// T27e（Task 27 の設計書 4.5、4.6）: READ の確かめのジョブ（`READ_CHECK`）の、ジョブの管理（`createAuditJobManager` の `startReadCheck` と、ジョブの
// 終わりの結果の記録）を、偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `read-check` の動き）を本物の `fork` で起動して確かめる（本物の
// ワーカーと Chromium での端から端は `discovery-job-fork.test.ts` の「T27e」の describe）。
// - 開始の確かめは発見と同じ（プロファイルが `TEST_AUTH_PASSIVE`、認証の設定が `CURRENT`）。取り消していない定義が 0 件なら
//   `READ_CHECK_DEFINITIONS_MISSING`（ワーカーを起動しない）。公開の監査のプロファイルは拒む。
// - `START` は、`READ_CHECK` の種類と、認証の指定（種類を含む SHA-256）と、定義の一覧（定義の ID・今の版・対象の候補の画面・定義の中身）を持つ。
//   対象の候補の画面は、索引で候補を最後に見た発見のジョブの `discovery.json` から決める（決められなければ `null`）。取り消した定義は入れない。
// - ジョブの終わり: 親が `read-evidence.json` を読み、スキーマ・ジョブの ID・Run の ID・件数の要約・定義の一覧で確かめ、結果を記録してから、ジョブを
//   `FINISHED` にする。読めない・合わないときは `FAILED`（`READ_CHECK_RESULT_INVALID`）で、結果を記録しない。実行の間に定義が変わった（版が違う）
//   結果は、記録の部品が拒む（ほかの結果は記録する）。
// - `FINISHED` の件数の要約は、READ の確かめのジョブの Run を実行した結果だけ（ないのは契約の違反）。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { AuditJobManager, AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import {
  cancelReadCheck,
  createReadCheck,
  readRecentReadCheckResults,
  updateReadCheck,
} from '../../src/control/job/read-check-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { MAX_WORKER_READ_CHECKS, workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { blockingAfterStartFork, createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import {
  PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
  testWriteProfile,
} from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261011000000';
const OTHER_RUN_ID = 'RUN-20261011000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-read-check-job';
const PUBLIC_PROFILE_ID = 'example-public-read-check';
const WRITE_PROFILE_ID = 'example-write-read-check';
const TEST_TIMEOUT_MS = 60_000;
/** 発見と READ の確かめのジョブの出力先（同じ場所。READ の確かめのジョブが、発見の `discovery.json` を読む）。 */
const OUTPUT_DIRECTORY = 'read-check-jobs-output';
const DEFINITION_AT = '20261011000500';
const CHANGED_AT = '20261011000600';

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

const ALLOWED: ReadonlySet<string> = new Set([TEST_ORIGIN]);
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }),
  ...computeCandidateDigests(discovered),
});
const location = (path: string) => ({ origin: TEST_ORIGIN, path });
const SEARCH = candidateOf(sampleForm({
  page: location('/admin/items'), formMethod: 'GET', action: sampleAction('/admin/items', [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search'), sampleField('authenticity_token', 'hidden')],
}));
const LOOKUP = candidateOf(sampleForm({
  page: location('/admin/lookup'), formMethod: 'GET', action: sampleAction('/admin/item', [], TEST_ORIGIN), submitterText: '照会',
  fields: [sampleField('id')],
}));
const UNKNOWN_DIGEST = `sha256:${'f'.repeat(64)}`;

const definitionFor = (targetIdentityDigest: string, q = 'x'): ReadCheckDefinition => ({
  targetIdentityDigest,
  parameters: { q },
  expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
});

const discoveryDocument = (jobId: string): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId,
  runId: FAKE_RUN_ID,
  startedAt: '20261011000000',
  finishedAt: '20261011000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [
    { url: `${TEST_ORIGIN}/admin/items`, state: 'READ', record: { location: location('/admin/items'), incompleteReasons: [], candidates: [SEARCH] }, blockedRequests: 0 },
    { url: `${TEST_ORIGIN}/admin/lookup`, state: 'READ', record: { location: location('/admin/lookup'), incompleteReasons: [], candidates: [LOOKUP] }, blockedRequests: 0 },
  ],
  omittedUnreadPages: 0,
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

const countingFork: AuditWorkerForker = forks.fork;

const fakeWorker = (mode: FakeWorkerMode, extra: Partial<FakeWorkerValues>, name: string): FakeWorker => {
  const directory = join(workDirectory, 'workers', name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, extra));
};

/** 偽のワーカーで、ジョブの管理を作り直す（出力先は、発見と READ の確かめで同じ）。 */
async function managerWith(worker: FakeWorker, forkWorker: AuditWorkerForker = countingFork): Promise<AuditJobManager> {
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker,
  });
  return manager;
}

/** 今のジョブの管理から、ジョブの見え方を読む（ない間は null）。 */
const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };

/** 発見のジョブを 1 回、偽のワーカーで行い、索引と `discovery.json` を作る。 */
async function discover(profileId = PROFILE_ID): Promise<void> {
  const document = discoveryDocument('__JOB_ID__');
  const worker = fakeWorker('discovery', {
    discovery: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
      documentText: JSON.stringify(document),
      summary: { ...discoverySummaryOf(document) },
      runStatus: 'COMPLETE',
    },
  }, 'discovery');
  const started = await (await managerWith(worker)).startDiscovery({ profileId, expectedRevision: MIN_PROFILE_REVISION });
  if (!started.ok) {
    throw new Error(`the discovery job did not start: ${started.reason}`);
  }
  expect(await waitForJob(currentManager, started.job.jobId, isJobEnded)).toMatchObject({ state: 'FINISHED' });
}

/** READ の確かめのジョブを 1 回、偽のワーカーで行う。 */
async function runReadCheckJob(
  name: string,
  readCheck: Omit<NonNullable<FakeWorkerValues['readCheck']>, 'outputDirectory'>,
  whileRunning?: () => void,
  forkWorker: AuditWorkerForker = countingFork,
  profileId = PROFILE_ID,
): Promise<AuditJobView & { readonly received: readonly Record<string, unknown>[] }> {
  const worker = fakeWorker('read-check', { readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), ...readCheck } }, name);
  const started = await (await managerWith(worker, forkWorker)).startReadCheck({ profileId, expectedRevision: MIN_PROFILE_REVISION });
  if (!started.ok) {
    throw new Error(`the READ check job did not start: ${started.reason}`);
  }
  expect(started.job).toMatchObject({ jobKind: 'READ_CHECK', state: 'STARTING' });
  whileRunning?.();
  const ended = await waitForJob(currentManager, started.job.jobId, isJobEnded);
  return { ...ended, received: worker.received() };
}

const createDefinition = (readCheckId: string, definition: ReadCheckDefinition, profileId = PROFILE_ID): void => {
  expect(createReadCheck(database, { readCheckId, profileId, definition, at: DEFINITION_AT }).ok).toBe(true);
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-read-check-jobs-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('READ check jobs (T27e): the start', () => {
  it('rejects a profile without definitions (READ_CHECK_DEFINITIONS_MISSING), a public profile and a wrong request without starting a worker', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const jobs = await managerWith(fakeWorker('read-check', { readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), results: [] } }, 'rejects'));
    expect(await jobs.startReadCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
      .toMatchObject({ ok: false, reason: 'READ_CHECK_DEFINITIONS_MISSING' });
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    expect(cancelReadCheck(database, { readCheckId: 'read-1', expectedRevision: 1, at: CHANGED_AT }).ok).toBe(true);
    expect(await jobs.startReadCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
      .toMatchObject({ ok: false, reason: 'READ_CHECK_DEFINITIONS_MISSING' });
    expect(await jobs.startReadCheck({ profileId: PUBLIC_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION })).toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    expect(await jobs.startReadCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1 })).toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(await jobs.startReadCheck({ profileId: PROFILE_ID } as never)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(forks.count()).toBe(0);
    expect(jobs.listAuditJobs()).toEqual([]);
  });

  it('sends START with the kind, the authentication bound to the kind and the definitions with the target pages from the last discovery', async () => {
    await discover();
    createDefinition('read-1', definitionFor(SEARCH.identityDigest, 'りんご'));
    createDefinition('read-2', definitionFor(LOOKUP.identityDigest));
    createDefinition('read-3', definitionFor(UNKNOWN_DIGEST));
    createDefinition('read-4', definitionFor(SEARCH.identityDigest));
    expect(updateReadCheck(database, { readCheckId: 'read-2', expectedRevision: 1, definition: definitionFor(LOOKUP.identityDigest, 'A-2'), at: CHANGED_AT }).ok).toBe(true);
    expect(cancelReadCheck(database, { readCheckId: 'read-4', expectedRevision: 1, at: CHANGED_AT }).ok).toBe(true);
    const ended = await runReadCheckJob('start', { results: ['MATCHED', 'NOT_MATCHED', 'READ_CANDIDATE_DRIFTED'] });
    expect(ended).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', resultRunStatus: 'COMPLETE', endKind: 'RAN', failureReason: null });
    const start = ended.received.find((message) => message['type'] === 'START');
    expect(start).toMatchObject({ jobKind: 'READ_CHECK', authentication: { approvedTestOrigins: [TEST_ORIGIN] } });
    const authentication = start?.['authentication'] as { readonly setup: AuthSetup; readonly authenticationSha256: string };
    expect(authentication.authenticationSha256)
      .toBe(workerAuthenticationDigestOf(authentication.setup, [TEST_ORIGIN], { jobKind: 'READ_CHECK', automatedLogin: null }));
    expect(start?.['readChecks']).toEqual([
      { readCheckId: 'read-1', readCheckRevision: 1, targetPage: location('/admin/items'), definition: definitionFor(SEARCH.identityDigest, 'りんご') },
      { readCheckId: 'read-2', readCheckRevision: 2, targetPage: location('/admin/lookup'), definition: definitionFor(LOOKUP.identityDigest, 'A-2') },
      { readCheckId: 'read-3', readCheckRevision: 1, targetPage: null, definition: definitionFor(UNKNOWN_DIGEST) },
    ]);
    // 結果を記録してから、ジョブを終える。
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ jobId, readCheckId, readCheckRevision, result }) => [jobId, readCheckId, readCheckRevision, result]).sort())
      .toEqual([
        [ended.jobId, 'read-1', 1, 'MATCHED'],
        [ended.jobId, 'read-2', 2, 'NOT_MATCHED'],
        [ended.jobId, 'read-3', 1, 'READ_CANDIDATE_DRIFTED'],
      ]);
    // IPC: 結果を載せず、件数の要約だけ。
    expect(MAX_WORKER_READ_CHECKS).toBe(20);
  }, TEST_TIMEOUT_MS);

  // T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルでも、認証の設定・発見・READ の
  // 確かめの定義の保存・READ の確かめのジョブができる（確かめは認証つきの読み取りの監査と同じ）。認証つきの監査（`AUDIT`）は、今までどおり
  // `MODE_NOT_EXECUTABLE` で、ワーカーを起動しない。
  it('runs the READ check of a write mode profile after its discovery, and still rejects its AUDIT (T28b)', async () => {
    expect(createProfile(database, testWriteProfile(WRITE_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(saveAuthSetup(database, { ...SETUP, profileId: WRITE_PROFILE_ID }, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
    await discover(WRITE_PROFILE_ID);
    createDefinition('write-read-1', definitionFor(SEARCH.identityDigest), WRITE_PROFILE_ID);
    const ended = await runReadCheckJob('write-mode', { results: ['MATCHED'] }, undefined, countingFork, WRITE_PROFILE_ID);
    expect(ended).toMatchObject({ profileId: WRITE_PROFILE_ID, jobKind: 'READ_CHECK', state: 'FINISHED', resultRunStatus: 'COMPLETE', failureReason: null });
    expect(ended.received.find((message) => message['type'] === 'START')).toMatchObject({
      jobKind: 'READ_CHECK',
      authentication: { approvedTestOrigins: [TEST_ORIGIN] },
      readChecks: [{ readCheckId: 'write-read-1', readCheckRevision: 1, targetPage: location('/admin/items') }],
    });
    expect(readRecentReadCheckResults(database, WRITE_PROFILE_ID).map(({ jobId, readCheckId, result }) => [jobId, readCheckId, result]))
      .toEqual([[ended.jobId, 'write-read-1', 'MATCHED']]);
    const forked = forks.count();
    expect(await manager?.startAuditJob({ profileId: WRITE_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true }))
      .toEqual({ ok: false, reason: 'MODE_NOT_EXECUTABLE', errors: [] });
    expect(forks.count()).toBe(forked);
  }, TEST_TIMEOUT_MS);

  it('gives a null target page when the last discovery.json cannot be read', async () => {
    await discover();
    rmSync(join(workDirectory, OUTPUT_DIRECTORY, FAKE_RUN_ID, 'discovery.json'));
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    const ended = await runReadCheckJob('no-discovery-json', { results: ['READ_CANDIDATE_DRIFTED'] });
    expect(ended.received.find((message) => message['type'] === 'START')?.['readChecks']).toEqual([
      { readCheckId: 'read-1', readCheckRevision: 1, targetPage: null, definition: definitionFor(SEARCH.identityDigest) },
    ]);
  }, TEST_TIMEOUT_MS);

  // T37d（Task 37 の設計書 3.5）: 画面の path の定義の対象の画面は、ターゲット設定の開始の URL の Origin と定義の path（発見の結果によらない）。結果の
  // 成果物は、対象の種類と画面の path まで、開始の定義と照らす。
  it('sends a page path definition with the page of the start URL origin, and records its result', async () => {
    await discover();
    const pageDefinition: ReadCheckDefinition = { targetPagePath: '/admin/members', parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    createDefinition('read-2', pageDefinition);
    const ended = await runReadCheckJob('page-path', { results: ['MATCHED', 'UNDETERMINED'] });
    expect(ended).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', failureReason: null });
    expect(ended.received.find((message) => message['type'] === 'START')?.['readChecks']).toEqual([
      { readCheckId: 'read-1', readCheckRevision: 1, targetPage: location('/admin/items'), definition: definitionFor(SEARCH.identityDigest) },
      { readCheckId: 'read-2', readCheckRevision: 1, targetPage: location('/admin/members'), definition: pageDefinition },
    ]);
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ readCheckId, result }) => [readCheckId, result]).sort())
      .toEqual([['read-1', 'MATCHED'], ['read-2', 'UNDETERMINED']]);
  }, TEST_TIMEOUT_MS);
});

describe('READ check jobs (T27e): recording read-evidence.json at the end of the job', () => {
  it('fails the job with READ_CHECK_RESULT_INVALID and records nothing when read-evidence.json is missing, broken or does not match', async () => {
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    for (const [name, values] of [
      ['missing', { results: [], document: 'missing' }],
      ['broken', { results: [], document: 'broken' }],
      ['other-job', { results: [], document: 'other-job' }],
      ['other-summary', { results: [], summary: { checks: 1, executed: 0 } }],
    ] as const) {
      const ended = await runReadCheckJob(name, values);
      expect(ended, name).toMatchObject({ state: 'FAILED', failureReason: 'READ_CHECK_RESULT_INVALID' });
    }
    expect(readRecentReadCheckResults(database, PROFILE_ID)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // DEF-084: 子が最後のメッセージを送ってから終わると、混雑の下で、親の `exit` が最後の `message`（`FINISHED`）より先に来ることがある。
  // `START` の直後に親をふさいで、その形を決まって作る。`FINISHED` を受けてから `read-evidence.json` を確かめる（件数の要約が合わなければ
  // `READ_CHECK_RESULT_INVALID`。`WORKER_EXITED` にしない）。
  it('checks read-evidence.json with the counts of FINISHED even when the exit of the worker arrives before its last messages (DEF-084)', async () => {
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    const ended = await runReadCheckJob('blocked-other-summary', { results: [], summary: { checks: 1, executed: 0 } }, undefined, blockingAfterStartFork(countingFork));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'READ_CHECK_RESULT_INVALID' });
    expect(readRecentReadCheckResults(database, PROFILE_ID)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('treats FINISHED without the counts of a READ check Run as a protocol violation', async () => {
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    const ended = await runReadCheckJob('no-summary', { results: [], summary: null });
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
    expect(readRecentReadCheckResults(database, PROFILE_ID)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not record the result of a definition changed during the job (the store rejects the stale revision), and records the others', async () => {
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    createDefinition('read-2', definitionFor(LOOKUP.identityDigest));
    const ended = await runReadCheckJob('changed-during', { results: ['MATCHED', 'MATCHED'], delayMs: 500 }, () => {
      expect(updateReadCheck(database, { readCheckId: 'read-2', expectedRevision: 1, definition: definitionFor(LOOKUP.identityDigest, 'y'), at: CHANGED_AT }).ok).toBe(true);
    });
    expect(ended).toMatchObject({ state: 'FINISHED', failureReason: null });
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ readCheckId, readCheckRevision }) => [readCheckId, readCheckRevision])).toEqual([['read-1', 1]]);
  }, TEST_TIMEOUT_MS);
});

// T37a（Task 37 の設計書 3.1）: 監査の段の口のある READ の確かめのジョブ。成果物の監査の段の数（`authentication`）は、IPC の要約と照らし合わせる
// （合わなければ `READ_CHECK_RESULT_INVALID`）。
describe('READ check jobs (T37a): the counts of the audit stage', () => {
  const AUTHENTICATION = Object.freeze({
    registeredReadRequestsAllowed: 1,
    tokenRefreshBlocked: 0,
    otherNonReadBlocked: 0,
    serviceUnauthorizedResponses: 2,
    serviceRequestLimitReached: false,
  });

  it('finishes when the counts of FINISHED match read-evidence.json, and fails with READ_CHECK_RESULT_INVALID when they do not', async () => {
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    const matched = await runReadCheckJob('authentication', { results: ['MATCHED'], authentication: AUTHENTICATION });
    expect(matched).toMatchObject({ state: 'FINISHED', failureReason: null });
    for (const [name, values] of [
      ['other-counts', { results: ['MATCHED'], authentication: AUTHENTICATION, summary: { checks: 1, executed: 1, authentication: { ...AUTHENTICATION, serviceUnauthorizedResponses: 3 } } }],
      ['missing-counts', { results: ['MATCHED'], authentication: AUTHENTICATION, summary: { checks: 1, executed: 1 } }],
      ['extra-counts', { results: ['MATCHED'], summary: { checks: 1, executed: 1, authentication: AUTHENTICATION } }],
    ] as const) {
      const ended = await runReadCheckJob(name, values);
      expect(ended, name).toMatchObject({ state: 'FAILED', failureReason: 'READ_CHECK_RESULT_INVALID' });
    }
  }, TEST_TIMEOUT_MS);
});

// LG-4（テストの組の設計書 3.7.3）: 前の版（`discovery-schema/1.0`）の `discovery.json` は読まない。最後の発見の成果物が前の版なら、READ の確かめの
// 対象の画面は決まらない（null）。
describe('READ check jobs (LG-4): a discovery.json of the previous version 1.0 is not read', () => {
  it('gives a null target page when the last discovery.json is of the version 1.0', async () => {
    await discover();
    const path = join(workDirectory, OUTPUT_DIRECTORY, FAKE_RUN_ID, 'discovery.json');
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...current, schemaVersion: 'discovery-schema/1.0' }));
    createDefinition('read-1', definitionFor(SEARCH.identityDigest));
    const ended = await runReadCheckJob('previous-version', { results: ['READ_CANDIDATE_DRIFTED'] });
    expect(ended.received.find((message) => message['type'] === 'START')?.['readChecks']).toEqual([
      { readCheckId: 'read-1', readCheckRevision: 1, targetPage: null, definition: definitionFor(SEARCH.identityDigest) },
    ]);
  }, TEST_TIMEOUT_MS);
});
