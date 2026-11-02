/**
 * シナリオの画面の、使えないときの知らせ（Task 28 の設計書 4.6。T28e）。一覧・作成・詳細・変更の画面が共用する。
 * 使えない（書き込みのモードでない）・取り消したプロファイルでは、作る・変える・承認するを出さないことを知らせる。
 * PL-5（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: プロファイルの要点の欄（改訂・監査モード・認証の方式・状態）は出さない（どのサイトかは
 * 今どこにいるかの 1 行が示す）。知らせは、使う画面の要点のパネルの中に置く。
 */
import { LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import { Notice } from './Notice';

export function ScenarioProfilePanel({ eligible, editable }: Readonly<{ eligible: boolean; editable: boolean }>) {
  return (
    <>
      {eligible ? null : (
        <Notice kind="caution">
          <p data-testid="scenario-not-eligible">{LOCAL_UI_SCENARIO_TEXT.notEligible}</p>
        </Notice>
      )}
      {eligible && !editable ? (
        <Notice kind="caution">
          <p data-testid="scenario-retired">{LOCAL_UI_SCENARIO_TEXT.retired}</p>
        </Notice>
      ) : null}
    </>
  );
}
