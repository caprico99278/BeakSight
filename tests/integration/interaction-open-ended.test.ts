// L5（INV-LIMITS の表 A の T11・T21・N5。設計者の判断 2026-11-10）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - 押した後の観測は、決まった期限（前は操作の期限 3 秒）ではなく、ページの落ち着き（`waitForPageSettled` と口ごとの静まり）で終える。押してから 4 秒後に届く
//   データで開く部品も、確かめられる（前は `NO_OBSERVABLE_CHANGE`）。
// - Mobile では、Desktop の同じページになかった候補だけを確かめる（同じ候補は 2 回確かめない）。Mobile にだけある候補は確かめる。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 300_000;
/** 押してからデータが届くまでの長さ（前の操作の期限 3 秒より長い）。 */
const SLOW_DATA_MS = 4_000;

const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>slow toggle</title>'
  + '<style>@media (max-width: 600px) { #wide { display: none; } } @media (min-width: 601px) { #narrow { display: none; } }</style></head><body><main><h1>開く部品</h1>'
  + '<button id="slow" type="button" aria-expanded="false" aria-controls="slow-panel">詳しく</button><div id="slow-panel" hidden></div>'
  + '<button id="narrow" type="button" aria-expanded="false" aria-controls="narrow-panel">メニュー</button><div id="narrow-panel" hidden>中身</div>'
  + '<span id="wide"></span>'
  + '</main><script>'
  + "document.getElementById('slow').addEventListener('click', () => { fetch('/api/slow').then((r) => r.text()).then((text) => {"
  + " const b = document.getElementById('slow'); b.setAttribute('aria-expanded', 'true'); const p = document.getElementById('slow-panel'); p.textContent = text; p.hidden = false; }); });"
  + "document.getElementById('narrow').addEventListener('click', () => { const b = document.getElementById('narrow');"
  + " b.setAttribute('aria-expanded', 'true'); document.getElementById('narrow-panel').hidden = false; });"
  + '</script></body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const directories: string[] = [];

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
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

describe('L5: the interaction waits for the page to settle instead of a fixed timeout', () => {
  it('verifies a control that opens with data arriving later than the former timeout, and checks on mobile only what desktop did not show', async () => {
    server = await startLoopbackHttpServer((request, response) => {
      if (request.url === '/api/slow') {
        setTimeout(() => response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('遅れて届いた中身'), SLOW_DATA_MS);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    const { origin } = server;
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [] },
      audit: { performance: false, accessibility: false, screenshots: false, interactions: true },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-interaction-open-'));
    directories.push(root);
    const auditor = new PageAuditor({
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: root,
      navigationPacer: createTestNavigationPacer(config),
      safetyViolationRecorded: () => false,
    });
    const normalized = normalizeUrl(`${origin}/`, `${origin}/`, new Set());
    if (!normalized.ok) {
      throw new Error('fixture URL must normalize');
    }
    const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
    const interactions = (viewport: string) => outcome.result.evidence.flatMap((record) =>
      (record.type === 'interaction' && record.viewport === viewport ? [record.payload] : []));

    // Desktop: 遅れて届くデータで開く部品も確かめられる（狭い画面だけのメニューは見えないので、見えない候補として確かめない）。
    const pressed = (viewport: string, nested: boolean) => outcome.result.evidence.flatMap((record) =>
      (record.type === 'interaction' && record.viewport === viewport && (record.payload.pressTrail !== undefined) === nested
        ? [[record.payload.status, record.payload.reason]] : []));
    expect(pressed('desktop', false)).toEqual([
      ['VERIFIED', 'OBSERVABLE_STATE_CHANGED'],
      ['REJECTED_UNSAFE', 'NOT_VISIBLE'],
    ]);
    // COV-4 の入れ子の開いた状態（設計者の判断 2026-11-10。重なりではない）: 開いた状態は、まだ見ていない（状態・候補）の組なので、その中の候補をもう一度
    // 押す。開閉の部品（詳しく）は、開いたままなので変化がなく（NO_OBSERVABLE_CHANGE）、狭い画面だけのメニューは、開いた状態でも見えない（NOT_VISIBLE）。
    expect(pressed('desktop', true)).toEqual([
      ['NOT_VERIFIABLE', 'NO_OBSERVABLE_CHANGE'],
      ['REJECTED_UNSAFE', 'NOT_VISIBLE'],
    ]);
    // Mobile: Desktop と同じ部品（詳しく）は確かめ直さず、Mobile にだけある部品（メニュー）だけを確かめる。
    expect(interactions('mobile').map(({ status }) => status)).toEqual(['VERIFIED']);
  }, TEST_TIMEOUT_MS);
});
