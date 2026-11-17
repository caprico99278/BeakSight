// RB-14b: `passive-request-guard.test.ts` のうち、本物の Chromium で確かめる 27 場面（Playwright の前提・口の誤用・サーバとの境目・DEF-050 の閉じる競り）。
// 偽の Context と偽の CDP の session で確かめる場面は、単体の project の `passive-request-guard.test.ts` に残した。
// このファイルの Guard は、送信の扱いの口（`auditSend`）なしで付ける（人が選んだ READ_ONLY と同じ形）。
import type { ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { closePassivePageAndContext } from '../../src/orchestration/passive-session-close.js';
import {
  awaitPassiveRequestGuardReady,
  CDP_SESSION_DETACHED_MESSAGE,
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, useHeadlessChromium } from '../helpers/chromium.js';
import { FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS, NO_NON_READ_REQUESTS, openServerWindow } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { roundsOf } from '../helpers/test-rounds.js';

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
  const server = await startLoopbackHttpServer((request, response) => {
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
  const hanging: HangingServer = {
    origin: server.origin,
    hangReceived,
    cutHang: () => {
      cut = true;
      for (const response of pendingHangs.splice(0)) response.socket?.destroy();
    },
    close: server.close,
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

/**
 * SAFE-2 の 4（違反の区分の (3)）: 許した読み取り（GET・HEAD）の main frame の移動の失敗は、違反でなく読み取りの失敗の記録（`readNavigationFailures`）になる。
 * その記録（method・Origin と path・失敗の理由）の一覧。
 */
const readFailuresOf = (ledger: SafetyLedger): readonly string[] =>
  (ledger.snapshot().readNavigationFailures?.events ?? []).map(({ method, url, errorText }) => `${method} ${url} ${errorText}`);

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
      message: CDP_SESSION_DETACHED_MESSAGE,
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
    // Context が閉じる。違反のコードは、Guard の page の session が外れたことの `CDP_SESSION_DETACHED` である。
    // RB-4 fix（DEF-274）: 読み込みの取り消し（`net::ERR_ABORTED`）が読み取りの失敗の記録に残るかは期待に書かない。読み取りなので、記録に残っても安全の
    // 決まりに反しない（SAFE-2 の 4）。page の close の後は、取り消しの証拠を確かめられずに記録に残ることがある。
    await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([{
      code: 'CDP_SESSION_DETACHED',
      message: CDP_SESSION_DETACHED_MESSAGE,
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

  // FIN-1（SD-2 の 2.4）: 許可 Origin の外へのリダイレクトの続きは止めない（届き、止めた記録はない。移った画面を点検しないのは読み込みの部品）。
  it('lets an external redirect follow-up through and allows external image and script GET subresources', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([primary.origin]));
    const page = await createGuardedPage(context);

    const redirectOutcome = await page.goto(`${primary.origin}/__external-redirect`)
      .then((response) => ({ kind: 'RESOLVED' as const, url: response?.url() }))
      .catch(() => ({ kind: 'REJECTED' as const }));
    expect({
      redirectOutcome,
      externalGet: external.getCounters().get,
      blockedNavigations: ledger.snapshot().blockedNavigations,
    }).toMatchObject({
      redirectOutcome: { kind: 'RESOLVED', url: `${external.origin}/external-link.html` },
      externalGet: 1,
      blockedNavigations: [],
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
    // リダイレクトの続きの 1 件と、script と画像の 2 件。
    expect(external.getCounters().get).toBe(3);
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

  // FIN-1（SD-2 の 2.4）: 「許可 Origin の写しを取り、外への直の main frame の移動を止める」場面は消した（main frame の移動は許可 Origin の外でも止めない）。

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
    // DEF-144: 違反は、結びつく要求（method・Origin・path）も持つ。
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'PASSIVE_GUARD_PAGE_NOT_READY',
      message: expect.stringContaining('before explicit page readiness'),
      request: expect.objectContaining({ method: 'GET' }),
    })]));
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

  // SAFE-2 の 4: 一覧にない読み取りの失敗は、違反でなく読み取りの失敗の記録になる（前は違反で、Context を無効にした）。
  it('records an unlisted failure (net::ERR_FAILED) of an allowed main-frame GET as a read failure', async () => {
    const server = await startServer();
    const ledger = new SafetyLedger();
    const context = await createGuardedContext(ledger, new Set([server.origin]));
    const page = await createGuardedPage(context);
    // ページの route は、Guard の Context の route より先に動く。Guard が中断したものではない失敗を起こす。
    await page.route(`${server.origin}/index.html`, (route) => route.abort('failed'));

    await expect(page.goto(`${server.origin}/index.html`)).rejects.toThrow();

    await expect.poll(() => readFailuresOf(ledger)).toEqual([`GET ${server.origin}/index.html net::ERR_FAILED`]);
  });

  // DEF-004b（RDEF4 Minor-1）: 許可した GET のメインフレームのナビゲーションを、サーバが受け取った後にソケットを切って失敗させる。
  // 凍結の前（Passive）は記録せず、凍結中は記録する（SAFE-2 の 4 から、違反でなく読み取りの失敗の記録。Context は無効にしない）。
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

  it('records a listed network-layer failure of an allowed main-frame GET during interaction freeze as a read failure', async () => {
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
    await expect.poll(() => ledger.snapshot().readNavigationFailures?.events).toEqual([{
      method: 'GET', url: `${server.origin}/hang`, errorText: expect.stringMatching(LISTED_SOCKET_CLOSE_FAILURE), phase: 'INTERACTION',
    }]);
  });

  // FIN-1（SD-2 の 2.4）: 何段かのリダイレクトの、許可 Origin の外の最後の段も止めない。
  it('lets a multi-hop internal redirect reach its external final hop', async () => {
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
      outcome: 'RESOLVED',
      primaryGet: 1,
      middleGet: 1,
      externalGet: 1,
      snapshot: { blockedNavigations: [], invariantViolations: [] },
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
      phase: 'LOAD',
    }]);
    expect(ledger.snapshot().invariantViolations).toHaveLength(0);
  });
});

/** DEF-050 の実機の確かめで、iframe の `src` を 1 ms ごとに変えるページ（`fixtures/site/`）。 */
const IFRAME_SRC_CHURN_PAGE = '/iframe-src-churn.html';
/** DEF-050 の実機の確かめの viewport。 */
const viewportForChurn: Viewport = Object.freeze({ width: 800, height: 600 });
/**
 * DEF-050 の実機の確かめで、読み込み → Context を閉じる処理をくり返す回数。NPR2 の再現の実験では、修正の前に、Passive の Context を
 * 閉じる場面で、headless shell は 20 回のうち 3 回、CLI の Chromium は 20 回のうち 4 回、違反が出た。値は `test-rounds.ts`（TS-b。ふだんの組と
 * 全部の組）。
 */
const IFRAME_SRC_CHURN_CLOSE_ROUNDS = roundsOf('iframeSrcChurnClose');
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
describe.each(chromiumRunsOf([
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: (): Promise<Browser> => launchCliChromium() },
]))('DEF-050: closing the Context of a page that keeps changing its iframe src, with $name', ({ name, launch }) => {
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
