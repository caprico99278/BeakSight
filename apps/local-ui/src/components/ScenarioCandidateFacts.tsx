/**
 * シナリオにする候補の要点（Task 28 の設計書 4.6。T28e）。作成と変更の画面が共用する。PL-5（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2）:
 * 画面のアドレスの後ろと、ボタンの語だけを出す（送信先・送り方・enctype・候補の種類・サイトのアドレスは出さない）。
 * 値・トークン・選択肢の label は、サーバが返さない。
 */
import { LOCAL_UI_DISCOVERY_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import type { ScenarioCandidateView } from '../server/scenario-functions';

const discoveryText = LOCAL_UI_DISCOVERY_TEXT;

export function ScenarioCandidateFacts({ candidate }: Readonly<{ candidate: ScenarioCandidateView }>) {
  return (
    <dl className="facts" data-testid="scenario-target" data-digest={candidate.identityDigest}>
      <dt>{LOCAL_UI_SCENARIO_TEXT.columns.page}</dt>
      <dd>{candidate.pagePath}</dd>
      <dt>{discoveryText.submitterWords}</dt>
      <dd>{discoveryText.submitterWordsValue(candidate.submitterWords)}</dd>
    </dl>
  );
}
