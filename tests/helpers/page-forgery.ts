/**
 * ページの JS の偽り（T32j-4。DEF-087・DEF-114 の形）。isolated world で読む部品（ログインの事前の確かめ、Interaction の候補の発見・解決・
 * 読み取り、書き込みの段の同じ要素の確かめ、要素の橋渡し）が、ページの JS の偽りの下でも正しく読み、読む間にページの JS が走らないことを
 * 確かめるテストが共有する。
 * - 偽りは、ページの `<head>` の外部の script（`/forgery.js?k=<種類>`。CSP の `script-src 'self'` でも動く）で入れる。偽りが走るたびに
 *   `window.__pageHits`（`PAGE_HITS`）を 1 つ増やす。
 * - 偽りは main world の読み取りを誤らせる値を返す（form の method を `get`、要素の id を `forged`、`isConnected` を false、走査は空など）。
 * - 走った回数は、CDP の `Runtime.evaluate` で global の値を読むだけで数える（`readPageHits`。Playwright の `evaluate` はページの JS を
 *   呼びうるので使わない）。
 */
import type { Page } from 'playwright';

/** 偽りが走った回数を数える、ページの global の名前。 */
export const PAGE_HITS = '__pageHits';

const count = `window.${PAGE_HITS} = (window.${PAGE_HITS} || 0) + 1;`;

/** 偽りの種類ごとの script（`none` は偽りなし）。 */
export const PAGE_FORGERIES = Object.freeze({
  none: '',
  // `Function.prototype.call` を上書きし、標準の getter を `call` で呼ぶ読み取りに偽の値を返す。
  call: `window.${PAGE_HITS} = 0; (() => {
    const getterOf = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
    const apply = Reflect.apply;
    const fakes = new Map([
      [getterOf(Element.prototype, 'id'), () => 'forged'],
      [getterOf(Element.prototype, 'localName'), () => 'div'],
      [getterOf(Element.prototype, 'tagName'), () => 'DIV'],
      [getterOf(HTMLFormElement.prototype, 'method'), () => 'get'],
      [getterOf(HTMLInputElement.prototype, 'type'), () => 'hidden'],
      [getterOf(Node.prototype, 'isConnected'), () => false],
    ]);
    Function.prototype.call = function (thisArg, ...args) {
      const fake = fakes.get(this);
      if (fake) { ${count} return fake(); }
      return apply(this, thisArg, args);
    };
  })();`,
  // `Object.getOwnPropertyDescriptor` を上書きし、偽の getter を返す。
  gopd: `window.${PAGE_HITS} = 0; (() => {
    const original = Object.getOwnPropertyDescriptor;
    const fakes = { id: 'forged', localName: 'div', tagName: 'DIV', method: 'get', type: 'hidden' };
    Object.getOwnPropertyDescriptor = function (target, name) {
      const descriptor = original(target, name);
      if (descriptor !== undefined && Object.hasOwn(fakes, name)) { ${count} return { ...descriptor, get() { return fakes[name]; } }; }
      return descriptor;
    };
  })();`,
  // prototype の getter を、偽の値を返す getter に書き換える。
  proto: `window.${PAGE_HITS} = 0; (() => {
    const define = (prototype, name, fake) => Object.defineProperty(prototype, name, {
      configurable: true, enumerable: true, get() { ${count} return fake; },
    });
    define(Element.prototype, 'id', 'forged');
    define(Element.prototype, 'localName', 'div');
    define(Element.prototype, 'tagName', 'DIV');
    define(HTMLFormElement.prototype, 'method', 'get');
    define(HTMLInputElement.prototype, 'type', 'hidden');
    define(Node.prototype, 'isConnected', false);
  })();`,
  // `Function.prototype.bind` と `apply` を上書きする（走ったら数える）。
  bind: `window.${PAGE_HITS} = 0; (() => {
    const reflect = Reflect.apply;
    const bind = Function.prototype.bind;
    const apply = Function.prototype.apply;
    Function.prototype.bind = function (...args) { ${count} return reflect(bind, this, args); };
    Function.prototype.apply = function (...args) { ${count} return reflect(apply, this, args); };
  })();`,
  // 戻り値の直列化を狙う偽り（DEF-114 の形）: `Object.prototype` の getter（`v`）と、`Array.isArray`・`Object.is`。
  serialize: `window.${PAGE_HITS} = 0; (() => {
    Object.defineProperty(Object.prototype, 'v', { configurable: true, get() { ${count} return 'true'; } });
    const isArray = Array.isArray;
    Array.isArray = function (value) { ${count} return isArray(value); };
    Object.is = function () { ${count} return true; };
  })();`,
  // 走査の偽り: `querySelectorAll`・`querySelector`・`getElementById`・`createTreeWalker` が空を返す。
  walk: `window.${PAGE_HITS} = 0; (() => {
    const empty = document.createDocumentFragment();
    Document.prototype.querySelectorAll = function () { ${count} return empty.querySelectorAll('*'); };
    Element.prototype.querySelectorAll = function () { ${count} return empty.querySelectorAll('*'); };
    DocumentFragment.prototype.querySelectorAll = function () { ${count} return empty.querySelectorAll('*'); };
    Document.prototype.querySelector = function () { ${count} return null; };
    Document.prototype.getElementById = function () { ${count} return null; };
    Document.prototype.createTreeWalker = function () { ${count} return { nextNode: () => null, currentNode: null }; };
  })();`,
  // DOM clobbering: 名前つきの要素が `document` の標準のプロパティとメソッドを隠す（読み込みの後に足す）。
  clobber: `window.${PAGE_HITS} = 0; addEventListener('DOMContentLoaded', () => {
    for (const name of ['body', 'documentElement', 'forms', 'querySelector', 'querySelectorAll', 'getElementById', 'createTreeWalker']) {
      const image = document.createElement('img');
      image.name = name;
      document.body.append(image);
    }
  });`,
} as const);
export type PageForgeryKind = keyof typeof PAGE_FORGERIES;
/** 偽りの種類（`none` を除く）。 */
export const PAGE_FORGERY_KINDS = Object.freeze(
  (Object.keys(PAGE_FORGERIES) as PageForgeryKind[]).filter((kind) => kind !== 'none'),
);

/** 偽りの script の path（テストのサーバが `PAGE_FORGERIES[k]` を JavaScript として返す）。 */
export const PAGE_FORGERY_SCRIPT_PATH = '/forgery.js';

/** 偽りの script を `<head>` で読み込むページの HTML。 */
export const pageForgeryHtml = (body: string, kind: string, title = 'forgery'): string =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title>`
  + `<script src="${PAGE_FORGERY_SCRIPT_PATH}?k=${encodeURIComponent(kind)}"></script></head><body>${body}</body></html>`;

/** 偽りの script の本文（知らない種類は空）。 */
export const pageForgeryScript = (kind: string | null): string =>
  (kind !== null && Object.hasOwn(PAGE_FORGERIES, kind) ? PAGE_FORGERIES[kind as PageForgeryKind] : '');

/** ページの JS が走った回数（CDP の `Runtime.evaluate` で global の値を読むだけ）。 */
export const readPageHits = async (page: Page): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  try {
    const { result } = await session.send('Runtime.evaluate', { expression: `window.${PAGE_HITS} ?? 0`, returnByValue: true });
    return typeof result.value === 'number' ? result.value : Number.NaN;
  } finally {
    await session.detach();
  }
};

/** 偽りの script が入ったか（`PAGE_HITS` が数として置かれたか。CDP の `Runtime.evaluate` で読むだけ）。 */
export const pageForgeryInstalled = async (page: Page): Promise<boolean> => {
  const session = await page.context().newCDPSession(page);
  try {
    const { result } = await session.send('Runtime.evaluate', { expression: `typeof window.${PAGE_HITS} === 'number'`, returnByValue: true });
    return result.value === true;
  } finally {
    await session.detach();
  }
};
