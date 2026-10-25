/**
 * CLI の Chromium の起動の設定（`chromium.launch` に渡す値）の置き場所（中断した Run の再開の設計書 4.10、サイトへの負荷の制御の設計書 4.9）。
 * channel、起動の引数、シグナルの扱いは、ここだけに書く。
 * EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.1・3.2・3.5。DEF-171）: 本番の Chromium は、すべてここの起動の部品
 * （`launchChromium`）で起動する。使い捨ての一時のプロファイルの `Default/Preferences` に、許した種類の URL のほかを止める設定
 * （`externalLaunchBlockPreferences`）を置き、`chromiumLaunchOptions` の値のまま `launchPersistentContext` で起動して、その `browser()` を返す
 * （呼ぶ側は今どおり `newContext()` で Context を作る）。起動のたびに、設定が効いていることを自己検査で確かめ、効いていなければ閉じた理由
 * `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`（`ChromiumLaunchRefusedError`）の誤りにする。本番のほかの場所は `chromium.launch`・`launchPersistentContext`
 * を直接呼ばない（Gate `tests/architecture/chromium-launch-ownership.test.ts`）。
 * テストの既定の headless shell（`tests/helpers/chromium.ts` など）は、この部品を使わない（Preferences を読まない。もともと外部のアプリを起動しない）。
 * ただし、Shared Worker を無効にする引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`。DEF-044）は、テストの起動の補助も既定で使う（外すのは、テストの
 * 明示の選択だけ）。WebRTC の中継を通らない UDP を止める引数（`CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS`。DEF-124）も、テストの起動の補助が
 * 既定で使う。テストの CLI の起動の組（`launchCliChromium` など）は、この部品（`launchChromiumWith`）で起動する。
 */
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { errorCodeOf, safeErrorMessage } from '../core/errors.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { DAY_MS } from '../core/time-units.js';
import { BEAKSIGHT_INTERNAL_WINDOW_TEXT } from '../presentation/messages.js';

/**
 * CLI の Chromium の起動で `chromium.launch` に渡す `channel`（中断した Run の再開の設計書 4.10。RR の Critical-1）。headless と headed の
 * 両方、すべての OS で、この値を使う。
 * - `'chromium'` は、Playwright に同梱の Chromium（`npx playwright install chromium` で入るもの）の、GUI のプログラムの `chrome.exe` を、
 *   新しい headless の方式で動かす。版は Playwright の版で決まる（再開の版の比べ方の理由は変わらない。`RUN_VERSION_FIELDS`）。
 * - `channel` を渡さない既定の headless は、コンソールのプログラムの `chrome-headless-shell.exe` を使う。Playwright は Windows で、Chromium を
 *   BeakSight と同じコンソールにつないで起動するので、1回目の Ctrl+C の CTRL_C_EVENT を Chromium も受けて終わり、今のページが失敗のまま
 *   「終わったページ」として保存され、再開しても監査し直されない（`handleSIGINT: false` では防げない）。GUI のプログラムの `chrome.exe` は、
 *   CTRL_C_EVENT を受けない。
 */
export const CHROMIUM_CHANNEL = 'chromium';

/**
 * ページの先読みを止める、Chromium の feature の閉じた一覧（DEF-023。サイトへの負荷の制御の設計書 4.9）。`--enable-features` の値として渡す。
 * 先読みの要求は、Guard の route も、読み込みの間隔（`NavigationPacer`）も、負荷の記録（`LoadMeter`）も通らずにサイトに届くので、止める。
 * BeakSight は、先読みの結果を監査に使わない（監査するページは、自分で読み込む）ので、止めても監査の結果は変わらない。
 * どれで止まるかは Chromium の版で変わりうるので、Chromium 151（Playwright 1.62.1）で、ローカルの fixture のページで確かめて選んだ。
 * どれも、外すとその先読みの要求がサーバに届く（確かめは `tests/integration/preloading-disabled.test.ts`。版が変わったら、そこで気づく）。
 * - `NoStatePrefetchHoldback`: 古い形の prerender（`<link rel="prerender">`）による先読み（NoStatePrefetch）を、行わない（hold back）。
 * - `PrefetchMultipleActiveSetSizeLimitForBase:prefetch_multiple_active_set_size_limit_for_base_value/0`: ブラウザが同時に行う prefetch の
 *   数の上限（基本の枠）を 0 にする。speculation rules の prefetch が始まらず、サーバに要求が届かない。speculation rules の prerender の
 *   前に行う prefetch（prerender の対象のページの要求）も、同じく始まらない。すぐに行う設定（immediate）のほか、hover（moderate）と
 *   pointerdown（conservative）で始まる先読みも止まり、先読みの対象のページへ移動するときは、普通に読み込むことを確かめた。
 *   止まる仕組み（始まらない prefetch が順番待ちのまま残る）は、feature の名前からの推測で、Chromium の資料では確かめていない。
 *   prerender そのものは、DEF-023 の実験では、Playwright の Context で Chromium が行わなかった（`PrerenderingDisabledByDevTools`）。
 *
 * 試して、効かなかったので入れないもの（Chromium 151）:
 * - `--disable-features` の `Prerender2`、`SpeculationRules`、`SpeculationRulesPrefetchFuture`、`PrefetchUseContentRefactor`、
 *   `NoStatePrefetch`、`LinkPrefetch`
 * - `--disable-blink-features` の `SpeculationRules`、`Prerender2`、`SpeculationRulesPrefetchFuture`、`LinkPrefetch`
 * - `--enable-features` の `PreloadingConfig` の holdback（設定は Chromium に届いたが、DevTools がつながっている Context では、Chromium は
 *   holdback を使わなかった）と、`PrefetchEagerLimit` の `max_number_of_eager_prefetches_per_page`（0 と 1）
 * BN-R0 の C-1（2026-10-23。Chromium 151、両方の Chromium）: speculation rules の prerender だけの指定では、上の上限 0 で止まらず、Chromium が prerender の
 * 代わりの prefetch（`Prerender2FallbackPrefetchSpecRules`）を行い、Guard を通らない文書の要求（`Sec-Purpose: prefetch;prerender`）がサーバに届き、その後の
 * 移動がその応答で main frame を移していた。そのため、`--disable-features` の `Prerender2FallbackPrefetchSpecRules`（`CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES`）
 * も渡す（以前の「上の上限 0 で止まるので要らない」は、今の Chromium では成り立たない）。
 * 古い形の prefetch（`<link rel="prefetch">`）は、止める引数が見つからなかった。ページが読み込む画像などと同じく、Guard の route を通る（種類 `prefetch` には、
 * 監査の段の除外も当てる。`src/safety/request-policy.ts` の `isPageSubresourceRead`）。
 */
export const CHROMIUM_PRELOADING_DISABLED_FEATURES = Object.freeze([
  'NoStatePrefetchHoldback',
  'PrefetchMultipleActiveSetSizeLimitForBase:prefetch_multiple_active_set_size_limit_for_base_value/0',
] as const);

/**
 * BN-R0 の C-1: ページの先読みを止める、`--disable-features` の値として渡す Chromium の feature の閉じた一覧（上の説明）。`--disable-features` は、Playwright の
 * 既定の値と Google への接続を止める feature と一緒に、1 つの引数（`CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS`）で渡す。
 */
export const CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES = Object.freeze(['Prerender2FallbackPrefetchSpecRules'] as const);

/**
 * Playwright（1.62.1）が、Chromium の起動の引数に自分で加える `--enable-features` の値（Playwright の既定。環境変数
 * `PLAYWRIGHT_LEGACY_SCREENSHOT` がない場合。DEF-023）。
 * Chromium は、`--enable-features` が複数あると、最後の1つだけを使う（DEF-023 で確かめた）。先読みを止める引数も `--enable-features` で、
 * Playwright の既定の後に並ぶので、Playwright の既定の値を、先読みを止める引数の値に含めて引き継ぐ。含めないと、Playwright の既定の
 * 振る舞い（スクリーンショットの取り方）が変わる。`--disable-features` も同じく最後の1つだけが使われるので、Google への接続を止める
 * 引数（`CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS`。DEF-070）は、Playwright の既定の `--disable-features` の値
 * （`PLAYWRIGHT_DEFAULT_DISABLED_FEATURES`）を含めて引き継ぐ。Playwright の版が変わって既定が変わったら、
 * `tests/integration/preloading-disabled.test.ts` で気づく。
 */
export const PLAYWRIGHT_DEFAULT_ENABLED_FEATURES = Object.freeze(['CDPScreenshotNewSurface'] as const);

/**
 * ページの先読みを止める、Chromium の起動の引数の閉じた一覧（DEF-023）。`--enable-features` の1つだけで、値は、Playwright の既定の値
 * （`PLAYWRIGHT_DEFAULT_ENABLED_FEATURES`）と、先読みを止める feature（`CHROMIUM_PRELOADING_DISABLED_FEATURES`）である。
 */
export const CHROMIUM_PRELOADING_DISABLED_ARGS = Object.freeze([
  `--enable-features=${[...PLAYWRIGHT_DEFAULT_ENABLED_FEATURES, ...CHROMIUM_PRELOADING_DISABLED_FEATURES].join(',')}`,
] as const);

/**
 * Playwright（1.62.1）が、Chromium の起動の引数に自分で加える `--disable-features` の値（Playwright の既定。DEF-070）。並びも同じにする。
 * 写した元: `node_modules/playwright-core/lib/coreBundle.js` の `packages/playwright-core/src/server/chromium/chromiumSwitches.ts` の部分の
 * `disabledFeatures`（条件で変わる値はない）。
 * Chromium は、`--disable-features` が複数あると、最後の1つだけを使う。Google への接続を止める引数（`CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS`）
 * は Playwright の既定の後に並ぶので、この値を含めないと、Playwright が止めている feature（`HttpsUpgrades` など）が効き出し、監査の
 * 振る舞いが変わる（DEF-070-research で、`HttpsUpgrades` が効き出して `http://` の名前を `:443` で開こうとすることを確かめた）。
 *
 * Playwright の版を上げるときに確かめ直す手順:
 * 1. 新しい版の `node_modules/playwright-core/lib/coreBundle.js`（または `lib/server/chromium/chromiumSwitches.js`）で、
 *    `disabledFeatures` の配列を読み、この値を同じ並びに直す。`--enable-features` の既定（`PLAYWRIGHT_DEFAULT_ENABLED_FEATURES`）も同じく
 *    確かめる。
 * 2. `tests/integration/preloading-disabled.test.ts`（実際に渡った `--disable-features` を、Playwright の既定の起動と比べる）と、
 *    `tests/integration/chromium-google-connections.test.ts`（Google への接続の試みと、`HttpsUpgrades` が効き出していないこと）を実行する。
 *    この値が古いと、前者が失敗して気づく。
 */
export const PLAYWRIGHT_DEFAULT_DISABLED_FEATURES = Object.freeze([
  // BN-R0 fix round 1（2026-10-23）: Playwright 1.64.1 の既定（`coreBundle.js` の `disabledFeatures`）に写し直した。1.62.1 の写しのままで、
  // `BoundaryEventDispatchTracksNodeRemoval` が残り、`AvoidCorsURLLoaderRestartOnRedirect`・`NetworkTimeServiceQuerying`・`AimEnabled` が欠けていた
  // （`tests/integration/preloading-disabled.test.ts` の既定の比べで気づいた）。
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
] as const);

/**
 * Chromium 自身が Google へ接続することを止める、Chromium の feature の閉じた一覧（DEF-070。`--disable-features` の値として渡す）。
 * CLI の起動の設定（`channel: 'chromium'` の `chrome.exe`）は、Playwright の既定の起動の引数（`--disable-background-networking` など）の
 * ままでは、監査と関係なく、自分で Google へ接続しようとする（テストの既定の headless shell は、接続しない）。監査対象のサイトへの要求では
 * ないが、第三者への送信になりうるので止める。Chromium 151（Playwright 1.62.1）で、インターネットへは出さない実験（記録用の中継と DNS の
 * 規則）で確かめて選んだ（DEF-070-research。確かめは `tests/integration/chromium-google-connections.test.ts`）:
 * - `AutofillServerCommunication`: form のあるページのたびの autofill の問い合わせ（`content-autofill.googleapis.com`。form の署名と
 *   欄の署名を含む）を止める。Passive・Interaction・ログインの段のどの Context でも起きていた。
 * - `NetworkTimeServiceQuerying`: 起動のたびの時刻の問い合わせ（`clients2.google.com` の `/time/`）を止める。
 * - `PreconnectToSearch`: 既定の検索エンジン（`www.google.com`）への先回りの接続（preconnect）を止める。
 * - `AimEnabled`: AI Mode の可否の問い合わせ（`www.google.com`）を止める。
 * 起動のときの ListAccounts（`accounts.google.com`）と GCM の checkin（`android.clients.google.com`）は、feature では止まらないので、
 * 向け先を変える引数（`CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS`）で止める。
 * BeakSight は、これらの機能の結果を監査に使わないので、止めても監査の結果（スクリーンショット、DOM、Guard の判定）は変わらない。
 */
export const CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES = Object.freeze([
  'AutofillServerCommunication',
  'NetworkTimeServiceQuerying',
  'PreconnectToSearch',
  'AimEnabled',
] as const);

/**
 * Chromium 自身の Google への接続を止める、Chromium の起動の引数の閉じた一覧（DEF-070）。`--disable-features` の1つだけで、値は、
 * Playwright の既定の値（`PLAYWRIGHT_DEFAULT_DISABLED_FEATURES`）と、Google への接続を止める feature
 * （`CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES`）と、BN-R0 の C-1 から先読みを止める feature（`CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES`）である。
 */
export const CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS = Object.freeze([
  `--disable-features=${[
    ...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
    ...CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES,
    // BN-R0 の C-1: `--disable-features` は最後の 1 つだけが使われるので、先読みを止める feature も、同じ 1 つの引数に入れる。
    ...CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES,
  ].join(',')}`,
] as const);

/**
 * Chromium 自身の Google のアカウントと GCM への接続の向け先にする、使われないローカルの宛先（DEF-070。ユーザーの判断で止める）。
 * 127.0.0.1（この PC の中）の 9 番のポート（discard。ふつうは何も待ち受けていない）。外へは出ない。DEF-070-fix の実験（テストには
 * していない）で、9 番のポートで待ち受けても、起動と form のあるページで 15 秒の間に何も届かなかった（Chromium が 9 番のポートを危ない
 * ポートとして扱い、接続しないためと推測。Chromium の資料では確かめていない）。万一、この PC の 9 番のポートで何かが待ち受けていて
 * 届いた場合も、届くのは Chromium 自身の問い合わせで、監査対象のサイトへの要求ではない。外へ接続しないことの確かめは
 * `tests/integration/chromium-google-connections.test.ts`。
 */
export const CHROMIUM_UNUSED_LOCAL_ENDPOINT = 'http://127.0.0.1:9';

/**
 * Chromium 自身の Google への接続のうち、feature では止まらないものの向け先を、使われないローカルの宛先（`CHROMIUM_UNUSED_LOCAL_ENDPOINT`）
 * に変える、Chromium の起動の引数の閉じた一覧（DEF-070）。Chromium 151（Playwright 1.62.1）で、インターネットへは出さない実験で確かめた:
 * - `--gaia-url`: Google のアカウントの基の URL。起動のたびの ListAccounts（`accounts.google.com`。Google のアカウントの一覧の問い合わせ）
 *   の向け先。BeakSight は Chromium に Google のアカウントでログインしないので、使わない。ページが読み込む `accounts.google.com` の
 *   要求（「Google でログイン」のボタンなど）は、この引数で変わらない（同じテストで、引数の前後でスクリーンショット、DOM の Evidence、
 *   Guard の記録が変わらないことを確かめる）。
 * - `--gcm-checkin-url`: GCM（プッシュの通知の仕組み）の checkin（`android.clients.google.com`）の向け先。BeakSight はプッシュの通知を
 *   使わない。
 * - `--component-updater=url-source=...`（DEF-158。2026-10-23。Chromium 156・Playwright 1.64.1 の CLI の Chromium）: component updater の問い合わせ
 *   （`update.googleapis.com` の `/service/update2/json`。CONNECT 443 と HTTP 80）の向け先。Playwright の既定の `--disable-component-update` があっても、起動の
 *   直後に、要求に応じた（`installsource: ondemand`）component の問い合わせ（appid `ceofaddefefcbblgcgnibnonglccbfja`）が出るようになった。BeakSight は
 *   component を使わない。試して効かなかったもの: `--component-updater=disable-background-downloads`、`--disable-component-update` の重ね、
 *   `--variations-server-url`、`--disable-features` の `OptimizationGuideModelDownloading`・`OptimizationHintsFetching`・`OnDeviceModelService`・
 *   `PrivacySandboxAttestationsComponent`・`ComponentUpdaterServiceForPrivacySandbox`。テストの既定の headless shell は、この問い合わせを出さない。
 */
export const CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS = Object.freeze([
  `--gaia-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
  `--gcm-checkin-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
  `--component-updater=url-source=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
] as const);

/**
 * Shared Worker を無効にする、Chromium の起動の引数の閉じた一覧（DEF-044。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md`
 * 1.2）。CLI の起動（`chromiumLaunchOptions`）と、テストの起動の補助（`tests/helpers/chromium.ts`）の両方が使う。
 * Playwright（1.62.1）は `shared_worker` の target に session を付けないので、Shared Worker の中の要求（fetch、XHR、keepalive の POST）は、
 * Guard の route も CDP の横取りも通らずにサーバに届く。そのため、Shared Worker そのものを無効にする（`typeof SharedWorker` が `undefined`
 * になる。機能の検出で Dedicated Worker などに切り替えるページは動き、切り替えないページでは、Shared Worker に依存する機能が動かない）。
 * 引数が効かずに Shared Worker が作られた場合は、`BrowserContextFactory` の自己検査が違反 `SHARED_WORKER_OBSERVED` にする（fail-closed）。
 *
 * Chromium 151（Playwright 1.62.1）で、headless shell と `channel: 'chromium'` の `chrome.exe` の両方で確かめて選んだ（NP5）:
 * - `--disable-shared-workers`（選んだもの）: Shared Worker を無効にする専用の switch。ほかの引数と値を共有しないので、Playwright の
 *   既定の引数を上書きしない。両方の Chromium で `typeof SharedWorker === 'undefined'` になり、`typeof Worker` は `function` のまま。
 * - `--disable-blink-features=SharedWorker`: 同じく効いた。Playwright の既定の引数には `--disable-blink-features` はないが、値を
 *   カンマで並べる形の引数なので、将来の既定や別の指定と重なると上書きのおそれがある（DEF-023 の `--enable-features` の教訓）。
 * - `--disable-features=SharedWorker`: 効いたが、Playwright の既定の `--disable-features` を上書きするので使えない。
 */
export const CHROMIUM_SHARED_WORKERS_DISABLED_ARGS = Object.freeze(['--disable-shared-workers'] as const);

/**
 * WebRTC の、出口の中継を通らない UDP（STUN・TURN の UDP、ICE の接続の確かめ）を止める、Chromium の起動の引数の閉じた一覧（DEF-124）。CLI の
 * 起動（`chromiumLaunchOptions`）と、テストの起動の補助（`tests/helpers/chromium.ts`）の両方が使う。主な防御は、Guard の初期化のスクリプト
 * （`WEBRTC_BLOCK_INIT_SCRIPT`。WebRTC の入口を塞ぐ）で、これは UDP について守りを重ねるもの。
 * 値の `disable_non_proxied_udp` は、WebRTC に、中継（Context の proxy）を通らない UDP を使わせない。中継の CONNECT を通る TCP（TURN の TCP・TLS、
 * ICE の TCP）は止めない（Guard の初期化のスクリプトが止める）。
 *
 * Chromium 151（Playwright 1.62.1）で、本物の factory と Guard の Passive の Context（初期化のスクリプトなし）で、127.0.0.1 の UDP の受け口に
 * 届くかを確かめて選んだ（DEF-124-fix の実験）。効く switch が、Chromium の種類で違った:
 * - `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: テストの既定の headless shell で効いた（STUN・TURN の UDP・ICE の UDP が 0）。
 *   CLI の `channel: 'chromium'` の `chrome.exe` では効かなかった（届いた）。
 * - `--webrtc-ip-handling-policy=disable_non_proxied_udp`: `chrome.exe` で効いた。headless shell では効かなかった（届いた）。
 * 両方を渡すと、両方の Chromium で UDP が 0 になった（headed は未確認）。どちらも値を 1 つだけ取る switch で、Playwright の既定の引数に
 * ないので、既定を上書きしない。
 * 試して、効かなかったので入れないもの: `--force-webrtc-ip-handling-policy=default_public_interface_only`、
 * `--disable-blink-features=RTCPeerConnection,WebTransport`（`typeof RTCPeerConnection` が変わらない）、`--disable-quic`。
 */
export const CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS = Object.freeze([
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
] as const);

/** `chromiumLaunchOptions` の指定。 */
export interface ChromiumLaunchSettings {
  /** headless で起動するか（設定の `browser.headed` の逆）。 */
  readonly headless: boolean;
}

/**
 * CLI の `chromium.launch` に渡す値を作る（呼ぶたびに新しい値）。
 * - `channel`: `CHROMIUM_CHANNEL`（Ctrl+C で Chromium が終わらないため）。
 * - `args`: `CHROMIUM_PRELOADING_DISABLED_ARGS`（ページの先読みを止めるため）と、`CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS`（Chromium 自身の
 *   Google への接続を止めるため。DEF-070）と、`CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS`（起動のときの ListAccounts と GCM の checkin の
 *   向け先を、使われないローカルの宛先に変えるため。DEF-070）と、`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`（Shared Worker を無効にするため。
 *   DEF-044）と、`CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS`（WebRTC の、中継を通らない UDP を止めるため。DEF-124）。
 * - `handleSIGINT`・`handleSIGTERM`・`handleSIGHUP`: `false`。Playwright の既定のシグナルの処理（SIGINT・SIGTERM・SIGHUP で Browser を
 *   閉じてプロセスを終える）を止める（中断した Run の再開の設計書 4.7）。Playwright がプロセスを終えると、最後の処理（出力の書き出し）が
 *   行われないためである。シグナルは、BeakSight が受ける（R5b）。
 */
export function chromiumLaunchOptions(settings: ChromiumLaunchSettings): LaunchOptions {
  return {
    headless: settings.headless,
    channel: CHROMIUM_CHANNEL,
    args: [
      ...CHROMIUM_PRELOADING_DISABLED_ARGS,
      ...CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS,
      ...CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS,
      ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
      ...CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS,
    ],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// EL-12: 外部のアプリの起動を Chromium の側で止める起動の部品（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.1・3.2・3.5）。
// ---------------------------------------------------------------------------------------------------------------

/**
 * 一時のプロファイルの Preferences の `policy.url_blocklist`（設計書 3.5）。すべての URL を止め、`EXTERNAL_LAUNCH_ALLOWED_URL_PATTERNS` だけを
 * 許す。止めた URL への移動は、Chromium が `net::ERR_BLOCKED_BY_ADMINISTRATOR` のエラーの頁にし、OS の外部のアプリ（メール、電話など）へ渡さない。
 */
export const EXTERNAL_LAUNCH_BLOCKED_URL_PATTERNS = Object.freeze(['*'] as const);

/**
 * 一時のプロファイルの Preferences の `policy.url_allowlist` の閉じた一覧（設計書 3.5）。http・https と、Chromium と Playwright が内部で使う
 * 最小の種類（`about:`・`data:`・`blob:`）。Guard の外部スキームの判定の一覧（`NON_EXTERNAL_NAVIGATION_SCHEMES`）と同じ種類である。EL-0 の調べで、
 * エラーの頁・ダウンロード・PDF・WebSocket・blob などは今と同じに動き、変わるのは `view-source:` だけ（BeakSight は使わない）と確かめた。
 */
export const EXTERNAL_LAUNCH_ALLOWED_URL_PATTERNS = Object.freeze(['http://*', 'https://*', 'about:*', 'data:*', 'blob:*'] as const);

/** 一時のプロファイルの `Default/Preferences` に書く中身（呼ぶたびに新しい値）。 */
export function externalLaunchBlockPreferences(): {
  readonly policy: { readonly url_blocklist: string[]; readonly url_allowlist: string[] };
} {
  return { policy: { url_blocklist: [...EXTERNAL_LAUNCH_BLOCKED_URL_PATTERNS], url_allowlist: [...EXTERNAL_LAUNCH_ALLOWED_URL_PATTERNS] } };
}

/** 一時のプロファイルのフォルダの名前の先頭（OS の一時のフォルダの下に、`mkdtemp` で作る）。 */
export const CHROMIUM_PROFILE_DIRECTORY_PREFIX = 'beaksight-chromium-profile-';

/** 一時のプロファイルの中の、Preferences のファイルの置き場所（プロファイルのフォルダからの相対の部品）。 */
export const CHROMIUM_PROFILE_PREFERENCES_PATH = Object.freeze(['Default', 'Preferences'] as const);

/**
 * 一時のプロファイルを消すときの、やり直しの回数と間隔（ms。設計書 3.5 の後片付け）。Windows では、Browser の切断の直後は Chromium のプロセスが
 * まだファイルを開いていることがあるので、Node の `rm` のやり直し（`EBUSY` など）で待つ。やり直しても消せなければ、残す（中身は既定の Context の
 * 空の頁と自己検査だけで、Run の Context は `newContext()` のメモリの中なので、Cookie などのログインの状態は書かれない）。
 */
export const CHROMIUM_PROFILE_REMOVE_RETRIES = 10;
export const CHROMIUM_PROFILE_REMOVE_RETRY_DELAY_MS = 200;
/** 予期しない切断の後、Chromium のプロセスが終わるのを待ってから、もう一度消すまでの時間（ms。終わる途中の `Local State` の書き直しの後）。 */
export const CHROMIUM_PROFILE_REMOVE_AFTER_DISCONNECT_MS = 2_000;

/**
 * EL-F（EL-R の M3）: 起動のときに消す、古い一時のプロファイルの年齢（ms。フォルダの最後の変更から 1 日）。BeakSight の process が強制的に終わった
 * ときなどに残ったものを消す。
 */
export const CHROMIUM_STALE_PROFILE_AGE_MS = DAY_MS;

/**
 * Chromium が動いている間、プロファイルのフォルダに置くファイル（EL-F の実験。Windows の CLI の Chromium）。あるプロファイルは、ほかの BeakSight の
 * Browser が使っているとみなし、古くても消さない（動いている Chromium のプロファイルを `rm` すると、一部を消してから止まり、そのプロファイルを壊す）。
 */
export const CHROMIUM_PROFILE_IN_USE_FILE = 'lockfile';

/** 自己検査で移動する、許していない独自のスキームの URL（OS に登録のないスキーム。設定が効かなくても、アプリは起動しない）。 */
export const EXTERNAL_LAUNCH_SELF_CHECK_URL = 'beaksight-launch-check:probe';

/** 自己検査の合格の印: 設定が効いているときの、移動の誤りの文（効いていないと `net::ERR_ABORTED`）。 */
export const EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT = 'net::ERR_BLOCKED_BY_ADMINISTRATOR';

/** 自己検査の移動と、`about:blank` へ戻す移動の時間の上限（ms）。 */
export const EXTERNAL_LAUNCH_SELF_CHECK_TIMEOUT_MS = 10_000;

/**
 * EL-F（EL-R の M1）: 自己検査で、許した種類（http・https）が止まっていないことを確かめる移動の先。使われないローカルの宛先
 * （`CHROMIUM_UNUSED_LOCAL_ENDPOINT` の 9 番のポート）で、Chromium はこのポートを危ないポートとして接続せずに `net::ERR_UNSAFE_PORT` にする。設定の確かめは
 * それより前に行われるので、許す一覧が http・https を許さない形（上書き）なら `EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT` になる（EL-F の実験）。どちらの場合も、
 * 要求は外へも、この PC の中へも出ない。
 */
export const EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS = Object.freeze([`${CHROMIUM_UNUSED_LOCAL_ENDPOINT}/`, 'https://127.0.0.1:9/'] as const);

/**
 * EL-F（EL-R の M1・M2）: 既定の Context の頁に置く、BeakSight の内部の窓の頁（`data:`。許した種類の中）。自己検査の終わりに読み、許した種類の `data:` が
 * 止まっていないことを確かめる。headed では、この頁を最小化して残す（利用者が見ても、BeakSight の内部の窓と分かる）。
 */
export const BEAKSIGHT_INTERNAL_WINDOW_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  // 文言は固定で、HTML の特別な文字を含まない（`messages.ts` の `BEAKSIGHT_INTERNAL_WINDOW_TEXT`）。
  `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${BEAKSIGHT_INTERNAL_WINDOW_TEXT.title}</title>`
    + `<p>${BEAKSIGHT_INTERNAL_WINDOW_TEXT.body}</p></html>`,
)}`;

/**
 * 自己検査の後、Chromium がエラーの頁（`chrome-error:`）を確かにするのを待つ上限（ms）。確かになる前に `about:blank` へ移すと、その移動が
 * エラーの頁への移動で取り消される（EL-12 の実験。CLI の Chromium）。来なければ、待たずに戻す。
 */
export const EXTERNAL_LAUNCH_ERROR_PAGE_WAIT_MS = 3_000;

/** Chromium のエラーの頁のスキーム（`URL.protocol` の形）。 */
const CHROMIUM_ERROR_PAGE_PROTOCOL = 'chrome-error:';

/**
 * 起動の部品が Browser を返さずに断る、閉じた理由の一覧（設計書 3.2・3.5）。
 * - `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`: 自己検査で、許していないスキームへの移動が `EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT` にならなかった（設定が
 *   効いていない。管理のポリシーが上書きする端末など）。Run・ジョブを始めない（PREFLIGHT の項目 `EXTERNAL_LAUNCH_BLOCK`）。
 */
export const CHROMIUM_LAUNCH_REFUSAL_REASONS = Object.freeze(['EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE'] as const);
export type ChromiumLaunchRefusalReason = (typeof CHROMIUM_LAUNCH_REFUSAL_REASONS)[number];

/** 起動の部品が、閉じた理由（`CHROMIUM_LAUNCH_REFUSAL_REASONS`）で Browser を返さなかった誤り（起動した Browser は閉じてある）。 */
export class ChromiumLaunchRefusedError extends Error {
  readonly reason: ChromiumLaunchRefusalReason;

  constructor(reason: ChromiumLaunchRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ChromiumLaunchRefusedError';
    this.reason = reason;
  }
}

/** `error` が、起動の部品の閉じた理由の誤りか（`reason` を渡すと、その理由のときだけ真）。 */
export function isChromiumLaunchRefused(error: unknown, reason?: ChromiumLaunchRefusalReason): error is ChromiumLaunchRefusedError {
  return error instanceof ChromiumLaunchRefusedError && (reason === undefined || error.reason === reason);
}

/**
 * 起動の部品の依存（本番は `PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES`）。テストだけが差し替える（起動の部品の差し替えで、headed の最小化や
 * 後片付けを確かめる。TS-g。設定を置かない起動で自己検査の不合格を確かめる）。本番の呼び出し（`launchChromium`）は渡さない。
 */
export interface ChromiumLaunchDependencies {
  /** 一時のプロファイルのフォルダを作り、その絶対のパスを返す。 */
  readonly createProfileDirectory: () => Promise<string>;
  /** 一時のプロファイルに Preferences（`externalLaunchBlockPreferences`）を書く。 */
  readonly writeProfilePreferences: (profileDirectory: string) => Promise<void>;
  /** プロファイルを使って Chromium を起動する（本番は `chromium.launchPersistentContext`）。 */
  readonly launchPersistentContext: (profileDirectory: string, options: LaunchOptions) => Promise<BrowserContext>;
  /** 一時のプロファイルを消す（やり直しを含む。失敗は投げてよい。部品が封じ込める）。 */
  readonly removeProfileDirectory: (profileDirectory: string) => Promise<void>;
  /** EL-F（M3）: 古い一時のプロファイルを消す（`removeStaleProfileDirectoriesIn`。失敗は投げてよい。部品が封じ込める）。 */
  readonly removeStaleProfileDirectories: () => Promise<unknown>;
}

/**
 * EL-F（EL-R の M3）: `parentDirectory` の下の、古い一時のプロファイル（名前が `CHROMIUM_PROFILE_DIRECTORY_PREFIX` で始まるフォルダで、最後の変更から
 * `CHROMIUM_STALE_PROFILE_AGE_MS` より前）を消し、消したものの名前を返す。使っているもの（`CHROMIUM_PROFILE_IN_USE_FILE` があるもの）と、消せないもの
 * （`remove` が失敗したもの）は飛ばす。フォルダの一覧を読めなければ、何もしない。
 */
export async function removeStaleProfileDirectoriesIn(
  parentDirectory: string,
  nowMs: number,
  remove: (directory: string) => Promise<void> = (directory) => rm(directory, { recursive: true, force: true }),
): Promise<readonly string[]> {
  const entries = await readdir(parentDirectory, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(CHROMIUM_PROFILE_DIRECTORY_PREFIX)) {
      continue;
    }
    const directory = join(parentDirectory, entry.name);
    try {
      const { mtimeMs } = await stat(directory);
      if (nowMs - mtimeMs <= CHROMIUM_STALE_PROFILE_AGE_MS || await exists(join(directory, CHROMIUM_PROFILE_IN_USE_FILE))) {
        continue;
      }
      await remove(directory);
      removed.push(entry.name);
    } catch {
      // 消せない（ほかの process が開いている、権限など）。飛ばす。
    }
  }
  return removed;
}

/** パスがあるか（読めなければ、あるとみなす。消さない側に倒す）。 */
const exists = (path: string): Promise<boolean> => access(path).then(() => true, (error: unknown) => errorCodeOf(error) !== 'ENOENT');

/** 本番の起動の部品の依存。 */
export const PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES: ChromiumLaunchDependencies = Object.freeze({
  createProfileDirectory: () => mkdtemp(join(tmpdir(), CHROMIUM_PROFILE_DIRECTORY_PREFIX)),
  writeProfilePreferences: async (profileDirectory: string): Promise<void> => {
    const [folder, file] = CHROMIUM_PROFILE_PREFERENCES_PATH;
    await mkdir(join(profileDirectory, folder), { recursive: true });
    await writeFile(join(profileDirectory, folder, file), JSON.stringify(externalLaunchBlockPreferences()), { flag: 'wx' });
  },
  launchPersistentContext: (profileDirectory: string, options: LaunchOptions) => chromium.launchPersistentContext(profileDirectory, options),
  removeProfileDirectory: (profileDirectory: string) => rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: CHROMIUM_PROFILE_REMOVE_RETRIES,
    retryDelay: CHROMIUM_PROFILE_REMOVE_RETRY_DELAY_MS,
  }),
  removeStaleProfileDirectories: () => removeStaleProfileDirectoriesIn(tmpdir(), Date.now()),
});

/**
 * 本番の Chromium を起動する（CLI の監査、ワーカーのジョブ、ログインの段の Browser のすべて）。`chromiumLaunchOptions(settings)` の値のまま
 * `launchChromiumWith` で起動する。
 */
export function launchChromium(settings: ChromiumLaunchSettings): Promise<Browser> {
  return launchChromiumWith(chromiumLaunchOptions(settings));
}

/**
 * `options`（`chromiumLaunchOptions` の値。テストの起動の補助は、引数を足し引きした値）で、外部のアプリの起動を止める Chromium を起動する（設計書 3.5）。
 * 1. 一時のプロファイルを作り、`Default/Preferences` に `externalLaunchBlockPreferences` を書く。
 * 2. `launchPersistentContext(<一時のプロファイル>, options)` で起動する（`options` の値は変えずに渡す）。返すのは、その `browser()`。
 *    persistent の既定の Context は、Run の Context に使わない（Guard の記録と数えに入らない）。`browser.contexts()` には 1 つ入る。
 * 0. EL-F（M3）: 古い一時のプロファイル（`removeStaleProfileDirectoriesIn`）を消す。
 * 3. 自己検査（`checkExternalLaunchBlock`）: 既定の頁で `EXTERNAL_LAUNCH_SELF_CHECK_URL` へ移り、`EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT` になることと、許した
 *    種類が止まっていないことを確かめ、内部の窓の頁にする。不合格は `ChromiumLaunchRefusedError`（`EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）。
 * 4. 既定の Context: すべての要求を止める（EL-F の M2。route と offline）。既定の頁: headless は閉じる。headed は閉じると Browser が終わるので、残して
 *    最小化する（最小化の失敗は封じ込める。安全の確かめではない）。
 * 5. 後片付け: `browser.close()` の後（Chromium のプロセスが終わった後）と、予期しない切断（`disconnected`）の後に、一時のプロファイルを消す（成否に
 *    かかわらず。消せなければ残す）。
 * 途中で失敗したら、起動した Browser を閉じ、一時のプロファイルを消してから、その誤りを投げる。
 */
export async function launchChromiumWith(
  options: LaunchOptions,
  dependencies: ChromiumLaunchDependencies = PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES,
): Promise<Browser> {
  // EL-F（M3）: 前に残った古い一時のプロファイルを消す（使っているもの・消せないものは飛ばす。失敗しても起動は続ける）。
  await dependencies.removeStaleProfileDirectories().catch(() => undefined);
  const profileDirectory = await dependencies.createProfileDirectory();
  // 消す処理は、何度呼んでもよい（Chromium が終わる途中に `Local State` を書き直すので、終わった後にもう一度消す）。
  const removeProfile = (): Promise<void> => dependencies.removeProfileDirectory(profileDirectory).catch(() => undefined);
  let persistent: BrowserContext;
  try {
    await dependencies.writeProfilePreferences(profileDirectory);
    persistent = await dependencies.launchPersistentContext(profileDirectory, options);
  } catch (error) {
    await removeProfile();
    throw error;
  }
  const browser = persistent.browser();
  if (browser === null) {
    await persistent.close().catch(() => undefined);
    await removeProfile();
    throw new Error('The persistent Chromium context has no browser');
  }
  // 後片付け（設計書 3.5）: Chromium は、切断（`disconnected`）の後、プロセスが終わるまでに `Local State` を書き直す（EL-12 の実験）。`browser.close()` は
  // プロセスの終わりを待つので、その後に消す（この Browser の `close` を、閉じてから消す形に包む。同じ Browser のまま）。予期しない切断（Chromium が
  // 落ちた、外から閉じた）は、切断の直後と `CHROMIUM_PROFILE_REMOVE_AFTER_DISCONNECT_MS` の後に消す（後の方は、Node の終わりを止めない）。
  const closeBrowser = browser.close.bind(browser);
  browser.close = async (...args: Parameters<Browser['close']>): Promise<void> => {
    try {
      await closeBrowser(...args);
    } finally {
      await removeProfile();
    }
  };
  browser.on('disconnected', () => {
    void removeProfile();
    setTimeout(() => void removeProfile(), CHROMIUM_PROFILE_REMOVE_AFTER_DISCONNECT_MS).unref();
  });
  try {
    if (!browser.isConnected()) {
      throw new Error('Chromium disconnected right after it was launched');
    }
    await prepareDefaultPage(persistent, options.headless !== false);
    return browser;
  } catch (error) {
    await browser.close().catch(() => undefined);
    await removeProfile();
    throw error;
  }
}

/** 既定の Context の頁で自己検査を行い、headless なら閉じ、headed なら残して最小化する（`launchChromiumWith` の 3・4）。 */
async function prepareDefaultPage(persistent: BrowserContext, headless: boolean): Promise<void> {
  const [first, ...others] = persistent.pages();
  const page = first ?? await persistent.newPage();
  await checkExternalLaunchBlock(page);
  for (const other of others) {
    await other.close();
  }
  // EL-F（EL-R の M2）: 既定の Context は Run に使わないので、すべての要求を止める（route で取り消し、さらに offline にする。EL-F の実験で、サーバに 0 件）。
  // headed で残す窓から、利用者が頁を開いても、どこへも要求を出さない。掛けられなければ、起動の失敗にする。
  await persistent.route('**', (route) => route.abort());
  await persistent.setOffline(true);
  if (headless) {
    await page.close();
    return;
  }
  await minimizeWindowOf(persistent, page).catch(() => undefined);
}

/**
 * 自己検査（設計書 3.2・3.5）: `page` で、許していない独自のスキーム（`EXTERNAL_LAUNCH_SELF_CHECK_URL`）へ移る。誤りの文に
 * `EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT` があるときだけ合格にする。移動が成り立った、ほかの誤り（`net::ERR_ABORTED` など）、時間切れは、
 * `ChromiumLaunchRefusedError`（`EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）。
 * EL-F（EL-R の M1）: 続けて、許した種類が止まっていないことも確かめる。http・https（`EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS`。接続しない宛先）が
 * `EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT` になる（許す一覧の上書き）か、`data:` の内部の窓（`BEAKSIGHT_INTERNAL_WINDOW_URL`）が止まれば、同じ理由で断る。
 * 終わりは、内部の窓の頁にする（前の `about:blank` の代わり）。ほかのスキームを管理者が許す形（許す一覧に足す）は、ここでは見分けられない（`doc/spec/safety.md`
 * の既知の残る経路）。
 */
export async function checkExternalLaunchBlock(page: Page): Promise<void> {
  // 1. 許していない独自のスキームが、設定で止まる。
  const blocked = await navigationErrorOf(page, EXTERNAL_LAUNCH_SELF_CHECK_URL);
  if (blocked === null) {
    throw new ChromiumLaunchRefusedError('EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE', 'the self-check navigation was not blocked');
  }
  if (!blocked.includes(EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT)) {
    throw new ChromiumLaunchRefusedError(
      'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE',
      `the self-check navigation was not blocked by the profile policy (${blocked})`,
    );
  }
  await openInternalWindow(page);
  // 2. EL-F（M1）: 許した種類（http・https）が、設定で止まっていない（使われない 9 番のポートなので、どちらでも接続しない）。
  for (const url of EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS) {
    const failure = await navigationErrorOf(page, url);
    if (failure?.includes(EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT) === true) {
      throw new ChromiumLaunchRefusedError(
        'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE',
        `an allowed scheme (${new URL(url).protocol}) was blocked by the profile policy`,
      );
    }
    await openInternalWindow(page);
  }
}

/**
 * `page` で `url` へ移り、誤りの文（1 行目。`MAX_ERROR_MESSAGE_LENGTH` 以内）を返す（移動が成り立てば `null`）。誤りのときは、Chromium がエラーの頁を
 * 確かにするのを待つ（確かになる前の次の移動は、エラーの頁への移動で取り消されるため）。
 */
async function navigationErrorOf(page: Page, url: string): Promise<string | null> {
  try {
    await page.goto(url, { timeout: EXTERNAL_LAUNCH_SELF_CHECK_TIMEOUT_MS });
    return null;
  } catch (error) {
    await page
      .waitForURL((current) => current.protocol === CHROMIUM_ERROR_PAGE_PROTOCOL, { timeout: EXTERNAL_LAUNCH_ERROR_PAGE_WAIT_MS })
      .catch(() => undefined);
    return safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH).split('\n')[0] ?? '';
  }
}

/**
 * EL-F（M1・M2）: BeakSight の内部の窓の頁（`BEAKSIGHT_INTERNAL_WINDOW_URL`。`data:`）を読む。許した種類の `data:` が止まっていれば、閉じた理由
 * `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`。ほかの失敗は、その誤りのまま投げる（起動の失敗）。
 */
async function openInternalWindow(page: Page): Promise<void> {
  const failure = await navigationErrorOf(page, BEAKSIGHT_INTERNAL_WINDOW_URL);
  if (failure === null) {
    return;
  }
  if (failure.includes(EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT)) {
    throw new ChromiumLaunchRefusedError('EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE', 'an allowed scheme (data:) was blocked by the profile policy');
  }
  throw new Error(`The internal window of BeakSight could not be opened (${failure})`);
}

/** headed の既定の頁の窓を最小化する（CDP の `Browser.getWindowForTarget`・`Browser.setWindowBounds`。session は終わりに切る）。 */
async function minimizeWindowOf(persistent: BrowserContext, page: Page): Promise<void> {
  const session = await persistent.newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } finally {
    await session.detach().catch(() => undefined);
  }
}
