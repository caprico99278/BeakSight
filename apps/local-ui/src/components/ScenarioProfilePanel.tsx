/**
 * シナリオの画面の、プロファイルの要点と、使えないときの知らせ（Task 28 の設計書 4.6。T28e）。一覧・作成・詳細・変更の画面が共用する。
 * 使えない（書き込みのモードでない）・取り消したプロファイルでは、作る・変える・承認するを出さないことを知らせる。
 * プロファイルの要点の欄は、操作の候補の画面・READ の確かめの画面と共用の `ProfileSummary`（CCX-29）。
 */
import { LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import type { DiscoveryProfileView } from '../server/discovery-documents';
import { Notice } from './Notice';
import { ProfileSummary } from './ProfileSummary';

export function ScenarioProfilePanel({ profile, eligible, editable }: Readonly<{ profile: DiscoveryProfileView; eligible: boolean; editable: boolean }>) {
  return (
    <>
      <ProfileSummary profile={profile} testId="scenario-profile" />
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
