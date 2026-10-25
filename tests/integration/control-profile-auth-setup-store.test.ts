// T43d（Task 43 の設計書 4.4「プロファイルと認証の設定の両方が変わるときは、1 回の保存で両方を書く」）: プロファイルの承認したサービスの Origin と認証の
// 設定をまとめて保存する部品（`saveProfileAndAuthSetup`）の結合テスト。
// - プロファイルの次の改訂と、その改訂に結びつく認証の設定を、管理データの 1 つの書き込みのトランザクションで書く。保存の後の認証の設定は「古い」にならない。
// - 今の改訂の照合（競合の検出）は保つ: 画面が読んだ改訂と保存されている改訂が違えば、どちらも書かない。
// - プロファイルか認証の設定のどちらかが検証を通らなければ、どちらも書かない（どちらの誤りかと、今の保存の部品の理由の値を返す）。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { saveProfileAndAuthSetup } from '../../src/control/store/profile-auth-setup-store.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { TEST_ORIGIN, resolveTestContext, testAuthProfile } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-observed';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const NEXT_REVISION = MIN_PROFILE_REVISION + 1;
const SAVED_AT = new Date(Date.UTC(2026, 9, 17, 1, 2, 3));

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-profile-auth-setup-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, formSetup(MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** フォームの送信の認証の設定（前に保存してある設定）。 */
function formSetup(profileRevision: number): AuthSetupV3 {
  return {
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: PROFILE_ID,
    profileRevision,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
  };
}

/** 下書きで作る、スクリプトで送るログインの認証の設定（版 3）。 */
const scriptSetup = (profileRevision: number, tokenOrigin = SERVICE_ORIGIN): AuthSetupV3 => ({
  ...formSetup(profileRevision),
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  loginPostEndpoints: [],
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: tokenOrigin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [],
  successStorageKey: { origin: TEST_ORIGIN, prefix: 'example-auth-token', suffix: '' },
});

/** サービスの Origin を足したプロファイルの次の改訂。 */
const profileWithService = (revision: number): SiteProfile => ({ ...testAuthProfile(PROFILE_ID, revision), approvedServiceOrigins: [SERVICE_ORIGIN] });

describe('T43d: saving the profile and the auth setup in one transaction', () => {
  it('writes the next profile revision and the auth setup bound to it, and the setup is current', () => {
    const result = saveProfileAndAuthSetup(database, {
      profile: profileWithService(NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION, setup: scriptSetup(NEXT_REVISION),
    }, { resolveContext: resolveTestContext, now: () => SAVED_AT });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(getProfile(database, PROFILE_ID)?.profile).toEqual(profileWithService(NEXT_REVISION));
    const stored = getAuthSetup(database, PROFILE_ID);
    expect(stored?.setup).toEqual(scriptSetup(NEXT_REVISION));
    expect(stored?.freshness).toBe('CURRENT');
    expect(stored?.profileRevision).toBe(NEXT_REVISION);
  });

  it('writes neither when the profile changed after the screen read it (the revision conflict)', () => {
    const result = saveProfileAndAuthSetup(database, {
      profile: profileWithService(NEXT_REVISION + 1), expectedRevision: NEXT_REVISION, setup: scriptSetup(NEXT_REVISION + 1),
    }, { resolveContext: resolveTestContext });
    expect(result).toMatchObject({ ok: false, part: 'PROFILE', reason: 'PROFILE_REVISION_CONFLICT' });
    expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION);
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(formSetup(MIN_PROFILE_REVISION));
  });

  it('writes neither when the auth setup does not pass the validation with the next profile', () => {
    const unapproved = saveProfileAndAuthSetup(database, {
      profile: profileWithService(NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION, setup: scriptSetup(NEXT_REVISION, 'https://other.example.invalid'),
    }, { resolveContext: resolveTestContext });
    expect(unapproved).toMatchObject({ ok: false, part: 'AUTH_SETUP', reason: 'AUTH_SETUP_INVALID' });
    expect(unapproved.ok ? [] : unapproved.errors.map(({ code }) => code)).toContain('AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED');
    // 前の改訂に結びつけた設定も、次の改訂と一緒には書けない。
    const stale = saveProfileAndAuthSetup(database, {
      profile: profileWithService(NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION, setup: scriptSetup(MIN_PROFILE_REVISION),
    }, { resolveContext: resolveTestContext });
    expect(stale).toMatchObject({ ok: false, part: 'AUTH_SETUP', reason: 'AUTH_SETUP_INVALID' });
    expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION);
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(formSetup(MIN_PROFILE_REVISION));
  });

  it('writes neither when the next profile does not pass the validation', () => {
    const result = saveProfileAndAuthSetup(database, {
      profile: { ...profileWithService(NEXT_REVISION), approvedServiceOrigins: ['ftp://service.example.invalid'] },
      expectedRevision: MIN_PROFILE_REVISION,
      setup: scriptSetup(NEXT_REVISION),
    }, { resolveContext: resolveTestContext });
    expect(result).toMatchObject({ ok: false, part: 'PROFILE', reason: 'PROFILE_INVALID' });
    expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION);
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(formSetup(MIN_PROFILE_REVISION));
  });
});
