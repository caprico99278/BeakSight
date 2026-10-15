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
  AUTH_SESSION_LOST: 'ログインの状態が切れたため、そのページを監査せず、それより後の監査を始めませんでした。',
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
  /**
   * BeakSight の版（`RunSummary.toolVersion`）と Playwright の版（`environment.playwrightVersion`）の項目の名前（CCX-29。CC-039）。HTML の要約の
   * 節と実行の環境の小節の項目と、CLI の「版が違うので再開できない」の知らせの項目（`versionDifferenceText`）。
   */
  toolVersion: 'BeakSight の版',
  playwrightVersion: 'Playwright',
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
    /** 「実行の環境」の小節。Playwright の版の項目は、CLI と共通の `RUN_SUMMARY_TEXT.playwrightVersion`。 */
    environmentHeading: '実行の環境',
    environment: {
      nodeVersion: 'Node.js',
      platform: 'OS',
      osRelease: 'OS の版',
      arch: 'CPU のアーキテクチャ',
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

/**
 * 同じ出力先で、別の起動が Run を始めているところ（出力先の開始のロックがあり、Run の ID はまだ決まっていない。DEF-057。Task 24 の設計書 4.6）
 * なので、再開も新しい Run もせずに終える。`activeRunInOutputDirectoryText` と同じ扱い（終了コード 4）。
 */
export const startingRunInOutputDirectoryText =
  '同じ出力先で、別の Run が始まるところです。その Run が終わってから実行してください。';

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

/**
 * 認証つきの Run で、セッションが切れたためにページを捨てて Run を止めることを知らせる、実行中の1行（Task 25 の設計書 4.3、4.4。T25d）。
 * `url` は止まったページの URL（Run Coordinator の知らせの事実。Ledger と同じ伏せ字の後の値）。CLI は認証つきの Run を行わないので、
 * この行は、知らせの種類の網羅のためにある（画面は、ジョブの記録から同じ案内を出す。T25e）。
 */
export const authSessionLostNoticeText = (url: string): string =>
  `ログインの状態が切れたため、このページで監査を止めます（${url}）。再開するともう一度ログインします。同じページで止まる場合は、このページを読まないパスに足してください。`;

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

// ---------------------------------------------------------------------------------------------------------------
// 管理データの準備（`npm run setup:local`）と保存（Task 23 の設計書 4.3、4.6。T23d）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 利用者のファイルを消さない・上書きしないことを伝える文（設計書 4.3 の 3、4.6）。ファイルにかかわる理由の手順に、そのまま入れる。
 */
const CONTROL_FILES_KEPT_TEXT = 'BeakSight は、このファイルを消したり、上書きしたり、移したりしません。';

/** 名前を変えるか移せば、次の準備で新しく作られることの文（設計書 4.6。データベースを消す・作り直す機能はない）。 */
const CONTROL_RENAME_TO_RECREATE_TEXT =
  'そのファイルを別の名前に変えるか、別の場所へ移してから、もう一度 npm run setup:local を実行してください。新しい管理データが作られます。';

/** 理由ごとの、利用者への説明と、取るべき手順。 */
export interface ControlReasonText {
  /** 何が起きたか（表示される文）。 */
  readonly description: string;
  /** 利用者が取るべき手順。 */
  readonly action: string;
}

/**
 * 環境の確かめで止める理由ごとの説明と手順。理由の一覧は `src/control/environment/control-environment.ts` の
 * `CONTROL_ENVIRONMENT_FAILURE_REASONS` が持ち、書き漏れと余分は `src/control/setup-local.ts` で型で確かめる
 * （このファイルは `src/control/` を import しないため）。
 */
export const CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS = deepFreeze({
  NODE_VERSION_UNSUPPORTED: {
    description: 'Node.js の版が古く、管理データ（SQLite）の機能を使えません。',
    action: 'Node.js 24 の最新の版（24.15.0 以上）を入れてから、もう一度実行してください。版は node -v で確かめられます。',
  },
  NODE_SQLITE_UNAVAILABLE: {
    description: 'この Node.js では、組み込みの SQLite（node:sqlite）を使えません。',
    action:
      'SQLite は Node.js に組み込まれているので、別に入れるものはありません。SQLite を止める指定（--no-experimental-sqlite。環境変数 NODE_OPTIONS の中を含む）があれば外し、それでも使えなければ Node.js 24 の最新の版を公式の配布から入れ直してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 管理データの部品が止める理由ごとの説明と手順（先頭の 2 つは環境の確かめの理由で、上と同じ文）。理由の一覧は
 * `src/control/store/store-errors.ts` の `CONTROL_STORE_FAILURE_REASONS` が持ち、書き漏れと余分は `src/control/setup-local.ts` で型で確かめる。
 */
export const CONTROL_STORE_FAILURE_DESCRIPTIONS = deepFreeze({
  ...CONTROL_ENVIRONMENT_FAILURE_DESCRIPTIONS,
  DATA_DIRECTORY_NOT_DIRECTORY: {
    description: '管理データを置くフォルダ（local-data）の位置に、フォルダではないファイルがあります。',
    action: `そのファイルを別の名前に変えるか、別の場所へ移してから、もう一度実行してください。${CONTROL_FILES_KEPT_TEXT}`,
  },
  DATA_DIRECTORY_NOT_WRITABLE: {
    description: '管理データを置くフォルダを作れないか、そのフォルダに書き込めません。',
    action: 'フォルダの書き込みの権限を確かめてください。リポジトリは、ローカルのディスクに置いてください（ネットワークのドライブや同期のフォルダでの動作は確かめていません）。',
  },
  NOT_A_SQLITE_FILE: {
    description: '管理データのファイルの位置に、SQLite ではないファイル（またはフォルダ）があります。',
    action: `${CONTROL_RENAME_TO_RECREATE_TEXT}${CONTROL_FILES_KEPT_TEXT}`,
  },
  NOT_A_BEAKSIGHT_DATABASE: {
    description: 'SQLite のファイルですが、BeakSight の管理データではありません。',
    action: `${CONTROL_RENAME_TO_RECREATE_TEXT}${CONTROL_FILES_KEPT_TEXT}`,
  },
  DATABASE_FROM_NEWER_VERSION: {
    description: 'この管理データは、今より新しい版の BeakSight で作られています。この版では読み書きしません。',
    action: `新しい版の BeakSight を使ってください。${CONTROL_FILES_KEPT_TEXT}`,
  },
  DATABASE_LOCKED: {
    description: '別のプログラムが、管理データのファイルを開いているか、書き込んでいます。',
    action: '画面のサーバ（npm run ui）や、ほかにこのファイルを開いているプログラムを閉じてから、もう一度実行してください。',
  },
  DATABASE_READ_ONLY: {
    description: '管理データのファイルが読み取り専用で、書き込めません。',
    action: 'ファイルの読み取り専用の設定と、書き込みの権限を確かめてから、もう一度実行してください。',
  },
  DATABASE_WAL_UNAVAILABLE: {
    description: '管理データのファイルを、必要な書き込みの方式（WAL）にできません。ネットワークのドライブなどに置かれている可能性があります。',
    action: 'リポジトリをローカルのディスクに置いてから、もう一度実行してください。',
  },
  DATABASE_INTEGRITY_FAILED: {
    description: '管理データのファイルが壊れています。',
    action: `${CONTROL_RENAME_TO_RECREATE_TEXT}前のデータは、名前を変えたファイルに残ります。${CONTROL_FILES_KEPT_TEXT}`,
  },
  MIGRATION_FAILED: {
    description: '管理データの版を上げる処理が失敗しました。途中の変更は元に戻してあります。',
    action: 'もう一度実行してください。繰り返し失敗する場合は、表示された詳細を開発者に伝えてください。',
  },
  DATABASE_OPEN_FAILED: {
    description: '管理データのファイルを開けませんでした。',
    action: 'ほかのプログラムがファイルを開いていないか、ファイルの権限を確かめてから、もう一度実行してください。表示された詳細も確かめてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * プロファイルの保存の部品が変更を拒む理由ごとの説明と手順（画面の表示で使う。T23f）。理由の一覧は
 * `src/control/store/profile-store.ts` の `PROFILE_STORE_REJECTION_REASONS` が持ち、書き漏れと余分は `src/control/setup-local.ts` で型で確かめる。
 */
export const PROFILE_STORE_REJECTION_DESCRIPTIONS = deepFreeze({
  PROFILE_INVALID: {
    description: 'プロファイルの内容に、誤りがあります。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'プロファイルが指す設定のファイルを読めないか、その内容に誤りがあります。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度保存してください。',
  },
  PROFILE_REVISION_NOT_INITIAL: {
    description: '新しいプロファイルの改訂が、最初の改訂ではありません。',
    action: '新しく作るプロファイルは、最初の改訂で保存してください。',
  },
  PROFILE_ALREADY_EXISTS: {
    description: '同じ名前のプロファイルが、既にあります（取り消したものを含みます）。',
    action: '別の名前にするか、既にあるプロファイルを更新してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。',
    action: '一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したプロファイルは、更新も取り消しもできません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: '別の変更が先に保存されたため、この変更を保存しませんでした。',
    action: '一覧を読み込み直して、今の内容を確かめてから、もう一度変更してください。',
  },
  PROFILE_REVISION_NOT_ADVANCED: {
    description: '新しい改訂が、保存されている改訂より大きくありません。',
    action: '一覧を読み込み直して、今の改訂を確かめてから、もう一度変更してください。',
  },
  STORED_PROFILE_INVALID: {
    description: '保存されているプロファイルが壊れているか、今の決まりに合いません。変更はしていません。',
    action: '表示された誤りを開発者に伝えてください。BeakSight は、保存されている内容を消したり書き換えたりしていません。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** `npm run setup:local` の表示の文言（設計書 4.6）。 */
export const SETUP_LOCAL_TEXT = deepFreeze({
  /** 準備が終わったときの見出し。 */
  doneHeading: '管理データの準備ができました。',
  /** 止めたときの見出し。 */
  failedHeading: '管理データの準備ができませんでした。',
  locationLabel: '管理データの場所',
  resultLabel: '結果',
  sqliteVersionLabel: 'SQLite の版',
  profilesLabel: 'プロファイル',
  quickCheckLabel: '整合性の確かめ（quick_check）',
  reasonLabel: '理由',
  actionLabel: '取るべき手順',
  detailLabel: '詳細',
  quickCheckOk: '問題はありません（ok）',
  /** 利用者のファイルを消さない・上書きしないことの文（ファイルにかかわる理由の手順に入っている）。 */
  filesKept: CONTROL_FILES_KEPT_TEXT,
  /** 新しく作った（版 N）。 */
  createdText: (schemaVersion: number): string => `新しく作りました（版 ${schemaVersion}）。`,
  /** 既にあった（版 N）。 */
  existingText: (schemaVersion: number): string => `既にありました（版 ${schemaVersion}）。何も変えていません。`,
  /** 既にあり、版を上げた。 */
  upgradedText: (fromVersion: number, toVersion: number): string => `既にありました。版 ${fromVersion} から版 ${toVersion} に上げました。`,
  /** 状態ごとのプロファイルの件数（件数の書式は `formatCount` のもの）。 */
  profileCountsText: (activeCountText: string, retiredCountText: string): string =>
    listText([`有効 ${activeCountText}`, `取り消し ${retiredCountText}`]),
  /** `quick_check` が問題の行を返した。 */
  quickCheckProblemText: (problemCountText: string): string => `問題があります（${problemCountText}）`,
  /** Node の版（今の版と、必要な版）。 */
  nodeVersionText: (currentVersion: string, minimumVersion: string): string =>
    `今の Node.js の版: ${currentVersion}（必要な版: ${minimumVersion} 以上）`,
  /** 次に行うこと（準備ができたとき）。 */
  nextStep: '画面は npm run ui で起動します（doc/spec/local-ui.md）。',
  // T26e（Task 26 の設計書 4.1 の「起動のとき」）: 資格情報のフォルダの一時のファイルの片付けと、暗号化の確かめの結果（値は出さない）。
  credentialProtectionLabel: '資格情報の暗号化（自動ログイン）',
  credentialProtectionAvailable: '使えます（Windows の DPAPI）',
  credentialProtectionUnavailable:
    '使えません（Windows の暗号化（DPAPI）を確かめられないか、Windows でないため、自動ログインは始められません。公開の監査と手動のログインの監査は使えます）',
  /** 資格情報のフォルダに残っていた一時のファイルを消した（`countText` は `formatCount` の結果）。 */
  temporaryCredentialFilesRemovedText: (countText: string): string =>
    `資格情報のフォルダに残っていた書きかけの一時のファイル（${countText}）を消しました。`,
  /** 資格情報のフォルダを読めず、一時のファイルを片付けられなかった。 */
  temporaryCredentialFilesUnreadable: '資格情報のフォルダを読めず、書きかけの一時のファイルを片付けられませんでした。フォルダの権限を確かめてください。',
} as const);

// ---------------------------------------------------------------------------------------------------------------
// ローカルの管理画面（`apps/local-ui/`。Task 23 の設計書 4.4、4.7。T23f）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 画面のサーバの守りの部品（`apps/local-ui/launcher/request-guard.ts`）が拒否するときの本文（T23e から移した）。鍵は HTTP の状態の名前。
 * token の値は含めない。
 */
export const LOCAL_UI_GUARD_REJECTION_TEXT = deepFreeze({
  BAD_REQUEST: '要求の形が正しくありません。',
  UNAUTHORIZED: 'この画面を開くには、画面のサーバを起動したときにコンソールに表示された URL を開いてください。',
  MISDIRECTED_REQUEST: 'このアドレスでは開けません。コンソールに表示された http://127.0.0.1 の URL を使ってください。',
} as const);

/** 画面のサーバのコンソールの文言（起動の部品と開発のサーバ）。token の URL は、コンソールにだけ出す。 */
export const LOCAL_UI_CONSOLE_TEXT = deepFreeze({
  tokenUrl: (url: string): string => `BeakSight 管理画面: ${url}`,
  devTokenUrl: (url: string): string => `BeakSight 管理画面（開発）: ${url}`,
  tokenNotice: 'この URL は、この起動のあいだだけ使えます。ほかの人に渡さないでください。',
  requestFailed: '画面のサーバの要求の処理で、誤りが起きました。',
} as const);

/** 画面のサーバ（本番の起動の部品と開発のサーバ）を起動できなかった理由（閉じた一覧。T23h）。 */
export type LocalUiStartFailure =
  | { readonly kind: 'PORT_IN_USE'; readonly port: number }
  | { readonly kind: 'PORT_INVALID'; readonly value: string }
  | { readonly kind: 'PORT_PERMISSION_DENIED'; readonly port: number }
  | { readonly kind: 'HOST_NOT_ALLOWED'; readonly host: string | true }
  | { readonly kind: 'LISTEN_ADDRESS_NOT_ALLOWED'; readonly address: string }
  | { readonly kind: 'START_FAILED'; readonly detail: string }
  | { readonly kind: 'PREVIEW_NOT_SUPPORTED' }
  /** ほかの画面のサーバが動いている（管理のロックの持ち主。DEF-061。T24h-4）。`port` は分からなければ `null`。 */
  | { readonly kind: 'ALREADY_RUNNING'; readonly processId: number; readonly port: number | null };

/** 画面のサーバを起動できなかったときの文言（何が起きたかと、取るべき手順）。 */
export const LOCAL_UI_START_FAILURE_TEXT = deepFreeze({
  heading: '画面のサーバを起動できませんでした。',
  portInUse: (port: number): string => `port ${port} は、ほかのプログラムが使っています。`,
  portInUseAction:
    'ほかの画面のサーバ（npm run ui、npm run ui:dev）を閉じるか、--port で別の番号を指定してください（例: npm run ui -- --port 4400）。',
  portInvalid: (value: string): string => `--port の値（${value}）が正しくありません。`,
  portInvalidAction: '--port には、1 から 65535 までの番号を指定してください（例: npm run ui -- --port 4400）。',
  portPermissionDenied: (port: number): string => `port ${port} で待ち受ける権限がありません。`,
  portPermissionDeniedAction: '--port で、ほかの番号（例: 4400）を指定してください。',
  hostNotAllowed: (host: string): string =>
    `待ち受けのアドレスに ${host} が指定されました。管理画面は 127.0.0.1 だけで待ち受けます（ほかのコンピュータから開けないようにするため）。`,
  hostNotAllowedAction: '--host を指定せずに、もう一度起動してください。',
  /** `--host` だけ（値なし）を指定したときの、待ち受けのアドレスの表示。 */
  allAddresses: 'すべてのアドレス',
  listenAddressNotAllowed: (address: string): string =>
    `画面のサーバが ${address} で待ち受けました。管理画面は 127.0.0.1 だけで待ち受けるので、止めました。`,
  listenAddressNotAllowedAction: '--host などの待ち受けのアドレスの指定を外して、もう一度起動してください。',
  startFailed: '画面のサーバの待ち受けを始められませんでした。',
  startFailedAction: '表示された詳細を確かめてから、もう一度起動してください。',
  previewNotSupported: '管理画面は、Vite の preview（vite preview）では起動できません（守りの部品を通らないため）。',
  previewNotSupportedAction: '画面は npm run ui で起動してください（開発のときは npm run ui:dev）。',
  /** ほかの画面のサーバが動いている（DEF-061。T24h-4）。`portText` は「、port N」か空。 */
  alreadyRunning: (processId: number, portText: string): string =>
    `画面のサーバは、すでに動いています（プロセスの ID ${processId}${portText}）。画面のサーバは、同時に 1 つだけ動かせます（監査を同時に 1 つだけにするため）。`,
  alreadyRunningPort: (port: number): string => `、port ${port}`,
  alreadyRunningAction: '動いている画面のサーバを使うか、それを止めてから起動してください（npm run ui と npm run ui:dev、--port の違いも、同じ扱いです）。',
} as const);

/** 起動できなかった理由を、コンソールに出す行にする（見出し、何が起きたか、取るべき手順、詳細）。 */
export const describeLocalUiStartFailure = (failure: LocalUiStartFailure): readonly string[] => {
  const text = LOCAL_UI_START_FAILURE_TEXT;
  const [description, action, detail] = ((): readonly [string, string, string | null] => {
    switch (failure.kind) {
      case 'PORT_IN_USE':
        return [text.portInUse(failure.port), text.portInUseAction, null];
      case 'PORT_INVALID':
        return [text.portInvalid(failure.value), text.portInvalidAction, null];
      case 'PORT_PERMISSION_DENIED':
        return [text.portPermissionDenied(failure.port), text.portPermissionDeniedAction, null];
      case 'HOST_NOT_ALLOWED':
        return [text.hostNotAllowed(failure.host === true ? text.allAddresses : failure.host), text.hostNotAllowedAction, null];
      case 'LISTEN_ADDRESS_NOT_ALLOWED':
        return [text.listenAddressNotAllowed(failure.address), text.listenAddressNotAllowedAction, null];
      case 'START_FAILED':
        return [text.startFailed, text.startFailedAction, failure.detail];
      case 'PREVIEW_NOT_SUPPORTED':
        return [text.previewNotSupported, text.previewNotSupportedAction, null];
      case 'ALREADY_RUNNING':
        return [
          text.alreadyRunning(failure.processId, failure.port === null ? '' : text.alreadyRunningPort(failure.port)),
          text.alreadyRunningAction,
          null,
        ];
    }
  })();
  return Object.freeze([
    text.heading,
    description,
    cliFieldText(SETUP_LOCAL_TEXT.actionLabel, action),
    ...(detail === null ? [] : [cliFieldText(SETUP_LOCAL_TEXT.detailLabel, detail)]),
  ]);
};

/**
 * プロファイルの検証の誤りのコード（`src/control/contracts.ts` の `PROFILE_VALIDATION_ERROR_CODES`）ごとの、日本語の説明。書き漏れと余分は、
 * 画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 */
export const PROFILE_VALIDATION_ERROR_DESCRIPTIONS = deepFreeze({
  PROFILE_SCHEMA_INVALID: 'プロファイルの形が正しくありません。',
  PROFILE_ID_INVALID: '名前（profileId）は、小文字の英数字とハイフンで、英数字から始め、63 文字までにしてください。',
  PROFILE_TARGET_PATH_INVALID: '設定のファイルは、config/targets/ か local/targets/ の中の .json を選んでください。',
  PROFILE_MODE_ENVIRONMENT_MISMATCH: 'この監査モードは、この環境では選べません（テスト環境の監査は、テスト環境だけで選べます）。',
  PROFILE_AUTH_MISMATCH: 'この監査モードでは、この認証の方式は選べません（公開の監査はログインしない、テスト環境の監査はログインする）。',
  PROFILE_TEST_ORIGINS_REQUIRED: 'このモードでは、テスト環境の Origin を 1 つ以上書いてください。',
  PROFILE_TEST_ORIGIN_INVALID: 'テスト環境の Origin の形が正しくありません（https://… か、このコンピュータの http://…）。',
  PROFILE_TEST_ORIGIN_OUTSIDE_TARGET: 'テスト環境の Origin が、設定のファイルの監査の対象（allowedOrigins）に入っていません。',
  PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED: 'このモードでは、テスト環境であることを確かめた記録の参照を書いてください。',
  PROFILE_REVISION_NOT_ADVANCED: '新しい改訂が、保存されている改訂より大きくありません。',
} as const);

/** ローカルの管理画面の文言（設計書 4.7）。 */
export const LOCAL_UI_TEXT = deepFreeze({
  appName: 'BeakSight',
  appTagline: '監査の管理（このコンピュータだけ）',
  skipToContent: '本文へ移動',
  navigationLabel: '画面の一覧',
  listeningBadge: '127.0.0.1 だけで待ち受け',
  loading: '読み込んでいます…',
  backToList: '一覧に戻る',
  reload: '読み込み直す',
  pages: {
    profiles: 'サイトとプロファイル',
    newProfile: '新しいプロファイル',
    editProfile: 'プロファイルの編集',
    environment: '環境の状態',
  },
  notFound: {
    title: 'ページが見つかりません',
    body: 'この URL の画面はありません。左のメニューから画面を選んでください。',
  },
  error: {
    title: '画面を表示できませんでした',
    body: '読み込み直しても直らない場合は、画面のサーバのコンソールを確かめてください。',
  },
  profileList: {
    caption: '登録したプロファイル',
    empty: 'まだプロファイルがありません。「新しいプロファイル」から登録してください。',
    newProfile: '新しいプロファイル',
    columns: {
      profileId: '名前（profileId）',
      environment: '環境',
      mode: '監査モード',
      auth: '認証の方式',
      status: '状態',
      revision: '改訂',
      updatedAt: '最後の更新',
      lastRun: '最後の Run',
    },
    edit: '編集',
    view: '表示',
  },
  profileForm: {
    profileId: '名前（profileId）',
    profileIdHint: '小文字の英数字とハイフン（例: example-public）。保存した後は変えられません。',
    targetConfigPath: '設定のファイル',
    targetConfigPathHint: 'config/targets/ か local/targets/ の中の JSON です。',
    targetConfigPathPlaceholder: '選んでください',
    noTargetConfigs: '設定のファイルが見つかりません。config/targets/ か local/targets/ に JSON を置いてください。',
    environment: '環境',
    mode: '監査モード',
    auth: '認証の方式',
    approvedTestOrigins: 'テスト環境の Origin（1 行に 1 つ）',
    approvedTestOriginsHint: 'テスト環境の監査のときだけ書きます（例: https://test.example.invalid）。',
    environmentEvidenceRef: 'テスト環境であることを確かめた記録の参照',
    environmentEvidenceRefHint: 'テスト環境の監査のときだけ書きます。秘密（パスワードなど）は書かないでください。',
    // T28b（Task 28 の設計書 4.5）: 書き込みのモードでも、認証の設定・操作の候補の発見・READ の確かめは使える。T32l-2: 書き込み（Task 30・31）は使えるが、
    // このモードの読み取りの監査（`AUDIT`）は今も使えない（`execution-policy.ts` の `PROFILE_OPERATION_POLICY`）。
    testModeNotice:
      'このモードのプロファイルでは、読み取りの監査（承認した書き込みの監査）は始められません。使えるのは、認証の設定、操作の候補の発見、READ の確かめ、書き込みのシナリオ、入力の規則、承認された登録と更新です。書き込みは、シナリオを承認した後に、「書き込みを始める」の画面から人が始めます。読み取りだけで監査するときは、認証つきの読み取りの監査（TEST_AUTH_PASSIVE）のプロファイルを別に作ってください。',
    required: 'この項目を入力してください。',
    save: '保存する',
    saving: '保存しています…',
    created: 'プロファイルを登録しました。',
    updated: 'プロファイルを更新しました。',
    rejectedHeading: '保存できませんでした',
    revisionText: (revision: number): string => `改訂 ${revision}`,
    configCheckHeading: '設定のファイルの確かめ',
    configOk: '設定のファイルに誤りはありません。',
    configChecking: '確かめています…',
    retiredNotice: 'このプロファイルは取り消してあります。変更はできません。',
  },
  retireDialog: {
    open: 'このプロファイルを取り消す',
    title: 'プロファイルを取り消しますか',
    body: '取り消すと、元に戻せません。同じ名前（profileId）は使い直せないので、続けて使う場合は、別の名前で新しく作ってください。保存した資格情報があれば、それも消します。',
    confirm: '取り消す',
    cancel: 'やめる',
    done: 'プロファイルを取り消しました。',
    // T26g-2（T26R の I1）: 取り消しの後に、保存した資格情報を消せなかったとき（取り消しは成功のまま）。
    credentialNotRemoved: '保存した資格情報を消せませんでした。資格情報の画面から消してください。',
  },
  environmentStatus: {
    nodeVersion: 'Node.js の版',
    sqliteVersion: 'SQLite の版',
    databaseLocation: '管理データの場所',
    schemaVersion: '管理データの版',
    schemaVersionText: (current: number, latest: number): string => `版 ${current}（この BeakSight の最新: 版 ${latest}）`,
    profileCounts: 'プロファイルの件数',
    quickCheck: '整合性の確かめ（quick_check）',
    quickCheckOk: '問題はありません（ok）',
    quickCheckProblem: '問題があります。npm run setup:local の表示を確かめてください。',
    listening: '待ち受け',
    listeningValue: '127.0.0.1 だけ（このコンピュータの中からだけ開けます）',
  },
  /** 要求の形の誤り（サーバでの検証で拒否した。画面の不具合のときだけ出る）。 */
  invalidRequest: '画面からの要求の形が正しくありません。画面を読み込み直してください。',
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 監査のジョブ（ローカルの管理画面から動かす監査。Task 24 の設計書 4.4、4.8、4.9。T24f）
// ---------------------------------------------------------------------------------------------------------------

/** 監査を、同じプロファイルで続きから再開する手順の文（中断と失敗の手順で使う）。 */
const AUDIT_JOB_RESUME_ACTION_TEXT = '同じプロファイルで「前回の続きから再開する」を選んで開始すると、続きから再開します。';

/**
 * 止めた自動ログインを、人が確かめてから再び許す手順の文（Task 26 の設計書 4.2、4.6。T26e）。開始を拒む理由と、自動ログインの結果の手順で使う。
 */
const AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT =
  '確かめたら、「ログインを確かめる」の画面で自動ログインの停止を解いてください（資格情報を変えるときは、変更の画面でまとめて解けます）。';

/**
 * 監査のジョブの開始を拒む理由ごとの説明と手順。理由の一覧は `src/control/job/job-records.ts` の `AUDIT_JOB_START_REJECTION_REASONS` が持ち、
 * 書き漏れと余分は画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる（このファイルは `src/control/` を import しない）。
 */
export const AUDIT_JOB_START_REJECTION_DESCRIPTIONS = deepFreeze({
  INVALID_REQUEST: {
    description: '開始の要求の形が正しくないか、画面のサーバが終わるところです。監査は始めていません。',
    action: '画面を読み込み直してから、もう一度開始してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したプロファイルでは、監査を始められません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、プロファイルが変更されました。監査は始めていません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度開始してください。',
  },
  // T27f（Task 27 の設計書 4.7）: 操作の候補の発見と READ の確かめは、認証つきの読み取りの監査のプロファイルだけで行う（公開の監査のプロファイルも
  // この理由になる）ので、説明を見直した。T28b（Task 28 の設計書 4.5）: 書き込みのモードのプロファイルでも、発見と READ の確かめを行えるようにした。
  MODE_NOT_EXECUTABLE: {
    description: 'このプロファイルの監査モードでは、この操作を始められません。承認した書き込みのモードのプロファイルでは、読み取りの監査（承認した書き込みの監査）は始められません。操作の候補の発見と READ の確かめは、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルだけで行えます。書き込み（登録と更新）は、承認した書き込みのモードのプロファイルだけで行えます。',
    action: '監査は、公開の監査（読むだけ）か、認証つきの読み取りの監査（ログインあり・読むだけ）のプロファイルで開始してください。操作の候補の発見と READ の確かめは、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルの詳細から始めてください。書き込みは、承認した書き込みのモードのプロファイルのシナリオから始めてください。',
  },
  TARGET_PATH_INVALID: {
    description: 'プロファイルが指す設定のファイルの場所を、受け付けません。',
    action: 'プロファイルの編集で、config/targets/ か local/targets/ の中の .json を選び直してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'プロファイルが指す設定のファイルを読めないか、その内容に誤りがあります。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度開始してください。',
  },
  PROFILE_INVALID: {
    description: '今の設定のファイルでは、プロファイルの内容に誤りがあります。',
    action: '表示された誤りを、プロファイルの編集で直してから、もう一度開始してください。',
  },
  JOB_ALREADY_ACTIVE: {
    description: 'ほかの監査のジョブが動いています。監査は、同時に 1 つだけ動かせます（サイトへの負荷を増やさないため）。',
    action: '実行履歴で、動いているジョブが終わるのを待つか、止めてから、もう一度開始してください。',
  },
  // T24h-4（DEF-061）: この画面のサーバが、画面のサーバを 1 つだけにするロックを失った（ほかの画面のサーバが取り直した）。
  CONTROL_INSTANCE_LOCK_LOST: {
    description: 'ほかの画面のサーバが動き始めたため、この画面のサーバでは監査を始められません。画面のサーバは、同時に 1 つだけ動かせます。',
    action: 'この画面のサーバを止めて、動いている画面のサーバを使ってください。',
  },
  // T25d（Task 25 の設計書 4.4、4.5）: 認証つきの読み取りの監査の開始の確かめ。
  // T26e: 自動ログインは方式として実行できるようになった（Windows だけであることは、資格情報の暗号化の確かめで決める）。今この理由になるのは、
  // ログインの確かめを自動ログインでないプロファイルで始めようとしたときと、監査モードに合わない認証の方式のとき。
  AUTH_STRATEGY_NOT_EXECUTABLE: {
    description: 'このプロファイルの認証の方式では、この操作を始められません。ログインの確かめは、認証の方式が自動ログインのプロファイルだけで行えます。',
    action: 'プロファイルの認証の方式を確かめてください。手動のログインのプロファイルは、「監査を始める」から始めてください。',
  },
  AUTH_SETUP_MISSING: {
    description: 'このプロファイルには、認証の設定がありません。監査は始めていません。',
    action: 'プロファイルの詳細から認証の設定を作ってから、もう一度開始してください。',
  },
  AUTH_SETUP_STALE: {
    description: '認証の設定を作った後に、プロファイルが変更されました。古い認証の設定では、監査を始めません。',
    action: '認証の設定を開いて、今のプロファイルで保存し直してから、もう一度開始してください。',
  },
  AUTH_SETUP_INVALID: {
    description: '今のプロファイルと設定のファイルでは、認証の設定に誤りがあります。監査は始めていません。',
    action: '認証の設定を開いて、誤りを直して保存してから、もう一度開始してください。',
  },
  // T26c（Task 26 の設計書 4.5 の開始の前の確かめ）: 自動ログインの資格情報と上限。T26e で文言を見直した（ログインの確かめと監査の両方で使う）。
  CREDENTIAL_MISSING: {
    description: 'このプロファイルには、自動ログインの資格情報が保存されていません。ログインは始めていません。',
    action: 'プロファイルの詳細から「資格情報」の画面を開き、テスト用のアカウントの資格情報を登録してから、もう一度始めてください。',
  },
  CREDENTIAL_STALE: {
    description: '保存した資格情報のログインの Origin が、今の認証の設定のログインの画面の Origin と違います。ログインは始めていません。',
    action: '「資格情報」の画面で、ユーザー名とパスワードの両方を入れ直してから、もう一度始めてください。',
  },
  CREDENTIAL_PROTECTION_UNAVAILABLE: {
    description: 'このコンピュータでは、資格情報の暗号化（Windows の DPAPI）を使えないため、自動ログインを始めません。Windows でない環境では、自動ログインは使えません。',
    action: '「環境の状態」の画面で、資格情報の暗号化の状態を確かめてください。Windows では、資格情報を保存したときと同じ Windows の利用者で、画面のサーバを動かしてください。',
  },
  AUTO_LOGIN_HELD: {
    description: '前の自動ログインが成功以外で終わったため、アカウントのロックを避けるために、このプロファイルの自動ログインを止めています。',
    action: `前のジョブの結果の案内に従って、テスト環境のアカウントと、資格情報と認証の設定を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  AUTO_LOGIN_RATE_LIMITED: {
    description: '自動ログインどうしの間隔、24 時間の回数の上限、またはサーバが示した待つ時間の中のため、まだ自動ログインを始められません（サイトに負荷をかけず、アカウントのロックを避けるため）。',
    action: '表示された「次に始められる日時」を過ぎてから、もう一度始めてください。',
  },
  // T27e（Task 27 の設計書 4.5、4.6）: READ の確かめを、定義が 1 件もないプロファイルで始めようとした（T27f で文言を見直した）。
  READ_CHECK_DEFINITIONS_MISSING: {
    description: 'このプロファイルには、READ の確かめの定義がありません（削除した定義は数えません）。READ の確かめは始めていません。サイトには接続していません。',
    action: '「READ の確かめ」の画面で、読み取り（READ）の候補を選び、送る値と期待を決めて保存してから、もう一度始めてください。候補がなければ、先に「操作の候補を探す」を行ってください。',
  },
  // T30e（Task 30 の設計書 3 章）: 書き込みのジョブの開始を拒む理由。画面の始める口は T30g。
  WRITE_GRANT_REJECTED: {
    description: '書き込みの実行の許可を使えませんでした（ない、使用済み、期限切れ、撤回された、承認のときと事実が変わったなど）。書き込みは送っていません。',
    action: 'シナリオの承認の状態を確かめ、必要なら承認し直してから、実行の許可を出し直して、もう一度始めてください。',
  },
  WRITE_DATA_NOT_GENERATED: {
    description: '送る値を作れませんでした（入力の規則が決まらない、一意にする組み合わせを使い切った、照合の READ に結び付ける値がないなど）。書き込みは送っていません。',
    action: 'シナリオの入力の規則と検証の指定を見直してから、実行の許可を出し直して、もう一度始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** 監査のジョブの停止を拒む理由ごとの説明と手順（理由の一覧は `AUDIT_JOB_STOP_REJECTION_REASONS`）。 */
export const AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS = deepFreeze({
  JOB_NOT_FOUND: {
    description: '対象のジョブが見つかりません。',
    action: '実行履歴を読み込み直して、対象を確かめてください。',
  },
  JOB_NOT_ACTIVE: {
    description: 'このジョブは、もう終わっています。',
    action: '画面を読み込み直して、今の状態を確かめてください。',
  },
  JOB_NOT_OWNED: {
    description: 'このジョブは、前に起動した画面のサーバのものなので、この画面からは止められません。',
    action: '画面を読み込み直してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 認証つきの監査で、設定のファイルの `crawl.allowedQueryParameters` に秘密に見える名前があって始めなかったときの案内（T25f round 1）。ワーカーは
 * 設定のエラー（`CONFIG_ERROR`）で終えるので、`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR` の手順に足す。
 */
export const AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION =
  '認証つきの監査では、設定のファイルの crawl.allowedQueryParameters に、秘密に見える名前（token、session、code、state など）を入れられません。';

/**
 * 監査のジョブの失敗と中断の理由ごとの説明と手順（理由の一覧は `src/control/job/job-records.ts` の `AUDIT_JOB_FAILURE_REASONS`。先頭の 6 つは
 * ワーカーが送る理由）。監査の外の失敗の文は、CLI と同じもの（`CLI_TEXT.failure`）を使う。
 */
export const AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS = deepFreeze({
  CONFIG_ERROR: {
    description: '設定のファイルに誤りがあるため、監査を始められませんでした。',
    action: `設定のファイルの内容を確かめてから、もう一度開始してください。${AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION}`,
  },
  ARTIFACT_WRITE_FAILED: {
    description: CLI_TEXT.failure.artifactWriteFailed,
    action: '出力先のフォルダの空きと書き込みの権限を確かめてから、もう一度開始してください。',
  },
  UNEXPECTED_FAILURE: {
    description: CLI_TEXT.failure.unexpected,
    action: `${AUDIT_JOB_RESUME_ACTION_TEXT}繰り返し起きる場合は、画面のサーバのコンソールを確かめてください。`,
  },
  PROTOCOL_VIOLATION: {
    description: '画面のサーバと監査のワーカーのやりとりの形が正しくなかったため、ワーカーを止めました。',
    action: `${AUDIT_JOB_RESUME_ACTION_TEXT}繰り返し起きる場合は、npm run build を実行してから、画面のサーバを起動し直してください。`,
  },
  START_TIMEOUT: {
    description: '監査のワーカーが、始める合図を、待つ時間の中に受け取れませんでした。',
    action: 'もう一度開始してください。',
  },
  // T24h-1 の M3: 開始の直前の検証の後に、ターゲット設定のファイルが変わった。
  CONFIG_CHANGED: {
    description: '開始の確かめの後に、ターゲット設定のファイルが変わったため、監査を始めませんでした。',
    action: '設定のファイルの内容を確かめてから、もう一度開始してください。',
  },
  WORKER_START_FAILED: {
    description: '監査のワーカーを起動できませんでした。',
    action: 'npm run build を実行してから、画面のサーバを起動し直してください（npm run ui は、ビルドしてから起動します）。',
  },
  WORKER_NOT_READY: {
    description: '監査のワーカーが、待つ時間の中に準備を終えませんでした。',
    action: 'もう一度開始してください。繰り返し起きる場合は、npm run build を実行してから、画面のサーバを起動し直してください。',
  },
  WORKER_EXITED: {
    description: '監査のワーカーが、結果を返す前に終わりました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  WORKER_UNRESPONSIVE: {
    description: '監査のワーカーが応答しなくなったため、止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  STOP_TIMEOUT: {
    description: '強制的に止める要求の後も終わらなかったため、監査のワーカーを止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  SERVER_RESTARTED: {
    description: '画面のサーバが、監査の途中で終わりました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  SERVER_SHUTDOWN: {
    description: '画面のサーバを終えるときに、待つ時間の中に監査が終わらなかったため、止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  // T25d（Task 25 の設計書 4.4）: ワーカーが `FAILED` で送る、認証つきの監査の理由（監査は始めていない）。
  AUTH_SETUP_CHANGED: {
    description: '開始の確かめの後に、認証の設定が変わったため、ログインも監査も始めませんでした。',
    action: '認証の設定を確かめてから、もう一度開始してください。',
  },
  AUTH_SETUP_REQUIRED: {
    description: 'ログインのブラウザが閉じられたか、ログインの画面を安全に開けなかったため、監査を始めませんでした。',
    action: '認証の設定（ログインの画面の URL など）を確かめてから、もう一度開始してください。',
  },
  UNSUPPORTED_AUTH_STATE: {
    description: 'ログインの後に、許可した Origin の Cookie も localStorage もなかったため、監査を始めませんでした。',
    action: 'この形のログイン（別の Origin のログインの画面など）には、まだ対応していません。認証の設定を確かめてください。',
  },
  LOGIN_TIMEOUT: {
    description: '決められた時間の中に、ログインが済まなかったため、監査を始めませんでした。',
    action: 'もう一度開始して、BeakSight が開いたブラウザでログインしてください。',
  },
  LOGIN_ATTEMPTS_EXCEEDED: {
    description: 'ログインの送信先への送信を止めたため、ログインを止めました。認証の設定の回数の上限を超えたか、BeakSight が扱えない形のログイン（JavaScript の fetch で送るログインなど）の可能性があります。監査は始めていません。',
    action: 'ログインの画面がフォームの送信（ページの移動）でログインするかを確かめてください。そうであれば、資格情報と認証の設定の回数の上限を確かめてから、もう一度開始してください。',
  },
  // T26c（Task 26 の設計書 4.5 の結果の閉じた一覧）: 自動ログインが成功以外で終わった。ログインを送った（か分からない）ときは、そのプロファイルの
  // 自動ログインを止めている。T26e で文言を見直した（人がすることを、手順の先頭に書く）。
  INVALID_CREDENTIALS: {
    description: 'ログインの画面が、資格情報の誤りを示しました。アカウントのロックを避けるため、このプロファイルの自動ログインを止めました。',
    action: `テスト環境で正しいユーザー名とパスワードを確かめ、「資格情報」の画面で変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  ACCOUNT_LOCKED: {
    description: 'ログインの画面が、アカウントのロックを示しました。このプロファイルの自動ログインを止めました。',
    action: `テスト環境の管理者に、アカウントのロックの解除を頼み、解除されたことを確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  MFA_REQUIRED: {
    description: 'ログインの後に、多要素認証（MFA）などの人の操作を求められました。BeakSight は、この操作をしません。このプロファイルの自動ログインを止めました。',
    action: `MFA のあるアカウントは、自動ログインに使えません。MFA を求めないテスト用のアカウントに変え、「資格情報」の画面で変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  CREDENTIAL_EXPIRED: {
    description: 'ログインの画面が、パスワードの期限切れを示しました。このプロファイルの自動ログインを止めました。',
    action: `テスト環境でパスワードを新しくしてから、「資格情報」の画面でパスワードを変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  RATE_LIMITED: {
    description: 'ログインの送信が、回数の制限（HTTP 429）で断られました。このプロファイルの自動ログインを止めました。',
    action: `時間をおいてください。サーバが示した日時を過ぎるまでは、停止を解いても自動ログインを始められません。テスト環境の状態を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  AUTH_RESULT_UNKNOWN: {
    description: 'ログインの結果を、認証の設定の条件で 1 つに決められませんでした（どの条件にも当たらない、2 つ以上に当たる、サーバの誤り、途中でワーカーが終わった、など）。このプロファイルの自動ログインを止めました。',
    action: `テスト環境でアカウントの状態を確かめ、認証の設定の成功の条件と失敗の条件（パスとセレクタ）を見直してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  LOGIN_FORM_INVALID: {
    description: 'ログインのフォームが、安全に値を入れられる形ではなかったため、値を入れずに止めました。ログインは送信していないので、自動ログインは止めていません。',
    action: '表示された理由を見て、認証の設定のセレクタと、ログインの送信先（POST のフォーム、送信先の Origin と path）を見直してください。',
  },
  LOGIN_FORM_INPUT_FAILED: {
    description: 'ログインのフォームに値を入れるか、送信するところで失敗しました。送信したかが分からないときは、このプロファイルの自動ログインを止めています。',
    action: `認証の設定のセレクタを見直してください。自動ログインを止めているときは、テスト環境のアカウントの状態を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  CREDENTIAL_CHANGED: {
    description: '開始の確かめの後に、保存した資格情報が変わったため、ログインを始めませんでした。ログインは送信していません。',
    action: '「資格情報」の画面で今の状態を確かめてから、もう一度始めてください。',
  },
  CREDENTIAL_UNAVAILABLE: {
    description: '保存した資格情報を戻せなかった（復号できなかった）ため、ログインを始めませんでした。ログインは送信していません。',
    action: '資格情報を保存したときと同じ Windows の利用者で、画面のサーバを動かしているかを確かめてください。直らない場合は、「資格情報」の画面で削除してから、登録し直してください。',
  },
  // T26g-1（設計書の変更履歴の「T26R」の行）: 送信の窓の中で、ページが許した送信のほかの要求を出そうとしたので止めた。
  UNEXPECTED_LOGIN_REQUEST: {
    description: 'ログインの画面が、入力した値を、許したログインの送信のほかの要求（画像、別のサイト、別のフォームなど）で送ろうとしたため、その要求を止めてログインを中止しました。値は送っていません。ログインを送った（か分からない）ときは、このプロファイルの自動ログインを止めています。',
    action: `ログインの画面が、入力の値を別の要求で送る作りになっていないかを確かめてください。BeakSight は、この形のログインを自動では扱えません。手動のログインに切り替えるか、ログインの画面を直してください。自動ログインを止めているときは、テスト環境のアカウントの状態も確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  // T27c（Task 27 の設計書の変更履歴「Blocker: T27c」の行の (2)）: ワーカーがまだ対応していない種類のジョブを受けたので、ログインも監査もせずに
  // 止めた（T27f で文言を見直した。画面のサーバとワーカーのビルドの版が合わないときに起きる）。
  JOB_KIND_NOT_SUPPORTED: {
    description: '監査のワーカーが、この種類のジョブに対応していなかったため、ログインも監査もせずに止めました。サイトには接続していません。画面のサーバと監査のワーカーのビルドの版が合っていない可能性があります。',
    action: 'npm run build を実行してから、画面のサーバを起動し直してください（npm run ui は、ビルドしてから起動します）。繰り返し起きる場合は、BeakSight の版を確かめてください。',
  },
  // T27d（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）: 発見のジョブの結果（`discovery.json`）を読めなかったので、候補の一覧を
  // 変えずに止めた（T27f で文言を見直した）。
  DISCOVERY_RESULT_INVALID: {
    description: '操作の候補の発見のジョブの結果のファイル（discovery.json）を読めないか、形が正しくなかったため、候補の一覧を変えずに止めました。',
    action: 'もう一度「操作の候補を探す」を始めてください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
  },
  // T27e（Task 27 の設計書 4.5）: READ の確かめのジョブの結果（`read-evidence.json`）を読めなかったので、結果を記録せずに止めた（T27f で文言を
  // 見直した）。
  READ_CHECK_RESULT_INVALID: {
    description: 'READ の確かめのジョブの結果のファイル（read-evidence.json）を読めないか、形が正しくなかったため、結果を記録せずに止めました。',
    action: 'もう一度「READ を確かめる」を始めてください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
  },
  // T30d（Task 30 の設計書 3 章の「記録」）: 書き込みのジョブ（`WRITE_CREATE`）の理由。始める口と画面は T30e・T30g。
  WRITE_GRANT_REJECTED: {
    description: '書き込みの実行の許可を使えなかった（撤回・期限切れ・承認のときと事実が変わったなど）ため、送らずに止めました。',
    action: 'シナリオの承認の状態を確かめ、必要なら承認し直してから、もう一度書き込みを始めてください。',
  },
  WRITE_RESULT_INVALID: {
    description: '書き込みのジョブの結果のファイル（action-run.json）を読めないか、形が正しくなかったため、結果を「分からない」として記録しました。登録されたかどうかは分かりません。',
    action: 'テスト環境で、登録されたかどうかを確かめてください。件数は使ったものとして数えています。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * READ の確かめの定義の保存を拒む理由（`src/control/read-check-policy.ts` の `READ_CHECK_DEFINITION_REJECTION_REASONS`。Task 27 の設計書 4.5。T27c）
 * ごとの説明と手順。書き漏れと余分は、画面の側で型で確かめる（T27f で文言を見直し、取り消したプロファイルの理由を足した）。画面の「削除」は、
 * 定義を一覧から外す操作（管理データの行は消さずに、取り消した時刻を書く）。
 */
export const READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS = deepFreeze({
  READ_CHECK_INPUT_INVALID: {
    description: 'READ の確かめの定義の形が正しくありません（期待がない、期待の種類が違う、数や文の長さ、件数の上限を超えている、など）。保存していません。',
    action: '期待の欄と送る値を見直してから、もう一度保存してください。',
  },
  READ_PARAMETER_SECRET_LIKE: {
    description: '秘密に見える名前（token、session、code、state、key など）の欄には、値を送りません。保存していません。',
    action: 'その欄の値を空にしてから、もう一度保存してください。この欄に値が要る画面は、READ の確かめに使えません。',
  },
  READ_PARAMETER_NOT_ALLOWED: {
    description: '値を送れるのは、対象の候補の、見えていて、読み取り専用でも無効でもない欄だけです（パスワードとファイルの欄は、名前にかかわらず送りません）。保存していません。',
    action: '最後の「操作の候補を探す」の結果で、欄が見えなくなったり、読み取り専用になったりしていないかを確かめ、送れる欄だけに値を入れてから、もう一度保存してください。',
  },
  READ_CANDIDATE_UNKNOWN: {
    description: '対象の候補が、最後の「操作の候補を探す」の結果にありません。保存していません。',
    action: '「操作の候補を探す」をもう一度行い、今の候補から選び直してください。',
  },
  READ_CANDIDATE_NOT_READ: {
    description: '対象の候補は、最後の「操作の候補を探す」の結果で、読み取り（READ）に分類されていません。READ の確かめには使えません。保存していません。',
    action: '読み取り（READ）に分類された候補を選んでください。',
  },
  READ_CHECK_LIMIT_EXCEEDED: {
    description: 'このプロファイルの READ の確かめの定義が、上限の数に達しています。保存していません。',
    action: '使わない定義を削除してから、もう一度保存してください。',
  },
  READ_CHECK_PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。保存していません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  READ_CHECK_NOT_FOUND: {
    description: '対象の READ の確かめの定義が見つかりません。',
    action: '定義の一覧を読み込み直して、対象を確かめてください。',
  },
  READ_CHECK_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、この定義が変わりました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
  READ_CHECK_CANCELED: {
    description: 'この定義は削除されています。変えられません。',
    action: '必要なら、新しい定義を作ってください。',
  },
  // T27f（T27c の申し送り 6）: 取り消したプロファイルでは、定義を作らない・変えない（削除はできる）。
  READ_CHECK_PROFILE_RETIRED: {
    description: '取り消したプロファイルでは、READ の確かめの定義を作ったり変えたりできません。保存していません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  // T27R-fix-1（DEF-088）: 送る値の名前か値が、発見の分類の危険な語（日本語を含む）に当たる。
  READ_PARAMETER_DANGEROUS_WORD: {
    description: '送る値の名前か値に、危険な語（削除、取り消し、一括、無効、解約、ログアウト、delete、cancel など）があります。この値は送りません。保存していません。',
    action: 'その欄の値を、危険な語を含まない値に変えるか、空にしてから、もう一度保存してください。',
  },
  // T28b fix round 1: READ の確かめを許さないモードのプロファイル（公開の監査）では、定義を作らない・変えない（削除はできる）。
  READ_CHECK_PROFILE_NOT_ELIGIBLE: {
    description: 'このプロファイルの監査モードでは、READ の確かめを使えません。READ の確かめは、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルだけで使えます。保存していません。',
    action: 'READ の確かめを使う場合は、テスト環境の、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルで定義を作ってください。',
  },
} as const satisfies Record<string, ControlReasonText>);

// ---------------------------------------------------------------------------------------------------------------
// 操作の候補の発見と READ の確かめ（ローカルの管理画面。Task 27 の設計書 4.3、4.5、4.7。T27f）
// 値の一覧と意味は `src/discovery/`（画面へは `src/control/discovery-view.ts` から公開し直す）が持ち、ここは文言だけを持つ。書き漏れと余分は、
// 画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。文言には、入力の値・トークン・選択肢の label を入れない。
// ---------------------------------------------------------------------------------------------------------------

/** 候補の分類の理由のコード（`CANDIDATE_REASON_CODES`）ごとの説明。 */
export const CANDIDATE_REASON_DESCRIPTIONS = deepFreeze({
  ACTION_OUTSIDE_ALLOWED_ORIGINS: '送信先が、プロファイルで許可した Origin の外か、送信先の Origin を読めません。',
  DESTRUCTIVE: '送り方が DELETE か、ボタンの文言・送信先・query の名前に、削除や取り消しなどの危険な語があります。',
  READ_GET_FORM: 'GET で送るフォームで、JavaScript の結び付きがありません。',
  GET_WITH_PASSWORD_FIELD: 'GET のフォームに、パスワードの欄があります（パスワードを URL に入れて送る形なので、扱いません）。',
  GET_WITH_MULTIPART: 'GET のフォームの送り方が、ファイルの送信（multipart）です。',
  POST_SEARCH: 'POST で送る検索や絞り込みです（POST で読む画面は、扱いません）。',
  GRAPHQL_ENDPOINT: '送信先が GraphQL への POST です。',
  JS_BOUND: 'フォームか送信のボタンに、JavaScript の処理（listener か inline の処理）が結び付いています。',
  JS_DELEGATED: '画面の全体（document・window）か祖先の要素に、押す・送る操作を受ける JavaScript の処理があります。',
  NO_KNOWN_ACTION: 'フォームの外のボタン（またはリセットのボタン）で、押したときの処理が分かりません。',
  DIALOG_METHOD: 'フォームの送り方が dialog で、サーバへ送りません。',
  METHOD_OVERRIDE_UNRECOGNIZED: '_method の欄の値が、PUT・PATCH・DELETE のどれでもないため、実際の送り方が決まりません。',
  UPDATE_METHOD: '実際の送り方が PUT か PATCH です。',
  UPDATE_WORD: '書き込みの送り方で、ボタンの文言か送信先に、更新・保存・編集などの語があります。',
  CREATE_WORD: '書き込みの送り方で、ボタンの文言か送信先に、登録・追加・作成などの語があります。',
  UNCLASSIFIED: '規則のどれにも当たりませんでした。',
  DUPLICATE_IDENTITY_CONFLICT: '同じ画面に、見分けのつかない（同じ識別の）候補が 2 つ以上あり、入力の規則などが違うため、1 つにまとめました。',
} as const satisfies Record<string, string>);

/** 発見のジョブで読まなかった画面の理由（`DISCOVERY_UNREAD_REASONS`）の表示の名前。 */
export const DISCOVERY_UNREAD_REASON_LABELS = deepFreeze({
  EXCLUDED: '読まないパス・読む範囲の外・危険な語（設定どおり）',
  MAX_DEPTH_REACHED: '深さの上限',
  NAVIGATION_FAILED: '読み込みの失敗',
  MAX_PAGES_REACHED: 'ページの上限',
  MAX_RUNTIME_REACHED: '時間の上限',
  STOPPED: '止める要求',
  AUTH_SESSION_LOST: 'ログインの状態の切れ',
  SAFETY_VIOLATION: '安全の決まりの違反',
  PREFLIGHT_FAILED: '始める前の確認の失敗',
} as const satisfies Record<string, string>);

/** 発見で画面を読み切れなかった理由（`INCOMPLETE_REASONS`。候補の契約の値）の説明。 */
export const DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS = deepFreeze({
  INCOMPLETE_SETTLE_TIMEOUT: '待つ時間の上限までに、画面の表示が落ち着きませんでした（後から表示される候補があるかもしれません）。',
  INCOMPLETE_FRAME_OR_CLOSED_SHADOW: '画面の中の枠（iframe）か、閉じた shadow root の中は読みません（その中の候補は示しません）。',
  INCOMPLETE_FREEZE_UNAVAILABLE: '画面を止めてから読む条件がそろわなかったため、読んでいません。',
  INCOMPLETE_READ_FAILED: '画面を読む途中で失敗したか、読む間に画面が変わりました。',
  INCOMPLETE_LIMIT_REACHED: '要素・候補・欄などの数か、URL の長さの上限に達したため、読めた分だけを示します。',
} as const satisfies Record<string, string>);

/** READ の確かめの結果の詳しい理由（`READ_CHECK_DETAILS`）の説明。 */
export const READ_CHECK_DETAIL_DESCRIPTIONS = deepFreeze({
  EXPECTATIONS_EVALUATED: '読んで、期待と照らしました。',
  TARGET_PAGE_UNKNOWN: '対象の候補がどの画面にあるかが分かりません（最後に見た発見の結果を読めませんでした）。',
  TARGET_PAGE_UNREADABLE: '対象の候補の画面を読めませんでした（読み込みの失敗、HTTP の誤り、画面を止める条件、表示が落ち着かない、など）。',
  CANDIDATE_NOT_FOUND: '対象の候補の画面を読みましたが、同じ候補がありませんでした。',
  CANDIDATE_NOT_READ: '対象の候補の今の分類が、読み取り（READ）ではありません。',
  SECRET_LIKE_PARAMETER: '送る値に、秘密に見える名前の欄があります。',
  // T27R-fix-1（DEF-088）: 保存の後に残った定義も、実行の前の確かめで止める。
  PARAMETER_DANGEROUS_WORD: '送る値の名前か値に、危険な語（削除、取り消し、一括、無効、delete、cancel など）があったため、読みませんでした。',
  // CCX-10: 保存の後に、欄が見えなくなった・読み取り専用になった・無効になった（実行の前の確かめ直しで止めた）。
  PARAMETER_NOT_SENDABLE: '送る値の欄が、今の画面では値を送れない欄（見えない、読み取り専用、無効、パスワード、ファイル）になっていました。',
  URL_NOT_BUILT: '送る URL を組み立てられませんでした（送信先が候補の Origin の外になる、長さの上限、など）。',
  REQUEST_POLICY: '要求の判定（読まないパス、危険な語、許可した Origin、ログインの画面）で止めました。',
  NAVIGATION_FAILED: '送った URL の読み込みが失敗しました（時間切れ、接続の失敗、外部への移動の遮断など）。',
  HTTP_ERROR_STATUS: '送った URL の応答が、HTTP の誤り（4xx・5xx）でした。',
  RESULT_PAGE_UNREADABLE: '送った URL は読み込めましたが、結果の構造を読めませんでした。',
  SESSION_LOST: '送った URL の読み込みで、ログインの状態が切れていました。',
} as const satisfies Record<string, string>);

/** 期待と照らせなかった理由（`READ_EXPECTATION_UNDETERMINED_REASONS`）の説明。 */
export const READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS = deepFreeze({
  STRUCTURE_NOT_FOUND: '数える表・一覧か、詳細（dl）が、主な領域にありません。',
  STRUCTURE_AMBIGUOUS: '数える表・一覧が 2 つ以上あるか、同じ名前の詳細の項目が 2 つ以上あり、どれを照らすか決められません。',
  STRUCTURE_LIMIT_REACHED: '読む上限（要素・構造の数、文字の長さ）に達し、読み切れませんでした。',
  PAGE_NOT_SETTLED: '待つ時間の上限までに、画面の表示が落ち着きませんでした。',
} as const satisfies Record<string, string>);

/** 行を数えた構造（`READ_ROW_SOURCES`）の表示の名前。 */
export const READ_ROW_SOURCE_LABELS = deepFreeze({
  TABLE: '表',
  LIST: '一覧',
} as const satisfies Record<string, string>);

/** ローカルの管理画面の、操作の候補の画面の文言（Task 27 の設計書 4.7。T27f）。 */
export const LOCAL_UI_DISCOVERY_TEXT = deepFreeze({
  pages: {
    discovery: '操作の候補',
  },
  profileDetail: {
    heading: '操作の候補と READ の確かめ',
    body: 'ログインの後に管理画面を読むだけで、フォームとボタンを操作の候補として集め、分類します。読み取り（READ）の候補は、送る値と期待を決めて確かめられます。どちらも、書き込みはしません。',
    openDiscovery: '操作の候補を開く',
    openReadChecks: 'READ の確かめを開く',
  },
  heading: '操作の候補を探す',
  guidance: 'BeakSight がログインしてから、認証の設定の読む範囲の管理画面を読むだけで、フォームとボタンを集めて分類します。送信や書き込みはしません。読み込みの間隔とページの上限は、設定のファイルの値です。',
  submit: '操作の候補を探す',
  submitting: '始めています…',
  cannotStartHeading: 'このプロファイルでは、今は操作の候補を探せません',
  rejectedHeading: '操作の候補を探すジョブを始められませんでした',
  notEligible: '操作の候補の発見は、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルだけで行えます。',
  latestHeading: '最後の発見',
  noDiscovery: 'まだ発見の記録はありません。「操作の候補を探す」から始めます。',
  latestJob: 'ジョブ',
  latestRecordedAt: '記録した日時',
  endReason: '終わり方',
  runStatus: 'Run の状態',
  pagesRead: '読んだ画面',
  pagesNotRead: '読まなかった画面',
  maxPages: 'ページの上限',
  unreadReasonsHeading: '読まなかった理由',
  incompletePagesHeading: '読み切れなかった画面',
  resultUnavailable: '最後の発見の結果のファイル（discovery.json）を読めないため、候補の詳しい内容は示せません。',
  candidatesHeading: '候補',
  noCandidates: '候補はありません。',
  pageHeading: '画面',
  originUnknown: 'Origin 不明',
  columns: {
    kind: '種類',
    classification: '分類',
    reason: '分類の理由',
    drift: 'ドリフト',
    method: '送り方',
    action: '送信先',
    stateField: '状態の欄',
    execution: 'この画面からの実行',
  },
  stateFieldMarked: '状態の欄あり（active・status・deleted・非表示・停止・取消・del_flg など）',
  stateFieldNone: 'なし',
  readCheckable: 'READ の確かめに使える',
  notExecutable: 'この画面からは実行できない',
  createReadCheck: 'READ の確かめを作る',
  methodOverride: (formMethod: string, override: string): string => `${formMethod}（_method: ${override}）`,
  noAction: 'なし（フォームの外のボタン）',
  detailSummary: '詳しい内容',
  detailUnavailable: 'この候補を最後に見た発見の結果のファイルを読めないため、詳しい内容は示せません。',
  // T27R-fix-1（DEF-086）: 候補はボタンの文言を持たず、文言が当たった分類の語だけを持つ。
  submitterWords: 'ボタンの分類の語',
  /** ボタンの分類の語の表示（一覧の区切りで並べる。0 件なら「分類の語なし」）。 */
  submitterWordsValue: (words: readonly string[]): string => (words.length === 0 ? '分類の語なし' : listText(words)),
  enctype: '送り方の形（enctype）',
  target: '開く先（target）',
  queryNames: '送信先の query の名前',
  listeners: 'JavaScript の結び付き',
  inlineHandler: 'inline の処理あり',
  noListeners: 'なし',
  firstSeenAt: '最初に見た日時',
  lastSeenAt: '最後に見た日時',
  fieldsHeading: '入力の欄',
  noFields: '入力の欄はありません。',
  fieldColumns: {
    name: '名前',
    type: '型',
    flags: '属性',
    constraints: '制約',
    options: '選択肢の値',
    sendable: '値を送れるか',
  },
  unnamedField: '（名前なし）',
  flags: {
    required: '必須',
    readonly: '読み取り専用',
    disabled: '無効',
    hidden: '見えない',
  },
  noFlags: 'なし',
  noConstraints: 'なし',
  noOptions: 'なし',
  optionsOmitted: (countText: string): string => `ほか ${countText}`,
  optionsHidden: '示しません（見えない欄か、秘密に見える名前の欄）',
  sendableYes: '送れる',
  sendableNo: '送れない',
  secretLikeField: '秘密に見える名前（値は送りません）',
  openJob: 'ジョブを開く',
  openReadChecks: 'READ の確かめを開く',
  backToProfile: 'プロファイルに戻る',
  /** ジョブの画面の、発見と READ の確かめのジョブの欄（進み具合を送らない。T27d の申し送り 5）。 */
  job: {
    noProgress: 'このジョブは進み具合を送りません。ジョブの種類と状態だけを示します。',
    openDiscovery: '操作の候補を開く',
    openReadChecks: 'READ の確かめの結果を開く',
    downloadDiscoveryJson: 'discovery.json をダウンロードする',
    downloadReadEvidenceJson: 'read-evidence.json をダウンロードする',
  },
} as const);

/** ローカルの管理画面の、READ の確かめの画面の文言（Task 27 の設計書 4.5、4.7。T27f）。 */
export const LOCAL_UI_READ_CHECK_TEXT = deepFreeze({
  pages: {
    readChecks: 'READ の確かめ',
    newReadCheck: 'READ の確かめを作る',
    editReadCheck: 'READ の確かめを変える',
  },
  heading: 'READ を確かめる',
  guidance: 'BeakSight がログインしてから、保存した定義ごとに、送る値で GET の URL を組み立てて読み、結果を期待と照らします。フォームの送信や書き込みはしません。',
  valuesNote: '送る値は、テスト環境のテスト用の値だけにしてください。値は管理データにそのまま保存し、この画面に表示します。秘密に見える名前の欄には、値を送りません。',
  submit: 'READ を確かめる',
  submitting: '始めています…',
  cannotStartHeading: 'このプロファイルでは、今は READ を確かめられません',
  rejectedHeading: 'READ の確かめを始められませんでした',
  notEligible: 'READ の確かめは、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルだけで行えます。',
  retired: '取り消したプロファイルでは、定義を作ったり変えたりできません。',
  definitionsHeading: '定義',
  noDefinitions: 'まだ定義はありません。下の読み取り（READ）の候補から作ります。',
  definitionCount: (countText: string, maxText: string): string => `${countText}（上限 ${maxText}）`,
  candidatesHeading: '読み取り（READ）の候補',
  candidatesNote: '最後の「操作の候補を探す」の結果のうち、READ の確かめに使える候補です。',
  noCandidates: 'READ の確かめに使える候補はありません。先に「操作の候補を探す」を行ってください。',
  candidateMissing: '対象の候補が、最後の「操作の候補を探す」の結果にありません。この定義は変えられません（削除はできます）。',
  columns: {
    page: '画面',
    action: '送信先',
    submitterWords: 'ボタンの分類の語',
    parameters: '送る値',
    expectations: '期待',
    revision: '版',
    updatedAt: '最後に変えた日時',
    operations: '操作',
  },
  noParameters: 'なし',
  create: 'この候補で作る',
  edit: '変える',
  remove: '削除',
  formHeading: '定義',
  parametersHeading: '送る値',
  parametersNote: '値を入れた欄だけを送ります。空の欄は送りません。値を送れるのは、見えていて、読み取り専用でも無効でもない欄だけです（パスワードとファイルの欄は送りません）。',
  noSendableFields: 'この候補には、値を送れる欄がありません（送る値なしで読みます）。',
  optionsHint: (valuesText: string): string => `選べる値: ${valuesText}`,
  secretLikeHint: '秘密に見える名前の欄です。値を入れても送れません（保存のときに拒みます）。',
  expectationsHeading: '期待',
  /** 期待の数の説明（`maxText` は `formatCount` の結果（単位つき））。 */
  expectationsNote: (maxText: string): string => `1 件以上、${maxText}まで。すべての期待が一致すると「一致」になります。`,
  expectationKind: '期待の種類',
  expectationCount: '行の数',
  expectationText: '含む文',
  expectationField: '詳細の項目の名前',
  expectationValue: '詳細の項目の値',
  addExpectation: '期待を足す',
  removeExpectation: 'この期待を外す',
  expectationNumber: (numberText: string): string => `期待 ${numberText}`,
  save: '保存する',
  saving: '保存しています…',
  saved: '保存しました。',
  removed: '削除しました。',
  saveRejectedHeading: '保存できませんでした',
  removeRejectedHeading: '削除できませんでした',
  reload: '読み込み直す',
  removeDialog: {
    title: 'この定義を削除しますか',
    body: '定義を一覧から外し、READ の確かめで読まないようにします。前の結果の記録は残ります。元に戻すときは、作り直してください。',
    confirm: '削除する',
    cancel: 'やめる',
  },
  resultsHeading: '結果',
  noResults: 'まだ結果はありません。',
  resultsJob: (jobText: string): string => `ジョブ ${jobText}`,
  endReason: '終わり方',
  recordedAt: '記録した日時',
  openEvidence: 'read-evidence.json をダウンロードする',
  evidenceUnavailable: 'このジョブの結果のファイル（read-evidence.json）を読めないため、詳しい理由と期待ごとの結果は示せません。',
  resultColumns: {
    definition: '定義',
    revision: '版',
    result: '結果',
    detail: '詳しい理由',
    httpStatus: 'HTTP の状態',
    expectations: '期待ごとの結果',
  },
  notExecuted: '確かめなかった定義',
  observedRowCount: (countText: string, sourceText: string): string => `数えた行 ${countText}（${sourceText}）`,
  found: '含んでいた',
  notFound: '含んでいなかった',
  observedValue: (valueText: string): string => `取れた値: ${valueText}`,
  observedNone: '取れた値なし',
  definitionRemoved: '削除した定義',
  backToList: 'READ の確かめに戻る',
  openDiscovery: '操作の候補を開く',
} as const);

// ---------------------------------------------------------------------------------------------------------------
// シナリオの承認（ローカルの管理画面。Task 28 の設計書 4.1、4.6、4.7。T28e）
// 値の一覧と意味は `src/control/approval/`（画面へは `src/control/approval-view.ts` から公開し直す）と画面のサーバが持ち、ここは文言だけを持つ。
// 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。文言には、入力の値・トークン・hidden の値・
// 選択肢の label を入れない。
// ---------------------------------------------------------------------------------------------------------------

/** シナリオの下書きを拒む理由（`src/control/approval/scenario-policy.ts` の `SCENARIO_DRAFT_REJECTION_REASONS`）ごとの説明と手順。 */
export const SCENARIO_DRAFT_REJECTION_DESCRIPTIONS = deepFreeze({
  SCENARIO_INPUT_INVALID: {
    description: 'シナリオの入力の形が正しくありません（項目の過不足、型、件数と長さの上限、重複、上限と期限の最小など）。保存していません。',
    action: '画面を読み込み直して、入力を見直してから、もう一度保存してください。',
  },
  SCENARIO_CANDIDATE_UNKNOWN: {
    description: '対象の候補が、最後の「操作の候補を探す」の結果にありません。保存していません。',
    action: '「操作の候補を探す」をもう一度行い、今の候補から作り直してください。',
  },
  SCENARIO_CANDIDATE_NOT_WRITABLE: {
    description: '対象の候補は、登録（CREATE）か更新（UPDATE）に分類されていません。シナリオは、登録か更新の候補からだけ作れます。保存していません。',
    action: '登録（CREATE）か更新（UPDATE）に分類された候補を選んでください。',
  },
  SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED: {
    description:
      '対象の候補の送り方が、シナリオで扱う形（送信先と enctype のある POST の form。_method の上書きは PUT と PATCH だけ）ではありません。保存していません。',
    action: 'この候補は、シナリオにできません。',
  },
  SCENARIO_FIELD_SECRET_LIKE: {
    description: '秘密に見える名前（token、session、code、state、key など）の欄には、値を送りません。保存していません。',
    action: 'その欄を、送る欄から外してください。',
  },
  SCENARIO_FIELD_DANGEROUS_WORD: {
    description: '欄の名前に、危険な語（削除、取り消し、一括、無効、delete、cancel など）があります。この欄には値を送りません。保存していません。',
    action: 'その欄を、送る欄から外してください。',
  },
  // DEF-094: 名前にかかわらず、パスワードの欄とファイルの欄には値を送らない。
  SCENARIO_FIELD_TYPE_NOT_SENDABLE: {
    description: 'パスワードの欄とファイルの欄には、名前にかかわらず値を送りません。保存していません。',
    action: 'その欄を、送る欄から外してください。',
  },
  SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT: {
    description:
      '登録の画面の、見えていて操作できる選択の欄（プルダウンなど）・スライダー・色の欄を送る欄に選ばないと、ブラウザが画面の既定の値で送るので、送る前に中身を確かめられません。保存していません。',
    action: 'その欄を、送る欄に選んでください。',
  },
  SCENARIO_FIELD_NOT_ALLOWED: {
    description:
      '値を送れるのは、対象の候補の、見えていて、読み取り専用でも無効でもない欄だけです（パスワードとファイルの欄を除きます。_method の欄も送りません）。保存していません。',
    action: '最後の「操作の候補を探す」の結果で欄が変わっていないかを確かめ、送れる欄だけを選んでください。',
  },
  // T31b（Task 31 の設計書 3 章の「UPDATE の指定」）: UPDATE の指定の理由（文言の確かめは T31h）。
  SCENARIO_UPDATE_SPEC_MISSING: {
    description: 'UPDATE の候補のシナリオには、UPDATE の指定（台帳の参照、path の型、保つ欄）が要ります。保存していません。',
    action: 'UPDATE の指定を入れてから、もう一度保存してください。',
  },
  SCENARIO_UPDATE_SPEC_NOT_ALLOWED: {
    description: 'CREATE の候補のシナリオは、UPDATE の指定を持てません。保存していません。',
    action: 'UPDATE の指定を外してから、もう一度保存してください。',
  },
  SCENARIO_UPDATE_TARGET_NOT_FOUND: {
    description: '台帳の参照に選んだシナリオが、このプロファイルにありません。保存していません。',
    action: '画面を読み込み直して、このプロファイルの CREATE のシナリオから選び直してください。',
  },
  SCENARIO_UPDATE_TARGET_NOT_CREATE: {
    description: '台帳の参照には、このシナリオでない CREATE のシナリオだけを選べます。保存していません。',
    action: 'CREATE のシナリオから選び直してください。',
  },
  SCENARIO_UPDATE_PATH_MISMATCH: {
    description: 'path の型の {id} に候補の画面の値を入れても、更新の画面と送信先の path の両方に、同じ値で戻りません。保存していません。',
    action: '候補の更新の画面と送信先の path を確かめて、レコードの ID の位置だけを {id} にしてください。',
  },
  SCENARIO_UPDATE_RECORD_ID_UNSAFE: {
    description: 'path の型の {id} の位置の値が、レコードの ID として受ける形ではありません。保存していません。',
    action: 'レコードの ID の位置を確かめて、path の型を直してください。',
  },
  // T31R-fix-1 の I-2。
  SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID: {
    description: 'path の型の {id} の位置が、台帳（参照した登録のシナリオ）の登録の ID の取り方に合いません。登録の ID の型を使うときは {id} の前の区切りが同じ、要素から取るときは {id} が送信先の最後の区切りである必要があります。保存していません。',
    action: '台帳の登録の ID の取り方に合う path の型（同じ種類のレコードの ID の区切り）を選んでください。',
  },
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD: {
    description: '更新の画面に、秘密に見える名前の見える欄があります。値を読めないので、この画面は更新に使えません。保存していません。',
    action: 'テスト環境の画面の欄を確かめてください。この画面では UPDATE のシナリオを作れません。',
  },
  // T31e fix round 1（文言の確かめは T31h）。
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD: {
    description: '更新の画面に、状態を表す名前で、秘密にも見える名前の、見えない欄（hidden・readonly など）があります。値を読めず、更新の前と後で照らせないので、この画面は更新に使えません。保存していません。',
    action: 'テスト環境の画面の欄を確かめてください。この画面では UPDATE のシナリオを作れません。',
  },
  SCENARIO_STATE_FIELD_NOT_CHANGEABLE: {
    description: '状態の欄（有効・無効、公開、削除の印など）は、変える欄にできません（保つ欄だけにできます）。保存していません。',
    action: 'その欄を、変える欄から保つ欄に移してください。',
  },
  // T31R2-fix-1（DEF-108 の残り）。
  SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD: {
    description: 'この画面には、秘密に見える名前の見えない欄・読み取り専用の欄（CSRF のトークンなど、ページが作る値の名前のほか）があります。値を読めず、送る中身を照らせないので、この画面には書き込めません。保存していません。',
    action: 'テスト環境の画面から、その欄をなくすか、名前を変えてから、操作の候補を探し直してください。',
  },
  // T31R-fix-1 の I-1。
  SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE: {
    description: '削除・取り消し・無効化・締め出しの語に当たる名前の欄（削除の印、ごみ箱、退会、ロックなど）は、変える欄にできません（保つ欄だけにできます）。保存していません。',
    action: 'その欄を、変える欄から保つ欄に移してください。',
  },
  SCENARIO_UPDATE_FIELD_ROLE_OVERLAP: {
    description: '同じ欄が、変える欄と保つ欄の両方に入っています。保存していません。',
    action: 'その欄を、どちらか一方だけに入れてください。',
  },
  SCENARIO_UPDATE_FIELD_ROLE_MISSING: {
    description: '見えていて編集できる欄は、すべて変える欄か保つ欄のどちらかにする必要があります。保存していません。',
    action: 'その欄を、変える欄か保つ欄に入れてください。',
  },
  SCENARIO_UPDATE_NO_CHANGED_FIELD: {
    description: 'UPDATE のシナリオには、変える欄が 1 つ以上要ります。保存していません。',
    action: '変える欄を 1 つ以上選んでください。',
  },
  SCENARIO_READ_CHECK_NOT_FOUND: {
    description: '照らす READ の確かめの定義が、このプロファイルにありません。保存していません。',
    action: '画面を読み込み直して、今の定義から選び直してください。',
  },
  SCENARIO_READ_CHECK_CANCELED: {
    description: '照らす READ の確かめの定義は、削除されています。保存していません。',
    action: '画面を読み込み直して、今の定義から選び直してください。',
  },
  SCENARIO_READ_CHECK_REVISION_MISMATCH: {
    description: '照らす READ の確かめの定義が、この画面を開いた後に変わりました。保存していません。',
    action: '画面を読み込み直して、今の版を選び直してください。',
  },
  // T30a（Task 30 の設計書 3 章の「検証の指定」）: 検証の指定の理由。
  SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS: {
    description: '成功の条件と入力の誤りの条件が、同じ画面に同時に当たることがあります（path の前方一致が同じで、セレクタも同じか、どちらかにありません）。保存していません。',
    action: 'どちらかの条件の path かセレクタを変えて、2 つの条件が同じ画面に当たらないようにしてから、もう一度保存してください。',
  },
  SCENARIO_VERIFICATION_PARAMETER_UNKNOWN: {
    description: '照合の READ で生成した値に結び付けた送る値が、READ の定義の今の版にありません。保存していません。',
    action: 'READ の定義の送る値の名前を確かめて、結び付けを直してから、もう一度保存してください。',
  },
  SCENARIO_VERIFICATION_FIELD_NOT_SENT: {
    description: '照合の READ の結び付けか期待に使った欄が、シナリオの送る欄にありません（生成した値がありません）。保存していません。',
    action: '送る欄に加えるか、照合の READ の欄を直してから、もう一度保存してください。',
  },
  SCENARIO_LIMIT_ABOVE_DEFAULT: {
    description: '上限が、既定の件数を超えています。シナリオの上限は、既定以下だけにできます。保存していません。',
    action: '上限を、欄の説明にある既定以下にしてください。',
  },
  SCENARIO_LIMIT_INCONSISTENT: {
    description: '1 回の Run の上限が、累積の上限を超えています。保存していません。',
    action: '1 回の Run の上限を、累積の上限以下にしてください。',
  },
  SCENARIO_TTL_ABOVE_DEFAULT: {
    description: '承認の期限の日数が、既定の日数を超えています。保存していません。',
    action: '期限の日数を、欄の説明にある既定以下にしてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * シナリオの画面の要求（作成・変更・承認・撤回）を拒む理由ごとの説明と手順。理由の一覧は、保存の部品の
 * `SCENARIO_STORE_REJECTION_REASONS`（`src/control/approval/scenario-store.ts`）と、画面のサーバの理由
 * （`apps/local-ui/src/server/scenario-facts.ts` の `SCENARIO_REQUEST_LOCAL_REJECTION_REASONS`）。
 */
export const SCENARIO_REQUEST_REJECTION_DESCRIPTIONS = deepFreeze({
  SCENARIO_PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。何も変えていません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  SCENARIO_PROFILE_RETIRED: {
    description: '取り消したプロファイルでは、シナリオを作ったり変えたりできません。何も変えていません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  SCENARIO_MODE_NOT_WRITE: {
    description: 'シナリオは、承認した書き込みのモード（TEST_APPROVED_WRITE）のプロファイルだけで使えます。何も変えていません。',
    action: 'テスト環境の、承認した書き込みのモードのプロファイルで作ってください。',
  },
  SCENARIO_DISCOVERY_NOT_LATEST: {
    description: '最後の「操作の候補を探す」の結果を読めないか、まだ発見の記録がありません。保存していません。',
    action: '「操作の候補を探す」を行ってから、もう一度保存してください。',
  },
  SCENARIO_CANDIDATE_NOT_FOUND: {
    description:
      '対象の候補が、最後の「操作の候補を探す」の結果にないか、そこで確かめられません（消えた、読み直していない、入力の規則か分類が変わった）。保存していません。',
    action: '「操作の候補を探す」をもう一度行い、今の候補から作り直してください。',
  },
  SCENARIO_DRAFT_INVALID: {
    description: '入力に誤りがあります。保存していません。',
    action: '項目ごとの理由を見て直してから、もう一度保存してください。',
  },
  SCENARIO_NOT_FOUND: {
    description: '対象のシナリオが見つかりません。何も変えていません。',
    action: 'シナリオの一覧を読み込み直して、対象を確かめてください。',
  },
  SCENARIO_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、このシナリオが変わりました。何も変えていません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度操作してください。',
  },
  SCENARIO_APPROVAL_DIGEST_MISMATCH: {
    description: '画面が古いため、承認していません（この画面を開いた後に、承認を縛る内容が変わりました）。',
    action: '画面を読み込み直して、今の内容と差分を確かめてから、もう一度承認してください。',
  },
  SCENARIO_SIDE_EFFECTS_UNCONFIRMED: {
    description: '副作用の確認に、まだ確かめていない項目があります。承認していません。',
    action: 'シナリオを変えて、副作用の確認の 4 項目をすべて確かめてから、もう一度承認してください。',
  },
  SCENARIO_NOT_APPROVABLE: {
    description: '今の事実では、承認できません。承認していません。',
    action: '理由を見て、候補、照らす READ の定義、プロファイルを確かめてください。候補が変わったときは、「操作の候補を探す」をもう一度行い、作り直してください。',
  },
  SCENARIO_NOT_APPROVED: {
    description: '撤回する承認がありません（承認していないか、もう撤回しています）。何も変えていません。',
    action: '画面を読み込み直して、今の状態を確かめてください。',
  },
  SCENARIO_FACTS_CHANGED: {
    description: '確かめている間に、「操作の候補を探す」の結果が記録されました。何も変えていません。',
    action: '画面を読み込み直してから、もう一度操作してください。',
  },
  SCENARIO_INPUT_RULES_NOT_LATEST: {
    description: '付けようとした入力の規則が、このシナリオの入力の規則の最新の版ではありません。シナリオは変えていません。',
    action: '入力の規則の画面を読み込み直して、最新の版を確かめてから、もう一度保存してください。',
  },
  // T31b: UPDATE の指定の前に保存した UPDATE の版（文言の確かめは T31h）。
  SCENARIO_UPDATE_SPEC_MISSING: {
    description: 'この UPDATE のシナリオの版には、UPDATE の指定がありません。承認していません。',
    action: 'シナリオを編集して UPDATE の指定を入れ、保存してから承認してください。',
  },
  SCENARIO_FACTS_UNAVAILABLE: {
    description: 'プロファイルが指す設定のファイルか、資格情報の版を読めないため、承認の状態を確かめられません。承認・撤回はしていません。',
    action: '設定のファイルの場所と中身（自動ログインなら資格情報の画面）を確かめてから、もう一度操作してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、シナリオの画面の文言（Task 28 の設計書 4.6。T28e）。 */
export const LOCAL_UI_SCENARIO_TEXT = deepFreeze({
  pages: {
    scenarios: 'シナリオ',
    newScenario: 'シナリオを作る',
    scenario: 'シナリオの詳細',
    editScenario: 'シナリオを変える',
  },
  profileDetail: {
    heading: '書き込みのシナリオ',
    body:
      '登録（CREATE）・更新（UPDATE）の候補を、送る欄・上限・期限・副作用の確認と合わせて「シナリオ」にし、内容を確かめて承認します。承認だけでは、書き込みは始まりません。書き込みは、承認の後に、シナリオの詳細から開く「書き込みを始める」の画面で、人が 1 件ずつ始めます。',
    open: 'シナリオを開く',
  },
  notEligible: 'シナリオは、承認した書き込みのモード（TEST_APPROVED_WRITE）のプロファイルだけで使えます。',
  retired: '取り消したプロファイルでは、シナリオを作ったり、変えたり、承認したりできません（記録は見られます）。',
  noExecution:
    'この画面からは、書き込みを実行しません。承認は、書き込みを許す条件（版、上限、期限、副作用の確認、検証の指定）を記録するだけです。書き込みは、承認の後に、「書き込みを始める」の画面から人が始めます。',
  listHeading: 'シナリオ',
  noScenarios: 'まだシナリオはありません。「操作の候補」の画面の、登録（CREATE）・更新（UPDATE）の候補の「シナリオを作る」から作ります。',
  columns: {
    kind: '種類',
    page: '画面',
    action: '送信先',
    state: '状態',
    expiresAt: '承認の期限',
    limits: '上限と使った件数',
    revision: '版',
    operations: '操作',
    /** T29e: 入力の規則の状態。 */
    inputRules: '入力の規則',
  },
  /** 上限と使った件数（`perRunText`・`usedText`・`cumulativeText` は `formatCount` の結果）。 */
  limitsValue: (perRunText: string, usedText: string, cumulativeText: string): string =>
    `1 回の Run ${perRunText}・累積 ${usedText} / ${cumulativeText}`,
  usedNote: '使った件数は、予約中・送った・送ったか分からない予約の件数の合計です（送る前に返した予約は数えません）。',
  /** シナリオの版の表示（`revisionText` は `formatInteger` の結果）。 */
  revisionValue: (revisionText: string): string => `版 ${revisionText}`,
  noExpiry: 'なし（承認していません）',
  open: '開く',
  createFromCandidate: 'シナリオを作る',
  factsUnavailable: 'プロファイルが指す設定のファイルか資格情報の版を読めないため、承認の状態を確かめられません。',
  // 作成と変更のフォーム。
  targetHeading: '対象の候補',
  formHeading: '内容',
  fieldsHeading: '送る欄',
  fieldsNote:
    '値を送る欄を選びます。選べるのは、候補の、見えていて、読み取り専用でも無効でもない欄だけです。秘密に見える名前と危険な語の欄は選べません（理由を示します）。送る値の作り方（入力の規則）は、保存した後に、シナリオの詳細の「入力の規則を開く」から決めます。',
  noFields: '値を送れる欄はありません。',
  readChecksHeading: '照らす READ の定義',
  readChecksNote:
    '承認を縛る READ の確かめの定義を選びます（任意）。選んだ定義が変わると、再承認が要ります。書き込みの後に読むのは、下の検証の指定の「照合の READ」の定義で、ここで選んだ定義は読みません。',
  noReadChecks: 'このプロファイルには、READ の確かめの定義がありません。',
  /** 照らす READ の定義の選択肢（`revisionText` は `formatInteger` の結果）。 */
  readCheckOption: (readCheckId: string, revisionText: string): string => `${readCheckId}（版 ${revisionText}）`,
  limitsHeading: '上限',
  perRunLimit: '1 回の Run の上限（件）',
  cumulativeLimit: '累積の上限（件）',
  /** 上限の欄の説明（`minText`・`maxText` は `formatCount` の結果）。 */
  limitHint: (minText: string, maxText: string): string => `${minText}以上、既定の ${maxText}以下にします。`,
  ttlHeading: '承認の期限',
  ttl: '承認の期限（日）',
  /** 期限の欄の説明（`minText`・`maxText` は `formatInteger` の結果）。 */
  ttlHint: (minText: string, maxText: string): string => `承認してから期限までの日数です。${minText} 日以上、既定の ${maxText} 日以下にします。`,
  sideEffectsHeading: '副作用の確認',
  sideEffectsNote: '承認の前に、4 項目をすべて確かめます。確かめていない項目があると、保存はできますが、承認はできません。',
  save: '保存する',
  saving: '保存しています…',
  saved: '保存しました。',
  saveRejectedHeading: '保存できませんでした',
  // 詳細。
  stateHeading: '承認の状態',
  reasonsHeading: '再承認が要る理由',
  expiresAt: '承認の期限',
  approvalTtlDays: '承認の期限の日数',
  /** 日数の表示（`daysText` は `formatInteger` の結果）。 */
  daysValue: (daysText: string): string => `${daysText} 日`,
  evidenceHeading: '発見の根拠（シナリオを作ったときの写し）',
  evidenceNote:
    'シナリオを作ったときの、最後の「操作の候補を探す」の候補の写しです。入力の値・CSRF のトークン・hidden の値・選択肢の label は持ちません。送る値の例は、入力の規則の画面の「データの例（送りません）」で示します。',
  discoveryJob: '写した発見のジョブ',
  requestHeading: '要求の形',
  formMethod: '送り方',
  origin: '送信先の Origin',
  path: '送信先の path',
  enctype: '送り方の形（enctype）',
  fieldsTableHeading: '欄の型と制約',
  fieldColumns: {
    name: '名前',
    type: '型',
    flags: '属性',
    constraints: '制約',
    selected: '送るか',
  },
  selectedYes: '送る',
  selectedNo: '送らない',
  inputRulesHeading: '入力の規則',
  inputRulesMissing: '未設定。入力の規則を決めるまで、実行の許可は出せません。',
  /** T29e: シナリオの詳細から、入力の規則の画面を開く。 */
  openRules: '入力の規則を開く',
  /** T29e: 入力の規則の状態（`label` は表示カタログのラベル。`referenceText` は参照の表示）。 */
  inputRulesState: (label: string, referenceText: string): string => `${label}（${referenceText}）`,
  /** 入力の規則の参照（`revisionText` は `formatInteger` の結果）。 */
  inputRulesValue: (ruleSetId: string, revisionText: string, digest: string): string => `${ruleSetId}（版 ${revisionText}、${digest}）`,
  sideEffectConfirmed: '確かめた',
  sideEffectUnconfirmed: '確かめていない',
  historyHeading: '承認と撤回の履歴',
  noHistory: 'まだ承認していません。',
  historyColumns: {
    kind: '種類',
    at: '日時',
    revision: '承認した版',
    expiresAt: '期限',
    detail: '内容',
  },
  approverLocalOperator: 'この画面の利用者（LOCAL_OPERATOR）',
  revisionsHeading: '版の履歴',
  revisionColumns: {
    revision: '版',
    recordedAt: '記録した日時',
    fields: '送る欄',
    limits: '上限',
    ttl: '承認の期限の日数',
  },
  diffHeading: '最後の承認との差分',
  noApproval: 'まだ承認していないので、差分はありません。',
  noDiff: '最後の承認から、承認を縛る内容は変わっていません。',
  diffColumns: {
    item: '項目',
    change: '前の値 → 今の値',
    description: '説明',
  },
  /** 差分の値の表示（機械の読める形。`previousText`・`currentText` は JSON の文字列）。 */
  diffValue: (previousText: string, currentText: string): string => `${previousText} → ${currentText}`,
  actionsHeading: '操作',
  edit: '変える',
  approve: '承認する',
  revoke: '承認を撤回する',
  approved: '承認しました。',
  revoked: '承認を撤回しました。',
  actionRejectedHeading: '操作できませんでした',
  unconfirmedSideEffects: '副作用の確認に、まだ確かめていない項目があるため、承認できません。「変える」から、4 項目をすべて確かめてください。',
  approveDialog: {
    title: 'このシナリオを承認しますか',
    body: '下の内容で、このシナリオの今の版を承認します。承認だけでは書き込みは始まりません。内容が変わると、承認は引き継がず、もう一度承認が要ります。',
    limits: '上限',
    ttl: '承認の期限',
    sideEffects: '副作用の確認',
    diff: '最後の承認との差分',
    confirm: '承認する',
    cancel: 'やめる',
  },
  revokeDialog: {
    title: '承認を撤回しますか',
    body:
      '最後の承認を撤回します。撤回すると、まだ消費していない実行の許可は無効になり、送っていない件数の予約は返ります。送った書き込みは取り消せません。撤回の記録は残ります。',
    confirm: '撤回する',
    cancel: 'やめる',
  },
  reload: '読み込み直す',
  backToList: 'シナリオの一覧に戻る',
  backToScenario: 'シナリオの詳細に戻る',
  openDiscovery: '操作の候補を開く',
  backToProfile: 'プロファイルに戻る',
  /**
   * T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」、2 章のユーザーの判断 3・4）: UPDATE の指定の入力と表示。`placeholder` は、path の型の
   * レコードの ID の区切りの印（契約の値。画面に書き写さない）。
   */
  update: {
    heading: 'UPDATE の指定',
    note:
      '更新するレコードの台帳、更新の画面と送信先の path の型、欄ごとの役割（変える・保つ）を決めます。更新するレコードは、台帳のレコードのうち最新の 1 件を、BeakSight が開始のときに選びます（人は ID を入力しません）。',
    ledger: '台帳にする登録（CREATE）のシナリオ',
    ledgerHint: '同じプロファイルの、登録（CREATE）のシナリオを選びます。このシナリオで BeakSight が登録して照合したレコードだけを更新します。',
    noLedger: '台帳にできる登録（CREATE）のシナリオがありません。先に、登録の候補からシナリオを作ります。',
    /** 台帳の選択肢（`pathText` は候補の画面の path）。 */
    ledgerOption: (scenarioId: string, pathText: string): string => `${scenarioId}（${pathText}）`,
    templates: 'path の型',
    /** path の型の選択の説明。 */
    templatesHint: (placeholder: string): string =>
      `候補の更新の画面の path と送信先の path で、同じ値を持つ区切りから、レコードの ID の区切りを選びます。選んだ区切りは ${placeholder} になります。`,
    /** 候補の path（`pagePath`・`actionPath` は候補のもの）。 */
    candidatePaths: (pagePath: string, actionPath: string): string => `候補の path: 画面 ${pagePath}・送信先 ${actionPath}`,
    /** 型の選択肢（2 つの型と、ID の区切りの値）。 */
    templateOption: (formTemplate: string, actionTemplate: string, recordId: string): string =>
      `画面 ${formTemplate}・送信先 ${actionTemplate}（ID の区切り: ${recordId}）`,
    manualTemplate: '手で入力する',
    noTemplateOption: '候補の path から、型を作れませんでした。型を手で入力します。',
    formPathTemplate: '更新の画面の path の型',
    actionPathTemplate: '送信先の path の型',
    /** 手で入力する型の説明。 */
    manualTemplateHint: (placeholder: string): string =>
      `レコードの ID の区切りを ${placeholder} にした path です。${placeholder} は、ちょうど 1 つ、区切りの全体に書きます。`,
    rolesHeading: '欄の役割',
    rolesNote:
      '見えていて編集できる欄ごとに、値を変えるか、今の値のまま保つかを選びます。既定は保つです。状態の欄と、秘密に見える名前の欄は変えられません（理由を示します）。変える欄は 1 つ以上必要です。',
    roleChange: '変える',
    roleKeep: '保つ',
    contactFieldHint:
      'メールアドレスと電話番号の欄は、既定で保ちます。変える欄にすると、合成の値（example.invalid、090-0XXX-XXXX）を送ります。外部への通知がないことの確認が要ります。',
    otherFieldsHeading: '役割のない欄',
    otherFieldsNote: '見えない欄、読み取り専用の欄、無効の欄、送り方の上書きの欄は、役割を持ちません（ページの値のまま送ります）。',
    noOtherFields: 'ありません。',
    // 詳細。
    changedFields: '変える欄',
    keptFields: '保つ欄',
    none: 'なし',
    plannedTarget: '更新の予定のレコード',
    plannedTargetNote: '台帳のレコードのうち、登録の時刻が最も新しい 1 件です。開始のときに選び直し、違えば止めます。',
    noPlannedTarget: '対象にできるレコードがない（台帳の登録（CREATE）のシナリオで、照合済み（VERIFIED）の登録がありません）。',
    specMissing: 'UPDATE の指定がありません（UPDATE の指定の前に保存した版です）。「変える」から指定します。',
    openLedger: '台帳のシナリオを開く',
  },
} as const);

/**
 * 入力の規則の判定の細分ごとの説明と手順（Task 29 の設計書 4.1。T29e）。細分の一覧は `src/control/data-rules/rule-contracts.ts` の
 * `NEEDS_RULE_INPUT_DETAILS`・`RULE_CONFLICT_DETAILS`・`EXTERNAL_DELIVERY_BLOCKED_DETAILS`（書き漏れは画面の `catalog-coverage.ts` が型で確かめる）。
 */
export const RULE_PROBLEM_DETAIL_DESCRIPTIONS = deepFreeze({
  NO_RULE: {
    description: 'この欄の値の作り方が決まっていません。',
    action: '意味の種類を選ぶか、作り方を「人が入れた値の一覧から」にして値を入れてください。',
  },
  REQUIRED_FIELD_NOT_SELECTED: {
    description: '入力が必須の欄ですが、シナリオの送る欄に選ばれていません。',
    action: 'シナリオを変えて、この欄を送る欄に選んでください。',
  },
  SEMANTIC_KIND_UNDECIDED: {
    description: '欄の名前と型から、意味の種類を推せませんでした（推し量って作りません）。',
    action: '意味の種類を選ぶか、人が入れた値の一覧を入れてください。',
  },
  PATTERN_UNSUPPORTED: {
    description: '欄の入力の形（pattern）が、扱える単純な形（数字の桁数・英数字の長さ・カタカナなど）でないか、作る値が合いません。',
    action: '人が入れた値の一覧で、欄の形に合う値を入れてください。',
  },
  RANGE_MISSING: {
    description: '数や日時の範囲（最小と最大）が決まっていません。',
    action: '範囲の最小と最大を入れてください。',
  },
  RANGE_EMPTY: {
    description: '範囲の最小が最大を超えています。',
    action: '範囲を直してください。',
  },
  CONSTRAINT_UNSUPPORTED: {
    description: '欄の最小・最大・刻みの形を扱えません（any、指数の表記、ありえない日時など）。',
    action: '範囲を人が入れるか、人が入れた値の一覧を使ってください。',
  },
  LENGTH_UNSATISFIABLE: {
    description: '欄の長さの制約（minlength・maxlength）に合う値を作れません。',
    action: '人が入れた値の一覧で、長さに合う値を入れてください。',
  },
  NO_USABLE_OPTION: {
    description: '選べる選択肢がありません（空の値と、危険な語・無効化の語（非表示、停止、取消、inactive など）の値を除くと残りません）。',
    action: '人が入れた値の一覧で、使ってよい選択肢の値を入れてください。',
  },
  URL_FIELD: {
    description: 'URL の欄の値は作りません。',
    action: '人が入れた値の一覧で、テスト環境で使ってよい URL を入れてください。',
  },
  ADDRESS_FIELD: {
    description: '住所の欄の値は作りません（実在の宛先に届くおそれがあるため）。',
    action: '人が入れた値の一覧で、テスト環境で使ってよい住所を入れてください。',
  },
  PHONE_FORMAT_UNSUPPORTED: {
    description: '欄の制約に、合成の電話番号の形（090-0XXX-XXXX、ハイフンなしの 0900XXXXXXX）が合いません。ほかの形には切り替えません。',
    action: 'テスト環境で使ってよい番号（管理下のテスト用の回線など）を、人が入れた値の一覧に入れてください。',
  },
  SEMANTIC_KIND_TYPE_MISMATCH: {
    description: '選んだ意味の種類が、欄の型に合いません（メール・電話の欄は、メール・電話か固定の一覧だけ）。',
    action: '欄の型に合う意味の種類を選んでください。',
  },
  FIXED_VALUE_VIOLATES_CONSTRAINT: {
    description: '人が入れた値が、欄の型・選択肢・制約に合わないか、危険な語か無効化の語（非表示、停止、取消、inactive など）を含みます（メールは example.invalid の宛先だけ）。',
    action: '欄に合う値に直してください。',
  },
  RANGE_OUTSIDE_FIELD_CONSTRAINT: {
    description: '人が入れた範囲が、欄の最小・最大の外です。',
    action: '欄の範囲の中に直してください。',
  },
  RELATION_FIELD_MISMATCH: {
    description: '欄どうしの関係の欄が、送る欄でないか、意味の種類が関係の役割に合いません。',
    action: '関係の欄と、その欄の意味の種類を確かめてください。',
  },
  RELATION_UNSATISFIABLE: {
    description: '欄どうしの関係（終了は開始より後、合計は単価 × 数量）を、範囲の中で満たせません。',
    action: '範囲か関係を直してください。',
  },
  UNIQUE_COMBINATIONS_EXHAUSTED: {
    description: '一意にする欄の組を、使った組と重ならないように作れません。',
    action: '一意にする欄を見直すか、値の一覧を増やしてください。',
  },
  STATE_FIELD_NOT_USABLE: {
    description: '状態の欄（有効・無効・公開・削除など）には値を入れません。',
    action: 'シナリオを変えて、この欄を送る欄から外してください。',
  },
  NOTIFICATION_OPT_OUT_UNAVAILABLE: {
    description: '通知・配信を求める欄で、「送らない」側の値が選べません（名前に否定の語がある欄を含む）。',
    action: '送らない側の値を、人が入れた値の一覧で入れるか、シナリオを変えて、この欄を送る欄から外してください。',
  },
  FIELD_NOT_SENDABLE: {
    description: '送る欄が、候補の送れる欄ではありません（見えない、読み取り専用、無効、パスワード、ファイルなど）。',
    action: '「操作の候補を探す」をもう一度行い、シナリオを作り直してください。',
  },
  EXTERNAL_NOTIFICATION_UNCONFIRMED: {
    description: 'メール・電話の欄は、シナリオの副作用の確認「メール・SMS・外部の通知が送られない設定です」を確かめるまで作りません。',
    action: 'シナリオを変えて、その項目をテスト環境の設定で確かめてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 入力の規則の保存を拒む理由ごとの説明と手順（T29e）。理由の一覧は、保存の部品の `RULE_SET_STORE_REJECTION_REASONS`
 * （`src/control/data-rules/rule-store.ts`）と、画面のサーバの理由（`apps/local-ui/src/server/data-rule-functions.ts` の
 * `DATA_RULE_REQUEST_LOCAL_REJECTION_REASONS`）。シナリオに参照を付ける 2 段目の拒否は `SCENARIO_REQUEST_REJECTION_DESCRIPTIONS`。
 */
export const DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS = deepFreeze({
  RULE_SET_SCENARIO_NOT_FOUND: {
    description: '対象のシナリオが見つかりません。保存していません。',
    action: 'シナリオの一覧を読み込み直して、対象を確かめてください。',
  },
  RULE_SET_PROFILE_RETIRED: {
    description: '取り消したプロファイルでは、入力の規則を保存できません。保存していません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  RULE_SET_MODE_NOT_WRITE: {
    description: '入力の規則は、承認した書き込みのモード（TEST_APPROVED_WRITE）のプロファイルだけで使えます。保存していません。',
    action: 'テスト環境の、承認した書き込みのモードのプロファイルで決めてください。',
  },
  RULE_SET_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、入力の規則が変わりました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
  RULE_SET_SECRET_FIELD_FIXED_VALUE: {
    description: '秘密に見える名前の欄には、人が入れた値を残せません。保存していません。',
    action: 'その欄の値の一覧を外してください。',
  },
  DATA_RULE_CONTENT_INVALID: {
    description: '入力の規則の中身に誤りがあります（同じ欄の規則が 2 つある、関係や一意にする欄に規則のない欄がある、など）。保存していません。',
    action: '内容を見直してから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、入力の規則（補完）の画面の文言（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。 */
export const LOCAL_UI_DATA_RULE_TEXT = deepFreeze({
  pages: {
    rules: '入力の規則',
  },
  intro:
    '送る欄ごとに、書き込みで送る値の作り方（入力の規則）を決めます。LLM は使わず、欄の型と制約、小さな辞書と業務テンプレート、人が入れた値の一覧から、決まった手順で作ります。決まらない欄は、推し量らずに止めます。',
  noExecution: 'この画面からは、書き込みを実行しません。データの例もサイトに送りません。',
  stateHeading: '入力の規則の状態',
  ruleSetLabel: '保存した版',
  /** 保存した版（`revisionText` は `formatInteger` の結果）。 */
  ruleSetValue: (ruleSetId: string, revisionText: string): string => `${ruleSetId}（版 ${revisionText}）`,
  noRuleSet: 'まだ保存していません（業務テンプレートと汎用の規則だけで判定しています）。',
  fieldsHeading: '送る欄の規則',
  fieldsNote: '「自動」は、業務テンプレートか汎用の規則で決めます。人の規則は、それより強く当たります。',
  columns: {
    field: '欄',
    status: '状態',
    source: '出どころ',
    rule: '規則',
    external: '外部到達',
  },
  noFields: 'このシナリオには、送る欄がありません。',
  notSelected: '送る欄ではありません（必須の欄）',
  noExternal: 'なし',
  noSource: 'なし',
  kindLabel: '意味の種類',
  autoKind: '自動（業務テンプレートか汎用の規則）',
  methodLabel: '作り方',
  fixedValuesLabel: '値の一覧（1 行に 1 つ）',
  /** 値の一覧の説明（`maxText`・`lengthText` は `formatCount`・`formatInteger` の結果）。 */
  fixedValuesHint: (maxText: string, lengthText: string): string =>
    `${maxText}まで。1 つの値は ${lengthText} 文字まで。値は管理データにそのまま残ります。秘密に見える名前の欄には入れられません。`,
  rangeLabel: '範囲（数や日時の欄だけ。空なら欄の制約とテンプレートの既定）',
  rangeMin: '最小',
  rangeMax: '最大',
  rangeStep: '刻み',
  relationsHeading: '欄どうしの関係',
  relationsNote:
    '人が決めた関係に、業務テンプレートの既定の関係（開始と終了、単価・数量・合計、氏名とフリガナが、それぞれ 1 つずつのとき）を足して当てます。',
  noRelations: '人が決めた関係はありません。',
  relationKindLabel: '関係',
  relationRoles: {
    startFieldName: '開始の欄',
    endFieldName: '終了の欄',
    unitPriceFieldName: '単価の欄',
    quantityFieldName: '数量の欄',
    totalFieldName: '合計の欄',
    nameFieldName: '氏名の欄',
    kanaFieldName: 'フリガナの欄',
  },
  addRelation: '関係を足す',
  removeRelation: '外す',
  effectiveRelationsLabel: '当てる関係',
  noEffectiveRelations: 'なし',
  uniqueHeading: '一意にする欄の組',
  uniqueNote:
    '選ばなければ、業務テンプレートの既定の組（顧客は氏名とフリガナ、商品は商品名、予約は日付・開始・選択肢）を使います。前に作った値の組と重なれば、作り直します。',
  effectiveUniqueLabel: '当てる組',
  noUnique: 'なし（一意性を求めません）',
  examplesHeading: 'データの例（送りません）',
  examplesNote:
    'この画面のための決まった値で作った例です。サイトには送りません。実際の書き込みでは、実行の許可ごとに別の値になります。メールアドレスと電話番号は、合成の形だけです。',
  /** 例の見出し（`numberText` は `formatInteger` の結果）。 */
  exampleLabel: (numberText: string): string => `例 ${numberText}`,
  examplesUnavailable: '値の作り方が決まらない欄があるため、例は作れません。',
  exampleColumns: {
    field: '欄',
    value: '値（例）',
  },
  notSent: '送らない',
  syntheticEmail: '合成のメールアドレス（example.invalid。届かない宛先）',
  syntheticPhone: '合成の電話番号（090-0 で始まる形）',
  save: '保存する',
  saving: '保存しています…',
  saveDialog: {
    title: '入力の規則を保存しますか',
    body:
      '保存すると、入力の規則の新しい版ができ、シナリオに付け直します。シナリオの版が 1 つ上がって下書きに戻るので、承認していた場合は、もう一度承認が要ります。',
    confirm: '保存する',
    cancel: 'やめる',
  },
  saved: '入力の規則を保存し、シナリオに付けました。シナリオは下書きに戻りました。内容を確かめてから、もう一度承認してください。',
  saveRejectedHeading: '保存できませんでした',
  attachRejected: '入力の規則は保存しましたが、シナリオに付けられませんでした。画面を読み込み直してから、もう一度保存してください。',
  reload: '読み込み直す',
  backToScenario: 'シナリオの詳細に戻る',
} as const);

/** 画面のサーバのコンソールの、監査のジョブの文言（設計書 4.4 の「画面のサーバの起動のとき」と「終わり」）。 */
export const LOCAL_UI_JOB_CONSOLE_TEXT = deepFreeze({
  /** 起動のときに、前の画面のサーバで終わっていなかったジョブを中断に直した（`countText` は `formatCount` の結果）。 */
  recoveredJobs: (countText: string): string =>
    `前の画面のサーバで終わっていなかった監査のジョブ（${countText}）を、中断として記録しました。${AUDIT_JOB_RESUME_ACTION_TEXT}`,
  /** 1 回目の Ctrl+C で、動いているジョブがある（`waitText` は待つ時間の上限。`formatDuration` の結果）。 */
  jobsStopping: (waitText: string): string =>
    `動いている監査を止めています。今のページの監査を終えるまで、最大 ${waitText} 待ってから終えます。すぐに終えるには、もう一度 Ctrl+C を押してください。`,
  /** 2 回目の Ctrl+C で、待たずに終える。 */
  exitingNow: `すぐに終えます。動いていた監査は、次に画面のサーバを起動したときに中断として記録されます。${AUDIT_JOB_RESUME_ACTION_TEXT}`,
  /** ジョブの管理の背後の処理（IPC の受け手、タイマー）の誤り。詳細（英語）を添えて出す。 */
  backgroundError: '監査のジョブの管理で、誤りが起きました。',
} as const);

/** ローカルの管理画面の、監査の開始・進み具合・実行履歴・成果物の文言（設計書 4.8）。 */
export const LOCAL_UI_AUDIT_TEXT = deepFreeze({
  pages: {
    jobs: '実行履歴',
    jobDetail: '監査のジョブ',
    startAudit: '監査を始める',
  },
  profileList: {
    startAudit: '監査を始める',
    lastRunNone: 'まだ実行していません',
    lastRunDetail: '詳細',
  },
  start: {
    profileHeading: 'プロファイル',
    configHeading: '設定の要点',
    configNote: 'この画面では変えられません。間隔と上限を変えるときは、設定のファイルを直してください（画面からは上書きしません）。',
    targetConfigPath: '設定のファイル',
    startUrl: '開始の URL',
    maxPages: 'ページの上限',
    maxRuntime: '時間の上限',
    minNavigationInterval: 'ページの読み込みの間隔',
    modeLegend: '始め方',
    resume: '前回の続きから再開する',
    resumeHint: '途中で止まった Run があれば、続きから再開します。なければ、新しく始めます。',
    startNew: '新しく始める',
    startNewHint: '途中の Run があっても再開せずに、最初から始めます（CLI の --new と同じ）。',
    submit: '監査を始める',
    submitting: '開始しています…',
    cannotStartHeading: 'このプロファイルでは、監査を始められません',
    rejectedHeading: '監査を始められませんでした',
  },
  jobs: {
    caption: '監査のジョブ（新しい順）',
    empty: 'まだ監査のジョブはありません。「サイトとプロファイル」の一覧の「監査を始める」から始めます。',
    columns: {
      createdAt: '開始の要求',
      profileId: 'プロファイル',
      state: 'ジョブの状態',
      runId: 'Run の ID',
      runStatus: 'Run の状態',
      endKind: '終わり方',
      finishedAt: '終わりの日時',
    },
  },
  job: {
    summaryHeading: 'ジョブ',
    state: 'ジョブの状態',
    profileId: 'プロファイル',
    profileRevision: '改訂',
    startMode: '始め方',
    runId: 'Run の ID',
    runStatus: 'Run の状態',
    endKind: '終わり方',
    exitCode: '終了コード',
    failureReason: '失敗・中断の理由',
    createdAt: '開始の要求',
    startedAt: 'Run の開始',
    finishedAt: '終わりの日時',
    stopRequestedAt: '止める要求',
    none: 'なし',
    progressHeading: '進み具合',
    noProgress: 'まだ進み具合の知らせはありません。',
    pagesProgressLabel: '監査を終えたページの割合（ページの上限に対して）',
    noticeHeading: '知らせ',
    pollingNote: (intervalText: string): string => `この画面は、${intervalText}ごとに状態を読み直します。画面を閉じても、監査は続きます。`,
    stop: '監査を止める',
    forceStop: '強制的に止める',
    stopRequested: '止める要求を送りました。今のページの監査を終えてから止まります。',
    forceStopHint: (waitText: string): string => `止める要求から ${waitText} たっても止まらないため、強制的に止められます。`,
    stopRejectedHeading: '止められませんでした',
    artifactsHeading: '成果物',
    noArtifacts: 'まだ成果物はありません。',
    openReport: 'HTML レポートを開く',
    downloadRunJson: 'run.json をダウンロードする',
    downloadAuditJson: 'audit.json をダウンロードする',
    downloadBundle: 'ChatGPT 用のバンドル（ZIP）をダウンロードする',
  },
  stopDialog: {
    title: '監査を止めますか',
    body: '今のページの監査を終えてから止めます。止めた Run は一部未完了になり、後で「前回の続きから再開する」を選んで開始すると、続きから再開します。',
    confirm: '止める',
    cancel: 'やめる',
  },
  forceStopDialog: {
    title: '強制的に止めますか',
    body: '今のページの監査を待たずに、すぐに止めます。再開のための保存は、最後に監査を終えたページまで残ります。',
    confirm: '強制的に止める',
    cancel: 'やめる',
  },
  /** 成果物の Server Routes が、許可の一覧の外や、ないファイルに返す本文（404）。 */
  artifactNotFound: 'この成果物はありません。',
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 認証つきの読み取りの監査（ローカルの管理画面の認証の設定、ログインの案内と状態。Task 25 の設計書 4.5、4.6。T25e）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 認証の設定の検証の誤りのコード（`src/control/auth/auth-setup-contracts.ts` の `AUTH_SETUP_VALIDATION_ERROR_CODES`）ごとの、日本語の説明。
 * 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。説明には、設定の値を入れない。
 */
export const AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS = deepFreeze({
  AUTH_SETUP_SCHEMA_INVALID: '認証の設定の形が正しくありません（必須の項目がない、値の種類が違う、同じ値が 2 回ある、など）。',
  AUTH_SETUP_LIMIT_EXCEEDED:
    '長さ、件数、または回数の上限を超えています。認証の方式が自動ログインのプロファイルでは、ログインの送信の回数は 1 回だけです（アカウントのロックを避けるため）。',
  AUTH_SETUP_PROFILE_INVALID: '今の設定のファイルでは、プロファイルの内容に誤りがあります。プロファイルの編集で直してください。',
  AUTH_SETUP_PROFILE_MISMATCH: '認証の設定が、このプロファイルのものではありません。',
  AUTH_SETUP_PROFILE_REVISION_MISMATCH:
    'この画面を開いた後に、プロファイルが変更されました（認証の設定は、今のプロファイルの改訂に結びつけて保存します）。読み込み直してから、もう一度保存してください。',
  AUTH_SETUP_MODE_UNSUPPORTED:
    '認証の設定は、認証つきの読み取りの監査か承認した書き込みのモードで、認証の方式が手動のログインか自動ログインのプロファイルだけで使います。',
  AUTH_SETUP_URL_INVALID: 'URL の形が正しくありません（http:// か https:// で始まり、ユーザー名・パスワード・# を含まない、正規の形の URL にしてください）。',
  AUTH_SETUP_PATH_INVALID: 'パスの形が正しくありません（/ で始め、//、..、符号化した .、空白、制御文字を含めないでください）。',
  AUTH_SETUP_ORIGIN_NOT_APPROVED: 'URL の Origin が、プロファイルのテスト環境の Origin に入っていません。',
  AUTH_SETUP_ORIGIN_OUTSIDE_TARGET: 'プロファイルのテスト環境の Origin が、設定のファイルの監査の対象（allowedOrigins）に入っていません。',
  AUTH_SETUP_SECRET_LIKE_VALUE: 'ログインの画面の URL に、秘密に見える名前の query（password、token、session など）があります。秘密は書かないでください。',
  AUTH_SETUP_IDP_NOT_SUPPORTED: '別の Origin のログインの画面（IdP）には、まだ対応していません。',
  AUTH_SETUP_SELECTOR_INVALID: '要素の CSS セレクタが正しくありません（空白だけ、改行や制御文字を含む）。使わない場合は空にしてください。',
  // T32j-4: 自動ログインの 3 つのセレクタは、標準の CSS として読む（ログインの form の事前の確かめは isolated world の中で探し直す）。
  AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS:
    '標準の CSS で読めない書き方があります（Playwright 独自の :has-text()・:visible・>>、css=・xpath= などの前置き）。標準の CSS セレクタだけで書いてください。shadow root をまたぐ書き方も、実行のときにフォームを読めないとして止まります。',
  AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS:
    'ログインが済んだと判定するパスが、ログインの画面（またはセッションが切れたと判定するパス）にも当たります。ログインの後にだけ開く画面のパスにしてください。',
  // T26b（Task 26 の設計書 4.3）: 自動ログインの設定の誤り。T26e で文言を見直した。
  AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED:
    '認証の方式が自動ログインのプロファイルでは、自動ログインの設定が要ります。ユーザー名の欄、パスワードの欄、送信のボタンの CSS セレクタを入れてください。',
  AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED:
    '認証の方式が手動のログインのプロファイルでは、自動ログインの設定は使いません。自動ログインを使う場合は、プロファイルの認証の方式を変えてください。',
  AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED:
    'ユーザー名の欄、パスワードの欄、送信のボタンの CSS セレクタに、同じものがあります。それぞれ別の要素を指すセレクタにしてください。',
  AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS:
    'ログインの結果を判定する条件が、同時に当たりえます（同じパスの条件で、セレクタが同じか、どちらかにセレクタがない）。同じパスの条件には、それぞれの画面にだけある要素のセレクタを指定してください。',
} as const);

/**
 * 認証の設定の保存の部品が保存を拒む理由（`src/control/store/auth-setup-store.ts` の `AUTH_SETUP_STORE_REJECTION_REASONS`）ごとの説明と手順。
 * 書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS = deepFreeze({
  AUTH_SETUP_INVALID: {
    description: '認証の設定に、誤りがあります。保存していません。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したプロファイルには、認証の設定を保存できません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'プロファイルが指す設定のファイルを読めないか、その内容に誤りがあります。保存していません。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度保存してください。',
  },
  PROFILE_INVALID: {
    description: '今の設定のファイルでは、プロファイルの内容に誤りがあります。保存していません。',
    action: 'プロファイルの編集で誤りを直してから、もう一度保存してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: '保存の途中で、プロファイルが変更されました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、認証つきの読み取りの監査の文言（認証の設定の画面、開始の画面の案内、ジョブの画面の認証の状態）。 */
export const LOCAL_UI_AUTH_TEXT = deepFreeze({
  pages: {
    authSetup: '認証の設定',
  },
  /** プロファイルの詳細の、認証の設定への案内。 */
  profileDetail: {
    heading: '認証の設定',
    body: 'この監査モードでは、監査や操作の候補の発見を始める前に、ログインの画面や読む範囲などの認証の設定が要ります。',
    open: '認証の設定を開く',
  },
  /** プロファイルの登録・編集のフォームで、認証の設定が要るモードを選んだときの案内。 */
  profileFormNotice:
    'ログインを使うモードでは、プロファイルを保存した後に、プロファイルの詳細から認証の設定を作ってから、監査や操作の候補の発見を始めます。',
  setup: {
    profileHeading: 'プロファイル',
    approvedTestOrigins: 'テスト環境の Origin',
    state: '認証の設定の状態',
    notSaved: 'まだ保存していません',
    updatedAt: '最後の保存',
    staleHeading: 'プロファイルが変わりました',
    staleBody: 'この認証の設定は、前の改訂のプロファイルで保存したものです。古い設定では監査を始めません。内容を見直して、保存し直してください。',
    notEligible: 'このプロファイルでは、認証の設定を使いません（認証つきの読み取りの監査か承認した書き込みのモードで、認証の方式が手動のログインか自動ログインのプロファイルだけで使います）。',
    retired: '取り消したプロファイルには、認証の設定を保存できません。',
    noSecretHeading: 'ここに秘密を書かないでください',
    noSecretBody:
      'パスワードや Cookie の値などの秘密は、この画面に書きません（保存もしません）。ログインは、監査を始めたときに BeakSight が開くブラウザで、人が行います。',
    /** 自動ログインのプロファイルの、秘密を書かない案内（T26e）。 */
    noSecretBodyAutomated:
      'パスワードや Cookie の値などの秘密は、この画面に書きません（保存もしません）。自動ログインのユーザー名とパスワードは、プロファイルの詳細の「資格情報」の画面で、別に暗号化して保存します。',
    formHeading: 'ログインと監査の範囲',
    loginStartUrl: 'ログインの画面の URL',
    loginStartUrlHint: 'BeakSight が開くブラウザで、最初に開く画面です（例: https://test.example.invalid/login）。',
    loginPostEndpoints: 'ログインの送信先（1 行に 1 つ）',
    loginPostEndpointsHint: 'ログインのフォームの送信先の URL です。ログインの間だけ、ここへの送信（POST）を許します（query は比べません）。',
    successPathPrefix: 'ログインが済んだと判定するパス',
    successPathPrefixHint: 'ログインの後に開く画面のパスの前方一致です（例: /admin）。ログインの画面のパスには当たらない値にします。',
    successSelector: 'ログインが済んだと判定する要素（CSS セレクタ。任意）',
    successSelectorHint: 'そのパスの画面にある要素です（例: #dashboard）。使わない場合は空にします。',
    sessionLostPathPrefix: 'セッションが切れたと判定するパス（任意）',
    sessionLostPathPrefixHint: '監査の途中でこのパスの画面へ移ったら、セッションが切れたと判定して止めます。空なら、ログインの画面の URL のパスです。',
    excludedPaths: '読まないパス（1 行に 1 つ）',
    excludedPathsHint: '監査で読まないパスの前方一致です。ログアウトの画面のパスを必ず入れてください。',
    auditPathPrefixes: '読む範囲のパス（1 行に 1 つ。任意）',
    auditPathPrefixesHint: '監査で読むパスの前方一致です。空なら、範囲を絞りません。',
    maxLoginAttempts: 'ログインの送信の回数の上限',
    maxLoginAttemptsHint: (minText: string, maxText: string): string =>
      `ログインの間に許す送信の回数です（${minText}〜${maxText}。総当たりをしないため）。`,
    /** 自動ログインのプロファイルの回数（変えられない。`countText` は `formatTimes` の結果。T26e）。 */
    maxLoginAttemptsFixedText: (countText: string): string => `${countText}（自動ログインでは変えられません）`,
    // DEF-099（`doc/spec/automated-login.md` の「ログインの送信の回数と上限」）: Guard が通すのは 1 回だけ。応答の前に接続が切れるとブラウザが
    // 送り直しうるので、回数の上限（24 時間の回数）では、応答がなかった回を 2 回と数える。
    maxLoginAttemptsFixedHint:
      '自動ログインでは、アカウントのロックを避けるため、1 回のジョブで BeakSight が通すログインの送信は 1 回だけです。ただし、応答の前に接続が切れると、ブラウザが同じ送信を送り直し、サーバに 2 回届くことがあります。このため、回数の上限では、応答がなかった回を 2 回と数えます。',
    // T26e（Task 26 の設計書 4.3）: 自動ログインの設定の欄（認証の方式が自動ログインのプロファイルだけ）。
    automatedHeading: '自動ログイン',
    automatedBody:
      'BeakSight が、保存した資格情報を入れるログインのフォームの要素と、送信の後の画面がどの失敗かを見分ける条件です。ユーザー名とパスワードの値は、ここには書きません。',
    usernameSelector: 'ユーザー名の欄（CSS セレクタ）',
    usernameSelectorHint: 'ログインのフォームのユーザー名の入力の欄を、ちょうど 1 つ指すセレクタです（例: #username）。',
    passwordSelector: 'パスワードの欄（CSS セレクタ）',
    passwordSelectorHint: 'type=password の入力の欄を、ちょうど 1 つ指すセレクタです（例: #password）。',
    submitSelector: '送信のボタン（CSS セレクタ）',
    submitSelectorHint: '同じフォームの送信のボタンを、ちょうど 1 つ指すセレクタです（例: #login-button）。',
    failureConditionsHeading: 'ログインの失敗を見分ける条件（任意）',
    failureConditionsBody:
      '使わない条件は、パスとセレクタの両方を空にします。結果は、成功の条件とここの条件のうち、ちょうど 1 つに当たったときだけ決めます（どれにも当たらないか、2 つ以上に当たるときは「結果が分からない」として止めます）。',
    failureConditionNames: {
      invalidCredentials: '資格情報の誤り',
      accountLocked: 'アカウントのロック',
      mfaRequired: '人の操作（MFA など）が必要',
      credentialExpired: 'パスワードの期限切れ',
    },
    /** 失敗の条件のパスの欄のラベル（`nameText` は `failureConditionNames` の値）。 */
    failurePathPrefixLabel: (nameText: string): string => `${nameText}: 画面のパス`,
    /** 失敗の条件のセレクタの欄のラベル。 */
    failureSelectorLabel: (nameText: string): string => `${nameText}: 要素（CSS セレクタ。任意）`,
    failurePathPrefixHint: 'その画面のパスの前方一致です（例: /login-error）。',
    failureSelectorHint: 'その画面にだけある要素です。同じパスの条件がほかにもあるときは、どの条件にも指定してください。',
    defaultExcludedHeading: '既定で読まない語',
    defaultExcludedBody: 'パスか query にこの語を含む URL は、上の設定にかかわらず読みません（ログアウトや削除などの操作を避けるため。この画面では変えられません）。',
    save: '保存する',
    saving: '保存しています…',
    saved: '認証の設定を保存しました。',
    rejectedHeading: '保存できませんでした',
    /** 1 行に 1 つの項目の、誤りのある行（`lineText` は `formatCount` などで書式を整えた値）。 */
    lineText: (lineText: string): string => `${lineText} 行目`,
    backToProfile: 'プロファイルに戻る',
  },
  /** 監査の開始の画面（認証つきのプロファイル）。 */
  start: {
    heading: 'ログイン',
    guidance: 'BeakSight が開くブラウザでログインしてください。ログインが済むと自動で監査が始まります。',
    guidanceNote: 'ログインの状態（Cookie など）は保存しません。この監査の間だけ使い、再開するときも、もう一度ログインします。',
    // T26e（Task 26 の設計書 4.6）: 自動ログインのプロファイルの案内と、上限の状態。
    automatedGuidance: 'BeakSight が保存した資格情報で自動でログインします。ブラウザは開きません。',
    automatedGuidanceNote:
      'ログインの状態（Cookie など）は保存しません。この監査の間だけ使い、再開するときも、もう一度自動でログインします（回数の上限に数えます）。',
    limitState: '自動ログインの状態',
    limitReady: '今すぐ始められます',
    limitHeld: '止めています（人が確かめて停止を解くまで始められません）',
    /** 次に始められる日時（`dateTimeText` は `formatDateTime` の結果）。 */
    limitWaitText: (dateTimeText: string): string => `${dateTimeText} を過ぎると始められます`,
    openCredentials: '資格情報を開く',
    openLoginCheck: 'ログインを確かめる画面を開く',
    loginStartUrl: 'ログインの画面の URL',
    auditScope: '読む範囲',
    auditScopeAll: '制限なし（許可した Origin の中）',
    openSetup: '認証の設定を開く',
  },
  /** 監査のジョブの画面（認証つきの監査）。 */
  job: {
    heading: 'ログイン',
    state: '認証の状態',
    sessionLostUrl: '止まったページの URL',
    sessionLostGuidance: 'このページを「読まないパス」に足すと、次からこのページを読みません。足すときは、認証の設定を開いて保存し直してください。',
    openSetup: '認証の設定を開く',
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 自動ログイン（ローカルの管理画面の資格情報、ログインの確かめ、ジョブの結果。Task 26 の設計書 4.2、4.6、4.7。T26e）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 資格情報の画面の要求（登録、変更、入れ直し、削除、自動ログインの停止の解除）を拒む理由ごとの説明と手順。理由の一覧は
 * `apps/local-ui/src/server/credential-errors.ts` の `CREDENTIAL_REQUEST_REJECTION_REASONS`（資格情報のファイルの部品の誤りのコードと、画面の
 * サーバの理由）。書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。説明と手順に、値を入れない。
 */
export const CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS = deepFreeze({
  CREDENTIAL_PROFILE_ID_INVALID: {
    description: 'プロファイルの名前の形が正しくありません。資格情報は変えていません。',
    action: '画面を読み込み直してから、もう一度操作してください。',
  },
  CREDENTIAL_ORIGIN_INVALID: {
    description: '認証の設定のログインの画面の URL から、ログインの Origin を求められません。資格情報は保存していません。',
    action: '認証の設定のログインの画面の URL を確かめて、保存し直してください。',
  },
  CREDENTIAL_VALUE_EMPTY: {
    description: '空の欄があります。空の欄は「消す」の意味にはなりません。資格情報は保存していません。',
    action: '空の欄に値を入れてください。変えない項目は、変更の画面で選ばないでください。',
  },
  CREDENTIAL_VALUE_TOO_LONG: {
    description: 'ユーザー名かパスワードが、長さの上限を超えています。資格情報は保存していません。',
    action: '欄の説明にある長さまでにしてください。',
  },
  CREDENTIAL_VALUE_MALFORMED: {
    description: 'ユーザー名かパスワードに、扱えない文字があります。資格情報は保存していません。',
    action: '値を入れ直してください。',
  },
  CREDENTIAL_CHANGE_EMPTY: {
    description: '変える項目が選ばれていません。資格情報は変えていません。',
    action: '「ユーザー名を変える」か「パスワードを変える」の、少なくとも一方を選んでください。',
  },
  CREDENTIAL_ALREADY_EXISTS: {
    description: 'このプロファイルには、もう資格情報が保存されています。上書きはしていません。',
    action: '画面を読み込み直して、変更の画面から変えてください。',
  },
  CREDENTIAL_MISSING: {
    description: 'このプロファイルには、資格情報が保存されていません。',
    action: '画面を読み込み直して、新しく登録してください。',
  },
  CREDENTIAL_STALE: {
    description:
      '保存したログインの Origin が、今の認証の設定のログインの画面の Origin と違うため、一部だけを変えることはできません。資格情報は変えていません。',
    action: '「入れ直す」で、ユーザー名とパスワードの両方を入れ直してください。',
  },
  CREDENTIAL_FILE_INVALID: {
    description: '保存してある資格情報のファイルが壊れているか、このプロファイルのものではありません。',
    action: '資格情報を削除してから、登録し直してください。',
  },
  CREDENTIAL_READ_FAILED: {
    description: '資格情報のファイルか、そのフォルダを読めませんでした。',
    action: '資格情報のフォルダ（場所は doc/spec/local-ui.md）の権限を確かめてから、もう一度操作してください。',
  },
  CREDENTIAL_PLATFORM_UNSUPPORTED: {
    description: 'Windows でないため、この環境では資格情報を保存できません（自動ログインは Windows だけで使えます）。',
    action: '自動ログインを使う場合は、Windows で画面のサーバを動かしてください。',
  },
  CREDENTIAL_STORAGE_UNSAFE: {
    description: '資格情報のフォルダの所有者か権限が、今の Windows の利用者だけになっていないため、保存しませんでした。',
    action:
      '資格情報のフォルダ（場所は doc/spec/local-ui.md）の権限を、今の利用者だけに直してください。直せないときは、中身を確かめてからフォルダを別の場所へ移し、もう一度保存してください（BeakSight が新しく作って、権限を絞ります）。',
  },
  CREDENTIAL_REPLACE_FAILED: {
    description: '資格情報のファイルを置き換えられませんでした。前に保存した資格情報は、そのまま残っています。',
    action: 'ほかのプログラムが資格情報のファイルを開いていないかを確かめてから、もう一度保存してください。',
  },
  CREDENTIAL_DELETE_FAILED: {
    description: '資格情報のファイルを削除できませんでした。',
    action: 'ほかのプログラムが資格情報のファイルを開いていないかを確かめてから、もう一度削除してください。',
  },
  CREDENTIAL_IN_USE: {
    description: 'このプロファイルのジョブ（監査かログインの確かめ）が動いているため、資格情報を変えられません。資格情報は変えていません。',
    action: '実行履歴で、そのジョブが終わるのを待つか、止めてから、もう一度操作してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  CREDENTIAL_NOT_ELIGIBLE: {
    description:
      'このプロファイルでは、この操作はできません（資格情報は、認証つきの読み取りの監査か承認した書き込みのモードで、認証の方式が自動ログインの、有効なプロファイルだけで使います）。',
    action: 'プロファイルの状態、監査モード、認証の方式を確かめてください。',
  },
  AUTH_SETUP_MISSING: {
    description: 'このプロファイルには、まだ認証の設定がありません。資格情報は、認証の設定のログインの画面の Origin に結びつけて保存します。',
    action: '先に認証の設定（ログインの画面の URL と、自動ログインの設定）を保存してから、もう一度保存してください。',
  },
  CREDENTIAL_CONFIRMATION_MISMATCH: {
    description: '2 回入れたパスワードが一致しません。資格情報は保存していません。',
    action: 'パスワードを、2 つの欄に同じように入れ直してください。',
  },
  CREDENTIAL_PROTECTION_FAILED: {
    description: '資格情報の暗号化（Windows の DPAPI）に失敗しました。資格情報は保存していません。',
    action: '「環境の状態」の画面で、資格情報の暗号化の状態を確かめてから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 自動ログインのフォームの確かめが通らなかった理由のコード（`src/control/worker-protocol.ts` の `WORKER_LOGIN_FORM_INVALID_REASONS`）ごとの、
 * 日本語の説明。書き漏れと余分は、画面の側で型で確かめる。
 */
export const LOGIN_FORM_INVALID_REASON_DESCRIPTIONS = deepFreeze({
  SELECTOR_NOT_UNIQUE: 'ユーザー名の欄、パスワードの欄、送信のボタンのセレクタのどれかが、ちょうど 1 つの要素に当たりませんでした。',
  USERNAME_FIELD_INVALID: 'ユーザー名の欄が、値を入れられる入力の欄ではありませんでした。',
  PASSWORD_FIELD_INVALID: 'パスワードの欄が、type=password の入力の欄ではありませんでした。',
  SUBMIT_BUTTON_INVALID: '送信のボタンが、フォームを送るボタンではありませんでした。',
  NOT_SAME_FORM: 'ユーザー名の欄、パスワードの欄、送信のボタンが、同じフォームの中にありませんでした。',
  METHOD_NOT_POST: 'フォームの送り方が POST ではありませんでした（GET のフォームに値を入れると、資格情報が URL に載るため）。',
  ACTION_NOT_ALLOWED: 'フォームの送信先が、認証の設定のログインの送信先と一致しませんでした。',
  FORM_TARGET_NOT_SELF: 'フォームの送信の結果を、別の窓か frame に開く形でした。',
  FORM_UNREADABLE: 'ログインのフォームを読めませんでした。',
} as const);

/** ローカルの管理画面の、資格情報の画面の文言（Task 26 の設計書 4.2、4.7。T26e）。値（ユーザー名とパスワード）は、どの文言にも入れない。 */
export const LOCAL_UI_CREDENTIAL_TEXT = deepFreeze({
  pages: {
    credentials: '資格情報（自動ログイン）',
  },
  /** プロファイルの詳細の、資格情報とログインの確かめへの案内。 */
  profileDetail: {
    heading: '資格情報（自動ログイン）',
    body:
      '自動ログインに使うテスト用のアカウントのユーザー名とパスワードを、このコンピュータに暗号化して保存します。保存した資格情報で、ログインだけを確かめることもできます。',
    open: '資格情報を開く',
    // T26g-3: 自動ログインでないプロファイルに、資格情報のファイルが残っているとき（プロファイルの詳細の画面の案内）。
    leftover: '保存した資格情報が残っています。このプロファイルでは使わないので、資格情報の画面から削除してください。',
  },
  testAccountOnlyHeading: 'ここに本番のパスワードを書かないでください',
  testAccountOnlyBody:
    'テスト環境のテスト用のアカウントの資格情報だけを入れてください。値は、Windows の暗号化（DPAPI）で、このコンピュータの今の利用者だけが戻せる形で、リポジトリの中の Git の管理の外のフォルダに保存します。この画面にも、記録にも、値は出しません。',
  browserSaveNote: 'ブラウザが、入れたパスワードの保存を勧めることがあります。保存しないでください（BeakSight からは止められません）。',
  status: {
    heading: '保存の状態',
    saved: '保存の有無',
    savedYes: '保存しています',
    savedNo: 'まだ保存していません',
    createdAt: '登録した日時',
    updatedAt: '最後に変えた日時',
    lastChangeKind: '最後の変更',
    revision: '改訂',
    loginOrigin: '保存したログインの Origin',
    currentLoginOrigin: '今の認証の設定のログインの Origin',
    originState: '認証の設定との一致',
    originMatches: '合っています',
    originStale: '入れ直しが必要です（認証の設定のログインの Origin が変わりました）',
    originUnknown: '認証の設定がないため、確かめられません',
    protection: '資格情報の暗号化',
    hold: '自動ログインの停止',
    notHeld: '止めていません',
    /** 止めている（`reasonText` は結果のラベル、`dateTimeText` は `formatDateTime` の結果）。 */
    heldText: (reasonText: string, dateTimeText: string): string => `止めています（${reasonText}。${dateTimeText}）`,
    readFailedHeading: '保存した資格情報を読めません',
  },
  notEligible: 'このプロファイルでは、資格情報を使いません（認証つきの読み取りの監査か承認した書き込みのモードで、認証の方式が自動ログインのプロファイルだけで使います）。',
  retired: '取り消したプロファイルには、資格情報を保存できません。保存してある資格情報は、削除できます。',
  // T26g-2 round 1: 自動ログインでないプロファイルに、資格情報のファイルが残っているとき（削除の操作だけを出す）。
  leftoverNotEligible: '保存した資格情報が残っています。このプロファイルでは使わないので、削除してください。',
  unavailableHeading: 'この環境では、資格情報を保存できません',
  authSetupMissingHeading: '先に認証の設定を保存してください',
  authSetupMissingBody:
    '資格情報は、認証の設定のログインの画面の Origin に結びつけて保存します。ログインの画面の URL と自動ログインの設定を、先に保存してください。',
  openAuthSetup: '認証の設定を開く',
  inUseHeading: 'このプロファイルのジョブが動いています',
  inUseBody: 'ジョブ（監査かログインの確かめ）が終わるまで、資格情報の変更と削除はできません。',
  /** 欄の長さの説明（`maxText` は `formatCount` などの結果）。 */
  valueLengthHint: (maxText: string): string => `${maxText} 文字まで。`,
  username: 'ユーザー名',
  password: 'パスワード',
  passwordConfirmation: 'パスワード（確かめのため、もう一度）',
  register: {
    heading: '新しく登録する',
    body: 'ユーザー名とパスワードの両方を入れてください。パスワードは、打ち間違いによるログインの失敗とアカウントのロックを避けるため、2 回入れます。',
    submit: '登録する',
    submitting: '登録しています…',
    done: '資格情報を登録しました。',
  },
  change: {
    heading: '変更する',
    legend: '変える項目',
    changeUsername: 'ユーザー名を変える',
    changePassword: 'パスワードを変える',
    newUsername: '新しいユーザー名',
    newPassword: '新しいパスワード',
    newPasswordConfirmation: '新しいパスワード（確かめのため、もう一度）',
    unchangedNote: '選ばなかった項目は、保存してある値をそのまま使います。',
    submit: '変更する',
    submitting: '変更しています…',
    done: '資格情報を変更しました。',
  },
  replace: {
    heading: '入れ直す',
    body: '保存したログインの Origin が、今の認証の設定と違います。一部だけは変えられないので、ユーザー名とパスワードの両方を入れ直してください。',
    submit: '入れ直す',
    submitting: '入れ直しています…',
    done: '資格情報を入れ直しました。',
  },
  clearHold: {
    label: '自動ログインの停止も解く',
    hint: 'テスト環境のアカウントの状態（ロックの解除、パスワード、MFA など）を確かめた場合だけ選んでください。資格情報を変えただけでは、停止は解きません。',
    done: '自動ログインの停止も解きました。',
  },
  remove: {
    open: '資格情報を削除する',
    title: '資格情報を削除しますか',
    body: '削除すると、もう一度登録するまで、このプロファイルの自動ログインとログインの確かめは始められません。',
    confirm: '削除する',
    cancel: 'やめる',
    done: '資格情報を削除しました。',
  },
  rejectedHeading: '資格情報を保存できませんでした',
  removeRejectedHeading: '資格情報を削除できませんでした',
  backToProfile: 'プロファイルに戻る',
  /** 環境の状態の画面の項目。 */
  environment: {
    protection: '資格情報の暗号化（自動ログイン）',
  },
} as const);

/** ローカルの管理画面の、ログインの確かめの画面と、ジョブの画面の自動ログインの文言（Task 26 の設計書 4.6。T26e）。 */
export const LOCAL_UI_LOGIN_CHECK_TEXT = deepFreeze({
  pages: {
    loginCheck: 'ログインを確かめる',
  },
  profileList: {
    loginCheck: 'ログインを確かめる',
  },
  heading: 'ログインの確かめ',
  guidance: 'BeakSight が保存した資格情報で、ログインだけを 1 回試し、結果を記録します。監査は行いません。ブラウザは開きません。',
  /** 上限の説明（`intervalText` と `windowText` は `formatDuration`、`countText` は `formatTimes` の結果）。 */
  limitNote: (intervalText: string, windowText: string, countText: string): string =>
    `自動ログイン（監査の前のログインを含む）は、同じプロファイルで ${intervalText} 以上あけ、${windowText} に ${countText} までです。成功以外で終わると、アカウントのロックを避けるため、人が確かめて停止を解くまで自動ログインを止めます。`,
  submit: 'ログインを確かめる',
  submitting: '始めています…',
  cannotStartHeading: 'このプロファイルでは、今はログインを確かめられません',
  rejectedHeading: 'ログインの確かめを始められませんでした',
  nextAllowedAt: '次に始められる日時',
  openCredentials: '資格情報を開く',
  hold: {
    heading: '自動ログインを止めています',
    reason: '止めた理由',
    heldAt: '止めた日時',
    action: '人がすること',
    clear: '確かめたので自動ログインを再び許す',
    dialogTitle: '自動ログインを再び許しますか',
    dialogBody:
      'テスト環境のアカウントの状態（ロックの解除、パスワード、MFA など）と、資格情報と認証の設定を確かめた場合だけ、再び許してください。許しても、自動ログインどうしの間隔と、サーバが示した待つ時間は守ります。',
    confirm: '再び許す',
    cancel: 'やめる',
    cleared: '自動ログインの停止を解きました。',
    notHeld: '自動ログインは止めていませんでした。',
    rejectedHeading: '停止を解けませんでした',
  },
  /** ジョブの画面の自動ログインの欄。 */
  job: {
    kind: 'ジョブの種類',
    heading: '自動ログイン',
    result: '結果',
    pending: 'まだ結果はありません',
    submitted: 'ログインの送信',
    retryAfterUntil: 'サーバが示した、次に試してよい日時',
    formInvalidReason: 'フォームの確かめで止めた理由',
    action: '人がすること',
    openLoginCheck: 'ログインを確かめる画面を開く',
  },
} as const);

/**
 * 実行の許可の発行を拒む理由ごとの説明と手順（T30g。理由の一覧は `src/control/approval/execution-grant.ts` の `EXECUTION_GRANT_REJECTION_REASONS`。
 * 書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts` が型で確かめる）。書き込みの開始の画面が使う。消費と確かめ直しの理由も、一覧に
 * あるので並べる（画面の開始では、ジョブの管理が `WRITE_GRANT_REJECTED` として返す）。
 */
export const EXECUTION_GRANT_REJECTION_DESCRIPTIONS = deepFreeze({
  GRANT_SCENARIO_NOT_FOUND: { description: 'シナリオが見つかりません。書き込みは始めていません。', action: 'シナリオの一覧を読み込み直してください。' },
  GRANT_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、シナリオの版が変わりました。書き込みは始めていません。',
    action: '画面を読み込み直して、今の版の内容を確かめてから、もう一度始めてください。',
  },
  GRANT_APPROVAL_INVALID: {
    description: '承認が今は有効ではありません（理由を下に示します）。書き込みは始めていません。',
    action: 'シナリオの詳細で理由を確かめ、必要なら承認し直してください。',
  },
  NEEDS_RULE_INPUT: {
    description: '入力の規則が決まっていない欄があります。書き込みは始めていません。',
    action: '入力の規則の画面で、送る欄すべての規則を決めてください。',
  },
  VERIFICATION_SPEC_MISSING: {
    description: '検証の指定（成功の条件・入力の誤りの条件・登録の ID の取り方・照合の READ）に、まだ決めていない項目があります。書き込みは始めていません。',
    action: 'シナリオを変える画面で、検証の指定をすべて決めて保存し、承認し直してください。',
  },
  GRANT_ENVIRONMENT_EVIDENCE_MISSING: {
    description: 'プロファイルに、テスト環境であることの証跡の参照がありません。書き込みは始めていません。',
    action: 'プロファイルの画面で、環境の証跡の参照を入れてください。',
  },
  GRANT_WRITE_INTERVAL_NOT_ELAPSED: {
    description: '同じシナリオの最後の書き込みから、決まった間隔が経っていません。書き込みは始めていません。',
    action: '次に実行できる時刻の後に、もう一度始めてください。',
  },
  GRANT_DAILY_WRITE_LIMIT_REACHED: {
    description: '同じシナリオの 24 時間の書き込みの件数が、上限に達しています。書き込みは始めていません。',
    action: '次に実行できる時刻の後に、もう一度始めてください。',
  },
  GRANT_ALREADY_OPEN: {
    description: 'このシナリオには、まだ使っていない実行の許可があります。書き込みは始めていません。',
    action: '少し待ってから（許可の期限は短い時間です）、画面を読み込み直して、もう一度始めてください。',
  },
  GRANT_WRITE_CONCURRENCY_EXCEEDED: {
    description: 'ほかの書き込みが動いています（書き込みは同時に 1 つだけです）。書き込みは始めていません。',
    action: '動いている書き込みが終わってから、もう一度始めてください。',
  },
  GRANT_RUN_LIMIT_EXCEEDED: { description: '1 回の Run の上限を超えます。書き込みは始めていません。', action: 'シナリオの上限を確かめてください。' },
  GRANT_CUMULATIVE_LIMIT_REACHED: {
    description: '累積の上限に達しています（予約中・送った・送ったか分からない件数を数えます）。書き込みは始めていません。',
    action: 'これ以上は書き込めません。上限を変えるときは、シナリオを変えて承認し直してください（既定以下だけ）。',
  },
  GRANT_FACTS_CHANGED: {
    description: '確かめている間に、「操作の候補を探す」の結果が記録されました。書き込みは始めていません。',
    action: '画面を読み込み直してから、もう一度始めてください。',
  },
  GRANT_NOT_FOUND: { description: '実行の許可が見つかりません。書き込みは始めていません。', action: '画面を読み込み直してから、もう一度始めてください。' },
  GRANT_MISMATCH: { description: '実行の許可が、このシナリオとジョブのものではありません。書き込みは始めていません。', action: '画面を読み込み直してから、もう一度始めてください。' },
  GRANT_EXPIRED: { description: '実行の許可の期限が過ぎました。書き込みは始めていません。', action: 'もう一度始めてください。' },
  GRANT_ALREADY_CONSUMED: { description: '実行の許可は、もう使われています。', action: '書き込みの履歴を確かめてください。' },
  GRANT_INVALIDATED: { description: '実行の許可は、撤回か期限切れで無効になりました。', action: 'シナリオの状態を確かめてから、もう一度始めてください。' },
  GRANT_NOT_CONSUMED: { description: '実行の許可が、まだ使われていません。', action: '画面を読み込み直してください。' },
  GRANT_RESERVATION_SETTLED: { description: '実行の許可の予約は、もう締められています。', action: '書き込みの履歴を確かめてください。' },
  GRANT_CLOCK_BEFORE_APPROVAL: {
    description: 'この端末の時計が、承認の時刻より前を指しています。書き込みは始めていません。',
    action: '端末の時計を確かめてから、もう一度始めてください。',
  },
  GRANT_CLOCK_BEFORE_ISSUE: {
    description: 'この端末の時計が、許可を出した時刻より前を指しています。書き込みは始めていません。',
    action: '端末の時計を確かめてから、もう一度始めてください。',
  },
  SCENARIO_UPDATE_SPEC_MISSING: {
    description: 'この UPDATE のシナリオの版には、UPDATE の指定がありません。書き込みは始めていません。',
    action: 'シナリオを編集して UPDATE の指定を入れ、保存してから承認してください。',
  },
  // T31e（Task 31 の設計書 3 章の「対象の選び方」）: UPDATE の対象の選び直し（文言の確かめは T31h）。
  TARGET_SELECTION_CHANGED: {
    description: 'この画面を開いた後に、更新の予定のレコードが変わりました（新しい登録があったなど）。書き込みは始めていません。',
    action: '画面を読み込み直して、更新の予定のレコードを確かめてから、もう一度始めてください。',
  },
  TARGET_RECORD_UNAVAILABLE: {
    description: '更新の対象にできるレコード（参照した登録のシナリオで、BeakSight が登録して照合したもの）がありません。書き込みは始めていません。',
    action: '参照した登録（CREATE）のシナリオで、登録の書き込みを照合まで済ませてから、もう一度始めてください。',
  },
  // T31R-fix-1 の I-2: 発行の確かめ直し（下書きの保存の後に、台帳の登録の ID の取り方が変わった）。
  SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID: {
    description: '台帳（参照した登録のシナリオ）の登録の ID の取り方が変わり、この更新のシナリオの path の型の {id} の位置に合わなくなりました。書き込みは始めていません。',
    action: 'このシナリオを変更して、台帳の登録の ID の取り方に合う path の型を選び、承認し直してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 書き込みの開始を、画面のサーバが拒む理由ごとの説明と手順（T30g。理由の一覧は `apps/local-ui/src/server/write-job-functions.ts` の
 * `WRITE_START_LOCAL_REJECTION_REASONS`）。
 */
export const WRITE_START_LOCAL_REJECTION_DESCRIPTIONS = deepFreeze({
  WRITE_SCENARIO_NOT_FOUND: { description: 'シナリオかプロファイルが見つかりません。書き込みは始めていません。', action: 'シナリオの一覧を読み込み直してください。' },
  // T31h-2: 更新（UPDATE）も画面から始められるようになったので、登録の開始の口の理由として書き直した。
  WRITE_KIND_NOT_CREATE: {
    description: '登録の書き込みを始められるのは、登録（CREATE）のシナリオだけです。書き込みは始めていません。',
    action: 'シナリオの詳細を読み込み直して、その画面の「書き込みを始める画面を開く」から始めてください。',
  },
  WRITE_FACTS_UNAVAILABLE: {
    description: 'プロファイルが指す設定のファイルか、資格情報の版を読めないため、承認の状態を確かめられません。書き込みは始めていません。',
    action: '設定のファイルの場所と中身（自動ログインなら資格情報の画面）を確かめてから、もう一度始めてください。',
  },
  // T31h-2: 更新（UPDATE）の開始の口に、UPDATE でないシナリオが来た。
  WRITE_KIND_NOT_UPDATE: {
    description: '更新の書き込みを始められるのは、更新（UPDATE）のシナリオだけです。書き込みは始めていません。',
    action: 'シナリオの詳細を読み込み直して、その画面の「書き込みを始める画面を開く」から始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、書き込みの文言（Task 30 の設計書 2 章、3 章、10 章。T30g）。 */
export const LOCAL_UI_WRITE_TEXT = deepFreeze({
  pages: {
    writeStart: '書き込みを始める',
  },
  // 検証の指定の入力（シナリオのフォーム）。
  verificationHeading: '検証の指定',
  verificationNote:
    '書き込みの結果を確かめる方法を決めます。決めていない項目があっても保存と承認はできますが、書き込みは始められません。値は、ページの構造（path とセレクタ）だけを書きます。',
  conditionPathPrefix: 'path の前方一致',
  conditionSelector: 'セレクタ（任意）',
  conditionHint: '/ で始まる path の始まりと、その画面にだけある要素の CSS セレクタです。path を空にすると、未指定になります。',
  recordIdSource: '取り方',
  recordIdUnset: '指定しない',
  recordIdValue: '型かセレクタ',
  readVerificationCheck: '照合に使う READ の確かめの定義',
  readVerificationUnset: '指定しない',
  /** 照合の READ の定義の選択肢（`revisionText` は `formatInteger` の結果）。 */
  readVerificationOption: (readCheckId: string, revisionText: string): string => `${readCheckId}（版 ${revisionText}）`,
  bindingsHeading: '生成した値に結び付ける送る値',
  bindingsNote: 'READ の定義の送る値のうち、登録した値で探すものを、シナリオの送る欄に結び付けます（1 つ以上）。',
  bindingUnset: '結び付けない',
  /** 結び付けの欄の名前（READ の定義の送る値の名前）。 */
  bindingLabel: (parameterName: string): string => `送る値 ${parameterName}`,
  expectationsHeading: '期待',
  expectationKind: '期待の種類',
  expectationCount: '行の数',
  expectationField: '詳細の項目の名前',
  expectationFieldName: '比べる値（送る欄）',
  addExpectation: '期待を足す',
  removeExpectation: 'この期待を外す',
  noReadChecks: 'このプロファイルには、照合に使える READ の確かめの定義がありません。',
  // 詳細。
  verificationSectionHeading: '検証の指定',
  verificationItemUnset: '未指定',
  verificationMissingHeading: '実行できない理由',
  verificationMissing: '検証の指定に、まだ決めていない項目があります。決めるまで、書き込みは始められません。',
  /** 条件の表示（`selector` がなければ path だけ）。 */
  conditionValue: (pathPrefix: string, selector: string | null): string => (selector === null ? pathPrefix : `${pathPrefix}・${selector}`),
  /** 照合の READ の表示（`revisionText` は `formatInteger` の結果。`countText` は期待の数）。 */
  readVerificationValue: (readCheckId: string, revisionText: string, countText: string): string => `${readCheckId}（版 ${revisionText}）・期待 ${countText}`,
  openWriteStart: '書き込みを始める画面を開く',
  writesHeading: '書き込みの履歴',
  noWrites: 'まだ書き込んでいません。',
  // 開始の画面。
  confirmHeading: '始める前に確かめること',
  confirmNote:
    '「書き込みを始める」を押すと、実行の許可を出し、すぐに書き込みのジョブを始めます。登録（CREATE）を 1 回の Run で 1 件だけ送ります。送る値は、入力の規則で作った合成のテストデータです。',
  // T31h-2: 更新（UPDATE）の開始の画面。
  confirmNoteUpdate:
    '「書き込みを始める」を押すと、実行の許可を出し、すぐに更新のジョブを始めます。下の「更新するレコード」1 件の、変える欄だけを新しい値にして送ります。新しい値は、入力の規則で作った合成のテストデータです。保つ欄は送る前の値のままにします。',
  targetRecord: '更新するレコード',
  targetRecordNote: '台帳の登録のシナリオで、BeakSight が登録して照合したレコードのうち、最も新しいものです。始めるときに選び直し、この画面と違えば始めません。',
  changedFields: '変える欄',
  keptFields: '保つ欄',
  formPage: '更新の画面',
  startDialogUpdateBody: 'テスト環境の上のレコード 1 件を更新します。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
  scenario: 'シナリオ',
  revision: '版',
  fields: '送る欄',
  action: '送り先',
  perRun: '1 回の Run で 1 件',
  /** 累積の残り（`usedText`・`limitText`・`remainingText` は `formatCount` の結果）。 */
  cumulativeValue: (usedText: string, limitText: string, remainingText: string): string => `使った件数 ${usedText} / 上限 ${limitText}（残り ${remainingText}）`,
  cumulative: '累積の上限',
  schedule: '連続の上限',
  /** 連続の上限の表示（`intervalText` は分、`perDayText` と `remainingText` は `formatCount` の結果）。 */
  scheduleValue: (intervalText: string, perDayText: string, remainingText: string): string =>
    `最後の書き込みから ${intervalText} 分あける・24 時間に ${perDayText}まで（残り ${remainingText}）`,
  nextAllowedAt: '次に実行できる時刻',
  nextAllowedNow: '今すぐ実行できます',
  notification: '外部への通知',
  notificationConfirmed: 'メール・SMS・外部の通知が送られない設定であることを、承認の前に確かめました。',
  notificationUnconfirmed: '外部への通知が送られないことを、まだ確かめていません。',
  evidence: 'テスト環境の証跡',
  evidencePresent: 'プロファイルに、テスト環境であることの証跡の参照があります。',
  evidenceMissing: 'プロファイルに、テスト環境であることの証跡の参照がありません。',
  approval: '承認の状態',
  start: '書き込みを始める',
  starting: '始めています…',
  notStartable: '今は書き込みを始められません。上の内容を確かめてください。',
  startRejectedHeading: '書き込みを始められませんでした',
  startDialog: {
    title: '書き込みを始めますか',
    body: 'テスト環境に、登録を 1 件送ります。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
    confirm: '書き込みを始める',
    cancel: 'やめる',
  },
  backToScenario: 'シナリオの詳細に戻る',
  // 結果。
  resultHeading: '書き込みの結果',
  resultPending: 'まだ結果が締められていません。',
  unknownHeading: '結果が分かりません。テスト環境を確かめてください',
  unknownBody:
    '送ったか、登録されたかが分かりません。成功と見なしていません。テスト環境で、このレコードが登録されたかを必ず確かめてください。件数は使ったものとして数えます。自動では送り直しません。',
  partialHeading: '照合できていません',
  partialBody: '成功の画面には当たりましたが、登録の ID か照合の READ で確かめられていません。テスト環境で登録の内容を確かめてください。',
  // T31h-2: 更新（UPDATE）の結果。
  partialUpdateBody: '成功の画面には当たりましたが、取れた ID か更新の後の照合で確かめられていません。テスト環境で、このレコードの内容を確かめてください。',
  diffHeading: '前後の差分',
  diffNote: '変えた欄は、更新の前に読んだ値と送った新しい値を出します。保つ欄は値を記録しないので、更新の後も同じだったかだけを出します。',
  changedDiffHeading: '変えた欄',
  keptDiffHeading: '保つ欄',
  noUpdateEvidence: '更新の後の照合の証拠がありません。',
  diffColumns: {
    field: '欄',
    previous: '前の値',
    next: '新しい値',
    matched: '更新の後の照合',
  },
  matchedValue: '一致',
  notMatchedValue: '一致しない',
  undeterminedValue: '照合できない',
  columns: {
    job: 'ジョブ',
    result: '結果',
    reason: '理由',
    submission: '送信',
    blockReason: '止めた理由',
    httpStatus: '応答の HTTP の状態',
    responseJudgement: '応答の判定',
    recordId: '登録の ID',
    // T31h-2: 更新（UPDATE）の対象のレコードの ID と、成功の後に取れた ID。
    target: '更新の対象のレコード',
    obtainedId: '取れた ID',
    readVerification: '照合の READ',
    reservation: '予約の締め',
    recordedAt: '記録した日時',
    submittedAt: '送った日時',
    settledAt: '締めた日時',
  },
  notApplicable: 'なし',
  submittedValuesHeading: '送った値（合成のテストデータ）',
  noSubmittedValues: '送った値はありません。',
  openJob: 'ジョブを開く',
} as const);

/**
 * 書き込みの報告（`action-report.html` と書き込みのバンドルの目録。Task 32 の設計書 4.1。T32f）の文言。画面と同じ意味の文言は、`LOCAL_UI_WRITE_TEXT`
 * の値をそのまま使う（同じ文を 2 か所に書かない）。
 */
export const ACTION_REPORT_TEXT = deepFreeze({
  title: '書き込みの報告',
  humanEnteredValuesHeading: '人が入れた値が入りうる報告です',
  humanEnteredValuesBody:
    'この報告には、更新の前に画面から読んだ値や、照合の READ で画面から読んだ値が入っています。これらは BeakSight が作った値ではなく、テスト環境で人が入れた値かもしれません。共有する前に、中身を確かめてください。',
  /** 書き込みのバンドルの目録（`manifest.json`）に書く注意。 */
  bundleHumanEnteredValuesNotice:
    'このバンドルには、更新の前に画面から読んだ値や、照合の READ で画面から読んだ値が入っています。テスト環境で人が入れた値かもしれません。共有する前に、中身を確かめてください。',
  /** 結果ごとの先頭のお知らせ（ここにない結果には出さない）。 */
  resultNotices: {
    UNKNOWN: { heading: LOCAL_UI_WRITE_TEXT.unknownHeading, body: LOCAL_UI_WRITE_TEXT.unknownBody },
    PARTIAL: { heading: LOCAL_UI_WRITE_TEXT.partialHeading, body: LOCAL_UI_WRITE_TEXT.partialBody },
  },
  sections: {
    notices: '注意',
    summary: '結果',
    precheck: '送る前の確かめ',
    submission: '送信',
    response: '応答',
    update: LOCAL_UI_WRITE_TEXT.diffHeading,
    readVerification: '照合の READ',
    guard: '送信の見張り（Guard）の記録',
    approval: '承認の要約',
    decisions: '人が決めたことと、BeakSight が自動で行ったこと',
  },
  labels: {
    result: LOCAL_UI_WRITE_TEXT.columns.result,
    reason: LOCAL_UI_WRITE_TEXT.columns.reason,
    kind: '種類',
    job: LOCAL_UI_WRITE_TEXT.columns.job,
    run: 'Run',
    scenario: LOCAL_UI_WRITE_TEXT.scenario,
    revision: LOCAL_UI_WRITE_TEXT.revision,
    grant: '実行の許可',
    recordId: LOCAL_UI_WRITE_TEXT.columns.recordId,
    reservation: '予約の締め（ワーカーの判定）',
    startedAt: '始めた日時',
    finishedAt: '終えた日時',
    candidateDigest: '画面の候補',
    blockReason: LOCAL_UI_WRITE_TEXT.columns.blockReason,
    submission: LOCAL_UI_WRITE_TEXT.columns.submission,
    actionPath: LOCAL_UI_WRITE_TEXT.action,
    submittedAt: LOCAL_UI_WRITE_TEXT.columns.submittedAt,
    httpStatus: LOCAL_UI_WRITE_TEXT.columns.httpStatus,
    judgement: LOCAL_UI_WRITE_TEXT.columns.responseJudgement,
    judgedAt: '判定した日時',
    target: LOCAL_UI_WRITE_TEXT.columns.target,
    readCheck: 'READ の確かめの定義',
    readResult: LOCAL_UI_WRITE_TEXT.columns.readVerification,
    readDetail: '詳しい理由',
    readUrl: '読んだ URL',
    receipt: '承認の記録',
    approvalDigest: '承認の digest',
    approvedAt: '承認した日時',
    expiresAt: '承認の期限',
    approver: '承認者',
    revokedAtStart: '始めた時点で撤回されていた',
    inputRule: '入力の規則の参照',
    limits: '件数の上限',
    approvalTtlDays: '承認の期限の日数',
    grantIssuedAt: '許可を出した日時',
    grantExpiresAt: '許可の期限',
    grantConsumedAt: '許可を使った日時',
    reservationCount: '予約した件数',
    reservedAt: '予約した日時',
    cumulative: LOCAL_UI_WRITE_TEXT.cumulative,
    capturedAt: '要約を読んだ日時',
  },
  atStartNote:
    '承認の要約の値は、書き込みを始めた時点のものです。予約の締めと累積の件数の確定の値は、管理画面の書き込みの結果で確かめてください。',
  candidateDigest: {
    matched: '承認した候補と同じでした',
    notMatched: '承認した候補と違いました',
    notChecked: '確かめまで進みませんでした',
  },
  submittedValuesHeading: LOCAL_UI_WRITE_TEXT.submittedValuesHeading,
  noSubmittedValues: LOCAL_UI_WRITE_TEXT.noSubmittedValues,
  valueColumns: { field: LOCAL_UI_WRITE_TEXT.diffColumns.field, value: '値' },
  diffNote: LOCAL_UI_WRITE_TEXT.diffNote,
  diffColumns: LOCAL_UI_WRITE_TEXT.diffColumns,
  changedDiffHeading: LOCAL_UI_WRITE_TEXT.changedDiffHeading,
  keptDiffHeading: LOCAL_UI_WRITE_TEXT.keptDiffHeading,
  noUpdateEvidence: LOCAL_UI_WRITE_TEXT.noUpdateEvidence,
  matchedValue: LOCAL_UI_WRITE_TEXT.matchedValue,
  notMatchedValue: LOCAL_UI_WRITE_TEXT.notMatchedValue,
  undeterminedValue: LOCAL_UI_WRITE_TEXT.undeterminedValue,
  readNotExecuted: '照合の READ は行っていません（送らなかった、結果が成功でなかった、または更新の後の照合で止めました）。',
  expectationsHeading: '期待ごとの結果',
  expectationColumns: { kind: '期待の種類', expected: '期待', result: '結果', observed: '読んだ値' },
  /** 詳細の項目の期待（項目の名前と値）。 */
  detailExpectation: (field: string, value: string): string => `${field} = ${value}`,
  found: '含んでいた',
  notFound: '含んでいなかった',
  noGuard: '書き込みの段に入っていません。',
  guardLabels: {
    blockedByOtherRulesInWindow: '送信の窓の中で止めた要求',
    submissionWindowOpen: '終わりの時点で送信の窓が開いていた',
    documentCharsetRead: '文書の文字コードを読めた',
    responseDeliveryCanceled: '応答を画面に返せなかった',
    /** 送信の段だけの理由で止めた要求の数（理由のコード）。 */
    blockedByReason: (code: string): string => `送信の段で止めた要求（${code}）`,
    /** 送る中身の照合で止めた要求の数（理由のコード）。 */
    blockedByPayloadReason: (code: string): string => `送る中身の照合で止めた要求（${code}）`,
  },
  yes: 'はい',
  no: 'いいえ',
  none: LOCAL_UI_WRITE_TEXT.notApplicable,
  /** 件数の上限（`perRunText`・`cumulativeText` は `formatInteger` の結果）。 */
  limitsValue: (perRunText: string, cumulativeText: string): string => `1 回の Run で ${perRunText} 件・累積で ${cumulativeText} 件まで`,
  /** 累積の件数（`usedText`・`limitText` は `formatInteger` の結果）。 */
  cumulativeValue: (usedText: string, limitText: string): string => `使った件数 ${usedText} / 上限 ${limitText}`,
  /** 承認の期限の日数（`daysText` は `formatInteger` の結果）。 */
  approvalTtlDaysValue: (daysText: string): string => `${daysText} 日`,
  /** 入力の規則の参照（`revisionText` は `formatInteger` の結果）。 */
  inputRuleValue: (ruleSetId: string, revisionText: string, digest: string): string => `${ruleSetId}（版 ${revisionText}）・${digest}`,
  sideEffectsHeading: '副作用の確認',
  sideEffectColumns: { item: '項目', confirmed: '確かめたか' },
  sideEffectConfirmed: '確かめた',
  sideEffectNotConfirmed: '確かめていない',
  humanDecisionsHeading: '人が決めたこと',
  automatedActionsHeading: 'BeakSight が自動で行ったこと',
} as const);

/**
 * 書き込みの報告の配布（T32g。Task 32 の設計書 4.1 の「親の確かめと画面の配布」）の画面の文言。ジョブの詳細の書き込みの結果と、シナリオの
 * 書き込みの履歴と、ジョブの成果物の一覧が使う。親の確かめの結果の表示は `WRITE_REPORT_CHECK_CATALOG`。
 */
export const LOCAL_UI_WRITE_REPORT_TEXT = deepFreeze({
  heading: '書き込みの報告',
  /** 書き込みの履歴の列の見出し。 */
  column: '報告',
  checkLabel: '報告の確かめ',
  openReport: '報告を開く',
  downloadBundle: '報告の ZIP をダウンロードする',
  notDistributed: '報告は配りません。書き込みの結果は、この画面の結果の欄で確かめてください。',
  notChecked: '報告はまだ確かめていません（書き込みが終わっていないか、結果の前にワーカーが終わりました）。報告は配りません。',
  /** 書き込みの履歴の、配らない報告の欄。 */
  notDistributedShort: '配らない',
  /** ジョブの詳細の成果物の一覧のリンク。 */
  artifacts: {
    openActionReport: '書き込みの報告（HTML）を開く',
    downloadActionEvidenceJson: 'action-evidence.json をダウンロードする',
    downloadApprovalSummaryJson: 'approval-summary.json をダウンロードする',
    downloadActionBundle: '書き込みの報告のバンドル（ZIP）をダウンロードする',
  },
} as const);

/**
 * 監査済みデータの台帳の画面（T32g。Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）の文言。台帳は画面だけで、書き出しの
 * ファイルは作らない。
 */
export const LOCAL_UI_LEDGER_TEXT = deepFreeze({
  pages: {
    ledger: '監査済みデータの台帳',
  },
  profileDetail: {
    open: '監査済みデータの台帳を開く',
  },
  notEligible: '監査済みデータの台帳は、承認した書き込みのモード（TEST_APPROVED_WRITE）のプロファイルだけで出します。',
  note: 'BeakSight は、登録したデータを削除も復元もしません。テスト環境のデータの片付けは、この台帳をもとに、テスト環境の管理者が行ってください。',
  entriesHeading: '登録（CREATE）',
  entriesNote: '送らずに止めた回は入れません。送ったか分からない回（登録したかもしれない回）は入れます。新しい順です。',
  noEntries: 'まだ登録はありません。',
  columns: {
    recordId: '登録の ID',
    scenario: 'シナリオと版',
    seed: 'seed の記録（許可の ID と規則の digest）',
    job: 'ジョブと Run',
    verification: '照合の状態',
    updates: 'この ID への UPDATE',
    recordedAt: '記録した日時',
  },
  scenariosHeading: '件数（シナリオごと）',
  noScenarios: 'まだシナリオはありません。',
  scenarioColumns: {
    scenario: 'シナリオ',
    kind: '種類',
    revision: '版',
    cumulative: '累計の件数と上限',
  },
  notObtained: '取れていない',
  notApplicable: 'なし',
  /** シナリオの版（`revisionText` は `formatInteger` の結果）。 */
  revisionValue: (revisionText: string): string => `版 ${revisionText}`,
  /** UPDATE の回数（`countText` は `formatCount` の結果）。 */
  updateCountValue: (countText: string): string => `${countText} 回`,
  lastUpdateLabel: '最後の結果',
  /** 累計の件数と上限（`usedText`・`limitText` は `formatCount` の結果）。 */
  cumulativeValue: (usedText: string, limitText: string): string => `${usedText} / 上限 ${limitText}`,
  cumulativeNote: '累計の件数は、実行の許可の判定と同じ数え方です（送ったか分からない回を含みます）。',
  openScenario: 'シナリオを開く',
  openJob: 'ジョブを開く',
  backToProfile: 'プロファイルに戻る',
} as const);
