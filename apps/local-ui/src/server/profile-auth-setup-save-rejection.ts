/**
 * MI-C（CC-115）: プロファイルと認証の設定をまとめて保存する部品（`src/control/store/profile-auth-setup-store.ts` の `saveProfileAndAuthSetup`）の拒否を、
 * 画面の 1 回の操作の理由に写す変換（サーバだけで使う）。「次から自動でログインする」（`credential-service.ts` の `setUpAutomatedLogin`）と
 * 「書き込みにも使う」（`write-mode-switch.ts` の `switchToWriteMode`）が、同じ形の変換をそれぞれ持っていたので、ここにまとめた。
 * - 改訂の衝突は `PROFILE_REVISION_CONFLICT`、対象の設定を読めないときは `TARGET_CONFIG_UNAVAILABLE`。
 * - ほかは、拒んだ部分で決める（認証の設定なら `AUTH_SETUP_INVALID`、プロファイルなら `PROFILE_INVALID`）。
 * 写す先の理由は、どちらの操作の理由の一覧にも入る（`write-mode-switch.test.ts` が確かめる）。
 */
import type { ProfileAndAuthSetupSaveResult } from '../../../../src/control/store/profile-auth-setup-store.js';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from './auth-setup-errors';

/** 認証の設定の検証の誤りがないとき（プロファイルの側の拒否）。 */
const NO_AUTH_SETUP_ERRORS: readonly AuthSetupErrorView[] = Object.freeze([]);

/**
 * MI-F3（独立レビュー MI-R の Minor 12）: 保存の部品の拒否の、画面に返す認証の設定の検証の誤り（拒んだのが認証の設定のときだけ。変換は
 * `authSetupErrorViewsOf`。プロファイルの側の拒否は空）。「次から自動でログインする」・「書き込みにも使う」・認証の設定の画面の下書きからの保存が、同じ形の
 * 式をそれぞれ書いていたので、ここにまとめた。
 */
export const authSetupErrorViewsOfProfileAndAuthSetupSaveRejection = (
  result: Extract<ProfileAndAuthSetupSaveResult, { ok: false }>,
): readonly AuthSetupErrorView[] => (result.part === 'AUTH_SETUP' ? authSetupErrorViewsOf(result.errors) : NO_AUTH_SETUP_ERRORS);

/** 写す先の理由（閉じた一覧。両方の操作の理由の一覧の一部）。 */
export const PROFILE_AND_AUTH_SETUP_SAVE_REJECTION_REASONS = Object.freeze([
  'PROFILE_REVISION_CONFLICT',
  'TARGET_CONFIG_UNAVAILABLE',
  'AUTH_SETUP_INVALID',
  'PROFILE_INVALID',
] as const);
export type ProfileAndAuthSetupSaveRejectionReason = (typeof PROFILE_AND_AUTH_SETUP_SAVE_REJECTION_REASONS)[number];

/** 保存の部品の拒否を、操作の理由に写す（改訂の衝突、対象の設定、認証の設定の検証、ほかはプロファイルの検証）。 */
export const reasonOfProfileAndAuthSetupSaveRejection = (
  result: Extract<ProfileAndAuthSetupSaveResult, { ok: false }>,
): ProfileAndAuthSetupSaveRejectionReason => {
  if (result.reason === 'PROFILE_REVISION_CONFLICT') {
    return 'PROFILE_REVISION_CONFLICT';
  }
  if (result.reason === 'TARGET_CONFIG_UNAVAILABLE') {
    return 'TARGET_CONFIG_UNAVAILABLE';
  }
  return result.part === 'AUTH_SETUP' ? 'AUTH_SETUP_INVALID' : 'PROFILE_INVALID';
};
