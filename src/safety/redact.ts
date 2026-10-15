import { REDACTED } from '../core/redaction.js';
import { redactUrlCredentials } from '../crawl/normalize-url.js';
import { isSecretLikeHeaderName, isSecretUrlQueryParameterName } from '../core/secret-query-names.js';

/**
 * header の値のうち、名前が秘密に見えるものを `REDACTED` にした写し（名前は書かれたまま残す。入力は変えない）。CCX-4: 名前の語の一覧と
 * 比べ方（header の部分一致の方針）の owner は `src/core/secret-query-names.ts` の `isSecretLikeHeaderName`。
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, isSecretLikeHeaderName(name) ? REDACTED : value]));
}

// ---------------------------------------------------------------------------------------------------------------
// 認証つきの Run の URL の伏せ字（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.6。T25f）
// - 認証つきの Run の成果物（Run のディレクトリのファイル）と知らせ（`RunNotice`）に書く URL の、秘密に見える query の値を `REDACTED` にする。
//   userinfo は、URL の owner の `redactUrlCredentials` と同じ規則で伏せる（ここで新しく判定しない）。
// - 公開監査では使わない（呼び出し側が、認証つきの Run のときだけ通す。公開監査の出力は変えない）。
// - 巡回の判定（同じページかどうか、重複の除去）には使わない（伏せ字の前の URL で判定する。伏せ字で別のページが同じに見えないように）。
// ---------------------------------------------------------------------------------------------------------------

// T27c: 値を伏せる query の名前の一覧と判定の owner は `src/core/secret-query-names.ts`（`src/control/` からも使うため）。ここは今の名前のまま
// 公開し直す（振る舞いは変えない）。
export { SECRET_URL_QUERY_PARAMETER_NAMES, isSecretUrlQueryParameterName } from '../core/secret-query-names.js';

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

/** query の 1 組（`name=value`）。名前が値を伏せる名前で、値が空でなければ、値を `REDACTED` にする。名前は書かれたまま残す。 */
const redactQueryPair = (pair: string): string => {
  const separator = pair.indexOf(NAME_VALUE_SEPARATOR);
  if (separator < 0 || separator === pair.length - 1) {
    return pair;
  }
  const name = pair.slice(0, separator);
  return isSecretUrlQueryParameterName(name) ? `${name}${NAME_VALUE_SEPARATOR}${REDACTED}` : pair;
};

/**
 * URL（絶対でも相対でもよい。成果物に書く形のまま）の秘密を伏せる。
 * 1. userinfo は、`redactUrlCredentials` で伏せる（今の規則と同じ）。
 * 2. 最初の `?` から、その後の最初の `#`（なければ終わり）までを query とし、組ごとに `redactQueryPair` を通す。ほかの部分（path、値を伏せない
 *    組、区切り）は、書かれたまま残す（並べ替え、percent-encode のし直しをしない）。
 * 3. fragment（`#` から後）は触らない。`#` が `?` より前にあれば、query はない。
 * 同じ値を 2 回通しても変わらない。
 */
export function redactUrlSecrets(url: string): string {
  const withoutCredentials = redactUrlCredentials(url);
  const queryStart = withoutCredentials.indexOf(QUERY_START);
  const fragmentStart = withoutCredentials.indexOf(FRAGMENT_START);
  if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) {
    return withoutCredentials;
  }
  const queryEnd = fragmentStart < 0 ? withoutCredentials.length : fragmentStart;
  const query = withoutCredentials.slice(queryStart + QUERY_START.length, queryEnd);
  const redactedQuery = query
    .split(QUERY_PAIR_SEPARATORS)
    .map((part, index) => (index % SPLIT_PAIR_PERIOD === 0 ? redactQueryPair(part) : part))
    .join('');
  return `${withoutCredentials.slice(0, queryStart + QUERY_START.length)}${redactedQuery}${withoutCredentials.slice(queryEnd)}`;
}

/** 文の中の、URL の候補（空白、引用符、`<`、`>`、backtick を含まない連なり）。 */
const URL_CANDIDATE = /[^\s"'<>`]+/gu;
/** URL の候補のうち、伏せる対象になりうるもの（query か userinfo の印を持つ）。 */
const USERINFO_MARK = '@';

/**
 * 文（誤りの文、console の文、可視テキストなど、URL を含みうる任意の文字列）の中の URL の候補ごとに、`redactUrlSecrets` を通す。候補は、
 * 空白・引用符・`<`・`>`・backtick で区切った連なりのうち、`?` か `@` を含むもの。ほかの文字は変えない。
 */
export function redactUrlSecretsInText(text: string): string {
  return text.replace(URL_CANDIDATE, (candidate) =>
    (candidate.includes(QUERY_START) || candidate.includes(USERINFO_MARK) ? redactUrlSecrets(candidate) : candidate));
}

/** JSON の値として扱うオブジェクト（prototype が `Object.prototype` か `null`）か。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * 値の木（JSON の値: 文字列、配列、プレーンなオブジェクト）の写しを作り、すべての文字列に `redactUrlSecretsInText` を通す。オブジェクトの名前
 * （キー）と、文字列でない値（数、真偽、`null`、`undefined`）、プレーンでないオブジェクト（`Uint8Array` など）は、そのまま残す。入力は変えない。
 */
export function redactUrlSecretsInValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactUrlSecretsInText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactUrlSecretsInValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactUrlSecretsInValue(item)])) as T;
  }
  return value;
}
