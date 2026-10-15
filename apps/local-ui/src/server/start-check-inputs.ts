/**
 * 開始の画面の、開始できない理由の確かめに要る値を読む部品（T27f。サーバだけで使う。ブラウザ側のコードは import しない）。
 * - T25e・T26e で `audit-job-functions.ts` の中に書いていた読み方（プロファイル、ターゲット設定、保存した認証の設定、自動ログインの開始の前の確かめの
 *   値）を、監査の開始の画面（`auditStartSummaryFn`）と、操作の候補の発見と READ の確かめの画面（T27f）が共用するために切り出した（振る舞いは
 *   同じ）。判定は `audit-start-check.ts` の `auditStartCheckOf`（ジョブの管理と同じ順）。
 * - 読むだけ。資格情報のメタデータは、読めない・壊れたファイルを、ないものとして扱う（ジョブの管理と同じ）。暗号化の状態は、起動のときの準備の結果。
 */
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { AutomatedLoginFailureResult } from '../../../../src/control/auth/automated-login-results.js';
import type { SiteProfile } from '../../../../src/control/contracts.js';
import type { CredentialMetadata } from '../../../../src/control/credentials/credential-store.js';
import { isProfileOperationAllowed, requiresAuthSetup } from '../../../../src/control/execution-policy.js';
import { decideAutoLoginStart } from '../../../../src/control/job/auto-login-limits.js';
import { readAutoLoginHold, readAutoLoginLimitInputs } from '../../../../src/control/job/auto-login-store.js';
import { isAcceptedTargetConfigPath, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import { getAuthSetup, type StoredAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import type { AuditStartCheckInput, AutoLoginStartInputs } from './audit-start-check';
import { localUiStore } from './control-store';
import {
  localUiCredentialEnvironment,
  localUiCredentialStore,
  protectionStateOf,
  type CredentialEnvironmentState,
} from './credential-runtime';
import { loadTargetContext } from './target-config';
import { isoTimestampOf, isoTimestampOrNull } from './timestamps';

/** 自動ログインのプロファイルの、開始の前の状態（T26e。値を含まない。日時は ISO 8601）。 */
export interface AuditAutoLoginSummaryView {
  /** 資格情報の暗号化を、この環境で使えるか（サーバが判定した結果）。 */
  readonly environment: CredentialEnvironmentState;
  /** 資格情報を保存しているか。 */
  readonly credentialSaved: boolean;
  /** 止めている自動ログイン（止めていなければ `null`）。 */
  readonly hold: { readonly reason: AutomatedLoginFailureResult; readonly heldAt: string } | null;
  /** 最小の間隔、24 時間の上限、`Retry-After` の待ちの中なら、次に始められる日時（なければ `null`）。 */
  readonly nextAllowedAt: string | null;
}

/**
 * 自動ログインのプロファイルの、開始の前の確かめに要る値を読む（T26e。読むだけ。資格情報のメタデータは、読めない・壊れたファイルを、ないものとして
 * 扱う（ジョブの管理と同じ）。暗号化の状態は、起動のときの準備の結果）。自動ログインのプロファイルでなければ `null`。自動ログインのプロファイルかは、
 * ログインの確かめを許すか（`execution-policy.ts` の `LOGIN_CHECK` の行。T28b で、書き込みのモードの自動ログインも含む）で決める。
 */
const autoLoginInputsOf = async (
  profile: SiteProfile,
): Promise<{ readonly inputs: AutoLoginStartInputs; readonly summary: AuditAutoLoginSummaryView } | null> => {
  if (!isProfileOperationAllowed('LOGIN_CHECK', profile.mode, profile.auth)) {
    return null;
  }
  let credential: CredentialMetadata | null;
  try {
    credential = await localUiCredentialStore().readMetadata(profile.profileId);
  } catch {
    credential = null;
  }
  const environment = await localUiCredentialEnvironment();
  const now = new Date();
  const database = localUiStore();
  const limit = decideAutoLoginStart({ ...readAutoLoginLimitInputs(database, profile.profileId, now), now });
  const hold = readAutoLoginHold(database, profile.profileId);
  return {
    inputs: { credential, protection: protectionStateOf(environment), limit },
    summary: {
      environment,
      credentialSaved: credential !== null,
      hold: hold === null ? null : { reason: hold.reason, heldAt: isoTimestampOf(hold.heldAt) },
      nextAllowedAt: limit.ok ? null : isoTimestampOrNull(limit.nextAllowedAt),
    },
  };
};

/** 開始の画面の確かめに要る、読んだ値。 */
export interface ProfileStartReading {
  readonly stored: StoredProfile;
  /** 読めたターゲット設定の文脈（読めない・パスを受けないなら `undefined`）。 */
  readonly context: ProfileValidationContext | undefined;
  readonly configError: ConfigErrorKind | null;
  /** 保存してある認証の設定（認証の設定が要るモードでなければ `null`）。 */
  readonly storedSetup: StoredAuthSetup | null;
  /** 自動ログインのプロファイルの開始の前の状態（自動ログインのプロファイルでなければ `null`）。 */
  readonly autoLoginSummary: AuditAutoLoginSummaryView | null;
  /** `auditStartCheckOf` の入力（ジョブの種類と、READ の確かめの定義の数は、呼び出し側が足す）。 */
  readonly checkInput: AuditStartCheckInput;
}

/**
 * プロファイルの、開始の確かめに要る値を読む（読むだけ）。プロファイルがなければ `null`。ターゲット設定は、`isAcceptedTargetConfigPath` を通った
 * パスだけを読む。認証の設定が要るモードでは、保存してある設定と、自動ログインのプロファイルの開始の前の確かめの値も読む（ジョブの管理と同じ順）。
 */
export const readProfileStart = async (profileId: string): Promise<ProfileStartReading | null> => {
  const stored = getProfile(localUiStore(), profileId);
  if (stored === null) {
    return null;
  }
  const { profile } = stored;
  const pathAccepted = isAcceptedTargetConfigPath(profile.targetConfigPath);
  const { context, configError } = pathAccepted ? await loadTargetContext(profile.targetConfigPath) : { context: undefined, configError: null };
  const storedSetup = requiresAuthSetup(profile.mode) ? getAuthSetup(localUiStore(), profile.profileId) : null;
  const autoLogin = await autoLoginInputsOf(profile);
  return {
    stored,
    context,
    configError,
    storedSetup,
    autoLoginSummary: autoLogin?.summary ?? null,
    checkInput: { status: stored.status, profile, pathAccepted, context, storedSetup, autoLogin: autoLogin?.inputs ?? null },
  };
};
