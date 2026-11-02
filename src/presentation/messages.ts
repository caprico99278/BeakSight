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
import type { FindingCategory, IncompleteReasonCode, JobSafetyViolationStage } from '../core/contracts.js';
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

/**
 * 画面のたたんだ区画（`apps/local-ui/src/components/AdvancedSettings.tsx`）の見出しの語の 1 か所（PL-3・PL-T。設計書
 * `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）。文の中で区画を指すときも、この語を読む（前は「詳しい設定」）。
 */
export const ADVANCED_SETTINGS_SUMMARY_TEXT = '詳しい内容';
/** 文の中で区画を指すときの形（「詳しい内容」）。 */
const ADVANCED_SETTINGS_REF_TEXT = `「${ADVANCED_SETTINGS_SUMMARY_TEXT}」`;

/** 書式（`src/presentation/format.ts`）が付ける、日本語の単位。 */
export const FORMAT_UNIT_TEXT = deepFreeze({
  /** 秒（例: `1.5秒`、経過時間の `24分10秒`）。 */
  seconds: '秒',
  /** 件数（例: `3件`）。 */
  count: '件',
  /** 回数（例: `284回`。ページの読み込みの回数。サイトへの負荷の制御の設計書 4.5、4.8）。 */
  times: '回',
  /** 経過時間の日（例: `1日`、`2日3時間`。PL-4。自動ログインの回数の決まりの「1日 10回まで」）。 */
  days: '日',
  /** 経過時間の時間（例: `1時間5分`。設計書 4.8）。 */
  hours: '時間',
  /** 経過時間の分（例: `24分10秒`。設計書 4.8）。 */
  minutes: '分',
  /** OP-3: ふだんの画面の日時の月と日（例: `10 月 27 日 15:30`。`formatPlainDateTime`）。 */
  monthOfYear: '月',
  dayOfMonth: '日',
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
  DEADLINE_EXCEEDED: 'ページの情報を集める作業が、時間内に終わりませんでした。',
  EVALUATION_FAILED: 'ページの中で情報を集める作業が、失敗しました。',
  PAGE_CLOSED: '情報を集めている途中で、ページが閉じられました。',
  NAVIGATION_FAILED: 'ページを開けませんでした。',
  DOM_READINESS_FAILED: 'ページの表示の準備ができるのを、待てませんでした。',
  SCROLL_TARGET_UNRESOLVED: 'ページの内容が画面より大きいのに、どこをスクロールすればよいか分かりませんでした。',
  SCROLL_NOT_ADVANCED: 'スクロールを求めても、スクロールの位置が進みませんでした。',
  // T44c（Task 44 の設計書 P1-4）: 理由を詳しくした（次にできることは `INCOMPLETE_REASON_NEXT_STEPS`）。
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED:
    'この画面でいちばん大きくスクロールできるのは、画面の中にある、読み込みの後に動く別のスクロールの枠でした。BeakSight は画面の全体だけをスクロールするので、その枠の中は全部は確かめていません。枠の中の問題を見落としているかもしれません。',
  INNER_SCROLL_SCAN_LIMIT_REACHED: '画面の中の別にスクロールする枠を探す作業が上限に達し、そうした枠がないことを確かめられませんでした。',
  SCROLL_TARGET_UNSTABLE: 'スクロールする場所を切り替えてやり直しても、どこをスクロールすればよいか定まりませんでした。',
  POSITION_NOT_AT_ORIGIN: 'スクロールの後に、ページの先頭へ戻せませんでした。',
  LAYOUT_COMPARISON_LIMIT_REACHED: '画面の部品の重なりの確認が、比べる数の上限に達して止まりました。',
  RESOURCE_LIMIT_REACHED: '画像やファイルの読み込みの記録が、件数の上限に達しました。',
  INVALID_BROWSER_DATA: 'ブラウザから返った値が、正しくありませんでした。',
  // DEF-129。
  PAGE_NAVIGATION_LIMIT_REACHED: '画面自身や画面の中の枠の読み込み直しや移動が、決まった回数を超えたため止めました。その画面は読み切れていません。',
  // DEF-130-fix。
  PAGE_SUBRESOURCE_LIMIT_REACHED: '画面が出す画像やデータの読み込みなどの要求が、1 画面あたりの決まった数を超えたため止めました。その画面は読み切れていません。',
  PREFLIGHT_FAILED: '始める前の確認に、失敗しました。',
  RUN_DIRECTORY_UNAVAILABLE: '点検の結果を置くフォルダを、作れませんでした。',
  SAFETY_INVARIANT_VIOLATION: '安全の決まりに反する動きを、記録しました。',
  SAFETY_LEDGER_TRUNCATED: '安全の記録が上限に達し、一部を記録できませんでした。',
  UNHANDLED_FAILURE: '想定していない失敗が、起きました。',
  MAX_PAGES_REACHED: 'ページ数の上限に達しました。',
  MAX_DEPTH_REACHED: 'リンクの深さの上限に達しました。',
  MAX_RUNTIME_REACHED: '時間の上限に達しました。',
  REQUIRED_ARTIFACT_INVALID: 'できたファイルのうち必ず要るものが、決まった形に合いませんでした。',
  EXECUTION_INCOMPLETE: '点検が、最後まで終わりませんでした。',
  REQUIRED_WORK_SKIPPED: '必要な確認の一部を、行いませんでした。',
  REQUIRED_WORK_BLOCKED: '必要な確認の一部を、安全のために止めました。',
  REQUIRED_WORK_TIMED_OUT: '必要な確認の一部が、時間切れになりました。',
  REQUIRED_WORK_NOT_OBSERVED: '必要な確認の一部で、結果を見届けられませんでした。',
  REQUIRED_WORK_NOT_VERIFIED: '必要な確認の一部で、結果を確かめられませんでした。',
  REQUIRED_WORK_FAILED: '必要な確認の一部が、失敗しました。',
  COLLECTOR_INCOMPLETE: 'ページの情報を集める作業の一部が、終わりませんでした。',
  RULE_EVALUATION_FAILED: 'チェック項目の判定が、失敗しました。',
  PAGE_CRASHED: 'ページを表示するブラウザのプログラムが、止まりました。',
  SAFETY_VIOLATION_ABORT: '安全の決まりに反する動きを見つけたため、それより後の点検を始めませんでした。',
  CHECKPOINT_WRITE_FAILED: '再開のための途中の保存を書けなかったため、それより後の点検を始めませんでした。',
  RUN_INTERRUPTED: '止める指示（Ctrl+C など）を受けたため、それより後の点検を始めませんでした。',
  SITE_UNAVAILABLE: 'サイトが応答しないため、それより後の点検を始めませんでした。',
  AUTH_SESSION_LOST: 'ログインが切れたため、そのページを点検せず、それより後の点検を始めませんでした。',
  // T35a（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限。
  SERVICE_REQUEST_LIMIT_REACHED: 'ログインのときに通ってよい外のサイトへの要求が、上限（1 分あたりか、1 回の点検あたり）に届きました。そのため、その要求を止めたか、それより後の点検を始めませんでした。',
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

/**
 * OP-G2（OP-G の指示書の 7）: 理由の詳しい内容のある所（点検の結果の報告の、末尾の記録の段。段の名前は表示カタログの `REPORT_SECTION_CATALOG.RECORD`）。前はファイルの
 * 名前（`run.json`・`page.json`）を書いていたが、この文は報告の本文と画面に出るので、利用者に分かる所の名前にした（ファイルの名前は記録の段にある）。
 */
const REPORT_RECORD_PLACE_TEXT = '点検の結果の報告の終わりにある「記録」';
/** T44h の判断 (1): BeakSight の不具合と見られる理由の、次にできること。 */
// T44R2 の M-11: 宛先は「BeakSight の開発者」（BeakSight はローカルの道具で、窓口の仕組みはない）。
const REPORT_DEFECT_NEXT_STEP_TEXT =
  `もう一度点検してください。続けて起きるときは、BeakSight の不具合と見られます。${REPORT_RECORD_PLACE_TEXT}の、理由の詳しい内容を添えて、BeakSight の開発者に知らせてください。`;
/** T44h の判断 (1): 安全の違反で止まったときの、レポートの次にできること（画面の文は `SAFETY_STOP_NEXT_STEP_TEXT`）。 */
const SAFETY_STOP_REPORT_NEXT_STEP_TEXT = `${REPORT_RECORD_PLACE_TEXT}の、安全の技術の記録で、違反の中身を確かめてください。原因を直すまで、同じ設定で点検し直さないでください。`;
/** T44h の判断 (1): 確かめきれなかった部分を、人が確かめる手順。 */
const MANUAL_PAGE_CHECK_TEXT = 'そのページをブラウザで開き、確かめきれなかった部分を手で確かめてください';
/** T44h の判断 (1): もう一度監査して、続けて起きるときは手で確かめる手順（`cause` は起きやすい場面）。 */
const retryThenManualOf = (cause: string): string => `${cause}もう一度点検してください。続けて起きるときは、${MANUAL_PAGE_CHECK_TEXT}。`;
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
  'メールや電話などの外のアプリを開かせないブラウザ（Chromium）の設定が、このパソコンで効かなかったこともあります（パソコンの管理の設定が上書きしている場合など）。そのときは、パソコンの管理者に確かめてください。';

/**
 * T44c（Task 44 の設計書 P1-4）: 未完了の理由ごとの、利用者が次にできることの文（理由の説明 `INCOMPLETE_REASON_DESCRIPTIONS` の後に出す）。
 * T44h の判断 (1)（設計書の履歴の「T44h の測りとユーザーの判断」の行）: すべての理由のコード（ページの理由と、Run の閉じた一覧の外の理由）に足した。網羅は型
 * （`satisfies Record<IncompleteReasonCode, string>`）で確かめる。CLI でも作る HTML レポートの文なので、画面の操作の名前は書かない（画面の文は
 * `LOCAL_UI_JOB_NEXT_STEPS.runReasons`。画面は、そこに載せていない理由にこの文を使う）。
 */
export const INCOMPLETE_REASON_NEXT_STEPS = deepFreeze({
  DEADLINE_EXCEEDED: retryThenManualOf('読み込みの遅い画面で起きます。サイトが混んでいない時間に、'),
  EVALUATION_FAILED: retryThenManualOf('画面の中のプログラムが、情報を集めるのを妨げることがあります。'),
  PAGE_CLOSED: retryThenManualOf('画面が自分で閉じる作りのことがあります。'),
  NAVIGATION_FAILED: 'そのページのアドレスをブラウザで開けるか、サイトが応答しているかを確かめてから、もう一度点検してください。',
  // T44R2 の I-7: この理由は、読み込みの落ち着きの待ち（期限は `crawl.resourceSettlingTimeoutMs`）が PARTIAL のときに付く（`page-auditor.ts`）。
  DOM_READINESS_FAILED:
    'サイトが応答しているかを確かめてから、もう一度点検してください。続けて起きるときは、設定のファイルにある、画像やファイルの読み込みが落ち着くのを待つ時間（crawl.resourceSettlingTimeoutMs）を長くしてください。',
  SCROLL_TARGET_UNRESOLVED: 'ページの下の方は、確かめきれていないことがあります。そのページをブラウザで開き、下までスクロールして手で確かめてください。',
  SCROLL_NOT_ADVANCED: 'スクロールを止める作り（スクロールの固定など）の画面で起きます。そのページをブラウザで開き、下までスクロールして手で確かめてください。',
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED:
    'その枠の中に確かめたい内容があれば、ブラウザで画面を開き、その枠をスクロールして手で確かめてください。',
  INNER_SCROLL_SCAN_LIMIT_REACHED: '部品の多い画面で起きます。画面の中に別にスクロールする枠があれば、ブラウザで画面を開き、その枠をスクロールして手で確かめてください。',
  SCROLL_TARGET_UNSTABLE: '読み込みの後に形が変わる画面で起きます。そのページをブラウザで開き、表示が落ち着いてから、スクロールして手で確かめてください。',
  POSITION_NOT_AT_ORIGIN: 'スクロールした後の先頭の表示は、確かめきれていないことがあります。そのページをブラウザで開き、先頭の表示を手で確かめてください。',
  LAYOUT_COMPARISON_LIMIT_REACHED: '部品の多い画面では、重なりの問題の一部を見落としていることがあります。重なりが気になる場所は、ブラウザで画面を開いて手で確かめてください。',
  RESOURCE_LIMIT_REACHED: '読み込みの多い画面では、表示の速さの問題の一部を見落としていることがあります。読み込みの量は、ブラウザの開発者ツールで確かめてください。',
  INVALID_BROWSER_DATA: REPORT_DEFECT_NEXT_STEP_TEXT,
  PAGE_NAVIGATION_LIMIT_REACHED:
    '画面が自分で読み込み直しや移動を繰り返す作りです。そのページをブラウザで開き、表示が落ち着くかを確かめてください。ログインして点検するときは、そのページをログインの設定の「読まないページ」に足すと、次から読みません。',
  PAGE_SUBRESOURCE_LIMIT_REACHED: '画面が多くの画像やデータを読み込む作りです。そのページをブラウザで開き、表示の内容を手で確かめてください。',
  PREFLIGHT_FAILED: `ブラウザ（Chromium）を起動できるか、出力先のフォルダに書けるかを確かめてから、もう一度監査してください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`,
  RUN_DIRECTORY_UNAVAILABLE: outputFolderNextStepOf('もう一度監査してください'),
  SAFETY_INVARIANT_VIOLATION: SAFETY_STOP_REPORT_NEXT_STEP_TEXT,
  SAFETY_LEDGER_TRUNCATED:
    '止めた要求が多すぎる画面があります。安全の記録で止めた要求の多いページを確かめ、範囲を狭めて（ログインして点検するときは「読まないページ」に足すなど）、もう一度点検してください。',
  UNHANDLED_FAILURE: REPORT_DEFECT_NEXT_STEP_TEXT,
  MAX_PAGES_REACHED: '残りのページも監査するには、設定のファイルのページの上限（crawl.maxPages）を上げてから、もう一度監査してください。',
  MAX_DEPTH_REACHED: 'もっと深いページも監査するには、設定のファイルのリンクの深さの上限（crawl.maxDepth）を上げてから、もう一度監査してください。',
  MAX_RUNTIME_REACHED: '残りのページは、続きから再開すると監査します。1 回で長く監査するには、設定のファイルの時間の上限（crawl.maxRuntimeMs）を上げてください。',
  REQUIRED_ARTIFACT_INVALID: `この点検の回でできたファイルの一部は使えません。${REPORT_DEFECT_NEXT_STEP_TEXT}`,
  EXECUTION_INCOMPLETE: '点検を始めなかったページがあります。終わり方の理由（時間の上限、止める指示など）を確かめ、続きから再開するか、もう一度点検してください。',
  REQUIRED_WORK_SKIPPED: `行わなかった確認は、ページの理由の詳しい内容で分かります。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_BLOCKED: `安全のために止めた確認です（BeakSight は送信を伴う操作をしません）。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_TIMED_OUT: retryThenManualOf('読み込みの遅い画面で起きます。サイトが混んでいない時間に、'),
  REQUIRED_WORK_NOT_OBSERVED: `結果が画面に出なかった確認です。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_NOT_VERIFIED: `結果を確かめられなかった確認です。要るときは、${MANUAL_PAGE_CHECK_TEXT}。`,
  REQUIRED_WORK_FAILED: retryThenManualOf(''),
  COLLECTOR_INCOMPLETE: retryThenManualOf('欠けた確認は、理由の詳しい内容（段階と理由）で分かります。'),
  RULE_EVALUATION_FAILED: REPORT_DEFECT_NEXT_STEP_TEXT,
  PAGE_CRASHED: retryThenManualOf('画面が重いか、記憶域が足りないことがあります。ほかのプログラムを閉じてから、'),
  SAFETY_VIOLATION_ABORT: SAFETY_STOP_REPORT_NEXT_STEP_TEXT,
  CHECKPOINT_WRITE_FAILED: outputFolderNextStepOf('続きから再開してください'),
  RUN_INTERRUPTED: '残りのページは、続きから再開すると監査します。',
  SITE_UNAVAILABLE: 'サイトが応答するようになったことを確かめてから、続きから再開してください。',
  AUTH_SESSION_LOST:
    'ログインの状態が切れたページのパスを、認証の設定の「読まないパス」に足すと、次から読みません。残りのページは、続きから再開すると監査します。',
  SERVICE_REQUEST_LIMIT_REACHED: 'ログインの設定にある、ログインのときに通ってよい外のサイトへの要求の上限を見直してから、続きから再開してください。',
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
  // OP-G2（OP-G の指示書の 7）: 報告の本文に出るので、技術の語（Origin・scheme）を使わない（コードは記録の段）。
  EXTERNAL_ACTION: 'ほかのサイトや、電話・メールなどのアプリへ移る部品なので、押しませんでした。',
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

/** HTML の部品（`src/report/html-components.ts`）が示す、日本語の文言（PL-R: 報告だけの文言。画面と同じやさしい言葉。設計書 5 章）。 */
export const REPORT_COMPONENT_TEXT = deepFreeze({
  /** Finding の表の列の見出し（`renderFindingRow` のセルの順）。 */
  findingColumns: ['重さ', '種類', '内容', 'ページ', '画面の幅', '規則', '証拠', '画面の写真'],
  /** OP-3: 報告の本文の、やさしい語の Finding の表の列の見出し（規則と証拠は、末尾の記録の段）。 */
  plainFindingColumns: ['重さ', '種類', '内容', 'ページ', '画面の幅', '画面の写真'],
  /** 該当するものがない。 */
  none: 'なし',
  /** ページによらない Finding（例: ページ間の Finding）のページの欄。 */
  pageIndependent: 'ページによらない',
  /** ビューポートによらない Finding のビューポートの欄。 */
  viewportIndependent: '画面の幅によらない',
  /** Finding の行のページの欄の、ページの一覧（文書の中のアンカー）へのリンク（U16c）。 */
  pageDetailLink: 'ページごとの結果で見る',
  /**
   * OP-G2（OP-G の指示書の 7。OP-3 の続き）: 報告の本文の、やさしい語の Finding の行の「種類」の欄で、表示カタログの名前（`FINDING_CATEGORY_CATALOG` の `label`）が
   * 技術の語の種類だけの、やさしい名前（ここにない種類は、表示カタログの名前のまま）。表示カタログの名前は、記録の段・CLI・ChatGPT 用のファイルのまま。
   */
  plainCategoryLabels: {
    HTTP: 'ページの返事',
    DOM: 'ページの作り',
  } satisfies Partial<Record<FindingCategory, string>>,
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
 * PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、5 章）: 報告だけの文言なので、画面と同じやさしい言葉にした（監査 → 点検、Run → 点検の回、
 * 指摘 → 問題、ビューポート → 画面の幅、Evidence → 証拠 など）。CLI と ChatGPT 用のファイルと共有する文言（`RUN_SUMMARY_TEXT`・`AUDIT_SEND_TEXT` など）は、
 * ChatGPT 用のファイルの中身を変えないため、ここでは変えない。
 */
export const HTML_REPORT_TEXT = deepFreeze({
  /** 文書の題（`<title>` と `<h1>`）。 */
  title: 'BeakSight 点検の結果',
  /** 指摘のない節の文。 */
  noFindings: 'この種類の問題は、見つかりませんでした。',
  /** 節の中の、指摘の件数の項目。 */
  findingCount: '問題の数',
  /** 未完了の理由の表の列の見出し。 */
  reasonColumns: ['記号', '説明', 'くわしい記録'],
  /** T44c: 未完了の理由の説明の後に出す、次にできること（`INCOMPLETE_REASON_NEXT_STEPS` の文）。 */
  reasonNextStep: (text: string): string => `次にできること: ${text}`,
  /**
   * PL-R: 冒頭の「まとめ」の段（表示用モデルの `overview` と `summary` を描くだけ）。何を見たか、問題の数（重さごと）、大事な 3 つ、見なかったもの。
   */
  overview: {
    /**
     * OP-H（撮影 UI-W4 の 3）: チェックした画面がある点検の、監査の段の報告のまとめの 1 行（この後の書き込みの段で登録・更新する。監査の段の「読み取りだけ」は、
     * 監査の段の事実のまま残す）。
     */
    plannedWrites: 'この点検では、この後に、チェックした画面でテスト用のデータを登録・更新します。結果はサイトの画面に出ます。',
    scopeHeading: '何を見たか',
    site: '点検したサイト（はじめのページ）',
    result: '点検の結果',
    discoveredPages: '見つけたページ',
    checkedPages: '開いて見たページ',
    countsHeading: '見つかった問題の数',
    /** 問題（サイト品質の指摘。安全は分けて数える）の数の文。 */
    problemsFound: (countText: string): string => `問題が ${countText}見つかりました。`,
    noProblems: '問題は見つかりませんでした。',
    countsNote: '重さごとの数です。「安全」は、サイトのデータを変えないように止めた送信などの記録で、問題の数には入れません。',
    topHeading: '大事な問題（重い順に 3 つまで）',
    /** 大事な問題の 1 件の、出た回数とページの数。 */
    problemTimes: (countText: string, pagesText: string): string => `（${countText}、${pagesText} ページ）`,
    /** ページによらない問題（いくつかのページを比べた問題など。ページの数が 0）の、出た回数だけ。 */
    problemTimesWithoutPages: (countText: string): string => `（${countText}）`,
    /** 大事な問題から、種類ごとの問題の表の行へのリンク。 */
    problemLink: 'くわしく見る',
    notCheckedHeading: '見られなかったところ',
    notFullyCheckedPages: (pagesText: string): string => `最後まで見られなかったページが ${pagesText} ページあります。`,
    runReasonsCaption: '点検の全体で見られなかった理由',
    pageReasonsCaption: 'ページで見られなかった理由',
    /** ページの理由の 1 行（説明と、その理由のあったページの数）。 */
    pageReason: (description: string, pagesText: string): string => `${description}（${pagesText} ページ）`,
    nothingLeft: '見られなかったところは、ありません。',
  },
  /** 記録の段（前の要約の節）の、HTML レポートだけで使う文言（CLI と共通の文言は `RUN_SUMMARY_TEXT`）。 */
  summary: {
    runHeading: '点検の回',
    runId: '点検の回の ID',
    allowedOrigins: '点検してよいサイトのアドレス（許可 Origin）',
    startedAt: STARTED_AT_LABEL,
    finishedAt: FINISHED_AT_LABEL,
    countsHeading: '問題の数（くわしく）',
    countsNote: 'サイトの問題（エラー、警告、情報）と安全は、分けて数えます。',
    countColumns: ['区分', '重さ', '数'],
    totalFindings: '問題と記録の合計',
    safetyInvariantViolations: '安全の決まりに反したこと',
    /** BN-d: BeakSight の遮断と指摘の関係の件数の説明と、バンドルの本体の指摘の件数の項目（区分の名前は `BEAKSIGHT_BLOCK_RELATION_CATALOG`）。 */
    blockRelationNote:
      'サイトの問題を、BeakSight が止めた要求との関係で分けて数えます。「遮断が原因」と「遮断の影響の可能性」の問題と安全の記録は、ChatGPT 用のファイルの本体（findings.json）から外し、別のファイルに理由つきで残します。',
    blockRelationCount: (label: string): string => `サイトの問題のうち「${label}」`,
    bundleMainFindings: 'ChatGPT 用のファイルの本体の問題',
    limitsHeading: '上限',
    limitColumns: ['上限', '設定', '届いたか'],
    limits: {
      maxPages: 'ページの数',
      maxDepth: 'リンクをたどる深さ',
      maxRuntime: '点検の時間',
    },
    reached: '届いた',
    notReached: '届いていない',
    unverifiedInteractions: '確かめられなかった、押す操作',
    unverifiedInternalLinks: '確かめられなかった、サイトの中のリンク',
    /** 「サイトへの負荷」の小節（見出しは `RUN_SUMMARY_TEXT.loadHeading`）の説明。 */
    loadNote: 'BeakSight が点検したサイトに送った要求の記録です。ページの読み込みは、いちばん短い間隔より長く空けて行いました。',
    /**
     * 「サイトへの負荷」の小節の項目（`RunSummary.load` の順。許可 Origin への要求は、CLI と共通の `RUN_SUMMARY_TEXT.allowedOriginRequests`）。
     * ページの読み込みの回数は、間隔の判定に使った読み込みの開始の回数で、始められなかった読み込みを含む（多めに数える側。設計書 4.5）。
     */
    load: {
      minNavigationInterval: 'ページの読み込みの、いちばん短い間隔',
      maxInteractionsPerPage: '1 ページで押して確かめる操作の上限',
      navigationCount: 'ページの読み込みの回数（始められなかったものを含む）',
      pacingWait: '間隔を空けるために待った時間の合計',
      otherOriginRequests: '点検してよいサイトの外への要求',
      servedFromCache: '点検の回の全体で、取っておいた写しから返した要求',
      withheldOtherOrigins: '送らなかった、点検してよいサイトの外への要求',
    },
    /** 「実行の記録」の小節（`RunSummary.executions`。中断した Run の再開の設計書 4.8 の「表示」。R6）の見出し。 */
    executionsHeading: '起動の記録',
    /** 「実行の記録」の小節の説明。 */
    executionsNote:
      'BeakSight を起動した回ごとの、始めと終わりの日時と、終わり方です。途中で止まった点検の回を、続きから点検した起動を、再開として数えます。',
    /** 「実行の記録」の小節の項目（実行の回数と、再開の回数）。 */
    executions: {
      count: '起動の回数',
      resumeCount: '再開の回数',
    },
    /**
     * 実行の一覧の表の列の見出し（何回目、開始の日時、終了の日時、終わり方）。終わり方の欄は、表示カタログのラベル、コード、説明を示す。
     * 開始と終了の日時の列は、Run の開始と終了の日時と同じ名前にする。
     */
    executionColumns: ['何回目の起動', STARTED_AT_LABEL, FINISHED_AT_LABEL, '終わり方'],
    /** 「実行の環境」の小節。Playwright の版の項目は、CLI と共通の `RUN_SUMMARY_TEXT.playwrightVersion`。 */
    environmentHeading: '動かした環境',
    environment: {
      nodeVersion: 'Node.js',
      platform: 'OS',
      osRelease: 'OS の版',
      arch: 'CPU の種類',
      chromiumVersion: 'Chromium',
    },
  },
  interactions: {
    countsHeading: '結果ごとの数',
    notVerifiableHeading: '確かめられなかったものの、わけごとの数',
    listHeading: '押す候補ごとの結果',
    /** 候補ごとの結果の表の列の見出し。理由の欄は、コード、日本語の説明、詳細を示す（C18o）。 */
    columns: ['ページ', '画面の幅', '押したもの', '結果', '確かめられなかったわけ', '理由', '証拠'],
    /** OP-3: 本文の、候補ごとの結果の表の列の見出し（理由はやさしい説明だけ。コード・詳細・証拠は記録の段）。 */
    plainColumns: ['ページ', '画面の幅', '押したもの', '結果', '確かめられなかったわけ', 'くわしいわけ'],
    /** OP-3: 本文の「押したもの」で、名前のない部品（要素の名前と役割は記録の段）。 */
    unnamedTarget: '名前のない部品',
    noInteractions: '押す候補の記録はありません。',
  },
  safety: {
    guard: '送信を止める守り',
    guardEnabled: '使った',
    guardDisabled: '使わなかった',
    blockedActionsHeading: '止めた動き',
    blockedActions: {
      requests: '要求',
      navigations: 'ページの移動',
      externalActions: '外への動きのある操作',
      popups: '別の窓（ポップアップ）',
      downloads: 'ダウンロード',
      webSockets: '常時の接続',
    },
    excludedInteractionCandidates: '安全のため外した、押す候補',
    invariantViolationCount: '安全の決まりに反したこと',
    record: '安全の記録',
    recordComplete: 'すべて記録した',
    recordTruncated: '上限に届き、一部を記録できなかった',
    lowerBoundNote: '安全の記録が上限に届いたので、止めた動きの数は少なめです。本当の数は、これより多いことがあります。',
    methodsCaption: '送り方（メソッド）ごとの、止めた要求',
    methodColumns: ['送り方（メソッド）', '数'],
    violationsCaption: '安全の決まりに反したことの一覧',
    violationColumns: ['記号', '内容（技術のくわしい記録）'],
    /** 事象の一覧の小見出し（C16d。設計書 6.1.10）。遮断した事象と、記録だけの事象（外部スキームへの移動の試み。C18a）の両方を含む。 */
    eventsHeading: '安全のために止めたことの一覧',
    /** 事象の一覧の説明。 */
    eventsNote: 'ページの安全の記録（証拠）にあることを、ページ、証拠、種類の順に並べたものです。',
    /** 安全の記録が上限に達したときの、事象の一覧の注意。 */
    eventsTruncatedNote: '安全の記録が上限に届いたので、この一覧には、記録できなかったものが入っていません。',
    /** 事象の表の列の見出し（「候補」は Interaction の候補の ID。C16e）。 */
    eventColumns: ['種類', 'ページ', '画面の幅', '送り方（メソッド）', 'アドレス（URL）', '押す候補', '理由', '証拠'],
  },
  pages: {
    url: 'ページのアドレス',
    status: '状態',
    pageJson: 'ページの記録（page.json）',
    visibleText: '見えている文字',
    reasons: '見られなかった理由',
    viewportsHeading: '画面の幅ごとの状態',
    viewportColumns: ['画面の幅', '状態', '開いたアドレス', '最後に着いたアドレス', '返事の番号（HTTP）', '開いた結果', '見られなかった理由'],
    screenshotsHeading: '画面の写真',
    findingsHeading: 'このページの問題',
    retriesHeading: 'やり直す前の記録',
    retriesNote: '最後に開き直す前に行った試しの記録です。問題の数と、問題の参照には入れません。',
    retryColumns: ['試し', '開いた結果', 'くわしい記録', '証拠', '画面の写真'],
    noPages: 'ページの記録はありません。',
    /** OP-3: 本文のページの見出し（`numberText` は何番目かの `formatInteger`。ページの番号は記録の段）。 */
    heading: (numberText: string): string => `${numberText} ページ目`,
    /** OP-3: 本文の、画面の幅ごとの状態の表の列の見出し（返事の番号と開いた結果のコードは記録の段）。 */
    plainViewportColumns: ['画面の幅', '状態', '開いたアドレス', '最後に着いたアドレス', '見られなかった理由'],
  },
  /**
   * OP-3（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、`2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 末尾の記録の段に移した、
   * 本文の技術の記録（問題の規則と証拠、押して確かめた操作の理由のコードと証拠、安全の送り方と事象、ページの番号とファイルと返事の番号）。
   */
  record: {
    findingsHeading: '問題の技術の記録',
    // OP-R2: 本文はやさしい文なので、規則の文（Rule の `message`）は、ここに出す。
    findingsNote: '種類ごとの問題の、番号、規則と版、規則の文、証拠、画面の写真の記録です。',
    findingColumns: ['問題の番号', '規則', '規則の文', '証拠', '画面の写真'],
    interactionsHeading: '押して確かめた操作の技術の記録',
    interactionColumns: ['ページ', '押したもの', '理由', '証拠'],
    safetyHeading: '安全の技術の記録',
    pagesHeading: 'ページの技術の記録',
    pageColumns: ['ページ', 'ページの番号', 'ページの記録（page.json）', '見えている文字', '見られなかった理由（記号）'],
    viewportColumns: ['ページの番号', '画面の幅', '返事の番号（HTTP）', '開いた結果', '見られなかった理由（記号）'],
    /** ページのやり直す前の記録の表の題（`pageId` はページの番号）。 */
    retriesCaption: (pageId: string): string => `${pageId} のやり直す前の記録`,
  },
  /**
   * OP-3: 本文の送信の扱いの、やさしい説明（送り方の名前を書かない。送り方を書いた表示カタログの説明は、記録の段と ChatGPT 用のファイルのまま）。鍵は送信の扱いの一覧
   * （`AUDIT_SEND_POLICIES`）と同じ（網羅は `html-report.ts` の型）。
   */
  plainAuditSend: {
    READ_ONLY: 'ページが出す書き込みの送信は、すべて止めました。',
    PASS_EXCEPT_DELETE: 'ページが出す書き込みの送信のうち、削除と危険な語の送信のほかを、サイトに届けました。',
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
      '同じ名前の Run のディレクトリが、すでにあります。別の Run の結果を上書きしないよう、監査を始めずに終えました。少し待ってから、もう一度実行してください。',
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
  passedNotice: (countText: string): string => `この点検では、ページが出す送信のうち削除のほかを通した（${countText}）`,
  /** AS-c: 通した数の内訳（ほかの Origin への送信の数と、WebSocket の接続の数。`formatCount` の結果）。 */
  passedDetail: (otherOriginCountText: string, webSocketCountText: string): string =>
    `うち、ほかのサイトへの送信 ${otherOriginCountText}。ほかに、つないだままやりとりする接続 ${webSocketCountText}`,
  passedOtherOrigins: 'ほかのサイトへ通した送信',
  passedWebSockets: '通した WebSocket の接続',
  /**
   * AS-c fix round 1（C-1・C-2）: Guard の判定を通らずに開いた WebSocket の接続（ページのスクリプトが模擬を迂回した接続、Worker の中の接続）と、危険な語の
   * 接続の知らせ（`formatCount` の結果）。止められない接続で、ブラウザが開いた事実から数えた。
   */
  webSocketCaution: (outsideGuardCountText: string, dangerousCountText: string): string =>
    `つないだままやりとりする接続のうち、BeakSight の見張りを通らずに開いたもの ${outsideGuardCountText}、危険な語を含むもの ${dangerousCountText}（止められない接続です。ブラウザが開いた接続から数えました）`,
  passedWebSocketsOutsideGuard: 'Guard の判定を通らずに開いた WebSocket の接続',
  passedDangerousWebSockets: '危険な語を含む WebSocket の接続',
  jobNotice: 'この作業では、ページが出す送信のうち、削除のほかを通しました。削除と、危険な語を含む送信は止めました。',
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
  `ログインのときに通ってよい外のサイトへの要求が、1 分あたりの上限に届いたため、次の読み込みの前に ${waitText}待ちます（${String(waitCount)} 回目。合計 ${totalText}）。`;

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
 * MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 3）: 自動ログインのプロファイルで、資格情報の送信先を変える保存を拒んだ
 * ときの説明と手順（理由 `CREDENTIAL_DESTINATION_LOCKED`。プロファイルの保存の部品・認証の設定の保存の部品・表の行の「登録する」の 3 つのカタログが同じ文を使う）。
 */
const CREDENTIAL_DESTINATION_LOCKED_TEXT = deepFreeze({
  description: '自動ログインにしたサイトでは、ログインの送信先を変えられません。保存していません。',
  action: `変えるときは、${ADVANCED_SETTINGS_REF_TEXT}でログインのしかたを「手でログインする」に戻してください。次の点検で手でもう一度ログインすると、BeakSight が送信先を記録して、自動でログインするように切り替えます。`,
} as const satisfies ControlReasonText);

/**
 * MI-F1（設計書 4.7.1 の 1・2）: プロファイルの作成・編集と、認証の設定の画面の下書きからの保存で、画面のサーバが拒む理由ごとの説明と手順。理由の一覧は
 * `src/control/auth/credential-destination.ts` の `PROFILE_SAVE_GUARD_REJECTIONS` が持ち、書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS = deepFreeze({
  SERVICE_ORIGIN_ADD_NOT_OBSERVED: {
    description: 'ログインのときに通ってよい外のサイトのアドレスは、ここでは足せません。保存していません。',
    action: 'このアドレスは、手で 1 回ログインすると、BeakSight がログインの送信先を見て自動で入れます。入ったアドレスを消すことはできます。',
  },
  AUTOMATED_LOGIN_SWITCH_REQUIRED: {
    description: 'サイトを足すときや設定を変えるときは、ログインのしかたを自動ログインにできません。保存していません。',
    action: '「手でログインする」のまま保存してください。1 回目の点検で手でログインすると、BeakSight が自動でログインするように切り替えます。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * プロファイルの保存の部品が変更を拒む理由ごとの説明と手順（画面の表示で使う。T23f）。理由の一覧は
 * `src/control/store/profile-store.ts` の `PROFILE_STORE_REJECTION_REASONS` が持ち、書き漏れと余分は `src/control/setup-local.ts` で型で確かめる。
 */
export const PROFILE_STORE_REJECTION_DESCRIPTIONS = deepFreeze({
  PROFILE_INVALID: {
    description: 'サイトの設定の内容に、誤りがあります。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'このサイトの設定のファイルを読めないか、その内容に誤りがあります。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度保存してください。',
  },
  PROFILE_REVISION_NOT_INITIAL: {
    description: '新しく足すサイトなのに、変更の回数が最初の値になっていません。',
    action: '新しく足すサイトは、変更の回数を最初の値にして保存してください。',
  },
  PROFILE_ALREADY_EXISTS: {
    description: '同じ名前のサイトが、もうあります（取り消したものも含みます）。',
    action: '別の名前にするか、もうあるサイトの設定を変えてください。',
  },
  PROFILE_NOT_FOUND: {
    description: 'そのサイトが見つかりません。',
    action: '一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したサイトは、変更も取り消しもできません。',
    action: '使い続けるときは、新しい名前でサイトを足し直してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: '別の変更が先に保存されたため、この変更を保存しませんでした。',
    action: '一覧を読み込み直して、今の内容を確かめてから、もう一度変更してください。',
  },
  PROFILE_REVISION_NOT_ADVANCED: {
    description: '変更の回数が、保存されている回数より進んでいません。',
    action: '一覧を読み込み直して、今の内容を確かめてから、もう一度変更してください。',
  },
  STORED_PROFILE_INVALID: {
    description: '保存されているサイトの設定が壊れているか、今の決まりに合いません。変更はしていません。',
    action: '表示された誤りを開発者に伝えてください。BeakSight は、保存されている内容を消したり変えたりしていません。',
  },
  // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルの、設定のファイル・テスト環境の Origin・承認したサービスの Origin を変える保存。
  CREDENTIAL_DESTINATION_LOCKED: CREDENTIAL_DESTINATION_LOCKED_TEXT,
} as const satisfies Record<string, ControlReasonText>);

/**
 * T43b（Task 43 の設計書 4.2）: プロファイルの作成で、開始の URL と許可 Origin の欄の誤り（欄に出す）。一覧は `src/config/target-config-draft.ts` の
 * `TARGET_SITE_PROBLEMS` が持ち、書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_SITE_PROBLEM_DESCRIPTIONS = deepFreeze({
  START_URL_REQUIRED: '開始のアドレスを入力してください。',
  START_URL_INVALID: '開始のアドレスは、http:// か https:// で始まるアドレスにしてください（例: https://example.test/）。',
  START_URL_TOO_LONG: '開始のアドレスが長すぎます。短いアドレスにしてください。',
  START_URL_HAS_CREDENTIALS: '開始のアドレスに、ユーザー名やパスワード（@ の前の部分）を含めないでください。',
  START_URL_HAS_FRAGMENT: '開始のアドレスに、# から後ろの部分を含めないでください。',
  ALLOWED_ORIGINS_REQUIRED: '点検してよいサイトのアドレスを 1 つ以上入力してください。',
  ALLOWED_ORIGIN_INVALID: '点検してよいサイトのアドレスは、1 行に 1 つ、https://example.test のような形で書いてください。最後の / や、その後ろの部分は付けないでください。',
  ALLOWED_ORIGINS_TOO_MANY: '点検してよいサイトのアドレスが多すぎます。数を減らしてください。',
  ALLOWED_ORIGINS_MISSING_START: '点検してよいサイトのアドレスに、開始のアドレスの頭の部分（https://〜 のサイトのアドレス）を入れてください。',
} as const);

/**
 * T43b（Task 43 の設計書 4.2）: 開始の URL から対象の設定のファイルを作れなかった理由ごとの説明と手順（フォームの上に出す）。一覧は
 * `src/config/target-config-draft.ts` の `TARGET_CONFIG_CREATION_FAILURES` が持ち、書き漏れと余分は画面の `display/catalog-coverage.ts` で型で確かめる。
 */
export const TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS = deepFreeze({
  TARGET_SITE_INVALID: {
    description: '開始のアドレスか、点検してよいサイトのアドレスに、誤りがあります。設定のファイルは作っていません。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  TARGET_CONFIG_INVALID: {
    description: '開始のアドレスと、点検してよいサイトのアドレスから作った設定が、設定の決まりに合いません。設定のファイルは作っていません。',
    action: '開始のアドレスと、点検してよいサイトのアドレスを確かめてから、もう一度保存してください。',
  },
  // T43R-fix-D（M-6）: Windows の予約名の名前と、置き場所がリンク（junction・symlink）であること。
  TARGET_CONFIG_NAME_RESERVED: {
    description: 'この名前（con、nul、aux、prn、com1〜com9、lpt1〜lpt9 など）は、Windows ではファイルの名前に使えません。設定のファイルを作らず、サイトも登録していません。',
    action: '別の名前にしてから、もう一度保存してください。',
  },
  TARGET_CONFIG_EXISTS: {
    description: '同じ名前の設定のファイル（local/targets/ の中の、名前と同じ .json）が、もうあります。上書きはしていません。サイトも登録していません。',
    action: '別の名前にするか、「すでにある設定のファイルを使う」を選んで、そのファイルを選んでください。',
  },
  TARGET_CONFIG_LOCATION_UNSAFE: {
    description: '設定のファイルを置くフォルダ（local か local/targets）が、ほかの場所へのリンク（junction・シンボリックリンク）か、フォルダではありません。何も書かずに止めました。サイトも登録していません。',
    action: 'local と local/targets を、リンクでない普通のフォルダにしてから、もう一度保存してください。',
  },
  TARGET_CONFIG_WRITE_FAILED: {
    description: '設定のファイルを書けませんでした。サイトは登録していません。',
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
    description: 'そのサイトが見つかりません。設定のファイルは変えていません。',
    action: 'サイトの一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したサイトの設定のファイルは、画面からは変えられません。',
    action: '使い続けるときは、新しい名前でサイトを足し直してください。',
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
    description: '値が今と同じです。設定のファイルは変えていません。書くと、書き込みの手順に出した書き込みの OK が外れるため、同じ値では書きません。',
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
  heading: '点検の負荷',
  body: 'このサイトの設定のファイルにある、ページの上限・時間の上限・ページの読み込みの間隔です。変えると、設定のファイルを更新します（サイトの変更の回数は進みません）。',
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
    title: '点検の負荷を変えますか',
    body: '設定のファイルの値を、次のとおりに変えます。',
    item: '項目',
    before: '変える前',
    after: '変えた後',
    confirm: '設定のファイルを更新する',
    cancel: '変えずに戻る',
  },
  /** 書き込みのモードで、今承認が有効なシナリオがあるとき（`countText` は `formatCount` の結果）。 */
  approvalNotice: (countText: string): string =>
    `書き込みの OK を出した書き込みの手順（${countText}）の OK が外れます。OK は設定のファイルの内容に結びついているため、書き込みを始める前に、もう一度書き込みの OK を出してください。`,
  /**
   * 途中の Run は再開されない旨（いつも出す。途中の Run を探す部品は、画面のコードが読み込めない範囲にあるため、あるかどうかは示さない）。
   */
  resumeNotice:
    '途中で止まった点検があれば、設定が変わるため、続きからは再開されません。次に点検を始めると、続きからでなく、新しい点検の回として始めます。',
  saved: '点検の負荷を変えました。',
  rejectedHeading: '点検の負荷を変えられませんでした',
  requestFailed:
    '画面のサーバとのやりとりで誤りが起きたため、確かめられませんでした（通信の誤りか、入れた値の確かめでの誤り）。画面のサーバが動いているかを、起動したコンソールで確かめてから、もう一度押してください。',
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
  UNAUTHORIZED: 'この画面を開くには、画面のサーバを起動したときにコンソールに表示されたアドレスを開いてください。',
  MISDIRECTED_REQUEST: 'このアドレスでは開けません。コンソールに表示された、http://127.0.0.1 で始まるアドレスを使ってください。',
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
    `待ち受けのアドレスに ${host} が指定されました。管理画面は 127.0.0.1 だけで待ち受けます（ほかのパソコンから開けないようにするため）。`,
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
    `画面のサーバは、すでに動いています（プロセスの ID ${processId}${portText}）。画面のサーバは、同時に 1 つだけ動かせます（点検を同時に 1 つだけにするため）。`,
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
  PROFILE_SCHEMA_INVALID: 'サイトの設定の形が正しくありません。',
  PROFILE_ID_INVALID: '名前は、小文字の英字・数字とハイフン（-）で書き、英字か数字から始め、63 文字までにしてください。',
  PROFILE_TARGET_PATH_INVALID: '設定のファイルは、config/targets/ か local/targets/ の中の .json を選んでください。',
  PROFILE_MODE_ENVIRONMENT_MISMATCH: 'この点検のしかたは、このサイトの種類では選べません。テスト用のサイトでの点検は、テスト用のサイトだけで選べます。',
  PROFILE_AUTH_MISMATCH: 'この点検のしかたでは、このログインのしかたは選べません。公開の画面の点検ではログインせず、テスト用のサイトでの点検ではログインします。',
  PROFILE_TEST_ORIGINS_REQUIRED: 'この点検のしかたでは、テスト用のサイトのアドレスを 1 つ以上書いてください。',
  PROFILE_TEST_ORIGIN_INVALID: 'テスト用のサイトのアドレスの形が正しくありません（https://… か、このパソコンの http://…）。',
  PROFILE_TEST_ORIGIN_OUTSIDE_TARGET: 'テスト用のサイトのアドレスが、点検してよいサイトのアドレスに入っていません。',
  PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED: 'この点検のしかたでは、テスト用のサイトであることを確かめた記録の参照を書いてください。',
  PROFILE_REVISION_NOT_ADVANCED: '変更の回数が、保存されている回数より進んでいません。',
  // T34a（Task 34 の設計書 3.1）: 承認したサービスの Origin。
  // MI-F4（MI-R の文言の指摘）: 承認したサービスの Origin は画面から書かない（手動のログインの観察だけが入れる）ので、書き方の案内をやめ、外し方を示す。
  PROFILE_SERVICE_ORIGIN_INVALID:
    'ログインのときに通ってよい外のサイトのアドレスの形が正しくありません（https://… か、このパソコンの http://…）。このアドレスは、手でログインしたときに BeakSight が見て入れるものです。テスト用のサイトとして点検するサイトだけが持てます。要らないアドレスは「消す」で外してください。',
  // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.9）: 承認したサービスの Origin は画面から足さない（手動のログインの観察だけが足す）ので、
  // 書き方の案内をやめ、何が入らないかと、どこから入るかを示す。
  PROFILE_SERVICE_ORIGIN_INSIDE_TARGET:
    '点検する管理画面のサイトのアドレス（点検してよいサイトのアドレス）は、ログインのときに通ってよい外のサイトのアドレスには入れません。手でログインすると、ログインの先のサイトのアドレスが自動で入ります。',
  // PL-F 修正の 1 回目（PL-REV の Minor 2）: 確かめた記録の参照が秘密に見える。
  ISOLATION_REFERENCE_SECRET_LIKE: 'パスワードなどの秘密に見える文字は入れられません。確かめた記録の名前だけを入れてください。',
} as const);

/** ローカルの管理画面の文言（設計書 4.7）。 */
export const LOCAL_UI_TEXT = deepFreeze({
  appName: 'BeakSight',
  appTagline: '点検の管理（このパソコンだけ）',
  skipToContent: '本文へ移動',
  navigationLabel: '画面の一覧',
  listeningBadge: 'このパソコンからだけ開けます',
  backToList: '一覧に戻る',
  reload: '読み込み直す',
  // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: たたんだ区画の部品（`components/AdvancedSettings.tsx`）の見出し。PL-3（設計書
  // `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 直すための欄と、調べるための情報の両方を入れるので「詳しい内容」（前は「詳しい設定」）。
  advancedSettings: {
    summary: '詳しい内容',
  },
  pages: {
    profiles: '点検するサイト',
    newProfile: 'サイトを足す',
    editProfile: 'サイトの設定',
    environment: '環境の状態',
  },
  notFound: {
    title: 'ページが見つかりません',
    body: 'このアドレスの画面はありません。左のメニューから画面を選んでください。',
  },
  error: {
    title: '画面を表示できませんでした',
    body: '読み込み直しても直らない場合は、画面のサーバを起動したウィンドウの表示を確かめてください。',
  },
  profileList: {
    caption: '登録したサイト',
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 12）: 一覧の要点の 1 行（何をする道具か）。主のボタン「サイトを足す」は、この直下。
    intro: 'BeakSight は、テスト用のサイトや公開の画面を見て回り、困りごとがないかを点検します。',
    empty: 'まだサイトがありません。「サイトを足す」を押して、点検したいページのアドレスを入れます。',
    newProfile: 'サイトを足す',
    columns: {
      profileId: '名前',
      // PL-1: 行の、次にすること（サイトの画面と同じ判定の段の文）と「続ける」。
      next: '次にすること',
      environment: 'サイトの種類',
      mode: '点検のしかた',
      auth: 'ログインのしかた',
      status: '状態',
      revision: '何回目の変更か',
      updatedAt: '最後の更新',
      lastRun: '前回の点検',
    },
  },
  profileForm: {
    // T43b（Task 43 の設計書 4.2）: 開始の URL から対象の設定のファイルを作るか、すでにある設定のファイルを使うか。PL-1（設計書
    // `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面はいつも開始のアドレスから決め、同じサイトの設定のファイルが決まらないときだけ、
    // 保存の拒否の知らせの中で選ぶ（`targetChoice`）。
    targetChoice: 'どれを使いますか',
    targetSourceNew: '開始のアドレスから新しく作る',
    startUrl: '開始のアドレス',
    startUrlHint: '点検を始めるページのアドレスを貼り付けます（例: https://example.test/admin）。',
    // MI-1: 使い方の 2 択（環境・監査モード・認証の方式は、ここから決まる。詳しい設定で直せる）。
    usage: '使い方',
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11）: ログインが要るかで選ぶ語にした。
    usageTestAuth: 'ログインが必要なサイト',
    usagePublic: 'ログインしなくても見られるサイト',
    // PL-1: 隔離の扱いの 2 択（作成）は外した（保存した日の未確認の参照をサーバが作り、確かめた記録の参照は「書き込みも試す」の確認で選ぶ。PL-5）。作成の
    // 「詳しい設定」の欄（と、その空のままのときの決め方の説明）も消した。
    // MI-2（設計書 4.2 の「保存して入口を確かめる」）: テスト環境のときの保存のボタンと、その下の説明。
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11、4.1.3 の 3）: ボタンは 1 つ。保存 → サイトの下調べ → 点検へ、自動で進む。
    // OP-1（設計書 4.1 の D5、4.1.3 の 2）: サイトの設定の「毎回手でログインする」の切り替え（詳しい内容の中）。
    manualLoginEveryTime: '毎回手でログインする',
    manualLoginEveryTimeHint: '入れると、点検のたびに開いたブラウザで手でログインします。外すと、BeakSight が自動でログインします（保存した ID とパスワードは消しません）。',
    saveAndCheckEntry: '点検を始める',
    saveAndCheckEntryNote: '押すと、サイトを下調べしてから点検を始めます。ログインの画面が開いたら、いつもどおりログインしてください。次からは BeakSight がログインします。',
    // OP-1 修正の 2 回目（4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」）: ログインしなくても見られるサイトのときの説明（ログインの文はない）。
    saveAndCheckEntryNotePublic: '押すと、サイトを下調べしてから点検を始めます。',
    // MI-1: 開始の URL の Origin を許可 Origin に含む設定のファイルが 2 つ以上あった（何も保存していない）。
    targetConfigAmbiguous: {
      description: '同じサイトの設定のファイルが複数あります。どれを使うかを決められないので、保存していません。',
      action: '上で使うファイルを選んでから、もう一度保存してください。',
    },
    // MI-C2 項目 16 の `newServiceOriginsFromAutomatedLogin` は、MI-F1 で `PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS` に置き換えた。
    // MI-C: 開始の URL の Origin を許可 Origin に含む設定のファイルはあるが、どれも別の開始の URL だった（新しいファイルを作らず、何も保存していない）。
    targetConfigStartUrlMismatch: {
      description: '同じサイトの設定のファイルが、別の開始のアドレスであります。どれを使うか、新しく作るかを決められないので、保存していません。',
      action: '上で、使うファイルか「開始のアドレスから新しく作る」を選んでから、もう一度保存してください。',
    },
    // MI-2: 保存はできたが、続けて入口の確かめを始められなかったとき（プロファイルの詳細に出す）。
    entryCheckNotStarted: {
      heading: 'サイトは保存しましたが、サイトの下調べを始められませんでした',
      action: '「サイトの下調べをやり直す」を押して、もう一度始めてください。',
      requestFailed: '画面のサーバとのやりとりで誤りが起きたため、サイトの下調べを始めたかを確かめられませんでした。始まっていることがあります。',
      // MI-F3（MI-R の Minor 14b）: 応答を取れなかったときの、このプロファイルの入口の確かめのジョブ（動いているもの・終わったもの）。押し直す前に見る。
      jobsFound:
        'このサイトの下調べの作業が、次のとおりあります。作業の画面で、様子と結果を確かめてください。もう一度始めると、開始のアドレスのページをもう 1 回読みます。',
      noJobs: 'このサイトの下調べの作業は、まだありません。',
    },
    profileId: '名前',
    profileIdHint: '使える文字は、小文字の英字と数字とハイフン（-）です（例: example-public）。保存した後は変えられません。',
    targetConfigPath: '設定のファイル',
    targetConfigPathHint: 'config/targets/ か local/targets/ の中の JSON です。',
    targetConfigPathPlaceholder: '選んでください',
    noTargetConfigs: '設定のファイルが見つかりません。config/targets/ か local/targets/ に JSON を置いてください。',
    environment: 'サイトの種類',
    mode: '点検のしかた',
    auth: 'ログインのしかた',
    approvedTestOrigins: 'テスト用のサイトのアドレス（1 行に 1 つ）',
    approvedTestOriginsHint: 'テスト用のサイトを点検するときだけ書きます（例: https://test.example.invalid）。',
    environmentEvidenceRef: 'テスト用のサイトであることを確かめた記録（名前や置き場所）',
    environmentEvidenceRefHint: 'テスト用のサイトを点検するときだけ書きます。秘密（パスワードなど）は書かないでください。',
    required: 'この項目を入力してください。',
    save: '保存する',
    saving: '保存しています…',
    created: 'サイトを登録しました。',
    updated: 'サイトの設定を更新しました。',
    rejectedHeading: '保存できませんでした',
    revisionText: (revision: number): string => `${revision} 回目の変更`,
    configCheckHeading: '設定のファイルの確かめ',
    configOk: '設定のファイルに誤りはありません。',
    configChecking: '確かめています…',
    retiredNotice: 'このサイトの登録は取り消してあります。変更はできません。',
  },
  retireDialog: {
    open: 'このサイトの登録を取り消す',
    title: 'サイトの登録を取り消しますか',
    body: '取り消すと、元に戻せません。同じ名前は使い直せません。続けて点検する場合は、別の名前でサイトを足してください。保存した ID とパスワードがあれば、それも消します。',
    confirm: '取り消す',
    cancel: 'やめる',
    done: 'サイトの登録を取り消しました。',
    // T26g-2（T26R の I1）: 取り消しの後に、保存した資格情報を消せなかったとき（取り消しは成功のまま）。
    credentialNotRemoved: '保存した ID とパスワードを消せませんでした。ID とパスワードの画面から消してください。',
  },
  environmentStatus: {
    nodeVersion: 'Node.js の版',
    sqliteVersion: 'SQLite の版',
    databaseLocation: '管理データの場所',
    schemaVersion: '管理データの版',
    schemaVersionText: (current: number, latest: number): string => `版 ${current}（この BeakSight の最新: 版 ${latest}）`,
    profileCounts: '登録したサイトの件数',
    quickCheck: '管理データに壊れがないかの確かめ',
    quickCheckOk: '問題はありません',
    quickCheckProblem: '問題があります。npm run setup:local の表示を確かめてください。',
    listening: 'この画面を開ける所',
    listeningValue: 'このパソコンの中からだけ（127.0.0.1）',
  },
} as const);

/**
 * MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」）: 画面のサーバの起動のときに、使えないプロファイルを自動で
 * 取り消したときの、画面のサーバのログ（標準出力）の行（取り消したプロファイルごとに 1 行。画面には出さない）。理由の鍵は `src/control/unusable-profile.ts` の
 * `UNUSABLE_PROFILE_REASONS`（網羅は `catalog-coverage.ts`）。
 */
export const LOCAL_UI_UNUSABLE_PROFILE_TEXT = deepFreeze({
  /** `credentialNotRemoved`: 取り消しの後に、保存した資格情報を消せなかった（取り消しは成功のまま。文は取り消しの画面と同じ）。 */
  retired: (profileId: string, reasonText: string, credentialNotRemoved: boolean): string =>
    `使えないサイトの登録を取り消しました: ${profileId}（理由: ${reasonText}）。${credentialNotRemoved ? LOCAL_UI_TEXT.retireDialog.credentialNotRemoved : ''}`,
  reasons: {
    AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP:
      'ログインのしかたが自動ログインなのに、ログインの設定がないため、ログインの要る作業をどれも始められません。今は、手でログインするサイトの 1 回目の点検で手でログインすると、自動ログインになります',
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 監査のジョブ（ローカルの管理画面から動かす監査。Task 24 の設計書 4.4、4.8、4.9。T24f）
// ---------------------------------------------------------------------------------------------------------------

/** 監査を、同じプロファイルで続きから再開する手順の文（中断と失敗の手順で使う）。 */
const AUDIT_JOB_RESUME_ACTION_TEXT = '同じサイトで「点検を始める」を押すと、続きから再開します。';

/**
 * 止めた自動ログインを、人が確かめてから再び許す手順の文（Task 26 の設計書 4.2、4.6。T26e）。開始を拒む理由と、自動ログインの結果の手順で使う。
 */
const AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT =
  '確かめたら、「自動ログインの再開」の画面で、自動ログインの停止を解いてください。ID とパスワードを変えるときは、変更の画面でまとめて解けます。';

/**
 * 監査のジョブの開始を拒む理由ごとの説明と手順。理由の一覧は `src/control/job/job-records.ts` の `AUDIT_JOB_START_REJECTION_REASONS` が持ち、
 * 書き漏れと余分は画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる（このファイルは `src/control/` を import しない）。
 */
export const AUDIT_JOB_START_REJECTION_DESCRIPTIONS = deepFreeze({
  INVALID_REQUEST: {
    description: '始める要求の形が正しくないか、画面のサーバが終わるところです。まだ何も始めていません。',
    action: '画面を読み込み直してから、もう一度開始してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '点検するサイトが見つかりません。',
    action: 'サイトの一覧を読み込み直して、サイトを確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '登録を取り消したサイトでは、点検を始められません。',
    action: '続けて点検する場合は、新しい名前でサイトを足してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、サイトの設定が変わりました。点検は始めていません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度開始してください。',
  },
  // T27f（Task 27 の設計書 4.7）: 操作の候補の発見と READ の確かめは、認証つきの読み取りの監査のプロファイルだけで行う（公開の監査のプロファイルも
  // この理由になる）ので、説明を見直した。T28b（Task 28 の設計書 4.5）: 書き込みのモードのプロファイルでも、発見と READ の確かめを行えるようにした。
  // MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.5）: 書き込みのモードのプロファイルでも、読み取りの監査を始められるようにした（監査は
  // 読むだけ）ので、「書き込みのモードでは監査を始められない」の文を外した。
  MODE_NOT_EXECUTABLE: {
    description: 'このサイトの点検のしかたでは、この作業を始められません。',
    action: '点検は、「公開の画面の点検」か、テスト用のサイトの点検（「ログインして見るだけの点検」か「書き込みも試す点検」）のサイトで始めてください。点検そのものは、どれも見るだけです。操作さがしと見るだけの確かめは、「ログインして見るだけの点検」か「書き込みも試す点検」のサイトの画面から始めてください。書き込みは、「書き込みも試す点検」のサイトの、書き込みの手順から始めてください。',
  },
  TARGET_PATH_INVALID: {
    description: 'このサイトが使う設定のファイルの場所を、受け付けません。',
    action: '「サイトの設定」の画面で、config/targets/ か local/targets/ の中の .json を選び直してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'このサイトが使う設定のファイルを読めないか、その内容に誤りがあります。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度開始してください。',
  },
  PROFILE_INVALID: {
    description: '今の設定のファイルでは、サイトの設定に誤りがあります。',
    action: '表示された誤りを、「サイトの設定」の画面で直してから、もう一度始めてください。',
  },
  JOB_ALREADY_ACTIVE: {
    description: 'ほかの作業が動いています。作業は、同時に 1 つだけ動かせます（サイトへの負担を増やさないため）。',
    action: '「作業の履歴」で、動いている作業が終わるのを待つか、止めてから、もう一度始めてください。',
  },
  // T24h-4（DEF-061）: この画面のサーバが、画面のサーバを 1 つだけにするロックを失った（ほかの画面のサーバが取り直した）。
  CONTROL_INSTANCE_LOCK_LOST: {
    description: 'ほかの画面のサーバが動き始めたため、この画面のサーバでは作業を始められません。画面のサーバは、同時に 1 つだけ動かせます。',
    action: 'この画面のサーバを止めて、動いている画面のサーバを使ってください。',
  },
  // T25d（Task 25 の設計書 4.4、4.5）: 認証つきの読み取りの監査の開始の確かめ。
  // T26e: 自動ログインは方式として実行できるようになった（Windows だけであることは、資格情報の暗号化の確かめで決める）。今この理由になるのは、
  // ログインの確かめを自動ログインでないプロファイルで始めようとしたときと、監査モードに合わない認証の方式のとき。
  AUTH_STRATEGY_NOT_EXECUTABLE: {
    // PL-T: 画面からログインの確かめを始める道はなくなったので、ログインの確かめの説明は外した。
    description: 'このサイトのログインのしかたでは、この作業を始められません。',
    action: 'サイトのログインのしかたを確かめてください。手でログインするサイトは、「点検を始める」から始めてください。',
  },
  AUTH_SETUP_MISSING: {
    description: 'このサイトには、ログインの設定がありません。点検は始めていません。',
    // MI-8（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.9）: 認証の設定は入口の確かめの後に BeakSight が案で保存する（MI-3）ので、先に入口を確かめる。
    action: `サイトの画面の「サイトの下調べをやり直す」を押してください。ログインの画面が見つかると、BeakSight がログインの設定の案を保存します。保存できなかったときは、${ADVANCED_SETTINGS_REF_TEXT}からログインの設定を作ってから、もう一度始めてください。`,
  },
  AUTH_SETUP_STALE: {
    description: 'ログインの設定を作った後に、サイトの設定が変わりました。古いログインの設定では、点検を始めません。',
    action: 'ログインの設定を開いて、今のサイトの設定で保存し直してから、もう一度始めてください。',
  },
  AUTH_SETUP_INVALID: {
    description: '今のサイトの設定と設定のファイルでは、ログインの設定に誤りがあります。点検は始めていません。',
    action: 'ログインの設定を開いて、誤りを直して保存してから、もう一度始めてください。',
  },
  // T26c（Task 26 の設計書 4.5 の開始の前の確かめ）: 自動ログインの資格情報と上限。T26e で文言を見直した（ログインの確かめと監査の両方で使う）。
  CREDENTIAL_MISSING: {
    description: 'このサイトには、自動ログインに使う ID とパスワードが保存されていません。ログインは始めていません。',
    action: 'サイトの画面から ID とパスワードの画面を開き、テスト用のアカウントの ID とパスワードを登録してから、もう一度始めてください。',
  },
  CREDENTIAL_STALE: {
    description: 'ID とパスワードを保存したときのログインの画面と、今のログインの設定のログインの画面とで、サイトのアドレスが違います。ログインは始めていません。',
    action: 'ID とパスワードの画面で、ID とパスワードの両方を入れ直してから、もう一度始めてください。',
  },
  CREDENTIAL_PROTECTION_UNAVAILABLE: {
    description: 'このパソコンでは、パスワードを守る Windows の暗号化を使えないため、自動ログインを始めません。Windows でないパソコンでは、自動ログインは使えません。',
    action: '「環境の状態」の画面で、パスワードの暗号化の状態を確かめてください。Windows では、ID とパスワードを保存したときと同じ Windows の利用者で、画面のサーバを動かしてください。',
  },
  AUTO_LOGIN_HELD: {
    description: '前の自動ログインがうまくいかなかったため、アカウントがロックされて使えなくなるのを避けるために、このサイトの自動ログインを止めています。',
    action: `前の作業の結果の案内に従って、テスト用のサイトのアカウントと、保存した ID とパスワードと、ログインの設定を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  AUTO_LOGIN_RATE_LIMITED: {
    description: 'まだ自動ログインを始められません。前の自動ログインから間がないか、24 時間の回数の上限に達したか、サイトが示した待ち時間の中です。サイトに負担をかけず、アカウントのロックを避けるための決まりです。',
    action: '少し時間をおいてから、もう一度始めてください。次に始められる日時が出ているときは、その日時を過ぎてから始めてください。',
  },
  // T27e（Task 27 の設計書 4.5、4.6）: READ の確かめを、定義が 1 件もないプロファイルで始めようとした（T27f で文言を見直した）。
  READ_CHECK_DEFINITIONS_MISSING: {
    description: 'このサイトには、見るだけの確かめがありません（削除したものは数えません）。見るだけの確かめは始めていません。サイトにはつないでいません。',
    action: '「見るだけの確かめ」の画面で、見るだけの操作を選び、送る値とあるはずのものを決めて保存してから、もう一度始めてください。見つかった操作がなければ、先に「操作さがしを始める」を押してください。',
  },
  // T30e（Task 30 の設計書 3 章）: 書き込みのジョブの開始を拒む理由。画面の始める口は T30g。
  WRITE_GRANT_REJECTED: {
    description: '書き込みの OK を使えませんでした（ない、使い終わった、期限が切れた、取り消された、OK を出したときと状況が変わった、など）。書き込みは送っていません。',
    action: '書き込みの手順の、書き込みの OK の状態を確かめてください。必要なら書き込みの OK を出し直してから、もう一度始めてください。',
  },
  WRITE_DATA_NOT_GENERATED: {
    description: '送る値を作れませんでした（入れる値の決まりが定まらない、重ならない値の組み合わせを使い切った、答え合わせの見るだけの確かめに結び付ける値がない、など）。書き込みは送っていません。',
    action: '書き込みの手順の、入れる値の決まりと答え合わせのしかたを見直してください。それから書き込みの OK を出し直して、もう一度始めてください。',
  },
  // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない。
  WRITE_READ_VERIFICATION_PAGE_TARGET: {
    description: '答え合わせに選んだ見るだけの確かめが、ページ（アドレスの後ろ）を読むものです。書き込みの答え合わせには、見るだけの操作を読む確かめだけを使えます。書き込みは送っていません。',
    action: '書き込みの手順の答え合わせのしかたで、見るだけの操作を読む確かめを選び直してください。それから書き込みの OK を出し直して、もう一度始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * DEF-146: 止める確認のダイアログ（`LOCAL_UI_AUDIT_TEXT.stopDialog`・`forceStopDialog`）の題と確定のボタンに入れる、止める対象の呼び名（ジョブの種類
 * `AUDIT_JOB_KINDS` ごと。網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる）。
 */
export const AUDIT_JOB_STOP_TARGET_NAMES = deepFreeze({
  AUDIT: '点検',
  LOGIN_CHECK: 'ログインの確かめ',
  DISCOVERY: '操作さがし',
  READ_CHECK: '見るだけの確かめ',
  WRITE_CREATE: '登録の書き込み',
  WRITE_UPDATE: '更新の書き込み',
  ENTRY_CHECK: 'サイトの下調べ',
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
    stop: '今のページの点検を終えてから止めます。止めた点検の回は、一部が終わっていない状態になります。後で「点検を始める」を押すと、続きから再開します。',
    force: '今のページの点検を待たずに、すぐに止めます。続きから再開するための記録は、最後に点検を終えたページまで残ります。',
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
    stop: `次の確かめに進まずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.READ_CHECK)}`,
    force: `今の読み込みを待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.READ_CHECK)}`,
  },
  WRITE_CREATE: {
    stop: `書き込みを送る前なら、送らずに止めます。送る直前の確かめ直しの後に止めたときは、そのまま送り、その回の結果を記録します。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_CREATE)}`,
    force: `待たずに、すぐに止めます。送った後に止めると、送ったか分からない（結果が分からない）として記録することがあります。そのときは、テスト用のサイトでデータの状態を確かめてください。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_CREATE)}`,
  },
  WRITE_UPDATE: {
    stop: `書き込みを送る前なら、送らずに止めます。送る直前の確かめ直しの後に止めたときは、そのまま送り、その回の結果を記録します。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_UPDATE)}`,
    force: `待たずに、すぐに止めます。送った後に止めると、送ったか分からない（結果が分からない）として記録することがあります。そのときは、テスト用のサイトでデータの状態を確かめてください。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.WRITE_UPDATE)}`,
  },
  ENTRY_CHECK: {
    stop: `開始のアドレスのページを読む前なら、読まずに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.ENTRY_CHECK)}`,
    force: `待たずに、すぐに止めます。${stopWithoutResumeText(AUDIT_JOB_STOP_TARGET_NAMES.ENTRY_CHECK)}`,
  },
} as const);

/**
 * T44d（設計の変更の履歴の T44d の行の P2-3 の残り）: 止める要求を送った後に、ジョブの画面に出す文（ジョブの種類ごと。止まり方は
 * `AUDIT_JOB_STOP_DIALOG_BODIES` の `stop` と同じ）。網羅は画面の側の `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる。
 */
export const AUDIT_JOB_STOP_REQUESTED_TEXTS = deepFreeze({
  AUDIT: '止める要求を送りました。今のページの点検を終えてから止まります。',
  LOGIN_CHECK: '止める要求を送りました。ログインを送る前なら、送らずに止まります。',
  DISCOVERY: '止める要求を送りました。次の画面を読まずに止まります。',
  READ_CHECK: '止める要求を送りました。次の確かめに進まずに止まります。',
  WRITE_CREATE: '止める要求を送りました。書き込みを送る前なら、送らずに止まります。',
  WRITE_UPDATE: '止める要求を送りました。書き込みを送る前なら、送らずに止まります。',
  ENTRY_CHECK: '止める要求を送りました。開始のアドレスのページを読む前なら、読まずに止まります。',
} as const);

/** 監査のジョブの停止を拒む理由ごとの説明と手順（理由の一覧は `AUDIT_JOB_STOP_REJECTION_REASONS`）。 */
export const AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS = deepFreeze({
  JOB_NOT_FOUND: {
    description: '対象の作業が見つかりません。',
    action: '作業の履歴を読み込み直して、対象を確かめてください。',
  },
  JOB_NOT_ACTIVE: {
    description: 'この作業は、もう終わっています。',
    action: '画面を読み込み直して、今の状態を確かめてください。',
  },
  JOB_NOT_OWNED: {
    description: 'この作業は、前に起動した画面のサーバのものなので、この画面からは止められません。',
    action: '画面を読み込み直してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 監査で、設定のファイルの `crawl.allowedQueryParameters` に秘密に見える名前があって始めなかったときの案内（T25f round 1）。ワーカーは
 * 設定のエラー（`CONFIG_ERROR`）で終えるので、`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR` の手順に足す。T44g（Task 44 の P4-1 の発見事項 4）:
 * 公開の監査も同じ理由で始めないので、文は公開の監査にも当てはまる形にした（名前は今のまま）。
 */
export const AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION =
  '公開の画面の点検でも、ログインして点検するときでも、設定のファイルで読んでよい「アドレスの ? の後ろ」の名前（設定の項目 crawl.allowedQueryParameters）に、秘密に見える名前（token、session、code、state など）は入れられません。';

/**
 * 監査のジョブの失敗と中断の理由ごとの説明と手順（理由の一覧は `src/control/job/job-records.ts` の `AUDIT_JOB_FAILURE_REASONS`。先頭の 6 つは
 * ワーカーが送る理由）。監査の外の失敗の文は、CLI と同じもの（`CLI_TEXT.failure`）を使う。
 */
export const AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS = deepFreeze({
  CONFIG_ERROR: {
    description: '設定のファイルに誤りがあるため、点検を始められませんでした。',
    action: `設定のファイルの内容を確かめてから、もう一度開始してください。${AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION}`,
  },
  ARTIFACT_WRITE_FAILED: {
    description: CLI_TEXT.failure.artifactWriteFailed,
    action: '出力先のフォルダの空きと書き込みの権限を確かめてから、もう一度開始してください。',
  },
  UNEXPECTED_FAILURE: {
    description: CLI_TEXT.failure.unexpected,
    action: `${AUDIT_JOB_RESUME_ACTION_TEXT}繰り返し起きる場合は、画面のサーバを起動したウィンドウの表示を確かめてください。`,
  },
  PROTOCOL_VIOLATION: {
    description: '画面のサーバと点検のプログラムのやりとりの形が正しくなかったため、点検のプログラムを止めました。',
    action: `${AUDIT_JOB_RESUME_ACTION_TEXT}繰り返し起きる場合は、npm run build を実行してから、画面のサーバを起動し直してください。`,
  },
  START_TIMEOUT: {
    description: '点検のプログラムが、始める合図を、決まった時間の中に受け取れませんでした。',
    action: 'もう一度開始してください。',
  },
  // T24h-1 の M3: 開始の直前の検証の後に、ターゲット設定のファイルが変わった。
  CONFIG_CHANGED: {
    description: '始める前の確かめの後に、設定のファイルが変わったため、点検を始めませんでした。',
    action: '設定のファイルの内容を確かめてから、もう一度開始してください。',
  },
  WORKER_START_FAILED: {
    description: '点検のプログラムを起動できませんでした。',
    action: 'npm run build を実行してから、画面のサーバを起動し直してください（npm run ui は、ビルドしてから起動します）。',
  },
  WORKER_NOT_READY: {
    description: '点検のプログラムが、決まった時間の中に準備を終えませんでした。',
    action: 'もう一度開始してください。繰り返し起きる場合は、npm run build を実行してから、画面のサーバを起動し直してください。',
  },
  WORKER_EXITED: {
    description: '点検のプログラムが、結果を返す前に終わりました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  WORKER_UNRESPONSIVE: {
    description: '点検のプログラムが応答しなくなったため、止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  STOP_TIMEOUT: {
    description: '強制的に止める要求の後も終わらなかったため、点検のプログラムを止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  SERVER_RESTARTED: {
    description: '画面のサーバが、作業の途中で終わりました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  SERVER_SHUTDOWN: {
    description: '画面のサーバを終えるときに、決まった時間の中に作業が終わらなかったため、止めました。',
    action: AUDIT_JOB_RESUME_ACTION_TEXT,
  },
  // T25d（Task 25 の設計書 4.4）: ワーカーが `FAILED` で送る、認証つきの監査の理由（監査は始めていない）。
  AUTH_SETUP_CHANGED: {
    description: '始める前の確かめの後に、ログインの設定が変わったため、ログインも点検も始めませんでした。',
    action: 'ログインの設定を確かめてから、もう一度始めてください。',
  },
  AUTH_SETUP_REQUIRED: {
    description: 'ログインに使うブラウザが閉じられたか、ログインの画面を安全に開けなかったため、点検を始めませんでした。',
    action: 'ログインの設定（ログインの画面のアドレスなど）を確かめてから、もう一度始めてください。',
  },
  UNSUPPORTED_AUTH_STATE: {
    description: 'ログインの後に、点検してよいサイトについて、ブラウザに残るログインの印も、ブラウザの保存場所の中身もなかったため、点検を始めませんでした。',
    action: 'この形のログイン（別のサイトにあるログインの画面など）には、まだ対応していません。ログインの設定を確かめてください。',
  },
  LOGIN_TIMEOUT: {
    description: '決められた時間の中に、ログインが済まなかったため、点検を始めませんでした。',
    action: 'もう一度開始して、BeakSight が開いたブラウザでログインしてください。',
  },
  LOGIN_ATTEMPTS_EXCEEDED: {
    description: 'ログインの送り先への送信を止めたため、ログインを止めました。ログインの設定の回数の上限を超えたか、BeakSight が扱えない形のログイン（ページの中のプログラムで送るログインなど）の可能性があります。点検は始めていません。',
    action: 'ログインの画面が、ふつうのフォームの送信（ページが移る形）でログインするかを確かめてください。そうであれば、ID とパスワードと、ログインの設定の回数の上限を確かめてから、もう一度始めてください。',
  },
  // T26c（Task 26 の設計書 4.5 の結果の閉じた一覧）: 自動ログインが成功以外で終わった。ログインを送った（か分からない）ときは、そのプロファイルの
  // 自動ログインを止めている。T26e で文言を見直した（人がすることを、手順の先頭に書く）。
  INVALID_CREDENTIALS: {
    description: 'ログインの画面が、ID かパスワードの誤りを示しました。アカウントのロックを避けるため、このサイトの自動ログインを止めました。',
    action: `テスト用のサイトで正しい ID とパスワードを確かめ、ID とパスワードの画面で変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  ACCOUNT_LOCKED: {
    description: 'ログインの画面が、アカウントがロックされて使えないことを示しました。このサイトの自動ログインを止めました。',
    action: `テスト用のサイトの管理者に、アカウントのロックの解除を頼み、解除されたことを確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  MFA_REQUIRED: {
    description: 'ログインの後に、2 段階の確認などの人の操作を求められました。BeakSight は、この操作をしません。このサイトの自動ログインを止めました。',
    action: `2 段階の確認があるアカウントは、自動ログインに使えません。2 段階の確認を求めないテスト用のアカウントに変え、ID とパスワードの画面で変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  CREDENTIAL_EXPIRED: {
    description: 'ログインの画面が、パスワードの期限切れを示しました。このサイトの自動ログインを止めました。',
    action: `テスト用のサイトでパスワードを新しくしてから、ID とパスワードの画面でパスワードを変更してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  RATE_LIMITED: {
    description: 'ログインの送信が、サイトの回数の制限で断られました。このサイトの自動ログインを止めました。',
    action: `時間をおいてください。サイトが示した日時を過ぎるまでは、停止を解いても自動ログインを始められません。テスト用のサイトの状態を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  AUTH_RESULT_UNKNOWN: {
    description: 'ログインの結果を、ログインの設定の条件で 1 つに決められませんでした（どの条件にも当たらない、2 つ以上に当たる、サイトの誤り、途中で点検のプログラムが終わった、など）。このサイトの自動ログインを止めました。',
    action: `テスト用のサイトでアカウントの状態を確かめ、ログインの設定の成功の条件と失敗の条件（アドレスの後ろと部品の目印）を見直してください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  LOGIN_FORM_INVALID: {
    description: 'ログインのフォームが、安全に値を入れられる形ではなかったため、値を入れずに止めました。ログインは送信していないので、自動ログインは止めていません。',
    action: '表示された理由を見て、ログインの設定の部品の目印と、ログインの送り先（送るフォーム、送り先のサイトのアドレスとアドレスの後ろ）を見直してください。',
  },
  LOGIN_FORM_INPUT_FAILED: {
    description: 'ログインのフォームに値を入れるか、送信するところで失敗しました。送信したかが分からないときは、このサイトの自動ログインを止めています。',
    action: `ログインの設定の部品の目印を見直してください。自動ログインを止めているときは、テスト用のサイトのアカウントの状態を確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  CREDENTIAL_CHANGED: {
    description: '始める前の確かめの後に、保存した ID とパスワードが変わったため、ログインを始めませんでした。ログインは送信していません。',
    action: 'ID とパスワードの画面で今の状態を確かめてから、もう一度始めてください。',
  },
  CREDENTIAL_UNAVAILABLE: {
    description: '保存した ID とパスワードを読み出せなかった（暗号を解けなかった）ため、ログインを始めませんでした。ログインは送信していません。',
    action: 'ID とパスワードを保存したときと同じ Windows の利用者で、画面のサーバを動かしているかを確かめてください。直らない場合は、ID とパスワードの画面で消してから、登録し直してください。',
  },
  // T26g-1（設計書の変更履歴の「T26R」の行）: 送信の窓の中で、ページが許した送信のほかの要求を出そうとしたので止めた。
  UNEXPECTED_LOGIN_REQUEST: {
    description: 'ログインの画面が、入力した値を、決めたログインの送信のほかの通信（画像、別のサイト、別のフォームなど）で送ろうとしました。そのため、その通信を止めてログインを中止しました。値は送っていません。ログインを送った（か分からない）ときは、このサイトの自動ログインを止めています。',
    action: `ログインの画面が、入力した値を別の通信で送る作りになっていないかを確かめてください。BeakSight は、この形のログインを自動では扱えません。手でログインするしかたに切り替えるか、ログインの画面を直してください。自動ログインを止めているときは、テスト用のサイトのアカウントの状態も確かめてください。${AUTO_LOGIN_HOLD_CLEAR_ACTION_TEXT}`,
  },
  // T27c（Task 27 の設計書の変更履歴「Blocker: T27c」の行の (2)）: ワーカーがまだ対応していない種類のジョブを受けたので、ログインも監査もせずに
  // 止めた（T27f で文言を見直した。画面のサーバとワーカーのビルドの版が合わないときに起きる）。
  JOB_KIND_NOT_SUPPORTED: {
    description: '点検のプログラムが、この種類の作業に対応していなかったため、ログインも点検もせずに止めました。サイトにはつないでいません。画面のサーバと点検のプログラムのビルドが合っていない可能性があります。',
    action: 'npm run build を実行してから、画面のサーバを起動し直してください（npm run ui は、ビルドしてから起動します）。繰り返し起きる場合は、BeakSight の版を確かめてください。',
  },
  // T27d（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）: 発見のジョブの結果（`discovery.json`）を読めなかったので、候補の一覧を
  // 変えずに止めた（T27f で文言を見直した）。
  DISCOVERY_RESULT_INVALID: {
    description: '操作さがしの作業の結果のファイル（discovery.json）を読めないか、形が正しくなかったため、見つかった操作の一覧を変えずに止めました。',
    action: 'もう一度「操作さがしを始める」を押してください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
  },
  // T27e（Task 27 の設計書 4.5）: READ の確かめのジョブの結果（`read-evidence.json`）を読めなかったので、結果を記録せずに止めた（T27f で文言を
  // 見直した）。
  READ_CHECK_RESULT_INVALID: {
    description: '見るだけの確かめの作業の結果のファイル（read-evidence.json）を読めないか、形が正しくなかったため、結果を記録せずに止めました。',
    action: 'もう一度、見るだけの確かめを始めてください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
  },
  // T30d（Task 30 の設計書 3 章の「記録」）: 書き込みのジョブ（`WRITE_CREATE`）の理由。始める口と画面は T30e・T30g。
  WRITE_GRANT_REJECTED: {
    description: '書き込みの OK を使えなかった（取り消された、期限が切れた、OK を出したときと状況が変わった、など）ため、送らずに止めました。',
    action: '書き込みの手順の、書き込みの OK の状態を確かめてください。必要なら書き込みの OK を出し直してから、もう一度書き込みを始めてください。',
  },
  WRITE_RESULT_INVALID: {
    description: '書き込みの作業の結果のファイル（action-run.json）を読めないか、形が正しくなかったため、結果を「分からない」として記録しました。登録されたかどうかは分かりません。',
    action: 'テスト用のサイトで、登録されたかどうかを確かめてください。書き込みの件数は、使ったものとして数えています。',
  },
  // T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブの結果（`entry-check.json`）を読めなかったので、その案を使わずに止めた。
  ENTRY_CHECK_RESULT_INVALID: {
    description: 'サイトの下調べの作業の結果のファイル（entry-check.json）を読めないか、形が正しくなかったため、その結果から作った案は使いません。',
    action: 'もう一度「サイトを下調べする」を始めてください。繰り返し起きる場合は、出力先のフォルダに書き込めるか、設定のファイルの出力先が変わっていないか、BeakSight の版を確かめてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * READ の確かめの定義の保存を拒む理由（`src/control/read-check-policy.ts` の `READ_CHECK_DEFINITION_REJECTION_REASONS`。Task 27 の設計書 4.5。T27c）
 * ごとの説明と手順。書き漏れと余分は、画面の側で型で確かめる（T27f で文言を見直し、取り消したプロファイルの理由を足した）。画面の「削除」は、
 * 定義を一覧から外す操作（管理データの行は消さずに、取り消した時刻を書く）。
 */
export const READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS = deepFreeze({
  READ_CHECK_INPUT_INVALID: {
    description: '見るだけの確かめの中身の形が正しくありません。あるはずのものがない、確かめる中身の種類が違う、数や文の長さや件数が上限を超えている、などです。保存していません。',
    action: 'あるはずのものの欄と送る値を見直してから、もう一度保存してください。',
  },
  READ_PARAMETER_SECRET_LIKE: {
    description: '秘密に見える名前（token、session、code、state、key など）の欄には、値を送りません。保存していません。',
    action: 'その欄の値を空にしてから、もう一度保存してください。この欄に値が要る画面は、見るだけの確かめに使えません。',
  },
  READ_PARAMETER_NOT_ALLOWED: {
    description: '値を送れるのは、対象の操作の候補の欄のうち、見えていて、使えて、変えられる欄だけです。パスワードとファイルの欄は、名前にかかわらず送りません。保存していません。',
    action: '前回の操作さがしの結果で、欄が見えなくなったり、変えられなくなったりしていないかを確かめてください。送れる欄だけに値を入れてから、もう一度保存してください。',
  },
  READ_CANDIDATE_UNKNOWN: {
    description: '対象の操作の候補が、前回の操作さがしの結果にありません。保存していません。',
    action: '操作さがしをもう一度行い、今の候補から選び直してください。',
  },
  READ_CANDIDATE_NOT_READ: {
    description: '対象の操作の候補は、前回の操作さがしの結果で、見るだけの操作に分けられていません。見るだけの確かめには使えません。保存していません。',
    action: '見るだけの操作に分けられた候補を選んでください。',
  },
  READ_CHECK_LIMIT_EXCEEDED: {
    description: 'このサイトの見るだけの確かめが、上限の数に達しています。保存していません。',
    action: '使わない見るだけの確かめを削除してから、もう一度保存してください。',
  },
  READ_CHECK_PROFILE_NOT_FOUND: {
    description: '対象のサイトが見つかりません。保存していません。',
    action: 'サイトの一覧を読み込み直して、対象を確かめてください。',
  },
  READ_CHECK_NOT_FOUND: {
    description: '対象の見るだけの確かめが見つかりません。',
    action: '見るだけの確かめの一覧を読み込み直して、対象を確かめてください。',
  },
  READ_CHECK_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、この見るだけの確かめが変わりました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
  READ_CHECK_CANCELED: {
    description: 'この見るだけの確かめは削除されています。変えられません。',
    action: '必要なら、新しく作ってください。',
  },
  // T27f（T27c の申し送り 6）: 取り消したプロファイルでは、定義を作らない・変えない（削除はできる）。
  READ_CHECK_PROFILE_RETIRED: {
    description: '取り消したサイトでは、見るだけの確かめを作ったり変えたりできません。保存していません。',
    action: '使い続ける場合は、新しい名前でサイトを足し直してください。',
  },
  // T27R-fix-1（DEF-088）: 送る値の名前か値が、発見の分類の危険な語（日本語を含む）に当たる。
  READ_PARAMETER_DANGEROUS_WORD: {
    description: '送る値の名前か値に、危険な語（削除、取り消し、一括、無効、解約、ログアウト、delete、cancel など）があります。この値は送りません。保存していません。',
    action: 'その欄の値を、危険な語を含まない値に変えるか、空にしてから、もう一度保存してください。',
  },
  // T28b fix round 1: READ の確かめを許さないモードのプロファイル（公開の監査）では、定義を作らない・変えない（削除はできる）。
  READ_CHECK_PROFILE_NOT_ELIGIBLE: {
    description: 'このサイトの点検のしかたでは、見るだけの確かめを使えません。見るだけの確かめは、点検のしかたが「ログインして見るだけの点検」か「書き込みも試す点検」のサイトだけで使えます。保存していません。',
    action: '見るだけの確かめを使う場合は、テスト用のサイトのうち、点検のしかたが「ログインして見るだけの点検」か「書き込みも試す点検」のもので作ってください。',
  },
  // T37d（Task 37 の設計書 3.5）: 画面の path の定義の理由。
  READ_PAGE_PATH_INVALID: {
    description: '画面のアドレスの後ろの形が正しくありません。/ で始まり、? と # を含まない形だけを使えます。日本語や空白は %XX の形にしてください。保存していません。',
    action: '前回の操作さがしで読んだ画面から選ぶか、ブラウザのアドレス欄に出る形でアドレスの後ろを入れてから、もう一度保存してください。',
  },
  READ_PAGE_START_URL_UNKNOWN: {
    description: 'サイトの開始のアドレスを読めないため、アドレスの後ろから、読むページのアドレスを決められません。保存していません。',
    action: '設定のファイルを読めるかを確かめてから、もう一度保存してください。',
  },
  READ_PAGE_ORIGIN_NOT_ALLOWED: {
    description: '開始のアドレスのサイトが、点検してよいサイトのアドレスに入っていません。画面を読む見るだけの確かめは、開始のアドレスと同じサイトの画面だけを読みます。保存していません。',
    action: 'サイトの設定の、点検してよいサイトのアドレスと、設定のファイルの開始のアドレスを見直してください。',
  },
  READ_PAGE_PATH_EXCLUDED: {
    description: 'その画面は、読まないページ、読む範囲の外、またはログインの画面です。読みません。保存していません。',
    action: 'ログインの設定の、読まないページと読む範囲を確かめてください。読んでよい画面のアドレスの後ろを選んでください。',
  },
  READ_PAGE_PATH_DANGEROUS_WORD: {
    description: '画面のアドレスの後ろに、危険な語（logout、delete、remove、cancel など）があります。読みません。保存していません。',
    action: '危険な語を含まない画面のアドレスの後ろを選んでください。',
  },
} as const satisfies Record<string, ControlReasonText>);

// ---------------------------------------------------------------------------------------------------------------
// 操作の候補の発見と READ の確かめ（ローカルの管理画面。Task 27 の設計書 4.3、4.5、4.7。T27f）
// 値の一覧と意味は `src/discovery/`（画面へは `src/control/discovery-view.ts` から公開し直す）が持ち、ここは文言だけを持つ。書き漏れと余分は、
// 画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。文言には、入力の値・トークン・選択肢の label を入れない。
// ---------------------------------------------------------------------------------------------------------------

/** 候補の分類の理由のコード（`CANDIDATE_REASON_CODES`）ごとの説明。 */
export const CANDIDATE_REASON_DESCRIPTIONS = deepFreeze({
  ACTION_OUTSIDE_ALLOWED_ORIGINS: '送信先が、点検してよいサイトのアドレスの外か、送信先のサイトのアドレスを読めません。',
  DESTRUCTIVE: '送り方が削除か、ボタンの文言・送信先・アドレスの ? の後ろの名前に、削除や取り消しなどの危険な語があります。',
  READ_GET_FORM: '見るだけの通信で送るフォームで、ページの中のプログラムが結び付いていません。',
  GET_WITH_PASSWORD_FIELD: '見るだけの通信のフォームに、パスワードの欄があります。パスワードをページのアドレスに入れて送る形なので、扱いません。',
  GET_WITH_MULTIPART: '見るだけの通信のフォームの送り方が、ファイルを送る形です。',
  POST_SEARCH: '送る通信で行う検索や絞り込みです。送る通信で読む画面は、扱いません。',
  GRAPHQL_ENDPOINT: '送信先が、GraphQL（データをまとめて扱う窓口）への送る通信です。',
  JS_BOUND: 'フォームか送信のボタンに、ページの中のプログラムの処理が結び付いています。',
  JS_DELEGATED: '画面の全体か、外側の部品に、押す・送る操作を受けるページの中のプログラムがあります。',
  NO_KNOWN_ACTION: 'フォームの外のボタン（またはリセットのボタン）で、押したときの処理が分かりません。',
  DIALOG_METHOD: 'ダイアログを閉じるだけのフォームで、サイトへ送りません。',
  METHOD_OVERRIDE_UNRECOGNIZED: '送り方を上書きする欄（_method）の値が、更新か削除の送り方のどれでもないため、実際の送り方が決まりません。',
  UPDATE_METHOD: '実際の送り方が、更新の送り方です。',
  UPDATE_WORD: '書き込みの送り方で、ボタンの文言か送信先に、更新・保存・編集などの語があります。',
  CREATE_WORD: '書き込みの送り方で、ボタンの文言か送信先に、登録・追加・作成などの語があります。',
  UNCLASSIFIED: '分け方の決まりのどれにも当たりませんでした。',
  DUPLICATE_IDENTITY_CONFLICT: '同じ画面に、見分けのつかない操作の候補が 2 つ以上あり、欄の決まりなどが違うため、1 つにまとめました。',
} as const satisfies Record<string, string>);

/** 発見のジョブで読まなかった画面の理由（`DISCOVERY_UNREAD_REASONS`）の表示の名前。 */
export const DISCOVERY_UNREAD_REASON_LABELS = deepFreeze({
  EXCLUDED: '読まないページ・読む範囲の外・危険な語（設定どおり）',
  MAX_DEPTH_REACHED: '深さの上限',
  NAVIGATION_FAILED: '読み込みの失敗',
  // DEF-136: 4xx・5xx の画面（候補もリンクも拾わない）。
  HTTP_ERROR_STATUS: 'サイトがエラーを返した画面',
  MAX_PAGES_REACHED: 'ページの上限',
  MAX_RUNTIME_REACHED: '時間の上限',
  STOPPED: '止める要求',
  AUTH_SESSION_LOST: 'ログインが切れた',
  // T37a（Task 37 の設計書 3.1）。
  SERVICE_REQUEST_LIMIT_REACHED: '通ってよい外のサイトへの要求の上限',
  // DEF-136。
  SITE_UNAVAILABLE: 'サイトが応答しない',
  SAFETY_VIOLATION: '安全の決まりの違反',
  PREFLIGHT_FAILED: '始める前の確認の失敗',
} as const satisfies Record<string, string>);

/** 発見で画面を読み切れなかった理由（`INCOMPLETE_REASONS`。候補の契約の値）の説明。 */
export const DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS = deepFreeze({
  INCOMPLETE_SETTLE_TIMEOUT: '待つ時間の上限までに、画面の表示が落ち着きませんでした（後から表示される候補があるかもしれません）。',
  INCOMPLETE_FRAME_OR_CLOSED_SHADOW: '画面の中の枠か、外から読めない部品の中は読みません。その中の操作の候補は示しません。',
  INCOMPLETE_FREEZE_UNAVAILABLE: '画面を止めてから読む条件がそろわなかったため、読んでいません。',
  INCOMPLETE_READ_FAILED: '画面を読む途中で失敗したか、読む間に画面が変わりました。',
  INCOMPLETE_LIMIT_REACHED: '部品・候補・欄などの数か、ページのアドレスの長さの上限に達したため、読めた分だけを示します。',
  // DEF-129。
  INCOMPLETE_PAGE_NAVIGATION_LIMIT:
    '画面自身や画面の中の枠の読み込み直しや移動が、決まった回数を超えたため止めました。読んだ内容が途中のものかもしれないため、読めた分だけを示します。',
  // DEF-130-fix。
  INCOMPLETE_PAGE_SUBRESOURCE_LIMIT:
    '画面が出す画像やデータの読み込みなどの要求が、1 画面あたりの決まった数を超えたため止めました。画面がデータを描き切れなかったかもしれないため、読めた分だけを示します。',
  // T37a（Task 37 の設計書 3.1）。T37R2-fix: 今数えている項目（上限・401・止めた登録した呼び出し・サービスの Origin への読み取りでない要求）に合わせた。
  SERVICE_READ_REFUSED:
    'この画面を読む間に、通ってよい外のサイトへの要求を上限で止めた、外のサイトがログインしている状態を受け付けなかった、登録した見るだけの呼び出しを止めた、外のサイトへの見るだけでない要求を止めた、のどれかがありました。画面がデータを描けなかったかもしれないため、読めた分だけを示します。',
} as const satisfies Record<string, string>);

/** READ の確かめの結果の詳しい理由（`READ_CHECK_DETAILS`）の説明。 */
export const READ_CHECK_DETAIL_DESCRIPTIONS = deepFreeze({
  EXPECTATIONS_EVALUATED: '読んで、あるはずのものと照らしました。',
  TARGET_PAGE_UNKNOWN: '対象の操作の候補がどの画面にあるかが分かりません。最後に見た操作さがしの結果を読めませんでした。',
  TARGET_PAGE_UNREADABLE: '対象の操作の候補の画面を読めませんでした。読み込みの失敗、サイトがエラーを返した、画面を止めて読む条件がそろわない、表示が落ち着かない、などです。',
  CANDIDATE_NOT_FOUND: '対象の操作の候補の画面を読みましたが、同じ候補がありませんでした。',
  CANDIDATE_NOT_READ: '対象の操作の候補が、今は見るだけの操作に分けられていません。',
  SECRET_LIKE_PARAMETER: '送る値に、秘密に見える名前の欄があります。',
  // T27R-fix-1（DEF-088）: 保存の後に残った定義も、実行の前の確かめで止める。
  PARAMETER_DANGEROUS_WORD: '送る値の名前か値に、危険な語（削除、取り消し、一括、無効、delete、cancel など）があったため、読みませんでした。',
  // CCX-10: 保存の後に、欄が見えなくなった・読み取り専用になった・無効になった（実行の前の確かめ直しで止めた）。
  PARAMETER_NOT_SENDABLE: '送る値の欄が、今の画面では値を送れない欄（見えない、変えられない、使えない、パスワード、ファイル）になっていました。',
  URL_NOT_BUILT: '読むページのアドレスを組み立てられませんでした。送信先が候補のサイトの外になる、アドレスの後ろを開始のアドレスのサイトで組み立てられない、長さの上限、などです。',
  REQUEST_POLICY: '読まないページ、危険な語、点検してよいサイトのアドレス、ログインの画面の決まりに当たったため、止めました。',
  NAVIGATION_FAILED: '読んだページの読み込みが失敗しました（時間切れ、接続の失敗、外のサイトへの移動を止めた、など）。',
  HTTP_ERROR_STATUS: '読んだページで、サイトがエラーを返しました。',
  RESULT_PAGE_UNREADABLE: '読んだページは読み込めましたが、結果の画面の形を読めませんでした。',
  SESSION_LOST: '読んだページの読み込みで、ログインが切れていました（ブラウザに残るログインの印が消えた場合を含みます）。',
  // T37d（Task 37 の設計書 3.5）: 読んで照らしたが、監査の段の事実で判定しなかった（照らした結果に関係なく判定できない）。
  SERVICE_READ_REFUSED:
    '読む間に、通ってよい外のサイトへの見るだけの要求を上限で止めたか、外のサイトがログインしている状態を受け付けませんでした。画面がデータを描けなかったかもしれないため、照らした結果に関係なく判定していません。',
  AUDIT_STAGE_REQUEST_BLOCKED:
    '読む間に、登録した見るだけの手続きの呼び出しを回数の上限か送り方で止めたか、外のサイトへの見るだけでない要求（登録していない手続きの呼び出しなど）を止めました。画面がデータを描けなかったかもしれないため、照らした結果に関係なく判定していません。',
} as const satisfies Record<string, string>);

/** 期待と照らせなかった理由（`READ_EXPECTATION_UNDETERMINED_REASONS`）の説明。 */
export const READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS = deepFreeze({
  STRUCTURE_NOT_FOUND: '数える表・一覧か、項目と値の並び（詳細）が、画面の主な所にありません。',
  STRUCTURE_AMBIGUOUS: '数える表・一覧が 2 つ以上あるか、同じ名前の詳細の項目が 2 つ以上あり、どれを照らすか決められません。',
  STRUCTURE_LIMIT_REACHED: '読む上限（部品や表の数、文字の長さ）に達し、読み切れませんでした。',
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
    discovery: '操作さがし',
  },
  profileDetail: {
    openDiscovery: '操作さがしの結果を見る',
    openReadChecks: '見るだけの確かめを開く',
  },
  guidance: 'BeakSight がログインしてから、ログインの設定の読む範囲の管理画面を見るだけで、フォームとボタンを集めて分けます。送信や書き込みはしません。読み込みの間隔とページの上限は、設定のファイルの値です。',
  submit: '操作さがしを始める',
  submitting: '始めています…',
  cannotStartHeading: 'このサイトでは、今は操作さがしを始められません',
  rejectedHeading: '操作さがしの作業を始められませんでした',
  notEligible: '操作さがしは、点検のしかたが「ログインして見るだけの点検」か「書き込みも試す点検」のサイトだけで行えます。',
  latestHeading: '前回の操作さがし',
  noDiscovery: 'まだ操作さがしの記録はありません。「操作さがしを始める」から始めます。',
  pagesRead: '読んだ画面',
  unreadReasonsHeading: '読まなかった理由',
  incompletePagesHeading: '読み切れなかった画面',
  noCandidates: '操作の候補はありません。',
  noAction: 'なし（フォームの外のボタン）',
  // T27R-fix-1（DEF-086）: 候補はボタンの文言を持たず、文言が当たった分類の語だけを持つ。
  submitterWords: 'ボタンの分類の語',
  /** ボタンの分類の語の表示（一覧の区切りで並べる。0 件なら「分類の語なし」）。 */
  submitterWordsValue: (words: readonly string[]): string => (words.length === 0 ? '分類の語なし' : listText(words)),
  flags: {
    required: '必須',
    readonly: '変えられない',
    disabled: '使えない',
    hidden: '見えない',
  },
  noFlags: 'なし',
  noConstraints: 'なし',
  /** ジョブの画面の、発見と READ の確かめのジョブの欄（進み具合を送らない。T27d の申し送り 5）。 */
  job: {
    openDiscovery: '操作さがしの結果を見る',
    openReadChecks: '見るだけの確かめの結果を開く',
    downloadDiscoveryJson: 'discovery.json をダウンロードする',
    downloadReadEvidenceJson: 'read-evidence.json をダウンロードする',
  },
} as const);

/** ローカルの管理画面の、READ の確かめの画面の文言（Task 27 の設計書 4.5、4.7。T27f）。 */
export const LOCAL_UI_READ_CHECK_TEXT = deepFreeze({
  pages: {
    readChecks: '見るだけの確かめ',
    newReadCheck: '見るだけの確かめを作る',
    editReadCheck: '見るだけの確かめを変える',
  },
  guidance: 'BeakSight がログインしてから、保存した見るだけの確かめを 1 つずつ行います。候補を読むものは、送る値でページのアドレスを組み立てて読みます。画面を読むものは、その画面を読みます。どちらも、結果をあるはずのものと照らします。フォームの送信や書き込みはしません。',
  valuesNote: '送る値は、テスト用のサイトのテスト用の値だけにしてください。値は管理データにそのまま保存し、この画面に表示します。秘密に見える名前の欄には、値を送りません。',
  submit: '見るだけの確かめを始める',
  submitting: '始めています…',
  cannotStartHeading: 'このサイトでは、今は見るだけの確かめを始められません',
  rejectedHeading: '見るだけの確かめを始められませんでした',
  notEligible: '見るだけの確かめは、点検のしかたが「ログインして見るだけの点検」か「書き込みも試す点検」のサイトだけで行えます。',
  retired: '取り消したサイトでは、見るだけの確かめを作ったり変えたりできません。',
  definitionsHeading: '保存した確かめ',
  noDefinitions: 'まだ見るだけの確かめはありません。下の「見るだけの操作の候補」から作るか、「画面の読み方を決める」から作ります。',
  definitionCount: (countText: string, maxText: string): string => `${countText}（上限 ${maxText}）`,
  candidatesHeading: '見るだけの操作の候補',
  candidatesNote: '前回の操作さがしの結果のうち、見るだけの確かめに使える候補です。',
  noCandidates: '見るだけの確かめに使える候補はありません。先に操作さがしを行ってください。',
  candidateMissing: '対象の操作の候補が、前回の操作さがしの結果にありません。この見るだけの確かめは変えられません（削除はできます）。',
  columns: {
    page: '画面',
    action: '送信先',
    submitterWords: 'ボタンの分類の語',
    parameters: '送る値',
    expectations: 'あるはずのもの',
    updatedAt: '最後に変えた日時',
    operations: '操作',
  },
  noParameters: 'なし',
  create: 'この候補で作る',
  edit: '変える',
  remove: '削除',
  formHeading: '確かめの中身',
  parametersHeading: '送る値',
  parametersNote: '値を入れた欄だけを送ります。空の欄は送りません。値を送れるのは、見えていて、読み取り専用でも無効でもない欄だけです（パスワードとファイルの欄は送りません）。',
  noSendableFields: 'この候補には、値を送れる欄がありません（送る値なしで読みます）。',
  optionsHint: (valuesText: string): string => `選べる値: ${valuesText}`,
  secretLikeHint: '秘密に見える名前の欄です。値を入れても送れません（保存のときに拒みます）。',
  expectationsHeading: 'あるはずのもの',
  /** 期待の数の説明（`maxText` は `formatCount` の結果（単位つき））。 */
  expectationsNote: (maxText: string): string => `1 件以上、${maxText}まで。あるはずのものがすべて合うと「一致」になります。`,
  expectationKind: '確かめる中身の種類',
  expectationCount: '行の数',
  expectationText: '含む文',
  expectationField: '詳細の項目の名前',
  expectationValue: '詳細の項目の値',
  addExpectation: 'あるはずのものを足す',
  removeExpectation: 'この項目を外す',
  expectationNumber: (numberText: string): string => `あるはずのもの ${numberText}`,
  save: '保存する',
  saving: '保存しています…',
  saved: '保存しました。',
  removed: '削除しました。',
  saveRejectedHeading: '保存できませんでした',
  removeRejectedHeading: '削除できませんでした',
  removeDialog: {
    title: 'この見るだけの確かめを削除しますか',
    body: '一覧から外し、見るだけの確かめで読まないようにします。前の結果の記録は残ります。元に戻すときは、作り直してください。',
    confirm: '削除する',
    cancel: 'やめる',
  },
  resultsHeading: '結果',
  noResults: 'まだ結果はありません。',
  resultsJob: (jobText: string): string => `${jobText} の作業`,
  endReason: '終わり方',
  recordedAt: '記録した日時',
  openEvidence: 'read-evidence.json をダウンロードする',
  evidenceUnavailable: 'この作業の結果のファイル（read-evidence.json）を読めないため、詳しい理由と、あるはずのものごとの結果は示せません。',
  resultColumns: {
    definition: '確かめ',
    revision: '何回目の変更か',
    result: '結果',
    detail: '詳しい理由',
    httpStatus: 'サイトの返事の番号',
    expectations: 'あるはずのものごとの結果',
  },
  notExecuted: '確かめなかったもの',
  observedRowCount: (countText: string, sourceText: string): string => `数えた行 ${countText}（${sourceText}）`,
  found: '含んでいた',
  notFound: '含んでいなかった',
  observedValue: (valueText: string): string => `取れた値: ${valueText}`,
  observedNone: '取れた値なし',
  definitionRemoved: '削除した確かめ',
  /** T37d（Task 37 の設計書 3.5）: 画面の path を読む定義。 */
  page: {
    targetHeading: '読む対象',
    pagePath: '画面のアドレスの後ろ',
    pagePathHint: '開始のアドレスと同じサイトの画面の、アドレスの後ろです。/ で始まり、? と # を含まない、ブラウザのアドレス欄に出る形で入れてください。',
    /** T38f: `{id}` つきの画面の path の型の案内（`placeholder` は型の印。API のシナリオの照合の READ に使える）。 */
    pageTemplateHint: (placeholder: string): string =>
      `アドレスの後ろの / で区切った 1 つを ${placeholder} にすると、画面を通さずに送る書き込みの手順の答え合わせに使えます。${placeholder} には、作ったデータの一覧にある、登録したデータの番号が入ります。区切りの全体を ${placeholder} にし、1 つだけ置いてください。この形のものは、見るだけの確かめとしては単独で読みません。`,
    choosePath: '前回の操作さがしで読んだ画面から選ぶ',
    chooseNone: '選ばない（入力する）',
    noPagePaths: '前回の操作さがしの結果を読めないため、選べる一覧はありません。アドレスの後ろを入れてください。',
    note: '画面を読むものは、その画面を 1 回読み込み、データが描かれて落ち着いてから、あるはずのものと照らします。値は送りません。読む間に、外のサイトへの見るだけの要求を止めたり、外のサイトに断られたりしたときは、「判定できない」になります。',
    candidateNote: '候補を読むものは、見るだけの確かめの画面の「見るだけの操作の候補」の一覧から、候補を選んで作ります。',
    chooseCandidate: '候補を選ぶ',
    create: '画面の読み方を決める',
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
    description: '書き込みの手順の中身の形が正しくありません。項目の過不足、値の形、件数と長さの上限、重複、上限と期限の最小、などです。保存していません。',
    action: '画面を読み込み直して、入力を見直してから、もう一度保存してください。',
  },
  SCENARIO_CANDIDATE_UNKNOWN: {
    description: '対象の操作の候補が、前回の操作さがしの結果にありません。保存していません。',
    action: '操作さがしをもう一度行い、今の候補から作り直してください。',
  },
  SCENARIO_CANDIDATE_NOT_WRITABLE: {
    description: '対象の操作の候補は、新しく登録か更新に分けられていません。書き込みの手順は、新しく登録か更新の候補からだけ作れます。保存していません。',
    action: '新しく登録か更新に分けられた候補を選んでください。',
  },
  SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED: {
    description:
      '対象の操作の候補の送り方が、書き込みの手順で扱う形ではありません。扱えるのは、送信先と送る中身の形がある、送る通信のフォームだけです（送り方の上書きは、更新の送り方だけ）。保存していません。',
    action: 'この候補は、書き込みの手順にできません。',
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
      '登録の画面に、送る欄に選んでいない、見えていて操作できる選択の欄（プルダウンなど）・スライダー・色の欄があります。選ばないと、ブラウザが画面の既定の値で送るので、送る前に中身を確かめられません。保存していません。',
    action: 'その欄を、送る欄に選んでください。',
  },
  SCENARIO_FIELD_NOT_ALLOWED: {
    description:
      '値を送れるのは、対象の操作の候補の欄のうち、見えていて、使えて、変えられる欄だけです。パスワードとファイルの欄と、送り方を上書きする欄（_method）は送りません。保存していません。',
    action: '前回の操作さがしの結果で欄が変わっていないかを確かめ、送れる欄だけを選んでください。',
  },
  // T31b（Task 31 の設計書 3 章の「UPDATE の指定」）: UPDATE の指定の理由（文言の確かめは T31h）。
  SCENARIO_UPDATE_SPEC_MISSING: {
    description: '更新する書き込みの手順には、更新の指定（参照する作ったデータの一覧、アドレスの形、保つ欄）が要ります。保存していません。',
    action: '更新の指定を入れてから、もう一度保存してください。',
  },
  SCENARIO_UPDATE_SPEC_NOT_ALLOWED: {
    description: '新しく登録する書き込みの手順は、更新の指定を持てません。保存していません。',
    action: '更新の指定を外してから、もう一度保存してください。',
  },
  SCENARIO_UPDATE_TARGET_NOT_FOUND: {
    description: '作ったデータの一覧として選んだ書き込みの手順が、このサイトにありません。保存していません。',
    action: '画面を読み込み直して、このサイトの、新しく登録する書き込みの手順から選び直してください。',
  },
  SCENARIO_UPDATE_TARGET_NOT_CREATE: {
    description: '作ったデータの一覧には、この手順とは別の、新しく登録する書き込みの手順だけを選べます。保存していません。',
    action: '新しく登録する書き込みの手順から選び直してください。',
  },
  SCENARIO_UPDATE_PATH_MISMATCH: {
    description: 'アドレスの形の {id} に候補の画面の値を入れても、更新の画面と送信先の、両方のアドレスの後ろに同じ値で戻りません。保存していません。',
    action: '候補の更新の画面と送信先のアドレスの後ろを確かめて、データの番号の位置だけを {id} にしてください。',
  },
  SCENARIO_UPDATE_RECORD_ID_UNSAFE: {
    description: 'アドレスの形の {id} の位置の値が、データの番号として受ける形ではありません。保存していません。',
    action: 'データの番号の位置を確かめて、アドレスの形を直してください。',
  },
  // T31R-fix-1 の I-2。
  SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID: {
    description: 'アドレスの形の {id} の位置が、作ったデータの一覧（参照した登録の手順）での、登録したデータの番号の取り方に合いません。番号をアドレスの形から取るときは、{id} の前の区切りが同じである必要があります。番号を画面の部品から取るときは、{id} が送信先の最後の区切りである必要があります。保存していません。',
    action: '作ったデータの一覧の番号の取り方に合うアドレスの形（同じ種類のデータの番号の区切り）を選んでください。',
  },
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD: {
    description: '更新の画面に、秘密に見える名前の見える欄があります。値を読めないので、この画面は更新に使えません。保存していません。',
    action: 'テスト用のサイトの画面の欄を確かめてください。この画面では、更新する書き込みの手順を作れません。',
  },
  // T31e fix round 1（文言の確かめは T31h）。
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD: {
    description: '更新の画面に、状態を表す名前で、秘密にも見える名前の、隠れた欄か変えられない欄があります。値を読めず、更新の前と後で照らせないので、この画面は更新に使えません。保存していません。',
    action: 'テスト用のサイトの画面の欄を確かめてください。この画面では、更新する書き込みの手順を作れません。',
  },
  SCENARIO_STATE_FIELD_NOT_CHANGEABLE: {
    description: '状態の欄（有効・無効、公開、削除の印など）は、変える欄にできません（保つ欄だけにできます）。保存していません。',
    action: 'その欄を、変える欄から保つ欄に移してください。',
  },
  // T31R2-fix-1（DEF-108 の残り）。
  SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD: {
    description: 'この画面には、秘密に見える名前の、隠れた欄か変えられない欄があります（ページが作る、なりすまし防止の値などの欄のほかに）。値を読めず、送る中身を照らせないので、この画面には書き込めません。保存していません。',
    action: 'テスト用のサイトの画面から、その欄をなくすか、名前を変えてから、操作さがしをやり直してください。',
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
    description: '更新する書き込みの手順には、変える欄が 1 つ以上要ります。保存していません。',
    action: '変える欄を 1 つ以上選んでください。',
  },
  SCENARIO_READ_CHECK_NOT_FOUND: {
    description: '照らす見るだけの確かめが、このサイトにありません。保存していません。',
    action: '画面を読み込み直して、今の見るだけの確かめから選び直してください。',
  },
  SCENARIO_READ_CHECK_CANCELED: {
    description: '照らす見るだけの確かめは、削除されています。保存していません。',
    action: '画面を読み込み直して、今の見るだけの確かめから選び直してください。',
  },
  SCENARIO_READ_CHECK_REVISION_MISMATCH: {
    description: '照らす見るだけの確かめが、この画面を開いた後に変わりました。保存していません。',
    action: '画面を読み込み直して、もう一度選び直してください。',
  },
  // T30a（Task 30 の設計書 3 章の「検証の指定」）: 検証の指定の理由。
  SCENARIO_VERIFICATION_PARAMETER_UNKNOWN: {
    description: '答え合わせの見るだけの確かめで、BeakSight が作った値に結び付けた送る値が、その見るだけの確かめの今の中身にありません。保存していません。',
    action: '見るだけの確かめの送る値の名前を確かめて、結び付けを直してから、もう一度保存してください。',
  },
  SCENARIO_VERIFICATION_FIELD_NOT_SENT: {
    description: '答え合わせの見るだけの確かめの結び付けか、あるはずのものに使った欄が、書き込みの手順の送る欄にありません（BeakSight が作った値がありません）。保存していません。',
    action: '送る欄に加えるか、答え合わせの見るだけの確かめの欄を直してから、もう一度保存してください。',
  },
  SCENARIO_LIMIT_ABOVE_DEFAULT: {
    description: '上限が、既定の件数を超えています。書き込みの手順の上限は、既定以下だけにできます。保存していません。',
    action: '上限を、欄の説明にある既定以下にしてください。',
  },
  SCENARIO_LIMIT_INCONSISTENT: {
    description: '1 回の点検の上限が、合計の上限を超えています。保存していません。',
    action: '1 回の点検の上限を、合計の上限以下にしてください。',
  },
  SCENARIO_TTL_ABOVE_DEFAULT: {
    description: '書き込みの OK の期限の日数が、既定の日数を超えています。保存していません。',
    action: '期限の日数を、欄の説明にある既定以下にしてください。',
  },
  // T37d fix round 1: 書き込みの照合の READ に、画面の path を読む定義は使わない。
  SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET: {
    description: '答え合わせに選んだ見るだけの確かめは、画面を読むものです。書き込みの答え合わせには、見るだけの操作の候補を読むものだけを使えます。保存していません。',
    action: '答え合わせには、候補を読む見るだけの確かめを選んでください。',
  },
  // T38b（Task 38 の設計書 3.2）: API で送るシナリオの下書き。
  SCENARIO_API_CANDIDATE_NOT_API: {
    description: '対象の操作の候補は、送らずに観察した送り方が、画面を通さない送信の登録・更新ではないか、観察の記録（入れた欄と値の形）がありません。保存していません。',
    action: '操作さがしをもう一度行い、送り方が画面を通さない送信の登録・更新の候補から作ってください。',
  },
  SCENARIO_API_STATE_KEY: {
    description: '送る中身に、削除の印にあたる状態の項目があります。画面を通さずに送る書き込みの手順にはできません。保存していません。',
    action: '状態を変えない画面のボタンから作ってください。',
  },
  SCENARIO_API_METHOD_OVERRIDE: {
    description: '送る中身が、送り方を上書きしています（_method の項目）。保存していません。',
    action: '送り方を上書きしない画面のボタンから作ってください。',
  },
  SCENARIO_API_HEADER_METHOD_OVERRIDE: {
    description: 'ページが送信に添える情報に、送り方を上書きする名前があります。保存していません。',
    action: '送り方を上書きしない画面のボタンから作ってください。',
  },
  SCENARIO_API_ORIGIN_NOT_APPROVED: {
    description: '送り先のサイトのアドレスが、このサイトの「ログインのときに通ってよい外のサイトのアドレス」にありません。保存していません。',
    action: 'サイトの設定の「ログインのときに通ってよい外のサイトのアドレス」を確かめ、必要なら操作さがしをやり直してください。',
  },
  SCENARIO_API_SHAPE_NOT_EXECUTABLE: {
    description: '送る要求の形を確かめ直すと、登録・更新の形ではありませんでした（削除、上書き、一括、更新する行を選ぶ条件の不備など）。保存していません。',
    action: '操作さがしをやり直し、登録・更新の形の候補から作ってください。',
  },
  SCENARIO_API_FIELD_KEY_MISMATCH: {
    description: '送る項目と画面の欄が 1 対 1 で対応していません（欄のない項目を送る、同じ欄が 2 つの項目に対応する、欄のある項目を送らない、など）。保存していません。',
    action: '欄に対応する項目をすべて、ちょうど 1 回ずつ送る項目に選んでください。',
  },
  SCENARIO_API_FIELD_TYPE_MISMATCH: {
    description: '欄の種類と、送る中身の値の形が合いません（数の欄の値を文字で送る、など）。保存していません。',
    action: 'この候補は、画面を通さずに送る書き込みの手順にできません。画面の作りを確かめてください。',
  },
  SCENARIO_API_KEY_NOT_ALLOWED: {
    description: '欄に対応しない項目が、ページが決める項目の一覧にないか、一覧の名前が欄のない項目ではありません。保存していません。',
    action: 'ページが決める項目（例: 会社や店ごとの番号）を、名前を確かめて一覧に入れてください。値は照らさず、書き込んだときの値を記録に残します。',
  },
  SCENARIO_API_PAGE_KEY_SECRET_LIKE: {
    description: '秘密に見える名前の項目は、ページが決める項目にできません。保存していません。',
    action: 'この候補は、画面を通さずに送る書き込みの手順にできません。',
  },
  SCENARIO_API_FILTER_MISMATCH: {
    description: '更新する行を選ぶ条件の名前が、送る要求のものと違います（登録には、この条件はありません）。保存していません。',
    action: '要求の形に出ている、行を選ぶ条件の名前を確かめて入れてください。',
  },
  // T38c（T38b の報告の (2)）: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う。
  SCENARIO_API_DISCOVERY_PROFILE_STALE: {
    description: 'この候補を見つけた操作さがしの後に、サイトの設定を変えました（要求の送り先の確かめが、今の設定と合いません）。保存していません。',
    action: '操作さがしをもう一度行ってから、書き込みの手順を作り直してください。',
  },
  // T38R-fix の I-2: ページが決める鍵の JSON の型、登録の ID を読む応答の鍵の名前。
  SCENARIO_API_PAGE_KEY_NOT_SCALAR: {
    description: 'この項目は、値が、中に項目を持つまとまりか並びです。中の値を照らせないため、ページが決める項目は、値が文字・数・はい/いいえ・空の項目だけにできます。保存していません。',
    action: 'この項目を、ページが決める項目から外してください。外せない場合は、この候補では書き込みの手順を作れません。',
  },
  SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE: {
    description: '登録したデータの番号を読む、サイトの返事の項目の名前が、秘密に見えます。値を照らさない項目に、秘密を運ばせないためです。保存していません。',
    action: '番号の項目を別の項目にするか、空にして、書き込みの後の確かめ方にある、番号の取り方を使ってください。',
  },
  // T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2）: API のシナリオの照合の READ。T40R2-fix: 画面から取る登録の ID の型は拒まず、注意
  // （`LOCAL_UI_WRITE_TEXT.recordIdPatternCaution`）にした。
  SCENARIO_API_READ_VERIFICATION_NOT_BOUND: {
    description: '答え合わせに使う、画面を読む見るだけの確かめ（{id} の形）のあるはずのものが、行の数だけです。登録した値と比べるものがないと、別の画面を読んでも一致しうるので、答え合わせに使えません。保存していません。',
    action: 'あるはずのものに「本文が含む」か「詳細の項目の値」を足し、比べる値に送る欄を選んでください。',
  },
  // T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵。ユーザーの判断 2）: API の更新のページが決める鍵と、台帳の ID と filter の結び付け。
  SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE: {
    description: 'この項目は、ページが値を決める項目ですが、更新の画面の欄として見分けられません。更新では、送る前の値と照らせる項目（画面の選択の欄など）だけを許します。保存していません。',
    action: 'この項目を、ページが決める項目から外してください。外せない場合は、この画面では、画面を通さずに送る更新の手順を作れません。',
  },
  SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID: {
    description: '作ったデータの一覧（参照した登録の手順）の番号で、更新する行を選べるか分かりません。登録が画面を通さずに送るものでない、登録と更新の送り先（サイトのアドレスとアドレスの後ろ）が違う（別の表）、または登録したデータの番号を読む返事の項目の名前が、行を選ぶ条件の名前と違います。保存していません。',
    action: '同じ送り先（同じ表）に画面を通さずに登録し、返事の項目の名前が行を選ぶ条件の名前と同じ登録の手順を、作ったデータの一覧に選んでください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * シナリオの画面の要求（作成・変更・承認・撤回）を拒む理由ごとの説明と手順。理由の一覧は、保存の部品の
 * `SCENARIO_STORE_REJECTION_REASONS`（`src/control/approval/scenario-store.ts`）と、画面のサーバの理由
 * （`apps/local-ui/src/server/scenario-facts.ts` の `SCENARIO_REQUEST_LOCAL_REJECTION_REASONS`）。
 */
export const SCENARIO_REQUEST_REJECTION_DESCRIPTIONS = deepFreeze({
  SCENARIO_PROFILE_NOT_FOUND: {
    description: '対象のサイトが見つかりません。何も変えていません。',
    action: 'サイトの一覧を読み込み直して、対象を確かめてください。',
  },
  SCENARIO_PROFILE_RETIRED: {
    description: '取り消したサイトでは、書き込みの手順を作ったり変えたりできません。何も変えていません。',
    action: '使い続ける場合は、新しい名前でサイトを足し直してください。',
  },
  SCENARIO_MODE_NOT_WRITE: {
    description: '書き込みの手順は、点検のしかたが「書き込みも試す点検」のサイトだけで使えます。何も変えていません。',
    action: 'テスト用のサイトのうち、点検のしかたが「書き込みも試す点検」のもので作ってください。',
  },
  SCENARIO_DISCOVERY_NOT_LATEST: {
    description: '前回の操作さがしの結果を読めないか、まだ操作さがしの記録がありません。保存していません。',
    action: '操作さがしを行ってから、もう一度保存してください。',
  },
  SCENARIO_CANDIDATE_NOT_FOUND: {
    description:
      '対象の操作の候補が、前回の操作さがしの結果にないか、そこで確かめられません（消えた、読み直していない、欄の決まりか分類が変わった）。保存していません。',
    action: '操作さがしをもう一度行い、今の候補から作り直してください。',
  },
  SCENARIO_DRAFT_INVALID: {
    description: '入力に誤りがあります。保存していません。',
    action: '項目ごとの理由を見て直してから、もう一度保存してください。',
  },
  SCENARIO_NOT_FOUND: {
    description: '対象の書き込みの手順が見つかりません。何も変えていません。',
    action: '書き込みの手順の一覧を読み込み直して、対象を確かめてください。',
  },
  SCENARIO_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、この書き込みの手順が変わりました。何も変えていません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度操作してください。',
  },
  SCENARIO_APPROVAL_DIGEST_MISMATCH: {
    description: '画面が古いため、書き込みの OK を出していません。この画面を開いた後に、OK の対象の内容が変わりました。',
    action: '画面を読み込み直して、今の内容と変わった所を確かめてから、もう一度書き込みの OK を出してください。',
  },
  SCENARIO_SIDE_EFFECTS_UNCONFIRMED: {
    description: 'ほかへの影響の確認に、まだ確かめていない項目があります。書き込みの OK を出していません。',
    // MI-8（設計書 4.9。MI-6 で副作用の確認は承認のダイアログの 1 回になった）: シナリオの画面にはチェックがない。
    action: '画面を読み込み直してから「書き込みの OK を出す」を押してください。確認のダイアログで 4 項目の中身を読んで、「書き込みの OK を出す」を押してください。',
  },
  SCENARIO_NOT_APPROVABLE: {
    description: '今の状態では、書き込みの OK を出せません。OK を出していません。',
    action: '理由を見て、操作の候補、照らす見るだけの確かめ、サイトの設定を確かめてください。候補が変わったときは、操作さがしをもう一度行い、作り直してください。',
  },
  SCENARIO_NOT_APPROVED: {
    description: '取り消す書き込みの OK がありません（OK を出していないか、もう取り消しています）。何も変えていません。',
    action: '画面を読み込み直して、今の状態を確かめてください。',
  },
  SCENARIO_FACTS_CHANGED: {
    description: '確かめている間に、操作さがしの結果が記録されました。何も変えていません。',
    action: '画面を読み込み直してから、もう一度操作してください。',
  },
  SCENARIO_INPUT_RULES_NOT_LATEST: {
    description: '付けようとした入れる値の決まりが、この書き込みの手順の、いちばん新しい決まりではありません。書き込みの手順は変えていません。',
    action: '入れる値の決まりの画面を読み込み直して、いちばん新しい中身を確かめてから、もう一度保存してください。',
  },
  SCENARIO_FACTS_UNAVAILABLE: {
    description: 'サイトが指す設定のファイルか、保存した ID とパスワードの記録を読めないため、書き込みの OK の状態を確かめられません。OK を出すことも取り消すこともしていません。',
    action: '設定のファイルの場所と中身を確かめてから、もう一度操作してください。自動ログインなら、ID とパスワードの画面も確かめてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** 承認のダイアログの取り消しのボタンの文言（PL-S: 副作用の 4 つの約束の説明が、このボタンの名前を引く）。 */
const APPROVE_DIALOG_CANCEL_LABEL = 'やめる';

/** ローカルの管理画面の、シナリオの画面の文言（Task 28 の設計書 4.6。T28e）。 */
export const LOCAL_UI_SCENARIO_TEXT = deepFreeze({
  pages: {
    scenarios: '書き込みの手順',
    newScenario: '書き込みの手順を作る',
    scenario: '書き込みの手順の詳細',
    editScenario: '書き込みの手順を変える',
  },
  notEligible: '書き込みの手順は、書き込みも試す点検のサイトだけで使えます。',
  retired: '取り消したサイトでは、書き込みの手順を作ったり、変えたり、書き込みの OK を出したりできません。記録は見られます。',
  noExecution:
    'この画面からは、書き込みをしません。書き込みの OK は、書き込んでよい条件（何回目の変更か、件数の上限、期限、ほかへの影響の確認、結果の確かめ方）を記録するだけです。書き込みは、OK を出した後に、「書き込みを始める」の画面から人が始めます。',
  listHeading: '書き込みの手順',
  // PL-U（設計書 14.1 の U4）: 0 件の一覧にも主のボタン「書き込みの手順を作る」を置くので、ほかの画面へは案内しない。
  noScenarios: 'まだ書き込みの手順はありません。',
  /** PL-U（14.1 の U4）: 0 件の一覧で、使える操作さがしの結果がないとき（主のボタンは、操作さがしを始める）。 */
  emptyListStartDiscovery: '次は「書き込みの手順を作る」を押します。先に、書き込める操作をさがします。まだ何も書き込みません。',
  columns: {
    kind: '種類',
    page: '画面',
    state: '状態',
    expiresAt: '書き込みの OK の期限',
    limits: '上限と使った件数',
    revision: '何回目の変更か',
    operations: '操作',
    /** T29e: 入力の規則の状態。 */
    inputRules: '入れる値の決まり',
  },
  /** 上限と使った件数（`perRunText`・`usedText`・`cumulativeText` は `formatCount` の結果）。 */
  limitsValue: (perRunText: string, usedText: string, cumulativeText: string): string =>
    `1 回に ${perRunText}・合計 ${usedText} / ${cumulativeText}`,
  usedNote: '使った件数は、送る前に取り置いた件数・送った件数・送ったか分からない件数の合計です。送る前に取り置きを戻した件数は数えません。',
  /** シナリオの版の表示（`revisionText` は `formatInteger` の結果）。 */
  revisionValue: (revisionText: string): string => `${revisionText} 回目の変更`,
  noExpiry: 'なし（書き込みの OK を出していません）',
  open: '開く',
  factsUnavailable: 'サイトが使う設定のファイルか、保存した ID とパスワードが何回目の変更かを読めないため、書き込みの OK の状態を確かめられません。',
  // 作成と変更のフォーム。
  targetHeading: '対象の候補',
  formHeading: '内容',
  fieldsHeading: '送る欄',
  fieldsNote:
    '値を送る欄を選びます。選べるのは、操作の候補の欄のうち、見えていて、変えられて、使える状態の欄だけです。名前が秘密に見える欄と、危ない語の欄は選べません（理由を出します）。送る値の作り方（入れる値の決まり）は、保存した後に、書き込みの手順の詳細の「入れる値の決まりを開く」から決めます。',
  noFields: '値を送れる欄はありません。',
  limitsHeading: '上限',
  perRunLimit: '1 回に書き込む件数の上限（件）',
  cumulativeLimit: '合計の件数の上限（件）',
  /** 上限の欄の説明（`minText`・`maxText` は `formatCount` の結果）。 */
  limitHint: (minText: string, maxText: string): string => `${minText}以上、最初から決まっている上限の ${maxText}以下にします。`,
  ttl: '書き込みの OK の期限（日）',
  /** 期限の欄の説明（`minText`・`maxText` は `formatInteger` の結果）。 */
  ttlHint: (minText: string, maxText: string): string => `書き込みの OK を出してから期限までの日数です。${minText} 日以上、最初から決まっている上限の ${maxText} 日以下にします。`,
  /**
   * MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6、ユーザーの判断 2）: 決まった値の欄（入力の欄でなく表示だけ）と、たたんだ詳しい設定の
   * 説明（`countText` は `formatCount` の結果）。
   */
  perRunLimitValue: (countText: string): string => `${countText}（決まった値です）`,
  advancedLimitsNote: '合計の件数の上限と書き込みの OK の期限は、最初の値のままで保存できます。変えるときだけ開いてください。',
  /** MI-6: 既定の値が分からない欄（保存の確かめが送る欄にすることを求める欄）の印。 */
  mustSendHint: '最初に入っている値が分からない欄なので、必ず送ります。',
  save: '保存する',
  saving: '保存しています…',
  saved: '保存しました。',
  saveRejectedHeading: '保存できませんでした',
  /** T38c（Task 38 の設計書 3.3）: API のシナリオの要求の型の要約（承認の画面と詳細。値は持たない）。 */
  api: {
    method: '通信の種類',
    origin: '送り先のサイトのアドレス',
    pathShape: 'アドレスの形',
    keyFields: '本文の項目と欄',
    pageKeys: 'ページが決める項目',
    none: 'なし',
    /** 鍵と欄の 1 件（`fieldText` は欄の名前か CSS）。 */
    keyField: (key: string, type: string, fieldText: string): string => `${key}（JSON の ${type}）← 欄 ${fieldText}`,
    /** ページが決める鍵の 1 件。 */
    pageKey: (key: string, type: string): string => `${key}（JSON の ${type}。値は照らしません）`,
    /** 欄の識別（名前か CSS）。 */
    fieldName: (name: string): string => `名前 ${name}`,
    fieldSelector: (selector: string): string => `部品の目印 ${selector}`,
    /** T38f: 送り方と、登録の ID の取り方（応答の本文の鍵）。 */
    transport: '送り方',
    recordId: '登録したデータの ID を読む、応答の項目',
    recordIdUnset: '指定なし（結果の確かめ方で決めた取り方を使います）',
    /** T38f: 作成と変更のフォーム。 */
    formHeading: '画面を通さない送信の形と、送る項目',
    formNote:
      '操作さがしで対象のボタンを押したときに、ページが送ろうとした通信の形から、案を入れています。項目と欄の組み合わせを確かめてください。値は入れません。',
    // MI-6（設計書 4.6）: 登録の送る鍵と、ページが決める鍵と、更新の filter の名前は、1 つの値しか通らないので、表示だけにした。
    keyFieldsNote: '欄に値を入れて送る、本文の項目です。欄と組になる項目は、すべて送ります（決まった値です）。',
    pageKeysNote:
      '欄と組にならず、ページが値を決める本文の項目です。すべて通します（値は照らしません。決まった値です）。名前が秘密に見える項目があると、この書き込みの手順は保存できません（理由を出します）。',
    noPageKeys: 'ページが決める項目はありません。',
    filterNameLabel: '更新する行を選ぶ条件の名前',
    filterNameHint: '更新する行を選ぶ、アドレスの ? の後ろの名前です。通信の形にある条件の名前を使います（決まった値です）。',
    /** MI-6: 送る鍵・許す鍵の印（表示だけ）。 */
    keySent: '送る',
    pageKeyAllowed: '通す',
    ledgerLabel: '作ったデータの一覧（更新するデータを登録した書き込みの手順）',
    ledgerUnset: '選んでいません',
    /** 台帳の選択肢（登録のシナリオの id と、その画面の path）。 */
    ledgerOption: (scenarioId: string, pagePath: string): string => `${scenarioId}（${pagePath}）`,
    // T41e-3（T41R-fix-B）: 台帳にできるのは、同じ送り先（Origin と path の型）の API の登録で、登録の ID が filter に結び付くシナリオだけ。
    noLedgerOptions:
      '作ったデータの一覧にできる、新しく登録する書き込みの手順がありません。使えるのは、この更新と同じ送り先（サイトのアドレスとアドレスの形）に、画面を通さない送信で新しく登録する書き込みの手順だけです。同じ送り先の、新しく登録する書き込みの手順を先に作ってください。そして書き込みをして、答え合わせが合ったデータを作ってください。',
    formPathTemplateLabel: '更新の画面のアドレスの形',
    formPathTemplateHint: '操作の候補の画面のアドレスの後ろで、データの ID の区切りを形の印にしたものです。',
    // MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: 更新の照合の READ を、台帳の登録のシナリオの照合の READ から埋める。PL-5 の 9 の (2):
    // 写すのは保存の口だけ（`update-verification-copy.ts`）。画面は、写すことを 1 行で出す（中身は出さない）。埋められない理由（`ledgerReadUnavailable`）は
    // 閉じた一覧の文言として残す。
    ledgerReadUnavailable: {
      LEDGER_READ_VERIFICATION_MISSING: {
        description: '作ったデータの一覧にした登録の手順に、答え合わせの確かめがありません。そのため、答え合わせの確かめを入れていません。',
        action: '下の答え合わせの確かめで、アドレスの後ろに ID の印がある画面の確かめを選んでください。比べる欄には、変える欄を選んでください。',
      },
      LEDGER_READ_CHECK_UNUSABLE: {
        description: '作ったデータの一覧にした登録の手順の答え合わせの確かめは、取り消したものか、アドレスの後ろに ID の印がある画面の確かめではありません。そのため、この更新には使えず、答え合わせの確かめを入れていません。',
        action: '下の答え合わせの確かめで、アドレスの後ろに ID の印がある画面の確かめを選んでください。比べる欄には、変える欄を選んでください。',
      },
    },
    recordIdKeyLabel: '登録したデータの ID を読む、応答の項目（入れなくてもかまいません）',
    recordIdKeyHint: '登録したときの応答の本文から、登録したデータの ID を読む項目の名前です。空にすると、下の結果の確かめ方で決めた ID の取り方を使います。',
    errorsHeading: '画面を通さない送信の指定を直してください',
    publicationStateKeepHint: '公開の状態にあたる欄です。最初は今の値のまま保ちます（変える欄にすると、入れる値の決まりの値を送ります）。',
  },
  selectedYes: '送る',
  /** T29e: シナリオの詳細から、入力の規則の画面を開く。 */
  openRules: '入れる値の決まりを開く',
  edit: '変える',
  approve: '書き込みの OK を出す',
  revoke: '書き込みの OK を取り消す',
  approved: '書き込みの OK を出しました。',
  revoked: '書き込みの OK を取り消しました。',
  actionRejectedHeading: '操作できませんでした',
  approveDialog: {
    title: 'この書き込みの手順に、書き込みの OK を出しますか',
    body: '下の内容で、この書き込みの手順の今の内容に OK を出します。OK を出しただけでは、書き込みは始まりません。内容が変わると、OK は引き継がれず、もう一度 OK が要ります。',
    sideEffects: 'ほかへの影響の確認',
    /**
     * MI-6: 4 項目の中身と、1 回の押下で確かめたことになること。PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 4）: 過去形でなく、押す前に
     * 4 つとも確かめる形にした。
     */
    sideEffectsNote:
      `次の 4 つの約束を読んでください。4 つとも本当か確かめてから「書き込みの OK を出す」を押してください。1 つでも違えば「${APPROVE_DIALOG_CANCEL_LABEL}」を押してください。まだ確かめた印のない項目があるときは、押すと、確かめた印を付けて変更の回数を 1 つ進め、その内容に OK を出します。`,
    /**
     * PL-S（設計書 9 章の 3）: 何を・どこへ・何件（`placeText` は操作を見つけた画面の path を 1 つ、`countText` は 1 回の Run の件数の `formatInteger` の結果）。
     * 送り方（フォーム・API）によらず同じ文。
     */
    targetCreate: (placeText: string, countText: string): string =>
      `${placeText} の画面で、作り物のデータを ${countText} 件登録します。送ったら取り消せません。`,
    targetUpdate: (placeText: string, countText: string): string =>
      `${placeText} の画面で、作り物のデータで ${countText} 件更新します。送ったら取り消せません。`,
    confirm: '書き込みの OK を出す',
    cancel: APPROVE_DIALOG_CANCEL_LABEL,
  },
  revokeDialog: {
    title: '書き込みの OK を取り消しますか',
    body:
      '最後に出した書き込みの OK を取り消します。取り消すと、まだ使っていない OK は使えなくなり、まだ送っていない件数の取り置きは戻ります。送った書き込みは取り消せません。取り消した記録は残ります。',
    confirm: '取り消す',
    cancel: 'やめる',
  },
  reload: '読み込み直す',
  /**
   * T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」、2 章のユーザーの判断 3・4）: UPDATE の指定の入力と表示。`placeholder` は、path の型の
   * レコードの ID の区切りの印（契約の値。画面に書き写さない）。
   */
  update: {
    heading: '更新の指定',
    note:
      '更新するデータを選ぶ、作ったデータの一覧と、更新の画面と送信先のアドレスの形と、欄ごとの役割（変える・保つ）を決めます。更新するデータは、作ったデータの一覧のうち最新の 1 件を、BeakSight が書き込みを始めるときに選びます（人は ID を入れません）。',
    ledger: '作ったデータの一覧にする、新しく登録する書き込みの手順',
    ledgerHint: '同じサイトの、新しく登録する書き込みの手順を選びます。この手順で BeakSight が登録して、答え合わせをしたデータだけを更新します。',
    noLedger: '作ったデータの一覧にできる、新しく登録する書き込みの手順がありません。先に、新しく登録する操作の候補から、書き込みの手順を作ります。',
    /** 台帳の選択肢（`pathText` は候補の画面の path）。 */
    ledgerOption: (scenarioId: string, pathText: string): string => `${scenarioId}（${pathText}）`,
    templates: 'アドレスの形',
    /** path の型の選択の説明。 */
    templatesHint: (placeholder: string): string =>
      `候補の更新の画面と送信先のアドレスの後ろで、同じ値を持つ区切りから、データの ID の区切りを選びます。選んだ区切りは ${placeholder} になります。`,
    /** 候補の path（`pagePath`・`actionPath` は候補のもの）。 */
    candidatePaths: (pagePath: string, actionPath: string): string => `候補のアドレスの後ろ: 画面 ${pagePath}・送信先 ${actionPath}`,
    /** 型の選択肢（2 つの型と、ID の区切りの値）。 */
    templateOption: (formTemplate: string, actionTemplate: string, recordId: string): string =>
      `画面 ${formTemplate}・送信先 ${actionTemplate}（ID の区切り: ${recordId}）`,
    manualTemplate: '手で入力する',
    noTemplateOption: '候補のアドレスの後ろから、アドレスの形を作れませんでした。形を手で入力します。',
    formPathTemplate: '更新の画面のアドレスの形',
    actionPathTemplate: '送信先のアドレスの形',
    /** 手で入力する型の説明。 */
    manualTemplateHint: (placeholder: string): string =>
      `データの ID の区切りを ${placeholder} にした、アドレスの後ろです。${placeholder} は、ちょうど 1 つ、区切りの全体に書きます。`,
    rolesHeading: '欄の役割',
    rolesNote:
      '見えていて変えられる欄ごとに、値を変えるか、今の値のまま保つかを選びます。最初は「保つ」になっています。状態の欄と、名前が秘密に見える欄は変えられません（理由を出します）。変える欄は 1 つ以上要ります。',
    roleChange: '変える',
    roleKeep: '保つ',
    contactFieldHint:
      'メールアドレスと電話番号の欄は、最初は保ちます。変える欄にすると、作り物の値（example.invalid、090-0XXX-XXXX）を送ります。メールや電話への知らせが外に届かないことの確認が要ります。',
    otherFieldsHeading: '役割のない欄',
    otherFieldsNote: '見えない欄、変えられない欄、使えない状態の欄、送り方を変える欄は、役割を持ちません（ページの値のまま送ります）。',
    noOtherFields: 'ありません。',
    none: 'なし',
    plannedTarget: '更新する予定のデータ',
    noPlannedTarget: '更新できるデータがありません（作ったデータの一覧にした登録の手順で、答え合わせが合った登録がありません）。',
  },
} as const);

/**
 * 入力の規則の判定の細分ごとの説明と手順（Task 29 の設計書 4.1。T29e）。細分の一覧は `src/control/data-rules/rule-contracts.ts` の
 * `NEEDS_RULE_INPUT_DETAILS`・`RULE_CONFLICT_DETAILS`・`EXTERNAL_DELIVERY_BLOCKED_DETAILS`（書き漏れは画面の `catalog-coverage.ts` が型で確かめる）。
 */
export const RULE_PROBLEM_DETAIL_DESCRIPTIONS = deepFreeze({
  NO_RULE: {
    description: 'この欄の値の作り方が決まっていません。',
    action: '値の種類を選ぶか、作り方を「人が入れた値の一覧から」にして値を入れてください。',
  },
  REQUIRED_FIELD_NOT_SELECTED: {
    description: '必ず入れる欄ですが、書き込みの手順の送る欄に選ばれていません。',
    action: '書き込みの手順を変えて、この欄を送る欄に選んでください。',
  },
  SEMANTIC_KIND_UNDECIDED: {
    description: '欄の名前と種類から、値の種類を決められませんでした（当て推量では作りません）。',
    action: '値の種類を選ぶか、人が入れた値の一覧を入れてください。',
  },
  PATTERN_UNSUPPORTED: {
    description: '欄に入れる値の形の決まりが、扱える単純な形（数字の桁数・英数字の長さ・カタカナなど）でないか、作る値が合いません。',
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
    description: '欄の最小・最大・刻みの書き方を扱えません（any、指数の書き方、ありえない日時など）。',
    action: '範囲を人が入れるか、人が入れた値の一覧を使ってください。',
  },
  LENGTH_UNSATISFIABLE: {
    description: '欄の文字数の決まり（いちばん短い長さ・いちばん長い長さ）に合う値を作れません。',
    action: '人が入れた値の一覧で、長さに合う値を入れてください。',
  },
  NO_USABLE_OPTION: {
    description: '選べる選択肢がありません（空の値と、危ない語・使えなくする語（非表示、停止、取消、inactive など）の値を除くと残りません）。',
    action: '人が入れた値の一覧で、使ってよい選択肢の値を入れてください。',
  },
  URL_FIELD: {
    description: 'ページのアドレス（URL）の欄の値は作りません。',
    action: '人が入れた値の一覧で、テスト用のサイトで使ってよいアドレスを入れてください。',
  },
  ADDRESS_FIELD: {
    description: '住所の欄の値は作りません（実在の宛先に届くおそれがあるため）。',
    action: '人が入れた値の一覧で、テスト用のサイトで使ってよい住所を入れてください。',
  },
  PHONE_FORMAT_UNSUPPORTED: {
    description: '欄の決まりに、作り物の電話番号の形（090-0XXX-XXXX、ハイフンなしの 0900XXXXXXX）が合いません。ほかの形には切り替えません。',
    action: 'テスト用のサイトで使ってよい番号（自分たちで管理しているテスト用の回線など）を、人が入れた値の一覧に入れてください。',
  },
  SEMANTIC_KIND_TYPE_MISMATCH: {
    description: '選んだ値の種類が、欄の種類に合いません（メール・電話の欄に使えるのは、メール・電話か固定の一覧だけです）。',
    action: '欄の種類に合う値の種類を選んでください。',
  },
  FIXED_VALUE_VIOLATES_CONSTRAINT: {
    description: '人が入れた値が、欄の種類・選択肢・決まりに合わないか、危ない語か使えなくする語（非表示、停止、取消、inactive など）を含みます（メールは example.invalid の宛先だけ使えます）。',
    action: '欄に合う値に直してください。',
  },
  RANGE_OUTSIDE_FIELD_CONSTRAINT: {
    description: '人が入れた範囲が、欄の最小・最大の外です。',
    action: '欄の範囲の中に直してください。',
  },
  RELATION_FIELD_MISMATCH: {
    description: '欄どうしの関係に使う欄が、送る欄でないか、値の種類が関係の役割に合いません。',
    action: '関係に使う欄と、その欄の値の種類を確かめてください。',
  },
  RELATION_UNSATISFIABLE: {
    description: '欄どうしの関係（終了は開始より後、合計は単価 × 数量）を、範囲の中で満たせません。',
    action: '範囲か関係を直してください。',
  },
  UNIQUE_COMBINATIONS_EXHAUSTED: {
    description: 'ほかと重ならないようにする欄の組を、前に使った組と重ならないように作れません。',
    action: 'ほかと重ならないようにする欄を見直すか、値の一覧を増やしてください。',
  },
  STATE_FIELD_NOT_USABLE: {
    description: '状態の欄（有効・無効・公開・削除など）には値を入れません。',
    action: '書き込みの手順を変えて、この欄を送る欄から外してください。',
  },
  NOTIFICATION_OPT_OUT_UNAVAILABLE: {
    description: '通知・配信を求める欄で、「送らない」側の値が選べません（名前に否定の語がある欄を含む）。',
    action: '送らない側の値を、人が入れた値の一覧で入れるか、書き込みの手順を変えて、この欄を送る欄から外してください。',
  },
  FIELD_NOT_SENDABLE: {
    description: '送る欄が、操作の候補で送れる欄ではありません（見えない、変えられない、使えない状態、パスワード、ファイルなど）。',
    action: '「操作さがしを始める」でもう一度操作さがしをして、書き込みの手順を作り直してください。',
  },
  PAGE_KEY_RULE_NOT_ALLOWED: {
    description: 'この項目は、ページが値を決める項目です（書き込みの OK のときに名前を示した項目）。BeakSight は値を作らないので、決まりを持てません。',
    action: 'この項目の決まりを消してください。値を入れる場合は、欄と組になる項目として、書き込みの手順を作り直してください。',
  },
  JSON_VALUE_TYPE_MISMATCH: {
    description: '決まりが作る値が、項目の JSON の型で送れる形ではありません（数の項目に送れるのは、先頭の 0・小数の末尾の 0・指数の書き方・-0 のない、15 桁までの数だけです）。または、欄の種類と項目の JSON の型の組が合いません。',
    action: '項目の型に合う値か範囲に直してください。組が合わない場合は、「操作さがしを始める」でもう一度操作さがしをして、書き込みの手順を作り直してください。',
  },
  // MI-F4（MI-6 の後の流れ）: 副作用の確認は、シナリオの画面でなく、承認のダイアログの 1 回の押下で入る。
  EXTERNAL_NOTIFICATION_UNCONFIRMED: {
    description: 'メール・電話の欄の値は、「メールや電話への知らせが届かない」約束を確かめて書き込みの OK を出すまで作りません（この確認は、書き込みの OK の確認の画面で行います）。',
    action: 'テスト用のサイトで、メールや電話への知らせが外に届かないことを確かめてください。その後、書き込みの手順の詳細の「書き込みの OK を出す」を押し、確認の画面で 4 つの約束を読んでから OK を出してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 入力の規則の保存を拒む理由ごとの説明と手順（T29e）。理由の一覧は、保存の部品の `RULE_SET_STORE_REJECTION_REASONS`
 * （`src/control/data-rules/rule-store.ts`）と、画面のサーバの理由（`apps/local-ui/src/server/data-rule-functions.ts` の
 * `DATA_RULE_REQUEST_LOCAL_REJECTION_REASONS`）。シナリオに参照を付ける 2 段目の拒否は `SCENARIO_REQUEST_REJECTION_DESCRIPTIONS`。
 */
export const DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS = deepFreeze({
  RULE_SET_SCENARIO_NOT_FOUND: {
    description: '対象の書き込みの手順が見つかりません。保存していません。',
    action: '書き込みの手順の一覧を読み込み直して、対象を確かめてください。',
  },
  RULE_SET_PROFILE_RETIRED: {
    description: '取り消したサイトでは、入れる値の決まりを保存できません。保存していません。',
    action: '使い続ける場合は、新しい名前でサイトを足し直してください。',
  },
  RULE_SET_MODE_NOT_WRITE: {
    description: '入れる値の決まりは、書き込みも試す点検のサイトだけで使えます。保存していません。',
    action: '書き込みも試す点検にした、テスト用のサイトで決めてください。',
  },
  RULE_SET_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、入れる値の決まりが変わりました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
  RULE_SET_SECRET_FIELD_FIXED_VALUE: {
    description: '名前が秘密に見える欄には、人が入れた値を残せません。保存していません。',
    action: 'その欄の値の一覧を外してください。',
  },
  DATA_RULE_CONTENT_INVALID: {
    description: '入れる値の決まりの中身に誤りがあります（同じ欄の決まりが 2 つある、関係やほかと重ならないようにする欄に、決まりのない欄がある、など）。保存していません。',
    action: '内容を見直してから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、入力の規則（補完）の画面の文言（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。 */
export const LOCAL_UI_DATA_RULE_TEXT = deepFreeze({
  pages: {
    rules: '入れる値の決まり',
  },
  intro:
    '送る欄ごとに、書き込みで送る値の作り方（入れる値の決まり）を決めます。AI は使いません。欄の種類と決まり、小さな辞書と業務テンプレート、人が入れた値の一覧から、決まった手順で作ります。決まらない欄は、当て推量で作らずに止めます。',
  noExecution: 'この画面からは、書き込みを実行しません。データの例もサイトに送りません。',
  stateHeading: '入れる値の決まりの状態',
  ruleSetLabel: '保存した内容',
  /** 保存した版（`revisionText` は `formatInteger` の結果）。 */
  ruleSetValue: (ruleSetId: string, revisionText: string): string => `${ruleSetId}（${revisionText} 回目の変更）`,
  noRuleSet: 'まだ保存していません（業務テンプレートと汎用の規則だけで決めています）。',
  fieldsHeading: '送る欄の決まり',
  fieldsNote: '「自動」は、業務テンプレートか汎用の規則で決めます。人が決めた決まりは、それより優先します。',
  /**
   * MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6 の C）: 推せた欄はたたみ、推せなかった欄だけを見せる。すべて推せたときの知らせと、
   * たたんだ区画の説明（`countText` は `formatCount` の結果）。
   */
  undecidedNote: '次の欄は、BeakSight が値の作り方を決められませんでした。作り方を決めてください。',
  allDecided: 'すべての欄を BeakSight が作れます。「保存する」を押すだけで使えます。',
  decidedNote: (countText: string): string =>
    `BeakSight が作れる欄（${countText}）と、欄どうしの関係・ほかと重ならないようにする欄の組は、ここにたたんでいます。直すときだけ開いてください。`,
  /** MI-6: 副作用の確認を承認のときに確かめる前提で、作れる欄にしたメール・電話の欄の印。 */
  confirmationAtApproval: '書き込みの OK を出すときに、メールや電話への知らせが外に届かないことを確かめます',
  columns: {
    source: '出どころ',
    rule: '決まり',
    external: '外に届くもの',
  },
  noFields: 'この書き込みの手順には、送る欄がありません。',
  notSelected: '送る欄ではありません（必ず入れる欄です）',
  noExternal: 'なし',
  noSource: 'なし',
  kindLabel: '値の種類',
  autoKind: '自動（業務テンプレートか汎用の規則）',
  methodLabel: '作り方',
  fixedValuesLabel: '値の一覧（1 行に 1 つ）',
  /** 値の一覧の説明（`maxText`・`lengthText` は `formatCount`・`formatInteger` の結果）。 */
  fixedValuesHint: (maxText: string, lengthText: string): string =>
    `${maxText}まで。1 つの値は ${lengthText} 文字まで。値は BeakSight の記録にそのまま残ります。名前が秘密に見える欄には入れられません。`,
  rangeLabel: '範囲（数や日時の欄だけ。空なら、欄の決まりとテンプレートの最初の値を使います）',
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
  uniqueHeading: 'ほかと重ならないようにする欄の組',
  uniqueNote:
    '選ばなければ、業務テンプレートで最初から決まっている組（顧客は氏名とフリガナ、商品は商品名、予約は日付・開始・選択肢）を使います。前に作った値の組と重なれば、作り直します。',
  effectiveUniqueLabel: '当てる組',
  noUnique: 'なし（重ならないことを求めません）',
  examplesHeading: 'データの例（送りません）',
  examplesNote:
    'この画面のための決まった値で作った例です。サイトには送りません。実際の書き込みでは、書き込みを始めるたびに別の値になります。メールアドレスと電話番号は、作り物の形だけです。',
  /** 例の見出し（`numberText` は `formatInteger` の結果）。 */
  exampleLabel: (numberText: string): string => `例 ${numberText}`,
  examplesUnavailable: '値の作り方が決まらない欄があるため、例は作れません。',
  exampleColumns: {
    field: '欄',
    value: '値（例）',
  },
  notSent: '送らない',
  syntheticEmail: '作り物のメールアドレス（example.invalid。届かない宛先）',
  syntheticPhone: '作り物の電話番号（090-0 で始まる形）',
  save: '保存する',
  saving: '保存しています…',
  saveDialog: {
    title: '入れる値の決まりを保存しますか',
    body:
      '保存すると、入れる値の決まりの新しい内容ができ、書き込みの手順に付け直します。書き込みの手順の変更の回数が 1 つ進み、下書きに戻ります。書き込みの OK を出していた場合は、もう一度 OK が要ります。',
    confirm: '保存する',
    cancel: 'やめる',
  },
  saved: '入れる値の決まりを保存し、書き込みの手順に付けました。書き込みの手順は下書きに戻りました。内容を確かめてから、もう一度書き込みの OK を出してください。',
  saveRejectedHeading: '保存できませんでした',
  attachRejected: '入れる値の決まりは保存しましたが、書き込みの手順に付けられませんでした。画面を読み込み直してから、もう一度保存してください。',
  reload: '読み込み直す',
} as const);

/**
 * 入力の規則の画面の、自動で作った規則の文言（手動の操作を減らす設計書 3A.3。FM2c）。出どころの印のラベルは `catalog.ts` の `RULE_ORIGIN_CATALOG`。
 * 数の文字は、呼び出し側が `formatInteger` で作って渡す。
 */
export const LOCAL_UI_DATA_RULE_INFERENCE_TEXT = deepFreeze({
  originLabel: '出どころの印',
  defaultRangeHeading: '仮の幅を入れた欄（推測）',
  /** 既定の幅の説明（`daysText`・`minText`・`maxText` は既定の幅の数）。 */
  defaultRangeNote: (daysText: string, minText: string, maxText: string): string =>
    `範囲の手がかり（最小・最大・刻み）がない欄に、推測で仮の幅を入れました。日付・日時は、基準の日（書き込みを始めた日）から ${daysText} 日後まで、数は ${minText}〜${maxText} の整数です。サイトが受け付けないときは、範囲を入れ直して保存してください。`,
  defaultRangeBadge: '仮の幅（推測）',
  /** 基準日からの幅（`fromText`・`toText` は日の数）。 */
  baseDateWindowText: (fromText: string, toText: string): string => `基準の日から ${fromText}〜${toText} 日後`,
  baseDateWindowLabel: '日付の幅',
} as const);

/** 画面のサーバのコンソールの、監査のジョブの文言（設計書 4.4 の「画面のサーバの起動のとき」と「終わり」）。 */
export const LOCAL_UI_JOB_CONSOLE_TEXT = deepFreeze({
  /** 起動のときに、前の画面のサーバで終わっていなかったジョブを中断に直した（`countText` は `formatCount` の結果）。 */
  recoveredJobs: (countText: string): string =>
    `前の画面のサーバで終わっていなかった点検の作業（${countText}）を、中断として記録しました。${AUDIT_JOB_RESUME_ACTION_TEXT}`,
  /** 1 回目の Ctrl+C で、動いているジョブがある（`waitText` は待つ時間の上限。`formatDuration` の結果）。 */
  jobsStopping: (waitText: string): string =>
    `動いている点検を止めています。今のページの点検を終えるまで、最大 ${waitText} 待ってから終えます。すぐに終えるには、もう一度 Ctrl+C を押してください。`,
  /** 2 回目の Ctrl+C で、待たずに終える。 */
  exitingNow: `すぐに終えます。動いていた点検は、次に画面のサーバを起動したときに中断として記録されます。${AUDIT_JOB_RESUME_ACTION_TEXT}`,
  /** ジョブの管理の背後の処理（IPC の受け手、タイマー）の誤り。詳細（英語）を添えて出す。 */
  backgroundError: '点検の作業の管理で、誤りが起きました。',
} as const);

/** T44e: 時間の上限で止まったときの、次にできること（監査と発見と READ の確かめで共用する前半）。 */
const RAISE_RUNTIME_LIMIT_TEXT = 'サイトの画面の「点検の負荷」で時間の上限を上げられます';
/** T44e: 変えると途中の Run は再開されない旨（P2-1 と同じ決まり）。 */
const LIMIT_CHANGE_RESTARTS_TEXT = '（上限を変えると、途中の点検の回は続きから再開されず、新しく始まります）';
/** T44e: 安全の違反で止まったときの、次にできること。 */
const SAFETY_STOP_NEXT_STEP_TEXT = '安全の違反の中身（点検の報告（HTML）の安全の記録か、この画面の安全の違反の欄）を確かめてください。原因を直すまで、同じ設定で始め直さないでください。';
/** T44e: 始める前の確認で止まったときの、次にできること（`action` は始め直す操作の名前）。 */
const preflightNextStepOf = (action: string): string =>
  `ブラウザ（Chromium）を起動できるか、できたファイルを置くフォルダに書けるかを確かめてから、もう一度「${action}」を押してください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`;
/** T44e: 承認したサービスの Origin への要求の上限で止まったときの、次にできること（`action` は始め直す操作の名前）。 */
const serviceLimitNextStepOf = (action: string): string =>
  `ログインの設定で、ログインのときに通ってよい外のサイトへの通信の上限を見直してから、もう一度「${action}」を押してください。`;
/**
 * PL-4（PL-1 の報告による設計者の判断）: 入口の確かめのボタンの名前（サイトの画面・ログインの設定の画面の `EntryCheckPanel`・作業の画面の次にすることの文で
 * 同じ語）。`LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY` の値。ジョブの画面の次にできること（`LOCAL_UI_JOB_NEXT_STEPS`）は、そのカタログより前に定義する
 * （const の宣言の前に読むと落ちる）ので、名前はこの 1 か所に置き、両方から読む。
 */
const RECHECK_ENTRY_ACTION_TEXT = 'サイトの下調べをやり直す';

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
      `残りのページは、「点検を始める」を押すと、続きから点検します。1 回で長く点検するには、${RAISE_RUNTIME_LIMIT_TEXT}${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    STOPPED_BY_SIGNAL: '続きを点検するには、「点検を始める」を押してください。',
    STOPPED_BY_SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    STOPPED_BY_SITE_UNAVAILABLE: 'サイトがまた開けるようになったことを確かめてから、「点検を始める」を押してください。続きから点検します。',
    INTERRUPTED_ABNORMALLY: '「点検を始める」を押すと、最後に保存したページの続きから点検します。',
    STOPPED_BY_AUTH_SESSION_LOST: 'この画面の「ログイン」の欄の案内（止まったページを「読まないページ」に足すなど）に従ってから、「点検を始める」を押してください。続きから点検します。',
    STOPPED_BY_SERVICE_REQUEST_LIMIT: serviceLimitNextStepOf('点検を始める'),
  },
  /** Run の状態（`RUN_STATUSES`）。 */
  runStatuses: {
    COMPLETE: null,
    PARTIAL: '最後まで終えられなかった理由は、この欄と、HTML レポートの各ページにあります。理由ごとの「次にできること」を見てください。',
    FAILED: 'この欄の理由を確かめ、直してから、もう一度始めてください。',
    ABORTED_BY_SAFETY: `${SAFETY_STOP_NEXT_STEP_TEXT}直した後は、「新しく始める」を選んで「点検を始める」を押してください。`,
  },
  /** 監査のジョブの終わり方（`WORKER_OUTCOME_KINDS`）。説明が手順を含むものは `null`。 */
  endKinds: {
    RAN: null,
    RUN_ACTIVE: null,
    VERSION_MISMATCH: null,
    RUN_DIRECTORY_UNAVAILABLE:
      '結果を書き出すフォルダ（設定のファイルで決めた出力先）に書き込めるかを確かめてから、もう一度始めてください。空きの容量、書き込みの権限、ほかのプログラムが開いていないかを見てください。',
    RESUME_UNAVAILABLE:
      '同じ出力先で、ほかの点検（コマンドで始めたものを含む）が動いていないかを確かめてから、もう一度始めてください。続けて起きるときは、「新しく始める」を選んで「点検を始める」を押してください。',
  },
  /**
   * Run の全体に付く理由（`IncompleteReasonCode` のうち、Run の理由に入るもの。閉じた一覧は `catalog-coverage.ts`）。ページごとの理由は HTML レポートに出す。
   */
  runReasons: {
    MAX_PAGES_REACHED: `残りのページも点検するには、サイトの画面の「点検の負荷」でページの上限を上げてから、もう一度始めてください${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    MAX_DEPTH_REACHED: 'もっと深いページも点検するには、設定のファイルで、リンクをたどる深さの上限を上げてから、もう一度始めてください。',
    MAX_RUNTIME_REACHED:
      `残りのページは、「点検を始める」を押すと、続きから点検します。1 回で長く点検するには、${RAISE_RUNTIME_LIMIT_TEXT}${LIMIT_CHANGE_RESTARTS_TEXT}。`,
    RUN_INTERRUPTED: '続きを点検するには、「点検を始める」を押してください。',
    SITE_UNAVAILABLE: 'サイトがまた開けるようになったことを確かめてから、「点検を始める」を押してください。続きから点検します。',
    AUTH_SESSION_LOST: 'ログインが切れたページを、ログインの設定の「読まないページ」に足すと、次からそのページを読みません。続きは、「点検を始める」を押してください。',
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('点検を始める'),
    SAFETY_VIOLATION_ABORT: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('点検を始める'),
    CHECKPOINT_WRITE_FAILED: '結果を書き出すフォルダに書き込めるか（空きの容量、書き込みの権限）を確かめてから、「点検を始める」を押してください。続きから点検します。',
    RUN_DIRECTORY_UNAVAILABLE: '結果を書き出すフォルダに書き込めるか（空きの容量、書き込みの権限）を確かめてから、もう一度始めてください。',
  },
  /** 発見のジョブの終わり方（`DISCOVERY_END_REASONS`）。説明が手順を含むものは `null`。 */
  discoveryEndReasons: {
    COMPLETED: null,
    MAX_PAGES_REACHED: '残りの画面も読むには、サイトの画面の「点検の負荷」でページの上限を上げてから、もう一度「操作さがしを始める」を押してください。',
    MAX_RUNTIME_REACHED: `残りの画面も読むには、${RAISE_RUNTIME_LIMIT_TEXT}。上げてから、もう一度「操作さがしを始める」を押してください。`,
    STOPPED: null,
    AUTH_SESSION_LOST: null,
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('操作さがしを始める'),
    SITE_UNAVAILABLE: null,
    SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('操作さがしを始める'),
  },
  /** READ の確かめのジョブの終わり方（`READ_CHECK_END_REASONS`）。説明が手順を含むものは `null`。 */
  readCheckEndReasons: {
    COMPLETED: null,
    MAX_RUNTIME_REACHED: `残りの確かめも行うには、${RAISE_RUNTIME_LIMIT_TEXT}。上げてから、もう一度「見るだけの確かめを始める」を押してください。`,
    STOPPED: null,
    AUTH_SESSION_LOST: null,
    SERVICE_REQUEST_LIMIT_REACHED: serviceLimitNextStepOf('見るだけの確かめを始める'),
    SITE_UNAVAILABLE: null,
    SAFETY_VIOLATION: SAFETY_STOP_NEXT_STEP_TEXT,
    PREFLIGHT_FAILED: preflightNextStepOf('見るだけの確かめを始める'),
  },
  /** 入口の確かめのジョブの終わり方（`ENTRY_CHECK_END_REASONS`）。止めたものと読んだものは `null`。 */
  entryCheckEndReasons: {
    READ: null,
    LEFT_ALLOWED_ORIGINS:
      `開始のアドレスと、点検してよいサイトのアドレスが正しいかを確かめてください。ログインの画面がほかのサイト（外のログインのサービス）にある形には、まだ対応していません。ログインの設定は、サイトの画面の${ADVANCED_SETTINGS_REF_TEXT}から作ってください。`,
    // MI-8（設計書 4.9）: 認証の設定の画面は「詳しい設定」から開く（MI-3）。
    // PL-4: ボタンの名前は、サイトの画面と同じ語（`RECHECK_ENTRY_ACTION_TEXT`）。
    READ_FAILED: `少し時間をおいて、もう一度「${RECHECK_ENTRY_ACTION_TEXT}」を押してください。続けて読めないときは、ログインの設定を、サイトの画面の${ADVANCED_SETTINGS_REF_TEXT}から作ってください。`,
    NAVIGATION_FAILED: `サイトが開けるかと、開始のアドレスが正しいかを確かめてから、もう一度「${RECHECK_ENTRY_ACTION_TEXT}」を押してください。`,
    // PL-3: ボタンの名前は、サイトの画面と同じ語（RECHECK_ENTRY_ACTION_TEXT）。
    PREFLIGHT_FAILED: preflightNextStepOf(RECHECK_ENTRY_ACTION_TEXT),
    STOPPED: null,
    SAFETY_VIOLATION: `安全の決まりに反する動きがあったため、この結果は使えません。ログインの設定は、サイトの画面の${ADVANCED_SETTINGS_REF_TEXT}から作ってください。`,
  },
} as const);

/**
 * T44e（Task 44 の設計書 P2-4）: 書き込みのジョブが送る前の確かめで送らずに止めた（`PRECHECK_FAILED`）ときの、具体的な理由（`action-run.json` の
 * `precheckDetail`。一覧は `src/control/actions/action-contracts.ts` の `PRECHECK_FAILURE_DETAILS`）ごとの説明と次にできること。網羅は画面の側の
 * `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる。
 */
export const PRECHECK_FAILURE_DETAIL_DESCRIPTIONS = deepFreeze({
  STOPPED: {
    description: '止める合図（書き込みの OK の取り消し、書き込みの手順の変更、止める操作）を受けたため、送らずに止めました。',
    action: '書き込みを続けるときは、書き込みの手順に書き込みの OK が出ているかを確かめてから、もう一度始めてください。',
  },
  SESSION_LOST: {
    description: '書き込みの画面で、ログインが切れていました。送っていません。',
    action: 'ログインできるか（ログインの設定と、テスト用のサイトのアカウント）を確かめてから、もう一度始めてください。',
  },
  PAGE_UNAVAILABLE: {
    description: '書き込みの画面を読めませんでした（読み込みに失敗した、サイトが誤りの応答を返した、欄の値を読めない）。送っていません。',
    action: 'テスト用のサイトで書き込みの画面が開けるかを確かめてから、もう一度始めてください。',
  },
  CANDIDATE_CHANGED: {
    description: '書き込みの画面の操作が、書き込みの OK を出した操作と合いませんでした（画面が変わった）。送っていません。',
    action: '操作さがしをやり直し、書き込みの手順を見直して書き込みの OK を出し直してから、もう一度始めてください。',
  },
  PRIOR_VALUES_EMPTY: {
    description: '更新の前に読んだ画面で、BeakSight の印を入れた欄がすべて空でした（値が入る前の画面を読んだとみなしました）。送っていません。',
    action: '少し時間をおいて、もう一度始めてください。続けて起きるときは、テスト用のサイトで、更新するデータの値を確かめてください。',
  },
  KNOWN_KEPT_VALUE_MISMATCH: {
    description:
      '保つ欄の値が、作ったデータの一覧にある値（BeakSight が新しく登録や更新で送った値）と違いました。BeakSight の外で値が変わったデータや、結果が分からなかった更新の後のデータは、違う値を上書きしないために更新しません。送っていません。',
    action: 'テスト用のサイトで、更新するデータの値を確かめてください。新しく登録する書き込みで新しいデータを作ると、そのデータは更新できます。',
  },
  PRIOR_VALUE_UNUSABLE: {
    description: '更新の前の値を、記録や答え合わせに使えませんでした（長すぎる、書き込みの OK を出した値の種類に変えられない）。送っていません。',
    action: '書き込みの手順の変える欄・保つ欄と、テスト用のサイトの更新するデータの値を確かめてください。',
  },
  PRIOR_VALUE_CHANGED: {
    description:
      '書き込みの画面の値が、更新の前に読んだ値と違いました（開き直した画面か、押す直前の読み直し）。ページが値を変えたか、ほかの人がデータを変えた可能性があります。送っていません。',
    action: '少し時間をおいて、もう一度始めてください。続けて起きるときは、テスト用のサイトで、更新するデータと画面の動きを確かめてください。',
  },
  FORM_NOT_READY: {
    description: '入力の前の確かめ、値の入力、押す操作のどれかに失敗しました。送っていません。',
    action: '書き込みの画面が、書き込みの OK を出したときと同じかを確かめてから、もう一度始めてください。',
  },
  UNEXPECTED_REQUEST: {
    description: '値を入れた後に、書き込みの OK を出した送信のほかの通信が出たため、押しませんでした。',
    action: 'ページが入力の値を別の通信で送る作りでないかを、テスト用のサイトで確かめてください。',
  },
  RECHECK_REFUSED: {
    description: '送る直前の確かめ直しで、書き込みの OK が外れていました（取り消し、期限切れ、書き込みの手順やサイトの設定の変更など）。送っていません。',
    action: '書き込みの手順の画面で書き込みの OK の状態を確かめ、OK を出し直してから、もう一度始めてください。',
  },
  AUDIT_STAGE_STOPPED: {
    description: 'ブラウザに残るログインの印がなくなったか、ログインのときに通ってよい外のサイトへの通信の回数が上限に届いたため、送りませんでした。',
    action: 'ログインしている状態と、ログインの設定の通信の回数の上限を確かめてから、もう一度始めてください。',
  },
  PREFLIGHT_FAILED: {
    description: '始める前の確認（ブラウザの起動など）に失敗しました。送っていません。',
    action: `ブラウザ（Chromium）を起動できるか、出力先のフォルダに書けるかを確かめてから、もう一度始めてください。${PREFLIGHT_EXTERNAL_LAUNCH_BLOCK_TEXT}`,
  },
  // PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1 の「事前の確かめ」）: form の登録を送る前の答え合わせ。
  VALUE_ALREADY_PRESENT: {
    description: 'この値はもうサイトにあるので、書き込みの結果を確かめられません。送る前の答え合わせで、作る値がもうサイトの画面に見えていました。送っていません。',
    action: '入れる値の決まりが、毎回同じ値を作る形になっていないかを確かめてください。答え合わせの画面（一覧や検索の画面）が、探した文字をそのまま画面に出していないかも、テスト用のサイトで確かめてください。',
  },
  // PL-F（安全のレビュー PL-REV の Minor 3）: 止める振る舞いは変えず、文をやさしくした。
  VERIFICATION_READ_UNAVAILABLE: {
    description: 'サイトの一覧を読めなかったので、書き込みませんでした。',
    action: '少し待ってから、もう一度始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** T44e: ジョブの画面の「終わり方と理由」の欄の文言。 */
export const LOCAL_UI_JOB_END_TEXT = deepFreeze({
  heading: '終わり方と理由',
  executionEnd: '最後の実行の終わり方',
  reasons: '点検の回の理由',
  endReason: '終わり方',
  nextStep: '次にできること',
  /** ページごとの理由の置き場所（引数は、一部未完了・失敗・監査しなかったページの数。`formatCount` の結果）。 */
  pageReasons: (partialText: string, failedText: string, skippedText: string): string =>
    `終えられなかったページ（一部未完了 ${partialText}、失敗 ${failedText}、点検しなかった ${skippedText}）の理由は、HTML レポートの各ページにあります。`,
} as const);

/** ローカルの管理画面の、監査の開始・進み具合・実行履歴・成果物の文言（設計書 4.8）。 */
export const LOCAL_UI_AUDIT_TEXT = deepFreeze({
  pages: {
    jobs: '作業の履歴',
    startAudit: '点検を始める',
  },
  profileList: {
    startAudit: '点検を始める',
    lastRunNone: 'まだ点検していません',
    lastRunDetail: '詳細',
  },
  start: {
    // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、2 章の判断 3）: 要点のパネルの、1 回押すと何が起きるかの文（主のボタンが始めるもの
    // ごと。決めるのは画面のサーバの `primaryStart`）。ログインのしかたの案内は、続けて `LOCAL_UI_AUTH_TEXT.start` の文を出す。
    whatHappens: {
      STAGE_CHAIN: 'サイトのページを見て回り、操作できる所を探します。読むだけで、書き込みはしません。',
      AUDIT_ONLY: 'サイトのページを見て回ります。読むだけで、書き込みはしません。',
    },
    /** OP-G（指示書の 5）: チェックした画面があるときの、まとめて実行の文（「読むだけ」は、チェックがないときだけ）。 */
    whatHappensWithWrites: 'サイトのページを見て回り、操作できる所を探します。チェックした画面では、テスト用のデータを登録・更新します。そのほかは見るだけです。',
    /**
     * PL-3（4 章の 4）: 前回の点検が最後まで終わらなかったときだけ出す一文（始め方の選択は詳しい内容。`foldedHeading` はたたんだ区画の見出し
     * `LOCAL_UI_TEXT.advancedSettings.summary`）。
     */
    resumeNote: (foldedHeading: string): string =>
      `前回の点検は、最後まで終わっていません。続きがあれば、続きから点検します。最初から点検するときは、「${foldedHeading}」の「始め方」で選んでください。`,
    // PL-3: 詳しい内容の、まとめて実行のステップの並びの見出し。
    stagesLabel: '行うステップ（この順）',
    // MI-3 の D（MI-5 の報告による設計者の判断）: 書き込みのモードのプロファイルで監査を始めるときだけ出す一文（監査は読み取りだけ）。
    readOnlyInWriteMode: 'この点検は見るだけで行います（書き込みは送りません）。',
    // T44d（Task 44 の設計書 P2-1）: 間隔と上限は、プロファイルの画面の「監査の負荷」で変えられる。PL-3: 設定のファイルの置き場所の話は出さない
    // （変えられないときの案内は、サイトの画面の「点検の負荷」の欄が出す）。
    configNote: 'この画面では変えられません。読むページの数と間隔は、サイトの画面の「点検の負荷」で変えます。',
    startUrl: '開始のアドレス',
    maxPages: 'ページの上限',
    maxRuntime: '時間の上限',
    minNavigationInterval: 'ページの読み込みの間隔',
    modeLegend: '始め方',
    resume: '前回の続きから再開する',
    resumeHint: '途中で止まった点検があれば、その続きから始めます。なければ、新しく始めます。',
    startNew: '新しく始める',
    startNewHint: '途中で止まった点検があっても、続きからではなく最初から始めます。',
    submit: '点検を始める',
    submitting: '開始しています…',
    cannotStartHeading: 'このサイトでは、点検を始められません',
    rejectedHeading: '点検を始められませんでした',
  },
  jobs: {
    caption: '作業（新しい順）',
    empty: 'まだ作業はありません。「点検するサイト」の一覧の「点検を始める」から始めます。',
  },
  job: {
    summaryHeading: '作業',
    state: '作業の状態',
    profileId: 'サイト',
    startMode: '始め方',
    runId: '点検の回',
    runStatus: '点検の回の状態',
    endKind: '終わり方',
    exitCode: '終了コード',
    failureReason: '失敗・中断の理由',
    createdAt: '開始を頼んだ日時',
    startedAt: '始まった日時',
    finishedAt: '終わりの日時',
    stopRequestedAt: '停止を頼んだ日時',
    none: 'なし',
    progressHeading: '進み具合',
    pagesProgressLabel: '点検を終えたページの割合（ページの上限に対して）',
    noticeHeading: '知らせ',
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
      '画面のサーバとのやりとりで誤りが起きたため、止める操作を届けられませんでした。画面のサーバが動いているかを、BeakSight を起動した黒い画面（コンソール）で確かめてから、もう一度止めてください。',
    artifactsHeading: 'できたファイル',
    openReport: 'HTML レポートを開く',
    downloadRunJson: 'run.json をダウンロードする',
    downloadAuditJson: 'audit.json をダウンロードする',
    downloadBundle: 'ChatGPT に渡すまとめファイル（ZIP）をダウンロードする',
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
  artifactNotFound: 'このファイルはありません。',
} as const);

/**
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、13 章の 10・11・13）: 作業の画面の要点（結果の 1 行、待つ間の進み具合、
 * 主のボタン）と、作業の一覧の 3 つの列。結果の種類と主のボタンの種類は、画面のサーバ（`apps/local-ui/src/server/audit-job-functions.ts` の `jobSummaryOf`）が
 * 決める。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts` で確かめる。`target` は作業の呼び名（`AUDIT_JOB_STOP_TARGET_NAMES`）。
 */
export const LOCAL_UI_JOB_SUMMARY_TEXT = deepFreeze({
  /** 動いている間の結果の 1 行（止めている間は、種類ごとの `AUDIT_JOB_STOP_REQUESTED_TEXTS`）。 */
  active: {
    STARTING: (target: string): string => `${target}を始めています。`,
    RUNNING: (target: string): string => `${target}をしています。`,
    AWAITING_LOGIN: '開いたブラウザで、ログインしてください。',
  },
  /**
   * OP-G2（OP-G の指示書の 6）: まとめて実行の連鎖が動いている間に、点検の画面にとどまって出す結果の 1 行（今の段。鍵は `JOB_SUMMARY_CHAIN_STAGES`。`NEXT` は
   * 段と段の間）。
   */
  chainStage: {
    AUDIT: '点検をしています。',
    DISCOVERY: '点検の続きで、操作さがしをしています。',
    READ_CHECK: '点検の続きで、見るだけの確かめをしています。',
    WRITE_CREATE: 'チェックした画面で登録しています。',
    WRITE_UPDATE: 'チェックした画面で更新しています。',
    NEXT: '点検の続きを始めています。',
  },
  /** 終わった後の結果の 1 行。 */
  finished: {
    AUDIT_COMPLETE: '点検が終わりました。最後まで見ました。',
    AUDIT_PARTIAL: '点検が終わりました。一部のページは見られませんでした。',
    ENTRY_CHECK_LOGIN_PAGE: 'サイトの下調べが終わりました。ログインの画面が見つかりました。',
    ENTRY_CHECK_READ: 'サイトの下調べが終わりました。はじめのページを見られました。',
    ENTRY_CHECK_NEEDS_SETUP: 'サイトの下調べが終わりました。ログインのしかたを、BeakSight だけでは決められませんでした。',
    ENTRY_CHECK_NOT_READ: 'サイトの下調べで、はじめのページを見られませんでした。',
    LOGIN_CHECK_SUCCEEDED: 'ログインできました。',
    DISCOVERY_FINISHED: '操作さがしが終わりました。',
    READ_CHECK_FINISHED: '見るだけの確かめが終わりました。',
    WRITE_VERIFIED: '書き込みが終わりました。サイトに入ったことを確かめました。',
    WRITE_PARTIAL: '書き込みを送りましたが、入ったかを最後まで確かめられませんでした。',
    WRITE_UNKNOWN: '送ったかどうか分かりません。テスト用のサイトでデータがあるか確かめてください。',
    WRITE_NOT_SENT: '書き込みを送らずに止めました。',
    WRITE_PENDING: '書き込みの結果を待っています。',
    SAFETY_VIOLATION: '安全のため止めました。送ってはいけない送信を見つけました。',
    SESSION_LOST: '途中でログインが切れたので、止まりました。',
    FAILED: '作業がうまくいきませんでした。',
    INTERRUPTED: '作業が途中で止まりました。',
  },
  /**
   * PL-R（設計書 14 章、13 章の 13。PL-2 の持ち越し）: 点検が最後まで終わり、報告を作る時に書いた小さなまとめ（`report-summary.json`）を読めたときの結果の 1 行
   * （`finished.AUDIT_COMPLETE` の代わり。問題はサイトの問題の数で、安全の記録は入れない。`countText` は `formatInteger`）。
   */
  auditCompleteWithProblems: (countText: string): string => `点検が終わりました。問題が ${countText} 件見つかりました。`,
  auditCompleteWithoutProblems: '点検が終わりました。問題は見つかりませんでした。',
  /** 主のボタンの語（ほかの画面と同じ語は、その画面のカタログを使う）。 */
  openResult: '結果を見る',
  /** 点検を待つ間の進み具合と、終わるまでの長くてもの見積もり（13 章の 11。分は切り上げ）。 */
  progressEstimate: (pagesText: string, maxPagesText: string, minutesText: string): string =>
    `読んだページ ${pagesText} / ${maxPagesText}。長くても あと 約 ${minutesText} 分`,
  /** 動いている間の、画面が新しくなることと、閉じても続くこと（読み直しの間隔は書かない）。 */
  autoRefresh: (target: string): string => `この画面は自動で新しくなります。閉じても${target}は続きます。`,
  /** 確かめきれなかった所があるとき（`details` はたたんだ区画の見出し。`LOCAL_UI_TEXT.advancedSettings.summary`）。 */
  incomplete: (details: string): string => `確かめきれなかった所があります。くわしくは、下の「${details}」を開いて見てください。`,
  /** ログインが切れたこと（OP-3: 要点にはアドレスを出さない。切れたページのアドレスは詳しい内容の「ログイン」の欄）。 */
  sessionLostPage: 'ページを見ている途中で、ログインが切れました。',
  /** 行の登録が要るとき（`details` はたたんだ区画の見出し）。自動の登録の理由があれば、その次にすることを続けて出す。 */
  registrationNeeded: (details: string): string => `ログインの設定に足りない送信があります。下の「${details}」の表で、行を選んで登録してください。`,
  /** 作業の一覧の 3 つの列（何の作業か・いつ・結果）。 */
  listColumns: {
    what: '何の作業か',
    when: 'いつ',
    result: '結果',
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// 認証つきの読み取りの監査（ローカルの管理画面の認証の設定、ログインの案内と状態。Task 25 の設計書 4.5、4.6。T25e）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 認証の設定の検証の誤りのコード（`src/control/auth/auth-setup-contracts.ts` の `AUTH_SETUP_VALIDATION_ERROR_CODES`）ごとの、日本語の説明。
 * 書き漏れと余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。説明には、設定の値を入れない。
 */
export const AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS = deepFreeze({
  AUTH_SETUP_SCHEMA_INVALID: 'ログインの設定の形が正しくありません（なくてはならない項目がない、値の種類が違う、同じ値が 2 回ある、など）。',
  AUTH_SETUP_LIMIT_EXCEEDED:
    '長さ、件数、または回数の上限を超えています。自動ログインのサイトでは、ログインの送信は 1 回だけです（アカウントがロックされて使えなくなるのを避けるため）。',
  AUTH_SETUP_PROFILE_INVALID: '今の設定のファイルでは、サイトの設定に誤りがあります。「サイトの設定」で直してください。',
  AUTH_SETUP_PROFILE_MISMATCH: 'このログインの設定は、このサイトのものではありません。',
  AUTH_SETUP_PROFILE_REVISION_MISMATCH:
    'この画面を開いた後に、サイトの設定が変わりました。ログインの設定は、今のサイトの設定に合わせて保存します。画面を読み込み直してから、もう一度保存してください。',
  AUTH_SETUP_MODE_UNSUPPORTED:
    'このサイトでは、ログインの設定を使いません。ログインの設定は、ログインして点検するサイト（点検のしかたがログインして見るだけか書き込みも試す点検で、ログインのしかたが手でログインか自動ログインのサイト）だけで使います。使うときは、「サイトの設定」で点検のしかたとログインのしかたを変えてください。',
  AUTH_SETUP_URL_INVALID: 'ページのアドレスの形が正しくありません。http:// か https:// で始まり、ユーザー名・パスワード・# を含まない、正しい形のアドレスにしてください。',
  AUTH_SETUP_PATH_INVALID: 'アドレスの後ろの形が正しくありません。/ で始め、//、..、符号化した .、空白、改行などの見えない文字を含めないでください。',
  AUTH_SETUP_ORIGIN_NOT_APPROVED: 'ページのアドレスの頭の部分（サイトのアドレス）が、テスト用のサイトのアドレスに入っていません。',
  AUTH_SETUP_ORIGIN_OUTSIDE_TARGET: 'テスト用のサイトのアドレスが、設定のファイルの「点検してよいサイトのアドレス」に入っていません。',
  // T34R-fix-b（M-6）: 必須の query の値の確かめ（値に見える文字列、メールアドレス）も、このコードで知らせる。
  AUTH_SETUP_SECRET_LIKE_VALUE:
    'ログインの画面のアドレスか、送信先に必ず付けるアドレスの ? の後ろに、秘密に見える名前（password、token、session など）か、値に見える文字列（長いでたらめな文字の並び、ログインの合い札の形、メールアドレス）があります。秘密や個人の情報は書かないでください。',
  AUTH_SETUP_IDP_NOT_SUPPORTED: 'ほかのサイトにあるログインの画面には、まだ対応していません。',
  AUTH_SETUP_SELECTOR_INVALID: '部品の目印が正しくありません（空白だけ、改行などの見えない文字を含む）。使わない場合は空にしてください。',
  // T32j-4: 自動ログインの 3 つのセレクタは、標準の CSS として読む（ログインの form の事前の確かめは isolated world の中で探し直す）。
  AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS:
    '部品の目印に、標準の CSS で読めない書き方があります（:has-text()・:visible・>>、css=・xpath= などの前置き）。標準の CSS の書き方だけで書いてください。shadow root をまたぐ書き方も、動かすときにフォームを読めないとして止まります。',
  AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS:
    '「ログインが済んだと判定するページ」が、ログインの画面（または「ログインが切れたと判定するページ」）にも当たります。ログインの後にだけ開くページのアドレスの後ろにしてください。',
  // T26b（Task 26 の設計書 4.3）: 自動ログインの設定の誤り。T26e で文言を見直した。
  AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED:
    '自動ログインのサイトでは、自動ログインの設定が要ります。ユーザー名の欄、パスワードの欄、送信のボタンの部品の目印を入れてください。',
  AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED:
    '手でログインするサイトでは、自動ログインの設定は使いません。自動ログインを使う場合は、サイトのログインのしかたを変えてください。',
  AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED:
    'ユーザー名の欄、パスワードの欄、送信のボタンの部品の目印に、同じものがあります。それぞれ別の部品を指す目印にしてください。',
  AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS:
    'ログインの結果を判定する条件が、同時に当たることがあります（アドレスの後ろが同じ条件で、部品の目印が同じか、どちらかに目印がない）。アドレスの後ろが同じ条件には、それぞれの画面にだけある部品の目印を入れてください。',
  // T34a（Task 34 の設計書 3.2）: 認証の設定の版 3（スクリプトで送るログイン）の誤り。画面の文言の見直しは T34d。
  AUTH_SETUP_SCRIPT_LOGIN_REQUIRED:
    'ページの中のプログラムで送るログインでは、ログインの送信先と、ログインが済んだと判定するブラウザの保存場所の名前が要ります。両方を入れてください。',
  // T35a: 監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限も、スクリプトで送るログインだけの項目。
  AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED:
    'フォームの送信で行うログインでは、ページの中のプログラムの送信先、ログインに伴う送信、ブラウザの保存場所の名前、点検のステップの見るだけの呼び出し、外のサイトへの通信の回数の上限は使いません。ページの中のプログラムで送るログインにするか、これらを空にしてください。',
  AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED:
    'フォームの送信で行うログインでは、ログインの送信先（サイトのアドレスとアドレスの後ろ）が 1 つ以上要ります。',
  // MI-8（設計書 4.9）: 承認したサービスの Origin は画面から足せない（MI-1。手動のログインの観察だけが足す）ので、足し方を手動のログインに合わせた。
  AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED:
    'ページの中のプログラムの送信先のサイトのアドレスが、「ログインのときに通ってよい外のサイトのアドレス」にありません。送信先を直すか、一度、手でログインしてください（ログインのサーバのアドレスが自動で入ります）。',
  AUTH_SETUP_REQUIRED_QUERY_INVALID:
    '送信先に必ず付けるアドレスの ? の後ろに、空の名前、同じ名前の重なり、または使えない文字（改行などの見えない文字）があります。名前と値を直してください。',
  AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED:
    'ログインに伴う送信に、ほかの送信（またはページの中のプログラムの送信先）と同じアドレスのものがあります。1 つにまとめてください。',
  AUTH_SETUP_STORAGE_KEY_INVALID:
    'ブラウザの保存場所の名前の始まりと終わりが、どちらも空か、使えない文字（改行などの見えない文字）を含みます。どの名前にも当たる指定は使えません。',
  // T35a（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しの重なり。
  AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED:
    '点検のステップの見るだけの呼び出しに、ほかの呼び出しと同じアドレスのものがあります。1 つにまとめてください。',
} as const);

/**
 * 認証の設定の保存の部品が保存を拒む理由（`src/control/store/auth-setup-store.ts` の `AUTH_SETUP_STORE_REJECTION_REASONS`）ごとの説明と手順。MI-C 項目 12:
 * 画面のサーバの保存が拒む `NEW_TARGET_FROM_AUTOMATED_LOGIN`（自動ログインのプロファイルに新しい承認したサービスの Origin を足す保存。MI-G と同じ理由）も
 * 持つ（型は `auth-setup-functions.ts` の `AuthSetupSaveRejectionReason`）。書き漏れと余分は、画面の側で型で確かめる。
 */
export const AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS = deepFreeze({
  AUTH_SETUP_INVALID: {
    description: 'ログインの設定に、誤りがあります。保存していません。',
    action: '表示された誤りを直してから、もう一度保存してください。',
  },
  PROFILE_NOT_FOUND: {
    description: '対象のサイトが見つかりません。',
    action: 'サイトの一覧を読み込み直して、対象を確かめてください。',
  },
  PROFILE_RETIRED: {
    description: '取り消したサイトには、ログインの設定を保存できません。',
    action: '使い続ける場合は、「サイトを足す」から新しい名前で作り直してください。',
  },
  TARGET_CONFIG_UNAVAILABLE: {
    description: 'サイトが使う設定のファイルを読めないか、その内容に誤りがあります。保存していません。',
    action: '設定のファイルの場所と内容を確かめてから、もう一度保存してください。',
  },
  PROFILE_INVALID: {
    description: '今の設定のファイルでは、サイトの設定に誤りがあります。保存していません。',
    action: '「サイトの設定」で誤りを直してから、もう一度保存してください。',
  },
  PROFILE_REVISION_CONFLICT: {
    description: '保存の途中で、サイトの設定が変わりました。保存していません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度保存してください。',
  },
  NEW_TARGET_FROM_AUTOMATED_LOGIN: {
    description: '自動ログインのサイトには、「ログインのときに通ってよい外のサイトのアドレス」（ログインの送信先）を新しく足せません。保存していません。',
    action: `${ADVANCED_SETTINGS_REF_TEXT}でログインのしかたを手でログインに戻してから、一度、手でログインしてください。ログインの送信先が自動で登録されます。`,
  },
  // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルの、ログインの送信先を変える認証の設定の保存。
  CREDENTIAL_DESTINATION_LOCKED: CREDENTIAL_DESTINATION_LOCKED_TEXT,
  // MI-F1（設計書 4.3）: 「設定がないときだけ保存する」保存で、設定がすでにあった（入口の確かめの後の案の保存。画面の保存では出ない）。
  AUTH_SETUP_ALREADY_EXISTS: {
    description: 'ログインの設定が、すでにあります。上書きしていません。',
    action: '画面を読み込み直して、今のログインの設定を確かめてください。',
  },
  // MI-F1（設計書 4.7.1 の 1）: 下書きからの保存で、ジョブの行が観察していない承認したサービスの Origin を足そうとした。
  SERVICE_ORIGIN_ADD_NOT_OBSERVED: PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS.SERVICE_ORIGIN_ADD_NOT_OBSERVED,
  // MI-F5（設計書 4.7.1 の 6）: 認証の設定の画面の保存（方式によらない）で、ログインの送信先を、入口の確かめと手動のログインの観察にない値にしようとした。
  CREDENTIAL_DESTINATION_OBSERVED_ONLY: {
    description: 'ログインの送信先は、サイトの下調べと、手でログインしたときに BeakSight が見た送信からだけ入ります。保存していません。',
    action: 'ログインの送信先を変えるには、サイトを作り直してください（作るときに入れるのは開始のアドレスだけです）。ほかの欄は、送信先を変えずに保存できます。',
  },
  // MI-F3（設計書 4.3）: 監査の開始の画面の読まないパスの保存で、替える元の認証の設定が保存されていない（開始の画面は、認証の設定があるときだけ欄を出すので、
  // 画面の操作ではふつう出ない）。
  AUTH_SETUP_NOT_FOUND: {
    description: 'ログインの設定がまだありません。読まないページを保存していません。',
    action: '画面を読み込み直して、今のログインの設定を確かめてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、認証つきの読み取りの監査の文言（認証の設定の画面、開始の画面の案内、ジョブの画面の認証の状態）。 */
export const LOCAL_UI_AUTH_TEXT = deepFreeze({
  pages: {
    authSetup: 'ログインの設定',
  },
  /** プロファイルの詳細の、認証の設定への案内。 */
  profileDetail: {
    open: 'ログインの設定を開く',
  },
  /**
   * T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルで、スクリプトで送るログインの送信先と鍵が空のときの案内（入口の確かめの結果と、認証の設定の
   * 画面。空の欄は、手動のログインの成功の後の自動の登録が埋める）。
   */
  // T44h の判断 (2)（測りの記録の N3）: 承認したサービスの Origin も自動の登録が足すので、先にプロファイルで足さない旨を含める（足すと改訂が進み、認証の設定が
  // 古くなって手順が増える）。
  // MI-8（設計書 4.9）: 承認したサービスの Origin は画面から足せなくなった（MI-1）ので、「先に足さなくてかまいません」の言い方をやめた。
  scriptLoginAutoRegistrationNote:
    'ページの中のプログラムで送るログインの送信先と、ログインが済んだと判定するブラウザの保存場所の名前は、空のまま保存できます（手でログインするサイトだけ）。「ログインのときに通ってよい外のサイトのアドレス」も、空のままでかまいません。この設定で点検などを始め、BeakSight が開くブラウザで一度、手でログインすると、送信先と保存場所の名前と、送信先のサイトのアドレス（ログインのときに通ってよい外のサイトのアドレス）が自動で登録されます。',
  /**
   * プロファイルの登録・編集のフォームで、認証の設定が要るモードを選んだときの案内。MI-8（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.9）:
   * 認証の設定は、入口の確かめの後に BeakSight が案で保存する（MI-3）ので、利用者が作る手順の案内をやめた。
   */
  profileFormNotice:
    `ログインして点検するしかたでは、ログインの設定（ログインの画面や読む範囲など）を使います。サイトの下調べでログインの画面が見つかると、BeakSight が案を作って保存します。保存できなかったときだけ、サイトの画面の${ADVANCED_SETTINGS_REF_TEXT}から作ってください。`,
  setup: {
    // PL-4: サイトの値の表（名前・改訂・点検のしかた・ログインのしかた・状態・Origin の一覧・最後の保存）は出さなくなったので、その見出しと項目の名前は消した。
    state: 'ログインの設定の状態',
    notSaved: 'まだ保存していません',
    staleHeading: 'サイトの設定が変わりました',
    staleBody: 'このログインの設定は、サイトの設定が変わる前に保存したものです。古い設定では点検を始めません。内容を見直して、保存し直してください。',
    notEligible: 'このサイトでは、ログインの設定を使いません。ログインの設定は、ログインして点検するサイト（点検のしかたがログインして見るだけか書き込みも試す点検で、ログインのしかたが手でログインか自動ログインのサイト）だけで使います。使うときは、「サイトの設定」で点検のしかたとログインのしかたを変えてください。',
    retired: '取り消したサイトには、ログインの設定を保存できません。',
    /**
     * PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2・3。作業記録 UX-1 の画面 C の 5.3）: ログインの設定の画面の要点の文（「どこから来た値か」の
     * 表とサイトの値の表の代わり）。ログインの送り先の欄は、詳しい内容の中にも出さない。
     */
    summarySaved:
      'このログインの設定は、BeakSight がサイトを見て自動で作りました。ふだんは直す必要はありません。直すのは、自動で入らない欄（ログインした後のページ、読む範囲、読まないページ など）だけです。',
    summaryNotSaved:
      `ログインの設定は、まだありません。「${RECHECK_ENTRY_ACTION_TEXT}」を押すと、BeakSight がサイトを見て自動で作ります。`,
    noSecretBody:
      'パスワードや、ブラウザに残るログインの印の値などの秘密は、この画面に書きません（保存もしません）。ログインは、点検を始めたときに BeakSight が開くブラウザで、人が行います。',
    /** 自動ログインのプロファイルの、秘密を書かない案内（T26e）。 */
    noSecretBodyAutomated:
      'パスワードや、ブラウザに残るログインの印の値などの秘密は、この画面に書きません（保存もしません）。自動ログインのユーザー名とパスワードは、別の「ID とパスワード」の画面で、暗号化して保存します。',
    formHeading: 'ログインと点検の範囲',
    // MI-F5（設計書 4.7.1 の 6）: 認証の設定があるときの、ログインの送信先の欄の案内。PL-4: 送信先の欄は出さなくなったので、出さない理由の文にした。
    destinationLockedNote:
      'ログインの送り先（ログインの画面、送り方、ログインの欄）は、サイトの下調べと、手でログインしたときに BeakSight が見たものだけを使います。この画面には出さず、変えられません。変えるときは、サイトを作り直してください。',
    /** T43b（Task 43 の設計書 4.2）: 新しい認証の設定で、開始の URL の path から案を埋めたときの案内（`path` は開始の URL の path）。 */
    startUrlDraftNotice: (path: string): string =>
      `開始のアドレスの後ろ（${path}）から、「ログインが済んだと判定するページ」と「読む範囲のページ」の案を入れました。まだ保存していません。違うときは直して保存してください。`,
    loginStartUrl: 'ログインの画面のアドレス',
    loginStartUrlHint: 'BeakSight が開くブラウザで、最初に開く画面です（例: https://test.example.invalid/login）。',
    loginPostEndpoints: 'ログインの送信先（1 行に 1 つ）',
    loginPostEndpointsHint: 'ログインのフォームの送信先のページのアドレスです。ログインの間だけ、ここへの送る通信を通します（アドレスの ? の後ろは比べません）。',
    successPathPrefix: 'ログインが済んだと判定するページ（アドレスの後ろ）',
    successPathPrefixHint: 'ログインの後に開くページのアドレスの後ろが、これで始まるかで見ます（例: /admin）。ログインの画面のアドレスには当たらない値にします。',
    successSelector: 'ログインが済んだと判定する部品の目印（任意）',
    successSelectorHint: 'そのページにある部品の目印です（例: #dashboard）。使わない場合は空にします。',
    sessionLostPathPrefix: 'ログインが切れたと判定するページ（アドレスの後ろ。任意）',
    sessionLostPathPrefixHint: '点検の途中で、アドレスの後ろがこれで始まるページへ移ったら、ログインが切れたと判定して止めます。空なら、ログインの画面のアドレスの後ろを使います。',
    excludedPaths: '読まないページ（1 行に 1 つ）',
    excludedPathsHint: '点検で読まないページです。アドレスの後ろがこれで始まるページを読みません。ログアウトの画面のアドレスの後ろを必ず入れてください。',
    auditPathPrefixes: '読む範囲のページ（1 行に 1 つ。任意）',
    auditPathPrefixesHint: '点検で読むページです。アドレスの後ろがこれで始まるページだけを読みます。空なら、範囲を絞りません。',
    maxLoginAttempts: 'ログインの送信の回数の上限',
    maxLoginAttemptsHint: (minText: string, maxText: string): string =>
      `ログインの間に通す送信の回数です（${minText}〜${maxText}。パスワードを何度も試さないため）。`,
    /** 自動ログインのプロファイルの回数（変えられない。`countText` は `formatTimes` の結果。T26e）。 */
    maxLoginAttemptsFixedText: (countText: string): string => `${countText}（自動ログインでは変えられません）`,
    // DEF-099（`doc/spec/automated-login.md` の「ログインの送信の回数と上限」）: Guard が通すのは 1 回だけ。応答の前に接続が切れるとブラウザが
    // 送り直しうるので、回数の上限（24 時間の回数）では、応答がなかった回を 2 回と数える。
    maxLoginAttemptsFixedHint:
      '自動ログインでは、アカウントがロックされるのを避けるため、1 回の作業で BeakSight が通すログインの送信は 1 回だけです。ただし、応答の前に接続が切れると、ブラウザが同じ送信を送り直し、サーバに 2 回届くことがあります。このため、回数の上限では、応答がなかった回を 2 回と数えます。',
    // T26e（Task 26 の設計書 4.3）: 自動ログインの設定の欄（認証の方式が自動ログインのプロファイルだけ）。
    automatedHeading: '自動ログイン',
    automatedBody:
      'BeakSight が、保存した ID とパスワードを入れるログインのフォームの部品の目印と、送信の後の画面がどの失敗かを見分ける条件です。ユーザー名とパスワードの値は、ここには書きません。',
    usernameSelector: 'ユーザー名の欄（部品の目印）',
    usernameSelectorHint: 'ログインのフォームのユーザー名の入力の欄を、ちょうど 1 つ指す目印です（例: #username）。',
    passwordSelector: 'パスワードの欄（部品の目印）',
    passwordSelectorHint: 'パスワードの入力の欄（type=password）を、ちょうど 1 つ指す目印です（例: #password）。',
    submitSelector: '送信のボタン（部品の目印）',
    submitSelectorHint: '同じフォームの送信のボタンを、ちょうど 1 つ指す目印です（例: #login-button）。',
    failureConditionsHeading: 'ログインの失敗を見分ける条件（任意）',
    failureConditionsBody:
      '使わない条件は、アドレスの後ろと部品の目印の両方を空にします。結果は、成功の条件とここの条件のうち、ちょうど 1 つに当たったときだけ決めます（どれにも当たらないか、2 つ以上に当たるときは「結果が分からない」として止めます）。',
    failureConditionNames: {
      invalidCredentials: 'ID かパスワードの誤り',
      accountLocked: 'アカウントのロック',
      mfaRequired: '人の操作（2 段階の確認など）が必要',
      credentialExpired: 'パスワードの期限切れ',
    },
    /** 失敗の条件のパスの欄のラベル（`nameText` は `failureConditionNames` の値）。 */
    failurePathPrefixLabel: (nameText: string): string => `${nameText}: ページのアドレスの後ろ`,
    /** 失敗の条件のセレクタの欄のラベル。 */
    failureSelectorLabel: (nameText: string): string => `${nameText}: 部品の目印（任意）`,
    failurePathPrefixHint: 'その画面のアドレスの後ろが、これで始まるかで見ます（例: /login-error）。',
    failureSelectorHint: 'その画面にだけある部品の目印です。アドレスの後ろが同じ条件がほかにもあるときは、どの条件にも入れてください。',
    defaultExcludedHeading: 'いつも読まない語',
    defaultExcludedBody: 'アドレスの後ろか ? の後ろにこの語を含むページは、上の設定にかかわらず読みません。ログアウトや削除などの操作を避けるためです。この画面では変えられません。',
    save: '保存する',
    saving: '保存しています…',
    saved: 'ログインの設定を保存しました。',
    rejectedHeading: '保存できませんでした',
    /** 1 行に 1 つの項目の、誤りのある行（`lineText` は `formatCount` などで書式を整えた値）。 */
    lineText: (lineText: string): string => `${lineText} 行目`,
  },
  /** 監査の開始の画面（認証つきのプロファイル）。 */
  start: {
    heading: 'ログイン',
    guidance: 'BeakSight が開くブラウザでログインしてください。ログインが済むと、自動で作業が進みます。',
    guidanceNote: 'ログインしている状態（ブラウザに残るログインの印など）は保存しません。この作業の間だけ使います。続きから始めるときも、もう一度ログインします。',
    // T26e（Task 26 の設計書 4.6）: 自動ログインのプロファイルの案内と、上限の状態。
    automatedGuidance: 'BeakSight が、保存した ID とパスワードで自動でログインします。ブラウザは開きません。',
    /** OP-G（設計書 4.1.4 の E3）: 表示の設定で作業中のブラウザを画面に出すサイトの、自動ログインの案内（`automatedGuidance` は出さないサイト）。 */
    automatedGuidanceBrowserShown: 'BeakSight が、保存した ID とパスワードで自動でログインします。作業中のブラウザが画面に出ます。',
    automatedGuidanceNote:
      'ログインしている状態（ブラウザに残るログインの印など）は保存しません。この作業の間だけ使います。続きから始めるときも、もう一度自動でログインします（回数の上限に数えます）。',
    limitState: '自動ログインの状態',
    limitReady: '今すぐ始められます',
    limitHeld: '止めています（人が確かめて停止を解くまで始められません）',
    /** 次に始められる日時（`dateTimeText` は `formatDateTime` の結果）。 */
    limitWaitText: (dateTimeText: string): string => `${dateTimeText} を過ぎると始められます`,
    openCredentials: 'ID とパスワードの画面を開く',
    // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の最後）: ログインの確かめの画面は、止めた自動ログインを再開する入口としてだけ残す。
    openLoginCheck: '自動ログインの再開の画面を開く',
    loginStartUrl: 'ログインの画面のアドレス',
    auditScope: '読む範囲',
    auditScopeAll: '制限なし（点検してよいサイトの中）',
    openSetup: 'ログインの設定を開く',
    // MI-3 の C（設計書 4.3）: 監査の開始の画面の「読まないパス」（認証の設定のあるプロファイルだけ）。変えて始めると、認証の設定を保存してから始める。
    excludedPaths: '読まないページ（任意。1 行に 1 つ）',
    excludedPathsHint:
      '点検で読まないページです。アドレスの後ろがこれで始まるページを読みません（ログアウトの画面など）。変えて「点検を始める」を押すと、ログインの設定を保存してから始めます。変えなければ保存しません。',
    // MI-C 項目 9: 承認済みのシナリオがあるプロファイルだけ（`countText` は `formatCount` の結果で、単位「件」を含む。変えると認証の設定の digest が変わり、承認が外れる）。
    excludedPathsReapproval: (countText: string): string =>
      `変えると、書き込みの OK を出した書き込みの手順（${countText}）は、OK を出し直す必要があります。`,
    excludedPathsDefaultWords: '次の語をアドレスの後ろか ? の後ろに含むページは、ここに書かなくても読みません。',
    excludedPathsRejected: '読まないページを保存できなかったため、まだ始めていません。',
    /** PL-3: 要点のパネルの知らせ（欄は詳しい内容の中。`foldedHeading` はたたんだ区画の見出し `LOCAL_UI_TEXT.advancedSettings.summary`）。 */
    excludedPathsRejectedNote: (foldedHeading: string): string =>
      `点検は、まだ始めていません。「${foldedHeading}」の「読まないページ」の欄に、保存できなかった理由があります。直してから、もう一度押してください。`,
  },
  /** 監査のジョブの画面（認証つきの監査）。 */
  job: {
    heading: 'ログイン',
    state: 'ログインの状態',
    sessionLostUrl: '止まったページのアドレス',
    sessionLostGuidance: 'このページを「読まないページ」に足すと、次からこのページを読みません。足すときは、ログインの設定を開いて保存し直してください。',
    openSetup: 'ログインの設定を開く',
    /**
     * DEF-138: セッションの切れを判定したページの記録（`SessionLossEvidence`）。path と query の名前と数だけで、値（token、Cookie の値、query の値）は
     * ありません。
     */
    sessionLoss: {
      heading: 'ログインが切れたと判定した読み込みの記録',
      note: 'アドレスの後ろと、? の後ろの名前と数だけを記録しています（ログインの合い札、ブラウザに残るログインの印の値、? の後ろの値は記録しません）。',
      stage: '判定した段階',
      requestedPath: '頼んだページ',
      landedPath: '行き着いた先',
      landedBy: '行き着いた先を見た場所',
      landedByLabels: {
        PAGE_URL: '画面の最後のアドレス',
        BLOCKED_REDIRECT: 'BeakSight が止めた移動の先（読む範囲の外）',
      } satisfies Record<SessionLossLandedBy, string>,
      redirectPaths: '読み込みの経路（自動の転送と画面の移動の順）',
      /** 経路のほかに記録しなかった段の数（`countText` は `formatCount` の結果）。 */
      omittedText: (countText: string): string => `ほかに ${countText} の移動を記録していません。`,
      blockedRequests: 'この読み込みの間に止めた通信',
      blockedColumns: { method: '通信の種類', originKind: 'サイト', path: 'アドレスの後ろ', reason: '理由', count: '回数' },
      storageKeyChange: '読み込みの前と後の、ログインの印の名前の違い',
      storageColumns: { storage: '置き場所', originKind: 'サイト', change: '違い', count: '名前の数', shapes: '名前の形（先頭と末尾）' },
      storageLabels: {
        LOCAL_STORAGE: 'ブラウザの保存場所（localStorage）の名前', COOKIE: 'ブラウザに残るログインの印（Cookie）の名前', INDEXED_DB: 'ブラウザの保存場所（IndexedDB）の名前',
      } satisfies Record<SessionLossStorageKind, string>,
      changeLabels: { REMOVED: '消えた', ADDED: '増えた' } satisfies Record<SessionLossKeyChange, string>,
      originKindLabels: {
        ALLOWED: '点検してよいサイト', SERVICE: 'ログインのときに通ってよい外のサイト', OTHER: 'そのほかのサイト',
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
  EXTERNAL_MAIN_FRAME_NAVIGATION: '点検してよいサイトの外への画面の移動を止めました。',
  AUDIT_EXCLUDED_URL: '読まないページ・読む範囲の外・危険な語に当たる読み込みを止めました。',
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
    description: 'サイトの名前の形が正しくありません。ID とパスワードは変えていません。',
    action: '画面を読み込み直してから、もう一度操作してください。',
  },
  CREDENTIAL_ORIGIN_INVALID: {
    description: 'ログインの設定にあるログインの画面のアドレスから、ログインのサイトのアドレスを求められません。ID とパスワードは保存していません。',
    action: 'ログインの設定で、ログインの画面のアドレスを確かめて、保存し直してください。',
  },
  CREDENTIAL_VALUE_EMPTY: {
    description: '空の欄があります。空の欄は「消す」の意味にはなりません。ID とパスワードは保存していません。',
    action: '空の欄に値を入れてください。変えない項目は、変更の画面で選ばないでください。',
  },
  CREDENTIAL_VALUE_TOO_LONG: {
    description: 'ユーザー名かパスワードが、長さの上限を超えています。ID とパスワードは保存していません。',
    action: '欄の説明にある長さまでにしてください。',
  },
  // T36c（Task 36 の設計者の判断 2）: 短い値は、自動ログインの資格情報の守りで正しく比べられないので受けない。
  CREDENTIAL_VALUE_TOO_SHORT: {
    description: 'ユーザー名かパスワードが短すぎます。短いと、自動ログインのときに値が外へ送られていないかを確かめられないため、受け付けません。ID とパスワードは保存していません。',
    action: '欄の説明にある長さ以上にしてください。',
  },
  CREDENTIAL_VALUE_MALFORMED: {
    description: 'ユーザー名かパスワードに、扱えない文字があります。ID とパスワードは保存していません。',
    action: '値を入れ直してください。',
  },
  CREDENTIAL_CHANGE_EMPTY: {
    description: '変える項目が選ばれていません。ID とパスワードは変えていません。',
    action: '「ユーザー名を変える」か「パスワードを変える」の、少なくとも一方を選んでください。',
  },
  CREDENTIAL_ALREADY_EXISTS: {
    description: 'このサイトには、もう ID とパスワードが保存されています。上書きはしていません。',
    action: '画面を読み込み直して、変更の画面から変えてください。',
  },
  CREDENTIAL_MISSING: {
    description: 'このサイトには、ID とパスワードが保存されていません。',
    action: '画面を読み込み直して、新しく登録してください。',
  },
  CREDENTIAL_STALE: {
    description:
      '保存したときのログインのサイトのアドレスが、今のログインの設定と違います。そのため、一部だけを変えることはできません。ID とパスワードは変えていません。',
    action: '「入れ直す」で、ユーザー名とパスワードの両方を入れ直してください。',
  },
  CREDENTIAL_FILE_INVALID: {
    description: '保存してある ID とパスワードのファイルが壊れているか、このサイトのものではありません。',
    action: '「保存した ID とパスワードを消す」で消してから、登録し直してください。',
  },
  CREDENTIAL_READ_FAILED: {
    description: 'ID とパスワードのファイルか、そのフォルダを読めませんでした。',
    action: 'ID とパスワードを入れるフォルダ（場所は doc/spec/local-ui.md に書いてあります）の権限を確かめてから、もう一度操作してください。',
  },
  CREDENTIAL_PLATFORM_UNSUPPORTED: {
    description: 'このパソコンは Windows でないため、ID とパスワードを保存できません。自動ログインは Windows だけで使えます。',
    action: '自動ログインを使う場合は、Windows で画面のサーバを動かしてください。',
  },
  CREDENTIAL_STORAGE_UNSAFE: {
    description: 'ID とパスワードを入れるフォルダの持ち主か権限が、今の Windows の利用者だけになっていないため、保存しませんでした。',
    action:
      'ID とパスワードを入れるフォルダ（場所は doc/spec/local-ui.md に書いてあります）の権限を、今の利用者だけに直してください。直せないときは、中身を確かめてからフォルダを別の場所へ移し、もう一度保存してください（BeakSight が新しく作って、権限を絞ります）。',
  },
  CREDENTIAL_REPLACE_FAILED: {
    description: 'ID とパスワードのファイルを置き換えられませんでした。前に保存した ID とパスワードは、そのまま残っています。',
    action: 'ほかのプログラムが ID とパスワードのファイルを開いていないかを確かめてから、もう一度保存してください。',
  },
  CREDENTIAL_DELETE_FAILED: {
    description: 'ID とパスワードのファイルを消せませんでした。',
    action: 'ほかのプログラムが ID とパスワードのファイルを開いていないかを確かめてから、もう一度消してください。',
  },
  CREDENTIAL_IN_USE: {
    description: 'このサイトの作業が動いているため、ID とパスワードを変えられません。ID とパスワードは変えていません。',
    action: '「作業の履歴」で、その作業が終わるのを待つか、止めてから、もう一度操作してください。',
  },
  PROFILE_NOT_FOUND: {
    description: 'そのサイトが見つかりません。',
    action: 'サイトの一覧を読み込み直して、どのサイトかを確かめてください。',
  },
  CREDENTIAL_NOT_ELIGIBLE: {
    description:
      'このサイトでは、この操作はできません。ID とパスワードは、点検のしかたが「ログインして見るだけの点検」か「書き込みも試す点検」で、ログインのしかたが自動ログインの、取り消していないサイトだけで使います。',
    action: 'サイトの状態、点検のしかた、ログインのしかたを確かめてください。',
  },
  AUTH_SETUP_MISSING: {
    description: 'このサイトには、まだログインの設定がありません。ID とパスワードは、ログインの設定にあるログインの画面のサイトのアドレスに結びつけて保存します。',
    action: '先にログインの設定（ログインの画面のアドレスと、自動ログインの設定）を保存してから、もう一度保存してください。',
  },
  CREDENTIAL_CONFIRMATION_MISMATCH: {
    description: '2 回入れたパスワードが同じではありません。ID とパスワードは保存していません。',
    action: 'パスワードを、2 つの欄に同じように入れ直してください。',
  },
  CREDENTIAL_PROTECTION_FAILED: {
    description: 'ID とパスワードを暗号化できませんでした（Windows の暗号化の仕組みを使います）。ID とパスワードは保存していません。',
    action: '「環境の状態」の画面で、「ID とパスワードの暗号化」の状態を確かめてから、もう一度保存してください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 自動ログインのフォームの確かめが通らなかった理由のコード（`src/control/worker-protocol.ts` の `WORKER_LOGIN_FORM_INVALID_REASONS`）ごとの、
 * 日本語の説明。書き漏れと余分は、画面の側で型で確かめる。
 */
export const LOGIN_FORM_INVALID_REASON_DESCRIPTIONS = deepFreeze({
  SELECTOR_NOT_UNIQUE: 'ユーザー名の欄、パスワードの欄、送信のボタンの部品の目印のどれかが、画面の部品のちょうど 1 つに当たりませんでした。',
  USERNAME_FIELD_INVALID: 'ユーザー名の欄が、値を入れられる入力の欄ではありませんでした。',
  PASSWORD_FIELD_INVALID: 'パスワードの欄が、パスワード用の入力の欄ではありませんでした。',
  SUBMIT_BUTTON_INVALID: '送信のボタンが、フォームを送るボタンではありませんでした。',
  NOT_SAME_FORM: 'ユーザー名の欄、パスワードの欄、送信のボタンが、同じフォームの中にありませんでした。',
  METHOD_NOT_POST: 'フォームの送り方が、値をページのアドレスに載せる形（見るだけの通信）でした。この形のフォームに値を入れると、ID とパスワードがアドレスに載ってしまいます。',
  ACTION_NOT_ALLOWED: 'フォームの送り先が、ログインの設定にあるログインの送り先と合いませんでした。',
  FORM_TARGET_NOT_SELF: 'フォームを送った結果を、別の窓か、ページの中の別の枠に開く形でした。',
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
  VALUE_CHANGED: '入れた値が、押す前に画面の処理で変えられていました（押していません）。',
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
    API_FIELDED_KEYS: '送る項目は、操作さがしで画面の欄と結びついた項目のすべてです。',
    API_UNFIELDED_KEYS: 'ページが決める項目は、画面の欄と結びつかない項目のうち、選べる項目のすべてです。',
    API_SHAPE_FILTER: '更新するデータを選ぶ項目の名前は、操作さがしで記録した送信の形にある名前です。',
    CONTRACT_DEFAULTS: '上限と書き込みの OK の期限は、初めから決まっている値です。',
    SIDE_EFFECTS_UNCONFIRMED: 'ほかへの影響の確認は、まだしていません。書き込みの OK のダイアログで 4 つの約束を読み、「書き込みの OK を出す」を押すと、確かめたことになります。',
    SINGLE_BOUND_LEDGER: '作ったデータの一覧は、この更新に結びつく登録の書き込みの手順が 1 つだけなので、それにしました。',
    ONLY_FORM_PATH_TEMPLATE: '更新の画面のアドレスの形は、選べる形が 1 つだけなので、それにしました。',
    FIRST_FORM_PATH_TEMPLATE: '更新の画面のアドレスの形は、選べる形が 2 つ以上あるので、先頭の形にしました。',
    RECORD_ID_KEY_FROM_UPDATE_FILTER: '登録したデータの番号を読む、返事の項目は、同じ表を更新するときにデータを選ぶ項目の名前から推しました。',
    READ_PAGE_TEMPLATE_FROM_READ_PATH: '答え合わせで見るページのアドレスの形は、見られたページのアドレスの後ろから推しました。',
    READ_EXPECTATION_FROM_VARYING_FIELD: '答え合わせで見る欄（ページの文にあるはずの値）は、入れる値の決まりで毎回値が変わる欄から推しました。',
    DEFAULT_RANGE_WITHOUT_HINT: '値の範囲の手がかりがない日付・数の欄なので、推した入れる値の決まりに、初めから決まっている幅を入れました。',
    HUMAN_CHOICE: '人が選んだ値です。',
    LOGIN_FIELD_SINGLE_CANDIDATE: '手でログインしたときのログインの画面で、この欄に当たる部品が 1 つだけだったので、それから作りました。入れた値は読んでいません。',
    FORM_RECORD_ID_FROM_UPDATE_CANDIDATE: '作ったデータの番号の取り方は、同じデータを更新する画面のアドレスの形から推しました。',
    ANSWER_READ_FROM_SEARCH_CANDIDATE: '答え合わせは、操作さがしで見つかった検索や一覧の画面に、作った値を入れて探す形にしました。',
    FORM_RECORD_ID_FROM_CREATE_ACTION: '作ったデータの番号の取り方は、データがまだないので、登録の送り先のアドレスの後ろに番号が付く、よくある形から推しました。',
    API_RECORD_ID_KEY_COMMON_NAME: '登録したデータの番号を読む、返事の項目は、データがまだないので、よくある番号の項目の名前から推しました。',
    READ_PAGE_TEMPLATE_COMMON_SHAPE: '答え合わせで見るページのアドレスの形は、データがまだないので、登録の画面の 1 つ上のアドレスの後ろに番号が付く、よくある形から推しました。',
    READ_PAGE_LIST_OF_CREATE_PAGE: '答え合わせは、登録の画面の 1 つ上にある一覧の画面に、作った値が出るかで見ることにしました。',
  },
} as const);

/**
 * FM2b（手を減らす段 2 の設計書 3A.2。案 2）: シナリオの下書きをボタン 1 回で作る画面の文言（発見の画面のボタンと確認のダイアログと結果、作成の画面の
 * 案内、シナリオの画面の推測の項目）。理由と状態の一覧は `src/control/approval/api-scenario-autodraft.ts`（`AUTO_DRAFT_BLOCKERS`・
 * `AUTO_DRAFT_READ_CHECK_OUTCOMES`・`AUTO_DRAFT_INFERRED_ITEMS`）。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts`。値（目印・送る値）は
 * 入れない。
 */
export const LOCAL_UI_AUTO_DRAFT_TEXT = deepFreeze({
  creating: '作っています…',
  cannotHeading: '今は、書き込みの手順の下書きを作れません',
  blockers: {
    PROFILE_NOT_EDITABLE: {
      description: 'このサイトでは、書き込みの手順を作れません。点検のしかたが「書き込みも試す点検」でないか、取り消したサイトです。',
      action: 'テスト用のサイトで、点検のしかたが「書き込みも試す点検」のサイトで行ってください。',
    },
    DISCOVERY_MISSING: {
      description: '前回の操作さがしの結果を読めないか、まだ操作さがしの記録がありません。',
      action: '「操作さがしを始める」で操作さがしをしてから、もう一度押してください。',
    },
    DISCOVERY_STALE: {
      description: '前回の操作さがしの後に、サイトの設定を変えました（操作さがしのときと今とで、何回目の変更かが違います）。',
      action: '「操作さがしを始める」でやり直してから、押してください。',
    },
    NO_WRITE_ROWS: {
      description: '前回の操作さがしの結果に、新しく登録する形・更新する形がありません。',
      action: '書き込みの画面までたどれるように、操作さがしをやり直してください。',
    },
    PREVIEW_OUTDATED: {
      description: '確かめた後に、サイトの設定か前回の操作さがしの結果が変わりました。何も作っていません。',
      action: '画面を読み込み直して、作るものをもう一度確かめてください。',
    },
  },
  /** PL-U の修正の 1 回目（設計書 14.1 の判断、U3）: 作った結果の 1 行（確認のダイアログはなくした。`countText` は `formatInteger`）。 */
  createdCount: (countText: string): string => `書き込みの手順を ${countText} 個作りました。`,
  /** PL-D2: 作った書き込みの手順が 0 個のときの 1 行（「0 個作りました」とは言わない）。 */
  noneCreated: '新しく作る書き込みの手順はありませんでした。',
  createStatuses: {
    NEW: '下書きを作ります',
    EXISTING: '既にあります（作りません）',
    REJECTED: '作れません',
  },
  createdStatus: '下書きを作りました',
  failedStatus: '保存できませんでした',
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10）: 更新で変える欄は BeakSight が決める（前は人が作成の画面で選んだ）。
  updateStatuses: {
    NEW: '更新の下書きを作ります（変える欄は BeakSight が決めます）',
    NO_CHANGED_FIELD: '更新で変えられる欄がありません（更新は試せません）',
    EXISTING: '既にあります（作りません）',
    REJECTED: '作れません',
    CREATED: '更新の下書きを作りました',
    NOT_SAVED: '更新の下書きを作れませんでした',
  },
  rulesFailed: '入れる値の決まりを付けられませんでした。入れる値の決まりの画面で決めてください。',
  openScenario: '書き込みの手順を開く',
  openCreateForm: '作成の画面で変える欄を選ぶ',
  resultHeading: '作った結果',
  // 作成の画面（更新の案内から開いたとき）。
  form: {
    chooseChangedFields: 'この書き込みの手順では、変える欄を人が必ず選びます。変える欄を 1 つ以上「変える」にしてから保存してください。保存の後に、推した入れる値の決まりを付けます。',
    chooseLedger: '作ったデータの一覧として使える、新しく登録する書き込みの手順が 2 つ以上あります。どれを使うかを選んでください。',
    noLedger: '作ったデータの一覧として使える、新しく登録する書き込みの手順がありません。操作さがしの画面の「書き込みの手順の下書きを作る」か、新しく登録する書き込みの手順を先に作ってください。',
  },
  savedWithRules: '書き込みの手順を保存し、推した入れる値の決まりを付けました。推せなかった欄は、入れる値の決まりの画面で入れてください。',
  savedRulesFailed: '書き込みの手順を保存しました。入れる値の決まりは付けられなかったので、入れる値の決まりの画面で決めてください。',
  // シナリオの画面と承認のダイアログ。
  inferredHeading: '推測した項目（確かめてください）',
  inferredItems: {
    RECORD_ID_KEY: '登録したデータの番号を読む、返事の項目',
    READ_PAGE_TEMPLATE: '答え合わせで見るページのアドレスの形',
    READ_EXPECTATION: '答え合わせで見る欄（ページの文にあるはずの値）',
    UPDATE_FORM_PATH_TEMPLATE: '更新の画面のアドレスの形（前もって選んだ先頭の形）',
    DEFAULT_RANGE_FIELD: '範囲に初めから決まっている幅を入れた欄（入れる値の決まり）',
  },
  approveInferredHeading: '推測した項目が残っています',
  // PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1 の「決められないとき」）: フォームの形の下書きの時点で出す、決められなかった理由（1 行）。
  formGaps: {
    RECORD_ID_NOT_FOUND: '作ったデータを後で探せません（更新は試せません）。同じデータを更新する画面が、操作さがしで見つかりませんでした。',
    ANSWER_READ_NO_CANDIDATE: '答え合わせに使える検索や一覧の画面が、操作さがしで見つかりませんでした。書き込みの結果を確かめられません。',
    ANSWER_READ_NO_TEXT_FIELD: '検索や一覧の画面か書き込みの画面に、文字を入れる欄がありません。書き込みの結果を確かめられません。',
  },
  // PL-6b: 書き換えの答え合わせを、作ったデータの一覧の書き込みの手順から写せない理由（1 行）。
  updateCopyUnavailable: {
    LEDGER_READ_VERIFICATION_MISSING: '作ったデータの一覧の書き込みの手順に答え合わせがないので、更新の答え合わせを写せません。',
    LEDGER_READ_CHECK_UNUSABLE: '作ったデータの一覧の書き込みの手順の答え合わせは、更新には使えない形なので、写せません。',
    CHANGED_FIELD_NOT_TEXT: '変える欄に文字の欄がないので、作った値で探す答え合わせはできません（更新した後の答え合わせはします）。',
  },
} as const);

/** ローカルの管理画面の、資格情報の画面の文言（Task 26 の設計書 4.2、4.7。T26e）。値（ユーザー名とパスワード）は、どの文言にも入れない。 */
export const LOCAL_UI_CREDENTIAL_TEXT = deepFreeze({
  pages: {
    credentials: 'ID とパスワード（自動ログイン）',
  },
  /** プロファイルの詳細の、資格情報とログインの確かめへの案内。 */
  profileDetail: {
    open: 'ID とパスワードの画面を開く',
    // T26g-3: 自動ログインでないプロファイルに、資格情報のファイルが残っているとき（プロファイルの詳細の画面の案内）。
    leftover: '保存した ID とパスワードが残っています。このサイトでは使わないので、ID とパスワードの画面から消してください。',
  },
  // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章。作業記録 UX-1 の画面 C の 9 章の 1・3・4）: 入力の欄がある画面だけに出す、テスト用のアカウントだけを
  // 入れることと保存の場所（DPAPI・Git・リポジトリの語を外した）。
  testAccountOnlyHeading: 'テスト用のアカウントだけを入れてください',
  testAccountOnlyBody:
    '本番のパスワードは入れないでください。入れた ID とパスワードは、このパソコンの中に、今のユーザーだけが開ける形で保存します。画面にも記録にも出しません。消すか、サイトを取り消すまで残ります。',
  browserSaveNote: 'ブラウザが「パスワードを保存しますか」と聞いたら、保存しないを選んでください。',
  /**
   * PL-4（設計書 3 章の 1・2）: ID とパスワードの画面の要点の行（日時・改訂・Origin・暗号化の行は出さない。ログインする先はホストだけ）。止めているときの
   * することは `AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS` の `action`。
   */
  summary: {
    saved: '自動ログインを使っています。ID とパスワードはこのパソコンの中に、今のユーザーだけが開ける形で保存しています。',
    notSaved: '自動ログインに使う ID とパスワードが、まだ保存されていません。',
    /** ログインする先（`hostText` はログインの画面のホストだけ）。 */
    destination: (hostText: string): string => `ログインする先: ${hostText} のログインの画面です。`,
    /** 止めている（`reasonText` は自動ログインの結果のラベル）。 */
    held: (reasonText: string): string => `前の自動ログインがうまくいかなかったため、自動ログインを止めています（${reasonText}）。`,
  },
  status: {
    readFailedHeading: '保存した ID とパスワードを読めません',
  },
  /** PL-4（作業記録 UX-1 の画面 C の S4）: 手でログインするサイトで、ログインの設定がまだないとき（主のボタンは「点検を始める」）。 */
  notEligibleManual: '先に 1 回、手でログインして点検してください。そのあと自動ログインにできます。',
  /** PL-4: 公開の画面だけを点検するサイト（ボタンなし）。 */
  notEligiblePublic: 'このサイトはログインしないので、ID とパスワードは要りません。',
  retired: '取り消したサイトには、ID とパスワードを保存できません。保存してある ID とパスワードは、消せます。',
  // T26g-2 round 1: 自動ログインでないプロファイルに、資格情報のファイルが残っているとき（削除の操作だけを出す）。
  leftoverNotEligible: '保存した ID とパスワードが残っています。このサイトでは使わないので、消してください。',
  unavailableHeading: 'このパソコンでは、ID とパスワードを保存できません',
  authSetupMissingHeading: '先にログインの設定を保存してください',
  authSetupMissingBody:
    'ID とパスワードは、ログインの設定にあるログインの画面のサイトのアドレスに結びつけて保存します。ログインの画面のアドレスと自動ログインの設定を、先に保存してください。',
  openAuthSetup: 'ログインの設定を開く',
  inUseHeading: 'このサイトの作業が動いています',
  inUseBody: 'このサイトの作業が終わるまで、ID とパスワードを変えることも消すこともできません。',
  /** 欄の長さの説明（`minText`・`maxText` は単位のない整数の書式 `formatInteger` の結果。T36c で下限を足した。T36R-fix で DEF-123 を直した）。 */
  valueLengthHint: (minText: string, maxText: string): string => `${minText} 文字以上、${maxText} 文字まで。`,
  username: 'ユーザー名',
  password: 'パスワード',
  passwordConfirmation: 'パスワード（確かめのため、もう一度）',
  register: {
    body: 'ユーザー名とパスワードの両方を入れてください。パスワードは、打ち間違いでログインに失敗したり、アカウントがロックされて使えなくなったりしないように、2 回入れます。',
    submit: '登録する',
    submitting: '登録しています…',
    done: 'ID とパスワードを登録しました。',
  },
  change: {
    heading: 'ID とパスワードを変える',
    legend: '変える項目',
    changeUsername: 'ユーザー名を変える',
    changePassword: 'パスワードを変える',
    newUsername: '新しいユーザー名',
    newPassword: '新しいパスワード',
    newPasswordConfirmation: '新しいパスワード（確かめのため、もう一度）',
    unchangedNote: '選ばなかった項目は、保存してある値をそのまま使います。',
    submit: '変更する',
    submitting: '変更しています…',
    done: 'ID とパスワードを変更しました。',
  },
  replace: {
    body: 'ログインする先が変わりました。ユーザー名とパスワードの両方を入れ直してください。',
    submit: '入れ直す',
    submitting: '入れ直しています…',
    done: 'ID とパスワードを入れ直しました。',
  },
  clearHold: {
    label: '自動ログインの停止も解く',
    hint: 'テスト用のサイトのアカウントの状態（ロックが解けているか、パスワード、2 段階の確認など）を確かめた場合だけ選んでください。ID とパスワードを変えただけでは、停止は解きません。',
    done: '自動ログインの停止も解きました。',
  },
  remove: {
    open: '保存した ID とパスワードを消す',
    title: '保存した ID とパスワードを消しますか',
    body: '消すと、もう一度登録するまで、このサイトでは自動ログインを使えません。',
    confirm: '消す',
    cancel: 'やめる',
    done: '保存した ID とパスワードを消しました。',
  },
  rejectedHeading: 'ID とパスワードを保存できませんでした',
  removeRejectedHeading: '保存した ID とパスワードを消せませんでした',
  /** 環境の状態の画面の項目。 */
  environment: {
    protection: 'ID とパスワードの暗号化（自動ログイン）',
  },
} as const);

/** ローカルの管理画面の、ログインの確かめの画面と、ジョブの画面の自動ログインの文言（Task 26 の設計書 4.6。T26e）。 */
export const LOCAL_UI_LOGIN_CHECK_TEXT = deepFreeze({
  /**
   * PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 1、6 章の最後）: ログインの確かめの画面は、止めた自動ログインを再開する入口としてだけ残す
   * （ふだんの流れからは行かない。点検の最初の自動ログインが、ログインの確かめを兼ねる）。画面の題と、要点のパネルの文。ログインだけを試すボタンはなくした
   * （試すと自動ログインの間隔に当たり、すぐに点検を始められない。点検で兼ねる）。
   */
  title: '自動ログインの再開',
  summary: {
    notHeld: '自動ログインは止まっていません。点検を始めると、最初の自動ログインで、ログインできるかも確かめます。',
    notAutomated: 'このサイトは、自動ログインを使いません。この画面ですることはありません。',
  },
  /**
   * 上限の説明（`intervalText` と `windowText` は `formatElapsedTime`、`countText` は `formatTimes` の結果）。PL-4: 「1日 10回まで」の形にした（前は
   * 「24時間 の間に 10回 まで」）。
   */
  limitNote: (intervalText: string, windowText: string, countText: string): string =>
    `アカウントを守るため、自動ログイン（点検の前のログインも数えます）は、同じサイトで ${intervalText}に 1回、${windowText} ${countText}までです。成功しなかったときは、アカウントのロックを避けるため、あなたが確かめて停止を解くまで、自動ログインを止めます。`,
  nextAllowedAt: '次に始められる日時',
  openCredentials: 'ID とパスワードの画面を開く',
  hold: {
    // PL-3: 要点のパネルの文（なぜ止まったか。確かめることは、止めた理由ごとの「人がすること」）。
    summary: '自動ログインがうまくいかなかったので、アカウントを守るため、自動ログインを止めています。下の「人がすること」を確かめてから、再開してください。',
    reason: '止めた理由',
    heldAt: '止めた日時',
    action: '人がすること',
    clear: '確かめたので再開する',
    dialogTitle: '自動ログインを再開しますか',
    dialogBody:
      'テスト用のサイトのアカウントの状態（ロックが解けているか、パスワード、2 段階の確認など）と、保存した ID とパスワード、ログインの設定を確かめた場合だけ、再開してください。再開しても、自動ログインどうしの間隔と、サイトが示した待つ時間は守ります。',
    confirm: '再開する',
    cancel: 'やめる',
    cleared: '自動ログインの停止を解きました。',
    notHeld: '自動ログインは止めていませんでした。',
  },
  /** ジョブの画面の自動ログインの欄。 */
  job: {
    kind: '作業の種類',
    heading: '自動ログイン',
    result: '結果',
    pending: 'まだ結果はありません',
    submitted: 'ログインの送信',
    retryAfterUntil: 'サイトが示した、次に試してよい日時',
    formInvalidReason: 'フォームの確かめで止めた理由',
    action: '人がすること',
    // PL-3: ログインの確かめの画面は、止めた自動ログインを再開する入口（`LOCAL_UI_AUTH_TEXT.start.openLoginCheck` と同じ語）。
    openLoginCheck: LOCAL_UI_AUTH_TEXT.start.openLoginCheck,
  },
} as const);

// ---------------------------------------------------------------------------------------------------------------
// プロファイルの「次にすること」と、保存の後の次の手順（T43a。Task 43 の設計書 4.1）
// ---------------------------------------------------------------------------------------------------------------

/**
 * サイトの画面の要点のパネル（今の様子の文、主のボタンと二次のボタン）と、サイトの一覧の行の短い文、保存の後の次の手順のリンクの文言（T43a で作り、PL-1
 * で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に置き換えた）。段とボタンの一覧は `apps/local-ui/src/display/next-steps.ts` の `PROFILE_STAGES`・
 * `PROFILE_ACTIONS`（書き漏れと余分は `catalog-coverage.ts`）。始められない理由の説明と手順は `AUDIT_JOB_START_REJECTION_DESCRIPTIONS`、入口の確かめの後の
 * 認証の設定の状態の理由は `LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT`。
 */
export const LOCAL_UI_NEXT_STEP_TEXT = deepFreeze({
  /** 要点のパネルの見出し。 */
  summaryHeading: '今の様子',
  /** 段ごとの、今の様子の文（やさしい言葉で 1〜2 文）。 */
  stages: {
    SITE_RETIRED: LOCAL_UI_TEXT.profileForm.retiredNotice,
    ENTRY_NOT_CHECKED:
      'ログインの画面をまだ見つけていません。「サイトの下調べをやり直す」を押すと、開始のアドレスのページを 1 回だけ読んで調べます（ログインも書き込みもしません）。',
    AUTH_SETUP_CREATE: 'ログインの設定を、BeakSight が自動で作れませんでした。「ログインの設定を開く」から作ってください。',
    AUTH_SETUP_FIX: 'ログインの設定を直してから、点検を始めます。',
    CREDENTIAL_FIX: '自動ログインに使う ID とパスワードを入れ直してから、点検を始めます。',
    AUTO_LOGIN_WAIT: '自動ログインは、続けては行えません（サイトとアカウントを守る決まりです）。',
    AUTO_LOGIN_HELD:
      '前の自動ログインがうまくいかなかったため、自動ログインを止めています。テスト用のアカウントと、保存した ID とパスワードを確かめてから、停止を解いてください。',
    BLOCKED: '今は、このサイトで点検を始められません。',
    AUDIT_PUBLIC: '公開の画面を点検します。「点検を始める」を押してください。',
    AUDIT_MANUAL_LOGIN: 'ログインの画面が見つかりました。次は、点検を始めて、開いたブラウザで手でログインします。',
    AUDIT_AUTOMATED_LOGIN:
      '次の点検から、BeakSight が自動でログインします。ログインに失敗したときは、点検は止まり、作業の画面に理由が出ます。',
    // OP-2: 「書き込みも試す」と「書き込みの手順へ」の段は外した（書き込みは、下の一覧でチェックした画面だけ、点検の中で行う）。
    AUDIT_AGAIN: '前回の点検が終わりました。もう一度点検するときは、「点検を始める」を押してください。',
  },
  /**
   * OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 点検から移ってきたときの段の文（要点の 1 行目が点検の結果の 1 行なので、
   * 「点検が終わりました」を繰り返さない）。ない段は `stages` のまま。
   */
  afterAuditArrival: {
    AUDIT_AGAIN: 'もう一度点検するときは、「点検を始める」を押してください。',
  },
  /** 自動ログインの間隔の中の、始められる時刻（`dateText` は `formatPlainDateTime` の結果。OP-3）。 */
  waitUntil: (dateText: string): string => `${dateText} から始められます。`,
  /**
   * OP-G（指示書の 4）: サイトの画面の要点の、自動ログインの間隔の中の 1 行（段の文と始められる時刻を 1 行にまとめる。`dateText` は `formatPlainDateTime` の結果）。
   */
  autoLoginWaitUntil: (dateText: string): string => `自動ログインは続けては行えないため（サイトとアカウントを守る決まりです）、${dateText} から始められます。`,
  /** 自動ログインの間隔の中で、始められる時刻が分からないとき。 */
  waitUnknown: '少し時間をおいてから、もう一度この画面を開いてください。',
  /** ボタンの名前（行き先ごと）。 */
  actions: {
    RECHECK_ENTRY: RECHECK_ENTRY_ACTION_TEXT,
    AUTH_SETUP: LOCAL_UI_AUTH_TEXT.profileDetail.open,
    CREDENTIAL: LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open,
    AUDIT_START: LOCAL_UI_AUDIT_TEXT.profileList.startAudit,
    SCENARIOS: '書き込みの手順へ',
    CLEAR_HOLD: '自動ログインの停止を解く',
    // PL-U（設計書 14.1 の U2）: 最新の点検の報告を開く（作業の画面の主のボタンと同じ語）。
    AUDIT_RESULT: LOCAL_UI_JOB_SUMMARY_TEXT.openResult,
  },
  /** 入口を確かめ直すボタンの、押すと何をするかの文（詳しい内容の中）。 */
  entryCheckNote: '開始のアドレスのページを 1 回だけ読み、ログインの画面かを調べ直します（ログインも書き込みもしません）。',
  /** 詳しい内容の中の、ほかの画面への入口の見出し。 */
  otherScreensHeading: 'ほかの画面',
  /** サイトの一覧の行の、段ごとの短い文。 */
  listStages: {
    SITE_RETIRED: '取り消してあります',
    ENTRY_NOT_CHECKED: 'サイトの下調べが要ります',
    AUTH_SETUP_CREATE: 'ログインの設定が要ります',
    AUTH_SETUP_FIX: 'ログインの設定を直す必要があります',
    CREDENTIAL_FIX: 'ID とパスワードを入れ直す必要があります',
    AUTO_LOGIN_WAIT: '自動ログインの間隔を待っています',
    AUTO_LOGIN_HELD: '自動ログインを止めています',
    BLOCKED: '今は点検を始められません',
    AUDIT_PUBLIC: '次は点検です',
    AUDIT_MANUAL_LOGIN: '次は点検です（手でログインします）',
    AUDIT_AUTOMATED_LOGIN: '次は点検です（自動でログインします）',
    AUDIT_AGAIN: '点検が終わっています',
  },
  /** サイトの一覧の行の、サイトの画面へ進むボタン。 */
  continue: '続ける',
  /** 保存の後に出す、次の手順のリンク（ほかの画面）。 */
  after: {
    heading: '次の手順',
    openOverview: 'サイトの画面で次にすることを見る',
    actions: {
      AUTH_SETUP: LOCAL_UI_AUTH_TEXT.profileDetail.open,
      CREDENTIAL: 'ID とパスワードを登録する',
      // PL-T: ログインの確かめの画面は、止めた自動ログインを再開する入口だけ（設計書 PL 6 章の最後）。
      LOGIN_CHECK: LOCAL_UI_AUTH_TEXT.start.openLoginCheck,
      AUDIT_START: LOCAL_UI_AUDIT_TEXT.profileList.startAudit,
    },
  },
} as const);

/**
 * 実行の許可の発行を拒む理由ごとの説明と手順（T30g。理由の一覧は `src/control/approval/execution-grant.ts` の `EXECUTION_GRANT_REJECTION_REASONS`。
 * 書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts` が型で確かめる）。書き込みの開始の画面が使う。消費と確かめ直しの理由も、一覧に
 * あるので並べる（画面の開始では、ジョブの管理が `WRITE_GRANT_REJECTED` として返す）。
 */
export const EXECUTION_GRANT_REJECTION_DESCRIPTIONS = deepFreeze({
  GRANT_SCENARIO_NOT_FOUND: { description: '書き込みの手順が見つかりません。書き込みは始めていません。', action: '書き込みの手順の一覧を読み込み直してください。' },
  GRANT_REVISION_CONFLICT: {
    description: 'この画面を開いた後に、書き込みの手順が変わりました。書き込みは始めていません。',
    action: '画面を読み込み直して、今の内容を確かめてから、もう一度始めてください。',
  },
  GRANT_APPROVAL_INVALID: {
    description: '書き込みの OK が、今は使えません（理由を下に示します）。書き込みは始めていません。',
    action: '書き込みの手順の画面で理由を確かめ、必要なら書き込みの OK を出し直してください。',
  },
  NEEDS_RULE_INPUT: {
    description: '入れる値の決まりがまだない欄があります。書き込みは始めていません。',
    action: '入れる値の決まりの画面で、送る欄すべての決まりを作ってください。',
  },
  VERIFICATION_SPEC_MISSING: {
    description: '結果の確かめ方（成功の条件・入れた値の誤りの条件・登録したデータの番号の取り方・答え合わせ）に、まだ決めていない項目があります。書き込みは始めていません。',
    action: '書き込みの手順を変える画面で、結果の確かめ方をすべて決めて保存し、書き込みの OK を出し直してください。',
  },
  GRANT_ENVIRONMENT_EVIDENCE_MISSING: {
    description: 'サイトの設定に、テスト用のサイトであることを確かめた記録の参照がありません。書き込みは始めていません。',
    // MI-8（設計書 4.9）: プロファイルの編集は、プロファイルの詳細の「詳しい設定」の中にある（MI-1）。
    action: `サイトの画面の${ADVANCED_SETTINGS_REF_TEXT}（サイトの設定）で、テスト用のサイトであることを確かめた記録の参照を入れてください。`,
  },
  GRANT_WRITE_INTERVAL_NOT_ELAPSED: {
    description: '同じ書き込みの手順の前回の書き込みから、決まった間隔が経っていません。書き込みは始めていません。',
    action: '次に始められる時刻の後に、もう一度始めてください。',
  },
  GRANT_DAILY_WRITE_LIMIT_REACHED: {
    description: '同じ書き込みの手順で、24 時間の間に書き込んだ件数が上限に達しています。書き込みは始めていません。',
    action: '次に始められる時刻の後に、もう一度始めてください。',
  },
  GRANT_ALREADY_OPEN: {
    description: 'この書き込みの手順には、まだ使っていない書き込みの OK があります。書き込みは始めていません。',
    action: '少し待ってから（この OK の期限は短い時間です）、画面を読み込み直して、もう一度始めてください。',
  },
  GRANT_WRITE_CONCURRENCY_EXCEEDED: {
    description: 'ほかの書き込みが動いています（書き込みは同時に 1 つだけです）。書き込みは始めていません。',
    action: '動いている書き込みが終わってから、もう一度始めてください。',
  },
  GRANT_RUN_LIMIT_EXCEEDED: { description: '1 回で書き込める件数の上限を超えます。書き込みは始めていません。', action: '書き込みの手順の上限を確かめてください。' },
  GRANT_CUMULATIVE_LIMIT_REACHED: {
    description: '合計の上限に達しています（これから送る分・送った分・送ったか分からない分を数えます）。書き込みは始めていません。',
    action: 'これ以上は書き込めません。上限を変えるときは、書き込みの手順を変えて、書き込みの OK を出し直してください（初めから決まっている値以下だけ）。',
  },
  GRANT_FACTS_CHANGED: {
    description: '確かめている間に、操作さがしの結果が記録されました。書き込みは始めていません。',
    action: '画面を読み込み直してから、もう一度始めてください。',
  },
  GRANT_NOT_FOUND: { description: '書き込みの OK が見つかりません。書き込みは始めていません。', action: '画面を読み込み直してから、もう一度始めてください。' },
  GRANT_MISMATCH: { description: '書き込みの OK が、この書き込みの手順と作業のものではありません。書き込みは始めていません。', action: '画面を読み込み直してから、もう一度始めてください。' },
  GRANT_EXPIRED: { description: '書き込みの OK の期限が過ぎました。書き込みは始めていません。', action: 'もう一度始めてください。' },
  GRANT_ALREADY_CONSUMED: { description: '書き込みの OK は、もう使われています。', action: '書き込みの履歴を確かめてください。' },
  GRANT_INVALIDATED: { description: '書き込みの OK は、取り消されたか期限が切れたため、使えなくなりました。', action: '書き込みの手順の状態を確かめてから、もう一度始めてください。' },
  GRANT_NOT_CONSUMED: { description: '書き込みの OK が、まだ使われていません。', action: '画面を読み込み直してください。' },
  GRANT_RESERVATION_SETTLED: { description: '書き込みの OK の取り置きは、もう締められています。', action: '書き込みの履歴を確かめてください。' },
  GRANT_CLOCK_BEFORE_APPROVAL: {
    description: 'このパソコンの時計が、書き込みの OK を出した時刻より前を指しています。書き込みは始めていません。',
    action: 'このパソコンの時計を確かめてから、もう一度始めてください。',
  },
  GRANT_CLOCK_BEFORE_ISSUE: {
    description: 'このパソコンの時計が、書き込みを始める準備をした時刻より前を指しています。書き込みは始めていません。',
    action: 'このパソコンの時計を確かめてから、もう一度始めてください。',
  },
  // T31e（Task 31 の設計書 3 章の「対象の選び方」）: UPDATE の対象の選び直し（文言の確かめは T31h）。
  TARGET_SELECTION_CHANGED: {
    description: 'この画面を開いた後に、更新する予定のデータが変わりました（新しく登録したデータがあったなど）。書き込みは始めていません。',
    action: '画面を読み込み直して、更新する予定のデータを確かめてから、もう一度始めてください。',
  },
  TARGET_RECORD_UNAVAILABLE: {
    description: '更新できるデータ（結びつけた新しく登録する書き込みの手順で、BeakSight が登録して答え合わせが合ったもの）がありません。書き込みは始めていません。',
    action: '結びつけた新しく登録する書き込みの手順で、登録の書き込みを答え合わせまで済ませてから、もう一度始めてください。',
  },
  // T31R-fix-1 の I-2: 発行の確かめ直し（下書きの保存の後に、台帳の登録の ID の取り方が変わった）。
  SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID: {
    description: '作ったデータの一覧（結びつけた新しく登録する書き込みの手順）で、登録したデータの番号の取り方が変わりました。そのため、この更新の手順のアドレスの形で、番号を入れる所に合わなくなりました。書き込みは始めていません。',
    action: 'この書き込みの手順を変更して、作ったデータの一覧の番号の取り方に合うアドレスの形を選び、書き込みの OK を出し直してください。',
  },
  // T41b: 発行の確かめ直し（下書きの保存の後に、台帳の登録の ID を読む応答の鍵が変わった）。
  SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID: {
    description: '作ったデータの一覧（結びつけた新しく登録する書き込みの手順）の今の内容では、登録したデータの番号で、更新するデータを選べなくなりました（送り先のアドレスが違うか、番号を読む返事の項目の名前が、データを選ぶ項目の名前と違います）。書き込みは始めていません。',
    action: '登録の送り先と番号の項目の名前を合わせるか、同じ表の作ったデータの一覧を選んでこの書き込みの手順を変更し、書き込みの OK を出し直してください。',
  },
  // MI-F1（設計書 4.7.1 の 5）: シナリオの今の版の副作用の確認が済んでいない（承認の判定と別の多重の守り）。
  SCENARIO_SIDE_EFFECTS_UNCONFIRMED: {
    description: 'この書き込みの手順の今の内容は、ほかへの影響の確認が済んでいません。書き込みは始めていません。',
    action: '書き込みの手順の画面で、ほかへの影響を確かめて、書き込みの OK を出し直してください。',
  },
  // T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: 照合の READ の期待が、実行のたびに変わる値と比べない。
  READ_VERIFICATION_NOT_VARYING: {
    description: '答え合わせで見るページ（番号の入るアドレスの形）で比べる欄が、毎回同じ値になる欄（値が 1 つだけの決まった一覧など）だけです。別のデータのページを見ても合ってしまうことがあるので、書き込みは始めていません。',
    action: '比べる欄を、BeakSight が作った値の欄（毎回変わる欄）にするか、その欄の入れる値の決まりを、値が 2 つ以上になる作り方にしてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/**
 * 書き込みの開始を、画面のサーバが拒む理由ごとの説明と手順（T30g。理由の一覧は `apps/local-ui/src/server/write-job-functions.ts` の
 * `WRITE_START_LOCAL_REJECTION_REASONS`）。
 */
export const WRITE_START_LOCAL_REJECTION_DESCRIPTIONS = deepFreeze({
  WRITE_SCENARIO_NOT_FOUND: { description: '書き込みの手順かサイトが見つかりません。書き込みは始めていません。', action: '書き込みの手順の一覧を読み込み直してください。' },
  // T31h-2: 更新（UPDATE）も画面から始められるようになったので、登録の開始の口の理由として書き直した。
  WRITE_KIND_NOT_CREATE: {
    description: '新しく登録する書き込みを始められるのは、新しく登録する書き込みの手順だけです。書き込みは始めていません。',
    action: '書き込みの手順の画面を読み込み直して、その画面の「書き込みを始める画面を開く」から始めてください。',
  },
  WRITE_FACTS_UNAVAILABLE: {
    description: 'サイトの設定のファイルか、保存した ID とパスワードが何回目の変更かを読めないため、書き込みの OK の状態を確かめられません。書き込みは始めていません。',
    action: '設定のファイルの場所と中身（自動ログインなら ID とパスワードの画面）を確かめてから、もう一度始めてください。',
  },
  // T31h-2: 更新（UPDATE）の開始の口に、UPDATE でないシナリオが来た。
  WRITE_KIND_NOT_UPDATE: {
    description: '更新の書き込みを始められるのは、更新の書き込みの手順だけです。書き込みは始めていません。',
    action: '書き込みの手順の画面を読み込み直して、その画面の「書き込みを始める画面を開く」から始めてください。',
  },
} as const satisfies Record<string, ControlReasonText>);

/** ローカルの管理画面の、書き込みの文言（Task 30 の設計書 2 章、3 章、10 章。T30g）。 */
export const LOCAL_UI_WRITE_TEXT = deepFreeze({
  pages: {
    writeStart: '書き込みを始める',
  },
  // 検証の指定の入力（シナリオのフォーム）。
  verificationHeading: '結果の確かめ方',
  // PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1）: 成否は BeakSight が、答え合わせと送った後の画面の形で確かめる（成功の条件と入力の誤りの条件の欄はない）。
  verificationNote:
    '書き込みの結果は、BeakSight が、答え合わせと、送った後の画面の形（同じ入力の画面が、入れた値のまま出たか）で確かめます。ここでは、登録の ID の取り方と答え合わせを決めます。決めていない項目があっても、保存と書き込みの OK はできます。ただし、書き込みは始められません。値には、ページの作り（アドレスの後ろと部品の目印）だけを書きます。',
  /** T40a-fix: API のシナリオの検証の指定の説明（成否の条件と入力の誤りの条件は使わないので、欄を出さない）。 */
  apiVerificationNote:
    '画面を通さずに送る書き込みの手順は、送った後にサイトから返ってきた答えの状態と、取れた登録の ID で結果を確かめます。登録の ID は、返ってきた答えの中の項目か、ここの取り方のどちらかで決めます。',
  /**
   * T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行。使える度合い）: 画面から登録の ID を取る型が、書き込みの画面の path にも当たるときの注意（保存は
   * 拒まない）。保存の画面とシナリオの詳細の画面が出す。
   */
  recordIdPatternCaution:
    'この ID の形は、書き込みの画面（登録の画面）のアドレスの後ろにも当たります。書き込みの前の画面の一部を ID と取り違えないよう、登録の ID は、返ってきた答えの項目から取る形を勧めます。',
  recordIdSource: '取り方',
  recordIdUnset: '指定しない',
  recordIdValue: '形か部品の目印',
  readVerificationCheck: '答え合わせに使う見るだけの確かめ',
  readVerificationUnset: '指定しない',
  /** 照合の READ の定義の選択肢（`revisionText` は `formatInteger` の結果）。 */
  readVerificationOption: (readCheckId: string, revisionText: string): string => `${readCheckId}（${revisionText} 回目の変更）`,
  bindingsHeading: '作った値と結び付ける送る値',
  bindingsNote: '見るだけの確かめの送る値のうち、登録した値で探すものを、書き込みの手順の送る欄に結び付けます（1 つ以上）。',
  bindingUnset: '結び付けない',
  /** 結び付けの欄の名前（READ の定義の送る値の名前）。 */
  bindingLabel: (parameterName: string): string => `送る値 ${parameterName}`,
  expectationsHeading: 'あるはずのもの',
  expectationKind: '確かめる中身の種類',
  expectationCount: '行の数',
  expectationField: '詳細の項目の名前',
  expectationFieldName: '比べる値（送る欄）',
  addExpectation: 'あるはずのものを足す',
  removeExpectation: 'この項目を外す',
  noReadChecks: 'このサイトには、答え合わせに使える見るだけの確かめがありません。',
  writesHeading: '書き込みの履歴',
  noWrites: 'まだ書き込んでいません。',
  targetRecord: '更新するデータ',
  targetRecordNote: '新しく登録する書き込みの手順で、BeakSight が登録して答え合わせが合ったデータのうち、いちばん新しいものです。始めるときに選び直し、この画面と違えば始めません。',
  changedFields: '変える欄',
  keptFields: '変えない欄',
  startDialogUpdateBody: 'テスト用のサイトのデータ 1 件を更新します。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
  scenario: '書き込みの手順',
  revision: '何回目の変更か',
  fields: '送る欄',
  action: '送り先',
  perRun: '1 回で 1 件',
  /** 累積の残り（`usedText`・`limitText`・`remainingText` は `formatCount` の結果）。 */
  cumulativeValue: (usedText: string, limitText: string, remainingText: string): string => `使った件数 ${usedText} / 上限 ${limitText}（残り ${remainingText}）`,
  cumulative: '合計の上限',
  schedule: '間隔と回数の上限',
  /** 連続の上限の表示（`intervalText` は分、`perDayText` と `remainingText` は `formatCount` の結果）。 */
  scheduleValue: (intervalText: string, perDayText: string, remainingText: string): string =>
    `最後の書き込みから ${intervalText} 分あける・24 時間に ${perDayText}まで（残り ${remainingText}）`,
  nextAllowedAt: '次に始められる時刻',
  nextAllowedNow: '今すぐ始められます',
  notification: 'メールなどの通知',
  notificationConfirmed: 'メールや電話への知らせが送られない設定であることを、書き込みの OK の前に確かめました。',
  notificationUnconfirmed: 'メールなどの通知が送られないことを、まだ確かめていません。',
  evidence: 'テスト用のサイトであることの記録',
  evidencePresent: 'このサイトの設定に、テスト用のサイトであることを確かめた記録の参照があります。',
  evidenceMissing: 'このサイトの設定に、テスト用のサイトであることを確かめた記録の参照がありません。',
  approval: '書き込みの OK の状態',
  start: '書き込みを始める',
  starting: '始めています…',
  startRejectedHeading: '書き込みを始められませんでした',
  startDialog: {
    title: '書き込みを始めますか',
    body: 'テスト用のサイトに、新しく登録するデータを 1 件送ります。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
    confirm: '書き込みを始める',
    cancel: 'やめる',
  },
  // 結果。
  resultHeading: '書き込みの結果',
  /** T44e（Task 44 の設計書 P2-4）: 送る前の確かめで止めた具体的な理由の欄の見出し。 */
  precheckDetailHeading: '送らずに止めた理由',
  resultPending: 'まだ結果が決まっていません。',
  // PL-S（設計書 7 章）: 書き込みの結果が分からない（`UNKNOWN`）ときの文を、やさしい言葉に直した（書き込みの報告の知らせも同じ文を使う）。
  unknownHeading: '送ったかどうか分かりません',
  unknownBody:
    'テスト用のサイトでデータがあるか確かめてください。BeakSight は成功とは見なしていません。この 1 件は使った数に入ります。自動では送り直しません。',
  /** PL-S（設計書 7 章）: 書き込みの後の作業の画面の要点（BeakSight はデータを消さない）。 */
  noCleanup: '作ったデータは消しません。片付けはテスト用のサイトの管理者に頼んでください。',
  partialHeading: '答え合わせができていません',
  partialBody: '成功の画面は出ましたが、登録の ID か、見るだけの確かめでの答え合わせで、確かめられていません。テスト用のサイトで、登録の内容を確かめてください。',
  // T31h-2: 更新（UPDATE）の結果。
  partialUpdateBody: '成功の画面は出ましたが、取れた ID か、更新の後の答え合わせで、確かめられていません。テスト用のサイトで、このデータの内容を確かめてください。',
  diffHeading: '更新の前と後',
  diffNote: '変えた欄は、更新の前に読んだ値と、送った新しい値を出します。変えない欄は値を残さないので、更新の後も同じだったかだけを出します。',
  changedDiffHeading: '変えた欄',
  keptDiffHeading: '変えない欄',
  noUpdateEvidence: '更新の後の答え合わせの記録がありません。',
  diffColumns: {
    field: '欄',
    previous: '前の値',
    next: '新しい値',
    matched: '更新の後の答え合わせ',
  },
  matchedValue: '一致',
  notMatchedValue: '一致しない',
  undeterminedValue: '答え合わせできない',
  columns: {
    job: '作業',
    result: '結果',
    reason: '理由',
    submission: '送信',
    blockReason: '止めた理由',
    httpStatus: 'サイトからの答えの状態の番号',
    responseJudgement: 'サイトからの答えの判定',
    recordId: '登録の ID',
    // T31h-2: 更新（UPDATE）の対象のレコードの ID と、成功の後に取れた ID。
    target: '更新の対象のデータ',
    obtainedId: '取れた ID',
    readVerification: '答え合わせ（見るだけの確かめ）',
    reservation: '上限の件数の扱い',
    recordedAt: '記録した日時',
    submittedAt: '送った日時',
    settledAt: '結果を決めた日時',
  },
  notApplicable: 'なし',
  submittedValuesHeading: '送った値（作り物のテストデータ）',
  noSubmittedValues: '送った値はありません。',
  openJob: '作業の様子を見る',
  /**
   * T40d（Task 40 の設計書 3.4、3.5）: 送り方と API の要約の項目名と文言（書き込みの結果・履歴・開始の画面と、書き込みの報告が共用する。送り方の値の
   * ラベルは `SCENARIO_TRANSPORT_CATALOG`）。シナリオの画面と同じ意味の項目名は、`LOCAL_UI_SCENARIO_TEXT.api` の値をそのまま使う。
   */
  api: {
    heading: '画面を通さない送信の形（書き込みの OK を出した形）',
    transport: LOCAL_UI_SCENARIO_TEXT.api.transport,
    method: LOCAL_UI_SCENARIO_TEXT.api.method,
    origin: LOCAL_UI_SCENARIO_TEXT.api.origin,
    pathShape: LOCAL_UI_SCENARIO_TEXT.api.pathShape,
    shapeDigest: '形の照らし合わせ用の文字列',
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
      '書き込みの結果は、人が決める成功の条件や入力の誤りの条件を使わずに決めます（画面で送る書き込みも同じです）。画面を通さずに送る書き込みは、サイトから返ってきた答えの種類（うまくいった、送る回数が多すぎる、入力の誤り、サイトの側の誤り）と、取れた登録の ID で結果を決めます。「サイトからの答えの判定」は、こうして決めた結果です。',
    /** ページが決める鍵の値の null の印（長さの上限を超えた値は残さない）。 */
    pageKeyValueCut: '長さの上限を超えたので、値を残していません',
    /** ページが決める鍵の値の全体がない回（送らなかった、送る前の確かめまで進まなかった）。 */
    pageKeyValuesNotRecorded: '値はありません（送らなかったか、送る前の確かめまで進みませんでした）',
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
        '更新できる、答え合わせが合ったデータがありません。新しく登録する書き込みの手順で 1 件登録し、答え合わせが合ったら、続けてそのデータを更新できます。',
      PREVIOUS_UPDATE_STOPPED:
        'いちばん新しいデータでは、前の更新が、答え合わせが合わないまま止まりました。新しく登録する書き込みの手順で 1 件登録し、答え合わせが合ったら、続けてそのデータを更新できます。',
    },
    open: '登録してから更新する',
    notStartable: '新しく登録する書き込みの手順か、この更新の手順が、今は始められません。それぞれの「書き込みを始める」の画面で理由を確かめてください。',
    dialogTitle: '登録してから更新しますか',
    dialogBody:
      'テスト用のサイトに、新しく登録するデータを 1 件送ります。答え合わせが合ったら、続けてそのデータの更新を 1 件送ります。登録の答え合わせが合わなければ、更新は始めません。始めた後は、送る直前の確かめで止まらない限り、送信を取り消せません。',
    /** 確認のダイアログの 2 回の書き込み（`scenarioId` はシナリオの id）。 */
    // PL-5（設計書 3 章の 2）: 書き込みの手順の ID と送り先は出さない。
    stepCreate: '1 回目: 新しく登録',
    stepUpdate: '2 回目: 更新',
    stepRemaining: '合計の残り',
    /** 累積の残り（`remainingText`・`limitText` は `formatCount` の結果）。 */
    remainingValue: (remainingText: string, limitText: string): string => `残り ${remainingText}（上限 ${limitText}）`,
    stepTarget: '更新するデータ',
    stepTargetValue: '1 回目で登録して、答え合わせが合ったデータ',
    confirm: '登録してから更新する',
    stateHeading: '続けて更新する予定',
    stateLabel: '状態',
    reasonLabel: '更新を始めなかった理由',
    /** T41g-3: 自動ログインの間隔を待った後に、更新を始め直す時刻の項目名。 */
    nextStartAt: '更新を始め直す時刻',
    openUpdateJob: '更新の作業の様子を見る',
    /** 何も始めずに拒んだ理由（`WRITE_CHAIN_START_REJECTION_REASONS`）。 */
    startRejections: {
      CHAIN_NOT_OFFERED: {
        description: '今は「登録してから更新する」を使う場面ではありません（更新する予定のデータがあります）。何も始めていません。',
        action: '画面を読み込み直して、更新する予定のデータを確かめてから、「書き込みを始める」を使ってください。',
      },
      CREATE_NOT_STARTABLE: {
        description: '新しく登録する書き込みの手順が、今は始められません。何も始めていません。',
        action: '新しく登録する書き込みの手順の「書き込みを始める」の画面で、始められない理由を確かめてください。',
      },
      UPDATE_NOT_STARTABLE: {
        description: 'この更新の手順が、今は始められません（書き込みの OK、結果の確かめ方、上限、間隔など。画面が古い場合も含みます）。何も始めていません。',
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
  downloadBundle: '報告のまとめファイル（ZIP）をダウンロードする',
  notDistributed: '報告は配りません。書き込みの結果は、この画面の結果の欄で確かめてください。',
  notChecked: '報告はまだ確かめていません。書き込みが終わっていないか、結果が出る前に点検のプログラムが終わりました。報告は配りません。',
  /** 書き込みの履歴の、配らない報告の欄。 */
  notDistributedShort: '配らない',
  /** ジョブの詳細の成果物の一覧のリンク。 */
  artifacts: {
    openActionReport: '書き込みの報告（HTML）を開く',
    downloadActionEvidenceJson: 'action-evidence.json をダウンロードする',
    downloadApprovalSummaryJson: 'approval-summary.json をダウンロードする',
    downloadActionBundle: '書き込みの報告のまとめファイル（ZIP）をダウンロードする',
  },
} as const);

/**
 * 監査済みデータの台帳の画面（T32g。Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）の文言。台帳は画面だけで、書き出しの
 * ファイルは作らない。
 */
export const LOCAL_UI_LEDGER_TEXT = deepFreeze({
  pages: {
    ledger: '作ったデータの一覧',
  },
  profileDetail: {
    open: '作ったデータの一覧を開く',
  },
  notEligible: '作ったデータの一覧は、点検のしかたが「書き込みも試す点検」のサイトにだけ出します。',
  note: 'BeakSight は、登録したデータを消すことも、元に戻すこともしません。テスト用のサイトのデータの片付けは、この一覧をもとに、テスト用のサイトの管理者に頼んでください。',
  noEntries: 'まだ登録はありません。',
  columns: {
    recordId: '登録の ID',
    verification: '答え合わせの状態',
    updates: 'この ID の更新',
  },
  scenariosHeading: '件数（書き込みの手順ごと）',
  noScenarios: 'まだ書き込みの手順はありません。',
  notObtained: '取れていない',
  notApplicable: 'なし',
  /** UPDATE の回数（`countText` は `formatCount` の結果）。 */
  updateCountValue: (countText: string): string => `${countText} 回`,
  lastUpdateLabel: '最後の結果',
  /** 累計の件数と上限（`usedText`・`limitText` は `formatCount` の結果）。 */
  cumulativeValue: (usedText: string, limitText: string): string => `${usedText} / 上限 ${limitText}`,
  cumulativeNote: '合計の件数は、書き込みを始めるときの確かめと同じ数え方です（送ったか分からない回を含みます）。',
  openScenario: '書き込みの手順を開く',
} as const);

/**
 * スクリプトで送るログインの画面の文言（T34d。Task 34 の設計書 3.1、3.2、3.6）。プロファイルの画面の「承認したサービスの Origin」の欄と、認証の
 * 設定の画面の、ログインの送り方・token の送信先・必須の query・ログインに伴う送信・成功のローカル ストレージの鍵の欄。ログインの送り方の名前は
 * `LOGIN_TRANSPORT_CATALOG`。
 */
export const LOCAL_UI_SCRIPT_LOGIN_TEXT = deepFreeze({
  // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: プロファイルの編集では、承認したサービスの Origin を読むだけの一覧と「消す」だけに
  // する（足す欄はない。手動のログインの観察だけが足す）。作成の画面には出さない。
  profile: {
    approvedServiceOrigins: 'ログインのときに通ってよい外のサイトのアドレス',
    approvedServiceOriginsHint:
      'ここからは足せません。手でログインすると、ログインに使った外のサイトのアドレスが自動で入ります。要らないアドレスは「消す」で外してから、保存してください。',
    approvedServiceOriginsNone: 'まだありません（手でログインすると、自動で入ります）。',
    /** 1 つの Origin を一覧から外すボタンの名前（`origin` は外す Origin）。 */
    removeServiceOrigin: '消す',
    removeServiceOriginLabel: (origin: string): string => `${origin} を消す`,
  },
  setup: {
    loginTransport: 'ログインの送り方',
    loginTransportHint: 'ログインの画面で、ログインのボタンを押したときの送り方です。',
    scriptHeading: 'ページの中のプログラムが送るログイン',
    scriptBody:
      'ログインのステップで通すのは、下の「ログインの送り先」へ、ページの中のプログラムが送る通信だけです（アドレスの ? の後ろに要る組がすべてあるときだけ、回数の上限まで）。ほかの送信は止めて記録します。',
    // MI-3（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 誤りの見た目でなく知らせ（ヒント）。承認したサービスの Origin は、プロファイルの画面から
    // 足せない（MI-1）。手動のログインの観察だけが足す。
    // MI-8（設計書 4.9）: この知らせは自動ログインのプロファイルだけに出る（`script-login-notices.ts`）。自動ログインのプロファイルからは足せない（MI-G）ので、
    // 先に手動のログインへ戻すことを含める（戻す道は MI-4 が確かめた）。
    noServiceOriginsNotice:
      `まだ、ログインのときに通ってよい外のサイトのアドレスがありません。自動ログインのサイトからは足せません。${ADVANCED_SETTINGS_REF_TEXT}でログインのしかたを「手でログインする」に戻してから、手で 1 回ログインすると、ログインに使った外のサイトのアドレスが自動で入ります。`,
    scriptOrigin: 'ログインの送り先のサイトのアドレス',
    selectPlaceholder: '選んでください',
    scriptPath: 'ログインの送り先のアドレスの後ろ',
    methodFixed: '送る通信の種類',
    methodFixedValue: '送る通信だけ',
    requiredQuery: 'アドレスの ? の後ろに要る組',
    sideRequests: 'ログインに伴う送信',
    storageKeyHeading: 'ログインできた印になる、ブラウザの保存場所の項目',
    storageKeyBody:
      'ログインの後に、このサイトのアドレスのブラウザの保存場所に、決めた始まりで始まり、決めた終わりで終わる名前の項目があれば、ログインが済んだとみなします（成功の条件に足します。値は読みません）。',
    storageOrigin: '項目があるサイトのアドレス',
    storageOriginHint: 'サイトの設定の「テスト用のサイトのアドレス」から選びます。',
    storagePrefix: '項目の名前の始まり',
    storagePrefixHint: '項目の名前の始まりです（例: app-）。始まりと終わりの両方を空にはできません。',
    storageSuffix: '項目の名前の終わり',
    storageSuffixHint: '項目の名前の終わりです（例: -auth-token）。',
  },
} as const);

/**
 * ジョブの詳細の「ログインの段で止めた送信」（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行）。止めた読み取りでない要求の Origin と path と種類と理由と
 * 回数の表、数のまとめ、登録の案内。値・query・本文は、画面のサーバに届かない（ジョブの記録には、Origin と path だけがある）。
 */
export const LOCAL_UI_LOGIN_STAGE_TEXT = deepFreeze({
  heading: 'ログインのステップで止めた送信',
  body: 'ログインのステップで止めた、見るだけでない送信です。サイトのアドレスと、アドレスの後ろと、? の後ろの名前だけを残します。値と本文は残しません（grant_type の決まった形の値だけは残します）。',
  guidance:
    'ログインに要る送信なら、ログインの設定の「ログインに伴う送信」に登録してください。見るだけの送信か、ログインに要る送信かは、あなたが決めます。',
  openSetup: 'ログインの設定を開く',
  tableCaption: '止めた送信（サイトのアドレス・アドレスの後ろ・種類・理由が同じものは 1 行にまとめます）',
  columns: {
    origin: 'サイトのアドレス',
    path: 'アドレスの後ろ',
    resourceType: '種類',
    reason: '理由',
    count: '回数',
  },
  /** 値に見える区切り（長い base64url・16 進、JWT の形）を `[REDACTED]` に伏せたパスに添える文（T34e fix round 1）。 */
  redactedPathNote: '（値に見える区切りを伏せました）',
  /** 一覧の上限を超えた送信の数（`countText` は `formatCount` の結果）。 */
  unlisted: (countText: string): string => `ほかに ${countText}の送信を止めました（一覧の上限を超えたので、表には出していません）。`,
  tokenRequestsAllowed: '通したログインの送信',
  sideRequestsAllowed: '通したログインに伴う送信',
  serviceOriginReads: 'ログインのときに通ってよい外のサイトへの、見るだけの送信',
  blockedTotal: '止めた、見るだけでない送信',
  /**
   * T36R-fix（T36R の M-7）: 自動ログインで、資格情報を含む要求を止めた数（token の送信のほか。読み取りの要求も含むので、止めた読み取りでない送信の数には
   * 足さず、独立の欄に出す）。
   */
  credentialRequestsBlocked: 'ID とパスワードを含む送信を止めた数',
  /** ML-b（手動のログインの通して記録する決まり。設計書 2.3）: 手動のログインの段で通した送信の表。 */
  passedTableCaption: '手でログインする間に通した送信（サイトのアドレス・アドレスの後ろ・種類が同じものは 1 行にまとめます。値は残しません）',
  /** ML-b-3: token の送信より前に最初に見た行の印（自動の登録は、この印のある手続きの呼び出しだけをログインに伴う送信にします）。 */
  passedBeforeToken: 'ログインの送信より前',
  passedUnlisted: (countText: string): string => `ほかに ${countText}の送信を通しました（一覧の上限を超えたので、表には出していません）。`,
} as const);

/**
 * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ジョブの詳細の「ログインの段」の欄の、ログインの後のブラウザの状態の名前の記録。
 * 名前は先頭と末尾の一般の語の形だけで、値・中身・名前の全体は、画面のサーバに届かない。
 */
export const LOCAL_UI_LOGIN_STATE_NAMES_TEXT = deepFreeze({
  heading: 'ログインの後のブラウザの状態の名前',
  note:
    'ログインのステップの終わりに読んだ、ブラウザに残った情報の名前です。それぞれを点検に引き継いだか、点検してよいサイトとログインのときに通ってよい外のサイトのどちらでもないので外したかを示します。名前は先頭と末尾のよくある語だけを残し、値と中身は残しません。',
  cookiesCaption: 'ブラウザに残るログインの印（ドメイン・アドレスの後ろ・名前の形・結果が同じものは 1 行にまとめます）',
  localStorageCaption: 'ブラウザの保存場所の項目（サイトのアドレス・名前の形・結果が同じものは 1 行にまとめます）',
  indexedDBCaption: 'ブラウザの保存場所のデータベース（サイトのアドレス・名前の形・結果が同じものは 1 行にまとめます）',
  columns: {
    domain: 'ドメイン',
    path: 'アドレスの後ろ',
    hostOnly: '送る先',
    origin: 'サイトのアドレス',
    shape: '名前の形（先頭と末尾）',
    outcome: '点検への引き継ぎ',
    count: '名前の数',
  },
  outcomeLabels: { CARRIED: '引き継いだ', OUTSIDE_APPROVED: '外した（点検してよいサイトの外）' },
  hostOnlyLabels: { hostOnly: 'そのサイトだけ', domain: 'サブドメインにも送る' },
  /** 先頭と末尾に一般の語のない名前（名前は残さない）。 */
  noShape: '（よくある語のない名前）',
  none: 'なし',
  /** 表の上限を超えた名前の数（`countText` は `formatCount` の結果）。 */
  unlisted: (countText: string): string => `ほかに ${countText}の名前があります（表の上限を超えたので、出していません）。`,
} as const);

/**
 * ML-b（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2〜2.4）: 手動のログインの「ログインを終えた」と、手動のログインの成功から自動で
 * 登録した設定の文言（ジョブの画面とプロファイルの画面）。
 */
export const LOCAL_UI_MANUAL_LOGIN_TEXT = deepFreeze({
  confirm: 'ログインを終えた',
  confirming: '知らせています…',
  accepted: 'ログインを終えたことを知らせました。ログインしている状態を保存して、点検に進みます。',
  rejected: 'ログインを終えたことを、受け付けられませんでした。',
  /** DEF-146: 「ログインを終えた」の Server Function の呼び出しが例外で終わった・結果の形でない値で終わったときの理由（ジョブの管理には届いていない）。 */
  requestFailed:
    '画面のサーバとのやりとりで誤りが起きたため、知らせを届けられませんでした（通信の誤りか、送った内容の確かめの誤り）。画面のサーバが動いているかを、起動したときの画面（コンソール）で確かめてから、もう一度押してください。',
  /**
   * ML-b-2: 拒んだ理由の説明（ジョブの管理の閉じた一覧 `AUDIT_JOB_LOGIN_CONFIRM_REJECTION_REASONS`。網羅は画面の側の
   * `apps/local-ui/src/display/catalog-coverage.ts` で型で確かめる）。
   */
  rejectionReasons: {
    JOB_NOT_FOUND: 'この作業が見つかりません。作業の履歴から開き直してください。',
    JOB_NOT_ACTIVE: 'この作業は、もう動いていません。続けるなら、点検を始め直してください。',
    NOT_AWAITING_LOGIN: 'この作業は、今は手でログインするのを待っていません（ログインの前か後、または止める操作の後です）。画面の状態を確かめてください。',
    ALREADY_CONFIRMED: 'ログインを終えたことは、もう知らせてあります。点検に進むまで待ってください。',
  },
  /**
   * ML-b-2（設計書 2.3）: 手動のログインの成功から、ジョブの管理がジョブの終わりの後に設定を自動で登録した結果（ジョブの画面）。SKIPPED の理由は閉じた一覧
   * `AUDIT_JOB_LOGIN_AUTO_REGISTRATION_SKIP_REASONS`（網羅は `catalog-coverage.ts` で型で確かめる）。
   */
  autoRegistration: {
    saved: 'この作業で手でログインしたときの様子から、設定を覚えました。',
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）: 手でのログインの値を受け取って、自動ログインに切り替えたとき。
    switched: '次の点検から、BeakSight が自動でログインします。',
    savedRevision: '保存したサイトの設定',
    addedServiceOrigins: '足した、ログインのときに通ってよい外のサイトのアドレス',
    skipped: 'この作業で手でログインしたときの様子からは、設定を覚えませんでした。',
    // OP-K（K3）: 自動ログインへ切り替えられなかった理由の 1 行（閉じた一覧 `AUDIT_JOB_AUTOMATED_LOGIN_UNAVAILABLE_REASONS`。網羅は `catalog-coverage.ts`）。
    automatedLoginReasons: {
      TOKEN_TARGET_ON_TEST_ORIGIN: 'ログインの送り先がテスト用のサイトと同じアドレスのため、自動ログインにできませんでした。',
      LOGIN_FIELDS_MISSING: 'ログインの画面の入力欄とボタンの場所が分からなかったため、自動ログインにできませんでした。',
      SWITCH_INVALID: '自動ログインの設定を組み立てられなかったため、自動ログインにできませんでした。',
      DESTINATION_MISMATCH: '入れた ID とパスワードが、覚えたログインの送り先とは別の所へ送られたため、自動ログインにしませんでした。',
      CREDENTIAL_NOT_WRITABLE: 'この PC では ID とパスワードを保存できないため、自動ログインにできませんでした。',
      CREDENTIAL_NOT_SAVED: 'ID とパスワードを保存できなかったため、自動ログインにできませんでした。',
      REGISTRATION_NOT_SAVED: 'サイトの設定を保存できなかったため、自動ログインにできませんでした。',
    },
    skipReason: '理由',
    next: '次にすること',
    skipReasons: {
      NO_PASSED_REQUESTS: {
        label: '通した送信がない',
        next: 'ログインの間に通した送信がないため、覚えるものはありません。ログインの画面が、ページの中のプログラムで送る形なら、もう一度「点検を始める」から、手でログインしてください（通した送信から、自動で覚えます）。',
      },
      NO_TOKEN_REQUEST: {
        label: 'ログインの送信が見つからない',
        next: '通した送信に、ログインの送信の形（grant_type を持つ送信）がありませんでした。ログインのステップの、通した送信の表にログインの送信の行があれば、その行の「登録する」で登録してください。',
      },
      NO_STORAGE_KEY: {
        label: 'ログインできた印の案がない',
        next: 'ログインの後のブラウザの保存場所に、新しい項目が見つかりませんでした。ログインを最後まで済ませてから「ログインを終えた」を押したかを確かめ、もう一度、手でログインしてください。',
      },
      NOTHING_NEW: {
        label: '足すものがない',
        next: '通した送信は、今の設定にすべて入っています。することはありません。',
      },
      PROFILE_CHANGED: {
        label: 'サイトの設定かログインの設定が変わった',
        next: '作業を始めた後に、サイトの設定かログインの設定が変わったため、上書きしませんでした。要るなら、ログインのステップの表の「登録する」から入れてください。',
      },
      SAVE_REJECTED: {
        label: '保存の確かめを通らなかった',
        next: '組み立てた設定を、保存の確かめが受け付けませんでした。ログインのステップの表の行の「登録する」で、行ごとに登録してください（登録できない行には、理由が出ます）。',
      },
      MULTIPLE_TOKEN_TARGETS: {
        label: 'ログインの送り先が 1 つに決まらない',
        next: 'ログインの送り先が 2 つ以上あり、1 つに決まらないため、覚えませんでした。通した送信の表のログインの送信の行から「登録する」で、正しい送り先を選んで登録してください。',
      },
      // DEF-182（OP-DEF 修正の 1 回目）: token の送信先がテスト環境と同じアドレス。自動ログインは使えず、手動のログインのまま（行の登録も要らない）。
      TOKEN_TARGET_ON_TEST_ORIGIN: {
        label: 'ログインの送り先がテスト用のサイトと同じアドレス',
        next: 'このサイトは、ログインの送り先がテスト用のサイトと同じアドレスのため、自動ログインを使えません。手でログインして点検してください。',
      },
    },
  },
  setupHeading: 'ログインから覚えた設定',
  setupNote:
    `手でログインしてうまくいったときに、通した送信とログインの後の様子から、BeakSight の送信の見張りを通るための設定を自動で覚えます。自動ログインは、この設定に入っている送信だけを通します。中身を見直し、足りなければ、ログインのステップの表の「登録する」で足してください。違う値を直すときだけ、${ADVANCED_SETTINGS_REF_TEXT}のログインの設定の画面を開きます。`,
  token: 'ログインの送り先',
  /** token の送信先の必須の query（名前だけ）。 */
  tokenQueryNames: (names: string): string => `（アドレスの ? の後ろに要る名前: ${names}）`,
  sideRequests: 'ログインに伴う送信',
  /** ログインに伴う送信 1 件（`maxText` は `formatCount` の結果）。 */
  sideRequestValue: (method: string, target: string, maxText: string): string => `${method} ${target}（ログインのステップ 1 回あたり ${maxText}まで）`,
  serviceOrigins: 'ログインのときに通ってよい外のサイトのアドレス',
  successKey: 'ログインできた印になる、ブラウザの保存場所の項目',
  /** 鍵の形（接頭辞と接尾辞。間の部分は持たない）。 */
  successKeyValue: (prefix: string, suffix: string): string => `${prefix}…${suffix}`,
  none: 'なし',
  revisionNote:
    '設定を保存すると、サイトの設定の変更の回数が進みます。OK を出した書き込みの手順や、操作さがし・見るだけの確かめの結果は、やり直しが要ることがあります。',
  review: 'ログインの設定の画面で見直す',
} as const);

/**
 * T43d（Task 43 の設計書 4.4）: 観察した要求の「登録する」と、ログインの段の観察（成功の鍵の名前と成功の画面のセレクタの案）、認証の設定の画面の下書きの
 * 文言。「登録する」はその場で保存しない（認証の設定の画面を下書きつきで開き、利用者が確かめて保存する）。
 */
export const LOCAL_UI_LOGIN_OBSERVATION_TEXT = deepFreeze({
  columns: {
    query: '? の後ろの名前',
    register: '登録',
  },
  /** query の名前の一覧の後に、一覧に入れなかった名前の数を添える文（`countText` は `formatCount` の結果）。 */
  omittedQueryNames: (countText: string): string => `ほか ${countText}`,
  /** 残した値（`grant_type=password` の形で出す）の前に置く語。 */
  recordedValue: '値',
  noQuery: 'なし',
  register: '登録する',
  /** 行の登録先（ボタンの説明）。 */
  registerTokenTarget: 'ログインの送り先として登録します（送り方は、ページの中のプログラムが送る形）。',
  registerSideRequest: 'ログインに伴う送信として登録します（送る通信で、1 回のログインで 1 回まで）。',
  /** ボタンを出さない行の案内。 */
  manualRedactedPath: '値に見える部分を伏せたアドレスなので、登録の案を作れません。ログインの設定に手で入れてください。',
  manualAlreadyRegistered: '登録してある送信の上限か送り方で止めました。ログインの設定を開いて、登録の内容を手で直してください。',
  /** ログインの段の観察の欄。 */
  observationHeading: 'ログインのステップで見つけた案',
  observationBody: 'ログインのステップの始めと終わりに読んだことから作った案です（値と画面の文字は残しません）。保存は、ログインの設定の画面であなたが行います。',
  /** T43R-fix の C-1 (a): 鍵の名前は、区切りで分けた最初と最後の部分だけ（間の部分は残さない）。 */
  storageKeys: '新しく出た、ブラウザの保存場所の項目の名前の形（ログインできた印の案。最初と最後の部分だけで、間の部分は残しません）',
  storageKeysOrigin: '項目があるサイトのアドレス',
  /** 1 つの形の、接頭辞と接尾辞の間に置く語。 */
  storageKeyMiddle: '…',
  successSelector: 'ログインできた画面の部品の目印の案',
  /** 案の説明（`word` は閉じた一覧のログアウトの語）。T43R-fix の C-1 (b): ログアウトの語を含む属性の CSS だけ。 */
  successSelectorLogout: (word: string): string => `ログアウトの語「${word}」を含む、見えるリンクかボタンの目印`,
  /** T43R-fix の C-1 (c): 自動ログインで、入れた資格情報を含んだので捨てた案の数（`countText` は `formatCount` の結果）。 */
  credentialDiscarded: (countText: string): string => `入れた ID かパスワードを含んでいたので、${countText}の案を捨てました。`,
  /** T43R-fix の M-5: ログインの段のまとめが管理データの上限を超えたので、観察と query の名前を省いた。 */
  observationOmitted: 'ログインのステップのまとめが大きすぎたので、見つけた案と ? の後ろの名前を省きました。',
  applyObservation: '案をログインの設定に入れる',
  /** 認証の設定の画面の下書きの知らせ（T43R-fix の M-3: 下書きはジョブに結び付かない。URL で受け取ったもの）。 */
  draftHeading: 'ページのアドレスで受け取った下書き',
  draftBody: 'ページのアドレスで受け取った下書き（登録の案）を、欄に入れました。まだ保存していません。確かめてから保存してください。',
  /** 保存のときにプロファイルの承認したサービスの Origin にも足す Origin の知らせ（足す Origin は保存の時点の欄から決め直す）。 */
  draftServiceOrigins:
    '保存すると、保存のときのログインの送り先とログインに伴う送信のサイトのアドレスのうち、まだ通ってよいとしていないもの（今の欄では次のアドレス）を、サイトの設定の「ログインのときに通ってよい外のサイトのアドレス」にも足します。サイトの設定とログインの設定は、1 回で保存します。',
  draftInvalid: 'ページのアドレスで受け取った下書きの形が正しくないので、欄に入れませんでした。',
} as const);

/**
 * FM-1（手動の操作を減らす設計書 2.2 の画面）: プロファイルの表示の設定（ジョブのブラウザを表示する。既定は表示）と、ジョブの画面の「見るだけ。操作しない」
 * の注意。理由は閉じた一覧（`PROFILE_DISPLAY_SETTINGS_REJECTION_REASONS`。網羅は `catalog-coverage.ts`）。
 */
export const LOCAL_UI_DISPLAY_SETTINGS_TEXT = deepFreeze({
  heading: '表示の設定',
  showJobBrowser: '作業中のブラウザを画面に出す',
  /** FM-3: 欄の説明（切り替えるとすぐ保存する。専用の保存のボタンはない）。 */
  autoSaveNote:
    'この欄の設定は、切り替えるとすぐ保存します。サイトの設定の保存とは別です（「保存する」のボタンを押す必要はなく、押してもこの欄は変わりません）。',
  hint:
    '点検・操作さがし・見るだけの確かめ・書き込みの作業中のブラウザを画面に出して、様子を見られます（ログインのステップのブラウザは、いつも出します）。切り替えると、すぐ保存します。切り替えても、サイトの設定の変更の回数と書き込みの OK は変わりません。次に始める作業から使います。',
  saving: '保存しています…',
  saved: '表示の設定を保存しました。',
  /** FM-3: 保存できなかったとき（チェックは元の値に戻す）。 */
  rejected: '表示の設定を保存できませんでした。チェックを、切り替える前の値に戻しました。',
  /** FM-3: Server Function が例外を投げたとき（入力の検証の誤り、通信の誤り）の理由。 */
  requestFailed: '画面のサーバとのやりとりで誤りが起きました（送った内容の確かめの誤りか、通信の誤り）。画面のサーバが動いているかを確かめてから、もう一度切り替えてください。',
  reasons: {
    PROFILE_NOT_FOUND: 'このサイトが見つかりません。',
    SETTINGS_INVALID: '表示の設定の値が正しくありません。',
  },
  watchOnly:
    '作業中のブラウザを画面に出しています。ログインを頼まれたときのほかは、ブラウザを操作しないでください（操作すると、結果が乱れます。ブラウザを閉じると、作業は失敗として終わります）。',
  /** AS-b（監査の段の送信の扱いの設計書 2.1）: 監査の段の送信の扱いの切り替え（OP-I の I1 から、サイトの既定は通す側）。 */
  // OP-U: 点検のほか、登録・更新の作業の値を入れる前にも当たるので、作業の名前を並べず「ページを見ている間」と言う。
  auditSendPassExceptDelete: 'ページが出す送信のうち、削除のほかを通す（ページを見ている間）',
  auditSendHint:
    '既定は通す側です。通すと、ページが出す書き込みの送信がサイトに届きます。削除と危険な語の送信は止めます。外すと見るだけになります（ページが出す書き込みの送信を止めます）。通す側にするときは、確認のダイアログで「通す」を選んだときに保存します。外すときは、切り替えるとすぐ保存します。切り替えても、サイトの設定の変更の回数と書き込みの OK は変わりません。次に始める作業から使います。',
  auditSendDialogTitle: 'ページが出す書き込みの送信を通しますか',
  auditSendDialogBody: 'ページが出す書き込みの送信がサイトに届きます。削除と危険な語の送信は止めます。',
  auditSendConfirm: '通す',
  auditSendCancel: 'やめる',
  // OP-I（I1）: 「削除のほかを通す」はサイトの既定になったので、要点の「守りを緩めています」の印（`auditSendRelaxed`）はなくした。
} as const);

/** MI-3（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 認証の設定を自動で保存できなかったときに、プロファイルの詳細の「次にすること」が出すリンク。 */
const AUTH_SETUP_CREATE_IN_ADVANCED_LABEL = `${ADVANCED_SETTINGS_REF_TEXT}でログインの設定を作る`;

/**
 * MI-F4（MI-R の文言の指摘）: 認証の設定がないか、プロファイルの今の改訂に結びついていないときの手順（自動ログインへの切り替えと「書き込みにも使う」の拒否）。
 * 認証の設定の画面はふだんの流れから外したので、プロファイルの詳細の「次にすること」の道（古いときの「…を直す」と、ないときのリンク）を示す。
 */
// PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 前は「次にすること」の「ログインの設定を直す」を指していた。今のサイトの画面の言葉に合わせた。
const AUTH_SETUP_NOT_CURRENT_ACTION_TEXT = `サイトの画面の「${LOCAL_UI_NEXT_STEP_TEXT.actions.AUTH_SETUP}」から、ログインの設定の中身を確かめて保存してから、もう一度行ってください。ログインの設定がまだないときは、サイトの画面の「${LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY}」を押してください。`;

/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える画面（資格情報の画面の、手動のログインのプロファイルの形）と、「次から
 * 自動でログインする」の案内（FM-1 の手動の操作を減らす設計書 2.3。ジョブの画面とプロファイルの画面。FM2e で、3 つの画面への案内の
 * `LOCAL_UI_AUTOMATED_LOGIN_OFFER_TEXT` をここへ寄せて消した）の文言。理由と戻しの一覧は `apps/local-ui/src/server/credential-service.ts`（`AUTOMATED_LOGIN_SETUP_REJECTION_REASONS`・
 * `AUTOMATED_LOGIN_SETUP_ROLLBACKS`）。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts`。値（ユーザー名とパスワード）は入れない。
 */
export const LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT = deepFreeze({
  // MI-C 項目 15: 見出しと入口の文言は、プロファイルの詳細の「次にすること」の「次から自動でログインする」（`AutomatedLoginReadinessNote`）が使う。
  /**
   * MI-4（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.4）: プロファイルの詳細の「次にすること」の「次から自動でログインする」。状態の一覧は
   * `apps/local-ui/src/server/credential-service.ts` の `AUTOMATED_LOGIN_READINESS_STATES`（書き漏れと余分は `catalog-coverage.ts`）。
   */
  /**
   * PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2、6 章の 4）: 要点の文。ログインの欄の目印（CSS セレクタ）は、観察の案が 3 つそろうときだけ
   * そのまま使い、画面に出さない（方式の表も出さない）。
   */
  intro:
    // OP-1: 手でのログインの値は、1 回目の点検で BeakSight が受け取って自動ログインにする。この画面は、それができなかったときや入れ替えるときの直す道。
    'テスト用のアカウントの ID とパスワードを入れてください。次の点検から、BeakSight がこのアカウントで自動でログインします。',
  /** PL-4: 観察の案が 3 つそろわないとき（欄もボタンも出さない）。 */
  notAvailable: 'このサイトでは自動ログインを使えません。手でログインして点検してください。',
  credentials: {
    heading: 'ログインに使う ID とパスワード',
  },
  authSetupNotCurrentHeading: '先にログインの設定を保存し直してください',
  authSetupNotCurrentBody:
    'ログインの設定がないか、サイトの設定を最後に変えたときより前のものです（サイトの下調べで自動で保存できなかったか、サイトの設定を変えた後です）。下の「ログインの設定を開く」で中身を確かめて保存してから、この画面に戻ってください。',
  openAuthSetup: 'ログインの設定を開く',
  /** PL-4: 主のボタン（確定のダイアログを開く）。前は「変更を確かめる」。 */
  review: '自動ログインにする',
  dialog: {
    title: '自動ログインに切り替えますか',
    body: '次のとおりに保存します。途中で失敗したときは、保存した ID とパスワードを消して、前の状態に戻します。',
    item: '項目',
    before: '変える前',
    after: '変えた後',
    method: 'ログインのしかた',
    maxLoginAttempts: 'ログインのステップで送る回数の上限',
    credential: 'ログインの ID とパスワード',
    credentialAfter: '登録する（値は表示しません）',
    credentialBefore: 'なし',
    /** 改訂が進むこと（`beforeText` と `afterText` は改訂の表示）。 */
    revisionNotice: (beforeText: string, afterText: string): string =>
      `サイトの設定は「${beforeText}」から「${afterText}」になります。操作さがし・見るだけの確かめの結果は、やり直しが要ることがあります。`,
    /** 今承認が有効なシナリオがあるとき（`countText` は `formatCount` の結果）。 */
    approvalNotice: (countText: string): string =>
      `書き込みの OK を出した書き込みの手順（${countText}）は、OK が外れます。OK はサイトの設定を変えると外れるためです。書き込みを始める前に、もう一度 OK を出してください。`,
    confirm: '保存する',
    cancel: '保存せずに戻る',
    /**
     * PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 2）: パスワードを入れる先（`hostText` はログインの画面のホストだけ。Origin の表記や path は
     * 出さない）。ログインの画面が分からないときは `destinationUnknown`。
     */
    destination: (hostText: string): string => `パスワードを入れる先: 手でログインしたときと同じ、${hostText} のログインの画面です。`,
    destinationUnknown: 'パスワードを入れる先: 手でログインしたときと同じログインの画面です。',
    testAccountOnly: 'テスト用のアカウントだけを入れてください。本番のパスワードは入れないでください。',
    storage: 'パスワードは、このパソコンの中に、今のユーザーだけが開ける形で保存します。',
    /** 回数の決まり（`minutesText`・`daysText`・`countText` は、定義元の定数（`auto-login-limits.ts`）の `formatInteger` の結果）。 */
    limits: (minutesText: string, daysText: string, countText: string): string =>
      `自動ログインは ${minutesText} 分に 1 回、${daysText} 日に ${countText} 回までです。うまくいかないと止まり、あなたが確かめるまで再開しません。`,
  },
  saving: '保存しています…',
  /**
   * PL-4（設計書 6 章の 4、13 章の最後の段落）: 確定の後に移る点検の開始の画面の、要点の 1 行目（移った印 `automatedLoginSetUpSearch` があるときに出す）。
   * 前の保存の後の画面（済んだ知らせと「ログインを確かめる」の案内）はなくした。
   */
  arrived: '自動ログインにしました。',
  rejectedHeading: '自動ログインに切り替えられませんでした',
  rejections: {
    PROFILE_NOT_FOUND: {
      description: '点検するサイトが見つかりません。',
      action: 'サイトの一覧から開き直してください。',
    },
    NOT_OFFERED: {
      description: 'このサイトは、手でログインする、使える状態のサイトではありません（すでに自動ログインか、取り消してあります）。',
      action: '画面を読み直してください。ID とパスワードの変更は、ID とパスワードの画面の今の操作で行ってください。',
    },
    PROFILE_REVISION_CONFLICT: {
      description: 'この画面を開いた後に、サイトの設定が変わりました（別の保存が先に行われました）。',
      action: '画面を読み直して、中身を確かめてから、もう一度保存してください。',
    },
    AUTH_SETUP_NOT_CURRENT: {
      description: 'ログインの設定がないか、サイトの設定を最後に変えたときより前のものです。',
      action: AUTH_SETUP_NOT_CURRENT_ACTION_TEXT,
    },
    TARGET_CONFIG_UNAVAILABLE: {
      description: 'このサイトの設定のファイルを読めませんでした。',
      action: '設定のファイルがあり、読めることを確かめてから、もう一度行ってください。',
    },
    PROFILE_INVALID: {
      description: 'ログインのしかたを変えたサイトの設定が、確かめを通りませんでした。',
      action: 'サイトの設定の画面で中身を確かめてください。',
    },
    AUTH_SETUP_INVALID: {
      description: 'ログインの欄の目印を入れたログインの設定が、確かめを通りませんでした。',
      // PL-4: 欄の目印は画面に出さない（観察の案だけを使う）ので、直す道は手でログインして観察し直すこと。
      action: '手でログインして 1 回点検し直してから、もう一度行ってください。ほかの項目の誤りは、ログインの設定の画面で直してください。',
    },
    SAVE_FAILED: {
      description: 'BeakSight の記録を保存できませんでした。',
      action: '画面のサーバを起動したコンソールに出た誤りを確かめてから、もう一度行ってください。',
    },
  },
  rollbacks: {
    NOT_NEEDED: '何も保存していません（前の状態のままです）。',
    REMOVED: '保存した ID とパスワードのファイルを消し、前の状態に戻しました。',
    FAILED: '保存した ID とパスワードのファイルを消せませんでした。この画面を読み直し、「保存した ID とパスワードを消す」で消してください。',
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
  editDraft: 'ログインの設定の画面で直す',
  preparing: '案を作っています…',
  dialogTitle: 'この送信を登録しますか',
  dialogBody:
    '次の内容をログインの設定に足して、その場で保存します。保存するとサイトの設定の変更の回数が進みます。そのため、書き込みの OK を出した書き込みの手順や、操作さがし・見るだけの確かめの結果は、やり直しが要ることがあります。',
  tokenTarget: 'ログインの合い札をもらう送信先（ページの中のプログラムで送る形です。今の送信先があれば、これに替えます）',
  /** token の送信先の必須の query（名前だけ）。 */
  tokenQueryNames: (names: string): string => `（アドレスの ? の後ろに必ずある名前: ${names}）`,
  sideRequest: 'ログインに伴う送信',
  addServiceOrigins: 'ログインのときに通ってよい外のサイトのアドレスに足すもの',
  nextRevision: '保存した後のサイトの設定',
  confirm: '登録する',
  cancel: 'やめる',
  saving: '保存しています…',
  /** 保存の知らせ（`revisionText` は改訂の表示）。 */
  saved: (revisionText: string): string => `登録しました（サイトの設定は「${revisionText}」になりました）。`,
  rejected: 'この送信は登録できません。',
  /** 保存の部品が拒んだ理由のコード。 */
  codes: (codes: string): string => `くわしい理由の記号: ${codes}`,
  reasons: {
    // MI-F3（MI-F4 の報告の片付け）: 利用者が知りえない値を手で入れさせる案内は、最後の手段にする（まず手動のログインでもう一度ログインする）。
    REDACTED_PATH:
      'アドレスの後ろのうち、値に見える部分を伏せてあるので、この行からは送信先が決まりません。まず、もう一度手でログインしてください（ログインの送信先は、決まれば自動で登録されます）。それでも決まらないときだけ、ブラウザの開発者ツールの通信の記録で送信先のアドレスの後ろを確かめ、「ログインの設定の画面で直す」から入れてください。',
    EXCLUDED_PATH: '読まないページか、危険な語（ログアウト・削除など）を含むアドレスなので、登録しません。',
    ALREADY_REGISTERED: 'この送信は、もう登録してあります。回数の上限か送り方の違いで止めた行は、「ログインの設定の画面で直す」から直してください。',
    NO_TOKEN_TARGET: 'ログインの合い札をもらう送信先がまだないので、ログインに伴う送信を足せません。先に、合い札をもらう送信の行を登録してください。',
    NO_STORAGE_KEY:
      'ログインできたことを示す、ブラウザの保存場所の鍵が分かりません。まず、もう一度手でログインしてください（ログインの後の画面で鍵を見つけられれば、自動で入ります）。それでも決まらないときだけ、ブラウザの開発者ツールのローカル ストレージで鍵の名前を確かめ、「ログインの設定の画面で直す」から成功の鍵の形を入れてください。',
    SIDE_REQUEST_LIMIT: 'ログインに伴う送信は、もう上限の数まで登録してあります。',
    // MI-8（設計書 4.9、MI-4 の判断）: 自動ログインのプロファイルの利用者は、先に手動のログインへ戻す必要がある（詳しい設定の編集で方式を戻す）。
    NEW_TARGET_FROM_AUTOMATED_LOGIN:
      `自動ログインの記録や、自動ログインのサイトからは、新しいログインの送信先（ログインの合い札をもらう送信先と、ログインのときに通ってよい外のサイトのアドレス）を足せません。一度手でログインすると、ログインの送信先が自動で登録されます。自動ログインのサイトでは、${ADVANCED_SETTINGS_REF_TEXT}でログインのしかたを「手でログインする」に戻してから、一度手でログインしてください。`,
    // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルで、ログインの送信先を変える登録（保存の部品の層と同じ文）。
    CREDENTIAL_DESTINATION_LOCKED: `${CREDENTIAL_DESTINATION_LOCKED_TEXT.description}${CREDENTIAL_DESTINATION_LOCKED_TEXT.action}`,
    JOB_NOT_FOUND: 'この作業が見つかりません。',
    ROW_NOT_FOUND: 'この行が見つかりません。画面を読み直してください。',
    PROFILE_NOT_FOUND: '点検するサイトが見つかりません。',
    AUTH_SETUP_NOT_FOUND: 'ログインの設定がまだありません。先にログインの設定の画面で保存してください。',
    PROFILE_CHANGED: '確かめた後にサイトの設定が変わりました。画面を読み直して、もう一度押してください。',
    SAVE_REJECTED: '保存の確かめを通りませんでした。「ログインの設定の画面で直す」から、中身を確かめてください。',
  },
} as const);

/**
 * ジョブの詳細の、発見と READ の確かめのジョブの監査の段の数（T37a。Task 37 の設計書 3.1。成果物の `authentication`。`run.json` と同じ形）の文言。
 * ログインの段の要約（`LOCAL_UI_LOGIN_STAGE_TEXT`）と並べて出す。数だけで、URL・値は出さない。
 */
export const LOCAL_UI_AUDIT_STAGE_TEXT = deepFreeze({
  heading: 'ログインした後の通信の数',
  body: 'ログインした後に画面を見る間に、外のサイト（ログインのときに通ってよいサイト）へ出た通信の数です。残すのは数だけです（アドレス・本文・値は残しません）。',
  registeredReadRequestsAllowed: '通した、登録した見るだけの呼び出し',
  tokenRefreshBlocked: '止めた、ログインの合い札の取り直し',
  otherNonReadBlocked: '止めた、そのほかの見るだけでない送信',
  serviceUnauthorizedResponses: '外のサイトが、ログインしている状態を受け付けなかった返事',
  serviceRequestLimitReached: '外のサイトへの通信の上限',
  /** DEF-141: 1 分あたりの上限で、次の読み込みの前に待った回数と時間の合計。 */
  serviceRequestPacingWaits: '外のサイトへの通信の、1 分あたりの上限で待った回数',
  serviceRequestPacingWaitMs: '外のサイトへの通信の、1 分あたりの上限で待った時間',
  limitReached: '届きました',
  limitNotReached: '届いていません',
  /** 上限に届いたときの説明。 */
  limitReachedNote:
    '外のサイトへの通信の、点検の 1 回あたりの上限に届いたため、残りの画面は読んでいません。上限はログインの設定で決まります。時間を置いてから、もう一度始めてください。',
} as const);

/**
 * DEF-144: 発見と READ の確かめのジョブが安全の違反で止まったときの、違反の中身（成果物 `discovery.json`・`read-evidence.json` の `safetyViolation`）の表示。
 * 違反の種類のコードと文は英数字のまま出す（`run.json` と同じ値）。段の表示は `JOB_SAFETY_VIOLATION_STAGE_LABELS`。
 */
export const LOCAL_UI_SAFETY_VIOLATION_TEXT = deepFreeze({
  heading: '安全のために止めた理由',
  body: '安全の決まりに反することが起きたため、作業を止めました。残すのは、起きたことの種類と場所だけです（本文・アドレスの ? の後ろの値・ブラウザに残るログインの印・ログインの合い札は残しません）。',
  stage: '起きたとき',
  pagePath: 'ページのアドレスの後ろ',
  pressedWords: '押していたボタンの語',
  pressedNoWords: '（語のないボタン）',
  pressedIdentity: '押していた操作の記号',
  count: '違反の数',
  recordTruncated: '安全の記録は、上限に届いたため一部が欠けています（数は全体の数です）。',
  tableCaption: '違反の一覧',
  columns: { code: '起きたこと', message: 'くわしい内容', method: '通信の種類', origin: 'サイトのアドレス', path: 'アドレスの後ろ' },
  noRequest: '（通信なし）',
  noOrigin: '（サイトのアドレスなし）',
  /**
   * PL-W: 違反の記号（`code`。英大文字の識別子）の代わりに出す、起きたことの名前。記号の頭の語で分ける（分け方は画面の側の
   * `apps/local-ui/src/display/labels.ts` の `safetyViolationCodeLabel`）。記号そのものは画面に出さない。
   */
  codeFamilies: {
    CDP: 'ブラウザへの指示がうまくいきませんでした',
    GUARD: 'BeakSight の送信の見張りが、うまく動きませんでした',
    HTTP: '通信を止める処理が、うまくいきませんでした',
    WEBSOCKET: 'つないだままやりとりする接続の扱いが、うまくいきませんでした',
    INTERACTION: 'ボタンを押す試しの後片付けが、うまくいきませんでした',
    REDIRECT: 'ページの移り先をたどれませんでした',
    EGRESS: '外への通信の見張りが、うまく動きませんでした',
    WORKER: 'ページの中の別のプログラムの見張りが、うまく動きませんでした',
    EXTERNAL_SCHEME: '外部のアプリへ移るボタンを見分けられませんでした',
    OTHER: '安全の守りの中で、思わぬことが起きました',
  },
  /** 一覧に載せなかった違反の数（`countText` は `formatCount` の結果で、単位「件」を含む。MI-F3: 後ろに「件」を重ねない）。 */
  omittedText: (countText: string): string => `一覧に載せなかった違反が ${countText}あります。`,
} as const);

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 発見のジョブの、外部のアプリへ移るボタンの扱い（成果物の
 * `externalSchemeProbes`）の表示。
 */
export const LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT = deepFreeze({
  heading: '外部のアプリへ移るボタン',
  body: 'メールや電話など、外部のアプリへ移るボタンは押しません。押してから分かったときは、安全のため画面を閉じ、その画面を 1 回だけ読み込み直して残りのボタンを確かめます。',
  notPressed: '外部のアプリへ移るので押さなかったボタン',
  reloadedPages: '残りのボタンを確かめるために読み込み直した画面',
} as const);

/**
 * T44c（Task 44 の設計書 P1-3）: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数（成果物の `pressLimitProbes`）の表示。
 */
export const LOCAL_UI_PRESS_LIMIT_PROBE_TEXT = deepFreeze({
  heading: '押す数の上限で押せなかった保存・登録のボタン',
  body: '送らずに様子を見るためにボタンを押すのは、1 つの画面で 3 回までです。見えないボタンは数える前に除き、保存・登録・更新などの語のあるボタンを先に押します。上限を超えて押せなかったボタンは、送り方が分からないので、新しく登録・更新をする書き込みの手順の候補になりません。保存のボタンがあるのに候補が出ない画面があれば、この数を確かめてください。',
  priorityNotPressed: '上限で押せなかった、保存・登録・更新などの語のあるボタン',
} as const);

/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの、ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`）の表示。理由の
 * 説明は `INCOMPLETE_REASON_DESCRIPTIONS`、次にできることは `INCOMPLETE_REASON_NEXT_STEPS`。
 */
export const LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT = deepFreeze({
  heading: '確かめきれなかったページの理由',
  body: '点検したページのうち、一部を確かめきれなかったページの数を、理由ごとに示します。くわしくはレポートのページの欄を見てください。',
  tableCaption: '理由ごとのページ数',
  columns: { reason: '理由', pages: 'ページ数', nextStep: '次にできること' },
} as const);

/** DEF-144: 違反が起きた段（`JobSafetyViolationStage`）の表示。 */
export const JOB_SAFETY_VIOLATION_STAGE_LABELS = deepFreeze({
  CONTEXT_OPEN: 'ブラウザの画面を開く間',
  PAGE_LOAD: '画面を開いて読むところ',
  SUBMISSION_PROBE: '画面を読み込んで見ている間',
  CONTEXT_CLOSE: '送らずに様子を見るためにボタンを押している間',
} as const satisfies Record<JobSafetyViolationStage, string>);

/**
 * ログインの段で止めた読み取りでない要求の理由（`src/control/worker-protocol.ts` の `WORKER_LOGIN_STAGE_BLOCK_REASONS`）ごとの表示（T34e）。書き漏れと
 * 余分は、画面の側（`apps/local-ui/src/display/catalog-coverage.ts`）で型で確かめる。
 */
export const LOGIN_STAGE_BLOCK_REASON_LABELS = deepFreeze({
  TOKEN_REQUEST_OVER_LIMIT: 'ログインの合い札をもらう送信が、回数の上限を超えた',
  TOKEN_REQUEST_NOT_SCRIPT: 'ログインの合い札をもらう送信先への、ページの中のプログラムからでない送信',
  TOKEN_REQUEST_QUERY_MISMATCH: 'ログインの合い札をもらう送信先への、アドレスの ? の後ろに必ずある名前が違う送信',
  SIDE_REQUEST_OVER_LIMIT: 'ログインに伴う送信の回数の上限を超えた',
  SIDE_REQUEST_NOT_SCRIPT: 'ログインに伴う送信の送信先への、ページの中のプログラムからでない送信',
  UNREGISTERED_NON_READ: '登録していない、見るだけでない送信',
  // T36R-fix（T36R の M-2）: 資格情報を含む要求の理由は行にしない（数だけ。`LOCAL_UI_LOGIN_STAGE_TEXT.credentialRequestsBlocked`）。
  NON_READ_METHOD: 'ログインの送信先でない所への、見るだけでない送信',
} as const);

/**
 * ログインの後の SPA の監査の画面の文言（T35d。Task 35 の設計書 3.1、3.4）。認証の設定の画面の、スクリプトの送信のときだけ出す「監査で通す読み取りの
 * 手続きの呼び出し」の一覧と、「サービスの Origin への要求の上限」の欄。
 */
export const LOCAL_UI_SPA_AUDIT_TEXT = deepFreeze({
  setup: {
    auditReads: '点検のときに通す、見るだけの呼び出し',
    /** 一覧の補足（`maxText`・`perLoadText` は `formatCount`・`formatTimes` の結果）。 */
    auditReadsHint: (maxText: string, perLoadText: string): string =>
      `点検のステップで、ページの中のプログラムが出す送る通信のうち、ここに登録した送信先へのものだけを、1 回の読み込みで決まった回数まで通します（${maxText} まで登録できます。1 回の読み込みで ${perLoadText} まで通します）。`,
    auditReadsJudgement:
      '登録するのは、データを見るだけの呼び出しです。見るだけかどうかは、あなたが判断して登録します。まず空のまま試し、点検でできたファイルの安全の記録で止めた通信を見て、要るものだけを登録してください。',
    readOrigin: '呼び出し先のサイトのアドレス',
    readPath: '呼び出し先のアドレスの後ろ',
    readMaxPerPageLoad: '1 回の読み込みの回数',
    addRead: '呼び出しを足す',
    removeRead: 'この呼び出しを消す',
    noReads: '点検のときに通す、見るだけの呼び出しはありません。',
    limitsHeading: 'ログインのときに通ってよい外のサイトへの通信の上限',
    /**
     * 上限の補足（既定の値。`perMinuteText`・`perRunText`・`perPageText` は `formatCount` の結果）。T44f: 1 回の Run あたりの既定は、`perRunText` か、ページの上限 ×
     * `perPageText`（`SERVICE_REQUESTS_PER_PAGE_ALLOWANCE`）の大きいほう。
     */
    limitsBody: (perMinuteText: string, perRunText: string, perPageText: string): string =>
      `点検のステップで、ログインのときに通ってよい外のサイトへ送る通信の数の上限です。空なら、1 分あたり ${perMinuteText}、点検の 1 回あたり ${perRunText} か「ページの上限 × ${perPageText}」の大きいほうを使います。書くときは、小さくはできますが、大きくはできません。1 分あたりの上限に届くと、次の画面を読む前に待ってから続けます（ページの途中では止めません）。点検の 1 回あたりの上限に届くと、点検を止めます。`,
    perMinute: '1 分あたりの上限',
    /** 欄の補足（`minText`・`maxText` は `formatCount` の結果）。 */
    perMinuteHint: (minText: string, maxText: string): string => `${minText} から ${maxText} まで（空なら ${maxText}）。`,
    perRun: '点検の 1 回あたりの上限',
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
    heading: 'サイトの下調べ',
    body: 'ログインしないで開始のアドレスを 1 回だけ読み、ログインの画面の欄と送り方を調べて、ログインの設定の案を作ります。欄の値は読まず、送信や書き込みはしません。読み込みは 1 回だけで、ほかの作業と同時には動きません。',
    // PL-4: ボタンの名前は、サイトの画面と同じ `LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY`（`EntryCheckPanel` が読む。前は「入口を確かめる」）。
    starting: '始めています…',
    cannotStart: '今はサイトを下調べできません。',
    rejectedHeading: 'サイトの下調べを始められませんでした',
    latestHeading: '最後に成功したサイトの下調べ',
    latestJob: '作業の様子を見る',
    latestFinishedAt: '終わった日時',
    noLatest: 'まだ成功したサイトの下調べはありません。',
    proposalAvailable: 'この結果から、ログインの設定の案を作れました。ログインの設定がまだなかったときは、BeakSight がこの案で保存します（すでにある設定は更新しません）。',
    noProposal: 'この結果からは、ログインの設定の案を作れませんでした（ログインの画面に見えない、点検してよいサイトの外へ移った、など）。',
  },
  job: {
    heading: 'サイトの下調べの結果',
    unavailable: 'サイトの下調べの結果のファイル（entry-check.json）を読めないため、結果を示せません。',
    endReason: '終わり方',
    landing: '移った先',
    landingInside: '点検してよいサイトの中',
    landingOutside: '点検してよいサイトの外（サイトのアドレスだけを記録）',
    loginPage: 'ログインの画面に見えるか',
    loginPageYes: '見える（見えるパスワードの欄がある）',
    loginPageNo: '見えない（見えるパスワードの欄がない）',
    fieldsHeading: '欄の候補',
    fieldColumn: '欄',
    candidatesColumn: '見える候補の数',
    selectorColumn: '1 つだけを指す部品の目印',
    noSelector: '（案なし）',
    fields: { username: 'ユーザー名の欄', password: 'パスワードの欄', submit: '送信の部品' },
    formHeading: 'フォーム',
    placement: '3 つの部品の置き方',
    placementUnknown: '（3 つのどれかの候補がちょうど 1 つでないため、分かりません）',
    method: '通信の種類',
    action: '送り先',
    none: 'なし',
    proposalHeading: 'ログインの設定の案',
    noProposal: '案は作っていません。',
    loginStartUrl: 'ログインを始めるページのアドレス',
    sessionLostPathPrefix: 'ログインが切れたと見なすアドレスの後ろ（これで始まる）',
    loginTransport: '送り方',
    loginPostEndpoint: 'フォームの送信先',
    selectorsHeading: '自動ログインの部品の目印',
    blockedRequests: 'BeakSight の送信の見張りが止めた、ページが出した通信',
    downloadEntryCheckJson: 'サイトの下調べの結果（entry-check.json）を保存する',
  },
  authSetup: {
    /** 新しい認証の設定に、入口の確かめの案を埋めたことの案内（`finishedAt` は表示の日時）。 */
    proposalNotice: (finishedAt: string): string =>
      `サイトの下調べ（${finishedAt}）の案を欄に埋めました。まだ保存していません。値を確かめ、変えたい欄だけを書き直してから保存してください。`,
    /** 自動ログインのプロファイル（全部の欄が要る）の、送り方の案がスクリプトで送るときの文。 */
    // MI-8（設計書 4.9）: 自動ログインのプロファイルからは送信先を足せない（MI-G）ので、手動のログインに戻して観察する道を示す。
    scriptTargetNeeded:
      `送り方の案は、ページの中のプログラムで送る形です。ログインの合い札をもらう送信先はサイトの下調べでは分からず、自動ログインのサイトからは足せません。${ADVANCED_SETTINGS_REF_TEXT}でログインのしかたを「手でログインする」に戻してから、一度手でログインすると、自動で登録されます。`,
    /**
     * T44h の判断 (2)（測りの記録の N3）: 手動のログインのプロファイルの、送り方の案がスクリプトで送るときの文（送信先は、手動のログインの後の自動の登録が埋める）。
     */
    scriptTargetAutoRegistered: `送り方の案は、ページの中のプログラムで送る形です。ログインの合い札をもらう送信先はサイトの下調べでは分からないので、空のまま保存してください。一度手でログインすると、自動で登録されます（下の「${LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.scriptHeading}」の欄の案内）。`,
  },
} as const);

/**
 * MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後の認証の設定の状態（`src/control/auth/auth-setup-proposal.ts` の
 * `ENTRY_CHECK_AUTH_SETUP_STATES`）のうち、認証の設定がないとき（自動で保存できなかったとき）の理由 1 行と、「詳しい設定で認証の設定を作る」のリンク。ジョブの画面の「入口の確かめの結果」と、プロファイルの
 * 詳細の「次にすること」が出す（設計者の判断: 認証の設定があるとき（`PRESENT`）は文を出さず、次の段（監査の開始）だけを案内する。`NOT_USED` も出さない）。書き漏れと余分は `apps/local-ui/src/display/catalog-coverage.ts`。認証の設定の画面の「どこから来た値か」の要約も、ここに置く。
 */
export const LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT = deepFreeze({
  states: {
    NOT_CHECKED: `まだサイトを下調べしていないため、ログインの設定を案で作っていません。サイトの画面の「サイトの下調べをやり直す」を押すか、${ADVANCED_SETTINGS_REF_TEXT}で作ってください。`,
    NOT_READ: `サイトの下調べで開始のアドレスを読めなかったため、ログインの設定を案で作りませんでした。もう一度サイトを下調べするか、${ADVANCED_SETTINGS_REF_TEXT}で作ってください。`,
    NOT_LOGIN_PAGE:
      `サイトの下調べで、開始のアドレスのページはログインの画面に見えませんでした（見えるパスワードの欄がありません）。そのため、ログインの設定を案で作りませんでした。${ADVANCED_SETTINGS_REF_TEXT}で作ってください。`,
    PROPOSAL_INVALID:
      `サイトの下調べの案は、ログインの設定の確かめを通らないため、保存しませんでした（たとえば、ログインが済んだと見なすアドレスの後ろを、開始のアドレスから決められないとき）。${ADVANCED_SETTINGS_REF_TEXT}で作ってください。`,
    NOT_SAVED: `保存できませんでした。もう一度サイトを下調べするか、${ADVANCED_SETTINGS_REF_TEXT}で作ってください。`,
  },
  createInAdvanced: AUTH_SETUP_CREATE_IN_ADVANCED_LABEL,
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

/** OP-F: サイトの画面の「登録・更新を試せる画面」の一覧の見出し（一覧の見出しと、まとめて実行の次にできることの文が使う）。 */
const WRITE_SCREENS_HEADING_TEXT = '登録・更新を試せる画面';
/** FM2d: まとめて実行の、各段のジョブの画面で次にできることを確かめる案内（止めた理由の多くに共通）。 */
const STAGE_CHAIN_SEE_STAGE_TEXT = '止まったステップの作業の様子を開き、その画面の「次にできること」を確かめてください。';
/**
 * FM2d: まとめて実行は再開しない旨（止まった監査の段は、監査として再開できる）。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3）: 開始の画面の
 * 「点検を始める」が、まとめて実行を始める（点検のステップは、続きがあれば続きから。始め方の既定）。
 */
const STAGE_CHAIN_NO_RESUME_TEXT = `止まったステップの続きからは進めません。もう一度「${LOCAL_UI_AUDIT_TEXT.start.submit}」を押すと、点検のステップから始め直します（点検は、前回の続きがあれば続きから読みます）。`;
/** PL-3: まとめて実行を始め直す操作の文（開始の画面の主のボタン「点検を始める」）。 */
const STAGE_CHAIN_RESTART_TEXT = `もう一度「${LOCAL_UI_AUDIT_TEXT.start.submit}」を押してください。`;

/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の画面の文言。ジョブの詳細の連鎖の欄（`detail`）、
 * 止めた理由ごとの次にできること（`stopReasons`。`CHAIN_STOP_REASONS`）。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3）: 開始の画面の
 * 「まとめて実行する」の欄（前の `start`）はなくした（主のボタン「点検を始める」が、まとめて実行を始める。文言は `LOCAL_UI_AUDIT_TEXT.start`）。状態と理由のラベルと色は、表示カタログ（`catalog.ts`。FM2R の Minor 3）。
 * 段の種類の名前は、ジョブの種類の表示（`AUDIT_JOB_KIND_CATALOG`）を使う（ここに書かない）。網羅は画面の側の `catalog-coverage.ts` で型で確かめる。
 */
export const LOCAL_UI_STAGE_CHAIN_TEXT = deepFreeze({
  detail: {
    heading: 'まとめて実行',
    state: '状態',
    stages: 'ステップ',
    /** OP-3: 要点のパネルの中の、止まった理由の 1 行（`label` は止めた理由の表示）。 */
    stopReasonLine: (label: string): string => `止まった理由: ${label}`,
    thisStage: 'この作業',
    openStage: '作業の様子を見る',
    /** FM2R の Minor 1: この画面が止まった段のジョブで、止めた理由がこの画面の終わり方と同じとき（理由と次にできることを繰り返さない）。 */
    stoppedHere: 'まとめて実行は、このステップで止まりました。次にできることは、この画面の欄にあります。',
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 「まとめて実行をやめる」のボタンと、その結果の文はなくした（止めるのは、要点の
    // 「点検を止める」の 1 つ）。
  },
  // FM2R の Minor 3: 連鎖の状態・段の状態・止めた理由のラベルと色は、表示カタログ（`STAGE_CHAIN_STATE_CATALOG` など。`catalog.ts`）。ここは次にできることの文。
  stopReasons: {
    USER_STOPPED: { nextStep: STAGE_CHAIN_NO_RESUME_TEXT },
    SAFETY_VIOLATION: { nextStep: SAFETY_STOP_NEXT_STEP_TEXT },
    SESSION_LOST: { nextStep: `${STAGE_CHAIN_SEE_STAGE_TEXT}ログインの欄の案内に従ってから、${STAGE_CHAIN_RESTART_TEXT}` },
    SITE_UNAVAILABLE: { nextStep: `サイトが応答するようになったことを確かめてから、${STAGE_CHAIN_RESTART_TEXT}` },
    SERVICE_REQUEST_LIMIT_REACHED: { nextStep: serviceLimitNextStepOf(LOCAL_UI_AUDIT_TEXT.start.submit) },
    STAGE_FAILED: { nextStep: `${STAGE_CHAIN_SEE_STAGE_TEXT}直してから、${STAGE_CHAIN_RESTART_TEXT}` },
    PROFILE_REVISION_CHANGED: {
      nextStep: `まとめて実行は、始めたときのサイトの設定に結びついています。変更を確かめてから、${STAGE_CHAIN_RESTART_TEXT}`,
    },
    NEXT_STAGE_REJECTED: {
      nextStep: `画面のサーバが終わる途中か、使用中の印を失った可能性があります。画面のサーバを確かめてから、${STAGE_CHAIN_RESTART_TEXT}`,
    },
    // OP-2: 結果が分からない画面の後は、残りの登録・更新をしない（作ったデータが残っているかもしれない）。
    WRITE_RESULT_UNKNOWN: {
      nextStep: 'テスト環境の画面で、データが作られたかを確かめてください。残りの画面の登録・更新はしていません。',
    },
    // OP-F: 試せなかった画面には、何も送っていない。行の様子は、サイトの画面の一覧に出る。
    WRITE_NOT_TRIED: {
      nextStep: `試せなかった画面には、何も送っていません。サイトの画面の「${WRITE_SCREENS_HEADING_TEXT}」の一覧で、その画面の様子を確かめてください。`,
    },
  },
} as const);

/**
 * PL-5（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 5・6、6 章の 6〜8、8 章）: 書き込みのステップの画面（操作さがし、書き込みの
 * 手順の詳細、書き込みを始める、作ったデータの一覧、見るだけの確かめ）の、要点のパネルの文と主のボタンの語。言葉は同じ設計書の 5 章にそろえる。数は
 * `formatCount` の結果を受ける（ここで組み立てない）。
 */
export const LOCAL_UI_WRITE_STAGE_TEXT = deepFreeze({
  /** 要点のパネルの見出し（サイトの画面と同じ語）。 */
  summaryHeading: LOCAL_UI_NEXT_STEP_TEXT.summaryHeading,
  discovery: {
    /** 書き込める操作（登録と書き換えの形）の数（`countText` は `formatCount` の結果）。 */
    found: (countText: string): string => `書き込める操作が ${countText}見つかりました。`,
    foundNone: '書き込める操作は見つかりませんでした。',
    /** 書き込みを試さないサイトの、見つかった操作の数。 */
    foundReadOnly: (countText: string): string => `操作さがしが終わりました。見つかった操作は ${countText}です。`,
    nextCreate: '次は「書き込みの手順を作る」を押します。まだ何も送りません。',
    drafted: '書き込みの手順は作ってあります。次は、書き込みの手順を開いて、書き込みの OK を出します。',
    searchAgain: 'もう一度さがす',
    createDrafts: '書き込みの手順を作る',
    openScenarios: '書き込みの手順を見る',
    candidatesHeading: '見つかった操作',
    /** 画面ごとの見出し（`path` はアドレスの後ろ）。 */
    pageHeading: (path: string): string => `${path} の画面`,
  },
  scenario: {
    approve: '書き込みの OK',
    start: '書き込みを始める',
    /** 主のボタンが「書き込みの OK」のときの、次にすることの文。 */
    nextApprove: '次は「書き込みの OK」を押して、何をどこへ書き込むかを確かめます。',
    /** 主のボタンが「書き込みを始める」のときの、次にすることの文。 */
    nextStart: '次は「書き込みを始める」を押します。',
    /** 書き込みの OK は出ているが、このサイトでは今は始められないとき。 */
    cannotStart: 'このサイトでは、今は書き込みを始められません。サイトの画面で、点検のしかたを確かめてください。',
    /** 9 の (4): フォームの登録で、作ったデータの ID の取り方を決められなかった（書き込みはできるが、書き換えはその登録からはできない）。 */
    recordIdUndetermined: '作ったデータを後で探せないので、この登録で作ったデータの更新は試せません（登録は試せます）。',
    /** 答え合わせのしかたを決められなかった（書き込みの OK は出せるが、始められない）。 */
    verificationMissing: '答え合わせのしかたを決められなかったので、書き込みの結果を確かめられません。このままでは書き込みを始められません。',
    /** 入れる値の決まりに、推せなかった欄がある（詳しい内容で決める）。 */
    rulesInsufficient: '入れる値を決められない欄があります。下の「詳しい内容」の「入れる値の決まりを開く」で決めてください。',
    /** 9 の (2): 書き換えの答え合わせを、登録の書き込みの手順から写した。 */
    verificationCopied: '答え合わせは登録のときと同じしかたで行います。',
    /** 書き換えの手順の、書き換えるデータがまだないとき。 */
    noPlannedTarget: '更新するデータがまだありません。先に登録の書き込みをして、答え合わせが合ったデータを作ってください。',
  },
  write: {
    /** 書き込みを始める画面の、何を・どこへ・何件の文の前の 1 行。 */
    ready: '中身を確かめてから「書き込みを始める」を押してください。押すと、確認の画面が出ます。',
    /** 今は始められないとき（理由はこの下の行）。 */
    notReady: 'まだ書き込みを始められません。理由は次のとおりです。',
    /** 次に始められる時刻（`atText` は `formatDateTime` の結果）。 */
    waitUntil: (atText: string): string => `${atText}から始められます。`,
  },
  ledger: {
    /** 行の数（`countText` は `formatCount` の結果）。 */
    count: (countText: string): string => `BeakSight が作ったデータは ${countText}です。`,
    none: 'BeakSight が作ったデータは、まだありません。',
    nextUpdate: '次は「更新を試す」を押して、変える欄を選びます。',
    updateTry: '更新を試す',
    columns: {
      what: '何を作ったか',
      at: 'いつ',
      updated: '更新したか',
    },
    /** 行の「何を作ったか」（OP-3: `screenText` は画面の呼び名 `LOCAL_UI_WRITE_SCREENS_TEXT.screenName` の結果。アドレスの後ろは出さない）。 */
    what: (screenText: string): string => `${screenText}で登録したデータ`,
    updatedYes: (countText: string): string => `更新した（${countText}）`,
    updatedNo: 'まだ更新していない',
  },
  readChecks: {
    /** 見るだけの確かめの数（`countText` は `formatCount` の結果）。 */
    count: (countText: string): string => `見るだけの確かめは ${countText}あります。`,
    none: '見るだけの確かめは、まだありません。操作さがしの後に、BeakSight が答え合わせに使うものを作ります。',
    optional: 'この画面は、見るだけの点検をしたいときだけ使います。ふだんの書き込みの流れでは開かなくてかまいません。',
  },
} as const);

/**
 * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.2 の R1〜R3）: サイトの画面の「登録・更新を試せる画面」の一覧（チェックの欄つき）。
 * 一覧の上の 1 行、行の名前（画面の名前が取れないときの、やさしい形の 1 行）、行の状態、前の点検の結果の 1 行、保存できなかったときの 1 行。
 */
export const LOCAL_UI_WRITE_SCREENS_TEXT = deepFreeze({
  heading: WRITE_SCREENS_HEADING_TEXT,
  intro: 'チェックした画面では、点検のときに、テスト用のデータを 1 件登録し、1 回更新します。作ったデータは消しません。',
  none: '登録・更新を試せる画面は、まだ見つかっていません。点検をすると、見つかった画面がここに出ます。',
  /** 画面の名前が取れないときの、やさしい形の 1 行（`word` は path の、番号でない最後の区切り）。 */
  screenName: (word: string): string => (word.length === 0 ? '登録の画面' : `「${word}」の登録の画面`),
  /**
   * OP-G（指示書の 7）: 「登録・更新を試せる画面」の一覧で、見出しの取れない画面の名前（英字の path を出さない。`positionText` は、名前のない行の中の順の番号の
   * `formatInteger` の結果）。
   */
  unnamedScreen: (positionText: string): string => `登録の画面（${positionText}）`,
  /**
   * OP-2 の修正の 1 回目（判断 1）: メールや電話への知らせを送ることがある画面の行の 1 行（副作用の確認の 4 つの約束のうち、通知の約束をやさしい形にした文）。
   * チェックを入れることが、この確認を兼ねる。
   */
  mayNotify: 'この画面は、メールや電話への知らせを送ることがあります。テスト用のサイトで、だれにも届かない設定のときだけチェックしてください。',
  states: {
    CHECKED: 'チェックしています',
    CHECKABLE: 'チェックできます',
    RECHECK_NEEDED: 'サイトの設定が変わったので、チェックが外れました。もう一度チェックしてください。',
    NOT_CHECKABLE: 'この画面では試せません',
  },
  /**
   * OP-2 の修正の 2 回目（判断 2）: 試せない行の理由（種類ごとのやさしい 1 行。種類の振り分けは `write-screen-functions.ts` の `writeScreenNotCheckableKindOf`。
   * 網羅は `catalog-coverage.ts`）。
   */
  notCheckable: {
    SECRET_FIELD: 'パスワードなどの秘密に見える欄があるため、試せません。',
    DESTRUCTIVE: '消す・取り消すなどの操作に当たる欄があるため、試せません。',
    ANSWER_CHECK: '答え合わせのしかたを決められないため、試せません。',
    SITE_CHANGED: 'サイトの設定が変わったため、まだ試せません。もう一度点検すると、試せるようになります。',
    UNSUPPORTED: 'この画面の入力のしかたを扱えないため、試せません。',
    // OP-K（K2）: 本物のテスト環境で「扱えない」になった理由に合わせた 1 行。
    SECRET_KEY: '画面が自動で送る項目に、秘密に見える名前のものがあるため、試せません。',
    FIELD_SHAPE: '入れた値と、送る中身の結び付きが分からないため、試せません。',
  },
  /**
   * OP-2 の修正の 2 回目（設計書 4.1.2 の R1）: 更新の 1 行。更新の画面は作ったデータがあるときにしか見つからないので、まだ見つからないときは次の点検で試す。
   * 見つかったが更新する欄を決められないときは、登録だけを試す。
   */
  update: {
    NEXT_INSPECTION: '更新は、次の点検で試します。',
    NOT_DECIDABLE: '更新する欄を決められないため、登録だけを試します。',
    /** OP-F（安全のレビューの M-3）: 点検の中で見つかった更新の画面が知らせを送ることがあり、チェックがそれを確かめていない（更新は自動では承認しない）。 */
    MAY_NOTIFY: '更新の画面は、メールや電話への知らせを送ることがあります。もう一度チェックすると、更新も試します。',
  },
  lastResult: {
    heading: '前の点検の結果',
    created: '登録しました',
    /** OP-2 の修正の 2 回目（R1）: 更新の書き込みの手順がまだない行の、登録だけの 1 行。 */
    createdOnly: '登録しました。',
    createNotVerified: '登録は確かめられませんでした。',
    updated: '更新しました',
    updateNotVerified: '更新は確かめられませんでした',
    updateNotTried: '更新は試せませんでした',
    /** 登録の文と更新の文をつないだ 1 行（OP-H: どちらの文も句点で終わる）。 */
    line: (createText: string, updateText: string): string => `${createText}。${updateText}。`,
    /**
     * OP-F（設計者の判断の 4）: 最後の回が、送らずに締めた回（準備が通らなかった・止めた）のときの 1 行（`reason` は理由の文）。前に確かめた結果は、別の 1 行で残す。
     */
    notTried: (reason: string): string => `前回は試せませんでした。${reason}`,
    /** 最後の更新の回だけが、送らずに締めた回のとき。 */
    updateNotTriedLast: (reason: string): string => `前回は更新を試せませんでした。${reason}`,
    /** 送らずに締めた理由（`ACTION_BLOCK_REASONS`）のやさしい文。網羅は `catalog-coverage.ts`。 */
    notSentReasons: {
      PRECHECK_FAILED: '点検の中で止めたか、送る前の準備が整わなかったため、何も送っていません。',
      PAYLOAD_MISMATCH: '送る直前の確かめで、送る内容が決めたものと違ったため、何も送っていません。',
    },
  },
  saving: '保存しています…',
  rejections: {
    PROFILE_NOT_FOUND: 'サイトが見つかりません。サイトの一覧から開き直してください。',
    MODE_SWITCH_FAILED: 'このサイトを書き込みに使えるようにできませんでした。ログインの設定を確かめてから、もう一度チェックしてください。',
    SCREEN_NOT_DRAFTABLE: 'この画面の登録・更新の手順を作れませんでした。点検をもう一度してから、チェックしてください。',
    FACTS_UNAVAILABLE: 'サイトの設定を読めませんでした。画面を読み込み直してください。',
    APPROVAL_REJECTED: 'この画面の登録・更新を有効にできませんでした。点検をもう一度してから、チェックしてください。',
  },
  requestFailed: '保存できませんでした。画面を読み込み直してください。',
  /**
   * 点検の要点の書き込みの 1 行（OP-G: 実際に送った段と結果から決める。前は書き込みの段があれば、結果によらず「登録・更新も行いました」の 1 つだった。決め方は
   * `display/write-screen-values.ts` の `inspectionWriteOutcomeOf`。網羅は `catalog-coverage.ts`）。
   */
  inspectionWrite: {
    /** 登録も更新も確かめられた。 */
    WROTE: 'チェックした画面では登録・更新も行いました。',
    /** 登録だけを行い、確かめられた（更新の画面がまだない）。 */
    CREATED: 'チェックした画面では登録も行いました。',
    /** 送ったが確かめられなかったもの、または試せなかった画面がある。 */
    NOT_CONFIRMED: 'チェックした画面の登録・更新に、確かめられなかったものか、試せなかったものがあります。',
    /** チェックした画面があったが、1 つも試せなかった（何も送っていない）。 */
    NOT_TRIED: 'チェックした画面の登録・更新は、試せませんでした（何も送っていません）。',
  },
} as const);

/**
 * PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章）: ローカルの管理画面の枠の、共通の文言（今どこにいるかの 1 行の区切り、知らせの種類の語、
 * 左のメニューの環境の知らせ）。言葉は同じ設計書の 5 章にそろえる。1 行の項目の名前は、各画面の題と同じ鍵を使う（ここに書き写さない）。
 */
export const LOCAL_UI_FRAME_TEXT = deepFreeze({
  /** 今どこにいるかの 1 行の区切り（`components/PageFrame.tsx` の中の 1 か所だけが使う。読み上げでは読まない）。 */
  trailSeparator: '＞',
  /** 知らせに見出しがないときに出す、種類の語（鍵は `components/Notice.tsx` の `NoticeKind`。網羅は `catalog-coverage.ts`）。 */
  noticeKinds: {
    caution: '注意',
    critical: '大事',
    positive: '済み',
  },
  /** 左のメニューの、環境に問題があるときだけ出す項目（行き先は環境の状態の画面）。 */
  environmentProblem: '環境に問題があります',
} as const);
