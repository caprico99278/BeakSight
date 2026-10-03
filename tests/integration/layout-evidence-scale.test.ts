import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import type { LayoutCollectionResult, LayoutEvidence } from '../../src/core/evidence-types.js';
import { LAYOUT_THRESHOLDS, collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

// レビュー V8 の再現条件: 16,000要素のページで9.7秒かかっていた（要素数の2乗で遅くなる）。
// 目安は1秒以内。修正後の実測は約0.1秒なので、CIの揺れを見込んでも、しきい値は目安の1秒のままにする。
const SCALE_ELEMENT_COUNT = 16_000;
const SCALE_TEST_THRESHOLD_MS = 1_000;

let browser: Browser;
let server: FixtureServer | undefined;

/**
 * fixture のサーバの `pathname` を、Guard の付いた Passive の page で開いて `run` に渡す。
 * 終わったら（失敗しても）、page と Context を閉じる（`withGuardedPassivePage`）。
 */
async function withFixture(pathname: string, viewport: Viewport, run: (page: Page) => Promise<void>): Promise<void> {
  server ??= await startFixtureServer();
  const fixtureServer = server;
  const factory = new BrowserContextFactory(browser, createTestConfig(fixtureServer.origin, '/overflow.html'), () => new SafetyLedger());
  await withGuardedPassivePage(factory, viewport, async (page) => {
    await page.goto(`${fixtureServer.origin}/${pathname}`, { waitUntil: 'load' });
    await run(page);
  });
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
  await server?.close();
  server = undefined;
});

describe('layout collection scale (V8)', () => {
  it(`collects a page of ${SCALE_ELEMENT_COUNT} sibling elements within the time target`, async () => {
    const viewport = { width: 400, height: 300 };
    await withFixture(`many-elements.html?count=${SCALE_ELEMENT_COUNT}`, viewport, async (fixturePage) => {
      const expectedOutside = await fixturePage.evaluate((epsilon) => (
        [...document.body.querySelectorAll('*')]
          .filter((element) => element.getBoundingClientRect().bottom > window.innerHeight + epsilon)
          .length
      ), LAYOUT_THRESHOLDS.geometryEpsilonPx);

      const startedAt = performance.now();
      const result = await collectLayoutEvidence(fixturePage, viewport);
      const elapsedMs = performance.now() - startedAt;
      console.info(`layout collection of ${SCALE_ELEMENT_COUNT} elements took ${elapsedMs.toFixed(0)} ms`);

      expect(elapsedMs).toBeLessThan(SCALE_TEST_THRESHOLD_MS);
      const layout = completeLayout(result);
      expect(layout.boxesOutsideViewport).toHaveLength(LAYOUT_THRESHOLDS.maxOutsideViewportCandidates);
      expect(layout.truncation.omittedOutsideViewportCount).toBe(
        expectedOutside - LAYOUT_THRESHOLDS.maxOutsideViewportCandidates,
      );
      expect(layout.boxesOutsideViewport[0]?.selector).toMatch(/^body:nth-of-type\(1\) > p:nth-of-type\(\d+\)$/u);
    });
  });

  it(`collects ${SCALE_ELEMENT_COUNT} sideways candidates inside a clipping ancestor within the time target (RT12r N4)`, async () => {
    // はみ出しの候補の組を決めるために、横にはみ出す候補ごとに祖先をたどる。その作業量が、要素数に比例して収まることを確かめる。
    const viewport = { width: 400, height: 300 };
    await withFixture('many-elements.html?count=1', viewport, async (fixturePage) => {
      await fixturePage.evaluate((count) => {
        const clipper = document.createElement('div');
        clipper.style.cssText = 'width:400px;height:40px;overflow:hidden;';
        const track = document.createElement('div');
        track.style.cssText = `display:flex;width:${(count + 1) * 10}px;`;
        for (let index = 0; index < count; index += 1) {
          const cell = document.createElement('span');
          cell.style.cssText = 'flex:0 0 10px;height:20px;';
          track.append(cell);
        }
        clipper.append(track);
        const wide = document.createElement('img');
        wide.id = 'late-wide-image';
        wide.alt = 'Late wide image';
        wide.style.cssText = 'display:block;width:600px;height:20px;';
        document.body.append(clipper, wide);
      }, SCALE_ELEMENT_COUNT);

      const startedAt = performance.now();
      const result = await collectLayoutEvidence(fixturePage, viewport);
      const elapsedMs = performance.now() - startedAt;
      console.info(`layout collection of ${SCALE_ELEMENT_COUNT} clipped sideways candidates took ${elapsedMs.toFixed(0)} ms`);

      expect(elapsedMs).toBeLessThan(SCALE_TEST_THRESHOLD_MS);
      const layout = completeLayout(result);
      expect(layout.boxesOutsideViewport).toHaveLength(LAYOUT_THRESHOLDS.maxOutsideViewportCandidates);
      expect(layout.boxesOutsideViewport.find((box) => box.selector === '#late-wide-image')).toMatchObject({
        horizontalClipAncestor: 'NONE',
      });
    });
  });

  it('returns the facts gathered before the deadline passed inside the browser, with the reason', async () => {
    const viewport = { width: 400, height: 300 };
    await withFixture('many-elements.html?count=2000', viewport, async (fixturePage) => {
      // ブラウザ内の時計だけを、何回か読んだ後に大きく進める（Node側の期限は十分に先）。
      await fixturePage.evaluate(() => {
        const realNow = Date.now.bind(Date);
        let reads = 0;
        Date.now = () => {
          reads += 1;
          return reads > 300 ? realNow() + 1e9 : realNow();
        };
      });

      const result = await collectLayoutEvidence(fixturePage, viewport, { deadlineAtMs: Date.now() + 20_000 });

      expect(result.status).toBe('PARTIAL');
      if (result.status !== 'PARTIAL') {
        return;
      }
      expect(result.reason).toBe('DEADLINE_EXCEEDED');
      expect(result.layout).not.toBeNull();
      expect(result.layout?.document.viewportWidth).toBe(400);
      expect(result.layout?.boxesOutsideViewport.length).toBeGreaterThan(0);
      expect(Object.isFrozen(result)).toBe(true);
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

describe('layout truncation evidence (V9)', () => {
  it('counts overlap candidates and fixed elements cut by the limits', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      const extraFixed = 5;
      await fixturePage.evaluate(({ fixedCount }) => {
        const container = document.createElement('div');
        for (let index = 0; index < fixedCount; index += 1) {
          const element = document.createElement('div');
          element.textContent = `Fixed ${index}`;
          element.style.cssText = `position:fixed;left:${index % 700}px;top:0;width:40px;height:20px;`;
          container.append(element);
        }
        document.body.append(container);
      }, { fixedCount: LAYOUT_THRESHOLDS.maxFixedElementCandidates + extraFixed });

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      expect(layout.fixedElements).toHaveLength(LAYOUT_THRESHOLDS.maxFixedElementCandidates);
      // 追加した固定要素と、もとの #consent-banner の分。
      expect(layout.truncation.omittedFixedElementCount).toBe(extraFixed + 1);
      expect(layout.elementOverlaps).toHaveLength(LAYOUT_THRESHOLDS.maxElementOverlapCandidates);
      expect(layout.truncation.omittedElementOverlapCount).toBeGreaterThan(0);
    });
  });

  it('stops comparing overlap pairs at the comparison limit and says so', async () => {
    const viewport = { width: 800, height: 600 };
    await withFixture('element-overlap.html', viewport, async (fixturePage) => {
      const stackedCount = Math.ceil(Math.sqrt(LAYOUT_THRESHOLDS.maxOverlapComparisons * 2)) + 10;
      await fixturePage.evaluate((count) => {
        const container = document.createElement('div');
        for (let index = 0; index < count; index += 1) {
          const paragraph = document.createElement('p');
          paragraph.textContent = `Stacked ${index}`;
          paragraph.style.cssText = 'position:absolute;left:0;top:2000px;width:100px;height:20px;margin:0;';
          container.append(paragraph);
        }
        document.body.append(container);
      }, stackedCount);

      const result = await collectLayoutEvidence(fixturePage, viewport);

      // R4 の M2: 比べる組の上限に達したら、COMPLETE にせず、集めた事実と理由を返す。
      expect(result.status).toBe('PARTIAL');
      expect(result.status === 'PARTIAL' ? result.reason : undefined).toBe('LAYOUT_COMPARISON_LIMIT_REACHED');
      const layout = result.layout;
      expect(layout?.truncation.overlapComparisonLimitReached).toBe(true);
      expect(layout?.elementOverlaps).toHaveLength(LAYOUT_THRESHOLDS.maxElementOverlapCandidates);
    });
  });

  it('counts outside, zero-size, clipped-text, and fixed-heading candidates beyond the limits and marks cut text', async () => {
    const viewport = { width: 400, height: 300 };
    await withFixture('overflow.html', viewport, async (fixturePage) => {
      const extra = 7;
      await fixturePage.evaluate(({ zeroCount, clippedCount, headingCount, textLength }) => {
        const container = document.createElement('div');
        for (let index = 0; index < zeroCount; index += 1) {
          const button = document.createElement('button');
          button.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;padding:0;border:0;overflow:hidden;';
          container.append(button);
        }
        for (let index = 0; index < clippedCount; index += 1) {
          const clipped = document.createElement('div');
          clipped.textContent = `Clipped ${index} ${'x'.repeat(textLength)}`;
          clipped.style.cssText = 'width:40px;height:20px;overflow:hidden;white-space:nowrap;';
          container.append(clipped);
        }
        for (let index = 0; index < headingCount; index += 1) {
          const heading = document.createElement('h4');
          heading.textContent = `Covered ${index}`;
          heading.style.cssText = 'position:absolute;left:10px;top:10px;width:100px;height:20px;margin:0;';
          container.append(heading);
        }
        document.body.prepend(container);
      }, {
        zeroCount: LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates + extra,
        clippedCount: LAYOUT_THRESHOLDS.maxClippedTextCandidates + extra,
        headingCount: LAYOUT_THRESHOLDS.maxFixedHeadingOverlapCandidates + extra,
        textLength: LAYOUT_THRESHOLDS.maxClippedTextLength,
      });

      const layout = completeLayout(await collectLayoutEvidence(fixturePage, viewport));

      expect(layout.zeroSizeInteractive).toHaveLength(LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates);
      // もとのページの #zero-action の分を加える。
      expect(layout.truncation.omittedZeroSizeInteractiveCount).toBe(extra + 1);
      expect(layout.clippedText).toHaveLength(LAYOUT_THRESHOLDS.maxClippedTextCandidates);
      expect(layout.truncation.omittedClippedTextCount).toBeGreaterThanOrEqual(extra);
      expect(layout.clippedText[0]).toMatchObject({ truncated: true });
      expect(layout.clippedText[0]?.text).toHaveLength(LAYOUT_THRESHOLDS.maxClippedTextLength);
      expect(layout.fixedHeadingOverlaps).toHaveLength(LAYOUT_THRESHOLDS.maxFixedHeadingOverlapCandidates);
      expect(layout.truncation.omittedFixedHeadingOverlapCount).toBeGreaterThanOrEqual(extra);
      expect(layout.truncation.omittedOutsideViewportCount).toBeGreaterThanOrEqual(0);
    });
  });
});
