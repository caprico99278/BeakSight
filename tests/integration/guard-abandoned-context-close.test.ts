// DEF-110: 期限で見捨てた（`closePassiveContextBeforeDeadline` が待つのをやめた）Guard の付いた Context の close が、Browser を閉じた後に
// reject されても、Guard は違反（`GUARDED_CONTEXT_CLOSE_FAILED`）に数えない。Context がもう存在しないことを、文言に頼らずに確かめられた
// 場合（Guard がその Context の close の事象を見た場合）だけ、閉じたとみなす。確かめられない場合（Browser も Context も生きている）は、
// 今のまま違反にする（fail-closed）。テストの既定の headless shell と CLI の Chromium の両方で確かめる。
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import {
  closePassiveContextBeforeDeadline,
  PassiveContextCloseDeadlineError,
  type PassiveSessionCloseFailure,
} from '../../src/orchestration/passive-session-close.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { createGuardHarness, createHarnessPage, type GuardHarness } from '../helpers/passive-guard-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT: Viewport = Object.freeze({ width: 800, height: 600 });
/** 開く fixture のページ（リンクのない小さなページ）。 */
const PAGE_PATH = '/clipped-text.html';
/** 注入する短い Context の close の期限（ms）。実際の `CONTEXT_CLOSE_TIMEOUT_MS` を待たない。 */
const SHORT_CLOSE_TIMEOUT_MS = 200;
/** 止めた close の reject の後、Guard が結果（閉じた、または違反）を出すまで待つ上限（ms）。 */
const GUARD_SETTLE_TIMEOUT_MS = 5_000;
/** 1 つのテストの上限（ms）。Browser の起動と終了を含む。 */
const TEST_TIMEOUT_MS = 60_000;
/** 1 から数えた、close を止めて偽の失敗にする Context の順番（`newContext` の呼び出しの順）。 */
const FIRST_CONTEXT_NUMBER = 1;

/** close の偽の失敗。文言は Playwright のものと違える（Guard が文言で判定しないことを確かめる）。 */
const fakeCloseFailure = (): Error => new Error('DEF-110 test: the stalled Context close was rejected');

/** `browserRejectingContextClose` の結果。 */
interface RejectingContextCloseBrowser {
  /** `newContext` で作った 1 つ目の Context の `close()` を、`rejectClose()` まで止めてから偽の失敗にする Browser の Proxy。 */
  readonly browser: Browser;
  /** 止めていた `close()` を、偽の失敗（`failure`）で reject させる。 */
  rejectClose(): void;
  /** 止めた `close()` が reject した（偽の失敗を投げる直前）ときに解ける Promise。 */
  readonly closeRejected: Promise<void>;
  /** 偽の失敗。 */
  readonly failure: Error;
  /** 止めた Context を、元の `close()` で閉じる（後片付け。失敗は捨てる）。 */
  closeStalledForReal(): Promise<void>;
}

/**
 * `newContext` で作った 1 つ目の Context の `close()` を、`rejectClose()` まで止め、その後は元の close を呼ばずに偽の失敗で reject させる
 * Browser の Proxy。Context そのものは本物で、`close` だけを、その Context の自身のプロパティで置き換える（Guard の Context と Ledger の対応は
 * 保たれる）。2 つ目以降の Context は置き換えない。
 */
function browserRejectingContextClose(real: Browser): RejectingContextCloseBrowser {
  const gate = createDeferred<void>();
  const rejected = createDeferred<void>();
  const failure = fakeCloseFailure();
  const stalled: { realClose: (() => Promise<void>) | undefined } = { realClose: undefined };
  let createdCount = 0;
  const browser = overrideBrowser(real, {
    newContext: async (...args: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
      const context = await real.newContext(...args);
      createdCount += 1;
      if (createdCount !== FIRST_CONTEXT_NUMBER) {
        return context;
      }
      const realClose = context.close.bind(context);
      stalled.realClose = () => realClose();
      Object.defineProperty(context, 'close', {
        configurable: true,
        writable: true,
        value: async (): Promise<void> => {
          await gate.promise;
          rejected.resolve(undefined);
          throw failure;
        },
      });
      return context;
    },
  });
  return Object.freeze({
    browser,
    rejectClose: () => gate.resolve(undefined),
    closeRejected: rejected.promise,
    failure,
    async closeStalledForReal(): Promise<void> {
      await stalled.realClose?.().catch(() => undefined);
    },
  });
}

/** Guard の付いた Context と page を factory で作り、fixture のページを開く。 */
async function openGuardedContext(factory: BrowserContextFactory, origin: string): Promise<BrowserContext> {
  const context = await factory.createPassiveContext(VIEWPORT);
  const page = await factory.createPassivePage(context);
  await page.goto(`${origin}${PAGE_PATH}`, { waitUntil: 'load' });
  return context;
}

/** 期限で見捨てた close の失敗が、期限切れ（`PassiveContextCloseDeadlineError`）として返ったことを確かめる（閉じる処理の失敗の記録）。 */
function expectAbandonedAtDeadline(failure: PassiveSessionCloseFailure | null): void {
  expect(failure).not.toBeNull();
  expect(failure?.step).toBe('context');
  expect(failure?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
}

/** 止めた close の reject の後、Guard が閉じたか、違反を記録するまで待つ。 */
async function waitForGuardOutcome(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  await expect.poll(
    () => isPassiveRequestGuardClosed(context) || ledger.snapshot().invariantViolations.length > 0,
    { timeout: GUARD_SETTLE_TIMEOUT_MS },
  ).toBe(true);
}

describe.each([
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium() },
])('DEF-110: an abandoned guarded Context close rejected after the Browser closed, with $name', ({ launch }) => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('records no violation and closes the Guard, while the close failure stays the deadline failure', async () => {
    const real = await launch();
    const rejecting = browserRejectingContextClose(real);
    const factory = new BrowserContextFactory(
      rejecting.browser, createTestConfig(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS,
    );
    try {
      const context = await openGuardedContext(factory, server.origin);
      const ledger = factory.getSafetyLedger(context);

      // 期限の中で close が終わらず、待つのをやめる（DEF-110 の最後のビューポートの Passive の Context）。
      const failure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
      expectAbandonedAtDeadline(failure);

      // Run Coordinator の `finally` と同じく Browser を閉じ、その後に裏で続いていた close が reject される。
      await real.close();
      rejecting.rejectClose();
      await rejecting.closeRejected;
      await waitForGuardOutcome(context, ledger);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(true);
      expect(real.isConnected()).toBe(false);
    } finally {
      await factory.close();
      await real.close().catch(() => undefined);
    }
  }, TEST_TIMEOUT_MS);

  it('still records GUARDED_CONTEXT_CLOSE_FAILED when the close fails while the Browser and the Context are alive', async () => {
    const real = await launch();
    const rejecting = browserRejectingContextClose(real);
    const factory = new BrowserContextFactory(
      rejecting.browser, createTestConfig(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS,
    );
    try {
      const context = await openGuardedContext(factory, server.origin);
      const ledger = factory.getSafetyLedger(context);

      const failure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
      expectAbandonedAtDeadline(failure);

      // Browser を閉じずに、close を偽の失敗にする（Context は実際には生きている）。
      rejecting.rejectClose();
      await rejecting.closeRejected;
      await waitForGuardOutcome(context, ledger);

      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: rejecting.failure.message },
      ]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(real.isConnected()).toBe(true);
      expect(testContextsOf(real)).toContain(context);
    } finally {
      await rejecting.closeStalledForReal();
      await factory.close();
      await real.close();
    }
  }, TEST_TIMEOUT_MS);

  it('still records GUARDED_CONTEXT_CLOSE_FAILED when only another Context of the same Browser was closed', async () => {
    const real = await launch();
    const rejecting = browserRejectingContextClose(real);
    const factory = new BrowserContextFactory(
      rejecting.browser, createTestConfig(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS,
    );
    try {
      const context = await openGuardedContext(factory, server.origin);
      const other = await openGuardedContext(factory, server.origin);
      const ledger = factory.getSafetyLedger(context);

      const failure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: SHORT_CLOSE_TIMEOUT_MS });
      expectAbandonedAtDeadline(failure);

      // 同じ Browser のほかの Context だけを閉じる（その close の事象は、止めた Context の閉じた証しにならない）。
      await factory.closePassiveContext(other);
      expect(isPassiveRequestGuardClosed(other)).toBe(true);
      rejecting.rejectClose();
      await rejecting.closeRejected;
      await waitForGuardOutcome(context, ledger);

      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: rejecting.failure.message },
      ]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(real.isConnected()).toBe(true);
    } finally {
      await rejecting.closeStalledForReal();
      await factory.close();
      await real.close();
    }
  }, TEST_TIMEOUT_MS);
});

/** 偽の Context の許可 Origin。 */
const HARNESS_ORIGIN = 'https://example.test';

/** close を `gate` まで止めてから `closeError` で reject する、偽の Context の Guard の harness と、その gate。 */
function harnessWithGatedCloseFailure(closeError: Error): { readonly harness: GuardHarness; release(): void } {
  const gate = createDeferred<void>();
  const harness = createGuardHarness({ contextCloseGate: gate.promise, contextCloseError: closeError });
  return { harness, release: () => gate.resolve(undefined) };
}

/** 偽の Context の Context の close の事象を、Guard の listener に送る（Browser が切れたときに Playwright が出す事象）。 */
function emitContextClose(harness: GuardHarness): void {
  const handler = harness.contextCloseHandler;
  expect(handler).toBeDefined();
  handler?.();
}

// DEF-110 fix: 判定は Guard の中の 1 か所（close の試み）で、持ち主の close と無効化の close の両方に効く。偽の Context で、close の事象を
// 見た後の reject は違反にせず、見ていない reject は今のまま違反にすることを、両方の経路で確かめる。
describe('DEF-110: the Guard close attempt treats a rejected close as closed only after the Context close event', () => {
  it('owner close: no GUARDED_CONTEXT_CLOSE_FAILED when the Context close event was seen before the rejection', async () => {
    const closeError = new Error('owner close rejected after the Context closed');
    const { harness, release } = harnessWithGatedCloseFailure(closeError);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([HARNESS_ORIGIN]));

    const closing = closePassiveGuardedContext(harness.context);
    emitContextClose(harness);
    release();

    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(harness.removedListeners).toContain('CONTEXT:close');
  });

  it('owner close: still GUARDED_CONTEXT_CLOSE_FAILED when no Context close event was seen', async () => {
    const closeError = new Error('owner close rejected while the Context is alive');
    const { harness, release } = harnessWithGatedCloseFailure(closeError);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([HARNESS_ORIGIN]));

    const closing = closePassiveGuardedContext(harness.context);
    release();

    await expect(closing).rejects.toBe(closeError);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: closeError.message },
    ]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
  });

  it('safety invalidation: no GUARD_CONTEXT_INVALIDATION_FAILED when the Context close event was seen before the rejection', async () => {
    const closeError = new Error('invalidation close rejected after the Context closed');
    const pageCloseError = new Error('page close failed');
    const { harness, release } = harnessWithGatedCloseFailure(closeError);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([HARNESS_ORIGIN]));
    const page = createHarnessPage(harness, { closeError: pageCloseError, url: `${HARNESS_ORIGIN}/fixture` });
    await awaitPassiveRequestGuardReady(page);

    // page の close の失敗は、Context の無効化（`SAFETY_INVALIDATION` の close）を始める。
    const pageClosing = closePassiveGuardedPage(page);
    emitContextClose(harness);
    release();

    await expect(pageClosing).rejects.toBe(pageCloseError);
    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'GUARDED_PAGE_CLOSE_FAILED', message: pageCloseError.message },
    ]);
  });

  it('safety invalidation: still GUARD_CONTEXT_INVALIDATION_FAILED when no Context close event was seen', async () => {
    const closeError = new Error('invalidation close rejected while the Context is alive');
    const pageCloseError = new Error('page close failed');
    const { harness, release } = harnessWithGatedCloseFailure(closeError);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([HARNESS_ORIGIN]));
    const page = createHarnessPage(harness, { closeError: pageCloseError, url: `${HARNESS_ORIGIN}/fixture` });
    await awaitPassiveRequestGuardReady(page);

    const pageClosing = closePassiveGuardedPage(page);
    release();

    await expect(pageClosing).rejects.toBe(pageCloseError);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'GUARDED_PAGE_CLOSE_FAILED', message: pageCloseError.message },
      { code: 'GUARD_CONTEXT_INVALIDATION_FAILED', message: closeError.message },
    ]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
  });
});
