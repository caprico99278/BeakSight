/**
 * Guard の付いた Context の出口の中継（HTTP の前方 proxy。DEF-039・DEF-040 の設計書 2.1.1。owner）。DEF-085 から、Interaction の Context
 * だけでなく、factory が作るすべての Guard の Context（Passive、ログインの段）に付ける。
 *
 * - Node.js 標準の `http` と `net` だけで作り、127.0.0.1 の空いたポートで待つ。Guard の Context は、Playwright の Context ごとの
 *   proxy（`proxy: { server }`）で、すべての通信をここに通す（127.0.0.1 への通信も含む）。
 * - 受けるもの: 絶対形の HTTP の要求（`http://...`。上流へそのまま転送する）と、`CONNECT host:port`（上流へ TCP で接続し、
 *   `200 Connection Established` の後は両方向にそのまま流す。https と wss はこれを通る。中身は見ない）。それ以外（相対形の要求、
 *   `http:` 以外の絶対形、`Upgrade` を伴う要求）は `400` で拒む。
 * - 状態は `OPEN` → `FROZEN` → `CLOSED` の一方向。
 *   - `OPEN`: 転送する。上流の方針（`upstreamPolicy(host, port)`）に合わないものは `403` で拒み、`onRejected`（`phase: 'OPEN'`）に知らせる。
 *     要求の方針（`requestPolicy(method, url)`。絶対形の HTTP の要求だけ。DEF-085）があれば、合わないものを `403` で拒み、`onRejected`
 *     （`phase: 'REQUEST_POLICY'`）に知らせる（上流の方針より先に確かめる）。CONNECT は中身が見えないので、要求の方針を当てない。
 *     要求の回数の上限（`requestBudget`。DEF-099 fix。書き込みの段の Context の承認の送信先への POST）があれば、要求の方針と上流の方針を
 *     通った絶対形の要求のうち当たるものを上限まで通し、超えたものを `403` で拒み、`onRejected`（`phase: 'REQUEST_BUDGET'`）に知らせる。
 *   - `freeze()`: `FROZEN` にし、今つながっているすべてのソケット（クライアント側と上流側。CONNECT のトンネルと keep-alive を含む）を
 *     破棄する。以後は、すべての要求と CONNECT を `403` で拒み、`onRejected`（`phase: 'FROZEN'`）に知らせる。
 *   - `close()`: `CLOSED` にし、すべてのソケットを破棄して、待ち受けを閉じる。重ねて呼んでもよい。
 * - 記録の口 `onRejected({ method, url, phase })`: `url` は、絶対形の要求ならその URL、CONNECT なら `host:port`（authority の形。
 *   https か wss かは分からない）。中継は Safety Ledger を知らない（Ledger に写すのは factory。設計書 2.1.2）。
 * - 上流の失敗の伝え方（DEF-085 fix round 1。`upstreamFailureMode`）: `PASS_THROUGH` は、中継なしと同じ結果になるよう、失敗をそのまま
 *   伝える。上流に接続できない（絶対形の要求、CONNECT のどちらも）ときは、応答（502 など）を作らずに、クライアントの接続を RST で切る
 *   （Chromium は `ERR_CONNECTION_RESET`。網の層の失敗）。上流が接続の後に応答なしで切ったときは、クライアントの接続も応答なしで切る
 *   （`ERR_EMPTY_RESPONSE`。中継なしと同じ）。上流の本文が途中で切れたときは、クライアントへの応答も途中で壊す
 *   （`ERR_CONTENT_LENGTH_MISMATCH`、`ERR_INCOMPLETE_CHUNKED_ENCODING`。中継なしと同じ）。`BAD_GATEWAY`（既定）は、今までどおり `502` を返す。
 *   どちらでも、中継の拒否（上流の方針、要求の方針、凍結の後）は `403` のまま。
 * - `PASS_THROUGH` の絶対形の HTTP の要求の転送（DEF-085 fix round 3。T27R2 の C2）: 上流の応答を Node で読み直さず、上流の bytes をそのまま
 *   クライアントへ流す（`#relayPassThrough`）。Chromium が中継なしと同じ bytes を自分で読むので、理由の文字列、ヘッダの生の並び、変わった形の応答
 *   （大きなヘッダ、制御文字、LF だけの改行、CL と TE、obs-fold、HTTP/0.9 など）の扱いが、中継なしと同じになる。上流が RST で切ったら、
 *   クライアントにも RST で伝える。Chromium の要求は、寛容な解析（`insecureHTTPParser`）と大きなヘッダの上限（`MAX_EGRESS_HTTP_HEADER_BYTES`）で
 *   読む。上流へは、中継なしの Chromium と同じ `Connection: keep-alive` を付けて送る。
 * - 失敗の口 `onError`: 待ち受けの後の `error` だけを知らせる。ソケットごとの失敗は、そのソケットを破棄するだけで、知らせない。
 *   口（`onRejected`、`onError`）の例外は封じ込める。
 * - 上流の方針の既定（`ALLOW_ALL_EGRESS_UPSTREAMS`）は、すべての host を許す（production。ページが読み込むほかの Origin のリソースは、
 *   中継を通しても露出が増えない）。テストは、127.0.0.1 だけを許す方針を注入する。
 * - TLS は解かない（中身の検査は Guard の仕事）。HTTP/2 と HTTP/3 は使われない（Chromium は HTTP の中継には HTTP/1.1 で話す。推測）。
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LookupAddress, LookupOptions } from 'node:dns';
import {
  connect as netConnect,
  isIP,
  Socket as NetSocket,
  type AddressInfo,
  type LookupFunction,
  type Socket,
} from 'node:net';
import type { Duplex } from 'node:stream';

/** 中継の状態の閉じた一覧（一方向に進む）。 */
export const EGRESS_PROXY_STATES = Object.freeze(['OPEN', 'FROZEN', 'CLOSED'] as const);
export type EgressProxyState = (typeof EGRESS_PROXY_STATES)[number];

/**
 * 中継が要求を拒んだ段階の閉じた一覧（`OPEN` は上流の方針の拒否、`FROZEN` は凍結の後の拒否、`REQUEST_POLICY` は `OPEN` の間に要求の方針
 * （method と URL。DEF-085）で拒んだもの）。
 */
export const EGRESS_REJECTION_PHASES = Object.freeze(['OPEN', 'FROZEN', 'REQUEST_POLICY', 'REQUEST_BUDGET'] as const);
export type EgressRejectionPhase = (typeof EGRESS_REJECTION_PHASES)[number];

/** 中継が拒んだ 1 件の要求。`url` は、絶対形の要求ならその URL、CONNECT なら `host:port`。 */
export interface EgressRejection {
  readonly method: string;
  readonly url: string;
  readonly phase: EgressRejectionPhase;
}

/** 上流の方針。`host` は URL の hostname の形（IPv6 は `[...]`）、`port` は実際に接続する番号（`http:` の既定は 80）。 */
export type EgressUpstreamPolicy = (host: string, port: number) => boolean;

/**
 * 要求の方針（DEF-085）。`method` は要求の method、`url` は絶対形の要求の URL（`http:`）。真なら通す。例外は拒否として扱う（fail-closed）。
 */
export type EgressRequestPolicy = (method: string, url: string) => boolean;

/**
 * 要求の回数の上限（DEF-099 fix。書き込みの段の Context の、承認の送信先への POST）。絶対形の HTTP の要求のうち `matches` に当たるものを、`limit`
 * 回まで通し、超えたものを `403` で拒み、`onRejected`（`phase: 'REQUEST_BUDGET'`）に知らせる。数えるのは、要求の方針と上流の方針を通った後
 * （中継が上流へ送ろうとした要求）。CONNECT の中身は見えないので数えない。`matches` の例外は当たったとして扱う（fail-closed）。
 */
export interface EgressRequestBudget {
  readonly matches: (method: string, url: string) => boolean;
  readonly limit: number;
}

/** production の上流の方針: すべての host を許す。 */
export const ALLOW_ALL_EGRESS_UPSTREAMS: EgressUpstreamPolicy = () => true;

/** 上流の失敗の伝え方の閉じた一覧（DEF-085 fix round 1。`EgressProxyOptions.upstreamFailureMode`）。 */
export const EGRESS_UPSTREAM_FAILURE_MODES = Object.freeze(['PASS_THROUGH', 'BAD_GATEWAY'] as const);
export type EgressUpstreamFailureMode = (typeof EGRESS_UPSTREAM_FAILURE_MODES)[number];

export interface EgressProxyOptions {
  /** 上流の方針。省略すると `ALLOW_ALL_EGRESS_UPSTREAMS`。 */
  readonly upstreamPolicy?: EgressUpstreamPolicy | undefined;
  /** 要求の方針（DEF-085）。省略すると、要求の method と URL では拒まない（今のまま）。 */
  readonly requestPolicy?: EgressRequestPolicy | undefined;
  /** 要求の回数の上限（DEF-099 fix。`EgressRequestBudget`）。省略すると数えない（今のまま）。 */
  readonly requestBudget?: EgressRequestBudget | undefined;
  /**
   * 上流の失敗の伝え方（DEF-085 fix round 1。`EGRESS_UPSTREAM_FAILURE_MODES`）。省略すると `BAD_GATEWAY`（今のまま）。
   * - `PASS_THROUGH`: 応答を作らずに、失敗をそのまま伝える（中継なしと同じ結果にする。Passive とログインの段の Context）。上流に接続できない
   *   ときは、クライアントの接続を RST で切る（Chromium は `ERR_CONNECTION_RESET`）。上流が接続の後に応答なしで切ったときは、クライアントの
   *   接続も応答なしで切る（`ERR_EMPTY_RESPONSE`。中継なしと同じ）。上流の本文が途中で切れたときは、クライアントへの応答も途中で壊す。
   * - `BAD_GATEWAY`: 上流の失敗に `502` を返す（Interaction の Context の今の作り。変えるかは設計者の判断を待つ）。
   */
  readonly upstreamFailureMode?: EgressUpstreamFailureMode | undefined;
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
  /**
   * 要求の host（URL の hostname の形）と port で、最後に接続できた上流の相手のアドレス（DEF-085 fix round 2）。`PASS_THROUGH` のときだけ覚える
   * （`BAD_GATEWAY` ではいつも `null`）。覚えていなければ `null`。上限は `MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES`。
   */
  upstreamAddressOf(host: string, port: number): EgressUpstreamAddress | null;
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
/** 拒否の応答の、生の bytes の形（status ごと。fix round 4 の M-1）。 */
const RAW_REJECTION_RESPONSES: ReadonlyMap<number, string> = new Map([
  [HTTP_STATUS_FORBIDDEN, FORBIDDEN_RESPONSE],
  [HTTP_STATUS_BAD_REQUEST, BAD_REQUEST_RESPONSE],
]);
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

/** `localhost` の名前（RFC 6761 6.3）と、その下の名前の接尾辞。小文字で比べる。 */
const LOCALHOST_NAME = 'localhost';
const LOCALHOST_SUFFIX = `.${LOCALHOST_NAME}`;

/**
 * `localhost` か、その下の名前か（大文字と小文字を区別しない。RFC 6761 6.3）。末尾の `.` のある完全な名前（`localhost.`、`app.localhost.`）も
 * 同じに扱う（Chromium と同じ。DEF-085 fix round 3 の M4）。
 */
function isLocalhostName(host: string): boolean {
  const lower = host.toLowerCase();
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return name === LOCALHOST_NAME || name.endsWith(LOCALHOST_SUFFIX);
}

/**
 * `localhost` の名前を解決した結果（ループバックの IPv4 と IPv6）。OS には問い合わせない。順は IPv4 を先にする（BeakSight の fixture と
 * 中継自身は 127.0.0.1 で待つので、多くの場合、最初の試みでつながる）。
 */
const LOOPBACK_LOOKUP_ADDRESSES: readonly LookupAddress[] = Object.freeze([
  Object.freeze({ address: '127.0.0.1', family: 4 }),
  Object.freeze({ address: '::1', family: 6 }),
]);

/**
 * `localhost` の名前の名前解決（`net.connect` と `http.request` の `lookup`。DEF-085 fix round 1、round 2）。OS（`dns.lookup`）に問い合わせずに、
 * ループバックのアドレスを返す。`all` の指定があれば全部、なければ `family` に合う最初のもの（指定がなければ最初のもの）。
 */
const loopbackLookup = ((
  _hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void => {
  if (options.all === true) {
    callback(null, LOOPBACK_LOOKUP_ADDRESSES.map((entry) => ({ ...entry })));
    return;
  }
  const family = options.family === 6 || options.family === 'IPv6' ? 6 : options.family === 4 || options.family === 'IPv4' ? 4 : null;
  const entry = LOOPBACK_LOOKUP_ADDRESSES.find((candidate) => family === null || candidate.family === family)
    ?? LOOPBACK_LOOKUP_ADDRESSES[0];
  callback(null, entry?.address ?? '127.0.0.1', entry?.family ?? 4);
}) as LookupFunction;

/** 上流への接続の指定（`host` と、`localhost` の名前の場合の `lookup`）。 */
interface UpstreamConnectTarget {
  readonly host: string;
  readonly lookup?: LookupFunction;
}

/**
 * `PASS_THROUGH` の接続先（DEF-085 fix round 1、round 2）。中継なしの Chromium は、`localhost` とその下の名前（例 `app.localhost`）を、OS の名前解決に
 * 問わずにループバックに解決する（RFC 6761 6.3）。中継も同じく、その名前は OS に問い合わせずに、ループバックのアドレスに接続する（`lookup` を
 * `loopbackLookup` にする。要求の `Host` のヘッダは変えない）。ほかの名前は `connectHost` と同じ（OS の名前解決）。
 */
function passThroughConnectTarget(host: string): UpstreamConnectTarget {
  return isLocalhostName(host) ? { host: LOCALHOST_NAME, lookup: loopbackLookup } : { host: connectHost(host) };
}

/**
 * 上流の相手のアドレスを覚える表の件数の上限（DEF-085 fix round 2）。1 つの Context の中継が覚える、要求の host と port ごとの最後の相手の
 * アドレスの数。超えたら、最も古く更新したものから捨てる。値の根拠: 1 つの Context が読み込む 1 ページの、別の host と port の数は、ふつう
 * 数十までなので、余裕を持たせた（設計者の指示の「上限つきの小さな表」）。
 */
export const MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES = 256;

/** 上流の相手のアドレス（`socket.remoteAddress` と `remotePort`）。 */
export interface EgressUpstreamAddress {
  readonly address: string;
  readonly port: number;
}

/** 表の鍵（要求の host を小文字にしたものと port）。host は URL の hostname の形（IPv6 は `[...]`）。 */
const upstreamAddressKey = (host: string, port: number): string => `${host.toLowerCase()} ${port}`;

/** `socket` を、失敗を外に出さずに破棄する。 */
function destroyQuietly(socket: Duplex): void {
  socket.on('error', () => undefined);
  socket.destroy();
}

/**
 * 上流の失敗を、応答を作らずにクライアントへ伝える（DEF-085 fix round 1）: クライアントの接続を RST で切る（`net.Socket` でなければ
 * 破棄する）。Chromium は、中継なしの接続の失敗と同じく、網の層の失敗（`ERR_CONNECTION_RESET`）として扱う。
 */
function resetQuietly(socket: Duplex): void {
  socket.on('error', () => undefined);
  if (socket instanceof NetSocket && !socket.destroyed) {
    socket.resetAndDestroy();
  } else {
    socket.destroy();
  }
}

/**
 * `PASS_THROUGH` の中継が読む、要求のヘッダの大きさの上限（bytes。DEF-085 fix round 3）。Node の既定（16 KiB）では、約 20 KB の Cookie を
 * 持つ要求を読めない（T27R2）。値の根拠: Chromium の HTTP の頭の読み取りの上限（`net/http/http_stream_parser.cc` の `kMaxHeaderBufSize`、
 * 256 KiB）に合わせた。中継なしの Chromium が送れる大きさの要求を、中継が拒まない。
 */
export const MAX_EGRESS_HTTP_HEADER_BYTES = 256 * 1024;

/**
 * `PASS_THROUGH` の上流への要求に付ける `Connection` のヘッダ。中継なしの Chromium と同じ `keep-alive` にする（`close` にすると、上流の応答の
 * ヘッダが変わり、記録する応答のヘッダの大きさが中継なしと変わる。fix round 3 の再測定）。
 */
const UPSTREAM_CONNECTION_HEADER = 'Connection: keep-alive';

/** `Content-Length` のヘッダの名前（小文字）。 */
const CONTENT_LENGTH_HEADER = 'content-length';

/** 上流が RST で切ったときの、Node の失敗のコード。 */
const UPSTREAM_RESET_ERROR_CODE = 'ECONNRESET';
/** chunked の本文の終わり。 */
const LAST_CHUNK = '0\r\n\r\n';

/** 本文を chunked で送るメッセージか（`Transfer-Encoding` の最後の符号化が `chunked`）。 */
function isChunkedMessage(headers: IncomingHttpHeaders): boolean {
  const encodings = (headers['transfer-encoding'] ?? '').split(',').map((value) => value.trim().toLowerCase());
  return encodings.at(-1) === 'chunked';
}

/** 本文の 1 片を、chunked の 1 つの chunk に包む（空の片は送らない。空の chunk は終わりの印になるため）。 */
function chunkOf(chunk: Buffer): Buffer {
  return chunk.length === 0
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`, 'latin1'), chunk, Buffer.from('\r\n', 'latin1')]);
}

/**
 * `PASS_THROUGH` の上流への要求の頭（DEF-085 fix round 3）。要求の行は origin-form、ヘッダは生の並び（`rawHeaders`。名前の大文字と小文字と
 * 重なりを保つ）から、ホップごとのヘッダと `Transfer-Encoding` を除き（chunked の本文なら `Content-Length` も除く）、chunked の本文なら
 * `Transfer-Encoding: chunked` を、最後に
 * `UPSTREAM_CONNECTION_HEADER` を足す。文字列は latin1 で bytes にする（Node が読んだ値の bytes を変えない）。
 */
function upstreamRequestHead(method: string, path: string, rawHeaders: readonly string[], chunked: boolean): Buffer {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? '';
    const lower = name.toLowerCase();
    // fix round 4（M-3）: 本文を chunked に包み直すときは、`Content-Length` を送らない（両方を送ると、上流が本文の長さを取り違えうる）。
    if (!HOP_BY_HOP_HEADERS.has(lower) && !(chunked && lower === CONTENT_LENGTH_HEADER)) {
      lines.push(`${name}: ${rawHeaders[index + 1] ?? ''}`);
    }
  }
  if (chunked) {
    lines.push('Transfer-Encoding: chunked');
  }
  lines.push(UPSTREAM_CONNECTION_HEADER);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
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
  readonly #requestPolicy: EgressRequestPolicy | undefined;
  readonly #requestBudget: EgressRequestBudget | undefined;
  /** 回数の上限に当たった要求の数（DEF-099 fix）。 */
  #budgetUsed = 0;
  readonly #upstreamFailureMode: EgressUpstreamFailureMode;
  readonly #onRejected: (rejection: EgressRejection) => void;
  readonly #onError: (error: unknown) => void;
  /** 今つながっているソケット（クライアント側と上流側）。凍結と閉じる処理で、すべて破棄する。 */
  readonly #sockets = new Set<Duplex>();
  /**
   * 要求の host と port ごとの、最後に接続できた上流の相手のアドレス（DEF-085 fix round 2。`PASS_THROUGH` のときだけ書く）。挿入の順を
   * 更新の順にし（書くたびに消してから入れ直す）、上限（`MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES`）を超えたら、最も古いものを捨てる。
   */
  readonly #upstreamAddresses = new Map<string, EgressUpstreamAddress>();
  /** クライアントの接続ごとの、今の要求の上流の接続（`PASS_THROUGH` の転送。fix round 3）。 */
  readonly #clientRelays = new WeakMap<Duplex, Socket>();
  #state: EgressProxyState = 'OPEN';
  #port = 0;
  #closing: Promise<void> | null = null;

  constructor(options: EgressProxyOptions) {
    this.#upstreamPolicy = options.upstreamPolicy ?? ALLOW_ALL_EGRESS_UPSTREAMS;
    this.#requestPolicy = options.requestPolicy;
    this.#requestBudget = options.requestBudget === undefined
      ? undefined
      : Object.freeze({ matches: options.requestBudget.matches, limit: options.requestBudget.limit });
    this.#upstreamFailureMode = options.upstreamFailureMode ?? 'BAD_GATEWAY';
    this.#onRejected = options.onRejected;
    this.#onError = options.onError;
    // DEF-085 fix round 3: `PASS_THROUGH` は、Chromium が送る要求を、Chromium と同じくらい寛容に読む（大きな Cookie の要求を含む）。
    this.#server = createServer(
      this.#upstreamFailureMode === 'PASS_THROUGH'
        ? { insecureHTTPParser: true, maxHeaderSize: MAX_EGRESS_HTTP_HEADER_BYTES }
        : {},
      (request, response) => this.#handleRequest(request, response),
    );
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

  upstreamAddressOf(host: string, port: number): EgressUpstreamAddress | null {
    const entry = this.#upstreamAddresses.get(upstreamAddressKey(host, port));
    return entry === undefined ? null : { ...entry };
  }

  /**
   * 上流に接続できたソケットの相手のアドレスを、要求の host と port に結びつけて覚える（DEF-085 fix round 2。`PASS_THROUGH` のときだけ）。
   * 相手のアドレスが IP アドレスでないか、port が分からなければ、覚えない。
   */
  #rememberUpstreamAddress(host: string, port: number, socket: Socket): void {
    if (this.#upstreamFailureMode !== 'PASS_THROUGH') {
      return;
    }
    const { remoteAddress, remotePort } = socket;
    if (remoteAddress === undefined || isIP(remoteAddress) === 0 || remotePort === undefined) {
      return;
    }
    const key = upstreamAddressKey(host, port);
    this.#upstreamAddresses.delete(key);
    this.#upstreamAddresses.set(key, Object.freeze({ address: remoteAddress, port: remotePort }));
    while (this.#upstreamAddresses.size > MAX_EGRESS_UPSTREAM_ADDRESS_ENTRIES) {
      const oldest = this.#upstreamAddresses.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#upstreamAddresses.delete(oldest.value);
    }
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

  /** 上流への接続の指定（`PASS_THROUGH` では `passThroughConnectTarget`、`BAD_GATEWAY` では今のまま `connectHost`）。 */
  #upstreamTarget(host: string): UpstreamConnectTarget {
    return this.#upstreamFailureMode === 'PASS_THROUGH' ? passThroughConnectTarget(host) : { host: connectHost(host) };
  }

  /** 要求の方針で通すか。方針がなければ通す。方針の例外は拒否として扱う（fail-closed）。 */
  #requestAllowed(method: string, url: string): boolean {
    if (this.#requestPolicy === undefined) {
      return true;
    }
    try {
      return this.#requestPolicy(method, url) === true;
    } catch {
      return false;
    }
  }

  /** 回数の上限で拒むか（DEF-099 fix）。当たる要求を数え、上限を超えたら真。`matches` の例外は当たったとして扱う（fail-closed）。 */
  #overBudget(method: string, url: string): boolean {
    if (this.#requestBudget === undefined) {
      return false;
    }
    let matches: boolean;
    try {
      matches = this.#requestBudget.matches(method, url) === true;
    } catch {
      matches = true;
    }
    if (!matches) {
      return false;
    }
    this.#budgetUsed += 1;
    return this.#budgetUsed > this.#requestBudget.limit;
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
      const rawRejection = RAW_REJECTION_RESPONSES.get(status);
      if (this.#upstreamFailureMode === 'PASS_THROUGH' && this.#clientRelays.has(request.socket) && rawRejection !== undefined) {
        // fix round 4（M-1）: 同じ接続の前の要求を生の bytes で転送した後は、前の `ServerResponse` が終わらないので、この応答は並んだまま
        // 返らない。前の上流を外し、拒否の応答を生の bytes で書いて、接続を閉じる（上流には送らない）。
        this.#detachPreviousRelay(request.socket);
        endWith(request.socket, rawRejection);
        return;
      }
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
    if (!this.#requestAllowed(method, requestUrl)) {
      this.#reject(method, requestUrl, 'REQUEST_POLICY');
      respondEmpty(HTTP_STATUS_FORBIDDEN);
      return;
    }
    if (!this.#upstreamPolicy(target.host, target.port)) {
      this.#reject(method, requestUrl, 'OPEN');
      respondEmpty(HTTP_STATUS_FORBIDDEN);
      return;
    }
    if (this.#overBudget(method, requestUrl)) {
      this.#reject(method, requestUrl, 'REQUEST_BUDGET');
      respondEmpty(HTTP_STATUS_FORBIDDEN);
      return;
    }
    if (this.#upstreamFailureMode === 'PASS_THROUGH') {
      this.#relayPassThrough(request, method, target);
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

  /**
   * `PASS_THROUGH` の絶対形の HTTP の要求の転送（DEF-085 fix round 3。T27R2 の C2）。応答を Node で読み直さずに、上流の bytes をそのまま
   * クライアントへ流す（Chromium が、中継なしと同じ bytes を自分で読む。理由の文字列、ヘッダの生の並び、変わった形の応答、本文の途中の切断の
   * 扱いが、中継なしと同じになる）。
   * - 上流へは、要求の行を origin-form（`<method> <path> HTTP/1.1`）にし、要求のヘッダの生の並び（`rawHeaders`）からホップごとのヘッダを除いて、
   *   中継なしの Chromium と同じ `Connection: keep-alive` を足して送る（`UPSTREAM_CONNECTION_HEADER`）。本文は、Node が読んだ本文を、chunked で
   *   送られてきた要求は chunked に包み直して送る。
   * - 上流の bytes は、そのままクライアントへ流し、上流が閉じたら（FIN）クライアントへの接続も閉じる（応答なしで閉じた場合も。Chromium は
   *   `ERR_EMPTY_RESPONSE`。中継なしと同じ）。Chromium が、応答を読み終えた同じ接続で次の要求を送ったら、前の上流を外して壊し
   *   （`#clientRelays`）、新しい上流へ転送する。
   * - 上流に接続できない（拒否、名前解決の失敗など）、または上流が RST で切った（`ECONNRESET`）ときは、クライアントの接続を RST で切る
   *   （`ERR_CONNECTION_RESET`。中継なしと同じ網の層の失敗）。そのほかの失敗は、クライアントの接続を閉じる。
   * - 凍結と閉じる処理は、追っているソケット（クライアント側と上流側）をすべて壊す（今までと同じ）。
   */
  #relayPassThrough(request: IncomingMessage, method: string, target: ForwardTarget): void {
    const client = request.socket;
    // Chromium は、前の応答を読み終えてから、同じ接続で次の要求を送る（keep-alive）。前の要求の上流は、ここで外して壊す（その上流が後で
    // 閉じても、クライアントの接続を閉じない）。
    this.#detachPreviousRelay(client);
    if (!this.#clientRelays.has(client)) {
      // fix round 4（I-1）: クライアントのソケットの listener は、接続ごとに 1 回だけ付ける（要求ごとに足すと、keep-alive の接続で積み増し、
      // `MaxListenersExceededWarning` が出る）。閉じたら、そのときの上流を壊す。
      client.on('error', () => undefined);
      client.on('close', () => this.#clientRelays.get(client)?.destroy());
    }
    const upstream = netConnect({ ...this.#upstreamTarget(target.host), port: target.port });
    this.#clientRelays.set(client, upstream);
    const isCurrent = (): boolean => this.#clientRelays.get(client) === upstream;
    this.#track(upstream);
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      if (this.#state !== 'OPEN' || client.destroyed) {
        destroyQuietly(upstream);
        destroyQuietly(client);
        return;
      }
      this.#rememberUpstreamAddress(target.host, target.port, upstream);
      const chunked = isChunkedMessage(request.headers);
      upstream.write(upstreamRequestHead(method, target.path, request.rawHeaders, chunked));
      request.on('data', (chunk: Buffer) => {
        upstream.write(chunked ? chunkOf(chunk) : chunk);
      });
      request.on('end', () => {
        if (chunked) {
          upstream.write(LAST_CHUNK);
        }
      });
      upstream.pipe(client, { end: false });
    });
    // 上流が閉じたら（FIN）、クライアントへの接続も閉じる（応答なしで閉じた場合、close-delimited の本文の終わり、本文の途中の切断）。
    upstream.on('end', () => {
      if (isCurrent()) {
        client.end();
      }
    });
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (client.destroyed || !isCurrent()) {
        return;
      }
      if (!connected || error.code === UPSTREAM_RESET_ERROR_CODE) {
        resetQuietly(client);
      } else {
        client.destroy();
      }
    });
  }

  /** 同じクライアントの接続の、前の要求の上流を外して壊す（fix round 3、round 4）。前の要求がなければ、何もしない。 */
  #detachPreviousRelay(client: Duplex): void {
    const previous = this.#clientRelays.get(client);
    if (previous !== undefined) {
      previous.unpipe(client);
      destroyQuietly(previous);
    }
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
    let tunnelEstablished = false;
    const upstreamSocket = netConnect({ ...this.#upstreamTarget(target.host), port: target.port }, () => {
      if (this.#state !== 'OPEN' || clientSocket.destroyed) {
        destroyQuietly(upstreamSocket);
        destroyQuietly(clientSocket);
        return;
      }
      this.#rememberUpstreamAddress(target.host, target.port, upstreamSocket);
      tunnelEstablished = true;
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
      if (tunnelEstablished) {
        clientSocket.destroy();
      } else if (this.#upstreamFailureMode === 'PASS_THROUGH') {
        // DEF-085 fix round 1: 上流に接続できないとき（トンネルを開く前）は、CONNECT に応答（502 など）を返さずに、クライアントの接続を
        // RST で切る。Chromium は `ERR_TUNNEL_CONNECTION_FAILED` ではなく、網の層の失敗（`ERR_CONNECTION_RESET`）として扱う（両方の
        // Chromium で確かめた）。
        resetQuietly(clientSocket);
      } else if (clientSocket.writable && !upstreamSocket.connecting && upstreamSocket.bytesRead === 0) {
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
  if (options.requestPolicy !== undefined && typeof options.requestPolicy !== 'function') {
    throw new TypeError('Egress proxy request policy must be a function');
  }
  if (options.requestBudget !== undefined && (typeof options.requestBudget.matches !== 'function'
    || !Number.isSafeInteger(options.requestBudget.limit) || options.requestBudget.limit < 0)) {
    throw new TypeError('Egress proxy request budget must have a match function and a non-negative integer limit');
  }
  if (
    options.upstreamFailureMode !== undefined
    && !(EGRESS_UPSTREAM_FAILURE_MODES as readonly unknown[]).includes(options.upstreamFailureMode)
  ) {
    throw new TypeError('Egress proxy upstream failure mode must be one of EGRESS_UPSTREAM_FAILURE_MODES');
  }
  const proxy = new EgressProxyImpl(options);
  await proxy.listen();
  return proxy;
}
