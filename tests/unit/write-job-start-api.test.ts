// T40a（Task 40 の設計書 3.2）: 書き込みのジョブの開始の口（`src/control/job/write-job-start.ts` の `writeStartSpecOf`）の、送り方 API の登録の
// シナリオの書き込みの指定。
// - 中身: 送り方 `API`、承認した API の指定（シナリオの API の指定のまま。照合に要る項目と ID の取り方）、生成した値（欄に対応する鍵ごと。欄の識別は
//   API の指定の `keyFields`）、送信の要素の識別の digest（登録の画面の path で求めた候補の識別の digest）、書き込みの画面、検証の指定、照合の READ
//   （`{id}` の型の画面の READ は送る値なしで、期待は生成した値。候補の READ は結び付けで送る値を作る）、承認の要約の事実。
// - 作らないもの: API の更新（Task 41 まで）、検証の指定がそろわない、READ の定義の id と版が違う、型でない画面の path の READ。
// - 開始の拒否（`readVerificationTargetRejectionOf`）は、API の型の READ を通す（FORM と、型でない画面の READ は今のまま拒む）。
// - 作った指定は、IPC の契約（`validateParentToWorkerMessage`）を通る。
import { describe, expect, it } from 'vitest';
import { scenarioTransportOf, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import {
  WRITE_READ_VERIFICATION_PAGE_TARGET,
  apiCreateReadListPagePathOf,
  readVerificationTargetRejectionOf,
  writeStartSpecOf,
} from '../../src/control/job/write-job-start.js';
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
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { ALL_CONFIRMED, PROFILE_ID, candidateOf, sampleScenario } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const NEW_PATH = '/admin/members/new';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const GRANT_ID = 'grant-api-1';

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];

// T40a-fix: 主な見本の API のシナリオは、成否の条件と入力の誤りの条件と検証の指定の `recordId` を持たない（ID は API の `recordId` で取る）。
const CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'POST',
      resourceType: 'fetch',
      url: `${API}/rest/v1/members?select=*`,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1], score: Number(MARKERS[2]), tenant_id: 'tenant-1' }) },
    }, { pagePath: NEW_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
};

const TEMPLATE_READ: ReadCheckView = {
  readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, createdAt: '20261017000000', updatedAt: '20261017000000', canceledAt: null,
  definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [] } as ReadCheckDefinition,
};
const CANDIDATE_READ: ReadCheckView = {
  ...TEMPLATE_READ, readCheckId: 'rc-search',
  definition: { targetIdentityDigest: DIGEST, parameters: { q: '' }, expectations: [] },
};
// OP-R（設計書 4.1.9 の R1）: 登録の画面の 1 つ上（`/admin/members`）は一覧の画面として使えるようになったので、使えない画面の path の見本は、ほかの画面（`/admin`）にした。
const FIXED_PAGE_READ: ReadCheckView = { ...TEMPLATE_READ, readCheckId: 'rc-page-fixed', definition: { targetPagePath: '/admin', parameters: {}, expectations: [] } };
/** OP-R（R1）: 登録の画面の 1 つ上の一覧の画面の定義。 */
const LIST_PATH = '/admin/members';
const LIST_READ: ReadCheckView = { ...TEMPLATE_READ, readCheckId: 'rc-list', definition: { targetPagePath: LIST_PATH, parameters: {}, expectations: [] } };
const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
  { readCheckId: 'rc-search', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'], targetKind: 'CANDIDATE' },
  { readCheckId: 'rc-list', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: false, pagePath: LIST_PATH },
] as const;

/** PL-6a: API のシナリオの、画面から ID を取る検証の指定（成否の条件はもうない。結果の判定のしかたの印は null）。 */
const VERIFICATION_CONDITIONS = {
  resultJudgement: null,
  recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}/edit' },
} as const;
/** T40a-fix: API のシナリオは、成否の条件と入力の誤りの条件を求めない（ID の取り方は `api.recordId` があればよい）。 */
const NO_CONDITIONS = { resultJudgement: null, recordId: null } as const;
const RESPONSE_KEY = { source: 'RESPONSE_BODY_KEY', key: 'id' } as const;

/** 下書きの確かめ（T38b・T38c）が作る API の登録のシナリオの版（照合の READ、検証の指定の残り、API の ID の取り方は引数）。 */
const apiScenarioOf = (
  readVerification: Record<string, unknown>,
  conditions: Record<string, unknown> = NO_CONDITIONS,
  apiRecordId: Record<string, unknown> | null = RESPONSE_KEY,
): ScenarioRevision => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: CANDIDATE.identityDigest,
    transport: 'API',
    fieldNames: ['name', 'email', 'score'],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: { ...conditions, readVerification },
    api: {
      shapeDigest: CANDIDATE.submissionProbe?.shapeDigest,
      pageKeys: ['tenant_id'],
      filterName: null,
      recordId: apiRecordId,
      ledger: null,
    },
  }, CANDIDATE, READ_FACTS, {
    scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) {
    throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  }
  return { ...sampleScenario(), ...result.content, inputRuleReference: null };
};

const TEMPLATE_SCENARIO = apiScenarioOf({ readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] });
/** OP-R（R1）: 一覧の画面の照合の READ の API の登録のシナリオ。 */
const LIST_SCENARIO = apiScenarioOf({ readCheckId: 'rc-list', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] });
const SEARCH_SCENARIO = apiScenarioOf({
  readCheckId: 'rc-search', revision: 1, bindings: [{ parameterName: 'q', fieldName: 'name' }], expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
});

const VALUES = Object.freeze({ email: 'sample0001@example.invalid', name: 'サンプル 太郎', score: '7' });

const SEED_RECORD: SeedRecord = {
  seed: 'd'.repeat(64),
  seedInput: { profileId: PROFILE_ID, scenarioId: TEMPLATE_SCENARIO.scenarioId, scenarioRevision: TEMPLATE_SCENARIO.revision,
    ruleSetDigest: `sha256:${'c'.repeat(64)}`, executionGrantId: GRANT_ID },
  baseDate: '2026-10-17',
  attempt: 0,
} as SeedRecord;

const inputsOf = (scenario: ScenarioRevision, readCheck: ReadCheckView, targetPath: string | null) => ({
  scenario,
  evidence: CANDIDATE,
  grantId: GRANT_ID,
  profileId: PROFILE_ID,
  seedRecord: SEED_RECORD,
  values: VALUES,
  readCheck,
  targetPage: targetPath === null ? null : { origin: SAMPLE_ORIGIN, path: targetPath },
  approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
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

const startOf = (write: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-api-1',
  jobKind: 'WRITE_CREATE',
  targetConfigPath: 'local/targets/example-api.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [SAMPLE_ORIGIN],
    approvedServiceOrigins: [API],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [SAMPLE_ORIGIN], { jobKind: 'WRITE_CREATE', automatedLogin: null, approvedServiceOrigins: [API] }),
  },
  write,
});

describe('T40a: the write specification of an API CREATE scenario', () => {
  it('makes the API write specification with a page path template READ (no value to send, the expectations from the values)', () => {
    const spec = writeStartSpecOf(inputsOf(TEMPLATE_SCENARIO, TEMPLATE_READ, TEMPLATE_PATH));
    expect(spec).toEqual({
      transport: 'API',
      scenarioId: TEMPLATE_SCENARIO.scenarioId,
      scenarioRevision: TEMPLATE_SCENARIO.revision,
      grantId: GRANT_ID,
      profileId: PROFILE_ID,
      seedRecord: SEED_RECORD,
      formPage: { origin: SAMPLE_ORIGIN, path: NEW_PATH },
      candidate: { identityDigest: CANDIDATE.identityDigest, ruleDigest: CANDIDATE.ruleDigest },
      submitterIdentityDigest: CANDIDATE.identityDigest,
      api: TEMPLATE_SCENARIO.api,
      values: VALUES,
      // T40a-fix: API の書き込みの指定の成否の条件と入力の誤りの条件は null。ID の取り方は検証の指定の `recordId`（ここは未指定。API の
      // `recordId` がある）。
      verification: NO_CONDITIONS,
      readVerification: {
        readCheckId: 'rc-page',
        readCheckRevision: 1,
        targetPage: { origin: SAMPLE_ORIGIN, path: TEMPLATE_PATH },
        definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: VALUES.email }] },
      },
      approvalFacts: inputsOf(TEMPLATE_SCENARIO, TEMPLATE_READ, TEMPLATE_PATH).approvalFacts,
    });
    expect(spec !== null && isWorkerStartApiWrite(spec)).toBe(true);
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
    // 値は欄に対応する鍵の値だけで、ページが決める鍵の値と目印を持たない。
    expect(JSON.stringify(spec)).not.toContain('tenant-1');
    expect(JSON.stringify(spec)).not.toContain('bsprobe');
  });

  it('binds the values to a READ candidate as for a FORM scenario', () => {
    const spec = writeStartSpecOf(inputsOf(SEARCH_SCENARIO, CANDIDATE_READ, '/admin/members'));
    expect(spec?.readVerification).toEqual({
      readCheckId: 'rc-search',
      readCheckRevision: 1,
      targetPage: { origin: SAMPLE_ORIGIN, path: '/admin/members' },
      definition: { targetIdentityDigest: DIGEST, parameters: { q: VALUES.name }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    });
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
  });

  // T40a-fix: API の書き込みの指定は、結果の判定のしかたの印を持たない（null。PL-6a: 成否の条件はもうない）。ID の取り方は検証の指定の
  // `recordId` を載せる（API の `recordId` がなくても、検証の指定の取り方で作る）。
  it('has no result judgement for an API scenario, and carries the record id of the verification spec', () => {
    const withConditions = apiScenarioOf({ readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] },
      VERIFICATION_CONDITIONS, null);
    expect(withConditions.verification).toMatchObject({ resultJudgement: null, recordId: VERIFICATION_CONDITIONS.recordId });
    const spec = writeStartSpecOf(inputsOf(withConditions, TEMPLATE_READ, TEMPLATE_PATH));
    expect(spec?.verification).toEqual({ resultJudgement: null, recordId: VERIFICATION_CONDITIONS.recordId });
    expect(spec !== null && isWorkerStartApiWrite(spec) ? spec.api.recordId : 'none').toBeNull();
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
  });

  it.each<readonly [string, () => ReturnType<typeof writeStartSpecOf>]>([
    ['an API UPDATE scenario (Task 41)', () => writeStartSpecOf(inputsOf({ ...TEMPLATE_SCENARIO, kind: 'UPDATE' }, TEMPLATE_READ, TEMPLATE_PATH))],
    // T40a-fix: ID の取り方が 2 つとも未指定（API の `recordId` も検証の指定の `recordId` もない）。
    ['an API scenario without any way to take the record id', () => writeStartSpecOf(inputsOf(
      apiScenarioOf({ readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] }, NO_CONDITIONS, null),
      TEMPLATE_READ, TEMPLATE_PATH,
    ))],
    ['an API scenario without the READ verification', () => writeStartSpecOf(inputsOf({
      ...TEMPLATE_SCENARIO, verification: { ...TEMPLATE_SCENARIO.verification, readVerification: null },
    }, TEMPLATE_READ, TEMPLATE_PATH))],
    ['a READ definition of another revision', () => writeStartSpecOf(inputsOf(TEMPLATE_SCENARIO, { ...TEMPLATE_READ, revision: 2 }, TEMPLATE_PATH))],
    ['a page path READ that is not a template nor the list page', () => writeStartSpecOf(inputsOf(TEMPLATE_SCENARIO, { ...FIXED_PAGE_READ, readCheckId: 'rc-page' }, '/admin'))],
    // OP-R（R1）: 一覧の画面の定義は、API の登録だけ（更新は作らない）。
    ['the list page READ of an API UPDATE scenario', () => writeStartSpecOf({
      ...inputsOf({ ...LIST_SCENARIO, kind: 'UPDATE' }, LIST_READ, LIST_PATH), targetRecordId: '1',
    })],
    ['an API scenario without the API spec', () => {
      const { api: _api, ...withoutApi } = TEMPLATE_SCENARIO;
      return writeStartSpecOf(inputsOf(withoutApi, TEMPLATE_READ, TEMPLATE_PATH));
    }],
    ['a value of an expectation that is not made', () => writeStartSpecOf({ ...inputsOf(TEMPLATE_SCENARIO, TEMPLATE_READ, TEMPLATE_PATH), values: { ...VALUES, email: null } })],
  ])('makes no specification for %s', (_label, make) => {
    expect(make()).toBeNull();
  });

  it('lets the page path template READ through the start check for an API scenario only', () => {
    expect(readVerificationTargetRejectionOf(TEMPLATE_READ, 'API')).toBeNull();
    expect(readVerificationTargetRejectionOf(CANDIDATE_READ, 'API')).toBeNull();
    expect(readVerificationTargetRejectionOf(TEMPLATE_READ, 'FORM')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(readVerificationTargetRejectionOf(FIXED_PAGE_READ, 'API')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(readVerificationTargetRejectionOf(FIXED_PAGE_READ, 'API', apiCreateReadListPagePathOf(TEMPLATE_SCENARIO, CANDIDATE))).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
  });

  // OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1。T37d の判断 5 を改めた）: API の登録に限って、登録の画面の 1 つ上の一覧の画面の定義を
  // 照合の READ に使う（送る値なし。期待は生成した値。GET 1 回は、ワーカーが行う）。FORM と API の更新と、ほかの画面の path は、今のまま使わない。
  it('lets the list page READ one above the create page through the start check for an API create only (OP-R R1)', () => {
    const rejectionOf = (scenario: ScenarioRevision, evidence: DiscoveryCandidate) =>
      readVerificationTargetRejectionOf(LIST_READ, scenarioTransportOf(scenario), apiCreateReadListPagePathOf(scenario, evidence));
    expect(rejectionOf(LIST_SCENARIO, CANDIDATE)).toBeNull();
    expect(rejectionOf({ ...LIST_SCENARIO, transport: 'FORM' }, CANDIDATE)).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(rejectionOf({ ...LIST_SCENARIO, kind: 'UPDATE' }, CANDIDATE)).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    expect(rejectionOf(LIST_SCENARIO, { ...CANDIDATE, page: { ...CANDIDATE.page, path: '/admin/other/new' } })).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
    // 一覧の画面の path を渡さなければ（呼ぶ側の古い形）、今のまま拒む。
    expect(readVerificationTargetRejectionOf(LIST_READ, 'API')).toBe(WRITE_READ_VERIFICATION_PAGE_TARGET);
  });

  it('makes the API write specification with the list page READ (no value to send, the expectations from the values) (OP-R R1)', () => {
    // OP-REV6 の I-1: 一覧の画面の期待は、実行のたびに違う値になる欄（ここはメール）と比べる。
    const spec = writeStartSpecOf({ ...inputsOf(LIST_SCENARIO, LIST_READ, LIST_PATH), uniqueEachRunFieldNames: ['email'] });
    expect(spec?.readVerification).toEqual({
      readCheckId: 'rc-list',
      readCheckRevision: 1,
      targetPage: { origin: SAMPLE_ORIGIN, path: LIST_PATH },
      definition: { targetPagePath: LIST_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: VALUES.email }] },
    });
    expect(validateParentToWorkerMessage(startOf(spec))).toMatchObject({ ok: true });
  });

  it.each<readonly [string, (write: Record<string, unknown>) => Record<string, unknown>]>([
    ['another page path that is not a template', (write) => ({ ...write, readVerification: withPage(write, '/admin') })],
    ['the list page of another create page', (write) => ({ ...write, formPage: { ...(write['formPage'] as object), path: '/admin/other/new' } })],
    ['the list page without an expectation compared with a generated value', (write) => ({
      ...write, readVerification: { ...(write['readVerification'] as object), definition: { targetPagePath: LIST_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } },
    })],
  ])('rejects in the IPC a list page READ with %s (OP-R R1)', (_label, change) => {
    const spec = writeStartSpecOf({ ...inputsOf(LIST_SCENARIO, LIST_READ, LIST_PATH), uniqueEachRunFieldNames: ['email'] }) as unknown as Record<string, unknown>;
    expect(validateParentToWorkerMessage(startOf(change(spec)))).toMatchObject({ ok: false });
  });
});

// OP-REV6 の I-1: 一覧の画面には前の登録が並ぶので、一覧の画面の期待は、実行のたびに違う値になる欄（値の生成の持ち主の判定 `uniqueEachRunFieldNamesOf`。親が渡す）と
// 比べるときだけ作る。人の名前など、回をまたいで同じになりうる欄だけと比べるなら作らない（渡さなければ作らない）。`{id}` の型の画面は今のまま。
describe('OP-REV6 I-1: the list page READ compares with a value unique to each run', () => {
  const NAME_LIST_SCENARIO = apiScenarioOf({ readCheckId: 'rc-list', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] });

  it('makes no specification when the expectation of the list page compares with a field that is not unique to each run, or when nothing is given', () => {
    expect(writeStartSpecOf({ ...inputsOf(NAME_LIST_SCENARIO, LIST_READ, LIST_PATH), uniqueEachRunFieldNames: ['email'] })).toBeNull();
    expect(writeStartSpecOf(inputsOf(LIST_SCENARIO, LIST_READ, LIST_PATH))).toBeNull();
    expect(writeStartSpecOf({ ...inputsOf(LIST_SCENARIO, LIST_READ, LIST_PATH), uniqueEachRunFieldNames: ['email'] })).not.toBeNull();
  });

  it('keeps the {id} page template READ as before', () => {
    expect(writeStartSpecOf(inputsOf(TEMPLATE_SCENARIO, TEMPLATE_READ, TEMPLATE_PATH))).not.toBeNull();
  });
});

/** OP-R: 照合の READ の対象の画面の path を替えた写し（定義の path と、対象の画面の path を揃える）。 */
const withPage = (write: Record<string, unknown>, path: string): Record<string, unknown> => {
  const read = write['readVerification'] as { readonly targetPage: { readonly origin: string }; readonly definition: Record<string, unknown> };
  return { ...read, targetPage: { ...read.targetPage, path }, definition: { ...read.definition, targetPagePath: path } };
};
