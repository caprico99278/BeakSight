// 更新で変える欄を BeakSight が決める規則 F の唯一の置き場所（OP-2。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10）。純粋な部品
// （管理データ・ファイル・画面に依らない）。前は、変える欄を人が作成の画面で選んでいた（10 月 22 日の判断。D10 で置き換えた）。
// - 選べる欄（`usable`）: 値が決まり毎回変わる、ふつうの文字の欄で、外部へ届く語（メール・電話・通知など）でなく、その欄だけを変える下書きが今の下書きの確かめを
//   通るもの。事実は、送り方ごとの部品（フォームの形 `formUpdateChangedFieldOf`）が求める。
// - 選ぶ順: 登録で送った欄 → 登録の画面にある欄 → ほかの欄（同じ段の中は、渡された順。候補の欄・鍵の順）。1 つだけ選ぶ。
// - 選べなければ `UPDATE_CHANGED_FIELD_NOT_FOUND`（画面の一覧の行は、チェックできない形にし、理由の 1 行を出す）。
// - 値が決まり毎回変わるかの判定（`updateChangedValueVaries`）は、入れる値の決まりの owner（`data-rules/`）の推しと判定をそのまま使う（書き写さない）。
import type { CandidateField, CandidateFieldType, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { NO_FIELD_CONSTRAINTS, planRuleSet, type EvaluationScenario } from '../data-rules/field-evaluation.js';
import { inferRuleSetContent } from '../data-rules/rule-set-inference.js';
import { varyingFieldNamesOf } from '../data-rules/varying-values.js';
import { DRAFT_PROBE_LEDGER_SCENARIO_ID, DRAFT_PROBE_PATH_TEMPLATE, UNCONFIRMED_SIDE_EFFECTS } from './api-scenario-draft.js';
import { UPDATE_SCENARIO_KIND } from './scenario-contracts.js';

/** 選べない理由（閉じた一覧。画面の文言はカタログ）。 */
export const UPDATE_CHANGED_FIELD_UNAVAILABLE_REASONS = Object.freeze(['UPDATE_CHANGED_FIELD_NOT_FOUND'] as const);
export type UpdateChangedFieldUnavailableReason = (typeof UPDATE_CHANGED_FIELD_UNAVAILABLE_REASONS)[number];

/** 選んだ根拠（閉じた一覧。選ぶ順）。 */
export const UPDATE_CHANGED_FIELD_GROUNDS = Object.freeze(['SENT_BY_CREATE', 'ON_CREATE_SCREEN', 'OTHER_FIELD'] as const);
export type UpdateChangedFieldGround = (typeof UPDATE_CHANGED_FIELD_GROUNDS)[number];

/** 欄 1 つの事実。 */
export interface UpdateChangedFieldFact {
  readonly name: string;
  /** 変える欄に選べる（値が決まり毎回変わる、ふつうの文字の欄。外部へ届く語でない。下書きの確かめを通る）。 */
  readonly usable: boolean;
  /** 台帳（登録の書き込みの手順）が送った欄。 */
  readonly sentInLedger: boolean;
  /** 登録の画面にある欄。 */
  readonly onCreateScreen: boolean;
}

/** 選んだ結果。 */
export type UpdateChangedFieldChoice =
  | { readonly kind: 'CHOSEN'; readonly fieldName: string; readonly ground: UpdateChangedFieldGround }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: UpdateChangedFieldUnavailableReason };

/** 根拠ごとの、その段に入る欄か。 */
const GROUND_TESTS: Readonly<Record<UpdateChangedFieldGround, (fact: UpdateChangedFieldFact) => boolean>> = Object.freeze({
  SENT_BY_CREATE: (fact) => fact.sentInLedger,
  ON_CREATE_SCREEN: (fact) => fact.onCreateScreen,
  OTHER_FIELD: () => true,
});

/** 規則の判定のためだけの、フォームの形の更新のシナリオの形（id と型は確かめの部品の仮の値。保存しない）。 */
const probeUpdateScenarioOf = (candidate: DiscoveryCandidate, changed: string, keep: readonly string[]): EvaluationScenario => ({
  scenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID,
  kind: UPDATE_SCENARIO_KIND,
  candidate: { identityDigest: candidate.identityDigest } as EvaluationScenario['candidate'],
  fieldNames: [changed],
  sideEffectConfirmations: UNCONFIRMED_SIDE_EFFECTS,
  update: {
    targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID,
    formPathTemplate: DRAFT_PROBE_PATH_TEMPLATE,
    actionPathTemplate: DRAFT_PROBE_PATH_TEMPLATE,
    keepFieldNames: [...keep],
    // 判定は見ない（承認の有効さの確かめだけが使う）。
    templatedIdentityDigest: candidate.identityDigest,
  },
});

/**
 * 欄 `changed` の値が、推した規則で決まり、実行のたびに変わるか（`candidate` の欄で判定する。API の形は、鍵の欄を候補の欄にした写しを渡す）。
 */
export const updateChangedValueVaries = (candidate: DiscoveryCandidate, changed: string, keep: readonly string[]): boolean => {
  const scenario = probeUpdateScenarioOf(candidate, changed, keep);
  const inferred = inferRuleSetContent(scenario, candidate);
  // 選ぶ欄は外部へ届く語でない文字の欄だけなので、副作用の確認の前提によらない（承認の前の画面の前提は使わない）。
  const plan = planRuleSet({ scenarioId: scenario.scenarioId, ...inferred.content }, scenario, candidate);
  return plan.evaluation.fields.some((field) => field.fieldName === changed && field.status === 'DECIDED') && varyingFieldNamesOf(plan).includes(changed);
};

/**
 * API の鍵の判定に使う欄（鍵の名前と probe の欄の型。制約・選択肢・required はない。入れる値の決まりの owner が API の鍵を判定するときの欄と同じ形）。
 */
export const apiKeyFieldOf = (key: string, type: CandidateFieldType): CandidateField => Object.freeze({
  name: key,
  tag: type === 'textarea' ? 'textarea' : type.startsWith('select') ? 'select' : 'input',
  type,
  required: false,
  readonly: false,
  disabled: false,
  hidden: false,
  constraints: NO_FIELD_CONSTRAINTS,
  options: null,
  omittedOptionCount: 0,
  hasValue: false,
});

/** 規則 F で、変える欄を 1 つ選ぶ（選べなければ理由）。 */
export const chooseUpdateChangedField = (facts: readonly UpdateChangedFieldFact[]): UpdateChangedFieldChoice => {
  const usable = facts.filter((fact) => fact.usable);
  for (const ground of UPDATE_CHANGED_FIELD_GROUNDS) {
    const found = usable.find(GROUND_TESTS[ground]);
    if (found !== undefined) {
      return Object.freeze({ kind: 'CHOSEN', fieldName: found.name, ground });
    }
  }
  return Object.freeze({ kind: 'UNAVAILABLE', reason: 'UPDATE_CHANGED_FIELD_NOT_FOUND' });
};
