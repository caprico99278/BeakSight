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
    description: 'WebSocket の接続を、遮断しました。',
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
    description: 'Interaction の操作の間に、ページが起こしたリクエストを遮断しました。',
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
    description: 'Interaction の操作の間に、ページが起こした WebSocket の接続を遮断しました。',
  },
  externalSchemeNavigations: {
    label: '外部スキームへの移動の試み',
    order: 11,
    tone: 'shield',
    // C18g: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      '外部スキーム（tel:、mailto: など）への移動の記録です。理由が EXTERNAL_SCHEME_NAVIGATION の記録は、ページが移動を試みたものです。ブラウザは移動していませんが、画面を表示する実行（headed）では、外部のアプリが起動した可能性があります。理由が EXTERNAL_SCHEME_REDIRECT_BLOCKED の記録は、サーバのリダイレクトを、ブラウザがたどる前に止めたものです。',
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
