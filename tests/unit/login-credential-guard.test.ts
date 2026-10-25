// T36b（Task 36 の設計書 3.3・3.4・4 章）: 自動ログインのログインの段の、資格情報の持ち出しの守りの比べの部品（`src/safety/login-credential-guard.ts`）と、
// token の送信の応答の状態の観測の部品（`src/safety/token-response-observation.ts`）。
// - 比べる形は 3 つ: そのまま、URL の符号化（`encodeURIComponent`、空白を `+` にした形、`application/x-www-form-urlencoded` の形）、JSON の文字列の
//   符号化（`JSON.stringify` の中身）。URL の符号化の形は、16 進の大文字と小文字を区別しない。部分一致（本文と URL のどこかに含まれていれば当たる）。
// - 空の値は比べない。短すぎる値（`MIN_COMPARABLE_CREDENTIAL_LENGTH` より短い）は、どの送信にも当たるものとして扱う（止めすぎは安全の側）。
// - 本文を読めない（本文があるのに部品が取れない、file や blob の部品）ときは、当たるものとして扱う（fail-closed）。捨てた部品も当たる。
// - 部品は、値を JSON にも文字列にも出さない。
// - 応答の状態の観測: 通した token の送信ごとに、応答の状態のコードと `Retry-After` の値（短い印字できる値だけ）、応答がない（失敗）、まだ応答がない
//   （待っている）を区別する。本文は読まない。
// 例の値は、匿名の値（`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  MIN_COMPARABLE_CREDENTIAL_LENGTH,
  armLoginCredentialGuard,
  NO_COOKIES,
  UNREADABLE_COOKIES,
  carriesLoginCredential,
  carriesLoginCredentialInState,
  cookieTextsOf,
  createLoginCredentialGuard,
  createPendingLoginCredentialGuard,
  discardLoginCredentialGuard,
  isLoginCredentialGuard,
  requestBodyTextOf,
  type LoginCredentialGuard,
  type RequestBodyText,
} from '../../src/safety/login-credential-guard.js';
import { MAX_RETRY_AFTER_VALUE_LENGTH, TokenResponseTracker } from '../../src/safety/token-response-observation.js';

const USERNAME = 'member one@example.invalid';
const PASSWORD = 'p"a\\ss&w=rd+1';
const SIDE_URL = 'https://api.example.invalid/rest/v1/rpc/log_login';
const NONE: RequestBodyText = { kind: 'NONE' };
const text = (value: string): RequestBodyText => ({ kind: 'TEXT', text: value });
const guardOf = (username = USERNAME, password = PASSWORD) => createLoginCredentialGuard({ username, password });
const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
/** T36R2-fix: `%XX` の 16 進（基数と、1 バイトの桁数）。 */
const HEX_RADIX = 16;
const HEX_BYTE_DIGITS = 2;
/** T36R-fix: 比べの口の形が変わった（要求の method・ヘッダ・Cookie を足した）。T36b の場面は、読み取りでない要求（`POST`）の URL と本文として比べる。 */
const carries = (guard: LoginCredentialGuard, url: string, body: RequestBodyText): boolean =>
  carriesLoginCredential(guard, { url, readMethod: false, body, headers: {}, cookies: NO_COOKIES });

describe('T36b: the comparison of the login credentials on the registered side requests', () => {
  it.each<readonly [string, string]>([
    ['the raw value', `{"note":"x ${PASSWORD} y"}`],
    ['encodeURIComponent', `p=${encodeURIComponent(PASSWORD)}`],
    ['encodeURIComponent in lower case hex', `p=${encodeURIComponent(PASSWORD).toLowerCase()}`],
    ['the form encoding with + for the space', new URLSearchParams({ u: USERNAME }).toString()],
    ['encodeURIComponent with + for the space', `u=${encodeURIComponent(USERNAME).split('%20').join('+')}`],
    ['the JSON string encoding', JSON.stringify({ password: PASSWORD })],
  ])('finds a credential carried in the body by %s', (_name, body) => {
    expect(carries(guardOf(), SIDE_URL, text(body))).toBe(true);
  });

  it.each<readonly [string, string]>([
    ['encodeURIComponent', `${SIDE_URL}?u=${encodeURIComponent(USERNAME)}`],
    ['the form encoding', `${SIDE_URL}?${new URLSearchParams({ p: PASSWORD }).toString()}`],
  ])('finds a credential carried in the URL by %s', (_name, url) => {
    expect(carries(guardOf(), url, NONE)).toBe(true);
  });

  it('does not find the credentials in a body and a URL without them', () => {
    expect(carries(guardOf(), SIDE_URL, text('{"event":"login"}'))).toBe(false);
    expect(carries(guardOf(), `${SIDE_URL}?event=login`, NONE)).toBe(false);
  });

  it('ignores an empty value, and treats a value shorter than the threshold as carried by every request', () => {
    expect(MIN_COMPARABLE_CREDENTIAL_LENGTH).toBe(4);
    expect(carries(guardOf('', PASSWORD), SIDE_URL, text('{"event":"login"}'))).toBe(false);
    expect(carries(guardOf('abc', PASSWORD), SIDE_URL, text('{"event":"login"}'))).toBe(true);
    expect(carries(guardOf('abcd', PASSWORD), SIDE_URL, text('{"event":"login"}'))).toBe(false);
  });

  it('treats an unreadable body and a discarded guard as carrying a credential (fail-closed)', () => {
    expect(carries(guardOf(), SIDE_URL, { kind: 'UNREADABLE' })).toBe(true);
    const guard = guardOf();
    discardLoginCredentialGuard(guard);
    expect(carries(guard, SIDE_URL, NONE)).toBe(true);
  });

  it('reads the body from the CDP post data entries, and marks a missing or a file part unreadable', () => {
    expect(requestBodyTextOf(false, undefined)).toEqual(NONE);
    expect(requestBodyTextOf(true, [{ bytes: base64('a=') }, { bytes: base64('b') }])).toEqual(text('a=b'));
    expect(requestBodyTextOf(true, undefined)).toEqual({ kind: 'UNREADABLE' });
    expect(requestBodyTextOf(true, [])).toEqual({ kind: 'UNREADABLE' });
    expect(requestBodyTextOf(true, [{ bytes: base64('a=') }, {}])).toEqual({ kind: 'UNREADABLE' });
  });

  // T36c（Task 36 の設計書 3.3・4 章）: 自動ログインは、ログインの段の Context を作った後に復号する（平文を持つ時間を延ばさない）。部品は、値のない
  // 待ちの形で作って Guard に渡し、値を入れる直前に 1 回だけ値を入れる（`armLoginCredentialGuard`）。値を入れる前は、どの要求も比べない（ページは
  // まだ値を知らない）。2 回目と、捨てた後と、作り方の違う部品には入れられない（`TypeError`。値は文に入れない）。
  it('compares nothing before it is armed, and compares the values after it is armed once', () => {
    const guard = createPendingLoginCredentialGuard();
    expect(isLoginCredentialGuard(guard)).toBe(true);
    expect(carries(guard, `${SIDE_URL}?p=${encodeURIComponent(PASSWORD)}`, NONE)).toBe(false);
    armLoginCredentialGuard(guard, { username: USERNAME, password: PASSWORD });
    expect(carries(guard, `${SIDE_URL}?p=${encodeURIComponent(PASSWORD)}`, NONE)).toBe(true);
    expect(carries(guard, SIDE_URL, NONE)).toBe(false);
    expect(() => armLoginCredentialGuard(guard, { username: USERNAME, password: PASSWORD })).toThrow(TypeError);
    const discarded = createPendingLoginCredentialGuard();
    discardLoginCredentialGuard(discarded);
    expect(() => armLoginCredentialGuard(discarded, { username: USERNAME, password: PASSWORD })).toThrow(TypeError);
    expect(carries(discarded, SIDE_URL, NONE)).toBe(true);
  });

  it('keeps the values out of JSON, the string form and the own properties', () => {
    const guard = guardOf();
    expect(isLoginCredentialGuard(guard)).toBe(true);
    expect(isLoginCredentialGuard({})).toBe(false);
    for (const shown of [JSON.stringify(guard), String(guard), JSON.stringify(Object.getOwnPropertyNames(guard))]) {
      expect(shown).not.toContain('member');
      expect(shown).not.toContain('rd+1');
    }
  });
});

describe('T36b: the observation of the token request responses', () => {
  it('keeps the status and the Retry-After value of each admitted token request, and the failure and the pending ones', () => {
    const tracker = new TokenResponseTracker();
    tracker.sent('n1');
    tracker.sent('n2');
    tracker.sent('n3');
    tracker.sent(undefined);
    tracker.responseReceived({ requestId: 'n1', response: { status: 429, headers: { 'Retry-After': '120' } } });
    tracker.loadingFailed({ requestId: 'n2', errorText: 'net::ERR_EMPTY_RESPONSE' });
    tracker.responseReceived({ requestId: 'other', response: { status: 200, headers: {} } });
    expect(tracker.snapshot()).toEqual([
      { state: 'RESPONDED', status: 429, retryAfter: '120' },
      { state: 'FAILED', status: null, retryAfter: null },
      { state: 'PENDING', status: null, retryAfter: null },
      { state: 'PENDING', status: null, retryAfter: null },
    ]);
  });

  it('reads the Retry-After header in any case, keeps only a short printable value, and keeps the first outcome', () => {
    const tracker = new TokenResponseTracker();
    tracker.sent('a');
    tracker.sent('b');
    tracker.sent('c');
    tracker.responseReceived({ requestId: 'a', response: { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } } });
    tracker.responseReceived({ requestId: 'b', response: { status: 429, headers: { 'RETRY-AFTER': 'x'.repeat(MAX_RETRY_AFTER_VALUE_LENGTH + 1) } } });
    tracker.responseReceived({ requestId: 'c', response: { status: 400, headers: { 'retry-after': 'a\nb' } } });
    tracker.loadingFailed({ requestId: 'a' });
    expect(tracker.snapshot()).toEqual([
      { state: 'RESPONDED', status: 503, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' },
      { state: 'RESPONDED', status: 429, retryAfter: null },
      { state: 'RESPONDED', status: 400, retryAfter: null },
    ]);
  });

  it('ignores malformed events', () => {
    const tracker = new TokenResponseTracker();
    tracker.sent('a');
    tracker.responseReceived(null);
    tracker.responseReceived({ requestId: 'a', response: { status: 'x' } });
    tracker.loadingFailed('x');
    expect(tracker.snapshot()).toEqual([{ state: 'PENDING', status: null, retryAfter: null }]);
  });
});

// T36R-fix（Task 36 の独立レビュー T36R の C-1・C-2・C-4・M-8。設計書 7 章の T36R の行）: 比べる所と形を広げた。
// - C-1: 要求のヘッダの値（`Referer` を含む）と、要求に付く Cookie（名前と値）。Cookie を読めないときは、含まれるとみなす（fail-closed）。
// - C-2: URL などを寛容に % を戻した形と、さらに + を空白に直した形にも、そのままの値を比べる（戻せない % の並びはそのまま）。
// - C-4: 引き継ぐ状態（Cookie の名前と値、ローカル ストレージの鍵と値）を比べる口。
// - M-8（設計者の既定）: パスワードは、すべての要求（読み取りを含む）の URL・本文・ヘッダ・Cookie と、引き継ぐ状態で比べる。ユーザー名は、読み取りでない
//   要求の URL・本文・ヘッダだけで比べる。
describe('T36R-fix: the comparison on the headers, the cookies, the browser-encoded URLs and the carried-over state', () => {
  const READ_URL = 'https://app.example.invalid/r/read';
  type CheckedRequest = Parameters<typeof carriesLoginCredential>[1];
  const request = (overrides: Partial<CheckedRequest>): CheckedRequest =>
    ({ url: READ_URL, readMethod: true, body: NONE, headers: {}, cookies: NO_COOKIES, ...overrides });

  it('finds the password in a header value, including the Referer, on a read', () => {
    expect(carriesLoginCredential(guardOf(), request({ headers: { 'x-leak': PASSWORD } }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ headers: { Referer: new URL(`https://app.example.invalid/a?x=${PASSWORD}`).href } }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ headers: { accept: 'text/html' } }))).toBe(false);
  });

  it('finds the password in a cookie as is and in encodeURIComponent, and treats unreadable cookies as carrying it', () => {
    expect(carriesLoginCredential(guardOf(), request({ cookies: cookieTextsOf([{ name: 'lk', value: PASSWORD }]) }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ cookies: cookieTextsOf([{ name: 'lk', value: encodeURIComponent(PASSWORD) }]) }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ cookies: cookieTextsOf([{ name: 'sid', value: 'abc' }]) }))).toBe(false);
    expect(carriesLoginCredential(guardOf(), request({ cookies: UNREADABLE_COOKIES }))).toBe(true);
  });

  it.each([['a space and a slash', 'Zq9 Kx/7Lp'], ['a quote and an at sign', "Zq9'Kx@7Lp"], ['a non-ASCII letter and an at sign', 'Zqä9Kx@7Lp']])(
    'finds the password with %s concatenated as is into the query and the path (encoded by the browser)',
    (_name, password) => {
      const guard = guardOf(USERNAME, password);
      expect(carriesLoginCredential(guard, request({ url: new URL(`https://app.example.invalid/r?x=${password}`).href }))).toBe(true);
      expect(carriesLoginCredential(guard, request({ url: new URL(`https://app.example.invalid/r/${password}`).href }))).toBe(true);
    },
  );

  // T36R2-fix: 戻せないバイトは置き換え文字になり、ほかの部分（値の `encodeURIComponent` の形）は今どおり当たる。
  it('reads an undecodable percent sequence with the replacement character, and still finds the value next to it', () => {
    expect(carriesLoginCredential(guardOf(), request({ url: `${READ_URL}?x=%E0%A4%A&y=%zz&p=${encodeURIComponent(PASSWORD)}` }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ url: `${READ_URL}?x=%E0%A4%A&y=%zz` }))).toBe(false);
  });

  it('compares the user name only on a non-read request, in the URL, the body and the headers', () => {
    expect(carriesLoginCredential(guardOf(), request({ url: `${READ_URL}?email=${encodeURIComponent(USERNAME)}` }))).toBe(false);
    expect(carriesLoginCredential(guardOf(), request({ readMethod: true, headers: { 'x-who': USERNAME } }))).toBe(false);
    expect(carriesLoginCredential(guardOf(), request({ cookies: cookieTextsOf([{ name: 'who', value: USERNAME }]) }))).toBe(false);
    expect(carriesLoginCredential(guardOf(), request({ readMethod: false, body: text(`who=${USERNAME}`) }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ readMethod: false, headers: { 'x-who': USERNAME } }))).toBe(true);
    expect(carriesLoginCredential(guardOf(), request({ readMethod: false, url: `${READ_URL}?email=${encodeURIComponent(USERNAME)}` }))).toBe(true);
  });

  it('finds the password in the carried-over state (the cookies and the local storage), not the user name', () => {
    const stateWith = (
      cookies: readonly { readonly name: string; readonly value: string }[],
      localStorage: readonly { readonly name: string; readonly value: string }[],
    ) => ({ cookies, origins: [{ localStorage }] });
    expect(carriesLoginCredentialInState(guardOf(), stateWith([], [{ name: 'stash', value: PASSWORD }]))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), stateWith([{ name: 'lk', value: encodeURIComponent(PASSWORD) }], []))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), stateWith([], [{ name: PASSWORD, value: 'x' }]))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), stateWith([{ name: 'sid', value: 'abc' }], [{ name: 'who', value: USERNAME }]))).toBe(false);
    const discarded = guardOf();
    discardLoginCredentialGuard(discarded);
    expect(carriesLoginCredentialInState(discarded, stateWith([], []))).toBe(true);
  });

  // DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2）: 引き継ぐ状態に IndexedDB が加わったので、その中身（データベースの名前、
  // object store の名前、記録の鍵と値の文字列）も同じく比べる（T36R-fix の C-4 の決まりを、新しく引き継ぐものにも当てる）。
  it('finds the password in the carried-over IndexedDB (nested record values and keys), not the user name', () => {
    const withDatabase = (stores: readonly unknown[]) => ({
      cookies: [],
      origins: [{ localStorage: [], indexedDB: [{ name: 'auth-db', version: 1, stores }] }],
    });
    const store = (records: readonly unknown[]) => ({ name: 'kv', autoIncrement: false, records, indexes: [] });
    expect(carriesLoginCredentialInState(guardOf(), withDatabase([store([{ value: { session: { stash: PASSWORD } } }])]))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), withDatabase([store([{ key: PASSWORD, value: 1 }])]))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), withDatabase([store([{ valueEncoded: { a: [{ v: encodeURIComponent(PASSWORD) }] } }])]))).toBe(true);
    expect(carriesLoginCredentialInState(guardOf(), withDatabase([store([{ value: { who: USERNAME, token: 'abc' } }])]))).toBe(false);
  });
});

// T36R2-fix（Task 36 の再レビュー T36R2）:
// - M-a: 引き継ぐ状態の比べ（`carriesLoginCredentialInState`）を、値を入れる前（待ちの形のまま）に呼んだら、含まれるとみなす（fail-closed。状態を返す
//   のは、値を入れて送った後の成功だけなので、値を入れる前に呼ばれるのは誤り）。要求の比べ（`carriesLoginCredential`）は、今どおり値を入れる前は
//   何も比べない（ページはまだ値を知らない）。
// - 寛容な `%XX` の戻し方を WHATWG の percent-decode に近い形にした（各 `%XX` を 1 バイトに戻し、バイト列を UTF-8 として読み、戻せないバイトは
//   置き換え文字 U+FFFD）。戻せないバイトの並びに挟まれた値の、UTF-8 として正しい部分が比べに当たる。
describe('T36R2-fix: the state check before arming, and the percent decoding with the replacement character', () => {
  const READ_URL = 'https://app.example.invalid/r/read';
  /** 値の UTF-8 のバイトを、すべて `%XX` にした形。 */
  const allPercentEncoded = (value: string): string =>
    [...Buffer.from(value, 'utf8')].map((byte) => `%${byte.toString(HEX_RADIX).toUpperCase().padStart(HEX_BYTE_DIGITS, '0')}`).join('');
  const readRequest = (url: string) => ({ url, readMethod: true, body: NONE, headers: {}, cookies: NO_COOKIES });

  it('M-a: treats the carried-over state as carrying the password when it is checked before arming (fail-closed)', () => {
    const pending = createPendingLoginCredentialGuard();
    expect(carriesLoginCredentialInState(pending, { cookies: [], origins: [] })).toBe(true);
    expect(carriesLoginCredentialInState(pending, { cookies: [{ name: 'sid', value: 'abc' }], origins: [{ localStorage: [] }] })).toBe(true);
    // 要求の比べは、値を入れる前は何も比べない（今どおり）。
    expect(carriesLoginCredential(pending, readRequest(`${READ_URL}?p=${encodeURIComponent(PASSWORD)}`))).toBe(false);
    armLoginCredentialGuard(pending, { username: USERNAME, password: PASSWORD });
    expect(carriesLoginCredentialInState(pending, { cookies: [{ name: 'sid', value: 'abc' }], origins: [] })).toBe(false);
  });

  it.each([
    ['an ASCII password', 'Zq9Kx7Lp3Wm'],
    ['a password with a space and a slash', 'Zq9 Kx/7Lp'],
    ['a password with a non-ASCII letter', 'Zqä9Kx@7Lp'],
  ])('finds %s fully percent-encoded between undecodable bytes', (_name, password) => {
    const guard = guardOf(USERNAME, password);
    const wrapped = (prefix: string, suffix: string): string => `${READ_URL}?x=${prefix}${allPercentEncoded(password)}${suffix}`;
    expect(carriesLoginCredential(guard, readRequest(wrapped('%FF', '%FE')))).toBe(true);
    expect(carriesLoginCredential(guard, readRequest(wrapped('%C3', '%E0%A4')))).toBe(true);
    expect(carriesLoginCredential(guard, readRequest(wrapped('%80%80', '')))).toBe(true);
    // 値を含まない、戻せないバイトの並びだけなら当たらない。
    expect(carriesLoginCredential(guard, readRequest(`${READ_URL}?x=%FF%FE%C3`))).toBe(false);
  });
});
