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
 *   条件のパスとセレクタ）の欄を出し、版 2 の `automatedLogin` を組み立てる。失敗の条件は、パスとセレクタの両方が空なら「使わない」（`null`）。
 *   ログインの送信の回数は、自動ログインでは `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` に固定して表示する（編集させない）。手動のログインでは今のまま
 *   （`automatedLogin: null`）。ユーザー名とパスワードの値の欄は、このフォームにない（資格情報の画面）。
 */
import { useState, type ReactNode } from 'react';
import {
  AUTH_SETUP_SCHEMA_VERSION_2,
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  MIN_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AutomatedLoginFailureConditionKind,
  type LoginPostEndpoint,
  type LoginResultCondition,
} from '../../../../src/control/auth/auth-setup-contracts.js';
import { formatInteger, formatTimes } from '../../../../src/presentation/format.js';
import {
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../src/presentation/messages.js';
import {
  failureConditionPathFieldOf,
  failureConditionSelectorFieldOf,
  type AuthSetupErrorView,
  type AuthSetupFormField,
} from '../server/auth-setup-errors';
import type { AuthSetupSaveView } from '../server/auth-setup-functions';
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
}

/** 文字列の欄の名前（`textInput` が扱う）。 */
type TextValueKey = Exclude<keyof AuthSetupFormValues, 'maxLoginAttempts' | 'failureConditions'>;

/** 回数の上限の選択肢（下限から上限まで）。 */
const LOGIN_ATTEMPT_OPTIONS: readonly number[] = Array.from(
  { length: MAX_LOGIN_ATTEMPTS - MIN_LOGIN_ATTEMPTS + 1 },
  (_unused, index) => MIN_LOGIN_ATTEMPTS + index,
);

/** 行の区切り。 */
const LINE_SEPARATOR = /\r?\n/u;

const linesOf = (text: string): string[] => text.split(LINE_SEPARATOR).map((line) => line.trim()).filter((line) => line.length > 0);

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

/** 保存してある設定（なければ空）を、フォームの値にする。自動ログインのプロファイル（`automated`）では、回数は固定の値。 */
export const authSetupFormValuesOf = (setup: AuthSetup | null, automated = false): AuthSetupFormValues => ({
  loginStartUrl: setup?.loginStartUrl ?? '',
  loginPostEndpoints: (setup?.loginPostEndpoints ?? []).map((endpoint) => `${endpoint.origin}${endpoint.path}`).join('\n'),
  successPathPrefix: setup?.successCondition.pathPrefix ?? '',
  successSelector: setup?.successCondition.selector ?? '',
  sessionLostPathPrefix: setup?.sessionLostCondition.pathPrefix ?? '',
  excludedPaths: (setup?.excludedPaths ?? []).join('\n'),
  auditPathPrefixes: (setup?.auditPathPrefixes ?? []).join('\n'),
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : (setup?.maxLoginAttempts ?? MIN_LOGIN_ATTEMPTS),
  usernameSelector: setup?.automatedLogin?.usernameSelector ?? '',
  passwordSelector: setup?.automatedLogin?.passwordSelector ?? '',
  submitSelector: setup?.automatedLogin?.submitSelector ?? '',
  failureConditions: Object.fromEntries(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.map((kind) =>
    [kind, failureConditionValuesOf(setup?.automatedLogin?.failureConditions[kind])])) as Record<AutomatedLoginFailureConditionKind, FailureConditionFormValues>,
});

/**
 * フォームの値から、保存する認証の設定の文書を作る（プロファイルの今の改訂に結びつける）。版 2（Task 26 の設計書 4.3。T26b）で作る。
 * 自動ログインのプロファイル（`automated`）では、自動ログインの設定を組み立て、回数は固定の値にする（T26e）。手動のログインでは
 * `automatedLogin` は null。
 */
export const authSetupDocumentOf = (values: AuthSetupFormValues, profileId: string, profileRevision: number, automated = false): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
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
  /** 保存する（サーバへ送る）。 */
  readonly onSave: (values: AuthSetupFormValues) => Promise<AuthSetupSaveView>;
  /** 保存できたとき。 */
  readonly onSaved: () => void;
  /** 改訂の衝突のときに、今の内容を読み直す。 */
  readonly onReload: () => void;
}

export function AuthSetupForm({ initialValues, automated, onSave, onSaved, onReload }: AuthSetupFormProps) {
  const text = LOCAL_UI_AUTH_TEXT.setup;
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
  const plainInput = (
    field: AuthSetupFormField,
    name: string,
    value: string,
    hint: string,
    onChange: (value: string) => void,
  ): ReactNode => (
    <FieldFrame label={FIELD_LABELS[field]} hint={hint} errors={errorsOf(field)}>
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
      {linesInput('loginPostEndpoints', 'loginPostEndpoints', text.loginPostEndpointsHint)}
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
