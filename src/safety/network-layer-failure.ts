/**
 * ネットワークの層の失敗の閉じた一覧（DEF-004）。
 *
 * Passive Request Guard は、許可した読み取り（GET/HEAD）のメインフレームのナビゲーションが、
 * この一覧に載る理由で失敗した場合に限り、Guard の不変条件の違反として扱わない。
 * 読み取りのリクエストは、サーバに届いても安全の問題にならず、これらの理由は Guard 自身の不具合を示さないためである。
 *
 * 一覧は閉じている（fail-closed）。`net::ERR_ABORTED`、`net::ERR_FAILED`、`net::ERR_BLOCKED_BY_CLIENT` のように、
 * Guard の中断や配送の取りこぼしを示しうる理由と、判断に迷う理由は、載せない。照合は完全一致である。
 */
export const NETWORK_LAYER_FAILURE_CODES = [
  // 接続
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_TIMED_OUT',
  // 応答
  'net::ERR_EMPTY_RESPONSE',
  // DEF-029: 本文の途中で、サーバか経路が接続を切った失敗（`Content-Length` より短い本文、chunked の本文の途中の切断）。
  // Guard の中断や配送の取りこぼしを示さない。
  'net::ERR_CONTENT_LENGTH_MISMATCH',
  'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  // ネットワークの変化
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_INTERNET_DISCONNECTED',
  // 名前解決と宛先
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_NAME_RESOLUTION_FAILED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_ADDRESS_INVALID',
] as const;

/** TLS の失敗のコードの接頭辞。接頭辞の後ろには、英大文字・数字・`_` が1文字以上続く必要がある。 */
export const NETWORK_LAYER_FAILURE_CODE_PREFIXES = [
  'net::ERR_SSL_',
  'net::ERR_CERT_',
] as const;

const NETWORK_LAYER_FAILURE_CODE_SET: ReadonlySet<string> = new Set(NETWORK_LAYER_FAILURE_CODES);
const CODE_SUFFIX_PATTERN = /^[A-Z0-9_]+$/u;

/** Chromium の失敗の理由（`Request.failure().errorText`）が、ネットワークの層の失敗の閉じた一覧に載っているか。 */
export function isNetworkLayerFailure(errorText: string): boolean {
  if (NETWORK_LAYER_FAILURE_CODE_SET.has(errorText)) {
    return true;
  }
  return NETWORK_LAYER_FAILURE_CODE_PREFIXES.some((prefix) => (
    errorText.startsWith(prefix) && CODE_SUFFIX_PATTERN.test(errorText.slice(prefix.length))
  ));
}

/**
 * 応答（ヘッダ）を受けた後に、Chromium が読み込みを失敗にする理由の閉じた一覧（DEF-029）。
 *
 * Passive Request Guard は、許可した読み取り（GET/HEAD）のメインフレームのナビゲーションが、凍結の前に、この一覧に載る理由で失敗し、
 * その要求の応答の HTTP の status が 4xx・5xx であることを確かめた場合に限り、Guard の不変条件の違反として扱わない。
 * 応答のヘッダを受けているので、要求はサーバに届き、サーバが失敗の status で答えた（配送は確か）ためである。
 * - `net::ERR_HTTP_RESPONSE_CODE_FAILURE`: 本文のない 4xx・5xx の応答を、Chromium が描かずに、読み込みを失敗にした。
 * - `net::ERR_INVALID_AUTH_CREDENTIALS`: 401（Basic）に答える認証の情報がないので、Chromium が読み込みを失敗にした。
 *
 * 一覧は閉じている（fail-closed）。ネットワークの層の失敗（`NETWORK_LAYER_FAILURE_CODES`）とは重ならない。`net::ERR_ABORTED`
 * （ダウンロードへの切り替わり、外部スキームへの 3xx）や `net::ERR_BLOCKED_BY_CLIENT`（Guard の中断）は、理由が違うので載せない。
 * 照合は完全一致である。
 */
export const RESPONSE_RECEIVED_FAILURE_CODES = Object.freeze([
  'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
  'net::ERR_INVALID_AUTH_CREDENTIALS',
] as const);

const RESPONSE_RECEIVED_FAILURE_CODE_SET: ReadonlySet<string> = new Set(RESPONSE_RECEIVED_FAILURE_CODES);

/** Chromium の失敗の理由（`Request.failure().errorText`）が、応答を受けた後の失敗の閉じた一覧に載っているか（完全一致）。 */
export function isResponseReceivedFailure(errorText: string): boolean {
  return RESPONSE_RECEIVED_FAILURE_CODE_SET.has(errorText);
}
