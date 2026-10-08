/**
 * Interaction の出口の中継（`src/safety/egress-proxy.ts`。DEF-039・DEF-040 の設計書 2.1.1）の確かめ。
 * 本物の `http` のクライアントと `net` のソケットで、127.0.0.1 の上流に向けて、転送、トンネル、方針の拒否、凍結、閉じる処理を確かめる。
 * 上流は、このテストが 127.0.0.1 に立てるサーバだけである（実在の外部のサイトにはアクセスしない）。
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOW_ALL_EGRESS_UPSTREAMS,
  EGRESS_PROXY_STATES,
  startEgressProxy,
  type EgressProxy,
  type EgressRejection,
  type EgressUpstreamPolicy,
} from '../../src/safety/egress-proxy.js';

/** 上流（127.0.0.1 のサーバ）が受けた要求の記録。 */
interface UpstreamObservation {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface Upstream {
  readonly port: number;
  readonly observations: readonly UpstreamObservation[];
  /** CONNECT のトンネルの中を通って届いた、生の要求の行（最初の行）。 */
  readonly tunneledRequestLines: readonly string[];
  close(): Promise<void>;
}

/** 中継の応答（本文は、文字列にして返す）。 */
interface ProxiedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** 127.0.0.1 だけを許す上流の方針（テストの方針）。 */
const LOOPBACK_ONLY: EgressUpstreamPolicy = (host) => host === '127.0.0.1';

/** 「ソケットが閉じた」ことを待つ上限（ms）。期限の値ではなく、確かめのための余裕である。 */
const SOCKET_CLOSE_WAIT_MS = 2_000;

const readBody = (message: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  message.on('data', (chunk: Buffer) => chunks.push(chunk));
  message.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  message.on('error', reject);
});

async function startUpstream(): Promise<Upstream> {
  const observations: UpstreamObservation[] = [];
  const tunneledRequestLines: string[] = [];
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      observations.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'fixture' });
      response.end(`upstream:${request.method}:${request.url}:${body}`);
    });
  });
  // トンネルの中を通る要求も、同じサーバが HTTP として受ける（`observations` に載る）。最初の行は別に残す。
  server.on('connection', (socket: Socket) => {
    socket.once('data', (chunk: Buffer) => {
      tunneledRequestLines.push(chunk.toString('utf8').split('\r\n')[0] ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    observations,
    tunneledRequestLines,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** 中継に、絶対形（`path` にそのまま URL を入れる）の要求を送る。 */
function requestThroughProxy(
  proxy: EgressProxy,
  method: string,
  url: string,
  options: { readonly headers?: Record<string, string>; readonly body?: string; readonly agent?: boolean } = {},
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: proxy.port,
      method,
      path: url,
      headers: { host: new URL(url, 'http://127.0.0.1/').host, ...options.headers },
      agent: options.agent === undefined ? false : undefined,
    }, (response) => {
      void readBody(response).then((body) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }), reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

/** CONNECT の結果。`socket` は、トンネルが開いた場合だけある。 */
interface ConnectOutcome {
  readonly status: number;
  readonly socket: Socket | null;
}

/**
 * 中継に `CONNECT authority` を送る。Node の `http` のクライアントは、CONNECT の応答を状態コードによらず `connect` の事象で返すので、
 * 2xx でなければソケットを閉じて `socket: null` にする。
 */
function connectThroughProxy(proxy: EgressProxy, authority: string): Promise<ConnectOutcome> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, agent: false });
    request.on('connect', (response, socket) => {
      const status = response.statusCode ?? 0;
      if (status === 200) {
        resolve({ status, socket });
        return;
      }
      socket.destroy();
      resolve({ status, socket: null });
    });
    request.on('error', reject);
    request.end();
  });
}

/** トンネルの中で、生の HTTP の要求を書き、応答の文字列（ソケットが閉じるまで）を返す。 */
function requestInsideTunnel(socket: Socket, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.write(requestText);
  });
}

const waitForClose = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
  if (socket.destroyed) {
    resolve();
    return;
  }
  const timer = setTimeout(() => reject(new Error('the socket did not close')), SOCKET_CLOSE_WAIT_MS);
  socket.once('close', () => {
    clearTimeout(timer);
    resolve();
  });
});

/** 中継の待ち受けのポートに TCP で接続できるか。 */
const canConnect = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = netConnect({ host: '127.0.0.1', port }, () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});

let upstream: Upstream;
let rejections: EgressRejection[];
let errors: unknown[];
const proxies: EgressProxy[] = [];

async function startProxy(upstreamPolicy: EgressUpstreamPolicy = LOOPBACK_ONLY): Promise<EgressProxy> {
  const proxy = await startEgressProxy({
    upstreamPolicy,
    onRejected: (rejection) => rejections.push(rejection),
    onError: (error) => errors.push(error),
  });
  proxies.push(proxy);
  return proxy;
}

beforeEach(async () => {
  upstream = await startUpstream();
  rejections = [];
  errors = [];
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await upstream.close();
});

describe('egress proxy (design 2.1.1)', () => {
  it('listens on a free port of 127.0.0.1 and starts OPEN', async () => {
    const proxy = await startProxy();

    expect(proxy.state).toBe('OPEN');
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.server).toBe(`http://127.0.0.1:${proxy.port}`);
    expect(EGRESS_PROXY_STATES).toEqual(['OPEN', 'FROZEN', 'CLOSED']);
    expect(ALLOW_ALL_EGRESS_UPSTREAMS('example.invalid', 443)).toBe(true);
  });

  it('OPEN: forwards absolute-form GET and POST requests to the 127.0.0.1 upstream without hop-by-hop headers', async () => {
    const proxy = await startProxy();
    const base = `http://127.0.0.1:${upstream.port}`;

    const get = await requestThroughProxy(proxy, 'GET', `${base}/read?q=1`, {
      headers: { 'proxy-connection': 'keep-alive', 'x-forwarded-test': 'yes' },
    });
    const post = await requestThroughProxy(proxy, 'POST', `${base}/write`, {
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    });

    expect(get).toMatchObject({ status: 200, body: `upstream:GET:/read?q=1:` });
    expect(get.headers['x-upstream']).toBe('fixture');
    expect(post).toMatchObject({ status: 200, body: `upstream:POST:/write:payload` });
    expect(upstream.observations.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'GET', url: '/read?q=1', body: '' },
      { method: 'POST', url: '/write', body: 'payload' },
    ]);
    expect(upstream.observations[0]?.headers['proxy-connection']).toBeUndefined();
    expect(upstream.observations[0]?.headers['x-forwarded-test']).toBe('yes');
    expect(upstream.observations[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(rejections).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('OPEN: tunnels CONNECT to the 127.0.0.1 upstream and relays both directions', async () => {
    const proxy = await startProxy();

    const { status, socket } = await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`);
    expect(status).toBe(200);
    if (socket === null) {
      throw new Error('the tunnel was not opened');
    }
    const response = await requestInsideTunnel(
      socket,
      `GET /tunneled HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );

    expect(response).toMatch(/^HTTP\/1\.1 200 OK/u);
    expect(response).toContain('upstream:GET:/tunneled:');
    expect(upstream.tunneledRequestLines).toContain('GET /tunneled HTTP/1.1');
    expect(rejections).toEqual([]);
  });

  it('OPEN: rejects an upstream outside the policy with 403 and records the rejection with phase OPEN', async () => {
    const proxy = await startProxy();
    const denied = await requestThroughProxy(proxy, 'GET', 'http://localhost:9/denied');
    const deniedTunnel = await connectThroughProxy(proxy, 'localhost:9');

    expect(denied.status).toBe(403);
    expect(deniedTunnel).toEqual({ status: 403, socket: null });
    expect(rejections).toEqual([
      { method: 'GET', url: 'http://localhost:9/denied', phase: 'OPEN' },
      { method: 'CONNECT', url: 'localhost:9', phase: 'OPEN' },
    ]);
    expect(upstream.observations).toEqual([]);
    expect(proxy.state).toBe('OPEN');
  });

  it('OPEN: passes the host and port of the request to the policy', async () => {
    const seen: [string, number][] = [];
    const proxy = await startProxy((host, port) => {
      seen.push([host, port]);
      return host === '127.0.0.1';
    });

    await requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${upstream.port}/policy`);
    await requestThroughProxy(proxy, 'GET', 'http://127.0.0.1/default-port');
    await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`).then(({ socket }) => socket?.destroy());

    expect(seen).toEqual([
      ['127.0.0.1', upstream.port],
      ['127.0.0.1', 80],
      ['127.0.0.1', upstream.port],
    ]);
  });

  it('rejects relative-form and non-http requests with 400 without recording a rejection', async () => {
    const proxy = await startProxy();

    const relative = await requestThroughProxy(proxy, 'GET', '/relative');
    const https = await requestThroughProxy(proxy, 'GET', `https://127.0.0.1:${upstream.port}/secure`);
    const malformedTunnel = await connectThroughProxy(proxy, 'no-port');

    expect(relative.status).toBe(400);
    expect(https.status).toBe(400);
    expect(malformedTunnel).toEqual({ status: 400, socket: null });
    expect(rejections).toEqual([]);
    expect(upstream.observations).toEqual([]);
  });

  it('freeze(): destroys the open tunnel and keep-alive connections, then rejects everything with 403 and phase FROZEN', async () => {
    const proxy = await startProxy();
    const base = `http://127.0.0.1:${upstream.port}`;
    const { socket: tunnel } = await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`);
    if (tunnel === null) {
      throw new Error('the tunnel was not opened');
    }
    const keepAlive = netConnect({ host: '127.0.0.1', port: proxy.port });
    keepAlive.on('error', () => undefined);
    await new Promise<void>((resolve) => keepAlive.once('connect', resolve));
    tunnel.on('error', () => undefined);

    proxy.freeze();

    expect(proxy.state).toBe('FROZEN');
    await waitForClose(tunnel);
    await waitForClose(keepAlive);
    const get = await requestThroughProxy(proxy, 'POST', `${base}/after-freeze`, { body: 'late' });
    const connect = await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`);

    expect(get.status).toBe(403);
    expect(connect).toEqual({ status: 403, socket: null });
    expect(rejections).toEqual([
      { method: 'POST', url: `${base}/after-freeze`, phase: 'FROZEN' },
      { method: 'CONNECT', url: `127.0.0.1:${upstream.port}`, phase: 'FROZEN' },
    ]);
    expect(upstream.observations).toEqual([]);
    // 凍結は不可逆で、重ねて呼んでも変わらない。
    proxy.freeze();
    expect(proxy.state).toBe('FROZEN');
  });

  it('freeze(): destroys an in-flight forwarded request so that the client sees no response', async () => {
    const proxy = await startProxy();
    let slowRequests = 0;
    const slow = createServer((_request, response) => {
      // 応答の途中で待つ（中継が転送の途中で凍結される場面）。
      slowRequests += 1;
      response.writeHead(200);
      response.write('partial');
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    try {
      const inFlight = requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${slowPort}/slow`).then(
        () => 'completed',
        () => 'failed',
      );
      await expect.poll(() => slowRequests).toBeGreaterThan(0);
      proxy.freeze();

      expect(await inFlight).toBe('failed');
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it('close(): stops listening, becomes CLOSED, destroys the tunnel, and can be called again', async () => {
    const proxy = await startProxy();
    const { socket: tunnel } = await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`);
    if (tunnel === null) {
      throw new Error('the tunnel was not opened');
    }
    tunnel.on('error', () => undefined);
    expect(await canConnect(proxy.port)).toBe(true);

    await proxy.close();

    expect(proxy.state).toBe('CLOSED');
    await waitForClose(tunnel);
    expect(await canConnect(proxy.port)).toBe(false);
    await expect(proxy.close()).resolves.toBeUndefined();
    proxy.freeze();
    expect(proxy.state).toBe('CLOSED');
    expect(errors).toEqual([]);
  });

  it('keeps relaying when the rejection hook throws', async () => {
    const proxy = await startEgressProxy({
      upstreamPolicy: LOOPBACK_ONLY,
      onRejected: () => {
        throw new Error('hook failure');
      },
      onError: (error) => errors.push(error),
    });
    proxies.push(proxy);

    const denied = await requestThroughProxy(proxy, 'GET', 'http://localhost:9/denied');
    const allowed = await requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${upstream.port}/still-open`);

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(errors).toEqual([]);
  });
});
