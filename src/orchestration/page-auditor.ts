import { rm } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { RuleEngine } from '../audit/rule-engine.js';
import { focusCheckOutcomeOf, isHiddenFocusCheckOutcome } from '../audit/focus-check.js';
import { revealTargetsOfLayout } from '../audit/overlap-pairs.js';
import { ContextConstructionError, type BrowserContextFactory } from '../browser/context-factory.js';
import { controlledScroll } from '../browser/controlled-scroll.js';
import type { MainFrameLoadObservation } from '../browser/main-frame-load.js';
import { pageFailureReason } from '../browser/page-failure.js';
import { waitForPageSettled, type PageSettlingResult } from '../browser/page-settling.js';
import type { AuditConfig, Viewport } from '../config/types.js';
import { viewportSizeFor } from '../config/viewport-size.js';
import { artifactFilePath, beforeHideScreenshotRelativePath, screenshotRelativePath } from '../core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  evidenceStateIdOf,
  openedEvidenceStateIdOf,
  type EvidenceCapture,
  type EvidenceId,
  type EvidenceCaptureScrollPosition,
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
  type EvidenceStateId,
  type RecheckFindingRecord,
  type RecheckHeadingRecord,
  type ViewportNotificationHandlingRecord,
  type ViewportProfile,
  type ViewportRecheckRecord,
  type ViewportSettlingRecord,
} from '../core/contracts.js';
import { createFindingId } from '../core/ids.js';
import { stateReadyOf } from '../core/page-readiness.js';
import { recheckStatesOf } from '../core/recheck.js';
import { awaitBeforeDeadline, resolveTimeoutMs } from '../core/deadline.js';
import type { PassiveStressSessionFactory, ResizedStressLayoutOptions, StressLayoutOptions } from '../evidence/layout-collector.js';
import type { InteractionAuditInput } from '../interaction/isolated-auditor.js';
import { checkDialogFocus, type DialogFocusCheckOptions } from '../interaction/dialog-focus-check.js';
import type { SessionLossEvidenceInput } from './authenticated-run.js';
import {
  interactionCandidateStepOf,
  nextLoadMayStart,
  pageAuditDepthOf,
  pageAuditStagesOf,
  RUN_TIME_LIMIT_SKIP_REASON,
  stressWidthAbortOf,
  viewportSkipReasonOf,
  waitsWithPageShown,
  DOWNLOAD_RESPONSE_REASON,
  type PageAuditDepthDecision,
  type PageSamenessPort,
} from './page-audit-plan.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  PROGRESS_SIGNAL_KINDS,
  PROGRESS_WATCH_QUIET_LIMIT_MS,
  progressWatchEndReason,
  watchProgress,
  type ProgressSignalKind,
  type ProgressSignals,
  type ProgressWatchEnd,
  type ProgressWatchOptions,
  type WatchedOutcome,
} from '../core/progress-watch.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import {
  PAGE_SCHEMA_VERSION,
  SCROLLABLE_REGION_AXE_RULE_ID,
  type NormalizedHttpUrlEvidence,
  type SafetyEvidenceLoad,
  type ScreenshotCaptureType,
  type ScreenshotEvidence,
  type ScrollEvidence,
  type SessionLossEvidence,
  type LayoutCollectionResult,
  type EvidenceStateMark,
  type LayoutEvidence,
  type NotificationFrameEvidence,
  type NotificationOverlayEvidence,
  type RevealTargetSpec,
  type OpenedStateEvidence,
  type OpenedStateStatus,
  type StressNotificationOverlayEvidence,
  type StressLayoutEvidence,
  type FocusCheckEvidence,
  type DialogFocusEvidence,
  type RevealCaptureEvidence,
} from '../core/evidence-types.js';
import { isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import { DEBUG_TIMING_OFF, type DebugTimingLog, type DebugTimingScope } from '../core/debug-timing.js';
import {
  CONTROLLED_SCROLL_PACING,
  INTERACTION_CLEANUP_ALLOWANCE_MS,
  INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE,
  PAGE_SETTLING_PACING,
} from '../core/limits.js';
import {
  collectorIncompleteReason,
  derivePageAuditStatus,
  isSameContentSkippedViewport,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
} from '../core/status.js';
import { discoverLinks } from '../crawl/discover-links.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { collectAccessibilityEvidence } from '../evidence/accessibility-collector.js';
import type { CollectorHandle } from '../evidence/collector-handle.js';
import { ConsoleCollector } from '../evidence/console-collector.js';
import { collectDomEvidence, recordedDomEvidenceOf } from '../evidence/dom-collector.js';
import { collectLayoutEvidence, collectResizedStressLayout, collectStressLayout } from '../evidence/layout-collector.js';
import { stateMarkTargetSelectorsOf } from '../evidence/state-mark.js';
import {
  checkSequentialTab,
  collectFocusChecks,
  type FocusCheckOptions,
  type SequentialTabOptions,
} from '../evidence/focus-check-collector.js';
import { breakpointSideWidthsOf, readMediaQueryConditionTexts } from '../evidence/media-query-widths.js';
import { DataActivityCollector, NetworkCollector, type DataRequestActivity, type NetworkCollectorHandle } from '../evidence/network-collector.js';
import { PerformanceCollector } from '../evidence/performance-collector.js';
import {
  captureAsIs,
  checkScrollableRegions,
  revealAndCapture,
  type RevealCapturePort,
  type ScrollableRegionCheckOptions,
  type ScrollableRegionTarget,
} from '../evidence/reveal-and-capture.js';
import {
  captureScreenshots,
  captureViewportScreenshot,
  ScreenshotWatchEndedError,
  type ScreenshotCapturePaths,
} from '../evidence/screenshot-collector.js';
import { dismissNotificationFrames, readModalCandidateOrdinals, type NotificationDismissalProgress } from '../interaction/notification-overlay.js';
import { discoverInteractionCandidates, INTERACTION_CANDIDATE_SELECTOR } from '../interaction/discover-candidates.js';
import {
  auditInteraction,
  InteractionOwnerCleanupError,
  type InteractionAuditResult,
  type InteractionAuditSession,
  type InteractionPressStep,
} from '../interaction/isolated-auditor.js';
import type { InteractionCandidate } from '../safety/interaction-policy.js';
import { mobileOnlyInteractionCandidates } from './interaction-viewport-difference.js';
import { auditPageContentDigestOf, auditPageTemplateKeyOf, openedStateStructureKeyOf } from './audit-page-structure.js';
import { findingsNotInBase } from './opened-state.js';
import {
  notificationPressNavigationsOf,
  notificationPressNavigationTargetsOf,
  pageEventPhaseOf,
  pageLoadFactsOf,
  scrollKeyPressGuardOf,
} from '../safety/passive-request-guard.js';
import {
  safetyEventsEvidenceFromSnapshot,
  summarizePageSafety,
  type SafetyLedger,
  type SafetyLedgerSnapshot,
} from '../safety/safety-ledger.js';
import {
  AUTH_SESSION_LOST_SKIP_REASON,
  SESSION_LOSS_CHECK_POINTS,
  authSessionLostReason,
  observeSessionLossNavigation,
  sessionLossEvidenceOf,
  sessionLossStageDetailOf,
  sessionLostUrlAt,
  type SessionLossCheckPoint,
  type SessionLossNavigationObserver,
  type SessionLossNavigationRecord,
} from './authenticated-run.js';
import { createEvidenceRecord } from './evidence-builder.js';
import type { IdAllocator } from './id-allocator.js';
import { navigatePage, navigationFailureDetail, type PageNavigationResult } from './page-navigation.js';
import {
  auditScopeLeftUrl, movedOutsideAuditScopeNavigation, watchAuditScope, type AuditScopeJudge, type AuditScopeWatch,
} from './audit-scope-watch.js';
import {
  closePassivePageAndContext,
  PassiveContextCloseDeadlineError,
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
import {
  SITE_UNAVAILABLE_SKIP_REASON,
  siteUnavailabilityOf,
  siteUnavailableDetail,
  siteUnavailableStageDetail,
  type SiteUnavailability,
  type SiteUnavailabilityStage,
} from './site-availability.js';
import { skippedPageResult } from './skipped-page.js';
import { waitWithPageShown, withoutPacingWaitEvents, type PacingWaitOptions, type PacingWaitWindow } from './visible-pacing-wait.js';
import { OPEN_ENDED_STAGE_MS, openEndedStageDeadline } from './stage-deadline.js';
import {
  auditDocumentLeftCause,
  sameStressLayoutFacts,
  stressWidthIncompleteReasonOf,
  stressWidthSessionCloser,
  type AuditDocumentLeftCause,
} from './stress-width-end.js';
import type { OpenedPressKey } from './crawl-frontier.js';
import { createStressSessionFactory, type StressSessionOptions } from './stress-session.js';

/**
 * Page Auditor が呼ぶ collector と Link の抽出と、Interaction の候補の発見。既定は本番の関数で、テストでは一部を差し替えて
 * 例外や PARTIAL を起こせる。差し替えは呼び出しの口を変えるだけで、Link の抽出の入口（`discoverLinks`）、候補の発見の入口
 * （`discoverInteractionCandidates`）や collector の判断を別に持つものではない。
 */
export interface PageAuditCollectors {
  readonly collectDomEvidence: typeof collectDomEvidence;
  readonly collectLayoutEvidence: typeof collectLayoutEvidence;
  readonly collectStressLayout: typeof collectStressLayout;
  /** SWR: 1 回だけ読み込み、幅ごとに大きさだけを変えて回す幅の走査。 */
  readonly collectResizedStressLayout: typeof collectResizedStressLayout;
  readonly collectAccessibilityEvidence: typeof collectAccessibilityEvidence;
  readonly performance: Pick<PerformanceCollector, 'installBeforeNavigation' | 'collect' | 'readLcpBeforeScroll'>;
  readonly captureScreenshots: typeof captureScreenshots;
  /** AUD-3d: 1 枚の viewport の画像を撮る部品（幅の走査の幅と、落ち着いた後の確かめ直しの段）。 */
  readonly captureViewportScreenshot: typeof captureViewportScreenshot;
  /** AUD-4d: 画面の外の、フォーカスできる要素のフォーカスの確かめ。 */
  readonly collectFocusChecks: typeof collectFocusChecks;
  readonly discoverLinks: typeof discoverLinks;
  readonly discoverInteractionCandidates: typeof discoverInteractionCandidates;
  /** DEF-210（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.2・3.4）: 通知の枠を閉じる・隠す部品。 */
  readonly dismissNotificationFrames: typeof dismissNotificationFrames;
}

/** RB-10: 先頭の引数の page を結んだ関数の型（監査の読み込みの口は page を見せない）。 */
type PageBound<F> = F extends (page: never, ...rest: infer R) => infer O ? (...rest: R) => O : never;

/**
 * RB-10（再構築の設計書 2 章 1・3 章。plan 2 章の 9）: 監査の読み込みの口が見せる、読み込んだ 1 つの page への操作（Passive の page・幅の走査の各幅・開いた状態）。
 * 本物は `playwrightAuditLoadPortsOf` が page に結んで作り、テストだけが偽の口を渡す。口は判定しない（段の順・理由・止め方は Page Auditor に残る）。
 * Guard の事実（`loadFacts`・`pressNavigations`・`documentLeftCause`・`ledger`）は、Context を閉じた後も読める。
 */
export interface AuditView {
  /** main frame の URL（`page.url()`）。 */
  readonly url: () => string;
  readonly isClosed: () => boolean;
  /** viewport の幅（なければ `null`）。 */
  readonly viewportWidth: () => number | null;
  /** 段の例外のときの理由（`pageFailureReason`）。 */
  readonly failureReason: () => string;
  /** 描画プロセスの crash の事象を受ける。外す関数を返す。 */
  readonly onCrash: (listener: () => void) => () => void;
  /** AUD-2a: 段を終えたときの URL と位置。 */
  readonly captureLocation: () => Promise<CaptureLocation>;
  readonly attachProgressSignals: PageBound<typeof attachPageProgressSignals>;
  readonly waitForSettled: PageBound<typeof waitForPageSettled>;
  readonly controlledScroll: PageBound<typeof controlledScroll>;
  readonly readMediaQueryConditionTexts: PageBound<typeof readMediaQueryConditionTexts>;
  readonly attachDataActivity: PageBound<typeof DataActivityCollector.attach>;
  readonly collectDomEvidence: PageBound<typeof collectDomEvidence>;
  readonly collectLayoutEvidence: PageBound<typeof collectLayoutEvidence>;
  readonly collectAccessibilityEvidence: PageBound<typeof collectAccessibilityEvidence>;
  readonly collectPerformance: PageBound<PerformanceCollector['collect']>;
  /** EV-1: scroll の段の前の LCP（`PerformanceCollector.readLcpBeforeScroll`）。 */
  readonly readLcpBeforeScroll: PageBound<PerformanceCollector['readLcpBeforeScroll']>;
  readonly captureScreenshots: PageBound<typeof captureScreenshots>;
  readonly captureViewportScreenshot: PageBound<typeof captureViewportScreenshot>;
  readonly collectFocusChecks: PageBound<typeof collectFocusChecks>;
  /** EV-2: 対象まで動かして測り直して撮る部品（`revealAndCapture`）と、動かさずに測って撮る部品（`captureAsIs`。フォーカスの確かめ）。 */
  readonly revealAndCapture: PageBound<typeof revealAndCapture>;
  readonly captureAsIs: PageBound<typeof captureAsIs<EvidenceId>>;
  /** EV-4: 横にスクロールする領域の、キーボードの実操作（`checkScrollableRegions`）。 */
  readonly checkScrollableRegions: PageBound<typeof checkScrollableRegions>;
  /** AUD-3: 通常の Tab の確かめ（`checkSequentialTab`。キーを押す期間は、この page の Guard の口）。 */
  readonly checkSequentialTab: PageBound<typeof checkSequentialTab>;
  /** FRET: 窓を開くボタンの確かめ（`checkDialogFocus`。キーを押す期間は、この page の Guard の口）。 */
  readonly checkDialogFocus: (options: Omit<DialogFocusCheckOptions, 'keyPressGuard'>) => Promise<DialogFocusEvidence>;
  readonly discoverLinks: PageBound<typeof discoverLinks>;
  readonly discoverInteractionCandidates: PageBound<typeof discoverInteractionCandidates>;
  readonly dismissNotificationFrames: PageBound<typeof dismissNotificationFrames>;
  /** REV-AUD2 の I-1: 開いた状態がモーダルのとき、小窓の中の操作の候補の番号（モーダルでなければ null。`readModalCandidateOrdinals`）。 */
  readonly readModalCandidateOrdinals: (deadlineAtMs: number) => Promise<readonly number[] | null>;
  /** DEF-129・DEF-225: Guard が数えた文書の読み込みの事実（`pageLoadFactsOf`）。 */
  readonly loadFacts: () => ReturnType<typeof pageLoadFactsOf>;
  /** fix round 3: 押す期間に Guard が見た移動とポップアップの数（`notificationPressNavigationsOf`。RB-14a: 移動は止めずに数える）。 */
  readonly pressNavigations: () => number;
  /** RB-14a: 押す期間に Guard が止めずに数えた移動の行き先（`notificationPressNavigationTargetsOf`。セッションの切れの判定に使う）。 */
  readonly pressNavigationTargets: () => readonly string[];
  /** C・DEF-250 の c: page を使うのをやめる原因（その page の Ledger の記録で見る）。 */
  readonly documentLeftCause: (navigated: boolean) => AuditDocumentLeftCause | null;
  /** REV-SD の I-1: main frame の移動を見張り、点検の範囲の外へ移ったかを答える（`watchAuditScope`。判定がなければ見張らない）。読み込みの前に付ける。 */
  readonly watchAuditScope: (isOutside: AuditScopeJudge | undefined, requestedUrl: string) => AuditScopeWatch;
  /** その page の Context の Ledger（Guard が閉じた Context では投げうる）。 */
  readonly ledger: () => SafetyLedger;
  /** DEF-138: factory が残した、その Context の状態の名前（読めなければ `null`）。 */
  readonly authenticatedStateNames: () => SessionLossEvidenceInput['stateNames'];
  readonly observeSessionLossNavigation: () => SessionLossNavigationObserver;
  readonly waitWithPageShown: (options: Omit<PacingWaitOptions, 'page'>) => Promise<PacingWaitWindow | null>;
}

/** RB-10: 開いた Passive の読み込み（主の page）。 */
export interface AuditPassiveLoad {
  readonly view: AuditView;
  readonly installPerformance: () => Promise<void>;
  readonly navigate: PageBound<typeof navigatePage>;
  /** network の collector を付ける（BN-a の時点の印は Guard の決め方で付ける）。 */
  readonly attachNetwork: (approvedServiceOrigins: readonly string[]) => NetworkCollectorHandle;
  readonly attachConsole: () => CollectorHandle<EvidencePayloadByType['console']>;
}

/** RB-10: Passive の Context と page を開いた結果（`openPassiveSessionBeforeDeadline` の形。`close` は Context を閉じ、失敗を返す）。 */
export type AuditPassiveOpening =
  | { readonly status: 'OPENED'; readonly ledger: SafetyLedger; readonly load: AuditPassiveLoad; readonly close: () => Promise<readonly PassiveSessionCloseFailure[]> }
  | { readonly status: 'FAILED'; readonly ledger: SafetyLedger | null; readonly error: unknown; readonly close: () => Promise<readonly PassiveSessionCloseFailure[]> }
  | { readonly status: 'DEADLINE_EXCEEDED'; readonly ledger: SafetyLedger | null; readonly closeFailures: readonly PassiveSessionCloseFailure[] };

/** RB-10: 幅の走査の 1 つの幅のセッション。 */
export interface AuditStressSession {
  readonly view: AuditView;
  readonly close: () => Promise<void>;
}

/** RB-10: 幅の走査のセッションを作る口（`createStressSessionFactory` の形）。 */
export interface AuditStressSessions {
  readonly createSession: (viewport: Viewport) => Promise<AuditStressSession>;
  readonly ledgers: () => readonly SafetyLedger[];
}

/** RB-10: 幅の走査の collector の受け口（page の代わりに口の page を受ける）。 */
export interface AuditStressLayoutOptions extends Omit<StressLayoutOptions, 'settleBeforeLayout' | 'afterLayout'> {
  readonly settleBeforeLayout: (view: AuditView, deadlineAtMs: number) => Promise<void>;
  readonly afterLayout?: ((view: AuditView, width: number, layout: LayoutEvidence) => Promise<void>) | undefined;
}

/** SWR: 大きさを変えて回す幅の走査の受け口（`collectResizedStressLayout` の `aroundWidth` を足したもの）。 */
export interface AuditResizedStressLayoutOptions extends AuditStressLayoutOptions {
  readonly aroundWidth?: ResizedStressLayoutOptions['aroundWidth'];
}

/** RB-10: Interaction の候補 1 つの入力（session の作り方は口が持つ）。 */
export interface AuditInteractionInput extends Omit<InteractionAuditInput, 'sessionFactory' | 'releaseLateSessionFailure' | 'afterVerified' | 'verifyTrail'> {
  readonly afterVerified?: ((view: AuditView) => Promise<void>) | undefined;
  readonly verifyTrail?: ((view: AuditView) => Promise<boolean>) | undefined;
}

/**
 * RB-10: Interaction の候補 1 つの結果。後片付けの失敗（4.5.8）は、口が session を 1 回だけ閉じてから返す。Context の構築の失敗（R14 の I2）は、口が Context を閉じ、
 * 閉じた後の snapshot を付けて返す（Page Auditor が理由を残し、段の失敗にする）。
 */
export type AuditInteractionOutcome =
  | InteractionCandidateOutcome
  | { readonly kind: 'CONSTRUCTION_FAILED'; readonly error: unknown; readonly closeFailures: readonly PassiveSessionCloseFailure[]; readonly safety: SafetyLedgerSnapshot };

/**
 * RB-10: 監査の読み込みの口（Passive の読み込み・幅の走査・Interaction）。本物は `playwrightAuditLoadPortsOf`（factory と collector から作る）。テストだけが
 * `PageAuditorDependencies.auditLoadPorts` で偽の口を渡す（本番の入口は渡さない。Gate `discovery-crawl-ports-entry`）。
 */
export interface AuditLoadPorts {
  readonly openPassive: (viewport: Viewport, deadlineAtMs: number, deadlines: ResolvedPassiveSessionDeadlines) => Promise<AuditPassiveOpening>;
  readonly stressSessions: (options: StressSessionOptions) => AuditStressSessions;
  readonly collectStressLayout: (
    createSession: AuditStressSessions['createSession'],
    url: string,
    widths: readonly number[],
    options: AuditStressLayoutOptions,
  ) => Promise<readonly StressLayoutEvidence[]>;
  /** SWR: 1 つのセッションで 1 回だけ読み込み、幅ごとに大きさだけを変えて回す（`collectResizedStressLayout`）。 */
  readonly collectResizedStressLayout: (
    createSession: AuditStressSessions['createSession'],
    url: string,
    widths: readonly number[],
    options: AuditResizedStressLayoutOptions,
  ) => Promise<readonly StressLayoutEvidence[]>;
  readonly auditInteraction: (
    input: AuditInteractionInput,
    deadlines: ResolvedPassiveSessionDeadlines,
    cleanupDeadlineAtMs: () => number,
  ) => Promise<AuditInteractionOutcome>;
}

/** RB-10: 本物の監査の読み込みの口（Playwright の page を結ぶ）。 */
export function playwrightAuditLoadPortsOf(factory: BrowserContextFactory, collectors: PageAuditCollectors): AuditLoadPorts {
  const pages = new WeakMap<AuditView, Page>();
  const viewOf = (page: Page, documentLedgers: () => readonly SafetyLedger[]): AuditView => {
    const bind = <R extends unknown[], O>(work: (target: Page, ...rest: R) => O) => (...rest: R): O => work(page, ...rest);
    const view: AuditView = Object.freeze({
      url: () => page.url(),
      isClosed: () => page.isClosed(),
      viewportWidth: () => page.viewportSize()?.width ?? null,
      failureReason: () => pageFailureReason(page),
      onCrash: (listener: () => void) => {
        page.on('crash', listener);
        return () => {
          page.off('crash', listener);
        };
      },
      captureLocation: () => captureLocationOf(page),
      attachProgressSignals: bind(attachPageProgressSignals),
      waitForSettled: bind(waitForPageSettled),
      controlledScroll: bind(controlledScroll),
      readMediaQueryConditionTexts: bind(readMediaQueryConditionTexts),
      attachDataActivity: bind(DataActivityCollector.attach),
      collectDomEvidence: bind(collectors.collectDomEvidence),
      collectLayoutEvidence: bind(collectors.collectLayoutEvidence),
      collectAccessibilityEvidence: bind(collectors.collectAccessibilityEvidence),
      collectPerformance: bind(collectors.performance.collect.bind(collectors.performance)),
      readLcpBeforeScroll: bind(collectors.performance.readLcpBeforeScroll.bind(collectors.performance)),
      captureScreenshots: bind(collectors.captureScreenshots),
      captureViewportScreenshot: bind(collectors.captureViewportScreenshot),
      collectFocusChecks: bind(collectors.collectFocusChecks),
      revealAndCapture: bind(revealAndCapture),
      captureAsIs: bind(captureAsIs<EvidenceId>),
      // REV-EV4 の C-1（a）: キーを押す期間の main frame の移動とポップアップは、この page の Guard が止める。
      checkScrollableRegions: (targets: readonly ScrollableRegionTarget[], options: ScrollableRegionCheckOptions) =>
        checkScrollableRegions(page, targets, { ...options, keyPressGuard: scrollKeyPressGuardOf(page) }),
      // AUD-3: 通常の Tab の確かめのキーの押下の期間も、同じ Guard の口で、ページが始めた画面の移動とポップアップを止める。
      checkSequentialTab: (evidence: FocusCheckEvidence, options: SequentialTabOptions) =>
        checkSequentialTab(page, evidence, { ...options, keyPressGuard: scrollKeyPressGuardOf(page) }),
      // FRET: 窓を開くボタンの確かめのキーの押下の期間も、同じ Guard の口で、ページが始めた画面の移動とポップアップを止める。押す期間（2026-11-25）は、
      // 同じ口の `pressPeriod` で、読み取りでない要求も止める。
      checkDialogFocus: (options: Omit<DialogFocusCheckOptions, 'keyPressGuard'>) =>
        checkDialogFocus(page, { ...options, keyPressGuard: scrollKeyPressGuardOf(page) }),
      discoverLinks: bind(collectors.discoverLinks),
      discoverInteractionCandidates: bind(collectors.discoverInteractionCandidates),
      dismissNotificationFrames: bind(collectors.dismissNotificationFrames),
      readModalCandidateOrdinals: (deadlineAtMs: number) => readModalCandidateOrdinals(page, INTERACTION_CANDIDATE_SELECTOR, deadlineAtMs),
      loadFacts: () => pageLoadFactsOf(page),
      pressNavigations: () => notificationPressNavigationsOf(page),
      pressNavigationTargets: () => notificationPressNavigationTargetsOf(page),
      documentLeftCause: (navigated: boolean) => auditDocumentLeftCause(page, documentLedgers().map((ledger) => ledger.snapshot()), navigated),
      watchAuditScope: (isOutside: AuditScopeJudge | undefined, requestedUrl: string) => watchAuditScope(page, isOutside, requestedUrl),
      ledger: () => factory.getSafetyLedger(page.context()),
      // 状態の名前を持たない factory（テストの差し替えなど）は、名前の違いを読めない（`null`）。
      authenticatedStateNames: () => (typeof factory.authenticatedStateNamesOf === 'function' ? factory.authenticatedStateNamesOf(page.context()) : null),
      observeSessionLossNavigation: () => observeSessionLossNavigation(page),
      waitWithPageShown: (options: Omit<PacingWaitOptions, 'page'>) => waitWithPageShown({ ...options, page }),
    });
    pages.set(view, page);
    return view;
  };
  const pageOf = (view: AuditView): Page => {
    const page = pages.get(view);
    if (page === undefined) {
      throw new TypeError('the page view was not opened by the Playwright audit load ports');
    }
    return page;
  };
  // 幅の走査の collector の入力（口の session を page に、口の page の受け口を page の受け口に結ぶ。2 つの幅の走査の共通）。
  const stressCollectorInputOf = (
    createSession: AuditStressSessions['createSession'],
    options: AuditStressLayoutOptions,
  ): { readonly pageFactory: PassiveStressSessionFactory; readonly options: StressLayoutOptions } => {
    const views = new Map<Page, AuditView>();
    const viewOfPage = (page: Page): AuditView => {
      const view = views.get(page);
      if (view === undefined) {
        throw new TypeError('the stress page was not opened by the audit load ports');
      }
      return view;
    };
    const { afterLayout } = options;
    return {
      pageFactory: async (viewport) => {
        const session = await createSession(viewport);
        const page = pageOf(session.view);
        views.set(page, session.view);
        return { page, close: () => session.close() };
      },
      options: {
        deadlineAtMs: options.deadlineAtMs,
        beforeNavigation: options.beforeNavigation,
        afterNavigation: options.afterNavigation,
        settleBeforeLayout: (page, deadlineAtMs) => options.settleBeforeLayout(viewOfPage(page), deadlineAtMs),
        afterLayout: afterLayout === undefined ? undefined : (page, width, layout) => afterLayout(viewOfPage(page), width, layout),
      },
    };
  };
  return Object.freeze<AuditLoadPorts>({
    openPassive: async (viewport: Viewport, deadlineAtMs: number, deadlines: ResolvedPassiveSessionDeadlines): Promise<AuditPassiveOpening> => {
      // T44b（設計者の判断の (1)）: ページの監査の読み込み（Desktop と Mobile）の印。閉じる前にページを離れて待つのは、この読み込みだけ。
      const opened = await openPassiveSessionBeforeDeadline(factory, viewport, deadlineAtMs, { ...deadlines, pageAuditLoad: true });
      const closeOf = (context: BrowserContext | undefined) => () => closePassivePageAndContext(factory, context, deadlines);
      switch (opened.status) {
        case 'OPENED': {
          const { page, context, ledger } = opened;
          return {
            status: 'OPENED',
            ledger,
            close: closeOf(context),
            load: Object.freeze({
              view: viewOf(page, () => [ledger]),
              installPerformance: () => collectors.performance.installBeforeNavigation(context),
              navigate: (url: string, options: Parameters<typeof navigatePage>[2]) => navigatePage(page, url, options),
              attachNetwork: (approvedServiceOrigins: readonly string[]) => NetworkCollector.attach(page, { phaseOf: () => pageEventPhaseOf(page), approvedServiceOrigins }),
              attachConsole: () => ConsoleCollector.attach(page),
            }),
          };
        }
        case 'FAILED':
          return { status: 'FAILED', ledger: opened.ledger, error: opened.error, close: closeOf(opened.context) };
        case 'DEADLINE_EXCEEDED':
          return { status: 'DEADLINE_EXCEEDED', ledger: opened.ledger, closeFailures: opened.closeFailures };
      }
    },
    stressSessions: (options: StressSessionOptions): AuditStressSessions => {
      const sessions = createStressSessionFactory(factory, options);
      return Object.freeze({
        ledgers: () => sessions.ledgers(),
        createSession: async (viewport: Viewport): Promise<AuditStressSession> => {
          const session = await sessions.createSession(viewport);
          return Object.freeze({ view: viewOf(session.page, () => sessions.ledgers()), close: () => session.close() });
        },
      });
    },
    collectStressLayout: (createSession, url, widths, options) => {
      const bound = stressCollectorInputOf(createSession, options);
      return collectors.collectStressLayout(bound.pageFactory, url, widths, bound.options);
    },
    collectResizedStressLayout: (createSession, url, widths, options) => {
      const bound = stressCollectorInputOf(createSession, options);
      return collectors.collectResizedStressLayout(bound.pageFactory, url, widths, { ...bound.options, aroundWidth: options.aroundWidth });
    },
    auditInteraction: async (input, deadlines, cleanupDeadlineAtMs): Promise<AuditInteractionOutcome> => {
      const { afterVerified, verifyTrail, ...rest } = input;
      const openedView = (page: Page): AuditView => viewOf(page, () => []);
      try {
        return {
          kind: 'AUDITED',
          result: await auditInteraction({
            ...rest,
            sessionFactory: (viewport) => factory.createInteractionSession(viewport),
            // 作成の期限を過ぎた後に届いた `ContextConstructionError` の Context は、Passive と同じ部品で閉じる（設計書 4.2）。
            releaseLateSessionFailure: (error) => releaseLatePassiveContextFailure(factory, error, deadlines),
            ...(afterVerified === undefined ? {} : { afterVerified: (page: Page) => afterVerified(openedView(page)) }),
            ...(verifyTrail === undefined ? {} : { verifyTrail: (page: Page) => verifyTrail(openedView(page)) }),
          }),
        };
      } catch (error) {
        if (error instanceof InteractionOwnerCleanupError) {
          await closeAbandonedInteractionSession(error.session, cleanupDeadlineAtMs());
          return { kind: 'CLEANUP_FAILED', safety: error.safety };
        }
        if (error instanceof ContextConstructionError) {
          // Guard が Context を閉じた場合も、エラーが持つ Ledger を含める（R14r の Important-1）。閉じていなければ閉じる。
          const closeFailures = await closePassivePageAndContext(factory, error.context, deadlines);
          return { kind: 'CONSTRUCTION_FAILED', error, closeFailures, safety: error.ledger.snapshot() };
        }
        throw error;
      }
    },
  });
}

/** page rule の評価をするもの（`RuleEngine`）。評価のたびに、採番器の Finding の連番から新しく作る（設計書 4.5.3）。 */
export type PageRuleEvaluator = Pick<RuleEngine, 'evaluate'>;

/** `PageAuditor` に注入するもの（Task 14〜17 の設計書 第3章、4.5.1、4.5.3）。 */
export interface PageAuditorDependencies {
  /** Passive Context と page、幅の走査のセッションを作る factory（本物の監査の読み込みの口が使う。偽の口を渡すテストは省く）。 */
  readonly contextFactory?: BrowserContextFactory | undefined;
  /** RB-10: 監査の読み込みの口（テストだけが偽の口を渡す）。省略すると、factory と collector の本物の口。 */
  readonly auditLoadPorts?: AuditLoadPorts | undefined;
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
  /** collector の差し替え口（本物の口の中で使う。テストで例外や PARTIAL を起こすため）。指定しなかった collector は本番の関数を使う。 */
  readonly collectors?: Partial<PageAuditCollectors>;
  /**
   * Context と page の作成・終了の期限の注入口（DEF-008、R15r-4。Task 18 の前の整理の設計書 4.2、4.4）。省略した項目は、
   * `limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
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
  /**
   * DEF-236 の修正: 違反があるかを、止めたことを記録せずに調べる関数（真なら違反がある）。次の読み込みの前に、前の画面を見せたまま待つかを決めるときに
   * 使う（`#nextLoadMayStart`）。ここでは何も始めず止めもしないので、止めたことの記録（`safetyViolationRecorded`）を使わない。Run Coordinator は、
   * 今のページの Ledger を調べる関数を渡す。省略したときは `safetyViolationRecorded` を使う（Page Auditor だけを確かめるテストの `() => false` など）。
   */
  readonly safetyViolationDetected?: (() => boolean) | undefined;
  /**
   * ページの読み込みの間隔を守る部品（サイトへの負荷の制御の設計書 4.1）。Run Coordinator が Run の初めに1つだけ作り、robots.txt と
   * sitemap.xml の取得にも同じものを渡す。Page Auditor は、Passive の各ビューポート（再試行を含む）、幅の走査の各幅、Interaction の
   * 各候補の読み込みの前に `beforeNavigation()` を呼ぶ。待った時間は、期限を消費しない（設計書 4.4。待った分だけ期限を延ばす）。
   * 必須の依存である（渡し忘れると間隔を空けずに読み込む、という形を残さない）。`beforeNavigation` と `snapshot` の関数を持たない
   * 値と、渡さなかった場合は `TypeError`。
   */
  readonly navigationPacer: NavigationPacer;
  /**
   * 認証つきの Run のセッションの切れの path の前方一致（Task 25 の設計書 4.3。T25c）。省略すると、セッションの切れを確かめない（公開監査。
   * 今のまま）。渡すと、Passive の各ビューポートと、幅の走査の各幅の読み込みの後に、main frame の最後の URL（と、Guard が監査の段の除外で
   * 止めた main frame の移動の先）の path が、これで始まるかを確かめる。当たったら、そのビューポートの収集をせず、同じページの残りの
   * ビューポートと幅を始めず、結果の `authSessionLostDetail` に当たった場所を返す（ページを捨てて Run を止めるのは Run Coordinator）。
   * NL-2: null（ログインのないテスト用のサイトの認証つきの Run）は、省略と同じく、セッションの切れを確かめない。
   */
  readonly sessionLostPathPrefix?: string | null | undefined;
  /**
   * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 読み込んだ画面の main frame の URL が点検の範囲の外か（Run Coordinator が
   * `isOutsideRunAuditScope` で作る）。範囲の外へ移った Passive の画面は点検しない（`navigatePage` の口。結果は `BLOCKED_EXTERNAL_REDIRECT`）。省略は判定しない。
   */
  readonly isOutsideAuditScope?: ((url: string) => boolean) | undefined;
  /**
   * DEF-138: 承認したサービスの Origin（スクリプトで送るログインの Run の監査の段の口の値）。セッションの切れの証拠の Origin の区別だけに使う。省略は空。
   */
  readonly approvedServiceOrigins?: readonly string[] | undefined;
  /**
   * COV-4 の区切り 3（設計者の判断 2026-11-10）: 開いた状態の構造の鍵を受け付ける口（Run の全体で初めての鍵なら真。Run Coordinator は巡回の記録
   * `CrawlFrontier.acceptOpenedStructure` を渡し、checkpoint に残る）。省略すると、この Page Auditor の中だけで覚える。
   */
  readonly acceptOpenedStructure?: ((structureKey: string) => boolean) | undefined;
  /**
   * COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 開いた状態の中で押す組（構造の鍵・候補の ID・順番）を受け付ける口（初めての組なら真。Run
   * Coordinator は `CrawlFrontier.acceptOpenedPress` を渡し、checkpoint に残る）。省略すると、この Page Auditor の中だけで覚える。
   */
  readonly acceptOpenedPress?: ((press: OpenedPressKey) => boolean) | undefined;
  /**
   * DUP（ユーザーの判断 2026-11-18）: 同じ作りの画面の口（`PageSamenessPort`）。渡すと、Desktop の layout の後にページの点検の深さを決め、深さの段の表
   * （`pageAuditStagesOf`）に従う。省略すると、どのページもしっかり点検する（チェックした画面だけの点検の Run は渡さない）。
   */
  readonly pageSameness?: PageSamenessPort | undefined;
  /**
   * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1 の 4）: Run の時間の上限の時刻（`now` と同じ基準。利用者の `maxRuntimeMs` を、Run Coordinator
   * がこの実行の開始から数えたもの）。ページの途中でも効かせるため、ページの期限と Interaction の段の期限を、この時刻より後にしない（差し込み口。
   * 上限を過ぎた段は、今の期限切れと同じく `<段階>:DEADLINE_EXCEEDED` で終わり、残りのページは Run Coordinator が `MAX_RUNTIME_REACHED` にする）。
   * 省略すると、上限なし。
   */
  readonly runDeadlineAtMs?: number | undefined;
  /**
   * L1: 進みの見張りの反応なしの長さ（ms。正の安全な整数）。省略すると `PROGRESS_WATCH_QUIET_LIMIT_MS`。テストで短い長さを渡すための口。
   */
  readonly progressWatchQuietLimitMs?: number | undefined;
  /** RB-2: 観察の窓の一式（落ち着きとスクロールの待ち）。省略すると本番の値。テストだけが渡す（Run Coordinator の `observationWindows`）。 */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: 測りの記録（Run Coordinator が入のときだけ渡す）。1 画面の段・読み込み・
   * ビューポート・幅の走査の幅ごと・読み込みの間隔の待ちを測る。省略すると切（何もしない）。
   */
  readonly debugTiming?: DebugTimingLog | undefined;
}

/**
 * 違反を検出したため、始めなかった監査の理由のコード（Task 19 の前の整理の設計書 4.5。C18f）。
 * 幅の走査と Interaction の段階の理由の `detail` にも、同じ文字列を使う。
 */
const SAFETY_VIOLATION_ABORT_CODE: Extract<IncompleteReasonCode, 'SAFETY_VIOLATION_ABORT'> = 'SAFETY_VIOLATION_ABORT';

/**
 * サイトの不調を検知したことを表す理由のコード（サイトが応答しないときに Run を止める設計書 3.1）。始めなかったビューポートの理由
 * （`SITE_UNAVAILABLE_SKIP_REASON`。owner は `site-availability.ts`）のコードを使う。不調を検知したビューポートの理由と、幅の走査と
 * Interaction の段階を途中で止めた理由の `detail` にも、同じ文字列を使う。
 */
const SITE_UNAVAILABLE_CODE = SITE_UNAVAILABLE_SKIP_REASON.code;
/** DEF-129: ページが始めた main frame の読み込みを Guard が上限で止めたビューポートの理由（`detail` は `null`）。 */
const PAGE_NAVIGATION_LIMIT_INCOMPLETE_REASON: IncompleteReason = Object.freeze({
  code: 'PAGE_NAVIGATION_LIMIT_REACHED' satisfies IncompleteReasonCode,
  detail: null,
});
/** Passive の各ビューポートの読み込みの段階の名前（不調を検知した段階。`SITE_UNAVAILABILITY_STAGES` の1つ）。 */
const PASSIVE_STAGE: Extract<SiteUnavailabilityStage, 'passive'> = 'passive';
/** 幅の走査の各幅の読み込みの段階の名前（不調を検知した段階。`SITE_UNAVAILABILITY_STAGES` の1つ）。 */
const STRESS_LAYOUT_STAGE: Extract<SiteUnavailabilityStage, 'stress-layout'> = 'stress-layout';
/** Interaction の各候補の読み込みの段階の名前（不調を検知した段階。`SITE_UNAVAILABILITY_STAGES` の1つ）。 */
const INTERACTION_STAGE: Extract<SiteUnavailabilityStage, 'interaction'> = 'interaction';

/** 違反を検出したため、幅の走査の次の幅のセッションを作らなかったことを、段階の例外として伝える（C18f）。 */
class SafetyViolationAbortError extends Error {
  constructor() {
    super('a safety invariant violation was recorded; the next stress sweep session was not started');
    this.name = 'SafetyViolationAbortError';
  }
}

/**
 * サイトの不調を検知したため、幅の走査の次の幅のセッションを作らなかったことを、段階の例外として伝える（サイトが応答しないときに Run を
 * 止める設計書 3.1。`SafetyViolationAbortError` と同じ形）。
 */
class SiteUnavailableAbortError extends Error {
  constructor() {
    super('site unavailability was detected; the next stress sweep session was not started');
    this.name = 'SiteUnavailableAbortError';
  }
}

/**
 * 認証つきの Run で、セッションの切れを検知したため、幅の走査の次の幅のセッションを作らなかったことを、段階の例外として伝える（T25c。
 * `SiteUnavailableAbortError` と同じ形）。
 */
class AuthSessionLostAbortError extends Error {
  constructor() {
    super('the authenticated session was lost; the next stress sweep session was not started');
    this.name = 'AuthSessionLostAbortError';
  }
}

/** セッションの切れを検知した理由のコード（`AUTH_SESSION_LOST_SKIP_REASON` のコード。幅の走査の段階の理由の `detail` にも使う）。 */
const AUTH_SESSION_LOST_CODE = AUTH_SESSION_LOST_SKIP_REASON.code;

/**
 * 1 つのビューポートで、セッションの切れを検知した段階（T25c）。最初の 1 つだけを持つ。DEF-138: `source` は、証拠を組み立てるための、判定した読み込みの
 * page と Context と経路の記録（Context を閉じた後に、factory が読んだ状態の名前と合わせて組み立てる）。
 * DF-3: `stage` は場所の印の段階の部分（`sessionLossStageDetailOf`。読み込みの直後は `passive`・`stress-layout`、後の時機は `passive:settled` など）。
 */
interface ViewportAuthSessionLoss {
  stage: string | null;
  source: SessionLossSource | null;
}

/** DF-3: このビューポートで読み込んだ page（Passive と、幅の走査の各幅）。決めた時機に、セッションの切れを確かめ直すために、読み込んだ順に持つ。 */
interface SessionLossLoad {
  readonly stage: Extract<SiteUnavailabilityStage, 'passive' | 'stress-layout'>;
  readonly view: AuditView;
  /** DEF-138: 経路の記録（認証つきの Run だけ）。ビューポートの Context を閉じる前に外す。 */
  readonly route: SessionLossNavigationObserver | null;
}

/**
 * DF-3: ビューポートの終わりの確かめの時機。最後のビューポートはページの監査の終わり（`pageEnd`）、ほかは次のビューポートの前（`beforeNextLoad`）。
 */
const viewportEndCheckPointOf = (profile: ViewportProfile): SessionLossCheckPoint => (
  profile === VIEWPORT_PROFILES[VIEWPORT_PROFILES.length - 1] ? SESSION_LOSS_CHECK_POINTS.pageEnd : SESSION_LOSS_CHECK_POINTS.beforeNextLoad
);

/** DEF-138: セッションの切れを判定した読み込みの、証拠の材料（値は持たない。page と Context は閉じた後に読む）。 */
interface SessionLossSource {
  readonly view: AuditView;
  readonly navigation: SessionLossNavigationRecord | null;
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
   * Desktop でサイトの不調を検知した場合は、呼ばない（次のビューポートを始めないため。サイトが応答しないときに Run を止める設計書 3.1）。
   */
  readonly precedesRetry: (desktop: ViewportAuditResult) => boolean;
  /**
   * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 4）: このページの後に、次のページを読み込むか（Run Coordinator だけが決める）。
   * Page Auditor は、最後のビューポート（Mobile）の証拠を集め終えた後、閉じる前に 1 回だけ呼ぶ。引数は、このページのそれまでの Evidence（Desktop の Link を
   * 含む）。真なら、前の画面を見せたまま読み込みの間隔を待ってから閉じる。偽か省略なら、待たずに閉じる（Run の最後のページ）。
   */
  readonly nextPageFollows?: ((evidence: readonly EvidenceRecord[]) => boolean) | undefined;
  /**
   * EV-5（設計者の判断 2026-11-16）: 時間切れの後の再開で、終えたページを読み直すときの、読み直しの番号（正の安全な整数）。渡すと、この試行の画像を全部
   * `pages/<pageId>/revisit-<番号>/` の下に置く（前の結果の画像を上書きしない）。省略は、ふだんの読み込み。
   */
  readonly revisit?: number | undefined;
}

/** 閉じる処理と、Context を作る処理の失敗を、理由の `detail`（`<場面>:<メッセージ>`）で区別するための場面の名前（設計書 4.5.5）。 */
const SESSION_FAILURE_LABELS = Object.freeze({
  open: 'passive-context',
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
  /** 監査を始めた候補の数が、設定の上限（`crawl.maxInteractionsPerPage`）に達した（サイトへの負荷の制御の設計書 4.3）。 */
  limit: 'limit',
  /**
   * このビューポートで、サイトの不調を検知した（幅の走査か、前の候補の読み込み。サイトが応答しないときに Run を止める設計書 3.1）。
   */
  siteUnavailable: SITE_UNAVAILABLE_CODE,
} as const);
type InteractionStopReason = (typeof INTERACTION_STOP_REASONS)[keyof typeof INTERACTION_STOP_REASONS];

/** `auditViewport()` の中間の結果。ページの結果は、両方のビューポートのこれから組み立てる。 */
interface ViewportAuditOutcome {
  readonly result: ViewportAuditResult;
  readonly evidence: readonly EvidenceRecord[];
  readonly findings: readonly Finding[];
  /** このビューポートの Safety の記録。Ledger の snapshot は、Context を閉じた後に取って集計する。 */
  readonly safety: ViewportSafetySources;
  /** このビューポートで検知したサイトの不調（段階と判定の結果）。検知しなかった場合と、始めなかったビューポートは `null`（設計書 3.1）。 */
  readonly siteUnavailability: DetectedSiteUnavailability | null;
  /**
   * このビューポートで、セッションの切れを検知した段階（T25c。DF-3: 後の時機なら `<段階>:<時機>`）。検知しなかった場合と、始めなかったビューポートは
   * `null`。
   */
  readonly authSessionLostStage: ViewportAuthSessionLoss['stage'];
  /** DEF-138: セッションの切れの証拠（検知したビューポートだけ。ほかは `null`）。 */
  readonly authSessionLoss: SessionLossEvidence | null;
}

/** 検知したサイトの不調（サイトが応答しないときに Run を止める設計書 3.1）。`detail` の組み立ては `site-availability.ts` が行う。 */
interface DetectedSiteUnavailability {
  /** 不調を検知した段階。 */
  readonly stage: SiteUnavailabilityStage;
  /** 判定の結果（`siteUnavailabilityOf` が返したもの）。 */
  readonly unavailability: SiteUnavailability;
}

/**
 * 1つのビューポートで、最初に検知したサイトの不調を1つだけ持つ（サイトが応答しないときに Run を止める設計書 3.1）。
 * Passive、幅の走査、Interaction の読み込みの観測を受け取り、`siteUnavailabilityOf` で判定する（判定は site-availability.ts だけが持つ）。
 * 最初に検知したときだけ、ビューポートの理由 `SITE_UNAVAILABLE`（`detail` は `<段階>:<判定の詳細>`）を1件加える。後で検知した不調は
 * 記録しない（同じビューポートの理由は1件だけである）。
 */
class ViewportSiteUnavailability {
  readonly #reasons: IncompleteReason[];
  #detected: DetectedSiteUnavailability | null = null;

  constructor(reasons: IncompleteReason[]) {
    this.#reasons = reasons;
  }

  /** 最初に検知した不調。検知していなければ `null`。 */
  get detected(): DetectedSiteUnavailability | null {
    return this.#detected;
  }

  /**
   * `stage` の読み込みの観測を判定する。不調で、まだ検知していなければ、記録して理由を加える。この観測が不調なら真を返す。
   */
  observe(stage: SiteUnavailabilityStage, observation: MainFrameLoadObservation): boolean {
    const unavailability = siteUnavailabilityOf(observation);
    if (unavailability === null) {
      return false;
    }
    if (this.#detected === null) {
      this.#detected = Object.freeze({ stage, unavailability });
      this.#reasons.push(Object.freeze({ code: SITE_UNAVAILABLE_CODE, detail: siteUnavailableStageDetail(stage, unavailability) }));
    }
    return true;
  }
}

/**
 * 1つのビューポートの Safety の記録。Safety の Evidence は、この順に作る（設計書 4.5.2 の手順6）。
 * - `passiveLedgers`: Passive の Context の Ledger（Context を作れた場合だけ）
 * - `interactionSnapshots`: Interaction の候補ごとの、隔離した Context の Ledger の snapshot（Desktop だけ）。
 *   `auditInteraction` が Context を閉じた後に取ったものである。
 * - `stressLedgers`: 幅の走査のセッションの Ledger（Desktop だけ）
 * BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 4）: Interaction の snapshot は候補の番号（候補の発見の順で 0 から）と、
 * 幅の走査の Ledger はその幅と組にして持つ（safety の Evidence の読み込みの印 `load` に写す。Evidence の並びに頼らない）。
 */
interface ViewportSafetySources {
  readonly passiveLedgers: SafetyLedger[];
  readonly interactionSnapshots: { readonly snapshot: SafetyLedgerSnapshot; readonly candidateIndex: number }[];
  /** SWR: 大きさを変えて回した Context は、走査した幅の一覧（`widths`。走査の順に足す）も持つ。 */
  readonly stressLedgers: { readonly ledger: SafetyLedger; readonly width: number; readonly widths?: readonly number[] }[];
  /**
   * DEF-236: 前の画面を見せたまま読み込みの間隔を待った Ledger の、待ちの範囲（Passive と幅の走査の Context）。その範囲の事象は、safety の Evidence には残すが、
   * Rule の入力から除く（`withoutPacingWaitEvents`）。
   */
  readonly pacingWaits: Map<SafetyLedger, PacingWaitWindow>;
}

/** BN-a: ページの監査の読み込み（Desktop と Mobile の Passive の Context）の safety の Evidence の読み込みの印。 */
const PAGE_AUDIT_LOAD: SafetyEvidenceLoad = Object.freeze({ kind: 'PAGE_AUDIT' });

/** 候補1つの監査の結果。後片付けの失敗は、エラーが保持する Safety の snapshot だけを持つ（4.5.8）。 */
type InteractionCandidateOutcome =
  | { readonly kind: 'AUDITED'; readonly result: InteractionAuditResult }
  | { readonly kind: 'CLEANUP_FAILED'; readonly safety: SafetyLedgerSnapshot };

/**
 * 段階の結果。L1b: 見張りが段階を終えても、collector が途中の記録を返した場合は、`ok` で、終えた理由（`watchEnded`）を付ける（理由は見張りが記録
 * 済みなので、呼ぶ側は collector の PARTIAL の理由を重ねて記録しない）。
 */
type StageAttempt<T> = { readonly ok: true; readonly value: T; readonly watchEnded?: ProgressWatchEnd } | { readonly ok: false };

/**
 * 1つのページを、Desktop と Mobile の両方のビューポートで監査する（Task 14〜17 の設計書 4.5）。
 * Interaction の段階は、Desktop で、設定の `audit.interactions` が有効な場合だけ行う（4.5.2 の手順5）。
 * 注入する `now` は、`Date.now()` と同じ基準の時刻でなければならない（`PageAuditorDependencies.now`。期限の判定に
 * `awaitBeforeDeadline` などが `Date.now()` を使うため）。
 */
/** DUP: しっかり点検する深さ（ページを始めるたびに戻す値）。 */
const FULL_DEPTH: PageAuditDepthDecision = Object.freeze({ depth: 'FULL', sameAs: null });

export class PageAuditor {
  /** RB-10: 監査の読み込みの口。 */
  readonly #ports: AuditLoadPorts;
  readonly #config: AuditConfig;
  readonly #allocator: IdAllocator;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #screenshotRootDirectory: string;
  readonly #createRuleEngine: (firstFindingSequence: number) => PageRuleEvaluator;
  readonly #deadlines: ResolvedPassiveSessionDeadlines;
  readonly #safetyViolationRecorded: () => boolean;
  /** DEF-236 の修正: 止めたことを記録しない違反の確かめ（`PageAuditorDependencies.safetyViolationDetected`）。 */
  readonly #safetyViolationDetected: () => boolean;
  readonly #pacer: NavigationPacer;
  /** 認証つきの Run のセッションの切れの path の前方一致（T25c）。公開監査では `null`。 */
  readonly #sessionLostPathPrefix: string | null;
  /** SD-2: 読み込んだ画面の URL が点検の範囲の外か（`PageAuditorDependencies.isOutsideAuditScope`）。省略は `undefined`（判定しない）。 */
  readonly #isOutsideAuditScope: ((url: string) => boolean) | undefined;
  /** DEF-138: 承認したサービスの Origin（証拠の Origin の区別だけ）。 */
  readonly #approvedServiceOrigins: readonly string[];
  /** L5 の N5: 今のページの Desktop で見つけた Interaction の候補（Mobile で同じ候補を確かめ直さないため。ページを始めるたびに `null` に戻す）。 */
  #desktopInteractionCandidates: readonly InteractionCandidate[] | null = null;
  /** EV-5: 今のページの試行の読み直しの番号（`PageAuditAttempt.revisit`。読み直しでなければ `null`）。画像のパスを作る所が渡す。 */
  #screenshotRevisit: number | null = null;
  /** DUP: 同じ作りの画面の口（`PageAuditorDependencies.pageSameness`）。 */
  readonly #pageSameness: PageSamenessPort | undefined;
  /** DUP: 今のページの点検の深さ（ページを始めるたびに `FULL` に戻し、Desktop の layout の後に決める）。 */
  #pageDecision: PageAuditDepthDecision = FULL_DEPTH;
  /** AUD-5: 今のページの Desktop の作りの鍵（作れなければ `null`。ページの結果の `templateKey` に残す）。 */
  #pageTemplateKey: string | null = null;
  /** COV-4 の区切り 3: 開いた状態の構造の鍵を受け付ける口（`PageAuditorDependencies.acceptOpenedStructure`）。 */
  readonly #acceptOpenedStructure: (structureKey: string) => boolean;
  /** COV-4 の区切り 3（入れ子の開いた状態）: 開いた状態の中で押す組を受け付ける口（`PageAuditorDependencies.acceptOpenedPress`）。 */
  readonly #acceptOpenedPress: (press: OpenedPressKey) => boolean;
  /**
   * FRET（設計書 `2026-11-24-beaksight-dialog-focus-return-design.md` 1.1）: 窓を開くボタンの確かめで押した物の鍵の digest（Run で 1 回。Run Coordinator は Run で
   * 1 つの Page Auditor を作るので、Run の単位の覚え。checkpoint には残さない）。
   */
  readonly #dialogFocusPressed = new Set<string>();
  /** L0: Run の時間の上限の時刻（上限なしは `undefined`。LZ-1 で番兵の `Infinity` をやめた）。 */
  readonly #runDeadlineAtMs: number | undefined;
  /** L1: 進みの見張りの反応なしの長さ（ms）。 */
  readonly #quietLimitMs: number;
  /** RB-2: 観察の窓の一式（落ち着きとスクロール）。 */
  readonly #windows: ObservationWindows;
  /** DBG-1: 測りの記録（切なら何もしない口）。 */
  readonly #debugTiming: DebugTimingLog;
  /**
   * DEF-210（設計書 3.3）: この Run で見た通知の枠の digest（ビューポートの種類ごと。幅の走査は別の集合）。Run の続き（checkpoint）では引き継がない
   * （再開の後の最初のページで、同じ枠の覆いの指摘をもう 1 回出しうる。限界）。
   */
  readonly #notificationSeenDigests = new Map<string, Set<string>>();

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
    const { safetyViolationDetected } = dependencies;
    if (safetyViolationDetected !== undefined && typeof safetyViolationDetected !== 'function') {
      throw new TypeError('PageAuditor safetyViolationDetected must be a function when given');
    }
    this.#safetyViolationDetected = safetyViolationDetected ?? safetyViolationRecorded;
    const { navigationPacer } = dependencies;
    if (
      !isRecord(navigationPacer)
      || typeof navigationPacer.beforeNavigation !== 'function'
      || typeof navigationPacer.snapshot !== 'function'
    ) {
      throw new TypeError('PageAuditor requires a navigation pacer');
    }
    this.#pacer = navigationPacer;
    const { sessionLostPathPrefix } = dependencies;
    if (sessionLostPathPrefix !== undefined && sessionLostPathPrefix !== null && typeof sessionLostPathPrefix !== 'string') {
      throw new TypeError('PageAuditor sessionLostPathPrefix must be a string or null when given');
    }
    this.#sessionLostPathPrefix = sessionLostPathPrefix ?? null;
    if (dependencies.isOutsideAuditScope !== undefined && typeof dependencies.isOutsideAuditScope !== 'function') {
      throw new TypeError('PageAuditor isOutsideAuditScope must be a function when given');
    }
    this.#isOutsideAuditScope = dependencies.isOutsideAuditScope;
    const { approvedServiceOrigins } = dependencies;
    if (approvedServiceOrigins !== undefined
      && (!Array.isArray(approvedServiceOrigins) || !approvedServiceOrigins.every((origin) => typeof origin === 'string'))) {
      throw new TypeError('PageAuditor approvedServiceOrigins must be strings when given');
    }
    this.#approvedServiceOrigins = Object.freeze([...(approvedServiceOrigins ?? [])]);
    const { acceptOpenedStructure } = dependencies;
    if (acceptOpenedStructure !== undefined && typeof acceptOpenedStructure !== 'function') {
      throw new TypeError('PageAuditor acceptOpenedStructure must be a function when given');
    }
    const ownOpenedStructures = new Set<string>();
    this.#acceptOpenedStructure = acceptOpenedStructure ?? ((structureKey: string): boolean => {
      if (ownOpenedStructures.has(structureKey)) {
        return false;
      }
      ownOpenedStructures.add(structureKey);
      return true;
    });
    const { acceptOpenedPress } = dependencies;
    if (acceptOpenedPress !== undefined && typeof acceptOpenedPress !== 'function') {
      throw new TypeError('PageAuditor acceptOpenedPress must be a function when given');
    }
    const ownOpenedPresses = new Set<string>();
    this.#acceptOpenedPress = acceptOpenedPress ?? ((press: OpenedPressKey): boolean => {
      const text = JSON.stringify([press.structureKey, press.candidateId, press.ordinal]);
      if (ownOpenedPresses.has(text)) {
        return false;
      }
      ownOpenedPresses.add(text);
      return true;
    });
    const { pageSameness } = dependencies;
    if (pageSameness !== undefined && (!isRecord(pageSameness) || typeof pageSameness.referenceOf !== 'function'
      || typeof pageSameness.sameContentAs !== 'function' || typeof pageSameness.decided !== 'function')) {
      throw new TypeError('PageAuditor pageSameness must have referenceOf, sameContentAs and decided functions when given');
    }
    this.#pageSameness = pageSameness;
    const { runDeadlineAtMs } = dependencies;
    if (runDeadlineAtMs !== undefined && (typeof runDeadlineAtMs !== 'number' || Number.isNaN(runDeadlineAtMs))) {
      throw new TypeError('PageAuditor runDeadlineAtMs must be a number when given');
    }
    this.#runDeadlineAtMs = runDeadlineAtMs;
    this.#quietLimitMs = resolveTimeoutMs(dependencies.progressWatchQuietLimitMs, PROGRESS_WATCH_QUIET_LIMIT_MS);
    this.#windows = observationWindowsOrProduction(dependencies.observationWindows);
    this.#debugTiming = dependencies.debugTiming ?? DEBUG_TIMING_OFF;
    this.#deadlines = resolvePassiveSessionDeadlines(dependencies.deadlines);
    this.#config = config;
    this.#allocator = allocator;
    this.#clock = clock;
    this.#now = now;
    this.#screenshotRootDirectory = screenshotRootDirectory;
    this.#createRuleEngine = dependencies.createRuleEngine
      ?? ((firstFindingSequence) => new RuleEngine({ targetId: config.target.id, firstFindingSequence }));
    // RB-10（REV の M-4）: 本物の口を作ったか。偽の口を渡したときに、factory と collector の差し替えを黙って捨てない（両方を渡したら誤り）。
    let realPortsBuilt = false;
    const requiredFactory = (): BrowserContextFactory => {
      realPortsBuilt = true;
      if (contextFactory === undefined) {
        throw new TypeError('PageAuditor requires a context factory');
      }
      return contextFactory;
    };
    this.#ports = dependencies.auditLoadPorts ?? playwrightAuditLoadPortsOf(requiredFactory(), Object.freeze({
      collectDomEvidence,
      collectLayoutEvidence,
      collectStressLayout,
      collectResizedStressLayout,
      collectAccessibilityEvidence,
      performance: new PerformanceCollector(),
      captureScreenshots,
      captureViewportScreenshot,
      collectFocusChecks,
      discoverLinks,
      discoverInteractionCandidates,
      dismissNotificationFrames,
      ...dependencies.collectors,
    }));
    if (!realPortsBuilt && (contextFactory !== undefined || dependencies.collectors !== undefined)) {
      throw new TypeError('PageAuditor takes either the audit load ports, or the context factory and the collectors, not both');
    }
  }

  /**
   * `url`（正規化済みの、要求するURL）のページを、Desktop、Mobile の順に監査する（設計書 4.5.1）。
   * `attempt` は、Run Coordinator が再試行を区別するために渡す（`PageAuditAttempt`。DEF-007）。形が不正なら `TypeError` を投げる。
   * ページの状態は `derivePageAuditStatus` で、ビューポートの状態から導く。結果は深く凍結する。
   * 各ビューポートの Context は、途中で例外が起きても、必ず閉じてから返る（例外は呼び出し側に返す）。
   * Context と page の作成と終了は、期限付きで待つ（DEF-008）。作成の期限切れはビューポートの失敗（`DEADLINE_EXCEEDED`）、終了の
   * 期限切れは閉じる処理の失敗（`UNHANDLED_FAILURE`）として記録し、止まり続けない。遅れて届いた Context は、部品が閉じる。
   * ビューポートの読み込み（Passive、幅の走査の各幅、Interaction の各候補）でサイトの不調を検知したら、同じページの次のビューポートを
   * 始めず、理由 `SITE_UNAVAILABLE`（`detail` は `null`）の `SKIPPED` にする。結果の `siteUnavailableDetail` は、最初に検知した不調の
   * 詳細（`<ビューポート>:<段階>:<判定の詳細>`）である（サイトが応答しないときに Run を止める設計書 3.1）。
   */
  async audit(url: NormalizedHttpUrlEvidence, pageId: PageId, attempt?: PageAuditAttempt): Promise<PageAuditOutcome> {
    if (attempt !== undefined && (
      !isPositiveSafeInteger(attempt.attempt)
      || typeof attempt.precedesRetry !== 'function'
      || (attempt.nextPageFollows !== undefined && typeof attempt.nextPageFollows !== 'function')
      || (attempt.revisit !== undefined && !isPositiveSafeInteger(attempt.revisit))
    )) {
      throw new TypeError('PageAuditor attempt needs a positive safe integer attempt number and a precedesRetry function');
    }
    // EV-5: 読み直しなら、この試行の画像を `revisit-<番号>/` の下に置く（ページの画像のパスを作る所は、どれもこの値を渡す）。
    this.#screenshotRevisit = attempt?.revisit ?? null;
    const outcomes: ViewportAuditOutcome[] = [];
    // L5 の N5: 前のページの Desktop の候補を、このページの Mobile に持ち込まない。
    this.#desktopInteractionCandidates = null;
    // DUP: 深さは、このページの Desktop の layout の後に決める（決めるまでは、しっかり点検する）。
    this.#pageDecision = FULL_DEPTH;
    this.#pageTemplateKey = null;
    // 再試行の前の試行なら、その試行の番号（スクリーンショットを `retry-<番号>` に置く）。Desktop の監査を終えた後に決める（DEF-007）。
    let screenshotRetryAttempt: number | null = null;
    // 最初に検知したサイトの不調の詳細（設計書 3.1）。検知しなければ `null`。
    let firstSiteUnavailableDetail: string | null = null;
    // 認証つきの Run で、最初にセッションの切れを検知した場所（`<ビューポート>:<段階>`。T25c）。検知しなければ `null`。
    let authSessionLostDetail: string | null = null;
    // DEF-138: そのときの証拠。
    let authSessionLoss: SessionLossEvidence | null = null;
    for (const profile of VIEWPORT_PROFILES) {
      // 次のビューポートを始めない条件（順は `viewportSkipReasonOf`: 違反 → 不調 → セッションの切れ → ダウンロード → Run の時間の上限。C18f・設計書 3.1・
      // T25c・DEF-225・L0）。始めないビューポートでは、ページの読み込みの間隔の待ちも呼ばない。
      const skipReason = viewportSkipReasonOf({
        earlierViewports: outcomes.length,
        violationRecorded: this.#safetyViolationRecorded,
        siteUnavailable: firstSiteUnavailableDetail !== null,
        sessionLost: authSessionLostDetail !== null,
        downloadResponse: outcomes.some((previous) => previous.result.incompleteReasons.some((reason) => reason.code === DOWNLOAD_RESPONSE_REASON.code)),
        runTimeLimitPassed: () => this.#runTimeLimitPassed(),
      });
      // DUP（設計者の判断 2026-11-18）: 表示の中身が点検した画面と同じページは、Mobile を始めない（段の表の `viewport`。理由は同じ中身の画面のページの ID。
      // 途中で止まった理由ではない）。REV-DUP の M-2: 時間切れより先に当てる（省くビューポートを、時間切れの読み直しの候補にしない）。
      const skippedBySameness = !pageAuditStagesOf(this.#pageDecision.depth, profile).viewport;
      if (skipReason !== null && !(skippedBySameness && skipReason.code === RUN_TIME_LIMIT_SKIP_REASON.code)) {
        outcomes.push(skippedViewportOutcome(url, pageId, profile, skipReason));
        continue;
      }
      if (skippedBySameness) {
        outcomes.push(skippedViewportOutcome(url, pageId, profile, Object.freeze({ code: 'SAME_CONTENT_AS_EARLIER_PAGE', detail: this.#pageDecision.sameAs })));
        continue;
      }
      // DEF-236: このビューポートの後に読み込みが続くか（閉じる前に、前の画面を見せたまま待つかを決める）。Desktop の後は、幅の走査か Mobile。Mobile の後は、
      // 再試行（Desktop の後に決めた）か、Run Coordinator が決める次のページ。始めない条件（違反・不調・セッションの切れなど）は `#auditViewport` が見る。
      const isLastProfile = profile === VIEWPORT_PROFILES[VIEWPORT_PROFILES.length - 1];
      const retryFollows = screenshotRetryAttempt !== null;
      const earlierEvidence = outcomes.flatMap((previous) => previous.evidence);
      const laterLoadFollows = (viewportEvidence: readonly EvidenceRecord[]): boolean => !isLastProfile
        || retryFollows
        || attempt?.nextPageFollows?.([...earlierEvidence, ...viewportEvidence]) === true;
      // AUD-2a: 状態 ID の試行の番号（Run Coordinator の試行。渡さなければ 1）。
      // DBG-1: ビューポートごと（Desktop・Mobile）の時間を測る（切なら何もしない）。
      const outcome = await this.#debugTiming.measure('AUDIT_VIEWPORT', () => ({ pageId, stateId: evidenceStateIdOf(pageId, profile, attempt?.attempt ?? 1) }),
        () => this.#auditViewport(url, pageId, profile, screenshotRetryAttempt, laterLoadFollows, attempt?.attempt ?? 1));
      outcomes.push(outcome);
      if (outcome.authSessionLostStage !== null) {
        // セッションの切れを検知したので、次のビューポートを始めない。再試行の判断（`precedesRetry`）も呼ばない。
        authSessionLostDetail = `${profile}:${outcome.authSessionLostStage}`;
        authSessionLoss = outcome.authSessionLoss;
      } else if (outcome.siteUnavailability !== null) {
        // 不調を検知したので、次のビューポートを始めない。そのため、Desktop でも、再試行の判断（`precedesRetry`）を呼ばない。
        const { stage, unavailability } = outcome.siteUnavailability;
        firstSiteUnavailableDetail = siteUnavailableDetail(profile, stage, unavailability);
      } else if (profile === 'desktop' && attempt !== undefined && attempt.precedesRetry(outcome.result)) {
        screenshotRetryAttempt = attempt.attempt;
      }
    }
    const viewports = Object.fromEntries(
      VIEWPORT_PROFILES.map((profile, index) => [profile, (outcomes[index] as ViewportAuditOutcome).result]),
    ) as Record<ViewportProfile, ViewportAuditResult>;
    // DUP: 表示の中身が同じなので始めなかったビューポートは、ページの状態と未完了の理由に入れない（ページを PARTIAL にしない）。
    const auditedOutcomes = outcomes.filter((outcome) => !isSameContentSkippedViewport(outcome.result));
    const { depth, sameAs } = this.#pageDecision;
    const result: PageAuditResult = {
      schemaVersion: PAGE_SCHEMA_VERSION,
      pageId,
      pageUrl: url,
      status: derivePageAuditStatus(auditedOutcomes.map((outcome) => outcome.result.status)),
      viewports,
      evidence: outcomes.flatMap((outcome) => outcome.evidence),
      findings: outcomes.flatMap((outcome) => outcome.findings),
      incompleteReasons: pageIncompleteReasons(auditedOutcomes.map((outcome) => outcome.result)),
      ...(depth === 'FULL' || sameAs === null ? {} : { sameness: Object.freeze({ depth, sameAs }) }),
      // AUD-5（S-07）: 題名の重なりを同じ画面の別のデータと分けるために、作りの鍵を残す（作れたときだけ）。
      ...(this.#pageTemplateKey === null ? {} : { templateKey: this.#pageTemplateKey }),
    };
    // 違反の集計は、Context を閉じた後の snapshot で行う（閉じる処理の中で記録された違反も含めるため）。
    const safety = summarizePageSafety(outcomes.flatMap(({ safety: sources }) => [
      ...sources.passiveLedgers.map((ledger) => ledger.snapshot()),
      ...sources.interactionSnapshots.map(({ snapshot }) => snapshot),
      ...sources.stressLedgers.map(({ ledger }) => ledger.snapshot()),
    ]));
    return deepFreeze({
      result,
      safety,
      siteUnavailableDetail: firstSiteUnavailableDetail,
      // T25c: 認証つきの Run だけ、セッションの切れの場所を返す（公開監査の結果の形は変えない）。DEF-138: 証拠も返す。
      ...(this.#sessionLostPathPrefix === null ? {} : { authSessionLostDetail, authSessionLoss }),
    });
  }

  /** DBG-1: 読み込みの間隔の待ち（段の間の待ち。測りの記録が入のときだけ測る）。 */
  #pacedNavigation(scope: DebugTimingScope): Promise<number> {
    return this.#debugTiming.measure('PACING_WAIT', () => scope, () => this.#pacer.beforeNavigation());
  }

  /** 1つのビューポートの監査（設計書 4.5.2 の 1〜8）。 */
  async #auditViewport(
    url: NormalizedHttpUrlEvidence,
    pageId: PageId,
    profile: ViewportProfile,
    screenshotRetryAttempt: number | null,
    laterLoadFollows: (viewportEvidence: readonly EvidenceRecord[]) => boolean = () => false,
    attemptNumber = 1,
  ): Promise<ViewportAuditOutcome> {
    const config = this.#config;
    const viewportSize = viewportSizeFor(config, profile);
    // AUD-2a: この読み込みの状態 ID。
    const stateId = evidenceStateIdOf(pageId, profile, attemptNumber);
    // ページの読み込みの間隔を守る（サイトへの負荷の制御の設計書 4.1）。再試行も、このビューポートの監査を通るので、同じく待つ。
    await this.#pacedNavigation({ pageId, stateId });
    // AUD-2a: ビューポートを始めた時刻（間隔の待ちの後。読み込みから集めた Evidence の時刻の範囲の始まり）。
    const viewportStartedAt = this.#clock().toISOString();
    // L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: ページの期限（`overallPageTimeoutMs`）と、collector に渡す期限・その余裕は撤廃した。
    // 各段は進みの見張りで包み（`StageRunner.attempt`）、応答しない・静まらない・Run の時間の上限のときだけ終える。
    const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);

    const evidence: EvidenceRecord[] = [];
    const reasons: IncompleteReason[] = [];
    const safety: ViewportSafetySources = { passiveLedgers: [], interactionSnapshots: [], stressLedgers: [], pacingWaits: new Map() };
    let navigation: PageNavigationResult | null = null;
    // このビューポートで最初に検知したサイトの不調（Passive、幅の走査、Interaction のどこで検知しても1つだけ。設計書 3.1）。
    const siteUnavailability = new ViewportSiteUnavailability(reasons);
    // このビューポートで最初に検知したセッションの切れ（T25c。Passive か、幅の走査のどこかで 1 つだけ）。
    const authSessionLoss: ViewportAuthSessionLoss = { stage: null, source: null };
    // DF-3: このビューポートで読み込んだ page（決めた時機に、セッションの切れを確かめ直す）。
    const sessionLossLoads: SessionLossLoad[] = [];
    // DEF-191: Desktop の幅の走査の控え（`#collect` が書く。Context を閉じた後に回す）。
    const deferredStressSweep: { value: DeferredStressSweep | null } = { value: null };
    // DEF-210: このビューポートの通知の枠の事実（主の読み込みと、閉じる前の layout と、幅の走査の各幅）。
    const notification: ViewportNotification = { overlay: null, beforeDismissal: null, stress: [] };
    let failed = false;
    // DEF-236: 証拠を集め終えたか（例外で終えた読み込みでは、見せたまま待たない）。
    let evidenceSettled = false;
    let stages: StageRunner | undefined;
    // RB-10: 開いた Passive の page（口の page）と、Context を閉じる口と、crash の受け手を外す口。
    let view: AuditView | undefined;
    // REV-SD の I-1: Passive の page の main frame の見張り（読み込みの前に付け、閉じる前に外す）。
    let scopeWatch: AuditScopeWatch | null = null;
    let closePassive: (() => Promise<readonly PassiveSessionCloseFailure[]>) | null = null;
    let stopCrashWatch: (() => void) | null = null;
    let network: NetworkCollectorHandle | undefined;
    let consoleHandle: CollectorHandle<EvidencePayloadByType['console']> | undefined;
    // AUD-2a: 直前に終えた段の、集めた状態と時刻（`record` が既定で付ける）。段を始めていなければ `null`。
    let lastCapture: EvidenceCapture | null = null;
    // AUD-2a: 安定の判定の結果と、通知の枠の扱い（段を始めなければ `null`）。
    let settlingRecord: ViewportSettlingRecord | null = null;
    let notificationHandling: ViewportNotificationHandlingRecord | null = null;
    // AUD-2d: 落ち着いた後の確かめ直しの結果（収集で書く）。
    const pendingRecheck: { value: PendingRecheck | null } = { value: null };
    // COV-4 の区切り 3: このビューポートで監査した開いた状態（操作の段が書き、Rule の評価の段で読む）。
    const openedStates: PendingOpenedState[] = [];
    /** AUD-2a: ビューポートを始めた時刻から今までの、`phase` の集めた状態と時刻（読み込み全体から集めた Evidence。位置は持たない）。 */
    const viewportCaptureOf = (phase: PageAuditStage, url: string | null): EvidenceCapture => Object.freeze({
      stateId,
      phase,
      startedAt: viewportStartedAt,
      finishedAt: this.#clock().toISOString(),
      url,
      scrollPosition: null,
    });
    const record = <TType extends EvidenceType>(
      type: TType,
      payload: EvidencePayloadByType[TType],
      capture: EvidenceCapture | null = lastCapture,
    ): EvidenceRecord => {
      const created = createEvidenceRecord(
        { type, pageId, viewport: profile, payload, capture: capture ?? undefined },
        { allocator: this.#allocator, clock: this.#clock },
      ) as EvidenceRecord;
      evidence.push(created);
      return created;
    };

    try {
      // 1. Passive Context と page を、期限付きで作る（DEF-008。Task 18 の前の整理の設計書 4.2、4.4）。期限は、今から
      // `sessionOpenTimeoutMs` 後と、Run の時間の上限の早い方である（L1: ページの期限は撤廃した）。
      const opened = await this.#ports.openPassive(
        viewportSize,
        passiveSessionOpenDeadlineAtMs({ timeoutMs: this.#deadlines.sessionOpenTimeoutMs, notAfterMs: this.#runDeadlineOrUndefined() }),
        this.#deadlines,
      );
      // 構築に失敗した Context の Ledger も、Safety の Evidence と違反の集計に含める（設計書 4.3、R14 の I2、R14r の Important-1）。
      // Guard の取り付けの失敗は、この Ledger に違反として記録されるためである。Guard が Context を閉じた場合も、エラーは Ledger を持つ。
      if (opened.ledger !== null) {
        safety.passiveLedgers.push(opened.ledger);
      }
      let load: AuditPassiveLoad | undefined;
      switch (opened.status) {
        case 'OPENED':
          load = opened.load;
          view = load.view;
          closePassive = opened.close;
          break;
        case 'FAILED':
          // 今の失敗の扱い。Context は、Guard がまだ閉じていなければ、`finally` で閉じる。
          failed = true;
          closePassive = opened.close;
          reasons.push(sessionFailureReason(SESSION_FAILURE_LABELS.open, opened.error));
          break;
        case 'DEADLINE_EXCEEDED':
          // 作成の期限切れは、ビューポートの失敗とする。Context は部品が閉じた（遅れて届く Context も、部品が閉じる）ので、
          // `finally` で閉じ直さない。部品が閉じる処理の失敗（期限切れを含む）は、閉じる処理の失敗として記録する。
          failed = true;
          reasons.push(sessionOpenDeadlineReason(), ...closeFailureReasons(opened.closeFailures));
          break;
      }

      if (load !== undefined) {
        const passive = load;
        const activePage = passive.view;
        // REV-SD の I-1: 読み込みの後にページが自分で範囲の外へ移ったら、それ以降の操作をしない（判定は `audit-scope-watch.ts` の 1 か所）。
        const scope = activePage.watchAuditScope(this.#isOutsideAuditScope, url);
        scopeWatch = scope;
        const watchPassive: PageWatch = (work, contentKinds) => this.#watchOnPage(activePage, work, contentKinds);
        const runner = new StageRunner(activePage, reasons, watchPassive);
        stages = runner;
        stopCrashWatch = activePage.onCrash(runner.onCrash);
        // L1: Passive の段階は、既定で、進みの見張りで待つ（期限はない）。
        // AUD-2a: 段の始めと終わりの時刻と、終えたときの URL と位置を、集めた状態と時刻（`lastCapture`）に残す。位置は、見張りの中で段の値を得た後に読む
        // （見張りが段を終えた後は読まない。L1b の途中の記録を待たずに返すため）。見放さない段（別の Context）は、Passive の page の位置を読まない。
        const attempt = async <T>(
          stage: PageAuditStage,
          work: (signals: ProgressSignals | null) => Promise<T>,
          watched = true,
          failureReason?: StageFailureReason,
          keepOnWatchEnd = false,
        ): Promise<StageAttempt<T>> => {
          const startedAt = this.#clock().toISOString();
          let location: CaptureLocation | null = null;
          // DBG-1: 段ごと（落ち着き・axe・撮影・開いた状態の確かめなど）の時間を測る（切なら何もしない）。
          const result = await this.#debugTiming.measure('AUDIT_STAGE', () => ({ pageId, stateId, part: stage }), () => runner.attempt(stage, async (signals) => {
            const value = await work(signals);
            if (watched && signals?.signal.aborted !== true) {
              location = await activePage.captureLocation();
            }
            return value;
          }, watched, failureReason, keepOnWatchEnd));
          // 段の中（閉包）で代入するので、型の絞り込みを外して読む。
          const finished = location as CaptureLocation | null;
          lastCapture = Object.freeze({
            stateId,
            phase: stage,
            startedAt,
            finishedAt: this.#clock().toISOString(),
            url: finished?.url ?? null,
            scrollPosition: finished?.scrollPosition ?? null,
          });
          return result;
        };

        // 2. collector を取り付ける（performance の init script はナビゲーションの前に入れる）。
        const performanceInstalled = config.audit.performance
          && (await attempt('performance', () => passive.installPerformance())).ok;
        // BN-a（設計書 3.1 の 3）: 失敗の行の時点の印は、Guard の時点の決め方で付ける。collector は閉じる前（手順 6）に外すので、ページの監査の network の
        // Evidence の失敗は、測りの前と最中（`LOAD`）のものだけである。AUD-7: 誤りの応答の文脈に、承認したサービスの Origin かを残す。
        network = passive.attachNetwork(this.#approvedServiceOrigins);
        consoleHandle = passive.attachConsole();

        // 3. ナビゲーションする。
        // L1（設計者の判断 2）: 読み込みの期限（`navigationTimeoutMs`）は撤廃し、進みの見張りで待つ。読み込みは通信と画面の変化そのものが進みなので、全部の印を
        // 中身の進みに数える（通信の続く遅い読み込みを見放さない）。見張りが終えたら、読み込みの時間切れ（Run の時間の上限なら失敗）として扱う
        // （サイトの不調の判定と再試行は、前の時間切れと同じ）。crash の段階を記すために、処理中の段階にする。
        // DEF-138: 認証つきの Run では、main frame の文書の要求の経路を、セッションの切れの確かめまで記録する（要求を足さない。証拠だけに使う）。DF-3:
        // 確かめは、ビューポートの終わりまで続くので、記録は Context を閉じる前に外す。
        const route = this.#sessionLostPathPrefix === null ? null : activePage.observeSessionLossNavigation();
        const passiveLoad: SessionLossLoad = { stage: PASSIVE_STAGE, view: activePage, route };
        sessionLossLoads.push(passiveLoad);
        let loaded: PageNavigationResult;
        // 見張りが読み込みを終えた理由（終えなければ `null`）。
        let navigationEnd: ProgressWatchEnd | null = null;
        let loading: Promise<PageNavigationResult> | undefined;
        // DBG-1: 読み込みの時間を測る（切なら何もしない）。
        const watchedNavigation = await this.#debugTiming.measure('AUDIT_STAGE', () => ({ pageId, stateId, part: 'navigation' }), () => runner.during('navigation', () => watchPassive((signals) => {
          loading = passive.navigate(url, {
            timeoutMs: OPEN_ENDED_STAGE_MS,
            ledger: activePage.ledger(),
            allowedQueryParameters,
            abandonSignal: signals.signal,
            // SD-2: 範囲の外へ移った画面は点検しない。
            ...(this.#isOutsideAuditScope === undefined ? {} : { isOutsideAuditScope: this.#isOutsideAuditScope }),
          });
          return loading;
        }, PROGRESS_SIGNAL_KINDS)));
        if (watchedNavigation.status === 'REJECTED') {
          throw watchedNavigation.reason;
        }
        if (watchedNavigation.status === 'ENDED') {
          // 見張りが終えた読み込みは、見放す印で時間切れの観測として返る（応答の status は追跡の値）。
          navigationEnd = watchedNavigation.end;
          reasons.push(progressWatchEndReason('navigation', navigationEnd));
          if (loading === undefined) {
            throw new Error('the watched load did not start');
          }
          loaded = await loading;
        } else {
          loaded = watchedNavigation.value;
        }
        navigation = loaded;

        if (navigation.navigationOutcome !== 'OK') {
          failed = true;
          reasons.push(Object.freeze({ code: 'NAVIGATION_FAILED', detail: navigationFailureDetail(navigation) }));
        }
        // T25c: 認証つきの Run では、main frame の最後の URL がセッションの切れの path に当たったら（Guard が除外で止めた移動の先を含む）、
        // FAILED にし、理由 `AUTH_SESSION_LOST`（`detail` は段階）を加え、収集をしない（ログインの画面を管理画面として監査しない）。
        // サイトの不調の判定より先に確かめる（除外で止めたログインの画面への移動の失敗を、サイトの不調と取り違えないため）。
        if (this.#detectSessionLoss(SESSION_LOSS_CHECK_POINTS.navigation, [passiveLoad], authSessionLoss, reasons) !== null) {
          failed = true;
        } else if (navigationEnd === 'RUN_TIME_LIMIT') {
          // L1: Run の時間の上限で見放した読み込みは、サイトの不調にしない（時間切れの観測でも判定しない）。
          failed = true;
        } else if (siteUnavailability.observe(PASSIVE_STAGE, navigation.loadObservation)) {
          // 読み込みの観測で、サイトの不調を判定する（サイトが応答しないときに Run を止める設計書 3.1）。不調なら、読み込みが `OK`
          // （503 など）でも FAILED にし、理由 `SITE_UNAVAILABLE`（`<段階>:<判定の詳細>`）を加える。読み込みの失敗の理由は、そのまま残す。
          // L1: 進みの見張りが見放した読み込みは、前の時間切れと同じ観測で判定する。
          failed = true;
        }
        // 読み込みが失敗した場合と、不調を検知した場合と、セッションの切れを検知した場合は、収集（4. と 5.）をしない（不調では、scroll
        // などでページの部品の読み込みがさらに起きるのを避ける。設計書 3.1）。
        if (navigation.navigationOutcome === 'OK' && siteUnavailability.detected === null && authSessionLoss.stage === null) {
          // DEF-250 の c: 読み込んだ後は、段の前と段の間に、page を使うのをやめる原因（main frame の外部スキームへの移動の記録・文書の消失）を見る（幅の走査の C と
          // 同じ判定 `auditDocumentLeftCause`）。原因があれば、残りの段を始めずにビューポートを終える（閉じるのは、ビューポートの後片付けの持ち主の口）。
          // REV-SD の I-1: 点検の範囲の外へ移ったことも、残りの段を始めない原因にする（理由は、ビューポートの終わりに読み込みの失敗として残す）。
          runner.watchDocument(() => activePage.documentLeftCause(true) ?? (scope.outsideUrl() === null ? null : OUTSIDE_AUDIT_SCOPE_CAUSE));
          // 4. DOM の準備を待ち、controlled scroll を行う。
          const settlingStartedAtMs = this.#now();
          const dataActivity = (): DataRequestActivity => (network === undefined ? NO_DATA_ACTIVITY : network.dataRequestActivity());
          const settling = await attempt('settling', (signals) => this.#waitForSettled(activePage, signalsOf(signals), dataActivity));
          if (settling.ok && settling.value.status === 'PARTIAL') {
            reasons.push(Object.freeze({ code: 'DOM_READINESS_FAILED', detail: settling.value.reason }));
          }
          // AUD-2a: 安定の判定の結果を、ビューポートの記録に残す（見張りが段を終えたら、その理由）。
          settlingRecord = settlingRecordOf(settling, Math.max(0, this.#now() - settlingStartedAtMs), runner.lastWatchEnd);
          // DF-3（DEF-167）: 落ち着きを待った後にも確かめる（読み込みの後にスクリプトがログインの画面へ移すサイト）。当たれば、読み込みの直後と同じく
          // FAILED にし、収集をしない。
          if (this.#detectSessionLoss(SESSION_LOSS_CHECK_POINTS.settled, [passiveLoad], authSessionLoss, reasons) !== null) {
            failed = true;
          }
        }
        // 落ち着きの待ちの後にセッションの切れを検知した場合も、scroll と収集をしない（同じ条件で確かめ直す）。
        if (navigation.navigationOutcome === 'OK' && siteUnavailability.detected === null && authSessionLoss.stage === null) {
          // DEF-210（設計書 3.2・3.3）: 落ち着いた後、測る前に、通知の枠を閉じる（閉じられない枠は隠す）。初めての枠があるときだけ、閉じる前の layout を
          // 測って残す（覆いの規則が 1 回だけ評価する）。落ち着きの待ちの段の続きとして行う（段の名前は増やさない）。押したことで画面が移っても、
          // 読み込み直さず、そのまま点検を続ける（移ったことは Evidence に残る）。
          await attempt('settling', (signals) => this.#handleNotificationFrames(
            activePage, profile, viewportSize, notification, signalsOf(signals), () => scope.outsideUrl() === null,
            { pageId, retryAttempt: screenshotRetryAttempt, record: (shot) => record('screenshot', shot) },
          ));
          // AUD-2a: 通知の枠の扱い（閉じた数・隠した数・見た枠の digest）を、ビューポートの記録に残す。
          notificationHandling = notificationHandlingRecordOf(notification.overlay);
          // fix round 2（設計書 3.2.1 の 4）: 閉じる押下で main frame の移動を試みた（Guard が数えた）ビューポートは、誤りの画面を測らない（scroll と収集をしない）。
          // 読み込み直しもしない。理由を残して PARTIAL にする。
          const dismissalNavigationBlocked = notification.overlay?.navigated === true;
          if (dismissalNavigationBlocked) {
            reasons.push(NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON);
          }
          // L1・L9: scroll の段の期限（`resourceSettlingTimeoutMs` × 4）は撤廃した。期限を渡さず、段の見張りの口を渡す（部品は新しい位置・高さ・作りを
          // 読んだときだけ進みの印を付け、口の abort で、それまでの記録を返す）。見張りが段を終えたら、その記録を残し、理由は見張りの 1 つだけにする。
          // EV-1: scroll の段の前に、LCP だけを読んでおく（スクロールで後から描かれた塊を LCP に数えない。測り直しも読み込み直しもしない）。
          let lcpBeforeScroll: Awaited<ReturnType<AuditView['readLcpBeforeScroll']>>;
          const scroll = dismissalNavigationBlocked ? STAGE_NOT_COMPLETED : await attempt('scroll', async (signals) => {
            if (performanceInstalled) {
              lcpBeforeScroll = await signalsOf(signals).track(activePage.readLcpBeforeScroll());
            }
            return activePage.controlledScroll({
              stepViewportFraction: CONTROLLED_SCROLL_PACING.stepViewportFraction,
              ...this.#windows.scroll,
              progress: signalsOf(signals),
            });
          }, true, undefined, true);
          if (scroll.ok) {
            record('scroll', scroll.value);
            if (scroll.watchEnded === undefined) {
              reasons.push(...scrollIncompleteReasons(scroll.value));
            }
          }

          // 5. 収集する（閉じる押下の移動を止めたビューポートは、収集しない）。
          if (!dismissalNavigationBlocked) await this.#collect({
            url,
            pageId,
            profile,
            view: activePage,
            viewportSize,
            allowedQueryParameters,
            performanceInstalled,
            network,
            screenshotRetryAttempt,
            reasons,
            safety,
            siteUnavailability,
            authSessionLoss,
            sessionLossLoads,
            deferredStressSweep,
            notification,
            scrolled: scroll.ok,
            lcpBeforeScroll,
            record,
            attempt,
            currentCapture: () => lastCapture,
            recheck: pendingRecheck,
            openedStates,
            stateId,
            stages: runner,
          });
        }

        // ナビゲーションの成否と crash にかかわらず、network と console の Evidence を記録する（設計書 4.3.0）。
        // どちらも page の外（Node 側）に集めた記録なので、crash の後も読む。
        // AUD-2a: 読み込みから今までに集めた記録なので、段は `navigation`、時刻の範囲はビューポートを始めた時から今まで。
        let finalUrl: string | null;
        try {
          finalUrl = activePage.url();
        } catch {
          finalUrl = null;
        }
        const networkSnapshot = await snapshotCollector('navigation', activePage, reasons, network);
        if (networkSnapshot.ok) {
          record('network', networkSnapshot.value, viewportCaptureOf('navigation', finalUrl));
        }
        const consoleSnapshot = await snapshotCollector('navigation', activePage, reasons, consoleHandle);
        if (consoleSnapshot.ok) {
          record('console', consoleSnapshot.value, viewportCaptureOf('navigation', finalUrl));
        }
        // DF-3（DEF-167）: ビューポートの終わりに、このビューポートで読み込んだ page を確かめ直す（Context を閉じる前。ページを離れる手順（T44b）の前の、
        // main frame の最後の URL を見るため）。時機は、次のビューポートの前か、ページの監査の終わり（`viewportEndCheckPointOf`）。
        this.#detectSessionLoss(viewportEndCheckPointOf(profile), sessionLossLoads, authSessionLoss, reasons);
      }

      // 段階の途中で見つけられなかった crash も、理由として記録する（設計書 4.5.4、R14 の m1）。
      stages?.recordPendingCrash('safety');
      // DEF-236: 証拠を集め終えた（例外で終えた読み込みでは待たない）。
      evidenceSettled = true;
    } finally {
      // 6. page と Context を必ず閉じる。閉じる処理の失敗も、理由として記録する。ページの期限を過ぎて見放した段階は、
      // Context を閉じると終わる（メインスレッドが止まったページも含む。設計書 4.5.7）。閉じる順と、ページを離れる手順（T44b）は変えない。
      network?.detach();
      consoleHandle?.detach();
      stopCrashWatch?.();
      // DEF-138・DF-3: 経路の記録は、閉じる前に外す（BeakSight がページを離れる移動を記録しない）。
      for (const load of sessionLossLoads) {
        load.route?.dispose();
      }
      // DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 1・4・5）: 次の読み込みがあるなら、collector を外した後、閉じる前に、この画面を
      // 見せたまま読み込みの間隔を待つ（待ちは閉じる処理の期限の外）。違反・不調・セッションの切れ・ダウンロード・Run の時間の上限・crash の後と、最後のページの
      // 後は、待たずに閉じる。待ちの後に閉じ、次のセッションを作る（同時に 2 つの Context は生かさない）。
      const shownView = view;
      if (shownView !== undefined && waitsWithPageShown({
        evidenceSettled,
        crashed: stages?.crashed === true,
        downloadBlocked: () => navigation !== null && navigation.navigationOutcome !== 'OK' && shownView.loadFacts()?.mainFrameDownloadBlocked === true,
        nextLoadMayStart: () => this.#nextLoadMayStart(siteUnavailability, authSessionLoss),
        laterLoadFollows: () => laterLoadFollows(evidence),
      })) {
        await this.#waitWithPageShown(shownView, safety, null);
      }
      // REV-SD の I-1: 閉じる前に、今の URL を見直してから見張りを外す（閉じる前に BeakSight が離れる移動は見ない）。
      scopeWatch?.outsideUrl();
      scopeWatch?.dispose();
      reasons.push(...closeFailureReasons(closePassive === null ? [] : await closePassive()));
    }
    // DF-3: Context を閉じた後にも、もう一度確かめる（閉じる間に Guard が止めた main frame の移動を含める。Ledger は閉じた後も factory から読める）。
    this.#detectSessionLoss(viewportEndCheckPointOf(profile), sessionLossLoads, authSessionLoss, reasons);

    // DEF-191（設計書 `2026-11-04-beaksight-login-session-design.md` 3.1 の 1）: Desktop の幅の走査は、D の Context を閉じた後に回す（Mobile の前）。D と幅の
    // 走査の Context が同時に生きないので、同じ更新の鍵で更新を 2 回送らない。D の page が crash したビューポートは、前の順と同じく走査しない。layout の Evidence は
    // 走査の後に記録する（主の形は D で測ったもの）。走査で読み込んだ page も、ビューポートの終わりの時機で確かめ直す（前の順と同じ確かめの範囲）。
    // fix round 3（設計書 3.2.2 の 1・4）: 押す期間（最初に閉じるか隠した時から Context を閉じるまで）に、Guard が main frame の移動かポップアップを見たビューポートは、
    // 誤りの画面を測ったおそれがあるので、測った Evidence を捨て、幅の走査もしない（PARTIAL と理由。読み込み直しはしない）。Context を閉じた後に数を読む。
    const closedView = view;
    if (closedView !== undefined && closedView.pressNavigations() > 0) {
      if (!reasons.some((reason) => reason.code === NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON.code)) {
        reasons.push(NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON);
      }
      discardMeasuredEvidence(evidence);
      deferredStressSweep.value = null;
    }
    // REV-SD の I-1: 読み込めた画面が、その後に点検の範囲の外へ移ったら、読み込みで移ったときと同じく点検しない（`BLOCKED_EXTERNAL_REDIRECT`。通信・console・
    // 安全の記録のほかの Evidence を捨て、幅の走査もしない）。
    const outsideUrl = scopeWatch?.outsideUrl() ?? null;
    if (outsideUrl !== null && navigation !== null && navigation.navigationOutcome === 'OK') {
      navigation = movedOutsideAuditScopeNavigation(navigation, outsideUrl, url, allowedQueryParameters);
      failed = true;
      reasons.push(Object.freeze({ code: 'NAVIGATION_FAILED', detail: navigationFailureDetail(navigation) }));
      discardMeasuredEvidence(evidence, OUTSIDE_AUDIT_SCOPE_DISCARDED_EVIDENCE_TYPES);
      deferredStressSweep.value = null;
      pendingRecheck.value = null;
      openedStates.length = 0;
    }
    const pendingSweep = deferredStressSweep.value;
    if (pendingSweep !== null && closedView !== undefined) {
      // AUD-3d・SWR: 幅の画像とフォーカスの確かめの Evidence を除き、画像のファイルを消す（結果を残さない幅と、大きさを変えて集めて捨てた幅の共通）。
      const dropStressWidthEvidence = async (widths: ReadonlySet<number>): Promise<void> => {
        for (let index = evidence.length - 1; index >= 0; index -= 1) {
          const created = evidence[index];
          if (created?.type === 'screenshot' && created.payload.stressWidth !== undefined && widths.has(created.payload.stressWidth)) {
            evidence.splice(index, 1);
            await rm(artifactFilePath(this.#screenshotRootDirectory, created.payload.relativePath), { force: true }).catch(() => undefined);
          } else if (created?.type === 'focus' && created.payload.stressWidth !== undefined && widths.has(created.payload.stressWidth)) {
            // AUD-4d: その幅のフォーカスの確かめも残さない（その幅の画像は、上で消す）。
            evidence.splice(index, 1);
          }
        }
      };
      // AUD-3d・4d: 幅の走査の各幅の、viewport の画像（画像を撮る設定のときだけ）とフォーカスの確かめを残す口（状態 ID は Desktop の読み込みのもの）。
      const stressScreenshots: StressScreenshotSink = {
        pageId,
        retryAttempt: screenshotRetryAttempt,
        screenshots: config.audit.screenshots,
        record: (type, payload, capture) => record(type, payload, capture),
        discardWidths: dropStressWidthEvidence,
        hiddenFrameCountOf: (width) => hiddenFrameCountOf(notification.stress.find((entry) => entry.width === width)?.overlay),
      };
      // fix round 3・SWR の 4: 押す期間に移動かポップアップを止めた幅（幅ごとに、その幅の間に増えた数で決める）。
      const pressBlockedWidths = new Set<number>();
      const sweepState = { reasons, safety, siteUnavailability, authSessionLoss, sessionLossLoads, notification, stressScreenshots, pressBlockedWidths };
      // DEF-250 の c: 点検の途中で page を使うのをやめたビューポートは、幅の走査も始めない（そのビューポートを終えた）。
      // DUP: 幅の走査をしない深さのページも、始めない（`DeferredStressSweep.sweep`）。
      const stressSweep = stages?.crashed === true || stages?.documentLeft === true || !pendingSweep.sweep
        ? null
        : await this.#sweepStressWidths(url, pendingSweep, new StageRunner(closedView, reasons, (work, kinds) => this.#watchOnPage(closedView, work, kinds)), sweepState);
      for (const load of sessionLossLoads) {
        load.route?.dispose();
      }
      this.#detectSessionLoss(viewportEndCheckPointOf(profile), sessionLossLoads, authSessionLoss, reasons);
      // fix round 3（設計書 3.2.2 の 1・4）: 幅の走査の各幅も、その幅の押す期間に移動かポップアップを止めたら、その幅の結果を残さない（理由を残す）。
      if (pressBlockedWidths.size > 0 && !reasons.some((reason) => reason.code === NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON.code)) {
        reasons.push(NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON);
      }
      const keptSweep = stressSweep === null ? null : stressSweep.filter((result) => !pressBlockedWidths.has(result.width));
      // AUD-3d: 結果を残さない幅は、その幅の画像も残さない（Evidence を除き、ファイルを消す。誤りの画面の画像を残さない）。
      await dropStressWidthEvidence(pressBlockedWidths);
      // AUD-2a: 幅の走査の後に包んでも、主の形を測った時刻と状態（`primaryCapture`）を残す。
      record('layout', layoutPayloadOf(pendingSweep.primary, keptSweep, notification), pendingSweep.primaryCapture);
    }
    // AUD-2e: 確かめ直しで集め直した主の layout を、1 回目の layout の Evidence の後に残す（集めた段 `recheck` の状態と時刻のまま）。1 回目の layout の
    // Evidence がない（捨てた）ビューポートでは残さない（比べる相手がない）。
    const recheckLayout = pendingRecheck.value?.layout ?? null;
    if (pendingRecheck.value !== null && recheckLayout !== null) {
      const recordedIds = evidence.some((created) => created.type === 'layout')
        ? [record('layout', recheckLayout.payload, recheckLayout.capture).evidenceId]
        : [];
      pendingRecheck.value = Object.freeze({ ...pendingRecheck.value, evidenceIds: Object.freeze([...pendingRecheck.value.evidenceIds, ...recordedIds]), layout: null });
    }

    // 7. Safety の Evidence を、Ledger ごとに1つ作る（Passive の Context、Interaction の候補ごと、幅の走査のセッション）。BN-a（設計書
    // `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 2・4）: Context を閉じた後の snapshot で作る（閉じる途中・ページを離れた後に止めた
    // 要求も、時点 `CLOSING` で page.json に残す。違反の集計 `summarizePageSafety` と同じ時点）。各 Evidence に、読み込みの印を付ける。
    // DEF-236: 前の画面を見せたまま待った Ledger は、待ちの間の事象を Rule の入力から除いた写しを作る（Evidence には全部を残す）。
    const ruleInputs = new Map<EvidenceRecord, EvidenceRecord>();
    // AUD-2a: Safety の Evidence は、Context を閉じた後に、ビューポートを始めた時から今までの記録で作る（段は `safety`）。
    const recordSafety = (ledger: SafetyLedger, payload: EvidencePayloadByType['safety']): void => {
      const created = record('safety', payload, viewportCaptureOf('safety', null));
      const window = safety.pacingWaits.get(ledger);
      if (window !== undefined && created.type === 'safety') {
        ruleInputs.set(created, Object.freeze({ ...created, payload: withoutPacingWaitEvents(created.payload, window) }));
      }
    };
    for (const ledger of safety.passiveLedgers) {
      recordSafety(ledger, safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE', PAGE_AUDIT_LOAD));
    }
    for (const { snapshot, candidateIndex } of safety.interactionSnapshots) {
      record('safety', safetyEventsEvidenceFromSnapshot(snapshot, 'INTERACTION', { kind: 'INTERACTION', candidateIndex }), viewportCaptureOf('safety', null));
    }
    for (const { ledger, width, widths } of safety.stressLedgers) {
      // REV-SWR の M-1: 大きさを変えた Context は、結果を残した幅がなくても `widths`（空）を持つ（どの幅の指摘にも結び付けない）。
      recordSafety(ledger, safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE', widths === undefined
        ? { kind: 'STRESS_WIDTH', width }
        : { kind: 'STRESS_WIDTH', width, widths: Object.freeze([...widths]) }));
    }

    // 8. page rule を評価する。Safety の Evidence は、ここまでに Rule の入力にそろっている（設計書 4.3）。Rule は Evidence だけを読む（page と Context を
    // 閉じた後でもよい）。DEF-236: 見せたままの待ちの間の事象は、Rule の入力に入れない。
    // AUD-2d の直し・AUD-2e: 確かめ直しの Evidence（axe と主の layout）は、1 回目の Rule の評価の入力に入れない（確かめ直しの評価で比べる）。
    const recheckedEvidenceIds = new Set<EvidenceId>(pendingRecheck.value?.evidenceIds ?? []);
    // COV-4 の区切り 3: 開いた状態の記録は、1 回目の評価の入力に入れない（開いた状態ごとに、その記録だけで評価する）。
    const openedEvidenceIds = new Set<EvidenceId>(openedStates.flatMap(({ evidenceIds, recheck }) => [...evidenceIds, ...(recheck?.evidenceIds ?? [])]));
    // DUP（設計者の判断 2026-11-18、REV-DUP の M-3・M-6）: Rule に渡す記録の種類は、深さの段の表（`ruleEvidenceTypes`。点検を省くページは安全・通信・console
    // だけ。layout などの事実は判定にだけ使い、同じ中身の画面の指摘と重なる表示の指摘を作らない）。
    const ruleEvidenceTypes = pageAuditStagesOf(this.#pageDecision.depth, profile).ruleEvidenceTypes;
    const baseFindings = this.#evaluateRules(
      url,
      pageId,
      profile,
      evidence
        .filter((created) => !recheckedEvidenceIds.has(created.evidenceId) && !openedEvidenceIds.has(created.evidenceId))
        .filter((created) => ruleEvidenceTypes === null || ruleEvidenceTypes.includes(created.type))
        .map((created) => ruleInputs.get(created) ?? created),
      reasons,
    );
    // COV-4 の区切り 3（設計者の判断 2026-11-10）: 開いた状態ごとに、その記録だけで Rule を評価し、開く前の画面と fingerprint が同じ指摘を除く。除いた数は、
    // その状態を開いた操作の記録（`openedState.duplicateFindingCount`）に書き直す（バンドルの summary に出す）。
    const openedFindings: Finding[] = [];
    for (const opened of openedStates) {
      const ids = new Set(opened.evidenceIds);
      const stateFindings = this.#evaluateRules(url, pageId, profile, evidence.filter((created) => ids.has(created.evidenceId)), reasons);
      // その状態の確かめ直し（AUD-2d・2e）の表と、後から出た問題（`LATE`）。比べるのは、その状態の記録と指摘だけ。
      const recheckIds = new Set(opened.recheck?.evidenceIds ?? []);
      const stateRecheck = opened.recheck === null
        ? null
        : this.#recheckRecordOf(
          opened.recheck,
          opened.openedState.stateId,
          url,
          pageId,
          profile,
          evidence.filter((created) => ids.has(created.evidenceId) || recheckIds.has(created.evidenceId)),
          stateFindings,
        );
      const { kept, droppedCount } = findingsNotInBase([...baseFindings, ...openedFindings], [...stateFindings, ...(stateRecheck?.lateFindings ?? [])]);
      openedFindings.push(...kept);
      const position = evidence.findIndex((created) => created.evidenceId === opened.interactionEvidenceId);
      const interactionRecord = evidence[position];
      if (interactionRecord?.type === 'interaction') {
        evidence[position] = Object.freeze({
          ...interactionRecord,
          payload: Object.freeze({
            ...interactionRecord.payload,
            openedState: Object.freeze({
              ...opened.openedState,
              duplicateFindingCount: droppedCount,
              ...(stateRecheck === null ? {} : { recheck: stateRecheck.record }),
            }),
          }),
        });
      }
    }
    const firstFindings: readonly Finding[] = [...baseFindings, ...openedFindings];
    // AUD-2d: 確かめ直しの表（指摘の印は、ここで 1 回目の指摘と比べて付ける）。`LATE` の指摘は、本体の Finding に足す。
    const rechecked = pendingRecheck.value === null
      ? null
      // COV-4 の区切り 3: 確かめ直しは、開く前の画面の指摘とだけ比べる（開いた状態の指摘は、確かめ直しの対象の外）。
      : this.#recheckRecordOf(pendingRecheck.value, stateId, url, pageId, profile, evidence, baseFindings);
    const recheck = rechecked?.record ?? null;
    const findings: readonly Finding[] = rechecked === null ? firstFindings : [...firstFindings, ...rechecked.lateFindings];
    stages?.recordPendingCrash('rules');

    // DEF-129: Context を閉じた後に、文書の読み込みの事実を読む（Guard の 1 か所が数えた値）。ページが始めた読み込み（main frame か、T37R2-fix で子の
    // frame）を上限で止めたビューポートは、読み切れていない（`PAGE_NAVIGATION_LIMIT_REACHED`）。SPEC-1: 要求の数は成果物に書かない。
    const loadFacts = closedView === undefined ? null : closedView.loadFacts();
    if (loadFacts?.limitReached === true) {
      reasons.push(PAGE_NAVIGATION_LIMIT_INCOMPLETE_REASON);
    }
    // DEF-225: 読み込みが失敗し、それが Guard の止めたダウンロードによるもの（Context を閉じた後に読む Guard の事実）なら、読み込みの失敗の理由を、ダウンロードに
    // なった理由に替える（FAILED のまま。読み込み直さない）。
    if (navigation !== null && navigation.navigationOutcome !== 'OK' && loadFacts?.mainFrameDownloadBlocked === true) {
      const failure = reasons.findIndex((reason) => reason.code === 'NAVIGATION_FAILED');
      if (failure >= 0) reasons.splice(failure, 1, DOWNLOAD_RESPONSE_REASON);
      else reasons.push(DOWNLOAD_RESPONSE_REASON);
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
        // AUD-2a: この読み込みの状態 ID と、安定の判定の結果・通知の枠の扱い（段を始めたときだけ）。
        stateId,
        ...(settlingRecord === null ? {} : { settling: settlingRecord }),
        ...(notificationHandling === null ? {} : { notificationHandling: withStressHiddenCount(notificationHandling, notification.stress) }),
        ...(recheck === null ? {} : { recheck }),
      },
      evidence,
      findings,
      safety,
      siteUnavailability: siteUnavailability.detected,
      authSessionLostStage: authSessionLoss.stage,
      // DEF-138: Context を閉じた後に組み立てる（閉じるときに factory が読んだ状態の名前と、閉じる間に止めた要求を含める）。
      authSessionLoss: this.#sessionLossEvidenceOf(url, profile, authSessionLoss),
    };
  }

  /**
   * 認証つきの Run で、決めた時機（`point`。`SESSION_LOSS_CHECK_POINTS`）に、読み込んだ page（`loads`。読み込んだ順）のどれかで、セッションが切れたかを
   * 確かめる（T25c。Task 25 の設計書 4.3。DF-3 で時機を増やした）。公開監査（前方一致の指定なし）と、このビューポートで記録した後は、確かめずに `null`。
   * - main frame の最後の URL（`page.url()`）の path が、セッションの切れの path の前方一致に当たる。
   * - または、その Context の Guard が、監査の段の除外で止めた main frame の移動の先（Safety Ledger の `blockedAuditExclusions` の、
   *   `mainFrameNavigation` が真の記録の URL）の path が当たる（ログインの画面が読む範囲の外で、Guard がリダイレクトを止めた場合）。
   * 判定は、ワーカーの 1 画面の読み込みと同じ部品（`authenticated-run.ts` の `sessionLostUrlAt` を通した `sessionLostUrlOf`。CCX-6）。
   * 当たれば、最初に当たった読み込みを `loss` に記録し（段階の部分は `sessionLossStageDetailOf`。証拠の経路はその時点の記録）、理由 `AUTH_SESSION_LOST` を
   * `reasons` に加え、当たった読み込みの段階を返す。URL や値は記録しない。
   */
  #detectSessionLoss(
    point: SessionLossCheckPoint,
    loads: readonly SessionLossLoad[],
    loss: ViewportAuthSessionLoss,
    reasons: IncompleteReason[],
  ): SessionLossLoad['stage'] | null {
    const prefix = this.#sessionLostPathPrefix;
    if (prefix === null || loss.stage !== null) {
      return null;
    }
    for (const load of loads) {
      // fix round 4・5（通知の枠の設計書 3.2.3 の 1、3.2.4 の 2）: 許可 Origin を渡し、押す期間に止めた許可 Origin への移動も見る。
      if (sessionLostUrlAt(point, load.view, load.view.ledger(), prefix, this.#config.site.allowedOrigins) !== null) {
        const stage = sessionLossStageDetailOf(load.stage, point);
        loss.stage = stage;
        loss.source = { view: load.view, navigation: load.route?.snapshot() ?? null };
        reasons.push(authSessionLostReason(stage));
        return load.stage;
      }
    }
    return null;
  }

  /**
   * DEF-138: セッションの切れの証拠（設計書 2.1）を、判定と同じ owner の部品（`sessionLossEvidenceOf`）で組み立てる。検知しなかったビューポートは `null`。
   * Context を閉じた後に呼ぶ（Ledger と状態の名前は、閉じた後でも factory から読める）。サイトへの要求を出さない。
   */
  #sessionLossEvidenceOf(url: NormalizedHttpUrlEvidence, profile: ViewportProfile, loss: ViewportAuthSessionLoss): SessionLossEvidence | null {
    const prefix = this.#sessionLostPathPrefix;
    const { stage, source } = loss;
    if (prefix === null || stage === null || source === null) {
      return null;
    }
    try {
      return sessionLossEvidenceOf({
        stage: `${profile}:${stage}`,
        requestedUrl: url,
        page: source.view,
        ledger: source.view.ledger(),
        sessionLostPathPrefix: prefix,
        navigation: source.navigation,
        stateNames: source.view.authenticatedStateNames(),
        allowedOrigins: this.#config.site.allowedOrigins,
        serviceOrigins: this.#approvedServiceOrigins,
      });
    } catch {
      // 証拠を組み立てられなくても、セッションの切れで止めること（判定）は変えない。
      return null;
    }
  }

  /**
   * DEF-236（設計書 3.1 の 4）: 次の読み込み（次のビューポート・幅・ページ）を始めうるか。違反を記録した後、このビューポートでサイトの不調かセッションの切れを
   * 検知した後、Run の時間の上限の後は、次を始めないので、前の画面を見せたまま待たない。違反は、止めたことを記録しない確かめ（`#safetyViolationDetected`）で
   * 調べる（ここでは何も止めない。止めたことは、次を始めない所で記録する）。
   */
  #nextLoadMayStart(siteUnavailability: ViewportSiteUnavailability, authSessionLoss: ViewportAuthSessionLoss): boolean {
    return nextLoadMayStart({
      siteUnavailable: siteUnavailability.detected !== null,
      sessionLost: authSessionLoss.stage !== null,
      runTimeLimitPassed: () => this.#runTimeLimitPassed(),
      violationDetected: this.#safetyViolationDetected,
    });
  }

  /**
   * DEF-236: 前の画面（`page`）を閉じずに見せたまま、読み込みの間隔を待つ（共有の部品 `waitWithPageShown`）。待ちの範囲は、その Context の Ledger と組にして
   * `safety.pacingWaits` に残す（Rule の入力から除くため）。Ledger を読めない Context（Guard が閉じたなど）では待たない。例外を投げない。
   */
  async #waitWithPageShown(
    view: AuditView,
    safety: ViewportSafetySources,
    signals: Pick<ProgressSignals, 'mark'> | null,
  ): Promise<void> {
    let ledger: SafetyLedger;
    try {
      ledger = view.ledger();
    } catch {
      return;
    }
    const window = await view.waitWithPageShown({ ledger, pacer: this.#pacer, signals });
    if (window !== null) {
      safety.pacingWaits.set(ledger, window);
    }
  }

  /** DEF-210: 見た通知の枠の digest の集合（鍵ごと。なければ作る）。 */
  #seenNotificationDigestsOf(key: string): Set<string> {
    let seen = this.#notificationSeenDigests.get(key);
    if (seen === undefined) {
      seen = new Set();
      this.#notificationSeenDigests.set(key, seen);
    }
    return seen;
  }

  /**
   * DEF-210（設計書 3.2・3.3）: 主の読み込みで、通知の枠を閉じる（閉じられない枠は隠す）。この Run のこのビューポートの種類で初めての枠があるときだけ、閉じる前の
   * layout を測って `notification.beforeDismissal` に残す。結果は `notification.overlay` に残す（読めて枠がなければ残さない）。例外を投げない。
   * L1: 予算（`NOTIFICATION_HANDLING_BUDGET_MS`）とページの期限は撤廃し、段の見張り（`signals`）で待つ。見張りが段を終えたら（abort）、その時点の途中の結果
   * （押した数と押した枠）を打ち切りの印つきで、すぐに残す（段を見放しても、それまでの記録を残す。fix round 2。設計書 3.2.1 の 6）。
   */
  /** REV-SD の I-1: `view`（`requestedUrl` を読み込んだ）の main frame の今の URL が、点検の範囲の中か（判定は `auditScopeLeftUrl`。範囲の判定がなければ中）。 */
  #inAuditScope(view: Pick<AuditView, 'url'>, requestedUrl: string): boolean {
    return this.#isOutsideAuditScope === undefined || auditScopeLeftUrl(view.url(), this.#isOutsideAuditScope, requestedUrl) === null;
  }

  async #handleNotificationFrames(
    view: AuditView,
    profile: ViewportProfile,
    viewportSize: Viewport,
    notification: ViewportNotification,
    signals: ProgressSignals,
    inAuditScope: () => boolean,
    shots: { readonly pageId: PageId; readonly retryAttempt: number | null; readonly record: (shot: ScreenshotEvidence) => void },
  ): Promise<void> {
    const progress: NotificationDismissalProgress = { current: null };
    const keep = (overlay: NotificationOverlayEvidence): void => {
      if (hasNotificationFacts(overlay)) {
        notification.overlay = overlay;
      }
    };
    const keepPartial = (): void => keep(notificationOverlayAfterTimeout(progress));
    // AUD-2（5.2）: 隠す前の画面の画像（隠したときだけ残す）。
    const beforeHide = this.#beforeHideScreenshot({ view, pageId: shots.pageId, profile, retryAttempt: shots.retryAttempt, stressWidth: null });
    signals.signal.addEventListener('abort', keepPartial, { once: true });
    try {
      keep(await view.dismissNotificationFrames({
        deadlineAtMs: this.#openEndedAtMs(),
        pressMode: 'AUDIT',
        seenDigests: this.#seenNotificationDigestsOf(profile),
        progress,
        // REV-SD の I-1: 押す・隠す直前に、範囲の外へ移っていないかを見る。
        inAuditScope,
        beforeFirstDismissal: async () => {
          notification.beforeDismissal = await view.collectLayoutEvidence(viewportSize);
        },
        beforeFirstHide: beforeHide.capture,
      }));
    } finally {
      signals.signal.removeEventListener('abort', keepPartial);
      await beforeHide.commit(notification.overlay?.frames ?? [], shots.record);
    }
  }

  /**
   * AUD-2（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 5.2）: 通知の枠を隠す前の画面の画像。`capture` は最初に隠す直前に呼ばれ（読み込みは
   * しない。撮影は今の部品）、`commit` は閉じる処理の後に呼ぶ（実際に隠した枠があるときだけ Evidence に残し、なければファイルを消す）。画像を撮る設定でないときは
   * 撮らない。撮れなくても、隠す処理と点検は続ける。
   */
  #beforeHideScreenshot(target: {
    readonly view: Pick<AuditView, 'captureViewportScreenshot'>;
    readonly pageId: PageId;
    readonly profile: ViewportProfile;
    readonly retryAttempt: number | null;
    readonly stressWidth: number | null;
  }): {
    readonly capture: () => Promise<void>;
    readonly commit: (frames: readonly NotificationFrameEvidence[], record: (shot: ScreenshotEvidence) => void) => Promise<void>;
  } {
    const relativeArtifactPath = beforeHideScreenshotRelativePath(target.pageId, target.profile, target.retryAttempt, target.stressWidth, this.#screenshotRevisit);
    const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
    let shot: ScreenshotEvidence | null = null;
    return {
      capture: async () => {
        if (!this.#config.audit.screenshots || shot !== null) return;
        try {
          const captured = await target.view.captureViewportScreenshot(
            { outputPath, relativeArtifactPath }, { pageId: target.pageId, viewport: target.profile, stressWidth: target.stressWidth },
          );
          shot = Object.freeze({ ...captured, beforeNotificationHide: true as const });
        } catch {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      },
      commit: async (frames, record) => {
        if (shot === null) return;
        if (frames.some((frame) => frame.hidden)) {
          record(shot);
        } else {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      },
    };
  }

  /**
   * AUD-2d・2e: 落ち着いた後の確かめ直し（読み込み直さない。ページへの要求を足さない）。段は `recheck`（進みの見張りで待つ。期限は置かない）。
   * 1. DOM の形が静まるまで待つ（落ち着きの判定と同じ部品。データの要求も待つ）。
   * 2. DOM の見出しを読み直し、1 回目の見出しと比べて印を付ける（`recheckStatesOf`。鍵は段と文字）。
   * 3. AUD-2e: 1 回目に axe を流したら、1 回目と同じ設定（全部のルール）で axe を流し直す（1 回目になかったルールの新しい違反も拾う）。
   * 4. AUD-2e: 1 回目に主の layout を集めたら、主の layout を集め直す（幅の走査は、読み込み直しが要るので確かめ直さない）。
   * 指摘の印は、Rule の評価の後に `#recheckRecordOf` が付ける。
   * 1 回目の DOM がなければ確かめ直さない（`FIRST_PASS_NOT_COMPLETED`）。段を終えられなければ `STAGE_NOT_COMPLETED`。
   */
  async #recheckAfterSettled(
    state: RecheckTarget,
    firstDom: EvidencePayloadByType['dom'] | null,
    firstAccessibility: EvidencePayloadByType['accessibility'] | null,
    firstLayoutCollected: boolean,
  ): Promise<PendingRecheck> {
    const { view, pageId, attempt } = state;
    const startedAt = this.#clock().toISOString();
    const firstAxeRuleIds = firstAccessibility === null ? [] : firstAccessibility.violations.map(({ ruleId }) => ruleId);
    const evidenceIds: EvidenceId[] = [];
    const notRechecked = (reason: NonNullable<ViewportRecheckRecord['reason']>, settling: ViewportSettlingRecord | null): PendingRecheck => Object.freeze({
      status: 'NOT_RECHECKED',
      reason,
      startedAt,
      finishedAt: this.#clock().toISOString(),
      settling,
      axeRuleIds: Object.freeze([...new Set(firstAxeRuleIds)]),
      accessibility: null,
      // 途中まで残した確かめ直しの Evidence も、1 回目の Rule の評価の入力から除く（表は空のまま）。
      evidenceIds: Object.freeze([...evidenceIds]),
      layout: null,
      headings: Object.freeze([]),
      pageReady: null,
    });
    if (firstDom === null) {
      return notRechecked('FIRST_PASS_NOT_COMPLETED', null);
    }
    const network = state.network;
    const settlingStartedAtMs = this.#now();
    const settled = await attempt('recheck', (signals) =>
      this.#waitForSettled(view, signalsOf(signals), () => network.dataRequestActivity()));
    const settling = settlingRecordOf(settled, Math.max(0, this.#now() - settlingStartedAtMs), state.stages.lastWatchEnd);
    if (!settled.ok) {
      return notRechecked('STAGE_NOT_COMPLETED', settling);
    }
    const dom = await attempt('recheck', () => view.collectDomEvidence(pageId));
    if (!dom.ok) {
      return notRechecked('STAGE_NOT_COMPLETED', settling);
    }
    // AUD-2d の直し・AUD-2e: 確かめ直しの結果は、集めた直後に Evidence に残す（段は `recheck`。`LATE` の指摘が参照する一次の証拠。1 回目の Rule の評価の
    // 入力には入れない）。
    let accessibility: EvidencePayloadByType['accessibility'] | null = null;
    if (firstAccessibility !== null) {
      // AUD-2e: 1 回目と同じ設定（全部のルール）で流す。
      const rechecked = await attempt('recheck', (signals) =>
        view.collectAccessibilityEvidence({ watch: { progress: signalsOf(signals) } }));
      if (!rechecked.ok || rechecked.value.status !== 'COMPLETE') {
        return notRechecked('STAGE_NOT_COMPLETED', settling);
      }
      accessibility = rechecked.value;
      evidenceIds.push(state.record('accessibility', rechecked.value).evidenceId);
    }
    let layout: PendingRecheck['layout'] = null;
    if (firstLayoutCollected) {
      // AUD-2e: 主の layout だけを集め直す（1 回目の主の layout と同じ部品・同じ大きさ）。Evidence は主の形だけ（幅の走査と通知の枠の事実は持たない）。
      // Evidence は、1 回目の layout の Evidence の後に残す（Desktop の 1 回目の layout は、幅の走査の後に残すため。`#recordRecheckLayout`）。
      const rechecked = await attempt('recheck', () => view.collectLayoutEvidence(state.viewportSize));
      if (!rechecked.ok) {
        return notRechecked('STAGE_NOT_COMPLETED', settling);
      }
      layout = Object.freeze({ payload: Object.freeze({ primary: rechecked.value, stressSweep: null }), capture: state.currentCapture() });
      // AUD-3d の続き（証拠の欠けを埋める）: 集め直した layout の直後に、確かめ直しの段の viewport の画像を撮る（確かめ直しの指摘が参照する。後から出た問題が
      // 写る）。画像を撮る設定のときだけ。撮れなくても確かめ直しの結果は変えない。
      if (this.#config.audit.screenshots) {
        await this.#recheckScreenshot(state, rechecked.value.layout);
      }
    }
    const headingKey = ({ level, text }: { readonly level: number; readonly text: string }): string => `${String(level)}:${text}`;
    const headings = recheckStatesOf(firstDom.headings, dom.value.headings, headingKey)
      .map(({ item, state: mark }): RecheckHeadingRecord => Object.freeze({ level: item.level, text: item.text, state: mark }));
    // AUD-2e: `axeRuleIds` は、比べた axe のルール（1 回目か確かめ直しに違反のあったルール。確かめ直しは全部のルールで流す）。
    const axeRuleIds = [...new Set([...firstAxeRuleIds, ...(accessibility?.violations.map(({ ruleId }) => ruleId) ?? [])])];
    return Object.freeze({
      status: 'RECHECKED',
      reason: null,
      startedAt,
      finishedAt: this.#clock().toISOString(),
      settling,
      axeRuleIds: Object.freeze(axeRuleIds),
      accessibility,
      evidenceIds: Object.freeze(evidenceIds),
      layout,
      headings: Object.freeze(headings),
      // EV-3: 同じ条件で待ち直した後の準備の状態（待ちの終わり方と、読み直した DOM の読み込み中の表示。判定は `stateReadyOf` の 1 か所）。
      pageReady: stateReadyOf(settled.value.reason, dom.value.loadingIndicators),
    });
  }

  /**
   * AUD-2d・2e: 確かめ直しの表を作る（Rule の評価の後）。確かめ直しの Evidence（axe と主の layout）を、種類ごとに 1 つずつ Rule に通し（採番器は進めない）、
   * 1 回目の指摘（同じ種類の 1 回目の Evidence を参照するもの）と fingerprint で比べて印を付ける（`recheckStatesOf` の 1 か所）。
   * layout の 1 回目の指摘は、確かめ直せるものだけを比べる: 1 回目の layout の主の形だけを Rule に通して出る fingerprint の指摘（幅の走査の指摘と、
   * 通知の枠の事実の指摘は、確かめ直さないので表に載せない）。確かめ直さなかった（`NOT_RECHECKED`）ら、表は空。
   */
  #recheckRecordOf(
    pending: PendingRecheck,
    stateId: EvidenceStateId,
    url: NormalizedHttpUrlEvidence,
    pageId: PageId,
    profile: ViewportProfile,
    evidence: readonly EvidenceRecord[],
    findings: readonly Finding[],
  ): { readonly record: ViewportRecheckRecord; readonly lateFindings: readonly Finding[] } {
    const recheckedIds = new Set<EvidenceId>(pending.evidenceIds);
    const firstFindings: Finding[] = [];
    const recheckedFindings: Finding[] = [];
    // 1 つの Evidence だけを Rule に通した指摘（その Evidence を参照するもの）。採番器はここでは進めない（`LATE` の指摘だけを、下で採番し直す）。
    const findingsOf = (record: EvidenceRecord): readonly Finding[] => {
      try {
        const engine = this.#createRuleEngine(this.#allocator.nextFindingSequence);
        return engine.evaluate({ pageId, pageUrl: url, viewport: profile, evidence: [record] }).findings
          .filter((finding) => finding.evidenceRefs.includes(record.evidenceId));
      } catch {
        return [];
      }
    };
    for (const recheckedRecord of pending.status === 'RECHECKED' ? evidence.filter(({ evidenceId }) => recheckedIds.has(evidenceId)) : []) {
      const firstRecord = evidence.find((record) => record.type === recheckedRecord.type && !recheckedIds.has(record.evidenceId));
      if (firstRecord === undefined) {
        continue;
      }
      let first = findings.filter((finding) => finding.evidenceRefs.includes(firstRecord.evidenceId));
      if (firstRecord.type === 'layout') {
        // 確かめ直せる 1 回目の layout の指摘（主の形だけから出るもの）。
        const comparable = new Set(findingsOf({ ...firstRecord, payload: { primary: firstRecord.payload.primary, stressSweep: null } })
          .map(({ fingerprint }) => fingerprint));
        first = first.filter(({ fingerprint }) => comparable.has(fingerprint));
      }
      firstFindings.push(...first);
      recheckedFindings.push(...findingsOf(recheckedRecord));
    }
    const states = recheckStatesOf(firstFindings, recheckedFindings, ({ fingerprint }) => fingerprint);
    const marked = states.map(({ item, state: mark }): RecheckFindingRecord => Object.freeze({ fingerprint: item.fingerprint, ruleId: item.ruleId, state: mark }));
    // AUD-2d の直し: 確かめ直しで新しく出た問題（`LATE`）も Finding にする（見落とさないため）。ID は、採番器の今の連番から振り直す。
    const late = states.filter(({ state: mark }) => mark === 'LATE').map(({ item }) => item);
    const firstSequence = this.#allocator.nextFindingSequence;
    const lateFindings: readonly Finding[] = Object.freeze(late.map((finding, index) => Object.freeze({ ...finding, findingId: createFindingId(firstSequence + index) })));
    this.#allocator.advanceFindingSequence(firstSequence + late.length);
    const record: ViewportRecheckRecord = Object.freeze({
      status: pending.status,
      reason: pending.reason,
      stateId,
      startedAt: pending.startedAt,
      finishedAt: pending.finishedAt,
      settling: pending.settling,
      axeRuleIds: pending.axeRuleIds,
      findings: Object.freeze(marked),
      headings: pending.headings,
      ...(pending.pageReady === null ? {} : { pageReady: pending.pageReady }),
    });
    return { record, lateFindings };
  }

  /**
   * AUD-2c: 画像の撮影（viewport の画像と全体の画像を、別の時機に撮る）。各回は段 `screenshot` で、撮った画像の Evidence を残す。
   * - 失敗した回は、その回の書きかけのファイルを消す（消す処理の失敗は、元の失敗を隠さないように無視する）。見放した撮影が後で終わった場合も、Evidence のない
   *   ファイルを残さない。
   * - L1b: 見張りが撮影の途中で段を終えたら、撮り終えた分を、待たずに（ファイルを消さずに）返す。撮り終えなかった画像のファイル（書きかけ）は消す。
   */
  #screenshotCapture(state: CollectionState): {
    readonly capture: (part: 'VIEWPORT' | 'FULL_PAGE', markTargets?: readonly string[]) => Promise<void>;
  } {
    const { pageId, profile, view, record, attempt } = state;
    const paths = screenshotCapturePaths(this.#screenshotRootDirectory, pageId, profile, state.screenshotRetryAttempt, this.#screenshotRevisit);
    // AUD-4: `markTargets` は、直前の主の layout の対象（viewport の画像の状態の印に、対象の矩形を読み直して記録する）。
    const capture = async (part: 'VIEWPORT' | 'FULL_PAGE', markTargets?: readonly string[]): Promise<void> => {
      const outputPath = part === 'VIEWPORT' ? paths.viewportCapture.outputPath : paths.fullPageCapture.outputPath;
      const removeFile = async (): Promise<void> => {
        await rm(outputPath, { force: true }).catch(() => undefined);
      };
      let abandoned = false;
      const screenshots = await attempt('screenshot', async (signals) => {
        try {
          const captured = await view.captureScreenshots(paths, { watch: { progress: signalsOf(signals) }, parts: part, markTargets });
          if (abandoned) {
            await removeFile();
          }
          return captured;
        } catch (error) {
          if (error instanceof ScreenshotWatchEndedError) {
            return error.captured;
          }
          await removeFile();
          throw error;
        }
      }, true, undefined, true);
      if (!screenshots.ok) {
        abandoned = true;
        await removeFile();
        return;
      }
      for (const screenshot of screenshots.value) {
        record('screenshot', withHiddenFrameCount(screenshot, hiddenFrameCountOf(state.notification.overlay)));
      }
      if (screenshots.watchEnded !== undefined && !screenshots.value.some((screenshot) => screenshot.captureType === part)) {
        await removeFile();
      }
    };
    return { capture };
  }

  /**
   * AUD-3d（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-3d）: 幅の走査の幅の layout を読んだ直後に、その幅の viewport の画像を撮る口。
   * - 撮った画像の Evidence は、段 `stress-layout`・Desktop の読み込みの状態 ID で残す（その幅の layout の `capture` と同じ状態）。
   * - 撮れなかった幅は、書きかけのファイルを消し、Evidence を残さない（幅の layout の結果は変えない。例外を投げない）。撮る数に上限は置かない。
   */
  #stressWidthScreenshot(
    stateId: EvidenceStateId,
    sink: StressScreenshotSink,
    /** SWR: 読んだフォーカスの確かめを受ける口（照らし合わせの読み込み直しの幅）。 */
    onFocusChecks?: (checks: FocusCheckEvidence) => void,
  ): (stressView: AuditView, width: number, layout: LayoutEvidence) => Promise<void> {
    return async (stressView, width, layout) => {
      if (sink.screenshots) {
        const startedAt = this.#clock().toISOString();
        const relativeArtifactPath = screenshotRelativePath(
          sink.pageId, 'desktop', 'VIEWPORT', sink.retryAttempt, width, false, null, null, null, this.#screenshotRevisit,
        );
        const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
        try {
          const screenshot = await stressView.captureViewportScreenshot(
            { outputPath, relativeArtifactPath },
            { pageId: sink.pageId, viewport: 'desktop', stressWidth: width, markTargets: markTargetsOf(layout) },
          );
          sink.record('screenshot', withHiddenFrameCount(screenshot, sink.hiddenFrameCountOf(width)), this.#stageCapture(stateId, 'stress-layout', startedAt));
        } catch {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      }
      // EV-2: その幅のセッションを閉じる前に、その幅の重なりと覆いの指摘の対象まで動かして撮る。
      await this.#revealTargets({
        ...sink, view: stressView, targets: sink.screenshots ? revealTargetsOf(layout, false) : [], stateId, viewport: 'desktop', stressWidth: width, phase: 'stress-layout',
      });
      // AUD-4d: その幅の layout と画像の後（次の幅の読み込みの前）に、その幅のフォーカスの確かめを読む（その幅の最後の読み取り）。
      const startedAt = this.#clock().toISOString();
      // AUD-3（REV-AUD3 の後の判断）: 幅の走査の幅では、通常の Tab の確かめはしない（主の読み込みだけ）。
      const checks = await stressView.collectFocusChecks({
        stressWidth: width,
        settleIntervalMs: this.#windows.scroll.stepWaitMs,
        onFocused: this.#focusedScreenshot({ ...sink, view: stressView, stateId, viewport: 'desktop', stressWidth: width }),
      });
      sink.record('focus', checks, this.#stageCapture(stateId, 'focus-check', startedAt));
      onFocusChecks?.(checks);
    };
  }

  /**
   * EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 1 つの layout（主の layout か幅の layout）の、重なりと覆いの指摘の対象
   * （`revealTargetsOf`）まで動かして測り直し、撮る（その page を閉じる前）。撮った画像の Evidence は、段 `phase`・その読み込みの状態 ID で残す
   * （`reveal-<番号>`）。画像を撮らない設定・対象がないときは何もしない。撮れなかった画像は、書きかけのファイルを消す。例外は投げない（後の段の証拠に影響させない）。
   * 動かした後の落ち着きの待ちは、今のスクロールの待ちの値。読み込みは足さない。
   */
  async #revealTargets(target: {
    readonly view: AuditView;
    readonly targets: readonly RevealTargetSpec[];
    readonly pageId: PageId;
    readonly retryAttempt: number | null;
    readonly screenshots: boolean;
    readonly stateId: EvidenceStateId;
    readonly viewport: ViewportProfile;
    readonly stressWidth: number | null;
    readonly phase: PageAuditStage;
    readonly record: StressScreenshotSink['record'];
    readonly track?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
    /** EV-4: 同じ読み込みの中の `reveal-<番号>` の番号（同じ読み込みの横にスクロールする領域の画像と重ねない）。省くと 1 から。 */
    readonly revealCount?: { value: number };
  }): Promise<void> {
    if (!target.screenshots || target.targets.length === 0) {
      return;
    }
    try {
      await target.view.revealAndCapture(target.targets, {
        settleMs: this.#windows.scroll.stepWaitMs,
        track: target.track,
        capture: this.#revealCapture(target, target.revealCount ?? { value: 0 }),
      });
    } catch {
      // 対象まで動かして撮れなかった指摘は、画像の参照の側で保留の理由になる（ここでは段を失敗にしない）。
    }
  }

  /**
   * EV-2: 対象まで動かして測り直した viewport の画像を撮って、Evidence に残す口（段 `phase`・その読み込みの状態 ID。`reveal-<番号>`。番号は `count` で数える）。
   * 撮れなかったら、書きかけのファイルを消して `null`。
   */
  #revealCapture(target: NumberedCaptureTarget, count: { value: number }): RevealCapturePort<EvidenceId> {
    return (reveal) => this.#numberedCapture(target, count, reveal);
  }

  /**
   * FRET: 窓を開くボタンの確かめの、押す前と閉じた後の viewport の画像を撮る口（番号は、同じ読み込みの `reveal-<番号>` と共有して数える。測り直しの記録はない）。
   */
  #dialogFocusCapture(target: NumberedCaptureTarget, count: { value: number }): () => Promise<EvidenceId | null> {
    return () => this.#numberedCapture(target, count, undefined);
  }

  /** EV-2・FRET: `reveal-<番号>` の viewport の画像を撮って、Evidence に残す（撮れなかったら、書きかけのファイルを消して `null`）。 */
  async #numberedCapture(target: NumberedCaptureTarget, count: { value: number }, reveal: RevealCaptureEvidence | undefined): Promise<EvidenceId | null> {
    count.value += 1;
    const startedAt = this.#clock().toISOString();
    const relativeArtifactPath = screenshotRelativePath(
      target.pageId, target.viewport, 'VIEWPORT', target.retryAttempt, target.stressWidth, false, null, null, count.value, this.#screenshotRevisit,
    );
    const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
    try {
      const screenshot = await target.view.captureViewportScreenshot(
        { outputPath, relativeArtifactPath },
        { pageId: target.pageId, viewport: target.viewport, stressWidth: target.stressWidth, ...(reveal === undefined ? {} : { reveal }) },
      );
      return target.record('screenshot', screenshot, this.#stageCapture(target.stateId, target.phase, startedAt)).evidenceId;
    } catch {
      await rm(outputPath, { force: true }).catch(() => undefined);
      return null;
    }
  }

  /** AUD-3d・4d: 段の集めた状態と時刻（ビューポートの読み込みの状態 ID、段、始めた時刻から今まで。URL と位置は読まない）。 */
  #stageCapture(stateId: EvidenceStateId, phase: PageAuditStage, startedAt: string): EvidenceCapture {
    return Object.freeze({ stateId, phase, startedAt, finishedAt: this.#clock().toISOString(), url: null, scrollPosition: null });
  }

  /**
   * AUD-4d: フォーカスの確かめの口（フォーカスを当てたままの間に呼ばれる）。フォーカスしても隠れたままの要素（`focusCheckOutcomeOf` の判定。Rule と同じ 1 か所）
   * だけ、フォーカスを当てたままの viewport の画像を撮り、Evidence に残して ID を返す（段 `focus-check`）。正しく現れる要素・画像を撮らない設定・撮れなかったときは
   * `null`（書きかけのファイルは消す）。
   */
  #focusedScreenshot(target: {
    readonly view: AuditView;
    readonly pageId: PageId;
    readonly retryAttempt: number | null;
    readonly screenshots: boolean;
    readonly stateId: EvidenceStateId;
    readonly viewport: ViewportProfile;
    readonly stressWidth: number | null;
    readonly record: StressScreenshotSink['record'];
    /** COV-4 の区切り 3: 開いた状態のフォーカスの確かめなら、その状態の番号（画像は `state-<番号>/focus-<番号>`）。 */
    readonly openedStateIndex?: number | null;
  }): NonNullable<FocusCheckOptions['onFocused']> {
    return async (item, viewport, index) => {
      if (!target.screenshots || !isHiddenFocusCheckOutcome(focusCheckOutcomeOf(item, viewport))) {
        return null;
      }
      const startedAt = this.#clock().toISOString();
      const relativeArtifactPath = screenshotRelativePath(
        target.pageId, target.viewport, 'VIEWPORT', target.retryAttempt, target.stressWidth, false, index, target.openedStateIndex ?? null, null,
        this.#screenshotRevisit,
      );
      const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
      try {
        // EV-2: 先頭へ戻さずに、フォーカスの後の位置のまま（フォーカスは当てたまま）、対象を測り直して撮る。
        const scroll = item.scroll ?? { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 0 } }, ancestors: [] };
        const captured = await target.view.captureAsIs({ purpose: 'FOCUS', selectors: [item.selector] }, scroll, async (reveal) => {
          const screenshot = await target.view.captureViewportScreenshot(
            { outputPath, relativeArtifactPath },
            { pageId: target.pageId, viewport: target.viewport, stressWidth: target.stressWidth, reveal },
          );
          return target.record('screenshot', screenshot, this.#stageCapture(target.stateId, 'focus-check', startedAt)).evidenceId;
        });
        if (captured === null) {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
        return captured;
      } catch {
        await rm(outputPath, { force: true }).catch(() => undefined);
        return null;
      }
    };
  }

  /**
   * AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 4）: 通常の Tab の確かめ。直の focus で隠れたままの項目（`focusCheckOutcomeOf`
   * の判定。Rule と同じ 1 か所）がある記録だけ、その項目を候補にして確かめる（候補がなければ Tab を押さない）。確かめられなければ、記録を変えずに返す。
   * REV-AUD3 の後の判断: 主の読み込み（ビューポートごと）だけで呼ぶ。期限は、この段の見張り（`signals`）。
   */
  async #sequentialTab(view: AuditView, checks: FocusCheckEvidence, signals: ProgressSignals): Promise<FocusCheckEvidence> {
    const viewport = { width: checks.viewportWidth, height: checks.viewportHeight };
    const candidates = checks.items.flatMap((item, index) => (isHiddenFocusCheckOutcome(focusCheckOutcomeOf(item, viewport)) ? [index] : []));
    // AUDR2: 走らなかった・確かめられなかった理由を、記録に残す。
    if (candidates.length === 0) {
      return Object.freeze({ ...checks, sequentialTabOutcome: 'NO_CANDIDATES' });
    }
    return view.checkSequentialTab(checks, {
      candidates, settleIntervalMs: this.#windows.scroll.stepWaitMs, track: (work) => signals.track(work), signal: signals.signal,
    }).catch(() => Object.freeze({ ...checks, sequentialTabOutcome: 'READ_FAILED' as const }));
  }

  /**
   * AUD-3d の続き: 落ち着いた後の確かめ直しの段の viewport の画像を撮り、Evidence に残す（段 `recheck`。直前に集め直した layout と同じ状態と時刻の範囲）。
   * 撮れなければ、書きかけのファイルを消し、Evidence を残さない（例外を投げない）。
   */
  async #recheckScreenshot(state: RecheckTarget, layout: LayoutEvidence | null): Promise<void> {
    const { view, pageId, profile, attempt } = state;
    // COV-4 の区切り 3: 開いた状態の確かめ直しの画像は、その状態の `state-<番号>/recheck/viewport.png`。
    const relativeArtifactPath = screenshotRelativePath(
      pageId, profile, 'VIEWPORT', state.screenshotRetryAttempt, null, true, null, state.openedStateIndex ?? null, null, this.#screenshotRevisit,
    );
    const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
    const shot = await attempt('recheck', async () => {
      return view.captureViewportScreenshot({ outputPath, relativeArtifactPath }, { pageId, viewport: profile, stressWidth: null, markTargets: markTargetsOf(layout) });
    });
    if (!shot.ok) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      return;
    }
    state.record('screenshot', shot.value);
  }

  /**
   * 設計書 4.5.2 の 5。設定で無効な段階は実行しない（4.5.5）。L1: collector に期限を渡さない（ページの期限と余裕は撤廃した）。期限の数を必ず受け取る
   * collector（performance）には、切らない値を渡す。collector の中に残る期限は L2 で扱う。
   */
  async #collect(state: CollectionState): Promise<void> {
    const { pageId, profile, view, viewportSize, reasons, record, attempt } = state;
    const config = this.#config;

    const dom = await attempt('dom', () => view.collectDomEvidence(pageId));
    if (dom.ok) {
      // DUP（REV-DUP の M-4）: 欄の表示の値の digest は記録に残さない（中身の要約にだけ使う）。
      record('dom', recordedDomEvidenceOf(dom.value));
    }
    // DUP: 同じ作りの画面の口があれば、Desktop の DOM の後に、作りの鍵を作る（候補の形を読む。読み込みは足さない）。
    const sameness = profile === 'desktop' ? this.#pageSameness : undefined;
    let templateKey: string | null = null;
    if (sameness !== undefined && dom.ok) {
      const found = await attempt('interaction-discovery', () => view.discoverInteractionCandidates(undefined, this.#openEndedAtMs()));
      templateKey = found.ok ? auditPageTemplateKeyOf(dom.value, state.url, found.value.candidates) : null;
      this.#pageTemplateKey = templateKey;
    }

    // AUD-4: layout の状態の印に、今の記録の隠した通知の枠の数を足す（状態の画像も同じ数を足す）。
    const primary = await attempt('layout', async () =>
      layoutResultWithHiddenFrameCount(await view.collectLayoutEvidence(viewportSize), hiddenFrameCountOf(state.notification.overlay)));
    // AUD-2a: 主の形を測った段の、集めた状態と時刻（次の段で上書きされる前に控える）。
    const primaryCapture = state.currentCapture();
    // DUP: Desktop の layout の後に、ページの点検の深さを決めて、口に知らせる（Mobile は、決めた深さに従う）。
    if (sameness !== undefined) {
      const contentDigest = dom.ok && primary.ok ? auditPageContentDigestOf(dom.value, primary.value.layout) : null;
      const decision = pageAuditDepthOf({ templateKey, contentDigest, referenceOf: sameness.referenceOf, sameContentAs: sameness.sameContentAs });
      this.#pageDecision = decision;
      sameness.decided(Object.freeze({ ...decision, pageId, templateKey, contentDigest }));
    }
    const depthStages = pageAuditStagesOf(this.#pageDecision.depth, profile);
    if (primary.ok) {
      if (primary.value.status === 'PARTIAL') {
        reasons.push(collectorIncompleteReason('layout', primary.value.reason));
      }
      // 幅の走査は Desktop で1回だけ行い、Mobile の `stressSweep` は null にする（設計書 4.5.6）。
      // DEF-191（設計書 `2026-11-04-beaksight-login-session-design.md` 3.1）: Desktop の幅の走査は、この Context を閉じた後に回す（`#sweepStressWidths`。
      // サービスの Origin へ送れる Context を同時に 1 つにする）。ここでは、主の形を控えるだけで、layout の Evidence は走査の後に記録する（L1: 走査に残す
      // 時間の控えは撤廃した）。
      if (profile === 'desktop') {
        // L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14、網羅の設計書 3.3）: 幅の走査に、この page の CSS の media query の境目の
        // 両側の幅を足す。境目は、Context を閉じる前のこの page から読む（読むだけ。読めなければ設定の幅だけ）。
        // DUP: 幅の走査をしない深さでは、境目を読まない（主の形は、走査をしないまま Context を閉じた後に記録する）。
        const breakpoints = depthStages.stressSweep
          ? await attempt('layout', async () => breakpointSideWidthsOf(await view.readMediaQueryConditionTexts()))
          : null;
        state.deferredStressSweep.value = {
          primary: primary.value,
          primaryCapture,
          stateId: state.stateId,
          breakpointWidths: breakpoints?.ok === true ? breakpoints.value : [],
          sweep: depthStages.stressSweep,
        };
      } else {
        record('layout', layoutPayloadOf(primary.value, null, state.notification), primaryCapture);
      }
    }

    // AUD-2c（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2c）: viewport の画像は、DOM・layout の直後（axe の前）に撮る（DOM・layout と
    // 同じ状態の見た目を残す）。全体の画像は、今の位置（performance の後）のまま撮る。
    // DUP: layout の後の画像・reveal・確かめ直し、axe、性能、Interaction、フォーカスの確かめは、深さの段の表（`depthStages`）にもよる。
    const screenshots = config.audit.screenshots && depthStages.afterLayout ? this.#screenshotCapture(state) : null;
    await screenshots?.capture('VIEWPORT', markTargetsOf(primary.ok ? primary.value.layout : null));

    // REC-1: 色（color）の Evidence は集めない（Rule・表示・報告で読む所がない。コントラストは axe が見る）。

    // L1b（見張りは 1 つだけ）: accessibility・performance・screenshot の collector には期限を渡さず、この段の見張りの口（`watch.progress`）を渡す。
    // collector は自分では見張らず、その口に進みの印を付け、口の abort で途中の記録を返す。見張りが段を終えたら、その記録を Evidence に残し、理由は
    // 見張りの 1 つだけにする（collector の PARTIAL の理由を重ねない）。
    // AUD-2d・2e: 1 回目の axe の結果（確かめ直しで、1 回目と同じ設定の axe を流し直すか決め、比べたルールを記録するため）。
    let firstAccessibility: EvidencePayloadByType['accessibility'] | null = null;
    if (config.audit.accessibility && depthStages.accessibility) {
      const accessibility = await attempt('accessibility', (signals) =>
        view.collectAccessibilityEvidence({ watch: { progress: signalsOf(signals) } }), true, undefined, true);
      if (accessibility.ok) {
        firstAccessibility = accessibility.value;
        record('accessibility', accessibility.value);
        if (accessibility.value.status === 'PARTIAL' && accessibility.watchEnded === undefined) {
          reasons.push(collectorIncompleteReason('accessibility', accessibility.value.reason));
        }
      }
    }

    if (config.audit.performance && state.performanceInstalled && depthStages.performance) {
      const network = state.network;
      const performance = await attempt('performance', async (signals) => {
        const watch = { progress: signalsOf(signals) };
        // AUD-6c: 測る前に BeakSight がページにした操作（scroll の段と、通知の枠の閉じるボタンの押下）を、性能の記録に残す。
        const operationsBeforeMeasurement = { scrolled: state.scrolled, notificationFramePressed: (state.notification.overlay?.pressCount ?? 0) > 0 };
        // EV-1: scroll の段の前に読んだ LCP を、判定に使う値として渡す。
        return view.collectPerformance(await network.snapshot({ watch }), { watch, operationsBeforeMeasurement, lcpBeforeScroll: state.lcpBeforeScroll });
      }, true, undefined, true);
      if (performance.ok) {
        record('performance', performance.value);
        if (performance.value.status === 'PARTIAL' && performance.watchEnded === undefined) {
          reasons.push(collectorIncompleteReason('performance', performance.value.reason));
        }
      }
    }

    // AUD-2c: 全体の画像は、今の位置（performance の後）のまま撮る（viewport の画像は DOM・layout の直後に撮った）。
    await screenshots?.capture('FULL_PAGE');

    // EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 主の layout の重なりと覆いの指摘の対象まで動かして測り直し、撮る（撮った後に
    // 元の位置へ戻す。読み込みは足さない）。段は画像の段 `screenshot`。EV-4: 見切れの指摘の対象も撮る。
    const primaryRevealTargets = primary.ok && config.audit.screenshots && depthStages.afterLayout ? revealTargetsOf(primary.value.layout, true) : [];
    const revealCount = { value: 0 };
    if (primaryRevealTargets.length > 0) {
      await attempt('screenshot', (signals) => this.#revealTargets({
        view,
        targets: primaryRevealTargets,
        pageId,
        retryAttempt: state.screenshotRetryAttempt,
        screenshots: config.audit.screenshots,
        stateId: state.stateId,
        viewport: profile,
        stressWidth: null,
        phase: 'screenshot',
        record: (type, payload, capture) => record(type, payload, capture),
        track: (work) => signalsOf(signals).track(work),
        revealCount,
      }));
    }

    // AUD-2d（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2d）: 画像の後に、落ち着いた後の確かめ直しをする（読み込み直さない）。
    // AUD-2e: 主の layout を集めたら、確かめ直しで主の layout も集め直す。
    state.recheck.value = depthStages.afterLayout
      ? await this.#recheckAfterSettled(state, dom.ok ? dom.value : null, firstAccessibility, primary.ok)
      : null;

    // Link は、ビューポートごとに 1 回だけ抽出する（ARCH03、設計書 4.4）。L5 の N5（INV-LIMITS の表 A）: Mobile のビューポートでも抽出し、Mobile にだけある
    // 導線の出た先も、巡回の辺にする（Desktop だけの決まりはやめた）。
    const links = await attempt('links', () => view.discoverLinks(pageId, {
      allowedOrigins: new Set(config.site.allowedOrigins),
      allowedQueryParameters: state.allowedQueryParameters,
    }));
    if (links.ok) {
      record('link', links.value);
    }

    // Interaction は、Link の抽出の後、Safety の Evidence と Rule の評価の前に、Desktop だけで行う（設計書 4.5.2）。
    // L5 の N5: Mobile でも行う（Mobile では、Desktop の同じページになかった候補だけ。`mobileOnlyInteractionCandidates`）。
    if (config.audit.interactions && depthStages.interactions) {
      await this.#auditInteractions(state);
    }
    if (!depthStages.focusCheck) {
      return;
    }

    // AUD-4d（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: そのビューポートの最後に、画面の外の、フォーカスできる要素のフォーカスの
    // 確かめを読む（ほかの証拠を集め終えた後。フォーカスでページの JS が状態を変えても、後の証拠を汚さないため。設計者の判断 2026-11-10）。段は `focus-check`。
    const focusStartedAt = this.#clock().toISOString();
    const checks = await attempt('focus-check', (signals) => view.collectFocusChecks({
      stressWidth: null,
      settleIntervalMs: this.#windows.scroll.stepWaitMs,
      track: (work) => signalsOf(signals).track(work),
      // REV-AUD3 の M-4: 位置の落ち着きの待ちは、この段の期限で終える。
      signal: signalsOf(signals).signal,
      onFocused: this.#focusedScreenshot({
        view,
        pageId,
        retryAttempt: state.screenshotRetryAttempt,
        screenshots: config.audit.screenshots,
        stateId: state.stateId,
        viewport: profile,
        stressWidth: null,
        record: (type, payload, capture) => record(type, payload, capture),
      }),
      // REV-AUD3 の 2 回目の I-A: 見張りが段を終えたら、collector は途中の記録（落ち着かなかった項目を含む）を同じ回りのうちに返す。その記録を残す。
    }), true, undefined, true);
    // EV-4（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: axe の `scrollable-region-focusable` の要素ごとに、領域まで動かして撮り、Tab で
    // 届くか・矢印のキーで動くかを試す（フォーカスの確かめの後。値は変えず、位置とフォーカスを元へ戻す）。結果は、このフォーカスの確かめの記録に足す。
    const regionTargets = scrollableRegionTargetsOf(firstAccessibility);
    const regions = regionTargets.length === 0 ? null : await attempt('focus-check', (signals) => view.checkScrollableRegions(regionTargets, {
      settleMs: this.#windows.scroll.stepWaitMs,
      track: (work) => signalsOf(signals).track(work),
      capture: config.audit.screenshots
        ? this.#revealCapture({
          view, pageId, retryAttempt: state.screenshotRetryAttempt, stateId: state.stateId, viewport: profile, stressWidth: null, phase: 'focus-check',
          record: (type, payload, capture) => record(type, payload, capture),
        }, revealCount)
        : undefined,
    }));
    // AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 4）: ほかの証拠を集め終えた後に、直の focus で隠れたままの項目がある画面
    // だけ、文書の先頭からの通常の Tab の確かめをする（元のフォーカスと位置に戻す）。結果は、このフォーカスの確かめの記録の項目に足す。
    if (checks.ok) {
      // REV-AUD3 の 3 回目の M-1: 直の focus の確かめが見張りで終わった（落ち着かなかった）ビューポートでは、Tab の確かめを始めない（反応なしの待ちを
      // 重ねず、直の focus の戻す処理と重ならない）。
      const directEnded = checks.watchEnded !== undefined || checks.value.items.some((item) => item.unsettled === true);
      const tabbed = directEnded
        ? { ok: false as const }
        : await attempt('focus-check', (signals) => this.#sequentialTab(view, checks.value, signalsOf(signals)));
      // AUDR2: 走らなかった（見張りで終わった）・Tab の確かめの段が見張りで終わった（期限）ことを、記録に残す。
      const focus: FocusCheckEvidence = tabbed.ok
        ? tabbed.value
        : Object.freeze({ ...checks.value, sequentialTabOutcome: directEnded ? 'WATCH_ENDED' : 'DEADLINE' });
      // FRET（設計書 `2026-11-24-beaksight-dialog-focus-return-design.md` 1.2）: そのビューポートの点検の最後に、窓を開くボタンを押して、窓を閉じた後のフォーカスの
      // 戻り先を確かめる（窓を開けた状態が、ほかの証拠に混ざらないため）。同じ物は Run で 1 回。結果は、このフォーカスの確かめの記録に足す。
      const dialog = await attempt('focus-check', (signals) => view.checkDialogFocus({
        keyScope: profile,
        accept: (keyDigest) => {
          if (this.#dialogFocusPressed.has(keyDigest)) return false;
          this.#dialogFocusPressed.add(keyDigest);
          return true;
        },
        settleIntervalMs: this.#windows.scroll.stepWaitMs,
        track: (work) => signalsOf(signals).track(work),
        signal: signalsOf(signals).signal,
        capture: config.audit.screenshots ? this.#dialogFocusCapture({
          view, pageId, retryAttempt: state.screenshotRetryAttempt, stateId: state.stateId, viewport: profile, stressWidth: null, phase: 'focus-check',
          record: (type, payload, capture) => record(type, payload, capture),
        }, revealCount) : undefined,
      }));
      const withRegions = regions?.ok === true ? Object.freeze({ ...focus, scrollableRegions: regions.value }) : focus;
      const payload = dialog.ok ? Object.freeze({ ...withRegions, dialogFocus: dialog.value }) : withRegions;
      record('focus', payload, this.#stageCapture(state.stateId, 'focus-check', focusStartedAt));
    }
  }

  /**
   * DEF-191（設計書 `2026-11-04-beaksight-login-session-design.md` 3.1 の 1）: Desktop の幅の走査（設計書 4.5.6）。Desktop の Context（D）を閉じた後に呼ぶ
   * （D と幅の走査の Context が同時に生きない。サービスの Origin へ送れる Context は同時に 1 つ）。幅ごとの Context は順に開け閉めし、作るときに、最後に閉じた
   * Context の状態を受け継ぐ（factory の決め方）。L1: 走査の期限（控えた残りの時間）は撤廃した。幅のセッションの作成の期限の上限は Run の時間の上限、collector に
   * 渡す期限は切らない値（`openEndedStageDeadline`）。各幅の落ち着きの待ちと通知の枠の扱いは、その幅の page を進みの見張りで包む（`#watchOnPage`）。
   * 段階の実行は `runner`（D の page の crash とは競わせない。見放さずに終わりを待つ）。幅の走査の結果を返す（段階が終わらなければ `null`）。
   * 違反・サイトの不調・セッションの切れの確かめ、幅の Ledger と読み込みの一覧の記録は、前の順のときと同じ。
   * SWR（設計者の判断 2026-11-17。案 B）: 幅が 2 つ以上なら、REVISIT の Context を 1 つだけ作り、一番広い幅で 1 回だけ読み込み、広い順に viewport の大きさだけを
   * 変えて測る（一番狭い幅は、照らし合わせのために測るだけで、証拠を残さない）。その後に一番狭い幅を新しい REVISIT の Context で読み込み直して測り（今の幅ごと
   * の読み込みと同じ）、その幅の事実（`sameStressLayoutFacts`）が大きさを変えて測ったものと違えば、大きさを変えて集めた幅の証拠を捨てて、残りの幅を今どおり
   * 幅ごとに読み込み直す。大きさを変えて回す途中で幅が終わった（失敗・page を閉じた・見張りが静まらない幅を終えた）ときも、全部の幅を幅ごとに読み込み直す。
   * 1 画面の幅の走査の読み込みは、ふだん 2 回、違いが出た画面は幅の数 + 1 回まで。違反・不調・セッションの切れの確かめは、大きさを変える前にも行う。
   */
  async #sweepStressWidths(
    url: NormalizedHttpUrlEvidence,
    pending: DeferredStressSweep,
    runner: StageRunner,
    state: Pick<CollectionState, 'reasons' | 'safety' | 'siteUnavailability' | 'authSessionLoss' | 'sessionLossLoads' | 'notification'> & {
      /** AUD-3d・4d: 幅の画像とフォーカスの確かめを残す口。 */
      readonly stressScreenshots: StressScreenshotSink;
      /** fix round 3・SWR の 4: 押す期間に移動かポップアップを止めた幅（ここで足し、捨てた幅は除く）。 */
      readonly pressBlockedWidths: Set<number>;
    },
  ): Promise<EvidencePayloadByType['layout']['stressSweep']> {
    const { reasons, safety, siteUnavailability } = state;
    const config = this.#config;
    // 違反を検出した後は、幅の走査の次の幅を始めない（Task 19 の前の整理の設計書 4.5）。各幅の読み込みの間隔の待ちの前（DEF-209。セッションを作る前）に
    // 確かめ、違反があれば待たず、作らずに段階を止める（理由は `stress-layout:SAFETY_VIOLATION_ABORT`）。始めた幅のセッションの Ledger は、今までどおり残る。
    // 幅の走査のセッションの作成と終了も、期限付きで待つ（DEF-008）。作成の期限の上限は、走査の期限を、それまでに走査の中で待った時間の分だけ延ばしたもの
    // である（幅の走査が自分の期限を延ばすのと同じ量）。上限は幅ごとに変わるので、幅ごとにセッションの factory を作る。期限の注入（R15r-4）も、そのまま渡す。
    // 作ったセッションの Ledger は、作成の途中で失敗した場合も含めて、作った順に残す。
    // サイトの不調を検知した後も、次の幅を始めない（サイトが応答しないときに Run を止める設計書 3.1。理由は `stress-layout:SITE_UNAVAILABLE`）。
    // 読み込み中の幅の値（通知の枠の記録に付ける）。幅ごとの見張り（`watchWidth`）が、その幅の段を始めるときに入れる（SWR: 大きさを変えて回す幅も、
    // 読み込み直す幅も、幅の段は 1 つずつ直列に行う）。
    let loadingStressWidth: number | null = null;
    // T25c: 読み込み中の幅のセッションの page と、DEF-138 の経路の記録（認証つきの Run だけ）。読み込みの後に、セッションの切れを確かめるため。
    // DF-3: 読み込んだ幅は、このビューポートの読み込みの一覧（`state.sessionLossLoads`）にも加え、後の時機にも確かめ直す。
    let loadingStressLoad: SessionLossLoad | null = null;
    // DEF-247: 読み込み中の幅の session を閉じる口（1 回だけ閉じる。`stressWidthSessionCloser`）。
    let loadingStressClose: (() => Promise<void>) | null = null;
    // L1: 今の幅の進みの見張りの口（幅ごとに `#watchStressWidth` が作る）。
    let widthSignals: ProgressSignals | null = null;
    /** L1: 今の幅の読み込みが終わったか（`afterNavigation` を受けたか）。 */
    let widthNavigated = false;
    // DEF-209: 次の幅を始めないかの確かめは、その幅の読み込みの間隔の待ち（`beforeNavigation`）の前に行う（待ちを移す前と同じく、始めない幅では待たない。
    // 待ちの数を変えない）。当たれば、待たずに投げる（collector は、待ちの失敗をセッションの作成の失敗と同じく例外で返す）。
    // SWR: 大きさを変える幅の前も、同じ確かめで次の幅を始めない（読み込まないので、間隔は待たない）。
    const abortIfNextWidthMustNotStart = (): void => {
      // 順は `stressWidthAbortOf`（違反 → 不調 → セッションの切れ）。DF-3（DEF-167）: 幅の走査の前と、各幅の前に、それまでに読み込んだ page（Passive と前の幅）を
      // 確かめ直す。当たれば、この幅を始めない。
      switch (stressWidthAbortOf({
        violationRecorded: this.#safetyViolationRecorded,
        siteUnavailable: siteUnavailability.detected !== null,
        sessionLost: () => state.authSessionLoss.stage !== null || this.#detectSessionLoss(
          SESSION_LOSS_CHECK_POINTS.beforeNextLoad,
          state.sessionLossLoads,
          state.authSessionLoss,
          reasons,
        ) !== null,
      })) {
        case 'SAFETY_VIOLATION_ABORT':
          throw new SafetyViolationAbortError();
        case 'SITE_UNAVAILABLE':
          throw new SiteUnavailableAbortError();
        case 'AUTH_SESSION_LOST':
          throw new AuthSessionLostAbortError();
        case null:
          return;
      }
    };
    const beforeStressNavigation = async (): Promise<number> => {
      abortIfNextWidthMustNotStart();
      // DBG-1: 幅の走査の読み込みの間隔の待ちを測る（切なら何もしない）。
      return await this.#debugTiming.measure('PACING_WAIT', () => ({ pageId: state.stressScreenshots.pageId, part: 'stress-layout' }), () => this.#pacer.beforeNavigation());
    };
    // SWR の 3: 大きさを変えて回す Context は、Ledger 1 つに走査した幅の一覧（`sweptWidths`。走査の順に足す）を付ける。読み込み直す幅は `null`（今どおり幅ごと）。
    const createSessionFor = (sweptWidths: number[] | null) => async (viewport: Viewport): Promise<AuditStressSession> => {
      loadingStressWidth = viewport.width;
      loadingStressLoad = null;
      loadingStressClose = null;
      // 幅の走査の Context は、ページの読み込み直しなので、役割は `REVISIT` である（負荷の制御の設計書 4.7）。
      // DEF-209: セッションは、その幅の待ちの後に作るので、作成の期限の上限（`notAfterMs`）は、その幅の待ちも含めて延ばしたもの（collector がその幅の
      // 読み込みに使う期限と同じ量）になる。
      const sessions = this.#ports.stressSessions({
        deadlines: this.#deadlines,
        notAfterMs: this.#runDeadlineOrUndefined(),
        role: 'REVISIT',
      });
      try {
        const session = await sessions.createSession(viewport);
        const shownView = session.view;
        // L1: その幅の page の自発の変化の印を、その幅の見張りに付ける（その幅のセッションを閉じると、page の事象も止まる）。
        if (widthSignals !== null) {
          shownView.attachProgressSignals(widthSignals);
        }
        // DEF-138: 読み込みの前に、経路の記録を付ける（認証つきの Run だけ）。
        loadingStressLoad = {
          stage: STRESS_LAYOUT_STAGE,
          view: shownView,
          route: this.#sessionLostPathPrefix === null ? null : shownView.observeSessionLossNavigation(),
        };
        state.sessionLossLoads.push(loadingStressLoad);
        // DEF-236（設計書 3.1 の 5）: その幅の証拠を集め終えた後、閉じる前に、その幅の画面を見せたまま読み込みの間隔を待つ（幅の走査の後には、次の幅か Mobile が
        // 続く。始めない条件のときは待たない）。待つ間も、その幅の見張りに中身の進みの印を付ける（BeakSight 自身の間隔は「反応なし」に数えない）。
        // DEF-247: その幅の session を閉じる口（factory が持ち主として Context ごと閉じる）を、1 回だけ閉じる形にする。幅を早く終える所（外部スキームの記録・
        // 見張りが終えた幅）と、collector の後片付けの両方が使う（page だけを閉じると、Guard が印のない session の切れを違反にする）。
        const closeSession = stressWidthSessionCloser(() => session.close());
        loadingStressClose = closeSession;
        return Object.freeze({
          view: shownView,
          close: async (): Promise<void> => {
            if (!shownView.isClosed() && this.#nextLoadMayStart(siteUnavailability, state.authSessionLoss)) {
              await this.#waitWithPageShown(shownView, safety, widthSignals);
            }
            await closeSession();
          },
        });
      } finally {
        // BN-a: 幅のセッションの Ledger を、その幅と組にして残す（safety の Evidence の読み込みの印）。SWR の 3: 大きさを変えて回す Context は、走査した幅の一覧も。
        safety.stressLedgers.push(...sessions.ledgers().map((ledger) => (sweptWidths === null
          ? { ledger, width: viewport.width }
          : { ledger, width: viewport.width, widths: sweptWidths })));
      }
    };
    // 走査は、自分で期限を守る（見放さない）。各幅の読み込みの前には、ページの読み込みの間隔を守る（負荷の制御の設計書 4.1）。
    // セッションを閉じる処理の期限切れは、`stress-layout:CLOSE_DEADLINE_EXCEEDED` として記録する（RP18r の Minor-2）。幅のセッションの中で違反が起き、
    // Guard がその Context を閉じた場合も、違反で止まったことが分かる `stress-layout:SAFETY_VIOLATION_ABORT` にする（C18i、RC18b の N2）。
    // そのほかの失敗は、前の順（D の page が生きていた）と同じ `EVALUATION_FAILED`（D の page は閉じたので、page の状態からは決めない）。
    // 各幅の読み込みの観測は、受け口で受け取り、サイトの不調を判定して記録する（設計書 2.1、3.1）。
    // L1: 幅ごとに、その幅の読み込み・落ち着き・測りを進みの見張りで包む（幅の page の通信・画面の変化と、幅の区切りの印を、どれも中身の進みに数える。
    // 幅の走査の期限は撤廃した）。見張りが幅を終えたら、理由を残し、止まった幅の page を閉じて、その幅を collector に失敗として返させる（それまでの幅の
    // 記録を残す）。応答しない・Run の時間の上限なら、残りの幅は始めない。静まらないなら、次の幅へ進む。
    // AUD-2b・2d の指示書の 3: 各幅の結果に、その幅を集めた状態と時刻を付ける（状態 ID は Desktop の読み込みのもの。位置は読まない）。
    const withCapture = (results: StressSweepResults, startedAt: string): StressSweepResults => {
      const capture: EvidenceCapture = Object.freeze({
        stateId: pending.stateId,
        phase: 'stress-layout',
        startedAt,
        finishedAt: this.#clock().toISOString(),
        url: null,
        scrollPosition: null,
      });
      // AUD-4: 幅の layout の状態の印に、その幅の今の記録の隠した通知の枠の数を足す（その幅の画像も同じ数を足す）。
      return Object.freeze(results.map((result) => Object.freeze({
        ...layoutResultWithHiddenFrameCount(result, state.stressScreenshots.hiddenFrameCountOf(result.width)),
        capture,
      })));
    };
    /**
     * 1 つの幅の段を見張る（`run` が、その幅を読み込むか大きさを変えて測る）。`hardStop` は、応答しない・Run の時間の上限で、残りの幅を始めないこと。
     * SWR: 大きさを変えた幅（`resized`）は、読み込み済みの page を続けて使う（読み込みは終わっている。その幅の見張りに page の印を付け直す）。押す期間の移動は、
     * その幅の間に増えた数で決める（SWR の 4）。
     */
    // DBG-1: 幅の走査の幅ごとの時間を測る（切なら何もしない）。
    const watchWidth = (
      width: number,
      resized: boolean,
      run: () => Promise<StressSweepResults>,
    ): Promise<{ readonly results: StressSweepResults; readonly hardStop: boolean }> => this.#debugTiming.measure(
      'AUDIT_STRESS_WIDTH', () => ({ pageId: state.stressScreenshots.pageId, counts: { width } }), () => watchOneWidth(width, resized, run));
    const watchOneWidth = async (
      width: number,
      resized: boolean,
      run: () => Promise<StressSweepResults>,
    ): Promise<{ readonly results: StressSweepResults; readonly hardStop: boolean }> => {
      let running: Promise<StressSweepResults> | undefined;
      widthNavigated = resized;
      loadingStressWidth = width;
      const widthStartedAt = this.#clock().toISOString();
      if (!resized) {
        loadingStressClose = null;
      }
      const loadBefore = resized ? loadingStressLoad as SessionLossLoad | null : null;
      const pressesBefore = loadBefore?.view.pressNavigations() ?? 0;
      // C（DEF-245 の続き。発見の側の `documentGoneOf` と同じ考え方）: その幅の page が外部スキームへ移ろうとした記録が入るか、読み込んだ後に文書が消えたら
      // （誤りの画面に替わった・閉じた）、その幅の page を閉じて終える（collector は、その幅を失敗として返す）。Playwright の 1 手には期限を付けず、事実を
      // 確かめの間隔ごとに見る。
      let widthDocumentEnded = false;
      const widthDocumentWatch = setInterval(() => {
        const load = loadingStressLoad;
        if (widthDocumentEnded || load === null) {
          return;
        }
        // REV-SD の I-1: 読み込んだ後に範囲の外へ移った幅の page も、使うのをやめる。
        if (load.view.documentLeftCause(widthNavigated) !== null || (widthNavigated && !this.#inAuditScope(load.view, url))) {
          widthDocumentEnded = true;
          // DEF-247: page だけを閉じず、その幅の session の口で Context ごと閉じる（collector の後片付けと共有する 1 回の閉じ）。
          void loadingStressClose?.().catch(() => undefined);
        }
      }, this.#windows.pageSettle.pollIntervalMs);
      const attached: { detach: (() => void) | null } = { detach: null };
      let watched: WatchedOutcome<StressSweepResults>;
      try {
        watched = await watchProgress((signals) => {
          widthSignals = signals;
          if (loadBefore !== null) {
            attached.detach = loadBefore.view.attachProgressSignals(signals);
          }
          running = run();
          return running;
        }, this.#watchOptions(PROGRESS_SIGNAL_KINDS));
      } finally {
        clearInterval(widthDocumentWatch);
        attached.detach?.();
      }
      widthSignals = null;
      if (watched.status === 'REJECTED') {
        throw watched.reason;
      }
      const notePresses = (): void => {
        const load = loadingStressLoad as SessionLossLoad | null;
        if ((load?.view.pressNavigations() ?? 0) > (load === loadBefore ? pressesBefore : 0)) {
          state.pressBlockedWidths.add(width);
        }
      };
      if (watched.status === 'FULFILLED') {
        notePresses();
        return { results: withCapture(watched.value, widthStartedAt), hardStop: false };
      }
      reasons.push(progressWatchEndReason('stress-layout', watched.end));
      // 読み込みの最中なら、読み込みは部品の中の期限（Playwright の既定。L2 の範囲）で終わり、時間切れの観測でサイトの不調を今までどおり判定するので、
      // 閉じない。読み込みの後（落ち着き・測り）で止まったなら、その幅の page を閉じて終わらせる。
      // DEF-247: page だけを閉じず、その幅の session の口で Context ごと閉じる（collector の後片付けと共有する 1 回の閉じ）。
      // 閉じる口は、collector が作った幅の session で決まる（この関数の外の受け口で入れるので、型の絞り込みを外す）。
      const closeStalled = loadingStressClose as (() => Promise<void>) | null;
      if (widthNavigated) {
        await closeStalled?.().catch(() => undefined);
      }
      const results = running === undefined ? Object.freeze([]) : withCapture(await running, widthStartedAt);
      notePresses();
      return { results, hardStop: watched.end !== 'STAGE_NEVER_QUIET' };
    };
    const stressOptions: AuditStressLayoutOptions = {
        deadlineAtMs: this.#openEndedAtMs(),
        beforeNavigation: beforeStressNavigation,
        // T44 P1-5: 幅の走査の読み込みも、最初の読み込みと同じ落ち着きの待ち（`#waitForSettled`）の後に形を測る。L1: 期限は撤廃し、その幅の page を見張る
        // （見張りが終えたら待ちをやめる）。結果は使わない。
        settleBeforeLayout: async (stressView) => {
          await this.#waitForSettledWatched(stressView);
          // L1: 幅の落ち着きの待ちが終わった（中身の進み）。
          widthSignals?.mark('BROWSER_RESPONSE');
          // DEF-210（設計書 3.2）: 幅の走査の各幅でも、測る前に通知の枠を閉じる（閉じられない枠は隠す）。閉じる前の layout は測らない。L1: 予算（15 秒）は撤廃し、
          // その幅の page を見張る。見張りが終えたら、途中の結果を打ち切りの印つきで残す。
          const width = loadingStressWidth;
          const progress: NotificationDismissalProgress = { current: null };
          // REV-SD の I-1: 範囲の外へ移った幅の page では押さず、その幅を測らない（その幅を失敗にする）。
          const inAuditScope = (): boolean => this.#inAuditScope(stressView, url);
          if (!inAuditScope()) {
            throw new Error('the stress page moved out of the audit scope');
          }
          // AUD-2（5.2）: その幅で隠す前の画面の画像（隠したときだけ残す）。
          const sink = state.stressScreenshots;
          const shotStartedAt = this.#clock().toISOString();
          const beforeHide = width === null
            ? null
            : this.#beforeHideScreenshot({ view: stressView, pageId: sink.pageId, profile: 'desktop', retryAttempt: sink.retryAttempt, stressWidth: width });
          const handled = await this.#watchOnPage(stressView, () => stressView.dismissNotificationFrames({
            deadlineAtMs: this.#openEndedAtMs(),
            pressMode: 'AUDIT',
            seenDigests: this.#seenNotificationDigestsOf(STRESS_NOTIFICATION_SEEN_KEY),
            progress,
            inAuditScope,
            ...(beforeHide === null ? {} : { beforeFirstHide: beforeHide.capture }),
          }));
          const overlay = handled.status === 'FULFILLED' ? handled.value : notificationOverlayAfterTimeout(progress);
          await beforeHide?.commit(overlay.frames, (shot) => {
            sink.record('screenshot', shot, this.#stageCapture(pending.stateId, 'stress-layout', shotStartedAt));
          });
          if (!inAuditScope()) {
            throw new Error('the stress page moved out of the audit scope');
          }
          if (width !== null && hasNotificationFacts(overlay)) {
            state.notification.stress.push(Object.freeze({ width, overlay }));
          }
          // fix round 2（設計書 3.2.1 の 4）: 閉じる押下で main frame の移動を試みた幅は、誤りの画面を測らない（理由を残し、その幅を失敗にする）。
          if (overlay.navigated) {
            if (!reasons.some((reason) => reason.code === NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON.code)) {
              reasons.push(NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON);
            }
            throw new Error('the close press of a notification frame tried to move the page');
          }
          // DF-3（DEF-167）: 落ち着きを待った後にも確かめる（当たれば、次の幅を始めない）。
          this.#detectSessionLoss(
            SESSION_LOSS_CHECK_POINTS.settled,
            state.sessionLossLoads.filter((load) => load.view === stressView),
            state.authSessionLoss,
            reasons,
          );
        },
        // AUD-3d: その幅の layout を読んだ直後に、その幅の viewport の画像を撮る（画像を撮る設定のときだけ）。
        afterLayout: this.#stressWidthScreenshot(pending.stateId, state.stressScreenshots),
        afterNavigation: (observation) => {
          // T25c: セッションの切れを先に確かめる（当たれば、次の幅を始めない。サイトの不調とは取り違えない）。
          const stressLoad = loadingStressLoad;
          if (stressLoad === null || this.#detectSessionLoss(
            SESSION_LOSS_CHECK_POINTS.navigation,
            [stressLoad],
            state.authSessionLoss,
            reasons,
          ) === null) {
            siteUnavailability.observe(STRESS_LAYOUT_STAGE, observation);
          }
          // L1: 幅の読み込みが終わった（中身の進み）。
          widthNavigated = true;
          widthSignals?.mark('BROWSER_RESPONSE');
        },
    };
    const afterStressLayout = stressOptions.afterLayout;
    /** 幅ごとに読み込み直す（今の形）。`hardStop` なら、残りの幅を始めない。 */
    const reloadWidths = async (
      widths: readonly number[],
      afterLayout = afterStressLayout,
    ): Promise<{ readonly results: StressSweepResults; readonly hardStop: boolean }> => {
      const results: StressSweepResults[number][] = [];
      for (const width of widths) {
        const outcome = await watchWidth(width, false, () => this.#ports.collectStressLayout(createSessionFor(null), url, [width], { ...stressOptions, afterLayout }));
        results.push(...outcome.results);
        if (outcome.hardStop) {
          return { results: Object.freeze(results), hardStop: true };
        }
      }
      return { results: Object.freeze(results), hardStop: false };
    };
    /** SWR: 大きさを変えて集めた幅の証拠（画像・フォーカスの確かめ・通知の枠の記録・押す期間の移動）を捨てる（読み込み直した幅で集め直す）。 */
    const discardResizedWidths = async (widths: readonly number[]): Promise<void> => {
      const discarded = new Set(widths);
      await state.stressScreenshots.discardWidths(discarded);
      for (const width of discarded) {
        state.pressBlockedWidths.delete(width);
      }
      const { stress } = state.notification;
      for (let index = stress.length - 1; index >= 0; index -= 1) {
        if (discarded.has(stress[index]?.width ?? Number.NaN)) {
          stress.splice(index, 1);
        }
      }
    };
    const sweepAllWidths = async (): Promise<StressSweepResults> => {
      const widths = stressSweepWidths(config, pending.breakpointWidths);
      const narrowest = widths.at(-1);
      if (widths.length < 2 || narrowest === undefined) {
        return (await reloadWidths(widths)).results;
      }
      // 1. 一番広い幅で 1 回だけ読み込み、広い順に大きさだけを変えて測る。一番狭い幅は、照らし合わせのために測るだけ（証拠は残さない）。
      const sweptWidths: number[] = [];
      const resizedState: { focus: FocusCheckEvidence | null; hardStop: boolean } = { focus: null, hardStop: false };
      const resized = await this.#ports.collectResizedStressLayout(createSessionFor(sweptWidths), url, widths, {
        ...stressOptions,
        afterLayout: async (view, width, layout) => {
          if (width === narrowest) {
            resizedState.focus = await view.collectFocusChecks({ stressWidth: width, settleIntervalMs: this.#windows.scroll.stepWaitMs });
            return;
          }
          await afterStressLayout?.(view, width, layout);
        },
        aroundWidth: async (width, work) => {
          const resizedWidth = width !== widths[0];
          if (resizedWidth) {
            abortIfNextWidthMustNotStart();
          }
          const outcome = await watchWidth(width, resizedWidth, async () => [await work()]);
          sweptWidths.push(width);
          resizedState.hardStop ||= outcome.hardStop;
          const [result] = outcome.results;
          if (result === undefined) {
            throw new Error('the resized stress width produced no result');
          }
          return result;
        },
      });
      // REV-SWR の M-1: 大きさを変えた Context の Ledger の `widths` は、大きさを変えて測り、結果を残した幅だけにする（`beaksight-block-relation` が、ほかの幅の
      // 指摘を、この Context の止めた要求に結び付けないため）。
      const keepSweptWidths = (kept: readonly StressSweepResults[number][]): void => {
        sweptWidths.splice(0, sweptWidths.length, ...kept.map((result) => result.width));
      };
      if (resizedState.hardStop) {
        // REV-SWR の M-2: 一番狭い幅は結果を残さないので、ほかの終わり方と同じく、その幅の記録を捨てる。
        await discardResizedWidths([narrowest]);
        const kept = resized.filter((result) => result.width !== narrowest);
        keepSweptWidths(kept);
        return Object.freeze(kept);
      }
      // 大きさを変えて回す途中で幅が終わったら、全部の幅を幅ごとに読み込み直す。
      if (resized.length !== widths.length || resized.some((result) => result.status === 'FAILED')) {
        await discardResizedWidths(widths);
        keepSweptWidths([]);
        return (await reloadWidths(widths)).results;
      }
      // 2. 一番狭い幅を読み込み直して測り（証拠は、ここで残す）、大きさを変えて測った事実と照らし合わせる。
      await discardResizedWidths([narrowest]);
      const loadedFacts: { focus: FocusCheckEvidence | null } = { focus: null };
      const verified = await reloadWidths([narrowest], this.#stressWidthScreenshot(pending.stateId, state.stressScreenshots, (checks) => {
        loadedFacts.focus = checks;
      }));
      const others = resized.slice(0, -1);
      keepSweptWidths(others);
      const loadedLayout = verified.results[0]?.layout ?? null;
      const resizedLayout = resized.at(-1)?.layout ?? null;
      if (verified.hardStop || loadedLayout === null || (resizedLayout !== null && sameStressLayoutFacts(
        { layout: resizedLayout, focus: resizedState.focus },
        { layout: loadedLayout, focus: loadedFacts.focus },
      ))) {
        return Object.freeze([...others, ...verified.results]);
      }
      // 3. 違いが出たら、大きさを変えて集めた幅の証拠を捨てて、残りの幅を幅ごとに読み込み直す。
      const otherWidths = others.map((result) => result.width);
      await discardResizedWidths(otherWidths);
      keepSweptWidths([]);
      const reloaded = await reloadWidths(otherWidths);
      return Object.freeze([...reloaded.results, ...verified.results]);
    };
    const swept = await runner.attempt(
      'stress-layout',
      sweepAllWidths,
      false,
      (error) => (this.#safetyViolationRecorded() ? SAFETY_VIOLATION_ABORT_CODE : stressSweepFailureReason(error) ?? STRESS_SWEEP_FAILED_REASON),
    );
    if (!swept.ok) {
      return null;
    }
    // B（C18i）: 幅の結果が `PAGE_CLOSED` で違反が記録されていれば、Guard が違反でその幅の Context を閉じたので `SAFETY_VIOLATION_ABORT` にする（止めたことは
    // 記録しない確かめ。止めるのは次を始めない所）。
    const violationDetected = this.#safetyViolationDetected();
    const sweepReasons = new Set(swept.value.flatMap((result) => (
      result.status === 'COMPLETE' ? [] : [stressWidthIncompleteReasonOf(result.reason, violationDetected)])));
    reasons.push(...[...sweepReasons].map((reason) => collectorIncompleteReason('stress-layout', reason)));
    return swept.value;
  }

  /**
   * Interaction の段階（設計書 4.3.1、4.5.7、4.5.8）。Passive の page で候補を見つけ、除外されるものも含めて、
   * 見つけた順に `auditInteraction` に渡す（呼び出しの前に取り除かない）。渡すのは、1ページの上限（`crawl.maxInteractionsPerPage`）
   * までで、残りは理由 `interaction:limit:remaining=<件数>` で記録する（サイトへの負荷の制御の設計書 4.3）。このビューポートでサイトの
   * 不調を検知した後は、残りの候補を始めず、理由 `interaction:SITE_UNAVAILABLE:remaining=<件数>` で記録する（サイトが応答しないときに
   * Run を止める設計書 3.1）。
   * 各候補の結果は、Evidence の部分を `interaction` の Evidence に記録し、Safety の snapshot は、INTERACTION の safety の
   * Evidence と違反の集計に使う。候補の結果の状態（NOT_VERIFIABLE など）では、ビューポートの状態を変えない。
   */
  async #auditInteractions(state: CollectionState): Promise<void> {
    const { view, reasons, siteUnavailability, attempt, stages } = state;

    // 候補の発見は Passive の page で行うので、Passive の段階と同じく、crash と競わせ、進みの見張りで待つ（L1）。読み取りの期限（部品の既定 10 秒）は、
    // 呼び出し側から切らない値を渡して外す（`maxDomWork` は部品の既定。件数の上限は L5）。
    const discovery = await attempt('interaction-discovery', () =>
      view.discoverInteractionCandidates(undefined, this.#openEndedAtMs()));
    if (!discovery.ok) {
      return;
    }
    // L1: Interaction の段階の期限（`overallPageTimeoutMs`）と、それに収まらない候補を始めない予算の決まりは撤廃した。候補ごとの期限（候補1つの見積もり。
    // L5 の範囲）だけを、候補を始める時刻から数える。Run の時間の上限に候補1つの見積もりが収まらなければ、残りの候補は始めない（`budget`）。
    const { completeness } = discovery.value;
    if (completeness !== 'COMPLETE') {
      reasons.push(collectorIncompleteReason('interaction-discovery', completeness));
    }
    // L5 の N5（設計者の判断 2026-11-10）: Desktop は見つけた候補を全部確かめ、その候補を控える。Mobile は、Desktop の同じページになかった候補だけを確かめる
    // （Desktop の候補が分からなければ全部）。
    const candidates = state.profile === 'desktop'
      ? discovery.value.candidates
      : mobileOnlyInteractionCandidates(this.#desktopInteractionCandidates, discovery.value.candidates);
    if (state.profile === 'desktop') {
      this.#desktopInteractionCandidates = discovery.value.candidates;
    }

    const auditOne = (
      target: InteractionCandidate,
      index: number,
      trail: readonly InteractionPressStep[],
      remaining: number,
      trailStructureKey: string | null = null,
    ): Promise<'CONTINUE' | 'STOP'> => this.#auditOneInteraction(state, target, index, trail, remaining, trailStructureKey);
    /**
     * 次の候補を始めるか（順は `interactionCandidateStepOf`: 段が止まった → 違反（Task 19 の前の整理の設計書 4.5）→ このビューポートの不調（設計書 3.1）→
     * 1 ページの上限（負荷の制御の設計書 4.3。L14: 利用者が指定したときだけ）。始めない候補では、ページの読み込みの間隔の待ちも呼ばない。止めたら、始めなかった
     * 候補の件数を理由に残し、偽を返す。`index` は監査を始めた候補の数（失敗した候補も数える）。
     */
    const mayAudit = (index: number, remaining: number): boolean => {
      const step = interactionCandidateStepOf({
        stopped: stages.stopped,
        violationRecorded: this.#safetyViolationRecorded,
        siteUnavailable: siteUnavailability.detected !== null,
        index,
        maxInteractionsPerPage: this.#config.crawl.maxInteractionsPerPage,
      });
      if (step.kind === 'STOP') {
        reasons.push(interactionStoppedReason(step.reason, remaining));
      }
      return step.kind === 'AUDIT';
    };
    for (const [index, candidate] of candidates.entries()) {
      if (!mayAudit(index, candidates.length - index)) {
        return;
      }
      if (await auditOne(candidate, index, [], candidates.length - index) === 'STOP') {
        return;
      }
    }

    // COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 開いた状態を幅優先で広げる（開いた順。`state.openedStates` は、確かめるたびに後ろに
    // 増える）。開いた状態の中の候補は、（その状態の構造の鍵、候補の ID、順番）がまだ見ていない組だけを、開くまでの押下の並びを押し直してから確かめる。
    // 終わりは、新しい構造の鍵の開いた状態が出なくなったとき（深さ・回数の上限は置かない）。
    let nextIndex = candidates.length;
    for (let position = 0; position < state.openedStates.length; position += 1) {
      const opened = state.openedStates[position];
      if (opened === undefined) {
        continue;
      }
      for (const nestedCandidate of opened.candidates) {
        if (!mayAudit(nextIndex, 1)) {
          return;
        }
        if (!this.#acceptOpenedPress({
          structureKey: opened.openedState.structureKey,
          candidateId: nestedCandidate.candidateId,
          ordinal: nestedCandidate.ordinal,
        })) {
          continue;
        }
        const index = nextIndex;
        nextIndex += 1;
        if (await auditOne(nestedCandidate, index, opened.trail, 1, opened.openedState.structureKey) === 'STOP') {
          return;
        }
      }
    }
  }

  /**
   * Interaction の候補を 1 つ確かめ、記録する（主の画面の候補と、COV-4 の区切り 3 の入れ子の候補で共通）。`trail` は開いた状態まで押し直す押下の並び（主の
   * 画面の候補は空）、`trailStructureKey` は押し直した後に同じ構造かを確かめる鍵。止めるべき理由を記録したら `STOP`。
   */
  async #auditOneInteraction(
    state: CollectionState,
    candidate: InteractionCandidate,
    index: number,
    trail: readonly InteractionPressStep[],
    remaining: number,
    trailStructureKey: string | null,
  ): Promise<'CONTINUE' | 'STOP'> {
    const { url, viewportSize, reasons, safety, record, attempt } = state;
    // ページの読み込みの間隔を守る（負荷の制御の設計書 4.1）。候補の監査は、隔離した Context で対象のページを読み込むためである。
    // 2件目以降の候補の開始の時刻は、待った後の現在の時刻である。
    await this.#pacedNavigation({ pageId: state.pageId, stateId: state.stateId });
    const deadlineAtMs = this.#interactionCandidateDeadline(this.#now());
    if (deadlineAtMs === null) {
      reasons.push(interactionStoppedReason(INTERACTION_STOP_REASONS.budget, remaining));
      return 'STOP';
    }
    // 候補は隔離した Context で監査するので、Passive の page の crash とも、ページの期限とも競わせない（幅の走査と同じ）。
    // 候補の監査は、候補ごとの期限（`deadlineAtMs`）を受け取って自分で守る。
    // COV-4 の区切り 3: 確かめ終えた操作で開いた状態の監査（操作の部品の口 `afterVerified` から呼ばれる）。
    let opened: Omit<PendingOpenedState, 'interactionEvidenceId'> | null = null;
    const afterVerified = async (openedView: AuditView): Promise<void> => {
      // DBG-1: 開いた状態の確かめの時間を測る（切なら何もしない）。
      opened = await this.#debugTiming.measure('AUDIT_STAGE', () => ({ pageId: state.pageId, stateId: state.stateId, part: 'opened-state' }),
        () => this.#auditOpenedState(state, openedView, [...trail, { candidateId: candidate.candidateId, ordinal: candidate.ordinal }]));
    };
    // 入れ子の候補は、押し直した後の page が、記録した開いた状態と同じ構造かを確かめる。
    const nested = trail.length === 0 || trailStructureKey === null
      ? undefined
      : {
        pressTrail: trail,
        verifyTrail: async (pressedView: AuditView): Promise<boolean> => (await this.#openedStructureKeyOf(pressedView, state.pageId, url)) === trailStructureKey,
      };
    const audited = await attempt(
      'interaction',
      () => this.#auditInteractionCandidate(url, candidate, index, viewportSize, deadlineAtMs, state, afterVerified, nested),
      false,
    );
    if (!audited.ok) {
      return 'CONTINUE';
    }
    if (audited.value.kind === 'CLEANUP_FAILED') {
      safety.interactionSnapshots.push({ snapshot: audited.value.safety, candidateIndex: index });
      reasons.push(interactionStoppedReason(INTERACTION_STOP_REASONS.cleanup, remaining - 1));
      return 'STOP';
    }
    const { safety: snapshot, ...interaction } = audited.value.result;
    const openedResult = opened as Omit<PendingOpenedState, 'interactionEvidenceId'> | null;
    const interactionRecord = record('interaction', {
      ...interaction,
      ...(trail.length === 0 ? {} : { pressTrail: trail }),
      ...(openedResult === null ? {} : { openedState: openedResult.openedState }),
    });
    if (openedResult !== null && openedResult.openedState.status !== 'SAME_STRUCTURE_SEEN') {
      state.openedStates.push({ ...openedResult, interactionEvidenceId: interactionRecord.evidenceId });
    }
    // BN-a: 候補の番号（候補の発見の順）と組にして残す。
    safety.interactionSnapshots.push({ snapshot, candidateIndex: index });
    return 'CONTINUE';
  }

  /** COV-4 の区切り 3: page の今の状態の、開いた状態の構造の鍵（DOM と、見つけた操作の候補の ID から。読み取りだけ）。 */
  async #openedStructureKeyOf(view: AuditView, pageId: PageId, url: NormalizedHttpUrlEvidence): Promise<string> {
    const dom = await view.collectDomEvidence(pageId);
    const discovered = await view.discoverInteractionCandidates(undefined, this.#openEndedAtMs());
    return openedStateStructureKeyOf(dom, url, discovered.candidates.map(({ candidateId }) => candidateId));
  }

  /**
   * COV-4 の区切り 3（網羅の設計書 3.2 の 6。設計者の判断 2026-11-10）: 確かめ終えた操作で開いた状態（凍結したままの隔離した page）に、今の段を読み込み直さずに
   * 当てる（DOM・layout・axe・画像・フォーカスの確かめ。段は `opened-state`、状態 ID は読み込みの状態 ID に `:state-<番号>`）。
   * - 開いた状態の構造の鍵（`openedStateStructureKeyOf`）が Run の全体で見た鍵なら、監査しない（`SAME_STRUCTURE_SEEN`。DOM の読み取りの記録も残さない）。
   * - その page を見張る進みの見張りで包む。見張りに終えられたら、それまでの記録を残して `PARTIAL`。読み取りの失敗も `PARTIAL`。
   * - 指摘は、Rule の評価の段で、この状態の記録だけで作る（開く前の画面と同じ指摘を除く）。
   */
  async #auditOpenedState(
    state: CollectionState,
    view: AuditView,
    trail: readonly InteractionPressStep[],
  ): Promise<Omit<PendingOpenedState, 'interactionEvidenceId'> | null> {
    const { pageId, profile, url, viewportSize, record } = state;
    const config = this.#config;
    const startedAt = this.#clock().toISOString();
    const openedStateIndex = state.openedStates.length + 1;
    const stateId = openedEvidenceStateIdOf(state.stateId, openedStateIndex);
    const capture = (): EvidenceCapture => this.#stageCapture(stateId, 'opened-state', startedAt);
    const evidenceIds: EvidenceId[] = [];
    const keep = (created: EvidenceRecord): void => {
      evidenceIds.push(created.evidenceId);
    };
    let structureKey: string | null = null;
    let seen = false;
    let recheck: PendingRecheck | null = null;
    // AUD-2d・2e の確かめ直しの、データの要求の口ごとの事実（凍結の中なので、ふつうは要求が止められたまま）。落ち着きの待ちのためだけなので、要求ごとの記録を
    // 持たない口にする（設計者の判断 2026-11-11）。
    const openedNetwork = view.attachDataActivity();
    // 入れ子の開いた状態（設計者の判断 2026-11-10）: 開いた状態の中の操作の候補（構造の鍵の候補の識別と、幅優先で広げる候補）。
    let openedCandidates: readonly InteractionCandidate[] = [];
    const watched = await this.#watchOnPage(view, async (signals) => {
      const dom = await view.collectDomEvidence(pageId);
      openedCandidates = (await view.discoverInteractionCandidates(undefined, this.#openEndedAtMs())).candidates;
      structureKey = openedStateStructureKeyOf(dom, url, openedCandidates.map(({ candidateId }) => candidateId));
      // REV-AUD2 の I-1（設計書 5.3 の「REV-AUD2 の後の判断」）: 開いた状態がモーダルなら、入れ子の点検の候補は小窓の中だけにする（背景は操作できない）。
      // 構造の鍵は、今までどおり全部の候補から作る。
      const insideModal = await view.readModalCandidateOrdinals(this.#openEndedAtMs());
      if (insideModal !== null) {
        openedCandidates = openedCandidates.filter(({ ordinal }) => insideModal.includes(ordinal));
      }
      if (!this.#acceptOpenedStructure(structureKey)) {
        seen = true;
        return;
      }
      keep(record('dom', recordedDomEvidenceOf(dom), capture()));
      const layout = await view.collectLayoutEvidence(viewportSize);
      keep(record('layout', layoutPayloadOf(layout, null, { overlay: null, beforeDismissal: null, stress: [] }), capture()));
      let accessibility: EvidencePayloadByType['accessibility'] | null = null;
      if (config.audit.accessibility) {
        accessibility = await view.collectAccessibilityEvidence({ watch: { progress: signals } });
        keep(record('accessibility', accessibility, capture()));
      }
      if (config.audit.screenshots) {
        const relativeArtifactPath = screenshotRelativePath(
          pageId, profile, 'VIEWPORT', state.screenshotRetryAttempt, null, false, null, openedStateIndex, null, this.#screenshotRevisit,
        );
        const outputPath = artifactFilePath(this.#screenshotRootDirectory, relativeArtifactPath);
        try {
          const screenshot = await view.captureViewportScreenshot(
            { outputPath, relativeArtifactPath }, { pageId, viewport: profile, stressWidth: null, markTargets: markTargetsOf(layout.layout) },
          );
          keep(record('screenshot', screenshot, capture()));
        } catch {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      }
      // 主の画面と同じく、落ち着いた後の確かめ直し（AUD-2d・2e。読み込み直さない）を当てる（段は `recheck`、状態 ID は開いた状態のもの。画像は
      // `state-<番号>/recheck/viewport.png`）。確かめ直しの記録は、1 回目の評価の入力に入れない（`PendingRecheck.evidenceIds`）。
      const recheckStartedAt = this.#clock().toISOString();
      const recheckCapture = (): EvidenceCapture => this.#stageCapture(stateId, 'recheck', recheckStartedAt);
      const recheckIds: EvidenceId[] = [];
      recheck = await this.#recheckAfterSettled({
        view,
        pageId,
        profile,
        viewportSize,
        screenshotRetryAttempt: state.screenshotRetryAttempt,
        openedStateIndex,
        network: openedNetwork,
        stages: { lastWatchEnd: null },
        currentCapture: recheckCapture,
        record: (type, payload, recordCapture) => {
          const created = record(type, payload, recordCapture ?? recheckCapture());
          recheckIds.push(created.evidenceId);
          return created;
        },
        attempt: async (_stage, work) => {
          try {
            return { ok: true, value: await work(signals) };
          } catch {
            return { ok: false };
          }
        },
      }, dom, accessibility, true);
      // AUD-2e: 集め直した主の layout は、この状態の 1 回目の layout の後に残す（段 `recheck` の状態と時刻のまま）。
      if (recheck.layout !== null) {
        recheckIds.push(record('layout', recheck.layout.payload, recheck.layout.capture).evidenceId);
      }
      // 確かめ直しの画像など、確かめ直しの中で残した記録も、この状態の確かめ直しの記録にする。
      recheck = Object.freeze({ ...recheck, layout: null, evidenceIds: Object.freeze([...new Set([...recheck.evidenceIds, ...recheckIds])]) });
      // 主の画面と同じく、フォーカスしても隠れたままの部品は、フォーカスを当てたままの画像を撮る（その状態の `state-<番号>/focus-<番号>`）。
      const focusStartedAt = this.#clock().toISOString();
      // AUD-3（REV-AUD3 の後の判断）: 開いた状態では、通常の Tab の確かめはしない（主の読み込みだけ）。M-4: 位置の落ち着きの待ちは、この段の期限で終える。
      const checks = await view.collectFocusChecks({
        stressWidth: null,
        settleIntervalMs: this.#windows.scroll.stepWaitMs,
        track: (work) => signals.track(work),
        signal: signals.signal,
        onFocused: this.#focusedScreenshot({
          view,
          pageId,
          retryAttempt: state.screenshotRetryAttempt,
          screenshots: config.audit.screenshots,
          stateId,
          viewport: profile,
          stressWidth: null,
          openedStateIndex,
          record: (type, payload, focusCapture) => {
            const created = record(type, payload, focusCapture);
            keep(created);
            return created;
          },
        }),
      });
      keep(record('focus', checks, this.#stageCapture(stateId, 'focus-check', focusStartedAt)));
    });
    openedNetwork.detach();
    if (structureKey === null) {
      // 構造の鍵を作る前に終えた（DOM を読めなかった）。監査できなかった。
      return null;
    }
    if (seen) {
      return {
        openedState: { stateId: state.stateId, structureKey, status: 'SAME_STRUCTURE_SEEN', duplicateFindingCount: 0 }, evidenceIds: [], recheck: null, trail, candidates: [],
      };
    }
    const status: OpenedStateStatus = watched.status === 'FULFILLED' ? 'AUDITED' : 'PARTIAL';
    return { openedState: { stateId, structureKey, status, duplicateFindingCount: 0 }, evidenceIds, recheck, trail, candidates: openedCandidates };
  }

  /**
   * 候補1つを `auditInteraction` で監査する。`InteractionOwnerCleanupError` の場合は、エラーが保持する session で `close()` を
   * 1回だけ、`INTERACTION_CLEANUP_ALLOWANCE_MS` を上限に試み、エラーが保持する Safety の snapshot を返す（設計書 4.5.8）。
   * session を作る処理が `ContextConstructionError` を投げた場合は、Guard がまだ Context を閉じていなければ閉じてから、投げ直す。
   * エラーが持つ Ledger は、閉じた後の snapshot を INTERACTION の Safety の記録に加える（Guard が Context を閉じていた場合も含む）。
   * 閉じる処理の失敗は、場面 `interaction-context-close` の理由として記録する（設計書 4.3、4.5.5、R14 の I2、R14r の Important-1・Minor-3）。
   * 候補の対象のページの読み込みの観測は、受け口で受け取り、サイトの不調を判定して記録する（サイトが応答しないときに Run を止める
   * 設計書 2.1、3.1）。`index` は候補の順の番号（候補の発見の順で 0 から）。
   */
  async #auditInteractionCandidate(
    url: NormalizedHttpUrlEvidence,
    candidate: InteractionCandidate,
    index: number,
    viewportSize: Viewport,
    deadlineAtMs: number,
    sink: Pick<CollectionState, 'reasons' | 'safety' | 'siteUnavailability'>,
    afterVerified?: (view: AuditView) => Promise<void>,
    nested?: { readonly pressTrail: readonly InteractionPressStep[]; readonly verifyTrail: (view: AuditView) => Promise<boolean> },
  ): Promise<InteractionCandidateOutcome> {
    const deadlines = this.#deadlines;
    const { openEnded, navigationTimeoutMs, timeoutMs, cleanupTimeoutMs } = interactionTimeoutsOf(this.#config);
    const audit = (progress: ProgressSignals | undefined): Promise<AuditInteractionOutcome> => this.#ports.auditInteraction({
      targetUrl: url,
      candidate,
      viewport: viewportSize,
      navigationTimeoutMs,
      timeoutMs,
      cleanupTimeoutMs,
      deadlineAtMs,
      // session の作成と、凍結の失敗の後の無効化を、期限付きで待つ（DEF-008。Task 18 の前の整理の設計書 4.4）。凍結を待つ処理は、
      // Context を閉じる処理を待つので、その期限（`contextCloseTimeoutMs`）を使う。L5（T21）: 利用者が期限を指定していなければ、凍結の待ちは見張りに任せる
      // （凍結できないまま見張りが終えたら session を閉じる。fail-closed は変わらない）。
      sessionOpenTimeoutMs: deadlines.sessionOpenTimeoutMs,
      freezeActivationTimeoutMs: openEnded ? OPEN_ENDED_STAGE_MS : deadlines.contextCloseTimeoutMs,
      afterTargetLoad: (observation) => {
        sink.siteUnavailability.observe(INTERACTION_STAGE, observation);
      },
      ...(progress === undefined ? {} : { progress }),
      ...(afterVerified === undefined ? {} : { afterVerified }),
      // COV-4 の区切り 3: 入れ子の候補は、開いた状態まで押し直してから確かめる。
      ...(nested === undefined ? {} : { pressTrail: nested.pressTrail, verifyTrail: nested.verifyTrail }),
      // REV-SD の I-1: 隔離した page が範囲の外へ移っていたら押さない。
      ...(this.#isOutsideAuditScope === undefined ? {} : { isOutsideAuditScope: this.#isOutsideAuditScope }),
    }, deadlines, () => this.#now() + INTERACTION_CLEANUP_ALLOWANCE_MS);
    const outcome = await this.#watchedInteraction(openEnded, audit);
    if (outcome.kind === 'CONSTRUCTION_FAILED') {
      // Guard が Context を閉じた場合も、エラーが持つ Ledger を含める（R14r の Important-1）。口が閉じた後の snapshot を受ける。
      sink.reasons.push(...closeFailureReasons(outcome.closeFailures, SESSION_FAILURE_LABELS.interactionContextClose));
      sink.safety.interactionSnapshots.push({ snapshot: outcome.safety, candidateIndex: index });
      throw outcome.error;
    }
    return outcome;
  }

  /**
   * L5（T11・T21）: 利用者が操作の期限を指定していなければ、候補 1 つを、隔離した page を見張る進みの見張りで包む（幅の走査と同じ形）。見張りが終えたら、部品が
   * session を閉じて `NOT_VERIFIABLE`（`STAGE_*`）を返すので、その結果を待つ。Run の時間の上限は、候補の期限（`deadlineAtMs`）が守る。
   */
  async #watchedInteraction(
    openEnded: boolean,
    audit: (progress: ProgressSignals | undefined) => Promise<AuditInteractionOutcome>,
  ): Promise<AuditInteractionOutcome> {
    if (!openEnded) {
      return audit(undefined);
    }
    let running: Promise<AuditInteractionOutcome> | undefined;
    const watched = await watchProgress((signals) => {
      running = audit(signals);
      return running;
    }, { ...this.#watchOptions(), runDeadlineAtMs: null });
    if (watched.status === 'FULFILLED') {
      return watched.value;
    }
    if (watched.status === 'REJECTED') {
      throw watched.reason;
    }
    if (running === undefined) {
      throw new Error('the interaction candidate did not start before the progress watch ended');
    }
    return running;
  }

  /**
   * 次の Interaction の候補の期限（設計書 4.5.7。計算はここだけで行う）。「候補の開始の時刻（間隔の待ちの後）+ 候補1つの予算」とする（候補1つの予算は、
   * `navigationTimeoutMs` と、`interactionTimeoutMs` の2倍の和。部品の中の期限で、L5 の範囲）。L1: 段階の期限は撤廃した。予算の全体が Run の時間の上限に
   * 収まらない場合だけ、`null`（そこで止める）を返す。
   */
  #interactionCandidateDeadline(candidateStartedAtMs: number): number | null {
    const { openEnded, navigationTimeoutMs, timeoutMs } = interactionTimeoutsOf(this.#config);
    // L5: 利用者が操作の期限を指定していなければ、候補の予算を置かない（Run の時間の上限だけ。見張りが終える）。
    if (openEnded) {
      return this.#openEndedAtMs();
    }
    const candidateBudgetMs = navigationTimeoutMs + timeoutMs * INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE;
    const deadlineAtMs = candidateStartedAtMs + candidateBudgetMs;
    return this.#runDeadlineAtMs === undefined || deadlineAtMs <= this.#runDeadlineAtMs ? deadlineAtMs : null;
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
      reasons.push(Object.freeze({ code: 'RULE_EVALUATION_FAILED', detail: safeErrorMessage(error) }));
      return [];
    }
  }

  /**
   * 落ち着きの待ち（T44R2 の M-5: 最初の読み込みと幅の走査の、唯一の呼び出しの形）。部品は `waitForPageSettled`、待ち方は `PAGE_SETTLING_PACING`。
   * L1: 期限（`crawl.resourceSettlingTimeoutMs`）は撤廃し、進みの見張りの口（`signals`）を渡す（新しい高さを読んだときだけ中身の進み）。部品が期限の数を
   * 必ず受け取るので、切らない値（`openEndedStageDeadline`）を渡す。
   */
  #waitForSettled(view: AuditView, signals: ProgressSignals, dataActivity?: () => DataRequestActivity): Promise<PageSettlingResult> {
    return view.waitForSettled({
      deadlineAtMs: this.#openEndedAtMs(),
      pollIntervalMs: this.#windows.pageSettle.pollIntervalMs,
      stableWindowMs: this.#windows.pageSettle.stableWindowMs,
      openDataRequestQuietMs: this.#windows.pageSettle.openDataRequestQuietMs,
      progress: signals,
      // AUD-2b: 主の読み込みでは、データの要求（network の collector の数）が届いたことも、落ち着きの条件にする。
      dataActivity,
      // EV-3: 内容の規則を当てる読み取り（データの要求を渡す主の読み込みと確かめ直し）では、見える読み込み中の表示が消えたことも条件にする（残ったまま
      // 何も動かなくなったら、準備が終わらないまま終えて、読み取りは続ける）。幅の走査は形だけを測るので、今のまま。
      awaitLoadingIndicators: dataActivity !== undefined,
    });
  }

  /** L1: 段の見張りの外（幅の走査の各幅）で落ち着きを待つ。その page を自分で見張り、見張りが終えたら待ちをやめる（結果は使わない）。 */
  async #waitForSettledWatched(view: AuditView): Promise<void> {
    await this.#watchOnPage(view, (signals) => this.#waitForSettled(view, signals));
  }

  /**
   * L1: `page` を見張りながら `work` を待つ（`watchProgress`。ページの自発の変化の印は `attachPageProgressSignals`）。反応なしの長さと Run の時間の上限は、
   * この Page Auditor のもの。`contentKinds` は、中身の進みに数える印（読み込みの段は全部）。
   */
  #watchOnPage<T>(
    view: AuditView,
    work: (signals: ProgressSignals) => Promise<T>,
    contentKinds?: readonly ProgressSignalKind[],
  ): Promise<WatchedOutcome<T>> {
    return watchProgress(async (signals) => {
      const detach = view.attachProgressSignals(signals);
      try {
        return await work(signals);
      } finally {
        detach();
      }
    }, this.#watchOptions(contentKinds));
  }

  /** L1: この Page Auditor の見張りの指定（反応なしの長さ・Run の時間の上限・中身の進みに数える印）。 */
  #watchOptions(contentKinds?: readonly ProgressSignalKind[]): ProgressWatchOptions {
    return {
      quietLimitMs: this.#quietLimitMs,
      runDeadlineAtMs: this.#runDeadlineAtMs ?? null,
      ...(contentKinds === undefined ? {} : { contentKinds }),
    };
  }

  /** L1: 期限を撤廃した段で、期限の数を必ず受け取る部品に渡す値（Run の時間の上限より後にしない）。 */
  #openEndedAtMs(): number {
    return openEndedStageDeadline(this.#now(), this.#runDeadlineAtMs);
  }

  /** L1: Run の時間の上限（期限の上限 `notAfterMs` に渡す形。上限なしは `undefined`）。 */
  #runDeadlineOrUndefined(): number | undefined {
    return this.#runDeadlineAtMs;
  }

  /** L0: Run の時間の上限を過ぎたか（上限なしなら偽）。 */
  #runTimeLimitPassed(): boolean {
    return this.#runDeadlineAtMs !== undefined && this.#now() >= this.#runDeadlineAtMs;
  }
}

/**
 * DEF-191: Desktop の Context を閉じた後に回す幅の走査の控え。`primary` は Desktop の主の形（layout の Evidence の `primary`）。L1: 走査に残す時間の控え
 * （`budgetMs`）は撤廃した。
 */
interface DeferredStressSweep {
  readonly primary: EvidencePayloadByType['layout']['primary'];
  /** AUD-2a: 主の形を測った段の、集めた状態と時刻（幅の走査の後に包む layout の Evidence に付ける）。 */
  readonly primaryCapture: EvidenceCapture | null;
  /** AUD-2b・2d の指示書の 3: Desktop の読み込みの状態 ID（幅の走査の各幅の結果に付ける）。 */
  readonly stateId: EvidenceStateId;
  /** L14: Desktop の page の CSS の media query の境目の両側の幅（`breakpointSideWidthsOf`）。 */
  readonly breakpointWidths: readonly number[];
  /** DUP: 幅の走査をするか（偽なら、走査をせずに主の形だけを記録する。`pageAuditStagesOf`）。 */
  readonly sweep: boolean;
}

/** DEF-210（設計書 3.2・3.3・3.6）: 1 つのビューポートの通知の枠の事実。 */
interface ViewportNotification {
  overlay: NotificationOverlayEvidence | null;
  beforeDismissal: LayoutCollectionResult | null;
  readonly stress: StressNotificationOverlayEvidence[];
}

/** fix round 2（設計書 3.2.1 の 4）: 閉じる押下の移動を止めたビューポートの理由。 */
const NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON: IncompleteReason = Object.freeze({ code: 'NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED', detail: null });

/** fix round 3（設計書 3.2.2 の 4）: 押す期間に移動を止めたビューポートで捨てる、画面を測った Evidence の種類（通信・console・安全の記録は残す）。 */
const MEASURED_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>(['dom', 'layout', 'accessibility','performance', 'screenshot', 'scroll', 'focus']);

/** REV-SD の I-1: 点検の範囲の外へ移ったビューポートで捨てる Evidence の種類（読み込みで移ったときと同じく、通信・console・安全の記録・metadata だけを残す）。 */
const OUTSIDE_AUDIT_SCOPE_DISCARDED_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  ...MEASURED_EVIDENCE_TYPES, 'link', 'color', 'interaction',
]);

/** REV-SD の I-1: 点検の範囲の外へ移ったことで、残りの段を始めない原因（`StageRunner.watchDocument`。理由は残さない）。 */
const OUTSIDE_AUDIT_SCOPE_CAUSE = 'OUTSIDE_AUDIT_SCOPE';

/** fix round 3: 画面を測った Evidence（REV-SD の I-1: または `types`）を、並びから取り除く（並びをその場で変える）。 */
function discardMeasuredEvidence(evidence: EvidenceRecord[], types: ReadonlySet<EvidenceType> = MEASURED_EVIDENCE_TYPES): void {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const record = evidence[index];
    if (record !== undefined && types.has(record.type)) evidence.splice(index, 1);
  }
}

/** fix round 2（設計書 3.2.1 の 6）: 期限で打ち切ったときの事実（途中の結果があれば、打ち切りの印つきで残す。なければ読めなかった）。 */
const notificationOverlayAfterTimeout = (progress: NotificationDismissalProgress): NotificationOverlayEvidence =>
  (progress.current === null ? UNREADABLE_NOTIFICATION_OVERLAY : Object.freeze({ ...progress.current, truncated: true }));

/** DEF-210: 期限までに通知の枠の処理が戻らなかったときの事実（読めなかった）。 */
const UNREADABLE_NOTIFICATION_OVERLAY: NotificationOverlayEvidence = Object.freeze({
  readStatus: 'FAILED', frames: Object.freeze([]), pressCount: 0, navigated: false, truncated: false,
});
/** DEF-210: 幅の走査の、見た枠の digest の集合の鍵（ビューポートの種類と別に持つ）。 */
const STRESS_NOTIFICATION_SEEN_KEY = 'stress-sweep';

/** 記録する事実があるか（読めなかったか、枠を見つけた）。読めて枠がなければ、Evidence に項目を足さない（前の Evidence の形のまま）。 */
const hasNotificationFacts = (overlay: NotificationOverlayEvidence): boolean => overlay.readStatus === 'FAILED' || overlay.frames.length > 0;

/** layout の Evidence の payload（DEF-210: 通知の枠の事実は、あるときだけ足す）。 */
function layoutPayloadOf(
  primary: EvidencePayloadByType['layout']['primary'],
  stressSweep: EvidencePayloadByType['layout']['stressSweep'],
  notification: ViewportNotification,
): EvidencePayloadByType['layout'] {
  return {
    primary,
    stressSweep,
    ...(notification.beforeDismissal === null ? {} : { beforeNotificationDismissal: notification.beforeDismissal }),
    ...(notification.overlay === null ? {} : { notificationOverlay: notification.overlay }),
    ...(notification.stress.length === 0 ? {} : { stressNotificationOverlays: Object.freeze([...notification.stress]) }),
  };
}

/** DEF-191: D の Context を閉じた後の幅の走査の、決まった理由のない失敗の理由（前の順で D の page が生きていたときの `pageFailureReason` と同じ値）。 */
const STRESS_SWEEP_FAILED_REASON = 'EVALUATION_FAILED';

interface CollectionState {
  readonly url: NormalizedHttpUrlEvidence;
  readonly pageId: PageId;
  readonly profile: ViewportProfile;
  /** RB-10: 監査する page（口の page）。 */
  readonly view: AuditView;
  readonly viewportSize: Viewport;
  readonly allowedQueryParameters: ReadonlySet<string>;
  readonly performanceInstalled: boolean;
  readonly network: NetworkCollectorHandle;
  /** 再試行の前の試行なら、その試行の番号（スクリーンショットを `retry-<番号>` に置く。DEF-007）。そうでなければ `null`。 */
  readonly screenshotRetryAttempt: number | null;
  readonly reasons: IncompleteReason[];
  readonly safety: ViewportSafetySources;
  /** このビューポートで最初に検知したサイトの不調。幅の走査と Interaction の読み込みの観測も、ここで判定して記録する（設計書 3.1）。 */
  readonly siteUnavailability: ViewportSiteUnavailability;
  /** このビューポートで最初に検知したセッションの切れ（T25c）。幅の走査の各幅の読み込みの後にも確かめて記録する。 */
  readonly authSessionLoss: ViewportAuthSessionLoss;
  /** DF-3: このビューポートで読み込んだ page（Passive と、幅の走査の各幅。読み込んだ順）。幅の走査は、読み込んだ幅を加える。 */
  readonly sessionLossLoads: SessionLossLoad[];
  /** DEF-191: Desktop の幅の走査を、Context を閉じた後に回すための控え（`#collect` が書き、`#auditViewport` が閉じた後に読む）。 */
  readonly deferredStressSweep: { value: DeferredStressSweep | null };
  /** DEF-210: このビューポートの通知の枠の事実（`#auditViewport` が作り、閉じる処理と幅の走査が書き、layout の Evidence に入れる）。 */
  readonly notification: ViewportNotification;
  /** AUD-6c: 収集の前に、scroll の段でページを縦に動かして確かめたか（性能の記録の、測る前の操作）。 */
  readonly scrolled: boolean;
  /** EV-1: scroll の段の前に読んだ LCP（読まなかった・読めなかったときは `undefined`）。 */
  readonly lcpBeforeScroll?: Awaited<ReturnType<AuditView['readLcpBeforeScroll']>>;
  /** Evidence を包んで残す。AUD-2a: `capture` を省略すると、直前に終えた段の集めた状態と時刻を付ける。 */
  readonly record: <TType extends EvidenceType>(type: TType, payload: EvidencePayloadByType[TType], capture?: EvidenceCapture | null) => EvidenceRecord;
  /**
   * 段階を実行する。L1: `watched` が真（既定）なら、Passive の page の進みの見張り（`StageRunner.attempt`）で包む（`work` に進みの印の口を渡す）。偽なら
   * 見放さない（自分の Context で行う段階）。`failureReason` は、例外から理由を決める関数（`StageRunner.attempt`）。
   */
  readonly attempt: <T>(
    stage: PageAuditStage,
    work: (signals: ProgressSignals | null) => Promise<T>,
    watched?: boolean,
    failureReason?: StageFailureReason,
    keepOnWatchEnd?: boolean,
  ) => Promise<StageAttempt<T>>;
  readonly stages: StageRunner;
  /** AUD-2a: 直前に終えた段の、集めた状態と時刻（`attempt` が残す。段を始めていなければ `null`）。 */
  readonly currentCapture: () => EvidenceCapture | null;
  /** AUD-2d: 落ち着いた後の確かめ直しの結果（`#collect` が書き、Rule の評価の後に `#auditViewport` が指摘と比べる）。 */
  readonly recheck: { value: PendingRecheck | null };
  /** COV-4 の区切り 3: このビューポートで監査した開いた状態（Rule の評価の段で、開いた状態ごとに評価する）。 */
  readonly openedStates: PendingOpenedState[];
  /** AUD-2a: この読み込みの状態 ID。 */
  readonly stateId: EvidenceStateId;
}

/** AUD-2d: Rule の評価の前の、確かめ直しの結果（指摘の印は、Rule の評価の後に決める）。 */
/** AUD-3d・4d: 幅の走査の幅の viewport の画像とフォーカスの確かめを残す口（ページ・試行の番号・画像を撮るか、Evidence を残す関数）。 */
interface StressScreenshotSink {
  readonly pageId: PageId;
  readonly retryAttempt: number | null;
  readonly screenshots: boolean;
  readonly record: <TType extends 'screenshot' | 'focus'>(type: TType, payload: EvidencePayloadByType[TType], capture: EvidenceCapture) => EvidenceRecord;
  /** SWR: その幅の画像とフォーカスの確かめの Evidence を捨てる（大きさを変えて集め、読み込み直しに戻した幅）。 */
  readonly discardWidths: (widths: ReadonlySet<number>) => Promise<void>;
  /** AUD-4: その幅の、今の記録の隠した通知の枠の数（状態の印に足す）。 */
  readonly hiddenFrameCountOf: (width: number) => number;
}

/** EV-2・FRET: `reveal-<番号>` の画像を撮る先（読み込みの page・ページ・試行の番号・状態 ID・ビューポート・幅・段・Evidence を残す関数）。 */
interface NumberedCaptureTarget {
  readonly view: AuditView;
  readonly pageId: PageId;
  readonly retryAttempt: number | null;
  readonly stateId: EvidenceStateId;
  readonly viewport: ViewportProfile;
  readonly stressWidth: number | null;
  readonly phase: PageAuditStage;
  readonly record: StressScreenshotSink['record'];
}

/**
 * AUD-2d・2e の確かめ直しを当てる先（読み込みの状態の `CollectionState` と、COV-4 の区切り 3 の開いた状態の両方）。開いた状態は `openedStateIndex` を持つ
 * （確かめ直しの画像の置き場が、その状態の下になる）。
 */
type RecheckTarget = Pick<CollectionState, 'view' | 'pageId' | 'profile' | 'attempt' | 'record' | 'viewportSize' | 'currentCapture' | 'screenshotRetryAttempt'> & {
  readonly network: Pick<NetworkCollectorHandle, 'dataRequestActivity'>;
  readonly stages: Pick<StageRunner, 'lastWatchEnd'>;
  readonly openedStateIndex?: number | null;
};

/** COV-4 の区切り 3: 監査した開いた状態（Rule の評価の段で、その状態の記録だけで評価し、操作の記録の除いた数を書き直す）。 */
interface PendingOpenedState {
  /** その状態の確かめ直し（AUD-2d・2e。集めなかったら `null`）。 */
  readonly recheck: PendingRecheck | null;
  /** 入れ子の開いた状態: 読み込みの後、この状態まで押す押下の並び（この状態を開いた押下を含む）。 */
  readonly trail: readonly InteractionPressStep[];
  /** 入れ子の開いた状態: この状態の中で見つけた操作の候補（幅優先で広げる。同じ構造の状態は空）。 */
  readonly candidates: readonly InteractionCandidate[];
  /** その状態を開いた操作の記録の ID。 */
  readonly interactionEvidenceId: EvidenceId;
  readonly openedState: OpenedStateEvidence;
  /** その状態の記録の ID（DOM・layout・axe・フォーカスの確かめ・画像）。 */
  readonly evidenceIds: readonly EvidenceId[];
}

interface PendingRecheck {
  readonly status: ViewportRecheckRecord['status'];
  readonly reason: ViewportRecheckRecord['reason'];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settling: ViewportSettlingRecord | null;
  readonly axeRuleIds: readonly string[];
  /** 確かめ直しの axe の結果（流さなかったら `null`）。 */
  readonly accessibility: EvidencePayloadByType['accessibility'] | null;
  /**
   * AUD-2d の直し・AUD-2e: 確かめ直しで残した Evidence の ID（axe と主の layout。`LATE` の指摘が参照する。1 回目の Rule の評価の入力には入れない）。
   * 集めなかったものは含まない。
   */
  readonly evidenceIds: readonly EvidenceId[];
  /**
   * AUD-2e: 集め直した主の layout（まだ Evidence にしていないもの。集めた段の状態と時刻つき）。1 回目の layout の Evidence の後に残し、その ID を
   * `evidenceIds` に足す（`#recordRecheckLayout`）。集めなかったら `null`。
   */
  readonly layout: { readonly payload: EvidencePayloadByType['layout']; readonly capture: EvidenceCapture | null } | null;
  /** 印を付けた見出し。 */
  readonly headings: readonly RecheckHeadingRecord[];
  /** EV-3: 読み直した DOM の準備の状態（確かめ直さなかったら `null`）。 */
  readonly pageReady: boolean | null;
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

/** 閉じる処理の期限切れ（Context）を、例外そのものか、`AggregateError` の中（入れ子を含む）に含むか。 */
function includesCloseDeadline(error: unknown): boolean {
  if (error instanceof PassiveContextCloseDeadlineError) {
    return true;
  }
  return error instanceof AggregateError && Array.isArray(error.errors) && error.errors.some(includesCloseDeadline);
}

/**
 * 幅の走査の段階の例外から、理由を決める（RP18r の Minor-2、C18f）。
 * - 違反を検出したため、次の幅のセッションを作らなかった: `SAFETY_VIOLATION_ABORT`
 * - サイトの不調を検知したため、次の幅のセッションを作らなかった: `SITE_UNAVAILABLE`（サイトが応答しないときに Run を止める設計書 3.1）
 * - 認証つきの Run で、セッションの切れを検知したため、次の幅のセッションを作らなかった: `AUTH_SESSION_LOST`（T25c）
 * - セッションを閉じる処理の期限切れを含む: `CLOSE_DEADLINE_EXCEEDED`
 * - そのほか: `null`（既定の `pageFailureReason(page)`）
 */
const stressSweepFailureReason: StageFailureReason = (error) => {
  if (error instanceof SafetyViolationAbortError) {
    return SAFETY_VIOLATION_ABORT_CODE;
  }
  if (error instanceof SiteUnavailableAbortError) {
    return SITE_UNAVAILABLE_CODE;
  }
  if (error instanceof AuthSessionLostAbortError) {
    return AUTH_SESSION_LOST_CODE;
  }
  return includesCloseDeadline(error) ? CLOSE_DEADLINE_EXCEEDED_REASON : null;
};

/**
 * L1: page の進みの見張り（`PageAuditor.#watchOnPage` を page に結んだもの）。`work` に進みの印の口を渡し、ページの自発の変化の印も付ける。
 * `contentKinds` は、中身の進みに数える印（省略は既定。読み込みの段は全部）。
 */
type PageWatch = <T>(
  work: (signals: ProgressSignals) => Promise<T>,
  contentKinds?: readonly ProgressSignalKind[],
) => Promise<WatchedOutcome<T>>;

/**
 * 1つのビューポートの Passive の page に対する段階の実行と、それを止める事象（描画プロセスの crash と、進みの見張り）を扱う。
 *
 * - crash した page への操作は、終わらないことがある（例: `locator.evaluateAll`）。メインスレッドが止まったページへの操作も、
 *   終わらない（R14 の I1）。そのため、Passive の page に対する段階は、crash と競わせ、L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）
 *   からは期限ではなく進みの見張り（`watchProgress`）で待つ。進みがある間は何分でも待ち、反応なしの長さの間に進みがなければ見放す。見放した処理の、遅れて返る
 *   結果や reject は封じ込める。見放した処理は、Context を閉じると終わる。
 * - crash を見つけた場合は、crash したときに処理中だった段階（なければ、見つけた時点の段階）を `<段階>:PAGE_CRASHED` として
 *   1回だけ記録する（設計書 4.5.4）。それより後の段階は、実行も記録もしない。
 * - 見張りが段階を終えた場合は、閉じた一覧の理由（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`。Run の時間の上限は `<段階>:MAX_RUNTIME_REACHED`）を記録する
 *   （`progressWatchEndReason`）。ページが応答しない（`STAGE_UNRESPONSIVE`）か Run の時間の上限なら、それより後の段階は実行しない（止まったページで段階ごとに
 *   待たない）。静まらない（`STAGE_NEVER_QUIET`。ページは動いている）なら、次の段階へ進む。それまでの段階の記録は、どの場合も残る。
 */
class StageRunner {
  readonly #view: Pick<AuditView, 'failureReason'>;
  readonly #reasons: IncompleteReason[];
  readonly #watch: PageWatch;
  #crashed = false;
  #crashRecorded = false;
  #stopped = false;
  #currentStage: PageAuditStage | null = null;
  #crashedDuringStage: PageAuditStage | null = null;
  /** AUD-2a: 直前の段を見張りが終えた理由。 */
  #lastWatchEnd: ProgressWatchEnd | null = null;
  /** DEF-250 の c: page を使うのをやめる原因を読む口（`watchDocument` で付ける。付けなければ見ない）と、その理由を記録したか。 */
  #documentLeftCause: (() => AuditDocumentLeftCause | typeof OUTSIDE_AUDIT_SCOPE_CAUSE | null) | null = null;
  #documentLeftRecorded = false;
  #resolveCrashSignal: () => void = () => undefined;
  /** crash したときに解決する。 */
  readonly #crashSignal: Promise<void> = new Promise<void>((resolve) => {
    this.#resolveCrashSignal = resolve;
  });

  constructor(view: Pick<AuditView, 'failureReason'>, reasons: IncompleteReason[], watch: PageWatch) {
    this.#view = view;
    this.#reasons = reasons;
    this.#watch = watch;
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

  /** crash か、応答しない・Run の時間の上限（L1。進みの見張り）を記録した後は、残りの段階を実行しない。 */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** AUD-2a: 直前の段（`attempt`）を見張りが終えた理由（終えなければ `null`）。 */
  get lastWatchEnd(): ProgressWatchEnd | null {
    return this.#lastWatchEnd;
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
   * `watched` が真なら、crash と競わせ、進みの見張り（L1）で待つ（`work` に進みの印の口を渡す）。偽なら、見放さずに終わりを待つ（Passive の page ではなく、
   * 別の Context で行う段階。幅の走査と、Interaction の候補。`work` には `null` を渡す）。その場合も、終わった時点で crash していれば記録する。
   * `failureReason` を渡した場合は、例外のときの `<理由>` を、まずその関数で決める（`null` を返せば `pageFailureReason(page)`）。
   */
  async attempt<T>(
    stage: PageAuditStage,
    work: (signals: ProgressSignals | null) => Promise<T>,
    watched: boolean,
    failureReason?: StageFailureReason,
    keepOnWatchEnd = false,
  ): Promise<StageAttempt<T>> {
    this.#lastWatchEnd = null;
    if (this.#stopped) {
      return STAGE_NOT_COMPLETED;
    }
    if (this.#crashed) {
      this.#recordCrash(stage);
      return STAGE_NOT_COMPLETED;
    }
    // DEF-250 の c: page を使うのをやめていれば、この段を始めない。
    if (this.#stopIfDocumentLeft(stage)) {
      return STAGE_NOT_COMPLETED;
    }
    let failure: { readonly error: unknown } | undefined;
    const run = (signals: ProgressSignals | null): Promise<StageAttempt<T>> => this.during(stage, () => work(signals)).then(
      (value): StageAttempt<T> => ({ ok: true, value }),
      (error: unknown): StageAttempt<T> => {
        failure = { error };
        return STAGE_NOT_COMPLETED;
      },
    );
    let settled: StageAttempt<T> | { readonly end: ProgressWatchEnd };
    // L1b: 見張りの中で実行した段階の処理（見張りが終えた後に、途中の記録を受け取るため）。
    let running: Promise<StageAttempt<T>> | undefined;
    if (!watched) {
      settled = await run(null);
    } else {
      // DEF-250 の c: 段を待つ間に page を使うのをやめたら、その段の待ちをやめる（段の処理は見放し、ビューポートの後片付けで Context と一緒に終わる）。
      const documentLeft = this.#documentLeftSignal();
      try {
        const watchedOutcome = await this.#watch((signals) => {
          running = run(signals);
          return Promise.race([
            running,
            this.#crashSignal.then((): StageAttempt<T> => STAGE_NOT_COMPLETED),
            documentLeft.left.then((): StageAttempt<T> => STAGE_NOT_COMPLETED),
          ]);
        });
        settled = watchedOutcome.status === 'FULFILLED'
          ? watchedOutcome.value
          : watchedOutcome.status === 'ENDED' ? { end: watchedOutcome.end } : STAGE_NOT_COMPLETED;
      } finally {
        documentLeft.stop();
      }
    }
    // DEF-250 の c: 段の間に page を使うのをやめていたら、その段は終わらなかったものとし、理由は 1 つ（`DOCUMENT_LEFT_DURING_AUDIT`）だけにする。
    if (!this.#crashed && this.#stopIfDocumentLeft(stage)) {
      return 'ok' in settled && settled.ok ? settled : STAGE_NOT_COMPLETED;
    }
    if (this.#crashed) {
      // 見放さない段階は、crash の後も、別の Context での結果を得る。その結果は記録する。
      this.#recordCrash(stage);
      return 'ok' in settled && settled.ok ? settled : STAGE_NOT_COMPLETED;
    }
    if ('end' in settled) {
      this.#recordWatchEnd(stage, settled.end);
      // L1b: 見張りの口だけを使う collector は、口の abort で、待たずに（同じ回りのうちに）それまでの記録を返す。その記録を Evidence に残す。返らない
      // 処理（口を使わない処理）は待たない。
      if (keepOnWatchEnd && running !== undefined) {
        const kept = await settledInThisTurn(running);
        if (kept !== null && kept.ok) {
          return { ok: true, value: kept.value, watchEnded: settled.end };
        }
      }
      return STAGE_NOT_COMPLETED;
    }
    if (settled.ok) {
      return settled;
    }
    const reason = failure === undefined || failureReason === undefined ? null : failureReason(failure.error);
    this.#reasons.push(collectorIncompleteReason(stage, reason ?? this.#view.failureReason()));
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

  /**
   * L1: 見張りが段階を終えた理由を記録する。応答しない・Run の時間の上限なら、それより後の段階を実行しない（静まらないなら続ける）。読み込みの段階
   * （`#auditViewport` が見張る）も、同じ決まりで記録するために使う。
   */
  recordWatchEnd(stage: PageAuditStage, end: ProgressWatchEnd): void {
    this.#recordWatchEnd(stage, end);
  }

  #recordWatchEnd(stage: PageAuditStage, end: ProgressWatchEnd): void {
    this.#lastWatchEnd = end;
    this.#reasons.push(progressWatchEndReason(stage, end));
    if (end !== 'STAGE_NEVER_QUIET') {
      this.#stopped = true;
    }
  }

  /**
   * DEF-250 の c: page を使うのをやめる原因を読む口を付ける（`auditDocumentLeftCause`。main frame の外部スキームへの移動の記録・文書の消失）。付けた後は、
   * 段を始める前と、段を待つ間（確かめの間隔ごと）に見て、原因があれば、残りの段を始めずにビューポートを終える（理由 `DOCUMENT_LEFT_DURING_AUDIT`。
   * それまでの段の記録は残る）。REV-SD の I-1: 原因が点検の範囲の外への移動（`OUTSIDE_AUDIT_SCOPE_CAUSE`）なら、残りの段を止めるだけで、理由は残さない
   * （ビューポートの終わりに、読み込みの失敗 `BLOCKED_EXTERNAL_REDIRECT` として残す）。
   */
  watchDocument(cause: () => AuditDocumentLeftCause | typeof OUTSIDE_AUDIT_SCOPE_CAUSE | null): void {
    this.#documentLeftCause = cause;
  }

  /** DEF-250 の c: 文書を使うのをやめたことで、ビューポートを終えたか。 */
  get documentLeft(): boolean {
    return this.#documentLeftRecorded;
  }

  /** DEF-250 の c: 原因があれば、理由を 1 回だけ記録し、残りの段を止めて、真を返す。 */
  #stopIfDocumentLeft(stage: PageAuditStage): boolean {
    const cause = this.#documentLeftCause?.() ?? null;
    if (cause === null) {
      return false;
    }
    if (cause !== OUTSIDE_AUDIT_SCOPE_CAUSE && !this.#documentLeftRecorded) {
      this.#documentLeftRecorded = true;
      this.#reasons.push(Object.freeze({ code: DOCUMENT_LEFT_DURING_AUDIT_CODE, detail: `${stage}:${cause}` }));
    }
    this.#stopped = true;
    return true;
  }

  /** DEF-250 の c: 段を待つ間、確かめの間隔ごとに原因を見て、あれば解決する約束と、見るのをやめる口。口がなければ解決しない。 */
  #documentLeftSignal(): { readonly left: Promise<void>; readonly stop: () => void } {
    const read = this.#documentLeftCause;
    if (read === null) {
      return { left: new Promise<void>(() => undefined), stop: () => undefined };
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const left = new Promise<void>((resolve) => {
      timer = setInterval(() => {
        if (read() !== null) {
          resolve();
        }
      }, PAGE_SETTLING_PACING.pollIntervalMs);
    });
    return { left, stop: () => clearInterval(timer) };
  }
}

/** DEF-250 の c: 点検の途中で page を使うのをやめた理由のコード。 */
const DOCUMENT_LEFT_DURING_AUDIT_CODE: Extract<IncompleteReasonCode, 'DOCUMENT_LEFT_DURING_AUDIT'> = 'DOCUMENT_LEFT_DURING_AUDIT';

/**
 * L1b: `work` が、今の回り（Node の待ちの行列の 1 回り。`setImmediate` の前）のうちに終わっていれば、その結果を返す。終わっていなければ `null`（待たない）。
 * 時間の期限ではなく、abort の後に同期の続きで返る collector の記録を受け取るための確かめ。
 */
async function settledInThisTurn<R>(work: Promise<R>): Promise<R | null> {
  return Promise.race([work, new Promise<null>((resolve) => {
    setImmediate(() => resolve(null));
  })]);
}

/** L1: 幅の走査の結果（幅ごとの Evidence の並び）。 */
type StressSweepResults = NonNullable<EvidencePayloadByType['layout']['stressSweep']>;

/** L1: 見張る段階（`StageRunner.attempt` の `watched`）が受け取る、進みの印の口（見張る段階では必ずある）。 */
/**
 * EV-2: layout の事実から、対象まで動かして撮る対象（判定は `revealTargetsOfLayout` の 1 か所）。layout がない・事実の形が壊れていて選べないときは、空（動かさない。
 * 撮れなかった指摘は、画像の参照の側で保留の理由になる）。
 */
function revealTargetsOf(layout: LayoutEvidence | null, primary: boolean): readonly RevealTargetSpec[] {
  if (layout === null) {
    return [];
  }
  try {
    return revealTargetsOfLayout(layout, primary);
  } catch {
    return [];
  }
}

/** EV-4: axe の `scrollable-region-focusable` の要素（キーボードの実操作を試す領域。axe の要素の順）。axe を流さなかったら空。 */
function scrollableRegionTargetsOf(accessibility: EvidencePayloadByType['accessibility'] | null): readonly ScrollableRegionTarget[] {
  return (accessibility?.violations ?? [])
    .filter(({ ruleId }) => ruleId === SCROLLABLE_REGION_AXE_RULE_ID)
    .flatMap(({ nodes }) => nodes.map(({ targetSelectors }) => ({ targetSelectors })));
}

function signalsOf(signals: ProgressSignals | null): ProgressSignals {
  if (signals === null) {
    throw new TypeError('a watched stage needs the progress signals');
  }
  return signals;
}

/** Node 側に集めた collector の記録を読む。失敗は `StageRunner.attempt` と同じ形で記録する。crash とも期限とも競わせない。 */
async function snapshotCollector<TEvidence>(
  stage: PageAuditStage,
  view: Pick<AuditView, 'failureReason'>,
  reasons: IncompleteReason[],
  handle: CollectorHandle<TEvidence>,
): Promise<StageAttempt<TEvidence>> {
  try {
    return { ok: true, value: await handle.snapshot() };
  } catch {
    reasons.push(collectorIncompleteReason(stage, view.failureReason()));
    return STAGE_NOT_COMPLETED;
  }
}

/** AUD-2b: network の collector がないときのデータの要求の数（データの条件は満たしたものとして扱う）。 */
const NO_DATA_ACTIVITY: DataRequestActivity = Object.freeze({ inFlight: 0, events: 0, endpoints: Object.freeze({ inFlight: [], completed: [] }) });

/** AUD-2a: 安定の判定の段の結果から、ビューポートの記録を作る。段を終えられなければ `NOT_COMPLETED`（見張りが終えたなら、その理由）。 */
function settlingRecordOf(
  settling: StageAttempt<PageSettlingResult>,
  elapsedMs: number,
  watchEnd: ProgressWatchEnd | null,
): ViewportSettlingRecord {
  if (!settling.ok) {
    return Object.freeze({ status: 'NOT_COMPLETED', reason: null, elapsedMs, observationCount: 0, lastScrollHeight: null, watchEnd });
  }
  const { observations, loadPhases } = settling.value;
  return Object.freeze({
    status: settling.value.status,
    reason: settling.value.reason,
    elapsedMs,
    observationCount: observations.length,
    lastScrollHeight: observations.at(-1)?.scrollHeight ?? null,
    watchEnd: settling.watchEnded ?? null,
    // AUD-2b: 読み込みの段の移り変わり（時刻は ISO 8601）。
    ...(loadPhases === undefined
      ? {}
      : { loadPhases: Object.freeze(loadPhases.map(({ phase, observedAtMs }) => Object.freeze({ phase, at: new Date(observedAtMs).toISOString() }))) }),
  });
}

/** AUD-2a: 主の読み込みの通知の枠の事実から、扱いの記録を作る（枠がなければ 0 と空）。 */
function notificationHandlingRecordOf(overlay: NotificationOverlayEvidence | null): ViewportNotificationHandlingRecord {
  const frames = overlay?.frames ?? [];
  return Object.freeze({
    dismissedCount: frames.filter((frame) => frame.dismissed).length,
    hiddenCount: frames.filter((frame) => frame.hidden).length,
    digests: Object.freeze(frames.map((frame) => frame.digest)),
  });
}

/** AUD-4: 状態の画像の印で矩形を読み直す、直前の layout の対象（layout がなければ `undefined`。読み直さない）。 */
const markTargetsOf = (layout: LayoutEvidence | null | undefined): readonly string[] | undefined =>
  (layout === null || layout === undefined ? undefined : stateMarkTargetSelectorsOf(layout));

/** AUD-4: 通知の枠の事実の、隠した枠の数（事実がなければ 0）。 */
const hiddenFrameCountOf = (overlay: NotificationOverlayEvidence | null | undefined): number => overlay?.frames.filter((frame) => frame.hidden).length ?? 0;

/**
 * AUD-4（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 7.2 の 1）: 状態の印に、今の記録の隠した通知の枠の数を足す（印がなければそのまま）。
 * layout と状態の画像の Evidence が使う。
 */
function withHiddenFrameCount<T extends { readonly stateMark?: EvidenceStateMark }>(value: T, count: number): T {
  return value.stateMark === undefined ? value : Object.freeze({ ...value, stateMark: Object.freeze({ ...value.stateMark, hiddenNotificationFrameCount: count }) });
}

/** AUD-4: layout の収集の結果（幅の結果を含む）の layout の状態の印に、隠した通知の枠の数を足す（layout か印がなければそのまま）。 */
function layoutResultWithHiddenFrameCount<T extends { readonly layout: LayoutEvidence | null }>(result: T, count: number): T {
  const { layout } = result;
  return layout?.stateMark === undefined ? result : Object.freeze({ ...result, layout: withHiddenFrameCount(layout, count) });
}

/** S-03a: 幅の走査で隠した枠の数（digest で数える）を、主の読み込みの数と分けて足す（幅の走査で枠を見なければ足さない）。 */
function withStressHiddenCount(
  record: ViewportNotificationHandlingRecord,
  stress: readonly StressNotificationOverlayEvidence[],
): ViewportNotificationHandlingRecord {
  if (stress.length === 0) {
    return record;
  }
  const hidden = new Set(stress.flatMap(({ overlay }) => overlay.frames.filter((frame) => frame.hidden).map((frame) => frame.digest)));
  return Object.freeze({ ...record, stressHiddenCount: hidden.size });
}

/** AUD-2a: 段を終えたときの main frame の URL と、文書のスクロールの位置。 */
export interface CaptureLocation {
  readonly url: string | null;
  readonly scrollPosition: EvidenceCaptureScrollPosition | null;
}

/**
 * AUD-2a: 段を終えたときの URL と位置を読む（読むだけ。ページの通信は出さない）。読めなければ、その値を `null` にする（例外を投げない）。
 */
async function captureLocationOf(page: Page): Promise<CaptureLocation> {
  let url: string | null;
  try {
    url = page.url();
  } catch {
    url = null;
  }
  let scrollPosition: EvidenceCaptureScrollPosition | null;
  try {
    const read: unknown = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    scrollPosition = isRecord(read) && typeof read.x === 'number' && typeof read.y === 'number' ? Object.freeze({ x: read.x, y: read.y }) : null;
  } catch {
    scrollPosition = null;
  }
  return Object.freeze({ url, scrollPosition });
}

/**
 * L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14）: 利用者が期限を指定していないときに、Interaction の部品（`auditInteraction`。
 * `src/interaction/isolated-auditor.ts`）に渡す、部品の中の期限（ms）。部品は正の整数を求めるので、前の値を名前つきで渡す。部品の中の期限の撤廃は L5
 * （表 A の T11・T21）。設定の `crawl.navigationTimeoutMs`・`crawl.interactionTimeoutMs` を指定したときは、その値を渡す。
 */
const INTERACTION_COMPONENT_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * L5（設計者の判断 2026-11-10）: 利用者が `crawl.interactionTimeoutMs` を指定していないときの、Interaction の後片付け（owner の close）の期限（ms）。BeakSight
 * 自身の処理の守り（Safety Ledger の不変条件の違反に結び付く）なので、操作の期限から切り離して残す（値は前の操作の期限の既定と同じ）。
 */
export const INTERACTION_CLEANUP_TIMEOUT_MS = 3_000;

/** Interaction の部品に渡す期限（`openEnded` は、利用者が操作の期限を指定していない＝期限を置かず、L0 の進みの見張りで終える）。 */
export interface InteractionTimeouts {
  readonly openEnded: boolean;
  readonly navigationTimeoutMs: number;
  readonly timeoutMs: number;
  readonly cleanupTimeoutMs: number;
}

/**
 * Interaction の部品に渡す期限（読み込み・操作・後片付け）。L5（INV-LIMITS の表 A の T11・T21）: 利用者が `crawl.interactionTimeoutMs` を指定していないときは、
 * 操作と読み込みの期限を置かない（`OPEN_ENDED_STAGE_MS`。読み込みは `crawl.navigationTimeoutMs` を指定していればその値）。後片付けは `INTERACTION_CLEANUP_TIMEOUT_MS`。
 * 指定したときは、今までどおりその値で終える（後片付けも同じ値）。
 */
export function interactionTimeoutsOf(config: AuditConfig): InteractionTimeouts {
  const { interactionTimeoutMs, navigationTimeoutMs } = config.crawl;
  if (interactionTimeoutMs === undefined) {
    return {
      openEnded: true,
      navigationTimeoutMs: navigationTimeoutMs ?? OPEN_ENDED_STAGE_MS,
      timeoutMs: OPEN_ENDED_STAGE_MS,
      cleanupTimeoutMs: INTERACTION_CLEANUP_TIMEOUT_MS,
    };
  }
  return {
    openEnded: false,
    navigationTimeoutMs: navigationTimeoutMs ?? INTERACTION_COMPONENT_NAVIGATION_TIMEOUT_MS,
    timeoutMs: interactionTimeoutMs,
    cleanupTimeoutMs: interactionTimeoutMs,
  };
}

/**
 * 幅の走査で調べる幅。設定の `stressWidths`（この順）に、L14 で media query の境目の両側の幅（`breakpointWidths`。小さい順。設定にある幅は重ねない）を
 * 足し、主要な2つのビューポートの幅を除く（設計書 4.5.6）。SWR: 広い順に並べる（狭い幅で開いた枠を、広い幅へ持ち越さない）。
 */
function stressSweepWidths(config: AuditConfig, breakpointWidths: readonly number[]): readonly number[] {
  const primaryWidths = new Set(VIEWPORT_PROFILES.map((profile) => viewportSizeFor(config, profile).width));
  const widths = [...new Set([...config.viewports.stressWidths, ...breakpointWidths])];
  return widths.filter((width) => !primaryWidths.has(width)).sort((left, right) => right - left);
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
  revisitIndex: number | null,
): ScreenshotCapturePaths {
  const capture = (captureType: ScreenshotCaptureType): ScreenshotCapturePaths['viewportCapture'] => {
    const relativeArtifactPath = screenshotRelativePath(pageId, profile, captureType, retryAttempt, null, false, null, null, null, revisitIndex);
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
 * 始めなかったビューポートの結果。違反を検出した後（理由 `SAFETY_VIOLATION_ABORT`。Task 19 の前の整理の設計書 4.5。C18f）と、
 * サイトの不調を検知した後（理由 `SITE_UNAVAILABLE`。サイトが応答しないときに Run を止める設計書 3.1）に使う。どちらも `detail` は
 * `null`。状態は `SKIPPED` で、Evidence、Finding、Safety の記録はない。
 * ビューポートの結果の形は、監査しなかった URL の結果（`skippedPageResult`）と同じものを使う。
 */
function skippedViewportOutcome(
  url: NormalizedHttpUrlEvidence,
  pageId: PageId,
  profile: ViewportProfile,
  reason: IncompleteReason,
): ViewportAuditOutcome {
  return {
    result: skippedPageResult(url, pageId, reason).viewports[profile],
    evidence: [],
    findings: [],
    safety: { passiveLedgers: [], interactionSnapshots: [], stressLedgers: [], pacingWaits: new Map() },
    siteUnavailability: null,
    authSessionLostStage: null,
    authSessionLoss: null,
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
 * `ContextConstructionError` の場合は、元の原因（`cause`）のメッセージも、`<メッセージ>: <原因のメッセージ>` の形で含める（LZ-2: 切り詰めない）（R14r2 の Minor-1。エラー自体のメッセージは固定の文言で、原因を表さないため）。
 */
function sessionFailureReason(label: string, error: unknown): IncompleteReason {
  const message = error instanceof ContextConstructionError
    ? `${safeErrorMessage(error)}: ${safeErrorMessage(error.cause)}`
    : error;
  return unhandledFailureReason(label, message);
}

/**
 * 閉じる処理の失敗を、場面（`contextCloseLabel`）の `UNHANDLED_FAILURE` の理由にする。失敗は Context を閉じる処理のものだけ（page は個別に
 * 閉じない。DEF-038。CCX-21 で page の場面の名前を消した）。
 */
function closeFailureReasons(
  failures: readonly PassiveSessionCloseFailure[],
  contextCloseLabel: ContextCloseLabel = SESSION_FAILURE_LABELS.contextClose,
): IncompleteReason[] {
  return failures.map(({ error }) => sessionFailureReason(contextCloseLabel, error));
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
