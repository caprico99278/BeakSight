/**
 * プロファイルの要点の欄（改訂、監査モード、認証の方式、状態）。操作の候補の画面・READ の確かめの画面・シナリオの画面が共用する（CCX-29。
 * CC-080 の (b)）。画面ごとに違うのは、欄の目印（`data-testid`）だけ。
 */
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { auditModeDisplay, authStrategyDisplay, profileStatusDisplay, toneClass } from '../display/labels';
import type { DiscoveryProfileView } from '../server/discovery-documents';

export function ProfileSummary({ profile, testId }: Readonly<{ profile: DiscoveryProfileView; testId: string }>) {
  const status = profileStatusDisplay(profile.status);
  return (
    <section className="panel">
      <h2 className="panel-heading">{profile.profileId}</h2>
      <dl className="facts" data-testid={testId}>
        <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
        <dd>{LOCAL_UI_TEXT.profileForm.revisionText(profile.revision)}</dd>
        <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
        <dd>{auditModeDisplay(profile.mode).label}</dd>
        <dt>{LOCAL_UI_TEXT.profileList.columns.auth}</dt>
        <dd>{authStrategyDisplay(profile.auth).label}</dd>
        <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
        <dd><span className={toneClass(status.tone)}>{status.label}</span></dd>
      </dl>
    </section>
  );
}
