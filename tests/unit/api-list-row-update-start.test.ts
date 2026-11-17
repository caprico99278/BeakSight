// LU-8（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D4、5.5 の最後の段（IPC））: 一覧の行の更新の、書き込みの開始と IPC。
// - 開始（`writeStartSpecOf`）: 台帳に `listRow` のある API の更新は、書き込みの画面を一覧の画面の path（番号を入れない）にし、`update.listRow` に
//   行を選ぶ値（台帳の最後に分かっている値 `knownKeptValuesOf`）と、前の値を後から入れる印（保つ鍵の名前。承認のとおり）を入れる。開き手の識別の digest と
//   行を選ぶ欄の名前は、`api.ledger.listRow` のまま（写し直さない）。
// - 送らずに止める（作らない）: 行を選ぶ値がない（空を含む）、今の台帳の登録の入力の規則で行を選ぶ欄が毎回違う欄でない（許可を出す時の確かめ直し）、
//   台帳の登録の毎回違う欄が渡されない（fail-closed）。LU-12b: フォームの `listRow` の START（形 B）も作る。
// - IPC: `listRow` の START を受ける（filter の形・path の形）。一覧の path と書き込みの画面の path の一致、型にした識別の digest を持たないこと、filter と
//   `{id}` のちょうど一方、`update.listRow` の有無と形を縛る。`listRow` のない START は今のまま。
// 値は匿名の合成のテストデータだけ。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScenarioKindFact, ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import type { RecordValueWrite } from '../../src/control/actions/write-result-facts.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf, type WriteStartInputs } from '../../src/control/job/write-job-start.js';
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
import {
  observedSubmissionProbeOf,
  submissionProbeOpenerOf,
  type SubmissionProbeInputField,
} from '../../src/discovery/submission-probe-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import {
  ALL_CONFIRMED,
  FULL_VERIFICATION,
  PROFILE_ID,
  UPDATE_CANDIDATE,
  candidateOf,
  sampleScenario,
  sampleUpdateScenario,
} from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleAction, sampleButton, sampleField, sampleForm } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const LIST_PATH = '/admin/members';
const ITEMS = '/rest/v1/members';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
const LEDGER_ID = 'scenario-ledger';
const GRANT_ID = 'grant-api-lr1';
const TARGET_ID = '4';
const OPENER_DIGEST = `sha256:${'1'.repeat(64)}`;
const ROW_KEY_VALUE = 'row-key-4@example.invalid';
const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
  readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
};

const MARKED_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];

/** 一覧の画面で、行の「編集」を押した後にできた窓の保存の候補（filter の形か path の形の PATCH）。 */
const listCandidateOf = (url: string): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: LIST_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'PATCH',
      resourceType: 'fetch',
      url,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1] }) },
    }, { pagePath: LIST_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: MARKED_FIELDS.length, skippedFieldCount: 0 }, MARKED_FIELDS, ['保存'], submissionProbeOpenerOf(OPENER_DIGEST, true, ['編集'])),
});

const FILTER_CANDIDATE = listCandidateOf(`${API}${ITEMS}?id=eq.4&select=*`);
const PATH_CANDIDATE = listCandidateOf(`${API}${ITEMS}/4`);

const TEMPLATE_READ: ReadCheckView = {
  readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, createdAt: '20261102000000', updatedAt: '20261102000000', canceledAt: null,
  definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition,
};
const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
] as const;

const LEDGER_FACT: ScenarioKindFact = Object.freeze<ScenarioKindFact>({
  scenarioId: LEDGER_ID,
  profileId: PROFILE_ID,
  kind: 'CREATE',
  apiRequest: { origin: API, pathShape: ITEMS },
  apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  uniqueEachRunFieldNames: ['email'],
});

/** 下書きの確かめ（LU-6）が作る一覧の行の更新のシナリオの版（変える鍵は名前、保つ鍵と行を選ぶ欄はメール）。 */
const listRowScenarioOf = (candidate: DiscoveryCandidate, filterName: string | null): ScenarioRevision => {
  const result = validateScenarioDraft({
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
      pageKeys: [],
      filterName,
      recordId: null,
      ledger: {
        targetCreateScenarioId: LEDGER_ID, formPathTemplate: LIST_PATH,
        listRow: { listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' },
      },
      keptKeys: ['email'],
    },
  }, candidate, READ_FACTS, {
    scenarioId: null,
    scenarios: [LEDGER_FACT],
    approvedServiceOrigins: [API],
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
};

const FILTER_SCENARIO = listRowScenarioOf(FILTER_CANDIDATE, 'id');
const PATH_SCENARIO = listRowScenarioOf(PATH_CANDIDATE, null);

const VALUES = Object.freeze({ name: '更新 花子' });

const seedRecordOf = (scenario: ScenarioRevision): SeedRecord => ({
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-11-02',
  attempt: 0,
} as SeedRecord);

/** 台帳の照合済みの登録 1 件（行を選ぶ欄の値と保つ鍵の値）。 */
const LEDGER_WRITES: readonly RecordValueWrite[] = [{
  writeKind: 'CREATE', recordId: TARGET_ID, targetRecordId: null, result: 'VERIFIED',
  submittedValues: { name: '登録 花子', email: ROW_KEY_VALUE }, submittedAt: '20261102000000', recordedAt: '20261102000000',
}];

/** 上書き（`undefined` は項目を省いたのと同じ扱いで、親が渡さない場合を表す）。 */
type InputOverrides = { readonly [K in keyof WriteStartInputs]?: WriteStartInputs[K] | undefined };

const inputsOf = (scenario: ScenarioRevision, candidate: DiscoveryCandidate, overrides: InputOverrides = {}): WriteStartInputs => ({
  scenario,
  evidence: candidate,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: seedRecordOf(scenario),
  values: VALUES,
  readCheck: TEMPLATE_READ,
  targetPage: { origin: SAMPLE_ORIGIN, path: TEMPLATE_PATH },
  targetRecordId: TARGET_ID,
  ledgerWrites: LEDGER_WRITES,
  ledgerUniqueEachRunFieldNames: ['email'],
  approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
  ...overrides,
}) as WriteStartInputs;

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
  jobId: 'job-api-lr1',
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

const FILTER_SPEC = writeStartSpecOf(inputsOf(FILTER_SCENARIO, FILTER_CANDIDATE));
const PATH_SPEC = writeStartSpecOf(inputsOf(PATH_SCENARIO, PATH_CANDIDATE));
const specWith = (overrides: Record<string, unknown>, spec: unknown = FILTER_SPEC): Record<string, unknown> =>
  ({ ...(spec as Record<string, unknown>), ...overrides });
const apiOf = (spec: unknown): Record<string, unknown> => (spec as { readonly api: Record<string, unknown> }).api;
const apiWith = (overrides: Record<string, unknown>, spec: unknown = FILTER_SPEC): Record<string, unknown> =>
  specWith({ api: { ...apiOf(spec), ...overrides } }, spec);
const updateOf = (spec: unknown): Record<string, unknown> => (spec as { readonly update: Record<string, unknown> }).update;

describe('LU-8: the START of a list row API UPDATE', () => {
  it.each<readonly [string, ScenarioRevision, ReturnType<typeof writeStartSpecOf>]>([
    ['the filter form', FILTER_SCENARIO, FILTER_SPEC],
    ['the path form', PATH_SCENARIO, PATH_SPEC],
  ])('opens the list page and carries the row key value and the deferred prior values mark (%s)', (_label, scenario, spec) => {
    expect(spec).not.toBeNull();
    expect(spec !== null && isWorkerStartApiWrite(spec)).toBe(true);
    expect(spec?.formPage).toEqual({ origin: SAMPLE_ORIGIN, path: LIST_PATH });
    expect(isWorkerStartApiWrite(spec!) ? spec.api : null).toEqual(scenario.api);
    // 開き手の識別の digest と行を選ぶ欄の名前は、承認した API の指定の台帳の行の選び方のまま。
    expect(isWorkerStartApiWrite(spec!) ? spec.api.ledger?.listRow : null)
      .toEqual({ listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' });
    expect(isWorkerStartApiWrite(spec!) ? spec.update : null).toEqual({
      targetRecordId: TARGET_ID,
      knownKeptValues: [{ key: 'email', value: ROW_KEY_VALUE }],
      listRow: { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: ['email'] } },
    });
    expect(errorsOf(startOf(spec))).toEqual([]);
  });

  it.each<readonly [string, InputOverrides]>([
    ['no verified registration of the target in the ledger (no row key value)', { ledgerWrites: [] }],
    ['an empty row key value', { ledgerWrites: [{ ...LEDGER_WRITES[0]!, submittedValues: { name: 'a', email: '' } }] }],
    ['a registration of another record only', { ledgerWrites: [{ ...LEDGER_WRITES[0]!, recordId: '5' }] }],
    ['a row key field that no longer differs each run by the input rules of the ledger', { ledgerUniqueEachRunFieldNames: ['name'] }],
    ['no unique each run field names of the ledger (fail-closed)', { ledgerUniqueEachRunFieldNames: undefined }],
    ['null unique each run field names of the ledger (fail-closed)', { ledgerUniqueEachRunFieldNames: null }],
  ])('makes no specification (sends nothing) for %s', (_label, overrides) => {
    expect(writeStartSpecOf(inputsOf(FILTER_SCENARIO, FILTER_CANDIDATE, overrides))).toBeNull();
    expect(writeStartSpecOf(inputsOf(PATH_SCENARIO, PATH_CANDIDATE, overrides))).toBeNull();
  });

  it('keeps the START of an API UPDATE without a list row (no list row block, the ledger unique names are not needed)', () => {
    const { listRow: _row, ...ledger } = FILTER_SCENARIO.api!.ledger!;
    const plain: ScenarioRevision = {
      ...FILTER_SCENARIO,
      api: { ...FILTER_SCENARIO.api!, ledger: { ...ledger, formPathTemplate: TEMPLATE_PATH }, templatedIdentityDigest: `sha256:${'3'.repeat(64)}` },
    };
    const spec = writeStartSpecOf(inputsOf(plain, FILTER_CANDIDATE, { ledgerUniqueEachRunFieldNames: undefined }));
    expect(spec?.formPage).toEqual({ origin: SAMPLE_ORIGIN, path: `/admin/members/${TARGET_ID}/edit` });
    expect(spec !== null && isWorkerStartApiWrite(spec) ? spec.update : null)
      .toEqual({ targetRecordId: TARGET_ID, knownKeptValues: [{ key: 'email', value: ROW_KEY_VALUE }] });
    expect(errorsOf(startOf(spec))).toEqual([]);
  });

  it('does not write the row key value into the IPC errors', () => {
    const errors = errorsOf(startOf(specWith({ formPage: { origin: SAMPLE_ORIGIN, path: '/admin/groups' } })));
    expect(errors).not.toEqual([]);
    expect(JSON.stringify(errors)).not.toContain(ROW_KEY_VALUE);
  });
});

// LU-12b（設計書 5.5、4.0 の D5。ユーザーの判断 2026-11-03「台帳との比べをフォームの形にも広げる」）: フォームの一覧の行の更新（形 B）の START。LU-8 の「LU-12 まで
// 作らない」を置き換えた。書き込みの画面は一覧の画面の path（番号を入れない）、送信先は送信先の型に台帳の番号を入れた path、`update.listRow` と保つ欄の台帳の
// 最後の値を持つ。作らない条件は API の形と同じ部品（行を選ぶ値がない・空、行を選ぶ欄が毎回違う欄でない・事実がない、変える欄の新しい値が台帳の値と同じ）。
describe('LU-12b: the START of a list row form UPDATE', () => {
  const FORM_READ: ReadCheckView = {
    readCheckId: 'rc-1', profileId: PROFILE_ID, revision: 2, createdAt: '20261102000000', updatedAt: '20261102000000', canceledAt: null,
    definition: { targetIdentityDigest: `sha256:${'4'.repeat(64)}`, parameters: { q: '' }, expectations: [] } as unknown as ReadCheckDefinition,
  };
  const FORM_LIST_PATH = '/members';
  /** 一覧の行のフォーム（変える欄 `name`、保つ欄で行を選ぶ欄の `email`）。 */
  const ROW_FORM_CANDIDATE = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: FORM_LIST_PATH },
    action: sampleAction('/members/1'),
    methodOverride: 'PATCH',
    submitterText: '保存',
    enctype: 'multipart/form-data',
    fields: [sampleField('name'), sampleField('email', 'email'), sampleField('_method', 'hidden', { hasValue: true })],
  }));
  const FORM_LIST_ROW = { listPagePath: FORM_LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' };
  const formScenarioOf = (listRow: boolean): ScenarioRevision => {
    const base = sampleUpdateScenario({
      verification: {
        ...FULL_VERIFICATION,
        readVerification: { readCheckId: 'rc-1', revision: 2, bindings: [{ parameterName: 'q', fieldName: 'name' }], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] },
      },
    });
    return listRow
      ? { ...base, update: { ...base.update!, formPathTemplate: FORM_LIST_PATH, keepFieldNames: ['email'], listRow: FORM_LIST_ROW } }
      : base;
  };
  const formInputsOf = (scenario: ScenarioRevision, overrides: InputOverrides = {}): WriteStartInputs => ({
    ...inputsOf(scenario, scenario.update?.listRow === undefined ? UPDATE_CANDIDATE : ROW_FORM_CANDIDATE),
    readCheck: FORM_READ,
    targetPage: { origin: SAMPLE_ORIGIN, path: FORM_LIST_PATH },
    targetRecordId: TARGET_ID,
    values: { name: '更新 花子' },
    ...overrides,
  }) as WriteStartInputs;

  it('makes the form UPDATE START without a list row as it was', () => {
    const spec = writeStartSpecOf(formInputsOf(formScenarioOf(false)));
    expect(spec).not.toBeNull();
    expect(spec !== null && !isWorkerStartApiWrite(spec) ? spec.update : null).not.toHaveProperty('listRow');
    expect(spec !== null && !isWorkerStartApiWrite(spec) ? spec.update : null).not.toHaveProperty('knownKeptValues');
  });

  it('opens the list page, sends to the action template with the ledger record id, and carries the row and the ledger values of the kept fields', () => {
    const spec = writeStartSpecOf(formInputsOf(formScenarioOf(true)));
    if (spec === null || isWorkerStartApiWrite(spec)) throw new Error('the list row form START was not made');
    expect(spec.formPage).toEqual({ origin: SAMPLE_ORIGIN, path: FORM_LIST_PATH });
    expect(spec.request.path).toBe(`/members/${TARGET_ID}`);
    expect(spec.update).toEqual({
      targetRecordId: TARGET_ID,
      templatedIdentityDigest: formScenarioOf(true).update?.templatedIdentityDigest,
      changedFieldNames: ['name'],
      keptFieldNames: ['email'],
      knownKeptValues: [{ key: 'email', value: ROW_KEY_VALUE }],
      listRow: { listPagePath: FORM_LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyValue: ROW_KEY_VALUE },
    });
    expect(errorsOf(startOf(spec))).toEqual([]);
  });

  it.each<readonly [string, InputOverrides]>([
    ['no row key value in the ledger', { ledgerWrites: [{ ...LEDGER_WRITES[0]!, submittedValues: { name: '登録 花子' } }] }],
    ['an empty row key value', { ledgerWrites: [{ ...LEDGER_WRITES[0]!, submittedValues: { name: '登録 花子', email: '' } }] }],
    ['a row key field that is no longer unique each run', { ledgerUniqueEachRunFieldNames: ['name'] }],
    ['no fact of the unique fields of the ledger', { ledgerUniqueEachRunFieldNames: undefined }],
    ['a new value that is the last value of the ledger', { values: { name: '登録 花子' } }],
  ])('makes no list row form START for %s', (_label, overrides) => {
    expect(writeStartSpecOf(formInputsOf(formScenarioOf(true), overrides))).toBeNull();
  });

  it('rejects the API list row block in the update block of a form write (by the schema)', () => {
    const spec = writeStartSpecOf(formInputsOf(formScenarioOf(true))) as unknown as Record<string, unknown>;
    const update = updateOf(spec);
    expect(errorsOf(startOf({ ...spec, update: { ...update, listRow: { rowKeyValue: 'x', deferredPriorValues: { keptKeys: [] } } } }))).not.toEqual([]);
  });
});

describe('LU-8: the IPC rules of a list row API UPDATE START', () => {
  it('has the list row block in the update block of the API write schema', () => {
    const update = SCHEMA.$defs['startApiWrite']?.properties['update'] as { readonly properties: Record<string, unknown>; readonly required: readonly string[] };
    expect(update.required).toEqual(['targetRecordId', 'knownKeptValues']);
    expect(update.properties['listRow']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['rowKeyValue', 'deferredPriorValues'],
      properties: {
        // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18）: 長さの上限（前は `MAX_SUBMITTED_VALUE_LENGTH`）を撤廃した。
        rowKeyValue: { type: 'string', minLength: 1 },
        deferredPriorValues: {
          type: 'object',
          additionalProperties: false,
          required: ['keptKeys'],
          properties: { keptKeys: { type: 'array', items: { $ref: 'urn:beaksight:schema:control:scenario:1#/$defs/apiKey' } } },
        },
      },
    });
  });

  it.each<readonly [string, () => Record<string, unknown>, string]>([
    ['a page that is not the list page', () => specWith({ formPage: { origin: SAMPLE_ORIGIN, path: '/admin/groups' } }),
      '/write/formPage/path must be the list page path of the list row of the ledger'],
    ['a page with the target id put in', () => specWith({ formPage: { origin: SAMPLE_ORIGIN, path: `${LIST_PATH}/${TARGET_ID}` } }),
      '/write/formPage/path must be the list page path of the list row of the ledger'],
    ['a ledger form path template that is not the list page path', () => apiWith({ ledger: { ...(apiOf(FILTER_SPEC)['ledger'] as object), formPathTemplate: TEMPLATE_PATH } }),
      '/write/formPage/path must be the list page path of the list row of the ledger'],
    ['a templated identity digest', () => apiWith({ templatedIdentityDigest: `sha256:${'3'.repeat(64)}` }),
      '/write/api must be the spec of a list row UPDATE'],
    ['no filter in the filter form (neither a filter nor {id})', () => apiWith({ filterName: null }),
      '/write/api must be the spec of a list row UPDATE'],
    ['a filter in the path form (both a filter and {id})', () => apiWith({ filterName: 'id' }, PATH_SPEC),
      '/write/api must be the spec of a list row UPDATE'],
    ['a POST request', () => apiWith({ request: { ...(apiOf(FILTER_SPEC)['request'] as object), method: 'POST' } }),
      '/write/api must be the spec of a list row UPDATE'],
    ['no kept keys', () => {
      const { keptKeys: _kept, ...rest } = apiOf(FILTER_SPEC);
      return specWith({ api: rest });
    }, '/write/api must be the spec of a list row UPDATE'],
    ['no list row block', () => {
      const { listRow: _row, ...rest } = updateOf(FILTER_SPEC);
      return specWith({ update: rest });
    }, '/write/update/listRow is required for a list row UPDATE and allowed only for it'],
    ['a deferred prior values mark with another key', () => specWith({ update: { ...updateOf(FILTER_SPEC), listRow: { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: ['name'] } } } }),
      '/write/update/listRow/deferredPriorValues must have the kept keys of the API spec, in the same order'],
    ['a deferred prior values mark with a missing key', () => specWith({ update: { ...updateOf(FILTER_SPEC), listRow: { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: [] } } } }),
      '/write/update/listRow/deferredPriorValues must have the kept keys of the API spec, in the same order'],
    ['a deferred prior values mark with a duplicate key', () => specWith({ update: { ...updateOf(FILTER_SPEC), listRow: { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: ['email', 'email'] } } } }),
      '/write/update/listRow/deferredPriorValues must have the kept keys of the API spec, in the same order'],
  ])('rejects %s', (_label, make, error) => {
    const errors = errorsOf(startOf(make()));
    expect(errors.filter((text) => text.startsWith(error)), JSON.stringify(errors)).toHaveLength(1);
  });

  it('rejects a list row block of an API UPDATE without a list row in the ledger', () => {
    const { listRow: _row, ...ledger } = FILTER_SCENARIO.api!.ledger!;
    const plain: ScenarioRevision = {
      ...FILTER_SCENARIO,
      api: { ...FILTER_SCENARIO.api!, ledger: { ...ledger, formPathTemplate: TEMPLATE_PATH }, templatedIdentityDigest: `sha256:${'3'.repeat(64)}` },
    };
    const spec = writeStartSpecOf(inputsOf(plain, FILTER_CANDIDATE)) as unknown as Record<string, unknown>;
    expect(errorsOf(startOf(spec))).toEqual([]);
    const errors = errorsOf(startOf({ ...spec, update: { ...updateOf(spec), listRow: updateOf(FILTER_SPEC)['listRow'] } }));
    expect(errors).toContain('/write/update/listRow is required for a list row UPDATE and allowed only for it');
  });

  it.each<readonly [string, unknown]>([
    ['an empty row key value', { rowKeyValue: '', deferredPriorValues: { keptKeys: ['email'] } }],
    // L12b（S18）: 長さの上限を撤廃したので、長い値は拒まない。
    ['a row key value that is not a string', { rowKeyValue: 4, deferredPriorValues: { keptKeys: ['email'] } }],
    ['no deferred prior values mark', { rowKeyValue: ROW_KEY_VALUE }],
    ['an empty kept key name', { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: [''] } }],
    ['another property of the mark', { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: ['email'], pageKeys: [] } }],
    ['a prior value in the mark', { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: [{ key: 'email', value: 'v' }] } }],
    ['another property of the block', { rowKeyValue: ROW_KEY_VALUE, deferredPriorValues: { keptKeys: ['email'] }, rowKeyField: 'email' }],
  ])('rejects a list row block with %s (by the schema)', (_label, listRow) => {
    expect(errorsOf(startOf(specWith({ update: { ...updateOf(FILTER_SPEC), listRow } })))).not.toEqual([]);
  });

  it('rejects a list row in a WRITE_CREATE', () => {
    expect(errorsOf(startOf(FILTER_SPEC, 'WRITE_CREATE'))).not.toEqual([]);
  });
});

// LU-7 fix round 3（設計書 5.5 の 7、K3）: 一覧の行の更新の照合の READ は、一覧の画面の定義も使う（書き込みの画面 = 一覧の画面）。IPC は、一覧の行の更新に限って、
// 書き込みの画面の path と同じ一覧の画面の照合の READ を受ける（生成した値と比べる期待の確かめは今のまま）。一覧の行のない更新は今のとおり拒む。
describe('LU-7 fix round 3: the list page READ of a list row API UPDATE START', () => {
  const LIST_READ: ReadCheckView = { ...TEMPLATE_READ, definition: { targetPagePath: LIST_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition };
  const LIST_PAGE = { origin: SAMPLE_ORIGIN, path: LIST_PATH };
  const LIST_SPEC = writeStartSpecOf(inputsOf(FILTER_SCENARIO, FILTER_CANDIDATE, { readCheck: LIST_READ, targetPage: LIST_PAGE }));
  const readOf = (spec: unknown): Record<string, unknown> => (spec as { readonly readVerification: Record<string, unknown> }).readVerification;

  it('accepts the list page READ of a list row UPDATE (the page of the write)', () => {
    expect(LIST_SPEC).not.toBeNull();
    expect(readOf(LIST_SPEC)).toMatchObject({ targetPage: LIST_PAGE, definition: { targetPagePath: LIST_PATH } });
    expect(errorsOf(startOf(LIST_SPEC))).toEqual([]);
  });

  it('rejects the list page READ of an API UPDATE without a list row block, as before', () => {
    const { listRow: _row, ...update } = updateOf(LIST_SPEC);
    expect(errorsOf(startOf(specWith({ update }, LIST_SPEC))))
      .toContain('/write/readVerification/definition must target a READ candidate or a page path template (or the list page one above the create page, or the list page of a list row update) on the origin of the page of the write');
  });

  it('rejects a list page READ of another page than the page of the write, even for a list row UPDATE', () => {
    const read = readOf(LIST_SPEC);
    const other = { ...read, targetPage: { origin: SAMPLE_ORIGIN, path: '/admin/groups' }, definition: { ...(read['definition'] as Record<string, unknown>), targetPagePath: '/admin/groups' } };
    expect(errorsOf(startOf(specWith({ readVerification: other }, LIST_SPEC))))
      .toContain('/write/readVerification/definition must target a READ candidate or a page path template (or the list page one above the create page, or the list page of a list row update) on the origin of the page of the write');
  });
});

// LU-7 fix round 2・3: 変える鍵の新しい値が、台帳の対象のレコードの最後に分かっている値と同じなら、書き込みの指定を作らない（IPC の確かめの前の、開始の組み立ての段で
// 止まる。一覧で変わったことを確かめられないため）。
describe('LU-7 fix round 2: a list row UPDATE whose new value is the last value of the ledger', () => {
  it('makes no specification at the start stage (before the IPC check), and makes one with another value', () => {
    expect(writeStartSpecOf(inputsOf(FILTER_SCENARIO, FILTER_CANDIDATE, { values: { name: '登録 花子' } }))).toBeNull();
    expect(writeStartSpecOf(inputsOf(PATH_SCENARIO, PATH_CANDIDATE, { values: { name: '登録 花子' } }))).toBeNull();
    expect(writeStartSpecOf(inputsOf(FILTER_SCENARIO, FILTER_CANDIDATE, { values: { name: '更新 花子' } }))).not.toBeNull();
  });
});
