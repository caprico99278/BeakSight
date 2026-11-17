// DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 の設計者の判断 (b)）: 出口の中継の、凍結の後の読み取りの受け入れ
// （`frozenReadAdmission`）。127.0.0.1 のサーバと、Node の http の要求（absolute-form）で確かめる。
// - 凍結の後でも、受け入れが通す GET・HEAD は転送する（サーバに届く）。
// - 受け入れが通さない GET、読み取りでない要求（受け入れが真でも）、CONNECT は、今のとおり `403` で拒み、`FROZEN` で知らせる（サーバに届かない）。
// - DEF-208-1 の (e): CONNECT の受け入れ（`tunnelAdmission`）がある中継は、凍結の後も、凍結の読み取りとして知らせた宛先（`admitTunnelDestinationOf` の
//   `frozenRead`）への CONNECT だけを通す。凍結の前に知らせた宛先と、知らせのない宛先は、待った後に `403` で拒み、`FROZEN` で知らせる。
// - 受け入れの例外は拒否として扱う（fail-closed）。受け入れがなければ、今のとおり凍結の後はすべて拒む。関数でない受け入れは `TypeError`。
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy, type EgressRejection, type EgressRequestPolicy } from '../../src/safety/egress-proxy.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startServer(): Promise<{ readonly origin: string; readonly received: string[] }> {
  const received: string[] = [];
  const server = await startLoopbackHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-length': '2' });
      response.end(request.method === 'HEAD' ? undefined : 'ok');
    });
  });
  cleanups.push(() => server.close());
  return { origin: server.origin, received };
}

/** CONNECT の受け入れの知らせを待つ時間（ms。テストを短くする）。 */
const TUNNEL_WAIT_MS = 200;

async function startFrozenProxy(
  admission: EgressRequestPolicy | undefined,
  rejections: EgressRejection[],
  beforeFreeze: (proxy: EgressProxy) => void = () => undefined,
): Promise<EgressProxy> {
  const proxy = await startEgressProxy({
    upstreamFailureMode: 'PASS_THROUGH',
    tunnelAdmission: { waitMs: TUNNEL_WAIT_MS },
    ...(admission === undefined ? {} : { frozenReadAdmission: admission }),
    onRejected: (rejection) => rejections.push(rejection),
    onError: () => undefined,
  });
  cleanups.push(() => proxy.close());
  beforeFreeze(proxy);
  proxy.freeze();
  return proxy;
}

/** 中継に absolute-form の要求を 1 回送り、status を返す（再試行しない）。 */
const send = (proxy: EgressProxy, method: string, url: string): Promise<number> => new Promise((resolvePromise, reject) => {
  const request = httpRequest({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: new URL(url).host, connection: 'close' } },
    (response) => {
      response.resume();
      response.on('end', () => resolvePromise(response.statusCode ?? 0));
    });
  request.on('error', reject);
  request.end(method === 'POST' ? 'name=x' : undefined);
});

/** 中継に CONNECT を 1 回送り、応答の最初の行を返す。 */
const sendConnect = (proxy: EgressProxy, authority: string): Promise<string> => new Promise((resolvePromise, reject) => {
  const socket = connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  let text = '';
  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString('latin1');
    if (text.includes('\r\n')) {
      socket.destroy();
      resolvePromise(text.split('\r\n', 1)[0] ?? '');
    }
  });
  socket.on('error', reject);
});

describe('DEF-208-1: the frozen read admission of the egress proxy', () => {
  it('forwards only the admitted reads after the freeze and rejects the rest as FROZEN', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const admitted = new Set([`${server.origin}/api/check`, `${server.origin}/api/items`]);
    const proxy = await startFrozenProxy((_method, url) => admitted.has(url), rejections);
    expect(proxy.state).toBe('FROZEN');
    expect(await send(proxy, 'GET', `${server.origin}/api/check`)).toBe(200);
    expect(await send(proxy, 'HEAD', `${server.origin}/api/check`)).toBe(200);
    expect(await send(proxy, 'GET', `${server.origin}/api/other`)).toBe(403);
    expect(await send(proxy, 'POST', `${server.origin}/api/items`)).toBe(403);
    expect(await send(proxy, 'DELETE', `${server.origin}/api/items`)).toBe(403);
    expect(await sendConnect(proxy, new URL(server.origin).host)).toContain('403');
    expect(server.received).toEqual(['GET /api/check', 'HEAD /api/check']);
    expect(rejections.map(({ method, phase }) => `${method} ${phase}`)).toEqual(['GET FROZEN', 'POST FROZEN', 'DELETE FROZEN', 'CONNECT FROZEN']);
  });

  it('opens a tunnel after the freeze only to a destination admitted as a frozen read (DEF-208-1 (e))', async () => {
    const admittedServer = await startServer();
    const earlierServer = await startServer();
    const unknownServer = await startServer();
    const rejections: EgressRejection[] = [];
    const proxy = await startFrozenProxy(() => false, rejections, (open) => open.admitTunnelDestinationOf(`${earlierServer.origin}/`));
    // 凍結の後に、凍結の読み取りでない知らせ（凍結の後には来ない形）は、凍結の後の受け入れに使わない。
    proxy.admitTunnelDestinationOf(`${unknownServer.origin}/`);
    proxy.admitTunnelDestinationOf(`${admittedServer.origin}/api/check`, true);
    expect(await sendConnect(proxy, new URL(admittedServer.origin).host)).toContain('200');
    expect(await sendConnect(proxy, new URL(earlierServer.origin).host)).toContain('403');
    expect(await sendConnect(proxy, new URL(unknownServer.origin).host)).toContain('403');
    expect(rejections.map(({ method, phase }) => `${method} ${phase}`)).toEqual(['CONNECT FROZEN', 'CONNECT FROZEN']);
  });

  it('opens a waiting tunnel when the frozen read admission arrives within the wait', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const proxy = await startFrozenProxy(() => false, rejections);
    const pending = sendConnect(proxy, new URL(server.origin).host);
    setTimeout(() => proxy.admitTunnelDestinationOf(`${server.origin}/api/check`, true), TUNNEL_WAIT_MS / 4);
    expect(await pending).toContain('200');
    expect(rejections).toEqual([]);
  });

  it('rejects everything after the freeze without the admission, and treats a throwing admission as a rejection', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const without = await startFrozenProxy(undefined, rejections);
    expect(await send(without, 'GET', `${server.origin}/api/check`)).toBe(403);
    const throwing = await startFrozenProxy(() => { throw new Error('broken'); }, rejections);
    expect(await send(throwing, 'GET', `${server.origin}/api/check`)).toBe(403);
    expect(server.received).toEqual([]);
    expect(rejections.map(({ phase }) => phase)).toEqual(['FROZEN', 'FROZEN']);
  });

  it('refuses an admission that is not a function', async () => {
    await expect(startEgressProxy({
      frozenReadAdmission: 'yes' as unknown as EgressRequestPolicy,
      onRejected: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow(TypeError);
  });
});

// DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1 の 2）: 凍結の後の token の更新の受け入れ（`frozenTokenRefreshAdmission`）。
// 凍結の後でも、受け入れが通す絶対形の `POST` だけは転送する。ほかの method（受け入れが真でも）と、受け入れが通さない `POST` は、今のとおり拒む。
describe('DEF-233: the frozen token refresh admission of the egress proxy', () => {
  const startWith = async (admission: EgressRequestPolicy | undefined, rejections: EgressRejection[]): Promise<EgressProxy> => {
    const proxy = await startEgressProxy({
      upstreamFailureMode: 'PASS_THROUGH',
      tunnelAdmission: { waitMs: TUNNEL_WAIT_MS },
      ...(admission === undefined ? {} : { frozenTokenRefreshAdmission: admission }),
      onRejected: (rejection) => rejections.push(rejection),
      onError: () => undefined,
    });
    cleanups.push(() => proxy.close());
    proxy.freeze();
    return proxy;
  };

  it('forwards only the admitted POST after the freeze and rejects the rest as FROZEN', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const proxy = await startWith((method, url) => method === 'POST' || url.endsWith('/token?grant_type=refresh_token'), rejections);
    expect(await send(proxy, 'POST', `${server.origin}/token?grant_type=refresh_token`)).toBe(200);
    expect(await send(proxy, 'PUT', `${server.origin}/token?grant_type=refresh_token`)).toBe(403);
    expect(await send(proxy, 'DELETE', `${server.origin}/token?grant_type=refresh_token`)).toBe(403);
    expect(await send(proxy, 'GET', `${server.origin}/token?grant_type=refresh_token`)).toBe(403);
    expect(server.received).toEqual(['POST /token?grant_type=refresh_token']);
    expect(rejections.map(({ method, phase }) => `${method} ${phase}`)).toEqual(['PUT FROZEN', 'DELETE FROZEN', 'GET FROZEN']);
  });

  it('rejects a POST the admission does not admit, and treats a throwing admission as a rejection', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const refusing = await startWith(() => false, rejections);
    expect(await send(refusing, 'POST', `${server.origin}/token?grant_type=refresh_token`)).toBe(403);
    const throwing = await startWith(() => { throw new Error('broken'); }, rejections);
    expect(await send(throwing, 'POST', `${server.origin}/token?grant_type=refresh_token`)).toBe(403);
    expect(server.received).toEqual([]);
    expect(rejections.map(({ phase }) => phase)).toEqual(['FROZEN', 'FROZEN']);
  });

  it('refuses an admission that is not a function', async () => {
    await expect(startEgressProxy({
      frozenTokenRefreshAdmission: 'yes' as unknown as EgressRequestPolicy,
      onRejected: () => undefined,
      onError: () => undefined,
    })).rejects.toThrow(TypeError);
  });
});
