/**
 * 開始の画面に出す、開始できない理由の確かめ（Task 24 の設計書 4.8 の T24f で `audit-job-functions.ts` の中に作り、T25e で認証の設定の確かめを
 * 足して、入出力を持たない部品に切り出した）。
 * - 判断の順と判定は、ジョブの管理の開始の直前の確かめ（`startAuditJob`）と同じ: 取り消し → 今実行できるモード → 今実行できる認証の方式 →
 *   認証の設定がない → 古い（`STALE`）→ ターゲット設定のパス → 読めない → プロファイルの検証 → 認証の設定の検証。判定は、それぞれの owner
 *   （`execution-policy.ts`、`isAcceptedTargetConfigPath` は呼び出し側、`validateSiteProfile`、`validateAuthSetup`）を呼ぶだけ。
 * - 画面の表示の確かめは補助だけ。開始を受けるかどうかは、ジョブの管理が開始の直前に決める（I08）。
 * - 管理データもファイルも読まない（呼び出し側が、読んだ値を渡す）。
 * - T25e round 1: ジョブの管理の開始の拒否（`AuditJobStartResult`）を、画面に返す値にする部品（`startRejectionViewOf`）も置く。
 *   `AUTH_SETUP_INVALID` のときは、ジョブの管理が返した認証の設定の検証の誤りを、コードと項目と行にする（英語の詳細は返さない）。
 * - T26e（Task 26 の設計書 4.5、4.6。T26d-2 の発見事項 3）: 自動ログインのプロファイルでは、認証の設定の検証の後に、ジョブの管理と同じ開始の前の
 *   確かめ（資格情報のメタデータ、暗号化が使えるか、上限）を行う（判定は `checkAutoLoginStart`。上限の判定 `decideAutoLoginStart` の結果は呼び出し側
 *   が読んで渡す。値は読まない）。ログインの確かめ（`LOGIN_CHECK`）の画面では、ジョブの管理と同じく、自動ログインでないプロファイルを
 *   `AUTH_STRATEGY_NOT_EXECUTABLE` で止める。上限で止めるときは、次に始められる日時（ISO 8601）も返す。
 * - T27f（Task 27 の設計書 4.7）: 操作の候補の発見（`DISCOVERY`）と READ の確かめ（`READ_CHECK`）の画面では、ジョブの管理と同じく、認証の設定が
 *   要るモードでないプロファイルを `MODE_NOT_EXECUTABLE` で止め、READ の確かめは、取り消していない定義が 0 件なら `READ_CHECK_DEFINITIONS_MISSING`
 *   で止める（認証の設定の確かめの前。定義の数は呼び出し側が読んで渡す）。
 * - T28b（Task 28 の設計書 4.5）: モードと認証の方式の確かめを、ジョブの管理と同じ 1 つの判定（`execution-policy.ts` の
 *   `profileOperationRejectionOf`）にした。書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルでも、発見・READ の確かめ・（自動ログインなら）
 *   ログインの確かめは、認証つきの読み取りの監査と同じ確かめになる。監査は `MODE_NOT_EXECUTABLE` のまま。
 */
import { validateAuthSetup } from '../../../../src/control/auth/auth-setup-policy.js';
import type { ProfileValidationErrorCode, SiteProfile } from '../../../../src/control/contracts.js';
import type { CredentialMetadata, CredentialProtectionState } from '../../../../src/control/credentials/credential-store.js';
import { operationRequiresAuthSetup, profileOperationRejectionOf } from '../../../../src/control/execution-policy.js';
import type { AuditJobStartResult } from '../../../../src/control/job/audit-job-manager.js';
import type { AutoLoginLimitDecision } from '../../../../src/control/job/auto-login-limits.js';
import { checkAutoLoginStart, type AutoLoginPreflightRejectionReason } from '../../../../src/control/job/auto-login-preflight.js';
import type { AuditJobKind, AuditJobStartRejectionReason } from '../../../../src/control/job/job-records.js';
import { WORKER_AUDIT_JOB_KIND, WORKER_READ_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の設定の新しさは、owner の名前つきの定数と比べる（文字列で比べない）。
import { CURRENT_AUTH_SETUP_FRESHNESS, type StoredAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import { ACTIVE_PROFILE_STATUS, type ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from './auth-setup-errors';
import { isoTimestampOrNull } from './timestamps';

/** 開始の画面に出す、開始できない理由（開始の直前のジョブの管理の判断と同じ理由の値）。 */
export type AuditStartBlocker = Extract<
  AuditJobStartRejectionReason,
  | 'PROFILE_RETIRED'
  | 'MODE_NOT_EXECUTABLE'
  | 'AUTH_STRATEGY_NOT_EXECUTABLE'
  | 'AUTH_SETUP_MISSING'
  | 'AUTH_SETUP_STALE'
  | 'TARGET_PATH_INVALID'
  | 'TARGET_CONFIG_UNAVAILABLE'
  | 'PROFILE_INVALID'
  | 'AUTH_SETUP_INVALID'
  | 'READ_CHECK_DEFINITIONS_MISSING'
  | AutoLoginPreflightRejectionReason
>;


/** 自動ログインの開始の前の確かめに要る、呼び出し側が読んだ値（T26e。値を含まない）。 */
export interface AutoLoginStartInputs {
  /** 資格情報のメタデータ（ないか、読めなければ `null`。ジョブの管理と同じ扱い）。 */
  readonly credential: CredentialMetadata | null;
  readonly protection: CredentialProtectionState;
  readonly limit: AutoLoginLimitDecision;
}

/** 確かめの入力（呼び出し側が読んだ値）。 */
export interface AuditStartCheckInput {
  readonly status: ProfileStatus;
  readonly profile: SiteProfile;
  /** ターゲット設定のパスを受けるか（`isAcceptedTargetConfigPath`）。 */
  readonly pathAccepted: boolean;
  /** 読めたターゲット設定の文脈（読めなければ `undefined`）。 */
  readonly context: ProfileValidationContext | undefined;
  /** 保存してある認証の設定（認証の設定が要るモードでなければ、渡しても使わない）。 */
  readonly storedSetup: StoredAuthSetup | null;
  /** 確かめるジョブの種類（T26e。省略は監査。T30e: 書き込みのジョブも、操作の行で確かめる）。 */
  readonly jobKind?: AuditJobKind;
  /** 自動ログインの開始の前の確かめの値（T26e。自動ログインの設定のときだけ使う。`null` か省略なら、この確かめをしない）。 */
  readonly autoLogin?: AutoLoginStartInputs | null;
  /** 取り消していない READ の確かめの定義の数（T27f。`READ_CHECK` の確かめだけで使う。省略は 0）。 */
  readonly readCheckDefinitionCount?: number;
  /**
   * FM2R の I-1: READ の確かめの定義が要るか（省略は要る）。まとめて実行の READ の段は偽（0 件は「行わなかった」で、止める理由にしない。ジョブの管理も、
   * 連鎖の READ の段では件数を開始の確かめに入れない）。
   */
  readonly readCheckDefinitionsRequired?: boolean;
}

/** 確かめの結果。 */
export interface AuditStartCheck {
  /** 開始できない理由（なければ `null`）。 */
  readonly blocker: AuditStartBlocker | null;
  /** プロファイルの検証の誤り（`PROFILE_INVALID` のときだけ。ほかは空）。 */
  readonly errorCodes: readonly ProfileValidationErrorCode[];
  /** 認証の設定が要るモードか。 */
  readonly authRequired: boolean;
  /** 認証の設定の検証の誤り（`AUTH_SETUP_INVALID` のときだけ。ほかは空）。 */
  readonly authSetupErrors: readonly AuthSetupErrorView[];
  /** 次に始められる日時（ISO 8601。`AUTO_LOGIN_RATE_LIMITED` のときだけ。ほかは `null`。T26e）。 */
  readonly nextAllowedAt: string | null;
}

/** 開始できない理由を確かめる（流れはファイルの先頭）。 */
export const auditStartCheckOf = (input: AuditStartCheckInput): AuditStartCheck => {
  const { status, profile, pathAccepted, context } = input;
  // 確かめるジョブの種類の省略の値は監査（T44g の CC-105: 値は IPC の契約の名前つきの定数から読む）。
  const jobKind = input.jobKind ?? WORKER_AUDIT_JOB_KIND;
  // T28b: 認証の設定が要るかは、その操作をそのモードで受けるときだけ（書き込みのモードの監査は始められないので、要るとは言わない）。
  const authRequired = operationRequiresAuthSetup(jobKind, profile.mode);
  const storedSetup = authRequired ? input.storedSetup : null;
  const validation = context === undefined ? null : validateSiteProfile(profile, context);
  const setupCheck = storedSetup !== null && storedSetup.freshness === CURRENT_AUTH_SETUP_FRESHNESS && validation !== null && validation.ok && context !== undefined
    ? validateAuthSetup(storedSetup.setup, validation.profile, context)
    : null;
  // T26e: 自動ログインの設定なら、ジョブの管理と同じ開始の前の確かめ（認証の設定の検証を通ったときだけ）。
  const autoLogin = input.autoLogin ?? null;
  const preflight = setupCheck !== null && setupCheck.ok && setupCheck.setup.automatedLogin !== null && validation !== null && validation.ok
    && autoLogin !== null
    ? checkAutoLoginStart({ profile: validation.profile, authSetup: setupCheck.setup, ...autoLogin })
    : null;
  // T28b: ジョブの種類ごとに許すモードと認証の方式は、ジョブの管理と同じ判定（`execution-policy.ts` の `profileOperationRejectionOf`）だけで決める
  // （T26e のログインの確かめは自動ログインだけ、T27f の発見と READ の確かめは認証の設定が要るモードだけ。書き込みのモードは監査だけを拒む）。READ の
  // 確かめは、取り消していない定義が 0 件なら、認証の設定の確かめの前に `READ_CHECK_DEFINITIONS_MISSING`。
  const operationRejection = profileOperationRejectionOf(jobKind, profile.mode, profile.auth);
  // T27f: 取り消していない定義が 0 件なら、READ の確かめのジョブは始めない。
  const readCheck = jobKind === WORKER_READ_CHECK_JOB_KIND && input.readCheckDefinitionsRequired !== false;
  const checks: readonly (readonly [boolean, AuditStartBlocker])[] = [
    [status !== ACTIVE_PROFILE_STATUS, 'PROFILE_RETIRED'],
    ...(operationRejection === null ? [] : [[true, operationRejection] as const]),
    [readCheck && (input.readCheckDefinitionCount ?? 0) === 0, 'READ_CHECK_DEFINITIONS_MISSING'],
    [authRequired && storedSetup === null, 'AUTH_SETUP_MISSING'],
    [storedSetup !== null && storedSetup.freshness !== CURRENT_AUTH_SETUP_FRESHNESS, 'AUTH_SETUP_STALE'],
    [!pathAccepted, 'TARGET_PATH_INVALID'],
    [context === undefined, 'TARGET_CONFIG_UNAVAILABLE'],
    [validation !== null && !validation.ok, 'PROFILE_INVALID'],
    [setupCheck !== null && !setupCheck.ok, 'AUTH_SETUP_INVALID'],
    ...(preflight === null || preflight.ok ? [] : [[true, preflight.reason] as const]),
  ];
  const blocker = checks.find(([blocked]) => blocked)?.[1] ?? null;
  return {
    blocker,
    errorCodes: validation !== null && !validation.ok ? validation.errors.map((error) => error.code) : [],
    authRequired,
    authSetupErrors: blocker === 'AUTH_SETUP_INVALID' && setupCheck !== null && !setupCheck.ok ? authSetupErrorViewsOf(setupCheck.errors) : [],
    nextAllowedAt: preflight !== null && !preflight.ok && blocker === preflight.reason ? isoTimestampOrNull(preflight.nextAllowedAt) : null,
  };
};

/** 画面に返す、開始の拒否の値（`ok` を除く）。 */
export interface AuditJobStartRejectionView {
  readonly reason: AuditJobStartRejectionReason;
  /** プロファイルの検証の誤りのコード（`PROFILE_INVALID` のときだけ。ほかは空）。 */
  readonly errorCodes: readonly ProfileValidationErrorCode[];
  /** 認証の設定の検証の誤り（`AUTH_SETUP_INVALID` のときだけ。ほかは空）。 */
  readonly authSetupErrors: readonly AuthSetupErrorView[];
  /**
   * 次に始められる日時（ISO 8601。T26e）。ジョブの管理が自動ログインの上限で拒んだとき（`AUTO_LOGIN_HELD`・`AUTO_LOGIN_RATE_LIMITED`）だけ持つ
   * （止めているときは `null`）。
   */
  readonly nextAllowedAt?: string | null;
}

/** ジョブの管理の開始の拒否を、画面に返す値にする。 */
export const startRejectionViewOf = (result: Extract<AuditJobStartResult, { ok: false }>): AuditJobStartRejectionView => ({
  reason: result.reason,
  errorCodes: result.errors.map((error) => error.code),
  authSetupErrors: result.reason === 'AUTH_SETUP_INVALID' ? authSetupErrorViewsOf(result.authSetupErrors ?? []) : [],
  ...(result.nextAllowedAt === undefined ? {} : { nextAllowedAt: isoTimestampOrNull(result.nextAllowedAt) }),
});
