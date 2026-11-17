// NL-2（設計書 `2026-11-06-beaksight-no-login-test-site-design.md` 3.2 の 2）: ログインのないテスト用のサイト（環境 `TEST` × 認証の方式 `NONE`。
// `approvedTestOrigins` は loopback だけ）のジョブの管理の `START`。偽のワーカー（`tests/helpers/fake-audit-worker.ts`）を本物の `fork` で起動して確かめる。
// - 認証の設定がなくても、ログインなしの `authentication`（`setup` が null、`approvedTestOrigins`、その SHA-256）を作って渡す。自動ログインの指定と
//   ログインの直後の登録は持たない。承認したサービスの Origin は、プロファイルの値をそのまま渡す（今の扱い）。
// - ログインの段を持たないジョブが `AUTH_STATE` を送ったら、契約の違反として扱う（fail-closed）。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../src/control/contracts.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { awaitWorkersExit, createFakeWorkerJobManager, fakeWorkerValuesOf, isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import { createTestConfig } from '../helpers/test-config.js';

const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const TARGET_PATH = 'local/targets/example-no-login.json';
const PROFILE_ID = 'example-no-login-job';
const FAKE_RUN_ID = 'RUN-20261106000000';
const OTHER_RUN_ID = 'RUN-20261106000999';
const TEST_TIMEOUT_MS = 60_000;

const CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig(LOOPBACK_ORIGIN) });
/** NL fix round 1: 開始の直前に読み直すターゲットの設定（テストが、外のサイトを許可 Origin に足した設定に替える）。 */
let currentContext: ProfileValidationContext = CONTEXT;
const resolveContext = (path: string): ProfileValidationContext | undefined => (path === TARGET_PATH ? currentContext : undefined);

/** ログインのないテスト用のサイトのプロファイル（書き込みのモード。承認したサービスの Origin は任意）。 */
const noLoginProfile = (approvedServiceOrigins?: readonly string[]): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: PROFILE_ID,
  revision: MIN_PROFILE_REVISION,
  targetConfigPath: TARGET_PATH,
  environment: 'TEST',
  mode: 'TEST_APPROVED_WRITE',
  auth: 'NONE',
  approvedTestOrigins: [LOOPBACK_ORIGIN],
  environmentEvidenceRef: 'evidence/example-no-login/isolation-check-1',
  ...(approvedServiceOrigins === undefined ? {} : { approvedServiceOrigins: [...approvedServiceOrigins] }),
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();

const fakeWorker = (mode: FakeWorkerMode): FakeWorker => {
  const directory = join(workDirectory, mode);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    discovery: { outputDirectory: join(workDirectory, 'out'), documentText: null, summary: null, runStatus: 'COMPLETE' },
  }));
};

const managerWith = (worker: FakeWorker): AuditJobManager => {
  manager = createFakeWorkerJobManager({ database, workDirectory, worker, resolveContext, forkWorker: forks.fork });
  return manager;
};

const startOf = (worker: FakeWorker): Record<string, unknown> | undefined => worker.received().find((message) => message['type'] === 'START');

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-no-login-jobs-'));
  mkdirSync(dirname(join(workDirectory, TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TARGET_PATH), JSON.stringify({ target: { id: 'example-no-login' } }), 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  currentContext = CONTEXT;
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('NL-2: the job manager makes the authentication without a login for TEST x NONE', () => {
  it('starts the audit without an auth setup and sends the authentication without a login (setup null, the origins and the digest)', async () => {
    expect(createProfile(database, noLoginProfile(), { resolveContext }).ok).toBe(true);
    const worker = fakeWorker('finish');
    const jobManager = managerWith(worker);
    const started = await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!started.ok) {
      throw new Error(`the audit did not start: ${JSON.stringify(started)}`);
    }
    const ended = await waitForJob(jobManager, started.job.jobId, isJobEnded);
    expect(ended).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', failureReason: null });
    expect(startOf(worker)?.['authentication']).toEqual({
      setup: null,
      approvedTestOrigins: [LOOPBACK_ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(null, [LOOPBACK_ORIGIN], { jobKind: 'AUDIT', automatedLogin: null, approvedServiceOrigins: [] }),
    });
  }, TEST_TIMEOUT_MS);

  it('passes the service origins of the profile as they are, in the authentication without a login of a discovery job', async () => {
    expect(createProfile(database, noLoginProfile([SERVICE_ORIGIN]), { resolveContext }).ok).toBe(true);
    const worker = fakeWorker('hold');
    const jobManager = managerWith(worker);
    const started = await jobManager.startDiscovery({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the discovery did not start: ${JSON.stringify(started)}`);
    }
    await waitForJob(jobManager, started.job.jobId, () => startOf(worker) !== undefined);
    expect(startOf(worker)?.['authentication']).toEqual({
      setup: null,
      approvedTestOrigins: [LOOPBACK_ORIGIN],
      approvedServiceOrigins: [SERVICE_ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(null, [LOOPBACK_ORIGIN], {
        jobKind: 'DISCOVERY', automatedLogin: null, approvedServiceOrigins: [SERVICE_ORIGIN],
      }),
    });
    expect(jobManager.stopAuditJob(started.job.jobId, { force: true }).ok).toBe(true);
    await waitForJob(jobManager, started.job.jobId, isJobEnded);
  }, TEST_TIMEOUT_MS);

  // NL fix round 1（設計書 6.1 の 1。SREV-NL の I-1）: 開始の直前に読み直したターゲットの設定の許可 Origin に、loopback でない Origin が足されていたら、
  // ワーカーを起動せずに拒む（プロファイルの検証し直しの `PROFILE_NO_LOGIN_REQUIRES_LOOPBACK`）。
  it('rejects the start without a worker when the target allowed origins gained an origin that is not loopback', async () => {
    expect(createProfile(database, noLoginProfile(), { resolveContext }).ok).toBe(true);
    currentContext = {
      targetConfig: { ...CONTEXT.targetConfig, site: { ...CONTEXT.targetConfig.site, allowedOrigins: [LOOPBACK_ORIGIN, 'https://app.example.invalid'] } },
    };
    const jobManager = managerWith(fakeWorker('finish'));
    const started = await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    expect(started).toMatchObject({ ok: false, reason: 'PROFILE_INVALID' });
    expect(JSON.stringify(started)).toContain('PROFILE_NO_LOGIN_REQUIRES_LOOPBACK');
    expect(await jobManager.startDiscovery({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION })).toMatchObject({ ok: false, reason: 'PROFILE_INVALID' });
    expect(forks.count()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('treats AUTH_STATE from a job without a login as a protocol violation (no login stage)', async () => {
    expect(createProfile(database, noLoginProfile(), { resolveContext }).ok).toBe(true);
    const worker = fakeWorker('discovery');
    const jobManager = managerWith(worker);
    const started = await jobManager.startDiscovery({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the discovery did not start: ${JSON.stringify(started)}`);
    }
    expect(await waitForJob(jobManager, started.job.jobId, isJobEnded)).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
  }, TEST_TIMEOUT_MS);
});
