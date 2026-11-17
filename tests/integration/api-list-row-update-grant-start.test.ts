// LU-8 fix round 1（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の最後の段、4.0 の D4。案 A）: 一覧の行の更新（API の台帳に `listRow`）の、
// 下書き → 承認 → 点検の登録の段 → 許可（同じ点検で照合まで済んだ登録）→ 更新の段の書き込みの指定が届く、までを、本物の管理データとジョブの管理
// （`createAuditJobManager`）と偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `chain`。本物の `fork`）で確かめる。作法は `api-update-grant-start.test.ts`。
// - 書き込みの指定: 書き込みの画面は一覧の画面の path（番号を入れない）、`update.listRow` に行を選ぶ値（台帳の最後に分かっている値）と前の値を後から入れる印（保つ鍵の
//   名前）。開き手の識別の digest と行を選ぶ欄の名前は `api.ledger.listRow` のまま。
// - SLIM W-1: 単独で書き込みを始める口を外した。書き込みの指定を作らずに止まる場面（行を選ぶ値がない・台帳の登録の規則で行を選ぶ欄が毎回違う欄でなくなった・
//   変える欄の新しい値が台帳の最後の値と同じ・一覧の画面の照合の READ）は、組み立ての単体（`tests/unit/api-list-row-update-start.test.ts`）が確かめる。
//   許可の発行の確かめ直しは、ここで管理データだけで確かめる。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  approveScenario,
  createScenario,
  issueExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import {
  observedSubmissionProbeOf,
  submissionProbeOpenerOf,
  type SubmissionProbeInputField,
  type SubmissionProbeOpener,
} from '../../src/discovery/submission-probe-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { chainWriteWorkerValues, runWriteChain, verifiedApiCreateRunText, writeStagesOf } from '../helpers/chain-write-support.js';
import { writeFakeWorker, type FakeWorker } from '../helpers/fake-audit-worker.js';
import { seedWriteResultForTest } from '../helpers/write-result-fixtures.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { awaitWorkersExit, createFakeWorkerJobManager, withOutputDirectory } from '../helpers/job-test-support.js';
import { ALL_CONFIRMED, candidateOf } from '../unit/approval-samples.js';
import { NO_JS_BINDING, sampleButton } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const TEST_TIMEOUT_MS = 60_000;
/** 点検の登録の段と更新の段の Run の ID。 */
const FAKE_RUN_ID = 'RUN-20261102000000';
const UPDATE_RUN_ID = 'RUN-20261102000100';
/** 点検の登録の段で取れる ID（台帳の登録 6 の後）。 */
const CHAIN_CREATED_ID = '8';
const OUTPUT_DIRECTORY = 'api-list-row-update-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-api-list-row' } });
const PROFILE_ID = 'example-api-list-row';
const CREATE_ID = 'scenario-api-create';
const UPDATE_ID = 'scenario-api-list-row-update';
const READ_CHECK_ID = 'rc-page';
const DISCOVERY_JOB_ID = 'job-aplr-d1';
const API_ORIGIN = 'https://api.example.invalid';
const NEW_PATH = '/admin/members/new';
const LIST_PATH = '/admin/members';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
const OPENER_DIGEST = `sha256:${'1'.repeat(64)}`;
/** 発見・シナリオ・承認・登録（連続の上限の 5 分を空ける）・規則の変更・更新の許可・ジョブの管理の時刻。 */
const DISCOVERED_AT = '20261102000000';
const CREATED_AT = '20261102001000';
const APPROVED_AT = '20261102002000';
const REGISTERED_AT = ['20261102003000', '20261102004000'] as const;
const RULES_CHANGED_AT = '20261102004500';
const ISSUE_AT = '20261102005000';
const MANAGER_NOW = '20261102005100';
const REGISTERED_IDS = ['6', '7'] as const;
const ROW_KEY_VALUE = 'sample0001@example.invalid';

const PROBE_MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];
const BODY = { name: PROBE_MARKERS[0], email: PROBE_MARKERS[1], score: Number(PROBE_MARKERS[2]) };

/** form のない画面の保存のボタン（probe が API の型を見た候補。`opener` があれば、一覧の行の「編集」を押した後にできた窓の保存）。 */
const buttonOf = (path: string, method: string, url: string, opener?: SubmissionProbeOpener): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: TEST_ORIGIN, path }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method, resourceType: 'fetch', url, origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' }, body: { kind: 'TEXT', text: JSON.stringify(BODY) },
    }, { pagePath: path, markers: PROBE_MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS, ['保存'], opener),
});
const CREATE_CANDIDATE = buttonOf(NEW_PATH, 'POST', `${API_ORIGIN}/rest/v1/members?select=*`);
const LIST_CANDIDATE = buttonOf(LIST_PATH, 'PATCH', `${API_ORIGIN}/rest/v1/members?id=eq.4&select=*`, submissionProbeOpenerOf(OPENER_DIGEST, true, ['編集']));

const pageOf = (candidate: DiscoveryCandidate) => ({
  url: `${TEST_ORIGIN}${candidate.page.path}`,
  state: 'READ',
  record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
  blockedRequests: 0,
});
const DISCOVERY: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: DISCOVERY_JOB_ID,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [pageOf(CREATE_CANDIDATE), pageOf(LIST_CANDIDATE)],
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

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
let facts: ApprovalExternalFacts;
const forks = createCountingFork();

const revisionOf = (scenarioId: string): number => readScenario(database, scenarioId)?.revision ?? 0;

/**
 * 点検の偽のワーカー: 登録の段は照合まで済んだ記録を書き（取れた ID は `CHAIN_CREATED_ID`）、更新の段は書き込みの指定の中身だけを見るため、送信の報告も記録も
 * 書かずに終わる（ワーカーの一覧の行の更新の流れは LU-10）。
 */
const fakeWorker = (name: string): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  const api = readScenario(database, CREATE_ID)?.current.api;
  if (api === undefined) {
    throw new Error('the ledger has no API spec');
  }
  return writeFakeWorker(directory, 'chain', chainWriteWorkerValues({
    outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), discovery: DISCOVERY, writeRunId: FAKE_RUN_ID,
    write: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), runIds: [FAKE_RUN_ID, UPDATE_RUN_ID], recheck: 1, onReject: 'report',
      submission: { submission: 'SENT', blockReason: null }, end: 'finish', report: null,
      actionRunText: verifiedApiCreateRunText({
        profileId: PROFILE_ID, scenarioId: CREATE_ID, scenarioRevision: revisionOf(CREATE_ID), api, runId: FAKE_RUN_ID, recordId: CHAIN_CREATED_ID, at: MANAGER_NOW,
      }),
      updateStage: { submission: null, actionRunText: null, end: 'crash' },
    },
  }));
};

const draftOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], api: Record<string, unknown>, expectedField: string) => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: {
    resultJudgement: null, recordId: null,
    readVerification: { readCheckId: READ_CHECK_ID, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: expectedField }] },
  },
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest ?? '', pageKeys: [], filterName: null, recordId: null, ledger: null, ...api },
});

type FieldRuleInput = Readonly<Record<string, unknown>>;

/** 欄の規則（固定の一覧）。 */
const fixedRuleOf = (fieldName: string, fixedValues: readonly string[]): FieldRuleInput =>
  ({ fieldName, semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [...fixedValues] });
/** 実行のたびに違う値になる欄の規則（合成の番号つきのメール）。 */
const EMAIL_RULE: FieldRuleInput = Object.freeze({ fieldName: 'email', semanticKind: 'EMAIL', method: 'FROM_TYPE', range: null, fixedValues: [] });

/** 入力の規則を保存して付ける（`expectedRuleRevision` は規則の集まりの今の版。作るときは null）。 */
const attachRules = (scenarioId: string, fieldRules: readonly FieldRuleInput[], expectedRuleRevision: number | null, at: string): void => {
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: expectedRuleRevision, content: {
      fieldRules: fieldRules as never,
      relations: [],
      uniqueKeyFieldNames: [],
    },
    expectedScenarioRevision: revisionOf(scenarioId), at,
  });
  if (saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  }
};

const approve = (scenarioId: string, receiptId: string): void => {
  const status = readScenarioApprovalStatus(database, scenarioId, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  expect(approveScenario(database, {
    scenarioId, expectedRevision: revisionOf(scenarioId), expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: facts, at: APPROVED_AT,
  })).toMatchObject({ ok: true });
};

/** 台帳の登録のシナリオの、照合まで済んだ登録を 1 件作る（発行 → 消費 → 送る前の記録 → `VERIFIED` の締め）。 */
const registerVerified = (index: 0 | 1, submittedValues: Readonly<Record<string, string>>): void => {
  const at = REGISTERED_AT[index];
  seedWriteResultForTest(database, {
    profileId: PROFILE_ID, scenarioId: CREATE_ID, scenarioRevision: revisionOf(CREATE_ID), grantId: `grant-c${index}`, jobId: `job-c${index}`,
    external: facts, at, submittedValues,
    report: {
      submission: 'SENT', blockReason: null, httpStatus: 201, responseJudgement: 'SUCCESS', recordId: REGISTERED_IDS[index], readVerification: 'MATCHED',
      submittedAt: at,
    },
  });
};

/**
 * 台帳と一覧の行の更新のシナリオを作り、承認する（台帳の登録は 1 件目だけ）。LU-7 fix round 2: 照合の READ の定義の画面（既定は `{id}` の型の画面。一覧の画面も）
 * を選べる。
 */
const prepare = async (readPagePath = TEMPLATE_PATH): Promise<void> => {
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  expect(createProfile(database, { ...testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), approvedServiceOrigins: [API_ORIGIN] },
    { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  expect(createStartingJob(database, {
    jobId: DISCOVERY_JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: DISCOVERED_AT,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, DISCOVERY_JOB_ID, 0, DISCOVERED_AT)).toBe(true);
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT,
    entries: mergeDiscoveryCandidates([CREATE_CANDIDATE, LIST_CANDIDATE]).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  expect(createReadCheck(database, {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID,
    definition: { targetPagePath: readPagePath, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, at: DISCOVERED_AT,
  })).toMatchObject({ ok: true });
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
  // 台帳: API の登録（ID は応答の本文の鍵 `id`）。メールは実行のたびに違う値になる欄（行を選ぶ欄）。
  expect(createScenario(database, {
    scenarioId: CREATE_ID, draft: draftOf(CREATE_CANDIDATE, ['email', 'name', 'score'], { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }, 'email'),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
  attachRules(CREATE_ID, [EMAIL_RULE, fixedRuleOf('name', ['登録一郎']), fixedRuleOf('score', ['1'])], null, CREATED_AT);
  approve(CREATE_ID, 'receipt-create');
  // 一覧の行の更新: 変える鍵は名前、保つ鍵はメールと点数（既定）、行を選ぶ欄はメール。
  expect(createScenario(database, {
    scenarioId: UPDATE_ID,
    draft: draftOf(LIST_CANDIDATE, ['name'], {
      filterName: 'id',
      ledger: {
        targetCreateScenarioId: CREATE_ID, formPathTemplate: LIST_PATH,
        listRow: { listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' },
      },
    }, 'name'),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
  attachRules(UPDATE_ID, [fixedRuleOf('name', ['更新一郎', '更新二郎'])], null, CREATED_AT);
  approve(UPDATE_ID, 'receipt-update');
  registerVerified(0, { name: '登録 0', email: 'sample0000@example.invalid', score: '1' });
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-api-list-row-grant-start-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('LU-8 fix round 1: a list row API UPDATE from the grant to the write specification', () => {
  beforeEach(async () => {
    await prepare();
  });

  it('sends the write specification with the list page, the row key value and the deferred prior values mark', async () => {
    const worker = fakeWorker('api-list-row-update');
    manager = createFakeWorkerJobManager({
      database,
      workDirectory,
      worker,
      resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
      forkWorker: forks.fork,
      now: () => dateOfCompactUtcTimestamp(MANAGER_NOW),
    });
    const { writeJobs } = await runWriteChain(manager, PROFILE_ID, MIN_PROFILE_REVISION);
    const created = readWriteResult(database, writeJobs[0]?.jobId ?? '');
    expect(created).toMatchObject({ writeKind: 'CREATE', result: 'VERIFIED', recordId: CHAIN_CREATED_ID });
    const rowKeyValue = created?.submittedValues['email'];
    const [, start] = writeStagesOf(worker.received());
    const api = readScenario(database, UPDATE_ID)?.current.api;
    expect(start).toMatchObject({
      jobKind: 'WRITE_UPDATE',
      write: {
        transport: 'API',
        scenarioId: UPDATE_ID,
        grantId: readWriteResult(database, writeJobs[1]?.jobId ?? '')?.grantId,
        formPage: { origin: TEST_ORIGIN, path: LIST_PATH },
        update: {
          targetRecordId: CHAIN_CREATED_ID,
          knownKeptValues: [{ key: 'email', value: rowKeyValue }, { key: 'score', value: '1' }],
          listRow: { rowKeyValue, deferredPriorValues: { keptKeys: ['email', 'score'] } },
        },
      },
    });
    const write = start?.['write'] as Record<string, unknown>;
    expect(write['api']).toEqual(api);
    expect((write['api'] as { readonly ledger: Record<string, unknown> }).ledger['listRow'])
      .toEqual({ listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' });
    expect(Object.keys(write['values'] as Record<string, unknown>)).toEqual(['name']);
    expect(JSON.stringify(start)).not.toContain('bsprobe');
  }, TEST_TIMEOUT_MS);
});

// LU-7 fix round 2（設計書 5.5 の 7、K3）: 台帳と更新の照合の READ が一覧の画面の定義だけの、一覧の行の更新。許可の発行は、唯一の判定
// （`readVerificationUniqueRejectionOf`）で、行を選ぶ欄（メール）が台帳の登録の毎回違う欄かを見る。
describe('LU-7 fix round 2: the grant of a list row API UPDATE verified on the list page', () => {
  const issueGrant = () => issueExecutionGrant(database, {
    scenarioId: UPDATE_ID, expectedRevision: revisionOf(UPDATE_ID), grantId: 'grant-u1', jobId: 'job-u1', count: 1, external: facts, at: ISSUE_AT,
    expectedTargetRecordId: REGISTERED_IDS[1],
  });

  it('does not issue the grant when the row key field no longer differs each run in the ledger', async () => {
    await prepare(LIST_PATH);
    registerVerified(1, { name: '登録 1', email: ROW_KEY_VALUE, score: '1' });
    attachRules(CREATE_ID, [
      fixedRuleOf('email', ['fixed0001@example.invalid', 'fixed0002@example.invalid']), fixedRuleOf('name', ['登録一郎']), fixedRuleOf('score', ['1']),
    ], 1, RULES_CHANGED_AT);
    expect(readPlannedUpdateTarget(database, UPDATE_ID)).toBe(REGISTERED_IDS[1]);
    expect(issueGrant()).toMatchObject({ ok: false, reason: 'READ_VERIFICATION_NOT_VARYING' });
  }, TEST_TIMEOUT_MS);
});
