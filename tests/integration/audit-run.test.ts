// T24a（Task 24 の設計書 4.1、7 章）: 監査の中核（`executeAuditRun`）を、本物の Run Coordinator と headless Chromium で、127.0.0.1 の
// fixture のサイトに対して動かす。
// - 観測の口が呼ばれる順: `onRunStarting` → `onRunStarted`（保存のセッションが始まった直後。ロックがある）→ `onProgress`（ページごと）。
// - `onRunStarted` の Run の ID と Run のディレクトリが、結果と書き出した run.json の値と同じ。
// - 止める印で止めた Run（PARTIAL）を、もう一度の実行で再開する（再開の判断 `RESUME`、同じ Run の ID）。
// - SU3c（サイトが応答しないときに Run を止める設計書 3.1、3.2、5 章。SLIM-GROUP で前の `cli-site-unavailable.test.ts` の主の場面を移した）: k ページの後に
//   サイトが応答しなくなると、k+1 ページ目の文書の GET（最初の試行と各確かめ直し）のほかはサイトに届かずに止まり、サイトが戻った後の同じ設定の実行で
//   再開して終える。確かめ直しの知らせの文言・robots.txt の不調・戻る前の再開は、単体（`tests/unit/run-coordinator.test.ts` の SU の場面、
//   `site-metadata-unresponsive.test.ts`）と `page-auditor-site-unavailability.test.ts`・`job-site-unavailability.test.ts`。
import { mkdtemp, rm } from 'node:fs/promises';
import { Agent, request as httpRequest, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import {
  executeAuditRun,
  type AuditRunDependencies,
  type AuditRunObserver,
  type AuditRunOutcome,
  type AuditRunStarted,
} from '../../src/cli/audit-run.js';
import { EXIT_CODES, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import type { AuditConfig } from '../../src/config/types.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import { acquireRunExclusion } from '../../src/core/run-exclusion.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { RunCoordinator, SITE_UNAVAILABLE_RECHECK_DELAYS_MS } from '../../src/orchestration/run-coordinator.js';
import { SITE_UNAVAILABLE_SKIP_REASON } from '../../src/orchestration/site-availability.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createRunLauncher, fastRunConfig, readJson, TEST_RUN_PROGRESS_QUIET_LIMIT_MS } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 止める印を付ける前に監査を終えるページの数。 */
const PAGES_BEFORE_STOP = 2;

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-run-integration-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

/** 作業のディレクトリの下の、`name` の出力先に書く、実行時間を抑えた Run の設定（`/crawl/` の5ページ）。 */
const configFor = (name: string): AuditConfig =>
  fastRunConfig(server.origin, START_PATH, { target: { id: 'audit-run' }, output: { directory: join(workDirectory, name) } });

/** 本物の headless Chromium で Run を行う依存。`stopAfterPages` を渡すと、そのページ数を終えたときに止める印を付ける。 */
function realDependencies(stopAfterPages?: number): AuditRunDependencies {
  const base: AuditRunDependencies = { launchBrowser: runLauncher.launcher, clock: () => new Date(), now: () => Date.now() };
  if (stopAfterPages === undefined) {
    return base;
  }
  const controller = new AbortController();
  return {
    ...base,
    stopSignal: controller.signal,
    createRunCoordinator: (dependencies) => new RunCoordinator({
      ...dependencies,
      onProgress: (report) => {
        dependencies.onProgress?.(report);
        if (report.pagesFinished === stopAfterPages) {
          controller.abort();
        }
      },
    }),
  };
}

/** 観測の口の呼ばれ方の記録。`onRunStarted` のときに、出力先の監査中の印が持たれていたか（確かめの途中の値）も記録する。 */
interface ObservedRun {
  readonly hooks: string[];
  readonly started: AuditRunStarted[];
  readonly lockHeldWhenStarted: Promise<boolean>[];
  readonly pagesFinished: number[];
}

/** 出力先の監査中の印が、ほかの起動に持たれているか（取れたら、すぐ離す）。 */
async function isExclusionHeld(outputDirectory: string): Promise<boolean> {
  const exclusion = await acquireRunExclusion(outputDirectory);
  if (exclusion.kind === 'ACQUIRED') {
    await exclusion.release();
  }
  return exclusion.kind === 'HELD';
}

function observingObserver(): { readonly observer: AuditRunObserver; readonly observed: ObservedRun } {
  const observed: ObservedRun = { hooks: [], started: [], lockHeldWhenStarted: [], pagesFinished: [] };
  return {
    observed,
    observer: {
      onRunStarting: () => observed.hooks.push('onRunStarting'),
      onRunStarted: (started) => {
        observed.hooks.push('onRunStarted');
        observed.started.push(started);
        // SPEC-2: 監査中の印は、出力先（Run のディレクトリの親）の排他。
        observed.lockHeldWhenStarted.push(isExclusionHeld(dirname(started.runDirectory)));
      },
      onProgress: (report) => {
        observed.hooks.push('onProgress');
        observed.pagesFinished.push(report.pagesFinished);
      },
      onNotice: () => observed.hooks.push('onNotice'),
    },
  };
}

const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;

/** 結果の `RAN` を取り出す（ほかの種類なら、テストを失敗にする）。 */
function ranOutcome(outcome: AuditRunOutcome): Extract<AuditRunOutcome, { readonly kind: 'RAN' }> {
  expect(outcome.kind).toBe('RAN');
  if (outcome.kind !== 'RAN') {
    throw new Error(`expected RAN, got ${outcome.kind}`);
  }
  return outcome;
}

describe('T24a: executeAuditRun with the real Run Coordinator and headless Chromium', () => {
  it('calls onRunStarting, then onRunStarted with the run ID and the locked run directory, then onProgress for each page', async () => {
    const { observer, observed } = observingObserver();

    const outcome = ranOutcome(await executeAuditRun(configFor('new-run'), realDependencies(), { startNew: false }, observer));

    expect(observed.hooks.slice(0, 2)).toEqual(['onRunStarting', 'onRunStarted']);
    expect(observed.hooks.slice(2).every((hook) => hook === 'onProgress')).toBe(true);
    expect(observed.started).toEqual([{ runId: outcome.runId, runDirectory: outcome.runDirectory, resumeDecision: { kind: 'NEW_RUN' } }]);
    expect(await Promise.all(observed.lockHeldWhenStarted)).toEqual([true]);
    const run = await readRun(outcome.runDirectory);
    expect(run.runId).toBe(outcome.runId);
    expect(outcome.runStatus).toBe(run.runStatus);
    expect(outcome.exitCode).toBe(exitCodeForRunStatus(run.runStatus));
    expect(observed.pagesFinished).toEqual(Array.from({ length: outcome.summary.coverage.audited }, (_, index) => index + 1));
  }, SUITE_TIMEOUT_MS);

  it('stops the Run with the stop signal (PARTIAL), and resumes the same Run with the RESUME decision', async () => {
    const config = configFor('stop-and-resume');
    const first = observingObserver();
    const stopped = ranOutcome(await executeAuditRun(config, realDependencies(PAGES_BEFORE_STOP), { startNew: false }, first.observer));

    expect(stopped.runStatus).toBe('PARTIAL');
    expect(stopped.exitCode).toBe(EXIT_CODES.PARTIAL);
    expect(first.observed.pagesFinished).toEqual([1, PAGES_BEFORE_STOP]);

    const second = observingObserver();
    const resumed = ranOutcome(await executeAuditRun(config, realDependencies(), { startNew: false }, second.observer));

    const resumeDecision = { kind: 'RESUME', runId: stopped.runId, runDirectory: stopped.runDirectory, completedPages: PAGES_BEFORE_STOP };
    expect(resumed).toMatchObject({ runId: stopped.runId, runDirectory: stopped.runDirectory, resumeDecision, notices: [] });
    expect(second.observed.started).toEqual([{ runId: stopped.runId, runDirectory: stopped.runDirectory, resumeDecision }]);
    expect(await Promise.all(second.observed.lockHeldWhenStarted)).toEqual([true]);
    expect((await readRun(resumed.runDirectory)).executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
  }, SUITE_TIMEOUT_MS);
  // 観測の口がすべて例外を投げても監査を続けることは、偽の Run Coordinator の `tests/unit/audit-run.test.ts`（SLIM-GROUP で結合の 2 回の Run を外した）。
});

/** 応答のない時間切れを早く起こす、読み込みの期限（ms。中継の後の fixture の小さな HTML は、この中で読み込める）。 */
const UNRESPONSIVE_NAVIGATION_TIMEOUT_MS = 2_000;

/** fixture のサーバの前に置く 127.0.0.1 の中継（`NORMAL` は中継し、`HANG` は接続を受けて何も返さない）。受けた要求を、受けた時のモードつきで記録する。 */
async function startRelay(upstream: FixtureServer) {
  const upstreamUrl = new URL(upstream.origin);
  const agent = new Agent({ keepAlive: false });
  const requests: { readonly method: string; readonly pathname: string; readonly mode: 'NORMAL' | 'HANG' }[] = [];
  const hung = new Set<ServerResponse>();
  let mode: 'NORMAL' | 'HANG' = 'NORMAL';
  const cutHung = (): void => {
    for (const response of hung) {
      response.socket?.destroy();
      response.destroy();
    }
    hung.clear();
  };
  const server = await startLoopbackHttpServer((request, response) => {
    requests.push({ method: request.method ?? '', pathname: (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/', mode });
    if (mode === 'HANG') {
      hung.add(response);
      response.once('close', () => hung.delete(response));
      return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['connection', 'keep-alive'].includes(name)));
    const upstreamRequest = httpRequest({ hostname: upstreamUrl.hostname, port: upstreamUrl.port, method: request.method, path: request.url, headers, agent }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, Object.fromEntries(Object.entries(upstreamResponse.headers)
        .filter(([name]) => !['connection', 'keep-alive', 'transfer-encoding'].includes(name))));
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once('error', () => response.destroy());
    response.once('close', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
  return {
    origin: server.origin,
    requests,
    setMode: (next: 'NORMAL' | 'HANG') => {
      cutHung();
      mode = next;
    },
    close: async () => {
      cutHung();
      agent.destroy();
      await server.close();
    },
  };
}

describe('SU3c: the site stops responding after the k-th page (design 3.1, 3.2, 5)', () => {
  it('stops after the k-th page with only the document GETs of the k+1-th page, and the same config resumes and finishes after the site is back', async () => {
    const relay = await startRelay(server);
    try {
      const config = fastRunConfig(relay.origin, START_PATH, {
        target: { id: 'audit-run-site-unavailable' },
        output: { directory: join(workDirectory, 'site-unavailable') },
        // k+1 ページ目の後に、もう 1 ページだけ残す（切り替えた後に次のページを読み込まないことを確かめるため）。
        crawl: { navigationTimeoutMs: UNRESPONSIVE_NAVIGATION_TIMEOUT_MS, maxPages: PAGES_BEFORE_STOP + 2 },
      });
      const sleeps: number[] = [];
      // 確かめ直しの前の待ち（60 秒〜8 分）は差し替える（実際には待たずに、待った長さを記録する）。k ページの後に中継を `HANG` にする。
      const dependencies = (switchAfterPages: number | null): AuditRunDependencies => ({
        launchBrowser: runLauncher.launcher,
        clock: () => new Date(),
        now: () => Date.now(),
        createRunCoordinator: (coordinatorDependencies) => new RunCoordinator({
          ...coordinatorDependencies,
          progressWatchQuietLimitMs: TEST_RUN_PROGRESS_QUIET_LIMIT_MS,
          onProgress: (report) => {
            coordinatorDependencies.onProgress?.(report);
            if (report.pagesFinished === switchAfterPages) {
              relay.setMode('HANG');
            }
          },
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }),
      });

      const stopped = ranOutcome(await executeAuditRun(config, dependencies(PAGES_BEFORE_STOP), { startNew: false }));
      const stoppedRun = await readRun(stopped.runDirectory);
      expect(stopped.runStatus).toBe('PARTIAL');
      expect(stoppedRun.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SITE_UNAVAILABLE']);
      expect(stoppedRun.incompleteReasons).toContainEqual({ code: SITE_UNAVAILABLE_SKIP_REASON.code, detail: 'desktop:passive:TIMEOUT' });
      expect(stoppedRun.safety.invariantViolationCount).toBe(0);
      expect(sleeps).toEqual([...SITE_UNAVAILABLE_RECHECK_DELAYS_MS]);
      // 切り替えた後にサイトに届いたのは、k+1 ページ目の文書の GET だけ（最初の試行と各確かめ直しの 1 回ずつ。Mobile・次のページの読み込みはない）。
      const afterSwitch = relay.requests.filter(({ mode, method, pathname }) => mode === 'HANG' && !(method === 'GET' && pathname === BROWSER_DEFAULT_FAVICON_PATH));
      expect(afterSwitch.length).toBe(SITE_UNAVAILABLE_RECHECK_DELAYS_MS.length + 1);
      expect(new Set(afterSwitch.map(({ method, pathname }) => `${method} ${pathname}`)).size).toBe(1);
      expect(afterSwitch[0]?.method).toBe('GET');

      relay.setMode('NORMAL');
      sleeps.splice(0);
      const resumed = ranOutcome(await executeAuditRun(config, dependencies(null), { startNew: false }));
      expect(resumed).toMatchObject({ runId: stopped.runId, resumeDecision: { kind: 'RESUME', completedPages: PAGES_BEFORE_STOP } });
      const finished = await readRun(resumed.runDirectory);
      expect(finished.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SITE_UNAVAILABLE', 'COMPLETED']);
      expect(finished.incompleteReasons.filter(({ code }) => code === SITE_UNAVAILABLE_SKIP_REASON.code)).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(relay.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    } finally {
      await relay.close();
    }
  }, SUITE_TIMEOUT_MS);
});
