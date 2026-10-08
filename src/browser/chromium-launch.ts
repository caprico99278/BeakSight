/**
 * CLI の Chromium の起動の設定（`chromium.launch` に渡す値）の置き場所（中断した Run の再開の設計書 4.10、サイトへの負荷の制御の設計書 4.9）。
 * CLI の本番の起動（`src/cli/run-command.ts` の `PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）は、`chromiumLaunchOptions` の値で
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
 * 振る舞い（スクリーンショットの取り方）が変わる。先読みを止める引数は `--disable-features` を使わないので、Playwright の既定の
 * `--disable-features` は、そのまま使われる。Playwright の版が変わって既定が変わったら、
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
 * - `args`: `CHROMIUM_PRELOADING_DISABLED_ARGS`（ページの先読みを止めるため）と、`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`（Shared Worker を
 *   無効にするため。DEF-044）。
 * - `handleSIGINT`・`handleSIGTERM`・`handleSIGHUP`: `false`。Playwright の既定のシグナルの処理（SIGINT・SIGTERM・SIGHUP で Browser を
 *   閉じてプロセスを終える）を止める（中断した Run の再開の設計書 4.7）。Playwright がプロセスを終えると、最後の処理（出力の書き出し）が
 *   行われないためである。シグナルは、BeakSight が受ける（R5b）。
 */
export function chromiumLaunchOptions(settings: ChromiumLaunchSettings): LaunchOptions {
  return {
    headless: settings.headless,
    channel: CHROMIUM_CHANNEL,
    args: [...CHROMIUM_PRELOADING_DISABLED_ARGS, ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}
