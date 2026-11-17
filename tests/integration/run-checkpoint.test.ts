// R4a（中断した Run の再開の設計書 4.1、4.3、4.3.1、4.4、第7章）: 新しい Run の間の、再開のための保存（チェックポイント）。
// 本物の `ArtifactWriter` を書き手にした保存のセッションを Run Coordinator に渡し、fixture のサイト（`/crawl/`。5ページ）を
// 本物の headless Chromium で監査する。確かめること:
// - `checkpoint/state.json`（と `state.prev.json`）と、監査した各ページの保存が、ページ（先）、状態（後）の順に書かれる。
// - `ArtifactWriter.readCheckpoint` に R2 の整合の確かめを渡して読み戻せ、保存の状態は `IN_PROGRESS` のまま（Run Coordinator は、
//   最後の状態を書かない）。SPEC-2: Run のディレクトリにロックを置かない（監査中の印は出力先のロック）。
// - 保存の Safety Ledger の snapshot（状態の保存のページの外のものと、各ページの保存のもの）が、Run のすべての Ledger になる。
// - CLI が呼ぶ `finish` で、最後の状態が書かれる。
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { artifactFilePath, checkpointArtifactRelativePath, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  createRunCheckpoint,
  decideRunResumption,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointStore,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { auditRunArrayOf } from '../helpers/audit-run-fixture.js';
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
/** 保存のセッションが書き手に頼んだ操作（頼んだ順）。 */
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
    cleanUpForResume: async (directory, completedPageIds) => {
      storeCalls.push('clean up');
      return target.cleanUpForResume(directory, completedPageIds);
    },
  };
}

const checkpointFile = (file: 'state' | 'previousState'): string =>
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
  session = new RunCheckpointSession({ store: recordingStore(writer) });
  server.resetCounters();
  server.resetRequestObservations();
  result = await auditRunArrayOf(await new RunCoordinator({
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
  }).run());
  runDirectory = runArtifactDirectory(workDirectory, result.run.runId);
}, RUN_TEST_TIMEOUT_MS);

afterAll(async () => {
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

  it('writes the state after robots.txt and sitemap.xml, and then the page and the state after every page', async () => {
    const pageIds = result.pages.map(({ pageId }) => pageId);
    expect(storeCalls).toEqual([
      'state IN_PROGRESS []',
      ...pageIds.flatMap((pageId, index) => [`page ${pageId}`, `state IN_PROGRESS [${pageIds.slice(0, index + 1).join(',')}]`]),
    ]);
    expect((await readdir(join(runDirectory, 'checkpoint'))).sort()).toEqual(['pages', 'state.json', 'state.prev.json']);
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
    // AS-b: 実効の監査の段の送信の扱いも渡す（この Run は既定の読み取りだけ）。
    expect(summarizeRunSafety({ guardEnabled: true, snapshots: [...state.safetyLedgerSnapshots, ...pageSnapshots], auditSendPolicy: 'READ_ONLY' }))
      .toEqual(result.run.safety);
  });

  it('writes the final state when the session is finished (as the CLI will do after the final output)', async () => {
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
    expect(storeCalls.at(-1)).toBe(`state FINISHED [${state.completedPageIds.join(',')}]`);
  });
});
