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
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import type { BeakSightBlockRelation } from '../core/beaksight-block-relation.js';
import type { BlockedEventPhase, InteractionNotVerifiableKind, SafetyEventKind, ScreenshotCaptureType } from '../core/evidence-types.js';
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
    description: '1 回の点検で使える時間の上限に届いたため、残りのページは点検せずに止めました。',
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
    description: '安全の決まりに反することを見つけたため、それより後の点検を始めませんでした。',
  },
  STOPPED_BY_SITE_UNAVAILABLE: {
    label: 'サイトの不調で停止',
    order: 5,
    tone: 'caution',
    description: 'サイトが応答しない（時間切れ、つながらない、混み合っているという返事など）ため、残りのページは点検せずに止めました。',
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
    description: 'ログインが切れた（ログインの画面に移った）ため、そのページも残りのページも点検せずに止めました。',
  },
  // T35c（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限に届いて止まった。core の一覧の並び（最後）に合わせる。
  STOPPED_BY_SERVICE_REQUEST_LIMIT: {
    label: '外のサイトへの通信の上限で停止',
    order: 8,
    tone: 'caution',
    description: 'ログインのときに通ってよい外のサイトへの通信の上限に届いたため、残りのページは点検せずに止めました。1 分あたりの上限なら、続きから再開すると残りを点検します。1 回の点検の全体の上限に届いたときは、再開してもすぐに止まります。',
  },
} as const satisfies Record<RunExecutionEndReason, DisplaySpec>);

/** PL-R: ページの状態（報告だけの文言。画面と同じやさしい言葉。設計書 5 章）。 */
export const PAGE_AUDIT_STATUS_CATALOG = deepFreeze({
  AUDITED: {
    label: '最後まで見た',
    order: 1,
    tone: 'positive',
    description: '必要な確かめを、すべて終えました。',
  },
  PARTIAL: {
    label: '一部だけ見た',
    order: 2,
    tone: 'caution',
    description: '一部を確かめきれませんでした。',
  },
  SKIPPED: {
    label: '見なかった',
    order: 3,
    tone: 'neutral',
    description: '上限などの理由で、点検しませんでした。',
  },
  FAILED: {
    label: '点検できなかった',
    order: 4,
    tone: 'critical',
    description: 'ページを点検できませんでした。',
  },
} as const satisfies Record<PageAuditStatus, DisplaySpec>);

/** PL-R: 押して確かめた操作の結果（報告だけの文言）。 */
export const INTERACTION_STATUS_CATALOG = deepFreeze({
  VERIFIED: {
    label: '確かめた',
    order: 1,
    tone: 'positive',
    description: '操作の結果、ページの状態が変わることを確かめました。',
  },
  REJECTED_UNSAFE: {
    label: '安全のため押さなかった',
    order: 2,
    tone: 'shield',
    description: '押しても安全だと確かめられないため、押しませんでした。',
  },
  BLOCKED_BY_SAFETY: {
    label: '安全のため止めた',
    order: 3,
    tone: 'shield',
    description: '押した後に、安全のために送信やほかのアプリを開く動きを止めました。',
  },
  NOT_VERIFIABLE: {
    label: '確かめられなかった',
    order: 4,
    tone: 'caution',
    description: '押した結果を確かめられませんでした。',
  },
  EXECUTION_FAILED: {
    label: '押せなかった',
    order: 5,
    tone: 'critical',
    description: '押す操作が、うまくいきませんでした。',
  },
} as const satisfies Record<InteractionStatus, DisplaySpec>);

export const INTERACTION_NOT_VERIFIABLE_KIND_CATALOG = deepFreeze({
  OBSERVED_NO_CHANGE: {
    label: '変わらなかった',
    order: 1,
    tone: 'neutral',
    description: '確かめる手順を終えましたが、画面の変化は見られませんでした。',
  },
  CHECK_NOT_COMPLETED: {
    label: '確かめを終えられなかった',
    order: 2,
    tone: 'caution',
    description: '確かめる手順を、最後まで終えられませんでした。',
  },
} as const satisfies Record<InteractionNotVerifiableKind, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// Evidence、ビューポート、スクリーンショット
// ---------------------------------------------------------------------------------------------------------------

/** PL-R: 証拠の記録の種類（報告だけの文言。やさしい言葉に、元の技術の語を括弧で添える）。 */
export const EVIDENCE_TYPE_CATALOG = deepFreeze({
  network: { label: '通信の記録', order: 1, tone: 'neutral', description: null },
  console: { label: 'ブラウザのメッセージ（コンソール）', order: 2, tone: 'neutral', description: null },
  dom: { label: 'ページの作り（HTML）', order: 3, tone: 'neutral', description: null },
  link: { label: 'リンク', order: 4, tone: 'neutral', description: null },
  layout: { label: '見た目の配置', order: 5, tone: 'neutral', description: null },
  color: { label: '色', order: 6, tone: 'neutral', description: null },
  performance: { label: '表示の速さ', order: 7, tone: 'neutral', description: null },
  accessibility: { label: '使いやすさ（アクセシビリティ）', order: 8, tone: 'neutral', description: null },
  interaction: { label: '押して確かめた操作', order: 9, tone: 'neutral', description: null },
  screenshot: { label: '画面の写真', order: 10, tone: 'neutral', description: null },
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
  VIEWPORT: { label: '表示範囲', order: 1, tone: 'neutral', description: '画面に見えている範囲です。' },
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
 * Safety の事象の記録の種類の、日本語のラベルと表示の順（PL-R: ラベルは報告だけの文言で、やさしい言葉にした。説明は理由のコードを読むための技術の記録のまま）。表示の順は、core の `SAFETY_EVENT_KINDS` の順（`SafetyEventsEvidence` の
 * 項目の順）と同じにする（設計書 6.1.10）。
 */
export const SAFETY_EVENT_KIND_CATALOG = deepFreeze({
  blockedRequests: {
    label: '止めた要求',
    order: 1,
    tone: 'shield',
    // T44R2 の M-7: 今の止め方に合わせた（理由ごとの説明は、事象の一覧の理由の欄。`BLOCKED_REQUEST_REASON_DESCRIPTIONS`）。
    description:
      'Guard が止めたリクエストです。読み取りでない送信のほか、1 画面あたりの読み込みの上限や、承認したサービスの Origin への要求の上限を超えたもの、閉じる前に画面を離れた後の上限を超えたもの（GET も止めます）を含みます。止めた理由は、理由の欄に示します。',
  },
  blockedNavigations: {
    label: '止めたページの移動',
    order: 2,
    tone: 'shield',
    description: '許可 Origin の外へのメインフレームのナビゲーションを、遮断しました。',
  },
  blockedWebSockets: {
    label: '止めた常時の接続（WebSocket）',
    order: 3,
    tone: 'shield',
    // DEF-040（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      'WebSocket の接続を、遮断しました。理由が PASSIVE_WEBSOCKET の記録は、ページ（文書）が開いた接続を Guard が止めたものです。理由が WORKER_CONNECT_POLICY の記録は、Worker の中で開いた接続を、BeakSight が文書と Worker に加える通信の制限（CSP の connect-src）が止めたものです。この記録は観察によるもので、止めた接続のすべてが残るとは限りません。理由が AUDIT_SEND_OVER_LIMIT の記録は、ページが出す送信を通す扱いで、1 つの読み込みで通す接続の数の上限を超えたものです。',
  },
  blockedExternalActions: {
    label: '押さなかった、外への動きのある操作',
    order: 4,
    tone: 'shield',
    description: '外部への作用（外部 Origin、特殊な scheme、ダウンロード）がある Interaction の候補を、実行しませんでした。',
  },
  excludedInteractionCandidates: {
    label: '安全のため外した、押す候補',
    order: 5,
    tone: 'shield',
    description: '安全のため、Interaction の候補を機械的に除外しました。',
  },
  blockedInteractionRequests: {
    label: '押した後に止めた要求',
    order: 6,
    tone: 'shield',
    // DEF-039（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。M3（NPR2）: 中継の記録に
    // Chromium 自身の通信が含まれうることも示す。
    description:
      'Interaction の操作の間に、ページが起こしたリクエストを遮断しました。理由が INTERACTION_FROZEN の記録は、通信を止めた後に Guard が止めたものです。理由が INTERACTION_FROZEN_EGRESS の記録は、通信を止めた後に、Interaction の環境の通信を通す BeakSight の中継（127.0.0.1 の proxy）が拒んだものです。Guard を通らずに出た要求の証拠で、CONNECT の記録の URL は host:port の形です。理由が EGRESS_UPSTREAM_DENIED の記録は、中継の上流の方針で拒んだものです（通常は出ません）。理由が GUARD_BYPASS_EGRESS の記録は、Guard を通らずに出ようとした通信を、BeakSight の中継が拒んだものです。Guard が許さない method や URL の要求と、Guard が通していない宛先への接続（記録の method は CONNECT、URL は host:port の形）があります。接続の記録には、ページが Guard を通さずに始めた接続のほかに、Chromium が Guard の止めたナビゲーションの先へ先回りして始めた接続も含まれることがあります。この理由の記録と、通信を止めた後の中継の記録（INTERACTION_FROZEN_EGRESS）は、Interaction の操作に限らず、ページの読み込みと発見の段階の記録にも現れます。環境を閉じる途中に中継が拒んだ要求は、記録しません。中継の記録には、ページの通信のほかに、Chromium 自身の通信（例: Google への接続）も含まれることがあります。',
  },
  blockedInteractionNavigations: {
    label: '押した後に止めたページの移動',
    order: 7,
    tone: 'shield',
    description: 'Interaction の操作の間に、ページが起こしたナビゲーションを遮断しました。',
  },
  blockedPopups: {
    label: '止めた別の窓（ポップアップ）',
    order: 8,
    tone: 'shield',
    description: 'ポップアップを、遮断しました。',
  },
  blockedDownloads: {
    label: '止めたダウンロード',
    order: 9,
    tone: 'shield',
    description: 'ダウンロードを、遮断しました。',
  },
  blockedInteractionWebSockets: {
    label: '押した後に止めた常時の接続（WebSocket）',
    order: 10,
    tone: 'shield',
    // DEF-040（NP4）: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      'Interaction の操作の間に、ページが起こした WebSocket の接続を遮断しました。理由が INTERACTION_FROZEN の記録は、ページ（文書）が開いた接続を Guard が止めたものです。理由が WORKER_CONNECT_POLICY の記録は、Worker の中で開いた接続を、BeakSight が文書と Worker に加える通信の制限（CSP の connect-src）が止めたものです。この記録は観察によるもので、止めた接続のすべてが残るとは限りません。',
  },
  externalSchemeNavigations: {
    label: 'ほかのアプリを開こうとした移動（tel: など）',
    order: 11,
    tone: 'shield',
    // C18g: 理由のコードごとの意味を示す（レポートは、事象の理由のコードをそのまま表示する）。
    description:
      '外部スキーム（tel:、mailto: など）への移動の記録です。理由が EXTERNAL_SCHEME_NAVIGATION の記録は、ページが移動を試みたものです。ブラウザの設定が移動を止め、外部のアプリへは渡していませんが、ページが外部のアプリを開こうとしたので、安全の不変条件の違反として記録し、Run を止めます。理由が EXTERNAL_SCHEME_REDIRECT_BLOCKED の記録は、サーバのリダイレクトを、ブラウザがたどる前に止めたものです。',
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

/**
 * HTML レポートの節の閉じた一覧。`CATEGORY_FINDINGS` の位置に、category の節（`REPORT_CATEGORY_SECTIONS`）を並べる。
 * PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）: 冒頭は「まとめ」（`OVERVIEW`）。Run の ID・許可 Origin・環境・版・送った要求の数などの
 * 技術の記録（前の「要約」）は、末尾の「記録」（`RECORD`）に置く（消さない）。
 */
export const REPORT_SECTIONS = Object.freeze([
  'OVERVIEW',
  'CRITICAL_FINDINGS',
  'CATEGORY_FINDINGS',
  'INTERACTIONS',
  'SAFETY',
  'PAGES',
  'RECORD',
] as const);
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** PL-R: 報告の節の名前と説明（報告だけの文言。画面と同じやさしい言葉。設計書 5 章）。 */
export const REPORT_SECTION_CATALOG = deepFreeze({
  OVERVIEW: {
    label: 'まとめ',
    order: 1,
    anchor: 'overview',
    description: '何を見たか、見つかった問題の数、大事な問題、見られなかったところです。',
  },
  CRITICAL_FINDINGS: {
    label: '重い問題（エラー）',
    order: 2,
    anchor: 'critical-findings',
    description: '重さが「エラー」の問題の一覧です。種類を問わず、ここに集めました。',
  },
  CATEGORY_FINDINGS: {
    label: '種類ごとの問題',
    order: 3,
    anchor: 'findings-by-category',
    description: null,
  },
  INTERACTIONS: {
    label: '押して確かめた操作',
    order: 4,
    anchor: 'interactions',
    description: 'ページの中のボタンなどを押して確かめた、ひとつひとつの結果です。',
  },
  SAFETY: {
    label: '安全のために止めたこと',
    order: 5,
    anchor: 'safety',
    description: 'サイトのデータを変えないように止めた送信などと、安全の決まりに反したことの記録です。',
  },
  PAGES: {
    label: 'ページごとの結果',
    order: 6,
    anchor: 'pages',
    description: 'ページごとの状態、画面の幅ごとの状態、画面の写真です。',
  },
  RECORD: {
    label: '記録',
    order: 7,
    anchor: 'record',
    description: 'あとで調べるための技術の記録です（点検の回の ID、サイトのアドレス、BeakSight の版、サイトに送った要求の数など）。',
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

/** PL-R: 種類ごとの節の名前と説明（報告だけの文言。やさしい言葉に、元の技術の語を括弧で添える）。 */
export const REPORT_CATEGORY_SECTION_CATALOG = deepFreeze({
  NETWORK: { label: '通信（ネットワーク）', order: 1, anchor: 'category-network', description: 'ページの返事と、画像やプログラムなどの読み込みの問題です。' },
  JAVASCRIPT: { label: 'ページの中のプログラム（JavaScript）', order: 2, anchor: 'category-javascript', description: null },
  LINKS: { label: 'リンク', order: 3, anchor: 'category-links', description: null },
  DOM: { label: 'ページの作り（HTML）', order: 4, anchor: 'category-dom', description: null },
  FORM: { label: '入力の欄（フォーム）', order: 5, anchor: 'category-form', description: null },
  LAYOUT: { label: '見た目のくずれ（レイアウト）', order: 6, anchor: 'category-layout', description: null },
  ACCESSIBILITY: { label: '使いやすさ（アクセシビリティ）', order: 7, anchor: 'category-accessibility', description: null },
  PERFORMANCE: { label: '表示の速さ', order: 8, anchor: 'category-performance', description: null },
  CROSS_PAGE: { label: 'ページどうしの比べ', order: 9, anchor: 'category-cross-page', description: 'いくつかのページを比べて見つけた問題です。' },
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
    label: '公開の画面の点検',
    order: 1,
    tone: 'positive',
    description: '公開しているページを、ログインせずに、見るだけで点検します。',
  },
  TEST_AUTH_PASSIVE: {
    label: 'ログインして見るだけの点検',
    order: 2,
    tone: 'caution',
    description: 'テスト用のサイトに、ログインしてから、見るだけで点検します。',
  },
  TEST_APPROVED_WRITE: {
    label: '書き込みも試す点検',
    order: 3,
    tone: 'caution',
    description: 'テスト用のサイトで、書き込みの OK を出した操作も試します。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 環境の種類（`ENVIRONMENT_KINDS`）の表示。 */
export const ENVIRONMENT_KIND_CATALOG = deepFreeze({
  PUBLIC: { label: '本番のサイト', order: 1, tone: 'neutral', description: null },
  TEST: { label: 'テスト用のサイト', order: 2, tone: 'notice', description: null },
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
  RETIRED: { label: '取り消し', order: 2, tone: 'neutral', description: '取り消したサイトは、元に戻せません。' },
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
  STARTING: { label: '開始中', order: 1, tone: 'notice', description: '作業を始めています。' },
  RUNNING: { label: '実行中', order: 2, tone: 'notice', description: '作業を進めています。' },
  STOPPING: {
    label: '停止中',
    order: 3,
    tone: 'caution',
    description: '止めるように伝えました。今していることを終えてから止まります。',
  },
  FINISHED: {
    label: '終了',
    order: 4,
    tone: 'positive',
    description: '作業が終わりました。結果は、この画面に出ています。',
  },
  FAILED: { label: '失敗', order: 5, tone: 'critical', description: '作業が失敗しました。' },
  INTERRUPTED: {
    label: '中断',
    order: 6,
    tone: 'caution',
    description: '結果が出る前に、作業が止まりました。点検の作業は、続きから再開できます。同じサイトで「点検を始める」を押すと、続きから点検します。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 監査のジョブの終わり方（監査の中核の結果の種類。`src/control/worker-protocol.ts` の `WORKER_OUTCOME_KINDS`）の表示。値の一覧と意味は
 * `src/control/` が持ち、ここは表示だけを持つ。書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUDIT_JOB_END_KIND_CATALOG = deepFreeze({
  RAN: { label: '結果を出して終わりました', order: 1, tone: 'positive', description: null },
  RUN_ACTIVE: {
    label: '別の点検の回が動いている',
    order: 2,
    tone: 'caution',
    description: '同じ結果の保存先で、別の点検の回が動いているか、始まるところでした。その点検が終わってから、もう一度始めてください。',
  },
  VERSION_MISMATCH: {
    label: '途中の点検の回の形が違う',
    order: 3,
    tone: 'caution',
    description: '途中の点検の回は、記録の形が今と違うため、再開できません。最初から始めるには、「新しく始める」を選んで点検を始めてください。',
  },
  RUN_DIRECTORY_UNAVAILABLE: {
    label: '点検の回の記録のフォルダを作れない',
    order: 4,
    tone: 'critical',
    description: '点検の回の記録を置くフォルダを作れなかったため、点検を始めずに終えました。',
  },
  RESUME_UNAVAILABLE: {
    label: '再開を始められない',
    order: 5,
    tone: 'caution',
    description: '途中の点検の回を、再開できませんでした。別のプログラムが動いている、再開のための記録を読み書きできない、などが考えられます。',
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
    // ML-b（手動のログインの設計書 2.2）: 手動のログインでは「ログインを終えた」で先へ進める。
    description: 'BeakSight が開いたブラウザで、ログインしてください。ログインが済むと、そのブラウザを閉じて作業を始めます。手でログインするときは、「ログインを終えた」を押すと先へ進みます。',
  },
  AUTHENTICATED: {
    label: 'ログイン済み',
    order: 2,
    tone: 'positive',
    description: 'ログインが済みました。ログインしている状態は保存せず、この作業の間だけ使います。',
  },
  AUTH_SETUP_REQUIRED: {
    label: 'ログインを続けられない',
    order: 3,
    tone: 'critical',
    description: 'ログインのブラウザが閉じられたか、ログインの画面を安全に開けませんでした。ログインの設定を確かめてください。',
  },
  UNSUPPORTED_AUTH_STATE: {
    label: '扱えないログインの形',
    order: 4,
    tone: 'critical',
    description: 'ログインした後に、点検してよいサイトの、ブラウザに残るログインの印も、ブラウザの保存場所の中身もありませんでした。この形のログインには、まだ対応していません。',
  },
  SESSION_LOST: {
    label: 'ログインが切れた',
    order: 5,
    tone: 'caution',
    description: '作業の途中で、ログインが切れたため止まりました。点検の作業は、再開すると、もう一度ログインしてから続けます。',
  },
  LOGIN_TIMEOUT: {
    label: 'ログインの時間切れ',
    order: 6,
    tone: 'caution',
    description: '決められた時間の中に、ログインが済みませんでした。作業は始めていません。',
  },
  LOGIN_ATTEMPTS_EXCEEDED: {
    label: 'ログインの回数の上限',
    order: 7,
    tone: 'critical',
    description: 'ログインの送信先への送信を止めたため、ログインを止めました。回数の上限を超えたか、BeakSight が扱えない形のログインの可能性があります。作業は始めていません。',
  },
  // T26d-2（Task 26 の設計書 4.5）: 自動ログインの段が成功以外で終わった（結果ごとの案内は、ジョブの失敗の理由の文言）。T26e で文言を見直した。
  AUTOMATED_LOGIN_FAILED: {
    label: '自動ログインの失敗',
    order: 8,
    tone: 'critical',
    description: '保存した ID とパスワードでの自動ログインが、成功しませんでした。作業は始めていません。この画面の「自動ログイン」の欄の結果と、人がすることを確かめてください。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 保存した認証の設定の新しさ（値の一覧は `src/control/store/auth-setup-store.ts` の `AUTH_SETUP_FRESHNESS_VALUES`。Task 25 の設計書 4.1、4.5。
 * T25e）。書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUTH_SETUP_FRESHNESS_CATALOG = deepFreeze({
  CURRENT: {
    label: '今の設定で保存済み',
    order: 1,
    tone: 'positive',
    description: null,
  },
  STALE: {
    label: '古い（保存し直しが必要）',
    order: 2,
    tone: 'caution',
    description: 'サイトの設定が変わったため、このログインの設定では点検を始めません。内容を見直して、保存し直してください。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * ログインの送り方（`src/control/auth/auth-setup-contracts.ts` の `LOGIN_TRANSPORTS`。T34d。Task 34 の設計書 3.2、3.6）の表示。値の一覧と意味は
 * `src/control/` が持ち、ここは表示だけを持つ。
 */
export const LOGIN_TRANSPORT_CATALOG = deepFreeze({
  FORM_NAVIGATION: {
    label: 'フォームの送信',
    order: 1,
    tone: 'neutral',
    description: 'ログインのフォームを送ると、画面が移ります（送信先は「ログインの送信先」に書きます）。',
  },
  SCRIPT_REQUEST: {
    label: 'ページの中のプログラムが送る',
    order: 2,
    tone: 'neutral',
    description: 'ログインの画面の中のプログラムが、ログインのときに通ってよい外のサイトへ、ログインの合い札を取りに行きます。画面は移らずに、そのプログラムが次の画面を開きます。',
  },
} as const satisfies Record<string, DisplaySpec>);

// PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: プロファイルの「次にすること」の表（手順と状態の表示。T43a）は、サイトの画面の要点と主の
// ボタンに置き換えたので消した（文言は `messages.ts` の `LOCAL_UI_NEXT_STEP_TEXT`）。

// ---------------------------------------------------------------------------------------------------------------
// 自動ログイン（ローカルの管理画面の資格情報、ログインの確かめ、ジョブの結果。Task 26 の設計書 4.2、4.6。T26e）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ジョブの種類（`src/control/job/job-records.ts` の `AUDIT_JOB_KINDS`）の表示。値の一覧と意味は `src/control/` が持ち、ここは表示だけを持つ。
 * 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 */
export const AUDIT_JOB_KIND_CATALOG = deepFreeze({
  AUDIT: { label: '点検', order: 1, tone: 'neutral', description: null },
  LOGIN_CHECK: {
    label: 'ログインの確かめ',
    order: 2,
    tone: 'notice',
    description: '保存した ID とパスワードで、ログインだけを 1 回試し、結果を記録する作業です。点検はしません。',
  },
  // T27c（Task 27 の設計書 4.6）: 操作の候補の発見と READ の確かめ。T27f で文言を見直した（進み具合を送らないことを書き足した）。
  DISCOVERY: {
    label: '操作さがし',
    order: 3,
    tone: 'notice',
    description: 'ログインの後に管理画面を見るだけで、フォームとボタンを操作の候補として集め、分類する作業です。送信や書き込みはしません。この作業は進み具合を知らせないので、種類と状態だけを示します。',
  },
  READ_CHECK: {
    label: '見るだけの確かめ',
    order: 4,
    tone: 'notice',
    description: 'ログインの後に、人が決めた見るだけの確かめ（一覧・詳細・検索の画面を見る）を行い、結果があるはずのものと合うかを比べる作業です。書き込みはしません。この作業は進み具合を知らせないので、種類と状態だけを示します。',
  },
  // T30d（Task 30 の設計書 3 章の「記録」）: 書き込みのジョブ。始める口と画面は T30e・T30g。
  WRITE_CREATE: {
    label: '新しく登録する書き込み',
    order: 5,
    tone: 'notice',
    description: '書き込みの OK を出した書き込みの手順に従って、テスト用のサイトに 1 件だけ新しく登録し、結果を確かめる作業です。',
  },
  // T31e（Task 31 の設計書 3 章の「記録」）: 更新の書き込みのジョブ。始める口と画面は T31f・T31h。
  WRITE_UPDATE: {
    label: '更新する書き込み',
    order: 6,
    tone: 'notice',
    description: '書き込みの OK を出した書き込みの手順に従って、テスト用のサイトのデータを 1 件だけ更新し、前後の値を確かめる作業です。更新するのは、BeakSight が登録して、答え合わせが合ったデータだけです。',
  },
  // T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブ。OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11）: 画面の名前は「サイトの下調べ」
  // （内部のコードの名前は変えない）。
  ENTRY_CHECK: {
    label: 'サイトの下調べ',
    order: 7,
    tone: 'notice',
    description: 'ログインしないで開始のアドレスのページを 1 回だけ開き、ログインの画面の欄と送り方の案を作る作業です。欄の値は読まず、送信や書き込みはしません。',
  },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 入口の確かめ（ローカルの管理画面。Task 43 の設計書 4.3。T43c）
// 値の一覧と意味は `src/control/entry-check.ts` が持ち、ここは表示だけを持つ。書き漏れと余分は、画面の側（`catalog-coverage.ts`）で型で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** 入口の確かめの終わり方（`ENTRY_CHECK_END_REASONS`）の表示。 */
export const ENTRY_CHECK_END_REASON_CATALOG = deepFreeze({
  READ: {
    label: '見られた',
    order: 1,
    tone: 'positive',
    description: '開始のアドレスのページを開き、表示が落ち着いた後に、見るだけで調べました。',
  },
  LEFT_ALLOWED_ORIGINS: {
    label: '点検してよいサイトの外へ移ろうとした',
    order: 2,
    tone: 'caution',
    description: '開始のアドレスのページが、点検してよいサイトの外へ移ろうとしました。BeakSight は移らずに止め、移ろうとしたサイトのアドレスだけを記録しました。外のログインのサービスへ移る形かもしれません。案は作っていません。',
  },
  READ_FAILED: {
    label: '中身を見られなかった',
    order: 3,
    tone: 'caution',
    description: '開始のアドレスのページは開けましたが、表示が落ち着かないか、中身を見られませんでした。案は作っていません。',
  },
  NAVIGATION_FAILED: {
    label: 'ページを開けなかった',
    order: 4,
    tone: 'critical',
    description: '開始のアドレスのページを開けませんでした（応答がない、時間切れなど）。BeakSight は、もう一度開き直すことはしません。',
  },
  PREFLIGHT_FAILED: {
    label: '始める前の確認で止まった',
    order: 5,
    tone: 'critical',
    description: 'ブラウザや結果の保存先の準備ができなかったため、開始のアドレスのページを開かずに止めました。',
  },
  STOPPED: {
    label: '止めた',
    order: 6,
    tone: 'neutral',
    description: '止める操作で、開始のアドレスのページを開く前に止めました。',
  },
  SAFETY_VIOLATION: {
    label: '安全のために止めた',
    order: 7,
    tone: 'critical',
    description: '安全の決まりに反する動きを記録したため、結果を使わずに止めました。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 入口の確かめの、3 つの要素の form の中の置き方（`ENTRY_CHECK_FORM_PLACEMENTS`）の表示。 */
export const ENTRY_CHECK_FORM_PLACEMENT_CATALOG = deepFreeze({
  SAME: { label: '3 つが同じフォームの中', order: 1, tone: 'neutral', description: null },
  NONE: { label: '3 つともフォームの外', order: 2, tone: 'neutral', description: null },
  MIXED: {
    label: '混ざっている',
    order: 3,
    tone: 'caution',
    description: '一部だけがフォームの中にあるか、別々のフォームの中にあります。自動ログインはこの形を止めるので、送り方の案は作っていません。',
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
    label: '見るだけ（検索など）',
    order: 1,
    tone: 'positive',
    description: '見るだけの通信で送るフォームです。「見るだけの確かめ」で、送る値とあるはずのものを決めて確かめられます。',
  },
  CREATE: {
    label: '登録（新しく作る）',
    order: 2,
    tone: 'notice',
    description: '新しく登録する操作に見える候補です。この画面からは実行できません。書き込みも試す点検のサイトでは、書き込みの手順にして書き込みの OK を出した後に、1 件ずつ送れます。',
  },
  UPDATE: {
    label: '更新',
    order: 3,
    tone: 'notice',
    description: '更新する操作に見える候補です。この画面からは実行できません。書き込みも試す点検のサイトでは、書き込みの手順にして書き込みの OK を出した後に、BeakSight が登録したデータを 1 件ずつ更新できます。',
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
    description: 'ページの中のプログラムで送る候補です。何をどこへ送るかを画面から決められないので、この画面からは実行できません。',
  },
  UNSUPPORTED_READ_TRANSPORT: {
    label: '扱えない見るだけの操作',
    order: 6,
    tone: 'caution',
    description: '送る通信を使う検索や、パスワードの欄やファイルを送る形のある見るだけの通信などです。この画面からは実行できず、見るだけの確かめにも使えません。',
  },
  BLOCKED_EXTERNAL: {
    label: '点検してよいサイトの外へ送る',
    order: 7,
    tone: 'critical',
    description: '送り先が、点検してよいサイトの外です。この画面からは実行できません。',
  },
  DISPLAY_ONLY: {
    label: '分類できない（表示だけ）',
    order: 8,
    tone: 'neutral',
    description: '決まりで分類できなかった候補です。候補として示すだけで、この画面からは実行できません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 候補の種類（`CANDIDATE_KINDS`）の表示。 */
export const CANDIDATE_KIND_CATALOG = deepFreeze({
  FORM: { label: 'フォーム', order: 1, tone: 'neutral', description: null },
  BUTTON: { label: 'ボタン', order: 2, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 候補の索引のドリフト（`src/control/job/discovery-index-store.ts` の `DISCOVERY_INDEX_DRIFTS`。最後の発見のジョブに対するもの）の表示。 */
export const DISCOVERY_DRIFT_CATALOG = deepFreeze({
  NEW: { label: '新しい', order: 1, tone: 'notice', description: '一番新しい操作さがしで、初めて見つかった候補です。' },
  CHANGED: {
    label: '変わった',
    order: 2,
    tone: 'caution',
    description: 'その前の操作さがしから、入れる値の決まり（必須・変えられない・制約・選択肢など）、分類、理由、状態の欄の印のどれかが変わりました。',
  },
  UNCHANGED: { label: '変わらない', order: 3, tone: 'neutral', description: 'その前の操作さがしと同じです。' },
  MISSING: {
    label: '消えた',
    order: 4,
    tone: 'caution',
    description: '一番新しい操作さがしで見終えた画面に、この候補がありませんでした。記録は消さずに残し、前に見たときの内容を示します。',
  },
  NOT_REVISITED: {
    label: '見直していない',
    order: 5,
    tone: 'neutral',
    description: '一番新しい操作さがしでは、この候補の画面を見ませんでした（見るページの数の上限や、見終えられなかった画面など）。前に見たときの内容を示します。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * T37c（Task 37 の設計書 3.4、3.6）: 送らずに観察する probe の結果（`src/discovery/submission-probe-contracts.ts` の `SUBMISSION_PROBE_RESULTS`）の表示。
 * 結果は承認の材料で、この画面からの実行の可否は変えない。
 */
export const SUBMISSION_PROBE_RESULT_CATALOG = deepFreeze({
  API_CREATE: {
    label: '画面を通さない送信での登録',
    order: 1,
    tone: 'notice',
    description: '押すと、ログインのときに通ってよい外のサイトへ、新しく登録する形の送信をする画面でした。BeakSight は送らずに止めました。',
  },
  API_UPDATE: {
    label: '画面を通さない送信での更新',
    order: 2,
    tone: 'notice',
    description: '押すと、ログインのときに通ってよい外のサイトへ、画面に出ているデータ 1 件を更新する形の送信をする画面でした。BeakSight は送らずに止めました。',
  },
  NOT_EXECUTABLE: {
    label: '実行できない形',
    order: 3,
    tone: 'critical',
    description: '押すと、削除・重なったら上書き・手続きの呼び出し・2 回以上の送信など、BeakSight が実行しない形の送信をする画面でした。BeakSight は送らずに止めました。',
  },
  NO_REQUEST: {
    label: '送信なし',
    order: 4,
    tone: 'neutral',
    description: '押しても、見るだけでない送信が出ませんでした（画面の入力の確かめで止まった場合も含みます）。',
  },
  NOT_OBSERVED: {
    label: '確かめていない',
    order: 5,
    tone: 'caution',
    description: '押さなかったか、押した後の送信を確かめられませんでした。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** T37c: 送らずに観察する probe の理由（実行できない理由と、観察しなかった理由。`SUBMISSION_PROBE_REASONS`）の表示。 */
export const SUBMISSION_PROBE_REASON_CATALOG = deepFreeze({
  DELETE_METHOD: { label: '削除の送信', order: 1, tone: 'critical', description: null },
  PUT_METHOD: { label: '丸ごと置き換える送信', order: 2, tone: 'critical', description: null },
  // T37R2-fix-A（M-2 (b)）: method を上書きするヘッダか、本文の `_method` がある。
  METHOD_OVERRIDE: { label: '送信の種類を変える印がある', order: 3, tone: 'critical', description: null },
  UNAPPROVED_ORIGIN: { label: 'ログインのときに通ってよい外のサイトのほかへの送信', order: 4, tone: 'critical', description: null },
  PROCEDURE_CALL_PATH: { label: '手続きの呼び出し', order: 5, tone: 'critical', description: null },
  UPSERT: { label: '重なったら上書きする送信', order: 6, tone: 'critical', description: null },
  ARRAY_BODY: { label: '一度に複数件を送る', order: 7, tone: 'critical', description: null },
  NON_JSON_BODY: { label: '送る中身が決まった形（JSON）でない', order: 8, tone: 'critical', description: null },
  MULTIPLE_REQUESTS: { label: '1 回の押下で 2 つ以上の要求', order: 9, tone: 'critical', description: null },
  SOFT_DELETE_KEY: { label: '削除の印を付ける項目がある', order: 10, tone: 'critical', description: null },
  // T37R-fix-A（I-3）・T37R2-fix-A（M-2 (a)）: 本文の鍵が上限で切り詰められた、伏せた鍵の名前がある、path が長すぎて伏せた、ヘッダの名前が多すぎる。
  SHAPE_TRUNCATED: { label: '送信の形を全部は確かめられない（項目が多すぎる・伏せた名前がある・アドレスが長すぎる）', order: 11, tone: 'critical', description: null },
  FILTER_MISSING: { label: '更新するデータの指定がない', order: 12, tone: 'critical', description: null },
  FILTER_MULTIPLE: { label: '更新するデータの指定が 2 つ以上', order: 13, tone: 'critical', description: null },
  FILTER_NOT_PAGE_VALUE: { label: '更新するデータの指定が、画面で最後に見たデータと違う', order: 14, tone: 'critical', description: null },
  UNRECOGNIZED: { label: '新しく登録と更新のどちらの形でもない', order: 15, tone: 'critical', description: null },
  // DEF-144: 外部のアプリ（メール・電話など）へ移るボタン。押さない（押して移ろうとしたものも、この理由にする）。
  EXTERNAL_SCHEME: { label: 'ほかのアプリ（メールや電話など）へ移るボタンなので押さなかった', order: 16, tone: 'caution', description: null },
  PAGE_CHANGED: { label: '押した後に画面が移った', order: 17, tone: 'caution', description: null },
  PRESS_LIMIT_REACHED: { label: '1 画面の押す回数の上限を超えた', order: 18, tone: 'neutral', description: null },
  TARGET_NOT_FOUND: { label: '押す前に同じボタンが見つからなかった', order: 19, tone: 'caution', description: null },
  PRESS_FAILED: { label: '入力か押す操作が失敗した', order: 20, tone: 'caution', description: null },
  // DEF-144: 安全の違反の後に Guard が画面を閉じたので、押せなかった（画面が移ったのとは別）。
  CONTEXT_CLOSED_BY_GUARD: { label: '安全のために画面を閉じたので押せなかった', order: 21, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 発見のジョブの終わり方（`DISCOVERY_END_REASONS`）の表示。 */
export const DISCOVERY_END_REASON_CATALOG = deepFreeze({
  COMPLETED: { label: '見られる画面をすべて見ました', order: 1, tone: 'positive', description: null },
  MAX_PAGES_REACHED: {
    label: 'ページの上限で止めました',
    order: 2,
    tone: 'caution',
    description: '見た画面の数が、設定で決めたページの数の上限に届いたため、残りの画面は見ていません。',
  },
  MAX_RUNTIME_REACHED: {
    label: '時間の上限で止めました',
    order: 3,
    tone: 'caution',
    description: '作業の時間が、設定で決めた時間の上限に届いたため、残りの画面は見ていません。',
  },
  STOPPED: { label: '止める操作で止めました', order: 4, tone: 'caution', description: '今の画面を見終えてから止まりました。操作さがしは、続きから再開しません。' },
  AUTH_SESSION_LOST: {
    label: 'ログインが切れました',
    order: 5,
    tone: 'caution',
    description: '途中でログインが切れたため、見た画面までを記録しました。もう一度「操作さがしを始める」を押してください。',
  },
  // T37a（Task 37 の設計書 3.1）: 承認したサービスの Origin への要求の上限に届いた。
  SERVICE_REQUEST_LIMIT_REACHED: {
    label: '外のサイトへの送信の上限で止めました',
    order: 6,
    tone: 'caution',
    description: 'ログインのときに通ってよい外のサイトへの、見るだけの送信の数が、ログインの設定の上限に届いたため、残りの画面は見ていません。',
  },
  // DEF-136: サイトの不調（応答しない・接続できない・429・502・503・504）が、1 回の確かめ直しの後も続いた。
  SITE_UNAVAILABLE: {
    label: 'サイトが応答しないため止めました',
    order: 7,
    tone: 'caution',
    description: 'サイトが応答しない状態が、待ってから確かめ直した後も続いたため、残りの画面は見ていません。サイトが戻ってから、もう一度「操作さがしを始める」を押してください。',
  },
  SAFETY_VIOLATION: {
    label: '安全の決まりの違反で止めました',
    order: 8,
    tone: 'critical',
    description: '安全の記録に、決まりの違反がありました。候補の一覧は変えていません。',
  },
  PREFLIGHT_FAILED: {
    label: '始める前の確認で止めました',
    order: 9,
    tone: 'critical',
    description: '始める前の確認が失敗したため、画面を 1 つも見ていません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** READ の確かめの結果（`READ_CHECK_RESULTS`。期待 1 件の結果にも使う）の表示。 */
export const READ_CHECK_RESULT_CATALOG = deepFreeze({
  MATCHED: { label: '一致', order: 1, tone: 'positive', description: '見た結果が、あるはずのものと合いました。' },
  NOT_MATCHED: { label: '不一致', order: 2, tone: 'critical', description: '見た結果が、あるはずのものと合いませんでした。' },
  UNDETERMINED: {
    label: '判定できない',
    order: 3,
    tone: 'caution',
    description: '見られなかったか、結果の形を決められなかったため、あるはずのものと比べられませんでした。',
  },
  READ_BLOCKED_BY_POLICY: {
    label: '見る前に止めた',
    order: 4,
    tone: 'caution',
    description: '送る前の決まり（読まないページ、危ない語、点検してよいサイト、秘密に見える名前、送れない欄）で止めたため、見ていません。',
  },
  READ_CANDIDATE_DRIFTED: {
    label: '画面が変わった',
    order: 5,
    tone: 'caution',
    description: '確かめる候補が、今の画面で見つからないか、どの画面か分からないため、見ていません。',
  },
  READ_CANDIDATE_NOT_READ: {
    label: '見るだけでなくなった',
    order: 6,
    tone: 'caution',
    description: '確かめる候補の今の分類が、見るだけでないため、見ていません。',
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
  TEXT_CONTAINS: { label: '本文にこの文がある', order: 3, tone: 'neutral', description: '結果の画面の主な部分に見えている文字に、指定の文が入っています。' },
  DETAIL_FIELD_EQUALS: {
    label: '詳細の項目の値が同じ',
    order: 4,
    tone: 'neutral',
    description: '結果の画面の詳細の欄（項目の名前と値の組）で、指定の項目の値が、指定の値と同じです。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** READ の確かめのジョブの終わり方（`READ_CHECK_END_REASONS`。確かめなかった定義の理由にも使う）の表示。 */
export const READ_CHECK_END_REASON_CATALOG = deepFreeze({
  COMPLETED: { label: 'すべての確かめを終えました', order: 1, tone: 'positive', description: null },
  MAX_RUNTIME_REACHED: {
    label: '時間の上限で止めました',
    order: 2,
    tone: 'caution',
    description: '作業の時間が、設定で決めた時間の上限に届いたため、残りは確かめていません。',
  },
  STOPPED: { label: '止める操作で止めました', order: 3, tone: 'caution', description: '今の確かめを終えてから止まりました。残りは確かめていません。' },
  AUTH_SESSION_LOST: {
    label: 'ログインが切れました',
    order: 4,
    tone: 'caution',
    description: '途中でログインが切れたため、残りは確かめていません。もう一度「見るだけの確かめを始める」を押してください。',
  },
  // T37a（Task 37 の設計書 3.1）: 承認したサービスの Origin への要求の上限に届いた。
  SERVICE_REQUEST_LIMIT_REACHED: {
    label: '外のサイトへの送信の上限で止めました',
    order: 5,
    tone: 'caution',
    description: 'ログインのときに通ってよい外のサイトへの、見るだけの送信の数が、ログインの設定の上限に届いたため、残りは確かめていません。',
  },
  // DEF-136: サイトの不調（応答しない・接続できない・429・502・503・504）が、1 回の確かめ直しの後も続いた。
  SITE_UNAVAILABLE: {
    label: 'サイトが応答しないため止めました',
    order: 6,
    tone: 'caution',
    description: 'サイトが応答しない状態が、待ってから確かめ直した後も続いたため、その確かめと残りは確かめていません。サイトが戻ってから、もう一度「見るだけの確かめを始める」を押してください。',
  },
  SAFETY_VIOLATION: {
    label: '安全の決まりの違反で止めました',
    order: 7,
    tone: 'critical',
    description: '安全の記録に、決まりの違反がありました。',
  },
  PREFLIGHT_FAILED: {
    label: '始める前の確認で止めました',
    order: 8,
    tone: 'critical',
    description: '始める前の確認が失敗したため、どれも確かめていません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 自動ログインの結果（`src/control/auth/automated-login-results.ts` の `AUTOMATED_LOGIN_RESULTS`）の表示。成功以外の結果の説明と、人がすること
 * （手順）は、ジョブの失敗の理由の文言（`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS`。同じ値）が持つので、ここの説明は成功だけに置く。
 */
export const AUTOMATED_LOGIN_RESULT_CATALOG = deepFreeze({
  SUCCEEDED: { label: '成功', order: 1, tone: 'positive', description: '保存した ID とパスワードで、ログインできました。' },
  INVALID_CREDENTIALS: { label: 'ID かパスワードの誤り', order: 2, tone: 'critical', description: null },
  ACCOUNT_LOCKED: { label: 'アカウントのロック', order: 3, tone: 'critical', description: null },
  MFA_REQUIRED: { label: '人の操作（2 段階の確認など）が必要', order: 4, tone: 'critical', description: null },
  CREDENTIAL_EXPIRED: { label: 'パスワードの期限切れ', order: 5, tone: 'critical', description: null },
  RATE_LIMITED: { label: '回数の制限', order: 6, tone: 'caution', description: null },
  AUTH_RESULT_UNKNOWN: { label: '結果が分からない', order: 7, tone: 'caution', description: null },
  LOGIN_FORM_INVALID: { label: 'フォームの確かめで中止', order: 8, tone: 'caution', description: null },
  LOGIN_FORM_INPUT_FAILED: { label: '入力か送信の失敗', order: 9, tone: 'caution', description: null },
  CREDENTIAL_CHANGED: { label: 'ID かパスワードが変わった', order: 10, tone: 'caution', description: null },
  CREDENTIAL_UNAVAILABLE: { label: '保存した ID とパスワードを取り出せない', order: 11, tone: 'critical', description: null },
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
    description: 'Windows の暗号化の仕組みで、自動ログインの ID とパスワードを保存して使えます。',
  },
  UNAVAILABLE: {
    label: '使えません',
    order: 2,
    tone: 'critical',
    description: 'Windows の暗号化の仕組みを確かめられませんでした。ID とパスワードを保存できず、自動ログインは始められません。公開の画面の点検と、手でログインする点検は使えます。',
  },
  NOT_WINDOWS: {
    label: 'このパソコンでは使えません',
    order: 3,
    tone: 'caution',
    description: 'Windows でないため、ID とパスワードを保存できず、自動ログインは始められません（自動ログインは Windows だけで使えます）。公開の画面の点検と、手でログインする点検は使えます。',
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
  CREATE: { label: '新しく登録', order: 1, tone: 'notice', description: 'テスト用のサイトに、データを新しく登録する書き込みです。' },
  UPDATE: { label: '更新', order: 2, tone: 'notice', description: 'テスト用のサイトの、データを更新する書き込みです。' },
} as const satisfies Record<string, DisplaySpec>);

/**
 * シナリオの表示の状態（`apps/local-ui/src/display/scenarios.ts` の `SCENARIO_DISPLAY_STATES`。保存した状態と、再承認の判定の結果から、画面の
 * サーバが 1 つ選ぶ）の表示。
 */
export const SCENARIO_DISPLAY_STATE_CATALOG = deepFreeze({
  DRAFT: { label: '下書き', order: 1, tone: 'neutral', description: 'まだ書き込みの OK を出していません。内容を確かめてから OK を出します。' },
  APPROVED: { label: 'OK を出した', order: 2, tone: 'positive', description: '今の内容で書き込みの OK を出しています（期限まで）。OK を出しただけでは、書き込みは始まりません。' },
  NEEDS_REAPPROVAL: {
    label: 'OK の出し直しが要る',
    order: 3,
    tone: 'caution',
    description: 'OK を出した後に、OK に関わる内容が変わりました。前の OK は引き継がないので、内容を確かめてから、もう一度 OK を出します。',
  },
  EXPIRED: { label: '期限切れ', order: 4, tone: 'caution', description: '書き込みの OK の期限を過ぎました。使うには、内容を確かめてから、もう一度 OK を出します。' },
  REVOKED: { label: 'OK を取り消した', order: 5, tone: 'neutral', description: '書き込みの OK を取り消しました。使うには、内容を確かめてから、もう一度 OK を出します。' },
} as const satisfies Record<string, DisplaySpec>);

/** 再承認が要る理由（`APPROVAL_INVALIDITY_REASONS`。20 種。T31b で UPDATE の 2 種、T38c で API の 2 種、T38R-fix で API の 3 種を足した）の表示。 */
export const APPROVAL_INVALIDITY_REASON_CATALOG = deepFreeze({
  SCENARIO_REVISION_CHANGED: {
    label: '書き込みの手順を変更した',
    order: 1,
    tone: 'caution',
    description: '書き込みの OK を出した後に、書き込みの手順を変更しました。',
  },
  PROFILE_REVISION_CHANGED: {
    label: 'サイトの設定が変わった',
    order: 2,
    tone: 'caution',
    description: '書き込みの OK を出した後に、サイトの設定を変更しました。どの項目を変更しても、OK は引き継ぎません。',
  },
  AUTH_SETUP_CHANGED: {
    label: 'ログインの設定が変わった',
    order: 3,
    tone: 'caution',
    description: '書き込みの OK を出した後に、ログインの設定が変わりました。自動ログインなら、保存した ID とパスワードを変えたときも当たります。',
  },
  TARGET_CONFIG_CHANGED: {
    label: '設定のファイルが変わった',
    order: 4,
    tone: 'caution',
    description: '書き込みの OK を出した後に、サイトが使う設定のファイルの中身が変わりました。',
  },
  CANDIDATE_CHANGED: {
    label: '見つかった操作が変わった',
    order: 5,
    tone: 'caution',
    description: '前回の「操作さがしを始める」で、対象の操作の欄の決まり（必ず入れる欄・入れられる値・選択肢など）か、操作の分け方が変わりました。',
  },
  CANDIDATE_MISSING: {
    label: '見つかった操作を確かめられない',
    order: 6,
    tone: 'caution',
    description: '前回の「操作さがしを始める」で、対象の操作が見つからなかったか、その画面をもう一度見ていません。',
  },
  CANDIDATE_TEMPLATES_UNAVAILABLE: {
    label: '更新の操作の形を確かめられない',
    order: 8,
    tone: 'caution',
    description: '更新の手順の操作を、どのデータかによらない形で確かめる記録が、まだありません。今は更新の手順に OK を出せません。',
  },
  // T38c: API のシナリオ（候補の要求の型）。
  CANDIDATE_SHAPE_CHANGED: {
    label: '送信の形が変わった',
    order: 9,
    tone: 'caution',
    description: '前回の「操作さがしを始める」で、対象のボタンを押したときにページが送る送信の形（送り先、中身の項目の名前など）が、OK を出した形と違いました。',
  },
  CANDIDATE_SHAPES_UNAVAILABLE: {
    label: '送信の形を確かめられない',
    order: 10,
    tone: 'caution',
    description: '対象の操作の送信の形の記録が、BeakSight の管理データにまだありません。「操作さがしを始める」をもう一度行ってください。',
  },
  // T38R-fix: 鍵と欄の対応（I-1）、Origin と最新の発見の改訂（C-2）。
  CANDIDATE_FIELDS_CHANGED: {
    label: '中身の項目と欄の対応が変わった',
    order: 11,
    tone: 'caution',
    description: '前回の「操作さがしを始める」で、送信の形は同じでも、中身の項目に値を入れる欄（欄の名前か部品の目印）が、OK を出した対応と違いました。',
  },
  API_ORIGIN_NOT_APPROVED: {
    label: '送り先が、通ってよい外のサイトにない',
    order: 12,
    tone: 'critical',
    description: '書き込みの手順の、画面を通さない送信の送り先のサイトのアドレスが、今のサイトの設定の「ログインのときに通ってよい外のサイトのアドレス」の一覧の、同じ位置にありません。',
  },
  API_DISCOVERY_PROFILE_STALE: {
    label: '操作さがしがサイトの設定の変更より前',
    order: 13,
    tone: 'caution',
    description: '前回の「操作さがしを始める」は、サイトの設定を変更する前の内容で行いました。もう一度「操作さがしを始める」を行ってください。',
  },
  INPUT_RULES_CHANGED: { label: '入れる値の決まりが変わった', order: 14, tone: 'caution', description: 'どの入れる値の決まりを使うか（決まりの集まり・変更の回数・中身）が変わりました。' },
  READ_CHECK_CHANGED: {
    label: '照らし合わせる見るだけの確かめが変わった',
    order: 15,
    tone: 'caution',
    description: '結果を照らし合わせる見るだけの確かめが、変わったか、削除されたか、見つかりません。',
  },
  EXPIRED: { label: '期限切れ', order: 16, tone: 'caution', description: '書き込みの OK の期限を過ぎました（ちょうど期限の時刻も含みます）。' },
  REVOKED: { label: 'OK を取り消した', order: 17, tone: 'neutral', description: '前回の書き込みの OK を取り消しました。' },
  NOT_APPROVED: { label: 'まだ OK を出していない', order: 18, tone: 'neutral', description: 'まだ書き込みの OK を出していません。' },
  PROFILE_RETIRED: { label: 'サイトを取り消した', order: 19, tone: 'critical', description: '取り消したサイトの書き込みの手順には、OK を出せません。' },
  MODE_NOT_WRITE: {
    label: '書き込みも試す点検でない',
    order: 20,
    tone: 'critical',
    description: 'サイトの点検のしかたが、「書き込みも試す点検」ではありません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 副作用の確認の項目（`SIDE_EFFECT_CONFIRMATIONS`。承認の前に人がすべて確かめる 4 項目）の表示。PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 4）:
 * 説明は、確かめたことの過去形でなく、約束の中身を現在形で書く（押す前に確かめるのは承認のダイアログの文 `sideEffectsNote`）。
 */
export const SIDE_EFFECT_CONFIRMATION_CATALOG = deepFreeze({
  TEST_RECORDS_ONLY: {
    label: '登録・更新されるのは、テスト用のサイトのデータだけです',
    order: 1,
    tone: 'neutral',
    description: '書き込むのはテスト用のサイトだけです。本物や、ほかの人と共有のデータは変わりません。',
  },
  NO_EXTERNAL_NOTIFICATION: {
    label: 'メールや電話への知らせが送られない設定です',
    order: 2,
    tone: 'neutral',
    description: '登録や更新をしても、だれかにメールや電話への知らせが届く設定ではありません。',
  },
  NO_PAYMENT_OR_EXTERNAL_SERVICE: {
    label: '決済や外部のサービスに及びません',
    order: 3,
    tone: 'neutral',
    description: 'お金の支払いや、在庫・ほかのサービスには影響しません。',
  },
  NOT_DESTRUCTIVE: {
    label: '削除・無効化・取り消しに当たりません',
    order: 4,
    tone: 'neutral',
    description: 'データを消したり、使えなくしたり、取り消したりする操作ではありません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 承認の digest の項目（`APPROVAL_DIGEST_ITEMS`。最後の承認との差分の項目名）の表示。 */
export const APPROVAL_DIGEST_ITEM_CATALOG = deepFreeze({
  profileId: { label: 'サイト', order: 1, tone: 'neutral', description: 'この書き込みの手順を使うサイトの名前です。' },
  scenarioId: { label: '書き込みの手順', order: 2, tone: 'neutral', description: '書き込みの手順を見分ける ID です。' },
  scenarioRevision: { label: '書き込みの手順の変更の回数', order: 3, tone: 'neutral', description: '書き込みの手順を変更すると、変更の回数が 1 つ進みます。' },
  profileRevision: { label: 'サイトの設定の変更の回数', order: 4, tone: 'neutral', description: 'サイトの設定を変更すると、変更の回数が 1 つ進みます。' },
  authSetupDigest: { label: 'ログインの設定', order: 5, tone: 'neutral', description: 'ログインの設定の中身です（自動ログインなら、保存した ID とパスワードの変更の回数も含みます）。' },
  targetConfigDigest: { label: '設定のファイル', order: 6, tone: 'neutral', description: 'サイトが使う設定のファイルの中身です。' },
  kind: { label: '種類', order: 7, tone: 'neutral', description: '新しく登録か、更新かです。' },
  candidateIdentityDigest: { label: '対象の操作', order: 8, tone: 'neutral', description: '対象の操作を見分ける中身です。' },
  candidateRuleDigest: { label: '操作の欄の決まり', order: 9, tone: 'neutral', description: '対象の操作の欄の決まり（必ず入れる欄・入れられる値・選択肢など）の中身です。' },
  request: { label: '送信の形', order: 10, tone: 'neutral', description: '送り方（フォームの送る通信の種類と、その上書き）、送信先のサイトのアドレスとアドレスの後ろ、送る中身の形式です。' },
  fieldNames: { label: '送る欄', order: 11, tone: 'neutral', description: '値を送る欄の名前の一覧です（値は持ちません）。' },
  sideEffectConfirmations: {
    label: 'ほかへの影響の確認',
    order: 12,
    tone: 'neutral',
    description: 'ほかへの影響の 4 つの約束を、それぞれ確かめたかどうかです（約束の順に並べた true か false）。',
  },
  limits: { label: '上限', order: 13, tone: 'neutral', description: '1 回の点検で送る件数の上限と、合計の件数の上限です。' },
  approvalTtlDays: { label: '書き込みの OK の期限の日数', order: 14, tone: 'neutral', description: 'OK を出してから期限までの日数です。' },
  inputRuleReference: {
    label: '使う入れる値の決まり',
    order: 15,
    tone: 'neutral',
    description: '送る値の作り方として、どの入れる値の決まりを使うか（決まりの集まり・変更の回数・中身）です。決めていなければ null です。',
  },
  readChecks: { label: '照らし合わせる見るだけの確かめ', order: 16, tone: 'neutral', description: '結果を照らし合わせる見るだけの確かめ（ID と変更の回数）です。' },
  // T30a（Task 30 の設計書 3 章の「検証の指定」）: 検証の指定の項目。PL-6a: 成功の条件と入力の誤りの条件を、結果の確かめ方の 1 項目に置き換えた。
  verificationResultJudgement: {
    label: '結果の確かめ方',
    order: 17,
    tone: 'neutral',
    description: 'BeakSight が書き込みの結果を確かめる方法です（フォームの書き込みは、答え合わせと、送った後の画面の形で確かめます）。',
  },
  verificationRecordId: {
    label: '登録の ID の取り方',
    order: 18,
    tone: 'neutral',
    description: '送った後のページのアドレスの形（例 /items/{id}）か、成功の画面の部品の目印です。決めていなければ null です。',
  },
  verificationRead: {
    label: '答え合わせの見るだけの確かめ',
    order: 19,
    tone: 'neutral',
    description: '登録した内容を見直す見るだけの確かめ（ID と変更の回数）、作った値に結び付ける送る値、あるはずのものです。決めていなければ null です。',
  },
  // T31b: UPDATE の指定（文言の確かめは T31h）。
  updateTargetCreateScenarioId: {
    label: '作ったデータの一覧の参照',
    order: 20,
    tone: 'neutral',
    description: '更新するデータを登録した、新しく登録する手順です。更新の指定がなければ null です。',
  },
  updateFormPathTemplate: {
    label: '更新の画面のアドレスの形',
    order: 21,
    tone: 'neutral',
    description: 'データの ID の位置を {id} にした、更新の画面のアドレスの後ろです。更新の指定がなければ null です。',
  },
  updateActionPathTemplate: {
    label: '送信先のアドレスの形',
    order: 22,
    tone: 'neutral',
    description: 'データの ID の位置を {id} にした、送信先のアドレスの後ろです。更新の指定がなければ null です。',
  },
  updateKeepFieldNames: {
    label: '値を変えない欄',
    order: 23,
    tone: 'neutral',
    description: '更新しても値を変えない欄の名前です。更新の指定がなければ null です。',
  },
  updateTemplatedIdentityDigest: {
    label: 'ID を除いた対象の操作',
    order: 24,
    tone: 'neutral',
    description: 'データの ID の位置を {id} にして、対象の操作を見分ける中身です。更新の指定がなければ null です。',
  },
  // T38c: 送り方と API の指定（FORM のシナリオは送り方が FORM で、ほかは null）。
  transport: { label: '送り方', order: 25, tone: 'neutral', description: 'フォームの送信か、ページの中のプログラムが送る、画面を通さない送信かです。' },
  apiShapeDigest: {
    label: '見つけた送信の形',
    order: 26,
    tone: 'neutral',
    description: '操作さがしで、対象のボタンを押したときにページが送ろうとした送信の形の中身です。画面を通さない送信の手順でなければ null です。',
  },
  apiRequest: {
    label: '画面を通さない送信の形',
    order: 27,
    tone: 'neutral',
    description: '送る通信の種類、送り先のサイトのアドレス、アドレスの形、アドレスの ? の後ろの名前、送る中身の形式、返事の返し方の指定です（値は持ちません）。画面を通さない送信の手順でなければ null です。',
  },
  apiKeyFields: {
    label: '中身の項目と欄',
    order: 28,
    tone: 'neutral',
    description: '送る中身の項目ごとの、値の形（文字・数など）と、値を入れる欄（欄の名前か部品の目印）です。画面を通さない送信の手順でなければ null です。',
  },
  apiPageKeys: {
    label: 'ページが決める項目',
    order: 29,
    tone: 'neutral',
    description: '欄に対応せず、ページが値を決める中身の項目の名前と、値の形です（値は照らし合わせません）。画面を通さない送信の手順でなければ null です。',
  },
  apiHeaderNames: {
    label: '送信に付けてよい情報の名前',
    order: 30,
    tone: 'neutral',
    description: 'ページが送信に付ける、追加の情報の名前です（ブラウザが付けるものは除きます）。画面を通さない送信の手順でなければ null です。',
  },
  apiFilterName: {
    label: '更新するデータを選ぶ名前',
    order: 31,
    tone: 'neutral',
    description: '更新する行を選ぶ、アドレスの ? の後ろの名前です（列の名前は確かめていません）。新しく登録する手順と、画面を通さない送信でない手順は null です。',
  },
  apiRecordId: {
    label: '画面を通さない送信の、登録の ID の取り方',
    order: 32,
    tone: 'neutral',
    description: '登録の ID を読む、サイトの返事の中身の項目です。決めていなければ null です。',
  },
  apiLedger: {
    label: '画面を通さない送信の、作ったデータの一覧の参照',
    order: 33,
    tone: 'neutral',
    description: '更新するデータを登録した新しく登録する手順と、更新の画面のアドレスの形と、その形にした画面を見分ける中身です。画面を通さない送信で更新する手順でなければ null です。',
  },
  // T41a: API の UPDATE の保つ鍵。
  apiKeptKeys: {
    label: '値を変えない項目',
    order: 34,
    tone: 'neutral',
    description: '更新で値を変えない中身の項目ごとの、値の形と、値を読む欄（欄の名前か部品の目印）です（値は持ちません）。画面を通さない送信で更新する手順でなければ null です。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 承認の記録の種類（`APPROVAL_RECEIPT_KINDS`）の表示。 */
export const APPROVAL_RECEIPT_KIND_CATALOG = deepFreeze({
  APPROVAL: { label: '書き込みの OK', order: 1, tone: 'positive', description: null },
  REVOCATION: { label: 'OK の取り消し', order: 2, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 撤回の理由（`REVOCATION_REASONS`）の表示。 */
export const REVOCATION_REASON_CATALOG = deepFreeze({
  OPERATOR_REQUEST: { label: '画面から取り消しました', order: 1, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 書き込み（Task 30 の設計書 2 章のユーザーの判断 2、3 章の「結果の判定」「予約の締め」「`UNKNOWN` の後」「検証の指定」。T30g）。値の一覧は
// `src/control/actions/action-contracts.ts` と `src/control/approval-view.ts` のもの。書き漏れは `apps/local-ui/src/display/catalog-coverage.ts` が
// 型で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** 書き込みの結果（`ACTION_RESULTS`）の表示。`UNKNOWN` は、テスト環境で登録の有無を確かめるよう促す（ユーザーの判断 2）。 */
export const ACTION_RESULT_CATALOG = deepFreeze({
  VERIFIED: {
    label: '答え合わせが合った',
    order: 1,
    tone: 'positive',
    description: '登録の成功の画面を確かめ、登録の ID を取り、見るだけの確かめで登録した内容を見直して、答え合わせが合いました。',
  },
  PARTIAL: {
    label: '答え合わせができていない',
    order: 2,
    tone: 'caution',
    description: '成功の画面にはなりましたが、登録の ID か、見るだけの確かめでの答え合わせで、確かめられていません。登録できたとは言い切れません。',
  },
  UNKNOWN: {
    label: '結果が分からない',
    order: 3,
    tone: 'critical',
    description: '送ったか、登録されたかが分かりません。テスト用のサイトで、登録されたかどうかを必ず確かめてください。件数は使ったものとして数えます。',
  },
  FAILED: {
    label: '登録されなかった',
    order: 4,
    tone: 'caution',
    description: 'サイトが「入力の誤り」か「送信が多すぎる」と返しました。登録されなかったと判定しました。件数は使ったものとして数えます。',
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
  PAYLOAD_MISMATCH: { label: '送る中身が OK を出した形と違う', order: 1, tone: 'caution', description: '送る直前の答え合わせで、送る中身が OK を出した形と違いました。' },
  PRECHECK_FAILED: { label: '送る前の確かめで止めた', order: 2, tone: 'caution', description: '画面・書き込みの OK・フォームの確かめで止めました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 送信の後の画面の判定（`RESPONSE_JUDGEMENTS`）の表示。 */
export const RESPONSE_JUDGEMENT_CATALOG = deepFreeze({
  // PL-6a: フォームの書き込みは、人が入れた条件でなく、答え合わせと送った後の画面の形で判定する（やさしい言葉で）。
  SUCCESS: { label: '書き込めた（答え合わせが合った、またはサイトが受け付けた）', order: 1, tone: 'positive', description: null },
  INPUT_ERROR: { label: 'サイトが入力の誤りを返した', order: 2, tone: 'caution', description: null },
  RATE_LIMITED: { label: '送信が多すぎると返された', order: 3, tone: 'caution', description: null },
  SERVER_ERROR: { label: 'サイトの側の誤り', order: 4, tone: 'critical', description: null },
  NO_CONDITION_MATCHED: { label: '書き込めたか判定できない', order: 5, tone: 'critical', description: null },
  MULTIPLE_CONDITIONS_MATCHED: { label: '結果が 2 通りに読める（判定できない）', order: 6, tone: 'critical', description: null },
  SESSION_LOST: { label: 'ログインが切れた', order: 7, tone: 'critical', description: null },
  REPOST_REDIRECT: { label: '同じ中身をもう一度送らせる転送を止めた', order: 8, tone: 'critical', description: null },
  RESPONSE_NOT_DELIVERED: { label: 'サイトの返事をページに返せなかった', order: 9, tone: 'critical', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 書き込みの結果を決めた理由（`ACTION_OUTCOME_REASONS`）の表示。 */
export const ACTION_OUTCOME_REASON_CATALOG = deepFreeze({
  PAYLOAD_MISMATCH: { label: '送る中身が OK を出した形と違う', order: 1, tone: 'caution', description: null },
  PRECHECK_FAILED: { label: '送る前の確かめで止めた', order: 2, tone: 'caution', description: null },
  NO_RESPONSE: { label: '返事がない（送ったか分からない）', order: 3, tone: 'critical', description: null },
  INPUT_ERROR: { label: '入力の誤り', order: 4, tone: 'caution', description: null },
  RATE_LIMITED: { label: '送信が多すぎると返された', order: 5, tone: 'caution', description: null },
  SERVER_ERROR: { label: 'サイトの側の誤り', order: 6, tone: 'critical', description: null },
  NO_CONDITION_MATCHED: { label: '書き込めたか判定できない', order: 7, tone: 'critical', description: null },
  MULTIPLE_CONDITIONS_MATCHED: { label: '結果が 2 通りに読める（判定できない）', order: 8, tone: 'critical', description: null },
  SESSION_LOST: { label: 'ログインが切れた', order: 9, tone: 'critical', description: null },
  REPOST_REDIRECT: { label: '同じ中身をもう一度送らせる転送を止めた', order: 10, tone: 'critical', description: null },
  RESPONSE_NOT_DELIVERED: { label: 'サイトの返事をページに返せなかった', order: 11, tone: 'critical', description: null },
  RECORD_ID_NOT_FOUND: { label: '登録の ID が取れない', order: 12, tone: 'caution', description: null },
  RECORD_ID_UNSAFE: { label: '登録の ID の形が安全でない', order: 13, tone: 'caution', description: null },
  READ_VERIFICATION_MATCHED: { label: '答え合わせが合った', order: 14, tone: 'positive', description: null },
  READ_VERIFICATION_NOT_MATCHED: { label: '答え合わせが合わない', order: 15, tone: 'critical', description: null },
  READ_VERIFICATION_UNDETERMINED: { label: '答え合わせを判定できない', order: 16, tone: 'caution', description: null },
  // T31e fix round 1（Task 31 の設計書 3 章）: UPDATE の結果の理由（文言の確かめは T31h）。
  RECORD_ID_MISMATCH: { label: '取れた ID が更新の対象と違う', order: 17, tone: 'critical', description: null },
  UNEXPECTED_FIELD_CHANGE: { label: '更新の後に、指定していない変化がある', order: 18, tone: 'critical', description: null },
  // T31f: UPDATE の更新の後の照合を判定できない（文言の確かめは T31h）。
  UPDATE_POSTCHECK_UNDETERMINED: { label: '更新の後の答え合わせを判定できない', order: 19, tone: 'caution', description: null },
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
  RESULT_JUDGEMENT: {
    label: '結果の判定',
    order: 4,
    tone: 'neutral',
    description: '送信の後のサイトの返事と画面を、BeakSight が確かめて判定しました（答え合わせと、同じ入力の画面が入れた値のまま出たかで決めます）。',
  },
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
  VALID: { label: '確かめ済み', order: 1, tone: 'positive', description: '報告のファイルが、結果と、始めた時の書き込みの OK と、まとめファイルの目録に合うことを確かめました。' },
  REPORT_MISSING: {
    label: '報告のファイルがない',
    order: 2,
    tone: 'caution',
    description: '報告のファイルの一部がありません。書き込みの結果は、この画面の結果の欄で確かめてください。',
  },
  REPORT_INVALID: { label: '報告の形が違う', order: 3, tone: 'critical', description: '報告のファイルが、決まった形に合いません。' },
  REPORT_MISMATCH: { label: '報告が作業と合わない', order: 4, tone: 'critical', description: '報告の作業・点検の回・書き込みの手順・結果が、この作業の結果と違います。' },
  APPROVAL_FACTS_MISMATCH: {
    label: '書き込みの OK の要約が始めた時と違う',
    order: 5,
    tone: 'critical',
    description: '報告の書き込みの OK の要約が、書き込みを始めた時に確かめた OK の中身と違います。',
  },
  BUNDLE_MISMATCH: {
    label: 'まとめファイルが報告と合わない',
    order: 6,
    tone: 'critical',
    description: '報告の 4 つのファイルから組み立て直したまとめファイルと、ZIP が 1 バイトでも違います（開けない ZIP も含みます）。',
  },
  RESULT_INVALID: { label: '結果のファイルが使えない', order: 7, tone: 'critical', description: '書き込みの結果のファイルが使えないため、報告を確かめられません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 検証の指定の項目（`SCENARIO_VERIFICATION_ITEMS`）の表示。 */
export const SCENARIO_VERIFICATION_ITEM_CATALOG = deepFreeze({
  // PL-6a: 成功の条件と入力の誤りの条件を、結果の確かめ方に置き換えた（人は入れない。BeakSight が付ける）。
  resultJudgement: {
    label: '結果の確かめ方',
    order: 1,
    tone: 'neutral',
    description: 'BeakSight が、答え合わせと、送った後の画面の形（同じ入力の画面が、入れた値のまま出たか）で書き込みの結果を確かめます。入れる必要はありません。',
  },
  recordId: { label: '登録の ID の取り方', order: 2, tone: 'neutral', description: '送った後のページのアドレスの形（例 /items/{id}）か、成功の画面の部品の目印です。' },
  readVerification: {
    label: '答え合わせの見るだけの確かめ',
    order: 3,
    tone: 'neutral',
    description: '作った値で、登録した内容を見直す見るだけの確かめと、そこにあるはずのものです。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** 登録の ID の取り方（`RECORD_ID_SOURCES`）の表示。 */
export const RECORD_ID_SOURCE_CATALOG = deepFreeze({
  URL_PATH_PATTERN: { label: '成功の後のページのアドレスの形', order: 1, tone: 'neutral', description: '{id} をちょうど 1 つ、アドレスの後ろの / と / の間の 1 区切り全体に書きます（例 /items/{id}）。' },
  ELEMENT: { label: '成功の画面の部品の目印', order: 2, tone: 'neutral', description: 'ID を文字で出している部品の目印（CSS セレクタ）です。' },
  // PL-6a: フォームの書き込みの取り方（送った後のアドレスの形を 2 つまで。空白で区切ります）。
  URL_PATH_PATTERNS: {
    label: '送った後のページのアドレスの形',
    order: 3,
    tone: 'neutral',
    description: '{id} をちょうど 1 つ、アドレスの後ろの / と / の間の 1 区切り全体に書きます（例 /items/{id}）。2 つまで、空白で区切って書けます（例 /items/{id} /items/{id}/edit）。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」の状態（`apps/local-ui/src/server/write-chain-policy.ts` の `WRITE_CHAIN_STATES`）の表示。値の一覧と
 * 意味は画面のサーバが持ち、ここは表示だけを持つ。書き漏れは画面の単体のテスト（`write-chain-policy.test.ts`）と `catalog-coverage.ts` が確かめる。
 */
export const WRITE_CHAIN_STATE_CATALOG = deepFreeze({
  CREATING: { label: '登録中（終わったら続けて更新します）', order: 1, tone: 'notice', description: null },
  // T41g-3: 自動ログインの最小の間隔を待っている（次に始められる時刻に、1 回だけ更新を始め直す）。
  WAITING_LOGIN_INTERVAL: {
    label: '自動ログインの間隔を待っています（待った後に続けて更新します）',
    order: 2,
    tone: 'notice',
    description: '自動ログインどうしの最小の間隔があるため、登録のすぐ後には更新を始められません。次に始められる時刻まで待ってから、1 回だけ更新を始めます。',
  },
  UPDATE_STARTED: { label: '続けて更新を始めました', order: 3, tone: 'positive', description: null },
  NOT_STARTED: { label: '更新は始めませんでした', order: 4, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** T41g: 「登録してから更新する」で更新を始めなかった理由（`WRITE_CHAIN_STOP_REASONS`）の表示。 */
export const WRITE_CHAIN_STOP_REASON_CATALOG = deepFreeze({
  CREATE_NOT_VERIFIED: {
    label: '登録の答え合わせが合いませんでした',
    order: 1,
    tone: 'caution',
    description: '登録の作業の結果が「答え合わせが合った」でないので、そのデータは更新しません。登録の結果を確かめてください。',
  },
  CREATE_RECORD_ID_MISSING: {
    label: '登録の ID が記録にありません',
    order: 2,
    tone: 'caution',
    description: '登録は答え合わせが合いましたが、登録の ID が記録にないので、更新する対象を決められません。',
  },
  PLANNED_TARGET_MISMATCH: {
    label: '更新の予定の対象が、登録したデータと違います',
    order: 3,
    tone: 'caution',
    description: '更新の予定の対象（作ったデータの一覧で、答え合わせが合った登録の最新の 1 件）が、今登録したデータではありません。開始の画面で予定の対象を確かめてください。',
  },
  UPDATE_START_REJECTED: {
    label: '更新を始められませんでした',
    order: 4,
    tone: 'caution',
    description: '更新の書き込みの OK を使う準備か、作業の開始で断られました。更新の書き込みの手順の開始の画面で理由を確かめてください。',
  },
  CREATE_WAIT_TIMEOUT: {
    label: '登録の作業が待つ時間の中で終わりませんでした',
    order: 5,
    tone: 'caution',
    description: '登録の作業の終わりを待つ上限の時間を過ぎたので、更新は始めません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * FM2d・FM2R の Minor 3: まとめて実行の状態（`src/control/job/stage-chain-policy.ts` の `CHAIN_STATES`）の表示（書き込みの連鎖と同じ形）。書き漏れは
 * `apps/local-ui/src/display/catalog-coverage.ts` が確かめる。
 */
export const STAGE_CHAIN_STATE_CATALOG = deepFreeze({
  RUNNING: { label: '行っている', order: 1, tone: 'notice', description: null },
  FINISHED: { label: '最後まで行った', order: 2, tone: 'positive', description: null },
  STOPPED: { label: '途中で止めた', order: 3, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** FM2d・FM2R の Minor 3: まとめて実行の段の状態（`CHAIN_STAGE_STATES`）の表示。`STOPPED` は、連鎖がその段で止まった印（FM2R の I-5）。 */
export const STAGE_CHAIN_STAGE_STATE_CATALOG = deepFreeze({
  PENDING: { label: 'これから行う', order: 1, tone: 'neutral', description: null },
  RUNNING: { label: '行っている', order: 2, tone: 'notice', description: null },
  DONE: { label: '終えた', order: 3, tone: 'positive', description: null },
  STOPPED: { label: 'このステップで止まった', order: 4, tone: 'caution', description: null },
  NOT_STARTED: { label: '始めなかった', order: 5, tone: 'caution', description: null },
  NOT_NEEDED: { label: '行わなかった（見るだけの確かめがない）', order: 6, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** FM2d・FM2R の Minor 3: まとめて実行を止めた理由（`CHAIN_STOP_REASONS`）の表示。次にできることの文は `LOCAL_UI_STAGE_CHAIN_TEXT.stopReasons`。 */
export const STAGE_CHAIN_STOP_REASON_CATALOG = deepFreeze({
  USER_STOPPED: { label: '「やめる」で止めた', order: 1, tone: 'caution', description: null },
  SAFETY_VIOLATION: { label: '安全の違反があった', order: 2, tone: 'critical', description: null },
  SESSION_LOST: { label: 'ログインが切れた', order: 3, tone: 'caution', description: null },
  SITE_UNAVAILABLE: { label: 'サイトが応答しなかった', order: 4, tone: 'caution', description: null },
  SERVICE_REQUEST_LIMIT_REACHED: { label: 'ログインのときに通ってよい外のサイトへの通信の上限に届いた', order: 5, tone: 'caution', description: null },
  STAGE_FAILED: { label: 'ステップが失敗した', order: 6, tone: 'critical', description: null },
  PROFILE_REVISION_CHANGED: { label: '途中でサイトの設定が変わった', order: 7, tone: 'caution', description: null },
  NEXT_STAGE_REJECTED: { label: '次のステップを始められなかった', order: 8, tone: 'caution', description: null },
  // OP-2: 書き込みの段の結果が分からない（残りの登録・更新を止めた）。
  WRITE_RESULT_UNKNOWN: { label: '登録・更新の結果が分からなかった', order: 9, tone: 'caution', description: null },
  // OP-F: チェックした画面のうち、試せなかった画面があった（送っていない）。
  WRITE_NOT_TRIED: { label: 'チェックした画面のうち、試せなかった画面があった', order: 10, tone: 'caution', description: null },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 書き込みの送り方（`src/control/approval/scenario-contracts.ts` の `SCENARIO_TRANSPORTS`。T40d。Task 40 の設計書 3.5）の表示。書き込みの報告・結果・
 * 履歴・開始の画面が使う。書き漏れは `apps/local-ui/src/display/catalog-coverage.ts` と `tests/unit/action-report-changeability.test.ts` が確かめる。
 */
export const SCENARIO_TRANSPORT_CATALOG = deepFreeze({
  FORM: { label: 'フォームの送信', order: 1, tone: 'neutral', description: '画面のフォームを送信して書き込みます。結果は、確かめ方で決めた条件で判定します。' },
  API: {
    label: '画面を通さない送信',
    order: 2,
    tone: 'neutral',
    description: 'ページの中のプログラムが、画面を通さずに送る送信で書き込みます。結果は、サイトの返事の状態と登録の ID で判定します。',
  },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 入力の規則（Task 29 の設計書 3 章の「補完の画面」、4.1、4.4。T29e）。値の一覧は `src/control/data-rules-view.ts` から公開し直したもの。書き漏れは
// `apps/local-ui/src/display/catalog-coverage.ts` が型で確かめる（`src/presentation/` は `src/control/` を import しない）。
// ---------------------------------------------------------------------------------------------------------------

/** 欄の意味の種類（`SEMANTIC_KINDS`）の表示。 */
export const SEMANTIC_KIND_CATALOG = deepFreeze({
  GENERIC_NUMBER: { label: '数（欄の種類と範囲から）', order: 1, tone: 'neutral', description: null },
  GENERIC_DATETIME: { label: '日時（欄の種類と範囲から）', order: 2, tone: 'neutral', description: null },
  GENERIC_CHOICE: { label: '選択肢（欄の選択肢から）', order: 3, tone: 'neutral', description: null },
  GENERIC_COLOR: { label: '色（欄の種類から）', order: 4, tone: 'neutral', description: null },
  FAMILY_NAME: { label: '姓（漢字）', order: 5, tone: 'neutral', description: null },
  GIVEN_NAME: { label: '名（漢字）', order: 6, tone: 'neutral', description: null },
  FULL_NAME: { label: '氏名（姓と名）', order: 7, tone: 'neutral', description: null },
  FAMILY_NAME_KANA: { label: '姓のフリガナ', order: 8, tone: 'neutral', description: null },
  GIVEN_NAME_KANA: { label: '名のフリガナ', order: 9, tone: 'neutral', description: null },
  FULL_NAME_KANA: { label: '氏名のフリガナ', order: 10, tone: 'neutral', description: null },
  EMAIL: { label: 'メールアドレス（合成。届かない宛先）', order: 11, tone: 'notice', description: '決まりで届かないことになっている example.invalid の宛先だけを作ります。' },
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
  // FM2c（手動の操作を減らす設計書 3A.3）: 番号・コード。
  DIGIT_CODE: {
    label: '番号・コード（数字の桁）',
    order: 24,
    tone: 'neutral',
    description: '欄の入力の形の指定が、決まった桁数の数字だけ（例 ^\\d{7}$）のとき、その桁数の数字を作ります。',
  },
  // OP-2: 作り物の文字（テンプレートの外のふつうの文字の欄）。
  GENERIC_TEXT: { label: '文字（作り物）', order: 25, tone: 'neutral', description: '「sample」と数字の、作り物の文字を作ります。' },
} as const satisfies Record<string, DisplaySpec>);

/** 保存した規則の出どころの印（`RULE_ORIGINS`。FM2c）の表示。 */
export const RULE_ORIGIN_CATALOG = deepFreeze({
  HUMAN: { label: '人が決めた', order: 1, tone: 'neutral', description: null },
  INFERRED: {
    label: '推し量った決まり（人は確かめていない）',
    order: 2,
    tone: 'caution',
    description: '業務テンプレートか、ふつうの決まりで推し量った決まりを、そのまま保存しました。中身を確かめてください。',
  },
} as const satisfies Record<string, DisplaySpec>);

/**
 * 自動で作る下書きの案の出どころ（`src/control/approval/draft-value-origin.ts` の `DRAFT_VALUE_ORIGINS`。FM2a・FM2b）の表示（名前・順・色の区分の
 * 1 か所）。推測は注意の色。根拠の文は `messages.ts` の `DRAFT_VALUE_TEXT.grounds`。印は表示だけで、承認に結ばない。
 */
export const DRAFT_VALUE_ORIGIN_CATALOG = deepFreeze({
  DETERMINED: { label: '操作さがしの記録から決まる', order: 1, tone: 'neutral', description: null },
  INFERRED: { label: '推測（確かめてください）', order: 2, tone: 'caution', description: '自動の下書きが推した値です。正しいかを確かめてください。' },
  HUMAN: { label: '人が決める', order: 3, tone: 'neutral', description: null },
} as const satisfies Record<string, DisplaySpec>);

/** 値の作り方（`GENERATION_METHODS`）の表示。 */
export const GENERATION_METHOD_CATALOG = deepFreeze({
  FROM_TYPE: { label: '欄の種類と、入れられる値の範囲から', order: 1, tone: 'neutral', description: null },
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
  // FM2c fix round 1: 保存した推した規則も、判定の出どころは `HUMAN`。推したか人が決めたかは、出どころの印（`RULE_ORIGIN_CATALOG`）で出す。
  HUMAN: {
    label: '保存した決まり',
    order: 1,
    tone: 'notice',
    description: '決まりの集まりに保存した決まりです（いちばん優先します）。推し量ったか人が決めたかは、出どころの印で示します。',
  },
  TEMPLATE: { label: '業務テンプレート', order: 2, tone: 'neutral', description: '欄の名前・種類・自動入力の指定から推し量った決まりです。' },
  GENERIC: { label: 'ふつうの決まり', order: 3, tone: 'neutral', description: '欄の種類と、入れられる値の範囲から作る決まりです。' },
  OPT_OUT: { label: '送らない側に固定', order: 4, tone: 'shield', description: '通知・配信を求める欄なので、送らない側に固定しました。' },
} as const satisfies Record<string, DisplaySpec>);

/** 欄ごとの判定の状態（`FIELD_RULE_STATUSES`）の表示。 */
export const FIELD_RULE_STATUS_CATALOG = deepFreeze({
  DECIDED: { label: '決まった', order: 1, tone: 'positive', description: null },
  NEEDS_RULE_INPUT: { label: '決まりを選ぶ必要がある', order: 2, tone: 'caution', description: '推し量らずに止めました。この欄の入れる値の決まりを選んでください。' },
  RULE_CONFLICT: { label: '決まりがぶつかる', order: 3, tone: 'critical', description: '欄の入れられる値の範囲や、欄どうしの関係と、決まりが合いません。' },
  EXTERNAL_DELIVERY_BLOCKED: {
    label: '外に届く欄なので止めた',
    order: 4,
    tone: 'shield',
    // MI-F4（MI-6 の後の流れ）: 副作用の確認は、承認のダイアログの 1 回の押下で入る。
    description: 'メール・電話の欄の値は、書き込みの OK を出す確認の画面で、約束「メールや電話への知らせが送られない設定です」を確かめて OK を出すまで作りません。',
  },
} as const satisfies Record<string, DisplaySpec>);

/** シナリオの入力の規則の状態（`apps/local-ui/src/display/data-rules.ts` の `INPUT_RULE_STATES`）の表示。 */
export const INPUT_RULE_STATE_CATALOG = deepFreeze({
  NOT_SET: { label: 'まだ決めていない', order: 1, tone: 'caution', description: '入れる値の決まりを作るまで、書き込みの OK は出せません。' },
  DECIDED: { label: 'すべて決まった', order: 2, tone: 'positive', description: '送る欄すべてに、値の作り方が決まっています。' },
  INSUFFICIENT: { label: '決まらない欄がある', order: 3, tone: 'caution', description: '値の作り方が決まらない欄があります。書き込みの OK は出せません。' },
} as const satisfies Record<string, DisplaySpec>);

/** 外部到達の種類（`EXTERNAL_DELIVERY_KINDS`）の表示。 */
export const EXTERNAL_DELIVERY_KIND_CATALOG = deepFreeze({
  EMAIL: { label: 'メールの欄', order: 1, tone: 'shield', description: null },
  PHONE: { label: '電話の欄', order: 2, tone: 'shield', description: null },
  NOTIFICATION: { label: '通知・配信の欄', order: 3, tone: 'shield', description: null },
  ADDRESS: { label: '住所の欄', order: 4, tone: 'shield', description: null },
} as const satisfies Record<string, DisplaySpec>);

// ---------------------------------------------------------------------------------------------------------------
// 監査の段の送信の扱い（AS-b。設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1・2.3）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 監査の段の送信の扱い（`AUDIT_SEND_POLICIES`）の表示。`prominent` は、報告（HTML・CLI・ChatGPT 用バンドル）とジョブの画面で、通したことの知らせを目立つ
 * 形で出すか（`PASS_EXCEPT_DELETE` だけ）。出すかどうかを決めるのは、表示用モデル（`summary.auditSend.prominent`）と画面が、この値を読む 1 か所だけ。
 */
export const AUDIT_SEND_POLICY_CATALOG = deepFreeze({
  READ_ONLY: {
    label: '読み取りだけ',
    order: 1,
    tone: 'positive',
    description: 'ページが出す書き込みの送信は、すべて止めました（GET と HEAD だけ）。',
    prominent: false,
  },
  PASS_EXCEPT_DELETE: {
    label: '削除のほかを通す',
    order: 2,
    tone: 'caution',
    description: 'ページが出す書き込みの送信のうち、削除と危険な語の送信のほかを、サイトに届けました。',
    prominent: true,
  },
} as const satisfies Record<AuditSendPolicyName, DisplaySpec & { readonly prominent: boolean }>);

// ---------------------------------------------------------------------------------------------------------------
// BeakSight の遮断と指摘の関係（BN-c・BN-d。設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3・3.5）
// ---------------------------------------------------------------------------------------------------------------

/** BeakSight の遮断と指摘の関係の区分の表示。 */
export interface BeakSightBlockRelationSpec extends DisplaySpec {
  /** HTML レポートの Finding の行に、区分の印を出すか（結び付かない指摘には出さない）。 */
  readonly badgeInFindingRow: boolean;
}

/**
 * BeakSight の遮断と指摘の関係の区分（`BEAKSIGHT_BLOCK_RELATIONS`）の表示（ラベル・色・順・説明）。HTML レポートの印と件数、CLI の要約の行、ChatGPT 用バンドルの
 * 読み方の案内が、ここから取る。
 */
export const BEAKSIGHT_BLOCK_RELATION_CATALOG = deepFreeze({
  CAUSED: {
    label: '遮断が原因',
    order: 1,
    tone: 'shield',
    description: 'BeakSight の遮断が、この指摘を決めました（指摘の対象の要求か、行き先の移動か、測った画面そのもの（止めた移動の後のエラーの画面）を、BeakSight が止めました）。サイトの欠陥ではありません。',
    badgeInFindingRow: true,
  },
  POSSIBLE: {
    label: '遮断の影響の可能性',
    order: 2,
    tone: 'caution',
    description: '同じ読み込みで、この指摘の結果を変えうる種類の要求を BeakSight が止めたか、BeakSight が無効にした機能をページが呼びました。サイトの欠陥とは言い切れません。',
    badgeInFindingRow: true,
  },
  NONE: {
    label: '遮断と結び付かない',
    order: 3,
    tone: 'neutral',
    description: 'BeakSight が止めた要求と結び付かない指摘です（サイトの欠陥の候補）。',
    badgeInFindingRow: false,
  },
} as const satisfies Record<BeakSightBlockRelation, BeakSightBlockRelationSpec>);

/**
 * BN-R0 の M-3: Guard が止めた事象の時点（`BLOCKED_EVENT_PHASES`）の表示。HTML レポートの SAFETY の Finding の行に、閉じる途中の遮断の印を出す（`badgeInFindingRow`）。
 */
export const BLOCKED_EVENT_PHASE_CATALOG = deepFreeze({
  LOAD: {
    label: '読み込みの間に止めた',
    order: 1,
    tone: 'neutral',
    description: '読み込みの間（閉じ始める前。測りの後も含む）に止めた要求です。',
    badgeInFindingRow: false,
  },
  CLOSING: {
    label: '閉じる途中に止めた',
    order: 2,
    tone: 'notice',
    description: '閉じる途中とページを離れた後に止めた要求です（測りの後のもの）。',
    badgeInFindingRow: true,
  },
} as const satisfies Record<BlockedEventPhase, DisplaySpec & { readonly badgeInFindingRow: boolean }>);

// ---------------------------------------------------------------------------------------------------------------
// 画面の通信の名前（PL-W。設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 2・4、5 章）。画面は HTTP の言葉（GET・POST）と
// 要求の種類（document・xhr など）を生で出さず、この日本語の名前を出す。値の意味（どれを見るだけとみなすかなど）は持たない（表示の名前だけ）。
// ---------------------------------------------------------------------------------------------------------------

/**
 * HTTP の送り方の名前ごとの、画面の名前（大文字の名前を鍵にする）。ここにない名前は、画面の側が `HTTP_METHOD_OTHER_LABEL` を出す。
 * 送り方の判定（読み取りの送り方かどうか）は `src/safety/request-policy.ts` が持ち、ここは名前の言い換えだけ。
 */
export const HTTP_METHOD_LABELS = deepFreeze({
  GET: '見るだけの通信',
  HEAD: '見るだけの通信（中身なし）',
  POST: '送る通信',
  PUT: '送る通信（置き換え）',
  PATCH: '送る通信（一部の更新）',
  DELETE: '消す通信',
  OPTIONS: '送る前の問い合わせ',
} as const satisfies Record<string, string>);

/** `HTTP_METHOD_LABELS` にない送り方の、画面の名前。 */
export const HTTP_METHOD_OTHER_LABEL = 'そのほかの通信';

/**
 * 要求の種類（`src/control/worker-protocol.ts` の `WORKER_REQUEST_RESOURCE_TYPES`）の、画面の名前。書き漏れと余分は、画面の側
 * （`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。鍵は引用符で書く（`fetch` などの名前を、外へ送る処理の参照と見分けるため。
 * `tests/architecture/write-stage-boundary.test.ts` の (e)）。
 */
export const REQUEST_RESOURCE_TYPE_LABELS = deepFreeze({
  'document': 'ページ',
  'stylesheet': '見た目の指定',
  'image': '画像',
  'media': '音声・動画',
  'font': '文字の形',
  'script': 'ページの中のプログラム',
  'texttrack': '字幕',
  'xhr': 'ページの中からの通信',
  'fetch': 'ページの中からの通信',
  'prefetch': '先読み',
  'eventsource': '知らせを受け取り続ける通信',
  'websocket': 'つないだままやりとりする接続',
  'manifest': 'アプリとしての情報',
  'signedexchange': '署名つきのページ',
  'ping': '知らせの送信',
  'cspviolationreport': '安全の決まりの報告',
  'preflight': '送る前の問い合わせ',
  'fedcm': 'ほかのサービスでのログインの連携',
  'other': 'そのほか',
} as const satisfies Record<string, string>);

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
