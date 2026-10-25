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
/** リダイレクト（3xx）の HTTP ステータスの範囲（PRE42-CC 組 S2。Guard の、外部スキームへのリダイレクトの判定が使う）。 */
export const REDIRECTION_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 300, max: 399 });
/** クライアントエラー（4xx）の HTTP ステータスの範囲。 */
export const CLIENT_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 400, max: 499 });
/** サーバエラー（5xx）の HTTP ステータスの範囲。 */
export const SERVER_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 500, max: 599 });
/** エラー（4xx・5xx）の HTTP ステータスの範囲。4xx の下端から 5xx の上端まで。 */
export const ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({
  min: CLIENT_ERROR_HTTP_STATUS_RANGE.min,
  max: SERVER_ERROR_HTTP_STATUS_RANGE.max,
});

/**
 * 観察して成果物に記録できる HTTP ステータスの範囲（DEF-164）。Chromium は、100〜999 の 3 桁の status をそのまま渡す（600 以上の決まっていない
 * status も渡す）。成果物のスキーマ（`read-evidence.json` の `httpStatus`）の最小と最大は、この範囲と一致する（`tests/unit/read-check-evaluation.test.ts`）。
 * 600 以上を誤りとする判定（`isHttpErrorOrNonStandardStatus`）は変えない（記録の範囲と判定は別）。
 * 書き込みの記録（`action-run.json` の `httpStatus`）は、この範囲を使わず 100〜599 のまま（管理データの `write_results.http_status` の範囲と一致させる。
 * 範囲の外の status は null として記録し、結果は UNKNOWN。`action-contracts.ts` の `MIN_HTTP_STATUS`・`MAX_HTTP_STATUS`。LG-4F の設計者の判断）。
 */
export const OBSERVABLE_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 100, max: 999 });

/** 回数の制限（429 Too Many Requests）の HTTP ステータス（T30f。書き込みの結果の判定と、自動ログインの結果の判定が使う）。 */
export const TOO_MANY_REQUESTS_HTTP_STATUS = 429;

/** HTTP のステータスが範囲にあるか。観測できなかったステータス（`null`）は、どの範囲にも入らない。 */
export const isHttpStatusInRange = (status: number | null, range: HttpStatusRange): boolean =>
  status !== null && status >= range.min && status <= range.max;

/**
 * HTTP のステータスが、誤り（4xx・5xx）か、600 以上の決まっていない status か（PRE42-CC 組 R。CC-042 の残り）。600 以上の決まっていない status
 * も誤りとして扱う（READ の確かめは、そのような画面を読まない。安全側に倒す設計者の判断）。観測できなかったステータス（`null`）は、誤りにしない。
 */
export const isHttpErrorOrNonStandardStatus = (status: number | null): boolean =>
  status !== null && status >= ERROR_HTTP_STATUS_RANGE.min;
