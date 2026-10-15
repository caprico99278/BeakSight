// T29c（Task 29 の設計書 3 章の決定的な生成と一意性、4.2、6 章）: 送る値の生成（`src/control/data-rules/scenario-data.ts` の
// `generateScenarioData`）の検査。
// - 同じ入力で同じ値、seed の各要素の変化で別の値。関係（終了 > 開始、合計 = 単価 × 数量、フリガナは氏名と同じ人）。
// - メールは `example.invalid` だけ。電話は 2 つの形だけで、使った番号と重ならない。欄の制約（maxlength、pattern）に合う。
// - 一意にする欄の組の作り直しと上限。人の固定の一覧の優先。値の範囲の両端（多くの seed）。
// - 生成した値が、危険な語・秘密に見える語・外部到達の語（メールと電話の欄のほか）に当たらない。
import { describe, expect, it } from 'vitest';
import { FAMILY_NAMES, GIVEN_NAMES } from '../../src/control/data-rules/dictionaries/dictionaries.js';
import { EXTERNAL_DELIVERY_NAME_WORDS, externalDeliveryKindsOfName } from '../../src/control/data-rules/external-delivery-words.js';
import { generateScenarioData, uniqueKeyOf, type ScenarioDataInput } from '../../src/control/data-rules/scenario-data.js';
import { isSyntheticEmailAddress, syntheticPhoneFormatOf, type FieldRule } from '../../src/control/data-rules/rule-contracts.js';
import { isSecretLikeQueryName } from '../../src/core/secret-query-names.js';
import { foldNfkcCase } from '../../src/core/text.js';
import type { CandidateField } from '../../src/discovery/candidate-contracts.js';
import { readParametersHaveDestructiveWord } from '../../src/discovery/classify.js';
import { BASE_DATE, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { NO_CONSTRAINTS, sampleField } from './discovery-candidate-samples.js';

const withConstraints = (field: CandidateField, constraints: Partial<CandidateField['constraints']>): CandidateField =>
  ({ ...field, constraints: { ...NO_CONSTRAINTS, ...constraints } });

/** 多くの seed で確かめる回数（名前つきの回数）。 */
const SAMPLE_RUNS = 200;

const CUSTOMER_FIELDS: readonly CandidateField[] = [
  sampleField('name', 'text', { required: true }),
  sampleField('name_kana'),
  sampleField('sei'),
  sampleField('sei_kana'),
  sampleField('email', 'email'),
  sampleField('tel', 'tel'),
  sampleField('note', 'textarea'),
  sampleField('notify', 'checkbox', { options: ['1'] }),
];

const RESERVATION_FIELDS: readonly CandidateField[] = [
  withConstraints(sampleField('reservation_date', 'date'), { min: '2026-11-01', max: '2026-11-30' }),
  withConstraints(sampleField('start_time', 'time'), { min: '09:00', max: '18:00', step: '1800' }),
  withConstraints(sampleField('end_time', 'time'), { min: '09:00', max: '18:00', step: '1800' }),
  sampleField('guests', 'number'),
  sampleField('course', 'select-one', { options: ['', 'a', 'b', 'delete'] }),
];

const PRODUCT_FIELDS: readonly CandidateField[] = [
  sampleField('product_name'),
  sampleField('price', 'number'),
  sampleField('quantity', 'number'),
  sampleField('total', 'number'),
];

const inputFor = (
  fields: readonly CandidateField[],
  options: { readonly rules?: readonly FieldRule[]; readonly grant?: string; readonly usedUniqueKeys?: readonly string[];
    readonly usedPhoneNumbers?: readonly string[]; readonly uniqueKeyFieldNames?: readonly string[] } = {},
): ScenarioDataInput => {
  const candidate = candidateWith(fields);
  const scenario = scenarioFor(candidate, fields.map((field) => field.name));
  const ruleSet = ruleSetFor(scenario, options.rules ?? [], { uniqueKeyFieldNames: [...(options.uniqueKeyFieldNames ?? [])] });
  return {
    ruleSet,
    scenario,
    candidate,
    seedInput: seedInputFor(scenario, ruleSet, options.grant),
    usedUniqueKeys: options.usedUniqueKeys ?? [],
    usedPhoneNumbers: options.usedPhoneNumbers ?? [],
    baseDate: BASE_DATE,
  };
};

const valuesOf = (input: ScenarioDataInput): Readonly<Record<string, string | null>> => {
  const result = generateScenarioData(input);
  if (!result.ok) {
    throw new Error(`not generated: ${JSON.stringify(result.problems)}`);
  }
  return result.values;
};

const valueOf = (values: Readonly<Record<string, string | null>>, name: string): string => {
  const value = values[name];
  if (typeof value !== 'string') {
    throw new Error(`no value for ${name}`);
  }
  return value;
};

describe('generateScenarioData: determinism (T29c)', () => {
  it('gives the same values for the same input, and different values for another grant', () => {
    expect(valuesOf(inputFor(CUSTOMER_FIELDS))).toEqual(valuesOf(inputFor(CUSTOMER_FIELDS)));
    const others = Array.from({ length: 5 }, (_unused, index) => JSON.stringify(valuesOf(inputFor(CUSTOMER_FIELDS, { grant: `grant-${index + 2}` }))));
    expect(others.filter((values) => values === JSON.stringify(valuesOf(inputFor(CUSTOMER_FIELDS))))).toEqual([]);
  });

  it('changes with each element of the seed', () => {
    const base = inputFor(CUSTOMER_FIELDS);
    const baseValues = JSON.stringify(valuesOf(base));
    const profile = { ...base, scenario: { ...base.scenario, profileId: 'other-profile' }, seedInput: { ...base.seedInput, profileId: 'other-profile' } };
    const revision = { ...base, scenario: { ...base.scenario, revision: 4 }, seedInput: { ...base.seedInput, scenarioRevision: 4 } };
    const scenarioId = {
      ...base,
      scenario: { ...base.scenario, scenarioId: 'scenario-9' },
      ruleSet: { ...base.ruleSet, scenarioId: 'scenario-9' },
    };
    const scenarioIdInput = { ...scenarioId, seedInput: seedInputFor(scenarioId.scenario, scenarioId.ruleSet) };
    const ruleSet = { ...base, ruleSet: { ...base.ruleSet, ruleSetId: 'rules-2' } };
    const ruleSetInput = { ...ruleSet, seedInput: seedInputFor(ruleSet.scenario, ruleSet.ruleSet) };
    for (const changed of [profile, revision, scenarioIdInput, ruleSetInput]) {
      expect(JSON.stringify(valuesOf(changed))).not.toBe(baseValues);
    }
  });

  it('rejects a seed input that does not match the scenario, the rule set or a bad base date (caller errors)', () => {
    const base = inputFor(CUSTOMER_FIELDS);
    expect(() => generateScenarioData({ ...base, seedInput: { ...base.seedInput, scenarioRevision: 9 } })).toThrow(RangeError);
    expect(() => generateScenarioData({ ...base, seedInput: { ...base.seedInput, profileId: 'x-profile' } })).toThrow(RangeError);
    expect(() => generateScenarioData({ ...base, seedInput: { ...base.seedInput, ruleSetDigest: `sha256:${'0'.repeat(64)}` } })).toThrow(RangeError);
    expect(() => generateScenarioData({ ...base, baseDate: '2026-02-30' })).toThrow(RangeError);
  });

  it('records the seed, the base date and the attempt, and returns frozen values', () => {
    const result = generateScenarioData(inputFor(CUSTOMER_FIELDS));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seedRecord.baseDate).toBe(BASE_DATE);
      expect(result.seedRecord.seed).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.seedRecord.attempt).toBe(0);
      expect(result.seedRecord.seedInput).toEqual(inputFor(CUSTOMER_FIELDS).seedInput);
      expect(Object.isFrozen(result) && Object.isFrozen(result.values) && Object.isFrozen(result.seedRecord)).toBe(true);
    }
  });
});

describe('generateScenarioData: customer (T29c)', () => {
  it('makes one person for the names and kana, a synthetic email, a synthetic phone and opts out of notifications', () => {
    for (let run = 0; run < SAMPLE_RUNS; run += 1) {
      const values = valuesOf(inputFor(CUSTOMER_FIELDS, { grant: `grant-${run}` }));
      const family = FAMILY_NAMES.find((entry) => entry.name === valueOf(values, 'sei'));
      expect(family).toBeDefined();
      expect(valueOf(values, 'sei_kana')).toBe(family?.kana);
      const given = GIVEN_NAMES.find((entry) => `${family?.name}${entry.name}` === valueOf(values, 'name'));
      expect(given, valueOf(values, 'name')).toBeDefined();
      expect(valueOf(values, 'name_kana')).toBe(`${family?.kana}${given?.kana}`);
      expect(isSyntheticEmailAddress(valueOf(values, 'email'))).toBe(true);
      expect(valueOf(values, 'email').endsWith('@example.invalid')).toBe(true);
      expect(syntheticPhoneFormatOf(valueOf(values, 'tel'))).toBe('HYPHENATED');
      expect(values.notify).toBeNull();
    }
  });

  it('uses the compact phone form when the field does not allow hyphens, and avoids used numbers', () => {
    const fields = [withConstraints(sampleField('tel', 'tel'), { maxlength: '11' })];
    const first = valueOf(valuesOf(inputFor(fields)), 'tel');
    expect(syntheticPhoneFormatOf(first)).toBe('COMPACT');
    const hyphenated = `090-0${first.slice(4, 7)}-${first.slice(7)}`;
    const second = valueOf(valuesOf(inputFor(fields, { usedPhoneNumbers: [hyphenated] })), 'tel');
    expect(second).not.toBe(first);
    expect(syntheticPhoneFormatOf(second)).toBe('COMPACT');
  });

  it('fits the names to maxlength and a katakana pattern', () => {
    const fields = [withConstraints(sampleField('name'), { maxlength: '4' }), withConstraints(sampleField('name_kana'), { pattern: '[ァ-ヶー]+' })];
    for (let run = 0; run < SAMPLE_RUNS; run += 1) {
      const values = valuesOf(inputFor(fields, { grant: `grant-${run}` }));
      expect(valueOf(values, 'name').length).toBeLessThanOrEqual(4);
      expect(valueOf(values, 'name_kana')).toMatch(/^[ァ-ヶー]+$/u);
    }
  });

  it('prefers the human fixed list', () => {
    const rules = [sampleFieldRule('name', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['試験一郎', '試験二郎'] })];
    for (let run = 0; run < 20; run += 1) {
      expect(['試験一郎', '試験二郎']).toContain(valueOf(valuesOf(inputFor([sampleField('name')], { rules, grant: `grant-${run}` })), 'name'));
    }
  });
});

describe('generateScenarioData: reservation and product (T29c)', () => {
  it('keeps the end after the start, the date in the field range and only usable choices, and reaches both ends of the counts', () => {
    const guests = new Set<string>();
    for (let run = 0; run < SAMPLE_RUNS; run += 1) {
      const values = valuesOf(inputFor(RESERVATION_FIELDS, { grant: `grant-${run}` }));
      expect(valueOf(values, 'end_time') > valueOf(values, 'start_time')).toBe(true);
      expect(valueOf(values, 'reservation_date') >= '2026-11-01' && valueOf(values, 'reservation_date') <= '2026-11-30').toBe(true);
      expect(['a', 'b']).toContain(valueOf(values, 'course'));
      guests.add(valueOf(values, 'guests'));
    }
    expect([...guests].sort()).toEqual(['1', '2', '3', '4']);
  });

  it('makes the total the unit price times the quantity, with a product name of the dictionary', () => {
    const quantities = new Set<string>();
    for (let run = 0; run < SAMPLE_RUNS; run += 1) {
      const values = valuesOf(inputFor(PRODUCT_FIELDS, { grant: `grant-${run}` }));
      expect(Number(valueOf(values, 'total'))).toBe(Number(valueOf(values, 'price')) * Number(valueOf(values, 'quantity')));
      expect(valueOf(values, 'product_name').length).toBeGreaterThan(0);
      quantities.add(valueOf(values, 'quantity'));
    }
    expect([...quantities].sort()).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('generateScenarioData: uniqueness (T29c)', () => {
  it('makes the values again when the unique key was used, and returns the unique key', () => {
    const first = generateScenarioData(inputFor(CUSTOMER_FIELDS));
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.uniqueKey).toBe(uniqueKeyOf(first.values, ['name', 'name_kana', 'sei', 'sei_kana']));
    const second = generateScenarioData(inputFor(CUSTOMER_FIELDS, { usedUniqueKeys: [first.uniqueKey ?? ''] }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.uniqueKey).not.toBe(first.uniqueKey);
      expect(second.seedRecord.attempt).toBeGreaterThan(0);
    }
  });

  it('stops with UNIQUE_COMBINATIONS_EXHAUSTED when every combination is used', () => {
    const fields = [sampleField('course', 'select-one', { options: ['a'] })];
    const used = uniqueKeyOf({ course: 'a' }, ['course']);
    const result = generateScenarioData(inputFor(fields, { usedUniqueKeys: [used], uniqueKeyFieldNames: ['course'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([{ fieldName: 'course', problem: { code: 'RULE_CONFLICT', detail: 'UNIQUE_COMBINATIONS_EXHAUSTED' } }]);
    }
  });

  it('returns the problems of the evaluation without generating', () => {
    const result = generateScenarioData(inputFor([sampleField('code_x')]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([{ fieldName: 'code_x', problem: { code: 'NEEDS_RULE_INPUT', detail: 'SEMANTIC_KIND_UNDECIDED' } }]);
    }
  });
});

describe('generateScenarioData: generated values do not hit words (T29c)', () => {
  const EXTERNAL_WORDS = Object.values(EXTERNAL_DELIVERY_NAME_WORDS).flat();

  it('makes no dangerous, secret-looking or external delivery words (except in email and phone fields)', () => {
    for (let run = 0; run < SAMPLE_RUNS; run += 1) {
      for (const fields of [CUSTOMER_FIELDS, RESERVATION_FIELDS, PRODUCT_FIELDS]) {
        const values = valuesOf(inputFor(fields, { grant: `grant-${run}` }));
        for (const [name, value] of Object.entries(values)) {
          if (value === null || name === 'email' || name === 'tel') {
            continue;
          }
          const label = `${name}=${value}`;
          expect(readParametersHaveDestructiveWord({ '': value }), label).toBe(false);
          expect(isSecretLikeQueryName(value), label).toBe(false);
          expect(externalDeliveryKindsOfName(value), label).toEqual([]);
          expect(EXTERNAL_WORDS.filter((word) => foldNfkcCase(value).includes(word)), label).toEqual([]);
        }
      }
    }
  });
});
