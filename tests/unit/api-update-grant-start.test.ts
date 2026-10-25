// T41b（Task 41 の設計書 3.2、8 章の「T41a・T41c の報告と設計者の判断」）: API の更新（UPDATE）の許可・開始・IPC。
// - 許可: 許可の拒否の理由に `SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID` を足す（発行の確かめ直し。文言はカタログ）。
// - 台帳の結び付け（設計者の判断 (1)）: API の更新は、台帳の URL の型の `{id}` の位置（区切りの番号）と、`{id}` より前の区切りがすべて同じであることだけを
//   求める（後ろの区切りは違ってよい）。要素から ID を取る台帳は、更新の画面の型の `{id}` の後ろに ID の区切りがないこと。form の更新の判定は変えない。
// - 開始の指定（設計者の判断 (2)）: `transport: 'API'`、`api` はシナリオの API の指定のまま、`values` は変える鍵だけ、`update: { targetRecordId }`、
//   書き込みの画面は台帳の画面の path の型に対象の ID を入れた具体的な path。保つ鍵とページが決める鍵の値は持たない。
// - IPC: `WRITE_UPDATE` のときだけ `update` を持ち、手書きの確かめと Schema の両方で縛る。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_GRANT_REJECTION_REASONS } from '../../src/control/approval/execution-grant.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { apiUpdateLedgerBindingRejectionOf, isUpdatePathBoundToLedger, validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerStartApiWrite,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
} from '../../src/control/worker-protocol.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { EXECUTION_GRANT_REJECTION_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const EDIT_PATH = '/admin/members/1/edit';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
const LEDGER_ID = 'scenario-ledger';
const GRANT_ID = 'grant-api-u1';
const TARGET_ID = '7';
const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
  readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
};

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
  { name: 'tenant_id', selector: '#tenant', type: 'select-one', marker: null },
];

/** form のない会員の更新の画面の保存（`id=eq.1` の PATCH）。テナントは選んだ欄（ページが決める鍵）。 */
const CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: EDIT_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'PATCH',
      resourceType: 'fetch',
      url: `${API}/rest/v1/members?id=eq.1&select=*`,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1], score: Number(MARKERS[2]), tenant_id: 'tenant-1' }) },
    }, { pagePath: EDIT_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
};

const TEMPLATE_READ: ReadCheckView = {
  readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, createdAt: '20261018000000', updatedAt: '20261018000000', canceledAt: null,
  definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition,
};
const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
] as const;

/** 下書きの確かめ（T41a）が作る API の更新のシナリオの版（変える鍵は名前、保つ鍵はメールと点数、ページが決める鍵はテナント）。 */
const UPDATE_SCENARIO: ScenarioRevision = (() => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: CANDIDATE.identityDigest,
    transport: 'API',
    fieldNames: ['name'],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: {
      successCondition: null, inputErrorCondition: null, recordId: null,
      readVerification: { readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] },
    },
    api: {
      shapeDigest: CANDIDATE.submissionProbe?.shapeDigest,
      pageKeys: ['tenant_id'],
      filterName: 'id',
      recordId: null,
      ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE_PATH },
      keptKeys: ['email', 'score'],
    },
  }, CANDIDATE, READ_FACTS, {
    scenarioId: null,
    scenarios: [{
      scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
      // T41R-fix-B: 台帳は同じ表の API の登録。
      apiRequest: { origin: API, pathShape: '/rest/v1/members' },
    }],
    approvedServiceOrigins: [API],
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
})();

const VALUES = Object.freeze({ name: '更新 太郎' });

const SEED_RECORD: SeedRecord = {
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO.scenarioId, scenarioRevision: UPDATE_SCENARIO.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-10-18',
  attempt: 0,
} as SeedRecord;

const inputsOf = (scenario: ScenarioRevision = UPDATE_SCENARIO, targetRecordId: string | null = TARGET_ID) => ({
  scenario,
  evidence: CANDIDATE,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: SEED_RECORD,
  values: VALUES,
  readCheck: TEMPLATE_READ,
  targetPage: { origin: SAMPLE_ORIGIN, path: TEMPLATE_PATH },
  targetRecordId,
  approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
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

const startOf = (write: unknown, jobKind: WorkerJobKind = 'WRITE_UPDATE'): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-api-u1',
  jobKind,
  targetConfigPath: 'local/targets/example-api.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [SAMPLE_ORIGIN],
    approvedServiceOrigins: [API],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [SAMPLE_ORIGIN], { jobKind, automatedLogin: null, approvedServiceOrigins: [API] }),
  },
  write,
});

const errorsOf = (value: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage(value);
  return checked.ok ? [] : checked.errors;
};

/** 開始の指定（作れることを確かめた写し。IPC の表の元）。 */
const SPEC = writeStartSpecOf(inputsOf());
const specWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...(SPEC as unknown as Record<string, unknown>), ...overrides });
const apiWith = (overrides: Record<string, unknown>): Record<string, unknown> =>
  specWith({ api: { ...(SPEC !== null && isWorkerStartApiWrite(SPEC) ? SPEC.api : {}), ...overrides } });

describe('T41b: the grant of an API UPDATE', () => {
  // LG-3b: 送り方の判定 `apiWriteRejectionOf` は捨てた。T41a の契約のない API の更新が保存・読み出しで止まる確かめは
  // `scenario-api-update-contract.test.ts` の `rejects an API UPDATE %s (saved before T41a)`、契約のある API の更新に許可を出す確かめは
  // `tests/integration/api-update-grant-start.test.ts`。
  it('has the reason of the filter not bound to the ledger id at the end of the closed list, with its description', () => {
    expect(EXECUTION_GRANT_REJECTION_REASONS.at(-1)).toBe('SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID');
    expect(EXECUTION_GRANT_REJECTION_DESCRIPTIONS.SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID.description.length).toBeGreaterThan(0);
  });
});

describe('T41b: the binding of an API UPDATE to the ledger (the designer decision (1))', () => {
  // T41R-fix-B: 更新と台帳は同じ表（同じ API の Origin と path の型）。この表は画面の型の結び付けだけを見る。
  const update = { filterName: 'id', formPathTemplate: TEMPLATE_PATH, origin: API, pathShape: '/rest/v1/members' };
  const SAME_RESOURCE = { origin: API, pathShape: '/rest/v1/members' };
  const urlLedger = (pathPattern: string) => ({ apiRecordId: null, apiRequest: SAME_RESOURCE, recordId: { source: 'URL_PATH_PATTERN', pathPattern } as const });

  it.each<readonly [string, ReturnType<typeof urlLedger> | {
    readonly apiRecordId: null; readonly apiRequest: typeof SAME_RESOURCE; readonly recordId: { readonly source: 'ELEMENT'; readonly selector: string };
  }, string, string | null]>([
    ['the same segments before {id} and other segments after it', urlLedger('/admin/members/{id}'), TEMPLATE_PATH, null],
    ['the same template', urlLedger(TEMPLATE_PATH), TEMPLATE_PATH, null],
    ['another position of {id}', urlLedger('/members/{id}/edit'), TEMPLATE_PATH, 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID'],
    ['other segments before {id}', urlLedger('/admin/groups/{id}'), TEMPLATE_PATH, 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID'],
    ['an element ledger and no id segment after {id}', { apiRecordId: null, apiRequest: SAME_RESOURCE, recordId: { source: 'ELEMENT', selector: '#id' } },
      TEMPLATE_PATH, null],
    ['an element ledger and an id segment after {id}', { apiRecordId: null, apiRequest: SAME_RESOURCE, recordId: { source: 'ELEMENT', selector: '#id' } },
      '/admin/orgs/{id}/members/1/edit',
      'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID'],
  ])('judges %s', (_label, ledger, formPathTemplate, reason) => {
    expect(apiUpdateLedgerBindingRejectionOf({ ...update, formPathTemplate }, ledger)).toBe(reason);
  });

  it('keeps the binding of a form UPDATE as it is (the segments after {id} are the same, the segments before it end the same)', () => {
    expect(isUpdatePathBoundToLedger('/admin/members/{id}/edit', { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' })).toBe(false);
    expect(isUpdatePathBoundToLedger('/admin/members/{id}', { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' })).toBe(true);
    expect(isUpdatePathBoundToLedger('/members/{id}/edit', { source: 'ELEMENT', selector: '#id' })).toBe(false);
    expect(isUpdatePathBoundToLedger('/members/{id}', { source: 'ELEMENT', selector: '#id' })).toBe(true);
  });
});

// T41R-fix-B（Task 41 の設計書 8 章の「T41R の完全版」の I-1）: API の更新の台帳は API の登録に限り、登録の API の Origin と path の型が更新と同じ（同じ表）
// であることを求める（保存・発行・開始の画面が同じ部品 `apiUpdateLedgerBindingRejectionOf` を通る）。理由は `SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID`
// を使い回す（台帳の ID が更新の filter の行に結び付かない）。画面の型の結び付けは今の緩めのまま。
describe('T41R-fix-B: the ledger of an API UPDATE is an API CREATE of the same resource', () => {
  const update = { filterName: 'id', formPathTemplate: TEMPLATE_PATH, origin: API, pathShape: '/rest/v1/members' };
  const apiLedger = { recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } as const, apiRequest: { origin: API, pathShape: '/rest/v1/members' } };

  it.each<readonly [string, Record<string, unknown>, string | null]>([
    ['the same origin and path shape', apiLedger, null],
    ['the same resource with a URL pattern ledger bound to the page', { ...apiLedger, apiRecordId: null, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' } },
      null],
    ['another path shape (another table)', { ...apiLedger, apiRequest: { origin: API, pathShape: '/rest/v1/orders' } }, 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID'],
    ['another origin', { ...apiLedger, apiRequest: { origin: 'http://127.0.0.3:4174', pathShape: '/rest/v1/members' } }, 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID'],
    ['a form CREATE ledger (no API request)', { recordId: { source: 'URL_PATH_PATTERN', pathPattern: TEMPLATE_PATH }, apiRecordId: null, apiRequest: null },
      'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID'],
    ['a ledger fact without the API request (unknown)', { recordId: null, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } },
      'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID'],
  ])('judges %s', (_label, ledger, reason) => {
    expect(apiUpdateLedgerBindingRejectionOf(update, ledger as never)).toBe(reason);
  });

  it('rejects a draft whose ledger is a CREATE of another table or a form CREATE', () => {
    const contextOf = (ledger: Record<string, unknown>) => ({
      scenarioId: null,
      scenarios: [{ scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE' as const, ...ledger }],
      approvedServiceOrigins: [API],
      profileRevisions: { discoveryJob: 2, current: 2 },
    });
    const draft = {
      profileId: PROFILE_ID, candidateIdentityDigest: CANDIDATE.identityDigest, transport: 'API', fieldNames: ['name'], readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, approvalTtlDays: 30,
      api: {
        shapeDigest: CANDIDATE.submissionProbe?.shapeDigest, pageKeys: ['tenant_id'], filterName: 'id', recordId: null,
        ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE_PATH },
      },
    };
    const codes = (ledger: Record<string, unknown>) => {
      const result = validateScenarioDraft(draft, CANDIDATE, READ_FACTS, contextOf(ledger));
      return result.ok ? [] : result.errors.map(({ code }) => code);
    };
    expect(codes(apiLedger)).toEqual([]);
    expect(codes({ ...apiLedger, apiRequest: { origin: API, pathShape: '/rest/v1/orders' } })).toEqual(['SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']);
    expect(codes({ recordId: { source: 'URL_PATH_PATTERN', pathPattern: TEMPLATE_PATH }, apiRecordId: null, apiRequest: null }))
      .toEqual(['SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']);
  });
});

describe('T41b: the START of an API UPDATE (the designer decision (2))', () => {
  it('makes the API write specification with the target id, the concrete page path and the values of the changed keys only', () => {
    expect(SPEC).toEqual({
      transport: 'API',
      scenarioId: UPDATE_SCENARIO.scenarioId,
      scenarioRevision: UPDATE_SCENARIO.revision,
      grantId: GRANT_ID,
      profileId: PROFILE_ID,
      seedRecord: SEED_RECORD,
      formPage: { origin: SAMPLE_ORIGIN, path: `/admin/members/${TARGET_ID}/edit` },
      candidate: { identityDigest: CANDIDATE.identityDigest, ruleDigest: CANDIDATE.ruleDigest },
      submitterIdentityDigest: CANDIDATE.identityDigest,
      api: UPDATE_SCENARIO.api,
      values: VALUES,
      verification: { successCondition: null, inputErrorCondition: null, recordId: null },
      readVerification: {
        readCheckId: 'rc-page',
        readCheckRevision: 1,
        targetPage: { origin: SAMPLE_ORIGIN, path: TEMPLATE_PATH },
        definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: VALUES.name }] },
      },
      // T41R2-fix-B・T41R3-fix-B: 台帳の値の履歴を渡さなければ、最後に分かっている保つ鍵の値はない。
      update: { targetRecordId: TARGET_ID, knownKeptValues: [] },
      approvalFacts: inputsOf().approvalFacts,
    });
    expect(errorsOf(startOf(SPEC))).toEqual([]);
    // 保つ鍵とページが決める鍵の値、probe の目印は持たない。
    expect(JSON.stringify(SPEC)).not.toContain('tenant-1');
    expect(JSON.stringify(SPEC)).not.toContain('bsprobe');
  });

  it.each<readonly [string, () => ReturnType<typeof writeStartSpecOf>]>([
    ['no target id', () => writeStartSpecOf(inputsOf(UPDATE_SCENARIO, null))],
    ['a target id that is not put into the template', () => writeStartSpecOf(inputsOf(UPDATE_SCENARIO, 'a/b'))],
    // LG-3b: 行 `an API UPDATE saved before T41a`（送り方の判定で止める）は捨てた。その版は、スキーマが拒むので読まれず、開始の口まで来ない。
  ])('makes no specification for %s', (_label, make) => {
    expect(make()).toBeNull();
  });
});

describe('T41b: the IPC rules of an API UPDATE START', () => {
  it('has the update block in the schema of the API write, with the target id of the form update block', () => {
    const update = SCHEMA.$defs['startApiWrite']?.properties['update'];
    // T41R2-fix-B・T41R3-fix-B: 最後に分かっている保つ鍵の値の一覧も必須（`api-update-known-filled.test.ts`）。
    expect(update).toMatchObject({ type: 'object', additionalProperties: false, required: ['targetRecordId', 'knownKeptValues'] });
    expect((update?.['properties'] as Record<string, unknown>)['targetRecordId'])
      .toEqual({ $ref: '#/$defs/startWrite/properties/update/properties/targetRecordId' });
  });

  it.each<readonly [string, () => Record<string, unknown>, WorkerJobKind, string]>([
    ['an update block in a WRITE_CREATE', () => specWith({}), 'WRITE_CREATE', '/write/update is required for WRITE_UPDATE and allowed only for it'],
    ['no update block in a WRITE_UPDATE', () => {
      const { update: _update, ...rest } = specWith({});
      return rest;
    }, 'WRITE_UPDATE', '/write/update is required for WRITE_UPDATE and allowed only for it'],
    ['a POST request', () => apiWith({ request: { ...(UPDATE_SCENARIO.api?.request ?? {}), method: 'POST' } }), 'WRITE_UPDATE',
      '/write/api must be the spec of an UPDATE'],
    ['no filter name', () => apiWith({ filterName: null }), 'WRITE_UPDATE', '/write/api must be the spec of an UPDATE'],
    ['no ledger', () => apiWith({ ledger: null }), 'WRITE_UPDATE', '/write/api must be the spec of an UPDATE'],
    ['no templated identity digest', () => {
      const { templatedIdentityDigest: _digest, ...rest } = UPDATE_SCENARIO.api ?? ({} as never);
      return specWith({ api: rest });
    }, 'WRITE_UPDATE', '/write/api must be the spec of an UPDATE'],
    ['no kept keys', () => {
      const { keptKeys: _kept, ...rest } = UPDATE_SCENARIO.api ?? ({} as never);
      return specWith({ api: rest });
    }, 'WRITE_UPDATE', '/write/api must be the spec of an UPDATE'],
    ['a kept key that is also changed', () => apiWith({ keptKeys: [...(UPDATE_SCENARIO.api?.keptKeys ?? []), ...(UPDATE_SCENARIO.api?.keyFields ?? [])] }),
      'WRITE_UPDATE', '/write/api/keptKeys must be keys of the fields, each once, that are not changed and not decided by the page'],
    ['a page key without the field identity', () => apiWith({ pageKeys: [{ key: 'tenant_id', type: 'string' }] }), 'WRITE_UPDATE',
      '/write/api/pageKeys of an UPDATE must have the field identity'],
    ['a value of a kept key', () => specWith({ values: { ...VALUES, email: 'kept@example.invalid' } }), 'WRITE_UPDATE',
      '/write/values must have a value for each key of the fields only, and no secret-like name'],
    ['a null value of a changed key', () => specWith({ values: { name: null } }), 'WRITE_UPDATE', '/write/values of an UPDATE must have a new value for each changed key'],
    ['a page of another record', () => specWith({ formPage: { origin: SAMPLE_ORIGIN, path: '/admin/members/8/edit' } }), 'WRITE_UPDATE',
      '/write/formPage/path must be the form path template of the ledger with the target record id'],
  ])('rejects %s', (_label, make, jobKind, error) => {
    const errors = errorsOf(startOf(make(), jobKind));
    expect(errors.filter((text) => text.startsWith(error)), JSON.stringify(errors)).toHaveLength(1);
  });

  // T41R2-fix-B・T41R3-fix-B（Task 41 の設計書 8 章の「T41R3」の C-3）: 最後に分かっている保つ鍵の値の一覧（空を含む）。開始の指定が台帳の値の履歴から求め、
  // IPC が縛る（値は BeakSight が作ったテストの値で、`values` と同じ扱い）。
  it('puts the last known values of the kept keys by the ledger into the update block, the empty one too', () => {
    const spec = writeStartSpecOf({
      ...inputsOf(),
      ledgerWrites: [
        { writeKind: 'CREATE', recordId: TARGET_ID, targetRecordId: null, result: 'VERIFIED', submittedValues: { name: 'a', email: 'e@example.invalid', score: '' },
          submittedAt: '20261018000000', recordedAt: '20261018000000' },
      ],
    });
    expect(spec !== null && isWorkerStartApiWrite(spec) ? spec.update : null).toEqual({
      targetRecordId: TARGET_ID, knownKeptValues: [{ key: 'email', value: 'e@example.invalid' }, { key: 'score', value: '' }],
    });
    expect(errorsOf(startOf(spec))).toEqual([]);
  });

  it.each<readonly [string, unknown, boolean]>([
    ['a changed key', [{ key: 'name', value: 'a' }], true],
    ['a key decided by the page', [{ key: 'tenant_id', value: 't' }], true],
    ['a key that is not in the request', [{ key: 'other', value: 'o' }], true],
    ['a duplicate key', [{ key: 'email', value: 'a@example.invalid' }, { key: 'email', value: 'b@example.invalid' }], true],
    ['too many items (by the schema)', Array.from({ length: 65 }, (_value, index) => ({ key: `key${index}`, value: 'v' })), false],
    ['a value over the length limit (by the schema)', [{ key: 'email', value: 'x'.repeat(8_193) }], false],
    ['a value that is not a string (by the schema)', [{ key: 'email', value: null }], false],
    ['another property (by the schema)', [{ key: 'email', value: 'e', field: 'x' }], false],
    ['no list (by the schema)', undefined, false],
  ])('rejects a known kept value list with %s', (_label, knownKeptValues, byRule) => {
    const errors = errorsOf(startOf(specWith({ update: { targetRecordId: TARGET_ID, ...(knownKeptValues === undefined ? {} : { knownKeptValues }) } })));
    expect(errors).not.toEqual([]);
    if (byRule) {
      expect(errors).toContain('/write/update/knownKeptValues must be kept keys of the API spec, each once');
    }
  });

  it('writes no value into the errors of the known kept values', () => {
    const errors = errorsOf(startOf(specWith({ update: { targetRecordId: TARGET_ID, knownKeptValues: [{ key: 'other', value: 'secret-kept-value-example' }] } })));
    expect(errors).not.toEqual([]);
    expect(JSON.stringify(errors)).not.toContain('secret-kept-value-example');
  });

  it('rejects a target id that is not of the record id form (by the schema)', () => {
    for (const targetRecordId of ['', '../7', '7/edit', 'a'.repeat(65)]) {
      expect(errorsOf(startOf(specWith({ update: { targetRecordId, knownKeptValues: [] } })))).not.toEqual([]);
    }
    expect(errorsOf(startOf(specWith({ update: { targetRecordId: TARGET_ID, knownKeptValues: [], keptValues: {} } })))).not.toEqual([]);
  });
});
