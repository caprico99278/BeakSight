import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_SCENARIO_TEXT, LOCAL_UI_WRITE_STAGE_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../../../../src/presentation/messages.js';
import { Notice } from '../../../../components/Notice';
import { PageFrame, scenarioTrail } from '../../../../components/PageFrame';
import { ScenarioCandidateFacts } from '../../../../components/ScenarioCandidateFacts';
import { ScenarioForm } from '../../../../components/ScenarioForm';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import { scenarioDetailPageFn, scenarioFormPageFn, updateScenarioFn } from '../../../../server/scenario-functions';

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/edit')({
  loader: async ({ params }) => {
    const detail = await scenarioDetailPageFn({ data: { scenarioId: params.scenarioId } });
    if (detail === null || detail.profile.profileId !== params.profileId) {
      throw notFound();
    }
    // T38f: API のシナリオは、候補の行を型の digest で選ぶ（同じ識別で型が違う行が別に残る）。
    const shapeDigest = detail.scenario.api?.shapeDigest;
    const form = await scenarioFormPageFn({
      data: { profileId: params.profileId, candidateIdentityDigest: detail.scenario.candidateIdentityDigest, ...(shapeDigest === undefined ? {} : { shapeDigest }) },
    });
    if (form === null) {
      throw notFound();
    }
    return { detail, form };
  },
  component: EditScenarioPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;

/**
 * シナリオを変える（Task 28 の設計書 4.6。T28e）。シナリオの詳細の「変える」から開く。候補はシナリオのまま（最後の発見の結果の、同じ識別の
 * digest の候補）で、送る欄、照らす READ の定義、上限、期限、副作用の確認を変える。画面が読んだ版と違えば、保存せずに知らせる（版の衝突）。
 * 保存すると版が 1 つ進み、下書きに戻る（承認は引き継がない）。
 */
function EditScenarioPage() {
  const { detail, form } = Route.useLoaderData();
  const update = useServerFn(updateScenarioFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, scenario } = detail;
  const params = { profileId: profile.profileId, scenarioId: scenario.scenarioId };
  const { candidate } = form;

  return (
    <PageFrame title={text.pages.editScenario} trail={scenarioTrail(profile.profileId, scenario.scenarioId)}>
      <ScenarioProfilePanel eligible={detail.eligible} editable={detail.editable} />
      {!detail.editable ? null : candidate === null || form.candidateRejection !== null ? (
        <Notice kind="caution">
          <div data-testid="scenario-candidate-rejected" data-reason={form.candidateRejection ?? ''}>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[form.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].description}</p>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[form.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].action}</p>
          </div>
        </Notice>
      ) : (
        // OP-3（設計書 PL 3 章の 1）: 作成の画面と同じ形（要点 → 主のボタン 1 つ → 詳しい内容 1 つ）。候補の要点は詳しい内容の中。
        <section className="panel">
          <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
          <ScenarioForm
            key={`${scenario.scenarioId}:${String(scenario.revision)}`}
            candidate={candidate}
            detailsLead={(
              <>
                <h3>{text.targetHeading}</h3>
                <ScenarioCandidateFacts candidate={candidate} />
              </>
            )}
            readChecks={form.readChecks}
            rules={form.rules}
            update={form.update}
            api={form.api}
            initial={{
              fieldNames: scenario.fieldNames,
              readChecks: scenario.readChecks,
              sideEffectConfirmations: scenario.sideEffectConfirmations,
              maxCreatesPerRun: scenario.limits.maxCreatesPerRun,
              maxCumulativeCreates: scenario.limits.maxCumulativeCreates,
              approvalTtlDays: scenario.approvalTtlDays,
              verification: scenario.verification,
              update: scenario.update,
              api: scenario.api,
            }}
            onSave={(content) => update({ data: { scenarioId: scenario.scenarioId, expectedRevision: scenario.revision, draft: { ...content } } })}
            onSaved={() => {
              void router.invalidate().then(() => navigate({ to: '/scenarios/$profileId/$scenarioId', params, search: { notice: 'saved' } }));
            }}
            onReload={() => {
              void router.invalidate();
            }}
          />
        </section>
      )}
    </PageFrame>
  );
}
