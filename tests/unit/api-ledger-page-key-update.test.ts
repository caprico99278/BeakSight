// DEF-203（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 5.10）: 番号と所属の絞り込みのある更新（5.9 の形）の本文に、編集の画面の欄と
// 結びつかない鍵（文字・真偽・null）がある形（純粋な部品の表）。
// - 型の入口（`apiScenarioShapeRejectionOf`）: 登録の形のページが決める鍵にある鍵だけ `SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE` にしない。登録の側にない鍵、
//   絞り込み 1 つの形は今のまま止める。
// - 下書きの確かめ: 台帳の登録のページが決める鍵（`apiPageKeyNames`）にある鍵だけ受け、照らす鍵の名前の一覧（`api.ledgerPageKeys`）を probe と台帳から作る。
// - 承認の digest: 照らす鍵の一覧が空でないときだけ値が変わる。
// - 開始の指定（`writeStartSpecOf`）と IPC: 照らす値は、登録の成果物のページが決めた値（JSON の型のまま）。値がない鍵があれば作らない。
// - 照合（`checkApiWritePayload`）: 本文の値は照らす値と型も値も完全一致。値を変えた・型を変えた・鍵を足した本文は止める。
// - 自動の下書き（`apiAutoDraftPlanOf`）: 登録が新しく作るときも、既にあるときも、更新の行を作れる。
import { describe, expect, it } from 'vitest';
import { apiAutoDraftPlanOf, type AutoDraftScenarioFact } from '../../src/control/approval/api-scenario-autodraft.js';
import { approvalDigestEntriesOf, computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import type { ScenarioKindFact, ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { apiScenarioShapeRejectionOf, validateScenarioDraft, type ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerStartApiWrite,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { checkApiWritePayload, type ApiWritePayloadExpectation, type ApiWriteRequestFacts } from '../../src/safety/api-write-payload-policy.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const ITEMS = '/rest/v1/items';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b'];
const NEW_PATH = '/admin/items/new';
const EDIT_PATH = '/admin/items/1';
const TEMPLATE_PATH = '/admin/items/{id}';
const LEDGER_ID = 'scenario-ledger';
const GRANT_ID = 'grant-def-203';
const TARGET_ID = '7';
const TENANT = 'account_id';
const TENANT_VALUE = 900;
/** 欄と結びつかない鍵（文字・真偽・null）と、登録の時にページが入れた値。 */
const EXTRAS = Object.freeze({ label: 'standard', pinned: false, picture: null });
const EXTRA_KEYS = Object.freeze(['label', 'picture', 'pinned']);
const HEADERS = { 'content-type': 'application/json', prefer: 'return=representation' };
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: null, selector: '#item-title', type: 'text', marker: 0 },
  { name: null, selector: '#item-note', type: 'textarea', marker: 1 },
];

const buttonOf = (pagePath: string, method: string, url: string, body: Record<string, unknown>): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method, resourceType: 'xhr', url, origin: { kind: 'APPROVED_API', index: 0 }, headers: HEADERS,
      body: { kind: 'TEXT', text: JSON.stringify(body) },
    }, { pagePath, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 1, unrecordedShapeCount: 0,
  }, { filledFieldCount: 2, skippedFieldCount: 0 }, INPUT_FIELDS),
});

const MARKED = { title: MARKERS[0], note: MARKERS[1] };
const CREATE = buttonOf(NEW_PATH, 'POST', `${API}${ITEMS}?select=*`, { ...MARKED, [TENANT]: TENANT_VALUE, ...EXTRAS });
const UPDATE = buttonOf(EDIT_PATH, 'PATCH', `${API}${ITEMS}?id=eq.1&select=*&${TENANT}=eq.${String(TENANT_VALUE)}`,
  { ...MARKED, id: 1, [TENANT]: TENANT_VALUE, ...EXTRAS });
/** 絞り込み 1 つの形（所属の絞り込みがない。今のまま止める）。 */
const ONE_FILTER_UPDATE = buttonOf(EDIT_PATH, 'PATCH', `${API}${ITEMS}?id=eq.1&select=*`, { ...MARKED, id: 1, [TENANT]: TENANT_VALUE, ...EXTRAS });

const ledgerFactOf = (apiPageKeyNames?: readonly string[] | null): ScenarioKindFact => ({
  scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  apiRequest: { origin: API, pathShape: ITEMS },
  ...(apiPageKeyNames === undefined ? {} : { apiPageKeyNames }),
});
const contextOf = (scenarios: readonly ScenarioKindFact[]): ScenarioDraftContext => ({
  scenarioId: null, scenarios, approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 },
});
const ALL_PAGE_KEYS = [TENANT, ...EXTRA_KEYS];

const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
] as const;

const draftOf = (candidate: DiscoveryCandidate, ledger: ScenarioKindFact, pageKeys: readonly string[] = [TENANT, 'id', ...EXTRA_KEYS]) => validateScenarioDraft({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames: ['title'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: {
    resultJudgement: null, recordId: null,
    readVerification: { readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'title' }] },
  },
  api: {
    shapeDigest: candidate.submissionProbe?.shapeDigest,
    pageKeys: [...pageKeys],
    filterName: 'id',
    recordId: null,
    ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE_PATH },
    keptKeys: ['note'],
  },
}, candidate, READ_FACTS, contextOf([ledger]));

const codesOf = (result: ReturnType<typeof draftOf>): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));

const UPDATE_SCENARIO: ScenarioRevision = (() => {
  const result = draftOf(UPDATE, ledgerFactOf(ALL_PAGE_KEYS));
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
})();

describe('DEF-203: the shape entry of an update with keys that are not bound to a field', () => {
  it('keeps rejecting the shape without the page keys of the create (as now)', () => {
    expect(apiScenarioShapeRejectionOf(UPDATE.submissionProbe as never)).toBe('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
  });

  it('accepts the shape when every such key is a page key of the create', () => {
    expect(apiScenarioShapeRejectionOf(UPDATE.submissionProbe as never, ALL_PAGE_KEYS)).toBeNull();
  });

  it('rejects the shape when one key is not a page key of the create', () => {
    expect(apiScenarioShapeRejectionOf(UPDATE.submissionProbe as never, [TENANT, 'label', 'pinned'])).toBe('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
  });

  it('keeps rejecting the shape of one filter (no tenant filter) even with the page keys of the create', () => {
    expect(apiScenarioShapeRejectionOf(ONE_FILTER_UPDATE.submissionProbe as never, ALL_PAGE_KEYS)).toBe('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
  });
});

describe('DEF-203: the draft of an update with keys that are not bound to a field', () => {
  it('accepts the keys that are page keys of the ledger and makes the list of the keys to compare from the probe and the ledger', () => {
    expect(UPDATE_SCENARIO.api).toMatchObject({
      filterName: 'id',
      otherFilterNames: [TENANT],
      ledgerPageKeys: [...EXTRA_KEYS],
      pageKeys: [
        { key: TENANT, type: 'number' }, { key: 'id', type: 'number' }, { key: 'label', type: 'string' }, { key: 'picture', type: 'null' },
        { key: 'pinned', type: 'boolean' },
      ],
    });
    expect(UPDATE_SCENARIO.api?.pageKeys.every(({ field }) => field === undefined)).toBe(true);
  });

  it.each<readonly [string, readonly string[] | null | undefined]>([
    ['a ledger without the page key names (an old fact)', undefined],
    ['a ledger with unknown page key names', null],
    ['a ledger that does not send one of the keys', [TENANT, 'label', 'pinned']],
  ])('rejects the draft for %s', (_label, names) => {
    expect(codesOf(draftOf(UPDATE, ledgerFactOf(names)))).toContain('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
  });

  it('keeps rejecting the draft of one filter (no tenant filter)', () => {
    expect(codesOf(draftOf(ONE_FILTER_UPDATE, ledgerFactOf(ALL_PAGE_KEYS), [TENANT, 'id', ...EXTRA_KEYS])))
      .toContain('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
  });
});

const DIGEST_FACTS = { profileRevision: 2, authSetupDigest: null, targetConfigDigest: `sha256:${'a'.repeat(64)}`, inputRuleDigest: null } as never;

describe('DEF-203: the approval digest', () => {
  it('adds the keys to compare only when there are some', () => {
    const { ledgerPageKeys: _keys, ...withoutKeys } = UPDATE_SCENARIO.api ?? ({} as never);
    const plain: ScenarioRevision = { ...UPDATE_SCENARIO, api: withoutKeys };
    expect(approvalDigestEntriesOf(UPDATE_SCENARIO, DIGEST_FACTS).apiPageKeys)
      .toEqual([approvalDigestEntriesOf(plain, DIGEST_FACTS).apiPageKeys, ['LEDGER_PAGE_KEYS', ...EXTRA_KEYS]]);
    expect(computeApprovalDigest(UPDATE_SCENARIO, DIGEST_FACTS)).not.toBe(computeApprovalDigest(plain, DIGEST_FACTS));
    expect(computeApprovalDigest({ ...plain, api: { ...withoutKeys, ledgerPageKeys: [] } }, DIGEST_FACTS)).toBe(computeApprovalDigest(plain, DIGEST_FACTS));
  });
});

const TEMPLATE_READ: ReadCheckView = {
  readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, createdAt: '20261105000000', updatedAt: '20261105000000', canceledAt: null,
  definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition,
};
const SEED_RECORD: SeedRecord = {
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO.scenarioId, scenarioRevision: UPDATE_SCENARIO.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-11-05',
  attempt: 0,
} as SeedRecord;
/** 登録の成果物のページが決めた値（JSON の scalar を JSON の文字列にした形）。 */
const CREATE_VALUES = Object.freeze({ [TENANT]: String(TENANT_VALUE), label: '"standard"', pinned: 'false', picture: 'null' });

const inputsOf = (createPageKeyValues: Readonly<Record<string, string | null>> | null | undefined) => ({
  scenario: UPDATE_SCENARIO,
  evidence: UPDATE,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: SEED_RECORD,
  values: { title: '更新の題' },
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
    protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-def-203', jobKind: 'WRITE_UPDATE', targetConfigPath: 'local/targets/example-api.json', startNew: true,
    targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
    authentication: {
      setup: SETUP, approvedTestOrigins: [SAMPLE_ORIGIN], approvedServiceOrigins: [API],
      authenticationSha256: workerAuthenticationDigestOf(SETUP, [SAMPLE_ORIGIN], { jobKind: 'WRITE_UPDATE', automatedLogin: null, approvedServiceOrigins: [API] }),
    },
    write,
  });
  return checked.ok ? [] : checked.errors;
};

describe('DEF-203: the START of an update with keys to compare', () => {
  it('puts the values decided by the page at the registration, as JSON values, and passes the IPC rules', () => {
    const spec = writeStartSpecOf(inputsOf(CREATE_VALUES));
    expect(spec !== null && isWorkerStartApiWrite(spec) ? spec.update : null).toEqual({
      targetRecordId: TARGET_ID, knownKeptValues: [], otherFilterValues: [{ key: TENANT, value: TENANT_VALUE }],
      ledgerKeyValues: [{ key: 'label', value: 'standard' }, { key: 'picture', value: null }, { key: 'pinned', value: false }],
    });
    expect(errorsOf(spec)).toEqual([]);
  });

  it.each<readonly [string, Readonly<Record<string, string | null>> | null | undefined]>([
    ['no values kept by the parent', undefined],
    ['no value of one key', { [TENANT]: String(TENANT_VALUE), label: '"standard"', pinned: 'false' }],
    ['the cut mark of a long value', { ...CREATE_VALUES, label: null }],
    ['a text that is not JSON', { ...CREATE_VALUES, pinned: 'not json' }],
  ])('makes no specification (sends nothing) for %s', (_label, values) => {
    expect(writeStartSpecOf(inputsOf(values))).toBeNull();
  });

  it.each<readonly [string, (update: Record<string, unknown>) => Record<string, unknown>]>([
    ['no values of the keys to compare', ({ ledgerKeyValues: _values, ...rest }) => rest],
    ['a value of a name that is not a key to compare', (update) => ({
      ...update, ledgerKeyValues: [{ key: 'label', value: 'standard' }, { key: 'picture', value: null }, { key: 'other', value: false }],
    })],
    ['two values of the same name', (update) => ({
      ...update, ledgerKeyValues: [{ key: 'label', value: 'a' }, { key: 'label', value: 'b' }, { key: 'pinned', value: false }],
    })],
  ])('rejects the START with %s', (_label, change) => {
    const spec = writeStartSpecOf(inputsOf(CREATE_VALUES)) as unknown as Record<string, unknown>;
    const errors = errorsOf({ ...spec, update: change(spec['update'] as Record<string, unknown>) });
    expect(errors.some((text) => text.startsWith('/write/update/ledgerKeyValues')), JSON.stringify(errors)).toBe(true);
  });
});

const RECORD_ID = '1001';
const NEW_TITLE = 'leak-marker-new';
const LEDGER_VALUES = [{ key: 'label', value: 'standard' }, { key: 'picture', value: null }, { key: 'pinned', value: false }] as const;

const expectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: {
    request: { method: 'PATCH', origin: API, pathShape: ITEMS, queryNames: ['select'], contentType: 'application/json', prefer: ['return=representation'] },
    keyFields: [{ key: 'title', type: 'string' }],
    pageKeys: [
      { key: TENANT, type: 'number' }, { key: 'id', type: 'number' }, { key: 'label', type: 'string' }, { key: 'picture', type: 'null' },
      { key: 'pinned', type: 'boolean' },
    ],
    headerNames: ['content-type', 'prefer'],
    filterName: 'id',
    otherFilterNames: [TENANT],
    ledgerPageKeys: [...EXTRA_KEYS],
  },
  values: { title: NEW_TITLE },
  recordId: RECORD_ID,
  keptKeys: [],
  pageKeyPriorValues: [{ key: TENANT, value: TENANT_VALUE }, { key: 'id', value: Number(RECORD_ID) }, ...LEDGER_VALUES],
  otherFilterValues: [{ key: TENANT, value: TENANT_VALUE }],
  ledgerKeyValues: [...LEDGER_VALUES],
  ...overrides,
});
const BODY = Object.freeze({ title: NEW_TITLE, id: Number(RECORD_ID), [TENANT]: TENANT_VALUE, ...EXTRAS });
const OWN = `id=eq.${RECORD_ID}&${TENANT}=eq.${String(TENANT_VALUE)}&select=*`;
const facts = (body: Record<string, unknown> = BODY): ApiWriteRequestFacts => ({
  method: 'PATCH',
  url: `${API}${ITEMS}?${OWN}`,
  headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

describe('DEF-203: the check of an update with keys to compare', () => {
  it('admits the values of the registration and returns no value', () => {
    expect(checkApiWritePayload(expectation(), facts())).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
  });

  it.each<readonly [string, Record<string, unknown>, string]>([
    ['a flipped boolean', { ...BODY, pinned: true }, 'BODY_VALUE_MISMATCH'],
    ['another string', { ...BODY, label: 'premium' }, 'BODY_VALUE_MISMATCH'],
    ['a string instead of null', { ...BODY, picture: 'https://example.invalid/a.png' }, 'BODY_VALUE_TYPE_MISMATCH'],
    ['a boolean as a string', { ...BODY, pinned: 'false' }, 'BODY_VALUE_TYPE_MISMATCH'],
    ['an added key', { ...BODY, rank: 1 }, 'BODY_KEY_UNEXPECTED'],
    ['a missing key', (({ label: _label, ...rest }) => rest)(BODY), 'BODY_KEY_MISSING'],
  ])('stops %s', (_label, body, decision) => {
    expect(checkApiWritePayload(expectation(), facts(body)).decision).toBe(decision);
  });

  it.each<readonly [string, Partial<ApiWritePayloadExpectation>]>([
    ['no values of the keys to compare (dropped by a copy)', { ledgerKeyValues: undefined }],
    ['values without the keys to compare', { spec: { ...expectation().spec, ledgerPageKeys: undefined } }],
    ['a missing value', { ledgerKeyValues: LEDGER_VALUES.slice(0, 2) }],
    ['a value of another type than the page key', { ledgerKeyValues: [{ key: 'label', value: 'standard' }, { key: 'picture', value: null }, { key: 'pinned', value: 'false' }] }],
    ['a prior value other than the value to compare', {
      pageKeyPriorValues: [{ key: TENANT, value: TENANT_VALUE }, { key: 'id', value: Number(RECORD_ID) }, { key: 'label', value: 'standard' },
        { key: 'picture', value: null }, { key: 'pinned', value: true }],
    }],
    ['a key to compare that is not a page key', { spec: { ...expectation().spec, ledgerPageKeys: [...EXTRA_KEYS, 'rank'] },
      ledgerKeyValues: [...LEDGER_VALUES, { key: 'rank', value: 1 }] }],
    ['a key to compare that is a filter key', { spec: { ...expectation().spec, ledgerPageKeys: [TENANT, ...EXTRA_KEYS] },
      ledgerKeyValues: [{ key: TENANT, value: TENANT_VALUE }, ...LEDGER_VALUES] }],
  ])('treats %s as an invalid expectation', (_label, overrides) => {
    expect(checkApiWritePayload(expectation(overrides), facts()).decision).toBe('EXPECTATION_INVALID');
  });
});

describe('DEF-203: the automatic draft of the update row', () => {
  const planOf = (scenarios: readonly AutoDraftScenarioFact[], facts: readonly ScenarioKindFact[]) =>
    apiAutoDraftPlanOf({ profileId: PROFILE_ID, candidates: [CREATE, UPDATE], context: contextOf(facts), scenarios });
  const existing: AutoDraftScenarioFact = {
    scenarioId: LEDGER_ID, kind: 'CREATE', state: 'REVOKED', candidateIdentityDigest: CREATE.identityDigest, shapeDigest: CREATE.submissionProbe?.shapeDigest ?? null,
  };

  it('makes the update row when the create is new in the same plan', () => {
    const plan = planOf([], []);
    expect(plan.creates.map(({ status }) => status)).toEqual(['NEW']);
    expect(plan.updates.map(({ status }) => status)).toEqual(['NEW']);
  });

  it('makes the update row when the create already exists (the page keys from the fact of the create)', () => {
    const plan = planOf([existing], [ledgerFactOf(ALL_PAGE_KEYS)]);
    expect(plan.creates.map(({ status }) => status)).toEqual(['EXISTING']);
    expect(plan.updates.map(({ status }) => status)).toEqual(['NEW']);
  });

  it('keeps rejecting the update row when the existing create does not send the keys', () => {
    const plan = planOf([existing], [ledgerFactOf([TENANT])]);
    expect(plan.updates.map((item) => [item.status, item.status === 'REJECTED' ? item.reason : null]))
      .toEqual([['REJECTED', 'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE']]);
  });
});
