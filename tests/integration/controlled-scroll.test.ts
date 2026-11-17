import { performance } from 'node:perf_hooks';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { waitForPageSettled } from '../../src/browser/page-settling.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

/** L9 の前の測定の記録の数の上限（定数は LZ-1 で消した）。 */
const MAX_SCROLL_OBSERVATIONS = 500;

let browser: Browser;
let server: FixtureServer;
let context: BrowserContext;
let factory: BrowserContextFactory;

useHeadlessChromium((launched) => {
  browser = launched;
});

// CCX-21（CC-049）: page は個別に閉じず、Context と一緒に閉じる（製品と同じ。DEF-038）。各テストの page は、ここで Context ごと閉じる。
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

    // page は個別に閉じず、Context と一緒に閉じる（DEF-038。CCX-21）。閉じた後の Ledger にも違反がない。
    const ledger = factory.getSafetyLedger(context);
    await factory.closePassiveContext(context);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
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

  });

  it('traverses an inner container that scrolls more than the document scrolls by the default body margin (DEF-207)', async () => {
    // R4 の N1 の再現条件(2): body の余白は既定のまま、`<div style="height:100vh;overflow:auto">` の中に高さ 5000px の要素がある。
    // 文書は余白の分だけスクロールできるが、スクロールできる量が最も大きいのは内側の領域なので、文書の後にその領域をたどる（DEF-207）。
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
    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
      representative: { clientHeight: fixtureState.clientHeight, scrollHeight: fixtureState.scrollHeight },
    });
    // たどった後、内側の領域の位置を元（0）に戻す。
    expect(fixtureState.shellScrollTop).toBe(0);
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

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

  });

  it('traverses an inner container inside an open shadow root that scrolls more than the document (R\'2 I-3, DEF-207)', async () => {
    // R'2 の I-3: 内側の領域を探す走査は、open な shadow root の中にも入る。DEF-207: 見つけた領域をたどる。
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
    expect(result.status, JSON.stringify(result.innerScrollScan)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
      representative: { clientHeight: fixtureState.clientHeight, scrollHeight: fixtureState.scrollHeight },
    });
    expect(fixtureState.shellScrollTop).toBe(0);
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

  });

  it('returns PARTIAL when content is taller than the viewport but no document scroller exists', async () => {
    const page = await openFixturePage('/unscrollable-overflow.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status).toBe('PARTIAL');
    expect(result.reason).toBe('SCROLL_TARGET_UNRESOLVED');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.finalSnapshot?.contentHeight).toBeGreaterThan(result.finalSnapshot?.viewportHeight ?? Infinity);

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

  });

  it('traverses the only inner container while html and body cannot scroll, and returns it to its origin (DEF-207)', async () => {
    // C4 の発見事項6: html と body が overflow:hidden（高さ100%）で、内側の div だけがスクロールし、
    // その中に遅延読み込みの内容があるページ。DEF-207: 文書の後に、その領域を文書と同じ決まりでたどり、遅延読み込みを最後まで待つ。
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

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.innerScrollScan).toMatchObject({
      containerCount: 1,
      scanLimitReached: false,
    });
    expect(result.innerScrollScan?.representative?.scrollHeight)
      .toBeGreaterThan(result.innerScrollScan?.representative?.clientHeight ?? Infinity);
    expect(result.innerScrollScan?.scannedElementCount).toBeGreaterThan(0);
    expect(Object.isFrozen(result.innerScrollScan)).toBe(true);
    expect(Object.isFrozen(result.innerScrollScan?.representative)).toBe(true);
    // 内側の領域を最下部までたどったので、遅延読み込みは2回とも起き、終わった後に領域の位置は元（0）に戻っている。
    expect(fixtureState).toMatchObject({ batches: 2, shellScrollTop: 0 });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });

  });

  it('draws the late content at the bottom of the inner container and keeps it after the traversal (DEF-207)', async () => {
    const page = await openFixturePage('/inner-scroll-late-heading.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });
    const fixtureState = await page.evaluate(() => ({
      lateHeadings: [...document.querySelectorAll('[data-late-section] h2')].map((heading) => heading.textContent),
      shellScrollTop: document.querySelector('#app-shell')?.scrollTop ?? -1,
    }));

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(fixtureState).toEqual({ lateHeadings: ['Late inner heading'], shellScrollTop: 0 });
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
  });

  it('L9: stops an inner container that keeps adding batches of the same structure without a deadline (NO_NEW_STRUCTURE)', async () => {
    const page = await openFixturePage('/inner-scroll-endless.html');

    const result = await controlledScroll(page, REAL_PAGE_SCROLL_OPTIONS);
    const state = await page.evaluate(() => ({
      batches: document.querySelectorAll('[data-endless-batch]').length,
      shellScrollTop: document.querySelector('#app-shell')?.scrollTop ?? -1,
    }));

    expect(result.status, JSON.stringify(result.innerScrollContainers)).toBe('COMPLETE');
    expect(result.innerScrollContainers).toEqual([expect.objectContaining({
      stopReason: 'NO_NEW_STRUCTURE',
      originTop: 0,
      restored: true,
    })]);
    expect(result.innerScrollContainers?.[0]?.heightGrowthCount).toBeGreaterThan(0);
    expect(state.batches).toBeGreaterThan(0);
    expect(state.shellScrollTop).toBe(0);
  });

  it('keeps COMPLETE for a page that fits in the viewport and ignores hidden, clipped, or fitting boxes', async () => {
    const page = await openFixturePage('/short-content.html');

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.reason).toBe('BOTTOM_AND_HEIGHT_STABLE');
    expect(result.finalSnapshot?.scrollTarget).toBeNull();
    expect(result.innerScrollScan).toMatchObject({ containerCount: 0, scanLimitReached: false, representative: null });
    expect(result.innerScrollScan?.scannedElementCount).toBeGreaterThan(0);

  });

  it('compares inner containers with the document even when the document itself scrolls', async () => {
    // R4 の N1 で、内側の領域もスクロールの対象の候補にした。文書がスクロールする場合も走査し、領域がなければ COMPLETE。
    const page = await openLazyPage();

    const result = await controlledScroll(page, { deadlineAtMs: Date.now() + 5_000, ...REAL_PAGE_SCROLL_OPTIONS });

    expect(result.status).toBe('COMPLETE');
    expect(result.finalSnapshot?.scrollTarget).toBe('SCROLLING_ELEMENT');
    expect(result.innerScrollScan).toMatchObject({ containerCount: 0, scanLimitReached: false, representative: null });

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

  it('L9: records every observation beyond the former limit and omits none (F11, N18)', async () => {
    // L9（INV-LIMITS の表 A の N18）: 測定の記録の件数の上限は撤廃した。期限まで高さが増え続けるページでも、全部の測定を記録する。
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

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(measuredScrollYs.length).toBeGreaterThan(MAX_SCROLL_OBSERVATIONS);
    expect(result.observations).toHaveLength(measuredScrollYs.length);
    expect(result.omittedObservationCount).toBe(0);
    expect(result.observations.map((observation) => observation.scrollY)).toEqual(measuredScrollYs);
    // 最後の測定は `finalSnapshot` と一致する。
    expect(result.finalSnapshot).toEqual(result.observations.at(-1));
    expect(result.finalSnapshot?.scrollY).toBe(measuredScrollYs.at(-1));
    expect(result.heightGrowthCount).toBe(measuredScrollYs.length - 1);
    expect(Object.isFrozen(result.observations)).toBe(true);
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

  it('records POSITION_NOT_AT_ORIGIN when the traversed inner container does not return to its origin (DEF-207)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(44_000);
    const innerState = { scrollTop: 0, disposed: false };
    const innerPhases: unknown[] = [];
    const fakeHandle = {
      asElement: () => fakeHandle,
      dispose: async () => {
        innerState.disposed = true;
      },
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        // L9: 領域の位置（selector の元）の読み取りは、入力を渡さない。
        if (argument === undefined) {
          return [0, 1, 0];
        }
        const record = argument as Record<string, unknown>;
        innerPhases.push(record.phase);
        if (record.phase === 'INNER_STEP') {
          innerState.scrollTop = record.top as number;
          return 'MUTATED';
        }
        if (record.phase === 'INNER_RESTORE') {
          // ページの作りが、入れ物を元の位置へ戻させない。
          return 50;
        }
        return { connected: true, scrollTop: innerState.scrollTop, clientHeight: 100, scrollHeight: 300 };
      }),
    };
    const fakePage = {
      isClosed: () => false,
      // L9: 見つけた全部の領域の並び（JSHandle）を返す。
      evaluateHandle: vi.fn(async (_callback: unknown, argument: unknown) => {
        expect((argument as Record<string, unknown>).phase).toBe('INNER_SCROLL_LOCATE');
        return { getProperties: async () => new Map([['0', fakeHandle]]), dispose: async () => undefined };
      }),
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        const record = argument as Record<string, unknown>;
        if (record.phase === 'INNER_SCROLL_SCAN') {
          return {
            scannedElementCount: 5,
            scanLimitReached: false,
            containerCount: 1,
            representative: { clientHeight: 100, scrollHeight: 300 },
          };
        }
        if (record.phase === 'RESET' || record.phase === 'RESTORE') {
          return { scrollX: 0, scrollY: 0 };
        }
        if (record.phase === 'STEP') {
          return 'MUTATED';
        }
        // 文書は動かない（内側の入れ物だけが動く）。
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
      deadlineAtMs: 45_000,
      stepViewportFraction: 0.5,
      stepWaitMs: 8,
      stableWindowMs: 15,
    });
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'COMPLETE', reason: 'BOTTOM_AND_HEIGHT_STABLE' });
    expect(innerPhases).toContain('INNER_STEP');
    expect(innerPhases.at(-1)).toBe('INNER_RESTORE');
    expect(result.restoration).toEqual({ status: 'NOT_RESTORED', reason: 'POSITION_NOT_AT_ORIGIN', position: null });
    expect(result.innerScrollContainers).toEqual([expect.objectContaining({
      selector: ':root > :nth-child(2) > :nth-child(1)',
      originTop: 0,
      maxScrollTop: 200,
      reachedBottom: true,
      stopReason: 'BOTTOM_AND_HEIGHT_STABLE',
      restored: false,
    })]);
    expect(innerState.disposed).toBe(true);
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
    // DEF-073: ブラウザの中の関数は、`document` のプロパティを `Document.prototype` の getter で読む。偽の `Document` の prototype に、
    // 偽の `document` の値を返す getter（`scrollingElement`・`documentElement`・`body`）を置く。
    const fakeDocumentConstructor = {
      prototype: Object.defineProperties({}, Object.fromEntries(
        (['scrollingElement', 'documentElement', 'body'] as const).map((name) => [
          name,
          { get(this: typeof fakeDocument): unknown { return this[name]; } },
        ]),
      )),
    };
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
        const previousDocumentConstructor = Object.getOwnPropertyDescriptor(globalThis, 'Document');
        Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
        Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
        Object.defineProperty(globalThis, 'Document', { value: fakeDocumentConstructor, configurable: true });
        try {
          return callback(argument);
        } finally {
          Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
          Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true });
          if (previousDocumentConstructor === undefined) {
            Reflect.deleteProperty(globalThis, 'Document');
          } else {
            Object.defineProperty(globalThis, 'Document', previousDocumentConstructor);
          }
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

  // L9: 本番は controlledScroll に期限を渡さないので、期限を過ぎた失敗の分け方の確かめは外した（期限の代表は
  // 'returns honest PARTIAL metadata at the absolute deadline without hanging'）。ブラウザの中の失敗は、どの段でも EVALUATION_FAILED にする。
  it.each([
    ['reset', 0],
    ['measure', 1],
    ['step', 2],
  ] as const)('classifies a scroll-%s rejection as an evaluation failure', async (phase, succeededCalls) => {
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
    vi.setSystemTime(15_000);
    let call = 0;
    const page = {
      isClosed: () => false,
      evaluate: vi.fn(() => {
        call += 1;
        if (call > succeededCalls) return Promise.reject(new Error(`${phase} failure`));
        return Promise.resolve(call === 1 ? 'MUTATED' : tallMeasurement);
      }),
    } as unknown as Page;
    const result = await controlledScroll(page, {
      deadlineAtMs: 15_050,
      stepViewportFraction: 0.5,
      stepWaitMs: 10,
      stableWindowMs: 10,
    });
    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
  });
});
