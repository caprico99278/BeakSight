// DEF-029（設計書 `2026-10-05-beaksight-def-029-response-received-failures-design.md`）: 許可した main frame の読み取りの読み込みが、
// 応答（ヘッダ）を受けた後に Chromium の都合で失敗した場合（本文が空の 4xx・5xx、401 Basic、本文の途中の切断）は、Guard の違反
// （`HTTP_MAIN_FRAME_DELIVERY_FAILED`）にしない。凍結中と、応答の status を確かめられない場合は、今までどおり違反にする（fail-closed）。
//
// - Chromium は、CLI と同じ起動の設定（`chromiumLaunchOptions`。headless）で起動する。本文が空の 4xx・5xx と、401 Basic を、
//   読み込みの失敗にするのは、CLI の Chromium（`chrome.exe` の新しい headless の方式）である。テストの補助の既定の headless
//   （`chrome-headless-shell.exe`）では、これらの読み込みは失敗せず、応答として終わる（DEF-029-fix の RED で確かめた）。
// - Guard の付いた Passive Context は、製品と同じ `BrowserContextFactory`（`createGateFactory`）で作る。
// - サーバは、このテストの中の 127.0.0.1 の `node:http` のサーバだけを使う。
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_HTTP_STATUS_RANGE } from '../../src/audit/rule-helpers.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { wait } from '../../src/core/deadline.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import {
  activateInteractionFreeze,
  assertPassiveRequestGuardActive,
  isPassiveRequestGuardClosed,
} from '../../src/safety/passive-request-guard.js';
import type { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { createDeferred } from '../helpers/deferred.js';
import { createGateFactory, QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { fastRunConfig, runWithCoordinator } from '../helpers/run-harness.js';

/** 本文のない 4xx・5xx の応答を、Chromium が描かずに読み込みを失敗にしたときの理由。 */
const HTTP_RESPONSE_CODE_FAILURE = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE';
/** 401（Basic）に答える認証の情報がないので、Chromium が読み込みを失敗にしたときの理由。 */
const INVALID_AUTH_CREDENTIALS = 'net::ERR_INVALID_AUTH_CREDENTIALS';
/** 本文の途中の切断の理由（DEF-029 で、ネットワークの層の失敗の一覧に加えたもの）。 */
const BODY_CUT_FAILURES: readonly string[] = ['net::ERR_CONTENT_LENGTH_MISMATCH', 'net::ERR_INCOMPLETE_CHUNKED_ENCODING'];
/** Run Coordinator のテストの上限（ms）。 */
const RUN_TEST_TIMEOUT_MS = 120_000;

const START_PATH = '/';
const START_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Start</title></head>'
  + '<body><main><h1>Start</h1></main></body></html>';
/** 本文の途中で切る応答の、送る分の本文。 */
const PARTIAL_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partial</title>';
const UNAUTHORIZED_HTML = '<!doctype html><title>Unauthorized</title><h1>Unauthorized</h1>';
const BASIC_CHALLENGE = Object.freeze({ 'WWW-Authenticate': 'Basic realm="beaksight-fixture"' });

/** サーバのパス（パスごとに応答の種類が決まる。`startResponseFailureServer`）。 */
const PATHS = Object.freeze({
  empty503: '/empty-503',
  empty404: '/empty-404',
  basic401: '/basic-401',
  basic401WithBody: '/basic-401-with-body',
  shortContentLength: '/short-content-length',
  cutChunked: '/cut-chunked',
  heldEmpty503: '/held-empty-503',
  robots: '/robots.txt',
  sitemap: '/sitemap.xml',
});

/** サーバが返す HTTP の status。 */
const STATUS = Object.freeze({
  ok: 200,
  unauthorized: 401,
  notFound: 404,
  serviceUnavailable: 503,
});

interface ReceivedRequest {
  readonly method: string;
  readonly pathname: string;
}

interface ResponseFailureServer {
  readonly origin: string;
  /** 受けた要求（受けた順）。 */
  readonly requests: readonly ReceivedRequest[];
  /** `PATHS.heldEmpty503` の要求を受けるまで待つ。 */
  readonly heldReceived: Promise<void>;
  /** 受けた `PATHS.heldEmpty503` の要求に、本文が空の 503 を返す。 */
  releaseHeld(): void;
  close(): Promise<void>;
}

const servers: ResponseFailureServer[] = [];
let browser: Browser;

/** CLI と同じ起動の設定（headless）で Chromium を起動する。 */
const launchCliChromium = (): Promise<Browser> => chromium.launch(chromiumLaunchOptions({ headless: true }));

beforeAll(async () => {
  browser = await launchCliChromium();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** 本文が空の応答を返す。 */
function sendEmpty(response: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { ...headers, 'Content-Length': '0' });
  response.end();
}

/** 本文の一部（`PARTIAL_HTML`）を送ってから、接続を切る。 */
function sendPartialAndCut(response: ServerResponse, headers: Readonly<Record<string, string>>): void {
  response.writeHead(STATUS.ok, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  response.write(PARTIAL_HTML, () => response.socket?.destroy());
}

/**
 * 応答を受けた後に読み込みが失敗する応答を返す、127.0.0.1 のサーバ。
 * - `START_PATH`: 小さな HTML（200）。
 * - `PATHS.empty503`・`PATHS.empty404`: 本文が空の 503・404。
 * - `PATHS.basic401`: `WWW-Authenticate: Basic` の、本文が空の 401。`PATHS.basic401WithBody` は、本文のある 401。
 * - `PATHS.shortContentLength`: `Content-Length` より短い本文を送って、接続を切る。
 * - `PATHS.cutChunked`: chunked の本文の途中で、接続を切る。
 * - `PATHS.heldEmpty503`: `releaseHeld` まで応答せず、その後に本文が空の 503 を返す。
 * - `PATHS.robots`: 本文が空の 404。`PATHS.sitemap` とほかのパス: 本文のある 404。
 */
async function startResponseFailureServer(): Promise<ResponseFailureServer> {
  const requests: ReceivedRequest[] = [];
  const held = createDeferred<void>();
  const heldResponses: ServerResponse[] = [];
  let released = false;
  const server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    requests.push({ method: request.method ?? '', pathname });
    switch (pathname) {
      case START_PATH:
        response.writeHead(STATUS.ok, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(START_HTML);
        return;
      case PATHS.empty503:
        sendEmpty(response, STATUS.serviceUnavailable);
        return;
      case PATHS.empty404:
      case PATHS.robots:
        sendEmpty(response, STATUS.notFound);
        return;
      case PATHS.basic401:
        sendEmpty(response, STATUS.unauthorized, BASIC_CHALLENGE);
        return;
      case PATHS.basic401WithBody:
        response.writeHead(STATUS.unauthorized, { ...BASIC_CHALLENGE, 'Content-Type': 'text/html; charset=utf-8' });
        response.end(UNAUTHORIZED_HTML);
        return;
      case PATHS.shortContentLength:
        // 宣言する長さは、送る本文の2倍（送る本文より長い）。
        sendPartialAndCut(response, { 'Content-Length': String(Buffer.byteLength(PARTIAL_HTML) * 2) });
        return;
      case PATHS.cutChunked:
        sendPartialAndCut(response, { 'Transfer-Encoding': 'chunked' });
        return;
      case PATHS.heldEmpty503:
        if (released) {
          sendEmpty(response, STATUS.serviceUnavailable);
          return;
        }
        heldResponses.push(response);
        held.resolve();
        return;
      case PATHS.sitemap:
      default:
        response.writeHead(STATUS.notFound, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const started: ResponseFailureServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    heldReceived: held.promise,
    releaseHeld: () => {
      released = true;
      for (const response of heldResponses.splice(0)) sendEmpty(response, STATUS.serviceUnavailable);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(started);
  return started;
}

/** 失敗した要求について、テストが観測した事実。 */
interface ObservedFailure {
  readonly errorText: string | undefined;
  /** 失敗した要求の `request.response()` の status（応答がなければ `null`、取り出しが失敗したら `THREW`）。 */
  readonly responseStatus: number | null | 'THREW';
}

/** page の `requestfailed` のうち、`url` の要求の最初のものの事実を返す。 */
function observeRequestFailure(page: Page, url: string): Promise<ObservedFailure> {
  return new Promise<ObservedFailure>((resolve) => {
    const onFailed = (request: Request): void => {
      if (request.url() !== url) return;
      page.off('requestfailed', onFailed);
      const errorText = request.failure()?.errorText;
      request.response().then(
        (response) => resolve({ errorText, responseStatus: response === null ? null : response.status() }),
        () => resolve({ errorText, responseStatus: 'THREW' }),
      );
    };
    page.on('requestfailed', onFailed);
  });
}

/** `server` が受けた、`pathname` への GET の件数。 */
const getCount = (server: ResponseFailureServer, pathname: string): number =>
  server.requests.filter((request) => request.method === 'GET' && request.pathname === pathname).length;

/** Guard の付いた Passive の page を開いて `run` に渡し、終わったら閉じる。 */
async function withGuardedPage(
  server: ResponseFailureServer,
  run: (page: Page, context: BrowserContext, ledger: SafetyLedger) => Promise<void>,
): Promise<void> {
  const factory = createGateFactory(browser, server.origin);
  const context = await factory.createPassiveContext(DEFAULT_CONFIG.viewports.primaryDesktop);
  let page: Page | undefined;
  try {
    page = await factory.createPassivePage(context);
    await run(page, context, factory.getSafetyLedger(context));
  } finally {
    await closePassiveResources({ factory, context, page });
  }
}

/** Guard の `requestfailed` の処理（応答の取り出しを含む）が終わるのを待ってから、違反が0件で、Guard が生きていることを確かめる。 */
async function expectNoViolationAndActiveGuard(page: Page, context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  await wait(QUIET_PERIOD_MS);
  expect(ledger.snapshot().invariantViolations).toEqual([]);
  expect(isPassiveRequestGuardClosed(context)).toBe(false);
  expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  expect(page.isClosed()).toBe(false);
}

/** 後続の許可した読み込みが通り、違反が0件のままであることを確かめる（Context が使えるまま）。 */
async function expectNextLoadSucceeds(server: ResponseFailureServer, page: Page, ledger: SafetyLedger): Promise<void> {
  const response = await page.goto(`${server.origin}${START_PATH}`);
  expect(response?.status()).toBe(STATUS.ok);
  expect(ledger.snapshot().invariantViolations).toEqual([]);
}

/**
 * Chromium は、読み込みの失敗の後にエラーのページを読み込む。そのページに移り（page の URL が `urlBefore` から変わり）、
 * 読み込みが終わるのを待つ（次の読み込みを、エラーのページの読み込みと重ねない）。
 */
async function waitForErrorPage(page: Page, urlBefore: string): Promise<void> {
  await expect.poll(() => page.url()).not.toBe(urlBefore);
  await page.waitForLoadState('load');
}

describe('DEF-029: a main-frame load that fails after the response was received is not a Guard violation', () => {
  it.each([
    { name: 'empty 503', path: PATHS.empty503, failure: HTTP_RESPONSE_CODE_FAILURE, status: STATUS.serviceUnavailable },
    { name: 'empty 404', path: PATHS.empty404, failure: HTTP_RESPONSE_CODE_FAILURE, status: STATUS.notFound },
    { name: '401 Basic with an empty body', path: PATHS.basic401, failure: INVALID_AUTH_CREDENTIALS, status: STATUS.unauthorized },
    { name: '401 Basic with a body', path: PATHS.basic401WithBody, failure: INVALID_AUTH_CREDENTIALS, status: STATUS.unauthorized },
  ])('$name: goto fails with $failure, no violation, the Context stays usable, and the server gets one GET', async ({
    path,
    failure,
    status,
  }) => {
    const server = await startResponseFailureServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${path}`;
      const urlBefore = page.url();
      const observed = observeRequestFailure(page, url);

      await expect(page.goto(url)).rejects.toThrow(failure);

      // 設計の前提: 失敗した要求は、応答（ヘッダ）を受けており、`request.response()` が status を返す。
      expect(await observed).toEqual({ errorText: failure, responseStatus: status });
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAndActiveGuard(page, context, ledger);
      await waitForErrorPage(page, urlBefore);
      await expectNextLoadSucceeds(server, page, ledger);
      expect(getCount(server, path)).toBe(1);
    });
  });

  // 本文の途中の切断: Chromium は、受けた分の文書に移る（commit）が、その文書の `load` は来ない（Guard のない Context でも同じ。
  // DEF-029-fix で確かめた）。そのため、読み込みは commit まで待ち、失敗の理由は `requestfailed` で確かめる。
  it.each([
    { name: 'body shorter than Content-Length', path: PATHS.shortContentLength },
    { name: 'chunked body cut in the middle', path: PATHS.cutChunked },
  ])('$name: the load fails with a body-cut reason, no violation, the Context stays usable, and the server gets one GET', async ({ path }) => {
    const server = await startResponseFailureServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${path}`;
      const observed = observeRequestFailure(page, url);

      expect((await page.goto(url, { waitUntil: 'commit' }))?.status()).toBe(STATUS.ok);

      const { errorText, responseStatus } = await observed;
      expect(BODY_CUT_FAILURES).toContain(errorText);
      expect(responseStatus).toBe(STATUS.ok);
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAndActiveGuard(page, context, ledger);
      await expectNextLoadSucceeds(server, page, ledger);
      expect(getCount(server, path)).toBe(1);
    });
  });
});

describe('DEF-029 controls: the same failures stay violations when the Guard cannot rely on them', () => {
  // 凍結の段階での同じ失敗（DEF-004b の確かめ方に合わせる。凍結の前に要求をサーバに届け、凍結の後に本文が空の 503 を返す）。
  it('an empty 503 of a main-frame load during the interaction freeze stays a violation and invalidates the Context', async () => {
    const server = await startResponseFailureServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      expect((await page.goto(`${server.origin}${START_PATH}`))?.status()).toBe(STATUS.ok);
      const observed = observeRequestFailure(page, `${server.origin}${PATHS.heldEmpty503}`);

      await page.evaluate((path) => { location.href = path; }, PATHS.heldEmpty503);
      await server.heldReceived;
      await activateInteractionFreeze(page);
      server.releaseHeld();

      expect((await observed).errorText).toBe(HTTP_RESPONSE_CODE_FAILURE);
      await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
        code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
        message: HTTP_RESPONSE_CODE_FAILURE,
      }]);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      expect(() => assertPassiveRequestGuardActive(context)).toThrow(/invalidated/iu);
    });
  });

  // 応答の status を確かめられない場合（fail-closed）。実際の本文が空の 503 の読み込みで、その要求の `request.response()` だけを
  // 差し替える（Guard のコードは変えない）。差し替えは、Guard が `requestfailed` で受けるのと同じ Request のオブジェクトに、
  // `request` の事象の時点で付ける。
  it.each([
    { name: 'no response', response: async (): Promise<Response | null> => null },
    {
      name: 'the response lookup throws',
      response: async (): Promise<Response | null> => {
        throw new Error('response lookup failed in the test');
      },
    },
    {
      name: 'a status just below the error range',
      response: async (): Promise<Response | null> => ({ status: () => ERROR_HTTP_STATUS_RANGE.min - 1 }) as unknown as Response,
    },
    {
      name: 'a status just above the error range',
      response: async (): Promise<Response | null> => ({ status: () => ERROR_HTTP_STATUS_RANGE.max + 1 }) as unknown as Response,
    },
  ])('$name: an empty 503 of a main-frame load stays a violation and invalidates the Context', async ({ response }) => {
    const server = await startResponseFailureServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${PATHS.empty503}`;
      context.on('request', (request) => {
        if (request.url() === url) vi.spyOn(request, 'response').mockImplementation(response);
      });
      const observed = observeRequestFailure(page, url);

      await expect(page.goto(url)).rejects.toThrow();

      expect((await observed).errorText).toBe(HTTP_RESPONSE_CODE_FAILURE);
      await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
        code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
        message: HTTP_RESPONSE_CODE_FAILURE,
      }]);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      expect(getCount(server, PATHS.empty503)).toBe(1);
    });
  });
});

describe('DEF-029: Run Coordinator on a site whose robots.txt is an empty 404', () => {
  /** Run Coordinator が起動した Browser（後に残っていないことを確かめる）。 */
  const runBrowsers: Browser[] = [];
  /**
   * Run Coordinator に渡す launcher。`createRunLauncher`（`tests/helpers/run-harness.ts`）と同じく、要求された `headless` の値によらず、
   * いつも headless で起動する。起動の設定は、CLI と同じ（`chromiumLaunchOptions`）にする。
   */
  const launchRunBrowser: BrowserLauncher = async () => {
    const launched = await launchCliChromium();
    runBrowsers.push(launched);
    return launched;
  };
  const workDirectories: string[] = [];

  afterEach(async () => {
    const leftovers = runBrowsers.splice(0).filter((launched) => launched.isConnected());
    await Promise.all(leftovers.map((launched) => launched.close().catch(() => undefined)));
    for (const directory of workDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    expect(leftovers.length, 'Browsers left connected after the Run').toBe(0);
  });

  it('starts the Run, does not end ABORTED_BY_SAFETY, and records robots.txt as NOT_FOUND with HTTP 404', async () => {
    const server = await startResponseFailureServer();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-def-029-'));
    workDirectories.push(outputDirectory);

    const result = await runWithCoordinator({
      config: fastRunConfig(server.origin, START_PATH, { audit: { interactions: false } }),
      launchBrowser: launchRunBrowser,
      outputDirectory,
    });

    // 修正の前は、robots.txt の取得で `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Run が ABORTED_BY_SAFETY になる（RED）。
    expect(result.run.safety.invariantViolations).toEqual([]);
    expect(result.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
    const [start] = result.pages;
    expect(start?.pageUrl).toBe(`${server.origin}${START_PATH}`);
    expect(start?.status).toBe('AUDITED');
    // 読み込みは例外で終わるが、robots.txt の取得は、観測した応答の status（404）から NOT_FOUND を導く（設計書 2.3。サイトが応答しないときに
    // Run を止める機能の SU3b で扱った。SU3b の前は FAILED だった）。本文のある 404 の sitemap.xml も NOT_FOUND。
    const metadata = start?.evidence.flatMap((record) => (record.type === 'metadata' ? [record] : []));
    expect(metadata?.map((record) => [record.payload.kind, record.payload.outcome, record.payload.httpStatus])).toEqual([
      ['ROBOTS_TXT', 'NOT_FOUND', STATUS.notFound],
      ['SITEMAP_XML', 'NOT_FOUND', STATUS.notFound],
    ]);
    expect(getCount(server, PATHS.robots)).toBe(1);
  }, RUN_TEST_TIMEOUT_MS);
});
