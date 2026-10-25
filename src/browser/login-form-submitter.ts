/**
 * ログインのフォームへの入力の部品（Task 26 の設計書 4.4 の 3・4 と「入力の部品」、5 章の SSOT。T26d-1）。ページの入力の欄に値を入れる操作
 * （`fill`、`click` による送信）を使ってよいのは、`src/` の中でこのファイルだけ（`tests/architecture/worker-login-hooks.test.ts` の (q)）。
 * 呼べるのは自動ログインの段（`src/worker/automated-login.ts`）だけ（同じ Gate の (x)）。
 *
 * 1. `inspectLoginForm`（値を受け取る前に呼ぶ。値を受けない）: フォームを読むだけで確かめる。要素の属性とプロパティだけを読み、ページに値を
 *    渡さない。次の順に確かめ、最初に外れた理由（`LOGIN_FORM_INVALID_REASONS`）を返す。
 *    - 3 つの要素（ユーザー名、パスワード、送信）が、それぞれちょうど 1 つ（main frame の中だけ）。
 *    - ユーザー名の欄が `input` の text・email・tel（`type` の未指定と、ブラウザが text とみなす値を含む。ブラウザの `type` のプロパティで読む）。
 *    - パスワードの欄が `input[type=password]`。
 *    - 送信の要素が、送信のボタン（`button` の `type` が submit、または `input[type=submit]`）。
 *    - 3 つが同じ `form` の要素に属する（ボタンの `form` 属性による関連も、ブラウザの `form` のプロパティで同じものとして扱う）。
 *    - method が POST（送信のボタンに `formmethod` があれば、それ）。
 *    - action（送信のボタンに `formaction` があれば、それ）を解決した URL が、呼ぶ側が渡した判定（要求の判定の owner の口。送信先の Origin と
 *      path の完全一致）に当たる。
 *    - 送信の先の閲覧の文脈が、同じ page（`formtarget`・`target`・`<base target>` が、ないか `_self`）。
 *    T36a（Task 36 の設計書 3.2）: スクリプトで送るログイン（`LoginFormTarget.submission` が `SCRIPT_REQUEST`）では、method と action を確かめない
 *    （スクリプトが送るため。送信先の判定は Guard のスクリプトの口）。ほかの確かめ（3 つの要素、欄の種類、同じ form、送信の先）は今どおり。
 *    T36R-fix（ユーザーの判断「ログインの画面に form の要素がなければ止めるのでは監査が開始できない」）: スクリプトで送るログインでは、3 つがすべて
 *    form の外（form の持ち主も、祖先の form もない）の画面も通す。そのときは、3 つがそれぞれちょうど 1 つ（main frame の中だけ。今どおり）、欄の種類
 *    （今どおり）、見えている、欄は編集できる、送信の要素は押せる（Playwright の `isVisible`・`isEditable`・`isEnabled`。外れたら、その要素の理由）、
 *    送信の要素は `button`・`input[type=submit|button]`・`role="button"` の要素のどれか（`href` のある要素は止める。T36R2-fix: 祖先に `href` のある
 *    `a`・`area` があるときも止める。shadow root をまたいで祖先をたどる。押すとページが移りうるため）、送信の先が同じ page（今どおり）を
 *    確かめる。一部だけが form の中か、別々の form の中なら `NOT_SAME_FORM`。フォームの送信のログイン（`FORM_NAVIGATION`）は変えない。
 *    プロパティは、要素の上書き（DOM clobbering。`<input name="action">` など）を受けないように、標準の prototype の getter で読む。
 *    T32j-4（Task 32 の設計書 4.4 の「CC-068 の設計」の 2。調査 T32j-3 の Lc）: 読み取りは isolated world で行う（`readInIsolatedWorld`。ページの JS
 *    は結果を偽れず、読む間に走らない）。isolated world の中で、設定のセレクタ（標準の CSS）から、文書と open な shadow root ごとに要素を
 *    探し直し、3 つの事実を読む。数が Playwright の `count()`（Locator。CSS のエンジン）と合わなければ、読めないとして止める
 *    （`FORM_UNREADABLE`。fail-closed。Playwright 独自の書き方や、shadow root をまたぐセレクタは、ここで止まる。設定の検証でも拒む）。
 *    ElementHandle は使わない。
 * 2. `fillLoginForm`: 確かめが通った後に、Playwright の `fill` でユーザー名とパスワードを入れる。`page.evaluate` で値を書かない。値を受ける
 *    引数（`loginSecret`）は、`.fill(` の引数のほかに現れない（同じ Gate の (z)）。
 * 3. `clickLoginSubmit`: Playwright の `click` で送る。
 * `fill` と `click` の誤りの文には、値が入りうる（Task 26 の調査 E7）。誤りは捨て、何の情報も持たない失敗（`{ ok: false }`）だけを返す
 * （返す値、投げる誤り、console、どこにも出さない）。呼ぶ側が、固定の結果のコード（`LOGIN_FORM_INPUT_FAILED`）にする。`click` を呼んだ後の失敗は、
 * 送信が分からない（呼ぶ側が `UNKNOWN` にする）。
 * 要素の引き方（セレクタの解釈）と、送信先の判定は、呼ぶ側が渡す（`LoginFormTarget`）。この部品は `src/control/` を読まない（Control の境界の Gate）。
 */
import type { Locator } from 'playwright';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';
import { FORM_POST_METHOD, FORM_SELF_TARGETS, FORM_STEP_TIMEOUT_MS } from './form-submission-common.js';
import { readInIsolatedWorld } from '../discovery/isolated-read.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';

/** フォームを読む・値を入れる・送る、それぞれの時間の上限（ms。T30c: 書き込みの入力の部品と共通の値 `FORM_STEP_TIMEOUT_MS`）。 */
export const LOGIN_FORM_STEP_TIMEOUT_MS = FORM_STEP_TIMEOUT_MS;

/**
 * フォームの確かめが通らない理由（閉じた一覧。確かめる順）。
 * - `SELECTOR_NOT_UNIQUE`: 3 つのセレクタのどれかが、ちょうど 1 つの要素に当たらない（0 か 2 以上）。
 * - `USERNAME_FIELD_INVALID`: ユーザー名の欄が、閉じた一覧の入力の欄（`USERNAME_INPUT_TYPES`）でない。
 * - `PASSWORD_FIELD_INVALID`: パスワードの欄が `input[type=password]` でない。
 * - `SUBMIT_BUTTON_INVALID`: 送信の要素が、送信のボタンでない（`button[type=button]`、リンクなど）。T36R-fix: form のない画面のスクリプトで送る
 *   ログインでは、`button`・`input[type=submit|button]`・`role="button"` でない、`href` がある（T36R2-fix: 祖先の `a`・`area` を含む）、見えない、押せない。ユーザー名とパスワードの欄が
 *   見えないか編集できないときは、その欄の理由。
 * - `NOT_SAME_FORM`: 3 つが同じ `form` に属さない（どれかが `form` に属さない場合を含む）。T36R-fix: スクリプトで送るログインでは、3 つがすべて
 *   form の外なら通し、一部だけが form の中か、別々の form の中のとき。
 * - `METHOD_NOT_POST`: method（`formmethod` を含む）が POST でない。
 * - `ACTION_NOT_ALLOWED`: action（`formaction` を含む）を解決した URL が、許した送信先でない。
 * - `FORM_TARGET_NOT_SELF`: 送信の先が、同じ page でない（`_blank`、名前つきの窓や iframe）。
 * - `FORM_UNREADABLE`: フォームを読めなかった（読む間の移動、時間の上限など）。
 */
export const LOGIN_FORM_INVALID_REASONS = Object.freeze([
  'SELECTOR_NOT_UNIQUE',
  'USERNAME_FIELD_INVALID',
  'PASSWORD_FIELD_INVALID',
  'SUBMIT_BUTTON_INVALID',
  'NOT_SAME_FORM',
  'METHOD_NOT_POST',
  'ACTION_NOT_ALLOWED',
  'FORM_TARGET_NOT_SELF',
  'FORM_UNREADABLE',
] as const);
export type LoginFormInvalidReason = (typeof LOGIN_FORM_INVALID_REASONS)[number];

/**
 * ログインの送り方（T36a。閉じた一覧）。`FORM_NAVIGATION` は form の送信（method と action を確かめる。今の確かめ）、`SCRIPT_REQUEST` はスクリプトの送信
 * （method と action を確かめない）。値と順は、認証の設定の `LOGIN_TRANSPORTS`（`src/control/auth/auth-setup-contracts.ts`）と同じ（この部品は
 * `src/control/` を読まないので写す。一致は `tests/unit/script-login-boundary-consistency.test.ts`）。
 */
export const LOGIN_FORM_SUBMISSIONS = Object.freeze(['FORM_NAVIGATION', 'SCRIPT_REQUEST'] as const);
export type LoginFormSubmission = (typeof LOGIN_FORM_SUBMISSIONS)[number];

/** method と action を確かめない送り方（スクリプトの送信）。 */
const SCRIPT_SUBMISSION: LoginFormSubmission = 'SCRIPT_REQUEST';

/** ユーザー名の欄として受ける `input` の `type`（ブラウザの `type` のプロパティの値。未指定と、知らない値は `text`）。 */
export const USERNAME_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'email', 'tel']);

/** パスワードの欄の `type`。 */
const PASSWORD_INPUT_TYPE = 'password';
/** 送信のボタンの `type`。 */
const SUBMIT_TYPE = 'submit';
/** 受ける method（T30c: 書き込みの入力の部品と共通の値）。 */
const POST_FORM_METHOD = FORM_POST_METHOD;
/** 同じ page を表す送信の先（T30c: 書き込みの入力の部品と共通の値）。 */
const SELF_TARGETS = FORM_SELF_TARGETS;
/** 要素の数（ちょうど 1 つ）。 */
const ONE_ELEMENT = 1;
/**
 * T36R-fix: 3 つの要素の form の中の置き方（ページの中で読む。要素ごとに、form の持ち主か、なければ祖先の form）。`SAME` は 3 つが同じ form の中、
 * `NONE` は 3 つとも form の外、`MIXED` はほか（一部だけが form の中、別々の form の中）。
 */
const FORM_PLACEMENTS: ReadonlySet<string> = new Set(['SAME', 'NONE', 'MIXED']);
/** 3 つとも form の外。 */
const NO_FORM_PLACEMENT = 'NONE';
/** 一部だけが form の中か、別々の form の中。 */
const MIXED_FORM_PLACEMENT = 'MIXED';
/** T36R-fix: form のない画面で、送信の要素として受ける `input` の `type`。 */
const FORMLESS_SUBMIT_INPUT_TYPES: ReadonlySet<string> = new Set([SUBMIT_TYPE, 'button']);
/** T36R-fix: form のない画面で、送信の要素として受ける要素の名前（`button` は `type` を問わない）と `role`。 */
const BUTTON_TAG = 'button';
const INPUT_TAG = 'input';
const BUTTON_ROLE = 'button';

/** 認証の設定の 3 つのセレクタ（標準の CSS。isolated world で、文書と open な shadow root ごとに探し直す）。 */
export interface LoginFormSelectors {
  readonly username: string;
  readonly password: string;
  readonly submit: string;
}

/** フォームの要素と、送信先の判定（呼ぶ側が渡す）。 */
export interface LoginFormTarget {
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  /** 3 つの Locator を作ったセレクタ（同じ値。事前の確かめは、これで isolated world の中で探し直す）。 */
  readonly selectors: LoginFormSelectors;
  /** action を解決した URL が、許した送信先か（要求の判定の owner の口。呼ぶ側が渡す）。 */
  readonly isAllowedAction: (actionUrl: string) => boolean;
  /**
   * T36a: ログインの送り方（`LOGIN_FORM_SUBMISSIONS`）。省略は `FORM_NAVIGATION`（今の確かめ）。`SCRIPT_REQUEST` では method と action を確かめない
   * （`isAllowedAction` を呼ばない）。
   */
  readonly submission?: LoginFormSubmission | undefined;
}

/** 入れる値（使った後に、呼ぶ側が参照を捨てる）。 */
export interface LoginFormSecret {
  readonly username: string;
  readonly password: string;
}

/** フォームの確かめの結果。 */
export type LoginFormInspection = { readonly ok: true } | { readonly ok: false; readonly reason: LoginFormInvalidReason };

/** 値を入れる・送るの結果（失敗は、誤りの情報を持たない）。 */
export type LoginFormStepOutcome = { readonly ok: true } | { readonly ok: false };

const INPUT_FAILED: LoginFormStepOutcome = Object.freeze({ ok: false });
const STEP_SUCCEEDED: LoginFormStepOutcome = Object.freeze({ ok: true });

/** ページの中で読んだ、フォームの事実（値を含まない）。 */
interface LoginFormFacts {
  readonly usernameTag: string;
  readonly usernameType: string;
  readonly passwordTag: string;
  readonly passwordType: string;
  readonly submitTag: string;
  readonly submitType: string;
  readonly sameForm: boolean;
  readonly method: string;
  readonly action: string;
  readonly target: string;
  /** T36R-fix: 3 つの要素の form の中の置き方（`FORM_PLACEMENTS`）。 */
  readonly placement: string;
  /** T36R-fix: 送信の要素の `role` 属性（前後の空白を除き、小文字。なければ空）。 */
  readonly submitRole: string;
  /** T36R-fix: 送信の要素が `href` 属性を持つ。T36R2-fix: または、祖先（shadow root をまたぐ）に `href` のある `a`・`area` がある。 */
  readonly submitHasHref: boolean;
}

/** ページの中で読んだ結果: 3 つのセレクタの要素の数（ユーザー名、パスワード、送信の順）と、どれもちょうど 1 つのときの事実。 */
interface LoginFormReading {
  readonly counts: readonly number[];
  readonly facts: LoginFormFacts | null;
}

/**
 * ページの中で、3 つのセレクタの要素を、文書と open な shadow root ごとに探し（数を返す）、どれもちょうど 1 つなら、3 つの要素の属性と
 * プロパティを読む（値は受けない。ページに何も書かない）。プロパティは標準の prototype の getter（部品の `standardProperty`。
 * `src/browser/in-page-readers.ts`。CC-068）で読み、要素の上書き（DOM clobbering）を受けない。この関数は、isolated world で動く（部品（`R`）を
 * `composeInPage` で組み込んで `readInIsolatedWorld` に渡す。外の変数を参照しない）。セレクタが標準の CSS でなければ例外（読めなかった）。
 */
function readLoginFormFactsReader(R: StandardReaders, selectors: LoginFormSelectors): LoginFormReading {
  const { standardProperty: read } = R;
  // 文書と、その中の open な shadow root（入れ子を含む。文書の順）で探す（CC-099: 部品の `openRoots`・`queryAllInRoots`）。
  const roots = R.openRoots();
  const find = (selector: string): Node[] => R.queryAllInRoots(roots, selector);
  const usernames = find(selectors.username);
  const passwords = find(selectors.password);
  const submits = find(selectors.submit);
  const counts = [usernames.length, passwords.length, submits.length];
  const username = usernames[0];
  const password = passwords[0];
  const submit = submits[0];
  if (username === undefined || password === undefined || submit === undefined || counts.some((count) => count !== 1)) {
    return { counts, facts: null };
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tagOf = (node: Node): string => (node instanceof Element ? text(read(Element.prototype, 'localName', node)) : '');
  const prototypeOf = (node: Node): object | null => {
    if (node instanceof HTMLInputElement) return HTMLInputElement.prototype;
    if (node instanceof HTMLButtonElement) return HTMLButtonElement.prototype;
    return null;
  };
  const typeOf = (node: Node): string => {
    const prototype = prototypeOf(node);
    return prototype === null ? '' : text(read(prototype, 'type', node));
  };
  const formOf = (node: Node): unknown => {
    const prototype = prototypeOf(node);
    return prototype === null ? null : read(prototype, 'form', node);
  };
  const hasAttribute = (node: Node, name: string): boolean => node instanceof Element && Element.prototype.hasAttribute.call(node, name);
  const form = formOf(username);
  const sameForm = form instanceof HTMLFormElement && formOf(password) === form && formOf(submit) === form;
  const submitPrototype = prototypeOf(submit);
  const override = (attribute: string, property: string): string | null =>
    submitPrototype !== null && hasAttribute(submit, attribute) ? text(read(submitPrototype, property, submit)) : null;
  const formProperty = (name: string): string => (form instanceof HTMLFormElement ? text(read(HTMLFormElement.prototype, name, form)) : '');
  const baseTarget = (): string => {
    // `document` の名前つきの要素（`<img name="querySelector">` など。DEF-073）に隠されないように、標準のメソッドで読む。
    const base = Document.prototype.querySelector.call(document, 'base[target]');
    return base === null ? '' : text(Element.prototype.getAttribute.call(base, 'target'));
  };
  const formTarget = override('formtarget', 'formTarget') ?? (form instanceof HTMLFormElement && hasAttribute(form, 'target')
    ? formProperty('target')
    : baseTarget());
  // T36R-fix: 要素ごとの form（form の持ち主か、なければ祖先の form。持ち主のない要素が form の中にあれば、form の中とみなす）。
  const containerOf = (node: Node): unknown => {
    const owner = formOf(node);
    if (owner instanceof HTMLFormElement) return owner;
    return node instanceof Element ? Element.prototype.closest.call(node, 'form') : null;
  };
  const containers = [containerOf(username), containerOf(password), containerOf(submit)];
  const placement = containers.every((container) => container === null)
    ? 'NONE'
    : containers.every((container) => container !== null && container === containers[0]) ? 'SAME' : 'MIXED';
  const submitRole = submit instanceof Element ? text(Element.prototype.getAttribute.call(submit, 'role')) : '';
  // T36R2-fix: 送信の要素の祖先（shadow root では host へ移る）に、`href` のある `a`・`area` があるか（押すとページが移りうる。CC-099: 部品の
  // `hasLinkAncestor`）。
  return { counts, facts: {
    usernameTag: tagOf(username),
    usernameType: typeOf(username),
    passwordTag: tagOf(password),
    passwordType: typeOf(password),
    submitTag: tagOf(submit),
    submitType: typeOf(submit),
    sameForm,
    method: override('formmethod', 'formMethod') ?? formProperty('method'),
    action: override('formaction', 'formAction') ?? formProperty('action'),
    target: formTarget.trim().toLowerCase(),
    placement,
    submitRole: submitRole.trim().toLowerCase(),
    submitHasHref: hasAttribute(submit, 'href') || R.hasLinkAncestor(submit),
  } };
}
const readLoginFormFactsInPage = composeInPage(readLoginFormFactsReader);

/** T36R-fix: スクリプトで送るログインの、form のない画面（3 つとも form の外）か。 */
const isFormlessScriptLogin = (facts: LoginFormFacts, scriptSubmission: boolean): boolean =>
  scriptSubmission && facts.placement === NO_FORM_PLACEMENT;

/** T36R-fix: form のない画面の送信の要素か（`button`・`input[type=submit|button]`・`role="button"`。`href` のある要素は除く）。 */
const isFormlessSubmitElement = (facts: LoginFormFacts): boolean =>
  !facts.submitHasHref
  && (facts.submitTag === BUTTON_TAG
    || (facts.submitTag === INPUT_TAG && FORMLESS_SUBMIT_INPUT_TYPES.has(facts.submitType))
    || facts.submitRole === BUTTON_ROLE);

/**
 * 読んだ事実から、最初に外れた理由（なければ `null`）。T36a: スクリプトの送信（`scriptSubmission`）では、method と action を確かめない。
 * T36R-fix: スクリプトの送信で、3 つとも form の外なら、送信の要素を form のない画面の形で確かめ、form と method と action を確かめない（送信の先は
 * 今どおり）。一部だけが form の中か、別々の form の中なら、送信の要素より先に `NOT_SAME_FORM`。
 */
const invalidReasonOf = (
  facts: LoginFormFacts,
  isAllowedAction: (actionUrl: string) => boolean,
  scriptSubmission: boolean,
): LoginFormInvalidReason | null => {
  if (facts.usernameTag !== INPUT_TAG || !USERNAME_INPUT_TYPES.has(facts.usernameType)) {
    return 'USERNAME_FIELD_INVALID';
  }
  if (facts.passwordTag !== INPUT_TAG || facts.passwordType !== PASSWORD_INPUT_TYPE) {
    return 'PASSWORD_FIELD_INVALID';
  }
  if (scriptSubmission && facts.placement === MIXED_FORM_PLACEMENT) {
    return 'NOT_SAME_FORM';
  }
  if (isFormlessScriptLogin(facts, scriptSubmission)) {
    if (!isFormlessSubmitElement(facts)) {
      return 'SUBMIT_BUTTON_INVALID';
    }
    return SELF_TARGETS.has(facts.target) ? null : 'FORM_TARGET_NOT_SELF';
  }
  if (!((facts.submitTag === BUTTON_TAG || facts.submitTag === INPUT_TAG) && facts.submitType === SUBMIT_TYPE)) {
    return 'SUBMIT_BUTTON_INVALID';
  }
  if (!facts.sameForm) {
    return 'NOT_SAME_FORM';
  }
  if (!scriptSubmission && facts.method !== POST_FORM_METHOD) {
    return 'METHOD_NOT_POST';
  }
  if (!scriptSubmission && !isAllowedAction(facts.action)) {
    return 'ACTION_NOT_ALLOWED';
  }
  return SELF_TARGETS.has(facts.target) ? null : 'FORM_TARGET_NOT_SELF';
};

/** 読み取りの事実の、文字列の項目。 */
const LOGIN_FORM_FACT_TEXT_KEYS: readonly string[] = [
  'usernameTag', 'usernameType', 'passwordTag', 'passwordType', 'submitTag', 'submitType', 'method', 'action', 'target',
];

/** 読み取りの形を確かめる（ページの中の結果は、信じずに形を見る）。 */
const isLoginFormFacts = (value: unknown): value is LoginFormFacts =>
  isRecord(value)
  && LOGIN_FORM_FACT_TEXT_KEYS.every((key) => typeof value[key] === 'string')
  && typeof value['sameForm'] === 'boolean'
  && typeof value['placement'] === 'string' && FORM_PLACEMENTS.has(value['placement'])
  && typeof value['submitRole'] === 'string'
  && typeof value['submitHasHref'] === 'boolean';

/**
 * T36R-fix: form のない画面で、3 つの要素が見えていて、欄が編集でき、送信の要素が押せるかを、Playwright で確かめる（外れた最初の要素の理由。
 * 通れば `null`）。値は入れない。
 */
async function formlessActionabilityReasonOf(target: LoginFormTarget, timeoutMs: number): Promise<LoginFormInvalidReason | null> {
  const [usernameVisible, usernameEditable, passwordVisible, passwordEditable, submitVisible, submitEnabled] = await Promise.all([
    target.username.isVisible(),
    target.username.isEditable({ timeout: timeoutMs }),
    target.password.isVisible(),
    target.password.isEditable({ timeout: timeoutMs }),
    target.submit.isVisible(),
    target.submit.isEnabled({ timeout: timeoutMs }),
  ]);
  if (!usernameVisible || !usernameEditable) {
    return 'USERNAME_FIELD_INVALID';
  }
  if (!passwordVisible || !passwordEditable) {
    return 'PASSWORD_FIELD_INVALID';
  }
  return submitVisible && submitEnabled ? null : 'SUBMIT_BUTTON_INVALID';
}

/** 読んだ結果の形を確かめる（ページの中の結果は、信じずに形を見る）。 */
const isLoginFormReading = (value: unknown): value is LoginFormReading =>
  isRecord(value) && Array.isArray(value['counts']) && value['counts'].every((count) => Number.isSafeInteger(count))
  && (value['facts'] === null || isLoginFormFacts(value['facts']));

/**
 * 3 つの要素を読み、理由を決める（時間の上限の中で）。数は Playwright の `count()` で確かめ（ちょうど 1 つでなければ `SELECTOR_NOT_UNIQUE`）、
 * 事実は isolated world で読む。isolated world で数えた数が Playwright の数と違えば、読めないとして止める（`FORM_UNREADABLE`。T32j-4）。
 */
async function inspectWithin(target: LoginFormTarget, timeoutMs: number): Promise<LoginFormInspection> {
  const counts = await Promise.all([target.username.count(), target.password.count(), target.submit.count()]);
  if (counts.some((count) => count !== ONE_ELEMENT)) {
    return { ok: false, reason: 'SELECTOR_NOT_UNIQUE' };
  }
  const outcome = await readInIsolatedWorld(target.username.page(), readLoginFormFactsInPage, target.selectors, Date.now() + timeoutMs);
  if (outcome.status !== 'READ' || !isLoginFormReading(outcome.value)) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  const { facts } = outcome.value;
  if (facts === null || outcome.value.counts.length !== counts.length
    || outcome.value.counts.some((count, index) => count !== counts[index])) {
    return { ok: false, reason: 'FORM_UNREADABLE' };
  }
  const scriptSubmission = target.submission === SCRIPT_SUBMISSION;
  const reason = invalidReasonOf(facts, target.isAllowedAction, scriptSubmission)
    ?? (isFormlessScriptLogin(facts, scriptSubmission) ? await formlessActionabilityReasonOf(target, timeoutMs) : null);
  return reason === null ? { ok: true } : { ok: false, reason };
}

/**
 * フォームを読むだけで確かめる（値を受け取る前に呼ぶ。値を受けない）。読めなければ `FORM_UNREADABLE`。例外を投げない。
 */
export async function inspectLoginForm(target: LoginFormTarget, timeoutMs = LOGIN_FORM_STEP_TIMEOUT_MS): Promise<LoginFormInspection> {
  const outcome = await awaitBeforeDeadline(inspectWithin(target, timeoutMs), Date.now() + timeoutMs);
  return outcome.status === 'FULFILLED' ? outcome.value : { ok: false, reason: 'FORM_UNREADABLE' };
}

/**
 * ユーザー名とパスワードを、Playwright の `fill` で入れる（`inspectLoginForm` が通った後に呼ぶ）。失敗は、誤りの情報を持たない `{ ok: false }`
 * （誤りの文に値が入りうるので、捨てる）。例外を投げない。
 */
export async function fillLoginForm(
  target: LoginFormTarget,
  loginSecret: LoginFormSecret,
  timeoutMs = LOGIN_FORM_STEP_TIMEOUT_MS,
): Promise<LoginFormStepOutcome> {
  try {
    await target.username.fill(loginSecret.username, { timeout: timeoutMs });
    await target.password.fill(loginSecret.password, { timeout: timeoutMs });
    return STEP_SUCCEEDED;
  } catch {
    return INPUT_FAILED;
  }
}

/**
 * 送信のボタンを、Playwright の `click` で押す。押した後のナビゲーションは待たない（`noWaitAfter`。Playwright の将来の既定。結果は呼ぶ側が
 * 要求と応答の観測で待つ。応答の遅いサーバで、押した後の待ちが時間の上限に掛かって失敗にならないため）。失敗は、誤りの情報を持たない
 * `{ ok: false }`（押した後の失敗かもしれないので、呼ぶ側は送信を分からないとする）。例外を投げない。
 */
export async function clickLoginSubmit(target: LoginFormTarget, timeoutMs = LOGIN_FORM_STEP_TIMEOUT_MS): Promise<LoginFormStepOutcome> {
  try {
    await target.submit.click({ timeout: timeoutMs, noWaitAfter: true });
    return STEP_SUCCEEDED;
  } catch {
    return INPUT_FAILED;
  }
}
