// DEF-198（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 5.9）: 番号のほかに所属の絞り込みがある更新（純粋な部品の表）。
// - 分類（`classifyApiShapeObservation`・`apiUpdateFiltersOf`）: 画面の番号の印の filter がちょうど 1 つで、ほかは名前の重ならない `eq` だけなら `API_UPDATE`。
//   番号の filter は並び順でなく印で選ぶ（所属の名前が番号より前に並ぶ形も）。`neq`・`in`・`or`・同じ名前が 2 つ・印が 2 つ・一覧の行から開いた形は `FILTER_MULTIPLE`。
// - 変えないもの: 絞り込み 1 つ・A_PATH・一覧の行から開く形・登録などの 6 つの形の分類と型の digest。
// - 下書きの確かめ: `filterName` は番号の filter、ほかの filter の名前（`otherFilterNames`）は probe の型から作る。本文の番号と所属の鍵は欄の識別なしで受ける。
// - 承認の digest: ほかの filter のない版は今の形のまま、ある版だけ値が変わる。
// - 開始の指定（`writeStartSpecOf`・`apiOtherFilterValuesOf`）と IPC: 照らす値は登録の成果物のページが決めた値から作り、なければ作らない。
// - 照合（`checkApiWritePayload`）: ほかの filter は `eq.<値>` と完全一致、本文の番号と所属の鍵は台帳の番号と同じ値。照らす値が写しで落ちた期待は止める。
import { describe, expect, it } from 'vitest';
import { approvalDigestEntriesOf, computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { apiScenarioShapeRejectionOf, validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { apiOtherFilterValuesOf, writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerStartApiWrite,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { apiShapeDigestOf, apiUpdateFiltersOf, classifyApiShapeObservation } from '../../src/discovery/api-shape-classification.js';
import { fieldNameHasStateWord } from '../../src/discovery/classify.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import {
  apiWritePriorValuesCopyOf,
  checkApiWritePayload,
  type ApiWritePayloadExpectation,
  type ApiWriteRequestFacts,
} from '../../src/safety/api-write-payload-policy.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const EDIT_PATH = '/admin/members/1/edit';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
const LEDGER_ID = 'scenario-ledger';
const GRANT_ID = 'grant-api-t1';
const TARGET_ID = '7';
/** 所属の鍵（番号の鍵 `id` より前に並ぶ名前）と、登録の時のページが決めた値。 */
const TENANT = 'account_id';
const TENANT_VALUE = 900;
const HEADERS = { 'content-type': 'application/json', prefer: 'return=representation' };

/** 型（PATCH。画面の path は `pagePath`）。 */
const shapeOf = (url: string, options: { readonly method?: string; readonly pagePath?: string; readonly body?: Record<string, unknown> } = {}): ApiRequestShape =>
  apiRequestShapeOf({
    method: options.method ?? 'PATCH',
    resourceType: 'fetch',
    url,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: HEADERS,
    body: { kind: 'TEXT', text: JSON.stringify(options.body ?? { name: 'N1' }) },
  }, { pagePath: options.pagePath ?? '/items/1001', markers: ['N1'], isStateKeyName: fieldNameHasStateWord });

const classify = (shape: ApiRequestShape, openedFromRow = false) =>
  classifyApiShapeObservation({ shapes: [shape], nonReadRequestCount: 1, openedFromRow });

const ITEMS = `${API}/rest/v1/items`;

describe('DEF-198: the classification of an update with a tenant filter', () => {
  it.each<readonly [string, string]>([
    ['the tenant after the id', `${ITEMS}?id=eq.1001&tenant_id=eq.900&select=*`],
    ['the tenant before the id (account_id)', `${ITEMS}?account_id=eq.900&id=eq.1001&select=*`],
    ['the tenant written first in the query', `${ITEMS}?tenant_id=eq.900&id=eq.1001`],
    ['a tenant value that is not of the record id form', `${ITEMS}?id=eq.1001&tenant_id=eq.t-1`],
  ])('classifies %s as an update and chooses the id filter by the page value', (_label, url) => {
    const shape = shapeOf(url);
    expect(classify(shape)).toMatchObject({ classification: 'API_UPDATE', reason: null });
    expect(apiUpdateFiltersOf(shape, false)?.record.name).toBe('id');
    expect(apiUpdateFiltersOf(shape, false)?.others.map(({ name }) => name)).toHaveLength(1);
  });

  it.each<readonly [string, string, boolean]>([
    ['a neq tenant', `${ITEMS}?id=eq.1001&tenant_id=neq.900`, false],
    ['an in tenant', `${ITEMS}?id=eq.1001&tenant_id=in.(900,901)`, false],
    ['an or filter', `${ITEMS}?id=eq.1001&tenant_id=eq.900&or=(id.eq.1001,id.eq.1)`, false],
    ['two tenant filters', `${ITEMS}?id=eq.1001&tenant_id=eq.900&tenant_id=eq.901`, false],
    ['two id filters', `${ITEMS}?id=eq.1001&id=eq.1&tenant_id=eq.900`, false],
    ['a tenant value equal to the page id (two marks)', `${ITEMS}?id=eq.1001&tenant_id=eq.1001`, false],
    ['no filter with the page id', `${ITEMS}?id=eq.55&tenant_id=eq.900`, false],
    ['a list row opener (the id is not decided by the mark)', `${ITEMS}?id=eq.1001&tenant_id=eq.900`, true],
  ])('keeps %s as FILTER_MULTIPLE', (_label, url, openedFromRow) => {
    const shape = shapeOf(url);
    expect(classify(shape, openedFromRow)).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_MULTIPLE' });
    expect(apiUpdateFiltersOf(shape, openedFromRow)).toBeNull();
  });

  // 調べ（DEF-198-research）の 6 つの形。分類と型の digest は今と同じ（型の digest の正規化 `normalizedShapeOf` は変えていない。値は今の作りで求めた値）。
  it.each<readonly [string, string, string, boolean, string, string | null]>([
    ['one filter of the page path', 'PATCH', `${ITEMS}?id=eq.1001&select=*`, false, 'API_UPDATE', null],
    ['A_PATH', 'PATCH', `${ITEMS}/1001?select=*`, false, 'API_UPDATE', null],
    ['one filter of a list row', 'PATCH', `${ITEMS}?id=eq.55&select=*`, true, 'API_UPDATE', null],
    ['one filter not of the page', 'PATCH', `${ITEMS}?id=eq.55&select=*`, false, 'NOT_EXECUTABLE', 'FILTER_NOT_PAGE_VALUE'],
    ['no filter and no id', 'PATCH', `${ITEMS}?select=*`, false, 'NOT_EXECUTABLE', 'FILTER_MISSING'],
    ['a create', 'POST', `${ITEMS}?select=*`, false, 'API_CREATE', null],
  ])('keeps the classification and the shape digest of %s', (_label, method, url, openedFromRow, classification, reason) => {
    const shape = shapeOf(url, { method, pagePath: method === 'POST' ? '/items/new' : openedFromRow ? '/items' : '/items/1001' });
    const classified = classify(shape, openedFromRow);
    expect(classified).toMatchObject({ classification, reason });
    expect(classified.shapeDigest).toBe(apiShapeDigestOf(shape));
    expect(UNCHANGED_DIGESTS[_label]).toBe(classified.shapeDigest);
  });
});

/**
 * 6 つの形の型の digest（今の作りの値。正規化を変えたら、ここが変わる）。DEF-220: 版の印を `beaksight:api-shape/4` に上げたので、値を v4 で求め直した
 * （正規化の形は変えていない）。
 */
const UNCHANGED_DIGESTS: Readonly<Record<string, string>> = {
  'one filter of the page path': 'sha256:dac55128568700a318b71be3526a0fdb94a91978a08f45aa5afd7b6835de65fb',
  A_PATH: 'sha256:fc30a68583e481b571762ea24fee7ea3bf5244af4b3a46d60dd49db23811d6db',
  'one filter of a list row': 'sha256:a70840a62addab18b9726924b4e47375ef76a812ba58505e40a6e662129804e6',
  'one filter not of the page': 'sha256:a70840a62addab18b9726924b4e47375ef76a812ba58505e40a6e662129804e6',
  'no filter and no id': 'sha256:4d3d8d0375a94bea2eef7416a635e5642ee6bb689d4cf4246a918df8082571de',
  'a create': 'sha256:26378611ea2c43daa467154f50bf0bdf62e53b7e5ad075b3fe9c3c24252aa929',
};

// ---------------------------------------------------------------------------------------------------------------
// 下書き・承認の digest・開始の指定
// ---------------------------------------------------------------------------------------------------------------

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];

/** 編集の画面の保存（番号と所属の絞り込み、本文に番号と所属の鍵。所属の欄はない）。 */
const candidateWith = (url: string): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: EDIT_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'PATCH',
      resourceType: 'fetch',
      url,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: HEADERS,
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1], id: 1, [TENANT]: TENANT_VALUE }) },
    }, { pagePath: EDIT_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 2, skippedFieldCount: 0 }, INPUT_FIELDS),
});
const CANDIDATE = candidateWith(`${API}/rest/v1/members?id=eq.1&${TENANT}=eq.${String(TENANT_VALUE)}&select=*`);

const TEMPLATE_READ: ReadCheckView = {
  readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, createdAt: '20261018000000', updatedAt: '20261018000000', canceledAt: null,
  definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition,
};
const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
] as const;

const draftOf = (candidate: DiscoveryCandidate, filterName: string) => validateScenarioDraft({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames: ['name'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: {
    resultJudgement: null, recordId: null,
    readVerification: { readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] },
  },
  api: {
    shapeDigest: candidate.submissionProbe?.shapeDigest,
    pageKeys: [TENANT, 'id'],
    filterName,
    recordId: null,
    ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE_PATH },
    keptKeys: ['email'],
  },
}, candidate, READ_FACTS, {
  scenarioId: null,
  scenarios: [{
    scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
    apiRequest: { origin: API, pathShape: '/rest/v1/members' },
  }],
  approvedServiceOrigins: [API],
  profileRevisions: { discoveryJob: 2, current: 2 },
});

const UPDATE_SCENARIO: ScenarioRevision = (() => {
  const result = draftOf(CANDIDATE, 'id');
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
})();

describe('DEF-198: the draft of an update with a tenant filter', () => {
  it('takes the other filter names from the probe shape and accepts the id and tenant keys of the body without a field', () => {
    expect(CANDIDATE.submissionProbe?.result).toBe('API_UPDATE');
    expect(apiScenarioShapeRejectionOf(CANDIDATE.submissionProbe as never)).toBeNull();
    expect(UPDATE_SCENARIO.api).toMatchObject({
      filterName: 'id',
      otherFilterNames: [TENANT],
      pageKeys: [{ key: TENANT, type: 'number' }, { key: 'id', type: 'number' }],
      request: { queryNames: ['select'] },
    });
  });

  it('rejects the tenant as the record id filter (the filter is chosen by the page value, not by the order)', () => {
    const result = draftOf(CANDIDATE, TENANT);
    expect(result.ok ? [] : result.errors.map(({ code }) => code)).toContain('SCENARIO_API_FILTER_MISMATCH');
  });
});

const DIGEST_FACTS = { profileRevision: 2, authSetupDigest: null, targetConfigDigest: `sha256:${'a'.repeat(64)}`, inputRuleDigest: null } as never;

describe('DEF-198: the approval digest', () => {
  it('keeps the value of the filter name of a spec without other filters, and adds the other filter names only when there are some', () => {
    const { otherFilterNames: _names, ...withoutOthers } = UPDATE_SCENARIO.api ?? ({} as never);
    const plain: ScenarioRevision = { ...UPDATE_SCENARIO, api: withoutOthers };
    expect(approvalDigestEntriesOf(plain, DIGEST_FACTS).apiFilterName).toBe('id');
    expect(approvalDigestEntriesOf(UPDATE_SCENARIO, DIGEST_FACTS).apiFilterName).toEqual(['id', ['OTHER_FILTERS', TENANT]]);
    expect(computeApprovalDigest(UPDATE_SCENARIO, DIGEST_FACTS)).not.toBe(computeApprovalDigest(plain, DIGEST_FACTS));
    // 空の一覧は持たない版と同じ扱い（今の承認は、そのまま有効）。
    expect(computeApprovalDigest({ ...plain, api: { ...withoutOthers, otherFilterNames: [] } }, DIGEST_FACTS)).toBe(computeApprovalDigest(plain, DIGEST_FACTS));
  });
});

const SEED_RECORD: SeedRecord = {
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO.scenarioId, scenarioRevision: UPDATE_SCENARIO.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-11-04',
  attempt: 0,
} as SeedRecord;

const inputsOf = (createPageKeyValues: Readonly<Record<string, string | null>> | null | undefined) => ({
  scenario: UPDATE_SCENARIO,
  evidence: CANDIDATE,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: SEED_RECORD,
  values: { name: '更新 太郎' },
  readCheck: TEMPLATE_READ,
  targetPage: { origin: SAMPLE_ORIGIN, path: TEMPLATE_PATH },
  targetRecordId: TARGET_ID,
  approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO.scenarioId, scenarioRevision: UPDATE_SCENARIO.revision, grantId: GRANT_ID }),
  ...(createPageKeyValues === undefined ? {} : { createPageKeyValues }),
});

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: 1,
  loginStartUrl: `${SAMPLE_ORIGIN}/login`,
  loginPostEndpoints: [{ origin: SAMPLE_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const errorsOf = (write: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage({
    protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-api-t1', jobKind: 'WRITE_UPDATE', targetConfigPath: 'local/targets/example-api.json', startNew: true,
    targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
    authentication: {
      setup: SETUP, approvedTestOrigins: [SAMPLE_ORIGIN], approvedServiceOrigins: [API],
      authenticationSha256: workerAuthenticationDigestOf(SETUP, [SAMPLE_ORIGIN], { jobKind: 'WRITE_UPDATE', automatedLogin: null, approvedServiceOrigins: [API] }),
    },
    write,
  });
  return checked.ok ? [] : checked.errors;
};

describe('DEF-198: the START of an update with a tenant filter', () => {
  it('puts the value decided by the page at the registration as the value of the other filter, and passes the IPC rules', () => {
    const spec = writeStartSpecOf(inputsOf({ [TENANT]: String(TENANT_VALUE) }));
    expect(spec !== null && isWorkerStartApiWrite(spec) ? spec.update : null).toEqual({
      targetRecordId: TARGET_ID, knownKeptValues: [], otherFilterValues: [{ key: TENANT, value: TENANT_VALUE }],
    });
    expect(errorsOf(spec)).toEqual([]);
    expect(apiOtherFilterValuesOf(UPDATE_SCENARIO.api ?? ({} as never), { [TENANT]: '"t-1"' })).toEqual([{ key: TENANT, value: 't-1' }]);
  });

  it.each<readonly [string, Readonly<Record<string, string | null>> | null | undefined]>([
    ['no values kept by the parent (another inspection, a restart)', undefined],
    ['null values', null],
    ['no value of the tenant', { other: '1' }],
    ['the cut mark of a long value', { [TENANT]: null }],
    ['an empty string', { [TENANT]: '""' }],
    ['a boolean', { [TENANT]: 'true' }],
    ['a JSON null', { [TENANT]: 'null' }],
    ['a text that is not JSON', { [TENANT]: 'not json' }],
  ])('makes no specification (sends nothing) for %s', (_label, values) => {
    expect(writeStartSpecOf(inputsOf(values))).toBeNull();
  });

  it.each<readonly [string, (update: Record<string, unknown>) => Record<string, unknown>]>([
    ['no values of the other filters', ({ otherFilterValues: _values, ...rest }) => rest],
    ['a value of a name that is not an other filter', (update) => ({ ...update, otherFilterValues: [{ key: 'group_id', value: 5 }] })],
    ['two values of the same name', (update) => ({ ...update, otherFilterValues: [{ key: TENANT, value: 900 }, { key: TENANT, value: 901 }] })],
  ])('rejects the START with %s', (_label, change) => {
    const spec = writeStartSpecOf(inputsOf({ [TENANT]: String(TENANT_VALUE) })) as unknown as Record<string, unknown>;
    const errors = errorsOf({ ...spec, update: change(spec['update'] as Record<string, unknown>) });
    expect(errors.some((text) => text.startsWith('/write/update/otherFilterValues')), JSON.stringify(errors)).toBe(true);
  });

  it('rejects other filter values for a spec without other filters', () => {
    const { otherFilterNames: _names, ...withoutOthers } = UPDATE_SCENARIO.api ?? ({} as never);
    const spec = writeStartSpecOf(inputsOf({ [TENANT]: String(TENANT_VALUE) })) as unknown as Record<string, unknown>;
    const errors = errorsOf({ ...spec, api: withoutOthers });
    expect(errors.some((text) => text.startsWith('/write/update/otherFilterValues')), JSON.stringify(errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------------------------------------------

const RECORD_ID = '1001';
const API_PATH = '/rest/v1/members';
const NEW_NAME = 'leak-marker-new';

const expectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: {
    request: { method: 'PATCH', origin: API, pathShape: API_PATH, queryNames: ['select'], contentType: 'application/json', prefer: ['return=representation'] },
    keyFields: [{ key: 'name', type: 'string' }],
    pageKeys: [{ key: TENANT, type: 'number' }, { key: 'id', type: 'number' }],
    headerNames: ['content-type', 'prefer'],
    filterName: 'id',
    otherFilterNames: [TENANT],
  },
  values: { name: NEW_NAME },
  recordId: RECORD_ID,
  keptKeys: [],
  pageKeyPriorValues: [{ key: TENANT, value: TENANT_VALUE }, { key: 'id', value: Number(RECORD_ID) }],
  otherFilterValues: [{ key: TENANT, value: TENANT_VALUE }],
  ...overrides,
});

const facts = (query: string, body: Record<string, unknown> = { name: NEW_NAME, id: Number(RECORD_ID), [TENANT]: TENANT_VALUE }): ApiWriteRequestFacts => ({
  method: 'PATCH',
  url: `${API}${API_PATH}?${query}`,
  headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});
const OWN = `id=eq.${RECORD_ID}&${TENANT}=eq.${String(TENANT_VALUE)}&select=id,name`;

describe('DEF-198: the check of an update with a tenant filter', () => {
  it('admits the id and the tenant of the registration, in either order, and returns no value', () => {
    expect(checkApiWritePayload(expectation(), facts(OWN))).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expect(checkApiWritePayload(expectation(), facts(`${TENANT}=eq.${String(TENANT_VALUE)}&select=*&id=eq.${RECORD_ID}`)).decision).toBe('ALLOW');
  });

  it.each<readonly [string, string, Record<string, unknown> | undefined, string]>([
    ['another tenant', `id=eq.${RECORD_ID}&${TENANT}=eq.901&select=*`, undefined, 'FILTER_MISMATCH'],
    ['a neq tenant', `id=eq.${RECORD_ID}&${TENANT}=neq.900&select=*`, undefined, 'FILTER_MISMATCH'],
    ['an in tenant', `id=eq.${RECORD_ID}&${TENANT}=in.(900,901)&select=*`, undefined, 'FILTER_MISMATCH'],
    ['an empty tenant', `id=eq.${RECORD_ID}&${TENANT}=eq.&select=*`, undefined, 'FILTER_MISMATCH'],
    ['another row', `id=eq.1&${TENANT}=eq.900&select=*`, undefined, 'FILTER_MISMATCH'],
    ['no tenant filter', `id=eq.${RECORD_ID}&select=*`, undefined, 'QUERY_MISMATCH'],
    ['two tenant filters', `${OWN}&${TENANT}=eq.901`, undefined, 'QUERY_MISMATCH'],
    ['two id filters', `${OWN}&id=eq.1`, undefined, 'QUERY_MISMATCH'],
    ['an or filter', `${OWN}&or=(id.eq.1)`, undefined, 'QUERY_MISMATCH'],
    ['a filter of a name not approved', `${OWN}&group_id=eq.5`, undefined, 'QUERY_MISMATCH'],
    ['another tenant in the body', OWN, { name: NEW_NAME, id: Number(RECORD_ID), [TENANT]: 901 }, 'BODY_VALUE_MISMATCH'],
    ['another id in the body', OWN, { name: NEW_NAME, id: 1002, [TENANT]: TENANT_VALUE }, 'BODY_VALUE_MISMATCH'],
    ['the tenant as a string in the body', OWN, { name: NEW_NAME, id: Number(RECORD_ID), [TENANT]: '900' }, 'BODY_VALUE_TYPE_MISMATCH'],
  ])('stops %s', (_label, query, body, decision) => {
    expect(checkApiWritePayload(expectation(), facts(query, body)).decision).toBe(decision);
  });

  it('stops another tenant even when the filter and the body agree on it', () => {
    expect(checkApiWritePayload(expectation(), facts(`id=eq.${RECORD_ID}&${TENANT}=eq.901&select=*`,
      { name: NEW_NAME, id: Number(RECORD_ID), [TENANT]: 901 })).decision).toBe('FILTER_MISMATCH');
  });

  it.each<readonly [string, Partial<ApiWritePayloadExpectation>]>([
    // Guard の写しが照らす値を落とした期待（`snapshotApiWriteExpectation` が写さない形）は、照合が止める。
    ['no values of the other filters (dropped by a copy)', { otherFilterValues: undefined }],
    ['values without other filter names', { spec: { ...expectation().spec, otherFilterNames: undefined } }],
    ['a value of another name', { otherFilterValues: [{ key: 'group_id', value: 5 }] }],
    ['an empty value', { otherFilterValues: [{ key: TENANT, value: '' }] }],
    ['a boolean value', { otherFilterValues: [{ key: TENANT, value: true }] }],
    ['a body prior of the tenant other than the filter value', { pageKeyPriorValues: [{ key: TENANT, value: 901 }, { key: 'id', value: Number(RECORD_ID) }] }],
    ['a body prior of the id other than the ledger id', { pageKeyPriorValues: [{ key: TENANT, value: TENANT_VALUE }, { key: 'id', value: 1002 }] }],
    ['the id filter as an other filter', { spec: { ...expectation().spec, otherFilterNames: ['id'] }, otherFilterValues: [{ key: 'id', value: 1 }] }],
    ['select as an other filter', { spec: { ...expectation().spec, otherFilterNames: ['select'] }, otherFilterValues: [{ key: 'select', value: 1 }] }],
  ])('treats %s as an invalid expectation', (_label, overrides) => {
    expect(checkApiWritePayload(expectation(overrides), facts(OWN)).decision).toBe('EXPECTATION_INVALID');
  });

  it('admits the copy of the values of the other filters made by the copy of the guard (`apiWritePriorValuesCopyOf`)', () => {
    const copied = apiWritePriorValuesCopyOf(expectation().otherFilterValues) as ApiWritePayloadExpectation['otherFilterValues'];
    expect(checkApiWritePayload(expectation({ otherFilterValues: copied }), facts(OWN)).decision).toBe('ALLOW');
  });
});
