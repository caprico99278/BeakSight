// PCR-DR の Important-1（サイトへの負荷の制御の設計書 4.10.3 の 2026-10-06 の追補）: Run 全体のキャッシュには、要求が成功して
// 終わった（Playwright の `requestfinished`。`requestfailed` でない）応答だけを入れる。
// - 本文の途中で切れた 200 の応答（`Content-Length` より短い本文、chunked の本文の途中の切断）は、読み込みが失敗するが、Playwright の
//   `response.body()` は途中までの本文で解決する。それをキャッシュに入れると、2ページ目以降の Passive（PRIMARY）の読み込みに、
//   壊れた応答を返してしまう。
// - ここでは、本物の factory と `ResourceCache` を使い、1回目だけ本文を途中で切るサーバ（127.0.0.1）で確かめる: 1回目の後に
//   キャッシュに入っていない、2つ目の PRIMARY の読み込みでサーバに要求が届く（取り直す）、2つ目では壊れていない本文が使われる。
//   対照として、ふつうに成功した応答は今のとおりキャッシュに入り、2つ目ではサーバに届かない。
// - Chromium は、テストの既定（headless shell）と、CLI と同じ起動の設定（`chromiumLaunchOptions`。headless）の両方で確かめる
//   （DEF-030。本文の切断の扱いが、Chromium の種類で違わないことを確かめるため）。
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { RESOURCE_CACHE_STORABLE_STATUS, ResourceCache } from '../../src/browser/resource-delivery.js';
import { wait } from '../../src/core/deadline.js';
import { createLoadMeter } from '../../src/crawl/load-meter.js';
import type { NETWORK_LAYER_FAILURE_CODES } from '../../src/safety/network-layer-failure.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

/** スクリプトを2つ読むページ（1回目だけ本文を途中で切るスクリプトと、いつも全体を返すスクリプト）。 */
const PAGE_PATH = '/truncated-cache.html';
/** 1回目だけ本文を途中で切るスクリプト。 */
const CUT_SCRIPT_PATH = '/truncated-cache-cut.js';
/** いつも全体を返すスクリプト（対照。ふつうに成功した応答は、今のとおりキャッシュに入る）。 */
const WHOLE_SCRIPT_PATH = '/truncated-cache-whole.js';

/** 切るスクリプトの、コメントの中の詰め物の長さ（文字。1バイトの文字だけを使う）。途中で切った本文が、構文の誤りになる長さにする。 */
const CUT_SCRIPT_PADDING_LENGTH = 4_000;
/**
 * 切るスクリプトの全体。始まりと終わりに印を付ける。途中で切った本文は、コメントが閉じないので、実行されない（構文の誤り）。
 * 全体が使われた場合だけ、両方の印が付く。
 */
const CUT_SCRIPT = [
  'globalThis.truncatedCacheCutStarted = true;',
  `/* ${'x'.repeat(CUT_SCRIPT_PADDING_LENGTH)} */`,
  'globalThis.truncatedCacheCutCompleted = true;',
].join('\n');
const CUT_SCRIPT_BYTES = Buffer.byteLength(CUT_SCRIPT);
/** 1回目に送る分の長さ（バイト）。全体の4分の1（コメントの途中）で切る。 */
const CUT_SCRIPT_SENT_BYTES = Math.floor(CUT_SCRIPT_BYTES / 4);
const WHOLE_SCRIPT = 'globalThis.truncatedCacheWholeRan = true;';
const PAGE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Truncated cache fixture</title></head><body>',
  `<script src="${CUT_SCRIPT_PATH}"></script>`,
  `<script src="${WHOLE_SCRIPT_PATH}"></script>`,
  '<p>truncated cache fixture</p>',
  '</body></html>',
].join('');
const JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8';
/** サーバが知らないパスに返す status。 */
const NOT_FOUND_STATUS = 404;

/** 事象を待つ上限（ms）。 */
const POLL_TIMEOUT_MS = 10_000;
/**
 * 1回目の読み込みの後、キャッシュに入らないことを確かめる前に置く時間（ms）。修正の前の作り（`response` の事象で `response.body()` を
 * 待って入れる）は、要求の失敗の後に、非同期で入れていた。その非同期の処理が終わるだけの時間を置き、入らないことが待ち不足でないように
 * する。
 */
const CACHE_SETTLE_MS = 500;
const TEST_TIMEOUT_MS = 60_000;

/** Chromium が報告する、本文の途中の切断の理由（Guard のネットワークの層の失敗の一覧に載る値）。 */
type BodyCutFailure = Extract<(typeof NETWORK_LAYER_FAILURE_CODES)[number], 'net::ERR_CONTENT_LENGTH_MISMATCH' | 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'>;

interface CutCase {
  readonly name: string;
  /** 1回目の応答の header（status は 200）。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly expectedFailure: BodyCutFailure;
}

const CUT_CASES: readonly CutCase[] = Object.freeze([
  {
    name: 'a body shorter than its Content-Length',
    headers: { 'Content-Type': JAVASCRIPT_CONTENT_TYPE, 'Content-Length': String(CUT_SCRIPT_BYTES) },
    expectedFailure: 'net::ERR_CONTENT_LENGTH_MISMATCH',
  },
  {
    name: 'a chunked body cut midway',
    headers: { 'Content-Type': JAVASCRIPT_CONTENT_TYPE, 'Transfer-Encoding': 'chunked' },
    expectedFailure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  },
]);

/** 1回目だけ本文を途中で切るサーバ（ループバック）。受けた要求のパスを、受けた順に記録する。 */
interface TruncatingServer {
  readonly origin: string;
  /** `pathname` の要求を受けた数。 */
  received(pathname: string): number;
  close(): Promise<void>;
}

/** `cutHeaders` は、1回目の（本文を途中で切る）応答の header。 */
async function startTruncatingServer(cutHeaders: CutCase['headers']): Promise<TruncatingServer> {
  const received: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    received.push(pathname);
    switch (pathname) {
      case PAGE_PATH:
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(PAGE_HTML);
        return;
      case CUT_SCRIPT_PATH:
        if (received.filter((path) => path === CUT_SCRIPT_PATH).length === 1) {
          // 1回目: キャッシュに入れる status（200）で、本文の一部だけを送ってから、接続を切る。
          response.writeHead(RESOURCE_CACHE_STORABLE_STATUS, cutHeaders);
          response.write(Buffer.from(CUT_SCRIPT).subarray(0, CUT_SCRIPT_SENT_BYTES), () => response.socket?.destroy());
          return;
        }
        response.writeHead(RESOURCE_CACHE_STORABLE_STATUS, { 'Content-Type': JAVASCRIPT_CONTENT_TYPE });
        response.end(CUT_SCRIPT);
        return;
      case WHOLE_SCRIPT_PATH:
        response.writeHead(RESOURCE_CACHE_STORABLE_STATUS, { 'Content-Type': JAVASCRIPT_CONTENT_TYPE });
        response.end(WHOLE_SCRIPT);
        return;
      default:
        response.statusCode = NOT_FOUND_STATUS;
        response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received: (pathname) => received.filter((path) => path === pathname).length,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Context の、失敗した要求（URL と理由）。 */
function watchFailures(context: BrowserContext): { readonly url: string; readonly errorText: string | null }[] {
  const failures: { readonly url: string; readonly errorText: string | null }[] = [];
  context.on('requestfailed', (request) => {
    failures.push({ url: request.url(), errorText: request.failure()?.errorText ?? null });
  });
  return failures;
}

let defaultBrowser: Browser;
let cliBrowser: Browser | undefined;
const servers: TruncatingServer[] = [];

useHeadlessChromium((launched) => {
  defaultBrowser = launched;
});

beforeAll(async () => {
  // CLI と同じ起動の設定（headless）。テストの既定の Chromium（headless shell）と、扱いが違う可能性があるため（DEF-030）。
  cliBrowser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
});

afterAll(async () => {
  await cliBrowser?.close();
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const BROWSERS = [
  { browserName: 'the default test Chromium (headless shell)', browserOf: (): Browser => defaultBrowser },
  { browserName: 'the Chromium of the CLI (chromiumLaunchOptions, headless)', browserOf: (): Browser => cliBrowser! },
] as const;

describe('the Run cache stores only the responses whose requests finished (PCR-DR Important-1)', () => {
  it.each(CUT_CASES.flatMap((cutCase) => BROWSERS.map((target) => ({ ...cutCase, ...target }))))(
    'does not store $name, and the next PRIMARY load takes it again from the network: $browserName',
    async ({ headers, expectedFailure, browserOf }) => {
      const browser = browserOf();
      const server = await startTruncatingServer(headers);
      servers.push(server);
      const config = createTestConfig(server.origin);
      const cache = new ResourceCache();
      const meter = createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() });
      // Run Coordinator と同じく、Run 全体のキャッシュと meter を渡した、本物の factory。
      const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: meter, resourceCache: cache });
      const pageUrl = `${server.origin}${PAGE_PATH}`;
      const cutUrl = `${server.origin}${CUT_SCRIPT_PATH}`;
      const wholeUrl = `${server.origin}${WHOLE_SCRIPT_PATH}`;

      // 1つ目の Passive の読み込み（PRIMARY。Desktop）: 切るスクリプトは、本文の途中の切断で失敗する（空振りでないこと）。
      const first = await factory.createPassiveContext(config.viewports.primaryDesktop);
      const firstFailures = watchFailures(first);
      const firstPage = await factory.createPassivePage(first);
      try {
        await firstPage.goto(pageUrl, { waitUntil: 'load' });
        await expect.poll(() => firstFailures.filter(({ url }) => url === cutUrl), { timeout: POLL_TIMEOUT_MS })
          .toEqual([{ url: cutUrl, errorText: expectedFailure }]);
        // 対照: ふつうに成功した応答は、今のとおりキャッシュに入る。
        await expect.poll(() => cache.lookup(wholeUrl)?.body.byteLength ?? null, { timeout: POLL_TIMEOUT_MS })
          .toBe(Buffer.byteLength(WHOLE_SCRIPT));
        await wait(CACHE_SETTLE_MS);

        // 途中で切れた応答は、キャッシュに入っていない。
        expect(cache.lookup(cutUrl)).toBeUndefined();
        expect(cache.stats().entryCount).toBe(1);
        expect(server.received(CUT_SCRIPT_PATH)).toBe(1);
      } finally {
        await closePassiveResources({ factory, context: first, page: firstPage });
      }

      // 2つ目の Passive の読み込み（PRIMARY。同じ factory と同じキャッシュ。Mobile の幅）: 切ったスクリプトは、ネットワークから取り直し、
      // 壊れていない本文が使われる。成功したスクリプトは、キャッシュから返す（サーバに届かない）。
      const second = await factory.createPassiveContext(config.viewports.primaryMobile);
      const secondFailures = watchFailures(second);
      const secondPage = await factory.createPassivePage(second);
      const pageErrors: string[] = [];
      secondPage.on('pageerror', (error) => {
        pageErrors.push(String(error));
      });
      try {
        await secondPage.goto(pageUrl, { waitUntil: 'load' });
        const ran = await secondPage.evaluate(() => {
          const marks = globalThis as {
            truncatedCacheCutStarted?: boolean;
            truncatedCacheCutCompleted?: boolean;
            truncatedCacheWholeRan?: boolean;
          };
          return {
            cutStarted: marks.truncatedCacheCutStarted ?? false,
            cutCompleted: marks.truncatedCacheCutCompleted ?? false,
            wholeRan: marks.truncatedCacheWholeRan ?? false,
          };
        });

        // ページの振る舞い: 切ったスクリプトの全体が実行され、構文の誤りなどのページの例外はない。
        expect(ran).toEqual({ cutStarted: true, cutCompleted: true, wholeRan: true });
        expect(pageErrors).toEqual([]);
        expect(secondFailures).toEqual([]);
        // サーバが受けた要求: 切ったスクリプトは2回目も届いた（取り直した）。成功したスクリプトは1回だけ（キャッシュから返した）。
        // 文書は毎回届く。
        expect(server.received(CUT_SCRIPT_PATH)).toBe(2);
        expect(server.received(WHOLE_SCRIPT_PATH)).toBe(1);
        expect(server.received(PAGE_PATH)).toBe(2);
        await expect.poll(() => meter.snapshot().servedFromCache, { timeout: POLL_TIMEOUT_MS }).toBe(1);
        // 取り直した全体の応答は、成功して終わったので、キャッシュに入る（全体の長さ）。
        await expect.poll(() => cache.lookup(cutUrl)?.body.byteLength ?? null, { timeout: POLL_TIMEOUT_MS }).toBe(CUT_SCRIPT_BYTES);
        for (const context of [first, second]) {
          const ledger = factory.getSafetyLedger(context).snapshot();
          expect(ledger.invariantViolationCount).toBe(0);
          expect(ledger.blockedRequests).toEqual([]);
        }
      } finally {
        await closePassiveResources({ factory, context: second, page: secondPage });
      }
      expect(browser.contexts(), 'Contexts left in the browser after the test').toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
