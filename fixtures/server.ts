import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_SCHEME_KEYS, EXTERNAL_SCHEME_TARGETS } from './external-scheme-targets.js';

export interface FixtureServerCounters {
  readonly get: number;
  readonly head: number;
  readonly post: number;
  readonly put: number;
  readonly patch: number;
  readonly delete: number;
  /** OPTIONS。 */
  readonly options: number;
  /**
   * ほかのすべてのメソッド（PROPFIND などの拡張メソッド、CONNECT、HTTPパーサーが知らない独自メソッド）。
   * GET・HEAD 以外のメソッドは、`post` から `other` までのどれかで必ず数える。
   */
  readonly other: number;
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
  /**
   * 偽なら、サイトの metadata（`/robots.txt` と `/sitemap.xml`）を 404 にする（ない場合を確かめるため）。既定は真で、
   * `fixtures/site/` のファイルを、このサーバの Origin を埋め込んで返す。
   */
  readonly siteMetadata?: boolean;
  /**
   * サイトの metadata（`/robots.txt` と `/sitemap.xml`）の本文を読むディレクトリ（`fixtures/site/` からの相対のパス。例: `full-crawl`。
   * T19a-fix-round-1）。サイトごとに専用の robots.txt と sitemap.xml を返すためにある。
   * - 省略すると、`fixtures/site/` の直下のファイルを返す（指定を加える前と同じ振る舞い）。
   * - 要求のパスは、指定しても Origin の直下（`/robots.txt`、`/sitemap.xml`）のままである。本文の Origin の置き換え
   *   （`{{FIXTURE_ORIGIN}}`）も、省略したときと同じに行う。
   * - `siteMetadata: false` を優先する。両方を指定すると、`/robots.txt` と `/sitemap.xml` は 404 になる。
   * - 指定したディレクトリに、そのファイルがなければ 404 にする。
   * - 絶対パス、`fixtures/site/` の外（リンクをたどった先が外になる場合を含む）、ないディレクトリ、ディレクトリでないものは、
   *   ファイルの解決と同じ確かめ（`isWithinDirectory`）で拒否し、`startFixtureServer` を失敗させる（起動しない）。
   */
  readonly siteMetadataDirectory?: string;
}

type MutableFixtureServerCounters = {
  -readonly [Key in keyof FixtureServerCounters]: number;
};

type FixtureFileResolution =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' };

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'site');
/** サイトの metadata のパス。`siteMetadata: false` で 404 にする。 */
const siteMetadataPathnames: ReadonlySet<string> = new Set(['/robots.txt', '/sitemap.xml']);
/**
 * サイトの metadata の本文で、このサーバの Origin に置き換える文字列。robots.txt と sitemap.xml は絶対URLを書くが、
 * fixture のサーバのポートは起動のたびに変わるためである。
 */
const fixtureOriginPlaceholder = '{{FIXTURE_ORIGIN}}';
const mutationAllowHeader = 'GET, HEAD, POST, PUT, PATCH, DELETE';
/**
 * `/__external-scheme-redirect?to=<名前>` が `302 Location` で返す、外部スキームの宛先の固定の一覧（C18g。RC18a の指摘1）。
 * どれも実在しない宛先である。値は、`fixtures/external-scheme-targets.ts` の `EXTERNAL_SCHEME_TARGETS` を使う（CC-031）。
 * クエリで任意の URL を渡すことはできず、一覧にない名前は 404 にする。
 */
const externalSchemeRedirectTargets: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  EXTERNAL_SCHEME_KEYS.map((key) => [key, EXTERNAL_SCHEME_TARGETS[key].url]),
));

/**
 * `/__slow-redirect` が、リクエストを受けてから `302 Location: /navigation-target.html`（同じ Origin）を返すまでの時間（ms。
 * DEF-013 の確かめ）。Guard のリダイレクトの対応付けの保持の時間（1,000ms）を超える値にする。
 */
const slowRedirectDelayMs = 1_500;
/** `/__slow-redirect` の宛先（同じ Origin の、普通のページ）。 */
const slowRedirectLocation = '/navigation-target.html';

/** `/__external-scheme-redirect` のクエリの `to` が、固定の一覧の名前なら、その宛先を返す。そうでなければ `null`。 */
function externalSchemeRedirectTarget(requestUrl: string | undefined): string | null {
  const query = (requestUrl ?? '').split('#', 1)[0]?.split('?').slice(1).join('?') ?? '';
  const name = new URLSearchParams(query).get('to');
  return name !== null && Object.hasOwn(externalSchemeRedirectTargets, name) ? externalSchemeRedirectTargets[name] ?? null : null;
}

function createCounters(): MutableFixtureServerCounters {
  return {
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

type MethodCounterKey = keyof Pick<
  FixtureServerCounters,
  'get' | 'head' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'other'
>;

/** メソッドを数えるカウンタ。GET・HEAD 以外のすべてのメソッドは、どれかの変更系カウンタに入る。 */
function counterForMethod(method: string | undefined): MethodCounterKey {
  switch (method) {
    case 'GET': return 'get';
    case 'HEAD': return 'head';
    case 'POST': return 'post';
    case 'PUT': return 'put';
    case 'PATCH': return 'patch';
    case 'DELETE': return 'delete';
    case 'OPTIONS': return 'options';
    default: return 'other';
  }
}

const mutationEndpointMethods: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

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
  // .txt・.xml・.css を application/octet-stream で返すと、Chromium のナビゲーションがダウンロードになる（Task 14〜17 の設計書 5.6.8）。
  if (pathname.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  if (pathname.endsWith('.xml')) {
    return 'application/xml';
  }
  if (pathname.endsWith('.css')) {
    return 'text/css; charset=utf-8';
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
    return method !== undefined && mutationEndpointMethods.has(method);
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

/** 要求を受けた、このサーバの Origin（`http://127.0.0.1:<ポート>`）。 */
function requestOrigin(request: IncomingMessage): string {
  return `http://127.0.0.1:${request.socket.localPort ?? 0}`;
}

/**
 * `siteMetadataDirectory` を確かめ、`fixtures/site/` からの相対のパス（区切りは `/`）にする。省略した場合は空文字列
 * （`fixtures/site/` の直下）。確かめに通らなければ、例外を投げる。
 */
async function resolveSiteMetadataDirectory(realSiteDirectory: string, directory: string | undefined): Promise<string> {
  if (directory === undefined) {
    return '';
  }
  const invalid = (reason: string): Error =>
    new Error(`invalid site metadata directory ${JSON.stringify(directory)}: ${reason}`);
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0') || isAbsolute(directory)) {
    throw invalid('it must be a non-empty relative path under fixtures/site/');
  }
  const candidate = resolve(realSiteDirectory, directory);
  if (!isWithinDirectory(realSiteDirectory, candidate)) {
    throw invalid('it is outside fixtures/site/');
  }
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    throw invalid('it does not exist');
  }
  if (!isWithinDirectory(realSiteDirectory, realCandidate)) {
    throw invalid('it is outside fixtures/site/');
  }
  if (!(await stat(realCandidate)).isDirectory()) {
    throw invalid('it is not a directory');
  }
  return relative(realSiteDirectory, realCandidate).split(sep).join('/');
}

/** 要求のパスに対応する、`fixtures/site/` の中のファイルのパス。サイトの metadata は、`siteMetadataDirectory` の中のファイルにする。 */
function staticFilePathname(pathname: string, siteMetadataDirectory: string): string {
  if (siteMetadataDirectory === '' || !siteMetadataPathnames.has(pathname)) {
    return pathname;
  }
  return `/${siteMetadataDirectory.split('/').map(encodeURIComponent).join('/')}${pathname}`;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  realSiteDirectory: string,
  siteMetadataDirectory: string,
): Promise<void> {
  const resolution = await fixtureFilePath(staticFilePathname(pathname, siteMetadataDirectory), realSiteDirectory);
  if (resolution.kind === 'invalid') {
    sendText(response, 400, 'invalid fixture path\n', request.method);
    return;
  }
  if (resolution.kind === 'missing') {
    sendText(response, 404, 'fixture not found\n', request.method);
    return;
  }

  const file = await readFile(resolution.path);
  const body = siteMetadataPathnames.has(pathname)
    ? Buffer.from(file.toString('utf8').replaceAll(fixtureOriginPlaceholder, requestOrigin(request)), 'utf8')
    : file;
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
  siteMetadataDirectory: string,
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
  counters[counterForMethod(request.method)] += 1;
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

  if (pathname === '/__external-scheme-redirect') {
    const location = externalSchemeRedirectTarget(request.url);
    if (location === null) {
      sendText(response, 404, 'unknown external scheme redirect target\n', request.method);
      return;
    }
    response.statusCode = 302;
    response.setHeader('Location', location);
    response.setHeader('Cache-Control', 'no-store');
    response.end();
    return;
  }

  if (pathname === '/__slow-redirect') {
    if (await waitForDelayOrResponseClose(response, slowRedirectDelayMs)) {
      response.statusCode = 302;
      response.setHeader('Location', slowRedirectLocation);
      response.setHeader('Cache-Control', 'no-store');
      response.end();
    }
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

  if (options.siteMetadata === false && siteMetadataPathnames.has(pathname)) {
    sendText(response, 404, 'fixture not found\n', request.method);
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

  await serveStatic(request, response, pathname, realSiteDirectory, siteMetadataDirectory);
}

function handleUpgrade(request: IncomingMessage, socket: Duplex, counters: MutableFixtureServerCounters): void {
  // WebSocket のハンドシェイク（GET）は webSocketUpgrade だけで数える。GET 以外のメソッドの Upgrade は、メソッドでも数える。
  if (request.method !== 'GET') {
    counters[counterForMethod(request.method)] += 1;
  }
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

const methodNotAllowedResponse = [
  'HTTP/1.1 405 Method Not Allowed',
  'Connection: close',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

/** CONNECT はリクエストのハンドラに届かないので、ここで数えて 405 を返す。 */
function handleConnect(request: IncomingMessage, socket: Duplex, counters: MutableFixtureServerCounters): void {
  counters[counterForMethod(request.method)] += 1;
  socket.end(methodNotAllowedResponse);
}

/**
 * HTTPパーサーが知らない独自メソッドは、リクエストのハンドラに届かずに解析エラーになる。
 * それも GET・HEAD 以外のメソッドとして数え、405 を返す。ほかの解析エラーは 400 を返す（Node.js の既定と同じ）。
 */
function handleClientError(error: Error, socket: Duplex, counters: MutableFixtureServerCounters): void {
  const isInvalidMethod = 'code' in error && error.code === 'HPE_INVALID_METHOD';
  if (isInvalidMethod) {
    counters.other += 1;
  }
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(isInvalidMethod ? methodNotAllowedResponse : [
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
  const siteMetadataDirectory = await resolveSiteMetadataDirectory(realSiteDirectory, options.siteMetadataDirectory);
  const counters = createCounters();
  const requestObservations: FixtureRequestObservation[] = [];
  const upgradedSockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, counters, realSiteDirectory, options, requestObservations, siteMetadataDirectory).catch(() => {
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
  server.on('connect', (request, socket) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    handleConnect(request, socket, counters);
  });
  server.on('clientError', (error, socket) => handleClientError(error, socket, counters));

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
