// 自動ログインの結果の閉じた一覧と、ログインの Origin の求め方の SSOT（Task 26 の設計書 4.4 の 5、4.5 の「結果の閉じた一覧」。T26c）。
// - ワーカーの IPC（`AUTH_STATE`、T26d）、ジョブの失敗の理由（`src/control/job/job-records.ts`）、管理データの版 4 の表の CHECK
//   （`src/control/store/migrations.ts`）が、ここを参照する。ワーカー（`src/worker/`）からも読めるように、`src/control/job/` と
//   `src/control/store/` の外に置く（ワーカーの許可の一覧はファイルの単位。足すのは T26d）。
// - ログインの Origin は、認証の設定の `loginStartUrl` の Origin（設計書 4.5 と変更履歴の「Blocker: T26c」の行の (4)）。資格情報の
//   ファイル（T26a）が保存する `loginOrigin` と同じく、既存の Origin の正規化（`canonicalHttpOriginOf`）で確かめる。
// 値の一覧は `as const` の凍結した配列として 1 回だけ定義し、型はその配列から導く。SQL と秘密を持たない。
import { SERVER_ERROR_HTTP_STATUS_RANGE, TOO_MANY_REQUESTS_HTTP_STATUS, isHttpStatusInRange } from '../../core/http-status.js';
import { canonicalHttpOriginOf } from '../../crawl/normalize-url.js';

/** 自動ログインの成功の結果。 */
export const AUTOMATED_LOGIN_SUCCEEDED = 'SUCCEEDED';

/**
 * 自動ログインの成功以外の結果（閉じた一覧。ジョブの失敗の理由と、止めた状態の理由にも使う）。
 * - `INVALID_CREDENTIALS`・`ACCOUNT_LOCKED`・`MFA_REQUIRED`・`CREDENTIAL_EXPIRED`: 認証の設定の失敗の条件に、ちょうど 1 つ当たった。
 * - `RATE_LIMITED`: main frame の応答が 429（`Retry-After` を読む）。
 * - `AUTH_RESULT_UNKNOWN`: 5xx、条件が 0 か 2 以上、時間の上限、またはワーカーが結果なしで終わった。
 * - `LOGIN_FORM_INVALID`: フォームを読むだけの確かめが通らなかった（値を入れていない。送信していない）。
 * - `LOGIN_FORM_INPUT_FAILED`: 値を入れるか送るところで失敗した（誤りの文は出さない）。
 * - `CREDENTIAL_CHANGED`: 資格情報の改訂の番号か Origin が、開始の確かめの後に変わった（送信していない）。
 * - `CREDENTIAL_UNAVAILABLE`: 資格情報を復号できなかった（送信していない）。
 * - `UNEXPECTED_LOGIN_REQUEST`: 送信の窓（値を入れ始めてから、許した POST を通すまで）の中で、ページが許した POST のほかの要求を出そうと
 *   したので止めた（入力の値を送りうる。成功の条件に当たっていても成功にしない。T26g-1、設計書の変更履歴の「T26R」の行）。
 */
export const AUTOMATED_LOGIN_FAILURE_RESULTS = Object.freeze([
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'MFA_REQUIRED',
  'CREDENTIAL_EXPIRED',
  'RATE_LIMITED',
  'AUTH_RESULT_UNKNOWN',
  'LOGIN_FORM_INVALID',
  'LOGIN_FORM_INPUT_FAILED',
  'CREDENTIAL_CHANGED',
  'CREDENTIAL_UNAVAILABLE',
  'UNEXPECTED_LOGIN_REQUEST',
] as const);
export type AutomatedLoginFailureResult = (typeof AUTOMATED_LOGIN_FAILURE_RESULTS)[number];

/** 自動ログインの結果のすべて（成功が先頭）。 */
export const AUTOMATED_LOGIN_RESULTS = Object.freeze([AUTOMATED_LOGIN_SUCCEEDED, ...AUTOMATED_LOGIN_FAILURE_RESULTS] as const);
export type AutomatedLoginResult = (typeof AUTOMATED_LOGIN_RESULTS)[number];

/** `Retry-After` を記録してよい結果（429）。 */
export const AUTOMATED_LOGIN_RATE_LIMITED_RESULT = 'RATE_LIMITED' satisfies AutomatedLoginFailureResult;

/** 結果が分からないときの結果（ワーカーが結果なしで終わったときにも使う）。 */
export const AUTOMATED_LOGIN_UNKNOWN_RESULT = 'AUTH_RESULT_UNKNOWN' satisfies AutomatedLoginFailureResult;

/**
 * 状態のコードを当てる応答の種類（T36R-fix。T36R の M-5。閉じた一覧）。
 * - `DOCUMENT_RESPONSE`: ログインの画面を開いたときと、form の送信の後の main frame の文書の応答（ワーカーの `statusOutcome`）。
 * - `TOKEN_RESPONSE`: スクリプトで送るログインの、token の送信の応答（ワーカーの `tokenResponseOutcome`。2xx は成功の確かめに進むので、ここに来ない）。
 */
export const LOGIN_HTTP_RESPONSE_KINDS = Object.freeze(['DOCUMENT_RESPONSE', 'TOKEN_RESPONSE'] as const);
export type LoginHttpResponseKind = (typeof LOGIN_HTTP_RESPONSE_KINDS)[number];

/** 応答の状態のコードから決まりうる結果。 */
export type LoginHttpStatusFailureResult = Extract<
  AutomatedLoginFailureResult,
  'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | typeof AUTOMATED_LOGIN_RATE_LIMITED_RESULT | typeof AUTOMATED_LOGIN_UNKNOWN_RESULT
>;

/** 状態のコードの表の 1 行。 */
export interface LoginHttpStatusResult {
  readonly status: number;
  readonly result: LoginHttpStatusFailureResult;
  /** この行を当てる応答（form の文書の応答では、400・401・423 は当てず、認証の設定の失敗の条件で決める）。 */
  readonly responseKinds: readonly LoginHttpResponseKind[];
}

/** 400（資格情報の誤り）。 */
const BAD_REQUEST_HTTP_STATUS = 400;
/** 401（資格情報の誤り）。 */
const UNAUTHORIZED_HTTP_STATUS = 401;
/** 423（アカウントのロック）。 */
const LOCKED_HTTP_STATUS = 423;

const TOKEN_RESPONSE_ONLY: readonly LoginHttpResponseKind[] = Object.freeze(['TOKEN_RESPONSE'] as const);

/**
 * ログインの応答の状態のコードから結果への表（T36R-fix。T36R の M-5。400・401・423・429 の対応の唯一の置き場。Task 36 の設計書 3.4 の表と、
 * Task 26 の設計書 4.5 の 429）。5xx は、どの応答でも結果が分からない（`AUTH_RESULT_UNKNOWN`）。token の送信の応答で、表にも 5xx にもない状態も、
 * 結果が分からない。form の文書の応答で、表にも 5xx にもない状態は決めない（`null`。成功の条件と失敗の条件を待つ）。
 */
export const LOGIN_HTTP_STATUS_RESULTS: readonly LoginHttpStatusResult[] = Object.freeze([
  Object.freeze({ status: BAD_REQUEST_HTTP_STATUS, result: 'INVALID_CREDENTIALS', responseKinds: TOKEN_RESPONSE_ONLY }),
  Object.freeze({ status: UNAUTHORIZED_HTTP_STATUS, result: 'INVALID_CREDENTIALS', responseKinds: TOKEN_RESPONSE_ONLY }),
  Object.freeze({ status: LOCKED_HTTP_STATUS, result: 'ACCOUNT_LOCKED', responseKinds: TOKEN_RESPONSE_ONLY }),
  Object.freeze({ status: TOO_MANY_REQUESTS_HTTP_STATUS, result: AUTOMATED_LOGIN_RATE_LIMITED_RESULT, responseKinds: LOGIN_HTTP_RESPONSE_KINDS }),
]);

/** 応答の状態のコードから決まる結果（決まらなければ `null`。上の表）。`RATE_LIMITED` のときは、呼ぶ側が `Retry-After` を読む。 */
export const loginHttpStatusResultOf = (status: number, responseKind: LoginHttpResponseKind): LoginHttpStatusFailureResult | null => {
  const row = LOGIN_HTTP_STATUS_RESULTS.find((entry) => entry.status === status && entry.responseKinds.includes(responseKind));
  if (row !== undefined) {
    return row.result;
  }
  if (isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE)) {
    return AUTOMATED_LOGIN_UNKNOWN_RESULT;
  }
  return responseKind === 'TOKEN_RESPONSE' ? AUTOMATED_LOGIN_UNKNOWN_RESULT : null;
};

/**
 * ログインの POST を送ったか（閉じた一覧）。`YES` は送った、`NO` は送る前に終わった（ロックの心配がない）、`UNKNOWN` は分からない
 * （送ったかもしれない）。成功以外で `YES` か `UNKNOWN` のときは、そのプロファイルの自動ログインを止める（設計書 4.5）。
 */
export const AUTOMATED_LOGIN_SUBMISSIONS = Object.freeze(['YES', 'NO', 'UNKNOWN'] as const);
export type AutomatedLoginSubmission = (typeof AUTOMATED_LOGIN_SUBMISSIONS)[number];

/** 送信が分からないとき。 */
export const AUTOMATED_LOGIN_SUBMISSION_UNKNOWN = 'UNKNOWN' satisfies AutomatedLoginSubmission;

/** 送信していないとき（止めない）。 */
export const AUTOMATED_LOGIN_SUBMISSION_NONE = 'NO' satisfies AutomatedLoginSubmission;

/** 成功のときの送信（成功は、送ったときだけ）。 */
export const AUTOMATED_LOGIN_SUBMISSION_SENT = 'YES' satisfies AutomatedLoginSubmission;

/**
 * ログインの Origin（`loginStartUrl` の Origin を、既存の Origin の正規化で確かめたもの）。http(s) の URL でなければ `undefined`。
 * 開始の前の確かめ（T26c）、ワーカーの確かめ（T26d）、資格情報の画面（T26e）が使う。
 */
export const loginOriginOf = (loginStartUrl: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(loginStartUrl);
  } catch {
    return undefined;
  }
  return canonicalHttpOriginOf(parsed.origin);
};
