import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll } from 'vitest';

/**
 * 別のサイトの iframe を別のプロセス（OOPIF）にする、Chromium の起動の引数（C18i。サイトの分離を強める側の引数）。
 * 標準の headless は OOPIF を作らないので、OOPIF の確かめに使う。サイトの分離を無効にする引数は、使わない。
 */
export const SITE_PER_PROCESS_ARGS = Object.freeze(['--site-per-process'] as const);

/** `launchHeadlessChromium` の指定。 */
export interface HeadlessChromiumOptions {
  /** 起動の引数（例: `SITE_PER_PROCESS_ARGS`）。headless を変える引数は渡さない。 */
  readonly args?: readonly string[];
}

/**
 * headless の Chromium を起動する。テストの Chromium は、いつも headless で起動する
 * （headed では、端末の外部のアプリ（電話、メールなど）が実際に起動するおそれがあるため）。
 */
export function launchHeadlessChromium(options: HeadlessChromiumOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, ...(options.args === undefined ? {} : { args: [...options.args] }) });
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
