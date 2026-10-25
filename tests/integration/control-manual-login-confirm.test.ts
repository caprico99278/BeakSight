// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.2、2.3、5 章の約束）: ジョブの管理の「ログインを終えた」の口
// （`confirmManualLogin`）と、手動のログインの成功から組み立てた認証の設定の自動の登録。偽のワーカー（`tests/helpers/fake-audit-worker.ts` の
// `auth-manual-confirm`）を本物の `fork` で起動する。
// - 口は、手動のログインのジョブが `AWAITING_LOGIN` のときだけ受け、ワーカーへ `LOGIN_CONFIRMED` を送る（2 回目、ないジョブ、ログインを待っていない
//   ジョブ、終わったジョブは、閉じた一覧の理由で拒む）。
// - 成功の `AUTH_STATE` の通した送信の一覧を、ジョブのログインの段のまとめに残す。ジョブが終わったら、認証の設定の版 3 とプロファイルの承認したサービスの
//   Origin を保存し、結果（`autoRegistration`）をまとめに残す。値は持たない。
// 管理データは一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION } from '../../src/control/worker-protocol.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
} from '../helpers/job-test-support.js';
import { PUBLIC_TARGET_PATH, TEST_ORIGIN, TEST_TARGET_PATH, publicProfile, resolveTestContext, testAuthProfile } from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261019000000';
const OTHER_RUN_ID = 'RUN-20261019000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const AUTH_PROFILE_ID = 'example-manual-login';
const PUBLIC_PROFILE_ID = 'example-public-login';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TEST_TIMEOUT_MS = 60_000;

/** 手動のログインの段で通した送信の一覧（token の送信と、テナントを決める手続きの呼び出し、危険な語の path）。 */
const PASSED_REQUESTS = Object.freeze({
  requests: [
    { origin: SERVICE_ORIGIN, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] } },
    // ML-a-fix: token の送信より前に通した手続きの呼び出し（自動で登録する）と、危険な語の path と、データを書く送り先（登録しない）。
    { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/current_tenant', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 2, beforeToken: true },
    { origin: SERVICE_ORIGIN, path: '/auth/v1/logout', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
    { origin: SERVICE_ORIGIN, path: '/rest/v1/members', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, beforeToken: true },
  ],
  unlisted: 0,
});
const LOGIN_OBSERVATION = Object.freeze({ storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } });

const setupFor = (profileRevision: number): AuthSetupV3 => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
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
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

const fakeWorker = (mode: FakeWorkerMode, extra: Partial<FakeWorkerValues> = {}): FakeWorker =>
  writeFakeWorker(workDirectory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, extra));

const managerWith = (worker: FakeWorker): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: (path) => resolveTestContext(path),
    forkWorker: forks.fork,
  });
  return manager;
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-manual-login-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('ML-a: the login confirmation of the job management and the automatic registration', () => {
  it('sends LOGIN_CONFIRMED only while the manual login job awaits the login, and saves the built auth setup and the service origin after the job ends', async () => {
    expect(createProfile(database, testAuthProfile(AUTH_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(saveAuthSetup(database, setupFor(MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const worker = fakeWorker('auth-manual-confirm', { loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION } });
    const jobManager = managerWith(worker);
    expect(await jobManager.confirmManualLogin('no-such-job')).toEqual({ ok: false, reason: 'JOB_NOT_FOUND' });
    const started = await jobManager.startAuditJob({ profileId: AUTH_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { jobId } = started.job;
    await waitForJob(jobManager, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN');
    expect(await jobManager.confirmManualLogin(jobId)).toEqual({ ok: true });
    expect(await jobManager.confirmManualLogin(jobId)).toEqual({ ok: false, reason: 'ALREADY_CONFIRMED' });
    const authenticated = await waitForJob(jobManager, jobId, (job) => job.lastAuthState === 'AUTHENTICATED');
    expect(authenticated.loginStage?.passedRequests).toEqual(PASSED_REQUESTS);
    expect(worker.received().filter((message) => message['type'] === 'LOGIN_CONFIRMED')).toEqual([{ protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_CONFIRMED' }]);
    expect(await jobManager.confirmManualLogin(jobId)).toEqual({ ok: false, reason: 'ALREADY_CONFIRMED' });

    jobManager.stopAuditJob(jobId);
    await waitForJob(jobManager, jobId, isJobEnded);
    const registered = await waitForJob(jobManager, jobId, (job) => job.loginStage?.autoRegistration !== undefined);
    expect(registered.loginStage?.autoRegistration).toEqual({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, addedServiceOrigins: [SERVICE_ORIGIN] });
    expect(await jobManager.confirmManualLogin(jobId)).toEqual({ ok: false, reason: 'JOB_NOT_ACTIVE' });

    const profile = getProfile(database, AUTH_PROFILE_ID);
    expect(profile?.profile.revision).toBe(MIN_PROFILE_REVISION + 1);
    expect(profile?.profile.approvedServiceOrigins).toEqual([SERVICE_ORIGIN]);
    const stored = getAuthSetup(database, AUTH_PROFILE_ID);
    expect(stored?.setup).toMatchObject({
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileRevision: MIN_PROFILE_REVISION + 1,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/current_tenant', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
      successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('rejects the confirmation of a job that does not await a manual login', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const jobManager = managerWith(fakeWorker('hold'));
    const started = await jobManager.startAuditJob({ profileId: PUBLIC_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await jobManager.confirmManualLogin(started.job.jobId)).toEqual({ ok: false, reason: 'NOT_AWAITING_LOGIN' });
    jobManager.stopAuditJob(started.job.jobId, { force: true });
    await waitForJob(jobManager, started.job.jobId, isJobEnded);
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);
});
