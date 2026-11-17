/**
 * テストの既定の headless shell の起動の引数の置き場所（CC-098 で 1 か所にした）。`tests/helpers/chromium.ts` の `launchHeadlessChromium` と、子のプロセスの
 * 入口の本文（`test-login-worker-entry.ts`・`auto-login-worker-entry.ts`）の両方が、ここから読む。画面のテストの補助からも読まれるので、`vitest` を
 * 読み込まない。
 */
import {
  CHROMIUM_DISABLED_FEATURES_ARGS,
  CHROMIUM_PRELOADING_DISABLED_ARGS,
  CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
  CHROMIUM_UNUSED_LOCAL_ENDPOINT,
  PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
} from '../../src/browser/chromium-launch.js';

/**
 * RB-4b: テストだけで止める、Chromium 自身の Google への接続の feature（前の DEF-070 の値）。製品の CLI の Chromium は、ユーザーの判断（2026-11-15）で
 * これを止めない。テストは外のインターネットへ出さない決まりなので、テストの起動（headless shell と、テストの CLI の起動の組）でだけ止める。
 * テストの引数が本番と違っても、ずれの確かめ（`tests/contract/`）の意味は変わらない。ブラウザ自身の接続は、ページの通信でも口（port）の操作でもなく、
 * 確かめる通り道の外だからである。
 */
export const TEST_ONLY_GOOGLE_CONNECTION_DISABLED_FEATURES = Object.freeze([
  'AutofillServerCommunication',
  'NetworkTimeServiceQuerying',
  'PreconnectToSearch',
  'AimEnabled',
] as const);

/**
 * RB-4b: テストだけの `--disable-features` の 1 つの引数（Chromium は最後の 1 つだけを使うので、製品の値に、テストだけの値を足した形にする）と、Google の
 * アカウント・GCM・component の更新の向け先を使われないローカルの宛先に変える引数（前の DEF-070・DEF-158 の値。理由は上と同じ）。
 */
export const TEST_ONLY_NO_INTERNET_ARGS: readonly string[] = Object.freeze([
  `${CHROMIUM_DISABLED_FEATURES_ARGS[0]},${TEST_ONLY_GOOGLE_CONNECTION_DISABLED_FEATURES.join(',')}`,
  `--gaia-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
  `--gcm-checkin-url=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
  `--component-updater=url-source=${CHROMIUM_UNUSED_LOCAL_ENDPOINT}`,
]);

/**
 * RB-4 fix（M-1）: 守りの起動の引数のない Chromium を作る対照の生の起動（`chromium.launch`）に足す、テストだけの外へ出ない引数。`--disable-features` は
 * Playwright の既定に、テストだけの feature を足したもの（製品の先読みなどを止める feature を入れない。入れると、対照が確かめる迂回が起きなくなる）。
 */
export const TEST_ONLY_NO_INTERNET_ARGS_FOR_UNGUARDED_LAUNCH: readonly string[] = Object.freeze([
  `--disable-features=${[...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES, ...TEST_ONLY_GOOGLE_CONNECTION_DISABLED_FEATURES].join(',')}`,
  ...TEST_ONLY_NO_INTERNET_ARGS.slice(1),
]);

/** 製品の起動の引数に、テストだけの外へ出ない引数を足す（`--disable-features` は最後の 1 つが使われるので、後ろに足す）。 */
export const withTestOnlyNoInternetArgs = (args: readonly string[]): readonly string[] => Object.freeze([...args, ...TEST_ONLY_NO_INTERNET_ARGS]);

/**
 * RB-4b: 子のプロセスの入口の本文で、CLI の起動の設定の Chromium を、本番と同じ起動の部品（`launchChromiumWith`。外部のアプリの起動を止める一時のプロファイル
 * と自己検査）で、テストだけの外へ出ない引数を足して起動する式。本文は `chromiumLaunchOptions` と `launchChromiumWith` を読み込む。
 */
export const TEST_CLI_CHROMIUM_LAUNCH_SOURCE = `launchChromiumWith({ ...chromiumLaunchOptions({ headless: true }), args: [...chromiumLaunchOptions({ headless: true }).args, ...${JSON.stringify(TEST_ONLY_NO_INTERNET_ARGS)}] })`;

/**
 * テストの既定の headless shell に、既定で付ける起動の引数。CLI と同じ守りの引数のうち、headless shell に要るもの: Shared Worker を無効にする引数
 * （DEF-044）。BN-R0 の C-1 から、ページの先読みを止める引数（`--enable-features` と、
 * Playwright の既定の値を引き継いだ `--disable-features` の 1 つ。どちらも CLI と同じ値）も付ける（headless shell でも、speculation rules の先読みの文書の
 * 要求が Guard を通らずに届いたため）。
 */
export const TEST_DEFAULT_CHROMIUM_ARGS: readonly string[] = withTestOnlyNoInternetArgs([
  ...CHROMIUM_PRELOADING_DISABLED_ARGS,
  ...CHROMIUM_DISABLED_FEATURES_ARGS,
  ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
]);

/**
 * 子のプロセスの入口の本文で、テストの既定の headless shell を起動する式。引数は `TEST_DEFAULT_CHROMIUM_ARGS` の値を、そのまま式に埋める
 * （子は `chromium` だけを読み込めばよい）。
 */
export const TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE = `chromium.launch({ headless: true, args: ${JSON.stringify(TEST_DEFAULT_CHROMIUM_ARGS)} })`;
