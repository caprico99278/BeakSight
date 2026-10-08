/**
 * 利用者向けの文言の唯一の owner（UI追補設計書 第4章、Task 14〜17 の設計書 6.1.5）。
 * - 理由のコード（`IncompleteReasonCode`、`InteractionReasonCode`）から、日本語の説明への変換を持つ。Interaction の lifecycle の
 *   理由のコード（`InteractionLifecycleReasonCode`）は表示しないので、説明を持たない（RC18 の M8）。
 * - 理由の `detail`（Interaction では `reasonDetail`）は、英数字の技術的な詳細として、表示面がエスケープしてそのまま示す
 *   （ここでは訳さない）。
 * - Finding の `message` は Rule が持つ。ここで作り直したり、言い換えたりしない。
 * - CLI と設定のエラーの文言は、Task 17 でここに加える。
 * - このファイルが import してよいのは、`src/core/**` と `src/config/types.ts` だけ（UI追補設計書 4.1）。
 */
import type { IncompleteReasonCode } from '../core/contracts.js';
import type { InteractionReasonCode } from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';

/** 観測できなかった値の表示（上位の設計書 14.11）。0 や空文字、「良好」などで代えない。 */
export const NOT_OBSERVED_TEXT = '未観測';

/** 書式（`src/presentation/format.ts`）が付ける、日本語の単位。 */
export const FORMAT_UNIT_TEXT = deepFreeze({
  /** 秒（例: `1.5秒`、経過時間の `24分10秒`）。 */
  seconds: '秒',
  /** 件数（例: `3件`）。 */
  count: '件',
  /** 回数（例: `284回`。ページの読み込みの回数。サイトへの負荷の制御の設計書 4.5、4.8）。 */
  times: '回',
  /** 経過時間の時間（例: `1時間5分`。設計書 4.8）。 */
  hours: '時間',
  /** 経過時間の分（例: `24分10秒`。設計書 4.8）。 */
  minutes: '分',
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 文言の中の一覧の書式（Rule の Finding の文言と CLI の共通。C17a、CC-016）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 項目を、一覧の区切り（`、`）で1つの文字列に並べる（例: `エラー 3件、警告 2件`、`desktop: 404、mobile: 500`）。
 * 一覧の区切りは、このファイルの外に書かない（UI Gate で確かめる）。
 */
export const listText = (items: readonly string[]): string => items.join('、');

/**
 * 項目を `maxListed` 件まで並べ、超えた分は、残りの件数を添える（例: `u1、u2、u3、u4、u5、ほか 2 件`）。項目は並べ替え済みであること。
 * 入力は変えない。
 */
export const truncatedListText = (items: readonly string[], maxListed: number): string => {
  const rest = items.length - maxListed;
  return rest > 0 ? listText([...items.slice(0, maxListed), `ほか ${rest} 件`]) : listText(items);
};

/** 未完了の理由のコードごとの、日本語の説明。 */
export const INCOMPLETE_REASON_DESCRIPTIONS = deepFreeze({
  DEADLINE_EXCEEDED: 'Evidence の収集が、期限までに終わりませんでした。',
  EVALUATION_FAILED: 'ページの中で Evidence を集める処理が、失敗しました。',
  PAGE_CLOSED: 'Evidence の収集の途中で、ページが閉じられました。',
  NAVIGATION_FAILED: 'ページを開けませんでした。',
  DOM_READINESS_FAILED: 'ページの DOM の準備ができるのを、待てませんでした。',
  SCROLL_TARGET_UNRESOLVED: 'ページの内容がビューポートより大きいのに、スクロールする要素を特定できませんでした。',
  SCROLL_NOT_ADVANCED: 'スクロールを求めても、スクロールの位置が進みませんでした。',
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED: 'スクロールできる量が最も大きいのは内側の領域で、その領域はたどっていません。',
  INNER_SCROLL_SCAN_LIMIT_REACHED: '内側のスクロール領域を探す処理が上限に達し、領域がないことを確かめられませんでした。',
  SCROLL_TARGET_UNSTABLE: 'スクロールの対象を切り替えてたどり直した後も、対象が定まりませんでした。',
  POSITION_NOT_AT_ORIGIN: 'スクロールの後に、ページの先頭へ戻せませんでした。',
  LAYOUT_COMPARISON_LIMIT_REACHED: 'レイアウトの重なりの確認が、比べる組の数の上限に達して止まりました。',
  RESOURCE_LIMIT_REACHED: 'リソースの読み込みの記録が、件数の上限に達しました。',
  INVALID_BROWSER_DATA: 'ブラウザから返った値が、不正でした。',
  PREFLIGHT_FAILED: '実行の前の確認に、失敗しました。',
  RUN_DIRECTORY_UNAVAILABLE: '監査の結果を置く Run のディレクトリを、作れませんでした。',
  SAFETY_INVARIANT_VIOLATION: '安全の不変条件の違反を、記録しました。',
  SAFETY_LEDGER_TRUNCATED: '安全の記録が上限に達し、一部を記録できませんでした。',
  UNHANDLED_FAILURE: '想定していない失敗が、起きました。',
  MAX_PAGES_REACHED: 'ページ数の上限に達しました。',
  MAX_DEPTH_REACHED: 'リンクの深さの上限に達しました。',
  MAX_RUNTIME_REACHED: '実行時間の上限に達しました。',
  REQUIRED_ARTIFACT_INVALID: '必須の出力ファイルが、スキーマに合いませんでした。',
  EXECUTION_INCOMPLETE: '実行が、最後まで終わりませんでした。',
  REQUIRED_WORK_SKIPPED: '必要な確認の一部を、行いませんでした。',
  REQUIRED_WORK_BLOCKED: '必要な確認の一部を、安全のために止めました。',
  REQUIRED_WORK_TIMED_OUT: '必要な確認の一部が、時間切れになりました。',
  REQUIRED_WORK_NOT_OBSERVED: '必要な確認の一部で、結果を観測できませんでした。',
  REQUIRED_WORK_NOT_VERIFIED: '必要な確認の一部で、結果を確かめられませんでした。',
  REQUIRED_WORK_FAILED: '必要な確認の一部が、失敗しました。',
  COLLECTOR_INCOMPLETE: 'Evidence の収集の一部が、完了しませんでした。',
  RULE_EVALUATION_FAILED: 'Rule の評価が、失敗しました。',
  PAGE_CRASHED: 'ページを描画するプロセスが、停止しました。',
  SAFETY_VIOLATION_ABORT: '安全の不変条件の違反を検出したため、それより後の監査を始めませんでした。',
  CHECKPOINT_WRITE_FAILED: '再開のための途中の保存を書けなかったため、それより後の監査を始めませんでした。',
  RUN_INTERRUPTED: '止める指示（Ctrl+C など）を受けたため、それより後の監査を始めませんでした。',
  SITE_UNAVAILABLE: 'サイトが応答しないため、それより後の監査を始めませんでした。',
} as const satisfies Record<IncompleteReasonCode, string>);

/** 未完了の理由のコードの、日本語の説明。 */
export const describeIncompleteReason = (code: IncompleteReasonCode): string => INCOMPLETE_REASON_DESCRIPTIONS[code];

/**
 * Interaction の理由のコードごとの、日本語の説明（Task 19 の前の整理の設計書 5.1.2 の「表示」。C18o）。
 * コードの一覧と、status ごとの対応は、`src/core/evidence-types.ts` の `INTERACTION_REASON_CODES`、`INTERACTION_REASON_CODES_BY_STATUS`。
 * 技術的な詳細（completeness や identityStatus の値、エラーの文言）は Evidence の `reasonDetail` にあるので、説明には書かない。
 * 「確認の期限」は、1つの操作の候補を確かめる期限。「安全のために通信を止める」は、クリックの前の Safety の凍結。
 */
export const INTERACTION_REASON_DESCRIPTIONS = deepFreeze({
  // VERIFIED
  OBSERVABLE_STATE_CHANGED: 'クリックの後に、ページの状態が変わることを観測しました。',
  // REJECTED_UNSAFE（`classifyInteractionCandidate` の除外の理由）
  SUBMISSION_CONTROL: '送信のボタンなので、操作しませんでした。',
  RESET_CONTROL: 'フォームを初期の状態に戻すボタンなので、操作しませんでした。',
  FORM_ASSOCIATED: 'フォームに属する要素なので、操作しませんでした。',
  NAVIGATION_HREF: 'ほかのページへ移動するリンクなので、操作しませんでした。',
  EXTERNAL_ACTION: '外部の Origin や、電話・メールなどの特殊な scheme へ作用する要素なので、操作しませんでした。',
  DOWNLOAD: 'ダウンロードを始める要素なので、操作しませんでした。',
  DISABLED: '無効になっている要素なので、操作しませんでした。',
  NOT_VISIBLE: '画面に表示されていない要素なので、操作しませんでした。',
  MALFORMED_CANDIDATE: '候補の記録が不正で、安全かを判断できないので、操作しませんでした。',
  // BLOCKED_BY_SAFETY
  // `SAFETY_FREEZE_BLOCKED`: 凍結の後の、通信・移動・ポップアップ・ダウンロード・WebSocket の遮断と、外部スキームへの移動の試み
  // （`isolated-auditor.ts` の `hasFreezeEvent`）。ページのスクリプトによる外部スキームへの移動は止められないので、そのことを隠さない
  // （Task 19 の前の整理の設計書 4.2、4.2.1。RC18 の M1）。
  SAFETY_FREEZE_BLOCKED:
    '安全のために通信を止めた後で、ページが、通信、ほかのページへの移動、ポップアップ、ダウンロード、外部のアプリ（電話やメールなど）を開く移動のどれかを試みました。外部のアプリを開く移動のほかは、遮断しました。外部のアプリを開く移動は、止められなかったおそれがあります。',
  // `OWNER_CLOSE_SAFETY_FAILURE`: 閉じる処理の失敗、期限切れ、閉じた後に Guard が終わりの状態にならない、のどれか（どれも Ledger に
  // 違反を記録する）。その後に、環境が閉じた場合だけ、このコードになる（閉じなければ `InteractionOwnerCleanupError`）。
  OWNER_CLOSE_SAFETY_FAILURE:
    '操作用のブラウザの環境を閉じる処理で、失敗、期限切れ、閉じた後も安全の確認の仕組みが終わりの状態にならない、のどれかが起きました。この異常は、安全の不変条件の違反として記録しました。環境は、その後に閉じました。',
  // NOT_VERIFIABLE: 操作用のブラウザの環境と、ページの読み込み
  SESSION_OPEN_DEADLINE: '操作用のブラウザの環境を開く途中で、確認の期限を過ぎました。',
  INITIAL_LOAD_BEFORE_LOAD: 'ページの読み込みを始める前に、確認の期限を過ぎました。',
  INITIAL_LOAD_DURING_LOAD: 'ページの読み込みの途中で、確認の期限を過ぎました。',
  INITIAL_LOAD_AFTER_LOAD: 'ページの読み込みを終えた後に、確認の期限を過ぎました。',
  INITIAL_LOAD_BEFORE_RENDER: 'ページの最初の描画が終わる前に、確認の期限を過ぎました。',
  // NOT_VERIFIABLE: 通信を止める前の下準備（スクロール、マウスを重ねる、フォーカス）
  SCROLL_PREPARATION_DEADLINE: 'スクロールの下準備の途中で、確認の期限を過ぎました。',
  SCROLL_PREPARATION_DOM_WORK_EXHAUSTED: 'スクロールの下準備の途中で、DOM を調べる作業量の上限に達しました。',
  SCROLL_PREPARATION_FAILED: 'スクロールの下準備が、失敗しました。',
  SCROLL_PREPARATION_SETTLE_DEADLINE: 'スクロールの後にページが落ち着くのを待つ間に、確認の期限を過ぎました。',
  HOVER_PREPARATION_DEADLINE: 'マウスを重ねる下準備の途中で、確認の期限を過ぎました。',
  HOVER_PREPARATION_FAILED: 'マウスを重ねる下準備が、失敗しました。',
  FOCUS_PREPARATION_DEADLINE: 'フォーカスの下準備の途中で、確認の期限を過ぎました。',
  FOCUS_PREPARATION_FAILED: 'フォーカスの下準備が、失敗しました。',
  FOCUS_PREPARATION_DOM_WORK_EXHAUSTED: 'フォーカスの下準備の途中で、DOM を調べる作業量の上限に達しました。',
  FOCUS_PREPARATION_TARGET_DISCONNECTED: 'フォーカスの下準備の途中で、対象の要素がページから外れました。',
  FOCUS_PREPARATION_CANDIDATE_LIMIT_REACHED: 'フォーカスの下準備で要素を調べる処理が、候補の数の上限に達しました。',
  FOCUS_PREPARATION_TEXT_NODE_LIMIT_REACHED: 'フォーカスの下準備で要素を調べる処理が、テキストノードの数の上限に達しました。',
  FOCUS_PREPARATION_STATE_CHANGED: 'フォーカスを当てただけで対象の状態が変わるので、クリックによる変化と見分けられません。',
  FOCUS_PREPARATION_STATE_UNCOMPARABLE: 'フォーカスを当てる前と後で、対象の状態を比べられませんでした。',
  // NOT_VERIFIABLE: 通信を止める前の、ページが安定しているかの確認
  STABILITY_CHECK_DEADLINE: 'ページが安定しているかを確かめる途中で、確認の期限を過ぎました。',
  STABILITY_CHECK_DOM_WORK_EXHAUSTED: 'ページが安定しているかを確かめる途中で、DOM を調べる作業量の上限に達しました。',
  STABILITY_CHECK_TARGET_DISCONNECTED: 'ページが安定しているかを確かめる途中で、対象の要素がページから外れました。',
  STABILITY_CHECK_CANDIDATE_LIMIT_REACHED: 'ページが安定しているかを確かめる処理が、候補の数の上限に達しました。',
  STABILITY_CHECK_TEXT_NODE_LIMIT_REACHED: 'ページが安定しているかを確かめる処理が、テキストノードの数の上限に達しました。',
  // NOT_VERIFIABLE: 通信を止めた後の、対象の探し直し、対象の要素の確認、クリック
  DEADLINE_AFTER_SAFETY_FREEZE: '安全のために通信を止めた直後に、確認の期限を過ぎました。',
  DEADLINE_DURING_CANDIDATE_REDISCOVERY: '対象の要素を探し直す途中で、確認の期限を過ぎました。',
  DOM_WORK_EXHAUSTED: '1つの操作の確認の全体で、DOM を調べる作業量の上限に達しました。',
  CANDIDATE_REDISCOVERY_INCOMPLETE: '対象の要素を探し直す処理が、最後まで終わりませんでした。',
  CANDIDATE_IDENTITY_NOT_REDISCOVERED: '探し直しても、対象の要素が見つかりませんでした。',
  CANDIDATE_IDENTITY_AMBIGUOUS: '探し直すと、対象の要素と区別できない要素が複数ありました。',
  DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION: '対象の要素への参照を取る前に、確認の期限を過ぎました。',
  DEADLINE_DURING_TARGET_HANDLE_ACQUISITION: '対象の要素への参照を取る途中で、確認の期限を過ぎました。',
  TARGET_HANDLE_NOT_RESOLVED: '対象の要素への参照を、取れませんでした。',
  TARGET_HANDLE_RESOLUTION_DOM_WORK_EXHAUSTED: '対象の要素への参照を取る途中で、DOM を調べる作業量の上限に達しました。',
  DEADLINE_DURING_TARGET_FACT_COLLECTION: 'クリックの前に対象の要素を調べる途中で、確認の期限を過ぎました。',
  TARGET_INSPECTION_DOM_WORK_EXHAUSTED: 'クリックの前に対象の要素を調べる途中で、DOM を調べる作業量の上限に達しました。',
  TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED: 'クリックの前に対象の要素を調べる処理が、候補の数の上限に達しました。',
  TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED: 'クリックの前に対象の要素を調べる処理が、テキストノードの数の上限に達しました。',
  TARGET_DISCONNECTED_BEFORE_ADMISSION: '操作してよいかを判定する前に、対象の要素がページから外れました。',
  TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION: 'クリックする要素を1つに定める途中で、対象の要素が変わりました。',
  DEADLINE_DURING_EXACT_NODE_ADMISSION: 'クリックする要素を操作してよいかを判定する途中で、確認の期限を過ぎました。',
  TARGET_NOT_SCROLL_PREPARED: '安全のために通信を止める前に、対象の要素を画面の中に入れられませんでした。',
  DEADLINE_BEFORE_EXACT_NODE_CLICK: 'クリックする直前に、確認の期限を過ぎました。',
  CLICK_TIMED_OUT: 'クリックが、期限までに終わりませんでした。',
  // NOT_VERIFIABLE: クリックの後の観測
  DEADLINE_BEFORE_POST_CONDITION_OBSERVATION: 'クリックの後の状態を観測する前に、確認の期限を過ぎました。',
  DEADLINE_DURING_POST_CONDITION_OBSERVATION: 'クリックの後の状態を観測する途中で、確認の期限を過ぎました。',
  PERSISTENCE_CHECK_DEADLINE: 'クリックの後の変化が続くかを確かめる途中で、確認の期限を過ぎました。',
  NO_OBSERVABLE_CHANGE: '確認の期限までに、クリックによる状態の変化を観測しませんでした。',
  GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED: '対象を含む領域がスクロールした間に、対象の位置や大きさだけが変わりました。',
  GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE: '対象の位置や大きさだけが変わり、対象を含む領域のスクロールの位置は比べられませんでした。',
  GEOMETRY_ONLY_CHANGED: '対象の位置や大きさだけが変わったので、操作の結果とはみなしませんでした。',
  RETAINED_INSPECTION_DOM_WORK_EXHAUSTED: 'クリックの後に対象の要素を調べる途中で、DOM を調べる作業量の上限に達しました。',
  RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED: 'クリックの後に対象の要素を調べる処理が、候補の数の上限に達しました。',
  RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED: 'クリックの後に対象の要素を調べる処理が、テキストノードの数の上限に達しました。',
  RETAINED_IDENTITY_LOST: 'クリックの後に、対象の要素が同じ要素であることを確かめられなくなりました。',
  // EXECUTION_FAILED
  EXECUTION_FAILED: '操作を確かめる処理が、途中でエラーになりました。',
  CLICK_FAILED: 'クリックが、期限切れ以外の理由で失敗しました。',
} as const satisfies Record<InteractionReasonCode, string>);

/** Interaction の理由のコードの、日本語の説明。 */
export const describeInteractionReason = (code: InteractionReasonCode): string => INTERACTION_REASON_DESCRIPTIONS[code];

/** HTML の部品（`src/report/html-components.ts`）が示す、日本語の文言。 */
export const REPORT_COMPONENT_TEXT = deepFreeze({
  /** Finding の表の列の見出し（`renderFindingRow` のセルの順）。 */
  findingColumns: ['重大度', 'カテゴリ', '内容', 'ページ', 'ビューポート', 'Rule', 'Evidence', 'スクリーンショット'],
  /** 該当するものがない。 */
  none: 'なし',
  /** ページによらない Finding（例: ページ間の Finding）のページの欄。 */
  pageIndependent: 'ページによらない',
  /** ビューポートによらない Finding のビューポートの欄。 */
  viewportIndependent: 'ビューポートによらない',
  /** Finding の行のページの欄の、ページの一覧（文書の中のアンカー）へのリンク（U16c）。 */
  pageDetailLink: 'ページの一覧で見る',
} as const);

/** Finding の行の、Rule の版（例: `版 2`）（U16c）。 */
export const ruleVersionText = (version: number): string => `版 ${version}`;

/** スクリーンショットへのリンクの文言（例: `デスクトップ・表示範囲`）。ラベルは、表示カタログのもの。 */
export const screenshotLinkText = (viewportLabel: string, captureTypeLabel: string): string =>
  `${viewportLabel}・${captureTypeLabel}`;

// ---------------------------------------------------------------------------------------------------------------
// Run の要約（HTML レポートと CLI。C17a）
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run の要約の文言（C17a）。HTML レポートの要約の節と、CLI の結果の行（`validate-config` と `run` の開始の行を含む）の、両方で使う。
 * HTML レポートだけで使う要約の文言は、`HTML_REPORT_TEXT.summary` に置く。CLI だけで使う文言は、`CLI_TEXT` に置く。
 */
export const RUN_SUMMARY_TEXT = deepFreeze({
  runStatus: 'Run の状態',
  target: '対象',
  startUrl: '開始の URL',
  coverageHeading: 'ページの網羅',
  coverage: {
    discovered: '発見したページ',
    audited: '監査したページ',
    partial: '一部未完了のページ',
    failed: '失敗したページ',
    skipped: 'スキップしたページ',
  },
  reasonsHeading: '未完了の理由',
  /** サイトへの負荷の記録（`RunSummary.load`。サイトへの負荷の制御の設計書 3.1 の7、4.5）の、HTML の小節の見出しと CLI の行の名前。 */
  loadHeading: 'サイトへの負荷',
  /** 許可 Origin への要求（`load.requests.allowedOrigins`）。HTML の小節の項目と、CLI の負荷の行の項目。 */
  allowedOriginRequests: '許可 Origin への要求',
} as const);

/** 1分あたりの最大（`RunLoadOriginRequests.peakPerMinute`）の短い名前。 */
const PEAK_PER_MINUTE_LABEL = '1分あたり最大';

/** 直近の1分の件数（`RunLoadRecentPerMinute`。サイトへの負荷の制御の設計書 4.8）の短い名前。 */
const RECENT_MINUTE_LABEL = '直近1分';

/**
 * 件数に、補足の項目を括弧で添える（例: `12件（発見したページ 85件、上限 50件）`）。項目は、一覧の区切り（`listText`）で並べる。
 */
export const countWithDetailsText = (countText: string, details: readonly string[]): string => `${countText}（${listText(details)}）`;

/**
 * 要求の件数に、1分あたりの最大を添える（例: `3,400件（1分あたり最大 210件）`。サイトへの負荷の制御の設計書 4.5）。
 * 件数と最大の書式は、`formatCount` のもの。組み立ては、`src/presentation/format.ts` の `formatRequestsWithPeak` だけが行う（L7）。
 */
export const countWithPeakPerMinuteText = (countText: string, peakText: string): string =>
  countWithDetailsText(countText, [`${PEAK_PER_MINUTE_LABEL} ${peakText}`]);

/**
 * 要求の件数に、直近の1分の件数と、1分あたりの最大を添える（例: `1,930件（直近1分 38件、1分あたり最大 61件）`。設計書 4.8）。
 * 実行中の進み具合の行で使う。組み立ては、`formatRequestsWithPeak` だけが行う。
 */
export const countWithRecentAndPeakPerMinuteText = (countText: string, recentText: string, peakText: string): string =>
  countWithDetailsText(countText, [`${RECENT_MINUTE_LABEL} ${recentText}`, `${PEAK_PER_MINUTE_LABEL} ${peakText}`]);

// ---------------------------------------------------------------------------------------------------------------
// HTML レポート（`src/report/html-report.ts`。U16c）
// ---------------------------------------------------------------------------------------------------------------

/** 開始の日時の項目の名前（Run の開始の日時と、実行の記録の表の列の見出し。R6）。 */
const STARTED_AT_LABEL = '開始の日時';

/** 終了の日時の項目の名前（Run の終了の日時と、実行の記録の表の列の見出し。R6）。 */
const FINISHED_AT_LABEL = '終了の日時';

/**
 * HTML レポートが示す、日本語の文言。節の名前と説明は、表示カタログ（`REPORT_SECTION_CATALOG`、`REPORT_CATEGORY_SECTION_CATALOG`）が
 * 持つ。ここには、節の中の小見出し、項目の名前、表の列の見出し、補足の文を置く。
 */
export const HTML_REPORT_TEXT = deepFreeze({
  /** 文書の題（`<title>` と `<h1>`）。 */
  title: 'BeakSight 監査レポート',
  /** 指摘のない節の文。 */
  noFindings: '該当する指摘はありません。',
  /** 節の中の、指摘の件数の項目。 */
  findingCount: '指摘の件数',
  /** 未完了の理由の表の列の見出し。 */
  reasonColumns: ['コード', '説明', '詳細'],
  /** 要約の節の、HTML レポートだけで使う文言（CLI と共通の文言は `RUN_SUMMARY_TEXT`）。 */
  summary: {
    runHeading: 'Run',
    runId: 'Run の ID',
    allowedOrigins: '許可 Origin',
    startedAt: STARTED_AT_LABEL,
    finishedAt: FINISHED_AT_LABEL,
    toolVersion: 'BeakSight の版',
    countsHeading: '指摘の件数',
    countsNote: 'サイト品質（エラー、警告、情報）と安全は、分けて数えます。',
    countColumns: ['区分', '重大度', '件数'],
    totalFindings: '指摘の合計',
    safetyInvariantViolations: '安全の不変条件の違反',
    limitsHeading: '上限',
    limitColumns: ['上限', '設定', '到達'],
    limits: {
      maxPages: 'ページ数',
      maxDepth: 'リンクの深さ',
      maxRuntime: '実行時間',
    },
    reached: '達した',
    notReached: '達していない',
    unverifiedInteractions: '確かめられなかった Interaction',
    unverifiedInternalLinks: '確かめられなかった内部リンク',
    /** 「サイトへの負荷」の小節（見出しは `RUN_SUMMARY_TEXT.loadHeading`）の説明。 */
    loadNote: 'BeakSight が監査対象のサイトに送った要求の実績です。ページの読み込みは、最小の間隔以上空けて行いました。',
    /**
     * 「サイトへの負荷」の小節の項目（`RunSummary.load` の順。許可 Origin への要求は、CLI と共通の `RUN_SUMMARY_TEXT.allowedOriginRequests`）。
     * ページの読み込みの回数は、間隔の判定に使った読み込みの開始の回数で、始められなかった読み込みを含む（多めに数える側。設計書 4.5）。
     */
    load: {
      minNavigationInterval: 'ページの読み込みの最小の間隔',
      maxInteractionsPerPage: '1ページで監査する Interaction の候補の上限',
      navigationCount: 'ページの読み込みの回数（始められなかったものを含む）',
      pacingWait: '間隔のために待った時間の合計',
      otherOriginRequests: '許可 Origin の外への要求',
      servedFromCache: 'Run 全体のキャッシュから返した要求',
      withheldOtherOrigins: '送らなかった、許可 Origin の外への要求',
    },
    /** 「実行の記録」の小節（`RunSummary.executions`。中断した Run の再開の設計書 4.8 の「表示」。R6）の見出し。 */
    executionsHeading: '実行の記録',
    /** 「実行の記録」の小節の説明。 */
    executionsNote:
      'BeakSight を起動した回ごとの、開始と終了の日時と、終わり方です。中断した Run を、同じコマンドで続きから監査した起動を、再開として数えます。',
    /** 「実行の記録」の小節の項目（実行の回数と、再開の回数）。 */
    executions: {
      count: '実行の回数',
      resumeCount: '再開の回数',
    },
    /**
     * 実行の一覧の表の列の見出し（何回目、開始の日時、終了の日時、終わり方）。終わり方の欄は、表示カタログのラベル、コード、説明を示す。
     * 開始と終了の日時の列は、Run の開始と終了の日時と同じ名前にする。
     */
    executionColumns: ['何回目の実行', STARTED_AT_LABEL, FINISHED_AT_LABEL, '終わり方'],
    environmentHeading: '実行の環境',
    environment: {
      nodeVersion: 'Node.js',
      platform: 'OS',
      osRelease: 'OS の版',
      arch: 'CPU のアーキテクチャ',
      playwrightVersion: 'Playwright',
      chromiumVersion: 'Chromium',
    },
  },
  interactions: {
    countsHeading: '状態ごとの件数',
    notVerifiableHeading: '確認できなかった区分ごとの件数',
    listHeading: '候補ごとの結果',
    /** 候補ごとの結果の表の列の見出し。理由の欄は、コード、日本語の説明、詳細を示す（C18o）。 */
    columns: ['ページ', 'ビューポート', '対象', '状態', '確認できなかった区分', '理由', 'Evidence'],
    noInteractions: '操作の候補の記録はありません。',
  },
  safety: {
    guard: '安全の確認',
    guardEnabled: '有効',
    guardDisabled: '無効',
    blockedActionsHeading: '遮断した操作',
    blockedActions: {
      requests: 'リクエスト',
      navigations: 'ナビゲーション',
      externalActions: '外部への作用',
      popups: 'ポップアップ',
      downloads: 'ダウンロード',
      webSockets: 'WebSocket',
    },
    excludedInteractionCandidates: '安全のため除外した Interaction の候補',
    invariantViolationCount: '安全の不変条件の違反',
    record: '安全の記録',
    recordComplete: 'すべて記録した',
    recordTruncated: '上限に達し、一部を記録できなかった',
    lowerBoundNote: '安全の記録が上限に達したため、遮断した操作の件数は下限です。実際の件数は、これより多いことがあります。',
    methodsCaption: 'メソッドごとの、遮断したリクエスト',
    methodColumns: ['メソッド', '件数'],
    violationsCaption: '安全の不変条件の違反',
    violationColumns: ['コード', '内容（技術的な詳細）'],
    /** 事象の一覧の小見出し（C16d。設計書 6.1.10）。遮断した事象と、記録だけの事象（外部スキームへの移動の試み。C18a）の両方を含む。 */
    eventsHeading: 'Safety の事象の一覧',
    /** 事象の一覧の説明。 */
    eventsNote: 'ページの安全の記録（Evidence）にある事象を、ページ、Evidence、種類の順に並べたものです。',
    /** 安全の記録が上限に達したときの、事象の一覧の注意。 */
    eventsTruncatedNote: '安全の記録が上限に達したため、この一覧には、記録できなかった事象が含まれていません。',
    /** 事象の表の列の見出し（「候補」は Interaction の候補の ID。C16e）。 */
    eventColumns: ['種類', 'ページ', 'ビューポート', 'メソッド', 'URL', '候補', '理由', 'Evidence'],
  },
  pages: {
    url: 'URL',
    status: '状態',
    pageJson: 'page.json',
    visibleText: '可視テキスト',
    reasons: '未完了の理由',
    viewportsHeading: 'ビューポートごとの状態',
    viewportColumns: ['ビューポート', '状態', '要求した URL', '最終の URL', 'HTTP ステータス', 'ナビゲーションの結果', '未完了の理由'],
    screenshotsHeading: 'スクリーンショット',
    findingsHeading: 'このページの指摘',
    retriesHeading: '再試行の前の記録',
    retriesNote: '最終の試行の前に行った試行の記録です。指摘の件数と、指摘の参照には含めません。',
    retryColumns: ['試行', 'ナビゲーションの結果', '詳細', 'Evidence', 'スクリーンショット'],
    noPages: 'ページの記録はありません。',
  },
} as const);

/** サイト品質や安全の区分ごとの合計の項目（例: `サイト品質の合計`）。ラベルは、表示カタログのもの。 */
export const severityGroupTotalText = (groupLabel: string): string => `${groupLabel}の合計`;

/** User-Agent の項目（例: `User-Agent（デスクトップ）`）。ラベルは、表示カタログのもの。 */
export const userAgentLabelText = (viewportLabel: string): string => `User-Agent（${viewportLabel}）`;

/** 何回目か（例: `1回目`）。再試行の前の試行の番号と、実行（起動）の番号（実行の記録の表。R6）の、共通の書き方。 */
export const ordinalText = (ordinal: number): string => `${ordinal}回目`;

/** 再試行の前の試行の番号（例: `1回目`）。 */
export const retryAttemptText = (attempt: number): string => ordinalText(attempt);

/** 再試行の前の試行の記録であることの印（例: `再試行の前の記録（1回目）`。Safety の事象の表。C16d）。 */
export const earlierAttemptRecordText = (attempt: number): string =>
  `${HTML_REPORT_TEXT.pages.retriesHeading}（${retryAttemptText(attempt)}）`;

// ---------------------------------------------------------------------------------------------------------------
// CLI と設定のエラー（`src/cli/**`。U17a、Task 14〜17 の設計書 第7章、6.1.5）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 設定のエラーの種類ごとの、日本語の説明。種類の一覧は `src/config/config-error.ts` の `CONFIG_ERROR_KINDS` が持ち、書き漏れと余分は、
 * そちらで型で確かめる（このファイルは `src/config/types.ts` 以外の `src/config/**` を import しないため）。
 * エラーの詳細（英語の検証のエラー、パスなど）は、技術的な詳細として、CLI がそのまま示す（ここでは訳さない）。
 */
export const CONFIG_ERROR_DESCRIPTIONS = deepFreeze({
  CONFIG_FILE_NOT_FOUND: '設定のファイルが見つかりません。',
  CONFIG_FILE_UNREADABLE: '設定のファイルを読めません。',
  CONFIG_JSON_INVALID: '設定のファイルを、JSON として読めません。',
  TARGET_ID_MISSING: '設定のファイルに、対象の ID（target.id）がありません。',
  TARGET_NOT_SELECTED: '使う設定のファイルが、1つに決まりません。--config で、設定のファイルを指定してください。',
  TARGET_ID_DUPLICATED: 'config/targets/ の中に、対象の ID（target.id）が同じ設定のファイルが、複数あります。',
  CONFIG_INVALID: '設定の内容に、誤りがあります。',
  COMMAND_MISSING: 'コマンドを指定してください。',
  UNKNOWN_COMMAND: '知らないコマンドです。',
  INVALID_ARGUMENTS: '引数に、誤りがあります。',
  CONFLICTING_ARGUMENTS: '--headed と --headless は、同時に指定できません。',
} as const);
export type ConfigErrorDescriptionKind = keyof typeof CONFIG_ERROR_DESCRIPTIONS;

/** 設定のエラーの種類の、日本語の説明。 */
export const describeConfigError = (kind: ConfigErrorDescriptionKind): string => CONFIG_ERROR_DESCRIPTIONS[kind];

/** CLI のコマンドごとの、日本語の説明（使い方の表示）。コマンドの名前の一覧は、CLI（`src/cli/arguments.ts`）が持つ。 */
export const CLI_COMMAND_DESCRIPTIONS = deepFreeze({
  run: '設定を読み、監査を実行して、結果を出力先に書き出します。',
  'validate-config': '設定を読み、誤りがないかを確かめます。監査は実行しません。',
} as const);

/** CLI のオプションごとの、値の名前（値を取らないものは `null`）と、日本語の説明（使い方の表示）。オプションの一覧は、CLI が持つ。 */
export const CLI_OPTION_DESCRIPTIONS = deepFreeze({
  config: {
    valueName: 'パス',
    description: '対象の設定のファイル。省略すると、config/targets/ の中の、ただ1つの設定のファイルを使います。',
  },
  output: {
    valueName: 'ディレクトリ',
    description: '出力先のディレクトリ。設定の output.directory を上書きします。',
  },
  headed: {
    valueName: null,
    description: 'ブラウザの画面を表示して実行します。設定の browser.headed を上書きします。',
  },
  headless: {
    valueName: null,
    description: 'ブラウザの画面を表示せずに実行します。設定の browser.headed を上書きします。--headed と同時には指定できません。',
  },
  new: {
    valueName: null,
    description: '途中の Run があっても、続きから再開せずに、新しい Run を始めます（run のときだけ）。',
  },
  help: {
    valueName: null,
    description: 'この使い方を表示します。設定は読まず、監査も実行しません。',
  },
} as const);

/** CLI が示す、日本語の文言（HTML レポートと共通の要約の文言は `RUN_SUMMARY_TEXT`）。 */
export const CLI_TEXT = deepFreeze({
  usage: {
    heading: '使い方',
    /** 使い方の1行目の、コマンドとオプションの置き場所。 */
    commandPlaceholder: '<コマンド>',
    optionsPlaceholder: '[オプション]',
    commandsHeading: 'コマンド',
    optionsHeading: 'オプション',
    exitCodesHeading: '終了コード',
  },
  /** 設定のエラーの見出し。終了コードの表の、設定のエラーの行のラベルにも使う（Run Status のラベルは、表示カタログのもの）。 */
  configErrorHeading: '設定のエラー',
  /**
   * 終了コードの表の、Run を始められない場合（実行中の Run がある、版が違う、ロックを同時に作り直された、保存を始められない）の行の
   * ラベル（中断した Run の再開の設計書 4.7.1）。
   */
  runUnavailableHeading: 'Run を始められない',
  /**
   * 終了コードの表の、中断（2回目のシグナルで、最後の処理をせずにすぐに終えた）の行のラベル（中断した Run の再開の設計書 4.7、4.7.1）。
   */
  interruptedHeading: '中断',
  /** 技術的な詳細（英語のエラーの文、パスなど）の見出し。 */
  detailsHeading: '詳細（技術的な情報）',
  validateConfig: {
    succeeded: '設定に、誤りはありません。',
  },
  run: {
    started: '監査を始めます。',
    resultHeading: '監査の結果',
    outputDirectory: '出力先',
    report: 'HTML レポート',
    bundle: 'ChatGPT 用のバンドル',
    /**
     * 結果の、サイトへの負荷の行（見出しは `RUN_SUMMARY_TEXT.loadHeading`）の、ページの読み込みの回数の短い名前
     * （HTML レポートの名前は `HTML_REPORT_TEXT.summary.load.navigationCount`）。
     */
    navigationCount: 'ページの読み込み',
    /**
     * 結果の、実行の記録の行（例: `実行: 3回、再開 2回`。中断した Run の再開の設計書 4.8 の「表示」。R6）の名前。HTML レポートの
     * 名前は `HTML_REPORT_TEXT.summary.executions.count`。
     */
    executions: '実行',
    /** 実行の記録の行の、再開の回数の短い名前（HTML レポートの名前は `HTML_REPORT_TEXT.summary.executions.resumeCount`）。 */
    resumes: '再開',
    /**
     * 結果の、この起動の終わり方の行（例: `この起動の終わり方: 実行時間の上限で停止（STOPPED_BY_RUNTIME_LIMIT）`。中断した Run の再開の
     * 設計書 4.8 の 2026-10-08 の追補。R9）の名前。ラベルは表示カタログ `RUN_EXECUTION_END_REASON_CATALOG` のもの。
     */
    lastEndReason: 'この起動の終わり方',
  },
  /**
   * 実行中の進み具合の行（サイトへの負荷の制御の設計書 4.8）の、CLI だけで使う文言。発見したページは `RUN_SUMMARY_TEXT.coverage.discovered`、
   * ページの読み込みは `CLI_TEXT.run.navigationCount`、許可 Origin への要求は `RUN_SUMMARY_TEXT.allowedOriginRequests` を使う。
   */
  progress: {
    /** 行の見出し。 */
    heading: '進み具合',
    /**
     * 監査を終えたページ（`RunProgressReport.pagesFinished`。Run の全体で、監査を終えたページの数で、再開した Run では、再開の前に終わった
     * ページを含む）。状態が監査済みのページだけの「監査したページ」とは別の数。
     */
    pagesFinished: '監査を終えたページ',
    /** 設定のページ数の上限（`RunProgressReport.maxPages`）。監査を終えたページの括弧の中に示す。 */
    maxPages: '上限',
    /** 許可 Origin の外への要求（`RunProgressReport.requests.otherOrigins.count`）の短い名前。 */
    otherOriginRequests: '許可 Origin の外',
    /** この実行の開始からの経過時間（`RunProgressReport.elapsedMs`）。 */
    elapsed: '経過',
  },
  failure: {
    /** artifact の書き出しの入出力の失敗（`ArtifactWriteError`）。 */
    artifactWriteFailed: '監査の結果のファイルを、書き出せませんでした。',
    /** 予期しない例外。 */
    unexpected: '想定していないエラーが起きたため、処理を終えました。',
    /**
     * 同じ名前の Run のディレクトリが、すでにあった（DEF-009。同じ秒に始めた別の Run など）。artifact は書かない。
     */
    runDirectoryExists:
      '同じ名前の Run のディレクトリが、すでにあります。別の Run の結果を書き換えないよう、監査を始めずに終えました。少し待ってから、もう一度実行してください。',
    /** Run のディレクトリを作れなかった（出力先を作れない場合など。DEF-009）。artifact は書かない。 */
    runDirectoryUnavailable: 'Run のディレクトリを、作れませんでした。監査を始めずに終えました。',
    /** 作れなかった Run のディレクトリのパスの項目の名前。 */
    runDirectory: 'Run のディレクトリ',
  },
  /** 中断した Run の再開の流れ（中断した Run の再開の設計書 4.7.1）の、値を含まない文言。値を含む文言は、下の `…Text` の関数。 */
  resume: {
    /**
     * 最後の出力を書いた後に、保存の終わり（最後の状態の書き出しと、ロックを外す処理）を、最後まで行えなかった（警告。終了コードは
     * Run Status のとおり）。最後の状態は書けて、ロックを外す処理だけが失敗した場合は、次の起動で最後の処理をやり直さないので、
     * 「ことがあります」とする。
     */
    finishFailed: '再開のための保存の終わりを、最後まで書けませんでした。次に同じコマンドを実行すると、最後の処理をもう一度行うことがあります。',
  },
  /** シグナル（SIGINT・SIGTERM・SIGHUP。Ctrl+C など）を受けたときに、標準エラーに示す文言（中断した Run の再開の設計書 4.7 の「シグナル」）。 */
  interrupt: {
    /** 1回目: 止める印を付け、今のページの監査を終えてから止める。 */
    stopRequested: '中断を受け付けました。今のページの監査を終えてから止めます。すぐに止めるには、もう一度押してください。',
    /** 2回目: 最後の処理をせずに、すぐに終える（終了コード 5）。保存は、最後に監査を終えたページまで残る。 */
    exitingNow: 'すぐに止めます。再開のための保存は、最後に監査を終えたページまで残っています。同じコマンドを実行すると、続きから再開します。',
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 中断した Run の再開の流れの文言（中断した Run の再開の設計書 4.7、4.7.1。R5a）。値（Run の ID、違う項目、版、パス、ページの数の書式）は、
// 呼び出し側（`src/cli/output.ts`）が渡す。
// ---------------------------------------------------------------------------------------------------------------

/** 同じ出力先で、別の Run が実行中（動いている Run のロックがある）なので、再開も新しい Run もせずに終える。 */
export const activeRunInOutputDirectoryText = (runId: string): string =>
  `同じ出力先で、別の Run（${runId}）が実行中です。その Run が終わってから実行してください。`;

/** 途中の Run の再開のための保存（`state.json` と `state.prev.json`）を読めないので、再開の対象にしない。 */
export const unreadableCheckpointText = (runId: string): string =>
  `途中の Run（${runId}）の再開のための保存を読めないため、再開の対象にしません。`;

/** 途中の Run の実効の設定が今回と違うので、再開せずに、新しい Run を始める。`differencesText` は、違う項目のパスの一覧の文言。 */
export const differentConfigRunText = (runId: string, differencesText: string): string =>
  `設定が違うため、途中の Run（${runId}）は再開しません（違う項目: ${differencesText}）。新しい Run を始めます。`;

/** 違う版の1項目（例: `BeakSight の版: 保存 0.1.0 → 今 0.2.0`）。ラベルは、表示の文言のもの。 */
export const versionDifferenceText = (label: string, saved: string, current: string): string =>
  `${label}: 保存 ${saved} → 今 ${current}`;

/** 途中の Run の版が今と違うので、再開できずに終える。`differencesText` は、違う版の項目（`versionDifferenceText`）の一覧の文言。 */
export const differentVersionRunText = (runId: string, differencesText: string): string =>
  `途中の Run（${runId}）は、版が違うため再開できません（${differencesText}）。最初から始めるには --new を付けてください。`;

/**
 * 途中の Run を、続きから再開する。`pagesFinishedText` は、監査を終えたページの数の項目（実行中の進み具合の行と同じ書き方。例:
 * `監査を終えたページ 3件`）。
 */
export const resumingRunText = (runId: string, pagesFinishedText: string): string =>
  `途中の Run（${runId}。${pagesFinishedText}）を、続きから再開します。最初から始めるには --new を付けてください。`;

/** 途中の Run は、違反を検出した後なので、新しいページを監査せずに、最後の処理だけを行う。 */
export const finalizingRunText = (runId: string): string =>
  `途中の Run（${runId}）は、安全の不変条件の違反を検出した後のため、新しいページを監査せずに、最後の処理だけを行います。`;

/** 再開を始められなかった: ロックが、動いている別のプロセスの Run のもの（`LOCK_HELD_BY_ACTIVE_RUN`）。 */
export const runLockHeldText = (runId: string): string => `別のプロセスが、この Run（${runId}）を実行しています。`;

/** 再開を始められなかった: 古いロックを、別のプロセスが同時に作り直した（`LOCK_TAKEN_OVER_CONCURRENTLY`）。 */
export const runLockTakenOverText = (runId: string): string => `別のプロセスが、同時にこの Run（${runId}）の再開を始めました。`;

/** 再開を始められなかった: 再開のための保存やロックを、読み書きできなかった（`CHECKPOINT_STORE_FAILED`）。 */
export const checkpointStoreFailedText = (runId: string): string => `再開のための保存を読み書きできませんでした（${runId}）。`;

/** 終わった Run の、使わない再開のための保存（ページの保存、`state.prev.json`）を消せなかった（警告。終了コードは変えない）。 */
export const finishedCheckpointCleanupFailedText = (path: string): string =>
  `終わった Run の再開のための保存の一部を消せませんでした（${path}）。手で消しても問題ありません。`;

/**
 * サイトの不調で止めた Run の、結果の1行（サイトが応答しないときに Run を止める設計書 3.4。SU4）。`detail` は、最初に検知した失敗の
 * 技術的な詳細（Run の理由 `SITE_UNAVAILABLE` の `detail`。例: `desktop:passive:TIMEOUT`）で、括弧の中にそのまま示す。`null` なら、
 * 括弧を出さない。出すかどうかは、表示用モデル（`RunSummaryView.siteUnavailableStop`）が決める。
 */
export const siteUnavailableStopText = (detail: string | null): string =>
  `サイトが応答しないため、監査を止めました${detail === null ? '' : `（${detail}）`}。サイトが戻ってから、同じコマンドで続きから再開してください。`;

/**
 * サイトの不調でページを捨てた後、待ってから同じページを確かめ直すことを知らせる、実行中の1行（サイトが応答しないときに Run を止める設計書
 * 3.5.4、3.6.2。SU5、SU6）。`url` はそのページの URL、`waitText` は待つ時間の文言（`formatDuration` の結果。例: `60秒`。値は Run Coordinator
 * の知らせの事実から、CLI が書式にかける）、`attempt` は何回目の確かめ直しか（1 から）、`maxAttempts` は確かめ直しの最大の回数。どれも、
 * そのまま示す。
 */
export const siteUnavailableRecheckText = (url: string, waitText: string, attempt: number, maxAttempts: number): string =>
  `サイトが応答しないため、${waitText}待ってから同じページを確かめ直します（${String(attempt)}/${String(maxAttempts)} 回目。${url}）。`;

/**
 * 確かめ直しで応答が戻った後、ページの読み込みの間隔を延ばして続けることを知らせる、実行中の1行（サイトが応答しないときに Run を止める設計書
 * 3.6.2。SU6）。`intervalText` は新しい間隔の文言（`formatDuration` の結果。例: `10秒`。値は Run Coordinator の知らせの事実から、CLI が
 * 書式にかける）。そのまま示す。
 */
export const siteUnavailableSlowdownText = (intervalText: string): string =>
  `確かめ直しで応答が戻ったので、ページの読み込みの間隔を ${intervalText} に延ばして続けます。`;

/** CLI の1つの項目の行（例: `出力先: C:\artifacts\RUN-…`）。 */
export const cliFieldText = (label: string, value: string): string => `${label}: ${value}`;

/** CLI の件数の項目（例: `エラー 3件`）。件数の書式は、`formatCount` のもの。 */
export const cliCountText = (label: string, countText: string): string => `${label} ${countText}`;

/**
 * 実行中の進み具合の行の項目を、`・` で1つの文字列に並べる（例: `監査を終えたページ 12件（…）・ページの読み込み 284回`。設計書 4.8）。
 * 項目の中の括弧で一覧の区切り（`、`）を使うので、項目どうしは別の区切りにする。
 */
export const progressItemsText = (items: readonly string[]): string => items.join('・');

/** ラベルに、コピーや検索のための値そのもの（コード）を添える（例: `完了（COMPLETE）`。UI追補設計書 3.1）。 */
export const labelWithCodeText = (label: string, code: string): string => `${label}（${code}）`;

/** severity の区分ごとの指摘の件数の項目の名前（例: `サイト品質の指摘`）。ラベルは、表示カタログのもの。 */
export const findingGroupCountsLabelText = (groupLabel: string): string => `${groupLabel}の指摘`;
