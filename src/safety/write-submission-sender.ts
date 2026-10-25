/**
 * 書き込みの送信の送り手（DEF-099 fix。Task 30 の設計書 11 章の DEF-099 の行。owner）。書き込みの段の承認の POST を、ブラウザの通信の層ではなく
 * BeakSight が 1 回だけ送る（Chromium は、応答の 1 バイトも返さずに接続が切れると POST を自動で送り直すため。DEF-099 の調査）。呼ぶのは Guard の
 * 書き込みの段と、AS-c fix round 1（I-1）から監査の段の送信の扱いのほかの Origin への CORS の事前確認（`PREFLIGHT`）だけ（`passive-request-guard.ts`。
 * Gate `write-stage-boundary` の (e)(f)）。
 *
 * - 中継（egress proxy）を通して送る。接続するのは引数の中継（`proxy`）だけ（直接の接続はしない）。http は absolute-form の要求、https は
 *   中継への `CONNECT` の上で TLS を張る。再試行しない。redirect を追わない（30x はそのまま返す）。
 * - TLS の証明書は、Node の同梱の証明書と OS の証明書の置き場所（`tls.getCACertificates('bundled' | 'system')`）で確かめる。確かめを切る設定は
 *   持たない（テストだけ、信頼する証明書を足せる: `additionalTrustedCertificates`）。確かめに失敗したら、要求の bytes を書く前なので `NOT_WRITTEN`。
 * - 結果（`WriteSubmissionOutcome`）: 書く前の失敗（要求の形、中継に接続できない、中継がトンネルを拒む、TLS の確かめ、書く前の時間切れ）は
 *   `NOT_WRITTEN`。書いた後に、応答がない・切れた・時間切れ・応答が上限を超える・読めない は `NO_RESPONSE`。応答の status とヘッダを受けたら
 *   `RESPONDED`（status、ヘッダ、展開した本文。本文の途中で切れた・時間切れでも、受けたところまでの本文で `RESPONDED`）。中継に要求の bytes を書き始めた時点で「書いた」とする（中継の先に届いたかは分からないので、分からない側に倒す）。
 * - ヘッダ: 呼び出し側（一時停止の要求）のヘッダをそのまま使い、通信の層の値を付け直す（`WRITE_SUBMISSION_ADDED_HEADER_NAMES`）: Host、
 *   Content-Length、`Connection: close`、`Accept-Encoding`（展開できる形だけ）、同じ Origin のトップのナビゲーションのフォームの送信の閉じた値
 *   （`Sec-Fetch-Site`・`Sec-Fetch-Mode`・`Sec-Fetch-Dest`・`Sec-Fetch-User`。`Origin` が送信先の Origin と違えば `Sec-Fetch-Site: cross-site`）、
 *   `Accept-Language`（Context の locale。呼び出し側にあればそのまま）。ホップごとのヘッダと中継のヘッダは送らない。T39c: API のシナリオの書き込み
 *   （`requestKind: 'FETCH'`）は、ページのスクリプトの fetch の閉じた値（`Sec-Fetch-Mode: cors`・`Sec-Fetch-Dest: empty`、`Sec-Fetch-User` なし）で、
 *   `POST` と `PATCH` を送る（`WRITE_SUBMISSION_REQUEST_KINDS`）。`Authorization` などのヘッダは一時停止の要求のまま送り、記録しない。
 * - 応答: gzip・deflate・br を展開して返す（`Content-Encoding` と `Content-Length` と、ホップごとのヘッダを残さない。展開できない形は、そのままの
 *   本文で `Content-Encoding` を外す）。Set-Cookie などの重なるヘッダは、受けた順に保つ。本文と展開の上限は `WRITE_SUBMISSION_MAX_RESPONSE_BYTES`。
 * - HTTP/1.1 の要求の bytes は自分で書き、応答は自分で読む（`HttpResponseReader`。status の行、ヘッダ、`Content-Length`・`chunked`・接続の閉じで
 *   区切る本文、1xx の読み飛ばし）。Node の `http` の要求の部品に、つないだ後の接続を渡すと、応答の後に届いた bytes で Node の中の確かめが落ちる
 *   ことがあったため（DEF-099 fix の確かめで見た）。
 * - 止める口（`signal`。DEF-099 fix round 1）: 止めたら接続を切り、書く前なら `NOT_WRITTEN`、書いた後なら `NO_RESPONSE`（`ABORTED`）。
 * - 値（本文、Cookie、CSRF のトークン）を記録しない。結果は閉じた一覧の語と、応答の中身だけ（呼び出し側がブラウザに返す）。例外を投げない。
 */
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, getCACertificates, type TLSSocket } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { API_WRITE_METHODS } from '../core/api-request-shape.js';
import { SUBMISSION_POST_METHOD as FORM_SUBMISSION_METHOD, hasAllowedOrigin } from './request-policy.js';

/** 送ってから応答を受け終わるまでの上限（ms。中継への接続から数える。自動ログインの結果を待つ時間と同じ 30 秒）。 */
export const WRITE_SUBMISSION_TIMEOUT_MS = 30_000;
/** 応答の本文の上限（bytes。受けた bytes と、展開した bytes のそれぞれ）。 */
export const WRITE_SUBMISSION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** 中継の `CONNECT` の応答のヘッダの上限（bytes）。 */
const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;
/** 応答のヘッダの塊の上限（bytes。status の行を含む）。 */
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
/** `chunked` の大きさの行の上限（bytes）。 */
const MAX_CHUNK_SIZE_LINE_BYTES = 1024;

/** 書く前の失敗の理由（閉じた一覧）。 */
export const WRITE_SUBMISSION_NOT_WRITTEN_REASONS = Object.freeze([
  'REQUEST_INVALID',
  'PROXY_UNAVAILABLE',
  'PROXY_REJECTED',
  'TLS_FAILED',
  'TIMED_OUT',
  'ABORTED',
] as const);
export type WriteSubmissionNotWrittenReason = (typeof WRITE_SUBMISSION_NOT_WRITTEN_REASONS)[number];

/** 書いた後に応答がない理由（閉じた一覧）。 */
export const WRITE_SUBMISSION_NO_RESPONSE_REASONS = Object.freeze([
  'CONNECTION_CLOSED',
  'TIMED_OUT',
  'RESPONSE_TOO_LARGE',
  'RESPONSE_UNREADABLE',
  'ABORTED',
] as const);
export type WriteSubmissionNoResponseReason = (typeof WRITE_SUBMISSION_NO_RESPONSE_REASONS)[number];

/** 応答のヘッダ 1 つ（受けた順。重なるヘッダはそれぞれ 1 つ）。 */
export interface WriteSubmissionHeader {
  readonly name: string;
  readonly value: string;
}

export type WriteSubmissionOutcome =
  | {
    readonly kind: 'RESPONDED';
    readonly status: number;
    readonly headers: readonly WriteSubmissionHeader[];
    readonly body: Buffer;
    /** 本文を展開できたか（展開が要らない場合を含む）。偽なら、受けたままの本文。 */
    readonly decoded: boolean;
  }
  | { readonly kind: 'NOT_WRITTEN'; readonly reason: WriteSubmissionNotWrittenReason }
  | { readonly kind: 'NO_RESPONSE'; readonly reason: WriteSubmissionNoResponseReason };

/**
 * 送る要求の形の閉じた一覧（T39c。Task 39 の設計書 3.4）。
 * - `FORM_NAVIGATION`: 同じ Origin のトップのナビゲーションのフォームの送信（Task 30〜32 の form の書き込み）。`POST` だけ。`Sec-Fetch-Mode: navigate`・
 *   `Sec-Fetch-Dest: document`・`Sec-Fetch-User: ?1`。
 * - `FETCH`: ページのスクリプトの fetch（API のシナリオの書き込み）。`POST`・`PATCH`（`API_WRITE_METHODS`。書かれたままの形）。`Sec-Fetch-Mode: cors`・
 *   `Sec-Fetch-Dest: empty`、`Sec-Fetch-User` を付けない。
 * - `PREFLIGHT`（AS-c fix round 1 の I-1。監査の段の送信の扱いの設計書 5 章の「AS-c fix round 1 の Blocker」の行）: CORS の事前確認。`OPTIONS` だけで、
 *   本文は空。`Sec-Fetch-Mode: cors`・`Sec-Fetch-Dest: empty`、`Sec-Fetch-User` を付けない。資格情報を付けないため、一時停止の要求のヘッダのうち、事前確認の
 *   ヘッダ（`PREFLIGHT_REQUEST_HEADER_NAMES`）だけを送る（`Cookie`・`Authorization` などは送らない）。
 * どれも `Sec-Fetch-Site` は、`Origin` が送信先の Origin と同じなら `same-origin`、違えば `cross-site`（同じサイトの別の Origin の `same-site` は
 * 見分けない限界）。
 */
export const WRITE_SUBMISSION_REQUEST_KINDS = Object.freeze(['FORM_NAVIGATION', 'FETCH', 'PREFLIGHT'] as const);

/** AS-c fix round 1（I-1）: 事前確認で送る、一時停止の要求のヘッダ（小文字で比べる。資格情報のヘッダは含めない）。 */
export const PREFLIGHT_REQUEST_HEADER_NAMES = Object.freeze([
  'origin',
  'access-control-request-method',
  'access-control-request-headers',
  'access-control-request-private-network',
  'accept',
  'user-agent',
  'referer',
  'accept-language',
] as const);

/** AS-c fix round 1（I-1）: 事前確認の method。 */
export const PREFLIGHT_METHOD = 'OPTIONS';
export type WriteSubmissionRequestKind = (typeof WRITE_SUBMISSION_REQUEST_KINDS)[number];

/** 送る要求（Guard が照合した、同じ本文の bytes）。 */
export interface WriteSubmissionRequest {
  readonly url: string;
  readonly method: string;
  /** 一時停止の要求のヘッダ（名前と値）。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  /** 要求の形（T39c。省略は `FORM_NAVIGATION`。今までの呼び出しのまま）。 */
  readonly requestKind?: WriteSubmissionRequestKind | undefined;
}

/** 送り手の指定。 */
export interface WriteSubmissionOptions {
  /** 中継（egress proxy）の待ち受け。送り手は、ここにだけ接続する。 */
  readonly proxy: { readonly host: string; readonly port: number };
  /** `Accept-Language` の値（Context の locale）。null なら付けない。 */
  readonly acceptLanguage: string | null;
  /** 上限（ms。省略すると `WRITE_SUBMISSION_TIMEOUT_MS`）。 */
  readonly timeoutMs?: number | undefined;
  /** テストだけ: 信頼する証明書を足す（PEM）。確かめは切らない。 */
  readonly additionalTrustedCertificates?: readonly string[] | undefined;
  /**
   * 止める口（DEF-099 fix round 1。Guard が閉じるときに止める）。止めたら、接続を切って終える: 書く前なら `NOT_WRITTEN`、書いた後なら `NO_RESPONSE`
   * （どちらも `ABORTED`）。始める前に止めてあれば、接続しない。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 送り手の経過の受け口（DEF-100 fix。サイトへの負荷の制御の手順書 `doc/spec/site-load.md`）。
 * - `onRequestWriteStart`: 要求の bytes を書き始める直前に、同期で 1 回だけ呼ぶ（書かずに終わった場合は呼ばない）。Guard は、ここで、読み込みの
 *   間隔の起点（main frame の文書の要求を送った時刻）を記録する。送った時刻は、受け口の側の時計で読む（送り手は時刻を返さない。時計を 2 つに
 *   しない）。例外は無視する（送る処理と結果を変えない）。
 */
export interface WriteSubmissionObserver {
  readonly onRequestWriteStart?: (() => void) | undefined;
}

/** 送り手が付け直すヘッダ（手順書と報告に使う。ブラウザが通信の層で付ける値の代わり）。 */
export const WRITE_SUBMISSION_ADDED_HEADER_NAMES = Object.freeze([
  'Host',
  'Content-Length',
  'Connection',
  'Accept-Encoding',
  'Accept-Language',
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Dest',
  'Sec-Fetch-User',
] as const);

/** 送り手が展開できる `Accept-Encoding`。 */
const ACCEPT_ENCODING = 'gzip, deflate, br';
/** 同じ Origin のトップのナビゲーションのフォームの送信の、`Sec-Fetch-*` の閉じた値。 */
const SEC_FETCH_SAME_ORIGIN = 'same-origin';
const SEC_FETCH_CROSS_SITE = 'cross-site';
/** 要求の形ごとの `Sec-Fetch-Mode`・`Sec-Fetch-Dest`・`Sec-Fetch-User`（null は付けない）と、送ってよい method（T39c）。 */
const REQUEST_KIND_SHAPES: Readonly<Record<WriteSubmissionRequestKind, {
  readonly mode: string;
  readonly dest: string;
  readonly user: string | null;
  readonly methods: readonly string[];
}>> = Object.freeze({
  FORM_NAVIGATION: Object.freeze({ mode: 'navigate', dest: 'document', user: '?1', methods: Object.freeze([FORM_SUBMISSION_METHOD]) }),
  FETCH: Object.freeze({ mode: 'cors', dest: 'empty', user: null, methods: API_WRITE_METHODS }),
  PREFLIGHT: Object.freeze({ mode: 'cors', dest: 'empty', user: null, methods: Object.freeze([PREFLIGHT_METHOD]) }),
});

/** 送らないヘッダ（小文字。ホップごと、中継、送り手が付け直すもの）。 */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'content-length', 'accept-encoding', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
]);
/** ブラウザに返さない応答のヘッダ（小文字）。 */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length',
]);

const HTTP_PROTOCOL = 'http:';
const HTTPS_PROTOCOL = 'https:';
const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({ [HTTP_PROTOCOL]: 80, [HTTPS_PROTOCOL]: 443 });
const CONNECT_ESTABLISHED_STATUS = /^HTTP\/1\.[01] 2\d\d(?: |\r)/u;
const HEADER_END = '\r\n\r\n';

/** 送る要求のヘッダ（ファイルの先頭の説明）。 */
function submissionHeadersOf(request: WriteSubmissionRequest, url: URL, acceptLanguage: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  let origin: string | undefined;
  let hasAcceptLanguage = false;
  const preflight = requestKindOf(request) === 'PREFLIGHT';
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string' || DROPPED_REQUEST_HEADERS.has(lower)) {
      continue;
    }
    // AS-c fix round 1（I-1）: 事前確認は、事前確認のヘッダだけを送る（資格情報を付けない）。
    if (preflight && !(PREFLIGHT_REQUEST_HEADER_NAMES as readonly string[]).includes(lower)) {
      continue;
    }
    if (lower === 'origin') {
      origin = value;
    }
    if (lower === 'accept-language') {
      hasAcceptLanguage = true;
    }
    headers[name] = value;
  }
  headers['Host'] = url.host;
  // 事前確認は本文を持たないので、`Content-Length` を付けない（ブラウザの事前確認と同じ形）。
  if (!preflight) {
    headers['Content-Length'] = String(request.body.length);
  }
  headers['Connection'] = 'close';
  headers['Accept-Encoding'] = ACCEPT_ENCODING;
  if (!hasAcceptLanguage && acceptLanguage !== null && acceptLanguage.length > 0) {
    headers['Accept-Language'] = acceptLanguage;
  }
  // Origin の比べは、要求の判定の owner の許可 Origin の判定（`hasAllowedOrigin`。同じ正規化）を、`Origin` の 1 つだけの集合で使う。
  headers['Sec-Fetch-Site'] = origin === undefined || hasAllowedOrigin(url.href, new Set([origin])) ? SEC_FETCH_SAME_ORIGIN : SEC_FETCH_CROSS_SITE;
  // T39c: 要求の形ごとの閉じた値（fetch の形は `Sec-Fetch-User` を付けない）。
  const shape = REQUEST_KIND_SHAPES[requestKindOf(request)];
  headers['Sec-Fetch-Mode'] = shape.mode;
  headers['Sec-Fetch-Dest'] = shape.dest;
  if (shape.user !== null) {
    headers['Sec-Fetch-User'] = shape.user;
  }
  return headers;
}

/** 要求の形（省略は `FORM_NAVIGATION`。閉じた一覧の外の値は、送る前の確かめで `REQUEST_INVALID` になる）。 */
const requestKindOf = (request: WriteSubmissionRequest): WriteSubmissionRequestKind =>
  request.requestKind ?? 'FORM_NAVIGATION';

/** 応答の本文を展開する（`Content-Encoding` の逆順）。展開できなければ null。 */
function decodedBodyOf(body: Buffer, contentEncoding: string | undefined): Buffer | null {
  if (contentEncoding === undefined) {
    return body;
  }
  const options = { maxOutputLength: WRITE_SUBMISSION_MAX_RESPONSE_BYTES };
  let current = body;
  const codings = contentEncoding.split(',').map((coding) => coding.trim().toLowerCase()).filter((coding) => coding.length > 0).reverse();
  try {
    for (const coding of codings) {
      if (coding === 'gzip' || coding === 'x-gzip') {
        current = gunzipSync(current, options);
      } else if (coding === 'deflate') {
        try {
          current = inflateSync(current, options);
        } catch {
          current = inflateRawSync(current, options);
        }
      } else if (coding === 'br') {
        current = brotliDecompressSync(current, options);
      } else if (coding !== 'identity') {
        return null;
      }
    }
  } catch {
    return null;
  }
  return current;
}

/** 応答のヘッダ（受けた順。返さないヘッダを除く）。 */
const responseHeadersOf = (rawHeaders: readonly string[]): readonly WriteSubmissionHeader[] => {
  const headers: WriteSubmissionHeader[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? '';
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.push(Object.freeze({ name, value: rawHeaders[index + 1] ?? '' }));
    }
  }
  return Object.freeze(headers);
};


/** 応答の本文の区切り方。 */
type BodyFraming =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'LENGTH'; remaining: number }
  | { readonly kind: 'CHUNKED'; state: 'SIZE' | 'DATA' | 'DATA_END' | 'TRAILER'; remaining: number }
  | { readonly kind: 'CLOSE' };

/** 応答の status の行（`HTTP/1.x NNN 理由`）。 */
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/u;
const CRLF = '\r\n';
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_NOT_MODIFIED = 304;
const INFORMATIONAL_STATUS_MAX = 199;

/**
 * HTTP/1.1 の応答を読む（DEF-099 fix。1 回の要求の応答だけ）。status の行とヘッダ（受けた順。重なるヘッダを保つ）、本文（`Content-Length`、
 * `chunked`、接続の閉じで区切る。204・304 は本文なし）。1xx は読み飛ばす。形が読めなければ `unreadable`、上限を超えたら `tooLarge`。
 */
class HttpResponseReader {
  #buffer: Buffer = Buffer.alloc(0);
  #status: number | null = null;
  #rawHeaders: string[] = [];
  #framing: BodyFraming | null = null;
  readonly #body: Buffer[] = [];
  #bodySize = 0;
  #complete = false;
  #unreadable = false;
  #tooLarge = false;

  get status(): number | null {
    return this.#status;
  }

  get complete(): boolean {
    return this.#complete;
  }

  get failed(): 'RESPONSE_UNREADABLE' | 'RESPONSE_TOO_LARGE' | null {
    return this.#tooLarge ? 'RESPONSE_TOO_LARGE' : this.#unreadable ? 'RESPONSE_UNREADABLE' : null;
  }

  get rawHeaders(): readonly string[] {
    return this.#rawHeaders;
  }

  /** 受けたところまでの本文。 */
  body(): Buffer {
    return Buffer.concat(this.#body);
  }

  /** 受けた bytes を足す。 */
  push(chunk: Buffer): void {
    if (this.#complete || this.failed !== null) {
      return;
    }
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#advance();
  }

  /** 接続が閉じた（接続の閉じで区切る本文は、ここで終わる）。 */
  end(): void {
    if (this.#framing?.kind === 'CLOSE') {
      this.#complete = true;
    }
  }

  #advance(): void {
    for (;;) {
      if (this.#complete || this.failed !== null) {
        return;
      }
      if (this.#framing === null) {
        if (!this.#readHead()) {
          return;
        }
        continue;
      }
      if (!this.#readBody(this.#framing)) {
        return;
      }
    }
  }

  /** ヘッダの塊を読む。読めたら真（1xx なら読み飛ばして、次の塊を待つ）。 */
  #readHead(): boolean {
    const end = this.#buffer.indexOf('\r\n\r\n', 0, 'latin1');
    if (end < 0) {
      if (this.#buffer.length > MAX_RESPONSE_HEADER_BYTES) {
        this.#unreadable = true;
      }
      return false;
    }
    const lines = this.#buffer.subarray(0, end).toString('latin1').split(CRLF);
    this.#buffer = this.#buffer.subarray(end + 4);
    const match = STATUS_LINE.exec(lines[0] ?? '');
    if (match === null) {
      this.#unreadable = true;
      return false;
    }
    const status = Number(match[1]);
    const rawHeaders: string[] = [];
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) {
        this.#unreadable = true;
        return false;
      }
      rawHeaders.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    if (status <= INFORMATIONAL_STATUS_MAX) {
      return true;
    }
    this.#status = status;
    this.#rawHeaders = rawHeaders;
    const headerValues = (name: string): readonly string[] =>
      rawHeaders.flatMap((value, index) => (index % 2 === 0 && value.toLowerCase() === name ? [rawHeaders[index + 1] ?? ''] : []));
    const transferEncoding = headerValues('transfer-encoding').join(',').toLowerCase();
    const contentLength = headerValues('content-length');
    if (status === HTTP_STATUS_NO_CONTENT || status === HTTP_STATUS_NOT_MODIFIED) {
      this.#framing = { kind: 'NONE' };
    } else if (transferEncoding.split(',').map((coding) => coding.trim()).includes('chunked')) {
      this.#framing = { kind: 'CHUNKED', state: 'SIZE', remaining: 0 };
    } else if (contentLength.length > 0) {
      const lengths = new Set(contentLength.flatMap((value) => value.split(',').map((part) => part.trim())));
      const [only, ...others] = [...lengths];
      if (only === undefined || others.length > 0 || !/^\d+$/u.test(only)) {
        this.#unreadable = true;
        return false;
      }
      this.#framing = { kind: 'LENGTH', remaining: Number(only) };
    } else {
      this.#framing = { kind: 'CLOSE' };
    }
    return true;
  }

  /** 本文を足す（上限を超えたら `tooLarge`）。 */
  #append(data: Buffer): void {
    this.#bodySize += data.length;
    if (this.#bodySize > WRITE_SUBMISSION_MAX_RESPONSE_BYTES) {
      this.#tooLarge = true;
      return;
    }
    this.#body.push(data);
  }

  /** 本文を読み進める。もっと bytes が要るなら偽。 */
  #readBody(framing: BodyFraming): boolean {
    switch (framing.kind) {
      case 'NONE':
        this.#complete = true;
        return true;
      case 'CLOSE':
        if (this.#buffer.length > 0) {
          this.#append(this.#buffer);
          this.#buffer = Buffer.alloc(0);
        }
        return false;
      case 'LENGTH': {
        const take = Math.min(framing.remaining, this.#buffer.length);
        if (take > 0) {
          this.#append(this.#buffer.subarray(0, take));
          this.#buffer = this.#buffer.subarray(take);
          framing.remaining -= take;
        }
        if (framing.remaining === 0) {
          this.#complete = true;
          return true;
        }
        return false;
      }
      case 'CHUNKED':
        return this.#readChunk(framing);
    }
  }

  /** `chunked` の 1 段を読む。もっと bytes が要るなら偽。 */
  #readChunk(framing: Extract<BodyFraming, { kind: 'CHUNKED' }>): boolean {
    if (framing.state === 'DATA') {
      const take = Math.min(framing.remaining, this.#buffer.length);
      if (take > 0) {
        this.#append(this.#buffer.subarray(0, take));
        this.#buffer = this.#buffer.subarray(take);
        framing.remaining -= take;
      }
      if (framing.remaining > 0) {
        return false;
      }
      framing.state = 'DATA_END';
      return true;
    }
    const lineEnd = this.#buffer.indexOf(CRLF, 0, 'latin1');
    if (lineEnd < 0) {
      if (this.#buffer.length > MAX_CHUNK_SIZE_LINE_BYTES) {
        this.#unreadable = true;
      }
      return false;
    }
    const line = this.#buffer.subarray(0, lineEnd).toString('latin1');
    this.#buffer = this.#buffer.subarray(lineEnd + 2);
    if (framing.state === 'DATA_END') {
      if (line.length > 0) {
        this.#unreadable = true;
        return false;
      }
      framing.state = 'SIZE';
      return true;
    }
    if (framing.state === 'TRAILER') {
      if (line.length === 0) {
        this.#complete = true;
      }
      return true;
    }
    const size = /^([0-9a-fA-F]+)(?:;.*)?$/u.exec(line.trim());
    if (size === null || (size[1] ?? '').length > 8) {
      this.#unreadable = true;
      return false;
    }
    const value = Number.parseInt(size[1] ?? '', 16);
    if (value === 0) {
      framing.state = 'TRAILER';
      return true;
    }
    framing.remaining = value;
    framing.state = 'DATA';
    return true;
  }
}

/** 要求の bytes（要求の行、ヘッダ、本文）。CR・LF を含むヘッダは送らない。 */
const requestBytesOf = (method: string, target: string, headers: Readonly<Record<string, string>>, body: Buffer): Buffer => {
  const lines = [`${method} ${target} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (!/[\r\n]/u.test(name) && !/[\r\n]/u.test(value)) {
      lines.push(`${name}: ${value}`);
    }
  }
  return Buffer.concat([Buffer.from(`${lines.join(CRLF)}${CRLF}${CRLF}`, 'latin1'), body]);
};

/** 読んだ応答の結果（status、返すヘッダ、展開した本文。受けたところまで）。 */
const responseOutcomeOf = (reader: HttpResponseReader): WriteSubmissionOutcome => {
  const raw = reader.body();
  const rawHeaders = reader.rawHeaders;
  const encodings = rawHeaders.flatMap((value, index) => (index % 2 === 0 && value.toLowerCase() === 'content-encoding' ? [rawHeaders[index + 1] ?? ''] : []));
  const decoded = decodedBodyOf(raw, encodings.length === 0 ? undefined : encodings.join(','));
  return { kind: 'RESPONDED', status: reader.status ?? 0, headers: responseHeadersOf(rawHeaders), body: decoded ?? raw, decoded: decoded !== null };
};

/** 信頼する証明書（Node の同梱、OS の置き場所、テストだけ足すもの）。 */
const trustedCertificatesOf = (additional: readonly string[] | undefined): string[] =>
  [...getCACertificates('bundled'), ...getCACertificates('system'), ...(additional ?? [])];

/**
 * 書き込みの POST を、中継を通して 1 回だけ送る（ファイルの先頭の説明）。例外を投げない。
 */
export function sendWriteSubmissionOnce(
  request: WriteSubmissionRequest,
  options: WriteSubmissionOptions,
  observer: WriteSubmissionObserver = {},
): Promise<WriteSubmissionOutcome> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Promise.resolve(Object.freeze({ kind: 'NOT_WRITTEN', reason: 'REQUEST_INVALID' }));
  }
  // T39c: method は、要求の形の閉じた一覧（form は `POST`、fetch は `POST`・`PATCH`）と書かれたままの形で一致すること。形が一覧の外なら送らない。
  const kind = requestKindOf(request);
  if ((url.protocol !== HTTP_PROTOCOL && url.protocol !== HTTPS_PROTOCOL) || !(WRITE_SUBMISSION_REQUEST_KINDS as readonly unknown[]).includes(kind)
    || !REQUEST_KIND_SHAPES[kind].methods.includes(request.method) || !Buffer.isBuffer(request.body)) {
    return Promise.resolve(Object.freeze({ kind: 'NOT_WRITTEN', reason: 'REQUEST_INVALID' }));
  }
  const tls = url.protocol === HTTPS_PROTOCOL;
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] ?? 0 : Number(url.port);
  const headers = submissionHeadersOf(request, url, options.acceptLanguage);
  const timeoutMs = options.timeoutMs ?? WRITE_SUBMISSION_TIMEOUT_MS;
  const { signal } = options;
  if (signal?.aborted === true) {
    return Promise.resolve(Object.freeze({ kind: 'NOT_WRITTEN', reason: 'ABORTED' }));
  }

  return new Promise<WriteSubmissionOutcome>((resolvePromise) => {
    let written = false;
    let settled = false;
    const resources: { destroy(): void }[] = [];
    const finish = (outcome: WriteSubmissionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const resource of resources) {
        try {
          resource.destroy();
        } catch {
          // 片付けの失敗は結果を変えない。
        }
      }
      resolvePromise(Object.freeze(outcome));
    };
    /**
     * 応答の status とヘッダを受けた後の結果（本文が終わる前に切れた・時間切れでも、サーバは応答したので `RESPONDED`。受けたところまでの本文。
     * 接続の閉じ方で区切る応答の終わりが、きれいな閉じ方でなかった場合を含む）。受ける前は null。
     */
    let responded: (() => WriteSubmissionOutcome | null) | null = null;
    const failed = (): void => finish(responded?.() ?? (written
      ? { kind: 'NO_RESPONSE', reason: 'CONNECTION_CLOSED' }
      : { kind: 'NOT_WRITTEN', reason: 'PROXY_UNAVAILABLE' }));
    const onAbort = (): void => finish(written ? { kind: 'NO_RESPONSE', reason: 'ABORTED' } : { kind: 'NOT_WRITTEN', reason: 'ABORTED' });
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(responded?.() ?? (written
      ? { kind: 'NO_RESPONSE', reason: 'TIMED_OUT' }
      : { kind: 'NOT_WRITTEN', reason: 'TIMED_OUT' })), timeoutMs);

    /** 接続（中継へのソケットか、その上の TLS）の上で要求を書き、応答を読む（`HttpResponseReader`）。 */
    const sendOver = (connection: Socket | TLSSocket, target: string): void => {
      const reader = new HttpResponseReader();
      const settleFromReader = (): boolean => {
        const failure = reader.failed;
        if (failure !== null) {
          finish({ kind: 'NO_RESPONSE', reason: failure });
          return true;
        }
        if (reader.complete) {
          finish(responseOutcomeOf(reader));
          return true;
        }
        return false;
      };
      responded = (): WriteSubmissionOutcome | null => (reader.status === null ? null : responseOutcomeOf(reader));
      connection.on('data', (chunk: Buffer) => {
        reader.push(chunk);
        settleFromReader();
      });
      connection.once('end', () => {
        reader.end();
        if (!settleFromReader()) {
          failed();
        }
      });
      connection.once('close', failed);
      // DEF-100 fix: 書き始める直前に、受け口に伝える（例外は無視する）。
      try {
        observer.onRequestWriteStart?.();
      } catch {
        // 受け口の失敗は、送る処理と結果を変えない。
      }
      written = true;
      connection.write(requestBytesOf(request.method, target, headers, request.body));
    };

    let proxySocket: Socket;
    try {
      proxySocket = netConnect({ host: options.proxy.host, port: options.proxy.port });
    } catch {
      finish({ kind: 'NOT_WRITTEN', reason: 'PROXY_UNAVAILABLE' });
      return;
    }
    resources.push(proxySocket);
    proxySocket.on('error', failed);
    proxySocket.once('connect', () => {
      if (!tls) {
        sendOver(proxySocket, url.href);
        return;
      }
      // https: 中継に CONNECT を送り、確立の応答を受けてから TLS を張る（ここまでは、要求の bytes を書いていない）。
      const authority = `${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
      let received = '';
      const onData = (chunk: Buffer): void => {
        received += chunk.toString('latin1');
        const end = received.indexOf(HEADER_END);
        if (end < 0) {
          if (received.length > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
            finish({ kind: 'NOT_WRITTEN', reason: 'PROXY_REJECTED' });
          }
          return;
        }
        proxySocket.off('data', onData);
        if (!CONNECT_ESTABLISHED_STATUS.test(received) || received.length > end + HEADER_END.length) {
          finish({ kind: 'NOT_WRITTEN', reason: 'PROXY_REJECTED' });
          return;
        }
        let secure: TLSSocket;
        try {
          secure = tlsConnect({
            socket: proxySocket,
            host: hostname,
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
            ca: trustedCertificatesOf(options.additionalTrustedCertificates),
            rejectUnauthorized: true,
            ALPNProtocols: ['http/1.1'],
          });
        } catch {
          finish({ kind: 'NOT_WRITTEN', reason: 'TLS_FAILED' });
          return;
        }
        resources.push(secure);
        secure.on('error', () => finish(responded?.() ?? (written
          ? { kind: 'NO_RESPONSE', reason: 'CONNECTION_CLOSED' }
          : { kind: 'NOT_WRITTEN', reason: 'TLS_FAILED' })));
        secure.once('secureConnect', () => {
          if (!secure.authorized) {
            finish({ kind: 'NOT_WRITTEN', reason: 'TLS_FAILED' });
            return;
          }
          sendOver(secure, `${url.pathname}${url.search}`);
        });
      };
      proxySocket.on('data', onData);
      proxySocket.once('close', () => {
        if (!written) {
          finish({ kind: 'NOT_WRITTEN', reason: 'PROXY_REJECTED' });
        }
      });
      proxySocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
  });
}
