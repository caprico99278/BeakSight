// T40c（Task 40 の設計書 3.4、4 章、5 章の 4）: 送り方 API の書き込みのジョブの、親の読み取りと締め（ジョブの管理 `createAuditJobManager`、偽のワーカー
// `tests/helpers/fake-audit-worker.ts` の `write` の動きを本物の `fork` で起動。ワーカーの API の書き込みの流れは T40b）。
// - 手で作った `action-run.json`（版 1.1。送り方 `API`、API の要約は `actionApiSummaryOf` で、承認した API の指定とページが決める鍵の値から作る）を、親が
//   受けて締める: 書き込みの結果の行は送り方 `API` と API の型の要約（型の digest、method、Origin、path の型）を持ち、`VERIFIED`・`COMMITTED`。報告の
//   確かめは `VALID`。
// - 記録の送り方・API の要約が `START` の API の指定と食い違えば、今の食い違いと同じく `WRITE_RESULT_INVALID`（送信の報告から締める。成功と偽らない）。
//   版 1.0 の記録（送り方を持たない）も、API のジョブでは使わない。
// - 秘密の目印（送り手のヘッダの値、応答の本文）は、要約に入らず、管理データのファイル（WAL を含む）と成果物に出ない。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_SUMMARY_SCHEMA_VERSION, type ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { actionApiSummaryOf } from '../../src/control/actions/action-api-summary.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import type { ScenarioApiSpec } from '../../src/control/approval/scenario-contracts.js';
import {
  approveScenario,
  createScenario,
  issueExecutionGrant,
  readExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished, type AuditJobView } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import { actionBundleFileName } from '../../src/core/artifact-layout.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { verifiedApiCreateDocuments } from '../helpers/action-report-samples.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { databaseFilePlaces, filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { ALL_CONFIRMED, candidateOf } from '../unit/approval-samples.js';
import { NO_JS_BINDING, sampleButton } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const TEST_TIMEOUT_MS = 60_000;
const FAKE_RUN_ID = 'RUN-20261017000000';
const OTHER_RUN_ID = 'RUN-20261017000999';
const OUTPUT_DIRECTORY = 'write-api-jobs-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-api-write' } });
const PROFILE_ID = 'example-api-write';
const SCENARIO_ID = 'scenario-api';
const READ_CHECK_ID = 'rc-page';
const DISCOVERY_JOB_ID = 'job-api-d1';
const API_ORIGIN = 'https://api.example.invalid';
const NEW_PATH = '/admin/members/new';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
/** 発見・シナリオ・承認・許可・ジョブの管理の時刻（承認の期限と許可の期限の中）。 */
const DISCOVERED_AT = '20261017000000';
const CREATED_AT = '20261017001000';
const APPROVED_AT = '20261017002000';
const ISSUE_AT = '20261017003000';
const MANAGER_NOW = '20261017003100';
const FFLATE_URL = pathToFileURL(createRequire(import.meta.url).resolve('fflate')).href;
const HTML = '<!DOCTYPE html>\n<p>report</p>\n';

/** probe の目印（値の位置の印。送る値ではない）。 */
const PROBE_MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
/** 秘密の目印（送り手のヘッダの値と、応答の本文。要約・管理データ・成果物に出ないこと）。 */
const HEADER_VALUE_MARKER = 'bsT40cHeaderValue0002';
const RESPONSE_BODY_MARKER = 'bsT40cResponseBody0002';

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];

/** form のない登録の画面の保存のボタン（probe が API の登録の型を見た候補）。 */
const CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleButton({ page: { origin: TEST_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'POST',
      resourceType: 'fetch',
      url: `${API_ORIGIN}/rest/v1/members?select=*`,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: PROBE_MARKERS[0], email: PROBE_MARKERS[1], score: Number(PROBE_MARKERS[2]), tenant_id: 'tenant-1' }) },
    }, { pagePath: NEW_PATH, markers: PROBE_MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
};

const DISCOVERY: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: DISCOVERY_JOB_ID,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [{
    url: `${TEST_ORIGIN}${NEW_PATH}`,
    state: 'READ',
    record: { location: { origin: TEST_ORIGIN, path: NEW_PATH }, incompleteReasons: [], candidates: [CANDIDATE] },
    blockedRequests: 0,
  }],
  omittedUnreadPages: 0,
} as DiscoveryDocument;

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 送る値（欄に対応する鍵ごと。入力の規則の人の固定の値）。 */
const FIXED_VALUES = Object.freeze({ email: 'sample0001@example.invalid', name: '試験一郎', score: '7' });

/** ワーカーの側の事実の見本（送り手が持つヘッダと応答の本文、Guard の照合が返したページが決める鍵の値）。要約に渡すのはページが決める鍵の値だけ。 */
const HANDOFF = Object.freeze({
  headers: { authorization: `Bearer ${HEADER_VALUE_MARKER}`, 'content-type': 'application/json' },
  responseBody: JSON.stringify({ id: 1001, note: RESPONSE_BODY_MARKER }),
  pageKeyValues: { tenant_id: 'tenant-1' },
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
let facts: ApprovalExternalFacts;
const forks = createCountingFork();

const fakeWorker = (name: string, write: NonNullable<FakeWorkerValues['write']>): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, 'write', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, { write }));
};

async function managerWith(worker: FakeWorker): Promise<AuditJobManager> {
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker: forks.fork,
    now: () => dateOfCompactUtcTimestamp(MANAGER_NOW),
  });
  return manager;
}

const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };
const isEndedWithoutWorker = (job: AuditJobView): boolean => isJobEnded(job) && (manager?.runningWorkerCount() ?? 0) === 0;

/** 承認した API の指定（保存したシナリオの今の版）。 */
const scenarioApi = (): ScenarioApiSpec => {
  const api = readScenario(database, SCENARIO_ID)?.current.api;
  if (api === undefined) {
    throw new Error('the scenario has no API spec');
  }
  return api;
};

const revision = (): number => readScenario(database, SCENARIO_ID)?.revision ?? 0;

/** 照合まで済んだ API の `action-run.json`（版 1.1。seed の記録は、偽のワーカーが START の値に置き換える印）。 */
const apiActionRunOf = (jobId: string, grantId: string, overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({
  ...verifiedApiCreateDocuments().actionRun,
  jobId,
  runId: FAKE_RUN_ID,
  profileId: PROFILE_ID,
  scenarioId: SCENARIO_ID,
  scenarioRevision: revision(),
  grantId,
  seedRecord: '__START_SEED_RECORD__' as never,
  // T40R2-fix（M-1）: 照合の READ の期待の欄（email）は実行のたびに変わる規則（値が 2 つの固定の一覧）なので、送った値は偽のワーカーが START の値を書き写す印。
  submittedValues: '__START_VALUES__' as never,
  api: actionApiSummaryOf(scenarioApi(), HANDOFF.pageKeyValues),
  startedAt: MANAGER_NOW,
  submittedAt: MANAGER_NOW,
  finishedAt: MANAGER_NOW,
  ...overrides,
});

/** `action-run.json` と重なる値が同じ、照合まで済んだ API の証拠。 */
const apiEvidenceTextOf = (run: ActionRunDocument): string => JSON.stringify({
  ...verifiedApiCreateDocuments().evidence,
  jobId: run.jobId,
  runId: FAKE_RUN_ID,
  profileId: PROFILE_ID,
  scenarioId: SCENARIO_ID,
  scenarioRevision: run.scenarioRevision,
  submission: { state: 'SENT', submittedValues: run.submittedValues, actionPath: scenarioApi().request.pathShape, submittedAt: MANAGER_NOW },
  recordId: run.recordId,
  startedAt: MANAGER_NOW,
  finishedAt: MANAGER_NOW,
  transport: run.transport,
  api: run.api,
});

const writeOf = (run: ActionRunDocument | string): NonNullable<FakeWorkerValues['write']> => ({
  outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
  recheck: 1,
  onReject: 'report',
  submission: { submission: 'SENT', blockReason: null },
  actionRunText: typeof run === 'string' ? run : JSON.stringify(run),
  end: 'finish',
  report: {
    approvalSummarySchemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    actionEvidenceText: typeof run === 'string' ? null : apiEvidenceTextOf(run),
    reportHtml: HTML,
    bundle: { name: actionBundleFileName(MANAGER_NOW), fflateUrl: FFLATE_URL },
  },
});

/** API の書き込みのジョブを 1 回、偽のワーカーで行う。 */
async function runApiWriteJob(name: string, grantId: string, write: NonNullable<FakeWorkerValues['write']>): Promise<AuditJobView> {
  const jobs = await managerWith(fakeWorker(name, write));
  const started = await jobs.startWriteCreate({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: SCENARIO_ID, grantId });
  if (!started.ok) {
    throw new Error(`the API write job did not start: ${started.reason}`);
  }
  return waitForJob(currentManager, started.job.jobId, isEndedWithoutWorker);
}

const issue = (slot: number): { readonly grantId: string; readonly jobId: string } => {
  const issued = issueExecutionGrant(database, {
    scenarioId: SCENARIO_ID, expectedRevision: revision(), grantId: `grant-a${slot}`, jobId: `job-a${slot}`, count: 1, external: facts, at: ISSUE_AT,
  });
  if (!issued.ok) {
    throw new Error(`not issued: ${issued.reason}`);
  }
  return { grantId: issued.grant.grantId, jobId: issued.grant.jobId };
};

/** API の登録のシナリオを、索引・照合の READ（`{id}` の型の画面）・入力の規則とともに作り、本物の事実で承認する。 */
const prepareApprovedApiScenario = async (): Promise<void> => {
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  const profile = createProfile(database, { ...testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), approvedServiceOrigins: [API_ORIGIN] },
    { resolveContext: resolveTestContext });
  if (!profile.ok) {
    throw new Error(`the profile was not created: ${JSON.stringify(profile)}`);
  }
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  expect(createStartingJob(database, {
    jobId: DISCOVERY_JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: DISCOVERED_AT,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, DISCOVERY_JOB_ID, 0, DISCOVERED_AT)).toBe(true);
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT,
    entries: mergeDiscoveryCandidates([CANDIDATE]).map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  expect(createReadCheck(database, {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID,
    definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, at: DISCOVERED_AT,
  })).toMatchObject({ ok: true });
  const created = createScenario(database, {
    scenarioId: SCENARIO_ID,
    draft: {
      profileId: PROFILE_ID,
      candidateIdentityDigest: CANDIDATE.identityDigest,
      transport: 'API',
      fieldNames: ['email', 'name', 'score'],
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
      verification: {
        successCondition: null,
        inputErrorCondition: null,
        recordId: null,
        readVerification: { readCheckId: READ_CHECK_ID, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] },
      },
      api: {
        shapeDigest: CANDIDATE.submissionProbe?.shapeDigest ?? '',
        pageKeys: ['tenant_id'],
        filterName: null,
        recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
        ledger: null,
      },
    },
    discovery: DISCOVERY,
    at: CREATED_AT,
  } as Parameters<typeof createScenario>[1]);
  if (!created.ok) {
    throw new Error(`the scenario was not created: ${JSON.stringify(created)}`);
  }
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: 'rules-api', scenarioId: SCENARIO_ID, expectedRevision: null, content: {
      // 人の固定の値（送る値を決める。値は匿名の合成のテストデータ）。T40R2-fix（M-1）: 照合の READ の期待の欄（email）は、実行のたびに変わる値と
      // 比べる必要があるので、値を 2 つにする（1 つの値だけの固定の一覧は、許可の発行が `READ_VERIFICATION_NOT_VARYING` で拒む）。
      fieldRules: (Object.entries(FIXED_VALUES) as [string, string][]).map(([fieldName, value]) => ({
        fieldName, semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null,
        fixedValues: fieldName === 'email' ? [value, 'sample0002@example.invalid'] : [value],
      })),
      relations: [],
      uniqueKeyFieldNames: [],
    },
    expectedScenarioRevision: created.scenario.revision, at: CREATED_AT,
  });
  if (saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  }
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
  const status = readScenarioApprovalStatus(database, SCENARIO_ID, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  expect(approveScenario(database, {
    scenarioId: SCENARIO_ID, expectedRevision: saved.attachment.scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '',
    receiptId: 'receipt-api', external: facts, at: APPROVED_AT,
  })).toMatchObject({ ok: true });
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-write-api-jobs-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  await prepareApprovedApiScenario();
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('T40c: the parent reads and settles the action-run.json of an API write job', () => {
  it('settles a matching API record (VERIFIED, COMMITTED), writes the transport and the shape summary to the ledger, and checks the report VALID', async () => {
    const { grantId, jobId } = issue(1);
    const run = apiActionRunOf(jobId, grantId);
    const ended = await runApiWriteJob('api-verified', grantId, writeOf(run));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', failureReason: null, endKind: 'RAN', writeReportCheck: 'VALID' });
    const api = scenarioApi();
    expect(readWriteResult(database, jobId)).toMatchObject({
      grantId, submission: 'SENT', httpStatus: 201, responseJudgement: 'SUCCESS', recordId: '1001', result: 'VERIFIED',
      reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', transport: 'API',
      api: { shapeDigest: api.shapeDigest, method: 'POST', origin: API_ORIGIN, pathShape: api.request.pathShape },
    });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ reservation: { state: 'COMMITTED' } });
    // 秘密の目印（送り手のヘッダの値、応答の本文）は、要約にも、管理データのファイル（WAL を含む）と成果物にも出ない。
    expect(JSON.stringify(run)).not.toContain(HEADER_VALUE_MARKER);
    const places = [...databaseFilePlaces(resolveControlDatabasePath(workDirectory)), ...filesUnder(resolve(workDirectory, OUTPUT_DIRECTORY))];
    expect(places.length).toBeGreaterThan(2);
    expect(placesWithMarkers(places, [HEADER_VALUE_MARKER, RESPONSE_BODY_MARKER, ...PROBE_MARKERS])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, (jobId: string, grantId: string) => unknown]>([
    ['another shape digest', (jobId, grantId) => apiActionRunOf(jobId, grantId, {
      api: { ...actionApiSummaryOf(scenarioApi(), HANDOFF.pageKeyValues), shapeDigest: `sha256:${'c'.repeat(64)}` },
    })],
    ['another origin', (jobId, grantId) => apiActionRunOf(jobId, grantId, {
      api: { ...actionApiSummaryOf(scenarioApi(), HANDOFF.pageKeyValues), origin: 'http://127.0.0.3:4174' },
    })],
    ['another path shape', (jobId, grantId) => apiActionRunOf(jobId, grantId, {
      api: { ...actionApiSummaryOf(scenarioApi(), HANDOFF.pageKeyValues), pathShape: '/rest/v1/other' },
    })],
    ['other keys', (jobId, grantId) => apiActionRunOf(jobId, grantId, {
      api: { ...actionApiSummaryOf(scenarioApi(), HANDOFF.pageKeyValues), keyNames: ['email', 'name'] },
    })],
    ['the FORM transport', (jobId, grantId) => apiActionRunOf(jobId, grantId, {
      transport: 'FORM', api: null, resultConditions: { successCondition: { pathPrefix: '/', selector: null }, inputErrorCondition: { pathPrefix: '/', selector: null } },
    })],
    ['the version 1.0 (no transport)', (jobId, grantId) => {
      const { transport: _transport, api: _api, ...run } = apiActionRunOf(jobId, grantId, {
        resultConditions: { successCondition: { pathPrefix: '/', selector: null }, inputErrorCondition: { pathPrefix: '/', selector: null } },
      });
      return { ...run, schemaVersion: 'action-run-schema/1.0' };
    }],
  ])('does not use a record with %s: WRITE_RESULT_INVALID, settled from the submission report (not as a success)', async (name, runOf) => {
    const { grantId, jobId } = issue(1);
    const ended = await runApiWriteJob(name.split(' ').join('-'), grantId, writeOf(JSON.stringify(runOf(jobId, grantId))));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID', writeReportCheck: 'RESULT_INVALID' });
    expect(readWriteResult(database, jobId)).toMatchObject({
      submission: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE', reservationState: 'UNKNOWN', recordId: null, transport: 'API',
    });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ reservation: { state: 'UNKNOWN' } });
  }, TEST_TIMEOUT_MS);
});
