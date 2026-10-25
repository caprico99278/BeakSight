// 自動ログインのログインの段の、資格情報の持ち出しの守りの唯一の部品（T36b。Task 36 の設計書 3.3・4 章）。
// - ワーカーの自動ログインの流れ（T36c）が、ログインの段の Context を作るときに、入れる資格情報（ユーザー名とパスワード）から部品を作って Guard に渡す
//   （`createLoginCredentialGuard`。ファクトリの口は `GuardLoginStage.credentialGuard`）。手動のログインでは渡さない（利用者が入力するので比べない）。
// - Guard は、スクリプトで送るログインの段で、判定が通した要求のうち、承認した token の送信のほかのすべて（登録したログインに伴う送信、main frame・
//   sub frame のナビゲーション、読み取り、ページの送信、Worker など。設計者の判断で、登録したログインに伴う送信から広げた）の URL と本文に、値が
//   含まれていれば止める（`carriesLoginCredential`）。token の送信そのもの（承認した送信先）は比べない。
// - 比べる形は 3 つ（`comparableFormsOf`）: そのまま、URL の符号化（`encodeURIComponent`、その空白（`%20`）を `+` にした形、
//   `application/x-www-form-urlencoded` の形）、JSON の文字列の符号化（`JSON.stringify` の中身）。URL の符号化の形は、16 進の大文字と小文字を区別
//   しない。ほかの形（base64、二重の符号化、文字コードの違いなど）は限界。
// - 空の値は比べない。`MIN_COMPARABLE_CREDENTIAL_LENGTH` より短い値は、部分一致で正しく比べられないので、どの送信にも含まれるとみなす（止めすぎは
//   安全の側。設計者への報告の閾値。どの要求にも当てるので、短い値ではログインの画面そのものを読めない）。本文を読めない（本文があるのに部品が取れない、file や blob の部品）とき、捨てた部品のときも、含まれるとみなす
//   （fail-closed）。
// - 値は、この部品の中（モジュールの WeakMap）だけで持つ。部品そのものは値を持たない（JSON にも文字列にも出ない）。Guard は、Context を閉じたら
//   捨てる（`discardLoginCredentialGuard`）。記録・IPC・管理データ・例外の文に、値も長さも残さない。
// - T36R-fix（Task 36 の独立レビュー T36R。設計書 7 章の T36R の行）:
//   - C-1: 比べる所に、要求のヘッダの値（`Referer` を含む）と、その要求に付く Cookie（名前と値。Guard が送る前に読む。読めなければ `UNREADABLE_COOKIES`
//     で、含まれるとみなす）を足した（`carriesLoginCredential` の要求の形 `LoginCredentialCheckRequest`）。
//   - C-2: 比べる文字列ごとに、寛容に `%XX` を戻した形と、さらに `+` を空白に直した形も作る（`expandedTextsOf`。`%XX` の続きはバイトに戻して UTF-8 と
//     して読み、戻せないバイトは置き換え文字にする（T36R2-fix）。`%` の後に 16 進が 2 桁続かない所はそのまま）。
//     ブラウザが一部の文字だけを % の形にする URL に、値をそのまま連結した場合を見つける。
//   - C-4: 引き継ぐ状態（Cookie の名前と値、ローカル ストレージの鍵と値。DEF-139 からは IndexedDB の名前と中身の文字列）を比べる口
//     （`carriesLoginCredentialInState`）。
//   - M-8（設計者の既定）: パスワードは、すべての要求（読み取りを含む）の URL・本文・ヘッダ・Cookie と、引き継ぐ状態で比べる。ユーザー名は、読み取りで
//     ない要求の URL・本文・ヘッダだけで比べる（SPA はログインの後にユーザー名で読み、セッションの保存にもユーザー名を持つのが普通のため）。
//   - 読み取りかは、呼び出し側（Guard）が要求の判定の owner の `isReadMethod` で決めて渡す（`readMethod`）。
// - T43R-fix の C-1 (c)・T43R2-fix: ログインの段の観察の案と比べる口（`carriesLoginCredentialInTexts`。値の比べる形と、ユーザー名の部分の逆向きの比べ）。
import type {
  AuthenticatedIndexedDBDatabase,
  AuthenticatedStorageCookie,
  AuthenticatedStorageItem,
} from '../core/authenticated-storage-state.js';
import { foldNfkcCase } from '../core/text.js';
import { decodeBase64BodyParts } from './request-body.js';

/** 部分一致で比べる値の最小の長さ（UTF-16 のコード単位）。これより短い空でない値は、どの送信にも含まれるとみなす。 */
export const MIN_COMPARABLE_CREDENTIAL_LENGTH = 4;

/**
 * 資格情報の持ち出しで止めた理由（T36b。Task 36 の設計書 3.3）。止めた要求は、ログインの段の記録に、この理由で数だけを数える
 * （`LoginStageMonitor.credentialRequestsBlocked`）。Safety Ledger には書かない（URL の query や path に値が入っているため）。ログインの段の止めた一覧の
 * 閉じた一覧への追加は、IPC の側の写し（`src/control/worker-protocol.ts`）と一緒に行う（T36b の報告の Blocker）。
 */
export const LOGIN_CREDENTIAL_BLOCK_REASON = 'LOGIN_CREDENTIAL_IN_REQUEST';

/** 入れる資格情報（ワーカーが復号した平文。部品を作った後は、呼び出し側は持たない）。 */
export interface LoginCredentialValues {
  readonly username: string;
  readonly password: string;
}

/** 1 つの値（パスワードかユーザー名）の比べる形と、短すぎる空でない値か（空の値は、形を持たず比べない）。 */
interface ValueForms {
  readonly forms: readonly ComparableForm[];
  readonly tooShort: boolean;
}

/** 比べる値の状態（部品ごと）。捨てたら `discarded`。 */
interface CredentialState {
  passwordForms: ValueForms;
  usernameForms: ValueForms;
  /**
   * T43R2-fix: ユーザー名を区切りと `@` で分けた、`MIN_COMPARABLE_CREDENTIAL_LENGTH` 以上の部分（NFKC と大文字小文字を畳んだ形）。ログインの段の観察の
   * 案と逆向きに比べる（`carriesLoginCredentialInTexts`）。
   */
  usernameParts: readonly string[];
  /** 捨てたか（捨てた後は、どの要求にも含まれるとみなす）。 */
  discarded: boolean;
  /** 値を入れたか（T36c。待ちの形で作った部品は、値を入れるまで何も比べない）。 */
  armed: boolean;
}

/** 値を入れる前の、何も比べない形。 */
const NO_VALUE_FORMS: ValueForms = Object.freeze({ forms: Object.freeze([]), tooShort: false });

/** 比べる形 1 つ（`caseInsensitive` は URL の符号化の形）。 */
interface ComparableForm {
  readonly value: string;
  readonly caseInsensitive: boolean;
}

const credentialStates = new WeakMap<LoginCredentialGuard, CredentialState>();

/**
 * 資格情報の持ち出しの守りの部品（値を持たない印。値はモジュールの中だけ）。`createLoginCredentialGuard` で作る（ほかで作った部品は値を持たず、
 * どの送信にも含まれるとみなされる）。
 */
export class LoginCredentialGuard {
  constructor() {
    Object.freeze(this);
  }

  toJSON(): Record<string, never> {
    return {};
  }

  toString(): string {
    return 'LoginCredentialGuard';
  }
}

/** URL の符号化の空白（`encodeURIComponent` の形）と、フォームの符号化の空白。 */
const ENCODED_SPACE = '%20';
const FORM_SPACE = '+';
/** 16 進の基数。 */
const HEX_RADIX = 16;
/** JSON の文字列の、前後の引用符の長さ。 */
const JSON_QUOTE_LENGTH = 1;

/**
 * `application/x-www-form-urlencoded` の形（WHATWG の URL の仕様の符号化。`encodeURIComponent` が残す `!`・`~`・`'`・`(`・`)` も符号化し、空白は
 * `+`）。URL の部品（`URLSearchParams`）は使わない（URL の判定の owner の Gate。値を URL として扱わない）。
 */
const FORM_EXTRA_ENCODED: ReadonlyMap<string, string> = new Map(['!', '~', "'", '(', ')'].map((character) => [
  character,
  `%${character.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`,
]));
const formUrlEncodedOf = (value: string): string => [...encodeURIComponent(value).split(ENCODED_SPACE).join(FORM_SPACE)]
  .map((character) => FORM_EXTRA_ENCODED.get(character) ?? character)
  .join('');

/** 値の比べる形（そのまま、URL の符号化の 3 つ、JSON の文字列の符号化）。同じ形は 1 つにまとめる。 */
function comparableFormsOf(value: string): readonly ComparableForm[] {
  const uriEncoded = encodeURIComponent(value);
  const forms: ComparableForm[] = [
    { value, caseInsensitive: false },
    { value: JSON.stringify(value).slice(JSON_QUOTE_LENGTH, -JSON_QUOTE_LENGTH), caseInsensitive: false },
    { value: uriEncoded.toLowerCase(), caseInsensitive: true },
    { value: uriEncoded.split(ENCODED_SPACE).join(FORM_SPACE).toLowerCase(), caseInsensitive: true },
    { value: formUrlEncodedOf(value).toLowerCase(), caseInsensitive: true },
  ];
  const seen = new Set<string>();
  return forms.filter((form) => {
    const key = `${String(form.caseInsensitive)}:${form.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 入れる資格情報から、部品を作る。値が文字列でなければ `TypeError`（値は文に入れない）。 */
export function createLoginCredentialGuard(values: LoginCredentialValues): LoginCredentialGuard {
  const guard = createPendingLoginCredentialGuard();
  armLoginCredentialGuard(guard, values);
  return guard;
}

/**
 * 値のない待ちの形の部品を作る（T36c。自動ログインの流れは、ログインの段の Context を作るときにこれを Guard に渡し、復号した値を入れる直前に
 * `armLoginCredentialGuard` で 1 回だけ値を入れる。復号した平文を持つ時間を延ばさない）。値を入れるまでは、どの要求も比べない（ページは値をまだ知らない）。
 */
export function createPendingLoginCredentialGuard(): LoginCredentialGuard {
  const guard = new LoginCredentialGuard();
  credentialStates.set(guard, { passwordForms: NO_VALUE_FORMS, usernameForms: NO_VALUE_FORMS, usernameParts: [], discarded: false, armed: false });
  return guard;
}

/** T43R2-fix: 部分に分ける区切り（ログインの段の観察の鍵の名前の区切りと、メールアドレスの `@`）。 */
const PART_SEPARATORS = /[.:_/@-]+/u;

/** NFKC と大文字小文字を畳み、区切りで分けた空でない部分。 */
const foldedPartsOf = (text: string): readonly string[] => foldNfkcCase(text).split(PART_SEPARATORS).filter((part) => part.length > 0);

/** 1 つの値の比べる形（空の値は、何も比べない）。 */
const valueFormsOf = (value: string): ValueForms => (value.length === 0
  ? NO_VALUE_FORMS
  : Object.freeze({ forms: comparableFormsOf(value), tooShort: value.length < MIN_COMPARABLE_CREDENTIAL_LENGTH }));

/**
 * 待ちの形の部品に、入れる資格情報を 1 回だけ入れる（T36c）。値が文字列でない、作り方の違う部品、捨てた部品、2 回目は `TypeError`（値は文に入れない。
 * 入れられなかった部品は今の状態のまま。捨てた部品は、どの要求にも含まれるとみなす）。
 */
export function armLoginCredentialGuard(guard: LoginCredentialGuard, values: LoginCredentialValues): void {
  const username: unknown = values?.username;
  const password: unknown = values?.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new TypeError('Login credential guard requires the username and the password as strings');
  }
  const state = credentialStates.get(guard);
  if (state === undefined || state.discarded || state.armed) {
    throw new TypeError('Login credential guard can be armed only once before it is discarded');
  }
  state.passwordForms = valueFormsOf(password);
  state.usernameForms = valueFormsOf(username);
  state.usernameParts = Object.freeze(foldedPartsOf(username).filter((part) => part.length >= MIN_COMPARABLE_CREDENTIAL_LENGTH));
  state.armed = true;
}

/** 部品か（`createLoginCredentialGuard` が作ったもの）。 */
export const isLoginCredentialGuard = (value: unknown): value is LoginCredentialGuard =>
  value instanceof LoginCredentialGuard && credentialStates.has(value);

/** 部品の値を捨てる（何度呼んでもよい）。捨てた後は、どの送信にも含まれるとみなす。 */
export function discardLoginCredentialGuard(guard: LoginCredentialGuard): void {
  const state = credentialStates.get(guard);
  if (state !== undefined) {
    state.passwordForms = NO_VALUE_FORMS;
    state.usernameForms = NO_VALUE_FORMS;
    state.discarded = true;
  }
}

/** 要求の本文の読み取りの結果（本文がない、読めた文字列、読めない）。 */
export type RequestBodyText =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'UNREADABLE' };

/** 本文がない（T36R-fix: Guard が、止めた要求の比べに使う。止めた要求の本文は送っていない）。 */
export const NO_BODY_TEXT: RequestBodyText = Object.freeze({ kind: 'NONE' });
const UNREADABLE_BODY: RequestBodyText = Object.freeze({ kind: 'UNREADABLE' });

/**
 * 本文があるか（CDP の `hasPostData`）と本文の部品（CDP の `postDataEntries`。各部品の `bytes` は base64）から、本文の文字列（UTF-8）を読む（Guard が
 * CDP の項目を渡す。Gate `write-stage-boundary` の (b)）。本文がなければ `NONE`。本文があるのに
 * 部品がない、空、`bytes` のない部品（file や blob）があれば `UNREADABLE`。
 */
export function requestBodyTextOf(
  hasBody: boolean | undefined,
  bodyParts: readonly { readonly bytes?: string | undefined }[] | undefined,
): RequestBodyText {
  if (hasBody !== true) {
    return NO_BODY_TEXT;
  }
  if (!Array.isArray(bodyParts) || bodyParts.length === 0 || bodyParts.some((entry) => typeof entry?.bytes !== 'string')) {
    return UNREADABLE_BODY;
  }
  // CC-096 の B: 部品の decode とつなぎ方は共通の部品（Guard の本文と同じ）。文字列にするのは、つないだ後。
  return Object.freeze({ kind: 'TEXT', text: decodeBase64BodyParts(bodyParts).toString('utf8') });
}

/**
 * Playwright の要求の本文（`postDataBuffer()`。route の層）から、本文の文字列（UTF-8）を読む（T36b。設計者の判断で範囲を広げた所。route の層の網）。
 * 本文がなければ `NONE`。
 */
export function requestBodyTextOfBuffer(body: Buffer | null): RequestBodyText {
  return body === null ? NO_BODY_TEXT : Object.freeze({ kind: 'TEXT', text: body.toString('utf8') });
}

/**
 * 要求に付く Cookie の読み取りの結果（T36R-fix の C-1）: 付く Cookie がない、読めた名前と値の文字列、読めない（含まれるとみなす）。
 */
export type CookieTexts =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'READ'; readonly texts: readonly string[] }
  | { readonly kind: 'UNREADABLE' };

export const NO_COOKIES: CookieTexts = Object.freeze({ kind: 'NONE' });
export const UNREADABLE_COOKIES: CookieTexts = Object.freeze({ kind: 'UNREADABLE' });

/** 名前と値の組（Cookie と、ローカル ストレージの項目）。 */
export interface NamedValue {
  readonly name: string;
  readonly value: string;
}

/** 要求に付く Cookie（名前と値）から、比べる文字列を作る。 */
export const cookieTextsOf = (cookies: readonly NamedValue[]): CookieTexts =>
  Object.freeze({ kind: 'READ', texts: Object.freeze(cookies.flatMap(({ name, value }) => [name, value])) });

/** 比べる要求（T36R-fix の C-1・M-8）。`readMethod` は、要求の判定の owner の `isReadMethod` の結果（呼び出し側が決める）。 */
export interface LoginCredentialCheckRequest {
  readonly url: string;
  readonly readMethod: boolean;
  readonly body: RequestBodyText;
  /** 要求のヘッダ（名前と値。値だけを比べる。なければ `undefined`）。 */
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly cookies: CookieTexts;
}

/**
 * 引き継ぐ状態（T36R-fix の C-4。`AuthenticatedState` の、比べる項目だけの形。`src/safety/` は `src/control/` を読めないので、形だけを置く）。
 * PRE42-CC 組 UI-K3（台帳の CC-060 の残り）: 項目の形は、認証済みの状態の形の owner（`src/core/authenticated-storage-state.ts`）の型から取る（`Pick`。
 * 比べる項目は前と同じ: Cookie と localStorage の名前と値、IndexedDB のデータベースの名前と中身）。
 */
export interface LoginCredentialCarriedState {
  readonly cookies: readonly Pick<AuthenticatedStorageCookie, 'name' | 'value'>[];
  readonly origins: readonly {
    readonly localStorage: readonly Pick<AuthenticatedStorageItem, 'name' | 'value'>[];
    /** DEF-139: 引き継ぐ IndexedDB（データベースの名前と中身。中身の文字列をすべて比べる）。 */
    readonly indexedDB?: readonly Pick<AuthenticatedIndexedDBDatabase, 'name' | 'stores'>[];
  }[];
}

/** DEF-139: 入れ子の値の中の文字列（オブジェクトの鍵を含む）をすべて集める（IndexedDB の中身を比べるため。値を外に出さない）。 */
const nestedTextsOf = (value: unknown, texts: string[] = []): string[] => {
  if (typeof value === 'string') {
    texts.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) nestedTextsOf(item, texts);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      texts.push(key);
      nestedTextsOf(item, texts);
    }
  }
  return texts;
};

/** `%XX` の続き（1 つ以上。ここを戻す）。区切りは結果に残す（捕まえる組にして `split` する）。 */
const PERCENT_RUN = /((?:%[0-9A-Fa-f]{2})+)/u;
/** 捕まえる組で `split` した結果の並び（ほかの文字、`%XX` の続き、…）の周期。奇数番目が `%XX` の続き。 */
const SPLIT_RUN_PERIOD = 2;
/** `%XX` の印。 */
const PERCENT_SIGN = '%';

/**
 * `%XX` の続きを戻す（T36R2-fix: WHATWG の percent-decode に近い形。各 `%XX` を 1 バイトに戻し、バイト列を UTF-8 として読む。UTF-8 として戻せない
 * バイトは置き換え文字 U+FFFD になり、ほかのバイトの並びは戻る。T36R-fix は、続きの一部が戻せないと続き全体をそのまま残し、戻せないバイトに
 * 挟まれた値が比べに当たらなかった）。
 */
const decodedRun = (run: string): string => Buffer.from(run.split(PERCENT_SIGN).join(''), 'hex').toString('utf8');

/** 寛容に `%XX` を戻した形（T36R-fix の C-2。T36R2-fix: 戻せないバイトは置き換え文字）。 */
const lenientPercentDecoded = (text: string): string => text
  .split(PERCENT_RUN)
  .map((part, index) => (index % SPLIT_RUN_PERIOD === 1 ? decodedRun(part) : part))
  .join('');

/** 比べる文字列ごとに、そのままと、寛容に `%XX` を戻した形と、さらに `+` を空白に直した形（T36R-fix の C-2）。 */
const expandedTextsOf = (texts: readonly string[]): readonly string[] => texts.flatMap((text) => {
  const decoded = lenientPercentDecoded(text);
  return [text, decoded, decoded.split(FORM_SPACE).join(' ')];
});

/** 文字列のどれかが、比べる形のどれかを含むか（文字列は、`expandedTextsOf` で広げてから比べる）。 */
const containsForm = (texts: readonly string[], forms: readonly ComparableForm[]): boolean => {
  if (forms.length === 0) {
    return false;
  }
  const expanded = expandedTextsOf(texts);
  const lowered = expanded.map((value) => value.toLowerCase());
  return forms.some((form) => (form.caseInsensitive ? lowered : expanded).some((value) => value.includes(form.value)));
};

/** 1 つの値が、文字列に含まれるとみなすか（短すぎる値は、どの文字列にも含まれるとみなす）。 */
const carriedIn = (value: ValueForms, texts: readonly string[]): boolean =>
  value.tooShort || containsForm(texts, value.forms);

/**
 * 要求に、入れた資格情報が含まれるか（ファイルの先頭の説明）。捨てた部品と知らない部品は、含まれるとみなす。値を入れる前の部品は、何も比べない。
 * - パスワード: URL・本文・ヘッダの値・Cookie（読み取りを含むすべての要求）。読めない本文と読めない Cookie は、含まれるとみなす。
 * - ユーザー名: 読み取りでない要求の URL・本文・ヘッダの値だけ。読めない本文は、含まれるとみなす。
 */
export function carriesLoginCredential(guard: LoginCredentialGuard, request: LoginCredentialCheckRequest): boolean {
  const state = credentialStates.get(guard);
  if (state === undefined || state.discarded) {
    return true;
  }
  if (!state.armed) {
    return false;
  }
  const headerValues = Object.values(request.headers ?? {}).filter((value): value is string => typeof value === 'string');
  const bodyTexts = request.body.kind === 'TEXT' ? [request.body.text] : [];
  const requestTexts = [request.url, ...headerValues, ...bodyTexts];
  const passwordCarried = (request.body.kind === 'UNREADABLE' || request.cookies.kind === 'UNREADABLE')
    ? state.passwordForms.forms.length > 0 || state.passwordForms.tooShort
    : carriedIn(state.passwordForms, [...requestTexts, ...(request.cookies.kind === 'READ' ? request.cookies.texts : [])]);
  if (passwordCarried) {
    return true;
  }
  if (request.readMethod) {
    return false;
  }
  return request.body.kind === 'UNREADABLE'
    ? state.usernameForms.forms.length > 0 || state.usernameForms.tooShort
    : carriedIn(state.usernameForms, requestTexts);
}

/**
 * T43R-fix の C-1 (c)（Task 43 の設計書 7 章の T43R の行）: 文字列（ログインの段の観察の案。成功の鍵の名前の接頭辞と接尾辞、成功の画面のセレクタ）の
 * どれかに、入れたユーザー名かパスワードが含まれるか。比べ方は要求の比べと同じ比べる形（そのまま、URL の符号化、JSON の文字列の符号化と、寛容に `%XX` を
 * 戻した形）。捨てた部品、知らない部品、値を入れる前の部品は、含まれるとみなす（fail-closed。案は値を入れて送った後にだけ作る）。
 */
export function carriesLoginCredentialInTexts(guard: LoginCredentialGuard, texts: readonly string[]): boolean {
  const state = credentialStates.get(guard);
  if (state === undefined || state.discarded || !state.armed) {
    return true;
  }
  if (carriedIn(state.passwordForms, texts) || carriedIn(state.usernameForms, texts)) {
    return true;
  }
  // T43R2-fix（Task 43 の設計書 7 章の最後の行）: 逆向きにも比べる。ユーザー名の部分（区切りと `@` で分けた 4 文字以上）が、文字列の部分（同じ区切りで
  // 分けたもの）と、NFKC と大文字小文字を畳んで一致すれば含む（メールの形・ローカル部・大文字小文字の違い）。
  const textParts = new Set(texts.flatMap(foldedPartsOf));
  return state.usernameParts.some((part) => textParts.has(part));
}

/**
 * 引き継ぐ状態（Cookie の名前と値、ローカル ストレージの鍵と値）に、入れたパスワードが含まれるか（T36R-fix の C-4・M-8。ユーザー名は比べない）。
 * 捨てた部品と知らない部品は、含まれるとみなす。T36R2-fix（T36R2 の M-a）: 値を入れる前の部品も、含まれるとみなす（fail-closed）。状態を返すのは、
 * 値を入れて送った後の成功だけなので、値を入れる前に呼ばれるのは誤り（要求の比べ `carriesLoginCredential` は、値を入れる前はページがまだ値を
 * 知らないので、何も比べない）。
 */
export function carriesLoginCredentialInState(guard: LoginCredentialGuard, carried: LoginCredentialCarriedState): boolean {
  const state = credentialStates.get(guard);
  if (state === undefined || state.discarded || !state.armed) {
    return true;
  }
  const texts = [
    ...carried.cookies.flatMap(({ name, value }) => [name, value]),
    ...carried.origins.flatMap(({ localStorage }) => localStorage.flatMap(({ name, value }) => [name, value])),
    // DEF-139: 引き継ぐ IndexedDB の、データベースの名前と中身の文字列。
    ...carried.origins.flatMap(({ indexedDB }) => (indexedDB ?? []).flatMap(({ name, stores }) => [name, ...nestedTextsOf(stores)])),
  ];
  return carriedIn(state.passwordForms, texts);
}
