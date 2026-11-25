// BS-2（設計書 `doc/design/2026-11-20-beaksight-key-action-positions-design.md` 2.2）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// 長いページの下の固定の帯（電話・メッセージ・予約）と、本文の下の方の問い合わせのリンクを、layout の読み取りが主要な行動の候補として記録し、電話番号を残さない。
// 値は作り物。
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { keyActionKindOf } from '../../src/core/key-actions.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT: Viewport = Object.freeze({ width: 400, height: 600 });
const PHONE_NUMBER = '0120-000-000';
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>long</title>'
  + '<style>html, body { margin: 0; }</style></head><body><main><h1>見出し</h1><p>本文です。</p><a href="/about">会社の案内</a>'
  + '<div style="height: 2400px"></div><a id="contact" href="/contact">お問い合わせ</a></main>'
  + `<div id="bar" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 60px; background: #fff">`
  + `<a id="tel" href="tel:${PHONE_NUMBER.replaceAll('-', '')}">電話 ${PHONE_NUMBER}</a>`
  + '<a id="chat" href="https://line.me/R/ti/p/example">メッセージ</a><button id="book" type="button">予約</button></div></body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

describe('BS-2: the key action candidates read by the layout collector', () => {
  it('records the candidates of the fixed bar and the footer link, with the fixed container, and without the phone number', async () => {
    server = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    const { origin } = server;
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const layout = await withGuardedPassivePage(factory, VIEWPORT, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      const result = await collectLayoutEvidence(page, VIEWPORT);
      if (result.status !== 'COMPLETE') {
        throw new Error('layout collection was not complete');
      }
      return result.layout;
    });
    const elements = layout.keyActionElements ?? [];
    expect(elements.map((element) => [element.selector, keyActionKindOf(element), element.fixedContainerSelector, element.rect.top >= VIEWPORT.height])).toEqual([
      ['#contact', 'CONTACT', null, true],
      ['#tel', 'PHONE', '#bar', false],
      ['#chat', 'MESSAGE', '#bar', false],
      ['#book', 'BOOKING', '#bar', false],
    ]);
    expect(JSON.stringify(layout)).not.toContain(PHONE_NUMBER);
    expect(JSON.stringify(layout)).not.toContain(PHONE_NUMBER.replaceAll('-', ''));
  });
});
