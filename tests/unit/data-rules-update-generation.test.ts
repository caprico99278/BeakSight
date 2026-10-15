// T31d（Task 31 の設計書 3 章の「変える欄の値」「保つ欄の期待の値」、4 章の「生成」）: UPDATE のシナリオの欄の判定（`field-evaluation.ts` の
// `evaluateRuleSet`）と生成（`scenario-data.ts` の `generateScenarioData`）。
// - 値を作るのは変える欄（`fieldNames`）だけ。保つ欄（UPDATE の指定の `keepFieldNames`）には値を作らず、規則も要らない（規則があっても使わない）。
// - Task 29 の「required の欄はすべて送る欄」は、UPDATE では「変える欄か保つ欄」で満たす。
// - 変える欄の値は、履歴（一意にする欄の組、電話番号）と重ならない。UPDATE で一意にする欄の組が決まらないときは、変える欄の組で重なりを避ける。
// - メールと電話を変える欄にしたときは、Task 29 の決まり（`NO_EXTERNAL_NOTIFICATION` の確認、合成の形だけ）がそのまま効く。
// - 状態の欄と無効化の語の選択肢は、変える欄で選ばない（T31a・T31b のとおり）。
// - CREATE の判定と生成は変えない。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { evaluateRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { syntheticPhoneFormatOf } from '../../src/control/data-rules/rule-contracts.js';
import { generateScenarioData, type ScenarioDataInput } from '../../src/control/data-rules/scenario-data.js';
import type { CandidateField, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { ALL_CONFIRMED, UPDATE_SPEC, candidateOf, sampleScenario } from './approval-samples.js';
import { BASE_DATE, NOTIFICATION_UNCONFIRMED, ruleSetFor, seedInputFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

/** 多くの seed で確かめる回数（名前つきの回数）。 */
const SAMPLE_RUNS = 100;

const EDIT_FIELDS: readonly CandidateField[] = [
  sampleField('name', 'text', { required: true }),
  sampleField('email', 'email', { required: true }),
  sampleField('tel', 'tel'),
  sampleField('note', 'textarea'),
  sampleField('status', 'select-one', { required: true, options: ['active', 'inactive'] }),
  sampleField('plan', 'select-one', { options: ['basic', 'inactive', 'hidden'] }),
  sampleField('_method', 'hidden', { hasValue: true }),
];

const EDIT: DiscoveryCandidate = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' },
  action: sampleAction('/members/1'),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: EDIT_FIELDS,
}));

/** 見えていて編集できる欄（name・email・tel・note・status・plan）のうち、変える欄と保つ欄（残り）。 */
const VISIBLE_EDITABLE = ['email', 'name', 'note', 'plan', 'status', 'tel'];

const updateScenario = (fieldNames: readonly string[], overrides: Partial<ScenarioRevision> = {}): ScenarioRevision => sampleScenario({
  kind: 'UPDATE',
  candidate: { identityDigest: EDIT.identityDigest, ruleDigest: EDIT.ruleDigest },
  fieldNames: [...fieldNames].sort(),
  update: { ...UPDATE_SPEC, keepFieldNames: VISIBLE_EDITABLE.filter((name) => !fieldNames.includes(name)) },
  ...overrides,
});

const inputFor = (scenario: ScenarioRevision, grant: string, usedUniqueKeys: readonly string[] = [], usedPhoneNumbers: readonly string[] = [],
  rules: Parameters<typeof ruleSetFor>[1] = []): ScenarioDataInput => {
  const ruleSet = ruleSetFor(scenario, rules);
  return {
    ruleSet,
    scenario,
    candidate: EDIT,
    seedInput: seedInputFor(scenario, ruleSet, grant),
    usedUniqueKeys,
    usedPhoneNumbers,
    baseDate: BASE_DATE,
  };
};

const grantOf = (index: number): string => `grant-${index}`;

describe('T31d: field judgement of an UPDATE scenario', () => {
  it('decides only the fields to change, and the required fields to keep do not need a rule', () => {
    const scenario = updateScenario(['name']);
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, EDIT);
    expect(evaluation.fields.map(({ fieldName, status }) => [fieldName, status])).toEqual([['name', 'DECIDED']]);
    expect(evaluation.executable).toBe(true);
  });

  it('does not use a rule of a field to keep', () => {
    const scenario = updateScenario(['name']);
    const rules = [sampleFieldRule('note', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['試験の備考'] })];
    const evaluation = evaluateRuleSet(ruleSetFor(scenario, rules), scenario, EDIT);
    expect(evaluation.fields.map(({ fieldName }) => fieldName)).toEqual(['name']);
    const generated = generateScenarioData(inputFor(scenario, grantOf(0), [], [], rules));
    expect(generated.ok && Object.keys(generated.values)).toEqual(['name']);
  });

  it('keeps the judgement of a CREATE scenario: a required field that is not sent needs a rule', () => {
    const scenario = updateScenario(['name'], { kind: 'CREATE', update: null });
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, EDIT);
    expect(evaluation.fields.filter(({ status }) => status !== 'DECIDED').map(({ fieldName, problem }) => [fieldName, problem?.detail]))
      .toEqual([['email', 'REQUIRED_FIELD_NOT_SELECTED'], ['status', 'REQUIRED_FIELD_NOT_SELECTED']]);
    expect(evaluation.executable).toBe(false);
  });

  it('never uses a state field as a field to change', () => {
    const scenario = updateScenario(['name', 'status']);
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, EDIT);
    expect(evaluation.fields.find(({ fieldName }) => fieldName === 'status')?.problem).toEqual({ code: 'RULE_CONFLICT', detail: 'STATE_FIELD_NOT_USABLE' });
  });
});

describe('T31d: values of an UPDATE scenario', () => {
  it('makes values only for the fields to change, never for the fields to keep, over many seeds', () => {
    const scenario = updateScenario(['name', 'plan']);
    for (let index = 0; index < SAMPLE_RUNS; index += 1) {
      const generated = generateScenarioData(inputFor(scenario, grantOf(index)));
      expect(generated.ok).toBe(true);
      if (generated.ok) {
        expect(Object.keys(generated.values).sort()).toEqual(['name', 'plan']);
        // 無効化の語の選択肢（inactive、hidden）は選ばない。
        expect(generated.values.plan).toBe('basic');
      }
    }
  });

  it('never makes a combination that is in the history (the unique key of the template), over many seeds', () => {
    const scenario = updateScenario(['name']);
    const used: string[] = [];
    for (let index = 0; index < SAMPLE_RUNS; index += 1) {
      const generated = generateScenarioData(inputFor(scenario, grantOf(index), used));
      expect(generated.ok).toBe(true);
      if (generated.ok && generated.uniqueKey !== null) {
        expect(used).not.toContain(generated.uniqueKey);
        used.push(generated.uniqueKey);
      }
    }
    expect(used).toHaveLength(SAMPLE_RUNS);
  });

  it('uses the fields to change as the unique key of an UPDATE when the rules and the templates give none (CREATE keeps none)', () => {
    const update = updateScenario(['note']);
    expect(evaluateRuleSet(ruleSetFor(update), update, EDIT).uniqueKeyFieldNames).toEqual(['note']);
    const create = updateScenario(['email', 'note', 'status'], { kind: 'CREATE', update: null });
    expect(evaluateRuleSet(ruleSetFor(create), create, EDIT).uniqueKeyFieldNames).toEqual([]);
    const used: string[] = [];
    for (let index = 0; index < SAMPLE_RUNS; index += 1) {
      const generated = generateScenarioData(inputFor(update, grantOf(index), used));
      if (generated.ok && generated.uniqueKey !== null) {
        expect(used).not.toContain(generated.uniqueKey);
        used.push(generated.uniqueKey);
      }
    }
    expect(used.length).toBeGreaterThan(0);
  });

  it('makes a synthetic email and phone only for the fields to change, and only with NO_EXTERNAL_NOTIFICATION', () => {
    const scenario = updateScenario(['email', 'name', 'tel']);
    const usedPhones: string[] = [];
    for (let index = 0; index < SAMPLE_RUNS; index += 1) {
      const generated = generateScenarioData(inputFor(scenario, grantOf(index), [], usedPhones));
      expect(generated.ok).toBe(true);
      if (generated.ok) {
        expect(generated.values.email?.endsWith('@example.invalid')).toBe(true);
        expect(syntheticPhoneFormatOf(generated.values.tel ?? '')).not.toBeNull();
        for (const phone of generated.phoneNumbers) {
          expect(usedPhones).not.toContain(phone);
        }
        usedPhones.push(...generated.phoneNumbers);
      }
    }
    const blocked = generateScenarioData(inputFor(updateScenario(['email', 'name', 'tel'], { sideEffectConfirmations: NOTIFICATION_UNCONFIRMED }), grantOf(0)));
    expect(blocked.ok ? [] : blocked.problems.map(({ fieldName, problem }) => [fieldName, problem.code]))
      .toEqual([['email', 'EXTERNAL_DELIVERY_BLOCKED'], ['tel', 'EXTERNAL_DELIVERY_BLOCKED']]);
    // メールと電話を保つ欄にしたときは、確認がなくても値を作らない（作る値がない）。
    const kept = generateScenarioData(inputFor(updateScenario(['name'], { sideEffectConfirmations: NOTIFICATION_UNCONFIRMED }), grantOf(0)));
    expect(kept.ok && Object.keys(kept.values)).toEqual(['name']);
    expect(ALL_CONFIRMED.NO_EXTERNAL_NOTIFICATION).toBe(true);
  });
});
