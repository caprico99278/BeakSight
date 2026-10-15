import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { formatCount, formatDateTime, formatInteger } from '../../../../../../src/presentation/format.js';
import { LOCAL_UI_SCENARIO_TEXT } from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../components/ScenarioProfilePanel';
import { ScenarioStatus } from '../../../components/ScenarioStatus';
import { inputRuleStateDisplay, scenarioKindDisplay, toneClass } from '../../../display/labels';
import { scenarioListPageFn, type ScenarioSummaryView } from '../../../server/scenario-functions';

export const Route = createFileRoute('/scenarios/$profileId/')({
  loader: async ({ params }) => {
    const page = await scenarioListPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: ScenariosPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;

/** 画面と送信先の表示（Origin を示すときは、Origin と path）。 */
const locationText = (origin: string, path: string, showOrigins: boolean): string => `${showOrigins ? origin : ''}${path}`;

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
  const { profile } = page;
  const columns = text.columns;
  return (
    <PageFrame title={text.pages.scenarios}>
      <ScenarioProfilePanel profile={profile} eligible={page.eligible} editable={page.editable} />
      {page.factsAvailable ? null : (
        <Notice kind="caution">
          <p data-testid="scenario-facts-unavailable">{text.factsUnavailable}</p>
        </Notice>
      )}
      <section className="panel" data-testid="scenario-list">
        <h2 className="panel-heading">{text.listHeading}</h2>
        <p data-testid="scenario-no-execution">{text.noExecution}</p>
        {page.scenarios.length === 0 ? <p data-testid="scenario-none">{text.noScenarios}</p> : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="nowrap">{columns.kind}</th>
                    <th scope="col">{columns.page}</th>
                    <th scope="col">{columns.action}</th>
                    <th scope="col">{columns.state}</th>
                    <th scope="col">{columns.expiresAt}</th>
                    <th scope="col">{columns.limits}</th>
                    <th scope="col">{columns.inputRules}</th>
                    <th scope="col" className="nowrap">{columns.revision}</th>
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
                        <td className="cell-break"><code>{locationText(scenario.pageOrigin, scenario.pagePath, page.showOrigins)}</code></td>
                        <td className="cell-break"><code>{locationText(scenario.actionOrigin, scenario.actionPath, page.showOrigins)}</code></td>
                        <td><ScenarioStatus status={scenario.status} showDescriptions={false} /></td>
                        <td>{expiryText(scenario)}</td>
                        <td data-testid="scenario-limits-used">
                          {text.limitsValue(formatCount(scenario.limits.maxCreatesPerRun), formatCount(scenario.used), formatCount(scenario.limits.maxCumulativeCreates))}
                        </td>
                        <td data-testid="scenario-input-rule-state" data-state={scenario.inputRuleState}>
                          <span className={toneClass(inputRules.tone)}>{inputRules.label}</span>
                        </td>
                        <td className="nowrap">{text.revisionValue(formatInteger(scenario.revision))}</td>
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
      <div className="button-row">
        <Link to="/discovery/$profileId" params={{ profileId: profile.profileId }} className="button">{text.openDiscovery}</Link>
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}
