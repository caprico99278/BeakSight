/**
 * Interaction の Context の出口の中継（HTTP の前方 proxy。DEF-039・DEF-040 の設計書 2.1.1。owner）。
 *
 * - Node.js 標準の `http` と `net` だけで作り、127.0.0.1 の空いたポートで待つ。Interaction の Context は、Playwright の Context ごとの
 *   proxy（`proxy: { server }`）で、すべての通信をここに通す（127.0.0.1 への通信も含む）。
 * - 受けるもの: 絶対形の HTTP の要求（`http://...`。上流へそのまま転送する）と、`CONNECT host:port`（上流へ TCP で接続し、
 *   `200 Connection Established` の後は両方向にそのまま流す。https と wss はこれを通る。中身は見ない）。それ以外（相対形の要求、
 *   `http:` 以外の絶対形、`Upgrade` を伴う要求）は `400` で拒む。
 * - 状態は `OPEN` → `FROZEN` → `CLOSED` の一方向。
 *   - `OPEN`: 転送する。上流の方針（`upstreamPolicy(host, port)`）に合わないものは `403` で拒み、`onRejected`（`phase: 'OPEN'`）に知らせる。
 *   - `freeze()`: `FROZEN` にし、今つながっているすべてのソケット（クライアント側と上流側。CONNECT のトンネルと keep-alive を含む）を
 *     破棄する。以後は、すべての要求と CONNECT を `403` で拒み、`onRejected`（`phase: 'FROZEN'`）に知らせる。
 *   - `close()`: `CLOSED` にし、すべてのソケットを破棄して、待ち受けを閉じる。重ねて呼んでもよい。
 * - 記録の口 `onRejected({ method, url, phase })`: `url` は、絶対形の要求ならその URL、CONNECT なら `host:port`（authority の形。
 *   https か wss かは分からない）。中継は Safety Ledger を知らない（Ledger に写すのは factory。設計書 2.1.2）。
 * - 失敗の口 `onError`: 待ち受けの後の `error` だけを知らせる。ソケットごとの失敗は、そのソケットを破棄するだけで、知らせない。
 *   口（`onRejected`、`onError`）の例外は封じ込める。
 * - 上流の方針の既定（`ALLOW_ALL_EGRESS_UPSTREAMS`）は、すべての host を許す（production。ページが読み込むほかの Origin のリソースは、
 *   中継を通しても露出が増えない）。テストは、127.0.0.1 だけを許す方針を注入する。
 * - TLS は解かない（中身の検査は Guard の仕事）。HTTP/2 と HTTP/3 は使われない（Chromium は HTTP の中継には HTTP/1.1 で話す。推測）。
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** 中継の状態の閉じた一覧（一方向に進む）。 */
export const EGRESS_PROXY_STATES = Object.freeze(['OPEN', 'FROZEN', 'CLOSED'] as const);
export type EgressProxyState = (typeof EGRESS_PROXY_STATES)[number];

/** 中継が要求を拒んだ段階の閉じた一覧（`OPEN` は上流の方針の拒否、`FROZEN` は凍結の後の拒否）。 */
export const EGRESS_REJECTION_PHASES = Object.freeze(['OPEN', 'FROZEN'] as const);
export type EgressRejectionPhase = (typeof EGRESS_REJECTION_PHASES)[number];

/** 中継が拒んだ 1 件の要求。`url` は、絶対形の要求ならその URL、CONNECT なら `host:port`。 */
export interface EgressRejection {
  readonly method: string;
  readonly url: string;
  readonly phase: EgressRejectionPhase;
}

/** 上流の方針。`host` は URL の hostname の形（IPv6 は `[...]`）、`port` は実際に接続する番号（`http:` の既定は 80）。 */
export type EgressUpstreamPolicy = (host: string, port: number) => boolean;

/** production の上流の方針: すべての host を許す。 */
export const ALLOW_ALL_EGRESS_UPSTREAMS: EgressUpstreamPolicy = () => true;

export interface EgressProxyOptions {
  /** 上流の方針。省略すると `ALLOW_ALL_EGRESS_UPSTREAMS`。 */
  readonly upstreamPolicy?: EgressUpstreamPolicy | undefined;
  /** 拒んだ要求の記録の口。 */
  readonly onRejected: (rejection: EgressRejection) => void;
  /** 待ち受けの後の中継の失敗の口。 */
  readonly onError: (error: unknown) => void;
}

export interface EgressProxy {
  /** Playwright の `proxy.server` に渡す値（`http://127.0.0.1:<port>`）。 */
  readonly server: string;
  readonly port: number;
  readonly state: EgressProxyState;
  freeze(): void;
  close(): Promise<void>;
}

/** 待ち受ける loopback のアドレス。Interaction の Context と同じ機械の中だけで使う。 */
const LOOPBACK_HOST = '127.0.0.1';
/** `http:` の既定のポート。 */
const DEFAULT_HTTP_PORT = 80;
/** 転送しないホップごとのヘッダ（RFC 9110 7.6.1 と、proxy の慣習の `Proxy-*`）。小文字で比べる。 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CONNECTION_ESTABLISHED_RESPONSE = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const FORBIDDEN_RESPONSE = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const BAD_REQUEST_RESPONSE = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_BAD_GATEWAY = 502;

/** 絶対形の要求の宛先（上流）。 */
interface ForwardTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

/** 絶対形の `http:` の要求の URL から、上流の宛先を取り出す。相対形や `http:` 以外は `null`。 */
function forwardTargetOf(requestUrl: string | undefined): ForwardTarget | null {
  if (requestUrl === undefined || !URL.canParse(requestUrl)) {
    return null;
  }
  const url = new URL(requestUrl);
  if (url.protocol !== 'http:' || url.hostname.length === 0) {
    return null;
  }
  return {
    host: url.hostname,
    port: url.port.length === 0 ? DEFAULT_HTTP_PORT : Number(url.port),
    path: `${url.pathname}${url.search}`,
  };
}

/** `CONNECT` の authority（`host:port`）から、上流の宛先を取り出す。ポートのないものや解析できないものは `null`。 */
function tunnelTargetOf(authority: string | undefined): Omit<ForwardTarget, 'path'> | null {
  if (authority === undefined || authority.includes('/') || !URL.canParse(`http://${authority}`)) {
    return null;
  }
  const url = new URL(`http://${authority}`);
  if (url.hostname.length === 0 || url.port.length === 0) {
    return null;
  }
  return { host: url.hostname, port: Number(url.port) };
}

/** ホップごとのヘッダを除いたヘッダ。 */
function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

/** `net` の接続先の host。URL の hostname の IPv6 の `[...]` を外す。 */
function connectHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** `socket` を、失敗を外に出さずに破棄する。 */
function destroyQuietly(socket: Duplex): void {
  socket.on('error', () => undefined);
  socket.destroy();
}

/** `message` を書いてから閉じる（書けなければ破棄する）。 */
function endWith(socket: Duplex, message: string): void {
  socket.on('error', () => undefined);
  if (socket.writable) {
    socket.end(message);
  } else {
    socket.destroy();
  }
}

class EgressProxyImpl implements EgressProxy {
  readonly #server: Server;
  readonly #upstreamPolicy: EgressUpstreamPolicy;
  readonly #onRejected: (rejection: EgressRejection) => void;
  readonly #onError: (error: unknown) => void;
  /** 今つながっているソケット（クライアント側と上流側）。凍結と閉じる処理で、すべて破棄する。 */
  readonly #sockets = new Set<Duplex>();
  #state: EgressProxyState = 'OPEN';
  #port = 0;
  #closing: Promise<void> | null = null;

  constructor(options: EgressProxyOptions) {
    this.#upstreamPolicy = options.upstreamPolicy ?? ALLOW_ALL_EGRESS_UPSTREAMS;
    this.#onRejected = options.onRejected;
    this.#onError = options.onError;
    this.#server = createServer((request, response) => this.#handleRequest(request, response));
    this.#server.on('connect', (request, socket, head: Buffer) => this.#handleConnect(request, socket, head));
    this.#server.on('upgrade', (request, socket) => this.#handleUpgrade(request, socket));
    this.#server.on('connection', (socket: Socket) => this.#track(socket));
    this.#server.on('clientError', (_error: Error, socket: Duplex) => endWith(socket, BAD_REQUEST_RESPONSE));
  }

  get server(): string {
    return `http://${LOOPBACK_HOST}:${this.#port}`;
  }

  get port(): number {
    return this.#port;
  }

  get state(): EgressProxyState {
    return this.#state;
  }

  /** 待ち受けを始める。失敗したら reject する（待ち受けの後の `error` は `onError` に知らせる）。 */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onListenError = (error: Error): void => reject(error);
      this.#server.once('error', onListenError);
      this.#server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
        this.#server.off('error', onListenError);
        const address = this.#server.address();
        if (address === null || typeof address === 'string') {
          this.#server.close();
          reject(new Error('Egress proxy did not bind to a TCP port'));
          return;
        }
        this.#port = (address as AddressInfo).port;
        this.#server.on('error', (error: Error) => this.#reportError(error));
        resolve();
      });
    });
  }

  freeze(): void {
    if (this.#state !== 'OPEN') {
      return;
    }
    this.#state = 'FROZEN';
    this.#destroyAllSockets();
  }

  close(): Promise<void> {
    if (this.#closing === null) {
      this.#state = 'CLOSED';
      this.#destroyAllSockets();
      this.#closing = new Promise<void>((resolve) => {
        this.#server.close(() => resolve());
        this.#destroyAllSockets();
      });
    }
    return this.#closing;
  }

  #track(socket: Duplex): void {
    this.#sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => this.#sockets.delete(socket));
    // 凍結や閉じる処理の後に受け入れたソケットは、すぐに破棄する（待ち受けが閉じるまでの隙間）。
    if (this.#state === 'CLOSED') {
      socket.destroy();
    }
  }

  #destroyAllSockets(): void {
    for (const socket of [...this.#sockets]) {
      socket.destroy();
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // 失敗の口の例外は、中継を止めない。
    }
  }

  #reject(method: string, url: string, phase: EgressRejectionPhase): void {
    try {
      this.#onRejected({ method, url, phase });
    } catch {
      // 記録の口の例外は、中継を止めない。
    }
  }

  /** `OPEN` でなければ拒む（`403`。記録する）。`OPEN` なら `false` を返す。 */
  #rejectUnlessOpen(method: string, url: string, respond: () => void): boolean {
    if (this.#state === 'OPEN') {
      return false;
    }
    this.#reject(method, url, 'FROZEN');
    respond();
    return true;
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? '';
    const requestUrl = request.url ?? '';
    const respondEmpty = (status: number): void => {
      response.writeHead(status, { connection: 'close', 'content-length': '0' });
      response.end();
    };
    if (this.#rejectUnlessOpen(method, requestUrl, () => respondEmpty(HTTP_STATUS_FORBIDDEN))) {
      return;
    }
    const target = forwardTargetOf(requestUrl);
    if (target === null) {
      respondEmpty(HTTP_STATUS_BAD_REQUEST);
      return;
    }
    if (!this.#upstreamPolicy(target.host, target.port)) {
      this.#reject(method, requestUrl, 'OPEN');
      respondEmpty(HTTP_STATUS_FORBIDDEN);
      return;
    }
    const upstream = httpRequest({
      host: connectHost(target.host),
      port: target.port,
      method,
      path: target.path,
      headers: endToEndHeaders(request.headers),
      agent: false,
    }, (upstreamResponse) => {
      if (this.#state !== 'OPEN') {
        upstreamResponse.destroy();
        response.destroy();
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? HTTP_STATUS_BAD_GATEWAY, endToEndHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on('socket', (socket: Socket) => this.#track(socket));
    upstream.on('error', () => {
      if (response.headersSent) {
        response.destroy();
      } else {
        respondEmpty(HTTP_STATUS_BAD_GATEWAY);
      }
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  }

  #handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const authority = request.url ?? '';
    clientSocket.on('error', () => undefined);
    if (this.#rejectUnlessOpen('CONNECT', authority, () => endWith(clientSocket, FORBIDDEN_RESPONSE))) {
      return;
    }
    const target = tunnelTargetOf(authority);
    if (target === null) {
      endWith(clientSocket, BAD_REQUEST_RESPONSE);
      return;
    }
    if (!this.#upstreamPolicy(target.host, target.port)) {
      this.#reject('CONNECT', authority, 'OPEN');
      endWith(clientSocket, FORBIDDEN_RESPONSE);
      return;
    }
    const upstreamSocket = netConnect({ host: connectHost(target.host), port: target.port }, () => {
      if (this.#state !== 'OPEN' || clientSocket.destroyed) {
        destroyQuietly(upstreamSocket);
        destroyQuietly(clientSocket);
        return;
      }
      clientSocket.write(CONNECTION_ESTABLISHED_RESPONSE);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    this.#track(upstreamSocket);
    upstreamSocket.on('error', () => {
      if (clientSocket.destroyed) {
        return;
      }
      if (clientSocket.writable && !upstreamSocket.connecting && upstreamSocket.bytesRead === 0) {
        endWith(clientSocket, `HTTP/1.1 ${HTTP_STATUS_BAD_GATEWAY} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } else {
        clientSocket.destroy();
      }
    });
    upstreamSocket.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstreamSocket.destroy());
  }

  /** `Upgrade` を伴う絶対形の要求（CONNECT でない WebSocket など）は受けない。凍結の後は拒否として記録する。 */
  #handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    socket.on('error', () => undefined);
    const method = request.method ?? '';
    const requestUrl = request.url ?? '';
    if (this.#rejectUnlessOpen(method, requestUrl, () => endWith(socket, FORBIDDEN_RESPONSE))) {
      return;
    }
    endWith(socket, BAD_REQUEST_RESPONSE);
  }
}

/** 中継を作り、127.0.0.1 の空いたポートで待ち受けを始める。待ち受けに失敗したら、その例外をそのまま投げる。 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  if (typeof options.onRejected !== 'function' || typeof options.onError !== 'function') {
    throw new TypeError('Egress proxy requires onRejected and onError hooks');
  }
  if (options.upstreamPolicy !== undefined && typeof options.upstreamPolicy !== 'function') {
    throw new TypeError('Egress proxy upstream policy must be a function');
  }
  const proxy = new EgressProxyImpl(options);
  await proxy.listen();
  return proxy;
}
