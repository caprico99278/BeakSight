// P14c（Task 14〜17 の設計書 第3章、4.2〜4.5）: Passive の段階の Page Auditor。
// 1回の audit で Desktop と Mobile を順に監査し、Evidence を先にそろえてから page rule を評価する。
// ナビゲーションの失敗、collector の例外と PARTIAL、Rule の評価の失敗、閉じる処理の失敗を、状態と理由で隠さずに記録する。
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import type { AuditRule } from '../../src/audit/rule.js';
import {
  BrowserContextFactory,
  ContextConstructionError,
  type InteractionGuardedSession,
} from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type {
  EvidenceRecord,
  EvidenceRecordFor,
  EvidenceType,
  PageAuditOutcome,
  ViewportProfile,
} from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import {
  COLLECTOR_DEADLINE_MARGIN_MS,
  CONTEXT_CLOSE_TIMEOUT_MS,
  MAX_ERROR_MESSAGE_LENGTH,
  PAGE_CLOSE_TIMEOUT_MS,
  SESSION_OPEN_TIMEOUT_MS,
} from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditAttempt, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import {
  PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE,
  PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
  PassivePageCloseDeadlineError,
} from '../../src/orchestration/passive-session-close.js';
import { PassiveSessionOpenDeadlineError } from '../../src/orchestration/passive-session-open.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer, type FixtureServerOptions } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
const SLOW_RESPONSE_DELAY_MS = 30_000;
const SHORT_NAVIGATION_TIMEOUT_MS = 1_000;
/** 期限のテストで注入する、作成の期限（ms。DEF-008、R15r-4）。実際の期限（`SESSION_OPEN_TIMEOUT_MS`）は待たない。 */
const SHORT_OPEN_DEADLINE_MS = 200;
/** 期限のテストで注入する、閉じる処理の期限（ms。DEF-006、DEF-008、R15r-4）。実際の期限は待たない。 */
const SHORT_CLOSE_DEADLINE_MS = 200;
/** タイマーが少し早く発火する場合の許容（ms）。 */
const TIMER_TOLERANCE_MS = 50;
/** audit() が戻った後に届いた Context と session を閉じ終えるのを待つ上限（ms）。 */
const LATE_RELEASE_TIMEOUT_MS = 10_000;
/** 幅の走査をしない設定（幅の走査を確かめないテストを速くする）。 */
const NO_STRESS_SWEEP: TestConfigOverrides = { viewports: { stressWidths: [] } };
/** 読み込みの後に、メインスレッドを止め続けるページ（R14 の I1）。 */
const BUSY_LOOP_PAGE = '/page-auditor-busy-loop.html';
/** 利用者の操作なしに、GET・HEAD 以外のリクエストを送るページ（R14 の m4）。 */
const NON_READ_REQUESTS_PAGE = '/page-auditor-non-read-requests.html';

let browser: Browser;
const servers: FixtureServer[] = [];
const temporaryDirectories: string[] = [];
/** `beforeAll` で監査した結果のスクリーンショットの置き場所。そのブロックのテストがすべて終わるまで残す。 */
const suiteTemporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  // テストが失敗しても、次のテストに Context を残さない。ただし、黙って閉じるだけにせず、残っていたらテストを失敗にする（R14 の m4）。
  const leftoverContexts = browser.contexts();
  for (const context of leftoverContexts) {
    await context.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
});

afterAll(async () => {
  for (const directory of suiteTemporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  servers.push(server);
  return server;
}

interface AuditRun {
  readonly outcome: PageAuditOutcome;
  readonly config: AuditConfig;
  readonly allocator: IdAllocator;
  readonly screenshotRootDirectory: string;
  /** audit が終わった時点で、ブラウザに残っていた Context の数。 */
  readonly remainingContextCount: number;
}

interface AuditFixtureOptions {
  readonly overrides?: TestConfigOverrides;
  readonly collectors?: PageAuditorDependencies['collectors'];
  readonly createRuleEngine?: PageAuditorDependencies['createRuleEngine'];
  readonly createFactory?: (config: AuditConfig) => BrowserContextFactory;
  /** Context と page の作成・終了の期限の注入（DEF-008、R15r-4）。期限のテストで、短い期限を渡す。 */
  readonly deadlines?: PageAuditorDependencies['deadlines'];
  /** 真なら、スクリーンショットの置き場所を、各テストの後ではなく、ファイルの最後に消す（`beforeAll` で監査する場合）。 */
  readonly keepScreenshotsForSuite?: boolean;
  /**
   * Run の途中で違反が記録されたかを答える関数の注入（C18f。本番では Run Coordinator が、Ledger の登録から答える）。
   * 必須の依存なので、省略した場合は、違反では止めないことを明示する `NEVER_STOP_FOR_SAFETY` を渡す。
   */
  readonly safetyViolationRecorded?: PageAuditorDependencies['safetyViolationRecorded'];
}

/** 違反では止めないことを明示する、違反の確かめ（Page Auditor だけを確かめるテスト用。C18f）。 */
const NEVER_STOP_FOR_SAFETY: PageAuditorDependencies['safetyViolationRecorded'] = () => false;

function normalized(url: string, config: AuditConfig): NormalizedHttpUrlEvidence {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
}

async function auditFixture(server: FixtureServer, pathname: string, options: AuditFixtureOptions = {}): Promise<AuditRun> {
  const config = createTestConfig(server.origin, '/', options.overrides);
  const contextFactory = options.createFactory?.(config)
    ?? new BrowserContextFactory(browser, config, () => new SafetyLedger());
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-page-auditor-'));
  (options.keepScreenshotsForSuite === true ? suiteTemporaryDirectories : temporaryDirectories).push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory,
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    ...(options.createRuleEngine === undefined ? {} : { createRuleEngine: options.createRuleEngine }),
    ...(options.collectors === undefined ? {} : { collectors: options.collectors }),
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
    safetyViolationRecorded: options.safetyViolationRecorded ?? NEVER_STOP_FOR_SAFETY,
  });
  const pageId = allocator.allocatePageId();
  const outcome = await auditor.audit(normalized(`${server.origin}${pathname}`, config), pageId);
  const remainingContextCount = browser.contexts().length;
  // どの監査の後にも、ブラウザに Context が残っていない（R14 の m4）。
  expect(remainingContextCount, 'Contexts left in the browser after audit()').toBe(0);
  return { outcome, config, allocator, screenshotRootDirectory, remainingContextCount };
}

function evidenceOf<TType extends EvidenceType>(
  outcome: PageAuditOutcome,
  type: TType,
  viewport: ViewportProfile,
): EvidenceRecordFor<TType>[] {
  return outcome.result.evidence.filter(
    (record): record is EvidenceRecordFor<TType> & EvidenceRecord => record.type === type && record.viewport === viewport,
  );
}

function evidenceTypesOf(outcome: PageAuditOutcome, viewport: ViewportProfile): EvidenceType[] {
  return [...new Set(outcome.result.evidence.filter((record) => record.viewport === viewport).map((record) => record.type))]
    .sort();
}

function expectDeeplyFrozen(value: unknown, path = 'result'): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeeplyFrozen(child, `${path}.${key}`);
  }
}

describe('PageAuditor on a page with a broken image and console errors (Task 14 Step 1)', () => {
  let run: AuditRun;

  beforeAll(async () => {
    const server = await startServer();
    run = await auditFixture(server, '/js-error.html', { keepScreenshotsForSuite: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('audits Desktop and then Mobile, and both viewports are AUDITED with the navigation facts', () => {
    const { result } = run.outcome;
    const pageUrl = normalized(`${servers[0]?.origin ?? ''}/js-error.html`, run.config);

    expect(result.status).toBe('AUDITED');
    expect(result.pageUrl).toBe(pageUrl);
    expect(result.incompleteReasons).toEqual([]);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toEqual({
        requestedUrl: pageUrl,
        finalUrl: pageUrl,
        httpStatus: 200,
        status: 'AUDITED',
        incompleteReasons: [],
        navigationOutcome: 'OK',
      });
    }
    // Desktop の Evidence が先に採番され、その後に Mobile の Evidence が採番される。
    const viewportsInOrder = result.evidence.map((record) => record.viewport);
    expect(viewportsInOrder.indexOf('mobile')).toBeGreaterThan(viewportsInOrder.lastIndexOf('desktop'));
  });

  it('collects every Passive Evidence type before the rules, and Links only on Desktop', () => {
    const { outcome } = run;
    const passiveTypes: EvidenceType[] = [
      'accessibility', 'color', 'console', 'dom', 'layout', 'network', 'performance', 'safety', 'screenshot', 'scroll',
    ];
    expect(evidenceTypesOf(outcome, 'desktop')).toEqual([...passiveTypes, 'link'].sort());
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual(passiveTypes.sort());
    expect(outcome.result.evidence.every((record) => record.pageId === outcome.result.pageId)).toBe(true);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(evidenceOf(outcome, 'screenshot', viewport).map((record) => record.payload.captureType)).toEqual([
        'VIEWPORT',
        'FULL_PAGE',
      ]);
      expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'console', viewport)[0]?.payload.pageErrors).toHaveLength(1);
    }
    // Evidence の ID は、Run で1つの連番から、重複なく振られる。
    const ids = outcome.result.evidence.map((record) => record.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('creates Findings that reference existing Evidence of the same viewport, with IDs from the allocator', () => {
    const { outcome, allocator } = run;
    const evidenceById = new Map(outcome.result.evidence.map((record) => [record.evidenceId, record]));
    const { findings } = outcome.result;

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.pageId).toBe(outcome.result.pageId);
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of finding.evidenceRefs) {
        expect(evidenceById.get(ref)?.viewport, `${finding.ruleId} ${ref}`).toBe(finding.viewport);
      }
    }
    for (const viewport of ['desktop', 'mobile'] as const) {
      const imageFailure = findings.find((finding) => finding.ruleId === 'IMAGE_LOAD_FAILED' && finding.viewport === viewport);
      expect(imageFailure?.evidenceRefs).toContain(evidenceOf(outcome, 'dom', viewport)[0]?.evidenceId);
      const pageError = findings.find((finding) => finding.ruleId === 'PAGE_ERROR' && finding.viewport === viewport);
      expect(pageError?.evidenceRefs).toEqual([evidenceOf(outcome, 'console', viewport)[0]?.evidenceId]);
      const resource4xx = findings.find((finding) => finding.ruleId === 'RESOURCE_4XX' && finding.viewport === viewport);
      expect(resource4xx?.evidenceRefs).toEqual([evidenceOf(outcome, 'network', viewport)[0]?.evidenceId]);
    }
    const findingIds = findings.map((finding) => finding.findingId);
    expect(new Set(findingIds).size).toBe(findingIds.length);
    // 評価の後に、Finding の連番が採番器に戻されている。
    expect(allocator.nextFindingSequence).toBe(1 + findings.length);
  });

  it('writes the screenshot files that the screenshot Evidence points to', async () => {
    const screenshots = run.outcome.result.evidence.filter((record) => record.type === 'screenshot');
    expect(screenshots).toHaveLength(4);
    for (const record of screenshots) {
      if (record.type !== 'screenshot') continue;
      await expect(access(join(run.screenshotRootDirectory, ...record.payload.relativePath.split('/')))).resolves
        .toBeUndefined();
    }
  });

  it('sweeps the stress widths once on Desktop, without the two primary viewport widths (4.5.6)', () => {
    const { outcome, config } = run;
    const [desktopLayout] = evidenceOf(outcome, 'layout', 'desktop');
    const [mobileLayout] = evidenceOf(outcome, 'layout', 'mobile');
    const primaryWidths = [config.viewports.primaryDesktop.width, config.viewports.primaryMobile.width];
    const expectedWidths = config.viewports.stressWidths.filter((width) => !primaryWidths.includes(width));

    expect(expectedWidths.length).toBeGreaterThan(0);
    expect(expectedWidths.length).toBeLessThan(config.viewports.stressWidths.length);
    expect(desktopLayout?.payload.stressSweep?.map((result) => result.width)).toEqual(expectedWidths);
    expect(desktopLayout?.payload.stressSweep?.every((result) => result.status === 'COMPLETE')).toBe(true);
    expect(mobileLayout?.payload.stressSweep).toBeNull();
  });

  it('records one PASSIVE safety Evidence per Ledger (the Passive Context and each stress sweep session)', () => {
    const { outcome } = run;
    const sweptWidthCount = evidenceOf(outcome, 'layout', 'desktop')[0]?.payload.stressSweep?.length ?? 0;
    const desktopSafety = evidenceOf(outcome, 'safety', 'desktop');
    const mobileSafety = evidenceOf(outcome, 'safety', 'mobile');

    expect(desktopSafety).toHaveLength(1 + sweptWidthCount);
    expect(mobileSafety).toHaveLength(1);
    expect([...desktopSafety, ...mobileSafety].every((record) => record.payload.scope === 'PASSIVE')).toBe(true);
    expect(outcome.safety).toEqual({ invariantViolationCount: 0, invariantViolations: [], recordTruncated: false });
  });

  it('returns a deeply frozen outcome that matches the page schema', async () => {
    expectDeeplyFrozen(run.outcome);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(run.outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  });

  it('closes every Context it created', () => {
    expect(run.remainingContextCount).toBe(0);
  });
});

describe('PageAuditor Desktop and Mobile independence (Task 14 Step 3)', () => {
  it('keeps Desktop AUDITED and records the layout Finding only on Mobile, without hiding it in the page result', async () => {
    const server = await startServer();
    const { outcome, remainingContextCount } = await auditFixture(server, '/mobile-only-overflow.html');
    const { result } = outcome;

    expect(result.viewports.desktop.status).toBe('AUDITED');
    expect(result.viewports.mobile.status).toBe('AUDITED');
    expect(result.status).toBe('AUDITED');

    const overflow = result.findings.filter((finding) => finding.ruleId === 'DOCUMENT_HORIZONTAL_OVERFLOW');
    const [mobileLayout] = evidenceOf(outcome, 'layout', 'mobile');
    const mobileOverflow = overflow.filter((finding) => finding.viewport === 'mobile');
    expect(mobileOverflow).toHaveLength(1);
    expect(mobileOverflow[0]?.evidenceRefs).toEqual([mobileLayout?.evidenceId]);
    // Desktop の主要なビューポートでは、横のはみ出しはない（幅の走査の Finding だけが、幅の情報付きで出る）。
    const desktopOverflow = overflow.filter((finding) => finding.viewport === 'desktop');
    // 幅の走査の 320px では、600px の要素がはみ出す。0件でも真になる `every` の前に、件数を確かめる（R14 の m4）。
    expect(desktopOverflow.length).toBeGreaterThan(0);
    expect(desktopOverflow.every((finding) => finding.message.startsWith('レスポンシブの幅'))).toBe(true);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor navigation failures (4.3.0, 4.5.4)', () => {
  it('marks both viewports FAILED on a navigation timeout and still records the network Evidence', async () => {
    const server = await startServer({ slowResponseDelayMs: SLOW_RESPONSE_DELAY_MS });
    const { outcome, remainingContextCount } = await auditFixture(server, '/__slow', {
      overrides: { ...NO_STRESS_SWEEP, crawl: { navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS } },
    });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: 'TIMEOUT',
        httpStatus: null,
        incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' }],
      });
      const [network] = evidenceOf(outcome, 'network', viewport);
      expect(network?.payload.requests.some((request) => request.url === `${server.origin}/__slow`)).toBe(true);
      expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'safety', viewport)).toHaveLength(1);
      // ナビゲーションが失敗したので、以降の収集はしない。
      for (const type of ['scroll', 'dom', 'layout', 'color', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
        expect(evidenceOf(outcome, type, viewport), `${viewport} ${type}`).toHaveLength(0);
      }
    }
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('marks both viewports FAILED on a blocked external redirect and records the network and safety Evidence', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/index.html` });
    const { outcome, remainingContextCount } = await auditFixture(primary, '/__external-redirect', {
      overrides: NO_STRESS_SWEEP,
    });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    expect(external.getCounters().get).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT',
        incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'BLOCKED_EXTERNAL_REDIRECT' }],
      });
      const [network] = evidenceOf(outcome, 'network', viewport);
      expect(network?.payload.requests.some((request) => request.url === `${primary.origin}/__external-redirect`)).toBe(true);
      const [safety] = evidenceOf(outcome, 'safety', viewport);
      expect(safety?.payload.blockedNavigations).toMatchObject([{ url: `${external.origin}/index.html` }]);
      expect(result.findings.some((finding) =>
        finding.ruleId === 'SAFETY_EXTERNAL_NAVIGATION_BLOCKED' && finding.viewport === viewport)).toBe(true);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  // R15a（設計書 5.6.4）: そのほかの失敗の detail は `FAILED:<Chromium のエラーのコード>`。Run Coordinator は、これで再試行を判断する。
  it('writes FAILED:<Chromium error code> as the detail when nothing listens on the port', async () => {
    // 起動して閉じたサーバの 127.0.0.1 のポートには、何も待ち受けていない。
    const closed = await startServer();
    await closed.close();
    const { outcome, remainingContextCount } = await auditFixture(closed, '/index.html', { overrides: NO_STRESS_SWEEP });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: 'FAILED',
        httpStatus: null,
      });
      // ナビゲーションの失敗の理由は、最初に記録する。ほかの理由（閉じる処理の失敗など）は、この変更の対象ではないので確かめない。
      expect(result.viewports[viewport].incompleteReasons[0])
        .toEqual({ code: 'NAVIGATION_FAILED', detail: 'FAILED:net::ERR_CONNECTION_REFUSED' });
      expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
    }
    expect(result.incompleteReasons[0]).toEqual({ code: 'NAVIGATION_FAILED', detail: 'FAILED:net::ERR_CONNECTION_REFUSED' });
    // DEF-004: 許可した GET のネットワークの層の失敗は、Guard の違反にならない。閉じる処理の失敗の理由も加わらない。
    expect(outcome.safety.invariantViolationCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport].incompleteReasons.map((reason) => reason.code)).not.toContain('UNHANDLED_FAILURE');
    }
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor collector failures (4.5.5)', () => {
  it('records COLLECTOR_INCOMPLETE with <stage>:<reason> when a collector throws, and closes the Context', async () => {
    const server = await startServer();
    let calls = 0;
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      collectors: {
        collectDomEvidence: async () => {
          calls += 1;
          throw new Error('injected DOM collector failure');
        },
      },
    });
    const { result } = outcome;

    expect(calls).toBe(2);
    expect(result.status).toBe('PARTIAL');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'PARTIAL',
        navigationOutcome: 'OK',
        incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'dom:EVALUATION_FAILED' }],
      });
      // 例外を投げた段階の Evidence はなく、ほかの段階の Evidence は記録される。
      expect(evidenceOf(outcome, 'dom', viewport)).toHaveLength(0);
      expect(evidenceOf(outcome, 'layout', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
    }
    expect(result.incompleteReasons).toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail: 'dom:EVALUATION_FAILED' }]);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('records COLLECTOR_INCOMPLETE and keeps the Evidence when a collector returns PARTIAL', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      collectors: {
        collectLayoutEvidence: async (...args: Parameters<typeof collectLayoutEvidence>) => {
          const collected = await collectLayoutEvidence(...args);
          return Object.freeze({ status: 'PARTIAL', reason: 'LAYOUT_COMPARISON_LIMIT_REACHED', layout: collected.layout });
        },
      },
    });

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({
        status: 'PARTIAL',
        incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'layout:LAYOUT_COMPARISON_LIMIT_REACHED' }],
      });
      expect(evidenceOf(outcome, 'layout', viewport)[0]?.payload.primary).toMatchObject({
        status: 'PARTIAL',
        reason: 'LAYOUT_COMPARISON_LIMIT_REACHED',
      });
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('removes the partially written screenshot file when the screenshot stage fails', async () => {
    const server = await startServer();
    const writtenPaths: string[] = [];
    const { outcome, screenshotRootDirectory } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      collectors: {
        captureScreenshots: async (page, paths) => {
          await page.screenshot({ path: paths.viewportCapture.outputPath, type: 'png' });
          writtenPaths.push(paths.viewportCapture.outputPath);
          throw new Error('injected full-page screenshot failure');
        },
      },
    });

    expect(writtenPaths).toHaveLength(2);
    for (const path of writtenPaths) {
      expect(path.startsWith(screenshotRootDirectory)).toBe(true);
      await expect(access(path)).rejects.toThrow();
    }
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([
        { code: 'COLLECTOR_INCOMPLETE', detail: 'screenshot:EVALUATION_FAILED' },
      ]);
      expect(evidenceOf(outcome, 'screenshot', viewport)).toHaveLength(0);
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('marks the viewport FAILED when the renderer process crashes, without waiting for work on the crashed page', async () => {
    const server = await startServer();
    let crashRequests = 0;
    const startedAtMs = Date.now();
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      collectors: {
        // 描画プロセスを落とし、そのまま終わらない collector（crash した page への操作が終わらない場合を再現する）。
        collectColorEvidence: async (page) => {
          crashRequests += 1;
          const session = await page.context().newCDPSession(page);
          void session.send('Page.crash').catch(() => undefined);
          return new Promise<never>(() => undefined);
        },
      },
    });

    expect(crashRequests).toBe(2);
    expect(outcome.result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({ status: 'FAILED', navigationOutcome: 'OK' });
      // crash した段階を1回だけ、`<段階>:PAGE_CRASHED` として記録し（設計書 4.5.4）、それより後の段階（accessibility など）は実行しない。
      expect(outcome.result.viewports[viewport].incompleteReasons.filter((reason) => reason.code === 'COLLECTOR_INCOMPLETE'))
        .toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail: 'color:PAGE_CRASHED' }]);
      for (const type of ['color', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
        expect(evidenceOf(outcome, type, viewport), `${viewport} ${type}`).toHaveLength(0);
      }
      expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
    }
    // ページの期限（overallPageTimeoutMs）まで待たずに終わる。
    expect(Date.now() - startedAtMs).toBeLessThan(createTestConfig(server.origin).crawl.overallPageTimeoutMs);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not run the stages that the settings disable, and does not give them reasons', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: {
        ...NO_STRESS_SWEEP,
        audit: { performance: false, accessibility: false, screenshots: false, interactions: false },
      },
    });

    expect(outcome.result.status).toBe('AUDITED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
      for (const type of ['performance', 'accessibility', 'screenshot'] as const) {
        expect(evidenceOf(outcome, type, viewport), `${viewport} ${type}`).toHaveLength(0);
      }
      expect(evidenceOf(outcome, 'dom', viewport)).toHaveLength(1);
    }
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor rule evaluation and cleanup failures', () => {
  it('marks the viewport PARTIAL with RULE_EVALUATION_FAILED when a page rule fails', async () => {
    const server = await startServer();
    const failingRule: AuditRule = {
      ruleId: 'TEST_FAILING_RULE',
      version: 1,
      category: 'DOM',
      severity: 'WARN',
      evaluate: () => {
        throw new Error('injected rule failure');
      },
    };
    const sequences: number[] = [];
    const { outcome, allocator } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      createRuleEngine: (firstFindingSequence) => {
        sequences.push(firstFindingSequence);
        return new RuleEngine({ targetId: 'test-target', firstFindingSequence, catalog: [failingRule] });
      },
    });

    // 評価のたびに、採番器の連番から新しい RuleEngine を作る。
    expect(sequences).toEqual([1, 1]);
    expect(allocator.nextFindingSequence).toBe(1);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({
        status: 'PARTIAL',
        incompleteReasons: [{ code: 'RULE_EVALUATION_FAILED', detail: 'TEST_FAILING_RULE:injected rule failure' }],
      });
    }
    expect(outcome.result.status).toBe('PARTIAL');
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not hide a failure to close the Passive Context', async () => {
    const server = await startServer();
    class FailingCloseFactory extends BrowserContextFactory {
      override async closePassiveContext(context: BrowserContext): Promise<void> {
        await super.closePassiveContext(context);
        throw new Error('injected Context close failure');
      }
    }
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      createFactory: (config) => new FailingCloseFactory(browser, config, () => new SafetyLedger()),
    });

    expect(remainingContextCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].status).toBe('PARTIAL');
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([
        { code: 'UNHANDLED_FAILURE', detail: 'passive-context-close:injected Context close failure' },
      ]);
    }
  }, AUDIT_TEST_TIMEOUT_MS);
});

// DEF-007: 再試行を区別する情報の形が不正なら、監査を始めずに TypeError を投げる。
describe('PageAuditor attempt argument (DEF-007)', () => {
  it.each([
    ['a zero attempt number', { attempt: 0, precedesRetry: () => false }],
    ['a non-integer attempt number', { attempt: 1.5, precedesRetry: () => false }],
    ['a missing retry decision', { attempt: 1 }],
  ])('rejects %s without opening a Context', async (_label, attempt) => {
    const server = await startServer();
    const config = createTestConfig(server.origin, '/', NO_STRESS_SWEEP);
    const allocator = new IdAllocator();
    const auditor = new PageAuditor({
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger()),
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: tmpdir(),
      safetyViolationRecorded: NEVER_STOP_FOR_SAFETY,
    });

    await expect(auditor.audit(
      normalized(`${server.origin}/index.html`, config),
      allocator.allocatePageId(),
      attempt as unknown as PageAuditAttempt,
    )).rejects.toThrow(TypeError);
    expect(browser.contexts()).toHaveLength(0);
    expect(server.getRequestObservations()).toEqual([]);
  });
});

// DEF-006: page を閉じる処理が終わらない場合は、期限（`PAGE_CLOSE_TIMEOUT_MS`）で見切り、場面 `passive-page-close` の理由として
// 記録してから、Context を閉じる。
// P18c（R15r-4）: 実際の期限（5秒）を待たず、短い期限を注入する。page を閉じ始めてから Context を閉じ始めるまでの時間で、
// 注入した期限で見切ったことを確かめる。
describe('PageAuditor page close deadline (DEF-006)', () => {
  it('records passive-page-close for a page close that does not finish, and still closes the Context', async () => {
    const server = await startServer();
    const pageCloseStartedAt: number[] = [];
    const contextCloseStartedAt: number[] = [];
    class HangingPageCloseFactory extends BrowserContextFactory {
      override async closePassivePage(): Promise<void> {
        pageCloseStartedAt.push(performance.now());
        await new Promise<never>(() => undefined);
      }

      override async closePassiveContext(context: BrowserContext): Promise<void> {
        contextCloseStartedAt.push(performance.now());
        await super.closePassiveContext(context);
      }
    }
    const startedAt = performance.now();
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false, screenshots: false } },
      createFactory: (config) => new HangingPageCloseFactory(browser, config, () => new SafetyLedger()),
      deadlines: { pageCloseTimeoutMs: SHORT_CLOSE_DEADLINE_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(remainingContextCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].status).toBe('PARTIAL');
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([
        { code: 'UNHANDLED_FAILURE', detail: `passive-page-close:${PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE}` },
      ]);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    // 2つのビューポートで、それぞれ注入した期限まで待ってから、Context を閉じる。止まり続けない。
    expect(pageCloseStartedAt).toHaveLength(2);
    expect(contextCloseStartedAt).toHaveLength(2);
    pageCloseStartedAt.forEach((pageCloseAt, index) => {
      const waitedMs = (contextCloseStartedAt[index] ?? Number.NaN) - pageCloseAt;
      expect(waitedMs).toBeGreaterThanOrEqual(SHORT_CLOSE_DEADLINE_MS - TIMER_TOLERANCE_MS);
      expect(waitedMs).toBeLessThan(PAGE_CLOSE_TIMEOUT_MS);
    });
    expect(elapsedMs).toBeLessThan(AUDIT_TEST_TIMEOUT_MS / 2);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P18c（DEF-008。Task 18 の前の整理の設計書 4.2、4.4）: Page Auditor の Context と page の作成・終了と、Interaction の session の
// 作成を、期限付きで待つ。作成の期限切れはビューポートの失敗（`DEADLINE_EXCEEDED`、場面 `passive-context`）、終了の期限切れは
// 閉じる処理の失敗として記録する。遅れて届いた Context と session は閉じる。どのテストも、実際の期限を待たず、短い期限を注入する。
describe('PageAuditor session open and close deadlines (DEF-008)', () => {
  /** 期限を守らない（終わらない処理を待ち続ける）場合に、テストを失敗にする上限。 */
  const DEADLINE_AUDIT_TEST_TIMEOUT_MS = 60_000;
  /** session の作成の期限切れの理由のコード（C18n）。詳細はない。 */
  const SESSION_OPEN_DEADLINE_REASON = 'SESSION_OPEN_DEADLINE';

  it('marks both viewports FAILED with DEADLINE_EXCEEDED when the Passive Context is not created before the deadline', async () => {
    const server = await startServer();
    let contextCalls = 0;
    const startedAt = performance.now();
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(): Promise<BrowserContext> {
          contextCalls += 1;
          return new Promise<never>(() => undefined);
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(contextCalls).toBe(2);
    expect(elapsedMs).toBeLessThan(SESSION_OPEN_TIMEOUT_MS);
    expect(outcome.result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: null,
        incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'passive-context' }],
      });
      // Context がないので、Ledger も Evidence もない。
      expect(outcome.result.evidence.filter((record) => record.viewport === viewport)).toEqual([]);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(server.getRequestObservations()).toEqual([]);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('closes a Passive Context that arrives after the open deadline', async () => {
    const server = await startServer();
    const gate = createDeferred<undefined>();
    let lateContexts = 0;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
          await gate.promise;
          const context = await super.createPassiveContext(viewport);
          lateContexts += 1;
          return context;
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
    });
    expect(outcome.result.viewports.desktop.incompleteReasons)
      .toEqual([{ code: 'DEADLINE_EXCEEDED', detail: 'passive-context' }]);

    // audit() が戻った後に Context が届く。部品が、待たずに閉じる。
    gate.resolve(undefined);
    await expect.poll(() => lateContexts, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(2);
    await expect.poll(() => browser.contexts().length, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(0);
    expect(server.getRequestObservations()).toEqual([]);
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('marks both viewports FAILED and closes the Context when the Passive page is not created before the deadline', async () => {
    const server = await startServer();
    let pageCalls = 0;
    const startedAt = performance.now();
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassivePage(): Promise<Page> {
          pageCalls += 1;
          return new Promise<never>(() => undefined);
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(pageCalls).toBe(2);
    expect(elapsedMs).toBeLessThan(SESSION_OPEN_TIMEOUT_MS);
    expect(remainingContextCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: null,
        incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'passive-context' }],
      });
      // Context はできたので、その Ledger から PASSIVE の safety の Evidence を作る。
      const safety = evidenceOf(outcome, 'safety', viewport);
      expect(safety).toHaveLength(1);
      expect(safety[0]?.payload.scope).toBe('PASSIVE');
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(server.getRequestObservations()).toEqual([]);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('records passive-context-close for a Context close that does not finish, and goes on to the next viewport', async () => {
    const server = await startServer();
    const contextCreateStartedAt: number[] = [];
    const contextCloseStartedAt: number[] = [];
    let auditReturnedAt = Number.NaN;
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false, screenshots: false } },
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
          contextCreateStartedAt.push(performance.now());
          return super.createPassiveContext(viewport);
        }

        // Context は閉じるが、閉じる処理が戻らない。
        override async closePassiveContext(context: BrowserContext): Promise<void> {
          contextCloseStartedAt.push(performance.now());
          await super.closePassiveContext(context);
          await new Promise<never>(() => undefined);
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { contextCloseTimeoutMs: SHORT_CLOSE_DEADLINE_MS },
    }).finally(() => {
      auditReturnedAt = performance.now();
    });

    expect(remainingContextCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].status).toBe('PARTIAL');
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([
        { code: 'UNHANDLED_FAILURE', detail: `passive-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
      ]);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    // Desktop の Context を閉じ始めてから Mobile の Context を作り始めるまでと、Mobile の Context を閉じ始めてから戻るまでは、
    // 注入した期限で見切る。
    expect(contextCreateStartedAt).toHaveLength(2);
    expect(contextCloseStartedAt).toHaveLength(2);
    const waitedMs = [
      (contextCreateStartedAt[1] ?? Number.NaN) - (contextCloseStartedAt[0] ?? Number.NaN),
      auditReturnedAt - (contextCloseStartedAt[1] ?? Number.NaN),
    ];
    for (const waited of waitedMs) {
      expect(waited).toBeGreaterThanOrEqual(SHORT_CLOSE_DEADLINE_MS - TIMER_TOLERANCE_MS);
      expect(waited).toBeLessThan(CONTEXT_CLOSE_TIMEOUT_MS);
    }
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('bounds the stress sweep session open by the page deadline (notAfterMs)', async () => {
    const server = await startServer();
    /** ページの期限。Passive の段階が早く終わるページで、幅の走査の段階に余裕をもって届く長さにする。 */
    const pageTimeoutMs = 4_000;
    let contextCalls = 0;
    const sweep: { deadlineAtMs?: number | undefined; rejectedAt?: number; error?: unknown } = {};
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: {
        viewports: { stressWidths: [320] },
        crawl: { overallPageTimeoutMs: pageTimeoutMs },
        audit: { interactions: false, screenshots: false, performance: false, accessibility: false },
      },
      // 2回目の Context（Desktop の幅の走査のセッション）だけ、作成が戻らない。
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
          contextCalls += 1;
          if (contextCalls === 2) {
            return new Promise<never>(() => undefined);
          }
          return super.createPassiveContext(viewport);
        }
      })(browser, config, () => new SafetyLedger()),
      // 作成の期限そのものは長くして、ページの期限で見切ることを確かめる。
      deadlines: { sessionOpenTimeoutMs: AUDIT_TEST_TIMEOUT_MS },
      collectors: {
        collectStressLayout: async (createSession, _url, widths, options) => {
          sweep.deadlineAtMs = options?.deadlineAtMs;
          try {
            await createSession({ width: widths[0] ?? 320, height: 800 });
          } catch (error) {
            sweep.rejectedAt = Date.now();
            sweep.error = error;
            throw error;
          }
          throw new Error('the stress sweep session must not open');
        },
      },
    });

    expect(sweep.error).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect(sweep.deadlineAtMs).toBeDefined();
    // 幅の走査の期限（ページの期限の範囲の中）で見切る。
    expect(sweep.rejectedAt ?? Number.NaN).toBeGreaterThanOrEqual((sweep.deadlineAtMs ?? Number.NaN) - TIMER_TOLERANCE_MS);
    expect(sweep.rejectedAt ?? Number.NaN).toBeLessThan((sweep.deadlineAtMs ?? Number.NaN) + COLLECTOR_DEADLINE_MARGIN_MS);
    expect(outcome.result.viewports.desktop.incompleteReasons)
      .toContainEqual({ code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:EVALUATION_FAILED' });
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  // RP18r の Minor-2: 幅の走査のセッションを閉じる処理の期限切れを、段階の理由の detail から読み取れるようにする
  // （コードは `COLLECTOR_INCOMPLETE` のまま。detail は `stress-layout:CLOSE_DEADLINE_EXCEEDED`）。
  it('records stress-layout:CLOSE_DEADLINE_EXCEEDED when closing a stress sweep session Context does not finish', async () => {
    const server = await startServer();
    let contextCalls = 0;
    let stressContext: BrowserContext | undefined;
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: {
        viewports: { stressWidths: [320] },
        audit: { interactions: false, screenshots: false, performance: false, accessibility: false },
      },
      // 2回目の Context（Desktop の幅の走査のセッション）だけ、閉じる処理が戻らない（Context は閉じる）。
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
          contextCalls += 1;
          const context = await super.createPassiveContext(viewport);
          if (contextCalls === 2) {
            stressContext = context;
          }
          return context;
        }

        override async closePassiveContext(context: BrowserContext): Promise<void> {
          await super.closePassiveContext(context);
          if (context === stressContext) {
            await new Promise<never>(() => undefined);
          }
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { contextCloseTimeoutMs: SHORT_CLOSE_DEADLINE_MS },
    });

    expect(stressContext).toBeDefined();
    expect(remainingContextCount).toBe(0);
    const reasons = outcome.result.viewports.desktop.incompleteReasons;
    expect(reasons).toContainEqual({ code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:CLOSE_DEADLINE_EXCEEDED' });
    expect(reasons).not.toContainEqual({ code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:EVALUATION_FAILED' });
    expect(outcome.result.viewports.desktop.status).toBe('PARTIAL');
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('records stress-layout:CLOSE_DEADLINE_EXCEEDED for a close deadline inside an AggregateError, and keeps other failures', async () => {
    const server = await startServer();
    const overrides: TestConfigOverrides = {
      viewports: { stressWidths: [320] },
      audit: { interactions: false, screenshots: false, performance: false, accessibility: false },
    };
    const throwingSweep = (error: unknown): PageAuditorDependencies['collectors'] => ({
      collectStressLayout: async () => {
        throw error;
      },
    });

    const cases: readonly (readonly [unknown, string])[] = [
      [new PassivePageCloseDeadlineError(), 'stress-layout:CLOSE_DEADLINE_EXCEEDED'],
      [
        new AggregateError(
          [new Error('work failed'), new AggregateError([new Error('page close failed'), new PassiveContextCloseDeadlineError()])],
          'both failed',
        ),
        'stress-layout:CLOSE_DEADLINE_EXCEEDED',
      ],
      [new AggregateError([new Error('work failed'), new Error('close failed')], 'both failed'), 'stress-layout:EVALUATION_FAILED'],
      [new PassiveSessionOpenDeadlineError('context'), 'stress-layout:EVALUATION_FAILED'],
    ];
    for (const [error, detail] of cases) {
      const { outcome } = await auditFixture(server, '/index.html', { overrides, collectors: throwingSweep(error) });
      const stressReasons = outcome.result.viewports.desktop.incompleteReasons
        .filter((reason) => reason.detail?.startsWith('stress-layout:') === true);
      expect(stressReasons).toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail }]);
    }
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('records NOT_VERIFIABLE (CHECK_NOT_COMPLETED) for candidates whose session is not opened, and closes late sessions', async () => {
    const server = await startServer();
    const gate = createDeferred<undefined>();
    let sessionCalls = 0;
    let lateSessions = 0;
    const startedAt = performance.now();
    const { outcome } = await auditFixture(server, '/accordion.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { screenshots: false } },
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
          sessionCalls += 1;
          await gate.promise;
          const session = await super.createInteractionSession(viewport);
          lateSessions += 1;
          return session;
        }
      })(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    // 候補ごとに、注入した期限で見切る（実際の期限 `SESSION_OPEN_TIMEOUT_MS` を待たない）。
    expect(elapsedMs).toBeLessThan(SESSION_OPEN_TIMEOUT_MS);
    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(sessionCalls).toBeGreaterThan(0);
    expect(interactions).toHaveLength(sessionCalls);
    for (const interaction of interactions) {
      expect(interaction.payload).toMatchObject({
        status: 'NOT_VERIFIABLE',
        notVerifiableKind: 'CHECK_NOT_COMPLETED',
        reason: SESSION_OPEN_DEADLINE_REASON,
        reasonDetail: null,
        lifecycle: { status: 'CLOSED', reason: 'SESSION_NOT_OPENED', reasonDetail: null },
      });
    }
    expect(evidenceOf(outcome, 'safety', 'desktop').filter((record) => record.payload.scope === 'INTERACTION'))
      .toHaveLength(sessionCalls);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });

    // audit() が戻った後に session が届く。待たずに閉じる。
    gate.resolve(undefined);
    await expect.poll(() => lateSessions, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(sessionCalls);
    await expect.poll(() => browser.contexts().length, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(0);
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);

  it('closes the Context of a ContextConstructionError that arrives after the Interaction session open deadline', async () => {
    const server = await startServer();
    const gate = createDeferred<undefined>();
    let sessionCalls = 0;
    let lateFailures = 0;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { outcome } = await auditFixture(server, '/accordion.html', {
        overrides: { ...NO_STRESS_SWEEP, audit: { screenshots: false } },
        createFactory: (config) => new (class extends BrowserContextFactory {
          override async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
            sessionCalls += 1;
            await gate.promise;
            const context = await this.createPassiveContext(viewport);
            lateFailures += 1;
            throw new ContextConstructionError(context, this.getSafetyLedger(context), new Error('late guard failure'));
          }
        })(browser, config, () => new SafetyLedger()),
        deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
      });
      expect(sessionCalls).toBeGreaterThan(0);
      expect(evidenceOf(outcome, 'interaction', 'desktop')
        .map(({ payload }) => ({ reason: payload.reason, reasonDetail: payload.reasonDetail })))
        .toEqual(Array.from({ length: sessionCalls }, () => ({ reason: SESSION_OPEN_DEADLINE_REASON, reasonDetail: null })));

      // audit() が戻った後に、Context を持つ失敗が届く。その Context を閉じる。
      gate.resolve(undefined);
      await expect.poll(() => lateFailures, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(sessionCalls);
      await expect.poll(() => browser.contexts().length, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }, DEADLINE_AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor on an SVG image without intrinsic dimensions (T12b)', () => {
  it('does not report IMAGE_LOAD_FAILED for an SVG image that loaded', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/unsized-svg-image.html', { overrides: NO_STRESS_SWEEP });

    for (const viewport of ['desktop', 'mobile'] as const) {
      const [dom] = evidenceOf(outcome, 'dom', viewport);
      // 2026-09-24 の確認では、Chromium はこの画像の naturalWidth・naturalHeight を 300・150 と報告した（0 ではない）。
      expect(dom?.payload.images).toMatchObject([{ resolvedUrl: `${server.origin}/unsized-image.svg`, complete: true }]);
    }
    expect(outcome.result.findings.filter((finding) => finding.ruleId === 'IMAGE_LOAD_FAILED')).toEqual([]);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14e（R14 の I1、設計書 4.5.7）: ページの期限を守る。メインスレッドが止まったページでも、期限を過ぎたら残りの段階を行わず、
// Context を閉じ、それまでの Evidence で Safety の Evidence を作って Rule を評価して、戻る。
describe('PageAuditor page deadline (R14 I1)', () => {
  /**
   * ページの期限。設計書の例と同じ 6,000ms。Interaction が有効な設定の検証の条件（候補1つの見積もり 2,000 + 2 × 2,000 以上）を
   * ちょうど満たす値である。このテストでは、dom の段階でページの期限に達するので、Interaction の段階（候補の発見を含む）は行わない。
   */
  const SHORT_PAGE_TIMEOUT_MS = 6_000;
  /**
   * `audit()` の所要時間の上限。ビューポート2つの期限（2 × 6,000ms）に、Context を閉じる時間などの余裕を足して、期限の4倍とする。
   * 修正前は、止まったページの dom の段階が戻らず、この上限を超える（テストの時間の上限に達する）。
   */
  const BUSY_LOOP_AUDIT_LIMIT_MS = SHORT_PAGE_TIMEOUT_MS * 4;

  it('returns within a few page deadlines on a page whose main thread stays blocked, with DEADLINE_EXCEEDED', async () => {
    const server = await startServer();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const ruleEvaluations: number[] = [];
      const startedAtMs = Date.now();
      const { outcome } = await auditFixture(server, BUSY_LOOP_PAGE, {
        overrides: {
          ...NO_STRESS_SWEEP,
          crawl: {
            overallPageTimeoutMs: SHORT_PAGE_TIMEOUT_MS,
            navigationTimeoutMs: 2_000,
            interactionTimeoutMs: 2_000,
            // DOM の準備（500ms）と scroll（2,000ms）を早く終え、期限を受け取らない dom の段階で、ページの期限に達するようにする。
            resourceSettlingTimeoutMs: 500,
          },
        },
        createRuleEngine: (firstFindingSequence) => {
          ruleEvaluations.push(firstFindingSequence);
          return new RuleEngine({ targetId: 'test-target', firstFindingSequence });
        },
      });
      const elapsedMs = Date.now() - startedAtMs;

      expect(elapsedMs).toBeLessThan(BUSY_LOOP_AUDIT_LIMIT_MS);
      expect(outcome.result.status).toBe('PARTIAL');
      for (const viewport of ['desktop', 'mobile'] as const) {
        const viewportResult = outcome.result.viewports[viewport];
        expect(viewportResult).toMatchObject({ status: 'PARTIAL', navigationOutcome: 'OK' });
        // 期限を過ぎた段階を1回だけ記録し、残りの段階は実行も記録もしない。
        expect(viewportResult.incompleteReasons.filter((reason) => reason.detail?.endsWith(':DEADLINE_EXCEEDED')))
          .toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail: 'dom:DEADLINE_EXCEEDED' }]);
        for (const type of ['dom', 'layout', 'color', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
          expect(evidenceOf(outcome, type, viewport), `${viewport} ${type}`).toHaveLength(0);
        }
        // それまでに集めた Evidence と、Safety の Evidence は記録する。
        expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
        expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
        expect(evidenceOf(outcome, 'safety', viewport)).toHaveLength(1);
      }
      // Rule は、ビューポートごとに評価する。
      expect(ruleEvaluations).toHaveLength(2);
      await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
        .resolves.toEqual({ ok: true });

      // 期限を過ぎた後に遅れて返る結果や reject は、封じ込める。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }, BUSY_LOOP_AUDIT_LIMIT_MS * 2);
});

// P14e（R14 の I2、設計書 4.3）: 構築に失敗した Context の Ledger も、Safety の Evidence と違反の集計に含める。
describe('PageAuditor Passive Context construction failure (R14 I2)', () => {
  it('includes the Ledger of the Context of ContextConstructionError in the safety Evidence and the safety summary', async () => {
    const server = await startServer();
    /** 最初の Passive Context（Desktop）だけ、Ledger に違反を1件記録してから `ContextConstructionError` を投げる。 */
    class ConstructionFailureFactory extends BrowserContextFactory {
      #failed = false;

      override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
        const context = await super.createPassiveContext(viewport);
        if (this.#failed) {
          return context;
        }
        this.#failed = true;
        this.getSafetyLedger(context).recordInvariantViolation({
          code: 'TEST_CONSTRUCTION_VIOLATION',
          message: 'injected construction violation',
        });
        throw new ContextConstructionError(context, this.getSafetyLedger(context), new Error('injected guard installation failure'));
      }
    }
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
      createFactory: (config) => new ConstructionFailureFactory(browser, config, () => new SafetyLedger()),
    });

    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations).toEqual([
      { code: 'TEST_CONSTRUCTION_VIOLATION', message: 'injected construction violation' },
    ]);
    expect(outcome.result.viewports.desktop.status).toBe('FAILED');
    expect(outcome.result.viewports.desktop.incompleteReasons.map((reason) => reason.code)).toEqual(['UNHANDLED_FAILURE']);
    // 構築に失敗した Context の Ledger から、PASSIVE の safety の Evidence を1つ作る（違反は Evidence に含めない）。
    const desktopSafety = evidenceOf(outcome, 'safety', 'desktop');
    expect(desktopSafety).toHaveLength(1);
    expect(desktopSafety[0]?.payload.scope).toBe('PASSIVE');
    expect(JSON.stringify(outcome.result)).not.toContain('TEST_CONSTRUCTION_VIOLATION');
    expect(outcome.result.viewports.mobile.status).toBe('AUDITED');
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C14x（R14r2 の Minor-1）: Context の構築の失敗の理由（`passive-context:...`）には、`ContextConstructionError` の元の原因
// （`cause`）のメッセージを、上限（`MAX_ERROR_MESSAGE_LENGTH`）付きで含める。
describe('PageAuditor Passive Context construction failure detail (R14r2 Minor-1)', () => {
  const OPEN_LABEL = 'passive-context:';
  it.each([
    ['a short cause message', 'injected guard installation failure'],
    ['a cause message longer than the limit', `long-cause-${'x'.repeat(MAX_ERROR_MESSAGE_LENGTH * 2)}`],
  ])('includes %s of ContextConstructionError in the detail within the limit', async (_label, causeMessage) => {
    const server = await startServer();
    /** 最初の Passive Context（Desktop）だけ、`causeMessage` を原因とする `ContextConstructionError` を投げる。 */
    class ConstructionFailureFactory extends BrowserContextFactory {
      #failed = false;

      override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
        const context = await super.createPassiveContext(viewport);
        if (this.#failed) {
          return context;
        }
        this.#failed = true;
        throw new ContextConstructionError(context, this.getSafetyLedger(context), new Error(causeMessage));
      }
    }
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
      createFactory: (config) => new ConstructionFailureFactory(browser, config, () => new SafetyLedger()),
    });

    const reasons = outcome.result.viewports.desktop.incompleteReasons;
    expect(reasons.map((reason) => reason.code)).toEqual(['UNHANDLED_FAILURE']);
    const detail = reasons[0]?.detail ?? '';
    expect(detail.startsWith(OPEN_LABEL)).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(OPEN_LABEL.length + MAX_ERROR_MESSAGE_LENGTH);
    // 元の原因のメッセージ（長い場合は、その先頭の部分）が、detail に含まれる。
    expect(detail).toContain(causeMessage.slice(0, 64));
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14f（R14r の Important-1、設計書 4.3）: Guard の取り付けに失敗し、Guard が Context を閉じた場合も、その Context の Ledger を、
// Safety の Evidence と違反の集計に含める。Context は残らない（`auditFixture` が確かめる）。
describe('PageAuditor Guard installation failure that closes the Context (R14r Important-1)', () => {
  it('counts GUARD_INSTALLATION_FAILED and records the Desktop safety Evidence on the Passive path', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
      // 1回目の Context は、Desktop の Passive Context である。
      createFactory: (config) => new BrowserContextFactory(browserOpeningPageAfterNewContext(browser, { onlyOnCall: 1 }), config, () => new SafetyLedger()),
    });

    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations.map((violation) => violation.code)).toEqual(['GUARD_INSTALLATION_FAILED']);
    expect(outcome.result.viewports.desktop.status).toBe('FAILED');
    expect(outcome.result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: expect.stringMatching(/^passive-context:/u) as unknown as string },
    ]);
    const desktopSafety = evidenceOf(outcome, 'safety', 'desktop');
    expect(desktopSafety).toHaveLength(1);
    expect(desktopSafety[0]?.payload.scope).toBe('PASSIVE');
    expect(outcome.result.viewports.mobile.status).toBe('AUDITED');
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('counts GUARD_INSTALLATION_FAILED and records the safety Evidence on the stress sweep path', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { viewports: { stressWidths: [320] }, audit: { interactions: false } },
      // 1回目は Desktop の Passive Context、2回目は幅の走査のセッションの Context である。
      createFactory: (config) => new BrowserContextFactory(browserOpeningPageAfterNewContext(browser, { onlyOnCall: 2 }), config, () => new SafetyLedger()),
    });

    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations.map((violation) => violation.code)).toEqual(['GUARD_INSTALLATION_FAILED']);
    // Passive の Context と、幅の走査のセッションの Context の、2つの Ledger から、PASSIVE の safety の Evidence を作る。
    const desktopSafety = evidenceOf(outcome, 'safety', 'desktop');
    expect(desktopSafety).toHaveLength(2);
    expect(desktopSafety.every((record) => record.payload.scope === 'PASSIVE')).toBe(true);
    expect(outcome.result.viewports.desktop.status).toBe('PARTIAL');
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14f（R14r の Minor-2、設計書 4.5.7）: 期限を受け取る collector には、ページの期限から `COLLECTOR_DEADLINE_MARGIN_MS` を引いた時刻を
// 渡す。collector が期限で止まったときの PARTIAL の Evidence を、ページの期限で捨てずに記録する。
describe('PageAuditor collector deadline margin (R14r Minor-2)', () => {
  it('records the PARTIAL Evidence of a collector that stops at the deadline it received', async () => {
    const server = await startServer();
    const pageTimeoutMs = 6_000;
    const receivedDeadlines: number[] = [];
    /** 各ビューポートのページの期限の上限（実際のページの期限は、これ以前である）。 */
    const latestPageDeadlines: number[] = [];
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: {
        ...NO_STRESS_SWEEP,
        crawl: { overallPageTimeoutMs: pageTimeoutMs },
        audit: { interactions: false, performance: false, screenshots: false, accessibility: true },
      },
      collectors: {
        // 受け取った期限まで待ってから、本番の collector を呼ぶ（期限を過ぎているので、PARTIAL の DEADLINE_EXCEEDED を返す）。
        collectAccessibilityEvidence: async (page, options) => {
          const deadlineAtMs = options?.deadlineAtMs ?? Number.NaN;
          receivedDeadlines.push(deadlineAtMs);
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now())));
          return collectAccessibilityEvidence(page, { deadlineAtMs });
        },
      },
      // ページの期限の上限を知るために、Passive Context を作る前の時刻を記録する（ページの期限は、これより前に決まる）。
      createFactory: (config) => new (class extends BrowserContextFactory {
        override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
          latestPageDeadlines.push(Date.now() + pageTimeoutMs);
          return super.createPassiveContext(viewport);
        }
      })(browser, config, () => new SafetyLedger()),
    });

    expect(receivedDeadlines).toHaveLength(2);
    for (const viewport of ['desktop', 'mobile'] as const) {
      const accessibility = evidenceOf(outcome, 'accessibility', viewport);
      expect(accessibility, viewport).toHaveLength(1);
      expect(accessibility[0]?.payload).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
      expect(outcome.result.viewports[viewport]).toMatchObject({ status: 'PARTIAL' });
      expect(outcome.result.viewports[viewport].incompleteReasons).toContainEqual(
        { code: 'COLLECTOR_INCOMPLETE', detail: 'accessibility:DEADLINE_EXCEEDED' },
      );
    }
    // 渡した期限は、ページの期限から、少なくとも余裕の分だけ前である。
    expect(latestPageDeadlines).toHaveLength(2);
    receivedDeadlines.forEach((deadlineAtMs, index) => {
      expect(deadlineAtMs).toBeLessThanOrEqual((latestPageDeadlines[index] ?? Number.NaN) - COLLECTOR_DEADLINE_MARGIN_MS);
    });
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14e（R14 の m4）: Page Auditor を通しても、Passive では GET・HEAD 以外がサーバに届かず、遮断の事実から Finding ができる。
describe('PageAuditor Passive non-read requests (R14 m4)', () => {
  it('does not let POST, sendBeacon, PUT, or DELETE reach the server and creates SAFETY_NON_READ_REQUEST_BLOCKED', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, NON_READ_REQUESTS_PAGE, {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
    });

    const counters = server.getCounters();
    expect(counters.get).toBeGreaterThan(0);
    expect({
      post: counters.post,
      put: counters.put,
      patch: counters.patch,
      delete: counters.delete,
      options: counters.options,
      other: counters.other,
    }).toEqual({ post: 0, put: 0, patch: 0, delete: 0, options: 0, other: 0 });

    for (const viewport of ['desktop', 'mobile'] as const) {
      const safety = evidenceOf(outcome, 'safety', viewport);
      expect(safety).toHaveLength(1);
      const blockedMethods = new Set(safety[0]?.payload.blockedRequests.map((event) => event.method));
      // sendBeacon は POST として送られる。
      expect([...blockedMethods].sort()).toEqual(['DELETE', 'POST', 'PUT']);
      const findings = outcome.result.findings.filter((finding) =>
        finding.ruleId === 'SAFETY_NON_READ_REQUEST_BLOCKED' && finding.viewport === viewport);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.evidenceRefs).toEqual([safety[0]?.evidenceId]);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C18f（Task 19 の前の整理の設計書 4.5、RC18a の指摘2）: 違反を検出した後は、同じページの次のビューポートと、幅の走査の次の幅を
// 始めない。始めなかったビューポートは、理由付きの SKIPPED にする。違反の確かめは、Run Coordinator が注入する関数で行う。
describe('PageAuditor: no new viewport or stress width after a safety invariant violation (C18f, design 4.5)', () => {
  const SAFETY_VIOLATION_ABORT = { code: 'SAFETY_VIOLATION_ABORT', detail: null } as const;

  /** 作った Ledger を覚えておき、どれかに違反があるかを答える（Run Coordinator が、Ledger の登録から答えるのと同じ確かめ方）。 */
  function trackLedgers(): { readonly create: () => SafetyLedger; readonly violationRecorded: () => boolean } {
    const ledgers: SafetyLedger[] = [];
    return {
      create: () => {
        const ledger = new SafetyLedger();
        ledgers.push(ledger);
        return ledger;
      },
      violationRecorded: () => ledgers.some((ledger) => ledger.snapshot().invariantViolationCount > 0),
    };
  }

  /** `violatingCall` 番目（1から数える）に作った Passive Context の Ledger に、違反を1件記録する factory。作った数を数える。 */
  class ViolatingContextFactory extends BrowserContextFactory {
    passiveContexts = 0;
    readonly #violatingCall: number;

    constructor(config: AuditConfig, createLedger: () => SafetyLedger, violatingCall: number) {
      super(browser, config, createLedger);
      this.#violatingCall = violatingCall;
    }

    override async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
      const context = await super.createPassiveContext(viewport);
      this.passiveContexts += 1;
      if (this.passiveContexts === this.#violatingCall) {
        this.getSafetyLedger(context).recordInvariantViolation({ code: 'TEST_INJECTED_VIOLATION', message: 'injected violation' });
      }
      return context;
    }
  }

  it('does not start the Mobile viewport after a violation in Desktop and records it as SKIPPED with SAFETY_VIOLATION_ABORT', async () => {
    const server = await startServer();
    const ledgers = trackLedgers();
    let factory: ViolatingContextFactory | undefined;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
      // 1回目の Context は、Desktop の Passive Context である。
      createFactory: (config) => (factory = new ViolatingContextFactory(config, ledgers.create, 1)),
      safetyViolationRecorded: ledgers.violationRecorded,
    });

    // Mobile の Context は作らない。
    expect(factory?.passiveContexts).toBe(1);
    expect(outcome.result.viewports.desktop.navigationOutcome).toBe('OK');
    expect(outcome.result.viewports.mobile).toEqual({
      requestedUrl: outcome.result.pageUrl,
      finalUrl: null,
      httpStatus: null,
      status: 'SKIPPED',
      incompleteReasons: [SAFETY_VIOLATION_ABORT],
      navigationOutcome: null,
    });
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);
    expect(outcome.result.findings.filter((finding) => finding.viewport === 'mobile')).toEqual([]);
    // 一部のビューポートだけが SKIPPED なので、ページは PARTIAL（`derivePageAuditStatus`）。ページの理由にも残す。
    expect(outcome.result.status).toBe('PARTIAL');
    expect(outcome.result.incompleteReasons).toContainEqual(SAFETY_VIOLATION_ABORT);
    expect(outcome.safety.invariantViolationCount).toBe(1);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not start the next stress width after a violation in a stress session, and records stress-layout:SAFETY_VIOLATION_ABORT', async () => {
    const server = await startServer();
    const ledgers = trackLedgers();
    let factory: ViolatingContextFactory | undefined;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { viewports: { stressWidths: [320, 768] }, audit: { interactions: false } },
      // 1回目は Desktop の Passive Context、2回目は幅の走査の最初の幅（320）のセッションの Context である。
      createFactory: (config) => (factory = new ViolatingContextFactory(config, ledgers.create, 2)),
      safetyViolationRecorded: ledgers.violationRecorded,
    });

    // 2つ目の幅（768）と、Mobile の Context は作らない。
    expect(factory?.passiveContexts).toBe(2);
    expect(outcome.result.viewports.desktop.incompleteReasons).toContainEqual(
      { code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:SAFETY_VIOLATION_ABORT' },
    );
    // 始めた幅の走査のセッションの Ledger は、今までどおり、PASSIVE の safety の Evidence にする。
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(2);
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [SAFETY_VIOLATION_ABORT] });
    expect(outcome.safety.invariantViolationCount).toBe(1);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  // C18i（RC18b の N2）: 幅の走査のセッションの中で違反が起き、Guard がそのセッションの Context を閉じた場合も、段階の理由を
  // `stress-layout:SAFETY_VIOLATION_ABORT` にする（違反で止まったことが分かる理由）。RC18b の再現では、セッションの後始末の失敗から
  // `stress-layout:EVALUATION_FAILED` になっていた。新しい理由のコードは加えない（既存のコードの detail で表す）。
  it('records stress-layout:SAFETY_VIOLATION_ABORT when the Guard closes a stress session Context after a violation inside it', async () => {
    /** 2つ目の page（幅の走査の最初の幅のセッション）だけが、読み込みの初めに外部スキームへ移動するようにする factory。 */
    class ExternalSchemeInStressSessionFactory extends BrowserContextFactory {
      passivePages = 0;

      override async createPassivePage(context: BrowserContext): Promise<Page> {
        const page = await super.createPassivePage(context);
        this.passivePages += 1;
        if (this.passivePages === 2) {
          // headed（headless のブラウザへの注入）では、外部スキームへの移動は違反になり、Guard が Context を閉じる。
          // 宛先は実在しないものである。
          await page.addInitScript({ content: "window.location.href = 'mailto:nobody@example.invalid';" });
        }
        return page;
      }
    }
    const server = await startServer();
    const ledgers = trackLedgers();
    let factory: ExternalSchemeInStressSessionFactory | undefined;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { viewports: { stressWidths: [320] }, audit: { interactions: false }, browser: { headed: true } },
      createFactory: (config) => (factory = new ExternalSchemeInStressSessionFactory(browser, config, ledgers.create)),
      safetyViolationRecorded: ledgers.violationRecorded,
    });

    // Desktop の page と、幅の走査の1つの幅のセッションの page だけを作る（Mobile は、違反の後なので始めない）。
    expect(factory?.passivePages).toBe(2);
    const stressReasons = outcome.result.viewports.desktop.incompleteReasons
      .filter((reason) => reason.detail?.startsWith('stress-layout:') === true);
    expect(stressReasons).toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:SAFETY_VIOLATION_ABORT' }]);
    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [SAFETY_VIOLATION_ABORT] });
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('starts every viewport and stress width when the injected check answers no violation', async () => {
    const server = await startServer();
    const ledgers = trackLedgers();
    let factory: ViolatingContextFactory | undefined;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { viewports: { stressWidths: [320, 768] }, audit: { interactions: false } },
      // 違反を記録しない（0番目の Context はない）。
      createFactory: (config) => (factory = new ViolatingContextFactory(config, ledgers.create, 0)),
      safetyViolationRecorded: ledgers.violationRecorded,
    });

    // Desktop、幅の走査の2つの幅、Mobile。
    expect(factory?.passiveContexts).toBe(4);
    expect(outcome.result.viewports.mobile.status).not.toBe('SKIPPED');
    expect(JSON.stringify(outcome.result)).not.toContain('SAFETY_VIOLATION_ABORT');
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C18f（設計者の判断）: 違反の確かめは、Page Auditor の必須の依存である。渡し忘れると止まらない、という形を残さない。
describe('PageAuditor requires the safety violation check (C18f)', () => {
  it('is a type error and a TypeError to construct a PageAuditor without safetyViolationRecorded', () => {
    const config = createTestConfig('http://127.0.0.1:1', '/');
    const contextFactory = new BrowserContextFactory(browser, config, () => new SafetyLedger());
    const withoutCheck = {
      contextFactory,
      config,
      allocator: new IdAllocator(),
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: tmpdir(),
    };
    // @ts-expect-error: 違反の確かめ（`safetyViolationRecorded`）を渡さないと、型のエラーになる。
    expect(() => new PageAuditor(withoutCheck)).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutCheck, safetyViolationRecorded: 'no' as unknown as () => boolean })).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutCheck, safetyViolationRecorded: NEVER_STOP_FOR_SAFETY })).not.toThrow();
  });
});
