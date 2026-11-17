import { createFileRoute, notFound } from '@tanstack/react-router';
// PRE42-CC 組 UI-K（組 2 の引き継ぎ。CC-106）: シナリオの種類の値は、管理データに触れない純粋な owner から読む（文字列で比べない）。
import { UPDATE_SCENARIO_KIND } from '../../../../../../../src/core/scenario-kind.js';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_STAGE_TEXT,
  LOCAL_UI_WRITE_TEXT,
  listText,
} from '../../../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../../../components/AdvancedSettings';
import { DraftValueMark } from '../../../../components/DraftValueMark';
import { arrivedFromJobOf } from '../../../../components/JobArrival';
import { PageFrame, arrivalSearchOf, scenariosTrail } from '../../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import { ScenarioStatus } from '../../../../components/ScenarioStatus';
import { WriteResultHistory } from '../../../../components/WriteResultDetails';
import { closedListReason } from '../../../../display/server-function-outcome';
import { approvalInvalidityReasonDisplay, scenarioDisplayStateDisplay } from '../../../../display/labels';
import { getAuditJobFn } from '../../../../server/audit-job-functions';
import { scenarioDetailPageFn, type ScenarioDetailPageView } from '../../../../server/scenario-functions';

/** PL-5（設計書 3 章の 5、13 章の最後の段落）: 自動で移ってきた書き込みの作業の、終わった結果（文の鍵はカタログと同じ）。 */
const isFinishedJobResult = closedListReason(LOCAL_UI_JOB_SUMMARY_TEXT.finished);

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/')({
  // PL-5: 作業の画面から自動で移ってきた印（`arrived`。PL-V）と、どの作業から移ったか（`fromJob`。PL-2 の `JobArrival.tsx`）も受ける（サイトの詳細と同じ形）。
  validateSearch: (search: Record<string, unknown>): { arrived?: 'auto'; fromJob?: string } => {
    const fromJob = arrivedFromJobOf(search);
    return {
      ...arrivalSearchOf(search),
      ...(fromJob === null ? {} : { fromJob }),
    };
  },
  loaderDeps: ({ search }) => ({ fromJob: arrivedFromJobOf(search) }),
  loader: async ({ params, deps }) => {
    const [page, arrivedJob] = await Promise.all([
      scenarioDetailPageFn({ data: { scenarioId: params.scenarioId } }),
      deps.fromJob === null ? Promise.resolve(null) : getAuditJobFn({ data: { jobId: deps.fromJob } }),
    ]);
    if (page === null || page.profile.profileId !== params.profileId) {
      throw notFound();
    }
    return {
      ...page,
      // PL-5（3 章の 5）: 移ってきた作業の結果（このサイトのこの書き込みの手順の作業で、終わった結果のときだけ）。
      arrivedResult: arrivedJob !== null && arrivedJob.profileId === params.profileId && arrivedJob.write?.scenarioId === params.scenarioId
        && isFinishedJobResult(arrivedJob.summary.result)
        ? arrivedJob.summary.result
        : null,
    };
  },
  component: ScenarioDetailPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;
const stageText = LOCAL_UI_WRITE_STAGE_TEXT.scenario;
const writeText = LOCAL_UI_WRITE_TEXT;

/** FM2b: 自動の下書きが推した値のまま残る項目（詳しい内容。項目の名前と印だけ。値は出さない）。 */
function InferredItems({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  return (
    <ul data-testid="scenario-inferred">
      {page.inferredItems.map((item) => (
        <li key={`${item.item}:${item.value}`} data-item={item.item}>
          {LOCAL_UI_AUTO_DRAFT_TEXT.inferredItems[item.item]}{' '}
          <DraftValueMark origin={item.origin} ground={item.ground} />
        </li>
      ))}
    </ul>
  );
}

/** 要点の、今の様子の文の後に出す 1 行ずつの文（決められなかったこと・写したこと。判定はサーバの値）。 */
function SummaryLines({ page }: Readonly<{ page: ScenarioDetailPageView }>) {
  const { scenario } = page;
  return (
    <>
      {page.recordIdUndetermined ? <p data-testid="scenario-record-id-undetermined">{stageText.recordIdUndetermined}</p> : null}
      {page.missingVerification.length === 0 ? null : (
        <p data-testid="scenario-verification-missing" data-reason="VERIFICATION_SPEC_MISSING">{stageText.verificationMissing}</p>
      )}
      {page.inputRuleState === 'INSUFFICIENT' ? <p data-testid="scenario-rules-insufficient">{stageText.rulesInsufficient}</p> : null}
      {page.verificationCopied ? <p data-testid="scenario-verification-copied">{stageText.verificationCopied}</p> : null}
      {scenario.kind === UPDATE_SCENARIO_KIND && page.plannedUpdateTarget === null
        ? <p data-testid="scenario-update-no-target">{stageText.noPlannedTarget}</p>
        : null}
      {page.writes.length === 0 ? null : <p data-testid="scenario-no-cleanup">{writeText.noCleanup}</p>}
    </>
  );
}

/**
 * 書き込みの手順の詳細（Task 28 の設計書 4.6。T28e。PL-5 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。読むだけの画面。上から:
 * 要点のパネル（今の様子の文と、決められなかったこと・写したことの 1 行、次にすることの 1 行）→ 詳しい内容 1 つ（書き換えの対象、書き込みの結果、推した項目）。
 * 要求の形・検証の指定の中身・入れる値の決まりの中身・版・digest・ID は出さない。SPEC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.1）:
 * 変える・入れる値の決まり・OK・取り消し・書き込みを始めるの操作は外した（書き込みは、サイトの画面の一覧のチェックだけ）。
 */
function ScenarioDetailPage() {
  const page = Route.useLoaderData();
  const { profile, scenario, evidence, status } = page;
  const stateDescription = status === null ? text.factsUnavailable : scenarioDisplayStateDisplay(status.displayState).description;

  return (
    <PageFrame title={text.pages.scenario} trail={scenariosTrail(profile.profileId)}>
      {/* 3 章の 1: 要点のパネル（今の様子の文、1 行ずつの理由、次にすることの 1 行。13 章の 6）。 */}
      <section className="panel" data-testid="scenario-summary">
        <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
        {/* PL-5（3 章の 5、13 章の最後の段落）: 書き込みの作業から自動で移ってきたときは、要点の 1 行目に何が起きたか（作業の結果の文）。 */}
        {page.arrivedResult === null ? null : (
          <p data-testid="scenario-arrival" data-result={page.arrivedResult}>{LOCAL_UI_JOB_SUMMARY_TEXT.finished[page.arrivedResult]}</p>
        )}
        <ScenarioProfilePanel eligible={page.eligible} editable={page.editable} />
        <div data-testid="scenario-status" data-scenario-kind={scenario.kind}>
          {stateDescription === null ? null : <p data-testid="scenario-state-description">{stateDescription}</p>}
          {status === null || status.reasons.length === 0 ? null : (
            <ul data-testid="scenario-reasons">
              {status.reasons.map((reason) => <li key={reason} data-reason={reason}>{approvalInvalidityReasonDisplay(reason).label}</li>)}
            </ul>
          )}
        </div>
        <SummaryLines page={page} />
        {/* SPEC-4: 書き込みの OK・開始のボタンは外した（試すかは、サイトの画面の一覧のチェックで決める）。 */}
        {page.eligible ? <p data-testid="scenario-next-check">{stageText.nextCheck}</p> : null}
      </section>

      {/* 3 章の 1: 詳しい内容 1 つ（開かなくても流れは進む）。 */}
      <section className="panel">
        <AdvancedSettings testId="scenario-detail-advanced">
          <div data-testid="scenario-state-badge"><ScenarioStatus status={status} showDescriptions={false} /></div>
          <dl className="facts">
            <dt>{text.columns.page}</dt>
            <dd data-testid="scenario-page">{evidence.pagePath}</dd>
            <dt>{text.fieldsHeading}</dt>
            <dd data-testid="scenario-field-names">{scenario.fieldNames.length === 0 ? text.update.none : listText(scenario.fieldNames)}</dd>
            {scenario.kind !== UPDATE_SCENARIO_KIND ? null : (
              <>
                <dt>{text.update.plannedTarget}</dt>
                <dd data-testid="scenario-update-planned" data-target={page.plannedUpdateTarget ?? ''}>
                  {page.plannedUpdateTarget === null ? text.update.noPlannedTarget : page.plannedUpdateTarget}
                </dd>
              </>
            )}
          </dl>
          {page.inferredItems.length === 0 ? null : (
            <>
              <h3>{LOCAL_UI_AUTO_DRAFT_TEXT.inferredHeading}</h3>
              <InferredItems page={page} />
            </>
          )}
          <section data-testid="scenario-writes">
            <h3>{writeText.writesHeading}</h3>
            <WriteResultHistory results={page.writes} />
          </section>
        </AdvancedSettings>
      </section>

    </PageFrame>
  );
}
