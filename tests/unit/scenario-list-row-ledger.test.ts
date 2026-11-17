// LU-6（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D1・D3・D4、K5、5.2 の 6、5.4 の 1〜3・5）: 一覧の行の更新の台帳の契約と確かめ、
// 台帳への結び付き（同じ表）、承認の digest の版 6。
// - 一覧の行の台帳（`api.ledger.listRow`）: 一覧の画面の path・開き手の識別の digest・行を選ぶ欄。値（行の中身）は持たない。
// - 確かめ: 一覧の path が候補の画面と同じ、probe の記録の開き手の digest が同じで名前がある（D3）、行を選ぶ欄が台帳の登録の毎回違う欄にある、
//   path の形（型の最後が `{id}`）では filter が null、filter の形では filter、両方は拒む。
// - 確かめ直し（5.2 の 6）: 開き手のある probe の記録は `openedFromRow` で分類し直す（probe の結果と食い違わない）。
// - 台帳への結び付き（5.4 の 3）: 更新の型の path が台帳の登録の型の path と同じか、後ろに `/{id}` を 1 つ足したものなら同じ表。
// - 承認の digest: 版 `beaksight-approval/6`、`listRow` が変われば digest が変わる。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_FORMAT,
  approvalDigestDifferencesOf,
  computeApprovalDigest,
  type ApprovalDigestFacts,
} from '../../src/control/approval/approval-digest.js';
import {
  apiKeyFieldsDigestOf,
  type ScenarioApiSpec,
  type ScenarioKindFact,
  type ScenarioListRow,
  type ScenarioRevision,
} from '../../src/control/approval/scenario-contracts.js';
import {
  apiLedgerTableMatchOf,
  apiUpdateLedgerBindingRejectionOf,
  assertStorableScenarioRevision,
  storedScenarioRevisionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { evaluateApprovalValidity, type ApprovalCurrentFacts, type ApprovalValidityInput } from '../../src/control/approval/approval-validity.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  observedSubmissionProbeOf,
  submissionProbeOpenerOf,
  type SubmissionProbeInputField,
  type SubmissionProbeOpener,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import {
  ALL_CONFIRMED,
  AUTH_SETUP_DIGEST,
  FULL_VERIFICATION,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  UPDATE_SPEC as FORM_UPDATE_SPEC,
  candidateOf,
  sampleApproval,
  sampleScenario,
  sampleUpdateScenario,
} from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const LEDGER_ID = 'scenario-ledger';
const LIST_PATH = '/admin/members';
const ITEMS = '/rest/v1/members';
const OPENER_DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_OPENER_DIGEST = `sha256:${'2'.repeat(64)}`;

const MARKED_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];
const MEMBER_BODY = { name: MARKERS[0], email: MARKERS[1] };

const shapeOf = (url: string): ApiRequestShape => apiRequestShapeOf({
  method: 'PATCH',
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
  body: { kind: 'TEXT', text: JSON.stringify(MEMBER_BODY) },
}, { pagePath: LIST_PATH, markers: MARKERS });

const NAMED_OPENER = submissionProbeOpenerOf(OPENER_DIGEST, true, ['編集']);

/** 開き手のない記録は `opener` に null を渡す（省けば名前のある開き手）。 */
const probeOf = (url: string, opener: SubmissionProbeOpener | null = NAMED_OPENER): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shapeOf(url)], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: MARKED_FIELDS.length, skippedFieldCount: 0 }, MARKED_FIELDS, ['保存'], opener ?? undefined);

/** 一覧の画面で、行の開き手を押した後にできた窓の保存の候補。 */
const listButtonOf = (probe: SubmissionProbeRecord, pagePath = LIST_PATH): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});

/** filter の形（A_FILTER）と path の形（A_PATH）と、両方の形。 */
const FILTER_URL = `${API}${ITEMS}?id=eq.4&select=*`;
const PATH_URL = `${API}${ITEMS}/4`;
const BOTH_URL = `${API}${ITEMS}/4?id=eq.4`;
const FILTER_CANDIDATE = listButtonOf(probeOf(FILTER_URL));
const PATH_CANDIDATE = listButtonOf(probeOf(PATH_URL));

const LIST_ROW: ScenarioListRow = Object.freeze({ listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' });

const LEDGER_FACT: ScenarioKindFact = Object.freeze<ScenarioKindFact>({
  scenarioId: LEDGER_ID,
  profileId: PROFILE_ID,
  kind: 'CREATE',
  apiRequest: { origin: API, pathShape: ITEMS },
  apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  uniqueEachRunFieldNames: ['email'],
});

const contextOf = (ledger: Readonly<Record<string, unknown>> = {}): ScenarioDraftContext => ({
  scenarioId: null,
  scenarios: [{ ...LEDGER_FACT, ...ledger } as ScenarioKindFact],
  approvedServiceOrigins: [API],
  profileRevisions: { discoveryJob: 2, current: 2 },
});

const draftOf = (
  candidate: DiscoveryCandidate,
  filterName: string | null,
  listRow: object = LIST_ROW,
  ledger: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames: ['name'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: {
    shapeDigest: candidate.submissionProbe?.shapeDigest,
    pageKeys: [],
    filterName,
    recordId: null,
    ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: LIST_PATH, listRow, ...ledger },
  },
});

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (draft: unknown, candidate: DiscoveryCandidate, context: ScenarioDraftContext = contextOf()): ScenarioDraftValidationResult =>
  validateScenarioDraft(draft, candidate, [], context);

describe('LU-6: the probe of a list row is classified again with openedFromRow (5.2 the 6)', () => {
  it('keeps the probe result API_UPDATE for the filter form and the path form of a list row', () => {
    expect(FILTER_CANDIDATE.submissionProbe?.result).toBe('API_UPDATE');
    expect(PATH_CANDIDATE.submissionProbe?.result).toBe('API_UPDATE');
    // 一覧の行の台帳を持たない下書きでも、分類し直しは probe の結果と同じ（ほかの誤りは台帳の確かめが返す）。
    const { listRow: _row, ...plainLedger } = { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/members/{id}/edit', listRow: null };
    const draft = { ...draftOf(FILTER_CANDIDATE, 'id'), api: { ...(draftOf(FILTER_CANDIDATE, 'id').api as object), ledger: plainLedger } };
    const codes = codesOf(validate(draft, FILTER_CANDIDATE));
    expect(codes).not.toContain('SCENARIO_API_SHAPE_NOT_EXECUTABLE');
    expect(codes).not.toContain('SCENARIO_INPUT_INVALID');
  });
});

describe('LU-6: the ledger of a list row update (an API UPDATE)', () => {
  it('accepts the filter form, and keeps the list row in the ledger of the content (no value of the row)', () => {
    const result = validate(draftOf(FILTER_CANDIDATE, 'id'), FILTER_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.ledger).toEqual({ targetCreateScenarioId: LEDGER_ID, formPathTemplate: LIST_PATH, listRow: LIST_ROW });
    expect(result.content.api?.filterName).toBe('id');
    expect(JSON.stringify(result.content)).not.toContain('bsprobe');
  });

  it('accepts the path form with a null filter', () => {
    const result = validate(draftOf(PATH_CANDIDATE, null), PATH_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.request.pathShape).toBe(`${ITEMS}/{id}`);
    expect(result.content.api?.ledger?.listRow).toEqual(LIST_ROW);
  });

  it.each<readonly [string, () => readonly [Record<string, unknown>, DiscoveryCandidate, ScenarioDraftContext?], readonly string[]]>([
    ['the probe record has no opener', () => {
      // 開き手のない記録の filter の形は、画面の path に番号がないので更新にならない。path の形で確かめる。
      const candidate = listButtonOf(probeOf(PATH_URL, null));
      expect(candidate.submissionProbe?.opener).toBeUndefined();
      return [draftOf(candidate, null), candidate];
    }, ['SCENARIO_UPDATE_PATH_MISMATCH']],
    ['the identity digest of the opener differs', () => [draftOf(FILTER_CANDIDATE, 'id', { ...LIST_ROW, openerIdentityDigest: OTHER_OPENER_DIGEST }), FILTER_CANDIDATE],
      ['SCENARIO_UPDATE_PATH_MISMATCH']],
    ['the opener has no name (D3)', () => {
      const candidate = listButtonOf(probeOf(FILTER_URL, submissionProbeOpenerOf(OPENER_DIGEST, false, ['編集'])));
      return [draftOf(candidate, 'id'), candidate];
    }, ['SCENARIO_UPDATE_PATH_MISMATCH']],
    ['the row key field is not a field of the ledger that differs each run', () => [draftOf(FILTER_CANDIDATE, 'id', { ...LIST_ROW, rowKeyField: 'name' }),
      FILTER_CANDIDATE], ['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']],
    ['the ledger fact does not tell the fields that differ each run', () => [draftOf(FILTER_CANDIDATE, 'id'), FILTER_CANDIDATE,
      contextOf({ uniqueEachRunFieldNames: undefined })], ['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']],
    ['the list page path is not the page path of the candidate', () => {
      const candidate = listButtonOf(probeOf(FILTER_URL), '/admin/groups');
      return [draftOf(candidate, 'id'), candidate];
    }, ['SCENARIO_UPDATE_PATH_MISMATCH']],
    ['the request has both a filter and an id at the end of the path', () => {
      const candidate = listButtonOf(probeOf(BOTH_URL));
      return [draftOf(candidate, 'id'), candidate];
    }, ['SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']],
    // 型に filter がないので filter の名前の誤り、filter と `{id}` の両方なので台帳に結ばない。
    ['the path form names a filter', () => [draftOf(PATH_CANDIDATE, 'id'), PATH_CANDIDATE],
      ['SCENARIO_API_FILTER_MISMATCH', 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']],
    ['the ledger takes no record id from the response body', () => [draftOf(PATH_CANDIDATE, null), PATH_CANDIDATE, contextOf({ apiRecordId: null })],
      ['SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']],
  ])('rejects the draft when %s', (_label, make, codes) => {
    const [draft, candidate, context] = make();
    expect(codesOf(validate(draft, candidate, context))).toEqual(codes);
  });

  it.each<readonly [string, object, Readonly<Record<string, unknown>>]>([
    ['the update page path template differs from the list page path', LIST_ROW, { formPathTemplate: '/admin/members/{id}/edit' }],
    ['the list page path has {id}', { ...LIST_ROW, listPagePath: '/admin/{id}' }, { formPathTemplate: '/admin/{id}' }],
    ['the opener digest is not a digest', { ...LIST_ROW, openerIdentityDigest: 'x' }, {}],
    ['the row key field is empty', { ...LIST_ROW, rowKeyField: '' }, {}],
    ['the list row has another property', { ...LIST_ROW, rowValue: 'a' }, {}],
  ])('rejects the shape of the list row when %s', (_label, listRow, ledger) => {
    expect(codesOf(validate(draftOf(FILTER_CANDIDATE, 'id', listRow, ledger), FILTER_CANDIDATE))).toContain('SCENARIO_INPUT_INVALID');
  });
});

describe('LU-6: the same table of the ledger and the update (5.4 the 3)', () => {
  const ledger: Pick<ScenarioKindFact, 'recordId' | 'apiRecordId' | 'apiRequest'> = {
    recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, apiRequest: { origin: API, pathShape: ITEMS },
  };
  const update: { filterName: string | null; formPathTemplate: string; origin: string; pathShape: string } = {
    filterName: null, formPathTemplate: LIST_PATH, origin: API, pathShape: `${ITEMS}/{id}`,
  };

  it('tells the same path and the path with one /{id} added, and nothing else', () => {
    expect(apiLedgerTableMatchOf({ origin: API, pathShape: ITEMS }, { origin: API, pathShape: ITEMS })).toBe('SAME_PATH');
    expect(apiLedgerTableMatchOf({ origin: API, pathShape: ITEMS }, { origin: API, pathShape: `${ITEMS}/{id}` })).toBe('RECORD_PATH');
    expect(apiLedgerTableMatchOf({ origin: API, pathShape: ITEMS }, { origin: API, pathShape: `${ITEMS}/{id}/x` })).toBeNull();
    expect(apiLedgerTableMatchOf({ origin: API, pathShape: ITEMS }, { origin: API, pathShape: '/rest/v1/other/{id}' })).toBeNull();
    expect(apiLedgerTableMatchOf({ origin: API, pathShape: ITEMS }, { origin: 'https://other.example.invalid', pathShape: ITEMS })).toBeNull();
  });

  it('binds the update /items/{id} to the ledger of /items by the key of the response body', () => {
    expect(apiUpdateLedgerBindingRejectionOf(update, ledger)).toBeNull();
    // 台帳の型の path が同じでも、型にした ID のある更新（`/{id}` の形）は結ぶ（form の形の画面の型でも）。
    expect(apiUpdateLedgerBindingRejectionOf({ ...update, formPathTemplate: '/admin/members/{id}/edit' }, ledger)).toBeNull();
  });

  it.each<readonly [string, Partial<typeof update>, Partial<ScenarioKindFact>]>([
    ['/items/{id}/x', { pathShape: `${ITEMS}/{id}/x` }, {}],
    ['/other/{id}', { pathShape: '/rest/v1/other/{id}' }, {}],
    ['the path form with a filter', { filterName: 'id' }, {}],
    ['the path form with a ledger without the key of the response body', {}, { apiRecordId: null }],
    ['a list row (no {id} in the update page) with a ledger without the key of the response body', { pathShape: ITEMS, filterName: 'id' }, { apiRecordId: null }],
  ])('does not bind %s', (_label, change, ledgerChange) => {
    expect(apiUpdateLedgerBindingRejectionOf({ ...update, ...change }, { ...ledger, ...ledgerChange })).toBe('SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// スキーマと承認の digest
// ---------------------------------------------------------------------------------------------------------------

const DIGEST_FACTS: ApprovalDigestFacts = Object.freeze({ profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });
const TEMPLATED = `sha256:${'e'.repeat(64)}`;
const NAME_FIELD = { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text' } as const;

const API_UPDATE_SPEC: ScenarioApiSpec = Object.freeze({
  shapeDigest: `sha256:${'a'.repeat(64)}`,
  request: { method: 'PATCH', origin: API, pathShape: ITEMS, queryNames: ['select'], contentType: 'application/json', prefer: [] },
  keyFields: [NAME_FIELD],
  keptKeys: [],
  pageKeys: [],
  headerNames: ['authorization', 'content-type'],
  filterName: 'id',
  recordId: null,
  ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/members/{id}/edit' },
  templatedIdentityDigest: TEMPLATED,
} satisfies ScenarioApiSpec);

const apiUpdateScenario = (api: Partial<ScenarioApiSpec> = {}): ScenarioRevision => ({
  ...sampleScenario(),
  kind: 'UPDATE',
  transport: 'API',
  request: null,
  api: { ...API_UPDATE_SPEC, ...api },
  fieldNames: ['name'],
  verification: { ...FULL_VERIFICATION, resultJudgement: null, recordId: null, readVerification: null },
  update: null,
});

const listRowLedger = (listRow: ScenarioListRow = LIST_ROW): NonNullable<ScenarioApiSpec['ledger']> =>
  ({ targetCreateScenarioId: LEDGER_ID, formPathTemplate: listRow.listPagePath, listRow });

/** fix round 1 の判断 1: 一覧の行の API の更新の版（画面の path を型にした識別の digest を持たない）。 */
const listRowScenario = (listRow: ScenarioListRow = LIST_ROW): ScenarioRevision => {
  const { templatedIdentityDigest: _templated, ...spec } = API_UPDATE_SPEC;
  return { ...apiUpdateScenario(), api: { ...spec, ledger: listRowLedger(listRow) } };
};

describe('LU-6: the scenario schema has the list row as an optional item', () => {
  const documentOf = (scenario: ScenarioRevision): unknown => JSON.parse(JSON.stringify(scenario)) as unknown;

  it('accepts the ledger of an API UPDATE and the UPDATE spec of a form, with and without the list row', () => {
    expect(validateControlDocument('scenario', documentOf(apiUpdateScenario()))).toEqual({ ok: true });
    expect(validateControlDocument('scenario', documentOf(listRowScenario()))).toEqual({ ok: true });
    expect(validateControlDocument('scenario', documentOf(sampleUpdateScenario()))).toEqual({ ok: true });
    expect(validateControlDocument('scenario', documentOf(sampleUpdateScenario({ update: { ...FORM_UPDATE_SPEC, listRow: LIST_ROW } })))).toEqual({ ok: true });
  });

  // fix round 1 の判断 1: 型にした識別の digest は、一覧の行の更新では持たず、ほかの API の更新では今のとおり必ず持つ。
  it('stores and reads back a list row update without the templated identity digest, and rejects one with it', () => {
    expect(() => assertStorableScenarioRevision(listRowScenario())).not.toThrow();
    expect(storedScenarioRevisionOf(documentOf(listRowScenario())).api?.ledger?.listRow).toEqual(LIST_ROW);
    expect(validateControlDocument('scenario', documentOf(apiUpdateScenario({ ledger: listRowLedger() }))).ok).toBe(false);
    const { templatedIdentityDigest: _templated, ...withoutDigest } = API_UPDATE_SPEC;
    expect(() => assertStorableScenarioRevision({ ...apiUpdateScenario(), api: withoutDigest })).toThrow(RangeError);
  });

  it('stores the content of an accepted list row draft', () => {
    const result = validate(draftOf(FILTER_CANDIDATE, 'id'), FILTER_CANDIDATE);
    if (!result.ok) throw new Error(`the draft was rejected: ${codesOf(result).join(', ')}`);
    expect(result.content.api?.templatedIdentityDigest).toBeUndefined();
    expect(() => assertStorableScenarioRevision({ ...sampleScenario(), ...result.content, inputRuleReference: null })).not.toThrow();
  });

  it('rejects a list row with a value of the row or without an item', () => {
    const { rowKeyField: _row, ...withoutKey } = LIST_ROW;
    for (const listRow of [{ ...LIST_ROW, rowValue: 'a' }, withoutKey]) {
      const ledger = { targetCreateScenarioId: LEDGER_ID, formPathTemplate: LIST_PATH, listRow } as unknown as ScenarioApiSpec['ledger'];
      expect(validateControlDocument('scenario', documentOf(apiUpdateScenario({ ledger }))).ok).toBe(false);
    }
  });
});

// fix round 1 の判断 1: 一覧の行の更新の承認の有効性は、API の登録と同じく候補の識別の digest で確かめる（`RangeError` にしない）。
describe('LU-6: the approval validity of a list row update by the identity digest of the candidate', () => {
  const RULE = `sha256:${'d'.repeat(64)}`;
  const scenario = { ...listRowScenario(), candidate: { identityDigest: FILTER_CANDIDATE.identityDigest, ruleDigest: RULE } };
  const FACTS: ApprovalCurrentFacts = Object.freeze<ApprovalCurrentFacts>({
    profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE', approvedServiceOrigins: [API] },
    authSetupDigest: AUTH_SETUP_DIGEST,
    targetConfigDigest: TARGET_CONFIG_DIGEST,
    candidate: { identityDigest: FILTER_CANDIDATE.identityDigest, ruleDigest: RULE, classification: 'NEEDS_BINDING', drift: 'SEEN' },
    candidateShapeDigests: [API_UPDATE_SPEC.shapeDigest],
    candidateKeyFieldDigests: [apiKeyFieldsDigestOf(API_UPDATE_SPEC.shapeDigest, [NAME_FIELD])],
    apiShapeOrigin: { kind: 'APPROVED_API', index: 0 },
    latestDiscoveryProfileRevision: 4,
    // 一覧の画面には ID がないので、型にした digest の一覧は見ない（なくてもよい）。
    templatedCandidates: null,
    inputRuleReference: INPUT_RULES,
    readChecks: READ_CHECK_FACTS,
  });
  const inputOf = (facts: Partial<ApprovalCurrentFacts> = {}): ApprovalValidityInput => ({
    scenario,
    facts: { ...FACTS, ...facts },
    lastApproval: sampleApproval(computeApprovalDigest(scenario, DIGEST_FACTS), {
      bound: { ...sampleApproval('x').bound, candidateIdentityDigest: FILTER_CANDIDATE.identityDigest, candidateRuleDigest: RULE },
    }),
    lastRevocation: null,
    now: new Date(Date.parse('2026-11-02T02:00:00Z')),
  });

  it('is approved when the identity digest of the candidate is the same', () => {
    expect(evaluateApprovalValidity(inputOf())).toMatchObject({ approved: true });
  });

  it('needs a new approval when the candidate of the identity digest is not in the index', () => {
    const validity = evaluateApprovalValidity(inputOf({
      candidate: { identityDigest: OTHER_OPENER_DIGEST, ruleDigest: RULE, classification: 'NEEDS_BINDING', drift: 'SEEN' },
    }));
    expect(validity).toMatchObject({ approved: false, reasons: ['CANDIDATE_MISSING'] });
    expect(evaluateApprovalValidity(inputOf({ candidate: null }))).toMatchObject({ approved: false, reasons: ['CANDIDATE_MISSING'] });
  });
});

describe('LU-6: the approval digest version 6 binds the list row (K5)', () => {
  it('has the format version 6', () => {
    expect(APPROVAL_DIGEST_FORMAT).toBe('beaksight-approval/6');
  });

  it.each<readonly [keyof ScenarioListRow, string]>([
    ['listPagePath', '/admin/groups'],
    ['openerIdentityDigest', OTHER_OPENER_DIGEST],
    ['rowKeyField', 'code'],
  ])('changes the digest of an API UPDATE when %s of the list row changes, in the item of the ledger', (key, value) => {
    const before = apiUpdateScenario({ ledger: listRowLedger() });
    const after = apiUpdateScenario({ ledger: { ...listRowLedger(), listRow: { ...LIST_ROW, [key]: value } } });
    expect(computeApprovalDigest(after, DIGEST_FACTS)).not.toBe(computeApprovalDigest(before, DIGEST_FACTS));
    expect(approvalDigestDifferencesOf({ scenario: before, facts: DIGEST_FACTS }, { scenario: after, facts: DIGEST_FACTS }).map(({ item }) => item))
      .toEqual(['apiLedger']);
  });

  it('changes the digest of an API UPDATE when the list row is added', () => {
    const before = apiUpdateScenario({ ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: LIST_PATH } });
    expect(computeApprovalDigest(apiUpdateScenario({ ledger: listRowLedger() }), DIGEST_FACTS)).not.toBe(computeApprovalDigest(before, DIGEST_FACTS));
  });

  it('changes the digest of a form UPDATE when the list row is added or changes, in the item of the update page path template', () => {
    const plain = sampleUpdateScenario();
    const withRow = sampleUpdateScenario({ update: { ...FORM_UPDATE_SPEC, listRow: LIST_ROW } });
    const otherRow = sampleUpdateScenario({ update: { ...FORM_UPDATE_SPEC, listRow: { ...LIST_ROW, rowKeyField: 'code' } } });
    const digests = new Set([plain, withRow, otherRow].map((scenario) => computeApprovalDigest(scenario, DIGEST_FACTS)));
    expect(digests.size).toBe(3);
    expect(approvalDigestDifferencesOf({ scenario: withRow, facts: DIGEST_FACTS }, { scenario: otherRow, facts: DIGEST_FACTS }).map(({ item }) => item))
      .toEqual(['updateFormPathTemplate']);
  });
});
