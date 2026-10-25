// 秘密に見える名前の方針の、語の一覧と比べ方の唯一の owner（CCX-4。共通化の台帳の N3）。次の 4 つの方針を、名前を付けて並べる。
// 4 つは意味が違う（同じ名前でも結果が違ってよい）ので、まとめない。
// 1. URL の query の伏せ字（完全一致）: `SECRET_URL_QUERY_PARAMETER_NAMES`、`isSecretUrlQueryParameterName`。Task 25 の設計書 4.6 の URL の
//    伏せ字（Task 25・26）と、READ の定義の拒否（T27c）が使う。T25f で `src/safety/redact.ts` に作り、T27c でここへ移した（Task 27 の設計書の
//    変更履歴「Blocker: T27c」の行の (1)）。`src/safety/redact.ts` は、今の名前のまま公開し直す。
// 2. 認証の設定の拒否（部分一致。fail-closed）: `SECRET_LIKE_QUERY_NAME_WORDS`、`isSecretLikeQueryName`。`loginStartUrl` の query の名前を
//    拒む（`AUTH_SETUP_SECRET_LIKE_VALUE`）。`src/control/auth/auth-setup-contracts.ts` は一覧を今の名前のまま公開し直し、
//    `auth-setup-policy.ts` は判定をここから使う。
// 3. header の伏せ字（部分一致）: `SECRET_LIKE_HEADER_EXACT_NAMES`、`SECRET_LIKE_HEADER_NAME_WORDS`、`isSecretLikeHeaderName`。公開監査の
//    Network の Evidence の header の値を伏せる（`src/safety/redact.ts` の `redactHeaders`）。
// 4. 書き込みの照合で名前だけを照らす、ページが読み込みごとに作る値の欄の名前の語（T31R2-fix-1。DEF-108 の残り）:
//    `PAGE_ISSUED_TOKEN_FIELD_WORDS`。比べ方（欄の名前の語の単位）は、欄の名前の語の分け方の owner に依るので、判定
//    `isPageIssuedTokenFieldName` は `src/discovery/read-check-contracts.ts` に置く（このファイルは import を持たないため。一覧はここにだけ書く）。
// 5. ログインの段の観察の、成功の鍵の名前の案に残してよい端の部分の語（T43R2-fix。Task 43 の設計書 7 章の最後の行）:
//    `LOGIN_STORAGE_KEY_GENERAL_WORDS`。比べ方（NFKC と大文字小文字を畳んだ部分の完全一致）は `src/discovery/login-observation.ts`
//    （このファイルは import を持たず、NFKC の正規化は `src/core/text.ts` の部品だけが書くため。一覧はここにだけ書く）。
// 6. API の書き込みの本文の鍵の名前（部分一致。fail-closed。T38R-fix の I-2）: `API_WRITE_SECRET_LIKE_KEY_WORDS`、
//    `API_WRITE_SECRET_LIKE_KEY_SEGMENTS`。ページが決める鍵と、登録の ID を読む応答の鍵（値を照らさない鍵）を拒む
//    （`src/control/approval/scenario-policy.ts`）。T38R2-fix の M-1: 比べ方（NFKC と大文字小文字を畳んだ形の部分一致と、欄の名前の語の単位の一致）は
//    `src/discovery/classify.ts` の `isApiWriteKeyNameSecretLike`（このファイルは import を持たず、NFKC の正規化は `src/core/text.ts` の部品だけが書き、
//    欄の名前の語の分け方の owner は `classify.ts` のため。方針 4・5 と同じ。一覧はここにだけ書く）。T41a: 語を足し、結合文字を除いた形（NFD の後。
//    `src/core/text.ts` の `stripCombiningMarks`）でも比べる。
// - `src/control/` と `src/discovery/` は `src/safety/` を import できない（`tests/architecture/control-boundary.test.ts` の (b) など）ので、
//   ここを直接使う。純粋な定義と関数だけのファイル（import なし。`tests/architecture/secret-name-policies.test.ts` の (b)）。
// - 秘密に見える語の一覧（配列のリテラル）は、`src/**` の中で、ここにだけ書く（同じ Gate の (a)）。

// ---------------------------------------------------------------------------------------------------------------
// 方針 1: URL の query の伏せ字（完全一致）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 値を伏せる query の名前（名前つきの閉じた一覧。小文字で、よく書かれる形）。比べ方は `isSecretUrlQueryParameterName`: percent-encode と `+` を
 * 戻した名前を小文字にし、区切り（`-`、`_`、`.`、空白）を除いた形が、一覧のどれかの同じ形と完全に一致すれば当たる（名前の一部が一致しても
 * 当たらない。`keyword` や `author` の値は伏せない）。
 */
export const SECRET_URL_QUERY_PARAMETER_NAMES = Object.freeze([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth_token',
  'session_token',
  'csrf_token',
  'xsrf_token',
  'authenticity_token',
  'jwt',
  'ticket',
  'session',
  'sessionid',
  'sid',
  'phpsessid',
  'jsessionid',
  'auth',
  'authorization',
  'key',
  'apikey',
  'api_key',
  'access_key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'pass',
  'otp',
  'code',
  'state',
  'nonce',
  'csrf',
  'xsrf',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'samlrequest',
  'samlresponse',
  'relaystate',
  'credential',
  'credentials',
] as const);

/** 名前を比べる形にするときに除く区切り。 */
const QUERY_NAME_SEPARATORS = /[-_.\s]/gu;
/** percent-encode された 1 バイト。 */
const PERCENT_ENCODED_OCTET = /%([0-9a-fA-F]{2})/gu;
/** percent-encode の 16 進。 */
const HEXADECIMAL_RADIX = 16;
/** form の書き方の空白。 */
const FORM_SPACE = '+';

/** query の名前を、比べる形にする（`+` と percent-encode を戻し、小文字にし、区切りを除く）。 */
const comparableQueryName = (name: string): string => name
  .split(FORM_SPACE)
  .join(' ')
  .replace(PERCENT_ENCODED_OCTET, (_match, octet: string) => String.fromCharCode(Number.parseInt(octet, HEXADECIMAL_RADIX)))
  .toLowerCase()
  .replace(QUERY_NAME_SEPARATORS, '');

const SECRET_QUERY_NAME_SET: ReadonlySet<string> = new Set(SECRET_URL_QUERY_PARAMETER_NAMES.map(comparableQueryName));

/** query の名前（書かれたままの形。percent-encode を含んでよい）が、値を伏せる名前か（比べ方は `SECRET_URL_QUERY_PARAMETER_NAMES`）。 */
export function isSecretUrlQueryParameterName(name: string): boolean {
  const comparable = comparableQueryName(name);
  return comparable.length > 0 && SECRET_QUERY_NAME_SET.has(comparable);
}

// ---------------------------------------------------------------------------------------------------------------
// 方針 2: 認証の設定の拒否（部分一致。fail-closed。Task 25 の設計書 4.1。T25a で `auth-setup-contracts.ts` と `auth-setup-policy.ts` に作り、
// CCX-4 でここへ移した）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 秘密に見える query の名前の語（閉じた一覧）。`loginStartUrl` の query の名前を小文字にし、英数字以外を除いた文字列が、この語の
 * どれかを含めば拒む（`AUTH_SETUP_SECRET_LIKE_VALUE`。fail-closed なので、`author` のような語も拒む）。比べ方は `isSecretLikeQueryName`。
 */
export const SECRET_LIKE_QUERY_NAME_WORDS = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'session',
  'sid',
  'auth',
  'apikey',
  'credential',
  'code',
  'state',
] as const);

/** 認証の設定の query の名前の比べで除く文字（英数字以外）。 */
const NON_ALPHANUMERIC = /[^a-z0-9]/gu;

/** query の名前が、秘密に見える語（`SECRET_LIKE_QUERY_NAME_WORDS`）を含むか。 */
export function isSecretLikeQueryName(name: string): boolean {
  const compact = name.toLowerCase().replace(NON_ALPHANUMERIC, '');
  return SECRET_LIKE_QUERY_NAME_WORDS.some((word) => compact.includes(word));
}

// ---------------------------------------------------------------------------------------------------------------
// 方針 3: header の伏せ字（部分一致。公開監査の Network の Evidence。`src/safety/redact.ts` の `redactHeaders` から CCX-4 でここへ移した）
// ---------------------------------------------------------------------------------------------------------------

/** 値を伏せる header の名前（小文字にした名前の完全一致。区切りは除かない）。 */
export const SECRET_LIKE_HEADER_EXACT_NAMES = Object.freeze([
  'cookie',
  'set-cookie',
] as const);

/** 値を伏せる header の名前の語（小文字にし、`-` と `_` を除いた名前が、この語のどれかを含めば当たる）。 */
export const SECRET_LIKE_HEADER_NAME_WORDS = Object.freeze([
  'authorization',
  'token',
  'session',
  'apikey',
  'authkey',
  'subscriptionkey',
  'secret',
] as const);

// ---------------------------------------------------------------------------------------------------------------
// 方針 4: 書き込みの照合で名前だけを照らす、ページが読み込みごとに作る値の欄の名前の語（T31R2-fix-1）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ページが読み込みごとに作る値（CSRF のトークンなど）の欄の名前の語（閉じた一覧。T31R2-fix-1。DEF-108 の残り）。判定は
 * `src/discovery/read-check-contracts.ts` の `isPageIssuedTokenFieldName`（欄の名前の語の単位で比べる。`authenticity_token`・`_token`・
 * `__RequestVerificationToken` などは `token` の語で、Django の `csrfmiddlewaretoken` は 1 語の名前として当たる）。ほかの秘密に見える名前
 * （方針 1 の `code`・`key`・`ticket` など）は含めない（値を読めず照らせないので、その欄がある画面の書き込みは止める）。
 */
export const PAGE_ISSUED_TOKEN_FIELD_WORDS = Object.freeze(['csrf', 'xsrf', 'token', 'nonce', 'csrfmiddlewaretoken'] as const);

// ---------------------------------------------------------------------------------------------------------------
// 方針 5: ログインの段の観察の、成功の鍵の名前の案に残してよい端の部分の語（T43R2-fix。Task 43 の設計書 7 章の最後の行。設計者の既定）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 鍵の名前を区切りで分けた最初か最後の部分が、この語（NFKC と大文字小文字を畳んだ形の完全一致。比べ方は `src/discovery/login-observation.ts`）に
 * 当たるときだけ、その側を成功の鍵の名前の接頭辞か接尾辞の案にする（利用者の名前や ID が端に来る形を残さない。当たらない側は空にし、利用者が入れる）。
 * 小文字の、鍵の名前によく書かれる、利用者に固有でない語だけ。
 */
export const LOGIN_STORAGE_KEY_GENERAL_WORDS = Object.freeze([
  'token',
  'tokens',
  'auth',
  'session',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'access',
  'refresh',
  'jwt',
  'credentials',
] as const);

// ---------------------------------------------------------------------------------------------------------------
// 方針 6: API の書き込みの本文の鍵の名前（部分一致。fail-closed。T38R-fix の I-2。Task 38 の設計書 7 章の最後の行）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 秘密に見える API の本文の鍵の語（閉じた一覧。NFKC と大文字小文字を畳み、文字と数字以外を除いた形で書く）。ページが決める鍵と、登録の ID を読む
 * 応答の鍵（値を照らさない鍵）に使う。鍵の名前を同じ形にした文字列が、この語のどれかを含めば当たる（fail-closed なので、`author` のような語も当たる）。
 * 比べ方は `src/discovery/classify.ts` の `isApiWriteKeyNameSecretLike`。T38R2-fix の M-1 で、CSRF のトークン・暗証の語・カードの確かめの番号・署名の鍵・
 * 確かめの番号の語と、日本語の語（NFKC で英字にならない。半角カナは NFKC で全角になる）を足した。
 */
export const API_WRITE_SECRET_LIKE_KEY_WORDS = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'session',
  'auth',
  'apikey',
  'credential',
  'privatekey',
  'bearer',
  'otp',
  'cookie',
  'jwt',
  'signature',
  'csrf',
  'xsrf',
  'passcode',
  'passphrase',
  'pincode',
  'cvv',
  'cvc',
  'signingkey',
  'verificationcode',
  'パスワード',
  'トークン',
  '暗証番号',
  // T41a（Task 41 の設計書 3.1）: 秘密の鍵・ドイツ語のパスワード・暗号の鍵・ライセンスの鍵・HMAC・確かめの番号と、日本語の語。`refresh`・`card_number` は
  // 正当な欄に当たるので足さない。
  'privkey',
  'passwort',
  'encryptionkey',
  'licensekey',
  'hmac',
  'securitycode',
  '秘密鍵',
  '暗証',
  'セッション',
] as const);

/**
 * 秘密に見える API の本文の鍵の、語の単位の語（閉じた一覧。部分一致にすると、ふつうの語（`shipping`・`inside` など）にも当たる短い語）。鍵の名前を
 * 欄の名前の語（`src/discovery/classify.ts` の `fieldNameWordsOf`。区切り、文字と数字の境、camelCase と頭字語の境で分け、NFKC と大文字小文字を畳む）に
 * 分け、どれかがこの語と一致すれば当たる（`pin1` は `pin`・`1`、`PINCode` は `pin`・`code`）。
 */
export const API_WRITE_SECRET_LIKE_KEY_SEGMENTS = Object.freeze([
  'pin', 'pwd', 'sid', 'mfa', 'pass',
  // T41a（Task 41 の設計書 3.1）: パスワードの略・ハッシュの塩・社会保障番号（部分一致にすると `power`・`basalt`・`classname` などに当たる）。
  'pw', 'salt', 'ssn',
] as const);

/**
 * T44g（Task 44 の設計書 P4-2。設計者の判断）: 方針 6 の部分一致の誤検知として除く、鍵の名前（名前つきの閉じた一覧。比べる形で書く）。鍵の名前の比べる形
 * （NFKC と大文字小文字を畳み、文字と数字以外を除いた形。結合文字を除いた形も）が、この語にちょうど当たる鍵だけを除く（`author_token` などは今どおり当たる）。
 * `author` は `auth`、`footprint` は `otp` の部分一致に当たっていた。`session_count`・`hmac_ok` は、`session`・`hmac` の語そのものを含むので除かない。
 */
export const API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES = Object.freeze([
  'author',
  'footprint',
] as const);

/** header の名前の比べで除く区切り。 */
const HEADER_NAME_SEPARATORS = /[-_]/gu;

/**
 * header の名前が、値を伏せる名前か。小文字にした名前が `SECRET_LIKE_HEADER_EXACT_NAMES` のどれかと一致するか、小文字にして区切りを除いた
 * 名前が `SECRET_LIKE_HEADER_NAME_WORDS` の語のどれかを含めば当たる。
 */
export function isSecretLikeHeaderName(name: string): boolean {
  const lowerName = name.toLowerCase();
  const compactName = lowerName.replace(HEADER_NAME_SEPARATORS, '');
  return SECRET_LIKE_HEADER_EXACT_NAMES.some((exactName) => exactName === lowerName)
    || SECRET_LIKE_HEADER_NAME_WORDS.some((word) => compactName.includes(word));
}
