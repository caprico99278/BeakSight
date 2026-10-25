/**
 * 認証の設定のフォーム（Task 25 の設計書 4.1、4.5、4.6。T25e）。
 * - 項目は設計書 4.1 の表のとおり（ログインの画面の URL、送信先、成功の条件、セッションの切れの条件、読まないパス、読む範囲、回数の上限）。
 *   別の Origin の IdP（`allowedIdpOrigins`）は Stage 1 では空だけなので、欄を置かずに空で送る。
 * - 秘密（パスワード、Cookie の値）を入れる欄は作らない。秘密を書かないことを、フォームの上で案内する。
 * - 画面の側では値の形を確かめない（補助の確かめも置かない）。保存の前に、サーバが `saveAuthSetup`（`validateAuthSetup`）で検証し、誤りの
 *   コードと項目と行を返す。誤りは、項目ごとに日本語で出す（`AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS`）。
 * - 1 行に 1 つの項目は、空の行を除いて送る。送信先は、1 行の URL を Origin と path に分けて送る（分けられない行は、そのまま Origin に入れて
 *   サーバの検証に任せる）。任意の項目は、空なら `null` で送る。
 * - T26e（Task 26 の設計書 4.3）: 認証の方式が自動ログインのプロファイル（`automated`）では、自動ログインの項目（3 つのセレクタと、4 つの失敗の
 *   条件のパスとセレクタ）の欄を出し、`automatedLogin` を組み立てる。失敗の条件は、パスとセレクタの両方が空なら「使わない」（`null`）。
 *   ログインの送信の回数は、自動ログインでは `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` に固定して表示する（編集させない）。手動のログインでは今のまま
 *   （`automatedLogin: null`）。ユーザー名とパスワードの値の欄は、このフォームにない（資格情報の画面）。
 * - T36a（Task 36 の設計書 3.5）: 自動ログインのプロファイルでも「ログインの送り方」を選べる（T34d では、自動ログインはフォームの送信に固定していた）。
 *   スクリプトで送るログインを選ぶと、自動ログインの設定と、スクリプトで送るログインの項目の両方を持つ版 3 の設定を作る。
 * - T34d（Task 34 の設計書 3.2、3.6）: 新しく保存する設定は版 3。手動のログインのプロファイルでは、ログインの送り方（フォームの送信・スクリプトの
 *   送信）を選ぶ。スクリプトの送信のときは、フォームの送信先の欄を出さずに、token の送信先（承認したサービスの Origin から選ぶ Origin、path、必須の
 *   query の組）、ログインに伴う送信の一覧（Origin、path、1 回のログインの回数。method は POST だけ）、成功のローカル ストレージの鍵の形（Origin、
 *   接頭辞、接尾辞）の欄を出す。フォームの送信のときは、今の欄のまま。
 *   LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 保存する設定は、いつも版 3（版 2 の設定を版 2 のまま保存する道と、その知らせは捨てた。認証の
 *   設定は版 3 だけを受ける）。
 * - T35d（Task 35 の設計書 3.1、3.4）: スクリプトの送信のときだけ、監査の段の読み取りの手続きの呼び出しの一覧（Origin、パス、1 回の読み込みの回数。
 *   method は POST だけ。上限 8）と、サービスの Origin への要求の上限（1 分あたり、1 回の Run あたり。空なら上限の値）の欄を出す。どちらも、値がある
 *   ときだけ項目として送る（項目のない設定の文書と digest を変えない）。フォームの送信では出さず、送らない。
 */
import { useState, type ReactNode } from 'react';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUDIT_READ_REQUEST_METHODS,
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  MAX_AUDIT_READ_REQUESTS,
  MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MAX_SERVICE_REQUESTS_PER_MINUTE,
  MAX_SERVICE_REQUESTS_PER_RUN,
  MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MIN_SERVICE_REQUESTS_PER_MINUTE,
  MIN_SERVICE_REQUESTS_PER_RUN,
  SERVICE_REQUESTS_PER_PAGE_ALLOWANCE,
  type AuditReadRequest,
  type ServiceRequestLimits,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  FORM_NAVIGATION_TRANSPORT,
  LOGIN_SIDE_REQUEST_METHODS,
  LOGIN_TRANSPORTS,
  MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_SIDE_REQUESTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  MAX_SCRIPT_LOGIN_REQUIRED_QUERY,
  MIN_LOGIN_ATTEMPTS,
  MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  SCRIPT_REQUEST_TRANSPORT,
  loginTransportOf,
  type AuthSetup,
  type AutomatedLoginFailureConditionKind,
  type LoginPostEndpoint,
  type LoginResultCondition,
  type LoginTransport,
} from '../../../../src/control/auth/auth-setup-contracts.js';
import { formatCount, formatInteger, formatTimes } from '../../../../src/presentation/format.js';
import {
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_SPA_AUDIT_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../src/presentation/messages.js';
import { loginTransportDisplay } from '../display/labels';
import { linesOf, textOfLines } from '../display/form-lines';
import { authSetupDraftOf } from '../display/start-url-draft';
import {
  entryCheckDraftOf,
  entryProposalSelectorsOf,
  keepsStartUrlSuccessPath,
  observedDraftFieldsOf,
  type EntryCheckDraft,
} from '../display/entry-check-draft';
import type { EntryCheckProposal } from '../../../../src/control/entry-check.js';
import type { ObservedAuthSetupDraft } from '../../../../src/control/login-observation-draft.js';
import {
  failureConditionPathFieldOf,
  failureConditionSelectorFieldOf,
  type AuthSetupErrorView,
  type AuthSetupFormField,
} from '../server/auth-setup-errors';
import type { AuthSetupSaveView } from '../server/auth-setup-functions';
import { scriptLoginNoticesOf } from '../display/script-login-notices';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

/** 自動ログインの失敗の条件 1 つの欄の値（T26e）。 */
export interface FailureConditionFormValues {
  readonly pathPrefix: string;
  readonly selector: string;
}

/** フォームの値（画面の入力のまま）。 */
export interface AuthSetupFormValues {
  readonly loginStartUrl: string;
  /** 1 行に 1 つ（送信先の URL）。 */
  readonly loginPostEndpoints: string;
  readonly successPathPrefix: string;
  readonly successSelector: string;
  readonly sessionLostPathPrefix: string;
  /** 1 行に 1 つ。 */
  readonly excludedPaths: string;
  /** 1 行に 1 つ。 */
  readonly auditPathPrefixes: string;
  readonly maxLoginAttempts: number;
  /** 自動ログインの 3 つのセレクタ（T26e。自動ログインのプロファイルだけ送る）。 */
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
  /** 自動ログインの失敗の条件（T26e）。 */
  readonly failureConditions: Readonly<Record<AutomatedLoginFailureConditionKind, FailureConditionFormValues>>;
  /** T34d: ログインの送り方。 */
  readonly loginTransport: LoginTransport;
  /** T34d: token の送信先（スクリプトの送信のときだけ送る）。 */
  readonly scriptOrigin: string;
  readonly scriptPath: string;
  readonly requiredQuery: readonly QueryFormValues[];
  /** T34d: ログインに伴う送信の一覧（スクリプトの送信のときだけ送る）。 */
  readonly sideRequests: readonly SideRequestFormValues[];
  /** T34d: 成功のローカル ストレージの鍵の形（スクリプトの送信のときだけ送る）。 */
  readonly storageOrigin: string;
  readonly storagePrefix: string;
  readonly storageSuffix: string;
  /** T35d: 監査の段の読み取りの手続きの呼び出しの一覧（スクリプトの送信のときだけ送る。空なら項目を送らない）。 */
  readonly auditReads: readonly AuditReadFormValues[];
  /** T35d: サービスの Origin への要求の上限（数の文字のまま。空なら上限の値。両方が空なら項目を送らない）。 */
  readonly servicePerMinute: string;
  readonly servicePerRun: string;
}

/** T35d: 監査の段の読み取りの手続きの呼び出し 1 つの欄の値（method は POST だけなので持たない）。 */
export interface AuditReadFormValues {
  readonly origin: string;
  readonly path: string;
  readonly maxPerPageLoad: number;
}

/** T34d: 必須の query の組 1 つの欄の値。 */
export interface QueryFormValues {
  readonly name: string;
  readonly value: string;
}

/** T34d: ログインに伴う送信 1 つの欄の値（method は POST だけなので持たない）。 */
export interface SideRequestFormValues {
  readonly origin: string;
  readonly path: string;
  readonly maxPerLoginStage: number;
}

/** 文字列の欄の名前（`textInput` が扱う）。 */
type TextValueKey = Exclude<
  keyof AuthSetupFormValues,
  'maxLoginAttempts' | 'failureConditions' | 'loginTransport' | 'requiredQuery' | 'sideRequests' | 'auditReads'
>;

/** ログインに伴う送信の、1 回のログインの回数の選択肢（下限から上限まで）。 */
const SIDE_REQUEST_COUNT_OPTIONS: readonly number[] = Array.from(
  { length: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE - MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE + 1 },
  (_unused, index) => MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE + index,
);

/** ログインに伴う送信の method（`POST` だけ）。 */
const [SIDE_REQUEST_METHOD] = LOGIN_SIDE_REQUEST_METHODS;

/** 新しい行の、必須の query の組とログインに伴う送信の初めの値。 */
const EMPTY_QUERY: QueryFormValues = Object.freeze({ name: '', value: '' });
const EMPTY_SIDE_REQUEST: SideRequestFormValues = Object.freeze({ origin: '', path: '', maxPerLoginStage: MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE });

/** T35d: 監査の段の読み取りの手続きの呼び出しの、1 回の読み込みの回数の選択肢と、新しい行の初めの値と、method（`POST` だけ）。 */
const AUDIT_READ_COUNT_OPTIONS: readonly number[] = Array.from(
  { length: MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD - MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD + 1 },
  (_unused, index) => MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD + index,
);
const EMPTY_AUDIT_READ: AuditReadFormValues = Object.freeze({ origin: '', path: '', maxPerPageLoad: MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD });
const [AUDIT_READ_METHOD] = AUDIT_READ_REQUEST_METHODS;

/** 回数の上限の選択肢（下限から上限まで）。 */
const LOGIN_ATTEMPT_OPTIONS: readonly number[] = Array.from(
  { length: MAX_LOGIN_ATTEMPTS - MIN_LOGIN_ATTEMPTS + 1 },
  (_unused, index) => MIN_LOGIN_ATTEMPTS + index,
);

// 1 行に 1 つの欄の読み方と書き方は、`display/form-lines.ts` の `linesOf`・`textOfLines`（T43b fix round 1）。

const nullIfEmpty = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** 送信先の 1 行（URL）を、Origin と path にする。URL として読めない行は、そのまま Origin に入れる（サーバの検証が誤りにする）。 */
const endpointOf = (line: string): LoginPostEndpoint => {
  try {
    const url = new URL(line);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: line, path: '' };
  }
};

/** 失敗の条件の欄の値（保存してある条件がなければ空）。 */
const failureConditionValuesOf = (condition: LoginResultCondition | null | undefined): FailureConditionFormValues => ({
  pathPrefix: condition?.pathPrefix ?? '',
  selector: condition?.selector ?? '',
});

/** 失敗の条件の欄の値を、条件にする（パスとセレクタの両方が空なら、使わない（`null`））。 */
const failureConditionOf = (values: FailureConditionFormValues): LoginResultCondition | null => {
  const selector = nullIfEmpty(values.selector);
  const pathPrefix = values.pathPrefix.trim();
  return pathPrefix.length === 0 && selector === null ? null : { pathPrefix, selector };
};

/**
 * 保存してある設定（なければ空）を、フォームの値にする。自動ログインのプロファイル（`automated`）では、回数は固定の値。
 * T43b（Task 43 の設計書 4.2）: 保存した設定がない（新しい認証の設定）ときだけ、対象の設定の開始の URL の path（`startUrlPath`）で、成功の画面の
 * path と監査の path の案を埋める（`authSetupDraftOf`）。保存した設定があれば、その値を出す。除外の path は今の既定（空）のまま。
 * T43c（Task 43 の設計書 4.3）: 保存した設定がないときだけ、最後の成功した入口の確かめの案（`entryProposal`）も埋める（`entryCheckDraftOf`。開始の
 * URL の path の案より優先する。ログインの画面の path に当たる成功の画面の path の案は残さない）。案のない欄は埋めない。保存は利用者が押す。
 * T43d（Task 43 の設計書 4.4）: ジョブの詳細からの観察した要求の下書き（`observedDraft`）を、優先の順の最後に重ねる（保存した設定があっても入れる。
 * 優先の順は `display/entry-check-draft.ts` の 1 か所）。
 */
export const authSetupFormValuesOf = (
  setup: AuthSetup | null,
  automated = false,
  startUrlPath: string | null = null,
  entryProposal: EntryCheckProposal | null = null,
  observedDraft: ObservedAuthSetupDraft | null = null,
): AuthSetupFormValues => {
  const base = savedAndEntryValuesOf(setup, automated, startUrlPath, entryProposal);
  // T43d: 観察した要求の下書きを、優先の順の最後に重ねる（順は `display/entry-check-draft.ts` の 1 か所）。
  return observedDraft === null
    ? base
    : { ...base, ...observedDraftFieldsOf(observedDraft, base.sideRequests, entryProposalSelectorsOf(entryProposal)) };
};

/** 優先の順の 1 と 2（保存した設定の値と、保存した設定がないときの開始の URL の path と入口の確かめの案）。 */
const savedAndEntryValuesOf = (
  setup: AuthSetup | null,
  automated: boolean,
  startUrlPath: string | null,
  entryProposal: EntryCheckProposal | null,
): AuthSetupFormValues => {
  const draft = authSetupDraftOf(setup === null ? startUrlPath : null);
  const entry: EntryCheckDraft = setup === null && entryProposal !== null ? entryCheckDraftOf(entryProposal) : {};
  const rest = restValuesOf(setup, automated);
  return {
    loginStartUrl: setup?.loginStartUrl ?? entry.loginStartUrl ?? '',
    loginPostEndpoints: setup === null
      ? entry.loginPostEndpoints ?? ''
      : textOfLines(setup.loginPostEndpoints.map((endpoint) => `${endpoint.origin}${endpoint.path}`)),
    successPathPrefix: setup?.successCondition.pathPrefix
      ?? (keepsStartUrlSuccessPath(draft.successPathPrefix, entry) ? draft.successPathPrefix : ''),
    successSelector: setup?.successCondition.selector ?? '',
    sessionLostPathPrefix: setup?.sessionLostCondition.pathPrefix ?? entry.sessionLostPathPrefix ?? '',
    excludedPaths: textOfLines(setup?.excludedPaths ?? []),
    auditPathPrefixes: textOfLines(setup?.auditPathPrefixes ?? draft.auditPathPrefixes),
    ...rest,
    loginTransport: entry.loginTransport ?? rest.loginTransport,
    usernameSelector: entry.usernameSelector ?? rest.usernameSelector,
    passwordSelector: entry.passwordSelector ?? rest.passwordSelector,
    submitSelector: entry.submitSelector ?? rest.submitSelector,
  };
};

/** 保存してある設定の、残りの欄の値（自動ログインと、版 3 の項目）。 */
const restValuesOf = (
  setup: AuthSetup | null,
  automated: boolean,
): Omit<AuthSetupFormValues, 'loginStartUrl' | 'loginPostEndpoints' | 'successPathPrefix' | 'successSelector' | 'sessionLostPathPrefix'
  | 'excludedPaths' | 'auditPathPrefixes'> => ({
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : (setup?.maxLoginAttempts ?? MIN_LOGIN_ATTEMPTS),
  usernameSelector: setup?.automatedLogin?.usernameSelector ?? '',
  passwordSelector: setup?.automatedLogin?.passwordSelector ?? '',
  submitSelector: setup?.automatedLogin?.submitSelector ?? '',
  failureConditions: Object.fromEntries(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.map((kind) =>
    [kind, failureConditionValuesOf(setup?.automatedLogin?.failureConditions[kind])])) as Record<AutomatedLoginFailureConditionKind, FailureConditionFormValues>,
  ...scriptLoginValuesOf(setup),
});

/** T34d: 版 3 の項目の欄の値（新しい設定は、フォームの送信と空の欄）。 */
function scriptLoginValuesOf(
  setup: AuthSetup | null,
): Pick<AuthSetupFormValues, 'loginTransport' | 'scriptOrigin' | 'scriptPath' | 'requiredQuery' | 'sideRequests'
  | 'storageOrigin' | 'storagePrefix' | 'storageSuffix' | 'auditReads' | 'servicePerMinute' | 'servicePerRun'> {
  const version3 = setup;
  const limits = version3?.serviceRequestLimits;
  return {
    // T36a: 自動ログインのプロファイルでも、保存してある送り方のまま（新しい設定はフォームの送信）。
    loginTransport: setup === null ? FORM_NAVIGATION_TRANSPORT : loginTransportOf(setup),
    scriptOrigin: version3?.scriptLogin?.origin ?? '',
    scriptPath: version3?.scriptLogin?.path ?? '',
    requiredQuery: (version3?.scriptLogin?.requiredQuery ?? []).map(({ name, value }) => ({ name, value })),
    sideRequests: (version3?.loginSideRequests ?? []).map(({ origin, path, maxPerLoginStage }) => ({ origin, path, maxPerLoginStage })),
    storageOrigin: version3?.successStorageKey?.origin ?? '',
    storagePrefix: version3?.successStorageKey?.prefix ?? '',
    storageSuffix: version3?.successStorageKey?.suffix ?? '',
    // T35d: 監査の段の項目（項目のない設定は、空の一覧と空の上限）。
    auditReads: (version3?.auditReadRequests ?? []).map(({ origin, path, maxPerPageLoad }) => ({ origin, path, maxPerPageLoad })),
    servicePerMinute: limits === undefined ? '' : String(limits.perMinute),
    servicePerRun: limits === undefined ? '' : String(limits.perRun),
  };
}

/** T35d: 監査の段の読み取りの手続きの呼び出しの欄のうち、Origin もパスもない行を除いた呼び出し。 */
const auditReadsOf = (rows: readonly AuditReadFormValues[]): readonly AuditReadRequest[] =>
  rows.filter(({ origin, path }) => origin.length > 0 || path.trim().length > 0)
    .map(({ origin, path, maxPerPageLoad }) => ({ origin, path: path.trim(), method: AUDIT_READ_METHOD, maxPerPageLoad }));

/** T35d: 上限の欄の値（空なら上限の値。数でない文字は、そのまま数にしてサーバの検証に任せる）。 */
const limitOf = (text: string, maximum: number): number => (text.trim().length === 0 ? maximum : Number(text.trim()));

/** T35d: サービスの Origin への要求の上限（両方の欄が空なら null。項目を送らない）。 */
const serviceRequestLimitsOf = (perMinute: string, perRun: string): ServiceRequestLimits | null =>
  (perMinute.trim().length === 0 && perRun.trim().length === 0
    ? null
    : { perMinute: limitOf(perMinute, MAX_SERVICE_REQUESTS_PER_MINUTE), perRun: limitOf(perRun, MAX_SERVICE_REQUESTS_PER_RUN) });

/** 必須の query の組の欄のうち、名前も値もない行を除いた組。 */
const queriesOf = (rows: readonly QueryFormValues[]) =>
  rows.filter(({ name, value }) => name.trim().length > 0 || value.length > 0).map(({ name, value }) => ({ name: name.trim(), value }));

/** ログインに伴う送信の欄のうち、Origin もパスもない行を除いた送信。 */
const sideRequestsOf = (rows: readonly SideRequestFormValues[]) =>
  rows.filter(({ origin, path }) => origin.length > 0 || path.trim().length > 0)
    .map(({ origin, path, maxPerLoginStage }) => ({ origin, path: path.trim(), method: SIDE_REQUEST_METHOD, maxPerLoginStage }));

/**
 * フォームの値から、保存する認証の設定の文書を作る（プロファイルの今の改訂に結びつける）。
 * 自動ログインのプロファイル（`automated`）では、自動ログインの設定を組み立て、回数は固定の値にする（T26e）。手動のログインでは
 * `automatedLogin` は null。T34d・LG-3b: いつも版 3 で作る。スクリプトの送信では、フォームの送信先を空にし、token の送信先・成功の鍵（欄が
 * すべて空なら null。サーバが「要る」と誤りにする）、ログインに伴う送信を送る。フォームの送信では、版 3 の項目は空にする。
 */
export const authSetupDocumentOf = (values: AuthSetupFormValues, profileId: string, profileRevision: number, automated = false): AuthSetup => {
  const form = formNavigationDocumentOf(values, profileId, profileRevision, automated);
  // T36a: 自動ログインのプロファイルでも、選んだ送り方で作る。
  const transport = values.loginTransport;
  if (transport === FORM_NAVIGATION_TRANSPORT) {
    return form;
  }
  const requiredQuery = queriesOf(values.requiredQuery);
  const scriptPath = values.scriptPath.trim();
  const auditReadRequests = auditReadsOf(values.auditReads);
  const serviceRequestLimits = serviceRequestLimitsOf(values.servicePerMinute, values.servicePerRun);
  return {
    ...form,
    loginPostEndpoints: [],
    loginTransport: transport,
    scriptLogin: values.scriptOrigin.length === 0 && scriptPath.length === 0 && requiredQuery.length === 0
      ? null
      : { origin: values.scriptOrigin, path: scriptPath, requiredQuery },
    loginSideRequests: sideRequestsOf(values.sideRequests),
    successStorageKey: values.storageOrigin.length === 0 && values.storagePrefix.length === 0 && values.storageSuffix.length === 0
      ? null
      : { origin: values.storageOrigin, prefix: values.storagePrefix, suffix: values.storageSuffix },
    // T35d: 監査の段の項目は、あるときだけ送る（項目のない設定の文書と digest を変えない）。
    ...(auditReadRequests.length === 0 ? {} : { auditReadRequests }),
    ...(serviceRequestLimits === null ? {} : { serviceRequestLimits }),
  };
};

/** フォームの送信の版 3 の文書（版 3 の項目は、送り方が `FORM_NAVIGATION` で、ほかは空）。 */
const formNavigationDocumentOf = (values: AuthSetupFormValues, profileId: string, profileRevision: number, automated: boolean): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId,
  profileRevision,
  loginStartUrl: values.loginStartUrl.trim(),
  loginPostEndpoints: linesOf(values.loginPostEndpoints).map(endpointOf),
  successCondition: { pathPrefix: values.successPathPrefix.trim(), selector: nullIfEmpty(values.successSelector) },
  sessionLostCondition: { pathPrefix: nullIfEmpty(values.sessionLostPathPrefix) },
  excludedPaths: linesOf(values.excludedPaths),
  auditPathPrefixes: linesOf(values.auditPathPrefixes),
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : values.maxLoginAttempts,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: values.usernameSelector.trim(),
      passwordSelector: values.passwordSelector.trim(),
      submitSelector: values.submitSelector.trim(),
      failureConditions: {
        invalidCredentials: failureConditionOf(values.failureConditions.invalidCredentials),
        accountLocked: failureConditionOf(values.failureConditions.accountLocked),
        mfaRequired: failureConditionOf(values.failureConditions.mfaRequired),
        credentialExpired: failureConditionOf(values.failureConditions.credentialExpired),
      },
    }
    : null,
  loginTransport: FORM_NAVIGATION_TRANSPORT,
  scriptLogin: null,
  loginSideRequests: [],
  successStorageKey: null,
});

/** 誤りの 1 件の文（説明と、あれば行）。 */
const errorTextOf = (error: AuthSetupErrorView): string => {
  const description = AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS[error.code];
  return error.line === null ? description : `${LOCAL_UI_AUTH_TEXT.setup.lineText(formatInteger(error.line))}: ${description}`;
};

/** 失敗の条件の欄のラベル（パスとセレクタ）。 */
const failureConditionLabels = (): Readonly<Record<string, string>> => Object.fromEntries(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind) => {
  const name = LOCAL_UI_AUTH_TEXT.setup.failureConditionNames[kind];
  return [
    [failureConditionPathFieldOf(kind), LOCAL_UI_AUTH_TEXT.setup.failurePathPrefixLabel(name)],
    [failureConditionSelectorFieldOf(kind), LOCAL_UI_AUTH_TEXT.setup.failureSelectorLabel(name)],
  ];
}));

/** フォームの項目のラベル（フォームの外で誤りを示すときにも使う）。 */
const FIELD_LABELS = Object.freeze({
  loginStartUrl: LOCAL_UI_AUTH_TEXT.setup.loginStartUrl,
  loginPostEndpoints: LOCAL_UI_AUTH_TEXT.setup.loginPostEndpoints,
  successPathPrefix: LOCAL_UI_AUTH_TEXT.setup.successPathPrefix,
  successSelector: LOCAL_UI_AUTH_TEXT.setup.successSelector,
  sessionLostPathPrefix: LOCAL_UI_AUTH_TEXT.setup.sessionLostPathPrefix,
  excludedPaths: LOCAL_UI_AUTH_TEXT.setup.excludedPaths,
  auditPathPrefixes: LOCAL_UI_AUTH_TEXT.setup.auditPathPrefixes,
  maxLoginAttempts: LOCAL_UI_AUTH_TEXT.setup.maxLoginAttempts,
  usernameSelector: LOCAL_UI_AUTH_TEXT.setup.usernameSelector,
  passwordSelector: LOCAL_UI_AUTH_TEXT.setup.passwordSelector,
  submitSelector: LOCAL_UI_AUTH_TEXT.setup.submitSelector,
  // T34d: 版 3 の欄。
  loginTransport: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.loginTransport,
  scriptOrigin: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.scriptOrigin,
  scriptPath: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.scriptPath,
  requiredQuery: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.requiredQuery,
  loginSideRequests: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.sideRequests,
  storageOrigin: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.storageOrigin,
  storagePrefix: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.storagePrefix,
  storageSuffix: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.storageSuffix,
  // T35d: 監査の段の欄。
  auditReadRequests: LOCAL_UI_SPA_AUDIT_TEXT.setup.auditReads,
  servicePerMinute: LOCAL_UI_SPA_AUDIT_TEXT.setup.perMinute,
  servicePerRun: LOCAL_UI_SPA_AUDIT_TEXT.setup.perRun,
  ...failureConditionLabels(),
}) as Readonly<Record<AuthSetupFormField, string>>;

/** フォームの外（開始の画面）で示す、誤りの 1 件の文（項目のラベル、あれば行、説明）。 */
export const authSetupErrorSummaryText = (error: AuthSetupErrorView): string =>
  error.field === null ? errorTextOf(error) : `${FIELD_LABELS[error.field]}: ${errorTextOf(error)}`;

/** 拒否の表示（項目ごとの誤りと、フォームの上の誤り）。 */
interface RejectionDisplay {
  readonly view: Extract<AuthSetupSaveView, { ok: false }>;
  readonly fieldErrors: Readonly<Partial<Record<AuthSetupFormField, readonly string[]>>>;
  readonly formErrors: readonly string[];
}

const rejectionDisplayOf = (view: Extract<AuthSetupSaveView, { ok: false }>): RejectionDisplay => {
  const fieldErrors: Partial<Record<AuthSetupFormField, string[]>> = {};
  const formErrors: string[] = [];
  for (const error of view.errors) {
    const text = errorTextOf(error);
    if (error.field === null) {
      formErrors.push(text);
    } else {
      fieldErrors[error.field] = [...(fieldErrors[error.field] ?? []), text];
    }
  }
  return { view, fieldErrors, formErrors: [...new Set(formErrors)] };
};

/** フォームの指定。 */
export interface AuthSetupFormProps {
  readonly initialValues: AuthSetupFormValues;
  /** 認証の方式が自動ログインのプロファイルか（T26e。自動ログインの欄を出し、回数を固定にする）。 */
  readonly automated: boolean;
  /** T34d: プロファイルの承認したテストの Origin（成功の鍵の Origin と、ログインに伴う送信の Origin の選択肢）。 */
  readonly testOrigins: readonly string[];
  /** T34d: プロファイルの承認したサービスの Origin（token の送信先の Origin と、ログインに伴う送信の Origin の選択肢）。 */
  readonly serviceOrigins: readonly string[];
  /** 保存する（サーバへ送る）。 */
  readonly onSave: (values: AuthSetupFormValues) => Promise<AuthSetupSaveView>;
  /** 保存できたとき。 */
  readonly onSaved: () => void;
  /** 改訂の衝突のときに、今の内容を読み直す。 */
  readonly onReload: () => void;
}

/** 選択肢（承認した Origin と、今の値が一覧にないときは今の値も。今の値を黙って変えない）。 */
const originOptionsOf = (origins: readonly string[], current: string): readonly string[] =>
  current.length === 0 || origins.includes(current) ? origins : [...origins, current];

/** T34d: 行を足して入れる一覧の枠（見出し、説明、行の誤り）。 */
function GroupFrame({ label, hint, errors, testId, children }: Readonly<{
  label: string;
  hint: string;
  errors: readonly string[];
  testId: string;
  children: ReactNode;
}>) {
  return (
    <fieldset className="field-group" data-testid={testId} aria-invalid={errors.length > 0}>
      <legend className="field-group-heading">{label}</legend>
      <p className="field-hint">{hint}</p>
      {children}
      {errors.length > 0 ? <p className="field-error">{errors.join(' ')}</p> : null}
    </fieldset>
  );
}

export function AuthSetupForm({ initialValues, automated, testOrigins, serviceOrigins, onSave, onSaved, onReload }: AuthSetupFormProps) {
  const text = LOCAL_UI_AUTH_TEXT.setup;
  const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT.setup;
  // T44h の判断 (2): スクリプトで送るログインの案内（入口の確かめの案の文は、ページの側が出す）。
  const scriptNotices = scriptLoginNoticesOf({ automated, serviceOriginCount: serviceOrigins.length, entryProposalScript: false });
  const [values, setValues] = useState<AuthSetupFormValues>(initialValues);
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<RejectionDisplay | null>(null);
  const errorsOf = (field: AuthSetupFormField): readonly string[] => rejection?.fieldErrors[field] ?? [];
  const change = <TKey extends keyof AuthSetupFormValues>(key: TKey, value: AuthSetupFormValues[TKey]): void => {
    setValues((current) => ({ ...current, [key]: value }));
    // 入力を変えたら、前の保存の拒否の表示を消す（直した後に古い誤りを出し続けない）。
    setRejection(null);
  };
  const changeCondition = (kind: AutomatedLoginFailureConditionKind, key: keyof FailureConditionFormValues, value: string): void => {
    setValues((current) => ({
      ...current,
      failureConditions: { ...current.failureConditions, [kind]: { ...current.failureConditions[kind], [key]: value } },
    }));
    setRejection(null);
  };
  const rejectionText = rejection === null ? null : AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS[rejection.view.reason];
  // T34d: 行の欄（`rowLabel` あり）は、行の見出しのラベルで出し、誤りは一覧の枠（`GroupFrame`）に出す（行ごとに繰り返さない）。
  const plainInput = (
    field: AuthSetupFormField,
    name: string,
    value: string,
    hint: string,
    onChange: (value: string) => void,
    rowLabel?: string,
  ): ReactNode => (
    <FieldFrame
      label={rowLabel ?? FIELD_LABELS[field]}
      {...(hint.length === 0 ? {} : { hint })}
      errors={rowLabel === undefined ? errorsOf(field) : []}
    >
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input"
          name={name}
          type="text"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldFrame>
  );
  const textInput = (field: AuthSetupFormField, key: TextValueKey, hint: string): ReactNode =>
    plainInput(field, key, values[key], hint, (value) => change(key, value));
  const linesInput = (field: AuthSetupFormField, key: 'loginPostEndpoints' | 'excludedPaths' | 'auditPathPrefixes', hint: string): ReactNode => (
    <FieldFrame label={FIELD_LABELS[field]} hint={hint} errors={errorsOf(field)}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          className="input"
          name={key}
          value={values[key]}
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(event) => change(key, event.target.value)}
        />
      )}
    </FieldFrame>
  );
  // T34d: 版 3 の欄。
  // T36a: 自動ログインのプロファイルでも、スクリプトで送るログインの欄を出す。
  const script = values.loginTransport === SCRIPT_REQUEST_TRANSPORT;
  const originSelect = (field: AuthSetupFormField, key: 'scriptOrigin' | 'storageOrigin', origins: readonly string[], hint: string): ReactNode => (
    <FieldFrame label={FIELD_LABELS[field]} hint={hint} errors={errorsOf(field)}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          className="input"
          name={key}
          value={values[key]}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(event) => change(key, event.target.value)}
        >
          <option value="">{scriptText.selectPlaceholder}</option>
          {originOptionsOf(origins, values[key]).map((origin) => <option key={origin} value={origin}>{origin}</option>)}
        </select>
      )}
    </FieldFrame>
  );
  const changeQuery = (index: number, key: keyof QueryFormValues, value: string): void =>
    change('requiredQuery', values.requiredQuery.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)));
  const changeAuditRead = <TKey extends keyof AuditReadFormValues>(index: number, key: TKey, value: AuditReadFormValues[TKey]): void =>
    change('auditReads', values.auditReads.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)));
  const auditText = LOCAL_UI_SPA_AUDIT_TEXT.setup;
  const changeSideRequest = <TKey extends keyof SideRequestFormValues>(index: number, key: TKey, value: SideRequestFormValues[TKey]): void =>
    change('sideRequests', values.sideRequests.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)));
  const lineLabel = (index: number, label: string): string => `${text.lineText(formatInteger(index + 1))} ${label}`;

  return (
    <form
      className="form-grid"
      noValidate
      data-testid="auth-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setRejection(null);
        void onSave(values)
          .then((result) => {
            if (result.ok) {
              onSaved();
            } else {
              setRejection(rejectionDisplayOf(result));
            }
          })
          .finally(() => setSaving(false));
      }}
    >
      {rejection !== null && rejectionText !== null ? (
        <Notice kind="critical" heading={text.rejectedHeading}>
          <p data-testid="auth-setup-rejection" data-reason={rejection.view.reason}>{rejectionText.description}</p>
          {rejection.formErrors.map((error) => <p key={error}>{error}</p>)}
          <p>{rejectionText.action}</p>
          {rejection.view.reason === 'PROFILE_REVISION_CONFLICT' ? (
            <div className="button-row">
              <button type="button" className="button" onClick={onReload}>{LOCAL_UI_TEXT.reload}</button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {textInput('loginStartUrl', 'loginStartUrl', text.loginStartUrlHint)}
      <GroupFrame label={FIELD_LABELS.loginTransport} hint={scriptText.loginTransportHint} errors={errorsOf('loginTransport')} testId="auth-setup-transport">
        {LOGIN_TRANSPORTS.map((transport) => {
          const display = loginTransportDisplay(transport);
          return (
            <label key={transport} className="choice">
              <input
                type="radio"
                name="loginTransport"
                value={transport}
                checked={values.loginTransport === transport}
                onChange={() => change('loginTransport', transport)}
              />
              <span>{display.label}</span>
              {display.description === null ? null : <span className="field-hint">{display.description}</span>}
            </label>
          );
        })}
      </GroupFrame>
      {script ? null : linesInput('loginPostEndpoints', 'loginPostEndpoints', text.loginPostEndpointsHint)}
      {textInput('successPathPrefix', 'successPathPrefix', text.successPathPrefixHint)}
      {textInput('successSelector', 'successSelector', text.successSelectorHint)}
      {textInput('sessionLostPathPrefix', 'sessionLostPathPrefix', text.sessionLostPathPrefixHint)}
      {linesInput('excludedPaths', 'excludedPaths', text.excludedPathsHint)}
      {linesInput('auditPathPrefixes', 'auditPathPrefixes', text.auditPathPrefixesHint)}
      {automated ? (
        <FieldFrame label={FIELD_LABELS.maxLoginAttempts} hint={text.maxLoginAttemptsFixedHint} errors={errorsOf('maxLoginAttempts')}>
          {({ id, describedBy }) => (
            <output id={id} className="field-value" aria-describedby={describedBy} data-testid="auth-setup-max-login-attempts-fixed">
              {text.maxLoginAttemptsFixedText(formatTimes(AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS))}
            </output>
          )}
        </FieldFrame>
      ) : (
        <FieldFrame
          label={FIELD_LABELS.maxLoginAttempts}
          hint={text.maxLoginAttemptsHint(formatTimes(MIN_LOGIN_ATTEMPTS), formatTimes(MAX_LOGIN_ATTEMPTS))}
          errors={errorsOf('maxLoginAttempts')}
        >
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              className="input"
              name="maxLoginAttempts"
              value={String(values.maxLoginAttempts)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => change('maxLoginAttempts', Number(event.target.value))}
            >
              {LOGIN_ATTEMPT_OPTIONS.map((count) => <option key={count} value={String(count)}>{formatTimes(count)}</option>)}
            </select>
          )}
        </FieldFrame>
      )}

      {script ? (
        <fieldset className="field-group" data-testid="auth-setup-script">
          <legend className="field-group-heading">{scriptText.scriptHeading}</legend>
          <p className="field-hint">{scriptText.scriptBody}</p>
          {/* T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルでは、送信先と鍵を空のまま保存でき、手動のログインの後に自動で登録される。T44h の判断 (2):
              承認したサービスの Origin も自動の登録が足すので、赤い文（先にプロファイルで足す）は自動ログインのプロファイルだけに出す（`scriptLoginNoticesOf`）。 */}
          {scriptNotices.autoRegistration === null ? null : <p data-testid="auth-setup-script-login-note">{scriptNotices.autoRegistration}</p>}
          {scriptNotices.serviceOriginsRequired === null ? null : (
            <p className="field-error" data-testid="auth-setup-no-service-origins">{scriptNotices.serviceOriginsRequired}</p>
          )}
          {originSelect('scriptOrigin', 'scriptOrigin', serviceOrigins, scriptText.scriptOriginHint)}
          {textInput('scriptPath', 'scriptPath', scriptText.scriptPathHint)}
          <p className="field-hint" data-testid="auth-setup-script-method">{`${scriptText.methodFixed}: ${scriptText.methodFixedValue}`}</p>
          <GroupFrame
            label={FIELD_LABELS.requiredQuery}
            hint={scriptText.requiredQueryHint(formatCount(MAX_SCRIPT_LOGIN_REQUIRED_QUERY))}
            errors={errorsOf('requiredQuery')}
            testId="auth-setup-required-query"
          >
            {values.requiredQuery.map((row, index) => (
              // 行の位置で並ぶ一覧（足すと末尾、消すと詰める）。
              <div key={index} className="field-pair" data-testid="auth-setup-required-query-row">
                {plainInput('requiredQuery', `requiredQueryName${String(index)}`, row.name, '', (value) => changeQuery(index, 'name', value),
                  lineLabel(index, scriptText.queryName))}
                {plainInput('requiredQuery', `requiredQueryValue${String(index)}`, row.value, '', (value) => changeQuery(index, 'value', value),
                  lineLabel(index, scriptText.queryValue))}
                <button type="button" className="button" onClick={() => change('requiredQuery', values.requiredQuery.filter((_row, rowIndex) => rowIndex !== index))}>
                  {lineLabel(index, scriptText.removeQuery)}
                </button>
              </div>
            ))}
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={values.requiredQuery.length >= MAX_SCRIPT_LOGIN_REQUIRED_QUERY}
                onClick={() => change('requiredQuery', [...values.requiredQuery, EMPTY_QUERY])}
              >
                {scriptText.addQuery}
              </button>
            </div>
          </GroupFrame>
          <GroupFrame
            label={FIELD_LABELS.loginSideRequests}
            hint={scriptText.sideRequestsHint(formatCount(MAX_LOGIN_SIDE_REQUESTS), formatTimes(MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE))}
            errors={errorsOf('loginSideRequests')}
            testId="auth-setup-side-requests"
          >
            {values.sideRequests.length === 0 ? <p>{scriptText.noSideRequests}</p> : null}
            {values.sideRequests.map((row, index) => (
              <div key={index} className="field-pair" data-testid="auth-setup-side-request-row">
                <FieldFrame label={lineLabel(index, scriptText.sideOrigin)} errors={[]}>
                  {({ id, describedBy }) => (
                    <select
                      id={id}
                      className="input"
                      name={`sideRequestOrigin${String(index)}`}
                      value={row.origin}
                      aria-describedby={describedBy}
                      onChange={(event) => changeSideRequest(index, 'origin', event.target.value)}
                    >
                      <option value="">{scriptText.selectPlaceholder}</option>
                      {originOptionsOf([...testOrigins, ...serviceOrigins], row.origin).map((origin) => <option key={origin} value={origin}>{origin}</option>)}
                    </select>
                  )}
                </FieldFrame>
                {plainInput('loginSideRequests', `sideRequestPath${String(index)}`, row.path, '', (value) => changeSideRequest(index, 'path', value),
                  lineLabel(index, scriptText.sidePath))}
                <FieldFrame label={lineLabel(index, scriptText.sideMaxPerLoginStage)} errors={[]}>
                  {({ id, describedBy }) => (
                    <select
                      id={id}
                      className="input"
                      name={`sideRequestMax${String(index)}`}
                      value={String(row.maxPerLoginStage)}
                      aria-describedby={describedBy}
                      onChange={(event) => changeSideRequest(index, 'maxPerLoginStage', Number(event.target.value))}
                    >
                      {SIDE_REQUEST_COUNT_OPTIONS.map((count) => <option key={count} value={String(count)}>{formatTimes(count)}</option>)}
                    </select>
                  )}
                </FieldFrame>
                <span className="field-hint">{`${scriptText.methodFixed}: ${scriptText.methodFixedValue}`}</span>
                <button type="button" className="button" onClick={() => change('sideRequests', values.sideRequests.filter((_row, rowIndex) => rowIndex !== index))}>
                  {lineLabel(index, scriptText.removeSideRequest)}
                </button>
              </div>
            ))}
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={values.sideRequests.length >= MAX_LOGIN_SIDE_REQUESTS}
                onClick={() => change('sideRequests', [...values.sideRequests, EMPTY_SIDE_REQUEST])}
              >
                {scriptText.addSideRequest}
              </button>
            </div>
          </GroupFrame>
          <p className="field-group-subheading">{scriptText.storageKeyHeading}</p>
          <p className="field-hint">{scriptText.storageKeyBody}</p>
          {originSelect('storageOrigin', 'storageOrigin', testOrigins, scriptText.storageOriginHint)}
          {textInput('storagePrefix', 'storagePrefix', scriptText.storagePrefixHint)}
          {textInput('storageSuffix', 'storageSuffix', scriptText.storageSuffixHint)}

          {/* T35d（Task 35 の設計書 3.1、3.4）: 監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限。 */}
          <GroupFrame
            label={FIELD_LABELS.auditReadRequests}
            hint={auditText.auditReadsHint(formatCount(MAX_AUDIT_READ_REQUESTS), formatTimes(MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD))}
            errors={errorsOf('auditReadRequests')}
            testId="auth-setup-audit-reads"
          >
            <p className="field-hint">{auditText.auditReadsJudgement}</p>
            {values.auditReads.length === 0 ? <p>{auditText.noReads}</p> : null}
            {values.auditReads.map((row, index) => (
              <div key={index} className="field-pair" data-testid="auth-setup-audit-read-row">
                <FieldFrame label={lineLabel(index, auditText.readOrigin)} errors={[]}>
                  {({ id, describedBy }) => (
                    <select
                      id={id}
                      className="input"
                      name={`auditReadOrigin${String(index)}`}
                      value={row.origin}
                      aria-describedby={describedBy}
                      onChange={(event) => changeAuditRead(index, 'origin', event.target.value)}
                    >
                      <option value="">{scriptText.selectPlaceholder}</option>
                      {originOptionsOf([...testOrigins, ...serviceOrigins], row.origin).map((origin) => <option key={origin} value={origin}>{origin}</option>)}
                    </select>
                  )}
                </FieldFrame>
                {plainInput('auditReadRequests', `auditReadPath${String(index)}`, row.path, '', (value) => changeAuditRead(index, 'path', value),
                  lineLabel(index, auditText.readPath))}
                <FieldFrame label={lineLabel(index, auditText.readMaxPerPageLoad)} errors={[]}>
                  {({ id, describedBy }) => (
                    <select
                      id={id}
                      className="input"
                      name={`auditReadMax${String(index)}`}
                      value={String(row.maxPerPageLoad)}
                      aria-describedby={describedBy}
                      onChange={(event) => changeAuditRead(index, 'maxPerPageLoad', Number(event.target.value))}
                    >
                      {AUDIT_READ_COUNT_OPTIONS.map((count) => <option key={count} value={String(count)}>{formatTimes(count)}</option>)}
                    </select>
                  )}
                </FieldFrame>
                <span className="field-hint">{`${scriptText.methodFixed}: ${scriptText.methodFixedValue}`}</span>
                <button type="button" className="button" onClick={() => change('auditReads', values.auditReads.filter((_row, rowIndex) => rowIndex !== index))}>
                  {lineLabel(index, auditText.removeRead)}
                </button>
              </div>
            ))}
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={values.auditReads.length >= MAX_AUDIT_READ_REQUESTS}
                onClick={() => change('auditReads', [...values.auditReads, EMPTY_AUDIT_READ])}
              >
                {auditText.addRead}
              </button>
            </div>
          </GroupFrame>
          <p className="field-group-subheading">{auditText.limitsHeading}</p>
          <p className="field-hint">
            {auditText.limitsBody(formatCount(MAX_SERVICE_REQUESTS_PER_MINUTE), formatCount(MAX_SERVICE_REQUESTS_PER_RUN), formatCount(SERVICE_REQUESTS_PER_PAGE_ALLOWANCE))}
          </p>
          {textInput('servicePerMinute', 'servicePerMinute',
            auditText.perMinuteHint(formatCount(MIN_SERVICE_REQUESTS_PER_MINUTE), formatCount(MAX_SERVICE_REQUESTS_PER_MINUTE)))}
          {textInput('servicePerRun', 'servicePerRun',
            auditText.perRunHint(formatCount(MIN_SERVICE_REQUESTS_PER_RUN), formatCount(MAX_SERVICE_REQUESTS_PER_RUN), formatCount(SERVICE_REQUESTS_PER_PAGE_ALLOWANCE)))}
        </fieldset>
      ) : null}

      {automated ? (
        <fieldset className="field-group" data-testid="auth-setup-automated">
          <legend className="field-group-heading">{text.automatedHeading}</legend>
          <p className="field-hint">{text.automatedBody}</p>
          {textInput('usernameSelector', 'usernameSelector', text.usernameSelectorHint)}
          {textInput('passwordSelector', 'passwordSelector', text.passwordSelectorHint)}
          {textInput('submitSelector', 'submitSelector', text.submitSelectorHint)}
          <p className="field-group-subheading">{text.failureConditionsHeading}</p>
          <p className="field-hint">{text.failureConditionsBody}</p>
          {AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.map((kind) => (
            <div key={kind} className="field-pair">
              {plainInput(
                failureConditionPathFieldOf(kind),
                failureConditionPathFieldOf(kind),
                values.failureConditions[kind].pathPrefix,
                text.failurePathPrefixHint,
                (value) => changeCondition(kind, 'pathPrefix', value),
              )}
              {plainInput(
                failureConditionSelectorFieldOf(kind),
                failureConditionSelectorFieldOf(kind),
                values.failureConditions[kind].selector,
                text.failureSelectorHint,
                (value) => changeCondition(kind, 'selector', value),
              )}
            </div>
          ))}
        </fieldset>
      ) : null}

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={saving}>
          {saving ? text.saving : text.save}
        </button>
      </div>
    </form>
  );
}
