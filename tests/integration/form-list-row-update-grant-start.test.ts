// LU-12b（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D5、5.5 の最後の段）: 行の下に広がるフォーム（形 B）の更新の、下書き → 承認 → 点検の
// 登録の段 → 許可（同じ点検で照合まで済んだ登録）→ 更新の段の書き込みの指定が届く、までを、本物の管理データとジョブの管理（`createAuditJobManager`）と偽のワーカー
// （`tests/helpers/fake-audit-worker.ts` の `chain`。本物の `fork`）で確かめる。作法は `api-list-row-update-grant-start.test.ts`。
// - 書き込みの指定: 書き込みの画面は一覧の画面の path（番号を入れない）、送信先は送信先の型に台帳の番号を入れた path、`update.listRow`（一覧の path・開き手・行を
//   選ぶ値）と `update.knownKeptValues`（保つ欄の台帳の最後の値）。ジョブの管理は、台帳の登録の今の入力の規則で行を選ぶ欄を確かめ直す（`audit-job-manager.ts` の
//   `ledgerUniqueEachRunFieldNames`。LU-12b でフォームの `update.listRow` にも広げた）。
// - SLIM W-1: 単独で書き込みを始める口を外した。行を選ぶ欄が毎回違う欄でなくなったときに書き込みの指定を作らないことは、組み立ての単体
//   （`tests/unit/api-list-row-update-start.test.ts` の LU-12b）が確かめる。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  approveScenario,
  createScenario,
  readScenario,
  readScenarioApprovalStatus,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { ACTION_RUN_SCHEMA_VERSION } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
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
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import { submissionProbeOpenerOf } from '../../src/discovery/submission-probe-contracts.js';
import { chainWriteWorkerValues, runWriteChain, writeStagesOf } from '../helpers/chain-write-support.js';
import { writeFakeWorker, type FakeWorker } from '../helpers/fake-audit-worker.js';
import { seedWriteResultForTest } from '../helpers/write-result-fixtures.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { awaitWorkersExit, createFakeWorkerJobManager, withOutputDirectory } from '../helpers/job-test-support.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { sampleAction, sampleButton, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const TEST_TIMEOUT_MS = 60_000;
/** 点検の登録の段と更新の段の Run の ID。 */
const FAKE_RUN_ID = 'RUN-20261103000000';
const UPDATE_RUN_ID = 'RUN-20261103000100';
/** 点検の登録の段で取れる ID（台帳の登録 6 の後）。 */
const CHAIN_CREATED_ID = '8';
const OUTPUT_DIRECTORY = 'form-list-row-update-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-form-list-row' } });
const PROFILE_ID = 'example-form-list-row';
const CREATE_ID = 'scenario-form-create';
const UPDATE_ID = 'scenario-form-list-row-update';
const READ_CHECK_ID = 'rc-search';
const DISCOVERY_JOB_ID = 'job-fplr-d1';
const NEW_PATH = '/admin/items/new';
const LIST_PATH = '/admin/items';
const DISCOVERED_AT = '20261103000000';
const CREATED_AT = '20261103001000';
const APPROVED_AT = '20261103002000';
const REGISTERED_AT = ['20261103003000', '20261103004000'] as const;
const MANAGER_NOW = '20261103005100';
const REGISTERED_IDS = ['6', '7'] as const;

const location = (path: string) => ({ origin: TEST_ORIGIN, path });
/** テストの Origin を許可 Origin として分類した候補（発見の文書の候補の形）。 */
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered, ...classifyCandidate(discovered, { allowedOrigins: new Set([TEST_ORIGIN]) }), ...computeCandidateDigests(discovered),
});
/** 登録の form（題名とメール）、一覧の検索の form（READ）、一覧の行のフォーム（同じ行の「編集」が開く。番号 1 の行）。 */
const CREATE_CANDIDATE = candidateOf(sampleForm({
  page: location(NEW_PATH), action: sampleAction(LIST_PATH, [], TEST_ORIGIN), submitterText: '登録',
  fields: [sampleField('title', 'text', { required: true }), sampleField('email', 'email', { required: true })],
}));
const SEARCH_CANDIDATE = candidateOf(sampleForm({
  page: location(LIST_PATH), formMethod: 'GET', action: sampleAction(LIST_PATH, [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));
const EDIT_BUTTON = candidateOf(sampleButton({ page: location(LIST_PATH), submitterText: '編集' }));
const OPENER = submissionProbeOpenerOf(EDIT_BUTTON.identityDigest, true, ['編集']);
const ROW_FORM_CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleForm({
    page: location(LIST_PATH), action: sampleAction(`${LIST_PATH}/1`, [], TEST_ORIGIN), submitterText: '保存',
    fields: [sampleField('title', 'text', { hasValue: true }), sampleField('email', 'email', { hasValue: true })],
  })),
  rowOpener: OPENER,
};

const pageOf = (path: string, candidates: readonly DiscoveryCandidate[]) => ({
  url: `${TEST_ORIGIN}${path}`, state: 'READ', record: { location: location(path), incompleteReasons: [], candidates }, blockedRequests: 0,
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
  pages: [pageOf(NEW_PATH, [CREATE_CANDIDATE]), pageOf(LIST_PATH, [SEARCH_CANDIDATE, ROW_FORM_CANDIDATE])],
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
 * 書かずに終わる（ワーカーの形 B の流れは `form-list-row-update-run.test.ts`）。段のジョブの id・許可の id・seed の記録・送った値は、偽のワーカーが置き換える印。
 */
const fakeWorker = (name: string): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  const createRun = {
    schemaVersion: ACTION_RUN_SCHEMA_VERSION, jobId: '__START_JOB_ID__', runId: FAKE_RUN_ID, profileId: PROFILE_ID, scenarioId: CREATE_ID,
    scenarioRevision: revisionOf(CREATE_ID), grantId: '__START_GRANT_ID__', seedRecord: '__START_SEED_RECORD__', submittedValues: '__START_VALUES__',
    resultJudgement: 'FORM_STRUCTURE', submission: 'SENT', blockReason: null, httpStatus: 303, responseJudgement: 'SUCCESS', recordId: CHAIN_CREATED_ID,
    readVerification: { readCheckId: READ_CHECK_ID, readCheckRevision: 1, result: 'MATCHED' }, reservationState: 'COMMITTED', result: 'VERIFIED',
    reason: 'READ_VERIFICATION_MATCHED', startedAt: MANAGER_NOW, submittedAt: MANAGER_NOW, finishedAt: MANAGER_NOW, transport: 'FORM', api: null,
  };
  return writeFakeWorker(directory, 'chain', chainWriteWorkerValues({
    outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), discovery: DISCOVERY, writeRunId: FAKE_RUN_ID,
    write: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), runIds: [FAKE_RUN_ID, UPDATE_RUN_ID], recheck: 1, onReject: 'report',
      submission: { submission: 'SENT', blockReason: null }, end: 'finish', report: null, actionRunText: JSON.stringify(createRun),
      updateStage: { submission: null, actionRunText: null, end: 'crash' },
    },
  }));
};

/** 照合の READ（一覧の検索の form に、題名を結ぶ）。 */
const VERIFICATION = Object.freeze({
  readVerification: {
    readCheckId: READ_CHECK_ID, revision: 1, bindings: [{ parameterName: 'q', fieldName: 'title' }], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'title' }],
  },
});

const draftOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], extra: Record<string, unknown>) => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  ...extra,
});

type FieldRuleInput = Readonly<Record<string, unknown>>;

const fixedRuleOf = (fieldName: string, fixedValues: readonly string[]): FieldRuleInput =>
  ({ fieldName, semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [...fixedValues] });
/** 実行のたびに違う値になる欄の規則（合成の番号つきのメール）。 */
const EMAIL_RULE: FieldRuleInput = Object.freeze({ fieldName: 'email', semanticKind: 'EMAIL', method: 'FROM_TYPE', range: null, fixedValues: [] });

const attachRules = (scenarioId: string, fieldRules: readonly FieldRuleInput[], expectedRuleRevision: number | null, at: string): void => {
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: expectedRuleRevision,
    content: { fieldRules: fieldRules as never, relations: [], uniqueKeyFieldNames: [] },
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
    confirmSideEffects: true,
  })).toMatchObject({ ok: true });
};

/** 台帳の登録のシナリオの、照合まで済んだ登録を 1 件作る。 */
const registerVerified = (index: 0 | 1, submittedValues: Readonly<Record<string, string>>): void => {
  const at = REGISTERED_AT[index];
  seedWriteResultForTest(database, {
    profileId: PROFILE_ID, scenarioId: CREATE_ID, scenarioRevision: revisionOf(CREATE_ID), grantId: `grant-c${index}`, jobId: `job-c${index}`,
    external: facts, at, submittedValues,
    report: {
      submission: 'SENT', blockReason: null, httpStatus: 303, responseJudgement: 'SUCCESS', recordId: REGISTERED_IDS[index], readVerification: 'MATCHED',
      submittedAt: at,
    },
  });
};

/** 台帳（form の登録）と形 B の更新のシナリオを作り、承認する（台帳の登録は 1 件目だけ）。 */
const prepare = async (): Promise<void> => {
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  expect(createProfile(database, testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  expect(createStartingJob(database, {
    jobId: DISCOVERY_JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: DISCOVERED_AT,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, DISCOVERY_JOB_ID, 0, DISCOVERED_AT)).toBe(true);
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT,
    entries: mergeDiscoveryCandidates([CREATE_CANDIDATE, SEARCH_CANDIDATE, ROW_FORM_CANDIDATE]).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  expect(createReadCheck(database, {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID,
    definition: { targetIdentityDigest: SEARCH_CANDIDATE.identityDigest, parameters: { q: '' }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, at: DISCOVERED_AT,
  })).toMatchObject({ ok: true });
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
  // 台帳: form の登録（ID は送った後の URL の型）。メールは実行のたびに違う値になる欄（行を選ぶ欄）。
  const created = createScenario(database, {
    scenarioId: CREATE_ID,
    draft: draftOf(CREATE_CANDIDATE, ['email', 'title'], {
      verification: { recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${LIST_PATH}/{id}`] }, ...VERIFICATION },
    }),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1]);
  if (!created.ok) throw new Error(`the ledger was rejected: ${JSON.stringify(created)}`);
  attachRules(CREATE_ID, [EMAIL_RULE, fixedRuleOf('title', ['登録一郎'])], null, CREATED_AT);
  approve(CREATE_ID, 'receipt-create');
  // 形 B の更新: 変える欄は題名、保つ欄と行を選ぶ欄はメール。
  const update = createScenario(database, {
    scenarioId: UPDATE_ID,
    draft: draftOf(ROW_FORM_CANDIDATE, ['title'], {
      verification: { recordId: null, ...VERIFICATION },
      update: {
        targetCreateScenarioId: CREATE_ID, formPathTemplate: LIST_PATH, actionPathTemplate: `${LIST_PATH}/{id}`, keepFieldNames: ['email'],
        listRow: { listPagePath: LIST_PATH, openerIdentityDigest: OPENER.identityDigest, rowKeyField: 'email' },
      },
    }),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1]);
  if (!update.ok) throw new Error(`the update was rejected: ${JSON.stringify(update)}`);
  attachRules(UPDATE_ID, [fixedRuleOf('title', ['更新一郎', '更新二郎'])], null, CREATED_AT);
  approve(UPDATE_ID, 'receipt-update');
  registerVerified(0, { title: '登録 0', email: 'sample0000@example.invalid' });
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-form-list-row-grant-start-'));
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

describe('LU-12b: a list row form UPDATE from the grant to the write specification', () => {
  beforeEach(async () => {
    await prepare();
  });

  it('sends the write specification with the list page, the action of the ledger record, the row and the ledger values of the kept fields', async () => {
    const worker = fakeWorker('form-list-row-update');
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
    expect(start).toMatchObject({
      jobKind: 'WRITE_UPDATE',
      write: {
        scenarioId: UPDATE_ID,
        grantId: readWriteResult(database, writeJobs[1]?.jobId ?? '')?.grantId,
        formPage: { origin: TEST_ORIGIN, path: LIST_PATH },
        request: { path: `${LIST_PATH}/${CHAIN_CREATED_ID}` },
        readVerification: { definition: { targetIdentityDigest: SEARCH_CANDIDATE.identityDigest } },
        update: {
          targetRecordId: CHAIN_CREATED_ID,
          changedFieldNames: ['title'],
          keptFieldNames: ['email'],
          knownKeptValues: [{ key: 'email', value: rowKeyValue }],
          listRow: { listPagePath: LIST_PATH, openerIdentityDigest: OPENER.identityDigest, rowKeyValue },
        },
      },
    });
    expect(Object.keys((start?.['write'] as Record<string, unknown>)['values'] as Record<string, unknown>)).toEqual(['title']);
  }, TEST_TIMEOUT_MS);
});
