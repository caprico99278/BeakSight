import { performance } from 'node:perf_hooks';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import {
  controlledScroll,
  MAX_LEADING_SCROLL_OBSERVATIONS,
  MAX_SCROLL_OBSERVATIONS,
} from '../../src/browser/controlled-scroll.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import { VISIBILITY_CHECK_OPTIONS } from '../../src/core/visibility.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let server: FixtureServer;
let context: BrowserContext;
let factory: BrowserContextFactory;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  vi.useRealTimers();
  await closePassiveResources({ factory, context }, { forceCloseContextOnFailure: true });
  await server?.close();
});

async function openFixturePage(pathname: string) {
  server = await startFixtureServer();
  factory = new BrowserContextFactory(browser, createTestConfig(server.origin, pathname), () => new SafetyLedger());
  context = await factory.createPassiveContext({ width: 800, height: 600 });
  const page = await factory.createPassivePage(context);
  await page.goto(`${server.origin}${pathname}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openLazyPage() {
  return openFixturePage('/lazy-content.html');
}

/** 偽のページが、内側のスクロール領域の走査（phase: INNER_SCROLL_SCAN）に返す「領域なし」の結果。 */
const EMPTY_INNER_SCROLL_SCAN = Object.freeze({
  scannedElementCount: 3,
  scanLimitReached: false,
  containerCount: 0,
  representative: null,
});

const REAL_PAGE_SCROLL_OPTIONS = Object.freeze({
  stepViewportFraction: 0.75,
  stepWaitMs: 25,
  stableWindowMs: 100,
});

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
    // 最後の観測で最下部に達し、終了時には先頭（0, 0）に戻っている（設計書 foundation-corrections 5.2）。
    const finalSnapshot = result.finalSnapshot;
    expect(finalSnapshot?.atBottom).toBe(true);
    expect(finalSnapshot?.scrollTarget).toBe('SCROLLING_ELEMENT');
    expect((finalSnapshot?.scrollY ?? 0) + (finalSnapshot?.viewportHeight ?? 0))
      .toBeGreaterThanOrEqual(fixtureState.scrollHeight - 1);
    expect(fixtureState.scrollY).toBe(0);
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
    expect(Object.isFrozen(result.finalSnapshot)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.restoration)).toBe(true);

    await factory.closePassivePage(page);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  });

  it('tracks a scrolling body when the root element cannot scroll and returns it to the top', async () => {
    // レビュー V2 の再現条件: html{overflow:hidden} body{overflow:auto}（どちらも height:100%）。
    const page = await openFixturePage('/body-scroll.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => ({
      batches: document.querySelectorAll('[data-lazy-batch]').length,
      bodyScrollTop: document.body.scrollTop,
      windowScrollY: window.scrollY,
    }));

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.observations.some((observation) => observation.scrollY > 0)).toBe(true);
    expect(result.finalSnapshot?.scrollTarget).toBe('BODY');
    expect(result.finalSnapshot?.atBottom).toBe(true);
    expect(result.heightGrowthCount).toBeGreaterThanOrEqual(1);
    expect(fixtureState.batches).toBe(2);
    expect(fixtureState).toMatchObject({ bodyScrollTop: 0, windowScrollY: 0 });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

    await factory.closePassivePage(page);
  });

  it('traverses the scrolling body to its bottom even when the document scrolls by the default body margin', async () => {
    // R4 の N1 の再現条件(1): html{height:100%;overflow:hidden}・body{height:100%;overflow:auto} で、body の余白は既定（8px）。
    // 文書も余白の分（16px）だけスクロールできるが、スクロールできる量が最も大きいのは body なので、body をたどる。
    const page = await openFixturePage('/body-scroll-default-margin.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        rootScrollRange: root.scrollHeight - root.clientHeight,
        bodyScrollRange: document.body.scrollHeight - document.body.clientHeight,
        bodyScrollHeight: document.body.scrollHeight,
        bodyScrollTop: document.body.scrollTop,
        windowScrollY: window.scrollY,
      };
    });

    // 前提: 文書も少しだけスクロールでき、body のほうが大きくスクロールできる。
    expect(fixtureState.rootScrollRange).toBeGreaterThan(1);
    expect(fixtureState.bodyScrollRange).toBeGreaterThan(fixtureState.rootScrollRange);
    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.finalSnapshot?.scrollTarget).toBe('BODY');
    expect(result.finalSnapshot?.atBottom).toBe(true);
    expect((result.finalSnapshot?.scrollY ?? 0) + (result.finalSnapshot?.viewportHeight ?? 0))
      .toBeGreaterThanOrEqual(fixtureState.bodyScrollHeight - 1);
    expect(result.innerScrollScan).toMatchObject({ containerCount: 0, scanLimitReached: false, representative: null });
    expect(fixtureState).toMatchObject({ bodyScrollTop: 0, windowScrollY: 0 });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL when an inner container scrolls more than the document scrolls by the default body margin', async () => {
    // R4 の N1 の再現条件(2): body の余白は既定のまま、`<div style="height:100vh;overflow:auto">` の中に高さ 5000px の要素がある。
    // 文書は余白の分だけスクロールできるが、スクロールできる量が最も大きいのは内側の領域なので、COMPLETE にしない。
    const page = await openFixturePage('/inner-scroll-default-margin.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      const shell = document.querySelector('#app-shell');
      return {
        rootScrollRange: root.scrollHeight - root.clientHeight,
        clientHeight: shell?.clientHeight ?? -1,
        scrollHeight: shell?.scrollHeight ?? -1,
        shellScrollTop: shell?.scrollTop ?? -1,
      };
    });

    expect(fixtureState.rootScrollRange).toBeGreaterThan(1);
    expect(result.status, JSON.stringify(result)).toBe('PARTIAL');
    expect(result.reason).toBe('INNER_SCROLL_CONTAINER_NOT_TRAVERSED');
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
      representative: { clientHeight: fixtureState.clientHeight, scrollHeight: fixtureState.scrollHeight },
    });
    // 内側の領域はたどらない。
    expect(fixtureState.shellScrollTop).toBe(0);

    await factory.closePassivePage(page);
  });

  it('switches once to the body when the body grows larger than the traversed document before completion (R\'2 I-1)', async () => {
    // R'2 の I-1 の再現条件: html{height:100%;overflow:hidden} body{height:100%;overflow:auto} で、10px の div が 150ms 後に
    // 5000px になる。最初は文書だけが余白の分スクロールできるので文書をたどるが、完了と判定する前に測り直すと body のほうが
    // 大きいので、1回だけ body に切り替えて最下部までたどる。伸びる前に完了と判定しないよう、安定を待つ時間を長くする。
    const page = await openFixturePage('/body-scroll-late-growth.html');

    const result = await controlledScroll(page, {
      deadlineAtMs: Date.now() + 10_000,
      ...REAL_PAGE_SCROLL_OPTIONS,
      stableWindowMs: 500,
    });
    const fixtureState = await page.evaluate(() => ({
      grown: document.querySelector('#late-content')?.getAttribute('data-grown') ?? null,
      bodyScrollHeight: document.body.scrollHeight,
      bodyScrollTop: document.body.scrollTop,
      windowScrollY: window.scrollY,
    }));

    expect(fixtureState.grown).toBe('true');
    expect(result.status, JSON.stringify(result.finalSnapshot)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.finalSnapshot?.scrollTarget).toBe('BODY');
    // 対象を1回切り替えたことを、scroll の Evidence に記録する（F12）。
    expect(result.targetSwitchCount).toBe(1);
    expect(result.finalSnapshot?.atBottom).toBe(true);
    expect((result.finalSnapshot?.scrollY ?? 0) + (result.finalSnapshot?.viewportHeight ?? 0))
      .toBeGreaterThanOrEqual(fixtureState.bodyScrollHeight - 1);
    expect(fixtureState).toMatchObject({ bodyScrollTop: 0, windowScrollY: 0 });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL when an inner container inside an open shadow root scrolls more than the document (R\'2 I-3)', async () => {
    // R'2 の I-3: 内側の領域を探す走査は、open な shadow root の中にも入る。
    const page = await openFixturePage('/shadow-inner-scroll.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      const shell = document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#app-shell');
      return {
        rootScrollRange: root.scrollHeight - root.clientHeight,
        clientHeight: shell?.clientHeight ?? -1,
        scrollHeight: shell?.scrollHeight ?? -1,
        shellScrollTop: shell?.scrollTop ?? -1,
      };
    });

    expect(fixtureState.rootScrollRange).toBeGreaterThan(1);
    expect(result.status, JSON.stringify(result.innerScrollScan)).toBe('PARTIAL');
    expect(result.reason).toBe('INNER_SCROLL_CONTAINER_NOT_TRAVERSED');
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
      representative: { clientHeight: fixtureState.clientHeight, scrollHeight: fixtureState.scrollHeight },
    });
    expect(fixtureState.shellScrollTop).toBe(0);

    await factory.closePassivePage(page);
  });

  it('counts the elements inside open shadow roots toward the inner container scan limit (R\'2 I-3)', async () => {
    // light DOM の要素は少なく、shadow root の中に上限を超える数の要素がある。文書は余白の分だけスクロールできる。
    const page = await openFixturePage('/shadow-scan-limit.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 10_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const lightElementCount = await page.evaluate(() => document.getElementsByTagName('*').length);

    expect(result.status, JSON.stringify(result.innerScrollScan)).toBe('COMPLETE');
    expect(result.finalSnapshot?.scrollTarget).toBe('SCROLLING_ELEMENT');
    expect(result.innerScrollScan?.scanLimitReached).toBe(true);
    expect(result.innerScrollScan?.scannedElementCount).toBeGreaterThan(lightElementCount);

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL when content is taller than the viewport but no document scroller exists', async () => {
    const page = await openFixturePage('/unscrollable-overflow.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('SCROLL_TARGET_UNRESOLVED');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.finalSnapshot?.contentHeight).toBeGreaterThan(result.finalSnapshot?.viewportHeight ?? Infinity);

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL instead of waiting for the deadline when the document never advances', async () => {
    const page = await openFixturePage('/scroll-locked.html');
    const startedAt = performance.now();
    const deadlineAtMs = Date.now() + 5_000;

    const result = await controlledScroll(page, { deadlineAtMs, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('SCROLL_NOT_ADVANCED');
    expect(result.observations.every((observation) => !observation.atBottom)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2_500);

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL when only an inner container scrolls while html and body cannot scroll', async () => {
    // C4 の発見事項6: html と body が overflow:hidden（高さ100%）で、内側の div だけがスクロールし、
    // その中に遅延読み込みの内容があるページ。内側の領域は追わないので、COMPLETE にしてはいけない。
    const page = await openFixturePage('/inner-scroll-container.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => {
      const shell = document.querySelector('#app-shell');
      return {
        batches: document.querySelectorAll('[data-lazy-batch]').length,
        clientHeight: shell?.clientHeight ?? -1,
        scrollHeight: shell?.scrollHeight ?? -1,
        shellScrollTop: shell?.scrollTop ?? -1,
      };
    });

    expect(result.status, JSON.stringify(result)).toBe('PARTIAL');
    expect(result.reason).toBe('INNER_SCROLL_CONTAINER_NOT_TRAVERSED');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
      representative: { clientHeight: fixtureState.clientHeight, scrollHeight: fixtureState.scrollHeight },
    });
    expect(result.innerScrollScan?.representative?.scrollHeight)
      .toBeGreaterThan(result.innerScrollScan?.representative?.clientHeight ?? Infinity);
    expect(result.innerScrollScan?.scannedElementCount).toBeGreaterThan(0);
    expect(Object.isFrozen(result.innerScrollScan)).toBe(true);
    expect(Object.isFrozen(result.innerScrollScan?.representative)).toBe(true);
    // 内側の領域を動かしていないので、遅延読み込みは起きていない。
    expect(fixtureState).toMatchObject({ batches: 0, shellScrollTop: 0 });

    await factory.closePassivePage(page);
  });

  it('keeps COMPLETE for a page that fits in the viewport and ignores hidden, clipped, or fitting boxes', async () => {
    const page = await openFixturePage('/short-content.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.innerScrollScan).toMatchObject({ containerCount: 0, scanLimitReached: false, representative: null });
    expect(result.innerScrollScan?.scannedElementCount).toBeGreaterThan(0);

    await factory.closePassivePage(page);
  });

  it('compares inner containers with the document even when the document itself scrolls', async () => {
    // R4 の N1 で、内側の領域もスクロールの対象の候補にした。文書がスクロールする場合も走査し、領域がなければ COMPLETE。
    const page = await openLazyPage();

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status).toBe('COMPLETE');
    expect(result.finalSnapshot?.scrollTarget).toBe('SCROLLING_ELEMENT');
    expect(result.innerScrollScan).toMatchObject({ containerCount: 0, scanLimitReached: false, representative: null });

    await factory.closePassivePage(page);
  });

  it('returns PARTIAL with the recorded fact when the inner container scan reaches its limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(34_000);
    const scanArguments: unknown[] = [];
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          scanArguments.push(argument);
          return {
            scannedElementCount: record.maxElements,
            scanLimitReached: true,
            containerCount: 0,
            representative: null,
          };
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        return {
          scrollTarget: null,
          scrollY: 0,
          viewportHeight: 100,
          scrollHeight: 100,
          contentHeight: 100,
          documentScrollRange: 0,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 35_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'INNER_SCROLL_SCAN_LIMIT_REACHED' });
    expect(scanArguments).toHaveLength(1);
    const scanArgument = scanArguments[0] as Record<string, unknown>;
    expect(scanArgument.visibilityOptions).toEqual(VISIBILITY_CHECK_OPTIONS);
    expect(Number.isSafeInteger(scanArgument.maxElements) && (scanArgument.maxElements as number) > 0).toBe(true);
    expect(result.innerScrollScan).toEqual({
      scannedElementCount: scanArgument.maxElements,
      scanLimitReached: true,
      containerCount: 0,
      representative: null,
    });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
  });

  it('keeps COMPLETE when the traversed document scrolls more than the largest inner container', async () => {
    // R4 の N1: スクロールできる量が最も大きい候補をたどる。内側の領域のほうが小さければ、たどった文書で COMPLETE にする。
    vi.useFakeTimers();
    vi.setSystemTime(38_000);
    const smallerInnerScan = Object.freeze({
      scannedElementCount: 10,
      scanLimitReached: false,
      containerCount: 1,
      representative: Object.freeze({ clientHeight: 100, scrollHeight: 250 }),
    });
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return smallerInnerScan;
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        // 文書は 200px（300 - 100）スクロールでき、最下部にいる。内側の領域は 150px（250 - 100）。
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY: 200,
          viewportHeight: 100,
          scrollHeight: 300,
          contentHeight: 300,
          documentScrollRange: 200,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 39_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'COMPLETE', reason: 'BOTTOM_AND_HEIGHT_STABLE' });
    expect(result.innerScrollScan).toEqual(smallerInnerScan);
  });

  it('keeps COMPLETE and records the scan limit when the scan reaches its limit after traversing the document (R\'2 m1)', async () => {
    // 設計書 foundation-corrections 5.1（F08 の判断）: 文書をたどった後に走査が上限に達しても COMPLETE のままにし、
    // 上限に達したことを `innerScrollScan.scanLimitReached` に記録する。
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return {
            scannedElementCount: record.maxElements,
            scanLimitReached: true,
            containerCount: 0,
            representative: null,
          };
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        // 文書は 200px スクロールでき、最下部にいる。
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY: 200,
          viewportHeight: 100,
          scrollHeight: 300,
          contentHeight: 300,
          documentScrollRange: 200,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 41_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'COMPLETE', reason: 'BOTTOM_AND_HEIGHT_STABLE' });
    expect(result.finalSnapshot?.scrollTarget).toBe('SCROLLING_ELEMENT');
    expect(result.innerScrollScan).toMatchObject({ scanLimitReached: true, containerCount: 0, representative: null });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
  });

  it('returns PARTIAL SCROLL_TARGET_UNSTABLE when the larger candidate changes again after the one switch (R\'2 I-1)', async () => {
    // 1回目の測り直しで body のほうが大きくなったので body に切り替えるが、body をたどった後の測り直しで、
    // 再び文書のほうが大きくなっている。2回目も対象が変わったので、COMPLETE にしない。
    vi.useFakeTimers();
    vi.setSystemTime(42_000);
    const measuredTargets: unknown[] = [];
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        measuredTargets.push(record.lockedTarget);
        if (record.lockedTarget === 'BODY') {
          // body は 500px スクロールでき、最下部にいる。文書は 900px スクロールできるようになった。
          return {
            scrollTarget: 'BODY',
            scrollY: 500,
            viewportHeight: 100,
            scrollHeight: 600,
            contentHeight: 1_000,
            documentScrollRange: 900,
            bodyScrollRange: 500,
          };
        }
        // 文書は 200px スクロールでき、最下部にいる。最初の測定では body はスクロールできず、その後 500px になる。
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY: 200,
          viewportHeight: 100,
          scrollHeight: 300,
          contentHeight: 600,
          documentScrollRange: 200,
          bodyScrollRange: record.lockedTarget === null ? 0 : 500,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 43_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'SCROLL_TARGET_UNSTABLE', targetSwitchCount: 1 });
    expect(measuredTargets).toContain('SCROLLING_ELEMENT');
    expect(measuredTargets).toContain('BODY');
    expect(result.observations.some((observation) => observation.scrollTarget === 'SCROLLING_ELEMENT')).toBe(true);
    expect(result.finalSnapshot?.scrollTarget).toBe('BODY');
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
  });

  it('caps the recorded observations, keeps the first and the last ones, and records the omitted count (F11)', async () => {
    // 設計書 foundation-corrections 5.8: 期限まで高さが増え続ける敵対的なページでも、観測の記録の件数に上限を設け、
    // 切り捨てた件数を記録する。最初の測定と、判定の直前の最後の測定を残す。
    vi.useFakeTimers();
    vi.setSystemTime(44_000);
    const measuredScrollYs: number[] = [];
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        // 測るたびに位置が進み、高さも増える（最下部に届かない）。
        const scrollY = measuredScrollYs.length * 10;
        measuredScrollYs.push(scrollY);
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY,
          viewportHeight: 100,
          scrollHeight: scrollY + 10_000,
          contentHeight: scrollY + 10_000,
          documentScrollRange: scrollY + 9_900,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 44_000 + MAX_SCROLL_OBSERVATIONS * 3,
      stepViewportFraction: 0.5,
      stepWaitMs: 1,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(MAX_SCROLL_OBSERVATIONS * 3 + 100);
    const result = await resultPromise;

    const trailingCount = MAX_SCROLL_OBSERVATIONS - MAX_LEADING_SCROLL_OBSERVATIONS;
    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(measuredScrollYs.length).toBeGreaterThan(MAX_SCROLL_OBSERVATIONS);
    expect(result.observations).toHaveLength(MAX_SCROLL_OBSERVATIONS);
    expect(result.omittedObservationCount).toBe(measuredScrollYs.length - MAX_SCROLL_OBSERVATIONS);
    expect(result.observations.map((observation) => observation.scrollY)).toEqual([
      ...measuredScrollYs.slice(0, MAX_LEADING_SCROLL_OBSERVATIONS),
      ...measuredScrollYs.slice(-trailingCount),
    ]);
    // 最後の測定は切り捨てず、`finalSnapshot` と一致する。高さが増えた回数は、切り捨てた測定も含めて数える。
    expect(result.finalSnapshot).toEqual(result.observations.at(-1));
    expect(result.finalSnapshot?.scrollY).toBe(measuredScrollYs.at(-1));
    expect(result.heightGrowthCount).toBe(measuredScrollYs.length - 1);
    expect(Object.isFrozen(result.observations)).toBe(true);
  });

  it('records no omitted observation while the observations stay within the limit (F11)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(46_000);
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY: 200,
          viewportHeight: 100,
          scrollHeight: 300,
          contentHeight: 300,
          documentScrollRange: 200,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 47_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'COMPLETE', omittedObservationCount: 0, targetSwitchCount: 0 });
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.length).toBeLessThan(MAX_SCROLL_OBSERVATIONS);
  });

  it('treats an invalid inner container scan result as an evaluation failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(36_000);
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          // 領域が1つあるのに代表がない、矛盾した結果。
          return { scannedElementCount: 10, scanLimitReached: false, containerCount: 1, representative: null };
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        return {
          scrollTarget: null,
          scrollY: 0,
          viewportHeight: 100,
          scrollHeight: 100,
          contentHeight: 100,
          documentScrollRange: 0,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 37_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED', innerScrollScan: null });
  });

  it('refuses COMPLETE when a bottom observation never scrolled through content taller than the viewport', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    let call = 0;
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async () => {
        call += 1;
        return call % 2 === 1
          ? 'MUTATED'
          : {
              scrollTarget: 'SCROLLING_ELEMENT',
              scrollY: 0,
              viewportHeight: 100,
              scrollHeight: 100,
              contentHeight: 300,
              documentScrollRange: 0,
              bodyScrollRange: 0,
            };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 31_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'SCROLL_NOT_ADVANCED' });
  });

  it('records a failed return to the document origin without hiding the completed scroll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(32_000);
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'RESTORE') {
          throw new Error('restore failed');
        }
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        if (record.phase === 'RESET' || record.phase === 'STEP') {
          return 'MUTATED';
        }
        return {
          scrollTarget: 'SCROLLING_ELEMENT',
          scrollY: 200,
          viewportHeight: 100,
          scrollHeight: 300,
          contentHeight: 300,
          documentScrollRange: 200,
          bodyScrollRange: 0,
        };
      }),
    } as unknown as Page;

    const resultPromise = controlledScroll(fakePage, {
      deadlineAtMs: 33_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'COMPLETE', reason: 'BOTTOM_AND_HEIGHT_STABLE' });
    expect(result.restoration).toEqual({ status: 'NOT_RESTORED', reason: 'EVALUATION_FAILED', position: null });
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
    expect(result.restoration).toEqual({ status: 'NOT_RESTORED', reason: 'DEADLINE_EXCEEDED', position: null });
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
      scrollX: 0,
      scrollY: 0,
      innerHeight: 100,
      scrollTo: vi.fn(),
    };
    const fakeRoot = { scrollTop: 0, clientHeight: 100, scrollHeight: 100, scrollTo: vi.fn() };
    const fakeDocument = { scrollingElement: fakeRoot, documentElement: fakeRoot, body: null };
    const fakePage = {
      isClosed: () => false,
      evaluate: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
        if ((argument as { readonly phase?: unknown }).phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        if ((argument as { readonly phase?: unknown }).phase === 'MEASURE') {
          fakeRoot.scrollHeight = heights[Math.min(measurement, heights.length - 1)] ?? 50;
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
    expect(result.innerScrollScan).toEqual(EMPTY_INNER_SCROLL_SCAN);
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

  it('classifies a settling-evaluation rejection through pageFailureReason when isClosed throws (C8, F04)', async () => {
    let isClosedCalls = 0;
    const page = {
      isClosed: () => {
        isClosedCalls += 1;
        if (isClosedCalls > 2) {
          throw new Error('page state is unavailable');
        }
        return false;
      },
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => {
        throw new Error('settling evaluation failure');
      }),
    } as unknown as Page;

    const result = await waitForPageSettled(page, {
      deadlineAtMs: Date.now() + 5_000,
      pollIntervalMs: 10,
      stableWindowMs: 10,
    });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
    expect(isClosedCalls).toBe(3);
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
    const tallMeasurement = {
      scrollTarget: 'SCROLLING_ELEMENT',
      scrollY: 0,
      viewportHeight: 100,
      scrollHeight: 300,
      contentHeight: 300,
      documentScrollRange: 200,
      bodyScrollRange: 0,
    };
    vi.useFakeTimers();
    vi.setSystemTime(18_000);
    const lateDeadline = 18_050;
    let lateCall = 0;
    const latePage = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        lateCall += 1;
        if (lateCall === 1) return Promise.resolve('MUTATED');
        if (lateCall === 2) return Promise.resolve(tallMeasurement);
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
        if (earlyCall === 2) return Promise.resolve(tallMeasurement);
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
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        if ((argument as { readonly phase?: unknown }).phase === 'INNER_SCROLL_SCAN') {
          return EMPTY_INNER_SCROLL_SCAN;
        }
        scrollCall += 1;
        return scrollCall % 2 === 1
          ? 'MUTATED'
          : {
              scrollTarget: null,
              scrollY: 0,
              viewportHeight: 100,
              scrollHeight: 100,
              contentHeight: 100,
              documentScrollRange: 0,
              bodyScrollRange: 0,
            };
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
