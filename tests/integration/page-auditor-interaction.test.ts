// P14d（Task 14〜17 の設計書 4.3、4.3.1、4.5.2 の手順5、4.5.7、4.5.8）: Page Auditor の Interaction の段階。
// Desktop だけで、設定で有効な場合に、Passive の page で候補を見つけ、除外されるものも含めてすべて `auditInteraction` に渡す。
// 候補ごとの結果を `interaction` の Evidence に、Safety の snapshot を INTERACTION の safety の Evidence と違反の集計に使い、
// その後で page rule を評価する。予算の不足、候補の発見の上限、後片付けの失敗は、PARTIAL と理由で隠さずに記録する。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
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
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
/** 幅の走査・performance・accessibility・スクリーンショットをしない設定（Interaction の段階を確かめるテストを速くする）。 */
const INTERACTION_ONLY: TestConfigOverrides = {
  viewports: { stressWidths: [] },
  audit: { performance: false, accessibility: false, screenshots: false, interactions: true },
};
const TOGGLE_PAGE = '/page-auditor-interaction-toggle.html';
const EXCLUSIONS_PAGE = '/page-auditor-interaction-exclusions.html';
const MANY_TOGGLES_PAGE = '/page-auditor-interaction-many-toggles.html';
const MANY_TOGGLES_CANDIDATE_COUNT = 4;

let browser: Browser;
const servers: FixtureServer[] = [];
const temporaryDirectories: string[] = [];

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

/** session の差し替え。session を作った後に、非同期の処理（例: Passive の page を落とす）を行ってもよい。 */
type WrapSession = (session: InteractionGuardedSession) => InteractionGuardedSession | Promise<InteractionGuardedSession>;

/** Interaction の session を作った回数と、そのビューポートを数える factory。`wrapSession` で session を差し替えられる。 */
class CountingFactory extends BrowserContextFactory {
  readonly interactionViewports: Viewport[] = [];
  readonly #wrapSession: WrapSession;

  constructor(config: AuditConfig, wrapSession: WrapSession = (session) => session, targetBrowser: Browser = browser) {
    super(targetBrowser, config, () => new SafetyLedger());
    this.#wrapSession = wrapSession;
  }

  override async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
    this.interactionViewports.push(viewport);
    return await this.#wrapSession(await super.createInteractionSession(viewport));
  }
}

interface AuditRun {
  readonly outcome: PageAuditOutcome;
  readonly config: AuditConfig;
  readonly factory: CountingFactory;
  readonly remainingContextCount: number;
  readonly elapsedMs: number;
}

interface AuditOptions {
  readonly overrides?: TestConfigOverrides;
  readonly wrapSession?: WrapSession;
  readonly collectors?: PageAuditorDependencies['collectors'];
  /** 省略すると `CountingFactory`。 */
  readonly createFactory?: (config: AuditConfig) => CountingFactory;
  /**
   * Run の途中で違反が記録されたかを答える関数の注入（C18f。本番では Run Coordinator が、Ledger の登録から答える）。
   * 必須の依存なので、省略した場合は、違反では止めないことを明示する `() => false` を渡す。
   */
  readonly safetyViolationRecorded?: PageAuditorDependencies['safetyViolationRecorded'];
}

async function auditFixture(pathname: string, options: AuditOptions = {}): Promise<AuditRun> {
  const server = await startFixtureServer();
  servers.push(server);
  const overrides = options.overrides ?? INTERACTION_ONLY;
  const config = createTestConfig(server.origin, '/', {
    ...overrides,
    viewports: { ...INTERACTION_ONLY.viewports, ...overrides.viewports },
  });
  const factory = options.createFactory?.(config) ?? new CountingFactory(config, options.wrapSession);
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-page-auditor-interaction-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory: factory,
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    ...(options.collectors === undefined ? {} : { collectors: options.collectors }),
    // 省略した場合は、違反では止めないことを明示する（Page Auditor だけを確かめるテスト）。
    safetyViolationRecorded: options.safetyViolationRecorded ?? ((): boolean => false),
  });
  const normalizedUrl = normalizeUrl(`${server.origin}${pathname}`, `${server.origin}${pathname}`, new Set());
  if (!normalizedUrl.ok) {
    throw new Error(`fixture URL must normalize: ${pathname}`);
  }
  const url: NormalizedHttpUrlEvidence = normalizedUrl.url;
  const startedAtMs = Date.now();
  const outcome = await auditor.audit(url, allocator.allocatePageId());
  const elapsedMs = Date.now() - startedAtMs;
  const remainingContextCount = browser.contexts().length;
  // どの監査の後にも、ブラウザに Context が残っていない（R14 の m4）。
  expect(remainingContextCount, 'Contexts left in the browser after audit()').toBe(0);
  return { outcome, config, factory, remainingContextCount, elapsedMs };
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

function safetyOf(outcome: PageAuditOutcome, viewport: ViewportProfile, scope: 'PASSIVE' | 'INTERACTION'): EvidenceRecordFor<'safety'>[] {
  return evidenceOf(outcome, 'safety', viewport).filter((record) => record.payload.scope === scope);
}

async function expectPageSchema(outcome: PageAuditOutcome): Promise<void> {
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
}

describe('PageAuditor Interaction stage on a page with an aria-expanded toggle', () => {
  it('records the VERIFIED interaction Evidence on Desktop and keeps Desktop AUDITED', async () => {
    const { outcome, config, factory, remainingContextCount } = await auditFixture(TOGGLE_PAGE);
    const { result } = outcome;

    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.payload.status).toBe('VERIFIED');
    // C18n: 記録した Evidence の理由は、コードと詳細（なし）に分かれている。lifecycle の理由はない。
    expect(interactions[0]?.payload).toMatchObject({
      reason: 'OBSERVABLE_STATE_CHANGED',
      reasonDetail: null,
      work: { status: 'VERIFIED', reason: 'OBSERVABLE_STATE_CHANGED', reasonDetail: null },
      lifecycle: { status: 'CLOSED', reason: null, reasonDetail: null },
    });
    // Evidence の部分だけを記録し、Safety の snapshot は含めない。
    expect(Object.keys(interactions[0]?.payload ?? {})).not.toContain('safety');
    // Interaction の Safety の snapshot から、INTERACTION の safety の Evidence を Desktop に1つ作る。
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(safetyOf(outcome, 'desktop', 'PASSIVE')).toHaveLength(1);
    // session は、設定の Desktop のビューポートで作る。
    expect(factory.interactionViewports).toEqual([config.viewports.primaryDesktop]);

    expect(result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    expect(result.status).toBe('AUDITED');
    expect(outcome.safety).toEqual({ invariantViolationCount: 0, invariantViolations: [], recordTruncated: false });
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction stage on a page whose candidates are all excluded (4.3.1)', () => {
  it('passes the excluded candidates to auditInteraction and evaluates the safety rules after the Interaction stage', async () => {
    const { outcome, factory, remainingContextCount } = await auditFixture(EXCLUSIONS_PAGE);
    const { result } = outcome;

    // 除外される候補も、呼び出しの前に取り除かずに、すべて auditInteraction に渡す。
    expect(factory.interactionViewports).toHaveLength(3);
    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(interactions.map((record) => record.payload.status)).toEqual(['REJECTED_UNSAFE', 'REJECTED_UNSAFE', 'REJECTED_UNSAFE']);
    // C18n: 除外の理由は、Evidence の理由のコードにもなる（詳細はない）。Safety の記録の理由と同じ値である。
    expect(interactions.map(({ payload }) => [payload.reason, payload.reasonDetail]).sort())
      .toEqual([['DOWNLOAD', null], ['EXTERNAL_ACTION', null], ['SUBMISSION_CONTROL', null]]);

    // 除外の事実は、Interaction の Safety の Evidence にある（Passive の Evidence にはない）。
    const interactionSafety = safetyOf(outcome, 'desktop', 'INTERACTION');
    expect(interactionSafety).toHaveLength(3);
    expect(interactionSafety.flatMap((record) => record.payload.excludedInteractionCandidates.map((event) => event.reason)))
      .toEqual(['SUBMISSION_CONTROL']);
    expect(interactionSafety.flatMap((record) => record.payload.blockedExternalActions.map((event) => event.reason)).sort())
      .toEqual(['DOWNLOAD', 'EXTERNAL_ACTION']);
    const passiveSafety = safetyOf(outcome, 'desktop', 'PASSIVE');
    // 0件でも真になる `every` の前に、件数を確かめる（R14 の m4）。
    expect(passiveSafety).toHaveLength(1);
    expect(passiveSafety.every((record) =>
      record.payload.excludedInteractionCandidates.length === 0 && record.payload.blockedExternalActions.length === 0)).toBe(true);

    // その Evidence から、Desktop の Safety の Finding ができる（Rule の評価が Interaction の後に行われる）。
    const interactionSafetyIds = new Set(interactionSafety.map((record) => record.evidenceId));
    for (const ruleId of ['SAFETY_INTERACTION_CANDIDATE_EXCLUDED', 'SAFETY_EXTERNAL_ACTION_BLOCKED']) {
      const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
      expect(findings.length, ruleId).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.viewport).toBe('desktop');
        expect(finding.severity).toBe('SAFETY');
        expect(finding.evidenceRefs.every((ref) => interactionSafetyIds.has(ref)), ruleId).toBe(true);
      }
    }
    // 除外は安全のための正しい結果なので、ビューポートを PARTIAL にしない。
    expect(result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction stage budget (4.5.7)', () => {
  it('stops when the next candidate does not fit in the stage deadline and records PARTIAL with the remaining count', async () => {
    const navigationTimeoutMs = 5_000;
    const interactionTimeoutMs = 3_000;
    // 候補1つの見積もりは navigationTimeoutMs + interactionTimeoutMs × 2 = 11,000ms。段階の予算は、それより 600ms だけ長い。
    // 最初の候補は収まり、1つを監査した後は（監査には 600ms より長くかかるので）次の候補が収まらない。
    const overallPageTimeoutMs = navigationTimeoutMs + interactionTimeoutMs * 2 + 600;
    const { outcome, factory, remainingContextCount } = await auditFixture(MANY_TOGGLES_PAGE, {
      overrides: { ...INTERACTION_ONLY, crawl: { navigationTimeoutMs, interactionTimeoutMs, overallPageTimeoutMs } },
    });
    const { result } = outcome;

    const audited = evidenceOf(outcome, 'interaction', 'desktop').length;
    expect(audited).toBeGreaterThanOrEqual(1);
    expect(audited).toBeLessThan(MANY_TOGGLES_CANDIDATE_COUNT);
    expect(factory.interactionViewports).toHaveLength(audited);
    expect(result.viewports.desktop.status).toBe('PARTIAL');
    expect(result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'COLLECTOR_INCOMPLETE', detail: `interaction:budget:remaining=${MANY_TOGGLES_CANDIDATE_COUNT - audited}` },
    ]);
    expect(result.viewports.mobile.status).toBe('AUDITED');
    expect(result.status).toBe('PARTIAL');
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);

  // P14f（R14r の Minor-1、設計書 4.5.7）: 候補の発見は Passive の段階の期限の中で行い、Interaction の段階の予算は、発見が
  // 終わった時刻から数える。そのため、設定の検証の境界の値（ページの期限 = 候補1つの見積もり）でも、1件目の候補を監査する。
  it('audits the first candidate when overallPageTimeoutMs equals the budget of one candidate', async () => {
    const navigationTimeoutMs = 2_000;
    const interactionTimeoutMs = 2_000;
    const overallPageTimeoutMs = navigationTimeoutMs + interactionTimeoutMs * 2;
    const { outcome, factory } = await auditFixture(TOGGLE_PAGE, {
      overrides: { ...INTERACTION_ONLY, crawl: { navigationTimeoutMs, interactionTimeoutMs, overallPageTimeoutMs } },
    });

    expect(factory.interactionViewports).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(outcome.result.viewports.desktop.incompleteReasons.filter((reason) => reason.detail?.startsWith('interaction:')))
      .toEqual([]);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);

  it('records PARTIAL with interaction-discovery:<completeness> when the candidate discovery is not COMPLETE', async () => {
    let discoveries = 0;
    const { outcome } = await auditFixture(TOGGLE_PAGE, {
      collectors: {
        discoverInteractionCandidates: async (...args: Parameters<typeof discoverInteractionCandidates>) => {
          discoveries += 1;
          const discovered = await discoverInteractionCandidates(...args);
          return Object.freeze({ ...discovered, completeness: 'CANDIDATE_LIMIT_REACHED' as const });
        },
      },
    });

    expect(discoveries).toBe(1);
    // 見つけた候補は、監査する。
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(outcome.result.viewports.desktop).toMatchObject({
      status: 'PARTIAL',
      incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'interaction-discovery:CANDIDATE_LIMIT_REACHED' }],
    });
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C14x（R14r2 の Minor-2、設計書 4.5.7）: 候補の発見は Passive の page で行うので、ページの期限で見放す。発見が終わらない場合も、
// `interaction-discovery:DEADLINE_EXCEEDED` を記録して、監査が戻る。見放す時刻を渡さない誤り（`null` を渡す）があると、監査が
// 戻らないので、このテストはテストの時間の上限で失敗する。
describe('PageAuditor Interaction candidate discovery that never finishes (R14r2 Minor-2)', () => {
  const OVERALL_PAGE_TIMEOUT_MS = 6_000;
  /** 見放す時刻を渡さない誤りを、全体の時間の上限より十分に早く、失敗として検出するためのテストの時間の上限。 */
  const NEVER_FINISHING_DISCOVERY_TEST_TIMEOUT_MS = OVERALL_PAGE_TIMEOUT_MS * 8;

  it('records interaction-discovery:DEADLINE_EXCEEDED at the page deadline and returns', async () => {
    let discoveries = 0;
    const { outcome, factory, elapsedMs } = await auditFixture(TOGGLE_PAGE, {
      overrides: {
        ...INTERACTION_ONLY,
        crawl: { navigationTimeoutMs: 2_000, interactionTimeoutMs: 2_000, overallPageTimeoutMs: OVERALL_PAGE_TIMEOUT_MS },
      },
      collectors: {
        // 終わらない発見（Passive の page のメインスレッドが止まった場合などを表す）。
        discoverInteractionCandidates: () => {
          discoveries += 1;
          return new Promise<never>(() => undefined);
        },
      },
    });

    expect(discoveries).toBe(1);
    expect(factory.interactionViewports).toEqual([]);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toEqual([]);
    expect(outcome.result.viewports.desktop.status).toBe('PARTIAL');
    expect(outcome.result.viewports.desktop.incompleteReasons).toContainEqual(
      { code: 'COLLECTOR_INCOMPLETE', detail: 'interaction-discovery:DEADLINE_EXCEEDED' },
    );
    // Desktop と Mobile の、それぞれのページの期限の和より前に戻る。
    expect(elapsedMs).toBeLessThan(OVERALL_PAGE_TIMEOUT_MS * 2 + 5_000);
    await expectPageSchema(outcome);
  }, NEVER_FINISHING_DISCOVERY_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction owner cleanup failure (4.5.8)', () => {
  it('tries close() once on the session of InteractionOwnerCleanupError, records interaction:cleanup, and skips the rest', async () => {
    let closeCalls = 0;
    // auditInteraction の後片付けでは、close() を呼んでも閉じない（終端に達しない）偽の session。
    // auditInteraction が回数を使い切って InteractionOwnerCleanupError を投げた後の close() だけ、本当に閉じる。
    const OWNER_CLOSE_ATTEMPTS = 2;
    const { outcome, factory, remainingContextCount } = await auditFixture(MANY_TOGGLES_PAGE, {
      wrapSession: (session) => ({
        page: session.page,
        ledger: session.ledger,
        isClosed: () => session.isClosed(),
        activateInteractionFreeze: () => session.activateInteractionFreeze(),
        close: async () => {
          closeCalls += 1;
          if (closeCalls > OWNER_CLOSE_ATTEMPTS) {
            await session.close();
          }
        },
      }),
    });
    const { result } = outcome;

    // auditInteraction の2回に、Page Auditor の1回を足した回数だけ呼ばれる。
    expect(closeCalls).toBe(OWNER_CLOSE_ATTEMPTS + 1);
    // 残りの候補は監査しない。
    expect(factory.interactionViewports).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(0);
    expect(result.viewports.desktop.status).toBe('PARTIAL');
    expect(result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'COLLECTOR_INCOMPLETE', detail: `interaction:cleanup:remaining=${MANY_TOGGLES_CANDIDATE_COUNT - 1}` },
    ]);
    // エラーが保持する Safety の snapshot を、Evidence と違反の集計に含める。
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(outcome.safety.invariantViolationCount).toBeGreaterThan(0);
    expect(outcome.safety.invariantViolations.map((violation) => violation.code))
      .toContain('INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED');
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction stage failures', () => {
  it('records COLLECTOR_INCOMPLETE with interaction:<reason> when auditInteraction throws, and leaves no Context', async () => {
    const { outcome, factory, remainingContextCount } = await auditFixture(TOGGLE_PAGE, {
      wrapSession: (session) => {
        // session を作った後に失敗したことにする（閉じてから投げる）。
        void session.close();
        throw new Error('injected interaction session failure');
      },
    });

    expect(factory.interactionViewports).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(0);
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(0);
    expect(outcome.result.viewports.desktop).toMatchObject({
      status: 'PARTIAL',
      incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'interaction:EVALUATION_FAILED' }],
    });
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction safety summary', () => {
  it('counts the invariant violations of the Interaction Safety snapshots in PageAuditOutcome.safety', async () => {
    const { outcome } = await auditFixture(TOGGLE_PAGE, {
      wrapSession: (session) => {
        session.ledger.recordInvariantViolation({ code: 'TEST_INJECTED_VIOLATION', message: 'injected interaction violation' });
        return session;
      },
    });

    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations).toEqual([
      { code: 'TEST_INJECTED_VIOLATION', message: 'injected interaction violation' },
    ]);
    // 違反は Evidence に含めない。
    expect(JSON.stringify(outcome.result)).not.toContain('TEST_INJECTED_VIOLATION');
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor Interaction stage scope', () => {
  it('does not look for candidates and gives no reason when interactions are disabled', async () => {
    let discoveries = 0;
    const { outcome, factory, remainingContextCount } = await auditFixture(TOGGLE_PAGE, {
      overrides: { ...INTERACTION_ONLY, audit: { ...INTERACTION_ONLY.audit, interactions: false } },
      collectors: {
        discoverInteractionCandidates: async (...args: Parameters<typeof discoverInteractionCandidates>) => {
          discoveries += 1;
          return discoverInteractionCandidates(...args);
        },
      },
    });

    expect(discoveries).toBe(0);
    expect(factory.interactionViewports).toEqual([]);
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(evidenceOf(outcome, 'interaction', viewport)).toHaveLength(0);
      expect(safetyOf(outcome, viewport, 'INTERACTION')).toHaveLength(0);
      expect(outcome.result.viewports[viewport]).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    }
    expect(remainingContextCount).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);

  it('runs the Interaction stage only on Desktop, not on Mobile', async () => {
    let discoveries = 0;
    const { outcome, config, factory, remainingContextCount } = await auditFixture(TOGGLE_PAGE, {
      collectors: {
        discoverInteractionCandidates: async (...args: Parameters<typeof discoverInteractionCandidates>) => {
          discoveries += 1;
          return discoverInteractionCandidates(...args);
        },
      },
    });

    expect(discoveries).toBe(1);
    expect(factory.interactionViewports).toEqual([config.viewports.primaryDesktop]);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'mobile')).toHaveLength(0);
    expect(safetyOf(outcome, 'mobile', 'INTERACTION')).toHaveLength(0);
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14e（R14 の I2、設計書 4.3）: Interaction の session の構築に失敗した場合も、その Context の Ledger を、INTERACTION の safety の
// Evidence と違反の集計に含める。その Context を閉じる処理の失敗も、捨てずに理由として記録する。
describe('PageAuditor Interaction Context construction failure (R14 I2)', () => {
  it('includes the Ledger of the Context of ContextConstructionError and records the failure to close that Context', async () => {
    /** Interaction の session を作るときに、Ledger に違反を1件記録してから `ContextConstructionError` を投げる。その Context の close は失敗する。 */
    class InteractionConstructionFailureFactory extends CountingFactory {
      readonly #constructionFailures = new Set<BrowserContext>();

      override async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
        this.interactionViewports.push(viewport);
        const context = await this.createPassiveContext(viewport);
        this.#constructionFailures.add(context);
        this.getSafetyLedger(context).recordInvariantViolation({
          code: 'TEST_INTERACTION_CONSTRUCTION_VIOLATION',
          message: 'injected interaction construction violation',
        });
        throw new ContextConstructionError(
          context,
          this.getSafetyLedger(context),
          new Error('injected interaction guard installation failure'),
        );
      }

      override async closePassiveContext(context: BrowserContext): Promise<void> {
        await super.closePassiveContext(context);
        if (this.#constructionFailures.has(context)) {
          throw new Error('injected interaction Context close failure');
        }
      }
    }
    const { outcome, factory } = await auditFixture(TOGGLE_PAGE, {
      createFactory: (config) => new InteractionConstructionFailureFactory(config),
    });

    expect(factory.interactionViewports).toHaveLength(1);
    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations).toEqual([
      { code: 'TEST_INTERACTION_CONSTRUCTION_VIOLATION', message: 'injected interaction construction violation' },
    ]);
    // 構築に失敗した Context の Ledger から、INTERACTION の safety の Evidence を1つ作る（違反は Evidence に含めない）。
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(JSON.stringify(outcome.result)).not.toContain('TEST_INTERACTION_CONSTRUCTION_VIOLATION');
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(0);
    expect(outcome.result.viewports.desktop).toMatchObject({
      status: 'PARTIAL',
      incompleteReasons: [
        // 場面の名前は、Interaction の Context を閉じる処理であることを示す（R14r の Minor-3）。
        { code: 'UNHANDLED_FAILURE', detail: 'interaction-context-close:injected interaction Context close failure' },
        { code: 'COLLECTOR_INCOMPLETE', detail: 'interaction:EVALUATION_FAILED' },
      ],
    });
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);

  // P14f（R14r の Important-1）: Guard の取り付けに失敗し、Guard が Context を閉じた場合も、その Ledger を集計に含める。
  it('counts GUARD_INSTALLATION_FAILED of an Interaction session whose Guard closed the Context', async () => {
    /** 2回目の `newContext`（Desktop の Interaction の session）で、Context を作った直後に page を1つ開く Browser。 */
    const poisonedBrowser = browserOpeningPageAfterNewContext(browser, { onlyOnCall: 2 });
    const { outcome, factory } = await auditFixture(TOGGLE_PAGE, {
      createFactory: (config) => new CountingFactory(config, undefined, poisonedBrowser),
    });

    expect(factory.interactionViewports).toHaveLength(1);
    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.safety.invariantViolations.map((violation) => violation.code)).toEqual(['GUARD_INSTALLATION_FAILED']);
    // 構築に失敗した Context の Ledger から、INTERACTION の safety の Evidence を1つ作る。
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(0);
    expect(outcome.result.viewports.desktop).toMatchObject({
      status: 'PARTIAL',
      incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'interaction:EVALUATION_FAILED' }],
    });
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// P14e（R14 の m1、設計書 4.5.4）: 最後の Interaction の候補の処理中に Passive の page が crash した場合も、
// `<段階>:PAGE_CRASHED` の理由を記録する（候補は隔離した Context で監査するので、段階は crash と競わせずに最後まで行う）。
describe('PageAuditor Passive page crash during the last Interaction candidate (R14 m1)', () => {
  it('records interaction:PAGE_CRASHED and marks Desktop FAILED', async () => {
    let passivePage: Page | undefined;
    const { outcome } = await auditFixture(TOGGLE_PAGE, {
      collectors: {
        discoverInteractionCandidates: async (...args: Parameters<typeof discoverInteractionCandidates>) => {
          [passivePage] = args;
          return discoverInteractionCandidates(...args);
        },
      },
      // 唯一の（最後の）候補の session を作った時点で、Passive の page の描画プロセスを落とし、crash の事象を待つ。
      wrapSession: async (session) => {
        const page = passivePage;
        if (page === undefined) {
          throw new Error('the Passive page must be captured before the Interaction session');
        }
        const cdp = await page.context().newCDPSession(page);
        const crashed = page.waitForEvent('crash');
        void cdp.send('Page.crash').catch(() => undefined);
        await crashed;
        return session;
      },
    });

    // 候補の監査は、隔離した Context で最後まで行い、その Evidence は記録する。
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(outcome.result.viewports.desktop.status).toBe('FAILED');
    expect(outcome.result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'COLLECTOR_INCOMPLETE', detail: 'interaction:PAGE_CRASHED' },
    ]);
    expect(outcome.result.viewports.mobile.status).toBe('AUDITED');
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

// C18f（Task 19 の前の整理の設計書 4.5、RC18a の指摘2）: 1つの候補で違反が起きた後は、Interaction の次の候補を始めない。
// 始めなかった候補は、今の途中で止めた扱い（`interaction:<理由>:remaining=<件数>`）と同じ形で記録する。
describe('PageAuditor Interaction: no next candidate after a safety invariant violation (C18f, design 4.5)', () => {
  it('does not start the next candidates after a violation in the first candidate session', async () => {
    // 候補の session の Ledger を覚えておき、どれかに違反があるかを答える（Run Coordinator が、Ledger の登録から答えるのと同じ）。
    const sessionLedgers: SafetyLedger[] = [];
    const { outcome, factory, remainingContextCount } = await auditFixture(MANY_TOGGLES_PAGE, {
      wrapSession: (session) => {
        sessionLedgers.push(session.ledger);
        if (sessionLedgers.length === 1) {
          session.ledger.recordInvariantViolation({ code: 'TEST_INJECTED_VIOLATION', message: 'injected interaction violation' });
        }
        return session;
      },
      safetyViolationRecorded: () => sessionLedgers.some((ledger) => ledger.snapshot().invariantViolationCount > 0),
    });

    // 最初の候補だけを監査し、残りの候補の session は作らない。
    expect(factory.interactionViewports).toHaveLength(1);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(safetyOf(outcome, 'desktop', 'INTERACTION')).toHaveLength(1);
    expect(outcome.result.viewports.desktop.status).toBe('PARTIAL');
    expect(outcome.result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'COLLECTOR_INCOMPLETE', detail: `interaction:SAFETY_VIOLATION_ABORT:remaining=${MANY_TOGGLES_CANDIDATE_COUNT - 1}` },
    ]);
    // 同じページの Mobile も始めない。
    expect(outcome.result.viewports.mobile).toMatchObject({
      status: 'SKIPPED',
      incompleteReasons: [{ code: 'SAFETY_VIOLATION_ABORT', detail: null }],
    });
    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(remainingContextCount).toBe(0);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});
