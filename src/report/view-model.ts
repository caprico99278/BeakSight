/**
 * 表示用モデルと表示用の集計の唯一の owner（UI追補設計書 第4章、4.2。Task 14〜17 の設計書 6.1.3、6.1.4）。
 * - 確定した Run（`AuditRunResult`。最終の Run Status のもの。`ArtifactWriter.writeRun` の戻り値の `result`）から、
 *   HTML レポート、ChatGPT 用バンドル、CLI の要約が使う1つのモデルを、1回だけ組み立てる。モデルは深く凍結する。
 * - 判定しない。Run Status は `RunSummary.runStatus` を、ページの件数は `RunSummary` の件数を、そのまま使う。新しい Finding や
 *   severity は作らない。
 * - Finding の件数と一覧の出どころは、`AuditRunResult.findings` の1つだけ（`PageAuditResult.findings` は使わない）。
 * - Finding を severity や category で数えたり分けたりする処理（表示用の集計）は、このファイルだけで行う（GATE-UI04）。T44i（Task 44 の設計書 6 章の
 *   2026-10-22 の行）: category の別・Rule の別の件数と、Rule ごとの要約（`ruleDigests`）も、ここだけで数える（ChatGPT 用バンドルは描くだけ）。
 * - ラベルと順は、カタログ（`src/presentation/catalog.ts`）から取る。モデルには値（severity や状態の値そのもの）を入れ、
 *   日本語のラベルは入れない（ラベルは、描画する側がカタログで引く）。理由の説明だけは、`messages.ts` の説明を入れる。
 * - 状態や severity の値の文字列を、直接書かない（GATE-UI01）。
 * - Evidence の場所（`page.json` と、その中の JSON Pointer）とスクリーンショットのパスは、Run のディレクトリからの相対パスで持つ。
 *   配置は、配置の owner（`src/core/artifact-layout.ts`。設計書 6.1.8）から取る。スクリーンショットのパスは、Page Auditor がその
 *   owner の関数で組み立てて Evidence に記録したもの（`ScreenshotEvidence.relativePath`）を、そのまま使う。
 * - スクリーンショットと Finding の関係づけ（設計書 6.1.8）は、`relateScreenshotsToFindings` の1か所で行う。
 * - Interaction と Safety の事象は、Evidence の場所（`location`）を持つ。場所は、Finding の Evidence の参照と同じ対応（同じ ID が
 *   2か所にある不正な Run では、先にあるもの）から付ける。描画する側は、ID から場所を引き直さない（設計書 6.1.10）。
 * - Safety の事象の一覧（`safety.events`）は、各ページの Safety の Evidence の記録を並べるだけで、Run Status や件数の判定には使わない。
 * - モデルは、入力のオブジェクトを参照せず、写しを持つ（入力を凍結したり、変えたりしない）。
 * - PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）: 報告の冒頭のまとめの段と、作業の画面が読む小さなまとめ（`report-summary.json`）の値
 *   （`overview`。大事な問題、見たページの数、見られなかった理由）も、ここだけで作る。
 * - MEM-4（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章）: 組み立ては、ページを 1 回だけ順になめる（`createReportViewModelAssembly`）。
 *   ページの置き場所（`RunPageStore`）の Run も、配列の Run と同じ値になる（`buildPublishedReportViewModel`）。Evidence の記録そのものは持たず、表示に要る値と、
 *   指摘ごとに先に引いた小さな値だけを持つ。
 */
import { rulePlainMessageOf } from '../audit/cross-page-rules.js';
import {
  FIXED_OCCLUSION_RULE_ID,
  FIXED_OVERLAP_CLASSES,
  OVERSIZED_FIXED_ELEMENT_RULE_ID,
  fixedOverlapOfFinding,
  fixedOverlapsNotCountedOf,
  type FixedOverlapFindingView,
  type FixedOverlapNotCountedEntry,
} from '../audit/fixed-overlap-classes.js';
import { FOCUS_CHECK_OUTCOMES, focusCheckOutcomeOf, type FocusCheckOutcome } from '../audit/focus-check.js';
import { LABEL_IN_NAME_RULE_ID, labelInNameOfFinding, type LabelInNameFindingView } from '../audit/label-in-name.js';
import {
  createHttpErrorCollector,
  type HttpErrorCollector,
  type HttpErrorFindingView,
  type HttpErrorsNotCountedView,
} from './http-error-view.js';
import { createLinkChecksCollector, type LinkChecksView } from './link-checks.js';
import { performanceObservationsOfPage, type PerformanceObservationView } from './performance-observations.js';
import { ruleVerificationBasisOf, type RuleVerificationBasis } from '../audit/rule-verification-basis.js';
import { pageArtifactRelativePath } from '../core/artifact-layout.js';
import { DEFAULT_AUDIT_SEND_POLICY, hasAuditSendWebSocketCaution } from '../core/audit-send-policy.js';
import { BEAKSIGHT_BLOCK_RELATIONS, type BeakSightBlockRelation } from '../core/beaksight-block-relation.js';
import {
  FINDING_CATEGORIES,
  INTERACTION_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type CrawlLimitState,
  type EvidenceId,
  type EvidenceRecord,
  type EvidenceType,
  type Finding,
  type FindingCategory,
  type FindingId,
  type IncompleteReason,
  type IncompleteReasonCode,
  type InteractionStatus,
  type ObservationStatus,
  type PageAuditResult,
  type PageAuditStatus,
  type PageId,
  type RecheckState,
  type RunEnvironment,
  type RunExecution,
  type RunExecutionEndReason,
  type RunAuditSendSummary,
  type RunId,
  type RunLoad,
  type RunSafetySummary,
  type RunStatus,
  type RunSummary,
  type Severity,
  type ViewportProfile,
} from '../core/contracts.js';
import type { RunPageScopeRecord } from '../core/audit-page-scope.js';
import {
  INTERACTION_NOT_VERIFIABLE_KINDS,
  SAFETY_EVENT_KINDS,
  type BlockedEventPhase,
  type InteractionNotVerifiableKind,
  type InteractionReasonCode,
  type NavigationOutcomeKind,
  type OpenedStateStatus,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type SafetyEvidenceScope,
  type ScreenshotCaptureType,
  type WebVitalsEvidence,
} from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';
import { REPORT_RULE_DIGEST_EXAMPLE_COUNT } from '../core/limits.js';
import { lastRunExecutionOf } from '../core/run-executions.js';
import { forEachRunPage, type RunPages } from '../core/run-page-store.js';
import { compareCodeUnits } from '../core/text.js';
import {
  AUDIT_SEND_POLICY_CATALOG,
  FINDING_CATEGORY_CATALOG,
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_CATEGORY_SECTIONS,
  SEVERITY_CATALOG,
  SEVERITY_GROUPS,
  VIEWPORT_PROFILE_CATALOG,
  findingCategoriesInSection,
  severitiesInGroup,
  sortByDisplayOrder,
  type ReportCategorySection,
  type SeverityGroup,
} from '../presentation/catalog.js';
import {
  FINDING_UNVERIFIED_NEXT_STEP_TEXT,
  describeIncompleteReason,
  describeInteractionReason,
  nextStepOfIncompleteReason,
} from '../presentation/messages.js';
import {
  artifactReferenceDraftsOfPage,
  buildArtifactReferences,
  missingArtifactReferencePaths,
  type ArtifactFileExists,
  type ArtifactReferenceDraft,
  type ArtifactReferenceView,
} from './artifact-references.js';
import { earlierAttemptEvidenceIds, retryRecordsOf, visibleTextOf } from './artifact-writer.js';
import {
  buildFindingGroups,
  structureInAccessibilityRecord,
  structureTargetOf,
  type FindingGroupView,
  type FindingStructureView,
} from './finding-groups.js';
import { isUncollectedAuditStatus } from '../core/status.js';
import {
  createFindingImageRegionCollector,
  FINDING_HOLD_REASONS,
  type FindingHoldReason,
  type FindingImageRegionView,
} from '../core/finding-image-regions.js';
import {
  beaksightBlockRelationOf,
  createBeakSightBlockIndexBuilder,
  safetyBlockPhaseCountsOf,
  type BeakSightBlockIndexBuilder,
  type BeakSightBlockRelationView,
} from './beaksight-block-relation.js';

export type { BeakSightBlockRefView, BeakSightBlockRelationView } from './beaksight-block-relation.js';
export type { ArtifactReferenceView } from './artifact-references.js';
export type { FindingGroupView } from './finding-groups.js';

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/**
 * 理由の表示（コード、詳細、日本語の説明）。`TCode` は理由のコードの型で、既定は未完了の理由（`IncompleteReasonCode`）。
 * `description` は、理由のコードの日本語の説明（`messages.ts` の `describeIncompleteReason`、`describeInteractionReason`）。
 * `detail` は、技術的な詳細のまま（Interaction では Evidence の `reasonDetail`）。
 */
export interface ReasonView<TCode extends string = IncompleteReasonCode> {
  readonly code: TCode;
  readonly detail: string | null;
  readonly description: string;
  /**
   * T44c（Task 44 の設計書 P1-4）: 次にできること（`messages.ts` の `nextStepOfIncompleteReason`。示せない理由と、Interaction の理由は `null`）。
   */
  readonly nextStep: string | null;
}

/**
 * Finding の件数。`total` は全件、`bySeverity` は severity ごと（キーは `SEVERITIES` の順）、`byGroup` はサイト品質と Safety の区分ごと
 * （区分は `SEVERITY_CATALOG` の `group`。上位の設計書 13章）。
 */
export interface SeverityCountsView {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byGroup: Readonly<Record<SeverityGroup, number>>;
}

/** T44i: category の別の件数の 1 件（`RunSummaryView.findingCountsByCategory`）。 */
export interface CategoryCountView {
  readonly category: FindingCategory;
  readonly count: number;
}

/** T44i: Rule の別の件数の 1 件（`RunSummaryView.findingCountsByRule`）。`category` は、その Rule の最初の Finding の category。 */
export interface RuleCountView {
  readonly ruleId: string;
  readonly category: FindingCategory;
  readonly count: number;
}

/**
 * T44i: Rule ごとの要約の例の 1 件（Finding の一部の写し）。`message` は Rule の文のまま。`screenshots` は、その Finding のスクリーンショット
 * （`FindingView.screenshots` と同じ。撮り方を問わない。ChatGPT 用バンドルは、入れる撮り方のものだけのパスを書く）。
 */
export interface RuleDigestExampleView {
  readonly findingId: FindingId;
  readonly pageId: PageId | null;
  readonly viewport: ViewportProfile | null;
  readonly message: string;
  readonly screenshots: readonly ScreenshotView[];
}

/**
 * T44i（Task 44 の設計書 6 章の 2026-10-22 の行。P2-9）: Rule ごとの要約（`ReportViewModel.ruleDigests`）。同じ指摘がページごとに並ぶので、全体の傾向を
 * Rule の単位で見るためのもの。数えるのは、このファイルだけである（ChatGPT 用バンドルは描くだけ）。
 */
export interface RuleDigestView {
  readonly ruleId: string;
  /** その Rule の最初の Finding の category。 */
  readonly category: FindingCategory;
  /** severity ごとの件数（キーは `SEVERITIES` の順。0 件の severity も含む）。 */
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly count: number;
  /** 出たページの数（違う `pageId` の数。ページによらない Finding は数えない）。 */
  readonly pageCount: number;
  /** ビューポートごとの件数（キーはビューポートの表示の順。0 件のビューポートも含む）。 */
  readonly byViewport: Readonly<Record<ViewportProfile, number>>;
  /** ビューポートによらない Finding（`viewport` が `null`）の件数。 */
  readonly viewportIndependentCount: number;
  /**
   * BN-d: BeakSight の遮断との関係の区分の別の件数（キーは `BEAKSIGHT_BLOCK_RELATIONS` の順。0 件の区分も含む）。SAFETY の Finding は区分の外なので、どの区分にも
   * 数えない。
   */
  readonly byBlockRelation: Readonly<Record<BeakSightBlockRelation, number>>;
  /**
   * 例（`AuditRunResult.findings` の順で、ページの違うものを先に、`REPORT_RULE_DIGEST_EXAMPLE_COUNT` 件まで。足りなければ、残りを同じ順で足す）。
   */
  readonly examples: readonly RuleDigestExampleView[];
  /** AUD-9b: この要約の指摘が入る候補群の数と ID（`findingGroups` の `groupId`。指摘の順に、最初に出た順）。 */
  readonly groupCount: number;
  readonly groupIds: readonly string[];
}

/** ページの網羅（`RunSummary` の件数のまま。数え直さない）。 */
export interface PageCoverageView {
  readonly discovered: number;
  readonly audited: number;
  readonly partial: number;
  readonly failed: number;
  readonly skipped: number;
}

/** 上限の設定（`effectiveConfig.crawl`）と、到達したか（`RunSummary.crawlLimits`）。 */
export interface RunLimitsView {
  /** L14: 3 つとも、利用者が指定したときだけ（ないときは上限なし。表示は「指定なし」）。 */
  readonly maxPages: number | undefined;
  readonly maxDepth: number | undefined;
  readonly maxRuntimeMs: number | undefined;
  readonly reached: CrawlLimitState;
}

/**
 * 実行（起動）の記録（`RunSummary.executions`。中断した Run の再開の設計書 4.8 の「表示」。R6）。回数は、このモデルの組み立ての中で
 * 1回だけ数える。HTML レポートの「実行の記録」、CLI の実行の行、`summary.json` は、この値を使い、数え直さない。
 */
export interface RunExecutionsView {
  /** 実行の回数（`items` の件数）。 */
  readonly count: number;
  /** 再開の回数（最初の実行の後の、実行の数。`count - 1`）。 */
  readonly resumeCount: number;
  /**
   * この起動の終わり方（`items` の最後の実行の終わり方。中断した Run の再開の設計書 4.8 の 2026-10-08 の追補。R9）。`items` は1件以上
   * なので、`null` にならない。どの実行の終わり方かは、ここで1回だけ決める。CLI の結果の「この起動の終わり方」の行は、この値を
   * 表示カタログで引くだけにし、`summary.json` には、コードのまま出る。
   */
  readonly lastEndReason: RunExecutionEndReason;
  /**
   * 最後の実行の終わりの時刻（`items` の最後の実行の `finishedAt`。CCX-19。CC-048）。ChatGPT 用バンドルの名前を決める時刻で、CLI の結果の
   * バンドルの行と、バンドルを書くときの名前の両方が、この値を使う（どの実行かは、`lastEndReason` と同じく、ここで 1 回だけ決める）。
   */
  readonly lastFinishedAt: string;
  /** 実行の記録の値の写し（`RunSummary.executions` の順のまま）。終わり方のラベルと説明は、描画する側がカタログで引く。 */
  readonly items: readonly [RunExecution, ...RunExecution[]];
}

/**
 * サイトの不調で止めたこと（サイトが応答しないときに Run を止める設計書 3.4。SU4）。CLI の結果の、止めたことと再開のしかたの1行が使う。
 */
export interface SiteUnavailableStopView {
  /**
   * Run の理由のうち、コード `SITE_UNAVAILABLE` の最初のものの `detail`（最初に検知した失敗の技術的な詳細のまま。例:
   * `desktop:passive:TIMEOUT`）。その理由がなければ `null`。
   */
  readonly detail: string | null;
}

/**
 * BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: 本体の Finding（BeakSight の遮断と結び付かない `NONE` のサイト品質）と、外した
 * Finding（`CAUSED`・`POSSIBLE`・SAFETY）の件数（`RunSummaryView.beaksightBlockRelation`）。数えるのは表示用モデルだけ。
 */
/** AUD-2d: 確かめ直しの印の別の、Finding の件数（`FindingVerificationView.recheck` で数える。数えるのは表示用モデルだけ）。 */
export interface RecheckSummaryView {
  readonly byMark: Readonly<Record<FindingRecheckMark, number>>;
  /** 本体から分けた、初めの表示だけの Finding の件数（`initialOnlyFindings`）。 */
  readonly initialOnlyFindingCounts: SeverityCountsView;
}

export interface BeakSightBlockRelationSummaryView {
  /** サイト品質の Finding の、区分の別の件数（キーは `BEAKSIGHT_BLOCK_RELATIONS` の順）。SAFETY の Finding は数えない。 */
  readonly byRelation: Readonly<Record<BeakSightBlockRelation, number>>;
  /** サイト品質の Finding のうち、BeakSight の遮断と結び付くもの（`CAUSED` と `POSSIBLE`）の件数。CLI の要約の行は、0 より大きいときだけ出す。 */
  readonly linkedFindingCount: number;
  /** 本体の Finding の件数（`NONE` のサイト品質）。 */
  readonly mainFindingCounts: SeverityCountsView;
  /** 外した Finding の件数（`CAUSED`・`POSSIBLE` のサイト品質と、SAFETY）。 */
  readonly excludedFindingCounts: SeverityCountsView;
}

/** 要約（設計書 6.1.4 の節1）。 */
/** AS-b: 監査の段の送信の扱いの表示（`RunSummaryView.auditSend`）。 */
export interface AuditSendView extends RunAuditSendSummary {
  /** 通したことを目立つ形で出すか（表示カタログの `prominent`）。 */
  readonly prominent: boolean;
  /** AS-c: ほかの Origin へ通した数（持たない Run は 0）。 */
  readonly passedOtherOriginRequests: number;
  /** AS-c: 通した WebSocket の接続の数（持たない Run は 0）。 */
  readonly passedWebSockets: number;
  /** AS-c fix round 1: そのうち Guard の route を通らずに開いた数と、危険な語に当たる数（持たない Run は 0）。 */
  readonly passedWebSocketsOutsideGuard: number;
  readonly passedDangerousWebSockets: number;
  /** AS-c fix round 1: その知らせを出すか（`hasAuditSendWebSocketCaution` の 1 か所で決める）。 */
  readonly webSocketCaution: boolean;
}

export interface RunSummaryView {
  readonly runId: RunId;
  /** `RunSummary.runStatus` のまま。 */
  readonly runStatus: RunStatus;
  readonly targetId: string;
  readonly toolVersion: string;
  readonly startUrl: string;
  /** 許可 Origin（URL をリンクにするかの判断に使う。設計書 6.1.6）。 */
  readonly allowedOrigins: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly coverage: PageCoverageView;
  /** サイト品質（ERROR、WARN、INFO）と Safety の件数。出どころは `AuditRunResult.findings` だけ。 */
  readonly findingCounts: SeverityCountsView;
  /** BN-d: 本体の Finding と外した Finding の件数と、区分の別の件数。 */
  readonly beaksightBlockRelation: BeakSightBlockRelationSummaryView;
  /** AUD-2d: 確かめ直しの印の別の件数（画面と HTML の本文は、初めの表示だけの件数だけを易しい文で出す）。 */
  readonly recheck: RecheckSummaryView;
  /**
   * T44i（Task 44 の設計書 6 章の 2026-10-22 の行。P2-9）: category の別の件数（`FINDING_CATEGORIES` の全部を、表示カタログの順に。0 件の category も含む）。
   */
  readonly findingCountsByCategory: readonly CategoryCountView[];
  /** T44i: Rule の別の件数（件数の多い順、同じ件数は `ruleId` の順（UTF-16 の符号単位の順））。 */
  readonly findingCountsByRule: readonly RuleCountView[];
  /** 安全の不変条件の違反の件数（`RunSafetySummary.invariantViolationCount`）。 */
  readonly safetyInvariantViolationCount: number;
  readonly limits: RunLimitsView;
  /**
   * サイトへの負荷の記録（`RunSummary.load` の写し。サイトへの負荷の制御の設計書 3.1 の7、4.5）。集計や計算をせず、記録の値のまま持つ。
   * HTML レポートの「サイトへの負荷」、CLI の負荷の行、`summary.json` は、この値を使う。
   */
  readonly load: RunLoad;
  /** 実行（起動）の記録と、実行の回数と、再開の回数（R6）。 */
  readonly executions: RunExecutionsView;
  /**
   * サイトの不調で止めたこと（サイトが応答しないときに Run を止める設計書 3.4）。実行の記録の最後の実行の終わり方が
   * `STOPPED_BY_SITE_UNAVAILABLE` のときだけ値を持ち、そうでなければ `null`（Run の理由ではなく、終わり方で決める）。出すかどうかは、
   * このモデルの組み立ての中で1回だけ決める。CLI の結果の行は、この値を使い、判断し直さない。
   */
  readonly siteUnavailableStop: SiteUnavailableStopView | null;
  /**
   * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 監査の段の送信の扱いと通した数（`run.json` の `safety.auditSend` の写し。持たない古い
   * Run は `READ_ONLY`・0 件）。`prominent`（通したことを目立つ形で出すか）は、表示カタログ（`AUDIT_SEND_POLICY_CATALOG`）から、ここで 1 回だけ決める。HTML・
   * CLI・`summary.json` は、この値を使い、数え直さない。
   */
  readonly auditSend: AuditSendView;
  /** Run の未完了の理由（`RunSummary.incompleteReasons` の順）。 */
  readonly incompleteReasons: readonly ReasonView[];
  readonly unverifiedInteractionCount: number;
  readonly unverifiedInternalLinkCount: number;
  /** AUD-6c: Web Vitals の観測の範囲（`webVitalsCoverageOf`）。合格の意味の値は持たない。 */
  readonly webVitalsCoverage: WebVitalsCoverageView;
  /** AUD-8: 色差の「測定できない」（axe の incomplete）の数と理由（`contrastUnmeasuredOf`）。「閾値未満」（violation）は数えない。バンドルにだけ出す。 */
  readonly contrastUnmeasured: ContrastUnmeasuredView;
  /**
   * AUD-3c: 固定の要素の重なりのうち、Finding にしなかった区分（幾何だけ・モーダル・スクロールで見える）の数（`fixedOverlapsNotCountedViewOf`。区分は
   * `src/audit/fixed-overlap-classes.ts` が決める）。バンドルにだけ出す。
   */
  readonly fixedOverlapsNotCounted: FixedOverlapsNotCountedView;
  /**
   * AUD-4c: http・https 以外の scheme のリンク（tel:・mailto: など）の件数と事実（`specialSchemeLinksOf`）。不具合として数えない（指摘にしない）。バンドルにだけ出す。
   */
  readonly specialSchemeLinks: SpecialSchemeLinksView;
  /** AUD-4d: フォーカスの確かめの数（確かめた要素の数と、結果ごとの数。結果は `focusCheckOutcomeOf` が決める）。バンドルにだけ出す。 */
  readonly focusChecks: FocusChecksView;
  /**
   * AUD-7: Finding にしなかった（正常の分岐 `EXPECTED_BRANCH`）4xx の応答の数と事実（`httpErrorsNotCountedOf`。区分は `src/audit/http-error-classes.ts` が
   * 決める）。バンドルにだけ出す。
   */
  readonly httpErrorsNotCounted: HttpErrorsNotCountedView;
  /** AUD-6c: 性能の値の観測の範囲（記録ごとの、測った段・観測の時間・測る前の操作・INP の状態・遅い指標と時間の内訳）。バンドルにだけ出す。 */
  readonly performanceObservations: readonly PerformanceObservationView[];
  /**
   * COV-4 の区切り 3: 見るだけの点検の操作で開いた状態の数（監査した・同じ構造の状態を前に監査したので監査しなかった・途中まで）と、開く前の画面と同じで除いた
   * 指摘の数（`openedStatesOf`）。バンドルにだけ出す。
   */
  readonly openedStates: OpenedStatesView;
  /**
   * 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しをまとめた記録の数と、その中の要求の数（`repeatedReadsOf`）。1 件ずつの記録は page.json に
   * 残らないので、数をバンドルに出す。
   */
  readonly repeatedReads: RepeatedReadsView;
  /**
   * EV-5（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.5）: 証拠の足り方の数（`evidenceSufficiencyOf`。ここで 1 回だけ数える）。確かめ直しで消えた数は
   * `recheck` にある。HTML・CLI・`summary.json` は、この値を描くだけ。
   */
  readonly evidenceSufficiency: EvidenceSufficiencyView;
  readonly environment: RunEnvironment;
}

/**
 * EV-5: 証拠の足り方の数。
 * - `heldFindingCount`・`heldByReason`: 確かめを待つ指摘（`imageRegion.holdReason` のある指摘）の数と、理由ごとの数（`FINDING_HOLD_REASONS` の全部。0 も含む）。
 * - `targetImageJudgedCount`・`targetInImageCount`: 画像に対象が入ったかを決めた指摘（`targetInImage` が `null` でない）の数と、そのうち全部写った（`INSIDE`）数
 *   （割合は、この 2 つの比）。
 * - `uncollectedPageCount`・`uncollectedViewportCount`: まだ見ていない（`SKIPPED`）ページとビューポートの数（見ていないページのビューポートも数える）。
 */
export interface EvidenceSufficiencyView {
  readonly heldFindingCount: number;
  readonly heldByReason: Readonly<Record<FindingHoldReason, number>>;
  readonly targetImageJudgedCount: number;
  readonly targetInImageCount: number;
  readonly uncollectedPageCount: number;
  readonly uncollectedViewportCount: number;
}

/** 設計者の判断 2026-11-11: まとめた記録の数、その中の要求の数（最初の 1 件を含む）、1 件ずつ記録しなかった要求の数（最初の 1 件を除く）。 */
export interface RepeatedReadsView {
  readonly groupCount: number;
  readonly requestCount: number;
  readonly unlistedRequestCount: number;
}

/** COV-4 の区切り 3: 開いた状態の数と、除いた指摘の数。 */
export interface OpenedStatesView {
  readonly audited: number;
  readonly sameStructureSeen: number;
  readonly partial: number;
  readonly duplicateFindingsDropped: number;
}

/** AUD-4d: フォーカスの確かめの数（結果ごと。`FOCUS_CHECK_OUTCOMES` の順。0 件の結果は持たない）。 */
export interface FocusChecksView {
  readonly checked: number;
  readonly byOutcome: readonly { readonly outcome: FocusCheckOutcome; readonly count: number }[];
}

/** AUD-4c: http・https 以外の scheme のリンクの件数（scheme ごと。scheme の順）と、リンクごとの事実（ページの順、ページの中はリンクの順）。 */
export interface SpecialSchemeLinksView {
  readonly total: number;
  readonly byScheme: readonly { readonly scheme: string; readonly count: number }[];
  readonly links: readonly { readonly pageId: PageId; readonly scheme: string; readonly rawUrl: string; readonly anchorText: string }[];
}

/** AUD-3c: Finding にしなかった固定の要素の重なりの数（覆いの Rule は組の数、大きすぎる固定要素の Rule は要素の数）と、Rule・区分ごとの数（Rule・区分の順）。 */
export interface FixedOverlapsNotCountedView {
  readonly total: number;
  readonly byClass: readonly FixedOverlapNotCountedEntry[];
}

/** AUD-8: 色差の「測定できない」の理由（axe の `messageKey`。なければ `null`）ごとの数。 */
export interface ContrastUnmeasuredReasonView {
  readonly messageKey: string | null;
  readonly count: number;
}

/** AUD-8: 色差の「測定できない」の数（要素の数）と、理由ごとの数（数の多い順、同じなら `messageKey` の順、`null` は最後）。 */
export interface ContrastUnmeasuredView {
  readonly nodeCount: number;
  readonly byReason: readonly ContrastUnmeasuredReasonView[];
}

/** 1つの Evidence の場所（Run のディレクトリからの相対パス）。 */
export interface EvidenceLocationView {
  readonly evidenceId: EvidenceId;
  readonly type: EvidenceType;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** その Evidence がある `page.json` の、Run のディレクトリからの相対パス（例: `pages/PAGE-000001/page.json`）。 */
  readonly path: string;
  /** `page.json` の中の場所（JSON Pointer。例: `/evidence/3`）。 */
  readonly pointer: string;
  /** 再試行の前の試行の Evidence なら、その試行の番号。最終の試行の Evidence（と metadata）なら `null`。 */
  readonly retryAttempt: number | null;
  /** この Evidence を `evidenceRefs` に持つ Finding の ID（`AuditRunResult.findings` の順）。 */
  readonly relatedFindingIds: readonly FindingId[];
}

/** Finding の Evidence の参照（`evidenceRefs` の順）。どのページにもない ID は、`location` が `null`。 */
export interface EvidenceRefView {
  readonly evidenceId: EvidenceId;
  readonly location: EvidenceLocationView | null;
}

/**
 * スクリーンショットの Evidence（`html-components.ts` の `ScreenshotRefInput` の形を含む）。`evidenceId` がスクリーンショットの ID
 * である。`relatedFindingIds` は、このスクリーンショットに関係づく Finding の ID（`AuditRunResult.findings` の順。重複なし）。
 * 関係づけの規則は、設計書 6.1.8（`relateScreenshotsToFindings`）:
 * - 最終の試行のスクリーンショットは、それを `evidenceRefs` で直接参照する Finding と、同じページ・同じビューポートの最終の試行の
 *   Evidence を参照する Finding に関係づく。
 * - 再試行の前の試行のスクリーンショットは、直接参照する Finding にだけ関係づく。
 */
export interface ScreenshotView {
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile;
  readonly captureType: ScreenshotCaptureType;
  /** Run のディレクトリからの相対パス（`ScreenshotEvidence.relativePath`）。 */
  readonly relativePath: string;
  readonly relatedFindingIds: readonly FindingId[];
  /** AUD-1c: 発表の前の確かめで、ファイルがなかったか（参照の一覧の `missing` と同じ値。確かめていない表示用モデルでは偽）。 */
  readonly missing: boolean;
  /** AUD-3d: 幅の走査の幅の viewport の画像なら、その幅（px）。主の画像は `null`。 */
  readonly stressWidth: number | null;
}

/** Finding（写し）と、その Evidence の参照（`evidenceRefs` の順）と、関係づくスクリーンショット。 */
export interface FindingView {
  readonly finding: Finding;
  /**
   * OP-R2（PL 設計書 14 章）: 報告の本文に出す、やさしい文。Finding の ruleId を持つ Rule の定義の文（`rulePlainMessageOf`。文を写さない）で、どの Rule も持たない
   * ruleId（前の版の Rule など）は、Rule の文（`finding.message`）のまま。ChatGPT 用バンドルには入れない。
   */
  readonly plainMessage: string;
  readonly evidence: readonly EvidenceRefView[];
  /**
   * この Finding に関係づくスクリーンショット（設計書 6.1.8。`ScreenshotView.relatedFindingIds` と同じ関係）。重複なし。
   * 直接参照するもの（`evidenceRefs` の順）が先で、その後に、同じページ・同じビューポートのもの（`evidenceRefs` の順に、
   * それぞれ `page.json` の中の順）。
   */
  readonly screenshots: readonly ScreenshotView[];
  /**
   * BN-c（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3）: BeakSight の遮断との関係（区分・理由・結び付いた遮断）。判定は
   * `src/report/beaksight-block-relation.ts` の 1 か所で、Finding ごとに 1 回だけ行う。SAFETY の Finding は区分の外なので `null`。
   */
  readonly beaksightBlockRelation: BeakSightBlockRelationView | null;
  /**
   * BN-R0 の M-3: SAFETY の Finding が数える止めた事象の、時点の別の件数（`CLOSING` は、閉じる途中とページを離れた後に止めたもの。測りの後）。サイト品質の Finding と、
   * 時点を持つ事象を数えない SAFETY の Rule は `null`。
   */
  readonly safetyBlockPhaseCounts: Readonly<Record<BlockedEventPhase, number>> | null;
  /**
   * AUD-6a: この指摘の検証の状態（`findingVerificationOf`。指摘ごとに 1 回だけ決める）。ChatGPT 用バンドルの `findings.json` は、これを写すだけ。HTML の本文には
   * 出さない（コードを見せない）。
   */
  readonly verification: FindingVerificationView;
  /**
   * AUD-3d: 指摘の画像の参照と、対象の領域の矩形（`findingImageRegionIndexOf` が決める。ページかビューポートによらない指摘は `null`）。バンドルは写すだけ。
   * HTML の本文は、易しい文で示す。
   */
  readonly imageRegion: FindingImageRegionView | null;
}

/** AUD-6a: 検証の根拠を確かめられなかった理由の閉じた一覧（参照する Evidence がどのページにもない、参照先のファイルが発表の前の確かめでなかった）。 */
export const FINDING_UNVERIFIED_REASONS = Object.freeze(['EVIDENCE_NOT_FOUND', 'EVIDENCE_FILE_MISSING'] as const);
export type FindingUnverifiedReason = (typeof FINDING_UNVERIFIED_REASONS)[number];

/**
 * AUD-6a: 指摘の検証の状態。`basis` は Rule の根拠（`ruleVerificationBasisOf`）。`status` は、証拠の参照に欠けがなければ `basis` と同じ、欠けがあれば
 * `UNVERIFIED`（`reason` に理由）。
 */
export interface FindingVerificationView {
  readonly status: RuleVerificationBasis | 'UNVERIFIED';
  readonly basis: RuleVerificationBasis;
  readonly reason: FindingUnverifiedReason | null;
  /**
   * AUD-2d: 落ち着いた後の確かめ直しの印（ビューポートの記録の `recheck` の表から、fingerprint で引く）。確かめ直さなかった指摘（axe でない指摘・前の Run・
   * 確かめ直しを終えられなかったビューポート）は `NOT_RECHECKED`。`INITIAL_ONLY` の指摘は、本体から分ける（`initialOnlyFindings`）。
   */
  readonly recheck: FindingRecheckMark;
  /**
   * AUD-3c: 固定の要素の重なりの区分（覆いの Rule と大きすぎる固定要素の Rule の指摘で、hit-test の事実がある Evidence のときだけ。区分は
   * `fixedOverlapOfFinding` が決める）。`renderDetermined` が偽（描画の遮蔽を決められない）の指摘は、候補群の確信度を 1 段下げる。
   */
  readonly overlap?: FixedOverlapFindingView;
  /**
   * AUD-4b: 名前の不一致の指摘の名前の文脈（AX の名前・命名元・見えるラベルのかたまり・主なラベルと補足・区分。区分は `labelInNameOfFinding` が決める）。名前の
   * 不一致の指摘で、AX を読めたときだけ。区分が主なラベルの欠け（`MAIN_LABEL_MISSING`）でなければ、候補群の確信度を 1 段下げる。
   */
  readonly labelInName?: LabelInNameFindingView;
  /**
   * AUD-7: 4xx・5xx の指摘の区分と、応答の事実（区分を持つ Rule の指摘で、応答の文脈が記録にあるときだけ。Rule の区分は `src/audit/http-error-classes.ts` が
   * 決め、BeakSight の遮断と結び付く指摘は `COLLECTION_CAUSED`）。`UNDETERMINED` の指摘は、候補群の確信度を 1 段下げる。
   */
  readonly httpError?: HttpErrorFindingView;
  /** AUD-6b: 検証できなかった指摘（`UNVERIFIED`）の、次に要る手順（やさしい文）。ほかの指摘は持たない。 */
  readonly nextStep?: string;
}

/**
 * AUD-2d: 指摘の確かめ直しの印。`LATE`（確かめ直しで新しく出た問題）も、見落とさないために本体の Finding にする（印で分かる）。
 */
export type FindingRecheckMark = RecheckState | 'NOT_RECHECKED';

/** AUD-6c: Web Vitals の 1 つの指標の、観測の範囲の数（performance の Evidence の数で数える）。 */
export interface WebVitalCoverageCountsView {
  readonly observed: number;
  /** 観測できなかった（例: 操作のない点検の INP）。良いという意味ではない。 */
  readonly notObserved: number;
  /** ブラウザが対応していない。 */
  readonly unsupported: number;
  /** Web Vitals を集められなかった Evidence。 */
  readonly notCollected: number;
}

/**
 * AUD-6c: Web Vitals の観測の範囲（最終の試行の performance の Evidence ごと）。`interpretation` は、未観測を合格と読ませないための印（値は 1 つだけ）。
 */
export interface WebVitalsCoverageView {
  readonly evidenceCount: number;
  readonly byMetric: Readonly<Record<keyof WebVitalsEvidence, WebVitalCoverageCountsView>>;
  readonly interpretation: 'UNOBSERVED_IS_NOT_PASSING';
}

/**
 * category の節（設計書 6.1.4 の節3。節の順はカタログの順）。`findings` は、severity の表示の順に並べる
 * （同じ severity は `AuditRunResult.findings` の順）。
 */
export interface FindingSectionView {
  readonly section: ReportCategorySection;
  /** 節に入る category（表示の順。`findingCategoriesInSection`）。 */
  readonly categories: readonly FindingCategory[];
  readonly findings: readonly FindingView[];
  readonly counts: SeverityCountsView;
}

/** ページのビューポートごとの状態（ビューポートの表示の順）。 */
export interface ViewportView {
  readonly viewport: ViewportProfile;
  readonly status: PageAuditStatus;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly httpStatus: number | null;
  readonly navigationOutcome: NavigationOutcomeKind | null;
  readonly incompleteReasons: readonly ReasonView[];
}

/** 再試行の前の試行の記録（`RunSummary.retries` の1件と、その試行の Evidence とスクリーンショット）。 */
export interface RetryAttemptView {
  readonly attempt: number;
  readonly navigationOutcome: NavigationOutcomeKind;
  readonly detail: string | null;
  readonly evidence: readonly EvidenceLocationView[];
  readonly screenshots: readonly ScreenshotView[];
}

/**
 * ページ（設計書 6.1.4 の節6。`AuditRunResult.pages` の順）。`screenshots` と `findings` は、最終の試行のもの。
 * 再試行の前の試行の記録は `retryAttempts` にある。`visibleTextPath` は、`visible-text.txt` を書かないページでは `null`。
 */
export interface PageView {
  readonly pageId: PageId;
  readonly pageUrl: string;
  readonly status: PageAuditStatus;
  readonly incompleteReasons: readonly ReasonView[];
  readonly viewports: readonly ViewportView[];
  readonly pageJsonPath: string;
  readonly visibleTextPath: string | null;
  readonly screenshots: readonly ScreenshotView[];
  /** `AuditRunResult.findings` を `pageId` で絞ったもの（`PageAuditResult.findings` は使わない）。 */
  readonly findings: readonly FindingView[];
  readonly findingCounts: SeverityCountsView;
  /** BN-d: このページの本体の Finding の ID と、外した Finding の ID（`AuditRunResult.findings` の順）と、それぞれの件数。 */
  readonly mainFindingIds: readonly FindingId[];
  readonly excludedFindingIds: readonly FindingId[];
  /** AUD-2d: 初めの表示だけの Finding の ID（本体と外した Finding のどちらにも入らない）。 */
  readonly initialOnlyFindingIds: readonly FindingId[];
  readonly mainFindingCounts: SeverityCountsView;
  readonly excludedFindingCounts: SeverityCountsView;
  readonly retryAttempts: readonly RetryAttemptView[];
}

/** Interaction の対象の要素（操作の前の記録。なければ後の記録）。 */
export interface InteractionTargetView {
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
}

/**
 * Interaction の候補ごとの結果（最終の試行のもの。ページの順、Evidence の順）。`reason` は、Evidence の理由のコードと詳細
 * （`reasonDetail`）に、コードの日本語の説明を添えたもの（未完了の理由と同じ形。C18o）。
 */
export interface InteractionView {
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly pageUrl: string;
  readonly viewport: ViewportProfile | null;
  readonly candidateId: string;
  readonly target: InteractionTargetView | null;
  readonly status: InteractionStatus;
  readonly notVerifiableKind: InteractionNotVerifiableKind | null;
  readonly reason: ReasonView<InteractionReasonCode>;
  /**
   * Interaction の Evidence の場所（C16d。設計書 6.1.10）。`evidence` と同じ場所（同じ ID が2か所にある不正な Run では、先にあるもの）。
   * HTML は、これで Evidence の参照を描く（ID から引き直さない）。
   */
  readonly location: EvidenceLocationView | null;
}

/** Safety の事象の理由（記録の種類ごとの理由の閉じた一覧を合わせたもの）。 */
export type SafetyEventReason = SafetyEventsEvidence[SafetyEventKind][number]['reason'];

/**
 * Safety の事象の1件（C16d。設計書 6.1.10）。Safety の Evidence（`SafetyEventsEvidence`）の、事象の一覧の1つの記録。
 * 表示のためだけのもので、Run Status と件数の判定には使わない。
 */
export interface SafetyEventView {
  /** 記録の種類（`SafetyEventsEvidence` の項目の名前のまま。値の一覧は core の `SAFETY_EVENT_KINDS`、ラベルは `SAFETY_EVENT_KIND_CATALOG`）。 */
  readonly kind: SafetyEventKind;
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** Safety の Evidence のもとになった Safety Ledger の種類（`PASSIVE` か `INTERACTION`）。 */
  readonly scope: SafetyEvidenceScope;
  /** 再試行の前の試行の記録なら、その試行の番号。最終の試行の記録なら `null`。 */
  readonly retryAttempt: number | null;
  /** HTTP のメソッド。記録にない種類は `null`。 */
  readonly method: string | null;
  /** 記録された URL（そのまま）。記録にない種類と、URL のない記録は `null`。 */
  readonly url: string | null;
  /** Interaction の候補の ID。記録にない種類は `null`。 */
  readonly candidateId: string | null;
  readonly reason: SafetyEventReason;
  /**
   * 記録のある Safety の Evidence の場所（`evidence` と同じ場所。HTML の Evidence の参照に使う。`InteractionView.location` と同じ扱い）。
   */
  readonly location: EvidenceLocationView | null;
}

/** Safety の一覧（`RunSummary.safety` の写し）と、Safety の事象の一覧（C16d。設計書 6.1.10）。 */
export interface SafetyView extends RunSafetySummary {
  /**
   * 各ページの Safety の Evidence の事象の記録（ページの順、Evidence の順、記録の種類の順（core の `SAFETY_EVENT_KINDS` の順。
   * `SafetyEventsEvidence` の項目の順と同じ）、記録の中の順）。再試行の前の試行の記録を含む。記録の上限で記録されなかった件数は、
   * この一覧から推し量らず、`recordTruncated` などの `RunSafetySummary` の値で示す。
   */
  readonly events: readonly SafetyEventView[];
}

/** Interaction の一覧（設計書 6.1.4 の節4）と、状態ごと・区分ごとの件数。 */
export interface InteractionListView {
  readonly items: readonly InteractionView[];
  readonly byStatus: Readonly<Record<InteractionStatus, number>>;
  readonly notVerifiableByKind: Readonly<Record<InteractionNotVerifiableKind, number>>;
}

/**
 * PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）: まとめの段の「大事な問題」の数の上限。値の根拠: ユーザーの判断（報告の冒頭に大事な
 * 3 つ）。
 */
export const REPORT_OVERVIEW_TOP_PROBLEM_COUNT = 3;

/**
 * PL-R: まとめの段の「大事な問題」の 1 件（Rule ごとの要約 `ruleDigests` の 1 件から作る。文言は Rule の文のまま）。`findingId` と `message` は、その Rule の
 * 例の最初の Finding（種類ごとの問題の表の行へのリンクに使う）。
 */
export interface OverviewProblemView {
  readonly ruleId: string;
  /** その Rule のいちばん重い severity。 */
  readonly severity: Severity;
  readonly count: number;
  readonly pageCount: number;
  readonly findingId: FindingId;
  readonly message: string;
  /** OP-R2: その Finding のやさしい文（`FindingView.plainMessage` と同じ値）。報告のまとめの段は、これを出す。 */
  readonly plainMessage: string;
}

/** PL-R: ページの理由ごとの、その理由のあったページの数（`run.json` の `pageIncompleteReasonCounts` の写しに、説明を添えたもの）。 */
export interface OverviewPageReasonView {
  readonly reason: ReasonView;
  readonly pages: number;
}

/**
 * PL-R: まとめの段（報告の冒頭）と、作業の画面が読む小さなまとめ（`report-summary.json`）の値。数えるのは、ここ（表示用モデルの組み立て）だけである。
 * 描く側は、ここと `summary` の値をそのまま使い、判定・集計し直さない。
 */
export interface ReportOverviewView {
  /** 問題の数（サイト品質の Finding の数。安全は分けて数える。`summary.findingCounts.byGroup.SITE_QUALITY` と同じ値）。 */
  readonly problemCount: number;
  /** AUD-9c: 問題を、同じ作りの所でまとめた数（サイト品質の候補群の数）。 */
  readonly problemGroupCount: number;
  /** 開いて見たページの数（`AUDITED` と `PARTIAL` のページ。`RunSummary` の件数のまま）。 */
  readonly checkedPageCount: number;
  /** 最後まで見られなかったページの数（`PARTIAL`・`FAILED`・`SKIPPED` のページ。`RunSummary` の件数のまま）。 */
  readonly notFullyCheckedPageCount: number;
  /**
   * 大事な問題（`ruleDigests` の並び（重さの順、件数の多い順）で、いちばん重い severity がサイト品質の Rule を、`REPORT_OVERVIEW_TOP_PROBLEM_COUNT` 件まで）。
   */
  readonly topProblems: readonly OverviewProblemView[];
  /** 点検の全体の理由（`RunSummary.incompleteReasons` の、コードの重なりを除いた記録の順。技術の詳細 `detail` は持たない）。 */
  readonly runReasons: readonly ReasonView[];
  /** ページの理由ごとのページの数（`run.json` の `pageIncompleteReasonCounts` の順。持たない前の書き手の Run は空）。 */
  readonly pageReasons: readonly OverviewPageReasonView[];
  /**
   * OP-H（撮影 UI-W4 の 3）: この点検で、この Run（監査の段）の後に登録・更新を試す、チェックした画面の数（`ReportRunFacts.plannedWriteScreenCount` のまま。
   * なければ 0）。1 以上なら、まとめの段に、この後に登録・更新する 1 行を出す。
   */
  readonly plannedWriteScreenCount: number;
  /**
   * WSO: 点検の範囲（`run.json` の `pageScope` のまま。「チェックした画面だけ」の Run だけ。サイトの全部の画面なら null）。あれば、まとめの段とバンドルに
   * 「チェックした画面だけを点検しました」の 1 行を出す。
   */
  readonly pageScope: RunPageScopeRecord | null;
}

/**
 * OP-H: Run の成果物の外から、表示用モデルに渡す事実（画面の点検のジョブの管理が `START` で渡し、ワーカーが写す）。`run.json` には書かない。省略は今のまま。
 */
export interface ReportRunFacts {
  /** この Run の後に登録・更新を試す、チェックした画面の数（1 以上の整数。チェックのない点検と CLI は省略）。 */
  readonly plannedWriteScreenCount?: number;
  /**
   * AUD-1c: 発表の前の確かめ（`missingArtifactReferencePaths`）で、なかった参照のパス。渡すと、表示用モデルの欠けの数（`missingArtifactCount`）になる。
   * 省略は「確かめていない」（欠けの数は `null`）。参照にないパスを渡すと `RangeError`。
   */
  readonly missingArtifactPaths?: readonly string[];
}

/** 表示用モデル。HTML レポート、ChatGPT 用バンドル、CLI の要約は、どれもこれを使う。 */
export interface ReportViewModel {
  readonly summary: RunSummaryView;
  /** PL-R: まとめの段の値（報告の冒頭と、`report-summary.json`）。 */
  readonly overview: ReportOverviewView;
  /** すべての Finding（`AuditRunResult.findings` の順）。 */
  readonly findings: readonly FindingView[];
  /** 重大な指摘（`SEVERITY_CATALOG` の `criticalSection` が真の severity の Finding。category を問わない。`AuditRunResult.findings` の順）。 */
  readonly criticalFindings: readonly FindingView[];
  /** category の節（すべての節。Finding のない節も含む）。 */
  readonly categorySections: readonly FindingSectionView[];
  /**
   * T44i: Rule ごとの要約（severity の表示の順（その Rule のいちばん重い severity）、件数の多い順、`ruleId` の順（UTF-16 の符号単位の順））。
   */
  readonly ruleDigests: readonly RuleDigestView[];
  /**
   * BN-d（設計書 3.5）: 本体の Finding（BeakSight の遮断と結び付かない `NONE` のサイト品質。`AuditRunResult.findings` の順）と、外した Finding（`CAUSED`・`POSSIBLE`・
   * SAFETY。同じ順）。ChatGPT 用バンドルの `findings.json` と `beaksight-related-findings.json` は、これを描くだけ。
   */
  readonly mainFindings: readonly FindingView[];
  readonly excludedFindings: readonly FindingView[];
  /** BN-d: 本体の Finding だけの Rule ごとの要約と、外した Finding だけの Rule ごとの要約（並びは `ruleDigests` と同じ決まり）。 */
  readonly mainRuleDigests: readonly RuleDigestView[];
  readonly excludedRuleDigests: readonly RuleDigestView[];
  /**
   * AUD-2d: 初めの表示だけの Finding（落ち着いた後の確かめ直しで消えた、遮断と結び付かないサイト品質。`AuditRunResult.findings` の順）と、その Rule ごとの要約。
   * 本体から分けて、別に評価できる形で残す（ChatGPT 用バンドルの `initial-only-findings.json` は、これを描くだけ）。
   */
  readonly initialOnlyFindings: readonly FindingView[];
  readonly initialOnlyRuleDigests: readonly RuleDigestView[];
  /**
   * AUD-9b: 同じ UI の繰り返しの候補群（`buildFindingGroups`。ここで 1 回だけ組む。並びは severity の順のまま）。ChatGPT 用バンドルの `finding-groups.json` は
   * これを写すだけ。
   */
  readonly findingGroups: readonly FindingGroupView[];
  readonly interactions: InteractionListView;
  /** Safety の一覧（`RunSummary.safety` の写し）と、Safety の事象の一覧（`events`）。 */
  readonly safety: SafetyView;
  readonly pages: readonly PageView[];
  /**
   * AUD-1a: ページの成果物のファイル（`page.json`・`visible-text.txt`・スクリーンショット）への参照の一覧（`buildArtifactReferences`。ここで 1 回だけ作る）。
   * ChatGPT 用バンドルは、これで入れるものと欠けの一覧を決める。
   */
  readonly artifactReferences: readonly ArtifactReferenceView[];
  /**
   * AUD-1c: 発表の前の確かめで、なかった参照の数（`ReportRunFacts.missingArtifactPaths` の数）。確かめていなければ `null`。HTML とバンドルの `manifest.json` は、
   * この値を示す。
   */
  readonly missingArtifactCount: number | null;
  /** AUD-6b: リンクごとの確かめの状態（`linkChecksOf`。ここで 1 回だけ作る）。ChatGPT 用バンドルの `links.json` は、これを写すだけ。 */
  readonly linkChecks: LinkChecksView;
}

// ---------------------------------------------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------------------------------------------

/**
 * 「重大な指摘」の節（設計書 6.1.4 の節2、6.1.8）に入れる severity。カタログの明示の属性 `criticalSection` で選ぶ（色のトーンでは
 * 選ばない）。severity の値そのものは書かない（GATE-UI01）。
 */
const CRITICAL_SEVERITIES: ReadonlySet<Severity> = new Set(
  SEVERITIES.filter((severity) => SEVERITY_CATALOG[severity].criticalSection),
);

const reasonView = ({ code, detail }: IncompleteReason): ReasonView => ({
  code,
  detail,
  description: describeIncompleteReason(code),
  // T44c: 次にできること（示せる理由だけ）。
  nextStep: nextStepOfIncompleteReason(code),
});

/** Interaction の理由（Evidence の `reason` と `reasonDetail`）に、コードの日本語の説明を添える（C18o）。 */
const interactionReasonView = (code: InteractionReasonCode, detail: string | null): ReasonView<InteractionReasonCode> => ({
  code,
  detail,
  description: describeInteractionReason(code),
  nextStep: null,
});

/** Finding を severity ごと、区分ごとに数える（表示用の集計。このファイルだけで行う）。 */
const countFindings = (findings: readonly FindingView[]): SeverityCountsView => {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const { finding } of findings) {
    bySeverity[finding.severity] += 1;
  }
  const byGroup = Object.fromEntries(
    SEVERITY_GROUPS.map((group) => [
      group,
      severitiesInGroup(group).reduce((sum, severity) => sum + bySeverity[severity], 0),
    ]),
  ) as Record<SeverityGroup, number>;
  return { total: findings.length, bySeverity, byGroup };
};

/** severity の表示の順に並べた新しい配列（同じ severity は入力の順）。 */
const sortBySeverity = (findings: readonly FindingView[]): readonly FindingView[] =>
  [...findings].sort((left, right) => SEVERITY_CATALOG[left.finding.severity].order - SEVERITY_CATALOG[right.finding.severity].order);

const copyFinding = (finding: Finding): Finding => ({
  ...finding,
  evidenceRefs: [...finding.evidenceRefs],
  // AUD-9b: まとめの鍵も写す（表示用モデルの凍結が、入力の配列に及ばないため）。
  ...(finding.groupingKeys === undefined ? {} : { groupingKeys: finding.groupingKeys.map(({ name, value }) => ({ name, value })) }),
});

/** T44i: category の別の件数（`FINDING_CATEGORIES` の全部を、表示カタログの順に。0 件も含む）。 */
const countFindingsByCategory = (findings: readonly FindingView[]): readonly CategoryCountView[] => {
  const counts = new Map<FindingCategory, number>();
  for (const { finding } of findings) {
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }
  return sortByDisplayOrder(FINDING_CATEGORIES, FINDING_CATEGORY_CATALOG).map((category) => ({ category, count: counts.get(category) ?? 0 }));
};

/** T44i: 1 つの Rule の Finding（`AuditRunResult.findings` の順）。`category` は、最初の Finding の category。 */
interface RuleFindingGroup {
  readonly ruleId: string;
  readonly category: FindingCategory;
  readonly findings: FindingView[];
}

/** T44i: Finding を Rule ごとに分ける（Rule は最初に出た順、Rule の中は `AuditRunResult.findings` の順）。 */
const groupFindingsByRule = (findings: readonly FindingView[]): readonly RuleFindingGroup[] => {
  const groups = new Map<string, RuleFindingGroup>();
  for (const view of findings) {
    const { ruleId, category } = view.finding;
    const group = groups.get(ruleId) ?? { ruleId, category, findings: [] };
    group.findings.push(view);
    groups.set(ruleId, group);
  }
  return [...groups.values()];
};

/** T44i: Rule の別の件数（件数の多い順、同じ件数は `ruleId` の順）。 */
const countFindingsByRule = (groups: readonly RuleFindingGroup[]): readonly RuleCountView[] =>
  groups
    .map(({ ruleId, category, findings }) => ({ ruleId, category, count: findings.length }))
    .sort((left, right) => right.count - left.count || compareCodeUnits(left.ruleId, right.ruleId));

/**
 * T44i: Rule ごとの要約の例。`AuditRunResult.findings` の順で、まだ選んでいないページ（ページによらない Finding は、1 つのページとして扱う）のものを
 * `REPORT_RULE_DIGEST_EXAMPLE_COUNT` 件まで選び、足りなければ、残りを同じ順で足す。
 */
const ruleDigestExamples = (findings: readonly FindingView[]): readonly RuleDigestExampleView[] => {
  const picked: FindingView[] = [];
  const pickedPages = new Set<PageId | null>();
  for (const view of findings) {
    if (picked.length < REPORT_RULE_DIGEST_EXAMPLE_COUNT && !pickedPages.has(view.finding.pageId)) {
      pickedPages.add(view.finding.pageId);
      picked.push(view);
    }
  }
  const pickedSet = new Set(picked);
  for (const view of findings) {
    if (picked.length < REPORT_RULE_DIGEST_EXAMPLE_COUNT && !pickedSet.has(view)) {
      picked.push(view);
    }
  }
  return picked.map(({ finding, screenshots }) => ({
    findingId: finding.findingId,
    pageId: finding.pageId,
    viewport: finding.viewport,
    message: finding.message,
    screenshots,
  }));
};

/** BN-c: サイト品質の severity か（SAFETY の Finding は、BeakSight の遮断との関係の区分の外）。 */
const isSiteQualitySeverity = (severity: Severity): boolean => SEVERITY_CATALOG[severity].group === 'SITE_QUALITY';

/** BN-d: BeakSight の遮断で外した Finding か（`CAUSED`・`POSSIBLE` のサイト品質と、SAFETY）。 */
const isBlockExcludedFinding = (view: FindingView): boolean => view.beaksightBlockRelation?.relation !== 'NONE';

/**
 * AUD-2d: 初めの表示だけの Finding か（BeakSight の遮断と結び付かないサイト品質で、落ち着いた後の確かめ直しで消えたもの）。BN-d と同じく、本体から分けて
 * 別に置く（消さない）。遮断で外した Finding は、遮断の側に置く（両方には置かない）。
 */
const isInitialOnlyFinding = (view: FindingView): boolean => !isBlockExcludedFinding(view) && view.verification.recheck === 'INITIAL_ONLY';

/** BN-d・AUD-2d: 本体の Finding か（BeakSight の遮断と結び付かない `NONE` のサイト品質で、初めの表示だけのものでない）。 */
const isMainFinding = (view: FindingView): boolean => !isBlockExcludedFinding(view) && !isInitialOnlyFinding(view);

/** AUD-2d: 確かめ直しの印の閉じた一覧（数える順）。 */
export const FINDING_RECHECK_MARKS = Object.freeze(['PERSISTENT', 'INITIAL_ONLY', 'LATE', 'NOT_RECHECKED'] as const satisfies readonly FindingRecheckMark[]);

/** AUD-2d: 確かめ直しの印の別の件数。 */
const countByRecheckMark = (findings: readonly FindingView[]): Readonly<Record<FindingRecheckMark, number>> => {
  const counts = Object.fromEntries(FINDING_RECHECK_MARKS.map((mark) => [mark, 0])) as Record<FindingRecheckMark, number>;
  for (const { verification } of findings) {
    counts[verification.recheck] = (counts[verification.recheck] ?? 0) + 1;
  }
  return counts;
};

/** EV-5: 証拠の足り方の数（指摘の画像の参照と、ページ・ビューポートの状態から数える）。 */
const evidenceSufficiencyOf = (findings: readonly FindingView[], pages: readonly PageView[]): EvidenceSufficiencyView => {
  const heldByReason = Object.fromEntries(FINDING_HOLD_REASONS.map((reason) => [reason, 0])) as Record<FindingHoldReason, number>;
  let targetImageJudgedCount = 0;
  let targetInImageCount = 0;
  for (const { imageRegion } of findings) {
    if (imageRegion === null) {
      continue;
    }
    if (imageRegion.holdReason !== null) {
      heldByReason[imageRegion.holdReason] += 1;
    }
    if (imageRegion.targetInImage !== null) {
      targetImageJudgedCount += 1;
      targetInImageCount += imageRegion.targetInImage === 'INSIDE' ? 1 : 0;
    }
  }
  return {
    heldFindingCount: FINDING_HOLD_REASONS.reduce((sum, reason) => sum + heldByReason[reason], 0),
    heldByReason,
    targetImageJudgedCount,
    targetInImageCount,
    uncollectedPageCount: pages.filter(({ status }) => isUncollectedAuditStatus(status)).length,
    uncollectedViewportCount: pages.flatMap(({ viewports }) => viewports).filter(({ status }) => isUncollectedAuditStatus(status)).length,
  };
};

/** BN-d: 区分の別の件数（キーは `BEAKSIGHT_BLOCK_RELATIONS` の順。区分を持たない SAFETY の Finding は数えない）。 */
const countByBlockRelation = (findings: readonly FindingView[]): Readonly<Record<BeakSightBlockRelation, number>> => {
  const counts = Object.fromEntries(BEAKSIGHT_BLOCK_RELATIONS.map((relation) => [relation, 0])) as Record<BeakSightBlockRelation, number>;
  for (const { beaksightBlockRelation } of findings) {
    if (beaksightBlockRelation !== null) {
      counts[beaksightBlockRelation.relation] += 1;
    }
  }
  return counts;
};

/** T44i: その Rule のいちばん重い severity の、表示の順（小さいほど先）。Rule の Finding は 1 件以上ある。 */
const mostSevereOrder = (bySeverity: Readonly<Record<Severity, number>>): number =>
  Math.min(...SEVERITIES.filter((severity) => bySeverity[severity] > 0).map((severity) => SEVERITY_CATALOG[severity].order));

/**
 * T44i: Rule ごとの要約（severity の表示の順（その Rule のいちばん重い severity）、件数の多い順、`ruleId` の順）。severity ごとの件数は
 * `countFindings` で数える。
 */
const buildRuleDigests = (
  groups: readonly RuleFindingGroup[],
  viewportOrder: readonly ViewportProfile[],
  groupIdOf: (findingId: FindingId) => string,
): readonly RuleDigestView[] =>
  groups
    .map(({ ruleId, category, findings }): RuleDigestView => {
      // AUD-9b: この要約の指摘が入る候補群（指摘の順に、最初に出た順。重なりなし）。
      const groupIds = [...new Set(findings.map(({ finding }) => groupIdOf(finding.findingId)))];
      const byViewport = Object.fromEntries(viewportOrder.map((viewport) => [viewport, 0])) as Record<ViewportProfile, number>;
      let viewportIndependentCount = 0;
      const pageIds = new Set<PageId>();
      for (const { finding } of findings) {
        if (finding.viewport === null) {
          viewportIndependentCount += 1;
        } else {
          byViewport[finding.viewport] += 1;
        }
        if (finding.pageId !== null) {
          pageIds.add(finding.pageId);
        }
      }
      return {
        ruleId,
        category,
        bySeverity: countFindings(findings).bySeverity,
        count: findings.length,
        pageCount: pageIds.size,
        byViewport,
        viewportIndependentCount,
        byBlockRelation: countByBlockRelation(findings),
        examples: ruleDigestExamples(findings),
        groupCount: groupIds.length,
        groupIds,
      };
    })
    .sort(
      (left, right) =>
        mostSevereOrder(left.bySeverity) - mostSevereOrder(right.bySeverity) ||
        right.count - left.count ||
        compareCodeUnits(left.ruleId, right.ruleId),
    );

/** PL-R: その Rule のいちばん重い severity（Rule の Finding は 1 件以上ある）。並びの `mostSevereOrder` と同じ決め方。 */
const mostSevereOf = (bySeverity: Readonly<Record<Severity, number>>): Severity =>
  sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG).find((severity) => bySeverity[severity] > 0) ?? SEVERITIES[0];

/**
 * PL-R: まとめの段の値（`ReportOverviewView`）。大事な問題は、Rule ごとの要約の並びのまま、いちばん重い severity がサイト品質の Rule を先頭から選ぶ（並べ直さない）。
 * ページの数は `RunSummary` の件数のまま足すだけ。理由は、点検の全体の理由のコードの重なりを除き（記録の順）、技術の詳細を落とす。
 */
const overviewView = (
  run: RunSummary,
  ruleDigests: readonly RuleDigestView[],
  findingCounts: SeverityCountsView,
  facts: ReportRunFacts,
  findings: readonly FindingView[],
  findingGroups: readonly FindingGroupView[],
): ReportOverviewView => {
  // OP-R2: 大事な問題のやさしい文は、その例の Finding の `plainMessage`（引き直さない）。
  const plainMessageById = new Map(findings.map((view) => [view.finding.findingId, view.plainMessage]));
  const runReasonCodes = [...new Set(run.incompleteReasons.map(({ code }) => code))];
  return {
    problemCount: findingCounts.byGroup.SITE_QUALITY,
    // AUD-9c: 問題（サイト品質の指摘）を、同じ作りの所でまとめた数（候補群の数。数え直さず、群の severity で分けるだけ）。
    problemGroupCount: findingGroups.filter((group) => isSiteQualitySeverity(group.severity)).length,
    checkedPageCount: run.auditedPageCount + run.partialPageCount,
    notFullyCheckedPageCount: run.partialPageCount + run.failedPageCount + run.skippedPageCount,
    topProblems: ruleDigests
      .filter((digest) => isSiteQualitySeverity(mostSevereOf(digest.bySeverity)))
      .slice(0, REPORT_OVERVIEW_TOP_PROBLEM_COUNT)
      .flatMap((digest): OverviewProblemView[] => {
        const [example] = digest.examples;
        return example === undefined
          ? []
          : [{
            ruleId: digest.ruleId,
            severity: mostSevereOf(digest.bySeverity),
            count: digest.count,
            pageCount: digest.pageCount,
            findingId: example.findingId,
            message: example.message,
            plainMessage: plainMessageById.get(example.findingId) ?? example.message,
          }];
      }),
    runReasons: runReasonCodes.map((code) => reasonView({ code, detail: null })),
    pageReasons: (run.pageIncompleteReasonCounts ?? []).map(({ code, pages }) => ({ reason: reasonView({ code, detail: null }), pages })),
    plannedWriteScreenCount: facts.plannedWriteScreenCount ?? 0,
    pageScope: run.pageScope === undefined ? null : { kind: run.pageScope.kind, pageCount: run.pageScope.pageCount },
  };
};

/**
 * 実行の記録の表示（R6）。実行の回数と再開の回数を数えるのは、ここだけである。最初の実行の後の実行が、再開である。
 * この起動の終わり方（最後の実行の終わり方。中断した Run の再開の設計書 4.8 の 2026-10-08 の追補。R9）と、最後の実行の終わりの時刻
 * （CCX-19。CC-048）を決めるのも、ここだけである（どれが最後の実行かは、core の `lastRunExecutionOf` で選ぶ。PRE42-CC 組 UI-K）。
 * 記録の値は、写して持つ（入力を凍結しない）。
 */
const executionsView = (executions: RunSummary['executions']): RunExecutionsView => {
  const [first, ...resumedExecutions] = executions;
  const lastExecution = lastRunExecutionOf(executions) ?? first;
  return {
    count: executions.length,
    resumeCount: resumedExecutions.length,
    lastEndReason: lastExecution.endReason,
    lastFinishedAt: lastExecution.finishedAt,
    items: structuredClone(executions),
  };
};

/**
 * AS-b: 監査の段の送信の扱いの表示。`run.json` の `safety.auditSend` の写しで、持たない古い Run は `READ_ONLY`・0 件と読む。目立つ形で出すかは表示カタログ
 * （`AUDIT_SEND_POLICY_CATALOG`）の値（ここだけで決める）。
 */
const auditSendView = (run: RunSummary): AuditSendView => {
  const auditSend = run.safety.auditSend ?? { policy: DEFAULT_AUDIT_SEND_POLICY, passedRequests: 0, passedRequestsByMethod: {} };
  return {
    policy: auditSend.policy,
    prominent: AUDIT_SEND_POLICY_CATALOG[auditSend.policy].prominent,
    passedRequests: auditSend.passedRequests,
    passedRequestsByMethod: { ...auditSend.passedRequestsByMethod },
    // AS-c: ほかの Origin へ通した数と、通した WebSocket の接続の数（持たない Run は 0）。
    passedOtherOriginRequests: auditSend.passedOtherOriginRequests ?? 0,
    passedWebSockets: auditSend.passedWebSockets ?? 0,
    // AS-c fix round 1: Guard の route を通らずに開いた接続と、危険な語の接続の数（持たない Run は 0）と、その知らせを出すか。
    passedWebSocketsOutsideGuard: auditSend.passedWebSocketsOutsideGuard ?? 0,
    passedDangerousWebSockets: auditSend.passedDangerousWebSockets ?? 0,
    webSocketCaution: hasAuditSendWebSocketCaution(auditSend),
  };
};

/**
 * サイトの不調で止めたことの表示（サイトが応答しないときに Run を止める設計書 3.4）。出すかどうかを決めるのは、ここだけである。
 * - 実行の記録の最後の実行の終わり方が `STOPPED_BY_SITE_UNAVAILABLE` のときだけ、値を返す（Run の理由ではなく、終わり方で決める。
 *   前の実行が不調で止まっていても、最後の実行がほかの終わり方なら `null`）。
 * - どの実行が最後かは決め直さず、実行の記録の表示（`executionsView`）の `lastEndReason` を読む（PRE42-CC 組 5a。CC-048）。
 * - `detail` は、Run の理由のうち、コード `SITE_UNAVAILABLE` の最初のものの `detail`（その理由がなければ `null`）。
 */
const siteUnavailableStopView = (run: RunSummary, executions: RunExecutionsView): SiteUnavailableStopView | null => {
  if (executions.lastEndReason !== 'STOPPED_BY_SITE_UNAVAILABLE') {
    return null;
  }
  const reason = run.incompleteReasons.find(({ code }) => code === 'SITE_UNAVAILABLE');
  return { detail: reason?.detail ?? null };
};

/** Safety の事象の記録から取り出す項目（記録にない項目は `null`）。 */
type SafetyEventFields = Pick<SafetyEventView, 'method' | 'url' | 'candidateId' | 'reason'>;

/** 記録の種類ごとの、事象の記録から項目を取り出す関数の表の型。鍵は core の `SafetyEventKind` のすべて。 */
type SafetyEventFieldReaders = {
  readonly [TKind in SafetyEventKind]: (event: SafetyEventsEvidence[TKind][number]) => SafetyEventFields;
};

/**
 * 記録の種類ごとの、事象の記録から項目を取り出す関数（設計書 6.1.10）。書き漏れと余分は、`satisfies` で型のエラーになる。
 * 記録にない項目は `null` にする。種類の並びは、この表ではなく core の `SAFETY_EVENT_KINDS` から取る。
 */
const SAFETY_EVENT_FIELDS: SafetyEventFieldReaders = Object.freeze({
  blockedRequests: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedNavigations: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedWebSockets: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedExternalActions: ({ candidateId, url, reason }) => ({ method: null, url, candidateId, reason }),
  excludedInteractionCandidates: ({ candidateId, reason }) => ({ method: null, url: null, candidateId, reason }),
  blockedInteractionRequests: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedInteractionNavigations: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedPopups: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedDownloads: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedInteractionWebSockets: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  externalSchemeNavigations: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
} satisfies SafetyEventFieldReaders);

/** Safety の Evidence の、1つの種類の事象の記録から取り出した項目（記録の中の順）。 */
function safetyEventFieldsOf<TKind extends SafetyEventKind>(
  payload: SafetyEventsEvidence,
  kind: TKind,
): readonly SafetyEventFields[] {
  const events: readonly SafetyEventsEvidence[TKind][number][] = payload[kind];
  return events.map((event) => SAFETY_EVENT_FIELDS[kind](event));
}

/** 場所を付ける前の Interaction の結果。 */
type InteractionDraft = Omit<InteractionView, 'location'>;
/** 場所を付ける前の Safety の事象。 */
type SafetyEventDraft = Omit<SafetyEventView, 'location'>;

/**
 * 関係する Finding と欠けを付ける前のスクリーンショット（MEM-4: 関係づけは全部のページを足した後に決まり、欠けは発表の前の確かめの後に決まる）。最後に
 * `ScreenshotView` にする（`screenshotViewOf`）。
 */
type ScreenshotDraft = Omit<ScreenshotView, 'relatedFindingIds' | 'missing'>;

/** 1つのページの Evidence を、場所の一覧と、スクリーンショットと、最終の試行の Interaction と、Safety の事象に分けたもの。 */
interface PageEvidenceIndex {
  readonly locations: readonly EvidenceLocationView[];
  readonly screenshots: readonly ScreenshotDraft[];
  readonly interactions: readonly InteractionDraft[];
  readonly safetyEvents: readonly SafetyEventDraft[];
}

/** ページの Evidence を1回だけたどり、場所、スクリーンショット、Interaction、Safety の事象を作る。 */
function indexPageEvidence(
  run: RunSummary,
  page: PageAuditResult,
  relatedFindingIds: (evidenceId: EvidenceId) => readonly FindingId[],
): PageEvidenceIndex {
  const retryAttemptOf = new Map<EvidenceId, number>();
  for (const retry of retryRecordsOf(run, page)) {
    for (const evidenceId of retry.evidenceIds) {
      retryAttemptOf.set(evidenceId, retry.attempt);
    }
  }
  const path = pageArtifactRelativePath(page.pageId, 'page');
  const locations: EvidenceLocationView[] = [];
  const screenshots: ScreenshotDraft[] = [];
  const interactions: InteractionDraft[] = [];
  const safetyEvents: SafetyEventDraft[] = [];
  page.evidence.forEach((record, index) => {
    const retryAttempt = retryAttemptOf.get(record.evidenceId) ?? null;
    locations.push({
      evidenceId: record.evidenceId,
      type: record.type,
      pageId: record.pageId,
      viewport: record.viewport,
      path,
      pointer: `/evidence/${index}`,
      retryAttempt,
      relatedFindingIds: [...relatedFindingIds(record.evidenceId)],
    });
    if (record.type === 'screenshot') {
      screenshots.push({
        evidenceId: record.evidenceId,
        pageId: record.payload.pageId,
        viewport: record.payload.viewport,
        captureType: record.payload.captureType,
        relativePath: record.payload.relativePath,
        // AUD-3d: 幅の走査の幅の画像の幅（主の画像は `null`）。
        stressWidth: record.payload.stressWidth ?? null,
      });
    } else if (record.type === 'interaction' && retryAttempt === null) {
      const { payload } = record;
      const target = payload.evidence.before ?? payload.evidence.after;
      interactions.push({
        evidenceId: record.evidenceId,
        pageId: record.pageId,
        pageUrl: page.pageUrl,
        viewport: record.viewport,
        candidateId: payload.candidateId,
        target: target === null ? null : { tagName: target.tagName, role: target.role, accessibleName: target.accessibleName },
        status: payload.status,
        notVerifiableKind: payload.notVerifiableKind,
        reason: interactionReasonView(payload.reason, payload.reasonDetail),
      });
    } else if (record.type === 'safety') {
      // 再試行の前の試行の記録も含める（`retryAttempt` で区別する。設計書 6.1.10）。
      const { payload } = record;
      for (const kind of SAFETY_EVENT_KINDS) {
        for (const fields of safetyEventFieldsOf(payload, kind)) {
          safetyEvents.push({
            kind,
            evidenceId: record.evidenceId,
            pageId: record.pageId,
            viewport: record.viewport,
            scope: payload.scope,
            retryAttempt,
            ...fields,
          });
        }
      }
    }
  });
  return { locations, screenshots, interactions, safetyEvents };
}

/**
 * AUD-6a: 指摘の検証の状態を決める（判定は、ここだけ）。参照する Evidence がどのページにもなければ `EVIDENCE_NOT_FOUND`、その `page.json` か関係する画像が
 * 発表の前の確かめでなかったら `EVIDENCE_FILE_MISSING` で `UNVERIFIED`。どちらもなければ、Rule の根拠のまま。
 */
function findingVerificationOf(
  ruleId: string,
  evidence: readonly EvidenceRefView[],
  screenshots: readonly ScreenshotView[],
  missingPaths: ReadonlySet<string>,
  recheck: FindingRecheckMark,
  overlap: FixedOverlapFindingView | null = null,
  labelInName: LabelInNameFindingView | null = null,
  httpError: HttpErrorFindingView | null = null,
): FindingVerificationView {
  const basis = ruleVerificationBasisOf(ruleId);
  // AUD-3c・AUD-4b・AUD-7: 区分は、ある指摘にだけ付ける（ほかの指摘の形を変えない）。
  const overlapField = {
    ...(overlap === null ? {} : { overlap }),
    ...(labelInName === null ? {} : { labelInName }),
    ...(httpError === null ? {} : { httpError }),
  };
  // AUD-6b: 検証できなかった指摘には、次に要る手順（やさしい文）を付ける。
  const unverified = (reason: FindingUnverifiedReason): FindingVerificationView =>
    ({ status: 'UNVERIFIED', basis, reason, recheck, ...overlapField, nextStep: FINDING_UNVERIFIED_NEXT_STEP_TEXT[reason] });
  if (evidence.some(({ location }) => location === null)) {
    return unverified('EVIDENCE_NOT_FOUND');
  }
  if (evidence.some(({ location }) => location !== null && missingPaths.has(location.path)) || screenshots.some((screenshot) => screenshot.missing)) {
    return unverified('EVIDENCE_FILE_MISSING');
  }
  return { status: basis, basis, reason: null, recheck, ...overlapField };
}

/**
 * MEM-4（DEF-266）: 指摘が参照する Evidence の記録から、指摘ごとに先に作った小さな値（記録そのものは持たない）。ページを 1 つずつ足すときに、記録を
 * `visit` に渡す。値は、指摘の参照の順で、値を置いた最初の参照のもの（`firstOf`）。
 * - 同じ ID の記録が 2 か所にある不正な Run で、後の記録で上書きするか（今の索引が後のもので引く）、先の記録だけを使うか（先のもので引く）は、渡す側が決める
 *   （先の記録だけを使う索引は、先に見た ID の記録だけを渡す）。
 */
class FindingRecordValues<TValue> {
  readonly #findingIndexesByEvidence = new Map<EvidenceId, number[]>();
  readonly #values = new Map<number, Map<EvidenceId, TValue>>();

  /** `applies` が真の指摘だけの値を作る。 */
  constructor(findings: readonly Finding[], applies: (finding: Finding) => boolean) {
    findings.forEach((finding, index) => {
      if (!applies(finding)) {
        return;
      }
      for (const evidenceId of new Set(finding.evidenceRefs)) {
        const indexes = this.#findingIndexesByEvidence.get(evidenceId) ?? [];
        indexes.push(index);
        this.#findingIndexesByEvidence.set(evidenceId, indexes);
      }
    });
  }

  /** 記録を参照する指摘ごとに、`valueOf` の値を置く（同じ指摘・同じ ID の値は上書きする。`undefined` は置かない）。 */
  visit(record: EvidenceRecord, valueOf: (findingIndex: number) => TValue | undefined): void {
    for (const findingIndex of this.#findingIndexesByEvidence.get(record.evidenceId) ?? []) {
      const value = valueOf(findingIndex);
      if (value === undefined) {
        continue;
      }
      const values = this.#values.get(findingIndex) ?? new Map<EvidenceId, TValue>();
      values.set(record.evidenceId, value);
      this.#values.set(findingIndex, values);
    }
  }

  /** 指摘の参照の順で、値を置いた最初の参照の値（なければ `undefined`）。 */
  firstOf(findingIndex: number, finding: Finding): TValue | undefined {
    const values = this.#values.get(findingIndex);
    for (const evidenceId of values === undefined ? [] : finding.evidenceRefs) {
      if (values?.has(evidenceId) === true) {
        return values.get(evidenceId);
      }
    }
    return undefined;
  }
}

/** 区分を持つ固定の要素の重なりの Rule の指摘か（AUD-3c）。 */
const isFixedOverlapFinding = (finding: Finding): boolean =>
  finding.ruleId === FIXED_OCCLUSION_RULE_ID || finding.ruleId === OVERSIZED_FIXED_ELEMENT_RULE_ID;

/** MEM-4: ページを 1 つずつ足して数えるもの（`earlier` は、そのページの再試行の前の試行の Evidence の ID）。 */
interface PageCollector<TResult> {
  readonly addPage: (page: PageAuditResult, earlier: ReadonlySet<EvidenceId>) => void;
  readonly result: () => TResult;
}

/**
 * AUD-4d: フォーカスの確かめの数（数えるのは、ここだけ）。単位は、各ページの最終の試行のフォーカスの確かめの Evidence（主の読み込みと幅の走査の幅）の要素。
 */
function focusChecksCollector(): PageCollector<FocusChecksView> {
  const counts = new Map<FocusCheckOutcome, number>();
  let checked = 0;
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        if (record.type !== 'focus' || earlier.has(record.evidenceId)) {
          continue;
        }
        const viewport = { width: record.payload.viewportWidth, height: record.payload.viewportHeight };
        for (const item of record.payload.items) {
          const outcome = focusCheckOutcomeOf(item, viewport);
          counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
          checked += 1;
        }
      }
    },
    result: () => ({
      checked,
      byOutcome: FOCUS_CHECK_OUTCOMES.flatMap((outcome) => (counts.has(outcome) ? [{ outcome, count: counts.get(outcome) ?? 0 }] : [])),
    }),
  };
}

/** COV-4 の区切り 3: 開いた状態の監査の結果から、数える欄（書き漏れは型のエラー）。 */
const OPENED_STATE_COUNT_FIELD: Readonly<Record<OpenedStateStatus, Exclude<keyof OpenedStatesView, 'duplicateFindingsDropped'>>> = Object.freeze({
  AUDITED: 'audited',
  SAME_STRUCTURE_SEEN: 'sameStructureSeen',
  PARTIAL: 'partial',
});

/**
 * COV-4 の区切り 3: 開いた状態の数と、除いた指摘の数（数えるのは、ここだけ）。単位は、各ページの最終の試行の操作の記録の `openedState`。
 */
function openedStatesCollector(): PageCollector<OpenedStatesView> {
  const counts = { audited: 0, sameStructureSeen: 0, partial: 0, duplicateFindingsDropped: 0 };
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        if (record.type !== 'interaction' || earlier.has(record.evidenceId) || record.payload.openedState === undefined) {
          continue;
        }
        const { status, duplicateFindingCount } = record.payload.openedState;
        counts[OPENED_STATE_COUNT_FIELD[status]] += 1;
        counts.duplicateFindingsDropped += duplicateFindingCount;
      }
    },
    result: () => counts,
  };
}

/**
 * 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しをまとめた記録の数（数えるのは、ここだけ）。単位は、各ページの最終の試行の network の Evidence の
 * `repeatedReads`。
 */
function repeatedReadsCollector(): PageCollector<RepeatedReadsView> {
  const counts = { groupCount: 0, requestCount: 0, unlistedRequestCount: 0 };
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        if (record.type !== 'network' || earlier.has(record.evidenceId)) {
          continue;
        }
        for (const repeated of record.payload.repeatedReads ?? []) {
          counts.groupCount += 1;
          counts.requestCount += repeated.count;
          counts.unlistedRequestCount += repeated.count - 1;
        }
      }
    },
    result: () => counts,
  };
}

/**
 * AUD-4c: http・https 以外の scheme のリンクの件数と事実（数えるのは、ここだけ）。単位は、各ページの最終の試行の link の Evidence のリンク（受け入れ判定が
 * `SPECIAL_SCHEME_RECORD_ONLY` のもの）。リンクの記録そのものは、page.json に残る。
 */
function specialSchemeLinksCollector(): PageCollector<SpecialSchemeLinksView> {
  const links: SpecialSchemeLinksView['links'][number][] = [];
  return {
    addPage: (page, earlier) => {
      // L5 の N5: リンクは両方のビューポートで記録する。同じリンクを 2 回数えないよう、Desktop の記録を使い、なければ Mobile の記録を使う。
      const linkRecords = page.evidence.filter((record) => record.type === 'link' && !earlier.has(record.evidenceId));
      const desktop = linkRecords.filter((record) => record.viewport !== 'mobile');
      for (const record of desktop.length > 0 ? desktop : linkRecords) {
        if (record.type !== 'link') {
          continue;
        }
        for (const link of record.payload.links) {
          if (link.admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') {
            links.push({ pageId: page.pageId, scheme: link.admission.scheme, rawUrl: link.admission.rawUrl, anchorText: link.anchorText });
          }
        }
      }
    },
    result: () => {
      const counts = new Map<string, number>();
      for (const { scheme } of links) {
        counts.set(scheme, (counts.get(scheme) ?? 0) + 1);
      }
      const byScheme = [...counts].map(([scheme, count]) => ({ scheme, count })).sort((left, right) => compareCodeUnits(left.scheme, right.scheme));
      return { total: links.length, byScheme, links };
    },
  };
}

/**
 * AUD-3c: Finding にしなかった固定の要素の重なりの数（数えるのは、ここだけ）。単位は、各ページの最終の試行の layout の Evidence（落ち着いた後の確かめ直しの
 * 段 `recheck` で集め直したものは数えない。1 回目と同じ組を 2 回数えないため）。区分は `fixedOverlapsNotCountedOf` が決める。
 */
function fixedOverlapsNotCountedCollector(): PageCollector<FixedOverlapsNotCountedView> {
  const counts = new Map<string, FixedOverlapNotCountedEntry>();
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        if (record.type !== 'layout' || earlier.has(record.evidenceId) || record.capture?.phase === 'recheck') {
          continue;
        }
        for (const entry of fixedOverlapsNotCountedOf(record.payload)) {
          const key = JSON.stringify([entry.ruleId, entry.overlapClass]);
          const known = counts.get(key);
          counts.set(key, known === undefined ? entry : { ...entry, count: known.count + entry.count });
        }
      }
    },
    result: () => {
      // 並びは、1 つの Evidence の並び（Rule・区分の順）と同じにする。
      const order = (entry: FixedOverlapNotCountedEntry): number =>
        (entry.ruleId === FIXED_OCCLUSION_RULE_ID ? 0 : 100) + FIXED_OVERLAP_CLASSES.indexOf(entry.overlapClass);
      const byClass = [...counts.values()].sort((left, right) => order(left) - order(right));
      return { total: byClass.reduce((sum, entry) => sum + entry.count, 0), byClass };
    },
  };
}

/**
 * AUD-2d: 確かめ直しの印の索引（ページ・ビューポート・fingerprint から印）。読むのは、ビューポートの記録の `recheck` の表だけ（決めるのは Page Auditor）。
 * `LATE` の指摘は、確かめ直しの Evidence から作った Finding（同じ fingerprint）なので、そのまま引ける。
 */
function recheckMarkCollector(findings: readonly Finding[]): {
  readonly addPage: (page: PageAuditResult) => void;
  readonly markOf: (finding: Finding) => FindingRecheckMark;
} {
  const keyOf = (pageId: string, viewport: string, fingerprint: string): string => JSON.stringify([pageId, viewport, fingerprint]);
  // MEM-4: 指摘の鍵の印だけを持つ（ほかの印は、どの指摘も引かない）。
  const findingKeys = new Set(findings.flatMap((finding) =>
    (finding.pageId === null || finding.viewport === null ? [] : [keyOf(finding.pageId, finding.viewport, finding.fingerprint)])));
  const marks = new Map<string, FindingRecheckMark>();
  const mark = (key: string, state: FindingRecheckMark): void => {
    if (findingKeys.has(key)) {
      marks.set(key, state);
    }
  };
  return {
    addPage: (page) => {
      for (const viewport of VIEWPORT_PROFILES) {
        for (const entry of page.viewports[viewport].recheck?.findings ?? []) {
          mark(keyOf(page.pageId, viewport, entry.fingerprint), entry.state);
        }
      }
      // COV-4 の区切り 3: 操作で開いた状態の確かめ直しの表（その状態を開いた操作の記録にある。開いた状態の指摘は、開く前の画面と fingerprint が重ならない）。
      for (const record of page.evidence) {
        if (record.type !== 'interaction' || record.viewport === null) {
          continue;
        }
        for (const entry of record.payload.openedState?.recheck?.findings ?? []) {
          mark(keyOf(page.pageId, record.viewport, entry.fingerprint), entry.state);
        }
      }
    },
    markOf: (finding) => (finding.pageId === null || finding.viewport === null
      ? 'NOT_RECHECKED'
      : marks.get(keyOf(finding.pageId, finding.viewport, finding.fingerprint)) ?? 'NOT_RECHECKED'),
  };
}

/** AUD-6c: Web Vitals の指標（`WebVitalsEvidence` の鍵。`Record` なので、指標を足すと書き漏れが型のエラーになる。値は数える順）。 */
const WEB_VITAL_METRIC_ORDER: Readonly<Record<keyof WebVitalsEvidence, number>> = Object.freeze({ LCP: 0, FCP: 1, CLS: 2, TTFB: 3, INP: 4 });
const WEB_VITAL_METRICS = (Object.keys(WEB_VITAL_METRIC_ORDER) as (keyof WebVitalsEvidence)[]).sort(
  (left, right) => WEB_VITAL_METRIC_ORDER[left] - WEB_VITAL_METRIC_ORDER[right],
);

/** AUD-6c: 観測の状態から、数える欄。 */
const WEB_VITAL_COVERAGE_FIELD: Readonly<Record<ObservationStatus, Exclude<keyof WebVitalCoverageCountsView, 'notCollected'>>> = Object.freeze({
  OBSERVED: 'observed',
  NOT_OBSERVED: 'notObserved',
  UNSUPPORTED: 'unsupported',
});

/**
 * AUD-6c: Web Vitals の観測の範囲を数える（数えるのは、ここだけ）。単位は、各ページの最終の試行の performance の Evidence（再試行の前の試行のものは数えない）。
 * Web Vitals のない Evidence（`webVitals` が `null`）は、どの指標も未収集。値の良し悪し（しきい値との比べ）は数えない。
 */
function webVitalsCoverageCollector(): PageCollector<WebVitalsCoverageView> {
  const counts = Object.fromEntries(
    WEB_VITAL_METRICS.map((metric) => [metric, { observed: 0, notObserved: 0, unsupported: 0, notCollected: 0 }]),
  ) as Record<keyof WebVitalsEvidence, { -readonly [TKey in keyof WebVitalCoverageCountsView]: number }>;
  let evidenceCount = 0;
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        if (record.type !== 'performance' || earlier.has(record.evidenceId)) {
          continue;
        }
        evidenceCount += 1;
        const { webVitals } = record.payload;
        for (const metric of WEB_VITAL_METRICS) {
          counts[metric][webVitals === null ? 'notCollected' : WEB_VITAL_COVERAGE_FIELD[webVitals[metric].status]] += 1;
        }
      }
    },
    result: () => ({ evidenceCount, byMetric: counts, interpretation: 'UNOBSERVED_IS_NOT_PASSING' }),
  };
}

/** AUD-8: 色差の axe の Rule の ID（「測定できない」を数える対象）。 */
const CONTRAST_AXE_RULE_IDS: ReadonlySet<string> = new Set(['color-contrast', 'color-contrast-enhanced']);

/**
 * AUD-8: 色差の「測定できない」を数える（数えるのは、ここだけ）。単位は、各ページの最終の試行の accessibility の Evidence の、色差の incomplete の要素。
 * 理由は、要素の確かめの最初の `messageKey`（古い版の記録や、理由のない要素は `null`）。
 */
function contrastUnmeasuredCollector(): PageCollector<ContrastUnmeasuredView> {
  const counts = new Map<string | null, number>();
  let nodeCount = 0;
  return {
    addPage: (page, earlier) => {
      for (const record of page.evidence) {
        // AUD-2d の直し: 確かめ直しの axe の Evidence（段 `recheck`）は数えない（1 回目と同じ要素を 2 回数えないため）。
        if (record.type !== 'accessibility' || earlier.has(record.evidenceId) || record.capture?.phase === 'recheck') {
          continue;
        }
        for (const rule of record.payload.incomplete) {
          if (!CONTRAST_AXE_RULE_IDS.has(rule.ruleId)) {
            continue;
          }
          for (const node of rule.nodes) {
            nodeCount += 1;
            const messageKey = node.checks?.find((check) => check.messageKey !== null)?.messageKey ?? null;
            counts.set(messageKey, (counts.get(messageKey) ?? 0) + 1);
          }
        }
      }
    },
    result: () => {
      const byReason = [...counts]
        .map(([messageKey, count]) => ({ messageKey, count }))
        .sort((left, right) => right.count - left.count
          || (left.messageKey === null ? 1 : 0) - (right.messageKey === null ? 1 : 0)
          || compareCodeUnits(left.messageKey ?? '', right.messageKey ?? ''));
      return { nodeCount, byReason };
    },
  };
}

/** スクリーンショットと Finding の関係（`relateScreenshotsToFindings` の結果）。 */
interface ScreenshotRelations {
  /** `AuditRunResult.findings` と同じ並びの、各 Finding に関係づくスクリーンショットの Evidence の ID（`FindingView.screenshots` の順）。 */
  readonly screenshotIdsOfFinding: readonly (readonly EvidenceId[])[];
  /** スクリーンショットの Evidence の ID から、関係づく Finding の ID（`AuditRunResult.findings` の順。重複なし）。 */
  readonly findingIdsOfScreenshot: ReadonlyMap<EvidenceId, readonly FindingId[]>;
}

/** 関係づけに使う、1つの Evidence の事実。 */
interface EvidenceRelationFacts {
  /** その Evidence がある `page.json` のページ。 */
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** 最終の試行の Evidence か（`retries[].evidenceIds` にないか）。 */
  readonly finalAttempt: boolean;
  readonly screenshot: boolean;
}

/**
 * スクリーンショットと Finding を関係づける（設計書 6.1.8。関係づけは、ここだけで行う）。
 * - 最終の試行のスクリーンショットは、それを `evidenceRefs` で直接参照する Finding と、同じページ（その Evidence がある
 *   `page.json` のページ）・同じビューポートの最終の試行の Evidence を参照する Finding に関係づける。Cross-page の Finding も同じ。
 * - 再試行の前の試行のスクリーンショットは、直接参照する Finding にだけ関係づける。再試行の前の試行の Evidence の参照からは、
 *   どのスクリーンショットにも広げない。
 * - 同じ ID の Evidence が2か所にある（不正な Run）場合は、先にあるものを使う（Evidence の場所と同じ扱い）。
 */
/** MEM-4: 関係づけに使う、ページを 1 つずつ足して集めた事実（Evidence の記録そのものは持たない）。 */
interface ScreenshotRelationFacts {
  /** Finding が参照する Evidence の事実だけ（関係づけが引くのは、Finding の参照だけ）。 */
  readonly facts: Map<EvidenceId, EvidenceRelationFacts>;
  /** AUD-3d: 幅の走査の幅の画像は、同じページ・同じビューポートの全部の指摘には広げず、その画像を参照する指摘（`imageRegionOf`）にだけ関係づける。 */
  readonly referenceOnlyScreenshots: Set<EvidenceId>;
  /** 最終の試行のスクリーンショット（ページごと、ビューポートごと。`page.json` の中の順）。 */
  readonly finalScreenshotsByPage: Map<PageId, Map<ViewportProfile, EvidenceId[]>>;
}

const emptyScreenshotRelationFacts = (): ScreenshotRelationFacts =>
  ({ facts: new Map(), referenceOnlyScreenshots: new Set(), finalScreenshotsByPage: new Map() });

/**
 * 関係づけの事実に、Evidence の記録を 1 つ足す（同じ ID が 2 か所にある不正な Run では、先にあるものだけを渡す）。`referenced` は、Finding が参照する Evidence
 * の ID（その事実だけを持つ）。
 */
function addScreenshotRelationFact(
  state: ScreenshotRelationFacts,
  page: PageAuditResult,
  record: EvidenceRecord,
  earlier: ReadonlySet<EvidenceId>,
  referenced: ReadonlySet<EvidenceId>,
): void {
  const fact: EvidenceRelationFacts = {
    pageId: page.pageId,
    viewport: record.viewport,
    finalAttempt: !earlier.has(record.evidenceId),
    screenshot: record.type === 'screenshot',
  };
  if (referenced.has(record.evidenceId)) {
    state.facts.set(record.evidenceId, fact);
  }
  // AUD-3d の続き: 確かめ直しの段の画像も、それを参照する指摘にだけ関係づける。
  // AUD-4d: フォーカスの確かめの画像も同じ（それを参照する指摘にだけ関係づける）。
  // REV-EV12 の I-3: 対象まで動かして撮った画像（`reveal` のある画像）も同じ（`revealScreenshotEvidenceIds` で関係づける）。
  if (record.type === 'screenshot'
    && (record.payload.stressWidth !== undefined || record.capture?.phase === 'recheck' || record.capture?.phase === 'focus-check'
      || record.payload.reveal !== undefined)) {
    state.referenceOnlyScreenshots.add(record.evidenceId);
    return;
  }
  if (fact.screenshot && fact.finalAttempt && fact.viewport !== null) {
    const byViewport = state.finalScreenshotsByPage.get(fact.pageId) ?? new Map<ViewportProfile, EvidenceId[]>();
    const ids = byViewport.get(fact.viewport) ?? [];
    ids.push(record.evidenceId);
    byViewport.set(fact.viewport, ids);
    state.finalScreenshotsByPage.set(fact.pageId, byViewport);
  }
}

function relateScreenshotsToFindings(
  findings: readonly Finding[],
  { facts, referenceOnlyScreenshots, finalScreenshotsByPage }: ScreenshotRelationFacts,
  imageRegionOf: (findingIndex: number) => FindingImageRegionView | null,
): ScreenshotRelations {
  const screenshotIdsOfFinding = findings.map((finding, findingIndex) => {
    const related = new Set<EvidenceId>();
    // 直接の参照（`evidenceRefs` の順）。
    for (const evidenceId of finding.evidenceRefs) {
      if (facts.get(evidenceId)?.screenshot === true) {
        related.add(evidenceId);
      }
    }
    // 同じページ・同じビューポートの、最終の試行の Evidence の参照。
    for (const evidenceId of finding.evidenceRefs) {
      const fact = facts.get(evidenceId);
      if (fact === undefined || !fact.finalAttempt || fact.viewport === null) {
        continue;
      }
      for (const screenshotId of finalScreenshotsByPage.get(fact.pageId)?.get(fact.viewport) ?? []) {
        related.add(screenshotId);
      }
    }
    // AUD-3d: 指摘が参照する幅の画像（同じ状態・同じ幅）。
    const region = imageRegionOf(findingIndex);
    const referenced = region?.screenshotEvidenceId ?? null;
    if (referenced !== null && referenceOnlyScreenshots.has(referenced)) {
      related.add(referenced);
    }
    // REV-EV12 の I-3: その指摘の対象を測り直して撮った画像。
    for (const revealed of region?.revealScreenshotEvidenceIds ?? []) {
      if (referenceOnlyScreenshots.has(revealed)) {
        related.add(revealed);
      }
    }
    return [...related];
  });

  const findingIdsOfScreenshot = new Map<EvidenceId, FindingId[]>();
  findings.forEach((finding, index) => {
    for (const screenshotId of screenshotIdsOfFinding[index] ?? []) {
      const ids = findingIdsOfScreenshot.get(screenshotId) ?? [];
      if (!ids.includes(finding.findingId)) {
        ids.push(finding.findingId);
      }
      findingIdsOfScreenshot.set(screenshotId, ids);
    }
  });
  return { screenshotIdsOfFinding, findingIdsOfScreenshot };
}

/** MEM-4: ページを足すときに作る、ページの表示（Finding との対応・関係づけ・欠けは、最後に付ける）。 */
interface PageDraft {
  readonly view: Omit<PageView, 'screenshots' | 'findings' | 'findingCounts' | 'mainFindingIds' | 'excludedFindingIds' | 'initialOnlyFindingIds'
    | 'mainFindingCounts' | 'excludedFindingCounts' | 'retryAttempts'>;
  readonly index: PageEvidenceIndex;
  /** 最終の試行のスクリーンショット（`page.json` の中の順）。 */
  readonly finalScreenshots: readonly ScreenshotDraft[];
  readonly retryAttempts: readonly (Omit<RetryAttemptView, 'screenshots'> & { readonly screenshots: readonly ScreenshotDraft[] })[];
}

/**
 * MEM-4（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章の MEM-4）: 表示用モデルの組み立て（唯一の所）。ページを 1 つずつ足し
 * （`addPage`。ページは持たない）、最後に 1 回だけ組み立てる（`finish`）。全部のページを 1 回なめるだけで、配列の Run も、ページの置き場所の Run も、同じ値になる。
 * - ページを足すときに持つのは、表示に要る値（ページ・Evidence の場所・スクリーンショット・Interaction・Safety の事象・リンク・数え上げ）と、指摘ごとに先に引いた
 *   小さな値（遮断との関係の索引・重なりの区分・名前の文脈・作りの印・画像の領域・確かめ直しの印・4xx・5xx の区分）だけ。Evidence の記録そのものは持たない。
 * - Finding との対応（関係づけ・ページの Finding）と、発表の前の確かめの欠けは、全部のページを足した後に付ける。
 */
function createReportViewModelAssembly(run: RunSummary, sourceFindings: readonly Finding[]): {
  readonly addPage: (page: PageAuditResult) => void;
  /** 足したページの成果物のファイルの参照（パスの重なりを含む、ページの順）。発表の前の確かめに使う。 */
  readonly artifactReferencePaths: () => readonly Pick<ArtifactReferenceView, 'path'>[];
  readonly finish: (facts: ReportRunFacts) => ReportViewModel;
} {
  // Evidence の ID から、それを参照する Finding の ID（`AuditRunResult.findings` の順）。
  const findingIdsByEvidence = new Map<EvidenceId, FindingId[]>();
  for (const finding of sourceFindings) {
    for (const evidenceId of new Set(finding.evidenceRefs)) {
      const ids = findingIdsByEvidence.get(evidenceId) ?? [];
      ids.push(finding.findingId);
      findingIdsByEvidence.set(evidenceId, ids);
    }
  }
  const relatedFindingIds = (evidenceId: EvidenceId): readonly FindingId[] => findingIdsByEvidence.get(evidenceId) ?? [];
  const referencedEvidenceIds: ReadonlySet<EvidenceId> = new Set(findingIdsByEvidence.keys());
  const viewportOrder = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);

  // 足したページの値。同じ ID が2か所にある（不正な Run）場合は、先にあるものを使う（`seen` は、見た Evidence の ID）。
  const seen = new Set<EvidenceId>();
  const pageDrafts: PageDraft[] = [];
  const referenceDrafts: ArtifactReferenceDraft[] = [];
  const locationById = new Map<EvidenceId, EvidenceLocationView>();
  const screenshotById = new Map<EvidenceId, ScreenshotDraft>();
  const relationFacts = emptyScreenshotRelationFacts();
  // AUD-3d: 指摘の画像の参照と対象の領域（幅の画像の関係づけにも使う）。
  const imageRegions = createFindingImageRegionCollector(sourceFindings);
  // BN-c: BeakSight の遮断との関係の索引（指摘が参照する Evidence の項目だけを持つ）。
  const blocks = createBeakSightBlockIndexBuilder(run, referencedEvidenceIds);
  // AUD-2d: 確かめ直しの印。
  const recheckMarks = recheckMarkCollector(sourceFindings);
  // AUD-3c: 固定の要素の重なりの区分（layout の Evidence。同じ ID の記録は、後のもので引く）。
  const fixedOverlaps = new FindingRecordValues<FixedOverlapFindingView | null>(sourceFindings, isFixedOverlapFinding);
  // AUD-4b: 名前の不一致の指摘の名前の文脈（axe の Evidence。同じ ID の記録は、後のもので引く）。
  const labelsInName = new FindingRecordValues<LabelInNameFindingView | null>(sourceFindings, (finding) => finding.ruleId === LABEL_IN_NAME_RULE_ID);
  // AUD-9b: 候補群の要素の作りの印（axe の Evidence。同じ ID の記録は、先のもので引く）。
  const structures = new FindingRecordValues<FindingStructureView | null>(sourceFindings, (finding) => structureTargetOf(finding) !== undefined);
  // AUD-7: 4xx・5xx の指摘の区分と、Finding にしなかった応答。
  const httpErrors = createHttpErrorCollector(run);
  // AUD-6b: リンクごとの確かめの状態。
  const linkChecks = createLinkChecksCollector(run);
  // AUD-6c: 性能の値の観測の範囲（ページの順）。
  const performanceObservations: PerformanceObservationView[] = [];
  const counted = pageCountCollectors();

  const addPage = (page: PageAuditResult): void => {
    const earlier = earlierAttemptEvidenceIds(run, page);
    const index = indexPageEvidence(run, page, relatedFindingIds);
    for (const location of index.locations) {
      if (!locationById.has(location.evidenceId)) {
        locationById.set(location.evidenceId, location);
      }
    }
    for (const screenshot of index.screenshots) {
      if (!screenshotById.has(screenshot.evidenceId)) {
        screenshotById.set(screenshot.evidenceId, screenshot);
      }
    }
    pageDrafts.push({
      view: {
        pageId: page.pageId,
        pageUrl: page.pageUrl,
        status: page.status,
        incompleteReasons: page.incompleteReasons.map(reasonView),
        viewports: viewportOrder.map((viewport) => {
          const state = page.viewports[viewport];
          return {
            viewport,
            status: state.status,
            requestedUrl: state.requestedUrl,
            finalUrl: state.finalUrl,
            httpStatus: state.httpStatus,
            navigationOutcome: state.navigationOutcome,
            incompleteReasons: state.incompleteReasons.map(reasonView),
          };
        }),
        pageJsonPath: pageArtifactRelativePath(page.pageId, 'page'),
        visibleTextPath: visibleTextOf(run, page) === null ? null : pageArtifactRelativePath(page.pageId, 'visibleText'),
      },
      index,
      finalScreenshots: index.screenshots.filter((screenshot) => !earlier.has(screenshot.evidenceId)),
      retryAttempts: retryRecordsOf(run, page).map((retry) => {
        const ids = new Set(retry.evidenceIds);
        return {
          attempt: retry.attempt,
          navigationOutcome: retry.navigationOutcome,
          detail: retry.detail,
          evidence: index.locations.filter((location) => ids.has(location.evidenceId)),
          screenshots: index.screenshots.filter((screenshot) => ids.has(screenshot.evidenceId)),
        };
      }),
    });
    referenceDrafts.push(...artifactReferenceDraftsOfPage(run, page));
    for (const record of page.evidence) {
      if (!seen.has(record.evidenceId)) {
        seen.add(record.evidenceId);
        addScreenshotRelationFact(relationFacts, page, record, earlier, referencedEvidenceIds);
        structures.visit(record, (findingIndex) => structureInAccessibilityRecord(record, structureTargetOf(sourceFindings[findingIndex] as Finding) ?? ''));
      }
      if (record.type === 'layout') {
        fixedOverlaps.visit(record, (findingIndex) => {
          const finding = sourceFindings[findingIndex] as Finding;
          return fixedOverlapOfFinding({ ruleId: finding.ruleId, keys: finding.groupingKeys ?? [] }, record.payload);
        });
      } else if (record.type === 'accessibility') {
        labelsInName.visit(record, (findingIndex) => {
          const finding = sourceFindings[findingIndex] as Finding;
          return labelInNameOfFinding({ ruleId: finding.ruleId, keys: finding.groupingKeys ?? [] }, record.payload);
        });
      }
    }
    imageRegions.addPage(page);
    blocks.addPage(page);
    recheckMarks.addPage(page);
    httpErrors.addPage(page);
    linkChecks.addPage(page);
    performanceObservations.push(...performanceObservationsOfPage(run, page));
    for (const collector of Object.values(counted)) {
      collector.addPage(page, earlier);
    }
  };

  return {
    addPage,
    artifactReferencePaths: () => referenceDrafts,
    finish: (facts) => assembleReportViewModel({
      run,
      sourceFindings,
      pageDrafts,
      referenceDrafts,
      locationById,
      screenshotById,
      relationFacts,
      imageRegions,
      blocks,
      recheckMarks,
      fixedOverlaps,
      labelsInName,
      structures,
      httpErrors,
      linkChecks,
      performanceObservations,
      counted,
    }, facts),
  };
}

/** MEM-4: ページの数え上げ（ページを 1 つずつ足して数える。数えるのは、それぞれの関数だけ）。 */
const pageCountCollectors = () => ({
  webVitalsCoverage: webVitalsCoverageCollector(),
  contrastUnmeasured: contrastUnmeasuredCollector(),
  fixedOverlapsNotCounted: fixedOverlapsNotCountedCollector(),
  specialSchemeLinks: specialSchemeLinksCollector(),
  focusChecks: focusChecksCollector(),
  openedStates: openedStatesCollector(),
  repeatedReads: repeatedReadsCollector(),
});

/** MEM-4: 全部のページを足した後の値（`createReportViewModelAssembly` が集めたもの）。 */
interface CollectedPages {
  readonly run: RunSummary;
  readonly sourceFindings: readonly Finding[];
  readonly pageDrafts: readonly PageDraft[];
  readonly referenceDrafts: readonly ArtifactReferenceDraft[];
  readonly locationById: ReadonlyMap<EvidenceId, EvidenceLocationView>;
  readonly screenshotById: ReadonlyMap<EvidenceId, ScreenshotDraft>;
  readonly relationFacts: ScreenshotRelationFacts;
  readonly imageRegions: ReturnType<typeof createFindingImageRegionCollector>;
  readonly blocks: BeakSightBlockIndexBuilder;
  readonly recheckMarks: ReturnType<typeof recheckMarkCollector>;
  readonly fixedOverlaps: FindingRecordValues<FixedOverlapFindingView | null>;
  readonly labelsInName: FindingRecordValues<LabelInNameFindingView | null>;
  readonly structures: FindingRecordValues<FindingStructureView | null>;
  readonly httpErrors: HttpErrorCollector;
  readonly linkChecks: ReturnType<typeof createLinkChecksCollector>;
  readonly performanceObservations: readonly PerformanceObservationView[];
  readonly counted: ReturnType<typeof pageCountCollectors>;
}

/**
 * 確定した Run の、全部のページを足した後の値から、表示用モデルを組み立てる（設計書 6.1.3。MEM-4: `createReportViewModelAssembly` の最後の段）。モデルは深く
 * 凍結する。入力は変えない。
 */
function assembleReportViewModel(collected: CollectedPages, facts: ReportRunFacts): ReportViewModel {
  const { run, sourceFindings, pageDrafts, locationById, screenshotById, counted } = collected;
  const imageRegionOf = collected.imageRegions.regionOf;
  const relations = relateScreenshotsToFindings(sourceFindings, collected.relationFacts, imageRegionOf);
  const screenshotFindingIds = (evidenceId: EvidenceId): readonly FindingId[] =>
    relations.findingIdsOfScreenshot.get(evidenceId) ?? [];
  // AUD-1a・1c: 参照の一覧（1 回だけ作る）と、発表の前の確かめでなかったパス（参照にないパスは `RangeError`）。
  const missingPaths: ReadonlySet<string> = new Set(facts.missingArtifactPaths ?? []);
  const artifactReferences = buildArtifactReferences(collected.referenceDrafts, screenshotFindingIds, missingPaths);
  // スクリーンショットに、関係づく Finding と欠けを付ける（同じスクリーンショットは同じ値）。
  const screenshotViews = new Map<ScreenshotDraft, ScreenshotView>();
  const screenshotViewOf = (draft: ScreenshotDraft): ScreenshotView => {
    const known = screenshotViews.get(draft);
    if (known !== undefined) {
      return known;
    }
    const view: ScreenshotView = {
      evidenceId: draft.evidenceId,
      pageId: draft.pageId,
      viewport: draft.viewport,
      captureType: draft.captureType,
      relativePath: draft.relativePath,
      relatedFindingIds: [...screenshotFindingIds(draft.evidenceId)],
      missing: missingPaths.has(draft.relativePath),
      stressWidth: draft.stressWidth,
    };
    screenshotViews.set(draft, view);
    return view;
  };

  // BN-c: BeakSight の遮断との関係は、Run の索引を 1 回だけ作り、サイト品質の Finding ごとに 1 回だけ判定する（SAFETY の Finding は区分の外）。
  const blockIndex = collected.blocks.finish();
  const findings: readonly FindingView[] = sourceFindings.map((finding, index) => {
    const evidence = finding.evidenceRefs.map((evidenceId) => ({ evidenceId, location: locationById.get(evidenceId) ?? null }));
    const screenshots = (relations.screenshotIdsOfFinding[index] ?? []).flatMap((evidenceId) => {
      const screenshot = screenshotById.get(evidenceId);
      return screenshot === undefined ? [] : [screenshotViewOf(screenshot)];
    });
    const beaksightBlockRelation = isSiteQualitySeverity(finding.severity) ? beaksightBlockRelationOf(blockIndex, finding) : null;
    // AUD-7（設計者の判断 2026-11-10）: 遮断の結び付きは、この 1 か所のまま。BeakSight の遮断と結び付く（`CAUSED`・`POSSIBLE`）指摘は、収集の側の誤り。
    const ruleHttpError = collected.httpErrors.findingViewOf(finding);
    const httpError = ruleHttpError !== null && beaksightBlockRelation !== null && beaksightBlockRelation.relation !== 'NONE'
      ? { ...ruleHttpError, errorClass: 'COLLECTION_CAUSED' as const }
      : ruleHttpError;
    return {
      finding: copyFinding(finding),
      // OP-R2: やさしい文は Rule の定義が持つ（Rule を評価しない）。
      plainMessage: rulePlainMessageOf(finding.ruleId) ?? finding.message,
      evidence,
      screenshots,
      // AUD-6a: 検証の状態（Rule の根拠の表と、証拠の参照の欠け。指摘ごとに 1 回だけ）。
      verification: findingVerificationOf(
        finding.ruleId,
        evidence,
        screenshots,
        missingPaths,
        collected.recheckMarks.markOf(finding),
        collected.fixedOverlaps.firstOf(index, finding) ?? null,
        collected.labelsInName.firstOf(index, finding) ?? null,
        httpError,
      ),
      beaksightBlockRelation,
      safetyBlockPhaseCounts: isSiteQualitySeverity(finding.severity) ? null : safetyBlockPhaseCountsOf(blockIndex, finding),
      imageRegion: imageRegionOf(index),
    };
  });
  // BN-d: 本体の Finding と外した Finding（`AuditRunResult.findings` の順）。AUD-2d: 初めの表示だけの Finding は、本体から分けて別に置く（消さない）。
  const mainFindings = findings.filter(isMainFinding);
  const excludedFindings = findings.filter(isBlockExcludedFinding);
  const initialOnlyFindings = findings.filter(isInitialOnlyFinding);

  const categorySections: readonly FindingSectionView[] = sortByDisplayOrder(
    REPORT_CATEGORY_SECTIONS,
    REPORT_CATEGORY_SECTION_CATALOG,
  ).map((section) => {
    const categories = findingCategoriesInSection(section);
    const sectionFindings = sortBySeverity(findings.filter(({ finding }) => categories.includes(finding.category)));
    return { section, categories: [...categories], findings: sectionFindings, counts: countFindings(sectionFindings) };
  });

  const viewportOrder = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);
  // T44i: Rule の別の件数と、Rule ごとの要約（同じ分け方から、1 回だけ数える）。
  const ruleGroups = groupFindingsByRule(findings);
  const pages: readonly PageView[] = pageDrafts.map(({ view, finalScreenshots, retryAttempts }) => {
    const pageFindings = findings.filter(({ finding }) => finding.pageId === view.pageId);
    const pageMainFindings = pageFindings.filter(isMainFinding);
    const pageExcludedFindings = pageFindings.filter(isBlockExcludedFinding);
    const pageInitialOnlyFindings = pageFindings.filter(isInitialOnlyFinding);
    return {
      ...view,
      screenshots: finalScreenshots.map(screenshotViewOf),
      findings: pageFindings,
      findingCounts: countFindings(pageFindings),
      mainFindingIds: pageMainFindings.map(({ finding }) => finding.findingId),
      excludedFindingIds: pageExcludedFindings.map(({ finding }) => finding.findingId),
      initialOnlyFindingIds: pageInitialOnlyFindings.map(({ finding }) => finding.findingId),
      mainFindingCounts: countFindings(pageMainFindings),
      excludedFindingCounts: countFindings(pageExcludedFindings),
      retryAttempts: retryAttempts.map((attempt) => ({ ...attempt, screenshots: attempt.screenshots.map(screenshotViewOf) })),
    };
  });

  // Interaction と Safety の事象に、Evidence の場所を付ける（Finding の Evidence の参照と同じ `locationById`。HTML は ID から引き直さない）。
  const withLocation = <TDraft extends { readonly evidenceId: EvidenceId }>(
    draft: TDraft,
  ): TDraft & { readonly location: EvidenceLocationView | null } => ({
    ...draft,
    location: locationById.get(draft.evidenceId) ?? null,
  });
  const interactionItems: readonly InteractionView[] = pageDrafts.flatMap(({ index }) => index.interactions.map(withLocation));
  const safetyEvents: readonly SafetyEventView[] = pageDrafts.flatMap(({ index }) => index.safetyEvents.map(withLocation));
  const byStatus = Object.fromEntries(INTERACTION_STATUSES.map((status) => [status, 0])) as Record<InteractionStatus, number>;
  const notVerifiableByKind = Object.fromEntries(INTERACTION_NOT_VERIFIABLE_KINDS.map((kind) => [kind, 0])) as Record<
    InteractionNotVerifiableKind,
    number
  >;
  for (const item of interactionItems) {
    byStatus[item.status] += 1;
    if (item.notVerifiableKind !== null) {
      notVerifiableByKind[item.notVerifiableKind] += 1;
    }
  }

  const crawl = run.effectiveConfig.crawl;
  const executions = executionsView(run.executions);
  const findingCounts = countFindings(findings);
  // AUD-9b: 候補群（1 回だけ組む）と、指摘の ID から群の ID（Rule ごとの要約の群の ID に使う）。作りの印は、ページを足すときに引いたもの。
  const findingGroups = buildFindingGroups(
    findings,
    (findingIndex) => collected.structures.firstOf(findingIndex, sourceFindings[findingIndex] as Finding) ?? null,
  );
  const groupIdByFinding = new Map(findingGroups.flatMap((group) => group.findingIds.map((findingId) => [findingId, group.groupId] as const)));
  const groupIdOf = (findingId: FindingId): string => groupIdByFinding.get(findingId) ?? '';
  const ruleDigests = buildRuleDigests(ruleGroups, viewportOrder, groupIdOf);
  const model: ReportViewModel = {
    summary: {
      runId: run.runId,
      runStatus: run.runStatus,
      targetId: run.target.id,
      toolVersion: run.toolVersion,
      startUrl: run.startUrl,
      allowedOrigins: [...run.allowedOrigins],
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      coverage: {
        discovered: run.discoveredPageCount,
        audited: run.auditedPageCount,
        partial: run.partialPageCount,
        failed: run.failedPageCount,
        skipped: run.skippedPageCount,
      },
      findingCounts,
      beaksightBlockRelation: {
        byRelation: countByBlockRelation(findings),
        linkedFindingCount: excludedFindings.filter(({ beaksightBlockRelation }) => beaksightBlockRelation !== null).length,
        mainFindingCounts: countFindings(mainFindings),
        excludedFindingCounts: countFindings(excludedFindings),
      },
      recheck: {
        byMark: countByRecheckMark(findings),
        initialOnlyFindingCounts: countFindings(initialOnlyFindings),
      },
      findingCountsByCategory: countFindingsByCategory(findings),
      findingCountsByRule: countFindingsByRule(ruleGroups),
      safetyInvariantViolationCount: run.safety.invariantViolationCount,
      limits: {
        maxPages: crawl.maxPages,
        maxDepth: crawl.maxDepth,
        maxRuntimeMs: crawl.maxRuntimeMs,
        reached: { ...run.crawlLimits },
      },
      load: structuredClone(run.load),
      executions,
      siteUnavailableStop: siteUnavailableStopView(run, executions),
      auditSend: auditSendView(run),
      incompleteReasons: run.incompleteReasons.map(reasonView),
      unverifiedInteractionCount: run.unverifiedInteractionCount,
      unverifiedInternalLinkCount: run.unverifiedInternalLinkCount,
      // AUD-6c: Web Vitals の観測の範囲（最終の試行の performance の Evidence ごと）。
      webVitalsCoverage: counted.webVitalsCoverage.result(),
      contrastUnmeasured: counted.contrastUnmeasured.result(),
      fixedOverlapsNotCounted: counted.fixedOverlapsNotCounted.result(),
      specialSchemeLinks: counted.specialSchemeLinks.result(),
      focusChecks: counted.focusChecks.result(),
      httpErrorsNotCounted: collected.httpErrors.notCounted(),
      performanceObservations: collected.performanceObservations,
      openedStates: counted.openedStates.result(),
      repeatedReads: counted.repeatedReads.result(),
      evidenceSufficiency: evidenceSufficiencyOf(findings, pages),
      environment: structuredClone(run.environment),
    },
    // PL-R: まとめの段（Rule ごとの要約と件数は、上で 1 回だけ作ったものを使う）。
    overview: overviewView(run, ruleDigests, findingCounts, facts, findings, findingGroups),
    findings,
    criticalFindings: findings.filter(({ finding }) => CRITICAL_SEVERITIES.has(finding.severity)),
    categorySections,
    ruleDigests,
    mainFindings,
    excludedFindings,
    mainRuleDigests: buildRuleDigests(groupFindingsByRule(mainFindings), viewportOrder, groupIdOf),
    excludedRuleDigests: buildRuleDigests(groupFindingsByRule(excludedFindings), viewportOrder, groupIdOf),
    initialOnlyFindings,
    initialOnlyRuleDigests: buildRuleDigests(groupFindingsByRule(initialOnlyFindings), viewportOrder, groupIdOf),
    findingGroups,
    interactions: { items: interactionItems, byStatus, notVerifiableByKind },
    safety: { ...structuredClone(run.safety), events: safetyEvents },
    pages,
    artifactReferences,
    missingArtifactCount: facts.missingArtifactPaths === undefined ? null : missingPaths.size,
    linkChecks: collected.linkChecks.result(),
  };
  return deepFreeze(model);
}

/**
 * 確定した Run から、表示用モデルを組み立てる（設計書 6.1.3）。入力は、最終の Run Status のもの（`ArtifactWriter.writeRun` の
 * 戻り値の `result`）でなければならない。モデルは深く凍結する。入力は変えない。ページの配列の Run の組み立て（ページの置き場所の Run は
 * `buildPublishedReportViewModel`。どちらも `createReportViewModelAssembly` の同じ組み立て）。
 */
export function buildReportViewModel(result: AuditRunResult, facts: ReportRunFacts = {}): ReportViewModel {
  const assembly = createReportViewModelAssembly(result.run, result.findings);
  for (const page of result.pages) {
    assembly.addPage(page);
  }
  return assembly.finish(facts);
}

/**
 * AUD-1c: 発表の前に、参照先のファイルがあるかを確かめてから、表示用モデルを組み立てる（`buildReportViewModel` と同じ組み立てに、なかったパス
 * `missingArtifactPaths` を渡す）。参照の一覧の作り方は `buildArtifactReferences` の 1 か所（ここでは、パスだけを使う）。`artifactFileExists` は、参照の順に
 * 1 回ずつ、読まずに確かめる（MEM-1）。例外は、そのまま伝える。渡された `facts.missingArtifactPaths` は、確かめた結果で置き換える。
 * MEM-4（DEF-266）: ページは、配列でもページの置き場所でもよい。`forEachRunPage` で 1 回だけなめ（置き場所のページの本体は、ページ数と同じ回数だけ戻す）、
 * ページを持たずに組み立てる。値は、配列で渡したときと同じ。
 */
export async function buildPublishedReportViewModel(
  result: AuditRunResult<RunPages>,
  artifactFileExists: ArtifactFileExists,
  facts: ReportRunFacts = {},
): Promise<ReportViewModel> {
  const assembly = createReportViewModelAssembly(result.run, result.findings);
  await forEachRunPage(result.pages, (page) => {
    assembly.addPage(page);
  });
  const missingArtifactPaths = await missingArtifactReferencePaths(assembly.artifactReferencePaths(), artifactFileExists);
  return assembly.finish({ ...facts, missingArtifactPaths });
}
