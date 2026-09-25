import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { wait } from '../../src/core/deadline.js';

const servers: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(options?: Parameters<typeof startFixtureServer>[0]): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  servers.push(server);
  return server;
}

function leaveUpgradeClientOpen(origin: string, upgrade: string): { response: Promise<string>; closed: Promise<void> } {
  const endpoint = new URL(origin);
  let received = '';
  let resolveResponse: (response: string) => void;
  let rejectResponse: (reason: unknown) => void;
  let resolveClosed: () => void;
  let rejectClosed: (reason: unknown) => void;
  const response = new Promise<string>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });

  socket.once('connect', () => {
    socket.write([
      'GET /socket HTTP/1.1',
      `Host: ${endpoint.host}`,
      'Connection: Upgrade',
      `Upgrade: ${upgrade}`,
      '',
      '',
    ].join('\r\n'));
  });
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });
  socket.once('close', (hadError) => {
    if (hadError) {
      const error = new Error('upgrade connection closed with an error');
      rejectResponse(error);
      rejectClosed(error);
      return;
    }
    resolveResponse(received);
    resolveClosed();
  });
  socket.once('error', (error) => {
    rejectResponse(error);
    rejectClosed(error);
  });

  return { response, closed };
}

function requestStatus(origin: string, path: string): Promise<number> {
  const endpoint = new URL(origin);
  return new Promise((resolve, reject) => {
    const serverRequest = request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      method: 'GET',
      path,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    serverRequest.once('error', reject);
    serverRequest.end();
  });
}

function sendRawRequest(origin: string, requestLine: string, headers: readonly string[] = []): Promise<string> {
  const endpoint = new URL(origin);
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.once('connect', () => {
      socket.write([requestLine, `Host: ${endpoint.host}`, 'Connection: close', ...headers, '', ''].join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.once('close', () => resolve(received));
    socket.once('error', reject);
  });
}

describe('fixture server', () => {
  it('keeps the configured slow response pending until the client cancels it', async () => {
    const server = await startServer({ slowResponseDelayMs: 30_000 });
    const controller = new AbortController();
    let settled = false;
    const pendingResponse = fetch(`${server.origin}/__slow`, { signal: controller.signal })
      .finally(() => {
        settled = true;
      });

    await expect.poll(() => server.getRequestObservations()).toEqual([{
      method: 'GET',
      pathname: '/__slow',
      cookie: null,
    }]);
    await wait(25);
    expect(settled).toBe(false);

    controller.abort();
    await expect(pendingResponse).rejects.toThrow();
  });

  it('records mutation endpoint hits independently from browser logic', async () => {
    const server = await startServer();

    const response = await fetch(`${server.origin}/__mutation`, { method: 'POST' });

    expect(response.status).toBe(204);
    expect(server.getCounters().post).toBe(1);
  });

  it('returns immutable request observations for browser credential-boundary proof', async () => {
    const server = await startServer();

    await fetch(`${server.origin}/index.html`, {
      headers: { Cookie: 'fixture-session=boundary-secret' },
    });

    const observations = server.getRequestObservations();
    expect(observations).toEqual([{
      method: 'GET',
      pathname: '/index.html',
      cookie: 'fixture-session=boundary-secret',
    }]);
    expect(Object.isFrozen(observations)).toBe(true);
    expect(Object.isFrozen(observations[0])).toBe(true);
    expect(server.getRequestObservations()).not.toBe(observations);

    server.resetRequestObservations();
    expect(server.getRequestObservations()).toEqual([]);
    expect(server.getCounters().get).toBe(1);
  });

  it('keeps every request method counter independent and returns immutable snapshots', async () => {
    const server = await startServer();

    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await fetch(`${server.origin}/__mutation`, { method });
      expect(response.status).toBe(204);
    }
    const upgrade = leaveUpgradeClientOpen(server.origin, 'websocket');
    await expect(upgrade.response).resolves.toContain('HTTP/1.1 426 Upgrade Required');
    await expect(upgrade.closed).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();

    const counters = server.getCounters();
    expect(counters).toEqual({
      get: 1,
      head: 1,
      post: 1,
      put: 1,
      patch: 1,
      delete: 1,
      options: 0,
      other: 0,
      webSocketUpgrade: 1,
      download: 0,
    });
    expect(Object.isFrozen(counters)).toBe(true);
    expect(server.getCounters()).not.toBe(counters);
  });

  it('resets counters explicitly and deterministically', async () => {
    const server = await startServer();
    await fetch(`${server.origin}/__mutation`, { method: 'PATCH' });

    server.resetCounters();

    expect(server.getCounters()).toEqual({
      get: 0,
      head: 0,
      post: 0,
      put: 0,
      patch: 0,
      delete: 0,
      options: 0,
      other: 0,
      webSocketUpgrade: 0,
      download: 0,
    });
  });

  it('serves static pages for GET and HEAD without a HEAD response body', async () => {
    const server = await startServer();

    const getResponse = await fetch(`${server.origin}/index.html`);
    const headResponse = await fetch(`${server.origin}/index.html`, { method: 'HEAD' });

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('content-type')).toContain('text/html');
    expect(await getResponse.text()).toContain('<title>Fixture Home</title>');
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-length')).toBeTruthy();
    expect(await headResponse.text()).toBe('');
    expect(server.getCounters()).toMatchObject({ get: 1, head: 1 });
  });

  it('returns 404 for a valid in-root static path that is missing', async () => {
    const server = await startServer();

    const response = await fetch(`${server.origin}/missing-fixture.html`);

    expect(response.status).toBe(404);
  });

  // C18g（RC18a の指摘1）: 外部スキームへのリダイレクトの経路。宛先は、サーバの中の固定の一覧（実在しないもの）だけで、
  // クエリで任意の URL を渡すことはできない。
  it.each([
    ['tel', 'tel:+10000000000'],
    ['mailto', 'mailto:nobody@example.invalid'],
    ['custom', 'beaksight-test-app:probe'],
  ] as const)('redirects /__external-scheme-redirect?to=%s to the fixed external scheme URL %s', async (key, location) => {
    const server = await startServer();

    const response = await fetch(`${server.origin}/__external-scheme-redirect?to=${key}`, { redirect: 'manual' });
    await response.body?.cancel();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(server.getRequestObservations()).toEqual([{
      method: 'GET',
      pathname: '/__external-scheme-redirect',
      cookie: null,
    }]);
  });

  // DEF-013 の確かめ: 1秒を超えて待ってから、同じ Origin の普通のページへ 302 を返す経路。
  it('redirects /__slow-redirect to /navigation-target.html after more than one second', async () => {
    const server = await startServer();
    const startedAt = Date.now();

    const response = await fetch(`${server.origin}/__slow-redirect`, { redirect: 'manual' });
    await response.body?.cancel();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/navigation-target.html');
  });

  it.each([
    '/__external-scheme-redirect',
    '/__external-scheme-redirect?to=unknown',
    '/__external-scheme-redirect?to=toString',
    `/__external-scheme-redirect?to=${encodeURIComponent('tel:+15550100')}`,
  ])('returns 404 without a Location for %s, whose destination is not in the fixed list', async (path) => {
    const server = await startServer();

    const response = await fetch(`${server.origin}${path}`, { redirect: 'manual' });
    await response.body?.cancel();

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects OPTIONS on the mutation endpoint with 405 and counts it as a non-read method', async () => {
    const server = await startServer();

    const response = await fetch(`${server.origin}/__mutation`, { method: 'OPTIONS' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(server.getCounters()).toEqual({
      get: 0,
      head: 0,
      post: 0,
      put: 0,
      patch: 0,
      delete: 0,
      options: 1,
      other: 0,
      webSocketUpgrade: 0,
      download: 0,
    });
  });

  it('counts every method other than GET and HEAD, including OPTIONS and custom methods', async () => {
    const server = await startServer();

    const staticOptions = await fetch(`${server.origin}/index.html`, { method: 'OPTIONS' });
    const propfind = await fetch(`${server.origin}/index.html`, { method: 'PROPFIND' });
    const query = await fetch(`${server.origin}/__mutation`, { method: 'QUERY' });
    const custom = await sendRawRequest(server.origin, 'BREW /index.html HTTP/1.1');
    const connectTunnel = await sendRawRequest(server.origin, 'CONNECT 127.0.0.1:443 HTTP/1.1');
    const postUpgrade = await sendRawRequest(server.origin, 'POST /socket HTTP/1.1', [
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Content-Length: 0',
    ]);

    expect(staticOptions.status).toBe(405);
    expect(propfind.status).toBe(405);
    expect(query.status).toBe(405);
    expect(custom).toMatch(/^HTTP\/1\.1 405 /u);
    expect(connectTunnel).toMatch(/^HTTP\/1\.1 405 /u);
    expect(postUpgrade).toMatch(/^HTTP\/1\.1 426 /u);
    expect(server.getCounters()).toEqual({
      get: 0,
      head: 0,
      post: 1,
      put: 0,
      patch: 0,
      delete: 0,
      options: 1,
      other: 4,
      webSocketUpgrade: 1,
      download: 0,
    });
  });

  it('records known methods that a static route rejects with 405', async () => {
    const server = await startServer();

    const response = await fetch(`${server.origin}/index.html`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(server.getCounters()).toMatchObject({ get: 0, post: 1 });
  });

  it('does not classify non-WebSocket upgrades as WebSocket hits', async () => {
    const server = await startServer();
    const upgrade = leaveUpgradeClientOpen(server.origin, 'h2c');

    await expect(upgrade.response).resolves.toContain('HTTP/1.1 400 Bad Request');
    await expect(upgrade.closed).resolves.toBeUndefined();
    expect(server.getCounters().webSocketUpgrade).toBe(0);
  });

  it('tracks downloads, rejects encoded traversal, and closes idempotently', async () => {
    const server = await startServer();

    const download = await fetch(`${server.origin}/__download`);
    const traversal = await fetch(`${server.origin}/%2e%2e%2fserver.ts`);

    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(await download.text()).toBe('fixture download\n');
    expect(traversal.status).toBe(400);
    expect(await requestStatus(server.origin, '/%2e%2e/index.html')).toBe(400);
    expect(server.getCounters()).toMatchObject({ get: 3, download: 1 });

    await Promise.all([server.close(), server.close()]);
    await expect(fetch(`${server.origin}/index.html`)).rejects.toThrow();
  });

  // R15a（Task 14〜17 の設計書 5.6.8）: 応答の種類。application/octet-stream で返すと、Chromium のナビゲーションがダウンロードになる。
  it.each([
    ['/robots.txt', 'text/plain; charset=utf-8'],
    ['/sitemap.xml', 'application/xml'],
    ['/resource-item.css', 'text/css; charset=utf-8'],
    ['/crawl/index.html', 'text/html; charset=utf-8'],
  ])('serves %s as %s', async (path, contentType) => {
    const server = await startServer();

    const response = await fetch(`${server.origin}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    await response.arrayBuffer();
  });

  it('serves robots.txt and sitemap.xml with the absolute URLs of this server', async () => {
    const server = await startServer();

    const robots = await (await fetch(`${server.origin}/robots.txt`)).text();
    const sitemapResponse = await fetch(`${server.origin}/sitemap.xml`);
    const sitemap = await sitemapResponse.text();
    const headSitemap = await fetch(`${server.origin}/sitemap.xml`, { method: 'HEAD' });

    expect(robots).toContain('User-agent: *');
    expect(robots).toContain(`Sitemap: ${server.origin}/sitemap.xml`);
    const locations = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/gu)].map((match) => match[1]);
    // クロールで発見されるページと、クロールでは発見されないページ（sitemap-only）を載せる。深さ3のページは載せない。
    expect(locations).toEqual([
      `${server.origin}/crawl/index.html`,
      `${server.origin}/crawl/level-1.html`,
      `${server.origin}/crawl/level-2.html`,
      `${server.origin}/crawl/sitemap-only.html`,
    ]);
    expect(sitemap).not.toContain('{{');
    expect(sitemapResponse.headers.get('content-length')).toBe(String(Buffer.byteLength(sitemap)));
    expect(headSitemap.status).toBe(200);
    expect(headSitemap.headers.get('content-length')).toBe(String(Buffer.byteLength(sitemap)));
    expect(await headSitemap.text()).toBe('');
  });

  it('returns 404 for robots.txt and sitemap.xml when the site metadata is turned off', async () => {
    const server = await startServer({ siteMetadata: false });

    const robots = await fetch(`${server.origin}/robots.txt`);
    const sitemap = await fetch(`${server.origin}/sitemap.xml`);
    const page = await fetch(`${server.origin}/crawl/index.html`);

    expect(robots.status).toBe(404);
    expect(sitemap.status).toBe(404);
    await Promise.all([robots.arrayBuffer(), sitemap.arrayBuffer()]);
    expect(page.status).toBe(200);
    await page.arrayBuffer();
    expect(server.getCounters()).toMatchObject({ get: 3 });
  });

  // T19a-fix-round-1: サイトの metadata を返すディレクトリ（`siteMetadataDirectory`。`fixtures/site/` からの相対のパス）。
  it('serves robots.txt and sitemap.xml from the chosen site metadata directory, with the absolute URLs of this server', async () => {
    const server = await startServer({ siteMetadataDirectory: 'full-crawl' });

    const robotsResponse = await fetch(`${server.origin}/robots.txt`);
    const robots = await robotsResponse.text();
    const sitemapResponse = await fetch(`${server.origin}/sitemap.xml`);
    const sitemap = await sitemapResponse.text();
    const headSitemap = await fetch(`${server.origin}/sitemap.xml`, { method: 'HEAD' });
    const page = await fetch(`${server.origin}/crawl/index.html`);

    expect(robotsResponse.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain(`Sitemap: ${server.origin}/sitemap.xml`);
    expect(robots).not.toContain('{{');
    expect(sitemapResponse.headers.get('content-type')).toBe('application/xml');
    const locations = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/gu)].map((match) => match[1]);
    // 全体の巡回のサイトの、実在する7ページ。404 になる missing.html は載せない。
    expect(locations).toEqual([
      `${server.origin}/full-crawl/index.html`,
      `${server.origin}/full-crawl/links.html`,
      `${server.origin}/full-crawl/technical.html`,
      `${server.origin}/full-crawl/layout.html`,
      `${server.origin}/full-crawl/control.html`,
      `${server.origin}/full-crawl/contrast.html`,
      `${server.origin}/full-crawl/accessibility.html`,
    ]);
    expect(sitemap).not.toContain('{{');
    expect(sitemapResponse.headers.get('content-length')).toBe(String(Buffer.byteLength(sitemap)));
    expect(headSitemap.status).toBe(200);
    expect(headSitemap.headers.get('content-length')).toBe(String(Buffer.byteLength(sitemap)));
    expect(await headSitemap.text()).toBe('');
    // metadata 以外のパスは、指定の影響を受けない。
    expect(page.status).toBe(200);
    await page.arrayBuffer();
  });

  it('keeps the root robots.txt and sitemap.xml when no site metadata directory is chosen', async () => {
    const server = await startServer({});

    const sitemap = await (await fetch(`${server.origin}/sitemap.xml`)).text();

    expect(sitemap).toContain(`<loc>${server.origin}/crawl/index.html</loc>`);
    expect(sitemap).not.toContain('/full-crawl/');
  });

  it('returns 404 for robots.txt and sitemap.xml when the site metadata is turned off, even with a directory chosen', async () => {
    const server = await startServer({ siteMetadata: false, siteMetadataDirectory: 'full-crawl' });

    const robots = await fetch(`${server.origin}/robots.txt`);
    const sitemap = await fetch(`${server.origin}/sitemap.xml`);

    expect(robots.status).toBe(404);
    expect(sitemap.status).toBe(404);
    await Promise.all([robots.arrayBuffer(), sitemap.arrayBuffer()]);
  });

  it.each([
    ['the parent of fixtures/site/', '..'],
    ['a directory outside fixtures/site/', '../../src'],
    ['a path that leaves and re-enters fixtures/site/', '../site/../../fixtures'],
    ['an absolute path', process.cwd()],
    ['a missing directory', 'no-such-metadata-directory'],
    ['a file instead of a directory', 'index.html'],
  ])('refuses to start with %s as the site metadata directory', async (_name, siteMetadataDirectory) => {
    await expect(startServer({ siteMetadataDirectory })).rejects.toThrow(/site metadata directory/u);
  });

  it('serves the crawl fixture: a chain to depth 3, a broken internal link, a duplicate link, an external link, and mailto:', async () => {
    const server = await startServer();
    const hrefsOf = async (path: string): Promise<string[]> => {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status, path).toBe(200);
      return [...(await response.text()).matchAll(/<a [^>]*href="([^"]*)"/gu)].map((match) => match[1] ?? '');
    };

    const start = await hrefsOf('/crawl/index.html');
    expect(start.filter((href) => href === '/crawl/level-1.html')).toHaveLength(2);
    expect(start).toContain('/crawl/missing.html');
    expect(start.some((href) => href.startsWith('https://') && !href.includes('127.0.0.1'))).toBe(true);
    expect(start.some((href) => href.startsWith('mailto:'))).toBe(true);
    expect(await hrefsOf('/crawl/level-1.html')).toContain('/crawl/level-2.html');
    expect(await hrefsOf('/crawl/level-2.html')).toContain('/crawl/level-3.html');
    await hrefsOf('/crawl/level-3.html');
    await hrefsOf('/crawl/sitemap-only.html');
    // どのクロールのページからも、sitemap-only へのリンクはない。
    for (const path of ['/crawl/index.html', '/crawl/level-1.html', '/crawl/level-2.html', '/crawl/level-3.html']) {
      expect(await hrefsOf(path), path).not.toContain('/crawl/sitemap-only.html');
    }
    const missing = await fetch(`${server.origin}/crawl/missing.html`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });
});
