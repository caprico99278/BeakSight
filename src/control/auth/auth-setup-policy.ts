// 認証の設定の判定の唯一の owner（Task 25 の設計書 4.1、5 章。T25a）。
// - `validateAuthSetup`: 入力の写しを取り（写せない値は形の誤り）、以後は写しだけを読む。fail-closed で、当たった誤りをすべて返す
//   （Task 22 の `validateSiteProfile` の返し方に合わせる）。順は次のとおり。
//   1. 上限（長さ・件数・回数）。大きな入力を、スキーマの検証や URL の解析に渡す前に止める。当たれば `AUTH_SETUP_LIMIT_EXCEEDED` だけを返す。
//   2. 形（スキーマ）。合わなければ `AUTH_SETUP_SCHEMA_INVALID` だけを返す。
//   3. 値の規則（プロファイルとの結びつき、モード、Origin の包含、URL と path の形、秘密に見える値、IdP、セレクタ、成功の条件の
//      あいまいさ、自動ログインの設定）。すべて確かめる。
// - 受けるのは版 2（`beaksight-auth-setup/2`。Task 26 の設計書 4.3。T26b）だけ。版 1 の文書は形の誤り（管理データの版 1 の文書を版 2 に
//   直すのは、読むときの `auth-setup-store.ts` だけ）。`automatedLogin` の要否は、プロファイルの認証の方式で決める（自動ログインなら必須で、
//   回数は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ。手動のログインなら null だけ）。
// - プロファイルは `ValidatedSiteProfile` の型で受けるが、型の変換で印を付けた値もありうるので、渡された文脈で `validateSiteProfile` を
//   通し直す（通らなければ `AUTH_SETUP_PROFILE_INVALID`）。プロファイルの値は、その写しから読む。
// - 誤りの文（`detail`）には、項目の名前と位置だけを書き、設定の値（URL、path、セレクタ、query の値）を入れない。
// - CCX-23（CC-061）: 誤りには、誤りのある項目の位置（`pointer`。JSON Pointer）も付ける。文の項目の名前と位置は、同じ区切りの並び
//   （`FieldLocation`）から作る（文は変えない）。画面は、英語の文を読まずに、この位置で項目と行を決める。
// - Origin の判定は、URL の意味の owner（`src/crawl/normalize-url.ts`）の部品を呼ぶだけにする（GATE-ARCH04）。
// - T30a fix round 1（Task 30 の設計書 3 章の「検証の指定」）: path の形（`isAcceptedPath`）、セレクタの形（`isAcceptedSelector`）、2 つの結果の
//   条件が同時に当たりうるか（`mayMatchTogether`）を、Task 26 の判定の owner として公開する（中身は変えない）。シナリオの検証の指定の確かめ
//   （`src/control/approval/scenario-policy.ts`）が使う（書き写さない）。
// 入出力を持たない。Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）を import しない。
import { isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { jsonPointerOf } from '../../core/json-pointer.js';
import { schemaIssuePointerOf } from '../../core/schema-validator.js';
import { isSecretLikeQueryName } from '../../core/secret-query-names.js';
import { hasControlOrLineSeparator, hasLoneSurrogate } from '../../core/text.js';
import {
  canonicalHttpOriginOf,
  hasUrlCredentials,
  isHttpProtocol,
  isOriginInAllowedOrigins,
} from '../../crawl/normalize-url.js';
import type { AuthStrategy, ValidatedSiteProfile } from '../contracts.js';
import { validateControlDocument, type ControlSchemaName } from '../control-schema-validator.js';
import { PROFILE_OPERATION_POLICY, isProfileOperationAllowed, type ProfileOperation } from '../execution-policy.js';
import { validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import {
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MAX_ALLOWED_IDP_ORIGINS,
  MAX_AUTH_SETUP_PATH_LIST_ITEMS,
  MAX_AUTH_SETUP_URL_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_POST_ENDPOINTS,
  MAX_SUCCESS_SELECTOR_LENGTH,
  MIN_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AuthSetupValidationError,
  type AuthSetupValidationErrorCode,
  type AuthSetupValidationResult,
  type AutomatedLoginSetup,
  type LoginResultCondition,
} from './auth-setup-contracts.js';

/**
 * 認証の設定を受ける操作（T28b）。受けるモードと認証の方式は、`src/control/execution-policy.ts` の閉じた一覧（`PROFILE_OPERATION_POLICY` の
 * `AUTH_SETUP` の行）だけで決める（Task 25 の設計書 4.1 の `TEST_AUTH_PASSIVE` に、Task 28 の設計書 4.5 で `TEST_APPROVED_WRITE` を足した。
 * 方式は、手動のログインと自動ログイン）。
 */
const AUTH_SETUP_OPERATION: ProfileOperation = 'AUTH_SETUP';

/** 認証の設定を受けるモードと、その方式（誤りの文に書く。値は owner の一覧から読む）。 */
const AUTH_SETUP_ACCEPTED_TEXT = Object.entries(PROFILE_OPERATION_POLICY[AUTH_SETUP_OPERATION])
  .map(([mode, strategies]) => `${mode} (${(strategies ?? []).join(' or ')})`)
  .join(', ');

/** 手動のログインの方式（Task 25。`automatedLogin` は null だけ）。 */
const MANUAL_STRATEGY: AuthStrategy = 'MANUAL_SESSION';

/** 自動ログインの方式（Task 26 の設計書 4.3。`automatedLogin` が必須で、回数は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ）。 */
const AUTOMATED_STRATEGY: AuthStrategy = 'AUTOMATED_LOGIN';

/** 版 2 のスキーマの名前（検証が受けるのは版 2 だけ。T26b）。 */
const AUTH_SETUP_SCHEMA_NAME: ControlSchemaName = 'auth-setup-v2';

/** 自動ログインの 3 つのセレクタの項目（`AutomatedLoginSetup` の名前。誤りの文の項目の名前にも使う）。 */
const AUTOMATED_LOGIN_SELECTOR_FIELDS = Object.freeze(['usernameSelector', 'passwordSelector', 'submitSelector'] as const);

/** 自動ログインの設定と、成功の条件の項目の名前（誤りの文と位置の項目の名前）。 */
const AUTOMATED_LOGIN_LABEL = 'automatedLogin';
const FAILURE_CONDITIONS_FIELD = 'failureConditions';
const SUCCESS_CONDITION_LABEL = 'successCondition';

/** path の先頭の文字。 */
const PATH_ROOT = '/';

/** path に書ける文字の全体: RFC 3986 の pchar（英数字、`-._~`、sub-delims、`:`、`@`、`%`）と区切りの `/`。 */
const PATH_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/u;

/** 親の区切り（`..`）。名前の中にあっても拒む（fail-closed）。 */
const PARENT_SEGMENT = '..';

/** 空の区切り（`//`。先頭なら別の host を指す形になる）。どこにあっても拒む。 */
const EMPTY_SEGMENT = '//';

/** 符号化した `.`（`%2e`。符号化した親の区切りを作れる）。大文字と小文字を区別せずに拒む。 */
const ENCODED_DOT = /%2e/iu;

/** 正しくない百分率の符号化（`%` の後に 16 進の 2 桁がない）。 */
const MALFORMED_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/u;

/** fragment の区切り。URL の中のどこにあっても拒む（空の fragment を含む）。 */
const FRAGMENT_SEPARATOR = '#';

/** 位置の区切り 1 つ（項目の名前か、配列の位置）。 */
type LocationSegment = string | number;

/**
 * 誤りのある項目の位置（CCX-23。CC-061）。同じ区切りの並びから、誤りの文の項目の名前（`label`。`loginPostEndpoints[0].origin`）と、
 * JSON Pointer（`pointer`。`/loginPostEndpoints/0/origin`）を作る。
 */
interface FieldLocation {
  readonly segments: readonly LocationSegment[];
  readonly label: string;
  readonly pointer: string;
}

/**
 * 区切りの並びの位置。文の名前は、項目の名前を `.` で、配列の位置を `[n]` でつなぐ（今までの誤りの文の名前と同じ）。JSON Pointer は、
 * `src/core/json-pointer.ts` の `jsonPointerOf` で作る（CCX-26）。
 */
const locationOf = (...segments: readonly LocationSegment[]): FieldLocation => Object.freeze({
  segments: Object.freeze([...segments]),
  label: segments.map((segment, index) =>
    (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`)).join(''),
  pointer: jsonPointerOf(segments.map(String)),
});

/** 位置の下の項目の位置。 */
const childOf = (parent: FieldLocation, segment: LocationSegment): FieldLocation => locationOf(...parent.segments, segment);

const errorOf = (code: AuthSetupValidationErrorCode, detail: string, pointer: string | null): AuthSetupValidationError =>
  Object.freeze({ code, detail, pointer });

/** 項目の位置（誤りの文の名前と、JSON Pointer）。 */
const LOGIN_START_URL_LOCATION = locationOf('loginStartUrl');
const LOGIN_POST_ENDPOINTS_LOCATION = locationOf('loginPostEndpoints');
const SUCCESS_PATH_PREFIX_LOCATION = locationOf(SUCCESS_CONDITION_LABEL, 'pathPrefix');
const SUCCESS_SELECTOR_LOCATION = locationOf(SUCCESS_CONDITION_LABEL, 'selector');
const SESSION_LOST_PATH_PREFIX_LOCATION = locationOf('sessionLostCondition', 'pathPrefix');
const EXCLUDED_PATHS_LOCATION = locationOf('excludedPaths');
const AUDIT_PATH_PREFIXES_LOCATION = locationOf('auditPathPrefixes');
const ALLOWED_IDP_ORIGINS_LOCATION = locationOf('allowedIdpOrigins');
const MAX_LOGIN_ATTEMPTS_LOCATION = locationOf('maxLoginAttempts');
const PROFILE_ID_LOCATION = locationOf('profileId');
const PROFILE_REVISION_LOCATION = locationOf('profileRevision');
const AUTOMATED_LOGIN_LOCATION = locationOf(AUTOMATED_LOGIN_LABEL);
const FAILURE_CONDITIONS_LOCATION = childOf(AUTOMATED_LOGIN_LOCATION, FAILURE_CONDITIONS_FIELD);

const rejected = (errors: readonly AuthSetupValidationError[]): AuthSetupValidationResult =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

// ---------------------------------------------------------------------------------------------------------------
// 1. 上限（スキーマの前。写しを、自身のプロパティと型を確かめながら読む）
// ---------------------------------------------------------------------------------------------------------------

/** 写しの自身のプロパティの値（オブジェクトでないか、プロパティがなければ `undefined`）。 */
const ownFieldOf = (value: unknown, key: string): unknown => (isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined);

/** 文字列が長さの上限（UTF-16 のコード単位）を超えるか（文字列でなければ、形の誤りとしてスキーマに任せる）。 */
const isTooLong = (value: unknown, maxLength: number): boolean => typeof value === 'string' && value.length > maxLength;

/** 配列の値（配列でなければ空。形の誤りはスキーマに任せる）。 */
const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** 文字列の項目の長さの誤り。 */
const lengthErrorsOf = (location: FieldLocation, value: unknown, maxLength: number): readonly AuthSetupValidationError[] =>
  isTooLong(value, maxLength)
    ? [errorOf('AUTH_SETUP_LIMIT_EXCEEDED', `${location.label} must be at most ${maxLength} UTF-16 code units`, location.pointer)]
    : [];

/** 配列の項目の件数の誤り。 */
const itemCountErrorsOf = (location: FieldLocation, items: readonly unknown[], maxItems: number): readonly AuthSetupValidationError[] =>
  items.length > maxItems
    ? [errorOf('AUTH_SETUP_LIMIT_EXCEEDED', `${location.label} must have at most ${maxItems} items`, location.pointer)]
    : [];

/** 配列の項目の件数と、各項目の長さの誤り。 */
const listLimitErrorsOf = (location: FieldLocation, value: unknown, maxItems: number): readonly AuthSetupValidationError[] => {
  const items = arrayOf(value);
  return [
    ...itemCountErrorsOf(location, items, maxItems),
    ...items.slice(0, maxItems).flatMap((item, index) => lengthErrorsOf(childOf(location, index), item, MAX_AUTH_SETUP_URL_LENGTH)),
  ];
};

/** 自動ログインの設定の長さの誤り（T26b。3 つのセレクタと、失敗の条件の path とセレクタ）。 */
const automatedLoginLimitErrorsOf = (automatedLogin: unknown): readonly AuthSetupValidationError[] => {
  const failureConditions = ownFieldOf(automatedLogin, 'failureConditions');
  return [
    ...AUTOMATED_LOGIN_SELECTOR_FIELDS.flatMap((field) =>
      lengthErrorsOf(childOf(AUTOMATED_LOGIN_LOCATION, field), ownFieldOf(automatedLogin, field), MAX_SUCCESS_SELECTOR_LENGTH)),
    ...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind) => {
      const condition = ownFieldOf(failureConditions, kind);
      const location = childOf(FAILURE_CONDITIONS_LOCATION, kind);
      return [
        ...lengthErrorsOf(childOf(location, 'pathPrefix'), ownFieldOf(condition, 'pathPrefix'), MAX_AUTH_SETUP_URL_LENGTH),
        ...lengthErrorsOf(childOf(location, 'selector'), ownFieldOf(condition, 'selector'), MAX_SUCCESS_SELECTOR_LENGTH),
      ];
    }),
  ];
};

/** 上限の誤り（設計書 4.1。長さ・件数・回数）。 */
const limitErrorsOf = (copy: unknown): readonly AuthSetupValidationError[] => {
  const errors: AuthSetupValidationError[] = [
    ...lengthErrorsOf(LOGIN_START_URL_LOCATION, ownFieldOf(copy, 'loginStartUrl'), MAX_AUTH_SETUP_URL_LENGTH),
  ];
  const endpoints = arrayOf(ownFieldOf(copy, 'loginPostEndpoints'));
  errors.push(...itemCountErrorsOf(LOGIN_POST_ENDPOINTS_LOCATION, endpoints, MAX_LOGIN_POST_ENDPOINTS));
  endpoints.slice(0, MAX_LOGIN_POST_ENDPOINTS).forEach((endpoint, index) => {
    const location = childOf(LOGIN_POST_ENDPOINTS_LOCATION, index);
    errors.push(
      ...lengthErrorsOf(childOf(location, 'origin'), ownFieldOf(endpoint, 'origin'), MAX_AUTH_SETUP_URL_LENGTH),
      ...lengthErrorsOf(childOf(location, 'path'), ownFieldOf(endpoint, 'path'), MAX_AUTH_SETUP_URL_LENGTH),
    );
  });
  const success = ownFieldOf(copy, SUCCESS_CONDITION_LABEL);
  errors.push(
    ...lengthErrorsOf(SUCCESS_PATH_PREFIX_LOCATION, ownFieldOf(success, 'pathPrefix'), MAX_AUTH_SETUP_URL_LENGTH),
    ...lengthErrorsOf(SUCCESS_SELECTOR_LOCATION, ownFieldOf(success, 'selector'), MAX_SUCCESS_SELECTOR_LENGTH),
    ...lengthErrorsOf(
      SESSION_LOST_PATH_PREFIX_LOCATION,
      ownFieldOf(ownFieldOf(copy, 'sessionLostCondition'), 'pathPrefix'),
      MAX_AUTH_SETUP_URL_LENGTH,
    ),
    ...listLimitErrorsOf(EXCLUDED_PATHS_LOCATION, ownFieldOf(copy, 'excludedPaths'), MAX_AUTH_SETUP_PATH_LIST_ITEMS),
    ...listLimitErrorsOf(AUDIT_PATH_PREFIXES_LOCATION, ownFieldOf(copy, 'auditPathPrefixes'), MAX_AUTH_SETUP_PATH_LIST_ITEMS),
    ...listLimitErrorsOf(ALLOWED_IDP_ORIGINS_LOCATION, ownFieldOf(copy, 'allowedIdpOrigins'), MAX_ALLOWED_IDP_ORIGINS),
  );
  const attempts = ownFieldOf(copy, 'maxLoginAttempts');
  if (Number.isInteger(attempts) && ((attempts as number) < MIN_LOGIN_ATTEMPTS || (attempts as number) > MAX_LOGIN_ATTEMPTS)) {
    errors.push(errorOf(
      'AUTH_SETUP_LIMIT_EXCEEDED',
      `${MAX_LOGIN_ATTEMPTS_LOCATION.label} must be from ${MIN_LOGIN_ATTEMPTS} to ${MAX_LOGIN_ATTEMPTS}`,
      MAX_LOGIN_ATTEMPTS_LOCATION.pointer,
    ));
  }
  errors.push(...automatedLoginLimitErrorsOf(ownFieldOf(copy, AUTOMATED_LOGIN_LABEL)));
  return errors;
};

// ---------------------------------------------------------------------------------------------------------------
// 3. 値の規則（形はスキーマで確かめ済み）
// ---------------------------------------------------------------------------------------------------------------

/** path の形: `/` で始まり、`//`・`..`・符号化した `.`・正しくない百分率の符号化を含まず、使える文字（`PATH_CHARACTERS`）だけ。 */
export const isAcceptedPath = (path: string): boolean =>
  path.startsWith(PATH_ROOT)
  && PATH_CHARACTERS.test(path)
  && !path.includes(EMPTY_SEGMENT)
  && !path.includes(PARENT_SEGMENT)
  && !ENCODED_DOT.test(path)
  && !MALFORMED_PERCENT_ENCODING.test(path);

const pathErrorsOf = (location: FieldLocation, path: string): readonly AuthSetupValidationError[] =>
  isAcceptedPath(path)
    ? []
    : [errorOf(
      'AUTH_SETUP_PATH_INVALID',
      `${location.label} must start with "/" and contain only path characters, without "//", "..", an encoded dot or a control character`,
      location.pointer,
    )];

/** 解析した URL（http(s)、userinfo なし、fragment なし、正規の形）。受けなければ `undefined`。 */
const acceptedUrlOf = (value: string): URL | undefined => {
  if (value.includes(FRAGMENT_SEPARATOR)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return isHttpProtocol(url.protocol) && !hasUrlCredentials(url) && url.href === value ? url : undefined;
};

/** Origin が、プロファイルの `approvedTestOrigins` に含まれないときの誤り。 */
const approvalErrorsOf = (location: FieldLocation, origin: string, approved: readonly string[]): readonly AuthSetupValidationError[] =>
  isOriginInAllowedOrigins(approved, origin)
    ? []
    : [errorOf('AUTH_SETUP_ORIGIN_NOT_APPROVED', `the origin of ${location.label} is not in approvedTestOrigins of the profile`, location.pointer)];

/** `loginStartUrl` の誤り。 */
const loginStartUrlErrorsOf = (value: string, approved: readonly string[]): readonly AuthSetupValidationError[] => {
  const location = LOGIN_START_URL_LOCATION;
  const url = acceptedUrlOf(value);
  if (url === undefined) {
    return [errorOf(
      'AUTH_SETUP_URL_INVALID',
      `${location.label} must be an absolute http(s) URL in its canonical form, without userinfo and without a fragment`,
      location.pointer,
    )];
  }
  const errors: AuthSetupValidationError[] = [...approvalErrorsOf(location, url.origin, approved)];
  if ([...url.searchParams.keys()].some(isSecretLikeQueryName)) {
    errors.push(errorOf(
      'AUTH_SETUP_SECRET_LIKE_VALUE',
      `${location.label} must not have a query parameter whose name looks like a secret`,
      location.pointer,
    ));
  }
  return errors;
};

/** `loginPostEndpoints` の誤り。 */
const endpointErrorsOf = (setup: AuthSetup, approved: readonly string[]): readonly AuthSetupValidationError[] =>
  setup.loginPostEndpoints.flatMap((endpoint, index) => {
    const location = childOf(LOGIN_POST_ENDPOINTS_LOCATION, index);
    const originLocation = childOf(location, 'origin');
    const originErrors = canonicalHttpOriginOf(endpoint.origin) === undefined
      ? [errorOf(
        'AUTH_SETUP_URL_INVALID',
        `${originLocation.label} must be the canonical serialization of an http(s) origin`,
        originLocation.pointer,
      )]
      : approvalErrorsOf(originLocation, endpoint.origin, approved);
    return [...originErrors, ...pathErrorsOf(childOf(location, 'path'), endpoint.path)];
  });

/**
 * 成功の条件の path の前方一致が、ログインの画面の path か、セッションが切れたと判定する path（既定はログインの画面の path）にも
 * 当たるときの誤り（T25a round 1）。比べは文字列の前方一致（`successCondition.pathPrefix` の意味と同じ）。`loginStartUrl` を受けない
 * ときは、その誤り（`AUTH_SETUP_URL_INVALID`）に任せて、ここでは確かめない。
 */
const successAmbiguityErrorsOf = (setup: AuthSetup): readonly AuthSetupValidationError[] => {
  const loginUrl = acceptedUrlOf(setup.loginStartUrl);
  if (loginUrl === undefined) {
    return [];
  }
  const successPrefix = setup.successCondition.pathPrefix;
  const sessionLostPath = setup.sessionLostCondition.pathPrefix ?? loginUrl.pathname;
  return loginUrl.pathname.startsWith(successPrefix) || sessionLostPath.startsWith(successPrefix)
    ? [errorOf(
      'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS',
      `${SUCCESS_PATH_PREFIX_LOCATION.label} must not match the path of loginStartUrl or the session lost path`,
      SUCCESS_PATH_PREFIX_LOCATION.pointer,
    )]
    : [];
};

/**
 * CSS セレクタの形（空白だけでなく、制御文字・行と段落の区切り・対でないサロゲートを含まない）。成功の条件のセレクタ、自動ログインの
 * 3 つのセレクタ、失敗の条件のセレクタの、共通の決まり（Task 26 の設計書 4.3。T26b）。書けない文字（制御文字の Cc と、行・段落の区切りの
 * Zl、Zp）と、対でないサロゲートの判定は、`src/core/text.ts` の部品を使う（CCX-3）。
 */
export const isAcceptedSelector = (selector: string): boolean =>
  selector.trim().length > 0 && !hasControlOrLineSeparator(selector) && !hasLoneSurrogate(selector);

/** 任意のセレクタ（成功の条件と失敗の条件）の誤り（null は受ける）。 */
const optionalSelectorErrorsOf = (location: FieldLocation, selector: string | null): readonly AuthSetupValidationError[] =>
  selector === null || isAcceptedSelector(selector)
    ? []
    : [errorOf(
      'AUTH_SETUP_SELECTOR_INVALID',
      `${location.label} must be null, or a non-blank selector without control characters, line breaks or lone surrogates`,
      location.pointer,
    )];

/** 必須のセレクタ（自動ログインの 3 つのセレクタ）の誤り。 */
const requiredSelectorErrorsOf = (location: FieldLocation, selector: string): readonly AuthSetupValidationError[] =>
  isAcceptedSelector(selector)
    ? []
    : [errorOf(
      'AUTH_SETUP_SELECTOR_INVALID',
      `${location.label} must be a non-blank selector without control characters, line breaks or lone surrogates`,
      location.pointer,
    )];

/**
 * 標準の CSS として読めない、Playwright 独自のセレクタの書き方の印（閉じた一覧。T32j-4。Task 32 の設計書 4.4 の「CC-068 の設計」の 2 と、
 * ユーザーの判断 11「設定の検証で拒む」）。自動ログインの 3 つのセレクタは、ログインの form の事前の確かめが isolated world の中で標準の CSS
 * として探し直す（`src/browser/login-form-submitter.ts`）ので、これらの印を持つセレクタは拒む。完全な CSS の解析はしない（印は近似。属性の値の
 * 中の印も拒む側に倒す）。印のないセレクタでも、実行のときに isolated world で読めなければ（shadow root をまたぐ書き方など）、ログインの form
 * を読めないとして止まる（`FORM_UNREADABLE`）。
 * - エンジンの前置き（`css=`・`xpath=`・`text=`・`id=`・`internal:role=`・`css:light=` など）。
 * - XPath と文字列の書き方（`//`・`..` で始まる、引用符で始まる）。
 * - 選び方をつなぐ `>>`。
 * - Playwright 独自の擬似クラス（`:has-text()`・`:text()`・`:text-is()`・`:text-matches()`・`:visible`・`:nth-match()`・`:left-of()`・
 *   `:right-of()`・`:above()`・`:below()`・`:near()`。大文字と小文字を区別しない）。
 */
export const PLAYWRIGHT_ONLY_SELECTOR_MARKS: readonly RegExp[] = Object.freeze([
  /^\s*[a-z_][\w-]*(?::[\w-]+)?\s*=/iu,
  /^\s*(?:\/\/|\.\.|["'`])/u,
  />>/u,
  /:(?:has-text|text|text-is|text-matches|visible|nth-match|left-of|right-of|above|below|near)(?![\w-])/iu,
]);

/** 標準の CSS として isolated world で探し直せる形か（`PLAYWRIGHT_ONLY_SELECTOR_MARKS` の印がない）。 */
export const isStandardCssSelectorShape = (selector: string): boolean =>
  !PLAYWRIGHT_ONLY_SELECTOR_MARKS.some((mark) => mark.test(selector));

/** 自動ログインの 3 つのセレクタの誤り（形の誤りがなければ、標準の CSS の形か）。 */
const automatedLoginSelectorErrorsOf = (location: FieldLocation, selector: string): readonly AuthSetupValidationError[] => {
  const formErrors = requiredSelectorErrorsOf(location, selector);
  if (formErrors.length > 0 || isStandardCssSelectorShape(selector)) {
    return formErrors;
  }
  return [errorOf(
    'AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS',
    `${location.label} must be a standard CSS selector without Playwright-only forms (engine prefixes, >>, :has-text(), :visible and the like)`,
    location.pointer,
  )];
};

/** path の一覧の誤り。 */
const pathListErrorsOf =(location: FieldLocation, paths: readonly string[]): readonly AuthSetupValidationError[] =>
  paths.flatMap((path, index) => pathErrorsOf(childOf(location, index), path));

/** 失敗の条件のうち null でないものと、その項目の位置（閉じた一覧の順）。 */
const failureConditionsOf = (
  automatedLogin: AutomatedLoginSetup,
): readonly { readonly location: FieldLocation; readonly condition: LoginResultCondition }[] =>
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind) => {
    const condition = automatedLogin.failureConditions[kind];
    return condition === null ? [] : [{ location: childOf(FAILURE_CONDITIONS_LOCATION, kind), condition }];
  });

/**
 * 2 つのログインの結果の条件が、同時に当たりうるか（Task 26 の設計書 4.3、4.4。T26b）: `pathPrefix` が同じで、`selector` も同じか、どちらかに
 * `selector` がない。失敗の条件と成功の条件の組と、失敗の条件どうしの組（T26e。T26b の発見 6 への設計者の判断）の、共通の規則。
 */
export const mayMatchTogether = (left: LoginResultCondition, right: LoginResultCondition): boolean =>
  left.pathPrefix === right.pathPrefix && (left.selector === null || right.selector === null || left.selector === right.selector);

/**
 * 自動ログインの設定の中身の誤り（T26b。設定があるときは、プロファイルの方式によらず確かめる）: 3 つのセレクタの形と重なり、失敗の条件の
 * path とセレクタの形、失敗の条件どうしと、失敗の条件と成功の条件の重なり。
 */
const automatedLoginContentErrorsOf = (setup: AuthSetup, automatedLogin: AutomatedLoginSetup): readonly AuthSetupValidationError[] => {
  const selectorFields = AUTOMATED_LOGIN_SELECTOR_FIELDS.map((field) => ({ field, location: childOf(AUTOMATED_LOGIN_LOCATION, field) }));
  const errors: AuthSetupValidationError[] = selectorFields.flatMap(({ field, location }) =>
    automatedLoginSelectorErrorsOf(location, automatedLogin[field]));
  const selectors = AUTOMATED_LOGIN_SELECTOR_FIELDS.map((field) => automatedLogin[field]);
  if (new Set(selectors).size < selectors.length) {
    // 位置は、3 つのセレクタの先頭（ユーザー名のセレクタ）の欄にする（画面は、その欄に出す。CCX-23 の前と同じ）。
    errors.push(errorOf(
      'AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED',
      `${selectorFields.map(({ location }) => location.label).join(', ')} must be different from each other`,
      selectorFields[0]?.location.pointer ?? AUTOMATED_LOGIN_LOCATION.pointer,
    ));
  }
  const failures = failureConditionsOf(automatedLogin);
  failures.forEach(({ location, condition }, index) => {
    errors.push(
      ...pathErrorsOf(childOf(location, 'pathPrefix'), condition.pathPrefix),
      ...optionalSelectorErrorsOf(childOf(location, 'selector'), condition.selector),
    );
    if (mayMatchTogether(condition, setup.successCondition)) {
      errors.push(errorOf(
        'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS',
        `${location.label} may match together with ${SUCCESS_CONDITION_LABEL} (the same pathPrefix, and the same selector or no selector on either)`,
        location.pointer,
      ));
    }
    failures.slice(0, index).forEach((earlier) => {
      if (mayMatchTogether(condition, earlier.condition)) {
        errors.push(errorOf(
          'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS',
          `${location.label} may match together with ${earlier.location.label} (the same pathPrefix, and the same selector or no selector on either)`,
          location.pointer,
        ));
      }
    });
  });
  return errors;
};

/**
 * プロファイルが、認証の設定を受けるモードと方式か（T26b。T28b で判定を `execution-policy.ts` の owner に寄せた。`TEST_AUTH_PASSIVE` と
 * `TEST_APPROVED_WRITE` で、手動のログインか自動ログイン）。
 */
const isSupportedProfile = (profile: unknown): boolean =>
  isProfileOperationAllowed(AUTH_SETUP_OPERATION, ownFieldOf(profile, 'mode'), ownFieldOf(profile, 'auth'));

/**
 * プロファイルの方式で決まる誤り（Task 26 の設計書 4.3。T26b）。受けないモードと方式（`AUTH_SETUP_MODE_UNSUPPORTED`）では確かめない。
 * - 自動ログイン: `automatedLogin` が必須。`maxLoginAttempts` は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ（回数の上限の誤り）。
 * - 手動のログイン: `automatedLogin` は null だけ。
 */
const strategyErrorsOf = (setup: AuthSetup, profile: unknown): readonly AuthSetupValidationError[] => {
  if (!isSupportedProfile(profile)) {
    return [];
  }
  if (ownFieldOf(profile, 'auth') !== AUTOMATED_STRATEGY) {
    return setup.automatedLogin === null
      ? []
      : [errorOf(
        'AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED',
        `${AUTOMATED_LOGIN_LOCATION.label} must be null for a profile with auth ${MANUAL_STRATEGY}`,
        AUTOMATED_LOGIN_LOCATION.pointer,
      )];
  }
  const errors: AuthSetupValidationError[] = [];
  if (setup.automatedLogin === null) {
    errors.push(errorOf(
      'AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED',
      `${AUTOMATED_LOGIN_LOCATION.label} is required for a profile with auth ${AUTOMATED_STRATEGY}`,
      AUTOMATED_LOGIN_LOCATION.pointer,
    ));
  }
  if (setup.maxLoginAttempts !== AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS) {
    errors.push(errorOf(
      'AUTH_SETUP_LIMIT_EXCEEDED',
      `${MAX_LOGIN_ATTEMPTS_LOCATION.label} must be ${AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS} for a profile with auth ${AUTOMATED_STRATEGY}`,
      MAX_LOGIN_ATTEMPTS_LOCATION.pointer,
    ));
  }
  return errors;
};

/** プロファイルの写し（`structuredClone`。写せなければ `undefined`）と、渡された文脈での検証の結果。 */
interface ProfileSide {
  readonly copy: unknown;
  readonly errors: readonly AuthSetupValidationError[];
}

const profileSideOf = (profile: ValidatedSiteProfile, context: ProfileValidationContext): ProfileSide => {
  let copy: unknown;
  try {
    copy = structuredClone(profile);
  } catch {
    return { copy: undefined, errors: [errorOf('AUTH_SETUP_PROFILE_INVALID', 'the profile must be a plain JSON value', null)] };
  }
  const validation = validateSiteProfile(copy, context);
  return {
    copy,
    errors: validation.ok
      ? []
      : [errorOf(
        'AUTH_SETUP_PROFILE_INVALID',
        `the profile does not pass validateSiteProfile with the given context (${[...new Set(validation.errors.map(({ code }) => code))].join(', ')})`,
        null,
      )],
  };
};

/** 写しの文字列の配列（配列でなければ空。文字列でない項目は除く）。 */
const stringsOf = (value: unknown): readonly string[] => arrayOf(value).filter((item): item is string => typeof item === 'string');

/** プロファイルとの結びつきと、モードと、Origin の包含の誤り。 */
const profileBindingErrorsOf = (
  setup: AuthSetup,
  profile: unknown,
  context: ProfileValidationContext,
): readonly AuthSetupValidationError[] => {
  const errors: AuthSetupValidationError[] = [];
  if (!isSupportedProfile(profile)) {
    errors.push(errorOf(
      'AUTH_SETUP_MODE_UNSUPPORTED',
      `an auth setup is accepted only for a profile with the mode and auth: ${AUTH_SETUP_ACCEPTED_TEXT}`,
      null,
    ));
  }
  if (ownFieldOf(profile, 'profileId') !== setup.profileId) {
    errors.push(errorOf('AUTH_SETUP_PROFILE_MISMATCH', `${PROFILE_ID_LOCATION.label} differs from the profile`, PROFILE_ID_LOCATION.pointer));
  }
  if (ownFieldOf(profile, 'revision') !== setup.profileRevision) {
    errors.push(errorOf(
      'AUTH_SETUP_PROFILE_REVISION_MISMATCH',
      `${PROFILE_REVISION_LOCATION.label} differs from the revision of the profile`,
      PROFILE_REVISION_LOCATION.pointer,
    ));
  }
  stringsOf(ownFieldOf(profile, 'approvedTestOrigins')).forEach((origin, index) => {
    if (!isOriginInAllowedOrigins(context.targetConfig.site.allowedOrigins, origin)) {
      errors.push(errorOf(
        'AUTH_SETUP_ORIGIN_OUTSIDE_TARGET',
        `approvedTestOrigins[${index}] of the profile is not included in site.allowedOrigins of the target configuration`,
        null,
      ));
    }
  });
  return errors;
};

/** 値の規則の誤り（すべて）。 */
const ruleErrorsOf = (
  setup: AuthSetup,
  profile: ValidatedSiteProfile,
  context: ProfileValidationContext,
): readonly AuthSetupValidationError[] => {
  const profileSide = profileSideOf(profile, context);
  const approved = stringsOf(ownFieldOf(profileSide.copy, 'approvedTestOrigins'));
  const errors: AuthSetupValidationError[] = [
    ...profileSide.errors,
    ...profileBindingErrorsOf(setup, profileSide.copy, context),
    ...loginStartUrlErrorsOf(setup.loginStartUrl, approved),
    ...endpointErrorsOf(setup, approved),
    ...pathErrorsOf(SUCCESS_PATH_PREFIX_LOCATION, setup.successCondition.pathPrefix),
    ...optionalSelectorErrorsOf(SUCCESS_SELECTOR_LOCATION, setup.successCondition.selector),
    ...successAmbiguityErrorsOf(setup),
    ...strategyErrorsOf(setup, profileSide.copy),
    ...(setup.automatedLogin === null ? [] : automatedLoginContentErrorsOf(setup, setup.automatedLogin)),
    ...(setup.sessionLostCondition.pathPrefix === null
      ? []
      : pathErrorsOf(SESSION_LOST_PATH_PREFIX_LOCATION, setup.sessionLostCondition.pathPrefix)),
    ...pathListErrorsOf(EXCLUDED_PATHS_LOCATION, setup.excludedPaths),
    ...pathListErrorsOf(AUDIT_PATH_PREFIXES_LOCATION, setup.auditPathPrefixes),
  ];
  if (setup.allowedIdpOrigins.length > 0) {
    errors.push(errorOf(
      'AUTH_SETUP_IDP_NOT_SUPPORTED',
      `${ALLOWED_IDP_ORIGINS_LOCATION.label} must be empty (an identity provider on another origin is not supported)`,
      ALLOWED_IDP_ORIGINS_LOCATION.pointer,
    ));
  }
  return errors;
};

/**
 * 認証の設定を検証する（設計書 4.1）。`profile` は `validateSiteProfile` を通ったプロファイル、`context` はその検証に使う文脈
 * （参照するターゲット JSON を読み込んだ結果）。受けるときは凍結した写し（呼び出し側の値と参照を共有しない）を返す。例外を投げない
 * （`context` の形の誤りは、呼び出し側の誤りとして `TypeError` を投げることがある。`validateSiteProfile` と同じ）。
 */
export const validateAuthSetup = (
  input: unknown,
  profile: ValidatedSiteProfile,
  context: ProfileValidationContext,
): AuthSetupValidationResult => {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    return rejected([errorOf('AUTH_SETUP_SCHEMA_INVALID', 'the auth setup must be a plain JSON value', null)]);
  }
  const limitErrors = limitErrorsOf(copy);
  if (limitErrors.length > 0) {
    return rejected(limitErrors);
  }
  const shape = validateControlDocument(AUTH_SETUP_SCHEMA_NAME, copy);
  if (!shape.ok) {
    // 位置は、スキーマの検証の部品が構造で返す位置から作る（文から読み取らない。CC-086。CCX-24）。文は `errors` と同じ。
    return rejected(shape.issues.map((issue) => errorOf('AUTH_SETUP_SCHEMA_INVALID', issue.message, schemaIssuePointerOf(issue))));
  }
  const setup = copy as AuthSetup;
  const errors = ruleErrorsOf(setup, profile, context);
  return errors.length > 0 ? rejected(errors) : Object.freeze({ ok: true, setup: deepFreeze(setup) });
};

/** セッションが切れたと判定する path の前方一致（設計書 4.1。既定は `loginStartUrl` の path）。`setup` は検証を通った設定。 */
export const sessionLostPathPrefixOf = (setup: AuthSetup): string =>
  setup.sessionLostCondition.pathPrefix ?? new URL(setup.loginStartUrl).pathname;
