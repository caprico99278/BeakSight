import { useState } from 'react';
import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { formatCount, formatDateTime } from '../../../../../../src/presentation/format.js';
import { LOCAL_UI_DISCOVERY_TEXT, LOCAL_UI_SCENARIO_TEXT, LOCAL_UI_TEXT, LOCAL_UI_WRITE_STAGE_TEXT } from '../../../../../../src/presentation/messages.js';
import { DiscoveryStartButton } from '../../../components/DiscoveryStartButton';
import { Notice } from '../../../components/Notice';
import { ScenarioAutoDraftPanel } from '../../../components/ScenarioAutoDraftPanel';
import { StartReasonDetails } from '../../../components/StartReasonDetails';
import { PageFrame, siteTrail } from '../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../components/ScenarioProfilePanel';
import { ScenarioStatus } from '../../../components/ScenarioStatus';
import { inputRuleStateDisplay, scenarioKindDisplay, toneClass } from '../../../display/labels';
import { emptyScenarioListEntryOf } from '../../../display/next-steps';
import type { AuditJobStartView } from '../../../server/audit-job-functions';
import { scenarioAutoDraftPreviewFn } from '../../../server/scenario-autodraft-functions';
import { scenarioListPageFn, type ScenarioSummaryView } from '../../../server/scenario-functions';

export const Route = createFileRoute('/scenarios/$profileId/')({
  loader: async ({ params }) => {
    // PL-U（設計書 14.1 の U4）: 0 件の一覧の「書き込みの手順を作る」のために、操作さがしの画面と同じ下書きの案も読む。
    const [page, autoDraft] = await Promise.all([
      scenarioListPageFn({ data: { profileId: params.profileId } }),
      scenarioAutoDraftPreviewFn({ data: { profileId: params.profileId } }),
    ]);
    if (page === null) {
      throw notFound();
    }
    return { ...page, autoDraft };
  },
  component: ScenariosPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;


/** 承認の期限の表示（有効な承認の期限。ないときは最後の承認の期限。承認の記録がなければ「なし」）。 */
const expiryText = (scenario: ScenarioSummaryView): string => {
  const expiresAt = scenario.status?.expiresAt ?? scenario.lastApprovalExpiresAt;
  return expiresAt === null ? text.noExpiry : formatDateTime(expiresAt);
};

/**
 * シナリオの一覧（Task 28 の設計書 4.6。T28e）。プロファイルの詳細から開く。シナリオごとの種類、画面と送信先、状態（下書き・承認済み・要再承認
 * （理由の一覧）・期限切れ・撤回済み）、承認の期限、上限と使った件数。書き込みを実行するボタンは置かない。
 */
function ScenariosPage() {
  const page = Route.useLoaderData();
  const router = useRouter();
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { profile, autoDraft } = page;
  const columns = text.columns;
  // PL-U（14.1 の U4）: 0 件の一覧の主のボタン「書き込みの手順を作る」の行き先（決め方は `next-steps.ts` の部品。書き込みの手順を作れるサイトだけ）。
  const entry = page.scenarios.length === 0 && page.editable ? emptyScenarioListEntryOf(autoDraft) : null;
  const createLabel = LOCAL_UI_WRITE_STAGE_TEXT.discovery.createDrafts;
  return (
    <PageFrame title={text.pages.scenarios} trail={siteTrail(profile.profileId)}>
      <ScenarioProfilePanel eligible={page.eligible} editable={page.editable} />
      {page.factsAvailable ? null : (
        <Notice kind="caution">
          <p data-testid="scenario-facts-unavailable">{text.factsUnavailable}</p>
        </Notice>
      )}
      <section className="panel" data-testid="scenario-list">
        <h2 className="panel-heading">{text.listHeading}</h2>
        <p data-testid="scenario-no-execution">{text.noExecution}</p>
        {page.scenarios.length === 0 ? <p data-testid="scenario-none">{text.noScenarios}</p> : null}
        {entry === 'CREATE_DRAFTS' ? <p>{LOCAL_UI_WRITE_STAGE_TEXT.discovery.nextCreate}</p> : null}
        {entry === 'START_DISCOVERY' ? <p data-testid="scenario-none-discovery">{text.emptyListStartDiscovery}</p> : null}
        {rejection === null ? null : (
          <Notice kind="critical" heading={LOCAL_UI_DISCOVERY_TEXT.rejectedHeading}>
            <StartReasonDetails
              profileId={profile.profileId}
              reason={rejection.reason}
              errorCodes={rejection.errorCodes}
              configError={null}
              authSetupErrors={rejection.authSetupErrors}
              nextAllowedAt={rejection.nextAllowedAt ?? null}
              showLoginCheckLink
            />
            <div className="button-row">
              <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                {LOCAL_UI_TEXT.reload}
              </button>
            </div>
          </Notice>
        )}
        {/* 下書きを作る部品は、作った後も結果を出し続けるので、書き込みの手順を作れるサイトでは置いたままにする（ボタンは 0 件のときだけ）。 */}
        {autoDraft !== null && page.editable && autoDraft.blocker === null ? (
          <ScenarioAutoDraftPanel profileId={profile.profileId} preview={autoDraft} label={createLabel} showButton={entry === 'CREATE_DRAFTS'} />
        ) : null}
        {entry === 'START_DISCOVERY' && rejection === null ? (
          <div className="button-row">
            <DiscoveryStartButton profileId={profile.profileId} revision={profile.revision} primary label={createLabel} onRejected={setRejection} />
          </div>
        ) : null}
        {page.scenarios.length === 0 ? null : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="nowrap">{columns.kind}</th>
                    <th scope="col">{columns.page}</th>
                    <th scope="col">{columns.state}</th>
                    <th scope="col">{columns.expiresAt}</th>
                    <th scope="col">{columns.limits}</th>
                    <th scope="col">{columns.inputRules}</th>
                    <th scope="col" className="nowrap">{columns.operations}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.scenarios.map((scenario) => {
                    const kind = scenarioKindDisplay(scenario.kind);
                    const inputRules = inputRuleStateDisplay(scenario.inputRuleState);
                    return (
                      <tr key={scenario.scenarioId} data-testid="scenario-row" data-scenario-id={scenario.scenarioId} data-kind={scenario.kind}
                        data-used={String(scenario.used)}>
                        <td className="nowrap"><span className={toneClass(kind.tone)}>{kind.label}</span></td>
                        {/* PL-5（設計書 3 章の 2）: 送り先・サイトのアドレス・何回目の変更かは出さない（画面のアドレスの後ろだけ）。 */}
                        <td className="cell-break">{scenario.pagePath}</td>
                        <td><ScenarioStatus status={scenario.status} showDescriptions={false} /></td>
                        <td>{expiryText(scenario)}</td>
                        <td data-testid="scenario-limits-used">
                          {text.limitsValue(formatCount(scenario.limits.maxCreatesPerRun), formatCount(scenario.used), formatCount(scenario.limits.maxCumulativeCreates))}
                        </td>
                        <td data-testid="scenario-input-rule-state" data-state={scenario.inputRuleState}>
                          <span className={toneClass(inputRules.tone)}>{inputRules.label}</span>
                        </td>
                        <td className="nowrap">
                          <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: profile.profileId, scenarioId: scenario.scenarioId }}
                            data-testid="scenario-open">
                            {text.open}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">{text.usedNote}</p>
          </>
        )}
      </section>
    </PageFrame>
  );
}
