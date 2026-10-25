/**
 * Interaction の出口の中継（`src/safety/egress-proxy.ts`。DEF-039・DEF-040 の設計書 2.1.1）の確かめ。
 * 本物の `http` のクライアントと `net` のソケットで、127.0.0.1 の上流に向けて、転送、トンネル、方針の拒否、凍結、閉じる処理を確かめる。
 * 上流は、このテストが 127.0.0.1 に立てるサーバだけである（実在の外部のサイトにはアクセスしない）。
 */
import dns from 'node:dns';
import { Agent as HttpAgent, Server as HttpServer, request as httpRequest, type IncomingMessage } from 'node:http';
import {
  connect as netConnect,
  createServer as createNetServer,
  isIP,
  Socket as NetSocket,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOW_ALL_EGRESS_UPSTREAMS,
  EGRESS_PROXY_STATES,
  MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES,
  startEgressProxy,
  type EgressProxy,
  type EgressRejection,
  type EgressUpstreamPolicy,
} from '../../src/safety/egress-proxy.js';
import { closedLoopbackOrigin, startLoopbackHttpServer } from '../helpers/loopback-server.js';

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
/** 127.0.0.1 と、`localhost` とその下の名前を許す上流の方針（DEF-085 fix round 2 のテスト。どれもループバック）。 */
const LOOPBACK_NAMES: EgressUpstreamPolicy = (host) => host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost');
/** 上限つきの表のテスト（上限より 1 つ多い CONNECT）の期限（ms）。 */
const BOUNDED_TABLE_TEST_TIMEOUT_MS = 30_000;

/** 「ソケットが閉じた」ことを待つ上限（ms）。期限の値ではなく、確かめのための余裕である。 */
const SOCKET_CLOSE_WAIT_MS = 2_000;
/** 本文の途中で切る上流が、最初の本文を書いてから接続を切るまでの時間（ms）。 */
const SOCKET_CUT_DELAY_MS = 50;
/** 1 つの keep-alive の接続で送る要求の数（DEF-085 fix round 4 の I-1。listener の上限の既定 10 を十分に超える数）。 */
const KEEP_ALIVE_REQUEST_COUNT = 100;
/** 同じ接続の 2 つ目の要求の答え（403 か、接続を閉じる）を待つ時間（ms。fix round 4 の M-1）。期限ではなく、確かめのための余裕である。 */
const SECOND_RESPONSE_WAIT_MS = 2_000;

/** 生の bytes の 1 つの応答を読み終えたか（Content-Length の分か、chunked の終わりまで）。 */
function isCompleteResponse(text: string): boolean {
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    return false;
  }
  const head = text.slice(0, headEnd).toLowerCase();
  const body = text.slice(headEnd + 4);
  const length = /\r\ncontent-length:\s*(\d+)/u.exec(head)?.[1];
  if (length !== undefined) {
    return Buffer.byteLength(body, 'latin1') >= Number(length);
  }
  return /\r\ntransfer-encoding:\s*chunked/u.test(head) ? body.includes('0\r\n\r\n') : false;
}

/**
 * 中継へ生のソケットで `first` を送り、応答を読み終えるのを待ち、`second` があれば同じ接続で送って、`SECOND_RESPONSE_WAIT_MS` の中に
 * 答え（新しい bytes か、接続を閉じる）があるかを返す（fix round 4）。
 */
function rawKeepAliveExchange(
  proxy: EgressProxy,
  first: string,
  second: string | null,
): Promise<{ readonly firstResponse: string; readonly secondAnswered: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port: proxy.port });
    let received = '';
    let firstResponse: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const finish = (secondAnswered: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ firstResponse: firstResponse ?? received, secondAnswered });
    };
    socket.on('error', () => undefined);
    socket.once('connect', () => socket.write(first, 'latin1'));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (firstResponse === null && isCompleteResponse(received)) {
        firstResponse = received;
        received = '';
        if (second === null) {
          finish(false);
          return;
        }
        socket.write(second, 'latin1');
        timer = setTimeout(() => finish(false), SECOND_RESPONSE_WAIT_MS);
      } else if (firstResponse !== null && received.length > 0) {
        finish(true);
      }
    });
    socket.on('close', () => {
      if (firstResponse === null) {
        reject(new Error(`the connection closed before the first response: ${received}`));
      } else {
        finish(true);
      }
    });
  });
}

const readBody = (message: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  message.on('data', (chunk: Buffer) => chunks.push(chunk));
  message.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  message.on('error', reject);
});

async function startUpstream(): Promise<Upstream> {
  const observations: UpstreamObservation[] = [];
  const tunneledRequestLines: string[] = [];
  const upstream = await startLoopbackHttpServer((request, response) => {
    void readBody(request).then((body) => {
      observations.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'fixture' });
      response.end(`upstream:${request.method}:${request.url}:${body}`);
    });
  });
  // トンネルの中を通る要求も、同じサーバが HTTP として受ける（`observations` に載る）。最初の行は別に残す。
  upstream.server.on('connection', (socket: Socket) => {
    socket.once('data', (chunk: Buffer) => {
      tunneledRequestLines.push(chunk.toString('utf8').split('\r\n')[0] ?? '');
    });
  });
  return {
    port: upstream.port,
    observations,
    tunneledRequestLines,
    close: upstream.close,
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
    const slow = await startLoopbackHttpServer((_request, response) => {
      // 応答の途中で待つ（中継が転送の途中で凍結される場面）。
      slowRequests += 1;
      response.writeHead(200);
      response.write('partial');
    });
    try {
      const inFlight = requestThroughProxy(proxy, 'GET', `${slow.origin}/slow`).then(
        () => 'completed',
        () => 'failed',
      );
      await expect.poll(() => slowRequests).toBeGreaterThan(0);
      proxy.freeze();

      expect(await inFlight).toBe('failed');
    } finally {
      await slow.close();
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

  // DEF-085 fix round 1: 上流の失敗の伝え方（`upstreamFailureMode`）。`PASS_THROUGH` は、応答を作らずに失敗をそのまま伝える（中継なしと
  // 同じ結果にするため。Passive とログインの段の Context）。`BAD_GATEWAY`（既定）は、今までどおり 502 を返す（Interaction の Context）。
  describe('upstream failure mode (DEF-085 fix round 1)', () => {
    /** 何も待ち受けていない 127.0.0.1 のポート（`closedLoopbackOrigin` の Origin のポート。CC-041）。 */
    const portOfClosedOrigin = async (): Promise<number> => Number(new URL(await closedLoopbackOrigin()).port);

    async function startModeProxy(upstreamFailureMode?: 'PASS_THROUGH' | 'BAD_GATEWAY'): Promise<EgressProxy> {
      const proxy = await startEgressProxy({
        upstreamPolicy: LOOPBACK_NAMES,
        ...(upstreamFailureMode === undefined ? {} : { upstreamFailureMode }),
        onRejected: (rejection) => rejections.push(rejection),
        onError: (error) => errors.push(error),
      });
      proxies.push(proxy);
      return proxy;
    }

    /** 約束の結果か、拒否の理由（例外）を返す。 */
    const settled = <T>(promise: Promise<T>): Promise<T | unknown> => promise.then((value) => value, (error: unknown) => error);

    it('PASS_THROUGH: resets the client connection (RST), without a 502, when the upstream of an absolute-form request refuses the connection', async () => {
      const proxy = await startModeProxy('PASS_THROUGH');
      const port = await portOfClosedOrigin();

      const failure = await settled(requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${port}/refused`));

      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toBe('ECONNRESET');
      expect((failure as Error).message).toBe('read ECONNRESET');
      expect(rejections).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('PASS_THROUGH: closes the client connection without a response when the upstream closes after connecting', async () => {
      const silent = await startLoopbackHttpServer((request) => {
        request.socket.destroy();
      });
      try {
        const proxy = await startModeProxy('PASS_THROUGH');

        const failure = await settled(requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${silent.port}/silent`));

        expect(failure).toBeInstanceOf(Error);
        // 応答のないまま閉じた接続（RST ではない）。Chromium は `ERR_EMPTY_RESPONSE`（中継なしと同じ）にする。
        expect((failure as Error).message).toBe('socket hang up');
        expect(rejections).toEqual([]);
      } finally {
        await silent.close();
      }
    });

    it('PASS_THROUGH: resets the client connection (RST), without a 502 to CONNECT, when the upstream of a tunnel refuses the connection', async () => {
      const proxy = await startModeProxy('PASS_THROUGH');
      const port = await portOfClosedOrigin();

      const failure = await settled(connectThroughProxy(proxy, `127.0.0.1:${port}`));

      expect(failure).toBeInstanceOf(Error);
      expect((failure as NodeJS.ErrnoException).code).toBe('ECONNRESET');
      expect(rejections).toEqual([]);
      expect(errors).toEqual([]);
    });

    it.each([
      ['a body shorter than Content-Length', { 'content-length': '5000' }],
      ['a chunked body cut in the middle', {}],
    ] as const)('PASS_THROUGH: breaks the client response too when the upstream sends %s', async (_label, headers) => {
      const cutting = await startLoopbackHttpServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html', ...headers });
        response.write('<!doctype html><title>partial</title>');
        setTimeout(() => response.socket?.destroy(), SOCKET_CUT_DELAY_MS);
      });
      try {
        const proxy = await startModeProxy('PASS_THROUGH');
        const outcome = await new Promise<{ readonly status: number; readonly complete: boolean }>((resolve, reject) => {
          const request = httpRequest({
            host: '127.0.0.1',
            port: proxy.port,
            method: 'GET',
            path: `http://127.0.0.1:${cutting.port}/partial`,
            agent: false,
          }, (response) => {
            response.resume();
            response.on('error', () => undefined);
            response.on('close', () => resolve({ status: response.statusCode ?? 0, complete: response.complete }));
          });
          request.on('error', reject);
          request.end();
        });

        expect(outcome).toEqual({ status: 200, complete: false });
      } finally {
        await cutting.close();
      }
    });

    it('BAD_GATEWAY (the default, the Interaction Context): still answers 502 to a request and to CONNECT whose upstream refuses the connection', async () => {
      const proxy = await startModeProxy();
      const port = await portOfClosedOrigin();

      const response = await requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${port}/refused`);
      const tunnel = await connectThroughProxy(proxy, `127.0.0.1:${port}`);

      expect(response.status).toBe(502);
      expect(tunnel).toEqual({ status: 502, socket: null });
      expect(rejections).toEqual([]);
    });

    it('PASS_THROUGH: connects a name under localhost (for example app.localhost) to the loopback, like Chromium without the proxy', async () => {
      const proxy = await startEgressProxy({
        upstreamPolicy: (host) => host === 'app.localhost',
        upstreamFailureMode: 'PASS_THROUGH',
        onRejected: (rejection) => rejections.push(rejection),
        onError: (error) => errors.push(error),
      });
      proxies.push(proxy);

      const response = await requestThroughProxy(proxy, 'GET', `http://app.localhost:${upstream.port}/named`);
      const tunnel = await connectThroughProxy(proxy, `app.localhost:${upstream.port}`);
      tunnel.socket?.destroy();

      expect(response).toMatchObject({ status: 200, body: 'upstream:GET:/named:' });
      // 要求の Host のヘッダは、読み替えない（上流は元の名前を受け取る）。
      expect(upstream.observations[0]?.headers.host).toBe(`app.localhost:${upstream.port}`);
      expect(tunnel.status).toBe(200);
      expect(rejections).toEqual([]);
    });

    it('PASS_THROUGH: does not ask the OS name resolution for localhost or a name under it (RFC 6761), before or after the rewrite', async () => {
      const lookupSpy = vi.spyOn(dns, 'lookup');
      try {
        const proxy = await startModeProxy('PASS_THROUGH');
        const named = await requestThroughProxy(proxy, 'GET', `http://APP.localhost:${upstream.port}/upper`);
        const plain = await requestThroughProxy(proxy, 'GET', `http://localhost:${upstream.port}/plain`);
        const tunnel = await connectThroughProxy(proxy, `app.localhost:${upstream.port}`);
        tunnel.socket?.destroy();

        expect([named.status, plain.status, tunnel.status]).toEqual([200, 200, 200]);
        // テストのクライアントが 127.0.0.1 へ接続するときの問い合わせ（IP アドレスなので OS には出ない）は除き、名前の問い合わせを見る。
        const lookedUpNames = (): string[] => lookupSpy.mock.calls.map((call) => String(call[0])).filter((name) => isIP(name) === 0);
        expect(lookedUpNames()).toEqual([]);

        // 対照: `BAD_GATEWAY`（今の Interaction の中継）は、`localhost` を OS の名前解決に問い合わせる（この見張りが働くことの確かめ）。
        const gateway = await startModeProxy();
        const control = await requestThroughProxy(gateway, 'GET', `http://localhost:${upstream.port}/control`);
        expect(control.status).toBe(200);
        expect(lookedUpNames()).toEqual(['localhost']);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it('PASS_THROUGH: remembers the upstream address of each connected host and port (absolute-form and CONNECT), and BAD_GATEWAY does not', async () => {
      const passing = await startModeProxy('PASS_THROUGH');
      const gateway = await startModeProxy();
      const port = await portOfClosedOrigin();

      await requestThroughProxy(passing, 'GET', `http://127.0.0.1:${upstream.port}/remember`);
      await settled(requestThroughProxy(passing, 'GET', `http://127.0.0.1:${port}/refused`));
      const tunnel = await connectThroughProxy(passing, `localhost:${upstream.port}`);
      tunnel.socket?.destroy();
      await requestThroughProxy(gateway, 'GET', `http://127.0.0.1:${upstream.port}/not-remembered`);

      expect(passing.upstreamAddressOf('127.0.0.1', upstream.port)).toEqual({ address: '127.0.0.1', port: upstream.port });
      expect(passing.upstreamAddressOf('LOCALHOST', upstream.port)).toEqual({ address: '127.0.0.1', port: upstream.port });
      // 接続できなかった上流と、接続していない host と port は、覚えていない。
      expect(passing.upstreamAddressOf('127.0.0.1', port)).toBeNull();
      expect(passing.upstreamAddressOf('127.0.0.1', upstream.port + 1)).toBeNull();
      // 中継自身の待ち受けのアドレスは、上流の相手のアドレスにならない。
      expect(passing.upstreamAddressOf('127.0.0.1', upstream.port)?.port).not.toBe(passing.port);
      expect(gateway.upstreamAddressOf('127.0.0.1', upstream.port)).toBeNull();
    });

    it(`PASS_THROUGH: keeps at most MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES (${MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES}) addresses, dropping the oldest`, async () => {
      const proxy = await startModeProxy('PASS_THROUGH');
      // 同じ上流に、別の名前（`<n>.localhost`）で、上限より 1 つ多く接続する（名前ごとに 1 件を覚える）。
      for (let index = 0; index <= MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES; index += 1) {
        const tunnel = await connectThroughProxy(proxy, `n${index}.localhost:${upstream.port}`);
        tunnel.socket?.destroy();
      }

      expect(proxy.upstreamAddressOf('n0.localhost', upstream.port)).toBeNull();
      expect(proxy.upstreamAddressOf('n1.localhost', upstream.port)).toEqual({ address: '127.0.0.1', port: upstream.port });
      expect(proxy.upstreamAddressOf(`n${MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES}.localhost`, upstream.port))
        .toEqual({ address: '127.0.0.1', port: upstream.port });
    }, BOUNDED_TABLE_TEST_TIMEOUT_MS);

    it('PASS_THROUGH: treats localhost. and a name under it with the trailing dot (app.localhost.) as the loopback, without asking the OS (round 3 M4)', async () => {
      const lookupSpy = vi.spyOn(dns, 'lookup');
      try {
        const proxy = await startEgressProxy({
          upstreamPolicy: (host) => host === 'localhost.' || host === 'app.localhost.',
          upstreamFailureMode: 'PASS_THROUGH',
          onRejected: (rejection) => rejections.push(rejection),
          onError: (error) => errors.push(error),
        });
        proxies.push(proxy);

        const plain = await requestThroughProxy(proxy, 'GET', `http://localhost.:${upstream.port}/dot`);
        const named = await requestThroughProxy(proxy, 'GET', `http://app.localhost.:${upstream.port}/named-dot`);
        const tunnel = await connectThroughProxy(proxy, `app.localhost.:${upstream.port}`);
        tunnel.socket?.destroy();

        expect([plain.status, named.status, tunnel.status]).toEqual([200, 200, 200]);
        expect(lookupSpy.mock.calls.map((call) => String(call[0])).filter((name) => isIP(name) === 0)).toEqual([]);
        expect(rejections).toEqual([]);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it('PASS_THROUGH: relays the request in origin-form with the raw headers, Connection: keep-alive, and the body (Content-Length and chunked) (round 3)', async () => {
      const proxy = await startModeProxy('PASS_THROUGH');
      const base = `http://127.0.0.1:${upstream.port}`;

      const get = await requestThroughProxy(proxy, 'GET', `${base}/raw?q=1`, {
        headers: { 'X-Mixed-Case': 'Kept', 'proxy-connection': 'keep-alive' },
      });
      const post = await requestThroughProxy(proxy, 'POST', `${base}/sized`, { headers: { 'content-type': 'text/plain' }, body: 'payload' });
      const chunked = await requestThroughProxy(proxy, 'POST', `${base}/chunked`, {
        headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
        body: 'chunked-payload',
      });

      expect(get).toMatchObject({ status: 200, body: 'upstream:GET:/raw?q=1:' });
      expect(post).toMatchObject({ status: 200, body: 'upstream:POST:/sized:payload' });
      expect(chunked).toMatchObject({ status: 200, body: 'upstream:POST:/chunked:chunked-payload' });
      // 上流には、生の大文字小文字のまま届き、ホップごとのヘッダは除かれ、中継なしの Chromium と同じ `Connection: keep-alive` が付く。
      expect(upstream.observations[0]?.headers['x-mixed-case']).toBe('Kept');
      expect(upstream.observations[0]?.headers['proxy-connection']).toBeUndefined();
      expect(upstream.observations.map(({ headers }) => headers.connection)).toEqual(['keep-alive', 'keep-alive', 'keep-alive']);
      expect(upstream.observations.map(({ url }) => url)).toEqual(['/raw?q=1', '/sized', '/chunked']);
      expect(rejections).toEqual([]);
    });

    it('PASS_THROUGH: serves the next request on the same client connection (keep-alive) from a new upstream, even to another upstream (round 3)', async () => {
      const second = await startUpstream();
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      try {
        const proxy = await startModeProxy('PASS_THROUGH');
        const viaAgent = (url: string): Promise<{ readonly body: string; readonly reused: boolean }> => new Promise((resolve, reject) => {
          const request = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, agent, headers: { host: new URL(url).host } }, (response) => {
            void readBody(response).then((body) => resolve({ body, reused: request.reusedSocket }), reject);
          });
          request.on('error', reject);
          request.end();
        });

        const first = await viaAgent(`http://127.0.0.1:${upstream.port}/first`);
        const next = await viaAgent(`http://127.0.0.1:${second.port}/second`);
        const third = await viaAgent(`http://127.0.0.1:${upstream.port}/third`);

        expect([first.body, next.body, third.body]).toEqual(['upstream:GET:/first:', 'upstream:GET:/second:', 'upstream:GET:/third:']);
        expect([first.reused, next.reused, third.reused]).toEqual([false, true, true]);
      } finally {
        agent.destroy();
        await second.close();
      }
    });

    it('PASS_THROUGH: does not pile up listeners on a keep-alive client connection over many requests, and emits no warning (round 4 I-1)', async () => {
      const warnings: string[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(`${warning.name}: ${warning.message}`);
      };
      process.on('warning', onWarning);
      // 中継の待ち受けが受けたクライアントの接続（サーバの 'connection' の事象）を拾う。
      const acceptedSockets: Socket[] = [];
      const emit = HttpServer.prototype.emit as (this: HttpServer, event: string | symbol, ...args: unknown[]) => boolean;
      const recordingEmit = function (this: HttpServer, event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'connection' && args[0] instanceof NetSocket) {
          acceptedSockets.push(args[0]);
        }
        return emit.call(this, event, ...args);
      };
      const emitSpy = vi.spyOn(HttpServer.prototype, 'emit').mockImplementation(recordingEmit as HttpServer['emit']);
      const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
      try {
        const proxy = await startModeProxy('PASS_THROUGH');
        const viaAgent = (path: string): Promise<string> => new Promise((resolve, reject) => {
          const request = httpRequest({
            host: '127.0.0.1',
            port: proxy.port,
            method: 'GET',
            path: `http://127.0.0.1:${upstream.port}${path}`,
            agent,
            headers: { host: `127.0.0.1:${upstream.port}` },
          }, (response) => {
            void readBody(response).then(resolve, reject);
          });
          request.on('error', reject);
          request.end();
        });
        const listenerCounts: number[] = [];
        for (let index = 0; index < KEEP_ALIVE_REQUEST_COUNT; index += 1) {
          await viaAgent(`/keep-alive-${index}`);
          const client = acceptedSockets.find((socket) => socket.localPort === proxy.port);
          listenerCounts.push((client?.listenerCount('close') ?? 0) + (client?.listenerCount('error') ?? 0));
        }
        await new Promise((resolve) => setImmediate(resolve));

        const proxyClients = acceptedSockets.filter((socket) => socket.localPort === proxy.port);
        expect(proxyClients).toHaveLength(1);
        // 2 件目からの listener の数は、要求の数で増えない（1 件目と最後が同じ）。
        expect(listenerCounts.at(-1)).toBe(listenerCounts[1]);
        expect(warnings.filter((warning) => warning.startsWith('MaxListenersExceededWarning'))).toEqual([]);
      } finally {
        agent.destroy();
        emitSpy.mockRestore();
        process.off('warning', onWarning);
      }
    });

    it('PASS_THROUGH: answers 403 (or closes) without waiting, when it rejects a later request on the same connection (round 4 M-1)', async () => {
      const proxy = await startEgressProxy({
        upstreamPolicy: LOOPBACK_NAMES,
        requestPolicy: (method, url) => method === 'GET' && !new URL(url).pathname.startsWith('/excluded'),
        upstreamFailureMode: 'PASS_THROUGH',
        onRejected: (rejection) => rejections.push(rejection),
        onError: (error) => errors.push(error),
      });
      proxies.push(proxy);
      const base = `http://127.0.0.1:${upstream.port}`;
      const secondRequests = [
        `POST ${base}/write HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nContent-Length: 0\r\n\r\n`,
        `GET ${base}/excluded/logout HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`,
      ];
      for (const second of secondRequests) {
        const outcome = await rawKeepAliveExchange(proxy, `GET ${base}/first HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`, second);
        expect(outcome.firstResponse).toContain('upstream:GET:/first:');
        expect(outcome.secondAnswered, second.split('\r\n')[0]).toBe(true);
      }
      expect(rejections.map(({ method, phase }) => `${method} ${phase}`)).toEqual(['POST REQUEST_POLICY', 'GET REQUEST_POLICY']);
      expect(upstream.observations.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /first', 'GET /first']);
    });

    it('PASS_THROUGH: does not send both Content-Length and chunked upstream when it re-chunks the body (round 4 M-3)', async () => {
      const heads: string[] = [];
      const raw = createNetServer((socket) => {
        let received = '';
        socket.on('error', () => undefined);
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('latin1');
          if (received.includes('0\r\n\r\n')) {
            heads.push(received.slice(0, received.indexOf('\r\n\r\n')));
            socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
          }
        });
      });
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      try {
        const port = (raw.address() as AddressInfo).port;
        const proxy = await startModeProxy('PASS_THROUGH');
        const outcome = await rawKeepAliveExchange(
          proxy,
          `POST http://127.0.0.1:${port}/both HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`,
          null,
        );

        expect(outcome.firstResponse).toContain('200 OK');
        expect(heads).toHaveLength(1);
        const headerNames = (heads[0] ?? '').split('\r\n').slice(1).map((line) => line.split(':')[0]?.trim().toLowerCase());
        expect(headerNames).toContain('transfer-encoding');
        expect(headerNames).not.toContain('content-length');
      } finally {
        await new Promise<void>((resolve) => raw.close(() => resolve()));
      }
    });

    it('rejects an unknown upstream failure mode', async () => {
      await expect(startEgressProxy({
        upstreamFailureMode: 'IGNORE' as unknown as 'PASS_THROUGH',
        onRejected: () => undefined,
        onError: () => undefined,
      })).rejects.toThrow(TypeError);
    });
  });

  // DEF-085: Passive とログインの段の Context の中継に渡す、要求の方針（method と URL）。
  describe('request policy (DEF-085)', () => {
    async function startPolicyProxy(requestPolicy: (method: string, url: string) => boolean): Promise<EgressProxy> {
      const proxy = await startEgressProxy({
        upstreamPolicy: LOOPBACK_ONLY,
        requestPolicy,
        onRejected: (rejection) => rejections.push(rejection),
        onError: (error) => errors.push(error),
      });
      proxies.push(proxy);
      return proxy;
    }

    it('OPEN: rejects an absolute-form request outside the request policy with 403 and phase REQUEST_POLICY, before the upstream policy', async () => {
      const seen: [string, string][] = [];
      const proxy = await startPolicyProxy((method, url) => {
        seen.push([method, url]);
        return method === 'GET';
      });
      const base = `http://127.0.0.1:${upstream.port}`;

      const allowed = await requestThroughProxy(proxy, 'GET', `${base}/read`);
      const denied = await requestThroughProxy(proxy, 'POST', `${base}/write`, { body: 'payload' });
      // 上流の方針にも合わない要求は、要求の方針の拒否として記録する（要求の方針を先に確かめる）。
      const deniedOutside = await requestThroughProxy(proxy, 'DELETE', 'http://localhost:9/outside');

      expect(allowed.status).toBe(200);
      expect(denied.status).toBe(403);
      expect(deniedOutside.status).toBe(403);
      expect(seen).toEqual([['GET', `${base}/read`], ['POST', `${base}/write`], ['DELETE', 'http://localhost:9/outside']]);
      expect(rejections).toEqual([
        { method: 'POST', url: `${base}/write`, phase: 'REQUEST_POLICY' },
        { method: 'DELETE', url: 'http://localhost:9/outside', phase: 'REQUEST_POLICY' },
      ]);
      expect(upstream.observations.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /read']);
      expect(proxy.state).toBe('OPEN');
    });

    it('treats an exception of the request policy as a rejection (fail-closed)', async () => {
      const proxy = await startPolicyProxy(() => {
        throw new Error('policy failure');
      });

      const denied = await requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${upstream.port}/policy-throws`);

      expect(denied.status).toBe(403);
      expect(rejections).toEqual([{ method: 'GET', url: `http://127.0.0.1:${upstream.port}/policy-throws`, phase: 'REQUEST_POLICY' }]);
      expect(upstream.observations).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('does not apply the request policy to CONNECT (the tunnel is opaque), and FROZEN still rejects everything', async () => {
      const proxy = await startPolicyProxy(() => false);

      const tunnel = await connectThroughProxy(proxy, `127.0.0.1:${upstream.port}`);
      expect(tunnel.status).toBe(200);
      tunnel.socket?.destroy();
      proxy.freeze();
      const frozen = await requestThroughProxy(proxy, 'GET', `http://127.0.0.1:${upstream.port}/after-freeze`);

      expect(frozen.status).toBe(403);
      expect(rejections).toEqual([{ method: 'GET', url: `http://127.0.0.1:${upstream.port}/after-freeze`, phase: 'FROZEN' }]);
    });

    it('rejects a request policy that is not a function', async () => {
      await expect(startEgressProxy({
        requestPolicy: 'GET' as unknown as (method: string, url: string) => boolean,
        onRejected: () => undefined,
        onError: () => undefined,
      })).rejects.toThrow(TypeError);
    });
  });
});
