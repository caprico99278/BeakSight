import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { LAYOUT_RULES } from '../../src/audit/layout-rules.js';
import type { FindingDraft } from '../../src/audit/rule.js';
import type { Viewport } from '../../src/config/types.js';
import type { EvidenceRecord } from '../../src/core/contracts.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import {
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type LayoutCollectionResult,
  type LayoutEvidence,
  type NormalizedHttpUrlEvidence,
} from '../../src/core/evidence-types.js';
import { LAYOUT_COLLECTION_PART_SIZE, LAYOUT_THRESHOLDS, collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let context: BrowserContext | undefined;
let factory: BrowserContextFactory | undefined;
let page: Page | undefined;
let server: FixtureServer | undefined;

/** fixture のページを開く、既定のビューポート。 */
const DEFAULT_FIXTURE_VIEWPORT: Viewport = Object.freeze({ width: 400, height: 300 });

/** COV-6 の前の、候補 1 つの中で走査したテキストのノードと子孫の要素の数の上限（いまは打ち切らない）。前の上限を超える形を作るために使う。 */
const FORMER_NODE_SCAN_LIMIT = 256;

/**
 * fixture のサーバの `pathname` を、Guard の付いた Passive の page で開いて `run` に渡す。
 * 終わったら（失敗しても）、page と Context を閉じる（`withGuardedPassivePage`）。
 */
async function withFixture(pathname: string, viewport: Viewport, run: (page: Page) => Promise<void>): Promise<void> {
  server ??= await startFixtureServer();
  const fixtureServer = server;
  const fixtureFactory = new BrowserContextFactory(
    browser,
    createTestConfig(fixtureServer.origin, '/overflow.html'),
    () => new SafetyLedger(),
  );
  await withGuardedPassivePage(fixtureFactory, viewport, async (fixturePage) => {
    await fixturePage.goto(`${fixtureServer.origin}/${pathname}`, { waitUntil: 'load' });
    await run(fixturePage);
  });
}

/**
 * 1つのテストで、fixture のページを順に開き直す場合に使う（開いた page と Context は、`closePassiveResources` で閉じる）。
 * 1つの page だけを使うテストは、`withFixture` を使う。
 */
async function openFixture(pathname: string, viewport: Viewport = DEFAULT_FIXTURE_VIEWPORT): Promise<Page> {
  server ??= await startFixtureServer();
  factory = new BrowserContextFactory(browser, createTestConfig(server.origin, '/overflow.html'), () => new SafetyLedger());
  context = await factory.createPassiveContext(viewport);
  page = await factory.createPassivePage(context);
  await page.goto(`${server.origin}/${pathname}`, { waitUntil: 'load' });
  return page;
}

function completeLayout(result: LayoutCollectionResult): LayoutEvidence {
  expect(result.status).toBe('COMPLETE');
  if (result.status !== 'COMPLETE') {
    throw new Error('layout collection was not complete');
  }
  return result.layout;
}

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await closePassiveResources({ factory, context, page });
  await server?.close();
  page = undefined;
  context = undefined;
  factory = undefined;
  server = undefined;
});

describe('layout evidence', () => {
  it('uses ancestor-aware visual visibility while retaining visually present aria-hidden geometry', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.boxesOutsideViewport.some((candidate) => candidate.selector === '#ancestor-hidden-outside')).toBe(
        false,
      );
      expect(evidence.boxesOutsideViewport).toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: '#aria-visual-outside',
          visibility: expect.objectContaining({ visible: true, ariaHidden: true }),
        }),
      ]));
    });
  });

  it('rejects a caller viewport that differs from the actual browser viewport', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      await expect(collectLayoutEvidence(fixturePage, { width: 401, height: 300 })).rejects.toThrow(
        'does not match actual browser viewport',
      );
    });
  });

  it('lists late horizontal and fixed offscreen candidates, and not the ordinary vertical flow (REC-1)', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const selectors = evidence.boxesOutsideViewport.map((candidate) => candidate.selector);

      expect(selectors).toContain('#priority-horizontal');
      expect(selectors).toContain('#priority-fixed-offscreen');
      // REC-1: 縦だけにはみ出す要素（画面の下に続く要素）は、読む Rule がないので一覧に入れない。
      expect(evidence.boxesOutsideViewport.filter((box) => !box.outside.left && !box.outside.right)).toEqual([]);
      // COV-6: 件数の上限で打ち切らない。
      expect(evidence.truncation.omittedOutsideViewportCount).toBe(0);
    });
  });

  it('excludes fixed-heading identity, containment, and wholly offscreen overlap pairs', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const pairs = evidence.fixedHeadingOverlaps.map((candidate) => (
        `${candidate.overlaySelector}->${candidate.headingSelector}`
      ));

      expect(pairs).not.toContain('#self-fixed-heading->#self-fixed-heading');
      expect(pairs).not.toContain('#fixed-containing->#contained-heading');
      expect(pairs).not.toContain('#contained-fixed->#heading-containing');
      expect(pairs).not.toContain('#offscreen-fixed->#offscreen-heading');
    });
  });

  it('preserves bounded overflow, outside-box, zero-size, and fixed-heading overlap facts', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.document.horizontalOverflowPx).toBeGreaterThan(0);
      expect(evidence.boxesOutsideViewport).toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: '#outside',
          position: 'absolute',
          zIndex: 'auto',
          overflowX: 'visible',
          overflowY: 'visible',
          outside: expect.objectContaining({ right: true }),
        }),
      ]));
      expect(evidence.zeroSizeInteractive).toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: '#zero-action',
          position: 'absolute',
          zIndex: 'auto',
          overflowX: 'hidden',
          overflowY: 'hidden',
          rect: expect.objectContaining({ width: 0, height: 0 }),
        }),
      ]));
      expect(evidence.document).toEqual(expect.objectContaining({
        bodyClientWidth: expect.any(Number),
        bodyClientHeight: expect.any(Number),
      }));
      expect(evidence.fixedHeadingOverlaps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          overlaySelector: '#fixed-banner',
          headingSelector: '#covered-heading',
          overlayPosition: 'fixed',
          overlayOverflowX: 'visible',
          overlayOverflowY: 'visible',
          headingOverflowX: 'visible',
          headingOverflowY: 'visible',
          intersection: expect.objectContaining({ area: expect.any(Number) }),
        }),
      ]));
      const overlap = evidence.fixedHeadingOverlaps.find((candidate) => (
        candidate.overlaySelector === '#fixed-banner' && candidate.headingSelector === '#covered-heading'
      ));
      expect(overlap?.intersection.area).toBeGreaterThanOrEqual(LAYOUT_THRESHOLDS.minOcclusionAreaPx2);
      expect(evidence.truncation.omittedOutsideViewportCount).toBe(0);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.fixedHeadingOverlaps[0]?.intersection)).toBe(true);
      expect(JSON.stringify(evidence)).not.toMatch(/finding|fingerprint|evidenceId/i);
    });
  });

  it('records the collection scroll position and collects at the origin after controlled scroll', async () => {
    // レビュー V3 の再現条件: 固定ヘッダと見出しの重なりは、先頭では0件、scrollY=1050 では2件。
    const viewport = { width: 800, height: 600 };
    await withFixture('fixed-header-scroll.html', viewport, async (fixturePage) => {
      await fixturePage.evaluate(() => window.scrollTo(0, 1050));

      const scrolled = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      expect(scrolled.scrollPosition).toEqual({ scrollX: 0, scrollY: 1050 });
      expect(scrolled.fixedHeadingOverlaps.map((candidate) => candidate.headingSelector).sort()).toEqual([
        '#lower-heading-1',
        '#lower-heading-2',
      ]);

      const scroll = await controlledScroll(fixturePage, {
        deadlineAtMs: Date.now() + 5_000,
        stepViewportFraction: 0.75,
        stepWaitMs: 25,
        stableWindowMs: 100,
      });
      const initial = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      expect(scroll.status).toBe('COMPLETE');
      expect(initial.scrollPosition).toEqual({ scrollX: 0, scrollY: 0 });
      expect(initial.fixedHeadingOverlaps).toEqual([]);
      expect(Object.isFrozen(initial.scrollPosition)).toBe(true);
    });
  });

  it('records the offset of a scrolling body as the document scroll position', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('body-scroll.html', viewport, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        document.body.scrollTop = 500;
      });

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      expect(evidence.scrollPosition).toEqual({ scrollX: 0, scrollY: 500 });
    });
  });

  it('treats a visibility:visible child of a visibility:hidden ancestor as visible (V7 B)', async () => {
    // レビュー V7 (B) の再現条件: 祖先が visibility:hidden で子が visible の場合に、layout の標本が0件になっていた。
    await withFixture('visibility-override.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const selectors = evidence.boxesOutsideViewport.map((candidate) => candidate.selector);

      expect(selectors).toContain('#override-visible-outside');
      expect(selectors).not.toContain('#inherited-hidden-outside');
      expect(selectors).not.toContain('#hidden-parent');
    });
  });

  it('treats every element of a transparent body as not visible (V7 A)', async () => {
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        document.body.style.opacity = '0';
      });

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.boxesOutsideViewport).toEqual([]);
      expect(evidence.zeroSizeInteractive).toEqual([]);
      expect(evidence.fixedHeadingOverlaps).toEqual([]);
    });
  });

  it('preserves visible clipped-text preconditions and bounded text', async () => {
    await withFixture('clipped-text.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.clippedText).toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: '#clipped',
          overflowX: 'hidden',
          position: 'static',
          zIndex: 'auto',
          widthClipped: true,
          text: expect.stringContaining('deliberately long'),
        }),
      ]));
    });
  });

  // LZ-3b: 前の見切れのテキストの上限（256）より長いテキストも、切り詰めずに記録する。
  it('records clipped text longer than the former length limit without truncating it', async () => {
    const text = `Clipped ${'x'.repeat(256)}`;
    await withFixture('overflow.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      await fixturePage.evaluate((value) => {
        const clipped = document.createElement('div');
        clipped.textContent = value;
        clipped.style.cssText = 'width:40px;height:20px;overflow:hidden;white-space:nowrap;';
        document.body.prepend(clipped);
      }, text);

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, DEFAULT_FIXTURE_VIEWPORT));

      expect(layout.clippedText.find((candidate) => candidate.text.startsWith('Clipped '))).toMatchObject({ text, truncated: false });
    });
  });
});

describe('element overlap evidence (V5)', () => {
  it('records bounded overlap candidates between visible primary elements with their layout facts', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));
      const pairs = layout.elementOverlaps.map((overlap) => (
        [overlap.first.selector, overlap.second.selector].sort().join('|')
      ));

      expect(pairs.sort()).toEqual([
        '#colliding-heading|#colliding-paragraph',
        '#consent-banner|#under-banner-link',
        '#far-heading|#far-paragraph',
        '#overlapped-button|#overlapping-image',
      ]);
      const collision = layout.elementOverlaps.find((overlap) => (
        [overlap.first.selector, overlap.second.selector].includes('#colliding-paragraph')
      ));
      const paragraph = collision?.first.selector === '#colliding-paragraph' ? collision.first : collision?.second;
      const heading = collision?.first.selector === '#colliding-heading' ? collision.first : collision?.second;
      expect(paragraph).toMatchObject({
        kind: 'paragraph',
        position: 'absolute',
        zIndex: '2',
        overflowX: 'hidden',
        overflowY: 'hidden',
        fixedOrStickyAncestor: false,
        area: 300 * 40,
        visibility: expect.objectContaining({ visible: true, visibility: 'visible' }),
      });
      expect(heading).toMatchObject({ kind: 'heading', zIndex: 'auto', overflowX: 'visible' });
      expect(collision?.intersection).toMatchObject({ width: 280, height: 20, area: 280 * 20 });

      const imageButton = layout.elementOverlaps.find((overlap) => (
        [overlap.first.selector, overlap.second.selector].includes('#overlapping-image')
      ));
      expect([imageButton?.first.kind, imageButton?.second.kind].sort()).toEqual(['button', 'image']);

      const banner = layout.elementOverlaps.find((overlap) => (
        [overlap.first.selector, overlap.second.selector].includes('#consent-banner')
      ));
      const bannerFacts = banner?.first.selector === '#consent-banner' ? banner.first : banner?.second;
      const linkFacts = banner?.first.selector === '#under-banner-link' ? banner.first : banner?.second;
      expect(bannerFacts).toMatchObject({ kind: 'other', position: 'fixed', zIndex: '50' });
      expect(linkFacts).toMatchObject({ kind: 'link', position: 'absolute' });

      expect(layout.fixedElements).toEqual([
        expect.objectContaining({
          selector: '#consent-banner',
          position: 'fixed',
          zIndex: '50',
          area: 800 * 300,
          viewportIntersectionArea: 800 * 300,
          viewportArea: 800 * 600,
          viewportAreaRatio: 0.5,
        }),
      ]);
      expect(layout.truncation).toMatchObject({
        omittedElementOverlapCount: 0,
        omittedFixedElementCount: 0,
        overlapComparisonLimitReached: false,
      });
      expect(Object.isFrozen(layout.elementOverlaps[0]?.first)).toBe(true);
      expect(Object.isFrozen(layout.fixedElements[0])).toBe(true);
      expect(JSON.stringify(layout)).not.toMatch(/finding|fingerprint|evidenceId/i);
    });
  });

  it('excludes elements whose area is clipped away by an ancestor overflow (R4 M3)', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        // 高さ0で overflow:hidden の要素の中の見出しは、見える面積が0なので重なりの候補にしない。
        const collapsed = document.createElement('div');
        collapsed.id = 'collapsed-panel';
        collapsed.style.cssText = 'position:absolute;left:600px;top:400px;width:180px;height:0;overflow:hidden;';
        collapsed.innerHTML = '<h4 id="clipped-heading" style="margin:0;height:40px;">Clipped heading</h4>';
        // 切り取られていない見出しは、比べるための対照として候補に残る。
        const shown = document.createElement('div');
        shown.id = 'shown-panel';
        shown.style.cssText = 'position:absolute;left:600px;top:500px;width:180px;height:60px;overflow:hidden;';
        shown.innerHTML = '<h4 id="shown-heading" style="margin:0;height:40px;">Shown heading</h4>';
        const overlay = (id: string, top: number): HTMLParagraphElement => {
          const paragraph = document.createElement('p');
          paragraph.id = id;
          paragraph.textContent = id;
          paragraph.style.cssText = `position:absolute;left:610px;top:${top}px;width:100px;height:30px;margin:0;`;
          return paragraph;
        };
        const main = document.querySelector('main') as HTMLElement;
        main.append(collapsed, shown, overlay('over-clipped', 400), overlay('over-shown', 500));
      });

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));
      const pairs = layout.elementOverlaps.map((overlap) => (
        [overlap.first.selector, overlap.second.selector].sort().join('|')
      ));

      expect(pairs).toContain('#over-shown|#shown-heading');
      expect(pairs.some((pair) => pair.includes('#clipped-heading'))).toBe(false);
    });
  });

  it('marks descendants of a fixed container', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        const link = document.createElement('a');
        link.id = 'banner-link';
        link.href = '#banner';
        link.textContent = 'Banner link';
        link.style.cssText = 'display:block;position:absolute;left:10px;top:60px;width:200px;height:30px;';
        document.querySelector('#consent-banner')?.append(link);
      });

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));
      const overlap = layout.elementOverlaps.find((candidate) => (
        [candidate.first.selector, candidate.second.selector].includes('#banner-link')
        && [candidate.first.selector, candidate.second.selector].includes('#under-banner-link')
      ));

      const bannerLink = overlap?.first.selector === '#banner-link' ? overlap.first : overlap?.second;
      expect(bannerLink).toMatchObject({ kind: 'link', position: 'absolute', fixedOrStickyAncestor: true });
      expect(layout.elementOverlaps.some((candidate) => (
        [candidate.first.selector, candidate.second.selector].sort().join('|') === '#banner-link|#consent-banner'
      ))).toBe(false);
    });
  });
});

describe('layout candidates collected in parts without a count limit (COV-6)', () => {
  it('collects every fixed element and overlap candidate beyond the former limit of 100, reading the overlaps in parts', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      const fixedCount = 120;
      await fixturePage.evaluate(({ fixedCount }) => {
        const container = document.createElement('div');
        for (let index = 0; index < fixedCount; index += 1) {
          const element = document.createElement('div');
          element.textContent = `Fixed ${index}`;
          element.style.cssText = `position:fixed;left:${index % 700}px;top:0;width:40px;height:20px;`;
          container.append(element);
        }
        document.body.append(container);
      }, { fixedCount });

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      // 追加した固定要素と、もとの #consent-banner の分。
      expect(layout.fixedElements).toHaveLength(fixedCount + 1);
      expect(layout.truncation).toMatchObject({ omittedFixedElementCount: 0, omittedElementOverlapCount: 0 });
      // 重なりの組は分け方の単位を超えるので、続きの位置から読み直して全部を集める。
      expect(layout.elementOverlaps.length).toBeGreaterThan(LAYOUT_COLLECTION_PART_SIZE);
      expect(layout.collectedInParts).toBe(Math.ceil(layout.elementOverlaps.length / LAYOUT_COLLECTION_PART_SIZE));
      expect(new Set(layout.elementOverlaps.map((overlap) => `${overlap.first.selector}|${overlap.second.selector}`)).size)
        .toBe(layout.elementOverlaps.length);
    });
  });

  it('compares every overlap pair beyond the former limit of 200,000 pairs, and finds a pair compared after it (COV-6)', async () => {
    // 比べる組だけを増やし、重なる組は増やさない（横に 2px ずつずらした幅 1px の段落。縦の範囲は重なるので、比べる組にはなる）。
    // その後ろ（上端の順で後）に、重なる 2 つの段落を置く。この組は、前の上限の組の数を超えた後で比べる。
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      const formerComparisonLimit = 200_000;
      const stackedCount = Math.ceil(Math.sqrt(formerComparisonLimit * 2)) + 10;
      await fixturePage.evaluate((count) => {
        const container = document.createElement('div');
        for (let index = 0; index < count; index += 1) {
          const paragraph = document.createElement('p');
          paragraph.textContent = `Stacked ${index}`;
          paragraph.style.cssText = `position:absolute;left:${index * 2}px;top:2000px;width:1px;height:20px;margin:0;overflow:hidden;`;
          container.append(paragraph);
        }
        for (const id of ['late-first', 'late-second']) {
          const paragraph = document.createElement('p');
          paragraph.id = id;
          paragraph.textContent = id;
          paragraph.style.cssText = 'position:absolute;left:4000px;top:2010px;width:100px;height:20px;margin:0;';
          container.append(paragraph);
        }
        document.body.append(container);
      }, stackedCount);

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      // 前は、比べる組の上限（200,000）で止めて PARTIAL にしていた。いまは上限を撤廃し、すべての組を比べて COMPLETE になる。
      expect(layout.truncation.overlapComparisonLimitReached).toBe(false);
      const pairs = layout.elementOverlaps.map((overlap) => [overlap.first.selector, overlap.second.selector].sort().join('|'));
      expect(pairs).toContain('#late-first|#late-second');
      expect(new Set(pairs).size).toBe(pairs.length);
    });
  });
});

/** layout の Evidence から、1つの layout の Rule の Finding の下書きを作り、その selector の一覧を返す。 */
function layoutRuleSelectors(ruleId: string, layout: LayoutEvidence): readonly (string | undefined)[] {
  return layoutRuleDrafts(ruleId, layout)
    .map((draft) => draft.identityFields.find((field) => field.name === 'selector')?.value);
}

/** layout の Evidence から、1つの layout の Rule の Finding の下書きを作る。 */
function layoutRuleDrafts(ruleId: string, layout: LayoutEvidence): readonly FindingDraft[] {
  const rule = LAYOUT_RULES.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`${ruleId} is not registered`);
  }
  const record: EvidenceRecord = {
    evidenceId: createEvidenceId('layout', 1),
    type: 'layout',
    pageId: createPageId(1),
    viewport: 'desktop',
    observedAt: '2026-09-24T00:00:00.000Z',
    payload: { primary: { status: 'COMPLETE', layout }, stressSweep: null },
  };
  return rule.evaluate({
    pageId: createPageId(1),
    pageUrl: 'http://127.0.0.1/layout-rule-cases' as NormalizedHttpUrlEvidence,
    viewport: 'desktop',
    evidence: [record],
  });
}

describe('layout evidence that avoids false positives (RT12 I1, I2, I3)', () => {
  it('records the nearest horizontal clipping ancestor, the element kind, and the nearest listed ancestor (I1)', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.boxesOutsideViewport.find((box) => box.selector === selector);

      expect(bySelector('#carousel-track')).toMatchObject({ kind: 'other', horizontalClipAncestor: 'CLIPPED' });
      // 表は主要要素の種類 table になる（RT12r の N3）。スクロールできる外枠の中なので、Finding にはしない。
      expect(bySelector('#scroll-table')).toMatchObject({ kind: 'table', horizontalClipAncestor: 'SCROLLABLE' });
      expect(bySelector('#scroll-cell-link-2')).toMatchObject({ kind: 'link', horizontalClipAncestor: 'SCROLLABLE' });
      expect(bySelector('#fixed-width-image')).toMatchObject({ kind: 'image', horizontalClipAncestor: 'NONE' });
      const tableIndex = evidence.boxesOutsideViewport.findIndex((box) => box.selector === '#scroll-table');
      const link = bySelector('#scroll-cell-link-2');
      const linkAncestor = evidence.boxesOutsideViewport[link?.nearestListedAncestorIndex ?? -1];
      // リンクの最も近い祖先は、横にはみ出す td で、その祖先をたどると表に着く。
      expect(linkAncestor?.selector).toMatch(/td:nth-of-type\(2\)$/u);
      const chain: string[] = [];
      for (let index = link?.nearestListedAncestorIndex ?? null; index !== null;) {
        chain.push(evidence.boxesOutsideViewport[index]?.selector ?? '');
        index = evidence.boxesOutsideViewport[index]?.nearestListedAncestorIndex ?? null;
      }
      expect(chain).toContain('#scroll-table');
      expect(bySelector('#scroll-table')?.nearestListedAncestorIndex).not.toBe(tableIndex);
    });
  });

  it('treats an overflow-x:hidden body as a clipping ancestor (I1)', async () => {
    await withFixture('layout-body-overflow-hidden.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.boxesOutsideViewport).toEqual(expect.arrayContaining([
        expect.objectContaining({ selector: '#bleed-image', kind: 'image', horizontalClipAncestor: 'CLIPPED' }),
        expect.objectContaining({ selector: '#bleed-heading', kind: 'heading', horizontalClipAncestor: 'CLIPPED' }),
      ]));
    });
  });

  it('reports only primary elements that really stick out, once per nested tree (I1)', async () => {
    const casesPage = await openFixture('layout-rule-cases.html');
    const cases = completeLayout(await collectLayoutEvidence(casesPage, { width: 400, height: 300 }));
    // カルーセル、横にスクロールできる表、拡大する画像のカードは Finding にせず、固定の幅の画像だけを Finding にする。
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', cases)).toEqual(['#fixed-width-image']);

    await closePassiveResources({ factory, context, page });
    const bodyPage = await openFixture('layout-body-overflow-hidden.html');
    const bodyHidden = completeLayout(await collectLayoutEvidence(bodyPage, { width: 400, height: 300 }));
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', bodyHidden)).toEqual([]);

    await closePassiveResources({ factory, context, page });
    const wrapperPage = await openFixture('layout-page-wrapper-overflow-hidden.html');
    const wrapperHidden = completeLayout(await collectLayoutEvidence(wrapperPage, { width: 400, height: 300 }));
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', wrapperHidden)).toEqual([]);

    await closePassiveResources({ factory, context, page });
    const tablePage = await openFixture('layout-wide-table.html');
    const table = completeLayout(await collectLayoutEvidence(tablePage, { width: 400, height: 300 }));
    // 表・tbody・tr・td・リンクが、すべて横にはみ出す候補として記録される。Finding は重ならない（1件以下）。
    expect(table.boxesOutsideViewport.filter((box) => box.outside.right).length).toBeGreaterThanOrEqual(4);
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', table).length).toBeLessThanOrEqual(1);
  });

  it('records whether a line of descendant text straddles the box, and reports only really cut text (I2)', async () => {
    const casesPage = await openFixture('layout-rule-cases.html');
    const cases = completeLayout(await collectLayoutEvidence(casesPage, { width: 400, height: 300 }));
    const bySelector = (selector: string) => cases.clippedText.find((candidate) => candidate.selector === selector);

    // カルーセルの外枠と、画像を拡大するカードは Finding にせず、本当にテキストが切れている箱だけを Finding にする。
    expect(layoutRuleSelectors('TEXT_CLIPPING', cases)).toEqual(['#clipped-caption']);
    expect(bySelector('#carousel')).toMatchObject({ widthClipped: true, partiallyClippedText: false });
    expect(bySelector('#zoom-card')).toMatchObject({ widthClipped: true, partiallyClippedText: false });
    expect(bySelector('#clipped-caption')).toMatchObject({ widthClipped: true, partiallyClippedText: true });
    expect(cases.truncation.clippedTextNodeScanLimitReachedCount).toBe(0);

    await closePassiveResources({ factory, context, page });
    const wrapperPage = await openFixture('layout-page-wrapper-overflow-hidden.html');
    const wrapperHidden = completeLayout(await collectLayoutEvidence(wrapperPage, { width: 400, height: 300 }));
    // ページ全体を包む overflow-x:hidden の外枠も、Finding にしない。
    expect(layoutRuleSelectors('TEXT_CLIPPING', wrapperHidden)).toEqual([]);
    expect(wrapperHidden.clippedText).toEqual([
      expect.objectContaining({ selector: '#page-wrapper', widthClipped: true, partiallyClippedText: false }),
    ]);
  });

  // S-06: 文字と外枠の間にスクロールできる祖先があれば、その祖先の箱で判定する（収まれば外枠の文字切れにしない。はみ出せば、その祖先を対象に残す）。
  it('judges the text in an inner scroll region by the box of the region (S-06)', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        const rows = Array.from({ length: 30 }, (_, index) => `<p>行 ${index + 1}</p>`).join('');
        // 外枠（高さ 150px で隠す）の中に、見出しと内側のスクロール領域。`inner-fits` は、領域の下の空の箱で外枠の中身がはみ出す（領域は外枠に収まる）。
        const box = (id: string, inner: string, after = ''): string => `<div id="${id}" style="height:150px;overflow:hidden">`
          + `<header style="height:40px">見出し</header><div id="${id}-inner" style="${inner};overflow:auto">${rows}</div>${after}</div>`;
        document.querySelector('main')?.insertAdjacentHTML('afterbegin',
          box('sticks-out', 'height:100%') + box('inner-fits', 'height:100px', '<div style="height:60px"></div>'));
      });
      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const selectors = layoutRuleSelectors('TEXT_CLIPPING', evidence).filter((selector) => /^#(sticks-out|inner-fits)/u.test(selector ?? ''));
      expect(selectors).toEqual(['#sticks-out-inner']);
    });
  });

  it('checks every text node of a candidate, beyond the former limit of 256 nodes (I2, COV-6)', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      await fixturePage.evaluate((limit) => {
        // 空白だけのテキストのノード（走査の数には入り、行の判定はしない）の後に、箱の境界をまたぐ行を置く。
        const box = (id: string, blankNodes: number): HTMLDivElement => {
          const element = document.createElement('div');
          element.id = id;
          element.style.cssText = 'width:200px;height:24px;overflow:hidden;white-space:nowrap;';
          for (let index = 0; index < blankNodes; index += 1) {
            element.append(document.createTextNode(' '));
          }
          element.append(document.createTextNode('x'.repeat(200)));
          return element;
        };
        // 前の上限（256）の中に、またぐ行がある箱（対照）と、またぐ行が前の上限の外にある箱。COV-6 の後は、どちらも見切れを見つける。
        document.querySelector('main')?.prepend(box('within-text-node-limit', limit - 1), box('many-text-nodes', limit * 4));
      }, FORMER_NODE_SCAN_LIMIT);

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      expect(bySelector('#within-text-node-limit')).toMatchObject({ widthClipped: true, partiallyClippedText: true });
      expect(bySelector('#many-text-nodes')).toMatchObject({ widthClipped: true, partiallyClippedText: true });
      expect(evidence.truncation.clippedTextNodeScanLimitReachedCount).toBe(0);
    });
  });

  it('records whether a zero-size control has a rendered descendant, and reports only empty ones (I3)', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.zeroSizeInteractive.find((candidate) => candidate.selector === selector);

      // float の画像だけを包むリンクと、absolute の子だけを包むリンクは Finding にせず、中身のないボタンだけを Finding にする。
      expect(layoutRuleSelectors('ZERO_SIZE_INTERACTIVE_ELEMENT', evidence)).toEqual(['#empty-button']);
      expect(bySelector('#float-image-link')).toMatchObject({ hasRenderedDescendant: true });
      expect(bySelector('#absolute-child-link')).toMatchObject({ hasRenderedDescendant: true });
      expect(bySelector('#empty-button')).toMatchObject({ hasRenderedDescendant: false });
      expect(evidence.truncation.renderedDescendantScanLimitReachedCount).toBe(0);
    });
  });

  it('checks every descendant of a zero-size control, beyond the former limit of 256 elements (I3, COV-6)', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      await fixturePage.evaluate((limit) => {
        // 描画されない子孫の後に、描画された子孫（float の画像）を置いたリンク。
        const link = (id: string, hiddenDescendants: number): HTMLAnchorElement => {
          const element = document.createElement('a');
          element.id = id;
          element.href = `#${id}`;
          for (let index = 0; index < hiddenDescendants; index += 1) {
            const hidden = document.createElement('span');
            hidden.style.display = 'none';
            element.append(hidden);
          }
          const image = document.createElement('img');
          image.alt = 'Late image';
          image.style.cssText = 'float:left;width:40px;height:40px;';
          element.append(image);
          return element;
        };
        // 前の上限（256）の中に描画された子孫があるリンク（対照）と、それが前の上限の外にあるリンク。COV-6 の後は、どちらも子孫を見つける。
        document.querySelector('main')?.prepend(
          link('within-descendant-limit', limit - 1),
          link('many-descendants-link', limit * 4),
        );
      }, FORMER_NODE_SCAN_LIMIT);

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.zeroSizeInteractive.find((candidate) => candidate.selector === selector);

      expect(bySelector('#within-descendant-limit')).toMatchObject({ hasRenderedDescendant: true });
      expect(bySelector('#many-descendants-link')).toMatchObject({ hasRenderedDescendant: true });
      expect(evidence.truncation.renderedDescendantScanLimitReachedCount).toBe(0);
    });
  });
});

describe('layout evidence corrected after the RT12r review (N1, N3, N4, N5)', () => {
  it('does not treat the small overshoot of a line rectangle in an auto-height box as clipped text (N1)', async () => {
    await withFixture('layout-text-clipping-lines.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const tight = evidence.clippedText.find((candidate) => candidate.selector === '#tight-line-box');

      // 行の矩形（フォントの内容領域）は、行の高さより大きいので、箱の上下に少しだけ出る。これは見切れではない。
      expect(tight).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).not.toContain('#tight-line-box');
    });
  });

  it('reports lines that are wholly below a box whose lower edge falls between two lines (N1)', async () => {
    await withFixture('layout-text-clipping-lines.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      expect(bySelector('#two-of-four-lines')).toMatchObject({ heightClipped: true, partiallyClippedText: true });
      // 横に隠れたスライドの行と、見える行が1つもない閉じたパネルは、見切れにしない。
      expect(bySelector('#vertical-carousel')).toMatchObject({
        widthClipped: true,
        heightClipped: true,
        partiallyClippedText: false,
      });
      expect(bySelector('#closed-panel')).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      // 同じ fixture の、横に一部だけ隠れる1行の箱（RT12e）も Finding になる。それ以外の結果は変わらない。
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).toEqual(['#two-of-four-lines', '#partly-cut-line']);
    });
  });

  it('reports a single line whose right part is hidden by the box, and ignores an overhang of 2 px or less (RT12e)', async () => {
    await withFixture('layout-text-clipping-lines.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      // 行の矩形が、箱（padding box）の右の境界からどれだけ出ているかと、行の幅を測る。
      const measured = await fixturePage.evaluate(() => {
        const measure = (selector: string) => {
          const box = document.querySelector(selector) as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(box);
          const lines = [...range.getClientRects()];
          const boxRight = box.getBoundingClientRect().left + box.clientLeft + box.clientWidth;
          return {
            lineCount: lines.length,
            lineWidth: Math.max(...lines.map((line) => line.width)),
            outsideRight: Math.max(...lines.map((line) => line.right)) - boxRight,
          };
        };
        return { partlyCut: measure('#partly-cut-line'), smallOverhang: measure('#small-overhang') };
      });

      // 前提: 1行の幅は約 380px で、隠れる量（約 80px）は、行の幅の4分の1以下である（割合のしきい値では見逃す形）。
      expect(measured.partlyCut.lineCount).toBe(1);
      expect(measured.partlyCut.lineWidth).toBeGreaterThan(340);
      expect(measured.partlyCut.lineWidth).toBeLessThanOrEqual(400);
      expect(measured.partlyCut.outsideRight).toBeLessThanOrEqual(
        measured.partlyCut.lineWidth * LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio,
      );
      expect(measured.partlyCut.outsideRight).toBeGreaterThan(
        LAYOUT_THRESHOLDS.clippedTextLineMaxIgnoredHorizontalOverflowPx,
      );
      // 前提: 小さな張り出しは、0 px より大きく、しきい値（2 px）以下である。
      expect(measured.smallOverhang.outsideRight).toBeGreaterThan(0);
      expect(measured.smallOverhang.outsideRight).toBeLessThanOrEqual(
        LAYOUT_THRESHOLDS.clippedTextLineMaxIgnoredHorizontalOverflowPx,
      );

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      expect(bySelector('#partly-cut-line')).toMatchObject({ widthClipped: true, partiallyClippedText: true });
      expect(bySelector('#small-overhang')).toMatchObject({ widthClipped: true, partiallyClippedText: false });
      // 横に隠れたスライドは、引き続き見切れにしない。
      expect(bySelector('#vertical-carousel')).toMatchObject({ widthClipped: true, partiallyClippedText: false });
      const findings = layoutRuleSelectors('TEXT_CLIPPING', evidence);
      expect(findings).toContain('#partly-cut-line');
      expect(findings).not.toContain('#small-overhang');
      expect(findings).not.toContain('#vertical-carousel');
    });
  });

  it('records a table and embedded media as primary kinds, and reports them when they stick out (N3)', async () => {
    const tablePage = await openFixture('layout-wide-table.html');
    const table = completeLayout(await collectLayoutEvidence(tablePage, { width: 400, height: 300 }));

    expect(table.boxesOutsideViewport.find((box) => box.selector === '#wide-table')).toMatchObject({
      kind: 'table',
      horizontalClipAncestor: 'NONE',
    });
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', table)).toEqual(['#wide-table']);

    await closePassiveResources({ factory, context, page });
    const mediaPage = await openFixture('layout-wide-media.html');
    const media = completeLayout(await collectLayoutEvidence(mediaPage, { width: 400, height: 300 }));

    expect(media.boxesOutsideViewport.filter((box) => box.kind === 'media').map((box) => box.selector)).toEqual([
      '#wide-frame',
      '#wide-video',
      '#wide-canvas',
    ]);
    expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', media)).toEqual(['#wide-frame', '#wide-video', '#wide-canvas']);
  });

  it('keeps an outside candidate without a clipping ancestor when carousels fill the candidate limit (N4)', async () => {
    await withFixture('layout-carousel-candidates.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const clippedCandidates = evidence.boxesOutsideViewport.filter((box) => box.horizontalClipAncestor === 'CLIPPED');

      // カルーセルの中の横にはみ出す候補だけで、前の件数の上限（100）を超える。COV-6 の後は、全部を集める。
      expect(clippedCandidates.length).toBeGreaterThan(100);
      expect(evidence.truncation.omittedOutsideViewportCount).toBe(0);
      expect(evidence.boxesOutsideViewport.find((box) => box.selector === '#late-wide-image')).toMatchObject({
        kind: 'image',
        horizontalClipAncestor: 'NONE',
      });
      expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', evidence)).toEqual(['#late-wide-image']);
      // 残した候補は、文書の順に並ぶ。
      const inDocumentOrder = await fixturePage.evaluate((selectors) => {
        const elements = selectors.map((selector) => document.querySelector(selector));
        return elements.every((element, index) => {
          const previous = index === 0 ? null : elements[index - 1];
          return element !== null
            && (previous === null || previous === undefined
              || (previous.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
        });
      }, evidence.boxesOutsideViewport.map((box) => box.selector));
      expect(inDocumentOrder).toBe(true);
    });
  });

  it('does not count a visually hidden descendant as rendered, and reports the zero-size link (N5)', async () => {
    await withFixture('layout-visually-hidden-link.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.zeroSizeInteractive.find((candidate) => candidate.selector === '#visually-hidden-label-link'))
        .toMatchObject({ hasRenderedDescendant: false });
      expect(layoutRuleSelectors('ZERO_SIZE_INTERACTIVE_ELEMENT', evidence)).toEqual(['#visually-hidden-label-link']);
    });
  });
});

describe('visually hidden elements by clip and clip-path (DEF-205)', () => {
  it('records the zero area of clip and clip-path, and does not report them as clipped text or outside the viewport', async () => {
    await withFixture('layout-clip-hidden-text.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const clipped = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      // スマホの幅の最小の大きさで、隠したリンクが 1 × 1 px より大きくなり、文字が箱からはみ出す（DEF-205 の前提）。
      for (const selector of ['#skip-rect', '#skip-rect-comma', '#skip-inset']) {
        expect(clipped(selector)?.rect.width).toBeGreaterThan(VISUALLY_HIDDEN_MAX_DIMENSION_PX);
        expect(clipped(selector)?.partiallyClippedText).toBe(true);
        expect(clipped(selector)?.visibility.clippedToZeroArea).toBe(true);
      }
      expect(clipped('#hidden-ancestor-cut')?.visibility.clippedToZeroArea).toBe(true);
      expect(clipped('#really-cut')?.visibility.clippedToZeroArea).toBe(false);
      expect(clipped('#partly-inset')?.visibility.clippedToZeroArea).toBe(false);
      expect(evidence.boxesOutsideViewport.find((box) => box.selector === '#hidden-wide-button')?.visibility.clippedToZeroArea)
        .toBe(true);

      // 隠した要素は数えず、隠していない本当の見切れと、はみ出しは数える。
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).toEqual(['#really-cut', '#partly-inset']);
      expect(layoutRuleSelectors('ELEMENT_OUTSIDE_VIEWPORT', evidence)).toEqual(['#visible-wide-button']);
    });
  });
});

describe('layout evidence corrected after the RT12r2 review (I1, M1, M2)', () => {
  it('compares the overshoot above and below a single line separately, and does not report the heading (I1)', async () => {
    await withFixture('layout-single-line-headings.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      // 実際に使われたフォントで、行の矩形が、箱（padding box）の上と下にどれだけ出ているかを測る。
      const measured = await fixturePage.evaluate((selectors) => selectors.map((selector) => {
        const box = document.querySelector(selector) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(box);
        const lines = [...range.getClientRects()].filter((line) => line.width > 0);
        const boxTop = box.getBoundingClientRect().top + box.clientTop;
        const boxBottom = boxTop + box.clientHeight;
        const line = lines[0];
        return {
          selector,
          lineCount: lines.length,
          lineHeight: line === undefined ? 0 : line.bottom - line.top,
          outsideTop: line === undefined ? 0 : boxTop - line.top,
          outsideBottom: line === undefined ? 0 : line.bottom - boxBottom,
        };
      }), ['#heading-line-height-10', '#heading-line-height-11', '#heading-with-rule']);

      // 前提の注記（RT12r3 の m2、DEF-019）: このテストは、上下に出た量の合計が、行の高さの4分の1を超えることを前提にしている。
      // fixture の @font-face（ascent-override・descent-override・line-gap-override）で、行の縦の寸法を固定しているので、
      // 環境のフォントによらず前提が成り立つ。local() のどのフォントもない環境では前提が崩れ、次の前提の assert で目に見える形で失敗する
      // （skip にすると、誤りが隠れるため、skip にしない）。
      const ratio = LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio;
      for (const heading of measured) {
        // 前提: 1行で、上下の出た量の合計は、行の矩形の高さの4分の1を超える（合計して比べると、誤って報告する形）。
        expect(heading.lineCount, heading.selector).toBe(1);
        expect(heading.outsideTop + heading.outsideBottom, heading.selector).toBeGreaterThan(heading.lineHeight * ratio);
        // 前提: 片側ずつは、行の矩形の高さの4分の1を超えない。
        expect(heading.outsideTop, heading.selector).toBeGreaterThan(0);
        expect(heading.outsideTop, heading.selector).toBeLessThanOrEqual(heading.lineHeight * ratio);
        expect(heading.outsideBottom, heading.selector).toBeGreaterThan(0);
        expect(heading.outsideBottom, heading.selector).toBeLessThanOrEqual(heading.lineHeight * ratio);
      }

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      expect(bySelector('#heading-line-height-10')).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      expect(bySelector('#heading-line-height-11')).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      // 見出しの横に線を引く形は、線が横にはみ出して切り取られるが、テキストは切れていない。
      expect(bySelector('#heading-with-rule')).toMatchObject({ widthClipped: true, partiallyClippedText: false });
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).toEqual([]);
    });
  });

  it('compares the overhang on the left and on the right of a line separately (I1)', async () => {
    await withFixture('layout-single-line-headings.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {
      // 1行を、箱の左と右に、それぞれ 2 px 以下だけ張り出させる（合計は 2 px を超える）。
      const measured = await fixturePage.evaluate(() => {
        const box = document.createElement('p');
        box.id = 'both-sides-overhang';
        box.style.cssText = 'margin:0;padding:0;border:0;overflow:hidden;white-space:nowrap;font-size:16px;line-height:40px;';
        const text = document.createElement('span');
        text.style.marginLeft = '-1.5px';
        text.textContent = 'Overhang on both sides';
        box.append(text);
        document.querySelector('main')?.prepend(box);
        const range = document.createRange();
        range.selectNodeContents(text);
        const textWidth = range.getBoundingClientRect().width;
        box.style.width = `${Math.round(textWidth - 3)}px`;
        const line = range.getBoundingClientRect();
        const boxLeft = box.getBoundingClientRect().left + box.clientLeft;
        return {
          outsideLeft: boxLeft - line.left,
          outsideRight: line.right - (boxLeft + box.clientWidth),
        };
      });

      const maxIgnored = LAYOUT_THRESHOLDS.clippedTextLineMaxIgnoredHorizontalOverflowPx;
      // 前提: 左右の張り出しの合計はしきい値を超え、片側ずつは超えない。
      expect(measured.outsideLeft + measured.outsideRight).toBeGreaterThan(maxIgnored);
      expect(measured.outsideLeft).toBeGreaterThan(0);
      expect(measured.outsideLeft).toBeLessThanOrEqual(maxIgnored);
      expect(measured.outsideRight).toBeGreaterThan(0);
      expect(measured.outsideRight).toBeLessThanOrEqual(maxIgnored);

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.clippedText.find((candidate) => candidate.selector === '#both-sides-overhang'))
        .toMatchObject({ widthClipped: true, heightClipped: false, partiallyClippedText: false });
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).not.toContain('#both-sides-overhang');
    });
  });

  it('does not use the text of invisible descendants, and still reports visible text that is really cut (M1)', async () => {
    await withFixture('layout-hidden-slide-text.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      // 見えない（opacity:0、visibility:hidden の）背の高いスライドの行は、箱の下に出ていても、判定に使わない。
      expect(bySelector('#opacity-slider')).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      expect(bySelector('#visibility-slider')).toMatchObject({ heightClipped: true, partiallyClippedText: false });
      // 見えるスライドの行が本当に切れている箱は、Finding になる。
      expect(bySelector('#visible-cut-slider')).toMatchObject({ heightClipped: true, partiallyClippedText: true });
      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).toEqual(['#visible-cut-slider']);
    });
  });

  it('does not count a descendant placed wholly outside the left or top of the document as rendered (M2)', async () => {
    await withFixture('layout-offscreen-label-link.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.zeroSizeInteractive.find((candidate) => candidate.selector === selector);

      expect(bySelector('#offscreen-left-label-link')).toMatchObject({ hasRenderedDescendant: false });
      expect(bySelector('#offscreen-top-label-link')).toMatchObject({ hasRenderedDescendant: false });
      // 親の中で負の位置にあっても、文書の中に描画されたアイコンは、描画された子孫として数える。
      expect(bySelector('#shifted-icon-link')).toMatchObject({ hasRenderedDescendant: true });
      expect(layoutRuleSelectors('ZERO_SIZE_INTERACTIVE_ELEMENT', evidence)).toEqual([
        '#offscreen-left-label-link',
        '#offscreen-top-label-link',
      ]);
    });
  });
});

describe('layout evidence corrected after the RT12r3 review (m1)', () => {
  it('does not report links in carousel slides moved outside the document by translate3d (m1)', async () => {
    await withFixture('layout-translated-carousel-links.html', { width: 800, height: 600 }, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 800, height: 600 }));
      const bySelector = (selector: string) => evidence.zeroSizeInteractive.find((candidate) => candidate.selector === selector);
      const slideSelectors = ['#slide-link-1', '#slide-link-2', '#slide-link-3', '#slide-link-4'];

      // 前提: どのスライドのリンクも、高さ0の候補である。1枚目と2枚目は、リンク自身が文書の左の外（右端が 0 以下）にある。
      for (const selector of slideSelectors) {
        expect(bySelector(selector), selector).toMatchObject({ rect: expect.objectContaining({ height: 0 }) });
      }
      expect(bySelector('#slide-link-1')?.rect.right).toBeLessThanOrEqual(0);
      expect(bySelector('#slide-link-2')?.rect.right).toBeLessThanOrEqual(0);

      // リンク自身が文書の外にあるので、その中の absolute の img と span は、描画された子孫として数える。
      for (const selector of slideSelectors) {
        expect(bySelector(selector), selector).toMatchObject({ hasRenderedDescendant: true });
      }
      // ビューポートの中にある、`left:-9999px` のテキストだけを持つリンクは、引き続き報告する。
      expect(bySelector('#offscreen-label-link')).toMatchObject({ hasRenderedDescendant: false });
      expect(layoutRuleSelectors('ZERO_SIZE_INTERACTIVE_ELEMENT', evidence)).toEqual(['#offscreen-label-link']);
    });
  });

  it('treats a zero-width candidate at the left edge as inside the document, and one ending at the left edge as outside (m1)', async () => {
    // 左端が 0 で幅が 0 の候補は、文書の中とみなす。文書の左の外にあるテキストは、描画された子孫として数えない。
    const edgePage = await openFixture('layout-offscreen-label-link.html');
    const edge = completeLayout(await collectLayoutEvidence(edgePage, { width: 400, height: 300 }));
    const edgeLink = edge.zeroSizeInteractive.find((candidate) => candidate.selector === '#offscreen-left-label-link');
    expect(edgeLink?.rect).toMatchObject({ left: 0, right: 0, width: 0 });
    expect(edgeLink).toMatchObject({ hasRenderedDescendant: false });
    await closePassiveResources({ factory, context, page });
    page = undefined;
    context = undefined;
    factory = undefined;

    // 左端が -600 で右端が 0 の候補は、文書の外とみなす。文書の左の外にある子孫も、描画された子孫として数える。
    const carouselPage = await openFixture('layout-translated-carousel-links.html', { width: 800, height: 600 });
    const carousel = completeLayout(await collectLayoutEvidence(carouselPage, { width: 800, height: 600 }));
    const endingLink = carousel.zeroSizeInteractive.find((candidate) => candidate.selector === '#slide-link-2');
    expect(endingLink?.rect).toMatchObject({ left: -600, right: 0, height: 0 });
    expect(endingLink).toMatchObject({ hasRenderedDescendant: true });
  });
});

describe('the horizontal overflow of the viewport and DOCUMENT_HORIZONTAL_OVERFLOW (RT12c)', () => {
  it('does not report a document that is wider than the viewport when the body propagates overflow-x:hidden', async () => {
    await withFixture('layout-body-overflow-hidden.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      // 文書の横幅は、事実としてそのまま記録する。ビューポートは横に切り取るので、利用者に横スクロールは生じない。
      expect(layoutRuleDrafts('DOCUMENT_HORIZONTAL_OVERFLOW', evidence)).toEqual([]);
      expect(evidence.document.horizontalOverflowPx).toBeGreaterThan(0);
      expect(evidence.document.viewportHorizontalClip).toBe('CLIPPED');
    });
  });

  it('reports a document that really scrolls sideways even when a page wrapper has overflow-x:hidden', async () => {
    await withFixture('layout-page-wrapper-overflow-hidden.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      // 外枠の中のはみ出しは、外枠が切り取るので、文書は横にはみ出さない。
      const wrapped = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      expect(wrapped.document).toMatchObject({ horizontalOverflowPx: 0, viewportHorizontalClip: 'NONE' });
      expect(layoutRuleDrafts('DOCUMENT_HORIZONTAL_OVERFLOW', wrapped)).toEqual([]);

      // 外枠の外に、ビューポートより 120 px 広い要素を置くと、文書が本当に横へスクロールする。
      await fixturePage.evaluate(() => {
        const wide = document.createElement('div');
        wide.id = 'outside-wrapper-wide';
        wide.style.cssText = 'width:520px;height:10px;';
        document.body.append(wide);
      });
      const overflowing = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      expect(overflowing.document).toMatchObject({ horizontalOverflowPx: 120, viewportHorizontalClip: 'NONE' });
      const drafts = layoutRuleDrafts('DOCUMENT_HORIZONTAL_OVERFLOW', overflowing);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.message).toContain('120 px');
    });
  });

  it('keeps reporting a page that really overflows sideways', async () => {
    await withFixture('layout-rule-cases.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));

      expect(evidence.document.viewportHorizontalClip).toBe('NONE');
      expect(evidence.document.horizontalOverflowPx).toBeGreaterThan(0);
      const drafts = layoutRuleDrafts('DOCUMENT_HORIZONTAL_OVERFLOW', evidence);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.message).toContain(`${String(evidence.document.horizontalOverflowPx)} px`);
    });
  });
});

describe('accessibility evidence', () => {
  it('keeps all axe violations including color contrast with bounded immutable node snippets', async () => {
    await withFixture('bad-contrast.html', { width: 800, height: 600 }, async (fixturePage) => {

      const evidence = await collectAccessibilityEvidence(fixturePage);

      expect(evidence.violations.some((violation) => violation.ruleId === 'color-contrast')).toBe(true);
      expect(evidence.violations.some((violation) => violation.ruleId === 'image-alt')).toBe(true);
      const contrastNode = evidence.violations.find((violation) => violation.ruleId === 'color-contrast')?.nodes[0];
      expect(contrastNode?.targetSelectors.flat()).toContain('#poor-contrast');
      expect(Object.isFrozen(evidence.violations)).toBe(true);
      expect(Object.isFrozen(contrastNode?.targetSelectors)).toBe(true);
      expect(JSON.stringify(evidence)).not.toMatch(/finding|fingerprint|evidenceId/i);
    });
  });

  it('keeps aria-hidden but visible text in the DOM visible text (V7 C)', async () => {
    // レビュー V7 (C) の再現条件: <main aria-hidden="true"> を、DOM は除外していた。
    await withFixture('visibility-override.html', { width: 800, height: 600 }, async (fixturePage) => {

      const dom = await collectDomEvidence(fixturePage, createPageId(1));

      expect(dom.visibleText.text).toContain('ARIA hidden but visible text');
      expect(dom.visibleText.text).toContain('Visible despite a hidden parent');
      expect(dom.visibleText.text).not.toContain('Inherited hidden text');
      expect(dom.visibleText.regions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'main', text: 'ARIA hidden but visible text', ariaHidden: true }),
      ]));
    });
  });

  it('takes no visible text from a transparent body (V7 A)', async () => {
    await withFixture('bad-contrast.html', { width: 800, height: 600 }, async (fixturePage) => {
      await fixturePage.evaluate(() => {
        document.body.style.opacity = '0';
      });

      const dom = await collectDomEvidence(fixturePage, createPageId(2));

      expect(dom.visibleText.text).toBe('');
    });
  });
});

describe('AUD-4a: 意図した省略の事実（ellipsis・行数の省略・閉じた折りたたみ）', () => {
  it('見切れの候補ごとに省略の書き方・見える行の数・閉じた折りたたみを記録し、意図した省略だけを Rule が外す', async () => {
    await withFixture('layout-intended-clipping.html', DEFAULT_FIXTURE_VIEWPORT, async (fixturePage) => {

      const evidence = completeLayout(await collectLayoutEvidence(fixturePage, { width: 400, height: 300 }));
      const bySelector = (selector: string) => evidence.clippedText.find((candidate) => candidate.selector === selector);

      expect(bySelector('#clamp-two')).toMatchObject({
        heightClipped: true,
        partiallyClippedText: true,
        clippingStyle: expect.objectContaining({ webkitLineClamp: '2', webkitBoxOrient: 'vertical' }),
        lineHeightPx: 20,
        lineClampCount: 2,
        collapsedByControl: false,
        intendedClipping: 'LINE_CLAMP',
      });
      expect(bySelector('#clamp-two')?.visibleLineCount).toBeCloseTo(2, 1);
      expect(bySelector('#clamp-half')).toMatchObject({
        clippingStyle: expect.objectContaining({ maxHeight: '30px' }),
        lineClampCount: 2,
        intendedClipping: 'LINE_CLAMP',
      });
      expect(bySelector('#clamp-half')?.visibleLineCount).toBeCloseTo(1.5, 1);
      expect(bySelector('#ellipsis-line')).toMatchObject({
        widthClipped: true,
        clippingStyle: expect.objectContaining({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
        lineClampCount: null,
        intendedClipping: 'INTENDED_ELLIPSIS',
      });
      expect(bySelector('#nowrap-cut')).toMatchObject({
        widthClipped: true,
        clippingStyle: expect.objectContaining({ textOverflow: 'clip', whiteSpace: 'nowrap' }),
        intendedClipping: null,
      });
      expect(bySelector('#collapsed-panel')).toMatchObject({ collapsedByControl: true, intendedClipping: 'COLLAPSED' });
      expect(bySelector('#collapsed-inner')).toMatchObject({ collapsedByControl: true, intendedClipping: 'COLLAPSED' });
      expect(bySelector('#open-panel-cut')).toMatchObject({ collapsedByControl: false, intendedClipping: null });

      expect(layoutRuleSelectors('TEXT_CLIPPING', evidence)).toEqual(['#clamp-half', '#nowrap-cut', '#open-panel-cut']);
    });
  });
});
