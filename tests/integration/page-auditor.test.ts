// P14c（Task 14〜17 の設計書 第3章、4.2〜4.5）: Passive の段階の Page Auditor。
// 1回の audit で Desktop と Mobile を順に監査し、Evidence を先にそろえてから page rule を評価する。
// ナビゲーションの失敗、collector の例外と PARTIAL、Rule の評価の失敗、閉じる処理の失敗を、状態と理由で隠さずに記録する。
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import {
  BrowserContextFactory,
  ContextConstructionError,
  type InteractionGuardedSession,
} from '../../src/browser/context-factory.js';
import { OLD_HIDDEN_CRAWL_DEFAULTS } from '../../src/config/load-config.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type {
  EvidenceRecord,
  EvidenceRecordFor,
  EvidenceType,
  PageAuditOutcome,
  ViewportProfile,
  PageLoadPhaseRecord,
  ViewportRecheckRecord,
} from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import {
  CONTEXT_CLOSE_TIMEOUT_MS,
  SESSION_OPEN_TIMEOUT_MS,
} from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectStressLayout } from '../../src/evidence/layout-collector.js';
import { isOutsideRunAuditScope } from '../../src/orchestration/authenticated-run.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditAttempt, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-close.js';
import { chromiumNetErrorCode } from '../../src/orchestration/page-navigation.js';
import { isNetworkLayerFailure } from '../../src/safety/network-layer-failure.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer, type FixtureServerOptions } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { TEST_SHORT_AUDIT_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
const SLOW_RESPONSE_DELAY_MS = 30_000;
const SHORT_NAVIGATION_TIMEOUT_MS = 1_000;
/** 期限のテストで注入する、作成の期限（ms。DEF-008、R15r-4）。実際の期限（`SESSION_OPEN_TIMEOUT_MS`）は待たない。 */
const SHORT_OPEN_DEADLINE_MS = 200;
/** 期限のテストで注入する、閉じる処理の期限（ms。DEF-006、DEF-008、R15r-4）。実際の期限は待たない。 */
const SHORT_CLOSE_DEADLINE_MS = 200;
/** タイマーが少し早く発火する場合の許容（ms）。 */
const TIMER_TOLERANCE_MS = 50;
/** T44R2 の I-6: 幅の走査の幅だけ落ち着かない画面の、ページの期限（最初の読み込みを終え、幅の走査に残りの時間の少ない幅を作る長さ）。 */
const STRESS_SETTLE_PAGE_TIMEOUT_MS = 8_000;
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
  const leftoverContexts = testContextsOf(browser);
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
  /** L0: Run の時間の上限の時刻（省略すると渡さない）。 */
  readonly runDeadlineAtMs?: number;
  /** L1: 進みの見張りの反応なしの長さ（省略すると `TEST_PROGRESS_QUIET_LIMIT_MS`）。 */
  readonly progressWatchQuietLimitMs?: number;
}

/** L1: テストの進みの見張りの反応なしの長さ（ms。fixture の各段は、これより十分に短く終わる）。 */
const TEST_PROGRESS_QUIET_LIMIT_MS = 5_000;
/** RB-10: 応答のない読み込みの場面の、見張りの反応なしの長さ（ms）。 */
const NO_RESPONSE_QUIET_LIMIT_MS = 1_500;

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
    ?? new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
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
    navigationPacer: createTestNavigationPacer(config),
    ...(options.createRuleEngine === undefined ? {} : { createRuleEngine: options.createRuleEngine }),
    ...(options.collectors === undefined ? {} : { collectors: options.collectors }),
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
    safetyViolationRecorded: options.safetyViolationRecorded ?? NEVER_STOP_FOR_SAFETY,
    // SD-2: 製品の Run と同じく、点検の範囲（許可 Origin の外）へ移った画面は点検しない。
    isOutsideAuditScope: (target: string) => isOutsideRunAuditScope(target, new Set(config.site.allowedOrigins), null),
    ...(options.runDeadlineAtMs === undefined ? {} : { runDeadlineAtMs: options.runDeadlineAtMs }),
    // L1: 進みの見張りの反応なしの長さ（テストでは短くする。製品は 3 分）。
    progressWatchQuietLimitMs: options.progressWatchQuietLimitMs ?? TEST_PROGRESS_QUIET_LIMIT_MS,
    // RB-10: 落ち着き・スクロール・知らせの枠の待ちを短くする（1 場面 5 秒以内）。
    observationWindows: TEST_SHORT_AUDIT_OBSERVATION_WINDOWS,
  });
  const pageId = allocator.allocatePageId();
  const outcome = await auditor.audit(normalized(`${server.origin}${pathname}`, config), pageId);
  const remainingContextCount = testContextsOf(browser).length;
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

/** AUD-2e: 1 回目の layout の Evidence（確かめ直しの段 `recheck` で集め直した主の layout を除く。幅の走査の結果は 1 回目の Evidence だけが持つ）。 */
function firstPassLayoutOf(outcome: PageAuditOutcome, viewport: ViewportProfile): EvidenceRecordFor<'layout'> | undefined {
  return evidenceOf(outcome, 'layout', viewport).find((record) => record.capture?.phase !== 'recheck');
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
    // SPEC-1: 要求の数（DEF-129・T37R2-fix・DEF-130-fix）は成果物に書かない。
    for (const viewport of ['desktop', 'mobile'] as const) {
      const viewportResult = result.viewports[viewport];
      expect(viewportResult).toEqual({
        requestedUrl: pageUrl,
        finalUrl: pageUrl,
        httpStatus: 200,
        status: 'AUDITED',
        incompleteReasons: [],
        navigationOutcome: 'OK',
        // AUD-2a: 状態 ID と、安定の判定の結果・通知の枠の扱い（この画面に通知の枠はない）。経過と観測の数は揺れるので、形だけを確かめる。
        stateId: `${result.pageId}:${viewport}:1`,
        settling: {
          status: 'SETTLED',
          reason: 'DOM_AND_HEIGHT_STABLE',
          elapsedMs: expect.any(Number) as unknown as number,
          observationCount: expect.any(Number) as unknown as number,
          lastScrollHeight: expect.any(Number) as unknown as number,
          watchEnd: null,
          // AUD-2b: 読み込みの段の移り変わり（最初は DOM の準備、最後は落ち着いた）。
          loadPhases: expect.arrayContaining([
            expect.objectContaining({ phase: 'AFTER_DOM_CONTENT_LOADED' }),
            expect.objectContaining({ phase: 'SETTLED' }),
          ]) as unknown as readonly PageLoadPhaseRecord[],
        },
        notificationHandling: { dismissedCount: 0, hiddenCount: 0, digests: [] },
        // AUD-2d: 落ち着いた後の確かめ直しの表（中身は `page-auditor-recheck.test.ts` で確かめる。ここでは確かめ直したことだけ）。
        recheck: expect.objectContaining({ status: 'RECHECKED', stateId: `${result.pageId}:${viewport}:1` }) as unknown as ViewportRecheckRecord,
      });
    }
    // Desktop の Evidence が先に採番され、その後に Mobile の Evidence が採番される。
    const viewportsInOrder = result.evidence.map((record) => record.viewport);
    expect(viewportsInOrder.indexOf('mobile')).toBeGreaterThan(viewportsInOrder.lastIndexOf('desktop'));
  });

  it('collects every Passive Evidence type before the rules, and Links on every viewport', () => {
    const { outcome } = run;
    // AUD-4d: フォーカスの確かめ（`focus`）も、どのビューポートにもある（ほかの証拠を集め終えた後に読む）。
    // N5: リンクは、どのビューポートでも集める（Mobile にだけあるリンクも辿る）。
    const passiveTypes: EvidenceType[] = [
      'accessibility', 'console', 'dom','focus', 'layout', 'link', 'network', 'performance', 'safety', 'screenshot', 'scroll',
    ];
    expect(evidenceTypesOf(outcome, 'desktop')).toEqual([...passiveTypes].sort());
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([...passiveTypes].sort());
    expect(outcome.result.evidence.every((record) => record.pageId === outcome.result.pageId)).toBe(true);
    for (const viewport of ['desktop', 'mobile'] as const) {
      // AUD-3d: 幅の走査の幅の画像（`stressWidth` を持つ）と、確かめ直しの段の画像（段 `recheck`）は除き、主の画像を見る（下の 'writes the screenshot files' で
      // 数える）。
      expect(evidenceOf(outcome, 'screenshot', viewport)
        .filter((record) => record.payload.stressWidth === undefined && record.capture?.phase !== 'recheck')
        .map((record) => record.payload.captureType)).toEqual([
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
    // 主の画像 4 枚（2 つのビューポート × viewport・全体）と、AUD-3d: 幅の走査の幅ごとの viewport の画像（Desktop だけ。走査した幅の数）と、確かめ直しの段の
    // viewport の画像（ビューポートごとに 1 枚）。
    const layout = evidenceOf(run.outcome, 'layout', 'desktop').find((record) => record.capture?.phase !== 'recheck');
    const sweptWidths = (layout?.payload.stressSweep ?? []).filter((result) => result.layout !== null).map((result) => result.width);
    expect(sweptWidths.length).toBeGreaterThan(0);
    expect(screenshots).toHaveLength(4 + sweptWidths.length + 2);
    expect(screenshots.filter((record) => record.capture?.phase === 'recheck').map((record) => record.viewport)).toEqual(['desktop', 'mobile']);
    expect(screenshots.flatMap((record) => (record.type === 'screenshot' && record.payload.stressWidth !== undefined ? [record.payload.stressWidth] : [])))
      .toEqual(sweptWidths);
    for (const record of screenshots) {
      if (record.type !== 'screenshot') continue;
      await expect(access(join(run.screenshotRootDirectory, ...record.payload.relativePath.split('/')))).resolves
        .toBeUndefined();
    }
  });

  it('sweeps the stress widths once on Desktop, without the two primary viewport widths (4.5.6)', () => {
    const { outcome, config } = run;
    const desktopLayout = firstPassLayoutOf(outcome, 'desktop');
    const mobileLayout = firstPassLayoutOf(outcome, 'mobile');
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
    const sweptWidthCount = firstPassLayoutOf(outcome, 'desktop')?.payload.stressSweep?.length ?? 0;
    const desktopSafety = evidenceOf(outcome, 'safety', 'desktop');
    const mobileSafety = evidenceOf(outcome, 'safety', 'mobile');

    expect(desktopSafety).toHaveLength(1 + sweptWidthCount);
    expect(mobileSafety).toHaveLength(1);
    expect([...desktopSafety, ...mobileSafety].every((record) => record.payload.scope === 'PASSIVE')).toBe(true);
    // 違反がなく、違反にしない止めた記録（SAFE-2 の 4）もない（確かめたい欄だけを見る）。
    expect(outcome.safety).toMatchObject({ invariantViolationCount: 0, invariantViolations: [], frameClassificationFailureCount: 0, readNavigationFailureCount: 0 });
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

describe('PageAuditor on a page whose main container scrolls by itself (DEF-207)', () => {
  it('traverses the inner container, keeps the page AUDITED, and collects the content drawn late at its bottom', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/inner-scroll-late-heading.html', { overrides: NO_STRESS_SWEEP });
    const { result } = outcome;

    expect(result.incompleteReasons).toEqual([]);
    expect(result.status).toBe('AUDITED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport].status).toBe('AUDITED');
      const [scroll] = evidenceOf(outcome, 'scroll', viewport);
      expect(scroll?.payload).toMatchObject({ status: 'COMPLETE', restoration: { status: 'RESTORED' } });
      const [dom] = evidenceOf(outcome, 'dom', viewport);
      expect(dom?.payload.headings.map((heading) => heading.text)).toContain('Late inner heading');
    }
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor navigation failures (4.3.0, 4.5.4)', () => {
  // SU2a（サイトが応答しないときに Run を止める設計書 3.1）: `/__slow` は、遅らせる間、ヘッダを返さない。応答のない時間切れはサイトの
  // 不調なので、Desktop は理由 `SITE_UNAVAILABLE` を加えた FAILED にし、Mobile は始めない（SKIPPED）。両方のビューポートが FAILED に
  // なり、両方に network などの Evidence が残る、という元の確かめは、応答を受けた後の時間切れ（不調ではない）で、
  // `tests/integration/page-auditor-site-unavailability.test.ts` に残した。
  it('marks Desktop FAILED with SITE_UNAVAILABLE on a navigation timeout without a response, records its network Evidence, and skips Mobile', async () => {
    const server = await startServer({ slowResponseDelayMs: SLOW_RESPONSE_DELAY_MS });
    const { outcome, remainingContextCount } = await auditFixture(server, '/__slow', {
      overrides: { ...NO_STRESS_SWEEP, crawl: { navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS } },
      // RB-10: 応答のない読み込みを見放すまでの反応なしの長さを短くする（1 場面 5 秒以内）。
      progressWatchQuietLimitMs: NO_RESPONSE_QUIET_LIMIT_MS,
    });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    expect(result.viewports.desktop).toMatchObject({
      status: 'FAILED',
      navigationOutcome: 'TIMEOUT',
      httpStatus: null,
      // L1: 期待を直した。読み込みの期限（`navigationTimeoutMs`）は撤廃し、進みの見張りが応答のない読み込みを見放す（理由 `STAGE_UNRESPONSIVE` を先に残す）。
      // 見放した読み込みは、前と同じ時間切れの観測で、サイトの不調を判定する。
      incompleteReasons: [
        { code: 'STAGE_UNRESPONSIVE', detail: 'navigation' },
        { code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' },
        { code: 'SITE_UNAVAILABLE', detail: 'passive:TIMEOUT' },
      ],
    });
    const [network] = evidenceOf(outcome, 'network', 'desktop');
    expect(network?.payload.requests.some((request) => request.url === `${server.origin}/__slow`)).toBe(true);
    expect(evidenceOf(outcome, 'console', 'desktop')).toHaveLength(1);
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(1);
    // ナビゲーションが失敗したので、以降の収集はしない。
    for (const type of ['scroll', 'dom', 'layout', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
      expect(evidenceOf(outcome, type, 'desktop'), `desktop ${type}`).toHaveLength(0);
    }
    // Mobile は始めない（理由 `SITE_UNAVAILABLE`、`detail` は `null` の SKIPPED。Evidence はない）。
    expect(result.viewports.mobile).toMatchObject({
      status: 'SKIPPED',
      navigationOutcome: null,
      incompleteReasons: [{ code: 'SITE_UNAVAILABLE', detail: null }],
    });
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('marks both viewports FAILED on an external redirect (not audited) and records the network Evidence', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/index.html` });
    const { outcome, remainingContextCount } = await auditFixture(primary, '/__external-redirect', {
      overrides: NO_STRESS_SWEEP,
    });
    const { result } = outcome;

    // SD-2: Guard は main frame の移動を止めない（外へ届く）。移った画面は点検しない（`BLOCKED_EXTERNAL_REDIRECT`）。
    expect(result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT',
        incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'BLOCKED_EXTERNAL_REDIRECT' }],
      });
      const [network] = evidenceOf(outcome, 'network', viewport);
      expect(network?.payload.requests.some((request) => request.url === `${primary.origin}/__external-redirect`)).toBe(true);
      expect(evidenceOf(outcome, 'dom', viewport)).toHaveLength(0);
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);

  /**
   * 理由が `NAVIGATION_FAILED` で、`detail` が `FAILED:<Chromium のエラーのコード>` の形、かつ、そのコードが網の層の失敗の一覧
   * （`isNetworkLayerFailure`）にあること（DEF-085 fix round 1。中継なしの `net::ERR_CONNECTION_REFUSED` と同じ扱いのコード）。
   */
  const expectNetworkLayerFailureReason = (reason: { readonly code: string; readonly detail: string | null } | undefined): void => {
    expect(reason?.code).toBe('NAVIGATION_FAILED');
    const code = chromiumNetErrorCode(reason?.detail ?? null);
    expect(reason?.detail).toBe(`FAILED:${code ?? ''}`);
    expect(code !== null && isNetworkLayerFailure(code), String(reason?.detail)).toBe(true);
  };

  // R15a（設計書 5.6.4）: そのほかの失敗の detail は `FAILED:<Chromium のエラーのコード>`。Run Coordinator は、これで再試行を判断する。
  // SU2a（サイトが応答しないときに Run を止める設計書 3.1）: 接続の拒否はサイトの不調なので、Mobile は始めない（SKIPPED）。
  it('writes FAILED:<Chromium error code> as the detail when nothing listens on the port', async () => {
    // 起動して閉じたサーバの 127.0.0.1 のポートには、何も待ち受けていない。
    const closed = await startServer();
    await closed.close();
    const { outcome, remainingContextCount } = await auditFixture(closed, '/index.html', { overrides: NO_STRESS_SWEEP });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    expect(result.viewports.desktop).toMatchObject({
      status: 'FAILED',
      navigationOutcome: 'FAILED',
      httpStatus: null,
    });
    // ナビゲーションの失敗の理由は、最初に記録する。ほかの理由（閉じる処理の失敗など）は、この変更の対象ではないので確かめない。
    // DEF-085 fix round 1: Passive の Context は出口の中継を通るので、接続の拒否の Chromium のエラーのコードは、中継が接続を切った
    // コード（`net::ERR_CONNECTION_RESET`）になる。コードの文字列だけを「網の層の失敗の一覧のどれか」で確かめる（形と扱いは変えない）。
    expectNetworkLayerFailureReason(result.viewports.desktop.incompleteReasons[0]);
    expect(evidenceOf(outcome, 'network', 'desktop')).toHaveLength(1);
    expect(result.viewports.mobile).toMatchObject({
      status: 'SKIPPED',
      navigationOutcome: null,
      httpStatus: null,
      incompleteReasons: [{ code: 'SITE_UNAVAILABLE', detail: null }],
    });
    expectNetworkLayerFailureReason(result.incompleteReasons[0]);
    expect(result.incompleteReasons[0]).toEqual(result.viewports.desktop.incompleteReasons[0]);
    // DEF-004: 許可した GET のネットワークの層の失敗は、Guard の違反にならない。閉じる処理の失敗の理由も加わらない。
    expect(outcome.safety.invariantViolationCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport].incompleteReasons.map((reason) => reason.code)).not.toContain('UNHANDLED_FAILURE');
    }
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  }, AUDIT_TEST_TIMEOUT_MS);
});

// RB-10: collector の例外・PARTIAL・設定で外した段は、偽の口の単体（`tests/unit/page-auditor-steps.test.ts`）へ移した。
describe('PageAuditor collector failures (4.5.5)', () => {
  it('removes the partially written screenshot file when the screenshot stage fails', async () => {
    const server = await startServer();
    const writtenPaths: string[] = [];
    const { outcome, screenshotRootDirectory } = await auditFixture(server, '/index.html', {
      overrides: NO_STRESS_SWEEP,
      collectors: {
        // AUD-2c: 撮る画像（`parts`）の書き先に、途中まで書いてから失敗する。
        captureScreenshots: async (page, paths, options) => {
          const outputPath = options?.parts === 'FULL_PAGE' ? paths.fullPageCapture.outputPath : paths.viewportCapture.outputPath;
          await page.screenshot({ path: outputPath, type: 'png' });
          writtenPaths.push(outputPath);
          throw new Error('injected screenshot failure');
        },
      },
    });

    // AUD-2c: viewport の画像と全体の画像を別の回に撮るので、失敗させる collector は、ビューポートごとに 2 回呼ばれる（どちらの回の書きかけも消す）。
    expect(writtenPaths).toHaveLength(4);
    for (const path of writtenPaths) {
      expect(path.startsWith(screenshotRootDirectory)).toBe(true);
      await expect(access(path)).rejects.toThrow();
    }
    for (const viewport of ['desktop', 'mobile'] as const) {
      // AUD-2c: viewport の画像の回と全体の画像の回が、それぞれ失敗を記録する。
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([
        { code: 'COLLECTOR_INCOMPLETE', detail: 'screenshot:EVALUATION_FAILED' },
        { code: 'COLLECTOR_INCOMPLETE', detail: 'screenshot:EVALUATION_FAILED' },
      ]);
      // 失敗させた段の画像は残らない（AUD-3d の続き: 確かめ直しの段の画像は、別の部品で撮るので残る）。
      expect(evidenceOf(outcome, 'screenshot', viewport).filter((record) => record.capture?.phase !== 'recheck')).toHaveLength(0);
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('marks the viewport FAILED when the renderer process crashes, without waiting for work on the crashed page', async () => {
    const server = await startServer();
    let crashRequests = 0;
    const startedAtMs = Date.now();
    // RB-10: crash の事象の代表として、Desktop だけを落とす（Mobile は本物の collector で集め、crash が次のビューポートに及ばないことを見る）。
    const { outcome, remainingContextCount } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false, performance: false } },
      collectors: {
        // 描画プロセスを落とし、そのまま終わらない collector（crash した page への操作が終わらない場合を再現する）。
        collectAccessibilityEvidence: async (page, options) => {
          crashRequests += 1;
          if (crashRequests > 1) {
            return collectAccessibilityEvidence(page, options);
          }
          const session = await page.context().newCDPSession(page);
          void session.send('Page.crash').catch(() => undefined);
          return new Promise<never>(() => undefined);
        },
      },
    });

    // Desktop の crash の 1 回と、Mobile の 1 回目の axe と落ち着いた後の確かめ直しの axe。
    expect(crashRequests).toBe(3);
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.result.viewports.mobile.status).not.toBe('FAILED');
    for (const viewport of ['desktop'] as const) {
      expect(outcome.result.viewports[viewport]).toMatchObject({ status: 'FAILED', navigationOutcome: 'OK' });
      // crash した段階を1回だけ、`<段階>:PAGE_CRASHED` として記録し（設計書 4.5.4）、それより後の段階（accessibility など）は実行しない。
      expect(outcome.result.viewports[viewport].incompleteReasons.filter((reason) => reason.code === 'COLLECTOR_INCOMPLETE'))
        .toEqual([{ code: 'COLLECTOR_INCOMPLETE', detail: 'accessibility:PAGE_CRASHED' }]);
      for (const type of ['accessibility', 'performance', 'link'] as const) {
        expect(evidenceOf(outcome, type, viewport), `${viewport} ${type}`).toHaveLength(0);
      }
      // AUD-2c: viewport の画像は、axe の段（crash させた段）の前に撮るので残る。全体の画像は、crash の後なので撮らない。
      expect(evidenceOf(outcome, 'screenshot', viewport).map((shot) => shot.payload.captureType)).toEqual(['VIEWPORT']);
      expect(evidenceOf(outcome, 'network', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
    }
    // ページの期限（overallPageTimeoutMs）まで待たずに終わる。
    // L14: ページの期限の既定は外した（前の既定の値と比べる）。
    expect(Date.now() - startedAtMs).toBeLessThan(OLD_HIDDEN_CRAWL_DEFAULTS.overallPageTimeoutMs);
    expect(remainingContextCount).toBe(0);
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown))
      .resolves.toEqual({ ok: true });
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
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: tmpdir(),
      navigationPacer: createTestNavigationPacer(config),
      safetyViolationRecorded: NEVER_STOP_FOR_SAFETY,
    });

    await expect(auditor.audit(
      normalized(`${server.origin}/index.html`, config),
      allocator.allocatePageId(),
      attempt as unknown as PageAuditAttempt,
    )).rejects.toThrow(TypeError);
    expect(testContextsOf(browser)).toHaveLength(0);
    expect(server.getRequestObservations()).toEqual([]);
  });
});

// DEF-038（決まりの変更）: page は個別に閉じず、Context と一緒に閉じる。以前は DEF-006 として、page を閉じる処理が終わらない場合は
// 期限（以前の `PAGE_CLOSE_TIMEOUT_MS`）で見切り、場面 `passive-page-close` の理由として記録してから Context を閉じることを確かめていた。
// CCX-21（CC-049）で、page を閉じる処理の期限と、その場面の名前を消した（期限は注入しない）。
// 今は、page を閉じる処理（止まる場合も）を呼ばないので、その理由は記録されず、待たずに Context を閉じることを確かめる。
describe('PageAuditor page close deadline (DEF-006, DEF-038)', () => {
  it('does not close the page by itself, so a page close that does not finish is never waited for, and closes the Context', async () => {
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
    });
    const elapsedMs = performance.now() - startedAt;

    expect(remainingContextCount).toBe(0);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].status).toBe('AUDITED');
      // 場面 `passive-page-close` の理由（以前の DEF-006 の記録）は、もう出ない。
      expect(outcome.result.viewports[viewport].incompleteReasons).toEqual([]);
      expect(JSON.stringify(outcome.result.viewports[viewport].incompleteReasons)).not.toContain('passive-page-close');
    }
    expect(outcome.safety.invariantViolationCount).toBe(0);
    // 2つのビューポートで、page を閉じる処理を呼ばずに、Context を閉じる。止まり続けない。
    expect(pageCloseStartedAt).toEqual([]);
    expect(contextCloseStartedAt).toHaveLength(2);
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
  /** Passive の Context と page の作成の期限切れの理由（ビューポートの失敗）。 */
  const PASSIVE_OPEN_DEADLINE_REASON = { code: 'DEADLINE_EXCEEDED', detail: 'passive-context' } as const;

  /**
   * Passive の Context と page を、監査の前に作っておく factory（DEF-035）。
   * Interaction の session の作成の期限を短くする（`SHORT_OPEN_DEADLINE_MS`）ために注入する `sessionOpenTimeoutMs` は、Page Auditor の
   * Passive の Context と page の作成の期限にも使われる。CPU が混雑すると、Desktop の Passive の作成がこの期限を過ぎ（ビューポートの
   * `DEADLINE_EXCEEDED`、場面 `passive-context`）、Interaction の段階まで進まない（Interaction の session を1つも作らない）。
   * そこで、Passive の Context と page は、監査の前に（期限の外で）本物の部品で作っておき、監査の中の作成の求めには、作っておいたものを
   * 求めの順に返す。監査の中の Passive の作成の期限の判定は、終わった作成を受け取るだけになり、時間に左右されない。
   * Interaction の session の作成（期限を短くして確かめる対象）は変えない。作っておいたものを使い切った後の求めは、本物の部品で作る。
   */
  class PreparedPassiveSessionFactory extends BrowserContextFactory {
    readonly #preparedContexts: { readonly viewport: Viewport; readonly context: BrowserContext }[] = [];
    readonly #preparedPages = new Map<BrowserContext, Page>();

    /** `viewports` の順に、Passive の Context と page を作っておく。Page Auditor は、Desktop、Mobile の順に作成を求める。 */
    async preparePassiveSessions(viewports: readonly Viewport[]): Promise<void> {
      for (const viewport of viewports) {
        const context = await super.createPassiveContext(viewport);
        this.#preparedPages.set(context, await super.createPassivePage(context));
        this.#preparedContexts.push({ viewport, context });
      }
    }

    override async createPassiveContext(
      viewport: Viewport,
      role?: Parameters<BrowserContextFactory['createPassiveContext']>[1],
    ): Promise<BrowserContext> {
      const prepared = this.#preparedContexts.shift();
      if (prepared === undefined) {
        return super.createPassiveContext(viewport, role);
      }
      // 作っておいたものと違う求め（大きさか役割の違い）は、テストの前提の誤りなので、失敗にする（黙って別の Context を使わない）。
      if ((role !== undefined && role !== 'PRIMARY')
        || prepared.viewport.width !== viewport.width
        || prepared.viewport.height !== viewport.height) {
        throw new Error(`the prepared Passive Context (${prepared.viewport.width}x${prepared.viewport.height}) does not match the request`);
      }
      return prepared.context;
    }

    override async createPassivePage(context: BrowserContext): Promise<Page> {
      const page = this.#preparedPages.get(context);
      if (page === undefined) {
        return super.createPassivePage(context);
      }
      this.#preparedPages.delete(context);
      return page;
    }
  }

  // RB-10: 作成の期限切れの代表は下の 1 本（Context はでき page ができない。口が Ledger を渡すことも確かめる）。Context ができない期限切れと、遅れて届いた
  // Context を閉じることは、`tests/unit/passive-session-open.test.ts` と偽の口の単体（`page-auditor-steps.test.ts`）が受け持つ。
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
      })(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
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
      })(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
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

  // RB-10: 閉じる期限切れの代表は上の 1 本（Passive の Context）。幅の走査の閉じる期限切れと失敗の理由の訳は偽の口の単体、候補の session の作成の期限切れ
  // （`SESSION_OPEN_DEADLINE`）は isolated-auditor と passive-session-open の単体が受け持つ。遅れて届く失敗の代表は下の 1 本。
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
      const overrides: TestConfigOverrides = { ...NO_STRESS_SWEEP, audit: { screenshots: false } };
      const config = createTestConfig(server.origin, '/', overrides);
      const factory = new (class extends PreparedPassiveSessionFactory {
        override async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
          sessionCalls += 1;
          await gate.promise;
          // 作っておいた Passive の Context は、監査の中で使い切っている。ここでは本物の部品で、遅れた Context を作る。
          const context = await this.createPassiveContext(viewport);
          lateFailures += 1;
          throw new ContextConstructionError(context, this.getSafetyLedger(context), new Error('late guard failure'));
        }
      })(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      // Passive の Context と page は、期限の外で作っておく（DEF-035。混雑で Interaction の段階まで進まないことを防ぐ）。
      await factory.preparePassiveSessions([config.viewports.primaryDesktop, config.viewports.primaryMobile]);
      const { outcome } = await auditFixture(server, '/accordion.html', {
        overrides,
        createFactory: (auditConfig) => {
          expect(auditConfig).toEqual(config);
          return factory;
        },
        deadlines: { sessionOpenTimeoutMs: SHORT_OPEN_DEADLINE_MS },
      });
      // Desktop の Passive の作成が期限を過ぎていない（過ぎると、Interaction の段階まで進まない。DEF-035）。
      expect(outcome.result.viewports.desktop.incompleteReasons).not.toContainEqual(PASSIVE_OPEN_DEADLINE_REASON);
      expect(sessionCalls).toBeGreaterThan(0);
      expect(evidenceOf(outcome, 'interaction', 'desktop')
        .map(({ payload }) => ({ reason: payload.reason, reasonDetail: payload.reasonDetail })))
        .toEqual(Array.from({ length: sessionCalls }, () => ({ reason: SESSION_OPEN_DEADLINE_REASON, reasonDetail: null })));

      // audit() が戻った後に、Context を持つ失敗が届く。その Context を閉じる。
      gate.resolve(undefined);
      await expect.poll(() => lateFailures, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(sessionCalls);
      await expect.poll(() => testContextsOf(browser).length, { timeout: LATE_RELEASE_TIMEOUT_MS }).toBe(0);
      await wait(20);
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
  /** RB-10: 止まった page の場面の、見張りの反応なしの長さ（ms）。 */
  const BUSY_LOOP_QUIET_LIMIT_MS = 1_500;

  // L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: ページの期限は撤廃し、進みの見張りで終える。期待を直した: 落ち着きの待ちの期限
  // （`resourceSettlingTimeoutMs` 500ms）もなくなったので、止まったページで最初に止まるのは dom の段階ではなく落ち着きの待ち（settling）で、理由は
  // `dom:DEADLINE_EXCEEDED` ではなく `STAGE_UNRESPONSIVE`（`detail` は settling）。反応なしの長さ（テストでは 5 秒）で戻る。
  it('returns within a few quiet limits on a page whose main thread stays blocked, with STAGE_UNRESPONSIVE', async () => {
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
        // RB-10: 止まった page を見放すまでの反応なしの長さを短くする（ビューポート 2 つで 5 秒以内）。
        progressWatchQuietLimitMs: BUSY_LOOP_QUIET_LIMIT_MS,
      });
      const elapsedMs = Date.now() - startedAtMs;

      expect(elapsedMs).toBeLessThan(BUSY_LOOP_AUDIT_LIMIT_MS);
      expect(outcome.result.status).toBe('PARTIAL');
      for (const viewport of ['desktop', 'mobile'] as const) {
        const viewportResult = outcome.result.viewports[viewport];
        expect(viewportResult).toMatchObject({ status: 'PARTIAL', navigationOutcome: 'OK' });
        // 応答しなかった段階を1回だけ記録し、残りの段階は実行も記録もしない。
        expect(viewportResult.incompleteReasons).toEqual([{ code: 'STAGE_UNRESPONSIVE', detail: 'settling' }]);
        for (const type of ['dom', 'layout', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
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
      await wait(200);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }, BUSY_LOOP_AUDIT_LIMIT_MS * 2);

  // RB-10: 止まった main thread の代表は上の 1 本。Run の時間の上限で次のビューポートを始めないことは偽の口の単体、見張りが Run の時間の上限で段を終える
  // ことは `tests/unit/progress-watch.test.ts` が受け持つ。
});

// RB-10: Passive の Context の構築の失敗（Ledger を含めること・原因の全文を理由に書くこと）は、偽の口の単体（`page-auditor-steps.test.ts`）へ移した。Guard が
// Context を閉じる本物の代表は、下の GUARD_INSTALLATION_FAILED の 1 本。

// P14f（R14r の Important-1、設計書 4.3）: Guard の取り付けに失敗し、Guard が Context を閉じた場合も、その Context の Ledger を、
// Safety の Evidence と違反の集計に含める。Context は残らない（`auditFixture` が確かめる）。
describe('PageAuditor Guard installation failure that closes the Context (R14r Important-1)', () => {
  it('counts GUARD_INSTALLATION_FAILED and records the Desktop safety Evidence on the Passive path', async () => {
    const server = await startServer();
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { ...NO_STRESS_SWEEP, audit: { interactions: false } },
      // 1回目の Context は、Desktop の Passive Context である。
      createFactory: (config) => new BrowserContextFactory(browserOpeningPageAfterNewContext(browser, { onlyOnCall: 1 }), config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
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

  // RB-10: 幅の走査の道の GUARD_INSTALLATION_FAILED は、同じ事象（Guard が Context を閉じる）なので上の 1 本に寄せた。collector に期限を渡さず見張りの口を渡す
  // ことは、偽の口の単体へ移した。
});

// T44 P1-5（ユーザーの判断「待ってから測る」）と T44R2 の I-6・M-5: 幅の走査の各幅の読み込みの後に、最初の読み込みと同じ落ち着きの待ち（本物の
// `waitForPageSettled`）を待ってから形を測る。待ちの上限は、その幅の期限から形を測る予備（`STRESS_LAYOUT_MEASURE_RESERVE_MS`）を引いた時刻と、今から
// `crawl.resourceSettlingTimeoutMs` 後の早い方（落ち着かない画面でも、形を測る時間を残す）。ふだんの実行で、この配線を守る。
describe('PageAuditor: the stress sweep waits for the page to settle before measuring each width (P1-5, T44R2 I-6・M-5)', () => {
  it('calls the real settling wait once for each width, after the load and before measuring', async () => {
    const server = await startServer();
    const settled: { readonly width: number; readonly waitedMs: number }[] = [];
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: {
        viewports: { stressWidths: [320, 768] },
        audit: { interactions: false, performance: false, screenshots: false, accessibility: false },
      },
      collectors: {
        collectStressLayout: async (createSession, url, widths, options) => collectStressLayout(createSession, url, widths, {
          ...options,
          settleBeforeLayout: async (page, deadlineAtMs) => {
            const started = Date.now();
            await options.settleBeforeLayout(page, deadlineAtMs);
            settled.push({ width: page.viewportSize()?.width ?? 0, waitedMs: Date.now() - started });
          },
        }),
      },
    });
    const sweep = firstPassLayoutOf(outcome, 'desktop')?.payload.stressSweep ?? [];
    expect(sweep.map(({ width, status }) => `${String(width)} ${status}`)).toEqual(['320 COMPLETE', '768 COMPLETE']);
    expect(settled.map(({ width }) => width)).toEqual([320, 768]);
    // 本物の落ち着きの待ち: 高さが変わらない時間（差し込んだ一式の `pageSettle.stableWindowMs`）を待つ。
    for (const { waitedMs } of settled) {
      expect(waitedMs).toBeGreaterThanOrEqual(TEST_SHORT_AUDIT_OBSERVATION_WINDOWS.pageSettle.stableWindowMs - TIMER_TOLERANCE_MS);
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('settles a width that only keeps growing with no new structure, without waiting for the run time limit (T44R2 I-6, changed by L1 and DEF-245 D)', async () => {
    const server = await startServer();
    const runDeadlineAtMs = Date.now() + STRESS_SETTLE_PAGE_TIMEOUT_MS * 4;
    // 幅 320 だけ落ち着かない画面。落ち着きの待ちの上限（`resourceSettlingTimeoutMs`）を、走査の期限より長くする（残りの時間の少ない幅）。
    const waits: { readonly waitedMs: number; readonly remainingMs: number }[] = [];
    const { outcome } = await auditFixture(server, '/stress-narrow-never-settles.html', {
      overrides: {
        viewports: { stressWidths: [320] },
        crawl: { overallPageTimeoutMs: STRESS_SETTLE_PAGE_TIMEOUT_MS, resourceSettlingTimeoutMs: STRESS_SETTLE_PAGE_TIMEOUT_MS * 10 },
        audit: { interactions: false, performance: false, screenshots: false, accessibility: false },
      },
      collectors: {
        collectStressLayout: async (createSession, url, widths, options) => collectStressLayout(createSession, url, widths, {
          ...options,
          settleBeforeLayout: async (page, deadlineAtMs) => {
            const started = Date.now();
            await options.settleBeforeLayout(page, deadlineAtMs);
            waits.push({ waitedMs: Date.now() - started, remainingMs: deadlineAtMs - Date.now() });
          },
        }),
      },
      runDeadlineAtMs,
    });
    // DEF-245 の D（設計者の判断 2026-11-11）: 期待を直した。この画面は、新しい作りの印が出ないまま高さだけが伸び続ける（同じ要素の高さが伸びるだけ）ので、
    // 静まったとみなし、Run の時間の上限を待たずに、その幅を測る（網羅は作りの印で決める）。
    expect(waits).toHaveLength(1);
    expect(waits[0]?.waitedMs).toBeLessThan(STRESS_SETTLE_PAGE_TIMEOUT_MS);
    expect(outcome.result.viewports.desktop.incompleteReasons.filter(({ detail }) => detail?.startsWith('stress-layout:') === true)).toEqual([]);
    const [sweep] = firstPassLayoutOf(outcome, 'desktop')?.payload.stressSweep ?? [];
    expect(sweep?.width).toBe(320);
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

  // RB-10: Desktop・幅の走査の中の違反で次を始めない順と、違反がなければ全部を始めることは、偽の口の単体（`page-auditor-steps.test.ts`）へ移した。
  // C18i（RC18b の N2）: 幅の走査のセッションの中で違反が起き、Guard がそのセッションの Context を閉じた場合も、段階の理由を
  // `stress-layout:SAFETY_VIOLATION_ABORT` にする（違反で止まったことが分かる理由）。RC18b の再現では、セッションの後始末の失敗から
  // `stress-layout:EVALUATION_FAILED` になっていた。新しい理由のコードは加えない（既存のコードの detail で表す）。
  it('records stress-layout:SAFETY_VIOLATION_ABORT when the Guard closes a stress session Context after a violation inside it', async () => {
    /** 2つ目の page（幅の走査の最初の幅のセッション）だけが、読み込みの後にポップアップを開くようにする factory。 */
    class ExternalSchemeInStressSessionFactory extends BrowserContextFactory {
      passivePages = 0;

      override async createPassivePage(context: BrowserContext): Promise<Page> {
        const page = await super.createPassivePage(context);
        this.passivePages += 1;
        if (this.passivePages === 2) {
          // SAFE-2 の 4 の後: 外部スキームへの移動は違反でなくなった（止めた記録だけ）。違反のきっかけは、CDP の付いていない page の要求
          // （DEF-113。`window.open` のポップアップ）にする。Guard が止め、Context を閉じる。
          await page.addInitScript({ content: "window.addEventListener('load', () => { setTimeout(() => { window.open('/popup-x.html'); }, 0); });" });
        }
        return page;
      }
    }
    const server = await startServer();
    const ledgers = trackLedgers();
    let factory: ExternalSchemeInStressSessionFactory | undefined;
    const { outcome } = await auditFixture(server, '/index.html', {
      overrides: { viewports: { stressWidths: [320] }, audit: { interactions: false } },
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

  // DEF-247: 幅の走査の page が読み込みの初めに外部スキーム（mailto）へ移ろうとした幅は、その記録で幅を終える（DEF-245 の続きの C）。終えるときは、page だけを
  // 閉じず、その幅の session の口で Context ごと閉じるので、Guard が印のない session の切れを違反にしない（違反 0 で、Mobile も続ける）。
  it('ends a stress width whose page tries an external scheme without a violation (DEF-247)', async () => {
    const server = await startServer();
    // 読み込みの後に、ページ自身が mailto へ移ろうとする画面（GATE-S03 と同じ画面。どの読み込みでも試みる）。
    const { outcome } = await auditFixture(server, '/external-scheme-navigation.html?via=location-href&to=mailto', {
      overrides: { crawl: { allowedQueryParameters: ['via', 'to'] }, viewports: { stressWidths: [320] }, audit: { interactions: false } },
    });

    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(outcome.result.viewports.mobile.status).not.toBe('SKIPPED');
    // DEF-250 の c: Desktop の page が mailto へ移ろうとした後は、残りの段を始めずにビューポートを終える（CLI の Chromium で誤りの画面に替わっても、見張りの
    // 時間切れを待たない）。理由は、外部スキームの移動として残る。
    const desktopCodes = outcome.result.viewports.desktop.incompleteReasons.map(({ code }) => code);
    expect(desktopCodes).not.toContain('STAGE_UNRESPONSIVE');
    expect(desktopCodes).toContain('DOCUMENT_LEFT_DURING_AUDIT');
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C18f（設計者の判断）: 違反の確かめは、Page Auditor の必須の依存である。渡し忘れると止まらない、という形を残さない。
describe('PageAuditor requires the safety violation check (C18f)', () => {
  it('is a type error and a TypeError to construct a PageAuditor without safetyViolationRecorded', () => {
    const config = createTestConfig('http://127.0.0.1:1', '/');
    const contextFactory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const withoutCheck = {
      contextFactory,
      config,
      allocator: new IdAllocator(),
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: tmpdir(),
      navigationPacer: createTestNavigationPacer(config),
    };
    // @ts-expect-error: 違反の確かめ（`safetyViolationRecorded`）を渡さないと、型のエラーになる。
    expect(() => new PageAuditor(withoutCheck)).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutCheck, safetyViolationRecorded: 'no' as unknown as () => boolean })).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutCheck, safetyViolationRecorded: NEVER_STOP_FOR_SAFETY })).not.toThrow();
  });
});

// L2（サイトへの負荷の制御の設計書 4.1）: ページの読み込みの間隔を守る部品は、Page Auditor の必須の依存である。渡し忘れると、
// 間隔を空けずに読み込む、という形を残さない。
describe('PageAuditor requires the navigation pacer (load control design 4.1)', () => {
  it('is a type error and a TypeError to construct a PageAuditor without a navigation pacer', () => {
    const config = createTestConfig('http://127.0.0.1:1', '/');
    const withoutPacer = {
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
      config,
      allocator: new IdAllocator(),
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: tmpdir(),
      safetyViolationRecorded: NEVER_STOP_FOR_SAFETY,
    };
    // @ts-expect-error: ページの読み込みの間隔を守る部品（`navigationPacer`）を渡さないと、型のエラーになる。
    expect(() => new PageAuditor(withoutPacer)).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutPacer, navigationPacer: {} as unknown as NavigationPacer })).toThrow(TypeError);
    expect(() => new PageAuditor({ ...withoutPacer, navigationPacer: createTestNavigationPacer(config) })).not.toThrow();
  });
});
