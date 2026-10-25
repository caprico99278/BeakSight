// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1、5 章の 2026-10-22 の FM2d の Blocker の行）: まとめて実行の、ジョブの管理の側の決まり
// （`startStageChain` と段の進め方）を、偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `chain`）を本物の `fork` で起動して確かめる（本物のワーカーと Chromium
// での端から端は `stage-chain-fork-default.test.ts`・`stage-chain-fork-cli.test.ts`。中身は `stage-chain-fork-cases.ts`）。
// - 段の並びはモードで決まる（`TEST_AUTH_PASSIVE`: 監査 → 発見 → READ、`TEST_APPROVED_WRITE`: 発見 → READ、公開の監査: 拒む）。段ごとにジョブの行を作る。
// - READ の段の対象の画面は、発見の段の索引を記録した後に決めて、`NEXT_STAGE` で渡す。定義が 0 件なら READ を行わない（失敗にしない）。
// - 手動のログインの自動の登録（改訂を進める）は、連鎖の最後に 1 回だけ（記録は最初の段のジョブ）。途中の段のジョブの行は、始めた時の改訂のまま。
// - 止める理由: 止める要求（連鎖の全体を止める）、段の未完了の理由（サービスの要求の上限など）、改訂の変化。止めたら次の段を始めない（`CHAIN_END`）。
// - 段の間に、ほかのジョブを始められない。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { AuditJobManager, AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { createReadCheck, readRecentReadCheckResults } from '../../src/control/job/read-check-store.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, updateProfile } from '../../src/control/store/profile-store.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  withOutputDirectory,
} from '../helpers/job-test-support.js';
import { sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { PUBLIC_TARGET_PATH, TEST_ORIGIN, TEST_TARGET_PATH, publicProfile, resolveTestContext, testAuthProfile, testWriteProfile } from './control-profile-fixtures.js';

const RUN_IDS = Object.freeze(['RUN-20261022000000', 'RUN-20261022000100', 'RUN-20261022000200']);
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-stage-chain';
const OUTPUT_DIRECTORY = 'stage-chain-output';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TEST_TIMEOUT_MS = 60_000;
const WAIT_LIMIT_MS = 20_000;
const WAIT_POLL_MS = 20;

/** 手動のログインの段で通した送信の一覧（自動の登録の材料。値を持たない）。 */
const PASSED_REQUESTS = Object.freeze({
  requests: [
    { origin: SERVICE_ORIGIN, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] } },
  ],
  unlisted: 0,
});
const LOGIN_OBSERVATION = Object.freeze({ storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } });

const setupFor = (profileRevision: number): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision,
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
const SEARCH: DiscoveryCandidate = ((discovered: DiscoveredCandidate) => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }),
  ...computeCandidateDigests(discovered),
}))(sampleForm({
  page: { origin: TEST_ORIGIN, path: '/admin/items' }, formMethod: 'GET', action: sampleAction('/admin/items', [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));

/** 発見の段の成果物（ジョブの ID と Run の ID は、偽のワーカーが置き換える）。 */
const DISCOVERY_DOCUMENT: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: '__RUN_ID__' as DiscoveryDocument['runId'],
  startedAt: '20261022000000',
  finishedAt: '20261022000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [
    { url: `${TEST_ORIGIN}/admin/items`, state: 'READ', record: { location: { origin: TEST_ORIGIN, path: '/admin/items' }, incompleteReasons: [], candidates: [SEARCH] }, blockedRequests: 0 },
  ],
  omittedUnreadPages: 0,
};

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

const fakeWorker = (chain: NonNullable<FakeWorkerValues['chain']>, extra: Partial<FakeWorkerValues> = {}): FakeWorker => writeFakeWorker(
  workDirectory,
  'chain',
  fakeWorkerValuesOf({ runId: RUN_IDS[0] ?? '', otherRunId: 'RUN-20261022009999' }, {
    chain,
    discovery: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
      documentText: JSON.stringify(DISCOVERY_DOCUMENT),
      summary: { ...discoverySummaryOf(DISCOVERY_DOCUMENT) },
      runStatus: 'COMPLETE',
    },
    readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), results: [] },
    ...extra,
  }),
);

const managerWith = (worker: FakeWorker, forkWorker: AuditWorkerForker = forks.fork): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker,
  });
  return manager;
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

/** 連鎖が終わり、ワーカーが終わるまで待つ。 */
async function waitForChainEnd(jobManager: AuditJobManager, chainId: string): Promise<StageChainView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const chain = jobManager.getStageChainOfJob(chainId);
    const jobs = (chain?.stages ?? []).flatMap(({ jobId }) => (jobId === null ? [] : [jobManager.getAuditJob(jobId)]));
    if (chain !== null && chain.state !== 'RUNNING' && jobs.every((job) => job?.finishedAt !== null) && jobManager.runningWorkerCount() === 0) {
      return chain;
    }
    if (Date.now() > deadline) {
      throw new Error(`the chain did not end: ${JSON.stringify(chain)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('the value did not come');
    }
    await sleep(WAIT_POLL_MS);
  }
}

const jobsOf = (jobManager: AuditJobManager, chain: StageChainView): readonly AuditJobView[] =>
  chain.stages.flatMap(({ jobId }) => {
    const job = jobId === null ? null : jobManager.getAuditJob(jobId);
    return job === null ? [] : [job];
  });

const startChain = async (jobManager: AuditJobManager, expectedRevision = MIN_PROFILE_REVISION): Promise<string> => {
  const started = await jobManager.startStageChain({ profileId: PROFILE_ID, expectedRevision, startNew: false });
  if (!started.ok) {
    throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
  }
  return started.job.jobId;
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-stage-chain-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const createAuthProfile = (mode: 'AUTH' | 'WRITE' = 'AUTH'): void => {
  const profile = mode === 'AUTH' ? testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION) : testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION);
  expect(createProfile(database, profile, { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, setupFor(MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
};

const createDefinition = (): void => {
  expect(createReadCheck(database, {
    readCheckId: 'read-items', profileId: PROFILE_ID, definition: { targetIdentityDigest: SEARCH.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] }, at: '20261022000000',
  }).ok).toBe(true);
};

describe('FM2d: the chained run in the job management', () => {
  it('runs the audit, the discovery and the READ check as three job rows, gives the READ target from the discovery stage, and registers the login once at the end', async () => {
    createAuthProfile();
    createDefinition();
    const worker = fakeWorker({ runIds: RUN_IDS }, { loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION } });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);

    expect(chain).toMatchObject({ chainId, profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, state: 'FINISHED', stopReason: null });
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'DONE']]);
    const jobs = jobsOf(jobManager, chain);
    expect(jobs.map(({ jobKind, state, profileRevision, runId }) => [jobKind, state, profileRevision, runId]))
      .toEqual([['AUDIT', 'FINISHED', 1, RUN_IDS[0]], ['DISCOVERY', 'FINISHED', 1, RUN_IDS[1]], ['READ_CHECK', 'FINISHED', 1, RUN_IDS[2]]]);
    // どの段のジョブからも、同じ連鎖が見える。
    for (const job of jobs) {
      expect(jobManager.getStageChainOfJob(job.jobId)?.chainId).toBe(chainId);
    }
    // 親 → 子: START は 1 回（連鎖の並びつき）。次の段は NEXT_STAGE。READ の対象の画面は、発見の段の索引から決めた。
    const received = worker.received();
    expect(received.filter((message) => message['type'] === 'START')).toHaveLength(1);
    expect(received.find((message) => message['type'] === 'START')?.['chain']).toEqual({ stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] });
    const nextStages = received.filter((message) => message['type'] === 'NEXT_STAGE');
    expect(nextStages.map((message) => [message['jobKind'], message['jobId']])).toEqual([['DISCOVERY', jobs[1]?.jobId], ['READ_CHECK', jobs[2]?.jobId]]);
    expect((nextStages[1]?.['readChecks'] as readonly { readonly targetPage: unknown }[] | undefined)?.map(({ targetPage }) => targetPage))
      .toEqual([{ origin: TEST_ORIGIN, path: '/admin/items' }]);
    expect(readRecentReadCheckResults(database, PROFILE_ID).map(({ jobId }) => jobId)).toEqual([jobs[2]?.jobId]);
    // 自動の登録は、連鎖の最後に 1 回だけ（最初の段のジョブの記録。ほかの段にはログインの段がない）。
    const registered = await waitFor(() => jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration);
    expect(registered).toMatchObject({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1 });
    expect(jobs.slice(1).map(({ jobId }) => jobManager.getAuditJob(jobId)?.loginStage ?? null)).toEqual([null, null]);
    expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION + 1);
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('does not run the READ check without a definition, and ends the chain without a failure', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(chain).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    expect(jobsOf(jobManager, chain).map(({ jobKind, state }) => [jobKind, state])).toEqual([['AUDIT', 'FINISHED'], ['DISCOVERY', 'FINISHED']]);
    expect(worker.received().filter((message) => message['type'] === 'CHAIN_END')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('chains only the discovery and the READ check in TEST_APPROVED_WRITE, and rejects the public profile', async () => {
    createAuthProfile('WRITE');
    const jobManager = managerWith(fakeWorker({ runIds: RUN_IDS }));
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    expect(createProfile(database, publicProfile('example-public-chain', MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(await jobManager.startStageChain({ profileId: 'example-public-chain', expectedRevision: MIN_PROFILE_REVISION, startNew: false }))
      .toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
  }, TEST_TIMEOUT_MS);

  it('stops the chain by the closed list of the stage reasons (the service request limit), and does not start the next stage', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS, runStatuses: ['PARTIAL'], reasonCodes: [['MAX_PAGES_REACHED', 'SERVICE_REQUEST_LIMIT_REACHED']] });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SERVICE_REQUEST_LIMIT_REACHED' });
    // FM2R の I-5: 連鎖が止まった段に印（`STOPPED`）を付ける。
    expect(chain.stages.map(({ state }) => state)).toEqual(['STOPPED', 'NOT_STARTED', 'NOT_STARTED']);
    expect(jobManager.listAuditJobs().map(({ jobKind, state }) => [jobKind, state])).toEqual([['AUDIT', 'FINISHED']]);
    expect(worker.received().filter((message) => message['type'] === 'NEXT_STAGE')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('continues after PARTIAL by the page limit and page level reasons', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS, runStatuses: ['PARTIAL'], reasonCodes: [['MAX_PAGES_REACHED', 'NAVIGATION_FAILED']] });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(chain).toMatchObject({ state: 'FINISHED' });
    expect(chain.stages.map(({ state }) => state)).toEqual(['DONE', 'DONE', 'NOT_NEEDED']);
  }, TEST_TIMEOUT_MS);

  it('stops the whole chain on the stop of a stage, and does not start the next stage', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS, holdStage: 0 });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitFor(() => jobManager.getAuditJob(chainId)?.runId);
    expect(jobManager.stopAuditJob(chainId).ok).toBe(true);
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    expect(chain.stages.map(({ state }) => state)).toEqual(['STOPPED', 'NOT_STARTED', 'NOT_STARTED']);
    expect(jobManager.listAuditJobs()).toHaveLength(1);
    expect(worker.received().filter((message) => message['type'] === 'NEXT_STAGE')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // FM2R の I-2（レビューの X2・X2b）: 段の `FINISHED` の直後（次の段へ進めている間・進めた直後）の「やめる」を、古い段の ID で押しても受け、次の段を
  // 始めない（始めていれば、その段を止める）。
  it.each([
    ['setImmediate', (stop: () => void) => setImmediate(stop)],
    ['5 ms', (stop: () => void) => setTimeout(stop, 5)],
    ['50 ms', (stop: () => void) => setTimeout(stop, 50)],
  ] as const)('accepts the stop with the old stage id right after the FINISHED of a stage (%s), and stops the whole chain', async (_timing, schedule) => {
    createAuthProfile();
    createDefinition();
    // 発見の段は、止める要求まで待つ（始まっていれば、止める要求で PARTIAL で終える）。
    const worker = fakeWorker({ runIds: RUN_IDS, holdStage: 1 });
    let stopResult: { readonly ok: boolean } | null = null;
    const chainIdHolder = { value: '' };
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolvePromise) => {
      resolveStopped = resolvePromise;
    });
    // 子の process のメッセージの受け手で、監査の段の FINISHED の直後に、古い段（監査の段）の ID で止める（止めるのは、ジョブの管理の受け手が同期の処理を
    // 終えた後の、決まった時機）。
    const jobManager = managerWith(worker, (modulePath, args, options) => {
      const child = forks.fork(modulePath, args, options);
      let seen = false;
      child.on('message', (message: unknown) => {
        if (!seen && typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'FINISHED') {
          seen = true;
          schedule(() => {
            stopResult = jobManager.stopAuditJob(chainIdHolder.value);
            resolveStopped();
          });
        }
      });
      return child;
    });
    const chainId = await startChain(jobManager);
    chainIdHolder.value = chainId;
    await stopped;
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(stopResult).toMatchObject({ ok: true });
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    // 発見の段を始めていれば止めた（READ の段は始めない）。
    expect(chain.stages[2]?.state).toBe('NOT_STARTED');
    expect(jobManager.listAuditJobs().every(({ jobKind }) => jobKind !== 'READ_CHECK')).toBe(true);
  }, TEST_TIMEOUT_MS);

  // FM2R の I-5: 最後の段で止めた・失敗したときも「最後まで行った」と出さない（止める要求なら USER_STOPPED、FINISHED がなければ STAGE_FAILED）。止まった段に
  // 印（`STOPPED`）を付ける。
  it('ends with USER_STOPPED when the last stage is stopped, and marks the stopped stage', async () => {
    createAuthProfile();
    createDefinition();
    const worker = fakeWorker({ runIds: RUN_IDS, holdStage: 2 });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const readJobId = await waitFor(() => jobManager.getStageChainOfJob(chainId)?.stages[2]?.jobId);
    await waitFor(() => jobManager.getAuditJob(readJobId)?.runId);
    expect(jobManager.stopAuditJob(readJobId).ok).toBe(true);
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    expect(chain.stages.map(({ state }) => state)).toEqual(['DONE', 'DONE', 'STOPPED']);
  }, TEST_TIMEOUT_MS);

  it('ends with STAGE_FAILED when the worker ends in the last stage without FINISHED', async () => {
    createAuthProfile();
    createDefinition();
    const worker = fakeWorker({ runIds: RUN_IDS, holdStage: 2 });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const readJobId = await waitFor(() => jobManager.getStageChainOfJob(chainId)?.stages[2]?.jobId);
    await waitFor(() => jobManager.getAuditJob(readJobId)?.runId);
    children.at(-1)?.kill();
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'STAGE_FAILED' });
    expect(chain.stages.map(({ state }) => state)).toEqual(['DONE', 'DONE', 'STOPPED']);
  }, TEST_TIMEOUT_MS);

  // FM2R 確かめ直しの R-1: 最後の段が `FINISHED` を送ったうえで失敗した（Safety の違反・`FAILED`）ときも、「最後まで行った」と出さない。最後の段の終わりも、
  // 途中の段と同じ進むかの判定で決め、止める理由で `STOPPED`（止まった段の印つき）にする。
  it.each([
    ['the safety violation', 'ABORTED_BY_SAFETY', ['SAFETY_VIOLATION_ABORT'], 'SAFETY_VIOLATION'],
    ['FAILED', 'FAILED', [], 'STAGE_FAILED'],
  ] as const)('ends with the stop reason when the last stage sends FINISHED with %s', async (_name, runStatus, codes, stopReason) => {
    createAuthProfile();
    createDefinition();
    const worker = fakeWorker({ runIds: RUN_IDS, runStatuses: ['COMPLETE', 'COMPLETE', runStatus], reasonCodes: [[], [], codes] });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason });
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'STOPPED']]);
  }, TEST_TIMEOUT_MS);

  it('stops the chain when the profile revision changed during a stage (the chain is bound to the revision at the start)', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS, finishDelayMs: 1_000 });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitFor(() => jobManager.getAuditJob(chainId)?.runId);
    const stored = getProfile(database, PROFILE_ID);
    expect(updateProfile(database, { profile: { ...stored?.profile, revision: MIN_PROFILE_REVISION + 1 }, expectedRevision: MIN_PROFILE_REVISION }, { resolveContext: resolveTestContext }).ok)
      .toBe(true);
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'PROFILE_REVISION_CHANGED' });
    expect(jobManager.listAuditJobs()).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('does not let another job start between the stages', async () => {
    createAuthProfile();
    const worker = fakeWorker({ runIds: RUN_IDS, finishDelayMs: 200 });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const attempts: string[] = [];
    while (jobManager.getStageChainOfJob(chainId)?.state === 'RUNNING') {
      const result = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (result.ok) {
        expect(jobManager.getStageChainOfJob(chainId)?.state, 'a job started while the chain was running').not.toBe('RUNNING');
        break;
      }
      attempts.push(result.reason);
      await sleep(5);
    }
    expect(attempts.length).toBeGreaterThan(10);
    expect(new Set(attempts)).toEqual(new Set(['JOB_ALREADY_ACTIVE']));
    await waitForChainEnd(jobManager, chainId);
  }, TEST_TIMEOUT_MS);
});
