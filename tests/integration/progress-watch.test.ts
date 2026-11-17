// L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L0）: 進みの見張りの結合のテスト（既定の Chromium の 1 つ。Guard つきの Passive
// Context）。見張る段は、落ち着きの待ち（`waitForPageSettled`。差し込み口 `progress`）と、ページの自発の変化の印（`attachPageProgressSignals`）。今の期限
// （`deadlineAtMs`）は長く（10 分）して並べ、見張りが段を終えることを確かめる。
// - 固まるページ（ページの中の JS が `while (true) {}` で main thread を止める）: 段は「応答しなかった」で終わり、次のページ（新しい Context）へ進んで読める。
// - 遅いが進むページ（1 秒ごとに 100 件ずつ、回ごとに新しい作りの要素を足す。合計 1 分。反応なしの長さより長い）: 段を終えずに最後まで待ち、全部
//   （6,000 件）を集める。DEF-245 の B・D の後は、窓を始め直すのは新しい作りの印が出たときだけなので、回ごとに要素の名前を変える。
// - 新しい path へ送り続けるページ（200ms ごとに新しい path へ fetch する。データの要求の数え方 `dataActivity` を渡す）: DEF-283 の後は、中身の進みが
//   開いた要求の静まりの長さ止まったところで落ち着き、見張りは段を終えない（前は「静まらない」で終わった）。
// - 周期のアニメーションだけのページ（高さが周期的に伸び縮みする。新しい作りは出ない）: 高さの行き来では窓を始め直さないので、速く落ち着く。
// 反応なしの長さは、テストでは 10 秒に縮める（製品は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { attachPageProgressSignals } from '../../src/browser/page-progress-signals.js';
import { waitForPageSettled, type DataActivity } from '../../src/browser/page-settling.js';
import { progressWatchEndReason, watchProgress, type WatchedOutcome } from '../../src/core/progress-watch.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';
import type { PageSettlingResult } from '../../src/browser/page-settling.js';

/** テストの反応なしの長さ（ms）。 */
const TEST_QUIET_LIMIT_MS = 10_000;
/** 今の期限（並べるだけ。見張りより先に来ないよう長くする）。 */
const LONG_EXISTING_DEADLINE_MS = 10 * 60_000;
/** 遅いが進むページ: 1 秒ごとに足す件数と、回数（合計 1 分）。 */
const SLOW_BATCH_SIZE = 100;
const SLOW_BATCH_COUNT = 60;
/** 遅いが進むページの落ち着きの窓（足す間隔の 1 秒より長く、反応なしの長さより短くする）。 */
const SLOW_STABLE_WINDOW_MS = 3_000;
/** 静まらないページが fetch する path の始まり（回ごとに新しい path）。 */
const TICK_PATH_PREFIX = '/tick/';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/hang': '<!doctype html><title>hang</title><p>ok</p><script>setTimeout(() => { while (true) {} }, 300);</script>',
  '/next': '<!doctype html><title>next</title><p>next page</p>',
  // 回ごとに要素の名前（英字）を変える（新しい作りの印を出す）。
  '/slow': `<!doctype html><title>slow</title><div id="list"></div><script>
const letters = (n) => { let text = ''; do { text = String.fromCharCode(97 + (n % 26)) + text; n = Math.floor(n / 26) - 1; } while (n >= 0); return text; };
let batches = 0;
const timer = setInterval(() => {
  const list = document.getElementById('list');
  for (let index = 0; index < ${String(SLOW_BATCH_SIZE)}; index += 1) {
    const item = document.createElement('row-' + letters(batches));
    item.textContent = 'item ' + String(batches * ${String(SLOW_BATCH_SIZE)} + index);
    list.appendChild(item);
  }
  batches += 1;
  if (batches >= ${String(SLOW_BATCH_COUNT)}) { clearInterval(timer); }
}, 1000);
</script>`,
  '/poll': `<!doctype html><title>poll</title><p>poll</p><script>
let ticks = 0;
setInterval(() => { ticks += 1; fetch('${TICK_PATH_PREFIX}' + String(ticks)).then((response) => response.text()).catch(() => 0); }, 200);
</script>`,
  '/periodic': `<!doctype html><title>periodic</title><div id="box" style="height:1000px">box</div><script>
let tall = false;
setInterval(() => { tall = !tall; document.getElementById('box').style.height = tall ? '1400px' : '1000px'; }, 200);
</script>`,
});

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const opened: { factory: BrowserContextFactory; context: BrowserContext }[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  for (const resources of opened.splice(0)) {
    await closePassiveResources(resources, { forceCloseContextOnFailure: true });
  }
  await server?.close();
  server = undefined;
});

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    if ((request.url ?? '').startsWith(TICK_PATH_PREFIX)) {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server;
};

/** 新しい Passive Context（Guard つき）で `pathname` を開く。`beforeLoad` は読み込みの前に page を受け取る（要求の数え方を付けるため）。 */
const openPage = async (origin: string, pathname: string, beforeLoad?: (page: Page) => void): Promise<Page> => {
  const factory = new BrowserContextFactory(browser, createTestConfig(origin, pathname), () => new SafetyLedger());
  const context = await factory.createPassiveContext({ width: 800, height: 600 });
  opened.push({ factory, context });
  const page = await factory.createPassivePage(context);
  beforeLoad?.(page);
  await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded' });
  return page;
};

/** 見張りつきの落ち着きの待ち（見張る段）。`dataActivity` はデータの要求の数え方。 */
const watchedSettling = (page: Page, stableWindowMs = 2_000, dataActivity?: () => DataActivity): Promise<WatchedOutcome<PageSettlingResult>> =>
  watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals, { domPollIntervalMs: 250 });
    try {
      return await waitForPageSettled(page, {
        deadlineAtMs: Date.now() + LONG_EXISTING_DEADLINE_MS,
        pollIntervalMs: 100,
        stableWindowMs,
        progress: signals,
        dataActivity,
      });
    } finally {
      detach();
    }
  }, { quietLimitMs: TEST_QUIET_LIMIT_MS });

describe('L0: the progress watch with Chromium', () => {
  it('ends the stage of a frozen page as unresponsive, and goes on to the next page', async () => {
    const { origin } = await startServer();
    const hung = await openPage(origin, '/hang');
    const startedAtMs = Date.now();

    const outcome = await watchedSettling(hung);
    const elapsedMs = Date.now() - startedAtMs;

    expect(outcome).toEqual({ status: 'ENDED', end: 'STAGE_UNRESPONSIVE' });
    expect(progressWatchEndReason('settling', 'STAGE_UNRESPONSIVE')).toEqual({ code: 'STAGE_UNRESPONSIVE', detail: 'settling' });
    // 反応なしの長さで終わる（今の期限 10 分は待たない）。
    expect(elapsedMs).toBeGreaterThanOrEqual(TEST_QUIET_LIMIT_MS - 1_000);
    expect(elapsedMs).toBeLessThan(TEST_QUIET_LIMIT_MS * 3);

    // 次のページ（新しい Context）へ進み、読める。
    const next = await openPage(origin, '/next');
    await expect(watchedSettling(next)).resolves.toMatchObject({ status: 'FULFILLED', value: { status: 'SETTLED' } });
  }, 90_000);

  it('waits for a slow page that keeps progressing beyond the quiet limit, and collects everything', async () => {
    const { origin } = await startServer();
    const slow = await openPage(origin, '/slow');
    const startedAtMs = Date.now();

    const outcome = await watchedSettling(slow, SLOW_STABLE_WINDOW_MS);
    const elapsedMs = Date.now() - startedAtMs;

    expect(outcome).toMatchObject({ status: 'FULFILLED', value: { status: 'SETTLED' } });
    // 反応なしの長さを何倍も超えて待った。
    expect(elapsedMs).toBeGreaterThan(TEST_QUIET_LIMIT_MS * 5);
    // 最後まで集める。
    await expect(slow.locator('#list > *').count()).resolves.toBe(SLOW_BATCH_SIZE * SLOW_BATCH_COUNT);
  }, 3 * 60_000);

  it('settles a page that keeps fetching new paths before the watch ends the stage (DEF-283)', async () => {
    const { origin } = await startServer();
    let counter: InFlightRequestCounter | undefined;
    const polling = await openPage(origin, '/poll', (page) => {
      counter = new InFlightRequestCounter(page);
    });
    const startedAtMs = Date.now();

    try {
      const outcome = await watchedSettling(polling, undefined, () => (counter as InFlightRequestCounter).dataActivity());
      const elapsedMs = Date.now() - startedAtMs;

      expect(outcome).toMatchObject({ status: 'FULFILLED', value: { status: 'SETTLED' } });
      expect(elapsedMs).toBeLessThan(TEST_QUIET_LIMIT_MS);
    } finally {
      counter?.dispose();
    }
  }, 90_000);

  it('settles a page that only keeps a periodic animation quickly', async () => {
    const { origin } = await startServer();
    const periodic = await openPage(origin, '/periodic');
    const startedAtMs = Date.now();

    const outcome = await watchedSettling(periodic);
    const elapsedMs = Date.now() - startedAtMs;

    expect(outcome).toMatchObject({ status: 'FULFILLED', value: { status: 'SETTLED' } });
    expect(elapsedMs).toBeLessThan(TEST_QUIET_LIMIT_MS);
  }, 90_000);
});
