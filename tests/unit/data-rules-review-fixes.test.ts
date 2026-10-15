// T29R-fix-1（Task 29 の独立レビュー T29R の指摘の修正）: 欄の判定（`evaluateRuleSet`）と生成（`generateScenarioData`）の、指摘ごとの確かめ。
// - I-1: メールと電話の両方の語に当たる欄。人の固定の値は、欄の type が email なら合成のメールの形だけ、tel なら合成の電話の形だけ、ほかの type なら
//   どちらかの合成の形だけ。自動の生成は type で決め、type で決まらなければ `SEMANTIC_KIND_UNDECIDED`。
// - I-2: 一覧にない名前の通知・同意の欄（通知の語を足した。required でない checkbox は、人の固定の値がない限り送らない）。
// - M-1: 人の固定の値と人の範囲を、欄の step に照らす。生成も欄の step に合う値だけ。
// - M-2: 合計 = 単価 × 数量 が、合計の欄の制約の中で成り立つ組み合わせがなければ `RELATION_UNSATISFIABLE`。判定が `DECIDED` なら生成は止まらない。
// - M-8: 著名人と同じ姓名になりやすい組は、氏名の組に選ばない。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import { AVOIDED_PERSON_NAME_PAIRS } from '../../src/control/data-rules/dictionaries/dictionaries.js';
import { evaluateRuleSet, planRuleSet, type FieldEvaluation } from '../../src/control/data-rules/field-evaluation.js';
import type { FieldRule, RuleProblem } from '../../src/control/data-rules/rule-contracts.js';
import { generateScenarioData, type ScenarioDataInput } from '../../src/control/data-rules/scenario-data.js';
import type { CandidateField } from '../../src/discovery/candidate-contracts.js';
import { BASE_DATE, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { NO_CONSTRAINTS, sampleField } from './discovery-candidate-samples.js';

/** 多くの seed で確かめる数。 */
const SEED_COUNT = 200;
/** 合成の形（設計書の形。owner の正規表現とは別に書く）。 */
const SYNTHETIC_EMAIL = 'sample0000000001@example.invalid';
const SYNTHETIC_PHONE = '090-0123-4567';
const REAL_LOOKING_EMAIL = 'someone@example.com';
const EMAIL_SHAPE = /^[a-z0-9._-]+@example\.invalid$/u;
const PHONE_SHAPE = /^(?:090-0[0-9]{3}-[0-9]{4}|0900[0-9]{7})$/u;

const withConstraints = (field: CandidateField, constraints: Partial<CandidateField['constraints']>): CandidateField =>
  ({ ...field, constraints: { ...NO_CONSTRAINTS, ...constraints } });

const inputOf = (fields: readonly CandidateField[], rules: readonly FieldRule[] = [], grant = 'grant-1'): ScenarioDataInput => {
  const candidate = candidateWith(fields);
  const scenario = scenarioFor(candidate, fields.map((field) => field.name));
  const ruleSet = ruleSetFor(scenario, rules);
  return { ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet, grant), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE };
};

const evaluationOf = (fields: readonly CandidateField[], rules: readonly FieldRule[] = []) => {
  const { ruleSet, scenario, candidate } = inputOf(fields, rules);
  return evaluateRuleSet(ruleSet, scenario, candidate);
};

const fieldOf = (fields: readonly CandidateField[], name: string, rules: readonly FieldRule[] = []): FieldEvaluation => {
  const found = evaluationOf(fields, rules).fields.find((field) => field.fieldName === name);
  if (found === undefined) {
    throw new Error(`no evaluation for ${name}`);
  }
  return found;
};

const fixedRule = (fieldName: string, fixedValues: readonly string[], semanticKind: FieldRule['semanticKind'] = 'FIXED_LIST'): FieldRule =>
  sampleFieldRule(fieldName, { semanticKind, method: 'FROM_FIXED_LIST', fixedValues: [...fixedValues] });

const CONFLICT = (detail: string): RuleProblem => ({ code: 'RULE_CONFLICT', detail } as RuleProblem);
const NEEDS = (detail: string): RuleProblem => ({ code: 'NEEDS_RULE_INPUT', detail } as RuleProblem);

const seeds = (count: number): readonly string[] => Array.from({ length: count }, (_unused, index) => `grant-review-${String(index)}`);

const valuesOf = (input: ScenarioDataInput): Readonly<Record<string, string | null>> => {
  const result = generateScenarioData(input);
  if (!result.ok) {
    throw new Error(`not generated: ${JSON.stringify(result.problems)}`);
  }
  return result.values;
};

// ---------------------------------------------------------------------------------------------------------------
// I-1
// ---------------------------------------------------------------------------------------------------------------

/** メールと電話の両方の語に当たる欄（T29R の名前）。 */
const BOTH_EMAIL_TYPED: readonly CandidateField[] = [
  sampleField('携帯メール', 'email'),
  sampleField('mobile_email', 'email'),
  sampleField('tel_mail', 'email'),
];
const BOTH_TEL_TYPED = withConstraints(sampleField('contact', 'tel'), { autocomplete: 'email' });

describe('I-1: fields that hit both the email and the phone words', () => {
  it.each(BOTH_EMAIL_TYPED.map((field) => [field.name, field] as const))('%s (type email) accepts only the synthetic email shape as fixed values',
    (_name, field) => {
      for (const value of [REAL_LOOKING_EMAIL, SYNTHETIC_PHONE]) {
        expect(fieldOf([field], field.name, [fixedRule(field.name, [value])]).problem, value).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
      }
      expect(fieldOf([field], field.name, [fixedRule(field.name, [SYNTHETIC_EMAIL])])).toMatchObject({ status: 'DECIDED', source: 'HUMAN' });
      // 意味の種類を電話にしても、人の固定の値はメールの形だけ。
      expect(fieldOf([field], field.name, [fixedRule(field.name, [REAL_LOOKING_EMAIL], 'PHONE')]).status).not.toBe('DECIDED');
    });

  it.each(BOTH_EMAIL_TYPED.map((field) => [field.name, field] as const))('%s (type email) generates only the synthetic email shape', (_name, field) => {
    for (const grant of seeds(SEED_COUNT)) {
      expect(valuesOf(inputOf([field], [], grant))[field.name], grant).toMatch(EMAIL_SHAPE);
    }
  });

  it('a tel field with autocomplete email accepts only the synthetic phone shape and generates it', () => {
    for (const value of [REAL_LOOKING_EMAIL, SYNTHETIC_EMAIL]) {
      expect(fieldOf([BOTH_TEL_TYPED], 'contact', [fixedRule('contact', [value])]).problem, value).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    }
    expect(fieldOf([BOTH_TEL_TYPED], 'contact', [fixedRule('contact', [SYNTHETIC_PHONE])]).status).toBe('DECIDED');
    for (const grant of seeds(SEED_COUNT)) {
      expect(valuesOf(inputOf([BOTH_TEL_TYPED], [], grant))['contact'], grant).toMatch(PHONE_SHAPE);
    }
  });

  it('a text field that hits both is undecided without a human rule, and its fixed values must be one of the synthetic shapes', () => {
    const field = sampleField('tel_mail', 'text');
    expect(fieldOf([field], 'tel_mail').problem).toEqual(NEEDS('SEMANTIC_KIND_UNDECIDED'));
    expect(fieldOf([field], 'tel_mail', [fixedRule('tel_mail', [REAL_LOOKING_EMAIL])]).problem).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    expect(fieldOf([field], 'tel_mail', [fixedRule('tel_mail', ['03-0000-0000'])]).problem).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    expect(fieldOf([field], 'tel_mail', [fixedRule('tel_mail', [SYNTHETIC_EMAIL, SYNTHETIC_PHONE])]).status).toBe('DECIDED');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// I-2
// ---------------------------------------------------------------------------------------------------------------

/** 一覧になかった名前の通知・同意の checkbox（T29R の名前。required でない）。 */
const CONSENT_CHECKBOX_NAMES: readonly string[] = ['mailmagazine', 'marketing_consent', 'optin', 'promotion', 'ご案内を受け取る', '連絡を希望する',
  'contact_ok', 'allow_call'];

describe('I-2: notification and consent fields whose names were not listed', () => {
  it.each(CONSENT_CHECKBOX_NAMES)('%s (an optional checkbox) is not sent', (name) => {
    const field = sampleField(name, 'checkbox', { options: ['1'] });
    expect(fieldOf([field], name)).toMatchObject({ status: 'DECIDED', source: 'OPT_OUT' });
    for (const grant of seeds(SEED_COUNT)) {
      expect(valuesOf(inputOf([field], [], grant))[name], grant).toBeNull();
    }
  });

  it('a radio of campaign information picks the side that does not receive', () => {
    const field = sampleField('キャンペーン情報', 'radio', { options: ['受け取る', '受け取らない'] });
    expect(fieldOf([field], field.name).source).toBe('OPT_OUT');
    for (const grant of seeds(SEED_COUNT)) {
      expect(valuesOf(inputOf([field], [], grant))[field.name], grant).toBe('受け取らない');
    }
  });

  it('a required consent checkbox of a notification word still needs a human decision', () => {
    const field = sampleField('marketing_consent', 'checkbox', { options: ['1'], required: true });
    expect(fieldOf([field], field.name).problem).toEqual(CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'));
  });

  it('an optional checkbox is not sent unless a human fixed value is given, and a required one keeps the generic rule', () => {
    const optional = sampleField('agree', 'checkbox', { options: ['1'] });
    expect(fieldOf([optional], 'agree')).toMatchObject({ status: 'DECIDED', source: 'OPT_OUT' });
    expect(valuesOf(inputOf([optional]))['agree']).toBeNull();
    expect(fieldOf([optional], 'agree', [fixedRule('agree', ['1'])])).toMatchObject({ status: 'DECIDED', source: 'HUMAN' });
    expect(valuesOf(inputOf([optional], [fixedRule('agree', ['1'])]))['agree']).toBe('1');
    const required = sampleField('agree', 'checkbox', { options: ['1'], required: true });
    expect(fieldOf([required], 'agree')).toMatchObject({ status: 'DECIDED', source: 'GENERIC' });
    expect(valuesOf(inputOf([required]))['agree']).toBe('1');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M-1
// ---------------------------------------------------------------------------------------------------------------

describe('M-1: the step of the field', () => {
  const stepped = withConstraints(sampleField('level', 'number'), { min: '0', max: '100', step: '5' });
  const days = withConstraints(sampleField('visit', 'date'), { min: '2026-11-01', max: '2026-11-30', step: '7' });

  it('checks the human fixed values against the step', () => {
    expect(fieldOf([stepped], 'level', [fixedRule('level', ['7'])]).problem).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    expect(fieldOf([stepped], 'level', [fixedRule('level', ['10'])]).status).toBe('DECIDED');
    expect(fieldOf([days], 'visit', [fixedRule('visit', ['2026-11-02'])]).problem).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    expect(fieldOf([days], 'visit', [fixedRule('visit', ['2026-11-08'])]).status).toBe('DECIDED');
  });

  it('checks the human range against the step (the bounds and the step)', () => {
    const range = (min: string, max: string, step: string | null): FieldRule => sampleFieldRule('level', { range: { min, max, step } });
    expect(fieldOf([stepped], 'level', [range('3', '50', null)]).problem).toEqual(CONFLICT('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
    expect(fieldOf([stepped], 'level', [range('5', '50', '3')]).problem).toEqual(CONFLICT('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
    expect(fieldOf([stepped], 'level', [range('5', '50', '10')]).status).toBe('DECIDED');
    const dateRange = sampleFieldRule('visit', { semanticKind: 'GENERIC_DATETIME', range: { min: '2026-11-03', max: '2026-11-30', step: null } });
    expect(fieldOf([days], 'visit', [dateRange]).problem).toEqual(CONFLICT('RANGE_OUTSIDE_FIELD_CONSTRAINT'));
  });

  it('generates only values on the step of the field (a human range, and the template default range)', () => {
    const offset = withConstraints(sampleField('level', 'number'), { min: '1', max: '100', step: '5' });
    const price = withConstraints(sampleField('price', 'number'), { step: '30' });
    const priceStep = 30;
    const offsetStep = 5;
    for (const grant of seeds(SEED_COUNT)) {
      const level = Number(valuesOf(inputOf([offset], [sampleFieldRule('level', { range: { min: '6', max: '51', step: null } })], grant))['level']);
      expect((level - 1) % offsetStep, grant).toBe(0);
      expect(Number(valuesOf(inputOf([price], [], grant))['price']) % priceStep, grant).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M-2
// ---------------------------------------------------------------------------------------------------------------

describe('M-2: the total relation in the judgement and the generation', () => {
  const productFields = (total: Partial<CandidateField['constraints']>): readonly CandidateField[] => [
    withConstraints(sampleField('price', 'number'), { min: '100', max: '900', step: '100' }),
    withConstraints(sampleField('quantity', 'number'), { min: '1', max: '3' }),
    withConstraints(sampleField('total', 'number'), total),
  ];

  it('stops when no combination fits the total field', () => {
    expect(fieldOf(productFields({ min: '5000', max: '6000' }), 'total').problem).toEqual(CONFLICT('RELATION_UNSATISFIABLE'));
    expect(fieldOf(productFields({ min: '1000', max: '1200' }), 'total').status).toBe('DECIDED');
  });

  it('never stops the generation when the judgement is DECIDED (a narrow total, over many seeds)', () => {
    // 27 の組み合わせのうち、2700 になるのは 900 × 3 の 1 つだけ。
    const narrow = productFields({ min: '2700', max: '2700' });
    expect(planRuleSet(inputOf(narrow).ruleSet, inputOf(narrow).scenario, inputOf(narrow).candidate).evaluation.executable).toBe(true);
    for (const grant of seeds(SEED_COUNT)) {
      const values = valuesOf(inputOf(narrow, [], grant));
      expect([values['price'], values['quantity'], values['total']], grant).toEqual(['900', '3', '2700']);
    }
  });

  it('never stops the generation when the judgement is DECIDED (several total fields)', () => {
    const totals: readonly Partial<CandidateField['constraints']>[] = [
      { min: '100', max: '300', step: '100' }, { min: '1000', max: '1200' }, { max: '400' }, { min: '2000', step: '500' }, { min: '1500', max: '1600' },
    ];
    for (const total of totals) {
      const fields = productFields(total);
      const executable = evaluationOf(fields).executable;
      for (const grant of seeds(SEED_COUNT)) {
        const result = generateScenarioData(inputOf(fields, [], grant));
        expect(result.ok, `${JSON.stringify(total)} ${grant}`).toBe(executable);
        if (result.ok) {
          expect(Number(result.values['total'])).toBe(Number(result.values['price']) * Number(result.values['quantity']));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M-8
// ---------------------------------------------------------------------------------------------------------------

describe('M-8: avoided person name pairs', () => {
  it('never generates an avoided pair', () => {
    const fields = [sampleField('sei'), sampleField('mei')];
    const avoided = new Set(AVOIDED_PERSON_NAME_PAIRS.map(({ family, given }) => `${family}/${given}`));
    const { persons } = planRuleSet(inputOf(fields).ruleSet, inputOf(fields).scenario, inputOf(fields).candidate);
    expect(persons.length).toBeGreaterThan(0);
    expect(persons.filter(({ family, given }) => avoided.has(`${family.name}/${given.name}`))).toEqual([]);
    for (const grant of seeds(SEED_COUNT)) {
      const values = valuesOf(inputOf(fields, [], grant));
      expect(avoided.has(`${String(values['sei'])}/${String(values['mei'])}`), grant).toBe(false);
    }
  });
});
