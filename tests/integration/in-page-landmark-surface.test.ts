// CC-128・CC-129（2026-11-06）: ページの中の部品 `isLayoutLandmark`（枠の landmark の ARIA の決まり）と `ownSurfaceFactsOf`（要素が描く面の事実）。
// - `isLayoutLandmark`: 明示の `role` があれば `role` だけで決める。`header`・`footer` は区分の要素の中では landmark にしない。`nav` はいつも landmark。
// - `ownSurfaceFactsOf`: 計算値と、自分の文字・疑似要素の内容があるかを読む（`replacedContent` は呼ぶ側が足す）。判定は `paintsOwnSurfaceOf`。
// - main world（`page.evaluate`）と isolated world（`readInIsolatedWorld`）で、同じ値を読む。
// Chromium は headless の 1 つだけ。ページは `setContent` で作る（サーバを使わない）。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeInPage, type StandardReaders } from '../../src/browser/in-page-readers.js';
import { paintsOwnSurfaceOf } from '../../src/core/own-surface.js';
import { readInIsolatedWorld } from '../../src/discovery/isolated-read.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';

const ISOLATED_READ_DEADLINE_MS = 5_000;

const LANDMARK_HTML = [
  '<header id="top-header">a</header>',
  '<section><header id="section-header">b</header><header id="section-banner" role="banner">c</header></section>',
  '<article><footer id="article-footer">d</footer></article>',
  '<div role="region"><footer id="region-footer">e</footer></div>',
  '<footer id="top-footer">f</footer>',
  '<section><nav id="section-nav">g</nav></section>',
  '<div id="role-navigation" role=" Navigation ">h</div>',
  '<header id="role-none" role="none">i</header>',
  '<div id="plain">j</div>',
  '<aside id="aside">k</aside>',
].join('');

/** 枠の landmark（操作さがしの共通の枠の目印と、通知の枠の見分けで使う一覧と同じ形）。 */
const LANDMARK_INPUT = {
  names: ['nav', 'header', 'footer'],
  roles: ['navigation', 'banner', 'contentinfo'],
  scopedNames: ['header', 'footer'],
  sectioningScopeSelector: 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]',
} as const;

const EXPECTED_LANDMARKS: Readonly<Record<string, boolean>> = {
  'top-header': true,
  'section-header': false,
  'section-banner': true,
  'article-footer': false,
  'region-footer': false,
  'top-footer': true,
  'section-nav': true,
  'role-navigation': true,
  'role-none': false,
  plain: false,
  aside: false,
  detached: true,
};

interface LandmarkInput {
  readonly names: readonly string[];
  readonly roles: readonly string[];
  readonly scopedNames: readonly string[];
  readonly sectioningScopeSelector: string;
}

const readLandmarks = composeInPage((R: StandardReaders, input: LandmarkInput): Record<string, boolean> => {
  const result: Record<string, boolean> = {};
  const all = Document.prototype.querySelectorAll.call(document, '[id]');
  for (let index = 0; index < all.length; index += 1) {
    const element = all.item(index);
    result[element.id] = R.isLayoutLandmark(element, input.names, input.roles, input.scopedNames, input.sectioningScopeSelector);
  }
  // 文書の外の header（親がない）は、区分の中にないので landmark。
  result['detached'] = R.isLayoutLandmark(document.createElement('header'), input.names, input.roles, input.scopedNames, input.sectioningScopeSelector);
  return result;
});

const SURFACE_HTML = [
  '<style>',
  '#painted { background-color: rgb(1, 2, 3); border: 2px solid rgb(4, 5, 6); box-shadow: rgb(0, 0, 0) 1px 1px 1px 0px; outline: 1px dotted rgb(7, 8, 9); }',
  '#pseudo::before { content: "x"; }',
  '</style>',
  '<div id="painted"><span>child</span></div>',
  '<div id="bare"><span>child</span></div>',
  '<div id="text">own text</div>',
  '<div id="pseudo"></div>',
  '<div id="many"></div>',
].join('');

interface SurfaceInput {
  readonly maxOwnTextNodeScan: number;
}

const readSurfaces = composeInPage((R: StandardReaders, input: SurfaceInput): Record<string, unknown> => {
  const many = Document.prototype.getElementById.call(document, 'many');
  if (many !== null && many.childNodes.length === 0) {
    for (let index = 0; index < input.maxOwnTextNodeScan + 1; index += 1) many.appendChild(document.createElement('span'));
  }
  const result: Record<string, unknown> = {};
  for (const id of ['painted', 'bare', 'text', 'pseudo', 'many']) {
    const element = Document.prototype.getElementById.call(document, id);
    if (element !== null) result[id] = R.ownSurfaceFactsOf(element, window.getComputedStyle(element), input.maxOwnTextNodeScan);
  }
  return result;
});

const SURFACE_INPUT: SurfaceInput = { maxOwnTextNodeScan: 4 };

describe('CC-128・CC-129: the shared in-page parts for layout landmarks and own surface facts', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchHeadlessChromium();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  it('reads layout landmarks by the ARIA rules in the main world and the isolated world', async () => {
    await page.setContent(`<!doctype html><html><body>${LANDMARK_HTML}</body></html>`);
    expect(await page.evaluate(readLandmarks, LANDMARK_INPUT)).toEqual(EXPECTED_LANDMARKS);
    const isolated = await readInIsolatedWorld(page, readLandmarks, LANDMARK_INPUT, Date.now() + ISOLATED_READ_DEADLINE_MS);
    expect(isolated).toEqual({ status: 'READ', value: EXPECTED_LANDMARKS });
  });

  it('reads own surface facts that paintsOwnSurfaceOf decides on, the same in both worlds', async () => {
    await page.setContent(`<!doctype html><html><body>${SURFACE_HTML}</body></html>`);
    const main = await page.evaluate(readSurfaces, SURFACE_INPUT) as Record<string, Record<string, unknown>>;
    expect(main['painted']).toEqual({
      backgroundColor: 'rgb(1, 2, 3)',
      backgroundImage: 'none',
      borderWidths: ['2px', '2px', '2px', '2px'],
      borderStyles: ['solid', 'solid', 'solid', 'solid'],
      borderColors: ['rgb(4, 5, 6)', 'rgb(4, 5, 6)', 'rgb(4, 5, 6)', 'rgb(4, 5, 6)'],
      outlineWidth: '1px',
      outlineStyle: 'dotted',
      outlineColor: 'rgb(7, 8, 9)',
      boxShadow: 'rgb(0, 0, 0) 1px 1px 1px 0px',
      backdropFilter: 'none',
      hasOwnText: false,
      hasPseudoContent: false,
    });
    expect(main['bare']).toMatchObject({ backgroundColor: 'rgba(0, 0, 0, 0)', hasOwnText: false, hasPseudoContent: false });
    expect(main['text']).toMatchObject({ hasOwnText: true, hasPseudoContent: false });
    expect(main['pseudo']).toMatchObject({ hasOwnText: false, hasPseudoContent: true });
    // 子のノードが上限を超えたら、自分の文字があるものとして扱う。
    expect(main['many']).toMatchObject({ hasOwnText: true });
    const decided = Object.fromEntries(Object.entries(main).map(([id, facts]) => [
      id, paintsOwnSurfaceOf({ ...(facts as unknown as Parameters<typeof paintsOwnSurfaceOf>[0]), replacedContent: false }),
    ]));
    expect(decided).toEqual({ painted: true, bare: false, text: true, pseudo: true, many: true });
    const isolated = await readInIsolatedWorld(page, readSurfaces, SURFACE_INPUT, Date.now() + ISOLATED_READ_DEADLINE_MS);
    expect(isolated).toEqual({ status: 'READ', value: main });
  });
});
