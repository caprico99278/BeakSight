import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { LOCAL_UI_AUTO_DRAFT_TEXT, LOCAL_UI_SCENARIO_TEXT, LOCAL_UI_WRITE_STAGE_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../../../src/presentation/messages.js';
import { Notice } from '../../../components/Notice';
import { PageFrame, scenariosTrail } from '../../../components/PageFrame';
import { ScenarioCandidateFacts } from '../../../components/ScenarioCandidateFacts';
import { ScenarioForm } from '../../../components/ScenarioForm';
import { ScenarioProfilePanel } from '../../../components/ScenarioProfilePanel';
import { createScenarioFn, scenarioFormPageFn } from '../../../server/scenario-functions';
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

/**
 * シナリオを作る（Task 28 の設計書 4.6。T28e）。候補の画面の、登録（CREATE）・更新（UPDATE）の候補の「シナリオを作る」から開く。送る欄、照らす
 * READ の定義、上限、期限、副作用の確認を決める。保存はサーバの確かめと保存の部品が決め、拒まれたら理由を項目ごとに出す。
 */
function NewScenarioPage() {
  const page = Route.useLoaderData();
  const { autoDraft } = Route.useSearch();
  const create = useServerFn(createScenarioFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, candidate, rules } = page;
  // FM2b: 自動の下書きの案内から開いた更新（変える欄は人が必ず選ぶ。保存の後に、推した入力の規則を付ける）。
  const guided = autoDraft === AUTO_DRAFT_SEARCH_MARK && page.api !== null && page.api.preset !== null;
  const preset = page.api?.preset ?? null;

  return (
    <PageFrame title={text.pages.newScenario} trail={scenariosTrail(profile.profileId)}>
      <ScenarioProfilePanel eligible={page.eligible} editable={page.editable} />
      {!page.editable ? null : candidate === null || page.candidateRejection !== null ? (
        <Notice kind="caution">
          <div data-testid="scenario-candidate-rejected" data-reason={page.candidateRejection ?? ''}>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[page.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].description}</p>
            <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[page.candidateRejection ?? 'SCENARIO_CANDIDATE_UNKNOWN'].action}</p>
          </div>
        </Notice>
      ) : (
        // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12 の 4、`2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 直す道として残るので、
        // 3 章の形（要点 → 主のボタン 1 つ → 詳しい内容 1 つ）にそろえる。候補の要点（画面のアドレスの後ろ）と、書き込みをしないことの文は、詳しい内容の中。
        <section className="panel" data-testid="scenario-new-summary">
          <h2 className="panel-heading">{LOCAL_UI_WRITE_STAGE_TEXT.summaryHeading}</h2>
          {!guided || preset === null ? null : (
            <Notice kind="caution">
              <div data-testid="auto-draft-form-guide">
                <p>{autoDraftText.form.chooseChangedFields}</p>
                {preset.ledger !== null ? null : (
                  <p data-testid="auto-draft-form-ledger-guide">{preset.ledgerOptionCount === 0 ? autoDraftText.form.noLedger : autoDraftText.form.chooseLedger}</p>
                )}
                {/* PL-5（設計書 3 章の 2）: 前もって選んだ作ったデータの一覧と画面の形（ID とアドレスの形）は出さない（下の欄が選んだ形で始まる）。 */}
              </div>
            </Notice>
          )}
          <ScenarioForm
            candidate={candidate}
            detailsLead={(
              <>
                <h3>{text.targetHeading}</h3>
                <ScenarioCandidateFacts candidate={candidate} />
                <p>{text.noExecution}</p>
              </>
            )}
            // 作ったデータの一覧を前もって選べなかったときは、選ぶ欄のある詳しい内容を開いて出す。
            openDetails={guided && preset !== null && preset.ledger === null}
            readChecks={page.readChecks}
            rules={rules}
            update={page.update}
            api={page.api}
            initial={{
              fieldNames: [],
              readChecks: [],
              // MI-F3（MI-R の Minor 12）: 初めの値は、サーバが渡す下書きの部品の定数（`UNCONFIRMED_SIDE_EFFECTS`）。ここで組み立てない。
              sideEffectConfirmations: rules.unconfirmedSideEffects,
              maxCreatesPerRun: rules.maxCreatesPerRun,
              maxCumulativeCreates: rules.maxCumulativeCreates,
              approvalTtlDays: rules.maxTtlDays,
              verification: { resultJudgement: null, recordId: null, readVerification: null },
              update: null,
              api: null,
            }}
            onSave={(content) => create({ data: { draft: { profileId: profile.profileId, candidateIdentityDigest: candidate.identityDigest, ...content } } })}
            onSaved={(saved) => {
              // PL-5 の 9 の (1): 推した入れる値の決まりは、保存の口が保存のときに付ける（画面は付けない）。案内から開いた更新だけ、付けたかの知らせを出す。
              const notice = !guided ? 'saved' : saved.rules?.attached === true ? 'autoRules' : 'autoRulesFailed';
              void navigate({ to: '/scenarios/$profileId/$scenarioId', params: { profileId: profile.profileId, scenarioId: saved.scenarioId }, search: { notice } });
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
