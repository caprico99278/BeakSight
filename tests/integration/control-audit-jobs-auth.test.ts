// T25d（Task 25 の設計書 4.4、4.5）: 認証つきの監査（`TEST_AUTH_PASSIVE`）の、ジョブの管理の開始の確かめと `AUTH_STATE` の記録。偽のワーカー
// （`tests/helpers/fake-audit-worker.ts`）を本物の `fork` で起動する（本物のワーカーでの確かめは `audit-worker-auth-fork.test.ts`）。
// - 開始の確かめ: 手動のログイン（`MANUAL_SESSION`）で、認証の設定が `CURRENT` で、開始の直前に `validateAuthSetup` を通り直すときだけ始める。
//   設定なし（`AUTH_SETUP_MISSING`）、古い設定（`AUTH_SETUP_STALE`）、検証を通らない設定（`AUTH_SETUP_INVALID`）、自動ログイン
//   （T26d-2: 方式としては実行できるので、設定がなければ `AUTH_SETUP_MISSING`）、書き込みの監査（`MODE_NOT_EXECUTABLE`）は、行を作らず、
//   ワーカーを起動しない。
// - `START` に、検証した設定の文書と `approvedTestOrigins` と、その SHA-256（`workerAuthenticationDigestOf`）を入れる。
// - `AUTH_STATE` を受けたら、ジョブの行に最後の認証の状態を記録する（`SESSION_LOST` では止まったページの URL も）。公開の監査のジョブの
//   `AUTH_STATE`、`RUN_STARTED` の前の `SESSION_LOST` は、契約の違反（`PROTOCOL_VIOLATION`）。
// 管理データは一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobManager,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION, workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode } from '../helpers/fake-audit-worker.js';
import { blockingAfterStartFork, createCountingFork } from '../helpers/worker-fork.js';
import {
  CONTROL_JOB_TEST_TIMING,
  FAKE_WORKER_HEARTBEAT_INTERVAL_MS,
  awaitWorkersExit,
  expectWorkersExited,
  isJobEnded,
  waitForJob,
} from '../helpers/job-test-support.js';
import {
  PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261010000000';
const OTHER_RUN_ID = 'RUN-20261010000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const AUTH_PROFILE_ID = 'example-auth-job';
const PUBLIC_PROFILE_ID = 'example-public-job';
const SESSION_LOST_URL = `${TEST_ORIGIN}/admin/reports`;
const TEST_TIMEOUT_MS = 60_000;

const setupFor = (profileRevision: number, overrides: Partial<AuthSetup> = {}): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: AUTH_PROFILE_ID,
  profileRevision,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
  ...overrides,
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;
let resolverCalls: string[] = [];

const countingFork: AuditWorkerForker = forks.fork;

const fakeWorker = (mode: FakeWorkerMode): FakeWorker => writeFakeWorker(workDirectory, mode, {
  protocolVersion: WORKER_PROTOCOL_VERSION,
  runId: FAKE_RUN_ID,
  otherRunId: OTHER_RUN_ID,
  heartbeatIntervalMs: FAKE_WORKER_HEARTBEAT_INTERVAL_MS,
  exitCodes: {
    complete: EXIT_CODES.COMPLETE,
    partial: EXIT_CODES.PARTIAL,
    interrupted: INTERRUPTED_EXIT_CODE,
    configError: EXIT_CODES.CONFIG_ERROR,
    failure: FAILURE_EXIT_CODE,
  },
  sessionLostUrl: SESSION_LOST_URL,
});

const managerWith = (worker: FakeWorker, forkWorker: AuditWorkerForker = countingFork): AuditJobManager => {
  manager = createAuditJobManager({
    database,
    repositoryRoot: workDirectory,
    workerPath: worker.path,
    resolveContext: (path) => {
      resolverCalls.push(path);
      return resolveTestContext(path);
    },
    forkWorker,
    timing: CONTROL_JOB_TEST_TIMING,
  });
  return manager;
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

const createAuthProfile = (profile: SiteProfile = testAuthProfile(AUTH_PROFILE_ID, MIN_PROFILE_REVISION)): void => {
  expect(createProfile(database, profile, { resolveContext: resolveTestContext }).ok).toBe(true);
};

const saveSetup = (setup: AuthSetup = setupFor(MIN_PROFILE_REVISION)): void => {
  expect(saveAuthSetup(database, setup, { resolveContext: resolveTestContext }).ok).toBe(true);
};

const authRequest = (expectedRevision = MIN_PROFILE_REVISION) =>
  Object.freeze({ profileId: AUTH_PROFILE_ID, expectedRevision, startNew: true });

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-audit-jobs-auth-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  resolverCalls = [];
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('audit jobs (T25d): the checks right before an authenticated start', () => {
  it('rejects a TEST_AUTH_PASSIVE profile without an auth setup, before reading the target configuration', async () => {
    createAuthProfile();
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob(authRequest())).toEqual({ ok: false, reason: 'AUTH_SETUP_MISSING', errors: [] });
    expect(resolverCalls).toEqual([]);
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });

  it('rejects a stale auth setup (the profile changed after the setup was saved)', async () => {
    createAuthProfile();
    saveSetup();
    const next = { ...testAuthProfile(AUTH_PROFILE_ID, MIN_PROFILE_REVISION + 1), environmentEvidenceRef: 'evidence/example-test-env/isolation-check-2' };
    expect(updateProfile(database, { profile: next, expectedRevision: MIN_PROFILE_REVISION }, { resolveContext: resolveTestContext }).ok).toBe(true);
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob(authRequest(MIN_PROFILE_REVISION + 1))).toEqual({ ok: false, reason: 'AUTH_SETUP_STALE', errors: [] });
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });

  it('rejects a stored auth setup that no longer passes validateAuthSetup right before the start', async () => {
    createAuthProfile();
    saveSetup();
    // 形（スキーマ）は正しいが、成功の条件がログインの画面にも当たる文書に書き換える（保存の後に壊れた・古い値を模す）。
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    try {
      raw.prepare('UPDATE auth_setups SET document = ? WHERE profile_id = ?')
        .run(JSON.stringify(setupFor(MIN_PROFILE_REVISION, { successCondition: { pathPrefix: '/admin', selector: null } })), AUTH_PROFILE_ID);
    } finally {
      raw.close();
    }
    const jobManager = managerWith(fakeWorker('hold'));

    // CCX-23（CC-061）: 誤りには、誤りのある項目の位置（JSON Pointer）も付く（画面が項目を決めるため）。
    expect(await jobManager.startAuditJob(authRequest())).toEqual({
      ok: false,
      reason: 'AUTH_SETUP_INVALID',
      errors: [],
      authSetupErrors: [{ code: 'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', detail: expect.any(String), pointer: '/successCondition/pathPrefix' }],
    });
    expect(forks.count()).toBe(0);
  });

  // CCX-3（設計者の判断）: 向きを変える文字の一覧に U+061C（ARABIC LETTER MARK）を含めた。共通化の前に保存した、環境の証拠の参照に
  // U+061C を含むプロファイルは、読み出しでは壊れないが、開始の直前の検証し直しで `PROFILE_INVALID` になる（値を直す更新で直せる）。
  it('rejects a stored profile whose evidence reference contains U+061C, when it is validated again right before the start', async () => {
    createAuthProfile();
    saveSetup();
    const stored = { ...testAuthProfile(AUTH_PROFILE_ID, MIN_PROFILE_REVISION), environmentEvidenceRef: 'evidence/example\u061c-check' };
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    try {
      raw.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?').run(JSON.stringify(stored), AUTH_PROFILE_ID);
    } finally {
      raw.close();
    }
    const jobManager = managerWith(fakeWorker('hold'));

    const result = await jobManager.startAuditJob(authRequest());
    expect(result).toMatchObject({ ok: false, reason: 'PROFILE_INVALID' });
    expect(result.ok ? [] : result.errors.map(({ code }) => code)).toEqual(['PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED']);
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });

  it('rejects AUTOMATED_LOGIN without an auth setup and TEST_APPROVED_WRITE, without reading the target configuration', async () => {
    createAuthProfile({ ...testAuthProfile(AUTH_PROFILE_ID, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' });
    createAuthProfile({ ...testAuthProfile('example-write-job', MIN_PROFILE_REVISION), mode: 'TEST_APPROVED_WRITE' });
    const jobManager = managerWith(fakeWorker('hold'));

    // T26d-2: 自動ログインは方式として実行できる（認証の設定がないので、ターゲット設定を読む前に拒む）。自動ログインの開始の確かめ（Windows で
    // ないときの `CREDENTIAL_PROTECTION_UNAVAILABLE` を含む）は `control-audit-jobs-auto-login.test.ts`。
    expect(await jobManager.startAuditJob(authRequest())).toEqual({ ok: false, reason: 'AUTH_SETUP_MISSING', errors: [] });
    expect(await jobManager.startAuditJob({ ...authRequest(), profileId: 'example-write-job' }))
      .toEqual({ ok: false, reason: 'MODE_NOT_EXECUTABLE', errors: [] });
    expect(resolverCalls).toEqual([]);
    expect(forks.count()).toBe(0);
  });
});

describe('audit jobs (T25d): START and AUTH_STATE', () => {
  it('sends the validated setup, the approved origins and their digest in START, and records the auth states and the lost page', async () => {
    createAuthProfile();
    saveSetup();
    const worker = fakeWorker('auth-session-lost');
    const jobManager = managerWith(worker);
    const result = await jobManager.startAuditJob(authRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job).toMatchObject({ lastAuthState: null, sessionLostUrl: null });

    const ended = await waitForJob(jobManager, result.job.jobId, isJobEnded);
    expect(ended).toMatchObject({
      state: 'FINISHED',
      resultRunStatus: 'PARTIAL',
      exitCode: EXIT_CODES.PARTIAL,
      lastAuthState: 'SESSION_LOST',
      sessionLostUrl: SESSION_LOST_URL,
      failureReason: null,
    });
    const start = worker.received().find((message) => message['type'] === 'START');
    const setup = setupFor(MIN_PROFILE_REVISION);
    expect(start?.['authentication']).toEqual({
      setup,
      approvedTestOrigins: [TEST_ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(setup, [TEST_ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  // DEF-084: 子が最後のメッセージを送ってから終わると、混雑の下で、親の `exit` が最後の `message`（`AUTH_STATE`・`FINISHED`）より先に来ることが
  // ある。`START` の直後に親をふさいで、その形を決まって作る。
  it('records the lost session and FINISHED even when the exit of the worker arrives before its last messages (DEF-084)', async () => {
    createAuthProfile();
    saveSetup();
    const jobManager = managerWith(fakeWorker('auth-session-lost'), blockingAfterStartFork(countingFork));
    const result = await jobManager.startAuditJob(authRequest());
    if (!result.ok) throw new Error(result.reason);

    expect(await waitForJob(jobManager, result.job.jobId, isJobEnded)).toMatchObject({
      state: 'FINISHED',
      resultRunStatus: 'PARTIAL',
      exitCode: EXIT_CODES.PARTIAL,
      lastAuthState: 'SESSION_LOST',
      sessionLostUrl: SESSION_LOST_URL,
      failureReason: null,
    });
    await expectWorkersExited(children);
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('records LOGIN_TIMEOUT as the last auth state and the failure reason', async () => {
    createAuthProfile();
    saveSetup();
    const jobManager = managerWith(fakeWorker('auth-timeout'));
    const result = await jobManager.startAuditJob(authRequest());
    if (!result.ok) throw new Error(result.reason);

    expect(await waitForJob(jobManager, result.job.jobId, isJobEnded)).toMatchObject({
      state: 'FAILED',
      failureReason: 'LOGIN_TIMEOUT',
      lastAuthState: 'LOGIN_TIMEOUT',
      sessionLostUrl: null,
      exitCode: FAILURE_EXIT_CODE,
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('does not send authentication to a public job, and treats AUTH_STATE from it as a protocol violation', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const worker = fakeWorker('auth-session-lost');
    const jobManager = managerWith(worker);
    const result = await jobManager.startAuditJob({ profileId: PUBLIC_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!result.ok) throw new Error(result.reason);

    expect(await waitForJob(jobManager, result.job.jobId, isJobEnded)).toMatchObject({
      state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION', lastAuthState: null,
    });
    const start = worker.received().find((message) => message['type'] === 'START');
    expect(start).toBeDefined();
    expect(start).not.toHaveProperty('authentication');
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('treats SESSION_LOST before RUN_STARTED as a protocol violation', async () => {
    createAuthProfile();
    saveSetup();
    const jobManager = managerWith(fakeWorker('auth-early-session-lost'));
    const result = await jobManager.startAuditJob(authRequest());
    if (!result.ok) throw new Error(result.reason);

    expect(await waitForJob(jobManager, result.job.jobId, isJobEnded)).toMatchObject({
      state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION', sessionLostUrl: null,
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);
});
