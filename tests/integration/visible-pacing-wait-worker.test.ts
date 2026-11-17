// DEF-236（設計書 `doc/design/2026-11-09-beaksight-visible-pacing-wait-design.md` 3.2・7 章）: 1 画面の読み込み（`visitGuardedPage`。操作さがし・READ の確かめ・
// 書き込みの段が使う口）も、監査と同じく、新しい空の画面を見せたまま待たず、前の画面を閉じずに見せたまま読み込みの間隔を待つ。
// - 読み込みの間隔の待ち（`beforeNavigation`）は、セッションを作る前（開いた画面がない時）に行う。
// - 読み取りを終えた後、閉じる前に、その画面を見せたまま待つ（`waitUntilNextNavigationDue`）。呼ぶ側が次の読み込みがないと伝えたら、待たない。
// - 待ちの間の DELETE は届かず、止めた要求の数（`blockedRequests`）に入らず、Ledger には残る。要求の数（`pageLoad`）は、待ちのない読み込みと同じ。
// Chromium はテストの既定の headless と、CLI の起動の設定の両方。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { visitGuardedPage, type GuardedPageVisit } from '../../src/worker/worker-run-session.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = chromiumRunsOf([
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
]);
const INTERVAL_MS = 1_500;
/** 待ちの間の通信の後、止めた DELETE の記録が残るまでの間（テストの包みが待ちの中で待つ）。 */
const ACTIVITY_SETTLE_MS = 300;
const TEST_TIMEOUT_MS = 90_000;

type PacerCall = { readonly kind: 'before' | 'due'; readonly shown: readonly string[]; readonly waitedMs: number };

const PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧</title><link rel="icon" href="data:,"></head><body>'
  + '<h1>一覧</h1><script>fetch("/data?x=1").catch(() => undefined);'
  + 'window.__waitActivity = async () => { fetch("/data?id=1&wait=1", { method: "DELETE" }).catch(() => undefined);'
  + ' await fetch("/data?wait=1").catch(() => undefined); return true; };</script></body></html>';

describe.each(LAUNCHERS)('DEF-236: a guarded page visit waits with the previous page shown (%s)', (_label, launch) => {
  let server: LoopbackHttpServer | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await server?.close();
    server = undefined;
  });

  it('waits before opening the next page, shows the read page during the wait, and does not count its requests', async () => {
    const received: { readonly method: string; readonly url: string }[] = [];
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      received.push({ method: request.method ?? 'GET', url: request.url ?? '/' });
      if ((request.url ?? '/').startsWith('/data')) {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end('[]');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(PAGE_HTML);
    });
    const { origin } = server;
    const launched = await launch();
    browser = launched;
    const shownPages = (): Page[] => testContextsOf(launched).flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    const calls: PacerCall[] = [];
    const inner = createNavigationPacer({ minIntervalMs: INTERVAL_MS, now: () => Date.now(), sleep: wait });
    let activity = true;
    const pacer: NavigationPacer = {
      beforeNavigation: async () => {
        const shown = shownPages().map((page) => page.url());
        const waitedMs = await inner.beforeNavigation();
        calls.push({ kind: 'before', shown, waitedMs });
        return waitedMs;
      },
      waitUntilNextNavigationDue: async () => {
        const pages = shownPages();
        if (activity && pages.length === 1) {
          await (pages[0] as Page).evaluate(async () => (window as unknown as { __waitActivity: () => Promise<boolean> }).__waitActivity()).catch(() => false);
        }
        const waitedMs = await inner.waitUntilNextNavigationDue();
        if (activity) {
          await wait(ACTIVITY_SETTLE_MS);
        }
        calls.push({ kind: 'due', shown: pages.map((page) => page.url()), waitedMs });
        return waitedMs;
      },
      snapshot: () => inner.snapshot(),
      raiseMinimumInterval: (ms) => inner.raiseMinimumInterval(ms),
      recordDocumentRequestSent: () => inner.recordDocumentRequestSent(),
    };
    const config = createTestConfig(origin, '/list', { crawl: { minNavigationIntervalMs: INTERVAL_MS } });
    const ledgers: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(launched, config, () => {
      const ledger = new SafetyLedger();
      ledgers.push(ledger);
      return ledger;
    }, { ...TEST_FACTORY_OPTIONS, navigationPacer: pacer });
    const options = { config, allowedQueryParameters: new Set<string>() };
    const read = async ({ page }: { readonly page: Page }): Promise<string> => page.title();

    // 1 画面目: 読み取りの後、見せたまま待つ（待ちの間に DELETE と読み取りを出す）。2 画面目: 次の読み込みがないと伝える（待たない）。
    const first = await visitGuardedPage(factory, pacer, `${origin}/list?n=1`, options, read);
    activity = false;
    const second = await visitGuardedPage(factory, pacer, `${origin}/list?n=2`, { ...options, pacingWaitBeforeClose: false }, read);

    expect(calls.map((call) => call.kind)).toEqual(['before', 'due', 'before']);
    // 読み込みの間隔は、セッションを作る前に待つ（空の画面を見せない）。待ちの間は、読んだ画面を見せたまま。
    expect(calls.filter((call) => call.kind === 'before').map((call) => call.shown)).toEqual([[], []]);
    expect(calls.find((call) => call.kind === 'due')?.shown).toEqual([`${origin}/list?n=1`]);
    expect(calls.find((call) => call.kind === 'due')?.waitedMs).toBeGreaterThan(0);
    expect(calls.at(-1)?.waitedMs).toBeLessThan(100);
    // 待ちの間の DELETE は届かず、止めた要求の数に入らず、Ledger には残る。要求の数は、待ちのない読み込みと同じ。
    expect(received.filter((record) => record.method === 'DELETE')).toEqual([]);
    expect(received.filter((record) => record.url.includes('wait=1')).length).toBeGreaterThan(0);
    const visited = (visit: GuardedPageVisit<string>): Extract<GuardedPageVisit<string>, { kind: 'VISITED' }> => {
      if (visit.kind !== 'VISITED') {
        throw new Error(`the page was not read: ${visit.kind}`);
      }
      return visit;
    };
    expect([visited(first).value, visited(second).value]).toEqual(['一覧', '一覧']);
    expect([visited(first).blockedRequests, visited(first).violation]).toEqual([0, false]);
    expect(ledgers.flatMap((ledger) => ledger.snapshot().blockedRequests).filter((event) => event.method === 'DELETE').map((event) => event.phase))
      .toEqual(['CLOSING']);
    expect(visited(first).pageLoad).toEqual(visited(second).pageLoad);
  }, TEST_TIMEOUT_MS);
});
