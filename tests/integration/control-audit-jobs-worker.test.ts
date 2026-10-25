// 監査のジョブの管理を、本物のワーカー（一時のビルドの `dist/worker/audit-worker.js`）と 127.0.0.1 の fixture のサーバ（`/crawl/` の 5 ページ）で
// 動かす結合テスト（Task 24 の設計書 4.4、7 章「ジョブ」。T24e）。ワーカーは本番の依存（CLI と同じ Chromium の起動の設定）で動く。
// - 開始 → `RUNNING` → `FINISHED`（Run の状態と終了コードは中核の結果のまま。成果物がある）。
// - 止める → PARTIAL（`STOPPED_BY_SIGNAL`）、強制 → 終了コード 5、ワーカーの強制終了 → `INTERRUPTED`（`WORKER_EXITED`）。
// - 画面のサーバの終わり（`shutdownAuditJobs`）: `STOP` を送って終わりを待つ。
// - 画面のサーバが落ちた（子 process のジョブの管理を強制終了）→ ワーカーと Chromium が残らない → 起動し直すと `recoverInterruptedJobs` で
//   `INTERRUPTED`（`SERVER_RESTARTED`）。
// - どの場面でも、ワーカーと、その子孫（Chromium）が残らない（ID と起動の時刻で見分ける）。fixture のサーバに届いた要求は GET と HEAD だけ。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, INTERRUPTED_EXIT_CODE, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobContextResolver,
  type AuditJobManager,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { hideJobBrowser } from '../helpers/worker-fork-support.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { isJobEnded, waitForJob, type JobViewSource } from '../helpers/job-test-support.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../helpers/process-tree.js';
import { cliTargetConfig, expectOnlyReadRequests, readJson } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { JOB_CHILD_PROTOCOL, startJobChild, type JobChild } from './control-audit-jobs-fixtures.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 最後まで監査する場面のページの読み込みの最小の間隔（ms。プロセスの一覧を読む間も Chromium が動いているように）。 */
const FULL_RUN_NAVIGATION_INTERVAL_MS = 2_000;
/** 止める場面の間隔（ms。1 ページ目の進み具合の後、止める要求が届く前に、次の読み込みが始まらないように）。 */
const STOPPING_NAVIGATION_INTERVAL_MS = 3_000;
/** 状態が変わるのを待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
/** ワーカーが終わった後に、Chromium のプロセスが消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 15_000;
/** 終わりのときに、ジョブの終わりを待つ時間（ms。今のページを終えて書き出すまで）。 */
const SHUTDOWN_WAIT_MS = 60_000;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
/** 本物の `fork` で起動し、起動した子を記録する（CC-097: `worker-fork.ts` の補助）。 */
const forks = createCountingFork();
const workers: readonly ChildProcess[] = forks.children;
const jobChildren: JobChild[] = [];

const recordingFork: AuditWorkerForker = forks.fork;

/** 画面のサーバと同じ形の文脈の読み方（リポジトリの root の下のターゲット JSON を `loadConfig` で読む）。 */
const loadConfigContext: AuditJobContextResolver = async (targetConfigPath) => ({
  targetConfig: await loadConfig(join(workDirectory, targetConfigPath)),
});

const workerPath = (): string => join(build.distDirectory, 'worker', 'audit-worker.js');

const newManager = (): AuditJobManager => {
  manager = createAuditJobManager({
    database,
    repositoryRoot: workDirectory,
    workerPath: workerPath(),
    resolveContext: loadConfigContext,
    forkWorker: recordingFork,
  });
  return manager;
};

/** `name` の場面のターゲット JSON とプロファイルを作り、出力先を返す。 */
async function prepareProfile(name: string, minNavigationIntervalMs: number): Promise<string> {
  const outputDirectory = join(workDirectory, `${name}-output`);
  const targetConfigPath = `config/targets/${name}.json`;
  await writeFile(join(workDirectory, targetConfigPath), JSON.stringify(cliTargetConfig(name, server.origin, START_PATH, {
    crawl: { minNavigationIntervalMs },
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  })), 'utf8');
  const context = await loadConfigContext(targetConfigPath);
  const created = createProfile(database, {
    schemaVersion: 'beaksight-profile/1',
    profileId: name,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  }, { resolveContext: () => context });
  expect(created.ok).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。
  hideJobBrowser(database, name);
  return outputDirectory;
}

/** 管理データから、ジョブの見え方を読む（本物のワーカーのジョブ）。 */
const databaseJobs: JobViewSource = { getAuditJob: (jobId) => readJob(database, jobId) };
/** 状態が変わるのを待つ上限と、読み直す間隔（本物のワーカーと Chromium のため、共通の既定より長い）。 */
const WAIT_OPTIONS = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

const hasProgress = (job: AuditJobView): boolean => job.state !== 'STARTING' && job.lastProgress !== null;
async function startJob(jobManager: AuditJobManager, profileId: string): Promise<AuditJobView> {
  const result = await jobManager.startAuditJob({ profileId, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
  if (!result.ok) {
    throw new Error(`the job did not start: ${result.reason}`);
  }
  return result.job;
}

/** 最後に起動したワーカーと、その子孫（Chromium）。Chromium が動いている間に読む。 */
async function lastWorkerTree(): Promise<readonly ProcessIdentity[]> {
  const worker = workers.at(-1);
  const processes = await listProcesses();
  const self = processes.filter(({ processId }) => processId === worker?.pid);
  const descendants = descendantsOf(worker?.pid ?? 0, processes);
  expect(descendants.length, 'the worker has no child process (Chromium) while it audits').toBeGreaterThan(0);
  return [...self, ...descendants];
}

async function expectNoProcessLeft(tree: readonly ProcessIdentity[]): Promise<void> {
  expect(await waitUntilExited(tree, PROCESS_EXIT_LIMIT_MS), 'processes left after the job ended').toEqual([]);
}

const readRun = async (outputDirectory: string, job: AuditJobView): Promise<RunSummary> =>
  await readJson(artifactFilePath(join(outputDirectory, job.runDirectory ?? ''), RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;

describe('audit jobs with the real worker (Task 24 design 4.4)', () => {
  beforeAll(async () => {
    server = await startFixtureServer();
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-control-audit-jobs-worker-'));
    await mkdir(join(workDirectory, 'config', 'targets'), { recursive: true });
    database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  }, SUITE_TIMEOUT_MS);

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(jobChildren.map(async (child) => child.kill()));
    const leftovers = workers.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of leftovers) {
      child.kill();
    }
    if (database !== undefined) {
      closeControlDatabase(database);
    }
    await build?.remove();
    await server?.close();
    if (workDirectory !== undefined) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    expect(leftovers.length, 'workers left running after the tests').toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('runs a job from STARTING through RUNNING to FINISHED with the Run status and the exit code of the core', async () => {
    server.resetCounters();
    server.resetRequestObservations();
    const outputDirectory = await prepareProfile('job-full', FULL_RUN_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-full');
    expect(job.state).toBe('STARTING');
    const running = await waitForJob(databaseJobs, job.jobId, hasProgress, WAIT_OPTIONS);
    expect(running.state).toBe('RUNNING');
    const tree = await lastWorkerTree();

    const finished = await waitForJob(databaseJobs, job.jobId, isJobEnded, WAIT_OPTIONS);
    expect(finished).toMatchObject({ state: 'FINISHED', endKind: 'RAN', failureReason: null });
    const run = await readRun(outputDirectory, finished);
    expect(finished.runId).toBe(run.runId);
    expect(finished.resultRunStatus).toBe(run.runStatus);
    expect(finished.exitCode).toBe(exitCodeForRunStatus(run.runStatus));
    expect(existsSync(artifactFilePath(join(outputDirectory, finished.runDirectory ?? ''), RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
    expect(finished.lastProgress?.pagesFinished).toBeGreaterThan(0);
    await expectNoProcessLeft(tree);
    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
  }, SUITE_TIMEOUT_MS);

  it('stops a job: STOPPING, then FINISHED with PARTIAL (STOPPED_BY_SIGNAL) and the exit code of PARTIAL', async () => {
    const outputDirectory = await prepareProfile('job-stop', STOPPING_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-stop');
    await waitForJob(databaseJobs, job.jobId, hasProgress, WAIT_OPTIONS);
    const tree = await lastWorkerTree();

    expect(jobManager.stopAuditJob(job.jobId)).toMatchObject({ ok: true, job: { state: 'STOPPING' } });
    const finished = await waitForJob(databaseJobs, job.jobId, isJobEnded, WAIT_OPTIONS);
    expect(finished).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', exitCode: EXIT_CODES.PARTIAL });
    expect(finished.stopRequestedAt).not.toBeNull();
    const run = await readRun(outputDirectory, finished);
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL']);
    await expectNoProcessLeft(tree);
  }, SUITE_TIMEOUT_MS);

  it('stops a job with force: INTERRUPTED WORKER_EXITED with the exit code 5', async () => {
    await prepareProfile('job-force', STOPPING_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-force');
    await waitForJob(databaseJobs, job.jobId, hasProgress, WAIT_OPTIONS);
    const tree = await lastWorkerTree();

    jobManager.stopAuditJob(job.jobId, { force: true });
    expect(await waitForJob(databaseJobs, job.jobId, isJobEnded, WAIT_OPTIONS))
      .toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED', exitCode: INTERRUPTED_EXIT_CODE });
    await expectNoProcessLeft(tree);
  }, SUITE_TIMEOUT_MS);

  it('records INTERRUPTED WORKER_EXITED when the worker is killed, and Chromium does not stay', async () => {
    await prepareProfile('job-killed', STOPPING_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-killed');
    await waitForJob(databaseJobs, job.jobId, hasProgress, WAIT_OPTIONS);
    const tree = await lastWorkerTree();

    workers.at(-1)?.kill();
    expect(await waitForJob(databaseJobs, job.jobId, isJobEnded, WAIT_OPTIONS)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    await expectNoProcessLeft(tree);
  }, SUITE_TIMEOUT_MS);

  // T24h-1 の M3: 開始の直前の検証の後、ワーカーが読む前に設定が変わったら、監査を始めない（サーバに要求を送らない）。
  it('records FAILED CONFIG_CHANGED when the target configuration changes between the check and the worker reading it', async () => {
    server.resetCounters();
    const outputDirectory = await prepareProfile('job-config-changed', STOPPING_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-config-changed');
    // 開始を受けた直後（ワーカーの `READY` の前）に、同じ形で内容だけを変える。
    await writeFile(join(workDirectory, 'config', 'targets', 'job-config-changed.json'), JSON.stringify(cliTargetConfig('job-config-changed', server.origin, START_PATH, {
      crawl: { minNavigationIntervalMs: FULL_RUN_NAVIGATION_INTERVAL_MS },
      audit: { screenshots: false },
      output: { directory: outputDirectory },
    })), 'utf8');

    expect(await waitForJob(databaseJobs, job.jobId, isJobEnded, WAIT_OPTIONS))
      .toMatchObject({ state: 'FAILED', failureReason: 'CONFIG_CHANGED', exitCode: EXIT_CODES.CONFIG_ERROR, runId: null });
    expect(existsSync(outputDirectory)).toBe(false);
    expect(server.getCounters().get).toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('sends STOP on shutdown and waits for the end of the job', async () => {
    await prepareProfile('job-shutdown', STOPPING_NAVIGATION_INTERVAL_MS);
    const jobManager = newManager();
    const job = await startJob(jobManager, 'job-shutdown');
    await waitForJob(databaseJobs, job.jobId, hasProgress, WAIT_OPTIONS);
    const tree = await lastWorkerTree();

    expect(await jobManager.shutdownAuditJobs({ waitMs: SHUTDOWN_WAIT_MS })).toEqual({ stopRequested: 1, killed: 0 });
    expect(readJob(database, job.jobId)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', exitCode: EXIT_CODES.PARTIAL });
    await expectNoProcessLeft(tree);
  }, SUITE_TIMEOUT_MS);

  it('leaves no worker and no Chromium when the UI server process dies, and the next server marks the job INTERRUPTED', async () => {
    await prepareProfile('job-crash', STOPPING_NAVIGATION_INTERVAL_MS);
    const child = await startJobChild({
      databasePath: resolveControlDatabasePath(workDirectory),
      repositoryRoot: workDirectory,
      workerPath: workerPath(),
      contextKind: JOB_CHILD_PROTOCOL.loadConfigContext,
    });
    jobChildren.push(child);
    const result = await child.start('job-crash', MIN_PROFILE_REVISION);
    expect(result.ok).toBe(true);
    const jobId = result.jobId ?? '';
    await waitForJob(databaseJobs, jobId, hasProgress, WAIT_OPTIONS);
    const processes = await listProcesses();
    const tree = descendantsOf(child.process.pid ?? 0, processes);
    expect(tree.some(({ processId }) => processId === result.workerPid)).toBe(true);
    expect(tree.length, 'the worker has no Chromium').toBeGreaterThan(1);

    await child.kill();
    await expectNoProcessLeft(tree);
    expect(readJob(database, jobId)?.state).toBe('RUNNING');

    const jobManager = newManager();
    expect(jobManager.recoverInterruptedJobs()).toBe(1);
    expect(jobManager.getAuditJob(jobId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'SERVER_RESTARTED' });
    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
  }, SUITE_TIMEOUT_MS);
});
