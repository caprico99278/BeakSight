import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { assertPassiveRequestGuardActive } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

/** CDP セッションの `close` と、それに続く Guard の無効化が観測できるまで待つ時間（ミリ秒）。 */
const GUARD_EVENT_SETTLE_MS = 500;

let browser: Browser;
let server: FixtureServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('DEF-001: axe in a guarded Passive Context', () => {
  it('runs axe without opening another page, recording invariant violations, or closing the page', async () => {
    const fixtureServer = await startFixtureServer();
    server = fixtureServer;
    const factory = new BrowserContextFactory(browser, createTestConfig(fixtureServer.origin, '/index.html'), () => new SafetyLedger());
    await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page, context, ledger) => {
      await page.goto(`${fixtureServer.origin}/index.html`, { waitUntil: 'load' });

      const pagesOpenedDuringAxe: string[] = [];
      const onPage = (opened: Page): void => {
        pagesOpenedDuringAxe.push(opened.url());
      };
      context.on('page', onPage);
      let evidence;
      try {
        evidence = await collectAccessibilityEvidence(page, { deadlineAtMs: Date.now() + 20_000 });
      } finally {
        context.off('page', onPage);
      }
      await new Promise((resolve) => setTimeout(resolve, GUARD_EVENT_SETTLE_MS));

      let guardActive = true;
      try {
        assertPassiveRequestGuardActive(context);
      } catch {
        guardActive = false;
      }
      expect({
        status: evidence.status,
        pagesOpenedDuringAxe,
        invariantViolations: ledger.snapshot().invariantViolations,
        pageClosed: page.isClosed(),
        guardActive,
        onlyOwnerPageOpen: context.pages().length === 1 && context.pages()[0] === page,
      }).toEqual({
        status: 'COMPLETE',
        pagesOpenedDuringAxe: [],
        invariantViolations: [],
        pageClosed: false,
        guardActive: true,
        onlyOwnerPageOpen: true,
      });
    });
  });
});
