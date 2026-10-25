// 認証の設定の判定の唯一の owner（Task 25 の設計書 4.1、5 章。T25a）。
// - `validateAuthSetup`: 入力の写しを取り（写せない値は形の誤り）、以後は写しだけを読む。fail-closed で、当たった誤りをすべて返す
//   （Task 22 の `validateSiteProfile` の返し方に合わせる）。順は次のとおり。
//   1. 上限（長さ・件数・回数）。大きな入力を、スキーマの検証や URL の解析に渡す前に止める。当たれば `AUTH_SETUP_LIMIT_EXCEEDED` だけを返す。
//   2. 形（スキーマ）。合わなければ `AUTH_SETUP_SCHEMA_INVALID` だけを返す。
//   3. 値の規則（プロファイルとの結びつき、モード、Origin の包含、URL と path の形、秘密に見える値、IdP、セレクタ、成功の条件の
//      あいまいさ、自動ログインの設定）。すべて確かめる。
// - 受けるのは版 3（`beaksight-auth-setup/3`。Task 34 の設計書 3.2）だけ。形は版 3 のスキーマ（`AUTH_SETUP_SCHEMA_NAME`）で確かめる（LG-3b: 版 1・
//   版 2 と知らない版の文書は形の誤り）。`automatedLogin`（T26b）の要否は、プロファイルの認証の方式で決める（自動ログインなら必須で、
//   回数は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ。手動のログインなら null だけ）。
// - 版 3 の決まり（T34a）: ログインの送り方（`loginTransport`）で要る項目と持てない項目、スクリプトの送信先の Origin（プロファイルの承認したサービスの
//   Origin）と path と必須の query、ログインに伴う送信の Origin（承認したテストの Origin かサービスの Origin）・path・重なり、成功のローカル ストレージの
//   鍵の Origin（承認したテストの Origin）と形。上限（件数・長さ・回数）は、ほかの項目と同じく、スキーマの前に確かめる。
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
import { exclusionMatchPathFormsOf } from '../../core/audit-exclusion-forms.js';
import { hitsDangerousTermIn, hitsExcludedPathPrefix } from '../../core/audit-exclusion-match.js';
import { isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { jsonPointerOf } from '../../core/json-pointer.js';
import { schemaIssuePointerOf } from '../../core/schema-validator.js';
import { isSecretLikeQueryName } from '../../core/secret-query-names.js';
import { isValueLikeText } from '../../core/url-path-redaction.js';
import { hasControlOrLineSeparator, hasLoneSurrogate } from '../../core/text.js';
import { hasUrlFragment } from '../../core/url-fragment.js';
import {
  canonicalHttpOriginOf,
  hasUrlCredentials,
  isHttpProtocol,
  isOriginInAllowedOrigins,
} from '../../crawl/normalize-url.js';
import { AUTOMATED_LOGIN_AUTH_STRATEGY, type AuthStrategy, type ValidatedSiteProfile } from '../contracts.js';
import { validateControlDocument } from '../control-schema-validator.js';
import { PROFILE_OPERATION_POLICY, isProfileOperationAllowed, type ProfileOperation } from '../execution-policy.js';
import { validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import {
  AUTH_SETUP_SCHEMA_NAME,
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MAX_ALLOWED_IDP_ORIGINS,
  MAX_AUTH_SETUP_PATH_LIST_ITEMS,
  MAX_AUTH_SETUP_URL_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_POST_ENDPOINTS,
  MAX_AUDIT_READ_REQUESTS,
  MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MAX_LOGIN_SIDE_REQUESTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  MAX_SERVICE_REQUESTS_PER_MINUTE,
  MAX_SERVICE_REQUESTS_PER_RUN,
  MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MIN_SERVICE_REQUESTS_PER_MINUTE,
  MIN_SERVICE_REQUESTS_PER_RUN,
  MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH,
  MAX_SCRIPT_LOGIN_REQUIRED_QUERY,
  MAX_SUCCESS_SELECTOR_LENGTH,
  MAX_SUCCESS_STORAGE_KEY_PART_LENGTH,
  MIN_LOGIN_ATTEMPTS,
  MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  SCRIPT_REQUEST_TRANSPORT,
  type AuthSetup,
  type AuditReadRequest,
  type AuthSetupV3,
  type AuthSetupValidationError,
  type AuthSetupValidationErrorCode,
  type AuthSetupValidationResult,
  type AutomatedLoginSetup,
  type LoginResultCondition,
  type LoginSideRequest,
  type ScriptLoginTarget,
  type SuccessStorageKey,
} from './auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../core/default-excluded-url-words.js';

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

/**
 * 自動ログインの方式（Task 26 の設計書 4.3。`automatedLogin` が必須で、回数は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ）。CC-108: 値は owner の
 * `AUTOMATED_LOGIN_AUTH_STRATEGY`（`contracts.ts`）から読む。
 */
const AUTOMATED_STRATEGY: AuthStrategy = AUTOMATED_LOGIN_AUTH_STRATEGY;

/** 版 3 の項目の名前（誤りの文と位置の項目の名前）。 */
const SCRIPT_LOGIN_LABEL = 'scriptLogin';
const LOGIN_SIDE_REQUESTS_LABEL = 'loginSideRequests';
const SUCCESS_STORAGE_KEY_LABEL = 'successStorageKey';
const LOGIN_TRANSPORT_LABEL = 'loginTransport';
/** T35a: 版 3 の任意の項目の名前。 */
const AUDIT_READ_REQUESTS_LABEL = 'auditReadRequests';
const SERVICE_REQUEST_LIMITS_LABEL = 'serviceRequestLimits';

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

// fragment の判定（URL の中のどこにあっても拒む。空の fragment を含む）は、`src/core/url-fragment.ts` の `hasUrlFragment`（T43b fix round 1）。

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
const SCRIPT_LOGIN_LOCATION = locationOf(SCRIPT_LOGIN_LABEL);
const REQUIRED_QUERY_LOCATION = childOf(SCRIPT_LOGIN_LOCATION, 'requiredQuery');
const LOGIN_SIDE_REQUESTS_LOCATION = locationOf(LOGIN_SIDE_REQUESTS_LABEL);
const SUCCESS_STORAGE_KEY_LOCATION = locationOf(SUCCESS_STORAGE_KEY_LABEL);
const AUDIT_READ_REQUESTS_LOCATION = locationOf(AUDIT_READ_REQUESTS_LABEL);
const SERVICE_REQUEST_LIMITS_LOCATION = locationOf(SERVICE_REQUEST_LIMITS_LABEL);

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

/** 整数の値が、下限と上限の外か（整数でない値は、形の誤りとしてスキーマに任せる）。 */
const isIntegerOutside = (value: unknown, minimum: number, maximum: number): boolean =>
  Number.isInteger(value) && ((value as number) < minimum || (value as number) > maximum);

/** 範囲の外の整数の誤り（`AUTH_SETUP_LIMIT_EXCEEDED`）。範囲の中か、整数でなければ空。 */
const rangeErrorsOf = (location: FieldLocation, value: unknown, minimum: number, maximum: number): readonly AuthSetupValidationError[] =>
  (isIntegerOutside(value, minimum, maximum)
    ? [errorOf('AUTH_SETUP_LIMIT_EXCEEDED', `${location.label} must be from ${minimum} to ${maximum}`, location.pointer)]
    : []);

/**
 * 版 3 の任意の項目の上限の誤り（T35a。Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出し（件数、Origin・path の長さ、1 回の読み込みあたりの
 * 上限）と、承認したサービスの Origin への要求の上限（1 分あたり、1 回の Run あたり）。
 */
const auditStageLimitErrorsOf = (copy: unknown): readonly AuthSetupValidationError[] => {
  const reads = arrayOf(ownFieldOf(copy, AUDIT_READ_REQUESTS_LABEL));
  const errors: AuthSetupValidationError[] = [...itemCountErrorsOf(AUDIT_READ_REQUESTS_LOCATION, reads, MAX_AUDIT_READ_REQUESTS)];
  reads.slice(0, MAX_AUDIT_READ_REQUESTS).forEach((read, index) => {
    const location = childOf(AUDIT_READ_REQUESTS_LOCATION, index);
    errors.push(
      ...lengthErrorsOf(childOf(location, 'origin'), ownFieldOf(read, 'origin'), MAX_AUTH_SETUP_URL_LENGTH),
      ...lengthErrorsOf(childOf(location, 'path'), ownFieldOf(read, 'path'), MAX_AUTH_SETUP_URL_LENGTH),
      ...rangeErrorsOf(childOf(location, 'maxPerPageLoad'), ownFieldOf(read, 'maxPerPageLoad'),
        MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD, MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD),
    );
  });
  const limits = ownFieldOf(copy, SERVICE_REQUEST_LIMITS_LABEL);
  errors.push(
    ...rangeErrorsOf(childOf(SERVICE_REQUEST_LIMITS_LOCATION, 'perMinute'), ownFieldOf(limits, 'perMinute'),
      MIN_SERVICE_REQUESTS_PER_MINUTE, MAX_SERVICE_REQUESTS_PER_MINUTE),
    ...rangeErrorsOf(childOf(SERVICE_REQUEST_LIMITS_LOCATION, 'perRun'), ownFieldOf(limits, 'perRun'),
      MIN_SERVICE_REQUESTS_PER_RUN, MAX_SERVICE_REQUESTS_PER_RUN),
  );
  return errors;
};

/**
 * 版 3 の項目の上限の誤り（T34a。Task 34 の設計書 3.2）: スクリプトの送信先の Origin・path・必須の query（件数と名前・値の長さ）、ログインに伴う送信
 * （件数、Origin・path の長さ、ログインの段 1 回あたりの上限）、成功のローカル ストレージの鍵（Origin・接頭辞・接尾辞の長さ）。項目がない文書の
 * 形の誤りは、スキーマに任せる。
 */
const version3LimitErrorsOf = (copy: unknown): readonly AuthSetupValidationError[] => {
  const scriptLogin = ownFieldOf(copy, SCRIPT_LOGIN_LABEL);
  const queries = arrayOf(ownFieldOf(scriptLogin, 'requiredQuery'));
  const errors: AuthSetupValidationError[] = [
    ...lengthErrorsOf(childOf(SCRIPT_LOGIN_LOCATION, 'origin'), ownFieldOf(scriptLogin, 'origin'), MAX_AUTH_SETUP_URL_LENGTH),
    ...lengthErrorsOf(childOf(SCRIPT_LOGIN_LOCATION, 'path'), ownFieldOf(scriptLogin, 'path'), MAX_AUTH_SETUP_URL_LENGTH),
    ...itemCountErrorsOf(REQUIRED_QUERY_LOCATION, queries, MAX_SCRIPT_LOGIN_REQUIRED_QUERY),
    ...queries.slice(0, MAX_SCRIPT_LOGIN_REQUIRED_QUERY).flatMap((query, index) => [
      ...lengthErrorsOf(childOf(childOf(REQUIRED_QUERY_LOCATION, index), 'name'), ownFieldOf(query, 'name'), MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH),
      ...lengthErrorsOf(childOf(childOf(REQUIRED_QUERY_LOCATION, index), 'value'), ownFieldOf(query, 'value'), MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH),
    ]),
  ];
  const sideRequests = arrayOf(ownFieldOf(copy, LOGIN_SIDE_REQUESTS_LABEL));
  errors.push(...itemCountErrorsOf(LOGIN_SIDE_REQUESTS_LOCATION, sideRequests, MAX_LOGIN_SIDE_REQUESTS));
  sideRequests.slice(0, MAX_LOGIN_SIDE_REQUESTS).forEach((sideRequest, index) => {
    const location = childOf(LOGIN_SIDE_REQUESTS_LOCATION, index);
    errors.push(
      ...lengthErrorsOf(childOf(location, 'origin'), ownFieldOf(sideRequest, 'origin'), MAX_AUTH_SETUP_URL_LENGTH),
      ...lengthErrorsOf(childOf(location, 'path'), ownFieldOf(sideRequest, 'path'), MAX_AUTH_SETUP_URL_LENGTH),
    );
    const limit = ownFieldOf(sideRequest, 'maxPerLoginStage');
    if (Number.isInteger(limit)
      && ((limit as number) < MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE || (limit as number) > MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE)) {
      const limitLocation = childOf(location, 'maxPerLoginStage');
      errors.push(errorOf(
        'AUTH_SETUP_LIMIT_EXCEEDED',
        `${limitLocation.label} must be from ${MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE} to ${MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE}`,
        limitLocation.pointer,
      ));
    }
  });
  errors.push(...auditStageLimitErrorsOf(copy));
  const storageKey = ownFieldOf(copy, SUCCESS_STORAGE_KEY_LABEL);
  errors.push(
    ...lengthErrorsOf(childOf(SUCCESS_STORAGE_KEY_LOCATION, 'origin'), ownFieldOf(storageKey, 'origin'), MAX_AUTH_SETUP_URL_LENGTH),
    ...lengthErrorsOf(childOf(SUCCESS_STORAGE_KEY_LOCATION, 'prefix'), ownFieldOf(storageKey, 'prefix'), MAX_SUCCESS_STORAGE_KEY_PART_LENGTH),
    ...lengthErrorsOf(childOf(SUCCESS_STORAGE_KEY_LOCATION, 'suffix'), ownFieldOf(storageKey, 'suffix'), MAX_SUCCESS_STORAGE_KEY_PART_LENGTH),
  );
  return errors;
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
  errors.push(...automatedLoginLimitErrorsOf(ownFieldOf(copy, AUTOMATED_LOGIN_LABEL)), ...version3LimitErrorsOf(copy));
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
  if (hasUrlFragment(value)) {
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
 * - 自動ログイン: `automatedLogin` が必須。`maxLoginAttempts` は `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` だけ（回数の上限の誤り）。ログインの送り方は、
 *   フォームの送信もスクリプトで送るログインも受ける（T36a。Task 36 の設計書 3.1。T34R-fix-b の M-3 の拒否を外した）。
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

// ---------------------------------------------------------------------------------------------------------------
// 版 3 の値の規則（T34a。Task 34 の設計書 3.2）
// ---------------------------------------------------------------------------------------------------------------

/** 正規の直列化の HTTP(S) の Origin か（`canonicalHttpOriginOf` の結果と完全に一致する。末尾の `/`、path、大文字などは受けない）。 */
const isCanonicalOrigin = (origin: string): boolean => canonicalHttpOriginOf(origin) === origin;

/** 版 3 の Origin の誤り（正規の Origin でない → `AUTH_SETUP_URL_INVALID`、`approved` に含まれない → `notApprovedCode`）。 */
const version3OriginErrorsOf = (
  location: FieldLocation,
  origin: string,
  approved: readonly string[],
  notApprovedCode: AuthSetupValidationErrorCode,
  approvedText: string,
): readonly AuthSetupValidationError[] => {
  if (!isCanonicalOrigin(origin)) {
    return [errorOf('AUTH_SETUP_URL_INVALID', `${location.label} must be the canonical serialization of an http(s) origin`, location.pointer)];
  }
  return isOriginInAllowedOrigins(approved, origin)
    ? []
    : [errorOf(notApprovedCode, `the origin of ${location.label} is not in ${approvedText} of the profile`, location.pointer)];
};

/** 書けない文字（制御文字・行と段落の区切り・対でないサロゲート）を含むか。 */
const hasUnwritableCharacter = (value: string): boolean => hasControlOrLineSeparator(value) || hasLoneSurrogate(value);

/** スクリプトの送信先の誤り（Origin は承認したサービスの Origin、path の形、必須の query の組）。 */
const scriptLoginErrorsOf = (scriptLogin: ScriptLoginTarget, services: readonly string[]): readonly AuthSetupValidationError[] => {
  const errors: AuthSetupValidationError[] = [
    ...version3OriginErrorsOf(
      childOf(SCRIPT_LOGIN_LOCATION, 'origin'),
      scriptLogin.origin,
      services,
      'AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED',
      'approvedServiceOrigins',
    ),
    ...pathErrorsOf(childOf(SCRIPT_LOGIN_LOCATION, 'path'), scriptLogin.path),
  ];
  const seen = new Set<string>();
  scriptLogin.requiredQuery.forEach(({ name, value }, index) => {
    const location = childOf(REQUIRED_QUERY_LOCATION, index);
    if (name.trim().length === 0 || hasUnwritableCharacter(name) || hasUnwritableCharacter(value) || seen.has(name)) {
      errors.push(errorOf(
        'AUTH_SETUP_REQUIRED_QUERY_INVALID',
        `${location.label} must have a non-blank name that is not used before, and no control characters, line breaks or lone surrogates`,
        location.pointer,
      ));
    } else if (isSecretLikeQueryName(name)) {
      errors.push(errorOf('AUTH_SETUP_SECRET_LIKE_VALUE', `${location.label} must not have a name that looks like a secret`, location.pointer));
    } else if (isValueLikeText(value)) {
      // T34R-fix-b（M-6）: 値に見える値（長い base64url・16 進・標準の base64・JWT の形・メールアドレスの形。`src/core/url-path-redaction.ts`）は持てない。
      errors.push(errorOf('AUTH_SETUP_SECRET_LIKE_VALUE', `${location.label} must not have a value that looks like a secret or personal data`,
        location.pointer));
    }
    seen.add(name);
  });
  return errors;
};

/** 送信先の鍵（Origin と path。重なりの判定）。 */
const endpointKeyOf = (origin: string, path: string): string => JSON.stringify([origin, path]);

/** ログインに伴う送信の誤り（Origin は承認したテストの Origin かサービスの Origin、path の形、送信先の重なり）。 */
const loginSideRequestErrorsOf = (
  sideRequests: readonly LoginSideRequest[],
  approvedOrigins: readonly string[],
  scriptLogin: ScriptLoginTarget | null,
): readonly AuthSetupValidationError[] => {
  const seen = new Set<string>(scriptLogin === null ? [] : [endpointKeyOf(scriptLogin.origin, scriptLogin.path)]);
  return sideRequests.flatMap((sideRequest, index) => {
    const location = childOf(LOGIN_SIDE_REQUESTS_LOCATION, index);
    const key = endpointKeyOf(sideRequest.origin, sideRequest.path);
    const duplicated = seen.has(key);
    seen.add(key);
    return [
      ...version3OriginErrorsOf(
        childOf(location, 'origin'),
        sideRequest.origin,
        approvedOrigins,
        'AUTH_SETUP_ORIGIN_NOT_APPROVED',
        'approvedTestOrigins or approvedServiceOrigins',
      ),
      ...pathErrorsOf(childOf(location, 'path'), sideRequest.path),
      ...(duplicated
        ? [errorOf(
          'AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED',
          `${location.label} must not have the origin and the path of another login side request or of ${SCRIPT_LOGIN_LABEL}`,
          location.pointer,
        )]
        : []),
    ];
  });
};

/** 成功のローカル ストレージの鍵の誤り（Origin は承認したテストの Origin、接頭辞と接尾辞の形）。 */
const successStorageKeyErrorsOf = (storageKey: SuccessStorageKey, approved: readonly string[]): readonly AuthSetupValidationError[] => {
  const errors: AuthSetupValidationError[] = [
    ...version3OriginErrorsOf(
      childOf(SUCCESS_STORAGE_KEY_LOCATION, 'origin'),
      storageKey.origin,
      approved,
      'AUTH_SETUP_ORIGIN_NOT_APPROVED',
      'approvedTestOrigins',
    ),
  ];
  if (storageKey.prefix.length === 0 && storageKey.suffix.length === 0) {
    errors.push(errorOf(
      'AUTH_SETUP_STORAGE_KEY_INVALID',
      `${SUCCESS_STORAGE_KEY_LOCATION.label} must have a prefix or a suffix (it must not match every key)`,
      SUCCESS_STORAGE_KEY_LOCATION.pointer,
    ));
  }
  for (const part of ['prefix', 'suffix'] as const) {
    if (hasUnwritableCharacter(storageKey[part])) {
      const location = childOf(SUCCESS_STORAGE_KEY_LOCATION, part);
      errors.push(errorOf('AUTH_SETUP_STORAGE_KEY_INVALID', `${location.label} must not contain control characters, line breaks or lone surrogates`,
        location.pointer));
    }
  }
  return errors;
};

/**
 * 登録した読み取りの手続きの呼び出しの path が、読まないパス（`excludedPaths`。前方一致）か、危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）に当たるか
 * （T35R-fix の M-1、T35R2-fix の M-4）。比べ方は Guard と同じ core の部品（`hitsExcludedPathPrefix`・`hitsDangerousTermIn`。小文字の形と、NFKC と
 * 大文字・小文字を畳んだ形で比べる）。Guard は、監査の段でも、読まないパスと危険な語に当たる呼び出しを止めるので、登録の時点で拒む。
 * CC-100: 比べる path の形は、Guard と同じ core の `exclusionMatchPathFormsOf`（`%XX` を戻した形、`/` をまとめた形、引数を外した形、`.` と `..`
 * を解決した形と、その畳み込み）。前は生の値とその畳み込みだけだったので、Guard が止める形（例: `/%6Cogout`）を登録で拒むようになった。形を作れない
 * 値は、当たるものとして拒む（fail-closed）。ML-a: 手動のログインの成功から認証の設定を組み立てる部品（`src/control/manual-login-registration.ts`）も、
 * 登録する送信先の path を同じ判定で除く（書き写さない）。
 */
export const isExcludedReadPath = (path: string, excludedPaths: readonly string[]): boolean => {
  const pathForms = exclusionMatchPathFormsOf(path);
  return pathForms === null || hitsExcludedPathPrefix(pathForms, excludedPaths) || hitsDangerousTermIn(pathForms, DEFAULT_EXCLUDED_URL_WORDS);
};

/**
 * 監査の段の読み取りの手続きの呼び出しの誤り（T35a。Task 35 の設計書 3.1）: Origin は承認したテストの Origin かサービスの Origin、path の形、Origin と
 * path の組の重なり（読み取りの手続きの呼び出しの間だけ。ログインに伴う送信・スクリプトの送信先との重なりは許す。段が違い、数え方も違うため）。
 * T35R-fix・T35R2-fix: path が読まないパスか危険な語に当たれば拒む（`isExcludedReadPath`）。
 */
const auditReadRequestErrorsOf = (
  reads: readonly AuditReadRequest[],
  approvedOrigins: readonly string[],
  excludedPaths: readonly string[],
): readonly AuthSetupValidationError[] => {
  const seen = new Set<string>();
  return reads.flatMap((read, index) => {
    const location = childOf(AUDIT_READ_REQUESTS_LOCATION, index);
    const key = endpointKeyOf(read.origin, read.path);
    const duplicated = seen.has(key);
    seen.add(key);
    return [
      ...version3OriginErrorsOf(
        childOf(location, 'origin'),
        read.origin,
        approvedOrigins,
        'AUTH_SETUP_ORIGIN_NOT_APPROVED',
        'approvedTestOrigins or approvedServiceOrigins',
      ),
      ...pathErrorsOf(childOf(location, 'path'), read.path),
      ...(isExcludedReadPath(read.path, excludedPaths)
        ? [errorOf('AUTH_SETUP_PATH_INVALID', `${location.label} must not start with one of ${EXCLUDED_PATHS_LOCATION.label} or contain a dangerous term`,
          childOf(location, 'path').pointer)]
        : []),
      ...(duplicated
        ? [errorOf('AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED', `${location.label} must not have the origin and the path of another audit read request`,
          location.pointer)]
        : []),
    ];
  });
};

/**
 * 版 3 の値の規則の誤り（T34a）。ログインの送り方で、要る項目と持てない項目を確かめ、項目があれば中身を確かめる。
 * - `SCRIPT_REQUEST`: `scriptLogin` と `successStorageKey` が要る（`AUTH_SETUP_SCRIPT_LOGIN_REQUIRED`）。`loginPostEndpoints` は空でよい。
 *   T44e（Task 44 の設計書 P2-8）: 認証の方式が手動のログインのプロファイル（`requiresScriptTargets` が偽）では、どちらもなくてよい（手動のログインの段は
 *   ページの送信を通して記録し、成功の後の自動の登録 `manualLoginRegistrationOf` が埋める）。自動ログインのプロファイルは今どおり求める。項目があるときの
 *   中身の確かめは、どちらの方式でも同じ。
 * - `FORM_NAVIGATION`: `scriptLogin`・`successStorageKey` を持てず、`loginSideRequests` は空（`AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED`。今の形の振る舞いを
 *   変えない）。`loginPostEndpoints` は 1 つ以上（`AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED`）。
 */
const version3ErrorsOf = (
  setup: AuthSetupV3,
  approved: readonly string[],
  services: readonly string[],
  requiresScriptTargets: boolean,
): readonly AuthSetupValidationError[] => {
  const errors: AuthSetupValidationError[] = [];
  if (setup.loginTransport === SCRIPT_REQUEST_TRANSPORT) {
    for (const [value, location] of [[setup.scriptLogin, SCRIPT_LOGIN_LOCATION], [setup.successStorageKey, SUCCESS_STORAGE_KEY_LOCATION]] as const) {
      if (value === null && requiresScriptTargets) {
        errors.push(errorOf(
          'AUTH_SETUP_SCRIPT_LOGIN_REQUIRED',
          `${location.label} is required for ${LOGIN_TRANSPORT_LABEL} ${SCRIPT_REQUEST_TRANSPORT}`,
          location.pointer,
        ));
      }
    }
  } else {
    const present = [
      [setup.scriptLogin !== null, SCRIPT_LOGIN_LOCATION],
      [setup.successStorageKey !== null, SUCCESS_STORAGE_KEY_LOCATION],
      [setup.loginSideRequests.length > 0, LOGIN_SIDE_REQUESTS_LOCATION],
      // T35a: 監査の段の項目（任意）は、スクリプトで送るログインのときだけ持てる（空の一覧を含め、項目そのものを持てない）。
      [setup.auditReadRequests !== undefined, AUDIT_READ_REQUESTS_LOCATION],
      [setup.serviceRequestLimits !== undefined, SERVICE_REQUEST_LIMITS_LOCATION],
    ] as const;
    for (const [isPresent, location] of present) {
      if (isPresent) {
        errors.push(errorOf(
          'AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED',
          `${location.label} must be null or empty for ${LOGIN_TRANSPORT_LABEL} ${setup.loginTransport}`,
          location.pointer,
        ));
      }
    }
    if (setup.loginPostEndpoints.length === 0) {
      errors.push(errorOf(
        'AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED',
        `${LOGIN_POST_ENDPOINTS_LOCATION.label} must have at least one endpoint for ${LOGIN_TRANSPORT_LABEL} ${setup.loginTransport}`,
        LOGIN_POST_ENDPOINTS_LOCATION.pointer,
      ));
    }
  }
  return [
    ...errors,
    ...(setup.scriptLogin === null ? [] : scriptLoginErrorsOf(setup.scriptLogin, services)),
    ...loginSideRequestErrorsOf(setup.loginSideRequests, [...approved, ...services], setup.scriptLogin),
    ...(setup.successStorageKey === null ? [] : successStorageKeyErrorsOf(setup.successStorageKey, approved)),
    ...auditReadRequestErrorsOf(setup.auditReadRequests ?? [], [...approved, ...services], setup.excludedPaths),
  ];
};

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
  // T34a: 承認したサービスの Origin（項目がなければ空）。版 3 のスクリプトの送信先とログインに伴う送信が使う。
  const services = stringsOf(ownFieldOf(profileSide.copy, 'approvedServiceOrigins'));
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
    // T44e（P2-8）: 手動のログインのプロファイルだけ、スクリプトで送るログインの送信先と成功の鍵を後から自動の登録で埋めてよい。
    ...version3ErrorsOf(setup, approved, services, ownFieldOf(profileSide.copy, 'auth') !== MANUAL_STRATEGY),
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
  // LG-3b: 版 3 のスキーマだけで確かめる（版 1・版 2 と知らない版は、形の誤り）。
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
