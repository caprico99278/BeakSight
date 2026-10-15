/**
 * プロファイルの登録・編集のフォーム（Task 23 設計書 4.7。TanStack Form）。
 * - 画面の側の確かめ（必須、名前の形）は補助だけ。保存の前に、サーバが Task 22 の検証を行い、誤りのコードを返す。
 * - 誤りは、項目ごとに日本語で出す（`PROFILE_VALIDATION_ERROR_DESCRIPTIONS`、`PROFILE_STORE_REJECTION_DESCRIPTIONS`、設定の誤りの説明）。
 * - `TEST_*` のモードは保存できるが、今は実行できないことを明示する。
 * - T25e: 認証つきの読み取りの監査（認証の設定が要るモード）を選んだときは、保存した後に認証の設定を作ってから始めることを案内する
 *   （今実行できないモードの案内は、承認した書き込みの監査だけに出る）。
 */
import { useEffect, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import {
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  SITE_PROFILE_SCHEMA_VERSION,
  type AuditMode,
  type AuthStrategy,
  type EnvironmentKind,
  type ProfileValidationErrorCode,
  type SiteProfile,
} from '../../../../src/control/contracts.js';
import type { ProfileStoreRejectionReason } from '../../../../src/control/store/profile-store.js';
import { requiresAuthSetup } from '../../../../src/control/execution-policy.js';
import {
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  describeConfigError,
} from '../../../../src/presentation/messages.js';
import {
  AUDIT_MODE_OPTIONS,
  AUTH_STRATEGY_OPTIONS,
  ENVIRONMENT_OPTIONS,
  isNotYetExecutableMode,
  type SelectOption,
} from '../display/labels';
import { checkTargetConfigFn, type ProfileChangeView } from '../server/profile-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

/** フォームの値（画面の入力のまま）。 */
export interface ProfileFormValues {
  readonly profileId: string;
  readonly targetConfigPath: string;
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** 1 行に 1 つ。 */
  readonly approvedTestOrigins: string;
  readonly environmentEvidenceRef: string;
}

/** 項目の名前。 */
type FieldName = keyof ProfileFormValues;

/** 検証の誤りのコードが指す項目（項目に結び付かないものは `null` で、フォームの上に出す）。 */
const FIELD_OF_ERROR_CODE: Readonly<Record<ProfileValidationErrorCode, FieldName | null>> = Object.freeze({
  PROFILE_SCHEMA_INVALID: null,
  PROFILE_ID_INVALID: 'profileId',
  PROFILE_TARGET_PATH_INVALID: 'targetConfigPath',
  PROFILE_MODE_ENVIRONMENT_MISMATCH: 'mode',
  PROFILE_AUTH_MISMATCH: 'auth',
  PROFILE_TEST_ORIGINS_REQUIRED: 'approvedTestOrigins',
  PROFILE_TEST_ORIGIN_INVALID: 'approvedTestOrigins',
  PROFILE_TEST_ORIGIN_OUTSIDE_TARGET: 'approvedTestOrigins',
  PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED: 'environmentEvidenceRef',
  PROFILE_REVISION_NOT_ADVANCED: null,
});

/** 新しいプロファイルの初めの値。 */
export const EMPTY_PROFILE_FORM: ProfileFormValues = Object.freeze({
  profileId: '',
  targetConfigPath: '',
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: '',
  environmentEvidenceRef: '',
});

/** 保存されているプロファイルを、フォームの値にする。 */
export const formValuesOf = (profile: SiteProfile): ProfileFormValues => ({
  profileId: profile.profileId,
  targetConfigPath: profile.targetConfigPath,
  environment: profile.environment,
  mode: profile.mode,
  auth: profile.auth,
  approvedTestOrigins: profile.approvedTestOrigins.join('\n'),
  environmentEvidenceRef: profile.environmentEvidenceRef ?? '',
});

/** フォームの値から、保存するプロファイルの文書を作る。 */
export const profileDocumentOf = (values: ProfileFormValues, revision: number): SiteProfile => {
  const evidence = values.environmentEvidenceRef.trim();
  return {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: values.profileId.trim(),
    revision,
    targetConfigPath: values.targetConfigPath,
    environment: values.environment,
    mode: values.mode,
    auth: values.auth,
    approvedTestOrigins: values.approvedTestOrigins.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0),
    environmentEvidenceRef: evidence.length === 0 ? null : evidence,
  };
};

/** 拒否の結果の表示（項目ごとの誤りと、フォームの上の誤り）。 */
interface RejectionDisplay {
  readonly reason: ProfileStoreRejectionReason;
  readonly fieldErrors: Readonly<Partial<Record<FieldName, readonly string[]>>>;
  readonly formErrors: readonly string[];
}

const rejectionDisplayOf = (
  reason: ProfileStoreRejectionReason,
  errorCodes: readonly ProfileValidationErrorCode[],
  configError: ConfigErrorKind | null,
): RejectionDisplay => {
  const fieldErrors: Partial<Record<FieldName, string[]>> = {};
  const formErrors: string[] = [];
  for (const code of new Set(errorCodes)) {
    const field = FIELD_OF_ERROR_CODE[code];
    const text = PROFILE_VALIDATION_ERROR_DESCRIPTIONS[code];
    if (field === null) {
      formErrors.push(text);
    } else {
      fieldErrors[field] = [...(fieldErrors[field] ?? []), text];
    }
  }
  if (configError !== null) {
    fieldErrors.targetConfigPath = [...(fieldErrors.targetConfigPath ?? []), describeConfigError(configError)];
  }
  return { reason, fieldErrors, formErrors };
};

/** 選んだ設定のファイルの確かめ（既存の読み込みと検証の結果）。 */
function TargetConfigCheck({ path }: Readonly<{ path: string }>) {
  const check = useServerFn(checkTargetConfigFn);
  const [message, setMessage] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  useEffect(() => {
    if (path === '') {
      setMessage(null);
      return undefined;
    }
    let cancelled = false;
    setMessage({ ok: true, text: LOCAL_UI_TEXT.profileForm.configChecking });
    void check({ data: { targetConfigPath: path } }).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setMessage({ ok: true, text: LOCAL_UI_TEXT.profileForm.configOk });
      } else if (!result.pathAccepted) {
        setMessage({ ok: false, text: PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_TARGET_PATH_INVALID });
      } else {
        setMessage({ ok: false, text: describeConfigError(result.configError) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, check]);
  if (message === null) {
    return null;
  }
  return (
    <Notice kind={message.ok ? 'positive' : 'critical'} heading={LOCAL_UI_TEXT.profileForm.configCheckHeading}>
      <p>{message.text}</p>
    </Notice>
  );
}

const selectOptions = <TValue extends string>(options: readonly SelectOption<TValue>[]) =>
  options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>);

/** フォームの指定。 */
export interface ProfileFormProps {
  /** 新しく作るか、既にあるものを編集するか（編集では名前を変えられない）。 */
  readonly kind: 'create' | 'edit';
  readonly initialValues: ProfileFormValues;
  /** 設定のファイルの候補（リポジトリの root からの相対パス）。 */
  readonly targetConfigCandidates: readonly string[];
  /** 保存する（サーバへ送る）。 */
  readonly onSave: (values: ProfileFormValues) => Promise<ProfileChangeView>;
  /** 保存できたとき。 */
  readonly onSaved: (view: Extract<ProfileChangeView, { ok: true }>) => void;
  /** 改訂の衝突のときに、今の内容を読み直す。 */
  readonly onReload: () => void;
}

export function ProfileForm({ kind, initialValues, targetConfigCandidates, onSave, onSaved, onReload }: ProfileFormProps) {
  const text = LOCAL_UI_TEXT.profileForm;
  const [rejection, setRejection] = useState<RejectionDisplay | null>(null);
  const form = useForm({
    defaultValues: initialValues,
    onSubmit: async ({ value }) => {
      setRejection(null);
      const result = await onSave(value);
      if (result.ok) {
        onSaved(result);
      } else {
        setRejection(rejectionDisplayOf(result.reason, result.errorCodes, result.configError));
      }
    },
  });

  const serverErrorsOf = (field: FieldName): readonly string[] => rejection?.fieldErrors[field] ?? [];
  const clientErrorsOf = (errors: readonly unknown[]): readonly string[] => errors.filter((error): error is string => typeof error === 'string');
  const rejectionText = rejection === null ? null : PROFILE_STORE_REJECTION_DESCRIPTIONS[rejection.reason];

  return (
    <form
      className="form-grid"
      noValidate
      onChange={() => {
        // 入力を変えたら、前の保存の拒否の表示を消す（直した後に古い誤りを出し続けない）。
        if (rejection !== null) {
          setRejection(null);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {rejection !== null && rejectionText !== null ? (
        <Notice kind="critical" heading={text.rejectedHeading}>
          <p>{rejectionText.description}</p>
          {rejection.formErrors.map((error) => <p key={error}>{error}</p>)}
          <p>{rejectionText.action}</p>
          {rejection.reason === 'PROFILE_REVISION_CONFLICT' ? (
            <div className="button-row">
              <button type="button" className="button" onClick={onReload}>{LOCAL_UI_TEXT.reload}</button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      <form.Field
        name="profileId"
        validators={{
          onSubmit: ({ value }) => {
            if (value.trim() === '') {
              return text.required;
            }
            return PROFILE_ID_PATTERN.test(value.trim()) ? undefined : PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_ID_INVALID;
          },
        }}
      >
        {(field) => (
          <FieldFrame label={text.profileId} hint={text.profileIdHint} errors={[...clientErrorsOf(field.state.meta.errors), ...serverErrorsOf('profileId')]}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                name={field.name}
                value={field.state.value}
                readOnly={kind === 'edit'}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>

      <form.Field
        name="targetConfigPath"
        validators={{ onSubmit: ({ value }) => (value === '' ? text.required : undefined) }}
      >
        {(field) => (
          <>
            <FieldFrame
              label={text.targetConfigPath}
              hint={targetConfigCandidates.length === 0 ? text.noTargetConfigs : text.targetConfigPathHint}
              errors={[...clientErrorsOf(field.state.meta.errors), ...serverErrorsOf('targetConfigPath')]}
            >
              {({ id, describedBy, invalid }) => (
                <select
                  id={id}
                  className="input"
                  name={field.name}
                  value={field.state.value}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <option value="">{text.targetConfigPathPlaceholder}</option>
                  {[...new Set([...targetConfigCandidates, ...(field.state.value === '' ? [] : [field.state.value])])].sort().map((path) => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                </select>
              )}
            </FieldFrame>
            <TargetConfigCheck path={field.state.value} />
          </>
        )}
      </form.Field>

      <form.Field name="environment">
        {(field) => (
          <FieldFrame label={text.environment} errors={serverErrorsOf('environment')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="input"
                name={field.name}
                value={field.state.value}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value as EnvironmentKind)}
              >
                {selectOptions(ENVIRONMENT_OPTIONS)}
              </select>
            )}
          </FieldFrame>
        )}
      </form.Field>

      <form.Field name="mode">
        {(field) => (
          <>
            <FieldFrame label={text.mode} errors={serverErrorsOf('mode')}>
              {({ id, describedBy, invalid }) => (
                <select
                  id={id}
                  className="input"
                  name={field.name}
                  value={field.state.value}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value as AuditMode)}
                >
                  {selectOptions(AUDIT_MODE_OPTIONS)}
                </select>
              )}
            </FieldFrame>
            {isNotYetExecutableMode(field.state.value) ? (
              <Notice kind="caution">
                <p>{text.testModeNotice}</p>
              </Notice>
            ) : null}
            {requiresAuthSetup(field.state.value) ? (
              <Notice kind="caution">
                <p data-testid="profile-auth-setup-notice">{LOCAL_UI_AUTH_TEXT.profileFormNotice}</p>
              </Notice>
            ) : null}
          </>
        )}
      </form.Field>

      <form.Field name="auth">
        {(field) => (
          <FieldFrame label={text.auth} errors={serverErrorsOf('auth')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="input"
                name={field.name}
                value={field.state.value}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value as AuthStrategy)}
              >
                {selectOptions(AUTH_STRATEGY_OPTIONS)}
              </select>
            )}
          </FieldFrame>
        )}
      </form.Field>

      <form.Field name="approvedTestOrigins">
        {(field) => (
          <FieldFrame label={text.approvedTestOrigins} hint={text.approvedTestOriginsHint} errors={serverErrorsOf('approvedTestOrigins')}>
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className="input"
                name={field.name}
                value={field.state.value}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>

      <form.Field name="environmentEvidenceRef">
        {(field) => (
          <FieldFrame label={text.environmentEvidenceRef} hint={text.environmentEvidenceRefHint} errors={serverErrorsOf('environmentEvidenceRef')}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                name={field.name}
                value={field.state.value}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>

      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="button-row">
            <button type="submit" className="button button--primary" disabled={isSubmitting}>
              {isSubmitting ? text.saving : text.save}
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/** 新しいプロファイルの最初の改訂。 */
export const FIRST_REVISION = MIN_PROFILE_REVISION;
