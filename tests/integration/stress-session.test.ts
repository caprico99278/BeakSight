// P14b（Task 14〜17 の設計書 4.5.6）: 幅の走査のセッションを、BrowserContextFactory の Passive Context で作る本番の部品。
// 作ったセッションの Ledger を、後で Safety の Evidence と違反の集計に含められるように返す。閉じるときの失敗は隠さない。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory, ContextConstructionError } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { collectStressLayout } from '../../src/evidence/layout-collector.js';
import {
  PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
} from '../../src/orchestration/passive-session-close.js';
import { PassiveSessionOpenDeadlineError } from '../../src/orchestration/passive-session-open.js';
import { createStressSessionFactory } from '../../src/orchestration/stress-session.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

const STRESS_DEADLINE_MS = 60_000;
const STRESS_VIEWPORT: Viewport = Object.freeze({ width: 320, height: 800 });
/** 期限を過ぎてから戻るまでの余裕。 */
const CLOSE_MARGIN_MS = 5_000;
/** タイマーが少し早く発火する場合の許容。 */
const TIMER_TOLERANCE_MS = 50;
/** 注入する短い期限（ms。DEF-008、R15r-4）。実際の期限（`PAGE_CLOSE_TIMEOUT_MS` など）を待たない。 */
const INJECTED_TIMEOUT_MS = 200;
/** 期限のテストの上限。期限を守らない（既定の期限を待つか、止まり続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = 3_000;
/** 偽の factory で、期限を過ぎてから戻るまでの余裕。 */
const FAKE_RETURN_MARGIN_MS = 1_000;

let browser: Browser;
let server: FixtureServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  for (const context of browser.contexts()) {
    await context.close();
  }
  await server?.close();
  server = undefined;
});

interface FakeFactoryCalls {
  readonly events: string[];
}

/**
 * 閉じるときの失敗を再現する、偽の BrowserContextFactory。ブラウザを使わない。
 * `getSafetyLedger` は、Context ごとに新しい Ledger を返す。
 */
function fakeFactory(
  calls: FakeFactoryCalls,
  behavior: {
    readonly closePageError?: Error;
    readonly closeContextError?: Error;
    readonly createPageError?: Error;
    readonly createContextError?: Error;
    /** 指定すると、`getSafetyLedger` がこの失敗を投げる（RP18 の指摘3）。 */
    readonly getSafetyLedgerError?: Error;
    /** 真なら、page を閉じる処理が終わらない（DEF-006）。 */
    readonly closePageHangs?: boolean;
    /** 真なら、Context を作る処理が終わらない（DEF-008）。 */
    readonly createContextHangs?: boolean;
    /** 真なら、page を作る処理が終わらない（DEF-008）。 */
    readonly createPageHangs?: boolean;
    /** 真なら、Context を閉じる処理が終わらない（DEF-008）。 */
    readonly closeContextHangs?: boolean;
  },
): BrowserContextFactory {
  const ledgers = new Map<unknown, SafetyLedger>();
  let contextSequence = 0;
  const factory = {
    createPassiveContext: async (viewport: Viewport) => {
      contextSequence += 1;
      const context = { name: `context-${contextSequence}` } as unknown as BrowserContext;
      const ledger = new SafetyLedger();
      ledgers.set(context, ledger);
      calls.events.push(`createContext:${viewport.width}x${viewport.height}`);
      if (behavior.createContextHangs === true) await new Promise<never>(() => undefined);
      if (behavior.createContextError !== undefined) {
        throw new ContextConstructionError(context, ledger, behavior.createContextError);
      }
      return context;
    },
    getSafetyLedger: (context: BrowserContext) => {
      if (behavior.getSafetyLedgerError !== undefined) throw behavior.getSafetyLedgerError;
      const ledger = ledgers.get(context);
      if (ledger === undefined) throw new Error('BrowserContext is not owned by this factory');
      return ledger;
    },
    createPassivePage: async () => {
      calls.events.push('createPage');
      if (behavior.createPageHangs === true) await new Promise<never>(() => undefined);
      if (behavior.createPageError !== undefined) throw behavior.createPageError;
      return { name: 'page' } as unknown as Page;
    },
    closePassivePage: async () => {
      calls.events.push('closePage');
      if (behavior.closePageHangs === true) await new Promise<never>(() => undefined);
      if (behavior.closePageError !== undefined) throw behavior.closePageError;
    },
    closePassiveContext: async () => {
      calls.events.push('closeContext');
      if (behavior.closeContextHangs === true) await new Promise<never>(() => undefined);
      if (behavior.closeContextError !== undefined) throw behavior.closeContextError;
    },
  };
  return factory as unknown as BrowserContextFactory;
}

describe('createStressSessionFactory with a real browser', () => {
  it('runs collectStressLayout at two widths on guarded Passive Contexts and collects one Ledger per session', async () => {
    server = await startFixtureServer();
    const ledgerFactoryCalls: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => {
      const ledger = new SafetyLedger();
      ledgerFactoryCalls.push(ledger);
      return ledger;
    });
    const stress = createStressSessionFactory(factory);

    const results = await collectStressLayout(stress.createSession, `${server.origin}/overflow.html`, [320, 480], {
      deadlineAtMs: Date.now() + STRESS_DEADLINE_MS,
    });

    expect(results.map(({ width, status }) => ({ width, status }))).toEqual([
      { width: 320, status: 'COMPLETE' },
      { width: 480, status: 'COMPLETE' },
    ]);
    const ledgers = stress.ledgers();
    expect(ledgers).toHaveLength(2);
    expect(ledgers).toEqual(ledgerFactoryCalls);
    expect(ledgers[0]).not.toBe(ledgers[1]);
    for (const ledger of ledgers) {
      expect(ledger.snapshot().invariantViolationCount).toBe(0);
    }
    // セッションの Context は、すべて閉じられている。
    expect(browser.contexts()).toHaveLength(0);
  });

  // P14f（R14r の Important-1、設計書 4.3）: Guard の取り付けの失敗で Guard が Context を閉じた場合も、その Ledger を一覧に含める。
  it('keeps the Ledger of a session whose Guard installation failed and whose Context the Guard closed', async () => {
    server = await startFixtureServer();
    const factory = new BrowserContextFactory(
      browserOpeningPageAfterNewContext(browser),
      createTestConfig(server.origin),
      () => new SafetyLedger(),
    );
    const stress = createStressSessionFactory(factory);

    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(ContextConstructionError);
    const ledgers = stress.ledgers();
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toBe((rejection as ContextConstructionError).ledger);
    expect(ledgers[0]?.snapshot().invariantViolations.map((violation) => violation.code)).toContain('GUARD_INSTALLATION_FAILED');
    expect(browser.contexts()).toHaveLength(0);
  });

  it('returns a frozen copy of the Ledger list that does not change with later sessions', async () => {
    server = await startFixtureServer();
    const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
    const stress = createStressSessionFactory(factory);

    const before = stress.ledgers();
    const session = await stress.createSession(STRESS_VIEWPORT);
    await session.close();

    expect(Object.isFrozen(before)).toBe(true);
    expect(before).toHaveLength(0);
    expect(stress.ledgers()).toHaveLength(1);
  });

  it('opens the session page with the requested viewport', async () => {
    server = await startFixtureServer();
    const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
    const stress = createStressSessionFactory(factory);

    const session = await stress.createSession(STRESS_VIEWPORT);
    try {
      expect(session.page.viewportSize()).toEqual({ width: 320, height: 800 });
    } finally {
      await session.close();
    }
  });

  it('rejects a second close of the same session', async () => {
    server = await startFixtureServer();
    const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
    const stress = createStressSessionFactory(factory);

    const session = await stress.createSession(STRESS_VIEWPORT);
    await session.close();

    await expect(session.close()).rejects.toThrow(/already closed/u);
  });
});

describe('createStressSessionFactory close and construction failures', () => {
  it('rethrows a page close failure after still closing the Context', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const closePageError = new Error('page close failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { closePageError }));

    const session = await stress.createSession(STRESS_VIEWPORT);
    await expect(session.close()).rejects.toBe(closePageError);

    expect(calls.events).toEqual(['createContext:320x800', 'createPage', 'closePage', 'closeContext']);
  });

  // DEF-006: page を閉じる処理が終わらない場合は、期限（`PAGE_CLOSE_TIMEOUT_MS`）で見切り、Context を閉じてから、期限切れの失敗を投げる。
  // 期限は注入する（R15r-4。実際の 5 秒を待たない）。
  it('throws the page close deadline failure after closing the Context when the page close does not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { closePageHangs: true }), {
      deadlines: { pageCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const session = await stress.createSession(STRESS_VIEWPORT);
    const startedAt = performance.now();
    await expect(session.close()).rejects.toThrow(PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(INJECTED_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    expect(calls.events).toEqual(['createContext:320x800', 'createPage', 'closePage', 'closeContext']);
  }, INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS + 10_000);

  // DEF-008（Task 18 の前の整理の設計書 4.4）: 作成か終了が終わらない場合も、期限の中で失敗を投げる（今の失敗の扱いと同じく、
  // 幅の走査の collector は、その幅を未完了にする）。
  it('throws the Context close deadline failure from close() when closing the Context does not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { closeContextHangs: true }), {
      deadlines: { contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const session = await stress.createSession(STRESS_VIEWPORT);
    const startedAt = performance.now();
    const rejection = await session.close().then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(PassiveContextCloseDeadlineError);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
    expect(calls.events).toEqual(['createContext:320x800', 'createPage', 'closePage', 'closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('throws the open deadline failure without a Ledger when creating the Context does not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { createContextHangs: true }), {
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const startedAt = performance.now();
    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect((rejection as PassiveSessionOpenDeadlineError).step).toBe('context');
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
    expect(calls.events).toEqual(['createContext:320x800']);
    expect(stress.ledgers()).toEqual([]);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes the Context, keeps its Ledger and throws the open deadline failure when creating the page does not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { createPageHangs: true }), {
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const startedAt = performance.now();
    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect((rejection as PassiveSessionOpenDeadlineError).step).toBe('page');
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
    expect(calls.events).toEqual(['createContext:320x800', 'createPage', 'closeContext']);
    expect(stress.ledgers()).toHaveLength(1);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('reports both failures when creating the page and then closing the Context do not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { createPageHangs: true, closeContextHangs: true }), {
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS, contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const startedAt = performance.now();
    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(AggregateError);
    const [openFailure, closeFailure] = (rejection as AggregateError).errors as unknown[];
    expect(openFailure).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect(closeFailure).toBeInstanceOf(PassiveContextCloseDeadlineError);
    expect(elapsedMs).toBeLessThan(2 * INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('uses the earlier caller deadline for creating a session', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { createContextHangs: true }), {
      notAfterMs: Date.now() + INJECTED_TIMEOUT_MS,
    });

    const startedAt = performance.now();
    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(rejection).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('lets collectStressLayout return within the deadlines when creating a session does not finish', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const stress = createStressSessionFactory(fakeFactory(calls, { createContextHangs: true }), {
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });

    const startedAt = performance.now();
    const rejection = await collectStressLayout(stress.createSession, 'http://127.0.0.1:9/', [320, 480], {
      deadlineAtMs: Date.now() + STRESS_DEADLINE_MS,
    }).then(() => undefined, (error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    // セッションの作成の失敗は、今と同じく、走査の失敗として投げられる（Page Auditor は、その段階を未完了にする）。
    expect(rejection).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + FAKE_RETURN_MARGIN_MS);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('rethrows a Context close failure', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const closeContextError = new Error('context close failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { closeContextError }));

    const session = await stress.createSession(STRESS_VIEWPORT);
    await expect(session.close()).rejects.toBe(closeContextError);
  });

  it('reports both failures when the page close and the Context close fail', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const closePageError = new Error('page close failed');
    const closeContextError = new Error('context close failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { closePageError, closeContextError }));

    const session = await stress.createSession(STRESS_VIEWPORT);
    const rejection = await session.close().then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([closePageError, closeContextError]);
  });

  it('closes the Context, keeps its Ledger and rethrows when the page cannot be created', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const createPageError = new Error('page creation failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { createPageError }));

    await expect(stress.createSession(STRESS_VIEWPORT)).rejects.toBe(createPageError);

    expect(calls.events).toEqual(['createContext:320x800', 'createPage', 'closeContext']);
    expect(stress.ledgers()).toHaveLength(1);
  });

  it('reports both failures when the page cannot be created and the Context close fails', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const createPageError = new Error('page creation failed');
    const closeContextError = new Error('context close failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { createPageError, closeContextError }));

    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([createPageError, closeContextError]);
    expect(stress.ledgers()).toHaveLength(1);
  });

  it('closes a Context whose construction failed but was retained, keeps its Ledger and rethrows', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const createContextError = new Error('guard installation failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { createContextError }));

    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(ContextConstructionError);
    expect((rejection as ContextConstructionError).cause).toBe(createContextError);
    expect(calls.events).toEqual(['createContext:320x800', 'closeContext']);
    expect(stress.ledgers()).toHaveLength(1);
  });

  // RP18 の指摘3: Context を作った直後に Ledger を取り出せなかった場合も、ほかの失敗と同じく、Context を閉じてから投げる。
  it('closes the Context and rethrows when its Ledger cannot be taken out right after creating it (RP18 finding 3)', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const getSafetyLedgerError = new Error('ledger lookup failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { getSafetyLedgerError }));

    await expect(stress.createSession(STRESS_VIEWPORT)).rejects.toBe(getSafetyLedgerError);

    expect(calls.events).toEqual(['createContext:320x800', 'closeContext']);
    expect(stress.ledgers()).toEqual([]);
  });

  it('reports both failures when the Ledger cannot be taken out and the Context close fails (RP18 finding 3)', async () => {
    const calls: FakeFactoryCalls = { events: [] };
    const getSafetyLedgerError = new Error('ledger lookup failed');
    const closeContextError = new Error('context close failed');
    const stress = createStressSessionFactory(fakeFactory(calls, { getSafetyLedgerError, closeContextError }));

    const rejection = await stress.createSession(STRESS_VIEWPORT).then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([getSafetyLedgerError, closeContextError]);
    expect(calls.events).toEqual(['createContext:320x800', 'closeContext']);
  });

  it('throws TypeError when the factory is missing', () => {
    expect(() => createStressSessionFactory(undefined as unknown as BrowserContextFactory)).toThrow(TypeError);
  });

  it('throws RangeError for an invalid injected deadline', () => {
    const calls: FakeFactoryCalls = { events: [] };
    expect(() => createStressSessionFactory(fakeFactory(calls, {}), { deadlines: { sessionOpenTimeoutMs: 0 } }))
      .toThrow(RangeError);
    expect(() => createStressSessionFactory(fakeFactory(calls, {}), { notAfterMs: Number.NaN })).toThrow(RangeError);
    expect(calls.events).toEqual([]);
  });
});
