// R4a2b（中断した Run の再開の設計書 3.1、3.2、4.4、4.5、第7章）: 保存からの再開と「中断しなかった場合と同じ」。
// 本物の `ArtifactWriter` を書き手にした保存のセッションと、本物の headless Chromium で、fixture のサイト（`/crawl/`。5ページ。
// 入口 → level-1、missing（404）→ level-2 → level-3 の順に監査する）を監査し、次の2つを比べる。
// - A: 中断しない Run（セッションあり）。
// - B: k ページ目の保存の後で中断する Run と、その保存から再開した Run。中断は、本物の `ArtifactWriter` を包んだ書き手が、k+1 ページ目の
//   ページの保存の前に、テスト用の例外を投げる形で模す。最初の Run Coordinator の結果は捨て（プロセスが終わったことを模す）、保存を
//   `ArtifactWriter.readCheckpoint` で読み、`decideRunResumption` で `RESUME` を確かめてから、新しい Run Coordinator に `resumeFrom` で渡す。
//   最初の Run のロックは、端末を再起動する前の OS の起動の時刻で取り（端末の再起動を模す）、再開のセッションが作り直す。
// 違反の後の再開（新しいページを始めず `ABORTED_BY_SAFETY`）も、同じ fixture のサイトで確かめる。
// 再開の直後の最初の読み込みが、前の回の最後の読み込みから最小の間隔以上空くことは、注入した時計で、単体のテスト
// （`tests/unit/run-coordinator.test.ts`）で確かめる（本物の時計では、再開までに間隔より長い時間がたつため）。ここでは、読み込みの
// 回数が、保存の値から続くことを確かめる。
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { finishAuditRun } from '../../src/cli/run-command.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  artifactFilePath,
  bundleFileName,
  CHECKPOINT_ARTIFACT_DIRECTORY,
  checkpointArtifactRelativePath,
  isBundleFileName,
  pageArtifactRelativePath,
  PAGES_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, Finding, PageAuditResult, PageId, RunProgressReport, RunSummary } from '../../src/core/contracts.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
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
  type RunLockHost,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  RunCoordinator,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorResumeInput,
} from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  captureCliOutput,
  createRunLauncher,
  expectOnlyReadRequests,
  expectSchemaValid,
  fastRunConfig,
  readJson,
  readRunAudit,
} from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 監査の順の、fixture のサイトのページ（パス）。 */
const CRAWL_PATHS = Object.freeze([
  '/crawl/index.html',
  '/crawl/level-1.html',
  '/crawl/missing.html',
  '/crawl/level-2.html',
  '/crawl/level-3.html',
]);
/** robots.txt と sitemap.xml のパス。 */
const SITE_METADATA_PATHS = Object.freeze(['/robots.txt', '/sitemap.xml']);
/** 整合の確かめ（R2 の関数。再開の流れの呼び出し側が、読み込みに渡すもの）。 */
const CHECKS = Object.freeze({ checkState: checkRunCheckpointConsistency, checkPage: checkRunCheckpointPageConsistency });

/** テスト用の、Run を止める例外（その時点でプロセスが終わったことを模す）。 */
class SimulatedInterruption extends Error {
  constructor() {
    super('simulated interruption of the process');
    this.name = 'SimulatedInterruption';
  }
}

/** 本物の `ArtifactWriter` を包んだ書き手が頼まれた操作（頼まれた順。ハートビートの書き換えも含む）。 */
type StoreCall =
  | { readonly kind: 'page'; readonly pageId: PageId }
  | { readonly kind: 'state'; readonly completedPageIds: readonly PageId[] }
  | { readonly kind: 'acquire lock' | 'rewrite lock' | 'read lock' | 'release lock' }
  | { readonly kind: 'clean up'; readonly removedPaths: readonly string[] };

interface StoreOptions {
  /** この回数目（1から）のページの保存の前に、`SimulatedInterruption` を投げる（ページの保存は書かない）。 */
  readonly interruptBeforePage?: number;
  /** 状態の保存を書く前に、書く値を、この関数が返した値に置き換える（R4a2b-fix-round-1。保存の値を書き換えた形の守りのテストのため）。 */
  readonly rewriteState?: (state: RunCheckpoint) => RunCheckpoint;
  /** 状態の保存を書いた後に、書いた値で呼ぶ。 */
  readonly afterState?: (state: RunCheckpoint) => void;
}

/** 本物の `ArtifactWriter` を包み、頼まれた操作を `calls` に記録する書き手。 */
function wrappedStore(target: ArtifactWriter, calls: StoreCall[], options: StoreOptions = {}): RunCheckpointStore {
  let pageWrites = 0;
  return {
    writeCheckpointPage: async (directory, page) => {
      pageWrites += 1;
      if (pageWrites === options.interruptBeforePage) {
        throw new SimulatedInterruption();
      }
      calls.push({ kind: 'page', pageId: page.pageId });
      return target.writeCheckpointPage(directory, page);
    },
    writeCheckpointState: async (directory, requested) => {
      const state = options.rewriteState?.(requested) ?? requested;
      calls.push({ kind: 'state', completedPageIds: state.completedPageIds });
      await target.writeCheckpointState(directory, state);
      options.afterState?.(state);
    },
    acquireRunLock: async (directory, lock) => {
      calls.push({ kind: 'acquire lock' });
      return target.acquireRunLock(directory, lock);
    },
    rewriteRunLock: async (directory, lock) => {
      calls.push({ kind: 'rewrite lock' });
      await target.rewriteRunLock(directory, lock);
    },
    readRunLock: async (directory) => {
      calls.push({ kind: 'read lock' });
      return target.readRunLock(directory);
    },
    releaseRunLock: async (directory) => {
      calls.push({ kind: 'release lock' });
      await target.releaseRunLock(directory);
    },
    cleanUpForResume: async (directory, completedPageIds) => {
      const removedPaths = await target.cleanUpForResume(directory, completedPageIds);
      calls.push({ kind: 'clean up', removedPaths });
      return removedPaths;
    },
  };
}

/**
 * 端末を再起動する前の OS で取ったロックの値（OS の起動の時刻が、許す誤差より前。プロセスの ID は、動いているこのプロセスのもので、
 * ID の使い回しを模す）。最初の Run のセッションが使う。
 */
const lockHostBeforeOsRestart = (nowMs: number): RunLockHost => {
  const host = currentProcessRunLockHost(nowMs);
  return { ...host, bootedAtMs: host.bootedAtMs - RUN_LOCK_BOOT_TIME_TOLERANCE_MS - RUN_LOCK_HEARTBEAT_INTERVAL_MS };
};

const findingKey = ({ findingId, ruleId, fingerprint }: Finding): readonly string[] => [findingId, ruleId, fingerprint];

/**
 * 「中断しなかった場合と同じ」で比べる項目（設計書 第7章）: ページの一覧と ID と状態、Evidence の ID と種類、Finding の ID・ruleId・
 * fingerprint（ページのものと Run のもの）、Run Status、SKIPPED の理由、Safety の集計（違反の件数、記録の切り詰め、遮断の件数、除外した
 * Interaction の候補の件数）、ページの件数、Run の理由、上限への到達、再試行の記録。
 *
 * 比べない項目（理由）:
 * - Run の ID（A と B は別の Run）。
 * - 時刻（`startedAt`、`finishedAt`、Evidence の `observedAt`）と、時刻や読み込みにかかった時間を含む Evidence の値（`payload`）。
 * - `load`（中断したページを2回読むので、読み込みと要求の数が違う）。
 * - 実行の記録（保存の `executions`）と環境（`environment`）。
 */
function comparableRun(result: AuditRunResult): unknown {
  const { run } = result;
  return {
    runStatus: run.runStatus,
    pages: result.pages.map((page) => ({
      pageId: page.pageId,
      pageUrl: page.pageUrl,
      status: page.status,
      skipReasons: page.status === 'SKIPPED' ? page.incompleteReasons : null,
      evidence: page.evidence.map(({ evidenceId, type }) => [evidenceId, type]),
      findings: page.findings.map(findingKey),
    })),
    findings: result.findings.map(findingKey),
    safety: run.safety,
    pageCounts: {
      discovered: run.discoveredPageCount,
      audited: run.auditedPageCount,
      partial: run.partialPageCount,
      failed: run.failedPageCount,
      skipped: run.skippedPageCount,
    },
    incompleteReasons: run.incompleteReasons,
    crawlLimits: run.crawlLimits,
    retries: run.retries,
  };
}

/** 保存を、R2 の整合の確かめを渡して、本物の `ArtifactWriter` で読む（`state.json` を使えなければ失敗にする）。 */
async function readSavedCheckpoint(runDirectory: string): Promise<{ readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] }> {
  const read = await new ArtifactWriter().readCheckpoint(runDirectory, CHECKS);
  if (!read.ok) {
    throw new Error(`the checkpoint could not be read: ${JSON.stringify(read.failures)}`);
  }
  expect(read.source).toBe('state');
  return { state: read.state, pages: read.pages };
}

/** Run のディレクトリの下の、ファイルの相対パス（区切りは `/`。名前の順）。 */
async function filesUnder(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();
/** 作った保存のセッション（後片付けで、ハートビートを止める）。 */
const sessions: RunCheckpointSession[] = [];

function newSession(store: RunCheckpointStore, createLockHost?: (nowMs: number) => RunLockHost): RunCheckpointSession {
  const session = new RunCheckpointSession({
    store,
    now: () => Date.now(),
    ...(createLockHost === undefined ? {} : { createLockHost }),
  });
  sessions.push(session);
  return session;
}

/** 本物の Chromium で、Run Coordinator の Run を行う（時計は実際の時刻）。 */
async function runCoordinator(input: {
  readonly config: AuditConfig;
  readonly outputDirectory: string;
  readonly session: RunCheckpointSession;
  readonly resumeFrom?: RunCoordinatorResumeInput;
  readonly createSafetyLedger?: () => SafetyLedger;
}): Promise<AuditRunResult> {
  return await new RunCoordinator({
    config: input.config,
    launchBrowser: runLauncher.launcher,
    createSafetyLedger: input.createSafetyLedger ?? (() => new SafetyLedger()),
    clock: () => new Date(),
    now: () => Date.now(),
    outputDirectory: input.outputDirectory,
    checkpointSession: input.session,
    ...(input.resumeFrom === undefined ? {} : { resumeFrom: input.resumeFrom }),
  }).run();
}

/** fixture のサーバが、前に `resetRequestObservations` してから受け取った要求のパス。 */
const observedPaths = (): string[] => server.getRequestObservations().map(({ pathname }) => pathname);

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resume-run-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  for (const session of sessions) {
    await session.abandon();
  }
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

describe('R4a2b: a Run interrupted after the k-th page checkpoint and resumed is the same as the Run without the interruption (resumable run design 7)', () => {
  /** 中断する前に保存を終えるページの数（k）。k+1 ページ目（/crawl/level-2.html）の監査の後、そのページの保存の前に中断する。 */
  const PAGES_BEFORE_INTERRUPTION = 3;
  /** 前の回の、監査の途中だったページのディレクトリに置く、古いファイル（再開の後に残らないこと）。 */
  const STALE_FILE_NAME = 'stale-screenshot-from-the-previous-execution.png';

  let config: AuditConfig;
  let uninterrupted: AuditRunResult;
  let uninterruptedDirectory: string;
  let runDirectory: string;
  let saved: { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };
  let previousLock: RunLock;
  let interruptedPageId: PageId;
  let interruptedPageFilesBeforeResume: string[];
  let pathsObservedByResumedRun: string[];
  let resumed: AuditRunResult;
  let resumedAtMs: number;
  const interruptedCalls: StoreCall[] = [];
  const resumedCalls: StoreCall[] = [];

  beforeAll(async () => {
    // スクリーンショットを撮る（監査の途中だったページのディレクトリに、前の回のスクリーンショットが残るようにする）。
    config = fastRunConfig(server.origin, START_PATH, { audit: { screenshots: true } });

    // A: 中断しない Run。
    const uninterruptedOutput = join(workDirectory, 'uninterrupted');
    uninterrupted = await runCoordinator({
      config,
      outputDirectory: uninterruptedOutput,
      session: newSession(new ArtifactWriter()),
    });
    uninterruptedDirectory = runArtifactDirectory(uninterruptedOutput, uninterrupted.run.runId);

    // B-1: k+1 ページ目のページの保存の前に中断する Run（結果は捨てる）。ロックは、端末を再起動する前の OS で取る。
    const interruptedOutput = join(workDirectory, 'interrupted');
    const interruptedSession = newSession(
      wrappedStore(new ArtifactWriter(), interruptedCalls, { interruptBeforePage: PAGES_BEFORE_INTERRUPTION + 1 }),
      lockHostBeforeOsRestart,
    );
    const discarded = await runCoordinator({ config, outputDirectory: interruptedOutput, session: interruptedSession });
    // プロセスが終わったことを模す（ハートビートを止める。ロックのファイルは残る）。
    await interruptedSession.abandon();
    runDirectory = runArtifactDirectory(interruptedOutput, discarded.run.runId);
    previousLock = await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'))) as RunLock;

    // B-2: 保存を読み、再開できることを確かめてから、新しい Run Coordinator で再開する。
    saved = await readSavedCheckpoint(runDirectory);
    expect(decideRunResumption(saved.state)).toBe('RESUME');
    interruptedPageId = uninterrupted.pages[PAGES_BEFORE_INTERRUPTION]?.pageId as PageId;
    const interruptedPageDirectory = artifactFilePath(runDirectory, `${PAGES_ARTIFACT_DIRECTORY}/${interruptedPageId}`);
    await writeFile(join(interruptedPageDirectory, STALE_FILE_NAME), 'stale', 'utf8');
    interruptedPageFilesBeforeResume = await filesUnder(interruptedPageDirectory);
    server.resetCounters();
    server.resetRequestObservations();
    resumedAtMs = Date.now();
    resumed = await runCoordinator({
      config,
      outputDirectory: join(workDirectory, 'resumed-output-root'),
      session: newSession(wrappedStore(new ArtifactWriter(), resumedCalls)),
      resumeFrom: { runDirectory, checkpoint: saved.state, pages: saved.pages },
    });
    pathsObservedByResumedRun = observedPaths();
  }, SUITE_TIMEOUT_MS);

  it('interrupts the first Run before the page checkpoint of the k+1-th page, leaving a resumable checkpoint of k pages', () => {
    expect(uninterrupted.pages.map(({ pageUrl }) => new URL(pageUrl).pathname)).toEqual(CRAWL_PATHS);
    expect(uninterrupted.pages.every(({ status }) => status !== 'SKIPPED')).toBe(true);
    const pageIds = uninterrupted.pages.map(({ pageId }) => pageId);
    expect(interruptedCalls.filter(({ kind }) => kind === 'page' || kind === 'state')).toEqual([
      { kind: 'state', completedPageIds: [] },
      ...pageIds.slice(0, PAGES_BEFORE_INTERRUPTION).flatMap((pageId, index) => [
        { kind: 'page', pageId },
        { kind: 'state', completedPageIds: pageIds.slice(0, index + 1) },
      ]),
    ]);
    expect(saved.state.state).toBe('IN_PROGRESS');
    expect(saved.state.completedPageIds).toEqual(pageIds.slice(0, PAGES_BEFORE_INTERRUPTION));
    expect(saved.pages.map(({ pageId }) => pageId)).toEqual(saved.state.completedPageIds);
    // 監査の途中だったページには、前の回のスクリーンショット（と、置いた古いファイル）がある。
    expect(interruptedPageFilesBeforeResume).toContain(STALE_FILE_NAME);
    expect(interruptedPageFilesBeforeResume.filter((file) => file.endsWith('.png') && !file.endsWith(STALE_FILE_NAME)).length)
      .toBeGreaterThan(0);
  });

  it('gives the same pages, IDs, Evidence, Findings, Run Status, skip reasons and Safety summary as the Run without the interruption', async () => {
    expect(comparableRun(resumed)).toEqual(comparableRun(uninterrupted));
    await expectSchemaValid(resumed);
  });

  it('keeps the Run ID, the run directory and the start of the first execution, and continues the load record', () => {
    expect(resumed.run.runId).toBe(saved.state.runId);
    expect(resumed.run.startedAt).toBe(saved.state.startedAt);
    // Run のディレクトリは作らない（前の回のものを使う）。
    expect(existsSync(join(workDirectory, 'resumed-output-root'))).toBe(false);
    expect(resumed.run.load.navigationCount).toBeGreaterThan(saved.state.load.pacer.navigationCount);
    expect(resumed.run.load.requests.allowedOrigins.count).toBeGreaterThan(saved.state.load.meter.allowedOrigins.count);
  });

  it('remakes the stale lock of the previous execution (before an OS restart) and removes the directory of the unfinished page', async () => {
    // 前の回のロックは、OS の起動の時刻が違うので古いとみなされ、作り直される（書き換えて読み直し、後始末をしてから保存する）。
    expect(resumedCalls.slice(0, 4).map(({ kind }) => kind)).toEqual(['acquire lock', 'rewrite lock', 'read lock', 'clean up']);
    const lock = await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'))) as RunLock;
    expect(lock.bootedAtMs).not.toBe(previousLock.bootedAtMs);
    expect(lock.acquiredAtMs).toBeGreaterThanOrEqual(resumedAtMs);
    const judgedAtMs = Date.now();
    expect(judgeRunLock(lock, { nowMs: judgedAtMs, bootedAtMs: currentProcessRunLockHost(judgedAtMs).bootedAtMs, isProcessRunning }))
      .toBe('ACTIVE');
    // 監査の途中だったページのディレクトリは消され、そのページは最初から監査し直される（古いファイルは残らず、スクリーンショットは
    // 中断しなかった Run と同じものがそろう）。
    const cleanUp = resumedCalls.find((call) => call.kind === 'clean up');
    expect(cleanUp).toEqual({ kind: 'clean up', removedPaths: [`${PAGES_ARTIFACT_DIRECTORY}/${interruptedPageId}`] });
    const pagePath = `${PAGES_ARTIFACT_DIRECTORY}/${interruptedPageId}`;
    const filesAfterResume = await filesUnder(artifactFilePath(runDirectory, pagePath));
    expect(filesAfterResume).not.toContain(STALE_FILE_NAME);
    expect(filesAfterResume).toEqual(await filesUnder(artifactFilePath(uninterruptedDirectory, pagePath)));
  });

  it('does not request robots.txt, sitemap.xml or the finished pages again, and sends only read requests', () => {
    for (const path of [...SITE_METADATA_PATHS, ...CRAWL_PATHS.slice(0, PAGES_BEFORE_INTERRUPTION)]) {
      expect(pathsObservedByResumedRun, path).not.toContain(path);
    }
    for (const path of CRAWL_PATHS.slice(PAGES_BEFORE_INTERRUPTION)) {
      expect(pathsObservedByResumedRun, path).toContain(path);
    }
    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
  });

  it('keeps saving after the resume: the earlier pages stay, and the execution of this resume is added', async () => {
    const pageIds = uninterrupted.pages.map(({ pageId }) => pageId);
    expect(resumedCalls.filter(({ kind }) => kind === 'page')).toEqual(
      pageIds.slice(PAGES_BEFORE_INTERRUPTION).map((pageId) => ({ kind: 'page', pageId })),
    );
    const { state, pages } = await readSavedCheckpoint(runDirectory);
    expect(state.completedPageIds).toEqual(pageIds);
    expect(pages.map(({ pageId }) => pageId)).toEqual(pageIds);
    expect(state).toMatchObject({ state: 'IN_PROGRESS', runId: saved.state.runId, startedAt: saved.state.startedAt });
    // 前の回の実行は、プロセスが途中で終わったので、終わり方を `INTERRUPTED_ABNORMALLY`、終わりの時刻を前の回の最後の保存の時刻に
    // して閉じる（R4b1。設計書 4.8）。この保存は、上の読み直し（`ArtifactWriter.readCheckpoint` と整合の確かめ）を通っている。
    expect(saved.state.executions).toHaveLength(1);
    expect(saved.state.executions[0]).toMatchObject({ finishedAt: null, endReason: null });
    expect(state.executions).toHaveLength(2);
    expect(state.executions[0]).toEqual({
      ...saved.state.executions[0],
      finishedAt: saved.state.savedAt,
      endReason: 'INTERRUPTED_ABNORMALLY',
    });
    expect(state.executions[1]).toMatchObject({ finishedAt: null, endReason: null });
    // 保存の時刻は、その値を作った時点の時計の値（前の回の最後の保存は、その実行の開始の後。再開の後の保存は、再開した実行の開始の後）。
    const resumedStartedAtMs = Date.parse(state.executions[1]?.startedAt ?? '');
    expect(Date.parse(saved.state.savedAt)).toBeGreaterThanOrEqual(Date.parse(saved.state.executions[0].startedAt));
    expect(resumedStartedAtMs).toBeGreaterThanOrEqual(resumedAtMs);
    expect(Date.parse(state.savedAt)).toBeGreaterThanOrEqual(resumedStartedAtMs);
    expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
    // run.json の実行の記録（R4b2。設計書 4.8）: 前の回は INTERRUPTED_ABNORMALLY（終わりの時刻は前の回の最後の保存の時刻）、この実行が最後。
    // 環境は含めない。
    expect(resumed.run.executions).toEqual([
      { startedAt: saved.state.executions[0].startedAt, finishedAt: saved.state.savedAt, endReason: 'INTERRUPTED_ABNORMALLY' },
      { startedAt: state.executions[1]?.startedAt, finishedAt: resumed.run.finishedAt, endReason: 'COMPLETED' },
    ]);
  });
});

// R4a2b-fix-round-1（中断した Run の再開の設計書 4.2 の最後の項目）: Run Coordinator は、各ページの保存の前に、そのページの Ledger を
// 調べて、保存の「違反の検出」のフラグを書く。違反を、ページの中の最後の確かめの後（ページの最後の Ledger）に記録しても、そのページの
// 保存のフラグは真で、再開の判定は `FINALIZE_ONLY` になる。保存のフラグが偽で、保存した snapshot に違反がある形（R4a2b の守り）は、
// 書き手が、状態の保存の書き出しで、フラグだけを偽にした値を書く形で確かめる（判定は `RESUME` になるが、Run Coordinator は snapshot の
// 違反で止まる）。
describe.each([
  { name: 'the saved flag', rewriteSavedFlag: false, flags: [true, false], decision: 'FINALIZE_ONLY' },
  { name: 'the snapshot only (the guard)', rewriteSavedFlag: true, flags: [false, false], decision: 'RESUME' },
] as const)('R4a2b: resuming after a safety invariant violation found in $name starts no new page (resumable run design 3.2, 4.2)', ({
  rewriteSavedFlag,
  flags,
  decision,
}) => {
  /** 違反を記録するページ（何番目に監査するページか。1から）。そのページの Mobile の Ledger に、違反を記録する。 */
  const VIOLATION_PAGE = 2;
  /**
   * 違反のページで作る Ledger のうち、違反を記録するものの順番（1から）。Desktop、Mobile の順に作り（fixture のページには
   * Interaction の候補がない）、Mobile の後には、ページの中の違反の確かめがない（違反は、ページの中の確かめでは見つからない）。
   */
  const VIOLATION_LEDGER_ORDINAL = 2;
  /** 最初の Run と再開した Run の出力先の名前（2つの形で分ける）。 */
  const OUTPUT_NAME = rewriteSavedFlag ? 'violation-flag-rewritten' : 'violation';

  let first: AuditRunResult;
  let resumed: AuditRunResult;
  let saved: { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };
  let pathsObservedByResumedRun: string[];

  beforeAll(async () => {
    const config = fastRunConfig(server.origin, START_PATH);
    // 違反のページの1つ前のページの状態の保存の後に作る Ledger が、違反のページのもの。
    let violationPageLedgers: number | null = null;
    const createSafetyLedger = (): SafetyLedger => {
      const ledger = new SafetyLedger();
      if (violationPageLedgers !== null) {
        violationPageLedgers += 1;
        if (violationPageLedgers === VIOLATION_LEDGER_ORDINAL) {
          ledger.recordInvariantViolation({ code: 'TEST_INJECTED_VIOLATION', message: 'injected by the resume test' });
        }
      }
      return ledger;
    };
    const firstOutput = join(workDirectory, OUTPUT_NAME);
    const firstSession = newSession(
      wrappedStore(new ArtifactWriter(), [], {
        // 守りの形では、状態の保存の「違反の検出」のフラグだけを偽にして書く。
        ...(rewriteSavedFlag
          ? { rewriteState: (state: RunCheckpoint): RunCheckpoint => ({ ...state, progress: { ...state.progress, safetyViolationDetected: false } }) }
          : {}),
        afterState: (state) => {
          if (state.completedPageIds.length === VIOLATION_PAGE - 1 && violationPageLedgers === null) {
            violationPageLedgers = 0;
          }
        },
      }),
      lockHostBeforeOsRestart,
    );
    // 最初の Run は、違反のページの保存の後、次のページを始めずに終わる。保存は、違反のページの後のもので終わっているので、その時点で
    // プロセスが終わった場合と同じである（結果は、比べるために使う）。
    first = await runCoordinator({ config, outputDirectory: firstOutput, session: firstSession, createSafetyLedger });
    await firstSession.abandon();
    const runDirectory = runArtifactDirectory(firstOutput, first.run.runId);
    saved = await readSavedCheckpoint(runDirectory);
    server.resetCounters();
    server.resetRequestObservations();
    resumed = await runCoordinator({
      config,
      outputDirectory: join(workDirectory, `${OUTPUT_NAME}-resumed-output-root`),
      session: newSession(new ArtifactWriter()),
      resumeFrom: { runDirectory, checkpoint: saved.state, pages: saved.pages },
    });
    pathsObservedByResumedRun = observedPaths();
  }, SUITE_TIMEOUT_MS);

  it('leaves the checkpoint after the page with the violation, with the violation in the saved Ledger snapshot of the page', () => {
    expect(first.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(saved.state.state).toBe('IN_PROGRESS');
    expect(saved.state.completedPageIds).toHaveLength(VIOLATION_PAGE);
    // 「止めた」ことのフラグは、そのページの保存の時点では、まだ偽（残りの URL を止めるのは、次のページを始める前の確かめ）。
    const [safetyViolationDetected, stoppedBySafetyViolation] = flags;
    expect(saved.state.progress).toMatchObject({ safetyViolationDetected, stoppedBySafetyViolation });
    expect(decideRunResumption(saved.state)).toBe(decision);
    const violationPage = saved.pages[VIOLATION_PAGE - 1];
    expect(violationPage?.safetyLedgerSnapshots.map(({ invariantViolationCount }) => invariantViolationCount)).toEqual([0, 1]);
  });

  it('starts no new page, requests nothing of the site, and is ABORTED_BY_SAFETY as without the interruption', () => {
    expect(resumed.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(resumed.run.safety.invariantViolationCount).toBe(1);
    expect(resumed.pages.slice(VIOLATION_PAGE).map(({ status, incompleteReasons }) => [status, incompleteReasons])).toEqual(
      resumed.pages.slice(VIOLATION_PAGE).map(() => ['SKIPPED', [{ code: 'SAFETY_VIOLATION_ABORT', detail: null }]]),
    );
    expect(resumed.pages.length).toBeGreaterThan(VIOLATION_PAGE);
    expect(pathsObservedByResumedRun.filter((path) => path.startsWith('/crawl/') || SITE_METADATA_PATHS.includes(path))).toEqual([]);
    expect(comparableRun(resumed)).toEqual(comparableRun(first));
  });
});

// R4b2（中断した Run の再開の設計書 4.3.2、4.5、4.6.1、4.8、第7章）: 止める印の形の「中断しなかった場合と同じ」。
// - A: 中断しない Run（セッションあり）。
// - B: `onProgress` で k ページ目が終わったときに `AbortController.abort()` を呼ぶ Run（PARTIAL。保存の終わり方は `FINISH`・`STOPPED`）と、
//   その最後の状態の保存から再開した Run。
// どの Run も、CLI と同じ順（`finishAuditRun` で出力を書いた後に、`checkpointConclusion()` に従ってセッションの `finish` か `abandon`）で終える。
// 比べる項目は、R4a2b と同じ（`comparableRun`）。加えて、B の再開の後の Run のディレクトリのファイルの一覧（`checkpoint/` を除く）が、
// A と同じであること（STOPPED の回の出力が残っても、最後の出力のファイルの集まりが変わらない。設計書 4.5）。
// 比べない項目（R4a2b と同じ）: Run の ID、時刻、時刻を含む Evidence の値、`load`、`executions`（A と B の間）、`environment`。
describe('R4b2: a Run stopped by the stop signal after the k-th page and resumed is the same as the Run without the stop (resumable run design 4.6.1, 7)', () => {
  /** 止める印を付ける前に監査を終えるページの数（k）。k ページ目の進み具合の報告で、印を付ける。 */
  const PAGES_BEFORE_STOP = 2;

  let uninterrupted: AuditRunResult;
  let uninterruptedDirectory: string;
  let uninterruptedConclusion: RunCoordinatorCheckpointConclusion;
  let stopped: AuditRunResult;
  let stoppedConclusion: RunCoordinatorCheckpointConclusion;
  let stoppedState: RunCheckpoint;
  let runDirectory: string;
  let resumed: AuditRunResult;
  let resumedConclusion: RunCoordinatorCheckpointConclusion;
  let finalState: RunCheckpoint;
  let resumedExecutionStartedAtMs: number;

  /**
   * CLI と同じ順で Run を終える（設計書 4.7.1）: `finishAuditRun` で出力を書いた後に、保存の終わり方に従って、`FINISH` ならセッションの
   * `finish` に最後の状態の保存を渡し、`ABANDON` なら `abandon` を呼ぶ。表示の出力先は、テストの中の偽のもの。
   */
  async function finishLikeCli(
    coordinator: RunCoordinator,
    session: RunCheckpointSession,
    result: AuditRunResult,
    outputDirectory: string,
  ): Promise<RunCoordinatorCheckpointConclusion> {
    await finishAuditRun(result, outputDirectory, captureCliOutput().output);
    const conclusion = coordinator.checkpointConclusion();
    if (conclusion.action === 'FINISH') {
      await session.finish(conclusion.checkpoint);
    } else if (conclusion.action === 'ABANDON') {
      await session.abandon();
    }
    return conclusion;
  }

  /** 本物の Chromium で Run を行う Run Coordinator（時計は実際の時刻）。 */
  const coordinatorFor = (input: {
    readonly config: AuditConfig;
    readonly outputDirectory: string;
    readonly session: RunCheckpointSession;
    readonly resumeFrom?: RunCoordinatorResumeInput;
    readonly stopSignal?: AbortSignal;
    readonly onProgress?: (report: RunProgressReport) => void;
  }): RunCoordinator => new RunCoordinator({
    config: input.config,
    launchBrowser: runLauncher.launcher,
    createSafetyLedger: () => new SafetyLedger(),
    clock: () => new Date(),
    now: () => Date.now(),
    outputDirectory: input.outputDirectory,
    checkpointSession: input.session,
    ...(input.resumeFrom === undefined ? {} : { resumeFrom: input.resumeFrom }),
    ...(input.stopSignal === undefined ? {} : { stopSignal: input.stopSignal }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });

  /** Run のディレクトリのファイルの一覧（`checkpoint/` の下を除く）。 */
  const outputFilesUnder = async (directory: string): Promise<string[]> =>
    (await filesUnder(directory)).filter((file) => !file.startsWith(`${CHECKPOINT_ARTIFACT_DIRECTORY}/`));

  beforeAll(async () => {
    // スクリーンショットを撮る（STOPPED の回と再開の後の出力のファイルの集まりを、スクリーンショットを含めて比べる）。
    const config = fastRunConfig(server.origin, START_PATH, { audit: { screenshots: true } });

    // A: 中断しない Run。
    const uninterruptedOutput = join(workDirectory, 'signal-uninterrupted');
    const uninterruptedSession = newSession(new ArtifactWriter());
    const uninterruptedCoordinator = coordinatorFor({ config, outputDirectory: uninterruptedOutput, session: uninterruptedSession });
    uninterrupted = await uninterruptedCoordinator.run();
    uninterruptedConclusion = await finishLikeCli(uninterruptedCoordinator, uninterruptedSession, uninterrupted, uninterruptedOutput);
    uninterruptedDirectory = runArtifactDirectory(uninterruptedOutput, uninterrupted.run.runId);

    // B-1: k ページ目の監査が終わったときに、止める印を付ける Run。
    const stoppedOutput = join(workDirectory, 'signal-stopped');
    const controller = new AbortController();
    const stoppedSession = newSession(new ArtifactWriter());
    const stoppedCoordinator = coordinatorFor({
      config,
      outputDirectory: stoppedOutput,
      session: stoppedSession,
      stopSignal: controller.signal,
      onProgress: (report) => {
        if (report.pagesFinished === PAGES_BEFORE_STOP) {
          controller.abort();
        }
      },
    });
    stopped = await stoppedCoordinator.run();
    stoppedConclusion = await finishLikeCli(stoppedCoordinator, stoppedSession, stopped, stoppedOutput);
    runDirectory = runArtifactDirectory(stoppedOutput, stopped.run.runId);

    // B-2: 最後の状態の保存を読み、再開できることを確かめてから、新しい Run Coordinator で再開する。
    const saved = await readSavedCheckpoint(runDirectory);
    stoppedState = saved.state;
    expect(decideRunResumption(stoppedState)).toBe('RESUME');
    const resumedSession = newSession(new ArtifactWriter());
    const resumedCoordinator = coordinatorFor({
      config,
      outputDirectory: join(workDirectory, 'signal-resumed-output-root'),
      session: resumedSession,
      resumeFrom: { runDirectory, checkpoint: saved.state, pages: saved.pages },
    });
    resumedExecutionStartedAtMs = Date.now();
    resumed = await resumedCoordinator.run();
    // 出力は、前の回と同じ Run のディレクトリ（`<出力先>/<Run の ID>`）に書く。
    resumedConclusion = await finishLikeCli(resumedCoordinator, resumedSession, resumed, stoppedOutput);
    finalState = (await readSavedCheckpoint(runDirectory)).state;
  }, SUITE_TIMEOUT_MS);

  it('stops after the k-th page with PARTIAL, skips the rest with RUN_INTERRUPTED, and leaves a STOPPED checkpoint', () => {
    expect(uninterrupted.pages.map(({ pageUrl }) => new URL(pageUrl).pathname)).toEqual(CRAWL_PATHS);
    expect(uninterruptedConclusion.action).toBe('FINISH');
    expect(stopped.run.runStatus).toBe('PARTIAL');
    const audited = stopped.pages.filter(({ status }) => status !== 'SKIPPED');
    expect(audited.map(({ pageId }) => pageId)).toEqual(uninterrupted.pages.slice(0, PAGES_BEFORE_STOP).map(({ pageId }) => pageId));
    const skipped = stopped.pages.filter(({ status }) => status === 'SKIPPED');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every(({ incompleteReasons }) => JSON.stringify(incompleteReasons) === JSON.stringify([{ code: 'RUN_INTERRUPTED', detail: null }])))
      .toBe(true);
    expect(stopped.run.incompleteReasons).toContainEqual({ code: 'RUN_INTERRUPTED', detail: null });
    expect(stopped.run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL']);
    expect(stoppedConclusion.action).toBe('FINISH');
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.completedPageIds).toEqual(audited.map(({ pageId }) => pageId));
    expect(stoppedState.savedAt).toBe(stopped.run.finishedAt);
  });

  it('gives the same pages, IDs, Evidence, Findings, Run Status, skip reasons and Safety summary as the Run without the stop', async () => {
    expect(comparableRun(resumed)).toEqual(comparableRun(uninterrupted));
    await expectSchemaValid(resumed);
  });

  // BN1（ChatGPT 用バンドルのファイル名の設計書 2.1）: バンドルの名前は、その Run の最後の実行の終わりの時刻を含むので、中断しなかった Run と
  // 再開した Run とで違う。名前の一致は求めず、ほかのファイルの一覧を比べる。バンドルは、それぞれの Run のディレクトリにちょうど1つあり、
  // 名前は、それぞれの run.json の `executions` の最後の `finishedAt` から `bundleFileName` で作ったものであることを確かめる。
  it('leaves the same set of output files in the run directory as the Run without the stop (except checkpoint/ and the bundle name)', async () => {
    const files = await outputFilesUnder(runDirectory);
    const withoutBundles = (paths: readonly string[]): readonly string[] => paths.filter((path) => !isBundleFileName(path));
    expect(files.length).toBeGreaterThan(0);
    expect(withoutBundles(files)).toEqual(withoutBundles(await outputFilesUnder(uninterruptedDirectory)));
    for (const directory of [runDirectory, uninterruptedDirectory]) {
      const written = await readJson(artifactFilePath(directory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
      const expectedBundle = bundleFileName(written.executions[written.executions.length - 1]?.finishedAt ?? '');
      expect((await outputFilesUnder(directory)).filter(isBundleFileName), directory).toEqual([expectedBundle]);
    }
  });

  it('records the stopped execution and the resumed one in run.json, and finishes the checkpoint as FINISHED', async () => {
    expect(resumed.run.executions).toEqual([
      { startedAt: stopped.run.startedAt, finishedAt: stopped.run.finishedAt, endReason: 'STOPPED_BY_SIGNAL' },
      { startedAt: expect.any(String), finishedAt: resumed.run.finishedAt, endReason: 'COMPLETED' },
    ]);
    expect(Date.parse(resumed.run.executions[1]?.startedAt ?? '')).toBeGreaterThanOrEqual(resumedExecutionStartedAtMs);
    const written = await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as AuditRunResult['run'];
    expect(written.executions).toEqual(resumed.run.executions);
    expect(resumedConclusion.action).toBe('FINISH');
    expect(finalState.state).toBe('FINISHED');
    expect(finalState.savedAt).toBe(resumed.run.finishedAt);
    expect(finalState.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
    expect(decideRunResumption(finalState)).toBe('NOT_RESUMABLE');
    // セッションの `finish` がロックを外した。
    expect(existsSync(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')))).toBe(false);
  });
});

// R7b（中断した Run の再開の設計書 4.10 の DEF-022）: 再開した実行で PREFLIGHT に失敗しても、その実行の出力（本物の `ArtifactWriter.writeRun`
// で書いた run.json、audit.json、ページの page.json）に、前の回までに終わったページが入り、残りの URL は、理由 `PREFLIGHT_FAILED`
// （`detail` は `null`）の SKIPPED になる。PREFLIGHT の失敗は、Chromium を起動できない launcher で起こす（本物の PREFLIGHT が `BROWSER_LAUNCH`
// で失敗する。対象のサイトにはアクセスしない）。違反がないので、保存の終わり方は `ABANDON` で、保存は変わらない（次の起動で、もう一度再開できる）。
describe('R7b: a resumed execution whose PREFLIGHT fails writes the pages finished before the interruption into its output (resumable run design 4.10 DEF-022)', () => {
  /** 中断する前に保存を終えるページの数（k）。k+1 ページ目のページの保存の前に中断する。 */
  const PAGES_BEFORE_INTERRUPTION = 2;
  const PREFLIGHT_FAILED_SKIP = Object.freeze({ code: 'PREFLIGHT_FAILED', detail: null });

  let interrupted: AuditRunResult;
  let runDirectory: string;
  let saved: { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };
  let resumed: AuditRunResult;
  let conclusion: RunCoordinatorCheckpointConclusion;
  let writtenRun: RunSummary;
  let writtenAudit: Awaited<ReturnType<typeof readRunAudit>>;
  let writtenPages: PageAuditResult[];
  let savedAfterResume: { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };
  let pathsObservedByResumedRun: string[];
  let launchAttempts = 0;

  beforeAll(async () => {
    const config = fastRunConfig(server.origin, START_PATH);
    // k+1 ページ目のページの保存の前に中断する Run（ロックは、端末を再起動する前の OS で取る。再開のセッションが作り直す）。
    const output = join(workDirectory, 'preflight-failed');
    const interruptedSession = newSession(
      wrappedStore(new ArtifactWriter(), [], { interruptBeforePage: PAGES_BEFORE_INTERRUPTION + 1 }),
      lockHostBeforeOsRestart,
    );
    interrupted = await runCoordinator({ config, outputDirectory: output, session: interruptedSession });
    // プロセスが終わったことを模す（ハートビートを止める。ロックのファイルは残る）。
    await interruptedSession.abandon();
    runDirectory = runArtifactDirectory(output, interrupted.run.runId);
    saved = await readSavedCheckpoint(runDirectory);
    expect(decideRunResumption(saved.state)).toBe('RESUME');

    // 再開した実行。Chromium を起動できない（PREFLIGHT が BROWSER_LAUNCH で失敗する）。
    const failingLauncher: BrowserLauncher = async () => {
      launchAttempts += 1;
      throw new Error('the browser cannot be launched in this test');
    };
    const resumedSession = newSession(new ArtifactWriter());
    const coordinator = new RunCoordinator({
      config,
      launchBrowser: failingLauncher,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: join(workDirectory, 'preflight-failed-resumed-output-root'),
      checkpointSession: resumedSession,
      resumeFrom: { runDirectory, checkpoint: saved.state, pages: saved.pages },
    });
    server.resetCounters();
    server.resetRequestObservations();
    resumed = await coordinator.run();
    pathsObservedByResumedRun = observedPaths();
    // CLI と同じく、出力を書いた後に、保存の終わり方に従う（設計書 4.7.1）。出力は、前の回と同じ Run のディレクトリに書く。
    await new ArtifactWriter().writeRun(resumed, { outputDirectory: output });
    conclusion = coordinator.checkpointConclusion();
    if (conclusion.action === 'ABANDON') {
      await resumedSession.abandon();
    }
    writtenRun = await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
    writtenAudit = await readRunAudit(runDirectory);
    writtenPages = [];
    for (const { pageId } of writtenAudit.pages) {
      writtenPages.push(await readJson(artifactFilePath(runDirectory, pageArtifactRelativePath(pageId, 'page'))) as PageAuditResult);
    }
    savedAfterResume = await readSavedCheckpoint(runDirectory);
  }, SUITE_TIMEOUT_MS);

  it('writes the pages finished before the interruption into run.json, audit.json and their page.json, the rest as SKIPPED with PREFLIGHT_FAILED, and leaves the checkpoint as it was', async () => {
    // PREFLIGHT は、Chromium を起動できずに失敗する（対象のサイトには、何も要求しない）。Run Status は FAILED、Run の理由の PREFLIGHT_FAILED は1件。
    expect(launchAttempts).toBe(1);
    expect(pathsObservedByResumedRun).toEqual([]);
    expect(resumed.run.runStatus).toBe('FAILED');
    expect(resumed.run.incompleteReasons).toEqual([{ code: 'PREFLIGHT_FAILED', detail: 'BROWSER_LAUNCH' }]);
    expect(writtenRun.runStatus).toBe('FAILED');
    expect(writtenRun.incompleteReasons).toEqual(resumed.run.incompleteReasons);

    const finishedPageIds = saved.state.completedPageIds;
    expect(finishedPageIds).toHaveLength(PAGES_BEFORE_INTERRUPTION);
    // 終わったページの結果は、前の回の Run の結果（開始のページの robots.txt と sitemap.xml の Evidence を含む）と同じ。
    const finishedPages = interrupted.pages.slice(0, PAGES_BEFORE_INTERRUPTION);
    expect(finishedPages.map(({ pageId }) => pageId)).toEqual(finishedPageIds);
    const asWritten = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
    expect(writtenAudit.pages.slice(0, PAGES_BEFORE_INTERRUPTION)).toEqual(asWritten(finishedPages));
    expect(writtenPages.slice(0, PAGES_BEFORE_INTERRUPTION)).toEqual(asWritten(finishedPages));
    expect(writtenAudit.findings).toEqual(asWritten(finishedPages.flatMap(({ findings }) => findings)));
    // 残りの URL は、保存の巡回の記録の、終わっていない URL（同じページの ID）。理由 PREFLIGHT_FAILED の SKIPPED。
    const rest = saved.state.frontier.entries.filter(({ pageId }) => !finishedPageIds.includes(pageId));
    expect(rest.length).toBeGreaterThan(0);
    expect(writtenAudit.pages.map(({ pageId }) => pageId)).toEqual(saved.state.frontier.entries.map(({ pageId }) => pageId));
    expect(writtenAudit.pages.slice(PAGES_BEFORE_INTERRUPTION).map(({ pageUrl, status, incompleteReasons }) => [pageUrl, status, incompleteReasons]))
      .toEqual(rest.map(({ url }) => [url, 'SKIPPED', [PREFLIGHT_FAILED_SKIP]]));
    expect(writtenPages.slice(PAGES_BEFORE_INTERRUPTION).map(({ status }) => status)).toEqual(rest.map(() => 'SKIPPED'));
    expect(writtenRun).toMatchObject({
      runId: saved.state.runId,
      startedAt: saved.state.startedAt,
      discoveredPageCount: saved.state.frontier.entries.length,
      skippedPageCount: rest.length,
    });
    await expectSchemaValid(resumed);

    // 違反はないので、保存の終わり方は ABANDON で、保存は変わらない（次の起動で、もう一度再開できる）。
    expect(conclusion).toEqual({ action: 'ABANDON' });
    expect(savedAfterResume.state).toEqual(saved.state);
    expect(decideRunResumption(savedAfterResume.state)).toBe('RESUME');
  });
});
