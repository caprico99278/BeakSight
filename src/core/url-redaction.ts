// URL の文字列の query の値と path の値に見える区切りを伏せる、core の唯一の部品（T35c。Task 35 の設計書 3.6）。
// - query の値の伏せ方（`redactUrlQueryValues`）: 最初の `?` から、その後の最初の `#`（なければ終わり）までを query とし、組（`&`・`;`・2 つ目の `?` で
//   区切る）ごとに、名前が `shouldRedactValue` に当たり値が空でなければ、値を `REDACTED` にする。名前と区切りと fragment は書かれたまま残す（並べ替え、
//   percent-encode のし直しをしない）。認証つきの Run の秘密に見える名前の伏せ方（`src/safety/redact.ts` の `redactUrlSecrets`。T25f）は、この部品に
//   名前の判定を渡して使う（T35c で、そこにあった組の扱いをここへ移した。振る舞いは変えない）。
// - 承認したサービスの Origin の URL の伏せ方（`redactServiceOriginUrl`）: path の値に見える区切りを伏せ（`src/core/url-path-redaction.ts` の
//   `redactValueLikePathSegments`）、query の値をすべて伏せる（名前は残す）。T35R-fix（T35R の M-3）: fragment の値も伏せる（`&` で区切った組ごとに、
//   `name=value` は値を、`=` のない組は組そのものを伏せる）。成果物の書き手が、認証つきの Run で承認したサービスの Origin の URL に使う。
// - T35R-fix（T35R の M-2）: WebSocket の URL（`ws://`・`wss://`）を、Origin を比べるために http(s) の URL として読む形（`asHttpSchemeUrl`。
//   `ws` は `http`、`wss` は `https`。ホストとポートはそのまま）。Origin の照合は、呼び出し側が今の照合の owner で行う。
// 同じ値を 2 回通しても変わらない。
import { REDACTED } from './redaction.js';
import { redactValueLikePathSegments } from './url-path-redaction.js';

/** query の始まり、fragment の始まり、名前と値の区切り。 */
const QUERY_START = '?';
const FRAGMENT_START = '#';
const NAME_VALUE_SEPARATOR = '=';
/**
 * query の組の区切り（`&` と、一部のサーバが使う `;`。query の中の 2 つ目の `?` も区切りにする: `?next=/x?token=…` の `token` を見落とさない）。
 * 区切りは、結果に残す（捕まえる組にして `split` する）。
 */
const QUERY_PAIR_SEPARATORS = /([&;?])/u;
/** 捕まえる組で `split` した結果の並び（組、区切り、組、…）の周期。偶数番目が組、奇数番目が区切り。 */
const SPLIT_PAIR_PERIOD = 2;
/** scheme と authority の区切り（`https://host`）。 */
const AUTHORITY_START = '://';
const PATH_START = '/';
/** fragment の組の区切り（区切りは結果に残す）。 */
const FRAGMENT_PAIR_SEPARATORS = /(&)/u;
/** WebSocket の scheme と、Origin を比べるときに読み替える http(s) の scheme（小文字。比べるときは大文字と小文字を区別しない）。 */
const WEB_SOCKET_SCHEME_AS_HTTP: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(['wss://', 'https://'] as const),
  Object.freeze(['ws://', 'http://'] as const),
]);

/** query の 1 組（`name=value`）。名前が `shouldRedactValue` に当たり、値が空でなければ、値を `REDACTED` にする。名前は書かれたまま残す。 */
const redactQueryPair = (pair: string, shouldRedactValue: (name: string) => boolean): string => {
  const separator = pair.indexOf(NAME_VALUE_SEPARATOR);
  if (separator < 0 || separator === pair.length - 1) {
    return pair;
  }
  const name = pair.slice(0, separator);
  return shouldRedactValue(name) ? `${name}${NAME_VALUE_SEPARATOR}${REDACTED}` : pair;
};

/** URL（絶対でも相対でもよい）の query の、名前が `shouldRedactValue` に当たる組の値を伏せる（ファイルの先頭の説明）。 */
export function redactUrlQueryValues(url: string, shouldRedactValue: (name: string) => boolean): string {
  const queryStart = url.indexOf(QUERY_START);
  const fragmentStart = url.indexOf(FRAGMENT_START);
  if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) {
    return url;
  }
  const queryEnd = fragmentStart < 0 ? url.length : fragmentStart;
  const query = url.slice(queryStart + QUERY_START.length, queryEnd);
  const redactedQuery = query
    .split(QUERY_PAIR_SEPARATORS)
    .map((part, index) => (index % SPLIT_PAIR_PERIOD === 0 ? redactQueryPair(part, shouldRedactValue) : part))
    .join('');
  return `${url.slice(0, queryStart + QUERY_START.length)}${redactedQuery}${url.slice(queryEnd)}`;
}

/** query の値をすべて伏せる名前の判定（承認したサービスの Origin の URL）。 */
const EVERY_QUERY_NAME = (): boolean => true;

/** fragment の 1 組。`name=value` は値を伏せ（空の値はそのまま）、`=` のない空でない組は組そのものを伏せる。 */
const redactFragmentPair = (pair: string): string => {
  if (pair.length === 0) {
    return pair;
  }
  return pair.includes(NAME_VALUE_SEPARATOR) ? redactQueryPair(pair, EVERY_QUERY_NAME) : REDACTED;
};

/** URL の fragment（最初の `#` の後）の値を伏せる（`#` がなければ、そのまま）。 */
const redactFragmentValues = (url: string): string => {
  const fragmentStart = url.indexOf(FRAGMENT_START);
  if (fragmentStart < 0) {
    return url;
  }
  const fragment = url.slice(fragmentStart + FRAGMENT_START.length)
    .split(FRAGMENT_PAIR_SEPARATORS)
    .map((part, index) => (index % SPLIT_PAIR_PERIOD === 0 ? redactFragmentPair(part) : part))
    .join('');
  return `${url.slice(0, fragmentStart + FRAGMENT_START.length)}${fragment}`;
};

/**
 * WebSocket の URL（`ws://`・`wss://` で始まる。大文字と小文字を区別しない）を、Origin を比べるための http(s) の URL に読み替える（ほかの値はそのまま）。
 * 伏せた値を書くためには使わない（比べるためだけ）。
 */
export function asHttpSchemeUrl(url: string): string {
  const lower = url.toLowerCase();
  const match = WEB_SOCKET_SCHEME_AS_HTTP.find(([webSocket]) => lower.startsWith(webSocket));
  return match === undefined ? url : `${match[1]}${url.slice(match[0].length)}`;
}

/**
 * 承認したサービスの Origin の URL（絶対形。`<scheme>://<authority><path>?<query>#<fragment>`）の、path の値に見える区切りと、query のすべての値と、
 * fragment の値を伏せる（名前は残す）。authority の後の path の部分は、最初の `?`・`#`（なければ終わり）まで。絶対形でない値は、query と fragment の
 * 値だけを伏せる。
 */
export function redactServiceOriginUrl(url: string): string {
  const authorityStart = url.indexOf(AUTHORITY_START);
  const pathStart = authorityStart < 0 ? -1 : url.indexOf(PATH_START, authorityStart + AUTHORITY_START.length);
  const queryOrFragment = [url.indexOf(QUERY_START), url.indexOf(FRAGMENT_START)].filter((index) => index >= 0);
  const pathEnd = queryOrFragment.length === 0 ? url.length : Math.min(...queryOrFragment);
  const withPath = pathStart < 0 || pathStart > pathEnd
    ? url
    : `${url.slice(0, pathStart)}${redactValueLikePathSegments(url.slice(pathStart, pathEnd))}${url.slice(pathEnd)}`;
  return redactFragmentValues(redactUrlQueryValues(withPath, EVERY_QUERY_NAME));
}
