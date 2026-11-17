// DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断、3 章の受け入れ条件 2）: 本物のワーカー（一時のビルド）を、本物の
// ジョブの管理（`createAuditJobManager`）で fork して、大きな保存から再開しても途絶えで止められないことを確かめる。
// - RB-6: 前の「重い終わりの注入」の 2 場面は消した。「Run の終わり」の段の知らせの後は止めない・段の外では今どおり止めるは、偽のワーカーの
//   `control-audit-jobs.test.ts`（DEF-143 の 5 場面）、ワーカーが段の知らせを `FINISHED` の前に送るは `audit-worker-session.test.ts` の単体にある。
// - 大きな保存からの再開: 重いページの fixture で止めた Run の保存を、雛形の写しで 149 ページ・150 MB 以上に増やし、本番の process の組み立てのワーカー（Browser の起動だけテストの引数つき）で再開して、最後まで
//   終わる（`WORKER_UNRESPONSIVE` にならない）。見張りの上限は短くする（大きな保存の「Run の終わり」の段は、それより長く main thread を占めうる）。
// ブラウザは headless（`hideJobBrowser`）。サーバは 127.0.0.1 だけ。管理データと出力先は一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobContextResolver,
  type AuditJobManager,
  type AuditJobTiming,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import { createPageId } from '../../src/core/ids.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { isJobEnded, waitForJob, type JobViewSource } from '../helpers/job-test-support.js';
import { inflateCheckpoint, startHeavyPageSite, type HeavyPageSite } from '../helpers/large-checkpoint-fixture.js';
import { cliTargetConfig, readJson } from '../helpers/run-harness.js';
import { useSharedTemporaryBuild } from '../helpers/shared-temporary-build.js';
import type { TemporaryBuild } from '../helpers/temporary-build.js';
import { installTestAuditWorkerEntry } from '../helpers/test-audit-worker-entry.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 600_000;
/** 状態が変わるのを待つ上限と、読み直す間隔（ms）。 */
const WAIT_OPTIONS = Object.freeze({ limitMs: 300_000, pollMs: 100 });

/**
 * 大きな保存の場面: ページの数、1 ページの行の数、監査を終えたページの数（残り 1 ページを再開で監査する）。DEF-264: 行の数は、雛形の 1 ページの保存が約 1 MB
 * （149 ページの写しで 150 MB を少し超える）になるようにする（雛形が膨らむと、ワーカーのメモリの別の問題 DEF-266 に当たる）。REC-3 でディスクの形が
 * 短くなったので、行の数を 18 から 70 にした（149 ページで、18 行は約 62 MB、44 行は約 109 MB だった）。
 */
const HEAVY_PAGE_COUNT = 150;
const HEAVY_PAGE_ROWS = 70;
const INFLATED_COMPLETED_PAGES = 149;
/** 大きな保存の合計の下限（バイト。受け入れ条件 1 の「150 MB 以上」）。 */
const INFLATED_MIN_TOTAL_BYTES = 150_000_000;
/** 大きな保存の場面の見張りの時間（ms。ふだんの上限は本番より短い。合図の間隔は本番の 2 秒）。 */
const LARGE_RUN_TIMING: Partial<AuditJobTiming> = Object.freeze({
  heartbeatTimeoutMs: 6_000,
  watchdogIntervalMs: 500,
  watchdogLagLimitMs: 3_000,
});

let heavySite: HeavyPageSite;
let build: TemporaryBuild;
let workDirectory: string;
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
/** 本物の `fork` で起動し、起動した子を記録する（CC-097: `worker-fork.ts` の補助）。 */
const forks = createCountingFork();
const workers: readonly ChildProcess[] = forks.children;
const recordingFork: AuditWorkerForker = forks.fork;

const loadConfigContext: AuditJobContextResolver = async (targetConfigPath) => ({
  targetConfig: await loadConfig(join(workDirectory, targetConfigPath)),
});

const databaseJobs: JobViewSource = { getAuditJob: (jobId) => readJob(database, jobId) };

/** DEF-277: 本番の process の組み立てを、Browser の起動だけテストだけの外へ出ない引数つきにして動かす入口（`beforeAll` で書く）。 */
let entry = '';
const productionWorkerPath = (): string => entry;

const newManager = (workerPath: string, timing: Partial<AuditJobTiming>): AuditJobManager => {
  manager = createAuditJobManager({
    database,
    repositoryRoot: workDirectory,
    workerPath,
    resolveContext: loadConfigContext,
    forkWorker: recordingFork,
    timing,
  });
  return manager;
};

/** `name` のターゲット JSON と公開の監査のプロファイルを作り、出力先を返す。 */
async function prepareProfile(name: string, origin: string, startPath: string, extra: Record<string, unknown>): Promise<string> {
  const outputDirectory = join(workDirectory, `${name}-output`);
  const targetConfigPath = `config/targets/${name}.json`;
  await writeFile(join(workDirectory, targetConfigPath), JSON.stringify(cliTargetConfig(name, origin, startPath, {
    ...extra,
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
  hideJobBrowser(database, name);
  return outputDirectory;
}

async function startJob(jobManager: AuditJobManager, profileId: string, startNew: boolean): Promise<AuditJobView> {
  const result = await jobManager.startAuditJob({ profileId, expectedRevision: MIN_PROFILE_REVISION, startNew });
  if (!result.ok) {
    throw new Error(`the job did not start: ${result.reason}`);
  }
  return result.job;
}

const readRun = async (outputDirectory: string, job: AuditJobView): Promise<RunSummary> =>
  await readJson(artifactFilePath(join(outputDirectory, job.runDirectory ?? ''), RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;

beforeAll(async () => {
  heavySite = await startHeavyPageSite(HEAVY_PAGE_COUNT, HEAVY_PAGE_ROWS);
  build = await useSharedTemporaryBuild();
  entry = installTestAuditWorkerEntry(build);
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-worker-finalizing-'));
  await mkdir(join(workDirectory, 'config', 'targets'), { recursive: true });
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
}, SUITE_TIMEOUT_MS);

afterEach(async () => {
  await manager?.close();
  manager = undefined;
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = workers.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of leftovers) {
    child.kill();
  }
  if (database !== undefined) {
    closeControlDatabase(database);
  }
  await build?.remove();
  await heavySite?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers.length, 'workers left running after the tests').toBe(0);
}, SUITE_TIMEOUT_MS);

describe('DEF-143 (acceptance 2): resuming a Run with a large checkpoint with the real worker', () => {
  it('stops a Run, resumes it from 149 pages of more than 150 MB, and finishes without WORKER_UNRESPONSIVE', async () => {
    const profileId = 'large-resume';
    const outputDirectory = await prepareProfile(profileId, heavySite.origin, heavySite.pagePath(1), {
      crawl: { maxPages: HEAVY_PAGE_COUNT, minNavigationIntervalMs: 0 },
      audit: { screenshots: false, interactions: false },
    });
    const jobManager = newManager(productionWorkerPath(), LARGE_RUN_TIMING);

    // 1 回目: 最初のページの後に止める（雛形の保存を作る）。
    const first = await startJob(jobManager, profileId, true);
    await waitForJob(databaseJobs, first.jobId, (job) => (job.lastProgress?.pagesFinished ?? 0) >= 1, WAIT_OPTIONS);
    expect(jobManager.stopAuditJob(first.jobId).ok).toBe(true);
    const stopped = await waitForJob(databaseJobs, first.jobId, isJobEnded, WAIT_OPTIONS);
    expect(stopped).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', failureReason: null });

    // 保存を 149 ページ・150 MB 以上に増やす。
    const runDirectory = join(outputDirectory, stopped.runDirectory ?? '');
    const inflated = await inflateCheckpoint(runDirectory, createPageId(1), INFLATED_COMPLETED_PAGES);
    expect(inflated.totalBytes).toBeGreaterThanOrEqual(INFLATED_MIN_TOTAL_BYTES);

    // 2 回目: 本番の入口のワーカーで再開し、最後まで終わる。
    const second = await startJob(jobManager, profileId, false);
    const finished = await waitForJob(databaseJobs, second.jobId, isJobEnded, WAIT_OPTIONS);
    expect(finished).toMatchObject({ state: 'FINISHED', endKind: 'RAN', failureReason: null, runId: stopped.runId });
    expect(finished.lastProgress?.pagesFinished).toBe(HEAVY_PAGE_COUNT);
    const run = await readRun(outputDirectory, finished);
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
    expect({ discovered: run.discoveredPageCount, skipped: run.skippedPageCount }).toEqual({ discovered: HEAVY_PAGE_COUNT, skipped: 0 });
    expect(existsSync(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
    expect(heavySite.nonReadRequests()).toBe(0);
  }, SUITE_TIMEOUT_MS);
});
