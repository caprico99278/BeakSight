// 実行のたびに変わる値の判定（T40R2-fix。Task 40 の設計書 7 章の「T40R2」の行の M-1）。純粋な関数。
// - `varyingFieldNamesOf(planned)`: 入力の規則の値の作り方（`planRuleSet` の `plans`）から、実行のたびに変わりうる欄（2 つ以上の値を作りうる欄）の名前。
//   毎回同じ値になる欄（1 つの値だけの固定の一覧、「送らない」側、値が 1 つしかない範囲、1 つしかない辞書の値など）は入れない。値の空間を求められない
//   欄も入れない（止める側に寄せる）。メールと電話は、合成の番号が実行のたびに変わる。
// - `readVerificationVaryingRejectionOf(ruleSet, scenario, candidate)`: API のシナリオの、送る値を持たない照合の READ（`{id}` の型の画面の READ。結び付けが
//   0 件）は、実行のたびに変わる値と比べる期待（`hasGeneratedValueExpectation` に、比べる欄が変わる欄かの述語を渡す）を 1 つ以上求める。外れれば
//   `READ_VERIFICATION_NOT_VARYING`。FORM のシナリオ、候補の READ（結び付けで生成した値を送る）、規則が実行できない規則の集まり（ほかの理由で止まる）は
//   null。許可の発行（`scenario-store.ts` の `issueIn`）と開始の画面が使う唯一の判定。シナリオの保存の時は規則がないので、種類だけで確かめる
//   （`scenario-policy.ts`）。
import type { ExecutionGrantRejectionReason } from '../approval/execution-grant.js';
import { API_SCENARIO_TRANSPORT, scenarioTransportOf, type ScenarioRevision } from '../approval/scenario-contracts.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { hasGeneratedValueExpectation } from '../../discovery/read-check-contracts.js';
import {
  MAX_RELATION_SIDE_VALUES,
  personValueOf,
  planRuleSet,
  type EvaluationScenario,
  type FieldPlan,
  type RuleSetPlan,
} from './field-evaluation.js';
import { genericValueSampleOf, multiplyDecimalIntegers } from './generic-values.js';
import type { RuleSetRevision } from './rule-contracts.js';

/** 照合の READ の期待が、実行のたびに変わる値と比べない理由（許可の発行を拒む理由の一覧の要素）。 */
export const READ_VERIFICATION_NOT_VARYING = 'READ_VERIFICATION_NOT_VARYING' satisfies ExecutionGrantRejectionReason;

/** 変わると言える、異なる値の最小の数。 */
const MIN_VARYING_VALUES = 2;

/** 値の一覧が、異なる値を 2 つ以上持つか。 */
const hasTwoValues = (values: readonly (string | null)[]): boolean => new Set(values).size >= MIN_VARYING_VALUES;

/** 欄の値の作り方が、実行のたびに変わりうるか。 */
const planVaries = (plan: FieldPlan, planned: RuleSetPlan): boolean => {
  switch (plan.kind) {
    case 'OPT_OUT':
      return false;
    case 'FIXED':
    case 'DICTIONARY':
      return hasTwoValues(plan.values);
    case 'GENERIC': {
      const { issueOf } = plan;
      const values = genericValueSampleOf(plan.field, MAX_RELATION_SIDE_VALUES) ?? [];
      return hasTwoValues(issueOf === null ? values : values.filter((value) => issueOf(value) === null));
    }
    case 'PERSON':
      return hasTwoValues(planned.persons.map((person) => personValueOf(person, plan.semanticKind)));
    case 'EMAIL':
    case 'PHONE':
    case 'DIGIT_CODE':
      return true;
    case 'DERIVED_TOTAL':
      return hasTwoValues(plan.pairs.map(([unit, quantity]) => multiplyDecimalIntegers(unit, quantity)));
  }
};

/** 実行のたびに変わりうる欄の名前（判定の欄の順。凍結）。 */
export const varyingFieldNamesOf = (planned: RuleSetPlan): readonly string[] =>
  Object.freeze([...planned.plans].filter(([, plan]) => planVaries(plan, planned)).map(([name]) => name));

/** 照合の READ の判定が見るシナリオの項目。 */
type VaryingScenario = EvaluationScenario & Pick<ScenarioRevision, 'verification'>;

/**
 * API のシナリオの送る値を持たない照合の READ が、実行のたびに変わる値と比べる期待を持つか（持たなければ理由、持てば null。対象の外も null）。
 * 規則の集まりが別のシナリオ・候補が違うときの `RangeError` は `planRuleSet` と同じ（対象の外のシナリオでは判定しないので投げない）。
 */
export const readVerificationVaryingRejectionOf = (
  ruleSet: RuleSetRevision,
  scenario: VaryingScenario,
  candidate: DiscoveryCandidate,
): typeof READ_VERIFICATION_NOT_VARYING | null => {
  const read = scenario.verification.readVerification;
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT || read === null || read.bindings.length > 0) {
    return null;
  }
  const planned = planRuleSet(ruleSet, scenario, candidate);
  if (!planned.evaluation.executable) {
    return null;
  }
  const varying = new Set(varyingFieldNamesOf(planned));
  return hasGeneratedValueExpectation(read.expectations, (expectation) => 'fieldName' in expectation && varying.has(expectation.fieldName))
    ? null
    : READ_VERIFICATION_NOT_VARYING;
};
