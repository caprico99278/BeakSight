import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { afterAll, beforeAll } from 'vitest';
import { CHROMIUM_SHARED_WORKERS_DISABLED_ARGS, chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT } from '../../src/safety/passive-request-guard.js';
import { overrideBrowser } from './browser-proxies.js';

/**
 * 別のサイトの iframe を別のプロセス（OOPIF）にする、Chromium の起動の引数（C18i。サイトの分離を強める側の引数）。
 * 標準の headless は OOPIF を作らないので、OOPIF の確かめに使う。サイトの分離を無効にする引数は、使わない。
 */
export const SITE_PER_PROCESS_ARGS = Object.freeze(['--site-per-process'] as const);

/**
 * ブラウザ（Chromium）自身が、ページのアイコンを取りに行くときの既定のパス（ページにアイコンの指定がない場合）。
 * Guard の付いた Context では、ふつうは Playwright が止めるが、まれにサーバに届く（DEF-024。サイトへの負荷の制御の設計書 4.9）。
 * サーバに届いた要求を確かめるテストは、このパスへの GET だけを、ブラウザ自身の要求として、期待する要求の一覧の確かめから除く。
 */
export const BROWSER_DEFAULT_FAVICON_PATH = '/favicon.ico';

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
 */
export function launchHeadlessChromium(options: HeadlessChromiumOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, args: withSharedWorkerArgs(options.args ?? [], options.sharedWorkers) });
}

/** `launchCliChromium` の指定。 */
export interface CliChromiumOptions {
  /** Shared Worker の扱い（既定は `disabled`。CLI と同じ）。 */
  readonly sharedWorkers?: TestSharedWorkers;
}

/**
 * CLI と同じ起動の設定（`chromiumLaunchOptions({ headless: true })`。`channel: 'chromium'` の `chrome.exe` の新しい headless）で Chromium を
 * 起動する。`sharedWorkers: 'allow'` のときだけ、Shared Worker を無効にする引数を外す（DEF-044 の自己検査と対照のテストの明示の選択）。
 */
export function launchCliChromium(options: CliChromiumOptions = {}): Promise<Browser> {
  const launchOptions = chromiumLaunchOptions({ headless: true });
  return chromium.launch({ ...launchOptions, args: withSharedWorkerArgs(launchOptions.args ?? [], options.sharedWorkers) });
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
 * DEF-049（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5 と変更履歴の NP6 の Blocker の行）: Guard が Context に付ける
 * Service Worker の登録の入口を塞ぐ初期化のスクリプト（`SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT`）だけを、付けずに捨てる Browser の
 * Proxy。factory の自己検査（`SERVICE_WORKER_OBSERVED`）を、入口が開いた状態で確かめるテストだけが、明示して選ぶ（テストのためだけの口）。
 * - 製品のコードは変えない。`newContext` で作った本物の Context の `addInitScript` を、その Context の自身のプロパティで置き換える
 *   （`page.context()` が同じ Context を返すので、Guard の Context と Ledger の対応は保たれる）。ほかの初期化のスクリプトは、そのまま付ける。
 * - production の起動（`src/cli/run-command.ts`）は Browser を Proxy にしないので、production では入口を開けられない。
 */
export function browserWithoutServiceWorkerRegistrationBlock(real: Browser): Browser {
  return overrideBrowser(real, {
    newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
      const context = await real.newContext(options);
      const addInitScript = context.addInitScript.bind(context);
      Object.defineProperty(context, 'addInitScript', {
        configurable: true,
        value: async (...args: Parameters<BrowserContext['addInitScript']>): Promise<void> => {
          const [script] = args;
          if (typeof script === 'object' && script !== null && 'content' in script
            && script.content === SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT) {
            return;
          }
          await addInitScript(...args);
        },
      });
      return context;
    },
  });
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
