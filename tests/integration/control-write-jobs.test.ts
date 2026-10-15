// T30e（Task 30 の設計書 3 章の「送る直前の確かめ直し」「予約の締め」「`UNKNOWN` の後」、4 章の「IPC」）: 書き込みのジョブ（`WRITE_CREATE`）の、ジョブの
// 管理（`createAuditJobManager` の `startWriteCreate`、IPC の確かめ直しの往復と送信の報告、ジョブの終わりの締め）を、偽のワーカー
// （`tests/helpers/fake-audit-worker.ts` の `write` の動き）を本物の `fork` で起動して確かめる（ワーカーの書き込みの流れは T30f）。
// - 開始の確かめの順: 操作の行・プラットフォーム・認証の設定 → 同時に 1 つの枠（ジョブの行。ジョブの id は許可に結び付けた id）→ 許可の消費 → 生成
//   （生成の履歴を渡す）→ 送る前の記録 → `START`。どの段で拒んでも、予約が `RESERVED` のまま残らない。
// - IPC: `START` の書き込みの指定（生成した値と、生成した値を結び付けた照合の READ）。確かめ直しの依頼は 1 回（2 回目は拒んで `STOP`）、撤回の後は
//   拒んで `STOP`。送信の報告は 1 回。
// - 締め: ジョブの終わりで必ず 1 回。`action-run.json` が読めて合えば、その中身から（判定は締めの部品が決め直す）。読めない・異常終了・応答なしは、
//   `NOT_SENT` の報告があれば `BLOCKED`・`RELEASED`、ほかは `UNKNOWN`。二重に締めない。画面のサーバの再起動の後の回復も、ジョブの管理から。
// T31f（Task 31 の設計書 3 章、4 章の「IPC」）: 更新の書き込みのジョブ（`WRITE_UPDATE`。`startWriteUpdate`）も、同じ偽のワーカーで確かめる。
// - 開始: 許可の対象の ID を `START` に写し、画面の path と送信先の path は型に対象の ID を入れた具体的な path。保つ欄の値と前の値は送らない。
//   許可の対象と違うシナリオ・CREATE の許可（と、CREATE の開始への UPDATE の許可）・消費済みの許可は拒む。どの拒みでも、その依頼の許可の予約を
//   `RESERVED` のまま残さない。生成の履歴は、同じ台帳の CREATE と UPDATE の送った値を含む（CREATE の開始でも）。
// - 締め: UPDATE の `action-run.json`（`update` の対象の ID と証拠、取れた ID）から。対象の ID の違う・`update` のない成果物は使わない。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。値は匿名の合成のテストデータだけ。
import { unzipSync, zipSync } from 'fflate';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import {
  ACTION_RUN_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  type ActionRunDocument,
  type ApprovalSummaryDocument,
  type WriteUpdateEvidence,
} from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  approveScenario,
  consumeExecutionGrant,
  issueExecutionGrant,
  readExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  readUsedCumulativeWrites,
  recordWriteAttempt,
  revokeScenarioApproval,
  settleWriteResult,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { RuleSetContent } from '../../src/control/data-rules/rule-contracts.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import {
  createAuditJobManager,
  type AuditJobManager,
} from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { checkWriteReport } from '../../src/control/job/write-report-check.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION } from '../../src/control/worker-protocol.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
} from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { createActionBundle } from '../../src/report/action-bundle.js';
import { verifiedCreateDocuments } from '../helpers/action-report-samples.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  CONTROL_JOB_TEST_TIMING,
  FAKE_WORKER_HEARTBEAT_INTERVAL_MS,
  awaitWorkersExit,
  isJobEnded,
  waitForJob,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { CREATE_CANDIDATE, UPDATE_CANDIDATE, UPDATE_TEMPLATED_IDENTITY_DIGEST } from '../unit/approval-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, publicProfile, resolveTestContext } from './control-profile-fixtures.js';
import {
  APPROVED_AT,
  DISCOVERY_JOB_ID,
  GRANT_PROFILE_ID,
  discoveryDocumentOf,
  prepareGrantProfile,
  prepareScenario,
  prepareUpdateScenario,
  VERIFICATION_SPEC,
} from './execution-grant-fixtures.js';

const TEST_TIMEOUT_MS = 60_000;
const FAKE_RUN_ID = 'RUN-20261012000000';
const OTHER_RUN_ID = 'RUN-20261012000999';
const OUTPUT_DIRECTORY = 'write-jobs-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-write' } });
const PUBLIC_PROFILE_ID = 'example-public-write';
/** 許可の発行の時刻と、ジョブの管理の時計（許可の期限の中）。 */
const ISSUE_AT = '20261012030000';
const MANAGER_NOW = '20261012030100';
const MINUTE_MS = 60_000;

const SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: GRANT_PROFILE_ID,
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

/** 人の固定の値の規則（一意にする欄の組は氏名。2 回目の生成は、組を使い切って止まる）。 */
const FIXED_CONTENT: RuleSetContent = {
  fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['試験一郎'] }],
  relations: [],
  uniqueKeyFieldNames: ['name'],
};

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
let facts: ApprovalExternalFacts;
let clock = dateOfCompactUtcTimestamp(MANAGER_NOW);
const forks = createCountingFork();

const timeAt = (offsetMs: number): string => formatCompactUtcTimestamp(new Date(dateOfCompactUtcTimestamp(ISSUE_AT).getTime() + offsetMs), 'test time');

const fakeWorker = (name: string, write: NonNullable<FakeWorkerValues['write']> | null): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, 'write', {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    runId: FAKE_RUN_ID,
    otherRunId: OTHER_RUN_ID,
    heartbeatIntervalMs: FAKE_WORKER_HEARTBEAT_INTERVAL_MS,
    exitCodes: {
      complete: EXIT_CODES.COMPLETE,
      partial: EXIT_CODES.PARTIAL,
      interrupted: INTERRUPTED_EXIT_CODE,
      configError: EXIT_CODES.CONFIG_ERROR,
      failure: FAILURE_EXIT_CODE,
    },
    ...(write === null ? {} : { write }),
  });
};

async function managerWith(worker: FakeWorker): Promise<AuditJobManager> {
  await manager?.close();
  manager = createAuditJobManager({
    database,
    repositoryRoot: workDirectory,
    workerPath: worker.path,
    resolveContext: (path) => {
      const context = resolveTestContext(path);
      return context === undefined ? undefined : { targetConfig: { ...context.targetConfig, output: { directory: OUTPUT_DIRECTORY } } };
    },
    forkWorker: forks.fork,
    timing: CONTROL_JOB_TEST_TIMING,
    now: () => clock,
  });
  return manager;
}

/** 今のジョブの管理から、ジョブの見え方を読む（ない間は null）。 */
const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };

/** ジョブが終わり、動いているワーカーがない。 */
const isEndedWithoutWorker = (job: AuditJobView): boolean => isJobEnded(job) && (manager?.runningWorkerCount() ?? 0) === 0;

/** 許可を発行する（ジョブの id は `job-w<slot>`、許可の id は `grant-<slot>`）。 */
const issue = (slot: number, at = ISSUE_AT, scenarioId = 'scenario-1'): { readonly grantId: string; readonly jobId: string } => {
  const issued = issueExecutionGrant(database, {
    scenarioId, expectedRevision: readScenario(database, scenarioId)?.revision ?? 0, grantId: `grant-${slot}`, jobId: `job-w${slot}`, count: 1,
    external: facts, at,
  });
  if (!issued.ok) {
    throw new Error(`not issued: ${issued.reason}`);
  }
  return { grantId: issued.grant.grantId, jobId: issued.grant.jobId };
};

/** 送る前の記録に直接書くときの seed の記録（ジョブを通さない回復のテスト）。 */
const fixedSeedRecordOf = (grantId: string): ActionRunDocument['seedRecord'] => ({
  seed: 'a'.repeat(64) as DataSeed,
  seedInput: { profileId: GRANT_PROFILE_ID, scenarioId: 'scenario-1', scenarioRevision: 2, ruleSetDigest: `sha256:${'b'.repeat(64)}`, executionGrantId: grantId },
  baseDate: '2026-10-12',
  attempt: 0,
});

/**
 * 照合まで済んだ `action-run.json`（`VERIFIED`）。T30f: seed の記録は、偽のワーカーが START の値に置き換える印（本物のワーカーと同じく、受けた値を書く）。
 */
const actionRunOf = (jobId: string, grantId: string, overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({
  schemaVersion: ACTION_RUN_SCHEMA_VERSION,
  jobId,
  runId: FAKE_RUN_ID,
  profileId: GRANT_PROFILE_ID,
  scenarioId: 'scenario-1',
  scenarioRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
  grantId,
  seedRecord: '__START_SEED_RECORD__' as never,
  submittedValues: { name: '試験一郎' },
  resultConditions: { successCondition: VERIFICATION_SPEC.successCondition ?? { pathPrefix: '/', selector: null },
    inputErrorCondition: VERIFICATION_SPEC.inputErrorCondition ?? { pathPrefix: '/', selector: null } },
  submission: 'SENT',
  blockReason: null,
  httpStatus: 200,
  responseJudgement: 'SUCCESS',
  recordId: '42',
  readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'MATCHED' },
  reservationState: 'COMMITTED',
  result: 'VERIFIED',
  reason: 'READ_VERIFICATION_MATCHED',
  startedAt: MANAGER_NOW,
  submittedAt: MANAGER_NOW,
  finishedAt: MANAGER_NOW,
  ...overrides,
});

const writeOf = (overrides: Partial<NonNullable<FakeWorkerValues['write']>> = {}): NonNullable<FakeWorkerValues['write']> => ({
  outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
  recheck: 1,
  onReject: 'report',
  submission: { submission: 'SENT', blockReason: null },
  actionRunText: null,
  end: 'finish',
  ...overrides,
});

/** T32e: 偽のワーカーに、書き込みの報告の承認の要約も書かせる（証拠は書かない。証拠の形は同じ process の中の流れのテストが確かめる）。 */
const WRITE_REPORT = Object.freeze({ approvalSummarySchemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION, actionEvidenceText: null });

/**
 * T32e（T32d の申し送り）: 偽のワーカーが書いた `approval-summary.json` を読み、スキーマに合い、親が `START` に入れた承認の要約の事実と同じで、
 * 値（種類、許可の ID と時刻、予約の件数、累積の使った件数、承認の記録）が管理データの事実と同じことを確かめる。
 */
async function expectApprovalSummaryOfParent(input: {
  readonly jobId: string;
  readonly grantId: string;
  readonly kind: 'CREATE' | 'UPDATE';
  readonly scenarioId: string;
  readonly start: readonly Record<string, unknown>[];
}): Promise<void> {
  const text = readFileSync(join(resolve(workDirectory, OUTPUT_DIRECTORY), FAKE_RUN_ID, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME), 'utf8');
  const summary = JSON.parse(text) as ApprovalSummaryDocument;
  expect(await validateArtifact('approval-summary', summary)).toEqual({ ok: true });
  const start = input.start.find((message) => message['type'] === 'START') as { readonly write: { readonly approvalFacts: unknown } } | undefined;
  expect(summary).toEqual({ ...(start?.write.approvalFacts as object), schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION, jobId: input.jobId, runId: FAKE_RUN_ID });
  const grant = readExecutionGrant(database, input.grantId);
  expect(summary).toMatchObject({
    profileId: GRANT_PROFILE_ID,
    scenario: { scenarioId: input.scenarioId, kind: input.kind },
    approval: { receiptId: grant?.approvalReceiptId, approver: 'LOCAL_OPERATOR' },
    revokedAtStart: false,
    grantAtStart: { grantId: input.grantId, issuedAt: grant?.issuedAt, expiresAt: grant?.expiresAt, consumedAt: MANAGER_NOW },
    reservationAtStart: { count: grant?.reservation.count, reservedAt: grant?.reservation.reservedAt },
    capturedAt: MANAGER_NOW,
  });
  expect(summary.cumulativeAtStart.used).toBe(readUsedCumulativeWrites(database, input.scenarioId, dateOfCompactUtcTimestamp(MANAGER_NOW)));
  expect(summary.cumulativeAtStart.used).toBeGreaterThanOrEqual(1);
  expect(summary.humanDecisions.includes('UPDATE_FIELD_ROLES')).toBe(input.kind === 'UPDATE');
  expect(summary.automatedActions.includes('TARGET_RECORD_SELECTION')).toBe(input.kind === 'UPDATE');
}

/** 書き込みのジョブを 1 回、偽のワーカーで行う。 */
async function runWriteJob(
  name: string,
  write: NonNullable<FakeWorkerValues['write']>,
  slot = 1,
  whileRunning?: () => void,
): Promise<AuditJobView & { readonly received: readonly Record<string, unknown>[] }> {
  const worker = fakeWorker(name, write);
  const jobs = await managerWith(worker);
  const started = await jobs.startWriteCreate({
    profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId: `grant-${slot}`,
  });
  if (!started.ok) {
    throw new Error(`the write job did not start: ${started.reason}`);
  }
  expect(started.job).toMatchObject({ jobId: `job-w${slot}`, jobKind: 'WRITE_CREATE', state: 'STARTING' });
  whileRunning?.();
  const ended = await waitForJob(currentManager, started.job.jobId, isEndedWithoutWorker);
  return { ...ended, received: worker.received() };
}

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

/** 承認を縛る管理データの外の事実（本物の求め方。資格情報を使わないプロファイル）。 */
const externalFacts = async (): Promise<ApprovalExternalFacts> => {
  const stored = getProfile(database, GRANT_PROFILE_ID);
  const value = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (value === null) {
    throw new Error('the external facts are not available');
  }
  return value;
};

/** シナリオを作り、規則の参照を付け、本物の事実で承認する。 */
const prepareApproved = async (ruleContent?: RuleSetContent): Promise<void> => {
  const latest = prepareGrantProfile(database);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
  const scenario = prepareScenario(database, latest, 'scenario-1', { approve: false, ...(ruleContent === undefined ? {} : { ruleContent }) });
  facts = await externalFacts();
  const status = readScenarioApprovalStatus(database, 'scenario-1', facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  expect(approveScenario(database, {
    scenarioId: 'scenario-1', expectedRevision: scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId: 'receipt-1',
    external: facts, at: APPROVED_AT,
  }).ok).toBe(true);
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-write-jobs-'));
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  clock = dateOfCompactUtcTimestamp(MANAGER_NOW);
  await prepareApproved(FIXED_CONTENT);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const reservationOf = (grantId: string): string | undefined => readExecutionGrant(database, grantId)?.reservation.state;

describe('write jobs (T30e): the start', () => {
  it('rejects an unknown grant, a grant of another job and a profile without the write operation, without a worker and without a reservation left', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const jobs = await managerWith(fakeWorker('rejects', writeOf()));
    const request = { profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId: 'grant-missing' };
    expect(await jobs.startWriteCreate(request)).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await jobs.startWriteCreate({ ...request, profileId: PUBLIC_PROFILE_ID })).toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    issue(1);
    expect(await jobs.startWriteCreate({ ...request, grantId: 'grant-1', scenarioId: 'scenario-other' }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await jobs.startWriteCreate({ ...request, grantId: 'Grant 1' } as never)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(forks.count()).toBe(0);
    expect(reservationOf('grant-1')).toBe('RESERVED');
    expect(readExecutionGrant(database, 'grant-1')?.consumedAt).toBeNull();
  });

  it('rejects a grant that a revocation invalidated (its reservation stays released), without a worker', async () => {
    const { grantId } = issue(1);
    expect(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
      receiptId: 'revoke-1', at: timeAt(30_000) }).ok).toBe(true);
    // 撤回は消費していない許可を無効にして予約を返す（ジョブの管理は、消費の前に許可を確かめて拒む）。
    const jobs = await managerWith(fakeWorker('revoked', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(reservationOf(grantId)).toBe('RELEASED');
    expect(forks.count()).toBe(0);
  });

  it('records the job FAILED and releases the reservation when the consumption fails after the job row (the target configuration changed)', async () => {
    const { grantId, jobId } = issue(1);
    writeFileSync(join(workDirectory, TEST_TARGET_PATH), JSON.stringify({ target: { id: 'example-write-changed' } }), 'utf8');
    const jobs = await managerWith(fakeWorker('changed', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: null, invalidatedAt: MANAGER_NOW, reservation: { state: 'RELEASED' } });
    expect(jobs.getAuditJob(jobId)).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    expect(forks.count()).toBe(0);
  });

  it('runs a write job: consumes the grant, records the attempt before START, sends the write specification, and settles the result once', async () => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob('verified', writeOf({ actionRunText: JSON.stringify(actionRunOf(jobId, grantId)), report: WRITE_REPORT }));
    // T32e（T32d の申し送り）: 親が組み立てた承認の要約の事実（START）を、偽のワーカーが書いた `approval-summary.json` で明示に確かめる。
    await expectApprovalSummaryOfParent({ jobId, grantId, kind: 'CREATE', scenarioId: 'scenario-1', start: ended.received });
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', failureReason: null, endKind: 'RAN' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: MANAGER_NOW, reservation: { state: 'COMMITTED' } });
    const result = readWriteResult(database, jobId);
    expect(result).toMatchObject({ grantId, submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED',
      submittedValues: { name: '試験一郎' } });
    const start = ended.received.find((message) => message['type'] === 'START') as Record<string, unknown> | undefined;
    expect(start).toMatchObject({
      jobId,
      jobKind: 'WRITE_CREATE',
      write: {
        scenarioId: 'scenario-1',
        grantId,
        request: { formMethod: 'POST', path: '/members' },
        candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest },
        values: { name: '試験一郎' },
        verification: { successCondition: VERIFICATION_SPEC.successCondition, inputErrorCondition: VERIFICATION_SPEC.inputErrorCondition,
          recordId: VERIFICATION_SPEC.recordId },
        readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, targetPage: null,
          definition: { parameters: { q: '試験一郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } },
      },
    });
    // 送る値は、送る前の記録と同じ（送る前に記録した）。
    expect((start?.['write'] as Record<string, unknown>)['values']).toEqual(result?.submittedValues);
    // T30f（Blocker 1 の案 A）: プロファイルと seed の記録も、送る前の記録と同じ値を送る。
    expect((start?.['write'] as Record<string, unknown>)['profileId']).toBe(GRANT_PROFILE_ID);
    expect((start?.['write'] as Record<string, unknown>)['seedRecord']).toEqual(result?.seedRecord);
    expect(ended.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null },
    ]);
    // ジョブの管理を作り直した後の回復は、締めた結果を変えない（二重に締めない）。
    expect((await managerWith(fakeWorker('after', writeOf()))).recoverInterruptedJobs()).toBe(0);
    expect(readWriteResult(database, jobId)?.result).toBe('VERIFIED');
  }, TEST_TIMEOUT_MS);

  it('rejects the start when the data cannot be generated (the unique combinations are used up), and leaves no reservation RESERVED', async () => {
    const first = issue(1);
    await runWriteJob('first', writeOf({ actionRunText: JSON.stringify(actionRunOf(first.jobId, first.grantId)) }));
    clock = new Date(dateOfCompactUtcTimestamp(MANAGER_NOW).getTime() + 10 * MINUTE_MS);
    const second = issue(2, timeAt(10 * MINUTE_MS));
    const jobs = await managerWith(fakeWorker('second', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1',
      grantId: second.grantId })).toMatchObject({ ok: false, reason: 'WRITE_DATA_NOT_GENERATED' });
    expect(readExecutionGrant(database, second.grantId)).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'RELEASED' } });
    expect(readWriteResult(database, second.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(jobs.getAuditJob(second.jobId)).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
  }, TEST_TIMEOUT_MS);

  it('uses a grant once when two starts race', async () => {
    const { grantId } = issue(1);
    const jobs = await managerWith(fakeWorker('race', writeOf({ end: 'wait', recheck: 0, submission: null })));
    const request = { profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId };
    const results = await Promise.all([jobs.startWriteCreate(request), jobs.startWriteCreate(request)]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(forks.count()).toBe(1);
    expect(readExecutionGrant(database, grantId)?.consumedAt).toBe(MANAGER_NOW);
    const started = results.find(({ ok }) => ok);
    if (started?.ok === true) {
      jobs.stopAuditJob(started.job.jobId, { force: true });
      await waitForJob(currentManager, started.job.jobId, isEndedWithoutWorker);
    }
  }, TEST_TIMEOUT_MS);
});

// DEF-101（T30g fix round 1）: ジョブの管理が、許可を確かめた後でも、ジョブの行を作る前の段（プロファイル・ターゲット設定の確かめ、終わっていない
// ジョブ）で開始を拒むときは、許可を無効にして予約を返す（予約を `RESERVED` のまま残さず、次の発行が同時実行の上限で拒まれない）。
describe('write jobs (DEF-101): a start rejected before the job row releases the grant', () => {
  /** 拒まれた後に、許可が無効になり予約が返り、次の許可を発行できる（同時実行の上限で拒まれない）。 */
  const expectReleasedAndIssuable = (grantId: string, nextSlot: number): void => {
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: null, reservation: { state: 'RELEASED' } });
    expect(readExecutionGrant(database, grantId)?.invalidatedAt).not.toBeNull();
    expect(() => issue(nextSlot, timeAt(MINUTE_MS))).not.toThrow();
  };

  it('releases the grant when the profile revision conflicts', async () => {
    const { grantId } = issue(1);
    const jobs = await managerWith(fakeWorker('revision', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(forks.count()).toBe(0);
    expectReleasedAndIssuable(grantId, 2);
  });

  it('releases the grant when the target configuration cannot be read', async () => {
    const { grantId } = issue(1);
    rmSync(join(workDirectory, TEST_TARGET_PATH));
    const jobs = await managerWith(fakeWorker('target', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE' });
    expect(forks.count()).toBe(0);
    writeTarget(TEST_TARGET_PATH);
    expectReleasedAndIssuable(grantId, 2);
  });

  it('releases the grant when another job is not finished', async () => {
    const { grantId } = issue(1);
    // 終わっていないほかのジョブ（発見のジョブ。偽のワーカーは、確かめ直しを頼まずに止められるまで待つ）。
    const jobs = await managerWith(fakeWorker('active', writeOf({ recheck: 0, submission: null, actionRunText: null, end: 'wait' })));
    const discovery = await jobs.startDiscovery({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    expect(discovery.ok).toBe(true);
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
    expect(forks.count()).toBe(1);
    expectReleasedAndIssuable(grantId, 2);
    if (discovery.ok) {
      jobs.stopAuditJob(discovery.job.jobId, { force: true });
      await waitForJob(currentManager, discovery.job.jobId, isEndedWithoutWorker);
    }
  }, TEST_TIMEOUT_MS);
});

describe('write jobs (T30e): the recheck', () => {
  it('rejects the recheck after a revocation, sends STOP, and settles the reported NOT_SENT as BLOCKED', async () => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob('revoked-recheck', writeOf(), 1, () => {
      expect(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
        receiptId: 'revoke-1', at: MANAGER_NOW }).ok).toBe(true);
    });
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    expect(ended.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'GRANT_INVALID' },
    ]);
    expect(ended.received.some((message) => message['type'] === 'STOP')).toBe(true);
    expect(readWriteResult(database, jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(reservationOf(grantId)).toBe('RELEASED');
  }, TEST_TIMEOUT_MS);

  // T30R-fix-1（DEF-103）: 撤回・シナリオの変更の後に、画面のサーバが呼ぶ止める口。そのシナリオの動いている書き込みのジョブに STOP（force でない）を
  // 送り、ほかのシナリオのジョブには送らない。
  it('stops the running write jobs of a scenario through stopWriteJobsOfScenario, and only those', async () => {
    const { jobId } = issue(1);
    const worker = fakeWorker('stop-scenario', writeOf({ recheck: 0, submission: null, end: 'wait' }));
    const jobs = await managerWith(worker);
    const started = await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId: 'grant-1' });
    expect(started.ok).toBe(true);
    await waitForJob(currentManager, jobId, (current) => current.state === 'RUNNING');
    expect(jobs.stopWriteJobsOfScenario('scenario-other')).toBe(0);
    expect(worker.received().some((message) => message['type'] === 'STOP')).toBe(false);
    expect(jobs.stopWriteJobsOfScenario('scenario-1')).toBe(1);
    const ended = await waitForJob(currentManager, jobId, isEndedWithoutWorker);
    expect(isJobEnded(ended)).toBe(true);
    expect(worker.received().filter((message) => message['type'] === 'STOP')).toEqual([
      expect.objectContaining({ type: 'STOP', force: false }),
    ]);
    expect(jobs.stopWriteJobsOfScenario('scenario-1')).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('rejects a second recheck request with RECHECK_REPEATED and STOP', async () => {
    const { jobId } = issue(1);
    const ended = await runWriteJob('double', writeOf({ recheck: 2 }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    const results = ended.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT');
    expect(results).toContainEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'RECHECK_REPEATED' });
    expect(ended.received.some((message) => message['type'] === 'STOP')).toBe(true);
    expect(readWriteResult(database, jobId)?.reservationState).not.toBeNull();
  }, TEST_TIMEOUT_MS);
});

// T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」「報告の確かめの記録」）: 書き込みのジョブを締めるときに、親が報告（2 つの JSON、HTML、
// バンドル）を照らし、結果をジョブの `writeReportCheck` に 1 回だけ記録する。報告の不一致は、書き込みの結果（予約・台帳）を変えない。
describe('write jobs (T32g): the report check at the end of the job', () => {
  const FFLATE_URL = pathToFileURL(createRequire(import.meta.url).resolve('fflate')).href;
  const HTML = '<!DOCTYPE html>\n<p>report</p>\n';

  /** `action-run.json`（`actionRunOf`）と重なる値が同じ、照合まで済んだ証拠（印はジョブの id。偽のワーカーが START の値に置き換える）。 */
  const evidenceTextOf = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    ...verifiedCreateDocuments().evidence,
    jobId: '__START_JOB_ID__',
    runId: FAKE_RUN_ID,
    profileId: GRANT_PROFILE_ID,
    scenarioId: 'scenario-1',
    scenarioRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
    recordId: '42',
    startedAt: MANAGER_NOW,
    finishedAt: MANAGER_NOW,
    ...overrides,
  });

  /** 報告をすべて書く偽のワーカーの指定（`report` の項目を上書きできる）。 */
  type FakeReport = NonNullable<NonNullable<FakeWorkerValues['write']>['report']>;
  const reportOf = (overrides: Partial<FakeReport> = {}): FakeReport => ({
    approvalSummarySchemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    actionEvidenceText: evidenceTextOf(),
    reportHtml: HTML,
    bundle: { name: actionBundleFileName(MANAGER_NOW), fflateUrl: FFLATE_URL },
    ...overrides,
  });

  it.each<readonly [string, Partial<NonNullable<NonNullable<FakeWorkerValues['write']>['report']>>, Record<string, unknown> | null, string]>([
    ['a report that agrees with the action-run.json, the START and the bundle', {}, null, 'VALID'],
    ['no HTML report and no bundle', { reportHtml: null, bundle: null }, null, 'REPORT_MISSING'],
    ['an evidence that does not match its schema', {}, { cookies: [] }, 'REPORT_INVALID'],
    ['an evidence of another run', {}, { runId: 'RUN-20261012000999' }, 'REPORT_MISMATCH'],
    ['an evidence with another result', {}, { result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' }, 'REPORT_MISMATCH'],
    ['an approval summary that differs from the START', { approvalFactsOverride: { revokedAtStart: true } }, null, 'APPROVAL_FACTS_MISMATCH'],
    ['a bundle whose manifest has another SHA-256', { bundle: { name: actionBundleFileName(MANAGER_NOW), fflateUrl: FFLATE_URL, tamper: 'manifest' } },
      null, 'BUNDLE_MISMATCH'],
    ['a bundle whose file on the disk was changed afterwards', { bundle: { name: actionBundleFileName(MANAGER_NOW), fflateUrl: FFLATE_URL, tamper: 'disk' } },
      null, 'BUNDLE_MISMATCH'],
  ])('records the report check of %s once, without changing the settled write result', async (name, report, evidence, check) => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob(name.split(' ').join('-'), writeOf({
      actionRunText: JSON.stringify(actionRunOf(jobId, grantId)),
      report: reportOf({ ...(evidence === null ? {} : { actionEvidenceText: evidenceTextOf(evidence) }), ...report }),
    }));
    expect(ended).toMatchObject({ state: 'FINISHED', failureReason: null, writeReportCheck: check });
    expect(readWriteResult(database, jobId)).toMatchObject({ result: 'VERIFIED', reservationState: 'COMMITTED' });
    expect(reservationOf(grantId)).toBe('COMMITTED');
  }, TEST_TIMEOUT_MS);

  it('records RESULT_INVALID when the action-run.json cannot be used (the job is WRITE_RESULT_INVALID)', async () => {
    const { jobId } = issue(1);
    const ended = await runWriteJob('report-result-invalid', writeOf({ actionRunText: '{"schemaVersion":', report: reportOf() }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID', writeReportCheck: 'RESULT_INVALID' });
    expect(readWriteResult(database, jobId)).toMatchObject({ result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);

  it('records no report check for a worker that ended before the result', async () => {
    issue(1);
    const ended = await runWriteJob('report-crash', writeOf({ end: 'crash', report: reportOf() }));
    expect(ended).toMatchObject({ state: 'INTERRUPTED', writeReportCheck: null });
  }, TEST_TIMEOUT_MS);
});

// T32R M-5・T32R2 M-2: 親の確かめは、ディスクの 4 つのファイルから書き込みのバンドルを同じ手順で組み立て直し、ディスクの ZIP とバイト列で照らす。
// 同じ名前の項目が 2 つある ZIP、ローカルのヘッダの名前だけを変えた ZIP、目録の名前を変えた ZIP、前後にごみを足した ZIP は、どれも `BUNDLE_MISMATCH`。
// 報告の見本（`verifiedCreateDocuments`）と本物のバンドルの組み立てで、`checkWriteReport` を直接呼ぶ（ディスクのファイルはメモリの値）。
describe('write jobs (T32R M-5, T32R2 M-2): the report check of a reshaped bundle', () => {
  const encoder = new TextEncoder();
  const documents = verifiedCreateDocuments();
  const { schemaVersion: _schemaVersion, jobId: _jobId, runId: _runId, ...approvalFacts } = documents.approvalSummary;
  const HTML = '<!DOCTYPE html>\n<p>report</p>\n';
  const texts = {
    actionRunJson: JSON.stringify(documents.actionRun),
    actionEvidenceJson: JSON.stringify(documents.evidence),
    approvalSummaryJson: JSON.stringify(documents.approvalSummary),
    reportHtml: HTML,
  };
  const diskFiles = new Map<string, Uint8Array>([
    [ACTION_RUN_ARTIFACT_FILE_NAME, encoder.encode(texts.actionRunJson)],
    [ACTION_EVIDENCE_ARTIFACT_FILE_NAME, encoder.encode(texts.actionEvidenceJson)],
    [APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, encoder.encode(texts.approvalSummaryJson)],
    [ACTION_REPORT_ARTIFACT_FILE_NAME, encoder.encode(texts.reportHtml)],
  ]);
  const bundleName = actionBundleFileName(documents.actionRun.finishedAt);
  const bundle = createActionBundle({
    jobId: documents.evidence.jobId, runId: documents.evidence.runId, containsHumanEnteredValues: documents.evidence.containsHumanEnteredValues, ...texts,
  });
  /** 1 つの項目の名前が ZIP に現れる回数（ローカルのヘッダと中央ディレクトリ）。 */
  const NAME_OCCURRENCES_PER_ENTRY = 2;
  /** 前後に足すごみのバイト数と値。 */
  const JUNK_LENGTH = 64;
  const JUNK_BYTE = 0x41;

  /** 報告を照らす（`files` はディスクのファイル。省略すると見本のまま）。 */
  const checkOf = (bundleBytes: Uint8Array, files: ReadonlyMap<string, Uint8Array> = diskFiles) => checkWriteReport({
    actionRun: documents.actionRun,
    approvalFacts,
    readFile: (fileName) => Promise.resolve(fileName === bundleName ? bundleBytes : files.get(fileName) ?? null),
  });

  /** 展開せずに、中央ディレクトリの項目の名前を順に返す。 */
  const entryNamesOf = (zip: Uint8Array): string[] => {
    const names: string[] = [];
    unzipSync(zip, { filter: ({ name }) => { names.push(name); return false; } });
    return names;
  };

  /**
   * ZIP のバイト列の中の `from`（項目の名前）を、同じ長さの `to` に書き換えた写し。`from` はちょうど 2 回（ローカルのヘッダ、中央ディレクトリの順）
   * 現れることを確かめ、`which` の回（0 から数える）だけを書き換える。
   */
  const renamedIn = (zip: Uint8Array, from: string, to: string, which: readonly number[]): Uint8Array => {
    const source = encoder.encode(from);
    const target = encoder.encode(to);
    expect(target.length).toBe(source.length);
    const renamed = zip.slice();
    let seen = 0;
    for (let index = 0; index + source.length <= renamed.length; index += 1) {
      if (source.every((byte, offset) => renamed[index + offset] === byte)) {
        if (which.includes(seen)) {
          renamed.set(target, index);
        }
        seen += 1;
      }
    }
    expect(seen).toBe(NAME_OCCURRENCES_PER_ENTRY);
    return renamed;
  };

  /** 同じ長さの別の名前（拡張子は保つ）。 */
  const otherNameOf = (name: string): string => {
    const extension = name.slice(name.lastIndexOf('.'));
    return `${'z'.repeat(name.length - extension.length)}${extension}`;
  };

  /** バンドルに、HTML の報告と同じ中身・同じ名前の項目をもう 1 つ足した ZIP（別の名前で足してから、名前のバイト列を書き換える）。 */
  const bundleWithDuplicatedReport = (): Uint8Array => {
    const entries = unzipSync(bundle);
    const html = entries[ACTION_REPORT_ARTIFACT_FILE_NAME];
    expect(html).toBeDefined();
    const placeholder = otherNameOf(ACTION_REPORT_ARTIFACT_FILE_NAME);
    const zipped = zipSync({ ...entries, [placeholder]: html ?? new Uint8Array() }, { level: 0 });
    return renamedIn(zipped, placeholder, ACTION_REPORT_ARTIFACT_FILE_NAME, [0, 1]);
  };

  /** 前（`leading`）か後ろにごみを足した ZIP。 */
  const withJunk = (zip: Uint8Array, leading: boolean): Uint8Array => {
    const padded = new Uint8Array(zip.length + JUNK_LENGTH).fill(JUNK_BYTE);
    padded.set(zip, leading ? JUNK_LENGTH : 0);
    return padded;
  };

  it('accepts the bundle as built (the baseline of this check)', async () => {
    expect(new Set(entryNamesOf(bundle)).size).toBe(entryNamesOf(bundle).length);
    expect(await checkOf(bundle)).toBe('VALID');
  });

  it('records BUNDLE_MISMATCH for a bundle with two entries of the same name, even when their contents agree with the manifest', async () => {
    const duplicated = bundleWithDuplicatedReport();
    expect(entryNamesOf(duplicated).filter((name) => name === ACTION_REPORT_ARTIFACT_FILE_NAME)).toHaveLength(NAME_OCCURRENCES_PER_ENTRY);
    expect(await checkOf(duplicated)).toBe('BUNDLE_MISMATCH');
  });

  it('records BUNDLE_MISMATCH for a bundle whose local header has another name than its central directory (T32R2 M-2)', async () => {
    const reshaped = renamedIn(bundle, ACTION_REPORT_ARTIFACT_FILE_NAME, otherNameOf(ACTION_REPORT_ARTIFACT_FILE_NAME), [0]);
    expect(entryNamesOf(reshaped)).toEqual(entryNamesOf(bundle));
    expect(await checkOf(reshaped)).toBe('BUNDLE_MISMATCH');
  });

  it('records BUNDLE_MISMATCH for a bundle whose manifest has another name (T32R2 M-2)', async () => {
    const [manifestName] = entryNamesOf(bundle);
    expect(manifestName).toBeDefined();
    const reshaped = renamedIn(bundle, manifestName ?? '', otherNameOf(manifestName ?? ''), [0, 1]);
    expect(entryNamesOf(reshaped)).not.toContain(manifestName);
    expect(await checkOf(reshaped)).toBe('BUNDLE_MISMATCH');
  });

  it.each([['after', false], ['before', true]] as const)('records BUNDLE_MISMATCH for a bundle with junk %s it (T32R2 M-2)', async (_label, leading) => {
    expect(await checkOf(withJunk(bundle, leading))).toBe('BUNDLE_MISMATCH');
  });

  // T32R3 Minor-1: 組み立て直しに使う `action-run.json`（2 回目の読み取り）は、締めに使った文書（1 回目に読んで確かめたもの）と同じ内容でなければ
  // ならない（バンドルをディスクのファイルにそろえて組み立て直しても通さない）。JSON でなければ形の違い（`REPORT_INVALID`）、内容が違えば
  // `REPORT_MISMATCH`。
  it.each<readonly [string, string, string]>([
    ['another result than the settled document', JSON.stringify({ ...documents.actionRun, result: 'UNKNOWN', reason: 'RESPONSE_UNKNOWN', recordId: null }),
      'REPORT_MISMATCH'],
    ['no JSON', 'not json at all', 'REPORT_INVALID'],
  ])('records the check of an action-run.json on the disk with %s, even with a bundle built from it (T32R3 Minor-1)', async (_label, runText, check) => {
    const rewritten = { ...texts, actionRunJson: runText };
    const files = new Map(diskFiles).set(ACTION_RUN_ARTIFACT_FILE_NAME, encoder.encode(runText));
    const rebuilt = createActionBundle({
      jobId: documents.evidence.jobId, runId: documents.evidence.runId, containsHumanEnteredValues: documents.evidence.containsHumanEnteredValues,
      ...rewritten,
    });
    expect(await checkOf(rebuilt, files)).toBe(check);
  });

  it('accepts an action-run.json on the disk with the same content as the settled document in another format (T32R3 Minor-1)', async () => {
    const runText = `${JSON.stringify(documents.actionRun, null, 2)}\n`;
    const files = new Map(diskFiles).set(ACTION_RUN_ARTIFACT_FILE_NAME, encoder.encode(runText));
    const rebuilt = createActionBundle({
      jobId: documents.evidence.jobId, runId: documents.evidence.runId, containsHumanEnteredValues: documents.evidence.containsHumanEnteredValues,
      ...texts, actionRunJson: runText,
    });
    expect(await checkOf(rebuilt, files)).toBe('VALID');
  });
});

describe('write jobs (T30e): the settlement at the end of the job', () => {
  it.each<readonly [string, Partial<NonNullable<FakeWorkerValues['write']>>, Record<string, unknown>, Record<string, unknown>]>([
    ['a crash after a SENT report', { submission: { submission: 'SENT', blockReason: null }, end: 'crash' },
      { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' }],
    ['a crash after a NOT_SENT report', { submission: { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' }, end: 'crash' },
      { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED' },
      { state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' }],
    ['a crash without a report', { submission: null, end: 'crash' },
      { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' }],
    ['a broken action-run.json after a SENT report', { actionRunText: '{"schemaVersion":' },
      { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['a missing action-run.json after a NOT_SENT report', { submission: { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' } },
      { submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
  ])('settles %s', async (name, write, settled, job) => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob(name.split(' ').join('-'), writeOf(write));
    expect(ended).toMatchObject(job);
    expect(readWriteResult(database, jobId)).toMatchObject(settled);
    expect(reservationOf(grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it('does not trust an action-run.json with another seed record (T30f; settles from the reports)', async () => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob('other-seed', writeOf({ actionRunText: JSON.stringify(actionRunOf(jobId, grantId, { seedRecord: fixedSeedRecordOf(grantId) })) }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);

  it('does not trust an action-run.json of another job (settles from the reports)', async () => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob('other-job', writeOf({ actionRunText: JSON.stringify(actionRunOf('job-other', grantId)) }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);

  it('closes a consumed write without a job through the job manager after a server restart (UNKNOWN), once', async () => {
    const { grantId, jobId } = issue(1);
    expect(consumeExecutionGrant(database, { grantId, scenarioId: 'scenario-1', scenarioRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
      jobId, profileId: GRANT_PROFILE_ID, external: facts, at: MANAGER_NOW }).ok).toBe(true);
    expect(recordWriteAttempt(database, {
      jobId, grantId, seedRecord: fixedSeedRecordOf(grantId), submittedValues: { name: '試験一郎' }, uniqueKey: null, phoneNumbers: [],
      at: MANAGER_NOW,
    }).ok).toBe(true);
    const jobs = await managerWith(fakeWorker('restart', writeOf()));
    jobs.recoverInterruptedJobs();
    expect(readWriteResult(database, jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' });
    expect(jobs.recoverInterruptedJobs()).toBe(0);
    expect(reservationOf(grantId)).toBe('UNKNOWN');
  }, TEST_TIMEOUT_MS);
});

// ===============================================================================================================
// T31f: 更新の書き込みのジョブ（`WRITE_UPDATE`）
// ===============================================================================================================

/** UPDATE のシナリオ（台帳は `scenario-1`）と、その対象のレコード（`scenario-1` の照合まで済んだ登録）の ID。 */
const UPDATE_SCENARIO_ID = 'scenario-u';
const UPDATE_TARGET = '42';
/** 対象の登録の時刻と、直接に記録する前の UPDATE の時刻（承認の後、ジョブの許可の発行の前。同じシナリオの間隔を守る）。 */
const REGISTERED_AT = '20261012021000';
const EARLIER_UPDATE_AT = '20261012022000';
/** 対象の登録で送った値と、UPDATE の規則の固定の値（変える欄 `name`。一意にする欄の組も `name`）。 */
const REGISTERED_NAME = '試験零郎';
const UPDATED_NAME = '試験二郎';
const UPDATE_CONTENT: RuleSetContent = {
  fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [UPDATED_NAME] }],
  relations: [],
  uniqueKeyFieldNames: ['name'],
};
/** 偽のワーカーが、`START` の対象の ID に置き換える印。 */
const START_TARGET_MARK = '__START_TARGET_RECORD_ID__';

/** `scenario-1` の照合まで済んだ登録を、管理データに直接作る（UPDATE の対象にできるレコード）。 */
const registerTarget = (recordId = UPDATE_TARGET, at = REGISTERED_AT): void => {
  const grantId = `grant-r${recordId}`;
  const jobId = `job-r${recordId}`;
  const issued = issueExecutionGrant(database, {
    scenarioId: 'scenario-1', expectedRevision: readScenario(database, 'scenario-1')?.revision ?? 0, grantId, jobId, count: 1, external: facts, at,
  });
  expect(issued.ok).toBe(true);
  expect(consumeExecutionGrant(database, { grantId, scenarioId: 'scenario-1', scenarioRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
    jobId, profileId: GRANT_PROFILE_ID, external: facts, at }).ok).toBe(true);
  expect(recordWriteAttempt(database, {
    jobId, grantId, seedRecord: fixedSeedRecordOf(grantId), submittedValues: { name: REGISTERED_NAME }, uniqueKey: null, phoneNumbers: [], at,
  }).ok).toBe(true);
  expect(settleWriteResult(database, {
    jobId, submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId, readVerification: 'MATCHED',
    submittedAt: at, at,
  }).ok).toBe(true);
};

/** UPDATE のシナリオを作り、規則の参照を付け、本物の事実で承認する（台帳は `scenario-1`）。 */
const prepareUpdateApproved = (): void => {
  const scenario = prepareUpdateScenario(database, discoveryDocumentOf(DISCOVERY_JOB_ID, [CREATE_CANDIDATE, UPDATE_CANDIDATE]), UPDATE_SCENARIO_ID,
    'scenario-1', { approve: false, ruleContent: UPDATE_CONTENT });
  const status = readScenarioApprovalStatus(database, UPDATE_SCENARIO_ID, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  expect(approveScenario(database, {
    scenarioId: UPDATE_SCENARIO_ID, expectedRevision: scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId: 'receipt-u',
    external: facts, at: APPROVED_AT,
  }).ok).toBe(true);
};

/** UPDATE の許可を発行する（ジョブの id は `job-u<slot>`、許可の id は `grant-u<slot>`。画面が見せた予定の対象は `UPDATE_TARGET`）。 */
const issueUpdate = (slot: number, at = ISSUE_AT): { readonly grantId: string; readonly jobId: string } => {
  const issued = issueExecutionGrant(database, {
    scenarioId: UPDATE_SCENARIO_ID, expectedRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0, grantId: `grant-u${slot}`,
    jobId: `job-u${slot}`, count: 1, expectedTargetRecordId: UPDATE_TARGET, external: facts, at,
  });
  if (!issued.ok) {
    throw new Error(`not issued: ${issued.reason}`);
  }
  expect(issued.grant.targetRecordId).toBe(UPDATE_TARGET);
  return { grantId: issued.grant.grantId, jobId: issued.grant.jobId };
};

/** 前の UPDATE（送った値 `name`）を、管理データに直接記録して締める。 */
const recordEarlierUpdate = (name: string): void => {
  const grantId = 'grant-u9';
  const jobId = 'job-u9';
  issueUpdate(9, EARLIER_UPDATE_AT);
  expect(consumeExecutionGrant(database, { grantId, scenarioId: UPDATE_SCENARIO_ID,
    scenarioRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0, jobId, profileId: GRANT_PROFILE_ID, external: facts,
    at: EARLIER_UPDATE_AT }).ok).toBe(true);
  expect(recordWriteAttempt(database, {
    jobId, grantId, seedRecord: fixedSeedRecordOf(grantId), submittedValues: { name }, uniqueKey: null, phoneNumbers: [], at: EARLIER_UPDATE_AT,
  }).ok).toBe(true);
  expect(settleWriteResult(database, {
    jobId, submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: UPDATE_TARGET, readVerification: 'MATCHED',
    submittedAt: EARLIER_UPDATE_AT, updateEvidence: { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: REGISTERED_NAME, newValue: name,
      matched: true }] }, at: EARLIER_UPDATE_AT,
  }).ok).toBe(true);
};

/** UPDATE の証拠（変える欄 `name` 1 つ。既定は一致）。 */
const updateEvidenceOf = (matched: boolean | null = true, newValue = UPDATED_NAME): WriteUpdateEvidence => ({
  fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: REGISTERED_NAME, newValue, matched }],
});

/** 照合まで済んだ UPDATE の `action-run.json`（対象の ID は、偽のワーカーが START の値に置き換える印）。 */
const updateActionRunOf = (
  jobId: string,
  grantId: string,
  overrides: Partial<ActionRunDocument> = {},
): ActionRunDocument => actionRunOf(jobId, grantId, {
  scenarioId: UPDATE_SCENARIO_ID,
  scenarioRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0,
  submittedValues: { name: UPDATED_NAME },
  recordId: UPDATE_TARGET,
  update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf() },
  ...overrides,
});

/** UPDATE の書き込みのジョブを 1 回、偽のワーカーで行う。 */
async function runUpdateJob(
  name: string,
  write: NonNullable<FakeWorkerValues['write']>,
  slot = 1,
): Promise<AuditJobView & { readonly received: readonly Record<string, unknown>[] }> {
  const worker = fakeWorker(name, write);
  const jobs = await managerWith(worker);
  const started = await jobs.startWriteUpdate({
    profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: UPDATE_SCENARIO_ID, grantId: `grant-u${slot}`,
  });
  if (!started.ok) {
    throw new Error(`the update job did not start: ${started.reason}`);
  }
  expect(started.job).toMatchObject({ jobId: `job-u${slot}`, jobKind: 'WRITE_UPDATE', state: 'STARTING' });
  const ended = await waitForJob(currentManager, started.job.jobId, isEndedWithoutWorker);
  return { ...ended, received: worker.received() };
}

describe('update write jobs (T31f): the start', () => {
  beforeEach(() => {
    registerTarget();
    prepareUpdateApproved();
  });

  it('copies the target of the grant into START with the concrete paths, without a kept or prior value, and settles VERIFIED', async () => {
    const { grantId, jobId } = issueUpdate(1);
    const ended = await runUpdateJob('update-verified', writeOf({ actionRunText: JSON.stringify(updateActionRunOf(jobId, grantId)), report: WRITE_REPORT }));
    // T32e（T32d の申し送り）: UPDATE の承認の要約の事実（種類、許可、件数、UPDATE だけの項目）。
    await expectApprovalSummaryOfParent({ jobId, grantId, kind: 'UPDATE', scenarioId: UPDATE_SCENARIO_ID, start: ended.received });
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', failureReason: null, endKind: 'RAN' });
    const start = ended.received.find((message) => message['type'] === 'START') as Record<string, unknown> | undefined;
    expect(start).toMatchObject({
      jobId,
      jobKind: 'WRITE_UPDATE',
      write: {
        scenarioId: UPDATE_SCENARIO_ID,
        grantId,
        // 画面の path と送信先の path は、シナリオの型（`/members/{id}/edit`・`/members/{id}`）に許可の対象の ID を入れた具体的な path。
        request: { formMethod: 'POST', methodOverride: 'PATCH', origin: UPDATE_CANDIDATE.page.origin, path: `/members/${UPDATE_TARGET}` },
        formPage: { origin: UPDATE_CANDIDATE.page.origin, path: `/members/${UPDATE_TARGET}/edit` },
        candidate: { identityDigest: UPDATE_CANDIDATE.identityDigest },
        values: { name: UPDATED_NAME },
        readVerification: { definition: { parameters: { q: UPDATED_NAME } } },
        update: { targetRecordId: UPDATE_TARGET, templatedIdentityDigest: UPDATE_TEMPLATED_IDENTITY_DIGEST, changedFieldNames: ['name'],
          keptFieldNames: [] },
      },
    });
    const write = start?.['write'] as Record<string, unknown>;
    expect(Object.keys(write['update'] as object).sort()).toEqual(['changedFieldNames', 'keptFieldNames', 'targetRecordId', 'templatedIdentityDigest']);
    expect(Object.keys(write['values'] as object)).toEqual(['name']);
    // 前の値（登録で送った値）は送らない（ワーカーが読む）。path の型も送らない（ワーカーは型を扱わない。登録の ID の取り方の型は検証の指定）。
    expect(JSON.stringify(start)).not.toContain(REGISTERED_NAME);
    expect(JSON.stringify([write['request'], write['formPage'], write['update']])).not.toContain('{id}');
    expect(readWriteResult(database, jobId)).toMatchObject({
      writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, submittedValues: { name: UPDATED_NAME }, submission: 'SENT', recordId: UPDATE_TARGET,
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', updateEvidence: updateEvidenceOf(),
    });
    // 消費済みの許可では、もう始めない（ワーカーを起動しない。締めた予約は変わらない）。
    const jobs = await managerWith(fakeWorker('update-again', writeOf()));
    expect(await jobs.startWriteUpdate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: UPDATE_SCENARIO_ID,
      grantId })).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(forks.count()).toBe(1);
    expect(reservationOf(grantId)).toBe('COMMITTED');
  }, TEST_TIMEOUT_MS);

  it('rejects a CREATE grant for an update and an UPDATE grant for a create, and releases each of them', async () => {
    const jobs = await managerWith(fakeWorker('kinds', writeOf()));
    const create = issue(1);
    expect(await jobs.startWriteUpdate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1',
      grantId: create.grantId })).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(readExecutionGrant(database, create.grantId)).toMatchObject({ consumedAt: null, reservation: { state: 'RELEASED' } });
    const update = issueUpdate(1, timeAt(MINUTE_MS));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: UPDATE_SCENARIO_ID,
      grantId: update.grantId })).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(readExecutionGrant(database, update.grantId)).toMatchObject({ consumedAt: null, reservation: { state: 'RELEASED' } });
    expect(forks.count()).toBe(0);
    expect(jobs.getAuditJob(create.jobId)).toBeNull();
    expect(jobs.getAuditJob(update.jobId)).toBeNull();
  });

  it('rejects a grant of another scenario (that grant is not changed) and a request of a bad shape, without a worker', async () => {
    const jobs = await managerWith(fakeWorker('other-scenario', writeOf()));
    const { grantId } = issueUpdate(1);
    const request = { profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId };
    expect(await jobs.startWriteUpdate(request)).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await jobs.startWriteUpdate({ ...request, scenarioId: UPDATE_SCENARIO_ID, grantId: 'Grant 1' } as never))
      .toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(await jobs.startWriteUpdate({ ...request, scenarioId: UPDATE_SCENARIO_ID, grantId: 'grant-missing' }))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(forks.count()).toBe(0);
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: null, invalidatedAt: null, reservation: { state: 'RESERVED' } });
  });

  it('releases the update grant when the start is rejected before the job row (the profile revision conflicts)', async () => {
    const { grantId } = issueUpdate(1);
    const jobs = await managerWith(fakeWorker('update-revision', writeOf()));
    expect(await jobs.startWriteUpdate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1, scenarioId: UPDATE_SCENARIO_ID,
      grantId })).toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: null, reservation: { state: 'RELEASED' } });
    expect(forks.count()).toBe(0);
  });

  it('rejects an update start whose value was already sent by an update of the same ledger (WRITE_DATA_NOT_GENERATED), releasing the grant', async () => {
    recordEarlierUpdate(UPDATED_NAME);
    const { grantId, jobId } = issueUpdate(1);
    const jobs = await managerWith(fakeWorker('update-used', writeOf()));
    expect(await jobs.startWriteUpdate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: UPDATE_SCENARIO_ID,
      grantId })).toMatchObject({ ok: false, reason: 'WRITE_DATA_NOT_GENERATED' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'RELEASED' } });
    expect(jobs.getAuditJob(jobId)).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    expect(forks.count()).toBe(0);
  });

  it('gives the values sent by an update to the generation of a create start (the unique combinations of the ledger)', async () => {
    // 前の UPDATE が、CREATE の規則の唯一の値（`試験一郎`）をレコードに送った。CREATE の生成は、その値を使った値として扱う。
    recordEarlierUpdate('試験一郎');
    const { grantId, jobId } = issue(1);
    const jobs = await managerWith(fakeWorker('create-after-update', writeOf()));
    expect(await jobs.startWriteCreate({ profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId: 'scenario-1', grantId }))
      .toMatchObject({ ok: false, reason: 'WRITE_DATA_NOT_GENERATED' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ reservation: { state: 'RELEASED' } });
    expect(jobs.getAuditJob(jobId)).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED' });
    expect(forks.count()).toBe(0);
  });
});

describe('update write jobs (T31f): the settlement at the end of the job', () => {
  beforeEach(() => {
    registerTarget();
    prepareUpdateApproved();
  });

  it.each<readonly [string, Partial<ActionRunDocument>, Record<string, unknown>]>([
    ['every field matched', {}, { result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED' }],
    ['another record id after the success', { recordId: '43' }, { result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH', reservationState: 'COMMITTED' }],
    ['a field that changed unexpectedly', { update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf(false) } },
      { result: 'UNKNOWN', reason: 'UNEXPECTED_FIELD_CHANGE', reservationState: 'COMMITTED' }],
    ['a field that could not be checked', { update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf(null) } },
      { result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED', reservationState: 'COMMITTED' }],
    ['no evidence of the check after the update', { update: { targetRecordId: START_TARGET_MARK, updateEvidence: null } },
      { result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED', reservationState: 'COMMITTED', updateEvidence: null }],
  ])('settles an update action-run.json with %s', async (name, overrides, settled) => {
    const { grantId, jobId } = issueUpdate(1);
    const ended = await runUpdateJob(name.split(' ').join('-'), writeOf({ actionRunText: JSON.stringify(updateActionRunOf(jobId, grantId, overrides)) }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', failureReason: null });
    expect(readWriteResult(database, jobId)).toMatchObject({ writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, submission: 'SENT', ...settled });
    expect(reservationOf(grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, (jobId: string, grantId: string) => string | null, Partial<NonNullable<FakeWorkerValues['write']>>,
    Record<string, unknown>, Record<string, unknown>]>([
    ['an action-run.json without the update block', (jobId, grantId) => JSON.stringify(actionRunOf(jobId, grantId, {
      scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0, submittedValues: { name: UPDATED_NAME },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['an action-run.json of another target', (jobId, grantId) => JSON.stringify(updateActionRunOf(jobId, grantId, {
      update: { targetRecordId: '43', updateEvidence: updateEvidenceOf() },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['an action-run.json whose evidence does not match the sent values', (jobId, grantId) => JSON.stringify(updateActionRunOf(jobId, grantId, {
      update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf(true, '試験三郎') },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN', updateEvidence: null },
    { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['a crash after a SENT report', () => null, { end: 'crash' }, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' },
      { state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' }],
    ['a NOT_SENT report without action-run.json', () => null, { submission: { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' } },
      { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED' },
      { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
  ])('settles an update job with %s from the reports', async (name, textOf, write, settled, job) => {
    const { grantId, jobId } = issueUpdate(1);
    const ended = await runUpdateJob(name.split(' ').join('-'), writeOf({ actionRunText: textOf(jobId, grantId), ...write }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', ...job });
    expect(readWriteResult(database, jobId)).toMatchObject({ writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, ...settled });
    expect(reservationOf(grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it('does not trust a create action-run.json with an update block (settles from the reports)', async () => {
    const { grantId, jobId } = issue(1);
    const ended = await runWriteJob('create-with-update', writeOf({ actionRunText: JSON.stringify(actionRunOf(jobId, grantId, {
      update: { targetRecordId: UPDATE_TARGET, updateEvidence: null },
    })) }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, jobId)).toMatchObject({ writeKind: 'CREATE', submission: 'UNKNOWN', result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);
});
