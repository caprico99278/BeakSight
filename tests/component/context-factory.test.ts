import type { Browser, BrowserContext, Download } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory, ContextConstructionError } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { startFixtureServer } from '../../fixtures/server.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

const viewport: Viewport = { width: 800, height: 600 };
let browser: Browser;
const contexts: BrowserContext[] = [];

function configFor(origin = 'https://example.test'): AuditConfig {
  return createTestConfig(origin, '/', { browser: { locale: 'en-GB', timezone: 'Europe/London' } });
}

function factoryFor(config = configFor()): BrowserContextFactory {
  return new BrowserContextFactory(browser, config, () => new SafetyLedger());
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
      routeWebSocket: vi.fn(async () => {
        throw new Error('fixture route installation failure');
      }),
      close,
    } as unknown as BrowserContext;
    const failedBrowser = {
      newContext: vi.fn(async () => failedContext),
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
      const context = await factory.createPassiveContext(viewport);
      contexts.push(context);
      const page = await factory.createPassivePage(context);
      // 対照: 遮断しない Context では、同じページで登録でき、Worker のスクリプトが取得される（テストが空振りしないことの確認）。
      const unblockedContext = await browser.newContext({ viewport });
      contexts.push(unblockedContext);
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
});
