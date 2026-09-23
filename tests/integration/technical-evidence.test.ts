import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';

let browser: Browser;
let context: BrowserContext | undefined;
let factory: BrowserContextFactory | undefined;
let page: Page | undefined;
let server: FixtureServer | undefined;

function configFor(origin: string): AuditConfig {
  return {
    ...DEFAULT_CONFIG,
    site: { startUrl: `${origin}/__technical-redirect`, allowedOrigins: [origin] },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
    viewports: {
      primaryDesktop: { ...DEFAULT_CONFIG.viewports.primaryDesktop },
      primaryMobile: { ...DEFAULT_CONFIG.viewports.primaryMobile },
      stressWidths: [...DEFAULT_CONFIG.viewports.stressWidths],
    },
  };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  if (page !== undefined && !page.isClosed() && factory !== undefined) {
    await factory.closePassivePage(page).catch(() => undefined);
  }
  if (context !== undefined && context.browser() !== null && factory !== undefined) {
    await factory.closePassiveContext(context).catch(() => undefined);
  }
  await server?.close();
  page = undefined;
  context = undefined;
  factory = undefined;
  server = undefined;
});

afterAll(async () => {
  await browser.close();
});

describe('technical evidence collectors', () => {
  it('passively preserves redirect, 404 resource, duplicate console, warning, and uncaught error evidence', async () => {
    server = await startFixtureServer();
    factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
    context = await factory.createPassiveContext({ width: 800, height: 600 });
    page = await factory.createPassivePage(context);
    await page.setExtraHTTPHeaders({
      Authorization: 'Bearer fixture-request-secret',
      Cookie: 'fixture-cookie=request-secret',
      Traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      Tracestate: 'fixture=request',
      'X-Request-Id': 'fixture-request-id',
      'X-Correlation-Id': 'fixture-correlation-id',
      'X-Unselected-Secret': 'must-not-enter-evidence',
    });
    const network = NetworkCollector.attach(page);
    const consoleEvidence = ConsoleCollector.attach(page);

    await page.goto(`${server.origin}/__technical-redirect`, { waitUntil: 'load' });
    await expect.poll(async () => (await consoleEvidence.snapshot()).pageErrors.length).toBe(1);

    const networkSnapshot = await network.snapshot();
    const consoleSnapshot = await consoleEvidence.snapshot();
    const redirectRequest = networkSnapshot.requests.find((request) => (
      request.url === `${server?.origin}/__technical-redirect`
    ));
    const finalRequest = networkSnapshot.requests.find((request) => (
      request.url === `${server?.origin}/js-error.html`
    ));
    const brokenImageResponse = networkSnapshot.responses.find((response) => (
      response.url === `${server?.origin}/__broken-image.png`
    ));
    const redirectResponse = networkSnapshot.responses.find((response) => (
      response.url === `${server?.origin}/__technical-redirect`
    ));
    const redirectObservation = server.getRequestObservations().find((observation) => (
      observation.pathname === '/__technical-redirect'
    ));

    expect(redirectRequest?.redirectToRequestId).toBe(finalRequest?.requestId);
    expect(finalRequest?.redirectFromRequestId).toBe(redirectRequest?.requestId);
    expect(finalRequest?.redirectChainRequestIds).toEqual([redirectRequest?.requestId]);
    expect(redirectObservation).toMatchObject({
      cookie: 'fixture-cookie=request-secret',
      authorization: 'Bearer fixture-request-secret',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'fixture=request',
      requestId: 'fixture-request-id',
      correlationId: 'fixture-correlation-id',
      unselectedSecret: 'must-not-enter-evidence',
    });
    expect(redirectRequest?.headers).toEqual({
      status: 'OBSERVED',
      values: expect.objectContaining({
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'fixture=request',
        'x-request-id': 'fixture-request-id',
        'x-correlation-id': 'fixture-correlation-id',
      }),
    });
    expect(networkSnapshot.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${server.origin}/__technical-redirect`, status: 302 }),
      expect.objectContaining({ url: `${server.origin}/js-error.html`, status: 200 }),
    ]));
    expect(brokenImageResponse).toMatchObject({
      status: 404,
      contentLengthHeader: '13',
      headers: {
        status: 'OBSERVED',
        values: expect.objectContaining({
          'content-type': 'image/png',
          'content-length': '13',
          'x-api-key': '[REDACTED]',
          'x-request-id': 'fixture-image-request-id',
        }),
      },
    });
    expect(redirectResponse).toMatchObject({
      status: 302,
      headers: {
        status: 'OBSERVED',
        values: expect.objectContaining({
          'set-cookie': '[REDACTED]',
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          tracestate: 'fixture=redirect',
          'x-request-id': 'fixture-response-request-id',
          'x-correlation-id': 'fixture-response-correlation-id',
        }),
      },
    });
    expect(JSON.stringify(networkSnapshot)).not.toContain('fixture-request-secret');
    expect(JSON.stringify(networkSnapshot)).not.toContain('fixture-response-secret');
    expect(JSON.stringify(networkSnapshot)).not.toContain('must-not-enter-evidence');

    expect(consoleSnapshot.consoleMessages.filter((message) => (
      message.type === 'error' && message.text === 'fixture duplicate error'
    ))).toHaveLength(2);
    expect(consoleSnapshot.consoleMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'warning',
        text: 'fixture console warning',
        location: expect.objectContaining({ url: `${server.origin}/js-error.html` }),
      }),
    ]));
    expect(consoleSnapshot.pageErrors).toEqual([
      expect.objectContaining({
        name: 'Error',
        message: 'fixture uncaught exception',
        stack: expect.stringContaining('js-error.html'),
      }),
    ]);
    expect(Object.isFrozen(consoleSnapshot)).toBe(true);
    expect(Object.isFrozen(consoleSnapshot.consoleMessages)).toBe(true);
    expect(Object.isFrozen(consoleSnapshot.consoleMessages[0]?.location)).toBe(true);
    expect(Object.isFrozen(consoleSnapshot.pageErrors[0])).toBe(true);

    network.detach();
    consoleEvidence.detach();
    await page.evaluate(() => console.error('late fixture console error'));
    expect(await consoleEvidence.snapshot()).toEqual(consoleSnapshot);
    expect(await network.snapshot()).toEqual(networkSnapshot);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  });
});
