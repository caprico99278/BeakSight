// L9（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4・6 の L9、`2026-11-09-beaksight-coverage-by-state-design.md` 3.3 の COV-5、
// `2026-11-09-beaksight-audit-precision-triage.md` の AUD-5）: controlled scroll の期限と上限の撤廃、伸び続ける画面の止め方、内側のスクロールの全部の
// 領域の結合のテスト（既定の Chromium）。
// - 内側のスクロールの領域が 3 つあるページ: 全部をたどり、領域ごとの記録と、戻した位置が残る。
// - 伸び続ける画面: 同じ作りの行だけが増え続けると止まる（`NO_NEW_STRUCTURE`）。新しい作りの区画が後から出る画面では、その区画まで読む。
// 固まる画面で見張りが段を終えることは page-auditor-collector-watch の 'L9: keeps the partial scroll record of a page that freezes while scrolling' が、
// 前の上限を超えて読むことは controlled-scroll が確かめる。
// サーバは、このテストの中の 127.0.0.1 のサーバだけを使う。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { controlledScroll } from '../../src/browser/controlled-scroll.js';
import { CONTROLLED_SCROLL_PACING } from '../../src/core/limits.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';

const head = (title: string, style = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0}${style}</style></head><body>`;

const rows = (count: number): string => Array.from({ length: count }, () => '<div class="row"><span>row</span></div>').join('');

/** 下に近づくと（残り 200px 以下）、`append` の中身を足すスクリプト（`more` が偽を返したら足さない）。 */
const appendNearBottom = (appendBody: string, delayMs: number): string => `<script>(() => {
  let loads = 0; let pending = false;
  const check = () => {
    if (pending) return;
    if (document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) > 200) return;
    pending = true;
    setTimeout(() => { loads += 1; const main = document.querySelector('main'); ${appendBody} pending = false; check(); }, ${delayMs});
  };
  addEventListener('scroll', check, { passive: true });
})();</script>`;

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/three-boxes': `${head('three boxes', '.box{height:120px;overflow-y:auto;border:1px solid #333}.box p{height:60px;margin:0}')}<main>`
    + ['a', 'b', 'c'].map((id) => `<div class="box" id="${id}">${'<p>item</p>'.repeat(10)}</div>`).join('')
    + '</main><script>document.getElementById("b").scrollTop = 50;</script></body></html>',
  '/endless-rows': `${head('endless rows', '.row{height:40px}')}<main><h1>endless rows</h1>${rows(20)}</main>`
    + appendNearBottom('main.insertAdjacentHTML("beforeend", ' + JSON.stringify(rows(10)) + ');', 20) + '</body></html>',
  '/late-section': `${head('late section', '.row{height:40px}.promo{height:300px}')}<main><h1>late section</h1>${rows(20)}</main>`
    + appendNearBottom(
      'main.insertAdjacentHTML("beforeend", ' + JSON.stringify(rows(10)) + ');'
      + ' if (loads === 1) main.insertAdjacentHTML("beforeend", '
      + JSON.stringify('<section class="promo" role="region" aria-label="promo"><h3>promo</h3><ul><li>one</li><li>two</li></ul></section>') + ');',
      20,
    ) + '</body></html>',
});

let browser: Browser;
let context: BrowserContext | undefined;
let server: LoopbackHttpServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  await context?.close().catch(() => undefined);
  await server?.close();
  context = undefined;
  server = undefined;
});

async function openPage(path: string): Promise<Page> {
  server = await startLoopbackHttpServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
  return page;
}

describe('L9: controlled scroll without deadlines or limits', () => {
  it('traverses every one of three inner scroll containers and records each one and its restored position', async () => {
    const page = await openPage('/three-boxes');

    const result = await controlledScroll(page, CONTROLLED_SCROLL_PACING);
    const scrollTops = await page.evaluate(() => ['a', 'b', 'c'].map((id) => document.getElementById(id)?.scrollTop ?? -1));

    expect(result.status, JSON.stringify(result)).toBe('COMPLETE');
    expect(result.innerScrollContainers).toHaveLength(3);
    expect(result.innerScrollContainers?.map((container) => container.originTop)).toEqual([0, 50, 0]);
    for (const container of result.innerScrollContainers ?? []) {
      expect(container).toMatchObject({
        clientHeight: 120,
        initialScrollHeight: 600,
        finalScrollHeight: 600,
        maxScrollTop: 480,
        reachedBottom: true,
        stopReason: 'BOTTOM_AND_HEIGHT_STABLE',
        restored: true,
      });
      expect(container.stepCount).toBeGreaterThan(0);
      expect(container.selector).toMatch(/^:root > /u);
    }
    expect(scrollTops).toEqual([0, 50, 0]);
  }, 60_000);

  it('stops a page that keeps adding rows of the same structure (NO_NEW_STRUCTURE)', async () => {
    const page = await openPage('/endless-rows');

    const result = await controlledScroll(page, CONTROLLED_SCROLL_PACING);
    const rowCount = await page.evaluate(() => document.querySelectorAll('.row').length);

    expect(result.status, JSON.stringify(result.reason)).toBe('COMPLETE');
    expect(result.reason).toBe('NO_NEW_STRUCTURE');
    expect(rowCount).toBeGreaterThan(20);
    expect(result.restoration).toEqual({ status: 'RESTORED', position: { scrollX: 0, scrollY: 0 } });
  }, 60_000);

  it('reads up to a section of a new structure that a later load adds, then stops (NO_NEW_STRUCTURE)', async () => {
    const page = await openPage('/late-section');

    const result = await controlledScroll(page, CONTROLLED_SCROLL_PACING);
    const promoBottom = await page.evaluate(() => {
      const promo = document.querySelector('.promo');
      return promo === null ? null : promo.getBoundingClientRect().bottom + window.scrollY;
    });

    expect(result.reason).toBe('NO_NEW_STRUCTURE');
    expect(promoBottom).not.toBeNull();
    expect(result.observations.some((observation) => observation.scrollY + observation.viewportHeight >= (promoBottom ?? Infinity))).toBe(true);
  }, 60_000);
});
