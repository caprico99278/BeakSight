// T32j-4（Task 32 の設計書 4.4 の「CC-068 の設計」の 2。調査 T32j-3 の Ri・Ii・Bx）: 要素の橋渡しの部品（`src/discovery/isolated-read.ts`）。
// - (a) `readElementsInIsolatedWorld`: isolated world で読み、値と、要素の参照（backendNodeId と、文書の根からの位置）を返す。shadow root の中の
//   要素は位置を持たない（null）。
// - (b) `readElementInIsolatedWorld`: backendNodeId の要素を isolated world で解決して読む。外された要素も読める（`isConnected` が false）。
//   ページが移った後は、読めない（`FAILED`）。
// - (c) `elementHandleOf`: 位置の Locator（自前の selector engine `ELEMENT_PATH_ENGINE_NAME`。Playwright の utility world で、標準の getter で
//   位置をたどる）で ElementHandle を得て、得た後に、isolated world で同じ backendNodeId を指すことを
//   確かめ直す。同じ位置の要素が差し替わっていれば、handle を返さない。`backendNodeIdsAtPaths` は位置の要素の backendNodeId。
// - ページの JS の偽り（`Function.prototype.call`、`getOwnPropertyDescriptor`、prototype の getter、`bind`、`Object.prototype` の getter、
//   走査の偽り、DOM clobbering）の下でも正しく読み、読む間にページの JS が走らない（CSP あり・なし）。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。サーバは 127.0.0.1 のテストの中のサーバだけ。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeInPage, type StandardReaders } from '../../src/browser/in-page-readers.js';
import {
  ELEMENT_PATH_ENGINE_NAME,
  elementPathSelectorOf,
  isElementPathSignal,
  newElementPathSignal,
} from '../../src/browser/element-path-engine.js';
import {
  backendNodeIdsAtPaths,
  elementHandleOf,
  readElementInIsolatedWorld,
  readElementsInIsolatedWorld,
  withSignaledElements,
} from '../../src/discovery/isolated-read.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { PAGE_FORGERY_KINDS, PAGE_FORGERY_SCRIPT_PATH, pageForgeryHtml, pageForgeryInstalled, pageForgeryScript, readPageHits, type PageForgeryKind } from '../helpers/page-forgery.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { roundsOf } from '../helpers/test-rounds.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

/** 読み取りの期限（ms）。 */
const READ_DEADLINE_MS = 5_000;
const STRICT_CSP = "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
/** 的の要素（light DOM の 2 つ目のボタン、shadow root の中のボタン）。 */
const BODY = [
  '<main><button id="first" type="button">first</button><section><button id="target" type="button" name="target">target</button></section>',
  '<div id="host"><template shadowrootmode="open"><button id="inner" type="button">inner</button></template></div></main>',
].join('');

/** 的のボタンと、shadow root の中のボタンを読む（値は id、要素は 2 つ）。 */
const readTargets = composeInPage((R: StandardReaders, input: { readonly id: string }) => {
  const target = Document.prototype.getElementById.call(document, input.id);
  const host = Document.prototype.getElementById.call(document, 'host');
  const shadowRootOf = R.standardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');
  const inner = host === null ? null : shadowRootOf(host)?.querySelector('button') ?? null;
  if (target === null || inner === null) throw new Error('Missing targets');
  return { value: { id: R.standardGetter<string>(Element.prototype, 'id')(target) }, elements: [target, inner] };
});
/** 要素の id と、つながっているか。 */
const readIdAndConnected = composeInPage((R: StandardReaders, element: Element, _input: null) => ({
  id: R.standardGetter<string>(Element.prototype, 'id')(element),
  connected: R.standardGetter<boolean>(Node.prototype, 'isConnected')(element),
}));
/** 文書の最初の form を読む（値はなし、要素は form）。 */
const readForm = composeInPage((_R: StandardReaders, _input: null) => {
  const form = Document.prototype.querySelector.call(document, 'form');
  if (form === null) throw new Error('Missing form');
  return { value: null, elements: [form] };
});

/** 入れ替えを続けるページの確かめの回数（値は `test-rounds.ts`。TS-b のふだんの組と全部の組）と、その時間の上限（ms）。 */
const SWAP_ROUNDS = roundsOf('isolatedElementSwap');
const SWAP_TEST_TIMEOUT_MS = 120_000;
/** ページの JS: 的の要素 A（`#target`）と、その写し B を、MessageChannel の回しで絶えず入れ替える（同じ位置）。 */
const SWAP_TARGET_FOREVER = (): void => {
  const a = document.getElementById('target');
  if (a === null) throw new Error('Missing target');
  a.setAttribute('data-which', 'A');
  const b = a.cloneNode(true) as HTMLElement;
  b.setAttribute('data-which', 'B');
  let flip = false;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    (flip ? b : a).replaceWith(flip ? a : b);
    flip = !flip;
    channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);
};

describe.each(LAUNCHERS)('T32j-4: the isolated element bridge (%s)', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (url.searchParams.get('csp') === '1') {
        headers['content-security-policy'] = STRICT_CSP;
      }
      if (url.pathname === PAGE_FORGERY_SCRIPT_PATH) {
        response.writeHead(200, { 'content-type': 'text/javascript' }).end(pageForgeryScript(url.searchParams.get('k')));
        return;
      }
      if (url.pathname !== '/page') {
        response.writeHead(404, headers).end();
        return;
      }
      response.writeHead(200, headers).end(pageForgeryHtml(BODY, url.searchParams.get('k') ?? 'none'));
    });
  });
  afterAll(async () => {
    await server.close();
    await browser.close();
  });

  const open = async (kind: PageForgeryKind = 'none', csp = false): Promise<Page> => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/page?k=${kind}&csp=${csp ? '1' : '0'}`);
    return page;
  };

  it('builds the element path selector of a path with a signal, and makes signals of the closed shape', () => {
    const signal = newElementPathSignal();
    expect(isElementPathSignal(signal)).toBe(true);
    expect(newElementPathSignal()).not.toBe(signal);
    for (const bad of ['beaksight-', `${signal}0`, signal.toUpperCase(), `x${signal}`, 'beaksight-zz', '']) {
      expect(isElementPathSignal(bad), bad).toBe(false);
    }
    expect(elementPathSelectorOf([0, 1, 2], signal)).toBe(`${ELEMENT_PATH_ENGINE_NAME}=0/1/2;${signal}`);
  });

  it('reads the value and the element references, and the element in a shadow root has no path', async () => {
    const page = await open();
    try {
      const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
      if (outcome.status !== 'READ') throw new Error('not read');
      expect(outcome.value).toEqual({ id: 'target' });
      expect(outcome.elements).toHaveLength(2);
      expect(outcome.elements[0]?.path).toEqual([0, 1, 0, 1, 0]);
      expect(outcome.elements[1]?.path).toBeNull();
      expect(outcome.elements.every(({ backendNodeId }) => Number.isSafeInteger(backendNodeId))).toBe(true);
      const ids = await backendNodeIdsAtPaths(page, [[0, 1, 0, 1, 0]], Date.now() + READ_DEADLINE_MS);
      expect(ids).toEqual([outcome.elements[0]?.backendNodeId]);
      expect(await backendNodeIdsAtPaths(page, [[0, 1, 9]], Date.now() + READ_DEADLINE_MS)).toBeNull();
    } finally { await page.close(); }
  });

  it('reads an element by its backendNodeId, also after it is removed, and not after the page moved', async () => {
    const page = await open();
    try {
      const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
      if (outcome.status !== 'READ') throw new Error('not read');
      const backendNodeId = outcome.elements[0]?.backendNodeId ?? Number.NaN;
      expect(await readElementInIsolatedWorld(page, backendNodeId, readIdAndConnected, null, Date.now() + READ_DEADLINE_MS))
        .toEqual({ status: 'READ', value: { id: 'target', connected: true } });
      await page.evaluate(() => document.getElementById('target')?.remove());
      expect(await readElementInIsolatedWorld(page, backendNodeId, readIdAndConnected, null, Date.now() + READ_DEADLINE_MS))
        .toEqual({ status: 'READ', value: { id: 'target', connected: false } });
      await page.goto(`${server.origin}/page?k=none&csp=0`);
      expect(await readElementInIsolatedWorld(page, backendNodeId, readIdAndConnected, null, Date.now() + READ_DEADLINE_MS))
        .toEqual({ status: 'FAILED' });
    } finally { await page.close(); }
  });

  it('gets the element handle at the path only while the path still points to the same element', async () => {
    const page = await open();
    try {
      const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
      if (outcome.status !== 'READ') throw new Error('not read');
      const reference = outcome.elements[0];
      if (reference === undefined) throw new Error('no reference');
      const handle = await elementHandleOf(page, reference, Date.now() + READ_DEADLINE_MS);
      expect(handle).not.toBeNull();
      expect(await handle?.getAttribute('id')).toBe('target');
      await handle?.dispose();
      // 同じ位置の要素を、同じ形の写しに差し替える（位置は同じで、要素は別）。
      await page.evaluate(() => {
        const target = document.getElementById('target');
        target?.replaceWith(target.cloneNode(true));
      });
      expect(await elementHandleOf(page, reference, Date.now() + READ_DEADLINE_MS)).toBeNull();
      const inShadow = outcome.elements[1];
      if (inShadow === undefined) throw new Error('no reference');
      expect(await elementHandleOf(page, inShadow, Date.now() + READ_DEADLINE_MS)).toBeNull();
    } finally { await page.close(); }
  });

  it.each(['nodeType', 'parentElement', 'matches', 'checkVisibility', 'getBoundingClientRect', 'children', 'firstElementChild', 'nextElementSibling',
    'addEventListener', 'removeEventListener', 'dispatchEvent'])(
    'gets the handle of a form whose %s is hidden by a named field (DOM clobbering, DEF-069)',
    async (name) => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<main><p>before</p><form aria-label="clobbered" method="post"><input name="${name}"><button type="submit">Send</button></form></main>`);
        const outcome = await readElementsInIsolatedWorld(page, readForm, null, Date.now() + READ_DEADLINE_MS);
        if (outcome.status !== 'READ') throw new Error('not read');
        const reference = outcome.elements[0];
        if (reference === undefined) throw new Error('no reference');
        const handle = await elementHandleOf(page, reference, Date.now() + READ_DEADLINE_MS);
        expect(handle).not.toBeNull();
        expect(await handle?.evaluate((form) => Element.prototype.getAttribute.call(form, 'aria-label'))).toBe('clobbered');
        await handle?.dispose();
      } finally { await page.close(); }
    },
  );

  // T32R-fix-I1（独立レビュー T32R の I-1）: ページの JS が、的の要素 A と、その写し B（同じ位置）を入れ替え続けても、handle は A の要素だけを
  // 指す（位置の要素と、backendNodeId の要素を、合図の事象で 1 つの同期の呼び出しの中で照らす）。修正の前は 300 回で違う要素が 71〜85 回。
  it.each([false, true])('never hands over a different element while the page keeps swapping it (CSP %s)', async (csp) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}/page?k=none&csp=${csp ? '1' : '0'}`);
      const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
      if (outcome.status !== 'READ') throw new Error('not read');
      const reference = outcome.elements[0];
      if (reference === undefined) throw new Error('no reference');
      await page.evaluate(SWAP_TARGET_FOREVER);
      const counts = { right: 0, wrong: 0, none: 0 };
      for (let round = 0; round < SWAP_ROUNDS; round += 1) {
        const handle = await elementHandleOf(page, reference, Date.now() + READ_DEADLINE_MS);
        if (handle === null) {
          counts.none += 1;
          continue;
        }
        if (await handle.getAttribute('data-which') === 'A') counts.right += 1; else counts.wrong += 1;
        await handle.dispose();
      }
      expect(counts.wrong).toBe(0);
      expect(counts.right + counts.none).toBe(SWAP_ROUNDS);
    } finally { await page.close(); }
  }, SWAP_TEST_TIMEOUT_MS);

  it('keeps the signal and its receiver out of reach of the page JS (main world) while the element is armed', async () => {
    const page = await open();
    try {
      const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
      if (outcome.status !== 'READ') throw new Error('not read');
      const reference = outcome.elements[0];
      if (reference === undefined) throw new Error('no reference');
      const seen = await withSignaledElements(page, [reference.backendNodeId], Date.now() + READ_DEADLINE_MS, async ([signal]) => {
        // main world から、window と document と的の要素の名前、合図の名前の事象の受け手を探す。
        return page.evaluate((name) => {
          const target = document.getElementById('target');
          const names = [...Object.getOwnPropertyNames(window), ...Object.getOwnPropertyNames(document),
            ...(target === null ? [] : Object.getOwnPropertyNames(target))];
          let fired = 0;
          const probe = (): void => { fired += 1; };
          window.addEventListener(name, probe, { capture: true });
          // ページは名前を知らないので、名前を当てずに受け手を見つける手段がない。名前を知った場合でも、ページが送る事象は取り消されない
          // （受け手は isolated world にあり、的の要素のときだけ取り消す）ことを、偽の名前ではなく本当の名前で確かめる。
          const event = new Event(name, { cancelable: true, bubbles: false });
          const notCanceled = document.body.dispatchEvent(event);
          window.removeEventListener(name, probe, { capture: true });
          return { beaksightNames: names.filter((n) => n.toLowerCase().includes('beaksight')), notCanceled, fired };
        }, signal ?? '');
      });
      expect(seen).toEqual({ status: 'DONE', value: { beaksightNames: [], notCanceled: true, fired: 1 } });
    } finally { await page.close(); }
  });

  describe.each([false, true])('with CSP %s', (csp) => {
    it.each([...PAGE_FORGERY_KINDS])(
      'reads honestly and runs no page JS when the page forges by %s',
      async (kind) => {
        const page = await open(kind, csp);
        try {
          const before = await readPageHits(page);
          const outcome = await readElementsInIsolatedWorld(page, readTargets, { id: 'target' }, Date.now() + READ_DEADLINE_MS);
          if (outcome.status !== 'READ') throw new Error('not read');
          expect(outcome.value).toEqual({ id: 'target' });
          const reference = outcome.elements[0];
          if (reference === undefined) throw new Error('no reference');
          expect(await readElementInIsolatedWorld(page, reference.backendNodeId, readIdAndConnected, null, Date.now() + READ_DEADLINE_MS))
            .toEqual({ status: 'READ', value: { id: 'target', connected: true } });
          expect(await backendNodeIdsAtPaths(page, [reference.path ?? []], Date.now() + READ_DEADLINE_MS)).toEqual([reference.backendNodeId]);
          expect(await readPageHits(page)).toBe(before);
          // 操作に使う handle も、同じ要素を指す（Playwright の utility world の部品で id を読む）。handle を得る所では、Playwright の main world の部品が組み込みを呼びうるので（`bind` の偽りなど）、ページの JS の回数は読み取りの間だけを数える。
          const handle = await elementHandleOf(page, reference, Date.now() + READ_DEADLINE_MS);
          expect(await handle?.getAttribute('id')).toBe('target');
          await handle?.dispose();
          // 偽りの script が入っていたことの確かめ。
          expect(await pageForgeryInstalled(page)).toBe(true);
        } finally { await page.close(); }
      },
    );
  });
});
