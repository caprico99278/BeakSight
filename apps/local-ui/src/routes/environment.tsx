import { createFileRoute } from '@tanstack/react-router';
import { formatCount } from '../../../../src/presentation/format.js';
import { LOCAL_UI_CREDENTIAL_TEXT, LOCAL_UI_TEXT, SETUP_LOCAL_TEXT } from '../../../../src/presentation/messages.js';
import { Notice } from '../components/Notice';
import { PageFrame } from '../components/PageFrame';
import { credentialEnvironmentDisplay, toneClass } from '../display/labels';
import { environmentStatusFn } from '../server/profile-functions';

export const Route = createFileRoute('/environment')({
  loader: () => environmentStatusFn(),
  component: EnvironmentPage,
});

/** 環境の状態（設計書 4.7）。 */
function EnvironmentPage() {
  const status = Route.useLoaderData();
  const text = LOCAL_UI_TEXT.environmentStatus;
  // T26e: 資格情報の暗号化を、この環境で使えるか（サーバが起動のときに 1 回確かめた結果。値は出さない）。
  const protection = credentialEnvironmentDisplay(status.credentialEnvironment);
  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.environment}>
      {status.quickCheckOk ? null : (
        <Notice kind="critical">
          <p>{text.quickCheckProblem}</p>
        </Notice>
      )}
      <section className="panel">
        <dl className="facts" data-testid="environment-status">
          <dt>{text.nodeVersion}</dt>
          <dd>{status.nodeVersion}</dd>
          <dt>{text.sqliteVersion}</dt>
          <dd>{status.sqliteVersion}</dd>
          <dt>{text.databaseLocation}</dt>
          <dd><code>{status.databaseLocation}</code></dd>
          <dt>{text.schemaVersion}</dt>
          <dd>{text.schemaVersionText(status.schemaVersion, status.latestSchemaVersion)}</dd>
          <dt>{text.profileCounts}</dt>
          <dd>{SETUP_LOCAL_TEXT.profileCountsText(formatCount(status.profileCounts.ACTIVE), formatCount(status.profileCounts.RETIRED))}</dd>
          <dt>{text.quickCheck}</dt>
          <dd>{status.quickCheckOk ? text.quickCheckOk : text.quickCheckProblem}</dd>
          <dt>{text.listening}</dt>
          <dd>{text.listeningValue}</dd>
          <dt>{LOCAL_UI_CREDENTIAL_TEXT.environment.protection}</dt>
          <dd>
            <span className={toneClass(protection.tone)} data-testid="environment-credential-protection" data-state={status.credentialEnvironment}>
              {protection.label}
            </span>
            {protection.description === null ? null : <span className="field-hint">{protection.description}</span>}
          </dd>
        </dl>
      </section>
    </PageFrame>
  );
}
