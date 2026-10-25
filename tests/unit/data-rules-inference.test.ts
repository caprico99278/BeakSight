// FM2c（手動の操作を減らす設計書 3A.3）: 入力の規則の自動の作成（`src/control/data-rules/rule-set-inference.ts` の `inferRuleSetContent`）と、
// 手がかりの追加（範囲のない日付と数の既定の幅、「番号・コード」の意味の種類、API の鍵の制約を form の候補から補う）。
// - 推した規則（業務テンプレート・汎用の規則）を、出どころの印 `INFERRED` つきの保存できる規則にする。推せない欄は、理由のコードつきの一覧で返す。
// - 範囲の手がかり（欄の min・max・step）がない日付・日時は基準日から 30 日後まで、数は 1〜100 の整数（`src/core/limits.ts` の名前つきの定数）。
//   欄に min・max があるときは、今どおりその範囲を使う。
// - 数字だけの固定の桁数の pattern（`^\d{7}$`、`[0-9]{4}`）の text の欄は「番号・コード」（`DIGIT_CODE`）。名前の語に当たらなくても推せる。
// - API の鍵は、probe の欄の name で同じ form の候補の欄と結び、制約と選択肢を使う。form の外のボタンの候補は、今どおり制約なし。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { evaluateRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { inferSemanticKind } from '../../src/control/data-rules/business-templates.js';
import {
  RULE_SET_SCHEMA_VERSION,
  type FieldRule,
  type RuleSetContent,
  type RuleSetRevision,
} from '../../src/control/data-rules/rule-contracts.js';
import { defaultRangeFieldNamesOf, inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { assertStorableRuleSet, ruleSetRevisionOfStoredDocument } from '../../src/control/data-rules/rule-set-policy.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import { varyingFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import { planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { DEFAULT_UNRANGED_DATE_WINDOW_DAYS, DEFAULT_UNRANGED_INTEGER_RANGE } from '../../src/core/limits.js';
import type { CandidateField, DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { BASE_DATE, NOTIFICATION_UNCONFIRMED, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { NO_CONSTRAINTS, NO_JS_BINDING, SAMPLE_ORIGIN, sampleAction, sampleButton, sampleField, sampleForm } from './discovery-candidate-samples.js';

const withConstraints = (field: CandidateField, constraints: Partial<CandidateField['constraints']>): CandidateField =>
  ({ ...field, constraints: { ...NO_CONSTRAINTS, ...constraints } });

/** 保存した版の形（推した規則だけを、規則の集まりの版にする）。 */
const savedOf = (scenario: ScenarioRevision, fieldRules: readonly FieldRule[]): RuleSetRevision => ruleSetFor(scenario, fieldRules);

/** 保存した版の形（推した中身のすべて。関係・一意にする欄の組・印を含む）。 */
const savedContentOf = (scenario: ScenarioRevision, content: RuleSetContent): RuleSetRevision => ruleSetFor(scenario, content.fieldRules, {
  relations: [...content.relations],
  uniqueKeyFieldNames: [...content.uniqueKeyFieldNames],
  ...(content.uniqueKeyOrigin === undefined ? {} : { uniqueKeyOrigin: content.uniqueKeyOrigin }),
  ...(content.templateDefaultsSaved === undefined ? {} : { templateDefaultsSaved: content.templateDefaultsSaved }),
});

/** 基準日から `days` 日後の日付。 */
const dayAfter = (base: string, days: number): string => new Date(Date.parse(`${base}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const FORM_FIELDS: readonly CandidateField[] = [
  sampleField('name'),
  sampleField('email', 'email'),
  sampleField('score_x', 'number'),
  sampleField('visit_x', 'date'),
  sampleField('arrival', 'datetime-local'),
  withConstraints(sampleField('limited_x', 'date'), { min: '2026-11-01', max: '2026-11-10' }),
  withConstraints(sampleField('half_range', 'number'), { min: '5' }),
  withConstraints(sampleField('stepped', 'number'), { step: '5' }),
  withConstraints(sampleField('member_x', 'text'), { pattern: '^\\d{7}$' }),
  withConstraints(sampleField('ticket_x', 'text'), { pattern: '[0-9]{4}' }),
  withConstraints(sampleField('mixed_x', 'text'), { pattern: '[A-Z]{2}[0-9]{4}' }),
  sampleField('free_x'),
];
const FORM_NAMES = FORM_FIELDS.map((field) => field.name);

const formCase = (confirmed = true) => {
  const candidate = candidateWith(FORM_FIELDS);
  const scenario = scenarioFor(candidate, FORM_NAMES, confirmed ? {} : { sideEffectConfirmations: NOTIFICATION_UNCONFIRMED });
  return { candidate, scenario, inferred: inferRuleSetContent(scenario, candidate) };
};

const ruleOf = (rules: readonly FieldRule[], name: string): FieldRule | undefined => rules.find((rule) => rule.fieldName === name);

describe('FM2c: inferRuleSetContent makes the inferred rules storable', () => {
  it('makes a rule with the origin mark INFERRED for each inferred field, and the content is storable', () => {
    const { scenario, inferred } = formCase();
    const { fieldRules } = inferred.content;
    expect(fieldRules.every((rule) => rule.origin === 'INFERRED')).toBe(true);
    expect(fieldRules.map((rule) => [rule.fieldName, rule.semanticKind, rule.method])).toEqual([
      ['arrival', 'GENERIC_DATETIME', 'FROM_TYPE'],
      ['email', 'EMAIL', 'FROM_TEMPLATE'],
      ['half_range', 'GENERIC_NUMBER', 'FROM_TYPE'],
      ['limited_x', 'GENERIC_DATETIME', 'FROM_TYPE'],
      ['member_x', 'DIGIT_CODE', 'FROM_TEMPLATE'],
      ['name', 'FULL_NAME', 'FROM_TEMPLATE'],
      ['score_x', 'GENERIC_NUMBER', 'FROM_TYPE'],
      ['stepped', 'GENERIC_NUMBER', 'FROM_TYPE'],
      ['ticket_x', 'DIGIT_CODE', 'FROM_TEMPLATE'],
      ['visit_x', 'GENERIC_DATETIME', 'FROM_TYPE'],
    ]);
    // fix round 1: テンプレートの既定の一意にする欄の組（顧客は氏名）を、推した印つきで固定する。関係はない（開始と終了、単価と数量、フリガナがない）。
    expect(inferred.content.relations).toEqual([]);
    expect(inferred.content.uniqueKeyFieldNames).toEqual(['name']);
    expect(inferred.content.uniqueKeyOrigin).toBe('INFERRED');
    expect(inferred.content.templateDefaultsSaved).toBe(true);
    expect(Object.isFrozen(inferred)).toBe(true);
    const stored = assertStorableRuleSet({ ...savedContentOf(scenario, inferred.content), schemaVersion: RULE_SET_SCHEMA_VERSION });
    expect(stored.fieldRules).toHaveLength(fieldRules.length);
  });

  it('puts the default width on dates and numbers without any range hint, and keeps the field range otherwise', () => {
    const { inferred } = formCase();
    const { fieldRules } = inferred.content;
    expect(ruleOf(fieldRules, 'visit_x')).toMatchObject({ range: null, baseDateWindow: DEFAULT_UNRANGED_DATE_WINDOW_DAYS });
    expect(ruleOf(fieldRules, 'arrival')).toMatchObject({ range: null, baseDateWindow: DEFAULT_UNRANGED_DATE_WINDOW_DAYS });
    expect(ruleOf(fieldRules, 'score_x')).toMatchObject({
      range: { min: String(DEFAULT_UNRANGED_INTEGER_RANGE.min), max: String(DEFAULT_UNRANGED_INTEGER_RANGE.max), step: '1' },
      baseDateWindow: null,
    });
    // 欄に min・max があれば、その範囲（既定の幅を入れない）。片方だけ・step だけの欄も、手がかりがあるので入れない。
    for (const name of ['limited_x', 'half_range', 'stepped']) {
      expect(ruleOf(fieldRules, name)).toMatchObject({ range: null, baseDateWindow: null });
    }
    expect(inferred.defaultRangeFieldNames).toEqual(['arrival', 'score_x', 'visit_x']);
  });

  it('finds the fields with the default width again from the saved rules with the same part (the mark is not bound)', () => {
    const { candidate, scenario, inferred } = formCase();
    const { fieldRules } = inferred.content;
    expect(defaultRangeFieldNamesOf(fieldRules, scenario, candidate)).toEqual(['arrival', 'score_x', 'visit_x']);
    // 人の規則にした欄、範囲を変えた欄は、既定の幅の欄でない。
    const changed = fieldRules.map((rule) => (rule.fieldName === 'arrival' ? { ...rule, origin: 'HUMAN' as const } : rule.fieldName === 'score_x'
      ? { ...rule, range: { min: '1', max: '50', step: '1' } }
      : rule));
    expect(defaultRangeFieldNamesOf(changed, scenario, candidate)).toEqual(['visit_x']);
    expect(defaultRangeFieldNamesOf([], scenario, candidate)).toEqual([]);
  });

  it('lists the fields it cannot infer with the reason codes', () => {
    const { inferred } = formCase();
    expect(inferred.unresolvedFields.map(({ fieldName, problem }) => [fieldName, problem.code, problem.detail])).toEqual([
      ['free_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
      ['half_range', 'NEEDS_RULE_INPUT', 'RANGE_MISSING'],
      ['mixed_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
      ['stepped', 'NEEDS_RULE_INPUT', 'RANGE_MISSING'],
    ]);
  });

  it('infers the contact fields even before the side effect confirmation, and lists them as blocked until it is done', () => {
    const { inferred } = formCase(false);
    expect(ruleOf(inferred.content.fieldRules, 'email')).toMatchObject({ semanticKind: 'EMAIL', origin: 'INFERRED' });
    expect(inferred.unresolvedFields.find(({ fieldName }) => fieldName === 'email')?.problem)
      .toEqual({ code: 'EXTERNAL_DELIVERY_BLOCKED', detail: 'EXTERNAL_NOTIFICATION_UNCONFIRMED' });
  });

  it('decides the saved inferred rules as saved rules, and the evaluation stays the same as the inference', () => {
    const { candidate, scenario, inferred } = formCase();
    const evaluation = evaluateRuleSet(savedOf(scenario, inferred.content.fieldRules), scenario, candidate);
    const decided = evaluation.fields.filter((field) => field.status === 'DECIDED').map((field) => [field.fieldName, field.source]);
    expect(decided).toEqual([
      ['arrival', 'HUMAN'],
      ['email', 'HUMAN'],
      ['limited_x', 'HUMAN'],
      ['member_x', 'HUMAN'],
      ['name', 'HUMAN'],
      ['score_x', 'HUMAN'],
      ['ticket_x', 'HUMAN'],
      ['visit_x', 'HUMAN'],
    ]);
  });

  it('generates the values inside the default widths from the base date, and the digit codes by the pattern', () => {
    const fields = [sampleField('visit_date', 'date'), sampleField('arrival', 'datetime-local'), sampleField('score_x', 'number'),
      withConstraints(sampleField('member_x'), { pattern: '^\\d{7}$' })];
    const candidate = candidateWith(fields);
    const scenario = scenarioFor(candidate, fields.map((field) => field.name));
    const ruleSet = savedOf(scenario, inferRuleSetContent(scenario, candidate).content.fieldRules);
    const last = dayAfter(BASE_DATE, DEFAULT_UNRANGED_DATE_WINDOW_DAYS.toDays);
    for (const grant of ['grant-1', 'grant-2', 'grant-3', 'grant-4', 'grant-5']) {
      const result = generateScenarioData({
        ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet, grant), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const date = result.values.visit_date ?? '';
      expect(date >= BASE_DATE && date <= last).toBe(true);
      const arrival = result.values.arrival ?? '';
      expect(arrival >= `${BASE_DATE}T00:00` && arrival <= `${last}T00:00`).toBe(true);
      const count = Number(result.values.score_x);
      expect(Number.isInteger(count) && count >= DEFAULT_UNRANGED_INTEGER_RANGE.min && count <= DEFAULT_UNRANGED_INTEGER_RANGE.max).toBe(true);
      expect(result.values.member_x).toMatch(/^[0-9]{7}$/u);
    }
    // 基準日が変われば、日付の幅も動く（保存した規則は、基準日からの日の数だけを持つ）。
    const later = '2027-01-15';
    const moved = generateScenarioData({
      ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: later,
    });
    expect(moved.ok && (moved.values.visit_date ?? '') >= later).toBe(true);
    // 実行のたびに変わる欄（照合の READ の期待に使える）。
    expect(varyingFieldNamesOf(planRuleSet(ruleSet, scenario, candidate))).toEqual(['arrival', 'member_x', 'score_x', 'visit_date']);
  });
});

describe('FM2c: the digit code kind (DIGIT_CODE)', () => {
  /**
   * FM2R fix round 1（I-3）: 番号・コードを推すのは、推した規則を作って保存するとき（`inferRuleSetContent`）だけ。人の規則がなければ、推した中身を
   * 保存した形で判定する。
   */
  const evaluateOne = (field: CandidateField, rules: readonly FieldRule[] = []) => {
    const candidate = candidateWith([field]);
    const scenario = scenarioFor(candidate, [field.name]);
    const saved = rules.length > 0 ? rules : inferRuleSetContent(scenario, candidate).content.fieldRules;
    return evaluateRuleSet(ruleSetFor(scenario, saved), scenario, candidate).fields[0];
  };

  it.each<readonly [string, string]>([
    ['^\\d{7}$', 'anchored \\d with a fixed count'],
    ['[0-9]{4}', 'a digit class with a fixed count'],
    ['\\d{1}', 'one digit'],
  ])('infers DIGIT_CODE from %s (%s), even for a name without a word', (pattern) => {
    expect(evaluateOne(withConstraints(sampleField('zz'), { pattern }))).toMatchObject({ status: 'DECIDED', rule: { semanticKind: 'DIGIT_CODE' } });
  });

  it.each<readonly [string]>([['\\d{2,4}'], ['\\d+'], ['[0-9A-Z]{4}'], ['\\d{3}-\\d{4}'], ['[A-Z]{3}']])(
    'does not infer DIGIT_CODE from a pattern that is not digits of a fixed count (%s)',
    (pattern) => {
      expect(evaluateOne(withConstraints(sampleField('zz'), { pattern }))).toMatchObject({
        status: 'NEEDS_RULE_INPUT', problem: { detail: 'SEMANTIC_KIND_UNDECIDED' },
      });
    },
  );

  it('prefers DIGIT_CODE over a dictionary kind whose values cannot match the digits (a product code)', () => {
    expect(evaluateOne(withConstraints(sampleField('product_code'), { pattern: '^\\d{6}$' })))
      .toMatchObject({ status: 'DECIDED', rule: { semanticKind: 'DIGIT_CODE' } });
  });

  it('keeps a numeric kind (its numbers are checked by the pattern, as before)', () => {
    expect(evaluateOne(withConstraints(sampleField('price'), { pattern: '^\\d{4}$' }))).toMatchObject({ rule: { semanticKind: 'UNIT_PRICE' } });
  });

  it('stops a human DIGIT_CODE rule on a field without a digit pattern, or with a length that the digits cannot meet', () => {
    const rule: FieldRule = { fieldName: 'zz', semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE', range: null, fixedValues: [] };
    expect(evaluateOne(sampleField('zz'), [rule])?.problem).toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'PATTERN_UNSUPPORTED' });
    expect(evaluateOne(withConstraints(sampleField('zz'), { pattern: '^\\d{7}$', maxlength: '5' }), [rule])?.problem)
      .toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'LENGTH_UNSATISFIABLE' });
  });
});

describe('FM2R fix round 1 (I-3): the inference at each judgement stays as before FM2c', () => {
  const MEMBER = withConstraints(sampleField('member_x', 'text'), { pattern: '^\\d{7}$' });

  it('infers DIGIT_CODE only when asked for the saved rules', () => {
    expect(inferSemanticKind(MEMBER)).toBeNull();
    expect(inferSemanticKind(MEMBER, { digitCode: true })).toBe('DIGIT_CODE');
  });

  // LG-3: 版 1 の文書は読まないので、版 2 の保存した規則の集まり（その欄の規則がない）で同じ確かめをする。
  it('stops a digit field without a saved rule in a stored rule set, as before', () => {
    const fields = [sampleField('name'), MEMBER];
    const candidate = candidateWith(fields);
    const scenario = scenarioFor(candidate, ['member_x', 'name']);
    const stored = ruleSetRevisionOfStoredDocument({
      schemaVersion: RULE_SET_SCHEMA_VERSION, ruleSetId: 'rules-1', scenarioId: scenario.scenarioId, revision: 1,
      fieldRules: [{ fieldName: 'name', semanticKind: 'FULL_NAME', method: 'FROM_TEMPLATE', range: null, fixedValues: [] }],
      relations: [], uniqueKeyFieldNames: [], createdAt: '20261013000000',
    });
    const evaluation = evaluateRuleSet(stored, scenario, candidate);
    expect(evaluation.fields.find((field) => field.fieldName === 'member_x')).toMatchObject({
      status: 'NEEDS_RULE_INPUT', problem: { code: 'NEEDS_RULE_INPUT', detail: 'SEMANTIC_KIND_UNDECIDED' }, source: null, rule: null,
    });
    expect(evaluation.executable).toBe(false);
    // 推した規則を作って保存すれば、番号・コードで決まる（保存した規則は承認に結ばれる）。
    const inferred = inferRuleSetContent(scenario, candidate);
    expect(evaluateRuleSet(ruleSetFor(scenario, inferred.content.fieldRules), scenario, candidate).fields
      .find((field) => field.fieldName === 'member_x')).toMatchObject({ status: 'DECIDED', source: 'HUMAN', rule: { semanticKind: 'DIGIT_CODE' } });
  });

  it('does not put the default width on a field without a saved rule at the judgement', () => {
    const candidate = candidateWith([sampleField('visit_x', 'date'), sampleField('score_x', 'number')]);
    const scenario = scenarioFor(candidate, ['score_x', 'visit_x']);
    expect(evaluateRuleSet(ruleSetFor(scenario), scenario, candidate).fields.map(({ fieldName, problem }) => [fieldName, problem?.detail ?? null]))
      .toEqual([['score_x', 'RANGE_MISSING'], ['visit_x', 'RANGE_MISSING']]);
  });
});

describe('FM2c: the base date window of a saved rule', () => {
  const windowRule = (fieldName: string, overrides: Partial<FieldRule> = {}): FieldRule => ({
    fieldName, semanticKind: 'GENERIC_DATETIME', method: 'FROM_TYPE', range: null, fixedValues: [], origin: 'INFERRED',
    baseDateWindow: { fromDays: 0, toDays: 30 }, ...overrides,
  });
  const evaluateOne = (field: CandidateField, rule: FieldRule) => {
    const candidate = candidateWith([field]);
    const scenario = scenarioFor(candidate, [field.name]);
    return evaluateRuleSet(ruleSetFor(scenario, [rule]), scenario, candidate).fields[0];
  };

  it('stops the window on a field with its own range, a step, or a type other than date and datetime-local', () => {
    expect(evaluateOne(withConstraints(sampleField('d', 'date'), { min: '2026-01-01', max: '2026-12-31' }), windowRule('d'))?.problem)
      .toEqual({ code: 'RULE_CONFLICT', detail: 'RANGE_OUTSIDE_FIELD_CONSTRAINT' });
    expect(evaluateOne(withConstraints(sampleField('d', 'date'), { step: '7' }), windowRule('d'))?.problem)
      .toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'CONSTRAINT_UNSUPPORTED' });
    expect(evaluateOne(sampleField('t', 'time'), windowRule('t'))?.problem).toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'CONSTRAINT_UNSUPPORTED' });
    expect(evaluateOne(sampleField('d', 'date'), windowRule('d'))?.status).toBe('DECIDED');
  });

  it('keeps start before end with the same window (the relation of the template)', () => {
    const fields = [sampleField('start_date', 'date'), sampleField('end_date', 'date')];
    const candidate = candidateWith(fields);
    const scenario = scenarioFor(candidate, ['end_date', 'start_date']);
    const inferred = inferRuleSetContent(scenario, candidate);
    expect(inferred.content.fieldRules.map((rule) => [rule.fieldName, rule.semanticKind, rule.baseDateWindow])).toEqual([
      ['end_date', 'END_TIME', DEFAULT_UNRANGED_DATE_WINDOW_DAYS],
      ['start_date', 'START_TIME', DEFAULT_UNRANGED_DATE_WINDOW_DAYS],
    ]);
    // fix round 1: 終了 > 開始の関係も、推した印つきで固定する。
    expect(inferred.content.relations).toEqual([{ kind: 'END_AFTER_START', startFieldName: 'start_date', endFieldName: 'end_date', origin: 'INFERRED' }]);
    const ruleSet = savedContentOf(scenario, inferred.content);
    expect(evaluateRuleSet(ruleSet, scenario, candidate).executable).toBe(true);
    const result = generateScenarioData({
      ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE,
    });
    expect(result.ok && (result.values.end_date ?? '') > (result.values.start_date ?? '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API の鍵の制約を form の候補から補う
// ---------------------------------------------------------------------------------------------------------------

const API = 'https://api.example.invalid';
const NEW_PATH = '/admin/orders/new';
const MARKERS = ['bsprobe00000000000a', '123456789', 'bsprobe00000000000c'];
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'lv_x', selector: '#lv', type: 'number', marker: 1 },
  { name: 'plan_x', selector: '#plan', type: 'text', marker: 0 },
  { name: 'ref_x', selector: '#ref', type: 'text', marker: 2 },
];

const shapeOf = (): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url: `${API}/rest/v1/orders?select=*`,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify({ plan_x: MARKERS[0], lv_x: Number(MARKERS[1]), ref_x: MARKERS[2] }) },
}, { pagePath: NEW_PATH, markers: MARKERS });

/** probe を持つ候補（form の中の候補か、form の外のボタンの候補）。 */
const apiCandidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...candidateOf(discovered),
  submissionProbe: observedSubmissionProbeOf({ shapes: [shapeOf()], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: INPUT_FIELDS.length, skippedFieldCount: 0 }, INPUT_FIELDS),
});

const FORM_CANDIDATE = apiCandidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: NEW_PATH },
  action: sampleAction('/admin/orders'),
  submitterText: '保存',
  jsBinding: { ...NO_JS_BINDING, submitter: ['click'] },
  fields: [
    withConstraints(sampleField('lv_x', 'number'), { min: '1', max: '5' }),
    withConstraints(sampleField('plan_x', 'text'), { pattern: '^\\d{3}$' }),
    sampleField('ref_x', 'text'),
  ],
}));
const BUTTON_CANDIDATE = apiCandidateOf(sampleButton({
  page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] },
}));

const apiScenarioOf = (candidate: DiscoveryCandidate): ScenarioRevision => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: candidate.identityDigest,
    transport: 'API',
    fieldNames: ['lv_x', 'plan_x', 'ref_x'],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    api: {
      shapeDigest: candidate.submissionProbe?.shapeDigest,
      pageKeys: [],
      filterName: null,
      recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
      ledger: null,
    },
  }, candidate, [], {
    scenarioId: null,
    scenarios: [],
    approvedServiceOrigins: [API],
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
};

/** 同じ候補の、form の欄の制約だけを外した写し（識別と規則の digest は同じ。補いがあれば、値が変わるはず）。 */
const withoutFormConstraints = (candidate: DiscoveryCandidate): DiscoveryCandidate =>
  ({ ...candidate, fields: candidate.fields.map((field) => ({ ...field, constraints: NO_CONSTRAINTS })) });

/** 承認済みのシナリオの例の、人の規則（補いの前から保存してあった形）。 */
const HUMAN_API_RULES: readonly FieldRule[] = [
  { fieldName: 'lv_x', semanticKind: 'GENERIC_NUMBER', method: 'FROM_TYPE', range: { min: '1', max: '9', step: '1' }, fixedValues: [] },
  { fieldName: 'plan_x', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['p1', 'p2', 'p3'] },
  { fieldName: 'ref_x', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['r1'] },
];

describe('FM2c: the constraints of an API key come from the field of the same form, only when the rules are inferred (fix round 1)', () => {
  it('does not use the form field in the judgement without saved rules (the same as before the supplement)', () => {
    const scenario = apiScenarioOf(FORM_CANDIDATE);
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, FORM_CANDIDATE);
    expect(evaluation.fields.map(({ fieldName, status, problem }) => [fieldName, status, problem?.detail ?? null])).toEqual([
      ['lv_x', 'NEEDS_RULE_INPUT', 'RANGE_MISSING'],
      ['plan_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
      ['ref_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
    ]);
    expect(evaluation).toEqual(evaluateRuleSet(ruleSetFor(scenario), scenario, withoutFormConstraints(FORM_CANDIDATE)));
  });

  it('keeps the generated values of an approved scenario the same with and without the form constraints', () => {
    const scenario = apiScenarioOf(FORM_CANDIDATE);
    const ruleSet = ruleSetFor(scenario, HUMAN_API_RULES);
    for (const grant of ['grant-1', 'grant-2', 'grant-3', 'grant-4', 'grant-5', 'grant-6']) {
      const generate = (candidate: DiscoveryCandidate) => generateScenarioData({
        ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet, grant), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE,
      });
      const withForm = generate(FORM_CANDIDATE);
      expect(withForm.ok).toBe(true);
      // 欄の範囲（1〜5）で補えば外れる値（6〜9）も、今どおり人の範囲から作る。
      expect(withForm).toEqual(generate(withoutFormConstraints(FORM_CANDIDATE)));
    }
  });

  it('fixes the supplemented range and digit count in the inferred rules, and generates inside them', () => {
    const scenario = apiScenarioOf(FORM_CANDIDATE);
    const inferred = inferRuleSetContent(scenario, FORM_CANDIDATE);
    expect(inferred.content.fieldRules.map(({ fieldName, semanticKind, range, digitCount }) => [fieldName, semanticKind, range, digitCount])).toEqual([
      ['lv_x', 'GENERIC_NUMBER', { min: '1', max: '5', step: null }, null],
      ['plan_x', 'DIGIT_CODE', null, 3],
    ]);
    expect(inferred.defaultRangeFieldNames).toEqual([]);
    expect(inferred.unresolvedFields.map(({ fieldName, problem }) => [fieldName, problem.detail])).toEqual([['ref_x', 'SEMANTIC_KIND_UNDECIDED']]);
    const ruleSet = ruleSetFor(scenario, [...inferred.content.fieldRules,
      { fieldName: 'ref_x', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['r1'] }]);
    for (const grant of ['grant-1', 'grant-2', 'grant-3', 'grant-4']) {
      const result = generateScenarioData({
        ruleSet, scenario, candidate: FORM_CANDIDATE, seedInput: seedInputFor(scenario, ruleSet, grant), usedUniqueKeys: [], usedPhoneNumbers: [],
        baseDate: BASE_DATE,
      });
      expect(result.ok).toBe(true);
      expect(Number(result.ok ? result.values.lv_x : 0)).toBeGreaterThanOrEqual(1);
      expect(Number(result.ok ? result.values.lv_x : 99)).toBeLessThanOrEqual(5);
      expect(result.ok ? result.values.plan_x : '').toMatch(/^[0-9]{3}$/u);
      // 保存した規則で作る値は、form の欄の制約によらない（判定は補わない）。
      expect(result).toEqual(generateScenarioData({
        ruleSet, scenario, candidate: withoutFormConstraints(FORM_CANDIDATE), seedInput: seedInputFor(scenario, ruleSet, grant), usedUniqueKeys: [],
        usedPhoneNumbers: [], baseDate: BASE_DATE,
      }));
    }
  });

  it('keeps the keys of a button outside a form without supplement (the number key needs a range, the default width fills it)', () => {
    const scenario = apiScenarioOf(BUTTON_CANDIDATE);
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, BUTTON_CANDIDATE);
    expect(evaluation.fields.map(({ fieldName, status, problem }) => [fieldName, status, problem?.detail ?? null])).toEqual([
      ['lv_x', 'NEEDS_RULE_INPUT', 'RANGE_MISSING'],
      ['plan_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
      ['ref_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED'],
    ]);
    const inferred = inferRuleSetContent(scenario, BUTTON_CANDIDATE);
    expect(inferred.defaultRangeFieldNames).toEqual(['lv_x']);
    expect(evaluateRuleSet(ruleSetFor(scenario, inferred.content.fieldRules), scenario, BUTTON_CANDIDATE).fields
      .find((field) => field.fieldName === 'lv_x')?.status).toBe('DECIDED');
  });
});

describe('FM2c fix round 1: a rule set with the saved template defaults uses only the saved relations and unique key fields', () => {
  const fields = [sampleField('name'), sampleField('start_date', 'date'), sampleField('end_date', 'date')];
  const candidate = candidateWith(fields);
  const scenario = scenarioFor(candidate, fields.map((field) => field.name));
  const window = { fromDays: 0, toDays: 30 };
  const rules: readonly FieldRule[] = [
    { fieldName: 'end_date', semanticKind: 'END_TIME', method: 'FROM_TEMPLATE', range: null, fixedValues: [], baseDateWindow: window },
    { fieldName: 'name', semanticKind: 'FULL_NAME', method: 'FROM_TEMPLATE', range: null, fixedValues: [] },
    { fieldName: 'start_date', semanticKind: 'START_TIME', method: 'FROM_TEMPLATE', range: null, fixedValues: [], baseDateWindow: window },
  ];

  it('adds the template defaults when the mark is absent (as before), and does not add them when it is set', () => {
    const plain = evaluateRuleSet(ruleSetFor(scenario, rules), scenario, candidate);
    expect(plain.relations.map((relation) => relation.kind)).toEqual(['END_AFTER_START']);
    expect(plain.uniqueKeyFieldNames).toEqual(['name']);
    const fixed = evaluateRuleSet(ruleSetFor(scenario, rules, { templateDefaultsSaved: true }), scenario, candidate);
    expect(fixed.relations).toEqual([]);
    expect(fixed.uniqueKeyFieldNames).toEqual([]);
  });

  it('keeps the saved relations and unique key fields of the inferred content in the judgement', () => {
    const inferred = inferRuleSetContent(scenario, candidate);
    const evaluation = evaluateRuleSet(savedContentOf(scenario, inferred.content), scenario, candidate);
    expect(evaluation.relations).toEqual(inferred.content.relations);
    expect(evaluation.uniqueKeyFieldNames).toEqual(['name']);
    expect(evaluation.executable).toBe(true);
  });
});
