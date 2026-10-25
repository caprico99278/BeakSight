// T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: API の `{id}` の照合の READ（送る値を持たない照合の READ）は、実行のたびに変わる値（生成した
// 値）と比べる期待を 1 つ以上求める。毎回同じ値になる入力の規則の欄（1 つの値だけの固定の一覧、「送らない」側、値が 1 つしかない範囲など）と比べる
// 期待だけでは、ページが古い ID を出したときに取り違えを見分けられない。
// - 欄ごとの「実行のたびに変わるか」の判定は `src/control/data-rules/varying-values.ts` の `varyingFieldNamesOf`（入力の規則の値の作り方から決める）。
// - 照合の READ の判定は `readVerificationVaryingRejectionOf`（規則の集まりとシナリオと候補から。許可の発行 `issueIn` と開始の画面が使う）。期待の判定は
//   `read-check-contracts.ts` の `hasGeneratedValueExpectation` に、比べる値が変わるかの述語を渡す（保存・許可・IPC が同じ部品）。
// - シナリオの保存の時は入力の規則がまだないので、種類だけで確かめる（T40R-fix-B のまま）。規則を確かめる許可の発行で、この判定をかける。
// - FORM のシナリオと、候補の READ（結び付けで生成した値を送る）は対象の外。
import { describe, expect, it } from 'vitest';
import { EXECUTION_GRANT_REJECTION_REASONS } from '../../src/control/approval/execution-grant.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import type { FieldRule } from '../../src/control/data-rules/rule-contracts.js';
import { readVerificationVaryingRejectionOf, varyingFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { hasGeneratedValueExpectation } from '../../src/discovery/read-check-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { EXECUTION_GRANT_REJECTION_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { ruleSetFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const NEW_PATH = '/admin/members/new';

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];

const CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'POST',
      resourceType: 'fetch',
      url: `${API}/rest/v1/members?select=*`,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1], score: Number(MARKERS[2]) }) },
    }, { pagePath: NEW_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
};

const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
  { readCheckId: 'rc-search', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'], targetKind: 'CANDIDATE' },
] as const;

type Expectations = readonly Record<string, unknown>[];

/** 下書きの確かめ（T38b〜T40R-fix-B）が作る API の登録のシナリオ（照合の READ は引数）。 */
const apiScenarioOf = (readCheckId: string, bindings: readonly Record<string, string>[], expectations: Expectations): ScenarioRevision => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: CANDIDATE.identityDigest,
    transport: 'API',
    fieldNames: ['name', 'email', 'score'],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: { successCondition: null, inputErrorCondition: null, recordId: null, readVerification: { readCheckId, revision: 1, bindings, expectations } },
    api: { shapeDigest: CANDIDATE.submissionProbe?.shapeDigest, pageKeys: [], filterName: null, recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, ledger: null },
  }, CANDIDATE, READ_FACTS, { scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 } });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
};

const fixed = (fieldName: string, values: readonly string[]): FieldRule =>
  sampleFieldRule(fieldName, { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: [...values] });
const SCORE_ONE_VALUE = sampleFieldRule('score', { range: { min: '5', max: '5', step: '1' } });
const SCORE_RANGE = sampleFieldRule('score', { range: { min: '1', max: '9', step: '1' } });
const NAME_ONE_VALUE = fixed('name', ['試験 太郎']);
const EMAIL_ONE_VALUE = fixed('email', ['sample0001@example.invalid']);

const TEXT_OF = (fieldName: string) => ({ kind: 'TEXT_CONTAINS', fieldName });
const DETAIL_OF = (fieldName: string) => ({ kind: 'DETAIL_FIELD_EQUALS', field: '項目', fieldName });
const ONE_ROW = { kind: 'ROW_COUNT_EQUALS', count: 1 };

describe('T40R2-fix M-1: which fields vary from run to run', () => {
  it('tells the varying fields from the plans of the input rules (one fixed value, one value range and opt-out do not vary)', () => {
    const scenario = apiScenarioOf('rc-page', [], [TEXT_OF('email')]);
    const varyingOf = (rules: readonly FieldRule[]) =>
      [...varyingFieldNamesOf(planRuleSet(ruleSetFor(scenario, rules), scenario, CANDIDATE))].sort();
    // テンプレートの規則: 氏名（辞書の人）とメール（合成の番号）は変わる。点数は範囲で変わる。
    expect(varyingOf([SCORE_RANGE])).toEqual(['email', 'name', 'score']);
    expect(varyingOf([SCORE_ONE_VALUE, NAME_ONE_VALUE, EMAIL_ONE_VALUE])).toEqual([]);
    expect(varyingOf([SCORE_RANGE, fixed('name', ['試験 太郎', '試験 次郎']), EMAIL_ONE_VALUE])).toEqual(['name', 'score']);
    expect(varyingOf([SCORE_RANGE, fixed('name', ['試験 太郎', '試験 太郎 '])])).toContain('name');
  });
});

describe('T40R2-fix M-1: the expectation of a READ without a value to send must compare with a varying value', () => {
  it('adds the grant rejection reason with its description', () => {
    // T41b: その後ろに、API の更新の台帳の結び付けの理由を足した（`api-update-grant-start.test.ts`）。
    expect(EXECUTION_GRANT_REJECTION_REASONS.at(-2)).toBe('READ_VERIFICATION_NOT_VARYING');
    expect(EXECUTION_GRANT_REJECTION_DESCRIPTIONS.READ_VERIFICATION_NOT_VARYING.description.length).toBeGreaterThan(0);
  });

  it.each<readonly [string, Expectations, readonly FieldRule[], string | null]>([
    ['a text of a field with one fixed value only', [TEXT_OF('email')], [SCORE_RANGE, EMAIL_ONE_VALUE], 'READ_VERIFICATION_NOT_VARYING'],
    ['a row count and a detail of a one-value range', [ONE_ROW, DETAIL_OF('score')], [SCORE_ONE_VALUE], 'READ_VERIFICATION_NOT_VARYING'],
    ['texts of fields that never vary', [TEXT_OF('email'), TEXT_OF('name')], [SCORE_RANGE, EMAIL_ONE_VALUE, NAME_ONE_VALUE], 'READ_VERIFICATION_NOT_VARYING'],
    ['a text of a generated email', [TEXT_OF('email')], [SCORE_RANGE], null],
    ['a constant text and a varying detail', [TEXT_OF('email'), DETAIL_OF('score')], [SCORE_RANGE, EMAIL_ONE_VALUE], null],
  ])('judges a page path template READ with %s', (_label, expectations, rules, reason) => {
    const scenario = apiScenarioOf('rc-page', [], expectations);
    expect(readVerificationVaryingRejectionOf(ruleSetFor(scenario, rules), scenario, CANDIDATE)).toBe(reason);
  });

  it('leaves a READ candidate bound to a generated value (it sends the value) and a FORM scenario out', () => {
    const search = apiScenarioOf('rc-search', [{ parameterName: 'q', fieldName: 'email' }], [ONE_ROW]);
    expect(readVerificationVaryingRejectionOf(ruleSetFor(search, [SCORE_RANGE, EMAIL_ONE_VALUE]), search, CANDIDATE)).toBeNull();
    const form = sampleScenario();
    expect(readVerificationVaryingRejectionOf(ruleSetFor(form, []), form, CANDIDATE)).toBeNull();
  });

  it('lets the expectation judgement take a predicate of the varying values (the save, the grant and the IPC call the same part)', () => {
    expect(hasGeneratedValueExpectation([TEXT_OF('email')], () => false)).toBe(false);
    expect(hasGeneratedValueExpectation([TEXT_OF('email')], () => true)).toBe(true);
    expect(hasGeneratedValueExpectation([ONE_ROW], () => true)).toBe(false);
    expect(hasGeneratedValueExpectation([TEXT_OF('email')])).toBe(true);
  });
});
