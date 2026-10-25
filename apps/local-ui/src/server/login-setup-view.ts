/**
 * ML-b（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.3）: 手動のログインの成功から自動で登録した、Guard を通るための
 * 設定の画面の値（ジョブの画面とプロファイルの画面が共用する）。読むだけ。
 * - 中身は、保存してある認証の設定（版 3 のスクリプトで送るログイン: token の送信先、ログインに伴う送信、成功のローカル ストレージの鍵の形）と、プロファイルの
 *   承認したサービスの Origin。保存の口（自動の登録は ML-a のジョブの管理、手での直しは認証の設定の画面）は変えない。
 * - 値は持たない: token の送信先の必須の query は名前だけ（値は返さない）。鍵は接頭辞と接尾辞の形だけ（今の設定と同じ）。
 * - スクリプトで送るログインの設定がないプロファイルは null（フォームの送信の設定には、自動で登録するものがない）。
 */
import { loginTransportOf, SCRIPT_REQUEST_TRANSPORT } from '../../../../src/control/auth/auth-setup-contracts.js';
import { getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { localUiStore } from './control-store';

/** 自動で登録した設定（値を持たない）。 */
export interface LoginSetupView {
  readonly profileId: string;
  readonly token: { readonly origin: string; readonly path: string; readonly queryNames: readonly string[] } | null;
  readonly sideRequests: readonly { readonly origin: string; readonly path: string; readonly method: string; readonly maxPerLoginStage: number }[];
  readonly serviceOrigins: readonly string[];
  readonly successKey: { readonly origin: string; readonly prefix: string; readonly suffix: string } | null;
}

/** プロファイルの、スクリプトで送るログインの設定（なければ null）。 */
export const loginSetupViewOf = (profileId: string): LoginSetupView | null => {
  const stored = getAuthSetup(localUiStore(), profileId);
  const profile = getProfile(localUiStore(), profileId);
  if (stored === null || profile === null || loginTransportOf(stored.setup) !== SCRIPT_REQUEST_TRANSPORT) {
    return null;
  }
  const { setup } = stored;
  return {
    profileId,
    token: setup.scriptLogin === null
      ? null
      : { origin: setup.scriptLogin.origin, path: setup.scriptLogin.path, queryNames: setup.scriptLogin.requiredQuery.map(({ name }) => name) },
    sideRequests: setup.loginSideRequests.map(({ origin, path, method, maxPerLoginStage }) => ({ origin, path, method, maxPerLoginStage })),
    serviceOrigins: [...(profile.profile.approvedServiceOrigins ?? [])],
    successKey: setup.successStorageKey === null ? null : { ...setup.successStorageKey },
  };
};
