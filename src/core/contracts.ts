import type {
  AccessibilityEvidence,
  ColorEvidence,
  ConsoleEvidence,
  DomEvidence,
  EffectiveAuditConfig,
  FocusCheckEvidence,
  InteractionEvidence,
  LayoutEvidencePayload,
  LinkDiscoveryEvidence,
  MetadataEvidence,
  NavigationOutcomeKind,
  NetworkEvidence,
  NormalizedHttpUrlEvidence,
  PageSchemaVersion,
  PerformanceEvidence,
  SafetyEventsEvidence,
  ScreenshotEvidence,
  ScrollEvidence,
  SessionLossEvidence,
} from './evidence-types.js';
// 型だけの import（実行時の依存はない。`status.ts` は、このファイルの型と値を使う）。
import type { RunStatusInput } from './status.js';
import type { RunPages } from './run-page-store.js';
import type { ProgressWatchEnd } from './progress-watch.js';
import type { AuditSendPolicyName } from './audit-send-policy.js';
import type { RunPageScopeRecord } from './audit-page-scope.js';
// 未完了の理由の確かめ（`isIncompleteReason`）が使う。`guards.ts` は何も import しない。
import { isRecord } from './guards.js';

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
  /**
   * DEF-129: ビューポートの Context で、ページが始めた文書の読み込み（main frame か子の frame の、JS の読み込み直しや移動、meta の転送）を、Guard が
   * frame ごとの上限（`src/safety/passive-request-guard.ts` の `PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`）で止めた（画面が落ち着かず、読み切れて
   * いない）。`detail` は `null`。
   */
  'PAGE_NAVIGATION_LIMIT_REACHED',
  /**
   * DEF-130-fix: ビューポートの Context で、1 画面の読み込みあたりの、ページが出す文書でない要求（画像・`fetch`・`xhr` など）を、Guard が上限
   * （前は 1,000）で止めた（画面がデータを描き切れず、読み切れていない）。`detail` は `null`。L10（S5）で上限を撤廃したので今は付かない（前の記録の
   * 読み方のために一覧に残す）。
   */
  'PAGE_SUBRESOURCE_LIMIT_REACHED',
  /**
   * DEF-210（通知の枠の設計書 3.2.1 の 4）: 通知の枠の閉じるボタンを押した期間に、ページが main frame の移動（読み込み直し・フォームの送信を含む）を試み、Guard が
   * 止めた。誤りの画面を測らないため、そのビューポート（幅の走査ではその幅）の測りをしない。読み込み直しはしない。`detail` は `null`。
   */
  'NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED',
  /**
   * DEF-250 の c: Passive の page の段の間に、ページが main frame で外部スキーム（mailto など）へ移ろうとしたか、文書が誤りの画面に替わった（閉じた）ので、残りの
   * 段を始めずに、そのビューポートを終えた（終える前に集めた証拠は残る。Mobile と次のページは続ける）。判定は `src/orchestration/stress-width-end.ts` の
   * `auditDocumentLeftCause`。`detail` は `<段>:<原因>`（原因は `EXTERNAL_SCHEME`・`DOCUMENT_GONE`）。
   */
  'DOCUMENT_LEFT_DURING_AUDIT',
  /**
   * DEF-225: 画面を開くと、ファイルのダウンロードになった（添付の形の応答など）。Guard はダウンロードを止めて取り消し、main frame の移動は失敗した（違反ではない。
   * `src/safety/passive-request-guard.ts` の `pageLoadFactsOf` の `mainFrameDownloadBlocked`）。そのビューポートは読めず、同じ URL をほかのビューポートで読み直さない。
   * `detail` は `null`。
   */
  'DOWNLOAD_RESPONSE',
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
  /**
   * 認証つきの Run（Task 25 の設計書 4.3、4.7。T25c）で、監査の段の main frame の最後の URL がセッションの切れ（ログインの画面）の path に
   * 当たったため、そのページを監査せず、その後の監査を始めなかった。公開監査（認証の指定のない Run）では現れない。
   * - 止まるきっかけのページ（捨てたページ）と、始めなかったページ（`SKIPPED`）の理由。きっかけのページの `detail` は、当たった場所
   *   （`<ビューポート>:<段階>`。例: `desktop:passive`、`desktop:stress-layout`。URL は入れない）。始めなかったページの `detail` は `null`。
   * - Run の理由にも1件残す（`detail` は `null`。SKIPPED のページから、最後の処理で導く）。
   * - 当たったビューポートの理由としても使い（`FAILED`。`detail` は `<段階>`）、その後に始めなかったビューポートは `SKIPPED`（`detail` は `null`）。
   * - 再開のときは、この理由の SKIPPED の URL を、待ち行列に戻す（`RESUME_REQUEUE_SKIP_REASON_CODES`）。再開のときのログインは T25d。
   * Run Status は、SKIPPED のページがあるので、`deriveRunStatus` が `PARTIAL` と導く（このコードでは決めない）。
   */
  'AUTH_SESSION_LOST',
  /**
   * スクリプトで送るログインの監査の Run（Task 35 の設計書 3.4。T35a で値を足し、記録の流れは T35c）で、承認したサービスの Origin への要求の上限
   * （1 分あたりか、1 回の Run あたり。認証の設定の `serviceRequestLimits`）に届いたため、その後の監査を始めなかった。公開監査とフォームの送信の
   * ログインの監査では現れない。止めた要求は、Guard の止めた理由 `SERVICE_REQUEST_LIMIT_REACHED`（`BLOCKED_REQUEST_REASONS`）で記録する。
   * - 始めなかったページ（`SKIPPED`）の理由。`detail` は `null`。Run の理由にも 1 件残す（SKIPPED のページから、最後の処理で導く）。
   * - 再開のときは、この理由の SKIPPED の URL を、待ち行列に戻す（`RESUME_REQUEUE_SKIP_REASON_CODES`。T35c。再開の実行は新しい上限で数える）。
   * Run Status は、SKIPPED のページがあるので、`deriveRunStatus` が `PARTIAL` と導く（このコードでは決めない）。
   */
  'SERVICE_REQUEST_LIMIT_REACHED',
  /**
   * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 進みの見張り（`src/core/progress-watch.ts`）が、ブラウザからの応答・ページの通信・
   * 画面の変化のどれもない状態が反応なしの長さ（`PROGRESS_WATCH_QUIET_LIMIT_MS`）続いたため、その段を「応答しなかった」として終えた。それまでに集めた
   * 記録は残し、次へ進む。`detail` は段の名前（`PageAuditStage`）。
   */
  'STAGE_UNRESPONSIVE',
  /**
   * L0: 進みの見張りが、段の中身の進み（応答・分けて読む回）がなく、ページの自発の変化（時計・アニメーションなどの周期的な変化）だけが反応なしの長さ
   * 続いたため、その段を「静まらない」として終えた。それまでに集めた記録は残し、次へ進む。`detail` は段の名前。
   */
  'STAGE_NEVER_QUIET',
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
  // AUD-2d: 落ち着いた後の確かめ直し（DOM が静まるまで待ち、見出しを読み直し、1 回目に違反のあった axe のルールだけを流し直す）。
  'recheck',
  // AUD-4d: 画面の外の、フォーカスできる要素にフォーカスを当てて読む（ほかの証拠を集め終えた後。ページの JS が状態を変えても、後の証拠を汚さないため）。
  'focus-check',
  'links',
  'interaction-discovery',
  'interaction',
  // COV-4 の区切り 3: 見るだけの点検の操作で開いた状態に、今の段（DOM・layout・axe・フォーカスの確かめ・画像）を、読み込み直さずに当てる。
  'opened-state',
  'safety',
  'rules',
] as const);
export type PageAuditStage = (typeof PAGE_AUDIT_STAGES)[number];

/** 未完了の理由。`detail` は、理由の補足（どの collector か、どのURLか、など）。補足がなければ `null`。 */
export interface IncompleteReason {
  readonly code: IncompleteReasonCode;
  readonly detail: string | null;
}

/**
 * 未完了の理由のコード（`INCOMPLETE_REASON_CODES` の値）か（CC-034。理由のコードの閉じた一覧に入っているかの確かめは、ここに1つだけ置く）。
 * 保存から読んだ値など、型の印のない値を確かめるのに使う。
 */
export const isIncompleteReasonCode = (value: unknown): value is IncompleteReasonCode =>
  typeof value === 'string' && (INCOMPLETE_REASON_CODES as readonly string[]).includes(value);

/** 未完了の理由の `detail`（文字列か `null`）か（CC-034）。 */
export const isIncompleteReasonDetail = (value: unknown): value is IncompleteReason['detail'] =>
  value === null || typeof value === 'string';

/**
 * 未完了の理由（`IncompleteReason`）か（CC-034）。配列でないオブジェクトで、コードが `isIncompleteReasonCode`、自分の項目の `detail` が
 * `isIncompleteReasonDetail` を満たすものだけを受ける（受け継いだだけの `detail` は受けない）。
 */
export const isIncompleteReason = (value: unknown): value is IncompleteReason =>
  isRecord(value)
  && isIncompleteReasonCode(value.code)
  && Object.hasOwn(value, 'detail')
  && isIncompleteReasonDetail(value.detail);

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
  /** AUD-4d: 画面の外の、フォーカスできる要素のフォーカスの確かめ（段 `focus-check`）。 */
  readonly focus: FocusCheckEvidence;
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
  'focus',
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
  /**
   * AUD-2a（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2a）: 集めた状態と時刻（Page Auditor のビューポートの Evidence だけ）。
   * 前の Run の記録と、ビューポートによらない Evidence にはない。バンドルと記録にだけ出す（画面と HTML の本文には出さない）。
   */
  readonly capture?: EvidenceCapture;
}

/**
 * AUD-2a: ビューポートの読み込みの状態 ID（`<pageId>:<ビューポート>:<試行>`）。同じ読み込みで集めた Evidence は、同じ値を持つ。作るのは `evidenceStateIdOf` だけ。
 */
export type EvidenceStateId = string;

/** AUD-2a: 状態 ID を作る（唯一の作り方）。`attempt` は、Run Coordinator の試行の番号（1 から）。 */
export const evidenceStateIdOf = (pageId: PageId, viewport: ViewportProfile, attempt: number, openedStateIndex: number | null = null): EvidenceStateId => {
  const loadStateId = `${pageId}:${viewport}:${String(attempt)}`;
  return openedStateIndex === null ? loadStateId : openedEvidenceStateIdOf(loadStateId, openedStateIndex);
};

/** COV-4 の区切り 3: 読み込みの状態 ID から、その読み込みで操作して開いた状態の ID（`:state-<番号>`。番号は 1 から）。 */
export const openedEvidenceStateIdOf = (loadStateId: EvidenceStateId, openedStateIndex: number): EvidenceStateId =>
  `${loadStateId}:state-${String(openedStateIndex)}`;

/**
 * AUD-2a: 状態 ID の形（page の schema の `pattern` と同じ）。COV-4 の区切り 3: 見るだけの点検の操作で開いた状態は、その読み込みの状態 ID に `:state-<番号>`
 * （1 から）を付ける。
 */
export const EVIDENCE_STATE_ID_PATTERN = /^PAGE-[0-9]{6,}:(?:desktop|mobile):[1-9][0-9]*(?::state-[1-9][0-9]*)?$/u;

/** AUD-2a: 集めたときの、文書のスクロールの位置（CSS ピクセル）。 */
export interface EvidenceCaptureScrollPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * AUD-2a: 1 つの Evidence を集めた状態と時刻。
 * - `phase`: 集めた段の名前（`PAGE_AUDIT_STAGES` の閉じた一覧。network・console は読み込みから集めた `navigation`）。
 * - `startedAt`・`finishedAt`: 段を始めた時刻と終えた時刻（ISO 8601。Desktop の layout は、幅の走査の後に包んでも、測った時刻）。
 * - `url`: 段を終えたときの main frame の URL（読めなければ `null`）。`scrollPosition`: 段を終えたときの位置（読めなければ `null`）。
 */
export interface EvidenceCapture {
  readonly stateId: EvidenceStateId;
  readonly phase: PageAuditStage;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly url: string | null;
  readonly scrollPosition: EvidenceCaptureScrollPosition | null;
}

/**
 * AUD-2a: 見張りが段を終えた理由の閉じた一覧（記録の `settling.watchEnd` の値。page の schema の enum と対にする）。値の意味の owner は
 * `src/core/progress-watch.ts` の `ProgressWatchEnd`（`satisfies` で、その型の値だけであることを確かめる）。
 */
export const VIEWPORT_SETTLING_WATCH_ENDS = Object.freeze(['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET', 'RUN_TIME_LIMIT'] as const satisfies readonly ProgressWatchEnd[]);

/**
 * AUD-2b（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2b）: 読み込みの段の閉じた一覧（この順に進む。判定は `src/browser/page-settling.ts`）。
 * - `AFTER_DOM_CONTENT_LOADED`: DOM の準備ができた（`domcontentloaded`）。
 * - `LOADING`: 文書かデータ（fetch・XHR）を読んでいる。
 * - `AFTER_DATA`: データが届いた（途中の数が 0、または静まりの窓の間にデータの通信が動かなかった）が、高さか DOM がまだ変わる。
 * - `SETTLED`: 高さが静まり、DOM の変化も静まり、データも届いた。
 */
export const PAGE_LOAD_PHASES = Object.freeze(['AFTER_DOM_CONTENT_LOADED', 'LOADING', 'AFTER_DATA', 'SETTLED'] as const);
export type PageLoadPhase = (typeof PAGE_LOAD_PHASES)[number];

/** AUD-2b: 読み込みの段が変わった時刻（ISO 8601）。 */
export interface PageLoadPhaseRecord {
  readonly phase: PageLoadPhase;
  readonly at: string;
}

/** AUD-2a: 安定の判定の結果の状態（判定を終えた・途中で終えた・段を終えられなかった）。 */
export const VIEWPORT_SETTLING_STATUSES = Object.freeze(['SETTLED', 'PARTIAL', 'NOT_COMPLETED'] as const);
export type ViewportSettlingStatus = (typeof VIEWPORT_SETTLING_STATUSES)[number];

/**
 * AUD-2a: ビューポートの安定の判定（`page-settling.ts`。L0・L1 の見張りつき）の結果。`reason` は判定の理由（`DOM_AND_HEIGHT_STABLE` など。段を終えられなければ
 * `null`）、`elapsedMs` は段の経過、`observationCount` は観測の数、`lastScrollHeight` は最後の観測の文書の高さ（観測がなければ `null`）、`watchEnd` は見張りが段を
 * 終えた理由（`ProgressWatchEnd` の値。終えなければ `null`）。
 */
export interface ViewportSettlingRecord {
  readonly status: ViewportSettlingStatus;
  readonly reason: string | null;
  readonly elapsedMs: number;
  readonly observationCount: number;
  readonly lastScrollHeight: number | null;
  readonly watchEnd: ProgressWatchEnd | null;
  /** AUD-2b: 読み込みの段の移り変わり（変わった時だけ。AUD-2b の前の記録にはない）。 */
  readonly loadPhases?: readonly PageLoadPhaseRecord[];
}

/**
 * AUD-2d（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2d）: 落ち着いた後の確かめ直しの印の閉じた一覧。
 * - `PERSISTENT`: 1 回目にも確かめ直しにもある（続く）。
 * - `INITIAL_ONLY`: 1 回目だけにある（初めの骨組みの時だけ。確かめ直しでは消えた）。
 * - `LATE`: 確かめ直しだけにある（後から出た）。
 */
export const RECHECK_STATES = Object.freeze(['PERSISTENT', 'INITIAL_ONLY', 'LATE'] as const);
export type RecheckState = (typeof RECHECK_STATES)[number];

/** AUD-2d: 確かめ直しの状態（確かめ直した・確かめ直さなかった）。 */
export const VIEWPORT_RECHECK_STATUSES = Object.freeze(['RECHECKED', 'NOT_RECHECKED'] as const);
export type ViewportRecheckStatus = (typeof VIEWPORT_RECHECK_STATUSES)[number];

/**
 * AUD-2d: 確かめ直さなかった理由の閉じた一覧（1 回目の DOM を読めなかった・確かめ直しの段を終えられなかった）。AUD-2e: 1 回目に axe の違反がない
 * ビューポートも、axe（全部のルール）と主の layout を確かめ直す（`RECHECKED`）。`axeRuleIds` が空になるのは、どちらの回にも違反がないとき（axe を止めた設定を含む）。
 */
export const RECHECK_SKIP_REASONS = Object.freeze(['FIRST_PASS_NOT_COMPLETED', 'STAGE_NOT_COMPLETED'] as const);
export type RecheckSkipReason = (typeof RECHECK_SKIP_REASONS)[number];

/** AUD-2d: 確かめ直した指摘の印（Finding の `fingerprint` で結ぶ。`LATE` は 1 回目の Finding がないので、確かめ直しの評価の fingerprint）。 */
export interface RecheckFindingRecord {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly state: RecheckState;
}

/** AUD-2d: 読み直した見出しの印（見出しの段と文字で結ぶ）。 */
export interface RecheckHeadingRecord {
  readonly level: number;
  readonly text: string;
  readonly state: RecheckState;
}

/**
 * AUD-2d: 落ち着いた後の確かめ直しの表（ビューポートの記録の 1 か所。表示用モデルとバンドルは、これを読むだけ）。読み込み直さない。`axeRuleIds` は、1 回目か確かめ直しで違反のあった axe のルール（AUD-2e。確かめ直しの axe は全部のルールで流す）。
 * 見出しと指摘の印は、変わらないものも含めて全部（`PERSISTENT` を含む）。確かめ直さなかったら `reason` に理由を書き、表は空。
 */
export interface ViewportRecheckRecord {
  readonly status: ViewportRecheckStatus;
  readonly reason: RecheckSkipReason | null;
  readonly stateId: EvidenceStateId;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** 確かめ直しの前の、DOM が静まるまでの待ち（`settling` と同じ形。待たなかったら `null`）。 */
  readonly settling: ViewportSettlingRecord | null;
  readonly axeRuleIds: readonly string[];
  readonly findings: readonly RecheckFindingRecord[];
  readonly headings: readonly RecheckHeadingRecord[];
  /**
   * EV-3: 確かめ直しで読み直した画面の準備の状態（`pageReadyOf`。確かめ直した（`RECHECKED`）ときだけ。前の版の記録にはない）。1 回目の状態の DOM の記録と
   * 合わせて、内容の指摘を「初めだけ」（確かめ直しの印 `INITIAL_ONLY`）・「完成した後も続く」・「準備が終わらない」（偽）に分ける。
   */
  readonly pageReady?: boolean;
}

/** AUD-2a: ビューポートの通知の枠の扱い（主の読み込み。閉じた数・隠した数・見た枠の digest）。 */
export interface ViewportNotificationHandlingRecord {
  readonly dismissedCount: number;
  readonly hiddenCount: number;
  readonly digests: readonly string[];
}

export type EvidenceRecord = {
  readonly [TType in EvidenceType]: EvidenceRecordFor<TType>;
}[EvidenceType];

/**
 * Finding の版。1.1（AUD-9a）で `groupingKeys` を足した。新しい Finding は 1.1。1.0 は欄のない古い Run の Finding（読むだけ）。
 * schema の URN は `urn:beaksight:schema:finding:1.0` のまま（足すだけの変更なので、page と audit の schema の参照を変えない）。
 */
export const FINDING_SCHEMA_VERSIONS = Object.freeze(['finding-schema/1.0', 'finding-schema/1.1'] as const);
export type FindingSchemaVersion = (typeof FINDING_SCHEMA_VERSIONS)[number];
export const CURRENT_FINDING_SCHEMA_VERSION: FindingSchemaVersion = 'finding-schema/1.1';

/** Finding のまとめの鍵の 1 つ（AUD-9a。許可の一覧は `src/audit/finding-grouping-keys.ts`）。 */
export interface FindingGroupingKeyRecord {
  readonly name: string;
  readonly value: string;
}

export interface Finding {
  readonly schemaVersion: FindingSchemaVersion;
  /**
   * AUD-9a: 同じ UI の繰り返しを後でまとめるための鍵。Rule の同一性の要素のうち、selector の類と Rule の識別だけを、同じ値で残す（fingerprint の入力とは別のもの）。
   * 1.1 の Finding は必ず持つ（空の配列もある）。1.0 の Finding（古い Run）にはない。
   */
  readonly groupingKeys?: readonly FindingGroupingKeyRecord[];
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
  /**
   * DEF-129・T37R2-fix・DEF-130-fix: そのビューポートの Context で、Guard が通した main frame の文書・子の frame の文書・文書でない要求の数。SPEC-1 で
   * 書くのをやめた（どの表示も読まなかった）。前の書き手の成果物を読むために型だけ残す。
   */
  readonly documentRequests?: number;
  readonly childFrameDocumentRequests?: number;
  readonly subresourceRequests?: number;
  /** AUD-2a: このビューポートの読み込みの状態 ID（`evidenceStateIdOf`）。前の Run の記録にはない。 */
  readonly stateId?: EvidenceStateId;
  /** AUD-2a: 安定の判定の結果（判定の段を始めなかったビューポートと、前の Run の記録にはない）。 */
  readonly settling?: ViewportSettlingRecord;
  /** AUD-2a: 通知の枠の扱い（扱いの段を始めなかったビューポートと、前の Run の記録にはない）。 */
  readonly notificationHandling?: ViewportNotificationHandlingRecord;
  /** AUD-2d: 落ち着いた後の確かめ直しの表（収集をしなかったビューポートと、前の Run の記録にはない）。 */
  readonly recheck?: ViewportRecheckRecord;
}

export interface PageAuditResult {
  /** BN-a: 書くのはいつも最新の版（`PAGE_SCHEMA_VERSION`）。前の版（保存から読んだ結果）も読める（`PAGE_READABLE_SCHEMA_VERSIONS`）。 */
  readonly schemaVersion: PageSchemaVersion;
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
  /** SAFE-2 の 4: frame の判定の失敗の記録の数（違反でない。`frameClassificationFailures.count` の合計。飽和）。 */
  readonly frameClassificationFailureCount: number;
  /** SAFE-2 の 4: 読み取りの main frame の移動の失敗の記録の数（違反でない。`readNavigationFailures.count` の合計。飽和）。 */
  readonly readNavigationFailureCount: number;
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
   * 認証つきの Run（Task 25 の設計書 4.3。T25c）で、そのページの監査の段の main frame の最後の URL が、セッションの切れの path に当たった
   * 場所（`<ビューポート>:<段階>`。例: `desktop:passive`）。当たらなければ `null`。省略は `null` と同じ（公開監査と、偽の Page Auditor）。
   * Run Coordinator は、これが `null` でなければ、そのページを捨てて、理由 `AUTH_SESSION_LOST` で Run を止める。Page の結果の JSON には含めない。
   */
  readonly authSessionLostDetail?: string | null;
  /**
   * DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.1）: `authSessionLostDetail` を返したときの、セッションの切れの証拠（値を
   * 持たない）。組み立てられなかったときと、検知しなかったときは `null`。省略は `null` と同じ。Page の結果の JSON には含めない。
   */
  readonly authSessionLoss?: SessionLossEvidence | null;
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
  /**
   * DEF-144: 違反が 1 つの要求に結びつくとき（Guard の判定の段階の誤り、CDP の付いていない page のナビゲーション）の、その要求の method と Origin と path
   * （Safety Ledger が URL から取り出す。query・fragment・本文・値は持たない。path の値に見える区切りは伏せる）。結びつかない違反は持たない。
   */
  readonly request?: SafetyInvariantViolationRequest;
}

/** DEF-144: 違反に結びつく要求（値を持たない）。`origin` は正規の Origin（http(s) でない・読めない URL は `null`）。 */
export interface SafetyInvariantViolationRequest {
  readonly method: string;
  readonly origin: string | null;
  readonly path: string;
}

/**
 * DEF-144: 発見と READ の確かめのジョブで、違反が起きた段（最初に違反を見た段）。組み立ては `src/safety/job-safety-violation.ts` の
 * `jobSafetyViolationOf`（形はここが owner。`src/discovery/` と `src/control/` が型を参照するため core に置く）。
 * - `CONTEXT_OPEN`: Context と page を作る間（読み込みの前）。
 * - `PAGE_LOAD`: 読み込みと読み取り（発見の候補の読み取り、凍結、リンクの抽出。READ の確かめの読み取り）。
 * - `SUBMISSION_PROBE`: 発見の、送らずに観察する probe の押下の中（押した候補は `press`）。
 * - `CONTEXT_CLOSE`: 読み取りの後、Context を閉じる間（閉じた後の Ledger で初めて見た）。
 */
export const JOB_SAFETY_VIOLATION_STAGES = Object.freeze(['CONTEXT_OPEN', 'PAGE_LOAD', 'SUBMISSION_PROBE', 'CONTEXT_CLOSE'] as const);
export type JobSafetyViolationStage = (typeof JOB_SAFETY_VIOLATION_STAGES)[number];

// LZ-3a: 残す違反の一覧の数の上限（前は `MAX_JOB_SAFETY_VIOLATION_ENTRIES` 16）は撤廃した（スキーマにも `maxItems` を置かない）。
// LZ-2: 違反の文の長さの上限（前は `MAX_JOB_SAFETY_VIOLATION_MESSAGE_LENGTH` 1,024）は撤廃した。

/** DEF-144: probe の押下の中の違反の、押した候補（値を持たない）。 */
export interface JobSafetyViolationPress {
  /** 送信ボタンの語（閉じた一覧の語。候補の `submitterWords`）。 */
  readonly submitterWords: readonly string[];
  /** 候補の識別の digest（候補の `identityDigest`）。 */
  readonly identityDigest: string;
}

/**
 * DEF-144: 発見と READ の確かめのジョブの違反の中身（`discovery.json`・`read-evidence.json` の `safetyViolation`、IPC の `FINISHED` の要約、ジョブの画面）。
 * 違反の一覧と数と記録の不完全は、`run.json` の `safety` と同じ形（`PageSafetySummary`）。値（本文、query の値、Cookie、token）を持たない。SAFE-2 の 4: 違反でない
 * 記録の数（`frameClassificationFailureCount`・`readNavigationFailureCount`）は、違反の中身に持たない（違反の形は変えない）。
 */
export interface JobSafetyViolation extends Omit<PageSafetySummary, 'frameClassificationFailureCount' | 'readNavigationFailureCount'> {
  /** 違反が起きた画面の path（query・fragment は持たない。値に見える区切りは伏せる。読めない URL は空）。 */
  readonly pagePath: string;
  readonly stage: JobSafetyViolationStage;
  /** probe の押下の中なら押した候補（押す前・押していない段は `null`）。 */
  readonly press: JobSafetyViolationPress | null;
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
  /**
   * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 実効の監査の段の送信の扱いと、Guard が通した読み取りでない要求の数。新しい Run は
   * 必ず持つ。任意の項目で、持たない古い `run.json` は `READ_ONLY`（通した数 0）と読む。
   */
  readonly auditSend?: RunAuditSendSummary;
  /**
   * SAFE-2 の 4: 違反にしない止めた記録の数（frame の判定の失敗・読み取りの main frame の移動の失敗。Ledger の snapshot の `count` の合計。飽和）と、外部スキーム
   * への移動の試みの記録の数。新しい Run は必ず持つ。任意の項目で、持たない古い `run.json` は 0 と読む。
   */
  readonly frameClassificationFailureCount?: number;
  readonly readNavigationFailureCount?: number;
  readonly externalSchemeNavigationCount?: number;
}

/** AS-b: `run.json` の `safety.auditSend`（扱いと通した数。値は持たない）。集計は `summarizeRunSafety` の 1 か所。 */
export interface RunAuditSendSummary {
  readonly policy: AuditSendPolicyName;
  /** 通した読み取りでない要求の総数（Ledger の snapshot の `passedAuditSendRequests.count` の合計）。 */
  readonly passedRequests: number;
  /** method ごとの通した数（Ledger の snapshot の `byMethod` の合計。method のコード単位の順）。 */
  readonly passedRequestsByMethod: Readonly<Record<string, number>>;
  /**
   * AS-c: 通した要求のうち、ほかの Origin（許可 Origin と承認したサービスの Origin のほか）へのものの数（snapshot の `otherOrigins` の合計）。新しい Run は必ず持つ。
   * 持たない Run（AS-c の前）は 0 と読む。
   */
  readonly passedOtherOriginRequests?: number;
  /** AS-c: 通した WebSocket の接続の数（snapshot の `passedAuditSendWebSockets.count` の合計）。新しい Run は必ず持つ。持たない Run は 0 と読む。 */
  readonly passedWebSockets?: number;
  /**
   * AS-c fix round 1（C-1・C-2）: そのうち Guard の route を通らずに開いた接続の数（snapshot の `passedAuditSendWebSockets.outsideGuard` の合計）。新しい Run は
   * 必ず持つ。持たない Run は 0 と読む。
   */
  readonly passedWebSocketsOutsideGuard?: number;
  /** AS-c fix round 1: そのうち危険な語に当たる接続の数（snapshot の `passedAuditSendWebSockets.dangerous` の合計）。新しい Run は必ず持つ。持たない Run は 0 と読む。 */
  readonly passedDangerousWebSockets?: number;
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
  /** 実効の設定の `crawl.maxInteractionsPerPage`（1ページで監査する Interaction の候補の上限）。L14: 指定していなければ持たない（上限なし）。 */
  readonly maxInteractionsPerPage?: number;
  /**
   * 間隔の判定に使った読み込みの開始の回数（`NavigationPacer.snapshot().navigationCount`）。待った後に読み込みを始められなかった
   * 場合も含むので、実際の読み込みの回数より多いことがある（多めに数える側）。
   */
  readonly navigationCount: number;
  /** 間隔のために待った時間の合計（ms。`NavigationPacer.snapshot().totalWaitMs`）。 */
  readonly pacingWaitMs: number;
  /** 監査対象のサイトに送った要求の実績（`LoadMeter.snapshot()`）。 */
  readonly requests: RunLoadRequests;
  /**
   * 承認したサービスの Origin への要求（T35a。Task 35 の設計書 3.4。任意の項目）。`requests.otherOrigins` の内数。スクリプトで送るログインの監査の
   * Run だけが持つ（公開監査とフォームの送信のログインの監査は持たない。出力は変えない）。
   */
  readonly approvedServiceOrigins?: RunLoadOriginRequests;
}

/**
 * スクリプトで送るログインの監査の段の数（T35a。Task 35 の設計書 3.7。run.json の任意の項目 `authentication`）。数だけで、URL・値を持たない。
 * - `registeredReadRequestsAllowed`: 通した、登録した読み取りの手続きの呼び出しの数。
 * - `tokenRefreshBlocked`: 止めた、token の送信先への送信（token の更新など）の数。
 * - `otherNonReadBlocked`: 止めた、そのほかの読み取りでない要求の数（Safety Ledger にもある）。
 * - `serviceUnauthorizedResponses`: 承認したサービスの Origin からの 401 の応答の数（値は読まない。記録だけで、セッションの切れとはみなさない）。
 * - `serviceRequestLimitReached`: 承認したサービスの Origin への要求の上限に届いたか。
 */
export interface RunAuthenticationSummary {
  readonly registeredReadRequestsAllowed: number;
  readonly tokenRefreshBlocked: number;
  readonly otherNonReadBlocked: number;
  readonly serviceUnauthorizedResponses: number;
  readonly serviceRequestLimitReached: boolean;
  /**
   * T37R-fix-B2（Task 37 の設計書 8 章の最後の行）: 許可 Origin への読み取りでない要求のうち、要求の種類が `fetch`・`xhr` のものを止めた数（記録だけで、
   * 描けなかった画面の判定には使わない）。今の書き手は必ず書く。前の版の成果物にはない。
   */
  readonly allowedOriginDataRequestsBlocked?: number;
  /**
   * DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2）: 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込み
   * （ページ・ビューポート・幅）の前に待った回数と、待った時間の合計（ms）。`run.json` では Run の全体（再開をまたいで足す）。今の書き手は必ず書く。前の版の
   * 成果物にはない。
   */
  readonly serviceRequestPacingWaits?: number;
  readonly serviceRequestPacingWaitMs?: number;
}

/**
 * ログインの状態の鍵がなくなったことで、セッションの切れとみなした場所（T35c。Run の理由 `AUTH_SESSION_LOST` の `detail`。T37a: 発見と READ の確かめの
 * 成果物の、終わり方の詳しい理由 `endReasonDetail` にも使う。この値の owner。URL・鍵の名前・値は入れない）。
 */
export const SESSION_KEY_LOST_DETAIL = 'session-key';
export type SessionKeyLostDetail = typeof SESSION_KEY_LOST_DETAIL;

/**
 * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.3）: 承認したサービスの Origin から 401 を受け、その画面が描けなかったことで、
 * セッションの切れとみなした（Run の理由 `AUTH_SESSION_LOST` の `detail`、発見と READ の確かめの成果物の `endReasonDetail`。この値の owner）。
 */
export const SERVICE_UNAUTHORIZED_DETAIL = 'SERVICE_UNAUTHORIZED';
export type ServiceUnauthorizedDetail = typeof SERVICE_UNAUTHORIZED_DETAIL;

/** DEF-233: セッションの切れの詳しい理由の閉じた一覧（鍵の消失・サービスの 401。path による切れは詳しい理由を持たない）。 */
export const SESSION_LOST_DETAILS = Object.freeze([SESSION_KEY_LOST_DETAIL, SERVICE_UNAUTHORIZED_DETAIL] as const);
export type SessionLostDetail = (typeof SESSION_LOST_DETAILS)[number];

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
  /** 設定の `crawl.maxPages`。L14 の後の段: 利用者が指定したときだけ持つ（ないときは上限なし。表示は「指定なし」）。 */
  readonly maxPages?: number;
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
  /**
   * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 今監査を始めたページの URL。ページを始めた知らせ
   * （`RunCoordinatorDependencies.onPageStarted`）だけが持つ（止まったページが、最後の進み具合の記録に残るようにするため）。ページを終えた後の
   * 進み具合と、発見・READ の確かめの進み具合は持たない（項目がない）。認証つきの Run では伏せ字（`redactUrlSecrets`）の後の値。
   */
  readonly currentPageUrl?: string;
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
  /**
   * T44c（Task 44 の設計書 P1-4。設計者の判断）: ページの未完了の理由ごとの、その理由を持つページの数（任意の項目。監査したページ（SKIPPED でない）の、ページと
   * ビューポートの理由。理由のコードの一覧の順。1 ページは理由ごとに 1 回）。理由を持つページがなければ持たない。前の書き手の `run.json` にもない。
   */
  readonly pageIncompleteReasonCounts?: readonly PageIncompleteReasonCount[];
  /** サイトへの負荷の記録（サイトへの負荷の制御の設計書 4.5）。PREFLIGHT の失敗などで早く終わった Run にも入れる。 */
  readonly load: RunLoad;
  /**
   * スクリプトで送るログインの監査の段の数（T35a。Task 35 の設計書 3.7。任意の項目）。スクリプトで送るログインの監査の Run だけが持つ（公開監査と
   * フォームの送信のログインの監査は持たない。出力は変えない）。
   * DEF-138: セッションの切れで止まった実行は、その証拠（`sessionLoss`）も持つ（フォームの送信のログインの監査は、証拠だけを持つ）。
   */
  readonly authentication?: RunAuthenticationRecord;
  /**
   * WSO: 点検の範囲（任意の項目。「チェックした画面だけ」の Run だけが持つ。読む画面の数だけで、URL は持たない）。サイトの全部の画面の Run と、前の書き手の
   * `run.json` は持たない。
   */
  readonly pageScope?: RunPageScopeRecord;
}

/** T44c: ページの未完了の理由ごとのページの数（`RunSummary.pageIncompleteReasonCounts` の 1 件）。 */
export interface PageIncompleteReasonCount {
  readonly code: IncompleteReasonCode;
  readonly pages: number;
}

/**
 * `run.json` の `authentication`（DEF-138）: 監査の段の数（スクリプトで送るログインの Run）に、セッションの切れの証拠（任意）を足したものか、証拠だけ
 * （フォームの送信のログインの Run）。証拠は、この実行がセッションの切れで止まったときの 1 件（Run は最初の切れで止まる）。
 */
export type RunAuthenticationRecord =
  | (RunAuthenticationSummary & { readonly sessionLoss?: SessionLossEvidence })
  | ({ readonly sessionLoss: SessionLossEvidence } & { readonly [Key in keyof RunAuthenticationSummary]?: never });

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
 * MEM-3（DEF-266）: `pages` の形は型の引数（`TPages`）。既定は配列（テストと今の呼び出し側）。本番の Run は、圧縮して持つ置き場所
 * （`src/core/run-page-store.ts` の `RunPageStore`）にする。読む側は `forEachRunPage` でなめる。
 */
export interface AuditRunResult<TPages extends RunPages = readonly PageAuditResult[]> {
  readonly run: RunSummary;
  /** URL の発見の順。監査しなかった URL の `SKIPPED` の結果も含む。 */
  readonly pages: TPages;
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
 * - `STOPPED_BY_AUTH_SESSION_LOST`: 認証つきの Run で、セッションの切れ（理由 `AUTH_SESSION_LOST`）を検知して止まった（Task 25 の設計書
 *   4.3。T25c）。再開できる（再開のときは、もう一度ログインする。T25d）。既存の値の表示の順を変えないよう、一覧の最後に加えた。
 * - `STOPPED_BY_SERVICE_REQUEST_LIMIT`: スクリプトで送るログインの監査の Run で、承認したサービスの Origin への要求の上限（理由
 *   `SERVICE_REQUEST_LIMIT_REACHED`）に届いて止まった（Task 35 の設計書 3.4。T35c。サイトの不調で止めた前例と同じ形）。再開できる（再開の実行は、
 *   新しい上限で数える）。既存の値の表示の順を変えないよう、一覧の最後に加えた。
 */
export const RUN_EXECUTION_END_REASONS = Object.freeze([
  'COMPLETED',
  'STOPPED_BY_RUNTIME_LIMIT',
  'STOPPED_BY_SIGNAL',
  'STOPPED_BY_SAFETY_VIOLATION',
  'STOPPED_BY_SITE_UNAVAILABLE',
  'INTERRUPTED_ABNORMALLY',
  'STOPPED_BY_AUTH_SESSION_LOST',
  'STOPPED_BY_SERVICE_REQUEST_LIMIT',
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
  /**
   * DEF-200（設計書 `2026-11-04-beaksight-login-session-design.md` 3.4）: この実行が、ログインの切れの後に、自動ログインでログインし直して自動で始めた実行の印と、
   * その時点のログインし直しの回数（段ごとに 1 から）。ほかの実行と、前の版の `run.json` は持たない（任意）。新しい終わり方の値は足さない。
   */
  readonly automaticRelogin?: RunExecutionAutomaticRelogin;
}

/** DEF-200: 段ごとのログインし直しの回数の上限（1 回の段で 2 回まで。自動ログインの全体の上限は別に守る）。 */
export const MAX_AUTOMATIC_RELOGINS_PER_STAGE = 2;

/** DEF-200: ログインし直して自動で始めた実行の印（回数は 1 から `MAX_AUTOMATIC_RELOGINS_PER_STAGE` まで）。 */
export interface RunExecutionAutomaticRelogin {
  readonly count: number;
}
