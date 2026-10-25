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
import type { BeakSightBlockRelationReason } from '../core/beaksight-block-relation.js';
import type { IncompleteReasonCode, JobSafetyViolationStage } from '../core/contracts.js';
import type {
  BLOCKED_REQUEST_REASONS,
  InteractionReasonCode,
  SessionLossBlockedRequestReason,
  SessionLossKeyChange,
  SessionLossLandedBy,
  SessionLossOriginKind,
  SessionLossStorageKind,
} from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_CRAWL_MAX_PAGES, REPORT_RULE_DIGEST_EXAMPLE_COUNT } from '../core/limits.js';

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

/**
 * BN-c（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3）: レスポンシブの幅の確認から作った layout の指摘の文（Rule の文の頭に、確かめた幅を
 * 付ける）。`widthText` は書式（`formatPixels`）にかけた幅。文を組むのは layout の Rule（`src/audit/layout-rules.ts`）で、幅の読み込みと指摘を結び付ける判定
 * （`src/report/beaksight-block-relation.ts`）も、この関数で頭の文を作って照らす（文の形を 1 か所にする）。
 */
export const stressWidthFindingMessageText = (widthText: string, message: string): string => `レスポンシブの幅 ${widthText} の確認で、${message}`;

/**
 * BN-c: 指摘と BeakSight の遮断の関係の理由のコード（`BEAKSIGHT_BLOCK_RELATION_REASONS`）ごとの、日本語の説明。HTML レポートの Finding の行が使う（バンドルの JSON は
 * コードのまま）。
 */
export const BEAKSIGHT_BLOCK_RELATION_REASON_DESCRIPTIONS = deepFreeze({
  TARGET_REQUEST_BLOCKED: '指摘の対象の要求を、BeakSight が止めました。',
  TARGET_NAVIGATION_BLOCKED: '行き先のページの移動を、BeakSight が止めました。',
  MAIN_FRAME_NAVIGATION_BLOCKED: 'BeakSight が画面の移動を止めた後に、エラーの画面を測ったことが、記録から分かります。',
  MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED: 'BeakSight が画面の移動を止めました。測ったのが止めた後のエラーの画面かは、記録からは分かりません（止めたのが測った後のこともあります）。',
  TARGET_REQUEST_PARTLY_BLOCKED: '指摘の対象の要求の一部を、BeakSight が止めました。',
  FETCH_FAILED_WITH_DATA_BLOCK: '同じ読み込みで、BeakSight がデータの要求（fetch・xhr）を止めました（どの呼び出しの失敗かは記録にありません）。',
  DISABLED_FEATURE: 'BeakSight が無効にした機能（SharedWorker）を、ページが呼びました。',
  SENSITIVE_KIND_BLOCKED: '同じ読み込みの間（閉じ始める前）に、この Rule の結果を変えうる種類の要求を、BeakSight が止めました。',
  NO_BLOCK_IN_LOAD: '結び付く読み込みの間（閉じ始める前）に、BeakSight は見える種類の要求を止めていません。',
  RULE_NOT_SENSITIVE: 'BeakSight は要求を止めましたが、この Rule の結果を変えうる種類ではありません。',
} as const satisfies Record<BeakSightBlockRelationReason, string>);

/** BN-c: 指摘と BeakSight の遮断の関係の理由の説明。 */
export const describeBeakSightBlockRelationReason = (reason: BeakSightBlockRelationReason): string =>
  BEAKSIGHT_BLOCK_RELATION_REASON_DESCRIPTIONS[reason];

/** BN-R0 の M-3: SAFETY の Finding の、止めた事象の時点の印に添える件数（引数は書式にかけた件数）。 */
export const blockedEventPhaseCountText = (count: string): string => `事象 ${count}`;

/** BN-d: CLI の要約の、BeakSight の遮断と結び付く指摘の行（ラベルと、本体から外したことの添え書き）。 */
export const BEAKSIGHT_BLOCK_RELATION_SUMMARY_TEXT = deepFreeze({
  label: 'BeakSight の遮断と結び付く指摘',
  /** 値（引数は区分の別の件数を並べた文）。 */
  value: (counts: string): string => `${counts}（ChatGPT 用バンドルの本体から外しました）`,
} as const);

/** Guard が要求を止めた理由（T35a）。 */
type BlockedRequestReason = (typeof BLOCKED_REQUEST_REASONS)[number];

/** 未完了の理由のコードごとの、日本語の説明。 */
export const INCOMPLETE_REASON_DESCRIPTIONS = deepFreeze({
  DEADLINE_EXCEEDED: 'Evidence の収集が、期限までに終わりませんでした。',
  EVALUATION_FAILED: 'ページの中で Evidence を集める処理が、失敗しました。',
  PAGE_CLOSED: 'Evidence の収集の途中で、ページが閉じられました。',
  NAVIGATION_FAILED: 'ページを開けませんでした。',
  DOM_READINESS_FAILED: 'ページの DOM の準備ができるのを、待てませんでした。',
  SCROLL_TARGET_UNRESOLVED: 'ページの内容がビューポートより大きいのに、スクロールする要素を特定できませんでした。',
  SCROLL_NOT_ADVANCED: 'スクロールを求めても、スクロールの位置が進みませんでした。',
  // T44c（Task 44 の設計書 P1-4）: 理由を詳しくした（次にできることは `INCOMPLETE_REASON_NEXT_STEPS`）。
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED:
    'この画面で最も大きくスクロールできるのは、読み込みの後に動く内側のスクロールの領域でした。BeakSight は画面の全体だけをたどるので、その領域の中は全部は確かめていません（領域の中の内容の指摘が欠けているかもしれません）。',
  INNER_SCROLL_SCAN_LIMIT_REACHED: '内側のスクロール領域を探す処理が上限に達し、領域がないことを確かめられませんでした。',
  SCROLL_TARGET_UNSTABLE: 'スクロールの対象を切り替えてたどり直した後も、対象が定まりませんでした。',
  POSITION_NOT_AT_ORIGIN: 'スクロールの後に、ページの先頭へ戻せませんでした。',
  LAYOUT_COMPARISON_LIMIT_REACHED: 'レイアウトの重なりの確認が、比べる組の数の上限に達して止まりました。',
  RESOURCE_LIMIT_REACHED: 'リソースの読み込みの記録が、件数の上限に達しました。',
  INVALID_BROWSER_DATA: 'ブラウザから返った値が、不正でした。',
  // DEF-129。
  PAGE_NAVIGATION_LIMIT_REACHED: '画面自身や画面の中の枠（iframe）の読み込み直しや移動が、決まった回数を超えたため止めました（その画面は読み切れていません）。',
  // DEF-130-fix。
  PAGE_SUBRESOURCE_LIMIT_REACHED: '画面が出す画像やデータの読み込みなどの要求が、1 画面あたりの決まった数を超えたため止めました（その画面は読み切れていません）。',
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
  // T35a（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限。
  SERVICE_REQUEST_LIMIT_REACHED: '承認したサービスの Origin への要求の上限（1 分あたりか、1 回の Run あたり）に届いたため、その要求を止めたか、それより後の監査を始めませんでした。',
} as const satisfies Record<IncompleteReasonCode, string>);

/**
 * Guard が要求を止めた理由（`src/core/evidence-types.ts` の `BLOCKED_REQUEST_REASONS`）ごとの、日本語の説明（T35a。Task 35 の設計書 3.2、3.4）。
 */
export const BLOCKED_REQUEST_REASON_DESCRIPTIONS = deepFreeze({
  NON_READ_METHOD: '読み取りでない送信（GET と HEAD のほか）を止めました。',
  SERVICE_REQUEST_LIMIT_REACHED: '承認したサービスの Origin への要求の上限（1 分あたりか、1 回の Run あたり）に届いたため、止めました。',
  // T35R-fix（T35R の C-1）: 幅の走査と Interaction の読み込みでは、承認したサービスの Origin へ送らない。
  SERVICE_ORIGIN_REVISIT: '幅の走査と操作の確かめの読み込みでは、承認したサービスの Origin（API など）へ送りません（API の読み取りは Desktop と Mobile の最初の読み込みだけです）。',
  // DEF-129: ページ自身の読み込み直しや移動の回数の上限。
  PAGE_NAVIGATION_LIMIT_REACHED: '画面自身や画面の中の枠（iframe）の読み込み直しや移動が、決まった回数を超えたため、止めました（その画面は読み切れていません）。',
  // DEF-130-fix: 1 画面の読み込みあたりの、ページが出す文書でない要求の数の上限。
  PAGE_SUBRESOURCE_LIMIT_REACHED: '画面が出す画像やデータの読み込みなどの要求が、1 画面あたりの決まった数を超えたため、止めました（その画面は読み切れていません）。',
  // AS-a: 監査の段の送信の扱い（削除のほかは通す）で、1 回の読み込みで通す数の上限。
  AUDIT_SEND_OVER_LIMIT: '画面が出す書き込みの送信が、1 回の読み込みで通す決まった数を超えたため、止めました。',
  // T44R の I-1: 閉じる前にページを離れた後の、画面が出す要求の上限と、離れた後の画面の読み込み。
  PAGE_LEAVE_REQUEST_LIMIT_REACHED: '閉じる前に画面を離れた後に、画面が出す要求が決まった数を超えたか、画面を読み込み直そうとしたため、止めました（その画面の読み取りは、離れる前に終わっています）。',
} as const satisfies Record<BlockedRequestReason, string>);

/**
 * T44R2 の M-7: Guard が要求を止めた理由の説明（止めた要求の理由でなければ `null`）。HTML レポートの Safety の事象の一覧の、止めた要求の行の理由の欄が使う
 * （表示はこの 1 か所。画面のセッションの切れの表は `SESSION_LOSS_BLOCKED_REQUEST_REASON_DESCRIPTIONS`）。
 */
export const describeBlockedRequestReason = (reason: string): string | null =>
  Object.hasOwn(BLOCKED_REQUEST_REASON_DESCRIPTIONS, reason)
    ? BLOCKED_REQUEST_REASON_DESCRIPTIONS[reason as BlockedRequestReason]
    : null;

/** 未完了の理由のコードの、日本語の説明。 */
export const describeIncompleteReason = (code: IncompleteReasonCode): string => INCOMPLETE_REASON_DESCRIPTIONS[code];

/** T44h の判断 (1): BeakSight の不具合と見られる理由の、次にできること（`where` は詳しい内容のある記録）。 */
// T44R2 の M-11: 宛先は「BeakSight の開発者」（BeakSight はローカルの道具で、窓口の仕組みはない）。
const reportDefectNextStepOf = (where: string): string =>
  `もう一度監査してください。続けて起きるときは、BeakSight の不具合と見られます。${where}の理由の詳しい内容を添えて、BeakSight の開発者に知らせてください。`;
/** T44h の判断 (1): 安全の違反で止まったときの、レポートの次にできること（画面の文は `SAFETY_STOP_NEXT_STEP_TEXT`）。 */
const SAFETY_STOP_REPORT_NEXT_STEP_TEXT = 'レポートと page.json の安全の記録で、違反の中身を確かめてください。原因を直すまで、同じ設定で監査し直さないでください。';
/** T44h の判断 (1): 確かめきれなかった部分を、人が確かめる手順。 */
const MANUAL_PAGE_CHECK_TEXT = 'そのページをブラウザで開き、確かめきれなかった部分を手で確かめてください';
/** T44h の判断 (1): もう一度監査して、続けて起きるときは手で確かめる手順（`cause` は起きやすい場面）。 */
const retryThenManualOf = (cause: string): string => `${cause}もう一度監査してください。続けて起きるときは、${MANUAL_PAGE_CHECK_TEXT}。`;
/** T44h の判断 (1): 出力先のフォルダを確かめる手順（`then` は、その後にすること）。 */
const outputFolderNextStepOf = (then: string): string =>
  `出力先（設定のファイルの output.directory）のフォルダに書けるか（空きの容量、権限、ほかのプログラムが開いていないか）を確かめてから、${then}。`;
/**
 * EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.2・3.5）: 始める前の確認の項目 `EXTERNAL_LAUNCH_BLOCK`（起動の部品の自己検査の
 * 不合格。閉じた理由 `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）で止まったときの、次にできることに足す文。理由の詳細（`detail`）は技術的な詳細として示す。
 */
/**
 * EL-F（設計書 `2026-10-24-beaksight-external-launch-block-design.md`。EL-R の M2）: Chromium の起動の部品が、既定の Context の頁に置く「BeakSight の内部の窓」
 * の文（`src/browser/chromium-launch.ts` の `BEAKSIGHT_INTERNAL_WINDOW_URL`。headed で最小化して残る窓）。HTML の特別な文字を含めない（そのまま頁に埋める）。
 */
export const BEAKSIGHT_INTERNAL_WINDOW_TEXT = deepFreeze({
  title: 'BeakSight の内部の窓',
  body: 'BeakSight の内部の窓です（外部のアプリを開かせない設定の確かめに使いました）。どこへも通信しません。監査の間は、この窓を閉じないでください。',
} as const);
const PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT =
  '理由の詳細が EXTERNAL_LAUNCH_BLOCK のときは、メールや電話などの外部のアプリを開かせない Chromium の設定が、この PC で効きませんでした（PC の管理の設定が上書きしている場合など）。PC の管理者に確かめてください。';

/**
 * T44c（Task 44 の設計書 P1-4）: 未完了の理由ごとの、利用者が次にできることの文（理由の説明 `INCOMPLETE_REASON_DESCRIPTIONS` の後に出す）。
 * T44h の判断 (1)（設計書の履歴の「T44h の測りとユーザーの判断」の行）: すべての理由のコード（ページの理由と、Run の閉じた一覧の外の理由）に足した。網羅は型
 * （`satisfies Record<IncompleteReasonCode, string>`）で確かめる。CLI でも作る HTML レポートの文なので、画面の操作の名前は書かない（画面の文は
 * `LOCAL_UI_JOB_NEXT_STEPS.runReasons`。画面は、そこに載せていない理由にこの文を使う）。
 */
export const INCOMPLETE_REASON_NEXT_STEPS = deepFreeze({
  DEADLINE_EXCEEDED: retryThenManualOf('読み込みの遅い画面で起きます。サイトが混んでいない時間に、'),
  EVALUATION_FAILED: retryThenManualOf('画面のスクリプトが収集を妨げることがあります。'),
  PAGE_CLOSED: retryThenManualOf('画面が自分で閉じる作り（window.close など）のことがあります。'),
  NAVIGATION_FAILED: 'そのページの URL をブラウザで開けるか、サイトが応答しているかを確かめてから、もう一度監査してください。',
  // T44R2 の I-7: この理由は、読み込みの落ち着きの待ち（期限は `crawl.resourceSettlingTimeoutMs`）が PARTIAL のときに付く（`page-auditor.ts`）。
  DOM_READINESS_FAILED:
    'サイトが応答しているかを確かめてから、もう一度監査してください。続けて起きるときは、設定のファイルのリソースの読み込みが落ち着くのを待つ期限（crawl.resourceSettlingTimeoutMs）を長くしてください。',
  SCROLL_TARGET_UNRESOLVED: 'ページの下の方は、確かめきれていないことがあります。そのページをブラウザで開き、下までスクロールして手で確かめてください。',
  SCROLL_NOT_ADVANCED: 'スクロールを止める作り（スクロールの固定など）の画面で起きます。そのページをブラウザで開き、下までスクロールして手で確かめてください。',
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED:
    'その領域の中に確かめたい内容があれば、ブラウザで画面を開き、その領域をスクロールして手で確かめてください。',
  INNER_SCROLL_SCAN_LIMIT_REACHED: '要素の多い画面で起きます。内側のスクロールの領域があれば、ブラウザで画面を開き、その領域をスクロールして手で確かめてください。',
  SCROLL_TARGET_UNSTABLE: '読み込みの後に形が変わる画面で起きます。そのページをブラウザで開き、表示が落ち着いてから、スクロールして手で確かめてください。',
  POSITION_NOT_AT_ORIGIN: 'スクロールした後の先頭の表示は、確かめきれていないことがあります。そのページをブラウザで開き、先頭の表示を手で確かめてください。',
  LAYOUT_COMPARISON_LIMIT_REACHED: '要素の多い画面では、重なりの指摘の一部が欠けていることがあります。重なりが気になる場所は、ブラウザで画面を開いて手で確かめてください。',
  RESOURCE_LIMIT_REACHED: '読み込みの多い画面では、性能の指摘の一部が欠けていることがあります。読み込みの量は、ブラウザの開発者ツールで確かめてください。',
  INVALID_BROWSER_DATA: reportDefectNextStepOf('page.json'),
  PAGE_NAVIGATION_LIMIT_REACHED:
    '画面が自分で読み込み直しや移動を繰り返す作りです。そのページをブラウザで開き、表示が落ち着くかを確かめてください。認証つきの監査では、そのパスを認証の設定の「読まないパス」に足すと、次から読みません。',
  PAGE_SUBRESOURCE_LIMIT_REACHED: '画面が多くの画像やデータを読み込む作りです。そのページをブラウザで開き、表示の内容を手で確かめてください。',
  PREFLIGHT_FAILED: `ブラウザ（Chromium）を起動できるか、出力先のフォルダに書けるかを確かめてから、もう一度監査してください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`,
  RUN_DIRECTORY_UNAVAILABLE: outputFolderNextStepOf('もう一度監査してください'),
  SAFETY_INVARIANT_VIOLATION: SAFETY_STOP_REPORT_NEXT_STEP_TEXT,
  SAFETY_LEDGER_TRUNCATED:
    '止めた要求が多すぎる画面があります。安全の記録で止めた要求の多いページを確かめ、範囲を狭めて（認証つきの監査では「読まないパス」に足すなど）、もう一度監査してください。',
  UNHANDLED_FAILURE: reportDefectNextStepOf('run.json と page.json'),
  MAX_PAGES_REACHED: '残りのページも監査するには、設定のファイルのページの上限（crawl.maxPages）を上げてから、もう一度監査してください。',
  MAX_DEPTH_REACHED: 'もっと深いページも監査するには、設定のファイルのリンクの深さの上限（crawl.maxDepth）を上げてから、もう一度監査してください。',
  MAX_RUNTIME_REACHED: '残りのページは、続きから再開すると監査します。1 回で長く監査するには、設定のファイルの時間の上限（crawl.maxRuntimeMs）を上げてください。',
  REQUIRED_ARTIFACT_INVALID: `この Run の出力の一部は使えません。${reportDefectNextStepOf('run.json')}`,
  EXECUTION_INCOMPLETE: '監査を始めなかったページがあります。終わり方の理由（時間の上限、止める指示など）を確かめ、続きから再開するか、もう一度監査してください。',
  REQUIRED_WORK_SKIPPED: `行わなかった確認は、ページの理由の詳しい内容で分かります。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_BLOCKED: `安全のために止めた確認です（BeakSight は送信を伴う操作をしません）。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_TIMED_OUT: retryThenManualOf('読み込みの遅い画面で起きます。サイトが混んでいない時間に、'),
  REQUIRED_WORK_NOT_OBSERVED: `結果が画面に出なかった確認です。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_NOT_VERIFIED: `結果を確かめられなかった確認です。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_FAILED: retryThenManualOf(''),
  COLLECTOR_INCOMPLETE: retryThenManualOf('欠けた確認は、理由の詳しい内容（段階と理由）で分かります。'),
  RULE_EVALUATION_FAILED: reportDefectNextStepOf('page.json'),
  PAGE_CRASHED: retryThenManualOf('画面が重いか、記憶域が足りないことがあります。ほかのプログラムを閉じてから、'),
  SAFETY_VIOLATION_ABORT: SAFETY_STOP_REPORT_NEXT_STEP_TEXT,
  CHECKPOINT_WRITE_FAILED: outputFolderNextStepOf('続きから再開してください'),
  RUN_INTERRUPTED: '残りのページは、続きから再開すると監査します。',
  SITE_UNAVAILABLE: 'サイトが応答するようになったことを確かめてから、続きから再開してください。',
  AUTH_SESSION_LOST:
    'ログインの状態が切れたページのパスを、認証の設定の「読まないパス」に足すと、次から読みません。残りのページは、続きから再開すると監査します。',
  SERVICE_REQUEST_LIMIT_REACHED: '認証の設定の、サービスの Origin への要求の上限を見直してから、続きから再開してください。',
} as const satisfies Record<IncompleteReasonCode, string>);

/** T44c: 未完了の理由のコードの、次にできること（T44h の判断 (1) から、すべての理由にある）。 */
export const nextStepOfIncompleteReason = (code: IncompleteReasonCode): string => INCOMPLETE_REASON_NEXT_STEPS[code];

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

/** ページの網羅の項目（`RUN_SUMMARY_TEXT.coverage` の鍵）。 */
export type PageCoverageItem = keyof typeof RUN_SUMMARY_TEXT.coverage;

/**
 * T44R2 の M-8: ページの網羅の項目の並び（HTML レポートの要約、CLI の結果の行、ChatGPT 用のバンドルの README の、どれもこの順）。並びはここの 1 か所だけに書く。
 */
export const PAGE_COVERAGE_ITEMS = Object.freeze(['discovered', 'audited', 'partial', 'failed', 'skipped'] as const) satisfies readonly PageCoverageItem[];

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
  /** T44c: 未完了の理由の説明の後に出す、次にできること（`INCOMPLETE_REASON_NEXT_STEPS` の文）。 */
  reasonNextStep: (text: string): string => `次にできること: ${text}`,
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
    /** BN-d: BeakSight の遮断と指摘の関係の件数の説明と、バンドルの本体の指摘の件数の項目（区分の名前は `BEAKSIGHT_BLOCK_RELATION_CATALOG`）。 */
    blockRelationNote:
      'サイト品質の指摘を、BeakSight が止めた要求との関係で分けて数えます。「遮断が原因」と「遮断の影響の可能性」の指摘と安全の指摘は、ChatGPT 用バンドルの本体（findings.json）から外し、別のファイルに理由つきで残します。',
    blockRelationCount: (label: string): string => `サイト品質のうち「${label}」`,
    bundleMainFindings: 'ChatGPT 用バンドルの本体の指摘',
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

/**
 * DEF-172: ロック（開始のロック、Run のロック）の持ち主の起動が動いているのに、ロックが古く見えるので、取り直す前に、ロックが更新されるかを待って
 * 確かめる（`durationText` は待つ時間。`formatDuration` の書き方。例: `75秒`）。端末のスリープや時計の跳びの後に、動いている Run を取り直さないため。
 */
export const runLockGraceWaitText = (durationText: string): string =>
  `同じ出力先のロックの持ち主の起動が動いているため、ロックが更新されるかを最大 ${durationText}待って確かめます（スリープや時計のずれの後に、動いている Run を取り直さないためです）。`;

/**
 * DEF-170: Run を始めた後に、この Run のロックを別の起動が持った（ハートビートで分かった）。サイトへの読み込みを止め、Run のフォルダに書かずに
 * 終えた（終了コードは、別の起動が Run を持つときと同じ 4）。
 */
export const runLockLostText =
  'この Run のロックを別の起動が持ちました。サイトへの読み込みを止め、Run のフォルダには書かずに終わりました。同じ出力先で同時に BeakSight を動かしていないか確かめてください。';

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
 * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 監査の段の送信の扱いの文言（報告の HTML・CLI と、ジョブの画面が共用する）。扱いのラベルと
 * 説明は表示カタログ（`AUDIT_SEND_POLICY_CATALOG`）。目立つ形で出すかは表示用モデル（`summary.auditSend.prominent`）と画面が、カタログの `prominent` で決める。
 * - `passedNotice`: 通した数（`formatCount` の結果。例: `3件`）を添えた知らせ。
 * - `jobNotice`: 通した数を持たない記録（発見・READ の確かめの結果）の知らせ。
 */
export const AUDIT_SEND_TEXT = deepFreeze({
  label: '送信の扱い',
  passedNotice: (countText: string): string => `この監査では、ページが出す送信のうち削除のほかを通した（${countText}）`,
  /** AS-c: 通した数の内訳（ほかの Origin への送信の数と、WebSocket の接続の数。`formatCount` の結果）。 */
  passedDetail: (otherOriginCountText: string, webSocketCountText: string): string =>
    `うち、ほかの Origin への送信 ${otherOriginCountText}。ほかに WebSocket の接続 ${webSocketCountText}`,
  passedOtherOrigins: 'ほかの Origin へ通した送信',
  passedWebSockets: '通した WebSocket の接続',
  /**
   * AS-c fix round 1（C-1・C-2）: Guard の判定を通らずに開いた WebSocket の接続（ページのスクリプトが模擬を迂回した接続、Worker の中の接続）と、危険な語の
   * 接続の知らせ（`formatCount` の結果）。止められない接続で、ブラウザが開いた事実から数えた。
   */
  webSocketCaution: (outsideGuardCountText: string, dangerousCountText: string): string =>
    `WebSocket の接続のうち、Guard の判定を通らずに開いたもの ${outsideGuardCountText}、危険な語を含むもの ${dangerousCountText}（止められない接続です。ブラウザが開いた接続から数えました）`,
  passedWebSocketsOutsideGuard: 'Guard の判定を通らずに開いた WebSocket の接続',
  passedDangerousWebSockets: '危険な語を含む WebSocket の接続',
  jobNotice: 'このジョブでは、ページが出す送信のうち削除のほかを通しました（削除と危険な語の送信は止めました）。',
  passedCount: '通した送信',
  methodsCaption: '通した送信の件数（method ごと）',
  methodColumns: ['method', '件数'],
} as const);

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
 * 承認したサービスへの要求が 1 分あたりの上限に届いたので、次の読み込みの前に待つことを知らせる、実行中の1行（DEF-141。設計書
 * `2026-10-20-beaksight-service-request-pacing-design.md` 2.2）。`waitText` はこれから待つ時間、`totalText` はこれまでに待った時間の合計（どちらも
 * `formatDuration` の結果）、`waitCount` は待った回数（この待ちを含む）。値は知らせの事実のまま示す。
 */
export const serviceRequestPacingWaitText = (waitText: string, waitCount: number, totalText: string): string =>
  `サービスへの要求が 1 分あたりの上限に届いたため、次の読み込みの前に ${waitText}待ちます（${String(waitCount)} 回目。合計 ${totalText}）。`;

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
    action: 'Node.js 24 の最新の版（24.22.1 以上）を入れてから、もう一度実行してください。版は node -v で確かめられます。',
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
  // LG-2: 基準の版（`src/control/store/control-schema-v17.ts` の `CONTROL_SCHEMA_V17`）より前の版。文の版の数は、テストで基準の版と比べる。
  DATABASE_FROM_OLDER_VERSION: {
    description: 'この管理データは、前の版（管理データの版 17 より前）の BeakSight で作られています。この BeakSight は、版 17 より前の管理データを開けません。読み書きしていません。',
    action: `${CONTROL_RENAME_TO_RECREATE_TEXT}前のデータは、名前を変えたファイルに残ります。${CONTROL_FILES_KEPT_TEXT}`,
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

/**
 * T43b（Task 43 の設計書 4.2）: プロファイルの作成で、開始の URL と許可 Origin の欄の誤り（欄に出す）。一覧は `src/config/target-config-draft.ts` の
 * `TARGET_SITE_PROBLEMS` が持ち、書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_SITE_PROBLEM_DESCRIPTIONS = deepFreeze({
  START_URL_REQUIRED: '開始の URL を入力してください。',
  START_URL_INVALID: '開始の URL は、http:// か https:// で始まる URL にしてください（例: https://example.test/）。',
  START_URL_TOO_LONG: '開始の URL が長すぎます。短い URL にしてください。',
  START_URL_HAS_CREDENTIALS: '開始の URL に、ユーザー名やパスワード（@ の前の部分）を含めないでください。',
  START_URL_HAS_FRAGMENT: '開始の URL に、# から後ろの部分を含めないでください。',
  ALLOWED_ORIGINS_REQUIRED: '許可 Origin を 1 つ以上入力してください。',
  ALLOWED_ORIGIN_INVALID: '許可 Origin は、1 行に 1 つ、https://example.test のような Origin の形（末尾の / や path なし）で書いてください。',
  ALLOWED_ORIGINS_TOO_MANY: '許可 Origin が多すぎます。数を減らしてください。',
  ALLOWED_ORIGINS_MISSING_START: '許可 Origin に、開始の URL の Origin を入れてください。',
} as const);

/**
 * T43b（Task 43 の設計書 4.2）: 開始の URL から対象の設定のファイルを作れなかった理由ごとの説明と手順（フォームの上に出す）。一覧は
 * `src/config/target-config-draft.ts` の `TARGET_CONFIG_CREATION_FAILURES` が持ち、書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS = deepFreeze({
  TARGET_SITE_INVALID: {
    description: '開始の URL か許可 Origin に、誤りがあります。設定のファイルは作っていません。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  TARGET_CONFIG_INVALID: {
    description: '開始の URL と許可 Origin から作った設定が、設定の決まりに合いません。設定のファイルは作っていません。',
    action: '開始の URL と許可 Origin を確かめてから、もう一度保存してください。',
  },
  // T43R-fix-D（M-6）: Windows の予約名の名前と、置き場所がリンク（junction・symlink）であること。
  TARGET_CONFIG_NAME_RESERVED: {
    description: 'この名前（con、nul、aux、prn、com1〜com9、lpt1〜lpt9 など）は、Windows ではファイルの名前に使えません。設定のファイルもプロファイルも作っていません。',
    action: '別の名前にしてから、もう一度保存してください。',
  },
  TARGET_CONFIG_EXISTS: {
    description: '同じ名前の設定のファイル（local/targets/ の中の、名前と同じ .json）が、既にあります。上書きはしていません。プロファイルも作っていません。',
    action: '別の名前にするか、「すでにある設定のファイルを使う」を選んで、そのファイルを選んでください。',
  },
  TARGET_CONFIG_LOCATION_UNSAFE: {
    description: '設定のファイルを置くフォルダ（local か local/targets）が、ほかの場所へのリンク（junction・シンボリックリンク）か、フォルダではありません。何も書かずに止めました。プロファイルも作っていません。',
    action: 'local と local/targets を、リンクでない普通のフォルダにしてから、もう一度保存してください。',
  },
  TARGET_CONFIG_WRITE_FAILED: {
    description: '設定のファイルを書けませんでした。プロファイルは作っていません。',
    action: 'local/targets/ のフォルダに書けるかを確かめてから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * T44d（Task 44 の設計書 P2-1）: プロファイルの画面の「監査の負荷」の欄の値の誤りごとの説明（欄に出す）。一覧は `src/config/target-config-draft.ts` の
 * `TARGET_CRAWL_LIMIT_PROBLEMS`。書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS = deepFreeze({
  NOT_POSITIVE_INTEGER: '1 以上の整数にしてください。',
  NOT_NON_NEGATIVE_INTEGER: '0 以上の整数にしてください。',
  // T44R（Task 44 のレビューの M-3）: 上限の値は `MAX_CRAWL_MAX_PAGES`（設定の検証と同じ）。
  ABOVE_MAX_PAGES: `ページの上限は ${MAX_CRAWL_MAX_PAGES.toLocaleString('en-US')} ページまでです（設定の決まり）。`,
  BELOW_NAVIGATION_INTERVAL_FLOOR: '今の下限より短くはできません（サイトへの負荷の決まり）。下限は、欄の下に示しています。',
} as const);

/**
 * T44d: 「監査の負荷」を変えられなかった理由ごとの説明と手順（欄の上に出す）。一覧は `src/config/target-config-draft.ts` の
 * `TARGET_CRAWL_LIMITS_CHANGE_FAILURES`。書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS = deepFreeze({
  PROFILE_NOT_FOUND: {
    description: '対象のプロファイルが見つかりません。設定のファイルは変えていません。',
    action: 'プロファイルの一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したプロファイルの設定のファイルは、画面からは変えられません。',
    action: '使い続ける場合は、新しい名前でプロファイルを作り直してください。',
  },
  TARGET_CONFIG_NOT_EDITABLE: {
    description: 'この設定のファイルは、画面からは変えられません（画面から書くのは、local/targets/ の中の、名前と同じ .json だけです）。',
    action: '設定のファイルを直してください。',
  },
  TARGET_CONFIG_INVALID: {
    description: '設定のファイルを読めないか、内容が設定の決まりに合いません（変えた後の内容が合わない場合も含みます）。設定のファイルは変えていません。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度変えてください。',
  },
  CRAWL_LIMITS_INVALID: {
    description: '値に誤りがあります。設定のファイルは変えていません。',
    action: '表示された誤りを直してから、もう一度変えてください。',
  },
  CRAWL_LIMITS_UNCHANGED: {
    description: '値が今と同じです。設定のファイルは変えていません（書くと、承認したシナリオの承認が外れるため、同じ値では書きません）。',
    action: '変える値を入れてから、もう一度変えてください。',
  },
  TARGET_CONFIG_CHANGED: {
    description: 'この画面を開いた後に、設定のファイルが変わりました。上書きはしていません。',
    action: '画面を読み込み直して、今の値を確かめてから、もう一度変えてください。',
  },
  TARGET_CONFIG_LOCATION_UNSAFE: {
    description: '設定のファイルか、それを置くフォルダ（local か local/targets）が、ほかの場所へのリンク（junction・シンボリックリンク）か、ファイル・フォルダではありません。何も書かずに止めました。',
    action: 'local と local/targets と設定のファイルを、リンクでない普通のフォルダとファイルにしてから、もう一度変えてください。',
  },
  TARGET_CONFIG_WRITE_FAILED: {
    description: '設定のファイルを書けませんでした。今の設定のファイルは変えていません。',
    action: 'local/targets/ のフォルダに書けるかを確かめてから、もう一度変えてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** T44d（Task 44 の設計書 P2-1）: プロファイルの画面の「監査の負荷」（ページの上限・時間の上限・読み込みの間隔）の文言。 */
export const LOCAL_UI_CRAWL_LIMITS_TEXT = deepFreeze({
  heading: '監査の負荷',
  body: 'プロファイルが指す設定のファイルの、ページの上限・時間の上限・ページの読み込みの間隔です。変えると、設定のファイルを書き換えます（プロファイルの改訂は変わりません）。',
  targetConfigPath: '設定のファイル',
  notEditable: 'この設定のファイルは、画面からは変えられません（画面から書くのは、local/targets/ の中の、名前と同じ .json だけです）。変えるときは、設定のファイルを直してください。',
  unreadable: '設定のファイルを読めないか、内容が設定の決まりに合わないため、画面からは変えられません。設定のファイルを確かめてください。',
  /** 入力の欄のラベル（単位つき）。 */
  fields: {
    maxPages: 'ページの上限（ページの数）',
    maxRuntimeMs: '時間の上限（ミリ秒）',
    minNavigationIntervalMs: 'ページの読み込みの間隔（ミリ秒）',
  },
  /** 欄の下の、今の値（`valueText` は書式を整えた値）。 */
  currentValue: (valueText: string): string => `今の値: ${valueText}`,
  /** 読み込みの間隔の下限（`floorText` は `formatDuration` の結果）。 */
  intervalFloor: (floorText: string): string => `下限: ${floorText}（これより短くはできません。サイトへの負荷の決まり）`,
  review: '変更を確かめる',
  reviewing: '確かめています…',
  dialog: {
    title: '監査の負荷を変えますか',
    body: '設定のファイルの値を、次のとおりに変えます。',
    item: '項目',
    before: '変える前',
    after: '変えた後',
    confirm: '設定のファイルを書き換える',
    cancel: '変えずに戻る',
  },
  /** 書き込みのモードで、今承認が有効なシナリオがあるとき（`countText` は `formatCount` の結果）。 */
  approvalNotice: (countText: string): string =>
    `承認したシナリオ（${countText}）の承認が外れます。承認は設定のファイルの内容に結びついているため、書き込みを始める前に、もう一度承認してください。`,
  /**
   * 途中の Run は再開されない旨（いつも出す。途中の Run を探す部品は、画面のコードが読み込めない範囲にあるため、あるかどうかは示さない）。
   */
  resumeNotice:
    '途中で止まった Run があれば、設定が変わるため再開されません。次に監査を始めると、「前回の続きから再開する」を選んでも、新しい Run を始めます。',
  saved: '監査の負荷を変えました。',
  rejectedHeading: '監査の負荷を変えられませんでした',
  requestFailed:
    '画面のサーバとのやりとりで誤りが起きたため、確かめられませんでした（通信の誤りか、入力の検証の誤り）。画面のサーバが動いているかを、起動したコンソールで確かめてから、もう一度押してください。',
} as const);

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
  /** UI-close: 管理画面のブラウザが閉じられたので、画面のサーバを止めるとき（もう一度使うときの手順つき）。 */
  closedByUi: '管理画面が閉じられたので、画面のサーバを止めました。もう一度使うときは、npm run ui を実行してください。',
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
  // T34a（Task 34 の設計書 3.1）: 承認したサービスの Origin。
  PROFILE_SERVICE_ORIGIN_INVALID:
    '承認したサービスの Origin の形が正しくありません（https://… か、このコンピュータの http://…）。テスト環境の監査のモードだけで書けます。',
  PROFILE_SERVICE_ORIGIN_INSIDE_TARGET:
    '承認したサービスの Origin が、設定のファイルの監査の対象（allowedOrigins）に入っています。認証のサービスと API の Origin は、監査の対象の外の Origin だけを書いてください。',
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
    // T43b（Task 43 の設計書 4.2）: 開始の URL から対象の設定のファイルを作るか、すでにある設定のファイルを使うか（どちらか一方）。
    targetSource: '対象のサイトの設定',
    targetSourceNew: '開始の URL から新しく作る',
    targetSourceExisting: 'すでにある設定のファイルを使う',
    startUrl: '開始の URL',
    startUrlHint: '監査を始める画面の URL です（例: https://example.test/）。入れると、名前と許可 Origin の案を埋めます。案は、変えたい欄だけ直してください。',
    allowedOrigins: '許可 Origin（1 行に 1 つ）',
    allowedOriginsHint: '監査で読んでよいサイトの Origin です。開始の URL の Origin を案として埋めます。ほかの Origin を足すときは、1 行に 1 つ書きます。',
    generatedTargetConfig: '保存すると作る設定のファイル',
    // T43b fix round 2: 最初の読み込みのための控えめな負荷（`pagesText` はページの上限、`intervalText` は読み込みの間隔。値は
    // `src/config/target-config-draft.ts` の `GENERATED_TARGET_CRAWL_LIMITS`）。
    generatedTargetConfigNote: (pagesText: string, intervalText: string): string =>
      `最初の監査のため、読むページは ${pagesText} ページまで、ページの読み込みの間隔は ${intervalText} の控えめな設定で作ります。ほかの負荷と出力先は既定の値です。読む範囲を広げるときは、作ったファイルを直してください（この画面からは変えません）。同じ名前のファイルがあれば、上書きせずに止めます。`,
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
  // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない。
  WRITE_READ_VERIFICATION_PAGE_TARGET: {
    description: '照合の READ の定義が、画面の path を読む定義です。書き込みの照合には、読み取り（READ）の候補を読む定義だけを使えます。書き込みは送っていません。',
    action: 'シナリオの検証の指定で、候補を読む READ の確かめの定義を選び直し、承認と実行の許可を出し直してから、もう一度始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * DEF-146: 止める確認のダイアログ（`LOCAL_UI_AUDIT_TEXT.stopDialog`・`forceStopDialog`）の題と確定のボタンに入れる、止める対象の呼び名（ジョブの種類
 * `AUDIT_JOB_KINDS` ごと。網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる）。
 */
export const AUDIT_JOB_STOP_TARGET_NAMES = deepFreeze({
  AUDIT: '監査',
  LOGIN_CHECK: 'ログインの確かめ',
  DISCOVERY: '発見',
  READ_CHECK: 'READ の確かめ',
  WRITE_CREATE: '登録の書き込み',
  WRITE_UPDATE: '更新の書き込み',
  ENTRY_CHECK: '入口の確かめ',
} as const);

/** T44d: 監査のほかの種類のジョブの止め方の本文の、再開しない旨（`target` は `AUDIT_JOB_STOP_TARGET_NAMES` の値）。 */
const stopWithoutResumeText = (target: string): string => `止めた${target}は再開しません。もう一度行うときは、最初から始め直してください。`;

/**
 * T44d（Task 44 の設計書 P2-3。DEF-146 の残り）: 止める確認のダイアログ（`LOCAL_UI_AUDIT_TEXT.stopDialog`・`forceStopDialog`）の本文。ジョブの種類
 * （`AUDIT_JOB_KINDS`）ごとに、止めたときに何が起きるかを書く（`stop` はふつうの止め方、`force` は強制の止め方）。続きから再開できるのは監査だけ。
 * 書き込みは、送る直前の確かめ直しの後に止めると送る（`doc/spec/approved-create.md` の「確かめ直しの後の撤回」）。強制の止め方では、ワーカーの終わり方に
 * よって、送ったか分からない（`UNKNOWN`）で締めることがある。網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる。
 */
export const AUDIT_JOB_STOP_DIALOG_BODIES = deepFreeze({
  AUDIT: {
    stop: '今のページの監査を終えてから止めます。止めた Run は一部未完了になり、後で「前回の続きから再開する」を選んで開始すると、続きから再開します。',
    force: '今のページの監査を待たずに、すぐに止めます。再開のための保存は、最後に監査を終えたページまで残ります。',
  },
  LOGIN_CHECK: {
    stop: `ログインを送る前なら、送らずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.LOGIN_CHECK)}`,
    force: `待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.LOGIN_CHECK)}`,
  },
  DISCOVERY: {
    stop: `次の画面を読まずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY)}`,
    force: `今の画面を待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY)}`,
  },
  READ_CHECK: {
    stop: `次の定義を読まずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.READ_CHECK)}`,
    force: `今の読み込みを待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.READ_CHECK)}`,
  },
  WRITE_CREATE: {
    stop: `書き込みを送る前なら、送らずに止めます。送る直前の確かめ直しの後に止めたときは、そのまま送り、その回の結果を記録します。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_CREATE)}`,
    force: `待たずに、すぐに止めます。送った後に止めると、送ったか分からない（結果が分からない）として記録することがあります。そのときは、テスト環境でレコードの状態を確かめてください。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_CREATE)}`,
  },
  WRITE_UPDATE: {
    stop: `書き込みを送る前なら、送らずに止めます。送る直前の確かめ直しの後に止めたときは、そのまま送り、その回の結果を記録します。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_UPDATE)}`,
    force: `待たずに、すぐに止めます。送った後に止めると、送ったか分からない（結果が分からない）として記録することがあります。そのときは、テスト環境でレコードの状態を確かめてください。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_UPDATE)}`,
  },
  ENTRY_CHECK: {
    stop: `開始の URL を読む前なら、読まずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.ENTRY_CHECK)}`,
    force: `待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.ENTRY_CHECK)}`,
  },
} as const);

/**
 * T44d（設計の変更の履歴の T44d の行の P2-3 の残り）: 止める要求を送った後に、ジョブの画面に出す文（ジョブの種類ごと。止まり方は
 * `AUDIT_JOB_STOP_DIALOG_BODIES` の `stop` と同じ）。網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる。
 */
export const AUDIT_JOB_STOP_REQUESTED_TEXTS = deepFreeze({
  AUDIT: '止める要求を送りました。今のページの監査を終えてから止まります。',
  LOGIN_CHECK: '止める要求を送りました。ログインを送る前なら、送らずに止まります。',
  DISCOVERY: '止める要求を送りました。次の画面を読まずに止まります。',
  READ_CHECK: '止める要求を送りました。次の定義を読まずに止まります。',
  WRITE_CREATE: '止める要求を送りました。書き込みを送る前なら、送らずに止まります。',
  WRITE_UPDATE: '止める要求を送りました。書き込みを送る前なら、送らずに止まります。',
  ENTRY_CHECK: '止める要求を送りました。開始の URL を読む前なら、読まずに止まります。',
} as const);

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
 * 監査で、設定のファイルの `crawl.allowedQueryParameters` に秘密に見える名前があって始めなかったときの案内（T25f round 1）。ワーカーは
 * 設定のエラー（`CONFIG_ERROR`）で終えるので、`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR` の手順に足す。T44g（Task 44 の P4-1 の発見事項 4）:
 * 公開の監査も同じ理由で始めないので、文は公開の監査にも当てはまる形にした（名前は今のまま）。
 */
export const AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION =
  '公開の監査でも認証つきの監査でも、設定のファイルの crawl.allowedQueryParameters に、秘密に見える名前（token、session、code、state など）を入れられません。';

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
  // T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブの結果（`entry-check.json`）を読めなかったので、その案を使わずに止めた。
  ENTRY_CHECK_RESULT_INVALID: {
    description: '入口の確かめのジョブの結果のファイル（entry-check.json）を読めないか、形が正しくなかったため、その案は使いません。',
    action: 'もう一度「入口を確かめる」を始めてください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
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
  // T37d（Task 37 の設計書 3.5）: 画面の path の定義の理由。
  READ_PAGE_PATH_INVALID: {
    description: '画面の path の形が正しくありません。/ で始まり、? と # を含まない、URL の形のままの path（日本語や空白は %XX の形）だけを使えます。保存していません。',
    action: '直近の「操作の候補を探す」の結果の画面から選ぶか、ブラウザのアドレス欄に出る形の path を入れてから、もう一度保存してください。',
  },
  READ_PAGE_START_URL_UNKNOWN: {
    description: 'プロファイルの開始の URL を読めないため、画面の path から読む URL を決められません。保存していません。',
    action: 'ターゲット設定を読めるかを確かめてから、もう一度保存してください。',
  },
  READ_PAGE_ORIGIN_NOT_ALLOWED: {
    description: '開始の URL の Origin が、プロファイルで許可した Origin の外です。画面の READ は、開始の URL と同じ Origin の画面だけを読みます。保存していません。',
    action: 'プロファイルの許可した Origin とターゲット設定の開始の URL を見直してください。',
  },
  READ_PAGE_PATH_EXCLUDED: {
    description: 'その画面は、読まないパス、読む範囲の外、またはログインの画面です。読みません。保存していません。',
    action: '認証の設定の読まないパスと読む範囲を確かめ、読んでよい画面の path を選んでください。',
  },
  READ_PAGE_PATH_DANGEROUS_WORD: {
    description: '画面の path に、危険な語（logout、delete、remove、cancel など）があります。読みません。保存していません。',
    action: '危険な語を含まない画面の path を選んでください。',
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
  // DEF-136: 4xx・5xx の画面（候補もリンクも拾わない）。
  HTTP_ERROR_STATUS: '誤りの状態の画面（4xx・5xx）',
  MAX_PAGES_REACHED: 'ページの上限',
  MAX_RUNTIME_REACHED: '時間の上限',
  STOPPED: '止める要求',
  AUTH_SESSION_LOST: 'ログインの状態の切れ',
  // T37a（Task 37 の設計書 3.1）。
  SERVICE_REQUEST_LIMIT_REACHED: 'サービスへの要求の上限',
  // DEF-136。
  SITE_UNAVAILABLE: 'サイトが応答しない',
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
  // DEF-129。
  INCOMPLETE_PAGE_NAVIGATION_LIMIT:
    '画面自身や画面の中の枠（iframe）の読み込み直しや移動が、決まった回数を超えたため止めました。読んだ内容が途中のものかもしれないため、読めた分だけを示します。',
  // DEF-130-fix。
  INCOMPLETE_PAGE_SUBRESOURCE_LIMIT:
    '画面が出す画像やデータの読み込みなどの要求が、1 画面あたりの決まった数を超えたため止めました。画面がデータを描き切れなかったかもしれないため、読めた分だけを示します。',
  // T37a（Task 37 の設計書 3.1）。T37R2-fix: 今数えている項目（上限・401・止めた登録した呼び出し・サービスの Origin への読み取りでない要求）に合わせた。
  SERVICE_READ_REFUSED:
    'この画面を読む間に、サービスへの要求を上限で止めた、サービスがログインの状態を受け付けなかった（401）、登録した読み取りの呼び出しを止めた、サービスへの読み取りでない要求を止めた、のどれかがありました。画面がデータを描けなかったかもしれないため、読めた分だけを示します。',
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
  URL_NOT_BUILT: '読む URL を組み立てられませんでした（送信先が候補の Origin の外になる、画面の path が開始の URL の Origin で組み立てられない、長さの上限、など）。',
  REQUEST_POLICY: '要求の判定（読まないパス、危険な語、許可した Origin、ログインの画面）で止めました。',
  NAVIGATION_FAILED: '読んだ URL の読み込みが失敗しました（時間切れ、接続の失敗、外部への移動の遮断など）。',
  HTTP_ERROR_STATUS: '読んだ URL の応答が、HTTP の誤り（4xx・5xx）でした。',
  RESULT_PAGE_UNREADABLE: '読んだ URL は読み込めましたが、結果の構造を読めませんでした。',
  SESSION_LOST: '読んだ URL の読み込みで、ログインの状態が切れていました（ログインの状態の鍵が消えた場合を含みます）。',
  // T37d（Task 37 の設計書 3.5）: 読んで照らしたが、監査の段の事実で判定しなかった（照らした結果に関係なく判定できない）。
  SERVICE_READ_REFUSED:
    '読む間に、サービスへの読み取りを上限で止めたか、サービスがログインの状態を受け付けませんでした（401）。画面がデータを描けなかったかもしれないため、照らした結果に関係なく判定していません。',
  AUDIT_STAGE_REQUEST_BLOCKED:
    '読む間に、登録した読み取りの手続きの呼び出しを回数の上限か送り方で止めたか、サービスへの読み取りでない要求（登録していない手続きの呼び出しなど）を止めました。画面がデータを描けなかったかもしれないため、照らした結果に関係なく判定していません。',
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
  /** T37c（Task 37 の設計書 3.6）: 送らずに観察する probe の結果（最小の表示。詳しい画面は T37e）。 */
  submissionProbe: {
    heading: '送らずに観察した送り方',
    body: '発見のときに、通信を止めた状態でこのボタンを押し、ページが送るはずだった要求の形を記録しました。サーバへは何も送っていません。値は記録していません。',
    result: '結果',
    reason: '理由',
    method: 'method',
    pathShape: '送り先の path の形',
    bodyKeys: '本文の鍵の名前',
    noBodyKeys: 'なし',
    noReason: 'なし',
    noShape: '記録した形はありません。',
  },
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
  guidance: 'BeakSight がログインしてから、保存した定義ごとに、候補を読む定義は送る値で GET の URL を組み立てて読み、画面を読む定義はその画面を読んで、結果を期待と照らします。フォームの送信や書き込みはしません。',
  valuesNote: '送る値は、テスト環境のテスト用の値だけにしてください。値は管理データにそのまま保存し、この画面に表示します。秘密に見える名前の欄には、値を送りません。',
  submit: 'READ を確かめる',
  submitting: '始めています…',
  cannotStartHeading: 'このプロファイルでは、今は READ を確かめられません',
  rejectedHeading: 'READ の確かめを始められませんでした',
  notEligible: 'READ の確かめは、認証つきの読み取りの監査か、承認した書き込みのモードのプロファイルだけで行えます。',
  retired: '取り消したプロファイルでは、定義を作ったり変えたりできません。',
  definitionsHeading: '定義',
  noDefinitions: 'まだ定義はありません。下の読み取り（READ）の候補から作るか、画面を読む定義を作ります。',
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
  /** T37d（Task 37 の設計書 3.5）: 画面の path を読む定義。 */
  page: {
    targetHeading: '読む対象',
    pagePath: '画面の path',
    pagePathHint: '開始の URL と同じ Origin の画面の path です。/ で始まり、? と # を含まない、ブラウザのアドレス欄に出る形で入れてください。',
    /** T38f: `{id}` つきの画面の path の型の案内（`placeholder` は型の印。API のシナリオの照合の READ に使える）。 */
    pageTemplateHint: (placeholder: string): string =>
      `path の区切りの 1 つを ${placeholder} にすると、API で送るシナリオの照合の READ に使えます（${placeholder} には、台帳の登録の ID が入ります。区切りの全体を ${placeholder} にし、1 つだけ置いてください）。この型の定義は、READ の確かめとしては単独で読みません。`,
    choosePath: '直近の「操作の候補を探す」で読んだ画面から選ぶ',
    chooseNone: '選ばない（入力する）',
    noPagePaths: '直近の「操作の候補を探す」の結果の画面を読めないため、選べる一覧はありません。path を入力してください。',
    note: '画面を読む定義は、その画面を 1 回読み込み、データが描かれて落ち着いてから、期待と照らします。値は送りません。読む間にサービスへの読み取りを止めたり断ったりしたときは、「判定できない」になります。',
    candidateNote: '候補を読む定義は、READ の確かめの画面の「読み取り（READ）の候補」の一覧から、候補を選んで作ります。',
    chooseCandidate: '候補を選ぶ',
    create: '画面を読む定義を作る',
    target: '対象',
  },
} as const);

/** T37d（Task 37 の設計書 3.5）: READ の確かめの定義の対象の種類（`READ_CHECK_TARGET_KINDS`）の表示の名前。 */
export const READ_CHECK_TARGET_KIND_LABELS = deepFreeze({
  CANDIDATE: '候補を読む',
  PAGE: '画面を読む',
} as const satisfies Record<string, string>);

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
  // T37d fix round 1: 書き込みの照合の READ に、画面の path を読む定義は使わない。
  SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET: {
    description: '照合の READ に選んだ定義は、画面の path を読む定義です。書き込みの照合には、読み取り（READ）の候補を読む定義だけを使えます。保存していません。',
    action: '照合の READ には、候補を読む READ の確かめの定義を選んでください。',
  },
  // T38b（Task 38 の設計書 3.2）: API で送るシナリオの下書き。
  SCENARIO_API_CANDIDATE_NOT_API: {
    description: '対象の候補は、送らずに観察した送り方が API の登録・更新ではないか、観察の記録（入れた欄と型）がありません。保存していません。',
    action: '「操作の候補を探す」をもう一度行い、送り方が API の登録・更新の候補から作ってください。',
  },
  SCENARIO_API_STATE_KEY: {
    description: '送る本文に、論理削除にあたる状態の鍵があります。API で送るシナリオにはできません。保存していません。',
    action: '状態を変えない画面のボタンから作ってください。',
  },
  SCENARIO_API_METHOD_OVERRIDE: {
    description: '送る本文が、送り方（method）を上書きしています（_method の鍵）。保存していません。',
    action: '送り方を上書きしない画面のボタンから作ってください。',
  },
  SCENARIO_API_HEADER_METHOD_OVERRIDE: {
    description: 'ページが付けるヘッダに、送り方（method）を上書きする名前があります。保存していません。',
    action: '送り方を上書きしない画面のボタンから作ってください。',
  },
  SCENARIO_API_ORIGIN_NOT_APPROVED: {
    description: '送り先の Origin が、プロファイルの承認したサービスの Origin にありません。保存していません。',
    action: 'プロファイルの承認したサービスの Origin を確かめ、必要なら「操作の候補を探す」をやり直してください。',
  },
  SCENARIO_API_SHAPE_NOT_EXECUTABLE: {
    description: '送る要求の形を確かめ直すと、登録・更新の形ではありませんでした（削除、上書き、一括、filter の不備など）。保存していません。',
    action: '「操作の候補を探す」をやり直し、登録・更新の形の候補から作ってください。',
  },
  SCENARIO_API_FIELD_KEY_MISMATCH: {
    description: '送る鍵と画面の欄が 1 対 1 で対応していません（欄のない鍵を送る、同じ欄が 2 つの鍵に対応する、欄のある鍵を送らない、など）。保存していません。',
    action: '欄に対応する鍵をすべて、ちょうど 1 回ずつ送る鍵に選んでください。',
  },
  SCENARIO_API_FIELD_TYPE_MISMATCH: {
    description: '欄の種類と、送る本文の値の型が合いません（数の欄の値を文字で送る、など）。保存していません。',
    action: 'この候補は API で送るシナリオにできません。画面の作りを確かめてください。',
  },
  SCENARIO_API_KEY_NOT_ALLOWED: {
    description: '欄に対応しない鍵が、ページが決める鍵の一覧にないか、一覧の名前が欄のない鍵ではありません。保存していません。',
    action: 'ページが決める鍵（例: テナントの ID）を、名前を確かめて一覧に入れてください。値は照らさず、実行したときの値を記録に残します。',
  },
  SCENARIO_API_PAGE_KEY_SECRET_LIKE: {
    description: '秘密に見える名前の鍵は、ページが決める鍵にできません。保存していません。',
    action: 'この候補は API で送るシナリオにできません。',
  },
  SCENARIO_API_FILTER_MISMATCH: {
    description: '更新の filter の名前が、送る要求の filter と違います（登録には filter はありません）。保存していません。',
    action: '要求の型に出ている filter の名前を確かめて入れてください。',
  },
  // T38c（T38b の報告の (2)）: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う。
  SCENARIO_API_DISCOVERY_PROFILE_STALE: {
    description: 'この候補を見つけた「操作の候補を探す」の後に、プロファイルを編集しました（要求の送り先の確かめが、今のプロファイルと合いません）。保存していません。',
    action: '「操作の候補を探す」をもう一度行ってから、シナリオを作り直してください。',
  },
  // T38R-fix の I-2: ページが決める鍵の JSON の型、登録の ID を読む応答の鍵の名前。
  SCENARIO_API_PAGE_KEY_NOT_SCALAR: {
    description: 'この鍵は、値が JSON の object か配列です。ページが決める鍵は、文字列・数・真偽・null の鍵だけ許します（中の値を照らせないため）。保存していません。',
    action: 'この鍵をページが決める鍵から外してください。外せない場合は、この候補ではシナリオを作れません。',
  },
  SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE: {
    description: '登録の ID を読む応答の鍵の名前が、秘密に見えます（値を照らさない鍵に、秘密を運ばせないため）。保存していません。',
    action: '登録の ID の鍵を別の鍵にするか、空にして、検証の指定の登録の ID の取り方を使ってください。',
  },
  // T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2）: API のシナリオの照合の READ。T40R2-fix: 画面から取る登録の ID の型は拒まず、注意
  // （`LOCAL_UI_WRITE_TEXT.recordIdPatternCaution`）にした。
  SCENARIO_API_READ_VERIFICATION_NOT_BOUND: {
    description: '照合に使う画面の READ（{id} の型）の期待が、行の数だけです。登録した値と比べる期待がないと、別の画面を読んでも一致しうるので、照合に使えません。保存していません。',
    action: '期待に「本文が含む」か「詳細の項目の値」を足し、比べる値に送る欄を選んでください。',
  },
  // T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵。ユーザーの判断 2）: API の更新のページが決める鍵と、台帳の ID と filter の結び付け。
  SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE: {
    description: 'この鍵は、ページが値を決める鍵ですが、更新の画面の欄として見分けられません。更新では、送る前の値と照らせる鍵（画面の選択の欄など）だけを許します。保存していません。',
    action: 'この鍵をページが決める鍵から外してください。外せない場合は、この画面では API の更新のシナリオを作れません。',
  },
  SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID: {
    description: '台帳（参照した登録のシナリオ）の登録の ID で、この更新の行を選べるか分かりません。台帳が API で送る登録でない、台帳の登録と更新の送り先（Origin と path）が違う（別の表）、または台帳が登録の ID を読む応答の鍵の名前が filter の名前と違います。保存していません。',
    action: '同じ送り先（同じ表）に API で登録し、応答の鍵の名前が filter の名前と同じ登録のシナリオを台帳に選んでください。',
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
  /** T38f: API の候補の probe の行（型）ごとの「シナリオを作る」（method と path の型で行を区別する）。 */
  createApiFromCandidate: (method: string, pathShape: string): string => `API のシナリオを作る（${method} ${pathShape}）`,
  /** T41e-2: 型から API のシナリオを作れない行の見出し（理由はシナリオの下書きの理由の説明）。 */
  apiCandidateRejected: (method: string, pathShape: string): string => `API のシナリオは作れません（${method} ${pathShape}）`,
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
  /** T38c（Task 38 の設計書 3.3）: API のシナリオの要求の型の要約（承認の画面と詳細。値は持たない）。 */
  api: {
    heading: 'API の要求の型（承認が縛る型）',
    note: 'ページのスクリプトが送る要求の型です。値は持ちません。承認の後に、発見で型が変わると、再承認が要ります。',
    method: 'method',
    origin: '送り先の Origin',
    pathShape: 'path の型',
    queryNames: 'query の名前',
    contentType: 'Content-Type',
    prefer: 'Prefer',
    keyFields: '本文の鍵と欄',
    pageKeys: 'ページが決める鍵',
    headerNames: 'ページが付けるヘッダの名前',
    filterName: '更新の filter の名前',
    none: 'なし',
    /** 鍵と欄の 1 件（`fieldText` は欄の名前か CSS）。 */
    keyField: (key: string, type: string, fieldText: string): string => `${key}（JSON の ${type}）← 欄 ${fieldText}`,
    /** ページが決める鍵の 1 件。 */
    pageKey: (key: string, type: string): string => `${key}（JSON の ${type}。値は照らしません）`,
    /** T41e: 更新の、欄として識別したページが決める鍵の 1 件（`fieldText` は欄の名前か CSS。送る前の画面の値と照らす）。 */
    pageKeyField: (key: string, type: string, fieldText: string): string => `${key}（JSON の ${type}）← 欄 ${fieldText}（送る前の画面の値と照らします）`,
    /** T41e: 更新の保つ鍵（見出しと 1 件。`fieldText` は欄の名前か CSS。値は送る前の画面の値のまま）。 */
    keptKeys: '保つ鍵と欄',
    keptKey: (key: string, type: string, fieldText: string): string => `${key}（JSON の ${type}）← 欄 ${fieldText}（値を変えません）`,
    /** 欄の識別（名前か CSS）。 */
    fieldName: (name: string): string => `名前 ${name}`,
    fieldSelector: (selector: string): string => `CSS ${selector}`,
    /** T38f: 送り方と、登録の ID の取り方（応答の本文の鍵）。 */
    transport: '送り方',
    recordId: '登録の ID を読む応答の鍵',
    recordIdUnset: '指定なし（検証の指定の取り方を使う）',
    /** T38f: 作成と変更のフォーム。 */
    formHeading: 'API の要求の型と、送る鍵',
    formNote:
      '発見で、対象のボタンを押したときにページが送ろうとした要求の型から、案を埋めています。鍵と欄の対応を確かめ、ページが決める鍵のうち許すものを選んでください。値は入れません。',
    keyFieldsNote: '欄に値を入れて送る本文の鍵です。欄に対応する鍵は、すべて送ります（送らない鍵があると保存できません）。',
    pageKeysNote: '欄に対応せず、ページが値を決める本文の鍵です。許す鍵だけを選んでください（値は照らしません）。秘密に見える名前の鍵は選べません。',
    noPageKeys: 'ページが決める鍵はありません。',
    headerNamesNote: 'ページが付けるヘッダの名前の案です（ブラウザが付ける名前は除いています）。承認に結びます。',
    filterNameLabel: '更新の filter の名前',
    filterNameHint: '更新する行を選ぶ query の名前です。要求の型の filter の名前と同じにしてください。',
    ledgerLabel: '台帳（更新するレコードを登録したシナリオ）',
    ledgerUnset: '選んでいません',
    /** 台帳の選択肢（登録のシナリオの id と、その画面の path）。 */
    ledgerOption: (scenarioId: string, pagePath: string): string => `${scenarioId}（${pagePath}）`,
    // T41e-3（T41R-fix-B）: 台帳にできるのは、同じ送り先（Origin と path の型）の API の登録で、登録の ID が filter に結び付くシナリオだけ。
    noLedgerOptions:
      '台帳にできる登録のシナリオがありません。台帳にできるのは、この更新と同じ送り先（Origin と path の型）の API の登録のシナリオだけです。同じ送り先の API の登録のシナリオを先に作り、書き込みで照合済みの登録を作ってください。',
    formPathTemplateLabel: '更新の画面の path の型',
    formPathTemplateHint: '候補の画面の path の、レコードの ID の区切りを型の印にしたものです。',
    recordIdKeyLabel: '登録の ID を読む応答の鍵（任意）',
    recordIdKeyHint: '登録の応答の本文から、登録の ID を読む鍵の名前です。空にすると、下の検証の指定の登録の ID の取り方を使います。',
    errorsHeading: 'API の指定を直してください',
    filterCautionHeading: 'filter の列の名前を確かめてください',
    filterCaution:
      '更新する行を選ぶ filter の名前（列の名前）は、発見では確かめていません（Task 37 の限界）。別の列を指していないかを、テスト環境の API の定義で確かめてから承認してください。',
    /** DEF-147: 公開の状態にあたる鍵の注意の印と、その説明。 */
    publicationStateKey: '公開の状態にあたる欄',
    publicationStateCautionHeading: '公開の状態にあたる欄があります',
    publicationStateCaution:
      '公開・非公開や下書きなどの状態を決める欄です。登録の値は入力の規則で決めます（削除・アーカイブにあたる値は使えません）。更新では既定で保ちます。テスト環境で、公開されても困らない値かを確かめてから承認してください。',
    publicationStateKeepHint: '公開の状態にあたる欄です。既定で保ちます（変えると、入力の規則の値を送ります）。',
  },
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
  PAGE_KEY_RULE_NOT_ALLOWED: {
    description: 'この鍵は、ページが決める値の鍵です（承認で名前を示した鍵）。BeakSight は値を作らないので、規則を持てません。',
    action: 'この鍵の規則を消してください。値を入れる場合は、欄に対応する鍵としてシナリオを作り直してください。',
  },
  JSON_VALUE_TYPE_MISMATCH: {
    description: '規則が作る値が、鍵の JSON の型で送れる形ではありません（数の鍵は、先頭の 0・小数の末尾の 0・指数の表記・-0 のない 15 桁までの数だけ）。または、欄の型と鍵の JSON の型の組が合いません。',
    action: '鍵の型に合う値か範囲に直してください。組が合わない場合は、「操作の候補を探す」をもう一度行い、シナリオを作り直してください。',
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

/**
 * 入力の規則の画面の、自動で作った規則の文言（手動の操作を減らす設計書 3A.3。FM2c）。出どころの印のラベルは `catalog.ts` の `RULE_ORIGIN_CATALOG`。
 * 数の文字は、呼び出し側が `formatInteger` で作って渡す。
 */
export const LOCAL_UI_DATA_RULE_INFERENCE_TEXT = deepFreeze({
  originLabel: '出どころの印',
  defaultRangeHeading: '既定の幅を使った欄（推測）',
  /** 既定の幅の説明（`daysText`・`minText`・`maxText` は既定の幅の数）。 */
  defaultRangeNote: (daysText: string, minText: string, maxText: string): string =>
    `範囲の手がかり（最小・最大・刻み）がない欄に、推測で既定の幅を入れました。日付・日時は基準日（実行の許可の発行日）から ${daysText} 日後まで、数は ${minText}〜${maxText} の整数です。サイトが受け付けないときは、範囲を入れ直して保存してください。`,
  defaultRangeBadge: '既定の幅（推測）',
  /** 基準日からの幅（`fromText`・`toText` は日の数）。 */
  baseDateWindowText: (fromText: string, toText: string): string => `基準日から ${fromText}〜${toText} 日後`,
  baseDateWindowLabel: '日付の幅',
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

/** T44e: 時間の上限で止まったときの、次にできること（監査と発見と READ の確かめで共用する前半）。 */
const RAISE_RUNTIME_LIMIT_TEXT = 'プロファイルの画面の「監査の負荷」で時間の上限を上げられます';
/** T44e: 変えると途中の Run は再開されない旨（P2-1 と同じ決まり）。 */
const LIMIT_CHANGE_RESTARTS_TEXT = '（上限を変えると、途中の Run は再開されず、新しく始まります）';
/** T44e: 安全の違反で止まったときの、次にできること。 */
const SAFETY_STOP_NEXT_STEP_TEXT = '違反の中身（HTML レポートの安全の記録、またはこの画面の安全の違反の欄）を確かめてください。原因を直すまで、同じ設定で始め直さないでください。';
/** T44e: 始める前の確認で止まったときの、次にできること（`action` は始め直す操作の名前）。 */
const preflightNextStepOf = (action: string): string =>
  `ブラウザ（Chromium）を起動できるか、出力先のフォルダに書けるかを確かめてから、もう一度「${action}」を始めてください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`;
/** T44e: 承認したサービスの Origin への要求の上限で止まったときの、次にできること（`action` は始め直す操作の名前）。 */
const serviceLimitNextStepOf = (action: string): string =>
  `認証の設定の、サービスの Origin への要求の上限を見直してから、もう一度「${action}」を始めてください。`;

/**
 * T44e（Task 44 の設計書 P2-7。測りの記録 `T44a-baseline.md` の 3.3）: ローカルの管理画面のジョブの画面に、終わり方と理由の説明（表示のカタログ
 * `RUN_EXECUTION_END_REASON_CATALOG`・`RUN_STATUS_CATALOG`・`AUDIT_JOB_END_KIND_CATALOG`・`DISCOVERY_END_REASON_CATALOG`・`READ_CHECK_END_REASON_CATALOG`・
 * `ENTRY_CHECK_END_REASON_CATALOG`・`INCOMPLETE_REASON_DESCRIPTIONS`）の後に出す「次にできること」。成功の終わり方と、説明が手順を含むものは `null`。
 * - 画面の操作（「前回の続きから再開する」「監査の負荷」など）を書くので、CLI でも作る HTML レポートの文（`INCOMPLETE_REASON_NEXT_STEPS`）とは分ける。
 *   Run の理由（`runReasons`）に載せていない理由は、`INCOMPLETE_REASON_NEXT_STEPS` の文を使う（画面の側で）。
 * - 網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる（Run の理由は、Run の全体に付く理由の閉じた一覧）。
 */
export const LOCAL_UI_JOB_NEXT_STEPS = deepFreeze({
  /** 監査の 1 回の実行の終わり方（`RUN_EXECUTION_END_REASONS`）。 */
  runExecutionEndReasons: {
    COMPLETED: null,
    STOPPED_BY_RUNTIME_LIMIT:
      `残りのページは、「前回の続きから再開する」を選んで始めると、続きから監査します。1 回で長く監査するには、${RAISE_RUNTIME_LIMIT_TEXT}${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    STOPPED_BY_SIGNAL: '続きを監査するには、「前回の続きから再開する」を選んで始めてください。',
    STOPPED_BY_SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    STOPPED_BY_SITE_UNAVAILABLE: 'サイトが応答するようになったことを確かめてから、「前回の続きから再開する」を選んで始めてください。',
    INTERRUPTED_ABNORMALLY: '「前回の続きから再開する」を選んで始めると、最後に保存したページの続きから監査します。',
    STOPPED_BY_AUTH_SESSION_LOST: 'この画面の「ログイン」の欄の案内（止まったページを読まないパスに足すなど）に従ってから、「前回の続きから再開する」を選んで始めてください。',
    STOPPED_BY_SERVICE_REQUEST_LIMIT: serviceLimitNextStepOf('監査を始める'),
  },
  /** Run の状態（`RUN_STATUSES`）。 */
  runStatuses: {
    COMPLETE: null,
    PARTIAL: '終えられなかった確認の理由は、この欄と、HTML レポートの各ページにあります。理由ごとの次にできることを確かめてください。',
    FAILED: 'この欄の理由を確かめ、直してから、もう一度始めてください。',
    ABORTED_BY_SAFETY: `${SAFETY_STOP_NEXT_STEP_TEXT}直した後は、「新しく始める」を選んで始めてください。`,
  },
  /** 監査のジョブの終わり方（`WORKER_OUTCOME_KINDS`）。説明が手順を含むものは `null`。 */
  endKinds: {
    RAN: null,
    RUN_ACTIVE: null,
    VERSION_MISMATCH: null,
    RUN_DIRECTORY_UNAVAILABLE:
      '出力先（設定のファイルの output.directory）のフォルダに書けるか（空きの容量、権限、ほかのプログラムが開いていないか）を確かめてから、もう一度始めてください。',
    RESUME_UNAVAILABLE:
      '同じ出力先で、ほかの監査（CLI を含む）が動いていないかを確かめてから、もう一度始めてください。続けて起きるときは、「新しく始める」を選んで始めてください。',
  },
  /**
   * Run の全体に付く理由（`IncompleteReasonCode` のうち、Run の理由に入るもの。閉じた一覧は `catalog-coverage.ts`）。ページごとの理由は HTML レポートに出す。
   */
  runReasons: {
    MAX_PAGES_REACHED: `残りのページも監査するには、プロファイルの画面の「監査の負荷」でページの上限を上げてから、もう一度始めてください${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    MAX_DEPTH_REACHED: 'もっと深いページも監査するには、設定のファイルのリンクの深さの上限（crawl.maxDepth）を直してから、もう一度始めてください。',
    MAX_RUNTIME_REACHED:
      `残りのページは、「前回の続きから再開する」を選んで始めると、続きから監査します。1 回で長く監査するには、${RAISE_RUNTIME_LIMIT_TEXT}${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    RUN_INTERRUPTED: '続きを監査するには、「前回の続きから再開する」を選んで始めてください。',
    SITE_UNAVAILABLE: 'サイトが応答するようになったことを確かめてから、「前回の続きから再開する」を選んで始めてください。',
    AUTH_SESSION_LOST: 'ログインの状態が切れたページのパスを、認証の設定の「読まないパス」に足すと、次から読みません。続きは、「前回の続きから再開する」を選んで始めてください。',
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('監査を始める'),
    SAFETY_VIOLATION_ABORT: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('監査を始める'),
    CHECKPOINT_WRITE_FAILED: '出力先のフォルダに書けるか（空きの容量、権限）を確かめてから、「前回の続きから再開する」を選んで始めてください。',
    RUN_DIRECTORY_UNAVAILABLE: '出力先のフォルダに書けるか（空きの容量、権限）を確かめてから、もう一度始めてください。',
  },
  /** 発見のジョブの終わり方（`DISCOVERY_END_REASONS`）。説明が手順を含むものは `null`。 */
  discoveryEndReasons: {
    COMPLETED: null,
    MAX_PAGES_REACHED: '残りの画面も読むには、プロファイルの画面の「監査の負荷」でページの上限を上げてから、もう一度「操作の候補を探す」を始めてください。',
    MAX_RUNTIME_REACHED: `残りの画面も読むには、${RAISE_RUNTIME_LIMIT_TEXT}。上げてから、もう一度「操作の候補を探す」を始めてください。`,
    STOPPED: null,
    AUTH_SESSION_LOST: null,
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('操作の候補を探す'),
    SITE_UNAVAILABLE: null,
    SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('操作の候補を探す'),
  },
  /** READ の確かめのジョブの終わり方（`READ_CHECK_END_REASONS`）。説明が手順を含むものは `null`。 */
  readCheckEndReasons: {
    COMPLETED: null,
    MAX_RUNTIME_REACHED: `残りの定義も確かめるには、${RAISE_RUNTIME_LIMIT_TEXT}。上げてから、もう一度「READ を確かめる」を始めてください。`,
    STOPPED: null,
    AUTH_SESSION_LOST: null,
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('READ を確かめる'),
    SITE_UNAVAILABLE: null,
    SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('READ を確かめる'),
  },
  /** 入口の確かめのジョブの終わり方（`ENTRY_CHECK_END_REASONS`）。止めたものと読んだものは `null`。 */
  entryCheckEndReasons: {
    READ: null,
    LEFT_ALLOWED_ORIGINS:
      '開始の URL と、プロファイルの許可 Origin が正しいかを確かめてください。ログインの画面が別の Origin（外部の認証のサービス）にある形には、まだ対応していません。認証の設定の欄は、画面で手で入れてください。',
    READ_FAILED: '少し時間をおいて、もう一度「入口を確かめる」を始めてください。続けて読めないときは、認証の設定の欄を、画面で手で入れてください。',
    NAVIGATION_FAILED: 'サイトが応答するかと、開始の URL が正しいかを確かめてから、もう一度「入口を確かめる」を始めてください。',
    PREFLIGHT_FAILED: preflightNextStepOf('入口を確かめる'),
    STOPPED: null,
    SAFETY_VIOLATION: '安全の決まりに反する動きがあったため、この結果は使えません。認証の設定の欄は、画面で手で入れてください。',
  },
} as const);

/**
 * T44e（Task 44 の設計書 P2-4）: 書き込みのジョブが送る前の確かめで送らずに止めた（`PRECHECK_FAILED`）ときの、具体的な理由（`action-run.json` の
 * `precheckDetail`。一覧は `src/control/actions/action-contracts.ts` の `PRECHECK_FAILURE_DETAILS`）ごとの説明と次にできること。網羅は画面の側の
 * `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる。
 */
export const PRECHECK_FAILURE_DETAIL_DESCRIPTIONS = deepFreeze({
  STOPPED: {
    description: '止める合図（撤回、シナリオの変更、止める操作）を受けたため、送らずに止めました。',
    action: '書き込みを続けるときは、シナリオの承認と実行の許可を確かめてから、もう一度始めてください。',
  },
  SESSION_LOST: {
    description: '書き込みの画面で、ログインの状態が切れていました。送っていません。',
    action: 'ログインできる状態か（認証の設定と、テスト環境のアカウント）を確かめてから、もう一度始めてください。',
  },
  PAGE_UNAVAILABLE: {
    description: '書き込みの画面を読めませんでした（読み込みの失敗、4xx・5xx の応答、欄の値を読めない）。送っていません。',
    action: 'テスト環境で書き込みの画面が開けるかを確かめてから、もう一度始めてください。',
  },
  CANDIDATE_CHANGED: {
    description: '書き込みの画面の候補が、承認した候補と合いませんでした（画面が変わった）。送っていません。',
    action: '操作の候補を探し直し、シナリオを見直して承認し直してから、もう一度始めてください。',
  },
  PRIOR_VALUES_EMPTY: {
    description: '更新の前に読んだ画面で、目印を入れた欄がすべて空でした（値が入る前の画面を読んだとみなしました）。送っていません。',
    action: '少し時間をおいて、もう一度始めてください。続けて起きるときは、テスト環境で対象のレコードの値を確かめてください。',
  },
  KNOWN_KEPT_VALUE_MISMATCH: {
    description:
      '保つ欄の値が、台帳が知る値（BeakSight が登録や更新で送った値）と違いました。BeakSight の外で値が変わったレコードや、結果が分からなかった更新の後のレコードは、違う値を書き換えないために更新しません。送っていません。',
    action: 'テスト環境で対象のレコードの値を確かめてください。登録の書き込みで新しいレコードを作ると、そのレコードは更新できます。',
  },
  PRIOR_VALUE_UNUSABLE: {
    description: '更新の前の値を、記録や照合に使えませんでした（長すぎる、承認した型に変えられない）。送っていません。',
    action: 'シナリオの変える欄・保つ欄と、テスト環境の対象のレコードの値を確かめてください。',
  },
  PRIOR_VALUE_CHANGED: {
    description:
      '書き込みの画面の値が、更新の前に読んだ値と違いました（開き直した画面か、押す直前の読み直し）。ページが値を書き換えたか、ほかの人がレコードを変えた可能性があります。送っていません。',
    action: '少し時間をおいて、もう一度始めてください。続けて起きるときは、テスト環境で対象のレコードと画面の動きを確かめてください。',
  },
  FORM_NOT_READY: {
    description: '入力の前の確かめ、値の入力、押す操作のどれかに失敗しました。送っていません。',
    action: '書き込みの画面が、シナリオを承認したときと同じかを確かめてから、もう一度始めてください。',
  },
  UNEXPECTED_REQUEST: {
    description: '値を入れた後に、承認した送信のほかの要求が出たため、押しませんでした。',
    action: 'ページが入力の値を別の要求で送る作りでないかを、テスト環境で確かめてください。',
  },
  RECHECK_REFUSED: {
    description: '送る直前の確かめ直しで、承認か実行の許可が外れていました（撤回、期限切れ、シナリオやプロファイルの変更など）。送っていません。',
    action: 'シナリオの画面で承認の状態を確かめ、承認し直してから、もう一度始めてください。',
  },
  AUDIT_STAGE_STOPPED: {
    description: 'ログインの状態の鍵がなくなったか、承認したサービスの Origin への要求の上限に届いたため、送りませんでした。',
    action: 'ログインの状態と、認証の設定の要求の上限を確かめてから、もう一度始めてください。',
  },
  PREFLIGHT_FAILED: {
    description: 'Run の前の確認（ブラウザの起動など）に失敗しました。送っていません。',
    action: `ブラウザ（Chromium）を起動できるか、出力先のフォルダに書けるかを確かめてから、もう一度始めてください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`,
  },
} as const satisfies Record<string, ControlReasonText>);

/** T44e: ジョブの画面の「終わり方と理由」の欄の文言。 */
export const LOCAL_UI_JOB_END_TEXT = deepFreeze({
  heading: '終わり方と理由',
  executionEnd: '最後の実行の終わり方',
  reasons: 'Run の理由',
  endReason: '終わり方',
  nextStep: '次にできること',
  /** ページごとの理由の置き場所（引数は、一部未完了・失敗・監査しなかったページの数。`formatCount` の結果）。 */
  pageReasons: (partialText: string, failedText: string, skippedText: string): string =>
    `終えられなかったページ（一部未完了 ${partialText}、失敗 ${failedText}、監査しなかった ${skippedText}）の理由は、HTML レポートの各ページにあります。`,
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
    // T44d（Task 44 の設計書 P2-1）: 間隔と上限は、プロファイルの画面の「監査の負荷」で変えられる（local/targets/ の中のファイルだけ）。
    configNote:
      'この画面では変えられません。間隔と上限を変えるときは、プロファイルの画面の「監査の負荷」で変えます（設定のファイルが local/targets/ の中にあるときだけ。ほかは設定のファイルを直します）。',
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
    /** T44d（Task 44 の設計書 P2-3）: ジョブの画面の大きい止めるボタン（`target` は止める対象の呼び名。`AUDIT_JOB_STOP_TARGET_NAMES`）。 */
    stop: (target: string): string => `${target}を止める`,
    forceStop: '強制的に止める',
    forceStopHint: (waitText: string): string => `止める要求から ${waitText} たっても止まらないため、強制的に止められます。`,
    stopRejectedHeading: '止められませんでした',
    /**
     * DEF-146: 止める要求の Server Function の呼び出しが例外で終わった（通信の誤り、入力の検証の誤り）、または結果の形でない値で終わったときの理由
     * （ジョブの管理には届いていない）。
     */
    stopRequestFailed:
      '画面のサーバとのやりとりで誤りが起きたため、止める要求を届けられませんでした（通信の誤りか、入力の検証の誤り）。画面のサーバが動いているかを、起動したコンソールで確かめてから、もう一度止めてください。',
    artifactsHeading: '成果物',
    noArtifacts: 'まだ成果物はありません。',
    openReport: 'HTML レポートを開く',
    downloadRunJson: 'run.json をダウンロードする',
    downloadAuditJson: 'audit.json をダウンロードする',
    downloadBundle: 'ChatGPT 用のバンドル（ZIP）をダウンロードする',
  },
  /**
   * DEF-146: 題と確定のボタンは、止める対象の呼び名（ジョブの種類ごと。`AUDIT_JOB_STOP_TARGET_NAMES`）を入れる。取り消しは「止めずに戻る」（前の「やめる」は、
   * 確定の「止める」と読み違えた）。T44d: 本文は、ジョブの種類ごとの `AUDIT_JOB_STOP_DIALOG_BODIES`。
   */
  stopDialog: {
    title: (target: string): string => `${target}を止めますか`,
    confirm: (target: string): string => `${target}を止める`,
    cancel: '止めずに戻る',
  },
  forceStopDialog: {
    title: (target: string): string => `${target}を強制的に止めますか`,
    confirm: (target: string): string => `${target}を強制的に止める`,
    cancel: '止めずに戻る',
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
  // T34R-fix-b（M-6）: 必須の query の値の確かめ（値に見える文字列、メールアドレス）も、このコードで知らせる。
  AUTH_SETUP_SECRET_LIKE_VALUE:
    'ログインの画面の URL か、送信先の必須の query に、秘密に見える名前（password、token、session など）か、値に見える文字列（長いランダムな文字列、token の形、メールアドレス）があります。秘密や個人の情報は書かないでください。',
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
  // T34a（Task 34 の設計書 3.2）: 認証の設定の版 3（スクリプトで送るログイン）の誤り。画面の文言の見直しは T34d。
  AUTH_SETUP_SCRIPT_LOGIN_REQUIRED:
    'スクリプトで送るログインでは、ログインの送信先と、ログインが済んだと判定するローカル ストレージの鍵が要ります。両方を入れてください。',
  // T35a: 監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限も、スクリプトで送るログインだけの項目。
  AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED:
    'フォームの送信で行うログインでは、スクリプトの送信先、ログインに伴う送信、ローカル ストレージの鍵、監査の段の読み取りの手続きの呼び出し、サービスの Origin への要求の上限は使いません。スクリプトで送るログインにするか、これらを空にしてください。',
  AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED:
    'フォームの送信で行うログインでは、ログインの送信先（Origin とパス）が 1 つ以上要ります。',
  AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED:
    'スクリプトの送信先の Origin が、プロファイルで承認したサービスの Origin にありません。プロファイルにサービスの Origin を足すか、送信先を直してください。',
  AUTH_SETUP_REQUIRED_QUERY_INVALID:
    '送信先の必須のクエリに、空の名前、同じ名前の重なり、または使えない文字（制御文字・改行）があります。名前と値を直してください。',
  AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED:
    'ログインに伴う送信に、ほかの送信（またはスクリプトの送信先）と同じ Origin とパスのものがあります。1 つにまとめてください。',
  AUTH_SETUP_STORAGE_KEY_INVALID:
    'ローカル ストレージの鍵の接頭辞と接尾辞が、どちらも空か、使えない文字（制御文字・改行）を含みます。どの鍵にも当たる指定は使えません。',
  // T35a（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しの重なり。
  AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED:
    '監査の段の読み取りの手続きの呼び出しに、ほかの呼び出しと同じ Origin とパスのものがあります。1 つにまとめてください。',
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
    // T44d（Task 44 の設計書 P2-2）: 入り口の近くの、今の認証の設定の要約（読む範囲は `start.auditScope`・`start.auditScopeAll` を共用する）。
    excludedPaths: '読まないパス',
    excludedPathsNone: 'なし（既定で読まない語を含む URL は、いつも読みません）',
  },
  /**
   * T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルで、スクリプトで送るログインの送信先と鍵が空のときの案内（入口の確かめの結果と、認証の設定の
   * 画面。空の欄は、手動のログインの成功の後の自動の登録が埋める）。
   */
  // T44h の判断 (2)（測りの記録の N3）: 承認したサービスの Origin も自動の登録が足すので、先にプロファイルで足さない旨を含める（足すと改訂が進み、認証の設定が
  // 古くなって手順が増える）。
  scriptLoginAutoRegistrationNote:
    'スクリプトで送るログインの token の送信先と、ログインが済んだと判定するローカル ストレージの鍵は、空のまま保存できます（手動のログインのプロファイルだけ）。プロファイルの承認したサービスの Origin も、先に足さなくてかまいません。この設定で監査などを始め、BeakSight が開くブラウザで手動のログインで一度ログインすると、送信先と鍵と、token の送信先の Origin（承認したサービスの Origin）が自動で登録されます。',
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
    /** T43b（Task 43 の設計書 4.2）: 新しい認証の設定で、開始の URL の path から案を埋めたときの案内（`path` は開始の URL の path）。 */
    startUrlDraftNotice: (path: string): string =>
      `対象の設定の開始の URL の path（${path}）で、「ログインが済んだと判定するパス」と「読む範囲のパス」の案を埋めました。保存するまでは案です。違うときは直してください。`,
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
    /**
     * DEF-138: セッションの切れを判定したページの記録（`SessionLossEvidence`）。path と query の名前と数だけで、値（token、Cookie の値、query の値）は
     * ありません。
     */
    sessionLoss: {
      heading: 'セッションが切れたと判定した読み込みの記録',
      note: 'パスと query の名前と数だけを記録しています（token、Cookie の値、query の値は記録しません）。',
      stage: '判定した段階',
      requestedPath: '頼んだページ',
      landedPath: '行き着いた先',
      landedBy: '行き着いた先を見た場所',
      landedByLabels: {
        PAGE_URL: '画面の最後の URL',
        BLOCKED_REDIRECT: 'BeakSight が止めた移動の先（読む範囲の外）',
      } satisfies Record<SessionLossLandedBy, string>,
      redirectPaths: '読み込みの経路（リダイレクトと画面の移動の順）',
      /** 経路のほかに記録しなかった段の数（`countText` は `formatCount` の結果）。 */
      omittedText: (countText: string): string => `ほかに ${countText} の段を記録していません。`,
      blockedRequests: 'この読み込みの間に止めた要求',
      blockedColumns: { method: 'メソッド', originKind: 'Origin', path: 'パス', reason: '理由', count: '回数' },
      storageKeyChange: '読み込みの前と後の、ログインの状態の名前の違い',
      storageColumns: { storage: '置き場所', originKind: 'Origin', change: '違い', count: '名前の数', shapes: '名前の形（先頭と末尾）' },
      storageLabels: {
        LOCAL_STORAGE: 'ローカル ストレージの鍵', COOKIE: 'Cookie の名前', INDEXED_DB: 'IndexedDB のデータベースの名前',
      } satisfies Record<SessionLossStorageKind, string>,
      changeLabels: { REMOVED: '消えた', ADDED: '増えた' } satisfies Record<SessionLossKeyChange, string>,
      originKindLabels: {
        ALLOWED: '許可した Origin', SERVICE: '承認したサービスの Origin', OTHER: 'そのほかの Origin',
      } satisfies Record<SessionLossOriginKind, string>,
      /** 経路の段の Origin の区別の補足（`label` は `originKindLabels` の値）。 */
      routeOriginText: (label: string): string => `（${label}）`,
      /** 名前の形（先頭と末尾だけ。間と、一般の語でない端は「…」）。 */
      shapeText: (prefix: string, suffix: string): string => `${prefix}…${suffix}`,
      storageUnread: '読み込みの後の状態を読めなかったため、名前の違いはありません。',
      none: 'なし',
      noChange: '違いはありません。',
    },
  },
} as const);

/**
 * DEF-138: セッションの切れの証拠の、止めた要求の理由（`SESSION_LOSS_BLOCKED_REQUEST_REASONS`）ごとの説明。止めた要求の理由（`BLOCKED_REQUEST_REASONS`）は
 * 今の説明を使い、main frame の移動と監査の段の除外の理由を足す。
 */
export const SESSION_LOSS_BLOCKED_REQUEST_REASON_DESCRIPTIONS = deepFreeze({
  ...BLOCKED_REQUEST_REASON_DESCRIPTIONS,
  EXTERNAL_MAIN_FRAME_NAVIGATION: '許可した Origin の外への画面の移動を止めました。',
  AUDIT_EXCLUDED_URL: '読まないパス・読む範囲の外・危険な語に当たる読み込みを止めました。',
} as const satisfies Record<SessionLossBlockedRequestReason, string>);

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
  // T36c（Task 36 の設計者の判断 2）: 短い値は、自動ログインの資格情報の守りで正しく比べられないので受けない。
  CREDENTIAL_VALUE_TOO_SHORT: {
    description: 'ユーザー名かパスワードが短すぎます。自動ログインで値が外へ送られないかを確かめられないため、受け付けません。資格情報は保存していません。',
    action: '欄の説明にある長さ以上にしてください。',
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

/**
 * T39d（Task 39 の設計書 3.5）: API のシナリオの書き込みの、入力と押下の部品の止めた理由（`src/browser/api-write-submitter.ts` の
 * `API_WRITE_INPUT_REASONS`）の日本語の説明。値は、どの文言にも入れない。書き漏れと余分は、テストで確かめる。
 */
export const API_WRITE_INPUT_REASON_DESCRIPTIONS = deepFreeze({
  SPEC_INVALID: '入れる欄か送信の要素の指定が正しくありませんでした（同じ欄を 2 回指定した、CSS の形が正しくない、など）。',
  PAGE_UNREADABLE: '画面を読めませんでした（時間切れや、読む間の画面の移動など）。',
  FIELD_NOT_FOUND: '入れる欄が、画面に見つかりませんでした。',
  FIELD_AMBIGUOUS: '入れる欄の指定が、画面の 2 つ以上の欄に当たりました。',
  FIELD_TYPE_NOT_SUPPORTED: '入れる欄が、値を入れられる種類（文字の欄、文章の欄、選択の欄）ではありませんでした。',
  FIELD_NOT_VISIBLE: '入れる欄が、画面に見えていませんでした。',
  FIELD_NOT_EDITABLE: '入れる欄が、無効か読み取り専用でした。',
  SUBMITTER_NOT_FOUND: '押す送信の要素が、画面に見つかりませんでした。',
  SUBMITTER_AMBIGUOUS: '押す送信の要素と同じ形の要素が、画面に 2 つ以上ありました。',
  SUBMITTER_INSIDE_LINK: '押す送信の要素が、リンク（href のある要素）か、その中にありました（押すと画面が移りうるため、押しません）。',
  ELEMENT_CHANGED: '入れる・押す直前に、確かめた欄か送信の要素が入れ替わっていました。',
  INPUT_FAILED: '欄に値を入れる操作が失敗しました。',
  VALUE_CHANGED: '入れた値が、押す前に画面の処理で書き換えられていました（押していません）。',
  SUBMIT_FAILED: '送信の要素を押す操作が失敗しました（送られたかは分かりません）。',
} as const);

/**
 * FM2a（手を減らす段 2 の設計書 3A 章の共通の決まり）: 自動で作る下書きの案の根拠（`src/control/approval/draft-value-origin.ts` の
 * `DRAFT_VALUE_GROUNDS`）の日本語の文言。値は、どの文言にも入れない。書き漏れと余分は、テストで確かめる。
 * CC-107（FM2e の片づけ）: 出どころ（`DRAFT_VALUE_ORIGINS`）の名前の文は、表示カタログ `catalog.ts` の `DRAFT_VALUE_ORIGIN_CATALOG` の 1 か所だけに置く
 * （名前・順・色の区分。画面の部品 `DraftValueMark` はそれを読む）。ここには写しを置かない。
 */
export const DRAFT_VALUE_TEXT = deepFreeze({
  grounds: {
    API_FIELDED_KEYS: '送る鍵は、発見で欄に対応した鍵のすべてです。',
    API_UNFIELDED_KEYS: 'ページが決める鍵は、欄に対応しない鍵のうち、選べる鍵のすべてです。',
    API_SHAPE_FILTER: '更新の filter の名前は、発見で記録した要求の型の filter です。',
    CONTRACT_DEFAULTS: '上限と承認の期限は、既定の値です。',
    SIDE_EFFECTS_UNCONFIRMED: '副作用の確認は、どれも確かめていない状態で作りました。承認の前に、人が確かめてください。',
    SINGLE_BOUND_LEDGER: '台帳は、この更新に結び付く登録のシナリオが 1 つだけなので、それにしました。',
    ONLY_FORM_PATH_TEMPLATE: '更新の画面の型は、選べる型が 1 つだけなので、それにしました。',
    FIRST_FORM_PATH_TEMPLATE: '更新の画面の型は、選べる型が 2 つ以上あるので、先頭の型にしました。',
    RECORD_ID_KEY_FROM_UPDATE_FILTER: '登録の ID を読む応答の鍵は、同じ表の更新の filter の名前から推しました。',
    READ_PAGE_TEMPLATE_FROM_READ_PATH: '照合の READ の画面の型は、読めた画面の path から推しました。',
    READ_EXPECTATION_FROM_VARYING_FIELD: '照合の READ の期待（本文が含む）の欄は、入力の規則で実行のたびに値が変わる欄から推しました。',
    DEFAULT_RANGE_WITHOUT_HINT: '範囲の手がかりがない日付・数の欄なので、推した入力の規則に既定の幅を入れました。',
    HUMAN_CHOICE: '人が選んだ値です。',
    LOGIN_FIELD_SINGLE_CANDIDATE: '手動のログインの画面で、この欄の候補が 1 つだけだった要素から作りました（入力した値は読んでいません）。',
  },
} as const);

/**
 * FM2b（手を減らす段 2 の設計書 3A.2。案 2）: シナリオの下書きをボタン 1 回で作る画面の文言（発見の画面のボタンと確認のダイアログと結果、作成の画面の
 * 案内、シナリオの画面の推測の項目）。理由と状態の一覧は `src/control/approval/api-scenario-autodraft.ts`（`AUTO_DRAFT_BLOCKERS`・
 * `AUTO_DRAFT_READ_CHECK_OUTCOMES`・`AUTO_DRAFT_INFERRED_ITEMS`）。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts`。値（目印・送る値）は
 * 入れない。
 */
export const LOCAL_UI_AUTO_DRAFT_TEXT = deepFreeze({
  heading: 'シナリオの下書きを作る',
  guidance:
    '最後の「操作の候補を探す」の結果から、API で送る登録のシナリオの下書き・照合の READ の定義・入力の規則を、まとめて作ります。更新のシナリオは作らず、変える欄を選ぶ作成の画面へ案内します。サイトには接続しません。承認・副作用の確認・書き込みは行いません。',
  open: 'シナリオの下書きを作る',
  opening: '作るものを確かめています…',
  creating: '作っています…',
  cannotHeading: '今は、シナリオの下書きを作れません',
  blockers: {
    PROFILE_NOT_EDITABLE: {
      description: 'このプロファイルでは、シナリオを作れません（承認した書き込みのモードでない、または取り消したプロファイルです）。',
      action: 'テスト環境の、承認した書き込みのモードのプロファイルで行ってください。',
    },
    DISCOVERY_MISSING: {
      description: '最後の「操作の候補を探す」の結果を読めないか、まだ発見の記録がありません。',
      action: '「操作の候補を探す」を行ってから、もう一度押してください。',
    },
    DISCOVERY_STALE: {
      description: '最後の「操作の候補を探す」の後に、プロファイルを変えました（発見の時の改訂と今の改訂が違います）。',
      action: '「操作の候補を探す」をやり直してから、押してください。',
    },
    NO_API_ROWS: {
      description: '最後の発見の結果に、API で送る登録・更新の型がありません。',
      action: 'form で送る画面は、候補の一覧の「シナリオを作る」から作ってください。',
    },
    PREVIEW_OUTDATED: {
      description: '確かめた後に、プロファイルか最後の発見が変わりました。何も作っていません。',
      action: '画面を読み込み直して、作るものをもう一度確かめてください。',
    },
  },
  dialog: {
    title: 'シナリオの下書きを作りますか',
    body: '次のものを作ります。どれも下書きで、承認・副作用の確認・書き込みは行いません。推測した項目は、シナリオの画面で確かめてください。',
    confirm: '下書きを作る',
    cancel: 'やめる',
  },
  createsHeading: '登録のシナリオの下書き',
  updatesHeading: '更新のシナリオ（変える欄を選んで作る）',
  noCreates: '登録の型はありません。',
  noUpdates: '更新の型はありません。',
  createStatuses: {
    NEW: '下書きを作ります',
    EXISTING: '既にあります（作りません）',
    REJECTED: '作れません',
  },
  createdStatus: '下書きを作りました',
  failedStatus: '保存できませんでした',
  updateStatuses: {
    NEEDS_CHANGED_FIELDS: '変える欄を選んでください（作成の画面で選んで保存します）',
    EXISTING: '既にあります（作りません）',
    REJECTED: '作れません',
  },
  rowLabel: (method: string, pathShape: string, pagePath: string): string => `${method} ${pathShape}（画面 ${pagePath}）`,
  recordIdKeyLabel: '登録の ID を読む応答の鍵',
  recordIdKeyMissing: '推せませんでした。シナリオの画面の「変える」で、登録の ID を読む応答の鍵を入れてください。',
  readCheckLabel: '照合の READ の定義',
  readCheckOutcomes: {
    CREATED: '作りました',
    EXISTING: '同じ型の定義が既にあるので、それを使います',
    NOT_INFERRED: '型を推せませんでした。READ の確かめの画面で「画面を読む定義」を作り、シナリオの照合の READ に選んでください',
    LIMIT_REACHED: '定義の数の上限に達しているので、作りませんでした。使わない定義を削除してから、シナリオの照合の READ を選んでください',
    REJECTED: '定義の保存の確かめで拒まれたので、作りませんでした',
    NOT_LINKED: '型は推せましたが、照合の READ に結べないので、定義を作りませんでした（理由は「照合の READ の期待の欄」）',
    NOT_ATTEMPTED: 'シナリオを作れなかったので、扱っていません',
  },
  readCheckPlannedOutcomes: {
    CREATED: '作ります',
    EXISTING: '同じ型の定義が既にあるので、それを使います',
    NOT_INFERRED: '型を推せません（人が作ります）',
    LIMIT_REACHED: '定義の数の上限に達しているので、作りません',
  },
  expectationLabel: '照合の READ の期待の欄',
  // FM2R の Minor 10: 期待を結ばなかった理由ごとの文（事実のとおり。結んだときは推した欄と印を出す）。
  expectationOutcomes: {
    LINKED: '推した期待で、照合の READ に結びました。',
    RULES_NOT_ATTACHED: '入力の規則を付けられなかったので、実行のたびに値が変わる欄を求められず、推せませんでした。入力の規則を決めてから、シナリオの画面の「変える」で照合の READ を入れてください。',
    NO_READ_CHECK: '照合の READ の定義がないので、結べませんでした（上の「照合の READ の定義」）。',
    NO_VARYING_FIELD: '実行のたびに値が変わる欄がないため、推せませんでした。入力の規則で値が 2 つ以上になる欄を作ってから、シナリオの画面の「変える」で照合の READ の期待を入れてください。',
    LINK_FAILED: '照合の READ を結んだ版の保存が拒まれたので、結べませんでした。シナリオの画面の「変える」で照合の READ を入れてください。',
  },
  rulesLabel: '入力の規則',
  rulesPlanned: '推した規則の集まりを作って付けます',
  rulesAttached: '推した規則の集まりを付けました',
  rulesFailed: '入力の規則を付けられませんでした。入力の規則の画面で決めてください。',
  unresolvedHeading: '推せなかった欄（入力の規則の画面で入れてください）',
  noUnresolved: '推せなかった欄はありません。',
  openScenario: 'シナリオを開く',
  openCreateForm: '作成の画面で変える欄を選ぶ',
  openRules: '入力の規則を開く',
  resultHeading: '作った結果',
  // 作成の画面（更新の案内から開いたとき）。
  form: {
    chooseChangedFields: 'このシナリオは、変える欄を人が必ず選びます。変える欄を 1 つ以上「変える」にしてから保存してください。保存の後に、推した入力の規則を付けます。',
    chooseLedger: '台帳にできる登録のシナリオが 2 つ以上あります。台帳を選んでください。',
    noLedger: '台帳にできる登録のシナリオがありません。発見の画面の「シナリオの下書きを作る」か、登録のシナリオを先に作ってください。',
    presetHeading: '前もって選んだ値',
    presetLedger: '台帳',
    presetFormPathTemplate: '更新の画面の型',
  },
  savedWithRules: 'シナリオを保存し、推した入力の規則を付けました。推せなかった欄は、入力の規則の画面で入れてください。',
  savedRulesFailed: 'シナリオを保存しました。入力の規則は付けられなかったので、入力の規則の画面で決めてください。',
  // シナリオの画面と承認のダイアログ。
  inferredHeading: '推測した項目（確かめてください）',
  inferredNote:
    '次の項目は、BeakSight が推した値のままです。正しいかを確かめ、違えば「変える」（入力の規則は「入力の規則を開く」）で直してください。人が入れた値には、この印を出しません。この印は承認には結び付きません。',
  inferredItems: {
    RECORD_ID_KEY: '登録の ID を読む応答の鍵',
    READ_PAGE_TEMPLATE: '照合の READ の画面の型',
    READ_EXPECTATION: '照合の READ の期待の欄（本文が含む）',
    UPDATE_FORM_PATH_TEMPLATE: '更新の画面の型（前もって選んだ先頭の型）',
    DEFAULT_RANGE_FIELD: '範囲の既定の幅を入れた欄（入力の規則）',
  },
  approveInferredHeading: '推測した項目が残っています',
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
  /** 欄の長さの説明（`minText`・`maxText` は単位のない整数の書式 `formatInteger` の結果。T36c で下限を足した。T36R-fix で DEF-123 を直した）。 */
  valueLengthHint: (minText: string, maxText: string): string => `${minText} 文字以上、${maxText} 文字まで。`,
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

// ---------------------------------------------------------------------------------------------------------------
// プロファイルの「次にすること」と、保存の後の次の手順（T43a。Task 43 の設計書 4.1）
// ---------------------------------------------------------------------------------------------------------------

/**
 * プロファイルの詳細の「次にすること」の欄と「監査を始める」の欄、保存の後の次の手順のリンクの文言（T43a）。手順と状態のラベルは表示のカタログ
 * （`PROFILE_NEXT_STEP_CATALOG`・`NEXT_STEP_STATE_CATALOG`）。監査を始められない理由の説明と手順は `AUDIT_JOB_START_REJECTION_DESCRIPTIONS`、
 * 一覧に出す短い文は `auditStartUnavailable`（理由の値は、取り消しと、`execution-policy.ts` の操作を拒む理由。書き漏れと余分は画面の側の
 * `catalog-coverage.ts` で型で確かめる）。
 */
export const LOCAL_UI_NEXT_STEP_TEXT = deepFreeze({
  heading: '次にすること',
  body: 'プロファイルを作ってから監査を始めるまでの手順です。「要る」と「古い（直す）」の手順を、上から順に済ませてください。',
  columns: {
    step: '手順',
    state: '状態',
    action: '画面',
  },
  /** 手順の画面へのリンク（`stepLabel` は手順のラベル）。 */
  openStep: (stepLabel: string): string => `${stepLabel}を開く`,
  /** 古くなった手順を直す画面へのリンク（`stepLabel` は手順のラベル）。 */
  fixStep: (stepLabel: string): string => `${stepLabel}を直す`,
  auditStart: {
    heading: LOCAL_UI_AUDIT_TEXT.pages.startAudit,
    unavailable: '今は、このプロファイルで監査を始められません。',
  },
  /** 保存の後と、ログインの確かめの成功の後に出す、次の手順のリンク。 */
  after: {
    heading: '次の手順',
    openOverview: 'プロファイルの「次にすること」を見る',
    actions: {
      AUTH_SETUP: LOCAL_UI_AUTH_TEXT.profileDetail.open,
      CREDENTIAL: '資格情報を登録する',
      LOGIN_CHECK: LOCAL_UI_LOGIN_CHECK_TEXT.profileList.loginCheck,
      AUDIT_START: LOCAL_UI_AUDIT_TEXT.profileList.startAudit,
    },
  },
  /** プロファイルの一覧で、監査を始められない行に出す短い理由。 */
  auditStartUnavailable: {
    PROFILE_RETIRED: '取り消したプロファイルなので、監査を始められません。',
    MODE_NOT_EXECUTABLE: 'この監査モードでは、監査を始められません。',
    AUTH_STRATEGY_NOT_EXECUTABLE: 'この認証の方式では、監査を始められません。',
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
  // T41b: 発行の確かめ直し（下書きの保存の後に、台帳の登録の ID を読む応答の鍵が変わった）。
  SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID: {
    description: '台帳（参照した登録のシナリオ）の今の版の登録の ID で、この API の更新の行を選べなくなりました（送り先の Origin と path が違う、または登録の ID を読む応答の鍵が filter の名前と違う）。書き込みは始めていません。',
    action: '台帳の登録の送り先と ID の鍵を合わせるか、同じ表の台帳を選んでこのシナリオを変更し、承認し直してください。',
  },
  // T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: 照合の READ の期待が、実行のたびに変わる値と比べない。
  READ_VERIFICATION_NOT_VARYING: {
    description: '照合に使う画面の READ（{id} の型）の期待が、毎回同じ値になる欄（値が 1 つだけの固定の一覧など）とだけ比べています。別の登録の画面を読んでも一致しうるので、書き込みは始めていません。',
    action: '期待の比べる欄を、生成した値の欄（実行のたびに変わる欄）にするか、その欄の入力の規則を、値が 2 つ以上になる作り方にしてください。',
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
  /** T40a-fix: API のシナリオの検証の指定の説明（成否の条件と入力の誤りの条件は使わないので、欄を出さない）。 */
  apiVerificationNote:
    'API で送るシナリオは、送った要求の応答の状態と、取れた登録の ID で結果を確かめます。成功の条件と入力の誤りの条件は使いません。登録の ID は、応答の本文の鍵か、ここの取り方のどちらかで決めます。',
  /** T40a-fix: API のシナリオの登録の ID の取り方の表示（応答の本文の鍵）。 */
  apiRecordIdValue: (key: string): string => `応答の本文の鍵 ${key}`,
  /**
   * T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行。使える度合い）: 画面から登録の ID を取る型が、書き込みの画面の path にも当たるときの注意（保存は
   * 拒まない）。保存の画面とシナリオの詳細の画面が出す。
   */
  recordIdPatternCaution:
    'この ID の型は、書き込みの画面（登録の画面）の path にも当たります。書き込みの前の画面の一部を ID として取り違えないよう、登録の ID は応答の本文の鍵から取る形を勧めます。',
  /** T40R2-fix（M-1）: 開始の画面の、照合の READ の期待が実行のたびに変わる値と比べないときの見出し。 */
  readVerificationNotVaryingHeading: '照合の READ の期待',
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
  /** T44e（Task 44 の設計書 P2-4）: 送る前の確かめで止めた具体的な理由の欄の見出し。 */
  precheckDetailHeading: '送らずに止めた理由',
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
  /**
   * T40d（Task 40 の設計書 3.4、3.5）: 送り方と API の要約の項目名と文言（書き込みの結果・履歴・開始の画面と、書き込みの報告が共用する。送り方の値の
   * ラベルは `SCENARIO_TRANSPORT_CATALOG`）。シナリオの画面と同じ意味の項目名は、`LOCAL_UI_SCENARIO_TEXT.api` の値をそのまま使う。
   */
  api: {
    heading: 'API の要求の型（承認した型）',
    transport: LOCAL_UI_SCENARIO_TEXT.api.transport,
    method: LOCAL_UI_SCENARIO_TEXT.api.method,
    origin: LOCAL_UI_SCENARIO_TEXT.api.origin,
    pathShape: LOCAL_UI_SCENARIO_TEXT.api.pathShape,
    shapeDigest: '型の digest',
    keyNames: '送る鍵',
    httpFieldNames: '許すヘッダの名前',
    recordIdKey: LOCAL_UI_SCENARIO_TEXT.api.recordId,
    recordIdKeyUnset: LOCAL_UI_SCENARIO_TEXT.api.recordIdUnset,
    pageKeyValuesHeading: 'ページが決める鍵とその値',
    pageKeyColumns: { key: '鍵', value: '値（JSON）' },
    noPageKeys: LOCAL_UI_SCENARIO_TEXT.api.noPageKeys,
    none: LOCAL_UI_SCENARIO_TEXT.api.none,
    /** 成否の条件と入力の誤りの条件を使わないことと、判定のしかた（T40a の報告の設計者の判断）。 */
    judgementNote:
      'API で送る書き込みは、成功の条件と入力の誤りの条件を使いません。送った要求の応答の HTTP の状態（2xx は成功、429 は要求が多すぎる、ほかの 4xx は入力の誤り、5xx はサーバの誤り）と、取れた登録の ID で結果を判定します。応答の判定のラベルは、この判定の結果です。',
    /** ページが決める鍵の値の null の印（長さの上限を超えた値は残さない）。 */
    pageKeyValueCut: '長さの上限を超えたので、値を残していません',
    /** ページが決める鍵の値の全体がない回（送らなかった、送る前の照合まで進まなかった）。 */
    pageKeyValuesNotRecorded: '値はありません（送らなかったか、送る前の照合まで進みませんでした）',
    /** T41e: 更新のページが決める鍵（送る前の値と照らし、値は残さない）。 */
    pageKeyValueNotKeptForUpdate: '更新では値を残しません（送る前の画面の値と同じであることを照らしました）',
  },
  /**
   * T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」の文言（更新のシナリオの開始の画面と、登録のジョブの画面）。状態と理由のラベルは
   * `WRITE_CHAIN_STATE_CATALOG`・`WRITE_CHAIN_STOP_REASON_CATALOG`。
   */
  chain: {
    heading: '登録してから更新する',
    /** 出す理由ごとの説明（`WRITE_CHAIN_OFFER_REASONS`）。 */
    offerReasons: {
      NO_TARGET:
        '更新できる照合済みのレコードがありません。台帳の登録のシナリオで 1 件登録し、照合済みになったら、続けてそのレコードを更新できます。',
      PREVIOUS_UPDATE_STOPPED:
        '最新のレコードでは、前の更新が照合済みにならずに止まりました。台帳の登録のシナリオで新しく 1 件登録し、照合済みになったら、続けてそのレコードを更新できます。',
    },
    open: '登録してから更新する',
    notStartable: '台帳の登録のシナリオか、この更新のシナリオが、今は始められません。それぞれの開始の画面で理由を確かめてください。',
    dialogTitle: '登録してから更新しますか',
    dialogBody:
      'テスト環境に、登録を 1 件送り、照合済みになったら、続けてそのレコードの更新を 1 件送ります。登録が照合済みにならなければ、更新は始めません。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
    /** 確認のダイアログの 2 回の書き込み（`scenarioId` はシナリオの id）。 */
    stepCreate: (scenarioId: string): string => `1 回目: 登録（シナリオ ${scenarioId}）`,
    stepUpdate: (scenarioId: string): string => `2 回目: 更新（シナリオ ${scenarioId}）`,
    stepAction: '送り先',
    stepRemaining: '累積の残り',
    /** 累積の残り（`remainingText`・`limitText` は `formatCount` の結果）。 */
    remainingValue: (remainingText: string, limitText: string): string => `残り ${remainingText}（上限 ${limitText}）`,
    stepTarget: '更新するレコード',
    stepTargetValue: '1 回目で登録して照合済みになったレコード',
    confirm: '登録してから更新する',
    stateHeading: '続けて更新する予定',
    stateLabel: '状態',
    reasonLabel: '更新を始めなかった理由',
    /** T41g-3: 自動ログインの間隔を待った後に、更新を始め直す時刻の項目名。 */
    nextStartAt: '更新を始め直す時刻',
    updateScenario: '更新のシナリオ',
    openUpdateJob: '更新のジョブを開く',
    /** 何も始めずに拒んだ理由（`WRITE_CHAIN_START_REJECTION_REASONS`）。 */
    startRejections: {
      CHAIN_NOT_OFFERED: {
        description: '今は「登録してから更新する」を使う場面ではありません（更新の予定のレコードがあります）。何も始めていません。',
        action: '画面を読み込み直して、更新の予定のレコードを確かめてから、「書き込みを始める」を使ってください。',
      },
      CREATE_NOT_STARTABLE: {
        description: '台帳の登録のシナリオが、今は始められません。何も始めていません。',
        action: '台帳の登録のシナリオの開始の画面で、始められない理由を確かめてください。',
      },
      UPDATE_NOT_STARTABLE: {
        description: 'この更新のシナリオが、今は始められません（承認、検証の指定、上限、間隔など。画面の版が古い場合も含みます）。何も始めていません。',
        action: '画面を読み込み直して、始められない理由を確かめてください。',
      },
    },
  },
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
    // T40d: API の書き込みの要約の節（FORM の報告には置かない）。
    api: '送り方と API の要求の型',
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
  /** T40d: API の書き込みの要約の節の項目名と文言（画面と同じ）。 */
  api: LOCAL_UI_WRITE_TEXT.api,
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

/**
 * スクリプトで送るログインの画面の文言（T34d。Task 34 の設計書 3.1、3.2、3.6）。プロファイルの画面の「承認したサービスの Origin」の欄と、認証の
 * 設定の画面の、ログインの送り方・token の送信先・必須の query・ログインに伴う送信・成功のローカル ストレージの鍵の欄。ログインの送り方の名前は
 * `LOGIN_TRANSPORT_CATALOG`。
 */
export const LOCAL_UI_SCRIPT_LOGIN_TEXT = deepFreeze({
  profile: {
    approvedServiceOrigins: '承認したサービスの Origin（1 行に 1 つ）',
    /** 欄の補足（`maxText` は `formatCount` の結果）。 */
    approvedServiceOriginsHint: (maxText: string): string =>
      `認証のサービスと API の Origin を書きます（${maxText} まで。例: https://auth.test.example.invalid）。監査の対象の Origin は書きません（クロールの範囲は広げません）。`,
  },
  setup: {
    loginTransport: 'ログインの送り方',
    loginTransportHint: 'ログインの画面で、ログインのボタンを押したときの送り方です。',
    approvedServiceOrigins: '承認したサービスの Origin',
    noServiceOrigins: 'なし',
    scriptHeading: 'スクリプトで送るログイン',
    scriptBody:
      'ログインの段で通すのは、下の token の送信先への、スクリプトの POST だけです（必須の query がすべてあるとき、回数の上限まで）。ほかの送信は止めて記録します。',
    noServiceOriginsNotice: 'プロファイルに、承認したサービスの Origin がありません。先にプロファイルの画面で足してください。',
    scriptOrigin: 'token の送信先の Origin',
    scriptOriginHint: 'プロファイルの「承認したサービスの Origin」から選びます。',
    selectPlaceholder: '選んでください',
    scriptPath: 'token の送信先のパス',
    scriptPathHint: '/ で始まるパスです（query は、下の「必須の query」に書きます）。',
    methodFixed: '送信の method',
    methodFixedValue: 'POST だけ',
    requiredQuery: '必須の query',
    /** 必須の query の補足（`maxText` は `formatCount` の結果）。 */
    requiredQueryHint: (maxText: string): string =>
      `要求の query に、この名前と値の組がすべてあるときだけ通します（${maxText} まで。例: 名前 grant_type、値 password）。`,
    queryName: '名前',
    queryValue: '値',
    addQuery: 'query の組を足す',
    removeQuery: 'この組を消す',
    sideRequests: 'ログインに伴う送信',
    /** ログインに伴う送信の補足（`maxText`・`perLoginText` は `formatCount`・`formatTimes` の結果）。 */
    sideRequestsHint: (maxText: string, perLoginText: string): string =>
      `ログインの画面のスクリプトが、token のほかに送る POST です（${maxText} まで。1 回のログインで ${perLoginText} まで）。まず空で試し、止めた記録を見て、要るものだけを登録します。`,
    sideOrigin: 'Origin',
    sidePath: 'パス',
    sideMaxPerLoginStage: '1 回のログインの回数',
    addSideRequest: '送信を足す',
    removeSideRequest: 'この送信を消す',
    noSideRequests: 'ログインに伴う送信はありません。',
    storageKeyHeading: '成功のローカル ストレージの鍵',
    storageKeyBody:
      'ログインの後に、この Origin のローカル ストレージに、接頭辞で始まり接尾辞で終わる名前の鍵があれば、ログインが済んだとみなします（成功の条件に足します。値は読みません）。',
    storageOrigin: '鍵の Origin',
    storageOriginHint: 'プロファイルの「テスト環境の Origin」から選びます。',
    storagePrefix: '鍵の名前の接頭辞',
    storagePrefixHint: '鍵の名前の始まりです（例: app-）。接頭辞と接尾辞の両方を空にはできません。',
    storageSuffix: '鍵の名前の接尾辞',
    storageSuffixHint: '鍵の名前の終わりです（例: -auth-token）。',
  },
} as const);

/**
 * ジョブの詳細の「ログインの段で止めた送信」（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行）。止めた読み取りでない要求の Origin と path と種類と理由と
 * 回数の表、数のまとめ、登録の案内。値・query・本文は、画面のサーバに届かない（ジョブの記録には、Origin と path だけがある）。
 */
export const LOCAL_UI_LOGIN_STAGE_TEXT = deepFreeze({
  heading: 'ログインの段で止めた送信',
  body: 'ログインの段で止めた、読み取りでない送信です（Origin とパスと query の名前だけを残します。値は grant_type の決まった形の値のほか、本文とともに残しません）。',
  guidance:
    'ログインに要る送信なら、認証の設定の「ログインに伴う送信」に登録してください。読み取りか、ログインに要る処理かは、利用者が判断します。',
  openSetup: '認証の設定を開く',
  tableCaption: '止めた送信（同じ Origin・パス・種類・理由は 1 行にまとめます）',
  columns: {
    origin: 'Origin',
    path: 'パス',
    resourceType: '種類',
    reason: '理由',
    count: '回数',
  },
  /** 値に見える区切り（長い base64url・16 進、JWT の形）を `[REDACTED]` に伏せたパスに添える文（T34e fix round 1）。 */
  redactedPathNote: '（値に見える区切りを伏せました）',
  /** 一覧の上限を超えた送信の数（`countText` は `formatCount` の結果）。 */
  unlisted: (countText: string): string => `ほかに ${countText}の送信を止めました（一覧の上限を超えたので、表には出していません）。`,
  countsHeading: '数のまとめ',
  tokenRequestsAllowed: '通した token の送信',
  sideRequestsAllowed: '通したログインに伴う送信',
  serviceOriginReads: '承認したサービスの Origin への読み取り',
  blockedTotal: '止めた読み取りでない送信',
  /**
   * T36R-fix（T36R の M-7）: 自動ログインで、資格情報を含む要求を止めた数（token の送信のほか。読み取りの要求も含むので、止めた読み取りでない送信の数には
   * 足さず、独立の欄に出す）。
   */
  credentialRequestsBlocked: '資格情報を含む要求を止めた数',
  /** ML-b（手動のログインの通して記録する決まり。設計書 2.3）: 手動のログインの段で通した送信の表。 */
  passedTableCaption: '手動のログインの間に通した送信（同じ Origin・パス・種類は 1 行にまとめます。値は残しません）',
  /** ML-b-3: token の送信より前に最初に見た行の印（自動の登録は、この印のある手続きの呼び出しだけをログインに伴う送信にします）。 */
  passedBeforeToken: 'token の送信より前',
  passedUnlisted: (countText: string): string => `ほかに ${countText}の送信を通しました（一覧の上限を超えたので、表には出していません）。`,
} as const);

/**
 * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ジョブの詳細の「ログインの段」の欄の、ログインの後のブラウザの状態の名前の記録。
 * 名前は先頭と末尾の一般の語の形だけで、値・中身・名前の全体は、画面のサーバに届かない。
 */
export const LOCAL_UI_LOGIN_STATE_NAMES_TEXT = deepFreeze({
  heading: 'ログインの後のブラウザの状態の名前',
  note:
    'ログインの段の終わりに読んだ、ブラウザの状態の名前です。それぞれを監査に引き継いだか、許可した Origin と承認したサービスの Origin の外なので外したかを示します。名前は先頭と末尾の一般の語だけを残し、値と中身は残しません。',
  cookiesCaption: 'Cookie（同じドメイン・パス・名前の形・結果は 1 行にまとめます）',
  localStorageCaption: 'ローカル ストレージの鍵（同じ Origin・名前の形・結果は 1 行にまとめます）',
  indexedDBCaption: 'IndexedDB のデータベース（同じ Origin・名前の形・結果は 1 行にまとめます）',
  columns: {
    domain: 'ドメイン',
    path: 'パス',
    hostOnly: '送る先',
    origin: 'Origin',
    shape: '名前の形（先頭と末尾）',
    outcome: '監査への引き継ぎ',
    count: '名前の数',
  },
  outcomeLabels: { CARRIED: '引き継いだ', OUTSIDE_APPROVED: '外した（許可の外）' },
  hostOnlyLabels: { hostOnly: 'その host だけ', domain: 'サブドメインにも送る' },
  /** 先頭と末尾に一般の語のない名前（名前は残さない）。 */
  noShape: '（一般の語のない名前）',
  none: 'なし',
  /** 表の上限を超えた名前の数（`countText` は `formatCount` の結果）。 */
  unlisted: (countText: string): string => `ほかに ${countText}の名前があります（表の上限を超えたので、出していません）。`,
} as const);

/**
 * ML-b（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2〜2.4）: 手動のログインの「ログインを終えた」と、手動のログインの成功から自動で
 * 登録した設定の文言（ジョブの画面とプロファイルの画面）。
 */
export const LOCAL_UI_MANUAL_LOGIN_TEXT = deepFreeze({
  heading: '手動のログイン',
  note:
    '開いたブラウザで、ログインを済ませてください。ログインの間の操作（ログインの送信、ページの手続きの呼び出しなど）は、普通のブラウザと同じく、サイトへ送られます（形だけを記録し、値は残しません）。ログインが済んだら、「ログインを終えた」を押してください。成功の条件に当たれば、押さなくても先へ進みます。',
  confirm: 'ログインを終えた',
  confirming: '知らせています…',
  accepted: 'ログインを終えたことを知らせました。状態を保存して、監査に進みます。',
  rejected: 'ログインを終えたことを、受け付けられませんでした。',
  /** DEF-146: 「ログインを終えた」の Server Function の呼び出しが例外で終わった・結果の形でない値で終わったときの理由（ジョブの管理には届いていない）。 */
  requestFailed:
    '画面のサーバとのやりとりで誤りが起きたため、知らせを届けられませんでした（通信の誤りか、入力の検証の誤り）。画面のサーバが動いているかを、起動したコンソールで確かめてから、もう一度押してください。',
  /**
   * ML-b-2: 拒んだ理由の説明（ジョブの管理の閉じた一覧 `AUDIT_JOB_LOGIN_CONFIRM_REJECTION_REASONS`。網羅は画面の側の
   * `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる）。
   */
  rejectionReasons: {
    JOB_NOT_FOUND: 'このジョブが見つかりません。ジョブの一覧から開き直してください。',
    JOB_NOT_ACTIVE: 'このジョブは、もう動いていません。続けるなら、監査を始め直してください。',
    NOT_AWAITING_LOGIN: 'このジョブは、今は手動のログインを待っていません（ログインの前か後、または止める要求の後です）。画面の状態を確かめてください。',
    ALREADY_CONFIRMED: 'ログインを終えたことは、もう知らせてあります。監査に進むまで待ってください。',
  },
  /**
   * ML-b-2（設計書 2.3）: 手動のログインの成功から、ジョブの管理がジョブの終わりの後に設定を自動で登録した結果（ジョブの画面）。SKIPPED の理由は閉じた一覧
   * `AUDIT_JOB_LOGIN_AUTO_REGISTRATION_SKIP_REASONS`（網羅は `catalog-coverage.ts` で型で確かめる）。
   */
  autoRegistration: {
    saved: 'このジョブの手動のログインから、設定を登録しました。',
    savedRevision: '保存したプロファイルの改訂',
    addedServiceOrigins: '足した承認したサービスの Origin',
    skipped: 'このジョブの手動のログインからは、設定を登録しませんでした。',
    skipReason: '理由',
    next: '次にすること',
    skipReasons: {
      NO_PASSED_REQUESTS: {
        label: '通した送信がない',
        next: 'ログインの間に通した送信がないため、登録するものはありません。設定が要るなら、認証の設定の画面で入れてください。',
      },
      NO_TOKEN_REQUEST: {
        label: 'token の送信が見つからない',
        next: '通した送信に、token の送信の形（grant_type を持つ送信）がありませんでした。ログインの段の表を見て、認証の設定の画面で token の送信先を入れてください。',
      },
      NO_STORAGE_KEY: {
        label: '成功の鍵の案がない',
        next: 'ログインの後のローカル ストレージに、新しい鍵が見つかりませんでした。認証の設定の画面で、成功の鍵の形を入れてください。',
      },
      NOTHING_NEW: {
        label: '足すものがない',
        next: '通した送信は、今の設定にすべて入っています。することはありません。',
      },
      PROFILE_CHANGED: {
        label: 'プロファイルか認証の設定が変わった',
        next: 'ジョブを始めた後に、プロファイルか認証の設定が変わったため、上書きしませんでした。要るなら、ログインの段の表の「登録する」から入れてください。',
      },
      SAVE_REJECTED: {
        label: '保存の確かめを通らなかった',
        next: '組み立てた設定を、保存の確かめが受け付けませんでした。ログインの段の表の「登録する」から、認証の設定の画面で中身を確かめて入れてください。',
      },
      MULTIPLE_TOKEN_TARGETS: {
        label: 'token の送信先が 1 つに決まらない',
        next: 'token の送信先が 2 つ以上あり、1 つに決まらないため、登録しませんでした。通した送信の表の token の行から「登録する」で、正しい送信先を選んで登録してください。',
      },
    },
  },
  setupHeading: '手動のログインから登録した設定',
  setupNote:
    '手動のログインが成功したときに、通した送信とログインの後の状態から、Guard を通るための設定を自動で登録します（自動ログインはこの設定で、登録した送信だけを通します）。中身を見直し、違っていれば認証の設定の画面で直してください。',
  token: 'token の送信先',
  /** token の送信先の必須の query（名前だけ）。 */
  tokenQueryNames: (names: string): string => `（必須の query: ${names}）`,
  sideRequests: 'ログインに伴う送信',
  /** ログインに伴う送信 1 件（`maxText` は `formatCount` の結果）。 */
  sideRequestValue: (method: string, target: string, maxText: string): string => `${method} ${target}（ログインの段 1 回あたり ${maxText}まで）`,
  serviceOrigins: '承認したサービスの Origin',
  successKey: '成功のローカル ストレージの鍵',
  /** 鍵の形（接頭辞と接尾辞。間の部分は持たない）。 */
  successKeyValue: (prefix: string, suffix: string): string => `${prefix}…${suffix}`,
  none: 'なし',
  revisionNote:
    '設定を保存すると、プロファイルの改訂が進みます。承認済みのシナリオや、発見・READ の確かめの結果は、やり直しが要ることがあります。',
  review: '認証の設定の画面で見直す',
} as const);

/**
 * T43d（Task 43 の設計書 4.4）: 観察した要求の「登録する」と、ログインの段の観察（成功の鍵の名前と成功の画面のセレクタの案）、認証の設定の画面の下書きの
 * 文言。「登録する」はその場で保存しない（認証の設定の画面を下書きつきで開き、利用者が確かめて保存する）。
 */
export const LOCAL_UI_LOGIN_OBSERVATION_TEXT = deepFreeze({
  columns: {
    query: 'query の名前',
    register: '登録',
  },
  /** query の名前の一覧の後に、一覧に入れなかった名前の数を添える文（`countText` は `formatCount` の結果）。 */
  omittedQueryNames: (countText: string): string => `ほか ${countText}`,
  /** 残した値（`grant_type=password` の形で出す）の前に置く語。 */
  recordedValue: '値',
  noQuery: 'なし',
  register: '登録する',
  /** 行の登録先（ボタンの説明）。 */
  registerTokenTarget: 'token の送信先として登録します（送り方は「スクリプトで送る」）。',
  registerSideRequest: 'ログインに伴う送信として登録します（POST、1 回のログインで 1 回まで）。',
  /** ボタンを出さない行の案内。 */
  manualRedactedPath: '値に見える区切りを伏せたパスなので、登録の案を作れません。認証の設定に手で入れてください。',
  manualAlreadyRegistered: '登録してある送信の上限か送り方で止めました。認証の設定を開いて、登録の内容を手で直してください。',
  /** ログインの段の観察の欄。 */
  observationHeading: 'ログインの段で観察した案',
  observationBody: 'ログインの段の始めと終わりに読んだことから作った案です（値と画面の文字は残しません）。保存は認証の設定の画面で利用者が行います。',
  /** T43R-fix の C-1 (a): 鍵の名前は、区切りで分けた最初と最後の部分だけ（間の部分は残さない）。 */
  storageKeys: '新しく出たローカル ストレージの鍵の名前の形（成功の鍵の名前の案。最初と最後の部分だけで、間の部分は残しません）',
  storageKeysOrigin: '鍵の Origin',
  /** 1 つの形の、接頭辞と接尾辞の間に置く語。 */
  storageKeyMiddle: '…',
  successSelector: '成功の画面のセレクタの案',
  /** 案の説明（`word` は閉じた一覧のログアウトの語）。T43R-fix の C-1 (b): ログアウトの語を含む属性の CSS だけ。 */
  successSelectorLogout: (word: string): string => `ログアウトの語「${word}」に当たる見えるリンクかボタンの、ログアウトの語を含む属性`,
  /** T43R-fix の C-1 (c): 自動ログインで、入れた資格情報を含んだので捨てた案の数（`countText` は `formatCount` の結果）。 */
  credentialDiscarded: (countText: string): string => `入れた資格情報を含んだので、${countText}の案を捨てました。`,
  /** T43R-fix の M-5: ログインの段のまとめが管理データの上限を超えたので、観察と query の名前を省いた。 */
  observationOmitted: 'ログインの段のまとめが大きすぎたので、観察した案と query の名前を省きました。',
  applyObservation: '案を認証の設定に入れる',
  /** 認証の設定の画面の下書きの知らせ（T43R-fix の M-3: 下書きはジョブに結び付かない。URL で受け取ったもの）。 */
  draftHeading: 'URL で受け取った下書き',
  draftBody: 'URL で受け取った下書き（登録の案）を、欄に入れました。まだ保存していません。確かめてから保存してください。',
  /** 保存のときにプロファイルの承認したサービスの Origin にも足す Origin の知らせ（足す Origin は保存の時点の欄から決め直す）。 */
  draftServiceOrigins:
    '保存すると、保存の時点の token の送信先とログインに伴う送信の Origin のうち承認していないもの（今の欄では次の Origin）を、プロファイルの「承認したサービスの Origin」にも足し、プロファイルと認証の設定を 1 回で保存します。',
  draftInvalid: 'URL で受け取った下書きの形が正しくないので、欄に入れませんでした。',
} as const);

/**
 * FM-1（手動の操作を減らす設計書 2.2 の画面）: プロファイルの表示の設定（ジョブのブラウザを表示する。既定は表示）と、ジョブの画面の「見るだけ。操作しない」
 * の注意。理由は閉じた一覧（`PROFILE_DISPLAY_SETTINGS_REJECTION_REASONS`。網羅は `catalog-coverage.ts`）。
 */
export const LOCAL_UI_DISPLAY_SETTINGS_TEXT = deepFreeze({
  heading: '表示の設定',
  showJobBrowser: 'ジョブのブラウザを表示する',
  /** FM-3: 欄の説明（切り替えるとすぐ保存する。専用の保存のボタンはない）。 */
  autoSaveNote:
    'この欄の設定は、切り替えるとすぐ保存します。プロファイルの保存とは別です（プロファイルの「保存する」のボタンを押す必要はなく、押してもこの欄は変わりません）。',
  hint:
    '監査・発見・READ の確かめ・書き込みのジョブのブラウザを表示して、様子を見られます（ログインの段のブラウザは、いつも表示します）。切り替えると、すぐ保存します。切り替えても、プロファイルの改訂と承認は変わりません。次に始めるジョブから使います。',
  saving: '保存しています…',
  saved: '表示の設定を保存しました。',
  /** FM-3: 保存できなかったとき（チェックは元の値に戻す）。 */
  rejected: '表示の設定を保存できませんでした。チェックを、切り替える前の値に戻しました。',
  /** FM-3: Server Function が例外を投げたとき（入力の検証の誤り、通信の誤り）の理由。 */
  requestFailed: '画面のサーバとのやりとりで誤りが起きました（入力の検証の誤りか、通信の誤り）。画面のサーバが動いているかを確かめてから、もう一度切り替えてください。',
  reasons: {
    PROFILE_NOT_FOUND: 'プロファイルが見つかりません。',
    SETTINGS_INVALID: '表示の設定の値が正しくありません。',
  },
  watchOnly:
    'このジョブのブラウザを表示しています。見るだけにして、操作しないでください（操作すると、結果が乱れます。ブラウザを閉じると、ジョブは失敗として終わります）。',
  /** AS-b（監査の段の送信の扱いの設計書 2.1）: 監査の段の送信の扱いの切り替え（既定は読み取りだけ）。 */
  auditSendPassExceptDelete: 'ページが出す送信のうち、削除のほかを通す（監査・発見・READ の確かめ）',
  auditSendHint:
    '既定は読み取りだけです（ページが出す書き込みの送信を止めます）。通すと、ページが出す書き込みの送信がサイトに届きます。削除と危険な語の送信は止めます。通す側へは、確認のダイアログで「通す」を選んだときに保存します。外すときは、切り替えるとすぐ保存します。切り替えても、プロファイルの改訂と承認は変わりません。次に始めるジョブから使います。',
  auditSendDialogTitle: 'ページが出す書き込みの送信を通しますか',
  auditSendDialogBody: 'ページが出す書き込みの送信がサイトに届きます。削除と危険な語の送信は止めます。',
  auditSendConfirm: '通す',
  auditSendCancel: 'やめる',
} as const);

/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える画面（資格情報の画面の、手動のログインのプロファイルの形）と、「次から
 * 自動でログインする」の案内（FM-1 の手動の操作を減らす設計書 2.3。ジョブの画面とプロファイルの画面。FM2e で、3 つの画面への案内の
 * `LOCAL_UI_AUTOMATED_LOGIN_OFFER_TEXT` をここへ寄せて消した）の文言。理由と戻しの一覧は `apps/local-ui/src/server/credential-service.ts`（`AUTOMATED_LOGIN_SETUP_REJECTION_REASONS`・
 * `AUTOMATED_LOGIN_SETUP_ROLLBACKS`）。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts`。値（ユーザー名とパスワード）は入れない。
 */
export const LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT = deepFreeze({
  offer: {
    heading: '次から自動でログインする',
    body:
      '手動のログインで登録した設定を使って、次のジョブから BeakSight がログインできます（自動ログイン。Windows だけ）。1 つの画面で、認証の方式の変更・ログインの欄のセレクタ・資格情報をまとめて確かめ、1 回で保存します。保存するとプロファイルの改訂が進むので、承認済みのシナリオは承認が外れます。',
    open: '自動ログインの設定へ進む',
  },
  heading: '自動ログインに切り替える',
  intro:
    '認証の方式を「自動でログインする」に変え、ログインの欄のセレクタと、ログインに使う資格情報を、確認の後に 1 回で保存します。パスワードは、ここで人が入れてください（BeakSight は手動のログインで入力した値を読みません）。',
  method: {
    heading: '認証の方式',
    before: '今の方式',
    after: '保存の後の方式',
  },
  selectors: {
    heading: 'ログインの欄のセレクタ',
    body:
      '最後の手動のログインのときに、ログインの画面でそれぞれの欄の候補が 1 つだけだった要素から、案を入れてあります（入力した値は読んでいません）。違っていれば直してください。',
    noProposal: '案はありません。ログインの画面のこの欄をちょうど 1 つ指す CSS セレクタを入れてください。',
  },
  credentials: {
    heading: 'ログインに使う資格情報',
  },
  authSetupNotCurrentHeading: '先に認証の設定を保存し直してください',
  authSetupNotCurrentBody:
    '認証の設定がないか、プロファイルの今の改訂に結びついていません。認証の設定の画面で中身を確かめて保存してから、この画面に戻ってください。',
  openAuthSetup: '認証の設定を開く',
  review: '変更を確かめる',
  dialog: {
    title: '自動ログインに切り替えますか',
    body: '次のとおりに保存します。途中で失敗したときは、保存した資格情報を消して、前の状態に戻します。',
    item: '項目',
    before: '変える前',
    after: '変えた後',
    method: '認証の方式',
    maxLoginAttempts: 'ログインの段の POST の回数の上限',
    revision: 'プロファイルの改訂',
    credential: '資格情報',
    credentialAfter: '登録する（値は表示しません）',
    credentialBefore: 'なし',
    emptySelector: 'なし',
    /** 改訂が進むこと（`beforeText` と `afterText` は改訂の表示）。 */
    revisionNotice: (beforeText: string, afterText: string): string =>
      `プロファイルの改訂が ${beforeText} から ${afterText} に進みます。発見・READ の確かめの結果は、やり直しが要ることがあります。`,
    /** 今承認が有効なシナリオがあるとき（`countText` は `formatCount` の結果）。 */
    approvalNotice: (countText: string): string =>
      `承認したシナリオ（${countText}）の承認が外れます。承認はプロファイルの改訂に結びついているため、書き込みを始める前に、もう一度承認してください。`,
    confirm: '保存する',
    cancel: '保存せずに戻る',
  },
  saving: '保存しています…',
  done: '自動ログインに切り替えました。認証の方式・ログインの欄のセレクタ・資格情報を保存しました。',
  loginCheckNote:
    '「ログインを確かめる」は自動では始めません。自動ログインの間隔と上限に数えるので、確かめるときに下のボタンを押してください。',
  rejectedHeading: '自動ログインに切り替えられませんでした',
  rejections: {
    PROFILE_NOT_FOUND: {
      description: 'プロファイルが見つかりません。',
      action: 'プロファイルの一覧から開き直してください。',
    },
    NOT_OFFERED: {
      description: 'このプロファイルは、手動のログインの有効なプロファイルではありません（すでに自動ログインか、取り消してあります）。',
      action: '画面を読み直してください。資格情報の変更は、資格情報の画面の今の操作で行ってください。',
    },
    PROFILE_REVISION_CONFLICT: {
      description: 'この画面を開いた後に、プロファイルが変わりました（別の保存が先に行われました）。',
      action: '画面を読み直して、中身を確かめてから、もう一度保存してください。',
    },
    AUTH_SETUP_NOT_CURRENT: {
      description: '認証の設定がないか、プロファイルの今の改訂に結びついていません。',
      action: '認証の設定の画面で中身を確かめて保存してから、もう一度行ってください。',
    },
    TARGET_CONFIG_UNAVAILABLE: {
      description: 'プロファイルの指す対象の設定のファイルを読めませんでした。',
      action: '設定のファイルがあり、読めることを確かめてから、もう一度行ってください。',
    },
    PROFILE_INVALID: {
      description: '認証の方式を変えたプロファイルが、プロファイルの確かめを通りませんでした。',
      action: 'プロファイルの画面で中身を確かめてください。',
    },
    AUTH_SETUP_INVALID: {
      description: 'セレクタを入れた認証の設定が、認証の設定の確かめを通りませんでした。',
      action: '欄に出した誤りを直して、もう一度保存してください。ほかの項目の誤りは、認証の設定の画面で直してください。',
    },
    SAVE_FAILED: {
      description: '管理データを書けませんでした。',
      action: '画面のサーバを起動したコンソールの誤りを確かめてから、もう一度行ってください。',
    },
  },
  rollbacks: {
    NOT_NEEDED: '何も保存していません（前の状態のままです）。',
    REMOVED: '保存した資格情報のファイルを消し、前の状態に戻しました。',
    FAILED: '保存した資格情報のファイルを消せませんでした。この画面を読み直し、「資格情報を削除する」で消してください。',
  },
  requestFailed:
    '画面のサーバとのやりとりで誤りが起きたため、保存したかを確かめられませんでした。画面を読み直して、今の状態を確かめてください。',
} as const);

/**
 * FM-1（手動の操作を減らす設計書 2.1）: ログインの段の表の「登録する」（確認のダイアログの後に、その場で保存する。画面は移らない）の文言。理由は閉じた一覧
 * （組み立ての `LOGIN_STAGE_ROW_REGISTRATION_REJECTIONS` と、画面のサーバの `LOGIN_STAGE_ROW_REQUEST_REJECTIONS`。網羅は `catalog-coverage.ts`）。
 */
export const LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT = deepFreeze({
  /** 認証の設定の画面を下書きつきで開くリンク（T43d の下書き。保存は利用者）。 */
  editDraft: '認証の設定の画面で直す',
  preparing: '案を作っています…',
  dialogTitle: 'この送信を登録しますか',
  dialogBody:
    '次の内容を認証の設定に足して、その場で保存します。保存するとプロファイルの改訂が進むので、承認済みのシナリオや、発見・READ の確かめの結果は、やり直しが要ることがあります。',
  tokenTarget: 'token の送信先（送り方は「スクリプトで送る」。今の送信先があれば、これに替えます）',
  /** token の送信先の必須の query（名前だけ）。 */
  tokenQueryNames: (names: string): string => `（必須の query: ${names}）`,
  sideRequest: 'ログインに伴う送信',
  addServiceOrigins: '承認したサービスの Origin に足す Origin',
  nextRevision: '保存した後のプロファイルの改訂',
  confirm: '登録する',
  cancel: 'やめる',
  saving: '保存しています…',
  /** 保存の知らせ（`revisionText` は改訂の表示）。 */
  saved: (revisionText: string): string => `登録しました（プロファイルは${revisionText}になりました）。`,
  rejected: 'この送信は登録できません。',
  /** 保存の部品が拒んだ理由のコード。 */
  codes: (codes: string): string => `理由のコード: ${codes}`,
  reasons: {
    REDACTED_PATH: '値に見える区切りを伏せたパスなので、送信先が決まりません。「認証の設定の画面で直す」から手で入れてください。',
    EXCLUDED_PATH: '読まないパスか、危険な語（ログアウト・削除など）を含むパスなので、登録しません。',
    ALREADY_REGISTERED: 'この送信は、もう登録してあります（登録してある送信の上限か送り方で止めた行は、「認証の設定の画面で直す」から直します）。',
    NO_TOKEN_TARGET: 'token の送信先がまだないので、ログインに伴う送信を足せません。先に token の送信の行を登録してください。',
    NO_STORAGE_KEY: '成功のローカル ストレージの鍵が分かりません。「認証の設定の画面で直す」から、成功の鍵の形を入れてください。',
    SIDE_REQUEST_LIMIT: 'ログインに伴う送信は、もう上限の数まで登録してあります。',
    JOB_NOT_FOUND: 'このジョブが見つかりません。',
    ROW_NOT_FOUND: 'この行が見つかりません。画面を読み直してください。',
    PROFILE_NOT_FOUND: 'プロファイルが見つかりません。',
    AUTH_SETUP_NOT_FOUND: '認証の設定がまだありません。先に認証の設定の画面で保存してください。',
    PROFILE_CHANGED: '確認の後にプロファイルが変わりました。画面を読み直して、もう一度押してください。',
    SAVE_REJECTED: '保存の確かめを通りませんでした。「認証の設定の画面で直す」から、中身を確かめてください。',
  },
} as const);

/**
 * ジョブの詳細の、発見と READ の確かめのジョブの監査の段の数（T37a。Task 37 の設計書 3.1。成果物の `authentication`。`run.json` と同じ形）の文言。
 * ログインの段の要約（`LOCAL_UI_LOGIN_STAGE_TEXT`）と並べて出す。数だけで、URL・値は出さない。
 */
export const LOCAL_UI_AUDIT_STAGE_TEXT = deepFreeze({
  heading: 'ログインの後の読み取りの数',
  body: 'ログインの後に画面を読む間の、サービスへの要求の数です（数だけを残します。URL・本文・値は残しません）。',
  registeredReadRequestsAllowed: '通した、登録した読み取りの手続きの呼び出し',
  tokenRefreshBlocked: '止めた token の更新',
  otherNonReadBlocked: '止めた、そのほかの読み取りでない送信',
  serviceUnauthorizedResponses: 'サービスがログインの状態を受け付けなかった応答（401）',
  serviceRequestLimitReached: 'サービスへの要求の上限',
  /** DEF-141: 1 分あたりの上限で、次の読み込みの前に待った回数と時間の合計。 */
  serviceRequestPacingWaits: 'サービスへの要求の 1 分あたりの上限で待った回数',
  serviceRequestPacingWaitMs: 'サービスへの要求の 1 分あたりの上限で待った時間',
  limitReached: '届きました',
  limitNotReached: '届いていません',
  /** 上限に届いたときの説明。 */
  limitReachedNote:
    'サービスへの要求の 1 回の Run あたりの上限に届いたため、残りの画面（定義）は読んでいません。上限は認証の設定で決まります。時間を置いてから、もう一度始めてください。',
} as const);

/**
 * DEF-144: 発見と READ の確かめのジョブが安全の違反で止まったときの、違反の中身（成果物 `discovery.json`・`read-evidence.json` の `safetyViolation`）の表示。
 * 違反の種類のコードと文は英数字のまま出す（`run.json` と同じ値）。段の表示は `JOB_SAFETY_VIOLATION_STAGE_LABELS`。
 */
export const LOCAL_UI_SAFETY_VIOLATION_TEXT = deepFreeze({
  heading: '安全のために止めた理由',
  body: '安全の決まり（Safety Ledger の不変条件）に反することが起きたため、ジョブを止めました。残すのは種類と場所だけです（本文・query の値・Cookie・token は残しません）。',
  stage: '起きた段',
  pagePath: '画面の path',
  pressedWords: '押していたボタンの語',
  pressedNoWords: '（語のないボタン）',
  pressedIdentity: '押していた候補の識別',
  count: '違反の数',
  recordTruncated: '安全の記録が上限で欠けています（数は全体です）。',
  tableCaption: '違反の一覧',
  columns: { code: '種類', message: '内容', method: 'method', origin: 'Origin', path: 'path' },
  noRequest: '（要求なし）',
  noOrigin: '（Origin なし）',
  omittedText: (count: string): string => `一覧に載せなかった違反が ${count} 件あります。`,
} as const);

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 発見のジョブの、外部のアプリへ移るボタンの扱い（成果物の
 * `externalSchemeProbes`）の表示。
 */
export const LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT = deepFreeze({
  heading: '外部のアプリへ移るボタン',
  body: 'メールや電話など、外部のアプリへ移るボタン（mailto: や tel: など）は押しません。押してから分かったときは、安全のため画面を閉じ、その画面を 1 回だけ読み込み直して残りのボタンを確かめます。',
  notPressed: '外部のアプリへ移るので押さなかったボタン',
  reloadedPages: '残りのボタンを確かめるために読み込み直した画面',
} as const);

/**
 * T44c（Task 44 の設計書 P1-3）: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数（成果物の `pressLimitProbes`）の表示。
 */
export const LOCAL_UI_PRESS_LIMIT_PROBE_TEXT = deepFreeze({
  heading: '押す数の上限で押せなかった保存・登録のボタン',
  body: '送らずに観察する押下は、1 画面 3 回までです。見えないボタンは数える前に除き、保存・登録・更新などの語のあるボタンを先に押します。上限を超えて押せなかったボタンは、送り方が分からないので、登録・更新のシナリオの候補になりません。保存のボタンがあるのに候補が出ない画面があれば、この数を確かめてください。',
  priorityNotPressed: '上限で押せなかった、保存・登録・更新などの語のあるボタン',
} as const);

/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの、ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`）の表示。理由の
 * 説明は `INCOMPLETE_REASON_DESCRIPTIONS`、次にできることは `INCOMPLETE_REASON_NEXT_STEPS`。
 */
export const LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT = deepFreeze({
  heading: '確かめきれなかったページの理由',
  body: '監査したページのうち、一部を確かめきれなかったページの数を、理由ごとに示します。くわしくはレポートのページの欄を見てください。',
  tableCaption: '理由ごとのページ数',
  columns: { reason: '理由', pages: 'ページ数', nextStep: '次にできること' },
} as const);

/** DEF-144: 違反が起きた段（`JobSafetyViolationStage`）の表示。 */
export const JOB_SAFETY_VIOLATION_STAGE_LABELS = deepFreeze({
  CONTEXT_OPEN: 'ブラウザの画面を開く間',
  PAGE_LOAD: '画面の読み込みと読み取り',
  SUBMISSION_PROBE: '送らずに観察する押下（probe）の中',
  CONTEXT_CLOSE: '画面を閉じる間',
} as const satisfies Record<JobSafetyViolationStage, string>);

/**
 * ログインの段で止めた読み取りでない要求の理由（`src/control/worker-protocol.ts` の `WORKER_LOGIN_STAGE_BLOCK_REASONS`）ごとの表示（T34e）。書き漏れと
 * 余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 */
export const LOGIN_STAGE_BLOCK_REASON_LABELS = deepFreeze({
  TOKEN_REQUEST_OVER_LIMIT: 'token の送信の回数の上限を超えた',
  TOKEN_REQUEST_NOT_SCRIPT: 'token の送信先への、スクリプトでない送信',
  TOKEN_REQUEST_QUERY_MISMATCH: 'token の送信先への、必須の query が違う送信',
  SIDE_REQUEST_OVER_LIMIT: 'ログインに伴う送信の回数の上限を超えた',
  SIDE_REQUEST_NOT_SCRIPT: 'ログインに伴う送信の送信先への、スクリプトでない送信',
  UNREGISTERED_NON_READ: '登録していない、読み取りでない送信',
  // T36R-fix（T36R の M-2）: 資格情報を含む要求の理由は行にしない（数だけ。`LOCAL_UI_LOGIN_STAGE_TEXT.credentialRequestsBlocked`）。
  NON_READ_METHOD: 'ログインの送信先でない、読み取りでない送信',
} as const);

/**
 * ログインの後の SPA の監査の画面の文言（T35d。Task 35 の設計書 3.1、3.4）。認証の設定の画面の、スクリプトの送信のときだけ出す「監査で通す読み取りの
 * 手続きの呼び出し」の一覧と、「サービスの Origin への要求の上限」の欄。
 */
export const LOCAL_UI_SPA_AUDIT_TEXT = deepFreeze({
  setup: {
    auditReads: '監査で通す読み取りの手続きの呼び出し',
    /** 一覧の補足（`maxText`・`perLoadText` は `formatCount`・`formatTimes` の結果）。 */
    auditReadsHint: (maxText: string, perLoadText: string): string =>
      `監査の段で、ページのスクリプトが送る POST のうち、ここに登録した送信先へのものだけを、1 回の読み込みで決まった回数まで通します（${maxText} まで。1 回の読み込みで ${perLoadText} まで）。`,
    auditReadsJudgement:
      '登録するのは、データを読むだけの手続きの呼び出しです。読むだけかどうかは、あなたが判断して登録します。まず空で試し、監査の成果物の安全の記録で止めた要求を見て、要るものだけを登録してください。',
    readOrigin: '呼び出しの Origin',
    readPath: '呼び出しのパス',
    readMaxPerPageLoad: '1 回の読み込みの回数',
    addRead: '呼び出しを足す',
    removeRead: 'この呼び出しを消す',
    noReads: '監査で通す読み取りの手続きの呼び出しはありません。',
    limitsHeading: 'サービスの Origin への要求の上限',
    /**
     * 上限の補足（既定の値。`perMinuteText`・`perRunText`・`perPageText` は `formatCount` の結果）。T44f: 1 回の Run あたりの既定は、`perRunText` か、ページの上限 ×
     * `perPageText`（`SERVICE_REQUESTS_PER_PAGE_ALLOWANCE`）の大きいほう。
     */
    limitsBody: (perMinuteText: string, perRunText: string, perPageText: string): string =>
      `監査の段で、承認したサービスの Origin へ送る要求の数の上限です。空なら、1 分あたり ${perMinuteText}、1 回の Run あたり ${perRunText} か「ページの上限 × ${perPageText}」の大きいほうを使います。書くときは、小さくはできますが、大きくはできません。1 分あたりの上限に届くと、次の画面を読む前に待ってから続けます（ページの途中では止めません）。1 回の Run あたりの上限に届くと、監査を止めます。`,
    perMinute: '1 分あたりの上限',
    /** 欄の補足（`minText`・`maxText` は `formatCount` の結果）。 */
    perMinuteHint: (minText: string, maxText: string): string => `${minText} から ${maxText} まで（空なら ${maxText}）。`,
    perRun: '1 回の Run あたりの上限',
    /** T44f: 空のときの既定は、`maxText` か「ページの上限 × `perPageText`」の大きいほう。 */
    perRunHint: (minText: string, maxText: string, perPageText: string): string =>
      `${minText} から ${maxText} まで（空なら ${maxText} か「ページの上限 × ${perPageText}」の大きいほう）。`,
  },
} as const);

/**
 * 入口の確かめの画面の文言（T43c。Task 43 の設計書 4.3）。プロファイルの詳細と認証の設定の画面の「入口を確かめる」、ジョブの詳細の読んだ事実と案、
 * 認証の設定の画面の案の案内。終わり方と置き方のラベルは表示のカタログ（`ENTRY_CHECK_END_REASON_CATALOG`・`ENTRY_CHECK_FORM_PLACEMENT_CATALOG`）。
 */
export const LOCAL_UI_ENTRY_CHECK_TEXT = deepFreeze({
  panel: {
    heading: '入口の確かめ',
    body: 'ログインしないで開始の URL を 1 回だけ読み、ログインの画面の欄と送り方を調べて、認証の設定の案を作ります。欄の値は読まず、送信や書き込みはしません。読み込みは 1 回だけで、ほかのジョブと同時には動きません。',
    start: '入口を確かめる',
    starting: '始めています…',
    cannotStart: '今は入口を確かめられません。',
    rejectedHeading: '入口の確かめを始められませんでした',
    latestHeading: '最後に成功した入口の確かめ',
    latestJob: 'ジョブを開く',
    latestFinishedAt: '終わった日時',
    noLatest: 'まだ成功した入口の確かめはありません。',
    proposalAvailable: 'この結果の案を、新しい認証の設定の欄に埋めます（保存するまでは案です）。',
    noProposal: 'この結果からは、認証の設定の案を作れませんでした（ログインの画面に見えない、許可 Origin の外へ移った、など）。',
  },
  job: {
    heading: '入口の確かめの結果',
    unavailable: '入口の確かめの結果のファイル（entry-check.json）を読めないため、結果を示せません。',
    endReason: '終わり方',
    landing: '移った先',
    landingInside: '許可 Origin の中',
    landingOutside: '許可 Origin の外（Origin だけを記録）',
    loginPage: 'ログインの画面に見えるか',
    loginPageYes: '見える（見えるパスワードの欄がある）',
    loginPageNo: '見えない（見えるパスワードの欄がない）',
    fieldsHeading: '欄の候補',
    fieldColumn: '欄',
    candidatesColumn: '見える候補の数',
    selectorColumn: '一意な CSS',
    noSelector: '（案なし）',
    fields: { username: 'ユーザー名の欄', password: 'パスワードの欄', submit: '送信の要素' },
    formHeading: 'form',
    placement: '3 つの要素の置き方',
    placementUnknown: '（3 つのどれかの候補がちょうど 1 つでないため、分かりません）',
    method: 'method',
    action: 'action',
    none: 'なし',
    proposalHeading: '認証の設定の案',
    noProposal: '案は作っていません。',
    loginStartUrl: 'ログインの開始の URL',
    sessionLostPathPrefix: 'セッションの切れの path',
    loginTransport: '送り方',
    loginPostEndpoint: 'フォームの送信先',
    selectorsHeading: '自動ログインのセレクタ',
    openAuthSetup: '認証の設定の画面で案を確かめる',
    blockedRequests: 'Guard が止めたページ自身の要求',
    downloadEntryCheckJson: '入口の確かめの結果（entry-check.json）を保存する',
  },
  authSetup: {
    /** 新しい認証の設定に、入口の確かめの案を埋めたことの案内（`finishedAt` は表示の日時）。 */
    proposalNotice: (finishedAt: string): string =>
      `入口の確かめ（${finishedAt}）の案を欄に埋めました。保存するまでは案です。値を確かめ、変えたい欄だけを書き直してから保存してください。`,
    /** 自動ログインのプロファイル（全部の欄が要る）の、送り方の案がスクリプトで送るときの文。 */
    scriptTargetNeeded: '送り方の案は「スクリプトで送る」です。token の送信先は入口の確かめでは分からないので、手動のログインで観察してから入れてください。',
    /**
     * T44h の判断 (2)（測りの記録の N3）: 手動のログインのプロファイルの、送り方の案がスクリプトで送るときの文（送信先は、手動のログインの後の自動の登録が埋める）。
     */
    scriptTargetAutoRegistered: `送り方の案は「スクリプトで送る」です。token の送信先は入口の確かめでは分からないので、空のまま保存してください。手動のログインで一度ログインすると、自動で登録されます（下の「${LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.scriptHeading}」の欄の案内）。`,
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// ChatGPT 用バンドルの読み方の案内（`README.md`。T44i）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ChatGPT 用バンドルの読み方の案内（ZIP の中の `README.md`。日本語の Markdown。T44i。Task 44 の設計書 6 章の 2026-10-22 の行。P2-9）の文言の唯一の置き場所。
 * - Markdown に組むのは `src/report/chatgpt-bundle.ts` だけである。category・severity・区分・Run Status の名前は、表示カタログ（`src/presentation/catalog.ts`）から
 *   組む側が取る（ここには置かない）。
 * - ファイルの名前は、バンドルのファイルの名前の owner（`CHATGPT_BUNDLE_FILE_NAMES` など）から、組む側が Markdown のコードの形にして引数で渡す（このファイルは
 *   `src/report/` を import しない）。
 * - 案内には、URL・`targetId`・`startUrl`・Finding の文を書かない（ID とカタログの文と数だけで組む）。
 */
export const CHATGPT_BUNDLE_GUIDE_TEXT = deepFreeze({
  title: 'BeakSight の監査の結果（ChatGPT 用のバンドル）',
  intro:
    'この ZIP は、BeakSight が Web サイトを監査した結果です。監査の間にページが出した送信をどこまで通したかは、要約の `auditSend` にあります。JSON の値（状態・重大度・category・理由など）は英数字のコードのままで、日本語のラベルは入っていません。Finding の文（`message`）は日本語です。',
  runHeading: 'Run の状態と網羅',
  runId: 'Run の ID',
  /**
   * T44R2 の I-5（設計者の判断 (b)）: ログインの送信の一般の文。今の記録では、認証つきの Run かどうかを正しく見分けられないので、値で分けた行は作らず、条件を付けた
   * 一般の文を、送信の扱いの行の近くに置く。
   */
  loginNote: 'ログインして監査した Run では、BeakSight はログインのための送信もします。',
  /** BN-R1 の M-5: 本体と外した指摘を合わせた全部の件数であることを、名前に書く（本体の件数は「本体の指摘と、外した指摘」の節）。 */
  findingCounts: '指摘の件数（本体と外した指摘を合わせた全部）',
  /** 判定できないページの説明（`summaryName` は `summary.json` の名前）。 */
  incompletePagesNote: (summaryName: string): string =>
    `一部未完了・失敗・スキップのページには、確かめられなかった部分があります。そのページに指摘がないことは、問題がないことを意味しません。値は ${summaryName} の \`runStatus\` と \`coverage\` にあります。`,
  readingOrderHeading: '読む順',
  readingOrderIntro: '次の順に読んでください。',
  /** 読む順の各項目（引数はファイルの名前）。 */
  readingOrder: {
    summary: (name: string): string =>
      `${name}: 要約です。Run の状態、ページの網羅、重大度・区分の別の件数、category の別の件数（\`findingCountsByCategory\`）、Rule の別の件数（\`findingCountsByRule\`）、本体の指摘と外した指摘の件数（\`beaksightBlockRelation\`）があります。重大度・category・Rule の別の件数は、外した指摘も含む全部の件数です。`,
    findingsByRule: (name: string): string =>
      `${name}: Rule ごとの要約です。本体の指摘の要約（\`main\`）と、外した指摘の要約（\`excluded\`）に分けてあります。件数、重大度の別の件数、出たページの数、ビューポートの別の件数、BeakSight の遮断との関係の区分の別の件数（\`byBlockRelation\`）と、例（${REPORT_RULE_DIGEST_EXAMPLE_COUNT} 件まで。ページの違うものが先）があります。全体の傾向は、\`main\` で見てください。`,
    findings: (name: string): string =>
      `${name}: 本体の Finding です。BeakSight が止めた要求と結び付かない、サイト品質の指摘だけです（サイトの欠陥の候補）。Finding ごとに、参照する Evidence の場所と、関係するスクリーンショットのパスがあります。`,
    /** BN-d: 外した指摘のファイル（引数はファイルの名前）。 */
    relatedFindings: (name: string): string =>
      `${name}: 本体から外した Finding です。BeakSight の遮断が原因の指摘、遮断の影響の可能性がある指摘、安全の区分の指摘です。Finding ごとに、BeakSight の遮断との関係（\`beaksightBlockRelation\`。区分 \`relation\`・理由 \`reason\`・結び付いた遮断 \`blocks\`。安全の区分の指摘は \`null\`）があります。安全の区分の指摘には、止めた事象の時点の別の件数（\`safetyBlockPhaseCounts\`。\`CLOSING\` は閉じる途中とページを離れた後）があります。`,
    pages: (name: string): string =>
      `${name}: ページごとの状態と、ビューポートごとの状態です。Finding と Evidence は、ID で参照します。本体の Finding は \`findingIds\`、外した Finding は \`excludedFindingIds\` です。`,
    evidence: (indexName: string, pageJsonName: string): string =>
      `${indexName}・${pageJsonName}・スクリーンショット: 一次の証拠です。Evidence の索引の \`path\` と \`pointer\`（JSON Pointer）で、ZIP の中の ${pageJsonName} の記録をたどれます。`,
  },
  /** `page.json` のパスの中の、ページの ID の置き場所の表記（例: `pages/<pageId>/page.json`）。 */
  pageIdPlaceholder: '<pageId>',
  /** 読む順に入らないファイルの説明。 */
  otherFiles: (manifestName: string, runName: string): string =>
    `${manifestName} は、ZIP の中のファイルの一覧（大きさとハッシュの値）と、入れられなかったファイルです。${runName} は、Run の記録そのものです。`,
  repetitionHeading: '同じ指摘の繰り返し',
  repetitionNote: (findingsName: string, findingsByRuleName: string): string =>
    `${findingsName} には、同じ Rule の指摘が、ページごと・ビューポートごとに繰り返し並びます（どのページにも共通の部分の指摘は、ページの数だけ出ます）。全体の傾向は、${findingsByRuleName} と、下の表で見てください。`,
  /** BN-R1 の M-5: 本体と外した指摘を合わせた全部の件数の表であることを、見出しに書く。 */
  categoryHeading: 'category の別の件数（本体と外した指摘を合わせた全部）',
  categoryColumns: ['category', 'コード', '件数'],
  ruleHeading: 'Rule の別の件数（本体の指摘）',
  ruleIntro: '本体の指摘を、重大度の重い順、件数の多い順に並べています。',
  ruleColumns: ['Rule', '重大度', 'category', '件数', 'ページの数'],
  noRules: '指摘はありません。',
  safetyHeading: '安全の区分の指摘',
  /**
   * 安全の区分の説明（`groupLabel` は、表示カタログの重大度の区分の名前）。T44R2 の M-6: 区分の Finding は、BeakSight の決まりで止めた送信や操作の記録であり、
   * 多くはページが出した送信であることを書く（重大度と区分を混ぜない）。
   */
  safetyNote: (groupLabel: string): string =>
    `重大度の区分が「${groupLabel}」の Finding は、BeakSight が自分の決まりで止めた送信や操作の記録です。多くは、ページが出した送信です。サイトの欠陥ではないので、サイト品質の指摘とは分けて数えています。`,
  /** BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: 本体と外した指摘の節。 */
  blockHeading: '本体の指摘と、外した指摘',
  /** 本体の意味（引数は、本体と外した指摘のファイルの名前）。 */
  bodyNote: (findingsName: string, relatedName: string): string =>
    `${findingsName} の指摘は、BeakSight が止めた要求と結び付かない、サイト品質の指摘だけです（サイトの欠陥の候補）。BeakSight の遮断と結び付く指摘と、安全の区分の指摘は、${relatedName} に理由つきで分けました。`,
  /** 本体の件数の項目の名前。 */
  bodyCount: '本体の指摘',
  /** 外した件数の項目の名前（引数は区分の名前）。 */
  excludedCount: (label: string): string => `外した指摘（${label}）`,
  /** 外した件数の値に、区分の説明を続けた文（引数は書式にかけた件数と、表示カタログの説明）。 */
  excludedCountValue: (count: string, description: string): string => `${count}。${description}`,
  /** page.json の中の、BeakSight の遮断の記録の説明（引数は page.json のパスの表記）。 */
  blockedByClientNote: (pageJsonName: string): string =>
    `${pageJsonName} の network の失敗のうち \`ERR_BLOCKED_BY_CLIENT\` のもの（\`blockedByBeakSight\` が真）と、console の「Failed to load resource」の文のうち \`ERR_BLOCKED_BY_CLIENT\` を含むものは、BeakSight が止めた要求の記録です。サイトの欠陥ではありません。`,
  /** 閉じる途中の遮断の説明。 */
  /** BN-R1 の M-5: 閉じる途中の遮断の扱い（事実に合わせた）。 */
  closingNote:
    '閉じる途中とページを離れた後に BeakSight が止めた要求（時点 `phase` が `CLOSING` の記録と、safety の Evidence の `blockedClosingRequests`）は、測りの後のものです。影響の可能性（`POSSIBLE`）の元には使いません。指摘の対象の要求そのものを閉じる途中に止めた場合（その URL に、読み込みの最中の本当の失敗がないとき）は、遮断が原因（`CAUSED`）の参照に入ります。',
} as const);

/** FM2d: まとめて実行の、各段のジョブの画面で次にできることを確かめる案内（止めた理由の多くに共通）。 */
const STAGE_CHAIN_SEE_STAGE_TEXT = '止まった段のジョブを開き、その画面の「次にできること」を確かめてください。';
/** FM2d: まとめて実行は再開しない旨（止まった監査の段は、監査として再開できる）。 */
const STAGE_CHAIN_NO_RESUME_TEXT = 'まとめて実行そのものは再開しません。止まった監査の段は、開始の画面の「前回の続きから再開する」で監査として続けられます。';

/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の画面の文言。開始の画面の欄（`start`）、ジョブの詳細の連鎖の欄（`detail`）、
 * 止めた理由ごとの次にできること（`stopReasons`。`CHAIN_STOP_REASONS`）。状態と理由のラベルと色は、表示カタログ（`catalog.ts`。FM2R の Minor 3）。
 * 段の種類の名前は、ジョブの種類の表示（`AUDIT_JOB_KIND_CATALOG`）を使う（ここに書かない）。網羅は画面の側の `catalog-coverage.ts` で型で確かめる。
 */
export const LOCAL_UI_STAGE_CHAIN_TEXT = deepFreeze({
  start: {
    heading: 'まとめて実行する',
    guidance: 'ログインを 1 回だけ行い、その後に次の段を続けて行います。段ごとに、ジョブの記録と Run を 1 つずつ作ります。',
    stagesLabel: '行う段（この順）',
    readCheckNote: 'READ の確かめは、定義が 1 件以上あるときだけ行います。定義がなければ行わずに終えます（失敗にはしません）。',
    stopNote: '途中で「やめる」を押すと、今の段を止め、次の段は始めません。',
    resumeNote: STAGE_CHAIN_NO_RESUME_TEXT,
    auditModeNote: '監査の段の始め方は、上の「始め方」の選択のとおりです。',
    submit: 'まとめて実行する',
    submitting: 'まとめて実行を始めています…',
    rejectedHeading: 'まとめて実行を始められませんでした',
    cannotStartHeading: '今はまとめて実行を始められません',
    /** 始められない理由が、上の開始の欄と同じとき（理由の本文とリンクを繰り返さない）。 */
    sameReasonAsAbove: '上の欄と同じ理由で始められません。上の欄の案内に従ってください。',
  },
  detail: {
    heading: 'まとめて実行',
    state: '状態',
    stages: '段',
    stopReason: '止まった理由',
    nextStep: '次にできること',
    thisStage: 'このジョブ',
    openStage: 'ジョブを開く',
    memoryNote: 'この欄は、画面のサーバが動いている間だけ出ます（画面のサーバを起動し直すと消えます。各段のジョブの記録は残ります）。',
    /** FM2R の Minor 1: この画面が止まった段のジョブで、止めた理由がこの画面の終わり方と同じとき（理由と次にできることを繰り返さない）。 */
    stoppedHere: 'まとめて実行は、この段で止まりました。止まった理由と次にできることは、この画面の上の欄にあります。',
    /** FM2R の I-2: 連鎖の全体を止めるボタン（今の段を止め、次の段を始めない）と、止めたときと拒まれたときの文。 */
    stop: 'まとめて実行をやめる',
    stopping: 'やめています…',
    stopHint: '今の段を止め、次の段は始めません。',
    stopRequested: 'まとめて実行をやめる要求を送りました。今の段が止まると、次の段は始めません。',
    stopFailed: 'まとめて実行をやめられませんでした。画面を読み直してください。',
  },
  // FM2R の Minor 3: 連鎖の状態・段の状態・止めた理由のラベルと色は、表示カタログ（`STAGE_CHAIN_STATE_CATALOG` など。`catalog.ts`）。ここは次にできることの文。
  stopReasons: {
    USER_STOPPED: { nextStep: STAGE_CHAIN_NO_RESUME_TEXT },
    SAFETY_VIOLATION: { nextStep: SAFETY_STOP_NEXT_STEP_TEXT },
    SESSION_LOST: { nextStep: `${STAGE_CHAIN_SEE_STAGE_TEXT}ログインの欄の案内に従ってから、もう一度まとめて実行してください。` },
    SITE_UNAVAILABLE: { nextStep: 'サイトが応答するようになったことを確かめてから、もう一度まとめて実行してください。' },
    SERVICE_REQUEST_LIMIT_REACHED: { nextStep: serviceLimitNextStepOf('まとめて実行する') },
    STAGE_FAILED: { nextStep: `${STAGE_CHAIN_SEE_STAGE_TEXT}直してから、もう一度まとめて実行してください。` },
    PROFILE_REVISION_CHANGED: {
      nextStep: 'まとめて実行は、始めた時のプロファイルの改訂に結びます。変更を確かめてから、もう一度まとめて実行してください。',
    },
    NEXT_STAGE_REJECTED: {
      nextStep: '画面のサーバが終わる途中か、管理のロックを失った可能性があります。画面のサーバを確かめてから、もう一度まとめて実行してください。',
    },
  },
} as const);
