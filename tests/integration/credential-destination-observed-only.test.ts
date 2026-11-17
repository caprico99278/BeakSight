// MI-F5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6・7。再レビュー MI-R2 の Critical C-A・Important I-A・Minor M-1）:
// 管理データの保存の部品が、画面の保存の口から渡される選択肢で、トランザクションの中で次を確かめる。
// - 認証の設定の保存（`saveAuthSetup` の `observedDestinationsOnly`）: 方式によらず、今保存してある設定から送信先が変わる保存を拒む
//   （`CREDENTIAL_DESTINATION_OBSERVED_ONLY`。自動ログインのプロファイルは今どおり `CREDENTIAL_DESTINATION_LOCKED`）。設定がないときは、渡された案か、送信先の
//   ない形と同じときだけ受ける。選択肢を渡さない口（観察からの登録、切り替え、テストの準備）は今どおり。
// - プロファイルと認証の設定のまとめて保存（`saveProfileAndAuthSetup` の `observedDestinationsOnly`）: 今保存してある設定か、口がトランザクションの中で求めた案
//   （行の観察）と同じ送信先だけを受ける。
// - プロファイルの更新（`updateProfile` の `gate`）: 口の判定を、トランザクションの中で、改訂の照合の後に、保存してある改訂に対して呼ぶ（拒めば何も書かない）。
// 管理データは一時のフォルダだけを使う。例の値は匿名の値（`example.invalid`）だけ。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { CREDENTIAL_DESTINATION_OBSERVED_ONLY_REASON } from '../../src/control/auth/credential-destination.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { saveProfileAndAuthSetup } from '../../src/control/store/profile-auth-setup-store.js';
import { createProfile, getProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { TEST_ORIGIN, resolveTestContext as resolveContext, testAuthProfile } from './control-profile-fixtures.js';

const MANUAL_PROFILE = 'example-observed-manual';
const AUTO_PROFILE = 'example-observed-auto';
const EMPTY_PROFILE = 'example-observed-empty';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OBSERVED_ORIGIN = 'https://observed.example.invalid';
const OBSERVED_ONLY = CREDENTIAL_DESTINATION_OBSERVED_ONLY_REASON;
const GRANT = Object.freeze({ name: 'grant_type', value: 'password' });

const AUTOMATED_LOGIN = Object.freeze({
  usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
  failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
});

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
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [GRANT] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/tenant', method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
});

const profileOf = (profileId: string, auth: SiteProfile['auth'], services: readonly string[] = [SERVICE_ORIGIN]): SiteProfile => ({
  ...testAuthProfile(profileId, MIN_PROFILE_REVISION),
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
const storedSetup = (profileId: string): AuthSetup | null => getAuthSetup(database, profileId)?.setup ?? null;
/** 画面の認証の設定の保存の口と同じ選択肢（最初の保存だけ、入口の確かめの案 `firstSaveBaselines` を渡す）。 */
const observedOnlyFirstSave = (firstSaveBaselines: readonly AuthSetup[] = []) => ({
  resolveContext,
  observedDestinationsOnly: { baselinesOf: (_profile: SiteProfile, stored: AuthSetup | null) => (stored === null ? firstSaveBaselines : []) },
});

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-credential-destination-observed-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  expect(createProfile(database, profileOf(MANUAL_PROFILE, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, scriptSetupOf(MANUAL_PROFILE, MIN_PROFILE_REVISION, false), { resolveContext })).toMatchObject({ ok: true });
  expect(createProfile(database, profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, scriptSetupOf(AUTO_PROFILE, MIN_PROFILE_REVISION, true), { resolveContext })).toMatchObject({ ok: true });
  expect(createProfile(database, profileOf(EMPTY_PROFILE, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('MI-F5: the auth setup save of the screen keeps the observed destination in any auth', () => {
  it('rejects the destination change of a MANUAL_SESSION profile, and writes nothing', () => {
    const before = storedSetup(MANUAL_PROFILE) as AuthSetup;
    for (const change of [
      { scriptLogin: { ...before.scriptLogin!, path: '/evil/token' } },
      { loginSideRequests: [{ origin: TEST_ORIGIN, path: '/collect', method: 'POST' as const, maxPerLoginStage: 1 }] },
      { loginStartUrl: `${TEST_ORIGIN}/other-auth` },
    ]) {
      expect(saveAuthSetup(database, { ...before, ...change }, observedOnlyFirstSave())).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    }
    expect(storedSetup(MANUAL_PROFILE)).toEqual(before);
  });

  it('keeps the reason of item 3 for an AUTOMATED_LOGIN profile', () => {
    const before = storedSetup(AUTO_PROFILE) as AuthSetup;
    expect(saveAuthSetup(database, { ...before, scriptLogin: { ...before.scriptLogin!, path: '/evil/token' } }, observedOnlyFirstSave()))
      .toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_LOCKED' });
  });

  it('accepts the fields that are not destinations, and the save without the option (the observation and the test setup)', () => {
    const before = storedSetup(MANUAL_PROFILE) as AuthSetup;
    expect(saveAuthSetup(database, { ...before, excludedPaths: ['/danger'], loginSideRequests: [] }, observedOnlyFirstSave())).toMatchObject({ ok: true });
    expect(saveAuthSetup(database, { ...before, scriptLogin: { ...before.scriptLogin!, path: '/observed/token' } }, { resolveContext })).toMatchObject({ ok: true });
  });

  it('accepts a first save that is the proposal or has no destination, and rejects the other first saves', () => {
    const none: AuthSetup = { ...scriptSetupOf(EMPTY_PROFILE, MIN_PROFILE_REVISION, false), scriptLogin: null, loginSideRequests: [], successStorageKey: null };
    const proposal: AuthSetup = { ...none, loginTransport: 'FORM_NAVIGATION', loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/session' }] };
    expect(saveAuthSetup(database, scriptSetupOf(EMPTY_PROFILE, MIN_PROFILE_REVISION, false), observedOnlyFirstSave([proposal])))
      .toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(saveAuthSetup(database, { ...proposal, loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/collect' }] }, observedOnlyFirstSave([proposal])))
      .toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(storedSetup(EMPTY_PROFILE)).toBeNull();
    expect(saveAuthSetup(database, proposal, observedOnlyFirstSave([proposal]))).toMatchObject({ ok: true });
  });

  it('accepts a first save with the login page URL only, without a proposal', () => {
    const none: AuthSetup = { ...scriptSetupOf(EMPTY_PROFILE, MIN_PROFILE_REVISION, false), scriptLogin: null, loginSideRequests: [], successStorageKey: null };
    expect(saveAuthSetup(database, none, observedOnlyFirstSave())).toMatchObject({ ok: true });
  });
});

describe('MI-F5: the profile and auth setup save of the draft accepts the observed destination only', () => {
  const observed = (setup: AuthSetup): AuthSetup => ({ ...setup, scriptLogin: { origin: OBSERVED_ORIGIN, path: '/auth/v1/token', requiredQuery: [GRANT] } });
  const saveDraft = (scriptLogin: AuthSetup['scriptLogin']) => {
    const profile = storedProfile(MANUAL_PROFILE);
    const setup = storedSetup(MANUAL_PROFILE) as AuthSetup;
    const seen: Array<{ readonly previous: SiteProfile; readonly stored: AuthSetup | null }> = [];
    const result = saveProfileAndAuthSetup(database, {
      profile: { ...profile, revision: profile.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN, OBSERVED_ORIGIN] },
      expectedRevision: profile.revision,
      setup: { ...setup, profileRevision: profile.revision + 1, scriptLogin },
    }, {
      resolveContext,
      observedDestinationsOnly: {
        baselinesOf: (previous, stored) => {
          seen.push({ previous, stored });
          return stored === null ? [] : [observed(stored)];
        },
      },
    });
    return { result, seen };
  };

  it('accepts the destination of the baseline the caller made in the transaction from the stored values', () => {
    const { result, seen } = saveDraft({ origin: OBSERVED_ORIGIN, path: '/auth/v1/token', requiredQuery: [GRANT] });
    expect(result).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.previous.revision).toBe(MIN_PROFILE_REVISION);
    expect(seen[0]?.stored?.scriptLogin?.origin).toBe(SERVICE_ORIGIN);
  });

  it('rejects another path than the baseline, and writes neither', () => {
    const profile = storedProfile(MANUAL_PROFILE);
    const setup = storedSetup(MANUAL_PROFILE);
    expect(saveDraft({ origin: OBSERVED_ORIGIN, path: '/evil', requiredQuery: [GRANT] }).result).toMatchObject({ ok: false, part: 'AUTH_SETUP', reason: OBSERVED_ONLY });
    expect(storedProfile(MANUAL_PROFILE)).toEqual(profile);
    expect(storedSetup(MANUAL_PROFILE)).toEqual(setup);
  });
});

describe('MI-F5: the gate of the profile update runs in the transaction, after the revision check (4.7.1 item 7)', () => {
  it('calls the gate with the stored revision, and writes nothing when the gate rejects', () => {
    const before = storedProfile(MANUAL_PROFILE);
    const seen: SiteProfile[] = [];
    const result = updateProfile(database, { profile: { ...before, revision: before.revision + 1, environmentEvidenceRef: 'changed' }, expectedRevision: before.revision }, {
      resolveContext,
      gate: (previous: SiteProfile) => {
        seen.push(previous);
        return 'AUTOMATED_LOGIN_SWITCH_REQUIRED';
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'AUTOMATED_LOGIN_SWITCH_REQUIRED' });
    expect(seen).toEqual([before]);
    expect(storedProfile(MANUAL_PROFILE)).toEqual(before);
  });

  it('checks the revision the screen read before the gate', () => {
    const before = storedProfile(MANUAL_PROFILE);
    let called = false;
    const result = updateProfile(database, { profile: { ...before, revision: before.revision + 2 }, expectedRevision: before.revision + 1 }, {
      resolveContext,
      gate: () => {
        called = true;
        return null;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(called).toBe(false);
  });

  it('writes when the gate accepts', () => {
    const before = storedProfile(MANUAL_PROFILE);
    expect(updateProfile(database, { profile: { ...before, revision: before.revision + 1, environmentEvidenceRef: 'changed' }, expectedRevision: before.revision }, {
      resolveContext,
      gate: () => null,
    })).toMatchObject({ ok: true, stored: { profile: { environmentEvidenceRef: 'changed' } } });
  });
});
