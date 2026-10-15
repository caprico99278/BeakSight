/**
 * CLI の Chromium の起動の設定（`chromium.launch` に渡す値）の置き場所（中断した Run の再開の設計書 4.10、サイトへの負荷の制御の設計書 4.9）。
 * CLI の本番の起動（`src/cli/audit-run.ts` の `PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）は、`chromiumLaunchOptions` の値で
 * `chromium.launch` を呼ぶ。channel、起動の引数、シグナルの扱いは、ここだけに書く。
 * テストの中で直接 Chromium を起動するもの（`tests/helpers/chromium.ts` など）は、この設定を使わない。ただし、Shared Worker を無効にする
 * 引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`。DEF-044）は、テストの起動の補助も既定で使う（外すのは、テストの明示の選択だけ）。
 */
import type { LaunchOptions } from 'playwright';

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
 * 効くが、要らないので入れないもの: `--disable-features=Prerender2FallbackPrefetchSpecRules`（prerender の前に行う prefetch だけを止める。
 * 上の上限 0 で止まる。また、`--disable-features` を加えると、Playwright の既定の `--disable-features` を上書きする）。
 * 古い形の prefetch（`<link rel="prefetch">`）は、止める引数が見つからなかった。ページが読み込む画像などと同じく、Guard の route を通る。
 */
export const CHROMIUM_PRELOADING_DISABLED_FEATURES = Object.freeze([
  'NoStatePrefetchHoldback',
  'PrefetchMultipleActiveSetSizeLimitForBase:prefetch_multiple_active_set_size_limit_for_base_value/0',
] as const);

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
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
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
 * （`CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES`）である。
 */
export const CHROMIUM_GOOGLE_SERVICES_DISABLED_ARGS = Object.freeze([
  `--disable-features=${[...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES, ...CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES].join(',')}`,
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
 */
export const CHROMIUM_GOOGLE_ENDPOINTS_REDIRECTED_ARGS = Object.freeze([
  `--gaia-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
  `--gcm-checkin-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
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
 *   DEF-044）。
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
    ],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}
