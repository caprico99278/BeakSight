// 欄の判定の唯一の owner（Task 29 の設計書 3 章の欄ごとの判定と規則の優先順位、4.2。T29c）。純粋な関数。
// - `evaluateRuleSet(ruleSet, scenario, candidate)`: 送る欄ごとの状態（`DECIDED`・`NEEDS_RULE_INPUT`・`RULE_CONFLICT`・`EXTERNAL_DELIVERY_BLOCKED`）
//   と、実行してよいか（送る欄すべてが `DECIDED` で、required なのに送る欄に選ばれていない欄がない）を返す。
// - 欄ごとの判定の順（最初に当たったもの）:
//   1. 候補の送れる欄でない（ない、hidden・readonly・disabled、password・file、`_method`）→ `RULE_CONFLICT` の `FIELD_NOT_SENDABLE`。
//   2. 状態の欄（発見の分類の状態の欄の名前の語。`classify.ts` の `fieldNameHasStateWord`）→ `STATE_FIELD_NOT_USABLE`。
//   3. 通知・配信を求める欄（外部到達の語の `NOTIFICATION`、またはメール・電話の語の選択の欄）→「送らない」側に固定する（`OPT_OUT`。規則に
//      依らない）。checkbox は送らない（null）。select・radio は「送らない」側の値（`isNotificationOptOutValue`）。選べず required なら
//      `NOTIFICATION_OPT_OUT_UNAVAILABLE`。required でなければ送らない（null）。名前に否定の語（`NOTIFICATION_NEGATION_WORDS`）がある欄は、
//      人の固定の値がなければ `NOTIFICATION_OPT_OUT_UNAVAILABLE`（T29c fix round 1）。
//   3b. required でない checkbox は、人の固定の値がない限り送らない（`OPT_OUT` の null。T29R-fix-1 の I-2）。
//   4. メール・電話の欄（外部到達の語か、規則の意味の種類）は、シナリオの副作用の確認 `NO_EXTERNAL_NOTIFICATION` が要る（なければ
//      `EXTERNAL_DELIVERY_BLOCKED`）。住所の欄と url の欄は、人の固定の一覧だけ（なければ `ADDRESS_FIELD`・`URL_FIELD`）。
//   5. 規則（優先順位: 人の規則（規則の集まり）→ 業務テンプレート → 汎用の規則。推せなければ `SEMANTIC_KIND_UNDECIDED`）。意味の種類と欄の型が
//      合わなければ `SEMANTIC_KIND_TYPE_MISMATCH`（メール・電話の欄は、固定の一覧のほかはメール・電話の種類だけ）。
//   6. 作れるか: 固定の一覧（値が欄の選択肢・制約・step に合い、危険な語と無効化の語（T31a）に当たらず、メールの欄は `example.invalid` の形。
//      メールと電話の両方に当たる欄は type で合成の形を決める（`contactShapeOf`。T29R-fix-1 の I-1））、範囲（欄の min・max と人の範囲、数と金額はテンプレートの
//      既定の範囲。人の範囲は欄の範囲の中で、欄の step の格子に乗る。既定の範囲は欄の step に合わせる。T29R-fix-1 の M-1）、辞書の値が欄の制約に
//      合うか、メールと電話の形が欄の制約に合うか。
// - 既定の値がある欄（hasValue）も、規則の値で上書きする（CREATE。UPDATE の扱いは Task 31）。
// - 欄どうしの関係: 規則の集まりの関係と、テンプレートの既定の関係（`defaultRelationsOf`。同じ種類で同じ従う欄の関係が人の関係にあれば足さない）。
//   従う欄（終了・合計・フリガナ）に問題を付ける。合計は単価 × 数量から求める（合計の欄の範囲は要らない。選択の欄なら `RELATION_UNSATISFIABLE`）。
//   T29R-fix-1（M-2）: 合計の欄の制約に合う単価と数量の組（`totalPairsOf`）を求め、なければ `RELATION_UNSATISFIABLE`。生成はその組から選ぶ。
// - 一意にする欄の組: 規則の集まりの組（送る欄だけ）。空ならテンプレートの既定（`defaultUniqueKeyFieldNamesOf`）。
// - 生成（`scenario-data.ts`）は、同じ判定の結果と値の作り方（`planRuleSet` の `plans`）を使う（判定で作れると言えば、生成も作れる）。
// - T31d（Task 31 の設計書 3 章の「変える欄の値」「保つ欄の期待の値」、4 章の「生成」）: UPDATE のシナリオは、値を作るのは変える欄（`fieldNames`）
//   だけ。保つ欄（UPDATE の指定の `keepFieldNames`）は規則が要らず、規則があっても使わない（送る欄でない欄の規則を使わない今の決まりと同じ）。
//   「required なのに送る欄に選ばれていない欄」は、UPDATE では変える欄でも保つ欄でもない欄だけ（保つ欄は前の値のまま送る）。一意にする欄の組が、
//   規則の集まりからもテンプレートの既定からも決まらないときは、UPDATE だけ、変える欄（`DECIDED` の欄）の組にする（使った値と重ならない値を作る
//   ため。CREATE は今のまま空）。状態の欄・無効化の語・メールと電話の決まりは、CREATE と同じ判定がそのまま効く。
// - 呼び出し側の誤り（規則の集まりが別のシナリオ、候補の識別の digest がシナリオと違う）は `RangeError`。
import type { ScenarioRevision } from '../approval/scenario-contracts.js';
import { deepFreeze } from '../../core/immutable.js';
import { compareCodeUnits } from '../../core/text.js';
import {
  CHOICE_FIELD_TYPES,
  isMethodOverrideFieldName,
  isUnsendableFieldType,
  writeFieldsOfName,
  type CandidateField,
  type CandidateFieldType,
  type DiscoveryCandidate,
} from '../../discovery/candidate-contracts.js';
import { fieldNameHasStateWord } from '../../discovery/classify.js';
import { isSendableWriteFieldName } from '../../discovery/read-check-contracts.js';
import {
  NAME_KANA_PAIRS,
  PERSON_NAME_KINDS,
  TEMPORAL_KINDS,
  defaultRelationsOf,
  defaultUniqueKeyFieldNamesOf,
  inferSemanticKind,
  isSemanticKindCompatible,
  templateDefaultRangeOf,
} from './business-templates.js';
import {
  AVOIDED_PERSON_NAME_PAIRS,
  FAMILY_NAMES,
  GIVEN_NAMES,
  PRODUCT_NAMES,
  REMARK_PHRASES,
  type NameEntry,
} from './dictionaries/dictionaries.js';
import {
  externalDeliveryKindsOf,
  isNotificationOptOutValue,
  notificationFieldNameIsNegated,
  type ExternalDeliveryKind,
} from './external-delivery-words.js';
import {
  alignUpToFieldStep,
  checkGenericRule,
  compareFieldValues,
  fieldStepFitOf,
  genericValueSampleOf,
  multiplyDecimalIntegers,
  stepMultipleFitOf,
  usableOptionValues,
  valueHasDestructiveWord,
  valueHasDisablingWord,
  type StepFit,
} from './generic-values.js';
import {
  FIXED_LIST_GENERATION_METHOD,
  SYNTHETIC_PHONE_FORMATS,
  isSyntheticEmailAddress,
  relationFieldNamesOf,
  syntheticEmailAddressOf,
  syntheticPhoneFormatOf,
  syntheticPhoneNumberOf,
  type FieldRelation,
  type FieldRule,
  type FieldRuleStatus,
  type RuleProblem,
  type RuleRange,
  type RuleSetRevision,
  type RuleSource,
  type SemanticKind,
  type SyntheticPhoneFormat,
} from './rule-contracts.js';
import { textConstraintCheckOf, unsatisfiedDetailOf, type TextConstraintCheck } from './text-constraints.js';

/** 判定が見るシナリオの項目。 */
export type EvaluationScenario = Pick<ScenarioRevision, 'scenarioId' | 'kind' | 'candidate' | 'fieldNames' | 'sideEffectConfirmations' | 'update'>;

/** 保つ欄（T31d。UPDATE の指定の保つ欄。CREATE と、UPDATE の指定がない版は空）。値を作らず、規則も要らない。 */
const keepFieldNamesOf = (scenario: EvaluationScenario): readonly string[] =>
  (scenario.kind === 'UPDATE' ? scenario.update?.keepFieldNames ?? [] : []);

/** 欄 1 つの判定（補完の画面の 1 行）。 */
export interface FieldEvaluation {
  readonly fieldName: string;
  /** 送る欄に選ばれているか（選ばれていない required の欄も、`REQUIRED_FIELD_NOT_SELECTED` として並ぶ）。 */
  readonly selected: boolean;
  readonly status: FieldRuleStatus;
  readonly problem: RuleProblem | null;
  /** 当てた規則の出どころ（規則が決まらなければ null）。 */
  readonly source: RuleSource | null;
  /** 当てた規則（人の規則か、推した規則。決まらなければ null）。 */
  readonly rule: FieldRule | null;
  readonly externalDeliveryKinds: readonly ExternalDeliveryKind[];
}

/** 規則の集まりの判定。 */
export interface RuleSetEvaluation {
  /** すべての欄が `DECIDED`（実行してよい）。 */
  readonly executable: boolean;
  /** 欄の名前の順（UTF-16 のコード単位）。 */
  readonly fields: readonly FieldEvaluation[];
  /** 当てる欄どうしの関係（人の関係、テンプレートの既定の関係の順）。 */
  readonly relations: readonly FieldRelation[];
  /** 一意にする欄の組（UTF-16 のコード単位の順）。 */
  readonly uniqueKeyFieldNames: readonly string[];
}

/** 姓と名の組（氏名とフリガナを作る同じ人）。 */
export interface Person {
  readonly family: NameEntry;
  readonly given: NameEntry;
}

/** 欄の値の作り方（`scenario-data.ts` が使う。判定の内部の形）。 */
export type FieldPlan =
  | { readonly kind: 'OPT_OUT'; readonly value: string | null }
  | { readonly kind: 'FIXED'; readonly values: readonly string[]; readonly phone: boolean }
  | { readonly kind: 'GENERIC'; readonly field: CandidateField; readonly issueOf: TextConstraintCheck | null }
  | { readonly kind: 'PERSON'; readonly semanticKind: SemanticKind }
  | { readonly kind: 'DICTIONARY'; readonly values: readonly string[] }
  | { readonly kind: 'EMAIL'; readonly issueOf: TextConstraintCheck }
  | { readonly kind: 'PHONE'; readonly format: SyntheticPhoneFormat; readonly issueOf: TextConstraintCheck }
  | {
    readonly kind: 'DERIVED_TOTAL';
    readonly field: CandidateField;
    readonly issueOf: TextConstraintCheck | null;
    /**
     * 合計の欄の制約に合う、単価と数量の組（T29R-fix-1 の M-2。判定が求める。生成は、この組から選ぶので、判定で作れると言えば生成も作れる）。
     * 関係を確かめる前は空。
     */
    readonly pairs: readonly (readonly [string, string])[];
  };

/** 判定と、値の作り方。 */
export interface RuleSetPlan {
  readonly evaluation: RuleSetEvaluation;
  /** `DECIDED` の欄の作り方（欄の名前ごと）。 */
  readonly plans: ReadonlyMap<string, FieldPlan>;
  /** 氏名の欄の制約に合う、姓と名の組（氏名の欄がなければ空）。 */
  readonly persons: readonly Person[];
}

// ---------------------------------------------------------------------------------------------------------------
// 小さな部品
// ---------------------------------------------------------------------------------------------------------------

const needs = (detail: Extract<RuleProblem, { code: 'NEEDS_RULE_INPUT' }>['detail']): RuleProblem => ({ code: 'NEEDS_RULE_INPUT', detail });
const conflict = (detail: Extract<RuleProblem, { code: 'RULE_CONFLICT' }>['detail']): RuleProblem => ({ code: 'RULE_CONFLICT', detail });
const BLOCKED: RuleProblem = { code: 'EXTERNAL_DELIVERY_BLOCKED', detail: 'EXTERNAL_NOTIFICATION_UNCONFIRMED' };

const TEXT_INPUT_TYPES: readonly CandidateFieldType[] = Object.freeze(['text', 'search']);
const GENERIC_KINDS: readonly SemanticKind[] = Object.freeze(['GENERIC_NUMBER', 'GENERIC_DATETIME', 'GENERIC_CHOICE', 'GENERIC_COLOR']);
const CONTACT_KINDS: readonly SemanticKind[] = Object.freeze(['EMAIL', 'PHONE']);
const FREE_RULE_KINDS: readonly SemanticKind[] = Object.freeze(['FIXED_LIST', 'OUT_OF_TEMPLATE']);
const UNIT_PRICE_KINDS: readonly SemanticKind[] = Object.freeze(['UNIT_PRICE', 'GENERIC_NUMBER']);
const QUANTITY_KINDS: readonly SemanticKind[] = Object.freeze(['QUANTITY', 'PARTY_SIZE', 'GENERIC_NUMBER']);
const TOTAL_KINDS: readonly SemanticKind[] = Object.freeze(['TOTAL_PRICE', 'GENERIC_NUMBER']);

const isChoiceType = (type: CandidateFieldType): boolean => (CHOICE_FIELD_TYPES as readonly CandidateFieldType[]).includes(type);

/** 同じ名前の欄（radio など）をまとめた欄（最初の欄の型と制約、選択肢はすべての和、required はどれか）。 */
const mergedFieldOf = (fields: readonly CandidateField[]): CandidateField | null => {
  const [first] = fields;
  if (first === undefined) {
    return null;
  }
  const options = fields.some((field) => field.options !== null) ? fields.flatMap((field) => field.options ?? []) : null;
  return { ...first, options, required: fields.some((field) => field.required) };
};

/** 氏名の種類の値（同じ人から。フルネームは姓と名を区切りなしでつなぐ）。 */
export const personValueOf = (person: Person, kind: SemanticKind): string => {
  switch (kind) {
    case 'FAMILY_NAME':
      return person.family.name;
    case 'GIVEN_NAME':
      return person.given.name;
    case 'FAMILY_NAME_KANA':
      return person.family.kana;
    case 'GIVEN_NAME_KANA':
      return person.given.kana;
    case 'FULL_NAME_KANA':
      return `${person.family.kana}${person.given.kana}`;
    default:
      return `${person.family.name}${person.given.name}`;
  }
};

/** 欄の型の値として 2 つを比べる（比べられなければ null）。 */
const compareAs = (type: CandidateFieldType, left: string, right: string): number | null => compareFieldValues(type, left, right);

/**
 * 人の固定の値に求める合成の形（T29R-fix-1 の I-1）。
 * - `EMAIL`: 合成のメールの形（`example.invalid`）だけ。メールの欄（電話には当たらない）、意味の種類がメール、メールと電話の両方に当たる type email の欄。
 * - `PHONE`: 合成の電話の形（`090-0XXX-XXXX`・`0900XXXXXXX`）だけ。メールと電話の両方に当たる type tel の欄。
 * - `EITHER`: どちらかの合成の形だけ。メールと電話の両方に当たる、ほかの型の欄。
 * - null: 形を求めない。電話だけに当たる欄は、設計書 3 章（2026-10-13 のユーザーの指示）のとおり、人が入れたテスト環境の番号を優先する。
 */
type ContactShape = 'EMAIL' | 'PHONE' | 'EITHER' | null;

const contactShapeOf = (field: CandidateField, external: readonly ExternalDeliveryKind[], kind: SemanticKind): ContactShape => {
  const email = external.includes('EMAIL');
  if (email && external.includes('PHONE')) {
    return field.type === 'email' ? 'EMAIL' : field.type === 'tel' ? 'PHONE' : 'EITHER';
  }
  return email || kind === 'EMAIL' ? 'EMAIL' : null;
};

/** 値が、求める合成の形に合うか。 */
const fitsContactShape = (shape: ContactShape, value: string): boolean => {
  const email = isSyntheticEmailAddress(value);
  const phone = syntheticPhoneFormatOf(value) !== null;
  switch (shape) {
    case 'EMAIL':
      return email;
    case 'PHONE':
      return phone;
    case 'EITHER':
      return email || phone;
    case null:
      return true;
  }
};

/** 欄の型が step を持つか（number・range と日時の型）。 */
const STEPPED_TYPES: readonly CandidateFieldType[] = Object.freeze(['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local']);

/** 固定の値が、欄（型・選択肢・制約・step）と求める合成の形に合うか。 */
const fixedValueFits = (field: CandidateField, shape: ContactShape, value: string): boolean => {
  // T31a: 無効化の語の値も、危険な語と同じく拒む（選択の欄は `usableOptionValues` でも除かれる）。
  if (value.length === 0 || valueHasDestructiveWord(value) || valueHasDisablingWord(value)) {
    return false;
  }
  if (!fitsContactShape(shape, value)) {
    return false;
  }
  if (isChoiceType(field.type)) {
    return usableOptionValues(field.options).includes(value);
  }
  const { min, max } = field.constraints;
  if (!TEXT_INPUT_TYPES.includes(field.type) && field.type !== 'textarea' && field.type !== 'email' && field.type !== 'tel' && field.type !== 'url') {
    const low = min === null ? 0 : compareAs(field.type, value, min);
    const high = max === null ? 0 : compareAs(field.type, value, max);
    if (low === null || high === null || low < 0 || high > 0) {
      return false;
    }
  }
  // T29R-fix-1（M-1）: step のある型は、欄の step の格子に乗る値だけ。
  if (STEPPED_TYPES.includes(field.type) && fieldStepFitOf(field, value) !== 'ON_STEP') {
    return false;
  }
  return textConstraintCheckOf(field.constraints)(value) === null;
};

// ---------------------------------------------------------------------------------------------------------------
// 欄ごとの段 1: 規則を決める
// ---------------------------------------------------------------------------------------------------------------

/** 段 1 の結果（問題か、規則と出どころ）。 */
type RuleDecision =
  | { readonly field: CandidateField | null; readonly problem: RuleProblem; readonly rule: FieldRule | null; readonly source: RuleSource | null;
    readonly plan: null; readonly external: readonly ExternalDeliveryKind[] }
  | { readonly field: CandidateField; readonly problem: null; readonly rule: FieldRule | null; readonly source: RuleSource;
    readonly plan: FieldPlan | null; readonly external: readonly ExternalDeliveryKind[] };

/** 通知・配信を求める欄の「送らない」側（段 1 の 3）。 */
const optOutDecision = (field: CandidateField, external: readonly ExternalDeliveryKind[], humanRule: FieldRule | undefined): RuleDecision => {
  // T29c fix round 1: 名前に否定の語がある通知の欄は、どちらが「送らない」側か決まらない。人の固定の値（欄の選択肢・制約に合うもの）がなければ止める。
  if (notificationFieldNameIsNegated(field.name)) {
    if (humanRule?.method !== FIXED_LIST_GENERATION_METHOD) {
      return { field, problem: conflict('NOTIFICATION_OPT_OUT_UNAVAILABLE'), rule: null, source: null, plan: null, external };
    }
    return humanRule.fixedValues.every((value) => fixedValueFits(field, null, value))
      ? { field, problem: null, rule: humanRule, source: 'HUMAN', plan: { kind: 'FIXED', values: humanRule.fixedValues, phone: false }, external }
      : { field, problem: conflict('FIXED_VALUE_VIOLATES_CONSTRAINT'), rule: humanRule, source: 'HUMAN', plan: null, external };
  }
  const optOut = field.type === 'checkbox' ? [] : usableOptionValues(field.options).filter(isNotificationOptOutValue);
  const [value] = optOut;
  if (value !== undefined) {
    return { field, problem: null, rule: null, source: 'OPT_OUT', plan: { kind: 'OPT_OUT', value }, external };
  }
  return field.required
    ? { field, problem: conflict('NOTIFICATION_OPT_OUT_UNAVAILABLE'), rule: null, source: null, plan: null, external }
    : { field, problem: null, rule: null, source: 'OPT_OUT', plan: { kind: 'OPT_OUT', value: null }, external };
};

const decideRule = (
  name: string,
  candidate: DiscoveryCandidate,
  humanRule: FieldRule | undefined,
  notificationConfirmed: boolean,
): RuleDecision => {
  // T31b fix round 1: 値を送る欄（組の名前は組の checkbox だけ。`writeFieldsOfName`）で判定する（組でない同じ名前の欄は、今どおり送れない）。
  const fields = writeFieldsOfName(candidate.fields, name);
  const field = mergedFieldOf(fields);
  if (field === null || !isSendableWriteFieldName(candidate, name) || isMethodOverrideFieldName(name)
    || fields.some((candidateField) => isUnsendableFieldType(candidateField.type))) {
    return { field, problem: conflict('FIELD_NOT_SENDABLE'), rule: null, source: null, plan: null, external: [] };
  }
  const external = externalDeliveryKindsOf(field);
  const fail = (problem: RuleProblem, rule: FieldRule | null = null, source: RuleSource | null = null): RuleDecision =>
    ({ field, problem, rule, source, plan: null, external });
  if (fieldNameHasStateWord(field.name)) {
    return fail(conflict('STATE_FIELD_NOT_USABLE'));
  }
  const contact = external.includes('EMAIL') || external.includes('PHONE');
  if (external.includes('NOTIFICATION') || (contact && isChoiceType(field.type))) {
    return optOutDecision(field, external, humanRule);
  }
  const humanFixed = humanRule?.method === FIXED_LIST_GENERATION_METHOD;
  // T29R-fix-1（I-2 の (b)）: required でない checkbox は、人の固定の値がない限り送らない（チェックしない）。一覧にない名前の通知・同意の欄を、
  // 受け取る側の値で作らないため。required の checkbox は、汎用の規則か人の規則で決める。
  if (field.type === 'checkbox' && !field.required && !humanFixed) {
    return { field, problem: null, rule: null, source: 'OPT_OUT', plan: { kind: 'OPT_OUT', value: null }, external };
  }
  if (contact && !notificationConfirmed) {
    return fail(BLOCKED);
  }
  if (!contact && external.includes('ADDRESS') && !humanFixed) {
    return fail(needs('ADDRESS_FIELD'));
  }
  if (field.type === 'url' && !humanFixed) {
    return fail(needs('URL_FIELD'));
  }
  let rule: FieldRule;
  let source: RuleSource;
  if (humanRule !== undefined) {
    rule = humanRule;
    source = 'HUMAN';
  } else {
    const kind = inferSemanticKind(field);
    if (kind === null) {
      return fail(needs('SEMANTIC_KIND_UNDECIDED'));
    }
    const generic = GENERIC_KINDS.includes(kind);
    rule = { fieldName: name, semanticKind: kind, method: generic ? 'FROM_TYPE' : 'FROM_TEMPLATE', range: null, fixedValues: [] };
    source = generic ? 'GENERIC' : 'TEMPLATE';
  }
  const fixed = rule.method === FIXED_LIST_GENERATION_METHOD;
  if (CONTACT_KINDS.includes(rule.semanticKind) && !notificationConfirmed) {
    return fail(BLOCKED, rule, source);
  }
  if ((contact && !fixed && !CONTACT_KINDS.includes(rule.semanticKind)) || !isSemanticKindCompatible(rule.semanticKind, field.type)) {
    return fail(conflict('SEMANTIC_KIND_TYPE_MISMATCH'), rule, source);
  }
  if (fixed) {
    const shape = contactShapeOf(field, external, rule.semanticKind);
    if (!rule.fixedValues.every((value) => fixedValueFits(field, shape, value))) {
      return fail(conflict('FIXED_VALUE_VIOLATES_CONSTRAINT'), rule, source);
    }
    const phone = shape !== 'EMAIL' && (external.includes('PHONE') || rule.semanticKind === 'PHONE');
    return { field, problem: null, rule, source, plan: { kind: 'FIXED', values: rule.fixedValues, phone }, external };
  }
  if (FREE_RULE_KINDS.includes(rule.semanticKind)) {
    return fail(needs('NO_RULE'), rule, source);
  }
  return { field, problem: null, rule, source, plan: null, external };
};

// ---------------------------------------------------------------------------------------------------------------
// 欄ごとの段 2: 作り方を決める
// ---------------------------------------------------------------------------------------------------------------

type PlanResult = { readonly plan: FieldPlan; readonly problem: null } | { readonly plan: null; readonly problem: RuleProblem };

const planned = (plan: FieldPlan): PlanResult => ({ plan, problem: null });
const unplanned = (problem: RuleProblem): PlanResult => ({ plan: null, problem });

/** 範囲の 1 つの端が、欄の範囲の中か（比べられなければ null）。 */
const insideField = (type: CandidateFieldType, value: string, field: CandidateField): boolean | null => {
  const { min, max } = field.constraints;
  const low = min === null ? 0 : compareAs(type, value, min);
  const high = max === null ? 0 : compareAs(type, value, max);
  return low === null || high === null ? null : low >= 0 && high <= 0;
};

/** 汎用の規則の値の空間を使う作り方（数・日時・色・選択。範囲は欄、人の規則、テンプレートの既定の順に補う）。 */
const genericPlanOf = (field: CandidateField, rule: FieldRule, source: RuleSource): PlanResult => {
  if (isChoiceType(field.type) || field.type === 'color') {
    const reason = checkGenericRule(field);
    return reason === null ? planned({ kind: 'GENERIC', field, issueOf: null }) : unplanned(reason === 'NOT_GENERIC_TYPE'
      ? conflict('SEMANTIC_KIND_TYPE_MISMATCH')
      : needs(reason));
  }
  const textual = TEXT_INPUT_TYPES.includes(field.type);
  const type: CandidateFieldType = textual ? 'number' : field.type;
  const fieldRange: RuleRange = textual
    ? { min: null, max: null, step: null }
    : { min: field.constraints.min, max: field.constraints.max, step: field.constraints.step };
  const human = source === 'HUMAN' ? rule.range : null;
  if (human !== null) {
    for (const bound of [human.min, human.max]) {
      const inside = bound === null ? true : insideField(type, bound, { ...field, constraints: { ...field.constraints, ...fieldRange } });
      if (inside === null) {
        return unplanned(needs('CONSTRAINT_UNSUPPORTED'));
      }
      if (!inside) {
        return unplanned(conflict('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
      }
    }
    // T29R-fix-1（M-1）: 人の範囲の端は欄の step の格子に乗り、人の step は欄の step の倍数であること（生成の値が欄の step に合うように）。
    const fits: readonly StepFit[] = textual ? [] : [
      ...[human.min, human.max].filter((bound): bound is string => bound !== null).map((bound) => fieldStepFitOf(field, bound)),
      ...(human.step === null ? [] : [stepMultipleFitOf(field, human.step)]),
    ];
    if (fits.includes('UNSUPPORTED')) {
      return unplanned(needs('CONSTRAINT_UNSUPPORTED'));
    }
    if (fits.includes('OFF_STEP')) {
      return unplanned(conflict('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
    }
  }
  let min = human?.min ?? fieldRange.min;
  let max = human?.max ?? fieldRange.max;
  let step = human?.step ?? fieldRange.step;
  const fallback = templateDefaultRangeOf(rule.semanticKind);
  if (fallback !== null && (min === null || max === null)) {
    const fallbackMin = min === null;
    min ??= fallback.min;
    max ??= fallback.max;
    step ??= fallback.step;
    // T29R-fix-1（M-1）: 既定の範囲は、欄の step に合わせる（step が欄の step の倍数でなければ欄の step、補った min は格子の上へ上げる）。
    if (!textual) {
      if (step !== null && stepMultipleFitOf(field, step) !== 'ON_STEP') {
        step = fieldRange.step;
      }
      const aligned = fallbackMin && min !== null ? alignUpToFieldStep(field, min) : min;
      if (aligned === null) {
        return unplanned(needs('CONSTRAINT_UNSUPPORTED'));
      }
      min = aligned;
    }
  }
  const pseudo: CandidateField = { ...field, type, constraints: { ...field.constraints, min, max, step } };
  const reason = checkGenericRule(pseudo);
  if (reason !== null) {
    return unplanned(reason === 'NOT_GENERIC_TYPE' ? conflict('SEMANTIC_KIND_TYPE_MISMATCH') : needs(reason));
  }
  if (!textual) {
    return planned({ kind: 'GENERIC', field: pseudo, issueOf: null });
  }
  const check = textConstraintCheckOf(field.constraints);
  const detail = [min, max].some((bound) => bound !== null && check(bound) !== null)
    ? unsatisfiedDetailOf([min, max].filter((bound): bound is string => bound !== null), check) ?? 'PATTERN_UNSUPPORTED'
    : null;
  return detail === null ? planned({ kind: 'GENERIC', field: pseudo, issueOf: check }) : unplanned(needs(detail));
};

/** 規則の意味の種類の作り方（段 2）。氏名は、組の絞り込みの後に確かめる。 */
const planOf = (field: CandidateField, rule: FieldRule, source: RuleSource, derivedTotal: boolean): PlanResult => {
  const kind = rule.semanticKind;
  if (derivedTotal) {
    return isChoiceType(field.type)
      ? unplanned(conflict('RELATION_UNSATISFIABLE'))
      : planned({
        kind: 'DERIVED_TOTAL',
        field,
        issueOf: TEXT_INPUT_TYPES.includes(field.type) ? textConstraintCheckOf(field.constraints) : null,
        pairs: [],
      });
  }
  if (PERSON_NAME_KINDS.includes(kind)) {
    return planned({ kind: 'PERSON', semanticKind: kind });
  }
  if (kind === 'NOTE' || kind === 'PRODUCT_NAME') {
    const dictionary = kind === 'NOTE' ? REMARK_PHRASES : PRODUCT_NAMES;
    const check = textConstraintCheckOf(field.constraints);
    const values = dictionary.filter((value) => check(value) === null);
    return values.length > 0
      ? planned({ kind: 'DICTIONARY', values: Object.freeze(values) })
      : unplanned(needs(unsatisfiedDetailOf(dictionary, check) ?? 'LENGTH_UNSATISFIABLE'));
  }
  if (kind === 'EMAIL') {
    const check = textConstraintCheckOf(field.constraints);
    const detail = unsatisfiedDetailOf([syntheticEmailAddressOf(0)], check);
    return detail === null ? planned({ kind: 'EMAIL', issueOf: check }) : unplanned(needs(detail));
  }
  if (kind === 'PHONE') {
    const check = textConstraintCheckOf(field.constraints);
    const format = SYNTHETIC_PHONE_FORMATS.find((candidate) => check(syntheticPhoneNumberOf(candidate, 0)) === null);
    return format === undefined ? unplanned(needs('PHONE_FORMAT_UNSUPPORTED')) : planned({ kind: 'PHONE', format, issueOf: check });
  }
  return genericPlanOf(field, rule, source);
};

// ---------------------------------------------------------------------------------------------------------------
// 関係と、氏名の組
// ---------------------------------------------------------------------------------------------------------------

/** 作り方の値の下限と上限（比べる型と一緒に。分からなければ null）。 */
const boundsOf = (plan: FieldPlan | undefined): { readonly type: CandidateFieldType; readonly min: string; readonly max: string } | null => {
  if (plan === undefined) {
    return null;
  }
  if (plan.kind === 'GENERIC') {
    const { field } = plan;
    if (isChoiceType(field.type)) {
      return sortedBounds(field.type, usableOptionValues(field.options));
    }
    const { min, max } = field.constraints;
    return min === null || max === null ? null : { type: field.type, min, max };
  }
  return plan.kind === 'FIXED' ? sortedBounds('select-one', plan.values) : null;
};

/** 値の一覧の最小と最大（比べられない値があれば null）。 */
const sortedBounds = (type: CandidateFieldType, values: readonly string[]): { readonly type: CandidateFieldType; readonly min: string; readonly max: string } | null => {
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    const low = min === undefined ? null : compareAs(type, value, min);
    const high = max === undefined ? null : compareAs(type, value, max);
    if (low === null || high === null) {
      return null;
    }
    min = low < 0 ? value : min;
    max = high > 0 ? value : max;
  }
  return min === undefined || max === undefined ? null : { type, min, max };
};

/** 2 つの欄の値を比べる型（同じ型ならその型、違えば選択の欄の比べ方）。 */
export const relationCompareType = (left: CandidateFieldType, right: CandidateFieldType): CandidateFieldType =>
  (left === right ? left : 'select-one');

/** 関係の問題（従う欄に付ける。なければ null）。 */
const relationProblemOf = (
  relation: FieldRelation,
  rules: ReadonlyMap<string, FieldRule>,
  plans: ReadonlyMap<string, FieldPlan>,
): RuleProblem | null => {
  const names = relationFieldNamesOf(relation);
  const kinds = names.map((name) => rules.get(name)?.semanticKind);
  if (kinds.some((kind) => kind === undefined)) {
    return conflict('RELATION_FIELD_MISMATCH');
  }
  const [first, second, third] = kinds as SemanticKind[];
  switch (relation.kind) {
    case 'END_AFTER_START': {
      if (first === undefined || second === undefined || !TEMPORAL_KINDS.includes(first as never) || !TEMPORAL_KINDS.includes(second as never)) {
        return conflict('RELATION_FIELD_MISMATCH');
      }
      const start = boundsOf(plans.get(relation.startFieldName));
      const end = boundsOf(plans.get(relation.endFieldName));
      if (start === null || end === null) {
        return conflict('RELATION_UNSATISFIABLE');
      }
      const order = compareAs(relationCompareType(start.type, end.type), end.max, start.min);
      return order === null || order <= 0 ? conflict('RELATION_UNSATISFIABLE') : null;
    }
    case 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY':
      return first !== undefined && second !== undefined && third !== undefined
        && UNIT_PRICE_KINDS.includes(first) && QUANTITY_KINDS.includes(second) && TOTAL_KINDS.includes(third)
        ? null
        : conflict('RELATION_FIELD_MISMATCH');
    case 'KANA_MATCHES_NAME':
      return NAME_KANA_PAIRS.some(([name, kana]) => name === first && kana === second) ? null : conflict('RELATION_FIELD_MISMATCH');
  }
};

/**
 * 合計 = 単価 × 数量 の組み合わせを確かめるときの、単価と数量のそれぞれの値の数の上限（T29R-fix-1 の M-2）。超えれば、値の空間を等しい間隔で
 * 間引いた値だけを確かめる（組の数は、この数の 2 乗まで）。間引いた値に合う組がなければ、止める側に寄せる（`RELATION_UNSATISFIABLE`）。
 */
export const MAX_RELATION_SIDE_VALUES = 100;

/** 合計の値が、合計の欄の制約（数の欄は min・max・step、文字の欄は pattern・長さ）に合うか（判定と生成が使う。T29R-fix-1 の M-2）。 */
export const derivedTotalFits = (plan: Extract<FieldPlan, { kind: 'DERIVED_TOTAL' }>, value: string): boolean => {
  if (plan.issueOf !== null) {
    return plan.issueOf(value) === null;
  }
  const { field } = plan;
  const { min, max } = field.constraints;
  const low = min === null ? 0 : compareAs(field.type, value, min);
  const high = max === null ? 0 : compareAs(field.type, value, max);
  if (low === null || high === null || low < 0 || high > 0) {
    return false;
  }
  return fieldStepFitOf(field, value) === 'ON_STEP';
};

/** 単価・数量の欄の、確かめる値（人の固定の一覧か、汎用の規則の値。ほかの作り方は null）。 */
const relationSideValuesOf = (plan: FieldPlan | undefined): readonly string[] | null => {
  if (plan?.kind === 'FIXED') {
    return plan.values;
  }
  if (plan?.kind !== 'GENERIC') {
    return null;
  }
  const values = genericValueSampleOf(plan.field, MAX_RELATION_SIDE_VALUES);
  const { issueOf } = plan;
  return values === null || issueOf === null ? values : values.filter((value) => issueOf(value) === null);
};

/** 合計の欄の制約に合う、単価と数量の組（なければ空）。 */
const totalPairsOf = (
  relation: Extract<FieldRelation, { kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY' }>,
  plans: ReadonlyMap<string, FieldPlan>,
): readonly (readonly [string, string])[] => {
  const units = relationSideValuesOf(plans.get(relation.unitPriceFieldName));
  const quantities = relationSideValuesOf(plans.get(relation.quantityFieldName));
  const total = plans.get(relation.totalFieldName);
  if (units === null || quantities === null || total?.kind !== 'DERIVED_TOTAL') {
    return [];
  }
  return Object.freeze(units.flatMap((unit) => quantities.flatMap((quantity) => {
    const product = multiplyDecimalIntegers(unit, quantity);
    return product !== null && derivedTotalFits(total, product) ? [Object.freeze([unit, quantity] as const)] : [];
  })));
};

/** 従う欄（終了・合計・フリガナ）の名前。 */
const dependentOf = (relation: FieldRelation): string => relationFieldNamesOf(relation).at(-1) ?? '';

/** 人の関係に、テンプレートの既定の関係のうち、同じ種類で同じ従う欄でないものを足す。 */
const effectiveRelationsOf = (human: readonly FieldRelation[], rules: readonly FieldRule[]): readonly FieldRelation[] => [
  ...human,
  ...defaultRelationsOf(rules).filter((relation) =>
    !human.some((other) => other.kind === relation.kind && dependentOf(other) === dependentOf(relation))),
];

/** 生成で選ばない姓と名の組（辞書の owner の閉じた一覧。T29R-fix-1 の M-8）の、比べる鍵。 */
const personKeyOf = (family: string, given: string): string => JSON.stringify([family, given]);
const AVOIDED_PERSON_KEYS: ReadonlySet<string> = new Set(AVOIDED_PERSON_NAME_PAIRS.map(({ family, given }) => personKeyOf(family, given)));

/** 姓と名のすべての組（辞書の順。生成で選ばない組を除く）。 */
const ALL_PERSONS: readonly Person[] = Object.freeze(FAMILY_NAMES.flatMap((family) => GIVEN_NAMES
  .filter((given) => !AVOIDED_PERSON_KEYS.has(personKeyOf(family.name, given.name)))
  .map((given) => Object.freeze({ family, given }))));

// ---------------------------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------------------------

/** 判定の途中の欄 1 つ。 */
interface Working {
  readonly fieldName: string;
  field: CandidateField | null;
  problem: RuleProblem | null;
  rule: FieldRule | null;
  source: RuleSource | null;
  plan: FieldPlan | null;
  readonly external: readonly ExternalDeliveryKind[];
}

/** 判定と、値の作り方を求める（純粋。入力を変えない）。 */
export const planRuleSet = (ruleSet: RuleSetRevision, scenario: EvaluationScenario, candidate: DiscoveryCandidate): RuleSetPlan => {
  if (ruleSet.scenarioId !== scenario.scenarioId) {
    throw new RangeError('the rule set belongs to another scenario');
  }
  if (candidate.identityDigest !== scenario.candidate.identityDigest) {
    throw new RangeError('the candidate is not the target candidate of the scenario');
  }
  const confirmed = scenario.sideEffectConfirmations.NO_EXTERNAL_NOTIFICATION;
  const humanRules = new Map(ruleSet.fieldRules.map((rule) => [rule.fieldName, rule]));
  const selected = [...new Set(scenario.fieldNames)].sort(compareCodeUnits);

  // 段 1: 規則
  const working: Working[] = selected.map((fieldName) => {
    const decision = decideRule(fieldName, candidate, humanRules.get(fieldName), confirmed);
    return { fieldName, ...decision };
  });
  const decided = working.filter((item) => item.problem === null && item.rule !== null);
  const rules = new Map(decided.map((item) => [item.fieldName, item.rule as FieldRule]));

  // 関係（段 2 の前に決める。合計は単価 × 数量から求める）
  const relations = effectiveRelationsOf(ruleSet.relations, [...rules.values()])
    .filter((relation) => selected.includes(dependentOf(relation)));
  const derivedTotals = new Set(relations.filter((relation) => relation.kind === 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY').map(dependentOf));

  // 段 2: 作り方
  for (const item of working) {
    if (item.problem === null && item.plan === null && item.rule !== null && item.field !== null && item.source !== null) {
      const result = planOf(item.field, item.rule, item.source, derivedTotals.has(item.fieldName));
      item.plan = result.plan;
      item.problem = result.problem;
    }
  }

  // 氏名の組（すべての氏名の欄の制約に合う組）
  const personItems = working.filter((item) => item.problem === null && item.plan?.kind === 'PERSON');
  const personChecks = personItems.map((item) => ({ item, check: textConstraintCheckOf(item.field?.constraints ?? { pattern: null, minlength: null, maxlength: null }) }));
  const persons = personItems.length === 0 ? [] : ALL_PERSONS.filter((person) => personChecks.every(({ item, check }) =>
    check(personValueOf(person, (item.plan as Extract<FieldPlan, { kind: 'PERSON' }>).semanticKind)) === null));
  if (personItems.length > 0 && persons.length === 0) {
    const own = personChecks.map(({ item, check }) => ({
      item,
      detail: unsatisfiedDetailOf(ALL_PERSONS.map((person) => personValueOf(person, (item.plan as Extract<FieldPlan, { kind: 'PERSON' }>).semanticKind)),
        check),
    }));
    const target = own.find((entry) => entry.detail !== null) ?? own[0];
    if (target !== undefined) {
      target.item.problem = needs(target.detail ?? 'LENGTH_UNSATISFIABLE');
      target.item.plan = null;
    }
  }

  // 関係の問題（従う欄に付ける）
  const plans = new Map(working.filter((item) => item.problem === null && item.plan !== null).map((item) => [item.fieldName, item.plan as FieldPlan]));
  for (const relation of relations) {
    const dependent = working.find((item) => item.fieldName === dependentOf(relation));
    if (dependent === undefined || dependent.problem !== null) {
      continue;
    }
    let problem = relationFieldNamesOf(relation).some((name) => !plans.has(name))
      ? conflict('RELATION_FIELD_MISMATCH')
      : relationProblemOf(relation, rules, plans);
    // T29R-fix-1（M-2）: 合計の欄の制約の中で成り立つ組を求め、生成はその組から選ぶ（判定で作れると言えば、生成も作れる）。
    if (problem === null && relation.kind === 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY' && dependent.plan?.kind === 'DERIVED_TOTAL') {
      const pairs = totalPairsOf(relation, plans);
      if (pairs.length === 0) {
        problem = conflict('RELATION_UNSATISFIABLE');
      } else {
        dependent.plan = { ...dependent.plan, pairs };
        plans.set(dependent.fieldName, dependent.plan);
      }
    }
    if (problem !== null) {
      dependent.problem = problem;
      dependent.plan = null;
      plans.delete(dependent.fieldName);
    }
  }

  // required なのに送る欄に選ばれていない欄（T31d: UPDATE の保つ欄は、前の値のまま送るので数えない）
  const kept = keepFieldNamesOf(scenario);
  const unselectedRequired = [...new Set(candidate.fields
    .filter((field) => field.required && field.name.length > 0 && !selected.includes(field.name) && !kept.includes(field.name)
      && isSendableWriteFieldName(candidate, field.name))
    .map((field) => field.name))];

  const fields: FieldEvaluation[] = [
    ...working.map((item) => ({
      fieldName: item.fieldName,
      selected: true,
      status: item.problem?.code ?? 'DECIDED',
      problem: item.problem,
      source: item.source,
      rule: item.rule,
      externalDeliveryKinds: item.external,
    }) satisfies FieldEvaluation),
    ...unselectedRequired.map((fieldName) => ({
      fieldName,
      selected: false,
      status: 'NEEDS_RULE_INPUT',
      problem: needs('REQUIRED_FIELD_NOT_SELECTED'),
      source: null,
      rule: null,
      externalDeliveryKinds: [],
    }) satisfies FieldEvaluation),
  ].sort((left, right) => compareCodeUnits(left.fieldName, right.fieldName));

  const decidedRules = working.filter((item) => item.problem === null && item.rule !== null).map((item) => item.rule as FieldRule);
  const humanUnique = ruleSet.uniqueKeyFieldNames.filter((name) => selected.includes(name));
  const ruleUnique = humanUnique.length > 0 ? [...humanUnique].sort(compareCodeUnits) : [...defaultUniqueKeyFieldNamesOf(decidedRules)];
  // T31d: UPDATE で組が決まらなければ、変える欄（`DECIDED` の欄。`fields` は欄の名前の順）の組で、使った値と重ならない値を作る。
  const uniqueKeyFieldNames = ruleUnique.length === 0 && scenario.kind === 'UPDATE'
    ? fields.filter((field) => field.selected && field.status === 'DECIDED').map((field) => field.fieldName)
    : ruleUnique;

  const evaluation: RuleSetEvaluation = deepFreeze({
    executable: fields.every((field) => field.status === 'DECIDED'),
    fields,
    relations: relations.map((relation) => ({ ...relation })),
    uniqueKeyFieldNames,
  });
  return Object.freeze({
    evaluation,
    plans: new Map([...plans].filter(([name]) => fields.some((field) => field.fieldName === name && field.status === 'DECIDED'))),
    persons: Object.freeze(persons),
  });
};

/** 規則の集まりを、シナリオと対象の候補に照らして判定する（純粋。入力を変えない。凍結）。 */
export const evaluateRuleSet = (ruleSet: RuleSetRevision, scenario: EvaluationScenario, candidate: DiscoveryCandidate): RuleSetEvaluation =>
  planRuleSet(ruleSet, scenario, candidate).evaluation;
