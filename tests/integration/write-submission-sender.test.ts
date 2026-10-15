// DEF-099 fix（Task 30 の設計書 11 章の DEF-099 の行）: 書き込みの送り手（`src/safety/write-submission-sender.ts` の `sendWriteSubmissionOnce`）。
// 本物の中継（`startEgressProxy`。製品と同じ PASS_THROUGH）と 127.0.0.1 の http と https（テストだけの自前の証明書）のサーバで確かめる。
// - 1 回だけ送る: 応答の前に接続が切れても、サーバに届く要求は 1 件（再試行しない）。結果は `NO_RESPONSE`（書いた後）。
// - 書く前の失敗は `NOT_WRITTEN`: 中継に接続できない、中継が CONNECT を拒む、TLS の確かめの失敗（信頼していない証明書。サーバに要求は届かない）。
// - 時間切れ（名前つきの上限を引数で短くする）: 書いた後は `NO_RESPONSE`（`TIMED_OUT`）。
// - 30x を追わない（303 と 307 をそのまま返す）。応答のヘッダは Set-Cookie を重ねて保つ。
// - ヘッダ: 一時停止の要求のヘッダをそのまま使い、通信の層の値（`Sec-Fetch-*` の閉じた値、`Accept-Language`、`Accept-Encoding`、Host、
//   Content-Length、Connection）を付け直す。
// - 展開: gzip・deflate・br を展開して返し、`Content-Encoding` を残さない。
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../../src/safety/egress-proxy.js';
import {
  WRITE_SUBMISSION_ADDED_HEADER_NAMES,
  sendWriteSubmissionOnce,
  type WriteSubmissionOptions,
  type WriteSubmissionRequest,
} from '../../src/safety/write-submission-sender.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY } from '../helpers/tls-test-certificate.js';

const SHORT_TIMEOUT_MS = 1_000;
const BODY = 'name=%E5%B1%B1%E7%94%B0&csrf_token=CSRF-MARKER-SENDER';

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

type Mode = 'ok' | 'drop' | 'hang' | '303' | '307' | 'gzip' | 'deflate' | 'br' | 'cookies';

interface TestServer {
  readonly origin: string;
  readonly received: Received[];
  mode: Mode;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startServer(tls: boolean): Promise<TestServer> {
  const sockets = new Set<Socket>();
  const state: TestServer = {
    origin: '',
    received: [],
    mode: 'ok',
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      state.received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString('latin1') });
      const html = '<h1>登録しました</h1>';
      switch (state.mode) {
        case 'drop':
          request.socket.destroy();
          return;
        case 'hang':
          return;
        case '303':
          response.writeHead(303, { location: '/members/1001' });
          response.end();
          return;
        case '307':
          response.writeHead(307, { location: '/members?again=1' });
          response.end();
          return;
        case 'gzip':
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
          response.end(gzipSync(Buffer.from(html, 'utf8')));
          return;
        case 'deflate':
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'deflate' });
          response.end(deflateSync(Buffer.from(html, 'utf8')));
          return;
        case 'br':
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' });
          response.end(brotliCompressSync(Buffer.from(html, 'utf8')));
          return;
        case 'cookies':
          response.writeHead(200, [['content-type', 'text/html; charset=utf-8'], ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Path=/']]);
          response.end(html);
          return;
        default:
          response.writeHead(201, { 'content-type': 'text/html; charset=utf-8', 'x-test': 'yes' });
          response.end(html);
      }
    });
  };
  const server: Server = tls ? createHttpsServer({ cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY }, handler) : createHttpServer(handler);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: Socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise()));
  (state as { origin: string }).origin = `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => state.close());
  return state;
}

async function startProxy(): Promise<EgressProxy> {
  const proxy = await startEgressProxy({ upstreamFailureMode: 'PASS_THROUGH', onRejected: () => undefined, onError: () => undefined });
  cleanups.push(() => proxy.close());
  return proxy;
}

const requestOf = (origin: string): WriteSubmissionRequest => ({
  url: `${origin}/members`,
  method: 'POST',
  headers: {
    Accept: 'text/html',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: 'sid=SESSION-MARKER',
    Origin: origin,
    Referer: `${origin}/members/new`,
    'User-Agent': 'BeakSightTest',
    Connection: 'keep-alive',
    'Content-Length': '1',
    'Accept-Encoding': 'zstd',
  },
  body: Buffer.from(BODY, 'latin1'),
});

const optionsOf = (proxy: EgressProxy, extra: Partial<WriteSubmissionOptions> = {}): WriteSubmissionOptions => ({
  proxy: { host: '127.0.0.1', port: proxy.port },
  acceptLanguage: 'ja-JP',
  additionalTrustedCertificates: [LOOPBACK_TEST_CERTIFICATE],
  ...extra,
});

describe.each([['http', false], ['https', true]] as const)('DEF-099: the write submission sender over %s through the egress proxy', (_name, tls) => {
  it('sends once, returns the response without following a redirect, and adds the network layer headers', async () => {
    const server = await startServer(tls);
    const proxy = await startProxy();
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(proxy));
    expect(outcome).toMatchObject({ kind: 'RESPONDED', status: 201 });
    expect(outcome.kind === 'RESPONDED' && outcome.body.toString('utf8')).toBe('<h1>登録しました</h1>');
    expect(outcome.kind === 'RESPONDED' && outcome.headers.find(({ name }) => name.toLowerCase() === 'x-test')?.value).toBe('yes');
    expect(server.received).toHaveLength(1);
    const [received] = server.received;
    expect(received?.body).toBe(BODY);
    expect(received?.method).toBe('POST');
    expect(received?.url).toBe('/members');
    expect(received?.headers).toMatchObject({
      cookie: 'sid=SESSION-MARKER', origin: server.origin, referer: `${server.origin}/members/new`, 'user-agent': 'BeakSightTest',
      'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(BODY, 'latin1')),
      host: new URL(server.origin).host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1',
      'accept-language': 'ja-JP', 'accept-encoding': 'gzip, deflate, br',
    });
    expect(WRITE_SUBMISSION_ADDED_HEADER_NAMES).toEqual(expect.arrayContaining(['Sec-Fetch-Site', 'Accept-Language', 'Accept-Encoding']));
  });

  it.each<[Mode, number]>([['303', 303], ['307', 307]])('does not follow a %s redirect', async (mode, status) => {
    const server = await startServer(tls);
    server.mode = mode;
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()));
    expect(outcome).toMatchObject({ kind: 'RESPONDED', status });
    expect(outcome.kind === 'RESPONDED' && outcome.headers.find(({ name }) => name.toLowerCase() === 'location')?.value).toBeDefined();
    expect(server.received).toHaveLength(1);
  });

  it.each<Mode>(['gzip', 'deflate', 'br'])('decodes a %s body and drops Content-Encoding', async (mode) => {
    const server = await startServer(tls);
    server.mode = mode;
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()));
    expect(outcome.kind === 'RESPONDED' && outcome.body.toString('utf8')).toBe('<h1>登録しました</h1>');
    expect(outcome.kind === 'RESPONDED' && outcome.headers.some(({ name }) => ['content-encoding', 'content-length'].includes(name.toLowerCase())))
      .toBe(false);
  });

  it('keeps every Set-Cookie header', async () => {
    const server = await startServer(tls);
    server.mode = 'cookies';
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()));
    expect(outcome.kind === 'RESPONDED' && outcome.headers.filter(({ name }) => name.toLowerCase() === 'set-cookie').map(({ value }) => value))
      .toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('sends once when the connection closes before a response (NO_RESPONSE, no retry)', async () => {
    const server = await startServer(tls);
    server.mode = 'drop';
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()));
    expect(outcome).toEqual({ kind: 'NO_RESPONSE', reason: 'CONNECTION_CLOSED' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(server.received).toHaveLength(1);
  });

  it('times out after writing (NO_RESPONSE, TIMED_OUT)', async () => {
    const server = await startServer(tls);
    server.mode = 'hang';
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy(), { timeoutMs: SHORT_TIMEOUT_MS }));
    expect(outcome).toEqual({ kind: 'NO_RESPONSE', reason: 'TIMED_OUT' });
    expect(server.received).toHaveLength(1);
  });

  it('does not write when the proxy is not reachable (NOT_WRITTEN)', async () => {
    const server = await startServer(tls);
    const proxy = await startProxy();
    const { port } = proxy;
    await proxy.close();
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), { ...optionsOf(proxy), proxy: { host: '127.0.0.1', port } });
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'PROXY_UNAVAILABLE' });
    expect(server.received).toHaveLength(0);
  });
});

// DEF-099 fix round 1: 止める口（`signal`）。Guard が閉じるとき、送信中の送り手を止める。書く前に止めたら `NOT_WRITTEN`、書いた後に止めたら
// `NO_RESPONSE`（どちらも `ABORTED`）。止めた後に要求は届かない・増えない。
describe.each([['http', false], ['https', true]] as const)('DEF-099 fix round 1: aborting the write submission sender over %s', (_name, tls) => {
  it('does not write when the signal is already aborted', async () => {
    const server = await startServer(tls);
    const controller = new AbortController();
    controller.abort();
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy(), { signal: controller.signal }));
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'ABORTED' });
    expect(server.received).toHaveLength(0);
  });

  it('stops after writing (NO_RESPONSE, ABORTED) without waiting for the time limit', async () => {
    const server = await startServer(tls);
    server.mode = 'hang';
    const controller = new AbortController();
    const started = Date.now();
    const sending = sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy(), { signal: controller.signal }));
    while (server.received.length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    controller.abort();
    expect(await sending).toEqual({ kind: 'NO_RESPONSE', reason: 'ABORTED' });
    expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS * 10);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(server.received).toHaveLength(1);
  });
});

describe('DEF-099: the TLS check of the write submission sender', () => {
  it('does not write to a server whose certificate is not trusted (the product check is on)', async () => {
    const server = await startServer(true);
    const proxy = await startProxy();
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(proxy, { additionalTrustedCertificates: [] }));
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'TLS_FAILED' });
    expect(server.received).toHaveLength(0);
  });

  it('does not write when the proxy rejects the tunnel (NOT_WRITTEN)', async () => {
    const server = await startServer(true);
    const proxy = await startEgressProxy({ upstreamFailureMode: 'PASS_THROUGH', upstreamPolicy: () => false, onRejected: () => undefined,
      onError: () => undefined });
    cleanups.push(() => proxy.close());
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(proxy));
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'PROXY_REJECTED' });
    expect(server.received).toHaveLength(0);
  });

  it('rejects a request that is not an http(s) POST without writing', async () => {
    const proxy = await startProxy();
    expect(await sendWriteSubmissionOnce({ ...requestOf('http://127.0.0.1:9'), url: 'ftp://127.0.0.1/x' }, optionsOf(proxy)))
      .toEqual({ kind: 'NOT_WRITTEN', reason: 'REQUEST_INVALID' });
  });
});

// DEF-100 fix（サイトへの負荷の手順書 `doc/spec/site-load.md`）: 送り手の経過の受け口（`onRequestWriteStart`）。要求の bytes を書き始める直前に
// 1 回だけ呼ぶ（Guard が、読み込みの間隔の起点を記録する）。書かずに終わった場合は呼ばない。受け口の例外は、送る処理と結果を変えない。
describe.each([['http', false], ['https', true]] as const)('DEF-100 fix: the write start of the write submission sender over %s', (_name, tls) => {
  it('calls the write start observer once, before the request reaches the server', async () => {
    const server = await startServer(tls);
    const receivedAtWriteStart: number[] = [];
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()), {
      onRequestWriteStart: () => {
        receivedAtWriteStart.push(server.received.length);
      },
    });
    expect(outcome.kind).toBe('RESPONDED');
    expect(receivedAtWriteStart).toEqual([0]);
    expect(server.received).toHaveLength(1);
  });

  it('does not call the write start observer when it does not write (NOT_WRITTEN)', async () => {
    const server = await startServer(tls);
    const proxy = await startProxy();
    const { port } = proxy;
    await proxy.close();
    let calls = 0;
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), { ...optionsOf(proxy), proxy: { host: '127.0.0.1', port } }, {
      onRequestWriteStart: () => {
        calls += 1;
      },
    });
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'PROXY_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('sends and returns the response although the write start observer throws', async () => {
    const server = await startServer(tls);
    const outcome = await sendWriteSubmissionOnce(requestOf(server.origin), optionsOf(await startProxy()), {
      onRequestWriteStart: () => {
        throw new Error('fixture observer failure');
      },
    });
    expect(outcome.kind).toBe('RESPONDED');
    expect(server.received).toHaveLength(1);
  });
});
