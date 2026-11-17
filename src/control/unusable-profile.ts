// MI-F3 項目 6（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の終わりの段落。ユーザーの指示 2026-10-26「フォームやボタンは増やさない。
// 基本的に自動化を厳守する」）: 使えないプロファイルを、画面のサーバの起動のときに自動で取り消すかの判定の唯一の owner。純粋な部品（入出力を持たない）。
// - 対象（`AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP`）: 取り消していない、認証の方式が自動ログイン（`isAutomatedLoginProfileAuth`）で、認証の設定がないプロファイル。
//   MI より前に作られた形で、今の画面の道では作れない（作成と編集は自動ログインにする保存を拒み、切り替えには認証の設定が要る）。入口の確かめの後の案の保存も
//   自動ログインのプロファイルを除き、資格情報の送信先の守りがあるので、このプロファイルは、ログインのある操作をどれも始められない。
// - 動いているジョブのあるプロファイルは取り消さない（ジョブの記録を、取り消したプロファイルに結びつけたまま途中で終わらせないため）。
// - 取り消しそのもの（今の取り消しの保存の部品と、残った資格情報の片付け）と記録は、画面のサーバの起動の流れ（`apps/local-ui/src/server/unusable-profile-retirement.ts`）。
import { isAutomatedLoginProfileAuth } from './auth/credential-destination.js';
import type { AuthStrategy } from './contracts.js';
import { ACTIVE_PROFILE_STATUS, type ProfileStatus } from './store/profile-records.js';

/** 起動のときに自動で取り消す理由（閉じた一覧。文言は `LOCAL_UI_UNUSABLE_PROFILE_TEXT.reasons`）。 */
export const UNUSABLE_PROFILE_REASONS = Object.freeze(['AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP'] as const);
export type UnusableProfileReason = (typeof UNUSABLE_PROFILE_REASONS)[number];

/** 判定に使う、プロファイルの事実（値を持たない）。 */
export interface UnusableProfileFacts {
  readonly status: ProfileStatus;
  readonly auth: AuthStrategy;
  /** 認証の設定が保存してあるか。 */
  readonly hasAuthSetup: boolean;
  /** そのプロファイルに、終わっていないジョブがあるか。 */
  readonly hasActiveJob: boolean;
}

/** 起動のときに自動で取り消す理由（取り消さないなら `null`）。 */
export const startupRetirementReasonOf = (facts: UnusableProfileFacts): UnusableProfileReason | null =>
  facts.status === ACTIVE_PROFILE_STATUS && isAutomatedLoginProfileAuth(facts.auth) && !facts.hasAuthSetup && !facts.hasActiveJob
    ? 'AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP'
    : null;
