// T34e fix round 1（Task 34 の設計書 8 章の T34e の行。設計者の判断: path の伏せ方を、名前の照合から「値に見える区切り」に替えた）: URL の path の
// 値に見える区切りを伏せる唯一の判定（`src/core/url-path-redaction.ts`）。
// - path を `/` で区切り、各区切りを decode した後で、さらに `;`・`=`・`,` で部分に分け、どれかの部分が値に見えれば、その区切り全体を `[REDACTED]` に
//   する（T34e fix round 2。`;jsessionid=<長い値>` の形）。値に見える条件（名前つきの定数）:
//   (a1) base64url の文字（英数字と `-`・`_`）だけで `MIN_VALUE_LIKE_BASE64URL_LENGTH` 以上、英大文字・英小文字・数字をすべて含む。
//   (a2) 英小文字と数字だけで `MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH` 以上、数字を `MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS` 以上含む。
//   (b) 16 進の文字だけで `MIN_VALUE_LIKE_HEX_LENGTH` 以上。
//   (c) JWT の形（`.` で区切った 3 つの base64url の組で、初めの組が JSON の始まり `eyJ` で始まる）。
//   UUID（8-4-4-4-12 の形）は ID として伏せない。
// - T34R-fix-b（独立レビュー T34R の M-2）: 区切りを `;`・`=`・`,` で分ける前に、区切り全体（decode の後）が標準の base64 の形（英数字と `+`・`/`、末尾に
//   0〜2 個の `=`、`MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH` 字以上、`+` か `=` を 1 つ以上含む）なら伏せる。メールアドレスの形（`@` の前後に文字があり、
//   `@` の後に `.` を含む）の区切り・部分も伏せる（個人の情報）。区切りでない値の判定（`isValueLikeText`。必須の query の値の検証が使う）も同じ条件。
// - T34R2-fix（2 回目のレビュー T34R2 の M-2）: `;`・`,` で分けた各項目と、`名前=値` の値の側（最初の `=` の後ろ全体。`=` の埋め字を含む）にも、
//   標準の base64 の条件を当てる。`%2F` を含む標準の base64（`+`・`=` なし）は、既知の限界として表に固定する。
// - 下の表は、誤って伏せる例と、伏せない例（手続きの名前、短い値、数字だけの ID）と、伏せない（限界）の例も固定する（閾値を変えるときは、表を直して
//   理由を書く）。
// 例の値は、匿名の値だけを使う（実在の token ではない）。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import {
  MIN_VALUE_LIKE_BASE64URL_LENGTH,
  MIN_VALUE_LIKE_HEX_LENGTH,
  MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS,
  MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH,
  MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH,
  REDACTED_PATH_SEGMENT,
  hasValueLikePathSegment,
  isValueLikePathSegment,
  isValueLikeText,
  redactValueLikePathSegments,
} from '../../src/core/url-path-redaction.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLWV4YW1wbGU';
const BASE64URL_24 = 'AbCdEfGhIjKlMnOpQrStUv12';
const HEX_32_DIGITS = '12345678901234567890123456789012';
const HEX_64 = 'a'.repeat(32) + '0'.repeat(32);
const UUID = '550e8400-e29b-41d4-a716-446655440000';
/** (a2) 英小文字と数字だけの 32 字（数字 6 つ）。 */
const LOWER_ALNUM_32 = 'abcdefghijklmnopqrstuvwxyz012345';
/** 標準の base64 の `+` と `==` を含む 31 字（T34R2-fix）。 */
const STANDARD_BASE64_VALUE = 'Zm9vYmFyYmF6+cXV4cXV1eGNvcmdl==';

describe('T34e fix round 1 and 2: the value-like segments of a URL path', () => {
  it('has the named thresholds and the redacted marker', () => {
    expect(MIN_VALUE_LIKE_BASE64URL_LENGTH).toBe(24);
    expect(MIN_VALUE_LIKE_HEX_LENGTH).toBe(32);
    expect(MIN_VALUE_LIKE_LOWER_ALNUM_LENGTH).toBe(32);
    expect(MIN_VALUE_LIKE_LOWER_ALNUM_DIGITS).toBe(4);
    expect(MIN_VALUE_LIKE_STANDARD_BASE64_LENGTH).toBe(20);
    expect(REDACTED_PATH_SEGMENT).toBe(REDACTED);
  });

  it.each([
    // 伏せない: 送信先の path（利用者が登録を決める材料）。
    ['/auth/v1/token', '/auth/v1/token'],
    ['/rest/v1/rpc/resolve_tenant', '/rest/v1/rpc/resolve_tenant'],
    ['/functions/v1/sync_access', '/functions/v1/sync_access'],
    ['/rest/v1/rpc/log_login', '/rest/v1/rpc/log_login'],
    // 伏せない: ID（数字の ID、UUID は大文字でも）。
    ['/admin/members/123/edit', '/admin/members/123/edit'],
    [`/items/${UUID}`, `/items/${UUID}`],
    [`/items/${UUID.toUpperCase()}`, `/items/${UUID.toUpperCase()}`],
    // 伏せない: 閾値より短い値、数字だけの 31 桁、英字だけの長い語、版の番号とファイルの名前。
    [`/s/${BASE64URL_24.slice(1)}`, `/s/${BASE64URL_24.slice(1)}`],
    [`/n/${HEX_32_DIGITS.slice(1)}`, `/n/${HEX_32_DIGITS.slice(1)}`],
    ['/abcdefghijklmnopqrstuvwxyz', '/abcdefghijklmnopqrstuvwxyz'],
    [`/${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`, `/${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`],
    // 伏せない（T34e fix round 2）: 手続きの名前（英小文字と `_`、末尾に数字）、英大文字と英小文字だけの 24 字、英小文字と数字の短い値・数字の少ない値。
    ['/rest/v1/rpc/list_members_with_details_v2', '/rest/v1/rpc/list_members_with_details_v2'],
    ['/rest/v1/rpc/sync_access_for_all_members_2024', '/rest/v1/rpc/sync_access_for_all_members_2024'],
    ['/AbCdEfGhIjKlMnOpQrStUvWx', '/AbCdEfGhIjKlMnOpQrStUvWx'],
    [`/t/${LOWER_ALNUM_32.slice(1)}`, `/t/${LOWER_ALNUM_32.slice(1)}`],
    ['/t/abcdefghijklmnopqrstuvwxyzabc123', '/t/abcdefghijklmnopqrstuvwxyzabc123'],
    // 伏せない: 区切りの中の名前と短い値。
    ['/a=b;c,d', '/a=b;c,d'],
    ['/app;lang=ja', '/app;lang=ja'],
    ['/lib/1.2.3/app.min.js', '/lib/1.2.3/app.min.js'],
    ['/assets/bundle.12345.js', '/assets/bundle.12345.js'],
    ['/', '/'],
    // 伏せる: JWT、長い base64url、長い 16 進（数字だけを含む）、percent-encode した値。
    [`/session/${JWT}`, `/session/${REDACTED}`],
    [`/reset/${BASE64URL_24}`, `/reset/${REDACTED}`],
    [`/n/${HEX_32_DIGITS}`, `/n/${REDACTED}`],
    [`/k/${HEX_64}/x`, `/k/${REDACTED}/x`],
    [`/v/${BASE64URL_24.slice(0, 4)}%2D${BASE64URL_24.slice(4)}`, `/v/${REDACTED}`],
    // 伏せる（T34e fix round 2）: 英小文字と数字だけの 32 字（数字 4 つ以上）、区切りの中の名前と値（どれかの部分が値に見えれば区切り全体）。
    [`/t/${LOWER_ALNUM_32}`, `/t/${REDACTED}`],
    [`/app;jsessionid=${BASE64URL_24}/next`, `/${REDACTED}/next`],
    [`/x/token=${JWT}`, `/x/${REDACTED}`],
    [`/x/a,${HEX_32_DIGITS}`, `/x/${REDACTED}`],
    [`/x/a%3D${BASE64URL_24}`, `/x/${REDACTED}`],
    // 伏せる（T34R-fix-b）: 標準の base64（`=` の埋め字、`+`、`%2B` で encode した `+`）、メールアドレスの形（区切りと、区切りの中の部分）。
    ['/x/YWJjZGVmZ2hpamtsbW5vcA==', `/x/${REDACTED}`],
    ['/x/Zm9vYmFy+YmF6cXV4cXV1eA', `/x/${REDACTED}`],
    ['/x/Zm9vYmFy%2BYmF6cXV4cXV1eA/y', `/x/${REDACTED}/y`],
    ['/x/abcdefghijklmnopqrs=', `/x/${REDACTED}`],
    ['/users/alice@example.invalid/edit', `/users/${REDACTED}/edit`],
    ['/x/user=alice%40example.invalid', `/x/${REDACTED}`],
    ['/x/a;mail=b.c@d.example', `/x/${REDACTED}`],
    // 伏せる（T34R2-fix）: 区切りの中の `名前=値` の値の側と、`,` の後ろの標準の base64（`=` の埋め字を含む）。encode した `+`・`=` も。
    [`/x;sid=${STANDARD_BASE64_VALUE}`, `/${REDACTED}`],
    [`/y/token=${STANDARD_BASE64_VALUE}`, `/y/${REDACTED}`],
    [`/x/a,${STANDARD_BASE64_VALUE}`, `/x/${REDACTED}`],
    ['/x/sid%3DZm9vYmFyYmF6%2BcXV4cXV1eGNvcmdl%3D%3D', `/x/${REDACTED}`],
    ['/x/a;b=c,Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZg=/d', `/x/${REDACTED}/d`],
    // 伏せる（DEF-155）: 角括弧で囲まれた値（`login[<値>]` の形。角括弧も区切り）。encode した角括弧、`[` の後ろの標準の base64（`=` の埋め字だけ）も。
    [`/x/login[${HEX_32_DIGITS}]`, `/x/${REDACTED}`],
    [`/x/a[${BASE64URL_24}]/y`, `/x/${REDACTED}/y`],
    [`/x/[${JWT}]`, `/x/${REDACTED}`],
    [`/x/user[${LOWER_ALNUM_32}][name]`, `/x/${REDACTED}`],
    [`/x/login%5B${HEX_32_DIGITS}%5D`, `/x/${REDACTED}`],
    ['/x/q[YWJjZGVmZ2hpamtsbW5vcA==]', `/x/${REDACTED}`],
    // 伏せない（DEF-155）: 値に見えない角括弧の区切り（添え字、ふつうの名前、短い値）。
    ['/x/items[0]', '/x/items[0]'],
    ['/x/a[b]', '/x/a[b]'],
    ['/x/login[email]/edit', '/x/login[email]/edit'],
    ['/x/filter[status][]=open', '/x/filter[status][]=open'],
    ['/x/items%5B12%5D', '/x/items%5B12%5D'],
    // 伏せない（限界。T34R2-fix で既知の限界として固定する）: `%2F` を含む標準の base64（`+` も `=` もない）。
    ['/x/QUJDREVGR0hJSktM%2FTU5PUFFSU1RVVldY', '/x/QUJDREVGR0hJSktM%2FTU5PUFFSU1RVVldY'],
    // 伏せない: 標準の base64 の形でも 19 字以下、`+` も `=` もない英数字だけ（ほかの条件に当たらないもの）、メールの形でないもの。
    ['/x/abcdefghijklmnopq=', '/x/abcdefghijklmnopq='],
    ['/x/abcdefghijklmnopqrstuvwxyz', '/x/abcdefghijklmnopqrstuvwxyz'],
    ['/x/@home', '/x/@home'],
    ['/x/a@b', '/x/a@b'],
    ['/x/name@', '/x/name@'],
    // 伏せない（限界。T34R-fix-b で既知の限界として固定する）: 23 字以下の base64url、数字のない英大文字と英小文字、JWT でない `.` 区切り、`~` で
    // 始まる値、16 進 31 字以下。
    ['/x/AbCdEfGhIjKlMnOpQrStUv1', '/x/AbCdEfGhIjKlMnOpQrStUv1'],
    ['/x/AbCdEfGhIjKlMnOpQrStUvWxYz', '/x/AbCdEfGhIjKlMnOpQrStUvWxYz'],
    ['/x/AbCd12EfGh34.IjKl56MnOp78.QrSt90UvWx12', '/x/AbCd12EfGh34.IjKl56MnOp78.QrSt90UvWx12'],
    ['/x/~AbCdEfGhIjKlMnOpQrStUv12', '/x/~AbCdEfGhIjKlMnOpQrStUv12'],
    ['/x/abcdef0123456789abcdef012345678', '/x/abcdef0123456789abcdef012345678'],
    // 誤って伏せる例（固定する）: 英大文字・英小文字・数字を含む 24 字以上の名前の区切り。
    ['/api/getMembersWithDetailsV2Api', `/api/${REDACTED}`],
    // 誤って伏せる例（固定する）: a〜f の英字だけの長い区切り（16 進の文字だけなので）。
    [`/x/${'abcdef'.repeat(6)}`, `/x/${REDACTED}`],
  ])('turns %s into %s', (path, expected) => {
    expect(redactValueLikePathSegments(path)).toBe(expected);
    expect(hasValueLikePathSegment(path)).toBe(expected !== path);
    expect(hasValueLikePathSegment(redactValueLikePathSegments(path))).toBe(false);
  });

  it('judges one segment after decoding it, and keeps a segment that cannot be decoded as it is', () => {
    expect(isValueLikePathSegment(BASE64URL_24)).toBe(true);
    expect(isValueLikePathSegment(`sid=${BASE64URL_24}`)).toBe(true);
    // 区切りでない値（decode しない）: 同じ条件。`password` のような語は当たらない。
    expect(isValueLikeText(JWT)).toBe(true);
    expect(isValueLikeText('YWJjZGVmZ2hpamtsbW5vcA==')).toBe(true);
    expect(isValueLikeText('someone@example.invalid')).toBe(true);
    expect(isValueLikeText('password')).toBe(false);
    expect(isValueLikeText('refresh_token')).toBe(false);
    expect(isValueLikeText('a%2Bb')).toBe(false);
    // DEF-155: 角括弧で囲まれた値は、区切りでない値でも当たる。添え字やふつうの名前、伏せ字の表記そのものは当たらない。
    expect(isValueLikePathSegment(`login[${HEX_32_DIGITS}]`)).toBe(true);
    expect(isValueLikeText(`login[${HEX_32_DIGITS}]`)).toBe(true);
    expect(isValueLikeText('items[0]')).toBe(false);
    expect(isValueLikeText('a[b]')).toBe(false);
    expect(isValueLikeText(REDACTED)).toBe(false);
    expect(isValueLikePathSegment(`${BASE64URL_24.slice(0, 4)}%5F${BASE64URL_24.slice(4)}`)).toBe(true);
    expect(isValueLikePathSegment('%E0%A4%A')).toBe(false);
    expect(isValueLikePathSegment(REDACTED_PATH_SEGMENT)).toBe(false);
    expect(isValueLikePathSegment('')).toBe(false);
  });
});
