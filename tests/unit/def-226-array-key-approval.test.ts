// DEF-226・ARR-2（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.1、3.3 の 2、3.4）: API の登録の本文の一覧の形の値（array）の承認と、書き込みの段の
// 照合と、記録。純粋な部品を表で確かめる。
// - 承認: 欄に対応づけた一覧の鍵（文字の欄 × 文字の一覧。要素は文字 1 つ）と、ページが決める一覧の鍵（入れ子なし・上限の中。要素の型の集合と数を承認の内容に
//   入れる）を受ける。入れ子・上限の超過・欄の一覧の要素の型と数の違いは、分けた理由で拒む。更新（UPDATE）の一覧の鍵と、要素の情報のない古い型は、今のまま
//   `SCENARIO_API_PAGE_KEY_NOT_SCALAR`。
// - 承認の digest: 一覧のないシナリオの digest は、ARR-2 の前の値のまま（固定の値）。一覧の鍵のあるシナリオは、要素の型の集合と数で digest が変わる。
// - 照合: 欄の一覧は `[生成した値]` と完全一致。ページが決める一覧は入れ子なし・要素の型の集合と数が承認と同じ・上限の中。承認していない一覧の鍵と入れ子は今の
//   まま `BODY_VALUE_NOT_SCALAR`。期待の誤り（要素の情報がない、上限の外、更新の一覧の鍵）は `EXPECTATION_INVALID`。
// - 記録: ページが決める一覧の値は、JSON の文字の形で残す（上限を超えたら null の印）。
// - 生成の型: 欄に対応づけた一覧の鍵の生成した値の型は、要素の型の文字（`apiKeyFieldValueTypeOf`）。
import { describe, expect, it } from 'vitest';
import { actionApiSummaryOf } from '../../src/control/actions/action-api-summary.js';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import { apiScenarioFormOf } from '../../src/control/approval/api-scenario-draft.js';
import type { ScenarioApiSpec, ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { apiKeyFieldValueTypeOf, isJsonValueConvertible } from '../../src/core/json-value.js';
import { apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import {
  checkApiWritePayload,
  type ApiWriteCheckSpec,
  type ApiWritePayloadExpectation,
  type ApiWriteRequestFacts,
} from '../../src/safety/api-write-payload-policy.js';
import { ALL_CONFIRMED, AUTH_SETUP_DIGEST, INPUT_RULES, PROFILE_ID, TARGET_CONFIG_DIGEST, candidateOf, sampleScenario } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b', '123456789'];
const NEW_PATH = '/admin/records/new';
const EDIT_PATH = '/admin/records/1/edit';
/** 題の欄（文字の値）と札の欄（文字の値が一覧に入る）。 */
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'title', selector: '#title', type: 'text', marker: 0 },
  { name: 'label', selector: '#label', type: 'text', marker: 1 },
];
/** 一覧の鍵のある本文（札の欄の文字が `labels` の一覧に入る。`holders` と `makers` はページが決める一覧）。 */
const ARRAY_BODY = { title: MARKERS[0], labels: [MARKERS[1]], holders: ['u-1'], makers: [] };
const DIGEST_FACTS = { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST } as const;

const shapeOf = (body: unknown, method = 'POST', url = `${API}/rest/v1/records?select=*`, pagePath = NEW_PATH): ApiRequestShape => apiRequestShapeOf({
  method,
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath, markers: MARKERS });

const probeOf = (shape: ApiRequestShape, inputFields = INPUT_FIELDS): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields);

const buttonOf = (probe: SubmissionProbeRecord, pagePath = NEW_PATH): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});
const createButtonOf = (body: unknown = ARRAY_BODY): DiscoveryCandidate => buttonOf(probeOf(shapeOf(body)));

const CONTEXT: ScenarioDraftContext = {
  scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 },
};
const draftOf = (candidate: DiscoveryCandidate, api: Record<string, unknown> = {}, fieldNames = ['labels', 'title']): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest, pageKeys: ['holders', 'makers'], filterName: null, recordId: null, ledger: null, ...api },
});
const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (candidate: DiscoveryCandidate, api: Record<string, unknown> = {}, fieldNames?: readonly string[]): ScenarioDraftValidationResult =>
  validateScenarioDraft(draftOf(candidate, api, fieldNames === undefined ? undefined : [...fieldNames]), candidate, [], CONTEXT);

const ARRAY_REASONS = [
  'SCENARIO_API_ARRAY_NESTED',
  'SCENARIO_API_ARRAY_OVER_LIMIT',
  'SCENARIO_API_ARRAY_ELEMENT_TYPE_MISMATCH',
  'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH',
] as const;

describe('ARR-2: the approval of the array keys of an API create', () => {
  it('has the four reasons of an array key in the closed list', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toEqual(expect.arrayContaining([...ARRAY_REASONS]));
  });

  it('accepts a field array key (a text field into a list of one text) and page array keys, and keeps the element types and the count of a page key', () => {
    const result = validate(createButtonOf());
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keyFields).toEqual([
      { key: 'labels', type: 'array', field: { kind: 'NAME', name: 'label' }, fieldType: 'text' },
      { key: 'title', type: 'string', field: { kind: 'NAME', name: 'title' }, fieldType: 'text' },
    ]);
    expect(result.content.api?.pageKeys).toEqual([
      { key: 'holders', type: 'array', elements: { types: ['string'], count: 1 } },
      { key: 'makers', type: 'array', elements: { types: [], count: 0 } },
    ]);
    // 値は持たない（I22）。スキーマを通る。
    expect(JSON.stringify(result.content)).not.toContain('bsprobe');
    expect(JSON.stringify(result.content)).not.toContain('u-1');
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('rejects a nested page array key, and accepts a long page array key and a long text (L13 fix round 1: no limit)', () => {
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, holders: [{ id: 1 }] })))).toEqual(['SCENARIO_API_ARRAY_NESTED']);
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, holders: [['u-1']] })))).toEqual(['SCENARIO_API_ARRAY_NESTED']);
    // L13 fix round 1: 要素の数と文字の長さに上限を置かない（前は 21 個・201 文字で `SCENARIO_API_ARRAY_OVER_LIMIT`）。
    const many = Array.from({ length: 21 }, (_, index) => `u-${String(index)}`);
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, holders: many })))).toEqual([]);
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, holders: ['x'.repeat(201)] })))).toEqual([]);
  });

  it('rejects a field array key whose elements are not exactly one text, with the reasons of the element type and the count', () => {
    const typed = validate(buttonOf(probeOf(shapeOf({ ...ARRAY_BODY, labels: [Number(MARKERS[2])] }), [
      INPUT_FIELDS[0] as SubmissionProbeInputField, { name: 'label', selector: '#label', type: 'text', marker: 2 },
    ])));
    expect(codesOf(typed)).toEqual(['SCENARIO_API_ARRAY_ELEMENT_TYPE_MISMATCH']);
    expect(typed.ok ? null : typed.errors[0]?.fieldName).toBe('labels');
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, labels: [MARKERS[1], 'extra'] })))).toEqual(['SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH']);
    expect(codesOf(validate(createButtonOf({ ...ARRAY_BODY, labels: [MARKERS[1], { a: 1 }] })))).toEqual(['SCENARIO_API_ARRAY_NESTED']);
  });

  it('rejects an array key of a shape without the element information (a probe before ARR-1) as before', () => {
    const shape = shapeOf(ARRAY_BODY);
    const old: ApiRequestShape = {
      ...shape,
      body: {
        ...shape.body,
        keys: shape.body.keys.map(({ name, type }) => ({ name, type })),
        markerKeys: shape.body.markerKeys.filter(({ inArray }) => inArray !== true),
      },
    };
    const probe = probeOf(old);
    const forged: SubmissionProbeRecord = { ...probe, shape: old, shapeDigest: apiShapeDigestOf(old) };
    const codes = codesOf(validate(buttonOf(forged), { pageKeys: ['holders', 'labels', 'makers'] }, ['title']));
    expect(codes).toContain('SCENARIO_API_PAGE_KEY_NOT_SCALAR');
    expect(codes.filter((code) => (ARRAY_REASONS as readonly string[]).includes(code))).toEqual([]);
  });

  it('rejects the array keys of an UPDATE as before (a page key and a marked key)', () => {
    const body = { title: MARKERS[0], labels: [MARKERS[1]], holders: ['u-1'] };
    const candidate = buttonOf(probeOf(shapeOf(body, 'PATCH', `${API}/rest/v1/records?id=eq.1&select=*`, EDIT_PATH)), EDIT_PATH);
    const draft = {
      ...draftOf(candidate, {
        pageKeys: ['holders'], filterName: 'id', ledger: { targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/admin/records/{id}/edit' },
      }, ['title']),
    };
    const context: ScenarioDraftContext = {
      ...CONTEXT,
      scenarios: [{ scenarioId: 'scenario-ledger', profileId: PROFILE_ID, kind: 'CREATE', apiRequest: { origin: API, pathShape: '/rest/v1/records' } }],
    };
    const codes = codesOf(validateScenarioDraft(draft, candidate, [], context));
    expect(codes).toContain('SCENARIO_API_PAGE_KEY_NOT_SCALAR');
    expect(codes.filter((code) => (ARRAY_REASONS as readonly string[]).includes(code))).toEqual([]);
    // 札（一覧に入る欄）を変える鍵にしても拒む。
    expect(codesOf(validateScenarioDraft({ ...draft, fieldNames: ['labels', 'title'] }, candidate, [], context))).toContain('SCENARIO_API_PAGE_KEY_NOT_SCALAR');
  });

  it('proposes the array keys in the form of the draft (the automatic draft uses it)', () => {
    const { form, rejection } = apiScenarioFormOf({ profileId: PROFILE_ID, candidate: createButtonOf(), context: CONTEXT, scenarios: [] });
    expect(rejection).toBeNull();
    expect(form?.keyFields.map(({ key, type, rejection: blocked }) => [key, type, blocked])).toEqual([['labels', 'array', null], ['title', 'string', null]]);
    expect(form?.pageKeys.map(({ key, rejection: blocked }) => [key, blocked])).toEqual([['holders', null], ['makers', null]]);
    const nested = apiScenarioFormOf({ profileId: PROFILE_ID, candidate: createButtonOf({ ...ARRAY_BODY, holders: [{ id: 1 }] }), context: CONTEXT, scenarios: [] });
    expect(nested.form?.pageKeys.find(({ key }) => key === 'holders')?.rejection).toBe('SCENARIO_API_ARRAY_NESTED');
  });
});

describe('ARR-2: the approval digest', () => {
  const scenarioOf = (candidate: DiscoveryCandidate, api: Record<string, unknown> = {}, fieldNames?: readonly string[]): ScenarioRevision => {
    const result = validate(candidate, api, fieldNames);
    if (!result.ok) throw new Error(codesOf(result).join(','));
    return { ...sampleScenario(), ...result.content, inputRuleReference: INPUT_RULES } as ScenarioRevision;
  };

  it('keeps the digest of a scenario without an array key (the value computed before ARR-2)', () => {
    const plain = scenarioOf(createButtonOf({ title: MARKERS[0], label: MARKERS[1], tenant_id: 'tenant-1' }), { pageKeys: ['tenant_id'] }, ['label', 'title']);
    expect(computeApprovalDigest(plain, DIGEST_FACTS)).toBe(PLAIN_SCENARIO_DIGEST);
  });

  it('changes the digest of a scenario with an array page key when the element types or the count change', () => {
    const base = computeApprovalDigest(scenarioOf(createButtonOf()), DIGEST_FACTS);
    expect(computeApprovalDigest(scenarioOf(createButtonOf({ ...ARRAY_BODY, holders: ['u-1', 'u-2'] })), DIGEST_FACTS)).not.toBe(base);
    expect(computeApprovalDigest(scenarioOf(createButtonOf({ ...ARRAY_BODY, holders: [1] })), DIGEST_FACTS)).not.toBe(base);
  });
});

/** ARR-2 の前の実装で計算した、一覧のないシナリオの承認の digest。 */
const PLAIN_SCENARIO_DIGEST = 'sha256:42b3167716993764e99ab2337d122a358975623574226857206cd87838016225';

// ---------------------------------------------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------------------------------------------

const API_PATH = '/rest/v1/records';
const LABEL_VALUE = '札 一';
const TITLE_VALUE = '題 一';
const checkSpec = (overrides: Partial<ApiWriteCheckSpec> = {}): ApiWriteCheckSpec => ({
  request: { method: 'POST', origin: API, pathShape: API_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
  keyFields: [{ key: 'labels', type: 'array' }, { key: 'title', type: 'string' }],
  pageKeys: [
    { key: 'holders', type: 'array', elements: { types: ['string'], count: 1 } },
    { key: 'makers', type: 'array', elements: { types: [], count: 0 } },
  ],
  headerNames: ['content-type'],
  filterName: null,
  ...overrides,
});
const expectationOf = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: checkSpec(),
  values: { labels: LABEL_VALUE, title: TITLE_VALUE },
  recordId: null,
  ...overrides,
});
const factsOf = (body: unknown, overrides: Partial<ApiWriteRequestFacts> = {}): ApiWriteRequestFacts => ({
  method: 'POST',
  url: `${API}${API_PATH}`,
  headers: { 'Content-Type': 'application/json' },
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  ...overrides,
});
const SENT = { title: TITLE_VALUE, labels: [LABEL_VALUE], holders: ['u-1'], makers: [] };

describe('ARR-2: the check of the array keys before the send', () => {
  it('allows the approved array keys and returns the values of the page array keys', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf(SENT))).toEqual({ decision: 'ALLOW', pageKeyValues: { holders: ['u-1'], makers: [] } });
    // escape の違う書き方の同じ文字も一致（値は解いて比べる）。
    const escaped = `{"title":"${TITLE_VALUE}","labels":["\\u672d \\u4e00"],"holders":[ "u-1" ],"makers":[ ]}`;
    expect(checkApiWritePayload(expectationOf(), factsOf(escaped)).decision).toBe('ALLOW');
  });

  it.each<readonly [string, unknown, string]>([
    ['a field list with another value added', { ...SENT, labels: [LABEL_VALUE, 'extra'] }, 'BODY_VALUE_MISMATCH'],
    ['a field list with another value', { ...SENT, labels: ['other'] }, 'BODY_VALUE_MISMATCH'],
    ['an empty field list', { ...SENT, labels: [] }, 'BODY_VALUE_MISMATCH'],
    ['a field list of a number', { ...SENT, labels: [1] }, 'BODY_VALUE_MISMATCH'],
    ['the field value as a text instead of a list', { ...SENT, labels: LABEL_VALUE }, 'BODY_VALUE_TYPE_MISMATCH'],
    ['a nested field list', { ...SENT, labels: [[LABEL_VALUE]] }, 'BODY_VALUE_NOT_SCALAR'],
    ['a page list with another count', { ...SENT, holders: ['u-1', 'u-2'] }, 'BODY_VALUE_MISMATCH'],
    ['a page list of another element type', { ...SENT, holders: [1] }, 'BODY_VALUE_MISMATCH'],
    ['a page list of mixed element types', { ...SENT, holders: ['u-1'], makers: [null] }, 'BODY_VALUE_MISMATCH'],
    ['a nested page list', { ...SENT, holders: [['u-1']] }, 'BODY_VALUE_NOT_SCALAR'],
    ['a page list with an object', { ...SENT, holders: [{ id: 'u-1' }] }, 'BODY_VALUE_NOT_SCALAR'],
    ['a page list as a text', { ...SENT, holders: 'u-1' }, 'BODY_VALUE_TYPE_MISMATCH'],
    ['an array key that is not approved', { ...SENT, extra: ['x'] }, 'BODY_VALUE_NOT_SCALAR'],
    ['a missing array key', { title: TITLE_VALUE, labels: [LABEL_VALUE], holders: ['u-1'] }, 'BODY_KEY_MISSING'],
  ])('does not send %s', (_name, body, decision) => {
    const result = checkApiWritePayload(expectationOf(), factsOf(body));
    expect(result).toEqual({ decision });
    expect(JSON.stringify(result)).not.toContain(LABEL_VALUE);
  });

  // L13 fix round 1: ページが決める一覧の数と文字の長さに上限を置かない（前は 21 個の期待と 201 文字の要素を止めた）。数が承認と違えば今どおり止める。
  it('sends a page list of 21 elements and a long text when the count matches the approval, and stops another count', () => {
    const wide = expectationOf({ spec: checkSpec({ pageKeys: [...checkSpec().pageKeys.filter(({ key }) => key !== 'holders'),
      { key: 'holders', type: 'array', elements: { types: ['string'], count: 21 } }] }) });
    const holders = ['x'.repeat(201), ...Array.from({ length: 20 }, (_, index) => `u-${String(index)}`)];
    expect(checkApiWritePayload(wide, factsOf({ ...SENT, holders })).decision).toBe('ALLOW');
    expect(checkApiWritePayload(wide, factsOf({ ...SENT, holders: holders.slice(0, 20) }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
    expect(checkApiWritePayload(expectationOf(), factsOf({ ...SENT, holders: ['x'.repeat(201)] })).decision).toBe('ALLOW');
  });

  it('does not send a scalar key whose value is an array (as before)', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf({ ...SENT, title: [TITLE_VALUE] }))).toEqual({ decision: 'BODY_VALUE_NOT_SCALAR' });
  });

  it.each<readonly [string, ApiWritePayloadExpectation]>([
    ['a page array key without the elements', expectationOf({ spec: checkSpec({ pageKeys: [{ key: 'holders', type: 'array' }] }) })],
    ['a page array key with nested element types', expectationOf({ spec: checkSpec({ pageKeys: [{ key: 'holders', type: 'array', elements: { types: ['object'], count: 1 } }] }) })],
    ['a scalar page key with the elements', expectationOf({ spec: checkSpec({ pageKeys: [{ key: 'holders', type: 'string', elements: { types: [], count: 0 } }] }) })],
    ['an object page key', expectationOf({ spec: checkSpec({ pageKeys: [{ key: 'holders', type: 'object' }] }) })],
    ['an array key of an UPDATE', expectationOf({
      spec: checkSpec({ request: { ...checkSpec().request, method: 'PATCH' }, filterName: 'id', pageKeys: [] }),
      recordId: '1',
    })],
  ])('treats %s as an invalid expectation', (_name, expectation) => {
    expect(checkApiWritePayload(expectation, factsOf(SENT))).toEqual({ decision: 'EXPECTATION_INVALID' });
  });
});

describe('ARR-2: the record of the page array keys and the type of a generated value', () => {
  it('records the value of a page array key as its JSON text', () => {
    const spec = {
      request: { method: 'POST', origin: API, pathShape: API_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
      shapeDigest: `sha256:${'a'.repeat(64)}`,
      keyFields: [{ key: 'labels', type: 'array', field: { kind: 'NAME', name: 'label' }, fieldType: 'text' }],
      pageKeys: [{ key: 'holders', type: 'array', elements: { types: ['string'], count: 1 } }, { key: 'makers', type: 'array', elements: { types: [], count: 0 } }],
      headerNames: [], filterName: null, recordId: null, ledger: null,
    } as unknown as ScenarioApiSpec;
    expect(actionApiSummaryOf(spec, { holders: ['u-1'], makers: [] }).pageKeyValues).toEqual({ holders: '["u-1"]', makers: '[]' });
  });

  it('makes a generated value of a field array key a text (the element type)', () => {
    expect(apiKeyFieldValueTypeOf('array')).toBe('string');
    expect(apiKeyFieldValueTypeOf('number')).toBe('number');
    expect(isJsonValueConvertible(LABEL_VALUE, apiKeyFieldValueTypeOf('array'))).toBe(true);
  });
});
