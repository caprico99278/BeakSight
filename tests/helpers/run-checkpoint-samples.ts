/**
 * テストの見本の保存（チェックポイント。中断した Run の再開の設計書 4.1）の組み立て（CC-037）。
 * R1 の frontier と採番器、L2 の pacer、L4 の meter、Safety Ledger の snapshot を、実際の部品を動かして作り、R2 の
 * `createRunCheckpoint`・`createRunCheckpointPage` に渡す。値は、`checkpoint`・`checkpoint-page` のスキーマと、R2 の整合の確かめに合う。
 * 既存の2か所（`tests/unit/run-checkpoint.test.ts` の `sampleRunState`、`tests/unit/artifact-writer.test.ts` の `sampleCheckpoint`）は、
 * まだ置き換えていない（R4a の指示書）。
 */
import type { RunCheckpointState, RunExecutionEndReason } from '../../src/core/contracts.js';
import { createLoadMeter } from '../../src/crawl/load-meter.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { CrawlFrontier, type CrawlUrlEntry } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import {
  createRunCheckpoint,
  createRunCheckpointPage,
  type RunCheckpoint,
  type RunCheckpointPage,
} from '../../src/orchestration/run-checkpoint.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { dom, FIXTURE_ORIGIN, FIXTURE_RUN_ID, fixtureUrl, page, PAGE_1, runSummary } from './audit-run-fixture.js';
import { createTestConfig } from './test-config.js';

/** `sampleRunCheckpoint` の指定。 */
export interface SampleRunCheckpointOptions {
  /** 真なら、開始の URL（PAGE-000001）の監査を終えた時点の保存。偽（既定）なら、robots.txt と sitemap.xml の取得の後の保存。 */
  readonly startPageFinished?: boolean;
  /** 保存の状態。省略すると `IN_PROGRESS`。 */
  readonly state?: RunCheckpointState;
}

/**
 * 保存の状態ごとの、見本の実行の記録の終わり方（R4b1 の実行の記録の整合。設計書 4.8）。`IN_PROGRESS` は実行の途中なので `null`。
 * `STOPPED` と `FINISHED` は、最後の実行の記録が終わり方と終わりの時刻（保存の時刻と同じ。設計書 4.3.2）を持つ。
 */
const SAMPLE_EXECUTION_END_REASONS = Object.freeze({
  IN_PROGRESS: null,
  STOPPED: 'STOPPED_BY_SIGNAL',
  FINISHED: 'COMPLETED',
} as const satisfies Record<RunCheckpointState, RunExecutionEndReason | null>);

/**
 * 見本の新しい Run の保存（`state.json` の値）。開始の URL（PAGE-000001）だけを発見した Run で、`startPageFinished` が真なら、
 * そのページは AUDITED で、終わったページの ID に載る（ページの保存は `sampleRunCheckpointPage`）。保存の時刻（`savedAt`）は、
 * 実行の開始の5分後。
 */
export function sampleRunCheckpoint(options: SampleRunCheckpointOptions = {}): RunCheckpoint {
  const config = createTestConfig(FIXTURE_ORIGIN);
  const allocator = new IdAllocator();
  const frontier = new CrawlFrontier(config.crawl.maxDepth, allocator);
  frontier.discover(fixtureUrl('/'), 0);
  const startPageFinished = options.startPageFinished === true;
  if (startPageFinished) {
    const entry = frontier.next() as CrawlUrlEntry;
    frontier.markAuditing(entry.url);
    frontier.markFinished(entry.url, 'AUDITED');
    allocator.allocateEvidenceId('dom');
  }
  const nowMs = (): number => 1_000;
  const startedAt = '2026-10-01T00:00:00.000Z';
  const savedAt = '2026-10-01T00:05:00.000Z';
  const state = options.state ?? 'IN_PROGRESS';
  const endReason = SAMPLE_EXECUTION_END_REASONS[state];
  return createRunCheckpoint({
    state,
    runId: FIXTURE_RUN_ID,
    toolVersion: '0.1.0',
    startedAt,
    savedAt,
    effectiveConfig: config,
    executions: [{ startedAt, finishedAt: endReason === null ? null : savedAt, endReason, environment: runSummary().environment }],
    frontier: frontier.snapshot(),
    allocator: allocator.snapshot(),
    progress: {
      reasons: [],
      retries: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      guardEnabled: true,
      preflightFailed: false,
      pagesStarted: startPageFinished ? 1 : 0,
    },
    safetyLedgerSnapshots: [new SafetyLedger().snapshot()],
    siteMetadata: null,
    load: {
      pacer: createNavigationPacer({ minIntervalMs: 0, now: nowMs, sleep: async () => undefined }).snapshot(),
      meter: createLoadMeter({ allowedOrigins: [FIXTURE_ORIGIN], now: nowMs }).snapshot(),
    },
    completedPageIds: startPageFinished ? [PAGE_1] : [],
  });
}

/** 見本のページの保存（`sampleRunCheckpoint({ startPageFinished: true })` に載る、PAGE-000001 の AUDITED の結果）。 */
export function sampleRunCheckpointPage(): RunCheckpointPage {
  return createRunCheckpointPage({
    result: page(PAGE_1, '/', 'AUDITED', [dom(1, PAGE_1, 'desktop', 'トップページ')]),
    retryEvidence: [],
    safetyLedgerSnapshots: [new SafetyLedger().snapshot(), new SafetyLedger().snapshot()],
  });
}
