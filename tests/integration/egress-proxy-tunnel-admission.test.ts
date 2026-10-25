// DEF-125: 出口の中継（`src/safety/egress-proxy.ts`）の CONNECT の受け入れ（`tunnelAdmission`）。中継は、Guard が通した要求の宛先（host とポート。
// `admitTunnelDestinationOf` で知らせる）への CONNECT だけを通し、ほかの CONNECT は `403` で拒んで `onRejected`（`TUNNEL_NOT_ADMITTED`）に知らせる
// （上流に接続しない）。知らせより先に来た CONNECT は、名前つきの時間（`waitMs`）まで知らせを待つ。127.0.0.1 の TCP の上流と、Node の `net` の生の
// CONNECT で確かめる（インターネットには出ない）。
import { createServer as createNetServer, connect as netConnect, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions, type EgressRejection } from '../../src/safety/egress-proxy.js';

/** テストの知らせの待ちの時間（ms）。 */
const TEST_ADMISSION_WAIT_MS = 400;
/** 知らせの待ちの間に、知らせを送るまでの時間（ms。`TEST_ADMISSION_WAIT_MS` より十分に短い）。 */
const LATE_ADMISSION_DELAY_MS = 100;
/** CONNECT の答えを待つ上限（ms）。期限ではなく、確かめのための余裕である。 */
const CONNECT_ANSWER_TIMEOUT_MS = 5_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** 受けた接続を数え、受けたものをそのまま返す 127.0.0.1 の TCP の上流。 */
async function startEchoUpstream(): Promise<{ readonly port: number; connections(): number }> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise()));
  cleanups.push(() => new Promise<void>((resolvePromise) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolvePromise());
  }));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

async function startAdmissionProxy(rejections: EgressRejection[], options: Partial<EgressProxyOptions> = {}): Promise<EgressProxy> {
  const proxy = await startEgressProxy({
    upstreamFailureMode: 'PASS_THROUGH',
    tunnelAdmission: { waitMs: TEST_ADMISSION_WAIT_MS },
    onRejected: (rejection) => rejections.push(rejection),
    onError: () => undefined,
    ...options,
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

/** CONNECT の結果（答えの最初の行と、トンネルの中で `ping` が返ったか）と、答えまでの時間。 */
interface ConnectOutcome {
  readonly statusLine: string;
  readonly echoed: boolean;
  readonly elapsedMs: number;
}

/** 中継に生の CONNECT を送り、答えの最初の行を読む。トンネルが開いたら `ping` を送り、返るかを確かめる。 */
const connectThrough = (proxy: EgressProxy, authority: string): Promise<ConnectOutcome> => new Promise((resolvePromise) => {
  const started = Date.now();
  const socket = netConnect({ host: '127.0.0.1', port: proxy.port });
  let received = '';
  let statusLine = '';
  const finish = (echoed: boolean): void => {
    clearTimeout(timer);
    socket.destroy();
    resolvePromise({ statusLine, echoed, elapsedMs: Date.now() - started });
  };
  const timer = setTimeout(() => finish(false), CONNECT_ANSWER_TIMEOUT_MS);
  socket.on('error', () => finish(false));
  socket.on('close', () => finish(false));
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
    if (statusLine.length === 0 && received.includes('\r\n')) {
      statusLine = received.split('\r\n')[0] ?? '';
      if (statusLine.includes(' 200 ')) {
        received = received.slice(received.indexOf('\r\n\r\n') + 4);
        socket.write('ping');
      }
    }
    if (statusLine.includes(' 200 ') && received.includes('ping')) {
      finish(true);
    }
  });
  socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
});

describe('DEF-125: the egress proxy admits CONNECT only to the destinations the Guard let through', () => {
  it('tunnels CONNECT to an admitted host and port, and rejects one that was not admitted with 403 and TUNNEL_NOT_ADMITTED without connecting upstream', async () => {
    const admitted = await startEchoUpstream();
    const other = await startEchoUpstream();
    const rejections: EgressRejection[] = [];
    const proxy = await startAdmissionProxy(rejections);
    proxy.admitTunnelDestinationOf(`https://127.0.0.1:${admitted.port}/page`);

    const pass = await connectThrough(proxy, `127.0.0.1:${admitted.port}`);
    const reject = await connectThrough(proxy, `127.0.0.1:${other.port}`);

    expect(pass).toMatchObject({ statusLine: 'HTTP/1.1 200 Connection Established', echoed: true });
    expect(reject).toMatchObject({ statusLine: 'HTTP/1.1 403 Forbidden', echoed: false });
    expect(reject.elapsedMs).toBeGreaterThanOrEqual(TEST_ADMISSION_WAIT_MS - 50);
    expect(admitted.connections()).toBe(1);
    expect(other.connections()).toBe(0);
    expect(rejections).toEqual([{ method: 'CONNECT', url: `127.0.0.1:${other.port}`, phase: 'TUNNEL_NOT_ADMITTED' }]);
  });

  it('holds a CONNECT that comes before the admission, and tunnels it as soon as the admission comes within the wait', async () => {
    const upstream = await startEchoUpstream();
    const rejections: EgressRejection[] = [];
    const proxy = await startAdmissionProxy(rejections);

    const pending = connectThrough(proxy, `127.0.0.1:${upstream.port}`);
    await wait(LATE_ADMISSION_DELAY_MS);
    expect(upstream.connections()).toBe(0);
    proxy.admitTunnelDestinationOf(`https://127.0.0.1:${upstream.port}/late`);
    const outcome = await pending;

    expect(outcome).toMatchObject({ statusLine: 'HTTP/1.1 200 Connection Established', echoed: true });
    expect(outcome.elapsedMs).toBeLessThan(TEST_ADMISSION_WAIT_MS);
    expect(upstream.connections()).toBe(1);
    expect(rejections).toEqual([]);
  });

  it('admits the host and the port of the URL: the default port of the scheme, the WebSocket schemes, and the same name in another case; not another port', async () => {
    const upstream = await startEchoUpstream();
    const asked: string[] = [];
    const rejections: EgressRejection[] = [];
    // 上流の方針は、受け入れを通った CONNECT だけに当たる（受け入れの後に確かめる）。127.0.0.1 のほかは拒む（外へは出ない）。
    const proxy = await startAdmissionProxy(rejections, {
      upstreamPolicy: (host, port) => {
        asked.push(`${host}:${port}`);
        return host === '127.0.0.1';
      },
    });
    proxy.admitTunnelDestinationOf('https://Example.TEST/a');
    proxy.admitTunnelDestinationOf('wss://ws.example.test/socket');
    proxy.admitTunnelDestinationOf(`ws://127.0.0.1:${upstream.port}/socket`);

    expect((await connectThrough(proxy, 'example.test:443')).statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect((await connectThrough(proxy, 'ws.example.test:443')).statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(await connectThrough(proxy, `127.0.0.1:${upstream.port}`)).toMatchObject({ echoed: true });
    expect((await connectThrough(proxy, 'example.test:8443')).statusLine).toBe('HTTP/1.1 403 Forbidden');

    // 受け入れを通ったものは上流の方針で拒まれ（OPEN）、通らなかった別のポートは受け入れで拒まれる（TUNNEL_NOT_ADMITTED）。
    // ポート 80 の CONNECT（`host:80`）は、下の DEF-133 の場面で確かめる。
    expect(asked).toEqual(['example.test:443', 'ws.example.test:443', `127.0.0.1:${upstream.port}`]);
    expect(rejections.map(({ url, phase }) => `${url} ${phase}`)).toEqual([
      'example.test:443 OPEN',
      'ws.example.test:443 OPEN',
      'example.test:8443 TUNNEL_NOT_ADMITTED',
    ]);
  });

  it('DEF-133: reads the port 80 of a CONNECT (host:80, the default port of http), and matches it with the admission of http and ws URLs without a port', async () => {
    const asked: string[] = [];
    const rejections: EgressRejection[] = [];
    // 上流の方針は、受け入れを通った CONNECT だけに当たる。どれも拒む（外へは出ない）。
    const proxy = await startAdmissionProxy(rejections, {
      upstreamPolicy: (host, port) => {
        asked.push(`${host}:${port}`);
        return false;
      },
    });
    proxy.admitTunnelDestinationOf('http://plain.example.test/x');
    proxy.admitTunnelDestinationOf('ws://socket.example.test/s');

    expect((await connectThrough(proxy, 'plain.example.test:80')).statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect((await connectThrough(proxy, 'socket.example.test:80')).statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect((await connectThrough(proxy, 'other.example.test:80')).statusLine).toBe('HTTP/1.1 403 Forbidden');
    // ポートのない authority は、今までどおり解析できない（400）。
    expect((await connectThrough(proxy, 'noport.example.test')).statusLine).toBe('HTTP/1.1 400 Bad Request');

    expect(asked).toEqual(['plain.example.test:80', 'socket.example.test:80']);
    expect(rejections.map(({ url, phase }) => `${url} ${phase}`)).toEqual([
      'plain.example.test:80 OPEN',
      'socket.example.test:80 OPEN',
      'other.example.test:80 TUNNEL_NOT_ADMITTED',
    ]);
  });

  it('ignores what is not a URL of http, https, ws or wss', async () => {
    const upstream = await startEchoUpstream();
    const rejections: EgressRejection[] = [];
    const proxy = await startAdmissionProxy(rejections);
    for (const value of ['not a url', `ftp://127.0.0.1:${upstream.port}/`, `data:text/plain,127.0.0.1:${upstream.port}`, '']) {
      proxy.admitTunnelDestinationOf(value);
    }
    expect((await connectThrough(proxy, `127.0.0.1:${upstream.port}`)).statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(upstream.connections()).toBe(0);
  });

  it('rejects a CONNECT that is still waiting when the proxy freezes (FROZEN), without connecting upstream', async () => {
    const upstream = await startEchoUpstream();
    const rejections: EgressRejection[] = [];
    const proxy = await startAdmissionProxy(rejections);
    const pending = connectThrough(proxy, `127.0.0.1:${upstream.port}`);
    await wait(LATE_ADMISSION_DELAY_MS);
    proxy.freeze();
    proxy.admitTunnelDestinationOf(`https://127.0.0.1:${upstream.port}/`);
    const outcome = await pending;
    expect(outcome.echoed).toBe(false);
    expect(outcome.statusLine).not.toContain(' 200 ');
    expect(upstream.connections()).toBe(0);
    expect(rejections.map(({ phase }) => phase)).not.toContain('TUNNEL_NOT_ADMITTED');
  });

  it('without tunnelAdmission, tunnels any CONNECT allowed by the upstream policy (unchanged)', async () => {
    const upstream = await startEchoUpstream();
    const rejections: EgressRejection[] = [];
    const proxy = await startEgressProxy({ upstreamFailureMode: 'PASS_THROUGH', onRejected: (rejection) => rejections.push(rejection), onError: () => undefined });
    cleanups.push(() => proxy.close());
    expect(await connectThrough(proxy, `127.0.0.1:${upstream.port}`)).toMatchObject({ echoed: true });
    expect(rejections).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a negative wait', { waitMs: -1 }],
    ['a fractional wait', { waitMs: 1.5 }],
    ['a wait that is not a number', { waitMs: '100' }],
  ])('rejects %s', async (_label, tunnelAdmission) => {
    await expect(startEgressProxy({
      tunnelAdmission: tunnelAdmission as EgressProxyOptions['tunnelAdmission'],
      onRejected: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow(TypeError);
  });
});
