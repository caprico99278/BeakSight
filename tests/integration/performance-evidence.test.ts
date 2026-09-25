import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import { MAX_RESOURCE_TIMING_ENTRIES } from '../../src/core/limits.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { PerformanceCollector } from '../../src/evidence/performance-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let context: BrowserContext | undefined;
let factory: BrowserContextFactory | undefined;
let page: Page | undefined;
let server: FixtureServer | undefined;

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

describe('performance evidence in a guarded Chromium lifecycle', () => {
  async function initializedVitalState(prelude: string): Promise<Record<string, unknown>> {
    let installedContent = '';
    const captureContext = {
      addInitScript: async ({ content }: { readonly content: string }) => {
        installedContent = content;
      },
    } as unknown as BrowserContext;
    await new PerformanceCollector().installBeforeNavigation(captureContext);
    const probeContext = await browser.newContext();
    try {
      await probeContext.addInitScript({ content: `${prelude}\n${installedContent}` });
      const probePage = await probeContext.newPage();
      await probePage.goto('about:blank', { waitUntil: 'load' });
      return await probePage.evaluate(() => {
        const globalObject = globalThis as typeof globalThis & {
          __BEAKSIGHT_PERFORMANCE__?: { readonly webVitals?: Record<string, unknown> };
        };
        return globalObject.__BEAKSIGHT_PERFORMANCE__?.webVitals ?? {};
      });
    } finally {
      await probeContext.close();
    }
  }

  it('marks INP unsupported when Event Timing lacks interactionId', async () => {
    const vitalState = await initializedVitalState(`
      if (globalThis.PerformanceEventTiming) {
        try { delete globalThis.PerformanceEventTiming.prototype.interactionId; } catch {}
      }
      Object.defineProperty(globalThis.PerformanceObserver, 'supportedEntryTypes', {
        configurable: true,
        value: [...new Set([...(globalThis.PerformanceObserver.supportedEntryTypes || []), 'event'])],
      });
    `);

    expect(vitalState.INP).toMatchObject({ status: 'UNSUPPORTED', value: null });
  });

  it('keeps TTFB supported without a global PerformanceNavigationTiming constructor', async () => {
    const vitalState = await initializedVitalState(`
      Object.defineProperty(globalThis, 'PerformanceNavigationTiming', {
        configurable: true,
        value: undefined,
      });
    `);

    expect(vitalState.TTFB).toMatchObject({ status: 'NOT_OBSERVED', value: null });
  });

  it('installs before navigation, emits no telemetry request, and collects available timing without requiring INP', async () => {
    server = await startFixtureServer();
    factory = new BrowserContextFactory(browser, createTestConfig(server.origin, '/index.html'), () => new SafetyLedger());
    context = await factory.createPassiveContext({ width: 800, height: 600 });
    const collector = new PerformanceCollector();
    await collector.installBeforeNavigation(context);
    page = await factory.createPassivePage(context);
    const network = NetworkCollector.attach(page);

    await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
    await waitForPageSettled(page, {
      deadlineAtMs: Date.now() + 2_000,
      pollIntervalMs: 20,
      stableWindowMs: 40,
    });
    await controlledScroll(page, {
      deadlineAtMs: Date.now() + 2_000,
      stepViewportFraction: 0.75,
      stepWaitMs: 20,
      stableWindowMs: 40,
    });
    const globalReplacement = await page.evaluate(() => {
      const globalObject = globalThis as typeof globalThis & {
        __BEAKSIGHT_PERFORMANCE__?: unknown;
      };
      const before = globalObject.__BEAKSIGHT_PERFORMANCE__;
      try {
        globalObject.__BEAKSIGHT_PERFORMANCE__ = { replaced: true };
      } catch {
        // fail-closedでconfigurableでないグローバル変数は、strictモードのページコードでは代入が拒否されることがある。
      }
      return {
        beforeIsObject: typeof before === 'object' && before !== null,
        replacementLostState: Boolean(
          typeof globalObject.__BEAKSIGHT_PERFORMANCE__ === 'object'
          && globalObject.__BEAKSIGHT_PERFORMANCE__ !== null
          && 'replaced' in globalObject.__BEAKSIGHT_PERFORMANCE__
        ),
      };
    });
    const networkEvidence = await network.snapshot();
    const evidence = await collector.collect(page, networkEvidence, {
      deadlineAtMs: Date.now() + 2_000,
    });

    expect(globalReplacement).toEqual({ beforeIsObject: true, replacementLostState: false });
    expect(evidence.status, JSON.stringify(evidence)).toBe('COMPLETE');
    expect(evidence.navigationTiming).not.toBeNull();
    expect(evidence.navigationTiming?.url).toBe(`${server.origin}/index.html`);
    expect(evidence.webVitals).not.toBeNull();
    if (evidence.webVitals === null) throw new Error('Expected browser Web Vital availability');
    expect(evidence.webVitals.INP).toMatchObject({
      status: expect.stringMatching(/^(NOT_OBSERVED|UNSUPPORTED)$/),
      value: null,
    });
    expect(Object.values(evidence.webVitals).every((vital) => (
      vital.status !== 'OBSERVED'
      || (typeof vital.value === 'number' && Number.isFinite(vital.value) && vital.value >= 0)
    ))).toBe(true);
    expect(server.getCounters()).toMatchObject({ get: 1, post: 0, put: 0, patch: 0, delete: 0 });
    expect(server.getRequestObservations()).toHaveLength(1);
    expect(networkEvidence.requests).toHaveLength(1);
    expect(evidence.telemetryCandidates).toEqual([]);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
    expect(Object.isFrozen(evidence)).toBe(true);

    network.detach();
  });
  async function openInstrumentedPage(pathname: string): Promise<{
    readonly collector: PerformanceCollector;
    readonly network: ReturnType<typeof NetworkCollector.attach>;
    readonly fixturePage: Page;
  }> {
    server ??= await startFixtureServer();
    factory = new BrowserContextFactory(browser, createTestConfig(server.origin, '/index.html'), () => new SafetyLedger());
    context = await factory.createPassiveContext({ width: 800, height: 600 });
    const collector = new PerformanceCollector();
    await collector.installBeforeNavigation(context);
    page = await factory.createPassivePage(context);
    const network = NetworkCollector.attach(page);
    await page.goto(`${server.origin}${pathname}`, { waitUntil: 'load' });
    return { collector, network, fixturePage: page };
  }

  it('expands the Resource Timing buffer so all 300 stylesheets are observed and no rating is kept', async () => {
    const { collector, network, fixturePage } = await openInstrumentedPage('/many-stylesheets.html#300');

    const evidence = await collector.collect(fixturePage, await network.snapshot(), {
      deadlineAtMs: Date.now() + 5_000,
    });
    const browserState = await fixturePage.evaluate(() => JSON.stringify(
      (globalThis as typeof globalThis & { __BEAKSIGHT_PERFORMANCE__?: unknown }).__BEAKSIGHT_PERFORMANCE__,
    ));

    expect(evidence.status, JSON.stringify(evidence.resourceCoverage)).toBe('COMPLETE');
    expect(evidence.resources.filter((resource) => resource.url.includes('/resource-item.css'))).toHaveLength(300);
    expect(evidence.resourceSummaries?.stylesheet.count).toBe(300);
    expect(evidence.resourceCoverage).toMatchObject({
      bufferSize: MAX_RESOURCE_TIMING_ENTRIES,
      bufferFull: false,
      omittedEntryCount: 0,
    });
    expect(browserState).not.toContain('rating');
    expect(JSON.stringify(evidence.webVitals)).not.toContain('rating');
    network.detach();
  });

  it('reports a full Resource Timing buffer as PARTIAL instead of COMPLETE', async () => {
    const overflowCount = MAX_RESOURCE_TIMING_ENTRIES + 20;
    const { collector, network, fixturePage } = await openInstrumentedPage(`/many-stylesheets.html#${overflowCount}`);

    const evidence = await collector.collect(fixturePage, await network.snapshot(), {
      deadlineAtMs: Date.now() + 5_000,
    });

    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'RESOURCE_LIMIT_REACHED' });
    expect(evidence.resourceCoverage?.bufferFull).toBe(true);
    expect(evidence.resources.length).toBeLessThanOrEqual(MAX_RESOURCE_TIMING_ENTRIES);
    expect(evidence.resourceSummaries).not.toBeNull();
    network.detach();
  });

  it('does not add zero transfer sizes of cross-origin resources without Timing-Allow-Origin to the totals', async () => {
    const external = await startFixtureServer();
    try {
      const { collector, network, fixturePage } = await openInstrumentedPage('/index.html');
      await fixturePage.evaluate(async (externalOrigin) => {
        const load = (source: string): Promise<void> => new Promise((resolve, reject) => {
          const image = new Image();
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(new Error(`image failed: ${source}`)), { once: true });
          image.src = source;
          document.body.append(image);
        });
        await Promise.all([
          load(`${externalOrigin}/external-image.svg?cross-origin=1`),
          load('/external-image.svg?same-origin=1'),
        ]);
      }, external.origin);

      const evidence = await collector.collect(fixturePage, await network.snapshot(), {
        deadlineAtMs: Date.now() + 5_000,
      });
      const crossOrigin = evidence.resources.find((resource) => resource.url.endsWith('?cross-origin=1'));
      const sameOrigin = evidence.resources.find((resource) => resource.url.endsWith('?same-origin=1'));

      expect(evidence.status).toBe('COMPLETE');
      expect(crossOrigin).toMatchObject({
        sizeStatus: 'CROSS_ORIGIN_RESTRICTED',
        transferSize: null,
        encodedBodySize: null,
        decodedBodySize: null,
      });
      expect(sameOrigin).toMatchObject({ sizeStatus: 'OBSERVED' });
      expect(sameOrigin?.transferSize).toBeGreaterThan(0);
      expect(evidence.resourceSummaries?.image).toEqual({
        count: 2,
        sizeUnknownCount: 1,
        transferSize: sameOrigin?.transferSize,
        encodedBodySize: sameOrigin?.encodedBodySize,
        decodedBodySize: sameOrigin?.decodedBodySize,
      });
      network.detach();
    } finally {
      await external.close();
    }
  });
});
