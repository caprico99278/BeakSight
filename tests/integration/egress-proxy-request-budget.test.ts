// DEF-099 fix（Task 30 の設計書 11 章の DEF-099 の行）: 出口の中継（`src/safety/egress-proxy.ts`）の要求の回数の上限（`requestBudget`）。書き込みの段の
// Context の中継は、承認の送信先への POST を 1 回だけ通し、2 回目を止めて記録する（http の重ねの守り）。127.0.0.1 のサーバと、Node の http の
// 要求（absolute-form）で確かめる。
// - 当たる要求（POST と送信先）は上限まで通し、超えたものを `403` で拒み、`onRejected` の `REQUEST_BUDGET` に知らせる（サーバに届かない）。
// - 当たらない要求（GET、別の path）は数えない。`matches` の例外は当たったとして扱う（fail-closed）。
// - 形の違う上限（関数でない、負の数、整数でない）は、中継を作らずに `TypeError`。
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy, type EgressRejection, type EgressRequestBudget } from '../../src/safety/egress-proxy.js';
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
      response.end('ok');
    });
  });
  cleanups.push(() => server.close());
  return { origin: server.origin, received };
}

async function startBudgetProxy(budget: EgressRequestBudget, rejections: EgressRejection[]): Promise<EgressProxy> {
  const proxy = await startEgressProxy({
    upstreamFailureMode: 'PASS_THROUGH',
    requestBudget: budget,
    onRejected: (rejection) => rejections.push(rejection),
    onError: () => undefined,
  });
  cleanups.push(() => proxy.close());
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

const writePostBudget = (origin: string): EgressRequestBudget => ({
  matches: (method, url) => method === 'POST' && url === `${origin}/members`,
  limit: 1,
});

describe('DEF-099: the request budget of the egress proxy', () => {
  it('passes the approved POST once, rejects the second and records it, and does not count other requests', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const proxy = await startBudgetProxy(writePostBudget(server.origin), rejections);
    expect(await send(proxy, 'GET', `${server.origin}/members/new`)).toBe(200);
    expect(await send(proxy, 'POST', `${server.origin}/members`)).toBe(200);
    expect(await send(proxy, 'POST', `${server.origin}/members`)).toBe(403);
    expect(await send(proxy, 'POST', `${server.origin}/other`)).toBe(200);
    expect(await send(proxy, 'GET', `${server.origin}/members/1001`)).toBe(200);
    expect(server.received).toEqual(['GET /members/new', 'POST /members', 'POST /other', 'GET /members/1001']);
    expect(rejections).toEqual([{ method: 'POST', url: `${server.origin}/members`, phase: 'REQUEST_BUDGET' }]);
  });

  it('counts a request whose match throws (fail-closed)', async () => {
    const server = await startServer();
    const rejections: EgressRejection[] = [];
    const proxy = await startBudgetProxy({ matches: () => { throw new Error('broken'); }, limit: 0 }, rejections);
    expect(await send(proxy, 'GET', `${server.origin}/members/new`)).toBe(403);
    expect(server.received).toEqual([]);
    expect(rejections.map(({ phase }) => phase)).toEqual(['REQUEST_BUDGET']);
  });

  it.each<[string, unknown]>([
    ['a match that is not a function', { matches: 'POST', limit: 1 }],
    ['a negative limit', { matches: () => true, limit: -1 }],
    ['a fractional limit', { matches: () => true, limit: 1.5 }],
  ])('rejects %s', async (_label, budget) => {
    await expect(startEgressProxy({ requestBudget: budget as EgressRequestBudget, onRejected: () => undefined, onError: () => undefined }))
      .rejects.toThrow(TypeError);
  });
});
