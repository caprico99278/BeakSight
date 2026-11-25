// DEF-200（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.4）: ログインが切れたら、自動ログインでログインし直して続ける。ジョブの管理の側の決まりを、
// 偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `chain` の `sessionLosses`）を本物の `fork` で起動して確かめる（本物のワーカーと Chromium での端から端は
// `relogin-chain-fork.test.ts`）。時刻はジョブの管理の `now` を差し替えて進め、間隔の待ちは `reloginWait` で時計を進めるだけ（長い時間は待たない）。
// - セッションの切れで終えた監査の段は、新しいジョブ（新しい jobId。同じ Run の続き `start_new = 0`）でログインし直して続ける。試しの記録は新しいジョブごとに 1 行。
// - 自動ログインの間隔（5 分）の中なら、間隔が明けるまで待ってから始める（待つ間はワーカーに何も送らない）。
// - 段の組ごとに 2 回まで（見るだけの点検と、操作さがし以降の READ の確かめは別に数える）。3 回目は止める（`SESSION_LOST`）。
// - ログインし直した後に 1 ページも読まずにまた切れたら、くり返さずに止める。
// - 手動のログインの連鎖ではログインし直さない（今のとおり止める）。書き込みの段ではログインし直さない（契約が受けない）。
// 管理データ・資格情報のフォルダ・出力先は一時のフォルダだけ。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../src/control/job/auto-login-limits.js';
import { readAutoLoginLimitInputs } from '../../src/control/job/auto-login-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_RELOGIN_STAGE_JOB_KINDS,
  validateParentToWorkerMessage,
} from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { awaitWorkersExit, createFakeWorkerJobManager, fakeWorkerValuesOf, withOutputDirectory } from '../helpers/job-test-support.js';
import { createTestCredentialStore, type TestCredentialStore } from '../helpers/test-credential-store.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { candidateOf } from '../unit/approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { PUBLIC_TARGET_PATH, TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testAuthProfile } from './control-profile-fixtures.js';

const RUN_IDS = Object.freeze(['RUN-20261104000000', 'RUN-20261104000100', 'RUN-20261104000200']);
const RELOGIN_RUN_IDS = Object.freeze(['RUN-20261104001000', 'RUN-20261104001100', 'RUN-20261104001200']);
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-relogin-chain';
const OUTPUT_DIRECTORY = 'relogin-chain-output';
const START_TIME_MS = Date.UTC(2026, 10, 4, 12, 0, 0);
const TEST_TIMEOUT_MS = 60_000;
const WAIT_LIMIT_MS = 20_000;
const WAIT_POLL_MS = 20;

const AUTOMATED_SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/admin/login', selector: '.login-error' },
      accountLocked: { pathPrefix: '/admin/locked', selector: null },
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

/** 発見の段の成果物（読んだ画面なし。ジョブの ID と Run の ID は、偽のワーカーが置き換える）。 */
const DISCOVERY_DOCUMENT: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: '__RUN_ID__' as DiscoveryDocument['runId'],
  startedAt: '20261104000000',
  finishedAt: '20261104000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [],
  omittedUnreadPages: 0,
};

let workDirectory = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;
let manager: AuditJobManager | undefined;
let nowMs = START_TIME_MS;
/** 間隔の待ちで待った時刻（`reloginWait` が受けた値）。 */
let waits: number[] = [];
const forks = createCountingFork();

/** RCA-6: GET の検索フォームが 1 つある発見の段の成果物（検索の確かめの組ができる）。 */
const SEARCH_DISCOVERY_DOCUMENT: DiscoveryDocument = {
  ...DISCOVERY_DOCUMENT,
  pages: [{
    url: `${SAMPLE_ORIGIN}/admin/items`, state: 'READ', blockedRequests: 0,
    record: {
      location: { origin: SAMPLE_ORIGIN, path: '/admin/items' }, incompleteReasons: [],
      candidates: [candidateOf(sampleForm({
        page: { origin: SAMPLE_ORIGIN, path: '/admin/items' }, formMethod: 'GET', action: sampleAction('/admin/items'), submitterText: '表示',
        fields: [sampleField('q', 'search')],
      }))],
    },
  }],
};

const fakeWorker = (chain: NonNullable<FakeWorkerValues['chain']>, document: DiscoveryDocument = DISCOVERY_DOCUMENT): FakeWorker => writeFakeWorker(
  workDirectory,
  'chain',
  fakeWorkerValuesOf({ runId: RUN_IDS[0] ?? '', otherRunId: 'RUN-20261104009999' }, {
    chain: { reloginRunIds: RELOGIN_RUN_IDS, ...chain },
    discovery: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
      documentText: JSON.stringify(document),
      summary: { ...discoverySummaryOf(document) },
      runStatus: 'COMPLETE',
    },
    readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), results: [] },
  }),
);

type ReloginWait = (untilMs: number, signal: AbortSignal) => Promise<void>;

const managerWith = (worker: FakeWorker, reloginWait?: ReloginWait): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker: forks.fork,
    now: () => new Date(nowMs),
    credentials: { root: credentials.root, store: credentials.store },
    // 間隔の待ちは、時計を進めるだけ（長い時間は待たない）。
    reloginWait: reloginWait ?? (async (untilMs) => {
      waits.push(untilMs);
      nowMs = Math.max(nowMs, untilMs);
    }),
  });
  return manager;
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

async function waitForChainEnd(jobManager: AuditJobManager, chainId: string): Promise<StageChainView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const chain = jobManager.getStageChainOfJob(chainId);
    const jobs = jobManager.listAuditJobs();
    if (chain !== null && chain.state !== 'RUNNING' && jobs.every((job) => job.finishedAt !== null) && jobManager.runningWorkerCount() === 0) {
      return chain;
    }
    if (Date.now() > deadline) {
      throw new Error(`the chain did not end: ${JSON.stringify(chain)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** ジョブを作った順に（同じ時刻の行は一覧の順を逆にした順）。 */
const jobsInOrder = (jobManager: AuditJobManager): readonly AuditJobView[] => [...jobManager.listAuditJobs()].reverse();

const startChain = async (jobManager: AuditJobManager): Promise<string> => {
  const started = await jobManager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: false });
  if (!started.ok) {
    throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
  }
  return started.job.jobId;
};

const relogins = (worker: FakeWorker): readonly Record<string, unknown>[] => worker.received().filter((message) => message['type'] === 'RELOGIN_STAGE');

const automatedProfile = (): SiteProfile => ({ ...testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' });

const createDefinition = (): void => {
  expect(createReadCheck(database, {
    readCheckId: 'read-items', profileId: PROFILE_ID,
    definition: { targetPagePath: '/admin/items', parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] }, at: '20261104000000',
  }).ok).toBe(true);
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-relogin-chain-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  credentials = await createTestCredentialStore();
  nowMs = START_TIME_MS;
  waits = [];
  forks.reset();
  expect(createProfile(database, automatedProfile(), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, AUTOMATED_SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
  await credentials.store.register({ profileId: PROFILE_ID, loginOrigin: TEST_ORIGIN, username: 'example-user', password: 'example-password' });
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  await credentials.remove();
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('DEF-200: the chained run signs in again after the sign-in is lost', () => {
  it('continues the audit as a new job of the same Run after the automated login waited for the interval, and finishes the chain', async () => {
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [1] });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);

    expect(chain).toMatchObject({ state: 'FINISHED', stopReason: null });
    const [relogin] = relogins(worker);
    const reloginJobId = String(relogin?.['jobId']);
    const discoveryJobId = chain.stages[1]?.jobId ?? '';
    const jobs = [chainId, reloginJobId, discoveryJobId].map((jobId) => jobManager.getAuditJob(jobId));
    // 監査の段は 2 つのジョブ（前のジョブは切れて PARTIAL、後のジョブは同じ Run の続き `start_new = 0` で COMPLETE）。発見の段が続いた。
    expect(jobs.map((job) => [job?.jobKind, job?.state, job?.runId, job?.resultRunStatus, job?.startNew])).toEqual([
      ['AUDIT', 'FINISHED', RUN_IDS[0], 'PARTIAL', false],
      ['AUDIT', 'FINISHED', RUN_IDS[0], 'COMPLETE', false],
      ['DISCOVERY', 'FINISHED', RUN_IDS[1], 'COMPLETE', true],
    ]);
    expect(chain.stages[0]?.jobId).toBe(reloginJobId);
    expect(relogins(worker).map((message) => [message['jobKind'], message['count']])).toEqual([['AUDIT', 1]]);
    // 自動ログインの間隔（最初の試しから 5 分）が明けるまで待ってから始めた（試しの記録は 2 行。新しいジョブにも結ぶ）。
    expect(waits).toEqual([START_TIME_MS + AUTO_LOGIN_MIN_INTERVAL_MS]);
    expect(readAutoLoginLimitInputs(database, PROFILE_ID, new Date(nowMs)).attempts).toHaveLength(2);
    expect(jobs[1]?.autoLoginAttempt?.result).toBe('SUCCEEDED');
  }, TEST_TIMEOUT_MS);

  it('cuts the interval wait short when the chain is stopped during it, does not sign in again, and ends the job (USER_STOPPED)', async () => {
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [1] });
    let chainId = '';
    let aborted = false;
    // 待ちの間に止める。待ちは止める知らせでだけ終わる（知らせが来なければ、時計を進めずに時間切れで返す）。
    const jobManager = managerWith(worker, (untilMs, signal) => new Promise((resolvePromise) => {
      waits.push(untilMs);
      const fallback = setTimeout(resolvePromise, WAIT_LIMIT_MS / 2);
      signal.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(fallback);
        resolvePromise();
      }, { once: true });
      expect(manager?.stopAuditJob(chainId)).toMatchObject({ ok: true });
    }));
    chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);

    expect(aborted).toBe(true);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    expect(relogins(worker)).toEqual([]);
    expect(waits).toHaveLength(1);
    expect(jobsInOrder(jobManager).map(({ jobKind, state }) => [jobKind, state])).toEqual([['AUDIT', 'FINISHED']]);
    expect(readAutoLoginLimitInputs(database, PROFILE_ID, new Date(nowMs)).attempts).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('signs in again twice per stage group and stops at the third loss of the audit stage (SESSION_LOST)', async () => {
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [3] });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));

    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SESSION_LOST' });
    expect(relogins(worker).map((message) => message['count'])).toEqual([1, 2]);
    expect(jobsInOrder(jobManager).map(({ jobKind, resultRunStatus }) => [jobKind, resultRunStatus]))
      .toEqual([['AUDIT', 'PARTIAL'], ['AUDIT', 'PARTIAL'], ['AUDIT', 'PARTIAL']]);
    expect(waits).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it('counts the READ check separately from the audit (two re-logins in the audit, then two more in the READ check, and stops at the third)', async () => {
    createDefinition();
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [2, 0, 3] });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));

    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SESSION_LOST' });
    expect(relogins(worker).map((message) => [message['jobKind'], message['count']]))
      .toEqual([['AUDIT', 1], ['AUDIT', 2], ['READ_CHECK', 1], ['READ_CHECK', 2]]);
    // READ の確かめは、ログインし直したら最初からやり直す（新しい Run）。
    const reads = jobsInOrder(jobManager).filter(({ jobKind }) => jobKind === 'READ_CHECK');
    expect(reads.map(({ runId, startNew }) => [runId, startNew])).toEqual([[RUN_IDS[2], true], [RELOGIN_RUN_IDS[0], true], [RELOGIN_RUN_IDS[1], true]]);
  }, TEST_TIMEOUT_MS);

  // RCA-6（検索の確かめの設計書 2.3）: READ の確かめの段のログインし直しでは、前のジョブで確かめた検索の確かめの組を除いた残りだけを渡す（順は保つ）。
  it('passes only the search checks not yet checked to the READ check stage started again after the re-login', async () => {
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [0, 0, 1] }, SEARCH_DISCOVERY_DOCUMENT);
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));

    expect(chain).toMatchObject({ state: 'FINISHED' });
    const keysOf = (message: Record<string, unknown> | undefined): readonly string[] =>
      ((message?.['searchChecks'] ?? []) as readonly { readonly key: string }[]).map(({ key }) => key);
    const stage = worker.received().find((message) => message['type'] === 'NEXT_STAGE' && message['jobKind'] === 'READ_CHECK');
    expect(keysOf(stage).length).toBeGreaterThan(1);
    expect(relogins(worker).map((message) => [message['jobKind'], keysOf(message)])).toEqual([['READ_CHECK', keysOf(stage).slice(1)]]);
  });

  // DEF-200（ユーザーの指示「回数の上限は点検と操作さがしで共有せず、操作さがしの段階で上限2回にカウントをリセットすること」）: 監査で 2 回ログインし直した後でも、
  // 操作さがしで、また 2 回までログインし直せる（同じ Run の続き）。操作さがしの 3 回目で止まる。
  it('signs in again twice in the audit and twice more in the discovery (the count is reset), and stops at the third loss of the discovery', async () => {
    const pageOf = (index: number): DiscoveryDocument['pages'][number] => ({
      url: `${TEST_ORIGIN}/admin/page-${String(index)}`, state: 'READ',
      record: { location: { origin: TEST_ORIGIN, path: `/admin/page-${String(index)}` }, incompleteReasons: [], candidates: [] }, blockedRequests: 0,
    } as DiscoveryDocument['pages'][number]);
    // 回ごとに読んだ画面が 1 つずつ増える（ログインし直した後に読んだ）。
    const attempts = [1, 2, 3, 4].map((count) => {
      const document: DiscoveryDocument = {
        ...DISCOVERY_DOCUMENT, runStatus: 'PARTIAL', endReason: 'AUTH_SESSION_LOST', pages: Array.from({ length: count }, (_value, index) => pageOf(index)),
      };
      return { documentText: JSON.stringify(document), summary: { ...discoverySummaryOf(document) } };
    });
    const worker = writeFakeWorker(workDirectory, 'chain', fakeWorkerValuesOf({ runId: RUN_IDS[0] ?? '', otherRunId: 'RUN-20261104009999' }, {
      chain: { runIds: RUN_IDS, reloginRunIds: RELOGIN_RUN_IDS, sessionLosses: [2, 3] },
      discovery: {
        outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
        documentText: JSON.stringify(DISCOVERY_DOCUMENT),
        summary: { ...discoverySummaryOf(DISCOVERY_DOCUMENT) },
        runStatus: 'COMPLETE',
        attempts,
      },
      readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), results: [] },
    }));
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));

    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SESSION_LOST' });
    expect(relogins(worker).map((message) => [message['jobKind'], message['count']]))
      .toEqual([['AUDIT', 1], ['AUDIT', 2], ['DISCOVERY', 1], ['DISCOVERY', 2]]);
    // 切れた回の結果も、今のとおり読めて記録した（どの段のジョブも失敗にしていない）。
    expect(jobManager.listAuditJobs().filter(({ state }) => state === 'FAILED')).toEqual([]);
    // 操作さがしのやり直しは、同じ Run の続き（`start_new = 0`）。
    const discoveries = jobManager.listAuditJobs().filter(({ jobKind }) => jobKind === 'DISCOVERY');
    expect(discoveries.map(({ runId, startNew }) => [runId, startNew]).sort((a, b) => Number(a[1]) - Number(b[1])))
      .toEqual([[RUN_IDS[1], false], [RUN_IDS[1], false], [RUN_IDS[1], true]].sort((a, b) => Number(a[1]) - Number(b[1])));
  }, TEST_TIMEOUT_MS);

  it('does not sign in again when it was lost again without reading a page after the re-login', async () => {
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [3], stallAfterRelogin: true });
    const jobManager = managerWith(worker);
    const chain = await waitForChainEnd(jobManager, await startChain(jobManager));

    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SESSION_LOST' });
    expect(relogins(worker)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it('does not sign in again in a chained run with the manual login', async () => {
    const manualProfileId = 'example-relogin-manual';
    expect(createProfile(database, testAuthProfile(manualProfileId, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const manualSetup: AuthSetup = { ...AUTOMATED_SETUP, profileId: manualProfileId, maxLoginAttempts: 2, automatedLogin: null };
    expect(saveAuthSetup(database, manualSetup, { resolveContext: resolveTestContext }).ok).toBe(true);
    const worker = fakeWorker({ runIds: RUN_IDS, sessionLosses: [1] });
    const jobManager = managerWith(worker);
    const started = await jobManager.startStageChain({ profileId: manualProfileId, expectedRevision: MIN_PROFILE_REVISION, startNew: false });
    if (!started.ok) {
      throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
    }
    const chain = await waitForChainEnd(jobManager, started.job.jobId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'SESSION_LOST' });
    expect(relogins(worker)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not accept the re-login of a write stage (the contract has only the audit, the discovery and the READ check)', () => {
    expect([...WORKER_RELOGIN_STAGE_JOB_KINDS]).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    for (const jobKind of ['WRITE_CREATE', 'WRITE_UPDATE']) {
      expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'RELOGIN_STAGE', jobId: 'job-1', jobKind, count: 1 }).ok).toBe(false);
    }
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'RELOGIN_STAGE', jobId: 'job-1', jobKind: 'AUDIT', count: 3 }).ok).toBe(false);
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'RELOGIN_STAGE', jobId: 'job-1', jobKind: 'AUDIT', count: 1 }).ok).toBe(true);
  });
});

