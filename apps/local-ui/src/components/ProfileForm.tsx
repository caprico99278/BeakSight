/**
 * プロファイルの登録・編集のフォーム（Task 23 設計書 4.7。TanStack Form）。
 * - 画面の側の確かめ（必須、名前の形）は補助だけ。保存の前に、サーバが Task 22 の検証を行い、誤りのコードを返す。
 * - 誤りは、項目ごとに日本語で出す（`PROFILE_VALIDATION_ERROR_DESCRIPTIONS`、`PROFILE_STORE_REJECTION_DESCRIPTIONS`、設定の誤りの説明）。
 * - `TEST_*` のモードは保存できるが、今は実行できないことを明示する。
 * - T25e: 認証つきの読み取りの監査（認証の設定が要るモード）を選んだときは、保存した後に認証の設定を作ってから始めることを案内する
 *   （今実行できないモードの案内は、承認した書き込みの監査だけに出る）。
 * - T34d（Task 34 の設計書 3.1）: 「承認したサービスの Origin」の欄（1 行に 1 つ）。テスト環境の 2 つのモード（認証の設定が要るモード）だけ出し、
 *   1 つ以上あるときだけプロファイルの項目にする（項目のないプロファイルの digest を変えない）。誤りの 2 つのコードは、この欄に出す。
 * - T43b（Task 43 の設計書 4.2）: 作成では、対象の設定を「開始の URL から新しく作る」（既定）か「すでにある設定のファイルを使う」かを選ぶ（どちらか
 *   一方）。新しく作るときは、開始の URL を入れると、その場で名前（ID）・許可 Origin・テスト環境の Origin の案を埋める（区分 a。`display/start-url-draft.ts`）。
 *   埋めた値は案で、利用者が直した欄は、その後は URL に追従しない。保存すると、サーバが `local/targets/<名前>.json` を作り、プロファイルはそれを指す。
 *   編集と「すでにある設定のファイルを使う」は、今までどおり（設定のファイルを選ぶ）。
 */
import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import {
  GENERATED_TARGET_CRAWL_LIMITS,
  allowedOriginsProblemOf,
  isReservedTargetConfigName,
  isTargetConfigCreationFailure,
  startUrlProblemOf,
  type TargetConfigCreationFailure,
  type TargetSiteInput,
  type TargetSiteProblem,
} from '../../../../src/config/target-config-draft.js';
import {
  MAX_APPROVED_SERVICE_ORIGINS,
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
import { formatCount, formatDuration, formatInteger } from '../../../../src/presentation/format.js';
import { requiresAuthSetup } from '../../../../src/control/execution-policy.js';
import {
  TEST_ORIGIN_MODES,
  defaultEnvironmentAndAuthOf,
  environmentAcceptsEvidence,
} from '../../../../src/control/profile-combinations.js';
import {
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
  describeConfigError,
} from '../../../../src/presentation/messages.js';
import {
  AUDIT_MODE_OPTIONS,
  AUTH_STRATEGY_OPTIONS,
  ENVIRONMENT_OPTIONS,
  isNotYetExecutableMode,
  type SelectOption,
} from '../display/labels';
import { linesOf, textOfLines } from '../display/form-lines';
import { generatedTargetConfigPathOf, profileDraftOf } from '../display/start-url-draft';
import { checkTargetConfigFn, type ProfileChangeView, type ProfileCreateView } from '../server/profile-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

/** T43b: 対象の設定の選び方（開始の URL から新しく作る、すでにある設定のファイルを使う）。 */
export type TargetSource = 'NEW' | 'EXISTING';

/** 選び方の順（画面の選択肢の順）。 */
const TARGET_SOURCES: readonly TargetSource[] = Object.freeze(['NEW', 'EXISTING']);

/** フォームの値（画面の入力のまま）。 */
export interface ProfileFormValues {
  /** T43b: 対象の設定の選び方（編集では `EXISTING`）。 */
  readonly targetSource: TargetSource;
  /** T43b: 開始の URL（`NEW` のときだけ使う）。 */
  readonly startUrl: string;
  /** T43b: 許可 Origin（1 行に 1 つ。`NEW` のときだけ使う）。 */
  readonly allowedOrigins: string;
  readonly profileId: string;
  /** すでにある設定のファイル（`EXISTING` のときだけ使う。`NEW` では、名前から決まる作るファイルのパス）。 */
  readonly targetConfigPath: string;
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** 1 行に 1 つ。 */
  readonly approvedTestOrigins: string;
  /** T34d: 承認したサービスの Origin（1 行に 1 つ。テスト環境の 2 つのモードだけ欄を出し、送る）。 */
  readonly approvedServiceOrigins: string;
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
  // T34d: 承認したサービスの Origin の欄。
  PROFILE_SERVICE_ORIGIN_INVALID: 'approvedServiceOrigins',
  PROFILE_SERVICE_ORIGIN_INSIDE_TARGET: 'approvedServiceOrigins',
});

/** T43b: 開始の URL と許可 Origin の欄の誤りが指す欄。 */
const FIELD_OF_SITE_PROBLEM: Readonly<Record<TargetSiteProblem, 'startUrl' | 'allowedOrigins'>> = Object.freeze({
  START_URL_REQUIRED: 'startUrl',
  START_URL_INVALID: 'startUrl',
  START_URL_TOO_LONG: 'startUrl',
  START_URL_HAS_CREDENTIALS: 'startUrl',
  START_URL_HAS_FRAGMENT: 'startUrl',
  ALLOWED_ORIGINS_REQUIRED: 'allowedOrigins',
  ALLOWED_ORIGIN_INVALID: 'allowedOrigins',
  ALLOWED_ORIGINS_TOO_MANY: 'allowedOrigins',
  ALLOWED_ORIGINS_MISSING_START: 'allowedOrigins',
});

/** 新しいプロファイルの初めの値（T43b: 開始の URL から新しく作る）。 */
export const EMPTY_PROFILE_FORM: ProfileFormValues = Object.freeze({
  targetSource: 'NEW',
  startUrl: '',
  allowedOrigins: '',
  profileId: '',
  targetConfigPath: '',
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: '',
  approvedServiceOrigins: '',
  environmentEvidenceRef: '',
});

/** 保存されているプロファイルを、フォームの値にする。 */
export const formValuesOf = (profile: SiteProfile): ProfileFormValues => ({
  targetSource: 'EXISTING',
  startUrl: '',
  allowedOrigins: '',
  profileId: profile.profileId,
  targetConfigPath: profile.targetConfigPath,
  environment: profile.environment,
  mode: profile.mode,
  auth: profile.auth,
  approvedTestOrigins: textOfLines(profile.approvedTestOrigins),
  approvedServiceOrigins: textOfLines(profile.approvedServiceOrigins ?? []),
  environmentEvidenceRef: profile.environmentEvidenceRef ?? '',
});

// 1 行に 1 つの欄の読み方と書き方は、`display/form-lines.ts` の `linesOf`・`textOfLines`（T43b fix round 1）。

/**
 * テスト環境の Origin と承認したサービスの Origin の欄を出すモードか（テスト環境の 2 つのモード。判定は組み合わせの表の owner
 * `profile-combinations.ts` の `TEST_ORIGIN_MODES`。T43a fix round 1 で、認証の設定が要るモードでの代用をやめた）。公開のモードでは、この 2 つの欄を
 * 隠し、隠した欄の値は送らない（保存の検証は今のまま。Task 43 の設計書 4.1）。
 */
export const usesTestEnvironmentFields = (mode: AuditMode): boolean => TEST_ORIGIN_MODES.includes(mode);

/** T34d: 承認したサービスの Origin の欄を出すモードか（テスト環境の Origin の欄と同じ）。 */
export const usesServiceOrigins = (mode: AuditMode): boolean => usesTestEnvironmentFields(mode);

/**
 * 確かめた記録の参照の欄を出すか（T43a fix round 1。設計者の判断 3）。モードではなく、環境で決める（公開のモードでも、環境がテスト環境なら出して
 * 送る）。判定は `profile-combinations.ts` の `environmentAcceptsEvidence`。
 */
export const usesEvidenceField = (environment: EnvironmentKind): boolean => environmentAcceptsEvidence(environment);

/** 欄が今の値で出ているか（出ていない欄の、保存の検証の誤りは、フォームの上に出す）。 */
const isFieldShown = (field: FieldName, values: ProfileFormValues): boolean => {
  switch (field) {
    case 'startUrl':
    case 'allowedOrigins':
      return values.targetSource === 'NEW';
    case 'targetConfigPath':
      return values.targetSource === 'EXISTING';
    case 'approvedTestOrigins':
      return usesTestEnvironmentFields(values.mode);
    case 'approvedServiceOrigins':
      return usesServiceOrigins(values.mode);
    case 'environmentEvidenceRef':
      return usesEvidenceField(values.environment);
    default:
      return true;
  }
};

/**
 * フォームの値から、保存するプロファイルの文書を作る。T34d: 承認したサービスの Origin は、欄を出すモードで 1 つ以上あるときだけ項目にする（項目の
 * ないプロファイルの digest を変えない）。T43a: 隠した欄の値は送らない（Origin は空、確かめた記録の参照は `null`）。
 */
export const profileDocumentOf = (values: ProfileFormValues, revision: number): SiteProfile => {
  const evidence = usesEvidenceField(values.environment) ? values.environmentEvidenceRef.trim() : '';
  const serviceOrigins = usesServiceOrigins(values.mode) ? linesOf(values.approvedServiceOrigins) : [];
  const profileId = values.profileId.trim();
  return {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId,
    revision,
    // T43b: 新しく作るときは、名前から決まる作るファイルのパス（サーバも同じ部品で決め直す）。
    targetConfigPath: values.targetSource === 'NEW' ? (generatedTargetConfigPathOf(profileId) ?? '') : values.targetConfigPath,
    environment: values.environment,
    mode: values.mode,
    auth: values.auth,
    approvedTestOrigins: usesTestEnvironmentFields(values.mode) ? linesOf(values.approvedTestOrigins) : [],
    environmentEvidenceRef: evidence.length === 0 ? null : evidence,
    ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
  };
};

/** 作成の Server Function の入力（T43b: 新しく作るときは、開始の URL と許可 Origin も送る）。 */
export interface ProfileCreateInput {
  readonly profile: SiteProfile;
  readonly newTargetSite?: TargetSiteInput;
}

/** T43b: フォームの値から、作成の入力を作る（すでにある設定のファイルを使うときは、プロファイルだけ）。 */
export const profileCreateInputOf = (values: ProfileFormValues): ProfileCreateInput => {
  const profile = profileDocumentOf(values, FIRST_REVISION);
  return values.targetSource === 'NEW'
    ? { profile, newTargetSite: { startUrl: values.startUrl.trim(), allowedOrigins: linesOf(values.allowedOrigins) } }
    : { profile };
};

/** 拒否の理由（保存の部品の理由か、T43b の対象の設定のファイルを作れなかった理由）。 */
type RejectionReason = ProfileStoreRejectionReason | TargetConfigCreationFailure;

/** 拒否の結果の表示（項目ごとの誤りと、フォームの上の誤り）。 */
interface RejectionDisplay {
  readonly reason: RejectionReason;
  readonly fieldErrors: Readonly<Partial<Record<FieldName, readonly string[]>>>;
  readonly formErrors: readonly string[];
}

/** 拒否の理由の説明と手順。 */
const rejectionTextOf = (reason: RejectionReason): { readonly description: string; readonly action: string } =>
  isTargetConfigCreationFailure(reason) ? TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS[reason] : PROFILE_STORE_REJECTION_DESCRIPTIONS[reason];

/** T43b: 対象の設定のファイルを作れなかったときの表示（欄の誤りは、開始の URL と許可 Origin の欄に出す）。 */
const siteRejectionDisplayOf = (reason: TargetConfigCreationFailure, siteProblems: readonly TargetSiteProblem[]): RejectionDisplay => {
  const fieldErrors: Partial<Record<FieldName, string[]>> = {};
  for (const problem of new Set(siteProblems)) {
    const field = FIELD_OF_SITE_PROBLEM[problem];
    fieldErrors[field] = [...(fieldErrors[field] ?? []), TARGET_SITE_PROBLEM_DESCRIPTIONS[problem]];
  }
  return { reason, fieldErrors, formErrors: [] };
};

const rejectionDisplayOf = (
  reason: ProfileStoreRejectionReason,
  errorCodes: readonly ProfileValidationErrorCode[],
  configError: ConfigErrorKind | null,
  values: ProfileFormValues,
): RejectionDisplay => {
  const fieldErrors: Partial<Record<FieldName, string[]>> = {};
  const formErrors: string[] = [];
  for (const code of new Set(errorCodes)) {
    const field = FIELD_OF_ERROR_CODE[code];
    const text = PROFILE_VALIDATION_ERROR_DESCRIPTIONS[code];
    // T43a fix round 1: 隠した欄の誤り（例: テストの環境のモードで公開の環境を選んだときの、確かめた記録の参照の誤り）は、フォームの上に出す。
    if (field === null || !isFieldShown(field, values)) {
      formErrors.push(text);
    } else {
      fieldErrors[field] = [...(fieldErrors[field] ?? []), text];
    }
  }
  if (configError !== null) {
    const text = describeConfigError(configError);
    if (isFieldShown('targetConfigPath', values)) {
      fieldErrors.targetConfigPath = [...(fieldErrors.targetConfigPath ?? []), text];
    } else {
      formErrors.push(text);
    }
  }
  return { reason, fieldErrors, formErrors };
};

/** 保存の結果（拒否）の表示。 */
const createRejectionDisplayOf = (result: Extract<ProfileCreateView, { ok: false }>, values: ProfileFormValues): RejectionDisplay =>
  'siteProblems' in result
    ? siteRejectionDisplayOf(result.reason, result.siteProblems)
    : rejectionDisplayOf(result.reason, result.errorCodes, result.configError, values);

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
  /** 保存する（サーバへ送る）。T43b: 作成では、対象の設定のファイルを作れなかった結果も返る。 */
  readonly onSave: (values: ProfileFormValues) => Promise<ProfileCreateView>;
  /** 保存できたとき。 */
  readonly onSaved: (view: Extract<ProfileChangeView, { ok: true }>) => void;
  /** 改訂の衝突のときに、今の内容を読み直す。 */
  readonly onReload: () => void;
}

export function ProfileForm({ kind, initialValues, targetConfigCandidates, onSave, onSaved, onReload }: ProfileFormProps) {
  const text = LOCAL_UI_TEXT.profileForm;
  const [rejection, setRejection] = useState<RejectionDisplay | null>(null);
  // T43b: 利用者が直した欄（直した欄は、その後は開始の URL に追従しない。空に戻すと、また追従する）。
  const edited = useRef({ profileId: false, allowedOrigins: false, approvedTestOrigins: false });
  const form = useForm({
    defaultValues: initialValues,
    onSubmit: async ({ value }) => {
      setRejection(null);
      const result = await onSave(value);
      if (result.ok) {
        onSaved(result);
      } else {
        setRejection(createRejectionDisplayOf(result, value));
      }
    },
  });

  /** T43b: 許可 Origin を、テスト環境の Origin の案に写す（利用者がテスト環境の Origin を直していなければ。欄はテストの環境のモードだけ出る）。 */
  const copyAllowedOriginsToTestOrigins = (allowedOrigins: string): void => {
    if (!edited.current.approvedTestOrigins) {
      form.setFieldValue('approvedTestOrigins', allowedOrigins);
    }
  };

  /** T43b: 開始の URL から、名前と許可 Origin の案を埋める（利用者が直した欄は変えない）。 */
  const fillFromStartUrl = (startUrl: string): void => {
    const draft = profileDraftOf(startUrl);
    if (!edited.current.profileId) {
      form.setFieldValue('profileId', draft.profileId);
    }
    if (!edited.current.allowedOrigins) {
      const allowedOrigins = textOfLines(draft.allowedOrigins);
      form.setFieldValue('allowedOrigins', allowedOrigins);
      copyAllowedOriginsToTestOrigins(allowedOrigins);
    }
  };

  /** 新しく作るときか（開始の URL から埋める欄と、作るファイルの案内を出す）。 */
  const createsTarget = (values: ProfileFormValues): boolean => kind === 'create' && values.targetSource === 'NEW';

  const serverErrorsOf = (field: FieldName): readonly string[] => rejection?.fieldErrors[field] ?? [];
  const clientErrorsOf = (errors: readonly unknown[]): readonly string[] => errors.filter((error): error is string => typeof error === 'string');
  const rejectionText = rejection === null ? null : rejectionTextOf(rejection.reason);

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

      {/* T43b（Task 43 の設計書 4.2）: 作成では、対象の設定の選び方（開始の URL から新しく作る（既定）か、すでにある設定のファイルを使うか）。 */}
      {kind === 'create' ? (
        <form.Field name="targetSource">
          {(field) => (
            <fieldset className="field-group" data-testid="profile-target-source">
              <legend className="field-group-heading">{text.targetSource}</legend>
              {TARGET_SOURCES.map((source) => (
                <label key={source} className="choice">
                  <input
                    type="radio"
                    name={field.name}
                    value={source}
                    checked={field.state.value === source}
                    onChange={() => field.handleChange(source)}
                  />
                  <span>{source === 'NEW' ? text.targetSourceNew : text.targetSourceExisting}</span>
                </label>
              ))}
            </fieldset>
          )}
        </form.Field>
      ) : null}

      {/* T43b: 開始の URL（新しく作るときの最初の欄）。入れると、その場で名前と許可 Origin の案を埋める。 */}
      <form.Subscribe selector={(state) => createsTarget(state.values)}>
        {(creates) => (creates ? (
          <form.Field
            name="startUrl"
            validators={{
              onSubmit: ({ value, fieldApi }) => {
                if (fieldApi.form.getFieldValue('targetSource') !== 'NEW') {
                  return undefined;
                }
                const problem = startUrlProblemOf(value);
                return problem === null ? undefined : TARGET_SITE_PROBLEM_DESCRIPTIONS[problem];
              },
            }}
          >
            {(field) => (
              <FieldFrame label={text.startUrl} hint={text.startUrlHint} errors={[...clientErrorsOf(field.state.meta.errors), ...serverErrorsOf('startUrl')]}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="input"
                    name={field.name}
                    type="url"
                    value={field.state.value}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      fillFromStartUrl(event.target.value);
                    }}
                  />
                )}
              </FieldFrame>
            )}
          </form.Field>
        ) : null)}
      </form.Subscribe>

      <form.Field
        name="profileId"
        validators={{
          onSubmit: ({ value, fieldApi }) => {
            if (value.trim() === '') {
              return text.required;
            }
            if (!PROFILE_ID_PATTERN.test(value.trim())) {
              return PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_ID_INVALID;
            }
            // CC-101（T43R-fix-D2）: 新しく作るときは、Windows の予約名の名前を案の段で拒む（ファイルの名前にできない）。
            return kind === 'create' && fieldApi.form.getFieldValue('targetSource') === 'NEW' && isReservedTargetConfigName(value.trim())
              ? TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS.TARGET_CONFIG_NAME_RESERVED.description
              : undefined;
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
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  edited.current.profileId = event.target.value !== '';
                }}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>

      {/* T43b: 許可 Origin（案を埋めた、直せる一覧）と、保存すると作るファイルの場所。 */}
      <form.Subscribe selector={(state) => createsTarget(state.values)}>
        {(creates) => (creates ? (
          <>
            <form.Field
              name="allowedOrigins"
              validators={{
                onSubmit: ({ value, fieldApi }) => {
                  if (fieldApi.form.getFieldValue('targetSource') !== 'NEW') {
                    return undefined;
                  }
                  const problem = allowedOriginsProblemOf(linesOf(value), fieldApi.form.getFieldValue('startUrl'));
                  return problem === null ? undefined : TARGET_SITE_PROBLEM_DESCRIPTIONS[problem];
                },
              }}
            >
              {(field) => (
                <FieldFrame
                  label={text.allowedOrigins}
                  hint={text.allowedOriginsHint}
                  errors={[...clientErrorsOf(field.state.meta.errors), ...serverErrorsOf('allowedOrigins')]}
                >
                  {({ id, describedBy, invalid }) => (
                    <textarea
                      id={id}
                      className="input"
                      name={field.name}
                      value={field.state.value}
                      spellCheck={false}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        field.handleChange(event.target.value);
                        edited.current.allowedOrigins = event.target.value !== '';
                        copyAllowedOriginsToTestOrigins(event.target.value);
                      }}
                    />
                  )}
                </FieldFrame>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.profileId.trim()}>
              {(profileId) => (
                <div className="field">
                  <span className="field-label">{text.generatedTargetConfig}</span>
                  {/* CC-101（T43R-fix-D2）: Windows の予約名の名前では、場所を示さずに理由を出す。 */}
                  {isReservedTargetConfigName(profileId) ? (
                    <span className="field-error" data-testid="generated-target-config-reserved">
                      {TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS.TARGET_CONFIG_NAME_RESERVED.description}
                    </span>
                  ) : null}
                  {generatedTargetConfigPathOf(profileId) === undefined ? null : (
                    <code data-testid="generated-target-config-path">{generatedTargetConfigPathOf(profileId)}</code>
                  )}
                  <span className="field-hint" data-testid="generated-target-config-note">
                    {text.generatedTargetConfigNote(
                      formatInteger(GENERATED_TARGET_CRAWL_LIMITS.maxPages),
                      formatDuration(GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs),
                    )}
                  </span>
                </div>
              )}
            </form.Subscribe>
          </>
        ) : null)}
      </form.Subscribe>

      <form.Subscribe selector={(state) => !createsTarget(state.values)}>
        {(choosesFile) => (choosesFile ? (
          <form.Field
            name="targetConfigPath"
            validators={{
              onSubmit: ({ value, fieldApi }) =>
                (fieldApi.form.getFieldValue('targetSource') === 'EXISTING' && value === '' ? text.required : undefined),
            }}
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
        ) : null)}
      </form.Subscribe>

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
                  onChange={(event) => {
                    const mode = event.target.value as AuditMode;
                    field.handleChange(mode);
                    // T43a fix round 1（Task 43 の設計書 4.1）: 環境と認証の方式を、組み合わせの表の初めの値に合わせる（利用者は後から変えられる）。
                    const initial = defaultEnvironmentAndAuthOf(mode);
                    form.setFieldValue('environment', initial.environment);
                    form.setFieldValue('auth', initial.auth);
                  }}
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

      {/* T43a（Task 43 の設計書 4.1）: テスト環境の Origin は、テスト環境の 2 つのモードだけ出す（公開のモードでは隠し、値は送らない）。 */}
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (usesTestEnvironmentFields(mode) ? (
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
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      // T43b: 利用者が直した後は、許可 Origin を写さない。
                      edited.current.approvedTestOrigins = event.target.value !== '';
                    }}
                  />
                )}
              </FieldFrame>
            )}
          </form.Field>
        ) : null)}
      </form.Subscribe>

      {/* T34d（Task 34 の設計書 3.1）: 承認したサービスの Origin（テスト環境の 2 つのモードだけ）。 */}
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) => (usesServiceOrigins(mode) ? (
          <form.Field name="approvedServiceOrigins">
            {(field) => (
              <FieldFrame
                label={LOCAL_UI_SCRIPT_LOGIN_TEXT.profile.approvedServiceOrigins}
                hint={LOCAL_UI_SCRIPT_LOGIN_TEXT.profile.approvedServiceOriginsHint(formatCount(MAX_APPROVED_SERVICE_ORIGINS))}
                errors={serverErrorsOf('approvedServiceOrigins')}
              >
                {({ id, describedBy, invalid }) => (
                  <textarea
                    id={id}
                    className="input"
                    name={field.name}
                    value={field.state.value}
                    spellCheck={false}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </FieldFrame>
            )}
          </form.Field>
        ) : null)}
      </form.Subscribe>

      {/* T43a fix round 1（設計者の判断 3）: 確かめた記録の参照は、環境がテスト環境のときに出す（公開のモードでも出して送る。公開の環境では隠し、
          値は送らない）。 */}
      <form.Subscribe selector={(state) => state.values.environment}>
        {(environment) => (usesEvidenceField(environment) ? (
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
        ) : null)}
      </form.Subscribe>

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
