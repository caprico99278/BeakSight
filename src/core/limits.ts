// 複数のownerで同じ意味を持つ上限値と、複数の collector で共有する Evidence の収集の上限（console・network・Resource Timing の件数や長さ）。
// 1つの collector だけが使う収集の上限（DOM_LIMITS、LAYOUT_THRESHOLDS など）と、特定のownerが意味を決める上限（Interaction 候補の上限など）は、そのownerに置く。

/** 記録するURLの最大長（UTF-16 のコード単位）。 */
export const MAX_URL_LENGTH = 2_048;

/** 記録するエラーメッセージの最大長（UTF-16 のコード単位）。 */
export const MAX_ERROR_MESSAGE_LENGTH = 2_048;

/** 記録するHTTPメソッドの最大長。 */
export const MAX_HTTP_METHOD_LENGTH = 32;

/** 記録するCSS selectorの最大長。 */
export const MAX_SELECTOR_LENGTH = 512;

/** CSS selectorを組み立てるときにたどる祖先の最大の深さ。 */
export const MAX_SELECTOR_DEPTH = 8;

/** ジオメトリ（CSSピクセル）を比べるときの許容誤差。 */
export const GEOMETRY_EPSILON_PX = 0.5;

/** 1ページで記録する console メッセージ（error・warning）の最大件数。超えた分は件数だけを記録する。 */
export const MAX_CONSOLE_MESSAGES = 1_000;

/** 1ページで記録する pageerror の最大件数。超えた分は件数だけを記録する。 */
export const MAX_PAGE_ERRORS = 200;

/** 記録する console メッセージの本文の最大長（UTF-16 のコード単位）。 */
export const MAX_CONSOLE_TEXT_LENGTH = 2_048;

/** 記録するエラーの名前（`Error.name`）の最大長（UTF-16 のコード単位）。 */
export const MAX_ERROR_NAME_LENGTH = 256;

/** 記録する stack の最大長（UTF-16 のコード単位）。 */
export const MAX_STACK_LENGTH = 8_192;

/** 1ページで記録するネットワークリクエストの最大件数。超えたリクエストと、その response・失敗は件数だけを記録する。 */
export const MAX_NETWORK_REQUESTS = 2_000;

/** 記録するHTTPヘッダの値の最大長（UTF-16 のコード単位）。 */
export const MAX_HEADER_VALUE_LENGTH = 2_048;

/** Resource Timing のバッファの大きさ（`performance.setResourceTimingBufferSize`）と、記録する Resource Timing の最大件数。 */
export const MAX_RESOURCE_TIMING_ENTRIES = 500;

/**
 * サイトの metadata（robots.txt と sitemap.xml）の Evidence に記録する本文の最大長（UTF-16 のコード単位。Task 14〜17 の設計書 5.6.2）。
 * 超えた分は切り詰め、`textTruncated` を真にする。
 * 値の根拠: 一般的な robots.txt は数 KB で、Google が読む robots.txt の上限（500 KiB）も、ほぼこの長さである。
 * sitemap.xml は1ファイルで最大 50MB になり得るので、本文は全部を残さない。sitemap の URL は、切り詰める前の本文から取り出す
 * （`MAX_SITEMAP_URLS`）。
 */
export const MAX_SITE_METADATA_TEXT_LENGTH = 500_000;

/**
 * sitemap.xml の Evidence に記録する `<loc>` の URL の最大件数（Task 14〜17 の設計書 5.6.2）。超えた分は記録せず、
 * `sitemapUrlsTruncated` を真にする。切り詰めた場合、Cross-page rule は `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
 * 値の根拠: sitemap のプロトコルが1ファイルに許す URL の最大件数（50,000）と同じにした。1ファイルの sitemap は切り詰めずに記録できる。
 */
export const MAX_SITEMAP_URLS = 50_000;

/**
 * Interaction の安定性の確認の時間（設計書 2026-09-23 4.4.1、R5 の N-1）。下準備の hover・focus の後、ページが落ち着くのを待ってから、
 * 凍結の前に、この時間だけ対象を観測し続ける。この間に変わった項目は「不安定」とし、click の後の根拠にしない。
 * 値は、よく使われる hover intent の遅れ（100〜300ms）、CSS の transition（150〜300ms）、300ms 周期のタイマーを、
 * 少なくとも1回は捉えられる長さにした。長くするほど、候補1つあたりの監査が長くなる。
 * `src/interaction/isolated-auditor.ts` と、このファイルの `MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS`（設定の検証
 * `src/config/validate-config.ts` が使う `crawl.interactionTimeoutMs` の下限）が参照するので、ここに1か所だけ置く
 * （F17b。`src/config` と `src/interaction` が互いに依存しないようにするため）。
 */
export const INTERACTION_STABILITY_WINDOW_MS = 500;

/**
 * Interaction の持続の確認の時間（設計書 2026-09-23 4.4.1、R5 の N-3）。click の後に根拠となる変化を見つけてから、この時間の後にも
 * 同じ変化が続いている場合だけ、根拠にする。押し下げたときの ripple（多くの UI の部品集で 400〜450ms 程度）のように、
 * すぐ元に戻る変化を除ける長さにした。置き場所の理由は `INTERACTION_STABILITY_WINDOW_MS` と同じ。
 */
export const INTERACTION_PERSISTENCE_WINDOW_MS = 500;

/**
 * `crawl.interactionTimeoutMs` の下限（この値を含まない）。F17（F16 の発見事項5）。
 * 設定の検証と、設定のスキーマ（`schemas/run.schema.json` の `interactionTimeoutMs` の `minimum` = この値 + 1）が同じ下限を使う。
 * 1つの候補の監査は、凍結の前に安定性の確認の時間の全体を、click の後に持続の確認の時間の全体を、同じ期限の中で使う。
 * 安定性の確認は、残りの時間がその長さ以下なら始めず、持続の確認は、確認の時刻が期限以後なら行わない。そのため、
 * 期限がこの2つの時間の和以下だと、どの候補も VERIFIED にならない（NOT_VERIFIABLE になる）。
 * 読み込みと初期描画は、この期限の外で、読み込みの期限（`crawl.navigationTimeoutMs`）で待つ（R6 の I-2）。
 * hover・focus・落ち着くのを待つ時間・click には決まった長さがないので、下限には含めない。
 */
export const MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS = INTERACTION_STABILITY_WINDOW_MS + INTERACTION_PERSISTENCE_WINDOW_MS;

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

/**
 * Guard の付いた Passive の page を閉じる処理（factory の `closePassivePage`）を待つ時間の上限（ms。DEF-006）。
 * この時間を過ぎたら、page を閉じる処理の失敗として記録し、Context を閉じる処理に進む（Context を閉じると、止まった page も閉じる）。
 * 背景: エラーページを表示している page で、次のナビゲーションも失敗し、その直後に page を閉じると、Chromium は page を閉じず、
 * `page.close()` が終わらない（DEF-005 の調査）。
 * 値の根拠: page を閉じる処理は、ふだん数十 ms で終わる（DEF-005 の測定）。負荷の高い環境でも誤って期限切れにしないよう、
 * その 100 倍程度の余裕を取った。止まった場合は永久に終わらないので、有限の値であれば止まり続けることはない。
 * 既定のページの期限（60,000ms）の 10% 未満である。
 */
export const PAGE_CLOSE_TIMEOUT_MS = 5_000;

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
 * 値の根拠: page を閉じる処理の上限（`PAGE_CLOSE_TIMEOUT_MS`）と同じにした。Context を閉じる処理は、Guard が保留中の処理を待つ時間
 * （`GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS`。2026-09-25 時点で 1,000ms）と、page と Context を閉じる時間で、ふだん 1 秒程度で終わる。
 */
export const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

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
 * Page Auditor の候補ごとの期限と、設定の検証（Interaction が有効なら、`crawl.overallPageTimeoutMs` がこの予算以上）が使う
 * （R14 の m2）。
 */
export const INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE = 2;

/**
 * ページの期限と、期限を受け取る collector に渡す期限との間の余裕（ms。設計書 4.5.7、R14r の Minor-2）。
 * Page Auditor は、ページの期限で段階を見放す（`awaitBeforeDeadline`）。collector にページの期限をそのまま渡すと、collector が
 * 期限で止まって返す途中までの結果（PARTIAL の Evidence）が、見放した後に届いて捨てられる。そのため、collector には、
 * ページの期限からこの値を引いた時刻を渡す。
 * 値の根拠: collector は、期限を過ぎたら `awaitBeforeDeadline` で待つのをやめ、それまでの結果を Node 側で組み立てて返す。
 * 期限から返るまでの時間は、タイマーの遅れ（Windows では約 16ms）と、Node 側での結果の組み立てである。ブラウザ内の処理の
 * 部分結果を返すための時間（layout の収集では `LAYOUT_THRESHOLDS.partialResultReserveMs` の 250ms）は、collector が自分の期限の
 * 前に取っておくので、ここには含めない。負荷の高い環境での遅れを見込んでも、期限から返るまでは数百 ms に収まる。
 * 500ms は、それを上回る余裕で、既定のページの期限（60,000ms）の 1% 未満なので、収集の時間をほとんど減らさない。
 */
export const COLLECTOR_DEADLINE_MARGIN_MS = 500;

/**
 * DOM の準備を待つ処理（`waitForPageSettled`）の待ち方。期限（`deadlineAtMs`）は、Page Auditor が段階ごとに決める。
 * - `pollIntervalMs`: `readyState` と `scrollHeight` を測る間隔。100ms は、1フレーム（約16ms）より十分長く、
 *   安定の時間の中で5回測れる間隔である。短いほど早く終わるが、測る回数が増える。
 * - `stableWindowMs`: 文書の読み込み（`readyState` が `loading`）が終わり、`scrollHeight` が変わらない状態がこの時間続いたら、
 *   落ち着いたとする。500ms は、初期描画の後の画像やフォントによる高さの変化を捉えられ、ページごとの待ち時間を大きくしない長さである。
 */
export const PAGE_SETTLING_PACING = Object.freeze({
  pollIntervalMs: 100,
  stableWindowMs: 500,
} as const);

/**
 * controlled scroll（`controlledScroll`）の待ち方（設計書 第11章: 人間に近い一定の刻みと待ちで、極端な操作をしない）。
 * - `stepViewportFraction`: 1回にスクロールする量の、ビューポートの高さに対する割合。0.75 は、前後の画面を4分の1ずつ重ねて、
 *   遅延読み込みの境界（`IntersectionObserver` の交差）を読み飛ばさない量である（controlled scroll が受け付ける上限は 0.9）。
 * - `stepWaitMs`: 1回のスクロールの後に待つ時間。250ms は、スクロールで始まる読み込みと描画（数フレーム）を待ち、
 *   高さ 10 画面程度のページを数秒でたどれる長さである。
 * - `stableWindowMs`: 最下部に着いた後、`scrollHeight` が変わらない状態がこの時間続いたら、たどり終えたとする。
 *   DOM の準備の安定の時間と同じ長さにする。
 */
export const CONTROLLED_SCROLL_PACING = Object.freeze({
  stepViewportFraction: 0.75,
  stepWaitMs: 250,
  stableWindowMs: PAGE_SETTLING_PACING.stableWindowMs,
} as const);

/**
 * scroll の段階の予算の、`crawl.resourceSettlingTimeoutMs` に対する倍率（設計書 4.5.7）。scroll は、遅延読み込みを
 * 何回も待つので、DOM の準備（`resourceSettlingTimeoutMs`）より長い予算にする。既定の設定では 20,000ms で、
 * `crawl.overallPageTimeoutMs`（既定 60,000ms）の3分の1に収まる。
 */
export const SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER = 4;

/**
 * ChatGPT 用バンドルに入れるスクリーンショットの、合計の大きさの上限（バイト。Task 14〜17 の設計書 6.1.11）。
 * 関係するスクリーンショットを、`VIEWPORT` のもの（パスの順）、`FULL_PAGE` のもの（パスの順）の順に入れ、合計がこの値を超えるものは
 * 入れない（`manifest.json` の `omittedFiles` に、理由 `BUNDLE_SIZE_LIMIT` で書く）。
 * 値の根拠: 64 MiB。手でアップロードするバンドルの大きさを抑えるための上限である（設計者の決定）。
 */
export const CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES = 64 * 1024 * 1024;
