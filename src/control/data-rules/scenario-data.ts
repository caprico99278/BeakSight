// 送る値の生成の入口（Task 29 の設計書 3 章の決定的な生成と一意性、4.2、11 章の電話番号。T29c）。純粋な関数。書き込みの要求は送らない
// （作った値を送るのは Task 30）。
// - まず欄の判定（`field-evaluation.ts` の `planRuleSet`）をかけ、実行できなければ判定の問題を返す（推し量って作らない）。
// - seed は T29b の `createDataSeed`（設計書 2 章の式）。seed の入力は、シナリオ（プロファイル・id・版）と規則の集まりの digest に合うこと
//   （合わなければ呼び出し側の誤りの `RangeError`）。基準日（実行の許可の発行日。Asia/Tokyo の `YYYY-MM-DD`）も形を確かめ、記録に残す。
// - 欄ごとの列: 用途（`purpose`）に、欄の名前と試しの番号（`attempt`）を鍵を並べた JSON にしたものを使う。氏名とフリガナは、同じ人（姓と名の組）を
//   1 つの列（`person`）から選ぶ。
// - 値: 「送らない」側（通知の欄）、人の固定の一覧（優先）、汎用の規則の値の空間、氏名、辞書、メール（`sample` と数字の局所部の
//   `@example.invalid`）、電話（`090-0XXX-XXXX` か `0900XXXXXXX`。使った番号（数字だけで比べる）と重ならない番号を、列から作り直す）。
// - 関係: 終了 > 開始（同じ値の空間なら入れ替え、そうでなければ作り直し）、合計 = 単価 × 数量（判定が求めた、合計の欄の制約に合う単価と数量の
//   組から選ぶ。T29R-fix-1 の M-2）、
//   フリガナは氏名と同じ人（同じ組から作るので、いつも成り立つ）。
// - 一意性: 一意にする欄の組の値（`uniqueKeyOf`）が、使った組（`usedUniqueKeys`。Task 30 が送った記録から渡す）とぶつかれば、試しの番号を進めて
//   作り直す。`MAX_UNIQUE_RETRIES` 回の作り直しでも作れなければ `RULE_CONFLICT` の `UNIQUE_COMBINATIONS_EXHAUSTED`（関係が成り立たなければ
//   `RELATION_UNSATISFIABLE`）。
import { deepFreeze } from '../../core/immutable.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { compareCodeUnits } from '../../core/text.js';
import type { ScenarioRevision } from '../approval/scenario-contracts.js';
import type { CandidateField, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { createDataSeed, createDeterministicStream, type DataSeed, type DataSeedInput } from './deterministic-stream.js';
import { derivedTotalFits, personValueOf, planRuleSet, relationCompareType, type FieldPlan } from './field-evaluation.js';
import { compareFieldValues, generateGenericValue, isGenericBaseDate, multiplyDecimalIntegers } from './generic-values.js';
import { computeRuleSetDigest } from './rule-digest.js';
import {
  MAX_UNIQUE_RETRIES,
  SYNTHETIC_EMAIL_LOCAL_DIGITS,
  SYNTHETIC_PHONE_VARIABLE_DIGITS,
  maxNumberOfDigits,
  phoneNumberDigitsOf,
  relationFieldNamesOf,
  syntheticEmailAddressOf,
  syntheticPhoneNumberOf,
  type FieldRelation,
  type FieldRuleProblem,
  type RuleProblem,
  type RuleSetRevision,
} from './rule-contracts.js';

/** 生成の入力。 */
export interface ScenarioDataInput {
  readonly ruleSet: RuleSetRevision;
  /** T31d: UPDATE のシナリオは、変える欄（`fieldNames`）だけの値を返す（保つ欄の値は作らない。UPDATE の指定の `keepFieldNames`）。 */
  readonly scenario: Pick<
    ScenarioRevision,
    'scenarioId' | 'profileId' | 'revision' | 'kind' | 'candidate' | 'fieldNames' | 'sideEffectConfirmations' | 'update'
  >;
  /** シナリオの対象の候補（最後の発見の候補の写し）。 */
  readonly candidate: DiscoveryCandidate;
  readonly seedInput: DataSeedInput;
  /** すでに使った一意にする欄の組（`uniqueKeyOf` の値）。 */
  readonly usedUniqueKeys: readonly string[];
  /** すでに作った電話番号（形によらず、数字だけで比べる）。 */
  readonly usedPhoneNumbers: readonly string[];
  /** 基準日（実行の許可の発行日。Asia/Tokyo の `YYYY-MM-DD`）。 */
  readonly baseDate: string;
}

/** 欄の問題 1 件（契約の `FieldRuleProblem`）。 */
export type FieldProblemReport = FieldRuleProblem;

/** 使った seed の記録（基準日と、成功した試しの番号を含む）。 */
export interface SeedRecord {
  readonly seed: DataSeed;
  readonly seedInput: DataSeedInput;
  readonly baseDate: string;
  readonly attempt: number;
}

/** 生成の結果。`values` の null は、その欄を送らない（通知の欄の「送らない」側）。 */
export type ScenarioDataResult =
  | {
    readonly ok: true;
    readonly values: Readonly<Record<string, string | null>>;
    /** 一意にする欄の組の値（組がなければ null）。 */
    readonly uniqueKey: string | null;
    /** 作った電話番号（使った番号の記録に足す）。 */
    readonly phoneNumbers: readonly string[];
    readonly seedRecord: SeedRecord;
  }
  | { readonly ok: false; readonly problems: readonly FieldProblemReport[] };

/** 一意にする欄の組の値（欄の名前 → 値の、鍵を並べた JSON）。 */
export const uniqueKeyOf = (values: Readonly<Record<string, string | null>>, fieldNames: readonly string[]): string =>
  sortedKeysJsonOf(Object.fromEntries([...fieldNames].sort(compareCodeUnits).map((name) => [name, values[name] ?? null])));

const failed = (problems: readonly FieldProblemReport[]): ScenarioDataResult => deepFreeze({ ok: false, problems: [...problems] });

/** 試し 1 回の失敗（次の試しで作り直すもの）か、止める問題。 */
type AttemptOutcome =
  | { readonly kind: 'DONE'; readonly values: Record<string, string | null>; readonly phoneNumbers: readonly string[] }
  | { readonly kind: 'RETRY'; readonly report: FieldProblemReport }
  | { readonly kind: 'STOP'; readonly report: FieldProblemReport };

const report = (fieldName: string, problem: RuleProblem): FieldProblemReport => ({ fieldName, problem });
const RELATION_UNSATISFIABLE: RuleProblem = { code: 'RULE_CONFLICT', detail: 'RELATION_UNSATISFIABLE' };
const UNIQUE_EXHAUSTED: RuleProblem = { code: 'RULE_CONFLICT', detail: 'UNIQUE_COMBINATIONS_EXHAUSTED' };

/** 2 つの汎用の値の空間が同じか（終了と開始を入れ替えてよいか）。 */
const sameSpace = (left: FieldPlan | undefined, right: FieldPlan | undefined): boolean => {
  const spaceOf = (plan: FieldPlan | undefined): string | null => {
    if (plan?.kind === 'GENERIC') {
      const { type, constraints, options } = plan.field;
      return JSON.stringify([type, constraints.min, constraints.max, constraints.step, options]);
    }
    return plan?.kind === 'FIXED' ? JSON.stringify(plan.values) : null;
  };
  const key = spaceOf(left);
  return key !== null && key === spaceOf(right);
};

/** 比べる型（作り方の欄の型）。 */
const typeOf = (plan: FieldPlan | undefined): CandidateField['type'] =>
  (plan?.kind === 'GENERIC' || plan?.kind === 'DERIVED_TOTAL' ? plan.field.type : 'select-one');

/** 関係を当てる（値を書き換える）。成り立たなければ、作り直しか止める問題。 */
const applyRelation = (
  relation: FieldRelation,
  values: Record<string, string | null>,
  plans: ReadonlyMap<string, FieldPlan>,
): AttemptOutcome | null => {
  const names = relationFieldNamesOf(relation);
  const dependent = names.at(-1) ?? '';
  if (relation.kind === 'KANA_MATCHES_NAME') {
    return null;
  }
  if (relation.kind === 'END_AFTER_START') {
    const start = values[relation.startFieldName];
    const end = values[relation.endFieldName];
    const startPlan = plans.get(relation.startFieldName);
    const endPlan = plans.get(relation.endFieldName);
    if (typeof start !== 'string' || typeof end !== 'string') {
      return { kind: 'STOP', report: report(dependent, RELATION_UNSATISFIABLE) };
    }
    const order = compareFieldValues(relationCompareType(typeOf(startPlan), typeOf(endPlan)), end, start);
    if (order === null) {
      return { kind: 'STOP', report: report(dependent, RELATION_UNSATISFIABLE) };
    }
    if (order < 0 && sameSpace(startPlan, endPlan)) {
      values[relation.startFieldName] = end;
      values[relation.endFieldName] = start;
      return null;
    }
    return order > 0 ? null : { kind: 'RETRY', report: report(dependent, RELATION_UNSATISFIABLE) };
  }
  const unitPrice = values[relation.unitPriceFieldName];
  const quantity = values[relation.quantityFieldName];
  const totalPlan = plans.get(relation.totalFieldName);
  const total = typeof unitPrice === 'string' && typeof quantity === 'string' ? multiplyDecimalIntegers(unitPrice, quantity) : null;
  if (total === null || totalPlan?.kind !== 'DERIVED_TOTAL') {
    return { kind: 'STOP', report: report(dependent, RELATION_UNSATISFIABLE) };
  }
  if (!derivedTotalFits(totalPlan, total)) {
    return { kind: 'RETRY', report: report(dependent, RELATION_UNSATISFIABLE) };
  }
  values[relation.totalFieldName] = total;
  return null;
};

/** 試し 1 回（試しの番号 `attempt` の列から、すべての欄の値を作る）。 */
const attemptOnce = (
  attempt: number,
  seed: DataSeed,
  input: ScenarioDataInput,
  planned: ReturnType<typeof planRuleSet>,
  usedPhones: ReadonlySet<string>,
): AttemptOutcome => {
  const streamOf = (purpose: Record<string, unknown>) => createDeterministicStream(seed, sortedKeysJsonOf({ ...purpose, attempt }));
  const person = planned.persons.length === 0 ? null : streamOf({ person: true }).pick(planned.persons);
  // 欄の名前（`__proto__` などを含みうる）を鍵にするので、原型のない入れ物にする。
  const values = Object.create(null) as Record<string, string | null>;
  const phoneNumbers: string[] = [];
  const names = [...planned.plans.keys()].sort(compareCodeUnits);
  for (const fieldName of names) {
    const plan = planned.plans.get(fieldName);
    const stream = streamOf({ field: fieldName });
    switch (plan?.kind) {
      case 'OPT_OUT':
        values[fieldName] = plan.value;
        break;
      case 'FIXED': {
        const choices = plan.phone ? plan.values.filter((value) => !usedPhones.has(phoneNumberDigitsOf(value))) : plan.values;
        if (choices.length === 0) {
          return { kind: 'STOP', report: report(fieldName, UNIQUE_EXHAUSTED) };
        }
        const value = stream.pick(choices);
        values[fieldName] = value;
        if (plan.phone) {
          phoneNumbers.push(value);
        }
        break;
      }
      case 'GENERIC': {
        const result = generateGenericValue(plan.field, stream, { baseDate: input.baseDate });
        if (!result.ok) {
          return { kind: 'STOP', report: report(fieldName, { code: 'NEEDS_RULE_INPUT', detail: 'CONSTRAINT_UNSUPPORTED' }) };
        }
        if (plan.issueOf !== null && plan.issueOf(result.value) !== null) {
          return { kind: 'RETRY', report: report(fieldName, { code: 'NEEDS_RULE_INPUT', detail: 'PATTERN_UNSUPPORTED' }) };
        }
        values[fieldName] = result.value;
        break;
      }
      case 'PERSON':
        values[fieldName] = person === null ? null : personValueOf(person, plan.semanticKind);
        break;
      case 'DICTIONARY':
        values[fieldName] = stream.pick(plan.values);
        break;
      case 'EMAIL': {
        const value = syntheticEmailAddressOf(stream.nextIntInclusive(0, maxNumberOfDigits(SYNTHETIC_EMAIL_LOCAL_DIGITS)));
        if (plan.issueOf(value) !== null) {
          return { kind: 'RETRY', report: report(fieldName, { code: 'NEEDS_RULE_INPUT', detail: 'PATTERN_UNSUPPORTED' }) };
        }
        values[fieldName] = value;
        break;
      }
      case 'PHONE': {
        let value: string | null = null;
        for (let draw = 0; draw <= MAX_UNIQUE_RETRIES && value === null; draw += 1) {
          const drawn = syntheticPhoneNumberOf(plan.format, stream.nextIntInclusive(0, maxNumberOfDigits(SYNTHETIC_PHONE_VARIABLE_DIGITS)));
          value = !usedPhones.has(phoneNumberDigitsOf(drawn)) && plan.issueOf(drawn) === null ? drawn : null;
        }
        if (value === null) {
          return { kind: 'RETRY', report: report(fieldName, UNIQUE_EXHAUSTED) };
        }
        values[fieldName] = value;
        phoneNumbers.push(value);
        break;
      }
      case 'DERIVED_TOTAL':
      case undefined:
        break;
    }
  }
  // T29R-fix-1（M-2）: 合計の関係は、判定が求めた組（合計の欄の制約に合う単価と数量）から 1 つを選び、単価と数量の値にする。
  for (const relation of planned.evaluation.relations) {
    const totalPlan = relation.kind === 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY' ? planned.plans.get(relation.totalFieldName) : undefined;
    if (relation.kind === 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY' && totalPlan?.kind === 'DERIVED_TOTAL' && totalPlan.pairs.length > 0) {
      const [unitPrice, quantity] = streamOf({ relation: relation.totalFieldName }).pick(totalPlan.pairs);
      values[relation.unitPriceFieldName] = unitPrice;
      values[relation.quantityFieldName] = quantity;
    }
  }
  for (const relation of planned.evaluation.relations) {
    const outcome = applyRelation(relation, values, planned.plans);
    if (outcome !== null) {
      return outcome;
    }
  }
  return { kind: 'DONE', values, phoneNumbers };
};

/**
 * 送る値の一覧を作る（純粋。入力を変えない。凍結）。実行できない規則の集まりは、判定の問題を返す。seed の入力がシナリオと規則の集まりに合わないか、
 * 基準日の形が違えば `RangeError`。
 */
export const generateScenarioData = (input: ScenarioDataInput): ScenarioDataResult => {
  const { ruleSet, scenario, candidate, seedInput, baseDate } = input;
  if (seedInput.profileId !== scenario.profileId || seedInput.scenarioId !== scenario.scenarioId || seedInput.scenarioRevision !== scenario.revision
    || seedInput.ruleSetDigest !== computeRuleSetDigest(ruleSet)) {
    throw new RangeError('the seed input does not match the scenario and the rule set');
  }
  if (!isGenericBaseDate(baseDate)) {
    throw new RangeError('the base date must be a real YYYY-MM-DD date');
  }
  const planned = planRuleSet(ruleSet, scenario, candidate);
  if (!planned.evaluation.executable) {
    return failed(planned.evaluation.fields.flatMap((field) => (field.problem === null ? [] : [report(field.fieldName, field.problem)])));
  }
  const seed = createDataSeed(seedInput);
  const usedKeys = new Set(input.usedUniqueKeys);
  const usedPhones = new Set(input.usedPhoneNumbers.map(phoneNumberDigitsOf));
  const uniqueNames = planned.evaluation.uniqueKeyFieldNames;
  /** 送る値の欄の名前（判定の欄の名前の順。`DECIDED` の欄だけ）。 */
  const fieldNames = planned.evaluation.fields.filter((field) => planned.plans.has(field.fieldName)).map((field) => field.fieldName);
  let last: FieldProblemReport | null = null;
  for (let attempt = 0; attempt <= MAX_UNIQUE_RETRIES; attempt += 1) {
    const outcome = attemptOnce(attempt, seed, input, planned, usedPhones);
    if (outcome.kind === 'STOP') {
      return failed([outcome.report]);
    }
    if (outcome.kind === 'RETRY') {
      last = outcome.report;
      continue;
    }
    const uniqueKey = uniqueNames.length === 0 ? null : uniqueKeyOf(outcome.values, uniqueNames);
    if (uniqueKey !== null && usedKeys.has(uniqueKey)) {
      last = report(uniqueNames[0] ?? '', UNIQUE_EXHAUSTED);
      continue;
    }
    const values = Object.fromEntries(fieldNames.map((name) => [name, outcome.values[name] ?? null]));
    return deepFreeze({
      ok: true,
      values,
      uniqueKey,
      phoneNumbers: [...outcome.phoneNumbers],
      seedRecord: { seed, seedInput: { ...seedInput }, baseDate, attempt },
    });
  }
  return failed([last ?? report(uniqueNames[0] ?? '', UNIQUE_EXHAUSTED)]);
};
