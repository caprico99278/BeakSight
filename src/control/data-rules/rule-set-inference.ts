// 入力の規則の集まりの自動の作成の唯一の owner（手動の操作を減らす設計書 3A.3。FM2c）。純粋な関数。
// - 方針: 推した規則は保存して承認の digest に結ぶ。承認の後に、コードの変更や推しの変更で、送る値が黙って変わらないようにする（FM2c fix round 1）。
// - `inferRuleSetContent(scenario, candidate)`: シナリオの送る欄（FORM は form の欄、API は本文の鍵）ごとに、欄の判定と同じ推し（`field-evaluation.ts` の
//   `inferredFieldRulesOf`。業務テンプレートと汎用の規則）で規則を作り、出どころの印 `INFERRED` つきの、保存できる規則の集まりの中身にする（推しを
//   複製しない）。推した規則を保存すると、規則の集まりの digest に入り、承認に結ばれる（`rule-digest.ts` の形の版 2）。
// - API の鍵の補い（fix round 1）: 推しは、同じ form の欄の制約で補った欄で行う。判定と生成は補わないので、補った範囲（数・日時の種類の欄の min・max・
//   step）と番号・コードの桁の数（`digitCount`）を、保存する規則に固定する。
// - 範囲の既定の幅: 推した規則の判定が `RANGE_MISSING` で、欄（API の鍵は補った欄）に範囲の手がかり（min・max・step）が何もない欄だけに入れる（欄に
//   min・max があれば、今どおりその範囲を使う。ユーザーの判断 2026-10-22。Task 29 の設計書 10 章の 3 を、この場面について改めた）。
//   - 日付・日時（date・datetime-local）: 基準日からの幅 `DEFAULT_UNRANGED_DATE_WINDOW_DAYS`（`baseDateWindow`。基準日は実行の許可の発行日）。time・
//     month・week には入れない。
//   - 数（数の意味の種類）: `DEFAULT_UNRANGED_INTEGER_RANGE` の整数（刻み 1。`range`）。
//   - 既定の幅を入れた欄の名前（推測の印）を返す。印は承認に結ばない。保存した規則からは、同じ部品で求め直す（`defaultRangeFieldNamesOf`）。
// - 欄どうしの関係と一意にする欄の組（fix round 1）: テンプレートの既定から求め、出どころの印 `INFERRED` つきで中身に入れて固定する
//   （`templateDefaultsSaved`。判定は保存した関係と組だけを使う）。
// - 推せない欄: 作った中身で欄の判定（シナリオの今の副作用の確認で）をかけ、`DECIDED` でない欄を、理由のコードつきで返す（人が規則の画面で入れる）。
// - いつ作ってシナリオに付けるか（下書きを作るボタンとの結び付け）は、この部品の外（FM2b）。
import { deepFreeze } from '../../core/immutable.js';
import { DEFAULT_UNRANGED_DATE_WINDOW_DAYS, DEFAULT_UNRANGED_INTEGER_RANGE } from '../../core/limits.js';
import { compareCodeUnits } from '../../core/text.js';
import { CHOICE_FIELD_TYPES, type CandidateField, type CandidateFieldType, type DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { NUMERIC_KINDS, TEMPORAL_KINDS, defaultUniqueKeyFieldNamesOf, fieldDigitCodeLengthOf } from './business-templates.js';
import {
  evaluateRuleSet,
  inferredFieldRulesOf,
  type EvaluationScenario,
  type InferredFieldRule,
  type RuleSetEvaluation,
} from './field-evaluation.js';
import { BASE_DATE_WINDOW_FIELD_TYPES } from './generic-values.js';
import {
  relationFieldNamesOf,
  ruleBaseDateWindowOf,
  ruleOriginOf,
  type FieldRule,
  type FieldRuleProblem,
  type RuleOrigin,
  type RuleRange,
  type RuleSetContent,
  type SemanticKind,
} from './rule-contracts.js';

/** 自動で作った規則の集まりの中身と、人に見せる一覧。 */
export interface InferredRuleSetContent {
  /** 保存できる中身（推した規則、テンプレートの既定の関係と一意にする欄の組。出どころの印は `INFERRED`。既定を保存した印つき）。 */
  readonly content: RuleSetContent;
  /** 推せない欄・判定が決まらない欄（理由のコードつき。欄の名前の順）。 */
  readonly unresolvedFields: readonly FieldRuleProblem[];
  /** 範囲の既定の幅を入れた欄の名前（推測の印。欄の名前の順）。 */
  readonly defaultRangeFieldNames: readonly string[];
}

/** 推した規則・関係・組の出どころの印。 */
const INFERRED_ORIGIN: RuleOrigin = 'INFERRED';

/** 範囲の既定の幅の刻み（整数）。 */
const DEFAULT_INTEGER_STEP = '1';

/** 範囲の手がかり（min・max・step）が何もない欄か。 */
const hasNoRangeHint = (field: CandidateField): boolean =>
  field.constraints.min === null && field.constraints.max === null && field.constraints.step === null;

const isNumericOrTemporal = (kind: SemanticKind): boolean =>
  (NUMERIC_KINDS as readonly SemanticKind[]).includes(kind) || (TEMPORAL_KINDS as readonly SemanticKind[]).includes(kind);

/** 推した規則（範囲・幅・桁なし）に、API の鍵を補った form の欄から求めた範囲と桁を固定する。 */
const fixedRuleOf = ({ rule, formField }: InferredFieldRule): FieldRule => {
  const base: FieldRule = { ...rule, range: null, baseDateWindow: null, digitCount: null };
  if (formField === null) {
    return base;
  }
  if (rule.semanticKind === 'DIGIT_CODE') {
    return { ...base, digitCount: fieldDigitCodeLengthOf(formField.constraints) };
  }
  const { min, max, step } = formField.constraints;
  const choice = (CHOICE_FIELD_TYPES as readonly CandidateFieldType[]).includes(formField.type);
  return isNumericOrTemporal(rule.semanticKind) && !choice && (min !== null || max !== null || step !== null)
    ? { ...base, range: { min, max, step } }
    : base;
};

/** 既定の幅を入れた規則（入れられなければ null）。 */
const withDefaultRangeOf = (rule: FieldRule, field: CandidateField): FieldRule | null => {
  if (!hasNoRangeHint(field)) {
    return null;
  }
  const kind: SemanticKind = rule.semanticKind;
  if ((TEMPORAL_KINDS as readonly SemanticKind[]).includes(kind) && (BASE_DATE_WINDOW_FIELD_TYPES as readonly string[]).includes(field.type)) {
    return { ...rule, range: null, baseDateWindow: { ...DEFAULT_UNRANGED_DATE_WINDOW_DAYS } };
  }
  if ((NUMERIC_KINDS as readonly SemanticKind[]).includes(kind)) {
    const range: RuleRange = {
      min: String(DEFAULT_UNRANGED_INTEGER_RANGE.min), max: String(DEFAULT_UNRANGED_INTEGER_RANGE.max), step: DEFAULT_INTEGER_STEP,
    };
    return { ...rule, range, baseDateWindow: null };
  }
  return null;
};

/** 判定の欄のうち、問題のある欄（理由のコードつき）。 */
const unresolvedOf = (evaluation: RuleSetEvaluation): readonly FieldRuleProblem[] =>
  evaluation.fields.flatMap((field) => (field.problem === null ? [] : [{ fieldName: field.fieldName, problem: field.problem }]));

/**
 * シナリオの送る欄から、推した規則の集まりの中身を作る（純粋。入力を変えない。凍結）。候補がシナリオの対象でない、API のシナリオが API の指定を
 * 持たないときは、欄の判定と同じ `RangeError`。
 */
export const inferRuleSetContent = (scenario: EvaluationScenario, candidate: DiscoveryCandidate): InferredRuleSetContent => {
  const inferred = inferredFieldRulesOf(scenario, candidate);
  const evaluationOf = (content: RuleSetContent): RuleSetEvaluation => evaluateRuleSet({ scenarioId: scenario.scenarioId, ...content }, scenario, candidate);
  const contentOf = (fieldRules: readonly FieldRule[]): RuleSetContent => ({ fieldRules, relations: [], uniqueKeyFieldNames: [] });

  // 1. 推した規則に、補った範囲と桁を固定する。
  const fixed = inferred.map(fixedRuleOf);
  // 2. 範囲の手がかりのない欄に、既定の幅を入れる。
  const rangeMissing = new Set(evaluationOf(contentOf(fixed)).fields
    .filter((field) => field.problem?.code === 'NEEDS_RULE_INPUT' && field.problem.detail === 'RANGE_MISSING')
    .map((field) => field.fieldName));
  const defaulted = new Set<string>();
  const fieldRules = fixed.map((rule, index): FieldRule => {
    const field = inferred[index]?.field;
    const widened = field !== undefined && rangeMissing.has(rule.fieldName) ? withDefaultRangeOf(rule, field) : null;
    if (widened !== null) {
      defaulted.add(rule.fieldName);
    }
    return widened ?? rule;
  }).sort((left, right) => compareCodeUnits(left.fieldName, right.fieldName));
  // 3. テンプレートの既定の関係と一意にする欄の組を求め、印つきで固定する（既定を足す今の判定で求める）。
  const withDefaults = evaluationOf(contentOf(fieldRules));
  const known = new Set(fieldRules.map((rule) => rule.fieldName));
  const relations = withDefaults.relations
    .filter((relation) => relationFieldNamesOf(relation).every((name) => known.has(name)))
    .map((relation) => ({ ...relation, origin: INFERRED_ORIGIN }));
  const decidedRules = withDefaults.fields.filter((field) => field.status === 'DECIDED' && field.rule !== null).map((field) => field.rule as FieldRule);
  const uniqueKeyFieldNames = defaultUniqueKeyFieldNamesOf(decidedRules).filter((name) => known.has(name));
  const content: RuleSetContent = {
    fieldRules,
    relations,
    uniqueKeyFieldNames,
    ...(uniqueKeyFieldNames.length > 0 ? { uniqueKeyOrigin: INFERRED_ORIGIN } : {}),
    templateDefaultsSaved: true,
  };
  return deepFreeze({
    content,
    unresolvedFields: unresolvedOf(evaluationOf(content)),
    defaultRangeFieldNames: fieldRules.filter((rule) => defaulted.has(rule.fieldName)).map((rule) => rule.fieldName),
  });
};

/** 2 つの範囲が同じか。 */
const sameRange = (left: RuleRange | null, right: RuleRange | null): boolean =>
  (left === null || right === null ? left === right : left.min === right.min && left.max === right.max && left.step === right.step);

/**
 * 保存した規則のうち、自動の作成が既定の幅を入れた欄の名前（推測の印を、同じ部品で求め直す。純粋。欄の名前の順。凍結）。今のシナリオと候補で
 * 自動の作成をやり直し、既定の幅を入れる欄のうち、保存した規則が推した規則（出どころ `INFERRED`）で、範囲と基準日からの幅が同じものだけ。
 * 画面のサーバが表示の値に載せる（ブラウザ側で条件を書き直さない）。
 */
export const defaultRangeFieldNamesOf = (
  fieldRules: readonly FieldRule[],
  scenario: EvaluationScenario,
  candidate: DiscoveryCandidate,
): readonly string[] => {
  const again = inferRuleSetContent(scenario, candidate);
  const saved = new Map(fieldRules.map((rule) => [rule.fieldName, rule]));
  return Object.freeze(again.defaultRangeFieldNames.filter((name) => {
    const rule = saved.get(name);
    const expected = again.content.fieldRules.find((candidateRule) => candidateRule.fieldName === name);
    if (rule === undefined || expected === undefined || ruleOriginOf(rule) !== INFERRED_ORIGIN) {
      return false;
    }
    const window = ruleBaseDateWindowOf(rule);
    const expectedWindow = ruleBaseDateWindowOf(expected);
    return sameRange(rule.range, expected.range)
      && (window === null || expectedWindow === null
        ? window === expectedWindow
        : window.fromDays === expectedWindow.fromDays && window.toDays === expectedWindow.toDays);
  }));
};
