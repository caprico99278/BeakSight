// CC-068（Task 32 の設計書 4.4 の「CC-068 の設計」の 1）: ページの中で読む部品と型つきの組み立て（`src/browser/in-page-readers.ts`）。
// - 部品（標準の prototype の getter で読む 4 つ）が、DOM clobbering を受けずに読む。getter がないときの扱いは、今までの書き方と同じ
//   （`standardGetter` は例外、ほかは `undefined`）。
// - 組み立てた関数を、今までのページの中の関数と同じ 4 つの道（`page.evaluate`・`ElementHandle.evaluate`・`page.evaluateHandle`・
//   `readInIsolatedWorld`）で動かせる（引数 0〜2 個、async の関数）。CSP（`script-src 'self'`、Trusted Types の `'none'`）のページでも動く。
// - 入力と出力の型を保つ（型の誤りはコンパイルで止まる。`npm run typecheck` で確かめる）。
// Chromium は headless のテストの既定だけ。サーバは 127.0.0.1 のテストの中のサーバだけ。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeInPage, type InPageReader, type StandardReaders } from '../../src/browser/in-page-readers.js';
import { readInIsolatedWorld } from '../../src/discovery/isolated-read.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';

/** isolated world の読み取りの期限（ms）。 */
const ISOLATED_READ_DEADLINE_MS = 5_000;
/** CSP のあるページと、ないページの path。 */
const CSP_PATH = '/csp.html';
const PLAIN_PATH = '/plain.html';
/** CSP のページの見出し（inline の script が動けば、この文字列に書き換わる。CSP が効いていることの確かめ）。 */
const INITIAL_TITLE = 'in-page readers';
const INLINE_SCRIPT_TITLE = 'inline script ran';
/** CSP のページの応答のヘッダ（`script-src 'self'` と Trusted Types の `'none'`）。 */
const STRICT_CSP = "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
/** form と `document` の標準のプロパティを隠す、名前つきの要素のページ（DOM clobbering）。 */
const CLOBBERED_BODY = [
  '<form id="target" method="post" action="/real-action">',
  '<input name="method" value="get"><input name="action" value="/forged"><input name="localName" value="x">',
  '<button name="submitter" type="submit">Send</button>',
  '</form>',
  '<img name="body" alt=""><img name="readyState" alt=""><img name="documentElement" alt="">',
].join('');
const CLOBBERED_HTML = `<!doctype html><html><head><title>${INITIAL_TITLE}</title></head><body>${CLOBBERED_BODY}`
  + `<script>document.title = ${JSON.stringify(INLINE_SCRIPT_TITLE)};</script></body></html>`;
const TARGET_SELECTOR = '#target';
const ACTION_PATH = '/real-action';
const MISSING_PROPERTY_NAME = 'beaksightMissingProperty';

interface ClobberedFacts {
  readonly method: string;
  readonly actionPath: string;
  readonly localName: string | undefined;
  readonly bodyName: string;
  readonly documentElementName: string;
  readonly readyState: string;
  readonly clobbered: boolean;
}

interface TargetInput {
  readonly selector: string;
}

/** 4 つの部品で、隠されたプロパティを読む（組み立てる側）。 */
const readClobberedFacts: InPageReader<[TargetInput], ClobberedFacts> = (R, input) => {
  const form = Document.prototype.querySelector.call(document, input.selector);
  const methodOf = R.standardGetter<string>(HTMLFormElement.prototype, 'method');
  const localNameOf = R.optionalStandardGetter<string>(Element.prototype, 'localName');
  const action = R.standardProperty<string>(HTMLFormElement.prototype, 'action', form);
  return {
    method: methodOf(form),
    actionPath: new URL(action).pathname,
    localName: localNameOf(form),
    bodyName: R.documentProperty<HTMLElement>('body').localName,
    documentElementName: R.documentProperty<HTMLElement>('documentElement').localName,
    readyState: R.documentProperty<string>('readyState'),
    clobbered: ((form as HTMLFormElement).method as unknown) instanceof Element
      && (document as unknown as Record<string, unknown>)['body'] instanceof HTMLImageElement,
  };
};
const composedClobberedFacts = composeInPage(readClobberedFacts);

const EXPECTED_FACTS: ClobberedFacts = {
  method: 'post',
  actionPath: ACTION_PATH,
  localName: 'form',
  bodyName: 'body',
  documentElementName: 'html',
  readyState: 'complete',
  clobbered: true,
};

/** getter がないときの扱い（`standardGetter` 以外は `undefined`）。 */
const readMissing = composeInPage((R: StandardReaders, name: string) => ({
  optional: R.optionalStandardGetter(Document.prototype, name)(document) === undefined,
  property: R.standardProperty(Document.prototype, name, document) === undefined,
  documentProperty: R.documentProperty(name) === undefined,
}));
/** getter がないとき、`standardGetter` は例外にする（今までの `standardGetter`・`getterOf` と同じ文言）。 */
const throwMissing = composeInPage((R: StandardReaders, name: string) => R.standardGetter(Document.prototype, name)(document));

/** 引数 0 個・2 個・async の関数。 */
const readWithoutArguments = composeInPage((R: StandardReaders) => R.documentProperty<string>('readyState'));
const readElementAndInput = composeInPage((R: StandardReaders, element: Element, input: { readonly attribute: string }) => ({
  localName: R.standardGetter<string>(Element.prototype, 'localName')(element),
  attribute: Element.prototype.getAttribute.call(element, input.attribute),
}));
const readAfterFrame = composeInPage(async (R: StandardReaders, input: TargetInput) => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return R.standardGetter<string>(HTMLFormElement.prototype, 'method')(Document.prototype.querySelector.call(document, input.selector));
});

/** CSP が効いているかの確かめ（inline の script が動かなかった）。 */
const readTitle = composeInPage((R: StandardReaders) => R.documentProperty<string>('title'));

/** 型の確かめ（実行しない。`npm run typecheck` で、誤りがコンパイルで止まることを確かめる）。 */
export function typeOnlyChecks(page: Page): void {
  const facts: Promise<ClobberedFacts> = page.evaluate(composedClobberedFacts, { selector: TARGET_SELECTOR });
  void facts;
  // @ts-expect-error 入力の形の誤りはコンパイルで止まる
  void page.evaluate(composedClobberedFacts, { wrong: TARGET_SELECTOR });
  // @ts-expect-error 出力の型の誤りもコンパイルで止まる
  const wrongOutput: Promise<{ readonly method: number }> = page.evaluate(composedClobberedFacts, { selector: TARGET_SELECTOR });
  void wrongOutput;
  // @ts-expect-error 部品の後の引数は 2 個まで（`ElementHandle.evaluate` の（要素, 入力）まで）
  void composeInPage((_R: StandardReaders, first: number, second: number, third: number) => first + second + third);
}

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('CC-068: the in-page readers and their typed composition (%s)', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request, response) => {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (request.url === CSP_PATH) {
        headers['content-security-policy'] = STRICT_CSP;
      } else if (request.url !== PLAIN_PATH) {
        response.writeHead(404, headers).end();
        return;
      }
      response.writeHead(200, headers).end(CLOBBERED_HTML);
    });
  });
  afterAll(async () => {
    await server.close();
    await browser.close();
  });

  const withPage = async (path: string, use: (page: Page) => Promise<void>): Promise<void> => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}${path}`);
      await use(page);
    } finally {
      await page.close();
    }
  };

  it.each([PLAIN_PATH, CSP_PATH])('reads through the DOM clobbering with the standard getters in the main world and the isolated world (%s)', async (path) => {
    await withPage(path, async (page) => {
      expect(await page.evaluate(readTitle)).toBe(path === CSP_PATH ? INITIAL_TITLE : INLINE_SCRIPT_TITLE);
      expect(await page.evaluate(composedClobberedFacts, { selector: TARGET_SELECTOR })).toEqual(EXPECTED_FACTS);
      // isolated world では、名前つきの要素がプロパティを隠すかどうか（`clobbered`）はページの main world と同じとは限らないので、読んだ値だけを比べる。
      const isolated = await readInIsolatedWorld(page, composedClobberedFacts, { selector: TARGET_SELECTOR }, Date.now() + ISOLATED_READ_DEADLINE_MS);
      expect(isolated).toEqual({ status: 'READ', value: { ...EXPECTED_FACTS, clobbered: expect.any(Boolean) } });
    });
  });

  it.each([PLAIN_PATH, CSP_PATH])('runs on each way of calling with 0 to 2 arguments and an async reader (%s)', async (path) => {
    await withPage(path, async (page) => {
      expect(await page.evaluate(readWithoutArguments)).toBe('complete');
      const handle = await page.locator('button').elementHandle();
      if (handle === null) throw new Error('Missing submitter');
      try {
        expect(await handle.evaluate(readElementAndInput, { attribute: 'name' })).toEqual({ localName: 'button', attribute: 'submitter' });
      } finally {
        await handle.dispose();
      }
      const resultHandle = await page.evaluateHandle(composedClobberedFacts, { selector: TARGET_SELECTOR });
      try {
        expect(await resultHandle.jsonValue()).toEqual(EXPECTED_FACTS);
      } finally {
        await resultHandle.dispose();
      }
      expect(await page.evaluate(readAfterFrame, { selector: TARGET_SELECTOR })).toBe('post');
    });
  });

  it('keeps the treatment of a missing getter (an exception only from standardGetter)', async () => {
    await withPage(PLAIN_PATH, async (page) => {
      expect(await page.evaluate(readMissing, MISSING_PROPERTY_NAME)).toEqual({ optional: true, property: true, documentProperty: true });
      await expect(page.evaluate(throwMissing, MISSING_PROPERTY_NAME)).rejects.toThrow(`Missing standard DOM getter: ${MISSING_PROPERTY_NAME}`);
      const isolated = await readInIsolatedWorld(page, throwMissing, MISSING_PROPERTY_NAME, Date.now() + ISOLATED_READ_DEADLINE_MS);
      expect(isolated).toEqual({ status: 'FAILED' });
    });
  });
});
