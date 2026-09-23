import type { Browser, BrowserContext, CDPSession, Download, Page, Request, Route, WebSocketRoute } from 'playwright';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import {
  awaitPassiveRequestGuardReady,
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
} from '../../src/safety/passive-request-guard.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const servers: FixtureServer[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => {
    try {
      await closePassiveGuardedContext(context);
    } catch {
      await context.close();
    }
  }));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await browser.close();
});

async function startServer(options?: Parameters<typeof startFixtureServer>[0]): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  servers.push(server);
  return server;
}

async function createGuardedContext(
  ledger: SafetyLedger,
  allowedOrigins: ReadonlySet<string>,
): Promise<BrowserContext> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.push(context);
  await installPassiveRequestGuard(context, ledger, allowedOrigins);
  return context;
}

async function createGuardedPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await awaitPassiveRequestGuardReady(page);
  return page;
}

interface GuardHarness {
  readonly context: BrowserContext;
  readonly calls: string[];
  readonly cdpCommands: string[];
  readonly cdpCommandLog: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  readonly removedListeners: readonly string[];
  readonly closeCount: number;
  readonly httpHandler: ((route: Route) => Promise<unknown> | unknown) | undefined;
  readonly webSocketHandler: ((route: WebSocketRoute) => Promise<unknown> | unknown) | undefined;
  readonly requestFailedHandler: ((request: Request) => Promise<unknown> | unknown) | undefined;
  readonly pageHandler: ((page: Page) => void) | undefined;
  readonly cdpRequestPausedHandler: ((event: FakeCdpPausedEvent) => void) | undefined;
  readonly cdpCloseHandler: (() => void) | undefined;
  registerPage(page: Page): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHostileGuardError(): object {
  return new Proxy(Object.create(null) as object, {
    get(_target, property): never {
      if (property === 'message' || property === 'name' || property === Symbol.toPrimitive) {
        throw new Error('hostile error property access');
      }
      throw new Error('unexpected hostile error property access');
    },
    getPrototypeOf(): never {
      throw new Error('hostile error prototype access');
    },
  });
}

interface FakeCdpPausedEvent {
  readonly requestId: string;
  readonly redirectedRequestId?: string;
  readonly frameId: string;
  readonly request: { readonly method: string; readonly url: string };
}

function createGuardHarness(options: {
  readonly hasPage?: boolean;
  readonly webSocketInstallError?: Error;
  readonly httpInstallError?: Error;
  readonly httpInstallGate?: Promise<void>;
  readonly newCdpSessionError?: Error;
  readonly cdpOnErrorEvent?: string;
  readonly cdpSendErrorMethod?: string;
  readonly cdpSendGate?: { readonly method: string; readonly promise: Promise<void> };
  readonly contextCloseError?: Error;
  readonly contextCloseRejection?: { readonly value: unknown };
  readonly contextCloseAttempts?: readonly (
    | { readonly outcome: 'RESOLVE' }
    | { readonly outcome: 'REJECT'; readonly error: unknown }
  )[];
  readonly contextCloseGate?: Promise<void>;
  readonly onContextClose?: () => void;
} = {}): GuardHarness {
  const calls: string[] = [];
  const cdpCommands: string[] = [];
  const cdpCommandLog: Array<{ readonly method: string; readonly params: unknown }> = [];
  const removedListeners: string[] = [];
  let closeCount = 0;
  let httpHandler: GuardHarness['httpHandler'];
  let webSocketHandler: GuardHarness['webSocketHandler'];
  let requestFailedHandler: GuardHarness['requestFailedHandler'];
  let pageHandler: GuardHarness['pageHandler'];
  let cdpRequestPausedHandler: GuardHarness['cdpRequestPausedHandler'];
  let cdpCloseHandler: GuardHarness['cdpCloseHandler'];
  const registeredPages: Page[] = [];
  const rawContext = {
    pages(): object[] {
      return options.hasPage === true ? [{}] : registeredPages;
    },
    on(event: string, handler: (value: unknown) => void): void {
      calls.push(`ON:${event}`);
      if (event === 'requestfailed') {
        requestFailedHandler = handler as GuardHarness['requestFailedHandler'];
      } else if (event === 'page') {
        pageHandler = handler as (page: Page) => void;
      }
    },
    off(event: string, handler: (value: unknown) => void): void {
      removedListeners.push(`CONTEXT:${event}`);
      if (event === 'page' && pageHandler === handler) pageHandler = undefined;
      if (event === 'requestfailed' && requestFailedHandler === handler) requestFailedHandler = undefined;
    },
    async newCDPSession(): Promise<CDPSession> {
      calls.push('CDP');
      if (options.newCdpSessionError !== undefined) {
        throw options.newCdpSessionError;
      }
      const session = {
        on(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          if (event === options.cdpOnErrorEvent) {
            throw new Error(`${event} listener setup failed`);
          }
          if (event === 'Fetch.requestPaused') {
            cdpRequestPausedHandler = handler as (event: FakeCdpPausedEvent) => void;
          } else if (event === 'close') {
            cdpCloseHandler = handler;
          }
        },
        off(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          removedListeners.push(`CDP:${event}`);
          if (event === 'Fetch.requestPaused' && cdpRequestPausedHandler === handler) {
            cdpRequestPausedHandler = undefined;
          }
          if (event === 'close' && cdpCloseHandler === handler) cdpCloseHandler = undefined;
        },
        async send(method: string, params?: unknown): Promise<unknown> {
          cdpCommands.push(method);
          cdpCommandLog.push({ method, params });
          if (method === options.cdpSendErrorMethod) {
            throw new Error(`${method} failed`);
          }
          if (method === options.cdpSendGate?.method) {
            await options.cdpSendGate.promise;
          }
          if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: 'root-frame' } } };
          }
          return undefined;
        },
      };
      return session as unknown as CDPSession;
    },
    async routeWebSocket(
      _pattern: unknown,
      handler: (route: WebSocketRoute) => Promise<unknown> | unknown,
    ): Promise<void> {
      calls.push('WEBSOCKET');
      if (options.webSocketInstallError !== undefined) {
        throw options.webSocketInstallError;
      }
      webSocketHandler = handler;
    },
    async route(_pattern: unknown, handler: (route: Route) => Promise<unknown> | unknown): Promise<void> {
      calls.push('HTTP');
      if (options.httpInstallError !== undefined) {
        throw options.httpInstallError;
      }
      httpHandler = handler;
      await options.httpInstallGate;
    },
    async close(): Promise<void> {
      calls.push('CLOSE');
      const attemptIndex = closeCount;
      closeCount += 1;
      options.onContextClose?.();
      const attempt = options.contextCloseAttempts?.[attemptIndex];
      if (attempt?.outcome === 'REJECT') return Promise.reject(attempt.error);
      await options.contextCloseGate;
      if (attempt?.outcome === 'RESOLVE') return;
      if (options.contextCloseRejection !== undefined) {
        return Promise.reject(options.contextCloseRejection.value);
      }
      if (options.contextCloseError !== undefined) {
        throw options.contextCloseError;
      }
    },
  };
  return {
    context: rawContext as unknown as BrowserContext,
    calls,
    cdpCommands,
    cdpCommandLog,
    removedListeners,
    get closeCount(): number {
      return closeCount;
    },
    get httpHandler(): GuardHarness['httpHandler'] {
      return httpHandler;
    },
    get webSocketHandler(): GuardHarness['webSocketHandler'] {
      return webSocketHandler;
    },
    get requestFailedHandler(): GuardHarness['requestFailedHandler'] {
      return requestFailedHandler;
    },
    get pageHandler(): GuardHarness['pageHandler'] {
      return pageHandler;
    },
    get cdpRequestPausedHandler(): GuardHarness['cdpRequestPausedHandler'] {
      return cdpRequestPausedHandler;
    },
    get cdpCloseHandler(): GuardHarness['cdpCloseHandler'] {
      return cdpCloseHandler;
    },
    registerPage(page: Page): void {
      registeredPages.push(page);
    },
  };
}

function createHarnessPage(harness: GuardHarness, options: {
  readonly closeError?: Error;
  readonly closeGate?: Promise<void>;
  readonly url?: string;
  readonly onEvent?: (event: string, handler: (...arguments_: unknown[]) => void) => void;
  readonly onOffEvent?: (event: string, handler: (...arguments_: unknown[]) => void) => void;
} = {}): Page {
  let closed = false;
  const closeHandlers = new Set<() => void>();
  const page = {
    context: () => harness.context,
    isClosed: () => closed,
    url: () => options.url ?? 'about:blank',
    on(event: string, handler: (...arguments_: unknown[]) => void): Page {
      options.onEvent?.(event, handler);
      return page as unknown as Page;
    },
    once(event: string, handler: () => void): Page {
      if (event === 'close') {
        closeHandlers.add(handler);
      }
      return page as unknown as Page;
    },
    off(event: string, handler: (...arguments_: unknown[]) => void): Page {
      options.onOffEvent?.(event, handler);
      if (event === 'close') {
        closeHandlers.delete(handler as () => void);
      }
      return page as unknown as Page;
    },
    async close(): Promise<void> {
      await options.closeGate;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
      closed = true;
      for (const handler of closeHandlers) {
        handler();
      }
      closeHandlers.clear();
    },
  } as unknown as Page;
  harness.registerPage(page);
  harness.pageHandler?.(page);
  return page;
}

async function readyHarnessPage(harness: GuardHarness): Promise<Page> {
  const page = createHarnessPage(harness);
  await awaitPassiveRequestGuardReady(page);
  return page;
}

function emitFailedMainFrameRequest(
  harness: GuardHarness,
  page: Page,
  facts: { readonly method: string; readonly url: string; readonly errorText: string },
): void {
  const frame = { parentFrame: () => null, page: () => page };
  harness.requestFailedHandler?.({
    method: () => facts.method,
    url: () => facts.url,
    isNavigationRequest: () => true,
    frame: () => frame,
    failure: () => ({ errorText: facts.errorText }),
  } as unknown as Request);
}

async function flushGuardProtocolCallbacks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarnessRoute(
  page: Page,
  facts: {
    readonly method: string;
    readonly url: string;
    readonly navigation: boolean;
    readonly abortError?: unknown;
    readonly abortRejection?: { readonly value: unknown };
  },
): { readonly route: Route; readonly abortCalls: () => number } {
  let abortCalls = 0;
  const frame = { parentFrame: () => null, page: () => page };
  const request = {
    method: () => facts.method,
    url: () => facts.url,
    isNavigationRequest: () => facts.navigation,
    frame: () => frame,
  } as unknown as Request;
  return {
    route: {
      request: () => request,
      abort: async () => {
        abortCalls += 1;
        if (facts.abortRejection !== undefined) {
          return Promise.reject(facts.abortRejection.value);
        }
        if (facts.abortError !== undefined) throw facts.abortError;
      },
      fallback: async () => undefined,
    } as unknown as Route,
    abortCalls: () => abortCalls,
  };
}

describe('Playwright native routing assumptions', () => {
  it('proves fallback does not re-intercept a redirect follow-up', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const blockedRedirects: string[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        request.url().startsWith(external.origin)
        && request.isNavigationRequest()
        && request.frame().parentFrame() === null
      ) {
        blockedRedirects.push(request.url());
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    });

    const redirectPage = await context.newPage();
    const outcome = await redirectPage.goto(`${primary.origin}/__external-redirect`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);
    expect({ outcome, blockedRedirects, externalGet: external.getCounters().get }).toEqual({
      outcome: 'RESOLVED',
      blockedRedirects: [],
      externalGet: 1,
    });
  });

  it('proves fallback preserves credentials omission for an ordinary request', async () => {
    const external = await startServer();
    const primary = await startServer();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    await context.addCookies([{
      name: 'fixture-session',
      value: 'must-not-be-sent',
      url: external.origin,
    }]);
    await context.route('**/*', async (route) => route.fallback());

    const subresourcePage = await context.newPage();
    await subresourcePage.goto(`${primary.origin}/index.html`);
    external.resetCounters();
    external.resetRequestObservations();
    await subresourcePage.evaluate(async (url) => {
      await fetch(url, { credentials: 'omit', mode: 'no-cors' });
    }, `${external.origin}/index.html`);

    expect(external.getCounters().get).toBe(1);
    expect(external.getRequestObservations()).toEqual([{
      method: 'GET',
      pathname: '/index.html',
      cookie: null,
    }]);
  });

  it('proves fulfilled main-frame redirects bypass follow-up interception', async () => {
    const external = await startServer();
    const middle = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const primary = await startServer({ externalRedirectUrl: `${middle.origin}/__external-redirect` });
    const allowedOrigins = new Set([primary.origin, middle.origin]);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const intercepted: string[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const isMainFrame = request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (!isMainFrame) {
        await route.fallback();
        return;
      }
      intercepted.push(request.url());
      if (!allowedOrigins.has(new URL(request.url()).origin)) {
        await route.abort('blockedbyclient');
        return;
      }
      const response = await route.fetch({
        headers: await request.allHeaders(),
        maxRedirects: 0,
      });
      try {
        await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    });

    const page = await context.newPage();
    const outcome = await page.goto(`${primary.origin}/__external-redirect`)
      .then((response) => ({ kind: 'RESOLVED' as const, status: response?.status(), url: page.url() }))
      .catch((error: unknown) => ({
        kind: 'REJECTED' as const,
        message: error instanceof Error ? error.message : String(error),
        url: page.url(),
      }));

    expect({
      outcome,
      intercepted,
      primaryGet: primary.getCounters().get,
      middleGet: middle.getCounters().get,
      externalGet: external.getCounters().get,
    }).toEqual({
      outcome: { kind: 'RESOLVED', status: 200, url: `${external.origin}/external-link.html` },
      intercepted: [`${primary.origin}/__external-redirect`],
      primaryGet: 1,
      middleGet: 1,
      externalGet: 1,
    });
  });

  it('CDP Request-stage interception sees every document hop while native subresources retain semantics', async () => {
    const external = await startServer();
    const middle = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const primary = await startServer({ externalRedirectUrl: `${middle.origin}/__external-redirect` });
    const allowedOrigins = new Set([primary.origin, middle.origin]);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const setupByPage = new WeakMap<Page, Promise<void>>();
    const observedDocuments: string[] = [];
    const diagnosticErrors: string[] = [];

    const setupCdpGuard = (page: Page): Promise<void> => {
      const existing = setupByPage.get(page);
      if (existing !== undefined) {
        return existing;
      }
      const setup = (async () => {
        const session = await context.newCDPSession(page);
        const frameTree = await session.send('Page.getFrameTree');
        const rootFrameId = frameTree.frameTree.frame.id;
        session.on('Fetch.requestPaused', (event) => {
          void (async () => {
            try {
              observedDocuments.push(event.request.url);
              const isRootFrame = event.frameId === rootFrameId;
              const isRead = event.request.method === 'GET' || event.request.method === 'HEAD';
              const isAllowedRoot = allowedOrigins.has(new URL(event.request.url).origin);
              if (!isRead || (isRootFrame && !isAllowedRoot)) {
                await session.send('Fetch.failRequest', {
                  requestId: event.requestId,
                  errorReason: 'BlockedByClient',
                });
                return;
              }
              await session.send('Fetch.continueRequest', { requestId: event.requestId });
            } catch (error) {
              diagnosticErrors.push(error instanceof Error ? error.message : String(error));
            }
          })();
        });
        await session.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        });
      })();
      setupByPage.set(page, setup);
      return setup;
    };

    context.on('page', (page) => {
      void setupCdpGuard(page).catch((error: unknown) => {
        diagnosticErrors.push(error instanceof Error ? error.message : String(error));
      });
    });

    await context.route('**/*', async (route) => {
      const setup = setupByPage.get(route.request().frame().page());
      if (setup === undefined) {
        throw new Error('CDP setup did not start before the first routed request');
      }
      await setup;
      await route.fallback();
    });

    const redirectPage = await context.newPage();
    await setupCdpGuard(redirectPage);
    await expect(redirectPage.goto(`${primary.origin}/__external-redirect`)).rejects.toThrow();
    expect(observedDocuments).toEqual([
      `${primary.origin}/__external-redirect`,
      `${middle.origin}/__external-redirect`,
      `${external.origin}/external-link.html`,
    ]);
    expect(primary.getCounters().get).toBe(1);
    expect(middle.getCounters().get).toBe(1);
    expect(external.getCounters().get).toBe(0);

    const nativePage = await context.newPage();
    await setupCdpGuard(nativePage);
    await context.addCookies([{
      name: 'fixture-session',
      value: 'must-not-be-sent',
      url: external.origin,
    }]);
    await nativePage.setContent('<!doctype html><title>Native semantics</title>');
    external.resetCounters();
    external.resetRequestObservations();
    const framePromise = nativePage.waitForEvent(
      'framenavigated',
      (frame) => frame.url() === `${external.origin}/index.html`,
    );
    const rendered = await nativePage.evaluate(async (externalOrigin) => {
      const script = document.createElement('script');
      const scriptLoaded = new Promise<void>((resolve, reject) => {
        script.addEventListener('load', () => resolve(), { once: true });
        script.addEventListener('error', () => reject(new Error('script failed')), { once: true });
      });
      script.src = `${externalOrigin}/external-script.js`;
      document.head.append(script);
      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error('image failed')), { once: true });
      });
      image.src = `${externalOrigin}/external-image.svg`;
      document.body.append(image);
      const frame = document.createElement('iframe');
      frame.src = `${externalOrigin}/index.html`;
      document.body.append(frame);
      await Promise.all([
        scriptLoaded,
        imageLoaded,
        fetch(`${externalOrigin}/__counters`, { credentials: 'omit', mode: 'no-cors' }),
      ]);
      return {
        scriptLoaded: (globalThis as typeof globalThis & { fixtureExternalScriptLoaded?: boolean })
          .fixtureExternalScriptLoaded,
        imageWidth: image.naturalWidth,
      };
    }, external.origin);
    const nestedFrame = await framePromise;

    expect(rendered).toEqual({ scriptLoaded: true, imageWidth: 1 });
    expect(await nestedFrame.locator('h1').textContent()).toBe('Fixture Home');
    expect(external.getCounters().get).toBe(4);
    expect(external.getRequestObservations().find(
      (observation) => observation.pathname === '/__counters',
    )?.cookie).toBeNull();
    expect(diagnosticErrors).toEqual([]);
  });
});

describe('installPassiveRequestGuard installation', () => {
  it('records frozen HTTP activity before a failed abort invalidates the context', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);
    const route = {
      request: () => ({
        method: () => 'GET',
        url: () => 'https://example.test/failed-frozen-abort',
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null, page: () => page }),
      } as unknown as Request),
      abort: async (): Promise<never> => { throw new Error('frozen abort failed'); },
    } as unknown as Route;

    await expect(harness.httpHandler?.(route)).rejects.toThrow('frozen abort failed');

    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_HTTP_ABORT_FAILED',
      message: 'frozen abort failed',
    }]));
    await expect.poll(() => harness.closeCount).toBe(1);
  });

  it('records frozen CDP activity before a failed Fetch.failRequest invalidates the context', async () => {
    const harness = createGuardHarness({ cdpSendErrorMethod: 'Fetch.failRequest' });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.({
      requestId: 'failed-frozen-cdp',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/failed-frozen-cdp' },
    });
    await expect.poll(() => harness.closeCount).toBe(1);

    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_CDP_FAIL_REQUEST_FAILED',
      message: 'Fetch.failRequest failed',
    }]));
  });

  it('does not reactivate after installation activity invalidates its owner context', async () => {
    const installGate = createDeferred<void>();
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({
      httpInstallGate: installGate.promise,
      contextCloseGate: closeGate.promise,
    });
    const ledger = new SafetyLedger();
    const installing = installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    let installationSettled = false;
    const installationOutcome = installing.then(
      () => ({ status: 'FULFILLED' as const }),
      (error: unknown) => ({ status: 'REJECTED' as const, error }),
    ).finally(() => {
      installationSettled = true;
    });
    await expect.poll(() => harness.httpHandler).toBeTypeOf('function');

    createHarnessPage(harness, { url: 'https://example.test/late-install-page' });
    await expect.poll(() => harness.closeCount).toBe(1);
    installGate.resolve(undefined);
    await Promise.resolve();
    expect(installationSettled).toBe(false);
    closeGate.resolve(undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('invalidated installation did not settle')), 500);
    });
    await expect(Promise.race([installationOutcome, deadline])).resolves.toMatchObject({
      status: 'REJECTED',
      error: { message: expect.stringMatching(/invalidated/i) },
    });

    expect(harness.closeCount).toBe(1);
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'GUARD_PAGE_PHASE_INVALID',
      message: 'Page observed during INSTALLING',
    }]));
  });

  it('keeps frozen invalidation enforcement active until its owned task drains, then remains terminal', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const cancelGate = createDeferred<void>();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    handlers.get('download')?.({
      url: () => 'data:text/plain,pending', suggestedFilename: () => 'pending.txt', cancel: () => cancelGate.promise,
    } as unknown as Download);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/invalidation',
      errorText: 'net::ERR_CONNECTION_RESET',
    });
    await expect.poll(() => harness.closeCount).toBe(1);

    const duringDrain = createHarnessRoute(page, {
      method: 'GET', url: 'https://example.test/during-invalidation', navigation: true,
    });
    await harness.httpHandler?.(duringDrain.route);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);

    cancelGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const afterDrain = createHarnessRoute(page, {
      method: 'GET', url: 'https://example.test/after-invalidation', navigation: true,
    });
    await harness.httpHandler?.(afterDrain.route);

    // CLOSEDは非同期のプロトコル作業を一切受け付けない。ルートは一時停止のままであり、
    // この締め切りより後のabortを許すと証跡の公開が遅すぎることになりかねない。
    expect(afterDrain.abortCalls()).toBe(0);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
  });

  it('retains late evidence after failed close until an explicit retry drains it', async () => {
    const harness = createGuardHarness({
      contextCloseAttempts: [
        { outcome: 'REJECT', error: new Error('invalidation close failed') },
        { outcome: 'RESOLVE' },
      ],
    });
    const ledger = new SafetyLedger();
    const cancelGate = createDeferred<void>();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      closeError: new Error('page close failed'),
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    handlers.get('download')?.({
      url: () => 'data:text/plain,late-evidence',
      suggestedFilename: () => 'late-evidence.txt',
      cancel: () => cancelGate.promise,
    } as unknown as Download);

    let closeSettled = false;
    let closeError: unknown;
    const closing = closePassiveGuardedPage(page).catch((error: unknown) => {
      closeError = error;
    }).finally(() => {
      closeSettled = true;
    });
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'GUARD_CONTEXT_INVALIDATION_FAILED',
      message: 'invalidation close failed',
    }]));
    await expect.poll(() => closeSettled).toBe(true);
    await closing;
    expect(closeError).toMatchObject({ message: 'page close failed' });
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    expect(harness.removedListeners).toEqual([]);
    const routed = createHarnessRoute(page, {
      method: 'GET', url: 'https://example.test/after-failed-invalidation-drain', navigation: true,
    });
    await harness.httpHandler?.(routed.route);

    expect(harness.closeCount).toBe(1);
    expect(routed.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
    let retrySettled = false;
    const retry = closePassiveGuardedContext(harness.context).catch((error: unknown) => {
      retrySettled = true;
      return error;
    });
    await expect.poll(() => harness.closeCount).toBe(2);
    expect(retrySettled).toBe(false);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    cancelGate.reject(new Error('late cancel failed'));
    expect(await retry).toMatchObject({ message: 'Passive request guard context was invalidated' });
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(harness.closeCount).toBe(2);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
      message: 'late cancel failed',
    }]));
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
  });

  it('does not complete page-close-triggered invalidation before its owned download task drains', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const cancelGate = createDeferred<void>();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      closeError: new Error('page close failed'),
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    handlers.get('download')?.({
      url: () => 'data:text/plain,pending-close', suggestedFilename: () => 'pending-close.txt', cancel: () => cancelGate.promise,
    } as unknown as Download);

    let settled = false;
    let closeError: unknown;
    const closing = closePassiveGuardedPage(page).catch((error: unknown) => {
      closeError = error;
    }).finally(() => {
      settled = true;
    });
    await expect.poll(() => harness.closeCount).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    cancelGate.resolve(undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('invalidation completion did not drain')), 500);
    });
    await Promise.race([closing, deadline]);
    expect(closeError).toMatchObject({ message: 'page close failed' });
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
  });

  it('shares one failed safety-invalidation owner and preserves frozen enforcement', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({
      contextCloseError: new Error('invalidation close failed'),
      contextCloseGate: closeGate.promise,
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);
    const failure = {
      method: () => 'GET',
      url: () => 'https://example.test/failed-owner',
      isNavigationRequest: () => true,
      frame: () => ({ parentFrame: () => null, page: () => page }),
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(failure);
    harness.requestFailedHandler?.(failure);
    await expect.poll(() => harness.closeCount).toBe(1);
    closeGate.resolve(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const routed = createHarnessRoute(page, {
      method: 'GET', url: 'https://example.test/after-failed-invalidation', navigation: true,
    });
    await harness.httpHandler?.(routed.route);

    expect(routed.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'GUARD_CONTEXT_INVALIDATION_FAILED',
      message: 'invalidation close failed',
    }]));
  });

  it('publishes a re-entrant invalidation waiter before the first context close side effect', async () => {
    const closeGate = createDeferred<void>();
    const cancelGate = createDeferred<void>();
    let harness!: GuardHarness;
    let listenerReturn: unknown;
    harness = createGuardHarness({
      contextCloseGate: closeGate.promise,
      onContextClose: () => {
        const page = activePage;
        const handler = harness.requestFailedHandler;
        if (page === undefined || handler === undefined) {
          throw new Error('re-entrant requestfailed handler was unavailable');
        }
        const request = {
          method: () => 'GET',
          url: () => 'https://example.test/reentrant-requestfailed',
          isNavigationRequest: () => true,
          frame: () => ({ parentFrame: () => null, page: () => page }),
          failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
        } as unknown as Request;
        listenerReturn = handler(request);
      },
    });
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    let activePage: Page | undefined;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      closeError: new Error('page close failed'),
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    activePage = page;
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    handlers.get('download')?.({
      url: () => 'data:text/plain,reentrant', suggestedFilename: () => 'reentrant.txt', cancel: () => cancelGate.promise,
    } as unknown as Download);

    let closeError: unknown;
    const closing = closePassiveGuardedPage(page).catch((error: unknown) => {
      closeError = error;
    });
    await expect.poll(() => harness.closeCount).toBe(1);
    expect(listenerReturn).toBeUndefined();

    closeGate.resolve(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    cancelGate.resolve(undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('re-entrant invalidation waiter deadlocked')), 500);
    });
    await Promise.race([closing, deadline]);

    expect(harness.closeCount).toBe(1);
    expect(closeError).toMatchObject({ message: 'page close failed' });
  });

  it('records a frozen HTTP navigation observed while owner context close is pending', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);

    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);
    const routed = createHarnessRoute(page, {
      method: 'GET',
      url: 'https://example.test/late-navigation',
      navigation: true,
    });
    await harness.httpHandler?.(routed.route);
    closeGate.resolve(undefined);
    await closing;

    expect(routed.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
  });

  it('records a frozen CDP Document observed while owner context close is pending', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);

    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);
    harness.cdpRequestPausedHandler?.({
      requestId: 'late-document',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/late-document' },
    });
    await expect.poll(() => harness.cdpCommands.filter((value) => value === 'Fetch.failRequest').length).toBe(1);
    closeGate.resolve(undefined);
    await closing;

    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
  });

  it('does not invent an interaction event during passive owner context close', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const routed = createHarnessRoute(page, {
      method: 'GET',
      url: 'https://example.test/passive-close',
      navigation: true,
    });

    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);
    await harness.httpHandler?.(routed.route);
    closeGate.resolve(undefined);
    await closing;

    expect(routed.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
    expect(ledger.snapshot().blockedInteractionNavigations).toEqual([]);
  });

  it('records popup download frame and WebSocket activity while frozen owner close is pending', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    handlers.get('download')?.({
      url: () => 'data:text/plain,late', suggestedFilename: () => 'late.txt', cancel: async () => undefined,
    } as unknown as Download);
    handlers.get('popup')?.({
      url: () => 'https://example.test/late-popup', close: async () => undefined,
    } as unknown as Page);
    handlers.get('framenavigated')?.({ url: () => 'https://example.test/late-frame' });
    await harness.webSocketHandler?.({
      url: () => 'wss://example.test/late', close: async () => undefined,
    } as unknown as WebSocketRoute);
    closeGate.resolve(undefined);
    await closing;

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedDownloads).toHaveLength(1);
    expect(snapshot.blockedPopups).toHaveLength(1);
    expect(snapshot.blockedInteractionNavigations).toHaveLength(1);
    expect(snapshot.blockedInteractionWebSockets).toHaveLength(1);
  });

  it('installs WebSocket and HTTP interception before resolving', async () => {
    const harness = createGuardHarness();

    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));

    expect(harness.calls).toEqual(['ON:page', 'ON:requestfailed', 'WEBSOCKET', 'HTTP']);
    expect(harness.closeCount).toBe(0);
  });

  it('detaches every owned listener exactly once before successful Context close returns', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent: (event) => pageRemoved.push(event),
    });
    await awaitPassiveRequestGuardReady(page);
    await closePassiveGuardedContext(harness.context);
    const snapshotAtClose = ledger.snapshot();

    expect(harness.removedListeners).toEqual(expect.arrayContaining([
      'CONTEXT:page',
      'CONTEXT:requestfailed',
      'CDP:Fetch.requestPaused',
      'CDP:close',
    ]));
    expect(pageRemoved).toEqual(expect.arrayContaining(['download', 'popup', 'framenavigated']));
    expect(new Set(harness.removedListeners).size).toBe(harness.removedListeners.length);
    expect(new Set(pageRemoved).size).toBe(pageRemoved.length);
    expect(harness.pageHandler).toBeUndefined();
    expect(harness.requestFailedHandler).toBeUndefined();
    expect(harness.cdpRequestPausedHandler).toBeUndefined();
    expect(harness.cdpCloseHandler).toBeUndefined();
    await Promise.resolve();
    expect(ledger.snapshot()).toEqual(snapshotAtClose);
  });

  it('continues after one listener inverse fails and never retries cleanup on owner re-entry', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    let downloadRemovalAttempts = 0;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent: (event) => {
        pageRemoved.push(event);
        if (event === 'download') {
          downloadRemovalAttempts += 1;
          throw new Error('download listener cleanup failed');
        }
      },
    });
    await awaitPassiveRequestGuardReady(page);

    await closePassiveGuardedContext(harness.context);
    const removalsAtClose = [...harness.removedListeners, ...pageRemoved];
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);

    expect(downloadRemovalAttempts).toBe(1);
    expect(pageRemoved).toEqual(['download', 'popup', 'framenavigated']);
    expect(harness.removedListeners).toEqual(expect.arrayContaining([
      'CONTEXT:page',
      'CONTEXT:requestfailed',
      'CDP:Fetch.requestPaused',
      'CDP:close',
    ]));
    expect([...harness.removedListeners, ...pageRemoved]).toEqual(removalsAtClose);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARD_LISTENER_CLEANUP_FAILED',
      message: 'download listener cleanup failed',
    }]);
  });

  it('releases each terminal page and CDP cleanup group during sequential page churn', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

    for (let index = 0; index < 70; index += 1) {
      const page = createHarnessPage(harness, {
        url: `https://example.test/churn-${index}`,
        onOffEvent: (event) => pageRemoved.push(`${index}:${event}`),
      });
      await awaitPassiveRequestGuardReady(page);
      await closePassiveGuardedPage(page);
    }

    const removalsBeforeContextClose = harness.removedListeners.length;
    const pageRemovalsBeforeContextClose = pageRemoved.length;
    await closePassiveGuardedContext(harness.context);

    expect(harness.removedListeners.slice(removalsBeforeContextClose)).toEqual([
      'CONTEXT:page',
      'CONTEXT:requestfailed',
    ]);
    expect(pageRemoved).toHaveLength(pageRemovalsBeforeContextClose);
    expect(pageRemoved).toHaveLength(70 * 3);
    expect(ledger.snapshot().invariantViolations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GUARD_LISTENER_GROUP_LIMIT_REACHED' }),
    ]));
  });

  it('fails closed once instead of admitting an unowned page listener set at the group cap', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

    for (let index = 0; index < 64; index += 1) {
      await awaitPassiveRequestGuardReady(createHarnessPage(harness, {
        url: `https://example.test/live-${index}`,
      }));
    }
    createHarnessPage(harness, { url: 'https://example.test/overflow-0' });
    createHarnessPage(harness, { url: 'https://example.test/overflow-1' });
    await expect.poll(() => harness.closeCount).toBe(1);

    expect(harness.calls.filter((call) => call === 'CDP')).toHaveLength(64);
    expect(ledger.snapshot().invariantViolations.filter(
      ({ code }) => code === 'GUARD_LISTENER_GROUP_LIMIT_REACHED',
    )).toEqual([{
      code: 'GUARD_LISTENER_GROUP_LIMIT_REACHED',
      message: 'Guard page/CDP listener cleanup group limit reached',
    }]);
  });

  it('releases partially installed page and CDP listeners when listener setup fails', async () => {
    const harness = createGuardHarness({
      cdpOnErrorEvent: 'Fetch.requestPaused',
      contextCloseError: new Error('partial setup invalidation close failed'),
    });
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent: (event) => pageRemoved.push(event),
    });

    await expect(awaitPassiveRequestGuardReady(page)).rejects.toThrow(
      'Fetch.requestPaused listener setup failed',
    );
    await expect.poll(() => harness.closeCount).toBe(1);

    expect(pageRemoved).toEqual(['download', 'popup', 'framenavigated']);
    expect(harness.removedListeners).toEqual(expect.arrayContaining([
      'CDP:close',
    ]));
    expect(harness.removedListeners).not.toContain('CONTEXT:page');
    expect(harness.removedListeners).not.toContain('CONTEXT:requestfailed');
    expect(harness.removedListeners).not.toContain('CDP:Fetch.requestPaused');
  });

  it('rolls back a Page listener group when its readiness task admission is denied', async () => {
    vi.useFakeTimers();
    try {
      const failRequestGate = createDeferred<void>();
      const harness = createGuardHarness({
        cdpSendGate: { method: 'Fetch.failRequest', promise: failRequestGate.promise },
        contextCloseError: new Error('admission invalidation close failed'),
      });
      const ledger = new SafetyLedger();
      const deniedPageRemovals: string[] = [];
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      await readyHarnessPage(harness);
      for (let index = 0; index < 256; index += 1) {
        harness.cdpRequestPausedHandler?.({
          requestId: `admitted-${index}`,
          frameId: 'root-frame',
          request: { method: 'GET', url: `https://example.test/admitted-${index}` },
        });
      }

      const deniedPage = createHarnessPage(harness, {
        url: 'https://example.test/denied-page',
        onOffEvent: (event) => deniedPageRemovals.push(event),
      });
      await expect(awaitPassiveRequestGuardReady(deniedPage)).rejects.toThrow(/invalidated/i);
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        'admission invalidation close failed',
      );

      expect(deniedPageRemovals).toEqual(['download', 'popup', 'framenavigated']);
      expect(harness.calls.filter((call) => call === 'CDP')).toHaveLength(1);
      const failedAttempts = harness.closeCount;
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        'admission invalidation close failed',
      );
      expect(harness.closeCount).toBe(failedAttempts + 1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
      expect(deniedPageRemovals).toEqual(['download', 'popup', 'framenavigated']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes a hostile listener-task rejection without skipping safety invalidation', async () => {
    const hostileError = createHostileGuardError();
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    let downloadHandler: ((download: Download) => void) | undefined;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/hostile-task',
      onEvent(event, handler) {
        if (event === 'download') downloadHandler = handler as (download: Download) => void;
      },
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);

    downloadHandler?.({
      url: () => 'data:text/plain,hostile-task',
      suggestedFilename: () => 'hostile-task.txt',
      cancel: () => Promise.reject(hostileError),
    } as unknown as Download);
    await expect.poll(() => harness.closeCount).toBe(1);

    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
      message: 'Guard error could not be safely normalized',
    }]));
  });

  it('normalizes a hostile listener-cleanup failure and continues every remaining inverse', async () => {
    const hostileError = createHostileGuardError();
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent(event) {
        pageRemoved.push(event);
        if (event === 'download') throw hostileError;
      },
    });
    await awaitPassiveRequestGuardReady(page);

    await closePassiveGuardedContext(harness.context);

    expect(pageRemoved).toEqual(['download', 'popup', 'framenavigated']);
    expect(harness.removedListeners).toEqual(expect.arrayContaining([
      'CDP:close',
      'CDP:Fetch.requestPaused',
      'CONTEXT:page',
      'CONTEXT:requestfailed',
    ]));
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARD_LISTENER_CLEANUP_FAILED',
      message: 'Guard error could not be safely normalized',
    }]);
  });

  it('normalizes a hostile enforcement failure without replacing its owner outcome or invalidation', async () => {
    const hostileError = createHostileGuardError();
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const routed = createHarnessRoute(page, {
      method: 'POST',
      url: 'https://example.test/hostile-enforcement',
      navigation: false,
      abortError: hostileError,
    });

    let ownerError: unknown;
    try {
      await harness.httpHandler?.(routed.route);
    } catch (error) {
      ownerError = error;
    }

    expect(ownerError === hostileError).toBe(true);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'HTTP_ABORT_FAILED',
      message: 'Guard error could not be safely normalized',
    }]));
  });

  it('preserves an undefined abort rejection while invalidating an unready navigation', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { url: 'https://example.test/unready' });
    const routed = createHarnessRoute(page, {
      method: 'GET',
      url: 'https://example.test/unready-navigation',
      navigation: true,
      abortRejection: { value: undefined },
    });

    const outcome = await Promise.resolve(harness.httpHandler?.(routed.route)).then(
      () => 'RESOLVED' as const,
      (error: unknown) => error === undefined ? 'REJECTED_UNDEFINED' as const : 'REJECTED_OTHER' as const,
    );

    expect(outcome).toBe('REJECTED_UNDEFINED');
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'HTTP_ABORT_FAILED',
      message: 'undefined',
    }]));
  });

  it('normalizes a huge bigint rejection without decimal materialization', async () => {
    const hugeBigint = 2n ** 1_000_000n;
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const routed = createHarnessRoute(page, {
      method: 'POST',
      url: 'https://example.test/huge-bigint',
      navigation: false,
      abortError: hugeBigint,
    });

    let ownerError: unknown;
    try {
      await harness.httpHandler?.(routed.route);
    } catch (error) {
      ownerError = error;
    }

    expect(ownerError === hugeBigint).toBe(true);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'HTTP_ABORT_FAILED',
      message: 'Guard error could not be safely normalized',
    }]));
  });

  it('retains fail-closed listeners when Context close rejects', async () => {
    const harness = createGuardHarness({ contextCloseError: new Error('context close failed') });
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent: (event) => pageRemoved.push(event),
    });
    await awaitPassiveRequestGuardReady(page);

    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');

    expect(harness.closeCount).toBe(2);
    expect(harness.removedListeners).toEqual([]);
    expect(pageRemoved).toEqual([]);
    expect(harness.pageHandler).toBeTypeOf('function');
    expect(harness.requestFailedHandler).toBeTypeOf('function');
    expect(harness.cdpRequestPausedHandler).toBeTypeOf('function');
    expect(harness.cdpCloseHandler).toBeTypeOf('function');
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'context close failed',
    }, {
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'context close failed',
    }]);
  });

  it('retains fail-closed listeners when Context close rejects undefined', async () => {
    const harness = createGuardHarness({ contextCloseRejection: { value: undefined } });
    const ledger = new SafetyLedger();
    const pageRemoved: string[] = [];
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      onOffEvent: (event) => pageRemoved.push(event),
    });
    await awaitPassiveRequestGuardReady(page);

    await expect(closePassiveGuardedContext(harness.context)).rejects.toBeUndefined();
    await expect(closePassiveGuardedContext(harness.context)).rejects.toBeUndefined();

    expect(harness.closeCount).toBe(2);
    expect(harness.removedListeners).toEqual([]);
    expect(pageRemoved).toEqual([]);
    expect(harness.pageHandler).toBeTypeOf('function');
    expect(harness.requestFailedHandler).toBeTypeOf('function');
    expect(harness.cdpRequestPausedHandler).toBeTypeOf('function');
    expect(harness.cdpCloseHandler).toBeTypeOf('function');
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'undefined',
    }, {
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'undefined',
    }]);
  });

  it('returns the same deterministic invalidation outcome while joining and after the final task-evidence cutoff', async () => {
    const closeGate = createDeferred<void>();
    const cancelGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    let downloadHandler: ((download: Download) => void) | undefined;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent(event, handler) {
        if (event === 'download') downloadHandler = handler as (download: Download) => void;
      },
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    downloadHandler?.({
      url: () => 'data:text/plain,invalidation-race',
      suggestedFilename: () => 'invalidation-race.txt',
      cancel: () => cancelGate.promise,
    } as unknown as Download);

    harness.cdpCloseHandler?.();
    await expect.poll(() => harness.closeCount).toBe(1);
    let joinSettled = false;
    let joinOutcome = 'PENDING';
    const joining = closePassiveGuardedContext(harness.context).then(
      () => { joinOutcome = 'RESOLVED'; joinSettled = true; },
      (error: unknown) => {
        joinOutcome = error instanceof Error ? error.message : 'NON_ERROR_REJECTION';
        joinSettled = true;
      },
    );
    await Promise.resolve();
    expect(joinSettled).toBe(false);

    closeGate.resolve(undefined);
    await Promise.resolve();
    expect(joinSettled).toBe(false);

    cancelGate.reject(new Error('invalidation cutoff cancel failed'));
    await joining;

    const completedOutcome = await closePassiveGuardedContext(harness.context).then(
      () => 'RESOLVED',
      (error: unknown) => error instanceof Error ? error.message : 'NON_ERROR_REJECTION',
    );

    expect(joinOutcome).toBe('Passive request guard context was invalidated');
    expect(completedOutcome).toBe(joinOutcome);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
      message: 'invalidation cutoff cancel failed',
    }]));
  });

  it('directly cancels a resolved Download event after interaction freeze', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    let downloadHandler: ((download: Download) => void) | undefined;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent(event, handler) {
        if (event === 'download') {
          downloadHandler = handler as (download: Download) => void;
        }
      },
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    let cancelCalls = 0;
    const download = {
      url: () => 'data:text/plain,fixture-download',
      suggestedFilename: () => 'fixture.txt',
      cancel: async () => {
        cancelCalls += 1;
      },
    } as unknown as Download;

    downloadHandler?.(download);
    await Promise.resolve();

    expect(cancelCalls).toBe(1);
    expect(ledger.snapshot().blockedDownloads).toEqual([{
      url: 'data:text/plain,fixture-download',
      suggestedFilename: 'fixture.txt',
      reason: 'INTERACTION_FROZEN',
    }]);
  });

  it('drains a deferred download-cancel rejection before guarded context close returns', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const cancelGate = createDeferred<void>();
    let downloadHandler: ((download: Download) => void) | undefined;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent(event, handler) {
        if (event === 'download') {
          downloadHandler = handler as (download: Download) => void;
        }
      },
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    downloadHandler?.({
      url: () => 'data:text/plain,deferred',
      suggestedFilename: () => 'deferred.txt',
      cancel: () => cancelGate.promise,
    } as unknown as Download);

    let closeSettled = false;
    const closing = closePassiveGuardedContext(harness.context).finally(() => {
      closeSettled = true;
    });
    await expect.poll(() => harness.closeCount).toBe(1);
    expect(closeSettled).toBe(false);

    cancelGate.reject(new Error('deferred download cancel failed'));
    await expect(closing).rejects.toThrow('Passive request guard context was invalidated');
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
      message: 'deferred download cancel failed',
    }]));
  });

  it('drains a deferred popup-close rejection before guarded context close returns', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const popupCloseGate = createDeferred<void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);
    createHarnessPage(harness, {
      url: 'https://example.test/popup',
      closeGate: popupCloseGate.promise,
    });

    let closeSettled = false;
    const closing = closePassiveGuardedContext(harness.context).finally(() => {
      closeSettled = true;
    });
    await expect.poll(() => harness.closeCount).toBe(1);
    expect(closeSettled).toBe(false);

    popupCloseGate.reject(new Error('deferred popup close failed'));
    await expect(closing).rejects.toThrow('Passive request guard context was invalidated');
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_POPUP_CLOSE_FAILED',
      message: 'deferred popup close failed',
    }]));
  });

  it('performs a drain-only retry after a listener-task drain timeout', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const neverSettles = createDeferred<void>();
      let downloadHandler: ((download: Download) => void) | undefined;
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = createHarnessPage(harness, {
        url: 'https://example.test/fixture',
        onEvent(event, handler) {
          if (event === 'download') {
            downloadHandler = handler as (download: Download) => void;
          }
        },
      });
      await awaitPassiveRequestGuardReady(page);
      await activateInteractionFreeze(page);
      downloadHandler?.({
        url: () => 'data:text/plain,never',
        suggestedFilename: () => 'never.txt',
        cancel: () => neverSettles.promise,
      } as unknown as Download);

      const closing = closePassiveGuardedContext(harness.context);
      const closeOutcome = expect(closing).rejects.toThrow(
        'Guard-owned listener tasks did not settle before cleanup deadline',
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await closeOutcome;
      await expect(closing).rejects.toMatchObject({ name: 'GuardTaskDrainTimeoutError' });
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
      const removedListeners = [...harness.removedListeners];

      expect(ledger.snapshot().invariantViolations.filter(
        ({ code }) => code === 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
      )).toEqual([{
        code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
        message: 'Guard-owned listener tasks did not settle before cleanup deadline',
      }]);

      neverSettles.resolve(undefined);
      await Promise.resolve();
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        /invalidated/i,
      );
      expect(harness.closeCount).toBe(1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
      expect(harness.removedListeners).toEqual(removedListeners);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps safety invalidation sticky through a drain-only retry', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const neverSettles = createDeferred<void>();
      let downloadHandler: ((download: Download) => void) | undefined;
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = createHarnessPage(harness, {
        url: 'https://example.test/fixture',
        onEvent(event, handler) {
          if (event === 'download') downloadHandler = handler as (download: Download) => void;
        },
      });
      await awaitPassiveRequestGuardReady(page);
      await activateInteractionFreeze(page);
      downloadHandler?.({
        url: () => 'data:text/plain,never-invalidation',
        suggestedFilename: () => 'never-invalidation.txt',
        cancel: () => neverSettles.promise,
      } as unknown as Download);

      harness.cdpCloseHandler?.();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations.filter(
        ({ code }) => code === 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
      )).toEqual([{
        code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
        message: 'Guard-owned listener tasks did not settle before cleanup deadline',
      }]);
      neverSettles.resolve(undefined);
      await Promise.resolve();
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        /invalidated/i,
      );
      expect(harness.closeCount).toBe(1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit new ordinary page-guard work after guarded context close starts', async () => {
    const harness = createGuardHarness();
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));

    await closePassiveGuardedContext(harness.context);
    createHarnessPage(harness, { url: 'https://example.test/late-page' });
    await Promise.resolve();

    expect(harness.calls.filter((call) => call === 'CDP')).toEqual([]);
  });

  it.each(['download', 'popup'] as const)(
    'drains deferred %s cleanup failure into the final interaction audit snapshot',
    async (kind) => {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const cleanupGate = createDeferred<void>();
      const eventHandlers = new Map<string, (value: unknown) => void>();
      let candidate: InteractionCandidate = {
        candidateId: `interaction-candidate:sha256:${'0'.repeat(64)}`,
        ordinal: 0,
        tagName: 'button',
        role: null,
        accessibleName: 'Safe toggle',
        textFingerprint: `sha256:${'1'.repeat(64)}`,
        ariaExpanded: 'false',
        ariaControls: null,
        ariaSelected: null,
        controlledVisible: null,
        controlledHidden: null,
        formAssociated: false,
        formMethod: null,
        formAction: null,
        href: null,
        hrefKind: 'NONE',
        download: false,
        type: 'button',
        disabled: false,
        visible: true,
        boundingBox: { x: 10, y: 20, width: 100, height: 30, top: 20, right: 110, bottom: 50, left: 10 },
      };
      const rawCandidate = {
        ...candidate,
        normalizedText: 'Safe toggle',
        rawHref: null,
        documentUrl: 'https://example.test/fixture',
        documentOrigin: 'https://example.test',
      };
      let page!: Page;
      const elementHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => {
          if (kind === 'download') {
            eventHandlers.get('download')?.({
              url: () => 'data:text/plain,audit-deferred',
              suggestedFilename: () => 'audit-deferred.txt',
              cancel: () => cleanupGate.promise,
            } as unknown as Download);
            return;
          }
          harness.pageHandler?.({
            url: () => 'https://example.test/audit-popup',
            close: () => cleanupGate.promise,
          } as unknown as Page);
        },
        dispose: async () => undefined,
        asElement: () => elementHandle,
      };
      const makePropertyHandle = (value: unknown) => ({
        jsonValue: async () => value,
        dispose: async () => undefined,
        asElement: () => value === elementHandle ? elementHandle : null,
      });
      page = {
        context: () => harness.context,
        isClosed: () => false,
        url: () => 'https://example.test/fixture',
        on(event: string, handler: (value: unknown) => void): Page {
          eventHandlers.set(event, handler);
          return page;
        },
        goto: async () => null,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined
            ? true
            : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => ({
          getProperties: async () => new Map([
            ['status', makePropertyHandle('FOUND')],
            ['domWorkUsed', makePropertyHandle(0)],
            ['element', makePropertyHandle(elementHandle)],
          ]),
          dispose: async () => undefined,
        }),
        locator: () => ({
          nth: () => ({
            elementHandle: async () => ({
              evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
              click: async () => {
                if (kind === 'download') {
                  eventHandlers.get('download')?.({
                    url: () => 'data:text/plain,audit-deferred',
                    suggestedFilename: () => 'audit-deferred.txt',
                    cancel: () => cleanupGate.promise,
                  } as unknown as Download);
                  return;
                }
                harness.pageHandler?.({
                  url: () => 'https://example.test/audit-popup',
                  close: () => cleanupGate.promise,
                } as unknown as Page);
              },
              dispose: async () => undefined,
            }),
          }),
        }),
      } as unknown as Page;
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      harness.registerPage(page);
      harness.pageHandler?.(page);
      await awaitPassiveRequestGuardReady(page);
      const discoveredCandidate = (await discoverInteractionCandidates(page)).candidates[0];
      if (discoveredCandidate === undefined) {
        throw new Error('audit guard harness candidate was not discovered');
      }
      candidate = discoveredCandidate;

      let auditSettled = false;
      let auditSessionClosed = false;
      const auditing = auditInteraction({
        sessionFactory: async () => ({
          page,
          ledger,
          activateInteractionFreeze: () => activateInteractionFreeze(page),
          isClosed: () => auditSessionClosed,
          close: async () => {
            try {
              await closePassiveGuardedContext(harness.context);
            } finally {
              auditSessionClosed = isPassiveRequestGuardClosed(harness.context);
            }
          },
        }),
        targetUrl: 'https://example.test/fixture',
        candidate,
        viewport: { width: 900, height: 700 },
        timeoutMs: 2_000,
        deadlineAtMs: Date.now() + 5_000,
      }).finally(() => {
        auditSettled = true;
      });
      await expect.poll(() => harness.closeCount).toBe(1);
      expect(auditSettled).toBe(false);

      cleanupGate.reject(new Error(`deferred ${kind} cleanup failed`));
      const result = await auditing;

      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.safety.invariantViolations).toContainEqual({
        code: kind === 'download' ? 'INTERACTION_DOWNLOAD_CANCEL_FAILED' : 'INTERACTION_POPUP_CLOSE_FAILED',
        message: `deferred ${kind} cleanup failed`,
      });
    },
  );

  it.each([
    ['WebSocket', { webSocketInstallError: new Error('WebSocket installation failed') }],
    ['HTTP', { httpInstallError: new Error('HTTP installation failed') }],
  ] as const)('invalidates the context and ledgers a %s installation failure', async (_layer, options) => {
    const harness = createGuardHarness(options);
    const ledger = new SafetyLedger();
    await expect(installPassiveRequestGuard(
      harness.context,
      ledger,
      new Set(),
    )).rejects.toThrow(/installation failed/);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARD_INSTALLATION_FAILED',
      message: expect.stringContaining('installation failed'),
    }]);
  });

  it('rejects repeat installation without widening or duplicating handlers', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

    await expect(installPassiveRequestGuard(
      harness.context,
      ledger,
      new Set(['https://attacker.test']),
    )).rejects.toThrow('already installed');

    expect(harness.calls.filter((call) => call === 'WEBSOCKET')).toHaveLength(1);
    expect(harness.calls.filter((call) => call === 'HTTP')).toHaveLength(1);
    expect(harness.closeCount).toBe(0);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARD_REPEAT_INSTALLATION',
      message: expect.stringContaining('already installed'),
    }]);
  });

  it('rejects before installing routes when a page already exists', async () => {
    const harness = createGuardHarness({ hasPage: true });
    const ledger = new SafetyLedger();

    await expect(installPassiveRequestGuard(
      harness.context,
      ledger,
      new Set(),
    )).rejects.toThrow('before creating any pages');
    expect(harness.calls).toEqual(['CLOSE']);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARD_INSTALLATION_FAILED',
      message: expect.stringContaining('before creating any pages'),
    }]);
  });

  it('rejects page readiness for a page from an unguarded context', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const page = await context.newPage();

    await expect(awaitPassiveRequestGuardReady(page)).rejects.toThrow(/not installed/i);
  });

  it('rejects guarded close APIs for an unguarded page and context', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const page = await context.newPage();

    await expect(closePassiveGuardedPage(page)).rejects.toThrow(/not installed/i);
    await expect(closePassiveGuardedContext(context)).rejects.toThrow(/not installed/i);
    expect(page.isClosed()).toBe(false);
  });

  it('rejects guarded close APIs after the guard context is invalidated', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    harness.cdpCloseHandler?.();
    await expect.poll(() => harness.closeCount).toBe(1);

    await expect(closePassiveGuardedPage(page)).rejects.toThrow(/invalidated/i);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
  });

  it('ledgers page close failure and invalidates without leaving stale owner intent', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { closeError: new Error('page close failed') });
    await awaitPassiveRequestGuardReady(page);

    await expect(closePassiveGuardedPage(page)).rejects.toThrow('page close failed');

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: 'page close failed',
    }]);
    await expect(closePassiveGuardedPage(page)).rejects.toThrow(/invalidated/i);
  });

  it('ledgers context close failure and retains retry ownership while failures persist', async () => {
    const harness = createGuardHarness({ contextCloseError: new Error('context close failed') });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'context close failed',
    }]);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');
    expect(harness.closeCount).toBe(2);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
  });

  it('retry of a failed invalidating raw Context close reaches CLOSED', async () => {
    const firstFailure = new Error('first raw close failed');
    const harness = createGuardHarness({ contextCloseAttempts: [
      { outcome: 'REJECT', error: firstFailure }, { outcome: 'RESOLVE' },
    ] });
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));

    await expect(closePassiveGuardedContext(harness.context)).rejects.toBe(firstFailure);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
    expect(harness.closeCount).toBe(2);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it('overlapping retry callers share one raw close and remain pending until it settles', async () => {
    const retryGate = createDeferred<void>();
    const firstFailure = new Error('first raw close failed');
    const harness = createGuardHarness({
      contextCloseAttempts: [{ outcome: 'REJECT', error: firstFailure }, { outcome: 'RESOLVE' }],
      contextCloseGate: retryGate.promise,
    });
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));
    await expect(closePassiveGuardedContext(harness.context)).rejects.toBe(firstFailure);
    let settled = 0;
    const observe = (): Promise<unknown> => closePassiveGuardedContext(harness.context).then(
      () => { settled += 1; return 'RESOLVED'; },
      (error: unknown) => { settled += 1; return error; },
    );
    const first = observe();
    const second = observe();
    try {
      await expect.poll(() => harness.closeCount).toBe(2);
      expect(settled).toBe(0);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    } finally {
      retryGate.resolve(undefined);
    }
    expect(await first).toMatchObject({ message: 'Passive request guard context was invalidated' });
    expect(await second).toMatchObject({ message: 'Passive request guard context was invalidated' });
    expect(harness.closeCount).toBe(2);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it('overlapping ordinary close callers share the active close attempt without retry', async () => {
    const gate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: gate.promise });
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));
    let settled = 0;
    const observe = (): Promise<unknown> => closePassiveGuardedContext(harness.context).then(
      () => { settled += 1; return 'RESOLVED'; },
      (error: unknown) => { settled += 1; return error; },
    );
    const first = observe();
    const second = observe();
    try {
      await expect.poll(() => harness.closeCount).toBe(1);
      expect(settled).toBe(0);
    } finally {
      gate.resolve(undefined);
    }
    expect(await first).toBe('RESOLVED');
    expect(await second).toBe('RESOLVED');
    expect(harness.closeCount).toBe(1);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it.each(['HTTP', 'WEBSOCKET'] as const)(
    'a failed %s invalidation attempt remains available for explicit owner retry',
    async (protocol) => {
      const closeFailure = new Error('protocol invalidation raw close failed');
      const harness = createGuardHarness({ contextCloseAttempts: [
        { outcome: 'REJECT', error: closeFailure }, { outcome: 'RESOLVE' },
      ] });
      await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      const route = createHarnessRoute(page, {
        method: 'POST', url: 'https://example.test/blocked', navigation: false,
        abortError: new Error('protocol abort failed'),
      });
      const callback = protocol === 'HTTP'
        ? harness.httpHandler?.(route.route)
        : harness.webSocketHandler?.({
          url: () => 'wss://example.test/blocked',
          close: async () => { throw new Error('protocol close failed'); },
        } as unknown as WebSocketRoute);
      await expect(Promise.resolve(callback)).rejects.toBe(closeFailure);
      expect(harness.closeCount).toBe(1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
      expect(harness.closeCount).toBe(2);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    },
  );

  it.each([
    ['HTTP', 'SYNC_THROW'], ['HTTP', 'DIRECT_REJECT'],
    ['WEBSOCKET', 'SYNC_THROW'], ['WEBSOCKET', 'DIRECT_REJECT'],
  ] as const)('fix round 1 %s callback retains its %s raw-close failure until explicit retry', async (protocol, timing) => {
    // ミューテーション検出: 最初の無効化が即座に拒否された後、コールバックが別の試行を
    // 開始してその失敗を隠しCLOSEDへ到達してしまうとこのテストは失敗する。
    const closeFailure = new Error('immediate raw close failed');
    const harness = createGuardHarness();
    const rawClose = vi.spyOn(harness.context, 'close').mockImplementationOnce(() => {
      if (timing === 'SYNC_THROW') throw closeFailure;
      return Promise.reject(closeFailure);
    });
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const route = createHarnessRoute(page, {
      method: 'POST', url: 'https://example.test/blocked', navigation: false,
      abortError: new Error('protocol abort failed'),
    });
    const callback = protocol === 'HTTP'
      ? harness.httpHandler?.(route.route)
      : harness.webSocketHandler?.({
        url: () => 'wss://example.test/blocked',
        close: async () => { throw new Error('protocol close failed'); },
      } as unknown as WebSocketRoute);
    await expect(Promise.resolve(callback)).rejects.toBe(closeFailure);
    expect(rawClose).toHaveBeenCalledTimes(1);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
    expect(rawClose).toHaveBeenCalledTimes(2);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it('fix round 1 contains hostile raw-close rejection from an unobserved requestfailed event', async () => {
    // ミューテーション検出: 任意のraw rejectionに対するinstanceof判定が、上限付き正規化より
    // 前に例外を投げ、unhandledRejectionとしてイベントリスナーの外へ漏れるとこのテストは失敗する。
    const unhandled: unknown[] = [];
    const observe = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    try {
      const harness = createGuardHarness({ contextCloseAttempts: [
        { outcome: 'REJECT', error: createHostileGuardError() }, { outcome: 'RESOLVE' },
      ] });
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      await readyHarnessPage(harness);
      void harness.requestFailedHandler?.({
        isNavigationRequest: () => true,
        frame: () => { throw new Error('frame unavailable'); },
      } as unknown as Request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
        { code: 'GUARD_CONTEXT_INVALIDATION_FAILED', message: 'Guard error could not be safely normalized' },
        { code: 'GUARD_CONTEXT_INVALIDATION_OWNER_FAILED', message: 'Guard error could not be safely normalized' },
      ]));
      expect(harness.closeCount).toBe(1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
      expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
      expect(harness.closeCount).toBe(2);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    } finally {
      process.off('unhandledRejection', observe);
    }
  });

  it.each([false, true])('synchronous re-entry preserves invalidation priority with retry=%s', async (failsFirst) => {
    const firstFailure = new Error('re-entrant raw close failed');
    let page!: Page;
    const harness = createGuardHarness({
      contextCloseAttempts: failsFirst
        ? [{ outcome: 'REJECT', error: firstFailure }, { outcome: 'RESOLVE' }]
        : [{ outcome: 'RESOLVE' }],
      onContextClose: () => {
        if (harness.closeCount === 1) emitFailedMainFrameRequest(harness, page, {
          method: 'GET', url: 'https://example.test/re-entry', errorText: 'net::ERR_CONNECTION_RESET',
        });
      },
    });
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));
    page = await readyHarnessPage(harness);
    const closing = closePassiveGuardedContext(harness.context);
    if (failsFirst) {
      await expect(closing).rejects.toBe(firstFailure);
      await expect.poll(() => harness.closeCount).toBe(2);
    } else {
      await expect(closing).rejects.toThrow(/invalidated/i);
    }
    expect(harness.closeCount).toBe(failsFirst ? 2 : 1);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it('fails a paused Document after guarded context close rejects instead of continuing it', async () => {
    const harness = createGuardHarness({ contextCloseError: new Error('context close failed') });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');

    harness.cdpRequestPausedHandler?.({
      requestId: 'after-rejected-context-close',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/catalog' },
    });

    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.failRequest',
    )).toHaveLength(1);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(harness.cdpCommands).not.toContain('Fetch.continueRequest');
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'context close failed',
    }]);
  });

  it('fails a paused Document while guarded context close is pending instead of continuing it', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.({
      requestId: 'during-context-close',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/catalog' },
    });

    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.failRequest',
    )).toHaveLength(1);
    expect(harness.cdpCommands).not.toContain('Fetch.continueRequest');
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    closeGate.resolve();
    await closing;
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await flushGuardProtocolCallbacks();
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('fails a paused Document while guarded page close is pending instead of continuing it', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { closeGate: closeGate.promise });
    await awaitPassiveRequestGuardReady(page);
    const closing = closePassiveGuardedPage(page);

    harness.cdpRequestPausedHandler?.({
      requestId: 'during-page-close',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/catalog' },
    });

    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.failRequest',
    )).toHaveLength(1);
    expect(harness.cdpCommands).not.toContain('Fetch.continueRequest');
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    closeGate.resolve();
    await closing;
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
    await expect(readyHarnessPage(harness)).resolves.toBeDefined();
  });

  it('detaches lifecycle listeners after a guarded page close failure successfully invalidates its Context', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { closeError: new Error('page close failed') });
    await awaitPassiveRequestGuardReady(page);
    await expect(closePassiveGuardedPage(page)).rejects.toThrow('page close failed');

    expect(harness.cdpRequestPausedHandler).toBeUndefined();
    expect(harness.requestFailedHandler).toBeUndefined();
    expect(harness.cdpCommands).not.toContain('Fetch.continueRequest');
    expect(harness.cdpCommands).not.toContain('Fetch.failRequest');
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: 'page close failed',
    }]);
  });

  it.each(['in progress', 'complete'] as const)(
    'keeps lifecycle listeners only while safety invalidation is %s',
    async (phase) => {
      const closeGate = phase === 'in progress' ? createDeferred<void>() : undefined;
      const harness = createGuardHarness(
        closeGate === undefined ? {} : { contextCloseGate: closeGate.promise },
      );
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      const frame = { parentFrame: () => null, page: () => page };
      harness.requestFailedHandler?.({
        method: () => 'GET',
        url: () => 'https://example.test/catalog',
        isNavigationRequest: () => true,
        frame: () => frame,
        failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
      } as unknown as Request);
      await expect.poll(() => harness.closeCount).toBe(1);

      if (phase === 'complete') {
        await expect.poll(() => harness.cdpRequestPausedHandler).toBeUndefined();
        expect(harness.requestFailedHandler).toBeUndefined();
      } else {
        expect(harness.cdpRequestPausedHandler).toBeTypeOf('function');
        expect(harness.requestFailedHandler).toBeTypeOf('function');
      }
      harness.cdpRequestPausedHandler?.({
        requestId: `after-invalidation-${phase}`,
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/catalog' },
      });

      await expect.poll(() => harness.cdpCommands.filter(
        (command) => command === 'Fetch.failRequest',
      )).toHaveLength(phase === 'in progress' ? 1 : 0);
      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/catalog',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });
      expect(harness.cdpCommands).not.toContain('Fetch.continueRequest');
      expect(harness.closeCount).toBe(1);
      expect(ledger.snapshot().blockedNavigations).toEqual([]);
      expect(ledger.snapshot().invariantViolations).toEqual([{
        code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
        message: 'net::ERR_CONNECTION_RESET',
      }]);
      closeGate?.resolve();
    },
  );

  it('ledgers lifecycle failRequest uncertainty without retrying rejected context close', async () => {
    const harness = createGuardHarness({
      contextCloseError: new Error('context close failed'),
      cdpSendErrorMethod: 'Fetch.failRequest',
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');

    harness.cdpRequestPausedHandler?.({
      requestId: 'lifecycle-fail-error',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/catalog' },
    });

    await expect.poll(() => ledger.snapshot().invariantViolations).toHaveLength(2);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await flushGuardProtocolCallbacks();
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: 'context close failed' },
      { code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message: 'Fetch.failRequest failed' },
      { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
    ]);
  });

  it('does not let a mismatched failure consume a lifecycle correlation record', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);
    harness.cdpRequestPausedHandler?.({
      requestId: 'lifecycle-exact-record',
      frameId: 'root-frame',
      request: { method: 'get', url: 'https://example.test/catalog' },
    });
    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.failRequest',
    )).toHaveLength(1);

    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/other',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await flushGuardProtocolCallbacks();
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_BLOCKED_BY_CLIENT',
    }]);
    expect(harness.closeCount).toBe(1);

    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await flushGuardProtocolCallbacks();
    expect(ledger.snapshot().invariantViolations).toHaveLength(1);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await flushGuardProtocolCallbacks();
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
      { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
    ]);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    closeGate.resolve();
    await expect(closing).rejects.toThrow('Passive request guard context was invalidated');
  });

  it('correlates a redirected lifecycle failure to its Playwright-visible predecessor', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    harness.cdpRequestPausedHandler?.({
      requestId: 'allowed-predecessor',
      frameId: 'root-frame',
      request: { method: 'get', url: 'https://example.test/redirect' },
    });
    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.continueRequest',
    )).toHaveLength(1);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.({
      requestId: 'lifecycle-redirect-target',
      redirectedRequestId: 'allowed-predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://external.test/catalog' },
    });
    await expect.poll(() => harness.cdpCommands.filter(
      (command) => command === 'Fetch.failRequest',
    )).toHaveLength(1);
    closeGate.resolve();
    await closing;
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/redirect',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('does not let an expired lifecycle correlation suppress a later matching failure', async () => {
    vi.useFakeTimers();
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const closing = closePassiveGuardedContext(harness.context);
    try {
      await Promise.resolve();
      expect(harness.closeCount).toBe(1);
      harness.cdpRequestPausedHandler?.({
        requestId: 'expiring-lifecycle-record',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/catalog' },
      });
      await Promise.resolve();
      expect(harness.cdpCommands.filter(
        (command) => command === 'Fetch.failRequest',
      )).toHaveLength(1);
      vi.setSystemTime(Date.now() + 1_001);

      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/catalog',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
        code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
        message: 'net::ERR_BLOCKED_BY_CLIENT',
      }]);
      expect(harness.closeCount).toBe(1);
    } finally {
      closeGate.resolve();
      await expect(closing).rejects.toThrow('Passive request guard context was invalidated');
      vi.useRealTimers();
    }
  });

  it('ledgers fallback and abort failures while keeping the request fail-closed', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    let abortCount = 0;
    const request = {
      method: () => 'GET',
      url: () => 'https://cdn.test/asset.js',
      isNavigationRequest: () => false,
    } as unknown as Request;
    const route = {
      request: () => request,
      async fallback(): Promise<void> {
        throw new Error('fallback failed');
      },
      async abort(): Promise<void> {
        abortCount += 1;
      },
    } as unknown as Route;

    await expect(Promise.resolve(harness.httpHandler?.(route))).rejects.toThrow('fallback failed');

    expect(abortCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_FALLBACK_FAILED',
      message: 'fallback failed',
    }]);
  });

  it.each([
    {
      operation: 'Fetch.continueRequest',
      requestUrl: 'https://example.test/catalog',
      expectedCode: 'CDP_CONTINUE_REQUEST_FAILED',
    },
    {
      operation: 'Fetch.failRequest',
      requestUrl: 'https://external.test/catalog',
      expectedCode: 'CDP_FAIL_REQUEST_FAILED',
    },
  ])('invalidates and ledgers $operation uncertainty', async ({ operation, requestUrl, expectedCode }) => {
    const harness = createGuardHarness({ cdpSendErrorMethod: operation });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.cdpRequestPausedHandler?.({
      requestId: 'document-request',
      frameId: 'root-frame',
      request: { method: 'GET', url: requestUrl },
    });

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: expectedCode,
      message: `${operation} failed`,
    }]);
  });

  it('does not let a blocked CDP request suppress an unrelated allowed request failure', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    harness.cdpRequestPausedHandler?.({
      requestId: 'allowed-document',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/redirect' },
    });
    harness.cdpRequestPausedHandler?.({
      requestId: 'blocked-document',
      redirectedRequestId: 'allowed-document',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://external.test/catalog' },
    });
    await expect.poll(() => ledger.snapshot().blockedNavigations).toEqual([{
      method: 'GET',
      url: 'https://external.test/catalog',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    }]);
    const frame = { parentFrame: () => null, page: () => page };
    const failedAllowedRequest = {
      method: () => 'GET',
      url: () => 'https://example.test/catalog',
      isNavigationRequest: () => true,
      frame: () => frame,
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(failedAllowedRequest);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_CONNECTION_RESET',
    }]);
  });

  it('contains the reserved overflow owner when 256 admitted tasks time out', async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const eventHandlers = new Map<string, (value: unknown) => void>();
      const gates = Array.from({ length: 257 }, () => createDeferred<void>());
      let cancelCalls = 0;
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = createHarnessPage(harness, {
        url: 'https://example.test/fixture',
        onEvent: (event, handler) => eventHandlers.set(event, handler as (value: unknown) => void),
      });
      await awaitPassiveRequestGuardReady(page);
      await activateInteractionFreeze(page);

      for (let index = 0; index < gates.length; index += 1) {
        eventHandlers.get('download')?.({
          url: () => `data:text/plain,${index}`,
          suggestedFilename: () => `${index}.txt`,
          cancel: () => {
            cancelCalls += 1;
            return gates[index]!.promise;
          },
        } as unknown as Download);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelCalls).toBe(256);
      expect(harness.closeCount).toBe(1);

      const closeOutcome = expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        'Guard-owned listener tasks did not settle before cleanup deadline',
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await closeOutcome;
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandledRejections).toEqual([]);
      expect(ledger.snapshot().invariantViolations.filter(
        ({ code }) => code === 'GUARD_TASK_LIMIT_REACHED',
      )).toHaveLength(1);
      expect(ledger.snapshot().invariantViolations.filter(
        ({ code }) => code === 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
      )).toHaveLength(1);
      const retryOutcome = expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(
        'Guard-owned listener tasks did not settle before cleanup deadline',
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await retryOutcome;
      expect(harness.closeCount).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it('round 5 event ownership contains failed-request invalidation without changing the public timeout', async () => {
    // ミューテーション検出: 非同期のrequestfailedリスナーが拒否されるcompletionを
    // awaitし、自身の別の未観測なPromiseをリークさせるとこのテストは失敗する。
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const observe = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    const cancelGate = createDeferred<void>();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const handlers = new Map<string, (...arguments_: unknown[]) => void>();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = createHarnessPage(harness, {
        url: 'https://example.test/fixture',
        onEvent: (event, handler) => handlers.set(event, handler),
      });
      await awaitPassiveRequestGuardReady(page);
      await activateInteractionFreeze(page);
      handlers.get('download')?.({
        url: () => 'data:text/plain,pending', suggestedFilename: () => 'pending.txt',
        cancel: () => cancelGate.promise,
      } as unknown as Download);
      void harness.requestFailedHandler?.({
        isNavigationRequest: () => true,
        frame: () => { throw new Error('round 5 frame unavailable'); },
      } as unknown as Request);
      const publicOutcome = closePassiveGuardedContext(harness.context).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_001);
      const timeout = await publicOutcome;
      expect(timeout).toMatchObject({ message: 'Guard-owned listener tasks did not settle before cleanup deadline' });
      const retryOutcome = closePassiveGuardedContext(harness.context).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await retryOutcome).toMatchObject({ name: 'GuardTaskDrainTimeoutError' });
      expect(await retryOutcome).not.toBe(timeout);
      expect(harness.closeCount).toBe(1);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      cancelGate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      process.off('unhandledRejection', observe);
      vi.useRealTimers();
    }
  });

  it('requestfailed callback is void-owned and drained when emitted synchronously during raw close', async () => {
    let harness!: GuardHarness;
    let page!: Page;
    let listenerReturn: Promise<unknown> | unknown;
    harness = createGuardHarness({
      onContextClose: () => {
        listenerReturn = harness.requestFailedHandler?.({
          isNavigationRequest: () => true,
          frame: () => ({ parentFrame: () => null, page: () => page }),
          method: () => 'GET',
          url: () => 'https://example.test/during-close',
          failure: (): never => { throw new Error('requestfailed classification failed during close'); },
        } as unknown as Request);
        void Promise.resolve(listenerReturn).catch(() => undefined);
      },
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    page = await readyHarnessPage(harness);

    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);

    expect(listenerReturn).toBeUndefined();
    expect(harness.closeCount).toBe(1);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toContainEqual({
      code: 'GUARD_REQUEST_FAILED_TASK_FAILED',
      message: 'requestfailed classification failed during close',
    });
  });

  it('257 synchronous requestfailed callbacks share the 256-task bound and one overflow invalidation owner', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const request = {
      isNavigationRequest: () => false,
      frame: () => ({ parentFrame: () => null, page: () => page }),
      method: () => 'GET',
      url: () => 'https://example.test/subresource.png',
      failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    } as unknown as Request;

    const returns = Array.from({ length: 257 }, () => harness.requestFailedHandler?.(request));
    expect(returns.every((value) => value === undefined)).toBe(true);
    expect(ledger.snapshot().invariantViolations.filter(
      ({ code }) => code === 'GUARD_TASK_LIMIT_REACHED',
    )).toHaveLength(1);
    await expect.poll(() => harness.closeCount).toBe(1);

    closeGate.resolve(undefined);
    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(harness.closeCount).toBe(1);
  });

  it('contains requestfailed task failure and raw-close rejection without process unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const observe = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', observe);
    try {
      const rawCloseFailure = new Error('requestfailed invalidation close failed');
      const harness = createGuardHarness({ contextCloseAttempts: [
        { outcome: 'REJECT', error: rawCloseFailure },
        { outcome: 'RESOLVE' },
      ] });
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      const returned = harness.requestFailedHandler?.({
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null, page: () => page }),
        failure: () => ({ errorText: 'net::ERR_FAILED' }),
        method: (): never => { throw new Error('requestfailed task exploded'); },
      } as unknown as Request);

      void Promise.resolve(returned).catch(() => undefined);
      expect(returned).toBeUndefined();
      await expect.poll(() => harness.closeCount).toBe(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
        { code: 'GUARD_REQUEST_FAILED_TASK_FAILED', message: 'requestfailed task exploded' },
        { code: 'GUARD_CONTEXT_INVALIDATION_FAILED', message: rawCloseFailure.message },
        { code: 'GUARD_CONTEXT_INVALIDATION_OWNER_FAILED', message: rawCloseFailure.message },
      ]));
      await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
      expect(harness.closeCount).toBe(2);
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
    } finally {
      process.off('unhandledRejection', observe);
    }
  });

  it.each(['HTTP', 'WEBSOCKET'] as const)(
    'round 5 protocol ownership drains a pending %s callback before terminal close and final evidence',
    async (protocol) => {
      // ミューテーション検出: ルートの作業がpending ownershipから漏れるか、そのdrainから
      // 自身を取り除く前に無効化を開始/awaitしてしまうとこのテストは失敗する。
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      const gate = createDeferred<void>();
      let started = false;
      const blockedProtocol = (): Promise<void> => { started = true; return gate.promise; };
      const routed = createHarnessRoute(page, { method: 'GET', url: 'https://example.test/allowed', navigation: false });
      Object.defineProperty(routed.route, 'fallback', { value: blockedProtocol });
      const callback = Promise.resolve(protocol === 'HTTP'
        ? harness.httpHandler?.(routed.route)
        : harness.webSocketHandler?.({ url: () => 'wss://example.test/pending', close: blockedProtocol } as unknown as WebSocketRoute))
        .catch((error: unknown) => error);
      await expect.poll(() => started).toBe(true);
      let closeSettled = false;
      const closing = closePassiveGuardedContext(harness.context).then(
        () => { closeSettled = true; return 'RESOLVED'; },
        (error: unknown) => { closeSettled = true; return error; },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const settledBeforeProtocol = closeSettled;
      const terminalBeforeProtocol = isPassiveRequestGuardClosed(harness.context);
      gate.reject(new Error(`round 5 late ${protocol} failure`));
      const outcome = await closing;
      await callback;
      expect(settledBeforeProtocol).toBe(false);
      expect(terminalBeforeProtocol).toBe(false);
      expect(outcome).toMatchObject({ message: 'Passive request guard context was invalidated' });
      expect(ledger.snapshot().invariantViolations).toContainEqual({
        code: protocol === 'HTTP' ? 'HTTP_FALLBACK_FAILED' : 'WEBSOCKET_CLOSE_FAILED',
        message: `round 5 late ${protocol} failure`,
      });
      expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
      expect(harness.closeCount).toBe(1);
      const finalEvidence = ledger.snapshot();
      await Promise.resolve();
      expect(ledger.snapshot()).toEqual(finalEvidence);
    },
  );

  it.each(['HTTP', 'WEBSOCKET'] as const)(
    'round 5 protocol ownership bounds %s admission and rejects terminal callbacks without delivery',
    async (protocol) => {
      // ミューテーション検出: プロトコルコールバックが共有タスク上限を迂回するか、
      // raw closeの成功が受付を打ち切った後にdelivery/証跡作業を開始するとこのテストは失敗する。
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      const gate = createDeferred<void>();
      let protocolCalls = 0;
      let serverConnections = 0;
      const blockedProtocol = (): Promise<void> => { protocolCalls += 1; return gate.promise; };
      const routed = createHarnessRoute(page, { method: 'GET', url: 'https://example.test/capped', navigation: false });
      Object.defineProperty(routed.route, 'fallback', { value: blockedProtocol });
      const http = harness.httpHandler!;
      const websocket = harness.webSocketHandler!;
      const socket = {
        url: () => 'wss://example.test/capped', close: blockedProtocol,
        connectToServer: () => { serverConnections += 1; },
      } as unknown as WebSocketRoute;
      const invoke = (): Promise<unknown> => Promise.resolve(protocol === 'HTTP' ? http(routed.route) : websocket(socket));
      const admitted = Array.from({ length: 256 }, invoke);
      await expect.poll(() => protocolCalls).toBe(256);
      const overflow = invoke();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const callsAtOverflow = protocolCalls;
      const closesAtOverflow = harness.closeCount;
      gate.resolve(undefined);
      await Promise.all([...admitted, overflow]);
      await closePassiveGuardedContext(harness.context).catch(() => undefined);
      const cutoff = ledger.snapshot();
      await invoke();
      expect(callsAtOverflow).toBe(256);
      expect(closesAtOverflow).toBe(1);
      expect(protocolCalls).toBe(256);
      expect(serverConnections).toBe(0);
      expect(ledger.snapshot()).toEqual(cutoff);
      expect(cutoff.invariantViolations.filter(({ code }) => code === 'GUARD_TASK_LIMIT_REACHED')).toHaveLength(1);
      expect(harness.closeCount).toBe(1);
    },
  );

  it('bounds expected CDP failure correlations and fails the overflow request closed', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);

    for (let index = 0; index < 65; index += 1) {
      harness.cdpRequestPausedHandler?.({
        requestId: `frozen-${index}`,
        frameId: 'root-frame',
        request: { method: 'GET', url: `https://example.test/frozen-${index}` },
      });
      await expect.poll(
        () => harness.cdpCommands.filter((command) => command === 'Fetch.failRequest').length,
      ).toBe(index + 1);
    }
    expect(ledger.snapshot().invariantViolations.filter(
      (event) => event.code === 'EXPECTED_CDP_FAILURE_LIMIT_REACHED',
    )).toHaveLength(1);
    await expect.poll(() => harness.requestFailedHandler).toBeUndefined();
    expect(harness.cdpRequestPausedHandler).toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'EXPECTED_CDP_FAILURE_LIMIT_REACHED',
      message: 'Expected CDP failure correlation limit reached',
    }]);
  });

  it('purges expired expected CDP failure correlations', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
      await activateInteractionFreeze(page);
      harness.cdpRequestPausedHandler?.({
        requestId: 'expires',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/expires' },
      });
      await vi.advanceTimersByTimeAsync(1_001);
      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/expires',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });
      await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
      ]));

    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds redirect predecessors and consumes the exact predecessor once', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);
    for (let index = 0; index < 64; index += 1) {
      harness.cdpRequestPausedHandler?.({
        requestId: `document-${index}`,
        frameId: 'root-frame',
        request: { method: 'GET', url: `https://example.test/document-${index}` },
      });
      await Promise.resolve();
    }
    harness.cdpRequestPausedHandler?.({
      requestId: 'redirect-current',
      redirectedRequestId: 'document-0',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/redirect-current' },
    });
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.({
      requestId: 'overflow-current',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/overflow-current' },
    });
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REDIRECT_PREDECESSOR_LIMIT_REACHED' }),
    ]));
    expect(ledger.snapshot().invariantViolations.filter(
      (event) => event.code === 'REDIRECT_PREDECESSOR_LIMIT_REACHED',
    )).toHaveLength(1);
  });

  it('rejects overlong method and URL correlation identities without truncation alias', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);
    const prefix = `https://example.test/${'a'.repeat(2_100)}`;
    harness.cdpRequestPausedHandler?.({
      requestId: 'overlong-a',
      frameId: 'root-frame',
      request: { method: 'G'.repeat(33), url: `${prefix}A` },
    });
    await Promise.resolve();
    emitFailedMainFrameRequest(harness, page, {
      method: 'G'.repeat(33),
      url: `${prefix}B`,
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CDP_CORRELATION_IDENTITY_REJECTED' }),
      expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
    ]));
  });

  it('initiates the published owner without self-draining an overlong paused Document task', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
      await activateInteractionFreeze(page);

      harness.cdpRequestPausedHandler?.({
        requestId: 'overlong-current',
        frameId: 'root-frame',
        request: { method: 'G'.repeat(33), url: 'https://example.test/overlong' },
      });
      await vi.advanceTimersByTimeAsync(1_001);

      expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([
        { method: 'Fetch.failRequest', params: { requestId: 'overlong-current', errorReason: 'BlockedByClient' } },
      ]);
      expect(harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('initiates the published owner without self-draining the expected-failure cap request', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);
      Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
      await activateInteractionFreeze(page);
      for (let index = 0; index < 64; index += 1) {
        harness.cdpRequestPausedHandler?.({
          requestId: `expected-${index}`,
          frameId: 'root-frame',
          request: { method: 'GET', url: `https://example.test/expected-${index}` },
        });
        await Promise.resolve();
      }

      harness.cdpRequestPausedHandler?.({
        requestId: 'expected-cap-current',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/expected-cap' },
      });
      await vi.advanceTimersByTimeAsync(1_001);

      expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest').at(-1)).toEqual({
        method: 'Fetch.failRequest',
        params: { requestId: 'expected-cap-current', errorReason: 'BlockedByClient' },
      });
      expect(harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumes an exact redirect predecessor once and fails the reused current request', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.cdpRequestPausedHandler?.({
      requestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/predecessor' },
    });
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.({
      requestId: 'redirect-current',
      redirectedRequestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/redirect-current' },
    });
    await Promise.resolve();
    expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'predecessor' } },
      { method: 'Fetch.continueRequest', params: { requestId: 'redirect-current' } },
    ]);
    expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([]);

    harness.cdpRequestPausedHandler?.({
      requestId: 'reused-current',
      redirectedRequestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/reused-current' },
    });
    await expect.poll(() => harness.closeCount).toBe(1);
    expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([
      { method: 'Fetch.failRequest', params: { requestId: 'reused-current', errorReason: 'BlockedByClient' } },
    ]);
  });

  it('fails the exact current request when a supplied redirect predecessor is missing, overlong, or expired', async () => {
    vi.useFakeTimers();
    try {
      const cases = [
        { name: 'missing', redirectedRequestId: 'missing-predecessor' },
        { name: 'overlong', redirectedRequestId: 'r'.repeat(257) },
        { name: 'expired', redirectedRequestId: 'expired-predecessor' },
      ] as const;
      for (const testCase of cases) {
        const harness = createGuardHarness();
        const ledger = new SafetyLedger();
        await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
        await readyHarnessPage(harness);
        if (testCase.name === 'expired') {
          harness.cdpRequestPausedHandler?.({
            requestId: 'expired-predecessor',
            frameId: 'root-frame',
            request: { method: 'GET', url: 'https://example.test/expired-predecessor' },
          });
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(1_001);
        }
        const requestId = `${testCase.name}-current`;
        harness.cdpRequestPausedHandler?.({
          requestId,
          redirectedRequestId: testCase.redirectedRequestId,
          frameId: 'root-frame',
          request: { method: 'GET', url: `https://example.test/${testCase.name}-current` },
        });
        await vi.advanceTimersByTimeAsync(1_001);
        expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([
          { method: 'Fetch.failRequest', params: { requestId, errorReason: 'BlockedByClient' } },
        ]);
        expect(harness.closeCount).toBe(1);
        expect(ledger.snapshot().invariantViolations).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT' }),
        ]));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the 65th exact current request after an exact redirect predecessor is consumed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      await readyHarnessPage(harness);
      for (let index = 0; index < 64; index += 1) {
        harness.cdpRequestPausedHandler?.({
          requestId: `document-${index}`,
          frameId: 'root-frame',
          request: { method: 'GET', url: `https://example.test/document-${index}` },
        });
        await Promise.resolve();
      }
      harness.cdpRequestPausedHandler?.({
        requestId: 'redirect-current',
        redirectedRequestId: 'document-0',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/redirect-current' },
      });
      await Promise.resolve();
      harness.cdpRequestPausedHandler?.({
        requestId: 'overflow-current',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/overflow-current' },
      });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(harness.cdpCommandLog.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([
        { method: 'Fetch.failRequest', params: { requestId: 'overflow-current', errorReason: 'BlockedByClient' } },
      ]);
      expect(harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      stage: 'newCDPSession',
      options: { newCdpSessionError: new Error('newCDPSession failed') },
      message: 'newCDPSession failed',
    },
    {
      stage: 'Page.getFrameTree',
      options: { cdpSendErrorMethod: 'Page.getFrameTree' },
      message: 'Page.getFrameTree failed',
    },
    {
      stage: 'Fetch.enable',
      options: { cdpSendErrorMethod: 'Fetch.enable' },
      message: 'Fetch.enable failed',
    },
  ])('invalidates and rejects readiness when $stage setup fails', async ({ options, message }) => {
    const harness = createGuardHarness(options);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness);

    await expect(awaitPassiveRequestGuardReady(page)).rejects.toThrow(message);

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_SETUP_FAILED',
      message,
    }]);
    await expect(awaitPassiveRequestGuardReady(page)).rejects.toThrow(/invalidated/i);
  });

  it('invalidates when a ready page CDP session detaches unexpectedly', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.cdpCloseHandler?.();

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_SESSION_DETACHED',
      message: 'Document interception session detached while its page remained active',
    }]);
  });

  it('invalidates when the requestfailed handler cannot look up the CDP page', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const frame = {
      parentFrame: () => null,
      page(): never {
        throw new Error('requestfailed page unavailable');
      },
    };
    const request = {
      method: () => 'GET',
      url: () => 'https://example.test/catalog',
      isNavigationRequest: () => true,
      frame: () => frame,
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(request);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_PAGE_LOOKUP_FAILED',
      message: 'requestfailed page unavailable',
    }]);
  });

  it('still ledgers an unexpected allowed-delivery abort while its page remains active', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    const frame = { parentFrame: () => null, page: () => page };
    const request = {
      method: () => 'GET',
      url: () => 'https://example.test/catalog',
      isNavigationRequest: () => true,
      frame: () => frame,
      failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(request);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_ABORTED',
    }]);
  });

  it('aborts and invalidates when the route handler cannot look up the CDP page', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    let abortCount = 0;
    const frame = {
      parentFrame: () => null,
      page(): never {
        throw new Error('route page unavailable');
      },
    };
    const request = {
      method: () => 'GET',
      url: () => 'https://example.test/catalog',
      isNavigationRequest: () => true,
      frame: () => frame,
    } as unknown as Request;
    const route = {
      request: () => request,
      async abort(): Promise<void> {
        abortCount += 1;
      },
    } as unknown as Route;

    await expect(Promise.resolve(harness.httpHandler?.(route))).rejects.toThrow('route page unavailable');

    expect(abortCount).toBe(1);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_PAGE_LOOKUP_FAILED',
      message: 'route page unavailable',
    }]);
  });

  it('ledgers an abort failure without claiming the request was blocked', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const request = {
      method: () => 'POST',
      url: () => 'https://example.test/mutation',
      isNavigationRequest: () => false,
    } as unknown as Request;
    const route = {
      request: () => request,
      async abort(): Promise<void> {
        throw new Error('abort failed');
      },
    } as unknown as Route;

    await expect(Promise.resolve(harness.httpHandler?.(route))).rejects.toThrow('abort failed');

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_ABORT_FAILED',
      message: 'abort failed',
    }]);
  });

  it('invalidates the context when navigation frame classification fails', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    let abortCount = 0;
    const request = {
      method: () => 'GET',
      url: () => 'https://example.test/catalog',
      isNavigationRequest: () => true,
      frame(): never {
        throw new Error('frame unavailable');
      },
    } as unknown as Request;
    const route = {
      request: () => request,
      async abort(): Promise<void> {
        abortCount += 1;
      },
    } as unknown as Route;

    await expect(Promise.resolve(harness.httpHandler?.(route))).resolves.toBeUndefined();

    expect(abortCount).toBe(1);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'FRAME_CLASSIFICATION_FAILED',
      message: 'frame unavailable',
    }]);
  });

  it('records a WebSocket policy block independently from best-effort close failure', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    let connected = false;
    const webSocketRoute = {
      url: () => 'wss://example.test/socket',
      connectToServer(): WebSocketRoute {
        connected = true;
        return webSocketRoute as unknown as WebSocketRoute;
      },
      async close(): Promise<void> {
        throw new Error('close failed');
      },
    } as unknown as WebSocketRoute;

    await expect(Promise.resolve(harness.webSocketHandler?.(webSocketRoute))).resolves.toBeUndefined();

    expect(connected).toBe(false);
    expect(ledger.snapshot().blockedWebSockets).toEqual([{
      url: 'wss://example.test/socket',
      reason: 'PASSIVE_WEBSOCKET',
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'WEBSOCKET_CLOSE_FAILED',
      message: 'close failed',
    }]);
  });
});

describe('passive request guard server boundary', () => {
  it('does not treat an explicitly guarded page close as CDP detachment', async () => {
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set(['https://example.test']));
    const page = await createGuardedPage(context);

    await closePassiveGuardedPage(page);

    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('does not ledger owner page close while an allowed navigation is pending', async () => {
    const server = await startServer({ slowResponseDelayMs: 30_000 });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const navigation = page.goto(`${server.origin}/__slow`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);
    await expect.poll(() => server.getRequestObservations().some(
      (observation) => observation.pathname === '/__slow',
    )).toBe(true);

    await closePassiveGuardedPage(page);
    await expect(navigation).resolves.toBe('REJECTED');
    expect(ledger.snapshot().invariantViolations).toEqual([]);

    const followup = await createGuardedPage(context);
    await followup.goto(`${server.origin}/index.html`);
    expect(await followup.locator('h1').textContent()).toBe('Fixture Home');
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('does not ledger owner context close while an allowed navigation is pending', async () => {
    const server = await startServer({ slowResponseDelayMs: 30_000 });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const navigation = page.goto(`${server.origin}/__slow`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);
    await expect.poll(() => server.getRequestObservations().some(
      (observation) => observation.pathname === '/__slow',
    )).toBe(true);

    await closePassiveGuardedContext(context);

    await expect(navigation).resolves.toBe('REJECTED');
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('treats an unmarked idle page close as unexpected CDP detachment', async () => {
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set(['https://example.test']));
    const page = await createGuardedPage(context);

    await page.close();

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_SESSION_DETACHED',
      message: 'Document interception session detached while its page remained active',
    }]);
  });

  it('ledgers an unmarked page close while an allowed navigation is pending', async () => {
    const server = await startServer({ slowResponseDelayMs: 30_000 });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const navigation = page.goto(`${server.origin}/__slow`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);
    await expect.poll(() => server.getRequestObservations().some(
      (observation) => observation.pathname === '/__slow',
    )).toBe(true);

    await page.close();

    await expect(navigation).resolves.toBe('REJECTED');
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_ABORTED',
    }]));
  });

  it('ledgers an unmarked context close while an allowed navigation is pending', async () => {
    const server = await startServer({ slowResponseDelayMs: 30_000 });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const navigation = page.goto(`${server.origin}/__slow`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);
    await expect.poll(() => server.getRequestObservations().some(
      (observation) => observation.pathname === '/__slow',
    )).toBe(true);

    await context.close();

    await expect(navigation).resolves.toBe('REJECTED');
    await expect.poll(() => ledger.snapshot().invariantViolations.length).toBeGreaterThan(0);
  });

  it('allows rendered GET/HEAD traffic but delivers no POST, PUT, PATCH, or DELETE', async () => {
    const server = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);

    await page.goto(`${server.origin}/post-form.html`);
    expect(await page.locator('h1').textContent()).toBe('Fixture Post Form');
    expect(await page.evaluate(() => fetch('/index.html', { method: 'HEAD' }).then((response) => response.status))).toBe(200);
    expect(server.getCounters()).toMatchObject({ get: 1, head: 1 });
    expect(server.getRequestObservations().map(({ method, pathname }) => ({ method, pathname }))).toEqual([
      { method: 'GET', pathname: '/post-form.html' },
      { method: 'HEAD', pathname: '/index.html' },
    ]);
    server.resetCounters();

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const requestFailure = page.waitForEvent('requestfailed', (request) => request.method() === method);
      await page.evaluate(async (mutationMethod) => {
        await fetch('/__mutation', { method: mutationMethod }).catch(() => undefined);
      }, method);
      await requestFailure;
    }

    const postFailure = page.waitForEvent('requestfailed', (request) => request.method() === 'POST');
    await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await postFailure;

    expect(server.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0 });
    expect(ledger.snapshot().blockedRequestsByMethod).toMatchObject({ POST: 1, PUT: 1, PATCH: 1, DELETE: 1 });
    expect(ledger.snapshot().invariantViolations).toHaveLength(0);
  });

  it('blocks an external redirect follow-up but allows external image and script GET subresources', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin]));
    const page = await createGuardedPage(context);

    const redirectOutcome = await page.goto(`${primary.origin}/__external-redirect`)
      .then((response) => ({
        kind: 'RESOLVED' as const,
        status: response?.status(),
        url: response?.url(),
      }))
      .catch((error: unknown) => ({
        kind: 'REJECTED' as const,
        message: error instanceof Error ? error.message : String(error),
      }));
    expect({
      redirectOutcome,
      externalGet: external.getCounters().get,
      blockedNavigations: ledger.snapshot().blockedNavigations,
    }).toMatchObject({
      redirectOutcome: { kind: 'REJECTED' },
      externalGet: 0,
      blockedNavigations: [{
        method: 'GET',
        url: `${external.origin}/external-link.html`,
        reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
      }],
    });

    const renderPage = await createGuardedPage(context);
    await renderPage.goto(`${primary.origin}/index.html`);
    const rendered = await renderPage.evaluate(async (externalOrigin) => {
      const script = document.createElement('script');
      const scriptLoaded = new Promise<void>((resolve, reject) => {
        script.addEventListener('load', () => resolve(), { once: true });
        script.addEventListener('error', () => reject(new Error('external script failed')), { once: true });
      });
      script.src = `${externalOrigin}/external-script.js`;
      document.head.append(script);

      const image = new Image();
      const imageLoaded = new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error('external image failed')), { once: true });
      });
      image.src = `${externalOrigin}/external-image.svg`;
      document.body.append(image);

      await Promise.all([scriptLoaded, imageLoaded]);
      return {
        scriptLoaded: (globalThis as typeof globalThis & { fixtureExternalScriptLoaded?: boolean })
          .fixtureExternalScriptLoaded,
        imageWidth: image.naturalWidth,
      };
    }, external.origin);

    expect(rendered).toEqual({ scriptLoaded: true, imageWidth: 1 });
    expect(external.getCounters().get).toBe(2);
    expect(ledger.snapshot().invariantViolations).toHaveLength(0);
  });

  it('preserves credentials omission for an approved external subresource', async () => {
    const external = await startServer();
    const primary = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin]));
    await context.addCookies([{
      name: 'fixture-session',
      value: 'must-not-be-sent',
      url: external.origin,
    }]);
    const page = await createGuardedPage(context);
    await page.setContent('<!doctype html><title>Credential omission</title>');

    await page.evaluate(async (url) => {
      await fetch(url, { credentials: 'omit', mode: 'no-cors' });
    }, `${external.origin}/index.html`);

    expect(external.getCounters().get).toBe(1);
    expect(external.getRequestObservations()).toEqual([{
      method: 'GET',
      pathname: '/index.html',
      cookie: null,
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('snapshots allowed origins and blocks a direct external main-frame navigation', async () => {
    const external = await startServer();
    const primary = await startServer();
    const ledger = new SafetyLedger();
    const allowedOrigins = new Set([primary.origin]);
    const context = await createGuardedContext(ledger, allowedOrigins);
    allowedOrigins.add(external.origin);
    const page = await createGuardedPage(context);

    const outcome = await page.goto(`${external.origin}/external-link.html`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);

    expect({ outcome, externalGet: external.getCounters().get, snapshot: ledger.snapshot() }).toMatchObject({
      outcome: 'REJECTED',
      externalGet: 0,
      snapshot: {
        blockedNavigations: [{
          method: 'GET',
          url: `${external.origin}/external-link.html`,
          reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
        }],
      },
    });
  });

  it('fails closed when navigation starts before explicit page readiness', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin]));
    let pageFromEvent: Page | undefined;
    let navigation: Promise<unknown> | undefined;
    context.once('page', (page) => {
      pageFromEvent = page;
      navigation = page.goto(`${primary.origin}/__external-redirect`);
    });

    await context.newPage().catch(() => undefined);
    expect(navigation).toBeDefined();
    await expect(navigation).rejects.toThrow();

    expect(primary.getCounters().get).toBe(0);
    expect(external.getCounters().get).toBe(0);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'PASSIVE_GUARD_PAGE_NOT_READY',
      message: expect.stringContaining('before explicit page readiness'),
    }]));
    await expect(awaitPassiveRequestGuardReady(pageFromEvent as Page)).rejects.toThrow(/invalidated/i);
  });

  it('records a failed allowed main-frame delivery as an invariant', async () => {
    const server = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    await server.close();

    await expect(page.goto(`${server.origin}/index.html`)).rejects.toThrow();

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: expect.stringMatching(/ERR_CONNECTION_REFUSED|ERR_FAILED/),
    }]);
    await expect.poll(() => page.isClosed()).toBe(true);
  });

  it('blocks a multi-hop internal redirect before its external final hop', async () => {
    const external = await startServer();
    const middle = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const primary = await startServer({ externalRedirectUrl: `${middle.origin}/__external-redirect` });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin, middle.origin]));
    const page = await createGuardedPage(context);

    const outcome = await page.goto(`${primary.origin}/__external-redirect`)
      .then(() => 'RESOLVED' as const)
      .catch(() => 'REJECTED' as const);

    expect({
      outcome,
      primaryGet: primary.getCounters().get,
      middleGet: middle.getCounters().get,
      externalGet: external.getCounters().get,
      snapshot: ledger.snapshot(),
    }).toMatchObject({
      outcome: 'REJECTED',
      primaryGet: 1,
      middleGet: 1,
      externalGet: 0,
      snapshot: {
        blockedNavigations: [{
          method: 'GET',
          url: `${external.origin}/external-link.html`,
          reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
        }],
        invariantViolations: [],
      },
    });
  });

  it('allows an external nested-frame GET without granting main-frame authority', async () => {
    const external = await startServer();
    const primary = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin]));
    const page = await createGuardedPage(context);
    await page.setContent('<!doctype html><title>Nested frame host</title>');

    const framePromise = page.waitForEvent('framenavigated', (frame) => frame.url() === `${external.origin}/index.html`);
    await page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.append(frame);
    }, `${external.origin}/index.html`);
    const frame = await framePromise;

    expect(await frame.locator('h1').textContent()).toBe('Fixture Home');
    expect(external.getCounters().get).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('blocks a passive WebSocket before the fixture server receives an upgrade', async () => {
    const server = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    await page.goto(`${server.origin}/index.html`);
    const webSocketUrl = `${server.origin.replace(/^http/, 'ws')}/socket`;

    const result = await page.evaluate((url) => new Promise<'BLOCKED' | 'OPENED' | 'TIMEOUT'>((resolve) => {
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => resolve('TIMEOUT'), 2_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve('OPENED');
      }, { once: true });
      const blocked = (): void => {
        clearTimeout(timeout);
        resolve('BLOCKED');
      };
      socket.addEventListener('error', blocked, { once: true });
      socket.addEventListener('close', blocked, { once: true });
    }), webSocketUrl);

    expect(result).toBe('BLOCKED');
    expect(server.getCounters().webSocketUpgrade).toBe(0);
    await expect.poll(() => ledger.snapshot().blockedWebSockets).toEqual([{
      url: webSocketUrl,
      reason: 'PASSIVE_WEBSOCKET',
    }]);
    expect(ledger.snapshot().invariantViolations).toHaveLength(0);
  });
});
