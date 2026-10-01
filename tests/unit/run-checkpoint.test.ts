// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 3.2、4.1、4.2、4.4、4.7、第7章）の R2:
// 保存の形式（`schemas/checkpoint.schema.json`、`schemas/checkpoint-page.schema.json`）と、`src/orchestration/run-checkpoint.ts`。
// スキーマの検証（`validateArtifact`）は、保存のファイルを読み書きする ArtifactWriter（R3）が行う（R2 の Blocker B1）。
// ここでは、スキーマそのものを確かめるために、テストの中で `validateArtifact` を直接呼ぶ。
import { uptime } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  RUN_CHECKPOINT_STATES,
  RUN_EXECUTION_END_REASONS,
  RUN_STATUSES,
  type CrawlUrlState,
  type IncompleteReasonCode,
  type PageId,
  type RunCheckpointState,
  type RunExecutionEndReason,
  type RunStatus,
} from '../../src/core/contracts.js';
import type { EffectiveAuditConfig } from '../../src/core/evidence-types.js';
import { createPageId, createRunId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createLoadMeter } from '../../src/crawl/load-meter.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { CrawlFrontier, type CrawlFrontierSnapshot, type CrawlUrlEntry } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  closeInterruptedRunExecutions,
  createRunCheckpoint,
  createRunCheckpointPage,
  createRunLock,
  currentProcessRunLockHost,
  decideRunCheckpointConclusion,
  decideRunExecutionEndReason,
  decideRunResumption,
  effectiveConfigDifferences,
  isProcessRunning,
  judgeRunLock,
  renewRunLock,
  RESUME_CONFIG_IGNORED_PATHS,
  RESUME_REQUEUE_SKIP_REASON_CODES,
  RUN_CHECKPOINT_CONCLUSION_ACTIONS,
  RUN_CHECKPOINT_FINAL_CONTENTS,
  RUN_CHECKPOINT_PAGE_SCHEMA_VERSION,
  RUN_CHECKPOINT_SCHEMA_VERSION,
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  RUN_LOCK_STALE_AFTER_MS,
  RUN_RESUME_SELECTION_KINDS,
  RUN_VERSION_FIELDS,
  runVersionDifferences,
  selectRunToResume,
  type RunCheckpoint,
  type RunCheckpointConclusion,
  type RunCheckpointConclusionAction,
  type RunCheckpointConclusionFacts,
  type RunCheckpointExecution,
  type RunCheckpointFinalContent,
  type RunCheckpointInput,
  type RunCheckpointPage,
  type RunLock,
  type RunLockJudgementInput,
  type RunResumeCandidate,
  type RunResumeSelection,
  type RunVersionField,
  type RunVersions,
} from '../../src/orchestration/run-checkpoint.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  dom,
  finding,
  FIXTURE_ORIGIN,
  FIXTURE_RUN_ID,
  fixtureUrl,
  idOf,
  metadata,
  page,
  PAGE_1,
  PAGE_2,
  PAGE_3,
  record,
  retry,
  runSummary,
  safety,
  screenshot,
} from '../helpers/audit-run-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

const START_URL = fixtureUrl('/');
const SECOND_URL = fixtureUrl('/second.html');
const THIRD_URL = fixtureUrl('/third.html');

/** 保存のファイルを通したのと同じく、JSON にして読み戻した値。 */
const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 値を JSON にして読み戻した、書き換えられる写し（壊れた保存を作るため）。 */
const mutableCopy = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** 深く凍結されているか。 */
const isDeeplyFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
};

/** 見本の Run の、最終の試行の結果と、再試行の前の試行の Evidence（`progress.results` と `progress.retryEvidence` の値）。 */
const firstPageResult = () => {
  const desktopDom = dom(3, PAGE_1, 'desktop', 'トップページ');
  return page(PAGE_1, '/', 'AUDITED', [
    desktopDom,
    screenshot(4, PAGE_1, 'desktop', 'VIEWPORT'),
    dom(5, PAGE_1, 'mobile', 'トップページ'),
    safety(6, PAGE_1, 'desktop'),
  ], [finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(desktopDom)])]);
};
const secondPageRetryEvidence = () => [dom(7, PAGE_2, 'desktop', '再試行の前の本文'), screenshot(8, PAGE_2, 'desktop', 'VIEWPORT', 1)];
const secondPageResult = () => page(PAGE_2, '/second.html', 'FAILED', [dom(9, PAGE_2, 'desktop', '2ページ目')]);

/** robots.txt と sitemap.xml の Evidence（`SiteMetadataResult.records` と同じ順）。 */
const siteMetadataRecords = () => [
  metadata(1, PAGE_1),
  record('metadata', 2, PAGE_1, null, {
    kind: 'SITEMAP_XML',
    url: fixtureUrl('/sitemap.xml'),
    outcome: 'OK',
    httpStatus: 200,
    text: '<urlset></urlset>',
    textTruncated: false,
    sitemapUrls: [SECOND_URL],
    sitemapUrlsTruncated: false,
  }),
] as const;

/**
 * 見本の Run の状態（`RunCheckpointInput`）。R1 の frontier と採番器、L2 の pacer、L4 の meter、Safety Ledger の snapshot を、
 * 実際の部品を動かして作る。PAGE-000001 は AUDITED、PAGE-000002 は再試行の後に FAILED、PAGE-000003 は QUEUED。
 * Safety Ledger の snapshot は、ページの外で作った Ledger（PREFLIGHT、環境の記録、robots.txt と sitemap.xml の取得）のものだけで、
 * 作った順に並べる（設計書 4.1）。ページの中で作った Ledger の snapshot は、ページの保存（`samplePages`）に入れる。
 */
async function sampleRunState(): Promise<RunCheckpointInput> {
  const config = createTestConfig(FIXTURE_ORIGIN);
  const allocator = new IdAllocator();
  const frontier = new CrawlFrontier(config.crawl.maxDepth, allocator);
  frontier.discover(START_URL, 0);
  const audit = (status: 'AUDITED' | 'FAILED', links: readonly typeof START_URL[]): void => {
    const entry = frontier.next() as CrawlUrlEntry;
    frontier.markAuditing(entry.url);
    frontier.markFinished(entry.url, status);
    for (const link of links) {
      frontier.discover(link, entry.depth + 1);
    }
  };
  audit('AUDITED', [SECOND_URL, THIRD_URL]);
  audit('FAILED', []);
  for (let index = 0; index < 9; index += 1) {
    allocator.allocateEvidenceId('dom');
  }
  allocator.advanceFindingSequence(2);

  let nowMs = 1_000;
  const pacer = createNavigationPacer({
    minIntervalMs: 500,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  });
  await pacer.beforeNavigation();
  await pacer.beforeNavigation();

  const meter = createLoadMeter({ allowedOrigins: [FIXTURE_ORIGIN], now: () => nowMs });
  meter.recordRequestFinished({}, START_URL);
  meter.recordRequestFinished({}, 'https://external.test/script.js');
  meter.recordServedFromRunCache({});
  meter.recordWithheld();

  // ページの外で作った Ledger（作った順）。環境の記録の Context は、閉じるのに失敗して違反を記録した。robots.txt と sitemap.xml の
  // 取得の Context は、Passive の Guard で遮断した要求と遷移を記録した。
  const preflightLedger = new SafetyLedger();
  const environmentLedger = new SafetyLedger();
  environmentLedger.recordInvariantViolation({ code: 'TEST_VIOLATION', message: 'テストの違反' });
  const siteMetadataLedger = new SafetyLedger();
  siteMetadataLedger.recordBlockedRequest({ method: 'POST', url: fixtureUrl('/api/submit'), reason: 'NON_READ_METHOD' });
  siteMetadataLedger.recordBlockedNavigation({ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
  siteMetadataLedger.recordExternalSchemeNavigation({
    url: 'beaksight-test-app:probe',
    scheme: 'beaksight-test-app',
    frame: 'MAIN',
    phase: 'PASSIVE',
    reason: 'EXTERNAL_SCHEME_NAVIGATION',
  });

  const environment = runSummary().environment;
  return {
    state: 'IN_PROGRESS',
    runId: FIXTURE_RUN_ID,
    toolVersion: '0.1.0',
    startedAt: '2026-10-01T00:00:00.000Z',
    savedAt: '2026-10-01T01:05:00.000Z',
    effectiveConfig: config,
    executions: [
      { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:10:00.000Z', endReason: 'INTERRUPTED_ABNORMALLY', environment },
      { startedAt: '2026-10-01T01:00:00.000Z', finishedAt: null, endReason: null, environment },
    ],
    frontier: frontier.snapshot(),
    allocator: allocator.snapshot(),
    progress: {
      reasons: [{ code: 'UNHANDLED_FAILURE', detail: 'site-metadata-page-close:closed' }],
      retries: [retry(SECOND_URL, 1, secondPageRetryEvidence())],
      safetyViolationDetected: true,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      guardEnabled: true,
      preflightFailed: false,
      pagesStarted: 2,
    },
    safetyLedgerSnapshots: [preflightLedger.snapshot(), environmentLedger.snapshot(), siteMetadataLedger.snapshot()],
    siteMetadata: { records: siteMetadataRecords() },
    load: { pacer: pacer.snapshot(), meter: meter.snapshot() },
    completedPageIds: [PAGE_1, PAGE_2],
  };
}

/** 見本の Run の保存（`state.json` の値）。 */
const sampleCheckpoint = async (): Promise<RunCheckpoint> => createRunCheckpoint(await sampleRunState());

/**
 * 見本の Run の、ページの中で作った Safety Ledger の snapshot（設計書 4.1。ページの保存に入れる）。PAGE-000001 は Desktop と Mobile の
 * Context の Ledger（Desktop で POST を1件遮断した）。PAGE-000002 は再試行したので、2回の試行の Desktop の Context の Ledger。
 */
const firstPageLedgerSnapshots = () => {
  const desktop = new SafetyLedger();
  desktop.recordBlockedRequest({ method: 'POST', url: fixtureUrl('/api/form'), reason: 'NON_READ_METHOD' });
  return [desktop.snapshot(), new SafetyLedger().snapshot()];
};
const secondPageLedgerSnapshots = () => {
  const retried = new SafetyLedger();
  retried.recordBlockedNavigation({ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
  return [new SafetyLedger().snapshot(), retried.snapshot()];
};

/** 見本の Run の、ページの保存の値（PAGE-000001 と PAGE-000002）。 */
const samplePages = (): readonly RunCheckpointPage[] => [
  createRunCheckpointPage({ result: firstPageResult(), retryEvidence: [], safetyLedgerSnapshots: firstPageLedgerSnapshots() }),
  createRunCheckpointPage({
    result: secondPageResult(),
    retryEvidence: secondPageRetryEvidence(),
    safetyLedgerSnapshots: secondPageLedgerSnapshots(),
  }),
];

/** 保存の値の一部を上書きした値（`RunCheckpoint` の形のまま。整合と判定のテスト用）。 */
const withCheckpoint = (checkpoint: RunCheckpoint, overrides: Partial<RunCheckpoint>): RunCheckpoint => ({ ...checkpoint, ...overrides });

const expectSchemaRejects = async (
  schema: 'checkpoint' | 'checkpoint-page',
  value: unknown,
  errorPart: string,
): Promise<void> => {
  const result = await validateArtifact(schema, value);
  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([expect.stringContaining(errorPart)]));
};

const expectInconsistent = (result: ReturnType<typeof checkRunCheckpointConsistency>, errorPart: string): void => {
  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([expect.stringContaining(errorPart)]));
};

describe('R2: the checkpoint content (state.json and the page checkpoint, design 4.1)', () => {
  it('creates a deeply frozen state.json value that comes back unchanged through JSON and matches checkpoint.schema.json', async () => {
    const checkpoint = await sampleCheckpoint();

    expect(checkpoint.schemaVersion).toBe(RUN_CHECKPOINT_SCHEMA_VERSION);
    expect(isDeeplyFrozen(checkpoint)).toBe(true);
    const restored = throughJson(checkpoint);
    // Safety Ledger の `blockedRequestsByMethod` は prototype のないオブジェクトなので、`toEqual` で比べる。
    expect(restored).toEqual(checkpoint);
    await expect(validateArtifact('checkpoint', restored)).resolves.toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(restored)).toEqual({ ok: true });
  });

  it('keeps every item of the run state that design 4.1 lists', async () => {
    const input = await sampleRunState();
    const checkpoint = createRunCheckpoint(input);

    expect(checkpoint).toEqual({ schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION, ...input });
    expect(Object.keys(checkpoint).sort()).toEqual([
      'allocator',
      'completedPageIds',
      'effectiveConfig',
      'executions',
      'frontier',
      'load',
      'progress',
      'runId',
      'safetyLedgerSnapshots',
      'savedAt',
      'schemaVersion',
      'siteMetadata',
      'startedAt',
      'state',
      'toolVersion',
    ]);
    // 保存の時刻（R4b1。設計書 4.1）は、入力の値のまま（その `state.json` の値を作った時刻）。
    expect(checkpoint.savedAt).toBe(input.savedAt);
  });

  it('keeps the frontier and the allocator in the form that R1 restores from', async () => {
    const restored = throughJson(await sampleCheckpoint());
    const config = createTestConfig(FIXTURE_ORIGIN);
    const allocator = IdAllocator.restore(restored.allocator);
    const frontier = CrawlFrontier.restore(restored.frontier, {
      maxDepth: config.crawl.maxDepth,
      allocator,
      allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
      requeueSkipReasonCodes: new Set(RESUME_REQUEUE_SKIP_REASON_CODES),
    });

    expect(frontier.snapshot()).toEqual(restored.frontier);
    expect(frontier.next()?.pageId).toBe(PAGE_3);
    expect(allocator.allocatePageId()).toBe(createPageId(4));
  });

  it('copies the input instead of keeping or freezing it', async () => {
    const input = await sampleRunState();
    const checkpoint = createRunCheckpoint(input);
    const before = throughJson(checkpoint);

    expect(Object.isFrozen(input.effectiveConfig)).toBe(false);
    (input.effectiveConfig.crawl as { maxPages: number }).maxPages += 1;
    (input.progress.reasons as unknown[]).push({ code: 'EXECUTION_INCOMPLETE', detail: null });

    expect(throughJson(checkpoint)).toEqual(before);
  });

  it('accepts a checkpoint before robots.txt and sitemap.xml were fetched (no metadata, no completed page)', async () => {
    const config = createTestConfig(FIXTURE_ORIGIN);
    const allocator = new IdAllocator();
    const frontier = new CrawlFrontier(config.crawl.maxDepth, allocator);
    frontier.discover(START_URL, 0);
    const input = await sampleRunState();
    const checkpoint = createRunCheckpoint({
      ...input,
      frontier: frontier.snapshot(),
      allocator: allocator.snapshot(),
      siteMetadata: null,
      safetyLedgerSnapshots: [],
      completedPageIds: [],
      load: { pacer: createNavigationPacer({ minIntervalMs: 0, now: () => 0, sleep: async () => undefined }).snapshot(), meter: input.load.meter },
    });

    expect(checkpoint.load.pacer.lastNavigationStartedAtMs).toBeNull();
    await expect(validateArtifact('checkpoint', throughJson(checkpoint))).resolves.toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(checkpoint)).toEqual({ ok: true });
  });

  it('creates deeply frozen page checkpoints that come back unchanged through JSON and match checkpoint-page.schema.json', async () => {
    const checkpoint = await sampleCheckpoint();
    for (const pageCheckpoint of samplePages()) {
      expect(pageCheckpoint.schemaVersion).toBe(RUN_CHECKPOINT_PAGE_SCHEMA_VERSION);
      expect(pageCheckpoint.pageId).toBe(pageCheckpoint.result.pageId);
      expect(pageCheckpoint.url).toBe(pageCheckpoint.result.pageUrl);
      expect(isDeeplyFrozen(pageCheckpoint)).toBe(true);
      const restored = throughJson(pageCheckpoint);
      expect(restored).toEqual(pageCheckpoint);
      await expect(validateArtifact('checkpoint-page', restored)).resolves.toEqual({ ok: true });
      expect(checkRunCheckpointPageConsistency(restored, checkpoint)).toEqual({ ok: true });
    }
  });

  it('keeps the final attempt, the Evidence of the earlier attempts, and the Safety Ledgers made in the page', () => {
    const [, second] = samplePages();

    // Safety Ledger の `blockedRequestsByMethod` は prototype のないオブジェクトなので、`toEqual` で比べる。
    expect(second).toEqual({
      schemaVersion: RUN_CHECKPOINT_PAGE_SCHEMA_VERSION,
      pageId: PAGE_2,
      url: SECOND_URL,
      result: secondPageResult(),
      retryEvidence: secondPageRetryEvidence(),
      safetyLedgerSnapshots: secondPageLedgerSnapshots(),
    });
    expect(second?.safetyLedgerSnapshots[1]?.blockedNavigations).toHaveLength(1);
  });

  it('copies the Safety Ledger snapshots of the page instead of keeping them', () => {
    const snapshots = firstPageLedgerSnapshots();
    const pageCheckpoint = createRunCheckpointPage({ result: firstPageResult(), retryEvidence: [], safetyLedgerSnapshots: snapshots });

    expect(pageCheckpoint.safetyLedgerSnapshots).not.toBe(snapshots);
    expect(pageCheckpoint.safetyLedgerSnapshots).toEqual(snapshots);
    expect(isDeeplyFrozen(pageCheckpoint.safetyLedgerSnapshots)).toBe(true);
  });
});

describe('R2: checkpoint.schema.json rejects broken checkpoints (design 4.2)', () => {
  const REQUIRED_KEYS = [
    'schemaVersion',
    'state',
    'runId',
    'toolVersion',
    'startedAt',
    'savedAt',
    'effectiveConfig',
    'executions',
    'frontier',
    'allocator',
    'progress',
    'safetyLedgerSnapshots',
    'siteMetadata',
    'load',
    'completedPageIds',
  ] as const;

  it.each(REQUIRED_KEYS)('rejects a checkpoint without %s', async (key) => {
    const value = mutableCopy(await sampleCheckpoint());
    delete value[key];
    await expectSchemaRejects('checkpoint', value, key);
  });

  it.each([
    ['the top level', (value: Record<string, unknown>) => value],
    ['the progress', (value: Record<string, unknown>) => value.progress as Record<string, unknown>],
    ['an execution', (value: Record<string, unknown>) => (value.executions as Record<string, unknown>[])[0] as Record<string, unknown>],
    ['a frontier entry', (value: Record<string, unknown>) => ((value.frontier as { entries: Record<string, unknown>[] }).entries[0]) as Record<string, unknown>],
    ['the allocator', (value: Record<string, unknown>) => value.allocator as Record<string, unknown>],
    ['a Safety Ledger snapshot', (value: Record<string, unknown>) => (value.safetyLedgerSnapshots as Record<string, unknown>[])[1] as Record<string, unknown>],
    ['the site metadata', (value: Record<string, unknown>) => value.siteMetadata as Record<string, unknown>],
    ['the pacer record', (value: Record<string, unknown>) => (value.load as { pacer: Record<string, unknown> }).pacer],
    ['the load record', (value: Record<string, unknown>) => value.load as Record<string, unknown>],
  ] as const)('rejects an extra property in %s', async (_name, target) => {
    const value = mutableCopy(await sampleCheckpoint());
    target(value).unexpected = true;
    await expectSchemaRejects('checkpoint', value, 'must NOT have additional properties');
  });

  it.each([
    ['a state outside the closed list', (value: Record<string, unknown>) => {
      value.state = 'PAUSED';
    }, '/state'],
    ['a numeric state', (value: Record<string, unknown>) => {
      value.state = 1;
    }, '/state'],
    ['another schema version', (value: Record<string, unknown>) => {
      value.schemaVersion = 'checkpoint-schema/2.0';
    }, '/schemaVersion'],
    ['a run ID in another format', (value: Record<string, unknown>) => {
      value.runId = 'run-1';
    }, '/runId'],
    ['an empty saved time', (value: Record<string, unknown>) => {
      value.savedAt = '';
    }, '/savedAt'],
    ['a numeric saved time', (value: Record<string, unknown>) => {
      value.savedAt = 1_000;
    }, '/savedAt'],
    ['an end reason outside the closed list', (value: Record<string, unknown>) => {
      ((value.executions as Record<string, unknown>[])[0] as Record<string, unknown>).endReason = 'CRASHED';
    }, '/executions/0/endReason'],
    ['an execution without the environment of run.json', (value: Record<string, unknown>) => {
      ((value.executions as Record<string, unknown>[])[0] as Record<string, unknown>).environment = { nodeVersion: 'v24' };
    }, '/executions/0/environment'],
    ['no execution', (value: Record<string, unknown>) => {
      value.executions = [];
    }, '/executions'],
    ['a crawl URL state outside the closed list', (value: Record<string, unknown>) => {
      ((value.frontier as { entries: Record<string, unknown>[] }).entries[2] as Record<string, unknown>).state = 'PENDING';
    }, '/frontier/entries/2/state'],
    ['a skip reason code outside the closed list', (value: Record<string, unknown>) => {
      const entry = (value.frontier as { entries: Record<string, unknown>[] }).entries[2] as Record<string, unknown>;
      entry.state = 'SKIPPED';
      entry.skipReason = { code: 'RUN_PAUSED', detail: null };
    }, '/frontier/entries/2/skipReason'],
    ['a SKIPPED entry without a skip reason', (value: Record<string, unknown>) => {
      ((value.frontier as { entries: Record<string, unknown>[] }).entries[2] as Record<string, unknown>).state = 'SKIPPED';
    }, '/frontier/entries/2/skipReason'],
    ['a QUEUED entry with a skip reason', (value: Record<string, unknown>) => {
      ((value.frontier as { entries: Record<string, unknown>[] }).entries[2] as Record<string, unknown>).skipReason = {
        code: 'MAX_PAGES_REACHED',
        detail: null,
      };
    }, '/frontier/entries/2/skipReason'],
    ['a negative depth', (value: Record<string, unknown>) => {
      ((value.frontier as { entries: Record<string, unknown>[] }).entries[0] as Record<string, unknown>).depth = -1;
    }, '/frontier/entries/0/depth'],
    ['a page ID in another format in the frontier', (value: Record<string, unknown>) => {
      ((value.frontier as { entries: Record<string, unknown>[] }).entries[0] as Record<string, unknown>).pageId = 'page-1';
    }, '/frontier/entries/0/pageId'],
    ['a next sequence below the first sequence', (value: Record<string, unknown>) => {
      (value.allocator as Record<string, unknown>).nextPageSequence = 0;
    }, '/allocator/nextPageSequence'],
    ['a fractional next sequence', (value: Record<string, unknown>) => {
      (value.allocator as Record<string, unknown>).nextEvidenceSequence = 1.5;
    }, '/allocator/nextEvidenceSequence'],
    ['a negative count of pages started', (value: Record<string, unknown>) => {
      (value.progress as Record<string, unknown>).pagesStarted = -1;
    }, '/progress/pagesStarted'],
    ['a string flag', (value: Record<string, unknown>) => {
      (value.progress as Record<string, unknown>).safetyViolationDetected = 'false';
    }, '/progress/safetyViolationDetected'],
    ['a reason code outside the closed list', (value: Record<string, unknown>) => {
      (value.progress as Record<string, unknown>).reasons = [{ code: 'NOT_A_REASON', detail: null }];
    }, '/progress/reasons/0/code'],
    ['a malformed retry record', (value: Record<string, unknown>) => {
      ((value.progress as { retries: Record<string, unknown>[] }).retries[0] as Record<string, unknown>).navigationOutcome = 'SLOW';
    }, '/progress/retries/0/navigationOutcome'],
    ['a malformed Safety event', (value: Record<string, unknown>) => {
      ((value.safetyLedgerSnapshots as { blockedRequests: Record<string, unknown>[] }[])[2]?.blockedRequests[0] as Record<string, unknown>).reason = 'ANY';
    }, '/safetyLedgerSnapshots/2/blockedRequests/0/reason'],
    ['a Safety Ledger snapshot without the invariant violation count', (value: Record<string, unknown>) => {
      delete (value.safetyLedgerSnapshots as Record<string, unknown>[])[0]?.invariantViolationCount;
    }, 'invariantViolationCount'],
    ['a Safety Ledger snapshot with a scope (the Evidence form)', (value: Record<string, unknown>) => {
      ((value.safetyLedgerSnapshots as Record<string, unknown>[])[0] as Record<string, unknown>).scope = 'PASSIVE';
    }, 'must NOT have additional properties'],
    ['a malformed invariant violation', (value: Record<string, unknown>) => {
      ((value.safetyLedgerSnapshots as { invariantViolations: unknown[] }[])[1] as { invariantViolations: unknown[] }).invariantViolations = [{ code: 1 }];
    }, '/safetyLedgerSnapshots/1/invariantViolations/0'],
    ['site metadata with one Evidence', (value: Record<string, unknown>) => {
      ((value.siteMetadata as { records: unknown[] }).records).pop();
    }, '/siteMetadata'],
    ['site metadata with three Evidence', (value: Record<string, unknown>) => {
      const records = (value.siteMetadata as { records: unknown[] }).records;
      records.push(records[1]);
    }, '/siteMetadata'],
    ['site metadata whose Evidence is not metadata', (value: Record<string, unknown>) => {
      (value.siteMetadata as { records: unknown[] }).records[0] = mutableCopy(dom(1, PAGE_1, 'desktop', 'text'));
    }, '/siteMetadata/records/0'],
    ['site metadata in the reverse order (sitemap.xml first)', (value: Record<string, unknown>) => {
      (value.siteMetadata as { records: unknown[] }).records.reverse();
    }, '/siteMetadata/records/0'],
    ['a malformed pacer record', (value: Record<string, unknown>) => {
      (value.load as { pacer: Record<string, unknown> }).pacer.lastNavigationStartedAtMs = '1000';
    }, '/load/pacer/lastNavigationStartedAtMs'],
    ['a meter record without the cached count', (value: Record<string, unknown>) => {
      delete (value.load as { meter: Record<string, unknown> }).meter.servedFromCache;
    }, 'servedFromCache'],
    ['a completed page ID in another format', (value: Record<string, unknown>) => {
      value.completedPageIds = ['PAGE-1'];
    }, '/completedPageIds/0'],
    ['a completed page ID listed twice', (value: Record<string, unknown>) => {
      value.completedPageIds = [PAGE_1, PAGE_1];
    }, '/completedPageIds'],
    ['an effective configuration in another shape than run.json', (value: Record<string, unknown>) => {
      delete ((value.effectiveConfig as { crawl: Record<string, unknown> }).crawl).maxPages;
    }, 'maxPages'],
  ] as const)('rejects %s', async (_name, breakValue, errorPart) => {
    const value = mutableCopy(await sampleCheckpoint());
    breakValue(value);
    await expectSchemaRejects('checkpoint', value, errorPart);
  });

  it('cannot read a state.json cut in the middle, and rejects the value of its first half', async () => {
    const checkpoint = await sampleCheckpoint();
    const text = JSON.stringify(checkpoint);

    expect(() => JSON.parse(text.slice(0, Math.floor(text.length / 2)))).toThrow(SyntaxError);
    const firstHalf = Object.fromEntries(Object.entries(mutableCopy(checkpoint)).slice(0, REQUIRED_KEYS.length / 2));
    await expectSchemaRejects('checkpoint', firstHalf, 'must include');
  });

  it.each([null, [], 'checkpoint', 1])('rejects %j as a checkpoint', async (value) => {
    await expect(validateArtifact('checkpoint', value)).resolves.toMatchObject({ ok: false });
  });
});

describe('R2: checkpoint-page.schema.json rejects broken page checkpoints (design 4.2)', () => {
  const samplePage = (): Record<string, unknown> => mutableCopy(samplePages()[1]);

  it.each(['schemaVersion', 'pageId', 'url', 'result', 'retryEvidence', 'safetyLedgerSnapshots'] as const)('rejects a page checkpoint without %s', async (key) => {
    const value = samplePage();
    delete value[key];
    await expectSchemaRejects('checkpoint-page', value, key);
  });

  it.each([
    ['an extra property', (value: Record<string, unknown>) => {
      value.unexpected = true;
    }, 'must NOT have additional properties'],
    ['another schema version', (value: Record<string, unknown>) => {
      value.schemaVersion = 'page-schema/1.0';
    }, '/schemaVersion'],
    ['a page ID in another format', (value: Record<string, unknown>) => {
      value.pageId = 'PAGE-2';
    }, '/pageId'],
    ['an empty URL', (value: Record<string, unknown>) => {
      value.url = '';
    }, '/url'],
    ['a result whose page status is outside the closed list', (value: Record<string, unknown>) => {
      (value.result as Record<string, unknown>).status = 'DONE';
    }, '/result/status'],
    ['a result without the viewports', (value: Record<string, unknown>) => {
      delete (value.result as Record<string, unknown>).viewports;
    }, 'viewports'],
    ['a result with an extra property', (value: Record<string, unknown>) => {
      (value.result as Record<string, unknown>).retryEvidence = [];
    }, 'must NOT have additional properties'],
    ['a malformed Evidence of an earlier attempt', (value: Record<string, unknown>) => {
      ((value.retryEvidence as Record<string, unknown>[])[0] as Record<string, unknown>).type = 'unknown';
    }, '/retryEvidence/0'],
    ['Evidence of an earlier attempt that is not a list', (value: Record<string, unknown>) => {
      value.retryEvidence = {};
    }, '/retryEvidence'],
    ['a malformed Safety Ledger snapshot of the page', (value: Record<string, unknown>) => {
      ((value.safetyLedgerSnapshots as Record<string, unknown>[])[1] as Record<string, unknown>).invariantViolationCount = -1;
    }, '/safetyLedgerSnapshots/1/invariantViolationCount'],
    ['a Safety Ledger snapshot of the page with an extra property', (value: Record<string, unknown>) => {
      ((value.safetyLedgerSnapshots as Record<string, unknown>[])[0] as Record<string, unknown>).scope = 'PASSIVE';
    }, 'must NOT have additional properties'],
    ['Safety Ledger snapshots of the page that are not a list', (value: Record<string, unknown>) => {
      value.safetyLedgerSnapshots = {};
    }, '/safetyLedgerSnapshots'],
  ] as const)('rejects %s', async (_name, breakValue, errorPart) => {
    const value = samplePage();
    breakValue(value);
    await expectSchemaRejects('checkpoint-page', value, errorPart);
  });
});

describe('R2: consistency that the schemas cannot check', () => {
  /** frontier の記録の1つの状態を変えた保存（`RunCheckpoint` の形のまま）。 */
  const withEntryState = (checkpoint: RunCheckpoint, pageId: PageId, state: CrawlUrlState): RunCheckpoint => withCheckpoint(checkpoint, {
    frontier: {
      entries: checkpoint.frontier.entries.map((entry) => (entry.pageId === pageId
        ? { ...entry, state, skipReason: state === 'SKIPPED' ? { code: 'MAX_PAGES_REACHED', detail: null } : null }
        : entry)),
    },
  });

  it('accepts the checkpoint of the sample run', async () => {
    expect(checkRunCheckpointConsistency(await sampleCheckpoint())).toEqual({ ok: true });
  });

  it('rejects a completed page ID that is not a page of the frontier', async () => {
    const checkpoint = await sampleCheckpoint();
    const unknownPage = createPageId(99);
    const result = checkRunCheckpointConsistency(withCheckpoint(checkpoint, { completedPageIds: [PAGE_1, PAGE_2, unknownPage] }));

    expectInconsistent(result, `/completedPageIds/2 (${unknownPage})`);
  });

  it.each(['QUEUED', 'AUDITING', 'SKIPPED', 'DISCOVERED'] as const)(
    'rejects a completed page whose frontier entry is %s (the audit of the page has not finished)',
    async (state) => {
      const checkpoint = withEntryState(await sampleCheckpoint(), PAGE_2, state);
      expectInconsistent(checkRunCheckpointConsistency(checkpoint), `/completedPageIds/1 (${PAGE_2})`);
    },
  );

  it('rejects a frontier entry that finished its audit but is not a completed page (its page checkpoint is not listed)', async () => {
    const checkpoint = await sampleCheckpoint();
    const result = checkRunCheckpointConsistency(withCheckpoint(checkpoint, { completedPageIds: [PAGE_1] }));

    expectInconsistent(result, `/frontier/entries/1 (${PAGE_2})`);
  });

  it('reports every inconsistency at once, without throwing', async () => {
    const checkpoint = withEntryState(await sampleCheckpoint(), PAGE_1, 'QUEUED');
    const result = checkRunCheckpointConsistency(withCheckpoint(checkpoint, { completedPageIds: [PAGE_1, createPageId(99)] }));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toHaveLength(3);
  });

  describe('page checkpoints', () => {
    it.each([
      ['a page ID that differs from the page ID of the result', (value: RunCheckpointPage): RunCheckpointPage => ({ ...value, pageId: PAGE_3 }), '/pageId'],
      ['a URL that differs from the URL of the result', (value: RunCheckpointPage): RunCheckpointPage => ({ ...value, url: THIRD_URL }), '/url'],
      ['Evidence of an earlier attempt of another page', (value: RunCheckpointPage): RunCheckpointPage => ({
        ...value,
        retryEvidence: [dom(7, PAGE_3, 'desktop', '別のページ')],
      }), '/retryEvidence/0/pageId'],
    ] as const)('rejects %s', async (_name, breakPage, errorPart) => {
      const checkpoint = await sampleCheckpoint();
      const second = samplePages()[1] as RunCheckpointPage;
      expectInconsistent(checkRunCheckpointPageConsistency(breakPage(second), checkpoint), errorPart);
    });

    it('rejects a page checkpoint of a page that the checkpoint does not list as completed', async () => {
      const checkpoint = withCheckpoint(await sampleCheckpoint(), { completedPageIds: [PAGE_1] });
      const second = samplePages()[1] as RunCheckpointPage;

      expectInconsistent(checkRunCheckpointPageConsistency(second, checkpoint), `/pageId (${PAGE_2})`);
    });

    it('rejects a page checkpoint whose URL differs from the URL of its frontier entry', async () => {
      const checkpoint = await sampleCheckpoint();
      const moved = createRunCheckpointPage({
        result: page(PAGE_2, '/moved.html', 'FAILED', [dom(9, PAGE_2, 'desktop', '2ページ目')]),
        retryEvidence: [],
        safetyLedgerSnapshots: [],
      });

      expectInconsistent(checkRunCheckpointPageConsistency(moved, checkpoint), '/url');
    });
  });
});

describe('R4b1: consistency of the executions (design 4.8)', () => {
  /** 保存の状態と実行の記録を置き換えた保存（`RunCheckpoint` の形のまま）。 */
  const withExecutions = (
    checkpoint: RunCheckpoint,
    state: RunCheckpointState,
    executions: RunCheckpoint['executions'],
  ): RunCheckpoint => withCheckpoint(checkpoint, { state, executions });
  /** 実行の記録を、終わり方 `endReason` で閉じたもの（終わりの時刻は、見本の保存の時刻）。 */
  const closed = (execution: RunCheckpointExecution, endReason: RunExecutionEndReason): RunCheckpointExecution => ({
    ...execution,
    finishedAt: '2026-10-01T01:05:00.000Z',
    endReason,
  });
  /** 実行の途中の記録（終わり方と終わりの時刻が `null`）。 */
  const open = (execution: RunCheckpointExecution): RunCheckpointExecution => ({ ...execution, finishedAt: null, endReason: null });
  /** 食い違いの文の一覧（食い違いがなければ空）。 */
  const errorsOf = (checkpoint: RunCheckpoint): readonly string[] => {
    const result = checkRunCheckpointConsistency(checkpoint);
    return result.ok ? [] : result.errors;
  };

  it('accepts an IN_PROGRESS checkpoint whose last execution is unfinished and whose earlier executions are closed', async () => {
    const checkpoint = await sampleCheckpoint();

    expect(checkpoint.state).toBe('IN_PROGRESS');
    expect(checkpoint.executions.map(({ endReason }) => endReason)).toEqual(['INTERRUPTED_ABNORMALLY', null]);
    expect(checkRunCheckpointConsistency(checkpoint)).toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(withExecutions(checkpoint, 'IN_PROGRESS', [open(checkpoint.executions[0])]))).toEqual({ ok: true });
  });

  it.each([
    ['STOPPED', 'STOPPED_BY_RUNTIME_LIMIT'],
    ['STOPPED', 'STOPPED_BY_SIGNAL'],
    ['FINISHED', 'COMPLETED'],
    ['FINISHED', 'STOPPED_BY_SAFETY_VIOLATION'],
  ] as const)('accepts a %s checkpoint whose last execution ended with %s', async (state, endReason) => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;

    expect(checkRunCheckpointConsistency(withExecutions(checkpoint, state, [earlier, closed(last as RunCheckpointExecution, endReason)])))
      .toEqual({ ok: true });
  });

  it('rejects an earlier execution without the end reason and the end time (only the last execution can be unfinished)', async () => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;
    const errors = errorsOf(withExecutions(checkpoint, 'IN_PROGRESS', [open(earlier), last as RunCheckpointExecution]));

    expect(errors).toHaveLength(2);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('/executions/0/endReason'),
      expect.stringContaining('/executions/0/finishedAt'),
    ]));
  });

  it('rejects an earlier execution with the end reason but without the end time', async () => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;
    const errors = errorsOf(withExecutions(checkpoint, 'IN_PROGRESS', [{ ...earlier, finishedAt: null }, last as RunCheckpointExecution]));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/executions/0/finishedAt');
  });

  it.each([
    ['the end reason and the end time', (execution: RunCheckpointExecution) => closed(execution, 'COMPLETED'), ['endReason', 'finishedAt']],
    ['only the end reason', (execution: RunCheckpointExecution) => ({ ...execution, endReason: 'COMPLETED' as const }), ['endReason']],
    ['only the end time', (execution: RunCheckpointExecution) => ({ ...execution, finishedAt: '2026-10-01T01:05:00.000Z' }), ['finishedAt']],
  ] as const)('rejects an IN_PROGRESS checkpoint whose last execution has %s', async (_name, change, items) => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;
    const errors = errorsOf(withExecutions(checkpoint, 'IN_PROGRESS', [earlier, change(last as RunCheckpointExecution)]));

    expect(errors).toHaveLength(items.length);
    expect(errors).toEqual(expect.arrayContaining(items.map((item) => expect.stringContaining(`/executions/1/${item}`))));
  });

  it.each(['STOPPED', 'FINISHED'] as const)('rejects a %s checkpoint whose last execution is unfinished', async (state) => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;
    const errors = errorsOf(withExecutions(checkpoint, state, [earlier, open(last as RunCheckpointExecution)]));

    expect(errors).toHaveLength(2);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('/executions/1/endReason'),
      expect.stringContaining('/executions/1/finishedAt'),
    ]));
    // 終わり方だけ、または終わりの時刻だけがない場合も、食い違いとする。
    expect(errorsOf(withExecutions(checkpoint, state, [earlier, { ...closed(last as RunCheckpointExecution, 'COMPLETED'), endReason: null }])))
      .toEqual([expect.stringContaining('/executions/1/endReason')]);
    expect(errorsOf(withExecutions(checkpoint, state, [earlier, { ...closed(last as RunCheckpointExecution, 'COMPLETED'), finishedAt: null }])))
      .toEqual([expect.stringContaining('/executions/1/finishedAt')]);
  });

  it.each(['STOPPED', 'FINISHED'] as const)(
    'rejects a %s checkpoint whose last execution ended with INTERRUPTED_ABNORMALLY (used only to close an earlier execution)',
    async (state) => {
      const checkpoint = await sampleCheckpoint();
      const [earlier, last] = checkpoint.executions;
      const errors = errorsOf(withExecutions(checkpoint, state, [earlier, closed(last as RunCheckpointExecution, 'INTERRUPTED_ABNORMALLY')]));

      expect(errors).toEqual([expect.stringContaining('/executions/1/endReason is INTERRUPTED_ABNORMALLY')]);
      // 実行の記録が1件だけの保存でも、最後の記録として扱う。
      expect(errorsOf(withExecutions(checkpoint, state, [closed(earlier, 'INTERRUPTED_ABNORMALLY')])))
        .toEqual([expect.stringContaining('/executions/0/endReason is INTERRUPTED_ABNORMALLY')]);
      // IN_PROGRESS の保存でも、最後の記録が INTERRUPTED_ABNORMALLY であることを、食い違いの1つとして返す。
      expect(errorsOf(withExecutions(checkpoint, 'IN_PROGRESS', [earlier, closed(last as RunCheckpointExecution, 'INTERRUPTED_ABNORMALLY')])))
        .toEqual(expect.arrayContaining([expect.stringContaining('/executions/1/endReason is INTERRUPTED_ABNORMALLY')]));
    },
  );

  it('reports every inconsistency of the executions together with the other inconsistencies, without throwing', async () => {
    const checkpoint = await sampleCheckpoint();
    const [earlier, last] = checkpoint.executions;
    const broken = withCheckpoint(withExecutions(checkpoint, 'STOPPED', [open(earlier), open(last as RunCheckpointExecution)]), {
      completedPageIds: [PAGE_1, PAGE_2, createPageId(99)],
    });

    // 途中の記録の2つ、最後の記録の2つ、終わったページの ID の1つ。
    expect(errorsOf(broken)).toHaveLength(5);
  });
});

describe('R2: whether a run can be resumed (design 3.2)', () => {
  /** frontier の1つの記録（ページの ID は連番から作る）。 */
  const entry = (sequence: number, state: CrawlUrlState, skipCode: IncompleteReasonCode | null = null) => ({
    url: fixtureUrl(`/page-${sequence}.html`),
    depth: sequence === 1 ? 0 : 1,
    pageId: createPageId(sequence),
    state,
    skipReason: skipCode === null ? null : { code: skipCode, detail: null },
  });
  const frontierOf = (...entries: ReturnType<typeof entry>[]): CrawlFrontierSnapshot => ({ entries });
  const decide = async (
    state: RunCheckpointState,
    safetyViolationDetected: boolean,
    frontier: CrawlFrontierSnapshot,
  ) => {
    const checkpoint = await sampleCheckpoint();
    return decideRunResumption({ state, frontier, progress: { ...checkpoint.progress, safetyViolationDetected } });
  };

  it('requeues the URLs skipped by the runtime limit of one execution and by a stop signal (R4b1)', () => {
    expect(RESUME_REQUEUE_SKIP_REASON_CODES).toEqual(['MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED']);
    expect(Object.isFrozen(RESUME_REQUEUE_SKIP_REASON_CODES)).toBe(true);
  });

  it.each([
    // プロセスが途中で終わった（IN_PROGRESS）: 続きから監査する。
    ['IN_PROGRESS with queued URLs', 'IN_PROGRESS', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'QUEUED')), 'RESUME'],
    ['IN_PROGRESS while a page was being audited', 'IN_PROGRESS', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'AUDITING')), 'RESUME'],
    ['IN_PROGRESS after the last page (only the final processing is left)', 'IN_PROGRESS', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'FAILED')), 'RESUME'],
    // 1回の実行の時間の上限で止まった（STOPPED）: 続きから監査する。
    ['STOPPED by the runtime limit', 'STOPPED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'SKIPPED', 'MAX_RUNTIME_REACHED')), 'RESUME'],
    // 止める印（Ctrl+C など）で止まった（STOPPED。R4b1）: 理由 RUN_INTERRUPTED の SKIPPED だけが残っていても、続きから監査する。
    ['STOPPED by a stop signal with only URLs skipped by RUN_INTERRUPTED', 'STOPPED', false, frontierOf(
      entry(1, 'AUDITED'),
      entry(2, 'SKIPPED', 'RUN_INTERRUPTED'),
      entry(3, 'SKIPPED', 'RUN_INTERRUPTED'),
    ), 'RESUME'],
    ['FINISHED even with URLs skipped by RUN_INTERRUPTED', 'FINISHED', false, frontierOf(
      entry(1, 'AUDITED'),
      entry(2, 'SKIPPED', 'RUN_INTERRUPTED'),
    ), 'NOT_RESUMABLE'],
    ['STOPPED with queued URLs', 'STOPPED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'QUEUED')), 'RESUME'],
    ['STOPPED with a page being audited', 'STOPPED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'AUDITING')), 'RESUME'],
    // STOPPED でも、待ち行列に戻す URL がなければ、再開しない。
    ['STOPPED with only URLs skipped by the page and depth limits', 'STOPPED', false, frontierOf(
      entry(1, 'AUDITED'),
      entry(2, 'SKIPPED', 'MAX_PAGES_REACHED'),
      entry(3, 'SKIPPED', 'MAX_DEPTH_REACHED'),
    ), 'NOT_RESUMABLE'],
    ['STOPPED after every URL was audited', 'STOPPED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'FAILED')), 'NOT_RESUMABLE'],
    // 違反を検出した: 新しいページを始めない。
    ['IN_PROGRESS after a safety violation', 'IN_PROGRESS', true, frontierOf(entry(1, 'AUDITED'), entry(2, 'QUEUED')), 'FINALIZE_ONLY'],
    ['FINISHED after a safety violation', 'FINISHED', true, frontierOf(entry(1, 'AUDITED'), entry(2, 'SKIPPED', 'SAFETY_VIOLATION_ABORT')), 'NOT_RESUMABLE'],
    ['STOPPED after a safety violation (the final processing was done)', 'STOPPED', true, frontierOf(
      entry(1, 'AUDITED'),
      entry(2, 'SKIPPED', 'MAX_RUNTIME_REACHED'),
    ), 'NOT_RESUMABLE'],
    // COMPLETE、ページ数・深さの上限による PARTIAL、FAILED で終わった（FINISHED）: 再開の対象にしない。
    ['FINISHED as COMPLETE', 'FINISHED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'AUDITED')), 'NOT_RESUMABLE'],
    ['FINISHED as PARTIAL by the page limit', 'FINISHED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'SKIPPED', 'MAX_PAGES_REACHED')), 'NOT_RESUMABLE'],
    ['FINISHED as PARTIAL by the depth limit', 'FINISHED', false, frontierOf(entry(1, 'AUDITED'), entry(2, 'SKIPPED', 'MAX_DEPTH_REACHED')), 'NOT_RESUMABLE'],
    ['FINISHED as FAILED', 'FINISHED', false, frontierOf(entry(1, 'FAILED')), 'NOT_RESUMABLE'],
    ['FINISHED even with URLs skipped by the runtime limit', 'FINISHED', false, frontierOf(
      entry(1, 'AUDITED'),
      entry(2, 'SKIPPED', 'MAX_RUNTIME_REACHED'),
    ), 'NOT_RESUMABLE'],
  ] as const)('decides %s', async (_name, state, violation, frontier, expected) => {
    expect(await decide(state, violation, frontier)).toBe(expected);
  });

  it('covers every checkpoint state', () => {
    expect([...RUN_CHECKPOINT_STATES]).toEqual(['IN_PROGRESS', 'STOPPED', 'FINISHED']);
  });
});

describe('R4b1: closing the executions that the previous process left unfinished (design 4.8)', () => {
  const SAVED_AT = '2026-10-01T01:05:00.000Z';
  const environment = runSummary().environment;
  /** 書き換えられる（凍結していない）実行の記録の一覧。 */
  const executionsOf = (): [RunCheckpointExecution, ...RunCheckpointExecution[]] => [
    { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:10:00.000Z', endReason: 'INTERRUPTED_ABNORMALLY', environment },
    { startedAt: '2026-10-01T00:20:00.000Z', finishedAt: '2026-10-01T00:30:00.000Z', endReason: 'STOPPED_BY_SIGNAL', environment },
    { startedAt: '2026-10-01T01:00:00.000Z', finishedAt: null, endReason: null, environment },
  ];

  it('closes only the executions without an end reason, with INTERRUPTED_ABNORMALLY at the saved time, and keeps the others', () => {
    const executions = executionsOf();

    const result = closeInterruptedRunExecutions(executions, SAVED_AT);

    expect(result).toEqual([
      executions[0],
      executions[1],
      { ...executions[2], finishedAt: SAVED_AT, endReason: 'INTERRUPTED_ABNORMALLY' },
    ]);
  });

  it('returns a deeply frozen copy and does not change or freeze the input', () => {
    const executions = executionsOf();
    const before = structuredClone(executions);

    const result = closeInterruptedRunExecutions(executions, SAVED_AT);

    expect(isDeeplyFrozen(result)).toBe(true);
    expect(result).not.toBe(executions);
    expect(executions).toEqual(before);
    expect(Object.isFrozen(executions)).toBe(false);
    expect(executions.some((execution) => Object.isFrozen(execution) || Object.isFrozen(execution.environment))).toBe(false);
  });

  it('returns the same records when every execution has its end reason (a STOPPED checkpoint)', () => {
    const [first, second] = executionsOf();
    const executions: [RunCheckpointExecution, ...RunCheckpointExecution[]] = [first, second as RunCheckpointExecution];

    expect(closeInterruptedRunExecutions(executions, SAVED_AT)).toEqual(executions);
  });

  it('closes the only execution of a checkpoint saved during the first execution', async () => {
    const checkpoint = await sampleCheckpoint();
    const [, last] = checkpoint.executions;

    const result = closeInterruptedRunExecutions([last as RunCheckpointExecution], checkpoint.savedAt);

    expect(result).toEqual([{ ...last, finishedAt: checkpoint.savedAt, endReason: 'INTERRUPTED_ABNORMALLY' }]);
    // 閉じた記録に、この実行の分を加えた保存は、整合の確かめを通る。
    const resumed = withCheckpoint(checkpoint, { executions: [...result, { ...(last as RunCheckpointExecution) }] });
    expect(checkRunCheckpointConsistency(resumed)).toEqual({ ok: true });
  });
});

describe('R4b1: how this execution ended (design 4.8)', () => {
  const decide = (runStatus: RunStatus, ...codes: IncompleteReasonCode[]) =>
    decideRunExecutionEndReason({ runStatus, skipReasonCodes: new Set(codes) });

  it.each([
    ['a safety violation', 'ABORTED_BY_SAFETY', ['SAFETY_VIOLATION_ABORT'], 'STOPPED_BY_SAFETY_VIOLATION'],
    ['the runtime limit of one execution', 'PARTIAL', ['MAX_RUNTIME_REACHED'], 'STOPPED_BY_RUNTIME_LIMIT'],
    ['a stop signal', 'PARTIAL', ['RUN_INTERRUPTED'], 'STOPPED_BY_SIGNAL'],
    ['a complete Run', 'COMPLETE', [], 'COMPLETED'],
    ['the page limit', 'PARTIAL', ['MAX_PAGES_REACHED'], 'COMPLETED'],
    ['a failed save', 'PARTIAL', ['CHECKPOINT_WRITE_FAILED'], 'COMPLETED'],
    ['a failed PREFLIGHT', 'FAILED', [], 'COMPLETED'],
  ] as const)('decides %s', (_name, runStatus, codes, expected) => {
    expect(decide(runStatus, ...codes)).toBe(expected);
  });

  it('checks the safety violation before the runtime limit, and the runtime limit before the stop signal', () => {
    expect(decide('ABORTED_BY_SAFETY', 'MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED')).toBe('STOPPED_BY_SAFETY_VIOLATION');
    expect(decide('ABORTED_BY_SAFETY', 'RUN_INTERRUPTED')).toBe('STOPPED_BY_SAFETY_VIOLATION');
    expect(decide('PARTIAL', 'RUN_INTERRUPTED', 'MAX_RUNTIME_REACHED')).toBe('STOPPED_BY_RUNTIME_LIMIT');
    expect(decide('PARTIAL', 'MAX_PAGES_REACHED', 'RUN_INTERRUPTED')).toBe('STOPPED_BY_SIGNAL');
  });

  it('never decides INTERRUPTED_ABNORMALLY (it only closes an earlier execution)', () => {
    expectTypeOf(decideRunExecutionEndReason).returns.toEqualTypeOf<Exclude<RunExecutionEndReason, 'INTERRUPTED_ABNORMALLY'>>();
    const codes: IncompleteReasonCode[] = ['MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED', 'MAX_PAGES_REACHED'];
    for (const runStatus of RUN_STATUSES) {
      for (let mask = 0; mask < 2 ** codes.length; mask += 1) {
        const subset = codes.filter((_code, index) => (mask & (1 << index)) !== 0);
        expect(decide(runStatus, ...subset)).not.toBe('INTERRUPTED_ABNORMALLY');
      }
    }
  });
});

describe('R4b1: how the checkpoint is concluded after the Run (design 4.3.2)', () => {
  /** 新しい Run が、保存のセッションを始め、保存にすべて成功し、最後まで行った事実。 */
  const facts = (overrides: Partial<RunCheckpointConclusionFacts> = {}): RunCheckpointConclusionFacts => ({
    sessionStarted: true,
    runStatus: 'COMPLETE',
    skipReasonCodes: new Set<IncompleteReasonCode>(),
    checkpointWriteFailed: false,
    resumed: false,
    preflightFailed: false,
    hasWrittenCheckpoint: true,
    ...overrides,
  });
  const codes = (...values: IncompleteReasonCode[]): ReadonlySet<IncompleteReasonCode> => new Set(values);
  const NONE: RunCheckpointConclusion = { action: 'NONE' };
  const ABANDON: RunCheckpointConclusion = { action: 'ABANDON' };
  const finish = (state: 'STOPPED' | 'FINISHED', content: RunCheckpointFinalContent): RunCheckpointConclusion => ({ action: 'FINISH', state, content });

  it('keeps the closed lists of the actions and of the contents of the final state', () => {
    expect([...RUN_CHECKPOINT_CONCLUSION_ACTIONS]).toEqual(['FINISH', 'ABANDON', 'NONE']);
    expect(Object.isFrozen(RUN_CHECKPOINT_CONCLUSION_ACTIONS)).toBe(true);
    expect([...RUN_CHECKPOINT_FINAL_CONTENTS]).toEqual(['CRAWL_END', 'LAST_WRITTEN']);
    expect(Object.isFrozen(RUN_CHECKPOINT_FINAL_CONTENTS)).toBe(true);
    expectTypeOf<RunCheckpointConclusion['action']>().toEqualTypeOf<RunCheckpointConclusionAction>();
    expectTypeOf<Extract<RunCheckpointConclusion, { readonly action: 'FINISH' }>['state']>()
      .toEqualTypeOf<Exclude<RunCheckpointState, 'IN_PROGRESS'>>();
    expectTypeOf<Extract<RunCheckpointConclusion, { readonly action: 'FINISH' }>['content']>().toEqualTypeOf<RunCheckpointFinalContent>();
  });

  it.each([
    // 1. セッションがない、または始めなかった。
    ['no started session', facts({ sessionStarted: false }), NONE],
    ['no started session, even after a violation and a failed save', facts({
      sessionStarted: false,
      runStatus: 'ABORTED_BY_SAFETY',
      checkpointWriteFailed: true,
      hasWrittenCheckpoint: false,
    }), NONE],
    // 2. 違反: 必ず FINISHED。保存に失敗していれば、最後に書けた保存の中身。書けた保存がなければ ABANDON。
    ['a violation', facts({ runStatus: 'ABORTED_BY_SAFETY', skipReasonCodes: codes('SAFETY_VIOLATION_ABORT') }), finish('FINISHED', 'CRAWL_END')],
    ['a violation and a failed save with a written checkpoint', facts({
      runStatus: 'ABORTED_BY_SAFETY',
      checkpointWriteFailed: true,
    }), finish('FINISHED', 'LAST_WRITTEN')],
    ['a violation and a failed save without a written checkpoint', facts({
      runStatus: 'ABORTED_BY_SAFETY',
      checkpointWriteFailed: true,
      hasWrittenCheckpoint: false,
    }), ABANDON],
    ['a violation with the runtime limit and a stop signal (FINISHED, not STOPPED)', facts({
      runStatus: 'ABORTED_BY_SAFETY',
      skipReasonCodes: codes('MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED'),
    }), finish('FINISHED', 'CRAWL_END')],
    ['a violation in a resumed execution whose PREFLIGHT failed', facts({
      runStatus: 'ABORTED_BY_SAFETY',
      resumed: true,
      preflightFailed: true,
    }), finish('FINISHED', 'CRAWL_END')],
    // 3. この実行で、保存に失敗した。
    ['a failed save', facts({ runStatus: 'PARTIAL', skipReasonCodes: codes('CHECKPOINT_WRITE_FAILED'), checkpointWriteFailed: true }), ABANDON],
    ['a failed save with the runtime limit', facts({
      runStatus: 'PARTIAL',
      skipReasonCodes: codes('CHECKPOINT_WRITE_FAILED', 'MAX_RUNTIME_REACHED'),
      checkpointWriteFailed: true,
    }), ABANDON],
    ['a failed save in a resumed execution whose PREFLIGHT failed', facts({
      runStatus: 'FAILED',
      checkpointWriteFailed: true,
      resumed: true,
      preflightFailed: true,
    }), ABANDON],
    // 4. 再開した実行で、PREFLIGHT に失敗した。
    ['a resumed execution whose PREFLIGHT failed', facts({ runStatus: 'FAILED', resumed: true, preflightFailed: true }), ABANDON],
    ['a new Run whose PREFLIGHT failed (nothing was crawled or written)', facts({
      runStatus: 'FAILED',
      preflightFailed: true,
      hasWrittenCheckpoint: false,
    }), finish('FINISHED', 'CRAWL_END')],
    // 5. それ以外: 実行時間の上限と止める印は STOPPED、ほかは FINISHED。
    ['the runtime limit of one execution', facts({ runStatus: 'PARTIAL', skipReasonCodes: codes('MAX_RUNTIME_REACHED') }), finish('STOPPED', 'CRAWL_END')],
    ['a stop signal', facts({ runStatus: 'PARTIAL', skipReasonCodes: codes('RUN_INTERRUPTED') }), finish('STOPPED', 'CRAWL_END')],
    ['a stop signal in a resumed execution', facts({
      runStatus: 'PARTIAL',
      skipReasonCodes: codes('RUN_INTERRUPTED'),
      resumed: true,
    }), finish('STOPPED', 'CRAWL_END')],
    ['the page limit', facts({ runStatus: 'PARTIAL', skipReasonCodes: codes('MAX_PAGES_REACHED') }), finish('FINISHED', 'CRAWL_END')],
    ['a complete Run', facts(), finish('FINISHED', 'CRAWL_END')],
    ['a complete resumed Run', facts({ resumed: true }), finish('FINISHED', 'CRAWL_END')],
    ['a complete Run without a written checkpoint', facts({ hasWrittenCheckpoint: false }), finish('FINISHED', 'CRAWL_END')],
  ] as const)('concludes %s', (_name, input, expected) => {
    const conclusion = decideRunCheckpointConclusion(input);

    expect(conclusion).toEqual(expected);
    expect(Object.isFrozen(conclusion)).toBe(true);
  });

  it('decides STOPPED exactly when this execution ended by the runtime limit or by a stop signal (the same rule as the end reason)', () => {
    const skipCodes: IncompleteReasonCode[] = ['MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED', 'MAX_PAGES_REACHED', 'SAFETY_VIOLATION_ABORT'];
    for (const runStatus of RUN_STATUSES) {
      for (let mask = 0; mask < 2 ** skipCodes.length; mask += 1) {
        const skipReasonCodes = codes(...skipCodes.filter((_code, index) => (mask & (1 << index)) !== 0));
        const endReason = decideRunExecutionEndReason({ runStatus, skipReasonCodes });
        const stopped = endReason === 'STOPPED_BY_RUNTIME_LIMIT' || endReason === 'STOPPED_BY_SIGNAL';
        expect(decideRunCheckpointConclusion(facts({ runStatus, skipReasonCodes }))).toEqual(finish(stopped ? 'STOPPED' : 'FINISHED', 'CRAWL_END'));
      }
    }
  });
});

describe('R2: comparing the effective configurations (design 4.7)', () => {
  const config = (): EffectiveAuditConfig => createTestConfig(FIXTURE_ORIGIN);
  const changed = (change: (value: EffectiveAuditConfig) => void): EffectiveAuditConfig => {
    const value = structuredClone(config());
    change(value);
    return value;
  };
  type Writable<T> = { -readonly [Key in keyof T]: Writable<T[Key]> };
  const writable = (value: EffectiveAuditConfig): Writable<EffectiveAuditConfig> => value as Writable<EffectiveAuditConfig>;

  it('finds no difference between equal configurations, also after one of them went through JSON', () => {
    expect(effectiveConfigDifferences(config(), config())).toEqual([]);
    expect(effectiveConfigDifferences(throughJson(config()), config())).toEqual([]);
  });

  it('returns the path of one different item', () => {
    expect(effectiveConfigDifferences(config(), changed((value) => {
      writable(value).crawl.maxPages += 1;
    }))).toEqual(['crawl.maxPages']);
  });

  it('compares arrays with their order', () => {
    const saved = changed((value) => {
      writable(value).site.allowedOrigins = [FIXTURE_ORIGIN, 'http://127.0.0.1:4174'];
      writable(value).viewports.stressWidths = [320, 768];
    });
    const current = changed((value) => {
      writable(value).site.allowedOrigins = ['http://127.0.0.1:4174', FIXTURE_ORIGIN];
      writable(value).viewports.stressWidths = [768, 320];
    });

    expect(effectiveConfigDifferences(saved, current)).toEqual(['site.allowedOrigins', 'viewports.stressWidths']);
    expect(effectiveConfigDifferences(saved, saved)).toEqual([]);
  });

  it('returns the path of a different nested item', () => {
    expect(effectiveConfigDifferences(config(), changed((value) => {
      writable(value).viewports.primaryDesktop.width += 1;
    }))).toEqual(['viewports.primaryDesktop.width']);
  });

  it('returns every different item in the order of the saved configuration', () => {
    expect(effectiveConfigDifferences(config(), changed((value) => {
      writable(value).output.directory = 'other-output';
      writable(value).browser.headed = true;
    }))).toEqual(['browser.headed', 'output.directory']);
  });

  it('returns the path of an item that only one of them has', () => {
    const saved = changed((value) => {
      (value.audit as unknown as Record<string, unknown>).legacy = true;
    });
    const current = changed((value) => {
      delete (value.crawl as unknown as Record<string, unknown>).maxDepth;
    });

    expect(effectiveConfigDifferences(saved, current)).toEqual(['crawl.maxDepth', 'audit.legacy']);
  });
});

// R2、R5a（設計書 4.7、4.7.1）: 起動の前に比べる版は、BeakSight と Playwright だけである。BeakSight は、Playwright に同梱の Chromium
// だけを使い、Chromium の版は Playwright の版で決まるので、Chromium の版は比べない（`RUN_VERSION_FIELDS` から外した）。
// 違う項目は、保存の値と今の値を添えて返す（CLI が、違う版を示すため。R5a）。
describe('R2: comparing the versions (design 4.7, 4.7.1)', () => {
  const environment = runSummary().environment;
  const sameVersions: RunVersions = { toolVersion: '0.1.0', playwrightVersion: environment.playwrightVersion };

  it('compares the versions of BeakSight and Playwright only, not of Chromium (R5a)', () => {
    expect(RUN_VERSION_FIELDS).toEqual(['toolVersion', 'playwrightVersion']);
    expect(RUN_VERSION_FIELDS).not.toContain('chromiumVersion');
    expect(Object.isFrozen(RUN_VERSION_FIELDS)).toBe(true);
    expectTypeOf<keyof RunVersions>().toEqualTypeOf<'toolVersion' | 'playwrightVersion'>();
    expectTypeOf<RunVersionField>().toEqualTypeOf<'toolVersion' | 'playwrightVersion'>();
  });

  it('finds no difference between the same versions', async () => {
    expect(runVersionDifferences(await sampleCheckpoint(), sameVersions)).toEqual([]);
  });

  it.each([
    ['BeakSight', { ...sameVersions, toolVersion: '0.2.0' }, [{ field: 'toolVersion', saved: '0.1.0', current: '0.2.0' }]],
    ['Playwright', { ...sameVersions, playwrightVersion: '9.9.9' }, [
      { field: 'playwrightVersion', saved: environment.playwrightVersion, current: '9.9.9' },
    ]],
    ['both', { toolVersion: '0.2.0', playwrightVersion: '9.9.9' }, [
      { field: 'toolVersion', saved: '0.1.0', current: '0.2.0' },
      { field: 'playwrightVersion', saved: environment.playwrightVersion, current: '9.9.9' },
    ]],
  ] as const)('returns the version of %s that differs, with the saved and the current value, in the order of the fields', async (_name, current, expected) => {
    const differences = runVersionDifferences(await sampleCheckpoint(), current);

    expect(differences).toEqual(expected);
    expect(isDeeplyFrozen(differences)).toBe(true);
  });

  it.each([
    ['another Chromium', '999.0.0.0'],
    ['a Chromium that could not be launched', null],
  ] as const)('does not count %s of the first execution as a different version (R5a)', async (_name, chromiumVersion) => {
    const checkpoint = await sampleCheckpoint();
    const [first, ...rest] = checkpoint.executions;
    const otherChromium = withCheckpoint(checkpoint, {
      executions: [{ ...first, environment: { ...first.environment, chromiumVersion } }, ...rest],
    });

    expect(runVersionDifferences(otherChromium, sameVersions)).toEqual([]);
  });

  it('compares with the environment of the first execution', async () => {
    const checkpoint = await sampleCheckpoint();
    const [first] = checkpoint.executions;
    const resumed = withCheckpoint(checkpoint, {
      executions: [first, { ...first, environment: { ...first.environment, playwrightVersion: '9.9.9', chromiumVersion: '999.0.0.0' } }],
    });

    expect(runVersionDifferences(resumed, sameVersions)).toEqual([]);
    expect(runVersionDifferences(resumed, { ...sameVersions, playwrightVersion: '9.9.9' })).toEqual([
      { field: 'playwrightVersion', saved: environment.playwrightVersion, current: '9.9.9' },
    ]);
  });
});

// R5a（設計書 4.7.1 の「選び方」）: 再開する Run を選ぶ。同じ対象の Run のうち、最初の実行の開始が最も新しいもの1つだけを候補にし、
// 再開できなければ新しい Run を始め（知らせなし）、設定が違えば違う項目を添えて新しい Run を始め、それ以外は再開する。
describe('R5a: selecting the run to resume (design 4.7.1)', () => {
  const current = (): EffectiveAuditConfig => createTestConfig(FIXTURE_ORIGIN);
  /** 再開できる（`RESUME`）保存（見本の保存は違反を検出しているので、そのフラグを偽にしたもの）。 */
  const resumable = async (): Promise<RunCheckpoint> => {
    const checkpoint = await sampleCheckpoint();
    return withCheckpoint(checkpoint, { progress: { ...checkpoint.progress, safetyViolationDetected: false } });
  };
  /** 終えた（`FINISHED`）保存。 */
  const finished = async (): Promise<RunCheckpoint> => withCheckpoint(await resumable(), { state: 'FINISHED' });
  /** 対象の ID を変えた保存。 */
  const ofTarget = (checkpoint: RunCheckpoint, targetId: string): RunCheckpoint =>
    withCheckpoint(checkpoint, { effectiveConfig: { ...checkpoint.effectiveConfig, target: { id: targetId } } });
  /** 読めた保存の1件（Run の ID は連番から作り、最初の実行の開始を `startedAt` にする）。 */
  const runOf = (sequence: number, checkpoint: RunCheckpoint, startedAt: string): RunResumeCandidate => {
    const runId = createRunId(sequence);
    return { runId, runDirectory: `output/${runId}`, checkpoint: withCheckpoint(checkpoint, { runId, startedAt }) };
  };
  const OLDER = '2026-10-01T00:00:00.000Z';
  const NEWER = '2026-10-02T00:00:00.000Z';
  const NEWEST = '2026-10-03T00:00:00.000Z';

  it('has the closed list of the selections', () => {
    expect(RUN_RESUME_SELECTION_KINDS).toEqual(['START_NEW', 'CONFIG_DIFFERS', 'RESUME']);
    expect(Object.isFrozen(RUN_RESUME_SELECTION_KINDS)).toBe(true);
    expectTypeOf<RunResumeSelection['kind']>().toEqualTypeOf<(typeof RUN_RESUME_SELECTION_KINDS)[number]>();
  });

  it('starts a new Run when no checkpoint could be read', () => {
    expect(selectRunToResume([], current())).toEqual({ kind: 'START_NEW' });
  });

  it('starts a new Run when only runs of other targets are saved, even if they are resumable and newer', async () => {
    const runs = [runOf(1, ofTarget(await resumable(), 'other-target'), NEWEST)];

    expect(decideRunResumption(runs[0]?.checkpoint as RunCheckpoint)).toBe('RESUME');
    expect(selectRunToResume(runs, current())).toEqual({ kind: 'START_NEW' });
  });

  it('resumes the run of the same target whose first execution started last, ignoring newer runs of other targets', async () => {
    const latest = runOf(2, await resumable(), NEWER);
    const runs = [runOf(1, await resumable(), OLDER), latest, runOf(3, ofTarget(await resumable(), 'other-target'), NEWEST)];

    expect(selectRunToResume(runs, current())).toEqual({ kind: 'RESUME', candidate: latest, decision: 'RESUME' });
  });

  it('does not resume an older interrupted run when the latest run of the same target is finished (no notice)', async () => {
    const runs = [runOf(1, await resumable(), OLDER), runOf(2, await finished(), NEWER)];

    expect(selectRunToResume(runs, current())).toEqual({ kind: 'START_NEW' });
  });

  it('starts a new Run with the paths of the different items when the latest run of the same target has another configuration', async () => {
    const checkpoint = await resumable();
    const otherConfig = withCheckpoint(checkpoint, {
      effectiveConfig: { ...checkpoint.effectiveConfig, crawl: { ...checkpoint.effectiveConfig.crawl, maxPages: checkpoint.effectiveConfig.crawl.maxPages + 1 } },
    });
    const latest = runOf(2, otherConfig, NEWER);
    // 設定が同じ古い途中の Run があっても、候補は最も新しいものだけである。
    const runs = [runOf(1, checkpoint, OLDER), latest];

    expect(selectRunToResume(runs, current())).toEqual({ kind: 'CONFIG_DIFFERS', candidate: latest, differences: ['crawl.maxPages'] });
  });

  it('starts a new Run without a notice when the latest run is not resumable, even if its configuration differs', async () => {
    const checkpoint = await finished();
    // 比べる項目（ページ数の上限）を変える（R5-fix-round-1 から、出力先は比べないため）。
    const otherConfig = withCheckpoint(checkpoint, {
      effectiveConfig: { ...checkpoint.effectiveConfig, crawl: { ...checkpoint.effectiveConfig.crawl, maxPages: checkpoint.effectiveConfig.crawl.maxPages + 1 } },
    });

    expect(selectRunToResume([runOf(1, otherConfig, NEWER)], current())).toEqual({ kind: 'START_NEW' });
  });

  // R5-fix-round-1（設計書 4.7。R5b の報告）: 出力先（`output.directory`。`--output` の上書きを含む）は比べない。出力先は途中の Run を探す
  // 場所そのものなので、書き方が違っても（相対のパスと、同じ場所の絶対のパス）、同じ出力先の途中の Run を再開する。比べない項目の一覧は
  // `RESUME_CONFIG_IGNORED_PATHS` で、パスの書き方は `effectiveConfigDifferences` が返すパスと同じ。`--headed`・`--headless` の上書き
  // （`browser.headed`）は、今までどおり比べる。
  describe('R5-fix-round-1: the items of the effective configuration that are not compared (design 4.7)', () => {
    /** 保存の実効の設定の出力先を、同じ場所の絶対のパスに書き換えた保存（今回の設定の出力先は、相対のパス）。 */
    const withAbsoluteOutput = (checkpoint: RunCheckpoint): RunCheckpoint => withCheckpoint(checkpoint, {
      effectiveConfig: { ...checkpoint.effectiveConfig, output: { directory: resolve(checkpoint.effectiveConfig.output.directory) } },
    });

    it('has the closed list of the paths that are not compared, written as effectiveConfigDifferences returns them', () => {
      expect(RESUME_CONFIG_IGNORED_PATHS).toEqual(['output.directory']);
      expect(Object.isFrozen(RESUME_CONFIG_IGNORED_PATHS)).toBe(true);
      const config = current();
      expect(effectiveConfigDifferences(config, { ...config, output: { directory: resolve(config.output.directory) } }))
        .toEqual(RESUME_CONFIG_IGNORED_PATHS);
    });

    it('resumes the latest run whose effective configuration differs only in the output directory', async () => {
      const latest = runOf(1, withAbsoluteOutput(await resumable()), NEWER);
      expect(effectiveConfigDifferences(latest.checkpoint.effectiveConfig, current())).toEqual(['output.directory']);

      expect(selectRunToResume([latest], current())).toEqual({ kind: 'RESUME', candidate: latest, decision: 'RESUME' });
    });

    it('does not resume, without the output directory in the different items, when another item differs too', async () => {
      const checkpoint = withAbsoluteOutput(await resumable());
      const latest = runOf(1, withCheckpoint(checkpoint, {
        effectiveConfig: { ...checkpoint.effectiveConfig, crawl: { ...checkpoint.effectiveConfig.crawl, maxPages: checkpoint.effectiveConfig.crawl.maxPages + 1 } },
      }), NEWER);
      expect(effectiveConfigDifferences(latest.checkpoint.effectiveConfig, current())).toEqual(['crawl.maxPages', 'output.directory']);

      expect(selectRunToResume([latest], current())).toEqual({ kind: 'CONFIG_DIFFERS', candidate: latest, differences: ['crawl.maxPages'] });
    });

    it('still compares the override by --headed and --headless (browser.headed)', async () => {
      const checkpoint = await resumable();
      const latest = runOf(1, withCheckpoint(checkpoint, {
        effectiveConfig: { ...checkpoint.effectiveConfig, browser: { ...checkpoint.effectiveConfig.browser, headed: !checkpoint.effectiveConfig.browser.headed } },
      }), NEWER);

      expect(selectRunToResume([latest], current())).toEqual({ kind: 'CONFIG_DIFFERS', candidate: latest, differences: ['browser.headed'] });
    });
  });

  it('only finalizes the latest run that detected a safety invariant violation (FINALIZE_ONLY)', async () => {
    const violated = await sampleCheckpoint();
    expect(violated.progress.safetyViolationDetected).toBe(true);
    const latest = runOf(1, violated, NEWER);

    expect(selectRunToResume([latest], current())).toEqual({ kind: 'RESUME', candidate: latest, decision: 'FINALIZE_ONLY' });
  });

  it('compares the start of the first execution, not the order of the list or the run ID', async () => {
    // Run の ID が小さく、一覧の後ろにある Run の、最初の実行の開始が最も新しい。
    const latest = runOf(1, await resumable(), NEWEST);
    const runs = [runOf(3, await finished(), NEWER), runOf(2, await finished(), OLDER), latest];

    expect(selectRunToResume(runs, current())).toEqual({ kind: 'RESUME', candidate: latest, decision: 'RESUME' });
  });

  it('takes the run with the larger run ID when the first executions started at the same time', async () => {
    const larger = runOf(2, await resumable(), NEWER);

    expect(selectRunToResume([larger, runOf(1, await finished(), NEWER)], current())).toEqual({ kind: 'RESUME', candidate: larger, decision: 'RESUME' });
    expect(selectRunToResume([runOf(1, await finished(), NEWER), larger], current())).toEqual({ kind: 'RESUME', candidate: larger, decision: 'RESUME' });
  });

  it('returns a frozen selection and does not change the input', async () => {
    const runs = [runOf(1, await resumable(), OLDER), runOf(2, await resumable(), NEWER)];
    const before = structuredClone(runs);

    const selection = selectRunToResume(runs, current());

    expect(Object.isFrozen(selection)).toBe(true);
    expect(runs).toEqual(before);
  });
});

describe('R2: the run lock (design 4.4)', () => {
  const PROCESS_ID = 4242;
  const BOOTED_AT_MS = 1_790_000_000_000;
  const NOW_MS = BOOTED_AT_MS + 3_600_000;
  const lockAt = (heartbeatAtMs: number, overrides: Partial<RunLock> = {}): RunLock => ({
    ...renewRunLock(createRunLock({ processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS, nowMs: heartbeatAtMs - 1 }), heartbeatAtMs),
    ...overrides,
  });
  const judgement = (overrides: Partial<RunLockJudgementInput> = {}): RunLockJudgementInput => ({
    nowMs: NOW_MS,
    bootedAtMs: BOOTED_AT_MS,
    isProcessRunning: () => true,
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the times of design 4.4 (OS boot time tolerance of 120 seconds, heartbeat every minute, stale after 5 minutes)', () => {
    expect(RUN_LOCK_BOOT_TIME_TOLERANCE_MS).toBe(120_000);
    expect(RUN_LOCK_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(RUN_LOCK_STALE_AFTER_MS).toBe(300_000);
    expect(RUN_LOCK_HEARTBEAT_INTERVAL_MS).toBeLessThan(RUN_LOCK_STALE_AFTER_MS);
  });

  it('creates a frozen lock from the process values, acquired and renewed at the current time', () => {
    const lock = createRunLock({ processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS, nowMs: NOW_MS });

    expect(lock).toEqual({ processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS, acquiredAtMs: NOW_MS, heartbeatAtMs: NOW_MS });
    expect(Object.isFrozen(lock)).toBe(true);
    expect(throughJson(lock)).toEqual(lock);
  });

  it('renews only the time of the last update', () => {
    const lock = createRunLock({ processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS, nowMs: NOW_MS });
    const renewed = renewRunLock(lock, NOW_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS);

    expect(renewed).toEqual({ ...lock, heartbeatAtMs: NOW_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS });
    expect(Object.isFrozen(renewed)).toBe(true);
    expect(lock.heartbeatAtMs).toBe(NOW_MS);
  });

  it.each([
    ['a negative process ID', { processId: -1, bootedAtMs: BOOTED_AT_MS, nowMs: NOW_MS }],
    ['process ID 0', { processId: 0, bootedAtMs: BOOTED_AT_MS, nowMs: NOW_MS }],
    ['a fractional time', { processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS, nowMs: NOW_MS + 0.5 }],
    ['a negative boot time', { processId: PROCESS_ID, bootedAtMs: -1, nowMs: NOW_MS }],
  ] as const)('rejects %s when creating a lock', (_name, host) => {
    expect(() => createRunLock(host)).toThrow(RangeError);
  });

  it('reads the values of the current process (process ID and the OS boot time from the uptime)', () => {
    const nowMs = Date.now();
    const host = currentProcessRunLockHost(nowMs);

    expect(host.processId).toBe(process.pid);
    expect(host.nowMs).toBe(nowMs);
    expect(Number.isSafeInteger(host.bootedAtMs)).toBe(true);
    expect(Math.abs(host.bootedAtMs - (nowMs - uptime() * 1000))).toBeLessThan(RUN_LOCK_BOOT_TIME_TOLERANCE_MS);
    expect(judgeRunLock(createRunLock(host), { ...judgement(), nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning })).toBe('ACTIVE');
  });

  it('judges a lock as ACTIVE only when the OS boot time, the process, and the last update all match', () => {
    const isRunning = vi.fn(() => true);

    expect(judgeRunLock(lockAt(NOW_MS - RUN_LOCK_HEARTBEAT_INTERVAL_MS), judgement({ isProcessRunning: isRunning }))).toBe('ACTIVE');
    expect(isRunning).toHaveBeenCalledWith(PROCESS_ID);
  });

  it.each([
    ['later', RUN_LOCK_BOOT_TIME_TOLERANCE_MS + 1],
    ['earlier', -(RUN_LOCK_BOOT_TIME_TOLERANCE_MS + 1)],
  ] as const)('judges a lock as STALE when the OS booted more than 120 seconds %s (the PC was restarted), even if the process ID is running', (_name, offsetMs) => {
    const isRunning = vi.fn(() => true);

    expect(judgeRunLock(lockAt(NOW_MS), judgement({ bootedAtMs: BOOTED_AT_MS + offsetMs, isProcessRunning: isRunning }))).toBe('STALE');
    expect(isRunning).not.toHaveBeenCalled();
  });

  it.each([RUN_LOCK_BOOT_TIME_TOLERANCE_MS, -RUN_LOCK_BOOT_TIME_TOLERANCE_MS])(
    'goes on to the next conditions when the OS boot time differs by exactly %i ms',
    (offsetMs) => {
      const isRunning = vi.fn(() => true);

      expect(judgeRunLock(lockAt(NOW_MS), judgement({ bootedAtMs: BOOTED_AT_MS + offsetMs, isProcessRunning: isRunning }))).toBe('ACTIVE');
      expect(isRunning).toHaveBeenCalledWith(PROCESS_ID);
      expect(judgeRunLock(lockAt(NOW_MS), judgement({ bootedAtMs: BOOTED_AT_MS + offsetMs, isProcessRunning: () => false }))).toBe('STALE');
    },
  );

  it('judges a lock as STALE when its process is not running', () => {
    expect(judgeRunLock(lockAt(NOW_MS), judgement({ isProcessRunning: () => false }))).toBe('STALE');
  });

  it('judges a lock as STALE when its last update is older than 5 minutes, and ACTIVE at exactly 5 minutes', () => {
    expect(judgeRunLock(lockAt(NOW_MS - RUN_LOCK_STALE_AFTER_MS - 1), judgement())).toBe('STALE');
    expect(judgeRunLock(lockAt(NOW_MS - RUN_LOCK_STALE_AFTER_MS), judgement())).toBe('ACTIVE');
  });

  it.each([
    ['null', null],
    ['a string', 'locked'],
    ['an array', [PROCESS_ID]],
    ['an empty object', {}],
    ['a lock without the boot time', (() => {
      const { bootedAtMs: _bootedAtMs, ...rest } = lockAt(NOW_MS);
      return rest;
    })()],
    ['a lock with an extra property', { ...lockAt(NOW_MS), host: 'other' }],
    ['a string process ID', { ...lockAt(NOW_MS), processId: String(PROCESS_ID) }],
    ['process ID 0', lockAt(NOW_MS, { processId: 0 })],
    ['a negative process ID', lockAt(NOW_MS, { processId: -1 })],
    ['a fractional time', lockAt(NOW_MS, { heartbeatAtMs: NOW_MS + 0.5 })],
    ['a negative time', lockAt(NOW_MS, { acquiredAtMs: -1 })],
  ] as const)('judges %s as a STALE lock (it is rebuilt), without asking whether a process is running', (_name, lock) => {
    const isRunning = vi.fn(() => true);

    expect(judgeRunLock(lock, judgement({ isProcessRunning: isRunning }))).toBe('STALE');
    expect(isRunning).not.toHaveBeenCalled();
  });

  it('checks whether a process is running with signal 0, and treats a process of another user (EPERM) as running', () => {
    expect(isProcessRunning(process.pid)).toBe(true);

    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(isProcessRunning(PROCESS_ID)).toBe(false);
    expect(kill).toHaveBeenLastCalledWith(PROCESS_ID, 0);

    kill.mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(isProcessRunning(PROCESS_ID)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])('does not signal process ID %d (0 and negative IDs mean process groups)', (processId) => {
    const kill = vi.spyOn(process, 'kill');

    expect(isProcessRunning(processId)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('R2: closed lists used by the checkpoint', () => {
  it('keeps the execution end reasons of design 4.8', () => {
    expect([...RUN_EXECUTION_END_REASONS]).toEqual([
      'COMPLETED',
      'STOPPED_BY_RUNTIME_LIMIT',
      'STOPPED_BY_SIGNAL',
      'STOPPED_BY_SAFETY_VIOLATION',
      'INTERRUPTED_ABNORMALLY',
    ]);
    expect(Object.isFrozen(RUN_EXECUTION_END_REASONS)).toBe(true);
    expect(Object.isFrozen(RUN_CHECKPOINT_STATES)).toBe(true);
  });
});
