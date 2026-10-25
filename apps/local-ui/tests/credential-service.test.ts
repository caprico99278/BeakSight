/**
 * 資格情報の画面のサーバの処理（`src/server/credential-service.ts`。Task 26 の設計書 4.2、4.7。T26e）を、管理データ（一時のフォルダ）と、偽の
 * 暗号化の部品で作った資格情報のファイルの部品（`tests/helpers/test-credential-store.ts`）で確かめる。本物の DPAPI は使わない。
 * - 表示: 保存の有無、作った時刻、最後に変えた時刻と種類、保存したログインの Origin と今の認証の設定との一致、暗号化の状態、止めた状態。
 * - 登録（両方必須、パスワードの不一致）、変更（ユーザー名だけ・パスワードだけ・両方。選ばなかった方の暗号文がバイトで同じ）、入れ直し、削除、
 *   ジョブが動いている間の拒否（`CREDENTIAL_IN_USE`）、止めた状態の解除の選択（変更の記録と解除の記録）、停止の解除の操作。
 * - Windows でないとき（ファイルの部品のプラットフォームを差し替えて）は保存を拒み、フォルダも作らない。
 * - 手動のログインのプロファイルでは、画面の値に資格情報を出さず、直接の要求を拒む。
 * - 値を出さない: 応答（成功と誤り）、管理データのファイルと WAL、資格情報のファイル（暗号文）に、目印の値がない。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../../src/control/contracts.js';
import {
  CREDENTIAL_DIRECTORY_NAME,
  CREDENTIAL_PARENT_DIRECTORY_NAME,
  MAX_CREDENTIAL_VALUE_LENGTH,
  MIN_CREDENTIAL_VALUE_LENGTH,
  createCredentialStoreWith,
  type CredentialStore,
} from '../../../src/control/credentials/credential-store.js';
import type { CredentialChangeCheck } from '../../../src/control/job/audit-job-manager.js';
import { readAutoLoginHold, readRecentCredentialEvents, recordAutoLoginResult } from '../../../src/control/job/auto-login-store.js';
import { createStartingJob, hasActiveJobForProfile, recordEnded } from '../../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, retireProfile } from '../../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { createTestConfig } from '../../../tests/helpers/test-config.js';
import { createTestCredentialProtector, createTestCredentialStore, type TestCredentialStore } from '../../../tests/helpers/test-credential-store.js';
import {
  changeCredential,
  clearCredentialHold,
  credentialPageOf,
  registerCredential,
  removeCredential,
  replaceCredential,
  type CredentialServiceDependencies,
} from '../src/server/credential-service';
import type { CredentialEnvironmentState } from '../src/server/credential-runtime';

const TEST_ORIGIN = 'https://app.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const AUTO_PROFILE = 't26e-auto';
const MANUAL_PROFILE = 't26e-manual';
const TARGET_PATH = 'config/targets/t26e.json';
const FIRST_REVISION = 1;
const NOW = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
/** 実行ごとの目印（値を出力しない。比べるときは `includes` の真偽だけを見る）。 */
const RUN = `${process.pid}-${Date.now()}`;
const USER_A = `t26e-user-a-${RUN}`;
const PASS_A = `t26e-pass-a-${RUN}`;
const USER_B = `t26e-user-b-${RUN}`;
const PASS_B = `t26e-pass-b-${RUN}`;
const MARKERS = Object.freeze([USER_A, PASS_A, USER_B, PASS_B]);
/** 画面に返す日時の形（ISO 8601。資格情報のファイルの部品の時刻は、テストの補助の今の時刻）。 */
const ISO_TIMESTAMP = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);

const context: ProfileValidationContext = {
  targetConfig: { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN, OTHER_ORIGIN] } },
};
const resolveContext = (path: string): ProfileValidationContext | undefined => (path === TARGET_PATH ? context : undefined);

const profileOf = (profileId: string, auth: SiteProfile['auth'], revision = FIRST_REVISION): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId,
  revision,
  targetConfigPath: TARGET_PATH,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth,
  approvedTestOrigins: [TEST_ORIGIN, OTHER_ORIGIN],
  environmentEvidenceRef: 'evidence/t26e',
});

const automatedSetupOf = (loginOrigin: string, revision = FIRST_REVISION): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: AUTO_PROFILE,
  profileRevision: revision,
  loginStartUrl: `${loginOrigin}/login`,
  loginPostEndpoints: [{ origin: loginOrigin, path: '/login' }],
  successCondition: { pathPrefix: '/home', selector: '#home' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: ['/home'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
});

let root = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;
let environment: CredentialEnvironmentState = 'AVAILABLE';
let platformSupported = true;
let jobCount = 0;
const responses: unknown[] = [];

const deps = (store: CredentialStore = credentials.store): CredentialServiceDependencies => ({
  database,
  store,
  checkCredentialChange: (profileId): CredentialChangeCheck =>
    hasActiveJobForProfile(database, profileId) ? { ok: false, reason: 'CREDENTIAL_IN_USE' } : { ok: true },
  platformSupported: () => platformSupported,
  environment: async () => environment,
  now: () => NOW,
});

/** 応答を覚えて返す（最後に、どの応答にも目印がないことを確かめる）。 */
const kept = async <T>(promise: Promise<T> | T): Promise<T> => {
  const value = await promise;
  responses.push(value);
  return value;
};

const fileOf = (profileId: string = AUTO_PROFILE): Record<string, unknown> =>
  JSON.parse(readFileSync(join(credentials.store.directory, `${profileId}.credential.json`), 'utf8')) as Record<string, unknown>;

const eventKinds = (): readonly string[] => readRecentCredentialEvents(database, AUTO_PROFILE).map((event) => event.kind).reverse();

const register = (overrides: Record<string, unknown> = {}) => kept(registerCredential(deps(), {
  profileId: AUTO_PROFILE,
  username: USER_A,
  password: PASS_A,
  passwordConfirmation: PASS_A,
  ...overrides,
} as never));

const change = (overrides: Record<string, unknown>) => kept(changeCredential(deps(), {
  profileId: AUTO_PROFILE,
  username: null,
  password: null,
  passwordConfirmation: null,
  clearHold: false,
  ...overrides,
} as never));

const stamp = (offsetMinutes: number): string =>
  formatCompactUtcTimestamp(new Date(NOW.getTime() + offsetMinutes * 60_000), 'test time');

/** 送信の後に成功以外で終わった試し（止める）を作る。 */
const holdAfterFailure = (): void => {
  jobCount += 1;
  const jobId = `job-${jobCount}`;
  expect(createStartingJob(database, {
    jobId,
    jobKind: 'LOGIN_CHECK',
    profileId: AUTO_PROFILE,
    profileRevision: FIRST_REVISION,
    startNew: false,
    createdAt: stamp(-30),
    autoLoginAttempt: { credentialRevision: 1 },
  }, () => null)).toEqual({ ok: true });
  recordAutoLoginResult(database, { jobId, result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, at: stamp(-29) });
  recordEnded(database, jobId, { state: 'FAILED', reason: 'INVALID_CREDENTIALS', exitCode: null, at: stamp(-29) });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beaksight-t26e-service-'));
  database = openControlDatabase(resolveControlDatabasePath(root));
  credentials = await createTestCredentialStore();
  environment = 'AVAILABLE';
  platformSupported = true;
  jobCount = 0;
  responses.length = 0;
  expect(createProfile(database, profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
  expect(createProfile(database, profileOf(MANUAL_PROFILE, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
  const saved = saveAuthSetup(database, automatedSetupOf(TEST_ORIGIN), { resolveContext });
  expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
});

afterEach(async () => {
  // 応答（成功と誤り）、管理データのファイルと WAL、資格情報のファイルに、目印の値がない（値を出力しないため、真偽だけを確かめる）。
  const serialized = JSON.stringify(responses);
  expect(MARKERS.filter((marker) => serialized.includes(marker)).length).toBe(0);
  closeControlDatabase(database);
  const dataDirectory = join(root, 'local-data');
  for (const name of existsSync(dataDirectory) ? readdirSync(dataDirectory) : []) {
    const bytes = readFileSync(join(dataDirectory, name));
    expect(MARKERS.filter((marker) => bytes.includes(Buffer.from(marker, 'utf8'))).length, name).toBe(0);
  }
  for (const name of existsSync(credentials.store.directory) ? readdirSync(credentials.store.directory) : []) {
    const bytes = readFileSync(join(credentials.store.directory, name));
    expect(MARKERS.filter((marker) => bytes.includes(Buffer.from(marker, 'utf8'))).length, name).toBe(0);
  }
  await credentials.remove();
  await rm(root, { recursive: true, force: true });
});

describe('T26e: the credential page values', () => {
  it('shows no credential, the current login origin, the encryption state and no hold for a new automated login profile', async () => {
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toEqual({
      profile: { profileId: AUTO_PROFILE, revision: FIRST_REVISION, mode: 'TEST_AUTH_PASSIVE', auth: 'AUTOMATED_LOGIN', status: 'ACTIVE' },
      eligible: true,
      environment: 'AVAILABLE',
      maxValueLength: MAX_CREDENTIAL_VALUE_LENGTH,
      // T36c（Task 36 の設計者の判断 2）: 欄の説明の下限も、サーバが渡す（意図して足した期待）。
      minValueLength: MIN_CREDENTIAL_VALUE_LENGTH,
      currentLoginOrigin: TEST_ORIGIN,
      credential: null,
      originMatches: null,
      readError: null,
      hold: null,
      inUse: false,
      // FM2e（意図して足した期待）: 1 回の操作で自動ログインの設定を終える欄は、手動のログインのプロファイルだけ（自動ログインのプロファイルは `null`）。
      automatedLoginSetup: null,
    });
    expect(await credentialPageOf(deps(), 'not-there')).toBeNull();
  });

  it('shows the saved metadata (times, kind, origin, revision) and the hold, never the values', async () => {
    expect(await register()).toMatchObject({ ok: true });
    holdAfterFailure();
    const page = await kept(credentialPageOf(deps(), AUTO_PROFILE));
    expect(page).toMatchObject({
      credential: {
        loginOrigin: TEST_ORIGIN,
        credentialRevision: 1,
        lastChangeKind: 'CREATED',
        createdAt: ISO_TIMESTAMP,
        updatedAt: ISO_TIMESTAMP,
      },
      originMatches: true,
      hold: { reason: 'INVALID_CREDENTIALS', heldAt: '2026-10-11T08:31:00Z' },
    });
  });

  it('shows the encryption state judged on the server (not Windows)', async () => {
    environment = 'NOT_WINDOWS';
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toMatchObject({ environment: 'NOT_WINDOWS', eligible: true });
  });
});

describe('T26e: registering a credential', () => {
  it('requires both the user name and the password, and records nothing on a rejection', async () => {
    expect(await register({ username: '' })).toEqual({ ok: false, reason: 'CREDENTIAL_VALUE_EMPTY', field: 'username' });
    expect(await register({ password: '', passwordConfirmation: '' })).toEqual({ ok: false, reason: 'CREDENTIAL_VALUE_EMPTY', field: 'password' });
    // T36c（設計者の判断 2）: 下限より短い値は拒む（項目の名前だけ）。
    const short = 'x'.repeat(MIN_CREDENTIAL_VALUE_LENGTH - 1);
    expect(await register({ username: short })).toEqual({ ok: false, reason: 'CREDENTIAL_VALUE_TOO_SHORT', field: 'username' });
    expect(await register({ password: short, passwordConfirmation: short })).toEqual({ ok: false, reason: 'CREDENTIAL_VALUE_TOO_SHORT', field: 'password' });
    expect(existsSync(credentials.store.directory)).toBe(false);
    expect(eventKinds()).toEqual([]);
  });

  it('rejects a password that does not match its confirmation before encrypting anything', async () => {
    expect(await register({ passwordConfirmation: PASS_B })).toEqual({ ok: false, reason: 'CREDENTIAL_CONFIRMATION_MISMATCH', field: 'password' });
    expect(existsSync(credentials.store.directory)).toBe(false);
    expect(eventKinds()).toEqual([]);
  });

  it('registers both values, records CREATED after the file is written, and refuses a second registration', async () => {
    const result = await register();
    expect(result).toEqual({
      ok: true,
      credential: {
        loginOrigin: TEST_ORIGIN,
        credentialRevision: 1,
        createdAt: ISO_TIMESTAMP,
        updatedAt: ISO_TIMESTAMP,
        lastChangeKind: 'CREATED',
      },
      holdCleared: false,
    });
    expect(fileOf()).toMatchObject({ profileId: AUTO_PROFILE, loginOrigin: TEST_ORIGIN, credentialRevision: 1 });
    expect(eventKinds()).toEqual(['CREATED']);
    expect(await register({ username: USER_B })).toEqual({ ok: false, reason: 'CREDENTIAL_ALREADY_EXISTS', field: null });
    expect(eventKinds()).toEqual(['CREATED']);
  });

  it('refuses to register without an auth setup (no login origin to bind)', async () => {
    const other = 't26e-auto-nosetup';
    expect(createProfile(database, profileOf(other, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
    expect(await kept(registerCredential(deps(), { profileId: other, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A })))
      .toEqual({ ok: false, reason: 'AUTH_SETUP_MISSING', field: null });
    expect(await kept(credentialPageOf(deps(), other))).toMatchObject({ currentLoginOrigin: null, credential: null });
  });
});

describe('T26e: changing a credential', () => {
  beforeEach(async () => {
    expect(await register()).toMatchObject({ ok: true });
  });

  it('changes only the user name, and copies the password cipher text byte for byte', async () => {
    const before = fileOf();
    expect(await change({ username: USER_B })).toMatchObject({ ok: true, credential: { credentialRevision: 2, lastChangeKind: 'USERNAME_CHANGED' } });
    const after = fileOf();
    expect(after['password']).toBe(before['password']);
    expect(after['username']).not.toBe(before['username']);
    expect(eventKinds()).toEqual(['CREATED', 'USERNAME_CHANGED']);
    expect((await credentials.store.decrypt(AUTO_PROFILE, TEST_ORIGIN)).username === USER_B).toBe(true);
  });

  it('changes only the password, and copies the user name cipher text byte for byte', async () => {
    const before = fileOf();
    expect(await change({ password: PASS_B, passwordConfirmation: PASS_B })).toMatchObject({
      ok: true,
      credential: { credentialRevision: 2, lastChangeKind: 'PASSWORD_CHANGED' },
    });
    const after = fileOf();
    expect(after['username']).toBe(before['username']);
    expect(after['password']).not.toBe(before['password']);
    expect(eventKinds()).toEqual(['CREATED', 'PASSWORD_CHANGED']);
  });

  it('changes both', async () => {
    expect(await change({ username: USER_B, password: PASS_B, passwordConfirmation: PASS_B })).toMatchObject({
      ok: true,
      credential: { credentialRevision: 2, lastChangeKind: 'BOTH_CHANGED' },
    });
    const decrypted = await credentials.store.decrypt(AUTO_PROFILE, TEST_ORIGIN);
    expect(decrypted.username === USER_B && decrypted.password === PASS_B).toBe(true);
  });

  it('refuses no selected item, an empty value and a mismatched confirmation, and keeps the file', async () => {
    const before = readFileSync(join(credentials.store.directory, `${AUTO_PROFILE}.credential.json`));
    expect(await change({})).toEqual({ ok: false, reason: 'CREDENTIAL_CHANGE_EMPTY', field: null });
    expect(await change({ username: '' })).toEqual({ ok: false, reason: 'CREDENTIAL_VALUE_EMPTY', field: 'username' });
    expect(await change({ password: PASS_B, passwordConfirmation: PASS_A })).toEqual({
      ok: false,
      reason: 'CREDENTIAL_CONFIRMATION_MISMATCH',
      field: 'password',
    });
    expect(readFileSync(join(credentials.store.directory, `${AUTO_PROFILE}.credential.json`)).equals(before)).toBe(true);
    expect(eventKinds()).toEqual(['CREATED']);
  });

  it('refuses a partial change when the login origin of the auth setup changed, and replaces both instead', async () => {
    expect(saveAuthSetup(database, automatedSetupOf(OTHER_ORIGIN), { resolveContext })).toMatchObject({ ok: true });
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toMatchObject({
      currentLoginOrigin: OTHER_ORIGIN,
      credential: { loginOrigin: TEST_ORIGIN },
      originMatches: false,
    });
    expect(await change({ username: USER_B })).toEqual({ ok: false, reason: 'CREDENTIAL_STALE', field: null });
    const replaced = await kept(replaceCredential(deps(), {
      profileId: AUTO_PROFILE,
      username: USER_B,
      password: PASS_B,
      passwordConfirmation: PASS_B,
      clearHold: false,
    }));
    expect(replaced).toMatchObject({ ok: true, credential: { loginOrigin: OTHER_ORIGIN, credentialRevision: 2, lastChangeKind: 'BOTH_CHANGED' } });
    expect(eventKinds()).toEqual(['CREATED', 'BOTH_CHANGED']);
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toMatchObject({ originMatches: true });
  });

  it('records the change and, only when chosen, the hold clearing', async () => {
    holdAfterFailure();
    expect(await change({ username: USER_B })).toMatchObject({ ok: true, holdCleared: false });
    expect(readAutoLoginHold(database, AUTO_PROFILE)).not.toBeNull();
    expect(eventKinds()).toEqual(['CREATED', 'USERNAME_CHANGED']);
    expect(await change({ password: PASS_B, passwordConfirmation: PASS_B, clearHold: true })).toMatchObject({ ok: true, holdCleared: true });
    expect(readAutoLoginHold(database, AUTO_PROFILE)).toBeNull();
    expect(eventKinds()).toEqual(['CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'HOLD_CLEARED']);
  });

  it('refuses changes, replacement and removal while a job of the profile runs (CREDENTIAL_IN_USE), and keeps the file', async () => {
    expect(createStartingJob(database, {
      jobId: 'running-job',
      jobKind: 'AUDIT',
      profileId: AUTO_PROFILE,
      profileRevision: FIRST_REVISION,
      startNew: false,
      createdAt: stamp(0),
    }, () => null)).toEqual({ ok: true });
    const before = readFileSync(join(credentials.store.directory, `${AUTO_PROFILE}.credential.json`));
    const inUse = { ok: false, reason: 'CREDENTIAL_IN_USE', field: null };
    expect(await change({ username: USER_B })).toEqual(inUse);
    expect(await kept(replaceCredential(deps(), {
      profileId: AUTO_PROFILE, username: USER_B, password: PASS_B, passwordConfirmation: PASS_B, clearHold: false,
    }))).toEqual(inUse);
    expect(await kept(removeCredential(deps(), AUTO_PROFILE))).toEqual(inUse);
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toMatchObject({ inUse: true });
    expect(readFileSync(join(credentials.store.directory, `${AUTO_PROFILE}.credential.json`)).equals(before)).toBe(true);
    expect(eventKinds()).toEqual(['CREATED']);
  });
});

describe('T26e: removing a credential and clearing the hold', () => {
  it('removes the file after the confirmation, records DELETED, and reports a missing credential afterwards', async () => {
    expect(await register()).toMatchObject({ ok: true });
    expect(await kept(removeCredential(deps(), AUTO_PROFILE))).toEqual({ ok: true, credential: null, holdCleared: false });
    expect(existsSync(join(credentials.store.directory, `${AUTO_PROFILE}.credential.json`))).toBe(false);
    expect(eventKinds()).toEqual(['CREATED', 'DELETED']);
    expect(readRecentCredentialEvents(database, AUTO_PROFILE)[0]).toMatchObject({ kind: 'DELETED', credentialRevision: 1 });
    expect(await kept(removeCredential(deps(), AUTO_PROFILE))).toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', field: null });
    expect(eventKinds()).toEqual(['CREATED', 'DELETED']);
  });

  it('clears the hold only by the explicit operation, and records HOLD_CLEARED', async () => {
    expect(await register()).toMatchObject({ ok: true });
    holdAfterFailure();
    expect(await kept(clearCredentialHold(deps(), AUTO_PROFILE))).toEqual({ ok: true, cleared: true });
    expect(readAutoLoginHold(database, AUTO_PROFILE)).toBeNull();
    expect(eventKinds()).toEqual(['CREATED', 'HOLD_CLEARED']);
    expect(await kept(clearCredentialHold(deps(), AUTO_PROFILE))).toEqual({ ok: true, cleared: false });
  });
});

describe('T26e: where the credential screen is not used', () => {
  it('rejects saving when the server judges that it is not Windows, and creates no folder', async () => {
    platformSupported = false;
    environment = 'NOT_WINDOWS';
    const linuxStore = createCredentialStoreWith(credentials.root, {
      protector: createTestCredentialProtector(),
      spawnProcess: () => {
        throw new Error('no child process on this platform');
      },
      now: () => NOW,
      platform: 'linux',
      renameFile: rename,
      waitBeforeRetry: async () => undefined,
    });
    const rejected = { ok: false, reason: 'CREDENTIAL_PLATFORM_UNSUPPORTED', field: null };
    expect(await kept(registerCredential(deps(linuxStore), {
      profileId: AUTO_PROFILE, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A,
    }))).toEqual(rejected);
    expect(await kept(changeCredential(deps(linuxStore), {
      profileId: AUTO_PROFILE, username: USER_A, password: null, passwordConfirmation: null, clearHold: false,
    }))).toEqual(rejected);
    expect(await kept(replaceCredential(deps(linuxStore), {
      profileId: AUTO_PROFILE, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A, clearHold: false,
    }))).toEqual(rejected);
    expect(existsSync(join(credentials.root, CREDENTIAL_PARENT_DIRECTORY_NAME, CREDENTIAL_DIRECTORY_NAME))).toBe(false);
    expect(eventKinds()).toEqual([]);
    expect(await kept(credentialPageOf(deps(linuxStore), AUTO_PROFILE))).toMatchObject({ environment: 'NOT_WINDOWS', credential: null });
  });

  it('does not show credentials for a manual login profile, and rejects direct requests', async () => {
    expect(await kept(credentialPageOf(deps(), MANUAL_PROFILE))).toMatchObject({
      eligible: false,
      credential: null,
      currentLoginOrigin: null,
      hold: null,
    });
    const rejected = { ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null };
    expect(await kept(registerCredential(deps(), {
      profileId: MANUAL_PROFILE, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A,
    }))).toEqual(rejected);
    expect(await kept(changeCredential(deps(), {
      profileId: MANUAL_PROFILE, username: USER_A, password: null, passwordConfirmation: null, clearHold: false,
    }))).toEqual(rejected);
    // T26g-2 round 1: 削除は資格で拒まない（ファイルが残っていれば消せる。`credential-retire.test.ts`）。ファイルがなければ `CREDENTIAL_MISSING`。
    expect(await kept(removeCredential(deps(), MANUAL_PROFILE))).toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', field: null });
    expect(await kept(clearCredentialHold(deps(), MANUAL_PROFILE))).toEqual(rejected);
    expect(existsSync(credentials.store.directory)).toBe(false);
    expect(await kept(registerCredential(deps(), {
      profileId: 'not-there', username: USER_A, password: PASS_A, passwordConfirmation: PASS_A,
    }))).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', field: null });
  });

  it('rejects saving for a retired profile, and still allows removing the saved credential', async () => {
    expect(await register()).toMatchObject({ ok: true });
    expect(retireProfile(database, { profileId: AUTO_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
    expect(await change({ username: USER_B })).toEqual({ ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null });
    expect(await kept(credentialPageOf(deps(), AUTO_PROFILE))).toMatchObject({ profile: { status: 'RETIRED' }, eligible: true });
    expect(await kept(removeCredential(deps(), AUTO_PROFILE))).toEqual({ ok: true, credential: null, holdCleared: false });
    expect(eventKinds()).toEqual(['CREATED', 'DELETED']);
  });
});

// T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）の自動ログインのプロファイルでも、認証つきの読み取りの
// 監査と同じ条件で、資格情報を保存・変更できる。手動のログインの書き込みのモードのプロファイルでは、今までどおり使わない。
describe('T28b: the credentials of a write mode profile', () => {
  const WRITE_AUTO_PROFILE = 't28b-write-auto';
  const WRITE_MANUAL_PROFILE = 't28b-write-manual';
  const writeProfileOf = (profileId: string, auth: SiteProfile['auth']): SiteProfile => ({ ...profileOf(profileId, auth), mode: 'TEST_APPROVED_WRITE' });

  it('shows, registers and changes the credential of an automated login write mode profile, after saving its auth setup', async () => {
    expect(createProfile(database, writeProfileOf(WRITE_AUTO_PROFILE, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
    const saved = saveAuthSetup(database, { ...automatedSetupOf(TEST_ORIGIN), profileId: WRITE_AUTO_PROFILE }, { resolveContext });
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
    expect(await kept(credentialPageOf(deps(), WRITE_AUTO_PROFILE))).toMatchObject({
      profile: { mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' },
      eligible: true,
      currentLoginOrigin: TEST_ORIGIN,
      credential: null,
    });
    expect(await kept(registerCredential(deps(), {
      profileId: WRITE_AUTO_PROFILE, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A,
    }))).toMatchObject({ ok: true, credential: { loginOrigin: TEST_ORIGIN, credentialRevision: 1, lastChangeKind: 'CREATED' } });
    expect(await kept(changeCredential(deps(), {
      profileId: WRITE_AUTO_PROFILE, username: USER_B, password: null, passwordConfirmation: null, clearHold: false,
    }))).toMatchObject({ ok: true, credential: { credentialRevision: 2 } });
  });

  it('does not show credentials for a manual login write mode profile, and rejects direct requests', async () => {
    expect(createProfile(database, writeProfileOf(WRITE_MANUAL_PROFILE, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
    expect(await kept(credentialPageOf(deps(), WRITE_MANUAL_PROFILE))).toMatchObject({ eligible: false, credential: null, currentLoginOrigin: null });
    expect(await kept(registerCredential(deps(), {
      profileId: WRITE_MANUAL_PROFILE, username: USER_A, password: PASS_A, passwordConfirmation: PASS_A,
    }))).toEqual({ ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null });
  });
});
