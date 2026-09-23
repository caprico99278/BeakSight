import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

export interface FixtureServerCounters {
  readonly get: number;
  readonly head: number;
  readonly post: number;
  readonly put: number;
  readonly patch: number;
  readonly delete: number;
  readonly webSocketUpgrade: number;
  readonly download: number;
}

export interface FixtureRequestObservation {
  readonly method: string;
  readonly pathname: string;
  readonly cookie: string | null;
  readonly authorization?: string | null;
  readonly traceparent?: string | null;
  readonly tracestate?: string | null;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly unselectedSecret?: string | null;
}

export interface FixtureServer {
  readonly origin: string;
  resetCounters(): void;
  getCounters(): Readonly<FixtureServerCounters>;
  resetRequestObservations(): void;
  getRequestObservations(): readonly Readonly<FixtureRequestObservation>[];
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  readonly externalRedirectUrl?: string;
  readonly slowResponseDelayMs?: number;
}

type MutableFixtureServerCounters = {
  -readonly [Key in keyof FixtureServerCounters]: number;
};

type FixtureFileResolution =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' };

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'site');
const mutationAllowHeader = 'GET, HEAD, POST, PUT, PATCH, DELETE';

function createCounters(): MutableFixtureServerCounters {
  return {
    get: 0,
    head: 0,
    post: 0,
    put: 0,
    patch: 0,
    delete: 0,
    webSocketUpgrade: 0,
    download: 0,
  };
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const candidateRelativePath = relative(directory, candidate);
  return candidateRelativePath === '' || (
    !candidateRelativePath.startsWith(`..${sep}`)
    && candidateRelativePath !== '..'
    && !isAbsolute(candidateRelativePath)
  );
}

function counterForMethod(method: string | undefined): keyof Pick<
  FixtureServerCounters,
  'get' | 'head' | 'post' | 'put' | 'patch' | 'delete'
> | undefined {
  switch (method) {
    case 'GET': return 'get';
    case 'HEAD': return 'head';
    case 'POST': return 'post';
    case 'PUT': return 'put';
    case 'PATCH': return 'patch';
    case 'DELETE': return 'delete';
    default: return undefined;
  }
}

function observedHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : value.join(', ');
}

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (pathname.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (pathname.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

async function fixtureFilePath(pathname: string, realSiteDirectory: string): Promise<FixtureFileResolution> {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { kind: 'invalid' };
  }

  if (
    !decodedPathname.startsWith('/')
    || decodedPathname.includes('\\')
    || decodedPathname.includes('\0')
    || decodedPathname.split('/').includes('..')
  ) {
    return { kind: 'invalid' };
  }

  const candidate = resolve(realSiteDirectory, decodedPathname.slice(1) || 'index.html');
  if (!isWithinDirectory(realSiteDirectory, candidate)) {
    return { kind: 'invalid' };
  }

  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      return { kind: 'missing' };
    }
    const realCandidate = await realpath(candidate);
    return isWithinDirectory(realSiteDirectory, realCandidate)
      ? { kind: 'file', path: realCandidate }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'missing' };
  }
}

function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.end();
}

function sendText(response: ServerResponse, statusCode: number, body: string, method: string | undefined): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(method === 'HEAD' ? undefined : body);
}

function allowHeaderFor(pathname: string): string {
  return pathname === '/__mutation' ? mutationAllowHeader : 'GET, HEAD';
}

function methodIsAllowed(pathname: string, method: string | undefined): boolean {
  if (pathname === '/__mutation') {
    return counterForMethod(method) !== undefined;
  }
  return method === 'GET' || method === 'HEAD';
}

function sendMethodNotAllowed(response: ServerResponse, pathname: string): void {
  response.statusCode = 405;
  response.setHeader('Allow', allowHeaderFor(pathname));
  response.end();
}

function waitForDelayOrResponseClose(response: ServerResponse, delayMs: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (completedDelay: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.off('close', onClose);
      resolveWait(completedDelay);
    };
    const onClose = (): void => finish(false);
    response.once('close', onClose);
    timer = setTimeout(() => finish(true), delayMs);
  });
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  realSiteDirectory: string,
): Promise<void> {
  const resolution = await fixtureFilePath(pathname, realSiteDirectory);
  if (resolution.kind === 'invalid') {
    sendText(response, 400, 'invalid fixture path\n', request.method);
    return;
  }
  if (resolution.kind === 'missing') {
    sendText(response, 404, 'fixture not found\n', request.method);
    return;
  }

  const body = await readFile(resolution.path);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentTypeFor(resolution.path));
  response.setHeader('Content-Length', body.byteLength);
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  counters: MutableFixtureServerCounters,
  realSiteDirectory: string,
  options: FixtureServerOptions,
  requestObservations: FixtureRequestObservation[],
): Promise<void> {
  const pathname = (request.url ?? '/').split(/[?#]/, 1)[0] ?? '/';
  const baseObservation: FixtureRequestObservation = {
    method: request.method ?? '',
    pathname,
    cookie: request.headers.cookie ?? null,
  };
  requestObservations.push(pathname === '/__technical-redirect'
    ? {
        ...baseObservation,
        authorization: observedHeader(request.headers.authorization),
        traceparent: observedHeader(request.headers.traceparent),
        tracestate: observedHeader(request.headers.tracestate),
        requestId: observedHeader(request.headers['x-request-id']),
        correlationId: observedHeader(request.headers['x-correlation-id']),
        unselectedSecret: observedHeader(request.headers['x-unselected-secret']),
      }
    : baseObservation);
  const methodCounter = counterForMethod(request.method);
  if (methodCounter === undefined) {
    sendMethodNotAllowed(response, pathname);
    return;
  }
  counters[methodCounter] += 1;
  if (!methodIsAllowed(pathname, request.method)) {
    sendMethodNotAllowed(response, pathname);
    return;
  }

  if (pathname === '/__mutation') {
    sendNoContent(response);
    return;
  }

  if (pathname === '/__external-redirect' && options.externalRedirectUrl !== undefined) {
    response.statusCode = 302;
    response.setHeader('Location', options.externalRedirectUrl);
    response.end();
    return;
  }

  if (pathname === '/__technical-redirect') {
    response.statusCode = 302;
    response.setHeader('Location', '/js-error.html');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', 'fixture-session=redirect-secret; HttpOnly');
    response.setHeader('Traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    response.setHeader('Tracestate', 'fixture=redirect');
    response.setHeader('X-Request-Id', 'fixture-response-request-id');
    response.setHeader('X-Correlation-Id', 'fixture-response-correlation-id');
    response.setHeader('X-Unselected-Secret', 'must-not-enter-evidence');
    response.end();
    return;
  }

  if (pathname === '/__broken-image.png') {
    const body = 'not an image\n';
    response.statusCode = 404;
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.setHeader('X-Api-Key', 'fixture-response-secret');
    response.setHeader('X-Request-Id', 'fixture-image-request-id');
    response.setHeader('X-Unselected-Secret', 'must-not-enter-evidence');
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  if (pathname === '/__slow' && options.slowResponseDelayMs !== undefined) {
    if (await waitForDelayOrResponseClose(response, options.slowResponseDelayMs)) {
      sendText(response, 200, 'fixture slow response\n', request.method);
    }
    return;
  }

  if (pathname === '/__download') {
    counters.download += 1;
    const body = 'fixture download\n';
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="fixture-download.txt"');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  if (pathname === '/__counters') {
    const body = `${JSON.stringify(counters)}\n`;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  await serveStatic(request, response, pathname, realSiteDirectory);
}

function handleUpgrade(request: IncomingMessage, socket: Duplex, counters: MutableFixtureServerCounters): void {
  const isWebSocket = request.headers.upgrade?.trim().toLowerCase() === 'websocket';
  if (isWebSocket) {
    counters.webSocketUpgrade += 1;
    socket.end([
      'HTTP/1.1 426 Upgrade Required',
      'Connection: close',
      'Upgrade: websocket',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n'));
    return;
  }
  socket.end([
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fixture server did not bind to a TCP port'));
        return;
      }
      resolvePort(address.port);
    });
  });
}

export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const realSiteDirectory = await realpath(siteDirectory);
  const counters = createCounters();
  const requestObservations: FixtureRequestObservation[] = [];
  const upgradedSockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, counters, realSiteDirectory, options, requestObservations).catch(() => {
      if (!response.headersSent) {
        sendText(response, 500, 'fixture server error\n', request.method);
      } else {
        response.destroy();
      }
    });
  });
  server.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    handleUpgrade(request, socket, counters);
  });

  const port = await listenOnLoopback(server);
  let closePromise: Promise<void> | undefined;

  return {
    origin: `http://127.0.0.1:${port}`,
    resetCounters(): void {
      Object.assign(counters, createCounters());
    },
    getCounters(): Readonly<FixtureServerCounters> {
      return Object.freeze({ ...counters });
    },
    resetRequestObservations(): void {
      requestObservations.splice(0);
    },
    getRequestObservations(): readonly Readonly<FixtureRequestObservation>[] {
      return Object.freeze(requestObservations.map((observation) => Object.freeze({ ...observation })));
    },
    close(): Promise<void> {
      if (closePromise === undefined) {
        closePromise = new Promise((resolveClose, reject) => {
          server.close((error) => {
            if (error === undefined || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
              resolveClose();
              return;
            }
            reject(error);
          });
          for (const socket of upgradedSockets) {
            socket.destroy();
          }
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  };
}
