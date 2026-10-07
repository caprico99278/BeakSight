// サイトが応答しないときに Run を止める設計書（`2026-10-05-beaksight-site-unavailability-stop-design.md`）の 2.1、2.2、5章。SU1b:
// main frame の読み込みの観測（`src/browser/main-frame-load.ts`）。page の要求と応答の事象で、main frame の最後の文書の要求の応答の
// status を追い、読み込みの終わり方（読み込みが終わった、期限の競争で時間切れ、例外）から、観測（`OK`・`TIMEOUT`・`FAILED`、
// `httpStatus`、`failureDetail`）を作る。実際の headless の Chromium と、テストの中のローカルのサーバ（127.0.0.1）で確かめる。
// 観測を `siteUnavailabilityOf` に渡し、応答（ヘッダ）のない時間切れだけが不調になることも確かめる（応答を受けた後の時間切れは不調でない）。
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeMainFrameLoad,
  trackMainFrameDocument,
  type MainFrameLoadObservation,
  type MainFrameLoadSettlement,
} from '../../src/browser/main-frame-load.js';
import { awaitBeforeDeadline } from '../../src/core/deadline.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';
import { SITE_UNAVAILABLE_HTTP_STATUSES, siteUnavailabilityOf } from '../../src/orchestration/site-availability.js';
import { useHeadlessChromium } from '../helpers/chromium.js';

/** Playwright の読み込みの期限（ms）。実際に期限切れを起こすので、短くする。 */
const LOAD_TIMEOUT_MS = 1_000;
/**
 * ヘッダの後に本文を止める場面の、Playwright の読み込みの期限（ms）。Chromium は、本文が止まった文書の応答の事象（`response`）を、
 * ヘッダを受けてから約 0.5 秒遅れて出す（SU2a の実装者が確かめた。設計書 2.2 の既知の限界）。`LOAD_TIMEOUT_MS` では、応答の事象の
 * 前に期限切れになり、応答を受けたことを観測できないことがあるので、それより十分に長くする（設計書 2.2: ヘッダの後の時間切れを
 * 確かめるときは、期限を 2 秒以上にする）。
 */
const STALL_AFTER_HEADERS_TIMEOUT_MS = 2_000;
/** 期限の競争（`awaitBeforeDeadline`）の期限（ms）。 */
const RACE_DEADLINE_MS = 1_000;
/** 期限の競争で、競わせる読み込みの Playwright の期限（ms）。競争の期限より十分に長くし、競争の期限が先に来るようにする。 */
const RACED_GOTO_TIMEOUT_MS = 10_000;
/**
 * 閉じたポートへの読み込みの Playwright の期限（ms）。Windows は、拒否された接続を数回試し直してから失敗にする（127.0.0.1 でも
 * 約2秒かかる）ので、`LOAD_TIMEOUT_MS` では、拒否の前に期限切れになる。拒否を待てるよう、十分に長くする。
 */
const REFUSED_CONNECTION_TIMEOUT_MS = 15_000;
/** 期限まで待ったかを確かめるときの、タイマーの誤差の許容（ms）。 */
const TIMER_TOLERANCE_MS = 50;

const OK_STATUS = 200;
const FOUND_STATUS = 302;
const NOT_FOUND_STATUS = 404;
/** 不調の代表として返す status（503 Service Unavailable。`SITE_UNAVAILABLE_HTTP_STATUSES` の1つ）。 */
const SERVICE_UNAVAILABLE_STATUS = 503;
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/** テストのサーバのパス。 */
const PATHS = Object.freeze({
  /** 200 の文書を返す。 */
  ok: '/ok',
  /** 503 の文書を返す。 */
  unavailable: '/unavailable',
  /** 接続を受けるが、何も返さない。 */
  hang: '/hang',
  /** 200 のヘッダと本文の始まりを返し、本文を止める。 */
  stallAfterHeaders: '/stall-after-headers',
  /** 200 のヘッダと、503 の iframe と画像を含む本文の始まりを返し、本文を止める。 */
  stallWithFrames: '/stall-with-frames',
  /** 302 で、応答しないパスへリダイレクトする。 */
  redirectToHang: '/redirect-to-hang',
});

type WaitUntil = NonNullable<NonNullable<Parameters<Page['goto']>[1]>['waitUntil']>;

interface TestServer {
  readonly origin: string;
  /** サーバが受けた要求のパスの一覧（受けた順）。 */
  requestedPaths(): readonly string[];
  /** 残った接続（応答しない接続を含む）を切ってから、サーバを閉じる。何度呼んでもよい。 */
  close(): Promise<void>;
}

let browser: Browser;
const contexts: BrowserContext[] = [];
const servers: TestServer[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  // 先に Context を閉じて、終わっていない読み込みを止める（期限の競争で残した読み込みも、ここで終わる）。
  for (const context of contexts.splice(0)) {
    await context.close();
  }
  // 応答しない接続を残したままサーバを閉じると、閉じる処理が終わらないので、接続を切ってから閉じる。
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function sendHtml(response: ServerResponse, status: number, body: string): void {
  const html = `<!doctype html><html><head><title>main frame load</title></head><body>${body}</body></html>`;
  response.writeHead(status, { 'Content-Type': HTML_CONTENT_TYPE, 'Content-Length': Buffer.byteLength(html) });
  response.end(html);
}

/** 200 のヘッダと本文の始まりを送り、本文を止める（`end` しない）。 */
function sendHeadersAndStall(response: ServerResponse, bodyStart: string): void {
  response.writeHead(OK_STATUS, { 'Content-Type': HTML_CONTENT_TYPE });
  response.write(`<!doctype html><html><head><title>stalled</title></head><body>${bodyStart}`);
}

function respond(path: string, response: ServerResponse): void {
  switch (path) {
    case PATHS.ok:
      sendHtml(response, OK_STATUS, '<p>ok</p>');
      return;
    case PATHS.unavailable:
      sendHtml(response, SERVICE_UNAVAILABLE_STATUS, '<p>maintenance</p>');
      return;
    case PATHS.hang:
      return;
    case PATHS.stallAfterHeaders:
      sendHeadersAndStall(response, '<p>the first part</p>');
      return;
    case PATHS.stallWithFrames:
      sendHeadersAndStall(response, `<iframe src="${PATHS.unavailable}"></iframe><img src="${PATHS.unavailable}" alt="">`);
      return;
    case PATHS.redirectToHang:
      response.writeHead(FOUND_STATUS, { Location: PATHS.hang });
      response.end();
      return;
    default:
      sendHtml(response, NOT_FOUND_STATUS, '<p>not found</p>');
  }
}

async function startTestServer(): Promise<TestServer> {
  const requestedPaths: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requestedPaths.push(path);
    respond(path, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  let closing: Promise<void> | undefined;
  const testServer: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    requestedPaths: () => [...requestedPaths],
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      return closing;
    },
  };
  servers.push(testServer);
  return testServer;
}

/** Guard のない素の Context の page。 */
async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

/** `page.goto` の終わり方（読み込みが終わった、または例外）。Playwright の期限は `timeoutMs`（既定は `LOAD_TIMEOUT_MS`）。 */
async function settleGoto(
  page: Page,
  url: string,
  waitUntil: WaitUntil,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<MainFrameLoadSettlement> {
  try {
    return { status: 'FULFILLED', value: await page.goto(url, { waitUntil, timeout: timeoutMs }) };
  } catch (error) {
    return { status: 'REJECTED', reason: error };
  }
}

interface TimedObservation {
  readonly observation: MainFrameLoadObservation;
  readonly elapsedMs: number;
}

/** 追跡を付けて読み込み、観測を作る。追跡は、観測の後に外す。 */
async function observeGoto(
  page: Page,
  url: string,
  waitUntil: WaitUntil,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<TimedObservation> {
  const tracker = trackMainFrameDocument(page);
  const startedAt = performance.now();
  try {
    const settlement = await settleGoto(page, url, waitUntil, timeoutMs);
    return { observation: observeMainFrameLoad(tracker, settlement), elapsedMs: performance.now() - startedAt };
  } finally {
    tracker.dispose();
  }
}

/** 期限まで待った（空振りでなく、実際に期限切れを起こした）ことを確かめる。 */
function expectWaitedUntilDeadline(elapsedMs: number, deadlineMs: number): void {
  expect(elapsedMs).toBeGreaterThanOrEqual(deadlineMs - TIMER_TOLERANCE_MS);
}

/** Playwright の期限切れの観測の、失敗の詳細（上限付きのメッセージ）を確かめる。 */
function expectPlaywrightFailureDetail(observation: MainFrameLoadObservation): void {
  expect(observation.failureDetail).toEqual(expect.any(String));
  expect(observation.failureDetail?.length).toBeGreaterThan(0);
  expect(observation.failureDetail?.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
}

describe('observeMainFrameLoad with a real Chromium and a local server (design 2.1)', () => {
  it('observes TIMEOUT without an HTTP status when the server accepts the connection but never answers', async () => {
    const server = await startTestServer();
    const page = await newPage();

    const { observation, elapsedMs } = await observeGoto(page, `${server.origin}${PATHS.hang}`, 'domcontentloaded');

    expect(observation).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: null });
    expectPlaywrightFailureDetail(observation);
    expect(Object.isFrozen(observation)).toBe(true);
    expectWaitedUntilDeadline(elapsedMs, LOAD_TIMEOUT_MS);
    expect(server.requestedPaths()).toContain(PATHS.hang);
    expect(siteUnavailabilityOf(observation)).toEqual({ kind: 'TIMEOUT', detail: 'TIMEOUT' });
  });

  it.each(['load', 'domcontentloaded'] as const)(
    'observes TIMEOUT with HTTP 200 when the body stalls after the headers (waitUntil: %s), which is not site unavailability',
    async (waitUntil) => {
      const server = await startTestServer();
      const page = await newPage();

      const { observation, elapsedMs } = await observeGoto(
        page,
        `${server.origin}${PATHS.stallAfterHeaders}`,
        waitUntil,
        STALL_AFTER_HEADERS_TIMEOUT_MS,
      );

      expect(observation).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: OK_STATUS });
      expectPlaywrightFailureDetail(observation);
      expectWaitedUntilDeadline(elapsedMs, STALL_AFTER_HEADERS_TIMEOUT_MS);
      expect(siteUnavailabilityOf(observation)).toBeNull();
    },
  );

  it('keeps the status of the main frame document, not of an iframe or an image, when the body stalls', async () => {
    const server = await startTestServer();
    const page = await newPage();
    const seenStatuses: number[] = [];
    page.on('response', (response) => seenStatuses.push(response.status()));

    const { observation, elapsedMs } = await observeGoto(
      page,
      `${server.origin}${PATHS.stallWithFrames}`,
      'load',
      STALL_AFTER_HEADERS_TIMEOUT_MS,
    );

    expect(observation).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: OK_STATUS });
    expectWaitedUntilDeadline(elapsedMs, STALL_AFTER_HEADERS_TIMEOUT_MS);
    // 空振りでないこと: iframe と画像の 503 の応答を、page が実際に受けていた。
    expect(seenStatuses).toContain(SERVICE_UNAVAILABLE_STATUS);
    expect(siteUnavailabilityOf(observation)).toBeNull();
  });

  it('observes OK with HTTP 503 when the load finishes with a 503 response, which is site unavailability', async () => {
    const server = await startTestServer();
    const page = await newPage();

    const { observation } = await observeGoto(page, `${server.origin}${PATHS.unavailable}`, 'domcontentloaded');

    expect(observation).toEqual({ navigationOutcome: 'OK', httpStatus: SERVICE_UNAVAILABLE_STATUS, failureDetail: null });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(SITE_UNAVAILABLE_HTTP_STATUSES).toContain(SERVICE_UNAVAILABLE_STATUS);
    expect(siteUnavailabilityOf(observation)).toEqual({ kind: 'HTTP_STATUS', detail: `HTTP ${SERVICE_UNAVAILABLE_STATUS}` });
  });

  it('observes OK with HTTP 200 when the load finishes with a 200 response, which is not site unavailability', async () => {
    const server = await startTestServer();
    const page = await newPage();

    const { observation } = await observeGoto(page, `${server.origin}${PATHS.ok}`, 'load');

    expect(observation).toEqual({ navigationOutcome: 'OK', httpStatus: OK_STATUS, failureDetail: null });
    expect(siteUnavailabilityOf(observation)).toBeNull();
  });

  it('uses the tracked status when the load finishes without a response (a same-document navigation)', async () => {
    const server = await startTestServer();
    const page = await newPage();
    const tracker = trackMainFrameDocument(page);
    try {
      const first = await settleGoto(page, `${server.origin}${PATHS.unavailable}`, 'domcontentloaded');
      expect(first.status).toBe('FULFILLED');

      const sameDocument = await settleGoto(page, `${server.origin}${PATHS.unavailable}#part`, 'domcontentloaded');

      expect(sameDocument).toEqual({ status: 'FULFILLED', value: null });
      expect(observeMainFrameLoad(tracker, sameDocument))
        .toEqual({ navigationOutcome: 'OK', httpStatus: SERVICE_UNAVAILABLE_STATUS, failureDetail: null });
    } finally {
      tracker.dispose();
    }
  });

  it('forgets the 302 response of a redirect, and observes TIMEOUT without an HTTP status when the redirect target never answers', async () => {
    const server = await startTestServer();
    const page = await newPage();
    const seenStatuses: number[] = [];
    page.on('response', (response) => seenStatuses.push(response.status()));

    const { observation, elapsedMs } = await observeGoto(page, `${server.origin}${PATHS.redirectToHang}`, 'domcontentloaded');

    expect(observation).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: null });
    expectPlaywrightFailureDetail(observation);
    expectWaitedUntilDeadline(elapsedMs, LOAD_TIMEOUT_MS);
    // 空振りでないこと: リダイレクトの 302 の応答の事象を page が出し、リダイレクトの先の要求がサーバに届いていた。
    expect(seenStatuses).toContain(FOUND_STATUS);
    expect(server.requestedPaths()).toEqual(expect.arrayContaining([PATHS.redirectToHang, PATHS.hang]));
    expect(siteUnavailabilityOf(observation)).toEqual({ kind: 'TIMEOUT', detail: 'TIMEOUT' });
  });

  it('observes FAILED with net::ERR_CONNECTION_REFUSED and without an HTTP status for a closed port', async () => {
    const closed = await startTestServer();
    await closed.close();
    const page = await newPage();

    const { observation, elapsedMs } = await observeGoto(
      page,
      `${closed.origin}${PATHS.ok}`,
      'domcontentloaded',
      REFUSED_CONNECTION_TIMEOUT_MS,
    );

    expect(observation).toMatchObject({ navigationOutcome: 'FAILED', httpStatus: null });
    expect(elapsedMs).toBeLessThan(REFUSED_CONNECTION_TIMEOUT_MS);
    expect(observation.failureDetail).toContain('net::ERR_CONNECTION_REFUSED');
    expectPlaywrightFailureDetail(observation);
    expect(siteUnavailabilityOf(observation))
      .toEqual({ kind: 'NETWORK_FAILURE', detail: 'FAILED:net::ERR_CONNECTION_REFUSED' });
  });

  it('observes TIMEOUT without an HTTP status and without a failure detail when the deadline race is lost', async () => {
    const server = await startTestServer();
    const page = await newPage();
    const tracker = trackMainFrameDocument(page);
    try {
      const startedAt = performance.now();
      const settlement = await awaitBeforeDeadline(
        page.goto(`${server.origin}${PATHS.hang}`, { waitUntil: 'domcontentloaded', timeout: RACED_GOTO_TIMEOUT_MS }),
        Date.now() + RACE_DEADLINE_MS,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(settlement.status).toBe('DEADLINE_EXCEEDED');
      expectWaitedUntilDeadline(elapsedMs, RACE_DEADLINE_MS);
      const observation = observeMainFrameLoad(tracker, settlement);
      expect(observation).toEqual({ navigationOutcome: 'TIMEOUT', httpStatus: null, failureDetail: null });
      expect(Object.isFrozen(observation)).toBe(true);
      expect(server.requestedPaths()).toContain(PATHS.hang);
      expect(siteUnavailabilityOf(observation)).toEqual({ kind: 'TIMEOUT', detail: 'TIMEOUT' });
    } finally {
      tracker.dispose();
    }
  });
});

describe('trackMainFrameDocument (design 2.1)', () => {
  it('keeps its value after dispose (the listeners are removed), and dispose can be called more than once', async () => {
    const server = await startTestServer();
    const page = await newPage();
    const tracker = trackMainFrameDocument(page);
    const unavailable = await settleGoto(page, `${server.origin}${PATHS.unavailable}`, 'domcontentloaded');
    expect(unavailable.status).toBe('FULFILLED');
    expect(tracker.latestResponseStatus()).toBe(SERVICE_UNAVAILABLE_STATUS);

    tracker.dispose();
    tracker.dispose();
    const ok = await settleGoto(page, `${server.origin}${PATHS.ok}`, 'domcontentloaded');
    const hang = await settleGoto(page, `${server.origin}${PATHS.hang}`, 'domcontentloaded');

    expect(ok.status === 'FULFILLED' ? ok.value?.status() : null).toBe(OK_STATUS);
    expect(hang.status).toBe('REJECTED');
    expect(tracker.latestResponseStatus()).toBe(SERVICE_UNAVAILABLE_STATUS);
  });

  it('ignores a request whose frame() throws (for example, a request of a service worker)', () => {
    const mainFrame = Object.freeze({});
    const page = Object.assign(new EventEmitter(), { mainFrame: () => mainFrame });
    const tracker = trackMainFrameDocument(page as unknown as Page);
    const document = { isNavigationRequest: () => true, frame: () => mainFrame };
    const frameless = {
      isNavigationRequest: () => true,
      frame: () => {
        throw new Error('Service Worker requests do not have an associated frame.');
      },
    };
    try {
      page.emit('request', document);
      page.emit('response', { request: () => document, status: () => SERVICE_UNAVAILABLE_STATUS });

      expect(() => page.emit('request', frameless)).not.toThrow();
      page.emit('response', { request: () => frameless, status: () => OK_STATUS });

      expect(tracker.latestResponseStatus()).toBe(SERVICE_UNAVAILABLE_STATUS);
    } finally {
      tracker.dispose();
    }
    expect(page.listenerCount('request')).toBe(0);
    expect(page.listenerCount('response')).toBe(0);
  });
});
