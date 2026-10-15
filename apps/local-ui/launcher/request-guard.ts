/**
 * ローカルの管理画面のサーバの、要求の守りの部品（Task 23 設計書 4.4、11 章の T23b の発見の行。T23e）。
 * 本番の起動の部品（`serve.ts`）と、開発のサーバ（`vite-guard-plugin.ts`。Vite の middleware）の両方で、この部品を使う（唯一の owner）。
 *
 * - **Host**: `Host` が `127.0.0.1:<port>` と完全に一致しなければ 421（`localhost` も拒否。画面の正式な URL は 127.0.0.1 だけ）。
 *   要求を受けた socket の手元のアドレスが `127.0.0.1` でない場合も 421（Host の header は送る側が偽れるため。T23h）。
 *   要求の対象がパスでない（絶対形式など）、または 127.0.0.1 の外を指す場合は 400。
 * - **token と cookie**: 起動ごとの暗号的な乱数の token。`?token=` が正しければ `HttpOnly`、`SameSite=Strict`、`Path=/` の cookie に替え、
 *   token を除いた URL へ 303 で移す。cookie も token もない要求、誤った token は 401（画面・Server Function・static のすべて）。
 *   比較は時間が一定の比較（SHA-256 の値を `timingSafeEqual` で比べる。長さの違いも漏らさない）。token はログやファイルに書かない。
 * - **応答の header**: すべての応答（誤りの応答、static、中継した応答、開発のサーバの応答）に、`Cache-Control: no-store` などと CSP を付ける。
 *   後から別の値を書かれても、`writeHead` の直前に付け直す（この部品の値が勝つ）。
 * - **CSP の nonce**: 要求ごとの nonce を作り、外から来た同じ名前の header を消してから、要求の header（`CSP_NONCE_REQUEST_HEADER`）で SSR に渡す。
 * - **成果物の CSP**（Task 24 の設計書 4.5。T24f）: 成果物の Server Routes（`/artifacts/…`。`src/security/artifact-route.ts`）の応答には、
 *   画面の CSP の代わりに、script を動かさない CSP（`sandbox allow-same-origin`、`default-src 'none'`、`img-src 'self' data:`、style は
 *   SHA-256 の値で許すものだけ）を付ける。style の値は、成果物の route が内部の header（`ARTIFACT_STYLE_HASH_RESPONSE_HEADER`）で渡し、
 *   この部品が形（base64 の SHA-256）を確かめてから CSP に入れ、内部の header はブラウザへ送らない。CSP を決めるのは、この部品だけである。
 *   `sandbox` に `allow-same-origin` を付ける理由: 付けないと文書の origin が opaque になり、`SameSite=Strict` の cookie がレポートの中の
 *   相対のリンク（スクリーンショットなど）の要求に付かず、401 になる（T24f の Chromium の実験で確かめた）。`allow-scripts` は付けないので、
 *   script は動かない。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { LOCAL_UI_GUARD_REJECTION_TEXT } from '../../../src/presentation/messages.ts';
import { ARTIFACT_STYLE_HASH_RESPONSE_HEADER, isArtifactRoutePath } from '../src/security/artifact-route.ts';
import { CSP_NONCE_REQUEST_HEADER } from '../src/security/csp-nonce.ts';

/** 待ち受けるアドレス（127.0.0.1 だけ。変えられない）。 */
export const LOCAL_UI_LISTEN_HOST = '127.0.0.1';

/** 起動ごとの token の長さ（byte）。 */
export const SESSION_TOKEN_BYTES = 32;

/** CSP の nonce の長さ（byte）。 */
export const CSP_NONCE_BYTES = 16;

/** token を受け取る URL の query の名前。 */
export const TOKEN_QUERY_PARAMETER = 'token';

/** この部品が返す HTTP の状態。 */
export const HTTP_STATUS = Object.freeze({
  SEE_OTHER: 303,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  MISDIRECTED_REQUEST: 421,
} as const);

/** 守りの設定。 */
export interface LocalUiGuardOptions {
  /** 待ち受けの port（Host の確かめと cookie の名前に使う）。 */
  readonly port: number;
  /** 起動ごとの token。 */
  readonly token: string;
  /**
   * 拒否の応答の本文（`src/presentation/messages.ts` の `LOCAL_UI_GUARD_REJECTION_TEXT`）。本番の起動の部品は、ビルドした画面のサーバの
   * 入口（`launcher-bridge`）から受け取り、開発のサーバは Vite の設定から渡す（起動の部品は Node の型の除去で動き、`src/` の TypeScript を
   * 直接読めないため、値は渡してもらう）。
   */
  readonly rejectionText: RejectionText;
}

/** 拒否の応答の本文の形。 */
export type RejectionText = Readonly<Record<keyof typeof LOCAL_UI_GUARD_REJECTION_TEXT, string>>;

/** 要求の判定の入力（Node の要求から取り出した値）。 */
export interface GuardRequestInput {
  /** 要求を受けた socket の手元のアドレス（`req.socket.localAddress`。T23h）。`127.0.0.1` でなければ拒否する。 */
  readonly localAddress: string | undefined;
  readonly url: string | undefined;
  readonly host: string | undefined;
  readonly cookie: string | undefined;
}

/** 要求の判定。 */
export type GuardDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'reject'; readonly status: (typeof HTTP_STATUS)['BAD_REQUEST' | 'UNAUTHORIZED' | 'MISDIRECTED_REQUEST'] }
  | { readonly kind: 'redirect'; readonly status: (typeof HTTP_STATUS)['SEE_OTHER']; readonly location: string; readonly setCookie: string };

/** 拒否の状態から、拒否の応答の本文（`src/presentation/messages.ts` の `LOCAL_UI_GUARD_REJECTION_TEXT`）の鍵への対応。 */
const REJECTION_TEXT_KEY: Readonly<Record<(typeof HTTP_STATUS)['BAD_REQUEST' | 'UNAUTHORIZED' | 'MISDIRECTED_REQUEST'], keyof RejectionText>> =
  Object.freeze({
    [HTTP_STATUS.BAD_REQUEST]: 'BAD_REQUEST',
    [HTTP_STATUS.UNAUTHORIZED]: 'UNAUTHORIZED',
    [HTTP_STATUS.MISDIRECTED_REQUEST]: 'MISDIRECTED_REQUEST',
  });

/** 起動ごとの token を作る（base64url）。 */
export const createSessionToken = (): string => randomBytes(SESSION_TOKEN_BYTES).toString('base64url');

/** 要求ごとの CSP の nonce を作る（base64）。 */
export const createCspNonce = (): string => randomBytes(CSP_NONCE_BYTES).toString('base64');

/** port ごとの cookie の名前（同じ 127.0.0.1 のほかの port の画面のサーバと混ざらないようにする）。 */
export const sessionCookieName = (port: number): string => `beaksight_ui_${port}`;

/** コンソールに表示する URL（127.0.0.1 だけ）。 */
export const formatTokenUrl = (port: number, token: string): string =>
  `http://${LOCAL_UI_LISTEN_HOST}:${port}/?${TOKEN_QUERY_PARAMETER}=${token}`;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** token の比較（時間が一定。空の値は一致としない）。 */
export const isTokenEqual = (candidate: string, expected: string): boolean =>
  candidate.length > 0 && expected.length > 0 && timingSafeEqual(digest(candidate), digest(expected));

/**
 * CSP（要求ごとの nonce）。`'unsafe-inline'` と `'unsafe-eval'` は使わない。本番と開発のサーバで同じ。
 * 開発のサーバの Vite の HMR の websocket（同じ `127.0.0.1:<port>` の `ws:`）は、`connect-src 'self'` で繋がることを Chromium で確かめた
 * （T23e。`ws:` を足す緩めは要らなかった）。
 */
export const buildContentSecurityPolicy = (nonce: string): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

/** CSP のほかに、すべての応答に付ける header。 */
const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** すべての応答に付ける header。 */
export const securityHeaders = (nonce: string): Readonly<Record<string, string>> => ({
  ...BASE_SECURITY_HEADERS,
  'Content-Security-Policy': buildContentSecurityPolicy(nonce),
});

/** 成果物の route が `<style>` の SHA-256 を渡す内部の header の名前（`src/security/artifact-route.ts`。テストのために、ここからも公開する）。 */
export { ARTIFACT_STYLE_HASH_RESPONSE_HEADER };

/** SHA-256 の base64（32 byte。`=` を 1 つ付けた 44 文字）。 */
const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;

/**
 * 成果物の CSP（Task 24 の設計書 4.5。T24f）。script は、どの形でも許さない（`sandbox` に `allow-scripts` を付けず、`default-src 'none'`）。
 * style は、`styleHashes` のうち SHA-256 の base64 の形のものだけを、その値で許す（なければ `'none'`）。`'unsafe-inline'` と `'unsafe-eval'` は
 * 使わない。`allow-same-origin` は、レポートの中の相対のリンクに cookie を付けるため（このファイルの先頭の説明）。
 */
export const buildArtifactContentSecurityPolicy = (styleHashes: readonly string[]): string => {
  const hashes = styleHashes.filter((hash) => SHA256_BASE64_PATTERN.test(hash));
  return [
    'sandbox allow-same-origin',
    "default-src 'none'",
    "img-src 'self' data:",
    hashes.length === 0 ? "style-src 'none'" : `style-src ${hashes.map((hash) => `'sha256-${hash}'`).join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
};

/** 成果物の応答に付ける header（CSP のほかは、画面の応答と同じ）。 */
export const artifactSecurityHeaders = (styleHashes: readonly string[]): Readonly<Record<string, string>> => ({
  ...BASE_SECURITY_HEADERS,
  'Content-Security-Policy': buildArtifactContentSecurityPolicy(styleHashes),
});

/** cookie の header から、名前の一致する値の一覧を取り出す。 */
const cookieValues = (cookieHeader: string | undefined, name: string): readonly string[] =>
  (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

/** 要求を判定する（Host → 要求の対象 → token → cookie の順）。 */
export const evaluateRequest = (options: LocalUiGuardOptions, input: GuardRequestInput): GuardDecision => {
  // 127.0.0.1 以外で受けた要求（待ち受けのアドレスが変えられた場合など）は、Host の値に関係なく、Host の違いと同じ 421 で拒否する（T23h）。
  if (input.localAddress !== LOCAL_UI_LISTEN_HOST || input.host !== `${LOCAL_UI_LISTEN_HOST}:${options.port}`) {
    return { kind: 'reject', status: HTTP_STATUS.MISDIRECTED_REQUEST };
  }
  const origin = `http://${LOCAL_UI_LISTEN_HOST}:${options.port}`;
  const target = input.url;
  if (target === undefined || !target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
    return { kind: 'reject', status: HTTP_STATUS.BAD_REQUEST };
  }
  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    return { kind: 'reject', status: HTTP_STATUS.BAD_REQUEST };
  }
  if (url.origin !== origin || url.pathname.startsWith('//')) {
    return { kind: 'reject', status: HTTP_STATUS.BAD_REQUEST };
  }
  const tokens = url.searchParams.getAll(TOKEN_QUERY_PARAMETER);
  if (tokens.length > 0) {
    const [token] = tokens;
    if (tokens.length !== 1 || token === undefined || !isTokenEqual(token, options.token)) {
      return { kind: 'reject', status: HTTP_STATUS.UNAUTHORIZED };
    }
    url.searchParams.delete(TOKEN_QUERY_PARAMETER);
    const search = url.searchParams.toString();
    return {
      kind: 'redirect',
      status: HTTP_STATUS.SEE_OTHER,
      location: `${url.pathname}${search === '' ? '' : `?${search}`}`,
      setCookie: `${sessionCookieName(options.port)}=${options.token}; HttpOnly; SameSite=Strict; Path=/`,
    };
  }
  const cookies = cookieValues(input.cookie, sessionCookieName(options.port));
  if (cookies.some((value) => isTokenEqual(value, options.token))) {
    return { kind: 'allow' };
  }
  return { kind: 'reject', status: HTTP_STATUS.UNAUTHORIZED };
};

/** `writeHead` に渡された header（オブジェクト、`[名前, 値, …]`、`[[名前, 値], …]`）を、名前ごとの値にまとめる。 */
const collectHeaderArgument = (argument: unknown): ReadonlyMap<string, OutgoingHttpHeader> => {
  const collected = new Map<string, string[]>();
  const add = (name: unknown, value: unknown): void => {
    if (typeof name !== 'string' || value === undefined || value === null) {
      return;
    }
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    collected.set(name.toLowerCase(), [...(collected.get(name.toLowerCase()) ?? []), ...values]);
  };
  if (Array.isArray(argument)) {
    if (argument.every((item) => Array.isArray(item))) {
      for (const item of argument as unknown[][]) {
        add(item[0], item[1]);
      }
    } else {
      for (let index = 0; index + 1 < argument.length; index += 2) {
        add(argument[index], argument[index + 1]);
      }
    }
  } else if (typeof argument === 'object' && argument !== null) {
    for (const [name, value] of Object.entries(argument as OutgoingHttpHeaders)) {
      add(name, value);
    }
  }
  return new Map([...collected].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? '') : values]));
};

/** 応答の内部の header から、成果物の style の値を取り出して消す（ブラウザへ送らない）。 */
const takeArtifactStyleHashes = (response: ServerResponse): readonly string[] => {
  const value = response.getHeader(ARTIFACT_STYLE_HASH_RESPONSE_HEADER);
  response.removeHeader(ARTIFACT_STYLE_HASH_RESPONSE_HEADER);
  const values = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter((item) => item.length > 0);
};

/** 応答の header を、成果物の style の値（内部の header から取り出したもの）から決める関数。 */
export type ResponseHeadersFor = (artifactStyleHashes: readonly string[]) => Readonly<Record<string, string>>;

/**
 * 応答に守りの header を付ける。いま付け、さらに `writeHead` の直前に付け直す（Node の `end` だけの応答も、内部で `writeHead` を通る）。
 * `writeHead` に渡された header は先に反映し、守りの header で上書きする。成果物の style の内部の header は、どの応答からも消す。
 * `headers` が関数なら、`writeHead` の直前に、内部の header の値を渡して決める（成果物の CSP。T24f）。
 */
export const enforceResponseHeaders = (response: ServerResponse, headers: Readonly<Record<string, string>> | ResponseHeadersFor): void => {
  const headersFor: ResponseHeadersFor = typeof headers === 'function' ? headers : () => headers;
  const apply = (artifactStyleHashes: readonly string[]): void => {
    for (const [name, value] of Object.entries(headersFor(artifactStyleHashes))) {
      response.setHeader(name, value);
    }
  };
  apply([]);
  const originalWriteHead = response.writeHead.bind(response) as (statusCode: number, statusMessage?: string) => ServerResponse;
  const patched = (statusCode: number, ...rest: unknown[]): ServerResponse => {
    const statusMessage = typeof rest[0] === 'string' ? rest[0] : undefined;
    const headerArgument = statusMessage === undefined ? rest[0] : rest[1];
    if (!response.headersSent) {
      for (const [name, value] of collectHeaderArgument(headerArgument)) {
        response.setHeader(name, value);
      }
      apply(takeArtifactStyleHashes(response));
    }
    return statusMessage === undefined ? originalWriteHead(statusCode) : originalWriteHead(statusCode, statusMessage);
  };
  response.writeHead = patched as typeof response.writeHead;
};

/** 要求の header を 1 つ、外から来た値を消してから入れる（`headers` と `rawHeaders` の両方）。 */
const replaceRequestHeader = (request: IncomingMessage, name: string, value: string): void => {
  const lower = name.toLowerCase();
  const raw = request.rawHeaders;
  for (let index = raw.length - 2; index >= 0; index -= 2) {
    if ((raw[index] ?? '').toLowerCase() === lower) {
      raw.splice(index, 2);
    }
  }
  raw.push(lower, value);
  request.headers[lower] = value;
};

/**
 * 成果物の Server Routes への要求か（T24f）。画面のサーバ（`serve.ts` の中継と Vite）と同じく、URL の構文で正規化したパス（`.` と `..` の
 * 区切り、その符号化を解いたもの）で判定する。パスとして読めない要求は、成果物でない側にする（その要求は、判定で 400 になる）。
 */
const isArtifactRequest = (request: IncomingMessage): boolean => {
  try {
    return isArtifactRoutePath(new URL(request.url ?? '/', `http://${LOCAL_UI_LISTEN_HOST}`).pathname);
  } catch {
    return false;
  }
};

/** 判定の入力を Node の要求から取り出す。 */
export const guardInputOf = (request: IncomingMessage): GuardRequestInput => ({
  localAddress: request.socket.localAddress,
  url: request.url,
  host: request.headers.host,
  cookie: request.headers.cookie,
});

/**
 * Node の要求に守りを掛ける。通してよければ `true`（要求に nonce の header を入れ、応答に守りの header を付けた状態）。
 * 通さない場合は、この関数が応答（拒否か 303）を書き終えて `false` を返す。
 */
export const guardNodeRequest = (options: LocalUiGuardOptions, request: IncomingMessage, response: ServerResponse): boolean => {
  const nonce = createCspNonce();
  enforceResponseHeaders(response, isArtifactRequest(request) ? artifactSecurityHeaders : securityHeaders(nonce));
  const decision = evaluateRequest(options, guardInputOf(request));
  if (decision.kind === 'reject') {
    response.writeHead(decision.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(options.rejectionText[REJECTION_TEXT_KEY[decision.status]]);
    return false;
  }
  if (decision.kind === 'redirect') {
    response.writeHead(decision.status, { Location: decision.location, 'Set-Cookie': decision.setCookie });
    response.end();
    return false;
  }
  replaceRequestHeader(request, CSP_NONCE_REQUEST_HEADER, nonce);
  return true;
};

/** 拒否の応答の、websocket の upgrade 用の文字列（応答の header は付けない。接続を閉じる）。 */
export const upgradeRejectionResponse = (status: number): string => `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
