import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { SideEffectConfirmation } from '../../../../../../src/control/approval-view.js';
import { LOCAL_UI_SCENARIO_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ScenarioCandidateFacts } from '../../../components/ScenarioCandidateFacts';
import { ScenarioForm } from '../../../components/ScenarioForm';
import { ScenarioProfilePanel } from '../../../components/ScenarioProfilePanel';
import { createScenarioFn, scenarioFormPageFn } from '../../../server/scenario-functions';

/** 識別の digest の形（`sha256:` と小文字の 16 進 64 桁）。形が違えば、候補を選んでいない扱いにする。 */
const IDENTITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const Route = createFileRoute('/scenarios/$profileId/new')({
  validateSearch: (search: Record<string, unknown>): { candidate?: string } => {
    const candidate = search['candidate'];
    return typeof candidate === 'string' && IDENTITY_DIGEST_PATTERN.test(candidate) ? { candidate } : {};
  },
  loaderDeps: ({ search }) => ({ candidate: search.candidate }),
  loader: async ({ params, deps }) => {
    if (deps.candidate === undefined) {
      throw notFound();
    }
    const page = await scenarioFormPageFn({ data: { profileId: params.profileId, candidateIdentityDigest: deps.candidate } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: NewScenarioPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;

/**
 * シナリオを作る（Task 28 の設計書 4.6。T28e）。候補の画面の、登録（CREATE）・更新（UPDATE）の候補の「シナリオを作る」から開く。送る欄、照らす
 * READ の定義、上限、期限、副作用の確認を決める。保存はサーバの確かめと保存の部品が決め、拒まれたら理由を項目ごとに出す。
 */
function NewScenarioPage() {
  const page = Route.useLoaderData();
  const create = useServerFn(createScenarioFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, candidate, rules } = page;

  return (
    <PageFrame title={text.pages.newScenario}>
      <ScenarioProfilePanel profile={profile} eligible={page.eligible} editable={page.editable} />
      {!page.editable ? null : candidate === null || page.candidateRejection !== null ? (
        <Notice kind="caution">
          <div data-testid="scenario-candidate-rejected" data-reason={page.candidateRejection ?? ''}>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[page.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].description}</p>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[page.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].action}</p>
          </div>
        </Notice>
      ) : (
        <section className="panel">
          <h2 className="panel-heading">{text.targetHeading}</h2>
          <ScenarioCandidateFacts candidate={candidate} showOrigins={page.showOrigins} />
          <h2 className="panel-heading">{text.formHeading}</h2>
          <p>{text.noExecution}</p>
          <ScenarioForm
            candidate={candidate}
            readChecks={page.readChecks}
            rules={rules}
            update={page.update}
            initial={{
              fieldNames: [],
              readChecks: [],
              sideEffectConfirmations: Object.fromEntries(rules.sideEffects.map((item) => [item, false])) as Record<SideEffectConfirmation, boolean>,
              maxCreatesPerRun: rules.maxCreatesPerRun,
              maxCumulativeCreates: rules.maxCumulativeCreates,
              approvalTtlDays: rules.maxTtlDays,
              verification: { successCondition: null, inputErrorCondition: null, recordId: null, readVerification: null },
              update: null,
            }}
            onSave={(content) => create({ data: { draft: { profileId: profile.profileId, candidateIdentityDigest: candidate.identityDigest, ...content } } })}
            onSaved={(scenarioId) => {
              void navigate({ to: '/scenarios/$profileId/$scenarioId', params: { profileId: profile.profileId, scenarioId }, search: { notice: 'saved' } });
            }}
            onReload={() => {
              void router.invalidate();
            }}
          />
        </section>
      )}
      <div className="button-row">
        <Link to="/scenarios/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToList}</Link>
        <Link to="/discovery/$profileId" params={{ profileId: profile.profileId }} className="button">{text.openDiscovery}</Link>
      </div>
    </PageFrame>
  );
}
