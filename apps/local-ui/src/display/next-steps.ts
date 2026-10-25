/**
 * プロファイルの「次にすること」（T43a。Task 43 の設計書 4.1）。ブラウザでも動く純粋な部品（値は持たず、判定は今の owner を呼ぶだけ）。
 * - 手順は 4 つ（認証の設定、資格情報、ログインの確かめ、監査の開始）。手順を使うプロファイルかは、`src/control/execution-policy.ts` の行の判定
 *   （`labels.ts` の `usesAuthSetup`・`usesAutomatedLogin`・`isExecutableProfile`、`LOGIN_CHECK` の行）だけで決める。使わない手順は「要らない」。
 * - 状態は、画面のサーバが読んだ事実から選ぶだけ（第二の判定を作らない）:
 *   - 認証の設定: 保存してある認証の設定の新しさ（`auth-setup-store.ts` の `freshness`。開始の確かめの `AUTH_SETUP_STALE` と同じ値）。ない → 要る、
 *     `CURRENT` でない → 古い、`CURRENT` → 済み。
 *   - 資格情報: 保存してあるか（資格情報のメタデータ）と、ログインの確かめの開始の確かめ（`audit-start-check.ts`。判定は `checkAutoLoginStart`）が
 *     `CREDENTIAL_STALE` か。ない → 要る、`CREDENTIAL_STALE` → 古い、ほか → 済み。
 *   - ログインの確かめ: 最後のログインの確かめのジョブ。ない・成功でない → 要る、成功でそのジョブのプロファイルの改訂が今の改訂 → 済み、改訂が
 *     変わった → 古い。
 *   - 監査の開始: 最後の監査のジョブが終わった（`FINISHED`）→ 済み、ほか → 要る。
 * - 監査を始められない理由（一覧の短い理由）: 取り消し → `execution-policy.ts` の `profileOperationRejectionOf('AUDIT', …)`（開始の確かめ
 *   `auditStartCheckOf` の初めの 2 つと同じ順）。認証の設定などの確かめは、開始の画面とプロファイルの詳細が、サーバの開始の確かめで出す。
 * - 表示（ラベル、色、説明）は `src/presentation/catalog.ts` の `PROFILE_NEXT_STEP_CATALOG`・`NEXT_STEP_STATE_CATALOG`、文言は `messages.ts` の
 *   `LOCAL_UI_NEXT_STEP_TEXT`。
 */
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import {
  isProfileOperationAllowed,
  profileOperationRejectionOf,
  type ProfileOperationRejection,
} from '../../../../src/control/execution-policy.js';
import type { AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の設定の新しさと、開始を拒む理由の値は、純粋な core の owner から読む（書き写さない）。
import { PROFILE_RETIRED_START_REJECTION_REASON } from '../../../../src/core/audit-job-start-rejection-reasons.js';
import { CURRENT_AUTH_SETUP_FRESHNESS } from '../../../../src/core/auth-setup-freshness.js';
import { ACTIVE_PROFILE_STATUS, type ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { isExecutableProfile, usesAuthSetup, usesAutomatedLogin } from './labels';

/** 手順（閉じた一覧。並べる順）。 */
export const PROFILE_NEXT_STEPS = Object.freeze(['AUTH_SETUP', 'CREDENTIAL', 'LOGIN_CHECK', 'AUDIT_START'] as const);
export type ProfileNextStep = (typeof PROFILE_NEXT_STEPS)[number];

/** 手順の状態（閉じた一覧）。 */
export const NEXT_STEP_STATES = Object.freeze(['DONE', 'NEEDED', 'STALE', 'NOT_NEEDED'] as const);
export type NextStepState = (typeof NEXT_STEP_STATES)[number];

/** その手順を、このモードと認証の方式のプロファイルで使うか（`execution-policy.ts` の行の判定）。 */
export const profileNextStepApplies = (step: ProfileNextStep, mode: AuditMode, auth: AuthStrategy): boolean => {
  switch (step) {
    case 'AUTH_SETUP':
      return usesAuthSetup(mode, auth);
    case 'CREDENTIAL':
      return usesAutomatedLogin(mode, auth);
    case 'LOGIN_CHECK':
      return isProfileOperationAllowed('LOGIN_CHECK', mode, auth);
    case 'AUDIT_START':
      return isExecutableProfile(mode, auth);
  }
};

/** その手順の次に使う手順（なければ `null`。保存の後の次の手順のリンクに使う）。 */
export const nextStepAfter = (step: ProfileNextStep, mode: AuditMode, auth: AuthStrategy): ProfileNextStep | null =>
  PROFILE_NEXT_STEPS.slice(PROFILE_NEXT_STEPS.indexOf(step) + 1).find((next) => profileNextStepApplies(next, mode, auth)) ?? null;

/** 状態を選ぶための、画面のサーバが読んだ事実。 */
export interface ProfileNextStepFacts {
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  /** 今のプロファイルの改訂。 */
  readonly revision: number;
  /** 保存してある認証の設定の新しさ（認証の設定がなければ `null`）。 */
  readonly authSetupFreshness: AuthSetupFreshness | null;
  /** 資格情報を保存しているか。 */
  readonly credentialSaved: boolean;
  /** ログインの確かめの開始の確かめが `CREDENTIAL_STALE` か（保存した資格情報のログインの Origin が、今の認証の設定と違う）。 */
  readonly credentialStale: boolean;
  /** 最後のログインの確かめのジョブ（なければ `null`）。成功したかと、そのジョブのプロファイルの改訂。 */
  readonly lastLoginCheck: { readonly succeeded: boolean; readonly profileRevision: number } | null;
  /** 最後の監査のジョブが終わった（`FINISHED`）か。 */
  readonly lastAuditFinished: boolean;
}

/** 「次にすること」の 1 行。 */
export interface ProfileNextStepRow {
  readonly step: ProfileNextStep;
  readonly state: NextStepState;
}

/** 使う手順の状態（使わない手順は呼ばない）。 */
const stateOf = (step: ProfileNextStep, facts: ProfileNextStepFacts): NextStepState => {
  switch (step) {
    case 'AUTH_SETUP':
      if (facts.authSetupFreshness === null) {
        return 'NEEDED';
      }
      return facts.authSetupFreshness === CURRENT_AUTH_SETUP_FRESHNESS ? 'DONE' : 'STALE';
    case 'CREDENTIAL':
      if (!facts.credentialSaved) {
        return 'NEEDED';
      }
      return facts.credentialStale ? 'STALE' : 'DONE';
    case 'LOGIN_CHECK':
      if (facts.lastLoginCheck === null || !facts.lastLoginCheck.succeeded) {
        return 'NEEDED';
      }
      return facts.lastLoginCheck.profileRevision === facts.revision ? 'DONE' : 'STALE';
    case 'AUDIT_START':
      return facts.lastAuditFinished ? 'DONE' : 'NEEDED';
  }
};

/** 「次にすること」の行（手順の順。選び方はファイルの先頭）。 */
export const profileNextStepsOf = (facts: ProfileNextStepFacts): readonly ProfileNextStepRow[] =>
  PROFILE_NEXT_STEPS.map((step) => ({
    step,
    state: profileNextStepApplies(step, facts.mode, facts.auth) ? stateOf(step, facts) : 'NOT_NEEDED',
  }));

/** 一覧で示す、監査を始められない理由（取り消しと、モードと認証の方式の理由）。 */
export type AuditStartUnavailableReason = typeof PROFILE_RETIRED_START_REJECTION_REASON | ProfileOperationRejection;

/**
 * プロファイルの状態とモードと認証の方式だけで分かる、監査を始められない理由（始められるなら `null`）。取り消し → `execution-policy.ts` の
 * `profileOperationRejectionOf('AUDIT', …)` の順（開始の確かめ `auditStartCheckOf` の初めの 2 つと同じ）。
 */
export const auditStartUnavailableReasonOf = (status: ProfileStatus, mode: AuditMode, auth: AuthStrategy): AuditStartUnavailableReason | null =>
  status === ACTIVE_PROFILE_STATUS ? profileOperationRejectionOf('AUDIT', mode, auth) : PROFILE_RETIRED_START_REJECTION_REASON;
