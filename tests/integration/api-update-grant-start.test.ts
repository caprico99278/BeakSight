// T41b（Task 41 の設計書 3.2、8 章の「T41a・T41c の報告と設計者の判断」）: API の更新（UPDATE）のシナリオの、下書き → 承認 → 点検の登録の段 → 許可（同じ
// 点検で照合まで済んだ登録）→ 更新の段の書き込みの指定が届く、までを、本物の管理データとジョブの管理（`createAuditJobManager`）と偽のワーカー
// （`tests/helpers/fake-audit-worker.ts` の `chain`。本物の `fork`）で確かめる。ワーカーの更新の流れは T41d なので、ここでは書き込みの指定の中身だけを見る。
// SLIM W-1: 単独で書き込みを始める口を外したので、点検（`tests/helpers/chain-write-support.ts`）を通す。
// - 台帳は API の登録のシナリオ（ID を応答の本文の鍵 `id` から取る。filter の名前と同じ）。
// - 書き込みの指定: ジョブの種類 `WRITE_UPDATE`、`api` はシナリオの API の指定のまま、`values` は変える鍵だけ、`update: { targetRecordId }`、書き込みの画面は
//   台帳の画面の path の型に対象の ID を入れた具体的な path。保つ鍵の値は台帳の登録で送った値（BeakSight が作ったテストの値）、probe の目印を持たない。
// - 発行の確かめ直し: 台帳の ID の鍵を filter の名前と違う鍵に替えると、`SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID` で許可を出さない。
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
  readScenario,
  readScenarioApprovalStatus,
  updateScenario,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { readAuditedDataLedger, readWriteResult } from '../../src/control/actions/write-result-facts.js';
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
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
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
const FAKE_RUN_ID = 'RUN-20261018000000';
const UPDATE_RUN_ID = 'RUN-20261018000100';
/** 点検の登録の段で取れる ID（台帳の登録 6・7 の後）。 */
const CHAIN_CREATED_ID = '8';
const OUTPUT_DIRECTORY = 'api-update-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-api-update' } });
const PROFILE_ID = 'example-api-update';
const CREATE_ID = 'scenario-api-create';
const UPDATE_ID = 'scenario-api-update';
const READ_CHECK_ID = 'rc-page';
const DISCOVERY_JOB_ID = 'job-apiu-d1';
const API_ORIGIN = 'https://api.example.invalid';
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
const TEMPLATE_PATH = '/admin/members/{id}/edit';
/** 発見・シナリオ・承認・登録（2 件。連続の上限の 5 分を空ける）・更新の許可・ジョブの管理の時刻。 */
const DISCOVERED_AT = '20261018000000';
const CREATED_AT = '20261018001000';
const APPROVED_AT = '20261018002000';
const REGISTERED_AT = ['20261018003000', '20261018004000'] as const;
const ISSUE_AT = '20261018005000';
const MANAGER_NOW = '20261018005100';
const REGISTERED_IDS = ['6', '7'] as const;

const PROBE_MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#score', type: 'number', marker: 2 },
];
const BODY = { name: PROBE_MARKERS[0], email: PROBE_MARKERS[1], score: Number(PROBE_MARKERS[2]) };

/** form のない画面の保存のボタン（probe が API の型を見た候補）。 */
const buttonOf = (path: string, method: string, url: string): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: TEST_ORIGIN, path }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method, resourceType: 'fetch', url, origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' }, body: { kind: 'TEXT', text: JSON.stringify(BODY) },
    }, { pagePath: path, markers: PROBE_MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
});
const CREATE_CANDIDATE = buttonOf(NEW_PATH, 'POST', `${API_ORIGIN}/rest/v1/members?select=*`);
const UPDATE_CANDIDATE = buttonOf(EDIT_PATH, 'PATCH', `${API_ORIGIN}/rest/v1/members?id=eq.1&select=*`);
/** T41R-fix-B: 別の表（注文）の登録の画面の保存（台帳にすると、会員の更新は別の表の同じ番号の行を指しうる）。 */
const ORDER_CREATE_CANDIDATE = buttonOf('/admin/orders/new', 'POST', `${API_ORIGIN}/rest/v1/orders?select=*`);

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
  pages: [pageOf(CREATE_CANDIDATE), pageOf(UPDATE_CANDIDATE), pageOf(ORDER_CREATE_CANDIDATE)],
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
 * 書かずに終わる（ワーカーの更新の流れは T41d）。
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

/** 入力の規則（人の固定の値。照合の READ の期待の欄は、実行のたびに変わる値にするため 2 つ）を付けて承認する。 */
const attachAndApprove = (scenarioId: string, values: Readonly<Record<string, readonly string[]>>, receiptId: string): void => {
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: {
      fieldRules: Object.entries(values).map(([fieldName, fixedValues]) => ({
        fieldName, semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [...fixedValues],
      })) as never,
      relations: [],
      uniqueKeyFieldNames: [],
    },
    expectedScenarioRevision: revisionOf(scenarioId), at: CREATED_AT,
  });
  if (saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  }
  const status = readScenarioApprovalStatus(database, scenarioId, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  expect(approveScenario(database, {
    scenarioId, expectedRevision: revisionOf(scenarioId), expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: facts, at: APPROVED_AT,
  })).toMatchObject({ ok: true });
};

/** 台帳の登録のシナリオの、照合まで済んだ登録を 1 件作る（発行 → 消費 → 送る前の記録 → `VERIFIED` の締め）。 */
const registerVerified = (index: 0 | 1): void => {
  const at = REGISTERED_AT[index];
  seedWriteResultForTest(database, {
    profileId: PROFILE_ID, scenarioId: CREATE_ID, scenarioRevision: revisionOf(CREATE_ID), grantId: `grant-c${index}`, jobId: `job-c${index}`,
    external: facts, at, submittedValues: { name: `登録 ${index}`, email: `sample000${index}@example.invalid`, score: '1' },
    report: {
      submission: 'SENT', blockReason: null, httpStatus: 201, responseJudgement: 'SUCCESS', recordId: REGISTERED_IDS[index], readVerification: 'MATCHED',
      submittedAt: at,
    },
  });
};

const prepare = async (): Promise<void> => {
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
    entries: mergeDiscoveryCandidates([CREATE_CANDIDATE, UPDATE_CANDIDATE, ORDER_CREATE_CANDIDATE]).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  expect(createReadCheck(database, {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID,
    definition: { targetPagePath: TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, at: DISCOVERED_AT,
  })).toMatchObject({ ok: true });
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
  // 台帳: API の登録（ID は応答の本文の鍵 `id`）。
  expect(createScenario(database, {
    scenarioId: CREATE_ID, draft: draftOf(CREATE_CANDIDATE, ['email', 'name', 'score'], { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }, 'email'),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
  attachAndApprove(CREATE_ID, { email: ['sample0101@example.invalid', 'sample0102@example.invalid'], name: ['登録一郎'], score: ['1'] }, 'receipt-create');
  // 更新: 変える鍵は名前、保つ鍵はメールと点数（既定）。
  expect(createScenario(database, {
    scenarioId: UPDATE_ID,
    draft: draftOf(UPDATE_CANDIDATE, ['name'], { filterName: 'id', ledger: { targetCreateScenarioId: CREATE_ID, formPathTemplate: TEMPLATE_PATH } }, 'name'),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
  attachAndApprove(UPDATE_ID, { name: ['更新一郎', '更新二郎'] }, 'receipt-update');
  registerVerified(0);
  registerVerified(1);
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-api-update-grant-start-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  await prepare();
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('T41b: an API UPDATE from the grant to the write specification', () => {
  it('issues a grant on the registration verified in the same inspection and sends the agreed write specification of the API UPDATE', async () => {
    const worker = fakeWorker('api-update');
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
    const [, start] = writeStagesOf(worker.received());
    const grantId = readWriteResult(database, writeJobs[1]?.jobId ?? '')?.grantId;
    const api = readScenario(database, UPDATE_ID)?.current.api;
    expect(start).toMatchObject({
      jobKind: 'WRITE_UPDATE',
      write: {
        transport: 'API',
        scenarioId: UPDATE_ID,
        grantId,
        formPage: { origin: TEST_ORIGIN, path: `/admin/members/${CHAIN_CREATED_ID}/edit` },
        // T41R2-fix-B・T41R3-fix-B: 台帳の登録で送った保つ鍵（メールと点数）の最後に分かっている値（BeakSight が作ったテストの値）。
        update: {
          targetRecordId: CHAIN_CREATED_ID,
          knownKeptValues: [{ key: 'email', value: created?.submittedValues['email'] }, { key: 'score', value: '1' }],
        },
        verification: { resultJudgement: null, recordId: null },
        readVerification: { definition: { targetPagePath: TEMPLATE_PATH } },
      },
    });
    const write = start?.['write'] as Record<string, unknown>;
    expect(write['api']).toEqual(api);
    expect(Object.keys(write['values'] as Record<string, unknown>)).toEqual(['name']);
    expect(['更新一郎', '更新二郎']).toContain((write['values'] as Record<string, unknown>)['name']);
    expect(JSON.stringify(start)).not.toContain('bsprobe');
  }, TEST_TIMEOUT_MS);

  // T41R-fix-B（Task 41 の設計書 8 章の「T41R の完全版」の I-1）: 台帳が別の表（注文）の API の登録なら、ID の鍵と filter の名前が同じでも、会員の更新の
  // シナリオを保存しない（同じ表であることを、登録と更新の API の Origin と path の型で求める）。
  it('does not save an API UPDATE whose ledger is an API CREATE of another table', () => {
    expect(createScenario(database, {
      scenarioId: 'scenario-api-orders',
      draft: draftOf(ORDER_CREATE_CANDIDATE, ['email', 'name', 'score'], { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }, 'email'),
      discovery: DISCOVERY, at: CREATED_AT,
    } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
    const saved = createScenario(database, {
      scenarioId: 'scenario-api-update-orders',
      draft: draftOf(UPDATE_CANDIDATE, ['name'], { filterName: 'id', ledger: { targetCreateScenarioId: 'scenario-api-orders', formPathTemplate: TEMPLATE_PATH } }, 'name'),
      discovery: DISCOVERY, at: CREATED_AT,
    } as Parameters<typeof createScenario>[1]);
    expect(saved.ok ? [] : [saved.reason, ...(saved.draftErrors ?? []).map(({ code }) => code)])
      .toEqual(['SCENARIO_DRAFT_INVALID', 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']);
    expect(readScenario(database, 'scenario-api-update-orders')).toBeNull();
  });

  it('checks the binding of the ledger id to the filter again at the issue', () => {
    // 台帳の登録の ID の鍵を、filter の名前（id）と違う鍵に替える（更新のシナリオの承認は、台帳の版に縛られないので有効のまま）。
    const create = readScenario(database, CREATE_ID);
    expect(updateScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: create?.revision ?? 0, discovery: DISCOVERY, at: ISSUE_AT,
      draft: draftOf(CREATE_CANDIDATE, ['email', 'name', 'score'], { recordId: { source: 'RESPONSE_BODY_KEY', key: 'member_id' } }, 'email'),
    } as Parameters<typeof updateScenario>[1])).toMatchObject({ ok: true });
    expect(issueExecutionGrant(database, {
      scenarioId: UPDATE_ID, expectedRevision: revisionOf(UPDATE_ID), grantId: 'grant-u2', jobId: 'job-u2', count: 1, external: facts, at: ISSUE_AT,
      expectedTargetRecordId: REGISTERED_IDS[1],
    })).toMatchObject({ ok: false, reason: 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID' });
  });
  // OP-H（撮影 UI-W4 の不具合 1）: API の UPDATE の書き込みの後も、作ったデータの一覧（台帳）が読める。API の UPDATE の台帳の参照は `api.ledger`
  // （唯一の決まり `updateLedgerScenarioIdOf`）。更新は、台帳の登録の同じ ID の行にだけ数える。
  it('reads the audited data ledger after an API UPDATE write, counting it on the registration of its ledger', () => {
    seedWriteResultForTest(database, {
      profileId: PROFILE_ID, scenarioId: UPDATE_ID, scenarioRevision: revisionOf(UPDATE_ID), grantId: 'grant-u3', jobId: 'job-u3',
      external: facts, at: ISSUE_AT, submittedValues: { name: '更新一郎' }, expectedTargetRecordId: REGISTERED_IDS[1],
      report: {
        submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: REGISTERED_IDS[1], readVerification: 'MATCHED',
        submittedAt: ISSUE_AT,
        updateEvidence: { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: '登録 1', newValue: '更新一郎', matched: true }] },
      },
    });
    const ledger = readAuditedDataLedger(database, PROFILE_ID);
    expect(ledger.map(({ jobId, recordId, updates }) => [jobId, recordId, updates.count, updates.last?.jobId ?? null])).toEqual([
      ['job-c1', REGISTERED_IDS[1], 1, 'job-u3'],
      ['job-c0', REGISTERED_IDS[0], 0, null],
    ]);
  });
});
