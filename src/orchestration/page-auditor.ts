import { rm } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { RuleEngine } from '../audit/rule-engine.js';
import { ContextConstructionError, type BrowserContextFactory } from '../browser/context-factory.js';
import { controlledScroll } from '../browser/controlled-scroll.js';
import { pageFailureReason } from '../browser/page-failure.js';
import { waitForPageSettled } from '../browser/page-settling.js';
import type { AuditConfig, Viewport } from '../config/types.js';
import { viewportSizeFor } from '../config/viewport-size.js';
import { artifactFilePath, screenshotRelativePath } from '../core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  type EvidencePayloadByType,
  type EvidenceRecord,
  type EvidenceType,
  type Finding,
  type IncompleteReason,
  type IncompleteReasonCode,
  type PageAuditOutcome,
  type PageAuditResult,
  type PageAuditStage,
  type PageId,
  type PartialFailureReason,
  type ViewportAuditResult,
  type ViewportAuditStatus,
  type ViewportProfile,
} from '../core/contracts.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import type { NormalizedHttpUrlEvidence, ScreenshotCaptureType, ScrollEvidence } from '../core/evidence-types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import {
  COLLECTOR_DEADLINE_MARGIN_MS,
  CONTROLLED_SCROLL_PACING,
  INTERACTION_CLEANUP_ALLOWANCE_MS,
  INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE,
  MAX_ERROR_MESSAGE_LENGTH,
  PAGE_SETTLING_PACING,
  SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER,
} from '../core/limits.js';
import {
  collectorIncompleteReason,
  derivePageAuditStatus,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
} from '../core/status.js';
import { discoverLinks } from '../crawl/discover-links.js';
import { collectAccessibilityEvidence } from '../evidence/accessibility-collector.js';
import type { CollectorHandle } from '../evidence/collector-handle.js';
import { collectColorEvidence } from '../evidence/color-collector.js';
import { ConsoleCollector } from '../evidence/console-collector.js';
import { collectDomEvidence } from '../evidence/dom-collector.js';
import { collectLayoutEvidence, collectStressLayout } from '../evidence/layout-collector.js';
import { NetworkCollector } from '../evidence/network-collector.js';
import { PerformanceCollector } from '../evidence/performance-collector.js';
import { captureScreenshots, type ScreenshotCapturePaths } from '../evidence/screenshot-collector.js';
import { discoverInteractionCandidates } from '../interaction/discover-candidates.js';
import {
  auditInteraction,
  InteractionOwnerCleanupError,
  type InteractionAuditResult,
  type InteractionAuditSession,
} from '../interaction/isolated-auditor.js';
import type { InteractionCandidate } from '../safety/interaction-policy.js';
import {
  safetyEventsEvidenceFromSnapshot,
  summarizePageSafety,
  type SafetyLedger,
  type SafetyLedgerSnapshot,
} from '../safety/safety-ledger.js';
import { createEvidenceRecord } from './evidence-builder.js';
import type { IdAllocator } from './id-allocator.js';
import { navigatePage, type PageNavigationResult } from './page-navigation.js';
import {
  closePassivePageAndContext,
  PassiveContextCloseDeadlineError,
  PassivePageCloseDeadlineError,
  type PassiveSessionCloseFailure,
} from './passive-session-close.js';
import {
  openPassiveSessionBeforeDeadline,
  passiveSessionOpenDeadlineAtMs,
  releaseLatePassiveContextFailure,
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';
import { skippedPageResult } from './skipped-page.js';
import { stageDeadline } from './stage-deadline.js';
import { createStressSessionFactory, type StressSessionFactory } from './stress-session.js';

/**
 * Page Auditor が呼ぶ collector と Link の抽出と、Interaction の候補の発見。既定は本番の関数で、テストでは一部を差し替えて
 * 例外や PARTIAL を起こせる。差し替えは呼び出しの口を変えるだけで、Link の抽出の入口（`discoverLinks`）、候補の発見の入口
 * （`discoverInteractionCandidates`）や collector の判断を別に持つものではない。
 */
export interface PageAuditCollectors {
  readonly collectDomEvidence: typeof collectDomEvidence;
  readonly collectLayoutEvidence: typeof collectLayoutEvidence;
  readonly collectStressLayout: typeof collectStressLayout;
  readonly collectColorEvidence: typeof collectColorEvidence;
  readonly collectAccessibilityEvidence: typeof collectAccessibilityEvidence;
  readonly performance: Pick<PerformanceCollector, 'installBeforeNavigation' | 'collect'>;
  readonly captureScreenshots: typeof captureScreenshots;
  readonly discoverLinks: typeof discoverLinks;
  readonly discoverInteractionCandidates: typeof discoverInteractionCandidates;
}

/** page rule の評価をするもの（`RuleEngine`）。評価のたびに、採番器の Finding の連番から新しく作る（設計書 4.5.3）。 */
export type PageRuleEvaluator = Pick<RuleEngine, 'evaluate'>;

/** `PageAuditor` に注入するもの（Task 14〜17 の設計書 第3章、4.5.1、4.5.3）。 */
export interface PageAuditorDependencies {
  /** Passive Context と page、幅の走査のセッションを作る factory。 */
  readonly contextFactory: BrowserContextFactory;
  /** 確定した監査の設定。 */
  readonly config: AuditConfig;
  /** Run で1つの採番器（Run Coordinator が作る）。 */
  readonly allocator: IdAllocator;
  /** Evidence の `observedAt` に使う時計。 */
  readonly clock: () => Date;
  /**
   * 期限の計算に使う、現在の時刻（ミリ秒）。
   * 前提: `Date.now()` と同じ基準（UNIX エポックからのミリ秒）で、同じ速さで進む時刻でなければならない（設計書 4.5.7、R14r の Minor-3）。
   * Page Auditor は、この時刻で求めた期限を、`Date.now()` で期限を判定する部品（`awaitBeforeDeadline`、期限を受け取る collector、
   * `auditInteraction`）に渡すためである。基準がずれた時計（例: 固定の時刻や、`performance.now()`）を渡すと、期限が早すぎたり
   * 遅すぎたりして、段階を見放す時刻と collector の期限が食い違う。
   */
  readonly now: () => number;
  /** スクリーンショットの保存先の根のディレクトリ。Evidence の `relativePath` は、ここからの相対パス。 */
  readonly screenshotRootDirectory: string;
  /**
   * 最初の Finding の連番から `RuleEngine` を作る関数。省略すると、`config.target.id` と `RULE_CATALOG` の `RuleEngine`。
   * 評価のたびに呼ぶ（インスタンスを使い回すと、Finding の ID が重複するため）。
   */
  readonly createRuleEngine?: (firstFindingSequence: number) => PageRuleEvaluator;
  /** collector の差し替え口（テストで例外や PARTIAL を起こすため）。指定しなかった collector は本番の関数を使う。 */
  readonly collectors?: Partial<PageAuditCollectors>;
  /**
   * Context と page の作成・終了の期限の注入口（DEF-008、R15r-4。Task 18 の前の整理の設計書 4.2、4.4）。省略した項目は、
   * `limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
   * Passive の Context と page、幅の走査のセッション、Interaction の session の作成と終了に使う。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
  /**
   * Run の途中で、安全の不変条件の違反が1件でも記録されたかを返す関数（Task 19 の前の整理の設計書 4.5。C18f）。
   * Run Coordinator が、Run の間に作ったすべての Ledger の登録から答える関数を渡す（違反の検出は Run Coordinator が持つ）。
   * Page Auditor は、次の監査を始める前に呼び、真なら始めない。確かめる時点は、次のとおりである。
   * - 同じページの、次のビューポートの前（始めなかったビューポートは、理由 `SAFETY_VIOLATION_ABORT` の `SKIPPED`）
   * - 幅の走査の、各幅のセッションを作る前（段階の理由 `stress-layout:SAFETY_VIOLATION_ABORT`）
   * - Interaction の、各候補の前（段階の理由 `interaction:SAFETY_VIOLATION_ABORT:remaining=<件数>`）
   * あわせて、幅の走査の段階が例外で止まったときにも呼び、真なら段階の理由を `stress-layout:SAFETY_VIOLATION_ABORT` にする
   * （幅のセッションの中の違反で、Guard がその Context を閉じた場合。C18i、RC18b の N2）。
   * すでに始めた処理の後始末（page と Context を閉じること）は、今までどおり行う。
   * 必須の依存である（渡し忘れると止まらない、という形を残さない）。関数でない値と、渡さなかった場合は `TypeError`。
   * 違反では止めない Page Auditor が必要な場合（テストなど）は、それを明示する関数（`() => false`）を渡す。
   */
  readonly safetyViolationRecorded: () => boolean;
}

/**
 * 違反を検出したため、始めなかった監査の理由のコード（Task 19 の前の整理の設計書 4.5。C18f）。
 * 幅の走査と Interaction の段階の理由の `detail` にも、同じ文字列を使う。
 */
const SAFETY_VIOLATION_ABORT_CODE: Extract<IncompleteReasonCode, 'SAFETY_VIOLATION_ABORT'> = 'SAFETY_VIOLATION_ABORT';

/**
 * 違反を検出したため、始めなかったページとビューポートの理由（`detail` は `null`）。Run Coordinator も、始めなかったページと、
 * 止めたことを表す Run の理由に、これを使う（C18f）。
 */
export const SAFETY_VIOLATION_ABORT_REASON: IncompleteReason = Object.freeze({ code: SAFETY_VIOLATION_ABORT_CODE, detail: null });

/** 違反を検出したため、幅の走査の次の幅のセッションを作らなかったことを、段階の例外として伝える（C18f）。 */
class SafetyViolationAbortError extends Error {
  constructor() {
    super('a safety invariant violation was recorded; the next stress sweep session was not started');
    this.name = 'SafetyViolationAbortError';
  }
}

/**
 * 再試行を区別する情報（DEF-007、Task 14〜17 の設計書 5.6.4）。Run Coordinator が `audit` に渡す。
 * 省略すると、再試行を考えない（スクリーンショットは、いつもの場所に置く）。
 */
export interface PageAuditAttempt {
  /** 試行の番号（1から始まる、正の安全な整数）。 */
  readonly attempt: number;
  /**
   * Desktop のビューポートの結果から、この試行の後に再試行するかを返す（再試行の判断は、Run Coordinator だけが持つ）。
   * Page Auditor は、Desktop のビューポートの監査を終えた後に、1回だけ呼ぶ。真なら、この試行は再試行の前の試行なので、それより後の
   * ビューポートのスクリーンショットを `pages/<pageId>/retry-<attempt>/<ビューポート>/` に置く。
   * Desktop のスクリーンショットは、いつもの場所に置く。再試行の判断は Desktop のナビゲーションの失敗だけで決まり、ナビゲーションが
   * 失敗したビューポートは、スクリーンショットを撮らないためである。
   */
  readonly precedesRetry: (desktop: ViewportAuditResult) => boolean;
}

/** 閉じる処理と、Context を作る処理の失敗を、理由の `detail`（`<場面>:<メッセージ>`）で区別するための場面の名前（設計書 4.5.5）。 */
const SESSION_FAILURE_LABELS = Object.freeze({
  open: 'passive-context',
  pageClose: 'passive-page-close',
  contextClose: 'passive-context-close',
  /** 構築に失敗した Interaction の session の Context を閉じる処理（R14r の Minor-3）。 */
  interactionContextClose: 'interaction-context-close',
} as const);
type ContextCloseLabel = (typeof SESSION_FAILURE_LABELS)['contextClose' | 'interactionContextClose'];

/** Interaction の段階を途中で止めた理由（`COLLECTOR_INCOMPLETE` の `detail` の `interaction:<理由>:remaining=<件数>`）。 */
const INTERACTION_STOP_REASONS = Object.freeze({
  /** 次の候補の見積もりが、段階の期限に収まらない（4.5.7）。 */
  budget: 'budget',
  /** `InteractionOwnerCleanupError` が起きた（4.5.8）。 */
  cleanup: 'cleanup',
  /** 安全の不変条件の違反を検出した（Task 19 の前の整理の設計書 4.5。C18f）。 */
  safety: SAFETY_VIOLATION_ABORT_CODE,
} as const);
type InteractionStopReason = (typeof INTERACTION_STOP_REASONS)[keyof typeof INTERACTION_STOP_REASONS];

/** `auditViewport()` の中間の結果。ページの結果は、両方のビューポートのこれから組み立てる。 */
interface ViewportAuditOutcome {
  readonly result: ViewportAuditResult;
  readonly evidence: readonly EvidenceRecord[];
  readonly findings: readonly Finding[];
  /** このビューポートの Safety の記録。Ledger の snapshot は、Context を閉じた後に取って集計する。 */
  readonly safety: ViewportSafetySources;
}

/**
 * 1つのビューポートの Safety の記録。Safety の Evidence は、この順に作る（設計書 4.5.2 の手順6）。
 * - `passiveLedgers`: Passive の Context の Ledger（Context を作れた場合だけ）
 * - `interactionSnapshots`: Interaction の候補ごとの、隔離した Context の Ledger の snapshot（Desktop だけ）。
 *   `auditInteraction` が Context を閉じた後に取ったものである。
 * - `stressLedgers`: 幅の走査のセッションの Ledger（Desktop だけ）
 */
interface ViewportSafetySources {
  readonly passiveLedgers: SafetyLedger[];
  readonly interactionSnapshots: SafetyLedgerSnapshot[];
  readonly stressLedgers: SafetyLedger[];
}

/** 候補1つの監査の結果。後片付けの失敗は、エラーが保持する Safety の snapshot だけを持つ（4.5.8）。 */
type InteractionCandidateOutcome =
  | { readonly kind: 'AUDITED'; readonly result: InteractionAuditResult }
  | { readonly kind: 'CLEANUP_FAILED'; readonly safety: SafetyLedgerSnapshot };

type StageAttempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * 1つのページを、Desktop と Mobile の両方のビューポートで監査する（Task 14〜17 の設計書 4.5）。
 * Interaction の段階は、Desktop で、設定の `audit.interactions` が有効な場合だけ行う（4.5.2 の手順5）。
 * 注入する `now` は、`Date.now()` と同じ基準の時刻でなければならない（`PageAuditorDependencies.now`。期限の判定に
 * `awaitBeforeDeadline` などが `Date.now()` を使うため）。
 */
export class PageAuditor {
  readonly #factory: BrowserContextFactory;
  readonly #config: AuditConfig;
  readonly #allocator: IdAllocator;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #screenshotRootDirectory: string;
  readonly #createRuleEngine: (firstFindingSequence: number) => PageRuleEvaluator;
  readonly #collectors: PageAuditCollectors;
  readonly #deadlines: ResolvedPassiveSessionDeadlines;
  readonly #safetyViolationRecorded: () => boolean;

  /** 注入した期限（`dependencies.deadlines`）が不正なら、`RangeError` か `TypeError` を投げる。 */
  constructor(dependencies: PageAuditorDependencies) {
    const { contextFactory, config, allocator, clock, now, screenshotRootDirectory } = dependencies;
    if (typeof clock !== 'function' || typeof now !== 'function') {
      throw new TypeError('PageAuditor requires a clock and a current time function');
    }
    if (typeof screenshotRootDirectory !== 'string' || screenshotRootDirectory.length === 0) {
      throw new TypeError('PageAuditor requires a screenshot root directory');
    }
    const { safetyViolationRecorded } = dependencies;
    if (typeof safetyViolationRecorded !== 'function') {
      throw new TypeError('PageAuditor requires a safetyViolationRecorded function');
    }
    this.#safetyViolationRecorded = safetyViolationRecorded;
    this.#deadlines = resolvePassiveSessionDeadlines(dependencies.deadlines);
    this.#factory = contextFactory;
    this.#config = config;
    this.#allocator = allocator;
    this.#clock = clock;
    this.#now = now;
    this.#screenshotRootDirectory = screenshotRootDirectory;
    this.#createRuleEngine = dependencies.createRuleEngine
      ?? ((firstFindingSequence) => new RuleEngine({ targetId: config.target.id, firstFindingSequence }));
    this.#collectors = Object.freeze({
      collectDomEvidence,
      collectLayoutEvidence,
      collectStressLayout,
      collectColorEvidence,
      collectAccessibilityEvidence,
      performance: new PerformanceCollector(),
      captureScreenshots,
      discoverLinks,
      discoverInteractionCandidates,
      ...dependencies.collectors,
    });
  }

  /**
   * `url`（正規化済みの、要求するURL）のページを、Desktop、Mobile の順に監査する（設計書 4.5.1）。
   * `attempt` は、Run Coordinator が再試行を区別するために渡す（`PageAuditAttempt`。DEF-007）。形が不正なら `TypeError` を投げる。
   * ページの状態は `derivePageAuditStatus` で、ビューポートの状態から導く。結果は深く凍結する。
   * 各ビューポートの Context は、途中で例外が起きても、必ず閉じてから返る（例外は呼び出し側に返す）。
   * Context と page の作成と終了は、期限付きで待つ（DEF-008）。作成の期限切れはビューポートの失敗（`DEADLINE_EXCEEDED`）、終了の
   * 期限切れは閉じる処理の失敗（`UNHANDLED_FAILURE`）として記録し、止まり続けない。遅れて届いた Context は、部品が閉じる。
   */
  async audit(url: NormalizedHttpUrlEvidence, pageId: PageId, attempt?: PageAuditAttempt): Promise<PageAuditOutcome> {
    if (attempt !== undefined && (!isPositiveSafeInteger(attempt.attempt) || typeof attempt.precedesRetry !== 'function')) {
      throw new TypeError('PageAuditor attempt needs a positive safe integer attempt number and a precedesRetry function');
    }
    const outcomes: ViewportAuditOutcome[] = [];
    // 再試行の前の試行なら、その試行の番号（スクリーンショットを `retry-<番号>` に置く）。Desktop の監査を終えた後に決める（DEF-007）。
    let screenshotRetryAttempt: number | null = null;
    for (const profile of VIEWPORT_PROFILES) {
      // 違反を検出した後は、同じページの次のビューポートを始めない（Task 19 の前の整理の設計書 4.5）。最初のビューポートの前には
      // 確かめない（ページを始めるかは、Run Coordinator が決める）。
      if (outcomes.length > 0 && this.#safetyViolationRecorded()) {
        outcomes.push(safetyAbortedViewportOutcome(url, pageId, profile));
        continue;
      }
      const outcome = await this.#auditViewport(url, pageId, profile, screenshotRetryAttempt);
      outcomes.push(outcome);
      if (profile === 'desktop' && attempt !== undefined && attempt.precedesRetry(outcome.result)) {
        screenshotRetryAttempt = attempt.attempt;
      }
    }
    const viewports = Object.fromEntries(
      VIEWPORT_PROFILES.map((profile, index) => [profile, (outcomes[index] as ViewportAuditOutcome).result]),
    ) as Record<ViewportProfile, ViewportAuditResult>;
    const result: PageAuditResult = {
      schemaVersion: 'page-schema/1.0',
      pageId,
      pageUrl: url,
      status: derivePageAuditStatus(outcomes.map((outcome) => outcome.result.status)),
      viewports,
      evidence: outcomes.flatMap((outcome) => outcome.evidence),
      findings: outcomes.flatMap((outcome) => outcome.findings),
      incompleteReasons: pageIncompleteReasons(outcomes.map((outcome) => outcome.result)),
    };
    // 違反の集計は、Context を閉じた後の snapshot で行う（閉じる処理の中で記録された違反も含めるため）。
    const safety = summarizePageSafety(outcomes.flatMap(({ safety: sources }) => [
      ...sources.passiveLedgers.map((ledger) => ledger.snapshot()),
      ...sources.interactionSnapshots,
      ...sources.stressLedgers.map((ledger) => ledger.snapshot()),
    ]));
    return deepFreeze({ result, safety });
  }

  /** 1つのビューポートの監査（設計書 4.5.2 の 1〜8）。 */
  async #auditViewport(
    url: NormalizedHttpUrlEvidence,
    pageId: PageId,
    profile: ViewportProfile,
    screenshotRetryAttempt: number | null,
  ): Promise<ViewportAuditOutcome> {
    const factory = this.#factory;
    const config = this.#config;
    const viewportSize = viewportSizeFor(config, profile);
    const pageDeadlineAtMs = this.#now() + config.crawl.overallPageTimeoutMs;
    // 期限を受け取る collector（DOM の準備、scroll、layout、幅の走査、accessibility、performance）に渡す期限の上限。
    // ページの期限より余裕の分だけ前にして、collector が期限で止まったときの PARTIAL の Evidence を捨てずに記録する（設計書 4.5.7）。
    const collectorDeadlineAtMs = pageDeadlineAtMs - COLLECTOR_DEADLINE_MARGIN_MS;
    const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);

    const evidence: EvidenceRecord[] = [];
    const reasons: IncompleteReason[] = [];
    const safety: ViewportSafetySources = { passiveLedgers: [], interactionSnapshots: [], stressLedgers: [] };
    let findings: readonly Finding[] = [];
    let navigation: PageNavigationResult | null = null;
    let failed = false;
    let stages: StageRunner | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let network: CollectorHandle<EvidencePayloadByType['network']> | undefined;
    let consoleHandle: CollectorHandle<EvidencePayloadByType['console']> | undefined;
    const record = <TType extends EvidenceType>(type: TType, payload: EvidencePayloadByType[TType]): EvidenceRecord => {
      const created = createEvidenceRecord(
        { type, pageId, viewport: profile, payload },
        { allocator: this.#allocator, clock: this.#clock },
      ) as EvidenceRecord;
      evidence.push(created);
      return created;
    };

    try {
      // 1. Passive Context と page を、期限付きで作る（DEF-008。Task 18 の前の整理の設計書 4.2、4.4）。期限は、今から
      // `sessionOpenTimeoutMs` 後と、ページの期限の早い方である。
      const opened = await openPassiveSessionBeforeDeadline(
        factory,
        viewportSize,
        passiveSessionOpenDeadlineAtMs({ timeoutMs: this.#deadlines.sessionOpenTimeoutMs, notAfterMs: pageDeadlineAtMs }),
        this.#deadlines,
      );
      // 構築に失敗した Context の Ledger も、Safety の Evidence と違反の集計に含める（設計書 4.3、R14 の I2、R14r の Important-1）。
      // Guard の取り付けの失敗は、この Ledger に違反として記録されるためである。Guard が Context を閉じた場合も、エラーは Ledger を持つ。
      if (opened.ledger !== null) {
        safety.passiveLedgers.push(opened.ledger);
      }
      switch (opened.status) {
        case 'OPENED':
          context = opened.context;
          page = opened.page;
          break;
        case 'FAILED':
          // 今の失敗の扱い。Context は、Guard がまだ閉じていなければ、`finally` で閉じる。
          failed = true;
          context = opened.context;
          reasons.push(sessionFailureReason(SESSION_FAILURE_LABELS.open, opened.error));
          break;
        case 'DEADLINE_EXCEEDED':
          // 作成の期限切れは、ビューポートの失敗とする。Context は部品が閉じた（遅れて届く Context も、部品が閉じる）ので、
          // `finally` で閉じ直さない。部品が閉じる処理の失敗（期限切れを含む）は、閉じる処理の失敗として記録する。
          failed = true;
          reasons.push(sessionOpenDeadlineReason(), ...closeFailureReasons(opened.closeFailures));
          break;
      }

      if (context !== undefined && page !== undefined) {
        const activePage = page;
        const runner = new StageRunner(activePage, reasons, this.#now);
        stages = runner;
        activePage.on('crash', runner.onCrash);
        // Passive の段階は、既定で、ページの期限まで待つ（設計書 4.5.7）。
        const attempt = <T>(
          stage: PageAuditStage,
          work: () => Promise<T>,
          abandonAtMs: number | null = pageDeadlineAtMs,
          failureReason?: StageFailureReason,
        ): Promise<StageAttempt<T>> => runner.attempt(stage, work, abandonAtMs, failureReason);

        // 2. collector を取り付ける（performance の init script はナビゲーションの前に入れる）。
        const performanceInstalled = config.audit.performance
          && (await attempt('performance', () => this.#collectors.performance.installBeforeNavigation(context as BrowserContext))).ok;
        network = NetworkCollector.attach(activePage);
        consoleHandle = ConsoleCollector.attach(activePage);

        // 3. ナビゲーションする。
        const navigationStartedAtMs = this.#now();
        const navigationDeadlineAtMs = stageDeadline(pageDeadlineAtMs, navigationStartedAtMs, config.crawl.navigationTimeoutMs);
        // ナビゲーションは、期限（`timeoutMs`）を受け取り、例外を投げずに結果を返す。crash の段階を記すためだけに、処理中の段階にする。
        const passiveContext = context;
        navigation = await runner.during('navigation', () => navigatePage(activePage, url, {
          timeoutMs: Math.max(1, Math.ceil(navigationDeadlineAtMs - navigationStartedAtMs)),
          ledger: factory.getSafetyLedger(passiveContext),
          allowedQueryParameters,
        }));

        if (navigation.navigationOutcome !== 'OK') {
          failed = true;
          reasons.push(Object.freeze({ code: 'NAVIGATION_FAILED', detail: navigationFailureDetail(navigation) }));
        } else {
          // 4. DOM の準備を待ち、controlled scroll を行う。
          const settling = await attempt('settling', () => waitForPageSettled(activePage, {
            deadlineAtMs: this.#stageDeadline(collectorDeadlineAtMs, config.crawl.resourceSettlingTimeoutMs),
            ...PAGE_SETTLING_PACING,
          }));
          if (settling.ok && settling.value.status === 'PARTIAL') {
            reasons.push(Object.freeze({ code: 'DOM_READINESS_FAILED', detail: settling.value.reason }));
          }
          const scroll = await attempt('scroll', () => controlledScroll(activePage, {
            deadlineAtMs: this.#stageDeadline(
              collectorDeadlineAtMs,
              config.crawl.resourceSettlingTimeoutMs * SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER,
            ),
            ...CONTROLLED_SCROLL_PACING,
          }));
          if (scroll.ok) {
            record('scroll', scroll.value);
            reasons.push(...scrollIncompleteReasons(scroll.value));
          }

          // 5. 収集する。
          await this.#collect({
            url,
            pageId,
            profile,
            page: activePage,
            viewportSize,
            collectorDeadlineAtMs,
            allowedQueryParameters,
            performanceInstalled,
            network,
            screenshotRetryAttempt,
            reasons,
            safety,
            record,
            attempt,
            stages: runner,
          });
        }

        // ナビゲーションの成否と crash にかかわらず、network と console の Evidence を記録する（設計書 4.3.0）。
        // どちらも page の外（Node 側）に集めた記録なので、crash の後も読む。
        const networkSnapshot = await snapshotCollector('navigation', activePage, reasons, network);
        if (networkSnapshot.ok) {
          record('network', networkSnapshot.value);
        }
        const consoleSnapshot = await snapshotCollector('navigation', activePage, reasons, consoleHandle);
        if (consoleSnapshot.ok) {
          record('console', consoleSnapshot.value);
        }
      }

      // 段階の途中で見つけられなかった crash も、理由として記録する（設計書 4.5.4、R14 の m1）。
      stages?.recordPendingCrash('safety');

      // 6. Safety の Evidence を、Ledger ごとに1つ作る（Passive の Context、Interaction の候補ごと、幅の走査のセッション）。
      for (const ledger of safety.passiveLedgers) {
        record('safety', safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE'));
      }
      for (const snapshot of safety.interactionSnapshots) {
        record('safety', safetyEventsEvidenceFromSnapshot(snapshot, 'INTERACTION'));
      }
      for (const ledger of safety.stressLedgers) {
        record('safety', safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE'));
      }

      // 7. page rule を評価する。Interaction の Safety の Evidence は、ここまでに Rule の入力にそろっている（設計書 4.3）。
      findings = this.#evaluateRules(url, pageId, profile, evidence, reasons);
      stages?.recordPendingCrash('rules');
    } finally {
      // 8. page と Context を必ず閉じる。閉じる処理の失敗も、理由として記録する。ページの期限を過ぎて見放した段階は、
      // Context を閉じると終わる（メインスレッドが止まったページも含む。設計書 4.5.7）。
      network?.detach();
      consoleHandle?.detach();
      if (stages !== undefined) {
        page?.off('crash', stages.onCrash);
      }
      reasons.push(...await closePassiveSession(factory, context, page, this.#deadlines));
    }

    // 描画プロセスが落ちた場合は FAILED にする（設計書 4.5.4）。
    const status: ViewportAuditStatus = failed || stages?.crashed === true ? 'FAILED' : reasons.length > 0 ? 'PARTIAL' : 'AUDITED';
    return {
      result: {
        requestedUrl: url,
        finalUrl: navigation?.finalUrl ?? null,
        httpStatus: navigation?.httpStatus ?? null,
        status,
        incompleteReasons: reasons,
        navigationOutcome: navigation?.navigationOutcome ?? null,
      },
      evidence,
      findings,
      safety,
    };
  }

  /** 設計書 4.5.2 の 5。設定で無効な段階は実行しない（4.5.5）。 */
  async #collect(state: CollectionState): Promise<void> {
    const { url, pageId, profile, page, viewportSize, collectorDeadlineAtMs, reasons, safety, record, attempt } = state;
    const config = this.#config;
    const collectors = this.#collectors;
    const deadlineAtMs = (): number => this.#stageDeadline(collectorDeadlineAtMs, null);

    const dom = await attempt('dom', () => collectors.collectDomEvidence(page, pageId));
    if (dom.ok) {
      record('dom', dom.value);
    }

    const primary = await attempt('layout', () => collectors.collectLayoutEvidence(page, viewportSize, { deadlineAtMs: deadlineAtMs() }));
    if (primary.ok) {
      if (primary.value.status === 'PARTIAL') {
        reasons.push(collectorIncompleteReason('layout', primary.value.reason));
      }
      // 幅の走査は Desktop で1回だけ行い、Mobile の `stressSweep` は null にする（設計書 4.5.6）。
      let stressSweep: EvidencePayloadByType['layout']['stressSweep'] = null;
      if (profile === 'desktop') {
        // 幅の走査のセッションの作成と終了も、期限付きで待つ（DEF-008）。作成の期限の上限は、幅の走査に渡す期限（ページの期限から
        // 余裕の分だけ前の `collectorDeadlineAtMs`）である。期限の注入（R15r-4）も、そのまま渡す。
        const sessions = createStressSessionFactory(this.#factory, { deadlines: this.#deadlines, notAfterMs: collectorDeadlineAtMs });
        // 違反を検出した後は、幅の走査の次の幅を始めない（Task 19 の前の整理の設計書 4.5）。各幅のセッションを作る前に確かめ、違反が
        // あれば作らずに段階を止める（理由は `stress-layout:SAFETY_VIOLATION_ABORT`）。始めた幅のセッションの Ledger は、今までどおり残る。
        const createSession: StressSessionFactory['createSession'] = async (viewport) => {
          if (this.#safetyViolationRecorded()) {
            throw new SafetyViolationAbortError();
          }
          return sessions.createSession(viewport);
        };
        // 幅の走査は、この page ではなく幅ごとの Context で行うので、この page の crash とも、ページの期限とも競わせない
        // （走査は、ページの期限を受け取って自分で守る）。途中で見放すと、走査のセッションが監査の後まで残るためである。
        // セッションを閉じる処理の期限切れは、`stress-layout:CLOSE_DEADLINE_EXCEEDED` として記録する（RP18r の Minor-2）。
        // 幅のセッションの中で違反が起き、Guard がその Context を閉じた場合、段階は、そのセッションの後始末の失敗（Guard が無効にした
        // Context の page は閉じられない）で止まる。その場合も、違反で止まったことが分かる `stress-layout:SAFETY_VIOLATION_ABORT` にする
        // （C18i、RC18b の N2。違反の検出は、注入された確かめ（Run Coordinator が持つ）だけで行う）。
        const swept = await attempt(
          'stress-layout',
          () => collectors.collectStressLayout(createSession, url, stressSweepWidths(config), { deadlineAtMs: deadlineAtMs() }),
          null,
          (error) => (this.#safetyViolationRecorded() ? SAFETY_VIOLATION_ABORT_CODE : stressSweepFailureReason(error)),
        );
        safety.stressLedgers.push(...sessions.ledgers());
        if (swept.ok) {
          stressSweep = swept.value;
          const sweepReasons = new Set(
            swept.value.flatMap((result) => (result.status === 'COMPLETE' ? [] : [result.reason])),
          );
          reasons.push(...[...sweepReasons].map((reason) => collectorIncompleteReason('stress-layout', reason)));
        }
      }
      record('layout', { primary: primary.value, stressSweep });
    }

    const color = await attempt('color', () => collectors.collectColorEvidence(page));
    if (color.ok) {
      record('color', color.value);
    }

    if (config.audit.accessibility) {
      const accessibility = await attempt('accessibility', () =>
        collectors.collectAccessibilityEvidence(page, { deadlineAtMs: deadlineAtMs() }));
      if (accessibility.ok) {
        record('accessibility', accessibility.value);
        if (accessibility.value.status === 'PARTIAL') {
          reasons.push(collectorIncompleteReason('accessibility', accessibility.value.reason));
        }
      }
    }

    if (config.audit.performance && state.performanceInstalled) {
      const network = state.network;
      const performance = await attempt('performance', async () =>
        collectors.performance.collect(page, await network.snapshot(), { deadlineAtMs: deadlineAtMs() }));
      if (performance.ok) {
        record('performance', performance.value);
        if (performance.value.status === 'PARTIAL') {
          reasons.push(collectorIncompleteReason('performance', performance.value.reason));
        }
      }
    }

    if (config.audit.screenshots) {
      const paths = screenshotCapturePaths(this.#screenshotRootDirectory, pageId, profile, state.screenshotRetryAttempt);
      // 途中まで書いたファイルを消す（呼び出し側の責任）。消す処理の失敗は、元の失敗を隠さないように無視する。
      const removeScreenshotFiles = async (): Promise<void> => {
        await Promise.allSettled([
          rm(paths.viewportCapture.outputPath, { force: true }),
          rm(paths.fullPageCapture.outputPath, { force: true }),
        ]);
      };
      // 期限切れや crash で見放した撮影が、後で終わった場合も、Evidence のないファイルを残さない。
      let abandoned = false;
      const screenshots = await attempt('screenshot', async () => {
        try {
          const captured = await collectors.captureScreenshots(page, paths);
          if (abandoned) {
            await removeScreenshotFiles();
          }
          return captured;
        } catch (error) {
          await removeScreenshotFiles();
          throw error;
        }
      });
      if (!screenshots.ok) {
        abandoned = true;
        await removeScreenshotFiles();
      }
      if (screenshots.ok) {
        for (const screenshot of screenshots.value) {
          record('screenshot', screenshot);
        }
      }
    }

    // Link は Desktop のときだけ、1回だけ抽出する（ARCH03、設計書 4.4）。
    if (profile === 'desktop') {
      const links = await attempt('links', () => collectors.discoverLinks(page, pageId, {
        allowedOrigins: new Set(config.site.allowedOrigins),
        allowedQueryParameters: state.allowedQueryParameters,
      }));
      if (links.ok) {
        record('link', links.value);
      }
    }

    // Interaction は、Link の抽出の後、Safety の Evidence と Rule の評価の前に、Desktop だけで行う（設計書 4.5.2）。
    if (profile === 'desktop' && config.audit.interactions) {
      await this.#auditInteractions(state);
    }
  }

  /**
   * Interaction の段階（設計書 4.3.1、4.5.7、4.5.8）。Passive の page で候補を見つけ、除外されるものも含めて、
   * 見つけた順にすべて `auditInteraction` に渡す（呼び出しの前に取り除かない）。
   * 各候補の結果は、Evidence の部分を `interaction` の Evidence に記録し、Safety の snapshot は、INTERACTION の safety の
   * Evidence と違反の集計に使う。候補の結果の状態（NOT_VERIFIABLE など）では、ビューポートの状態を変えない。
   */
  async #auditInteractions(state: CollectionState): Promise<void> {
    const { url, page, viewportSize, reasons, safety, record, attempt, stages } = state;

    // 候補の発見は Passive の page で行うので、Passive の段階と同じく、crash と競わせ、ページの期限まで待つ（4.5.7、R14r の Minor-1）。
    const discovery = await attempt('interaction-discovery', () => this.#collectors.discoverInteractionCandidates(page));
    if (!discovery.ok) {
      return;
    }
    // Interaction の段階の予算は、Passive の段階とは別に、候補の発見が終わった時刻から数える（4.5.7）。
    // 1件目の候補も、この時刻から数える。そうすると、設定の検証を通った設定（ページの期限 ≧ 候補1つの見積もり）なら、
    // 1件目の候補が予算に収まる。
    const discoveryFinishedAtMs = this.#now();
    const interactionStageDeadlineAtMs = discoveryFinishedAtMs + this.#config.crawl.overallPageTimeoutMs;
    const { candidates, completeness } = discovery.value;
    if (completeness !== 'COMPLETE') {
      reasons.push(collectorIncompleteReason('interaction-discovery', completeness));
    }

    for (const [index, candidate] of candidates.entries()) {
      // Passive の page の crash などで段階を止めた後は、残りの候補を監査しない。
      if (stages.stopped) {
        return;
      }
      // 違反を検出した後は、次の候補を始めない（Task 19 の前の整理の設計書 4.5）。始めなかった候補の件数を、途中で止めた理由に残す。
      if (this.#safetyViolationRecorded()) {
        reasons.push(interactionStoppedReason(INTERACTION_STOP_REASONS.safety, candidates.length - index));
        return;
      }
      const deadlineAtMs = this.#interactionCandidateDeadline(
        interactionStageDeadlineAtMs,
        index === 0 ? discoveryFinishedAtMs : this.#now(),
      );
      if (deadlineAtMs === null) {
        reasons.push(interactionStoppedReason(INTERACTION_STOP_REASONS.budget, candidates.length - index));
        return;
      }
      // 候補は隔離した Context で監査するので、Passive の page の crash とも、ページの期限とも競わせない（幅の走査と同じ）。
      // 候補の監査は、候補ごとの期限（`deadlineAtMs`）を受け取って自分で守る。
      const audited = await attempt(
        'interaction',
        () => this.#auditInteractionCandidate(url, candidate, viewportSize, deadlineAtMs, { reasons, safety }),
        null,
      );
      if (!audited.ok) {
        continue;
      }
      if (audited.value.kind === 'CLEANUP_FAILED') {
        safety.interactionSnapshots.push(audited.value.safety);
        reasons.push(interactionStoppedReason(INTERACTION_STOP_REASONS.cleanup, candidates.length - index - 1));
        return;
      }
      const { safety: snapshot, ...interaction } = audited.value.result;
      record('interaction', interaction);
      safety.interactionSnapshots.push(snapshot);
    }
  }

  /**
   * 候補1つを `auditInteraction` で監査する。`InteractionOwnerCleanupError` の場合は、エラーが保持する session で `close()` を
   * 1回だけ、`INTERACTION_CLEANUP_ALLOWANCE_MS` を上限に試み、エラーが保持する Safety の snapshot を返す（設計書 4.5.8）。
   * session を作る処理が `ContextConstructionError` を投げた場合は、Guard がまだ Context を閉じていなければ閉じてから、投げ直す。
   * エラーが持つ Ledger は、閉じた後の snapshot を INTERACTION の Safety の記録に加える（Guard が Context を閉じていた場合も含む）。
   * 閉じる処理の失敗は、場面 `interaction-context-close` の理由として記録する（設計書 4.3、4.5.5、R14 の I2、R14r の Important-1・Minor-3）。
   */
  async #auditInteractionCandidate(
    url: NormalizedHttpUrlEvidence,
    candidate: InteractionCandidate,
    viewportSize: Viewport,
    deadlineAtMs: number,
    sink: Pick<CollectionState, 'reasons' | 'safety'>,
  ): Promise<InteractionCandidateOutcome> {
    const factory = this.#factory;
    const deadlines = this.#deadlines;
    try {
      const result = await auditInteraction({
        sessionFactory: (viewport) => factory.createInteractionSession(viewport),
        targetUrl: url,
        candidate,
        viewport: viewportSize,
        navigationTimeoutMs: this.#config.crawl.navigationTimeoutMs,
        timeoutMs: this.#config.crawl.interactionTimeoutMs,
        deadlineAtMs,
        // session の作成と、凍結の失敗の後の無効化を、期限付きで待つ（DEF-008。Task 18 の前の整理の設計書 4.4）。凍結を待つ処理は、
        // Context を閉じる処理を待つので、その期限（`contextCloseTimeoutMs`）を使う。
        sessionOpenTimeoutMs: deadlines.sessionOpenTimeoutMs,
        freezeActivationTimeoutMs: deadlines.contextCloseTimeoutMs,
        // 作成の期限を過ぎた後に届いた `ContextConstructionError` の Context は、Passive と同じ部品で閉じる（設計書 4.2）。
        releaseLateSessionFailure: (error) => releaseLatePassiveContextFailure(factory, error, deadlines),
      });
      return { kind: 'AUDITED', result };
    } catch (error) {
      if (error instanceof InteractionOwnerCleanupError) {
        await closeAbandonedInteractionSession(error.session, this.#now() + INTERACTION_CLEANUP_ALLOWANCE_MS);
        return { kind: 'CLEANUP_FAILED', safety: error.safety };
      }
      if (error instanceof ContextConstructionError) {
        // Guard が Context を閉じた場合も、エラーが持つ Ledger を含める（R14r の Important-1）。閉じていなければ閉じる。
        sink.reasons.push(...await closePassiveSession(
          factory,
          error.context,
          undefined,
          deadlines,
          SESSION_FAILURE_LABELS.interactionContextClose,
        ));
        sink.safety.interactionSnapshots.push(error.ledger.snapshot());
      }
      throw error;
    }
  }

  /**
   * 次の Interaction の候補の期限（設計書 4.5.7。計算はここだけで行う）。段階の期限と「候補の開始の時刻 + 候補1つの予算」の早い方とする。
   * 候補1つの予算は、`navigationTimeoutMs` と、`interactionTimeoutMs` の2倍の和である。
   * 候補の開始の時刻は、1件目は候補の発見が終わった時刻、2件目以降は現在の時刻である（呼び出し側が渡す）。
   * 予算の全体が段階の期限に収まらない場合は、`null`（そこで止める）を返す。
   */
  #interactionCandidateDeadline(interactionStageDeadlineAtMs: number, candidateStartedAtMs: number): number | null {
    const { navigationTimeoutMs, interactionTimeoutMs } = this.#config.crawl;
    const candidateBudgetMs = navigationTimeoutMs + interactionTimeoutMs * INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE;
    const deadlineAtMs = stageDeadline(interactionStageDeadlineAtMs, candidateStartedAtMs, candidateBudgetMs);
    return deadlineAtMs - candidateStartedAtMs >= candidateBudgetMs ? deadlineAtMs : null;
  }

  /**
   * 採番器の現在の Finding の連番から `RuleEngine` を作って評価し、`nextFindingSequence` を採番器に戻す（設計書 4.5.3）。
   * 評価の失敗は `RULE_EVALUATION_FAILED`（`detail` は `<ruleId>:<内容>`）として記録する。
   */
  #evaluateRules(
    url: NormalizedHttpUrlEvidence,
    pageId: PageId,
    profile: ViewportProfile,
    evidence: readonly EvidenceRecord[],
    reasons: IncompleteReason[],
  ): readonly Finding[] {
    try {
      const engine = this.#createRuleEngine(this.#allocator.nextFindingSequence);
      const evaluated = engine.evaluate({ pageId, pageUrl: url, viewport: profile, evidence: [...evidence] });
      this.#allocator.advanceFindingSequence(evaluated.nextFindingSequence);
      reasons.push(...evaluated.failures.map(ruleEvaluationFailureReason));
      return evaluated.findings;
    } catch (error) {
      reasons.push(Object.freeze({ code: 'RULE_EVALUATION_FAILED', detail: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) }));
      return [];
    }
  }

  #stageDeadline(pageDeadlineAtMs: number, stageBudgetMs: number | null): number {
    return stageDeadline(pageDeadlineAtMs, this.#now(), stageBudgetMs);
  }
}

interface CollectionState {
  readonly url: NormalizedHttpUrlEvidence;
  readonly pageId: PageId;
  readonly profile: ViewportProfile;
  readonly page: Page;
  readonly viewportSize: Viewport;
  /** 期限を受け取る collector に渡す期限の上限（ページの期限 − `COLLECTOR_DEADLINE_MARGIN_MS`。設計書 4.5.7）。 */
  readonly collectorDeadlineAtMs: number;
  readonly allowedQueryParameters: ReadonlySet<string>;
  readonly performanceInstalled: boolean;
  readonly network: CollectorHandle<EvidencePayloadByType['network']>;
  /** 再試行の前の試行なら、その試行の番号（スクリーンショットを `retry-<番号>` に置く。DEF-007）。そうでなければ `null`。 */
  readonly screenshotRetryAttempt: number | null;
  readonly reasons: IncompleteReason[];
  readonly safety: ViewportSafetySources;
  readonly record: <TType extends EvidenceType>(type: TType, payload: EvidencePayloadByType[TType]) => EvidenceRecord;
  /**
   * 段階を実行する。`abandonAtMs` は、見放す時刻（省略するとページの期限。`null` なら見放さない）。
   * `failureReason` は、例外から理由を決める関数（`StageRunner.attempt`）。
   */
  readonly attempt: <T>(
    stage: PageAuditStage,
    work: () => Promise<T>,
    abandonAtMs?: number | null,
    failureReason?: StageFailureReason,
  ) => Promise<StageAttempt<T>>;
  readonly stages: StageRunner;
}

const STAGE_NOT_COMPLETED: StageAttempt<never> = Object.freeze({ ok: false });

/** crash した段階の理由（`COLLECTOR_INCOMPLETE` の `detail` の `<段階>:PAGE_CRASHED`。設計書 4.5.4）。 */
const PAGE_CRASHED_REASON: Extract<IncompleteReasonCode, 'PAGE_CRASHED'> = 'PAGE_CRASHED';

/** ページの期限を過ぎた段階の理由（`COLLECTOR_INCOMPLETE` の `detail` の `<段階>:DEADLINE_EXCEEDED`。設計書 4.5.7）。 */
const DEADLINE_EXCEEDED_REASON: Extract<PartialFailureReason, 'DEADLINE_EXCEEDED'> = 'DEADLINE_EXCEEDED';

/**
 * 段階の例外から、`COLLECTOR_INCOMPLETE` の `detail` の `<理由>` を決める関数（`StageRunner.attempt`）。
 * `null` を返した場合は、既定の `pageFailureReason(page)` を使う。
 */
type StageFailureReason = (error: unknown) => string | null;

/**
 * 幅の走査のセッションを閉じる処理が期限を過ぎた段階の理由（`COLLECTOR_INCOMPLETE` の `detail` の `stress-layout:CLOSE_DEADLINE_EXCEEDED`。
 * RP18r の Minor-2）。新しい理由のコードは加えず、既存のコードの `detail` で表す。
 */
const CLOSE_DEADLINE_EXCEEDED_REASON = 'CLOSE_DEADLINE_EXCEEDED';

/** 閉じる処理の期限切れ（page か Context）を、例外そのものか、`AggregateError` の中（入れ子を含む）に含むか。 */
function includesCloseDeadline(error: unknown): boolean {
  if (error instanceof PassivePageCloseDeadlineError || error instanceof PassiveContextCloseDeadlineError) {
    return true;
  }
  return error instanceof AggregateError && Array.isArray(error.errors) && error.errors.some(includesCloseDeadline);
}

/**
 * 幅の走査の段階の例外から、理由を決める（RP18r の Minor-2、C18f）。
 * - 違反を検出したため、次の幅のセッションを作らなかった: `SAFETY_VIOLATION_ABORT`
 * - セッションを閉じる処理の期限切れを含む: `CLOSE_DEADLINE_EXCEEDED`
 * - そのほか: `null`（既定の `pageFailureReason(page)`）
 */
const stressSweepFailureReason: StageFailureReason = (error) => {
  if (error instanceof SafetyViolationAbortError) {
    return SAFETY_VIOLATION_ABORT_CODE;
  }
  return includesCloseDeadline(error) ? CLOSE_DEADLINE_EXCEEDED_REASON : null;
};

/**
 * 1つのビューポートの Passive の page に対する段階の実行と、それを止める事象（描画プロセスの crash と、ページの期限）を扱う。
 *
 * - crash した page への操作は、終わらないことがある（例: `locator.evaluateAll`）。メインスレッドが止まったページへの操作も、
 *   終わらない（R14 の I1）。そのため、Passive の page に対する段階は、crash と競わせ、見放す時刻（ページの期限）まで待つ
 *   （`awaitBeforeDeadline`）。見放した処理の、遅れて返る結果や reject は封じ込める。見放した処理は、Context を閉じると終わる。
 * - crash を見つけた場合は、crash したときに処理中だった段階（なければ、見つけた時点の段階）を `<段階>:PAGE_CRASHED` として
 *   1回だけ記録する（設計書 4.5.4）。見放す時刻を過ぎた場合は、その段階を `<段階>:DEADLINE_EXCEEDED` として記録する（4.5.7）。
 *   どちらの場合も、それより後の段階は、実行も記録もしない。
 */
class StageRunner {
  readonly #page: Page;
  readonly #reasons: IncompleteReason[];
  readonly #now: () => number;
  #crashed = false;
  #crashRecorded = false;
  #stopped = false;
  #currentStage: PageAuditStage | null = null;
  #crashedDuringStage: PageAuditStage | null = null;
  #resolveCrashSignal: () => void = () => undefined;
  /** crash したときに解決する。 */
  readonly #crashSignal: Promise<void> = new Promise<void>((resolve) => {
    this.#resolveCrashSignal = resolve;
  });

  constructor(page: Page, reasons: IncompleteReason[], now: () => number) {
    this.#page = page;
    this.#reasons = reasons;
    this.#now = now;
  }

  /** page の `crash` の事象の listener。 */
  readonly onCrash = (): void => {
    if (!this.#crashed) {
      this.#crashed = true;
      this.#crashedDuringStage = this.#currentStage;
    }
    this.#resolveCrashSignal();
  };

  get crashed(): boolean {
    return this.#crashed;
  }

  /** crash か期限切れを記録した後は、残りの段階を実行しない。 */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** `work` の間、`stage` を処理中の段階とする（crash の段階を記すため）。 */
  async during<T>(stage: PageAuditStage, work: () => Promise<T>): Promise<T> {
    this.#currentStage = stage;
    try {
      return await work();
    } finally {
      if (this.#currentStage === stage) {
        this.#currentStage = null;
      }
    }
  }

  /**
   * 1つの段階を実行する。例外を投げた場合は、`COLLECTOR_INCOMPLETE`（`<段階>:<pageFailureReason(page)>`）を記録し、
   * Evidence を記録しない（設計書 4.5.5）。
   * `abandonAtMs` が数なら、crash と競わせ、その時刻まで待つ。`null` なら、見放さずに終わりを待つ（Passive の page ではなく、
   * 自分で期限を守る別の Context で行う段階。幅の走査と、Interaction の候補）。その場合も、終わった時点で crash していれば記録する。
   * `failureReason` を渡した場合は、例外のときの `<理由>` を、まずその関数で決める（`null` を返せば `pageFailureReason(page)`）。
   */
  async attempt<T>(
    stage: PageAuditStage,
    work: () => Promise<T>,
    abandonAtMs: number | null,
    failureReason?: StageFailureReason,
  ): Promise<StageAttempt<T>> {
    if (this.#stopped) {
      return STAGE_NOT_COMPLETED;
    }
    if (this.#crashed) {
      this.#recordCrash(stage);
      return STAGE_NOT_COMPLETED;
    }
    if (abandonAtMs !== null && this.#now() >= abandonAtMs) {
      this.#recordDeadlineExceeded(stage);
      return STAGE_NOT_COMPLETED;
    }
    let failure: { readonly error: unknown } | undefined;
    const running = this.during(stage, work).then(
      (value): StageAttempt<T> => ({ ok: true, value }),
      (error: unknown): StageAttempt<T> => {
        failure = { error };
        return STAGE_NOT_COMPLETED;
      },
    );
    let settled: StageAttempt<T> | typeof DEADLINE_EXCEEDED_REASON;
    if (abandonAtMs === null) {
      settled = await running;
    } else {
      const raced = await awaitBeforeDeadline(
        Promise.race([running, this.#crashSignal.then((): StageAttempt<T> => STAGE_NOT_COMPLETED)]),
        abandonAtMs,
      );
      settled = raced.status === 'FULFILLED'
        ? raced.value
        : raced.status === 'DEADLINE_EXCEEDED' ? DEADLINE_EXCEEDED_REASON : STAGE_NOT_COMPLETED;
    }
    if (this.#crashed) {
      // 見放さない段階は、crash の後も、別の Context での結果を得る。その結果は記録する。
      this.#recordCrash(stage);
      return settled !== DEADLINE_EXCEEDED_REASON && settled.ok ? settled : STAGE_NOT_COMPLETED;
    }
    if (settled === DEADLINE_EXCEEDED_REASON) {
      this.#recordDeadlineExceeded(stage);
      return STAGE_NOT_COMPLETED;
    }
    if (settled.ok) {
      return settled;
    }
    const reason = failure === undefined || failureReason === undefined ? null : failureReason(failure.error);
    this.#reasons.push(collectorIncompleteReason(stage, reason ?? pageFailureReason(this.#page)));
    return STAGE_NOT_COMPLETED;
  }

  /**
   * 段階の外（全部の段階を終えた後など）で crash を見つけていて、まだ理由を記録していなければ、記録する（R14 の m1）。
   * 段階は、crash したときに処理中だった段階とし、なければ `stage`（`safety` か `rules`）とする。
   */
  recordPendingCrash(stage: PageAuditStage): void {
    if (this.#crashed) {
      this.#recordCrash(stage);
    }
  }

  #recordCrash(stage: PageAuditStage): void {
    if (!this.#crashRecorded) {
      this.#crashRecorded = true;
      this.#reasons.push(collectorIncompleteReason(this.#crashedDuringStage ?? stage, PAGE_CRASHED_REASON));
    }
    this.#stopped = true;
  }

  #recordDeadlineExceeded(stage: PageAuditStage): void {
    this.#reasons.push(collectorIncompleteReason(stage, DEADLINE_EXCEEDED_REASON));
    this.#stopped = true;
  }
}

/** Node 側に集めた collector の記録を読む。失敗は `StageRunner.attempt` と同じ形で記録する。crash とも期限とも競わせない。 */
async function snapshotCollector<TEvidence>(
  stage: PageAuditStage,
  page: Page,
  reasons: IncompleteReason[],
  handle: CollectorHandle<TEvidence>,
): Promise<StageAttempt<TEvidence>> {
  try {
    return { ok: true, value: await handle.snapshot() };
  } catch {
    reasons.push(collectorIncompleteReason(stage, pageFailureReason(page)));
    return STAGE_NOT_COMPLETED;
  }
}

/** Chromium のネットワークのエラーのコード（例: `net::ERR_CONNECTION_REFUSED`）の形。 */
const CHROMIUM_NET_ERROR_CODE_PATTERN = /\bnet::ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*/u;

/** `FAILED` の detail の、結果の種類とエラーのコードの区切り（`FAILED:<Chromium のエラーのコード>`）。 */
const NAVIGATION_FAILURE_DETAIL_SEPARATOR = ':';

/**
 * ナビゲーションの失敗の詳細（`navigatePage` の `failureDetail`）から、Chromium のネットワークのエラーのコードを取り出す
 * （Task 14〜17 の設計書 5.6.4）。最初に現れたコードを返す。コードがない場合は `null`。取り出す処理は、ここだけで行う。
 */
export function chromiumNetErrorCode(failureDetail: string | null): string | null {
  if (typeof failureDetail !== 'string') {
    return null;
  }
  return CHROMIUM_NET_ERROR_CODE_PATTERN.exec(failureDetail)?.[0] ?? null;
}

/**
 * ナビゲーションが失敗したときの理由（`NAVIGATION_FAILED`）の `detail`（Task 14〜17 の設計書 4.5.4、5.6.4）。
 * - 期限切れ: `TIMEOUT`
 * - 外部へのリダイレクトの遮断: `BLOCKED_EXTERNAL_REDIRECT`
 * - そのほかの失敗: `FAILED:<Chromium のエラーのコード>`（例: `FAILED:net::ERR_CONNECTION_RESET`）。コードがない場合は `FAILED`。
 *
 * Run Coordinator は、この detail で再試行するかを判断する。`OK` は失敗ではないので `RangeError` を投げる。
 */
export function navigationFailureDetail(
  navigation: Pick<PageNavigationResult, 'navigationOutcome' | 'failureDetail'>,
): string {
  const { navigationOutcome } = navigation;
  if (navigationOutcome === 'OK') {
    throw new RangeError('navigation failure detail needs a failed navigation outcome');
  }
  if (navigationOutcome !== 'FAILED') {
    return navigationOutcome;
  }
  const code = chromiumNetErrorCode(navigation.failureDetail);
  return code === null ? navigationOutcome : `${navigationOutcome}${NAVIGATION_FAILURE_DETAIL_SEPARATOR}${code}`;
}

/** 幅の走査で調べる幅。設定の `stressWidths` から、主要な2つのビューポートの幅を除く（設計書 4.5.6）。 */
function stressSweepWidths(config: AuditConfig): readonly number[] {
  const primaryWidths = new Set(VIEWPORT_PROFILES.map((profile) => viewportSizeFor(config, profile).width));
  return config.viewports.stressWidths.filter((width) => !primaryWidths.has(width));
}

/**
 * scroll の Evidence から、未完了の理由を作る。コードは scroll の理由のコードで、`detail` は段階の名前（設計書 4.5.5）。
 * COMPLETE でも、先頭へ戻せなかった（`NOT_RESTORED`）場合は、その理由を記録する。
 */
function scrollIncompleteReasons(scroll: ScrollEvidence): IncompleteReason[] {
  const codes = new Set<IncompleteReason['code']>();
  if (scroll.status === 'PARTIAL') {
    codes.add(scroll.reason);
  }
  if (scroll.restoration.status === 'NOT_RESTORED') {
    codes.add(scroll.restoration.reason);
  }
  const stage: PageAuditStage = 'scroll';
  return [...codes].map((code) => Object.freeze({ code, detail: stage }));
}

/**
 * スクリーンショットの置き場所。パス（`pages/<pageId>/<ビューポート>/<ファイル名>`、再試行の前の試行は
 * `pages/<pageId>/retry-<retryAttempt>/<ビューポート>/<ファイル名>`。DEF-007）は、配置の owner（`src/core/artifact-layout.ts`。
 * 設計書 6.1.8、CC-023）の関数で組み立てる。ここでは、撮影の関数に渡す形にまとめるだけである。
 */
function screenshotCapturePaths(
  rootDirectory: string,
  pageId: PageId,
  profile: ViewportProfile,
  retryAttempt: number | null,
): ScreenshotCapturePaths {
  const capture = (captureType: ScreenshotCaptureType): ScreenshotCapturePaths['viewportCapture'] => {
    const relativeArtifactPath = screenshotRelativePath(pageId, profile, captureType, retryAttempt);
    return { outputPath: artifactFilePath(rootDirectory, relativeArtifactPath), relativeArtifactPath };
  };
  return {
    pageId,
    viewport: profile,
    viewportCapture: capture('VIEWPORT'),
    fullPageCapture: capture('FULL_PAGE'),
  };
}

/**
 * 違反を検出したため、始めなかったビューポートの結果（Task 19 の前の整理の設計書 4.5。C18f）。状態は `SKIPPED`、理由は
 * `SAFETY_VIOLATION_ABORT` で、Evidence、Finding、Safety の記録はない。ビューポートの結果の形は、監査しなかった URL の結果
 * （`skippedPageResult`）と同じものを使う。
 */
function safetyAbortedViewportOutcome(
  url: NormalizedHttpUrlEvidence,
  pageId: PageId,
  profile: ViewportProfile,
): ViewportAuditOutcome {
  return {
    result: skippedPageResult(url, pageId, SAFETY_VIOLATION_ABORT_REASON).viewports[profile],
    evidence: [],
    findings: [],
    safety: { passiveLedgers: [], interactionSnapshots: [], stressLedgers: [] },
  };
}

/**
 * Interaction の段階を途中で止めた理由。`detail` は `interaction:<理由>:remaining=<監査しなかった候補の件数>`（設計書 4.5.7、4.5.8）。
 */
function interactionStoppedReason(reason: InteractionStopReason, remainingCandidateCount: number): IncompleteReason {
  return collectorIncompleteReason('interaction', `${reason}:remaining=${remainingCandidateCount}`);
}

/**
 * `InteractionOwnerCleanupError` が保持する、まだ閉じていない session の `close()` を1回だけ試みる（設計書 4.5.8）。
 * `deadlineAtMs` を過ぎたら、終わりを待たない。失敗は投げない（理由の `interaction:cleanup` と、エラーが保持する Safety の
 * snapshot の違反で、すでに記録している）。
 */
async function closeAbandonedInteractionSession(session: InteractionAuditSession, deadlineAtMs: number): Promise<void> {
  await awaitBeforeDeadline((async (): Promise<void> => session.close())(), deadlineAtMs);
}

/**
 * 場面 `label` の `UNHANDLED_FAILURE` の理由（組み立ては `unhandledFailureReason`）。
 * `ContextConstructionError` の場合は、元の原因（`cause`）のメッセージも、`<メッセージ>: <原因のメッセージ>` の形で、同じ上限の中に
 * 含める（R14r2 の Minor-1。エラー自体のメッセージは固定の文言で、原因を表さないため）。
 */
function sessionFailureReason(label: string, error: unknown): IncompleteReason {
  const message = error instanceof ContextConstructionError
    ? `${safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)}: ${safeErrorMessage(error.cause, MAX_ERROR_MESSAGE_LENGTH)}`
    : error;
  return unhandledFailureReason(label, message);
}

/**
 * page と Context を `closePassivePageAndContext` で閉じる（page を閉じてから Context を閉じる。Guard がすでに Context を
 * 閉じていれば、Context は閉じ直さない）。どちらも期限（`deadlines` の `pageCloseTimeoutMs`、`contextCloseTimeoutMs`）付きで待つ
 * （DEF-006、DEF-008）。失敗（期限切れを含む）は投げずに、`UNHANDLED_FAILURE` の理由として返す（隠さない）。
 */
async function closePassiveSession(
  factory: BrowserContextFactory,
  context: BrowserContext | undefined,
  page: Page | undefined,
  deadlines: ResolvedPassiveSessionDeadlines,
  contextCloseLabel: ContextCloseLabel = SESSION_FAILURE_LABELS.contextClose,
): Promise<IncompleteReason[]> {
  return closeFailureReasons(await closePassivePageAndContext(factory, context, page, deadlines), contextCloseLabel);
}

/** 閉じる処理の失敗を、場面（page は `passive-page-close`、Context は `contextCloseLabel`）の `UNHANDLED_FAILURE` の理由にする。 */
function closeFailureReasons(
  failures: readonly PassiveSessionCloseFailure[],
  contextCloseLabel: ContextCloseLabel = SESSION_FAILURE_LABELS.contextClose,
): IncompleteReason[] {
  return failures.map(({ step, error }) =>
    sessionFailureReason(step === 'page' ? SESSION_FAILURE_LABELS.pageClose : contextCloseLabel, error));
}

/**
 * Passive の Context と page の作成が期限を過ぎたときの理由（DEF-008。Task 18 の前の整理の設計書 4.4）。コードは `DEADLINE_EXCEEDED`、
 * `detail` は作成の場面の名前（`passive-context`）。ページの期限を過ぎた段階の理由（`<段階>:DEADLINE_EXCEEDED`）と同じく期限切れを表し、
 * 作成のほかの失敗（`UNHANDLED_FAILURE` の `passive-context:<メッセージ>`）とは区別する。
 */
function sessionOpenDeadlineReason(): IncompleteReason {
  return Object.freeze({ code: DEADLINE_EXCEEDED_REASON, detail: SESSION_FAILURE_LABELS.open });
}

/**
 * ページ全体の理由。両方のビューポートの理由を、Desktop、Mobile の順に並べ、同じコードと `detail` の理由を1つにする。
 * ビューポートごとの理由は、`viewports.<profile>.incompleteReasons` に残る。
 */
function pageIncompleteReasons(results: readonly ViewportAuditResult[]): IncompleteReason[] {
  const seen = new Set<string>();
  const reasons: IncompleteReason[] = [];
  for (const reason of results.flatMap((result) => result.incompleteReasons)) {
    const key = JSON.stringify([reason.code, reason.detail]);
    if (!seen.has(key)) {
      seen.add(key);
      reasons.push(reason);
    }
  }
  return reasons;
}
