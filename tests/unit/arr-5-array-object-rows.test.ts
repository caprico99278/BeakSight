// ARR-5（DEF-234 の段 C。設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.4）: 要素が object の一覧（入れ子 1 段）を、行の位置と中の鍵（道
// `key[i].name`）で欄に対応づけることを、純粋な部品を表で確かめる。
// - 型の記録: object の行の中の鍵と印を、行ごとに記録する（値は残さない。I22）。中の鍵の名前は今の伏せ方で伏せる。
// - 対応と承認: 行の中の欄ごとに道 `key[i].name` の鍵として受ける。中の欄でない値は空の値だけ。深い入れ子・object と scalar の混ざり・行ごとに違う中の鍵の
//   集合・秘密に見える／状態の語の／伏せた中の鍵・上限の超過は拒む。
// - データの規則: 欄ごと（道ごと）に値ができる。
// - 送る前の照合: 行の数、行ごとの中の鍵の集合、欄の位置の生成した値、空の位置の空の値が承認と完全一致。
// - digest: 一覧のない型・DEF-226 の形・ARR-3・ARR-4 の形の digest は、ARR-5 の前の値のまま（固定の値）。
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
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import {
  apiArrayElementPathOf,
  apiArrayElementPathPartsOf,
  apiRequestShapeOf,
  type ApiRequestShape,
} from '../../src/core/api-request-shape.js';
import { REDACTED } from '../../src/core/redaction.js';
import { apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  observedSubmissionProbeOf,
  submissionProbeKeyFieldsOf,
  type SubmissionProbeInputField,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import { SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../src/presentation/messages.js';
import {
  checkApiWritePayload,
  type ApiWriteCheckSpec,
  type ApiWritePayloadExpectation,
  type ApiWriteRequestFacts,
} from '../../src/safety/api-write-payload-policy.js';
import { ALL_CONFIRMED, AUTH_SETUP_DIGEST, INPUT_RULES, PROFILE_ID, TARGET_CONFIG_DIGEST, candidateOf, sampleScenario } from './approval-samples.js';
import { BASE_DATE, ruleSetFor, seedInputFor } from './data-rule-scenario-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const ROW_KEYS_REASON = 'SCENARIO_API_ARRAY_ROW_KEYS_MISMATCH';
const INNER_KEY_REASON = 'SCENARIO_API_ARRAY_INNER_KEY_NOT_ALLOWED';
const API = 'https://api.example.invalid';
const MARKERS = Array.from({ length: 8 }, (_, index) => `bsprobe00000000000${String.fromCharCode(97 + index)}`);
const M = (index: number): string => MARKERS[index] ?? '';
const NEW_PATH = '/admin/records/new';
const fieldOf = (name: string, marker: number): SubmissionProbeInputField => ({ name, selector: `#${name}`, type: 'text', marker });
const TITLE_FIELD = fieldOf('title', 0);
/** 職歴の行 2 つ（名前と年）。 */
const OBJ_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('cn-0', 1), fieldOf('cy-0', 2), fieldOf('cn-1', 3), fieldOf('cy-1', 4)];
const OBJ_BODY = { title: M(0), careers: [{ name: M(1), year: M(2) }, { name: M(3), year: M(4) }] };
/** 後ろに空の行（ページが足す）。 */
const OBJ_TRAIL_BODY = { ...OBJ_BODY, careers: [...OBJ_BODY.careers, { name: '', year: '' }] };
const OBJ_KEYS = ['careers[0].name', 'careers[0].year', 'careers[1].name', 'careers[1].year', 'title'];
const ROWS_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('qual-0', 1), fieldOf('lic-0', 3)];
const ROWS_BODY = { title: M(0), quals: [M(1), ''], licenses: [M(3), ''] };
const TWO_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('qual-0', 1), fieldOf('qual-1', 2)];
const TWO_BODY = { title: M(0), quals: [M(1), M(2)] };
const DEF226_BODY = { title: M(0), labels: [M(1)], holders: ['u-1'], makers: [] };
const DEF226_FIELDS: readonly SubmissionProbeInputField[] = [TITLE_FIELD, fieldOf('label', 1)];
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
/** その型で欄のある鍵をすべて送る下書きの確かめ（拒む形の理由を見る）。 */
const validateAllFields = (body: unknown, fields: readonly SubmissionProbeInputField[]): ScenarioDraftValidationResult => {
  const candidate = buttonOf(probeOf(body, fields));
  const keys = submissionProbeKeyFieldsOf(candidate.submissionProbe as SubmissionProbeRecord).filter(({ field }) => field !== null).map(({ key }) => key);
  return validate(candidate, keys);
};
const scenarioOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], pageKeys: readonly string[] = []): ScenarioRevision => {
  const result = validate(candidate, fieldNames, pageKeys);
  if (!result.ok) throw new Error(codesOf(result).join(','));
  return { ...sampleScenario(), ...result.content, inputRuleReference: INPUT_RULES } as ScenarioRevision;
};
const keyOf = (shape: ApiRequestShape, name: string) => shape.body.keys.find((key) => key.name === name);

describe('ARR-5: the path of a key in a row', () => {
  it('makes and reads the path key[i].name with the ARR-3 parts', () => {
    expect(apiArrayElementPathOf('careers', 1, 'name')).toBe('careers[1].name');
    expect(apiArrayElementPathOf('careers', 1)).toBe('careers[1]');
    expect(apiArrayElementPathPartsOf('careers[1].name')).toEqual({ key: 'careers', index: 1, name: 'name' });
    expect(apiArrayElementPathPartsOf('careers[1]')).toEqual({ key: 'careers', index: 1 });
    expect(apiArrayElementPathPartsOf('careers[1].')).toBeNull();
  });
});

describe('ARR-5: the record of the keys in the rows', () => {
  it('records the keys of each row with the marker numbers, the empty values and the types, without a value', () => {
    const shape = shapeOf({ ...OBJ_BODY, careers: [{ name: M(1), year: '' }, { name: M(3), year: null }] });
    expect(keyOf(shape, 'careers')?.elements?.positions).toEqual([
      { markers: [], empty: false, type: 'object', keys: [{ name: 'name', markers: [1], empty: false, type: 'string' }, { name: 'year', markers: [], empty: true, type: 'string' }] },
      { markers: [], empty: false, type: 'object', keys: [{ name: 'name', markers: [3], empty: false, type: 'string' }, { name: 'year', markers: [], empty: true, type: 'null' }] },
    ]);
    expect(shape.body.markerKeys.find(({ key }) => key === 'careers')).toEqual({ key: 'careers', markers: [1, 3], inArray: true });
    expect(MARKERS.some((marker) => JSON.stringify(shape).includes(marker))).toBe(false);
  });

  it('records a row of one object too, and hides an inner key name like a value or with a marker', () => {
    const shape = shapeOf({ title: M(0), careers: [{ name: M(1), [M(2)]: '', 'someone@example.invalid': '' }] });
    const [row] = keyOf(shape, 'careers')?.elements?.positions ?? [];
    expect(row?.keys?.map(({ name }) => name).sort()).toEqual([REDACTED, REDACTED, 'name'].sort());
    expect(JSON.stringify(shape)).not.toContain(M(2));
  });

  it('passes the schema of a candidate with the keys of the rows', () => {
    expect(validateControlDocument('candidate', buttonOf(probeOf(OBJ_TRAIL_BODY, OBJ_FIELDS))).ok).toBe(true);
  });

  it('maps each field in a row to the path key[i].name', () => {
    expect(submissionProbeKeyFieldsOf(probeOf(OBJ_BODY, OBJ_FIELDS)).map(({ key, field, element }) => [key, field?.name ?? null, element ?? null])).toEqual([
      ['careers[0].name', 'cn-0', { key: 'careers', index: 0, name: 'name' }],
      ['careers[0].year', 'cy-0', { key: 'careers', index: 0, name: 'year' }],
      ['careers[1].name', 'cn-1', { key: 'careers', index: 1, name: 'name' }],
      ['careers[1].year', 'cy-1', { key: 'careers', index: 1, name: 'year' }],
      ['title', 'title', null],
    ]);
  });
});

describe('ARR-5: the approval of a list of rows', () => {
  const ROW = [{ name: 'name', role: 'FIELD' }, { name: 'year', role: 'FIELD' }];

  it('accepts the rows with a field for each inner key, and keeps the roles of the rows (no value)', () => {
    const result = validate(buttonOf(probeOf(OBJ_BODY, OBJ_FIELDS)), OBJ_KEYS);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keyFields.find(({ key }) => key === 'careers[1].year')).toEqual({
      key: 'careers[1].year', type: 'array', field: { kind: 'NAME', name: 'cy-1' }, fieldType: 'text',
      element: { key: 'careers', index: 1, name: 'year' }, rows: [ROW, ROW],
    });
    expect(MARKERS.some((marker) => JSON.stringify(result.content).includes(marker))).toBe(false);
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('accepts an empty row and empty inner values', () => {
    const result = validate(buttonOf(probeOf(OBJ_TRAIL_BODY, OBJ_FIELDS)), OBJ_KEYS);
    expect(codesOf(result)).toEqual([]);
    expect(result.ok ? result.content.api?.keyFields.find(({ key }) => key === 'careers[0].name')?.rows : null)
      .toEqual([ROW, ROW, [{ name: 'name', role: 'EMPTY_STRING' }, { name: 'year', role: 'EMPTY_STRING' }]]);
    const single = validateAllFields({ title: M(0), careers: [{ name: M(1), year: null }] }, [TITLE_FIELD, fieldOf('cn-0', 1)]);
    expect(codesOf(single)).toEqual([]);
    expect(single.ok ? single.content.api?.keyFields.find(({ key }) => key === 'careers[0].name')?.rows : null)
      .toEqual([[{ name: 'name', role: 'FIELD' }, { name: 'year', role: 'EMPTY_NULL' }]]);
  });

  const many = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${String(index)}`, '']));
  it.each<readonly [string, unknown, string]>([
    ['an object deeper in a row', [{ name: M(1), period: { from: '' } }], 'SCENARIO_API_ARRAY_NESTED'],
    ['a list in a row', [{ name: M(1), tags: [] }], 'SCENARIO_API_ARRAY_NESTED'],
    ['objects mixed with texts', [{ name: M(1) }, ''], 'SCENARIO_API_ARRAY_NESTED'],
    ['rows with other sets of inner keys', [{ name: M(1), year: '' }, { name: M(3) }], ROW_KEYS_REASON],
    ['a secret-like inner key', [{ name: M(1), api_token: '' }], INNER_KEY_REASON],
    ['an inner key of a state', [{ name: M(1), deleted: '' }], INNER_KEY_REASON],
    ['a hidden inner key', [{ name: M(1), 'someone@example.invalid': '' }], INNER_KEY_REASON],
    ['a value decided by the page in a row', [{ name: M(1), kind: 'job' }], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    ['a number at a field in a row', [{ name: M(1), year: 0 }], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
    // L13 fix round 1: 長い文字（前は上限の超過）は、ページが決める値として今どおり拒む。
    ['a long text decided by the page in a row', [{ name: M(1), note: 'x'.repeat(201) }], 'SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH'],
  ])('rejects %s', (_name, careers, reason) => {
    expect(codesOf(validateAllFields({ title: M(0), careers }, OBJ_FIELDS))).toContain(reason);
  });

  // L13 fix round 1: 行の数・行の中の鍵の数・葉の数に上限を置かない（前は 20・16・32 を超えたら `SCENARIO_API_ARRAY_OVER_LIMIT`）。
  it('accepts 21 rows of 17 inner keys (more than 32 leaves)', () => {
    const careers = [{ name: M(1), ...many(16) }, ...Array.from({ length: 20 }, () => ({ name: '', ...many(16) }))];
    expect(codesOf(validateAllFields({ title: M(0), careers }, [TITLE_FIELD, fieldOf('cn-0', 1)]))).toEqual([]);
  });

  it('keeps a list of objects without a marker a nested list (as before)', () => {
    expect(codesOf(validate(buttonOf(probeOf({ title: M(0), careers: [{ name: 'x' }] }, [TITLE_FIELD])), ['title'], ['careers']))).toEqual(['SCENARIO_API_ARRAY_NESTED']);
  });

  it('registers the new reasons in the closed list and the display catalog', () => {
    for (const reason of [ROW_KEYS_REASON, INNER_KEY_REASON]) {
      expect(SCENARIO_DRAFT_REJECTION_REASONS).toContain(reason);
      expect(Object.hasOwn(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS, reason)).toBe(true);
    }
  });

  it('makes a value for each field in the rows by the data rules', () => {
    const candidate = buttonOf(probeOf(OBJ_BODY, OBJ_FIELDS));
    const scenario = scenarioOf(candidate, OBJ_KEYS);
    const inferred = inferRuleSetContent(scenario, candidate);
    const ruleSet = ruleSetFor(scenario, inferred.content.fieldRules);
    const generated = generateScenarioData({
      ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet), usedUniqueKeys: [], usedPhoneNumbers: [], baseDate: BASE_DATE,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(Object.keys(generated.values).sort()).toEqual(OBJ_KEYS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------------------------------------------

const API_PATH = '/rest/v1/records';
const TITLE_VALUE = '題 一';
type CheckKeyField = ApiWriteCheckSpec['keyFields'][number];
const FIELD_ROW = [{ name: 'name', role: 'FIELD' }, { name: 'year', role: 'FIELD' }];
const EMPTY_ROW = [{ name: 'name', role: 'EMPTY_STRING' }, { name: 'year', role: 'EMPTY_NULL' }];
const ROWS = [FIELD_ROW, EMPTY_ROW];
const rowField = (name: string, rows: unknown = ROWS, index = 0, key = 'careers'): CheckKeyField =>
  ({ key: `${key}[${String(index)}].${name}`, type: 'array', element: { key, index, name }, rows } as unknown as CheckKeyField);
const TITLE_KEY: CheckKeyField = { key: 'title', type: 'string' };
const checkSpec = (keyFields: readonly CheckKeyField[] = [rowField('name'), rowField('year'), TITLE_KEY]): ApiWriteCheckSpec => ({
  request: { method: 'POST', origin: API, pathShape: API_PATH, queryNames: [], contentType: 'application/json', prefer: [] },
  keyFields,
  pageKeys: [],
  headerNames: ['content-type'],
  filterName: null,
});
const VALUES = { 'careers[0].name': '名前 一', 'careers[0].year': '2020', title: TITLE_VALUE };
const expectationOf = (spec: ApiWriteCheckSpec = checkSpec(), values: Readonly<Record<string, string | null>> = VALUES): ApiWritePayloadExpectation =>
  ({ spec, values, recordId: null });
const factsOf = (body: unknown): ApiWriteRequestFacts => ({
  method: 'POST', url: `${API}${API_PATH}`, headers: { 'Content-Type': 'application/json' },
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
});
const SENT_ROWS = [{ name: '名前 一', year: '2020' }, { name: '', year: null }];
const SENT = { title: TITLE_VALUE, careers: SENT_ROWS };

describe('ARR-5: the check of the rows before the send', () => {
  it('allows the rows with the generated values and the approved empty values (any order of the inner keys)', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf(SENT))).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expect(checkApiWritePayload(expectationOf(), factsOf({ ...SENT, careers: [{ year: '2020', name: '名前 一' }, { year: null, name: '' }] })).decision).toBe('ALLOW');
    // L13 fix round 1: 21 行・17 個の中の鍵（葉は 32 を超える）も、承認と完全一致なら送る。行の数が違えば今どおり止める。
    const inner = Array.from({ length: 16 }, (_, index) => `k${String(index).padStart(2, '0')}`);
    const wide = (role: 'FIELD' | 'EMPTY_STRING') => [{ name: 'name', role }, ...inner.map((name) => ({ name, role: 'EMPTY_STRING' }))]
      .sort((left, right) => (left.name < right.name ? -1 : 1));
    const wideRows = [wide('FIELD'), ...Array.from({ length: 20 }, () => wide('EMPTY_STRING'))];
    const wideExpectation = expectationOf(checkSpec([rowField('name', wideRows), TITLE_KEY]), { 'careers[0].name': '名前 一', title: TITLE_VALUE });
    const emptyRow = Object.fromEntries(['name', ...inner].map((name) => [name, '']));
    const wideSent = [{ ...emptyRow, name: '名前 一' }, ...Array.from({ length: 20 }, () => emptyRow)];
    expect(checkApiWritePayload(wideExpectation, factsOf({ title: TITLE_VALUE, careers: wideSent })).decision).toBe('ALLOW');
    expect(checkApiWritePayload(wideExpectation, factsOf({ title: TITLE_VALUE, careers: wideSent.slice(0, 20) }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
  });

  it.each<readonly [string, unknown, string]>([
    ['an inner key added', [{ ...SENT_ROWS[0], role: 'admin' }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['an inner key removed', [{ name: '名前 一' }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['a row added', [...SENT_ROWS, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['a row removed', [SENT_ROWS[0]], 'BODY_VALUE_MISMATCH'],
    ['the rows swapped', [SENT_ROWS[1], SENT_ROWS[0]], 'BODY_VALUE_MISMATCH'],
    ['another value at a field', [{ ...SENT_ROWS[0], name: 'other-value' }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['the fields swapped in a row', [{ name: '2020', year: '名前 一' }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['an empty value filled', [SENT_ROWS[0], { name: 'filled-by-page', year: null }], 'BODY_VALUE_MISMATCH'],
    ['an empty text for an approved null', [SENT_ROWS[0], { name: '', year: '' }], 'BODY_VALUE_MISMATCH'],
    ['a row as a text', [SENT_ROWS[0], ''], 'BODY_VALUE_MISMATCH'],
    ['a row as null', [SENT_ROWS[0], null], 'BODY_VALUE_MISMATCH'],
    ['a row as a list', [SENT_ROWS[0], ['', null]], 'BODY_VALUE_MISMATCH'],
    ['a deeper value', [{ ...SENT_ROWS[0], name: ['名前 一'] }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
    ['a deeper object', [{ ...SENT_ROWS[0], year: { value: '2020' } }, SENT_ROWS[1]], 'BODY_VALUE_MISMATCH'],
  ])('does not send the rows with %s', (_name, careers, decision) => {
    const result = checkApiWritePayload(expectationOf(), factsOf({ ...SENT, careers }));
    expect(result).toEqual({ decision });
    expect(JSON.stringify(result)).not.toContain('名前 一');
  });

  it('does not send a row with a duplicate inner key', () => {
    const text = `{"title":"${TITLE_VALUE}","careers":[{"name":"other","name":"名前 一","year":"2020"},{"name":"","year":null}]}`;
    expect(checkApiWritePayload(expectationOf(), factsOf(text))).toEqual({ decision: 'BODY_DUPLICATE_KEY' });
  });

  it('keeps a nested list of the page not sent (as before)', () => {
    expect(checkApiWritePayload(expectationOf(), factsOf({ ...SENT, extra: [{ a: 1 }] }))).toEqual({ decision: 'BODY_VALUE_NOT_SCALAR' });
  });

  it.each<readonly [string, ApiWritePayloadExpectation]>([
    ['a path that is not the path of its element', expectationOf(checkSpec([{ ...rowField('name'), key: 'careers[0].year' } as CheckKeyField, rowField('year'), TITLE_KEY]))],
    ['rows that differ between the keys of a list', expectationOf(checkSpec([rowField('name'), rowField('year', [FIELD_ROW, FIELD_ROW]), TITLE_KEY]))],
    ['a field in the rows without its key', expectationOf(checkSpec([rowField('name'), TITLE_KEY]))],
    ['an element at an inner key that is not a field', expectationOf(checkSpec([rowField('name'), rowField('year'), rowField('name', ROWS, 1), TITLE_KEY]), { ...VALUES, 'careers[1].name': 'x' })],
    ['rows with an unknown role', expectationOf(checkSpec([rowField('name', [[{ name: 'name', role: 'PAGE' }]]), TITLE_KEY]))],
    ['rows with a duplicate inner key', expectationOf(checkSpec([rowField('name', [[{ name: 'name', role: 'FIELD' }, { name: 'name', role: 'EMPTY_STRING' }]]), TITLE_KEY]))],
    ['rows with other sets of inner keys', expectationOf(checkSpec([rowField('name', [FIELD_ROW, [{ name: 'name', role: 'EMPTY_STRING' }]]), rowField('year', [FIELD_ROW, [{ name: 'name', role: 'EMPTY_STRING' }]]), TITLE_KEY]))],
    ['rows and positions together', expectationOf(checkSpec([{ ...rowField('name'), positions: ['FIELD', 'EMPTY_STRING'] } as CheckKeyField, rowField('year'), TITLE_KEY]))],
    ['rows without an element', expectationOf(checkSpec([{ key: 'careers', type: 'array', rows: ROWS } as unknown as CheckKeyField, TITLE_KEY]), { careers: 'x', title: TITLE_VALUE })],
    ['an element with an inner key without rows', expectationOf(checkSpec([{ key: 'careers[0].name', type: 'array', element: { key: 'careers', index: 0, name: 'name' } } as unknown as CheckKeyField, TITLE_KEY]))],
  ])('treats %s as an invalid expectation', (_name, expectation) => {
    expect(checkApiWritePayload(expectation, factsOf(SENT))).toEqual({ decision: 'EXPECTATION_INVALID' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------------------------------------------

/** ARR-5 の前の実装で計算した値（一覧のない型、DEF-226 の形、ARR-3 の形、ARR-4 の形）。 */
const PLAIN_SHAPE_DIGEST = 'sha256:339d70537bd15192fbf7f67a616a5be60dc8138caa8aa70a255bcff3959ef6c9';
const DEF226_SHAPE_DIGEST = 'sha256:24e0afc2a06ce69beeacf2d7ab2af17bb57e7ca5b541379c0c94c577233d27b6';
const DEF226_KEY_FIELDS_DIGEST = 'sha256:67ad19ec6bf05f0ea371b64b13c07bb2f54a91909761a6f66e5f7d32ff2768ae';
const ARR3_SHAPE_DIGEST = 'sha256:a31dac0b62b2090530dca10b7980f92ac7f0dbcb94bd9f1ceb838f6d1a43f057';
const ARR3_KEY_FIELDS_DIGEST = 'sha256:2723853cbb2af17f6c7510489b819066730f9312d1ab37660f7777e226a276a8';
const ARR3_APPROVAL_DIGEST = 'sha256:7b79034575c41b3532ed453ff60b993b03127f83c985684fe2d7981b3981ec9b';
const ARR4_SHAPE_DIGEST = 'sha256:3578cea173a243cfe4319ae10ae0851f4b36d3e07b66dd9e0920ed1c60b667a0';
const ARR4_KEY_FIELDS_DIGEST = 'sha256:835b7c798218faa5cc1c82462b241a1c2c2192c3e83226acc67347a22133d948';
const ARR4_APPROVAL_DIGEST = 'sha256:ad67a6998ceadf6abf17942c24a30c2e2e90baa8dff9b73f5bda6246f02e4875';

describe('ARR-5: the digests', () => {
  it('keeps the digests of a shape without a list and of the DEF-226, ARR-3 and ARR-4 forms (the values before ARR-5)', () => {
    expect(apiShapeDigestOf(shapeOf({ title: M(0), label: M(1), tenant_id: 'tenant-1' }))).toBe(PLAIN_SHAPE_DIGEST);
    const def226 = probeOf(DEF226_BODY, DEF226_FIELDS);
    expect(def226.shapeDigest).toBe(DEF226_SHAPE_DIGEST);
    expect(apiKeyFieldsDigestOf(def226.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(def226))).toBe(DEF226_KEY_FIELDS_DIGEST);
    const rows = probeOf(ROWS_BODY, ROWS_FIELDS);
    expect(rows.shapeDigest).toBe(ARR3_SHAPE_DIGEST);
    expect(apiKeyFieldsDigestOf(rows.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(rows))).toBe(ARR3_KEY_FIELDS_DIGEST);
    expect(computeApprovalDigest(scenarioOf(buttonOf(rows), ['licenses', 'quals', 'title']), DIGEST_FACTS)).toBe(ARR3_APPROVAL_DIGEST);
    const two = probeOf(TWO_BODY, TWO_FIELDS);
    expect(two.shapeDigest).toBe(ARR4_SHAPE_DIGEST);
    expect(apiKeyFieldsDigestOf(two.shapeDigest ?? '', scenarioApiKeyFieldsOfProbe(two))).toBe(ARR4_KEY_FIELDS_DIGEST);
    expect(computeApprovalDigest(scenarioOf(buttonOf(two), ['quals[0]', 'quals[1]', 'title']), DIGEST_FACTS)).toBe(ARR4_APPROVAL_DIGEST);
  });

  it('changes the digests when the rows change', () => {
    const plain = probeOf(OBJ_BODY, OBJ_FIELDS);
    const trail = probeOf(OBJ_TRAIL_BODY, OBJ_FIELDS);
    expect(plain.shapeDigest).not.toBe(trail.shapeDigest);
    expect(computeApprovalDigest(scenarioOf(buttonOf(plain), OBJ_KEYS), DIGEST_FACTS))
      .not.toBe(computeApprovalDigest(scenarioOf(buttonOf(trail), OBJ_KEYS), DIGEST_FACTS));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// fix round 1（SREV-ARR2 の C1・I1・M1・M2・M4）
// ---------------------------------------------------------------------------------------------------------------

/** SREV-ARR2 の実験の、行の中の鍵の名前の一覧（論理削除・削除の語・危険な語・状態の語・秘密に見える名前・method の上書き）。 */
const UNUSABLE_INNER_NAMES = [
  'del', 'delflg', 'del_flg', 'delete', 'delete_flag', 'is_deleted', 'deleted', 'removed', 'trash', 'trashed', 'purged', 'discarded', 'erased', 'destroyed',
  'archive', 'archived', '削除', '退会', '削除フラグ', 'destroy', 'remove', 'purge', 'status', 'state', 'password', 'api_key', 'access_token', 'secret', '_method',
];
const sortedRow = (row: readonly { readonly name: string; readonly role: string }[]) => [...row].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

describe('ARR-5 fix round 1: the names of the inner keys (C1, I1)', () => {
  it.each(UNUSABLE_INNER_NAMES)('rejects the inner key %s at an empty position and at a field', (name) => {
    expect(codesOf(validateAllFields({ title: M(0), careers: [{ name: M(1), [name]: '' }, { name: M(3), [name]: null }] }, OBJ_FIELDS))).toContain(INNER_KEY_REASON);
    expect(codesOf(validateAllFields({ title: M(0), careers: [{ name: M(1), [name]: M(2) }] }, OBJ_FIELDS))).toContain(INNER_KEY_REASON);
  });

  it.each(UNUSABLE_INNER_NAMES)('treats the rows with the inner key %s as an invalid expectation of the check', (name) => {
    const rows = [sortedRow([{ name: 'name', role: 'FIELD' }, { name, role: 'EMPTY_STRING' }])];
    const expectation = expectationOf(checkSpec([rowField('name', rows), TITLE_KEY]), { 'careers[0].name': '名前 一', title: TITLE_VALUE });
    expect(checkApiWritePayload(expectation, factsOf({ title: TITLE_VALUE, careers: [{ name: '名前 一', [name]: '' }] }))).toEqual({ decision: 'EXPECTATION_INVALID' });
  });

  it('keeps the usable inner keys (name, year)', () => {
    expect(codesOf(validate(buttonOf(probeOf(OBJ_BODY, OBJ_FIELDS)), OBJ_KEYS))).toEqual([]);
  });
});

describe('ARR-5 fix round 1: the paths that overlap (M1)', () => {
  it('does not split two lists whose paths overlap, and rejects them with the reason of the overlap', () => {
    // 一覧 a の行の中の鍵 b[0] と、最上位の一覧 a[0].b の位置 0 は、同じ道 a[0].b[0] になる。
    const body = { title: M(0), a: [{ 'b[0]': M(1) }], 'a[0].b': [M(2), M(3)] };
    const fields = [TITLE_FIELD, fieldOf('ab-0', 1), fieldOf('x-0', 2), fieldOf('x-1', 3)];
    const keyFields = submissionProbeKeyFieldsOf(probeOf(body, fields));
    expect(keyFields.filter(({ pathConflict }) => pathConflict === true).map(({ key }) => key).sort()).toEqual(['a', 'a[0].b']);
    expect(keyFields.some(({ element }) => element !== undefined)).toBe(false);
    expect(codesOf(validate(buttonOf(probeOf(body, fields)), ['title'], ['a', 'a[0].b']))).toContain('SCENARIO_API_ARRAY_PATH_CONFLICT');
  });

  it('does not split a list whose path is a key of the body', () => {
    const keyFields = submissionProbeKeyFieldsOf(probeOf({ ...OBJ_BODY, 'careers[0].name': 'x' }, OBJ_FIELDS));
    expect(keyFields.find(({ key }) => key === 'careers')?.pathConflict).toBe(true);
  });
});

const shapeOfText = (text: string): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url: `${API}/rest/v1/records?select=*`,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text },
}, { pagePath: NEW_PATH, markers: MARKERS });

describe('ARR-5 fix round 1: the same key twice in the body (M2)', () => {
  it.each<readonly [string, string]>([
    ['at the top level', `{"title":"${M(0)}","quals":["${M(1)}",""],"quals":["${M(2)}",""]}`],
    ['at the top level with another escape', `{"title":"${M(0)}","careers":[],"c\u0061reers":[]}`],
    ['in a row', `{"title":"${M(0)}","careers":[{"name":"${M(1)}","name":"${M(3)}"}]}`],
  ])('records the mark and rejects the shape with the same key twice %s', (_name, text) => {
    const shape = shapeOfText(text);
    expect(shape.body.duplicateKeyPresent).toBe(true);
    const probe = observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
      { filledFieldCount: OBJ_FIELDS.length, skippedFieldCount: 0 }, OBJ_FIELDS);
    const candidate = buttonOf(probe);
    const keys = submissionProbeKeyFieldsOf(probe).filter(({ field }) => field !== null).map(({ key }) => key);
    expect(codesOf(validate(candidate, keys))).toContain('SCENARIO_API_BODY_KEY_DUPLICATE');
    expect(validateControlDocument('candidate', candidate).ok).toBe(true);
  });

  it('does not mark a body without the same key twice (the digest does not change)', () => {
    expect(shapeOf(OBJ_BODY).body.duplicateKeyPresent).toBeUndefined();
  });

  it('registers the new reasons in the closed list and the display catalog', () => {
    for (const reason of ['SCENARIO_API_ARRAY_PATH_CONFLICT', 'SCENARIO_API_BODY_KEY_DUPLICATE']) {
      expect(SCENARIO_DRAFT_REJECTION_REASONS).toContain(reason);
      expect(Object.hasOwn(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS, reason)).toBe(true);
    }
  });
});

describe('ARR-5 fix round 1: the element of the keys in the form of the draft (M4)', () => {
  it('gives the element only to the keys of the positions of a list', () => {
    const { form } = apiScenarioFormOf({ profileId: PROFILE_ID, candidate: buttonOf(probeOf({ ...OBJ_BODY, 'tags[0]': M(5) }, [...OBJ_FIELDS, fieldOf('tag', 5)])), context: CONTEXT, scenarios: [] });
    expect(form?.keyFields.find(({ key }) => key === 'careers[1].name')?.element).toEqual({ key: 'careers', index: 1, name: 'name' });
    expect(form?.keyFields.find(({ key }) => key === 'tags[0]')?.element).toBeUndefined();
  });
});
