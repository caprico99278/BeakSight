/**
 * シナリオにする候補の要点（Task 28 の設計書 4.6。T28e）。作成と変更の画面が共用する（画面、送信先、送り方、enctype、ボタンの分類の語）。
 * 値・トークン・選択肢の label は、サーバが返さない。
 */
import { LOCAL_UI_DISCOVERY_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import { candidateKindDisplay } from '../display/labels';
import type { ScenarioCandidateView } from '../server/scenario-functions';

const discoveryText = LOCAL_UI_DISCOVERY_TEXT;

export function ScenarioCandidateFacts({ candidate, showOrigins }: Readonly<{ candidate: ScenarioCandidateView; showOrigins: boolean }>) {
  const method = candidate.formMethod === null
    ? discoveryText.noAction
    : candidate.methodOverride === null ? candidate.formMethod : discoveryText.methodOverride(candidate.formMethod, candidate.methodOverride);
  return (
    <dl className="facts" data-testid="scenario-target" data-digest={candidate.identityDigest}>
      <dt>{discoveryText.columns.kind}</dt>
      <dd>{candidateKindDisplay(candidate.kind).label}</dd>
      <dt>{LOCAL_UI_SCENARIO_TEXT.columns.page}</dt>
      <dd><code>{`${showOrigins ? candidate.pageOrigin : ''}${candidate.pagePath}`}</code></dd>
      <dt>{LOCAL_UI_SCENARIO_TEXT.columns.action}</dt>
      <dd>
        <code>{candidate.actionPath === null ? discoveryText.noAction : `${showOrigins ? candidate.actionOrigin ?? '' : ''}${candidate.actionPath}`}</code>
      </dd>
      <dt>{discoveryText.columns.method}</dt>
      <dd>{method}</dd>
      <dt>{discoveryText.enctype}</dt>
      <dd>{candidate.enctype ?? discoveryText.noFlags}</dd>
      <dt>{discoveryText.submitterWords}</dt>
      <dd>{discoveryText.submitterWordsValue(candidate.submitterWords)}</dd>
    </dl>
  );
}
