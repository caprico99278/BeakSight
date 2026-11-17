// MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 3・4。独立レビュー MI-R の Critical C-1・Important I-1・Minor 1・2）:
// 自動ログインのプロファイル（保存の前も後も `AUTOMATED_LOGIN`）では、管理データの保存の部品の層（プロファイルの更新、認証の設定の保存、プロファイルと認証の
// 設定のまとめて保存）が、トランザクションの中で「今保存してある値」と「保存の後の値」を比べ、資格情報の送信先が変わる保存を拒む
// （`CREDENTIAL_DESTINATION_LOCKED`。何も書かない）。送信先でない欄の変更、手動のログインのプロファイル、手動から自動への切り替え（切り替えの部品と同じ形の
// まとめて保存）、自動から手動へ戻すことは、今どおり受ける。
// 管理データは一時のフォルダだけを使う。例の値は匿名の値（`example.invalid`）だけ。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { saveProfileAndAuthSetup } from '../../src/control/store/profile-auth-setup-store.js';
import { createProfile, getProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { createTestConfig } from '../helpers/test-config.js';
import {
  OTHER_TEST_ORIGIN,
  SECOND_PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

const AUTO_PROFILE = 'example-locked-auto';
const MANUAL_PROFILE = 'example-locked-manual';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const UNOBSERVED_ORIGIN = 'https://unobserved.example.invalid';
const LOCKED = 'CREDENTIAL_DESTINATION_LOCKED';

/** テストの Origin を 2 つ許す対象の設定（テスト環境の Origin を足す・設定のファイルを替える道の確かめ）。 */
const WIDE_CONTEXT = Object.freeze({ targetConfig: createTestConfig(TEST_ORIGIN) });
const resolveContext = (path: string) => {
  if (path === SECOND_PUBLIC_TARGET_PATH) {
    return Object.freeze({ targetConfig: { ...WIDE_CONTEXT.targetConfig, site: { ...WIDE_CONTEXT.targetConfig.site, allowedOrigins: [TEST_ORIGIN, OTHER_TEST_ORIGIN] } } });
  }
  return resolveTestContext(path);
};

const AUTOMATED_LOGIN = Object.freeze({
  usernameSelector: '#email',
  passwordSelector: '#password',
  submitSelector: '#login',
  failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
});

/** スクリプトで送るログインの認証の設定（token の送信先は承認したサービスの Origin）。 */
const scriptSetupOf = (profileId: string, profileRevision: number, automated: boolean): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId,
  profileRevision,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
  allowedIdpOrigins: [],
  automatedLogin: automated ? AUTOMATED_LOGIN : null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/resolve', method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
});

/** フォームの送信のログインの認証の設定。 */
const formSetupOf = (profileId: string, profileRevision: number): AuthSetup => ({
  ...scriptSetupOf(profileId, profileRevision, true),
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  loginTransport: 'FORM_NAVIGATION',
  scriptLogin: null,
  loginSideRequests: [],
  successStorageKey: null,
});

const profileOf = (profileId: string, revision: number, auth: SiteProfile['auth'], services: readonly string[] = [SERVICE_ORIGIN]): SiteProfile => ({
  ...testAuthProfile(profileId, revision),
  auth,
  approvedServiceOrigins: [...services],
});

let workDirectory = '';
let database: ControlDatabase;

const storedProfile = (profileId: string): SiteProfile => {
  const stored = getProfile(database, profileId);
  if (stored === null) throw new Error('no profile');
  return stored.profile;
};
const storedSetup = (profileId: string): AuthSetup => {
  const stored = getAuthSetup(database, profileId);
  if (stored === null) throw new Error('no auth setup');
  return stored.setup;
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-credential-destination-lock-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  // テストの準備: 自動ログインのプロファイルは、保存の部品で直接作る（作成の口の守りは画面のサーバ。設計書 4.7.1 の 4）。保存してある設定のない自動ログインの
  // プロファイルの最初の設定の保存は、比べる今の値がないので受ける（設計者に報告する点）。
  expect(createProfile(database, profileOf(AUTO_PROFILE, MIN_PROFILE_REVISION, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, scriptSetupOf(AUTO_PROFILE, MIN_PROFILE_REVISION, true), { resolveContext })).toMatchObject({ ok: true });
  expect(createProfile(database, profileOf(MANUAL_PROFILE, MIN_PROFILE_REVISION, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, scriptSetupOf(MANUAL_PROFILE, MIN_PROFILE_REVISION, false), { resolveContext })).toMatchObject({ ok: true });
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** 認証の設定の保存（`saveAuthSetup`）で、自動ログインのプロファイルの送信先を変える保存。 */
const SETUP_DESTINATION_CHANGES: readonly (readonly [string, (setup: AuthSetup) => AuthSetup])[] = [
  ['the login page URL', (setup) => ({ ...setup, loginStartUrl: `${TEST_ORIGIN}/other-auth` })],
  ['the token target path (I-1)', (setup) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: '/other/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] } })],
  ['the required query of the token target (I-1)', (setup) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'client_credentials' }] } })],
  ['a new login side request (I-1)', (setup) => ({ ...setup, loginSideRequests: [...setup.loginSideRequests, { origin: SERVICE_ORIGIN, path: '/rpc/x', method: 'POST', maxPerLoginStage: 1 }] })],
  ['more login side requests per login stage', (setup) => ({ ...setup, loginSideRequests: [{ ...setup.loginSideRequests[0]!, maxPerLoginStage: 3 }] })],
  ['the login transport and the form endpoint (I-1)', (setup) => formSetupOf(setup.profileId, setup.profileRevision)],
  ['the automated login selectors', (setup) => ({ ...setup, automatedLogin: { ...AUTOMATED_LOGIN, passwordSelector: '#other-password' } })],
];

describe('MI-F1: the store keeps the credential destination of an AUTOMATED_LOGIN profile', () => {
  it.each(SETUP_DESTINATION_CHANGES)('rejects an auth setup save that changes %s, and writes nothing', (_name, change) => {
    const before = storedSetup(AUTO_PROFILE);
    const result = saveAuthSetup(database, change(before), { resolveContext });
    expect(result).toMatchObject({ ok: false, reason: LOCKED });
    expect(storedSetup(AUTO_PROFILE)).toEqual(before);
  });

  it.each([
    ['a new test origin and another target configuration (I-1)', (profile: SiteProfile): SiteProfile =>
      ({ ...profile, targetConfigPath: SECOND_PUBLIC_TARGET_PATH, approvedTestOrigins: [TEST_ORIGIN, OTHER_TEST_ORIGIN] })],
    ['a new service origin (C-1, Minor 1)', (profile: SiteProfile): SiteProfile => ({ ...profile, approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] })],
  ])('rejects a profile update that adds %s, and writes nothing', (_name, change) => {
    const before = storedProfile(AUTO_PROFILE);
    const result = updateProfile(database, { profile: change({ ...before, revision: before.revision + 1 }), expectedRevision: before.revision }, { resolveContext });
    expect(result).toMatchObject({ ok: false, reason: LOCKED });
    expect(storedProfile(AUTO_PROFILE)).toEqual(before);
  });

  it('rejects a profile and auth setup save that moves the token target to a new service origin (C-1), and writes neither', () => {
    const profile = storedProfile(AUTO_PROFILE);
    const setup = storedSetup(AUTO_PROFILE);
    const result = saveProfileAndAuthSetup(database, {
      profile: { ...profile, revision: profile.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: profile.revision,
      setup: { ...setup, profileRevision: profile.revision + 1, scriptLogin: { ...setup.scriptLogin!, origin: UNOBSERVED_ORIGIN } },
    }, { resolveContext });
    expect(result).toMatchObject({ ok: false, reason: LOCKED });
    expect(storedProfile(AUTO_PROFILE)).toEqual(profile);
    expect(storedSetup(AUTO_PROFILE)).toEqual(setup);
  });

  it('rejects a profile and auth setup save that only changes the token target path of an AUTOMATED_LOGIN profile', () => {
    const profile = storedProfile(AUTO_PROFILE);
    const setup = storedSetup(AUTO_PROFILE);
    const result = saveProfileAndAuthSetup(database, {
      profile: { ...profile, revision: profile.revision + 1 },
      expectedRevision: profile.revision,
      setup: { ...setup, profileRevision: profile.revision + 1, scriptLogin: { ...setup.scriptLogin!, path: '/other/token' } },
    }, { resolveContext });
    expect(result).toMatchObject({ ok: false, part: 'AUTH_SETUP', reason: LOCKED });
    expect(storedSetup(AUTO_PROFILE)).toEqual(setup);
  });
});

describe('MI-F1: what the store still accepts', () => {
  it('accepts the changes of the fields that are not destinations (excluded paths, audit paths, conditions, fewer side requests)', () => {
    const before = storedSetup(AUTO_PROFILE);
    const changed: AuthSetup = {
      ...before,
      excludedPaths: ['/auth/logout', '/danger'],
      auditPathPrefixes: ['/admin'],
      successCondition: { pathPrefix: '/admin/home', selector: null },
      sessionLostCondition: { pathPrefix: null },
      automatedLogin: { ...AUTOMATED_LOGIN, failureConditions: { ...AUTOMATED_LOGIN.failureConditions, accountLocked: { pathPrefix: '/locked', selector: null } } },
      loginSideRequests: [{ ...before.loginSideRequests[0]!, maxPerLoginStage: 1 }],
    };
    const result = saveAuthSetup(database, changed, { resolveContext });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(saveAuthSetup(database, { ...changed, loginSideRequests: [] }, { resolveContext })).toMatchObject({ ok: true });
  });

  it('accepts a profile update of an AUTOMATED_LOGIN profile that removes a service origin it does not use, or moves the mode', () => {
    const before = storedProfile(AUTO_PROFILE);
    expect(updateProfile(database, { profile: { ...before, revision: before.revision + 1, mode: 'TEST_APPROVED_WRITE' }, expectedRevision: before.revision },
      { resolveContext })).toMatchObject({ ok: true });
  });

  it('accepts the destination changes of a MANUAL_SESSION profile', () => {
    const profile = storedProfile(MANUAL_PROFILE);
    expect(updateProfile(database, {
      profile: { ...profile, revision: profile.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: profile.revision,
    }, { resolveContext })).toMatchObject({ ok: true });
    const setup = { ...storedSetup(MANUAL_PROFILE), profileRevision: profile.revision + 1 };
    expect(saveAuthSetup(database, { ...setup, scriptLogin: { ...setup.scriptLogin!, origin: UNOBSERVED_ORIGIN, path: '/other/token' } }, { resolveContext }))
      .toMatchObject({ ok: true });
  });

  it('accepts the switch from MANUAL_SESSION to AUTOMATED_LOGIN (the same save as setUpAutomatedLogin) and the switch back', () => {
    const profile = storedProfile(MANUAL_PROFILE);
    const setup = storedSetup(MANUAL_PROFILE);
    const switched = saveProfileAndAuthSetup(database, {
      profile: { ...profile, revision: profile.revision + 1, auth: 'AUTOMATED_LOGIN' },
      expectedRevision: profile.revision,
      setup: { ...setup, profileRevision: profile.revision + 1, automatedLogin: AUTOMATED_LOGIN, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS },
    }, { resolveContext });
    expect(switched, JSON.stringify(switched)).toMatchObject({ ok: true });
    const automated = storedProfile(MANUAL_PROFILE);
    expect(updateProfile(database, {
      profile: { ...automated, revision: automated.revision + 1, auth: 'MANUAL_SESSION', approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: automated.revision,
    }, { resolveContext })).toMatchObject({ ok: true });
    expect(storedProfile(MANUAL_PROFILE)).toMatchObject({ auth: 'MANUAL_SESSION', targetConfigPath: TEST_TARGET_PATH });
  });
});
