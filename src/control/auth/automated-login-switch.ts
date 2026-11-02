/**
 * 自動ログインへの切り替えの中身と、資格情報を書く前の確かめ（OP-1 の修正の 1 回目。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1。
 * FM2e の `setUpAutomatedLogin` と MI-4 の切り替えの前の確かめを、画面のサーバ `apps/local-ui/src/server/credential-service.ts` から移した）。純粋な関数と、管理データを
 * 読むだけの関数（書かない）。資格情報の画面のサーバ（切り替えの画面・ID とパスワードの画面）と、ジョブの管理（ログインの直後の登録と切り替え）の 2 つが使う
 * （同じ判断を 2 か所に書かない）。
 * - 資格情報を書く前の確かめ（`writableLoginOriginOf`）: プロファイル → 対象か（自動ログインのプロファイル。前提の方式を渡せる）→ Windows か → そのプロファイルの
 *   ジョブが動いていないか（呼ぶ側の `checkCredentialChange`。ジョブの管理は、ログインの段の口から書くときだけ、そのジョブのほかに動くジョブがないことを渡す）→
 *   ログインの Origin。
 * - 切り替えの中身（`automatedLoginSwitchOf`）: 方式を `AUTOMATED_LOGIN` にした次の改訂のプロファイルと、回数の上限 1 と 3 つのセレクタを入れた認証の設定を作り、
 *   プロファイルの検証と認証の設定の検証（`validateAuthSetupForProfile`）に通す。保存は呼ぶ側が `saveProfileAndAuthSetup` の 1 回で行う。
 */
import {
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AuthSetupValidationError,
  type AutomatedLoginSetup,
} from './auth-setup-contracts.js';
import { loginOriginOf } from './automated-login-results.js';
import { credentialRejection, type CredentialRequestRejection } from './credential-request-rejection.js';
import {
  AUTOMATED_LOGIN_AUTH_STRATEGY,
  MANUAL_EVERY_TIME_LOGIN_PREFERENCE,
  loginPreferenceOf,
  type AuthStrategy,
  type SiteProfile,
} from '../contracts.js';
import { WORKER_LOGIN_CHECK_JOB_KIND, type WorkerJobKind } from '../../core/audit-job-values.js';
import { isProfileOperationAllowed } from '../execution-policy.js';
import type { CredentialChangeRejectionReason } from '../job/job-records.js';
import { validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import { getAuthSetup, validateAuthSetupForProfile } from '../store/auth-setup-store.js';
import type { ControlDatabase } from '../store/control-database.js';
import { ACTIVE_PROFILE_STATUS } from '../store/profile-records.js';
import { getProfile, type StoredProfile } from '../store/profile-store.js';

/**
 * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5、4.1.3 の 2）: このジョブで「毎回手でログインする」が効くか（判定の 1 か所。ジョブの管理の開始と、
 * 画面の開始の確かめが使う）。効くときは、自動ログインの設定があっても手でログインする（自動ログインの開始の前の確かめと上限を当てない）。ログインの確かめのジョブは、
 * 自動ログインだけの操作なので効かない。
 */
export const manualLoginEveryTimeApplies = (profile: Pick<SiteProfile, 'loginPreference'>, jobKind: WorkerJobKind): boolean =>
  loginPreferenceOf(profile) === MANUAL_EVERY_TIME_LOGIN_PREFERENCE && jobKind !== WORKER_LOGIN_CHECK_JOB_KIND;

/** 資格情報を変えてよいかの確かめの結果（ジョブの管理の `CredentialChangeCheck` と同じ形）。 */
export type CredentialWriteCheck = { readonly ok: true } | { readonly ok: false; readonly reason: CredentialChangeRejectionReason };

/** 資格情報を書く前の確かめの部品。 */
export interface CredentialWriteCheckDependencies {
  readonly database: ControlDatabase;
  /** 資格情報を変えてよいか（画面のサーバはジョブの管理の `checkCredentialChange`。動いているジョブがあれば `CREDENTIAL_IN_USE`）。 */
  readonly checkCredentialChange: (profileId: string) => CredentialWriteCheck;
  /** 資格情報を保存できるプラットフォームか。 */
  readonly platformSupported: () => boolean;
}

/** 書く前の確かめの前提（保存の後の方式と、認証の設定のログインの画面の URL）。渡さなければ、保存してあるプロファイルと認証の設定で確かめる。 */
export interface CredentialWriteAssumption {
  readonly auth: AuthStrategy;
  readonly loginStartUrl: string;
}

/** 自動ログインのプロファイルか（`execution-policy.ts` の `CREDENTIAL` の行）。前提の方式を渡せる。 */
export const isCredentialEligible = (stored: StoredProfile, auth: AuthStrategy = stored.profile.auth): boolean =>
  isProfileOperationAllowed('CREDENTIAL', stored.profile.mode, auth);

/** 自動ログインへ切り替えられる（有効な、認証の設定を使う、手動のログインの）プロファイルか。 */
export const offersAutomatedLoginSwitch = (stored: StoredProfile): boolean =>
  stored.status === ACTIVE_PROFILE_STATUS
  && isProfileOperationAllowed('AUTH_SETUP', stored.profile.mode, stored.profile.auth)
  && !isProfileOperationAllowed('CREDENTIAL', stored.profile.mode, stored.profile.auth);

/** 対象のプロファイルの確かめ（`requireActive` なら `ACTIVE` だけ）。通らなければ拒否の応答。 */
export const credentialTargetRejectionOf = (
  database: ControlDatabase,
  profileId: string,
  requireActive: boolean,
  auth?: AuthStrategy,
): CredentialRequestRejection | null => {
  const stored = getProfile(database, profileId);
  if (stored === null) {
    return credentialRejection('PROFILE_NOT_FOUND');
  }
  if (!isCredentialEligible(stored, auth) || (requireActive && stored.status !== ACTIVE_PROFILE_STATUS)) {
    return credentialRejection('CREDENTIAL_NOT_ELIGIBLE');
  }
  return null;
};

/** 書く前の確かめ（ファイルの先頭）。通ればログインの Origin。 */
export const writableLoginOriginOf = (
  deps: CredentialWriteCheckDependencies,
  profileId: string,
  assumption?: CredentialWriteAssumption,
): { readonly loginOrigin: string } | CredentialRequestRejection => {
  const target = credentialTargetRejectionOf(deps.database, profileId, true, assumption?.auth);
  if (target !== null) {
    return target;
  }
  if (!deps.platformSupported()) {
    return credentialRejection('CREDENTIAL_PLATFORM_UNSUPPORTED');
  }
  const inUse = deps.checkCredentialChange(profileId);
  if (!inUse.ok) {
    return credentialRejection(inUse.reason);
  }
  const loginStartUrl = assumption?.loginStartUrl ?? getAuthSetup(deps.database, profileId)?.setup.loginStartUrl ?? null;
  const loginOrigin = loginStartUrl === null ? null : (loginOriginOf(loginStartUrl) ?? null);
  return loginOrigin === null ? credentialRejection('AUTH_SETUP_MISSING') : Object.freeze({ loginOrigin });
};

/** 3 つのセレクタ（切り替えの入力）。 */
export interface AutomatedLoginSelectors {
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
}

/** 失敗の条件を使わない形。 */
const NO_FAILURE_CONDITIONS = Object.freeze(Object.fromEntries(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.map((kind) => [kind, null]))) as
  AutomatedLoginSetup['failureConditions'];

/** 切り替えた後の認証の設定（次の改訂、回数の上限 1、3 つのセレクタ。失敗の条件は今のものか、使わない）。 */
export const automatedLoginSetupOf = (setup: AuthSetup, profileRevision: number, selectors: AutomatedLoginSelectors): AuthSetup => ({
  ...setup,
  profileRevision,
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  automatedLogin: {
    usernameSelector: selectors.usernameSelector.trim(),
    passwordSelector: selectors.passwordSelector.trim(),
    submitSelector: selectors.submitSelector.trim(),
    failureConditions: setup.automatedLogin?.failureConditions ?? NO_FAILURE_CONDITIONS,
  },
});

/** 切り替えの中身の結果。 */
export type AutomatedLoginSwitch =
  | { readonly ok: true; readonly nextProfile: SiteProfile; readonly nextSetup: AuthSetup }
  | { readonly ok: false; readonly reason: 'PROFILE_INVALID' }
  | { readonly ok: false; readonly reason: 'AUTH_SETUP_INVALID'; readonly errors: readonly AuthSetupValidationError[] };

/**
 * 切り替えの中身（ファイルの先頭）: プロファイル `profile` と認証の設定 `setup`（どちらも切り替える前の値。改訂はまだ進めていない）から、改訂 `nextRevision` の
 * 自動ログインのプロファイルと認証の設定を作り、検証に通す。
 */
export const automatedLoginSwitchOf = (
  profile: SiteProfile,
  setup: AuthSetup,
  nextRevision: number,
  context: ProfileValidationContext,
  selectors: AutomatedLoginSelectors,
): AutomatedLoginSwitch => {
  const nextProfile: SiteProfile = { ...profile, revision: nextRevision, auth: AUTOMATED_LOGIN_AUTH_STRATEGY };
  const nextSetup = automatedLoginSetupOf(setup, nextRevision, selectors);
  const validatedProfile = validateSiteProfile(nextProfile, context);
  if (!validatedProfile.ok) {
    return { ok: false, reason: 'PROFILE_INVALID' };
  }
  const validatedSetup = validateAuthSetupForProfile(nextSetup, validatedProfile.profile, context);
  if (!validatedSetup.ok) {
    return { ok: false, reason: 'AUTH_SETUP_INVALID', errors: validatedSetup.errors };
  }
  return { ok: true, nextProfile, nextSetup };
};
