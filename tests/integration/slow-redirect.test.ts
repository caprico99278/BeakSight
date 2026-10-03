// C18h（DEF-013。Task 19 の前の整理の設計書 4.6）: サーバが、リクエストを受けてから1秒を超えてリダイレクトを返しても、
// Guard のリダイレクトの対応付けが期限切れにならず、`REDIRECT_PREDECESSOR_MISSING` の偽の違反にならないことを確かめる。
// 対応付けの期限は、リクエストの開始からではなく、リダイレクトの応答（3xx）を受けた時点から数える。
//
// 厳守事項: Chromium は headless だけで起動する（`useHeadlessChromium`）。検証はローカルの fixture のサーバだけで行う。
import type { Browser, Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import {
  NAVIGATION_TARGET_HEADING,
  NAVIGATION_TARGET_PAGE,
  SLOW_REDIRECT_PATH,
} from '../helpers/external-scheme-fixture.js';
import { openServerWindow, QUIET_PERIOD_MS, withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });

let browser: Browser;
let server: FixtureServer;
let factory: BrowserContextFactory;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server?.close();
});

// afterAll は登録の逆順に実行されるので、ブラウザを閉じてから、サーバを閉じる。
useHeadlessChromium((launched) => {
  browser = launched;
});

beforeAll(() => {
  factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
});

describe('C18h: a slow server redirect keeps its Guard correlation and is followed without a violation', () => {
  it('main frame: a same-origin 302 returned after 1.5 seconds loads the redirect target without a violation', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      const response = await page.goto(`${server.origin}${SLOW_REDIRECT_PATH}`, { waitUntil: 'load' });
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(response?.status()).toBe(200);
      expect(page.url()).toBe(`${server.origin}${NAVIGATION_TARGET_PAGE}`);
      expect(await page.textContent('h1')).toBe(NAVIGATION_TARGET_HEADING);
      expect(window.requestLines()).toEqual([`GET ${SLOW_REDIRECT_PATH}`, `GET ${NAVIGATION_TARGET_PAGE}`]);
    });
  });

  it('iframe: a same-origin 302 returned after 1.5 seconds loads the redirect target in the frame without a violation', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const pageUrl = `${server.origin}${NAVIGATION_TARGET_PAGE}`;
      await page.goto(pageUrl, { waitUntil: 'load' });
      const window = openServerWindow(server);

      const frameLoaded = page.waitForEvent('framenavigated', {
        predicate: (frame: Frame) => frame.parentFrame() !== null && frame.url() === pageUrl,
      });
      await page.evaluate((src) => {
        const frame = document.createElement('iframe');
        frame.src = src;
        document.body.append(frame);
      }, SLOW_REDIRECT_PATH);
      const frame = await frameLoaded;
      await frame.waitForLoadState('load');
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(page.url()).toBe(pageUrl);
      expect(await frame.textContent('h1')).toBe(NAVIGATION_TARGET_HEADING);
      expect(window.requestLines()).toEqual([`GET ${SLOW_REDIRECT_PATH}`, `GET ${NAVIGATION_TARGET_PAGE}`]);
    });
  });
});
