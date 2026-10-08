import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, CDPSession, Download, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory, ContextConstructionError, type BrowserContextFactoryOptions } from '../../src/browser/context-factory.js';
import { ResourceCache } from '../../src/browser/resource-delivery.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import type { LoadMeter } from '../../src/crawl/load-meter.js';
import { startFixtureServer } from '../../fixtures/server.js';
import type { EgressProxy, EgressProxyOptions } from '../../src/safety/egress-proxy.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import {
  browserWithoutServiceWorkerRegistrationBlock,
  launchCliChromium,
  launchHeadlessChromium,
  useHeadlessChromium,
} from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import {
  openServerWindow,
  QUIET_PERIOD_MS,
  readSharedWorkerFixtureState,
  SERVICE_WORKER_BYPASS_WORKER_PATH,
  serviceWorkerBypassPath,
  SHARED_WORKER_DISABLED_FIXTURE_STATE,
  sharedWorkerPostsPath,
} from '../helpers/gate-harness.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/**
 * 出口の中継（`startEgressProxy`）の差し替えの口（DEF-039・DEF-040 の設計書 2.1.2 の確かめ）。既定では本物の中継を作り、作った中継と
 * その指定（`onRejected`、`onError`）を `created` に残す。`failWith` を入れると、中継を作らずにその例外を投げる。
 */
const egressProxyControl = vi.hoisted(() => ({
  failWith: null as unknown,
  created: [] as { readonly proxy: EgressProxy; readonly options: EgressProxyOptions }[],
}));
vi.mock('../../src/safety/egress-proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/safety/egress-proxy.js')>();
  return {
    ...actual,
    startEgressProxy: async (options: EgressProxyOptions): Promise<EgressProxy> => {
      if (egressProxyControl.failWith !== null) {
        throw egressProxyControl.failWith;
      }
      const proxy = await actual.startEgressProxy(options);
      egressProxyControl.created.push({ proxy, options });
      return proxy;
    },
  };
});

const viewport: Viewport = { width: 800, height: 600 };
let browser: Browser;
const contexts: BrowserContext[] = [];

function configFor(origin = 'https://example.test'): AuditConfig {
  return createTestConfig(origin, '/', { browser: { locale: 'en-GB', timezone: 'Europe/London' } });
}

/** 何もしない、偽の Browser の CDP の session（DEF-044 の自己検査の取り付けを通すだけ）。 */
function fakeBrowserCdpSession(): CDPSession {
  return {
    on: vi.fn(),
    send: vi.fn(async () => ({})),
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
}

function factoryFor(config = configFor(), options: BrowserContextFactoryOptions = {}): BrowserContextFactory {
  return new BrowserContextFactory(browser, config, () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, ...options });
}

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => {
    if (!context.browser()) {
      return;
    }
    await context.close().catch(() => undefined);
  }));
  egressProxyControl.failWith = null;
  await Promise.all(egressProxyControl.created.splice(0).map(({ proxy }) => proxy.close()));
  vi.restoreAllMocks();
});

describe('BrowserContextFactory', () => {
  it('injects locale, timezone, viewport, and blocks service workers', async () => {
    const newContext = vi.spyOn(browser, 'newContext');
    const factory = factoryFor();

    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);

    expect(newContext).toHaveBeenCalledOnce();
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 800, height: 600 },
      serviceWorkers: 'block',
    }));
  });

  it('cannot be constructed without a Safety Ledger factory', () => {
    expect(() => new BrowserContextFactory(
      browser,
      configFor(),
      undefined as unknown as () => SafetyLedger,
    )).toThrow(/ledger/i);
  });

  it('closes a newly constructed Context when guard installation fails', async () => {
    const close = vi.fn(async () => undefined);
    const failedContext = {
      pages: () => [],
      on: vi.fn(),
      // DEF-040: Guard は、取り付けの先頭で、Worker の中の WebSocket を止める CSP の初期化のスクリプトを Context に付ける（偽の Context では
      // 何もしない）。route の取り付けの失敗を確かめるテストなので、これより前で失敗させない。
      addInitScript: vi.fn(async () => undefined),
      routeWebSocket: vi.fn(async () => {
        throw new Error('fixture route installation failure');
      }),
      close,
    } as unknown as BrowserContext;
    const failedBrowser = {
      newContext: vi.fn(async () => failedContext),
      // DEF-044（NP5）: factory は、構築のときに Browser の CDP の session を開き、Shared Worker の自己検査を付ける（偽の session）。
      newBrowserCDPSession: vi.fn(async () => fakeBrowserCdpSession()),
    } as unknown as Browser;
    const factory = new BrowserContextFactory(failedBrowser, configFor(), () => new SafetyLedger());

    // P14f（R14r の Important-1）: Guard が Context を閉じた場合も、Ledger を持つ `ContextConstructionError` を投げ、
    // factory は Context と Ledger の対応を消さない。閉じた Context は、もう閉じられない（所有は解放済み）。
    const failure: unknown = await factory.createPassiveContext(viewport).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContextConstructionError);
    const constructionFailure = failure as ContextConstructionError;
    expect(constructionFailure.context).toBe(failedContext);
    expect((constructionFailure.cause as Error).message).toBe('fixture route installation failure');
    expect(close).toHaveBeenCalledOnce();
    expect(factory.getSafetyLedger(failedContext)).toBe(constructionFailure.ledger);
    // この偽の Context には `off` がないので、listener の後片付けの失敗も記録される。ここでは、取り付けの失敗の記録を確かめる。
    expect(constructionFailure.ledger.snapshot().invariantViolations).toContainEqual(
      { code: 'GUARD_INSTALLATION_FAILED', message: 'fixture route installation failure' },
    );
    await expect(factory.closePassiveContext(failedContext)).rejects.toThrow(/no longer active|not owned/i);
  });

  // P14f（R14r の Important-1、設計書 4.3）: `newContext` の直後に page を1つ開く Browser では、Guard の取り付けが
  // GUARD_INSTALLATION_FAILED で失敗し、Guard が Context を閉じる。その場合も、Ledger を持つ `ContextConstructionError` を投げる。
  it.each(['createPassiveContext', 'createInteractionSession'] as const)(
    '%s throws ContextConstructionError with the Ledger when the Guard closed the Context after its installation failed',
    async (method) => {
      const ledgers: SafetyLedger[] = [];
      const factory = new BrowserContextFactory(browserOpeningPageAfterNewContext(browser, {
        onContextCreated: (context) => contexts.push(context),
      }), configFor(), () => {
        const ledger = new SafetyLedger();
        ledgers.push(ledger);
        return ledger;
      });

      const failure: unknown = await factory[method](viewport).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ContextConstructionError);
      const constructionFailure = failure as ContextConstructionError;
      expect(ledgers).toHaveLength(1);
      expect(constructionFailure.ledger).toBe(ledgers[0]);
      expect(constructionFailure.ledger.snapshot().invariantViolations.map((violation) => violation.code))
        .toContain('GUARD_INSTALLATION_FAILED');
      // Guard が Context を閉じている。factory は、Ledger との対応を残し、所有は解放する。
      expect(browser.contexts()).not.toContain(constructionFailure.context);
      expect(factory.getSafetyLedger(constructionFailure.context)).toBe(constructionFailure.ledger);
      await expect(factory.closePassiveContext(constructionFailure.context)).rejects.toThrow(/no longer active|not owned/i);
    },
  );

  // P14f（R14r の Important-1）: Interaction の session の page の作成に失敗し、factory が Context を閉じた場合も、Ledger を持つ
  // `ContextConstructionError` を投げる。
  it('createInteractionSession throws ContextConstructionError with the Ledger when page creation fails and the Context is closed', async () => {
    const pageCreationFailure = new Error('fixture interaction page creation failure');
    const rawNewContext = browser.newContext.bind(browser);
    vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
      const context = await rawNewContext(options);
      contexts.push(context);
      vi.spyOn(context, 'newPage').mockRejectedValueOnce(pageCreationFailure);
      return context;
    });
    const ledgers: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browser, configFor(), () => {
      const ledger = new SafetyLedger();
      ledgers.push(ledger);
      return ledger;
    });

    const failure: unknown = await factory.createInteractionSession(viewport).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ContextConstructionError);
    const constructionFailure = failure as ContextConstructionError;
    expect(constructionFailure.cause).toBe(pageCreationFailure);
    expect(constructionFailure.ledger).toBe(ledgers[0]);
    expect(browser.contexts()).not.toContain(constructionFailure.context);
    expect(factory.getSafetyLedger(constructionFailure.context)).toBe(constructionFailure.ledger);
    await expect(factory.closePassiveContext(constructionFailure.context)).rejects.toThrow(/no longer active|not owned/i);
  });

  it('rejects a reused Safety Ledger before constructing another Context across factories', async () => {
    const sharedLedger = new SafetyLedger();
    const newContext = vi.spyOn(browser, 'newContext');
    const factory = new BrowserContextFactory(browser, configFor(), () => sharedLedger);
    const secondFactory = new BrowserContextFactory(browser, configFor(), () => sharedLedger);

    const first = await factory.createPassiveContext(viewport);
    contexts.push(first);
    await expect(secondFactory.createPassiveContext(viewport)).rejects.toThrow(/reused|isolated/i);

    expect(newContext).toHaveBeenCalledOnce();
    expect(factory.getSafetyLedger(first)).toBe(sharedLedger);
  });

  it.each(['GUARD_INSTALLATION', 'PAGE_READINESS'] as const)(
    'round 5 retained close retry preserves the construction cause after %s fails',
    async (failurePoint) => {
      // ミューテーション検出: 構築処理が、保持しているContextを露出させずに再送出するか、
      // ファクトリの所有権登録/解放が誤った境界で行われるとこのテストは失敗する。
      const constructionFailure = new Error(`round 5 ${failurePoint} failed`);
      const rawNewContext = browser.newContext.bind(browser);
      let closeCalls = 0;
      vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
        const context = await rawNewContext(options);
        contexts.push(context);
        const rawClose = context.close.bind(context);
        vi.spyOn(context, 'close').mockImplementation(async () => {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error('first retained close failed');
          await rawClose();
        });
        if (failurePoint === 'GUARD_INSTALLATION') {
          vi.spyOn(context, 'routeWebSocket').mockRejectedValue(constructionFailure);
        } else {
          vi.spyOn(context, 'newCDPSession').mockRejectedValue(constructionFailure);
        }
        return context;
      });
      const factory = factoryFor();
      try {
        const failure: unknown = await (failurePoint === 'GUARD_INSTALLATION'
          ? factory.createPassiveContext(viewport)
          : factory.createInteractionSession(viewport)).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          name: 'ContextConstructionError',
          context: expect.any(Object),
        });
        const retained = failure as ContextConstructionError;
        if (failurePoint === 'GUARD_INSTALLATION') {
          expect(retained.cause).toBe(constructionFailure);
        } else {
          // readinessは確立済みの無効化エラーを保持しつつ、元のプロトコル失敗を
          // 標準のErrorのcauseチェーンに残しておく。
          expect(retained.cause).toMatchObject({
            message: 'Passive request guard context was invalidated', cause: constructionFailure,
          });
          expect((retained.cause as Error).cause).toBe(constructionFailure);
        }
        expect(Object.isFrozen(retained)).toBe(true);
        // 利用可能な唯一のContextは、拒否された構築処理自身が持つものである。
        expect(closeCalls).toBe(1);
        expect(browser.contexts()).toContain(retained.context);
        await expect(factory.createPassivePage(retained.context)).rejects.toThrow(/invalidated/i);
        expect(factory.getSafetyLedger(retained.context).snapshot().invariantViolations).toContainEqual({
          code: 'GUARD_CONTEXT_INVALIDATION_FAILED', message: 'first retained close failed',
        });
        await expect(factory.closePassiveContext(retained.context)).rejects.toThrow(/invalidated/i);
        expect(closeCalls).toBe(2);
        expect(browser.contexts()).not.toContain(retained.context);
        await expect(factory.closePassiveContext(retained.context)).rejects.toThrow(/no longer active|not owned/i);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('creates one isolated ledger per owned Context', async () => {
    const ledgers: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browser, configFor(), () => {
      const ledger = new SafetyLedger();
      ledgers.push(ledger);
      return ledger;
    });

    const first = await factory.createPassiveContext(viewport);
    const second = await factory.createPassiveContext(viewport);
    contexts.push(first, second);

    expect(ledgers).toHaveLength(2);
    expect(factory.getSafetyLedger(first)).toBe(ledgers[0]);
    expect(factory.getSafetyLedger(second)).toBe(ledgers[1]);
    ledgers[0]?.recordInvariantViolation({ code: 'FIXTURE_ONLY', message: 'isolated' });
    expect(factory.getSafetyLedger(first).snapshot().invariantViolations).toHaveLength(1);
    expect(factory.getSafetyLedger(second).snapshot().invariantViolations).toHaveLength(0);
  });

  it('returns a page only after its passive guard is ready for immediate navigation', async () => {
    const factory = factoryFor();
    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);

    const page = await factory.createPassivePage(context);
    await expect(page.goto('data:text/html,<title>ready</title>')).resolves.toBeNull();
    await expect(page.title()).resolves.toBe('ready');
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);

    await factory.closePassivePage(page);
    await factory.closePassiveContext(context);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  });

  it('rejects foreign Context and Page lifecycle operations', async () => {
    const factory = factoryFor();
    const foreignContext = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(foreignContext);
    const foreignPage = await foreignContext.newPage();

    await expect(factory.createPassivePage(foreignContext)).rejects.toThrow(/owned/i);
    expect(() => factory.getSafetyLedger(foreignContext)).toThrow(/owned/i);
    await expect(factory.closePassivePage(foreignPage)).rejects.toThrow(/owned/i);
    await expect(factory.closePassiveContext(foreignContext)).rejects.toThrow(/owned/i);
  });

  it('drops Page and Context ownership when guarded Page close fails', async () => {
    const factory = factoryFor();
    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);
    const page = await factory.createPassivePage(context);
    vi.spyOn(page, 'close').mockRejectedValueOnce(new Error('fixture guarded close failure'));

    await expect(factory.closePassivePage(page)).rejects.toThrow('fixture guarded close failure');

    const newPage = vi.spyOn(context, 'newPage');
    await expect(factory.createPassivePage(context)).rejects.toThrow(/active|invalidated/i);
    expect(newPage).not.toHaveBeenCalled();
    await expect(factory.closePassivePage(page)).rejects.toThrow(/owned|active/i);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: 'fixture guarded close failure',
    }]));
  });

  it('consults Task 5 guard state before newPage after asynchronous invalidation', async () => {
    const factory = factoryFor();
    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);
    const page = await factory.createPassivePage(context);

    await page.close();
    await expect.poll(() => factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'CDP_SESSION_DETACHED',
      message: expect.stringContaining('detached'),
    }]));

    const newPage = vi.spyOn(context, 'newPage');
    await expect(factory.createPassivePage(context)).rejects.toThrow(/invalidated/i);
    expect(newPage).not.toHaveBeenCalled();
  });

  it('joins an already-published invalidation through InteractionGuardedSession close and its evidence cutoff', async () => {
    const cancelGate = createDeferred<void>();
    const server = await startFixtureServer();
    try {
      const factory = factoryFor(configFor(server.origin));
      const session = await factory.createInteractionSession(viewport);
      const context = session.page.context();
      contexts.push(context);
      const rawContextClose = vi.spyOn(context, 'close');
      await session.page.goto(`${server.origin}/`);
      await session.activateInteractionFreeze();
      const emit = session.page as unknown as {
        emit(event: string, value: unknown): boolean;
      };
      emit.emit('download', {
        url: () => 'data:text/plain,factory-invalidation-race',
        suggestedFilename: () => 'factory-invalidation-race.txt',
        cancel: () => cancelGate.promise,
      } as unknown as Download);

      await session.page.close();
      await expect.poll(() => rawContextClose.mock.calls.length).toBe(1);
      let sessionCloseSettled = false;
      let sessionCloseError: unknown;
      const sessionClosing = session.close().then(
        () => { sessionCloseSettled = true; },
        (error: unknown) => { sessionCloseError = error; sessionCloseSettled = true; },
      );
      await wait(20);
      expect(sessionCloseSettled).toBe(false);

      cancelGate.reject(new Error('factory invalidation cutoff cancel failed'));
      await sessionClosing;

      expect(sessionCloseError).toMatchObject({
        message: 'Passive request guard context was invalidated',
      });
      expect(rawContextClose).toHaveBeenCalledOnce();
      expect(session.ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
        code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
        message: 'factory invalidation cutoff cancel failed',
      }]));
    } finally {
      await server.close();
    }
  });

  it('retains factory close ownership after an active-only operation observes invalidation', async () => {
    const cancelGate = createDeferred<void>();
    const server = await startFixtureServer();
    try {
      const factory = factoryFor(configFor(server.origin));
      const session = await factory.createInteractionSession(viewport);
      const context = session.page.context();
      contexts.push(context);
      const rawContextClose = vi.spyOn(context, 'close');
      await session.page.goto(`${server.origin}/`);
      await session.activateInteractionFreeze();
      const emit = session.page as unknown as {
        emit(event: string, value: unknown): boolean;
      };
      emit.emit('download', {
        url: () => 'data:text/plain,factory-active-operation-race',
        suggestedFilename: () => 'factory-active-operation-race.txt',
        cancel: () => cancelGate.promise,
      } as unknown as Download);

      await session.page.close();
      await expect.poll(() => rawContextClose.mock.calls.length).toBe(1);
      await expect(session.activateInteractionFreeze()).rejects.toThrow(/invalidated/i);

      let sessionCloseSettled = false;
      const sessionClosing = session.close().then(
        () => { sessionCloseSettled = true; },
        () => { sessionCloseSettled = true; },
      );
      await wait(20);
      expect(sessionCloseSettled).toBe(false);

      cancelGate.reject(new Error('factory active-operation cutoff cancel failed'));
      await sessionClosing;

      expect(rawContextClose).toHaveBeenCalledOnce();
      expect(session.ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
        code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
        message: 'factory active-operation cutoff cancel failed',
      }]));
    } finally {
      await server.close();
    }
  });

  it('lifecycle priority retained close retry releases session ownership only at CLOSED', async () => {
    const server = await startFixtureServer();
    try {
      const factory = factoryFor(configFor(server.origin));
      const session = await factory.createInteractionSession(viewport);
      const context = session.page.context();
      contexts.push(context);
      await session.page.goto(`${server.origin}/`);
      await session.activateInteractionFreeze();
      const originalClose = context.close.bind(context);
      let attempts = 0;
      vi.spyOn(context, 'close').mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first retained close failed');
        await originalClose();
      });
      await expect(session.close()).rejects.toThrow('first retained close failed');
      expect(session.isClosed()).toBe(false);
      expect(session.page.isClosed()).toBe(false);
      expect(attempts).toBe(1);
      expect(session.ledger.snapshot().invariantViolations).toContainEqual({
        code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: 'first retained close failed',
      });
      await expect(factory.createPassivePage(context)).rejects.toThrow(/invalidated/i);
      // I1/Q3（設計書 4.1）: invalidation を経て CLOSED に達した close は、前回の失敗にかかわらず
      // factory.closePassiveContext() と同じく invalidated で reject する。所有は CLOSED で解放する。
      await expect(session.close()).rejects.toThrow('Passive request guard context was invalidated');
      expect(session.isClosed()).toBe(true);
      expect(session.page.isClosed()).toBe(true);
      expect(attempts).toBe(2);
      await expect(session.close()).rejects.toThrow(/already closed/i);
      await expect(factory.closePassiveContext(context)).rejects.toThrow(/no longer active|not owned/i);
    } finally {
      vi.restoreAllMocks();
      await server.close();
    }
  });

  it('does not close an already invalidated Context twice after readiness failure', async () => {
    const factory = factoryFor();
    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);
    const close = vi.spyOn(context, 'close');
    vi.spyOn(context, 'newCDPSession').mockRejectedValueOnce(new Error('fixture readiness failure'));

    const failure = await factory.createPassivePage(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'ContextConstructionError',
      cause: { message: 'Passive request guard context was invalidated',
        cause: { message: 'fixture readiness failure' } } });
    expect((failure as ContextConstructionError).context).toBe(context);
    await expect(factory.closePassiveContext(context)).rejects.toThrow(/invalidated/i);
    await expect.poll(() => close).toHaveBeenCalledOnce();
    await expect(factory.createPassivePage(context)).rejects.toThrow(/active|invalidated/i);
  });

  it('retained close retry releases the factory Context only after physical close', async () => {
    const factory = factoryFor();
    const context = await factory.createPassiveContext(viewport);
    contexts.push(context);
    const page = await factory.createPassivePage(context);
    const rawClose = context.close.bind(context);
    let attempts = 0;
    vi.spyOn(context, 'close').mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first retained close failed');
      await rawClose();
    });
    try {
      await expect(factory.closePassiveContext(context)).rejects.toThrow('first retained close failed');
      expect(page.isClosed()).toBe(false);
      expect(attempts).toBe(1);
      expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toContainEqual({
        code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: 'first retained close failed',
      });
      await expect(factory.closePassiveContext(context)).rejects.toThrow(/invalidated/i);
      expect(attempts).toBe(2);
      expect(page.isClosed()).toBe(true);
      await expect(factory.closePassiveContext(context)).rejects.toThrow(/no longer active|not owned/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(['PAGE_CLOSE', 'PAGE_READINESS'] as const)(
    'lifecycle priority retained close retry recovers the Context owner after %s fails',
    async (failurePoint) => {
      const factory = factoryFor();
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = failurePoint === 'PAGE_CLOSE' ? await factory.createPassivePage(context) : undefined;
      const originalClose = context.close.bind(context);
      let attempts = 0;
      vi.spyOn(context, 'close').mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first retained close failed');
        await originalClose();
      });
      try {
        if (page !== undefined) {
          vi.spyOn(page, 'close').mockRejectedValue(new Error('page close failed'));
          await expect(factory.closePassivePage(page)).rejects.toThrow('page close failed');
        } else {
          vi.spyOn(context, 'newCDPSession').mockRejectedValue(new Error('page readiness failed'));
          const failure = await factory.createPassivePage(context).catch((error: unknown) => error);
          expect(failure).toMatchObject({ name: 'ContextConstructionError',
            cause: { message: 'Passive request guard context was invalidated',
              cause: { message: 'page readiness failed' } } });
          expect((failure as ContextConstructionError).context).toBe(context);
        }
        // ページ失敗時のどちらのcatch分岐でも、Context所有権の削除漏れを検出する。
        expect(attempts).toBe(1);
        expect(browser.contexts()).toContain(context);
        await expect(factory.closePassiveContext(context)).rejects.toThrow('Passive request guard context was invalidated');
        expect(attempts).toBe(2);
        expect(browser.contexts()).not.toContain(context);
        await expect(factory.closePassiveContext(context)).rejects.toThrow(/no longer active|not owned/i);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('snapshots viewport and allowed origins before creating a Context', async () => {
    const mutableViewport = { width: 700, height: 500 };
    const mutableOrigins = ['https://example.test/path'];
    const config = configFor();
    const mutableConfig = {
      ...config,
      site: { ...config.site, allowedOrigins: mutableOrigins },
    } satisfies AuditConfig;
    const factory = factoryFor(mutableConfig);

    mutableOrigins[0] = 'https://attacker.invalid';
    const context = await factory.createPassiveContext(mutableViewport);
    contexts.push(context);
    mutableViewport.width = 1;

    const page = await factory.createPassivePage(context);
    expect(page.viewportSize()).toEqual({ width: 700, height: 500 });
    await expect(page.goto('https://attacker.invalid/')).rejects.toThrow();
    expect(factory.getSafetyLedger(context).snapshot().blockedNavigations).toHaveLength(1);
  });

  it.each([
    ['a fractional width', { width: 800.5, height: 600 }],
    ['a fractional height', { width: 800, height: 600.25 }],
    ['an unsafe integer width', { width: Number.MAX_SAFE_INTEGER + 1, height: 600 }],
  ] as const)('rejects %s as the viewport before creating a Context (F07 finding 6)', async (_name, fractional) => {
    const newContext = vi.spyOn(browser, 'newContext');
    const factory = factoryFor();

    await expect(factory.createPassiveContext(fractional)).rejects.toThrow(/positive safe integers/u);
    expect(newContext).not.toHaveBeenCalled();
  });

  describe('V13: browser settings take effect in a real browser', () => {
    it('blocks Service Worker registration in the passive Context', async () => {
      const server = await startFixtureServer();
      const factory = factoryFor(configFor(server.origin));
      // 対照: 遮断しない Context では、同じページで登録でき、Worker のスクリプトが取得される（テストが空振りしないことの確認）。
      // DEF-049: factory の自己検査は、同じ Browser のどの Context の Service Worker を見ても、その時点で所有するすべての Context を閉じる
      // ので、対照は、Guard の付いた Context を作る前に行う。
      const unblockedContext = await browser.newContext({ viewport });
      contexts.push(unblockedContext);
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      try {
        const unblockedPage = await unblockedContext.newPage();
        await unblockedPage.goto(`${server.origin}/service-worker.html`);
        await unblockedPage.evaluate(() => navigator.serviceWorker.register('/fixture-service-worker.js'));
        await expect.poll(() => unblockedPage.evaluate(async () => (
          (await navigator.serviceWorker.getRegistrations()).length
        ))).toBe(1);
        expect(server.getRequestObservations().some((observation) => (
          observation.pathname === '/fixture-service-worker.js'
        ))).toBe(true);
        await unblockedContext.close();
        server.resetRequestObservations();

        context = await factory.createPassiveContext(viewport);
        contexts.push(context);
        page = await factory.createPassivePage(context);
        await page.goto(`${server.origin}/service-worker.html`);
        // fixture のボタンの処理（`navigator.serviceWorker.register('/fixture-service-worker.js')`）を実行する。
        await page.evaluate(() => {
          document.querySelector('button')?.click();
        });
        await page.evaluate(async () => {
          await navigator.serviceWorker.register('/fixture-service-worker.js').catch(() => undefined);
        });
        await wait(200);

        const state = await page.evaluate(async () => ({
          registrations: (await navigator.serviceWorker.getRegistrations()).length,
          controlled: navigator.serviceWorker.controller !== null,
        }));
        expect(state).toEqual({ registrations: 0, controlled: false });
        expect(server.getRequestObservations().map((observation) => observation.pathname))
          .not.toContain('/fixture-service-worker.js');
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      } finally {
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });

    it('applies the configured locale and timezone inside the browser', async () => {
      const server = await startFixtureServer();
      // 実行環境の既定値と重なりにくい値を使う。
      const config = createTestConfig(server.origin, '/', { browser: { locale: 'de-CH', timezone: 'Pacific/Auckland' } });
      const factory = factoryFor(config);
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      try {
        await page.goto(`${server.origin}/index.html`);

        const observed = await page.evaluate(() => ({
          language: navigator.language,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }));

        expect(observed).toEqual({ language: 'de-CH', locale: 'de-CH', timeZone: 'Pacific/Auckland' });
      } finally {
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });
  });

  describe('V1/M3: page-initiated downloads are never accepted', () => {
    it('creates Passive and Interaction Contexts with acceptDownloads disabled', async () => {
      const newContext = vi.spyOn(browser, 'newContext');
      const factory = factoryFor();

      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const session = await factory.createInteractionSession(viewport);
      contexts.push(session.page.context());
      try {
        expect(newContext).toHaveBeenCalledTimes(2);
        for (const [options] of newContext.mock.calls) {
          expect(options).toMatchObject({ acceptDownloads: false });
        }
      } finally {
        await closePassiveResources({ factory, context });
        await session.close().catch(() => undefined);
      }
    });

    it.each([
      ['an HTTP download', 1, '/__download'],
      ['a generated data-URL download', 0, 'data:text/plain,fixture-download'],
    ] as const)('does not save %s clicked by page script in the passive phase and records it', async (
      _name,
      buttonIndex,
      downloadUrl,
    ) => {
      const server = await startFixtureServer();
      const factory = factoryFor(configFor(server.origin));
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      try {
        const downloads: Download[] = [];
        page.on('download', (download) => downloads.push(download));
        await page.goto(`${server.origin}/download-button.html`);

        await page.evaluate((index) => {
          document.querySelectorAll('button')[index]?.click();
        }, buttonIndex);

        const expectedUrl = downloadUrl.startsWith('/') ? `${server.origin}${downloadUrl}` : downloadUrl;
        await expect.poll(() => factory.getSafetyLedger(context).snapshot().blockedDownloads).toEqual([
          expect.objectContaining({ url: expectedUrl, reason: 'PASSIVE_DOWNLOAD' }),
        ]);
        expect(downloads).toHaveLength(1);
        expect(await downloads[0]!.failure()).not.toBeNull();
        await expect(downloads[0]!.path()).rejects.toThrow();
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      } finally {
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });
  });

  // L4（サイトへの負荷の制御の設計書 4.5）: factory は、作るすべての Context の要求の終わりの事象を、渡された LoadMeter に
  // そのまま渡す（数えない）。渡されなければ、事象を受け取らない。
  describe('L4: request end events are passed to the load meter', () => {
    /** 受け取った呼び出しを、そのまま記録する偽の LoadMeter（数え方は `LoadMeter` の単体テストで確かめる）。 */
    function recordingLoadMeter(): {
      readonly meter: LoadMeter;
      readonly finished: { readonly request: object; readonly url: string }[];
      readonly failed: { readonly request: object; readonly url: string; readonly errorText: string | null }[];
    } {
      const finished: { readonly request: object; readonly url: string }[] = [];
      const failed: { readonly request: object; readonly url: string; readonly errorText: string | null }[] = [];
      const meter: LoadMeter = {
        recordRequestFinished: (request, url) => {
          finished.push({ request, url });
        },
        recordRequestFailed: (request, url, errorText) => {
          failed.push({ request, url, errorText });
        },
        recordServedFromRunCache: () => undefined,
        recordWithheld: () => undefined,
        snapshot: () => {
          throw new Error('the factory must not read the load meter');
        },
        // L7（設計書 4.8）: 直近の1分の件数も、factory は読まない。
        recentPerMinute: () => {
          throw new Error('the factory must not read the load meter');
        },
      };
      return { meter, finished, failed };
    }

    it('passes requestfinished of the Passive and Interaction Contexts with the request and its URL', async () => {
      const server = await startFixtureServer();
      const recording = recordingLoadMeter();
      const factory = new BrowserContextFactory(
        browser,
        configFor(server.origin),
        () => new SafetyLedger(),
        { ...TEST_FACTORY_OPTIONS, loadMeter: recording.meter },
      );
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      const session = await factory.createInteractionSession(viewport);
      contexts.push(session.page.context());
      try {
        await page.goto(`${server.origin}/unsized-svg-image.html`, { waitUntil: 'load' });
        await expect.poll(() => recording.finished.map(({ url }) => url)).toEqual([
          `${server.origin}/unsized-svg-image.html`,
          `${server.origin}/unsized-image.svg`,
        ]);
        await session.page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
        await expect.poll(() => recording.finished.map(({ url }) => url)).toEqual([
          `${server.origin}/unsized-svg-image.html`,
          `${server.origin}/unsized-image.svg`,
          `${server.origin}/index.html`,
        ]);
        // 渡す鍵は、事象の Playwright の Request そのもの（キャッシュから返した印の照合に使う）。
        for (const { request, url } of recording.finished) {
          expect((request as { url(): string }).url()).toBe(url);
        }
        expect(recording.failed).toEqual([]);
      } finally {
        await closePassiveResources({ factory, context, page });
        await session.close().catch(() => undefined);
        await server.close();
      }
    });

    it('passes requestfailed with its failure reason, including the requests the Guard blocked', async () => {
      const server = await startFixtureServer();
      const recording = recordingLoadMeter();
      const factory = new BrowserContextFactory(
        browser,
        configFor(server.origin),
        () => new SafetyLedger(),
        { loadMeter: recording.meter },
      );
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      // Playwright が報告した失敗の理由（factory が渡したものと比べる）。
      const reported: string[] = [];
      context.on('requestfailed', (request) => {
        reported.push(`${request.url()} ${request.failure()?.errorText ?? null}`);
      });
      const page = await factory.createPassivePage(context);
      try {
        await page.goto(`${server.origin}/passive-patch-request.html`, { waitUntil: 'load' });
        await expect.poll(() => reported.length).toBe(1);
        // Guard が止めた PATCH。Chromium は、page の中の要求を止めた理由を `net::ERR_BLOCKED_BY_CLIENT.Inspector` と報告する。
        expect(reported[0]?.startsWith(`${server.origin}/__mutation net::ERR_BLOCKED_BY_CLIENT`), reported[0]).toBe(true);
        // 許可 Origin の外の、つながらない宛先への GET（Guard は通す）。
        const refusedUrl = 'http://127.0.0.1:9/unreachable.js';
        await page.evaluate(async (url) => {
          await fetch(url, { mode: 'no-cors' }).catch(() => undefined);
        }, refusedUrl);
        await expect.poll(() => reported.length).toBe(2);
        expect(reported[1]?.startsWith(`${refusedUrl} net::ERR_`), reported[1]).toBe(true);
        expect(reported[1]).not.toMatch(/BLOCKED_BY_CLIENT/u);
        // factory は、Playwright が報告した URL と失敗の理由を、そのまま渡す（数えるかどうかは meter が決める）。
        expect(recording.failed.map(({ url, errorText }) => `${url} ${errorText}`)).toEqual(reported);
        for (const { request, url } of recording.failed) {
          expect((request as { url(): string }).url()).toBe(url);
        }
        expect(server.getCounters().patch).toBe(0);
      } finally {
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });

    it('does not listen to request end events when no load meter is given', async () => {
      const server = await startFixtureServer();
      const factory = factoryFor(configFor(server.origin));
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const withMeter = new BrowserContextFactory(
        browser,
        configFor(server.origin),
        () => new SafetyLedger(),
        { loadMeter: recordingLoadMeter().meter },
      );
      const meteredContext = await withMeter.createPassiveContext(viewport);
      contexts.push(meteredContext);
      // Playwright の BrowserContext は、実行時には EventEmitter（`listenerCount` を持つ）である。
      const listeners = (target: BrowserContext, event: string): number =>
        (target as unknown as { listenerCount(eventName: string): number }).listenerCount(event);
      try {
        expect(listeners(context, 'requestfinished')).toBe(0);
        expect(listeners(meteredContext, 'requestfinished')).toBe(1);
        expect(listeners(meteredContext, 'requestfailed')).toBe(listeners(context, 'requestfailed') + 1);
      } finally {
        await closePassiveResources({ factory, context });
        await closePassiveResources({ factory: withMeter, context: meteredContext });
        await server.close();
      }
    });
  });

  // L5b（サイトへの負荷の制御の設計書 4.6、4.7）と DEF-031（設計書 4.10.3）: Context の役割（既定は PRIMARY）と、Run 全体のキャッシュの配線。
  // キャッシュを渡した factory は、作るすべての Context の応答をキャッシュに入れ、すべての Context の Guard に、その役割の届け方の部品を
  // 渡す（PRIMARY も、キャッシュにあるものはキャッシュから返す）。
  // キャッシュを渡さない factory は、今の振る舞いのまま（応答を受け取らず、どの役割でも、すべてネットワークに送る）。
  describe('L5b: Context roles and the Run cache', () => {
    /** 画像を1つ読むページと、その画像（Run 全体のキャッシュに入る種類）。 */
    const IMAGE_PAGE = '/unsized-svg-image.html';
    const IMAGE_PATH = '/unsized-image.svg';
    /** Playwright の BrowserContext は、実行時には EventEmitter（`listenerCount` を持つ）である。 */
    const listeners = (target: BrowserContext, event: string): number =>
      (target as unknown as { listenerCount(eventName: string): number }).listenerCount(event);

    function cachedFactoryFor(origin: string): { readonly factory: BrowserContextFactory; readonly cache: ResourceCache } {
      const cache = new ResourceCache();
      return { factory: new BrowserContextFactory(browser, configFor(origin), () => new SafetyLedger(), { resourceCache: cache }), cache };
    }

    /**
     * `factory` で `role` の Context と page を作り、`url` を読み込んでから閉じる。`beforeClose` があれば、閉じる前に待つ。
     * DEF-038: page を個別に閉じず、Context と一緒に閉じるようになったので、読み込みの直後に閉じると、Run 全体のキャッシュに応答の
     * 本文を入れる処理（`response.body()`）が終わる前に Context が閉じることがある。キャッシュに入ることを前提にする読み込みは、
     * `beforeClose` でキャッシュに入ったことを待ってから閉じる。
     */
    async function loadOnce(
      factory: BrowserContextFactory,
      url: string,
      role?: 'PRIMARY' | 'REVISIT',
      beforeClose?: () => Promise<void>,
    ): Promise<void> {
      const context = await factory.createPassiveContext(viewport, role);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      try {
        await page.goto(url, { waitUntil: 'load' });
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
        await beforeClose?.();
      } finally {
        await closePassiveResources({ factory, context, page });
      }
    }

    const imageRequests = (server: Awaited<ReturnType<typeof startFixtureServer>>): number =>
      server.getRequestObservations().filter((observation) => observation.pathname === IMAGE_PATH).length;

    it('creates PRIMARY Contexts by default; their Guard also gets the delivery part and serves the cached image from the Run cache (DEF-031)', async () => {
      const server = await startFixtureServer();
      const { factory, cache } = cachedFactoryFor(server.origin);
      try {
        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, undefined, async () => {
          await expect.poll(() => cache.lookup(`${server.origin}${IMAGE_PATH}`)).toBeDefined();
        });
        // 空振りでないこと: 1回目（キャッシュが空）の読み込みでは、画像はサーバに届いた。
        expect(imageRequests(server)).toBe(1);

        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`);
        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, 'PRIMARY');

        // 役割を省略した Context も、PRIMARY と同じく、キャッシュにある画像をキャッシュから返す（サーバに届かない）。文書は毎回届く。
        expect(server.getRequestObservations().filter((observation) => observation.pathname === IMAGE_PAGE)).toHaveLength(3);
        expect(imageRequests(server)).toBe(1);
      } finally {
        await server.close();
      }
    });

    it('marks the requests a PRIMARY Context served from the Run cache in the LoadMeter, as in a REVISIT Context (DEF-031)', async () => {
      const server = await startFixtureServer();
      const cache = new ResourceCache();
      const served: object[] = [];
      const loadMeter: LoadMeter = {
        recordRequestFinished: () => undefined,
        recordRequestFailed: () => undefined,
        recordServedFromRunCache: (request) => {
          served.push(request);
        },
        recordWithheld: () => undefined,
        snapshot: () => {
          throw new Error('not used in this test');
        },
        recentPerMinute: () => {
          throw new Error('not used in this test');
        },
      };
      const factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, resourceCache: cache, loadMeter });
      try {
        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, 'PRIMARY', async () => {
          await expect.poll(() => cache.lookup(`${server.origin}${IMAGE_PATH}`)).toBeDefined();
        });
        expect(served).toHaveLength(0);

        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, 'PRIMARY');

        // キャッシュから返した画像の要求に、1回だけ印を付けた。その応答は、キャッシュに入れ直さない（項目は1つのまま）。
        expect(served.map((request) => new URL((request as { url(): string }).url()).pathname)).toEqual([IMAGE_PATH]);
        expect(cache.stats().entryCount).toBe(1);
        expect(imageRequests(server)).toBe(1);
      } finally {
        await server.close();
      }
    });

    it('passes the delivery part to the Guard of a REVISIT Context, which serves the cached image from the Run cache', async () => {
      const server = await startFixtureServer();
      const { factory, cache } = cachedFactoryFor(server.origin);
      try {
        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, undefined, async () => {
          await expect.poll(() => cache.lookup(`${server.origin}${IMAGE_PATH}`)).toBeDefined();
        });

        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, 'REVISIT');
        // Interaction の session の Context も、REVISIT である（呼び出し側は役割を渡さない）。
        const session = await factory.createInteractionSession(viewport);
        contexts.push(session.page.context());
        try {
          await session.page.goto(`${server.origin}${IMAGE_PAGE}`, { waitUntil: 'load' });
          expect(session.ledger.snapshot().invariantViolations).toEqual([]);
        } finally {
          await session.close().catch(() => undefined);
        }

        // 文書は3回とも届くが、画像は主の読み込みの1回だけ届く。
        expect(server.getRequestObservations().filter((observation) => observation.pathname === IMAGE_PAGE)).toHaveLength(3);
        expect(imageRequests(server)).toBe(1);
      } finally {
        await server.close();
      }
    });

    it('keeps the current behavior without a Run cache: no request end listener, and REVISIT Contexts take everything from the network', async () => {
      const server = await startFixtureServer();
      const factory = factoryFor(configFor(server.origin));
      const { factory: withCache } = cachedFactoryFor(server.origin);
      const context = await factory.createPassiveContext(viewport, 'REVISIT');
      contexts.push(context);
      const cachedContext = await withCache.createPassiveContext(viewport, 'REVISIT');
      contexts.push(cachedContext);
      try {
        // キャッシュがなければ、要求が成功して終わった事象（`requestfinished`）を受け取らない（キャッシュがあれば、factory が1つだけ
        // 受け取る。どちらの factory にも meter はない）。キャッシュに入れるのは、要求が成功して終わった応答だけなので、応答の事象
        // （`response`）は、どちらも受け取らない（PCR-DR の Important-1。設計書 4.10.3）。
        expect(listeners(context, 'requestfinished')).toBe(0);
        expect(listeners(cachedContext, 'requestfinished')).toBe(1);
        expect(listeners(context, 'response')).toBe(0);
        expect(listeners(cachedContext, 'response')).toBe(0);

        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`);
        await loadOnce(factory, `${server.origin}${IMAGE_PAGE}`, 'REVISIT');
        expect(imageRequests(server)).toBe(2);
      } finally {
        await closePassiveResources({ factory, context });
        await closePassiveResources({ factory: withCache, context: cachedContext });
        await server.close();
      }
    });

    it('rejects an unknown role before creating a Context, and a Run cache that is not a ResourceCache', async () => {
      const newContext = vi.spyOn(browser, 'newContext');
      const ledgers: SafetyLedger[] = [];
      const factory = new BrowserContextFactory(browser, configFor(), () => {
        const ledger = new SafetyLedger();
        ledgers.push(ledger);
        return ledger;
      });

      await expect(factory.createPassiveContext(viewport, 'OTHER' as unknown as 'PRIMARY')).rejects.toThrow(TypeError);
      expect(newContext).not.toHaveBeenCalled();
      expect(ledgers).toEqual([]);
      expect(() => new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), {
        resourceCache: { lookup: () => undefined, store: () => true } as unknown as ResourceCache,
      })).toThrow(TypeError);
    });

    /** `handle` で応答する、この試験だけのサーバ（ループバック）を起動し、Origin と閉じる関数を返す。 */
    async function startBodyServer(
      handle: (pathname: string, response: ServerResponse) => void,
    ): Promise<{ readonly origin: string; close(): Promise<void> }> {
      const server = createServer((request, response) => {
        handle((request.url ?? '/').split('?', 1)[0] ?? '/', response);
      });
      await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
      const { port } = server.address() as AddressInfo;
      return {
        origin: `http://127.0.0.1:${port}`,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    const SMALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>';

    /**
     * Playwright の Response の `body` を見張る（どの応答の本文を取ろうとしたか）。prototype は、`page` で `url` を読み込んだ応答から取る。
     * `reject` に当たる URL の応答では、本文を取れなかったことにする（拒否する）。それ以外は、本物の `body` を呼ぶ。
     */
    async function watchResponseBodies(
      page: Page,
      url: string,
      reject: (responseUrl: string) => boolean = () => false,
    ): Promise<() => string[]> {
      const first = await page.goto(url, { waitUntil: 'load' });
      const prototype = Object.getPrototypeOf(first) as { body(): Promise<Buffer> };
      const original = prototype.body;
      const body = vi.spyOn(prototype, 'body').mockImplementation(function (this: { url(): string }) {
        return reject(this.url()) ? Promise.reject(new Error('fixture body unavailable')) : original.call(this);
      });
      return () => body.mock.contexts.map((response) => (response as { url(): string }).url());
    }

    // L5b-fix-round-1: factory は、キャッシュが入れる見込みがある（`ResourceCache.mayStore`）応答の本文だけを読む。文書、XHR、fetch、
    // リダイレクトの応答と、`content-length` がそのキャッシュの1件の上限を超えると分かる応答は、本文を読まない。画像は今までどおり入る。
    it('reads the body only of the responses the Run cache may store (L5b-fix-round-1)', async () => {
      // 1件の上限を小さくしたキャッシュ（`content-length` の判断が、そのキャッシュ自身の上限で行われることを確かめる）。
      const limits = Object.freeze({ maxEntryBytes: 1_024, maxTotalBytes: 4_096 });
      const oversizedBytes = limits.maxEntryBytes + 1;
      const server = await startBodyServer((pathname, response) => {
        switch (pathname) {
          case '/page.html':
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end([
              '<!doctype html><title>bodies</title>',
              '<img src="/small.svg" alt="small"><img src="/oversized.svg" alt="oversized"><img src="/redirect.svg" alt="redirect">',
              '<script>',
              'const xhr = new XMLHttpRequest();',
              'const xhrDone = new Promise((resolve) => { xhr.addEventListener("loadend", resolve); });',
              'xhr.open("GET", "/data.json"); xhr.send();',
              'Promise.all([xhrDone, fetch("/fetch.json").then((r) => r.text())]).then(() => { window.requestsDone = true; });',
              '</script>',
            ].join(''));
            return;
          case '/small.svg':
          case '/target.svg':
            response.setHeader('Content-Type', 'image/svg+xml');
            response.end(SMALL_SVG);
            return;
          case '/oversized.svg':
            response.setHeader('Content-Type', 'image/svg+xml');
            response.setHeader('Content-Length', String(oversizedBytes));
            response.end(Buffer.alloc(oversizedBytes, ' '));
            return;
          case '/redirect.svg':
            response.statusCode = 302;
            response.setHeader('Location', '/target.svg');
            response.end();
            return;
          case '/data.json':
          case '/fetch.json':
            response.setHeader('Content-Type', 'application/json');
            response.end('{"fixture":true}');
            return;
          default:
            response.statusCode = 404;
            response.end();
        }
      });
      const cache = new ResourceCache({ limits });
      const factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, resourceCache: cache });
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      try {
        const bodyUrlsOf = await watchResponseBodies(page, `${server.origin}/fetch.json`);

        await page.goto(`${server.origin}/page.html`, { waitUntil: 'load' });
        await expect.poll(() => page.evaluate(() => (globalThis as { requestsDone?: boolean }).requestsDone === true)).toBe(true);
        await expect.poll(() => cache.stats().entryCount).toBe(2);
        // 本文を読まないことを確かめるため、事象が届くだけの時間を置く。
        await wait(200);

        // 本文を読んだのは、キャッシュに入る画像（リダイレクトの先を含む）だけ。
        expect([...bodyUrlsOf()].sort()).toEqual([`${server.origin}/small.svg`, `${server.origin}/target.svg`]);
        expect(cache.lookup(`${server.origin}/small.svg`)).toBeDefined();
        expect(cache.lookup(`${server.origin}/target.svg`)).toBeDefined();
        for (const pathname of ['/page.html', '/data.json', '/fetch.json', '/oversized.svg', '/redirect.svg']) {
          expect(cache.lookup(`${server.origin}${pathname}`), pathname).toBeUndefined();
        }
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      } finally {
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });

    it('does not store a response whose body cannot be read, without an unhandled rejection', async () => {
      const server = await startBodyServer((pathname, response) => {
        if (pathname === '/page.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<!doctype html><title>bodies</title><img src="/unreadable.svg" alt="unreadable"><img src="/small.svg" alt="small">');
          return;
        }
        if (pathname === '/unreadable.svg' || pathname === '/small.svg') {
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end(SMALL_SVG);
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      const { factory, cache } = cachedFactoryFor(server.origin);
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      try {
        const unreadableUrl = `${server.origin}/unreadable.svg`;
        const bodyUrlsOf = await watchResponseBodies(page, `${server.origin}/small.svg`, (url) => url === unreadableUrl);

        await page.goto(`${server.origin}/page.html`, { waitUntil: 'load' });
        await expect.poll(() => cache.lookup(`${server.origin}/small.svg`)).toBeDefined();
        await expect.poll(bodyUrlsOf).toContain(unreadableUrl);
        await wait(200);

        // 本文を取れなかった応答は入れない。例外は外に出さず、未処理の拒否にもしない。ほかの応答は今までどおり入る。
        expect(cache.lookup(unreadableUrl)).toBeUndefined();
        expect(cache.stats().entryCount).toBe(1);
        expect(unhandled).toEqual([]);
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await closePassiveResources({ factory, context, page });
        await server.close();
      }
    });
  });

  // DEF-039・DEF-040 の設計書 2.1.2: Interaction の Context の出口の中継。
  describe('egress proxy of the Interaction Context (DEF-039, DEF-040)', () => {
    /** 直前に作られた中継とその指定。 */
    const lastEgressProxy = (): { readonly proxy: EgressProxy; readonly options: EgressProxyOptions } => {
      const last = egressProxyControl.created.at(-1);
      if (last === undefined) {
        throw new Error('no egress proxy was created');
      }
      return last;
    };

    it('passes the proxy of a fresh egress proxy to the Interaction Context only, never to the Passive Context', async () => {
      const newContext = vi.spyOn(browser, 'newContext');
      const factory = factoryFor();

      const passive = await factory.createPassiveContext(viewport);
      contexts.push(passive);
      const session = await factory.createInteractionSession(viewport);
      contexts.push(session.page.context());
      try {
        const { proxy } = lastEgressProxy();
        expect(newContext).toHaveBeenCalledTimes(2);
        expect(newContext.mock.calls[0]?.[0]).not.toHaveProperty('proxy');
        expect(newContext.mock.calls[1]?.[0]).toMatchObject({ proxy: { server: proxy.server } });
        expect(proxy.server).toBe(`http://127.0.0.1:${proxy.port}`);
        expect(proxy.state).toBe('OPEN');
      } finally {
        await session.close();
      }
    });

    it('routes the traffic of the Interaction Context through the proxy and consults the injected upstream policy', async () => {
      const server = await startFixtureServer();
      const consulted: [string, number][] = [];
      try {
        const factory = factoryFor(configFor(server.origin), {
          egressUpstreamPolicy: (host, port) => {
            consulted.push([host, port]);
            return host === '127.0.0.1';
          },
        });
        const session = await factory.createInteractionSession(viewport);
        contexts.push(session.page.context());
        try {
          const response = await session.page.goto(`${server.origin}/`, { waitUntil: 'load' });

          expect(response?.status()).toBe(200);
          expect(consulted).toContainEqual(['127.0.0.1', Number(new URL(server.origin).port)]);
          expect(consulted.every(([host]) => host === '127.0.0.1')).toBe(true);
          expect(session.ledger.snapshot().blockedInteractionRequests).toEqual([]);
          expect(session.ledger.snapshot().invariantViolations).toEqual([]);
        } finally {
          await session.close();
        }
      } finally {
        await server.close();
      }
    });

    it('records an upstream denied by the policy as EGRESS_UPSTREAM_DENIED and the request does not reach the server', async () => {
      const server = await startFixtureServer();
      try {
        const factory = factoryFor(configFor(server.origin), { egressUpstreamPolicy: () => false });
        const session = await factory.createInteractionSession(viewport);
        contexts.push(session.page.context());
        try {
          const response = await session.page.goto(`${server.origin}/`, { waitUntil: 'load' }).catch(() => null);

          expect(response?.status() ?? null).not.toBe(200);
          expect(server.getCounters().get).toBe(0);
          expect(session.ledger.snapshot().blockedInteractionRequests).toContainEqual({
            method: 'GET',
            url: `${server.origin}/`,
            reason: 'EGRESS_UPSTREAM_DENIED',
          });
        } finally {
          await session.close();
        }
      } finally {
        await server.close();
      }
    });

    it('throws the egress proxy start failure as it is and creates no Context', async () => {
      const failure = new Error('egress proxy listen failed');
      egressProxyControl.failWith = failure;
      const newContext = vi.spyOn(browser, 'newContext');
      const factory = factoryFor();

      await expect(factory.createInteractionSession(viewport)).rejects.toBe(failure);

      expect(newContext).not.toHaveBeenCalled();
      expect(browser.contexts()).toEqual([]);
    });

    it('closes the proxy when the Context or the page cannot be created', async () => {
      const pageCreationFailure = new Error('fixture interaction page creation failure');
      const rawNewContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
        const context = await rawNewContext(options);
        contexts.push(context);
        vi.spyOn(context, 'newPage').mockRejectedValueOnce(pageCreationFailure);
        return context;
      });
      const factory = factoryFor();

      const failure: unknown = await factory.createInteractionSession(viewport).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ContextConstructionError);
      expect(lastEgressProxy().proxy.state).toBe('CLOSED');
    });

    it('freezes the proxy after the Guard freeze, and also when the Guard freeze fails', async () => {
      const server = await startFixtureServer();
      try {
        const factory = factoryFor(configFor(server.origin));
        const session = await factory.createInteractionSession(viewport);
        contexts.push(session.page.context());
        const { proxy } = lastEgressProxy();
        await session.page.goto(`${server.origin}/`, { waitUntil: 'load' });
        expect(proxy.state).toBe('OPEN');

        await session.activateInteractionFreeze();

        expect(proxy.state).toBe('FROZEN');
        await session.close();
        expect(proxy.state).toBe('CLOSED');

        // Guard の凍結の失敗（owner の page が 1 つでない）でも、中継は凍結する。
        const failing = await factory.createInteractionSession(viewport);
        contexts.push(failing.page.context());
        const { proxy: failingProxy } = lastEgressProxy();
        await failing.page.goto(`${server.origin}/`, { waitUntil: 'load' });
        await factory.createPassivePage(failing.page.context());
        await expect(failing.activateInteractionFreeze()).rejects.toThrow(/exactly one current owner page/u);
        expect(failingProxy.state).toBe('FROZEN');
        expect(failing.ledger.snapshot().invariantViolations.map((violation) => violation.code))
          .toContain('INTERACTION_FREEZE_ACTIVATION_FAILED');
        await expect.poll(() => failing.isClosed()).toBe(true);
        await failing.close().catch(() => undefined);
        expect(failingProxy.state).toBe('CLOSED');
      } finally {
        await server.close();
      }
    });

    it('closes the proxy after the Context close even when that close fails, and the retried close still works', async () => {
      const factory = factoryFor();
      const session = await factory.createInteractionSession(viewport);
      const context = session.page.context();
      contexts.push(context);
      const { proxy } = lastEgressProxy();
      const originalClose = context.close.bind(context);
      let attempts = 0;
      vi.spyOn(context, 'close').mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first retained close failed');
        await originalClose();
      });

      await expect(session.close()).rejects.toThrow('first retained close failed');

      expect(proxy.state).toBe('CLOSED');
      expect(session.isClosed()).toBe(false);
      // 閉じる処理の失敗の後の再試行は、invalidation を経て CLOSED に達する（設計書 4.1。上の「lifecycle priority」のテストと同じ）。
      await expect(session.close()).rejects.toThrow('Passive request guard context was invalidated');
      expect(session.isClosed()).toBe(true);
      expect(proxy.state).toBe('CLOSED');
      expect(attempts).toBe(2);
    });

    it('records EGRESS_PROXY_FAILED and closes the Context when the proxy reports a failure after listening (fail-closed)', async () => {
      const factory = factoryFor();
      const session = await factory.createInteractionSession(viewport);
      const context = session.page.context();
      contexts.push(context);
      const { options } = lastEgressProxy();

      options.onError(new Error('egress listener died'));

      expect(session.ledger.snapshot().invariantViolations).toContainEqual({
        code: 'EGRESS_PROXY_FAILED',
        message: 'egress listener died',
      });
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      expect(session.page.isClosed()).toBe(true);
      // session の close は、始まっている閉じる処理に合流する。
      await expect(session.close()).resolves.toBeUndefined();
      expect(session.isClosed()).toBe(true);
      expect(lastEgressProxy().proxy.state).toBe('CLOSED');
      expect(session.ledger.snapshot().invariantViolationCount).toBe(1);
    });
  });
});

/** DEF-044 の自己検査の違反のコード（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.2）。 */
const SHARED_WORKER_OBSERVED_CODE = 'SHARED_WORKER_OBSERVED';

const sharedWorkerViolationsOf = (ledger: SafetyLedger): readonly unknown[] => ledger.snapshot().invariantViolations
  .filter((violation) => violation.code === SHARED_WORKER_OBSERVED_CODE);

/**
 * DEF-044（設計書 1.2 の fail-closed の自己検査）: factory は、Browser の CDP の session で target を見張り、Shared Worker の target
 * （`type === 'shared_worker'`）を見たら、起動の引数が効いていないとみなし、所有するすべての Context の Ledger に違反
 * `SHARED_WORKER_OBSERVED` を記録して、その Context を閉じる。引数を外した Chromium（テストの明示の選択 `sharedWorkers: 'allow'`）で、
 * テストの既定の headless shell と CLI の Chromium の両方で確かめる。
 */
describe.each([
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium({ sharedWorkers: 'allow' }) },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium({ sharedWorkers: 'allow' }) },
])('DEF-044: the Shared Worker self-check of the factory, with $name launched without the Shared Worker disabling arguments', ({ launch }) => {
  let allowingBrowser: Browser;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    server = await startFixtureServer();
    allowingBrowser = await launch();
  });

  afterAll(async () => {
    await allowingBrowser?.close();
    await server?.close();
  });

  it('records SHARED_WORKER_OBSERVED in the Ledger of every owned Context and closes them, when a page creates a Shared Worker', async () => {
    const factory = new BrowserContextFactory(allowingBrowser, configFor(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    try {
      const context = await factory.createPassiveContext(viewport);
      const page = await factory.createPassivePage(context);
      const idle = await factory.createPassiveContext(viewport);
      const session = await factory.createInteractionSession(viewport);

      // Context が閉じると、読み込みは失敗しうる（閉じたことは下で確かめる）。
      await page.goto(`${server.origin}${sharedWorkerPostsPath('fetch')}`, { waitUntil: 'load' }).catch(() => undefined);

      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      await expect.poll(() => isPassiveRequestGuardClosed(idle)).toBe(true);
      await expect.poll(() => session.isClosed()).toBe(true);
      for (const ledger of [factory.getSafetyLedger(context), factory.getSafetyLedger(idle), session.ledger]) {
        expect(sharedWorkerViolationsOf(ledger)).toHaveLength(1);
      }
      expect(page.isClosed()).toBe(true);
      expect(session.page.isClosed()).toBe(true);
      // 持ち主の閉じる処理は、始まっている閉じる処理に合流する（失敗しない）。
      await expect(factory.closePassiveContext(context)).resolves.toBeUndefined();
      await expect(factory.closePassiveContext(idle)).resolves.toBeUndefined();
      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await factory.close();
    }
  });
});

describe('DEF-044: the Shared Worker self-check of the factory, with the Shared Worker disabling arguments (test default)', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('records nothing and keeps the Context open: the page cannot create a Shared Worker', async () => {
    const factory = factoryFor(configFor(server.origin));
    try {
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);

      await page.goto(`${server.origin}${sharedWorkerPostsPath('fetch')}`, { waitUntil: 'load' });
      await expect.poll(() => readSharedWorkerFixtureState(page)).toEqual(SHARED_WORKER_DISABLED_FIXTURE_STATE);
      await wait(QUIET_PERIOD_MS);

      expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      await closePassiveResources({ factory, context, page });
    } finally {
      await factory.close();
    }
  });
});

describe('DEF-044: the Browser CDP session of the factory', () => {
  it('throws the failure to open the Browser session as it is from the first Context creation, without creating a Context (no Run starts)', async () => {
    const failure = new Error('fixture browser session failure');
    const newContext = vi.fn();
    const failingBrowser = {
      newContext,
      newBrowserCDPSession: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as Browser;
    const factory = new BrowserContextFactory(failingBrowser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);

    await expect(factory.createPassiveContext(viewport)).rejects.toBe(failure);
    await expect(factory.createInteractionSession(viewport)).rejects.toBe(failure);
    expect(newContext).not.toHaveBeenCalled();
    expect(egressProxyControl.created.every(({ proxy }) => proxy.state === 'CLOSED')).toBe(true);
    await expect(factory.close()).resolves.toBeUndefined();
  });

  it('throws the failure of Target.setDiscoverTargets as it is, and detaches the session', async () => {
    const failure = new Error('fixture discover failure');
    const session = fakeBrowserCdpSession();
    vi.mocked(session.send).mockRejectedValue(failure);
    const newContext = vi.fn();
    const failingBrowser = { newContext, newBrowserCDPSession: vi.fn(async () => session) } as unknown as Browser;
    const factory = new BrowserContextFactory(failingBrowser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);

    await expect(factory.createPassiveContext(viewport)).rejects.toBe(failure);
    expect(newContext).not.toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it('watches the targets before any Context: listens to Target.targetCreated, then sends Target.setDiscoverTargets', async () => {
    const session = fakeBrowserCdpSession();
    const fakeBrowser = { newBrowserCDPSession: vi.fn(async () => session) } as unknown as Browser;
    const factory = new BrowserContextFactory(fakeBrowser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await factory.close();

    expect(session.on).toHaveBeenCalledWith('Target.targetCreated', expect.any(Function));
    expect(session.send).toHaveBeenCalledWith('Target.setDiscoverTargets', { discover: true });
    const listenedAt = vi.mocked(session.on).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const discoveredAt = vi.mocked(session.send).mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(listenedAt).toBeLessThan(discoveredAt);
  });

  it('close() detaches the Browser session, can be called again, does not throw a detach failure, and no Context is created after it', async () => {
    const session = fakeBrowserCdpSession();
    vi.mocked(session.detach).mockRejectedValueOnce(new Error('fixture detach failure'));
    const newContext = vi.fn();
    const fakeBrowser = { newContext, newBrowserCDPSession: vi.fn(async () => session) } as unknown as Browser;
    const factory = new BrowserContextFactory(fakeBrowser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);

    await expect(factory.close()).resolves.toBeUndefined();
    await expect(factory.close()).resolves.toBeUndefined();
    expect(session.detach).toHaveBeenCalled();
    await expect(factory.createPassiveContext(viewport)).rejects.toThrow(/closed/i);
    expect(newContext).not.toHaveBeenCalled();
  });
});

/** DEF-049 の自己検査の違反のコード（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5 と変更履歴の NP6 の Blocker の行）。 */
const SERVICE_WORKER_OBSERVED_CODE = 'SERVICE_WORKER_OBSERVED';

const serviceWorkerViolationsOf = (ledger: SafetyLedger): readonly unknown[] => ledger.snapshot().invariantViolations
  .filter((violation) => violation.code === SERVICE_WORKER_OBSERVED_CODE);

/**
 * DEF-049（fail-closed の自己検査）: factory は、Browser の CDP の session の auto-attach（`service_worker`）で Service Worker の target を
 * 見たら、Guard の初期化のスクリプト（登録の入口を塞ぐ主な防御）が効いていないとみなし、所有するすべての Context の Ledger に違反
 * `SERVICE_WORKER_OBSERVED` を記録して、その Context を直ちに閉じる。入口を塞ぐスクリプトだけを付けない Browser の Proxy（テストの明示の
 * 選択 `browserWithoutServiceWorkerRegistrationBlock`）で、テストの既定の headless shell と CLI の Chromium の両方で確かめる。
 * Playwright が Service Worker の target を再開させるので、止める保証はない（競争）。届いた要求の数は記録するが、条件にしない。
 */
describe.each([
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium() },
])('DEF-049: the Service Worker self-check of the factory, with $name and without the registration block script', ({ name, launch }) => {
  let realBrowser: Browser;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    server = await startFixtureServer();
    realBrowser = await launch();
  });

  afterAll(async () => {
    await realBrowser?.close();
    await server?.close();
  });

  it('records SERVICE_WORKER_OBSERVED in the Ledger of every owned Context and closes them, when a page registers a Service Worker', async () => {
    const unblocked = browserWithoutServiceWorkerRegistrationBlock(realBrowser);
    const factory = new BrowserContextFactory(unblocked, configFor(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const window = openServerWindow(server);
    try {
      const context = await factory.createPassiveContext(viewport);
      const page = await factory.createPassivePage(context);
      const idle = await factory.createPassiveContext(viewport);
      const session = await factory.createInteractionSession(viewport);

      // Context が閉じると、読み込みは失敗しうる（閉じたことは下で確かめる）。
      await page.goto(`${server.origin}${serviceWorkerBypassPath('prototype', 'top')}`, { waitUntil: 'load' }).catch(() => undefined);

      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      await expect.poll(() => isPassiveRequestGuardClosed(idle)).toBe(true);
      await expect.poll(() => session.isClosed()).toBe(true);
      for (const ledger of [factory.getSafetyLedger(context), factory.getSafetyLedger(idle), session.ledger]) {
        expect(serviceWorkerViolationsOf(ledger)).toHaveLength(1);
      }
      expect(page.isClosed()).toBe(true);
      expect(session.page.isClosed()).toBe(true);
      // 持ち主の閉じる処理は、始まっている閉じる処理に合流する（失敗しない）。
      await expect(factory.closePassiveContext(context)).resolves.toBeUndefined();
      await expect(factory.closePassiveContext(idle)).resolves.toBeUndefined();
      await expect(session.close()).resolves.toBeUndefined();
      await wait(QUIET_PERIOD_MS);
      // 届いた要求の数は記録する（条件にしない。設計書の変更履歴の NP6 の Blocker の行）。
      console.info(`DEF-049 self-check ${name}: ${JSON.stringify({
        workerScriptGets: window.count('GET', SERVICE_WORKER_BYPASS_WORKER_PATH),
        mutationPosts: window.count('POST', '/__mutation'),
      })}`);
    } finally {
      await factory.close();
    }
  });
});

describe('DEF-049: the Service Worker auto-attach of the Browser CDP session of the factory', () => {
  it('listens to Target.attachedToTarget, then sends Target.setAutoAttach for service_worker targets, waiting for the debugger and flattened', async () => {
    const session = fakeBrowserCdpSession();
    const fakeBrowser = { newBrowserCDPSession: vi.fn(async () => session) } as unknown as Browser;
    const factory = new BrowserContextFactory(fakeBrowser, configFor(), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await factory.close();

    expect(session.on).toHaveBeenCalledWith('Target.attachedToTarget', expect.any(Function));
    expect(session.send).toHaveBeenCalledWith('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'service_worker', exclude: false }],
    });
    const onCalls = vi.mocked(session.on).mock.calls;
    const listenedAt = vi.mocked(session.on).mock.invocationCallOrder[
      onCalls.findIndex(([event]) => String(event) === 'Target.attachedToTarget')
    ] ?? Number.POSITIVE_INFINITY;
    const sendCalls = vi.mocked(session.send).mock.calls;
    const attachedAt = vi.mocked(session.send).mock.invocationCallOrder[
      sendCalls.findIndex(([method]) => method === 'Target.setAutoAttach')
    ] ?? Number.NEGATIVE_INFINITY;
    expect(listenedAt).toBeLessThan(attachedAt);
    // 再開の命令は送らない（Service Worker の target を、こちらから動かさない）。
    expect(sendCalls.map(([method]) => method)).not.toContain('Runtime.runIfWaitingForDebugger');
  });
});
