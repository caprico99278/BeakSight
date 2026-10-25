// DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 「Run の終わり」の段（集計・成果物の書き出し・止めたときの
// 片付け）に入る前に、流れが観測の口（`onFinalizing`）で知らせることを、同じ process の中で確かめる結合テスト。ワーカーは、この知らせを親へ
// `RUN_FINALIZING` で送り、親は、その段の間だけ途絶えの上限を延ばす（親とワーカーの確かめは `control-audit-jobs.test.ts` と
// `worker-finalizing-heartbeat-fork.test.ts`）。
// - 監査（`executeAuditRun`。本物の headless Chromium と 127.0.0.1 の fixture のサーバ）: 最後のページの進み具合の後、`run.json` を書く前に 1 回だけ。
//   止める印で止めたとき（片付け）と、PREFLIGHT に失敗したとき（Browser がない）も、同じく 1 回。
// - 発見と READ の確かめのジョブの流れ: 成果物（`discovery.json`・`read-evidence.json`）を書く前に 1 回だけ（Browser を起動できない場合で確かめる）。
//   T44g（P4-5）: 入口の確かめのジョブの流れ（`entry-check.json`）も同じ。
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { executeAuditRun, type AuditRunObserver } from '../../src/cli/audit-run.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import {
  DISCOVERY_ARTIFACT_FILE_NAME,
  ENTRY_CHECK_ARTIFACT_FILE_NAME,
  READ_EVIDENCE_ARTIFACT_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeEntryCheckRun } from '../../src/worker/entry-check-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { createRunLauncher, fastRunConfig } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const SUITE_TIMEOUT_MS = 180_000;
const START_PATH = '/crawl/index.html';
/** 監査するページの数（fixture の `/crawl/` は 5 ページ）。 */
const MAX_PAGES = 2;
/** Browser を起動できないときの、許可 Origin（どこにも接続しない）。 */
const UNREACHABLE_ORIGIN = 'http://127.0.0.1:9';

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-run-finalizing-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

/** 観測の口の事象の並び（進み具合はページの数、段の知らせは、その時点で `run.json` があったか）。 */
type ObservedEvent = { readonly kind: 'progress'; readonly pagesFinished: number } | { readonly kind: 'finalizing'; readonly runJsonExists: boolean };

/** 監査を 1 回動かし、観測の口の事象の並びを返す。 */
async function auditEvents(name: string, options: { readonly stopAfterPages?: number; readonly launchFails?: boolean } = {}): Promise<{
  readonly events: readonly ObservedEvent[];
  readonly runDirectory: string;
}> {
  const outputDirectory = join(workDirectory, name);
  const config = fastRunConfig(server.origin, START_PATH, {
    target: { id: name },
    crawl: { maxPages: MAX_PAGES, minNavigationIntervalMs: 0 },
    output: { directory: outputDirectory },
  });
  const events: ObservedEvent[] = [];
  let runDirectory = '';
  const controller = new AbortController();
  const observer: AuditRunObserver = {
    onRunStarted: (started) => {
      runDirectory = started.runDirectory;
    },
    onProgress: (report) => {
      events.push({ kind: 'progress', pagesFinished: report.pagesFinished });
      if (options.stopAfterPages !== undefined && report.pagesFinished >= options.stopAfterPages) {
        controller.abort();
      }
    },
    onFinalizing: () => {
      events.push({ kind: 'finalizing', runJsonExists: runDirectory !== '' && existsSync(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) });
    },
  };
  const outcome = await executeAuditRun(config, {
    launchBrowser: options.launchFails === true ? () => Promise.reject(new Error('no browser in this test')) : runLauncher.launcher,
    clock: () => new Date(),
    now: () => Date.now(),
    stopSignal: controller.signal,
  }, { startNew: true }, observer);
  expect(outcome.kind).toBe('RAN');
  return { events, runDirectory };
}

describe('DEF-143: the audit tells the start of the finalizing stage before it writes the outputs', () => {
  it('tells it once, after the progress of the last page and before run.json is written', async () => {
    const { events, runDirectory } = await auditEvents('finished');
    expect(events).toEqual([
      { kind: 'progress', pagesFinished: 1 },
      { kind: 'progress', pagesFinished: 2 },
      { kind: 'finalizing', runJsonExists: false },
    ]);
    expect(existsSync(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))).toBe(true);
  }, SUITE_TIMEOUT_MS);

  it('tells it once when the Run is stopped by the stop mark (the cleaning up after the stop)', async () => {
    const { events } = await auditEvents('stopped', { stopAfterPages: 1 });
    expect(events).toEqual([{ kind: 'progress', pagesFinished: 1 }, { kind: 'finalizing', runJsonExists: false }]);
  }, SUITE_TIMEOUT_MS);

  it('tells it once when the PREFLIGHT fails without a browser', async () => {
    const { events } = await auditEvents('preflight-failed', { launchFails: true });
    expect(events).toEqual([{ kind: 'finalizing', runJsonExists: false }]);
  }, SUITE_TIMEOUT_MS);
});

/** どこにも接続しない、認証つきの Run の指定（Browser を起動できないので、状態は使われない）。 */
const unreachableAuthentication = (): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [UNREACHABLE_ORIGIN],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

describe('DEF-143: the discovery and READ check jobs tell the start of the finalizing stage before they write the artifact', () => {
  const jobRequest = (name: string) => ({
    config: createTestConfig(UNREACHABLE_ORIGIN, '/admin/', {
      audit: { screenshots: false },
      output: { directory: join(workDirectory, name) },
    }),
    authentication: unreachableAuthentication(),
    launchBrowser: () => Promise.reject(new Error('no browser in this test')),
    clock: () => new Date(),
    now: () => Date.now(),
    stopSignal: new AbortController().signal,
  });

  it('tells it once in the discovery flow, before discovery.json is written', async () => {
    const seen: boolean[] = [];
    let runDirectory = '';
    const outcome = await executeDiscoveryRun({ ...jobRequest('discovery'), jobId: 'job-discovery-finalizing' }, {
      onRunStarted: (started) => {
        runDirectory = started.runDirectory;
      },
      onSessionLost: () => undefined,
      onFinalizing: () => {
        seen.push(existsSync(artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME)));
      },
    });
    expect(outcome.kind).toBe('RAN');
    expect(seen).toEqual([false]);
    expect(existsSync(artifactFilePath(runDirectory, DISCOVERY_ARTIFACT_FILE_NAME))).toBe(true);
  }, SUITE_TIMEOUT_MS);

  it('tells it once in the READ check flow, before read-evidence.json is written', async () => {
    const seen: boolean[] = [];
    let runDirectory = '';
    const outcome = await executeReadCheckRun({ ...jobRequest('read-check'), jobId: 'job-read-check-finalizing', readChecks: [] }, {
      onRunStarted: (started) => {
        runDirectory = started.runDirectory;
      },
      onSessionLost: () => undefined,
      onFinalizing: () => {
        seen.push(existsSync(artifactFilePath(runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME)));
      },
    });
    expect(outcome.kind).toBe('RAN');
    expect(seen).toEqual([false]);
    expect(existsSync(artifactFilePath(runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME))).toBe(true);
  }, SUITE_TIMEOUT_MS);

  // T44g（Task 44 の設計書 P4-5。DEF-143 の残り）: 入口の確かめのジョブの流れも、成果物（`entry-check.json`）を書く前に 1 回だけ知らせる。
  it('tells it once in the entry check flow, before entry-check.json is written', async () => {
    const seen: boolean[] = [];
    let runDirectory = '';
    const { authentication: _unused, ...request } = jobRequest('entry-check');
    const outcome = await executeEntryCheckRun({ ...request, jobId: 'job-entry-check-finalizing' }, {
      onRunStarted: (started) => {
        runDirectory = started.runDirectory;
      },
      onFinalizing: () => {
        seen.push(existsSync(artifactFilePath(runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME)));
      },
    });
    expect(outcome.kind).toBe('RAN');
    expect(seen).toEqual([false]);
    expect(existsSync(artifactFilePath(runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME))).toBe(true);
  }, SUITE_TIMEOUT_MS);
});
