// 実行のたびに変わる値の判定（T40R2-fix。Task 40 の設計書 7 章の「T40R2」の行の M-1）。純粋な関数。
// - `varyingFieldNamesOf(planned)`: 入力の規則の値の作り方（`planRuleSet` の `plans`）から、実行のたびに変わりうる欄（2 つ以上の値を作りうる欄）の名前。
//   毎回同じ値になる欄（1 つの値だけの固定の一覧、「送らない」側、値が 1 つしかない範囲、1 つしかない辞書の値など）は入れない。値の空間を求められない
//   欄も入れない（止める側に寄せる）。メールと電話は、合成の番号が実行のたびに変わる。
// - `readVerificationVaryingRejectionOf(ruleSet, scenario, candidate)`: API のシナリオの、送る値を持たない照合の READ（`{id}` の型の画面の READ。結び付けが
//   0 件）は、実行のたびに変わる値と比べる期待（`hasGeneratedValueExpectation` に、比べる欄が変わる欄かの述語を渡す）を 1 つ以上求める。外れれば
//   `READ_VERIFICATION_NOT_VARYING`。FORM のシナリオ、候補の READ（結び付けで生成した値を送る）、規則が実行できない規則の集まり（ほかの理由で止まる）は
//   null。許可の発行（`scenario-store.ts` の `issueIn`）と開始の画面が使う唯一の判定。シナリオの保存の時は規則がないので、種類だけで確かめる
//   （`scenario-policy.ts`）。
// - OP-REV6 の I-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1）: `uniqueEachRunFieldNamesOf(planned)` は、実行のたびに違う値になる作り方の
//   欄（合成の番号つきのメール・電話・番号・文字）の名前。一覧の画面には前の登録が並ぶので、一覧の画面の答え合わせの期待は、この欄に限る（人の名前・固定の一覧・
//   辞書の値は、2 つ以上の値を作りえても、回をまたいで同じになりうる）。`readVerificationVaryingRejectionOf` は、照合の READ の定義の画面の path が `{id}` の型で
//   ない（一覧の画面）とき、この欄で判定する。下書き（自動の下書きの選び方）、許可の発行、開始の画面、書き込みの指定の組み立てが同じ判定を使う。
// - LU-7 fix round 2（一覧の行の更新の設計書 5.5 の 7、K3）: 一覧の画面の照合と一覧の行の更新の「毎回違う欄」の判定は `readVerificationUniqueRejectionOf` の
//   1 か所（許可の発行は `readVerificationVaryingRejectionOf` を通して、書き込みの開始 `writeStartSpecOf` は直接呼ぶ）。一覧の行の更新（`listRow`）は、行を選ぶ欄で
//   前の登録の行と区別するので、行を選ぶ欄が台帳の登録の毎回違う欄にあることを求める（変える欄が毎回違う欄であることは求めない）。
import type { ExecutionGrantRejectionReason } from '../approval/execution-grant.js';
import {
  API_SCENARIO_TRANSPORT,
  scenarioTransportOf,
  type ScenarioListRow,
  type ScenarioRevision,
  type VerificationExpectation,
} from '../approval/scenario-contracts.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { hasGeneratedValueExpectation, isReadCheckPageTemplatePath } from '../../discovery/read-check-contracts.js';
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
    case 'GENERIC_TEXT':
      return true;
    case 'DERIVED_TOTAL':
      return hasTwoValues(plan.pairs.map(([unit, quantity]) => multiplyDecimalIntegers(unit, quantity)));
  }
};

/** OP-REV6 の I-1: 実行のたびに違う値になる作り方（合成の番号つき）。 */
const UNIQUE_EACH_RUN_PLAN_KINDS: ReadonlySet<FieldPlan['kind']> = new Set(['EMAIL', 'PHONE', 'DIGIT_CODE', 'GENERIC_TEXT']);

/** OP-REV6 の I-1: 実行のたびに違う値になる欄の名前（判定の欄の順。凍結。ファイルの先頭の説明）。 */
export const uniqueEachRunFieldNamesOf = (planned: RuleSetPlan): readonly string[] =>
  Object.freeze([...planned.plans].filter(([, plan]) => UNIQUE_EACH_RUN_PLAN_KINDS.has(plan.kind)).map(([name]) => name));

/** OP-REV6 の I-1: 照合の READ の定義の画面の path が、一覧の画面（`{id}` の型でない画面の path）か。 */
export const isListPageReadTarget = (readTargetPagePath: string | null | undefined): boolean =>
  typeof readTargetPagePath === 'string' && !isReadCheckPageTemplatePath(readTargetPagePath);

/** 実行のたびに変わりうる欄の名前（判定の欄の順。凍結）。 */
export const varyingFieldNamesOf = (planned: RuleSetPlan): readonly string[] =>
  Object.freeze([...planned.plans].filter(([, plan]) => planVaries(plan, planned)).map(([name]) => name));

/**
 * LU-7 fix round 2: 一覧の画面の照合と一覧の行の更新の「毎回違う欄」の判定（許可の発行と書き込みの開始が使う唯一の判定。外れれば理由、通れば null）。
 * - 一覧の行の更新（`listRow` あり）: 行を選ぶ欄が、台帳の登録の今の入力の規則で実行のたびに違う値になる欄（`ledgerUniqueEachRunFieldNames`。分からなければ
 *   拒む）にあること。照合の READ の画面によらない（LU-8 の開始の確かめ直しも、これ 1 つ）。変える欄（照合の期待の欄）が毎回違う欄であることは求めない。
 * - 一覧の行のない一覧の画面の照合（`listPage`）: 期待の欄が、そのシナリオの毎回違う欄（`uniqueEachRunFieldNames`）であること（OP-REV6 の I-1 のまま）。
 * - ほか（`{id}` の型の画面・候補の READ）は対象の外（null。`{id}` の型は `readVerificationVaryingRejectionOf` が変わる欄で判定する）。
 */
export const readVerificationUniqueRejectionOf = (input: {
  readonly expectations: readonly VerificationExpectation[];
  /** 照合の READ の定義が一覧の画面（`isListPageReadTarget`）か。 */
  readonly listPage: boolean;
  /** そのシナリオの、実行のたびに違う値になる欄（`uniqueEachRunFieldNamesOf`）。 */
  readonly uniqueEachRunFieldNames: readonly string[];
  /** 一覧の行の更新の行の選び方（承認した API の指定の `ledger.listRow`。なければ null）。 */
  readonly listRow: Pick<ScenarioListRow, 'rowKeyField'> | null;
  /** 台帳の登録の、今の入力の規則で実行のたびに違う値になる欄（分からなければ null）。一覧の行の更新だけが見る。 */
  readonly ledgerUniqueEachRunFieldNames: readonly string[] | null | undefined;
}): typeof READ_VERIFICATION_NOT_VARYING | null => {
  if (input.listRow !== null) {
    return (input.ledgerUniqueEachRunFieldNames ?? []).includes(input.listRow.rowKeyField) ? null : READ_VERIFICATION_NOT_VARYING;
  }
  if (!input.listPage) {
    return null;
  }
  const unique = new Set(input.uniqueEachRunFieldNames);
  return hasGeneratedValueExpectation(input.expectations, (expectation) => 'fieldName' in expectation && unique.has(expectation.fieldName))
    ? null
    : READ_VERIFICATION_NOT_VARYING;
};

/** 照合の READ の判定が見るシナリオの項目。 */
type VaryingScenario = EvaluationScenario & Pick<ScenarioRevision, 'verification'> & { readonly api?: Pick<NonNullable<ScenarioRevision['api']>, 'ledger'> };

/**
 * API のシナリオの送る値を持たない照合の READ が、実行のたびに変わる値と比べる期待を持つか（持たなければ理由、持てば null。対象の外も null）。
 * 規則の集まりが別のシナリオ・候補が違うときの `RangeError` は `planRuleSet` と同じ（対象の外のシナリオでは判定しないので投げない）。
 */
export const readVerificationVaryingRejectionOf = (
  ruleSet: RuleSetRevision,
  scenario: VaryingScenario,
  candidate: DiscoveryCandidate,
  /** OP-REV6 の I-1: 照合の READ の定義の画面の path（画面の path の定義でなければ null）。一覧の画面なら、実行のたびに違う値になる欄で判定する。 */
  readTargetPagePath: string | null = null,
  /**
   * LU-7 fix round 2: 一覧の行の更新の、台帳の登録の今の入力の規則で実行のたびに違う値になる欄（省けば null。一覧の画面の照合の一覧の行の更新は拒む。
   * fail-closed）。
   */
  ledgerUniqueEachRunFieldNames: readonly string[] | null = null,
): typeof READ_VERIFICATION_NOT_VARYING | null => {
  const read = scenario.verification.readVerification;
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT || read === null || read.bindings.length > 0) {
    return null;
  }
  const planned = planRuleSet(ruleSet, scenario, candidate);
  if (!planned.evaluation.executable) {
    return null;
  }
  // LU-7 fix round 2: 一覧の画面は、唯一の判定 `readVerificationUniqueRejectionOf`（一覧の行の更新は、行を選ぶ欄で判定する）。
  if (isListPageReadTarget(readTargetPagePath)) {
    return readVerificationUniqueRejectionOf({
      expectations: read.expectations, listPage: true, uniqueEachRunFieldNames: uniqueEachRunFieldNamesOf(planned),
      listRow: scenario.api?.ledger?.listRow ?? null, ledgerUniqueEachRunFieldNames,
    });
  }
  const varying = new Set(varyingFieldNamesOf(planned));
  return hasGeneratedValueExpectation(read.expectations, (expectation) => 'fieldName' in expectation && varying.has(expectation.fieldName))
    ? null
    : READ_VERIFICATION_NOT_VARYING;
};
