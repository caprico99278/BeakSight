// 自動ログインの開始の前の確かめ（Task 26 の設計書 4.5 の「開始の前の確かめ」。T26c）。純粋な関数だけ。ジョブの管理への組み込みは T26d。
// - 入力: プロファイル、認証の設定（版 2）、資格情報のメタデータ（T26a の `readMetadata` の結果。値を含まない）、暗号化が使えるか
//   （T26a の `checkProtection` の結果）、上限の判定の結果（`decideAutoLoginStart`）。
// - 確かめる順: 資格情報のファイルがある（`CREDENTIAL_MISSING`）→ 保存した `loginOrigin` が、認証の設定の `loginStartUrl` の Origin と同じ
//   （`CREDENTIAL_STALE`）→ 暗号化が使える（`CREDENTIAL_PROTECTION_UNAVAILABLE`）→ 止めていない（`AUTO_LOGIN_HELD`）→ 上限の中
//   （`AUTO_LOGIN_RATE_LIMITED`。次に始められる時刻つき）。人が直すべきこと（資格情報）を、待てば済むこと（上限）より先に出す。
// - ログインの Origin は `loginOriginOf`（既存の Origin の正規化）で求める。
// - 自動ログインのプロファイルでない、ほかのプロファイルの入力、自動ログインの設定がない、などは呼び出し側の誤り（`RangeError`）。
import type { AuthSetup } from '../auth/auth-setup-contracts.js';
import { loginOriginOf } from '../auth/automated-login-results.js';
import type { SiteProfile } from '../contracts.js';
import type { CredentialMetadata, CredentialProtectionState } from '../credentials/credential-store.js';
import type { AutoLoginLimitDecision } from './auto-login-limits.js';
import type { AuditJobStartRejectionReason } from './job-records.js';

/** 開始の前の確かめで拒む理由（開始を拒む理由の一部。確かめる順）。 */
export const AUTO_LOGIN_PREFLIGHT_REJECTION_REASONS = Object.freeze([
  'CREDENTIAL_MISSING',
  'CREDENTIAL_STALE',
  'CREDENTIAL_PROTECTION_UNAVAILABLE',
  'AUTO_LOGIN_HELD',
  'AUTO_LOGIN_RATE_LIMITED',
] as const satisfies readonly AuditJobStartRejectionReason[]);
export type AutoLoginPreflightRejectionReason = (typeof AUTO_LOGIN_PREFLIGHT_REJECTION_REASONS)[number];

/** 開始の前の確かめの入力。 */
export interface AutoLoginPreflightInput {
  readonly profile: SiteProfile;
  readonly authSetup: AuthSetup;
  /** 資格情報のメタデータ（ファイルがなければ `null`）。値（ユーザー名とパスワード）は受けない。 */
  readonly credential: CredentialMetadata | null;
  readonly protection: CredentialProtectionState;
  readonly limit: AutoLoginLimitDecision;
}

/** 開始の前の確かめの結果。拒むときは、次に始められる時刻（上限のときだけ。ほかは `null`）。 */
export type AutoLoginPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AutoLoginPreflightRejectionReason; readonly nextAllowedAt: string | null };

/** 自動ログインの方式。 */
const AUTOMATED_LOGIN_STRATEGY = 'AUTOMATED_LOGIN' satisfies SiteProfile['auth'];
/** 暗号化が使える状態。 */
const PROTECTION_AVAILABLE = 'AVAILABLE' satisfies CredentialProtectionState;

const rejected = (reason: AutoLoginPreflightRejectionReason, nextAllowedAt: string | null = null): AutoLoginPreflightResult =>
  Object.freeze({ ok: false, reason, nextAllowedAt });

/** 自動ログインを始めてよいか（設計書 4.5）。 */
export const checkAutoLoginStart = (input: AutoLoginPreflightInput): AutoLoginPreflightResult => {
  const { profile, authSetup, credential, protection, limit } = input;
  if (profile.auth !== AUTOMATED_LOGIN_STRATEGY) {
    throw new RangeError('the auto login preflight takes only a profile of the automated login');
  }
  if (authSetup.profileId !== profile.profileId || authSetup.automatedLogin === null) {
    throw new RangeError('the auth setup must belong to the profile and have the automated login settings');
  }
  const loginOrigin = loginOriginOf(authSetup.loginStartUrl);
  if (loginOrigin === undefined) {
    throw new RangeError('loginStartUrl of the auth setup must be an http(s) URL');
  }
  if (credential !== null && credential.profileId !== profile.profileId) {
    throw new RangeError('the credential metadata must belong to the profile');
  }

  if (credential === null) {
    return rejected('CREDENTIAL_MISSING');
  }
  if (credential.loginOrigin !== loginOrigin) {
    return rejected('CREDENTIAL_STALE');
  }
  if (protection !== PROTECTION_AVAILABLE) {
    return rejected('CREDENTIAL_PROTECTION_UNAVAILABLE');
  }
  if (!limit.ok) {
    return rejected(limit.reason, limit.nextAllowedAt);
  }
  return Object.freeze({ ok: true });
};
