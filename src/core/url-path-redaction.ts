// URL の path の「値に見える区切り」を伏せる唯一の判定（T34e fix round 1。Task 34 の設計書 8 章の T34e の行の設計者の判断）。
// - ログインの段で止めた読み取りでない要求の一覧の path（`src/safety/login-stage-blocked-requests.ts` が伏せ、IPC の `src/control/worker-protocol.ts` が
//   伏せるべき区切りが残っていないことを確かめ、画面が伏せた区切りを見分ける）に使う。名前（`token` など）は伏せない（名前を伏せても値は守れず、送信先の
//   path まで伏せると、利用者が何を登録すればよいか見分けられないため）。
// - path を `/` で区切り、各区切りを decode した後で、さらに `;`・`=`・`,`・`[`・`]` で部分に分け（T34e fix round 2。`;jsessionid=<長い値>` の形）、どれかの部分が
//   値に見えれば、その区切り全体を `REDACTED_PATH_SEGMENT` にする。値に見える条件:
//   (a1) base64url の文字（英数字と `-`・`_`）だけで `MIN_VALUE_LIKE_BASE64URL_LENGTH` 以上、英大文字・英小文字・数字をすべて含む。
//   (a2) 英小文字と数字だけ（`_`・`-` を含まない）で `MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH` 以上、数字を `MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS` 以上含む。
//        （T34e fix round 2: 手続きの名前（英小文字と `_`、末尾に数字。例 `list_members_with_details_v2`）は、利用者が登録の中身を見分けるために伏せない。）
//   (b) 16 進の文字だけで `MIN_VALUE_LIKE_HEX_LENGTH` 以上（数字だけの長い値を含む）。
//   (c) JWT の形: `.` で区切った 3 つの base64url の組で、初めの 2 つは空でなく、初めの組が JSON の始まりの base64url（`JWT_HEADER_PREFIX`）で始まる
//       （版の番号やファイルの名前 `app.min.js` を伏せないため）。
//   UUID（8-4-4-4-12 の 16 進）は ID として伏せない。
// - T34R-fix-b（独立レビュー T34R の M-2）: 部分に分ける前に、区切り全体（decode の後）が標準の base64 の形（英数字と `+`・`/`、末尾に 0〜2 個の `=`、
//   `MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH` 字以上、`+` か `=` を 1 つ以上含む）なら伏せる（`%2B` で encode した `+` も decode の後で当たる）。メール
//   アドレスの形（`@` の前に文字があり、`@` の後に `.` を含む文字がある）の区切り・部分も伏せる（個人の情報）。
// - 既知の限界（伏せない。表で固定）: 23 字以下の base64url、数字のない英大文字と英小文字、JWT でない `.` 区切り、`~` で始まる値、16 進 31 字以下。
// - 区切りでない値（decode しない）の判定 `isValueLikeText` も同じ条件（T34R-fix-b の M-6: 認証の設定の必須の query の値の検証が使う）。
// - T34R2-fix（2 回目のレビュー T34R2 の M-2）: 標準の base64 の条件は、区切り全体のほかに、`;`・`,` で分けた各項目と、項目の `名前=値` の値の側（最初の
//   `=` の後ろ全体。`=` の埋め字を含む）と、`;`・`=`・`,` で分けた各部分にも当てる。既知の限界: `%2F` を含む標準の base64（`+` も `=` もない）。
// - DEF-155: 角括弧 `[`・`]` も、項目の区切りと部分の区切りに加える（`login[<値>]` の形の値を取り出すため）。添え字（`items[0]`）やふつうの名前
//   （`a[b]`・`login[email]`）は、取り出した部分が値に見えないので伏せない。伏せ字の表記 `[REDACTED]` も、部分が英大文字だけなので当たらない。
// - 誤って伏せる例と伏せない例の表は `tests/unit/url-path-redaction.test.ts` で固定する。import は同じ core の伏せ字の表記だけ。
import { REDACTED } from './redaction.js';

/** 伏せた区切りの表記（Evidence の伏せ字と同じ）。 */
export const REDACTED_PATH_SEGMENT = REDACTED;

/** (a1) base64url の値に見える最小の長さ（英大文字・英小文字・数字をすべて含むもの）。 */
export const MIN_VALUE_LIKE_BASE64URL_LENGTH = 24;

/** 標準の base64（`+`・`/` と `=` の埋め字）の値に見える最小の長さ（T34R-fix-b）。 */
export const MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH = 20;

/** (a2) 英小文字と数字だけの値に見える最小の長さ。 */
export const MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH = 32;

/** (a2) 英小文字と数字だけの値に見える、数字の最小の数。 */
export const MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS = 4;

/** (b) 16 進の値に見える最小の長さ。 */
export const MIN_VALUE_LIKE_HEX_LENGTH = 32;

/** (c) JWT の初めの組（JSON の `{"` の base64url）の始まり。 */
const JWT_HEADER_PREFIX = 'eyJ';

/** JWT の組の数。 */
const JWT_PART_COUNT = 3;

/** path の区切り。 */
const PATH_SEPARATOR = '/';

/** JWT の組の区切り。 */
const JWT_PART_SEPARATOR = '.';

/** 区切りの中の名前と値の区切り（path の引数の `;`、名前と値の `=`、並びの `,`、DEF-155 で足した角括弧 `[`・`]`）。 */
const SEGMENT_PART_SEPARATORS = /[;=,[\]]/u;

/** 区切りの中の項目の区切り（path の引数の `;`、並びの `,`。T34R2-fix。DEF-155 で足した角括弧 `[`・`]`）。 */
const SEGMENT_ITEM_SEPARATORS = /[;,[\]]/u;

/** 項目の名前と値の区切り（T34R2-fix。最初の 1 つで分ける）。 */
const NAME_VALUE_SEPARATOR = '=';

const BASE64URL_CHARACTERS = /^[A-Za-z0-9_-]+$/u;
/** 標準の base64 の形（英数字と `+`・`/`、末尾に 0〜2 個の `=`）。 */
const STANDARD_BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/u;
/** 標準の base64 に特有の文字（`+` か `=`）。 */
const STANDARD_BASE64_MARK = /[+=]/u;
/** メールアドレスの名前と domain の区切り。 */
const EMAIL_AT = '@';
/** domain の区切り。 */
const DOMAIN_DOT = '.';
const LOWER_ALNUM_CHARACTERS = /^[a-z0-9]+$/u;
const HEX_CHARACTERS = /^[0-9A-Fa-f]+$/u;
const UPPER_LETTER = /[A-Z]/u;
const LOWER_LETTER = /[a-z]/u;
const DIGIT = /[0-9]/u;
const DIGITS = /[0-9]/gu;
const UUID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;

/** UUID（8-4-4-4-12 の 16 進）の形か（T37b: 送らずに観察した型の filter の値と、画面の path の ID の比べ `src/core/api-request-shape.ts` も使う）。 */
export const isUuidText = (value: string): boolean => UUID_SHAPE.test(value);

/** 区切りを decode する（decode できなければ、そのまま）。 */
const decodedSegmentOf = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** JWT の形か（3 つの base64url の組。初めの 2 つは空でなく、初めの組が `JWT_HEADER_PREFIX` で始まる。署名の組は空でもよい）。 */
const isJwtShape = (value: string): boolean => {
  const parts = value.split(JWT_PART_SEPARATOR);
  if (parts.length !== JWT_PART_COUNT) {
    return false;
  }
  const [header = '', payload = '', signature = ''] = parts;
  return header.startsWith(JWT_HEADER_PREFIX)
    && BASE64URL_CHARACTERS.test(payload)
    && BASE64URL_CHARACTERS.test(header)
    && (signature.length === 0 || BASE64URL_CHARACTERS.test(signature));
};

/** 標準の base64 の形の値か（T34R-fix-b。条件はファイルの先頭）。 */
const isStandardBase64Like = (value: string): boolean =>
  value.length >= MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH && STANDARD_BASE64_SHAPE.test(value) && STANDARD_BASE64_MARK.test(value);

/** メールアドレスの形か（T34R-fix-b。`@` の前に文字があり、`@` の後に `.` を含む文字がある）。 */
const isEmailLike = (value: string): boolean => {
  const at = value.indexOf(EMAIL_AT);
  return at > 0 && value.slice(at + EMAIL_AT.length).includes(DOMAIN_DOT);
};

/** 区切りの 1 つの部分（decode した後）が、値に見えるか（条件はファイルの先頭）。 */
const isValueLikePart = (value: string): boolean => {
  if (value.length === 0 || UUID_SHAPE.test(value)) {
    return false;
  }
  if (isEmailLike(value) || isStandardBase64Like(value)) {
    return true;
  }
  if (isJwtShape(value)) {
    return true;
  }
  if (HEX_CHARACTERS.test(value) && value.length >= MIN_VALUE_LIKE_HEX_LENGTH) {
    return true;
  }
  if (
    BASE64URL_CHARACTERS.test(value)
    && value.length >= MIN_VALUE_LIKE_BASE64URL_LENGTH
    && UPPER_LETTER.test(value)
    && LOWER_LETTER.test(value)
    && DIGIT.test(value)
  ) {
    return true;
  }
  return LOWER_ALNUM_CHARACTERS.test(value)
    && value.length >= MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH
    && (value.match(DIGITS) ?? []).length >= MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS;
};

/** 項目（`;`・`,` で分けたもの）の値の側（最初の `=` の後ろ全体。`=` がなければ項目の全体。T34R2-fix）。 */
const itemValueOf = (item: string): string => {
  const at = item.indexOf(NAME_VALUE_SEPARATOR);
  return at < 0 ? item : item.slice(at + NAME_VALUE_SEPARATOR.length);
};

/**
 * 値（区切りでない文字列。decode しない）が、値に見えるか（T34R-fix-b）。全体が標準の base64 の形かメールアドレスの形なら真。T34R2-fix: `;`・`,` で
 * 分けた項目と、その値の側（`=` の埋め字を含む）が標準の base64 の形かメールアドレスの形なら真。ほかは `;`・`=`・`,` で部分に分け、どれかの部分が値に
 * 見えれば真。DEF-155: 項目と部分の区切りに角括弧 `[`・`]` を含む。
 */
export const isValueLikeText = (text: string): boolean =>
  isStandardBase64Like(text)
  || isEmailLike(text)
  || text.split(SEGMENT_ITEM_SEPARATORS).some((item) => {
    const value = itemValueOf(item);
    return isStandardBase64Like(item) || isStandardBase64Like(value) || isEmailLike(value);
  })
  || text.split(SEGMENT_PART_SEPARATORS).some(isValueLikePart);

/**
 * path の 1 つの区切り（percent-encode を含んでよい）が、値に見えるか。decode した区切りを `isValueLikeText` で判定する（T34e fix round 2: 部分に分ける。
 * T34R-fix-b: 分ける前の全体で標準の base64 とメールアドレスの形を見る）。
 */
export const isValueLikePathSegment = (segment: string): boolean => isValueLikeText(decodedSegmentOf(segment));

/** path の値に見える区切りを `REDACTED_PATH_SEGMENT` にする（ほかの区切りは書かれたまま）。 */
export const redactValueLikePathSegments = (path: string): string =>
  path.split(PATH_SEPARATOR).map((segment) => (isValueLikePathSegment(segment) ? REDACTED_PATH_SEGMENT : segment)).join(PATH_SEPARATOR);

/**
 * path に、伏せた区切り（`REDACTED_PATH_SEGMENT`）があるか（T43R-fix の M-7。入口の確かめの案、登録の振り分け、ジョブの詳細の表示の判定を 1 か所にした）。
 */
export const hasRedactedPathSegment = (path: string): boolean => path.split(PATH_SEPARATOR).includes(REDACTED_PATH_SEGMENT);

/** path に、伏せるべき値に見える区切りが残っているか。 */
export const hasValueLikePathSegment = (path: string): boolean => path.split(PATH_SEPARATOR).some(isValueLikePathSegment);
