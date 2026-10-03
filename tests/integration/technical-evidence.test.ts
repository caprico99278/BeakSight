import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;
let server: FixtureServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('technical evidence collectors', () => {
  it('passively preserves redirect, 404 resource, duplicate console, warning, and uncaught error evidence', async () => {
    const fixtureServer = await startFixtureServer();
    server = fixtureServer;
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(fixtureServer.origin, '/__technical-redirect'),
      () => new SafetyLedger(),
    );
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page, _context, ledger) => {
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

      await page.goto(`${fixtureServer.origin}/__technical-redirect`, { waitUntil: 'load' });
      await expect.poll(async () => (await consoleEvidence.snapshot()).pageErrors.length).toBe(1);

      const networkSnapshot = await network.snapshot();
      const consoleSnapshot = await consoleEvidence.snapshot();
      const redirectRequest = networkSnapshot.requests.find((request) => (
        request.url === `${fixtureServer.origin}/__technical-redirect`
      ));
      const finalRequest = networkSnapshot.requests.find((request) => (
        request.url === `${fixtureServer.origin}/js-error.html`
      ));
      const brokenImageResponse = networkSnapshot.responses.find((response) => (
        response.url === `${fixtureServer.origin}/__broken-image.png`
      ));
      const redirectResponse = networkSnapshot.responses.find((response) => (
        response.url === `${fixtureServer.origin}/__technical-redirect`
      ));
      const redirectObservation = fixtureServer.getRequestObservations().find((observation) => (
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
        expect.objectContaining({ url: `${fixtureServer.origin}/__technical-redirect`, status: 302 }),
        expect.objectContaining({ url: `${fixtureServer.origin}/js-error.html`, status: 200 }),
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
          location: expect.objectContaining({ url: `${fixtureServer.origin}/js-error.html` }),
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
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    });
  });
  it('distinguishes the main document from a subframe document 404 and records response transfer size', async () => {
    const fixtureServer = await startFixtureServer();
    server = fixtureServer;
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(fixtureServer.origin, '/missing-frame-document.html'),
      () => new SafetyLedger(),
    );
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page) => {
      const network = NetworkCollector.attach(page);

      await page.goto(`${fixtureServer.origin}/missing-frame-document.html`, { waitUntil: 'load' });
      await expect.poll(async () => (await network.snapshot()).responses.filter((response) => (
        response.transferSize.status !== 'NOT_OBSERVED'
      )).length).toBe(2);

      const snapshot = await network.snapshot();
      const mainDocument = snapshot.responses.find((response) => (
        response.url === `${fixtureServer.origin}/missing-frame-document.html`
      ));
      const frameDocument = snapshot.responses.find((response) => (
        response.url === `${fixtureServer.origin}/__missing-frame-document.html`
      ));

      expect(mainDocument).toMatchObject({ status: 200, isNavigationRequest: true, isMainFrame: true });
      expect(frameDocument).toMatchObject({ status: 404, isNavigationRequest: true, isMainFrame: false });
      expect(snapshot.requests.find((request) => request.url.endsWith('/__missing-frame-document.html')))
        .toMatchObject({ isNavigationRequest: true, isMainFrame: false });
      expect(mainDocument?.transferSize.status).toBe('OBSERVED');
      if (mainDocument?.transferSize.status === 'OBSERVED') {
        expect(mainDocument.transferSize.bodyBytes).toBeGreaterThan(0);
        expect(mainDocument.transferSize.totalBytes).toBe(
          mainDocument.transferSize.headersBytes + mainDocument.transferSize.bodyBytes,
        );
      }
      expect(snapshot).toMatchObject({ omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0 });
      network.detach();
    });
  });
});
