/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える画面のサーバの処理（`src/server/credential-service.ts` の
 * `setUpAutomatedLogin` と、資格情報の画面の値 `credentialPageOf` の `automatedLoginSetup`）を、管理データ（一時のフォルダ）と、偽の暗号化の部品で作った
 * 資格情報のファイルの部品（`tests/helpers/test-credential-store.ts`）で確かめる。本物の DPAPI は使わない。
 * - 画面の値: 手動のログインのプロファイルだけ。最後の手動のログインの段の観察の欄の案（推測の印）、今の方式と回数の上限、承認が外れるシナリオの数。
 * - 保存の順: 全部を確かめる → 資格情報のファイルを書く → 管理データ（方式とセレクタ）を 1 つのトランザクションで書く。管理データで失敗したら、ファイルを
 *   消して前の状態に戻す。どこで失敗しても、前の状態が残る（成功、ファイルで失敗、管理データで失敗、改訂の衝突、戻しの失敗）。
 * - 保存の後の次のジョブ（ログインの確かめ）は、自動ログインで始まる（ジョブの管理と偽のワーカー。`START` に資格情報の改訂と根だけ）。
 * - 値を出さない: 応答、管理データのファイルと WAL、偽のワーカーが受けたメッセージに、目印の値がない。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import {AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../../src/control/contracts.js';
import { CredentialStoreError, type CredentialStore } from '../../../src/control/credentials/credential-store.js';
import type { AuditJobManager, CredentialChangeCheck } from '../../../src/control/job/audit-job-manager.js';
import { readRecentCredentialEvents } from '../../../src/control/job/auto-login-store.js';
import {
  createStartingJob,
  hasActiveJobForProfile,
  recordAuthState,
  recordLoginCheckFinished,
  recordLoginStageAutoRegistration,
} from '../../../src/control/job/job-store.js';
import { getAuthSetup, saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile, updateProfile } from '../../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testAuthProfile } from '../../../tests/integration/control-profile-fixtures.js';
import { writeFakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { awaitWorkersExit, createFakeWorkerJobManager, fakeWorkerValuesOf, isJobEnded, waitForJob } from '../../../tests/helpers/job-test-support.js';
import { createTestCredentialStore, type TestCredentialStore } from '../../../tests/helpers/test-credential-store.js';
import { createCountingFork } from '../../../tests/helpers/worker-fork.js';
import {
  credentialPageOf,
  setUpAutomatedLogin,
  type AutomatedLoginSetupRequest,
  type CredentialServiceDependencies,
} from '../src/server/credential-service';

const PROFILE_ID = 'fm2e-manual';
const NOW = new Date(Date.UTC(2026, 9, 22, 9, 0, 0));
const RUN = randomUUID();
const USER = `fm2e-user-${RUN}`;
const PASS = `fm2e-pass-${RUN}`;
const MARKERS = Object.freeze([USER, PASS]);
const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });
const APPROVED_SCENARIOS = 2;
const TEST_TIMEOUT_MS = 120_000;
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });

/** 手動のログインの認証の設定（回数の上限は 2。自動ログインに切り替えると 1 になる）。 */
const MANUAL_SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

let root = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const responses: unknown[] = [];

const deps = (store: CredentialStore = credentials.store, overrides: Partial<CredentialServiceDependencies> = {}): CredentialServiceDependencies => ({
  database,
  store,
  checkCredentialChange: (profileId): CredentialChangeCheck =>
    hasActiveJobForProfile(database, profileId) ? { ok: false, reason: 'CREDENTIAL_IN_USE' } : { ok: true },
  platformSupported: () => true,
  environment: async () => 'AVAILABLE',
  now: () => NOW,
  approvedScenarioCount: async () => APPROVED_SCENARIOS,
  ...overrides,
});

const requestOf = (overrides: Partial<AutomatedLoginSetupRequest> = {}): AutomatedLoginSetupRequest => ({
  profileId: PROFILE_ID,
  expectedRevision: MIN_PROFILE_REVISION,
  usernameSelector: FIELDS.username,
  passwordSelector: FIELDS.password,
  submitSelector: FIELDS.submit,
  username: USER,
  password: PASS,
  passwordConfirmation: PASS,
  ...overrides,
});

const setUp = async (request: AutomatedLoginSetupRequest, store: CredentialStore = credentials.store) => {
  const result = await setUpAutomatedLogin(deps(store), request, { resolveContext: resolveTestContext });
  responses.push(result);
  return result;
};

const credentialFileExists = (): boolean => existsSync(join(credentials.store.directory, `${PROFILE_ID}.credential.json`));

/** 前の状態（手動のログイン、改訂 1、認証の設定は手動のまま、資格情報のファイルと記録なし）が残っているか。 */
const expectPreviousState = (): void => {
  const stored = getProfile(database, PROFILE_ID);
  expect(stored?.profile.auth).toBe('MANUAL_SESSION');
  expect(stored?.profile.revision).toBe(MIN_PROFILE_REVISION);
  expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(MANUAL_SETUP);
  expect(getAuthSetup(database, PROFILE_ID)?.freshness).toBe('CURRENT');
  expect(credentialFileExists()).toBe(false);
  expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
};

/**
 * 手動のログインの段の観察を持つ、終わったジョブを作る（`loginFields` が `null` なら、欄の案のない観察。成功の鍵の形だけ）。`profileRevision` はジョブを
 * 始めた改訂。
 */
const recordManualLoginJob = (
  jobId: string,
  loginFields: Readonly<Record<'username' | 'password' | 'submit', string | null>> | null,
  minutesBefore: number,
  profileRevision: number = MIN_PROFILE_REVISION,
): void => {
  const at = formatCompactUtcTimestamp(new Date(NOW.getTime() - minutesBefore * 60_000), 'test time');
  expect(createStartingJob(database, {
    jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision, startNew: true, createdAt: at,
  }, () => null)).toEqual({ ok: true });
  const observation = loginFields === null
    ? { storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } }
    : { loginFields };
  expect(recordAuthState(database, jobId, 'AUTHENTICATED', null, { scriptLogin: null, blockedRequests: null, observation })).toBe(true);
  // 終わった行にする（ジョブが動いていない状態。終わり方の種類は確かめに関わらない）。
  expect(recordLoginCheckFinished(database, jobId, 0, at)).toBe(true);
};

const leaks = (text: string): boolean => MARKERS.some((marker) => text.includes(marker));
const databaseBytes = (): string => {
  const path = resolveControlDatabasePath(root);
  return [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('\n');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beaksight-fm2e-setup-'));
  mkdirSync(dirname(join(root, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(root, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(root));
  credentials = await createTestCredentialStore();
  forks.reset();
  responses.length = 0;
  expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, MANUAL_SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  // 応答に目印がない（成功と誤りのどちらも）。
  expect(responses.filter((response) => leaks(JSON.stringify(response)))).toEqual([]);
  closeControlDatabase(database);
  await credentials.remove();
  await rm(root, { recursive: true, force: true });
});

describe('FM2e: the page values of the one screen of the automated login', () => {
  it('shows the field proposals of the last manual login with the inferred mark, the method, the attempts and the approvals to lose', async () => {
    recordManualLoginJob('job-old', { username: '#old-user', password: '#old-pass', submit: '#old-go' }, 10);
    recordManualLoginJob('job-new', { ...FIELDS, submit: null }, 5);
    const page = await credentialPageOf(deps(), PROFILE_ID);
    responses.push(page);
    expect(page?.eligible).toBe(false);
    const inferred = (value: string) => ({ value, origin: 'INFERRED', ground: 'LOGIN_FIELD_SINGLE_CANDIDATE' });
    expect(page?.automatedLoginSetup).toEqual({
      authSetupCurrent: true,
      currentAuth: 'MANUAL_SESSION',
      currentSelectors: { username: null, password: null, submit: null },
      proposals: { username: inferred(FIELDS.username), password: inferred(FIELDS.password), submit: null },
      proposalJobId: 'job-new',
      maxLoginAttempts: { before: 2, after: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS },
      approvedScenarioCount: APPROVED_SCENARIOS,
    });
  });

  // FM2R の Minor 6: 案は、最後の手動のログインのジョブの案だけ。そのジョブに案がなければ、古いジョブの案に戻らず「案なし」。案のもとのジョブの改訂
  // （そのジョブの自動の登録が保存したときは、保存した改訂）が今の改訂と違えば使わない。
  it('uses only the proposals of the last manual login job, never an older one, and only for the current revision', async () => {
    const none = { username: null, password: null, submit: null };
    recordManualLoginJob('job-old', FIELDS, 10);
    recordManualLoginJob('job-new', null, 5);
    const latestWithout = await credentialPageOf(deps(), PROFILE_ID);
    expect(latestWithout?.automatedLoginSetup?.proposals).toEqual(none);
    expect(latestWithout?.automatedLoginSetup?.proposalJobId).toBeNull();

    // 今の改訂より前の改訂で始めたジョブ（自動の登録なし）の案は使わない。
    recordManualLoginJob('job-newest', FIELDS, 3);
    const current = getProfile(database, PROFILE_ID);
    if (current === null) throw new Error('no profile');
    expect(updateProfile(database, { profile: { ...current.profile, revision: MIN_PROFILE_REVISION + 1 }, expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(saveAuthSetup(database, { ...MANUAL_SETUP, profileRevision: MIN_PROFILE_REVISION + 1 }, { resolveContext: resolveTestContext }).ok).toBe(true);
    const stale = await credentialPageOf(deps(), PROFILE_ID);
    expect(stale?.automatedLoginSetup?.proposals).toEqual(none);
    expect(stale?.automatedLoginSetup?.proposalJobId).toBeNull();

    // そのジョブの自動の登録が保存した改訂が今の改訂なら使う（手動のログインの後の「次から自動でログインする」の形）。
    expect(recordLoginStageAutoRegistration(database, 'job-newest', { result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, addedServiceOrigins: [] }))
      .toBe(true);
    const registered = await credentialPageOf(deps(), PROFILE_ID);
    expect(registered?.automatedLoginSetup?.proposalJobId).toBe('job-newest');
    expect(registered?.automatedLoginSetup?.proposals.submit?.value).toBe(FIELDS.submit);
  });

  it('has no screen for an automated login profile and for a profile without an auth setup, and no proposals without a manual login observation', async () => {
    const plain = 'fm2e-no-setup';
    expect(createProfile(database, testAuthProfile(plain, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect((await credentialPageOf(deps(), plain))?.automatedLoginSetup).toBeNull();
    expect(await setUp(requestOf({ profileId: plain }))).toMatchObject({ ok: false, kind: 'SETUP', reason: 'AUTH_SETUP_NOT_CURRENT' });
    const empty = await credentialPageOf(deps(), PROFILE_ID);
    expect(empty?.automatedLoginSetup?.proposals).toEqual({ username: null, password: null, submit: null });
    expect(empty?.automatedLoginSetup?.proposalJobId).toBeNull();
    expect(await setUp(requestOf())).toMatchObject({ ok: true });
    const after = await credentialPageOf(deps(), PROFILE_ID);
    expect(after?.eligible).toBe(true);
    expect(after?.automatedLoginSetup).toBeNull();
  });
});

describe('FM2e: the order of the saves of the automated login', () => {
  it('saves the credential file, then the method and the selectors in one transaction, and records the credential event', async () => {
    const result = await setUp(requestOf());
    expect(result).toMatchObject({ ok: true, profileRevision: MIN_PROFILE_REVISION + 1 });
    const stored = getProfile(database, PROFILE_ID);
    expect(stored?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: MIN_PROFILE_REVISION + 1 });
    const setup = getAuthSetup(database, PROFILE_ID);
    expect(setup?.freshness).toBe('CURRENT');
    expect(setup?.setup).toEqual({
      ...MANUAL_SETUP,
      profileRevision: MIN_PROFILE_REVISION + 1,
      maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
      automatedLogin: {
        usernameSelector: FIELDS.username,
        passwordSelector: FIELDS.password,
        submitSelector: FIELDS.submit,
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      },
    });
    expect(credentialFileExists()).toBe(true);
    expect(readRecentCredentialEvents(database, PROFILE_ID).map(({ kind }) => kind)).toEqual(['CREATED']);
    const page = await credentialPageOf(deps(), PROFILE_ID);
    expect(page?.credential).toMatchObject({ loginOrigin: TEST_ORIGIN, credentialRevision: 1 });
    expect(page?.originMatches).toBe(true);
    expect(leaks(databaseBytes())).toBe(false);
    expect(leaks(readFileSync(join(credentials.store.directory, `${PROFILE_ID}.credential.json`), 'utf8'))).toBe(false);
  });

  it.each([
    ['a too short password', requestOf({ password: 'abc', passwordConfirmation: 'abc' }), 'CREDENTIAL_VALUE_TOO_SHORT'],
    ['the different confirmation', requestOf({ passwordConfirmation: `${PASS}x` }), 'CREDENTIAL_CONFIRMATION_MISMATCH'],
    ['an empty user name', requestOf({ username: '' }), 'CREDENTIAL_VALUE_EMPTY'],
  ] as const)('keeps the previous state when the credential is rejected (%s)', async (_name, request, reason) => {
    expect(await setUp(request)).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason });
    expectPreviousState();
  });

  it('keeps the previous state when the credential file cannot be written', async () => {
    const failing: CredentialStore = { ...credentials.store, register: async () => { throw new CredentialStoreError('CREDENTIAL_STORAGE_UNSAFE'); } };
    expect(await setUp(requestOf(), failing)).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_STORAGE_UNSAFE' });
    expectPreviousState();
  });

  it('does not touch a credential file that is already there (a leftover) and keeps the previous state', async () => {
    await credentials.store.register({ profileId: PROFILE_ID, loginOrigin: TEST_ORIGIN, username: `${USER}-old`, password: `${PASS}-old` });
    const before = readFileSync(join(credentials.store.directory, `${PROFILE_ID}.credential.json`), 'utf8');
    expect(await setUp(requestOf())).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_ALREADY_EXISTS' });
    expect(readFileSync(join(credentials.store.directory, `${PROFILE_ID}.credential.json`), 'utf8')).toBe(before);
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'MANUAL_SESSION', revision: MIN_PROFILE_REVISION });
  });

  it('removes the credential file and keeps the previous state when the management data fails', async () => {
    // テストだけの操作: ファイルを書いた直後に、管理データを閉じる（管理データの書き込みが例外で失敗する）。
    const closing: CredentialStore = {
      ...credentials.store,
      register: async (input) => {
        const metadata = await credentials.store.register(input);
        closeControlDatabase(database);
        return metadata;
      },
    };
    const result = await setUp(requestOf(), closing);
    database = openControlDatabase(resolveControlDatabasePath(root));
    expect(result).toMatchObject({ ok: false, kind: 'SETUP', reason: 'SAVE_FAILED', rollback: 'REMOVED' });
    expectPreviousState();
  });

  it('removes the credential file when another save advanced the revision before the management data (a revision conflict)', async () => {
    // テストだけの操作: ファイルを書いた直後に、別の保存がプロファイルの改訂を進める。
    const racing: CredentialStore = {
      ...credentials.store,
      register: async (input) => {
        const metadata = await credentials.store.register(input);
        const current = getProfile(database, PROFILE_ID);
        if (current === null) throw new Error('no profile');
        expect(updateProfile(database, { profile: { ...current.profile, revision: MIN_PROFILE_REVISION + 1 }, expectedRevision: MIN_PROFILE_REVISION },
          { resolveContext: resolveTestContext }).ok).toBe(true);
        return metadata;
      },
    };
    expect(await setUp(requestOf(), racing)).toMatchObject({ ok: false, kind: 'SETUP', reason: 'PROFILE_REVISION_CONFLICT', rollback: 'REMOVED' });
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'MANUAL_SESSION', revision: MIN_PROFILE_REVISION + 1 });
    expect(credentialFileExists()).toBe(false);
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
  });

  it('tells that the credential file remains when it cannot be removed after the management data failed', async () => {
    const stuck: CredentialStore = {
      ...credentials.store,
      register: async (input) => {
        const metadata = await credentials.store.register(input);
        closeControlDatabase(database);
        return metadata;
      },
      remove: async () => { throw new CredentialStoreError('CREDENTIAL_DELETE_FAILED'); },
    };
    const result = await setUp(requestOf(), stuck);
    database = openControlDatabase(resolveControlDatabasePath(root));
    expect(result).toMatchObject({ ok: false, kind: 'SETUP', reason: 'SAVE_FAILED', rollback: 'FAILED' });
    expect(credentialFileExists()).toBe(true);
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'MANUAL_SESSION', revision: MIN_PROFILE_REVISION });
  });

  it('checks everything before writing the file: the revision, the selectors, the job, the platform and the method', async () => {
    expect(await setUp(requestOf({ expectedRevision: MIN_PROFILE_REVISION + 1 })))
      .toMatchObject({ ok: false, kind: 'SETUP', reason: 'PROFILE_REVISION_CONFLICT', rollback: 'NOT_NEEDED' });
    expectPreviousState();
    const duplicated = await setUp(requestOf({ submitSelector: FIELDS.username }));
    expect(duplicated).toMatchObject({ ok: false, kind: 'SETUP', reason: 'AUTH_SETUP_INVALID', rollback: 'NOT_NEEDED' });
    expect(duplicated.ok ? [] : 'errors' in duplicated ? duplicated.errors.map(({ code, field }) => [code, field]) : [])
      .toContainEqual(['AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED', 'usernameSelector']);
    expectPreviousState();
    expect(await setUpAutomatedLogin(deps(credentials.store, { platformSupported: () => false }), requestOf(), { resolveContext: resolveTestContext }))
      .toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_PLATFORM_UNSUPPORTED' });
    expect(await setUpAutomatedLogin(deps(credentials.store, { checkCredentialChange: () => ({ ok: false, reason: 'CREDENTIAL_IN_USE' }) }), requestOf(),
      { resolveContext: resolveTestContext })).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_IN_USE' });
    expect(await setUpAutomatedLogin(deps(), requestOf(), { resolveContext: () => undefined }))
      .toMatchObject({ ok: false, kind: 'SETUP', reason: 'TARGET_CONFIG_UNAVAILABLE', rollback: 'NOT_NEEDED' });
    expectPreviousState();
    expect(await setUp(requestOf({ profileId: 'fm2e-missing' }))).toMatchObject({ ok: false, kind: 'SETUP', reason: 'PROFILE_NOT_FOUND' });
    // 自動ログインにした後は、もう一度は進めない（資格情報の画面の今の操作を使う）。
    expect(await setUp(requestOf())).toMatchObject({ ok: true });
    expect(await setUp(requestOf({ expectedRevision: MIN_PROFILE_REVISION + 1 }))).toMatchObject({ ok: false, kind: 'SETUP', reason: 'NOT_OFFERED' });
  });

  it('starts the next job with the automated login after the save (the job manager and the fake worker)', async () => {
    const saved = await setUp(requestOf());
    expect(saved).toMatchObject({ ok: true });
    const worker = writeFakeWorker(root, 'auto-login-success', fakeWorkerValuesOf({ runId: 'RUN-20261022000000', otherRunId: 'RUN-20261022000999' }));
    manager = createFakeWorkerJobManager({
      database,
      workDirectory: root,
      worker,
      resolveContext: resolveTestContext,
      forkWorker: forks.fork,
      timing: { readyTimeoutMs: 5_000, heartbeatTimeoutMs: 3_000 },
      now: () => NOW,
      credentials: { root: credentials.root, store: credentials.store },
    });
    const started = await manager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1 });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;
    const ended = await waitForJob(manager, started.job.jobId, isJobEnded, { limitMs: 20_000 });
    expect(ended).toMatchObject({ jobKind: 'LOGIN_CHECK', state: 'FINISHED', lastAuthState: 'AUTHENTICATED' });
    const start = worker.received().find((message) => message['type'] === 'START') as { authentication?: Record<string, unknown> } | undefined;
    expect(start?.authentication?.['automatedLogin']).toEqual({ credentialRevision: 1, credentialRoot: credentials.root });
    expect((start?.authentication?.['setup'] as AuthSetup | undefined)?.automatedLogin?.usernameSelector).toBe(FIELDS.username);
    expect(leaks(JSON.stringify(worker.received()))).toBe(false);
    expect(leaks(databaseBytes())).toBe(false);
  }, TEST_TIMEOUT_MS);
});
