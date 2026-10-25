// DEF-134（T39d の発見事項 1）: 要素の位置の engine（`beaksight-element-path`）の登録の時期のテストの本体（テストのファイルではない）。
// - 先に Playwright のセレクタ（`locator`）を使った page でも、合図つきの Locator（`elementHandleOf`。`withSignaledElements` と自前の selector engine）が
//   要素を返すこと。factory が page を作るときに engine を登録していれば通る（登録が使う直前だけなら、その page の Playwright の読み取りの部品が engine を
//   知らず、要素を返さない）。
// - engine の登録は process の中で 1 回だけなので、Chromium ごとに別のテストのファイル（別の worker）から呼ぶ（同じファイルで 2 つの Chromium を
//   続けて確かめると、2 つ目は 1 つ目の登録で通ってしまう）。
import type { Browser } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { composeInPage, type StandardReaders } from '../../src/browser/in-page-readers.js';
import { elementHandleOf, readElementsInIsolatedWorld, type InPageElementsResult } from '../../src/discovery/isolated-read.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite } from './spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from './test-config.js';

const TEST_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** メールアドレスの欄（`#email`）を、要素の参照として返す（ページの中で動く）。 */
const emailFieldInPage = composeInPage((_R: StandardReaders, id: string): InPageElementsResult => {
  const element = Document.prototype.getElementById.call(document, id);
  return { value: null, elements: element === null ? [] : [element] };
});

/** 1 つの Chromium で、先に locator を使った page で合図つきの Locator を確かめる。 */
export const describeElementPathEngineTiming = (label: string, launch: () => Promise<Browser>): void => {
  describe(`DEF-134: the element path engine on a page that used a locator first (${label})`, () => {
    let browser: Browser | undefined;

    afterAll(async () => {
      await browser?.close();
    });

    it('finds the element by the signaled locator after a locator was used on the page first', async () => {
      browser = await launch();
      const site = await startSpaAuthSite({});
      try {
        const factory = new BrowserContextFactory(browser, createTestConfig(site.appOrigin, SPA_APP_PATHS.auth), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
        const context = await factory.createPassiveContext(VIEWPORT);
        const page = await factory.createPassivePage(context);
        await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
        // 先に Playwright のセレクタを使う（その page の Playwright の読み取りの部品ができる）。
        expect(await page.locator(SPA_LOGIN_FIELDS.email).count()).toBe(1);
        const read = await readElementsInIsolatedWorld(page, emailFieldInPage, SPA_LOGIN_FIELDS.email.slice(1), Date.now() + READ_TIMEOUT_MS);
        expect(read.status).toBe('READ');
        const [reference] = read.status === 'READ' ? read.elements : [];
        expect(reference).toBeDefined();
        const handle = reference === undefined ? null : await elementHandleOf(page, reference, Date.now() + READ_TIMEOUT_MS);
        expect(handle).not.toBeNull();
        await handle?.dispose();
        await factory.close();
      } finally {
        await site.close();
      }
    }, TEST_TIMEOUT_MS);
  });
};
