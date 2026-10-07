// サイトの不調で止めたときの診断の記録の設計書（`2026-10-06-beaksight-site-unavailable-diagnostics-design.md`）の 2.1、4章。D1:
// ページ本体の要求の観察（`src/browser/navigation-diagnostics.ts`）。Guard とは別の CDP の session で `Network.enable` だけを行い、main frame の
// 文書の要求の事象（発行、ヘッダの送信、応答、終わり・失敗）を、要求ごとに記録する。header の中身と本文は記録しない。
//
// - 実際の Chromium で確かめる場面は、Guard の付いた本物の factory の Context（`createGateFactory`）で、テストの既定の Chromium（headless
//   shell）と、CLI と同じ起動の設定（`chromiumLaunchOptions({ headless: true })`）の両方で動かす（DEF-030）。
// - サーバは、このテストの中の 127.0.0.1 の `node:http` のサーバだけを使う。
// - 事象の順の組み合わせ（リダイレクトの応答の ExtraInfo が、次の要求の発行の後に届く、ネットワークに出ない内部のリダイレクト）と、上限と、
//   観察を始められない場合の一部は、偽の CDP の session で確かめる（`main-frame-load.test.ts` の偽の page と同じやり方）。
import { EventEmitter } from 'node:events';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import {
  MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS,
  MAX_NAVIGATION_DIAGNOSTICS_EVENTS,
  NAVIGATION_DIAGNOSTICS_CDP_COMMANDS,
  NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE,
  startNavigationDiagnostics,
} from '../../src/browser/navigation-diagnostics.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type {
  NavigationDiagnostics,
  NavigationDocumentRequestDiagnostics,
  NavigationDocumentRequestHop,
  ObservedNavigationDiagnostics,
} from '../../src/core/contracts.js';
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HTTP_METHOD_LENGTH,
  MAX_URL_LENGTH,
  SESSION_OPEN_TIMEOUT_MS,
} from '../../src/core/limits.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { createGateFactory, withGuardedPassivePage, withUnguardedPage } from '../helpers/gate-harness.js';

/** 終わる読み込み（200、リダイレクト）の Playwright の期限（ms）。読み込みは数十 ms で終わるので、十分に長くする。 */
const COMPLETING_LOAD_TIMEOUT_MS = 10_000;
/** 終わらない読み込み（応答しないサーバ、止めた要求）の Playwright の期限（ms）。実際に期限切れを起こすので、短くする。 */
const STALLED_LOAD_TIMEOUT_MS = 1_000;
/**
 * 時刻を比べるときの許容（ms）。要求の発行の時刻は Chromium の壁時計（`wallTime`）で、ほかの時刻は Node の `Date.now()` なので、
 * 同じ時計でも、丸めとタイマーの誤差の分だけずれうる。
 */
const CLOCK_TOLERANCE_MS = 50;
/** 観察を始める処理の期限（ms）。製品と同じ、Context と page の作成の期限の上限を使う。 */
const START_TIMEOUT_MS = SESSION_OPEN_TIMEOUT_MS;

const OK_STATUS = 200;
const FOUND_STATUS = 302;
const NOT_FOUND_STATUS = 404;
const LOOPBACK_ADDRESS = '127.0.0.1';
const HTML_TYPE = Object.freeze({ 'Content-Type': 'text/html; charset=utf-8' });

/** サーバのパス（パスごとに応答の種類が決まる。`startDiagnosticsServer`）。 */
const PATHS = Object.freeze({
  /** 200 の文書。Cookie を設定する（`Set-Cookie`）。 */
  ok: '/ok',
  /** 302 で `PATHS.ok` へリダイレクトする。 */
  redirect: '/redirect',
  /** 接続を受けるが、何も返さない。 */
  hang: '/hang',
  /** `PATHS.ok` の iframe を持つ 200 の文書。 */
  withFrame: '/with-frame',
});

/** 応答で設定する Cookie の値と、Context に入れておく Cookie の値（記録に header の中身がないことを確かめる印）。 */
const SET_COOKIE_VALUE = 'diagnostics-set-cookie-marker';
const CONTEXT_COOKIE = Object.freeze({ name: 'diagnostics-cookie', value: 'diagnostics-request-cookie-marker' });
/** 記録の JSON に現れてはならない header の名前（小文字で比べる）。 */
const FORBIDDEN_HEADER_NAMES = Object.freeze(['cookie', 'set-cookie', 'user-agent', 'accept', 'host', 'content-type']);

const pageHtml = (title: string, body = ''): string => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + `<title>${title}</title></head><body><main><h1>${title}</h1></main>${body}</body></html>`;

interface ReceivedRequest {
  readonly pathname: string;
  readonly headers: IncomingHttpHeaders;
}

interface DiagnosticsServer {
  readonly origin: string;
  readonly port: number;
  /** 受けた要求（受けた順）。 */
  readonly requests: readonly ReceivedRequest[];
  /** `pathname` への要求の件数。 */
  count(pathname: string): number;
  /** 残った接続（応答しない接続を含む）を切ってから、サーバを閉じる。何度呼んでもよい。 */
  close(): Promise<void>;
}

const servers: DiagnosticsServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function respond(pathname: string, response: ServerResponse): void {
  switch (pathname) {
    case PATHS.ok:
      response.writeHead(OK_STATUS, { ...HTML_TYPE, 'Set-Cookie': `diagnostics-set=${SET_COOKIE_VALUE}; Path=/` });
      response.end(pageHtml('OK'));
      return;
    case PATHS.redirect:
      response.writeHead(FOUND_STATUS, { Location: PATHS.ok });
      response.end();
      return;
    case PATHS.hang:
      return;
    case PATHS.withFrame:
      response.writeHead(OK_STATUS, HTML_TYPE);
      response.end(pageHtml('With a frame', `<iframe src="${PATHS.ok}" title="frame"></iframe>`));
      return;
    default:
      response.writeHead(NOT_FOUND_STATUS, HTML_TYPE);
      response.end(pageHtml('Not found'));
  }
}

async function startDiagnosticsServer(): Promise<DiagnosticsServer> {
  const requests: ReceivedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    requests.push({ pathname, headers: request.headers });
    respond(pathname, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_ADDRESS, port: 0 }, resolve);
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  const diagnosticsServer: DiagnosticsServer = {
    origin: `http://${LOOPBACK_ADDRESS}:${port}`,
    port,
    requests,
    count: (pathname) => requests.filter((request) => request.pathname === pathname).length,
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
  servers.push(diagnosticsServer);
  return diagnosticsServer;
}

type WaitUntil = NonNullable<NonNullable<Parameters<Page['goto']>[1]>['waitUntil']>;

interface ObservedLoad {
  readonly diagnostics: NavigationDiagnostics;
  /** 読み込みが例外で終わったか（期限切れなど）。 */
  readonly loadRejected: boolean;
}

/** 観察を始めてから `url` を読み込み、読み込みの結果によらず、読み込みの直後に観察を終える（Page Auditor と同じ順）。 */
async function observeLoad(
  page: Page,
  url: string,
  timeoutMs: number,
  waitUntil: WaitUntil = 'domcontentloaded',
): Promise<ObservedLoad> {
  const recorder = await startNavigationDiagnostics(page, { deadlineAtMs: Date.now() + START_TIMEOUT_MS });
  let loadRejected = false;
  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
  } catch {
    loadRejected = true;
  }
  return { diagnostics: await recorder.finish(), loadRejected };
}

function expectObserved(diagnostics: NavigationDiagnostics): ObservedNavigationDiagnostics {
  expect(diagnostics.status).toBe('OBSERVED');
  if (diagnostics.status !== 'OBSERVED') {
    throw new Error(`the navigation was not observed: ${diagnostics.reason}`);
  }
  return diagnostics;
}

/** 観察した唯一の文書の要求。 */
function onlyDocumentRequest(diagnostics: ObservedNavigationDiagnostics): NavigationDocumentRequestDiagnostics {
  expect(diagnostics.documentRequests).toHaveLength(1);
  expect(diagnostics.omittedDocumentRequestCount).toBe(0);
  expect(diagnostics.omittedEventCount).toBe(0);
  return diagnostics.documentRequests[0] as NavigationDocumentRequestDiagnostics;
}

/** 時刻が、観察の間（許容の分だけ広げたもの）にある。 */
function expectWithinObservation(diagnostics: ObservedNavigationDiagnostics, timeMs: number | null): void {
  expect(timeMs).toEqual(expect.any(Number));
  expect(timeMs as number).toBeGreaterThanOrEqual(diagnostics.observationStartedAtMs - CLOCK_TOLERANCE_MS);
  expect(timeMs as number).toBeLessThanOrEqual(diagnostics.observationEndedAtMs + CLOCK_TOLERANCE_MS);
}

/** 要求のヘッダを送り、応答のヘッダを受けた1回分の要求の確かめ。 */
function expectAnswered(
  diagnostics: ObservedNavigationDiagnostics,
  hop: NavigationDocumentRequestHop | undefined,
  expected: { readonly url: string; readonly status: number; readonly port: number },
): void {
  expect(hop).toMatchObject({
    url: expected.url,
    method: 'GET',
    truncated: false,
    httpStatus: expected.status,
    remoteIpAddress: LOOPBACK_ADDRESS,
    remotePort: expected.port,
  });
  expectWithinObservation(diagnostics, hop?.issuedAtMs ?? null);
  expectWithinObservation(diagnostics, hop?.requestHeadersSentAtMs ?? null);
  expectWithinObservation(diagnostics, hop?.responseHeadersReceivedAtMs ?? null);
  expect(hop?.responseHeadersReceivedAtMs as number).toBeGreaterThanOrEqual(hop?.requestHeadersSentAtMs as number);
}

/** `context` の `newCDPSession` で開いた session に送った命令の名前を集める（Guard の session は、page を作るときに開くので含まない）。 */
function recordSentCommands(context: BrowserContext): string[] {
  const sent: string[] = [];
  const openSession = context.newCDPSession.bind(context);
  vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => {
    const session = await openSession(target);
    const send = session.send.bind(session);
    vi.spyOn(session, 'send').mockImplementation(((method: string, params?: object) => {
      sent.push(method);
      return (send as (name: string, args?: object) => Promise<unknown>)(method, params);
    }) as unknown as CDPSession['send']);
    return session;
  });
  return sent;
}

const CHROMIUM_BUILDS = [
  { name: 'the default test Chromium (headless shell)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  {
    name: 'the Chromium of the CLI (chromiumLaunchOptions, headless)',
    launch: (): Promise<Browser> => chromium.launch(chromiumLaunchOptions({ headless: true })),
  },
] as const;

describe.each(CHROMIUM_BUILDS)('startNavigationDiagnostics in a Guarded Passive Context: $name (design 2.1)', ({ launch }) => {
  let browser: Browser;
  const viewport = DEFAULT_CONFIG.viewports.primaryDesktop;

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('records the issue, the sent headers, the 200 response, and the end of a document request, sending only Network.enable', async () => {
    const server = await startDiagnosticsServer();
    const url = `${server.origin}${PATHS.ok}`;

    const { diagnostics, sent } = await withGuardedPassivePage(createGateFactory(browser, server.origin), viewport, async (page, context) => {
      const commands = recordSentCommands(context);
      const load = await observeLoad(page, url, COMPLETING_LOAD_TIMEOUT_MS);
      expect(load.loadRejected).toBe(false);
      return { diagnostics: load.diagnostics, sent: commands };
    }, { expectNoViolations: true });

    const observed = expectObserved(diagnostics);
    const request = onlyDocumentRequest(observed);
    expect(request.hops).toHaveLength(1);
    expectAnswered(observed, request.hops[0], { url, status: OK_STATUS, port: server.port });
    expectWithinObservation(observed, request.loadingFinishedAtMs);
    expect(request.loadingFinishedAtMs as number).toBeGreaterThanOrEqual(request.hops[0]?.responseHeadersReceivedAtMs as number);
    expect(request.loadingFailure).toBeNull();
    expect(observed.observationEndedAtMs).toBeGreaterThanOrEqual(observed.observationStartedAtMs);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(request.hops[0])).toBe(true);
    // 観察の session に送った命令は、main frame の ID を読む命令と `Network.enable` だけで、Fetch の domain を使わない。
    expect(sent).toEqual([...NAVIGATION_DIAGNOSTICS_CDP_COMMANDS]);
    expect(NAVIGATION_DIAGNOSTICS_CDP_COMMANDS).toEqual(['Page.getFrameTree', 'Network.enable']);
    expect(sent.some((method) => method.startsWith('Fetch.'))).toBe(false);
    expect(server.count(PATHS.ok)).toBe(1);
  });

  it('records the issue and the sent headers without a response when the server never answers, finishing after the load deadline', async () => {
    const server = await startDiagnosticsServer();
    const url = `${server.origin}${PATHS.hang}`;

    const load = await withGuardedPassivePage(
      createGateFactory(browser, server.origin),
      viewport,
      (page) => observeLoad(page, url, STALLED_LOAD_TIMEOUT_MS),
      { expectNoViolations: true },
    );

    expect(load.loadRejected).toBe(true);
    const observed = expectObserved(load.diagnostics);
    const request = onlyDocumentRequest(observed);
    expect(request.hops).toHaveLength(1);
    const [hop] = request.hops;
    expect(hop).toMatchObject({ url, method: 'GET', responseHeadersReceivedAtMs: null, httpStatus: null, remoteIpAddress: null, remotePort: null });
    expectWithinObservation(observed, hop?.issuedAtMs ?? null);
    expectWithinObservation(observed, hop?.requestHeadersSentAtMs ?? null);
    expect(request.loadingFinishedAtMs).toBeNull();
    expect(request.loadingFailure).toBeNull();
    // 読み込みの期限の後に観察を終えた（期限の間、応答がなかった）。
    expect(observed.observationEndedAtMs - (hop?.issuedAtMs as number)).toBeGreaterThanOrEqual(STALLED_LOAD_TIMEOUT_MS - CLOCK_TOLERANCE_MS);
    expect(server.count(PATHS.hang)).toBe(1);
  });

  it('records the issue without the sent headers when the document request is held before it is sent', async () => {
    const server = await startDiagnosticsServer();
    const url = `${server.origin}${PATHS.ok}`;
    const paused = createDeferred<string>();

    const load = await withGuardedPassivePage(createGateFactory(browser, server.origin), viewport, async (page, context) => {
      // 別の CDP の session で、文書の要求を Request の段階で止めたままにする（ネットワークへ送らせない）。
      const holder = await context.newCDPSession(page);
      holder.on('Fetch.requestPaused', (event) => paused.resolve(event.request.url));
      await holder.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
      return observeLoad(page, url, STALLED_LOAD_TIMEOUT_MS);
    }, { expectNoViolations: true });

    // 空振りでないこと: 要求は止められ、サーバに届かなかった。
    await expect(paused.promise).resolves.toBe(url);
    expect(load.loadRejected).toBe(true);
    expect(server.count(PATHS.ok)).toBe(0);
    const observed = expectObserved(load.diagnostics);
    const request = onlyDocumentRequest(observed);
    expect(request.hops).toHaveLength(1);
    const [hop] = request.hops;
    expect(hop).toMatchObject({ url, method: 'GET', requestHeadersSentAtMs: null, responseHeadersReceivedAtMs: null, httpStatus: null });
    expectWithinObservation(observed, hop?.issuedAtMs ?? null);
    expect(request.loadingFinishedAtMs).toBeNull();
    expect(request.loadingFailure).toBeNull();
  });

  it('records a 302 redirect and its 200 target as two hops of the same document request', async () => {
    const server = await startDiagnosticsServer();
    const redirectUrl = `${server.origin}${PATHS.redirect}`;
    const targetUrl = `${server.origin}${PATHS.ok}`;

    const load = await withGuardedPassivePage(
      createGateFactory(browser, server.origin),
      viewport,
      (page) => observeLoad(page, redirectUrl, COMPLETING_LOAD_TIMEOUT_MS),
      { expectNoViolations: true },
    );

    expect(load.loadRejected).toBe(false);
    const observed = expectObserved(load.diagnostics);
    const request = onlyDocumentRequest(observed);
    expect(request.hops).toHaveLength(2);
    expectAnswered(observed, request.hops[0], { url: redirectUrl, status: FOUND_STATUS, port: server.port });
    expectAnswered(observed, request.hops[1], { url: targetUrl, status: OK_STATUS, port: server.port });
    expect(request.hops[1]?.issuedAtMs as number)
      .toBeGreaterThanOrEqual((request.hops[0]?.issuedAtMs as number) - CLOCK_TOLERANCE_MS);
    expectWithinObservation(observed, request.loadingFinishedAtMs);
    expect(request.loadingFailure).toBeNull();
    expect(server.count(PATHS.redirect)).toBe(1);
    expect(server.count(PATHS.ok)).toBe(1);
  });

  it('records only the document request of the main frame, not the document request of an iframe', async () => {
    const server = await startDiagnosticsServer();
    const url = `${server.origin}${PATHS.withFrame}`;

    const load = await withGuardedPassivePage(
      createGateFactory(browser, server.origin),
      viewport,
      (page) => observeLoad(page, url, COMPLETING_LOAD_TIMEOUT_MS, 'load'),
      { expectNoViolations: true },
    );

    expect(load.loadRejected).toBe(false);
    // 空振りでないこと: iframe の文書の要求も、サーバに届いた。
    expect(server.count(PATHS.ok)).toBe(1);
    const request = onlyDocumentRequest(expectObserved(load.diagnostics));
    expect(request.hops.map((hop) => hop.url)).toEqual([url]);
  });

  it('keeps the names and the values of the request and response headers out of the record', async () => {
    const server = await startDiagnosticsServer();
    const redirectUrl = `${server.origin}${PATHS.redirect}`;

    const load = await withGuardedPassivePage(createGateFactory(browser, server.origin), viewport, async (page, context) => {
      await context.addCookies([{ ...CONTEXT_COOKIE, url: server.origin }]);
      return observeLoad(page, redirectUrl, COMPLETING_LOAD_TIMEOUT_MS);
    }, { expectNoViolations: true });

    expect(load.loadRejected).toBe(false);
    // 空振りでないこと: 要求は Cookie と User-Agent を送り、応答は Cookie を設定した。
    const target = server.requests.find((request) => request.pathname === PATHS.ok);
    expect(target?.headers.cookie).toContain(CONTEXT_COOKIE.value);
    const userAgent = target?.headers['user-agent'];
    expect(userAgent).toEqual(expect.any(String));
    const json = JSON.stringify(load.diagnostics);
    expect(expectObserved(load.diagnostics).documentRequests).toHaveLength(1);
    for (const name of FORBIDDEN_HEADER_NAMES) {
      expect(json.toLowerCase(), `header name ${name}`).not.toContain(`"${name}"`);
    }
    expect(json.toLowerCase()).not.toContain('cookie');
    expect(json).not.toContain(CONTEXT_COOKIE.value);
    expect(json).not.toContain(SET_COOKIE_VALUE);
    expect(json).not.toContain(userAgent as string);
  });
});

describe('startNavigationDiagnostics when the observation cannot start (design 2.1)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchHeadlessChromium();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('records that it could not observe a closed page, without throwing, and finish can be called more than once', async () => {
    const diagnostics = await withUnguardedPage(browser, DEFAULT_CONFIG.viewports.primaryDesktop, async (page) => {
      await page.close();
      const recorder = await startNavigationDiagnostics(page, { deadlineAtMs: Date.now() + START_TIMEOUT_MS });
      const first = await recorder.finish();
      const second = await recorder.finish();
      expect(second).toBe(first);
      return first;
    });

    expect(diagnostics.status).toBe('NOT_OBSERVED');
    if (diagnostics.status === 'NOT_OBSERVED') {
      expect(diagnostics.reason.length).toBeGreaterThan(0);
      expect(diagnostics.reason.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
    }
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('records that it could not observe, without opening a session, when the start deadline has already passed', async () => {
    const diagnostics = await withUnguardedPage(browser, DEFAULT_CONFIG.viewports.primaryDesktop, async (page) => {
      const opened = vi.spyOn(page.context(), 'newCDPSession');
      const recorder = await startNavigationDiagnostics(page, { deadlineAtMs: Date.now() - 1 });
      expect(opened).not.toHaveBeenCalled();
      return recorder.finish();
    });

    expect(diagnostics).toEqual({ status: 'NOT_OBSERVED', reason: NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE });
  });

  it('finishes without throwing after the page is closed', async () => {
    const server = await startDiagnosticsServer();
    const diagnostics = await withUnguardedPage(browser, DEFAULT_CONFIG.viewports.primaryDesktop, async (page) => {
      const recorder = await startNavigationDiagnostics(page, { deadlineAtMs: Date.now() + START_TIMEOUT_MS });
      await page.goto(`${server.origin}${PATHS.ok}`, { waitUntil: 'domcontentloaded', timeout: COMPLETING_LOAD_TIMEOUT_MS });
      await page.close();
      return recorder.finish();
    });

    expect(onlyDocumentRequest(expectObserved(diagnostics)).hops[0]?.httpStatus).toBe(OK_STATUS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 偽の CDP の session（事象の順の組み合わせ、上限、始める処理の失敗）
// ---------------------------------------------------------------------------------------------------------------

const FAKE_MAIN_FRAME_ID = 'main-frame';
const FAKE_CHILD_FRAME_ID = 'child-frame';
const MILLISECONDS_PER_SECOND = 1_000;
/** 偽の要求の発行の壁時計（CDP の `wallTime`。秒）。 */
const FAKE_WALL_TIME_SECONDS = 1_800_000_000.25;
const FAKE_WALL_TIME_MS = FAKE_WALL_TIME_SECONDS * MILLISECONDS_PER_SECOND;
/** 偽の事象を受けた時刻（`Date.now()` の値）。 */
const FAKE_RECEIVED_AT_MS = 1_800_000_000_500;
const FAKE_ORIGIN = 'https://site.test';
/** 偽の応答の接続先（文書用のアドレスの範囲 TEST-NET-1）と port。 */
const FAKE_REMOTE_ADDRESS = '192.0.2.1';
const FAKE_PORT = 443;
/** ネットワークに出ない内部のリダイレクト（HSTS など）の status。 */
const INTERNAL_REDIRECT_STATUS = 307;
/** 観察を始める処理が終わらない場面の、始める処理の期限（ms）。 */
const SHORT_START_DEADLINE_MS = 50;

interface FakeSessionBehavior {
  /** `Network.enable` の結果（省略すると成功）。 */
  readonly enable?: () => Promise<unknown>;
  /** `detach` の結果（省略すると成功）。 */
  readonly detach?: () => Promise<void>;
}

/** CDP の session の偽物。事象は `emit` で出す。送った命令と、`detach` を呼んだ回数を数える。 */
class FakeCdpSession extends EventEmitter {
  readonly sent: string[] = [];
  detachCalls = 0;
  readonly #behavior: FakeSessionBehavior;

  constructor(behavior: FakeSessionBehavior = {}) {
    super();
    this.#behavior = behavior;
  }

  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: FAKE_MAIN_FRAME_ID } } };
    }
    if (method === 'Network.enable') {
      return this.#behavior.enable === undefined ? {} : this.#behavior.enable();
    }
    throw new Error(`unexpected command ${method}`);
  }

  detach(): Promise<void> {
    this.detachCalls += 1;
    return this.#behavior.detach === undefined ? Promise.resolve() : this.#behavior.detach();
  }
}

/** `context().newCDPSession()` が `session` を返す、偽の page。 */
const fakePage = (session: Promise<FakeCdpSession>): Page =>
  ({ context: () => ({ newCDPSession: () => session }) }) as unknown as Page;

async function startFake(session: FakeCdpSession): Promise<Awaited<ReturnType<typeof startNavigationDiagnostics>>> {
  return startNavigationDiagnostics(fakePage(Promise.resolve(session)), { deadlineAtMs: Date.now() + START_TIMEOUT_MS });
}

const fakeUrl = (path: string): string => `${FAKE_ORIGIN}${path}`;

/** main frame（既定）の文書の要求の発行（`Network.requestWillBeSent`）。header は、記録しないことを確かめるために持たせる。 */
const requestWillBeSent = (
  requestId: string,
  path: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  requestId,
  loaderId: requestId,
  documentURL: fakeUrl(path),
  request: { url: fakeUrl(path), method: 'GET', headers: { Cookie: 'fake-cookie', 'User-Agent': 'fake-agent' } },
  timestamp: 1,
  wallTime: FAKE_WALL_TIME_SECONDS,
  type: 'Document',
  frameId: FAKE_MAIN_FRAME_ID,
  ...extra,
});
const redirectResponse = (status: number, remoteIPAddress: string): Record<string, unknown> =>
  ({ url: '', status, headers: { 'Set-Cookie': 'fake' }, remoteIPAddress, remotePort: FAKE_PORT });
const requestExtraInfo = (requestId: string): Record<string, unknown> =>
  ({ requestId, associatedCookies: [], headers: { Cookie: 'fake-cookie' }, connectTiming: { requestTime: 1 } });
const responseExtraInfo = (requestId: string, statusCode: number): Record<string, unknown> =>
  ({ requestId, blockedCookies: [], headers: { 'Set-Cookie': 'fake' }, resourceIPAddressSpace: 'Public', statusCode });
const responseReceived = (requestId: string, status: number): Record<string, unknown> => ({
  requestId,
  loaderId: requestId,
  timestamp: 2,
  type: 'Document',
  response: { url: '', status, headers: {}, remoteIPAddress: FAKE_REMOTE_ADDRESS, remotePort: FAKE_PORT },
  hasExtraInfo: true,
  frameId: FAKE_MAIN_FRAME_ID,
});

/** 偽の事象を受けた時刻を、`FAKE_RECEIVED_AT_MS` にする（観察を始めた後に呼ぶ）。 */
const fixReceivedTime = (): void => {
  vi.spyOn(Date, 'now').mockReturnValue(FAKE_RECEIVED_AT_MS);
};

describe('startNavigationDiagnostics with a fake CDP session (design 2.1)', () => {
  it('uses the wall time of the issue, and the received time of the other events', async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    fixReceivedTime();

    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/page'));
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));
    session.emit('Network.responseReceivedExtraInfo', responseExtraInfo('r1', OK_STATUS));
    session.emit('Network.responseReceived', responseReceived('r1', OK_STATUS));
    session.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 3, encodedDataLength: 10 });

    const request = onlyDocumentRequest(expectObserved(await recorder.finish()));
    expect(request).toEqual({
      hops: [{
        url: fakeUrl('/page'),
        method: 'GET',
        truncated: false,
        issuedAtMs: FAKE_WALL_TIME_MS,
        requestHeadersSentAtMs: FAKE_RECEIVED_AT_MS,
        responseHeadersReceivedAtMs: FAKE_RECEIVED_AT_MS,
        httpStatus: OK_STATUS,
        remoteIpAddress: FAKE_REMOTE_ADDRESS,
        remotePort: FAKE_PORT,
      }],
      loadingFinishedAtMs: FAKE_RECEIVED_AT_MS,
      loadingFailure: null,
    });
    expect(session.sent).toEqual([...NAVIGATION_DIAGNOSTICS_CDP_COMMANDS]);
  });

  it('matches the response ExtraInfo of a redirect that arrives after the next issue to the redirected hop', async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    fixReceivedTime();

    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/redirect'));
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));
    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/hang', {
      redirectResponse: redirectResponse(FOUND_STATUS, FAKE_REMOTE_ADDRESS),
      redirectHasExtraInfo: true,
    }));
    // リダイレクトの応答の ExtraInfo が、次の要求の発行の後に届く（CLI の Chromium で見た順）。
    session.emit('Network.responseReceivedExtraInfo', responseExtraInfo('r1', FOUND_STATUS));
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));

    const request = onlyDocumentRequest(expectObserved(await recorder.finish()));
    expect(request.hops).toEqual([
      expect.objectContaining({
        url: fakeUrl('/redirect'),
        requestHeadersSentAtMs: FAKE_RECEIVED_AT_MS,
        responseHeadersReceivedAtMs: FAKE_RECEIVED_AT_MS,
        httpStatus: FOUND_STATUS,
        remoteIpAddress: FAKE_REMOTE_ADDRESS,
        remotePort: FAKE_PORT,
      }),
      // リダイレクトの先は、ヘッダを送ったが、応答はない。
      expect.objectContaining({
        url: fakeUrl('/hang'),
        requestHeadersSentAtMs: FAKE_RECEIVED_AT_MS,
        responseHeadersReceivedAtMs: null,
        httpStatus: null,
        remoteIpAddress: null,
        remotePort: null,
      }),
    ]);
  });

  it('does not give the sent headers to a hop that never reached the network (an internal redirect without ExtraInfo)', async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    fixReceivedTime();

    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/insecure'));
    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/secure', {
      redirectResponse: redirectResponse(INTERNAL_REDIRECT_STATUS, ''),
      redirectHasExtraInfo: false,
    }));
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));

    const request = onlyDocumentRequest(expectObserved(await recorder.finish()));
    expect(request.hops).toEqual([
      expect.objectContaining({ url: fakeUrl('/insecure'), requestHeadersSentAtMs: null, httpStatus: INTERNAL_REDIRECT_STATUS, remoteIpAddress: null }),
      expect.objectContaining({ url: fakeUrl('/secure'), requestHeadersSentAtMs: FAKE_RECEIVED_AT_MS, responseHeadersReceivedAtMs: null }),
    ]);
  });

  it('records the failure of a document request, and ignores other requests, other frames, and unknown request IDs', async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    fixReceivedTime();

    session.emit('Network.requestWillBeSent', requestWillBeSent('image', '/image.png', { type: 'Image' }));
    session.emit('Network.requestWillBeSent', requestWillBeSent('frame', '/frame', { frameId: FAKE_CHILD_FRAME_ID }));
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('unknown'));
    session.emit('Network.loadingFinished', { requestId: 'image', timestamp: 3, encodedDataLength: 1 });
    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/page'));
    session.emit('Network.loadingFailed', { requestId: 'r1', timestamp: 3, type: 'Document', errorText: 'net::ERR_ABORTED', canceled: true });

    const request = onlyDocumentRequest(expectObserved(await recorder.finish()));
    expect(request.hops.map((hop) => hop.url)).toEqual([fakeUrl('/page')]);
    expect(request.loadingFinishedAtMs).toBeNull();
    expect(request.loadingFailure).toEqual({ failedAtMs: FAKE_RECEIVED_AT_MS, errorText: 'net::ERR_ABORTED', canceled: true });
  });

  it(`keeps at most ${MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS} document requests and counts the rest`, async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    const overflow = 2;

    for (let index = 0; index < MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS + overflow; index += 1) {
      session.emit('Network.requestWillBeSent', requestWillBeSent(`r${index}`, `/page-${index}`));
      session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo(`r${index}`));
    }

    const observed = expectObserved(await recorder.finish());
    expect(MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS).toBe(16);
    expect(observed.documentRequests).toHaveLength(MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS);
    expect(observed.documentRequests.at(-1)?.hops[0]?.url).toBe(fakeUrl(`/page-${MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS - 1}`));
    expect(observed.omittedDocumentRequestCount).toBe(overflow);
    // 記録しなかった要求の事象は、事象の上限の数に含めない。
    expect(observed.omittedEventCount).toBe(0);
  });

  it(`keeps at most ${MAX_NAVIGATION_DIAGNOSTICS_EVENTS} events and counts the rest`, async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    const overflow = 3;

    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/page'));
    for (let index = 1; index < MAX_NAVIGATION_DIAGNOSTICS_EVENTS; index += 1) {
      session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));
    }
    for (let index = 0; index < overflow; index += 1) {
      session.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 3, encodedDataLength: 1 });
    }
    // 事象の上限に達した後の新しい文書の要求は、記録せずに数える。
    session.emit('Network.requestWillBeSent', requestWillBeSent('r2', '/next'));

    const observed = expectObserved(await recorder.finish());
    expect(MAX_NAVIGATION_DIAGNOSTICS_EVENTS).toBe(128);
    expect(observed.documentRequests).toHaveLength(1);
    expect(observed.documentRequests[0]?.loadingFinishedAtMs).toBeNull();
    expect(observed.omittedEventCount).toBe(overflow);
    expect(observed.omittedDocumentRequestCount).toBe(1);
  });

  it('bounds the URL and the method, and drops a remote address that is not an IP address', async () => {
    const session = new FakeCdpSession();
    const recorder = await startFake(session);
    const longPath = `/${'a'.repeat(MAX_URL_LENGTH)}`;

    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', longPath, {
      request: { url: fakeUrl(longPath), method: 'X'.repeat(MAX_HTTP_METHOD_LENGTH + 1), headers: {} },
    }));
    session.emit('Network.responseReceived', {
      ...responseReceived('r1', OK_STATUS),
      response: { url: '', status: OK_STATUS, headers: {}, remoteIPAddress: 'not-an-ip', remotePort: FAKE_PORT },
    });

    const [hop] = onlyDocumentRequest(expectObserved(await recorder.finish())).hops;
    expect(hop?.truncated).toBe(true);
    expect(hop?.url).toBe(fakeUrl(longPath).slice(0, MAX_URL_LENGTH));
    expect(hop?.method).toBe('X'.repeat(MAX_HTTP_METHOD_LENGTH));
    expect(hop?.remoteIpAddress).toBeNull();
    expect(hop?.remotePort).toBe(FAKE_PORT);
  });

  it('stops listening and asks to detach on finish, without waiting for the detach, and ignores later events', async () => {
    const neverDetached = createDeferred<void>();
    const session = new FakeCdpSession({ detach: () => neverDetached.promise });
    const recorder = await startFake(session);
    session.emit('Network.requestWillBeSent', requestWillBeSent('r1', '/page'));

    const first = await recorder.finish();
    session.emit('Network.requestWillBeSentExtraInfo', requestExtraInfo('r1'));
    const second = await recorder.finish();

    expect(second).toBe(first);
    expect(session.detachCalls).toBe(1);
    expect(session.eventNames()).toEqual([]);
    expect(onlyDocumentRequest(expectObserved(first)).hops[0]?.requestHeadersSentAtMs).toBeNull();
  });

  it('does not throw when the detach fails', async () => {
    const session = new FakeCdpSession({ detach: () => Promise.reject(new Error('Target page, context or browser has been closed')) });
    const recorder = await startFake(session);

    await expect(recorder.finish()).resolves.toMatchObject({ status: 'OBSERVED', documentRequests: [] });
    expect(session.detachCalls).toBe(1);
  });

  it('records that it could not observe when Network.enable fails, and detaches the session', async () => {
    const session = new FakeCdpSession({ enable: () => Promise.reject(new Error('Network.enable failed')) });
    const recorder = await startFake(session);

    await expect(recorder.finish()).resolves.toEqual({ status: 'NOT_OBSERVED', reason: 'Network.enable failed' });
    expect(session.detachCalls).toBe(1);
    expect(session.eventNames()).toEqual([]);
  });

  it('records that it could not observe when the session does not open before the deadline, and detaches the late session', async () => {
    const late = createDeferred<FakeCdpSession>();
    const recorder = await startNavigationDiagnostics(fakePage(late.promise), { deadlineAtMs: Date.now() + SHORT_START_DEADLINE_MS });

    await expect(recorder.finish()).resolves.toEqual({ status: 'NOT_OBSERVED', reason: NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE });
    const session = new FakeCdpSession();
    late.resolve(session);
    await vi.waitFor(() => expect(session.detachCalls).toBe(1));
    expect(session.eventNames()).toEqual([]);
  });
});
