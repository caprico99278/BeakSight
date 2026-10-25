// DEF-070（テストの補助）: Chromium 自身が試みる、loopback でない宛先への接続を数える、記録用の中継と、その中継を使う起動の引数。
// - 中継は 127.0.0.1 だけで待ち受ける HTTP の proxy。loopback への要求（絶対形の HTTP と CONNECT）だけを転送し、それ以外は外へつながずに
//   403 で拒み、宛先（host と port）を記録する。インターネットへは出さない。TLS は中で終えない（証明書や秘密鍵を使わない）。
// - Chromium には、`--proxy-server`（この中継）と、DNS を外へ出さない `--host-resolver-rules`（loopback の名前だけを解決する）の
//   両方を渡す（`recordingChromiumArgs`）。これらはテストの中だけで足す起動の引数で、製品の起動の設定（`src/browser/chromium-launch.ts`）
//   には入れない。
// - Chromium は、proxy の設定があっても、loopback（127.0.0.1、localhost）へは proxy を通さずに直接つなぐ（既定の除外）。fixture への
//   要求は中継を通らないことが多いが、通った場合も転送するので、ページの読み込みは変わらない。
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { LOOPBACK_HOSTNAMES } from '../../src/crawl/normalize-url.js';
import { startLoopbackHttpServer } from './loopback-server.js';

/** 中継が待ち受ける loopback のアドレス。 */
const RECORDER_HOST = '127.0.0.1';
/** 拒むときの HTTP の status。 */
const STATUS_FORBIDDEN = 403;
/** 転送に失敗したときの HTTP の status。 */
const STATUS_BAD_GATEWAY = 502;
/** `http:` の既定のポート。 */
const DEFAULT_HTTP_PORT = 80;
/** CONNECT を拒む応答（外へはつながない）。 */
const CONNECT_FORBIDDEN_RESPONSE = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
/** CONNECT を受けた応答（loopback へのトンネルだけ）。 */
const CONNECT_ESTABLISHED_RESPONSE = 'HTTP/1.1 200 Connection Established\r\n\r\n';

/**
 * DNS の問い合わせを外へ出さない Chromium の起動の引数（loopback の名前のほかは「見つからない」にする）。テストの中だけで使う。
 * proxy を通る要求の名前は中継が受けるので、この規則は、proxy を通らない名前解決（先回りの解決など）を外へ出さないためのもの。
 */
export const RECORDING_HOST_RESOLVER_RULES_ARG = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';

/** 中継が拒んで記録した 1 件の接続の試み。`kind` は、CONNECT（トンネル）か、絶対形の HTTP の要求か。 */
export interface RecordedEgressAttempt {
  readonly kind: 'CONNECT' | 'HTTP';
  /** 宛先の host（URL の hostname の形。IPv6 は `[...]`）。 */
  readonly host: string;
  readonly port: number;
}

export interface ChromiumEgressRecorder {
  /** `--proxy-server` に渡す値（`http://127.0.0.1:<port>`）。 */
  readonly server: string;
  /** これまでに拒んで記録した、loopback でない宛先への試み（写し）。 */
  attempts(): RecordedEgressAttempt[];
  close(): Promise<void>;
}

/** 中継を使う Chromium の起動の引数（`--proxy-server` と、DNS を外へ出さない規則）。テストの中だけで足す。 */
export function recordingChromiumArgs(recorder: ChromiumEgressRecorder): readonly string[] {
  return Object.freeze([`--proxy-server=${recorder.server}`, RECORDING_HOST_RESOLVER_RULES_ARG]);
}

/** 試みを `host:port` の形にする（記録の比べと、失敗の表示に使う）。 */
export function egressAttemptAuthority(attempt: RecordedEgressAttempt): string {
  return `${attempt.host}:${attempt.port}`;
}

const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTNAMES.includes(host);

/** CONNECT の宛先（`host:port`）を分ける。形が違えば null。 */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const separator = authority.lastIndexOf(':');
  if (separator <= 0) {
    return null;
  }
  const port = Number(authority.slice(separator + 1));
  if (!Number.isSafeInteger(port)) {
    return null;
  }
  return { host: authority.slice(0, separator), port };
}

/** 記録用の中継を 127.0.0.1 の空いたポートで起動する。 */
export async function startChromiumEgressRecorder(): Promise<ChromiumEgressRecorder> {
  const recorded: RecordedEgressAttempt[] = [];
  const sockets = new Set<Duplex>();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let target: URL | null = null;
    try {
      target = new URL(request.url ?? '');
    } catch {
      target = null;
    }
    if (target !== null && isLoopbackHost(target.hostname)) {
      const upstream = httpRequest({
        host: target.hostname,
        port: target.port === '' ? DEFAULT_HTTP_PORT : Number(target.port),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: request.headers,
        agent: false,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? STATUS_BAD_GATEWAY, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(STATUS_BAD_GATEWAY);
        }
        response.end();
      });
      request.pipe(upstream);
      return;
    }
    if (target !== null) {
      recorded.push({
        kind: 'HTTP',
        host: target.hostname,
        port: target.port === '' ? DEFAULT_HTTP_PORT : Number(target.port),
      });
    }
    response.writeHead(STATUS_FORBIDDEN, { connection: 'close', 'content-length': '0' });
    response.end();
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });

  server.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    const authority = parseAuthority(request.url ?? '');
    if (authority !== null && isLoopbackHost(authority.host)) {
      const upstream = netConnect({ host: RECORDER_HOST, port: authority.port }, () => {
        socket.write(CONNECT_ESTABLISHED_RESPONSE);
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      return;
    }
    if (authority !== null) {
      recorded.push({ kind: 'CONNECT', host: authority.host, port: authority.port });
    }
    socket.end(CONNECT_FORBIDDEN_RESPONSE);
  });

  await new Promise<void>((resolve) => server.listen({ host: RECORDER_HOST, port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server: `http://${RECORDER_HOST}:${port}`,
    attempts: () => [...recorded],
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 問い合わせのフォームの fixture のパス。 */
export const CONTACT_FORM_FIXTURE_PATHS = Object.freeze({
  /** 住所や連絡先の欄（`autocomplete` の指定つき）を持つフォームの画面（GET）。 */
  contactForm: '/contact-form',
  /** フォームのない画面（GET）。 */
  plain: '/plain',
  /** 「Google でログイン」のボタン（`accounts.google.com` の script、iframe、リンク）を持つ画面（GET）。 */
  googleSignIn: '/google-sign-in',
} as const);

/**
 * 「Google でログイン」の画面が読み込む、Google のアカウントの宛先の host。中継が拒むので、どこへも接続しない（DNS も、中継と規則で
 * 外へ出ない）。
 */
export const GOOGLE_SIGN_IN_FIXTURE_HOST = 'accounts.google.com';

/** fixture の応答の status。 */
const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;

/**
 * 問い合わせのフォームの画面。Chromium の autofill が、欄の種類を推して Google に問い合わせる形（名前、メール、電話、住所の欄。
 * DEF-070-research で、この形の画面を開くと、CLI の起動の設定の Chromium が `content-autofill.googleapis.com` へ接続を試みた）。
 */
const CONTACT_FORM_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>contact</title>'
  + '<link rel="icon" href="data:,"></head><body><h1>Contact</h1><form action="/contact-submit" method="post">'
  + '<label>Name <input name="name" autocomplete="name"></label>'
  + '<label>Email <input type="email" name="email" autocomplete="email"></label>'
  + '<label>Phone <input type="tel" name="tel" autocomplete="tel"></label>'
  + '<label>Address <input name="address" autocomplete="street-address"></label>'
  + '<label>City <input name="city" autocomplete="address-level2"></label>'
  + '<label>Postal <input name="zip" autocomplete="postal-code"></label>'
  + '<label>Message <textarea name="message"></textarea></label>'
  + '<button type="submit">Send</button></form></body></html>';

/**
 * 「Google でログイン」のボタンを持つ画面（DEF-070。`--gaia-url` の向け先を変えても、ページが読み込む `accounts.google.com` の要求と
 * 監査の Evidence が変わらないことを確かめる）。Google の Identity Services の形（script と、ボタンの iframe）と、ふつうのリンク。
 */
const GOOGLE_SIGN_IN_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>sign in</title>'
  + '<link rel="icon" href="data:,">'
  + `<script src="https://${GOOGLE_SIGN_IN_FIXTURE_HOST}/gsi/client" async></script></head><body><h1>Sign in</h1>`
  + `<p><a id="google-sign-in-link" href="https://${GOOGLE_SIGN_IN_FIXTURE_HOST}/o/oauth2/v2/auth?client_id=fixture">Google でログイン</a></p>`
  + `<iframe id="google-sign-in-button" title="Google でログイン" src="https://${GOOGLE_SIGN_IN_FIXTURE_HOST}/gsi/button?client_id=fixture"`
  + ' width="300" height="60"></iframe></body></html>';

/** フォームのない画面。 */
const PLAIN_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>plain</title>'
  + '<link rel="icon" href="data:,"></head><body><h1>Plain</h1><p>No form.</p></body></html>';

export interface ContactFormFixtureServer {
  readonly origin: string;
  /** 届いた要求（`METHOD path`。届いた順の写し）。 */
  requests(): string[];
  close(): Promise<void>;
}

/** 問い合わせのフォームの fixture のサーバを、127.0.0.1 の空いたポートで起動する。 */
export async function startContactFormFixtureServer(): Promise<ContactFormFixtureServer> {
  const requests: string[] = [];
  const pages: ReadonlyMap<string, string> = new Map([
    [CONTACT_FORM_FIXTURE_PATHS.contactForm, CONTACT_FORM_HTML],
    [CONTACT_FORM_FIXTURE_PATHS.plain, PLAIN_HTML],
    [CONTACT_FORM_FIXTURE_PATHS.googleSignIn, GOOGLE_SIGN_IN_HTML],
  ]);
  const server = await startLoopbackHttpServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    requests.push(`${request.method ?? ''} ${path}`);
    const body = request.method === 'GET' ? pages.get(path) : undefined;
    if (body === undefined) {
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  });
  return {
    origin: server.origin,
    requests: () => [...requests],
    close: () => server.close(),
  };
}
