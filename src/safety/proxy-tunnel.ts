/**
 * Node の側から Context の出口の中継（egress proxy）へトンネルを張る部品（DEF-276-relay。owner）。書き込みの送り手（`write-submission-sender.ts`）と、文書の
 * WebSocket の中継（`websocket-relay.ts`）が使う（同じ処理を写さない）。
 * - 中継に `CONNECT host:port` を送り、確立の応答（2xx）を受けてからトンネルを使う。宛先の受け入れ・上流の方針・凍結（トンネルを切る）は、中継が決める
 *   （ここでは照合し直さない）。
 * - TLS の証明書は、Node の同梱の証明書と OS の証明書の置き場所（`tls.getCACertificates('bundled' | 'system')`）で確かめる。確かめを切る設定は持たない
 *   （テストだけ、信頼する証明書を足せる）。ALPN は `http/1.1`。
 */
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, getCACertificates, type TLSSocket } from 'node:tls';

/** 中継の `CONNECT` の応答のヘッダの上限（bytes）。 */
const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;
const CONNECT_ESTABLISHED_STATUS = /^HTTP\/1\.[01] 2\d\d(?: |\r)/u;
/** HTTP/1.1 のヘッダの終わり。 */
export const HTTP_HEADER_END = '\r\n\r\n';

/** `CONNECT` の宛先（`host:port`。IPv6 は角括弧で囲む）。`hostname` は角括弧を外した形。 */
export const tunnelAuthorityOf = (hostname: string, port: number): string => `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;

/** URL の hostname から角括弧を外す（IPv6）。 */
export const bareHostnameOf = (url: URL): string => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);

/**
 * 接続した中継のソケット（`proxySocket`）に `CONNECT authority` を送り、確立の応答を待つ。確立したら `onEstablished`、中継が拒んだ（2xx でない・ヘッダが
 * 上限を超えた・確立の応答の後に bytes が続いた）ら `onRejected` を、どちらか 1 回だけ呼ぶ。ソケットの閉じと誤りは、呼ぶ側が扱う。
 */
export function requestProxyTunnel(proxySocket: Socket, authority: string, handlers: { readonly onEstablished: () => void; readonly onRejected: () => void }): void {
  let received = '';
  const onData = (chunk: Buffer): void => {
    received += chunk.toString('latin1');
    const end = received.indexOf(HTTP_HEADER_END);
    if (end < 0) {
      if (received.length > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
        proxySocket.off('data', onData);
        handlers.onRejected();
      }
      return;
    }
    proxySocket.off('data', onData);
    if (!CONNECT_ESTABLISHED_STATUS.test(received) || received.length > end + HTTP_HEADER_END.length) {
      handlers.onRejected();
      return;
    }
    handlers.onEstablished();
  };
  proxySocket.on('data', onData);
  proxySocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
}

/** 信頼する証明書（Node の同梱、OS の置き場所、テストだけ足すもの）。 */
const trustedCertificatesOf = (additional: readonly string[] | undefined): string[] =>
  [...getCACertificates('bundled'), ...getCACertificates('system'), ...(additional ?? [])];

/**
 * 確立したトンネル（`proxySocket`）の上で TLS を張り始める（証明書を確かめる。ALPN は `http/1.1`）。`secureConnect` の後に `authorized` を確かめるのは呼ぶ側。
 * 張れなければ投げる。
 */
export function connectTlsOverTunnel(proxySocket: Socket, hostname: string, additionalTrustedCertificates: readonly string[] | undefined): TLSSocket {
  return tlsConnect({
    socket: proxySocket,
    host: hostname,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
    ca: trustedCertificatesOf(additionalTrustedCertificates),
    rejectUnauthorized: true,
    ALPNProtocols: ['http/1.1'],
  });
}
