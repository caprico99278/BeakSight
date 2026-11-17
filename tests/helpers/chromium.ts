import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { afterAll, beforeAll } from 'vitest';
import {
  CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
  chromiumLaunchOptions,
  launchChromiumWith,
  PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES,
  type ChromiumLaunchDependencies,
} from '../../src/browser/chromium-launch.js';
import { SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT } from '../../src/safety/passive-request-guard.js';
import { BROWSER_DEFAULT_FAVICON_PATH as BROWSER_DEFAULT_FAVICON_PATH_VALUE } from '../../src/safety/request-policy.js';
import { browserSharedForRun, browserWithoutInitScript } from './browser-proxies.js';
import { TEST_DEFAULT_CHROMIUM_ARGS, withTestOnlyNoInternetArgs } from './test-chromium-args.js';
import { CLI_CHROMIUM_SELECTION, isBothChromiumSelected, TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE } from './test-run-environment.js';

/**
 * 別のサイトの iframe を別のプロセス（OOPIF）にする、Chromium の起動の引数（C18i。サイトの分離を強める側の引数）。
 * 標準の headless は OOPIF を作らないので、OOPIF の確かめに使う。サイトの分離を無効にする引数は、使わない。
 */
export const SITE_PER_PROCESS_ARGS = Object.freeze(['--site-per-process'] as const);

/**
 * ブラウザ（Chromium）自身が、ページのアイコンを取りに行くときの既定のパス（ページにアイコンの指定がない場合）。
 * Guard の付いた Context では、ふつうは Playwright が止めるが、まれにサーバに届く（DEF-024。サイトへの負荷の制御の設計書 4.9）。
 * サーバに届いた要求を確かめるテストは、このパスへの GET だけを、ブラウザ自身の要求として、期待する要求の一覧の確かめから除く。
 * 値は製品の `src/safety/request-policy.ts` の定数そのもの（CC-067。テストの側に同じ値を書かない）。
 */
export { BROWSER_DEFAULT_FAVICON_PATH } from '../../src/safety/request-policy.js';

/**
 * BN-R1 の M-4（DEF-126・DEF-150 と同じ扱いの 1 か所）: ブラウザ自身の favicon の要求か（GET で、Origin がテストのサーバの `origin`、path が
 * `BROWSER_DEFAULT_FAVICON_PATH`、query と fragment がない）。CLI の Chromium は、この要求を出す時点が揺れる（凍結の後になると、止めた記録が 1 件増える）ので、
 * テストの比べから除くときは、ここを使う。止めた証拠とサーバに届かないことの確かめは、除いた残りで、今どおり行う。
 * BN-R1 の確かめ直しの N-4: ほかの Origin の `/favicon.ico` を除かないよう、テストのサーバの Origin を受ける（相対の URL と、解けない URL は除かない）。
 */
export function isBrowserFaviconRequest(method: string, url: string, origin: string): boolean {
  if (method.toUpperCase() !== 'GET' || url.includes('?') || url.includes('#')) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(origin).origin && parsed.pathname === BROWSER_DEFAULT_FAVICON_PATH_VALUE;
  } catch {
    return false;
  }
}

/** 記録の一覧から、テストのサーバの `origin` への、ブラウザ自身の favicon の要求（`isBrowserFaviconRequest`）を除く。 */
export function withoutBrowserFaviconRecords<T extends { readonly method: string; readonly url: string }>(records: readonly T[], origin: string): T[] {
  return records.filter(({ method, url }) => !isBrowserFaviconRequest(method, url, origin));
}

/** サーバの要求の行（`<method> <path>`）の一覧から、ブラウザ自身の favicon の要求を除く。 */
export function withoutBrowserFaviconRequestLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line !== `GET ${BROWSER_DEFAULT_FAVICON_PATH_VALUE}`);
}

/**
 * テストの Chromium の Shared Worker の扱い（DEF-044。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.2）。
 * - `disabled`（既定）: CLI と同じく、Shared Worker を無効にする引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）を付ける。
 * - `allow`: 引数を付けない（外す）。factory の自己検査（`SHARED_WORKER_OBSERVED`）と、Shared Worker の fixture の対照を確かめるテスト
 *   だけが、明示して選ぶ。
 */
export type TestSharedWorkers = 'disabled' | 'allow';

/** `launchHeadlessChromium` の指定。 */
export interface HeadlessChromiumOptions {
  /** 起動の引数（例: `SITE_PER_PROCESS_ARGS`）。headless を変える引数は渡さない。Shared Worker の引数は、`sharedWorkers` で決める。 */
  readonly args?: readonly string[];
  /** Shared Worker の扱い（既定は `disabled`）。 */
  readonly sharedWorkers?: TestSharedWorkers;
}

/** `sharedWorkers` の扱いで、Shared Worker を無効にする引数を付けるか外す。 */
function withSharedWorkerArgs(args: readonly string[], sharedWorkers: TestSharedWorkers = 'disabled'): string[] {
  const disabled: readonly string[] = CHROMIUM_SHARED_WORKERS_DISABLED_ARGS;
  const others = args.filter((arg) => !disabled.includes(arg));
  return sharedWorkers === 'allow' ? others : [...others, ...disabled];
}

/**
 * headless の Chromium（テストの既定の headless shell）を起動する。テストの Chromium は、いつも headless で起動する
 * （headed では、端末の外部のアプリ（電話、メールなど）が実際に起動するおそれがあるため）。Shared Worker は、既定で無効にする（DEF-044）。
 * 既定の引数は `TEST_DEFAULT_CHROMIUM_ARGS`（`test-chromium-args.ts`。CC-098）。
 */
export function launchHeadlessChromium(options: HeadlessChromiumOptions = {}): Promise<Browser> {
  if (isCliChromiumSelected()) {
    return launchCliChromium(options);
  }
  return launchTestDefaultChromium(options);
}

/**
 * EL-12: テストの既定の headless shell を、CLI の回の環境変数によらず起動する（両方の Chromium をファイルの中で流すテストが、既定の側に使う）。引数は
 * `launchHeadlessChromium` の既定の回と同じ。
 */
export function launchTestDefaultChromium(options: HeadlessChromiumOptions = {}): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: withSharedWorkerArgs([...TEST_DEFAULT_CHROMIUM_ARGS, ...(options.args ?? [])], options.sharedWorkers),
  });
}

/**
 * DEF-085 fix round 1: テストの既定の Chromium（`launchHeadlessChromium`）を、CLI の起動の設定に切り替える環境変数と、CLI の Chromium を選ぶ値。
 * 名前と値は `test-run-environment.ts` の 1 か所（TS-a の発見事項 2。組を流す起動の部品も、そこから読む）。
 */
export { CLI_CHROMIUM_SELECTION, TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE } from './test-run-environment.js';

/**
 * DF-1: この回のテストの既定の Chromium が、CLI の起動の設定か（`TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE` が `CLI_CHROMIUM_SELECTION`。唯一の判定）。
 * `launchHeadlessChromium` の切り替えと、ブラウザの別に期待を分けるテスト（例: DEF-150 のブラウザ自身の favicon）が使う。
 */
export function isCliChromiumSelected(): boolean {
  return process.env[TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE] === CLI_CHROMIUM_SELECTION;
}

/** `launchCliChromium` の指定。 */
export interface CliChromiumOptions {
  /** Shared Worker の扱い（既定は `disabled`。CLI と同じ）。 */
  readonly sharedWorkers?: TestSharedWorkers;
  /** 足す起動の引数（DEF-099 fix: https の fixture の証明書の誤りを無視する引数など。テストの中だけ）。 */
  readonly args?: readonly string[];
}

/** CLI の起動の組の起動の値（`chromiumLaunchOptions({ headless: true })` に、引数を足し引きしたもの）。 */
function cliLaunchOptionsOf(options: CliChromiumOptions): LaunchOptions {
  const launchOptions = chromiumLaunchOptions({ headless: true });
  return {
    ...launchOptions,
    // RB-4b: テストは外のインターネットへ出さないので、テストだけの引数で Chromium 自身の Google への接続を止める（`withTestOnlyNoInternetArgs`）。
    args: withSharedWorkerArgs([...withTestOnlyNoInternetArgs(launchOptions.args ?? []), ...(options.args ?? [])], options.sharedWorkers),
  };
}

/**
 * EL-12: 起動の部品（`launchChromiumWith`）で起動した Browser の、起動の直後にあった Context（persistent の既定の Context）。Run の Context ではない
 * （`testContextsOf` が除く）。
 */
const launchDefaultContexts = new WeakMap<Browser, ReadonlySet<BrowserContext>>();

async function launchCliChromiumWith(options: CliChromiumOptions, dependencies: ChromiumLaunchDependencies): Promise<Browser> {
  const browser = await launchChromiumWith(cliLaunchOptionsOf(options), dependencies);
  launchDefaultContexts.set(browser, new Set(browser.contexts()));
  return browser;
}

/**
 * CLI と同じ起動の設定（`chromiumLaunchOptions({ headless: true })`。`channel: 'chromium'` の `chrome.exe` の新しい headless）で、本番と同じ起動の部品
 * （`launchChromiumWith`。EL-12: 一時のプロファイルの外部のアプリの起動を止める設定と自己検査）で Chromium を起動する。`sharedWorkers: 'allow'` のときだけ、
 * Shared Worker を無効にする引数を外す（DEF-044 の自己検査と対照のテストの明示の選択）。persistent の既定の Context が `browser.contexts()` に 1 つ入る
 * （テストが Context を数えたり閉じたりするときは `testContextsOf`・`closeTestContexts` を使う。既定の Context を閉じると Browser が終わる）。
 */
export function launchCliChromium(options: CliChromiumOptions = {}): Promise<Browser> {
  return launchCliChromiumWith(options, PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES);
}

/**
 * `BOTH_CHROMIUM_LAUNCHERS` の 1 つの起動（指定は、既定の Chromium と CLI の Chromium の両方が受ける形）。製品の起動の口（`{ headless }` を渡す）に
 * そのまま渡せるよう `headless` も受けるが、テストの Chromium はいつも headless なので読まない。
 */
export type BothChromiumLauncher = (
  options?: HeadlessChromiumOptions & CliChromiumOptions & { readonly headless?: boolean },
) => Promise<Browser>;

/**
 * SLIM-B0: 2 つの Chromium の組（`[テストの既定の Chromium の回, CLI の起動の設定の回]`）のうち、この回で流すもの（唯一の入口）。既定は CLI の起動の設定
 * （本番）の 1 つだけ。両方に広げるのは、`test-run-environment.ts` の `BOTH_CHROMIUM_RUN_ENVIRONMENT` の回（`tests/run-suite.mjs` の `safety`、
 * `related --with-safety`・`--both-chromium`。安全の不具合を直す束、Guard・中継・起動の部品を変えた束、Chromium の版を上げるとき）だけ。
 * ファイルの中で 2 つの Chromium の組を作るテストは、組の一覧（`describe.each` に渡す一覧、子のプロセスの入口に埋める起動の組など）を、ここに通して
 * 受け取る（Architecture Gate `tests/architecture/test-suites.test.ts`）。1 回だけ流す場面は、受け取った一覧の先頭の回で流す。
 */
export function chromiumRunsOf<const L extends readonly [unknown, unknown]>(runs: L): readonly L[number][] {
  return isBothChromiumSelected() ? Object.freeze([runs[0], runs[1]]) : Object.freeze([runs[1]]);
}

/** SLIM-B0: `BOTH_CHROMIUM_LAUNCHERS` の、CLI の起動の設定の回の名前（回の Chromium で場面を分けるテストが比べる）。 */
export const CLI_CHROMIUM_RUN_LABEL = 'the CLI launch settings';

/**
 * TEST-SLIM H0: 2 つの Chromium（テストの既定の headless shell と、CLI の起動の設定）で同じ場面を流す組（`describe.each(BOTH_CHROMIUM_LAUNCHERS)`）。
 * SLIM-B0: 組は `chromiumRunsOf` で選ぶ（既定は CLI の起動の設定の 1 つ、両方に広げる回だけ 2 つ）。
 * TEST-POLICY の決まり 3: 使うのは、安全の漏れを確かめるテストだけ（`tests/suites.ts` の安全の一覧か `BOTH_CHROMIUM_LEAK_CHECK_FILES`。Architecture
 * Gate `tests/architecture/test-suites.test.ts`）。ほかのテストは、既定の Chromium（`launchHeadlessChromium`）だけで流す。
 */
export const BOTH_CHROMIUM_LAUNCHERS: readonly (readonly [string, BothChromiumLauncher])[] = chromiumRunsOf([
  Object.freeze(['the default test Chromium', (options = {}) => launchTestDefaultChromium(options)] as const),
  Object.freeze([CLI_CHROMIUM_RUN_LABEL, (options = {}) => launchCliChromium(options)] as const),
]);

/** SLIM-B0: 1 回だけ流す場面の回の名前（`BOTH_CHROMIUM_LAUNCHERS` の先頭。両方に広げる回はテストの既定の Chromium、ほかは CLI の起動の設定）。 */
export const ONCE_CHROMIUM_LABEL: string = BOTH_CHROMIUM_LAUNCHERS[0]?.[0] ?? '';

/**
 * TEST-SLIM W2: 既定の Chromium（`launchHeadlessChromium`）だけで流す組。前に `describe.each` で 2 つの Chromium を流していたテストが、
 * 場面の形（名前と起動の組）を変えずに使う。CLI の回（`CLI_CHROMIUM_RUN_ENVIRONMENT`）では、`launchHeadlessChromium` が CLI の Chromium になる。
 */
export const DEFAULT_CHROMIUM_LAUNCHERS: readonly (readonly [string, BothChromiumLauncher])[] = Object.freeze([
  Object.freeze(['the default test Chromium', (options = {}) => launchHeadlessChromium(options)] as const),
]);

/**
 * EL-12: 自己検査の不合格を確かめるテストだけの起動。CLI の起動の組と同じ値で、一時のプロファイルに Preferences を置かずに起動の部品を通す（起動の部品は
 * `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE` で断るはず）。自己検査の移動の先は登録のない独自のスキームなので、外部のアプリは起動しない。
 */
export function launchCliChromiumWithoutExternalLaunchBlock(options: CliChromiumOptions = {}): Promise<Browser> {
  return launchCliChromiumWith(options, { ...PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES, writeProfilePreferences: async () => undefined });
}

/**
 * EL-12: `browser.contexts()` から、起動の部品の persistent の既定の Context を除いたもの（テストの Browser の、テストと Run が作った Context）。
 * テストの既定の headless shell（`chromium.launch`）では、`browser.contexts()` と同じ。
 */
export function testContextsOf(browser: Browser): BrowserContext[] {
  const defaults = launchDefaultContexts.get(browser);
  return browser.contexts().filter((context) => defaults?.has(context) !== true);
}

/** EL-12: テストと Run が作った Context を閉じる（`testContextsOf`。既定の Context は閉じない。閉じると Browser が終わるため）。失敗は無視する。 */
export async function closeTestContexts(browser: Browser): Promise<void> {
  await Promise.all(testContextsOf(browser).map((context) => context.close().catch(() => undefined)));
}

/**
 * テストファイルの `beforeAll` で headless Chromium を起動し、`afterAll` で閉じる。
 * 起動した `Browser` は `onLaunch` で受け取る。
 *
 * テストファイルの最上位（またはブロックの直下）で呼ぶこと。
 * Vitest の既定（`sequence.hooks: 'stack'`）では `afterAll` は登録の逆順に実行されるので、
 * この関数より前に登録した `afterAll` は、ブラウザを閉じた後に実行される。
 */
export function useHeadlessChromium(onLaunch: (browser: Browser) => void, options: HeadlessChromiumOptions = {}): void {
  let launched: Browser | undefined;
  beforeAll(async () => {
    launched = await launchHeadlessChromium(options);
    onLaunch(launched);
  });
  afterAll(async () => {
    await launched?.close();
    launched = undefined;
  });
}

/**
 * SLIM-2（X7）: 同じ process の中の流れ（`executeWriteCreateRun`・`executeDiscoveryRun`・`executeReadCheckRun` など）を何度も動かすテストが、流れごとに
 * Chromium を起こし直さないための起動の関数。呼ばれた describe の中で、最初の流れが `launch` で 1 回だけ本物を起こし（切れていたら起こし直す）、流れには
 * `browserSharedForRun` の Proxy を返す（流れの終わりの `close()` は、その流れの Context だけを閉じる）。`afterAll` で本物を閉じる。describe の直下で呼ぶ。
 */
export function useSharedRunBrowser(launch: () => Promise<Browser>): () => Promise<Browser> {
  let shared: Promise<Browser> | undefined;
  afterAll(async () => {
    const launched = shared;
    shared = undefined;
    await (await launched?.catch(() => undefined))?.close().catch(() => undefined);
  });
  return async () => {
    let real = shared === undefined ? undefined : await shared.catch(() => undefined);
    if (real === undefined || !real.isConnected()) {
      shared = launch();
      real = await shared;
    }
    return browserSharedForRun(real);
  };
}

/**
 * DEF-049（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5 と変更履歴の NP6 の Blocker の行）: Guard が Context に付ける
 * Service Worker の登録の入口を塞ぐ初期化のスクリプト（`SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT`）だけを、付けずに捨てる Browser の
 * Proxy。factory の自己検査（`SERVICE_WORKER_OBSERVED`）を確かめるテストだけが、明示して選ぶ（テストのためだけの口）。UPG-SW: Playwright 1.64.1
 * の `serviceWorkers: 'block'` は `ServiceWorkerContainer.prototype.register` を置き換えるので、これだけでは入口は開かない（どの迂回も登録せずに
 * 解決する）。入口を開いた状態は、Context の作成を `serviceWorkers: 'allow'` に替える Proxy と重ねて作る（`context-factory.test.ts` の
 * `browserOpeningServiceWorkerRegistration`）。
 * 作りは `browserWithoutInitScript`（CC-098）。production の起動（`src/cli/run-command.ts`）は Browser を Proxy にしないので、production では入口を
 * 開けられない。
 */
export function browserWithoutServiceWorkerRegistrationBlock(real: Browser): Browser {
  return browserWithoutInitScript(real, SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT);
}

/** ブラウザの CDP の target のうち、iframe の種類（別のプロセスの iframe。OOPIF）の target の URL。 */
export async function oopifTargetUrls(browser: Browser): Promise<string[]> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'iframe').map((target) => target.url);
  } finally {
    await session.detach();
  }
}
