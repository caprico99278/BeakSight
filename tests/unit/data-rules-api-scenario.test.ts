// T38e（Task 38 の設計書 3.6、7 章の履歴の T38b の報告の (1)・(3)）: 入力の規則を API のシナリオに当てる（`field-evaluation.ts` の
// `planRuleSet`・`evaluateRuleSet`、`scenario-data.ts` の `generateScenarioData`）。
// - API のシナリオでは、規則（`FieldRule`）を本文の鍵（`fieldNames`）で引く。値を入れる先の欄は `api.keyFields[].field`（`NAME` か `SELECTOR`）。
//   欄の型は、候補の probe の欄の範囲（`inputFields`）の型。欄の制約は probe に残らないので、ない（範囲は人の規則かテンプレートの既定）。
// - ページが決める鍵（`pageKeys`）には値を作らない。規則があれば `RULE_CONFLICT` の `PAGE_KEY_RULE_NOT_ALLOWED`（送る欄に選ばれていない行）。
// - 鍵の JSON の型と、規則が作る値の型が合わなければ `RULE_CONFLICT` の `JSON_VALUE_TYPE_MISMATCH`（number の鍵の固定の値と範囲の端が、
//   正規の数の形でない、欄の型と鍵の JSON の型の組が合わない）。string の鍵は、どの文字列の値も受ける。
// - 鍵と欄の対応が候補の probe の欄と合わない（候補が変わった）鍵は、FORM と同じ `FIELD_NOT_SENDABLE`。
// - FORM のシナリオは今のまま（`data-rules-*.test.ts` の回帰）。
import { describe, expect, it } from 'vitest';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { evaluateRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { jsonValueOf } from '../../src/control/data-rules/json-value.js';
import { RULE_CONFLICT_DETAILS, type FieldRelation, type FieldRule, type RuleProblem } from '../../src/control/data-rules/rule-contracts.js';
import { generateScenarioData, type ScenarioDataInput } from '../../src/control/data-rules/scenario-data.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { RULE_PROBLEM_DETAIL_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { BASE_DATE, ruleSetFor, seedInputFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const NEW_PATH = '/admin/members/new';

/** 押す前に入れた欄（氏名・メールアドレスは名前、点数は名前のない number の欄）。 */
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];

/** probe の型（本文と目印は引数）を持つ、form のない登録の画面の候補。 */
const apiCandidateOf = (
  inputFields: readonly SubmissionProbeInputField[],
  body: Readonly<Record<string, unknown>>,
  markers: readonly string[],
): DiscoveryCandidate => {
  const shape: ApiRequestShape = apiRequestShapeOf({
    method: 'POST',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members?select=*`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: { kind: 'TEXT', text: JSON.stringify(body) },
  }, { pagePath: NEW_PATH, markers });
  return {
    ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
    submissionProbe: observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
      { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields),
  };
};

const CANDIDATE = apiCandidateOf(INPUT_FIELDS, { name: MARKERS[0], email: MARKERS[1], score: Number(MARKERS[2]), tenant_id: 'tenant-1' }, MARKERS);

/** 下書きの確かめ（T38b）が作る API のシナリオの版。 */
const apiScenarioOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[]): ScenarioRevision => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: candidate.identityDigest,
    transport: 'API',
    fieldNames: [...fieldNames],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    api: {
      shapeDigest: candidate.submissionProbe?.shapeDigest,
      pageKeys: [...pageKeys],
      filterName: null,
      recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
      ledger: null,
    },
  }, candidate, [], {
    scenarioId: null,
    scenarios: [],
    approvedServiceOrigins: [API],
    // T38c: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と同じ。
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
};

const SCENARIO = apiScenarioOf(CANDIDATE, ['name', 'email', 'score'], ['tenant_id']);

/** 点数の規則（汎用の数。範囲は人が入れる。probe に欄の制約は残らない）。 */
const SCORE_RULE = sampleFieldRule('score', { range: { min: '1', max: '9', step: '1' } });

const CONFLICT = (detail: Extract<RuleProblem, { code: 'RULE_CONFLICT' }>['detail']): RuleProblem => ({ code: 'RULE_CONFLICT', detail });

const evaluationOf = (rules: readonly FieldRule[], scenario: ScenarioRevision = SCENARIO) => evaluateRuleSet(ruleSetFor(scenario, rules), scenario, CANDIDATE);

const fieldOf = (rules: readonly FieldRule[], fieldName: string, scenario: ScenarioRevision = SCENARIO) =>
  evaluationOf(rules, scenario).fields.find((field) => field.fieldName === fieldName);

const inputOf = (
  rules: readonly FieldRule[],
  scenario: ScenarioRevision = SCENARIO,
  candidate: DiscoveryCandidate = CANDIDATE,
  relations: readonly FieldRelation[] = [],
): ScenarioDataInput => {
  const ruleSet = ruleSetFor(scenario, rules, { relations: [...relations] });
  return {
    ruleSet,
    scenario,
    candidate,
    seedInput: seedInputFor(scenario, ruleSet),
    usedUniqueKeys: [],
    usedPhoneNumbers: [],
    baseDate: BASE_DATE,
  };
};

describe('T38e: the rules of an API scenario are looked up by the body key', () => {
  it('makes the sample an API scenario whose keys map to the probe fields (by name, or by CSS without a name)', () => {
    expect(SCENARIO.transport).toBe('API');
    expect(SCENARIO.request).toBeNull();
    expect(SCENARIO.fieldNames).toEqual(['email', 'name', 'score']);
    expect(SCENARIO.api?.keyFields.map(({ key, field }) => [key, field])).toEqual([
      ['email', { kind: 'NAME', name: 'email' }],
      ['name', { kind: 'NAME', name: 'name' }],
      ['score', { kind: 'SELECTOR', selector: '#score' }],
    ]);
    expect(SCENARIO.api?.pageKeys).toEqual([{ key: 'tenant_id', type: 'string' }]);
  });

  it('decides every key from the human rule of the key and the templates, and is executable', () => {
    const evaluation = evaluationOf([SCORE_RULE]);
    expect(evaluation.fields.map(({ fieldName, selected, status, source }) => [fieldName, selected, status, source])).toEqual([
      ['email', true, 'DECIDED', 'TEMPLATE'],
      ['name', true, 'DECIDED', 'TEMPLATE'],
      ['score', true, 'DECIDED', 'HUMAN'],
    ]);
    expect(evaluation.executable).toBe(true);
  });

  it('does not use a rule named after the field (the CSS) instead of the key, and the number key needs a range (no constraint in the probe)', () => {
    expect(fieldOf([{ ...SCORE_RULE, fieldName: '#score' }], 'score')).toMatchObject({
      status: 'NEEDS_RULE_INPUT', problem: { code: 'NEEDS_RULE_INPUT', detail: 'RANGE_MISSING' }, source: 'GENERIC',
    });
    expect(fieldOf([], 'score')?.problem).toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'RANGE_MISSING' });
  });

  it('keeps the rules of the email key behind the external notification confirmation (the key name and the field type)', () => {
    const scenario = { ...SCENARIO, sideEffectConfirmations: { ...ALL_CONFIRMED, NO_EXTERNAL_NOTIFICATION: false } };
    expect(fieldOf([SCORE_RULE], 'email', scenario)?.status).toBe('EXTERNAL_DELIVERY_BLOCKED');
  });

  it('generates the values by key, and each value converts to the JSON type of the key', () => {
    const result = generateScenarioData(inputOf([SCORE_RULE]));
    if (!result.ok) {
      throw new Error(JSON.stringify(result.problems));
    }
    expect(Object.keys(result.values)).toEqual(['email', 'name', 'score']);
    for (const { key, type } of SCENARIO.api?.keyFields ?? []) {
      expect(jsonValueOf(result.values[key] ?? null, type).ok).toBe(true);
    }
    expect(result.values['tenant_id']).toBeUndefined();
    expect(jsonValueOf(result.values['score'] ?? null, 'number')).toMatchObject({ ok: true });
  });

  it('throws RangeError for an API scenario without the API spec (a mistake of the caller)', () => {
    const { api: _api, ...withoutApi } = SCENARIO;
    expect(() => evaluationOf([SCORE_RULE], withoutApi)).toThrow(RangeError);
  });

  it('treats a key whose field no longer matches the probe fields (the candidate changed) as not sendable', () => {
    const api = SCENARIO.api;
    if (api === undefined) throw new Error('not an API scenario');
    const scenario: ScenarioRevision = {
      ...SCENARIO,
      api: { ...api, keyFields: api.keyFields.map((keyField) => (keyField.key === 'score'
        ? { ...keyField, field: { kind: 'SELECTOR', selector: '#other' } }
        : keyField)) },
    };
    expect(fieldOf([SCORE_RULE], 'score', scenario)?.problem).toEqual(CONFLICT('FIELD_NOT_SENDABLE'));
    const missing: ScenarioRevision = { ...SCENARIO, api: { ...api, keyFields: api.keyFields.filter(({ key }) => key !== 'score') } };
    expect(fieldOf([SCORE_RULE], 'score', missing)?.problem).toEqual(CONFLICT('FIELD_NOT_SENDABLE'));
  });
});

describe('T38e: the two reasons are in the closed list, with the description and the action', () => {
  it('lists PAGE_KEY_RULE_NOT_ALLOWED and JSON_VALUE_TYPE_MISMATCH under RULE_CONFLICT, and describes them', () => {
    expect(RULE_CONFLICT_DETAILS).toEqual(expect.arrayContaining(['PAGE_KEY_RULE_NOT_ALLOWED', 'JSON_VALUE_TYPE_MISMATCH']));
    for (const detail of ['PAGE_KEY_RULE_NOT_ALLOWED', 'JSON_VALUE_TYPE_MISMATCH'] as const) {
      expect(RULE_PROBLEM_DETAIL_DESCRIPTIONS[detail].description.length).toBeGreaterThan(0);
      expect(RULE_PROBLEM_DETAIL_DESCRIPTIONS[detail].action.length).toBeGreaterThan(0);
    }
  });
});

describe('T38e: the keys the page decides', () => {
  const TENANT_RULE = sampleFieldRule('tenant_id', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['t1'] });

  it('rejects a rule of a page key (the row is not selected), and the rule set is not executable', () => {
    const evaluation = evaluationOf([SCORE_RULE, TENANT_RULE]);
    expect(evaluation.fields.find((field) => field.fieldName === 'tenant_id')).toEqual({
      fieldName: 'tenant_id',
      selected: false,
      status: 'RULE_CONFLICT',
      problem: CONFLICT('PAGE_KEY_RULE_NOT_ALLOWED'),
      source: 'HUMAN',
      rule: TENANT_RULE,
      externalDeliveryKinds: [],
    });
    expect(evaluation.executable).toBe(false);
    expect(evaluation.fields.map(({ fieldName }) => fieldName)).toEqual(['email', 'name', 'score', 'tenant_id']);
  });

  it('makes no value for a page key, and the generation returns the problem', () => {
    expect(evaluationOf([SCORE_RULE]).fields.some((field) => field.fieldName === 'tenant_id')).toBe(false);
    const result = generateScenarioData(inputOf([SCORE_RULE, TENANT_RULE]));
    expect(result).toEqual({ ok: false, problems: [{ fieldName: 'tenant_id', problem: CONFLICT('PAGE_KEY_RULE_NOT_ALLOWED') }] });
  });
});

describe('T38e: the JSON type of the key and the type of the values of the rule', () => {
  const fixed = (fieldName: string, fixedValues: readonly string[]): FieldRule =>
    sampleFieldRule(fieldName, { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: [...fixedValues] });

  it.each([['01'], ['1e3'], ['-0'], ['2.50'], ['abc'], ['3', '04']])('rejects the fixed values %j of a number key', (...values) => {
    expect(fieldOf([fixed('score', values)], 'score')).toMatchObject({ status: 'RULE_CONFLICT', problem: CONFLICT('JSON_VALUE_TYPE_MISMATCH') });
  });

  it('accepts fixed values of a number key in the canonical form, and generates them', () => {
    expect(fieldOf([fixed('score', ['3', '12', '-25'])], 'score')?.status).toBe('DECIDED');
    // 欄の step（probe に残らないので HTML の既定の 1）に乗らない値は、今までどおり欄の制約の誤り。
    expect(fieldOf([fixed('score', ['2.5'])], 'score')?.problem).toEqual(CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'));
    const result = generateScenarioData(inputOf([fixed('score', ['12'])]));
    expect(result.ok && result.values['score']).toBe('12');
  });

  it.each([
    [{ min: '01', max: '9', step: '1' }],
    [{ min: '1', max: '9e1', step: '1' }],
    [{ min: '1', max: '9', step: '1.0' }],
    [{ min: '1', max: '1234567890123456', step: '1' }],
  ])('rejects the range %j of a number key that is not in the canonical form', (range) => {
    expect(fieldOf([{ ...SCORE_RULE, range }], 'score')).toMatchObject({ status: 'RULE_CONFLICT', problem: CONFLICT('JSON_VALUE_TYPE_MISMATCH') });
  });

  it('accepts any string value for a string key (the page sends the text of the field)', () => {
    expect(fieldOf([SCORE_RULE, fixed('name', ['01', '1e3', 'true'])], 'name')?.status).toBe('DECIDED');
  });

  it('rejects a key whose JSON type does not pair with the type of the field (number field and string, text field and number)', () => {
    const api = SCENARIO.api;
    if (api === undefined) throw new Error('not an API scenario');
    const retyped = (key: string, type: 'string' | 'number' | 'boolean'): ScenarioRevision => ({
      ...SCENARIO,
      api: { ...api, keyFields: api.keyFields.map((keyField) => (keyField.key === key ? { ...keyField, type } : keyField)) },
    });
    expect(fieldOf([SCORE_RULE], 'score', retyped('score', 'string'))?.problem).toEqual(CONFLICT('JSON_VALUE_TYPE_MISMATCH'));
    expect(fieldOf([SCORE_RULE], 'name', retyped('name', 'number'))?.problem).toEqual(CONFLICT('JSON_VALUE_TYPE_MISMATCH'));
    expect(fieldOf([SCORE_RULE], 'name', retyped('name', 'boolean'))?.problem).toEqual(CONFLICT('JSON_VALUE_TYPE_MISMATCH'));
  });
});

describe('T38e: the total of a number key (unit price × quantity) is in the canonical form', () => {
  const PRICE_MARKERS = ['111111111', '222222222', '333333333'];
  const PRICE_FIELDS: readonly SubmissionProbeInputField[] = [
    { name: 'unit_price', selector: '#unit-price', type: 'number', marker: 0 },
    { name: 'quantity', selector: '#quantity', type: 'number', marker: 1 },
    { name: 'total', selector: '#total', type: 'number', marker: 2 },
  ];
  const PRICE_CANDIDATE = apiCandidateOf(PRICE_FIELDS,
    { unit_price: Number(PRICE_MARKERS[0]), quantity: Number(PRICE_MARKERS[1]), total: Number(PRICE_MARKERS[2]) }, PRICE_MARKERS);
  const PRICE_SCENARIO = apiScenarioOf(PRICE_CANDIDATE, ['unit_price', 'quantity', 'total'], []);
  const TOTAL: FieldRelation = {
    kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY', unitPriceFieldName: 'unit_price', quantityFieldName: 'quantity', totalFieldName: 'total',
  };
  const rulesOf = (bound: string): readonly FieldRule[] => [
    sampleFieldRule('unit_price', { semanticKind: 'UNIT_PRICE', method: 'FROM_TEMPLATE', range: { min: bound, max: bound, step: '1' } }),
    sampleFieldRule('quantity', { semanticKind: 'QUANTITY', method: 'FROM_TEMPLATE', range: { min: bound, max: bound, step: '1' } }),
    sampleFieldRule('total', { semanticKind: 'TOTAL_PRICE', method: 'FROM_TEMPLATE' }),
  ];
  const totalOf = (bound: string) => {
    const input = inputOf(rulesOf(bound), PRICE_SCENARIO, PRICE_CANDIDATE, [TOTAL]);
    return {
      field: evaluateRuleSet(input.ruleSet, PRICE_SCENARIO, PRICE_CANDIDATE).fields.find((field) => field.fieldName === 'total'),
      result: generateScenarioData(input),
    };
  };

  it('generates the total when the product fits the number key', () => {
    const { field, result } = totalOf('12');
    expect(field?.status).toBe('DECIDED');
    expect(result.ok && result.values).toEqual({ quantity: '12', total: '144', unit_price: '12' });
  });

  it('rejects the total whose every product has more digits than the number key allows', () => {
    const { field, result } = totalOf('99999999');
    expect(field?.problem).toEqual(CONFLICT('JSON_VALUE_TYPE_MISMATCH'));
    expect(result).toEqual({ ok: false, problems: [{ fieldName: 'total', problem: CONFLICT('JSON_VALUE_TYPE_MISMATCH') }] });
  });
});

// DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: API のシナリオの公開の状態の鍵（`status`）は、ほかの欄と同じく入力の規則で利用者が
// 決める（状態の欄として使えなくしない）。ただし、論理削除の語の固定の値（`deleted` など）は拒む。FORM の状態の欄は今どおり使えない（`data-rules-*.test.ts`）。
describe('DEF-147: the publication state key of an API scenario is decided by the input rule', () => {
  const STATUS_FIELDS: readonly SubmissionProbeInputField[] = [...INPUT_FIELDS, { name: 'status', selector: '#status', type: 'text', marker: 3 }];
  const STATUS_MARKERS = [...MARKERS, 'bsprobe00000000000d'];
  const STATUS_CANDIDATE = apiCandidateOf(STATUS_FIELDS,
    { name: STATUS_MARKERS[0], email: STATUS_MARKERS[1], score: Number(STATUS_MARKERS[2]), status: STATUS_MARKERS[3], tenant_id: 'tenant-1' }, STATUS_MARKERS);
  const STATUS_SCENARIO = apiScenarioOf(STATUS_CANDIDATE, ['name', 'email', 'score', 'status'], ['tenant_id']);
  const statusRule = (values: readonly string[]): FieldRule =>
    sampleFieldRule('status', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: [...values] });
  const statusOf = (values: readonly string[]) =>
    evaluateRuleSet(ruleSetFor(STATUS_SCENARIO, [SCORE_RULE, statusRule(values)]), STATUS_SCENARIO, STATUS_CANDIDATE)
      .fields.find(({ fieldName }) => fieldName === 'status');

  it('decides the publication state key from the fixed list of the human rule', () => {
    expect(STATUS_CANDIDATE.submissionProbe?.result).toBe('API_CREATE');
    expect(statusOf(['draft'])).toMatchObject({ status: 'DECIDED', source: 'HUMAN', problem: null });
  });

  it('rejects a fixed value with a soft delete word for the publication state key', () => {
    expect(statusOf(['deleted'])?.problem).toEqual(CONFLICT('STATE_FIELD_NOT_USABLE'));
    expect(statusOf(['draft', 'archived'])?.problem).toEqual(CONFLICT('STATE_FIELD_NOT_USABLE'));
  });
});
