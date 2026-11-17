/**
 * 文書の WebSocket の Node の側の中継（DEF-276-relay。owner）。操作さがしの画面（文書の CSP が ws を止める Context）で、Guard の route が通した文書の WebSocket を、
 * ページの中の本物の接続でなく、Node の側の接続でサーバへつなぐ（呼ぶのは Guard だけ）。依存を足さない。
 * - 接続は Context の出口の中継（egress proxy）だけ: `CONNECT host:port` を送り（ws も wss も。Chromium と同じ）、wss はその上で TLS を張る（トンネルと証明書の
 *   扱いは `proxy-tunnel.ts`。書き込みの送り手と共通）。宛先の受け入れ・上流の方針・凍結（トンネルを切る）は、中継がそのまま決める。
 * - 握手は HTTP/1.1 の Upgrade（RFC 6455）。拡張（permessage-deflate）は申し出ない。握手の上限（`handshakeTimeoutMs`）を過ぎた、中継が拒んだ、TLS の確かめに
 *   落ちた、サーバが 101 と正しい `Sec-WebSocket-Accept` を返さなかった、止める口（`signal`）が止めた、は `WebSocketRelayError`（理由の閉じた一覧）で投げる。
 * - frame: text・binary・continuation（分割。間に挟まる制御の frame も扱う）・close・ping（pong を返す）・pong。サーバの frame の mask と RSV、制御の frame の
 *   分割・長さ超え、壊れた UTF-8 の text は、規約の誤りとして close（1002・1007）で閉じる。送る frame は mask する。
 * - 送りの詰まり: 送る順は Node のソケットの書き込みの列のまま保つ（落とさない。並べ替えない）。閉じた後の送りは捨てる。列が上限（`maxSendQueueBytes`）を
 *   超える送りでは、送らずに切る（code 1009、原因 `SEND_QUEUE_FULL`。REV-DEF276 の M-2）。
 * - ヘッダ: CR・LF・NUL を含む名前・値と subprotocol は、接続する前に拒む（`HEADER_INVALID`。REV-DEF276 の M-1）。Origin と Cookie の決め方は
 *   `relayHandshakeHeadersOf`（REV-DEF276 の I-1）。
 * - 閉じ: こちらから閉じるときは close の frame を送り、サーバの close の frame か接続の閉じを待つ（上限は `handshakeTimeoutMs`。過ぎたら切る）。サーバから
 *   閉じたら、同じ code を返して閉じる。接続が切れたら code 1006。閉じの知らせ（`onClose`）は 1 回だけ。
 * - 値（送受信の中身、Cookie）を記録しない。
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { AuthenticatedStorageCookie } from '../core/authenticated-storage-state.js';
import { sha1Base64OfText } from '../core/ids.js';
import { HTTP_HEADER_END, bareHostnameOf, connectTlsOverTunnel, requestProxyTunnel, tunnelAuthorityOf } from './proxy-tunnel.js';

/** 握手の失敗の理由（閉じた一覧）。 */
export const WEBSOCKET_RELAY_FAILURE_REASONS = Object.freeze([
  'REQUEST_INVALID', 'HEADER_INVALID', 'PROXY_UNAVAILABLE', 'PROXY_REJECTED', 'TLS_FAILED', 'HANDSHAKE_REJECTED', 'TIMED_OUT', 'ABORTED',
] as const);
export type WebSocketRelayFailureReason = (typeof WEBSOCKET_RELAY_FAILURE_REASONS)[number];

/** 握手の失敗（`reason` だけを持つ。値を文に入れない）。 */
export class WebSocketRelayError extends Error {
  readonly reason: WebSocketRelayFailureReason;
  constructor(reason: WebSocketRelayFailureReason) {
    super(`WebSocket relay failed: ${reason}`);
    this.name = 'WebSocketRelayError';
    this.reason = reason;
  }
}

/** 中継の指定。 */
export interface WebSocketRelayOptions {
  /** `ws:`・`wss:` の URL。 */
  readonly url: string;
  /** 出口の中継の待ち受け（接続するのはここだけ）。 */
  readonly proxy: { readonly host: string; readonly port: number };
  /** 握手に足すヘッダ（Cookie・Origin・User-Agent など。空の値は送らない）。 */
  readonly headers: Readonly<Record<string, string>>;
  /** subprotocol の申し出（ページが渡したもの）。 */
  readonly protocols: readonly string[];
  /** 握手と、こちらから閉じるときの上限（ms。正の整数）。 */
  readonly handshakeTimeoutMs: number;
  /** 送りの列（まだサーバへ書き出していない bytes）の上限（正の整数）。超える送りでは、閉じる（code 1009、原因 `SEND_QUEUE_FULL`）。 */
  readonly maxSendQueueBytes: number;
  /** テストだけ: 信頼する証明書を足す（PEM）。確かめは切らない。 */
  readonly additionalTrustedCertificates?: readonly string[] | undefined;
  /** 止める口（握手の間に止めたら `ABORTED`）。 */
  readonly signal?: AbortSignal | undefined;
}

/** 中継した接続。 */
export interface RelayedWebSocket {
  /** サーバが選んだ subprotocol（なければ空）。 */
  readonly protocol: string;
  send(data: string | Buffer): void;
  /** こちらから閉じる（close の frame を送る）。 */
  close(code?: number, reason?: string): void;
  /** すぐに切る（凍結と Context の閉じ。閉じの知らせは code 1006）。 */
  destroy(): void;
  onMessage(listener: (data: string | Buffer) => void): void;
  /** 閉じの知らせ（1 回だけ）。`cause` は、送りの列が上限を超えて閉じたときだけ `SEND_QUEUE_FULL`。 */
  onClose(listener: (code: number, reason: string, cause: RelayedWebSocketCloseCause | null) => void): void;
}

/** 中継が自分で閉じた原因（閉じた一覧）。 */
export type RelayedWebSocketCloseCause = 'SEND_QUEUE_FULL';

/** 握手の Origin と Cookie を決める事実（`relayHandshakeHeadersOf`）。 */
export interface RelayHandshakeFacts {
  /** `ws:`・`wss:` の宛先。 */
  readonly url: string;
  /** 開いている page の main frame の http(s) の Origin。 */
  readonly mainFrameOrigins: readonly string[];
  /** main frame でない frame の http(s) の Origin。 */
  readonly frameOrigins: readonly string[];
  /** 宛先の URL で読んだ Cookie（`BrowserContext.cookies(url)` の形）。 */
  readonly cookies: readonly Pick<AuthenticatedStorageCookie, 'name' | 'value' | 'domain' | 'sameSite'>[];
  /** ブラウザの User-Agent（ページから読まない）。 */
  readonly userAgent: string;
}

/** IPv4・IPv6 の host か。 */
const isIpHost = (host: string): boolean => /^[\d.]+$/u.test(host) || host.includes(':');
/**
 * 2 つの host が同じ site か（近い判定。公開の接尾辞の一覧は持たないので、同じ host か、後ろの 2 つの label が同じなら同じ site とする。IP は同じ値だけ）。
 */
function sameSiteHosts(left: string, right: string): boolean {
  if (left === right) return true;
  if (isIpHost(left) || isIpHost(right)) return false;
  const tail = (host: string): string => host.split('.').slice(-2).join('.');
  return left.includes('.') && right.includes('.') && tail(left) === tail(right);
}
/** Cookie の Domain が `host` に当たるか（先頭の `.` は domain の Cookie。ないものは host だけの Cookie）。 */
function cookieDomainMatches(domain: string, host: string): boolean {
  if (!domain.startsWith('.')) return domain === host;
  const bare = domain.slice(1);
  return host === bare || host.endsWith(`.${bare}`);
}
const hostOf = (origin: string): string => new URL(origin).hostname;

/**
 * DEF-276-relay（REV-DEF276 の I-1）: 握手のヘッダ（Origin・Cookie・User-Agent）をブラウザに近づけて決める（唯一の判定）。
 * - Origin: page の main frame の Origin（1 つに決まるとき）。宛先が main frame と同じ site でなく、別の Origin の iframe のどれか 1 つとだけ同じ site なら、
 *   その Origin。main frame が決まらない、または同じ site の iframe が 2 つ以上なら付けない。
 * - Cookie: 宛先の URL で読んだ組を土台にする。`SameSite=None` は送る。Lax・Strict は、Origin が main frame の Origin で、Cookie の Domain が main frame の
 *   host にも当たるときだけ送る（別の site の iframe が開いた接続では送らない）。
 */
export function relayHandshakeHeadersOf(facts: RelayHandshakeFacts): Record<string, string> {
  const target = new URL(facts.url).hostname;
  const mains = [...new Set(facts.mainFrameOrigins)];
  const main = mains.length === 1 ? mains[0] ?? null : null;
  let origin: string | null = null;
  if (main !== null) {
    if (sameSiteHosts(target, hostOf(main))) {
      origin = main;
    } else {
      const framed = [...new Set(facts.frameOrigins)].filter((candidate) => candidate !== main && sameSiteHosts(target, hostOf(candidate)));
      origin = framed.length === 0 ? main : framed.length === 1 ? framed[0] ?? null : null;
    }
  }
  const mainHost = main === null ? null : hostOf(main);
  const strictAllowed = origin !== null && origin === main && mainHost !== null;
  const cookies = facts.cookies.filter((cookie) => cookie.sameSite === 'None' || (strictAllowed && mainHost !== null && cookieDomainMatches(cookie.domain, mainHost)));
  return {
    ...(origin === null ? {} : { Origin: origin }),
    Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    'User-Agent': facts.userAgent,
  };
}

/** ヘッダの名前か値に、CR・LF・NUL があるか（握手の要求に差し込ませない）。 */
const HEADER_FORBIDDEN_CHARACTERS = /[\r\n\0]/u;

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE_RESPONSE_HEADER_BYTES = 16 * 1024;
const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });
const CLOSE_CODE = Object.freeze({ normal: 1000, protocolError: 1002, noStatus: 1005, abnormal: 1006, invalidData: 1007, messageTooBig: 1009 });
const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({ 'ws:': 80, 'wss:': 443 });

/** 送る frame（FIN つき、mask する）。 */
function frameOf(opcode: number, payload: Buffer): Buffer {
  const { length } = payload;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 0x10000) {
    head = Buffer.alloc(4);
    head.writeUInt8(0x80 | opcode, 0);
    head.writeUInt8(0x80 | 126, 1);
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head.writeUInt8(0x80 | opcode, 0);
    head.writeUInt8(0x80 | 127, 1);
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([head, mask, masked]);
}

/** close の frame の本文（code と理由）。1005・1006 は送れないので 1000 にする。 */
function closeBodyOf(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const body = Buffer.alloc(2 + reasonBytes.length);
  body.writeUInt16BE(code === CLOSE_CODE.noStatus || code === CLOSE_CODE.abnormal ? CLOSE_CODE.normal : code, 0);
  reasonBytes.copy(body, 2);
  return body;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** 握手の要求の bytes。 */
function handshakeRequestOf(target: URL, key: string, options: WebSocketRelayOptions): string {
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(options.protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${options.protocols.join(', ')}`] : []),
    ...Object.entries(options.headers).filter(([, value]) => value !== '').map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}${HTTP_HEADER_END}`;
}

/** 握手の応答のヘッダ（小文字の名前）と status の行。 */
function parseHandshakeResponse(head: string): { readonly status: string; readonly headers: ReadonlyMap<string, string> } {
  const [status = '', ...lines] = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers };
}

/** 中継を通して WebSocket を開く（ファイルの先頭の説明）。握手に失敗したら `WebSocketRelayError` で投げる。 */
export function openRelayedWebSocket(options: WebSocketRelayOptions): Promise<RelayedWebSocket> {
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    return Promise.reject(new WebSocketRelayError('REQUEST_INVALID'));
  }
  const port = target.port === '' ? DEFAULT_PORTS[target.protocol] : Number(target.port);
  if (port === undefined || !Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs <= 0
    || !Number.isSafeInteger(options.maxSendQueueBytes) || options.maxSendQueueBytes <= 0) {
    return Promise.reject(new WebSocketRelayError('REQUEST_INVALID'));
  }
  // REV-DEF276 の M-1: CR・LF・NUL を含むヘッダの名前・値と subprotocol は、接続する前に拒む。
  if ([...Object.entries(options.headers).flat(), ...options.protocols].some((text) => HEADER_FORBIDDEN_CHARACTERS.test(text))) {
    return Promise.reject(new WebSocketRelayError('HEADER_INVALID'));
  }
  if (options.signal?.aborted === true) {
    return Promise.reject(new WebSocketRelayError('ABORTED'));
  }
  const hostname = bareHostnameOf(target);
  const secure = target.protocol === 'wss:';
  const key = randomBytes(16).toString('base64');
  const expectedAccept = sha1Base64OfText(`${key}${WEBSOCKET_GUID}`);

  return new Promise<RelayedWebSocket>((resolve, reject) => {
    let settled = false;
    let proxySocket: Socket;
    let transport: Socket | TLSSocket | undefined;
    const fail = (reason: WebSocketRelayFailureReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      transport?.destroy();
      proxySocket.destroy();
      reject(new WebSocketRelayError(reason));
    };
    const onAbort = (): void => fail('ABORTED');
    const timer = setTimeout(() => fail('TIMED_OUT'), options.handshakeTimeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      proxySocket = netConnect({ host: options.proxy.host, port: options.proxy.port });
    } catch {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new WebSocketRelayError('PROXY_UNAVAILABLE'));
      return;
    }
    let tunnelEstablished = false;
    const onProxyError = (): void => fail(tunnelEstablished ? (secure ? 'TLS_FAILED' : 'HANDSHAKE_REJECTED') : 'PROXY_UNAVAILABLE');
    const onProxyClose = (): void => fail(tunnelEstablished ? 'HANDSHAKE_REJECTED' : 'PROXY_REJECTED');
    proxySocket.on('error', onProxyError);
    proxySocket.once('close', onProxyClose);

    /** トンネル（か、その上の TLS）の上で握手する。 */
    const handshake = (over: Socket | TLSSocket): void => {
      transport = over;
      let received = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf(HTTP_HEADER_END);
        if (end < 0) {
          if (received.length > MAX_HANDSHAKE_RESPONSE_HEADER_BYTES) fail('HANDSHAKE_REJECTED');
          return;
        }
        over.off('data', onData);
        const { status, headers } = parseHandshakeResponse(received.subarray(0, end).toString('latin1'));
        const protocol = headers.get('sec-websocket-protocol') ?? '';
        if (!/^HTTP\/1\.1 101(?: |$)/u.test(status) || headers.get('sec-websocket-accept') !== expectedAccept
          || headers.has('sec-websocket-extensions') || (protocol !== '' && !options.protocols.includes(protocol))) {
          fail('HANDSHAKE_REJECTED');
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        proxySocket.off('close', onProxyClose);
        proxySocket.off('error', onProxyError);
        // 握手の後の誤りは、開いた接続の閉じ（code 1006）として扱う（`openedSocketOf`）。
        proxySocket.on('error', () => undefined);
        resolve(openedSocketOf(over, proxySocket, protocol, received.subarray(end + HTTP_HEADER_END.length), {
          closeTimeoutMs: options.handshakeTimeoutMs, maxSendQueueBytes: options.maxSendQueueBytes,
        }));
      };
      over.on('data', onData);
      over.write(handshakeRequestOf(target, key, options), 'latin1');
    };

    proxySocket.once('connect', () => {
      requestProxyTunnel(proxySocket, tunnelAuthorityOf(hostname, port), {
        onRejected: () => fail('PROXY_REJECTED'),
        onEstablished: () => {
          tunnelEstablished = true;
          if (!secure) {
            handshake(proxySocket);
            return;
          }
          let tls: TLSSocket;
          try {
            tls = connectTlsOverTunnel(proxySocket, hostname, options.additionalTrustedCertificates);
          } catch {
            fail('TLS_FAILED');
            return;
          }
          transport = tls;
          tls.on('error', () => fail('TLS_FAILED'));
          tls.once('secureConnect', () => {
            if (!tls.authorized) {
              fail('TLS_FAILED');
              return;
            }
            handshake(tls);
          });
        },
      });
    });
  });
}

/** 握手を終えた接続（`rest` は、握手の応答の後に続いて届いた bytes）。 */
function openedSocketOf(
  socket: Socket | TLSSocket,
  proxySocket: Socket,
  protocol: string,
  rest: Buffer,
  limits: { readonly closeTimeoutMs: number; readonly maxSendQueueBytes: number },
): RelayedWebSocket {
  const { closeTimeoutMs } = limits;
  const messageListeners: ((data: string | Buffer) => void)[] = [];
  const closeListeners: ((code: number, reason: string, cause: RelayedWebSocketCloseCause | null) => void)[] = [];
  /** 届いて、まだ frame に読み切っていない bytes。 */
  let buffer: Buffer = rest;
  let fragments: Buffer[] = [];
  let fragmentOpcode: number | null = null;
  let closeSent = false;
  let finished = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let finalClose: { readonly code: number; readonly reason: string; readonly cause: RelayedWebSocketCloseCause | null } | null = null;

  const finish = (code: number, reason: string, cause: RelayedWebSocketCloseCause | null = null): void => {
    if (finished) return;
    finished = true;
    clearTimeout(closeTimer);
    socket.destroy();
    proxySocket.destroy();
    finalClose = { code, reason, cause };
    for (const listener of closeListeners.splice(0)) listener(code, reason, cause);
  };
  const sendClose = (code: number, reason: string): void => {
    if (closeSent || finished) return;
    closeSent = true;
    socket.write(frameOf(OPCODE.close, closeBodyOf(code, reason)));
    closeTimer = setTimeout(() => finish(code, reason), closeTimeoutMs);
  };
  /** 規約の誤り: close の frame を送って閉じる（知らせは、その code）。 */
  const protocolError = (code: number): void => {
    sendClose(code, '');
    finish(code, '');
  };

  /** 知らせ手がつく前に届いた message（つけたときに順に渡す）。 */
  const pendingMessages: (string | Buffer)[] = [];
  const deliver = (data: string | Buffer): void => {
    if (messageListeners.length === 0) {
      pendingMessages.push(data);
      return;
    }
    for (const listener of messageListeners) listener(data);
  };
  const parse = (): void => {
    while (!finished && buffer.length >= 2) {
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
        protocolError(CLOSE_CODE.protocolError);
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const long = buffer.readBigUInt64BE(2);
        if (long > BigInt(Number.MAX_SAFE_INTEGER)) {
          protocolError(CLOSE_CODE.protocolError);
          return;
        }
        length = Number(long);
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      const control = (opcode & 0x08) !== 0;
      if (control && (!fin || length > 125)) {
        protocolError(CLOSE_CODE.protocolError);
        return;
      }
      if (opcode === OPCODE.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_CODE.noStatus;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        sendClose(code, '');
        finish(code, reason);
        return;
      }
      if (opcode === OPCODE.ping) {
        if (!closeSent) socket.write(frameOf(OPCODE.pong, payload));
        continue;
      }
      if (opcode === OPCODE.pong) continue;
      if (opcode === OPCODE.continuation ? fragmentOpcode === null : (fragmentOpcode !== null || (opcode !== OPCODE.text && opcode !== OPCODE.binary))) {
        protocolError(CLOSE_CODE.protocolError);
        return;
      }
      if (opcode !== OPCODE.continuation) fragmentOpcode = opcode;
      fragments.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(fragments);
      const wholeOpcode = fragmentOpcode;
      fragments = [];
      fragmentOpcode = null;
      let data: string | Buffer = whole;
      if (wholeOpcode === OPCODE.text) {
        try {
          data = UTF8.decode(whole);
        } catch {
          protocolError(CLOSE_CODE.invalidData);
          return;
        }
      }
      deliver(data);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.once('close', () => finish(CLOSE_CODE.abnormal, ''));
  socket.on('error', () => finish(CLOSE_CODE.abnormal, ''));
  proxySocket.once('close', () => finish(CLOSE_CODE.abnormal, ''));
  // 握手の応答に続いて届いていた frame を読む。
  parse();

  return Object.freeze({
    protocol,
    send: (data: string | Buffer): void => {
      if (closeSent || finished) return;
      const frame = typeof data === 'string' ? frameOf(OPCODE.text, Buffer.from(data, 'utf8')) : frameOf(OPCODE.binary, data);
      // REV-DEF276 の M-2: 送りの列が上限を超えるなら、送らずに切る（ページには code 1009。呼ぶ側が記録する）。
      if (socket.writableLength + frame.length > limits.maxSendQueueBytes) {
        finish(CLOSE_CODE.messageTooBig, '', 'SEND_QUEUE_FULL');
        return;
      }
      socket.write(frame);
    },
    close: (code: number = CLOSE_CODE.normal, reason = ''): void => sendClose(code, reason),
    destroy: (): void => finish(CLOSE_CODE.abnormal, ''),
    onMessage: (listener: (data: string | Buffer) => void): void => {
      messageListeners.push(listener);
      for (const data of pendingMessages.splice(0)) listener(data);
    },
    onClose: (listener: (code: number, reason: string, cause: RelayedWebSocketCloseCause | null) => void): void => {
      if (finalClose !== null) {
        listener(finalClose.code, finalClose.reason, finalClose.cause);
        return;
      }
      closeListeners.push(listener);
    },
  });
}
