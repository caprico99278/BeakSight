/**
 * 認証の設定の検証の誤り（`validateAuthSetup` の `AuthSetupValidationError`）を、画面の項目ごとに分ける（Task 25 の設計書 4.5。T25e）。
 * - 画面に返すのは、閉じた一覧のコードと、項目と、1 行に 1 つの項目の行（1 から）だけ。英語の詳細（`detail`）は返さない。
 * - 項目は、検証の owner が誤りに付ける位置（`pointer`。JSON Pointer。`/loginPostEndpoints/1/origin`、`/excludedPaths/1`。CCX-23。CC-061）
 *   から決める（英語の詳細は読まない）。位置の区切りの前から、いちばん長く合う項目を採る。どの項目にも当たらない誤り（プロファイルとの
 *   結びつき、IdP、余分な項目、位置のない誤り）は、フォームの上に出す（`field` が `null`）。
 * - 同じコード・項目・行の誤りは 1 つにまとめる。
 * - T26e（Task 26 の設計書 4.3）: 自動ログインの項目（3 つのセレクタと、4 つの失敗の条件のパスとセレクタ）を足した。失敗の条件の全体を指す誤り
 *   （条件の重なり）は、その条件のパスの欄に出す。
 * - T34d（Task 34 の設計書 3.2、3.6）: 版 3 の項目（ログインの送り方、token の送信先の Origin・path・必須の query、ログインに伴う送信、成功の
 *   ローカル ストレージの鍵の Origin・接頭辞・接尾辞）を足した。項目の全体を指す誤りは、その項目の最初の欄に出す。必須の query とログインに伴う
 *   送信は、行（1 から）も出す。
 * - T35d（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しの一覧（行を出す）と、サービスの Origin への要求の上限（1 分あたり・1 回の Run
 *   あたり）の欄を足した。上限の全体を指す誤りは、1 分あたりの欄に出す。
 */
import {
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  type AuthSetupV3,
  type AuthSetupValidationError,
  type AuthSetupValidationErrorCode,
  type AutomatedLoginSetup,
  type AutomatedLoginFailureConditionKind,
} from '../../../../src/control/auth/auth-setup-contracts.js';
import { jsonPointerSegmentsOf } from '../../../../src/core/json-pointer.js';

/** 自動ログインの失敗の条件のパスの欄（T26e）。 */
export type FailureConditionPathField = `${AutomatedLoginFailureConditionKind}PathPrefix`;
/** 自動ログインの失敗の条件のセレクタの欄（T26e）。 */
export type FailureConditionSelectorField = `${AutomatedLoginFailureConditionKind}Selector`;

/** 失敗の条件のパスの欄の名前。 */
export const failureConditionPathFieldOf = (kind: AutomatedLoginFailureConditionKind): FailureConditionPathField => `${kind}PathPrefix`;
/** 失敗の条件のセレクタの欄の名前。 */
export const failureConditionSelectorFieldOf = (kind: AutomatedLoginFailureConditionKind): FailureConditionSelectorField => `${kind}Selector`;

/** 自動ログインの設定の、文書の項目の名前（位置の区切り）。 */
const AUTOMATED_LOGIN_DOCUMENT_NAME = 'automatedLogin' satisfies keyof AuthSetupV3;
const FAILURE_CONDITIONS_DOCUMENT_NAME = 'failureConditions' satisfies keyof AutomatedLoginSetup;

/** 認証の設定のフォームの項目（画面の入力の欄）のうち、自動ログインの失敗の条件でないもの。 */
const BASE_AUTH_SETUP_FORM_FIELDS = Object.freeze([
  'loginStartUrl',
  'loginPostEndpoints',
  'successPathPrefix',
  'successSelector',
  'sessionLostPathPrefix',
  'excludedPaths',
  'auditPathPrefixes',
  'maxLoginAttempts',
  // T26e: 自動ログインの 3 つのセレクタ（認証の方式が自動ログインのプロファイルだけ）。
  'usernameSelector',
  'passwordSelector',
  'submitSelector',
  // T34d（Task 34 の設計書 3.2、3.6）: 版 3 のスクリプトで送るログインの欄（ログインの送り方、token の送信先、必須の query、ログインに伴う送信、
  // 成功のローカル ストレージの鍵）。
  'loginTransport',
  'scriptOrigin',
  'scriptPath',
  'requiredQuery',
  'loginSideRequests',
  'storageOrigin',
  'storagePrefix',
  'storageSuffix',
  // T35d（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しの一覧と、サービスの Origin への要求の上限（1 分あたり、1 回の Run あたり）。
  'auditReadRequests',
  'servicePerMinute',
  'servicePerRun',
] as const);

/** 認証の設定のフォームの項目（T26e: 自動ログインの失敗の条件のパスとセレクタの欄を含む）。 */
export type AuthSetupFormField = (typeof BASE_AUTH_SETUP_FORM_FIELDS)[number] | FailureConditionPathField | FailureConditionSelectorField;

/** 認証の設定のフォームの項目（画面の入力の欄）。 */
export const AUTH_SETUP_FORM_FIELDS: readonly AuthSetupFormField[] = Object.freeze([
  ...BASE_AUTH_SETUP_FORM_FIELDS,
  ...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind) => [failureConditionPathFieldOf(kind), failureConditionSelectorFieldOf(kind)]),
]);

/** 画面に返す、検証の誤り 1 件。 */
export interface AuthSetupErrorView {
  readonly code: AuthSetupValidationErrorCode;
  /** 誤りのある項目（項目に結び付かない誤りは `null`）。 */
  readonly field: AuthSetupFormField | null;
  /** 1 行に 1 つの項目の、誤りのある行（1 から）。ほかは `null`。 */
  readonly line: number | null;
}

/** 位置の区切りの並び（文書の項目の名前）と、フォームの項目。 */
type FieldLocation = readonly [keyof AuthSetupV3, ...string[]];

/** 文書の項目の位置と、フォームの項目。 */
const DOCUMENT_FIELD_LOCATIONS: readonly (readonly [FieldLocation, AuthSetupFormField])[] = Object.freeze([
  [['loginStartUrl'], 'loginStartUrl'],
  [['loginPostEndpoints'], 'loginPostEndpoints'],
  [['successCondition', 'pathPrefix'], 'successPathPrefix'],
  [['successCondition', 'selector'], 'successSelector'],
  [['sessionLostCondition', 'pathPrefix'], 'sessionLostPathPrefix'],
  [['excludedPaths'], 'excludedPaths'],
  [['auditPathPrefixes'], 'auditPathPrefixes'],
  [['maxLoginAttempts'], 'maxLoginAttempts'],
  // T34d: 版 3 の項目。項目の全体を指す誤り（要る・持てない・鍵の形）は、その項目の最初の欄に出す。
  [['loginTransport'], 'loginTransport'],
  [['scriptLogin'], 'scriptOrigin'],
  [['scriptLogin', 'origin'], 'scriptOrigin'],
  [['scriptLogin', 'path'], 'scriptPath'],
  [['scriptLogin', 'requiredQuery'], 'requiredQuery'],
  [['loginSideRequests'], 'loginSideRequests'],
  [['successStorageKey'], 'storageOrigin'],
  [['successStorageKey', 'origin'], 'storageOrigin'],
  [['successStorageKey', 'prefix'], 'storagePrefix'],
  [['successStorageKey', 'suffix'], 'storageSuffix'],
  // T35d: 監査の段の項目。要求の上限の全体を指す誤りは、1 分あたりの欄に出す。
  [['auditReadRequests'], 'auditReadRequests'],
  [['serviceRequestLimits'], 'servicePerMinute'],
  [['serviceRequestLimits', 'perMinute'], 'servicePerMinute'],
  [['serviceRequestLimits', 'perRun'], 'servicePerRun'],
  [[AUTOMATED_LOGIN_DOCUMENT_NAME, 'usernameSelector'], 'usernameSelector'],
  [[AUTOMATED_LOGIN_DOCUMENT_NAME, 'passwordSelector'], 'passwordSelector'],
  [[AUTOMATED_LOGIN_DOCUMENT_NAME, 'submitSelector'], 'submitSelector'],
  ...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind): readonly (readonly [FieldLocation, AuthSetupFormField])[] => [
    // 条件の全体を指す誤り（重なり）は、パスの欄に出す。パスとセレクタの位置は、長く合う方が勝つ。
    [[AUTOMATED_LOGIN_DOCUMENT_NAME, FAILURE_CONDITIONS_DOCUMENT_NAME, kind], failureConditionPathFieldOf(kind)],
    [[AUTOMATED_LOGIN_DOCUMENT_NAME, FAILURE_CONDITIONS_DOCUMENT_NAME, kind, 'pathPrefix'], failureConditionPathFieldOf(kind)],
    [[AUTOMATED_LOGIN_DOCUMENT_NAME, FAILURE_CONDITIONS_DOCUMENT_NAME, kind, 'selector'], failureConditionSelectorFieldOf(kind)],
  ]),
]);

/** 1 行に 1 つの項目（行を出す）。 */
const LIST_FIELDS: ReadonlySet<AuthSetupFormField> = new Set([
  'loginPostEndpoints', 'excludedPaths', 'auditPathPrefixes',
  // T34d: 版 3 の、行を足して入れる一覧（必須の query、ログインに伴う送信）。
  'requiredQuery', 'loginSideRequests',
  // T35d: 監査の段の読み取りの手続きの呼び出し。
  'auditReadRequests',
]);
/** 配列の位置の区切り（0 から）。 */
const ARRAY_INDEX = /^\d+$/u;

/** 位置の区切りの並びが、項目の位置で始まるか。 */
const startsWithLocation = (segments: readonly string[], location: FieldLocation): boolean =>
  location.length <= segments.length && location.every((segment, index) => segments[index] === segment);

/** 誤りの位置に、いちばん長く合う項目と、その直後の配列の位置（1 行に 1 つの項目だけ）。位置がなければ、項目なし。 */
const fieldOf = (pointer: string | null): { readonly field: AuthSetupFormField | null; readonly line: number | null } => {
  // 位置の区切りの並び（RFC 6901 の書き方を戻した形。`src/core/json-pointer.ts`。CCX-25）。
  const segments = pointer === null ? [] : jsonPointerSegmentsOf(pointer);
  let best: { readonly location: FieldLocation; readonly field: AuthSetupFormField } | null = null;
  for (const [location, field] of DOCUMENT_FIELD_LOCATIONS) {
    if (startsWithLocation(segments, location) && (best === null || location.length > best.location.length)) {
      best = { location, field };
    }
  }
  if (best === null) {
    return { field: null, line: null };
  }
  const indexText = segments[best.location.length];
  return {
    field: best.field,
    line: LIST_FIELDS.has(best.field) && indexText !== undefined && ARRAY_INDEX.test(indexText) ? Number(indexText) + 1 : null,
  };
};

/** 検証の誤りを、画面に返す値にする（同じものは 1 つにまとめる。凍結した写し）。 */
export const authSetupErrorViewsOf = (errors: readonly AuthSetupValidationError[]): readonly AuthSetupErrorView[] => {
  const seen = new Set<string>();
  const views: AuthSetupErrorView[] = [];
  for (const error of errors) {
    const { field, line } = fieldOf(error.pointer);
    const key = JSON.stringify([error.code, field, line]);
    if (!seen.has(key)) {
      seen.add(key);
      views.push(Object.freeze({ code: error.code, field, line }));
    }
  }
  return Object.freeze(views);
};
