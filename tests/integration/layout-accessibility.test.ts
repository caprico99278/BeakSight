import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  ACCESSIBILITY_LIMITS,
  collectAccessibilityEvidence,
} from '../../src/evidence/accessibility-collector.js';
import { COLOR_LIMITS, collectColorEvidence } from '../../src/evidence/color-collector.js';
import { LAYOUT_THRESHOLDS, collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';

let browser: Browser;
let context: BrowserContext | undefined;
let factory: BrowserContextFactory | undefined;
let page: Page | undefined;
let server: FixtureServer | undefined;

function configFor(origin: string): AuditConfig {
  return {
    ...DEFAULT_CONFIG,
    site: { startUrl: `${origin}/overflow.html`, allowedOrigins: [origin] },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    viewports: {
      primaryDesktop: { ...DEFAULT_CONFIG.viewports.primaryDesktop },
      primaryMobile: { ...DEFAULT_CONFIG.viewports.primaryMobile },
      stressWidths: [...DEFAULT_CONFIG.viewports.stressWidths],
    },
  };
}

async function openFixture(pathname: string, viewport = { width: 400, height: 300 }): Promise<Page> {
  server ??= await startFixtureServer();
  factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
  context = await factory.createPassiveContext(viewport);
  page = await factory.createPassivePage(context);
  await page.goto(`${server.origin}/${pathname}`, { waitUntil: 'load' });
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  if (page !== undefined && !page.isClosed() && factory !== undefined) {
    await factory.closePassivePage(page).catch(() => undefined);
  }
  if (context !== undefined && context.browser() !== null && factory !== undefined) {
    await factory.closePassiveContext(context).catch(() => undefined);
  }
  await server?.close();
  page = undefined;
  context = undefined;
  factory = undefined;
  server = undefined;
});

afterAll(async () => {
  await browser?.close();
});

describe('layout evidence', () => {
  it('uses ancestor-aware visual visibility while retaining visually present aria-hidden geometry', async () => {
    const fixturePage = await openFixture('overflow.html');

    const evidence = await collectLayoutEvidence(fixturePage, { width: 400, height: 300 });

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

  it('rejects a caller viewport that differs from the actual browser viewport', async () => {
    const fixturePage = await openFixture('overflow.html');

    await expect(collectLayoutEvidence(fixturePage, { width: 401, height: 300 })).rejects.toThrow(
      'does not match actual browser viewport',
    );
  });

  it('retains late horizontal and fixed offscreen candidates ahead of ordinary vertical flow', async () => {
    const fixturePage = await openFixture('overflow.html');

    const evidence = await collectLayoutEvidence(fixturePage, { width: 400, height: 300 });
    const selectors = evidence.boxesOutsideViewport.map((candidate) => candidate.selector);

    expect(selectors).toContain('#priority-horizontal');
    expect(selectors).toContain('#priority-fixed-offscreen');
    expect(evidence.boxesOutsideViewport.length).toBeLessThanOrEqual(LAYOUT_THRESHOLDS.maxOutsideViewportCandidates);
  });

  it('excludes fixed-heading identity, containment, and wholly offscreen overlap pairs', async () => {
    const fixturePage = await openFixture('overflow.html');

    const evidence = await collectLayoutEvidence(fixturePage, { width: 400, height: 300 });
    const pairs = evidence.fixedHeadingOverlaps.map((candidate) => (
      `${candidate.overlaySelector}->${candidate.headingSelector}`
    ));

    expect(pairs).not.toContain('#self-fixed-heading->#self-fixed-heading');
    expect(pairs).not.toContain('#fixed-containing->#contained-heading');
    expect(pairs).not.toContain('#contained-fixed->#heading-containing');
    expect(pairs).not.toContain('#offscreen-fixed->#offscreen-heading');
  });

  it('preserves bounded overflow, outside-box, zero-size, and fixed-heading overlap facts', async () => {
    const fixturePage = await openFixture('overflow.html');

    const evidence = await collectLayoutEvidence(fixturePage, { width: 400, height: 300 });

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
    expect(evidence.boxesOutsideViewport.length).toBeLessThanOrEqual(LAYOUT_THRESHOLDS.maxOutsideViewportCandidates);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.fixedHeadingOverlaps[0]?.intersection)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/finding|fingerprint|evidenceId/i);
  });

  it('preserves visible clipped-text preconditions and bounded text', async () => {
    const fixturePage = await openFixture('clipped-text.html');

    const evidence = await collectLayoutEvidence(fixturePage, { width: 400, height: 300 });

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
    expect(evidence.clippedText[0]?.text.length).toBeLessThanOrEqual(LAYOUT_THRESHOLDS.maxClippedTextLength);
  });
});

describe('accessibility and CSS color evidence', () => {
  it('keeps all axe violations including color contrast with bounded immutable node snippets', async () => {
    const fixturePage = await openFixture('bad-contrast.html', { width: 800, height: 600 });

    const evidence = await collectAccessibilityEvidence(fixturePage);

    expect(evidence.violations.some((violation) => violation.ruleId === 'color-contrast')).toBe(true);
    expect(evidence.violations.some((violation) => violation.ruleId === 'image-alt')).toBe(true);
    const contrastNode = evidence.violations.find((violation) => violation.ruleId === 'color-contrast')?.nodes[0];
    expect(contrastNode?.targetSelectors.flat()).toContain('#poor-contrast');
    expect(contrastNode?.htmlSnippet.length).toBeLessThanOrEqual(ACCESSIBILITY_LIMITS.maxHtmlSnippetLength);
    expect(Object.isFrozen(evidence.violations)).toBe(true);
    expect(Object.isFrozen(contrastNode?.targetSelectors)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/finding|fingerprint|evidenceId/i);
  });

  it('collects bounded area-weighted foreground and explicit usable or ambiguous background facts', async () => {
    const fixturePage = await openFixture('bad-contrast.html', { width: 800, height: 600 });

    const evidence = await collectColorEvidence(fixturePage);

    const opaque = evidence.textSamples.find((sample) => sample.selector === '#opaque-sample');
    const ambiguous = evidence.textSamples.find((sample) => sample.selector === '#image-ambiguous');
    const ancestorHidden = evidence.textSamples.find((sample) => sample.selector === '#not-visible-sample');
    expect(opaque).toMatchObject({
      text: 'Opaque color sample.',
      foreground: { status: 'OBSERVED', color: { css: 'rgba(20, 40, 60, 1)' } },
      background: { status: 'OBSERVED', color: { css: 'rgba(240, 240, 240, 1)' } },
      contrast: { status: 'OBSERVED' },
    });
    expect(opaque?.contrast.status === 'OBSERVED' ? opaque.contrast.ratio : undefined).toBeGreaterThan(1);
    expect(ambiguous?.background).toEqual({ status: 'UNAVAILABLE', reason: 'BACKGROUND_IMAGE' });
    expect(ambiguous?.contrast).toEqual({ status: 'UNAVAILABLE', reason: 'BACKGROUND_IMAGE' });
    expect(ancestorHidden).toBeUndefined();
    expect(evidence.textSamples.length).toBeLessThanOrEqual(COLOR_LIMITS.maxTextSamples);
    expect(evidence.foregroundDistribution.length).toBeLessThanOrEqual(COLOR_LIMITS.maxDistributionEntries);
    expect(evidence.foregroundDistribution.reduce((sum, item) => sum + item.area, 0)).toBeGreaterThan(0);
    expect(Object.isFrozen(evidence.textSamples)).toBe(true);
    expect(Object.isFrozen(opaque?.foreground)).toBe(true);
    expect(Object.isFrozen(opaque?.foreground.status === 'OBSERVED' ? opaque.foreground.color : undefined)).toBe(true);
    expect(Object.isFrozen(evidence.foregroundDistribution[0])).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/baseline|finding|aesthetic|fingerprint/i);
  });

  it('marks element and ancestor partial opacity contrast as unavailable', async () => {
    const fixturePage = await openFixture('bad-contrast.html', { width: 800, height: 600 });

    const evidence = await collectColorEvidence(fixturePage);

    expect(evidence.textSamples.find((sample) => sample.selector === '#partial-opacity')?.contrast).toEqual({
      status: 'UNAVAILABLE',
      reason: 'PARTIAL_OPACITY',
    });
    expect(evidence.textSamples.find((sample) => sample.selector === '#ancestor-partial-sample')?.contrast).toEqual({
      status: 'UNAVAILABLE',
      reason: 'PARTIAL_OPACITY',
    });
  });

  it('weights colors by viewport and overflow-ancestor clipped visible area', async () => {
    const fixturePage = await openFixture('bad-contrast.html', { width: 800, height: 600 });

    const evidence = await collectColorEvidence(fixturePage);
    const overflowClipped = evidence.textSamples.find((sample) => sample.selector === '#overflow-clipped-color');
    const viewportClipped = evidence.textSamples.find((sample) => sample.selector === '#viewport-clipped-color');

    expect(overflowClipped).toMatchObject({ boundingArea: 8_000, visibleArea: 2_000 });
    expect(viewportClipped).toMatchObject({ boundingArea: 4_000, visibleArea: 1_000 });
    expect(evidence.textSamples.some((sample) => sample.selector === '#fully-clipped-color')).toBe(false);
    const clippedDistribution = evidence.foregroundDistribution.find((entry) => (
      entry.color.css === 'rgba(30, 60, 90, 1)'
    ));
    expect(clippedDistribution?.area).toBe(2_000);
  });

  it('retains an explicit bounded invalid foreground without aborting other samples', async () => {
    const fixturePage = await openFixture('bad-contrast.html', { width: 800, height: 600 });
    await fixturePage.evaluate(() => {
      const element = document.querySelector<HTMLElement>('#modern-color');
      if (element !== null) {
        element.style.color = 'oklch(50% 0.2 20)';
      }
    });

    const evidence = await collectColorEvidence(fixturePage);
    const modern = evidence.textSamples.find((sample) => sample.selector === '#modern-color');

    expect(modern).toMatchObject({
      foreground: {
        status: 'UNAVAILABLE',
        reason: 'INVALID_COLOR',
        serialized: expect.stringContaining('oklch'),
      },
      contrast: { status: 'UNAVAILABLE', reason: 'INVALID_COLOR' },
    });
    expect(
      modern?.foreground.status === 'UNAVAILABLE' ? modern.foreground.serialized.length : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(COLOR_LIMITS.maxColorSerializationLength);
    expect(evidence.textSamples.some((sample) => sample.selector === '#opaque-sample')).toBe(true);
    expect(evidence.foregroundDistribution.reduce((sum, entry) => sum + entry.proportion, 0)).toBeCloseTo(1);
  });
});
