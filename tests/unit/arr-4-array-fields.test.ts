// ARR-4（DEF-234 の段 A2。設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.3）: 1 つの一覧の鍵に欄の印が 2 つ以上ある形を、位置ごとに欄へ対応づけて
// 受けることを、純粋な部品を表で確かめる。
// - 対応: 印の位置ごとに、道 `key[i]`（ARR-3 の部品）の鍵として欄に対応づける（要素の鍵 `element` と、一覧の全体の位置の役 `positions` を持つ）。
// - 承認: 受ける形（欄 2 つ・欄 4 つと空の位置）と、拒む形（1 つの欄が 2 つの鍵に入る・同じ印が 2 つの位置に入る・1 つの位置に印が 2 つ・空でない値が混ざる・
//   道が本文の鍵と重なる・欄の位置の一部だけ送る）。
// - データの規則: 欄ごと（道ごと）に値ができる。
// - 送る前の照合: ARR-3 の位置ごとの完全一致（欄の位置が 2 つ以上）。足す・減らす・順・欄の位置の入れ替え・別の値・空の位置を埋める・入れ子は送らない。
// - digest: 一覧のない型・DEF-226 の形・ARR-3 の形（欄 1 つと空の位置）の digest は、ARR-4 の前の値のまま（固定の値）。
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import { apiScenarioFormOf } from '../../src/control/approval/api-scenario-draft.js';
import { apiKeyFieldsDigestOf, scenarioApiKeyFieldsOfProbe, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft, type ScenarioDraftContext, type ScenarioDraftValidationResult } from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  observedSubmissionProbeOf,
  submissionProbeKeyFieldsOf,
  type SubmissionProbeInputField,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import {
  checkApiWritePayload,
  type ApiWriteCheckSpec,
  type ApiWritePayloadExpectation,
  type ApiWriteRequestFacts,
} from '../../src/safety/api-write-payload-policy.js';
import { ALL_CONFIRMED, AUTH_SETUP_DIGEST, INPUT_RULES, PROFILE_ID, TARGET_CONFIG_DIGEST, candidateOf, sampleScenario } from './approval-samples.js';
import { BASE_DATE, ruleSetFor, seedInputFor } from './data-rule-scenario-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const MULTIPLE_FIELDS_REASON = 'SCENARIO_API_ARRAY_MULTIPLE_FIELDS';
const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b', 'bsprobe00000000000c', 'bsprobe00000000000d', 'bsprobe00000000000e'];
const NEW_PATH = '/admin/records/new';
const fieldOf = (name: string, marker: number): SubmissionProbeInputField => ({ name, selector: `#${name}`, type: 'text', marker });
const TITLE_FIELD = fieldOf('title', 0);
/** 資格の行の欄 2 つ（twoBoth）と、得意の行の欄 4 つ（four）。 */
const TWO_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('qual-0', 1), fieldOf('qual-1', 2)];
const FOUR_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('sk-0', 1), fieldOf('sk-1', 2), fieldOf('sk-2', 3), fieldOf('sk-3', 4)];
const TWO_BODY = { title: MARKERS[0], quals: [MARKERS[1], MARKERS[2]] };
const FOUR_BODY = { title: MARKERS[0], skills: [MARKERS[1], MARKERS[2], MARKERS[3], MARKERS[4], ''] };
/** ARR-3 の形（欄 1 つと空の位置）。 */
const ROWS_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('qual-0', 1), fieldOf('lic-0', 3)];
const ROWS_BODY = { title: MARKERS[0], quals: [MARKERS[1], ''], licenses: [MARKERS[3], ''] };
const DIGEST_FACTS = { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST } as const;

const shapeOf = (body: unknown): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url: `${API}/rest/v1/records?select=*`,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath: NEW_PATH, markers: MARKERS });
const probeOf = (body: unknown, inputFields: readonly SubmissionProbeInputField[]): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shapeOf(body)], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields);
const buttonOf = (probe: SubmissionProbeRecord): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});
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
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest, pageKeys: [...pageKeys], filterName: null, recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, ledger: null },
});
const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): ScenarioDraftValidationResult =>
  validateScenarioDraft(draftOf(candidate, fieldNames, pageKeys), candidate, [], CONTEXT);
const scenarioOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): ScenarioRevision => {
  const result = validate(candidate, fieldNames, pageKeys);
  if (!result.ok) throw new Error(codesOf(result).join(','));
  return { ...sampleScenario(), ...result.content, inputRuleReference: INPUT_RULES } as ScenarioRevision;
};
const TWO_KEYS = ['quals[0]', 'quals[1]', 'title'];
const FOUR_KEYS = ['skills[0]', 'skills[1]', 'skills[2]', 'skills[3]', 'title'];

describe('ARR-4: the fields of the positions of a list', () => {
  it('maps each marked position of a list to its field with the path key[i]', () => {
    expect(submissionProbeKeyFieldsOf(probeOf(TWO_BODY, TWO_FIELDS)).map(({ key, type, field, element }) => [key, type, field?.name ?? null, element ?? null])).toEqual([
      ['quals[0]', 'array', 'qual-0', { key: 'quals', index: 0 }],
      ['quals[1]', 'array', 'qual-1', { key: 'quals', index: 1 }],
      ['title', 'string', 'title', null],
    ]);
  });

  it('keeps one key for a list of one field (the ARR-3 and DEF-226 forms)', () => {
    expect(submissionProbeKeyFieldsOf(probeOf(ROWS_BODY, ROWS_FIELDS)).map(({ key, element }) => [key, element ?? null]))
      .toEqual([['licenses', null], ['quals', null], ['title', null]]);
  });

  it.each<readonly [string, unknown, readonly SubmissionProbeInputField[]]>([
    ['two markers in one element', { title: MARKERS[0], quals: [`${String(MARKERS[1])} ${String(MARKERS[2])}`, ''] }, TWO_FIELDS],
    ['a path that is a key of the body too', { ...TWO_BODY, 'quals[0]': 'x' }, TWO_FIELDS],
  ])('does not map the positions of %s (one key without a field, as before)', (_name, body, fields) => {
    const keyFields = submissionProbeKeyFieldsOf(probeOf(body, fields));
    expect(keyFields.some(({ element }) => element !== undefined)).toBe(false);
  });

  // L13（N25）: 道の長さでは分けるのをやめない（前は 64 文字を超える道を分けなかった）。
  it('maps the positions of a list with a long key name', () => {
    const name = 'q'.repeat(62);
    const keyFields = submissionProbeKeyFieldsOf(probeOf({ title: MARKERS[0], [name]: [MARKERS[1], MARKERS[2]] }, TWO_FIELDS));
    expect(keyFields.filter(({ element }) => element !== undefined).map(({ key }) => key)).toEqual([`${name}[0]`, `${name}[1]`]);
  });
});

describe('ARR-4: the approval of a list with two or more fields', () => {
  it('accepts a list of two fields with the field and the roles of each position (no value)', () => {
    const result = validate(buttonOf(probeOf(TWO_BODY, TWO_FIELDS)), TWO_KEYS);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keyFields).toEqual([
      { key: 'quals[0]', type: 'array', field: { kind: 'NAME', name: 'qual-0' }, fieldType: 'text', element: { key: 'quals', index: 0 }, positions: ['FIELD', 'FIELD'] },
      { key: 'quals[1]', type: 'array', field: { kind: 'NAME', name: 'qual-1' }, fieldType: 'text', element: { key: 'quals', index: 1 }, positions: ['FIELD', 'FIELD'] },
      { key: 'title', type: 'string', field: { kind: 'NAME', name: 'title' }, fieldType: 'text' },
    ]);
    expect(result.content.api?.pageKeys).toEqual([]);
    expect(MARKERS.some((marker) => JSON.stringify(result.content).includes(marker))).toBe(false);
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('accepts a list of four fields and an empty position', () => {
    const result = validate(buttonOf(probeOf(FOUR_BODY, FOUR_FIELDS)), FOUR_KEYS);
    expect(codesOf(result)).toEqual([]);
    expect(result.ok ? result.content.api?.keyFields.filter(({ element }) => element !== undefined).map(({ key, positions }) => [key, positions]) : null)
      .toEqual([0, 1, 2, 3].map((index) => [`skills[${String(index)}]`, ['FIELD', 'FIELD', 'FIELD', 'FIELD', 'EMPTY_STRING']]));
  });

  it('proposes the path keys in the form of the draft (the automatic draft uses it)', () => {
    const { form, rejection } = apiScenarioFormOf({ profileId: PROFILE_ID, candidate: buttonOf(probeOf(TWO_BODY, TWO_FIELDS)), context: CONTEXT, scenarios: [] });
    expect(rejection).toBeNull();
    expect(form?.keyFields.map(({ key, rejection: blocked }) => [key, blocked])).toEqual(TWO_KEYS.map((key) => [key, null]));
    expect(form?.pageKeys).toEqual([]);
  });

  it.each<readonly [string, unknown, readonly SubmissionProbeInputField[], readonly string[], readonly string[], string]>([
    ['one field in two keys', { ...TWO_BODY, copy: MARKERS[1] }, TWO_FIELDS, ['copy', ...TWO_KEYS], [], 'SCENARIO_API_FIELD_KEY_MISMATCH'],
    ['one marker at two positions', { title: MARKERS[0], quals: [MARKERS[1], MARKERS[1]] }, TWO_FIELDS, ['quals', 'title'], [], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a value of the page mixed into the list of the fields', { ...TWO_BODY, quals: [MARKERS[1], MARKERS[2], 'u-1'] }, TWO_FIELDS, TWO_KEYS, [], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a number at a field position', { ...TWO_BODY, quals: [MARKERS[1], Number('7')] }, TWO_FIELDS, TWO_KEYS, [], 'SCENARIO_API_FIELD_KEY_MISMATCH'],
    ['two markers in one element', { title: MARKERS[0], quals: [`${String(MARKERS[1])} ${String(MARKERS[2])}`] }, TWO_FIELDS, ['title'], ['quals'], MULTIPLE_FIELDS_REASON],
    ['only one of the positions sent', TWO_BODY, TWO_FIELDS, ['quals[0]', 'title'], [], 'SCENARIO_API_FIELD_KEY_MISMATCH'],
  ])('rejects %s', (_name, body, fields, fieldNames, pageKeys, reason) => {
    expect(codesOf(validate(buttonOf(probeOf(body, fields)), fieldNames, pageKeys))).toContain(reason);
  });

  it('makes a value for each field of the list by the data rules', () => {
    const scenario = scenarioOf(buttonOf(probeOf(TWO_BODY, TWO_FIELDS)), TWO_KEYS);
    const candidate = buttonOf(probeOf(TWO_BODY, TWO_FIELDS));
    // 推した規則（自動の作成と同じ部品）。
    const inferred = inferRuleSetContent(scenario, candidate);
    expect(inferred.content.fieldRules.map(({ fieldName }) => fieldName).sort()).toEqual(TWO_KEYS);
    const ruleSet = ruleSetFor(scenario, inferred.content.fieldRules);
    const generated = generateScenarioData({
      ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(Object.keys(generated.values).sort()).toEqual(TWO_KEYS);
    expect(typeof generated.values['quals[0]']).toBe('string');
    expect(typeof generated.values['quals[1]']).toBe('string');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------------------------------------------

const API_PATH = '/rest/v1/records';
const FIRST = '資格 一';
const SECOND = '資格 二';
const TITLE_VALUE = '題 一';
type CheckKeyField = ApiWriteCheckSpec['keyFields'][number];
const ROLES = ['FIELD', 'FIELD', 'EMPTY_STRING'] as const;
const elementField = (index: number, positions: readonly string[] = ROLES, key = 'quals'): CheckKeyField =>
  ({ key: `${key}[${String(index)}]`, type: 'array', element: { key, index }, positions } as unknown as CheckKeyField);
const TITLE_KEY: CheckKeyField = { key: 'title', type: 'string' };
const checkSpec = (keyFields: readonly CheckKeyField[] = [elementField(0), elementField(1), TITLE_KEY], pageKeys: ApiWriteCheckSpec['pageKeys'] = []): ApiWriteCheckSpec => ({
  request: { method: 'POST', origin: API, pathShape: API_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
  keyFields,
  pageKeys,
  headerNames: ['content-type'],
  filterName: null,
});
const VALUES = { 'quals[0]': FIRST, 'quals[1]': SECOND, title: TITLE_VALUE };
const expectationOf = (spec: ApiWriteCheckSpec = checkSpec(), values: Readonly<Record<string, string | null>> = VALUES): ApiWritePayloadExpectation =>
  ({ spec, values, recordId: null });
const factsOf = (body: unknown): ApiWriteRequestFacts => ({
  method: 'POST', url: `${API}${API_PATH}`, headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)),
});
const SENT = { title: TITLE_VALUE, quals: [FIRST, SECOND, ''] };

describe('ARR-4: the check of a list with two or more fields before the send', () => {
  it('allows the list with the generated value of each field at its position', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf(SENT))).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
  });

  it.each<readonly [string, unknown, string]>([
    ['an element added', [FIRST, SECOND, '', ''], 'BODY_VALUE_MISMATCH'],
    ['an element removed', [FIRST, SECOND], 'BODY_VALUE_MISMATCH'],
    ['the fields swapped', [SECOND, FIRST, ''], 'BODY_VALUE_MISMATCH'],
    ['the order reversed', ['', SECOND, FIRST], 'BODY_VALUE_MISMATCH'],
    ['another value at a field', [FIRST, 'other-value', ''], 'BODY_VALUE_MISMATCH'],
    ['the same value at both fields', [FIRST, FIRST, ''], 'BODY_VALUE_MISMATCH'],
    ['the empty position filled', [FIRST, SECOND, 'filled-by-page'], 'BODY_VALUE_MISMATCH'],
    ['a nested field', [[FIRST], SECOND, ''], 'BODY_VALUE_NOT_SCALAR'],
  ])('does not send the list with %s', (_name, quals, decision) => {
    const result = checkApiWritePayload(expectationOf(), factsOf({ ...SENT, quals }));
    expect(result).toEqual({ decision });
    expect(JSON.stringify(result)).not.toContain(FIRST);
  });

  it('does not send the path keys as keys of the body', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf({ ...SENT, 'quals[0]': FIRST }))).toEqual({ decision: 'BODY_KEY_UNEXPECTED' });
  });

  it.each<readonly [string, ApiWritePayloadExpectation]>([
    ['a path that is not the path of its element', expectationOf(checkSpec([{ ...elementField(0), key: 'quals[1]' } as CheckKeyField, elementField(1), TITLE_KEY]))],
    ['an element at a position that is not a field', expectationOf(checkSpec([elementField(0), elementField(2), TITLE_KEY]), { ...VALUES, 'quals[2]': SECOND })],
    ['a field position without its key', expectationOf(checkSpec([elementField(0), TITLE_KEY]))],
    ['the roles that differ between the keys of a list', expectationOf(checkSpec([elementField(0), elementField(1, ['FIELD', 'FIELD', 'EMPTY_NULL']), TITLE_KEY]))],
    ['an element of a text key', expectationOf(checkSpec([{ ...elementField(0), type: 'string' } as CheckKeyField, elementField(1), TITLE_KEY]))],
    ['an element without roles', expectationOf(checkSpec([{ key: 'quals[0]', type: 'array', element: { key: 'quals', index: 0 } } as unknown as CheckKeyField, elementField(1), TITLE_KEY]))],
    ['a list that is a key of the fields too', expectationOf(checkSpec([elementField(0), elementField(1), TITLE_KEY, { key: 'quals', type: 'array' }]), { ...VALUES, quals: FIRST })],
    ['a list that is a key of the page too', expectationOf(checkSpec([elementField(0), elementField(1), TITLE_KEY], [{ key: 'quals', type: 'array', elements: { types: ['string'], count: 3 } }]))],
    ['two fields without an element (one key)', expectationOf(checkSpec([{ key: 'quals', type: 'array', positions: ['FIELD', 'FIELD'] } as CheckKeyField, TITLE_KEY]), { quals: FIRST, title: TITLE_VALUE })],
  ])('treats %s as an invalid expectation', (_name, expectation) => {
    expect(checkApiWritePayload(expectation, factsOf(SENT))).toEqual({ decision: 'EXPECTATION_INVALID' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------------------------

// 前の形（一覧のない型・DEF-226・ARR-3）の digest が変わらないことは、arr-5-array-object-rows の ARR-5 の digest の場面が確かめる。
describe('ARR-4: the digests', () => {
  it('changes the digests when the fields of the positions change', () => {
    const two = probeOf(TWO_BODY, TWO_FIELDS);
    const swapped = probeOf(TWO_BODY, [TITLE_FIELD, fieldOf('qual-1', 1), fieldOf('qual-0', 2)]);
    expect(apiKeyFieldsDigestOf(two.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(two)))
      .not.toBe(apiKeyFieldsDigestOf(two.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(swapped)));
    const base = computeApprovalDigest(scenarioOf(buttonOf(two), TWO_KEYS), DIGEST_FACTS);
    expect(computeApprovalDigest(scenarioOf(buttonOf(swapped), TWO_KEYS), DIGEST_FACTS)).not.toBe(base);
  });
});
