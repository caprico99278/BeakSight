// 監査のジョブの管理を、本物のワーカー（一時のビルド）と 127.0.0.1 の fixture のサーバ（`/crawl/` の 5 ページ）で動かす結合テスト（Task 24 の設計書
// 4.4、7 章「ジョブ」。T24e）。ワーカーは本番の依存で動き、Browser の起動だけを、テストだけの外へ出ない引数を足した CLI の起動の設定にする（DEF-277。
// 入口は `tests/helpers/test-audit-worker-entry.ts`。子 process のジョブの管理 `control-audit-jobs-child.ts` にも同じ入口を渡す）。
// - 開始 → `RUNNING` → `FINISHED`（Run の状態と終了コードは中核の結果のまま。成果物がある）。この場面は、専用の fixture のサイト（full-crawl）を製品の
//   既定値で最後まで監査する（T19a。壊したページの ruleId、対照のページ、Guard と違反 0、GET と HEAD だけ、schema とバンドル）。
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
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { AUDIT_SEND_READ_ONLY } from '../../src/core/audit-send-policy.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath, isBundleFileName } from '../../src/core/artifact-layout.js';
import { VIEWPORT_PROFILES, type RunSummary } from '../../src/core/contracts.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../helpers/chromium.js';
import { isJobEnded, waitForJob, type JobViewSource } from '../helpers/job-test-support.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../helpers/process-tree.js';
import {
  STATIC_SITE_EXPECTED_PAGES,
  STATIC_SITE_EXPECTED_RULE_IDS,
  STATIC_SITE_METADATA_DIRECTORY,
  STATIC_SITE_START_PATH,
} from '../helpers/representative-site-answers.js';
import {
  cliTargetConfig,
  expectOnlyReadRequests,
  expectSchemaValid,
  findingsOf,
  readJson,
  readRunArtifactFiles,
  readRunAudit,
  type ArtifactFileContent,
} from '../helpers/run-harness.js';
import { useSharedTemporaryBuild } from '../helpers/shared-temporary-build.js';
import type { TemporaryBuild } from '../helpers/temporary-build.js';
import { installTestAuditWorkerEntry } from '../helpers/test-audit-worker-entry.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { JOB_CHILD_PROTOCOL, startJobChild, type JobChild } from './control-audit-jobs-fixtures.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 設定が変わる場面で、書き換えた後の読み込みの最小の間隔（ms。内容だけを変える）。 */
const FULL_RUN_NAVIGATION_INTERVAL_MS = 2_000;
/**
 * T19a: 専用の fixture のサイト（`fixtures/site/full-crawl/`）。サーバは `/robots.txt` と `/sitemap.xml` をこのサイトのものから返す。監査するページの一覧
 * （発見の順）と壊したページごとの ruleId は、fixture の側の正解（`representative-site-answers.ts`）を使う。
 */
const FULL_CRAWL_PROFILE_ID = 'job-full-crawl';
const FULL_CRAWL_CONTROL_PATH = '/full-crawl/control.html';
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

/** DEF-277: テストだけの入口（Browser の起動に、テストだけの外へ出ない引数を足す。`beforeAll` で一時のビルドの root に書く）。 */
let entry = '';
const workerPath = (): string => entry;

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

/** T19a: 製品の既定値のまま、`site`・出力先・読み込みの最小の間隔（0。ループバックの fixture）だけを書いた、full-crawl のプロファイル。 */
async function prepareFullCrawlProfile(site: FixtureServer): Promise<string> {
  const outputDirectory = join(workDirectory, `${FULL_CRAWL_PROFILE_ID}-output`);
  const targetConfigPath = `config/targets/${FULL_CRAWL_PROFILE_ID}.json`;
  await writeFile(join(workDirectory, targetConfigPath), JSON.stringify({
    target: { id: FULL_CRAWL_PROFILE_ID },
    site: { startUrl: `${site.origin}${STATIC_SITE_START_PATH}`, allowedOrigins: [site.origin] },
    crawl: { minNavigationIntervalMs: 0 },
    output: { directory: outputDirectory },
  }), 'utf8');
  const context = await loadConfigContext(targetConfigPath);
  expect(createProfile(database, {
    schemaVersion: 'beaksight-profile/1',
    profileId: FULL_CRAWL_PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  }, { resolveContext: () => context }).ok).toBe(true);
  hideJobBrowser(database, FULL_CRAWL_PROFILE_ID);
  return outputDirectory;
}

/** 管理データから、ジョブの見え方を読む（本物のワーカーのジョブ）。 */
const databaseJobs: JobViewSource = { getAuditJob: (jobId) => readJob(database, jobId) };
/** 状態が変わるのを待つ上限と、読み直す間隔（本物のワーカーと Chromium のため、共通の既定より長い）。 */
const WAIT_OPTIONS = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });
/** T19a: 製品の既定値で 8 ページを最後まで監査する場面の待ちの上限（幅の走査とスクリーンショットを含む）。 */
const FULL_CRAWL_WAIT_OPTIONS = Object.freeze({ limitMs: SUITE_TIMEOUT_MS - 30_000, pollMs: WAIT_POLL_MS });

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
    build = await useSharedTemporaryBuild();
    entry = installTestAuditWorkerEntry(build);
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

  // T19a（Task 19 の設計書 4.2。SLIM-GROUP で前の `fixture-full-crawl.test.ts` を、利用者の道（ジョブの管理 → 本物のワーカー）のこの場面にまとめた）:
  // 専用の fixture のサイト（`fixtures/site/full-crawl/`）を、製品の既定値（幅の走査・スクリーンショット・Interaction の段）で最後まで監査する。
  it('runs a job from STARTING through RUNNING to FINISHED on the full-crawl fixture with the product defaults (T19a)', async () => {
    const site = await startFixtureServer({ siteMetadataDirectory: STATIC_SITE_METADATA_DIRECTORY });
    try {
      const outputDirectory = await prepareFullCrawlProfile(site);
      site.resetCounters();
      site.resetRequestObservations();
      const jobManager = newManager();
      const job = await startJob(jobManager, FULL_CRAWL_PROFILE_ID);
      expect(job.state).toBe('STARTING');
      const running = await waitForJob(databaseJobs, job.jobId, hasProgress, FULL_CRAWL_WAIT_OPTIONS);
      expect(running.state).toBe('RUNNING');
      const tree = await lastWorkerTree();

      const finished = await waitForJob(databaseJobs, job.jobId, isJobEnded, FULL_CRAWL_WAIT_OPTIONS);
      expect(finished).toMatchObject({ state: 'FINISHED', endKind: 'RAN', failureReason: null });
      await expectNoProcessLeft(tree);
      const runDirectory = join(outputDirectory, finished.runDirectory ?? '');
      const run = await readRun(outputDirectory, finished);
      expect(finished.runId).toBe(run.runId);
      expect(finished.resultRunStatus).toBe(run.runStatus);
      expect(finished.exitCode).toBe(exitCodeForRunStatus(run.runStatus));
      expect(run.runStatus, JSON.stringify(run.incompleteReasons)).toBe('COMPLETE');
      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETE);

      // 製品の既定値（site・出力先・読み込みの間隔のほか）。
      expect(run.effectiveConfig.crawl).toEqual({ ...DEFAULT_CONFIG.crawl, minNavigationIntervalMs: 0 });
      expect(run.effectiveConfig.viewports).toEqual(DEFAULT_CONFIG.viewports);
      // 送信の扱いは、プロファイルの監査の段の設定（このプロファイルは指定なし → 読み取りだけ。AS-b）をワーカーが上書きする。
      expect(run.effectiveConfig.audit).toEqual({ ...DEFAULT_CONFIG.audit, sendPolicy: AUDIT_SEND_READ_ONLY });

      // 監査したページの一覧、壊したページごとの ruleId、対照のページ、sitemap。
      const audit = await readRunAudit(runDirectory);
      const pathOf = (url: string | null): string | null => (url === null ? null : new URL(url).pathname);
      const ruleIdsOn = (path: string): string[] => [...new Set(audit.findings.filter((finding) => pathOf(finding.pageUrl) === path).map(({ ruleId }) => ruleId))];
      expect(audit.pages.map((page) => pathOf(page.pageUrl))).toEqual(STATIC_SITE_EXPECTED_PAGES);
      expect(audit.pages.every((page) => page.status === 'AUDITED')).toBe(true);
      for (const [path, ruleIds] of Object.entries(STATIC_SITE_EXPECTED_RULE_IDS)) {
        expect(ruleIdsOn(path), path).toEqual(expect.arrayContaining([...ruleIds]));
      }
      const control = audit.pages.find((page) => pathOf(page.pageUrl) === FULL_CRAWL_CONTROL_PATH);
      expect(control?.findings).toEqual([]);
      expect(ruleIdsOn(FULL_CRAWL_CONTROL_PATH)).toEqual([]);
      expect(control?.evidence.flatMap((record) => (record.type === 'interaction' ? [record.payload.status] : []))).toContain('VERIFIED');
      expect(findingsOf(audit, 'DISCOVERED_URL_NOT_IN_SITEMAP').map((finding) => pathOf(finding.pageUrl))).toEqual(['/full-crawl/missing.html']);
      expect(findingsOf(audit, 'SITEMAP_URL_NOT_DISCOVERED')).toEqual([]);

      // Guard と違反 0、届いた要求は GET と HEAD だけ（このサイトのパスとサイトの metadata だけ。ブラウザ自身の favicon を除く）。
      expect(run.safety.guardEnabled).toBe(true);
      expect(run.safety.invariantViolationCount).toBe(0);
      expect(run.safety.blockedActions).toEqual({ requests: 0, navigations: 0, externalActions: 0, popups: 0, downloads: 0, webSockets: 0 });
      const observations = site.getRequestObservations();
      expectOnlyReadRequests(site.getCounters(), observations);
      expect([...new Set(observations
        .filter(({ method, pathname }) => !(method === 'GET' && pathname === BROWSER_DEFAULT_FAVICON_PATH))
        .map(({ pathname }) => pathname))].filter((pathname) => !/^\/full-crawl\/|^\/robots\.txt$|^\/sitemap\.xml$/u.test(pathname))).toEqual([]);

      // 成果物と schema、バンドル（run.json と同じバイト列、監査したビューポートの見える範囲の画像が全部ある）。
      const files = await readRunArtifactFiles(runDirectory);
      const bundles = files.map(({ path }) => path).filter((path) => !path.includes('/') && isBundleFileName(path));
      expect(bundles).toHaveLength(1);
      const bundleName = bundles[0] ?? '';
      const fileAt = (path: string): ArtifactFileContent | undefined => files.find((file) => file.path === path);
      for (const name of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
        expect(fileAt(name), name).toBeDefined();
      }
      await expectSchemaValid({ run, pages: audit.pages, findings: audit.findings });
      const textOf = (file: ArtifactFileContent | undefined): string => Buffer.from(file?.bytes ?? new Uint8Array()).toString('utf8');
      expect(textOf(fileAt(`${bundleName}!/${RUN_ARTIFACT_FILE_NAMES.run}`))).toBe(textOf(fileAt(RUN_ARTIFACT_FILE_NAMES.run)));
      const viewportShots = files.filter(({ path }) => new RegExp(`^${bundleName.replaceAll('.', '\\.')}!/pages/PAGE-\\d+/(desktop|mobile)/viewport\\.png$`, 'u').test(path));
      expect(viewportShots).toHaveLength(audit.pages.length * VIEWPORT_PROFILES.length);
    } finally {
      await site.close();
    }
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
