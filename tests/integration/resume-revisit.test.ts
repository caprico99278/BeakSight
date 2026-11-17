// EV-5（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 2 章のユーザーの判断・3.5）: 時間切れで止まった Run を続けるときは、一部だけ終わった
// 画面を、まだ見ていない画面より先に読み直す。本物の headless Chromium（既定）で、fixture のサイト（`/crawl/`。入口 → level-1 → missing → level-2 → level-3）を
// 監査する。時間切れは偽の時計で作る: 2 ページ目（level-1）の文書をサーバが受けた後、時計を Run の時間の上限の分だけ進める（Desktop の途中で上限を過ぎ、Mobile は
// 見ず、残りのページは時間切れの SKIPPED）。再開は同じ進んだ時計で続ける（本番の値は変えない）。
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { runArtifactDirectory } from '../../src/core/artifact-layout.js';
import { FINDING_SCHEMA_VERSIONS, type AuditRunResult, type Finding, type PageAuditResult } from '../../src/core/contracts.js';
import { createFindingId } from '../../src/core/ids.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  decideRunResumption,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointStore,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunCoordinator, type RunCoordinatorResumeInput } from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { auditRunArrayOf } from '../helpers/audit-run-fixture.js';
import { createRunLauncher, expectSchemaValid, fastRunConfig } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
const CUT_PATH = '/crawl/level-1.html';
const UNVISITED_PATHS = Object.freeze(['/crawl/missing.html', '/crawl/level-2.html', '/crawl/level-3.html']);
/** Run の時間の上限（設定の値。偽の時計は、この分だけ進める）。 */
const RUN_TIME_LIMIT_MS = 60 * 60 * 1000;

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();
const sessions: RunCheckpointSession[] = [];

/** 偽の時計（本物の時刻に、進めた分を足す）。構えたパスの文書をサーバが受けたら、Run の時間の上限の分だけ進める（戻さない）。 */
let clockOffsetMs = 0;
let armedPath: string | null = null;
const now = (): number => {
  if (armedPath !== null && server.getRequestObservations().some(({ pathname }) => pathname === armedPath)) {
    clockOffsetMs += RUN_TIME_LIMIT_MS;
    armedPath = null;
  }
  return Date.now() + clockOffsetMs;
};

/** Run を行い、保存の終わり方が `FINISH` なら、CLI と同じく最後の状態の保存を書く。 */
async function runCoordinator(
  config: ReturnType<typeof fastRunConfig>,
  outputDirectory: string,
  resumeFrom?: RunCoordinatorResumeInput,
  store: RunCheckpointStore = new ArtifactWriter(),
  stopSignal?: AbortSignal,
): Promise<AuditRunResult> {
  const session = new RunCheckpointSession({ store });
  sessions.push(session);
  const coordinator = new RunCoordinator({
    config,
    launchBrowser: runLauncher.launcher,
    createSafetyLedger: () => new SafetyLedger(),
    clock: () => new Date(),
    now,
    outputDirectory,
    checkpointSession: session,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
    ...(stopSignal === undefined ? {} : { stopSignal }),
  });
  const result = await auditRunArrayOf(await coordinator.run());
  const conclusion = coordinator.checkpointConclusion();
  if (conclusion.action === 'FINISH') {
    await session.finish(conclusion.checkpoint);
  }
  return result;
}

const htmlPathsOf = (paths: readonly string[]): string[] => paths.filter((path) => path.startsWith('/crawl/') && path.endsWith('.html'));

/** 画像を撮り、時間の上限を指定した設定。 */
const timeLimitedConfig = () => fastRunConfig(server.origin, START_PATH, { crawl: { maxRuntimeMs: RUN_TIME_LIMIT_MS }, audit: { screenshots: true } });

type SavedCheckpoint = { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };

/** 保存を、整合の確かめを渡して読む。 */
async function readSaved(runDirectory: string): Promise<SavedCheckpoint> {
  const read = await new ArtifactWriter().readCheckpoint(runDirectory, {
    checkState: checkRunCheckpointConsistency,
    checkPage: checkRunCheckpointPageConsistency,
  });
  if (!read.ok) {
    throw new Error(`the checkpoint could not be read: ${JSON.stringify(read.failures)}`);
  }
  return { state: read.state, pages: read.pages };
}

/** 時間切れで止まる Run を行い（`cutPath` の文書を受けたら時計を進める）、その保存を読む。 */
async function stopByTimeLimit(output: string, cutPath: string = CUT_PATH): Promise<{
  readonly first: AuditRunResult;
  readonly runDirectory: string;
  readonly saved: SavedCheckpoint;
}> {
  server.resetRequestObservations();
  armedPath = cutPath;
  const first = await runCoordinator(timeLimitedConfig(), output);
  const runDirectory = runArtifactDirectory(output, first.run.runId);
  return { first, runDirectory, saved: await readSaved(runDirectory) };
}

/**
 * そのページの保存の結果に、確かめを待つ指摘（`NOT_OPERATED`。状態の記録のない layout を参照する覆いの指摘）を 1 件足した写し（REV-EV5 の実験 r1 と同じ形）。
 * 全部終わったページを、確かめを待つ指摘で読み直す候補にするため。
 */
function withHeldFinding(page: RunCheckpointPage): RunCheckpointPage {
  const result = structuredClone(page.result);
  const record = result.evidence.find((candidate) => candidate.viewport === 'desktop' && candidate.type === 'layout');
  if (record === undefined) {
    throw new Error('the page has no desktop layout');
  }
  const { capture: _capture, ...withoutCapture } = record;
  const evidence = result.evidence.map((candidate) => (candidate === record ? withoutCapture : candidate));
  const held: Finding = {
    schemaVersion: FINDING_SCHEMA_VERSIONS[FINDING_SCHEMA_VERSIONS.length - 1] ?? 'finding-schema/1.1', findingId: createFindingId(999_999), fingerprint: 'ev5-held',
    ruleId: 'FIXED_ELEMENT_OCCLUSION', ruleVersion: 1, category: 'LAYOUT', severity: 'WARN', pageId: result.pageId, pageUrl: result.pageUrl,
    viewport: 'desktop', message: 'held', evidenceRefs: [record.evidenceId], groupingKeys: [],
  };
  return { ...page, result: { ...result, evidence, findings: [...result.findings, held] } };
}

const pathnameOf = (url: string): string => new URL(url).pathname;

/** ページの画像の、Run のディレクトリからの相対パス。 */
const screenshotPathsOf = (page: PageAuditResult | undefined): string[] =>
  (page?.evidence ?? []).flatMap((record) => (record.type === 'screenshot' ? [record.payload.relativePath] : []));

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resume-revisit-'));
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

describe('EV-5: resuming a run stopped by the time limit reads the partly finished page before the pages not yet seen', () => {
  let first: AuditRunResult;
  let saved: { readonly state: RunCheckpoint; readonly pages: readonly RunCheckpointPage[] };
  let resumed: AuditRunResult;
  let resumedPaths: string[];

  beforeAll(async () => {
    const output = join(workDirectory, 'out');
    const stopped = await stopByTimeLimit(output);
    first = stopped.first;
    saved = stopped.saved;
    server.resetRequestObservations();
    resumed = await runCoordinator(timeLimitedConfig(), output, { runDirectory: stopped.runDirectory, checkpoint: saved.state, pages: saved.pages });
    resumedPaths = htmlPathsOf(server.getRequestObservations().map(({ pathname }) => pathname));
  }, SUITE_TIMEOUT_MS);

  it('stops the first run by the time limit with the second page partly finished', () => {
    expect(decideRunResumption(saved.state)).toBe('RESUME');
    expect(saved.state.executions.at(-1)?.endReason).toBe('STOPPED_BY_RUNTIME_LIMIT');
    const cut = first.pages.find(({ pageUrl }) => new URL(pageUrl).pathname === CUT_PATH);
    expect(cut?.viewports.mobile.status).toBe('SKIPPED');
  });

  it('reads the partly finished page first, then the pages not yet seen, and finishes the page', async () => {
    expect(resumedPaths[0]).toBe(CUT_PATH);
    for (const path of UNVISITED_PATHS) {
      expect(resumedPaths.indexOf(path), path).toBeGreaterThan(resumedPaths.indexOf(CUT_PATH));
    }
    const pages = resumed.pages.filter(({ pageUrl }) => new URL(pageUrl).pathname === CUT_PATH);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.viewports.mobile.status).not.toBe('SKIPPED');
    expect(resumed.run.executions.at(-1)?.endReason).toBe('COMPLETED');
    await expectSchemaValid(resumed);
  });
});

// 設計者の判断（2026-11-16）: 読み直しの画像は、前の結果の画像と別の場所に書く。読み直しを捨てた（ここでは、読み直したページの保存の前にプロセスが終わった）
// ときも、保存に残る前の結果の画像は、そのまま残る。
describe('EV-5: a page read again writes its images apart, and the images of the earlier result stay when the reading is dropped', () => {
  let earlierPaths: string[];
  let earlierTimes: (number | null)[];
  let afterTimes: (number | null)[];
  let revisitedPaths: string[];

  const modifiedTimesOf = async (runDirectory: string, paths: readonly string[]): Promise<(number | null)[]> =>
    Promise.all(paths.map(async (path) => (await stat(join(runDirectory, path)).catch(() => null))?.mtimeMs ?? null));

  beforeAll(async () => {
    const { runDirectory, saved } = await stopByTimeLimit(join(workDirectory, 'dropped'));
    earlierPaths = screenshotPathsOf(saved.pages.find(({ url }) => pathnameOf(url) === CUT_PATH)?.result);
    earlierTimes = await modifiedTimesOf(runDirectory, earlierPaths);
    // 読み直したページの保存を書く前に、プロセスが終わったことを模す（保存は前の結果のまま）。
    const writer = new ArtifactWriter();
    const endingStore: RunCheckpointStore = {
      writeCheckpointPage: async () => {
        throw new Error('simulated end of the process before the page checkpoint');
      },
      writeCheckpointState: async (directory, state) => writer.writeCheckpointState(directory, state),
      cleanUpForResume: async (directory, completedPageIds) => writer.cleanUpForResume(directory, completedPageIds),
    };
    const dropped = await runCoordinator(timeLimitedConfig(), join(workDirectory, 'dropped'), {
      runDirectory, checkpoint: saved.state, pages: saved.pages,
    }, endingStore);
    revisitedPaths = screenshotPathsOf(dropped.pages.find(({ pageUrl }) => pathnameOf(pageUrl) === CUT_PATH));
    afterTimes = await modifiedTimesOf(runDirectory, earlierPaths);
  }, SUITE_TIMEOUT_MS);

  it('writes the images of the page read again apart from the images of the earlier result, and leaves the earlier images as they were', () => {
    expect(earlierPaths.length).toBeGreaterThan(0);
    expect(revisitedPaths.length).toBeGreaterThan(0);
    expect(revisitedPaths.filter((path) => earlierPaths.includes(path))).toEqual([]);
    expect(earlierTimes.every((time) => time !== null)).toBe(true);
    expect(afterTimes).toEqual(earlierTimes);
  });
});

// REV-EV5 の I-1（実験 r1 の S2）: 全部終わっていたページの読み直しが時間切れで途中になったら、読み直しを捨て、前の結果を残す（読み直しを終えたページにも入れない）。
describe('EV-5: a page read again and cut by the time limit keeps the earlier full result', () => {
  let resumed: AuditRunResult;
  let savedAfter: SavedCheckpoint;
  let heldPageId: string;

  beforeAll(async () => {
    const output = join(workDirectory, 'cut-again');
    // 3 ページ目で時間切れにし、全部終わった 2 ページ目（level-1）に確かめを待つ指摘を足して、読み直しの候補にする。
    const { runDirectory, saved } = await stopByTimeLimit(output, '/crawl/missing.html');
    const pages = saved.pages.map((page) => (pathnameOf(page.url) === CUT_PATH ? withHeldFinding(page) : page));
    heldPageId = pages.find(({ url }) => pathnameOf(url) === CUT_PATH)?.pageId ?? '';
    // 再開では、level-1 の読み直しの文書を受けたら、また時間切れにする。
    server.resetRequestObservations();
    armedPath = CUT_PATH;
    resumed = await runCoordinator(timeLimitedConfig(), output, { runDirectory, checkpoint: saved.state, pages });
    savedAfter = await readSaved(runDirectory);
  }, SUITE_TIMEOUT_MS);

  it('keeps the earlier result with both viewports, and does not mark the page as read again', () => {
    const page = resumed.pages.find(({ pageUrl }) => pathnameOf(pageUrl) === CUT_PATH);
    expect(page?.viewports.mobile.status).not.toBe('SKIPPED');
    expect(savedAfter.pages.find(({ pageId }) => pageId === heldPageId)?.result.viewports.mobile.status).not.toBe('SKIPPED');
    expect(savedAfter.state.revisitedPageIds ?? []).not.toContain(heldPageId);
  });
});

// REV-EV5 の I-2（実験 r1 の S3）: 時間切れの後の再開が別の理由（止める印）で止まっても、次の再開で読み直す。
describe('EV-5: the reading again continues after a resumed run stopped by another reason', () => {
  let thirdPaths: string[];

  beforeAll(async () => {
    const output = join(workDirectory, 'stopped-between');
    const { runDirectory, saved } = await stopByTimeLimit(output);
    // 2 回目は、始めから止める印を立てて、何も読まずに止める（実行の終わり方は止める印）。
    const stop = new AbortController();
    stop.abort();
    await runCoordinator(timeLimitedConfig(), output, { runDirectory, checkpoint: saved.state, pages: saved.pages }, new ArtifactWriter(), stop.signal);
    const second = await readSaved(runDirectory);
    expect(second.state.executions.at(-1)?.endReason).toBe('STOPPED_BY_SIGNAL');
    server.resetRequestObservations();
    await runCoordinator(timeLimitedConfig(), output, { runDirectory, checkpoint: second.state, pages: second.pages });
    thirdPaths = htmlPathsOf(server.getRequestObservations().map(({ pathname }) => pathname));
  }, SUITE_TIMEOUT_MS);

  it('reads the partly finished page first in the next resume', () => {
    expect(thirdPaths[0]).toBe(CUT_PATH);
  });
});
