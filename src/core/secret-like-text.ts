// 自由に書く文の「秘密に見える値」を判定する唯一の部品（PL-F 修正の 1 回目。安全のレビュー PL-REV の Minor 2）。利用者が書く参照（環境の証跡の参照。
// 「書き込みも試す」の「確かめた記録がある」と、詳しい内容の編集の同じ欄）に、資格情報を書かせないために拒む。次のどれかに当たれば真。
// 1. userinfo のある絶対形の URL（`scheme://<userinfo>@`）。
// 2. 秘密に見える名前の `name=value`。名前の判定は `secret-query-names.ts` の方針 1（`isSecretUrlQueryParameterName`。完全一致）を使う（新しい名前の
//    一覧を作らない。部分一致の方針 2 は `auth-server` のような語に当たるため使わない）。値が空なら当たらない。
// 3. 認証の scheme（`Bearer`・`Basic`。大文字小文字を問わない）の後に、空白を挟んで値に見える文字の連なりが続く形。値に見える条件は、数字、`+`・`/`・`=`、
//    2 文字目より後の英大文字のどれかを含むこと（`Basic check` のようなふつうの文を通すため）。
// - 伏せ字（`src/control/ui-server-log.ts` の `redactUiServerLogText`）とは意味が違う（伏せ字は拒むより広く当てる）ので、ここは拒む判定だけを持つ。
// - 既知の限界: 名前のない値だけ（例: 長い token だけを書いた文）、`name: value` の形、ほかの scheme（`Digest` など）は当てない。
import { isSecretUrlQueryParameterName } from './secret-query-names.js';

/** 1. userinfo のある絶対形の URL（scheme の後の `//` から、最初の `/`・`?`・`#`・空白の前に `@` がある）。 */
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]*@/iu;

/** 2. `name=value` の組（名前は英数字と `_`・`.`・`-`・`%`・`+`。前は文の始まりか、名前に使わない文字。値は空白と `&`・`;`・`#` の前まで）。 */
const NAME_VALUE_PAIR = /(?:^|[^A-Za-z0-9_.%+-])([A-Za-z0-9_.%+-]+)=([^\s&;#]+)/gu;

/** 3. 認証の scheme と、その後の値の候補（RFC 9110 の token68 の文字）。 */
const AUTH_SCHEME_VALUE = /(?:^|[^A-Za-z0-9])(?:bearer|basic)\s+([A-Za-z0-9\-._~+/]+=*)/giu;

/** 3. 値に見える印（数字、`+`・`/`・`=`）。 */
const VALUE_MARK = /[0-9+/=]/u;

/** 3. 2 文字目より後の英大文字。 */
const INNER_UPPER_LETTER = /^.[^A-Z]*[A-Z]/u;

const hasSecretLikeNameValuePair = (text: string): boolean =>
  [...text.matchAll(NAME_VALUE_PAIR)].some((match) => isSecretUrlQueryParameterName(match[1] ?? ''));

const hasAuthSchemeValue = (text: string): boolean =>
  [...text.matchAll(AUTH_SCHEME_VALUE)].some((match) => {
    const value = match[1] ?? '';
    return VALUE_MARK.test(value) || INNER_UPPER_LETTER.test(value);
  });

/** 自由に書く文が、秘密に見える値を含むか（条件はファイルの先頭）。 */
export const isSecretLikeText = (text: string): boolean =>
  URL_WITH_USERINFO.test(text) || hasSecretLikeNameValuePair(text) || hasAuthSchemeValue(text);
