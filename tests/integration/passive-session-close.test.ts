// CC-018: page と Context を閉じる手順（page を閉じてから Context を閉じる。Guard がすでに Context を閉じていれば、
// Context は閉じ直さない）と、その失敗の一覧を返す部品。例外にするか理由にするかは、呼び出し側が決める。
import { createServer } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory, ContextConstructionError } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { PAGE_CLOSE_TIMEOUT_MS } from '../../src/core/limits.js';
import { navigatePage } from '../../src/orchestration/page-navigation.js';
import {
  closePassiveContextBeforeDeadline,
  closePassivePageAndContext,
  closePassivePageBeforeDeadline,
  PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE,
  PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
  PassivePageCloseDeadlineError,
} from '../../src/orchestration/passive-session-close.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

const VIEWPORT: Viewport = Object.freeze({ width: 800, height: 600 });
const ORIGIN = 'http://127.0.0.1:9';

let browser: Browser;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  for (const context of browser.contexts()) {
    await context.close();
  }
  vi.restoreAllMocks();
});

/** 注入する短い期限（ms）。実際の期限（`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を待たない（R15r-4）。 */
const SHORT_CLOSE_TIMEOUT_MS = 200;
/** 期限を過ぎてから戻るまでの余裕（偽の factory の場合）。 */
const FAKE_CLOSE_MARGIN_MS = 1_000;
/** 期限のテストの上限。注入した期限を守らない（既定の期限を待つ）場合は、この時間で失敗する。 */
const SHORT_DEADLINE_TEST_TIMEOUT_MS = 3_000;
/** タイマーが少し早く発火する場合の許容。 */
const TIMER_TOLERANCE_MS = 50;

/** 閉じる処理の呼び出しを記録する、偽の factory。Guard の状態を持たない偽の Context は、Guard が閉じていないと判定される。 */
function fakeFactory(
  behavior: {
    readonly pageError?: Error;
    readonly contextError?: Error;
    /** 真なら、page を閉じる処理が終わらない。 */
    readonly pageHangs?: boolean;
    /** 真なら、Context を閉じる処理が終わらない。 */
    readonly contextHangs?: boolean;
  } = {},
) {
  const events: string[] = [];
  const factory = {
    closePassivePage: async (): Promise<void> => {
      events.push('closePage');
      if (behavior.pageHangs === true) await new Promise<never>(() => undefined);
      if (behavior.pageError !== undefined) throw behavior.pageError;
    },
    closePassiveContext: async (): Promise<void> => {
      events.push('closeContext');
      if (behavior.contextHangs === true) await new Promise<never>(() => undefined);
      if (behavior.contextError !== undefined) throw behavior.contextError;
    },
  };
  return { factory, events };
}

const fakeContext = { name: 'context' } as unknown as BrowserContext;
const fakePage = { name: 'page' } as unknown as Page;

describe('closePassivePageAndContext (CC-018)', () => {
  it('does nothing when there is no Context', async () => {
    const { factory, events } = fakeFactory();

    const failures = await closePassivePageAndContext(factory, undefined, fakePage);

    expect(failures).toEqual([]);
    expect(events).toEqual([]);
  });

  it('closes the page before the Context and returns no failures', async () => {
    const { factory, events } = fakeFactory();

    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage);

    expect(failures).toEqual([]);
    expect(Object.isFrozen(failures)).toBe(true);
    expect(events).toEqual(['closePage', 'closeContext']);
  });

  it('closes only the Context when there is no page', async () => {
    const { factory, events } = fakeFactory();

    await expect(closePassivePageAndContext(factory, fakeContext, undefined)).resolves.toEqual([]);
    expect(events).toEqual(['closeContext']);
  });

  it('still closes the Context after the page close failed and returns the page failure as it was thrown', async () => {
    const pageError = new Error('page close failed');
    const { factory, events } = fakeFactory({ pageError });

    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage);

    expect(events).toEqual(['closePage', 'closeContext']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.step).toBe('page');
    expect(failures[0]?.error).toBe(pageError);
    expect(Object.isFrozen(failures[0])).toBe(true);
  });

  it('returns the Context close failure', async () => {
    const contextError = new Error('context close failed');
    const { factory } = fakeFactory({ contextError });

    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage);

    expect(failures.map(({ step }) => step)).toEqual(['context']);
    expect(failures[0]?.error).toBe(contextError);
  });

  it('returns both failures in the order page, Context', async () => {
    const pageError = new Error('page close failed');
    const contextError = new Error('context close failed');
    const { factory } = fakeFactory({ pageError, contextError });

    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage);

    expect(failures.map(({ step, error }) => ({ step, error }))).toEqual([
      { step: 'page', error: pageError },
      { step: 'context', error: contextError },
    ]);
  });

  it('does not close again a Context that the Guard closed after its installation failed', async () => {
    const factory = new BrowserContextFactory(
      browserOpeningPageAfterNewContext(browser),
      createTestConfig(ORIGIN),
      () => new SafetyLedger(),
    );
    const failure: unknown = await factory.createPassiveContext(VIEWPORT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContextConstructionError);
    const { context } = failure as ContextConstructionError;
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    const closeContext = vi.spyOn(factory, 'closePassiveContext');

    await expect(closePassivePageAndContext(factory, context, undefined)).resolves.toEqual([]);
    expect(closeContext).not.toHaveBeenCalled();
  });

  it('returns only the page failure when the page close failure made the Guard close the Context', async () => {
    const factory = new BrowserContextFactory(browser, createTestConfig(ORIGIN), () => new SafetyLedger());
    const context = await factory.createPassiveContext(VIEWPORT);
    const page = await factory.createPassivePage(context);
    const pageError = new Error('fixture page close failure');
    vi.spyOn(page, 'close').mockRejectedValueOnce(pageError);
    const closeContext = vi.spyOn(factory, 'closePassiveContext');

    const failures = await closePassivePageAndContext(factory, context, page);

    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(failures.map(({ step, error }) => ({ step, error }))).toEqual([{ step: 'page', error: pageError }]);
    expect(closeContext).not.toHaveBeenCalled();
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations.map(({ code }) => code))
      .toContain('GUARDED_PAGE_CLOSE_FAILED');
  });
});

// R15r-4: page を閉じる処理の期限は、注入できる。既定値は `PAGE_CLOSE_TIMEOUT_MS`。
describe('closePassivePageBeforeDeadline with an injected deadline (R15r-4)', () => {
  it('returns the page close deadline failure at the injected deadline', async () => {
    const { factory, events } = fakeFactory({ pageHangs: true });

    const startedAt = performance.now();
    const failure = await closePassivePageBeforeDeadline(factory, fakePage, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(failure?.step).toBe('page');
    expect(failure?.error).toBeInstanceOf(PassivePageCloseDeadlineError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(events).toEqual(['closePage']);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);

  it('rejects a deadline that is not a positive safe integer', async () => {
    const { factory, events } = fakeFactory();

    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(closePassivePageBeforeDeadline(factory, fakePage, { timeoutMs })).rejects.toThrow(RangeError);
    }
    expect(events).toEqual([]);
  });
});

// DEF-008: Context を閉じる処理に期限を付ける（Task 18 の前の整理の設計書 4.2、4.3）。既定値は `CONTEXT_CLOSE_TIMEOUT_MS`。
describe('closePassiveContextBeforeDeadline (DEF-008)', () => {
  it('returns null when the Context closes before the deadline', async () => {
    const { factory, events } = fakeFactory();

    await expect(closePassiveContextBeforeDeadline(factory, fakeContext)).resolves.toBeNull();
    expect(events).toEqual(['closeContext']);
  });

  it('returns the Context close failure as it was thrown', async () => {
    const contextError = new Error('context close failed');
    const { factory } = fakeFactory({ contextError });

    const failure = await closePassiveContextBeforeDeadline(factory, fakeContext);

    expect(failure).toEqual({ step: 'context', error: contextError });
    expect(failure?.error).toBe(contextError);
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('returns the Context close deadline failure at the injected deadline when closing does not finish', async () => {
    const { factory, events } = fakeFactory({ contextHangs: true });

    const startedAt = performance.now();
    const failure = await closePassiveContextBeforeDeadline(factory, fakeContext, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(failure?.step).toBe('context');
    expect(failure?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
    expect((failure?.error as Error).message).toBe(PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(events).toEqual(['closeContext']);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);

  it('contains a rejection that arrives after the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectLate!: (reason: unknown) => void;
      const factory = {
        closePassivePage: async (): Promise<void> => undefined,
        closePassiveContext: () => new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        }),
      };

      const failure = await closePassiveContextBeforeDeadline(factory, fakeContext, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
      rejectLate(new Error('late context close failure'));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(failure?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);

  it('does not close again a Context that the Guard already closed', async () => {
    const factory = new BrowserContextFactory(
      browserOpeningPageAfterNewContext(browser),
      createTestConfig(ORIGIN),
      () => new SafetyLedger(),
    );
    const failure: unknown = await factory.createPassiveContext(VIEWPORT).catch((error: unknown) => error);
    const { context } = failure as ContextConstructionError;
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    const closeContext = vi.spyOn(factory, 'closePassiveContext');

    await expect(closePassiveContextBeforeDeadline(factory, context)).resolves.toBeNull();
    expect(closeContext).not.toHaveBeenCalled();
  });

  it('closes a real guarded Context', async () => {
    const factory = new BrowserContextFactory(browser, createTestConfig(ORIGIN), () => new SafetyLedger());
    const context = await factory.createPassiveContext(VIEWPORT);

    await expect(closePassiveContextBeforeDeadline(factory, context)).resolves.toBeNull();
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  });

  it('rejects a deadline that is not a positive safe integer', async () => {
    const { factory, events } = fakeFactory();

    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(closePassiveContextBeforeDeadline(factory, fakeContext, { timeoutMs })).rejects.toThrow(RangeError);
    }
    expect(events).toEqual([]);
  });
});

// DEF-008: `closePassivePageAndContext` は、Context を `closePassiveContextBeforeDeadline` で閉じる。期限は、どちらも注入できる。
describe('closePassivePageAndContext with deadlines (DEF-008)', () => {
  it('returns the Context close deadline failure when closing the Context does not finish', async () => {
    const { factory, events } = fakeFactory({ contextHangs: true });

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage, {
      pageCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(events).toEqual(['closePage', 'closeContext']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.step).toBe('context');
    expect(failures[0]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);

  it('returns both deadline failures in the order page, Context when neither close finishes', async () => {
    const { factory, events } = fakeFactory({ pageHangs: true, contextHangs: true });

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, fakeContext, fakePage, {
      pageCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(2 * SHORT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(2 * SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(events).toEqual(['closePage', 'closeContext']);
    expect(failures.map(({ step }) => step)).toEqual(['page', 'context']);
    expect(failures[0]?.error).toBeInstanceOf(PassivePageCloseDeadlineError);
    expect(failures[1]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);
});

// DEF-006: エラーページを表示している page で、次のナビゲーションも失敗し、その直後に page を閉じると、Chromium は page を閉じず、
// `page.close()` が終わらない（DEF-005 の調査）。page を閉じる処理は `PAGE_CLOSE_TIMEOUT_MS` で見切り、Context を閉じる処理に進む。
describe('closePassivePageAndContext with a page that Chromium does not close (DEF-006)', () => {
  /**
   * 注入する page を閉じる処理の期限（R15r-4。実際の `PAGE_CLOSE_TIMEOUT_MS` を待たない）。ふだんの page を閉じる処理（数十 ms）より
   * 長くし、止まらなかった場合に誤って期限切れにしにくくする（期限切れになっても、次のテストの条件は満たす）。
   */
  const INJECTED_PAGE_CLOSE_TIMEOUT_MS = 500;
  /** 期限を過ぎてから、Context を閉じて戻るまでの余裕。 */
  const CLOSE_MARGIN_MS = 5_000;
  const TEST_TIMEOUT_MS = INJECTED_PAGE_CLOSE_TIMEOUT_MS + CLOSE_MARGIN_MS + 10_000;

  /** 127.0.0.1 の、いま使われていないポートの Origin（ポートを一度確保して、すぐに解放する。接続を拒否する）。 */
  async function unusedLoopbackOrigin(): Promise<string> {
    const probe = createServer();
    const port = await new Promise<number>((resolvePort, reject) => {
      probe.once('error', reject);
      probe.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = probe.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('probe server did not bind to a TCP port'));
          return;
        }
        resolvePort(address.port);
      });
    });
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    return `http://127.0.0.1:${port}`;
  }

  /** Guard の付いた page で、接続を拒否する Origin へ2回続けてナビゲーションする（2回とも失敗する）。 */
  async function openPageShowingErrorAfterTwoFailures() {
    const unreachableOrigin = await unusedLoopbackOrigin();
    const factory = new BrowserContextFactory(browser, createTestConfig(unreachableOrigin), () => new SafetyLedger());
    const context = await factory.createPassiveContext(VIEWPORT);
    const page = await factory.createPassivePage(context);
    const ledger = factory.getSafetyLedger(context);
    const navigationOptions = { timeoutMs: 10_000, ledger, allowedQueryParameters: new Set<string>() };
    const first = await navigatePage(page, `${unreachableOrigin}/first.html`, navigationOptions);
    const second = await navigatePage(page, `${unreachableOrigin}/second.html`, navigationOptions);
    expect([first.navigationOutcome, second.navigationOutcome]).toEqual(['FAILED', 'FAILED']);
    return { factory, context, page, ledger };
  }

  /** page を閉じる処理を、終わらないようにする（Chromium が page を閉じない場合と同じ形を、確実に作る）。 */
  function makePageCloseHang(factory: BrowserContextFactory): void {
    vi.spyOn(factory, 'closePassivePage').mockImplementation(() => new Promise<never>(() => undefined));
  }

  // Chromium が page を閉じないかどうかは、タイミングで変わる（多くの実行で止まるが、止まらないこともある）。
  // そのため、ここでは、どちらの場合も期限の中で戻り、Context が閉じることを確かめる。止まった場合の記録は、次のテストで確かめる。
  it('returns within the page close deadline and closes the Context under the DEF-005 condition', async () => {
    const { factory, context, page, ledger } = await openPageShowingErrorAfterTwoFailures();

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, context, page, {
      pageCloseTimeoutMs: INJECTED_PAGE_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(INJECTED_PAGE_CLOSE_TIMEOUT_MS + CLOSE_MARGIN_MS);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
    // 止まった場合は、page を閉じる処理の期限切れだけが記録される。
    expect(failures.length).toBeLessThanOrEqual(1);
    for (const failure of failures) {
      expect(failure.step).toBe('page');
      expect((failure.error as Error).message).toBe(PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE);
    }
    // 見切った page を閉じる処理は、Context を閉じた後に終わる。その結果は封じ込め、Guard の違反にもならない。
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('records the missed deadline as a page close failure and then closes the Context', async () => {
    const { factory, context, page, ledger } = await openPageShowingErrorAfterTwoFailures();
    makePageCloseHang(factory);

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, context, page, {
      pageCloseTimeoutMs: INJECTED_PAGE_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(INJECTED_PAGE_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(INJECTED_PAGE_CLOSE_TIMEOUT_MS + CLOSE_MARGIN_MS);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.step).toBe('page');
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect((failures[0]?.error as Error).message).toBe(PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE);
    expect(Object.isFrozen(failures[0])).toBe(true);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('lets the test cleanup helper close such a page and its Context without waiting forever', async () => {
    const { factory, context, page } = await openPageShowingErrorAfterTwoFailures();
    makePageCloseHang(factory);

    // 期限を注入し、既定の `PAGE_CLOSE_TIMEOUT_MS` を実際には待たない（P18e。P18a の発見事項1）。
    const startedAt = performance.now();
    await closePassiveResources({ factory, context, page }, { pageCloseTimeoutMs: INJECTED_PAGE_CLOSE_TIMEOUT_MS });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(INJECTED_PAGE_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    // 既定の期限（`PAGE_CLOSE_TIMEOUT_MS`）を待った場合は、ここで失敗する。
    expect(elapsedMs).toBeLessThan(PAGE_CLOSE_TIMEOUT_MS);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
  }, TEST_TIMEOUT_MS);
});
