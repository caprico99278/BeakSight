// DEF-085 fix round 3（2 回目の独立レビュー T27R2 の C2）: Passive の Context の出口の中継（`PASS_THROUGH`）を通しても、http: のサイトの
// 変わった応答の読み込みの結果が、中継なし（Guard だけ）と同じであることを確かめる。
// - 中継なし: 本物の Guard だけを付けた Context（`installPassiveRequestGuard`。factory と同じ Context の作り方）。
// - 中継あり: 本物の factory の Passive の Context（`createPassiveContext`。Guard と中継）。
// - 相手は、このテストの中の 127.0.0.1 の TCP のサーバ（要求の頭を受けたら、場面ごとの生の bytes を返す）。
// - 比べるもの: 読み込みの結果の種類（応答か失敗か）、HTTP の status、理由の文字列（`statusText`）、失敗のエラーのコード、Guard の違反の
//   コード、本文の先頭。中継なしと同じにできない形は `ACCEPTED_DIFFERENCES` に、理由とともに置く（報告して受け入れの判断を待つ形）。
// - Chromium は headless だけ（`BOTH_CHROMIUM_LAUNCHERS`。遅い組は CLI の起動の設定の 1 つ）。
// - SLIM: 形ごとに Context を作り直さず、中継なしと中継ありの Context と page を 1 つずつ、形をまたいで続けて読む（違反は、その読み込みの間に増えた分を
//   比べる）。違反が出たか page が閉じたら、その読み手を閉じて、次の形で作り直す。大きな Cookie の場面は、Cookie が残らないよう Context を新しく作る。
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 読み込みの期限（ms）。本文の途中で切れる場面は、読み込みが終わらないので、この期限で終わる（中継なしと同じ）。 */
const LOAD_TIMEOUT_MS = 5_000;
/** 1 つの場面の比べ（2 つの Context での読み込み）の期限（ms）。 */
const SHAPE_TEST_TIMEOUT_MS = 4 * LOAD_TIMEOUT_MS;
/** 大きな応答ヘッダの値の長さ（T27R2 の形。Node の既定のヘッダの上限 16 KiB を超える）。 */
const LARGE_HEADER_VALUE_LENGTH = 20_000;
/** 大きな Cookie の数と 1 つの値の長さ（合わせて約 20 KB。T27R2 の形）。 */
const LARGE_COOKIE_COUNT = 5;
const LARGE_COOKIE_VALUE_LENGTH = 4_000;
/** 応答を送ってから接続を切るまでの時間（ms。本文の途中の切断の場面）。 */
const CUT_DELAY_MS = 50;
const VIEWPORT = Object.freeze({ width: 800, height: 600 });

const OK_BODY = 'hello';
const ok = (head: string): string => `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${head}Content-Length: ${OK_BODY.length}\r\n\r\n${OK_BODY}`;

/** 場面ごとの、相手の振る舞い（要求の頭を受けた後に呼ぶ）。 */
const SHAPES: Readonly<Record<string, (socket: Socket) => void>> = Object.freeze({
  '/ok': (socket) => socket.end(ok('')),
  '/large-header': (socket) => socket.end(ok(`X-Pad: ${'a'.repeat(LARGE_HEADER_VALUE_LENGTH)}\r\n`)),
  '/control-char': (socket) => socket.end(Buffer.from(ok('X-Bad: a\x01b\r\n'), 'latin1')),
  '/nul-char': (socket) => socket.end(Buffer.from(ok('X-Nul: a\x00b\r\n'), 'latin1')),
  '/lf-only': (socket) => socket.end('HTTP/1.1 200 OK\nContent-Type: text/html\nContent-Length: 5\n\nhello'),
  '/cl-and-te': (socket) => socket.end(
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
  ),
  '/custom-reason': (socket) => socket.end('HTTP/1.1 200 Custom Reason\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello'),
  '/no-reason': (socket) => socket.end('HTTP/1.1 200\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello'),
  '/status-999': (socket) => socket.end('HTTP/1.1 999 Odd\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello'),
  '/http-1-0-close-delimited': (socket) => socket.end('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\nhello-close-delimited'),
  '/obs-fold': (socket) => socket.end(ok('X-Fold: a\r\n b\r\n')),
  '/space-in-name': (socket) => socket.end(ok('X Bad: 1\r\n')),
  '/duplicate-content-length': (socket) => socket.end(
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!',
  ),
  '/latin1-value': (socket) => socket.end(Buffer.from(ok('X-L: caf\xe9\r\n'), 'latin1')),
  '/early-hints': (socket) => socket.end(
    `HTTP/1.1 103 Early Hints\r\nLink: </ok>; rel=preload; as=fetch\r\n\r\n${ok('')}`,
  ),
  '/close-without-response': (socket) => socket.destroy(),
  '/reset-without-response': (socket) => socket.resetAndDestroy(),
  '/header-then-short-body': (socket) => socket.end(
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100\r\n\r\nshort',
  ),
  '/partial-header': (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Ty');
    setTimeout(() => socket.destroy(), CUT_DELAY_MS);
  },
  '/chunked-cut': (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n');
    setTimeout(() => socket.destroy(), CUT_DELAY_MS);
  },
  '/reset-after-body': (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 50\r\n\r\nabc');
    setTimeout(() => socket.resetAndDestroy(), CUT_DELAY_MS);
  },
  '/not-http': (socket) => socket.end('NOT HTTP AT ALL\r\n\r\n'),
  '/http-0-9': (socket) => socket.end('<html>hi</html>'),
  '/no-content': (socket) => socket.end('HTTP/1.1 204 No Content\r\n\r\n'),
  '/redirect-without-location': (socket) => socket.end('HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n'),
});

/**
 * 中継なしと同じにできない形（DEF-085 fix round 3 の (d)。設計者に報告し、受け入れの判断を待つ）。鍵は場面の path、値は理由。
 * ここに載せた形は、両方とも「失敗」か両方とも「応答」であることだけを確かめる（結果の種類は同じ）。
 */
const ACCEPTED_DIFFERENCES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * 新しい Context で 1 回だけ読む形（形をまたぐ読み手で続けて読むと、前の形の後の接続の状態で中継なしの読み方が変わる形）。
 * `/partial-header`: 続けて読むと、中継なし（Guard だけ）の読み込みだけが失敗になった（SLIM の後の流しで、中継なし FAILED・中継あり 200）。
 * 形ごとに Context を作り直す前の形では、両方とも 200 で本文が空になり、同じ結果になる（2026-11-15 に確かめた）。
 */
const FRESH_CONTEXT_SHAPES: ReadonlySet<string> = new Set(['/partial-header']);

interface LoadOutcome {
  readonly kind: 'RESPONSE' | 'FAILED';
  readonly status: number | null;
  readonly statusText: string | null;
  readonly errorCode: string | null;
  readonly body: string | null;
  readonly violations: readonly string[];
}

/** 失敗の文から、Chromium のエラーのコード（`net::ERR_...`）か、期限切れの印を取り出す。 */
function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /net::ERR_[A-Z0-9_]+/u.exec(message)?.[0] ?? (/Timeout/u.test(message) ? 'TIMEOUT' : 'OTHER');
}

/** 形をまたいで使う読み手（Context と page と Ledger）。 */
interface Reader {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  close(): Promise<void>;
}

/** `url` を読み、結果を返す。違反のコードは、この読み込みの間に増えた分だけを返す。 */
async function load(page: Page, url: string, ledger: SafetyLedger): Promise<LoadOutcome> {
  const start = ledger.snapshot().invariantViolations.length;
  const violations = (): string[] => [...new Set(ledger.snapshot().invariantViolations.slice(start).map(({ code }) => code))].sort();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => null);
    return {
      kind: 'RESPONSE',
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      errorCode: null,
      body: body === null ? null : body.slice(0, 40),
      violations: violations(),
    };
  } catch (error) {
    return {
      kind: 'FAILED',
      status: null,
      statusText: null,
      errorCode: errorCodeOf(error),
      body: null,
      violations: violations(),
    };
  }
}

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-085 fix round 3: the egress proxy reads http: responses as Chromium does, with %s', (_name, launch) => {
  let browser: Browser;
  let server: Server;
  let origin = '';
  /** 相手が受けた要求の頭の長さ（path ごと。大きな Cookie の要求が届いたことの確かめ）。 */
  const receivedHeadLengths = new Map<string, number>();

  beforeAll(async () => {
    browser = await launch();
    server = createNetServer((socket) => {
      let received = '';
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        const end = received.indexOf('\r\n\r\n');
        if (end < 0) {
          return;
        }
        const head = received.slice(0, end);
        received = '';
        const target = head.split('\r\n')[0]?.split(' ')[1] ?? '/';
        const path = new URL(target, 'http://placeholder.invalid').pathname;
        receivedHeadLengths.set(path, head.length);
        const respond = SHAPES[path] ?? ((s: Socket): void => {
          s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        });
        respond(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  /** 形をまたいで使う読み手（中継なしと中継あり）。 */
  const readers: Record<'withoutProxy' | 'withProxy', Reader | null> = { withoutProxy: null, withProxy: null };

  afterAll(async () => {
    await readers.withoutProxy?.close();
    await readers.withProxy?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /** 中継なし: Guard だけを付けた Context と page。 */
  async function openWithoutProxy(cookies: boolean): Promise<Reader> {
    const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    const close = (): Promise<void> => closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    try {
      if (cookies) await context.addCookies(largeCookies(origin));
      const ledger = new SafetyLedger();
      await installPassiveRequestGuard(context, ledger, new Set([origin]));
      const page = await context.newPage();
      await awaitPassiveRequestGuardReady(page);
      return { page, ledger, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** 中継あり: factory の Passive の Context（Guard と中継）と page。 */
  async function openWithProxy(cookies: boolean): Promise<Reader> {
    const factory = new BrowserContextFactory(browser, createTestConfig(origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(VIEWPORT);
    const close = async (): Promise<void> => {
      await factory.closePassiveContext(context).catch(() => undefined);
      await factory.close();
    };
    try {
      if (cookies) await context.addCookies(largeCookies(origin));
      const page = await factory.createPassivePage(context);
      return { page, ledger: factory.getSafetyLedger(context), close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** 新しい Context で 1 回だけ読む（大きな Cookie の場面）。 */
  async function loadOnce(open: (cookies: boolean) => Promise<Reader>, path: string, cookies: boolean): Promise<LoadOutcome> {
    const reader = await open(cookies);
    try {
      return await load(reader.page, `${origin}${path}`, reader.ledger);
    } finally {
      await reader.close();
    }
  }

  /** 形をまたいで使う読み手で読む。違反が出たか page が閉じたら、その読み手を閉じて、次の形で作り直す。 */
  async function loadShared(mode: keyof typeof readers, path: string): Promise<LoadOutcome> {
    let reader = readers[mode];
    if (reader === null || reader.page.isClosed()) {
      await reader?.close();
      reader = await (mode === 'withoutProxy' ? openWithoutProxy(false) : openWithProxy(false));
      readers[mode] = reader;
    }
    const outcome = await load(reader.page, `${origin}${path}`, reader.ledger);
    if (outcome.violations.length > 0 || reader.page.isClosed()) {
      await reader.close();
      readers[mode] = null;
    }
    return outcome;
  }

  it.each(Object.keys(SHAPES))('reads %s with the same result as without the proxy', async (path) => {
    const fresh = FRESH_CONTEXT_SHAPES.has(path);
    const withoutProxy = fresh ? await loadOnce(openWithoutProxy, path, false) : await loadShared('withoutProxy', path);
    const withProxy = fresh ? await loadOnce(openWithProxy, path, false) : await loadShared('withProxy', path);
    console.info(`DEF-085 C2 ${path}: ${JSON.stringify({ withoutProxy, withProxy })}`);
    if (Object.hasOwn(ACCEPTED_DIFFERENCES, path)) {
      expect(withProxy.kind).toBe(withoutProxy.kind);
      return;
    }
    expect(withProxy).toEqual(withoutProxy);
  }, SHAPE_TEST_TIMEOUT_MS);

  it('sends a request with about 20 KB of cookies and reads the same result as without the proxy', async () => {
    const withoutProxy = await loadOnce(openWithoutProxy, '/ok', true);
    const withoutProxyHead = receivedHeadLengths.get('/ok') ?? 0;
    const withProxy = await loadOnce(openWithProxy, '/ok', true);
    const withProxyHead = receivedHeadLengths.get('/ok') ?? 0;
    console.info(`DEF-085 C2 large cookies: ${JSON.stringify({ withoutProxy, withProxy, withoutProxyHead, withProxyHead })}`);
    expect(withProxy).toEqual(withoutProxy);
    expect(withProxyHead).toBeGreaterThan(LARGE_COOKIE_COUNT * LARGE_COOKIE_VALUE_LENGTH);
  }, SHAPE_TEST_TIMEOUT_MS);
});

/** 約 20 KB の Cookie（T27R2 の形）。 */
function largeCookies(origin: string): { name: string; value: string; url: string }[] {
  return Array.from({ length: LARGE_COOKIE_COUNT }, (_, index) => ({
    name: `big${index}`,
    value: 'c'.repeat(LARGE_COOKIE_VALUE_LENGTH),
    url: origin,
  }));
}
