// ARR-3（DEF-234 の段 A1。設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.1・2.2・2.5）: 入力の行がいくつもある登録の画面の、一覧の位置ごとの欄の
// 対応（欄 1 つと空の位置）と、印が 2 つ以上の一覧の穴を閉じることを、純粋な部品を表で確かめる。
// - 道 `key[i]` の部品（1 か所）。
// - 型の記録: 一覧の中に印があり要素が 2 以上の鍵だけ、位置ごとの「印の番号・空の値か・型」を持つ（値は残さない。I22）。
// - 対応と承認: 印が 1 つの一覧は、印の位置を欄に、ほかの空の位置を「空の位置」として受ける。空でない値が混ざる形は今のまま数の違いで拒む。印が 2 つ以上の
//   一覧は、ページが決める一覧として受けず、新しい理由で拒む。
// - 送る前の照合: 位置ごとの完全一致・空の位置の一致・要素の数。足す・減らす・順・別の値・空の位置を埋める・入れ子は送らない。
// - digest: 一覧のない型と DEF-226 の形（要素 1）の digest は、ARR-3 の前の値のまま（固定の値）。位置の情報があれば digest が変わる。
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import { apiScenarioFormOf } from '../../src/control/approval/api-scenario-draft.js';
import { apiKeyFieldsDigestOf, scenarioApiKeyFieldsOfProbe, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import {
  apiArrayElementPathOf,
  apiArrayElementPathPartsOf,
  apiRequestShapeOf,
  type ApiRequestShape,
} from '../../src/core/api-request-shape.js';
import { SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../src/presentation/messages.js';
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

/** 新しい拒みの理由（印が 2 つ以上の一覧。段 A2 まで対応できない形）。 */
const MULTIPLE_FIELDS_REASON = 'SCENARIO_API_ARRAY_MULTIPLE_FIELDS';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b', 'bsprobe00000000000c', 'bsprobe00000000000d'];
const NEW_PATH = '/admin/records/new';
/** 題の欄と、資格の行の欄 2 つと、免許の行の欄。 */
const TITLE_FIELD: SubmissionProbeInputField = { name: 'title', selector: '#title', type: 'text', marker: 0 };
const QUAL_0: SubmissionProbeInputField = { name: 'qual-0', selector: '#qual-0', type: 'text', marker: 1 };
const QUAL_1: SubmissionProbeInputField = { name: 'qual-1', selector: '#qual-1', type: 'text', marker: 2 };
const LIC_0: SubmissionProbeInputField = { name: 'lic-0', selector: '#lic-0', type: 'text', marker: 3 };
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, QUAL_0, LIC_0];
/** 実環境の形 1 の一般の形（行の欄の後ろに空の行）。 */
const ROWS_BODY = { title: MARKERS[0], quals: [MARKERS[1], ''], licenses: [MARKERS[3], ''] };
/** DEF-226 の形（欄の文字 1 つの一覧と、ページが決める一覧）。 */
const DEF226_BODY = { title: MARKERS[0], labels: [MARKERS[1]], holders: ['u-1'], makers: [] };
const DEF226_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, { name: 'label', selector: '#label', type: 'text', marker: 1 }];
const DIGEST_FACTS = { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST } as const;

const shapeOf = (body: unknown): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url: `${API}/rest/v1/records?select=*`,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath: NEW_PATH, markers: MARKERS });

const probeOf = (shape: ApiRequestShape, inputFields: readonly SubmissionProbeInputField[] = INPUT_FIELDS): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields);

const buttonOf = (probe: SubmissionProbeRecord): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});
const createButtonOf = (body: unknown, inputFields: readonly SubmissionProbeInputField[] = INPUT_FIELDS): DiscoveryCandidate =>
  buttonOf(probeOf(shapeOf(body), inputFields));

const CONTEXT: ScenarioDraftContext = {
  scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 },
};
const draftOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames: [...fieldNames],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest, pageKeys: [...pageKeys], filterName: null, recordId: null, ledger: null },
});
const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): ScenarioDraftValidationResult =>
  validateScenarioDraft(draftOf(candidate, fieldNames, pageKeys), candidate, [], CONTEXT);
const keyOf = (shape: ApiRequestShape, name: string) => shape.body.keys.find((key) => key.name === name);

describe('ARR-3: the path of a list element', () => {
  it('makes and reads the path key[i] in one place', () => {
    expect(apiArrayElementPathOf('quals', 0)).toBe('quals[0]');
    expect(apiArrayElementPathOf('quals', 12)).toBe('quals[12]');
    expect(apiArrayElementPathPartsOf('quals[1]')).toEqual({ key: 'quals', index: 1 });
    expect(apiArrayElementPathPartsOf(apiArrayElementPathOf('a[b]', 3))).toEqual({ key: 'a[b]', index: 3 });
    // ARR-5（`arr-5-array-object-rows.test.ts`）: 道を `key[i].name` へ広げた（`quals[1].name` は読める）。
    expect(apiArrayElementPathPartsOf('quals[1].name')).toEqual({ key: 'quals', index: 1, name: 'name' });
    for (const text of ['quals', 'quals[]', 'quals[-1]', 'quals[01]', 'quals[1', '[1]', 'quals[1].', 'quals[x]']) {
      expect(apiArrayElementPathPartsOf(text)).toBeNull();
    }
  });
});

describe('ARR-3: the record of the positions of a list with a marker', () => {
  it('records the marker numbers, the empty values and the types of each position, without a value', () => {
    const shape = shapeOf({ ...ROWS_BODY, quals: [MARKERS[1], ''], licenses: [null, MARKERS[3], 'u-1'] });
    expect(keyOf(shape, 'quals')?.elements?.positions).toEqual([
      { markers: [1], empty: false, type: 'string' },
      { markers: [], empty: true, type: 'string' },
    ]);
    expect(keyOf(shape, 'licenses')?.elements?.positions).toEqual([
      { markers: [], empty: true, type: 'null' },
      { markers: [3], empty: false, type: 'string' },
      { markers: [], empty: false, type: 'string' },
    ]);
    const text = JSON.stringify(shape);
    expect(MARKERS.some((marker) => text.includes(marker))).toBe(false);
    expect(text).not.toContain('u-1');
  });

  it('records two markers of a list at their positions', () => {
    const shape = shapeOf({ title: MARKERS[0], quals: [MARKERS[1], MARKERS[2]] });
    expect(keyOf(shape, 'quals')?.elements?.positions).toEqual([
      { markers: [1], empty: false, type: 'string' },
      { markers: [2], empty: false, type: 'string' },
    ]);
  });

  it('does not record the positions of a list of one element (the DEF-226 form) or of a list without a marker', () => {
    const def226 = shapeOf(DEF226_BODY);
    expect(keyOf(def226, 'labels')?.elements).toEqual({ types: ['string'], count: 1, nested: false, textOverLimit: false });
    expect(keyOf(def226, 'holders')?.elements).toEqual({ types: ['string'], count: 1, nested: false, textOverLimit: false });
    expect(keyOf(shapeOf({ title: MARKERS[0], holders: ['u-1', 'u-2'] }), 'holders')?.elements?.positions).toBeUndefined();
  });

  it('passes the schema of a candidate with the positions', () => {
    const candidate = createButtonOf(ROWS_BODY);
    expect(validateControlDocument('candidate', candidate).ok).toBe(true);
  });
});

describe('ARR-3: the field of a list and the empty positions in the approval', () => {
  it('accepts a list with one field and empty positions, and keeps the positions in the key of the field (no value)', () => {
    const result = validate(createButtonOf(ROWS_BODY), ['licenses', 'quals', 'title']);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keyFields).toEqual([
      { key: 'licenses', type: 'array', field: { kind: 'NAME', name: 'lic-0' }, fieldType: 'text', positions: ['FIELD', 'EMPTY_STRING'] },
      { key: 'quals', type: 'array', field: { kind: 'NAME', name: 'qual-0' }, fieldType: 'text', positions: ['FIELD', 'EMPTY_STRING'] },
      { key: 'title', type: 'string', field: { kind: 'NAME', name: 'title' }, fieldType: 'text' },
    ]);
    expect(MARKERS.some((marker) => JSON.stringify(result.content).includes(marker))).toBe(false);
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
    // 索引の鍵と欄の対応（probe から作る）も、同じ位置を持つ。
    expect(scenarioApiKeyFieldsOfProbe(probeOf(shapeOf(ROWS_BODY))).find(({ key }) => key === 'quals')?.positions).toEqual(['FIELD', 'EMPTY_STRING']);
  });

  it('accepts a null empty position and an empty position before the field', () => {
    const nulled = validate(createButtonOf({ ...ROWS_BODY, quals: [MARKERS[1], null] }), ['licenses', 'quals', 'title']);
    expect(codesOf(nulled)).toEqual([]);
    expect(nulled.ok ? nulled.content.api?.keyFields.find(({ key }) => key === 'quals')?.positions : null).toEqual(['FIELD', 'EMPTY_NULL']);
    const before = validate(createButtonOf({ ...ROWS_BODY, quals: ['', '', MARKERS[1]] }), ['licenses', 'quals', 'title']);
    expect(codesOf(before)).toEqual([]);
    expect(before.ok ? before.content.api?.keyFields.find(({ key }) => key === 'quals')?.positions : null).toEqual(['EMPTY_STRING', 'EMPTY_STRING', 'FIELD']);
  });

  it('keeps the key of the field of a list of one element without positions (the DEF-226 form)', () => {
    const result = validate(createButtonOf(DEF226_BODY, DEF226_FIELDS), ['labels', 'title'], ['holders', 'makers']);
    expect(codesOf(result)).toEqual([]);
    expect(result.ok ? result.content.api?.keyFields.find(({ key }) => key === 'labels') : null)
      .toEqual({ key: 'labels', type: 'array', field: { kind: 'NAME', name: 'label' }, fieldType: 'text' });
  });

  it.each<readonly [string, unknown, string]>([
    ['a value decided by the page mixed into the list of a field', [MARKERS[1], 'u-1'], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a number mixed into the list of a field', [MARKERS[1], 0], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a false mixed into the list of a field', [MARKERS[1], false], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a list in the list of a field', [MARKERS[1], ['']], 'SCENARIO_API_ARRAY_NESTED'],
  ])('rejects %s', (_name, quals, reason) => {
    const result = validate(createButtonOf({ ...ROWS_BODY, quals }), ['licenses', 'quals', 'title']);
    expect(codesOf(result)).toEqual([reason]);
    expect(result.ok ? null : result.errors[0]?.fieldName).toBe('quals');
  });

  it('closes the hole: a list with two markers is not accepted as a list decided by the page', () => {
    const body = { title: MARKERS[0], quals: [MARKERS[1], MARKERS[2]] };
    const fields = [TITLE_FIELD, QUAL_0, QUAL_1];
    // ARR-4（`arr-4-array-fields.test.ts`）で、この形は位置ごとの欄の鍵（道 `key[i]`）に分けて受けるようにした。ページが決める一覧の鍵 `quals` は、もう
    // 本文の欄のない鍵として選べない（ページが決める一覧として受けないことは変わらない）。
    const codes = codesOf(validate(createButtonOf(body, fields), ['title'], ['quals']));
    expect(codes).toContain('SCENARIO_API_KEY_NOT_ALLOWED');
    expect(codes).not.toContain(MULTIPLE_FIELDS_REASON);
    const { form, rejection } = apiScenarioFormOf({ profileId: PROFILE_ID, candidate: createButtonOf(body, fields), context: CONTEXT, scenarios: [] });
    expect(rejection).toBeNull();
    expect(form?.pageKeys).toEqual([]);
    expect(form?.keyFields.map(({ key }) => key)).toEqual(['quals[0]', 'quals[1]', 'title']);
  });

  it('closes the hole for two markers in one element too', () => {
    const body = { title: MARKERS[0], quals: [`${String(MARKERS[1])} ${String(MARKERS[2])}`] };
    expect(codesOf(validate(createButtonOf(body, [TITLE_FIELD, QUAL_0, QUAL_1]), ['title'], ['quals']))).toEqual([MULTIPLE_FIELDS_REASON]);
  });

  it('registers the new reason in the closed list and the display catalog', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toContain(MULTIPLE_FIELDS_REASON);
    expect(Object.hasOwn(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS, MULTIPLE_FIELDS_REASON)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------------------------------------------

const API_PATH = '/rest/v1/records';
const QUAL_VALUE = '資格 一';
const TITLE_VALUE = '題 一';
const checkSpec = (overrides: Partial<ApiWriteCheckSpec> = {}): ApiWriteCheckSpec => ({
  request: { method: 'POST', origin: API, pathShape: API_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
  keyFields: [{ key: 'quals', type: 'array', positions: ['FIELD', 'EMPTY_STRING'] }, { key: 'title', type: 'string' }],
  pageKeys: [],
  headerNames: ['content-type'],
  filterName: null,
  ...overrides,
});
const expectationOf = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: checkSpec(),
  values: { quals: QUAL_VALUE, title: TITLE_VALUE },
  recordId: null,
  ...overrides,
});
const factsOf = (body: unknown): ApiWriteRequestFacts => ({
  method: 'POST',
  url: `${API}${API_PATH}`,
  headers: { 'Content-Type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});
const SENT = { title: TITLE_VALUE, quals: [QUAL_VALUE, ''] };

describe('ARR-3: the check of the positions of a list before the send', () => {
  it('allows the list with the generated value at the field and the approved empty value at the empty position', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf(SENT))).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    const nulled = expectationOf({ spec: checkSpec({ keyFields: [{ key: 'quals', type: 'array', positions: ['EMPTY_NULL', 'FIELD'] }, { key: 'title', type: 'string' }] }) });
    expect(checkApiWritePayload(nulled, factsOf({ ...SENT, quals: [null, QUAL_VALUE] })).decision).toBe('ALLOW');
  });

  it.each<readonly [string, unknown, string]>([
    ['an element added', [QUAL_VALUE, '', ''], 'BODY_VALUE_MISMATCH'],
    ['the value of the field added again', [QUAL_VALUE, '', QUAL_VALUE], 'BODY_VALUE_MISMATCH'],
    ['an element removed', [QUAL_VALUE], 'BODY_VALUE_MISMATCH'],
    ['the order changed', ['', QUAL_VALUE], 'BODY_VALUE_MISMATCH'],
    ['another value at the field', ['other-value', ''], 'BODY_VALUE_MISMATCH'],
    ['the empty position filled by the page', [QUAL_VALUE, 'filled-by-page'], 'BODY_VALUE_MISMATCH'],
    ['null at an empty text position', [QUAL_VALUE, null], 'BODY_VALUE_MISMATCH'],
    ['the value of the field at the empty position', [QUAL_VALUE, QUAL_VALUE], 'BODY_VALUE_MISMATCH'],
    ['a nested field', [[QUAL_VALUE], ''], 'BODY_VALUE_NOT_SCALAR'],
    ['a nested empty position', [QUAL_VALUE, ['']], 'BODY_VALUE_NOT_SCALAR'],
    ['an object at the empty position', [QUAL_VALUE, {}], 'BODY_VALUE_NOT_SCALAR'],
  ])('does not send the list with %s', (_name, quals, decision) => {
    const result = checkApiWritePayload(expectationOf(), factsOf({ ...SENT, quals }));
    expect(result).toEqual({ decision });
    expect(JSON.stringify(result)).not.toContain(QUAL_VALUE);
  });

  // L13 fix round 1: 位置の数に上限を置かない（前は 21 個からを期待の誤りにした）。数が承認と違う一覧は、今どおり止める。
  it('allows a list of 21 positions that matches the approval, and stops a list of another count', () => {
    const positions = ['FIELD', ...Array.from({ length: 20 }, () => 'EMPTY_STRING' as const)] as const;
    const expectation = expectationOf({ spec: checkSpec({ keyFields: [{ key: 'quals', type: 'array', positions: [...positions] }, { key: 'title', type: 'string' }] }) });
    const quals = [QUAL_VALUE, ...Array.from({ length: 20 }, () => '')];
    expect(checkApiWritePayload(expectation, factsOf({ ...SENT, quals })).decision).toBe('ALLOW');
    expect(checkApiWritePayload(expectation, factsOf({ ...SENT, quals: quals.slice(0, 20) }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
    expect(checkApiWritePayload(expectation, factsOf({ ...SENT, quals: [...quals, ''] }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
  });

  it('keeps the check of the list of one element without positions (the DEF-226 form)', () => {
    const spec = checkSpec({ keyFields: [{ key: 'quals', type: 'array' }, { key: 'title', type: 'string' }] });
    expect(checkApiWritePayload(expectationOf({ spec }), factsOf({ ...SENT, quals: [QUAL_VALUE] })).decision).toBe('ALLOW');
    expect(checkApiWritePayload(expectationOf({ spec }), factsOf(SENT))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
  });

  it.each<readonly [string, unknown]>([
    ['positions on a text key', [{ key: 'quals', type: 'array', positions: ['FIELD', 'EMPTY_STRING'] }, { key: 'title', type: 'string', positions: ['FIELD', 'EMPTY_STRING'] }]],
    ['positions without the field', [{ key: 'quals', type: 'array', positions: ['EMPTY_STRING', 'EMPTY_STRING'] }, { key: 'title', type: 'string' }]],
    ['positions with two fields', [{ key: 'quals', type: 'array', positions: ['FIELD', 'FIELD'] }, { key: 'title', type: 'string' }]],
    ['a position of an unknown kind', [{ key: 'quals', type: 'array', positions: ['FIELD', 'PAGE'] }, { key: 'title', type: 'string' }]],
    ['positions of one element', [{ key: 'quals', type: 'array', positions: ['FIELD'] }, { key: 'title', type: 'string' }]],
    ['positions that are not a list', [{ key: 'quals', type: 'array', positions: 'FIELD' }, { key: 'title', type: 'string' }]],
  ])('treats %s as an invalid expectation', (_name, keyFields) => {
    const expectation = expectationOf({ spec: checkSpec({ keyFields: keyFields as ApiWriteCheckSpec['keyFields'] }) });
    expect(checkApiWritePayload(expectation, factsOf(SENT))).toEqual({ decision: 'EXPECTATION_INVALID' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------------------------

/** ARR-3 の前の実装で計算した値（一覧のない型、DEF-226 の形の型・鍵と欄の対応・承認の digest）。 */
const PLAIN_SHAPE_DIGEST = 'sha256:339d70537bd15192fbf7f67a616a5be60dc8138caa8aa70a255bcff3959ef6c9';
const DEF226_SHAPE_DIGEST = 'sha256:24e0afc2a06ce69beeacf2d7ab2af17bb57e7ca5b541379c0c94c577233d27b6';
const DEF226_KEY_FIELDS_DIGEST = 'sha256:67ad19ec6bf05f0ea371b64b13c07bb2f54a91909761a6f66e5f7d32ff2768ae';
const DEF226_APPROVAL_DIGEST = 'sha256:ad998f885bf684346c21f2222e33ee4c4699059f51f5c744c398a6c6885b2b7b';

describe('ARR-3: the digests', () => {
  const scenarioOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): ScenarioRevision => {
    const result = validate(candidate, fieldNames, pageKeys);
    if (!result.ok) throw new Error(codesOf(result).join(','));
    return { ...sampleScenario(), ...result.content, inputRuleReference: INPUT_RULES } as ScenarioRevision;
  };

  it('keeps the digests of a shape without a list and of the DEF-226 form (the values before ARR-3)', () => {
    expect(apiShapeDigestOf(shapeOf({ title: MARKERS[0], label: MARKERS[1], tenant_id: 'tenant-1' }))).toBe(PLAIN_SHAPE_DIGEST);
    const def226 = probeOf(shapeOf(DEF226_BODY), DEF226_FIELDS);
    expect(def226.shapeDigest).toBe(DEF226_SHAPE_DIGEST);
    expect(apiKeyFieldsDigestOf(def226.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(def226))).toBe(DEF226_KEY_FIELDS_DIGEST);
    expect(computeApprovalDigest(scenarioOf(buttonOf(def226), ['labels', 'title'], ['holders', 'makers']), DIGEST_FACTS)).toBe(DEF226_APPROVAL_DIGEST);
  });

  it('changes the digests when the positions change', () => {
    const trailing = probeOf(shapeOf(ROWS_BODY));
    const nulled = probeOf(shapeOf({ ...ROWS_BODY, quals: [MARKERS[1], null] }));
    const leading = probeOf(shapeOf({ ...ROWS_BODY, quals: ['', MARKERS[1]] }));
    expect(new Set([trailing.shapeDigest, nulled.shapeDigest, leading.shapeDigest]).size).toBe(3);
    const fields = ['licenses', 'quals', 'title'];
    const digests = [trailing, nulled, leading].map((probe) => computeApprovalDigest(scenarioOf(buttonOf(probe), fields), DIGEST_FACTS));
    expect(new Set(digests).size).toBe(3);
    const keyFieldDigests = [trailing, nulled, leading].map((probe) => apiKeyFieldsDigestOf(trailing.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(probe)));
    expect(new Set(keyFieldDigests).size).toBe(3);
  });
});
