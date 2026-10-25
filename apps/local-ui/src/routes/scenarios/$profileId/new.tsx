import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import type { SideEffectConfirmation } from '../../../../../../src/control/approval-view.js';
import { LOCAL_UI_AUTO_DRAFT_TEXT, LOCAL_UI_SCENARIO_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../../../src/presentation/messages.js';
import { DraftValueMark } from '../../../components/DraftValueMark';
import { Notice } from '../../../components/Notice';
import { PageFrame } from '../../../components/PageFrame';
import { ScenarioCandidateFacts } from '../../../components/ScenarioCandidateFacts';
import { ScenarioForm } from '../../../components/ScenarioForm';
import { ScenarioProfilePanel } from '../../../components/ScenarioProfilePanel';
import { createScenarioFn, scenarioFormPageFn } from '../../../server/scenario-functions';
import { attachAutoDraftRulesFn } from '../../../server/scenario-autodraft-functions';
import { AUTO_DRAFT_SEARCH_MARK, isAutoDraftSearchMark } from '../../../display/auto-draft-search';

/** 識別の digest の形（`sha256:` と小文字の 16 進 64 桁）。形が違えば、候補を選んでいない扱いにする。 */
const IDENTITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

interface NewScenarioSearch {
  readonly candidate?: string;
  readonly shape?: string;
  /**
   * FM2b: 前もって選ぶ台帳と更新の画面の型（案。確かめは今の保存の口）。FM2R の Minor 13: 形の確かめは画面に書き写さない（画面のサーバが、選択肢に
   * あるものだけを受ける。選択肢にない値は選ばない）。
   */
  readonly ledger?: string;
  readonly template?: string;
  /** FM2b: 自動の下書きの案内から開いたか（保存の後に、推した入力の規則を付ける。印の値は `auto-draft-search.ts`）。 */
  readonly autoDraft?: typeof AUTO_DRAFT_SEARCH_MARK;
}

export const Route = createFileRoute('/scenarios/$profileId/new')({
  validateSearch: (search: Record<string, unknown>): NewScenarioSearch => {
    const candidate = search['candidate'];
    // T38f: API の候補の行を選ぶ型の digest（同じ形。形が違えば、型を選んでいない扱い）。
    const shape = search['shape'];
    const ledger = search['ledger'];
    const template = search['template'];
    return {
      ...(typeof candidate === 'string' && IDENTITY_DIGEST_PATTERN.test(candidate) ? { candidate } : {}),
      ...(typeof shape === 'string' && IDENTITY_DIGEST_PATTERN.test(shape) ? { shape } : {}),
      ...(typeof ledger === 'string' ? { ledger } : {}),
      ...(typeof template === 'string' ? { template } : {}),
      ...(isAutoDraftSearchMark(search['autoDraft']) ? { autoDraft: AUTO_DRAFT_SEARCH_MARK } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ candidate: search.candidate, shape: search.shape, ledger: search.ledger, template: search.template }),
  loader: async ({ params, deps }) => {
    if (deps.candidate === undefined) {
      throw notFound();
    }
    const page = await scenarioFormPageFn({
      data: {
        profileId: params.profileId,
        candidateIdentityDigest: deps.candidate,
        ...(deps.shape === undefined ? {} : { shapeDigest: deps.shape }),
        ...(deps.ledger === undefined ? {} : { ledgerScenarioId: deps.ledger }),
        ...(deps.template === undefined ? {} : { formPathTemplate: deps.template }),
      },
    });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: NewScenarioPage,
});

const text = LOCAL_UI_SCENARIO_TEXT;
const autoDraftText = LOCAL_UI_AUTO_DRAFT_TEXT;
/** 作成したシナリオの版。 */
const FIRST_SCENARIO_REVISION = 1;

/**
 * シナリオを作る（Task 28 の設計書 4.6。T28e）。候補の画面の、登録（CREATE）・更新（UPDATE）の候補の「シナリオを作る」から開く。送る欄、照らす
 * READ の定義、上限、期限、副作用の確認を決める。保存はサーバの確かめと保存の部品が決め、拒まれたら理由を項目ごとに出す。
 */
function NewScenarioPage() {
  const page = Route.useLoaderData();
  const { autoDraft } = Route.useSearch();
  const create = useServerFn(createScenarioFn);
  const attachRules = useServerFn(attachAutoDraftRulesFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, candidate, rules } = page;
  // FM2b: 自動の下書きの案内から開いた更新（変える欄は人が必ず選ぶ。保存の後に、推した入力の規則を付ける）。
  const guided = autoDraft === AUTO_DRAFT_SEARCH_MARK && page.api !== null && page.api.preset !== null;
  const preset = page.api?.preset ?? null;

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
          {!guided || preset === null ? null : (
            <Notice kind="caution">
              <div data-testid="auto-draft-form-guide">
                <p>{autoDraftText.form.chooseChangedFields}</p>
                {preset.ledger !== null ? null : (
                  <p data-testid="auto-draft-form-ledger-guide">{preset.ledgerOptionCount === 0 ? autoDraftText.form.noLedger : autoDraftText.form.chooseLedger}</p>
                )}
                {preset.ledger === null && preset.formPathTemplate === null ? null : (
                  <dl className="facts" data-testid="auto-draft-form-preset">
                    {preset.ledger === null ? null : (
                      <>
                        <dt>{autoDraftText.form.presetLedger}</dt>
                        <dd data-testid="auto-draft-form-preset-ledger" data-value={preset.ledger.value}>
                          <code>{preset.ledger.value}</code>{' '}
                          {preset.ledger.origin === null || preset.ledger.ground === null ? null
                            : <DraftValueMark origin={preset.ledger.origin} ground={preset.ledger.ground} />}
                        </dd>
                      </>
                    )}
                    {preset.formPathTemplate === null ? null : (
                      <>
                        <dt>{autoDraftText.form.presetFormPathTemplate}</dt>
                        <dd data-testid="auto-draft-form-preset-template" data-value={preset.formPathTemplate.value}>
                          <code>{preset.formPathTemplate.value}</code>{' '}
                          {preset.formPathTemplate.origin === null || preset.formPathTemplate.ground === null ? null
                            : <DraftValueMark origin={preset.formPathTemplate.origin} ground={preset.formPathTemplate.ground} />}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            </Notice>
          )}
          <ScenarioForm
            candidate={candidate}
            readChecks={page.readChecks}
            rules={rules}
            update={page.update}
            api={page.api}
            initial={{
              fieldNames: [],
              readChecks: [],
              sideEffectConfirmations: Object.fromEntries(rules.sideEffects.map((item) => [item, false])) as Record<SideEffectConfirmation, boolean>,
              maxCreatesPerRun: rules.maxCreatesPerRun,
              maxCumulativeCreates: rules.maxCumulativeCreates,
              approvalTtlDays: rules.maxTtlDays,
              verification: { successCondition: null, inputErrorCondition: null, recordId: null, readVerification: null },
              update: null,
              api: null,
            }}
            onSave={(content) => create({ data: { draft: { profileId: profile.profileId, candidateIdentityDigest: candidate.identityDigest, ...content } } })}
            onSaved={(scenarioId) => {
              const open = (notice: 'saved' | 'autoRules' | 'autoRulesFailed'): void => {
                void navigate({ to: '/scenarios/$profileId/$scenarioId', params: { profileId: profile.profileId, scenarioId }, search: { notice } });
              };
              if (!guided) {
                open('saved');
                return;
              }
              // FM2b: 案内から開いた更新だけ、保存した版（作成は版 1）に、推した入力の規則を付ける（承認の前）。
              void attachRules({ data: { scenarioId, expectedRevision: FIRST_SCENARIO_REVISION } })
                .then((attached) => open(attached.ok ? 'autoRules' : 'autoRulesFailed'), () => open('autoRulesFailed'));
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
