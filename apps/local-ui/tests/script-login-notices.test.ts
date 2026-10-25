/**
 * T44h の判断 (2)（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」の行。測りの記録 `T44h-after.md` の 3.6 の N3）: 認証の設定の画面の、
 * スクリプトで送るログインの案内（`scriptLoginNoticesOf`）。
 * - 手動のログインのプロファイル: 送信先・鍵・承認したサービスの Origin は、手動のログインの後の自動の登録が埋めるので、自動の登録の案内だけを出す。
 *   承認したサービスの Origin がなくても、赤い文（先にプロファイルで足す）は出さない（足すと改訂が進み、認証の設定が古くなって手順が増える）。入口の確かめの
 *   案の文も、自動の登録に合わせる（「観察してから入れてください」と言わない）。
 * - 自動ログインのプロファイル: 今どおり。全部の欄が要るので、承認したサービスの Origin がなければ赤い文を出し、入口の確かめの案の文は「観察してから入れる」。
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_SCRIPT_LOGIN_TEXT } from '../../../src/presentation/messages.js';
import { scriptLoginNoticesOf } from '../src/display/script-login-notices';

describe('T44h (2): the script login notices on the auth setup screen', () => {
  it('shows only the automatic registration guidance to a manual login profile without the service origins (N3)', () => {
    const notices = scriptLoginNoticesOf({ automated: false, serviceOriginCount: 0, entryProposalScript: true });
    expect(notices).toEqual({
      autoRegistration: LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote,
      serviceOriginsRequired: null,
      entryCheckScript: LOCAL_UI_ENTRY_CHECK_TEXT.authSetup.scriptTargetAutoRegistered,
    });
    // 3 つの文は食い違わない: プロファイルで先に足す、観察してから入れる、とは言わない。
    const texts = [notices.autoRegistration, notices.entryCheckScript].join(' ');
    expect(texts).not.toContain(LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.noServiceOriginsNotice);
    expect(texts).not.toContain('観察してから入れて');
    expect(texts).not.toContain('先にプロファイルの画面で足して');
    expect(notices.autoRegistration).toContain('承認したサービスの Origin');
    expect(notices.entryCheckScript).toContain('空のまま保存');
  });

  it('keeps the guidance of a manual login profile with the service origins, and shows no entry check text without the script proposal', () => {
    expect(scriptLoginNoticesOf({ automated: false, serviceOriginCount: 1, entryProposalScript: false })).toEqual({
      autoRegistration: LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote,
      serviceOriginsRequired: null,
      entryCheckScript: null,
    });
  });

  it('keeps the automated login profile as now: the red text without the service origins and the entry check text to observe first', () => {
    expect(scriptLoginNoticesOf({ automated: true, serviceOriginCount: 0, entryProposalScript: true })).toEqual({
      autoRegistration: null,
      serviceOriginsRequired: LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.noServiceOriginsNotice,
      entryCheckScript: LOCAL_UI_ENTRY_CHECK_TEXT.authSetup.scriptTargetNeeded,
    });
    expect(scriptLoginNoticesOf({ automated: true, serviceOriginCount: 2, entryProposalScript: false })).toEqual({
      autoRegistration: null,
      serviceOriginsRequired: null,
      entryCheckScript: null,
    });
  });
});
