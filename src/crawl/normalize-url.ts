import type { LinkNormalizationEvidence, NormalizedHttpUrlEvidence, UrlRejectionReason } from '../core/evidence-types.js';
import { REDACTED } from '../core/redaction.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { compareCodeUnits } from '../core/text.js';

/** 正規化済みの http(s) URL。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type NormalizedHttpUrl = NormalizedHttpUrlEvidence;

/** URL の正規化の結果。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type NormalizedUrlResult = LinkNormalizationEvidence;

const isTrackingParameter = (name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return normalizedName.startsWith('utm_') || normalizedName === 'gclid' || normalizedName === 'fbclid';
};

const isUnreservedOctet = (octet: number): boolean =>
  (octet >= 0x41 && octet <= 0x5A)
  || (octet >= 0x61 && octet <= 0x7A)
  || (octet >= 0x30 && octet <= 0x39)
  || octet === 0x2D
  || octet === 0x2E
  || octet === 0x5F
  || octet === 0x7E;

const canonicalizePathPercentEncoding = (pathname: string): string => pathname.replace(
  /%([0-9a-fA-F]{2})/gu,
  (_match, hexadecimalOctet: string) => {
    const octet = Number.parseInt(hexadecimalOctet, 16);
    return isUnreservedOctet(octet) ? String.fromCharCode(octet) : `%${hexadecimalOctet.toUpperCase()}`;
  },
);

/**
 * 正規化で残す query の名前か（L14。設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14、表 A の N7）。
 * - 追跡用の名前（`utm_*`・`gclid`・`fbclid`）は、いつも捨てる。
 * - 残す名前を選んでいない（空の集合。設定の `crawl.allowedQueryParameters` の既定 `[]`）なら、ほかの名前を全部残す（操作さがしの場所の鍵 COV-2 と同じく、
 *   query の違うページを別のページとして読む）。ただし、URL の伏せ字の一覧に当たる名前（`isSecretUrlQueryParameterName`。token・session など）は捨てる
 *   （正規化した URL は、記録・報告に書くため。認証つきの Run が、この名前を選ばせない決まり `secretAllowedQueryParameters` と同じ扱い）。
 * - 選んだ名前があれば、その名前だけを残す（今までどおり）。
 */
const isKeptQueryParameter = (name: string, allowedQueryParameters: ReadonlySet<string>): boolean => {
  if (isTrackingParameter(name)) {
    return false;
  }
  return allowedQueryParameters.size === 0 ? !isSecretUrlQueryParameterName(name) : allowedQueryParameters.has(name);
};

/** 認証情報を含むURLを受け入れないときの理由（`URL_REJECTION_REASONS` の1つ）。 */
export const CREDENTIALS_NOT_ALLOWED = 'CREDENTIALS_NOT_ALLOWED' satisfies UrlRejectionReason;

/**
 * URLを巡回用の正規形にする。受け入れない場合の `rawUrl` は、認証情報を伏せ字にした値（`redactUrlCredentials`）。
 * 受け入れない理由は、閉じた一覧 `URL_REJECTION_REASONS` のコード。
 * - 解析できないURLは `INVALID_URL`、http(s) 以外は `UNSUPPORTED_SCHEME`。
 * - 認証情報を含むURL（基準URLから引き継いだものを含む）は `CREDENTIALS_NOT_ALLOWED`。
 * - L14（表 A の N23）: 長さの上限（前の `MAX_URL_LENGTH` による `URL_TOO_LONG`）では拒まない。`URL_TOO_LONG` の値は、前の記録の読み方のために一覧に残す。
 */
export const normalizeUrl = (
  rawUrl: string,
  baseUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
): NormalizedUrlResult => {
  const reject = (reason: UrlRejectionReason): NormalizedUrlResult => ({
    ok: false,
    rawUrl: redactUrlCredentials(rawUrl, baseUrl),
    reason,
  });

  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return reject('INVALID_URL');
  }

  if (!isHttpProtocol(url.protocol)) {
    return reject('UNSUPPORTED_SCHEME');
  }

  if (hasUrlCredentials(url)) {
    return reject(CREDENTIALS_NOT_ALLOWED);
  }

  const allowedParameters = [...url.searchParams.entries()]
    .filter(([name]) => isKeptQueryParameter(name, allowedQueryParameters))
    .sort(([leftName], [rightName]) => compareCodeUnits(leftName, rightName));
  const normalizedQuery = new URLSearchParams();
  for (const [name, value] of allowedParameters) {
    normalizedQuery.append(name, value);
  }

  url.pathname = canonicalizePathPercentEncoding(url.pathname);
  url.search = normalizedQuery.toString();
  url.hash = '';
  // L14（INV-LIMITS の表 A の N23）: 長さでは受け入れを拒まない（長い URL のページも読む）。記録の値の長さは、記録する側が決める。
  return { ok: true, url: url.toString() as NormalizedHttpUrl };
};

/**
 * DEF-304（設計書 `2026-11-20-beaksight-audit-precision-and-scope-design.md` 2.1）: `url` と `requestedUrl` の Origin と path が同じなら、`url` の query を
 * `requestedUrl` の query に置き換えた URL（画面自身が変えた query を、点検の範囲の判定に使わないため。唯一の使い手は `auditScopeLeftUrl`）。Origin か path が
 * 違うか、読めなければ `url` のまま。
 */
export const withRequestedQueryOnSamePath = (url: string, requestedUrl: string): string => {
  try {
    const current = new URL(url);
    const requested = new URL(requestedUrl);
    if (current.origin !== requested.origin || current.pathname !== requested.pathname) {
      return url;
    }
    current.search = requested.search;
    return current.href;
  } catch {
    return url;
  }
};

/** `URL.protocol` の値が `http:` または `https:` か。 */
export const isHttpProtocol = (protocol: string): boolean => protocol === 'http:' || protocol === 'https:';

/**
 * 許可Originの設定値を、認証情報を含まない HTTP(S) の Origin の直列化の集合にする。
 * 解析できない値、HTTP(S) 以外、認証情報を含む値には権限を与えない（集合に入れない）。
 */
export const canonicalizeAllowedOrigins = (allowedOrigins: Iterable<string>): ReadonlySet<string> => {
  const canonicalOrigins = new Set<string>();
  for (const entry of allowedOrigins) {
    try {
      const url = new URL(entry);
      if (isHttpProtocol(url.protocol) && !hasUrlCredentials(url)) {
        canonicalOrigins.add(url.origin);
      }
    } catch {
      // 不正な形式のエントリに権限を与えてはならない。
    }
  }
  return canonicalOrigins;
};

/** URLが認証情報（ユーザー名またはパスワード）を含むか。 */
export const hasUrlCredentials = (url: URL): boolean => url.username.length > 0 || url.password.length > 0;

/**
 * ループバックのアドレスの host（`URL.hostname` の値）。並びは、設定の誤りの文に示す順。
 * サイトへの負荷の制御の設計書 3.2、4.2（設定の検証）と、Task 22 の設計書 4.3（テスト環境の `http:` の Origin）が使う。
 * 凍結した配列（書き換えられない。T22d、T22R の M2）。判定（`isLoopbackUrl`）は、公開しない集合 `loopbackHostnameSet` で行う。
 */
export const LOOPBACK_HOSTNAMES: readonly string[] = Object.freeze(['127.0.0.1', '[::1]', 'localhost']);

/** `LOOPBACK_HOSTNAMES` の集合（このファイルの外へ公開しない。公開した値を書き換えようとしても、判定は変わらない）。 */
const loopbackHostnameSet: ReadonlySet<string> = new Set(LOOPBACK_HOSTNAMES);

/** URL の host が、ループバックのアドレス（`127.0.0.1`、`[::1]`、`localhost`）か。 */
export const isLoopbackUrl = (url: URL): boolean => loopbackHostnameSet.has(url.hostname);

/**
 * 値が、認証情報を含まない HTTP(S) の Origin の正規の直列化（`new URL(value).origin` と同じ文字列）であれば、その値を返す。
 * 解析できない値、HTTP(S) 以外、認証情報を含む値、正規の直列化と違う書き方（末尾の `/`、パス、大文字、既定のポートなど）は `undefined`
 * （Task 22 の設計書 4.3 の `approvedTestOrigins`）。
 */
export const canonicalHttpOriginOf = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!isHttpProtocol(url.protocol) || hasUrlCredentials(url) || url.origin !== value) {
    return undefined;
  }
  return url.origin;
};

/**
 * Origin の直列化 `origin` が、許可Originの設定値に含まれるか。設定値は `canonicalizeAllowedOrigins` の意味で正規化して比べる。
 * `origin` は書き換えずに比べるので、正規の直列化でない値は含まれない（`false`）。
 */
export const isOriginInAllowedOrigins = (allowedOrigins: Iterable<string>, origin: string): boolean =>
  canonicalizeAllowedOrigins(allowedOrigins).has(origin);

/** 同時に始める判定のサイトの鍵で、ホスト名の先頭から除く部分（REV-PAR の m-2）。 */
const CONCURRENT_SITE_IGNORED_HOST_PREFIX = 'www.';

/**
 * 同時に始める判定（ジョブの管理のサイトごとに同時に 1 つ。PAR-b、REV-PAR の I-1・m-2）だけで使う、サイトの鍵の集合。許可 Origin の設定値を
 * `canonicalizeAllowedOrigins` で正規の形にしてから、ホスト名の先頭の `www.` を除く（`www.` の有無だけが違う 2 つの Origin は、同じサーバへの負荷を
 * 2 倍にしないため、同じサイトとみなす）。ほかの判定（許可 Origin の所属、DEF-180 の間隔の鍵など）には使わない。
 */
export const concurrentSiteKeysOf = (allowedOrigins: Iterable<string>): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const origin of canonicalizeAllowedOrigins(allowedOrigins)) {
    const url = new URL(origin);
    if (url.hostname.startsWith(CONCURRENT_SITE_IGNORED_HOST_PREFIX)) {
      url.hostname = url.hostname.slice(CONCURRENT_SITE_IGNORED_HOST_PREFIX.length);
    }
    keys.add(url.origin);
  }
  return keys;
};

/** 伏せ字の表記を、URLの解析器がユーザー名として直列化した値。 */
const REDACTED_USERNAME = new URL(`http://${REDACTED}@redacted.invalid/`).username;

/** 先頭の空白・制御文字、scheme、区切りのスラッシュ（またはバックスラッシュ）の後の、authority の中の最後の `@` までの userinfo。 */
const USERINFO_PATTERN = /^([\u0000- ]*(?:[A-Za-z][A-Za-z0-9+.-]*:)?[\\/]*)[^\\/?#]*@/u;

/** 解析できないURLの userinfo（`//` の後の authority の中の、最後の `@` まで）。 */
const UNPARSED_USERINFO_PATTERN = /^([\u0000- ]*(?:[A-Za-z][A-Za-z0-9+.-]*:)?[\\/]{2})[^\\/?#]*@/u;

const parseUrl = (rawUrl: string, baseUrl?: string): URL | undefined => {
  try {
    return new URL(rawUrl, baseUrl);
  } catch {
    return undefined;
  }
};

/** 基準URLから認証情報を除いたもの。相対URLが基準URLの認証情報を引き継いだだけの場合を、生の値の認証情報と区別するために使う。 */
const credentialFreeBaseUrl = (baseUrl: string | undefined): string | undefined => {
  const base = baseUrl === undefined ? undefined : parseUrl(baseUrl);
  if (base === undefined) {
    return baseUrl;
  }
  base.username = '';
  base.password = '';
  return base.toString();
};

/**
 * Evidence に残す生のURLから、認証情報を伏せ字（`REDACTED`、`[REDACTED]`）にする。
 * 生の値そのものが認証情報を含まない場合は、値をそのまま返す（基準URLの認証情報は生の値に含まれないので扱わない）。
 * 生の値の中で伏せ字にできない場合は、認証情報を除いて組み立て直した絶対URLを返す。
 */
export const redactUrlCredentials = (rawUrl: string, baseUrl?: string): string => {
  const base = credentialFreeBaseUrl(baseUrl);
  const parsed = parseUrl(rawUrl, base);
  if (parsed === undefined) {
    return rawUrl.replace(UNPARSED_USERINFO_PATTERN, `$1${REDACTED}@`);
  }
  if (!hasUrlCredentials(parsed)) {
    return rawUrl;
  }

  const redactedInPlace = rawUrl.replace(USERINFO_PATTERN, `$1${REDACTED}@`);
  const reparsed = parseUrl(redactedInPlace, base);
  if (reparsed !== undefined && reparsed.username === REDACTED_USERNAME && reparsed.password.length === 0) {
    return redactedInPlace;
  }
  return `${parsed.protocol}//${REDACTED}@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
};
