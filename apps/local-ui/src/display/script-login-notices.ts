/**
 * T44h の判断 (2)（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」の行。測りの記録 `T44h-after.md` の 3.6 の N3）: 認証の設定の画面の、スクリプトで送る
 * ログインの案内（純粋な関数。画面の部品はこの結果だけを描く）。
 * - 手動のログインのプロファイル: token の送信先・成功の鍵・承認したサービスの Origin は、手動のログインの成功の後の自動の登録が埋める（T44e の P2-8）。そのため
 *   自動の登録の案内だけを出し、承認したサービスの Origin がなくても赤い文（先にプロファイルで足す）は出さない。入口の確かめの案の文も、自動の登録に合わせる。
 * - 自動ログインのプロファイル: 今どおり（全部の欄が要る。承認したサービスの Origin がなければ赤い文、入口の確かめの案の文は「観察してから入れる」）。
 */
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_SCRIPT_LOGIN_TEXT } from '../../../../src/presentation/messages.js';

/** 案内を決める入力。 */
export interface ScriptLoginNoticeInput {
  /** 自動ログインのプロファイルか。 */
  readonly automated: boolean;
  /** プロファイルの承認したサービスの Origin の数。 */
  readonly serviceOriginCount: number;
  /** 入口の確かめの案（欄に埋めた案）の送り方が、スクリプトで送るログインか。 */
  readonly entryProposalScript: boolean;
}

/** 出す案内の文（出さないものは `null`）。 */
export interface ScriptLoginNotices {
  /** 手動のログインの後の自動の登録の案内（手動のログインのプロファイルだけ）。 */
  readonly autoRegistration: string | null;
  /** 承認したサービスの Origin がないことの誤りの文（自動ログインのプロファイルだけ）。 */
  readonly serviceOriginsRequired: string | null;
  /** 入口の確かめの案がスクリプトで送るログインのときの文。 */
  readonly entryCheckScript: string | null;
}

export const scriptLoginNoticesOf = ({ automated, serviceOriginCount, entryProposalScript }: ScriptLoginNoticeInput): ScriptLoginNotices => {
  const entryText = LOCAL_UI_ENTRY_CHECK_TEXT.authSetup;
  return {
    autoRegistration: automated ? null : LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote,
    serviceOriginsRequired: automated && serviceOriginCount === 0 ? LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.noServiceOriginsNotice : null,
    entryCheckScript: entryProposalScript ? (automated ? entryText.scriptTargetNeeded : entryText.scriptTargetAutoRegistered) : null,
  };
};
