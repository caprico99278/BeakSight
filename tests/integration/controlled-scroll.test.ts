import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';

let browser: Browser;
let server: FixtureServer;
let context: BrowserContext;
let factory: BrowserContextFactory;

function configFor(origin: string): AuditConfig {
  return {
    ...DEFAULT_CONFIG,
    site: { startUrl: `${origin}/lazy-content.html`, allowedOrigins: [origin] },
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
  vi.useRealTimers();
  if (context !== undefined && context.browser() !== null) {
    await factory.closePassiveContext(context).catch(() => context.close());
  }
  await server?.close();
});

afterAll(async () => {
  await browser.close();
});

async function openLazyPage() {
  server = await startFixtureServer();
  factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
  context = await factory.createPassiveContext({ width: 800, height: 600 });
  const page = await factory.createPassivePage(context);
  await page.goto(`${server.origin}/lazy-content.html`, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('page settling and controlled scrolling', () => {
  it('settles DOM readiness and immutable height observations without relying on networkidle', async () => {
    const page = await openLazyPage();
    const result = await waitForPageSettled(page, {
      deadlineAtMs: Date.now() + 2_000,
      pollIntervalMs: 20,
      stableWindowMs: 60,
    });

    expect(result.status).toBe('SETTLED');
    expect(result.reason).toBe('DOM_AND_HEIGHT_STABLE');
    expect(result.observations.length).toBeGreaterThanOrEqual(2);
    expect(result.observations.every((observation) => (
      observation.readyState === 'interactive' || observation.readyState === 'complete'
    ))).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.observations[0])).toBe(true);

    await factory.closePassivePage(page);
  });

  it('observes repeated lazy height growth and reaches the final stable bottom', async () => {
    const page = await openLazyPage();

    const result = await controlledScroll(page, {
      deadlineAtMs: Date.now() + 5_000,
      stepViewportFraction: 0.75,
      stepWaitMs: 25,
      stableWindowMs: 100,
    });
    const fixtureState = await page.evaluate(() => ({
      batches: document.querySelectorAll('[data-lazy-batch]').length,
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));

    expect(result.status).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.heightGrowthCount).toBeGreaterThanOrEqual(3);
    expect(result.observations.some((observation) => observation.heightGrew)).toBe(true);
    expect(fixtureState.batches).toBe(3);
    expect(fixtureState.scrollY + fixtureState.viewportHeight).toBeGreaterThanOrEqual(fixtureState.scrollHeight - 1);
    expect(result.finalSnapshot?.atBottom).toBe(true);
    expect(Object.isFrozen(result.finalSnapshot)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);

    await factory.closePassivePage(page);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  });

  it('returns honest PARTIAL metadata at the absolute deadline without hanging', async () => {
    const page = await openLazyPage();
    const startedAt = performance.now();
    const deadlineAtMs = Date.now() + 40;

    const result = await controlledScroll(page, {
      deadlineAtMs,
      stepViewportFraction: 0.5,
      stepWaitMs: 20,
      stableWindowMs: 5_000,
    });

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('DEADLINE_EXCEEDED');
    if (result.finalSnapshot === null) {
      expect(result.observations).toEqual([]);
    } else {
      expect(result.finalSnapshot.observedAtMs).toBeLessThan(deadlineAtMs);
      expect(result.finalSnapshot.atBottom).toBe(false);
    }

    await factory.closePassivePage(page);
  });

  it('never promotes a settling observation completed at the absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const deadlineAtMs = 1_050;
    const fakePage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(() => Promise.resolve().then(() => {
        vi.setSystemTime(deadlineAtMs);
        return { readyState: 'complete' as const, scrollHeight: 100 };
      })),
    } as unknown as Page;

    const result = await waitForPageSettled(fakePage, {
      deadlineAtMs,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('DEADLINE_EXCEEDED');
    expect(result.observations.every((observation) => observation.observedAtMs < deadlineAtMs)).toBe(true);
    vi.useRealTimers();
  });

  it('never promotes a scroll observation completed at the absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const deadlineAtMs = 2_050;
    let evaluateCall = 0;
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        evaluateCall += 1;
        if (evaluateCall === 1) {
          return Promise.resolve('MUTATED');
        }
        return Promise.resolve().then(() => {
          vi.setSystemTime(deadlineAtMs);
          return { scrollY: 0, viewportHeight: 100, scrollHeight: 100 };
        });
      }),
    } as unknown as Page;

    const result = await controlledScroll(fakePage, {
      deadlineAtMs,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });

    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('DEADLINE_EXCEEDED');
    expect(result.observations.every((observation) => observation.observedAtMs < deadlineAtMs)).toBe(true);
    vi.useRealTimers();
  });

  it('cannot mutate scroll after returning deadline PARTIAL when evaluate starts late', async () => {
    const initialScrollY = 73;
    let scrollY = initialScrollY;
    let releaseEvaluate: (() => void) | undefined;
    let finishLateCallback: (() => void) | undefined;
    const evaluateStarted = new Promise<void>((resolve) => {
      releaseEvaluate = resolve;
    });
    const lateCallbackFinished = new Promise<void>((resolve) => {
      finishLateCallback = resolve;
    });
    const scrollTo = vi.fn((_x: number, y: number) => {
      scrollY = y;
    });
    const fakeWindow = { scrollTo };
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (callback: (argument: { readonly deadlineAtMs: number }) => unknown, argument: { readonly deadlineAtMs: number }) => {
        await evaluateStarted;
        const previousWindow = globalThis.window;
        Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
        try {
          return callback(argument);
        } finally {
          Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
          finishLateCallback?.();
        }
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: Date.now() + 20,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    releaseEvaluate?.();
    await lateCallbackFinished;
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollY).toBe(initialScrollY);
  });

  it('requires a new full stable window after document height shrinks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const heights = [100, 100, 50, 50, 50];
    let measurement = 0;
    const fakeWindow = {
      scrollY: 0,
      innerHeight: 100,
      scrollTo: vi.fn(),
      scrollBy: vi.fn(),
    };
    const fakeDocument = { documentElement: { scrollHeight: 100 } };
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
        const source = callback.toString();
        if (source.includes('scrollHeight: document.documentElement.scrollHeight')) {
          fakeDocument.documentElement.scrollHeight = heights[Math.min(measurement, heights.length - 1)] ?? 50;
          measurement += 1;
        }
        const previousWindow = globalThis.window;
        const previousDocument = globalThis.document;
        Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
        Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
        try {
          return callback(argument);
        } finally {
          Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
          Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true });
        }
      }),
    } as unknown as Page;
    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 4_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.status).toBe('COMPLETE');
    expect(result.finalSnapshot?.scrollHeight).toBe(50);
    expect(result.observations.length).toBeGreaterThanOrEqual(5);
    expect(result.heightGrowthCount).toBe(0);
  });

  it('classifies late DOM-readiness rejection as deadline but preserves an early rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const lateDeadline = 10_050;
    const latePage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(() => Promise.resolve().then(() => {
        vi.setSystemTime(lateDeadline);
        throw new Error('late DOM failure');
      })),
    } as unknown as Page;

    const late = await waitForPageSettled(latePage, {
      deadlineAtMs: lateDeadline,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });
    expect(late).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });

    vi.setSystemTime(11_000);
    const earlyPage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(async () => {
        throw new Error('early DOM failure');
      }),
    } as unknown as Page;
    const early = await waitForPageSettled(earlyPage, {
      deadlineAtMs: 11_050,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });
    expect(early).toMatchObject({ status: 'PARTIAL', reason: 'DOM_READINESS_FAILED' });
  });

  it('classifies late settling-evaluation rejection as deadline but preserves an early rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_000);
    const lateDeadline = 12_050;
    const latePage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(() => Promise.resolve().then(() => {
        vi.setSystemTime(lateDeadline);
        throw new Error('late settling evaluation failure');
      })),
    } as unknown as Page;
    const late = await waitForPageSettled(latePage, {
      deadlineAtMs: lateDeadline,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });
    expect(late).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });

    vi.setSystemTime(13_000);
    const earlyPage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => {
        throw new Error('early settling evaluation failure');
      }),
    } as unknown as Page;
    const early = await waitForPageSettled(earlyPage, {
      deadlineAtMs: 13_050,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });
    expect(early).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
  });

  it('classifies late scroll-reset rejection as deadline but preserves an early rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(14_000);
    const lateDeadline = 14_050;
    const latePage = {
      isClosed: () => false,
      evaluate: vi.fn(() => Promise.resolve().then(() => {
        vi.setSystemTime(lateDeadline);
        throw new Error('late reset failure');
      })),
    } as unknown as Page;
    const late = await controlledScroll(latePage, {
      deadlineAtMs: lateDeadline,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(late).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });

    vi.setSystemTime(15_000);
    const earlyPage = {
      isClosed: () => false,
      evaluate: vi.fn(async () => {
        throw new Error('early reset failure');
      }),
    } as unknown as Page;
    const early = await controlledScroll(earlyPage, {
      deadlineAtMs: 15_050,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(early).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
  });

  it('classifies late scroll-measure rejection as deadline but preserves an early rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(16_000);
    const lateDeadline = 16_050;
    let lateCall = 0;
    const latePage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        lateCall += 1;
        return lateCall === 1
          ? Promise.resolve('MUTATED')
          : Promise.resolve().then(() => {
            vi.setSystemTime(lateDeadline);
            throw new Error('late measure failure');
          });
      }),
    } as unknown as Page;
    const late = await controlledScroll(latePage, {
      deadlineAtMs: lateDeadline,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(late).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });

    vi.setSystemTime(17_000);
    let earlyCall = 0;
    const earlyPage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        earlyCall += 1;
        return earlyCall === 1
          ? Promise.resolve('MUTATED')
          : Promise.reject(new Error('early measure failure'));
      }),
    } as unknown as Page;
    const early = await controlledScroll(earlyPage, {
      deadlineAtMs: 17_050,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(early).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
  });

  it('classifies late scroll-step rejection as deadline but preserves an early rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(18_000);
    const lateDeadline = 18_050;
    let lateCall = 0;
    const latePage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        lateCall += 1;
        if (lateCall === 1) return Promise.resolve('MUTATED');
        if (lateCall === 2) return Promise.resolve({ scrollY: 0, viewportHeight: 100, scrollHeight: 300 });
        return Promise.resolve().then(() => {
          vi.setSystemTime(lateDeadline);
          throw new Error('late step failure');
        });
      }),
    } as unknown as Page;
    const late = await controlledScroll(latePage, {
      deadlineAtMs: lateDeadline,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(late).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });

    vi.setSystemTime(19_000);
    let earlyCall = 0;
    const earlyPage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        earlyCall += 1;
        if (earlyCall === 1) return Promise.resolve('MUTATED');
        if (earlyCall === 2) return Promise.resolve({ scrollY: 0, viewportHeight: 100, scrollHeight: 300 });
        return Promise.reject(new Error('early step failure'));
      }),
    } as unknown as Page;
    const early = await controlledScroll(earlyPage, {
      deadlineAtMs: 19_050,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(early).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
  });

  it('downgrades terminal settling and scroll success when freezing crosses the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    let activeDeadline = 20_100;
    const originalFreeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(((value: object) => {
      if (
        'status' in value
        && (value.status === 'SETTLED' || value.status === 'COMPLETE')
      ) {
        vi.setSystemTime(activeDeadline);
      }
      return originalFreeze(value);
    }) as typeof Object.freeze);
    const settlingPage = {
      isClosed: () => false,
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ readyState: 'complete' as const, scrollHeight: 100 })),
    } as unknown as Page;
    const settlingPromise = waitForPageSettled(settlingPage, {
      deadlineAtMs: activeDeadline,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const settling = await settlingPromise;
    expect(settling).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(settling.observations.every((observation) => observation.observedAtMs < activeDeadline)).toBe(true);

    vi.setSystemTime(21_000);
    activeDeadline = 21_100;
    let scrollCall = 0;
    const scrollPage = {
      isClosed: () => false,
      evaluate: vi.fn(async () => {
        scrollCall += 1;
        return scrollCall % 2 === 1
          ? 'MUTATED'
          : { scrollY: 0, viewportHeight: 100, scrollHeight: 100 };
      }),
    } as unknown as Page;
    const scrollPromise = controlledScroll(scrollPage, {
      deadlineAtMs: activeDeadline,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const scroll = await scrollPromise;
    expect(scroll).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(scroll.observations.every((observation) => observation.observedAtMs < activeDeadline)).toBe(true);
  });
});
