// T24a（Task 24 の設計書 4.1、7 章）: 監査の中核（`executeAuditRun`）を、本物の Run Coordinator と headless Chromium で、127.0.0.1 の
// fixture のサイトに対して動かす。
// - 観測の口が呼ばれる順: `onRunStarting` → `onRunStarted`（保存のセッションが始まった直後。ロックがある）→ `onProgress`（ページごと）。
// - `onRunStarted` の Run の ID と Run のディレクトリが、結果と書き出した run.json の値と同じ。
// - 止める印で止めた Run（PARTIAL）を、もう一度の実行で再開する（再開の判断 `RESUME`、同じ Run の ID）。
// - 観測の口がすべて例外を投げても、監査は最後まで行い、口がない場合と同じ結果になる。
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath, checkpointArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { createRunLauncher, fastRunConfig, readJson } from '../helpers/run-harness.js';

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

/** 観測の口の呼ばれ方の記録。`onRunStarted` のときに、Run のディレクトリとロックがあったかも記録する。 */
interface ObservedRun {
  readonly hooks: string[];
  readonly started: AuditRunStarted[];
  readonly lockExistedWhenStarted: boolean[];
  readonly pagesFinished: number[];
}

function observingObserver(): { readonly observer: AuditRunObserver; readonly observed: ObservedRun } {
  const observed: ObservedRun = { hooks: [], started: [], lockExistedWhenStarted: [], pagesFinished: [] };
  return {
    observed,
    observer: {
      onRunStarting: () => observed.hooks.push('onRunStarting'),
      onRunStarted: (started) => {
        observed.hooks.push('onRunStarted');
        observed.started.push(started);
        observed.lockExistedWhenStarted.push(existsSync(artifactFilePath(started.runDirectory, checkpointArtifactRelativePath('lock'))));
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
    expect(observed.lockExistedWhenStarted).toEqual([true]);
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
    expect(second.observed.lockExistedWhenStarted).toEqual([true]);
    expect((await readRun(resumed.runDirectory)).executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
  }, SUITE_TIMEOUT_MS);

  it('finishes the audit with the same result when every hook of the observer throws', async () => {
    const throwing: AuditRunObserver = {
      onRunStarting: () => {
        throw new Error('the observer failed');
      },
      onRunStarted: () => {
        throw new Error('the observer failed');
      },
      onProgress: () => {
        throw new Error('the observer failed');
      },
      onNotice: () => {
        throw new Error('the observer failed');
      },
    };

    const withThrowing = ranOutcome(await executeAuditRun(configFor('throwing'), realDependencies(), { startNew: false }, throwing));
    const without = ranOutcome(await executeAuditRun(configFor('without'), realDependencies(), { startNew: false }));

    expect(withThrowing.runStatus).toBe(without.runStatus);
    expect(withThrowing.exitCode).toBe(without.exitCode);
    expect(withThrowing.summary.coverage).toEqual(without.summary.coverage);
    expect(withThrowing.summary.findingCounts).toEqual(without.summary.findingCounts);
  }, SUITE_TIMEOUT_MS);
});
