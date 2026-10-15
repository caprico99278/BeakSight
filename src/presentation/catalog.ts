/**
 * 表示用語彙の唯一の owner（UI追補設計書 第4章、4.2）。値の一覧（意味）は `src/core/**` が持ち、このファイルは、
 * 各値の日本語のラベル、表示の順、色のトークンの名前、説明だけを持つ。値の意味（どの Rule がどの category・severity になるか、
 * どの状態が Run Status にどう効くか）は決めない。
 * - このファイルが import してよいのは、`src/core/**` と `src/config/types.ts` だけ（UI追補設計書 4.1）。
 * - カタログは `satisfies Record<値, …>` で書き、core の一覧に値を足したら、書き漏れが型のエラーになるようにする。
 * - 色の値は置かない。色の値は、トークンの名前（`DisplayTone`）ごとに `src/report/html-tokens.ts` が持つ（GATE-UI02）。
 */
import type {
  EvidenceType,
  FindingCategory,
  InteractionStatus,
  PageAuditStatus,
  RunExecutionEndReason,
  RunStatus,
  Severity,
  ViewportProfile,
} from '../core/contracts.js';
import { FINDING_CATEGORIES, SEVERITIES } from '../core/contracts.js';
import type { InteractionNotVerifiableKind, SafetyEventKind, ScreenshotCaptureType } from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';

/**
 * 色のトークンの名前の閉じた一覧。バッジや強調の色は、この名前で選ぶ。
 * 名前は、状態や severity の値そのもの（`ERROR` など）とは別にする（表示面のコードに状態の値を書かないため。GATE-UI01）。
 */
export const DISPLAY_TONES = Object.freeze(['critical', 'caution', 'notice', 'shield', 'positive', 'neutral'] as const);
export type DisplayTone = (typeof DISPLAY_TONES)[number];

/** 1つの値の表示のしかた。 */
export interface DisplaySpec {
  /** 日本語のラベル。バッジなどでは、色だけに頼らず、この文字を示す。 */
  readonly label: string;
  /** 表示の順（小さいほど先）。1つのカタログの中で重ならない。 */
  readonly order: number;
  /** 色のトークンの名前。 */
  readonly tone: DisplayTone;
  /** 利用者向けの短い説明。説明が要らない値は `null`。 */
  readonly description: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------------------------------------------

/** Severity の集計の区分（上位の設計書 13章）。サイト品質（ERROR、WARN、INFO）と Safety（SAFETY）を分けて数える。 */
export const SEVERITY_GROUPS = Object.freeze(['SITE_QUALITY', 'SAFETY'] as const);
export type SeverityGroup = (typeof SEVERITY_GROUPS)[number];

export const SEVERITY_GROUP_CATALOG = deepFreeze({
  SITE_QUALITY: {
    label: 'サイト品質',
    order: 1,
    tone: 'neutral',
    description: '監査したサイトの品質に関する指摘です。',
  },
  SAFETY: {
    label: '安全',
    order: 2,
    tone: 'shield',
    description: 'BeakSight が安全のために止めた操作や、安全の不変条件に関する記録です。',
  },
} as const satisfies Record<SeverityGroup, DisplaySpec>);

export interface SeveritySpec extends DisplaySpec {
  /** サイト品質か Safety か。 */
  readonly group: SeverityGroup;
  /**
   * 「重大な指摘」の節（Task 14〜17 の設計書 6.1.4 の節2、6.1.8）に入れる severity か。表示用モデルは、この属性で振り分ける
   * （色のトーンを、振り分けの根拠にしない）。
   */
  readonly criticalSection: boolean;
}

export const SEVERITY_CATALOG = deepFreeze({
  ERROR: {
    label: 'エラー',
    order: 1,
    tone: 'critical',
    description: '利用者に影響する可能性が高い問題です。',
    group: 'SITE_QUALITY',
    criticalSection: true,
  },
  WARN: {
    label: '警告',
    order: 2,
    tone: 'caution',
    description: '確認を勧める問題です。',
    group: 'SITE_QUALITY',
    criticalSection: false,
  },
  INFO: {
    label: '情報',
    order: 3,
    tone: 'notice',
    description: '参考のための記録です。',
    group: 'SITE_QUALITY',
    criticalSection: false,
  },
  SAFETY: {
    label: '安全',
    order: 4,
    tone: 'shield',
    description: '安全のために止めた操作や、安全に関する記録です。サイト品質の件数とは分けて数えます。',
    group: 'SAFETY',
    criticalSection: false,
  },
} as const satisfies Record<Severity, SeveritySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------------------------------------------

export const RUN_STATUS_CATALOG = deepFreeze({
  COMPLETE: {
    label: '完了',
    order: 1,
    tone: 'positive',
    description: '必要な確認を、すべて終えました。',
  },
  PARTIAL: {
    label: '一部未完了',
    order: 2,
    tone: 'caution',
    description: '一部の確認を終えられませんでした。結果は、確認できた範囲のものです。',
  },
  FAILED: {
    label: '失敗',
    order: 3,
    tone: 'critical',
    description: '監査を実行できませんでした。',
  },
  ABORTED_BY_SAFETY: {
    label: '安全のため中止',
    order: 4,
    tone: 'shield',
    description: '安全の不変条件の違反を記録したため、監査を中止しました。',
  },
} as const satisfies Record<RunStatus, DisplaySpec>);

/**
 * 1回の実行（起動）の終わり方（`RunExecution.endReason`。中断した Run の再開の設計書 4.8）。値の一覧と意味は core の
 * `RUN_EXECUTION_END_REASONS` が持ち、ここは、HTML レポートの「実行の記録」の表で示すラベル、順、色のトーン、説明だけを持つ。
 */
export const RUN_EXECUTION_END_REASON_CATALOG = deepFreeze({
  COMPLETED: {
    label: '最後まで実行',
    order: 1,
    tone: 'positive',
    description: '最後の処理まで行いました。',
  },
  STOPPED_BY_RUNTIME_LIMIT: {
    label: '実行時間の上限で停止',
    order: 2,
    tone: 'caution',
    description: '1回の起動の実行時間の上限に達したため、残りのページを監査せずに止めました。',
  },
  STOPPED_BY_SIGNAL: {
    label: '中断の指示で停止',
    order: 3,
    tone: 'caution',
    description: '止める指示（Ctrl+C など）を受けたため、今のページを終えてから止めました。',
  },
  STOPPED_BY_SAFETY_VIOLATION: {
    label: '安全のため停止',
    order: 4,
    tone: 'shield',
    description: '安全の不変条件の違反を検出したため、それより後の監査を始めませんでした。',
  },
  STOPPED_BY_SITE_UNAVAILABLE: {
    label: 'サイトの不調で停止',
    order: 5,
    tone: 'caution',
    description: 'サイトが応答しない（時間切れ、接続の失敗、503 などの応答）ため、残りのページを監査せずに止めました。',
  },
  INTERRUPTED_ABNORMALLY: {
    label: '途中で終了',
    order: 6,
    tone: 'critical',
    description:
      'プロセスが途中で終わりました（強制終了、停電、端末の再起動、2回目の Ctrl+C など）。終わりの時刻は、最後に保存した時刻です。',
  },
  // T25c（Task 25 の設計書 4.3）: 認証つきの Run で、セッションの切れで止まった。core の一覧の並び（最後）に合わせる。
  STOPPED_BY_AUTH_SESSION_LOST: {
    label: 'ログインの切れで停止',
    order: 7,
    tone: 'caution',
    description: 'ログインの状態が切れた（ログインの画面に移った）ため、そのページを監査せず、残りのページも監査せずに止めました。',
  },
} as const satisfies Record<RunExecutionEndReason, DisplaySpec>);

export const PAGE_AUDIT_STATUS_CATALOG = deepFreeze({
  AUDITED: {
    label: '監査済み',
    order: 1,
    tone: 'positive',
    description: '必要な確認を、すべて終えました。',
  },
  PARTIAL: {
    label: '一部未完了',
    order: 2,
    tone: 'caution',
    description: '一部の確認を終えられませんでした。',
  },
  SKIPPED: {
    label: 'スキップ',
    order: 3,
    tone: 'neutral',
    description: '上限などの理由で、監査しませんでした。',
  },
  FAILED: {
    label: '失敗',
    order: 4,
    tone: 'critical',
    description: 'ページを監査できませんでした。',
  },
} as const satisfies Record<PageAuditStatus, DisplaySpec>);

export const INTERACTION_STATUS_CATALOG = deepFreeze({
  VERIFIED: {
    label: '確認済み',
    order: 1,
    tone: 'positive',
    description: '操作の結果、ページの状態が変わることを確かめました。',
  },
  REJECTED_UNSAFE: {
    label: '安全のため対象外',
    order: 2,
    tone: 'shield',
    description: '安全に操作できると確かめられないため、操作しませんでした。',
  },
  BLOCKED_BY_SAFETY: {
    label: '安全のため遮断',
    order: 3,
    tone: 'shield',
    description: '操作の途中で、安全のために通信や外部への作用を止めました。',
  },
  NOT_VERIFIABLE: {
    label: '確認できず',
    order: 4,
    tone: 'caution',
    description: '操作の結果を確かめられませんでした。',
  },
  EXECUTION_FAILED: {
    label: '実行の失敗',
    order: 5,
    tone: 'critical',
    description: '操作を実行できませんでした。',
  },
} as const satisfies Record<InteractionStatus, DisplaySpec>);

export const INTERACTION_NOT_VERIFIABLE_KIND_CATALOG = deepFreeze({
  OBSERVED_NO_CHANGE: {
    label: '変化なし',
    order: 1,
    tone: 'neutral',
    description: '確かめる手順を終えましたが、状態の変化を観測しませんでした。',
  },
  CHECK_NOT_COMPLETED: {
    label: '確認を終えられず',
    order: 2,
    tone: 'caution',
    description: '確かめる手順を、最後まで終えられませんでした。',
  },
} as const satisfies Record<InteractionNotVerifiableKind, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// Evidence、ビューポート、スクリーンショット
// ---------------------------------------------------------------------------------------------------------------

export const EVIDENCE_TYPE_CATALOG = deepFreeze({
  network: { label: 'ネットワーク', order: 1, tone: 'neutral', description: null },
  console: { label: 'コンソール', order: 2, tone: 'neutral', description: null },
  dom: { label: 'DOM', order: 3, tone: 'neutral', description: null },
  link: { label: 'リンク', order: 4, tone: 'neutral', description: null },
  layout: { label: 'レイアウト', order: 5, tone: 'neutral', description: null },
  color: { label: '色', order: 6, tone: 'neutral', description: null },
  performance: { label: 'パフォーマンス', order: 7, tone: 'neutral', description: null },
  accessibility: { label: 'アクセシビリティ', order: 8, tone: 'neutral', description: null },
  interaction: { label: 'インタラクション', order: 9, tone: 'neutral', description: null },
  screenshot: { label: 'スクリーンショット', order: 10, tone: 'neutral', description: null },
  scroll: { label: 'スクロール', order: 11, tone: 'neutral', description: null },
  metadata: {
    label: 'サイトのメタデータ',
    order: 12,
    tone: 'neutral',
    description: 'robots.txt と sitemap.xml の取得の記録です。',
  },
  safety: {
    label: '安全の記録',
    order: 13,
    tone: 'shield',
    description: '安全のために止めた操作の記録です。',
  },
} as const satisfies Record<EvidenceType, DisplaySpec>);

export const VIEWPORT_PROFILE_CATALOG = deepFreeze({
  desktop: { label: 'デスクトップ', order: 1, tone: 'neutral', description: null },
  mobile: { label: 'モバイル', order: 2, tone: 'neutral', description: null },
} as const satisfies Record<ViewportProfile, DisplaySpec>);

export const SCREENSHOT_CAPTURE_TYPE_CATALOG = deepFreeze({
  VIEWPORT: { label: '表示範囲', order: 1, tone: 'neutral', description: 'ビューポートに見えている範囲です。' },
  FULL_PAGE: { label: 'ページ全体', order: 2, tone: 'neutral', description: 'ページの全体です。' },
} as const satisfies Record<ScreenshotCaptureType, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// Safety の事象の記録の種類（Task 14〜17 の設計書 6.1.10）
// ---------------------------------------------------------------------------------------------------------------

/**
 * Safety の事象の記録の種類。値の一覧の owner は core（`SAFETY_EVENT_KINDS`、`SafetyEventKind`。設計書 6.1.10）で、ここは
 * core の型を、同じ名前で公開するだけにする（同じ一覧をもう一度書かない）。core に種類を1つ加えると、
 * `SAFETY_EVENT_KIND_CATALOG` の書き漏れが型のエラーになる。
 */
export type { SafetyEventKind };

/**
 * Safety の事象の記録の種類の、日本語のラベルと表示の順。表示の順は、core の `SAFETY_EVENT_KINDS` の順（`SafetyEventsEvidence` の
 * 項目の順）と同じにする（設計書 6.1.10）。
 */
export const SAFETY_EVENT_KIND_CATALOG = deepFreeze({
  blockedRequests: {
    label: '遮断したリクエスト',
    order: 1,
    tone: 'shield',
    description: '読み取り以外のメソッドのリクエストを、遮断しました。',
  },
  blockedNavigations: {
    label: '遮断したナビゲーション',
    order: 2,
    tone: 'shield',
    description: '許可 Origin の外へのメインフレームのナビゲーションを、遮断しました。',
  },
  blockedWebSockets: {
    label: '遮断した WebSocket',
    order: 3,
    tone: 'shield',
    // DEF-040（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      'WebSocket の接続を、遮断しました。理由が PASSIVE_WEBSOCKET の記録は、ページ（文書）が開いた接続を Guard が止めたものです。理由が WORKER_CONNECT_POLICY の記録は、Worker の中で開いた接続を、BeakSight が文書と Worker に加える通信の制限（CSP の connect-src）が止めたものです。この記録は観察によるもので、止めた接続のすべてが残るとは限りません。',
  },
  blockedExternalActions: {
    label: '実行しなかった外部への作用',
    order: 4,
    tone: 'shield',
    description: '外部への作用（外部 Origin、特殊な scheme、ダウンロード）がある Interaction の候補を、実行しませんでした。',
  },
  excludedInteractionCandidates: {
    label: '除外した Interaction の候補',
    order: 5,
    tone: 'shield',
    description: '安全のため、Interaction の候補を機械的に除外しました。',
  },
  blockedInteractionRequests: {
    label: '操作中に遮断したリクエスト',
    order: 6,
    tone: 'shield',
    // DEF-039（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。M3（NPR2）: 中継の記録に
    // Chromium 自身の通信が含まれうることも示す。
    description:
      'Interaction の操作の間に、ページが起こしたリクエストを遮断しました。理由が INTERACTION_FROZEN の記録は、通信を止めた後に Guard が止めたものです。理由が INTERACTION_FROZEN_EGRESS の記録は、通信を止めた後に、Interaction の環境の通信を通す BeakSight の中継（127.0.0.1 の proxy）が拒んだものです。Guard を通らずに出た要求の証拠で、CONNECT の記録の URL は host:port の形です。理由が EGRESS_UPSTREAM_DENIED の記録は、中継の上流の方針で拒んだものです（通常は出ません）。理由が GUARD_BYPASS_EGRESS の記録は、Guard が許さない method や URL の要求が Guard を通らずに出ようとしたのを、BeakSight の中継が拒んだものです。この理由の記録と、通信を止めた後の中継の記録（INTERACTION_FROZEN_EGRESS）は、Interaction の操作に限らず、ページの読み込みと発見の段階の記録にも現れます。環境を閉じる途中に中継が拒んだ要求は、記録しません。中継の記録には、ページの通信のほかに、Chromium 自身の通信（例: Google への接続）も含まれることがあります。',
  },
  blockedInteractionNavigations: {
    label: '操作中に遮断したナビゲーション',
    order: 7,
    tone: 'shield',
    description: 'Interaction の操作の間に、ページが起こしたナビゲーションを遮断しました。',
  },
  blockedPopups: {
    label: '遮断したポップアップ',
    order: 8,
    tone: 'shield',
    description: 'ポップアップを、遮断しました。',
  },
  blockedDownloads: {
    label: '遮断したダウンロード',
    order: 9,
    tone: 'shield',
    description: 'ダウンロードを、遮断しました。',
  },
  blockedInteractionWebSockets: {
    label: '操作中に遮断した WebSocket',
    order: 10,
    tone: 'shield',
    // DEF-040（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      'Interaction の操作の間に、ページが起こした WebSocket の接続を遮断しました。理由が INTERACTION_FROZEN の記録は、ページ（文書）が開いた接続を Guard が止めたものです。理由が WORKER_CONNECT_POLICY の記録は、Worker の中で開いた接続を、BeakSight が文書と Worker に加える通信の制限（CSP の connect-src）が止めたものです。この記録は観察によるもので、止めた接続のすべてが残るとは限りません。',
  },
  externalSchemeNavigations: {
    label: '外部スキームへの移動の試み',
    order: 11,
    tone: 'shield',
    // C18g: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      '外部スキーム（tel:、mailto: など）への移動の記録です。理由が EXTERNAL_SCHEME_NAVIGATION の記録は、ページが移動を試みたものです。ブラウザは移動していませんが、外部のアプリが起動した可能性があるので、安全の不変条件の違反として記録し、Run を止めます。理由が EXTERNAL_SCHEME_REDIRECT_BLOCKED の記録は、サーバのリダイレクトを、ブラウザがたどる前に止めたものです。',
  },
} as const satisfies Record<SafetyEventKind, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// HTML レポートの節（Task 14〜17 の設計書 6.1.4）
// ---------------------------------------------------------------------------------------------------------------

/** 節の表示のしかた。`anchor` は、節の見出しの `id` に使う、安全な文字（`[a-z0-9-]`）だけの名前。 */
export interface ReportSectionSpec {
  readonly label: string;
  readonly order: number;
  readonly anchor: string;
  readonly description: string | null;
}

/** HTML レポートの節の閉じた一覧。`CATEGORY_FINDINGS` の位置に、category の節（`REPORT_CATEGORY_SECTIONS`）を並べる。 */
export const REPORT_SECTIONS = Object.freeze([
  'SUMMARY',
  'CRITICAL_FINDINGS',
  'CATEGORY_FINDINGS',
  'INTERACTIONS',
  'SAFETY',
  'PAGES',
] as const);
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const REPORT_SECTION_CATALOG = deepFreeze({
  SUMMARY: {
    label: '要約',
    order: 1,
    anchor: 'summary',
    description: 'Run の状態、ページの網羅、指摘の件数、上限と未完了の理由です。',
  },
  CRITICAL_FINDINGS: {
    label: '重大な指摘',
    order: 2,
    anchor: 'critical-findings',
    description: '重大度がエラーの指摘です（カテゴリを問いません）。',
  },
  CATEGORY_FINDINGS: {
    label: 'カテゴリ別の指摘',
    order: 3,
    anchor: 'findings-by-category',
    description: null,
  },
  INTERACTIONS: {
    label: 'インタラクション',
    order: 4,
    anchor: 'interactions',
    description: '操作の候補ごとの結果です。',
  },
  SAFETY: {
    label: '安全',
    order: 5,
    anchor: 'safety',
    description: '安全のために止めた操作と、安全の不変条件の違反です。',
  },
  PAGES: {
    label: 'ページの一覧',
    order: 6,
    anchor: 'pages',
    description: 'ページごとの状態、ビューポートごとの状態、スクリーンショットです。',
  },
} as const satisfies Record<ReportSection, ReportSectionSpec>);

/**
 * category の節の閉じた一覧（上位の設計書 第20章のカテゴリの名前にあたる）。1つの節が、1つ以上の `FindingCategory` をまとめる。
 * どの `FindingCategory` がどの節に入るかは、`FINDING_CATEGORY_CATALOG` の `section` の1か所で決める。
 */
export const REPORT_CATEGORY_SECTIONS = Object.freeze([
  'NETWORK',
  'JAVASCRIPT',
  'LINKS',
  'DOM',
  'FORM',
  'LAYOUT',
  'ACCESSIBILITY',
  'PERFORMANCE',
  'CROSS_PAGE',
  'SAFETY',
] as const);
export type ReportCategorySection = (typeof REPORT_CATEGORY_SECTIONS)[number];

export const REPORT_CATEGORY_SECTION_CATALOG = deepFreeze({
  NETWORK: { label: 'ネットワーク', order: 1, anchor: 'category-network', description: 'HTTP の応答と、リソースの読み込みです。' },
  JAVASCRIPT: { label: 'JavaScript', order: 2, anchor: 'category-javascript', description: null },
  LINKS: { label: 'リンク', order: 3, anchor: 'category-links', description: null },
  DOM: { label: 'DOM', order: 4, anchor: 'category-dom', description: null },
  FORM: { label: 'フォーム', order: 5, anchor: 'category-form', description: null },
  LAYOUT: { label: 'レイアウト', order: 6, anchor: 'category-layout', description: null },
  ACCESSIBILITY: { label: 'アクセシビリティ', order: 7, anchor: 'category-accessibility', description: null },
  PERFORMANCE: { label: 'パフォーマンス', order: 8, anchor: 'category-performance', description: null },
  CROSS_PAGE: { label: 'ページ間', order: 9, anchor: 'category-cross-page', description: '複数のページを比べた指摘です。' },
  SAFETY: { label: '安全', order: 10, anchor: 'category-safety', description: null },
} as const satisfies Record<ReportCategorySection, ReportSectionSpec>);

export interface FindingCategorySpec extends DisplaySpec {
  /** HTML レポートで、この category の Finding を置く節。 */
  readonly section: ReportCategorySection;
}

export const FINDING_CATEGORY_CATALOG = deepFreeze({
  HTTP: { label: 'HTTP', order: 1, tone: 'neutral', description: 'HTTP の応答に関する指摘です。', section: 'NETWORK' },
  RESOURCE: { label: 'リソース', order: 2, tone: 'neutral', description: '画像やスクリプトなどの読み込みに関する指摘です。', section: 'NETWORK' },
  JAVASCRIPT: { label: 'JavaScript', order: 3, tone: 'neutral', description: 'スクリプトのエラーに関する指摘です。', section: 'JAVASCRIPT' },
  LINK: { label: 'リンク', order: 4, tone: 'neutral', description: 'リンク切れなどに関する指摘です。', section: 'LINKS' },
  DOM: { label: 'DOM', order: 5, tone: 'neutral', description: '文書の構造に関する指摘です。', section: 'DOM' },
  FORM: { label: 'フォーム', order: 6, tone: 'neutral', description: 'フォームに関する指摘です。', section: 'FORM' },
  ACCESSIBILITY: { label: 'アクセシビリティ', order: 7, tone: 'neutral', description: 'アクセシビリティに関する指摘です。', section: 'ACCESSIBILITY' },
  LAYOUT: { label: 'レイアウト', order: 8, tone: 'neutral', description: 'はみ出しや重なりなどの表示に関する指摘です。', section: 'LAYOUT' },
  PERFORMANCE: { label: 'パフォーマンス', order: 9, tone: 'neutral', description: '表示の速さに関する指摘です。', section: 'PERFORMANCE' },
  CROSS_PAGE: { label: 'ページ間', order: 10, tone: 'neutral', description: '複数のページを比べた指摘です。', section: 'CROSS_PAGE' },
  SAFETY: { label: '安全', order: 11, tone: 'shield', description: '安全に関する記録です。', section: 'SAFETY' },
} as const satisfies Record<FindingCategory, FindingCategorySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 監査プロファイルと管理データ（ローカルの管理画面。Task 23 の設計書 4.7。T23f）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 監査モード（`src/control/contracts.ts` の `AUDIT_MODES`）の表示。値の一覧と意味は `src/control/contracts.ts` が持ち、ここは表示だけを持つ。
 * 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる（このファイルは `src/control/` を import しない）。
 */
export const AUDIT_MODE_CATALOG = deepFreeze({
  PUBLIC_PASSIVE: {
    label: '公開の監査（読むだけ）',
    order: 1,
    tone: 'positive',
    description: '公開されているページを、ログインせずに、読むだけで監査します。',
  },
  TEST_AUTH_PASSIVE: {
    label: 'テスト環境の監査（ログインあり・読むだけ）',
    order: 2,
    tone: 'caution',
    description: 'テスト環境に、ログインしてから、読むだけで監査します。',
  },
  TEST_APPROVED_WRITE: {
    label: 'テスト環境の監査（承認した書き込みあり）',
    order: 3,
    tone: 'caution',
    description: 'テスト環境で、承認した書き込みの操作も確かめます。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 環境の種類（`ENVIRONMENT_KINDS`）の表示。 */
export const ENVIRONMENT_KIND_CATALOG = deepFreeze({
  PUBLIC: { label: '公開（本番）', order: 1, tone: 'neutral', description: null },
  TEST: { label: 'テスト環境', order: 2, tone: 'notice', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 認証の方式（`AUTH_STRATEGIES`）の表示。 */
export const AUTH_STRATEGY_CATALOG = deepFreeze({
  NONE: { label: 'ログインしない', order: 1, tone: 'neutral', description: null },
  MANUAL_SESSION: { label: '手でログインする', order: 2, tone: 'neutral', description: null },
  AUTOMATED_LOGIN: { label: '自動でログインする', order: 3, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** プロファイルの状態（`src/control/store/profile-records.ts` の `PROFILE_STATUSES`）の表示。 */
export const PROFILE_STATUS_CATALOG = deepFreeze({
  ACTIVE: { label: '有効', order: 1, tone: 'positive', description: null },
  RETIRED: { label: '取り消し', order: 2, tone: 'neutral', description: '取り消したプロファイルは、元に戻せません。' },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 監査のジョブ（ローカルの管理画面から動かす監査。Task 24 の設計書 4.4、4.8。T24f）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 監査のジョブの状態（`src/control/job/job-records.ts` の `AUDIT_JOB_STATES`）の表示。値の一覧と意味は `src/control/job/` が持ち、ここは
 * 表示だけを持つ。書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 * Run の状態（COMPLETE、PARTIAL など）とは別のもの（Run の状態は `RUN_STATUS_CATALOG`）。
 */
export const AUDIT_JOB_STATE_CATALOG = deepFreeze({
  STARTING: { label: '開始中', order: 1, tone: 'notice', description: '監査のワーカーを起動しています。' },
  RUNNING: { label: '実行中', order: 2, tone: 'notice', description: '監査を実行しています。' },
  STOPPING: {
    label: '停止中',
    order: 3,
    tone: 'caution',
    description: '止める要求を送りました。今のページの監査を終えてから止まります。',
  },
  FINISHED: {
    label: '終了',
    order: 4,
    tone: 'positive',
    description: '監査のワーカーが結果を返しました。結果は「Run の状態」で確かめてください。',
  },
  FAILED: { label: '失敗', order: 5, tone: 'critical', description: '監査を実行できませんでした。' },
  INTERRUPTED: {
    label: '中断',
    order: 6,
    tone: 'caution',
    description: '結果を返す前に、監査が止まりました。同じプロファイルで「前回の続きから再開する」を選んで開始すると、続きから再開します。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 監査のジョブの終わり方（監査の中核の結果の種類。`src/control/worker-protocol.ts` の `WORKER_OUTCOME_KINDS`）の表示。値の一覧と意味は
 * `src/control/` が持ち、ここは表示だけを持つ。書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUDIT_JOB_END_KIND_CATALOG = deepFreeze({
  RAN: { label: '監査を実行しました', order: 1, tone: 'positive', description: null },
  RUN_ACTIVE: {
    label: '別の Run が実行中',
    order: 2,
    tone: 'caution',
    description: '同じ出力先で、別の Run が実行中か、始まるところでした。その Run が終わってから、もう一度開始してください。',
  },
  VERSION_MISMATCH: {
    label: '途中の Run の版が違う',
    order: 3,
    tone: 'caution',
    description: '途中の Run は、版が違うため再開できません。最初から始めるには「新しく始める」を選んで開始してください。',
  },
  RUN_DIRECTORY_UNAVAILABLE: {
    label: 'Run のディレクトリを作れない',
    order: 4,
    tone: 'critical',
    description: 'Run のディレクトリを作れなかったため、監査を始めずに終えました。',
  },
  RESUME_UNAVAILABLE: {
    label: '再開を始められない',
    order: 5,
    tone: 'caution',
    description: '途中の Run の再開を始められませんでした（別のプロセスが実行中、再開のための保存を読み書きできない、など）。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 監査のジョブの最後の認証の状態（値の一覧は `src/control/worker-protocol.ts` の `WORKER_AUTH_STATES`。Task 25 の設計書 4.4、4.5。T25d）。
 * 値と秘密を含まない状態の表示だけ。画面の案内（T25e）が使う。
 */
export const AUDIT_JOB_AUTH_STATE_CATALOG = deepFreeze({
  AWAITING_LOGIN: {
    label: 'ログイン待ち',
    order: 1,
    tone: 'notice',
    description: 'BeakSight が開いたブラウザで、ログインしてください。ログインが済むと、そのブラウザを閉じて監査を始めます。',
  },
  AUTHENTICATED: {
    label: 'ログイン済み',
    order: 2,
    tone: 'positive',
    description: 'ログインが済みました。ログインの状態は保存せず、この監査の間だけ使います。',
  },
  AUTH_SETUP_REQUIRED: {
    label: 'ログインを続けられない',
    order: 3,
    tone: 'critical',
    description: 'ログインのブラウザが閉じられたか、ログインの画面を安全に開けませんでした。認証の設定を確かめてください。',
  },
  UNSUPPORTED_AUTH_STATE: {
    label: '扱えないログインの形',
    order: 4,
    tone: 'critical',
    description: 'ログインの後に、許可した Origin の Cookie も localStorage もありませんでした。この形のログインには、まだ対応していません。',
  },
  SESSION_LOST: {
    label: 'ログインの状態が切れた',
    order: 5,
    tone: 'caution',
    description: '監査の途中で、ログインの状態が切れたため止まりました。再開すると、もう一度ログインしてから続けます。',
  },
  LOGIN_TIMEOUT: {
    label: 'ログインの時間切れ',
    order: 6,
    tone: 'caution',
    description: '決められた時間の中に、ログインが済みませんでした。監査は始めていません。',
  },
  LOGIN_ATTEMPTS_EXCEEDED: {
    label: 'ログインの回数の上限',
    order: 7,
    tone: 'critical',
    description: 'ログインの送信先への送信を止めたため、ログインを止めました。回数の上限を超えたか、BeakSight が扱えない形のログインの可能性があります。監査は始めていません。',
  },
  // T26d-2（Task 26 の設計書 4.5）: 自動ログインの段が成功以外で終わった（結果ごとの案内は、ジョブの失敗の理由の文言）。T26e で文言を見直した。
  AUTOMATED_LOGIN_FAILED: {
    label: '自動ログインの失敗',
    order: 8,
    tone: 'critical',
    description: '保存した資格情報での自動ログインが、成功以外で終わりました。監査は始めていません。この画面の「自動ログイン」の結果と、人がすることを確かめてください。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 保存した認証の設定の新しさ（値の一覧は `src/control/store/auth-setup-store.ts` の `AUTH_SETUP_FRESHNESS_VALUES`。Task 25 の設計書 4.1、4.5。
 * T25e）。書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUTH_SETUP_FRESHNESS_CATALOG = deepFreeze({
  CURRENT: {
    label: '今の改訂で保存済み',
    order: 1,
    tone: 'positive',
    description: null,
  },
  STALE: {
    label: '古い（保存し直しが必要）',
    order: 2,
    tone: 'caution',
    description: 'プロファイルの改訂が変わったため、この認証の設定では監査を始めません。内容を見直して、保存し直してください。',
  },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 自動ログイン（ローカルの管理画面の資格情報、ログインの確かめ、ジョブの結果。Task 26 の設計書 4.2、4.6。T26e）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ジョブの種類（`src/control/job/job-records.ts` の `AUDIT_JOB_KINDS`）の表示。値の一覧と意味は `src/control/` が持ち、ここは表示だけを持つ。
 * 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 */
export const AUDIT_JOB_KIND_CATALOG = deepFreeze({
  AUDIT: { label: '監査', order: 1, tone: 'neutral', description: null },
  LOGIN_CHECK: {
    label: 'ログインの確かめ',
    order: 2,
    tone: 'notice',
    description: '保存した資格情報で、ログインだけを 1 回試し、結果を記録するジョブです。監査は行いません。',
  },
  // T27c（Task 27 の設計書 4.6）: 操作の候補の発見と READ の確かめ。T27f で文言を見直した（進み具合を送らないことを書き足した）。
  DISCOVERY: {
    label: '操作の候補の発見',
    order: 3,
    tone: 'notice',
    description: 'ログインの後に管理画面を読むだけで、フォームとボタンを操作の候補として集め、分類するジョブです。送信や書き込みはしません。このジョブは進み具合を送らないので、種類と状態だけを示します。',
  },
  READ_CHECK: {
    label: 'READ の確かめ',
    order: 4,
    tone: 'notice',
    description: 'ログインの後に、人が決めた READ の確かめ（一覧・詳細・検索の GET）を読み、結果を期待と照らすジョブです。書き込みはしません。このジョブは進み具合を送らないので、種類と状態だけを示します。',
  },
  // T30d（Task 30 の設計書 3 章の「記録」）: 書き込みのジョブ。始める口と画面は T30e・T30g。
  WRITE_CREATE: {
    label: '登録の書き込み',
    order: 5,
    tone: 'notice',
    description: '承認したシナリオに従って、テスト環境に 1 件だけ登録を送り、結果を確かめるジョブです。',
  },
  // T31e（Task 31 の設計書 3 章の「記録」）: 更新の書き込みのジョブ。始める口と画面は T31f・T31h。
  WRITE_UPDATE: {
    label: '更新の書き込み',
    order: 6,
    tone: 'notice',
    description: '承認したシナリオに従って、BeakSight が登録して照合したテスト環境のレコードを 1 件だけ更新し、前後の値を確かめるジョブです。',
  },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 操作の候補の発見と READ の確かめ（ローカルの管理画面。Task 27 の設計書 4.3、4.4、4.5、4.7。T27f）
// 値の一覧と意味は `src/discovery/`（画面へは `src/control/discovery-view.ts` から公開し直す）と `src/control/job/` が持ち、ここは表示だけを持つ。
// 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** 候補の分類（`CANDIDATE_CLASSIFICATIONS`）の表示。READ のほかは、この画面からは実行できない（説明に書く）。 */
export const CANDIDATE_CLASSIFICATION_CATALOG = deepFreeze({
  READ: {
    label: '読み取り（READ）',
    order: 1,
    tone: 'positive',
    description: 'GET で読むフォームです。「READ の確かめ」で、送る値と期待を決めて確かめられます。',
  },
  CREATE: {
    label: '登録（CREATE）',
    order: 2,
    tone: 'notice',
    description: '登録の操作に見える候補です。この画面からは実行できません。承認した書き込みのモードのプロファイルでは、シナリオにして承認した後に、1 件ずつ送れます。',
  },
  UPDATE: {
    label: '更新（UPDATE）',
    order: 3,
    tone: 'notice',
    description: '更新の操作に見える候補です。この画面からは実行できません。承認した書き込みのモードのプロファイルでは、シナリオにして承認した後に、BeakSight が登録したレコードを 1 件ずつ更新できます。',
  },
  NOT_EXECUTABLE: {
    label: '実行しない（削除など）',
    order: 4,
    tone: 'critical',
    description: '削除や取り消しなどの、戻せない操作に見える候補です。BeakSight は、この候補を実行しません。',
  },
  NEEDS_BINDING: {
    label: '送り方が決まらない',
    order: 5,
    tone: 'caution',
    description: 'JavaScript の処理で送る候補です。何をどこへ送るかを画面から決められないので、この画面からは実行できません。',
  },
  UNSUPPORTED_READ_TRANSPORT: {
    label: '扱えない読み取り',
    order: 6,
    tone: 'caution',
    description: 'POST で読む検索、パスワードの欄やファイルの送り方のある GET などです。この画面からは実行できず、READ の確かめにも使えません。',
  },
  BLOCKED_EXTERNAL: {
    label: '許可 Origin の外へ送る',
    order: 7,
    tone: 'critical',
    description: '送信先が、プロファイルで許可した Origin の外です。この画面からは実行できません。',
  },
  DISPLAY_ONLY: {
    label: '分類できない（表示だけ）',
    order: 8,
    tone: 'neutral',
    description: '規則で分類できなかった候補です。候補として示すだけで、この画面からは実行できません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 候補の種類（`CANDIDATE_KINDS`）の表示。 */
export const CANDIDATE_KIND_CATALOG = deepFreeze({
  FORM: { label: 'フォーム', order: 1, tone: 'neutral', description: null },
  BUTTON: { label: 'ボタン', order: 2, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 候補の索引のドリフト（`src/control/job/discovery-index-store.ts` の `DISCOVERY_INDEX_DRIFTS`。最後の発見のジョブに対するもの）の表示。 */
export const DISCOVERY_DRIFT_CATALOG = deepFreeze({
  NEW: { label: '新しい', order: 1, tone: 'notice', description: '最後の発見で、初めて見つかった候補です。' },
  CHANGED: {
    label: '変わった',
    order: 2,
    tone: 'caution',
    description: '前の発見から、入力の規則（必須・読み取り専用・制約・選択肢など）、分類、理由、状態の欄の印のどれかが変わりました。',
  },
  UNCHANGED: { label: '変わらない', order: 3, tone: 'neutral', description: '前の発見と同じです。' },
  MISSING: {
    label: '消えた',
    order: 4,
    tone: 'caution',
    description: '最後の発見で読み切れた画面に、この候補がありませんでした。記録は消さずに残し、前に見たときの内容を示します。',
  },
  NOT_REVISITED: {
    label: '読み直していない',
    order: 5,
    tone: 'neutral',
    description: '最後の発見では、この候補の画面を読みませんでした（巡回の上限や、読み切れなかった画面など）。前に見たときの内容を示します。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 発見のジョブの終わり方（`DISCOVERY_END_REASONS`）の表示。 */
export const DISCOVERY_END_REASON_CATALOG = deepFreeze({
  COMPLETED: { label: '読める画面をすべて読みました', order: 1, tone: 'positive', description: null },
  MAX_PAGES_REACHED: {
    label: 'ページの上限で止めました',
    order: 2,
    tone: 'caution',
    description: '読んだ画面の数が、設定のファイルのページの上限に達したため、残りの画面は読んでいません。',
  },
  MAX_RUNTIME_REACHED: {
    label: '時間の上限で止めました',
    order: 3,
    tone: 'caution',
    description: '実行の時間が、設定のファイルの時間の上限に達したため、残りの画面は読んでいません。',
  },
  STOPPED: { label: '止める要求で止めました', order: 4, tone: 'caution', description: '今の画面を読み終えてから止まりました。発見のジョブは再開しません。' },
  AUTH_SESSION_LOST: {
    label: 'ログインの状態が切れました',
    order: 5,
    tone: 'caution',
    description: '途中でログインの状態が切れたため、読んだ画面までを記録しました。もう一度「操作の候補を探す」を始めてください。',
  },
  SAFETY_VIOLATION: {
    label: '安全の決まりの違反で止めました',
    order: 6,
    tone: 'critical',
    description: '安全の記録に、決まりの違反がありました。候補の一覧は変えていません。',
  },
  PREFLIGHT_FAILED: {
    label: '始める前の確認で止めました',
    order: 7,
    tone: 'critical',
    description: '始める前の確認が失敗したため、画面を 1 つも読んでいません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** READ の確かめの結果（`READ_CHECK_RESULTS`。期待 1 件の結果にも使う）の表示。 */
export const READ_CHECK_RESULT_CATALOG = deepFreeze({
  MATCHED: { label: '一致', order: 1, tone: 'positive', description: '読んだ結果が、期待と一致しました。' },
  NOT_MATCHED: { label: '不一致', order: 2, tone: 'critical', description: '読んだ結果が、期待と一致しませんでした。' },
  UNDETERMINED: {
    label: '判定できない',
    order: 3,
    tone: 'caution',
    description: '読めなかったか、結果の構造を決められなかったため、期待と照らせませんでした。',
  },
  READ_BLOCKED_BY_POLICY: {
    label: '読む前に止めた',
    order: 4,
    tone: 'caution',
    description: '要求の判定（読まないパス、危険な語、許可した Origin、秘密に見える名前、送れない欄）で止めたため、読んでいません。',
  },
  READ_CANDIDATE_DRIFTED: {
    label: '画面が変わった',
    order: 5,
    tone: 'caution',
    description: '対象の候補が、今の画面で見つからないか、どの画面か分からないため、読んでいません。',
  },
  READ_CANDIDATE_NOT_READ: {
    label: 'READ でなくなった',
    order: 6,
    tone: 'caution',
    description: '対象の候補の今の分類が、読み取り（READ）でないため、読んでいません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** READ の確かめの期待の種類（`READ_CHECK_EXPECTATION_KINDS`）の表示。 */
export const READ_CHECK_EXPECTATION_KIND_CATALOG = deepFreeze({
  ROW_COUNT_EQUALS: {
    label: '行の数がちょうど',
    order: 1,
    tone: 'neutral',
    description: '結果の表（なければ一覧）のデータの行の数が、指定の数とちょうど同じです。',
  },
  ROW_COUNT_AT_LEAST: {
    label: '行の数が少なくとも',
    order: 2,
    tone: 'neutral',
    description: '結果の表（なければ一覧）のデータの行の数が、指定の数以上です。',
  },
  TEXT_CONTAINS: { label: '本文が文を含む', order: 3, tone: 'neutral', description: '結果の画面の主な領域の見えている文字が、指定の文を含みます。' },
  DETAIL_FIELD_EQUALS: {
    label: '詳細の項目の値が等しい',
    order: 4,
    tone: 'neutral',
    description: '結果の画面の詳細（dl の dt と dd）の、指定の項目の値が、指定の値と同じです。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** READ の確かめのジョブの終わり方（`READ_CHECK_END_REASONS`。確かめなかった定義の理由にも使う）の表示。 */
export const READ_CHECK_END_REASON_CATALOG = deepFreeze({
  COMPLETED: { label: 'すべての定義を確かめました', order: 1, tone: 'positive', description: null },
  MAX_RUNTIME_REACHED: {
    label: '時間の上限で止めました',
    order: 2,
    tone: 'caution',
    description: '実行の時間が、設定のファイルの時間の上限に達したため、残りの定義は確かめていません。',
  },
  STOPPED: { label: '止める要求で止めました', order: 3, tone: 'caution', description: '今の定義を終えてから止まりました。残りの定義は確かめていません。' },
  AUTH_SESSION_LOST: {
    label: 'ログインの状態が切れました',
    order: 4,
    tone: 'caution',
    description: '途中でログインの状態が切れたため、残りの定義は確かめていません。もう一度「READ を確かめる」を始めてください。',
  },
  SAFETY_VIOLATION: {
    label: '安全の決まりの違反で止めました',
    order: 5,
    tone: 'critical',
    description: '安全の記録に、決まりの違反がありました。',
  },
  PREFLIGHT_FAILED: {
    label: '始める前の確認で止めました',
    order: 6,
    tone: 'critical',
    description: '始める前の確認が失敗したため、どの定義も確かめていません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 自動ログインの結果（`src/control/auth/automated-login-results.ts` の `AUTOMATED_LOGIN_RESULTS`）の表示。成功以外の結果の説明と、人がすること
 * （手順）は、ジョブの失敗の理由の文言（`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS`。同じ値）が持つので、ここの説明は成功だけに置く。
 */
export const AUTOMATED_LOGIN_RESULT_CATALOG = deepFreeze({
  SUCCEEDED: { label: '成功', order: 1, tone: 'positive', description: '保存した資格情報で、ログインできました。' },
  INVALID_CREDENTIALS: { label: '資格情報の誤り', order: 2, tone: 'critical', description: null },
  ACCOUNT_LOCKED: { label: 'アカウントのロック', order: 3, tone: 'critical', description: null },
  MFA_REQUIRED: { label: '人の操作（MFA など）が必要', order: 4, tone: 'critical', description: null },
  CREDENTIAL_EXPIRED: { label: 'パスワードの期限切れ', order: 5, tone: 'critical', description: null },
  RATE_LIMITED: { label: '回数の制限（HTTP 429）', order: 6, tone: 'caution', description: null },
  AUTH_RESULT_UNKNOWN: { label: '結果が分からない', order: 7, tone: 'caution', description: null },
  LOGIN_FORM_INVALID: { label: 'フォームの確かめで中止', order: 8, tone: 'caution', description: null },
  LOGIN_FORM_INPUT_FAILED: { label: '入力か送信の失敗', order: 9, tone: 'caution', description: null },
  CREDENTIAL_CHANGED: { label: '資格情報が変わった', order: 10, tone: 'caution', description: null },
  CREDENTIAL_UNAVAILABLE: { label: '資格情報を戻せない', order: 11, tone: 'critical', description: null },
  // T26g-1（設計書の変更履歴の「T26R」の行）: 送信の窓の中で、ページが許した送信のほかの要求を出そうとした。
  UNEXPECTED_LOGIN_REQUEST: { label: 'ログインの画面の予期しない送信', order: 12, tone: 'critical', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 自動ログインで、ログインの POST を送ったか（`AUTOMATED_LOGIN_SUBMISSIONS`）の表示。 */
export const AUTOMATED_LOGIN_SUBMISSION_CATALOG = deepFreeze({
  YES: { label: '送信しました', order: 1, tone: 'neutral', description: null },
  NO: {
    label: '送信していません',
    order: 2,
    tone: 'neutral',
    description: 'ログインの送信の前に止まりました。アカウントのロックの心配はないので、自動ログインは止めていません。',
  },
  UNKNOWN: {
    label: '送信したかが分かりません',
    order: 3,
    tone: 'caution',
    description: '送信したかもしれないため、アカウントのロックを避けるために、自動ログインを止めています。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 保存した資格情報の最後の変更の種類（`src/control/credentials/credential-store.ts` の `CREDENTIAL_CHANGE_KINDS`）の表示。 */
export const CREDENTIAL_CHANGE_KIND_CATALOG = deepFreeze({
  CREATED: { label: '登録', order: 1, tone: 'neutral', description: null },
  USERNAME_CHANGED: { label: 'ユーザー名の変更', order: 2, tone: 'neutral', description: null },
  PASSWORD_CHANGED: { label: 'パスワードの変更', order: 3, tone: 'neutral', description: null },
  BOTH_CHANGED: { label: 'ユーザー名とパスワードの変更', order: 4, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 資格情報の暗号化を、この環境で使えるか（画面のサーバが起動のときに 1 回確かめた結果。値の一覧は
 * `apps/local-ui/src/server/credential-runtime.ts` の `CREDENTIAL_ENVIRONMENT_STATES`）の表示。値は出さない。
 */
export const CREDENTIAL_ENVIRONMENT_CATALOG = deepFreeze({
  AVAILABLE: {
    label: '使えます',
    order: 1,
    tone: 'positive',
    description: 'Windows の暗号化（DPAPI）で、自動ログインの資格情報を保存して使えます。',
  },
  UNAVAILABLE: {
    label: '使えません',
    order: 2,
    tone: 'critical',
    description: 'Windows の暗号化（DPAPI）を確かめられませんでした。資格情報を保存できず、自動ログインは始められません。公開の監査と手動のログインの監査は使えます。',
  },
  NOT_WINDOWS: {
    label: 'この環境では使えません',
    order: 3,
    tone: 'caution',
    description: 'Windows でないため、資格情報を保存できず、自動ログインは始められません（自動ログインは Windows だけで使えます）。公開の監査と手動のログインの監査は使えます。',
  },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// シナリオの承認（ローカルの管理画面。Task 28 の設計書 4.1、4.3、4.6。T28e）
// 値の一覧と意味は `src/control/approval/`（画面へは `src/control/approval-view.ts` から公開し直す）と、画面の表示の状態の一覧
// （`apps/local-ui/src/display/scenarios.ts`）が持ち、ここは表示だけを持つ。書き漏れと余分は、画面の側
// （`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** シナリオの種類（`SCENARIO_KINDS`）の表示。 */
export const SCENARIO_KIND_CATALOG = deepFreeze({
  CREATE: { label: '登録（CREATE）', order: 1, tone: 'notice', description: 'テスト環境に、レコードを登録する書き込みです。' },
  UPDATE: { label: '更新（UPDATE）', order: 2, tone: 'notice', description: 'テスト環境の、レコードを更新する書き込みです。' },
} as const satisfies Record<string, DisplaySpec>);

/**
 * シナリオの表示の状態（`apps/local-ui/src/display/scenarios.ts` の `SCENARIO_DISPLAY_STATES`。保存した状態と、再承認の判定の結果から、画面の
 * サーバが 1 つ選ぶ）の表示。
 */
export const SCENARIO_DISPLAY_STATE_CATALOG = deepFreeze({
  DRAFT: { label: '下書き', order: 1, tone: 'neutral', description: 'まだ承認していません。内容を確かめてから承認します。' },
  APPROVED: { label: '承認済み', order: 2, tone: 'positive', description: '今の内容で承認しています（期限まで）。承認だけでは、書き込みは始まりません。' },
  NEEDS_REAPPROVAL: {
    label: '要再承認',
    order: 3,
    tone: 'caution',
    description: '承認した後に、承認を縛る内容が変わりました。前の承認は引き継がないので、内容を確かめてから、もう一度承認します。',
  },
  EXPIRED: { label: '期限切れ', order: 4, tone: 'caution', description: '承認の期限を過ぎました。使うには、内容を確かめてから、もう一度承認します。' },
  REVOKED: { label: '撤回済み', order: 5, tone: 'neutral', description: '承認を撤回しました。使うには、内容を確かめてから、もう一度承認します。' },
} as const satisfies Record<string, DisplaySpec>);

/** 再承認が要る理由（`APPROVAL_INVALIDITY_REASONS`。15 種。T31b で UPDATE の 2 種を足した）の表示。 */
export const APPROVAL_INVALIDITY_REASON_CATALOG = deepFreeze({
  SCENARIO_REVISION_CHANGED: {
    label: 'シナリオの版が変わった',
    order: 1,
    tone: 'caution',
    description: '承認した後に、シナリオを編集しました（版が変わりました）。',
  },
  PROFILE_REVISION_CHANGED: {
    label: 'プロファイルが変わった',
    order: 2,
    tone: 'caution',
    description: '承認した後に、プロファイルを編集しました（どの項目の編集でも、承認は引き継ぎません）。',
  },
  AUTH_SETUP_CHANGED: {
    label: '認証の設定が変わった',
    order: 3,
    tone: 'caution',
    description: '承認した後に、認証の設定（自動ログインなら資格情報の版も）が変わりました。',
  },
  TARGET_CONFIG_CHANGED: {
    label: 'ターゲットの設定が変わった',
    order: 4,
    tone: 'caution',
    description: '承認した後に、プロファイルが指す設定のファイル（ターゲットの設定）の内容が変わりました。',
  },
  CANDIDATE_CHANGED: {
    label: '候補が変わった',
    order: 5,
    tone: 'caution',
    description: '最後の「操作の候補を探す」で、対象の候補の入力の規則（必須・制約・選択肢など）か分類が変わりました。',
  },
  CANDIDATE_MISSING: {
    label: '候補を確かめられない',
    order: 6,
    tone: 'caution',
    description: '最後の「操作の候補を探す」で、対象の候補が見つからないか、その画面を読み直していません。',
  },
  // T31b: UPDATE のシナリオ（文言の確かめは T31h）。
  UPDATE_SPEC_MISSING: {
    label: 'UPDATE の指定がない',
    order: 7,
    tone: 'caution',
    description: 'UPDATE のシナリオに、UPDATE の指定（台帳の参照、path の型、保つ欄）がありません。指定を足して保存し直すまで、承認できません。',
  },
  CANDIDATE_TEMPLATES_UNAVAILABLE: {
    label: '型にした候補を確かめられない',
    order: 8,
    tone: 'caution',
    description: 'UPDATE のシナリオの候補を、レコードによらない形で確かめる記録が、まだありません。今は UPDATE を承認できません。',
  },
  INPUT_RULES_CHANGED: { label: '入力の規則が変わった', order: 9, tone: 'caution', description: '入力の規則の参照（集まり・版・digest）が変わりました。' },
  READ_CHECK_CHANGED: {
    label: '照らす READ の定義が変わった',
    order: 10,
    tone: 'caution',
    description: '照らす READ の確かめの定義が、変わったか、削除されたか、見つかりません。',
  },
  EXPIRED: { label: '期限切れ', order: 11, tone: 'caution', description: '承認の期限を過ぎました（ちょうど期限の時刻を含みます）。' },
  REVOKED: { label: '撤回済み', order: 12, tone: 'neutral', description: '最後の承認を撤回しました。' },
  NOT_APPROVED: { label: '未承認', order: 13, tone: 'neutral', description: 'まだ承認していません。' },
  PROFILE_RETIRED: { label: 'プロファイルを取り消した', order: 14, tone: 'critical', description: '取り消したプロファイルのシナリオは、承認できません。' },
  MODE_NOT_WRITE: {
    label: '書き込みのモードでない',
    order: 15,
    tone: 'critical',
    description: 'プロファイルの監査モードが、承認した書き込みのモード（TEST_APPROVED_WRITE）ではありません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 副作用の確認の項目（`SIDE_EFFECT_CONFIRMATIONS`。承認の前に人がすべて確かめる 4 項目）の表示。 */
export const SIDE_EFFECT_CONFIRMATION_CATALOG = deepFreeze({
  TEST_RECORDS_ONLY: {
    label: '登録・更新されるのは、テスト環境のレコードだけです',
    order: 1,
    tone: 'neutral',
    description: '本番や共有のデータに書き込まないことを、送信先の画面とテスト環境の構成で確かめました。',
  },
  NO_EXTERNAL_NOTIFICATION: {
    label: 'メール・SMS・外部の通知が送られない設定です',
    order: 2,
    tone: 'neutral',
    description: '登録や更新で、人にメールや SMS や通知が届かないことを、テスト環境の設定で確かめました。',
  },
  NO_PAYMENT_OR_EXTERNAL_SERVICE: {
    label: '決済や外部のサービスに及びません',
    order: 3,
    tone: 'neutral',
    description: '決済、在庫の引き当て、外部のサービスへの連携などが動かないことを確かめました。',
  },
  NOT_DESTRUCTIVE: {
    label: '削除・無効化・取り消しに当たりません',
    order: 4,
    tone: 'neutral',
    description: 'この操作が、ほかのレコードを消したり、無効にしたり、取り消したりしないことを確かめました。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 承認の digest の項目（`APPROVAL_DIGEST_ITEMS`。最後の承認との差分の項目名）の表示。 */
export const APPROVAL_DIGEST_ITEM_CATALOG = deepFreeze({
  profileId: { label: 'プロファイル', order: 1, tone: 'neutral', description: 'シナリオのプロファイルの名前です。' },
  scenarioId: { label: 'シナリオ', order: 2, tone: 'neutral', description: 'シナリオの ID です。' },
  scenarioRevision: { label: 'シナリオの版', order: 3, tone: 'neutral', description: 'シナリオを編集すると、版が 1 つ進みます。' },
  profileRevision: { label: 'プロファイルの改訂', order: 4, tone: 'neutral', description: 'プロファイルを編集すると、改訂が 1 つ進みます。' },
  authSetupDigest: { label: '認証の設定', order: 5, tone: 'neutral', description: '認証の設定（自動ログインなら資格情報の版も）の digest です。' },
  targetConfigDigest: { label: 'ターゲットの設定', order: 6, tone: 'neutral', description: 'プロファイルが指す設定のファイルの内容の digest です。' },
  kind: { label: '種類', order: 7, tone: 'neutral', description: '登録（CREATE）か更新（UPDATE）です。' },
  candidateIdentityDigest: { label: '候補の識別', order: 8, tone: 'neutral', description: '対象の候補を見分ける digest です。' },
  candidateRuleDigest: { label: '候補の入力の規則', order: 9, tone: 'neutral', description: '対象の候補の入力の規則（必須・制約・選択肢など）の digest です。' },
  request: { label: '要求の形', order: 10, tone: 'neutral', description: '送り方（form の method、_method の上書き）、送信先の Origin と path、enctype です。' },
  fieldNames: { label: '送る欄', order: 11, tone: 'neutral', description: '値を送る欄の名前の一覧です（値は持ちません）。' },
  sideEffectConfirmations: {
    label: '副作用の確認',
    order: 12,
    tone: 'neutral',
    description: '副作用の確認の 4 項目を確かめたか（項目の順の真偽）です。',
  },
  limits: { label: '上限', order: 13, tone: 'neutral', description: '1 回の Run の上限と、累積の上限の件数です。' },
  approvalTtlDays: { label: '承認の期限の日数', order: 14, tone: 'neutral', description: '承認してから期限までの日数です。' },
  inputRuleReference: {
    label: '入力の規則の参照',
    order: 15,
    tone: 'neutral',
    description: '送る値の作り方の規則の参照（集まり・版・digest）です。未設定なら null です。',
  },
  readChecks: { label: '照らす READ の定義', order: 16, tone: 'neutral', description: '結果を照らす READ の確かめの定義の参照（ID と版）です。' },
  // T30a（Task 30 の設計書 3 章の「検証の指定」）: 検証の指定の 4 項目。
  verificationSuccessCondition: {
    label: '成功の条件',
    order: 17,
    tone: 'neutral',
    description: '送信の後の画面が登録の成功に当たる条件（path の前方一致とセレクタ）です。未指定なら null です。',
  },
  verificationInputErrorCondition: {
    label: '入力の誤りの条件',
    order: 18,
    tone: 'neutral',
    description: '送信の後の画面が入力の誤りに当たる条件（path の前方一致とセレクタ）です。未指定なら null です。',
  },
  verificationRecordId: {
    label: '登録の ID の取り方',
    order: 19,
    tone: 'neutral',
    description: '成功の後の URL の path の型（例 /items/{id}）か、成功の画面の要素のセレクタです。未指定なら null です。',
  },
  verificationRead: {
    label: '照合の READ',
    order: 20,
    tone: 'neutral',
    description: '登録した内容を読み直す READ の定義の参照（ID と版）、生成した値に結び付ける送る値、期待です。未指定なら null です。',
  },
  // T31b: UPDATE の指定（文言の確かめは T31h）。
  updateTargetCreateScenarioId: {
    label: '台帳の参照',
    order: 21,
    tone: 'neutral',
    description: '更新するレコードを登録した CREATE のシナリオです。UPDATE の指定がなければ null です。',
  },
  updateFormPathTemplate: {
    label: '更新の画面の path の型',
    order: 22,
    tone: 'neutral',
    description: 'レコードの ID の位置を {id} にした、更新の画面の path です。UPDATE の指定がなければ null です。',
  },
  updateActionPathTemplate: {
    label: '送信先の path の型',
    order: 23,
    tone: 'neutral',
    description: 'レコードの ID の位置を {id} にした、送信先の path です。UPDATE の指定がなければ null です。',
  },
  updateKeepFieldNames: {
    label: '保つ欄',
    order: 24,
    tone: 'neutral',
    description: '更新しても値を変えない欄の名前です。UPDATE の指定がなければ null です。',
  },
  updateTemplatedIdentityDigest: {
    label: '型にした候補の識別',
    order: 25,
    tone: 'neutral',
    description: 'レコードの ID の位置を {id} にした、候補の識別の digest です。UPDATE の指定がなければ null です。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 承認の記録の種類（`APPROVAL_RECEIPT_KINDS`）の表示。 */
export const APPROVAL_RECEIPT_KIND_CATALOG = deepFreeze({
  APPROVAL: { label: '承認', order: 1, tone: 'positive', description: null },
  REVOCATION: { label: '撤回', order: 2, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 撤回の理由（`REVOCATION_REASONS`）の表示。 */
export const REVOCATION_REASON_CATALOG = deepFreeze({
  OPERATOR_REQUEST: { label: '画面から撤回しました', order: 1, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 書き込み（Task 30 の設計書 2 章のユーザーの判断 2、3 章の「結果の判定」「予約の締め」「`UNKNOWN` の後」「検証の指定」。T30g）。値の一覧は
// `src/control/actions/action-contracts.ts` と `src/control/approval-view.ts` のもの。書き漏れは `apps/local-ui/src/display/catalog-coverage.ts` が
// 型で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** 書き込みの結果（`ACTION_RESULTS`）の表示。`UNKNOWN` は、テスト環境で登録の有無を確かめるよう促す（ユーザーの判断 2）。 */
export const ACTION_RESULT_CATALOG = deepFreeze({
  VERIFIED: {
    label: '照合済み',
    order: 1,
    tone: 'positive',
    description: '登録の成功の画面を確かめ、登録の ID を取り、照合の READ で登録した内容を読み直せました。',
  },
  PARTIAL: {
    label: '照合できていない',
    order: 2,
    tone: 'caution',
    description: '成功の画面には当たりましたが、登録の ID か照合の READ で確かめられていません。登録できたとは言い切れません。',
  },
  UNKNOWN: {
    label: '結果が分からない',
    order: 3,
    tone: 'critical',
    description: '送ったか、登録されたかが分かりません。テスト環境で、登録されたかどうかを必ず確かめてください。件数は使ったものとして数えます。',
  },
  FAILED: {
    label: '登録されなかった',
    order: 4,
    tone: 'caution',
    description: 'サイトが入力の誤りか、要求が多すぎること（429）を返しました。登録されなかったと判定しました。件数は使ったものとして数えます。',
  },
  BLOCKED: { label: '送らずに止めた', order: 5, tone: 'neutral', description: '送る前の確かめで止めました。サイトには送っていません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 送信の状態（`SUBMISSION_STATES`）の表示。 */
export const SUBMISSION_STATE_CATALOG = deepFreeze({
  SENT: { label: '送った', order: 1, tone: 'notice', description: null },
  NOT_SENT: { label: '送っていない', order: 2, tone: 'neutral', description: null },
  UNKNOWN: { label: '送ったか分からない', order: 3, tone: 'critical', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 送らずに止めた理由（`ACTION_BLOCK_REASONS`）の表示。 */
export const ACTION_BLOCK_REASON_CATALOG = deepFreeze({
  PAYLOAD_MISMATCH: { label: '送る中身が承認と違う', order: 1, tone: 'caution', description: '送る直前の照合で、送る中身が承認した形と違いました。' },
  PRECHECK_FAILED: { label: '送る前の確かめで止めた', order: 2, tone: 'caution', description: '画面・承認・許可・フォームの確かめで止めました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 送信の後の画面の判定（`RESPONSE_JUDGEMENTS`）の表示。 */
export const RESPONSE_JUDGEMENT_CATALOG = deepFreeze({
  SUCCESS: { label: '成功の条件に当たった', order: 1, tone: 'positive', description: null },
  INPUT_ERROR: { label: '入力の誤りの条件に当たった', order: 2, tone: 'caution', description: null },
  RATE_LIMITED: { label: '要求が多すぎる（429）', order: 3, tone: 'caution', description: null },
  SERVER_ERROR: { label: 'サーバの誤り（5xx）', order: 4, tone: 'critical', description: null },
  NO_CONDITION_MATCHED: { label: 'どの条件にも当たらない', order: 5, tone: 'critical', description: null },
  MULTIPLE_CONDITIONS_MATCHED: { label: '2 つ以上の条件に当たった', order: 6, tone: 'critical', description: null },
  SESSION_LOST: { label: 'セッションが切れた', order: 7, tone: 'critical', description: null },
  REPOST_REDIRECT: { label: '再送の転送（307・308）を止めた', order: 8, tone: 'critical', description: null },
  RESPONSE_NOT_DELIVERED: { label: '応答を画面に返せなかった', order: 9, tone: 'critical', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 書き込みの結果を決めた理由（`ACTION_OUTCOME_REASONS`）の表示。 */
export const ACTION_OUTCOME_REASON_CATALOG = deepFreeze({
  PAYLOAD_MISMATCH: { label: '送る中身が承認と違う', order: 1, tone: 'caution', description: null },
  PRECHECK_FAILED: { label: '送る前の確かめで止めた', order: 2, tone: 'caution', description: null },
  NO_RESPONSE: { label: '応答がない（送ったか分からない）', order: 3, tone: 'critical', description: null },
  INPUT_ERROR: { label: '入力の誤り', order: 4, tone: 'caution', description: null },
  RATE_LIMITED: { label: '要求が多すぎる（429）', order: 5, tone: 'caution', description: null },
  SERVER_ERROR: { label: 'サーバの誤り（5xx）', order: 6, tone: 'critical', description: null },
  NO_CONDITION_MATCHED: { label: 'どの条件にも当たらない', order: 7, tone: 'critical', description: null },
  MULTIPLE_CONDITIONS_MATCHED: { label: '2 つ以上の条件に当たった', order: 8, tone: 'critical', description: null },
  SESSION_LOST: { label: 'セッションが切れた', order: 9, tone: 'critical', description: null },
  REPOST_REDIRECT: { label: '再送の転送（307・308）を止めた', order: 10, tone: 'critical', description: null },
  RESPONSE_NOT_DELIVERED: { label: '応答を画面に返せなかった', order: 11, tone: 'critical', description: null },
  RECORD_ID_NOT_FOUND: { label: '登録の ID が取れない', order: 12, tone: 'caution', description: null },
  RECORD_ID_UNSAFE: { label: '登録の ID の形が安全でない', order: 13, tone: 'caution', description: null },
  READ_VERIFICATION_MATCHED: { label: '照合の READ が一致した', order: 14, tone: 'positive', description: null },
  READ_VERIFICATION_NOT_MATCHED: { label: '照合の READ が一致しない', order: 15, tone: 'critical', description: null },
  READ_VERIFICATION_UNDETERMINED: { label: '照合の READ を判定できない', order: 16, tone: 'caution', description: null },
  // T31e fix round 1（Task 31 の設計書 3 章）: UPDATE の結果の理由（文言の確かめは T31h）。
  RECORD_ID_MISMATCH: { label: '取れた ID が更新の対象と違う', order: 17, tone: 'critical', description: null },
  UNEXPECTED_FIELD_CHANGE: { label: '更新の後に、指定していない変化がある', order: 18, tone: 'critical', description: null },
  // T31f: UPDATE の更新の後の照合を判定できない（文言の確かめは T31h）。
  UPDATE_POSTCHECK_UNDETERMINED: { label: '更新の後の照合を判定できない', order: 19, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 締めた予約の状態（`SETTLED_RESERVATION_STATES`）の表示。 */
export const SETTLED_RESERVATION_STATE_CATALOG = deepFreeze({
  COMMITTED: { label: '使った（送った）', order: 1, tone: 'notice', description: null },
  UNKNOWN: { label: '使った（送ったか分からない）', order: 2, tone: 'critical', description: null },
  RELEASED: { label: '返した（送っていない）', order: 3, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 書き込みの報告の「人が決めたこと」（`HUMAN_DECISIONS`。T32f。Task 32 の設計書 4.1）の表示。書き漏れは `tests/unit/action-report-changeability.test.ts`
 * が型と実行時で確かめる。
 */
export const HUMAN_DECISION_CATALOG = deepFreeze({
  SCENARIO_APPROVAL: { label: 'シナリオの版の承認', order: 1, tone: 'notice', description: '送る画面と送る欄と結果の確かめ方を、人が確かめて承認しました。' },
  INPUT_RULES: { label: '送る値の入力の規則', order: 2, tone: 'notice', description: '送る値の作り方の規則を、人が決めました。' },
  LIMITS: { label: '件数の上限と承認の期限', order: 3, tone: 'notice', description: '1 回の Run と累積の件数の上限、承認の期限の日数を、人が決めました。' },
  SIDE_EFFECT_CONFIRMATIONS: { label: '副作用の確認', order: 4, tone: 'notice', description: '承認の前に、副作用の確認の項目を人がすべて確かめました。' },
  UPDATE_FIELD_ROLES: { label: '変える欄と保つ欄（更新だけ）', order: 5, tone: 'notice', description: '更新で値を変える欄と、値を保つ欄を、人が決めました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 書き込みの報告の「自動で行うこと」（`AUTOMATED_ACTIONS`。T32f）の表示。書き漏れの確かめは `HUMAN_DECISION_CATALOG` と同じ。 */
export const AUTOMATED_ACTION_CATALOG = deepFreeze({
  VALUE_GENERATION: { label: '送る値の生成（合成のテストデータ）', order: 1, tone: 'neutral', description: '入力の規則から、送る値を BeakSight が作りました。' },
  TARGET_RECORD_SELECTION: {
    label: '更新するレコードの選択（更新だけ）',
    order: 2,
    tone: 'neutral',
    description: '台帳の登録のうち、照合まで済んだ最も新しいレコードを、BeakSight が選びました。',
  },
  SUBMISSION: { label: '送信', order: 3, tone: 'neutral', description: '承認した形のとおりに、BeakSight が 1 回だけ送りました。' },
  RESULT_JUDGEMENT: { label: '結果の判定', order: 4, tone: 'neutral', description: '送信の後の画面を、BeakSight が検証の指定で判定しました。' },
  READ_VERIFICATION: { label: '照合の READ', order: 5, tone: 'neutral', description: '登録・更新した内容を、BeakSight が READ で読み直して照らしました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 書き込みの報告の先頭の注意（T32f）の表示。 */
export const ACTION_REPORT_NOTICE_CATALOG = deepFreeze({
  HUMAN_ENTERED_VALUES: { label: '人の値', order: 1, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 書き込みの報告の親の確かめの結果（`src/control/job/job-records.ts` の `WRITE_REPORT_CHECKS`。T32g）の表示。画面は `VALID` のときだけ報告を配る。
 * 値の一覧と意味は `src/control/job/` が持ち、ここは表示だけを持つ。
 */
export const WRITE_REPORT_CHECK_CATALOG = deepFreeze({
  VALID: { label: '確かめ済み', order: 1, tone: 'positive', description: '報告のファイルが、結果と開始の時の承認とバンドルの目録に合うことを確かめました。' },
  REPORT_MISSING: {
    label: '報告のファイルがない',
    order: 2,
    tone: 'caution',
    description: '報告のファイルの一部がありません。書き込みの結果は、この画面の結果の欄で確かめてください。',
  },
  REPORT_INVALID: { label: '報告の形が違う', order: 3, tone: 'critical', description: '報告のファイルが、決まった形に合いません。' },
  REPORT_MISMATCH: { label: '報告がジョブと合わない', order: 4, tone: 'critical', description: '報告のジョブ・Run・シナリオ・結果が、このジョブの結果と違います。' },
  APPROVAL_FACTS_MISMATCH: {
    label: '承認の要約が開始の時と違う',
    order: 5,
    tone: 'critical',
    description: '報告の承認の要約が、書き込みを始めた時に確かめた承認の事実と違います。',
  },
  BUNDLE_MISMATCH: {
    label: 'バンドルが報告と合わない',
    order: 6,
    tone: 'critical',
    description: '報告の 4 つのファイルから組み立て直したバンドルと、ZIP が 1 バイトでも違います（展開できない ZIP も含みます）。',
  },
  RESULT_INVALID: { label: '結果のファイルが使えない', order: 7, tone: 'critical', description: '書き込みの結果のファイルが使えないため、報告を確かめられません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 検証の指定の項目（`SCENARIO_VERIFICATION_ITEMS`）の表示。 */
export const SCENARIO_VERIFICATION_ITEM_CATALOG = deepFreeze({
  successCondition: { label: '成功の条件', order: 1, tone: 'neutral', description: '送信の後の画面が、登録の成功に当たる条件（path の前方一致とセレクタ）です。' },
  inputErrorCondition: {
    label: '入力の誤りの条件',
    order: 2,
    tone: 'neutral',
    description: '送信の後の画面が、入力の誤りに当たる条件（path の前方一致とセレクタ）です。',
  },
  recordId: { label: '登録の ID の取り方', order: 3, tone: 'neutral', description: '成功の後の URL の path の型（例 /items/{id}）か、成功の画面の要素のセレクタです。' },
  readVerification: {
    label: '照合の READ',
    order: 4,
    tone: 'neutral',
    description: '生成した値で、登録した内容を読み直す READ の確かめの定義と、その期待です。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 登録の ID の取り方（`RECORD_ID_SOURCES`）の表示。 */
export const RECORD_ID_SOURCE_CATALOG = deepFreeze({
  URL_PATH_PATTERN: { label: '成功の後の URL の path の型', order: 1, tone: 'neutral', description: '{id} をちょうど 1 つ、path の 1 区切りの全体に書きます（例 /items/{id}）。' },
  ELEMENT: { label: '成功の画面の要素のセレクタ', order: 2, tone: 'neutral', description: 'ID を文字として表示する要素の CSS セレクタです。' },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 入力の規則（Task 29 の設計書 3 章の「補完の画面」、4.1、4.4。T29e）。値の一覧は `src/control/data-rules-view.ts` から公開し直したもの。書き漏れは
// `apps/local-ui/src/display/catalog-coverage.ts` が型で確かめる（`src/presentation/` は `src/control/` を import しない）。
// ---------------------------------------------------------------------------------------------------------------

/** 欄の意味の種類（`SEMANTIC_KINDS`）の表示。 */
export const SEMANTIC_KIND_CATALOG = deepFreeze({
  GENERIC_NUMBER: { label: '数（欄の型と範囲から）', order: 1, tone: 'neutral', description: null },
  GENERIC_DATETIME: { label: '日時（欄の型と範囲から）', order: 2, tone: 'neutral', description: null },
  GENERIC_CHOICE: { label: '選択肢（欄の選択肢から）', order: 3, tone: 'neutral', description: null },
  GENERIC_COLOR: { label: '色（欄の型から）', order: 4, tone: 'neutral', description: null },
  FAMILY_NAME: { label: '姓（漢字）', order: 5, tone: 'neutral', description: null },
  GIVEN_NAME: { label: '名（漢字）', order: 6, tone: 'neutral', description: null },
  FULL_NAME: { label: '氏名（姓と名）', order: 7, tone: 'neutral', description: null },
  FAMILY_NAME_KANA: { label: '姓のフリガナ', order: 8, tone: 'neutral', description: null },
  GIVEN_NAME_KANA: { label: '名のフリガナ', order: 9, tone: 'neutral', description: null },
  FULL_NAME_KANA: { label: '氏名のフリガナ', order: 10, tone: 'neutral', description: null },
  EMAIL: { label: 'メールアドレス（合成。届かない宛先）', order: 11, tone: 'notice', description: '配送されない予約のドメイン example.invalid の宛先だけを作ります。' },
  PHONE: { label: '電話番号（合成）', order: 12, tone: 'notice', description: '090-0 で始まる形（ハイフンなしは 0900 で始まる 11 桁）だけを作ります。' },
  NOTE: { label: '備考の文', order: 13, tone: 'neutral', description: null },
  PRODUCT_NAME: { label: '商品名', order: 14, tone: 'neutral', description: null },
  UNIT_PRICE: { label: '単価（数）', order: 15, tone: 'neutral', description: null },
  QUANTITY: { label: '数量（数）', order: 16, tone: 'neutral', description: null },
  TOTAL_PRICE: { label: '合計（単価 × 数量）', order: 17, tone: 'neutral', description: null },
  DATE: { label: '日付（日時）', order: 18, tone: 'neutral', description: null },
  START_TIME: { label: '開始の日時', order: 19, tone: 'neutral', description: null },
  END_TIME: { label: '終了の日時', order: 20, tone: 'neutral', description: null },
  PARTY_SIZE: { label: '人数（数）', order: 21, tone: 'neutral', description: null },
  FIXED_LIST: { label: '固定の一覧', order: 22, tone: 'neutral', description: '人が入れた値の一覧から選びます。' },
  OUT_OF_TEMPLATE: { label: 'テンプレートの外', order: 23, tone: 'neutral', description: '人が入れた値の一覧がなければ作りません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 値の作り方（`GENERATION_METHODS`）の表示。 */
export const GENERATION_METHOD_CATALOG = deepFreeze({
  FROM_TYPE: { label: '欄の型と制約から', order: 1, tone: 'neutral', description: null },
  FROM_TEMPLATE: { label: '業務テンプレートと辞書から', order: 2, tone: 'neutral', description: null },
  FROM_FIXED_LIST: { label: '人が入れた値の一覧から', order: 3, tone: 'neutral', description: '一覧の値を、1 行に 1 つ入れます。値は管理データにそのまま残ります。' },
} as const satisfies Record<string, DisplaySpec>);

/** 欄どうしの関係（`FIELD_RELATION_KINDS`）の表示。 */
export const FIELD_RELATION_KIND_CATALOG = deepFreeze({
  END_AFTER_START: { label: '終了は開始より後', order: 1, tone: 'neutral', description: null },
  TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY: { label: '合計は単価 × 数量', order: 2, tone: 'neutral', description: null },
  KANA_MATCHES_NAME: { label: 'フリガナは氏名と同じ人', order: 3, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 欄の規則の出どころ（`RULE_SOURCES`）の表示。 */
export const RULE_SOURCE_CATALOG = deepFreeze({
  HUMAN: { label: '人の規則', order: 1, tone: 'notice', description: 'この画面で決めた規則です（最も強い）。' },
  TEMPLATE: { label: '業務テンプレート', order: 2, tone: 'neutral', description: '欄の名前・型・autocomplete から推した規則です。' },
  GENERIC: { label: '汎用の規則', order: 3, tone: 'neutral', description: '欄の型と制約から作る規則です。' },
  OPT_OUT: { label: '送らない側に固定', order: 4, tone: 'shield', description: '通知・配信を求める欄なので、送らない側に固定しました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 欄ごとの判定の状態（`FIELD_RULE_STATUSES`）の表示。 */
export const FIELD_RULE_STATUS_CATALOG = deepFreeze({
  DECIDED: { label: '決まった', order: 1, tone: 'positive', description: null },
  NEEDS_RULE_INPUT: { label: '規則の入力が要る', order: 2, tone: 'caution', description: '推し量らずに止めました。規則を決めてください。' },
  RULE_CONFLICT: { label: '決まりがぶつかる', order: 3, tone: 'critical', description: '欄の制約や欄どうしの関係と、規則が合いません。' },
  EXTERNAL_DELIVERY_BLOCKED: {
    label: '外部到達で止めた',
    order: 4,
    tone: 'shield',
    description: 'メール・電話の欄は、シナリオの副作用の確認「外部の通知が送られない設定」を確かめるまで作りません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** シナリオの入力の規則の状態（`apps/local-ui/src/display/data-rules.ts` の `INPUT_RULE_STATES`）の表示。 */
export const INPUT_RULE_STATE_CATALOG = deepFreeze({
  NOT_SET: { label: '未設定', order: 1, tone: 'caution', description: '入力の規則を決めるまで、実行の許可は出せません。' },
  DECIDED: { label: 'すべて決まった', order: 2, tone: 'positive', description: '送る欄すべてに、値の作り方が決まっています。' },
  INSUFFICIENT: { label: '不足あり', order: 3, tone: 'caution', description: '値の作り方が決まらない欄があります。実行の許可は出せません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 外部到達の種類（`EXTERNAL_DELIVERY_KINDS`）の表示。 */
export const EXTERNAL_DELIVERY_KIND_CATALOG = deepFreeze({
  EMAIL: { label: 'メールの欄', order: 1, tone: 'shield', description: null },
  PHONE: { label: '電話の欄', order: 2, tone: 'shield', description: null },
  NOTIFICATION: { label: '通知・配信の欄', order: 3, tone: 'shield', description: null },
  ADDRESS: { label: '住所の欄', order: 4, tone: 'shield', description: null },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 並べ方
// ---------------------------------------------------------------------------------------------------------------

/**
 * 値を、カタログの表示の順（`order`）に並べた新しい配列を返す。同じ値は、入力の順のまま並ぶ。入力は変えない。
 * 表示面で値の順を決めるときは、値そのものを比べずに、この関数を使う。
 */
export const sortByDisplayOrder = <TValue extends string>(
  values: readonly TValue[],
  catalog: Readonly<Record<TValue, { readonly order: number }>>,
): readonly TValue[] => [...values].sort((left, right) => catalog[left].order - catalog[right].order);

/** category の節に入る `FindingCategory` を、表示の順に返す（対応は `FINDING_CATEGORY_CATALOG` の `section`）。 */
export const findingCategoriesInSection = (section: ReportCategorySection): readonly FindingCategory[] =>
  sortByDisplayOrder(
    FINDING_CATEGORIES.filter((category) => FINDING_CATEGORY_CATALOG[category].section === section),
    FINDING_CATEGORY_CATALOG,
  );

/**
 * severity の区分（サイト品質、Safety）に入る `Severity` を、表示の順に返す（対応は `SEVERITY_CATALOG` の `group`。C17a）。
 * 表示用モデルと CLI は、区分での絞り込みを、この関数だけで行う。
 */
export const severitiesInGroup = (group: SeverityGroup): readonly Severity[] =>
  sortByDisplayOrder(
    SEVERITIES.filter((severity) => SEVERITY_CATALOG[severity].group === group),
    SEVERITY_CATALOG,
  );
