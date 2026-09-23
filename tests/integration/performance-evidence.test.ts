import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { PerformanceCollector } from '../../src/evidence/performance-collector.js';
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
    site: { startUrl: `${origin}/index.html`, allowedOrigins: [origin] },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    viewports: {
      primaryDesktop: { ...DEFAULT_CONFIG.viewports.primaryDesktop },
      primaryMobile: { ...DEFAULT_CONFIG.viewports.primaryMobile },
      stressWidths: [...DEFAULT_CONFIG.viewports.stressWidths],
    },
  };
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
  await browser.close();
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
    factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
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
});
