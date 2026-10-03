// P14b（Task 14〜17 の設計書 4.3.0、4.5.4）: ナビゲーションの結果を、例外ではなく結果の種類として返す。
// 応答を得たら OK（4xx・5xx も OK）、Playwright の期限切れは TIMEOUT、Passive の Ledger の blockedNavigations が増えた失敗は
// BLOCKED_EXTERNAL_REDIRECT、それ以外は FAILED。最終URLは normalizeUrl で正規化する。
import { createServer } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';
import { navigatePage } from '../../src/orchestration/page-navigation.js';
import { closePassivePageAndContext } from '../../src/orchestration/passive-session-close.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

const NAVIGATION_TIMEOUT_MS = 15_000;
const SHORT_TIMEOUT_MS = 500;
const SLOW_RESPONSE_DELAY_MS = 30_000;
/** 閉じる処理の所要時間の上限（DEF-005）。ふだんは数十ミリ秒で終わる。止まった場合は、終わらない。 */
const PASSIVE_CLOSE_BUDGET_MS = 5_000;

let browser: Browser;
let factory: BrowserContextFactory | undefined;
let context: BrowserContext | undefined;
const servers: FixtureServer[] = [];
const plainContexts: BrowserContext[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  // DEF-005: page は閉じずに、Context を閉じる（Context を閉じると、page も閉じる）。
  // Chromium は、エラーページを表示している page で、次のナビゲーションも失敗した直後に page を閉じると、
  // エラーページの確定と重なった close の要求を捨てて、page を閉じない（`page.close()` が終わらない）。
  // このファイルには、1つの page で2回失敗するテストがある。製品のコードは、ナビゲーションごとに新しい page を開くので、この形にならない。
  await closePassiveResources({ factory, context }, { forceCloseContextOnFailure: true });
  factory = undefined;
  context = undefined;
  for (const plainContext of plainContexts.splice(0)) {
    await plainContext.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options: Parameters<typeof startFixtureServer>[0] = {}): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  servers.push(server);
  return server;
}

/** 127.0.0.1 の、いま使われていないポートの Origin（ポートを一度確保して、すぐに解放する）。 */
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

async function openGuardedPage(config: AuditConfig): Promise<{ readonly page: Page; readonly ledger: SafetyLedger }> {
  factory = new BrowserContextFactory(browser, config, () => new SafetyLedger());
  context = await factory.createPassiveContext({ width: 1_024, height: 768 });
  const page = await factory.createPassivePage(context);
  return { page, ledger: factory.getSafetyLedger(context) };
}

function options(ledger: SafetyLedger, allowedQueryParameters: ReadonlySet<string> = new Set<string>()) {
  return { timeoutMs: NAVIGATION_TIMEOUT_MS, ledger, allowedQueryParameters };
}

describe('navigatePage', () => {
  it('returns OK with the HTTP status and the normalized final URL for a 200 response', async () => {
    const server = await startServer();
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(server.origin));

    const result = await navigatePage(guardedPage, `${server.origin}/index.html`, options(ledger));

    expect(result).toEqual({
      navigationOutcome: 'OK',
      httpStatus: 200,
      finalUrl: `${server.origin}/index.html`,
      failureDetail: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns OK with the HTTP status for a 404 response (the Rule decides about 4xx and 5xx)', async () => {
    const server = await startServer();
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(server.origin));

    const result = await navigatePage(guardedPage, `${server.origin}/no-such-page.html`, options(ledger));

    expect(result).toEqual({
      navigationOutcome: 'OK',
      httpStatus: 404,
      finalUrl: `${server.origin}/no-such-page.html`,
      failureDetail: null,
    });
  });

  it('normalizes the final URL with normalizeUrl and the allowed query parameters', async () => {
    const server = await startServer();
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(server.origin));

    const result = await navigatePage(
      guardedPage,
      `${server.origin}/%69ndex.html?utm_source=mail&zeta=2&drop=1&alpha=1#section`,
      options(ledger, new Set(['alpha', 'zeta'])),
    );

    expect(result).toEqual({
      navigationOutcome: 'OK',
      httpStatus: 200,
      finalUrl: `${server.origin}/index.html?alpha=1&zeta=2`,
      failureDetail: null,
    });
  });

  it('uses the final URL and status after a same-origin redirect', async () => {
    const server = await startServer();
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(server.origin));

    const result = await navigatePage(guardedPage, `${server.origin}/__technical-redirect`, options(ledger));

    expect(result).toEqual({
      navigationOutcome: 'OK',
      httpStatus: 200,
      finalUrl: `${server.origin}/js-error.html`,
      failureDetail: null,
    });
  });

  it('returns TIMEOUT when Playwright times out', async () => {
    const server = await startServer({ slowResponseDelayMs: SLOW_RESPONSE_DELAY_MS });
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(server.origin));

    const result = await navigatePage(guardedPage, `${server.origin}/__slow`, {
      timeoutMs: SHORT_TIMEOUT_MS,
      ledger,
      allowedQueryParameters: new Set<string>(),
    });

    expect(result).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: null });
    expect(result.failureDetail).toEqual(expect.any(String));
    expect(result.failureDetail?.length).toBeGreaterThan(0);
    expect(result.failureDetail?.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
  });

  it('returns BLOCKED_EXTERNAL_REDIRECT when the Guard blocks an external main-frame redirect', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const { page: guardedPage, ledger } = await openGuardedPage(createTestConfig(primary.origin));

    const result = await navigatePage(guardedPage, `${primary.origin}/__external-redirect`, options(ledger));

    expect(result).toMatchObject({ navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT', httpStatus: null });
    expect(result.failureDetail).toEqual(expect.any(String));
    expect(external.getCounters().get).toBe(0);
    expect(ledger.snapshot().blockedNavigations).toMatchObject([{
      url: `${external.origin}/external-link.html`,
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    }]);
  });

  it('returns FAILED for a port that refuses connections', async () => {
    const server = await startServer();
    const unreachableOrigin = await unusedLoopbackOrigin();
    const config = createTestConfig(server.origin);
    const { page: guardedPage, ledger } = await openGuardedPage({
      ...config,
      site: { ...config.site, allowedOrigins: [server.origin, unreachableOrigin] },
    });

    const result = await navigatePage(guardedPage, `${unreachableOrigin}/index.html`, options(ledger));

    expect(result).toMatchObject({ navigationOutcome: 'FAILED', httpStatus: null });
    expect(result.failureDetail).toEqual(expect.any(String));
    expect(result.failureDetail?.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
    expect(ledger.snapshot().blockedNavigations).toHaveLength(0);
  });

  it('judges BLOCKED_EXTERNAL_REDIRECT by the increase during this navigation, not by earlier blocked navigations', async () => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const unreachableOrigin = await unusedLoopbackOrigin();
    const config = createTestConfig(primary.origin);
    const { page: guardedPage, ledger } = await openGuardedPage({
      ...config,
      site: { ...config.site, allowedOrigins: [primary.origin, unreachableOrigin] },
    });

    const blocked = await navigatePage(guardedPage, `${primary.origin}/__external-redirect`, options(ledger));
    const failed = await navigatePage(guardedPage, `${unreachableOrigin}/index.html`, options(ledger));

    expect([blocked.navigationOutcome, failed.navigationOutcome]).toEqual(['BLOCKED_EXTERNAL_REDIRECT', 'FAILED']);
    expect(ledger.snapshot().blockedNavigations).toHaveLength(1);
  });

  it('returns FAILED instead of throwing when the page is already closed', async () => {
    const plainContext = await browser.newContext();
    plainContexts.push(plainContext);
    const closedPage = await plainContext.newPage();
    await closedPage.close();

    const result = await navigatePage(closedPage, 'http://127.0.0.1:9/index.html', options(new SafetyLedger()));

    expect(result).toMatchObject({ navigationOutcome: 'FAILED', httpStatus: null, finalUrl: null });
    expect(result.failureDetail).toEqual(expect.any(String));
  });

  it.each([
    ['a zero timeout', { timeoutMs: 0 }, RangeError],
    ['a non-integer timeout', { timeoutMs: 1.5 }, RangeError],
    ['a non-finite timeout', { timeoutMs: Number.POSITIVE_INFINITY }, RangeError],
    ['a ledger that is not a SafetyLedger', { ledger: {} }, TypeError],
    ['allowed query parameters that are not a Set', { allowedQueryParameters: ['a'] }, TypeError],
  ])('throws for %s without navigating', async (_label, override, errorType) => {
    const plainContext = await browser.newContext();
    plainContexts.push(plainContext);
    const plainPage = await plainContext.newPage();
    const invalidOptions = { ...options(new SafetyLedger()), ...override } as Parameters<typeof navigatePage>[2];

    await expect(navigatePage(plainPage, 'http://127.0.0.1:9/index.html', invalidOptions)).rejects.toThrow(errorType);
    expect(plainPage.url()).toBe('about:blank');
  });

  it('throws TypeError for a URL that is not a string without navigating', async () => {
    const plainContext = await browser.newContext();
    plainContexts.push(plainContext);
    const plainPage = await plainContext.newPage();

    await expect(navigatePage(plainPage, 42 as unknown as string, options(new SafetyLedger()))).rejects.toThrow(TypeError);
    expect(plainPage.url()).toBe('about:blank');
  });
});

// DEF-005: 実際の Run と同じ形（1つの page で1回だけナビゲーションし、その直後に、製品の閉じる処理で page と Context を閉じる）で、
// 遮断や接続拒否の後の閉じる処理が、期限の中で終わること。閉じる処理は、Page Auditor と同じ `closePassivePageAndContext` を使う。
describe('closing the guarded page and Context right after a failed navigation', () => {
  it.each([
    ['a blocked external redirect', 'BLOCKED_EXTERNAL_REDIRECT'],
    ['a refused connection', 'FAILED'],
  ] as const)('finishes within the close budget after %s', async (_label, expectedOutcome) => {
    const external = await startServer();
    const primary = await startServer({ externalRedirectUrl: `${external.origin}/external-link.html` });
    const unreachableOrigin = await unusedLoopbackOrigin();
    const config = createTestConfig(primary.origin);
    const { page: guardedPage, ledger } = await openGuardedPage({
      ...config,
      site: { ...config.site, allowedOrigins: [primary.origin, unreachableOrigin] },
    });
    const url = expectedOutcome === 'BLOCKED_EXTERNAL_REDIRECT'
      ? `${primary.origin}/__external-redirect`
      : `${unreachableOrigin}/index.html`;
    const navigation = await navigatePage(guardedPage, url, options(ledger));
    expect(navigation.navigationOutcome).toBe(expectedOutcome);
    const guardedContext = context as BrowserContext;
    const activeFactory = factory as BrowserContextFactory;

    const startedAt = performance.now();
    const failures = await closePassivePageAndContext(activeFactory, guardedContext, guardedPage);
    const elapsedMs = performance.now() - startedAt;
    factory = undefined;
    context = undefined;

    expect(failures).toEqual([]);
    expect(elapsedMs).toBeLessThan(PASSIVE_CLOSE_BUDGET_MS);
    expect(guardedPage.isClosed()).toBe(true);
    expect(isPassiveRequestGuardClosed(guardedContext)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });
});
