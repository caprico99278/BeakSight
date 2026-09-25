import type { LinkNormalizationEvidence, NormalizedHttpUrlEvidence, UrlRejectionReason } from '../core/evidence-types.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { REDACTED } from '../core/redaction.js';
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

/** 認証情報を含むURLを受け入れないときの理由（`URL_REJECTION_REASONS` の1つ）。 */
export const CREDENTIALS_NOT_ALLOWED = 'CREDENTIALS_NOT_ALLOWED' satisfies UrlRejectionReason;

/**
 * URLを巡回用の正規形にする。受け入れない場合の `rawUrl` は、認証情報を伏せ字にした値（`redactUrlCredentials`）。
 * 受け入れない理由は、閉じた一覧 `URL_REJECTION_REASONS` のコード。
 * - 解析できないURLは `INVALID_URL`、http(s) 以外は `UNSUPPORTED_SCHEME`。
 * - 認証情報を含むURL（基準URLから引き継いだものを含む）は `CREDENTIALS_NOT_ALLOWED`。
 * - 正規化したURLが `MAX_URL_LENGTH` より長いものは `URL_TOO_LONG`（Evidence とクロールのキューに、上限を超えるURLを入れない）。
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
    .filter(([name]) => allowedQueryParameters.has(name) && !isTrackingParameter(name))
    .sort(([leftName], [rightName]) => compareCodeUnits(leftName, rightName));
  const normalizedQuery = new URLSearchParams();
  for (const [name, value] of allowedParameters) {
    normalizedQuery.append(name, value);
  }

  url.pathname = canonicalizePathPercentEncoding(url.pathname);
  url.search = normalizedQuery.toString();
  url.hash = '';
  const normalizedUrl = url.toString();
  if (normalizedUrl.length > MAX_URL_LENGTH) {
    return reject('URL_TOO_LONG');
  }
  return { ok: true, url: normalizedUrl as NormalizedHttpUrl };
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
