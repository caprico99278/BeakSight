// 欄の判定の唯一の owner（Task 29 の設計書 3 章の欄ごとの判定と規則の優先順位、4.2。T29c）。純粋な関数。
// - `evaluateRuleSet(ruleSet, scenario, candidate)`: 送る欄ごとの状態（`DECIDED`・`NEEDS_RULE_INPUT`・`RULE_CONFLICT`・`EXTERNAL_DELIVERY_BLOCKED`）
//   と、実行してよいか（送る欄すべてが `DECIDED` で、required なのに送る欄に選ばれていない欄がない）を返す。
// - 欄ごとの判定の順（最初に当たったもの）:
//   1. 候補の送れる欄でない（ない、hidden・readonly・disabled、password・file、`_method`）→ `RULE_CONFLICT` の `FIELD_NOT_SENDABLE`。
//   2. 状態の欄（発見の分類の状態の欄の名前の語。`classify.ts` の `fieldNameHasStateWord`）→ `STATE_FIELD_NOT_USABLE`。DEF-147: API のシナリオの鍵は、
//      論理削除にあたる鍵（`isApiSoftDeleteKeyName`）だけが `STATE_FIELD_NOT_USABLE`。公開の状態の鍵は規則で決めるが、論理削除の語の固定の値は拒む。
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
// - T38e（Task 38 の設計書 3.6）: API のシナリオ（`scenarioTransportOf` が `API`）は、規則を本文の鍵（`fieldNames`）で引く。値を入れる先の欄は
//   `api.keyFields[].field`（`NAME` か `SELECTOR`）で、欄の型は候補の probe の欄（`submissionProbeKeyFieldsOf`）の型。欄は鍵の名前で作る
//   （推しと外部到達の語は鍵の名前で見る）。probe は欄の制約を残さないので、制約・選択肢・required はない。段 1 の 1 は「鍵と欄の対応が probe の
//   欄と同じ」（違えば `FIELD_NOT_SENDABLE`）。欄の型と鍵の JSON の型の組（`SCENARIO_API_FIELD_JSON_TYPES`）が合わない、number の鍵の固定の値・
//   人の範囲・汎用の値の空間が正規の数の形（`json-value.ts`）で表せなければ `JSON_VALUE_TYPE_MISMATCH`。ページが決める鍵（`api.pageKeys`）には
//   値を作らず、規則があれば送る欄に選ばれていない行の `PAGE_KEY_RULE_NOT_ALLOWED`。「required なのに送る欄に選ばれていない欄」は数えない
//   （欄に対応する鍵は、下書きの確かめですべて送る鍵）。FORM のシナリオは今のまま。
// - FM2c（手動の操作を減らす設計書 3A.3）:
//   - 保存した規則の基準日からの幅（`baseDateWindow`）は、範囲の手がかり（欄の min・max・step）のない date・datetime-local の欄にだけ当てる（欄に min・max が
//     あれば `RANGE_OUTSIDE_FIELD_CONSTRAINT`、step があるかほかの型なら `CONSTRAINT_UNSUPPORTED`）。値は基準日（生成は実行の許可の発行日。判定だけの
//     呼び出しは名前つきの参照の日 `EVALUATION_REFERENCE_BASE_DATE`。幅の値の数と関係の成り立ちは、どの基準日でも同じ）から求める。
//   - 「番号・コード」（`DIGIT_CODE`）は、欄の pattern の桁数の数字を作る（pattern が数字だけの固定の桁数でなければ `PATTERN_UNSUPPORTED`、長さが合わな
//     ければ `LENGTH_UNSATISFIABLE`）。FM2R fix round 1（I-3）: 番号・コードを推すのは、推した規則を作るとき（`inferredFieldRulesOf`）だけ。判定のたびの
//     推し（保存した規則のない欄）は FM2c の前と同じで、番号・コードを推さない（既定の幅も、判定では入れない）。保存した番号・コードの規則は当てる。
//   - API のシナリオの鍵の欄を、form の中の候補の欄（probe の欄の name で結ぶ。同じ型のとき）の制約と選択肢で補うのは、自動の作成の推し
//     （`inferredFieldRulesOf`）のときだけ（fix round 1）。判定と生成は、今どおり制約なし（承認の後に、補いで値が黙って変わらないため）。補った範囲と桁は、
//     自動の作成が保存する規則に固定する。保存した規則の桁の数（`digitCount`）は、番号・コードの桁に使う。
//   - テンプレートの既定を保存した規則の集まり（`templateDefaultsSaved`。fix round 1）は、保存した関係と一意にする欄の組だけを使う（既定を足さない）。
//   - 推した規則の写し（`inferredFieldRulesOf`）: 規則の集まりの自動の作成（`rule-set-inference.ts`）が使う。同じ段 1 の判定で推した規則（業務テンプレートと
//     汎用の規則）だけを返す（推しは副作用の確認に依らない。確認が済むまでメール・電話の欄を止めるのは、保存した規則の判定でも同じ）。
// - 呼び出し側の誤り（規則の集まりが別のシナリオ、候補の識別の digest がシナリオと違う、API のシナリオが API の指定を持たない）は `RangeError`。
import {
  API_SCENARIO_TRANSPORT,
  isSameScenarioApiFieldIdentity,
  isScenarioApiFieldJsonTypePair,
  scenarioApiFieldIdentityOf,
  scenarioTransportOf,
  type ScenarioApiSpec,
  type ScenarioRevision,
} from '../approval/scenario-contracts.js';
import type { ApiJsonValueType } from '../../core/api-request-shape.js';
import { deepFreeze } from '../../core/immutable.js';
import { compareCodeUnits } from '../../core/text.js';
import {
  CHOICE_FIELD_TYPES,
  FIELD_CONSTRAINT_NAMES,
  isMethodOverrideFieldName,
  isUnsendableFieldType,
  writeFieldsOfName,
  type CandidateField,
  type CandidateFieldConstraints,
  type CandidateFieldType,
  type DiscoveryCandidate,
} from '../../discovery/candidate-contracts.js';
import {
  fieldNameHasSoftDeleteWord,
  fieldNameHasStateWord,
  isApiSoftDeleteKeyName,
  isPublicationStateKeyName,
} from '../../discovery/classify.js';
import { isSendableWriteFieldName } from '../../discovery/read-check-contracts.js';
import { submissionProbeKeyFieldsOf } from '../../discovery/submission-probe-contracts.js';
import {
  NAME_KANA_PAIRS,
  PERSON_NAME_KINDS,
  TEMPORAL_KINDS,
  defaultRelationsOf,
  defaultUniqueKeyFieldNamesOf,
  fieldDigitCodeLengthOf,
  inferSemanticKind,
  isSemanticKindCompatible,
  templateDefaultRangeOf,
  type InferenceOptions,
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
  BASE_DATE_WINDOW_FIELD_TYPES,
  alignUpToFieldStep,
  baseDateWindowRangeOf,
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
  ruleBaseDateWindowOf,
  ruleDigitCountOf,
  syntheticEmailAddressOf,
  templateDefaultsSavedOf,
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
import { isJsonValueConvertible, jsonNumberRangeFits } from './json-value.js';
import { textConstraintCheckOf, unsatisfiedDetailOf, type TextConstraintCheck } from './text-constraints.js';

/** 判定が見るシナリオの項目（T38e: 送り方と API の指定。FORM のシナリオは持たない）。 */
export type EvaluationScenario = Pick<
  ScenarioRevision,
  'scenarioId' | 'kind' | 'candidate' | 'fieldNames' | 'sideEffectConfirmations' | 'update' | 'transport' | 'api'
>;

/** API のシナリオの API の指定（FORM のシナリオは null。API のシナリオが指定を持たなければ、呼び出し側の誤りの `RangeError`）。 */
export const evaluationApiSpecOf = (scenario: Pick<EvaluationScenario, 'transport' | 'api'>): ScenarioApiSpec | null => {
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT) {
    return null;
  }
  if (scenario.api === undefined) {
    throw new RangeError('the API scenario has no API spec');
  }
  return scenario.api;
};

/** 保つ欄（T31d。UPDATE の指定の保つ欄。CREATE と、UPDATE の指定がない版は空）。値を作らず、規則も要らない。 */
const keepFieldNamesOf = (scenario: EvaluationScenario): readonly string[] =>
  (scenario.kind === 'UPDATE' ? scenario.update?.keepFieldNames ?? [] : []);

/** 判定が見る規則の集まりの項目（FM2c: 保存の前の中身も判定できるように、id・版・時刻は見ない）。 */
export type EvaluationRuleSet = Pick<RuleSetRevision, 'scenarioId' | 'fieldRules' | 'relations' | 'uniqueKeyFieldNames' | 'templateDefaultsSaved'>;

/**
 * 判定だけの呼び出し（基準日を渡さない）で、基準日からの幅を値の範囲にするときの参照の日（FM2c）。幅は欄の min・max・step がないときだけ当てるので、
 * 値の数と、欄どうしの関係が成り立つかは、どの基準日でも同じ（生成は実行の許可の発行日を渡す）。
 */
export const EVALUATION_REFERENCE_BASE_DATE = '2000-01-01';

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
  /** FM2c: 番号・コード（`digits` 桁の数字。欄の pattern の桁数）。 */
  | { readonly kind: 'DIGIT_CODE'; readonly digits: number; readonly issueOf: TextConstraintCheck }
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

/** 送る欄 1 つの欄（FORM は候補の欄、API は鍵に対応する probe の欄から作る欄）と、送れるか、鍵の JSON の型（FORM は null。T38e）。 */
interface SendTarget {
  readonly field: CandidateField | null;
  readonly sendable: boolean;
  readonly jsonType: ApiJsonValueType | null;
  /** FM2c fix round 1: 自動の作成の推しで、API の鍵の欄を補った同じ form の欄（ほかは null か、ない）。 */
  readonly formField?: CandidateField | null;
}

/** FORM のシナリオの送る欄。 */
const formTargetOf = (candidate: DiscoveryCandidate, name: string): SendTarget => {
  // T31b fix round 1: 値を送る欄（組の名前は組の checkbox だけ。`writeFieldsOfName`）で判定する（組でない同じ名前の欄は、今どおり送れない）。
  const fields = writeFieldsOfName(candidate.fields, name);
  const field = mergedFieldOf(fields);
  return {
    field,
    sendable: field !== null && isSendableWriteFieldName(candidate, name) && !isMethodOverrideFieldName(name)
      && !fields.some((candidateField) => isUnsendableFieldType(candidateField.type)),
    jsonType: null,
  };
};

/** 制約のない欄の制約（probe は欄の制約を残さない。T38e）。 */
const NO_FIELD_CONSTRAINTS: CandidateFieldConstraints = Object.freeze(
  Object.fromEntries(FIELD_CONSTRAINT_NAMES.map((name) => [name, null])) as CandidateFieldConstraints,
);

/**
 * API のシナリオの送る鍵の欄（T38e）。鍵と欄の対応（`api.keyFields`）が、候補の probe の鍵と欄の対応（`submissionProbeKeyFieldsOf`）と同じ欄の
 * 識別のときだけ送れる。欄は鍵の名前と probe の欄の型で作る（制約・選択肢・required はない）。
 */
/** form の候補の種類（FM2c: この候補の欄だけが、probe の欄と同じ form の欄）。 */
const FORM_CANDIDATE_KIND = 'FORM' satisfies DiscoveryCandidate['kind'];

/**
 * FM2c: probe の欄と同じ form の、同じ name・同じ型の候補の欄（制約と選択肢を補う）。form の外のボタンの候補、name のない probe の欄、型の違う欄は null。
 */
const sameFormFieldOf = (candidate: DiscoveryCandidate, probeField: { readonly name: string | null; readonly type: CandidateFieldType }): CandidateField | null => {
  if (candidate.kind !== FORM_CANDIDATE_KIND || probeField.name === null || probeField.name.length === 0) {
    return null;
  }
  const field = mergedFieldOf(writeFieldsOfName(candidate.fields, probeField.name));
  return field !== null && field.type === probeField.type ? field : null;
};

/**
 * API のシナリオの送る鍵の欄。FM2c fix round 1: 同じ form の欄の制約と選択肢で補うのは、自動の作成の推し（`supplement` が真）のときだけ。判定と生成は、
 * 今どおり制約なし（承認の後に、補いで送る値が黙って変わらないため。補った範囲と桁は、自動の作成が保存する規則に固定する）。
 */
const apiTargetOf = (candidate: DiscoveryCandidate, api: ScenarioApiSpec, key: string, supplement: boolean): SendTarget => {
  const keyField = api.keyFields.find((item) => item.key === key);
  const probe = candidate.submissionProbe;
  const probeField = probe === undefined ? null : submissionProbeKeyFieldsOf(probe).find((item) => item.key === key)?.field ?? null;
  const identity = probeField === null ? null : scenarioApiFieldIdentityOf(probeField);
  if (keyField === undefined || probeField === null || identity === null || !isSameScenarioApiFieldIdentity(identity, keyField.field)) {
    return { field: null, sendable: false, jsonType: null };
  }
  const { type } = probeField;
  const formField = supplement ? sameFormFieldOf(candidate, probeField) : null;
  const field: CandidateField = {
    name: key,
    tag: type === 'textarea' ? 'textarea' : type.startsWith('select') ? 'select' : 'input',
    type,
    required: false,
    readonly: false,
    disabled: false,
    hidden: false,
    constraints: formField?.constraints ?? NO_FIELD_CONSTRAINTS,
    options: formField?.options ?? null,
    omittedOptionCount: formField?.omittedOptionCount ?? 0,
    hasValue: false,
  };
  return { field, sendable: !isMethodOverrideFieldName(key) && !isUnsendableFieldType(type), jsonType: keyField.type, formField };
};

/**
 * 人の規則の値（固定の一覧、number の鍵の人の範囲の端と刻み）が、鍵の JSON の型に変えられるか（T38e。`json-value.ts`）。推した規則は値を
 * 持たない（作る値の空間は段 2 で確かめる）。
 */
const ruleValuesFitJsonType = (rule: FieldRule, source: RuleSource, jsonType: ApiJsonValueType): boolean => {
  if (source !== 'HUMAN') {
    return true;
  }
  if (!rule.fixedValues.every((value) => isJsonValueConvertible(value, jsonType))) {
    return false;
  }
  const range = jsonType === 'number' ? rule.range : null;
  return range === null || [range.min, range.max, range.step].every((value) => value === null || isJsonValueConvertible(value, jsonType));
};

const decideRule = (
  name: string,
  target: SendTarget,
  humanRule: FieldRule | undefined,
  notificationConfirmed: boolean,
  inferenceOptions: InferenceOptions = {},
): RuleDecision => {
  const { field, jsonType } = target;
  if (field === null || !target.sendable) {
    return { field, problem: conflict('FIELD_NOT_SENDABLE'), rule: null, source: null, plan: null, external: [] };
  }
  const external = externalDeliveryKindsOf(field);
  const fail = (problem: RuleProblem, rule: FieldRule | null = null, source: RuleSource | null = null): RuleDecision =>
    ({ field, problem, rule, source, plan: null, external });
  // T38e: 欄の型と鍵の JSON の型の組（T38b の下書きの確かめと同じ表）。
  if (jsonType !== null && !isScenarioApiFieldJsonTypePair(field.type, jsonType)) {
    return fail(conflict('JSON_VALUE_TYPE_MISMATCH'));
  }
  // DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: API のシナリオの鍵（`jsonType` がある）は、論理削除にあたる鍵だけを使えない
  // （`isApiSoftDeleteKeyName`。公開の状態の鍵は、ほかの欄と同じく入力の規則で利用者が決める）。ただし、その値に論理削除の語を固定することは拒む。
  // FORM のシナリオの欄は、今どおり状態の欄の語（`fieldNameHasStateWord`）で使えない。
  if (jsonType === null ? fieldNameHasStateWord(field.name) : isApiSoftDeleteKeyName(field.name)) {
    return fail(conflict('STATE_FIELD_NOT_USABLE'));
  }
  if (jsonType !== null && isPublicationStateKeyName(field.name) && (humanRule?.fixedValues ?? []).some(fieldNameHasSoftDeleteWord)) {
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
    const kind = inferSemanticKind(field, inferenceOptions);
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
  if (jsonType !== null && !ruleValuesFitJsonType(rule, source, jsonType)) {
    return fail(conflict('JSON_VALUE_TYPE_MISMATCH'), rule, source);
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

/**
 * FM2c: 保存した規則の基準日からの幅の作り方（範囲の手がかりのない date・datetime-local の欄だけ。値の範囲は基準日に日の数を足して求める）。
 */
const baseDateWindowPlanOf = (field: CandidateField, window: NonNullable<ReturnType<typeof ruleBaseDateWindowOf>>, baseDate: string): PlanResult => {
  const { min, max, step } = field.constraints;
  if (!(BASE_DATE_WINDOW_FIELD_TYPES as readonly CandidateFieldType[]).includes(field.type) || step !== null) {
    return unplanned(needs('CONSTRAINT_UNSUPPORTED'));
  }
  if (min !== null || max !== null) {
    return unplanned(conflict('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
  }
  const bounds = baseDateWindowRangeOf(field.type, baseDate, window);
  if (bounds === null) {
    return unplanned(needs('CONSTRAINT_UNSUPPORTED'));
  }
  const pseudo: CandidateField = { ...field, constraints: { ...field.constraints, min: bounds.min, max: bounds.max } };
  const reason = checkGenericRule(pseudo);
  return reason === null
    ? planned({ kind: 'GENERIC', field: pseudo, issueOf: null })
    : unplanned(reason === 'NOT_GENERIC_TYPE' ? conflict('SEMANTIC_KIND_TYPE_MISMATCH') : needs(reason));
};

/** 汎用の規則の値の空間を使う作り方（数・日時・色・選択。範囲は欄、人の規則、テンプレートの既定の順に補う）。 */
const genericPlanOf = (field: CandidateField, rule: FieldRule, source: RuleSource, baseDate: string): PlanResult => {
  if (isChoiceType(field.type) || field.type === 'color') {
    const reason = checkGenericRule(field);
    return reason === null ? planned({ kind: 'GENERIC', field, issueOf: null }) : unplanned(reason === 'NOT_GENERIC_TYPE'
      ? conflict('SEMANTIC_KIND_TYPE_MISMATCH')
      : needs(reason));
  }
  const window = source === 'HUMAN' ? ruleBaseDateWindowOf(rule) : null;
  if (window !== null) {
    return baseDateWindowPlanOf(field, window, baseDate);
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

/** HTML の number の既定の刻み（汎用の値の空間の刻みがないとき）。 */
const DEFAULT_NUMBER_SPACE_STEP = '1';

/**
 * 汎用の値の空間（数の欄の最小・最大・刻み）の値が、number の鍵の値（正規の数の形）で表せる見込みか（T38e。`jsonNumberRangeFits`）。数でない欄
 * （日時・色・選択）は、number の鍵の組に入らない（段 1 で拒む）ので、ここでは表せないとする。
 */
const genericSpaceFitsJsonNumber = (field: CandidateField): boolean => {
  const { min, max, step } = field.constraints;
  return field.type === 'number' && min !== null && max !== null && jsonNumberRangeFits(min, max, step ?? DEFAULT_NUMBER_SPACE_STEP);
};

/** 規則の意味の種類の作り方（段 2）。氏名は、組の絞り込みの後に確かめる。 */
const planOf = (field: CandidateField, rule: FieldRule, source: RuleSource, derivedTotal: boolean, baseDate: string): PlanResult => {
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
  if (kind === 'DIGIT_CODE') {
    // FM2c: 欄の pattern の桁数の数字（pattern が数字だけの固定の桁数でなければ作らない）。fix round 1: 保存した規則の桁の数があれば、それを使い
    // （API の鍵の欄。欄の制約に合うかは下で確かめる）。
    const digits = (source === 'HUMAN' ? ruleDigitCountOf(rule) : null) ?? fieldDigitCodeLengthOf(field.constraints);
    if (digits === null) {
      return unplanned(needs('PATTERN_UNSUPPORTED'));
    }
    const check = textConstraintCheckOf(field.constraints);
    const detail = unsatisfiedDetailOf([DIGIT_CODE_SAMPLE_DIGIT.repeat(digits)], check);
    return detail === null ? planned({ kind: 'DIGIT_CODE', digits, issueOf: check }) : unplanned(needs(detail));
  }
  return genericPlanOf(field, rule, source, baseDate);
};

/** 番号・コードの値の形を確かめる見本の数字（FM2c。桁の数だけ並べる）。 */
const DIGIT_CODE_SAMPLE_DIGIT = '0';

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

/**
 * 人の関係に、テンプレートの既定の関係のうち、同じ種類で同じ従う欄でないものを足す。FM2c fix round 1: テンプレートの既定を保存した規則の集まり
 * （`templateDefaultsSaved`）は、保存した関係だけ（既定を足さない）。
 */
const effectiveRelationsOf = (human: readonly FieldRelation[], rules: readonly FieldRule[], defaultsSaved: boolean): readonly FieldRelation[] => [
  ...human,
  ...(defaultsSaved ? [] : defaultRelationsOf(rules).filter((relation) =>
    !human.some((other) => other.kind === relation.kind && dependentOf(other) === dependentOf(relation)))),
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
  /** 鍵の JSON の型（API のシナリオの送る鍵。FORM は null。T38e）。 */
  readonly jsonType: ApiJsonValueType | null;
  field: CandidateField | null;
  problem: RuleProblem | null;
  rule: FieldRule | null;
  source: RuleSource | null;
  plan: FieldPlan | null;
  readonly external: readonly ExternalDeliveryKind[];
}

/** 送る欄の名前（重なりを除き、UTF-16 のコード単位の順）。 */
const selectedFieldNamesOf = (scenario: EvaluationScenario): readonly string[] => [...new Set(scenario.fieldNames)].sort(compareCodeUnits);

/** 送る欄 1 つの欄（FORM は候補の欄、API は鍵に対応する probe の欄から作る欄）。 */
const sendTargetOf = (candidate: DiscoveryCandidate, api: ScenarioApiSpec | null, fieldName: string, supplement = false): SendTarget =>
  (api === null ? formTargetOf(candidate, fieldName) : apiTargetOf(candidate, api, fieldName, supplement));

/** 候補がシナリオの対象の候補か（違えば呼び出し側の誤りの `RangeError`）。 */
const assertTargetCandidate = (scenario: EvaluationScenario, candidate: DiscoveryCandidate): void => {
  if (candidate.identityDigest !== scenario.candidate.identityDigest) {
    throw new RangeError('the candidate is not the target candidate of the scenario');
  }
};

/** 推した規則を作るときの推しの選び（FM2R fix round 1。I-3。判定のたびの推しは既定の選びのまま）。 */
const SAVED_RULE_INFERENCE: InferenceOptions = Object.freeze({ digitCode: true });

/** 推した規則 1 件と、その規則を当てる欄（FM2c。規則の集まりの自動の作成が使う）。 */
export interface InferredFieldRule {
  /** 推した規則（出どころの印は `INFERRED`。範囲・基準日からの幅は持たない）。 */
  readonly rule: FieldRule;
  /** 規則を当てる欄（FORM は候補の欄、API は鍵の欄。API の鍵の欄は、同じ form の欄の制約と選択肢で補った欄）。 */
  readonly field: CandidateField;
  /**
   * API の鍵の欄を補った、同じ form の欄（FM2c fix round 1。FORM のシナリオと、補わなかった鍵は null）。判定と生成は補わないので、自動の作成は、
   * この欄から求めた範囲と桁を、保存する規則に固定する。
   */
  readonly formField: CandidateField | null;
}

/**
 * 送る欄ごとに、段 1 の判定（人の規則なし）で業務テンプレートか汎用の規則が推した規則（FM2c。純粋。欄の名前の順。凍結）。推しは副作用の確認に
 * 依らない（メール・電話の欄も推す。確認が済むまで止めるのは、保存した規則の判定でも同じ）。推せない欄、「送らない」側に固定する欄、送れない欄は
 * 入らない。候補がシナリオの対象でなければ `RangeError`。
 */
export const inferredFieldRulesOf = (scenario: EvaluationScenario, candidate: DiscoveryCandidate): readonly InferredFieldRule[] => {
  assertTargetCandidate(scenario, candidate);
  const api = evaluationApiSpecOf(scenario);
  return deepFreeze(selectedFieldNamesOf(scenario).flatMap((fieldName): InferredFieldRule[] => {
    const target = sendTargetOf(candidate, api, fieldName, true);
    // FM2R fix round 1（I-3）: FM2c で足した推し（番号・コード）は、推した規則を作るときだけ。
    const decision = decideRule(fieldName, target, undefined, true, SAVED_RULE_INFERENCE);
    const inferred = decision.source === 'TEMPLATE' || decision.source === 'GENERIC';
    return decision.problem === null && decision.rule !== null && decision.field !== null && inferred
      ? [{ rule: { ...decision.rule, origin: 'INFERRED' }, field: decision.field, formField: target.formField ?? null }]
      : [];
  }));
};

/**
 * 判定と、値の作り方を求める（純粋。入力を変えない）。FM2c: 基準日（実行の許可の発行日。Asia/Tokyo の `YYYY-MM-DD`）は、保存した規則の基準日からの
 * 幅の値の範囲に使う（生成が渡す。渡さなければ参照の日 `EVALUATION_REFERENCE_BASE_DATE`）。
 */
export const planRuleSet = (
  ruleSet: EvaluationRuleSet,
  scenario: EvaluationScenario,
  candidate: DiscoveryCandidate,
  baseDate: string = EVALUATION_REFERENCE_BASE_DATE,
): RuleSetPlan => {
  if (ruleSet.scenarioId !== scenario.scenarioId) {
    throw new RangeError('the rule set belongs to another scenario');
  }
  assertTargetCandidate(scenario, candidate);
  const api = evaluationApiSpecOf(scenario);
  const confirmed = scenario.sideEffectConfirmations.NO_EXTERNAL_NOTIFICATION;
  const humanRules = new Map(ruleSet.fieldRules.map((rule) => [rule.fieldName, rule]));
  const selected = selectedFieldNamesOf(scenario);

  // 段 1: 規則（T38e: API のシナリオは、本文の鍵で規則を引き、鍵に対応する probe の欄で判定する）
  const working: Working[] = selected.map((fieldName) => {
    const target = sendTargetOf(candidate, api, fieldName);
    const decision = decideRule(fieldName, target, humanRules.get(fieldName), confirmed);
    return { fieldName, jsonType: target.jsonType, ...decision };
  });
  const decided = working.filter((item) => item.problem === null && item.rule !== null);
  const rules = new Map(decided.map((item) => [item.fieldName, item.rule as FieldRule]));

  // 関係（段 2 の前に決める。合計は単価 × 数量から求める）
  const defaultsSaved = templateDefaultsSavedOf(ruleSet);
  const relations = effectiveRelationsOf(ruleSet.relations, [...rules.values()], defaultsSaved)
    .filter((relation) => selected.includes(dependentOf(relation)));
  const derivedTotals = new Set(relations.filter((relation) => relation.kind === 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY').map(dependentOf));

  // 段 2: 作り方
  for (const item of working) {
    if (item.problem === null && item.plan === null && item.rule !== null && item.field !== null && item.source !== null) {
      const result = planOf(item.field, item.rule, item.source, derivedTotals.has(item.fieldName), baseDate);
      item.plan = result.plan;
      item.problem = result.problem;
      // T38e: number の鍵の汎用の値の空間（端と刻み）が、正規の数の形で表せること。
      if (item.jsonType === 'number' && result.plan?.kind === 'GENERIC' && !genericSpaceFitsJsonNumber(result.plan.field)) {
        item.plan = null;
        item.problem = conflict('JSON_VALUE_TYPE_MISMATCH');
      }
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
      const allPairs = totalPairsOf(relation, plans);
      // T38e: number の鍵の合計は、正規の数の形で表せる組だけ（合計は単価 × 数量なので、桁が増える）。
      const pairs = dependent.jsonType === 'number'
        ? allPairs.filter(([unit, quantity]) => isJsonValueConvertible(multiplyDecimalIntegers(unit, quantity), 'number'))
        : allPairs;
      if (allPairs.length === 0) {
        problem = conflict('RELATION_UNSATISFIABLE');
      } else if (pairs.length === 0) {
        problem = conflict('JSON_VALUE_TYPE_MISMATCH');
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

  // required なのに送る欄に選ばれていない欄（T31d: UPDATE の保つ欄は、前の値のまま送るので数えない。T38e: API のシナリオは数えない）
  const kept = keepFieldNamesOf(scenario);
  const unselectedRequired = api !== null ? [] : [...new Set(candidate.fields
    .filter((field) => field.required && field.name.length > 0 && !selected.includes(field.name) && !kept.includes(field.name)
      && isSendableWriteFieldName(candidate, field.name))
    .map((field) => field.name))];
  // T38e: ページが決める鍵の規則（値を作らない鍵。送る欄に選ばれていない行として拒む）
  const pageKeyRules = api === null ? [] : ruleSet.fieldRules.filter((rule) =>
    api.pageKeys.some(({ key }) => key === rule.fieldName) && !selected.includes(rule.fieldName));

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
    ...pageKeyRules.map((rule) => ({
      fieldName: rule.fieldName,
      selected: false,
      status: 'RULE_CONFLICT',
      problem: conflict('PAGE_KEY_RULE_NOT_ALLOWED'),
      source: 'HUMAN',
      rule,
      externalDeliveryKinds: [],
    }) satisfies FieldEvaluation),
  ].sort((left, right) => compareCodeUnits(left.fieldName, right.fieldName));

  const decidedRules = working.filter((item) => item.problem === null && item.rule !== null).map((item) => item.rule as FieldRule);
  const humanUnique = ruleSet.uniqueKeyFieldNames.filter((name) => selected.includes(name));
  // FM2c fix round 1: テンプレートの既定を保存した規則の集まりは、保存した組だけ（既定を足さない）。
  const ruleUnique = humanUnique.length > 0 || defaultsSaved ? [...humanUnique].sort(compareCodeUnits) : [...defaultUniqueKeyFieldNamesOf(decidedRules)];
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
export const evaluateRuleSet = (ruleSet: EvaluationRuleSet, scenario: EvaluationScenario, candidate: DiscoveryCandidate): RuleSetEvaluation =>
  planRuleSet(ruleSet, scenario, candidate).evaluation;
