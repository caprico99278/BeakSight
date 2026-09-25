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
  readonly cdpSendErrorMethod?: string;
  readonly contextCloseError?: Error;
  readonly contextCloseGate?: Promise<void>;
  readonly onContextClose?: () => void;
} = {}): GuardHarness {
  const calls: string[] = [];
  const cdpCommands: string[] = [];
  const cdpCommandLog: Array<{ readonly method: string; readonly params: unknown }> = [];
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
    async newCDPSession(): Promise<CDPSession> {
      calls.push('CDP');
      if (options.newCdpSessionError !== undefined) {
        throw options.newCdpSessionError;
      }
      const session = {
        on(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          if (event === 'Fetch.requestPaused') {
            cdpRequestPausedHandler = handler as (event: FakeCdpPausedEvent) => void;
          } else if (event === 'close') {
            cdpCloseHandler = handler;
          }
        },
        async send(method: string, params?: unknown): Promise<unknown> {
          cdpCommands.push(method);
          cdpCommandLog.push({ method, params });
          if (method === options.cdpSendErrorMethod) {
            throw new Error(`${method} failed`);
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
      closeCount += 1;
      options.onContextClose?.();
      await options.contextCloseGate;
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
    off(event: string, handler: () => void): Page {
      if (event === 'close') {
        closeHandlers.delete(handler);
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

function createHarnessRoute(
  page: Page,
  facts: { readonly method: string; readonly url: string; readonly navigation: boolean },
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
      abort: async () => { abortCalls += 1; },
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
    expect(harness.closeCount).toBe(1);
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

    expect(afterDrain.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
  });

  it('drains late evidence after failed frozen safety-invalidation close without closing twice', async () => {
    const harness = createGuardHarness({
      contextCloseError: new Error('invalidation close failed'),
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
    expect(closeSettled).toBe(false);

    cancelGate.reject(new Error('late cancel failed'));
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('failed invalidation did not drain pending task')), 500);
    });
    await Promise.race([closing, deadline]);
    const routed = createHarnessRoute(page, {
      method: 'GET', url: 'https://example.test/after-failed-invalidation-drain', navigation: true,
    });
    await harness.httpHandler?.(routed.route);

    expect(closeError).toMatchObject({ message: 'page close failed' });
    expect(harness.closeCount).toBe(1);
    expect(routed.abortCalls()).toBe(1);
    expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
    expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
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
    let reentrantSettled = false;
    let reentrantError: unknown;
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
        void Promise.resolve(handler(request)).catch((error: unknown) => {
          reentrantError = error;
        }).finally(() => {
          reentrantSettled = true;
        });
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
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(reentrantSettled).toBe(false);

    closeGate.resolve(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(reentrantSettled).toBe(false);
    cancelGate.resolve(undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('re-entrant invalidation waiter deadlocked')), 500);
    });
    await Promise.race([Promise.all([closing, new Promise<void>((resolve) => {
      const waitForReentrant = (): void => {
        if (reentrantSettled) {
          resolve();
          return;
        }
        setTimeout(waitForReentrant, 5);
      };
      waitForReentrant();
    })]), deadline]);

    expect(harness.closeCount).toBe(1);
    expect(closeError).toMatchObject({ message: 'page close failed' });
    expect(reentrantError).toBeUndefined();
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
    await closing;
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
    await closing;
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'INTERACTION_POPUP_CLOSE_FAILED',
      message: 'deferred popup close failed',
    }]));
  });

  it('bounds guarded context close while a listener task never settles', async () => {
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
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;

      expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
        code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
        message: 'Guard-owned listener tasks did not settle before cleanup deadline',
      }]));
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
          argument === undefined ? true : [rawCandidate]
        ),
        locator: () => ({
          nth: () => ({
            elementHandle: async () => ({
              evaluate: async () => ({ connected: true, raw: rawCandidate }),
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
      const discoveredCandidate = (await discoverInteractionCandidates(page))[0];
      if (discoveredCandidate === undefined) {
        throw new Error('audit guard harness candidate was not discovered');
      }
      candidate = discoveredCandidate;

      let auditSettled = false;
      const auditing = auditInteraction({
        sessionFactory: async () => ({
          page,
          ledger,
          activateInteractionFreeze: () => activateInteractionFreeze(page),
          close: () => closePassiveGuardedContext(harness.context),
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

  it('ledgers context close failure and invalidates without leaving stale owner intent', async () => {
    const harness = createGuardHarness({ contextCloseError: new Error('context close failed') });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow('context close failed');

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'GUARDED_CONTEXT_CLOSE_FAILED',
      message: 'context close failed',
    }]);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
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

  it('fails a paused Document after guarded page close rejects instead of continuing it', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { closeError: new Error('page close failed') });
    await awaitPassiveRequestGuardReady(page);
    await expect(closePassiveGuardedPage(page)).rejects.toThrow('page close failed');

    harness.cdpRequestPausedHandler?.({
      requestId: 'after-rejected-page-close',
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
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: 'page close failed',
    }]);
  });

  it.each(['in progress', 'complete'] as const)(
    'fails a paused Document after safety invalidation is %s instead of continuing it',
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

      harness.cdpRequestPausedHandler?.({
        requestId: `after-invalidation-${phase}`,
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
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_BLOCKED_BY_CLIENT',
    }]);
    expect(harness.closeCount).toBe(1);

    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations).toHaveLength(1);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/catalog',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
      { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
    ]);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    closeGate.resolve();
    await closing;
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

      expect(ledger.snapshot().invariantViolations).toEqual([{
        code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
        message: 'net::ERR_BLOCKED_BY_CLIENT',
      }]);
      expect(harness.closeCount).toBe(1);
    } finally {
      closeGate.resolve();
      await closing;
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

  it('fails closed once when guard-owned task admission exceeds 256', async () => {
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
    await expect.poll(() => cancelCalls).toBe(256);
    expect(ledger.snapshot().invariantViolations.filter(
      (event) => event.code === 'GUARD_TASK_LIMIT_REACHED',
    )).toHaveLength(1);
    expect(harness.closeCount).toBe(1);
    for (const gate of gates.slice(0, 256)) gate.resolve(undefined);
  });

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
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: 'https://example.test/unrelated',
      errorText: 'net::ERR_FAILED',
    });
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
    ]));
  });

  it('purges expired and consumed expected CDP failure correlations', async () => {
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
      expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
      ]));

      harness.cdpRequestPausedHandler?.({
        requestId: 'consumed-once',
        frameId: 'root-frame',
        request: { method: 'GET', url: 'https://example.test/consumed-once' },
      });
      await Promise.resolve();
      const before = ledger.snapshot().invariantViolations.length;
      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/consumed-once',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });
      expect(ledger.snapshot().invariantViolations).toHaveLength(before);
      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/consumed-once',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });
      expect(ledger.snapshot().invariantViolations.length).toBeGreaterThan(before);
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
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
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
