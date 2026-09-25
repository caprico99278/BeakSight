// DEF-008（Task 18 の前の整理の設計書 4.2、4.3）: Guard の付いた Passive Context と page を、期限付きで作る部品。
// 期限を過ぎた場合は期限切れを返し、遅れて届いた Context は閉じる。今の失敗（`ContextConstructionError` など）の扱いは変えない。
// どのテストも、実際の期限（`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を待たず、短い期限を注入する。
import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextConstructionError, type BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { CONTEXT_CLOSE_TIMEOUT_MS, PAGE_CLOSE_TIMEOUT_MS, SESSION_OPEN_TIMEOUT_MS } from '../../src/core/limits.js';
import { PassiveContextCloseDeadlineError } from '../../src/orchestration/passive-session-close.js';
import {
  openPassiveContextBeforeDeadline,
  openPassivePageBeforeDeadline,
  openPassiveSessionBeforeDeadline,
  PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE,
  passiveSessionOpenDeadlineAtMs,
  PassiveSessionOpenDeadlineError,
  releaseLatePassiveContextFailure,
  resolvePassiveSessionDeadlines,
  type LatePassiveContextRelease,
} from '../../src/orchestration/passive-session-open.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';

const VIEWPORT: Viewport = Object.freeze({ width: 800, height: 600 });
/** 注入する作成の期限（ms）。 */
const SHORT_OPEN_TIMEOUT_MS = 200;
/** 注入する Context を閉じる処理の期限（ms）。 */
const SHORT_CLOSE_TIMEOUT_MS = 200;
/** 期限を過ぎてから戻るまでの余裕。 */
const RETURN_MARGIN_MS = 1_000;
/** 期限のテストの上限。期限を守らない（終わらない処理を待ち続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = 3_000;
/** タイマーが少し早く発火する場合の許容。 */
const TIMER_TOLERANCE_MS = 50;

afterEach(() => {
  vi.restoreAllMocks();
});

type ContextBehavior = 'resolve' | 'hang' | 'deferred' | Error | 'construction-error';
type PageBehavior = 'resolve' | 'hang' | Error;
type CloseBehavior = 'resolve' | 'hang' | Error;

interface FakeFactoryOptions {
  readonly context?: ContextBehavior;
  readonly page?: PageBehavior;
  readonly closeContext?: CloseBehavior;
}

interface FakeFactory {
  readonly factory: BrowserContextFactory;
  readonly events: string[];
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** `context` が `deferred` のときの、Context を作る処理の結果を決める口。 */
  readonly contextCreation: Deferred<BrowserContext>;
}

/** Context と page を作る処理と閉じる処理の振る舞いを決められる、偽の factory。ブラウザを使わない。 */
function fakeFactory(options: FakeFactoryOptions = {}): FakeFactory {
  const events: string[] = [];
  const context = { name: 'context' } as unknown as BrowserContext;
  const page = { name: 'page' } as unknown as Page;
  const ledger = new SafetyLedger();
  const contextCreation = createDeferred<BrowserContext>();
  const behaviorOf = <T>(value: T | undefined, fallback: T): T => value ?? fallback;
  const factory = {
    createPassiveContext: async (viewport: Viewport): Promise<BrowserContext> => {
      events.push(`createContext:${viewport.width}x${viewport.height}`);
      const behavior = behaviorOf(options.context, 'resolve');
      if (behavior === 'hang') return new Promise<never>(() => undefined);
      if (behavior === 'deferred') return contextCreation.promise;
      if (behavior === 'construction-error') {
        throw new ContextConstructionError(context, ledger, new Error('guard installation failed'));
      }
      if (behavior instanceof Error) throw behavior;
      return context;
    },
    getSafetyLedger: (owned: BrowserContext): SafetyLedger => {
      events.push('getSafetyLedger');
      if (owned !== context) throw new Error('BrowserContext is not owned by this factory');
      return ledger;
    },
    createPassivePage: async (): Promise<Page> => {
      events.push('createPage');
      const behavior = behaviorOf(options.page, 'resolve');
      if (behavior === 'hang') return new Promise<never>(() => undefined);
      if (behavior instanceof Error) throw behavior;
      return page;
    },
    closePassiveContext: async (): Promise<void> => {
      events.push('closeContext');
      const behavior = behaviorOf(options.closeContext, 'resolve');
      if (behavior === 'hang') await new Promise<never>(() => undefined);
      if (behavior instanceof Error) throw behavior;
    },
  };
  return { factory: factory as unknown as BrowserContextFactory, events, context, page, ledger, contextCreation };
}

/** 遅れて届いた Context の後始末を受け取る口と、最初の1件を待つ Promise。 */
function lateReleaseReceiver(): {
  readonly onLateContextRelease: (release: LatePassiveContextRelease) => void;
  readonly received: LatePassiveContextRelease[];
  readonly first: Promise<LatePassiveContextRelease>;
} {
  const received: LatePassiveContextRelease[] = [];
  const first = createDeferred<LatePassiveContextRelease>();
  return {
    received,
    first: first.promise,
    onLateContextRelease: (release) => {
      received.push(release);
      first.resolve(release);
    },
  };
}

/** 未処理の拒否を集める。 */
async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}

const deadlineIn = (timeoutMs: number): number => Date.now() + timeoutMs;

describe('openPassiveSessionBeforeDeadline (DEF-008)', () => {
  it('opens the Context and the page and returns them with the Context Ledger', async () => {
    const fake = fakeFactory();

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'OPENED', context: fake.context, page: fake.page, ledger: fake.ledger });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.events).toEqual(['createContext:800x600', 'getSafetyLedger', 'createPage']);
  });

  // 今の失敗の扱いは変えない: 部品は Context を閉じず、Context と Ledger を返す。閉じるのは呼び出し側である。
  it('returns a ContextConstructionError of the Context creation as it was thrown, with its Context and Ledger', async () => {
    const fake = fakeFactory({ context: 'construction-error' });

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') throw new Error('expected FAILED');
    expect(result.step).toBe('context');
    expect(result.error).toBeInstanceOf(ContextConstructionError);
    expect(result.context).toBe(fake.context);
    expect(result.ledger).toBe(fake.ledger);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.events).toEqual(['createContext:800x600']);
  });

  it('returns another Context creation failure as it was thrown, without a Context or a Ledger', async () => {
    const error = new Error('newContext failed');
    const fake = fakeFactory({ context: error });

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'FAILED', step: 'context', error, context: undefined, ledger: null });
    expect(fake.events).toEqual(['createContext:800x600']);
  });

  it('returns a page creation failure as it was thrown and leaves the Context open for the caller', async () => {
    const error = new Error('newPage failed');
    const fake = fakeFactory({ page: error });

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'FAILED', step: 'page', error, context: fake.context, ledger: fake.ledger });
    expect(fake.events).toEqual(['createContext:800x600', 'getSafetyLedger', 'createPage']);
  });

  it('returns the open deadline failure within the deadline when creating the Context does not finish', async () => {
    const fake = fakeFactory({ context: 'hang' });

    const startedAt = performance.now();
    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_OPEN_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(elapsedMs).toBeLessThan(SHORT_OPEN_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(result.status).toBe('DEADLINE_EXCEEDED');
    if (result.status !== 'DEADLINE_EXCEEDED') throw new Error('expected DEADLINE_EXCEEDED');
    expect(result.step).toBe('context');
    expect(result.error).toBeInstanceOf(PassiveSessionOpenDeadlineError);
    expect(result.error.message).toBe(PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE);
    expect(result.error.step).toBe('context');
    expect(result.ledger).toBeNull();
    expect(result.closeFailures).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.events).toEqual(['createContext:800x600']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes the Context when creating the page does not finish, and returns the open deadline failure', async () => {
    const fake = fakeFactory({ page: 'hang' });

    const startedAt = performance.now();
    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(SHORT_OPEN_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(result.status).toBe('DEADLINE_EXCEEDED');
    if (result.status !== 'DEADLINE_EXCEEDED') throw new Error('expected DEADLINE_EXCEEDED');
    expect(result.step).toBe('page');
    expect(result.error.step).toBe('page');
    expect(result.ledger).toBe(fake.ledger);
    expect(result.closeFailures).toEqual([]);
    expect(fake.events).toEqual(['createContext:800x600', 'getSafetyLedger', 'createPage', 'closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('returns the Context close deadline failure when closing the Context after the page deadline does not finish', async () => {
    const fake = fakeFactory({ page: 'hang', closeContext: 'hang' });

    const startedAt = performance.now();
    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(SHORT_OPEN_TIMEOUT_MS + SHORT_CLOSE_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(result.status).toBe('DEADLINE_EXCEEDED');
    if (result.status !== 'DEADLINE_EXCEEDED') throw new Error('expected DEADLINE_EXCEEDED');
    expect(result.step).toBe('page');
    expect(result.closeFailures).toHaveLength(1);
    expect(result.closeFailures[0]?.step).toBe('context');
    expect(result.closeFailures[0]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('does not start creating anything when the deadline has already passed', async () => {
    const fake = fakeFactory();

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, Date.now() - 1);

    expect(result.status).toBe('DEADLINE_EXCEEDED');
    expect(result.status === 'DEADLINE_EXCEEDED' ? result.step : undefined).toBe('context');
    expect(fake.events).toEqual([]);
  });

  it('closes a Context that arrives after the deadline and hands the result to the receiver', async () => {
    const fake = fakeFactory({ context: 'deferred' });
    const receiver = lateReleaseReceiver();

    const result = await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
      onLateContextRelease: receiver.onLateContextRelease,
    });
    expect(result.status).toBe('DEADLINE_EXCEEDED');
    fake.contextCreation.resolve(fake.context);
    const release = await receiver.first;

    expect(release).toEqual({ ledger: fake.ledger, closeFailure: null });
    expect(Object.isFrozen(release)).toBe(true);
    expect(fake.events).toEqual(['createContext:800x600', 'getSafetyLedger', 'closeContext']);
    // page は作らない。
    expect(fake.events).not.toContain('createPage');
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('hands the Context close deadline failure of a late Context to the receiver', async () => {
    const fake = fakeFactory({ context: 'deferred', closeContext: 'hang' });
    const receiver = lateReleaseReceiver();

    await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
      contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS,
      onLateContextRelease: receiver.onLateContextRelease,
    });
    fake.contextCreation.resolve(fake.context);
    const release = await receiver.first;

    expect(release.ledger).toBe(fake.ledger);
    expect(release.closeFailure?.step).toBe('context');
    expect(release.closeFailure?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes the Context of a ContextConstructionError that arrives after the deadline', async () => {
    const fake = fakeFactory({ context: 'deferred' });
    const receiver = lateReleaseReceiver();

    await openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
      onLateContextRelease: receiver.onLateContextRelease,
    });
    fake.contextCreation.reject(new ContextConstructionError(fake.context, fake.ledger, new Error('late guard failure')));
    const release = await receiver.first;

    expect(release).toEqual({ ledger: fake.ledger, closeFailure: null });
    expect(fake.events).toEqual(['createContext:800x600', 'closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes a late Context even without a receiver, and contains late failures and receiver errors', async () => {
    const withoutReceiver = fakeFactory({ context: 'deferred', closeContext: new Error('late close failed') });
    const plainRejection = fakeFactory({ context: 'deferred' });
    const throwingReceiver = fakeFactory({ context: 'deferred' });
    let receiverCalls = 0;

    const unhandled = await collectUnhandledRejections(async () => {
      await openPassiveSessionBeforeDeadline(withoutReceiver.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));
      await openPassiveSessionBeforeDeadline(plainRejection.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
        onLateContextRelease: () => {
          receiverCalls += 1;
        },
      });
      await openPassiveSessionBeforeDeadline(throwingReceiver.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), {
        onLateContextRelease: () => {
          throw new Error('receiver failed');
        },
      });
      withoutReceiver.contextCreation.resolve(withoutReceiver.context);
      plainRejection.contextCreation.reject(new Error('late newContext failure'));
      throwingReceiver.contextCreation.resolve(throwingReceiver.context);
    });

    expect(unhandled).toEqual([]);
    expect(withoutReceiver.events).toContain('closeContext');
    expect(throwingReceiver.events).toContain('closeContext');
    // Context を持たない失敗は、閉じるものがないので、受け取る口を呼ばない。
    expect(plainRejection.events).toEqual(['createContext:800x600']);
    expect(receiverCalls).toBe(0);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('rejects an invalid deadline or an invalid close timeout without creating anything', async () => {
    const fake = fakeFactory();

    await expect(openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, Number.NaN)).rejects.toThrow(RangeError);
    await expect(openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
    await expect(
      openPassiveSessionBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS), { contextCloseTimeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
    expect(fake.events).toEqual([]);
  });
});

describe('openPassiveContextBeforeDeadline and openPassivePageBeforeDeadline (DEF-008)', () => {
  it('opens only the Context', async () => {
    const fake = fakeFactory();

    const result = await openPassiveContextBeforeDeadline(fake.factory, VIEWPORT, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'OPENED', context: fake.context, ledger: fake.ledger });
    expect(fake.events).toEqual(['createContext:800x600', 'getSafetyLedger']);
  });

  it('opens a page on an open Context', async () => {
    const fake = fakeFactory();

    const result = await openPassivePageBeforeDeadline(fake.factory, fake.context, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'OPENED', page: fake.page });
    expect(fake.events).toEqual(['createPage']);
  });

  it('returns a page creation failure as it was thrown without closing the Context', async () => {
    const error = new Error('newPage failed');
    const fake = fakeFactory({ page: error });

    const result = await openPassivePageBeforeDeadline(fake.factory, fake.context, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result).toEqual({ status: 'FAILED', step: 'page', error });
    expect(fake.events).toEqual(['createPage']);
  });

  it('closes the Context when creating the page does not finish before the deadline', async () => {
    const fake = fakeFactory({ page: 'hang' });

    const result = await openPassivePageBeforeDeadline(fake.factory, fake.context, deadlineIn(SHORT_OPEN_TIMEOUT_MS));

    expect(result.status).toBe('DEADLINE_EXCEEDED');
    if (result.status !== 'DEADLINE_EXCEEDED') throw new Error('expected DEADLINE_EXCEEDED');
    expect(result.step).toBe('page');
    expect(result.closeFailures).toEqual([]);
    expect(fake.events).toEqual(['createPage', 'closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes the Context without creating a page when the deadline has already passed', async () => {
    const fake = fakeFactory();

    const result = await openPassivePageBeforeDeadline(fake.factory, fake.context, Date.now() - 1);

    expect(result.status).toBe('DEADLINE_EXCEEDED');
    expect(fake.events).toEqual(['closeContext']);
  });
});

describe('passiveSessionOpenDeadlineAtMs (DEF-008)', () => {
  it('is SESSION_OPEN_TIMEOUT_MS after now by default', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(passiveSessionOpenDeadlineAtMs()).toBe(1_000_000 + SESSION_OPEN_TIMEOUT_MS);
  });

  it('uses the injected timeout and the earlier of the open deadline and the caller deadline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(passiveSessionOpenDeadlineAtMs({ timeoutMs: 300 })).toBe(1_000_300);
    expect(passiveSessionOpenDeadlineAtMs({ timeoutMs: 300, notAfterMs: 1_000_100 })).toBe(1_000_100);
    expect(passiveSessionOpenDeadlineAtMs({ notAfterMs: 2_000_000 })).toBe(1_000_000 + SESSION_OPEN_TIMEOUT_MS);
  });

  it('rejects a timeout that is not a positive safe integer', () => {
    expect(() => passiveSessionOpenDeadlineAtMs({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => passiveSessionOpenDeadlineAtMs({ timeoutMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('resolvePassiveSessionDeadlines (DEF-008, R15r-4)', () => {
  it('fills the omitted deadlines with the constants of limits.ts and freezes the result', () => {
    const resolved = resolvePassiveSessionDeadlines();

    expect(resolved).toEqual({
      sessionOpenTimeoutMs: SESSION_OPEN_TIMEOUT_MS,
      pageCloseTimeoutMs: PAGE_CLOSE_TIMEOUT_MS,
      contextCloseTimeoutMs: CONTEXT_CLOSE_TIMEOUT_MS,
      onLateContextRelease: undefined,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('keeps the injected deadlines and the receiver', () => {
    const onLateContextRelease = (): void => undefined;

    expect(resolvePassiveSessionDeadlines({
      sessionOpenTimeoutMs: 1,
      pageCloseTimeoutMs: 2,
      contextCloseTimeoutMs: 3,
      onLateContextRelease,
    })).toEqual({ sessionOpenTimeoutMs: 1, pageCloseTimeoutMs: 2, contextCloseTimeoutMs: 3, onLateContextRelease });
  });

  it('rejects invalid deadlines and receivers', () => {
    expect(() => resolvePassiveSessionDeadlines({ sessionOpenTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => resolvePassiveSessionDeadlines({ pageCloseTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => resolvePassiveSessionDeadlines({ contextCloseTimeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => resolvePassiveSessionDeadlines({ onLateContextRelease: 'receiver' as never })).toThrow(TypeError);
    expect(() => resolvePassiveSessionDeadlines(null as never)).toThrow(TypeError);
  });
});

// P18c（設計書 4.2）: この部品の外で期限を付けた作成（Interaction の session の作成）で、期限を過ぎた後に届いた失敗の後始末。
describe('releaseLatePassiveContextFailure (DEF-008, P18c)', () => {
  it('closes the Context of a late ContextConstructionError and hands the result to the receiver', async () => {
    const fake = fakeFactory();
    const receiver = lateReleaseReceiver();

    releaseLatePassiveContextFailure(
      fake.factory,
      new ContextConstructionError(fake.context, fake.ledger, new Error('late guard failure')),
      { onLateContextRelease: receiver.onLateContextRelease },
    );
    const release = await receiver.first;

    expect(release).toEqual({ ledger: fake.ledger, closeFailure: null });
    expect(Object.isFrozen(release)).toBe(true);
    expect(fake.events).toEqual(['closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('hands the Context close deadline failure to the receiver without waiting for the close', async () => {
    const fake = fakeFactory({ closeContext: 'hang' });
    const receiver = lateReleaseReceiver();
    const startedAt = Date.now();

    releaseLatePassiveContextFailure(
      fake.factory,
      new ContextConstructionError(fake.context, fake.ledger, new Error('late guard failure')),
      { contextCloseTimeoutMs: SHORT_CLOSE_TIMEOUT_MS, onLateContextRelease: receiver.onLateContextRelease },
    );
    // 待たずに戻る。
    expect(fake.events).toEqual(['closeContext']);
    const release = await receiver.first;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SHORT_CLOSE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
    expect(Date.now() - startedAt).toBeLessThan(CONTEXT_CLOSE_TIMEOUT_MS);
    expect(release.ledger).toBe(fake.ledger);
    expect(release.closeFailure?.step).toBe('context');
    expect(release.closeFailure?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('does nothing for a failure without a Context, and contains close and receiver failures', async () => {
    const plain = fakeFactory();
    const failingClose = fakeFactory({ closeContext: new Error('late close failed') });
    let receiverCalls = 0;

    const unhandled = await collectUnhandledRejections(async () => {
      releaseLatePassiveContextFailure(plain.factory, new Error('late newContext failure'), {
        onLateContextRelease: () => {
          receiverCalls += 1;
        },
      });
      releaseLatePassiveContextFailure(
        failingClose.factory,
        new ContextConstructionError(failingClose.context, failingClose.ledger, new Error('late guard failure')),
        {
          onLateContextRelease: () => {
            throw new Error('receiver failed');
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(unhandled).toEqual([]);
    expect(plain.events).toEqual([]);
    expect(receiverCalls).toBe(0);
    expect(failingClose.events).toEqual(['closeContext']);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('rejects an invalid close timeout without closing anything', () => {
    const fake = fakeFactory();

    expect(() => releaseLatePassiveContextFailure(
      fake.factory,
      new ContextConstructionError(fake.context, fake.ledger, new Error('late guard failure')),
      { contextCloseTimeoutMs: 0 },
    )).toThrow(RangeError);
    expect(fake.events).toEqual([]);
  });
});
