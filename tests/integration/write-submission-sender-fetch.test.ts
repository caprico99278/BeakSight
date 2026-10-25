// T39c（Task 39 の設計書 3.4）: 書き込みの送り手（`sendWriteSubmissionOnce`）の fetch の形（`requestKind: 'FETCH'`）。本物の中継（`startEgressProxy`。
// 製品と同じ PASS_THROUGH）と 127.0.0.1 の http と https（テストだけの自前の証明書）のサーバで確かめる。
// - fetch の形は `POST` と `PATCH`（query を含む URL）を送る。`Sec-Fetch-Mode: cors`・`Sec-Fetch-Dest: empty`、`Sec-Fetch-User` を付けない。一時停止の要求の
//   ヘッダ（`Authorization` を含む）と本文の bytes を、そのまま送る。
// - form の形（省略）は、今どおり `POST` だけ（`PATCH` は送らずに `NOT_WRITTEN`）。fetch の形でも `PUT`・`DELETE` は送らない。
// - 1 回だけ送る: 応答の前に接続が切れても、サーバに届く要求は 1 件（再試行しない）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { startEgressProxy, type EgressProxy } from '../../src/safety/egress-proxy.js';
import { sendWriteSubmissionOnce, type WriteSubmissionOptions, type WriteSubmissionRequest } from '../../src/safety/write-submission-sender.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY } from '../helpers/tls-test-certificate.js';

const BODY = '{"name":"試験","email":"t39c@example.test"}';
const BEARER = 'Bearer t39c-sender-marker';

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

interface TestServer {
  readonly origin: string;
  readonly received: Received[];
  drop: boolean;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startServer(tls: boolean): Promise<TestServer> {
  const state: TestServer = { origin: '', received: [], drop: false };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      state.received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
      if (state.drop) {
        request.socket.destroy();
        return;
      }
      response.writeHead(201, { 'content-type': 'application/json', 'access-control-allow-origin': 'https://app.example.test' });
      response.end('[{"id":"rec-1"}]');
    });
  };
  const server = await startLoopbackHttpServer(handler, { tls: tls ? { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } : undefined });
  server.server.on('secureConnection', (socket: Socket) => socket.on('error', () => undefined));
  (state as { origin: string }).origin = server.origin;
  cleanups.push(() => server.close());
  return state;
}

async function startProxy(): Promise<EgressProxy> {
  const proxy = await startEgressProxy({ upstreamFailureMode: 'PASS_THROUGH', onRejected: () => undefined, onError: () => undefined });
  cleanups.push(() => proxy.close());
  return proxy;
}

const optionsOf = (proxy: EgressProxy): WriteSubmissionOptions => ({
  proxy: { host: '127.0.0.1', port: proxy.port },
  acceptLanguage: 'ja-JP',
  additionalTrustedCertificates: [LOOPBACK_TEST_CERTIFICATE],
});

const fetchRequestOf = (origin: string, method: string, query = ''): WriteSubmissionRequest => ({
  url: `${origin}/rest/v1/members${query}`,
  method,
  requestKind: 'FETCH',
  headers: {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: BEARER,
    apikey: 'k-marker',
    Prefer: 'return=representation',
    Origin: 'https://app.example.test',
    Referer: 'https://app.example.test/members/new',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
  },
  body: Buffer.from(BODY, 'utf8'),
});

describe.each([['http', false], ['https', true]] as const)('T39c: the fetch form of the write submission sender over %s', (_name, tls) => {
  it.each<[string, string]>([['POST', ''], ['PATCH', '?id=eq.1001&select=*']])('sends a %s once with the fetch headers and the same body bytes', async (method, query) => {
    const server = await startServer(tls);
    const outcome = await sendWriteSubmissionOnce(fetchRequestOf(server.origin, method, query), optionsOf(await startProxy()));
    expect(outcome).toMatchObject({ kind: 'RESPONDED', status: 201 });
    expect(outcome.kind === 'RESPONDED' && outcome.headers.find(({ name }) => name.toLowerCase() === 'access-control-allow-origin')?.value)
      .toBe('https://app.example.test');
    expect(server.received).toHaveLength(1);
    const [received] = server.received;
    expect(received?.method).toBe(method);
    expect(received?.url).toBe(`/rest/v1/members${query}`);
    expect(received?.body.equals(Buffer.from(BODY, 'utf8'))).toBe(true);
    expect(received?.headers).toMatchObject({
      authorization: BEARER, apikey: 'k-marker', prefer: 'return=representation', 'content-type': 'application/json',
      'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site',
    });
    expect(received?.headers['sec-fetch-user']).toBeUndefined();
  });

  it('sends once when the connection closes before a response (NO_RESPONSE, no retry)', async () => {
    const server = await startServer(tls);
    server.drop = true;
    const outcome = await sendWriteSubmissionOnce(fetchRequestOf(server.origin, 'POST'), optionsOf(await startProxy()));
    expect(outcome).toEqual({ kind: 'NO_RESPONSE', reason: 'CONNECTION_CLOSED' });
    await wait(500);
    expect(server.received).toHaveLength(1);
  });

  it.each<[string, Partial<WriteSubmissionRequest>]>([
    ['PATCH in the form shape', { method: 'PATCH', requestKind: 'FORM_NAVIGATION' }],
    ['PATCH without the request kind (the form shape)', { method: 'PATCH', requestKind: undefined }],
    ['PUT in the fetch shape', { method: 'PUT' }],
    ['DELETE in the fetch shape', { method: 'DELETE' }],
    ['a lower case patch in the fetch shape', { method: 'patch' }],
  ])('does not send %s (NOT_WRITTEN, nothing arrives)', async (_label, overrides) => {
    const server = await startServer(tls);
    const outcome = await sendWriteSubmissionOnce({ ...fetchRequestOf(server.origin, 'POST'), ...overrides }, optionsOf(await startProxy()));
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'REQUEST_INVALID' });
    expect(server.received).toEqual([]);
  });
});

// AS-c fix round 1（I-1。監査の段の送信の扱いの設計書 5 章の「AS-c fix round 1 の Blocker」の行）: 事前確認の形（`requestKind: 'PREFLIGHT'`）。`OPTIONS` だけを、
// 事前確認のヘッダだけで（資格情報なし）、本文なしで 1 回送る。
describe.each([['http', false], ['https', true]] as const)('AS-c fix round 1: the preflight form of the sender over %s', (_name, tls) => {
  const preflightRequestOf = (origin: string, method = 'OPTIONS'): WriteSubmissionRequest => ({
    url: `${origin}/api/items?x=1`,
    method,
    requestKind: 'PREFLIGHT',
    headers: {
      Accept: '*/*',
      Origin: 'https://app.example.test',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
      Cookie: 'session=cookie-marker',
      Authorization: BEARER,
      'Sec-Fetch-Mode': 'navigate',
    },
    body: Buffer.alloc(0),
  });

  it('sends OPTIONS once with the preflight headers only (no credentials) and no body', async () => {
    const server = await startServer(tls);
    const outcome = await sendWriteSubmissionOnce(preflightRequestOf(server.origin), optionsOf(await startProxy()));
    expect(outcome).toMatchObject({ kind: 'RESPONDED', status: 201 });
    expect(server.received).toHaveLength(1);
    const [received] = server.received;
    expect(received?.method).toBe('OPTIONS');
    expect(received?.url).toBe('/api/items?x=1');
    expect(received?.body.length).toBe(0);
    expect(received?.headers).toMatchObject({
      origin: 'https://app.example.test',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    expect(received?.headers['cookie']).toBeUndefined();
    expect(received?.headers['authorization']).toBeUndefined();
    expect(received?.headers['content-length']).toBeUndefined();
  });

  it('does not send another method in the preflight form (NOT_WRITTEN, nothing arrives)', async () => {
    const server = await startServer(tls);
    const outcome = await sendWriteSubmissionOnce(preflightRequestOf(server.origin, 'POST'), optionsOf(await startProxy()));
    expect(outcome).toEqual({ kind: 'NOT_WRITTEN', reason: 'REQUEST_INVALID' });
    expect(server.received).toEqual([]);
  });
});
