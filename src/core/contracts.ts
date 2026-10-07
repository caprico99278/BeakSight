import type {
  AccessibilityEvidence,
  ColorEvidence,
  ConsoleEvidence,
  DomEvidence,
  EffectiveAuditConfig,
  InteractionEvidence,
  LayoutEvidencePayload,
  LinkDiscoveryEvidence,
  MetadataEvidence,
  NavigationOutcomeKind,
  NetworkEvidence,
  NormalizedHttpUrlEvidence,
  PerformanceEvidence,
  SafetyEventsEvidence,
  ScreenshotEvidence,
  ScrollEvidence,
} from './evidence-types.js';
// 型だけの import（実行時の依存はない。`status.ts` は、このファイルの型と値を使う）。
import type { RunStatusInput } from './status.js';

export type RunId = string & { readonly __brand: 'RunId' };
export type PageId = string & { readonly __brand: 'PageId' };
export type EvidenceId = string & { readonly __brand: 'EvidenceId' };
export type FindingId = string & { readonly __brand: 'FindingId' };

// 値の一覧（閉じた集合）は、`as const` の凍結した配列に1回だけ書き、型はその配列から導く。
// JSON Schema（`schemas/*.schema.json`）の enum は、この配列と一致させる（`tests/unit/schema-enum-consistency.test.ts`）。

/** Run Status の閉じた一覧（run.json の `runStatus`）。 */
export const RUN_STATUSES = Object.freeze(['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY'] as const);
export type RunStatus = (typeof RUN_STATUSES)[number];

/** ページとビューポートの監査の状態の閉じた一覧。 */
export const PAGE_AUDIT_STATUSES = Object.freeze(['AUDITED', 'PARTIAL', 'SKIPPED', 'FAILED'] as const);
export type PageAuditStatus = (typeof PAGE_AUDIT_STATUSES)[number];

/** Finding の severity の閉じた一覧。 */
export const SEVERITIES = Object.freeze(['ERROR', 'WARN', 'INFO', 'SAFETY'] as const);
export type Severity = (typeof SEVERITIES)[number];

/** Interaction の監査の結果の状態の閉じた一覧。 */
export const INTERACTION_STATUSES = Object.freeze([
  'VERIFIED',
  'REJECTED_UNSAFE',
  'BLOCKED_BY_SAFETY',
  'NOT_VERIFIABLE',
  'EXECUTION_FAILED',
] as const);
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

export const PARTIAL_FAILURE_REASONS = Object.freeze(['DEADLINE_EXCEEDED', 'EVALUATION_FAILED', 'PAGE_CLOSED'] as const);
export type PartialFailureReason = (typeof PARTIAL_FAILURE_REASONS)[number];

/**
 * 未完了の理由のコード（`incompleteReasons` の `code`）。collector の部分失敗の理由と、`deriveRunStatus()` の入力の
 * それぞれを表すコードを、ここで1回だけ定義する。collector の理由の型は、この一覧から `Extract` で導く。
 */
export const INCOMPLETE_REASON_CODES = Object.freeze([
  ...PARTIAL_FAILURE_REASONS,
  /** 遷移（`page.goto`）が失敗した。 */
  'NAVIGATION_FAILED',
  /** page settling: DOM の準備（`domcontentloaded`）を待つ処理が失敗した。 */
  'DOM_READINESS_FAILED',
  /** controlled scroll: 内容の高さがビューポートより大きいのに、スクロールする要素を特定できない。 */
  'SCROLL_TARGET_UNRESOLVED',
  /** controlled scroll: スクロールを要求しても位置が進まない、または一度もスクロールせずに内容がビューポートより大きい。 */
  'SCROLL_NOT_ADVANCED',
  /**
   * controlled scroll: 候補（文書、body、内側のスクロール領域）のうち、スクロールできる量が最も大きいのが内側の領域で、
   * controlled scroll はその領域をたどらない（完了と判定する前に測り直した結果を含む）。
   */
  'INNER_SCROLL_CONTAINER_NOT_TRAVERSED',
  /** controlled scroll: 内側のスクロール領域を探す走査が上限に達し、領域がないと確かめられない。 */
  'INNER_SCROLL_SCAN_LIMIT_REACHED',
  /** controlled scroll: 対象を1回切り替えてたどり直した後も、スクロールできる量が最も大きい候補が変わった。 */
  'SCROLL_TARGET_UNSTABLE',
  /** controlled scroll: 終了時に文書の先頭（0, 0）へ戻せなかった。 */
  'POSITION_NOT_AT_ORIGIN',
  /** layout: 重なりの走査が、比べる組の上限（`maxOverlapComparisons`）に達して止まった。 */
  'LAYOUT_COMPARISON_LIMIT_REACHED',
  /** performance: Resource Timing の件数の上限に達したか、バッファが満杯になった。 */
  'RESOURCE_LIMIT_REACHED',
  /** performance: ブラウザから返った値が不正だった。 */
  'INVALID_BROWSER_DATA',
  /** Run Status の入力 `preflightFailed`。 */
  'PREFLIGHT_FAILED',
  /**
   * Run のディレクトリを、Run の開始の時点で排他的に作れなかった（同じ名前のものがすでにある場合を含む。DEF-009）。
   * PREFLIGHT の失敗と同じく扱い、Run Status の入力は `preflightFailed` にする。`detail` は、失敗した作成の例外のメッセージ。
   */
  'RUN_DIRECTORY_UNAVAILABLE',
  /** Run Status の入力 `safetyInvariantViolations`。 */
  'SAFETY_INVARIANT_VIOLATION',
  /** Run Status の入力 `safetyLedgerTruncated`。 */
  'SAFETY_LEDGER_TRUNCATED',
  /** Run Status の入力 `unhandledFailures`。 */
  'UNHANDLED_FAILURE',
  /** Run Status の入力 `crawlLimitReached`（ページ数の上限）。 */
  'MAX_PAGES_REACHED',
  /** Run Status の入力 `crawlLimitReached`（深さの上限）。 */
  'MAX_DEPTH_REACHED',
  /** Run Status の入力 `crawlLimitReached`（実行時間の上限）。 */
  'MAX_RUNTIME_REACHED',
  /** Run Status の入力 `requiredArtifactsValid`。 */
  'REQUIRED_ARTIFACT_INVALID',
  /** Run Status の入力 `executionComplete`。 */
  'EXECUTION_INCOMPLETE',
  /** Run Status の入力 `skippedRequiredWork`。 */
  'REQUIRED_WORK_SKIPPED',
  /** Run Status の入力 `blockedRequiredWork`。 */
  'REQUIRED_WORK_BLOCKED',
  /** Run Status の入力 `timedOutRequiredWork`。 */
  'REQUIRED_WORK_TIMED_OUT',
  /** Run Status の入力 `notObservedRequiredWork`。 */
  'REQUIRED_WORK_NOT_OBSERVED',
  /** Run Status の入力 `notVerifiedRequiredWork`。 */
  'REQUIRED_WORK_NOT_VERIFIED',
  /** Run Status の入力 `failedRequiredWork`。 */
  'REQUIRED_WORK_FAILED',
  /** Run Status の入力 `incompleteCollectorCount`。 */
  'COLLECTOR_INCOMPLETE',
  /**
   * page rule の評価の失敗（`RuleEngine` の `RuleEvaluationFailure`）。Rule が例外を投げたか、不正な下書き
   * （入力にない Evidence の参照など）を返した。
   */
  'RULE_EVALUATION_FAILED',
  /**
   * 描画プロセスが落ちた（page の `crash` の事象。Task 14〜17 の設計書 4.5.4）。ビューポートの状態は `FAILED`。
   * crash した段階の理由は、`COLLECTOR_INCOMPLETE` の `detail` の `<段階>:PAGE_CRASHED` として記録する。
   */
  'PAGE_CRASHED',
  /**
   * 安全の不変条件の違反を Run の途中で検出したため、その後の監査を始めなかった（Task 19 の前の整理の設計書 4.5。C18f）。
   * - 始めなかったページ（`SKIPPED`）と、始めなかったビューポート（`SKIPPED`）の理由。`detail` は `null`。
   * - 止めたこと（ページ、ビューポート、幅、候補、再試行のどれか）を、Run の理由にも1件だけ残す（`detail` は `null`）。
   * - robots.txt と sitemap.xml の取得を始めなかった場合は、Run の理由に `detail` が `site-metadata` のものも残す。
   * - 始めなかった幅の走査の幅と Interaction の候補は、段階の理由（`COLLECTOR_INCOMPLETE`）の `detail` に、このコードを含める
   *   （`stress-layout:SAFETY_VIOLATION_ABORT`、`interaction:SAFETY_VIOLATION_ABORT:remaining=<件数>`）。
   * Run Status は、違反の件数から `deriveRunStatus` が `ABORTED_BY_SAFETY` と導く（このコードでは決めない）。
   */
  'SAFETY_VIOLATION_ABORT',
  /**
   * 再開のための保存（チェックポイント）を書けなかったため、その後の監査を始めなかった（中断した Run の再開の設計書 4.3）。
   * - 始めなかったページ（`SKIPPED`）の理由。`detail` は `null`。
   * - 書けなかったことを、Run の理由にも1件残す（`detail` は、失敗のメッセージ）。
   * - 保存のセッションを Run の初めに始められなかった場合は、Run のディレクトリを作れなかった場合と同じく、Run Status の入力は
   *   `preflightFailed` にする（ページを1つも監査しない）。
   */
  'CHECKPOINT_WRITE_FAILED',
  /**
   * 止める印（Ctrl+C などの1回目のシグナル）を受けたため、その後の監査を始めなかった（中断した Run の再開の設計書 4.6.1）。
   * - 始めなかったページ（`SKIPPED`）の理由。`detail` は `null`。
   * - Run の理由にも1件残す（SKIPPED のページから、最後の処理で導く。R4b2）。
   * - 再開のときは、この理由の SKIPPED の URL を、待ち行列に戻す（`RESUME_REQUEUE_SKIP_REASON_CODES`、`src/orchestration/run-checkpoint.ts`）。
   * Run Status は、SKIPPED のページがあるので、`deriveRunStatus` が `PARTIAL` と導く（このコードでは決めない）。
   */
  'RUN_INTERRUPTED',
  /**
   * サイトの不調（判定は `siteUnavailabilityOf`、`src/orchestration/site-availability.ts`）を検知したため、その後の監査を始めなかった
   * （サイトが応答しないときに Run を止める設計書 3.2）。
   * - 始めなかったページと、不調を検知したページ（`SKIPPED`）の理由。始めなかったページの `detail` は `null`。不調を検知したページ
   *   （止まるきっかけのページ）の `detail` は、最初に検知した失敗（Run の理由と同じ形。設計書 3.2 の 2026-10-05 改訂）。
   * - 再開のときは、この理由の SKIPPED の URL を、待ち行列に戻す（`RESUME_REQUEUE_SKIP_REASON_CODES`、`src/orchestration/run-checkpoint.ts`）。
   * - Run の理由にも1件残す（`detail` は、最初に検知した失敗。例: `desktop:passive:TIMEOUT`、`mobile:passive:HTTP 503`）。
   * - ビューポートの理由としても使う（設計書 3.1）。不調を検知したビューポートは `FAILED` で、`detail` は `<段階>:<判定の詳細>`
   *   （例: `passive:TIMEOUT`、`passive:HTTP 503`。組み立ては `siteUnavailableStageDetail`）。読み込みが失敗した場合の
   *   `NAVIGATION_FAILED` の理由も残す。不調を検知した後に始めなかったビューポートは `SKIPPED` で、`detail` は `null`。
   * Run Status は、SKIPPED のページがあるので、`deriveRunStatus` が `PARTIAL` と導く（このコードでは決めない）。
   */
  'SITE_UNAVAILABLE',
] as const);
export type IncompleteReasonCode = (typeof INCOMPLETE_REASON_CODES)[number];

/**
 * Page Auditor の処理の段階の名前の閉じた一覧（Task 14〜17 の設計書 4.5.5）。collector が PARTIAL を返したか例外を投げた場合の
 * 理由（`COLLECTOR_INCOMPLETE`）の `detail` は、`<段階>:<理由>` の形にする（`collectorIncompleteReason`、`src/core/status.ts`）。
 * ナビゲーション・DOM の準備・scroll・Rule の評価の失敗は、既存の専用の理由のコードを使う。
 */
export const PAGE_AUDIT_STAGES = Object.freeze([
  'navigation',
  'settling',
  'scroll',
  'dom',
  'layout',
  'stress-layout',
  'color',
  'accessibility',
  'performance',
  'screenshot',
  'links',
  'interaction-discovery',
  'interaction',
  'safety',
  'rules',
] as const);
export type PageAuditStage = (typeof PAGE_AUDIT_STAGES)[number];

/** 未完了の理由。`detail` は、理由の補足（どの collector か、どのURLか、など）。補足がなければ `null`。 */
export interface IncompleteReason {
  readonly code: IncompleteReasonCode;
  readonly detail: string | null;
}

export const OBSERVATION_STATUSES = Object.freeze(['OBSERVED', 'NOT_OBSERVED', 'UNSUPPORTED'] as const);
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** Finding の category（Task 12・13 の設計書 第4章）。日本語のラベルと並び順は、表示カタログが持つ。 */
export const FINDING_CATEGORIES = Object.freeze([
  'HTTP',
  'LINK',
  'RESOURCE',
  'JAVASCRIPT',
  'DOM',
  'FORM',
  'ACCESSIBILITY',
  'LAYOUT',
  'PERFORMANCE',
  'CROSS_PAGE',
  'SAFETY',
] as const);
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface EvidencePayloadByType {
  readonly network: NetworkEvidence;
  readonly console: ConsoleEvidence;
  readonly dom: DomEvidence;
  readonly link: LinkDiscoveryEvidence;
  readonly layout: LayoutEvidencePayload;
  readonly color: ColorEvidence;
  readonly performance: PerformanceEvidence;
  readonly accessibility: AccessibilityEvidence;
  readonly interaction: InteractionEvidence;
  readonly screenshot: ScreenshotEvidence;
  readonly scroll: ScrollEvidence;
  readonly metadata: MetadataEvidence;
  readonly safety: SafetyEventsEvidence;
}

/**
 * Evidence の種類の閉じた一覧（`EvidencePayloadByType` のキーと同じ集合。一致は `tests/unit/core-contracts.test.ts` の
 * 型の検査で確かめる）。
 */
export const EVIDENCE_TYPES = Object.freeze([
  'network',
  'console',
  'dom',
  'link',
  'layout',
  'color',
  'performance',
  'accessibility',
  'interaction',
  'screenshot',
  'scroll',
  'metadata',
  'safety',
] as const satisfies readonly (keyof EvidencePayloadByType)[]);
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceRecordFor<TType extends EvidenceType> {
  readonly evidenceId: EvidenceId;
  readonly type: TType;
  readonly pageId: PageId;
  /**
   * Evidence を集めたビューポート。ビューポートによらない Evidence（例: robots.txt などの metadata）は `null`。
   * 負荷を確かめる幅（`stressWidths`）の結果は、それを集めた主要なビューポートの layout の Evidence に含める。
   */
  readonly viewport: ViewportProfile | null;
  readonly observedAt: string;
  readonly payload: EvidencePayloadByType[TType];
}

export type EvidenceRecord = {
  readonly [TType in EvidenceType]: EvidenceRecordFor<TType>;
}[EvidenceType];

export interface Finding {
  readonly schemaVersion: 'finding-schema/1.0';
  readonly findingId: FindingId;
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly pageId: PageId | null;
  readonly pageUrl: string | null;
  /**
   * Finding の元になったビューポート。ビューポートによらない Finding（例: Cross-page の Finding、
   * ビューポートによらない Evidence だけから作る Finding）は `null`。
   */
  readonly viewport: ViewportProfile | null;
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceId[];
}

/** 主要なビューポート（設計書 9.3）の閉じた一覧。 */
export const VIEWPORT_PROFILES = Object.freeze(['desktop', 'mobile'] as const);
export type ViewportProfile = (typeof VIEWPORT_PROFILES)[number];

/** ビューポートごとの監査の状態。ページ全体の状態は、ビューポートの状態の中で最も悪いもの。 */
export type ViewportAuditStatus = PageAuditStatus;

/** ビューポートごとの、ページの identity と監査の状態（設計書 18.2 の identity）。 */
export interface ViewportAuditResult {
  /** 要求した、正規化済みのURL（クロールのキューのURL。`PageAuditResult.pageUrl` と同じ値）。 */
  readonly requestedUrl: NormalizedHttpUrlEvidence;
  /** リダイレクトの後の最終URL（メインフレームの文書のURL）。遷移に失敗したなどで観測できなかった場合は `null`。 */
  readonly finalUrl: string | null;
  /** メインフレームの文書の応答の HTTP ステータス。応答を観測できなかった場合は `null`。 */
  readonly httpStatus: number | null;
  readonly status: ViewportAuditStatus;
  readonly incompleteReasons: readonly IncompleteReason[];
  /**
   * ナビゲーションの結果の種類（Task 14〜17 の設計書 4.3.0、4.5.4）。そのビューポートでナビゲーションしなかった（スキップした）
   * 場合は `null`。`OK` 以外の場合、ビューポートの状態は `FAILED`、理由は `NAVIGATION_FAILED`（`detail` は結果の種類）。
   * Cross-page rule は、これでリンク先を検証したかと、ナビゲーションの失敗の種類を判断する。
   */
  readonly navigationOutcome: NavigationOutcomeKind | null;
}

export interface PageAuditResult {
  readonly schemaVersion: 'page-schema/1.0';
  readonly pageId: PageId;
  /**
   * ページの identity のURL。クロールのキューで使う、要求した正規化済みのURL（`normalizeUrl` の結果）。
   * リダイレクトの後の最終URLではない（最終URLは、ビューポートごとに `viewports.<profile>.finalUrl` に記録する）。
   */
  readonly pageUrl: NormalizedHttpUrlEvidence;
  readonly status: PageAuditStatus;
  /** Desktop と Mobile それぞれの監査の状態（設計書 9.3）。 */
  readonly viewports: Readonly<Record<ViewportProfile, ViewportAuditResult>>;
  readonly evidence: readonly EvidenceRecord[];
  readonly findings: readonly Finding[];
  readonly incompleteReasons: readonly IncompleteReason[];
}

/**
 * 1ページで作ったすべての Safety Ledger（Passive、Interaction、幅の走査）の集計（Task 14〜17 の設計書 4.5.1）。
 * 不変条件の違反は Evidence に含めないので、`PageAuditResult` の外に置く。Run Coordinator は、これを Run Status の入力
 * （`safetyInvariantViolations`、`safetyLedgerTruncated`）と、run.json の Safety の要約に集計する。
 * 作るには `summarizePageSafety`（`src/safety/safety-ledger.ts`）を使う。
 */
export interface PageSafetySummary {
  /** 記録できなかった分も含む、不変条件の違反の総数（安全な整数の上限で止める）。 */
  readonly invariantViolationCount: number;
  /** 各 Ledger が記録できた不変条件の違反（Ledger の順、Ledger の中では記録の順）。 */
  readonly invariantViolations: readonly SafetyInvariantViolationSummary[];
  /** どれかの Ledger の記録が上限で不完全になったか（`SafetyLedgerRecordLimits.truncated`）。 */
  readonly recordTruncated: boolean;
}

/**
 * ページ本体の要求の観察の結果の状態の閉じた一覧（サイトの不調で止めたときの診断の記録の設計書 2.1）。
 * - `OBSERVED`: 観察した（記録した文書の要求が0件の場合を含む）。
 * - `NOT_OBSERVED`: 観察を始められなかった（CDP の session を開けない、`Network.enable` が失敗した、始める処理が期限までに終わらない）。
 */
export const NAVIGATION_DIAGNOSTICS_STATUSES = Object.freeze(['OBSERVED', 'NOT_OBSERVED'] as const);
export type NavigationDiagnosticsStatus = (typeof NAVIGATION_DIAGNOSTICS_STATUSES)[number];

/**
 * 1回の読み込み（Passive のビューポートの読み込み、幅の走査の1つの幅、Interaction の1つの候補）の間の、ページ本体の要求の観察の結果
 * （サイトの不調で止めたときの診断の記録の設計書 2.1、2.2）。
 * 作るのは `startNavigationDiagnostics`（`src/browser/navigation-diagnostics.ts`）だけである。判定はしない（サイトの不調の判定は
 * `src/orchestration/site-availability.ts`）。要求と応答の header の中身と、本文は持たない。
 * 時刻は、すべて `Date.now()` と同じ基準の ms（UNIX エポックからのミリ秒）である。
 */
export type NavigationDiagnostics = ObservedNavigationDiagnostics | NotObservedNavigationDiagnostics;

/** 観察した結果。 */
export interface ObservedNavigationDiagnostics {
  readonly status: Extract<NavigationDiagnosticsStatus, 'OBSERVED'>;
  /** 観察を始めた時刻（`Network.enable` が終わった時刻）。 */
  readonly observationStartedAtMs: number;
  /** 観察を終えた時刻（読み込みの後に、観察を止めた時刻）。 */
  readonly observationEndedAtMs: number;
  /** main frame の文書の要求（発行の順）。上限は `MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS`。 */
  readonly documentRequests: readonly NavigationDocumentRequestDiagnostics[];
  /** 上限を超えたため（文書の要求の上限か、事象の上限に達した後）、記録しなかった文書の要求の数。 */
  readonly omittedDocumentRequestCount: number;
  /** 記録した文書の要求の事象のうち、事象の上限（`MAX_NAVIGATION_DIAGNOSTICS_EVENTS`）を超えたため、記録しなかった事象の数。 */
  readonly omittedEventCount: number;
}

/** 観察を始められなかった結果。 */
export interface NotObservedNavigationDiagnostics {
  readonly status: Extract<NavigationDiagnosticsStatus, 'NOT_OBSERVED'>;
  /** 始められなかった理由（上限 `MAX_ERROR_MESSAGE_LENGTH` 付きのメッセージ）。 */
  readonly reason: string;
}

/**
 * main frame の文書の要求1つ（CDP の同じ要求の ID）。リダイレクトは、同じ要求の続き（`hops` の次の要素）として記録する。
 * 読み込みの終わり（`Network.loadingFinished`）と失敗（`Network.loadingFailed`）は、要求の全体（最後の `hops`）に対するものである。
 */
export interface NavigationDocumentRequestDiagnostics {
  /** 最初の要求と、リダイレクトでたどった要求（発行の順）。少なくとも1つある。 */
  readonly hops: readonly NavigationDocumentRequestHop[];
  /** 読み込みが終わった時刻（`Network.loadingFinished` を受けた時刻）。受けていなければ `null`。 */
  readonly loadingFinishedAtMs: number | null;
  /** 読み込みの失敗（`Network.loadingFailed`）。受けていなければ `null`。 */
  readonly loadingFailure: NavigationDocumentLoadingFailure | null;
}

/** 文書の要求の1回分（最初の要求か、リダイレクトでたどった要求）。 */
export interface NavigationDocumentRequestHop {
  /** 要求の URL（上限 `MAX_URL_LENGTH`）。 */
  readonly url: string;
  /** 要求の method（上限 `MAX_HTTP_METHOD_LENGTH`）。 */
  readonly method: string;
  /** `url` か `method` を上限で切り詰めたか。 */
  readonly truncated: boolean;
  /** ページが要求を発行した時刻（`Network.requestWillBeSent` の `wallTime`。なければ、受けた時刻）。 */
  readonly issuedAtMs: number;
  /**
   * 要求のヘッダをネットワークへ送った時刻（`Network.requestWillBeSentExtraInfo` を受けた時刻）。受けていなければ `null`
   * （要求がネットワークへ送られていない。キャッシュや内部のリダイレクトのように、ネットワークに出ない要求も `null`）。
   */
  readonly requestHeadersSentAtMs: number | null;
  /**
   * 応答のヘッダを受けた時刻（`Network.responseReceivedExtraInfo`、`Network.responseReceived`、リダイレクトの応答の、最初に受けたもの）。
   * 受けていなければ `null`。
   */
  readonly responseHeadersReceivedAtMs: number | null;
  /** 応答の HTTP の status。応答を受けていなければ `null`。 */
  readonly httpStatus: number | null;
  /** 応答の接続先の IP アドレス（`remoteIPAddress`）。応答を受けていない場合と、IP アドレスでない場合は `null`。 */
  readonly remoteIpAddress: string | null;
  /** 応答の接続先の port（`remotePort`）。応答を受けていない場合と、0以上の安全な整数でない場合は `null`。 */
  readonly remotePort: number | null;
}

/** 文書の要求の読み込みの失敗（`Network.loadingFailed`）。 */
export interface NavigationDocumentLoadingFailure {
  /** 失敗を受けた時刻。 */
  readonly failedAtMs: number;
  /** 失敗の理由（例: `net::ERR_ABORTED`。上限 `MAX_ERROR_MESSAGE_LENGTH`）。 */
  readonly errorText: string;
  /** ブラウザが取り消したか（`canceled`）。 */
  readonly canceled: boolean;
}

/** `PageAuditor.audit(url, pageId)` の戻り値（Task 14〜17 の設計書 4.5.1）。 */
export interface PageAuditOutcome {
  readonly result: PageAuditResult;
  readonly safety: PageSafetySummary;
  /**
   * そのページで最初に検知したサイトの不調（判定は `siteUnavailabilityOf`、`src/orchestration/site-availability.ts`）の詳細
   * （サイトが応答しないときに Run を止める設計書 3.1、3.2）。形は `<ビューポート>:<段階>:<判定の詳細>`（例: `desktop:passive:TIMEOUT`、
   * `mobile:passive:HTTP 503`。組み立ては `siteUnavailableDetail`）。不調を検知しなければ `null`。
   * Run Coordinator は、これを、Run の理由と、止まるきっかけのページの理由（`SITE_UNAVAILABLE`）の `detail` に使う。
   * Page の結果（`PageAuditResult`）の JSON には含めない。
   */
  readonly siteUnavailableDetail: string | null;
  /**
   * 各ビューポートの読み込み（Passive、幅の走査の各幅、Interaction の各候補）の間の、ページ本体の要求の観察の結果（サイトの不調で止めた
   * ときの診断の記録の設計書 2.1、2.2。2026-10-07 の改訂）。始めなかったビューポート（SKIPPED のビューポート）は `null`。
   * ページの結果（`PageAuditResult`）と Evidence には含めない（診断の記録だけに使う）。
   */
  readonly navigationDiagnostics: Readonly<Record<ViewportProfile, ViewportNavigationDiagnostics | null>>;
}

/**
 * 1つのビューポートの診断の記録に持つ、幅の走査の幅ごとの観察の結果の最大の数（サイトの不調で止めたときの診断の記録の設計書 2.3）。
 * 設定の `viewports.stressWidths` の数に上限はないので、記録の数だけをここで止める（Page Auditor は、この数までの幅の観察を記録し、
 * 超えた幅の観察は記録しない）。診断の記録のスキーマ（`schemas/site-unavailable-diagnostic.schema.json`）の `stressWidths` の
 * `maxItems` と一致する。
 * 値の根拠: 既定の幅は 5 つで、幅はそれぞれページの読み込み直しなので、ふつうの設定は 10 幅に満たない。320px から 1920px まで 25px
 * おきに調べる密な走査（65 幅）に近い数まで余裕を取った（設計者の決定）。
 */
export const MAX_STRESS_WIDTH_NAVIGATION_DIAGNOSTICS = 64;

/**
 * 1つのビューポートの、ページ本体の要求の観察の結果（サイトの不調で止めたときの診断の記録の設計書 2.2 の 2026-10-07 の改訂）。
 * Passive の読み込みに加えて、幅の走査の幅ごと（幅の値つき。読み込みを始めた幅だけ、読み込んだ順）と、Interaction の候補ごと
 * （候補の順の番号つき。読み込みを始めた候補だけ、監査した順）の観察を持つ。幅の走査と Interaction は Desktop だけで行うので、
 * Mobile では、どちらも空である。
 */
export interface ViewportNavigationDiagnostics {
  /**
   * Passive の読み込みの間の観察の結果。Passive の読み込みを始めなかった（Context と page を作れなかった）ビューポートは `null`
   * （そのビューポートでは、幅の走査と Interaction も行わないので、下の2つは空）。
   */
  readonly passive: NavigationDiagnostics | null;
  /** 幅の走査の、読み込みを始めた幅ごとの観察の結果（読み込んだ順。上限は `MAX_STRESS_WIDTH_NAVIGATION_DIAGNOSTICS`）。 */
  readonly stressWidths: readonly StressWidthNavigationDiagnostics[];
  /**
   * Interaction の、対象のページの読み込みを始めた候補ごとの観察の結果（監査した順。上限は、候補の数の上限
   * `INTERACTION_CANDIDATE_LIMITS.maxCandidates`、`src/safety/interaction-policy.ts`）。
   */
  readonly interactionCandidates: readonly InteractionCandidateNavigationDiagnostics[];
}

/** 幅の走査の1つの幅の読み込みの観察の結果。 */
export interface StressWidthNavigationDiagnostics {
  /** 幅（CSS ピクセル。設定の `viewports.stressWidths` の値）。 */
  readonly width: number;
  readonly diagnostics: NavigationDiagnostics;
}

/** Interaction の1つの候補の、対象のページの読み込みの観察の結果。 */
export interface InteractionCandidateNavigationDiagnostics {
  /** 候補の順の番号（候補の発見の順。0 から）。 */
  readonly index: number;
  readonly diagnostics: NavigationDiagnostics;
}

/** 実行の環境の事実（設計書 18.1、Task 14〜17 の設計書 5.5）。ビューポート・locale・timezone・headed は `effectiveConfig` にある。 */
export interface RunEnvironment {
  readonly nodeVersion: string;
  /** OS（`process.platform`）。 */
  readonly platform: string;
  /** OS の版（`os.release()`）。 */
  readonly osRelease: string;
  /** CPU のアーキテクチャ（`process.arch`）。 */
  readonly arch: string;
  readonly playwrightVersion: string;
  /** Chromium の版。ブラウザを起動できなかった場合は `null`。 */
  readonly chromiumVersion: string | null;
  /** 実際の User-Agent。そのビューポートでページを開かなかった場合は `null`。 */
  readonly userAgents: Readonly<Record<ViewportProfile, string | null>>;
}

/** ビューポートごとの、ページの状態の件数。 */
export interface ViewportPageCounts {
  readonly audited: number;
  readonly partial: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * 安全のためにブロックした操作の件数（Passive と Interaction の両方のフェーズを含む）。
 * Safety Ledger の記録には上限があり、上限を超えた操作は数えられないことがあるので、各件数は下限である
 * （上限に達したかは `RunSafetySummary.recordTruncated` で分かる）。
 */
export interface SafetyBlockedActionCounts {
  readonly requests: number;
  readonly navigations: number;
  readonly externalActions: number;
  readonly popups: number;
  readonly downloads: number;
  readonly webSockets: number;
}

/**
 * 不変条件の違反の1件（CC-015）。違反の形の owner はここだけで、Safety Ledger の `InvariantViolationEvent`
 * （`src/safety/safety-ledger.ts`）は、この型の別名。
 */
export interface SafetyInvariantViolationSummary {
  readonly code: string;
  readonly message: string;
}

/** run.json の Safety Ledger の要約（設計書 第35章）。 */
export interface RunSafetySummary {
  readonly guardEnabled: boolean;
  readonly blockedRequestsByMethod: Readonly<Record<string, number>>;
  /**
   * ブロックした操作の件数。記録の上限があるため、件数は下限である（`recordTruncated` が真なら、実際の件数はこれより多いことがある）。
   * ブロックした操作の記録そのもの（URL・理由など）は、ページの safety の Evidence（`SafetyEventsEvidence`）が持つ。
   */
  readonly blockedActions: SafetyBlockedActionCounts;
  /** 安全のため機械的に除外した Interaction の候補の件数。 */
  readonly excludedInteractionCandidateCount: number;
  /** 記録できなかった分も含む、不変条件の違反の総数。0 より大きければ COMPLETE にしない。 */
  readonly invariantViolationCount: number;
  /** 記録できた不変条件の違反。 */
  readonly invariantViolations: readonly SafetyInvariantViolationSummary[];
  /** Safety Ledger の記録が上限で不完全になったか。 */
  readonly recordTruncated: boolean;
}

/**
 * 1つの区分（許可 Origin、またはそれ以外）の、ネットワークに送った要求の実績（サイトへの負荷の制御の設計書 4.5）。
 * 値は 0 以上の整数。
 */
export interface RunLoadOriginRequests {
  /** 数えた要求の件数。 */
  readonly count: number;
  /** 直近の1分（`LOAD_PEAK_WINDOW_MS`、`src/crawl/load-meter.ts`）の件数の最大。 */
  readonly peakPerMinute: number;
}

/**
 * run.json の `load.requests`（サイトへの負荷の制御の設計書 4.5）。数えるのは `LoadMeter`（`src/crawl/load-meter.ts`）だけで、
 * `LoadMeter.snapshot()` がこの形の値を返す。値は 0 以上の整数。
 */
export interface RunLoadRequests {
  /** 許可 Origin への要求。 */
  readonly allowedOrigins: RunLoadOriginRequests;
  /** 許可 Origin の外への要求。 */
  readonly otherOrigins: RunLoadOriginRequests;
  /** Run 全体のキャッシュから返した（ネットワークに送らなかった）要求の件数。 */
  readonly servedFromCache: number;
  /** 許可 Origin の外への要求のうち、送らなかったものの件数。 */
  readonly withheldOtherOrigins: number;
}

/**
 * run.json の `load`（サイトへの負荷の制御の設計書 3.1 の7、4.5）。Run Coordinator が、Browser を閉じた後の値で組み立てる。
 * 値はすべて 0 以上の整数。
 */
export interface RunLoad {
  /** 実効の設定の `crawl.minNavigationIntervalMs`（ページの読み込みの開始の最小の間隔。ms）。 */
  readonly minNavigationIntervalMs: number;
  /** 実効の設定の `crawl.maxInteractionsPerPage`（1ページで監査する Interaction の候補の上限）。 */
  readonly maxInteractionsPerPage: number;
  /**
   * 間隔の判定に使った読み込みの開始の回数（`NavigationPacer.snapshot().navigationCount`）。待った後に読み込みを始められなかった
   * 場合も含むので、実際の読み込みの回数より多いことがある（多めに数える側）。
   */
  readonly navigationCount: number;
  /** 間隔のために待った時間の合計（ms。`NavigationPacer.snapshot().totalWaitMs`）。 */
  readonly pacingWaitMs: number;
  /** 監査対象のサイトに送った要求の実績（`LoadMeter.snapshot()`）。 */
  readonly requests: RunLoadRequests;
}

/**
 * 区分ごとの、直近の1分（`LOAD_PEAK_WINDOW_MS`、`src/crawl/load-meter.ts`）に終わった要求の件数（サイトへの負荷の制御の設計書 4.8）。
 * 数えるのは `LoadMeter` だけで、`LoadMeter.recentPerMinute()` がこの形の値を返す。値は 0 以上の整数。
 */
export interface RunLoadRecentPerMinute {
  /** 許可 Origin への要求。 */
  readonly allowedOrigins: number;
  /** 許可 Origin の外への要求。 */
  readonly otherOrigins: number;
}

/**
 * 実行中の進み具合の事実（サイトへの負荷の制御の設計書 4.8）。Run Coordinator が、ページの監査が1つ終わるたびに（`markFinished` と
 * Link からの発見の後に）組み立て、注入された受け手（`RunCoordinatorDependencies.onProgress`）に渡す。JSON にできる、凍結した値。
 * 表示の側は、この値を書式にかけるだけで、数え直したり計算したりしない。run.json には書かない（最後の記録は `RunSummary.load`）。
 */
export interface RunProgressReport {
  /**
   * 監査を終えたページの数（`markFinished` したページの数）。再開した Run では、再開の前に終わったページを含む（Run の全体で、監査を
   * 終えたページの数）。
   */
  readonly pagesFinished: number;
  /** 発見したページの数（開始の URL を含む。`CrawlFrontier.discoveredCount`）。 */
  readonly pagesDiscovered: number;
  /** 設定の `crawl.maxPages`。 */
  readonly maxPages: number;
  /** この実行の開始からの経過時間（ms。注入した `now` で測る。0 以上）。 */
  readonly elapsedMs: number;
  /** 間隔の判定に使った読み込みの開始の回数（`NavigationPacer.snapshot().navigationCount`。`RunLoad.navigationCount` と同じ意味）。 */
  readonly navigationCount: number;
  /** 間隔のために待った時間の合計（ms。`NavigationPacer.snapshot().totalWaitMs`）。 */
  readonly pacingWaitMs: number;
  /** 監査対象のサイトに送った要求の実績（`LoadMeter.snapshot()`）。 */
  readonly requests: RunLoadRequests;
  /** 区分ごとの、直近の1分に終わった要求の件数（`LoadMeter.recentPerMinute()`）。 */
  readonly recentPerMinute: RunLoadRecentPerMinute;
}

/** クロールの上限に達したか。 */
export interface CrawlLimitState {
  readonly maxPagesReached: boolean;
  readonly maxDepthReached: boolean;
  readonly maxRuntimeReached: boolean;
}

/**
 * Run Coordinator が URL ごとに持つ状態の閉じた一覧（Task 14〜17 の設計書 5.1、5.6.3）。巡回の記録の owner は
 * `src/orchestration/crawl-frontier.ts`（`CrawlFrontier`）で、同じ名前で export し直している。値の一覧は、再開のための保存の
 * スキーマ（`schemas/checkpoint.schema.json` の巡回の記録の `state`）の enum と一致させるため、ここに置く（共通部品台帳 2.2。
 * 中断した Run の再開の設計書 4.2、R2 の Blocker B2）。
 * - `DISCOVERED`: 発見した（ページの ID を採番した）。
 * - `QUEUED`: キューに入れた。
 * - `AUDITING`: 監査している。
 * - `AUDITED`: 監査を終えた（ページの状態が `AUDITED` か `PARTIAL`）。
 * - `SKIPPED`: 監査しなかった（上限など）。
 * - `FAILED`: 監査を終えたが、ページの状態が `FAILED` だった。
 */
export const CRAWL_URL_STATES = Object.freeze(['DISCOVERED', 'QUEUED', 'AUDITING', 'AUDITED', 'SKIPPED', 'FAILED'] as const);
export type CrawlUrlState = (typeof CRAWL_URL_STATES)[number];

export interface RunSummary {
  readonly schemaVersion: 'run-schema/1.0';
  readonly runId: RunId;
  readonly toolVersion: string;
  readonly target: {
    readonly id: string;
  };
  readonly startUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly runStatus: RunStatus;
  /** Run の開始の時刻（ISO 8601）。再開した Run では、最初の実行の開始（中断した Run の再開の設計書 4.8）。 */
  readonly startedAt: string;
  /** Run の終わりの時刻（ISO 8601）。再開した Run では、最後の実行の終わり（`executions` の最後の `finishedAt` と同じ値）。 */
  readonly finishedAt: string | null;
  /**
   * 実行（起動）の記録（中断した Run の再開の設計書 4.8。R4b2）。各実行の開始と終わりの時刻と、終わり方を、実行の順に並べる（1件以上）。
   * 最後のものが、この Run を確定した実行である。再開していない Run は、1件だけ持つ。各実行の環境は持たない（`environment` は最初の
   * 実行のもの。各実行の環境は、再開のための保存 `checkpoint/state.json` に残す）。組み立てるのは Run Coordinator だけである。
   */
  readonly executions: readonly [RunExecution, ...RunExecution[]];
  /** 発見した内部の URL の数。開始の URL を含む（Task 14〜17 の設計書 5.6.5）。 */
  readonly discoveredPageCount: number;
  /** ページの状態が `AUDITED` のページの数。 */
  readonly auditedPageCount: number;
  /** ページの状態が `PARTIAL` のページの数（Task 14〜17 の設計書 5.6.5）。 */
  readonly partialPageCount: number;
  /** ページの状態が `FAILED` のページの数。 */
  readonly failedPageCount: number;
  /** ページの状態が `SKIPPED` のページの数。 */
  readonly skippedPageCount: number;
  readonly viewportPageCounts: Readonly<Record<ViewportProfile, ViewportPageCounts>>;
  readonly environment: RunEnvironment;
  readonly effectiveConfig: EffectiveAuditConfig;
  readonly safety: RunSafetySummary;
  /** 検証できなかった（`NOT_VERIFIABLE`・`EXECUTION_FAILED`）Interaction の件数。 */
  readonly unverifiedInteractionCount: number;
  /**
   * 検証できなかった内部リンクの件数（Task 14〜17 の設計書 5.3、5.6.5）。リンク先が上限などで監査されなかったもの。
   * 値は `evaluateCrossPageRules` の `unverifiedInternalLinkCount`。
   */
  readonly unverifiedInternalLinkCount: number;
  /** 再試行の前の、失敗した試行の記録（Task 14〜17 の設計書 5.6.4）。最終の試行の結果は `pages` にある。 */
  readonly retries: readonly RunRetryRecord[];
  readonly crawlLimits: CrawlLimitState;
  readonly incompleteReasons: readonly IncompleteReason[];
  /** サイトへの負荷の記録（サイトへの負荷の制御の設計書 4.5）。PREFLIGHT の失敗などで早く終わった Run にも入れる。 */
  readonly load: RunLoad;
}

/**
 * 再試行の前の、失敗した1回の試行の記録（Task 14〜17 の設計書 5.6.4）。Run Coordinator は、Desktop のナビゲーションが一時的な失敗
 * だった場合に、同じ `pageId` で `PageAuditor.audit` を呼び直す。そのときに、呼び直す前の試行をここに残す（最初の失敗の記録を消さない）。
 */
export interface RunRetryRecord {
  /** 監査した URL（`PageAuditResult.pageUrl`）。 */
  readonly url: NormalizedHttpUrlEvidence;
  /** 何回目の試行か（1から始まる整数）。 */
  readonly attempt: number;
  /** その試行の、Desktop のナビゲーションの結果の種類。 */
  readonly navigationOutcome: NavigationOutcomeKind;
  /**
   * その試行の、Desktop の `NAVIGATION_FAILED` の理由の `detail`（`TIMEOUT`、`BLOCKED_EXTERNAL_REDIRECT`、
   * `FAILED:<Chromium のエラーのコード>`、`FAILED`。作るのは `navigationFailureDetail`、`src/orchestration/page-navigation.ts`）。
   * 理由がない場合は `null`。
   */
  readonly detail: string | null;
  /**
   * その試行の Evidence の ID の一覧（試行の Evidence の順）。最初の試行の Evidence は捨てずに、最終のページの `evidence` に残す
   * （上位の設計書 10.1 の「最初の失敗 Evidence は保持する」。Task 14〜17 の設計書 5.6.4、R15 の Minor-6）。
   * その試行の Finding は残さない（Rule は、最終の試行の Evidence で評価する）。
   */
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * 確定した Run（Task 14〜17 の設計書 5.6.1）。`RunCoordinator.run()` の戻り値で、Task 16 の artifact の書き出しに渡す。
 * audit.json（`schemas/audit.schema.json`）の最上位の `run`・`pages`・`findings` にあたる。audit.json の `schemaVersion` は、
 * artifact の書き出しが付ける。
 */
export interface AuditRunResult {
  readonly run: RunSummary;
  /** URL の発見の順。監査しなかった URL の `SKIPPED` の結果も含む。 */
  readonly pages: readonly PageAuditResult[];
  /** Page rule と Cross-page rule のすべての Finding。 */
  readonly findings: readonly Finding[];
  /**
   * `run.runStatus` を導いた `deriveRunStatus` の入力（Task 14〜17 の設計書 6.1.1）。メモリの上だけの項目で、JSON には書かない
   * （audit.json と run.json に含めない）。Run Coordinator が、`deriveRunStatus` に渡したものと同じ値を入れる。
   * artifact の書き出し（`ArtifactWriter.writeRun`）は、スキーマに合わない artifact があった場合に、これの `requiredArtifactsValid` を
   * 偽にして、Run Status を `deriveRunStatus` で導き直す（ARCH05）。
   */
  readonly statusInput: RunStatusInput;
}

/**
 * 再開のための保存（`checkpoint/state.json`）の状態の閉じた一覧（中断した Run の再開の設計書 3.2、4.1）。
 * 保存の作成と、再開できるかの判定の owner は `src/orchestration/run-checkpoint.ts`。値の一覧は、スキーマ
 * （`schemas/checkpoint.schema.json` の `state`）の enum と一致させるため、ここに置く（共通部品台帳 2.2。R2 の Blocker B2）。
 * - `IN_PROGRESS`: Run の途中（プロセスが途中で終わった場合も、この状態のまま残る）。
 * - `STOPPED`: 止める印か、1回の実行の時間の上限で、今のページを終えてから止まり、最後の処理を行った（再開できることがある）。
 *   サイトの不調を検知して止まった場合も、この状態にする（サイトが応答しないときに Run を止める設計書 3.2）。
 * - `FINISHED`: 最後の処理まで行い、Run を終えた（再開の対象にしない）。
 */
export const RUN_CHECKPOINT_STATES = Object.freeze(['IN_PROGRESS', 'STOPPED', 'FINISHED'] as const);
export type RunCheckpointState = (typeof RUN_CHECKPOINT_STATES)[number];

/**
 * 1回の実行（起動）の終わり方の閉じた一覧（中断した Run の再開の設計書 4.8）。実行の途中は、終わり方を `null` にする。
 * 値の一覧は、スキーマ（`schemas/checkpoint.schema.json` の実行の記録の `endReason`）の enum と一致させるため、ここに置く
 * （共通部品台帳 2.2。R2 の Blocker B2）。
 * - `COMPLETED`: 最後の処理まで行った。
 * - `STOPPED_BY_RUNTIME_LIMIT`: 1回の実行の時間の上限で止まった。
 * - `STOPPED_BY_SIGNAL`: 止める印（Ctrl+C など）で止まった。
 * - `STOPPED_BY_SAFETY_VIOLATION`: 安全の不変条件の違反で止まった。
 * - `STOPPED_BY_SITE_UNAVAILABLE`: サイトの不調（時間切れ、ネットワークの層の失敗、429・502・503・504 の応答。判定は
 *   `src/orchestration/site-availability.ts`）を検知して止まった（サイトが応答しないときに Run を止める設計書 3.2）。再開できる。
 * - `INTERRUPTED_ABNORMALLY`: プロセスが途中で終わった（終わりの時刻は、最後の保存の時刻とする）。
 */
export const RUN_EXECUTION_END_REASONS = Object.freeze([
  'COMPLETED',
  'STOPPED_BY_RUNTIME_LIMIT',
  'STOPPED_BY_SIGNAL',
  'STOPPED_BY_SAFETY_VIOLATION',
  'STOPPED_BY_SITE_UNAVAILABLE',
  'INTERRUPTED_ABNORMALLY',
] as const);
export type RunExecutionEndReason = (typeof RUN_EXECUTION_END_REASONS)[number];

/**
 * `run.json` の、終えた1回の実行（起動）の記録（中断した Run の再開の設計書 4.8。R4b2。`RunSummary.executions` の項目）。
 * 実行の途中を表す `null` は持たない（`run.json` は、実行を終えてから書くため）。前の回のプロセスが途中で終わった実行は、終わり方を
 * `INTERRUPTED_ABNORMALLY`、終わりの時刻を、その実行の最後の保存の時刻にしたもの。
 */
export interface RunExecution {
  /** 実行の開始の時刻（ISO 8601）。 */
  readonly startedAt: string;
  /** 実行の終わりの時刻（ISO 8601）。 */
  readonly finishedAt: string;
  /** 実行の終わり方。 */
  readonly endReason: RunExecutionEndReason;
}
