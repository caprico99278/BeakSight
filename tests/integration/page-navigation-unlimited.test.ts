// L14（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 6 の L14、INV-LIMITS の表 A の T10）: 読み込みの期限（`crawl.navigationTimeoutMs`）を
// 利用者が指定していなければ、期限を置かず、進みの見張りで待つ。全く反応のないサーバでは、見張りが読み込みを終え、時間切れ（TIMEOUT）の観測で返す。
// 応答の遅いサーバでも、応答が届けば OK（前の期限で切らない）。反応なしの長さは、テストでは短くする（製品は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。
// サーバは、このテストの中の 127.0.0.1 のサーバだけを使う（既定の Chromium）。
import type { Browser, BrowserContext } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { navigatePage } from '../../src/orchestration/page-navigation.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';

const QUIET_LIMIT_MS = 2_000;
/** 応答を遅らせる長さ（ms）。反応なしの長さより長いが、その間もサーバは本文を少しずつ送る。 */
const DRIP_COUNT = 6;
const DRIP_INTERVAL_MS = 700;
const TEST_TIMEOUT_MS = 60_000;

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const contexts: BrowserContext[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close().catch(() => undefined);
  }
  await server?.close();
  server = undefined;
});

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    if (request.url === '/silent') {
      // 応答を返さない（全く反応がない）。
      return;
    }
    if (request.url === '/drip') {
      // ヘッダの前に、少しずつ時間をかけ、その後に文書を返す（読み込み全体は反応なしの長さより長い）。
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent === 1) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        }
        response.write(`<p>${String(sent)}</p>`);
        if (sent >= DRIP_COUNT) {
          clearInterval(timer);
          response.end('<!doctype html><title>drip</title><main>done</main>');
        }
      }, DRIP_INTERVAL_MS);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>ok</title><main>ok</main>');
  });
  return server;
};

const newPage = async () => {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
};

describe('L14: a load without a chosen time limit waits under the progress watch', () => {
  it('returns a TIMEOUT observation when the server never responds', async () => {
    const { origin } = await startServer();
    const page = await newPage();
    const startedAtMs = Date.now();

    const result = await navigatePage(page, `${origin}/silent`, {
      timeoutMs: undefined,
      ledger: new SafetyLedger(),
      allowedQueryParameters: new Set(),
      quietLimitMs: QUIET_LIMIT_MS,
    });

    expect(result.navigationOutcome).toBe('TIMEOUT');
    expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(QUIET_LIMIT_MS);
  }, TEST_TIMEOUT_MS);

  it('loads a page whose server answers slowly but keeps sending', async () => {
    const { origin } = await startServer();
    const page = await newPage();

    const result = await navigatePage(page, `${origin}/drip`, {
      timeoutMs: undefined,
      ledger: new SafetyLedger(),
      allowedQueryParameters: new Set(),
      quietLimitMs: QUIET_LIMIT_MS,
    });

    expect(result).toMatchObject({ navigationOutcome: 'OK', httpStatus: 200, finalUrl: `${origin}/drip` });
  }, TEST_TIMEOUT_MS);
});
