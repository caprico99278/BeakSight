import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, CDPSession, Download, Page, Request, Route, WebSocketRoute } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { INVALID_INTERCEPTION_ID_FAILURE_TEXTS } from '../../src/browser/playwright-errors.js';
import type { CachedResource } from '../../src/browser/resource-delivery.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { MAX_PENDING_GUARD_REQUEST_TASKS, MAX_URL_LENGTH } from '../../src/core/limits.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import { closePassivePageAndContext } from '../../src/orchestration/passive-session-close.js';
import {
  awaitPassiveRequestGuardReady,
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT,
  WORKER_CONNECT_POLICY,
  WORKER_CONNECT_POLICY_INIT_SCRIPT,
  workerConnectPolicyViolationUrl,
  type GuardResourceDelivery,
  type PassiveRequestGuardOptions,
} from '../../src/safety/passive-request-guard.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium, useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS, NO_NON_READ_REQUESTS, openServerWindow } from '../helpers/gate-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** Chromium がナビゲーションの失敗の後に表示するエラーのページの URL。 */
const CHROMIUM_ERROR_PAGE_URL = 'chrome-error://chromewebdata/';
const servers: FixtureServer[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser;

useHeadlessChromium((launched) => {
  browser = launched;
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

async function startServer(options?: Parameters<typeof startFixtureServer>[0]): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  servers.push(server);
  return server;
}

interface HangingServer {
  readonly origin: string;
  /** `/hang` へのリクエストをサーバが受け取るまで待つ。 */
  readonly hangReceived: Promise<void>;
  /** 受け取った `/hang` のソケットを、応答を送らずに切る。これ以後の `/hang`（Chromium の送り直しを含む）も、受け取ってすぐに切る。 */
  cutHang(): void;
  close(): Promise<void>;
}

const hangingServers: HangingServer[] = [];

/**
 * `/` に小さな HTML を返し、`/hang` には応答しないローカルのサーバ（DEF-004b）。
 * テストは、受け取った `/hang` のソケットを切ることで、ナビゲーションをネットワークの層の失敗で終わらせる。
 */
async function startHangingServer(): Promise<HangingServer> {
  let resolveHang: () => void = () => undefined;
  const hangReceived = new Promise<void>((resolve) => {
    resolveHang = resolve;
  });
  const pendingHangs: ServerResponse[] = [];
  let cut = false;
  const server = createServer((request, response) => {
    if (request.url === '/hang') {
      if (cut) {
        response.socket?.destroy();
        return;
      }
      pendingHangs.push(response);
      resolveHang();
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      response.end('<!doctype html><title>hang</title><h1>hang</h1>');
      return;
    }
    response.writeHead(404, { connection: 'close' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const hanging: HangingServer = {
    origin: `http://127.0.0.1:${port}`,
    hangReceived,
    cutHang: () => {
      cut = true;
      for (const response of pendingHangs.splice(0)) response.socket?.destroy();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  hangingServers.push(hanging);
  return hanging;
}

afterEach(async () => {
  await Promise.all(hangingServers.splice(0).map((server) => server.close()));
});

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
  /** Guard の `request` の事象の listener（C18a。外部スキームへの移動の検出）。 */
  readonly requestHandler: ((request: Request) => unknown) | undefined;
  readonly pageHandler: ((page: Page) => void) | undefined;
  readonly cdpRequestPausedHandler: ((event: FakeCdpPausedEvent) => void) | undefined;
  readonly cdpCloseHandler: (() => void) | undefined;
  /** Guard の page の session の `Network.loadingFailed` の listener（DEF-026。取り消しの証拠）。 */
  readonly cdpLoadingFailedHandler: ((event: FakeCdpLoadingFailedEvent) => void) | undefined;
  /** Guard の page の session の `Network.requestWillBeSent` の listener（DEF-027、DEF-042 の CORS の事前確認の判定）。 */
  readonly cdpRequestWillBeSentHandler: ((event: unknown) => void) | undefined;
  /** Guard の page の session の `Log.entryAdded` の listener（DEF-040。Worker の中の CSP の違反の観察）。 */
  readonly cdpLogEntryAddedHandler: ((event: unknown) => void) | undefined;
  registerPage(page: Page): void;
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
  /** Network の domain の要求の ID（DEF-026。取り消しの証拠の `Network.loadingFailed` の `requestId` と対応付ける）。 */
  readonly networkId?: string;
  readonly frameId: string;
  readonly request: { readonly method: string; readonly url: string; readonly headers?: Readonly<Record<string, string>> };
  /**
   * 要求の種類（DEF-042）。偽の harness の `cdpRequestPausedHandler` は、指定のない事象を `Document` の事象として Guard に渡す
   * （DEF-042 より前のテストは、Document の事象だけを送っていた）。Document でない要求のテストは、明示して渡す。
   */
  readonly resourceType?: string;
  /** 応答の段階（Response stage）の事象だけが持つ項目（C18g）。 */
  readonly responseStatusCode?: number;
  /** 応答の status の文言（DEF-040。`Fetch.continueResponse` の `responsePhrase` に使う）。 */
  readonly responseStatusText?: string;
  readonly responseErrorReason?: string;
  readonly responseHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** 偽の `Network.loadingFailed` の事象（DEF-026）。 */
interface FakeCdpLoadingFailedEvent {
  readonly requestId: string;
  readonly canceled?: boolean;
  /** 要求の種類（Network の domain の ResourceType。取り消しの証拠になるのは `Document` だけ）。 */
  readonly type?: string;
  readonly errorText?: string;
}

/** 偽の harness の `calls` に残す、Guard の初期化のスクリプトの名前（DEF-040、DEF-049）。 */
function initScriptName(content: string | undefined): string {
  if (content === WORKER_CONNECT_POLICY_INIT_SCRIPT) return 'WORKER_CONNECT_POLICY';
  if (content === SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT) return 'SERVICE_WORKER_REGISTRATION_BLOCK';
  return 'UNKNOWN';
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
  /**
   * 偽の page の session の `send` の差し替え（DEF-026）。Promise を返した命令は、その Promise を応答にする（失敗の注入、応答の保留）。
   * `undefined` を返した命令は、ほかの指定のとおりに扱う。
   */
  readonly cdpSendOverride?: (method: string, params: unknown) => Promise<unknown> | undefined;
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
  let requestHandler: GuardHarness['requestHandler'];
  let pageHandler: GuardHarness['pageHandler'];
  let cdpRequestPausedHandler: GuardHarness['cdpRequestPausedHandler'];
  let cdpCloseHandler: GuardHarness['cdpCloseHandler'];
  let cdpLoadingFailedHandler: GuardHarness['cdpLoadingFailedHandler'];
  let cdpRequestWillBeSentHandler: GuardHarness['cdpRequestWillBeSentHandler'];
  let cdpLogEntryAddedHandler: GuardHarness['cdpLogEntryAddedHandler'];
  const registeredPages: Page[] = [];
  const rawContext = {
    pages(): object[] {
      return options.hasPage === true ? [{}] : registeredPages;
    },
    // DEF-040: Guard は、ページを作る前に、Worker の中の WebSocket を止める CSP の初期化のスクリプトを Context に付ける。
    // DEF-049: Service Worker の登録の入口を塞ぐ初期化のスクリプトも付ける。どのスクリプトかを `calls` に残す。
    async addInitScript(script?: { readonly content?: string }): Promise<void> {
      calls.push(`INIT_SCRIPT:${initScriptName(script?.content)}`);
    },
    on(event: string, handler: (value: unknown) => void): void {
      calls.push(`ON:${event}`);
      if (event === 'requestfailed') {
        requestFailedHandler = handler as GuardHarness['requestFailedHandler'];
      } else if (event === 'request') {
        requestHandler = handler as GuardHarness['requestHandler'];
      } else if (event === 'page') {
        pageHandler = handler as (page: Page) => void;
      }
    },
    off(event: string, handler: (value: unknown) => void): void {
      removedListeners.push(`CONTEXT:${event}`);
      if (event === 'page' && pageHandler === handler) pageHandler = undefined;
      if (event === 'requestfailed' && requestFailedHandler === handler) requestFailedHandler = undefined;
      if (event === 'request' && requestHandler === handler) requestHandler = undefined;
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
          } else if (event === 'Network.loadingFailed') {
            cdpLoadingFailedHandler = handler as (event: FakeCdpLoadingFailedEvent) => void;
          } else if (event === 'Network.requestWillBeSent') {
            cdpRequestWillBeSentHandler = handler as (event: unknown) => void;
          } else if (event === 'Log.entryAdded') {
            cdpLogEntryAddedHandler = handler as (event: unknown) => void;
          }
        },
        off(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          removedListeners.push(`CDP:${event}`);
          if (event === 'Fetch.requestPaused' && cdpRequestPausedHandler === handler) {
            cdpRequestPausedHandler = undefined;
          }
          if (event === 'close' && cdpCloseHandler === handler) cdpCloseHandler = undefined;
          if (event === 'Network.loadingFailed' && cdpLoadingFailedHandler === handler) cdpLoadingFailedHandler = undefined;
          if (event === 'Log.entryAdded' && cdpLogEntryAddedHandler === handler) cdpLogEntryAddedHandler = undefined;
        },
        async send(method: string, params?: unknown): Promise<unknown> {
          cdpCommands.push(method);
          cdpCommandLog.push({ method, params });
          const overridden = options.cdpSendOverride?.(method, params);
          if (overridden !== undefined) {
            return overridden;
          }
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
    get requestHandler(): GuardHarness['requestHandler'] {
      return requestHandler;
    },
    get pageHandler(): GuardHarness['pageHandler'] {
      return pageHandler;
    },
    get cdpRequestPausedHandler(): GuardHarness['cdpRequestPausedHandler'] {
      // DEF-042: `resourceType` の指定のない偽の事象は、Document の事象として渡す（`FakeCdpPausedEvent.resourceType`）。
      const handler = cdpRequestPausedHandler;
      return handler === undefined ? undefined : (event) => handler({ resourceType: 'Document', ...event });
    },
    get cdpCloseHandler(): GuardHarness['cdpCloseHandler'] {
      return cdpCloseHandler;
    },
    get cdpLoadingFailedHandler(): GuardHarness['cdpLoadingFailedHandler'] {
      return cdpLoadingFailedHandler;
    },
    get cdpRequestWillBeSentHandler(): GuardHarness['cdpRequestWillBeSentHandler'] {
      return cdpRequestWillBeSentHandler;
    },
    get cdpLogEntryAddedHandler(): GuardHarness['cdpLogEntryAddedHandler'] {
      return cdpLogEntryAddedHandler;
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
      errorText: 'net::ERR_FAILED',
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
    await wait(0);
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
    await wait(20);
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
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(failure);
    harness.requestFailedHandler?.(failure);
    await expect.poll(() => harness.closeCount).toBe(1);
    closeGate.resolve(undefined);
    await wait(0);
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
          failure: () => ({ errorText: 'net::ERR_FAILED' }),
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
    await wait(20);
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

  it('V1: records and cancels a download started by the page during the passive phase', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    let cancelCalls = 0;
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/download-button.html',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);

    handlers.get('download')?.({
      url: () => 'https://example.test/__download',
      suggestedFilename: () => 'fixture-http.txt',
      cancel: async () => { cancelCalls += 1; },
    } as unknown as Download);
    await expect.poll(() => cancelCalls).toBe(1);

    expect(ledger.snapshot().blockedDownloads).toEqual([{
      url: 'https://example.test/__download',
      suggestedFilename: 'fixture-http.txt',
      reason: 'PASSIVE_DOWNLOAD',
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(() => assertPassiveRequestGuardActive(harness.context)).not.toThrow();
    await closePassiveGuardedContext(harness.context);
    expect(ledger.snapshot().blockedDownloads).toHaveLength(1);
  });

  it('V1: distinguishes passive and frozen downloads by reason in the same Ledger', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/download-button.html',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);

    handlers.get('download')?.({
      url: () => 'data:text/plain,passive', suggestedFilename: () => 'passive.txt', cancel: async () => undefined,
    } as unknown as Download);
    await activateInteractionFreeze(page);
    handlers.get('download')?.({
      url: () => 'data:text/plain,frozen', suggestedFilename: () => 'frozen.txt', cancel: async () => undefined,
    } as unknown as Download);

    expect(ledger.snapshot().blockedDownloads.map((event) => [event.suggestedFilename, event.reason])).toEqual([
      ['passive.txt', 'PASSIVE_DOWNLOAD'],
      ['frozen.txt', 'INTERACTION_FROZEN'],
    ]);
  });

  it('V1: treats a failed passive download cancel as an invariant violation and invalidates', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/download-button.html',
      onEvent: (event, handler) => handlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);

    handlers.get('download')?.({
      url: () => 'data:text/plain,passive-cancel',
      suggestedFilename: () => 'passive-cancel.txt',
      cancel: () => Promise.reject(new Error('passive cancel failed')),
    } as unknown as Download);
    await expect.poll(() => harness.closeCount).toBe(1);

    expect(ledger.snapshot().blockedDownloads).toEqual([
      expect.objectContaining({ reason: 'PASSIVE_DOWNLOAD' }),
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'PASSIVE_DOWNLOAD_CANCEL_FAILED',
      message: 'passive cancel failed',
    }]));
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow(/invalidated/i);
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

  it('installs the connect policy and the Service Worker registration block init scripts, then WebSocket and HTTP interception before resolving', async () => {
    const harness = createGuardHarness();

    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));

    // DEF-040: 初期化のスクリプト（meta の CSP）は、ページの事象を受け始める前（ページを作る前）に付ける。
    // DEF-049: Service Worker の登録の入口を塞ぐ初期化のスクリプトも、同じく、ページを作る前に付ける。
    expect(harness.calls).toEqual([
      'INIT_SCRIPT:WORKER_CONNECT_POLICY',
      'INIT_SCRIPT:SERVICE_WORKER_REGISTRATION_BLOCK',
      'ON:page',
      'ON:requestfailed',
      'ON:request',
      'WEBSOCKET',
      'HTTP',
    ]);
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
      'CONTEXT:request',
      'CDP:Fetch.requestPaused',
      'CDP:close',
    ]));
    expect(pageRemoved).toEqual(expect.arrayContaining(['download', 'popup', 'framenavigated']));
    expect(new Set(harness.removedListeners).size).toBe(harness.removedListeners.length);
    expect(new Set(pageRemoved).size).toBe(pageRemoved.length);
    expect(harness.pageHandler).toBeUndefined();
    expect(harness.requestFailedHandler).toBeUndefined();
    expect(harness.requestHandler).toBeUndefined();
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
      'CONTEXT:request',
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
    expect(harness.removedListeners).not.toContain('CONTEXT:request');
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

  // DEF-036（設計書 `2026-10-08-beaksight-def-036-frozen-popup-design.md` 2.1）: 凍結中のポップアップは、1回だけ記録し、Guard は
  // `page.close()` を呼ばない（Context と一緒に閉じる）。以前は、ポップアップをすぐに閉じ、その失敗を Context を閉じる前に drain する
  // ことを確かめていた（`INTERACTION_POPUP_CLOSE_FAILED`）。
  it('records a frozen popup once and leaves its close to the guarded context close (DEF-036)', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const openerHandlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, {
      url: 'https://example.test/fixture',
      onEvent: (event, handler) => openerHandlers.set(event, handler),
    });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    // `page` の事象は `createHarnessPage` の中で同期的に届き、以前の Guard は、閉じる処理を次の microtask で始めていた。
    // そのため、作った直後に差し替えた `close` で、Guard が呼んだかどうかを数えられる。
    let popupCloseCalls = 0;
    const popup = createHarnessPage(harness, { url: 'https://example.test/popup' });
    const popupClose = popup.close.bind(popup);
    Object.defineProperty(popup, 'close', {
      value: async (): Promise<void> => {
        popupCloseCalls += 1;
        await popupClose();
      },
    });
    openerHandlers.get('popup')?.(popup);
    await Promise.resolve();

    await closePassiveGuardedContext(harness.context);

    expect(harness.closeCount).toBe(1);
    expect(popupCloseCalls).toBe(0);
    expect(popup.isClosed()).toBe(false);
    expect(ledger.snapshot().blockedPopups).toEqual([{ url: 'https://example.test/popup', reason: 'INTERACTION_FROZEN' }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
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

  // DEF-036（設計書 `2026-10-08-beaksight-def-036-frozen-popup-design.md` 2.1）で、popup の場面の決まりを変えた。以前は、Guard が
  // 凍結中のポップアップをすぐに閉じ、その遅れた失敗（`INTERACTION_POPUP_CLOSE_FAILED`）が最終の snapshot に入ることを確かめていた。
  // 今は、Guard はポップアップを閉じない（記録だけ）ので、閉じる処理が呼ばれず、違反のない BLOCKED_BY_SAFETY になることを確かめる。
  it.each(['download', 'popup'] as const)(
    'reflects the frozen %s handling in the final interaction audit snapshot (download: drains a deferred cancel failure; popup: records without closing, DEF-036)',
    async (kind) => {
      const harness = createGuardHarness();
      const ledger = new SafetyLedger();
      const cleanupGate = createDeferred<void>();
      let popupCloseCalls = 0;
      const closeAuditPopup = (): Promise<void> => {
        popupCloseCalls += 1;
        return cleanupGate.promise;
      };
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
        // 本物の `inspectInteractionCandidateHandle` と同じく、対象自身の属性の記録も返す（F20b。設計書 4.4.1、4.4.2 手順4）。
        evaluate: async () => ({
          status: 'CONNECTED',
          domWorkUsed: 0,
          attributes: { complete: true, entries: [] },
          raw: rawCandidate,
        }),
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
            close: closeAuditPopup,
          } as unknown as Page);
        },
        scrollIntoViewIfNeeded: async () => undefined,
        hover: async () => undefined,
        // F16（設計書 4.4.1）: 凍結の前の下準備で、hover の後に focus する。
        focus: async () => undefined,
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
        // DEF-036: popup の場面で違反が0件であることを確かめるため、Guard の listener の後始末（`page.off`）を受け付ける。
        off(): Page {
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
              evaluate: async () => ({
                status: 'CONNECTED',
                domWorkUsed: 0,
                attributes: { complete: true, entries: [] },
                raw: rawCandidate,
              }),
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
                  close: closeAuditPopup,
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
        navigationTimeoutMs: 5_000,
        timeoutMs: 2_000,
        deadlineAtMs: Date.now() + 5_000,
      }).finally(() => {
        auditSettled = true;
      });
      await expect.poll(() => harness.closeCount).toBe(1);

      if (kind === 'popup') {
        const result = await auditing;

        expect(result.status).toBe('BLOCKED_BY_SAFETY');
        expect(result.safety.blockedPopups).toEqual([
          { url: 'https://example.test/audit-popup', reason: 'INTERACTION_FROZEN' },
        ]);
        expect(result.safety.invariantViolations).toEqual([]);
        expect(popupCloseCalls).toBe(0);
        return;
      }

      expect(auditSettled).toBe(false);

      cleanupGate.reject(new Error(`deferred ${kind} cleanup failed`));
      const result = await auditing;

      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.safety.invariantViolations).toContainEqual({
        code: 'INTERACTION_DOWNLOAD_CANCEL_FAILED',
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
          method: 'GET', url: 'https://example.test/re-entry', errorText: 'net::ERR_FAILED',
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
        failure: () => ({ errorText: 'net::ERR_FAILED' }),
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
        message: 'net::ERR_FAILED',
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
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    } as unknown as Request;

    harness.requestFailedHandler?.(failedAllowedRequest);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_FAILED',
    }]);
  });

  // DEF-004: 閉じた一覧に載るネットワークの層の失敗は、許可した読み取りのメインフレームのナビゲーションに限って違反にしない。
  // 対照として、あとから一覧にない失敗を起こし、それだけが違反として記録されることを確かめる（先の失敗の処理が終わっていることの確認を兼ねる）。
  it.each([
    { method: 'GET', errorText: 'net::ERR_CONNECTION_REFUSED' },
    { method: 'GET', errorText: 'net::ERR_CONNECTION_RESET' },
    { method: 'GET', errorText: 'net::ERR_NAME_NOT_RESOLVED' },
    { method: 'GET', errorText: 'net::ERR_SSL_PROTOCOL_ERROR' },
    { method: 'GET', errorText: 'net::ERR_CERT_AUTHORITY_INVALID' },
    { method: 'head', errorText: 'net::ERR_TIMED_OUT' },
  ])('does not record listed network-layer failure $errorText of an allowed $method main-frame navigation', async ({ method, errorText }) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);

    emitFailedMainFrameRequest(harness, page, { method, url: 'https://example.test/network-layer', errorText });
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET', url: 'https://example.test/control', errorText: 'net::ERR_FAILED',
    });

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_FAILED',
    }]);
    await expect.poll(() => harness.closeCount).toBe(1);
  });

  it.each([
    'net::ERR_FAILED',
    'net::ERR_ABORTED',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_BLOCKED_BY_RESPONSE',
    'net::ERR_UNSAFE_REDIRECT',
    'net::ERR_UNSAFE_PORT',
    'net::ERR_INVALID_RESPONSE',
    'net::ERR_INVALID_REDIRECT',
    'net::ERR_SSL_',
    'ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_REFUSED ',
  ])('still records unlisted failure %j of an allowed main-frame navigation as an invariant', async (errorText) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);

    emitFailedMainFrameRequest(harness, page, { method: 'GET', url: 'https://example.test/unlisted', errorText });

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: errorText,
    }]);
    await expect.poll(() => harness.closeCount).toBe(1);
  });

  it('still records a listed failure without a bounded correlation request as an invariant', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);

    emitFailedMainFrameRequest(harness, page, {
      method: 'GET',
      url: `https://example.test/${'a'.repeat(MAX_URL_LENGTH)}`,
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_CONNECTION_REFUSED',
    }]);
    await expect.poll(() => harness.closeCount).toBe(1);
  });

  // DEF-004b: 違反から外すのは、凍結中でない場合に限る。凍結中は、一覧に載る失敗でも、これまでどおり違反とする（fail-closed）。
  it.each([
    { method: 'GET', errorText: 'net::ERR_CONNECTION_REFUSED' },
    { method: 'GET', errorText: 'net::ERR_EMPTY_RESPONSE' },
    { method: 'GET', errorText: 'net::ERR_SSL_PROTOCOL_ERROR' },
    { method: 'HEAD', errorText: 'net::ERR_NAME_NOT_RESOLVED' },
  ])('still records listed network-layer failure $errorText of an allowed $method main-frame navigation during interaction freeze', async ({ method, errorText }) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);

    emitFailedMainFrameRequest(harness, page, { method, url: 'https://example.test/network-layer', errorText });

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: errorText,
    }]);
    await expect.poll(() => harness.closeCount).toBe(1);
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
      await wait(0);
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
      await wait(20);
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
      await wait(20);
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
    // C18i（RC18b の N1）: 別のプロセスの iframe（OOPIF）に自動で session を付ける設定も、page の横取りの準備の一部である。
    // 付けられなければ、OOPIF の中の移動を横取りできないので、page の準備の失敗として Context を閉じる（fail-closed）。
    {
      stage: 'Target.setAutoAttach',
      options: { cdpSendErrorMethod: 'Target.setAutoAttach' },
      message: 'Target.setAutoAttach failed',
    },
    // DEF-040: Worker の中の CSP の違反の観察（`Log.enable`）も、page の準備の一部である（記録は best-effort だが、準備は fail-closed）。
    {
      stage: 'Log.enable',
      options: { cdpSendErrorMethod: 'Log.enable' },
      message: 'Log.enable failed',
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
    // DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md` 2.1、2.4）: 印のない page の close は、今のとおり違反になり、
    // Context が閉じる。違反のコードは、Guard の page の session が外れたことの `CDP_SESSION_DETACHED` である。読み込みの取り消し
    // （`net::ERR_ABORTED`）は、Guard の証拠（許可して進めた要求が、応答を受けずに取り消された）がそろうので、
    // `HTTP_MAIN_FRAME_DELIVERY_FAILED` にならない。Guard が証拠を待つ時間の後に記録される違反も見逃さないよう、その2倍待ってから確かめる。
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'CDP_SESSION_DETACHED',
      message: 'Document interception session detached while its page remained active',
    }]));
    const { CANCELED_DOCUMENT_EVIDENCE_WAIT_MS } = await import('../../src/safety/passive-request-guard.js');
    await wait(CANCELED_DOCUMENT_EVIDENCE_WAIT_MS * 2);
    expect(ledger.snapshot().invariantViolations).not.toContainEqual(expect.objectContaining({
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
    }));
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

  // DEF-004: 許可した GET のメインフレームのナビゲーションが、閉じた一覧に載るネットワークの層の失敗で終わっても、
  // Guard の違反にはならず、Context も無効にならない。後続の許可したナビゲーションが通ることで、Guard が生きていることを確かめる。
  it('does not record a network-layer failure of an allowed main-frame GET as an invariant (connection refused)', async () => {
    const closed = await startServer();
    const live = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([closed.origin, live.origin]));
    const page = await createGuardedPage(context);
    await closed.close();

    await expect(page.goto(`${closed.origin}/index.html`)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    // Chromium は失敗の後にエラーのページを読み込む。その読み込みが終わってから、次のナビゲーションを始める。
    await expect.poll(() => page.url()).toBe(CHROMIUM_ERROR_PAGE_URL);
    const response = await page.goto(`${live.origin}/index.html`);

    expect(response?.status()).toBe(200);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(page.isClosed()).toBe(false);
    expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  });

  it('does not record a network-layer failure of an allowed main-frame GET as an invariant (name not resolved)', async () => {
    // RFC 2606 で予約された .invalid のドメインは、名前解決に必ず失敗する。
    const unresolvableOrigin = 'http://beaksight-nonexistent.invalid';
    const live = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([unresolvableOrigin, live.origin]));
    const page = await createGuardedPage(context);

    await expect(page.goto(`${unresolvableOrigin}/`)).rejects.toThrow(/ERR_NAME_(?:NOT_RESOLVED|RESOLUTION_FAILED)/);
    await expect.poll(() => page.url()).toBe(CHROMIUM_ERROR_PAGE_URL);
    const response = await page.goto(`${live.origin}/index.html`);

    expect(response?.status()).toBe(200);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(page.isClosed()).toBe(false);
    expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  });

  it('records an unlisted failure (net::ERR_FAILED) of an allowed main-frame GET as an invariant', async () => {
    const server = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    // ページの route は、Guard の Context の route より先に動く。Guard が中断したものではない失敗を起こす。
    await page.route(`${server.origin}/index.html`, (route) => route.abort('failed'));

    await expect(page.goto(`${server.origin}/index.html`)).rejects.toThrow();

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: 'net::ERR_FAILED',
    }]);
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(() => assertPassiveRequestGuardActive(context)).toThrow(/invalidated/i);
  });

  // DEF-004b（RDEF4 Minor-1）: 許可した GET のメインフレームのナビゲーションを、サーバが受け取った後にソケットを切って失敗させる。
  // 凍結の前（Passive）は違反にならず、凍結中は違反として記録して Context を無効にする。
  // ソケットを切った失敗は、Chromium では net::ERR_EMPTY_RESPONSE になる（一覧に載る接続の失敗も許す）。
  const LISTED_SOCKET_CLOSE_FAILURE = /^net::ERR_(?:EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED)$/u;

  function waitForHangFailure(page: Page, origin: string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      page.on('requestfailed', (request) => {
        if (request.url() === `${origin}/hang`) resolve(request.failure()?.errorText);
      });
    });
  }

  it('does not record a listed network-layer failure of an allowed main-frame GET before interaction freeze', async () => {
    const server = await startHangingServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const hangFailure = waitForHangFailure(page, server.origin);
    expect((await page.goto(`${server.origin}/`))?.status()).toBe(200);

    await page.evaluate(() => { location.href = '/hang'; });
    await server.hangReceived;
    server.cutHang();

    expect(await hangFailure).toMatch(LISTED_SOCKET_CLOSE_FAILURE);
    await expect.poll(() => page.url()).toBe(CHROMIUM_ERROR_PAGE_URL);
    const response = await page.goto(`${server.origin}/`);

    expect(response?.status()).toBe(200);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(page.isClosed()).toBe(false);
    expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  });

  it('records a listed network-layer failure of an allowed main-frame GET during interaction freeze and invalidates', async () => {
    const server = await startHangingServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    const hangFailure = waitForHangFailure(page, server.origin);
    expect((await page.goto(`${server.origin}/`))?.status()).toBe(200);

    await page.evaluate(() => { location.href = '/hang'; });
    await server.hangReceived;
    await activateInteractionFreeze(page);
    server.cutHang();

    expect(await hangFailure).toMatch(LISTED_SOCKET_CLOSE_FAILURE);
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
      code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      message: expect.stringMatching(LISTED_SOCKET_CLOSE_FAILURE),
    }]);
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(() => assertPassiveRequestGuardActive(context)).toThrow(/invalidated/i);
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

// C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: 外部スキームへの移動の検出（`request` の事象）。
// R7d（中断した Run の再開の設計書 4.10）: ページのスクリプトによる外部スキームへの移動は、headed と headless を問わず、安全の
// 不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）として記録し、Context を閉じる。移動の試みの記録も、今のとおり残す。
// Guard は、headed かどうかを受け取らない（型でも、実行時でも）。
// 本物の Chromium での経路ごとの確認は、`tests/integration/external-scheme-navigation.test.ts` で行う（headless だけ）。
describe('C18a: external scheme navigation detection', () => {
  /** `request` の事象に渡す、偽の Playwright の Request。`frame` を省くと、frame ができる前のリクエスト（`window.open`）にする。 */
  function fakeRequest(facts: {
    readonly url: string;
    readonly navigation?: boolean;
    readonly frame?: 'MAIN' | 'SUB';
  }): Request {
    const parent = { parentFrame: () => null };
    return {
      method: () => 'GET',
      url: () => facts.url,
      isNavigationRequest: () => facts.navigation ?? true,
      frame(): unknown {
        if (facts.frame === undefined) {
          throw new Error('Frame for this navigation request is not available');
        }
        return { parentFrame: () => (facts.frame === 'MAIN' ? null : parent) };
      },
    } as unknown as Request;
  }

  /** 外部スキームへの移動の試みの、不変条件の違反（R7d。中断した Run の再開の設計書 4.10）。 */
  const attemptedViolation = (scheme: string): { readonly code: string; readonly message: string } => ({
    code: 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED',
    message: `Navigation to the external scheme ${scheme} was attempted; the browser may have launched an external application`,
  });

  it('installs the request listener and detaches it on close', async () => {
    const harness = createGuardHarness();
    await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set(['https://example.test']));

    expect(harness.requestHandler).toBeTypeOf('function');
    await closePassiveGuardedContext(harness.context);
    expect(harness.requestHandler).toBeUndefined();
  });

  it.each([
    ['tel:+10000000000', 'tel', 'MAIN'],
    ['mailto:nobody@example.invalid', 'mailto', 'MAIN'],
    ['beaksight-test-app:probe', 'beaksight-test-app', 'SUB'],
  ] as const)('records a Passive navigation to %s, records the violation, and closes the Context through the invalidation path', async (
    url,
    scheme,
    frame,
  ) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.requestHandler?.(fakeRequest({ url, frame }));

    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([
      { url, scheme, frame, phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([attemptedViolation(scheme)]);
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);
  });

  it('records the Interaction phase after the freeze, records the violation, and closes the Context', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { url: 'https://example.test/frozen-owner' });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);

    harness.requestHandler?.(fakeRequest({ url: 'tel:+10000000000', frame: 'MAIN' }));

    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([
      { url: 'tel:+10000000000', scheme: 'tel', frame: 'MAIN', phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([attemptedViolation('tel')]);
  });

  it.each([
    ['https://example.test/next', true],
    ['http://external.test/', true],
    ['about:blank', true],
    ['about:srcdoc', true],
    ['data:text/html,ok', true],
    ['blob:https://example.test/0b8c7d2e-0000-4000-8000-000000000000', true],
    ['tel:+10000000000', false],
  ] as const)('does not record %s (navigation: %s)', async (url, navigation) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.requestHandler?.(fakeRequest({ url, navigation, frame: 'MAIN' }));

    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it.each([
    ['beaksight-test-app:probe', 'beaksight-test-app'],
    ['tel:+10000000000', 'tel'],
  ] as const)('keeps FRAME_CLASSIFICATION_FAILED when the frame of %s is not available, adds the violation, and fails closed', async (
    url,
    scheme,
  ) => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.requestHandler?.(fakeRequest({ url }));

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([
      attemptedViolation(scheme),
      { code: 'FRAME_CLASSIFICATION_FAILED', message: 'Frame for this navigation request is not available' },
    ]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
  });

  it('fails closed when the detection itself throws', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.requestHandler?.({
      isNavigationRequest(): never {
        throw new Error('request inspection failed');
      },
    } as unknown as Request);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'EXTERNAL_SCHEME_DETECTION_FAILED',
      message: 'request inspection failed',
    }]);
  });

  it('fails closed on a request URL that cannot be parsed', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.requestHandler?.(fakeRequest({ url: 'not a url', frame: 'MAIN' }));

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations.map(({ code }) => code)).toEqual(['EXTERNAL_SCHEME_DETECTION_FAILED']);
  });

  // R7d: Guard は `headed` を受け取らない。取り付けの指定は省略でき、`headed` は型で受け付けない。実行時に `headed` の値が
  // 紛れ込んでも、外部スキームへの移動の扱いは変わらない（違反として Context を閉じる）。
  it('installs without options and without a headed flag, without a violation', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();

    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    expect(harness.requestHandler).toBeTypeOf('function');
    expect(harness.closeCount).toBe(0);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
  });

  it('does not accept headed in the type of the options, and ignores a headed value given at run time', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    // @ts-expect-error R7d: Guard の取り付けの指定は `headed` を持たない（中断した Run の再開の設計書 4.10）。
    const options: PassiveRequestGuardOptions = { headed: false };

    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']), options);
    await readyHarnessPage(harness);
    harness.requestHandler?.(fakeRequest({ url: 'tel:+10000000000', frame: 'MAIN' }));

    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([attemptedViolation('tel')]);
  });
});

// C18g（RC18a の指摘1・3。Task 19 の前の整理の設計書 4.2「サーバのリダイレクトは、たどる前に止める」）: Guard は、Document の
// 応答の段階（CDP の Fetch の Response stage）で 3xx の Location を調べる。Location（相対の URL は、元のリクエストの URL を基準に
// 解決する）が外部スキームなら、リダイレクトをたどる前にリクエストを失敗させ、`externalSchemeNavigations` に
// `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する。止めて防げる経路なので、違反にしない（ページのスクリプトによる移動は違反にする
// のと違う。中断した Run の再開の設計書 4.10）。
// 本物の Chromium での確認は、`tests/integration/external-scheme-navigation.test.ts` と GATE-S03 で行う（headless だけ）。
describe('C18g: server redirects to an external scheme are stopped at the Document response stage', () => {
  /** 応答の段階の、偽の `Fetch.requestPaused` の事象。 */
  function responseEvent(facts: {
    readonly requestId?: string;
    readonly frameId?: string;
    readonly url?: string;
    readonly status?: number;
    readonly errorReason?: string;
    readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }): FakeCdpPausedEvent {
    return {
      requestId: facts.requestId ?? 'redirect-response',
      frameId: facts.frameId ?? 'child-frame',
      request: { method: 'GET', url: facts.url ?? 'https://example.test/redirect/source' },
      ...(facts.status === undefined ? {} : { responseStatusCode: facts.status }),
      ...(facts.errorReason === undefined ? {} : { responseErrorReason: facts.errorReason }),
      responseHeaders: facts.headers ?? [],
    };
  }

  const commandsOf = (harness: GuardHarness, method: string): ReadonlyArray<{ readonly method: string; readonly params: unknown }> =>
    harness.cdpCommandLog.filter((entry) => entry.method === method);

  const failed = (requestId: string): { readonly method: string; readonly params: unknown } => ({
    method: 'Fetch.failRequest',
    params: { requestId, errorReason: 'BlockedByClient' },
  });

  async function readyGuard(): Promise<{
    readonly harness: GuardHarness;
    readonly ledger: SafetyLedger;
    readonly page: Page;
  }> {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    return { harness, ledger, page };
  }

  it('enables the Document interception at the Response stage in addition to the Request stage, every request at the Request stage (DEF-042), and the Other responses (DEF-040)', async () => {
    const { harness } = await readyGuard();

    expect(commandsOf(harness, 'Fetch.enable')).toEqual([{
      method: 'Fetch.enable',
      params: {
        patterns: [
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
          { urlPattern: '*', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Other', requestStage: 'Response' },
        ],
      },
    }]);
  });

  it.each([
    ['tel:+10000000000', 'tel', 302, 'child-frame', 'SUB'],
    ['mailto:nobody@example.invalid', 'mailto', 301, 'root-frame', 'MAIN'],
    ['beaksight-test-app:probe', 'beaksight-test-app', 307, 'child-frame', 'SUB'],
  ] as const)('fails the redirect to %s before it is followed and records it as EXTERNAL_SCHEME_REDIRECT_BLOCKED', async (
    location,
    scheme,
    status,
    frameId,
    frame,
  ) => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({ frameId, status, headers: [{ name: 'Location', value: location }] }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([
      { url: location, scheme, frame, phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it('does not make a stopped redirect a violation, and matches the Location header name case-insensitively', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({
      status: 308,
      headers: [{ name: 'content-length', value: '0' }, { name: 'LOCATION', value: 'mailto:nobody@example.invalid' }],
    }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([{
      url: 'mailto:nobody@example.invalid',
      scheme: 'mailto',
      frame: 'SUB',
      phase: 'PASSIVE',
      reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it('stops the redirect when any of several Location headers is an external scheme', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({
      status: 302,
      headers: [{ name: 'Location', value: '/next' }, { name: 'location', value: 'tel:+10000000000' }],
    }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([
      { url: 'tel:+10000000000', scheme: 'tel', frame: 'SUB', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED' },
    ]);
  });

  it.each([
    ['a relative path', 302, [{ name: 'Location', value: '/next' }]],
    ['a scheme-relative URL', 302, [{ name: 'Location', value: '//other.example.test/next' }]],
    ['a relative path that looks like a scheme-less name', 303, [{ name: 'Location', value: 'tel' }]],
    ['an absolute http URL', 301, [{ name: 'Location', value: 'http://example.test/next' }]],
    ['an about:blank URL', 302, [{ name: 'Location', value: 'about:blank' }]],
    ['a 3xx without a Location', 304, []],
    ['a 200 response', 200, [{ name: 'Content-Type', value: 'text/html' }]],
    ['a 200 response with a Location header', 200, [{ name: 'Location', value: 'tel:+10000000000' }]],
    ['a 404 response', 404, []],
  ] as const)('continues the response with %s, without a record or a violation', async (_name, status, headers) => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({ status, headers }));

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'redirect-response' } },
    ]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('continues a response-stage network error without a record', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({ errorReason: 'ConnectionRefused' }));

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'redirect-response' } },
    ]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('fails closed on a Location that cannot be parsed: the request fails, a violation is recorded, and the Context closes', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(responseEvent({ status: 302, headers: [{ name: 'Location', value: 'http://[' }] }));

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations.map(({ code }) => code)).toEqual(['EXTERNAL_SCHEME_DETECTION_FAILED']);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
  });

  // C18g の追加（RC18a の指摘3。設計者の判断）: Guard 自身が外部スキームへのリダイレクトとして止めた main frame のリクエストの失敗は、
  // 予期した失敗であり、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。緩めるのは、止めたそのリクエストの失敗（1回）だけである。
  describe('the main frame failure of a redirect that the Guard itself stopped', () => {
    const SOURCE_URL = 'https://example.test/redirect/source';

    async function stopMainFrameRedirect(): Promise<{
      readonly harness: GuardHarness;
      readonly ledger: SafetyLedger;
      readonly page: Page;
    }> {
      const ready = await readyGuard();
      ready.harness.cdpRequestPausedHandler?.(responseEvent({
        frameId: 'root-frame',
        url: SOURCE_URL,
        status: 302,
        headers: [{ name: 'Location', value: 'tel:+10000000000' }],
      }));
      await expect.poll(() => commandsOf(ready.harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
      return ready;
    }

    it('is not a violation: the record stays and the Context stays open', async () => {
      const { harness, ledger, page } = await stopMainFrameRedirect();

      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
      await flushGuardProtocolCallbacks();
      await wait(10);

      expect(ledger.snapshot().externalSchemeNavigations).toEqual([{
        url: 'tel:+10000000000',
        scheme: 'tel',
        frame: 'MAIN',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
      }]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(harness.closeCount).toBe(0);
    });

    it('keeps the violation for a main frame failure of another URL (control)', async () => {
      const { harness, ledger, page } = await stopMainFrameRedirect();

      emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: 'https://example.test/another-page',
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      });

      await expect.poll(() => harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
      ]);
    });

    it('keeps the violation for a main frame failure of the same URL with another reason (control)', async () => {
      const { harness, ledger, page } = await stopMainFrameRedirect();

      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_ABORTED' });

      await expect.poll(() => harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_ABORTED' },
      ]);
    });

    it('excuses the stopped request only once: a second failure of the same request is a violation', async () => {
      const { harness, ledger, page } = await stopMainFrameRedirect();

      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
      await flushGuardProtocolCallbacks();
      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });

      await expect.poll(() => harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
      ]);
    });

    it('does not excuse a main frame failure after a stopped subframe redirect of the same URL (control)', async () => {
      const { harness, ledger, page } = await readyGuard();
      harness.cdpRequestPausedHandler?.(responseEvent({
        frameId: 'child-frame',
        url: SOURCE_URL,
        status: 302,
        headers: [{ name: 'Location', value: 'tel:+10000000000' }],
      }));
      await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);

      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });

      await expect.poll(() => harness.closeCount).toBe(1);
      expect(ledger.snapshot().invariantViolations).toEqual([
        { code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_BLOCKED_BY_CLIENT' },
      ]);
    });

    it('keeps both violations when the main frame redirect cannot be failed', async () => {
      const closeGate = createDeferred<void>();
      const harness = createGuardHarness({ cdpSendErrorMethod: 'Fetch.failRequest', contextCloseGate: closeGate.promise });
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
      const page = await readyHarnessPage(harness);

      harness.cdpRequestPausedHandler?.(responseEvent({
        frameId: 'root-frame',
        url: SOURCE_URL,
        status: 302,
        headers: [{ name: 'Location', value: 'tel:+10000000000' }],
      }));
      await expect.poll(() => harness.closeCount).toBe(1);
      emitFailedMainFrameRequest(harness, page, { method: 'GET', url: SOURCE_URL, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
      await expect.poll(() => ledger.snapshot().invariantViolations.map(({ code }) => code)).toEqual([
        'CDP_FAIL_REQUEST_FAILED',
        'HTTP_MAIN_FRAME_DELIVERY_FAILED',
      ]);
      closeGate.resolve();
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    });
  });

  it('fails closed when the external scheme redirect cannot be failed, without recording it as stopped', async () => {
    const harness = createGuardHarness({ cdpSendErrorMethod: 'Fetch.failRequest' });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);

    harness.cdpRequestPausedHandler?.(responseEvent({ status: 302, headers: [{ name: 'Location', value: 'tel:+10000000000' }] }));

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'CDP_FAIL_REQUEST_FAILED',
      message: 'Fetch.failRequest failed',
    }]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
  });

  it('records the Interaction phase for an external scheme redirect response that arrives after the freeze', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { url: 'https://example.test/frozen-owner' });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(responseEvent({
      frameId: 'root-frame',
      status: 302,
      headers: [{ name: 'Location', value: 'beaksight-test-app:probe' }],
    }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([{
      url: 'beaksight-test-app:probe',
      scheme: 'beaksight-test-app',
      frame: 'MAIN',
      phase: 'INTERACTION',
      reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('continues an ordinary response that arrives after the freeze (the Request stage keeps INTERACTION_FROZEN)', async () => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = createHarnessPage(harness, { url: 'https://example.test/frozen-owner' });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(responseEvent({ frameId: 'root-frame', status: 200 }));

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'redirect-response' } },
    ]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
    expect(ledger.snapshot().blockedInteractionNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('keeps the Request-stage redirect correlation: a followed same-origin redirect is still continued without a violation', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.({
      requestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/predecessor' },
    });
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.(responseEvent({
      requestId: 'predecessor',
      frameId: 'root-frame',
      url: 'https://example.test/predecessor',
      status: 302,
      headers: [{ name: 'Location', value: '/redirect-current' }],
    }));
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.({
      requestId: 'redirect-current',
      redirectedRequestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/redirect-current' },
    });

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'predecessor' } },
      { method: 'Fetch.continueRequest', params: { requestId: 'predecessor' } },
      { method: 'Fetch.continueRequest', params: { requestId: 'redirect-current' } },
    ]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('keeps the existing Request-stage block of a redirect to a disallowed origin in the main frame', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.({
      requestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/predecessor' },
    });
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.(responseEvent({
      requestId: 'predecessor',
      frameId: 'root-frame',
      url: 'https://example.test/predecessor',
      status: 302,
      headers: [{ name: 'Location', value: 'https://outside.example.test/' }],
    }));
    await Promise.resolve();
    harness.cdpRequestPausedHandler?.({
      requestId: 'redirect-current',
      redirectedRequestId: 'predecessor',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://outside.example.test/' },
    });

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-current')]);
    expect(ledger.snapshot().blockedNavigations).toEqual([
      { method: 'GET', url: 'https://outside.example.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
    ]);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('fails a response that arrives while the Context is closing, without a record', async () => {
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    await readyHarnessPage(harness);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(responseEvent({ status: 302, headers: [{ name: 'Location', value: 'tel:+10000000000' }] }));
    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('redirect-response')]);

    closeGate.resolve();
    await closing;
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });
});

// C18h（DEF-013。Task 19 の前の整理の設計書 4.6）: リダイレクトの対応付けの期限を、リクエストの開始からではなく、
// リダイレクトの応答（3xx）を受けた時点から数える。元のリクエストが終わったとき（完了か失敗）に登録を消し、件数の上限を超えた
// 場合と、対応付けが見つからない場合は、これまでどおり違反にする（fail-closed）。
describe('C18h: the redirect correlation is counted from the 3xx response and forgotten when the request ends', () => {
  const ORIGIN = 'https://example.test';
  /** 対応付けの保持の時間（1,000ms）を超える、遅いリダイレクトの応答の時間（ms。fixture の `/__slow-redirect` と同じ）。 */
  const SLOW_RESPONSE_MS = 1_500;
  /** 対応付けの保持の時間（1,000ms）を、ちょうど超える時間（ms）。 */
  const PAST_RETENTION_MS = 1_001;
  /** リダイレクトの対応付けの件数の上限（Guard の `MAX_REDIRECT_PREDECESSORS`）。 */
  const PREDECESSOR_LIMIT = 64;

  /** リクエストの段階の、偽の `Fetch.requestPaused` の事象。 */
  function requestEvent(requestId: string, path: string, redirectedRequestId?: string): FakeCdpPausedEvent {
    return {
      requestId,
      ...(redirectedRequestId === undefined ? {} : { redirectedRequestId }),
      frameId: 'root-frame',
      request: { method: 'GET', url: `${ORIGIN}${path}` },
    };
  }

  /** 応答の段階の、偽の `Fetch.requestPaused` の事象。 */
  function responseEvent(requestId: string, path: string, facts: {
    readonly status?: number;
    readonly errorReason?: string;
    readonly location?: string;
  }): FakeCdpPausedEvent {
    return {
      ...requestEvent(requestId, path),
      ...(facts.status === undefined ? {} : { responseStatusCode: facts.status }),
      ...(facts.errorReason === undefined ? {} : { responseErrorReason: facts.errorReason }),
      responseHeaders: facts.location === undefined ? [] : [{ name: 'Location', value: facts.location }],
    };
  }

  const requestIdsOf = (harness: GuardHarness, method: string): unknown[] =>
    harness.cdpCommandLog
      .filter((entry) => entry.method === method)
      .map((entry) => (entry.params as { readonly requestId: string }).requestId);

  const missingPredecessor = Object.freeze({
    code: 'REDIRECT_PREDECESSOR_MISSING',
    message: 'Supplied redirect predecessor was unavailable',
  });

  async function readyGuard(): Promise<{ readonly harness: GuardHarness; readonly ledger: SafetyLedger; readonly page: Page }> {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = await readyHarnessPage(harness);
    return { harness, ledger, page };
  }

  /** 偽の CDP の事象を渡し、Guard の処理が終わるまで（偽の時計のまま）進める。 */
  async function emit(harness: GuardHarness, event: FakeCdpPausedEvent): Promise<void> {
    harness.cdpRequestPausedHandler?.(event);
    await vi.advanceTimersByTimeAsync(0);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a redirect whose 3xx response arrives later than the retention after the request started', async () => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    await emit(harness, requestEvent('slow', '/slow'));
    await vi.advanceTimersByTimeAsync(SLOW_RESPONSE_MS);
    await emit(harness, responseEvent('slow', '/slow', { status: 302, location: '/target' }));
    await emit(harness, requestEvent('target', '/target', 'slow'));

    expect(requestIdsOf(harness, 'Fetch.continueRequest')).toEqual(['slow', 'slow', 'target']);
    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('still fails closed when the redirect request does not follow its 3xx response within the retention', async () => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    await emit(harness, requestEvent('late', '/late'));
    await emit(harness, responseEvent('late', '/late', { status: 302, location: '/target' }));
    await vi.advanceTimersByTimeAsync(PAST_RETENTION_MS);
    await emit(harness, requestEvent('late-target', '/target', 'late'));

    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual(['late-target']);
    expect(ledger.snapshot().invariantViolations).toEqual([missingPredecessor]);
    expect(harness.closeCount).toBe(1);
  });

  it.each([
    { ending: 'a 200 response', facts: { status: 200 } },
    { ending: 'a 3xx response without Location', facts: { status: 304 } },
    { ending: 'a response error', facts: { errorReason: 'ConnectionReset' } },
    { ending: 'an external scheme redirect stopped by the Guard', facts: { status: 302, location: 'mailto:nobody@example.invalid' } },
  ])('forgets the predecessor when the original request ends with $ending', async ({ facts }) => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    await emit(harness, requestEvent('ended', '/ended'));
    await emit(harness, responseEvent('ended', '/ended', facts));
    await emit(harness, requestEvent('after-end', '/after-end', 'ended'));

    expect(requestIdsOf(harness, 'Fetch.failRequest').at(-1)).toBe('after-end');
    expect(ledger.snapshot().invariantViolations).toEqual([missingPredecessor]);
    expect(harness.closeCount).toBe(1);
  });

  it('forgets the predecessor when the Guard fails the original request at the request stage', async () => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.({
      requestId: 'blocked',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://outside.test/' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual(['blocked']);
    await emit(harness, requestEvent('after-blocked', '/after-blocked', 'blocked'));

    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual(['blocked', 'after-blocked']);
    expect(ledger.snapshot().invariantViolations).toEqual([missingPredecessor]);
    expect(harness.closeCount).toBe(1);
  });

  it('fails the 3xx response closed when its correlation cannot be registered within the count limit', async () => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    await emit(harness, requestEvent('slow', '/slow'));
    await vi.advanceTimersByTimeAsync(PAST_RETENTION_MS);
    for (let index = 0; index < PREDECESSOR_LIMIT; index += 1) {
      await emit(harness, requestEvent(`pending-${index}`, `/pending-${index}`));
    }
    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual([]);
    await emit(harness, responseEvent('slow', '/slow', { status: 302, location: '/target' }));

    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual(['slow']);
    expect(ledger.snapshot().invariantViolations).toEqual([{
      code: 'REDIRECT_PREDECESSOR_LIMIT_REACHED',
      message: 'Redirect predecessor correlation limit reached',
    }]);
    expect(harness.closeCount).toBe(1);
  });

  it('refreshes a registered predecessor at its 3xx response without counting it twice', async () => {
    vi.useFakeTimers();
    const { harness, ledger } = await readyGuard();

    for (let index = 0; index < PREDECESSOR_LIMIT; index += 1) {
      await emit(harness, requestEvent(`pending-${index}`, `/pending-${index}`));
    }
    await emit(harness, responseEvent('pending-0', '/pending-0', { status: 302, location: '/target' }));
    await emit(harness, requestEvent('pending-0-target', '/target', 'pending-0'));

    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(requestIdsOf(harness, 'Fetch.continueRequest').slice(-2)).toEqual(['pending-0', 'pending-0-target']);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('keeps the correlation of a slow 3xx response that arrives after the Interaction freeze', async () => {
    vi.useFakeTimers();
    const { harness, ledger, page } = await readyGuard();
    Object.defineProperty(page, 'url', { value: () => `${ORIGIN}/fixture` });

    await emit(harness, requestEvent('slow', '/slow'));
    await activateInteractionFreeze(page);
    await vi.advanceTimersByTimeAsync(SLOW_RESPONSE_MS);
    await emit(harness, responseEvent('slow', '/slow', { status: 302, location: '/target' }));
    await emit(harness, requestEvent('frozen-target', '/target', 'slow'));

    expect(requestIdsOf(harness, 'Fetch.failRequest')).toEqual(['frozen-target']);
    expect(ledger.snapshot().blockedInteractionNavigations).toEqual([
      { method: 'GET', url: `${ORIGIN}/target`, reason: 'INTERACTION_FROZEN' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });
});

// L5b（サイトへの負荷の制御の設計書 4.7）: Guard は、段階が PASSIVE_ACTIVE で、許可の判定が ALLOW の、ナビゲーションでない要求の
// 届け方だけを、注入された部品（`resourceDelivery`）に尋ねる。部品が選べるのは、ネットワーク（今のまま）、キャッシュから返す、
// 送らない、の3つだけで、後の2つはネットワークに何も送らない。部品の例外と、`route.fulfill` と `route.abort` の失敗は、Guard の外に
// 投げず、違反にもしない（安全には関わらない）。送らなかった要求は、Safety の記録に入れない。
describe('resource delivery of the requests the Guard allowed (L5b)', () => {
  const ORIGIN = 'https://example.test';
  const OTHER_ORIGIN = 'https://other.test';
  const CACHED_RESOURCE: CachedResource = Object.freeze({
    url: `${ORIGIN}/asset.svg`,
    status: 200,
    headers: Object.freeze({ 'content-type': 'image/svg+xml' }),
    body: new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
  });

  /** 届け方の部品の呼び出しを記録する偽の部品。`decide` は注入する。 */
  function recordingDelivery(decide: GuardResourceDelivery['decide']): {
    readonly delivery: GuardResourceDelivery;
    readonly calls: string[];
    readonly decided: Parameters<GuardResourceDelivery['decide']>[0][];
  } {
    const calls: string[] = [];
    const decided: Parameters<GuardResourceDelivery['decide']>[0][] = [];
    return {
      calls,
      decided,
      delivery: {
        decide: (request) => {
          calls.push('decide');
          decided.push(request);
          return decide(request);
        },
        beforeServeFromRunCache: (request) => {
          calls.push(`beforeServeFromRunCache:${request.url()}`);
        },
        afterWithhold: (request) => {
          calls.push(`afterWithhold:${request.url()}`);
        },
      },
    };
  }

  /** route の操作を `calls` に記録する偽の route。fulfill と abort の失敗を注入できる。 */
  function deliveryRoute(
    calls: string[],
    facts: {
      readonly method?: string;
      readonly url: string;
      readonly resourceType?: string;
      readonly navigationPage?: Page;
      readonly fulfillError?: Error;
      readonly abortError?: Error;
    },
  ): { readonly route: Route; readonly request: Request; readonly fulfilled: unknown[] } {
    const fulfilled: unknown[] = [];
    const request = {
      method: () => facts.method ?? 'GET',
      url: () => facts.url,
      resourceType: () => facts.resourceType ?? 'image',
      isNavigationRequest: () => facts.navigationPage !== undefined,
      frame: () => ({ parentFrame: () => null, page: () => facts.navigationPage }),
    } as unknown as Request;
    const route = {
      request: () => request,
      fulfill: async (options: unknown): Promise<void> => {
        calls.push('fulfill');
        fulfilled.push(options);
        if (facts.fulfillError !== undefined) throw facts.fulfillError;
      },
      abort: async (errorCode?: string): Promise<void> => {
        calls.push(`abort:${errorCode ?? ''}`);
        if (facts.abortError !== undefined) throw facts.abortError;
      },
      fallback: async (): Promise<void> => {
        calls.push('fallback');
      },
    } as unknown as Route;
    return { route, request, fulfilled };
  }

  async function guardWith(delivery: GuardResourceDelivery): Promise<{ readonly harness: GuardHarness; readonly ledger: SafetyLedger }> {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]), { resourceDelivery: delivery });
    return { harness, ledger };
  }

  /** Safety の記録が、何もないこと（送らなかった要求も、キャッシュから返した要求も、記録しない）。 */
  function expectNoSafetyRecords(ledger: SafetyLedger): void {
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedInteractionRequests).toEqual([]);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
  }

  it('serves FROM_RUN_CACHE with route.fulfill, marking the request before serving, without the network or a Safety record', async () => {
    const recording = recordingDelivery(() => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const routed = deliveryRoute(recording.calls, { url: CACHED_RESOURCE.url });

    await expect(Promise.resolve(harness.httpHandler?.(routed.route))).resolves.toBeUndefined();

    expect(recording.decided).toEqual([
      { method: 'GET', resourceType: 'image', url: CACHED_RESOURCE.url, isNavigationRequest: false },
    ]);
    expect(recording.calls).toEqual(['decide', `beforeServeFromRunCache:${CACHED_RESOURCE.url}`, 'fulfill']);
    const [options] = routed.fulfilled as [{ readonly status: number; readonly headers: Record<string, string>; readonly body: Buffer }];
    expect(options.status).toBe(200);
    expect(options.headers).toEqual({ 'content-type': 'image/svg+xml' });
    // 本文は、写さずに包んだ Buffer（キャッシュの本文と同じメモリー）。
    expect(Buffer.isBuffer(options.body)).toBe(true);
    expect(options.body.buffer).toBe(CACHED_RESOURCE.body.buffer);
    expect(options.body.equals(Buffer.from(CACHED_RESOURCE.body))).toBe(true);
    expectNoSafetyRecords(ledger);
    expect(harness.closeCount).toBe(0);
  });

  it('withholds WITHHOLD with route.abort and then tells the delivery part, without the network or a Safety record', async () => {
    const recording = recordingDelivery(() => ({ kind: 'WITHHOLD' }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const url = `${OTHER_ORIGIN}/tag.js`;
    const routed = deliveryRoute(recording.calls, { url, resourceType: 'script' });

    await expect(Promise.resolve(harness.httpHandler?.(routed.route))).resolves.toBeUndefined();

    expect(recording.calls).toEqual(['decide', 'abort:blockedbyclient', `afterWithhold:${url}`]);
    // Guard が自分で止めた要求なので、その失敗の事象は違反にしない（`expectedRouteFailures` に登録してある）。
    harness.requestFailedHandler?.(routed.request);
    await flushGuardProtocolCallbacks();
    expectNoSafetyRecords(ledger);
    expect(harness.closeCount).toBe(0);
  });

  it('sends NETWORK through the native fallback, as without the delivery part', async () => {
    const recording = recordingDelivery(() => ({ kind: 'NETWORK' }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const routed = deliveryRoute(recording.calls, { url: `${ORIGIN}/fresh.svg` });

    await harness.httpHandler?.(routed.route);

    expect(recording.calls).toEqual(['decide', 'fallback']);
    expectNoSafetyRecords(ledger);
  });

  it('does not ask the delivery part for a navigation request', async () => {
    const recording = recordingDelivery(() => ({ kind: 'WITHHOLD' }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const page = await readyHarnessPage(harness);
    const routed = deliveryRoute(recording.calls, { url: `${ORIGIN}/next.html`, resourceType: 'document', navigationPage: page });

    await harness.httpHandler?.(routed.route);

    expect(recording.calls).toEqual(['fallback']);
    expectNoSafetyRecords(ledger);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not ask the delivery part for a %s request; the Guard blocks and records it', async (method) => {
    const recording = recordingDelivery(() => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const routed = deliveryRoute(recording.calls, { method, url: CACHED_RESOURCE.url, resourceType: 'fetch' });

    await harness.httpHandler?.(routed.route);

    expect(recording.calls).toEqual(['abort:blockedbyclient']);
    expect(ledger.snapshot().blockedRequests).toEqual([expect.objectContaining({ method, url: CACHED_RESOURCE.url })]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('does not ask the delivery part after the freeze, even for a cached URL; the Guard blocks and records it', async () => {
    const recording = recordingDelivery(() => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }));
    const { harness, ledger } = await guardWith(recording.delivery);
    const page = createHarnessPage(harness, { url: `${ORIGIN}/fixture` });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);
    const routed = deliveryRoute(recording.calls, { url: CACHED_RESOURCE.url });

    await harness.httpHandler?.(routed.route);

    expect(recording.calls).toEqual(['abort:blockedbyclient']);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([
      { method: 'GET', url: CACHED_RESOURCE.url, reason: 'INTERACTION_FROZEN' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  // RL-fix（RL の Minor-4 (c)）: Guard が閉じている段階（閉じかけ、無効化の途中）では、届け方の部品に尋ねず、Guard が今のまま止める
  // （キャッシュにある URL でも、キャッシュから返さない）。対照として、同じ Guard と同じ要求で、PASSIVE_ACTIVE の段階では部品に
  // 尋ねることを先に確かめる（この確かめが、部品に尋ねる経路を通る要求で行われていることを示す）。
  it.each([
    ['closing (owner close pending)', 'closing'],
    ['invalidating (safety invalidation pending)', 'invalidating'],
  ] as const)('does not ask the delivery part while the Guard is %s; the Guard aborts the request', async (_label, phase) => {
    const recording = recordingDelivery(() => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }));
    const closeGate = createDeferred<void>();
    const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]), {
      resourceDelivery: recording.delivery,
    });
    const page = await readyHarnessPage(harness);

    // 対照: PASSIVE_ACTIVE の段階では、同じ要求の届け方を部品に尋ねる。
    const active = deliveryRoute(recording.calls, { url: CACHED_RESOURCE.url });
    await harness.httpHandler?.(active.route);
    expect(recording.calls).toEqual(['decide', `beforeServeFromRunCache:${CACHED_RESOURCE.url}`, 'fulfill']);
    recording.calls.splice(0);

    // 閉じかけ: 持ち主が Context を閉じる（閉じる処理は、門で止めておく）。無効化: 違反（main frame の要求の失敗）で、Guard が Context を
    // 無効にする（閉じる処理は、門で止めておく）。
    const closing = phase === 'closing'
      ? closePassiveGuardedContext(harness.context).then(() => undefined)
      : Promise.resolve(emitFailedMainFrameRequest(harness, page, {
        method: 'GET',
        url: `${ORIGIN}/catalog`,
        errorText: 'net::ERR_FAILED',
      }));
    await expect.poll(() => harness.closeCount).toBe(1);
    // 閉じている段階である（動いている段階でも、閉じた後でもない）。
    expect(() => assertPassiveRequestGuardActive(harness.context)).toThrow();
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
    const late = deliveryRoute(recording.calls, { url: CACHED_RESOURCE.url });
    await harness.httpHandler?.(late.route);
    closeGate.resolve(undefined);
    await closing;

    expect(recording.calls).toEqual(['abort:blockedbyclient']);
    // 部品に尋ねたのは、対照の1回だけである。
    expect(recording.decided).toHaveLength(1);
    expect(late.fulfilled).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual(
      phase === 'closing' ? [] : [{ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: 'net::ERR_FAILED' }],
    );
  });

  it('falls back to the network without a violation when the delivery part throws', async () => {
    const recording = recordingDelivery(() => {
      throw new Error('delivery decision failed');
    });
    const { harness, ledger } = await guardWith(recording.delivery);
    const routed = deliveryRoute(recording.calls, { url: CACHED_RESOURCE.url });

    await expect(Promise.resolve(harness.httpHandler?.(routed.route))).resolves.toBeUndefined();

    expect(recording.calls).toEqual(['decide', 'fallback']);
    expectNoSafetyRecords(ledger);
    expect(harness.closeCount).toBe(0);
  });

  it('aborts without a violation when route.fulfill fails, and contains a failed abort as well', async () => {
    for (const abortError of [undefined, new Error('abort failed')]) {
      const recording = recordingDelivery(() => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }));
      const { harness, ledger } = await guardWith(recording.delivery);
      const routed = deliveryRoute(recording.calls, {
        url: CACHED_RESOURCE.url,
        fulfillError: new Error('fulfill failed'),
        ...(abortError === undefined ? {} : { abortError }),
      });

      await expect(Promise.resolve(harness.httpHandler?.(routed.route))).resolves.toBeUndefined();

      expect(recording.calls).toEqual([
        'decide',
        `beforeServeFromRunCache:${CACHED_RESOURCE.url}`,
        'fulfill',
        'abort:blockedbyclient',
      ]);
      harness.requestFailedHandler?.(routed.request);
      await flushGuardProtocolCallbacks();
      expectNoSafetyRecords(ledger);
      expect(harness.closeCount).toBe(0);
    }
  });

  it('contains a failed abort of WITHHOLD and failures of the delivery part callbacks without a violation', async () => {
    const { harness, ledger } = await guardWith({
      decide: () => ({ kind: 'WITHHOLD' }),
      beforeServeFromRunCache: () => {
        throw new Error('mark failed');
      },
      afterWithhold: () => {
        throw new Error('count failed');
      },
    });
    const calls: string[] = [];
    const routed = deliveryRoute(calls, { url: `${OTHER_ORIGIN}/tag.js`, abortError: new Error('abort failed') });

    await expect(Promise.resolve(harness.httpHandler?.(routed.route))).resolves.toBeUndefined();

    expect(calls).toEqual(['abort:blockedbyclient']);
    expectNoSafetyRecords(ledger);
    expect(harness.closeCount).toBe(0);

    // キャッシュから返す前の印の失敗も、Guard の外に投げず、キャッシュから返す。
    const served = await guardWith({
      decide: () => ({ kind: 'FROM_RUN_CACHE', resource: CACHED_RESOURCE }),
      beforeServeFromRunCache: () => {
        throw new Error('mark failed');
      },
      afterWithhold: () => undefined,
    });
    const servedCalls: string[] = [];
    const servedRoute = deliveryRoute(servedCalls, { url: CACHED_RESOURCE.url });
    await expect(Promise.resolve(served.harness.httpHandler?.(servedRoute.route))).resolves.toBeUndefined();
    expect(servedCalls).toEqual(['fulfill']);
    expectNoSafetyRecords(served.ledger);
  });
});

// DEF-026（設計書 `2026-10-05-beaksight-def-026-guard-canceled-document-design.md`）: Guard の CDP の層の命令（`Fetch.continueRequest`、
// `Fetch.failRequest`）の失敗のうち、文言が一時停止の ID が無効の形で、同じ session の取り消しの証拠（`Network.loadingFailed` の canceled で、
// type が Document。`requestId` が一時停止の通知の `networkId` と同じ）を受けたものだけを、ブラウザが取り消した要求として違反にしない。
// 証拠は、実際の Chromium では一時停止の通知より先に届くので、一時停止の有無によらず覚える。証拠がなければ、今のとおり違反にする
// （fail-closed）。ここでは、偽の page の session で、命令の応答と事象の順を決めて確かめる。
describe('DEF-026: a Guard command that fails because the browser canceled the paused Document request', () => {
  const ORIGIN = 'https://example.test';
  const [PAGE_CONTINUE_INVALID, PAGE_FAIL_INVALID] = INVALID_INTERCEPTION_ID_FAILURE_TEXTS;
  /** Guard が取り消しの証拠を待つ時間（ms。Guard の `CANCELED_DOCUMENT_EVIDENCE_WAIT_MS`）。 */
  const EVIDENCE_WAIT_MS = 500;
  /** 待ちの時間の中で、失敗の応答の後に証拠を送るまでの時間（ms）。 */
  const EVIDENCE_DELAY_WITHIN_WAIT_MS = 100;
  /** 待ちの時間が過ぎて、違反が記録されるのを待つ上限（ms）。 */
  const PAST_EVIDENCE_WAIT_POLL_MS = EVIDENCE_WAIT_MS * 4;
  /** 1つの session で覚える、取り消しの証拠の数の上限（Guard の `MAX_CANCELED_DOCUMENT_EVIDENCE`）。 */
  const EVIDENCE_LIMIT = 256;
  /** 取り消しの証拠を覚えておく時間（ms。Guard の `CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS`）。 */
  const EVIDENCE_RETENTION_MS = 5_000;
  /** 証拠を覚えておく時間を、確実に過ぎるまで待つ時間（ms）。 */
  const PAST_EVIDENCE_RETENTION_MS = EVIDENCE_RETENTION_MS + EVIDENCE_DELAY_WITHIN_WAIT_MS;
  /** 証拠を覚えておく時間を待つテストの上限（ms）。 */
  const EVIDENCE_RETENTION_TEST_TIMEOUT_MS = EVIDENCE_RETENTION_MS * 3;
  const NETWORK_ID = 'network-1';
  const CANCELED_EVIDENCE: FakeCdpLoadingFailedEvent = {
    requestId: NETWORK_ID,
    canceled: true,
    type: 'Document',
    errorText: 'net::ERR_ABORTED',
  };

  type CommandMethod = 'Fetch.continueRequest' | 'Fetch.failRequest';
  /** 偽の page の session の命令の応答を決める（`undefined` なら、既定の成功）。 */
  type Responder = (harness: GuardHarness, method: string, params: { readonly requestId?: string }) => Promise<unknown> | undefined;

  /** Request の段階の、偽の `Fetch.requestPaused` の事象（既定は、子の frame の、許可 Origin の GET）。 */
  const requestEvent = (overrides: Partial<FakeCdpPausedEvent> = {}): FakeCdpPausedEvent => ({
    requestId: 'interception-1',
    networkId: NETWORK_ID,
    frameId: 'child-frame',
    request: { method: 'GET', url: `${ORIGIN}/frame` },
    ...overrides,
  });

  /** Response の段階の、偽の `Fetch.requestPaused` の事象（既定は、200 の応答）。 */
  const responseEvent = (overrides: Partial<FakeCdpPausedEvent> = {}): FakeCdpPausedEvent => requestEvent({
    responseStatusCode: 200,
    responseHeaders: [],
    ...overrides,
  });

  /** 証拠を送る時: 失敗の応答の前、失敗の応答の後（待ちの時間の中）、送らない。 */
  type EvidenceTiming = 'BEFORE_FAILURE' | 'AFTER_FAILURE_WITHIN_WAIT' | 'NONE';

  /** `method` の命令を、`text` の文言で失敗させる応答。`evidence` の時に、`loadingFailed` の事象を送る。 */
  const failCommand = (
    method: CommandMethod,
    text: string,
    evidence: EvidenceTiming,
    loadingFailed: FakeCdpLoadingFailedEvent = CANCELED_EVIDENCE,
  ): Responder => (harness, sentMethod) => {
    if (sentMethod !== method) {
      return undefined;
    }
    return Promise.resolve().then(() => {
      if (evidence === 'BEFORE_FAILURE') {
        harness.cdpLoadingFailedHandler?.(loadingFailed);
      } else if (evidence === 'AFTER_FAILURE_WITHIN_WAIT') {
        setTimeout(() => harness.cdpLoadingFailedHandler?.(loadingFailed), EVIDENCE_DELAY_WITHIN_WAIT_MS);
      }
      throw new Error(text);
    });
  };

  async function readyGuard(respond: Responder, options: Parameters<typeof createGuardHarness>[0] = {}): Promise<{
    readonly harness: GuardHarness;
    readonly ledger: SafetyLedger;
    readonly page: Page;
  }> {
    const harness: GuardHarness = createGuardHarness({
      ...options,
      cdpSendOverride: (method, params) => respond(harness, method, params as { readonly requestId?: string }),
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = await readyHarnessPage(harness);
    return { harness, ledger, page };
  }

  const commandsOf = (harness: GuardHarness, method: string): ReadonlyArray<{ readonly method: string; readonly params: unknown }> =>
    harness.cdpCommandLog.filter((entry) => entry.method === method);

  /** Guard の作業が終わるのを待つ（証拠を待つ時間より長く待ち、遅れて記録される違反と、Context を閉じる処理も見逃さない）。 */
  const settleGuard = (): Promise<void> => wait(EVIDENCE_WAIT_MS * 2);

  it('enables the Network domain on the page session before the Document interception, to receive the cancellation evidence', async () => {
    const { harness } = await readyGuard(() => undefined);

    expect(harness.cdpCommands.indexOf('Network.enable')).toBeGreaterThanOrEqual(0);
    expect(harness.cdpCommands.indexOf('Network.enable')).toBeLessThan(harness.cdpCommands.indexOf('Fetch.enable'));
    expect(harness.cdpLoadingFailedHandler).toBeTypeOf('function');
  });

  it('invalidates and rejects readiness when Network.enable fails (the same as the other setup failures)', async () => {
    const harness = createGuardHarness({ cdpSendErrorMethod: 'Network.enable' });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = createHarnessPage(harness);

    await expect(awaitPassiveRequestGuardReady(page)).rejects.toThrow('Network.enable failed');

    expect(harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_SETUP_FAILED', message: 'Network.enable failed' }]);
  });

  it.each([
    ['the Request stage', requestEvent()],
    ['the Response stage', responseEvent()],
  ])('continue at %s: the failure is not a violation when the evidence arrived before the failure, and nothing is recorded', async (_stage, event) => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'BEFORE_FAILURE'));

    harness.cdpRequestPausedHandler?.(event);
    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toHaveLength(1);
    await settleGuard();

    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedNavigations).toEqual([]);
    expect(snapshot.externalSchemeNavigations).toEqual([]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('continue: the evidence that arrives after the failure, within the wait, prevents the violation', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'AFTER_FAILURE_WITHIN_WAIT'));

    harness.cdpRequestPausedHandler?.(requestEvent());
    await settleGuard();

    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('continue: without the evidence, the failure becomes a violation after the wait and the Context closes', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'NONE'));

    harness.cdpRequestPausedHandler?.(requestEvent());

    await expect.poll(() => harness.closeCount, { timeout: PAST_EVIDENCE_WAIT_POLL_MS }).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID }]);
  });

  it('continue: a paused event without networkId cannot be matched to the evidence, so the failure is a violation', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'BEFORE_FAILURE'));
    const { networkId: _omitted, ...withoutNetworkId } = requestEvent();

    harness.cdpRequestPausedHandler?.(withoutNetworkId);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID }]);
  });

  it.each([
    ['another failure text (the target closed)', 'cdpSession.send: Target page, context or browser has been closed'],
    ['another protocol failure of the same command', 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid state for continueInterceptedRequest'],
    ['a longer text that contains the invalid interception id text', `${PAGE_CONTINUE_INVALID} (retry)`],
  ])('continue: %s is a violation even with the evidence', async (_name, text) => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', text, 'BEFORE_FAILURE'));

    harness.cdpRequestPausedHandler?.(requestEvent());

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: text }]);
  });

  it.each([
    ['a loadingFailed that is not a cancellation', { requestId: NETWORK_ID, canceled: false, type: 'Document', errorText: 'net::ERR_FAILED' }],
    ['a loadingFailed without canceled', { requestId: NETWORK_ID, type: 'Document', errorText: 'net::ERR_ABORTED' }],
    ['a cancellation of another request', { requestId: 'network-other', canceled: true, type: 'Document', errorText: 'net::ERR_ABORTED' }],
    ['a cancellation of a request that is not a Document', { requestId: NETWORK_ID, canceled: true, type: 'Other', errorText: 'net::ERR_ABORTED' }],
    ['a cancellation without a type', { requestId: NETWORK_ID, canceled: true, errorText: 'net::ERR_ABORTED' }],
  ] as const)('continue: %s is not the evidence, so the failure is a violation', async (_name, loadingFailed) => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'BEFORE_FAILURE', loadingFailed));

    harness.cdpRequestPausedHandler?.(requestEvent());

    await expect.poll(() => harness.closeCount, { timeout: PAST_EVIDENCE_WAIT_POLL_MS }).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID }]);
  });

  // 実際の Chromium では、取り消しの証拠は、一時停止の通知より先に届く（DEF-026-fix の実験。282件のすべてで、3〜55ms 前）。
  it.each([
    ['continue at the Request stage', 'Fetch.continueRequest', PAGE_CONTINUE_INVALID, requestEvent()],
    ['continue at the Response stage', 'Fetch.continueRequest', PAGE_CONTINUE_INVALID, responseEvent()],
    ['fail (blocked main frame navigation)', 'Fetch.failRequest', PAGE_FAIL_INVALID, requestEvent({
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://outside.example.test/' },
    })],
  ] as const)('%s: the evidence that arrived before the paused event prevents the violation', async (_name, method, text, event) => {
    const { harness, ledger } = await readyGuard(failCommand(method, text, 'NONE'));

    harness.cdpLoadingFailedHandler?.(CANCELED_EVIDENCE);
    harness.cdpRequestPausedHandler?.(event);
    await expect.poll(() => commandsOf(harness, method)).toHaveLength(1);
    await settleGuard();

    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('the evidence is kept only for its retention: evidence older than the retention does not prevent the violation', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'NONE'));

    harness.cdpLoadingFailedHandler?.(CANCELED_EVIDENCE);
    await wait(PAST_EVIDENCE_RETENTION_MS);
    harness.cdpRequestPausedHandler?.(requestEvent());

    await expect.poll(() => harness.closeCount, { timeout: PAST_EVIDENCE_WAIT_POLL_MS }).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID }]);
  }, EVIDENCE_RETENTION_TEST_TIMEOUT_MS);

  it('fail (blocked main frame navigation): with the evidence, the block is recorded as when the command succeeds, without a violation', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'BEFORE_FAILURE'));

    harness.cdpRequestPausedHandler?.(requestEvent({ frameId: 'root-frame', request: { method: 'GET', url: 'https://outside.example.test/' } }));
    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toHaveLength(1);
    await settleGuard();

    expect(ledger.snapshot().blockedNavigations).toEqual([
      { method: 'GET', url: 'https://outside.example.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('fail (blocked main frame navigation), control: without the evidence, it is CDP_FAIL_REQUEST_FAILED and the block is not recorded', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'NONE'));

    harness.cdpRequestPausedHandler?.(requestEvent({ frameId: 'root-frame', request: { method: 'GET', url: 'https://outside.example.test/' } }));

    await expect.poll(() => harness.closeCount, { timeout: PAST_EVIDENCE_WAIT_POLL_MS }).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_FAIL_REQUEST_FAILED', message: PAGE_FAIL_INVALID }]);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
  });

  it('fail (external scheme redirect of the main frame): with the evidence, it is recorded as stopped and its main frame failure stays excused', async () => {
    const sourceUrl = `${ORIGIN}/redirect/source`;
    const { harness, ledger, page } = await readyGuard(failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'BEFORE_FAILURE'));

    harness.cdpRequestPausedHandler?.(responseEvent({
      frameId: 'root-frame',
      request: { method: 'GET', url: sourceUrl },
      responseStatusCode: 302,
      responseHeaders: [{ name: 'Location', value: 'tel:+10000000000' }],
    }));
    await expect.poll(() => ledger.snapshot().externalSchemeNavigations).toHaveLength(1);
    // 止める命令が成功した場合と同じく、main frame の予期した失敗の登録が残る（違反にしない）。
    emitFailedMainFrameRequest(harness, page, { method: 'GET', url: sourceUrl, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
    await flushGuardProtocolCallbacks();
    await settleGuard();

    expect(ledger.snapshot().externalSchemeNavigations).toEqual([
      { url: 'tel:+10000000000', scheme: 'tel', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('fail (after the Interaction freeze): with the evidence, the frozen block is recorded without INTERACTION_CDP_FAIL_REQUEST_FAILED', async () => {
    const harness: GuardHarness = createGuardHarness({
      cdpSendOverride: (method) => failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'BEFORE_FAILURE')(harness, method, {}),
    });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = createHarnessPage(harness, { url: `${ORIGIN}/frozen-owner` });
    await awaitPassiveRequestGuardReady(page);
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(requestEvent());
    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toHaveLength(1);
    await settleGuard();

    expect(ledger.snapshot().blockedInteractionNavigations).toEqual([
      { method: 'GET', url: `${ORIGIN}/frame`, reason: 'INTERACTION_FROZEN' },
    ]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('fail (while the Context is closing): with the evidence, the lifecycle failure is not a violation and the close is not invalidated', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard(
      failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'BEFORE_FAILURE'),
      { contextCloseGate: closeGate.promise },
    );
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(requestEvent());
    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toHaveLength(1);
    await flushGuardProtocolCallbacks();
    closeGate.resolve();

    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('fail (while the Context is closing), control: without the evidence, the lifecycle failure is recorded without waiting', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard(
      failCommand('Fetch.failRequest', PAGE_FAIL_INVALID, 'NONE'),
      { contextCloseGate: closeGate.promise },
    );
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(requestEvent());
    // 閉じる処理の途中は、証拠を待たない（待ちの時間より前に記録される）。
    await expect.poll(() => ledger.snapshot().invariantViolations, { timeout: EVIDENCE_WAIT_MS / 2 }).toEqual([
      { code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message: PAGE_FAIL_INVALID },
    ]);
    closeGate.resolve();
    await closing;
  });

  it('a close that starts while the Guard waits for the evidence ends the wait: the violation is recorded at once and the drain does not time out', async () => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'NONE'));
    harness.cdpRequestPausedHandler?.(requestEvent());
    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toHaveLength(1);
    await flushGuardProtocolCallbacks();

    const startedAt = Date.now();
    await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);

    expect(Date.now() - startedAt).toBeLessThan(EVIDENCE_WAIT_MS);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID }]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it.each([
    [`${EVIDENCE_LIMIT - 1} earlier cancellations: the ${EVIDENCE_LIMIT}th evidence is kept, and the canceled command is not a violation`, EVIDENCE_LIMIT - 1, []],
    [`${EVIDENCE_LIMIT} earlier cancellations: the ${EVIDENCE_LIMIT + 1}th evidence is not kept, and the canceled command is a violation`, EVIDENCE_LIMIT, [
      { code: 'CDP_CONTINUE_REQUEST_FAILED', message: PAGE_CONTINUE_INVALID },
    ]],
  ] as const)('the number of kept evidence is bounded: %s', async (_name, earlierCount, expectedViolations) => {
    const { harness, ledger } = await readyGuard(failCommand('Fetch.continueRequest', PAGE_CONTINUE_INVALID, 'NONE'));

    // ほかの文書の要求の取り消し（一時停止の通知の来ないものを含む）を、`earlierCount` 件受けた後に、確かめる要求の取り消しを受ける。
    for (let index = 0; index < earlierCount; index += 1) {
      harness.cdpLoadingFailedHandler?.({ ...CANCELED_EVIDENCE, requestId: `network-earlier-${index}` });
    }
    harness.cdpLoadingFailedHandler?.(CANCELED_EVIDENCE);
    harness.cdpRequestPausedHandler?.(requestEvent());
    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toHaveLength(1);
    await settleGuard();

    expect(ledger.snapshot().invariantViolations).toEqual(expectedViolations);
  });
});

// DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md` 2.1）: Guard の CDP の Fetch の横取りを、すべての要求の
// Request の段階に広げる。Document でない要求（`resourceType` が `Document` 以外）は、Guard が CDP の段階で判定する。
// - Passive: `classifyPassiveRequest`（ナビゲーションでない要求として）で、許可は `Fetch.continueRequest`、拒否は `Fetch.failRequest` と
//   `blockedRequests` の記録（理由は分類のもの。route と同じ）。
// - 凍結の後: `Fetch.failRequest` と `blockedInteractionRequests`（`INTERACTION_FROZEN`。ナビゲーションの記録は作らない）。
// - 閉じる途中: `Fetch.failRequest` だけ（route の今の扱いと同じで、記録しない）。
// - 命令の失敗が、一時停止の ID が無効な形なら、ブラウザが先に取り消した要求として扱う。それ以外の失敗と、method や URL のない要求は
//   fail-closed（違反にして Context を閉じる）。
// 本物の Chromium での確かめ（ページを離れるときの送信が届かないこと、記録が 1 回であること）は `guard-unload-requests.test.ts`。
describe('DEF-042: the CDP interception covers every request at the Request stage and judges the non-Document requests', () => {
  const ORIGIN = 'https://example.test';
  const OTHER_ORIGIN = 'https://other.test';

  /** Request の段階の、Document でない偽の `Fetch.requestPaused` の事象（既定は、root frame の `Ping`（sendBeacon）の POST）。 */
  const subresourceEvent = (overrides: Partial<FakeCdpPausedEvent> = {}): FakeCdpPausedEvent => ({
    requestId: 'subresource-1',
    networkId: 'network-subresource-1',
    frameId: 'root-frame',
    resourceType: 'Ping',
    request: { method: 'POST', url: `${ORIGIN}/__mutation` },
    ...overrides,
  });

  const commandsOf = (harness: GuardHarness, method: string): ReadonlyArray<{ readonly method: string; readonly params: unknown }> =>
    harness.cdpCommandLog.filter((entry) => entry.method === method);

  const failed = (requestId: string): { readonly method: string; readonly params: unknown } => ({
    method: 'Fetch.failRequest',
    params: { requestId, errorReason: 'BlockedByClient' },
  });

  const continued = (requestId: string): { readonly method: string; readonly params: unknown } => ({
    method: 'Fetch.continueRequest',
    params: { requestId },
  });

  async function readyGuard(options: Parameters<typeof createGuardHarness>[0] = {}): Promise<{
    readonly harness: GuardHarness;
    readonly ledger: SafetyLedger;
    readonly page: Page;
  }> {
    const harness = createGuardHarness(options);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = await readyHarnessPage(harness);
    return { harness, ledger, page };
  }

  it.each(['Ping', 'Fetch', 'XHR', 'Other'] as const)('Passive: fails a paused %s POST with BlockedByClient and records it once as NON_READ_METHOD', async (resourceType) => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([{ method: 'POST', url: `${ORIGIN}/__mutation`, reason: 'NON_READ_METHOD' }]);
    expect(ledger.snapshot().blockedRequestsByMethod).toEqual({ POST: 1 });
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it('Passive: fails a paused non-Document request without a networkId (the leaving requests of a page) and records it', async () => {
    const { harness, ledger } = await readyGuard();

    const withoutNetworkId: FakeCdpPausedEvent = {
      requestId: 'subresource-1',
      frameId: 'root-frame',
      resourceType: 'Ping',
      request: { method: 'POST', url: `${ORIGIN}/__mutation` },
    };
    harness.cdpRequestPausedHandler?.(withoutNetworkId);

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(ledger.snapshot().blockedRequests).toEqual([{ method: 'POST', url: `${ORIGIN}/__mutation`, reason: 'NON_READ_METHOD' }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it.each([
    ['GET', ORIGIN, 'Image'],
    ['HEAD', ORIGIN, 'Fetch'],
    ['GET', OTHER_ORIGIN, 'Script'],
  ] as const)('Passive: continues a paused %s %s %s without a record (non-Document requests are not bound to the allowed Origins, even in the root frame)', async (method, origin, resourceType) => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType, request: { method, url: `${origin}/asset` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([continued('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().blockedNavigations).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it('keeps the Document path for Document events: a paused Document GET outside the allowed Origin in the root frame is still a blocked navigation', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(subresourceEvent({
      resourceType: 'Document',
      request: { method: 'GET', url: `${OTHER_ORIGIN}/page` },
    }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(ledger.snapshot().blockedNavigations).toEqual([
      { method: 'GET', url: `${OTHER_ORIGIN}/page`, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
    ]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('after the Interaction freeze: fails the paused non-Document request and records INTERACTION_FROZEN without a navigation record', async () => {
    const { harness, ledger, page } = await readyGuard();
    Object.defineProperty(page, 'url', { value: () => `${ORIGIN}/fixture` });
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Image', request: { method: 'GET', url: `${ORIGIN}/late.png` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([{ method: 'GET', url: `${ORIGIN}/late.png`, reason: 'INTERACTION_FROZEN' }]);
    expect(ledger.snapshot().blockedInteractionNavigations).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await wait(10);
    expect(harness.closeCount).toBe(0);
  });

  it('while the owner Context close is pending: fails the paused non-Document request without a record', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ contextCloseGate: closeGate.promise });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Image', request: { method: 'GET', url: `${ORIGIN}/late.png` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    closeGate.resolve();
    await closing;
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it.each(INVALID_INTERCEPTION_ID_FAILURE_TEXTS)('treats "%s" on Fetch.failRequest for a non-Document request as a request the browser canceled: no violation, and the block stays recorded', async (text) => {
    const { harness, ledger } = await readyGuard({
      cdpSendOverride: (method) => (method === 'Fetch.failRequest' ? Promise.reject(new Error(text)) : undefined),
    });

    harness.cdpRequestPausedHandler?.(subresourceEvent());

    await expect.poll(() => ledger.snapshot().blockedRequests).toEqual([{ method: 'POST', url: `${ORIGIN}/__mutation`, reason: 'NON_READ_METHOD' }]);
    await wait(10);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('treats an invalid interception id on Fetch.continueRequest for a non-Document request as a request the browser canceled: no violation, no record', async () => {
    const { harness, ledger } = await readyGuard({
      cdpSendOverride: (method) => (method === 'Fetch.continueRequest'
        ? Promise.reject(new Error(INVALID_INTERCEPTION_ID_FAILURE_TEXTS[0]))
        : undefined),
    });

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Image', request: { method: 'GET', url: `${ORIGIN}/late.png` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toEqual([continued('subresource-1')]);
    await wait(10);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('records another failure of Fetch.failRequest for a non-Document request as a violation without a blocked record, and invalidates the Context (fail-closed)', async () => {
    const { harness, ledger } = await readyGuard({ cdpSendErrorMethod: 'Fetch.failRequest' });

    harness.cdpRequestPausedHandler?.(subresourceEvent());

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_FAIL_REQUEST_FAILED', message: 'Fetch.failRequest failed' }]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
  });

  it('records another failure of Fetch.continueRequest for a non-Document request as a violation and invalidates the Context (fail-closed)', async () => {
    const { harness, ledger } = await readyGuard({ cdpSendErrorMethod: 'Fetch.continueRequest' });

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Image', request: { method: 'GET', url: `${ORIGIN}/late.png` } }));

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_CONTINUE_REQUEST_FAILED', message: 'Fetch.continueRequest failed' }]);
  });

  // DEF-042 の設計書 2.4（閉じる途中の命令の失敗）: owner の close を始めた後に、session か target の閉鎖で命令が失敗した場合は、
  // target とともに消えた要求として扱い、違反にも記録にもしない。それ以外の失敗は、今までどおり違反。
  it.each([
    ['the page session', 'cdpSession.send: Target page, context or browser has been closed'],
    ['an OOPIF session', 'OOPIF interception session was detached'],
  ] as const)('while the owner Context close is pending: a Fetch.failRequest failure of %s because the target closed is neither a violation nor a record', async (_label, text) => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({
      contextCloseGate: closeGate.promise,
      cdpSendOverride: (method) => (method === 'Fetch.failRequest' ? Promise.reject(new Error(text)) : undefined),
    });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Other', request: { method: 'GET', url: `${ORIGIN}/favicon.ico` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    closeGate.resolve();
    await closing;
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
  });

  it('while the owner Context close is pending: another Fetch.failRequest failure stays a violation (CDP_LIFECYCLE_FAIL_REQUEST_FAILED)', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ contextCloseGate: closeGate.promise, cdpSendErrorMethod: 'Fetch.failRequest' });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(subresourceEvent({ resourceType: 'Other', request: { method: 'GET', url: `${ORIGIN}/favicon.ico` } }));

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([
      { code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message: 'Fetch.failRequest failed' },
    ]);
    closeGate.resolve();
    await closing;
    expect(harness.closeCount).toBe(1);
  });

  it('in the Passive phase (not closing): a Fetch.failRequest failure because the target closed stays a violation (fail-closed)', async () => {
    const { harness, ledger } = await readyGuard({
      cdpSendOverride: (method) => (method === 'Fetch.failRequest'
        ? Promise.reject(new Error('cdpSession.send: Target page, context or browser has been closed'))
        : undefined),
    });

    harness.cdpRequestPausedHandler?.(subresourceEvent());

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'CDP_FAIL_REQUEST_FAILED', message: 'cdpSession.send: Target page, context or browser has been closed' },
    ]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
  });

  // DEF-045（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 2）: 凍結の段階で、owner の close を始めた後
  // （`FROZEN_CLOSING`、`FROZEN_INVALIDATING`、close の試みあり）に、命令が session か target の閉鎖で失敗した場合は、違反にしない
  // （止める前の `INTERACTION_FROZEN` の記録は残る）。owner の close を始める前（`FROZEN_ACTIVE`）の同じ失敗は、今までどおり違反。
  // Document でない要求（`handlePausedRequest`）と、Document の要求（Document の凍結の分岐）の両方で確かめる。
  const CLOSED_TARGET_FAILURE_TEXT = 'cdpSession.send: Target page, context or browser has been closed';
  const FROZEN_CLOSE_RACE_REQUESTS = [
    ['non-Document', `${ORIGIN}/__mutation`, subresourceEvent()],
    ['Document', `${ORIGIN}/frozen-next`, subresourceEvent({ resourceType: 'Document', request: { method: 'GET', url: `${ORIGIN}/frozen-next` } })],
  ] as const;

  /** 凍結した Guard（Interaction の段階）を用意する。 */
  async function frozenGuard(options: Parameters<typeof createGuardHarness>[0] = {}): Promise<{
    readonly harness: GuardHarness;
    readonly ledger: SafetyLedger;
  }> {
    const { harness, ledger, page } = await readyGuard(options);
    Object.defineProperty(page, 'url', { value: () => `${ORIGIN}/fixture` });
    await activateInteractionFreeze(page);
    return { harness, ledger };
  }

  it.each(FROZEN_CLOSE_RACE_REQUESTS)('DEF-045 after the freeze, while the owner Context close is pending: a %s Fetch.failRequest failure because the target closed is not a violation, the frozen record stays, and the close is not invalidated', async (_label, url, event) => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await frozenGuard({
      contextCloseGate: closeGate.promise,
      cdpSendOverride: (method) => (method === 'Fetch.failRequest' ? Promise.reject(new Error(CLOSED_TARGET_FAILURE_TEXT)) : undefined),
    });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(event);

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    await wait(10);
    closeGate.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([
      { method: event.request.method, url, reason: 'INTERACTION_FROZEN' },
    ]);
    expect(harness.closeCount).toBe(1);
  });

  it.each(FROZEN_CLOSE_RACE_REQUESTS)('DEF-045 a %s request paused while frozen, whose Fetch.failRequest fails because the target closed after the owner Context close started, is not a violation', async (_label, url, event) => {
    const closeGate = createDeferred<void>();
    const failGate = createDeferred<unknown>();
    const { harness, ledger } = await frozenGuard({
      contextCloseGate: closeGate.promise,
      cdpSendOverride: (method) => (method === 'Fetch.failRequest' ? failGate.promise : undefined),
    });

    harness.cdpRequestPausedHandler?.(event);
    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);
    failGate.reject(new Error(CLOSED_TARGET_FAILURE_TEXT));
    await wait(10);
    closeGate.resolve();

    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([
      { method: event.request.method, url, reason: 'INTERACTION_FROZEN' },
    ]);
    expect(harness.closeCount).toBe(1);
  });

  it.each(FROZEN_CLOSE_RACE_REQUESTS)('DEF-045 control: after the freeze, before the owner close (FROZEN_ACTIVE), a %s Fetch.failRequest failure because the target closed stays a violation (fail-closed)', async (_label, _url, event) => {
    const { harness, ledger } = await frozenGuard({
      cdpSendOverride: (method) => (method === 'Fetch.failRequest' ? Promise.reject(new Error(CLOSED_TARGET_FAILURE_TEXT)) : undefined),
    });

    harness.cdpRequestPausedHandler?.(event);

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'INTERACTION_CDP_FAIL_REQUEST_FAILED', message: CLOSED_TARGET_FAILURE_TEXT },
    ]);
  });

  // DEF-050（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 6）: Document の閉じる途中の分岐
  // （`failPausedDocumentForLifecycle`）で、Context の閉じる処理が始まった後（owner の close か無効化。Passive と凍結の両方）に、命令が
  // session か target の閉鎖で失敗した場合は、違反にしない。Context の閉じる処理の前（page だけを閉じる途中）の同じ失敗は、今までどおり違反。
  const DOCUMENT_REQUEST_EVENT = subresourceEvent({ resourceType: 'Document', request: { method: 'GET', url: `${ORIGIN}/next` } });
  const DOCUMENT_RESPONSE_EVENT = subresourceEvent({
    resourceType: 'Document',
    request: { method: 'GET', url: `${ORIGIN}/next` },
    responseStatusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/html' }],
  });
  const rejectFailRequestAsClosed = (method: string): Promise<unknown> | undefined => (
    method === 'Fetch.failRequest' ? Promise.reject(new Error(CLOSED_TARGET_FAILURE_TEXT)) : undefined
  );

  it.each([
    ['Request', DOCUMENT_REQUEST_EVENT],
    ['Response', DOCUMENT_RESPONSE_EVENT],
  ] as const)('DEF-050 Passive, while the owner Context close is pending: a Document %s stage Fetch.failRequest failure because the target closed is not a violation, and the close is not invalidated', async (_stage, event) => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ contextCloseGate: closeGate.promise, cdpSendOverride: rejectFailRequestAsClosed });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(event);

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    await wait(10);
    closeGate.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(1);
  });

  it('DEF-050 frozen, while the owner Context close is pending: a Document Response stage Fetch.failRequest failure because the target closed is not a violation, and the close is not invalidated', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await frozenGuard({ contextCloseGate: closeGate.promise, cdpSendOverride: rejectFailRequestAsClosed });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(DOCUMENT_RESPONSE_EVENT);

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    await wait(10);
    closeGate.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(1);
  });

  it('DEF-050 while the Guard invalidates the Context: a Document Request stage Fetch.failRequest failure because the target closed is not a violation beyond the invalidation cause', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({
      contextCloseGate: closeGate.promise,
      cdpSendOverride: (method, params) => {
        const { requestId } = (params ?? {}) as { readonly requestId?: string };
        if (method === 'Fetch.failRequest' && requestId === 'invalidating-cause') {
          return Promise.reject(new Error('fixture failure that invalidates'));
        }
        return rejectFailRequestAsClosed(method);
      },
    });
    // 閉じた形でない失敗（違反）で、Guard が Context の無効化を始める。
    harness.cdpRequestPausedHandler?.(subresourceEvent({ requestId: 'invalidating-cause' }));
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(DOCUMENT_REQUEST_EVENT);

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toHaveLength(2);
    await wait(10);
    closeGate.resolve();
    await expect.poll(() => isPassiveRequestGuardClosed(harness.context)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'CDP_FAIL_REQUEST_FAILED', message: 'fixture failure that invalidates' },
    ]);
  });

  it('DEF-050 control: before the Context close, while only the page is being closed by its owner, a Document Fetch.failRequest failure because the target closed stays a violation (CDP_LIFECYCLE_FAIL_REQUEST_FAILED)', async () => {
    const pageCloseGate = createDeferred<void>();
    const harness = createGuardHarness({ cdpSendOverride: rejectFailRequestAsClosed });
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = createHarnessPage(harness, { closeGate: pageCloseGate.promise });
    await awaitPassiveRequestGuardReady(page);
    const pageClosing = closePassiveGuardedPage(page);

    harness.cdpRequestPausedHandler?.(DOCUMENT_REQUEST_EVENT);

    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([
      { code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message: CLOSED_TARGET_FAILURE_TEXT },
    ]);
    pageCloseGate.resolve();
    await pageClosing.catch(() => undefined);
  });

  // DEF-042 の設計書 2.4（CORS の事前確認）: `initiator.type` が `preflight` の `OPTIONS`（取れなければ `Access-Control-Request-Method`
  // ヘッダあり）は、Playwright と同じ応答（204 と CORS のヘッダ）で満たし、記録しない。事前確認でない `OPTIONS` は止めて記録する。
  const PREFLIGHT_HEADERS = Object.freeze({
    'Origin': ORIGIN,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-fixture-preflight',
  });
  const preflightEvent = (overrides: Partial<FakeCdpPausedEvent> = {}): FakeCdpPausedEvent => subresourceEvent({
    resourceType: 'Preflight',
    request: { method: 'OPTIONS', url: `${OTHER_ORIGIN}/api`, headers: PREFLIGHT_HEADERS },
    ...overrides,
  });
  const fulfilledPreflight = (headers: readonly { readonly name: string; readonly value: string }[]): { readonly method: string; readonly params: unknown } => ({
    method: 'Fetch.fulfillRequest',
    params: { requestId: 'subresource-1', responseCode: 204, responsePhrase: 'No Content', responseHeaders: headers, body: '' },
  });

  it('answers a CORS preflight identified by Network.requestWillBeSent (initiator preflight) with 204 and the CORS headers of the request, without a record', async () => {
    const { harness, ledger } = await readyGuard();
    harness.cdpRequestWillBeSentHandler?.({ requestId: 'network-subresource-1', initiator: { type: 'preflight' }, request: { method: 'OPTIONS', url: `${OTHER_ORIGIN}/api` } });

    harness.cdpRequestPausedHandler?.(preflightEvent());

    await expect.poll(() => commandsOf(harness, 'Fetch.fulfillRequest')).toEqual([fulfilledPreflight([
      { name: 'Access-Control-Allow-Origin', value: ORIGIN },
      { name: 'Access-Control-Allow-Methods', value: 'GET' },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
      { name: 'Access-Control-Allow-Headers', value: 'x-fixture-preflight' },
    ])]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('answers a CORS preflight identified only by its Access-Control-Request-Method header (no initiator) with the default CORS headers when the request has no Origin', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(preflightEvent({
      networkId: undefined as unknown as string,
      request: { method: 'OPTIONS', url: `${OTHER_ORIGIN}/api`, headers: { 'access-control-request-method': 'PUT' } },
    }));

    await expect.poll(() => commandsOf(harness, 'Fetch.fulfillRequest')).toEqual([fulfilledPreflight([
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'PUT' },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
    ])]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('answers a CORS preflight whose initiator record is known but whose headers are missing (initiator takes precedence)', async () => {
    const { harness } = await readyGuard();
    harness.cdpRequestWillBeSentHandler?.({ requestId: 'network-subresource-1', initiator: { type: 'preflight' } });

    harness.cdpRequestPausedHandler?.(preflightEvent({ request: { method: 'OPTIONS', url: `${OTHER_ORIGIN}/api` } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.fulfillRequest')).toEqual([fulfilledPreflight([
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS, DELETE' },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
    ])]);
  });

  it('still fails and records an OPTIONS request that is not a CORS preflight (no initiator record, no Access-Control-Request-Method)', async () => {
    const { harness, ledger } = await readyGuard();
    harness.cdpRequestWillBeSentHandler?.({ requestId: 'network-subresource-1', initiator: { type: 'script' } });

    harness.cdpRequestPausedHandler?.(preflightEvent({ resourceType: 'Fetch', request: { method: 'OPTIONS', url: `${ORIGIN}/api`, headers: { 'Origin': ORIGIN } } }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.fulfillRequest')).toEqual([]);
    expect(ledger.snapshot().blockedRequests).toEqual([{ method: 'OPTIONS', url: `${ORIGIN}/api`, reason: 'NON_READ_METHOD' }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('after the Interaction freeze: a CORS preflight is failed and recorded as INTERACTION_FROZEN like any other request', async () => {
    const { harness, ledger, page } = await readyGuard();
    Object.defineProperty(page, 'url', { value: () => `${ORIGIN}/fixture` });
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(preflightEvent());

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    expect(commandsOf(harness, 'Fetch.fulfillRequest')).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([{ method: 'OPTIONS', url: `${OTHER_ORIGIN}/api`, reason: 'INTERACTION_FROZEN' }]);
  });

  it('records a failure of Fetch.fulfillRequest for a CORS preflight as a violation and invalidates the Context (fail-closed)', async () => {
    const { harness, ledger } = await readyGuard({ cdpSendErrorMethod: 'Fetch.fulfillRequest' });

    harness.cdpRequestPausedHandler?.(preflightEvent());

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_PREFLIGHT_FULFILL_FAILED', message: 'Fetch.fulfillRequest failed' }]);
  });

  // DEF-042 の設計書 2.4（Guard の作業の上限）: 要求の横取りの作業は `MAX_PENDING_GUARD_REQUEST_TASKS` で数え、ほかの作業の上限
  // （256）には数えない。上限を超えた要求は一時停止のまま進めず、`GUARD_TASK_LIMIT_REACHED` にして Context を閉じる。
  it('admits more than 256 pending request-interception tasks without reaching the general task limit', async () => {
    const continueGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ cdpSendGate: { method: 'Fetch.continueRequest', promise: continueGate.promise } });
    /** ほかの作業の上限（Guard の `MAX_PENDING_GUARD_TASKS` = 256）を超え、要求の作業の上限（4,096）には届かない数。 */
    const count = 300;

    for (let index = 0; index < count; index += 1) {
      harness.cdpRequestPausedHandler?.(subresourceEvent({
        requestId: `image-${index}`,
        networkId: `network-image-${index}`,
        resourceType: 'Image',
        request: { method: 'GET', url: `${ORIGIN}/image-${index}.svg` },
      }));
    }
    await expect.poll(() => commandsOf(harness, 'Fetch.continueRequest')).toHaveLength(count);

    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
    continueGate.resolve();
    await closePassiveGuardedContext(harness.context);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('fails closed when the pending request-interception tasks exceed MAX_PENDING_GUARD_REQUEST_TASKS: one GUARD_TASK_LIMIT_REACHED violation and the Context closes', async () => {
    const continueGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ cdpSendGate: { method: 'Fetch.continueRequest', promise: continueGate.promise } });

    for (let index = 0; index < MAX_PENDING_GUARD_REQUEST_TASKS + 1; index += 1) {
      harness.cdpRequestPausedHandler?.(subresourceEvent({
        requestId: `image-${index}`,
        networkId: `network-image-${index}`,
        resourceType: 'Image',
        request: { method: 'GET', url: `${ORIGIN}/image-${index}.svg` },
      }));
    }
    await expect.poll(() => harness.closeCount).toBe(1);
    // 上限までの要求は、命令を受ける（無効化の順によって、続ける命令か、閉じる途中の止める命令か）。超えた 1 件は、命令を受けない。
    const commandedRequestIds = (): Set<unknown> => new Set(harness.cdpCommandLog
      .filter((entry) => entry.method === 'Fetch.continueRequest' || entry.method === 'Fetch.failRequest')
      .map((entry) => (entry.params as { readonly requestId: unknown }).requestId));
    await expect.poll(() => commandedRequestIds().size).toBe(MAX_PENDING_GUARD_REQUEST_TASKS);

    expect(commandedRequestIds().has(`image-${MAX_PENDING_GUARD_REQUEST_TASKS}`)).toBe(false);
    expect(ledger.snapshot().invariantViolations.filter(({ code }) => code === 'GUARD_TASK_LIMIT_REACHED')).toEqual([
      { code: 'GUARD_TASK_LIMIT_REACHED', message: 'paused CDP request' },
    ]);
    continueGate.resolve();
  });

  it('fails closed a paused non-Document request whose method or URL is missing: the request fails, a violation is recorded, and the Context closes', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(subresourceEvent({ request: { method: undefined, url: `${ORIGIN}/__mutation` } as unknown as FakeCdpPausedEvent['request'] }));

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toEqual([failed('subresource-1')]);
    await expect.poll(() => harness.closeCount).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([{ code: 'CDP_REQUEST_FACTS_INVALID', message: 'Paused request had no method or URL' }]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
  });
});

describe('DEF-040: the Other responses receive the Worker connect policy header, and the Worker CSP violations are recorded from the Log domain', () => {
  const ORIGIN = 'https://example.test';
  const SOCKET_URL = 'wss://example.test/socket';
  /** Chromium が Worker の中の CSP の違反のときに Log に残す文（NP3 で確かめた形）。 */
  const violationText = (url: string, policy: string = WORKER_CONNECT_POLICY): string =>
    `Connecting to '${url}' violates the following Content Security Policy directive: "${policy}". The action has been blocked.`;
  const workerLogEntry = (text: string, source = 'worker'): { readonly entry: { readonly source: string; readonly level: string; readonly text: string } } =>
    ({ entry: { source, level: 'error', text } });
  const otherResponse = (overrides: Partial<FakeCdpPausedEvent> = {}): FakeCdpPausedEvent => ({
    requestId: 'worker-script-1',
    networkId: 'network-worker-script-1',
    frameId: 'root-frame',
    resourceType: 'Other',
    request: { method: 'GET', url: `${ORIGIN}/worker.js` },
    responseStatusCode: 200,
    responseStatusText: 'OK',
    responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
    ...overrides,
  });
  const commandsOf = (harness: GuardHarness, method: string): ReadonlyArray<{ readonly method: string; readonly params: unknown }> =>
    harness.cdpCommandLog.filter((entry) => entry.method === method);
  const policyHeader = { name: 'Content-Security-Policy', value: WORKER_CONNECT_POLICY };

  async function readyGuard(options: Parameters<typeof createGuardHarness>[0] = {}, pageUrl?: string): Promise<{
    readonly harness: GuardHarness;
    readonly ledger: SafetyLedger;
    readonly page: Page;
  }> {
    const harness = createGuardHarness(options);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set([ORIGIN]));
    const page = createHarnessPage(harness, pageUrl === undefined ? {} : { url: pageUrl });
    await awaitPassiveRequestGuardReady(page);
    return { harness, ledger, page };
  }

  it('keeps the connect policy as the closed string of the design (2.2) and enables the Log domain on the page session after the interception', async () => {
    const { harness } = await readyGuard();

    expect(WORKER_CONNECT_POLICY).toBe('connect-src http: https: data: blob:');
    expect(harness.cdpCommands.indexOf('Log.enable')).toBeGreaterThan(harness.cdpCommands.indexOf('Fetch.enable'));
    expect(harness.cdpCommands.indexOf('Log.enable')).toBeGreaterThan(harness.cdpCommands.indexOf('Target.setAutoAttach'));
    expect(harness.cdpLogEntryAddedHandler).toBeTypeOf('function');
  });

  it('continues a paused Other response with responseCode, responsePhrase and the original headers plus the connect policy header', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpRequestPausedHandler?.(otherResponse());

    await expect.poll(() => commandsOf(harness, 'Fetch.continueResponse')).toEqual([{
      method: 'Fetch.continueResponse',
      params: {
        requestId: 'worker-script-1',
        responseCode: 200,
        responsePhrase: 'OK',
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, policyHeader],
      },
    }]);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(commandsOf(harness, 'Fetch.continueRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('uses the standard phrase of the status when the browser gives no status text, and adds the header to a response without headers', async () => {
    const { harness } = await readyGuard();

    const { responseHeaders: _headers, ...withoutHeaders } = otherResponse();
    harness.cdpRequestPausedHandler?.({ ...withoutHeaders, responseStatusCode: 404, responseStatusText: '' });

    await expect.poll(() => commandsOf(harness, 'Fetch.continueResponse')).toEqual([{
      method: 'Fetch.continueResponse',
      params: { requestId: 'worker-script-1', responseCode: 404, responsePhrase: 'Not Found', responseHeaders: [policyHeader] },
    }]);
  });

  it('continues a paused Other response that has no status (a network error) unchanged', async () => {
    const { harness, ledger } = await readyGuard();

    const { responseStatusCode: _status, responseStatusText: _text, responseHeaders: _headers, ...withoutResponse } = otherResponse();
    harness.cdpRequestPausedHandler?.({ ...withoutResponse, responseErrorReason: 'Failed' });

    await expect.poll(() => commandsOf(harness, 'Fetch.continueResponse')).toEqual([{
      method: 'Fetch.continueResponse',
      params: { requestId: 'worker-script-1' },
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('after the freeze: still continues the Other response (of a request continued before the freeze) with the connect policy header', async () => {
    const { harness, ledger, page } = await readyGuard({}, `${ORIGIN}/fixture`);
    await activateInteractionFreeze(page);

    harness.cdpRequestPausedHandler?.(otherResponse());

    await expect.poll(() => commandsOf(harness, 'Fetch.continueResponse')).toHaveLength(1);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
  });

  it('fails closed when Fetch.continueResponse fails: the response is failed, WORKER_CONNECT_POLICY_INJECTION_FAILED is recorded, and the Context closes', async () => {
    const { harness, ledger } = await readyGuard({ cdpSendErrorMethod: 'Fetch.continueResponse' });

    harness.cdpRequestPausedHandler?.(otherResponse());

    await expect.poll(() => harness.closeCount).toBe(1);
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([{
      method: 'Fetch.failRequest',
      params: { requestId: 'worker-script-1', errorReason: 'BlockedByClient' },
    }]);
    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'WORKER_CONNECT_POLICY_INJECTION_FAILED', message: 'Fetch.continueResponse failed' },
    ]);
    expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
  });

  it('treats an Invalid InterceptionId failure of Fetch.continueResponse (the browser canceled the response) as settled, without a violation', async () => {
    const { harness, ledger } = await readyGuard({
      cdpSendOverride: (method) => (method === 'Fetch.continueResponse'
        ? Promise.reject(new Error(INVALID_INTERCEPTION_ID_FAILURE_TEXTS[2]))
        : undefined),
    });

    harness.cdpRequestPausedHandler?.(otherResponse());

    await expect.poll(() => commandsOf(harness, 'Fetch.continueResponse')).toHaveLength(1);
    await flushGuardProtocolCallbacks();
    expect(commandsOf(harness, 'Fetch.failRequest')).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(harness.closeCount).toBe(0);
  });

  it('while the owner Context close is pending: fails the paused Other response instead of continuing it, and a target-closed failure is neither a violation nor a record', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({
      contextCloseGate: closeGate.promise,
      cdpSendOverride: (method) => (method === 'Fetch.failRequest'
        ? Promise.reject(new Error('cdpSession.send: Target page, context or browser has been closed'))
        : undefined),
    });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpRequestPausedHandler?.(otherResponse());

    await expect.poll(() => commandsOf(harness, 'Fetch.failRequest')).toHaveLength(1);
    expect(commandsOf(harness, 'Fetch.continueResponse')).toEqual([]);
    closeGate.resolve();
    await closing;
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('records a Worker CSP violation of the connect policy as blockedWebSockets WORKER_CONNECT_POLICY in the Passive phase', async () => {
    const { harness, ledger } = await readyGuard();

    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText(SOCKET_URL)));
    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText('ws://example.test/plain')));

    expect(ledger.snapshot().blockedWebSockets).toEqual([
      { url: SOCKET_URL, reason: 'WORKER_CONNECT_POLICY' },
      { url: 'ws://example.test/plain', reason: 'WORKER_CONNECT_POLICY' },
    ]);
    expect(ledger.snapshot().blockedInteractionWebSockets).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('records a Worker CSP violation of the connect policy as blockedInteractionWebSockets WORKER_CONNECT_POLICY after the freeze', async () => {
    const { harness, ledger, page } = await readyGuard({}, `${ORIGIN}/fixture`);
    await activateInteractionFreeze(page);

    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText(SOCKET_URL)));

    expect(ledger.snapshot().blockedInteractionWebSockets).toEqual([{ url: SOCKET_URL, reason: 'WORKER_CONNECT_POLICY' }]);
    expect(ledger.snapshot().blockedWebSockets).toEqual([]);
  });

  it('does not record Log entries that are not Worker WebSocket violations of the connect policy', async () => {
    const { harness, ledger } = await readyGuard();

    // page の文（Worker ではない）、別の policy（サイト自身の CSP）、WebSocket でない接続、解析できない URL、違反でない文、形の違う事象。
    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText(SOCKET_URL), 'security'));
    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText(SOCKET_URL, "default-src 'self'")));
    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText('about:blank')));
    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText('not a url')));
    harness.cdpLogEntryAddedHandler?.(workerLogEntry("Fetch API cannot load about:blank. Refused to connect because it violates the document's Content Security Policy."));
    harness.cdpLogEntryAddedHandler?.({ entry: null });
    harness.cdpLogEntryAddedHandler?.(undefined);

    expect(ledger.snapshot().blockedWebSockets).toEqual([]);
    expect(ledger.snapshot().blockedInteractionWebSockets).toEqual([]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('does not record a Worker CSP violation while the owner Context close is pending, and removes the Log listener on close', async () => {
    const closeGate = createDeferred<void>();
    const { harness, ledger } = await readyGuard({ contextCloseGate: closeGate.promise });
    const closing = closePassiveGuardedContext(harness.context);
    await expect.poll(() => harness.closeCount).toBe(1);

    harness.cdpLogEntryAddedHandler?.(workerLogEntry(violationText(SOCKET_URL)));

    closeGate.resolve();
    await closing;
    expect(ledger.snapshot().blockedWebSockets).toEqual([]);
    expect(harness.removedListeners).toContain('CDP:Log.entryAdded');
  });

  it('extracts the WebSocket URL only from the connect policy violation text of a Worker (workerConnectPolicyViolationUrl)', () => {
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText(SOCKET_URL)))).toBe(SOCKET_URL);
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText('ws://127.0.0.1:4173/socket')))).toBe('ws://127.0.0.1:4173/socket');
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText(SOCKET_URL), 'javascript'))).toBeNull();
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText(SOCKET_URL, 'connect-src https:')))).toBeNull();
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText('https://example.test/api')))).toBeNull();
    expect(workerConnectPolicyViolationUrl(workerLogEntry(violationText('')))).toBeNull();
    expect(workerConnectPolicyViolationUrl(workerLogEntry("Connecting to 'wss://example.test/socket' was fine."))).toBeNull();
    expect(workerConnectPolicyViolationUrl('text')).toBeNull();
  });
});

/** DEF-050 の実機の確かめで、iframe の `src` を 1 ms ごとに変えるページ（`fixtures/site/`）。 */
const IFRAME_SRC_CHURN_PAGE = '/iframe-src-churn.html';
/** DEF-050 の実機の確かめの viewport。 */
const viewportForChurn: Viewport = Object.freeze({ width: 800, height: 600 });
/**
 * DEF-050 の実機の確かめで、読み込み → Context を閉じる処理をくり返す回数。NPR2 の再現の実験では、修正の前に、Passive の Context を
 * 閉じる場面で、headless shell は 20 回のうち 3 回、CLI の Chromium は 20 回のうち 4 回、違反が出た。
 */
const IFRAME_SRC_CHURN_CLOSE_ROUNDS = 20;
/** 読み込みから閉じる処理（Passive）か凍結（Interaction）までの待ちの、基本の時間と、回ごとにずらす幅・種類の数。 */
const IFRAME_SRC_CHURN_BEFORE_CLOSE_MS = 100;
const IFRAME_SRC_CHURN_BEFORE_CLOSE_STEP_MS = 37;
const IFRAME_SRC_CHURN_BEFORE_CLOSE_STEPS = 5;
/** Interaction の凍結から owner の close までの待ちの種類の数（0〜3 ms。凍結の直後に閉じる）。 */
const IFRAME_SRC_CHURN_AFTER_FREEZE_STEPS = 4;
/** 1 回の上限の目安（ms。読み込み、待ち、閉じる処理）。テストの期限の計算に使う。 */
const IFRAME_SRC_CHURN_ROUND_BUDGET_MS = 2_000;
/**
 * 閉じる処理の前（Passive の段階）に、Guard がリダイレクトの対応付けの上限で Context を無効にした回の違反のコード（DEF-050 とは別の
 * 事象。NP6-round-1 の発見事項）。1 ms ごとに取り消される iframe の移動は応答を受けないので、対応付けの記録（上限
 * `MAX_REDIRECT_PREDECESSORS`、保持 1 秒）が埋まることがある（NP6-round-1 の実行で、Passive と Interaction の両方で、まれに起きた）。その回は、
 * 閉じる処理の前に Context が閉じたので、DEF-050 の確かめにならない。除いた回は出力に残し、回数の半分未満であることを確かめる。
 */
const PRE_FREEZE_REDIRECT_LIMIT_VIOLATION_CODE = 'REDIRECT_PREDECESSOR_LIMIT_REACHED';
/** その回の違反が、`PRE_FREEZE_REDIRECT_LIMIT_VIOLATION_CODE` の 1 件だけか。 */
const isPreFreezeRedirectLimitRound = (violations: readonly { readonly code: string }[]): boolean =>
  violations.length === 1 && violations[0]?.code === PRE_FREEZE_REDIRECT_LIMIT_VIOLATION_CODE;
const IFRAME_SRC_CHURN_TEST_TIMEOUT_MS = IFRAME_SRC_CHURN_CLOSE_ROUNDS * IFRAME_SRC_CHURN_ROUND_BUDGET_MS
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

/**
 * DEF-050（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 6）: iframe の `src` を 1 ms ごとに変え、sendBeacon の POST も
 * 送るページを読み込み、Context を閉じる（Passive は製品の手順 `closePassivePageAndContext`、Interaction は凍結の直後の owner の close）。
 * これを `IFRAME_SRC_CHURN_CLOSE_ROUNDS` 回くり返し、どの回も違反 0 と閉じる処理の成功、全部の回の後に
 * `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ってから、GET・HEAD 以外の要求がサーバに届いていないことを確かめる。テストの既定の
 * headless shell と、CLI の起動の設定（`chromiumLaunchOptions`）の両方で確かめる。
 */
describe.each([
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: (): Promise<Browser> => launchCliChromium() },
])('DEF-050: closing the Context of a page that keeps changing its iframe src, with $name', ({ name, launch }) => {
  let churnBrowser: Browser;
  let churnFactory: BrowserContextFactory;
  let churnServer: FixtureServer;

  beforeAll(async () => {
    churnServer = await startFixtureServer();
    churnBrowser = await launch();
    churnFactory = new BrowserContextFactory(churnBrowser, createTestConfig(churnServer.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  });

  afterAll(async () => {
    await churnBrowser?.close();
    await churnServer?.close();
  });

  const beforeCloseMs = (round: number): number => IFRAME_SRC_CHURN_BEFORE_CLOSE_MS
    + (round % IFRAME_SRC_CHURN_BEFORE_CLOSE_STEPS) * IFRAME_SRC_CHURN_BEFORE_CLOSE_STEP_MS;

  it.each([
    {
      mode: 'Passive (closePassivePageAndContext)',
      round: async (round: number): Promise<{ readonly ledger: SafetyLedger; readonly closeFailure: string | null }> => {
        const context = await churnFactory.createPassiveContext(viewportForChurn);
        const failures: string[] = [];
        try {
          const page = await churnFactory.createPassivePage(context);
          await page.goto(`${churnServer.origin}${IFRAME_SRC_CHURN_PAGE}`, { waitUntil: 'load' });
          await wait(beforeCloseMs(round));
        } catch (error) {
          // 読み込みの失敗（Guard が Context を閉じた場合など）も、その回の失敗として記録する（Ledger の違反とあわせて出す）。
          failures.push(`action:${String(error)}`);
        }
        const closeFailures = await closePassivePageAndContext(churnFactory, context);
        failures.push(...closeFailures.map(({ step, error }) => `${step}:${String(error)}`));
        return { ledger: churnFactory.getSafetyLedger(context), closeFailure: failures.length === 0 ? null : failures.join('|') };
      },
    },
    {
      mode: 'Interaction (the owner close right after the freeze)',
      round: async (round: number): Promise<{ readonly ledger: SafetyLedger; readonly closeFailure: string | null }> => {
        const session = await churnFactory.createInteractionSession(viewportForChurn);
        const failures: string[] = [];
        try {
          await session.page.goto(`${churnServer.origin}${IFRAME_SRC_CHURN_PAGE}`, { waitUntil: 'load' });
          await wait(beforeCloseMs(round));
          await session.activateInteractionFreeze();
          await wait(round % IFRAME_SRC_CHURN_AFTER_FREEZE_STEPS);
        } catch (error) {
          // 読み込みや凍結の失敗（Guard が Context を閉じた場合など）も、その回の失敗として記録する（Ledger の違反とあわせて出す）。
          failures.push(`action:${String(error)}`);
        } finally {
          await session.close().catch((error: unknown) => {
            failures.push(`close:${String(error)}`);
          });
        }
        return { ledger: session.ledger, closeFailure: failures.length === 0 ? null : failures.join('|') };
      },
    },
  ])('$mode: records no violation and closes without failure in every round, and no POST reaches the server', async ({ mode, round: runRound }) => {
    const allRoundsWindow = openServerWindow(churnServer);
    const failedRounds: unknown[] = [];
    const excludedRounds: unknown[] = [];
    for (let round = 0; round < IFRAME_SRC_CHURN_CLOSE_ROUNDS; round += 1) {
      const { ledger, closeFailure } = await runRound(round);
      const { invariantViolations } = ledger.snapshot();
      const summary = { round, invariantViolations, closeFailure };
      if (isPreFreezeRedirectLimitRound(invariantViolations)) {
        excludedRounds.push(summary);
      } else if (invariantViolations.length !== 0 || closeFailure !== null) {
        failedRounds.push(summary);
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    console.info(`DEF-050 ${name} ${mode}: ${JSON.stringify({ rounds: IFRAME_SRC_CHURN_CLOSE_ROUNDS, failedRounds, excludedRounds })}`);

    expect(failedRounds).toEqual([]);
    expect(excludedRounds.length).toBeLessThan(IFRAME_SRC_CHURN_CLOSE_ROUNDS / 2);
    expect(allRoundsWindow.count(null, '/__mutation')).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, IFRAME_SRC_CHURN_TEST_TIMEOUT_MS);
});
