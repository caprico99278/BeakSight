/**
 * HTTP のステータスの範囲と、その判定（CCX-2。CC-042）。Rule（`src/audit/`）と安全の部品（`src/safety/`）の両方が使うので、下の層の
 * `src/core/` に 1 か所だけ置く。Rule の補助（`src/audit/rule-helpers.ts`）は、同じものを今の名前のまま公開し直す。
 */

/** HTTP のステータスの範囲（両端を含む）。 */
export interface HttpStatusRange {
  readonly min: number;
  readonly max: number;
}

/** 成功（2xx）の HTTP ステータスの範囲。 */
export const SUCCESS_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 200, max: 299 });
/** クライアントエラー（4xx）の HTTP ステータスの範囲。 */
export const CLIENT_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 400, max: 499 });
/** サーバエラー（5xx）の HTTP ステータスの範囲。 */
export const SERVER_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 500, max: 599 });
/** エラー（4xx・5xx）の HTTP ステータスの範囲。4xx の下端から 5xx の上端まで。 */
export const ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({
  min: CLIENT_ERROR_HTTP_STATUS_RANGE.min,
  max: SERVER_ERROR_HTTP_STATUS_RANGE.max,
});

/** 回数の制限（429 Too Many Requests）の HTTP ステータス（T30f。書き込みの結果の判定と、自動ログインの結果の判定が使う）。 */
export const TOO_MANY_REQUESTS_HTTP_STATUS = 429;

/** HTTP のステータスが範囲にあるか。観測できなかったステータス（`null`）は、どの範囲にも入らない。 */
export const isHttpStatusInRange = (status: number | null, range: HttpStatusRange): boolean =>
  status !== null && status >= range.min && status <= range.max;
