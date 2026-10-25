// DEF-072・DEF-073: form の中の名前つきの入力の欄が form の標準のプロパティを隠すページ（DEF-072）と、名前つきの img と form が `document` の
// 標準のプロパティを隠すページ（DEF-073）で、ブラウザの中で読む部品（DOM・色・レイアウトの Evidence、Interaction の候補、ページの落ち着きの待ち、
// スクロールの位置と controlled scroll（内側のスクロール領域の探索を含む）、ログインのフォームの確かめ）が、上書きのない同じ構造のページ
// （名前だけを無害なものに変えた対照）と同じ結果を返すことを確かめる。link の抽出（`discoverLinks` の `document.baseURI`）も確かめる。
// fixture は `fixtures/site/dom-clobbered-collectors.html` と、その対照の `dom-clobbered-collectors-control.html`。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。サーバは 127.0.0.1 の fixture のサーバだけ。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { controlledScroll, readDocumentScrollPosition, scrollDocumentToOrigin } from '../../src/browser/controlled-scroll.js';
import { inspectLoginForm } from '../../src/browser/login-form-submitter.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import type { DomEvidence, ScrollEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { discoverLinks } from '../../src/crawl/discover-links.js';
import { collectColorEvidence } from '../../src/evidence/color-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

const CLOBBERED_PATH = '/dom-clobbered-collectors.html';
const CONTROL_PATH = '/dom-clobbered-collectors-control.html';
/**
 * link の抽出の fixture と、その対照。`document.baseURI` だけを、名前つきの img で隠す。Playwright の `locator.evaluateAll` は、
 * ページの `document.querySelectorAll` を使うので、上の fixture（`querySelectorAll` も隠す）とは分ける。
 */
const LINKS_PATH = '/dom-clobbered-links.html';
const LINKS_CONTROL_PATH = '/dom-clobbered-links-control.html';
/** link の抽出の fixture で、`document.querySelectorAll` だけを名前つきの img で隠すもの（DEF-074。対照は `LINKS_CONTROL_PATH`）。 */
const LINK_QUERY_PATH = '/dom-clobbered-link-query.html';
/** 対照のページの、名前の前に付けた無害な文字列。 */
const CONTROL_NAME_PREFIX = 'control-';
/** fixture の 3 つの form（スクロールする form、切り取る form、大きさ 0 の form）の中の、hidden の入力の欄の名前。 */
const FORM_PROPERTY_NAMES = [
  'id', 'tagName', 'nodeType', 'childNodes', 'children', 'parentElement', 'parentNode', 'previousElementSibling', 'shadowRoot',
  'assignedSlot', 'getAttribute', 'hasAttribute', 'matches', 'closest', 'contains', 'checkVisibility', 'getBoundingClientRect',
  'getClientRects', 'clientLeft', 'clientTop', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollLeft', 'scrollTop',
  'innerText', 'hidden', 'attributes', 'isConnected', 'elements', 'method', 'action', 'target', 'enctype',
] as const;
/** fixture の、`document` の標準のプロパティを隠す、名前つきの img と form の名前。 */
const DOCUMENT_PROPERTY_NAMES = [
  'forms', 'body', 'documentElement', 'scrollingElement', 'querySelector', 'querySelectorAll', 'createTreeWalker',
  'title', 'images', 'getElementById', 'createRange', 'readyState',
] as const;
const CLOBBERED_FORM_LABELS = ['Scrolling form', 'Clipping form', 'Zero size form'] as const;

const LAYOUT_DEADLINE_MS = 10_000;
const SETTLING_POLICY = Object.freeze({ deadlineMs: 2_000, pollIntervalMs: 20, stableWindowMs: 60 });
const SCROLL_POLICY = Object.freeze({ deadlineMs: 5_000, stepViewportFraction: 0.75, stepWaitMs: 25, stableWindowMs: 100 });
const LOGIN_ACTION_PATH = '/login';
/** fixture の link が使う query の引数で、巡回の URL に残すもの。 */
const ALLOWED_LINK_QUERY_PARAMETERS: ReadonlySet<string> = new Set(['page']);
/**
 * fixture の link の、解決した URL の path と query（抽出の順）。順は、Playwright の `locator('a[href]')` と同じ（文書の light DOM の
 * link を文書の順に並べ、その後に、open な shadow root の中の link を、host の文書の順に、入れ子の shadow root を含めて並べる）。
 */
const EXPECTED_LINK_PATHS = [
  '/crawl/next-page?page=2', '/relative-page', '/after-shadow-host', '/shadow-page', '/nested-shadow-page',
] as const;
/** `EXPECTED_LINK_PATHS` のうち、文書の light DOM の link（shadow root の中でないもの。文書の順）。 */
const LIGHT_DOM_LINK_PATHS = ['/crawl/next-page?page=2', '/relative-page', '/after-shadow-host'] as const;

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

/** 対照のページの入力の欄の名前から、前に付けた文字列を外す（それ以外の値は、両方のページで同じになる）。 */
function withoutControlPrefix(name: string): string {
  return name.startsWith(CONTROL_NAME_PREFIX) ? name.slice(CONTROL_NAME_PREFIX.length) : name;
}

function comparableDomEvidence(evidence: DomEvidence): unknown {
  const fields = (list: DomEvidence['unassociatedFields']): unknown => list.map((field) => ({ ...field, name: withoutControlPrefix(field.name) }));
  return {
    ...evidence,
    pageId: null,
    forms: evidence.forms.map((form) => ({ ...form, fields: fields(form.fields) })),
    unassociatedFields: fields(evidence.unassociatedFields),
  };
}

/** controlled scroll の結果のうち、時刻（`observedAtMs`）と測定の回数に左右されない部分。 */
function comparableScroll(result: ScrollEvidence): unknown {
  const { observedAtMs: _observedAtMs, ...finalSnapshot } = result.finalSnapshot ?? { observedAtMs: 0 };
  return {
    status: result.status,
    reason: result.reason,
    targetSwitchCount: result.targetSwitchCount,
    restoration: result.restoration.status,
    innerScrollScan: result.innerScrollScan,
    finalSnapshot,
  };
}

describe.each(LAUNCHERS)('DEF-072 and DEF-073: collectors on clobbered forms and documents (%s)', (_name, launch) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  /** 対照のページと上書きのあるページのそれぞれで `collect` を呼び、結果を返す。 */
  const collectOnBoth = async <T>(
    collect: (page: Page) => Promise<T>,
    paths: readonly [control: string, clobbered: string] = [CONTROL_PATH, CLOBBERED_PATH],
  ): Promise<{ readonly control: T; readonly clobbered: T }> => {
    const results: T[] = [];
    for (const path of paths) {
      const page = await browser.newPage();
      try {
        await page.goto(`${server.origin}${path}`);
        results.push(await collect(page));
      } finally {
        await page.close();
      }
    }
    const [control, clobbered] = results as [T, T];
    return { control, clobbered };
  };

  it('clobbers the standard properties of the forms and the document only on the clobbered page', async () => {
    const probe = (page: Page): Promise<{ readonly forms: readonly boolean[]; readonly document: readonly boolean[] }> => page.evaluate(
      ({ labels, formNames, documentNames }) => {
        const forms = Element.prototype.querySelectorAll.call(Document.prototype.querySelector.call(document, 'main') as Element, 'form');
        const labelled = [...forms].filter((form) => labels.includes(Element.prototype.getAttribute.call(form, 'aria-label') ?? ''));
        return {
          forms: labelled.flatMap((form) => formNames.map((name) => (form as unknown as Record<string, unknown>)[name] instanceof HTMLInputElement)),
          document: documentNames.map((name) => {
            const value = (document as unknown as Record<string, unknown>)[name];
            return value instanceof HTMLImageElement || value instanceof HTMLFormElement;
          }),
        };
      },
      { labels: [...CLOBBERED_FORM_LABELS] as string[], formNames: [...FORM_PROPERTY_NAMES], documentNames: [...DOCUMENT_PROPERTY_NAMES] },
    );
    const { control, clobbered } = await collectOnBoth(probe);
    const formCount = CLOBBERED_FORM_LABELS.length * FORM_PROPERTY_NAMES.length;
    expect(clobbered).toEqual({ forms: Array.from({ length: formCount }, () => true), document: DOCUMENT_PROPERTY_NAMES.map(() => true) });
    expect(control).toEqual({ forms: Array.from({ length: formCount }, () => false), document: DOCUMENT_PROPERTY_NAMES.map(() => false) });
  });

  it('collects the same DOM Evidence as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth(async (page) => comparableDomEvidence(await collectDomEvidence(page, createPageId(1))));
    expect(clobbered).toEqual(control);
  });

  it('discovers the same interaction candidates as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth((page) => discoverInteractionCandidates(page));
    expect(control.candidates.map(({ accessibleName }) => accessibleName)).toContain('Zero size form');
    expect(clobbered).toEqual(control);
  });

  it('collects the same color Evidence as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth((page) => collectColorEvidence(page));
    expect(control.textSamples.length).toBeGreaterThan(0);
    expect(clobbered).toEqual(control);
  });

  it('collects the same layout Evidence as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth((page) => {
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('Expected a viewport');
      return collectLayoutEvidence(page, viewport, { deadlineAtMs: Date.now() + LAYOUT_DEADLINE_MS });
    });
    expect(control.status).toBe('COMPLETE');
    expect(control.layout?.clippedText.length).toBeGreaterThan(0);
    expect(control.layout?.zeroSizeInteractive.length).toBeGreaterThan(0);
    expect(clobbered).toEqual(control);
  });

  it('waits for the page to settle and reads the document scroll position as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth(async (page) => {
      const settling = await waitForPageSettled(page, {
        deadlineAtMs: Date.now() + SETTLING_POLICY.deadlineMs,
        pollIntervalMs: SETTLING_POLICY.pollIntervalMs,
        stableWindowMs: SETTLING_POLICY.stableWindowMs,
      });
      const lastObservation = settling.observations.at(-1);
      return {
        settling: settling.status,
        readyState: lastObservation?.readyState,
        scrollHeight: lastObservation?.scrollHeight,
        position: await readDocumentScrollPosition(page),
        origin: await scrollDocumentToOrigin(page),
      };
    });
    expect(control).toMatchObject({ settling: 'SETTLED', readyState: 'complete' });
    expect(clobbered).toEqual(control);
  });

  it('scrolls the document and finds the scrolling form as an inner scroll container as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth(async (page) => comparableScroll(await controlledScroll(page, {
      deadlineAtMs: Date.now() + SCROLL_POLICY.deadlineMs,
      stepViewportFraction: SCROLL_POLICY.stepViewportFraction,
      stepWaitMs: SCROLL_POLICY.stepWaitMs,
      stableWindowMs: SCROLL_POLICY.stableWindowMs,
    })));
    expect(control).toMatchObject({ status: 'COMPLETE', innerScrollScan: { containerCount: 1 } });
    expect(clobbered).toEqual(control);
  });

  it('discovers the same links, resolved against the document base URL, as on the control page', async () => {
    const baseUriClobbered = await collectOnBoth((page) => page.evaluate(
      () => (document as unknown as Record<string, unknown>)['baseURI'] instanceof HTMLImageElement,
    ), [LINKS_CONTROL_PATH, LINKS_PATH]);
    expect(baseUriClobbered).toEqual({ control: false, clobbered: true });
    const { control, clobbered } = await collectOnBoth((page) => discoverLinks(page, createPageId(1), {
      allowedOrigins: new Set([server.origin]),
      allowedQueryParameters: ALLOWED_LINK_QUERY_PARAMETERS,
    }), [LINKS_CONTROL_PATH, LINKS_PATH]);
    expect(control.links.map(({ normalized }) => normalized)).toEqual(
      EXPECTED_LINK_PATHS.map((path) => ({ ok: true, url: `${server.origin}${path}` })),
    );
    expect(clobbered).toEqual(control);
  });

  it('discovers the same links as on the control page when the page hides document.querySelectorAll', async () => {
    const queryClobbered = await collectOnBoth((page) => page.evaluate(
      () => (document as unknown as Record<string, unknown>)['querySelectorAll'] instanceof HTMLImageElement,
    ), [LINKS_CONTROL_PATH, LINK_QUERY_PATH]);
    expect(queryClobbered).toEqual({ control: false, clobbered: true });
    const { control, clobbered } = await collectOnBoth((page) => discoverLinks(page, createPageId(1), {
      allowedOrigins: new Set([server.origin]),
      allowedQueryParameters: ALLOWED_LINK_QUERY_PARAMETERS,
    }), [LINKS_CONTROL_PATH, LINK_QUERY_PATH]);
    expect(control.links.map(({ normalized }) => normalized)).toEqual(
      EXPECTED_LINK_PATHS.map((path) => ({ ok: true, url: `${server.origin}${path}` })),
    );
    expect(clobbered).toEqual(control);
  });

  it('discovers the links of the document, skipping the shadow roots, when the page deletes the shadowRoot getter (PRE42-CC 5b, CC-099)', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.origin}${LINKS_CONTROL_PATH}`);
      const deleted = await page.evaluate(() => {
        Reflect.deleteProperty(Element.prototype, 'shadowRoot');
        return Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot') === undefined;
      });
      expect(deleted).toBe(true);
      const found = await discoverLinks(page, createPageId(1), {
        allowedOrigins: new Set([server.origin]),
        allowedQueryParameters: ALLOWED_LINK_QUERY_PARAMETERS,
      });
      // 前の振る舞いのまま: 例外にせず、文書（light DOM）の link を文書の順に拾い、shadow root の中は飛ばす。
      expect(found.links.map(({ normalized }) => normalized)).toEqual(
        LIGHT_DOM_LINK_PATHS.map((path) => ({ ok: true, url: `${server.origin}${path}` })),
      );
      expect(found.omittedLinkCount).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('inspects the login form as on the control page', async () => {
    const { control, clobbered } = await collectOnBoth((page) => inspectLoginForm({
      username: page.locator('#login-username'),
      password: page.locator('#login-password'),
      submit: page.locator('#login-submit'),
      // T32j-4: 事前の確かめは、同じセレクタで isolated world の中で探し直す。
      selectors: { username: '#login-username', password: '#login-password', submit: '#login-submit' },
      isAllowedAction: (actionUrl) => actionUrl === `${server.origin}${LOGIN_ACTION_PATH}`,
    }));
    expect(control).toEqual({ ok: true });
    expect(clobbered).toEqual(control);
  });
});
