import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';

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
    await new Promise((resolve) => setTimeout(resolve, 25));
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

  it('rejects unsupported mutation methods without affecting supported-method counters', async () => {
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
      webSocketUpgrade: 0,
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
});
