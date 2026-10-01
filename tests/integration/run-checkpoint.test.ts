// R4a（中断した Run の再開の設計書 4.1、4.3、4.3.1、4.4、第7章）: 新しい Run の間の、再開のための保存（チェックポイント）。
// 本物の `ArtifactWriter` を書き手にした保存のセッションを Run Coordinator に渡し、fixture のサイト（`/crawl/`。5ページ）を
// 本物の headless Chromium で監査する。確かめること:
// - `checkpoint/state.json`（と `state.prev.json`）と、監査した各ページの保存が、ページ（先）、状態（後）の順に書かれる。
// - `ArtifactWriter.readCheckpoint` に R2 の整合の確かめを渡して読み戻せ、保存の状態は `IN_PROGRESS` のまま（Run Coordinator は、
//   最後の状態を書かない）。ロックのファイルがある。
// - 保存の Safety Ledger の snapshot（状態の保存のページの外のものと、各ページの保存のもの）が、Run のすべての Ledger になる。
// - CLI が呼ぶ `finish` で、最後の状態が書かれ、ロックが消える。
// R4a2a（設計書 4.4、4.5）: 本物の `ArtifactWriter` を書き手にした保存のセッションの、再開の始め方（`RESUME`）。前の回の古いロック
// （端末の再起動の前の OS の起動の時刻のもの）がある Run のディレクトリで始めると、ロックが自分のものになり、監査の途中だったページの
// ディレクトリが消える。この確かめは、Chromium を使わず、一時ディレクトリの中だけで行う。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import {
  artifactFilePath,
  checkpointArtifactRelativePath,
  PAGES_ARTIFACT_DIRECTORY,
  pageArtifactRelativePath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { createPageId, createRunId } from '../../src/core/ids.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  createRunCheckpoint,
  createRunLock,
  currentProcessRunLockHost,
  decideRunResumption,
  isProcessRunning,
  judgeRunLock,
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointStore,
  type RunLock,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { createRunLauncher, expectOnlyReadRequests, fastRunConfig, readJson } from '../helpers/run-harness.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 整合の確かめ（R2 の関数。再開の流れが読み込みに渡すものと同じ）。 */
const CHECKS = Object.freeze({ checkState: checkRunCheckpointConsistency, checkPage: checkRunCheckpointPageConsistency });

let server: FixtureServer;
let workDirectory: string;
let runDirectory: string;
let result: AuditRunResult;
let writer: ArtifactWriter;
let session: RunCheckpointSession;
/** 保存のセッションが書き手に頼んだ操作（頼んだ順。ハートビートの `rewriteRunLock` を除く）。 */
const storeCalls: string[] = [];
/** この Run で作った Safety Ledger の数。 */
let ledgerCount = 0;
const runLauncher = createRunLauncher();

/** 本物の `ArtifactWriter` に渡し、頼まれた操作を記録する書き手。 */
function recordingStore(target: ArtifactWriter): RunCheckpointStore {
  return {
    writeCheckpointPage: async (directory, page) => {
      storeCalls.push(`page ${page.pageId}`);
      return target.writeCheckpointPage(directory, page);
    },
    writeCheckpointState: async (directory, state) => {
      storeCalls.push(`state ${state.state} [${state.completedPageIds.join(',')}]`);
      await target.writeCheckpointState(directory, state);
    },
    acquireRunLock: async (directory, lock) => {
      storeCalls.push('acquire lock');
      return target.acquireRunLock(directory, lock);
    },
    rewriteRunLock: async (directory, lock) => target.rewriteRunLock(directory, lock),
    readRunLock: async (directory) => {
      storeCalls.push('read lock');
      return target.readRunLock(directory);
    },
    releaseRunLock: async (directory) => {
      storeCalls.push('release lock');
      await target.releaseRunLock(directory);
    },
    cleanUpForResume: async (directory, completedPageIds) => {
      storeCalls.push('clean up');
      return target.cleanUpForResume(directory, completedPageIds);
    },
  };
}

const checkpointFile = (file: 'state' | 'previousState' | 'lock'): string =>
  artifactFilePath(runDirectory, checkpointArtifactRelativePath(file));

/** 保存を、R2 の整合の確かめを渡して読み戻す（読めなければ失敗にする）。 */
async function readSavedCheckpoint(): Promise<{ readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] }> {
  const read = await writer.readCheckpoint(runDirectory, CHECKS);
  if (!read.ok) {
    throw new Error(`the checkpoint could not be read: ${JSON.stringify(read.failures)}`);
  }
  expect(read.source).toBe('state');
  expect(read.failures).toEqual([]);
  return { state: read.state, pages: read.pages };
}

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-run-checkpoint-'));
  writer = new ArtifactWriter();
  session = new RunCheckpointSession({ store: recordingStore(writer), now: () => Date.now() });
  server.resetCounters();
  server.resetRequestObservations();
  result = await new RunCoordinator({
    config: fastRunConfig(server.origin, START_PATH),
    launchBrowser: runLauncher.launcher,
    createSafetyLedger: () => {
      ledgerCount += 1;
      return new SafetyLedger();
    },
    clock: () => new Date(),
    now: () => Date.now(),
    outputDirectory: workDirectory,
    checkpointSession: session,
  }).run();
  runDirectory = runArtifactDirectory(workDirectory, result.run.runId);
}, RUN_TEST_TIMEOUT_MS);

afterAll(async () => {
  // 終えていなければ、ハートビートを止める（ロックは、一時ディレクトリごと消す）。
  await session?.abandon();
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Run').toBe(0);
});

describe('R4a: checkpoints of a new Run with the real ArtifactWriter (resumable run design 4.3)', () => {
  it('audits the fixture site with only read requests, as without a session', () => {
    expect(result.pages.map(({ status }) => status).every((status) => status !== 'SKIPPED')).toBe(true);
    expect(result.pages).toHaveLength(5);
    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
  });

  it('writes the lock, the state after robots.txt and sitemap.xml, and then the page and the state after every page', async () => {
    const pageIds = result.pages.map(({ pageId }) => pageId);
    expect(storeCalls).toEqual([
      'acquire lock',
      'state IN_PROGRESS []',
      ...pageIds.flatMap((pageId, index) => [`page ${pageId}`, `state IN_PROGRESS [${pageIds.slice(0, index + 1).join(',')}]`]),
    ]);
    expect((await readdir(join(runDirectory, 'checkpoint'))).sort()).toEqual(['pages', 'run.lock', 'state.json', 'state.prev.json']);
    expect((await readdir(join(runDirectory, 'checkpoint', 'pages'))).sort()).toEqual(pageIds.map((pageId) => `${pageId}.json`).sort());
  });

  it('reads the checkpoint back through ArtifactWriter.readCheckpoint with the R2 consistency checks, still IN_PROGRESS', async () => {
    const { state, pages } = await readSavedCheckpoint();

    expect(state.state).toBe('IN_PROGRESS');
    expect(state.runId).toBe(result.run.runId);
    expect(state.executions).toEqual([{ startedAt: result.run.startedAt, finishedAt: null, endReason: null, environment: result.run.environment }]);
    expect(state.completedPageIds).toEqual(result.pages.map(({ pageId }) => pageId));
    expect(state.progress.pagesStarted).toBe(result.pages.length);
    expect(decideRunResumption(state)).toBe('RESUME');
    // ページの保存の結果に、robots.txt と sitemap.xml の Evidence（開始の URL のページ）と、再試行の前の試行の Evidence を前に加えると、
    // 出力のページになる。
    const metadataIds = state.siteMetadata?.records.map(({ evidenceId }) => evidenceId) ?? [];
    expect(metadataIds).toHaveLength(2);
    expect(pages.map(({ pageId }) => pageId)).toEqual(state.completedPageIds);
    pages.forEach((page, index) => {
      const output = result.pages[index];
      expect(page.result.status).toBe(output?.status);
      expect(output?.evidence.map(({ evidenceId }) => evidenceId)).toEqual([
        ...(index === 0 ? metadataIds : []),
        ...page.retryEvidence.map(({ evidenceId }) => evidenceId),
        ...page.result.evidence.map(({ evidenceId }) => evidenceId),
      ]);
    });
  });

  it('keeps every Safety Ledger of the Run: the ones outside the pages in state.json and the ones of each page in its page checkpoint', async () => {
    const { state, pages } = await readSavedCheckpoint();
    const pageSnapshots = pages.flatMap(({ safetyLedgerSnapshots }) => safetyLedgerSnapshots);

    expect(state.safetyLedgerSnapshots.length).toBeGreaterThan(0);
    expect(pages.every(({ safetyLedgerSnapshots }) => safetyLedgerSnapshots.length > 0)).toBe(true);
    expect(state.safetyLedgerSnapshots.length + pageSnapshots.length).toBe(ledgerCount);
    // 保存の snapshot から集計した Safety が、Run の Safety と同じになる（再開の後の最後の処理に使える）。
    expect(summarizeRunSafety({ guardEnabled: true, snapshots: [...state.safetyLedgerSnapshots, ...pageSnapshots] })).toEqual(result.run.safety);
  });

  it('leaves the lock of this process, which is judged as the lock of a running Run', async () => {
    const lock = await readJson(checkpointFile('lock'));
    const nowMs = Date.now();

    expect(lock).toMatchObject({ processId: process.pid });
    expect(judgeRunLock(lock, { nowMs, bootedAtMs: currentProcessRunLockHost(nowMs).bootedAtMs, isProcessRunning })).toBe('ACTIVE');
  });

  it('writes the final state and removes the lock when the session is finished (as the CLI will do after the final output)', async () => {
    const { state } = await readSavedCheckpoint();
    const { schemaVersion: _schemaVersion, ...input } = state;
    // 最後の状態の保存の、この実行の記録の終わりの時刻と、保存の時刻は、Run の終わりの時刻と同じ（設計書 4.3.2）。`FINISHED` の保存の
    // 最後の実行の記録は、終わり方と終わりの時刻を持つ（R4b1 の実行の記録の整合。設計書 4.8）。
    const finishedAt = result.run.finishedAt ?? state.savedAt;
    const finalState = createRunCheckpoint({
      ...input,
      state: 'FINISHED',
      savedAt: finishedAt,
      executions: [{ ...state.executions[0], finishedAt, endReason: 'COMPLETED' }],
    });

    await session.finish(finalState);

    const finished = await readSavedCheckpoint();
    expect(finished.state).toEqual(finalState);
    expect(await readJson(checkpointFile('previousState'))).toEqual(state);
    expect((await readdir(join(runDirectory, 'checkpoint'))).sort()).toEqual(['pages', 'state.json', 'state.prev.json']);
    expect(storeCalls.slice(-2)).toEqual([`state FINISHED [${state.completedPageIds.join(',')}]`, 'release lock']);
  });
});

describe('R4a2a: resuming a run directory with a stale lock, with the real ArtifactWriter (resumable run design 4.4, 4.5)', () => {
  it('takes over the lock of the previous execution (before an OS restart), removes the unfinished page, and keeps the lock against another resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beaksight-run-checkpoint-resume-'));
    const resumeWriter = new ArtifactWriter();
    const resumed = new RunCheckpointSession({ store: resumeWriter, now: () => Date.now() });
    const another = new RunCheckpointSession({ store: resumeWriter, now: () => Date.now() });
    try {
      const directory = runArtifactDirectory(root, createRunId(20261001000000));
      const finishedPage = createPageId(1);
      const unfinishedPage = createPageId(2);
      const pageFile = (pageId: typeof finishedPage): string => artifactFilePath(directory, pageArtifactRelativePath(pageId, 'page'));
      // 前の回: 端末を再起動する前の OS で取ったロック（OS の起動の時刻が、許す誤差より前。プロセスの ID は、動いているこのプロセスの
      // ものにして、ID の使い回しを模す）。終わったページと、監査の途中だったページのディレクトリ。
      const previousAtMs = Date.now() - RUN_LOCK_HEARTBEAT_INTERVAL_MS;
      const previous = createRunLock({
        processId: process.pid,
        nowMs: previousAtMs,
        bootedAtMs: currentProcessRunLockHost(previousAtMs).bootedAtMs - RUN_LOCK_BOOT_TIME_TOLERANCE_MS - RUN_LOCK_HEARTBEAT_INTERVAL_MS,
      });
      await expect(resumeWriter.acquireRunLock(directory, previous)).resolves.toEqual({ acquired: true });
      for (const pageId of [finishedPage, unfinishedPage]) {
        await mkdir(dirname(pageFile(pageId)), { recursive: true });
        await writeFile(pageFile(pageId), '{}', 'utf8');
      }
      const lockFile = artifactFilePath(directory, checkpointArtifactRelativePath('lock'));
      const startedAtMs = Date.now();

      await expect(resumed.start(directory, { mode: 'RESUME', completedPageIds: [finishedPage] })).resolves.toEqual({
        ok: true,
        removedPaths: [`${PAGES_ARTIFACT_DIRECTORY}/${unfinishedPage}`],
      });

      // ロックは、このセッションが作り直したもの（ロックを取った時刻が、始めた後）で、動いている Run のものと判定される。
      const lock = await readJson(lockFile) as RunLock;
      expect(lock).toMatchObject({ processId: process.pid });
      expect(lock.acquiredAtMs).toBeGreaterThanOrEqual(startedAtMs);
      await expect(resumeWriter.readRunLock(directory)).resolves.toEqual(lock);
      const judgedAtMs = Date.now();
      expect(judgeRunLock(lock, { nowMs: judgedAtMs, bootedAtMs: currentProcessRunLockHost(judgedAtMs).bootedAtMs, isProcessRunning }))
        .toBe('ACTIVE');
      expect(existsSync(pageFile(finishedPage))).toBe(true);
      expect(existsSync(artifactFilePath(directory, `${PAGES_ARTIFACT_DIRECTORY}/${unfinishedPage}`))).toBe(false);

      // 同じ Run のディレクトリを、別のセッションは再開しない（ロックも、終わったページも、そのまま）。
      await expect(another.start(directory, { mode: 'RESUME', completedPageIds: [] })).resolves.toEqual({
        ok: false,
        reason: 'LOCK_HELD_BY_ACTIVE_RUN',
        existingLock: lock,
      });
      expect(await readJson(lockFile)).toEqual(lock);
      expect(existsSync(pageFile(finishedPage))).toBe(true);
    } finally {
      await resumed.abandon();
      await another.abandon();
      await rm(root, { recursive: true, force: true });
    }
  });
});
