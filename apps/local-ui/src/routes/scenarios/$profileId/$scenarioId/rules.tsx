import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatDateTime, formatInteger } from '../../../../../../../src/presentation/format.js';
import { LOCAL_UI_DATA_RULE_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../../../../../src/presentation/messages.js';
import { DataRuleForm } from '../../../../components/DataRuleForm';
import { Notice } from '../../../../components/Notice';
import { PageFrame } from '../../../../components/PageFrame';
import { ScenarioProfilePanel } from '../../../../components/ScenarioProfilePanel';
import { inputRuleStateDisplay, toneClass } from '../../../../display/labels';
import { dataRulePageFn, saveDataRulesFn, type DataRuleExampleValueView, type DataRulePageView } from '../../../../server/data-rule-functions';

/** 操作の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const NOTICES = Object.freeze(['saved'] as const);
type DataRuleNotice = (typeof NOTICES)[number];
const isDataRuleNotice = (value: unknown): value is DataRuleNotice => NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/scenarios/$profileId/$scenarioId/rules')({
  validateSearch: (search: Record<string, unknown>): { notice?: DataRuleNotice } =>
    (isDataRuleNotice(search['notice']) ? { notice: search['notice'] } : {}),
  loader: async ({ params }) => {
    const page = await dataRulePageFn({ data: { scenarioId: params.scenarioId } });
    if (page === null || page.profile.profileId !== params.profileId) {
      throw notFound();
    }
    return page;
  },
  component: DataRulePage,
});

const text = LOCAL_UI_DATA_RULE_TEXT;
const scenarioText = LOCAL_UI_SCENARIO_TEXT;

/** 例の値の表示（送らない値と、合成の形の印）。 */
function ExampleValue({ value }: Readonly<{ value: DataRuleExampleValueView }>) {
  if (value.value === null) {
    return <span className={toneClass('neutral')}>{text.notSent}</span>;
  }
  return (
    <>
      <code>{value.value}</code>
      {value.synthetic === null ? null : (
        <span className="field-hint" data-testid="data-rule-synthetic" data-synthetic={value.synthetic}>
          {value.synthetic === 'EMAIL' ? text.syntheticEmail : text.syntheticPhone}
        </span>
      )}
    </>
  );
}

/** データの例（送らない）。 */
function Examples({ page }: Readonly<{ page: DataRulePageView }>) {
  if (page.examples === null) {
    return <p data-testid="data-rule-examples-unavailable">{text.examplesUnavailable}</p>;
  }
  return (
    <>
      {page.examples.map((example) => (
        <div key={example.index} className="table-wrap">
          <table data-testid="data-rule-example" data-index={String(example.index)}>
            <caption>{text.exampleLabel(formatInteger(example.index))}</caption>
            <thead>
              <tr>
                <th scope="col">{text.exampleColumns.field}</th>
                <th scope="col">{text.exampleColumns.value}</th>
              </tr>
            </thead>
            <tbody>
              {example.values.map((value) => (
                <tr key={value.fieldName} data-field-name={value.fieldName}>
                  <th scope="row"><code>{value.fieldName}</code></th>
                  <td className="cell-break"><ExampleValue value={value} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/**
 * 入力の規則（補完）の画面（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。シナリオの詳細の「入力の規則を開く」から開く。送る欄ごとの判定（状態と
 * 細分、出どころ、外部到達）、人の規則の編集、欄どうしの関係、一意にする欄の組、データの例（送らない）。保存は確認のダイアログの後だけで、保存すると
 * シナリオの版が上がり、下書きに戻る（再承認）。書き込みのモードでないプロファイルでは、編集とデータの例を出さない。
 */
function DataRulePage() {
  const page = Route.useLoaderData();
  const { notice } = Route.useSearch();
  const save = useServerFn(saveDataRulesFn);
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, scenario, ruleSet } = page;
  const params = { profileId: profile.profileId, scenarioId: scenario.scenarioId };
  const state = inputRuleStateDisplay(page.inputRuleState);

  return (
    <PageFrame title={text.pages.rules}>
      {notice === undefined ? null : (
        <Notice kind="positive">
          <p data-testid="data-rule-notice" data-notice={notice}>{text.saved}</p>
        </Notice>
      )}
      <ScenarioProfilePanel profile={profile} eligible={page.eligible} editable={page.editable} />
      {!page.eligible ? null : (
        <>
          <section className="panel" data-testid="data-rule-state" data-state={page.inputRuleState} data-scenario-id={scenario.scenarioId}
            data-revision={String(scenario.revision)}>
            <h2 className="panel-heading">{text.stateHeading}</h2>
            <p>{text.intro}</p>
            <p data-testid="data-rule-no-execution">{text.noExecution}</p>
            <dl className="facts">
              <dt>{text.stateHeading}</dt>
              <dd><span className={toneClass(state.tone)}>{state.label}</span>{state.description === null ? null : <span className="field-hint">{state.description}</span>}</dd>
              <dt>{text.ruleSetLabel}</dt>
              <dd data-testid="data-rule-rule-set">
                {ruleSet === null ? text.noRuleSet : `${text.ruleSetValue(ruleSet.ruleSetId, formatInteger(ruleSet.revision))} ${formatDateTime(ruleSet.createdAt)}`}
              </dd>
              <dt>{scenarioText.columns.revision}</dt>
              <dd>{scenarioText.revisionValue(formatInteger(scenario.revision))}</dd>
            </dl>
          </section>

          <section className="panel" data-testid="data-rule-editor">
            <h2 className="panel-heading">{text.fieldsHeading}</h2>
            <DataRuleForm
              key={`${scenario.scenarioId}:${String(scenario.revision)}:${String(ruleSet?.revision ?? 0)}`}
              page={page}
              onSave={(content) => save({
                data: {
                  scenarioId: scenario.scenarioId,
                  expectedScenarioRevision: scenario.revision,
                  expectedRuleSetRevision: ruleSet?.revision ?? null,
                  fieldRules: [...content.fieldRules],
                  relations: [...content.relations],
                  uniqueKeyFieldNames: [...content.uniqueKeyFieldNames],
                },
              })}
              onSaved={() => {
                void router.invalidate().then(() => navigate({ to: '/scenarios/$profileId/$scenarioId/rules', params, search: { notice: 'saved' }, replace: true }));
              }}
              onReload={() => {
                void router.invalidate();
              }}
            />
          </section>

          <section className="panel" data-testid="data-rule-examples">
            <h2 className="panel-heading">{text.examplesHeading}</h2>
            <p>{text.examplesNote}</p>
            <Examples page={page} />
          </section>
        </>
      )}
      <div className="button-row">
        <Link to="/scenarios/$profileId/$scenarioId" params={params} className="button">{text.backToScenario}</Link>
      </div>
    </PageFrame>
  );
}
