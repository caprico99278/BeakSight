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

/** `PageAuditor.audit(url, pageId)` の戻り値（Task 14〜17 の設計書 4.5.1）。 */
export interface PageAuditOutcome {
  readonly result: PageAuditResult;
  readonly safety: PageSafetySummary;
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

/** クロールの上限に達したか。 */
export interface CrawlLimitState {
  readonly maxPagesReached: boolean;
  readonly maxDepthReached: boolean;
  readonly maxRuntimeReached: boolean;
}

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
  readonly startedAt: string;
  readonly finishedAt: string | null;
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
   * `FAILED:<Chromium のエラーのコード>`、`FAILED`。作るのは `navigationFailureDetail`、`src/orchestration/page-auditor.ts`）。
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
