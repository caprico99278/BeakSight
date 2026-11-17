// T30e（Task 30 の設計書 3 章の「送る直前の確かめ直し」「予約の締め」「`UNKNOWN` の後」、4 章の「IPC」）: 点検の書き込みの段（`WRITE_CREATE`）の、ジョブの
// 管理（許可の発行と消費・値の生成・送る前の記録（`#prepareWrite`）、IPC の確かめ直しの往復と送信の報告、段の終わりの締め）を、偽のワーカー
// （`tests/helpers/fake-audit-worker.ts` の `chain` の書き込みの段）を本物の `fork` で起動して確かめる（ワーカーの書き込みの流れは T30f）。SLIM W-1: 単独で
// 書き込みを始める口を外したので、どの場面も点検（`tests/helpers/chain-write-support.ts`）を通す。
// - 準備の順: 許可の発行 → 同時に 1 つの枠（段のジョブの行）→ 許可の消費 → 生成（生成の履歴を渡す）→ 送る前の記録 → `NEXT_STAGE`。準備で止まれば、
//   その段の行を `FAILED` にし、予約を `RESERVED` のまま残さず、何も送らない。
// - IPC: `NEXT_STAGE` の書き込みの指定（生成した値と、生成した値を結び付けた照合の READ）。確かめ直しの依頼は 1 回（2 回目は拒んで `STOP`）、撤回の後は
//   拒んで `STOP`。送信の報告は 1 回。
// - 締め: 段の終わりで必ず 1 回。`action-run.json` が読めて合えば、その中身から（判定は締めの部品が決め直す）。読めない・異常終了・応答なしは、
//   `NOT_SENT` の報告があれば `BLOCKED`・`RELEASED`、ほかは `UNKNOWN`。二重に締めない。画面のサーバの再起動の後の回復も、ジョブの管理から。
// - OP-F（安全のレビューの M-1）: 親が書き込みの段を準備している間の「やめる」は、書き込みの段を始めない。送らずに止めた回の値は使った扱いにしない。値の
//   候補が尽きた画面は、試せなかった理由で終える（SLIM W-2 で、本物のワーカーの fork のテストから移した）。
// T31f（Task 31 の設計書 3 章、4 章の「IPC」）: 更新の書き込みの段（`WRITE_UPDATE`）も、同じ偽のワーカーで確かめる（同じ点検の登録の後）。
// - 指定: 許可の対象の ID（同じ点検で照合まで済んだ登録の番号）を写し、画面の path と送信先の path は型に対象の ID を入れた具体的な path。保つ欄の値と前の値は
//   送らない。生成の履歴は、同じ台帳の CREATE と UPDATE の送った値を含む（CREATE でも）。
// - 締め: UPDATE の `action-run.json`（`update` の対象の ID と証拠、取れた ID）から。対象の ID の違う・`update` のない成果物は使わない。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。値は匿名の合成のテストデータだけ。
import { unzipSync, zipSync } from 'fflate';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTION_RUN_SCHEMA_VERSION,
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  type ActionRunDocument,
  type ApprovalSummaryDocument,
  type WriteUpdateEvidence,
} from '../../src/control/actions/action-contracts.js';
import { readWriteResult, readWriteResults } from '../../src/control/actions/write-result-facts.js';
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
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { RuleSetContent } from '../../src/control/data-rules/rule-contracts.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { checkWriteReport } from '../../src/control/job/write-report-check.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION } from '../../src/control/worker-protocol.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
} from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { createActionBundle } from '../../src/report/action-bundle.js';
import { sampleApiSummary, verifiedCreateDocuments } from '../helpers/action-report-samples.js';
import { chainWriteWorkerValues, runWriteChain, writeStagesOf, type WriteChainResult } from '../helpers/chain-write-support.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { awaitWorkersExit, createFakeWorkerJobManager, withOutputDirectory } from '../helpers/job-test-support.js';
import { CREATE_CANDIDATE, UPDATE_CANDIDATE, UPDATE_TEMPLATED_IDENTITY_DIGEST } from '../unit/approval-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext } from './control-profile-fixtures.js';
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
/** 偽のワーカーが書き込みの指定を受けたかを確かめる間隔（ms）。 */
const GATE_POLL_MS = 20;
/** 登録の段と更新の段の Run の ID。 */
const FAKE_RUN_ID = 'RUN-20261012000000';
const UPDATE_RUN_ID = 'RUN-20261012000100';
const OUTPUT_DIRECTORY = 'write-jobs-output';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-write' } });
/** 偽のワーカーが、段のジョブの id と許可の id に置き換える印。 */
const START_JOB_MARK = '__START_JOB_ID__';
const START_GRANT_MARK = '__START_GRANT_ID__';
/** 許可の発行の時刻と、ジョブの管理の時計（許可の期限の中）。 */
const ISSUE_AT = '20261012030000';
const MANAGER_NOW = '20261012030100';
const MINUTE_MS = 60_000;

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
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

/** T37d: テストだけの書き込みで、管理の接続の書き込みを待つ上限（ms）。 */
const RAW_BUSY_TIMEOUT_MS = 5_000;

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
let facts: ApprovalExternalFacts;
let clock = dateOfCompactUtcTimestamp(MANAGER_NOW);
/** OP-F（M-1）: ジョブの管理が時計を読むたびに呼ぶ受け手（読む前に、呼び出しの stack の文を渡す。null で外す）。押す時を時間に頼らずに作るテストの口。 */
let clockReadHook: ((stack: string) => void) | null = null;
const forks = createCountingFork();

const timeAt = (offsetMs: number): string => formatCompactUtcTimestamp(new Date(dateOfCompactUtcTimestamp(ISSUE_AT).getTime() + offsetMs), 'test time');

/** 点検の発見の段の成果物の候補（既定は登録だけ。更新の場面は登録と更新）。 */
const CREATE_ONLY = [CREATE_CANDIDATE];
const CREATE_AND_UPDATE = [CREATE_CANDIDATE, UPDATE_CANDIDATE];

const fakeWorker = (name: string, write: NonNullable<FakeWorkerValues['write']>, candidates = CREATE_ONLY): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, 'chain', chainWriteWorkerValues({
    outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
    discovery: discoveryDocumentOf(DISCOVERY_JOB_ID, candidates),
    writeRunId: FAKE_RUN_ID,
    write,
  }));
};

async function managerWith(worker: FakeWorker): Promise<AuditJobManager> {
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker: forks.fork,
    now: () => {
      clockReadHook?.(new Error('clock read').stack ?? '');
      return clock;
    },
  });
  return manager;
}

/** 許可を発行する（ジョブの id は `job-w<slot>`、許可の id は `grant-<slot>`。点検を通さない回復の場面だけ）。 */
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
 * 照合まで済んだ `action-run.json`（`VERIFIED`）。T30f: seed の記録・段のジョブの id・許可の id は、偽のワーカーが書き込みの指定の値に置き換える印（本物の
 * ワーカーと同じく、受けた値を書く）。
 */
const actionRunOf = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({
  schemaVersion: ACTION_RUN_SCHEMA_VERSION,
  jobId: START_JOB_MARK,
  runId: FAKE_RUN_ID,
  profileId: GRANT_PROFILE_ID,
  scenarioId: 'scenario-1',
  scenarioRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
  grantId: START_GRANT_MARK,
  seedRecord: '__START_SEED_RECORD__' as never,
  submittedValues: { name: '試験一郎' },
  // PL-6a: 版 1.2 の記録は、成否の条件の代わりに結果の判定のしかたの印を持つ。
  resultJudgement: 'FORM_STRUCTURE',
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
  // T40c: 版 1.1 の FORM の記録（送り方 `FORM`、API の要約なし）。
  transport: 'FORM',
  api: null,
  ...overrides,
});

const writeOf =(overrides: Partial<NonNullable<FakeWorkerValues['write']>> = {}): NonNullable<FakeWorkerValues['write']> => ({
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
  readonly runId: string;
  /** その段の書き込みの指定（`NEXT_STAGE`）。 */
  readonly stage: Record<string, unknown> | undefined;
}): Promise<void> {
  const text = readFileSync(join(resolve(workDirectory, OUTPUT_DIRECTORY), input.runId, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME), 'utf8');
  const summary = JSON.parse(text) as ApprovalSummaryDocument;
  expect(await validateArtifact('approval-summary', summary)).toEqual({ ok: true });
  const stage = input.stage as { readonly write: { readonly approvalFacts: unknown } } | undefined;
  expect(summary).toEqual({ ...(stage?.write.approvalFacts as object), schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION, jobId: input.jobId, runId: input.runId });
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

/** 点検を 1 回、偽のワーカーで行った結果（書き込みの段のジョブ・その許可・偽のワーカーが受けた書き込みの指定）。 */
interface WriteChainRun extends WriteChainResult {
  readonly received: readonly Record<string, unknown>[];
  /** 書き込みの段の指定（行った順）。 */
  readonly stages: readonly Record<string, unknown>[];
}

/** 点検を 1 回、偽のワーカーで行う（書き込みの段は、チェックした画面の登録 →（承認した更新があれば）更新）。 */
async function runInspection(
  name: string,
  write: NonNullable<FakeWorkerValues['write']>,
  options: { readonly candidates?: readonly typeof CREATE_CANDIDATE[]; readonly onStarted?: (chainId: string, worker: FakeWorker) => void } = {},
): Promise<WriteChainRun> {
  const worker = fakeWorker(name, write, options.candidates === undefined ? CREATE_ONLY : [...options.candidates]);
  const jobs = await managerWith(worker);
  const result = await runWriteChain(jobs, GRANT_PROFILE_ID, MIN_PROFILE_REVISION, (chainId) => options.onStarted?.(chainId, worker));
  const received = worker.received();
  return { ...result, received, stages: writeStagesOf(received) };
}

/** 登録の段だけの点検を行い、その段のジョブの見え方と、許可の id を返す。 */
async function runCreateStage(
  name: string,
  write: NonNullable<FakeWorkerValues['write']>,
  options: Parameters<typeof runInspection>[2] = {},
): Promise<AuditJobView & { readonly grantId: string; readonly run: WriteChainRun }> {
  const run = await runInspection(name, write, options);
  const [job] = run.writeJobs;
  if (job === undefined) {
    throw new Error(`no write stage: ${JSON.stringify(run.chain)}`);
  }
  expect(job).toMatchObject({ jobKind: 'WRITE_CREATE' });
  return { ...job, grantId: readWriteResult(database, job.jobId)?.grantId ?? '', run };
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

describe('write stages of the inspection (T30e): the preparation', () => {
  it('runs a write stage: issues and consumes the grant, records the attempt before NEXT_STAGE, sends the write specification, and settles the result once', async () => {
    const ended = await runCreateStage('verified', writeOf({ actionRunText: JSON.stringify(actionRunOf()), report: WRITE_REPORT }));
    const { jobId, grantId } = ended;
    const start = ended.run.stages[0];
    // T32e（T32d の申し送り）: 親が組み立てた承認の要約の事実（書き込みの指定）を、偽のワーカーが書いた `approval-summary.json` で明示に確かめる。
    await expectApprovalSummaryOfParent({ jobId, grantId, kind: 'CREATE', scenarioId: 'scenario-1', runId: FAKE_RUN_ID, stage: start });
    expect(ended.run.chain).toMatchObject({ state: 'FINISHED', stopReason: null, writeStageJobIds: [jobId] });
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', failureReason: null, endKind: 'RAN' });
    expect(readExecutionGrant(database, grantId)).toMatchObject({ jobId, consumedAt: MANAGER_NOW, reservation: { state: 'COMMITTED' } });
    const result = readWriteResult(database, jobId);
    expect(result).toMatchObject({ grantId, submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED',
      submittedValues: { name: '試験一郎' } });
    expect(ended.run.stages).toHaveLength(1);
    expect(start).toMatchObject({
      jobId,
      jobKind: 'WRITE_CREATE',
      write: {
        scenarioId: 'scenario-1',
        grantId,
        request: { formMethod: 'POST', path: '/members' },
        candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest },
        values: { name: '試験一郎' },
        verification: { resultJudgement: VERIFICATION_SPEC.resultJudgement, recordId: VERIFICATION_SPEC.recordId },
        readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, targetPage: null,
          definition: { parameters: { q: '試験一郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } },
      },
    });
    // 送る値は、送る前の記録と同じ（送る前に記録した）。
    expect((start?.['write'] as Record<string, unknown>)['values']).toEqual(result?.submittedValues);
    // T30f（Blocker 1 の案 A）: プロファイルと seed の記録も、送る前の記録と同じ値を送る。
    expect((start?.['write'] as Record<string, unknown>)['profileId']).toBe(GRANT_PROFILE_ID);
    expect((start?.['write'] as Record<string, unknown>)['seedRecord']).toEqual(result?.seedRecord);
    expect(ended.run.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null },
    ]);
    // ジョブの管理を作り直した後の回復は、締めた結果を変えない（二重に締めない）。
    expect((await managerWith(fakeWorker('after', writeOf()))).recoverInterruptedJobs()).toBe(0);
    expect(readWriteResult(database, jobId)?.result).toBe('VERIFIED');
  }, TEST_TIMEOUT_MS);

  // T31f: 生成の履歴は、同じ台帳の UPDATE で送った値を含む。前の UPDATE が、CREATE の規則の唯一の値（`試験一郎`）をレコードに送ったので、CREATE の生成は
  // その値を使った値として扱い、値を作れない（`WRITE_DATA_NOT_GENERATED`）。その段は送らず、予約を返し、更新の段も試さずに、試せなかった理由で終える。
  it('does not send a stage whose data cannot be generated (the values sent by an update of the ledger), and ends with WRITE_NOT_TRIED', async () => {
    registerTarget();
    prepareUpdateApproved();
    recordEarlierUpdate('試験一郎');
    const run = await runInspection('create-after-update', writeOf(), { candidates: CREATE_AND_UPDATE });
    expect(run.chain).toMatchObject({ state: 'STOPPED', stopReason: 'WRITE_NOT_TRIED', writeStageJobIds: [] });
    expect(run.stages).toEqual([]);
    expect(run.writeJobs.map(({ jobKind, state, failureReason }) => [jobKind, state, failureReason])).toEqual([['WRITE_CREATE', 'FAILED', 'WRITE_GRANT_REJECTED']]);
    const result = readWriteResult(database, run.writeJobs[0]?.jobId ?? '');
    expect(result).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(readExecutionGrant(database, result?.grantId ?? '')).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'RELEASED' } });
  }, TEST_TIMEOUT_MS);

  // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない。定義の行を、版を変えずに画面の path の定義に書き換えた（テスト
  // だけの操作。承認と許可の確かめは定義の ID と版だけを見るので、照合の READ の確かめまで進む）とき、送らずに止め、予約を返す。
  it('does not send a stage whose verification READ is a page path definition (WRITE_READ_VERIFICATION_PAGE_TARGET), and leaves no reservation RESERVED', async () => {
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory), { timeout: RAW_BUSY_TIMEOUT_MS });
    try {
      expect(raw.prepare("UPDATE read_checks SET target_identity_digest = NULL, target_page_path = '/members', parameters = '{}' WHERE read_check_id = ?")
        .run('rc-verify').changes).toBe(1);
    } finally {
      raw.close();
    }
    const run = await runInspection('page-verification', writeOf());
    expect(run.chain).toMatchObject({ state: 'STOPPED', stopReason: 'WRITE_NOT_TRIED' });
    expect(run.stages).toEqual([]);
    expect(run.writeJobs.map(({ state, failureReason }) => [state, failureReason])).toEqual([['FAILED', 'WRITE_GRANT_REJECTED']]);
    expect(readWriteResult(database, run.writeJobs[0]?.jobId ?? '')).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
  }, TEST_TIMEOUT_MS);
});

describe('write stages of the inspection (T30e): the recheck', () => {
  it('rejects the recheck after a revocation, sends STOP, and settles the reported NOT_SENT as BLOCKED', async () => {
    const gate = join(workDirectory, 'recheck-gate');
    const revoking: Promise<void>[] = [];
    const ended = await runCreateStage('revoked-recheck', writeOf({ recheckGate: gate }), {
      // 書き込みの指定が届いた（許可を消費した）後、確かめ直しの依頼の前に、承認を撤回する。
      onStarted: (_chainId, worker) => {
        revoking.push((async () => {
          while (writeStagesOf(worker.received()).length === 0) {
            await wait(GATE_POLL_MS);
          }
          expect(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: readScenario(database, 'scenario-1')?.revision ?? 0,
            receiptId: 'revoke-1', at: MANAGER_NOW }).ok).toBe(true);
          writeFileSync(gate, '', 'utf8');
        })());
      },
    });
    await Promise.all(revoking);
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    expect(ended.run.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'GRANT_INVALID' },
    ]);
    expect(ended.run.received.some((message) => message['type'] === 'STOP')).toBe(true);
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(reservationOf(ended.grantId)).toBe('RELEASED');
  }, TEST_TIMEOUT_MS);

  it('rejects a second recheck request with RECHECK_REPEATED and STOP', async () => {
    const ended = await runCreateStage('double', writeOf({ recheck: 2 }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    const results = ended.run.received.filter((message) => message['type'] === 'WRITE_RECHECK_RESULT');
    expect(results).toContainEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'RECHECK_REPEATED' });
    expect(ended.run.received.some((message) => message['type'] === 'STOP')).toBe(true);
    expect(readWriteResult(database, ended.jobId)?.reservationState).not.toBeNull();
  }, TEST_TIMEOUT_MS);
});

// OP-F（安全のレビュー OP-REV の M-1）: 「やめる」を押したのが、親が書き込みの段を準備している間（最後の読み取りの段の後、`NEXT_STAGE` の前）でも、書き込みの段を
// 始めない。値の候補が尽きてチェックした画面を試せなかった点検は、黙って「最後まで行った」にせず、試せなかった理由で終える。送らずに止めた回の値は、使った扱いに
// しない（設計書 4.1.2 の R4）。押す時を時間に頼らずに作るため、ジョブの管理が書き込みの準備の中で時計を読む時に押す（テストの口）。SLIM W-2: 本物のワーカーの
// fork のテスト（RB-6 で消した書き込みの連鎖の fork）から移した（親の判定で、本物の Chromium の書き込みを要しない）。
describe('write stages of the inspection (OP-F M-1): the stop while the parent prepares the write stage', () => {
  /** 書き込みの準備の中の、`where` に当たる時計の読み出しで「やめる」を押す点検。 */
  const inspectStoppingAt = async (name: string, where: (stack: string) => boolean): Promise<WriteChainRun> => {
    let chainId: string | null = null;
    let stopped: unknown = null;
    clockReadHook = (stack) => {
      if (stopped === null && chainId !== null && where(stack)) {
        stopped = manager?.stopAuditJob(chainId) ?? null;
      }
    };
    try {
      return await runInspection(name, writeOf({ actionRunText: JSON.stringify(actionRunOf()) }), { onStarted: (id) => {
        chainId = id;
      } });
    } finally {
      clockReadHook = null;
      expect(stopped).toMatchObject({ ok: true });
    }
  };
  const writeResultCount = (): number => readWriteResults(database, 'scenario-1').length;

  it('does not start the write stage after the stop, then creates with the same value, and ends with the reason when no value is left', async () => {
    // 1 回目: 許可の発行の前（最初の書き込みの段の前の、更新の下書きの判定の間）に「やめる」を押す。許可を出さず（記録の行もない）、利用者の停止で終わる。
    const beforeGrant = await inspectStoppingAt('stop-before-grant', (stack) => stack.includes('prepareChainUpdates'));
    expect(beforeGrant.chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED', writeStageJobIds: [] });
    expect(beforeGrant.writeJobs).toEqual([]);
    expect(writeResultCount()).toBe(0);

    // 2 回目: 書き込みの準備の中（`NEXT_STAGE` の前）で「やめる」を押す。書き込みの段を始めず（送らずに締める）、利用者の停止で終わる。
    const inPreparation = await inspectStoppingAt('stop-in-preparation', (stack) => stack.includes('prepareWrite'));
    expect(inPreparation.chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED', writeStageJobIds: [] });
    expect(inPreparation.stages).toEqual([]);

    // 3 回目: 送らずに止めた回の値は使った扱いにしないので、同じ値で登録できる。
    clock = new Date(dateOfCompactUtcTimestamp(MANAGER_NOW).getTime() + 10 * MINUTE_MS);
    const created = await runInspection('create-same-value', writeOf({ actionRunText: JSON.stringify(actionRunOf({ startedAt: timeAt(11 * MINUTE_MS),
      submittedAt: timeAt(11 * MINUTE_MS), finishedAt: timeAt(11 * MINUTE_MS) })) }));
    expect(created.chain).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(readWriteResult(database, created.chain.writeStageJobIds[0] ?? '')).toMatchObject({ writeKind: 'CREATE', submission: 'SENT', result: 'VERIFIED',
      submittedValues: { name: '試験一郎' } });

    // 4 回目: 値の候補が尽きたので、チェックした画面を試せない。黙って「最後まで行った」にせず、試せなかった理由で終える。何も送らない。
    clock = new Date(dateOfCompactUtcTimestamp(MANAGER_NOW).getTime() + 20 * MINUTE_MS);
    const exhausted = await runInspection('values-used-up', writeOf());
    expect(exhausted.chain).toMatchObject({ state: 'STOPPED', stopReason: 'WRITE_NOT_TRIED', writeStageJobIds: [] });
    expect(exhausted.stages).toEqual([]);
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
    const ended = await runCreateStage(name.split(' ').join('-'), writeOf({
      actionRunText: JSON.stringify(actionRunOf()),
      report: reportOf({ ...(evidence === null ? {} : { actionEvidenceText: evidenceTextOf(evidence) }), ...report }),
    }));
    expect(ended).toMatchObject({ state: 'FINISHED', failureReason: null, writeReportCheck: check });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ result: 'VERIFIED', reservationState: 'COMMITTED' });
    expect(reservationOf(ended.grantId)).toBe('COMMITTED');
  }, TEST_TIMEOUT_MS);

  it('records RESULT_INVALID when the action-run.json cannot be used (the job is WRITE_RESULT_INVALID)', async () => {
    const ended = await runCreateStage('report-result-invalid', writeOf({ actionRunText: '{"schemaVersion":', report: reportOf() }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID', writeReportCheck: 'RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);

  it('records no report check for a worker that ended before the result', async () => {
    const ended = await runCreateStage('report-crash', writeOf({ end: 'crash', report: reportOf() }));
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
    const ended = await runCreateStage(name.split(' ').join('-'), writeOf(write));
    expect(ended).toMatchObject(job);
    expect(readWriteResult(database, ended.jobId)).toMatchObject(settled);
    expect(reservationOf(ended.grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it('does not trust an action-run.json with another seed record (T30f; settles from the reports)', async () => {
    const ended = await runCreateStage('other-seed', writeOf({ actionRunText: JSON.stringify(actionRunOf({ seedRecord: fixedSeedRecordOf('grant-other') })) }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);

  it('does not trust an action-run.json of another job (settles from the reports)', async () => {
    const ended = await runCreateStage('other-job', writeOf({ actionRunText: JSON.stringify(actionRunOf({ jobId: 'job-other' })) }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN' });
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
/**
 * 直接に作る登録で送った値、点検の登録の段で送る値（`FIXED_CONTENT` の唯一の値）、UPDATE の規則の固定の値（変える欄 `name`。一意にする欄の組も `name`）。
 */
const REGISTERED_NAME = '試験零郎';
const CREATED_NAME = '試験一郎';
const UPDATED_NAME = '試験二郎';
const UPDATE_CONTENT: RuleSetContent = {
  fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [UPDATED_NAME] }],
  relations: [],
  uniqueKeyFieldNames: ['name'],
};
/** 偽のワーカーが、書き込みの指定の対象の ID に置き換える印。 */
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

/** UPDATE の証拠（変える欄 `name` 1 つ。前の値は同じ点検の登録で送った値。既定は一致）。 */
const updateEvidenceOf = (matched: boolean | null = true, newValue = UPDATED_NAME): WriteUpdateEvidence => ({
  fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: CREATED_NAME, newValue, matched }],
});

/** 照合まで済んだ UPDATE の `action-run.json`（対象の ID は、偽のワーカーが書き込みの指定の値に置き換える印）。 */
const updateActionRunOf = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => actionRunOf({
  runId: UPDATE_RUN_ID,
  scenarioId: UPDATE_SCENARIO_ID,
  scenarioRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0,
  submittedValues: { name: UPDATED_NAME },
  recordId: UPDATE_TARGET,
  update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf() },
  ...overrides,
});

/**
 * 登録（照合まで済み、取れた ID は `UPDATE_TARGET`）→ 更新の点検を 1 回、偽のワーカーで行い、更新の段のジョブの見え方と許可の id を返す。更新の段だけの値は
 * `update`。
 */
async function runUpdateStage(
  name: string,
  update: NonNullable<NonNullable<FakeWorkerValues['write']>['updateStage']>,
  options: { readonly report?: typeof WRITE_REPORT } = {},
): Promise<AuditJobView & { readonly grantId: string; readonly run: WriteChainRun }> {
  const run = await runInspection(name, writeOf({
    runIds: [FAKE_RUN_ID, UPDATE_RUN_ID],
    actionRunText: JSON.stringify(actionRunOf({ recordId: UPDATE_TARGET })),
    ...(options.report === undefined ? {} : { report: options.report }),
    updateStage: update,
  }), { candidates: CREATE_AND_UPDATE });
  const job = run.writeJobs.find(({ jobKind }) => jobKind === 'WRITE_UPDATE');
  if (job === undefined) {
    throw new Error(`no update stage: ${JSON.stringify(run.chain)}`);
  }
  expect(readWriteResult(database, run.writeJobs[0]?.jobId ?? '')).toMatchObject({ writeKind: 'CREATE', result: 'VERIFIED' });
  return { ...job, grantId: readWriteResult(database, job.jobId)?.grantId ?? '', run };
}

describe('update write stages of the inspection (T31f): the preparation', () => {
  beforeEach(() => {
    prepareUpdateApproved();
  });

  it('copies the target of the grant into the write specification with the concrete paths, without a kept or prior value, and settles VERIFIED', async () => {
    const ended = await runUpdateStage('update-verified', { actionRunText: JSON.stringify(updateActionRunOf()) }, { report: WRITE_REPORT });
    const { jobId, grantId } = ended;
    const start = ended.run.stages[1];
    // T32e（T32d の申し送り）: UPDATE の承認の要約の事実（種類、許可、件数、UPDATE だけの項目）。
    await expectApprovalSummaryOfParent({ jobId, grantId, kind: 'UPDATE', scenarioId: UPDATE_SCENARIO_ID, runId: UPDATE_RUN_ID, stage: start });
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', failureReason: null, endKind: 'RAN' });
    expect(ended.run.chain).toMatchObject({ state: 'FINISHED', stopReason: null });
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
    expect(JSON.stringify(start)).not.toContain(CREATED_NAME);
    expect(JSON.stringify([write['request'], write['formPage'], write['update']])).not.toContain('{id}');
    expect(readWriteResult(database, jobId)).toMatchObject({
      writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, submittedValues: { name: UPDATED_NAME }, submission: 'SENT', recordId: UPDATE_TARGET,
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', updateEvidence: updateEvidenceOf(),
    });
    expect(reservationOf(grantId)).toBe('COMMITTED');
  }, TEST_TIMEOUT_MS);

  it('does not send an update whose value was already sent by an update of the same ledger (WRITE_DATA_NOT_GENERATED), releasing the grant', async () => {
    // 前の UPDATE（登録 42 へ）が、更新の規則の唯一の値を送った。同じ点検の登録（43）の更新の生成も、台帳の送った値として扱う。
    registerTarget();
    recordEarlierUpdate(UPDATED_NAME);
    const run = await runInspection('update-used', writeOf({ actionRunText: JSON.stringify(actionRunOf({ recordId: '43' })) }), { candidates: CREATE_AND_UPDATE });
    expect(run.chain).toMatchObject({ state: 'STOPPED', stopReason: 'WRITE_NOT_TRIED' });
    expect(run.stages.map((stage) => stage['jobKind'])).toEqual(['WRITE_CREATE']);
    const update = run.writeJobs.find(({ jobKind }) => jobKind === 'WRITE_UPDATE');
    expect(update).toMatchObject({ state: 'FAILED', failureReason: 'WRITE_GRANT_REJECTED' });
    const result = readWriteResult(database, update?.jobId ?? '');
    expect(result).toMatchObject({ writeKind: 'UPDATE', submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(readExecutionGrant(database, result?.grantId ?? '')).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'RELEASED' } });
  }, TEST_TIMEOUT_MS);
});

describe('update write stages of the inspection (T31f): the settlement at the end of the stage', () => {
  beforeEach(() => {
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
    const ended = await runUpdateStage(name.split(' ').join('-'), { actionRunText: JSON.stringify(updateActionRunOf(overrides)) });
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', failureReason: null });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, submission: 'SENT', ...settled });
    expect(reservationOf(ended.grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, () => string | null, NonNullable<NonNullable<FakeWorkerValues['write']>['updateStage']>,
    Record<string, unknown>, Record<string, unknown>]>([
    ['an action-run.json without the update block', () => JSON.stringify(actionRunOf({
      runId: UPDATE_RUN_ID, scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: readScenario(database, UPDATE_SCENARIO_ID)?.revision ?? 0,
      submittedValues: { name: UPDATED_NAME },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['an action-run.json of another target', () => JSON.stringify(updateActionRunOf({
      update: { targetRecordId: '43', updateEvidence: updateEvidenceOf() },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' }, { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['an action-run.json whose evidence does not match the sent values', () => JSON.stringify(updateActionRunOf({
      update: { targetRecordId: START_TARGET_MARK, updateEvidence: updateEvidenceOf(true, '試験三郎') },
    })), {}, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN', updateEvidence: null },
    { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
    ['a crash after a SENT report', () => null, { end: 'crash' }, { submission: 'UNKNOWN', result: 'UNKNOWN', reservationState: 'UNKNOWN' },
      { state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' }],
    ['a NOT_SENT report without action-run.json', () => null, { submission: { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' } },
      { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED' },
      { state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' }],
  ])('settles an update stage with %s from the reports', async (name, textOf, update, settled, job) => {
    const ended = await runUpdateStage(name.split(' ').join('-'), { actionRunText: textOf(), ...update });
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', ...job });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ writeKind: 'UPDATE', targetRecordId: UPDATE_TARGET, ...settled });
    expect(reservationOf(ended.grantId)).toBe(settled['reservationState']);
  }, TEST_TIMEOUT_MS);

  it('does not trust a create action-run.json with an update block (settles from the reports)', async () => {
    const ended = await runCreateStage('create-with-update', writeOf({ actionRunText: JSON.stringify(actionRunOf({
      update: { targetRecordId: UPDATE_TARGET, updateEvidence: null },
    })) }), { candidates: CREATE_AND_UPDATE });
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ writeKind: 'CREATE', submission: 'UNKNOWN', result: 'UNKNOWN' });
  }, TEST_TIMEOUT_MS);
});

// T40c（Task 40 の設計書 3.4。設計者の判断「順の入れ替え」）: FORM の書き込みのジョブの回帰。記録と報告は版 1.1（送り方 `FORM`、API の要約なし）で、締めは
// 今どおり。LG-4: 前の版 1.0 の記録（送り方を持たない）は使わない（`WRITE_RESULT_INVALID`）。送り方 `API` の記録も、FORM のジョブでは使わない。台帳の行は
// 送り方 `FORM` で、API の型の要約を持たない。
describe('write jobs (T40c): the FORM records of the version 1.1, and no record of the version 1.0', () => {
  it('settles a FORM record of 1.1 as today, and the ledger row has the transport FORM and no API summary', async () => {
    const run = actionRunOf();
    expect(run).toMatchObject({ schemaVersion: ACTION_RUN_SCHEMA_VERSION, transport: 'FORM', api: null });
    const ended = await runCreateStage('form-v11', writeOf({ actionRunText: JSON.stringify(run) }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', failureReason: null });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ result: 'VERIFIED', reservationState: 'COMMITTED', transport: 'FORM', api: null });
  }, TEST_TIMEOUT_MS);

  it('does not use a FORM record of the previous version 1.0 (no transport, no API summary; settles from the reports)', async () => {
    const { transport: _transport, api: _api, ...run } = actionRunOf();
    const ended = await runCreateStage('form-v10', writeOf({ actionRunText: JSON.stringify({ ...run, schemaVersion: 'action-run-schema/1.0' }) }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', transport: 'FORM', api: null });
  }, TEST_TIMEOUT_MS);

  it('does not use an API record for a FORM job (settles from the reports)', async () => {
    const ended = await runCreateStage('form-with-api', writeOf({ actionRunText: JSON.stringify(actionRunOf({
      transport: 'API', api: sampleApiSummary(), resultJudgement: null, submittedValues: {},
    })) }));
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FAILED', failureReason: 'WRITE_RESULT_INVALID' });
    expect(readWriteResult(database, ended.jobId)).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', transport: 'FORM', api: null });
  }, TEST_TIMEOUT_MS);
});
