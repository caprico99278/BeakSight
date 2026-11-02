/**
 * プロファイルの登録・編集のフォーム（Task 23 設計書 4.7。TanStack Form）。
 * - 画面の側の確かめ（必須、名前の形）は補助だけ。保存の前に、サーバが Task 22 の検証を行い、誤りのコードを返す。
 * - 誤りは、項目ごとに日本語で出す（`PROFILE_VALIDATION_ERROR_DESCRIPTIONS`、`PROFILE_STORE_REJECTION_DESCRIPTIONS`、設定の誤りの説明）。
 * - T25e: 認証つきの読み取りの監査（認証の設定が要るモード）を選んだときは、保存した後に認証の設定を作ってから始めることを案内する。
 * - MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 作成の画面に見える入力は、開始の URL、使い方の 2 択、テスト環境の
 *   ときの隔離の扱いの 2 択（「確かめた記録がある」のときだけ参照の欄）、保存のボタン、の 4 つだけ。名前・対象の設定の選び方・許可 Origin・設定の
 *   ファイル・環境・監査モード・認証の方式・テスト環境の Origin は、その下のたたんだ「詳しい設定」（`AdvancedSettings`）の中に置く。詳しい設定の欄は、
 *   空のまま（選び方は「開始の URL から決める」のまま）なら項目を送らず、隠す値はサーバの作成の流れ（`target-config-writer.ts` の
 *   `createProfileFromRequest`）が決める（画面とサーバの 2 か所に同じ判断を書かない）。直した欄だけ、その値を送る。承認したサービスの Origin の欄は、
 *   作成の画面には出さない（利用者は知りえない。手動のログインの観察だけが足す）。
 * - MI-2（同 4.2）: テスト環境のときは、保存のボタンが「保存して入口を確かめる」になり、下に、開始の URL を 1 回だけ読むことを示す（入口の確かめを
 *   始めるのは呼び出し側の `onSaved`。`routes/profiles/new.tsx`）。
 * - 編集（プロファイルの詳細の「詳しい設定」の中）: 今の全部の欄（名前は変えられない）。承認したサービスの Origin は、読むだけの一覧と「消す」だけ
 *   （足す欄はない）。T34d: 承認したサービスの Origin は、テスト環境の 2 つのモードで 1 つ以上あるときだけプロファイルの項目にする（項目のない
 *   プロファイルの digest を変えない）。誤りの 2 つのコードは、この一覧に出す。
 * - MI-1 の D: 書き込みのモードの「監査を始められない」の案内（MI-5 で監査を始められるようになり、出なくなった）は消した。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 6 章の 1、4 章。作業記録 UX-1 の画面 A の 4.2）: 作成の画面の見える入力は、開始の
 *   アドレス・使い方の 2 択・「保存して入口を確かめる」の 3 つだけ。隔離の扱いの 2 択は作成から外した（参照は、保存した日の未確認の形で、サーバの作成の流れが
 *   作る。確かめた記録の参照は「書き込みも試す」の確認で選ぶ。PL-5）。たたんだ「詳しい設定」の 8 欄（名前・選び方・許可 Origin・設定のファイル・環境・監査
 *   モード・認証の方式・テスト環境の Origin）も消した: どれもサーバが開始のアドレスと使い方から決め、人が選ぶ要るのは、同じサイトの設定のファイルが複数ある・
 *   別の開始のアドレスのものだけのとき（保存の拒否）だけなので、その選択を拒否の知らせの中に出す（候補のファイルか、新しく作るか。欄は増やさない）。
 *   編集の画面（サイトの画面の詳しい内容の中）は今のまま（保存のボタンは、詳しい内容の中なので二次の見た目）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { useServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import {
  isTargetConfigCreationFailure,
  startUrlProblemOf,
  type TargetSiteInput,
  type TargetSiteProblem,
} from '../../../../src/config/target-config-draft.js';
import {
  MANUAL_EVERY_TIME_LOGIN_PREFERENCE,
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  SITE_PROFILE_SCHEMA_VERSION,
  loginPreferenceOf,
  type AuditMode,
  type AuthStrategy,
  type EnvironmentKind,
  type ProfileValidationErrorCode,
  type SiteProfile,
} from '../../../../src/control/contracts.js';
import type { ProfileStoreRejectionReason } from '../../../../src/control/store/profile-store.js';
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
  PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS,
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
  type SelectOption,
} from '../display/labels';
import { linesOf, textOfLines } from '../display/form-lines';
import { profileDraftOf } from '../display/start-url-draft';
import { PROFILE_SAVE_GUARD_REJECTIONS, type ProfileSaveGuardRejection } from '../../../../src/control/auth/credential-destination.js';
import {
  checkTargetConfigFn,
  TARGET_CONFIG_START_URL_MISMATCH_REASON,
  type ProfileChangeView,
  type ProfileCreateView,
  type ProfileTargetChoice,
} from '../server/profile-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

/**
 * T43b: 対象の設定の選び方。MI-1: 作成の既定は `AUTO`（開始の URL から決める。同じサイトで開始の URL も同じ設定のファイルが 1 つあれば使い、同じ
 * サイトのファイルがなければ新しく作る。決めるのはサーバ）。`NEW`（開始の URL から新しく作る）と `EXISTING`（すでにある設定のファイルを使う）は、
 * 詳しい設定で選ぶ。編集では `EXISTING`。MI-C: 値は作成の入力の明示の項目 `targetChoice`（型はサーバの `ProfileTargetChoice`。ここに写さない）。
 */
export type TargetSource = ProfileTargetChoice;

/** MI-1: 使い方の 2 択（ログインして読む（テスト環境）・公開の画面だけ）。 */
export type ProfileUsage = 'TEST_AUTH' | 'PUBLIC';

/** 使い方の順（画面の選択肢の順。先頭が既定）。 */
const PROFILE_USAGES: readonly ProfileUsage[] = Object.freeze(['TEST_AUTH', 'PUBLIC']);

/**
 * 使い方ごとの監査モード。環境と認証の方式は、組み合わせの表の初めの値（`defaultEnvironmentAndAuthOf`。`TEST`・`MANUAL_SESSION` と `PUBLIC`・`NONE`）。
 * 組み合わせをここに写さない。
 */
const USAGE_MODES: Readonly<Record<ProfileUsage, AuditMode>> = Object.freeze({ TEST_AUTH: 'TEST_AUTH_PASSIVE', PUBLIC: 'PUBLIC_PASSIVE' });

/** フォームの値（画面の入力のまま）。 */
export interface ProfileFormValues {
  /** T43b: 対象の設定の選び方（編集では `EXISTING`。PL-1: 作成では、保存の拒否の知らせの中の選択だけが変える）。 */
  readonly targetSource: TargetSource;
  /** T43b: 開始の URL（作成で、`EXISTING` でないときだけ使う）。 */
  readonly startUrl: string;
  /** T43b: 許可 Origin（1 行に 1 つ。`NEW` のときだけ使う。空なら開始の URL の Origin）。 */
  readonly allowedOrigins: string;
  /** 名前（作成では、空ならサーバが開始の URL から決める）。 */
  readonly profileId: string;
  /** すでにある設定のファイル（`EXISTING` のときだけ使う）。 */
  readonly targetConfigPath: string;
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** 1 行に 1 つ（作成では、空ならサーバが決める）。 */
  readonly approvedTestOrigins: string;
  /** T34d: 承認したサービスの Origin（1 行に 1 つ。編集で、テスト環境の 2 つのモードだけ一覧を出す。足す欄はない）。 */
  readonly approvedServiceOrigins: string;
  /** 確かめた記録の参照（編集だけ。PL-1: 作成では送らず、サーバが保存した日の未確認の参照を作る）。 */
  readonly environmentEvidenceRef: string;
  /**
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5、4.1.3 の 2）: 「毎回手でログインする」（編集だけ。ログインの設定を使うモードだけ送る）。
   * 入れると `loginPreference: 'MANUAL_EVERY_TIME'` を保存する。
   */
  readonly manualLoginEveryTime: boolean;
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
  // T34d: 承認したサービスの Origin の一覧。
  PROFILE_SERVICE_ORIGIN_INVALID: 'approvedServiceOrigins',
  PROFILE_SERVICE_ORIGIN_INSIDE_TARGET: 'approvedServiceOrigins',
  // PL-F 修正の 1 回目: 確かめた記録の参照が秘密に見える。
  ISOLATION_REFERENCE_SECRET_LIKE: 'environmentEvidenceRef',
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

/** 新しいプロファイルの初めの値（MI-1: 使い方は「ログインして読む（テスト環境）」、選び方は「開始の URL から決める」）。 */
export const EMPTY_PROFILE_FORM: ProfileFormValues = Object.freeze({
  targetSource: 'AUTO',
  startUrl: '',
  allowedOrigins: '',
  profileId: '',
  targetConfigPath: '',
  mode: USAGE_MODES.TEST_AUTH,
  ...defaultEnvironmentAndAuthOf(USAGE_MODES.TEST_AUTH),
  approvedTestOrigins: '',
  approvedServiceOrigins: '',
  environmentEvidenceRef: '',
  manualLoginEveryTime: false,
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
  manualLoginEveryTime: loginPreferenceOf(profile) === MANUAL_EVERY_TIME_LOGIN_PREFERENCE,
});

// 1 行に 1 つの欄の読み方と書き方は、`display/form-lines.ts` の `linesOf`・`textOfLines`（T43b fix round 1）。

/**
 * テスト環境の Origin と承認したサービスの Origin の欄を出すモードか（テスト環境の 2 つのモード。判定は組み合わせの表の owner
 * `profile-combinations.ts` の `TEST_ORIGIN_MODES`。T43a fix round 1 で、認証の設定が要るモードでの代用をやめた）。公開のモードでは、この 2 つの欄を
 * 隠し、隠した欄の値は送らない（保存の検証は今のまま。Task 43 の設計書 4.1）。
 */
export const usesTestEnvironmentFields = (mode: AuditMode): boolean => TEST_ORIGIN_MODES.includes(mode);

/** T34d: 承認したサービスの Origin の一覧を出すモードか（テスト環境の Origin の欄と同じ）。 */
export const usesServiceOrigins = (mode: AuditMode): boolean => usesTestEnvironmentFields(mode);

/**
 * 確かめた記録の参照（MI-1 の作成では隔離の扱いの 2 択）を出すか（T43a fix round 1。設計者の判断 3）。モードではなく、環境で決める（公開のモードでも、
 * 環境がテスト環境なら出して送る）。判定は `profile-combinations.ts` の `environmentAcceptsEvidence`。
 */
export const usesEvidenceField = (environment: EnvironmentKind): boolean => environmentAcceptsEvidence(environment);

/** 作成の画面か、編集の画面か。 */
type FormKind = 'create' | 'edit';

/** 欄が今の値で出ているか（出ていない欄の、保存の検証の誤りは、フォームの上に出す）。PL-1: 作成の画面の欄は、開始の URL だけ（使い方は 2 択）。 */
const isFieldShown = (field: FieldName, values: ProfileFormValues, kind: FormKind): boolean => {
  if (kind === 'create') {
    return field === 'startUrl';
  }
  switch (field) {
    case 'startUrl':
    case 'allowedOrigins':
      return false;
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
 * フォームの値から、保存するプロファイルの文書を作る（編集）。T34d: 承認したサービスの Origin は、一覧を出すモードで 1 つ以上あるときだけ項目にする
 * （項目のないプロファイルの digest を変えない）。T43a: 隠した欄の値は送らない（Origin は空、確かめた記録の参照は `null`）。
 */
export const profileDocumentOf = (values: ProfileFormValues, revision: number): SiteProfile => {
  const evidence = usesEvidenceField(values.environment) ? values.environmentEvidenceRef.trim() : '';
  const serviceOrigins = usesServiceOrigins(values.mode) ? linesOf(values.approvedServiceOrigins) : [];
  return {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: values.profileId.trim(),
    revision,
    targetConfigPath: values.targetConfigPath,
    environment: values.environment,
    mode: values.mode,
    auth: values.auth,
    approvedTestOrigins: usesTestEnvironmentFields(values.mode) ? linesOf(values.approvedTestOrigins) : [],
    environmentEvidenceRef: evidence.length === 0 ? null : evidence,
    ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
    // OP-1: 「毎回手でログインする」は、ログインの設定を使うモードで入れたときだけ項目にする（外せば省く。省けば自動ログイン）。
    ...(values.manualLoginEveryTime && requiresAuthSetup(values.mode) ? { loginPreference: MANUAL_EVERY_TIME_LOGIN_PREFERENCE } : {}),
  };
};

/**
 * 作成の Server Function の入力（スキーマ `ui-profile-create`。T43b: 新しく作るか自動で決めるときは、開始の URL と許可 Origin も送る）。MI-1: `profile`
 * は、送らなかった項目をサーバが決める下書き（中身は保存の前にサーバが `validateSiteProfile` で確かめる）。MI-C: 対象の設定の選び方は、明示の項目
 * `targetChoice` で送る。
 */
export interface ProfileCreateInput {
  readonly targetChoice: TargetSource;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly newTargetSite?: TargetSiteInput;
}

/**
 * MI-1: フォームの値から、作成の入力を作る。空の名前・空のテスト環境の Origin と、テスト環境の確かめた記録の参照は、項目を送らない（サーバの
 * `createProfileFromRequest` が決める。PL-1: 参照は、いつも保存した日の未確認の形）。MI-C: 対象の設定の選び方は `targetChoice` で示し、設定のファイルのパスの項目は
 * `EXISTING` のときだけ送る（`NEW` の印に使わない。作るファイルの場所は、サーバが名前から決める）。
 */
export const profileCreateInputOf = (values: ProfileFormValues): ProfileCreateInput => {
  const profileId = values.profileId.trim();
  const testOrigins = linesOf(values.approvedTestOrigins);
  const testOriginsItem = (): Readonly<Record<string, unknown>> => {
    if (!usesTestEnvironmentFields(values.mode)) {
      return { approvedTestOrigins: [] };
    }
    return testOrigins.length === 0 ? {} : { approvedTestOrigins: testOrigins };
  };
  const evidenceItem = (): Readonly<Record<string, unknown>> => (usesEvidenceField(values.environment) ? {} : { environmentEvidenceRef: null });
  const profile = {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    revision: FIRST_REVISION,
    ...(profileId === '' ? {} : { profileId }),
    ...(values.targetSource === 'EXISTING' ? { targetConfigPath: values.targetConfigPath } : {}),
    environment: values.environment,
    mode: values.mode,
    auth: values.auth,
    ...testOriginsItem(),
    ...evidenceItem(),
  };
  if (values.targetSource === 'EXISTING') {
    return { targetChoice: values.targetSource, profile };
  }
  const startUrl = values.startUrl.trim();
  const allowedOrigins = values.targetSource === 'NEW' ? linesOf(values.allowedOrigins) : [];
  return {
    targetChoice: values.targetSource,
    profile,
    newTargetSite: { startUrl, allowedOrigins: allowedOrigins.length === 0 ? profileDraftOf(startUrl).allowedOrigins : allowedOrigins },
  };
};

/** 拒否の結果の表示（理由の説明と手順、項目ごとの誤り、フォームの上の誤り、候補の設定のファイル）。 */
interface RejectionDisplay {
  /** 拒否の理由（改訂の衝突のときだけ、読み直しのボタンを出す）。 */
  readonly reason: string;
  /** 説明と手順。 */
  readonly text: { readonly description: string; readonly action: string };
  readonly fieldErrors: Readonly<Partial<Record<FieldName, readonly string[]>>>;
  readonly formErrors: readonly string[];
  /**
   * MI-1: 同じサイトの設定のファイルが複数あったとき（MI-C: 同じサイトのファイルが別の開始の URL だったときも）の、その一覧（PL-1: 知らせの中で、使うファイルか
   * 新しく作るかを選ぶ）。
   */
  readonly candidates: readonly string[];
}

/** 改訂の衝突（読み直しのボタンを出す）。 */
const REVISION_CONFLICT: ProfileStoreRejectionReason = 'PROFILE_REVISION_CONFLICT';

/** T43b: 対象の設定のファイルを作れなかったときの表示（欄の誤りは、開始の URL と許可 Origin の欄に出す）。 */
const siteRejectionDisplayOf = (
  result: Extract<ProfileCreateView, { readonly siteProblems: readonly TargetSiteProblem[] }>,
  values: ProfileFormValues,
): RejectionDisplay => {
  const fieldErrors: Partial<Record<FieldName, string[]>> = {};
  const formErrors: string[] = [];
  for (const problem of new Set(result.siteProblems)) {
    const field = FIELD_OF_SITE_PROBLEM[problem];
    const text = TARGET_SITE_PROBLEM_DESCRIPTIONS[problem];
    // MI-1: 「開始の URL から決める」では許可 Origin の欄を出さないので、その誤りはフォームの上に出す。
    if (isFieldShown(field, values, 'create')) {
      fieldErrors[field] = [...(fieldErrors[field] ?? []), text];
    } else {
      formErrors.push(text);
    }
  }
  const reason = result.reason;
  const text = isTargetConfigCreationFailure(reason) ? TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS[reason] : PROFILE_STORE_REJECTION_DESCRIPTIONS[reason];
  return { reason, text, fieldErrors, formErrors, candidates: [] };
};

const rejectionDisplayOf = (
  reason: ProfileStoreRejectionReason,
  errorCodes: readonly ProfileValidationErrorCode[],
  configError: ConfigErrorKind | null,
  values: ProfileFormValues,
  kind: FormKind,
): RejectionDisplay => {
  const fieldErrors: Partial<Record<FieldName, string[]>> = {};
  const formErrors: string[] = [];
  for (const code of new Set(errorCodes)) {
    const field = FIELD_OF_ERROR_CODE[code];
    const text = PROFILE_VALIDATION_ERROR_DESCRIPTIONS[code];
    // T43a fix round 1: 隠した欄の誤り（例: テストの環境のモードで公開の環境を選んだときの、確かめた記録の参照の誤り）は、フォームの上に出す。
    if (field === null || !isFieldShown(field, values, kind)) {
      formErrors.push(text);
    } else {
      fieldErrors[field] = [...(fieldErrors[field] ?? []), text];
    }
  }
  if (configError !== null) {
    const text = describeConfigError(configError);
    if (isFieldShown('targetConfigPath', values, kind)) {
      fieldErrors.targetConfigPath = [...(fieldErrors.targetConfigPath ?? []), text];
    } else {
      formErrors.push(text);
    }
  }
  return { reason, text: PROFILE_STORE_REJECTION_DESCRIPTIONS[reason], fieldErrors, formErrors, candidates: [] };
};

/** MI-F1: 画面のサーバの口の拒否の理由か。 */
const isProfileSaveGuardRejection = (reason: string): reason is ProfileSaveGuardRejection =>
  (PROFILE_SAVE_GUARD_REJECTIONS as readonly string[]).includes(reason);

/** 保存の結果（拒否）の表示。 */
const createRejectionDisplayOf = (result: Extract<ProfileCreateView, { ok: false }>, values: ProfileFormValues, kind: FormKind): RejectionDisplay => {
  // MI-F1（設計書 4.7.1 の 1・2）: 画面のサーバの口が拒んだ（承認したサービスの Origin を足す、自動ログインにする。何も保存していない）。
  if (isProfileSaveGuardRejection(result.reason)) {
    return { reason: result.reason, text: PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS[result.reason], fieldErrors: {}, formErrors: [], candidates: [] };
  }
  if ('candidates' in result) {
    const text = result.reason === TARGET_CONFIG_START_URL_MISMATCH_REASON
      ? LOCAL_UI_TEXT.profileForm.targetConfigStartUrlMismatch
      : LOCAL_UI_TEXT.profileForm.targetConfigAmbiguous;
    return { reason: result.reason, text, fieldErrors: {}, formErrors: [], candidates: result.candidates };
  }
  return 'siteProblems' in result
    ? siteRejectionDisplayOf(result, values)
    : rejectionDisplayOf(result.reason, result.errorCodes, result.configError, values, kind);
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

/** 使い方の名前。 */
const USAGE_LABELS: Readonly<Record<ProfileUsage, string>> = Object.freeze({
  TEST_AUTH: LOCAL_UI_TEXT.profileForm.usageTestAuth,
  PUBLIC: LOCAL_UI_TEXT.profileForm.usagePublic,
});

/** PL-1: 保存の拒否の知らせの中の、対象の設定の選択の radio の名前（入力を変えたときの拒否の消し方で、この選択だけは除く）。 */
const TARGET_CHOICE_INPUT_NAME = 'targetChoice';

/** フォームの指定。 */
export interface ProfileFormProps {
  /** 新しく作るか、既にあるものを編集するか（編集では名前を変えられない）。 */
  readonly kind: FormKind;
  readonly initialValues: ProfileFormValues;
  /** 設定のファイルの候補（リポジトリの root からの相対パス。編集の選択肢）。 */
  readonly targetConfigCandidates: readonly string[];
  /** 保存する（サーバへ送る）。T43b: 作成では、対象の設定のファイルを作れなかった結果も返る。 */
  readonly onSave: (values: ProfileFormValues) => Promise<ProfileCreateView>;
  /** 保存できたとき（MI-2: 作成では、続けて入口の確かめを始める。終わるまで保存のボタンは押せない）。 */
  readonly onSaved: (view: Extract<ProfileChangeView, { ok: true }>) => void | Promise<void>;
  /** 改訂の衝突のときに、今の内容を読み直す。 */
  readonly onReload: () => void;
}

export function ProfileForm({ kind, initialValues, targetConfigCandidates, onSave, onSaved, onReload }: ProfileFormProps) {
  const text = LOCAL_UI_TEXT.profileForm;
  const creating = kind === 'create';
  const [rejection, setRejection] = useState<RejectionDisplay | null>(null);
  const form = useForm({
    defaultValues: initialValues,
    onSubmit: async ({ value }) => {
      setRejection(null);
      const result = await onSave(value);
      if (result.ok) {
        await onSaved(result);
      } else {
        setRejection(createRejectionDisplayOf(result, value, kind));
      }
    },
  });

  /** 監査モードを選ぶ（T43a fix round 1: 環境と認証の方式を、組み合わせの表の初めの値に合わせる。利用者は後から変えられる）。 */
  const chooseMode = (mode: AuditMode): void => {
    form.setFieldValue('mode', mode);
    const initial = defaultEnvironmentAndAuthOf(mode);
    form.setFieldValue('environment', initial.environment);
    form.setFieldValue('auth', initial.auth);
  };

  const serverErrorsOf = (field: FieldName): readonly string[] => rejection?.fieldErrors[field] ?? [];
  const clientErrorsOf = (errors: readonly unknown[]): readonly string[] => errors.filter((error): error is string => typeof error === 'string');

  // ---------------------------------------------------------------------------------------------------------------
  // 欄（作成と編集で同じ部品を使う）
  // ---------------------------------------------------------------------------------------------------------------

  /** 開始の URL（作成だけ。PL-1: 拒否の知らせの中で既にあるファイルを選んでも、入れた値は見えたまま）。 */
  const startUrlField = creating ? (
    <form.Field
      name="startUrl"
      validators={{
        onSubmit: ({ value, fieldApi }) => {
          if (fieldApi.form.getFieldValue('targetSource') === 'EXISTING') {
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
              onChange={(event) => field.handleChange(event.target.value)}
            />
          )}
        </FieldFrame>
      )}
    </form.Field>
  ) : null;

  /** MI-1: 使い方の 2 択（環境・監査モード・認証の方式を、組み合わせの表の初めの値にする）。 */
  const usageField = (
    <form.Subscribe selector={(state) => state.values.mode}>
      {(mode) => (
        <fieldset className="field-group" data-testid="profile-usage">
          <legend className="field-group-heading">{text.usage}</legend>
          {PROFILE_USAGES.map((usage) => (
            <label key={usage} className="choice">
              <input type="radio" name="usage" value={usage} checked={mode === USAGE_MODES[usage]} onChange={() => chooseMode(USAGE_MODES[usage])} />
              <span>{USAGE_LABELS[usage]}</span>
            </label>
          ))}
        </fieldset>
      )}
    </form.Subscribe>
  );

  /**
   * PL-1: 保存の拒否の知らせの中の、対象の設定の選択（同じサイトの設定のファイルが複数ある・別の開始のアドレスのものだけのとき）。候補のファイルを使うか、
   * 開始のアドレスから新しく作るかを選び、もう一度保存する（選び方の値は `targetSource`・`targetConfigPath`。送り方は `profileCreateInputOf`）。
   */
  const targetChoiceField = (candidates: readonly string[]) => (
    <form.Subscribe selector={(state) => (state.values.targetSource === 'EXISTING' ? state.values.targetConfigPath : state.values.targetSource)}>
      {(chosen) => (
        <fieldset className="field-group" data-testid="profile-target-choice">
          <legend className="field-group-heading">{text.targetChoice}</legend>
          {candidates.map((path) => (
            <label key={path} className="choice">
              <input
                type="radio"
                name={TARGET_CHOICE_INPUT_NAME}
                value={path}
                checked={chosen === path}
                onChange={() => {
                  form.setFieldValue('targetSource', 'EXISTING');
                  form.setFieldValue('targetConfigPath', path);
                }}
              />
              <span><code>{path}</code></span>
            </label>
          ))}
          <label className="choice">
            <input
              type="radio"
              name={TARGET_CHOICE_INPUT_NAME}
              value="NEW"
              checked={chosen === 'NEW'}
              onChange={() => {
                form.setFieldValue('targetSource', 'NEW');
                form.setFieldValue('targetConfigPath', '');
              }}
            />
            <span>{text.targetSourceNew}</span>
          </label>
        </fieldset>
      )}
    </form.Subscribe>
  );

  const evidenceInput = (
    <form.Field name="environmentEvidenceRef">
      {(field) => (
        <FieldFrame
          label={text.environmentEvidenceRef}
          hint={text.environmentEvidenceRefHint}
          errors={[...clientErrorsOf(field.state.meta.errors), ...serverErrorsOf('environmentEvidenceRef')]}
        >
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
  );

  /** 編集の名前（読むだけ。保存した後は変えられない）。 */
  const profileIdField = (
    <form.Field
      name="profileId"
      validators={{
        onSubmit: ({ value }) => {
          const trimmed = value.trim();
          if (trimmed === '') {
            return text.required;
          }
          return PROFILE_ID_PATTERN.test(trimmed) ? undefined : PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_ID_INVALID;
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
              readOnly
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
  );

  const targetConfigPathField = (
    <form.Field
      name="targetConfigPath"
      validators={{
        onSubmit: ({ value }) => (value === '' ? text.required : undefined),
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
  );

  const environmentField = (
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
  );

  const modeField = (
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
                onChange={(event) => chooseMode(event.target.value as AuditMode)}
              >
                {selectOptions(AUDIT_MODE_OPTIONS)}
              </select>
            )}
          </FieldFrame>
          {requiresAuthSetup(field.state.value) ? (
            <Notice kind="caution">
              <p data-testid="profile-auth-setup-notice">{LOCAL_UI_AUTH_TEXT.profileFormNotice}</p>
            </Notice>
          ) : null}
        </>
      )}
    </form.Field>
  );

  /** 編集の認証の方式（全部の方式。手動のログインへ戻す道に要る。自動ログインにする保存はサーバが拒む。MI-F1）。 */
  const authField = (
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
  );

  /** T43a（Task 43 の設計書 4.1）: テスト環境の Origin は、テスト環境の 2 つのモードだけ出す（公開のモードでは隠し、値は送らない）。 */
  const testOriginsField = (
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
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </FieldFrame>
          )}
        </form.Field>
      ) : null)}
    </form.Subscribe>
  );

  /**
   * MI-1（設計書 4.2）: 編集の、承認したサービスの Origin（テスト環境の 2 つのモードだけ）。読むだけの一覧と「消す」だけ（足す欄はない。手動のログインの
   * 観察だけが足す）。消した結果は、保存したときに次の改訂になる。
   */
  const serviceOriginsList = (
    <form.Subscribe selector={(state) => (usesServiceOrigins(state.values.mode) ? state.values.approvedServiceOrigins : null)}>
      {(originsText) => {
        if (originsText === null) {
          return null;
        }
        const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT.profile;
        const origins = linesOf(originsText);
        const errors = serverErrorsOf('approvedServiceOrigins');
        return (
          <div className="field" data-testid="profile-service-origins">
            <span className="field-label">{scriptText.approvedServiceOrigins}</span>
            <span className="field-hint">{scriptText.approvedServiceOriginsHint}</span>
            {origins.length === 0 ? <p data-testid="profile-service-origins-none">{scriptText.approvedServiceOriginsNone}</p> : (
              <ul className="word-list">
                {origins.map((origin) => (
                  <li key={origin} data-testid="profile-service-origin">
                    <code>{origin}</code>{' '}
                    <button
                      type="button"
                      className="button"
                      aria-label={scriptText.removeServiceOriginLabel(origin)}
                      onClick={() => {
                        setRejection(null);
                        form.setFieldValue('approvedServiceOrigins', textOfLines(origins.filter((other) => other !== origin)));
                      }}
                    >
                      {scriptText.removeServiceOrigin}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {errors.length > 0 ? <span className="field-error">{errors.join(' ')}</span> : null}
          </div>
        );
      }}
    </form.Subscribe>
  );

  /** 編集の、確かめた記録の参照（T43a fix round 1。設計者の判断 3: 環境がテスト環境のときに出す。公開のモードでも出して送る）。 */
  const editEvidenceField = (
    <form.Subscribe selector={(state) => usesEvidenceField(state.values.environment)}>
      {(shown) => (shown ? evidenceInput : null)}
    </form.Subscribe>
  );

  /** OP-1（D5）: 編集の「毎回手でログインする」の切り替え（ログインの設定を使うモードだけ）。 */
  const manualLoginEveryTimeField = (
    <form.Subscribe selector={(state) => requiresAuthSetup(state.values.mode)}>
      {(shown) => (shown ? (
        <form.Field name="manualLoginEveryTime">
          {(field) => (
            <p className="field">
              <label>
                <input
                  type="checkbox"
                  name={field.name}
                  checked={field.state.value}
                  data-testid="profile-manual-login-every-time"
                  aria-describedby="profile-manual-login-every-time-hint"
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {' '}
                {text.manualLoginEveryTime}
              </label>
              <span className="field-hint" id="profile-manual-login-every-time-hint">{text.manualLoginEveryTimeHint}</span>
            </p>
          )}
        </form.Field>
      ) : null)}
    </form.Subscribe>
  );

  const saveButton: ReactNode = (
    <form.Subscribe selector={(state) => [state.isSubmitting, requiresAuthSetup(state.values.mode)] as const}>
      {([isSubmitting, logsIn]) => (
        <div className="field">
          <div className="button-row">
            {/* PL-1: 作成の保存は画面の主のボタン。編集の保存は、サイトの画面の詳しい内容の中なので二次の見た目（主のボタンは要点のパネルの 1 つ）。 */}
            {/* OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11、4.1.3 の 3）と、その修正の 2 回目（設計者の判断「公開のサイトも点検を始める
                1 つ」）: 作成の画面のボタンは、どちらの使い方でも「点検を始める」1 つ（保存 → 下調べ → 点検。`routes/profiles/new.tsx`）。説明は、ログインが要る
                サイトのときだけ、ログインの文を含む。 */}
            <button type="submit" className={creating ? 'button button--primary' : 'button'} disabled={isSubmitting}>
              {isSubmitting ? text.saving : (creating ? text.saveAndCheckEntry : text.save)}
            </button>
          </div>
          {creating ? (
            <span className="field-hint" data-testid="profile-save-entry-check-note">
              {logsIn ? text.saveAndCheckEntryNote : text.saveAndCheckEntryNotePublic}
            </span>
          ) : null}
        </div>
      )}
    </form.Subscribe>
  );

  return (
    <form
      className="form-grid"
      noValidate
      onChange={(event) => {
        // 入力を変えたら、前の保存の拒否の表示を消す（直した後に古い誤りを出し続けない）。PL-1: 拒否の知らせの中の対象の設定の選択は除く（選んでから保存し
        // 直す）。ほかの入力を変えたら、その選択も初めの「開始の URL から決める」に戻す。
        if (rejection === null || (event.target as { name?: unknown }).name === TARGET_CHOICE_INPUT_NAME) {
          return;
        }
        setRejection(null);
        if (creating) {
          form.setFieldValue('targetSource', initialValues.targetSource);
          form.setFieldValue('targetConfigPath', initialValues.targetConfigPath);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {rejection === null ? null : (
        <Notice kind="critical" heading={text.rejectedHeading}>
          <p>{rejection.text.description}</p>
          {rejection.formErrors.map((error) => <p key={error}>{error}</p>)}
          {rejection.candidates.length === 0 ? null : (
            <div data-testid="profile-target-config-ambiguous" data-reason={rejection.reason}>
              {targetChoiceField(rejection.candidates)}
            </div>
          )}
          <p>{rejection.text.action}</p>
          {rejection.reason === REVISION_CONFLICT ? (
            <div className="button-row">
              <button type="button" className="button" onClick={onReload}>{LOCAL_UI_TEXT.reload}</button>
            </div>
          ) : null}
        </Notice>
      )}

      {creating ? (
        <>
          {/* PL-1（設計書 6 章の 1）: 見える入力は、開始のアドレス・使い方・保存の 3 つ。ほかの値はサーバが決める。 */}
          {startUrlField}
          {usageField}
          {saveButton}
        </>
      ) : (
        <>
          {profileIdField}
          {targetConfigPathField}
          {environmentField}
          {modeField}
          {authField}
          {testOriginsField}
          {serviceOriginsList}
          {editEvidenceField}
          {manualLoginEveryTimeField}
          {saveButton}
        </>
      )}
    </form>
  );
}

/** 新しいプロファイルの最初の改訂。 */
export const FIRST_REVISION = MIN_PROFILE_REVISION;
