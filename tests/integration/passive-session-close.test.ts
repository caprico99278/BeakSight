// CC-018: page と Context を閉じる手順（page を閉じてから Context を閉じる。Guard がすでに Context を閉じていれば、
// Context は閉じ直さない）と、その失敗の一覧を返す部品。例外にするか理由にするかは、呼び出し側が決める。
import { createServer } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, ContextConstructionError } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { navigatePage } from '../../src/orchestration/page-navigation.js';
import {
  closePassiveContextBeforeDeadline,
  closePassivePageAndContext,
  closePassivePageBeforeDeadline,
  PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
  PassivePageCloseDeadlineError,
} from '../../src/orchestration/passive-session-close.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import {
  closeUnguardedUnloadBeaconPage,
  createGateFactory,
  NO_NON_READ_REQUESTS,
  runGuardedUnloadBeaconRounds,
  UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS,
  UNLOAD_BEACON_TARGET_PATH,
} from '../helpers/gate-harness.js';
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

    const failures = await closePassivePageAndContext(factory, undefined);

    expect(failures).toEqual([]);
    expect(events).toEqual([]);
  });

  // DEF-038: page は個別に閉じず、Context だけを閉じる（page は Context と一緒に閉じる）。
  it('closes only the Context, without closing the page by itself, and returns no failures (DEF-038)', async () => {
    const { factory, events } = fakeFactory();

    const failures = await closePassivePageAndContext(factory, fakeContext);

    expect(failures).toEqual([]);
    expect(Object.isFrozen(failures)).toBe(true);
    expect(events).toEqual(['closeContext']);
  });

  // DEF-038: page を閉じる処理の期限（`pageCloseTimeoutMs`）は、閉じる手順で読まない（整理は CC-049）。
  it('does not read the page close deadline (DEF-038)', async () => {
    const { factory, events } = fakeFactory();

    await expect(closePassivePageAndContext(factory, fakeContext, { pageCloseTimeoutMs: 0 })).resolves.toEqual([]);
    expect(events).toEqual(['closeContext']);
  });

  // DEF-038: page を閉じる処理（失敗する場合も）を呼ばないので、page の失敗は返らない。
  it('does not call the page close even when it would fail, and returns no page failure (DEF-038)', async () => {
    const pageError = new Error('page close failed');
    const { factory, events } = fakeFactory({ pageError });

    const failures = await closePassivePageAndContext(factory, fakeContext);

    expect(events).toEqual(['closeContext']);
    expect(failures).toEqual([]);
  });

  it('returns the Context close failure as it was thrown', async () => {
    const contextError = new Error('context close failed');
    const { factory } = fakeFactory({ contextError });

    const failures = await closePassivePageAndContext(factory, fakeContext);

    expect(failures.map(({ step }) => step)).toEqual(['context']);
    expect(failures[0]?.error).toBe(contextError);
    expect(Object.isFrozen(failures[0])).toBe(true);
  });

  // DEF-038: page を閉じる処理が失敗する場合も、返るのは Context を閉じる処理の失敗だけである。
  it('returns only the Context close failure even when the page close would fail (DEF-038)', async () => {
    const pageError = new Error('page close failed');
    const contextError = new Error('context close failed');
    const { factory, events } = fakeFactory({ pageError, contextError });

    const failures = await closePassivePageAndContext(factory, fakeContext);

    expect(events).toEqual(['closeContext']);
    expect(failures.map(({ step, error }) => ({ step, error }))).toEqual([{ step: 'context', error: contextError }]);
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

    await expect(closePassivePageAndContext(factory, context)).resolves.toEqual([]);
    expect(closeContext).not.toHaveBeenCalled();
  });

  // DEF-038: 本物の Guard の付いた page は、`page.close()` を呼ばずに、Context と一緒に閉じる。違反も、閉じる処理の失敗もない。
  // （以前は、page を閉じる処理の失敗で Guard が Context を閉じる場面を確かめていた。page を個別に閉じなくなったので、その場面はない。）
  it('closes a real guarded page together with its Context, without calling page.close() (DEF-038)', async () => {
    const factory = new BrowserContextFactory(browser, createTestConfig(ORIGIN), () => new SafetyLedger());
    const context = await factory.createPassiveContext(VIEWPORT);
    const page = await factory.createPassivePage(context);
    const pageClose = vi.spyOn(page, 'close');
    const closePage = vi.spyOn(factory, 'closePassivePage');

    const failures = await closePassivePageAndContext(factory, context);

    expect(failures).toEqual([]);
    expect(pageClose).not.toHaveBeenCalled();
    expect(closePage).not.toHaveBeenCalled();
    expect(page.isClosed()).toBe(true);
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
    // factory は、閉じた Context の page を、もう持たない（DEF-038）。
    await expect(factory.closePassivePage(page)).rejects.toThrow(/owned/i);
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

// DEF-008: `closePassivePageAndContext` は、Context を `closePassiveContextBeforeDeadline` で閉じる。期限は注入できる。
describe('closePassivePageAndContext with deadlines (DEF-008)', () => {
  it('returns the Context close deadline failure when closing the Context does not finish', async () => {
    const { factory, events } = fakeFactory({ contextHangs: true });

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, fakeContext, {
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(events).toEqual(['closeContext']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.step).toBe('context');
    expect(failures[0]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);

  // DEF-038: page を閉じる処理（終わらない場合も）を待たないので、待つのは Context を閉じる処理の期限の1回分だけである。
  // （以前は、page と Context の両方の期限切れを、この順に返すことを確かめていた。）
  it('waits only for the Context close deadline, not for a page close that would not finish (DEF-038)', async () => {
    const { factory, events } = fakeFactory({ pageHangs: true, contextHangs: true });

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, fakeContext, {
      pageCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(SHORT_CLOSE_TIMEOUT_MS + FAKE_CLOSE_MARGIN_MS);
    expect(events).toEqual(['closeContext']);
    expect(failures.map(({ step }) => step)).toEqual(['context']);
    expect(failures[0]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, SHORT_DEADLINE_TEST_TIMEOUT_MS);
});

// DEF-006: エラーページを表示している page で、次のナビゲーションも失敗し、その直後に page を閉じると、Chromium は page を閉じず、
// `page.close()` が終わらない（DEF-005 の調査）。DEF-038 の後は、page を個別に閉じず、Context と一緒に閉じるので、page を閉じる処理を
// 待たない。この条件でも、Context を閉じる処理が page を閉じ、止まらずに戻ることを確かめる。
describe('closePassivePageAndContext with a page that Chromium does not close (DEF-006)', () => {
  /** Context を閉じて戻るまでの余裕（ms）。既定の page を閉じる処理の期限（`PAGE_CLOSE_TIMEOUT_MS`）より短い。 */
  const CLOSE_MARGIN_MS = 3_000;
  const TEST_TIMEOUT_MS = CLOSE_MARGIN_MS + 10_000;

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

  // DEF-038: page を個別に閉じないので、page を閉じる処理の期限切れはない。Context を閉じる処理が、page も閉じる。
  // （以前は、page を閉じる処理が期限の中で戻ること、止まった場合は期限切れが記録されることを確かめていた。）
  it('closes the Context, and the page with it, without closing the page by itself, under the DEF-005 condition', async () => {
    const { factory, context, page, ledger } = await openPageShowingErrorAfterTwoFailures();
    const closePage = vi.spyOn(factory, 'closePassivePage');

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, context);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(CLOSE_MARGIN_MS);
    expect(failures).toEqual([]);
    expect(closePage).not.toHaveBeenCalled();
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // DEF-038: page を閉じる処理が止まる場合も、それを呼ばないので、待たずに Context を閉じる。
  // （以前は、止まった page を閉じる処理を期限で見切り、page を閉じる処理の失敗として記録することを確かめていた。）
  it('does not wait for a page close that would not finish, and closes the Context', async () => {
    const { factory, context, page, ledger } = await openPageShowingErrorAfterTwoFailures();
    makePageCloseHang(factory);

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(factory, context);
    const elapsedMs = performance.now() - startedAt;

    // 既定の page を閉じる処理の期限（`PAGE_CLOSE_TIMEOUT_MS`）を待った場合は、ここで失敗する。
    expect(elapsedMs).toBeLessThan(CLOSE_MARGIN_MS);
    expect(failures).toEqual([]);
    expect(vi.mocked(factory.closePassivePage)).not.toHaveBeenCalled();
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // B2（DEF-038-fix-round-1）: テストの後片付けも、page を個別に閉じず、Context と一緒に閉じる。
  // （以前は、page を閉じる処理を注入した期限で見切ってから Context を閉じることを確かめていた。）
  it('lets the test cleanup helper close such a page with its Context, without closing the page by itself', async () => {
    const { factory, context, page } = await openPageShowingErrorAfterTwoFailures();
    makePageCloseHang(factory);

    const startedAt = performance.now();
    await closePassiveResources({ factory, context, page });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(CLOSE_MARGIN_MS);
    expect(vi.mocked(factory.closePassivePage)).not.toHaveBeenCalled();
    expect(isPassiveRequestGuardClosed(context)).toBe(true);
    expect(page.isClosed()).toBe(true);
  }, TEST_TIMEOUT_MS);
});

// DEF-038（設計書 `2026-10-08-beaksight-def-038-passive-page-close-design.md` 4）: Guard の付いた Passive のページを閉じるときの
// `pagehide`・`visibilitychange` の送信（`sendBeacon` と keepalive の `fetch` の POST）は、製品の閉じる手順
// （`closePassivePageAndContext`）では、サーバに届かない。page を個別に閉じると、Playwright は閉じ始めたページの要求で Context の
// route を呼ばないので、Guard を通らずに届く。Context だけを閉じる（page は Context と一緒に閉じる）と届かない。
describe('closePassivePageAndContext with a page that sends POST requests while it is being left (DEF-038)', () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('delivers no POST to the server and records no violation, in every round and after the settle wait', async () => {
    const factory = createGateFactory(browser, server.origin);

    const { failedRounds, allRoundsWindow } = await runGuardedUnloadBeaconRounds(factory, server, VIEWPORT);

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS);

  it('control: without the Guard, closing the same page with page.close() delivers the POST', async () => {
    const window = await closeUnguardedUnloadBeaconPage(browser, server, VIEWPORT);

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
  });
});
