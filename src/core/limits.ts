// 複数のownerで同じ意味を持つ上限値と、複数の collector で共有する Evidence の収集の上限（console・network・Resource Timing の件数や長さ）。
// 1つの collector だけが使う収集の値（LAYOUT_THRESHOLDS など）と、特定のownerが意味を決める上限（Interaction 候補の上限など）は、そのownerに置く。

// URL-LEN・L14: URL の長さの上限（前の `MAX_URL_LENGTH`）は撤廃した。LZ-2: URL 以外の文の長さの上限（エラーの文・エラーの名前・stack・console の文・
// header の値・セレクタ・サイトの metadata の本文。前の `MAX_ERROR_MESSAGE_LENGTH`・`MAX_ERROR_NAME_LENGTH`・`MAX_STACK_LENGTH`・
// `MAX_CONSOLE_TEXT_LENGTH`・`MAX_HEADER_VALUE_LENGTH`・`MAX_SELECTOR_LENGTH`・`MAX_SITE_METADATA_TEXT_LENGTH`）も撤廃した。
import { PRODUCTION_OBSERVATION_WINDOWS } from './observation-windows.js';

/**
 * HTTP メソッドの最大長。LZ-2 の後は、本番の要求の型（`src/core/api-request-shape.ts`）の method を伏せるかの判断だけが使う（承認の型の digest に関わるので、
 * LZ-2 では外さず、設計者の判断を待つ）。記録の method は切り詰めない。
 */
export const MAX_HTTP_METHOD_LENGTH = 32;

/**
 * DN-1（設計書 `2026-11-16-beaksight-profile-display-name-design.md` 2 章）: サイトの画面に出す名前の長さの上限（前後の空白を除いた文字の数）。
 * 保存の部品（`saveProfileDisplayName`）と画面の文（`LOCAL_UI_DISPLAY_NAME_TEXT`）が使う。管理データの版 22 の CHECK は、公開した時点のこの値の写し。
 */
export const MAX_PROFILE_DISPLAY_NAME_LENGTH = 80;

/** CSS selectorを組み立てるときにたどる祖先の最大の深さ。 */
export const MAX_SELECTOR_DEPTH = 8;

/** ジオメトリ（CSSピクセル）を比べるときの許容誤差。 */
export const GEOMETRY_EPSILON_PX = 0.5;

// L2（N8・N9）: 1 ページで記録する console・pageerror・ネットワークの要求の件数の上限（前は 1,000・200・2,000）は撤廃した（定数は LZ-1 で消した）。

/** Resource Timing のバッファの大きさ（`performance.setResourceTimingBufferSize`）と、記録する Resource Timing の最大件数。 */
export const MAX_RESOURCE_TIMING_ENTRIES = 500;

// LZ-3a: sitemap.xml の Evidence に記録する `<loc>` の URL の件数の上限（前は `MAX_SITEMAP_URLS` 50,000）は撤廃した。URL を残らず記録する
// （`sitemapUrlsTruncated` は前の記録のために残し、いつも偽）。

// SPEC-5（設計書 2026-11-14 5.1）: Interaction の安定の窓と持続の窓（前の `INTERACTION_STABILITY_WINDOW_MS`・`INTERACTION_PERSISTENCE_WINDOW_MS`、
// どちらも 500ms）と、その和から導いた `crawl.interactionTimeoutMs` の下限（前の `MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS`）はやめた。押した後は、ページの
// 落ち着き（`PAGE_SETTLING_PACING`）を待ってから 1 回だけ観測する。

// ---------------------------------------------------------------------------------------------------------------
// Page Auditor の期限と待ち方（Task 14〜17 の設計書 4.5.7）。Page Auditor の期限の計算（`stageDeadline` など）が参照する。
// ---------------------------------------------------------------------------------------------------------------

/**
 * `auditInteraction` が `InteractionOwnerCleanupError`（後片付けの失敗）を投げたときに、Page Auditor が、エラーが保持する
 * session の `close()` を1回試みる時間の上限（ms。設計書 4.5.7、4.5.8）。この時間を過ぎたら、`close()` の終わりを待たない。
 * 候補ごとの期限の見積もりには使わない（見積もりは `INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE` を使う）。
 * 値は、Context を閉じるときに Guard が保留中の処理を待つ上限（`src/safety/passive-request-guard.ts` の
 * `GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS`。2026-09-24 時点で 1,000ms）に、Context と page を閉じる処理そのものの余裕を 1,000ms 足したもの。
 */
export const INTERACTION_CLEANUP_ALLOWANCE_MS = 2_000;

// L10（N22）: Guard が同時に持てる要求の横取りの作業の数の上限（前は 4,096。超えたら `GUARD_TASK_LIMIT_REACHED`）は撤廃した（定数は LZ-1 で消した）。

/**
 * Browser を閉じる処理（`browser.close()`）を待つ時間の上限（ms。R15 の Minor-2）。Run Coordinator と PREFLIGHT が使う。
 * この時間を過ぎたら、閉じる処理の失敗として記録し、終わりを待たずに進む。
 * 値の根拠: Browser を閉じる処理は、Context と page を閉じ、Chromium のプロセスを終えるまでで、ふだん 1 秒未満で終わる。
 * 残った Context が多い場合や、負荷の高い環境でも収まるよう、10 倍程度の余裕を取った。
 */
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Guard の付いた Passive Context を閉じる処理（factory の `closePassiveContext`）を待つ時間の上限（ms。DEF-008。
 * Task 18 の前の整理の設計書 4.2）。この時間を過ぎたら、Context を閉じる処理の失敗として記録し、終わりを待たずに進む。
 * 待つのをやめるだけで、Guard の状態は変えない（Context を閉じる処理が終わらない間も、Guard はリクエストを止め続ける）。
 * 値の根拠: 以前の page を閉じる処理の上限（DEF-006 の 5 秒。DEF-038 で Passive の page を個別に閉じなくなり、CCX-21 で消した）と同じにした。
 * Context を閉じる処理は、Guard が保留中の処理を待つ時間
 * （`GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS`。2026-09-25 時点で 1,000ms）と、page と Context を閉じる時間で、ふだん 1 秒程度で終わる。
 */
export const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * 認証つきの Run（Task 25 の設計書 4.3。T25c）で、Context の認証済みの状態（`storageState()`）を取り出す処理を待つ時間の上限（ms）。
 * この時間を過ぎたら、取り出しの失敗として数え、前の状態のまま進む（値は記録しない）。公開監査では使わない。
 * 値の根拠: 取り出しは、Cookie の読み出しと、Origin ごとの localStorage の読み出し（開いている page の中か、通信をしない隠れた page）で、
 * ふだん数十 ms で終わる（T25c の実験）。閉じる処理の中で行うので、閉じる処理を待つ上限（`CONTEXT_CLOSE_TIMEOUT_MS`）の半分未満にした。
 */
export const AUTHENTICATED_STATE_READ_TIMEOUT_MS = 2_000;

/**
 * Guard の付いた Passive Context と page を作る処理（`newContext`、Guard の取り付け、`newPage`、Guard の準備）を待つ時間の上限
 * （ms。DEF-008。Task 18 の前の整理の設計書 4.2）。この時間を過ぎたら、作成の期限切れの失敗とし、遅れて届いた Context は閉じる。
 * 呼び出し元に、より短い全体の期限（ページの期限など）がある場合は、短い方を使う。
 * 値の根拠: Context と page の作成は、ふだん数十〜数百 ms で終わる。負荷の高い環境でも誤って期限切れにしないよう、十分な余裕を取った。
 * 既定のページの期限（60,000ms）の 6 分の 1 である。
 */
export const SESSION_OPEN_TIMEOUT_MS = 10_000;

/**
 * Interaction の候補1つの予算で、`crawl.interactionTimeoutMs` を数える回数（設計書 4.5.7）。
 * 候補1つの予算は、`crawl.navigationTimeoutMs` + この回数 × `crawl.interactionTimeoutMs` である。
 * 1回は操作の時間、もう1回は `auditInteraction` の後片付けの上限（後片付けを始めた時刻 + `interactionTimeoutMs`。
 * `src/interaction/isolated-auditor.ts` の `cleanupDeadlineAtMs`）の分である。
 * Page Auditor の候補ごとの期限が使う（R14 の m2。設定の検証での比べは SPEC-1 で撤廃した）。
 */
export const INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE = 2;

// L1: ページの期限と collector に渡す期限の間の余裕（前は 500ms）は、ページの期限を撤廃したので使わない（定数は LZ-1 で消した）。

/**
 * DOM の準備を待つ処理（`waitForPageSettled`）の待ち方。期限（`deadlineAtMs`）は、Page Auditor が段階ごとに決める。
 * - `pollIntervalMs`: `readyState` と `scrollHeight` を測る間隔。100ms は、1フレーム（約16ms）より十分長く、
 *   安定の時間の中で5回測れる間隔である。短いほど早く終わるが、測る回数が増える。
 * - `stableWindowMs`: 文書の読み込み（`readyState` が `loading`）が終わり、`scrollHeight` が変わらない状態がこの時間続いたら、
 *   落ち着いたとする。500ms は、初期描画の後の画像やフォントによる高さの変化を捉えられ、ページごとの待ち時間を大きくしない長さである。
 * RB-2: 値は観察の窓の一式（`pageSettle`）の本番の値から導く。
 */
export const PAGE_SETTLING_PACING = Object.freeze({
  pollIntervalMs: PRODUCTION_OBSERVATION_WINDOWS.pageSettle.pollIntervalMs,
  stableWindowMs: PRODUCTION_OBSERVATION_WINDOWS.pageSettle.stableWindowMs,
});

// L1: 幅の走査の各幅で形を測るために残す時間（前は 1,500ms）は、幅の期限を撤廃したので使わない（定数は LZ-1 で消した）。

/**
 * controlled scroll（`controlledScroll`）の待ち方（設計書 第11章: 人間に近い一定の刻みと待ちで、極端な操作をしない）。
 * - `stepViewportFraction`: 1回にスクロールする量の、ビューポートの高さに対する割合。0.75 は、前後の画面を4分の1ずつ重ねて、
 *   遅延読み込みの境界（`IntersectionObserver` の交差）を読み飛ばさない量である（controlled scroll が受け付ける上限は 0.9）。
 * - `stepWaitMs`: 1回のスクロールの後に待つ時間。250ms は、スクロールで始まる読み込みと描画（数フレーム）を待ち、
 *   高さ 10 画面程度のページを数秒でたどれる長さである。
 * - `stableWindowMs`: 最下部に着いた後、`scrollHeight` が変わらない状態がこの時間続いたら、たどり終えたとする。
 *   DOM の準備の安定の時間と同じ長さにする。
 * RB-2: 待ちの 2 つは観察の窓の一式（`scroll`）の本番の値から導く（量の割合は待ちでないので、ここに置く）。
 */
export const CONTROLLED_SCROLL_PACING = Object.freeze({
  stepViewportFraction: 0.75,
  ...PRODUCTION_OBSERVATION_WINDOWS.scroll,
});

// L1・L9: scroll の段階の予算の倍率（前は `crawl.resourceSettlingTimeoutMs` の 4 倍）は、段階の期限を撤廃したので使わない（定数は LZ-1 で消した）。

/**
 * AUD-1d（ユーザーの判断 2026-11-09）: ChatGPT 用バンドルを部（第 1 部・第 2 部…）に分けるときの、1 つの部の大きさの目安（バイト。中身のバイト数の和）。
 * 集めた証拠は外さず、この大きさを超える分は次の部に入れる（前の画像の予算に代わる。予算で外す決まりはやめた）。
 * 第 1 部は JSON の全部を分けずに入れるので、JSON だけで目安を超えることがある。値の根拠: 前の画像の予算と同じ 64 MiB（ChatGPT に渡せる大きさの目安。
 * 設計者の決定）。
 */
export const CHATGPT_BUNDLE_PART_SIZE_BYTES = 64 * 1024 * 1024;

/**
 * Rule ごとの要約（表示用モデルの `ruleDigests`。ChatGPT 用バンドルの `findings-by-rule.json`）の、1 つの Rule の例の数の上限（T44i。Task 44 の設計書 6 章の
 * 2026-10-22 の行。P2-9）。例は `AuditRunResult.findings` の順で、ページの違うものを先に選ぶ。
 * 値の根拠: 同じ指摘がページごとに繰り返すことを見分けるのに足り、要約の大きさを数十 KB の内に抑える数（設計者の決定）。
 */
export const REPORT_RULE_DIGEST_EXAMPLE_COUNT = 3;

/**
 * BN-c（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3）: 表示用モデルの指摘ごとの、結び付いた BeakSight の遮断の参照
 * （`beaksightBlockRelation.blocks`）の数の上限。超えた分は数だけを残す（`blockCount`）。
 * 値の根拠: 区分の理由を読み手が確かめるのに足り、1 ページで多くの遮断がある Run でもバンドルの大きさを抑える数（BN-c の実装者の決定）。
 */
export const REPORT_BEAKSIGHT_BLOCK_REFERENCE_COUNT = 5;

// LZ-3a: 設定のページの上限の上限（前は `MAX_CRAWL_MAX_PAGES` 100,000）は撤廃した。利用者が指定した正の整数をそのまま受ける。

/**
 * 範囲の手がかり（欄の min・max・step）がない日付・日時の欄に、入力の規則の自動の作成（`src/control/data-rules/rule-set-inference.ts`）が入れる
 * 既定の幅（基準日からの日の数。両端を含む。FM2c。手動の操作を減らす設計書 3A.3）。基準日は、実行の許可の発行日（Asia/Tokyo）。
 * 値の根拠: ユーザーの判断（2026-10-22）。「基準日から 30 日後までの幅」。Task 29 の設計書 10 章の 3「基準日から推さない」を、この場面について改めた。
 */
export const DEFAULT_UNRANGED_DATE_WINDOW_DAYS = Object.freeze({ fromDays: 0, toDays: 30 });

/**
 * 範囲の手がかり（欄の min・max・step）がない数の欄に、入力の規則の自動の作成が入れる既定の幅（両端を含む整数。刻みは 1。FM2c。手動の操作を
 * 減らす設計書 3A.3）。
 * 値の根拠: ユーザーの判断（2026-10-22）。「1〜100 の整数」。
 */
export const DEFAULT_UNRANGED_INTEGER_RANGE = Object.freeze({ min: 1, max: 100 });
