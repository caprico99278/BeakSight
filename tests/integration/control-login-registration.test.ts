// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D4・D5、4.1.3 の 1・2）: まとめて実行の、ログインの直後の登録と自動ログインへの
// 切り替えを、ジョブの管理の側で確かめる（偽のワーカー `tests/helpers/fake-audit-worker.ts` の `chain` を本物の `fork` で起動する。本物のワーカーと Chromium での
// 端から端は `login-registration-fork.test.ts`）。
// - `START` の `loginRegistration`: 手動のログインのプロファイルのまとめて実行だけ。受け取りの根は、希望が自動ログインで、資格情報のファイルがないときだけ。
// - 書く順（4.1.3 の 1）: 親が登録と切り替えを組み立てて確かめる → 許し（`CREDENTIAL_SAVE_ALLOWED`）→ ワーカーが書いて知らせる → 親が 1 回の保存 → 新しい設定
//   （`LOGIN_REGISTERED`）。3 つのセレクタがそろわないときは許しを送らず、登録だけ保存する（手動のまま）。
// - 連鎖は、親が自分で進めた改訂を基準として受け入れる（後の段のジョブの行は、登録の後の改訂）。
// 資格情報のファイルの部品は、目印のファイルで「書いたか」を表す偽の部品（値を持たない）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { CredentialMetadata, CredentialStore } from '../../src/control/credentials/credential-store.js';
import type { AuditJobManager, AuditJobTiming } from '../../src/control/job/audit-job-manager.js';
import { readRecentCredentialEvents } from '../../src/control/job/auto-login-store.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION, entryCheckSummaryOf, type EntryCheckDocument } from '../../src/control/entry-check.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { writeFakeWorker, type FakeWorker } from '../helpers/fake-audit-worker.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
} from '../helpers/job-test-support.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testAuthProfile } from './control-profile-fixtures.js';

const RUN_IDS = Object.freeze(['RUN-20261027000000', 'RUN-20261027000100', 'RUN-20261027000200']);
const PROFILE_ID = 'example-login-registration';
const OUTPUT_DIRECTORY = 'login-registration-output';
const TEST_TIMEOUT_MS = 60_000;
const WAIT_LIMIT_MS = 20_000;
const WAIT_POLL_MS = 20;
const LOGIN_FIELDS = Object.freeze({ username: '#user', password: '#pass', submit: '#go' });
const CARRIED_BY = Object.freeze({ origin: TEST_ORIGIN, path: '/admin/login' });

/** 成功の条件のない設定（開始の URL がログインの画面のときの案）。 */
const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '', selector: null },
  sessionLostCondition: { pathPrefix: '/admin/login' },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/login'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 発見の段の成果物（候補なし。ジョブの ID と Run の ID は、偽のワーカーが置き換える）。 */
const DISCOVERY_DOCUMENT: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: '__RUN_ID__' as DiscoveryDocument['runId'],
  startedAt: '20261027000000',
  finishedAt: '20261027000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [],
  omittedUnreadPages: 0,
};

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

/**
 * OP-F（OP-REV2 の m-3）: 目印のファイルのメタデータの上書き（省略は、改訂 1、作った日時は目印のファイルを書いた日時）。資格情報の画面がほかの時に書いたファイルのふりに使う。
 */
const markerMetadata: { override: Partial<CredentialMetadata> | null } = { override: null };

/** 目印のファイルで「書いたか」を表す偽の資格情報のファイルの部品（値を持たない）。作った日時は、目印のファイルを書いた日時（UTC の 14 桁）。 */
const markerStore = (markerPath: string): CredentialStore => {
  const metadata = (): CredentialMetadata => {
    const written = formatCompactUtcTimestamp(statSync(markerPath).mtime, 'marker time');
    return {
      profileId: PROFILE_ID, loginOrigin: TEST_ORIGIN, credentialRevision: 1, createdAt: written, updatedAt: written,
      lastChangeKind: 'CREATED', protection: 'DPAPI_CURRENT_USER', ...(markerMetadata.override ?? {}),
    };
  };
  const unused = (): never => {
    throw new Error('not used in this test');
  };
  return {
    register: unused, replaceAll: unused, change: unused, decrypt: unused, removeTemporaryFiles: unused,
    readMetadata: async () => (existsSync(markerPath) ? metadata() : null),
    remove: async () => {
      const existed = existsSync(markerPath);
      rmSync(markerPath, { force: true });
      return existed;
    },
    checkProtection: async () => 'AVAILABLE',
  } as unknown as CredentialStore;
};

const fakeWorker = (options: {
  readonly loginFields?: object;
  readonly capture?: boolean;
  readonly saved?: boolean;
  /** OP-F（I-1）: 目印を書いた直後に、`CREDENTIAL_SAVED` を送らずに終わる。 */
  readonly exitAfterWriting?: boolean;
  /** OP-F（I-1）: 目印を書いてから、`CREDENTIAL_SAVED` を送るまで待つ時間。 */
  readonly savedDelayMs?: number;
  /** OP-F（M-2）: 値を運んだ送り先（省略は、フォームの送信先 `CARRIED_BY`）。 */
  readonly carriedBy?: { readonly origin: string; readonly path: string };
}): FakeWorker => writeFakeWorker(
  workDirectory,
  'chain',
  fakeWorkerValuesOf({ runId: RUN_IDS[0] ?? '', otherRunId: 'RUN-20261027009999' }, {
    chain: {
      runIds: RUN_IDS,
      capture: {
        carriedBy: options.capture === false ? null : options.carriedBy ?? CARRIED_BY,
        credentialMarkerPath: join(workDirectory, 'credential-marker'),
        ...(options.saved === undefined ? {} : { saved: options.saved }),
        ...(options.exitAfterWriting === undefined ? {} : { exitAfterWriting: options.exitAfterWriting }),
        ...(options.savedDelayMs === undefined ? {} : { savedDelayMs: options.savedDelayMs }),
      },
    },
    discovery: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
      documentText: JSON.stringify(DISCOVERY_DOCUMENT),
      summary: { ...discoverySummaryOf(DISCOVERY_DOCUMENT) },
      runStatus: 'COMPLETE',
    },
    readCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY), results: [] },
    loginStage: {
      loginObservation: {
        successPathPrefix: '/admin/dashboard',
        ...(options.loginFields === undefined ? {} : { loginFields: options.loginFields }),
      },
    },
  }),
);

const managerWith = (worker: FakeWorker, timing?: Partial<AuditJobTiming>): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, OUTPUT_DIRECTORY),
    forkWorker: forks.fork,
    credentials: { root: workDirectory, store: markerStore(join(workDirectory, 'credential-marker')) },
    ...(timing === undefined ? {} : { timing }),
  });
  return manager;
};

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

const startChain = async (jobManager: AuditJobManager): Promise<string> => {
  const expectedRevision = getProfile(database, PROFILE_ID)?.profile.revision ?? MIN_PROFILE_REVISION;
  const started = await jobManager.startStageChain({ profileId: PROFILE_ID, expectedRevision, startNew: false });
  if (!started.ok) {
    throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
  }
  return started.job.jobId;
};

const createManualProfile = (loginPreference?: 'MANUAL_EVERY_TIME'): void => {
  const profile = { ...testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), ...(loginPreference === undefined ? {} : { loginPreference }) };
  expect(createProfile(database, profile, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-login-registration-'));
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), JSON.stringify({ target: { id: 'example-test' } }), 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
});

afterEach(async () => {
  markerMetadata.override = null;
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const typesOf = (worker: FakeWorker): readonly unknown[] => worker.received().map((message) => message['type']);

describe('OP-1: the registration and the switch right after the manual login (job management)', () => {
  it('allows the worker to write, then saves the registration and the switch at once, and chains the next stages on the new revision', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);

    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration).toEqual({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, addedServiceOrigins: [], automatedLogin: 'SWITCHED' });
    const start = worker.received().find((message) => message['type'] === 'START');
    expect((start?.['authentication'] as { readonly loginRegistration?: unknown } | undefined)?.loginRegistration).toEqual({ credentialRoot: workDirectory });
    // 許し → 新しい設定の順（許しは 1 回）。
    expect(typesOf(worker).filter((type) => type === 'CREDENTIAL_SAVE_ALLOWED' || type === 'LOGIN_REGISTERED' || type === 'LOGIN_REGISTRATION_SKIPPED'))
      .toEqual(['CREDENTIAL_SAVE_ALLOWED', 'LOGIN_REGISTERED']);
    const profile = getProfile(database, PROFILE_ID)?.profile;
    expect(profile?.auth).toBe('AUTOMATED_LOGIN');
    expect(profile?.revision).toBe(MIN_PROFILE_REVISION + 1);
    const setup = getAuthSetup(database, PROFILE_ID)?.setup;
    expect(setup?.automatedLogin).toMatchObject({ usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go' });
    expect(setup?.successCondition).toEqual({ pathPrefix: '/admin/dashboard', selector: null });
    expect(setup?.auditPathPrefixes).toEqual(['/admin/dashboard']);
    expect(readRecentCredentialEvents(database, PROFILE_ID).map(({ kind }) => kind)).toEqual(['CREATED']);
    // 連鎖は、親が進めた改訂を基準に進む（後の段のジョブの行は登録の後の改訂）。
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    expect(chain).toMatchObject({ state: 'FINISHED', stopReason: null, profileRevision: MIN_PROFILE_REVISION + 1 });
    const jobs = chain.stages.flatMap(({ jobId }) => (jobId === null ? [] : [jobManager.getAuditJob(jobId)]));
    expect(jobs.map((job) => job?.profileRevision)).toEqual([MIN_PROFILE_REVISION, MIN_PROFILE_REVISION + 1]);
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration).toMatchObject({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, automatedLogin: 'SWITCHED' });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('does not allow the worker to write when the three selectors are not all known, saves the registration only and keeps the manual login', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: { username: '#user', password: '#pass', submit: null } });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(typesOf(worker)).toContain('LOGIN_REGISTERED');
    expect(existsSync(join(workDirectory, 'credential-marker'))).toBe(false);
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'MANUAL_SESSION', revision: MIN_PROFILE_REVISION + 1 });
    // OP-K（K3）: 使えない理由を、閉じた理由のコードで残す（欄の場所がそろわない。下調べの案もない）。
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration)
      .toMatchObject({ result: 'SAVED', automatedLogin: 'NOT_AVAILABLE', automatedLoginReason: 'LOGIN_FIELDS_MISSING' });
  }, TEST_TIMEOUT_MS);

  // OP-K（K3）: 手でのログインの観察に欄の場所がなくても、最後の下調べ（入口の確かめ）の案に 3 つそろっていれば、それで切り替える（照らし `carriedBy` は今のまま）。
  it('switches with the selectors of the last entry check when the manual login observation has no login fields (OP-K K3)', async () => {
    createManualProfile();
    const entryRunId = 'RUN-20261027000900';
    const document: EntryCheckDocument = {
      schemaVersion: ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
      jobId: '__JOB_ID__',
      runId: entryRunId,
      startedAt: '20261027000900',
      finishedAt: '20261027000901',
      runStatus: 'COMPLETE',
      endReason: 'READ',
      landing: { origin: TEST_ORIGIN, path: '/admin/login', inAllowedOrigins: true },
      facts: {
        loginPage: true,
        fields: {
          username: { candidates: 1, selector: LOGIN_FIELDS.username },
          password: { candidates: 1, selector: LOGIN_FIELDS.password },
          submit: { candidates: 1, selector: LOGIN_FIELDS.submit },
        },
        form: { placement: 'SAME', action: { origin: TEST_ORIGIN, path: '/admin/login', inAllowedOrigins: true }, method: 'POST' },
      },
      proposal: {
        loginStartUrl: `${TEST_ORIGIN}/admin/login`,
        sessionLostPathPrefix: '/admin/login',
        loginTransport: 'FORM_NAVIGATION',
        loginPostEndpoint: { origin: TEST_ORIGIN, path: '/admin/login' },
        selectors: LOGIN_FIELDS,
      },
      blockedRequests: 0,
    };
    const entryDirectory = join(workDirectory, 'entry-check-worker');
    mkdirSync(entryDirectory, { recursive: true });
    const entryWorker = writeFakeWorker(entryDirectory, 'entry-check', fakeWorkerValuesOf({ runId: entryRunId, otherRunId: 'RUN-20261027009998' }, {
      entryCheck: {
        outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY),
        documentText: JSON.stringify(document),
        summary: { ...entryCheckSummaryOf(document) },
        runStatus: document.runStatus,
      },
    }));
    const entryManager = managerWith(entryWorker);
    const entry = await entryManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!entry.ok) {
      throw new Error(`the entry check did not start: ${entry.reason}`);
    }
    expect(await waitForJob({ getAuditJob: (jobId) => entryManager.getAuditJob(jobId) }, entry.job.jobId, isJobEnded))
      .toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'FINISHED', failureReason: null });
    await entryManager.close();
    // 観察に欄の場所がない（SPA のログインの画面を開いた直後の形）。
    const worker = fakeWorker({});
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker)).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration).toMatchObject({ result: 'SAVED', automatedLogin: 'SWITCHED' });
    expect(getAuthSetup(database, PROFILE_ID)?.setup.automatedLogin).toMatchObject({
      usernameSelector: LOGIN_FIELDS.username, passwordSelector: LOGIN_FIELDS.password, submitSelector: LOGIN_FIELDS.submit,
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('keeps the manual login when the worker could not write the credential', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, saved: false });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker)).toContain('CREDENTIAL_SAVE_ALLOWED');
    // OP-K（K3）: ワーカーが書けなかった理由を残す。
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration)
      .toMatchObject({ automatedLogin: 'NOT_AVAILABLE', automatedLoginReason: 'CREDENTIAL_NOT_SAVED' });
    // OP-L（L2）: ワーカーが知らせた、書けなかった理由のコード（値を含まない）も残す。
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration).toMatchObject({ automatedLoginSaveFailure: 'CREDENTIAL_STORAGE_UNSAFE' });
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'MANUAL_SESSION', revision: MIN_PROFILE_REVISION + 1 });
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not ask to receive when a credential file is already there, or when the profile logs in by hand every time', async () => {
    createManualProfile('MANUAL_EVERY_TIME');
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS });
    const jobManager = managerWith(worker);
    await waitForChainEnd(jobManager, await startChain(jobManager));
    const start = worker.received().find((message) => message['type'] === 'START');
    expect((start?.['authentication'] as { readonly loginRegistration?: unknown } | undefined)?.loginRegistration).toEqual({ credentialRoot: null });
    expect(typesOf(worker)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
  }, TEST_TIMEOUT_MS);

  it('does not ask to receive when a credential file already exists', async () => {
    createManualProfile();
    writeFileSync(join(workDirectory, 'credential-marker'), 'written', 'utf8');
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS });
    const jobManager = managerWith(worker);
    await waitForChainEnd(jobManager, await startChain(jobManager));
    const start = worker.received().find((message) => message['type'] === 'START');
    expect((start?.['authentication'] as { readonly loginRegistration?: unknown } | undefined)?.loginRegistration).toEqual({ credentialRoot: null });
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
  }, TEST_TIMEOUT_MS);
});

// OP-J（J2。設計書 4.1.6）: 登録の設定がすでにそろっている（足すものがない）プロファイルでも、受け取った値があり 4.1.3 の条件がそろえば、自動ログインへ切り替える。
describe('OP-J (J2): the switch when the registration has nothing to add', () => {
  /** 成功の条件と読む範囲が、観察した成功の画面の path でそろっている設定（登録で変わるものがない）。 */
  const COMPLETE_SETUP: AuthSetup = Object.freeze({
    ...SETUP,
    successCondition: { pathPrefix: '/admin/dashboard', selector: null },
    auditPathPrefixes: ['/admin/dashboard'],
  });
  const createCompleteProfile = (): void => {
    expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
    expect(saveAuthSetup(database, COMPLETE_SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  };

  it('saves the credential and switches to the automated login in one save, and the next inspection logs in automatically', async () => {
    createCompleteProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    const chain = await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker).filter((type) => type === 'CREDENTIAL_SAVE_ALLOWED' || type === 'LOGIN_REGISTERED' || type === 'LOGIN_REGISTRATION_SKIPPED'))
      .toEqual(['CREDENTIAL_SAVE_ALLOWED', 'LOGIN_REGISTERED']);
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration)
      .toEqual({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, addedServiceOrigins: [], automatedLogin: 'SWITCHED' });
    // 改訂が進むのは、切り替えの保存の 1 回だけ。
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: MIN_PROFILE_REVISION + 1 });
    const setup = getAuthSetup(database, PROFILE_ID)?.setup;
    expect(setup?.automatedLogin).toMatchObject({ usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go' });
    expect(setup?.successCondition).toEqual(COMPLETE_SETUP.successCondition);
    expect(setup?.auditPathPrefixes).toEqual(COMPLETE_SETUP.auditPathPrefixes);
    expect(readRecentCredentialEvents(database, PROFILE_ID).map(({ kind }) => kind)).toEqual(['CREATED']);
    // 連鎖の基準は、親が進めた改訂として受け入れる。
    expect(chain).toMatchObject({ state: 'FINISHED', stopReason: null, profileRevision: MIN_PROFILE_REVISION + 1 });
    // 次の点検は自動ログイン（値の受け取りを求めない。`START` に自動ログインの指定がある）。
    await waitForChainEnd(jobManager, await startChain(jobManager));
    const starts = worker.received().filter((message) => message['type'] === 'START');
    expect(starts.length).toBe(2);
    const second = starts[1]?.['authentication'] as { readonly loginRegistration?: unknown; readonly automatedLogin?: unknown } | undefined;
    expect(second?.loginRegistration).toBeUndefined();
    expect(second?.automatedLogin).toBeDefined();
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);
});

// OP-F（安全のレビュー OP-REV の I-1・M-2）: 許しの後の終わり方と、受け取った値の送り先。
describe('OP-F: the credential file after the allowance, and where the received value went', () => {
  const marker = (): string => join(workDirectory, 'credential-marker');
  const startsOf = (worker: FakeWorker): readonly Record<string, unknown>[] => worker.received().filter((message) => message['type'] === 'START');
  const receiptOf = (start: Record<string, unknown> | undefined): unknown =>
    (start?.['authentication'] as { readonly loginRegistration?: unknown } | undefined)?.loginRegistration;

  it('I-1: removes the file that the worker wrote when it ends before CREDENTIAL_SAVED, and offers the receipt again on the next inspection', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, exitAfterWriting: true });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker)).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(typesOf(worker)).not.toContain('CREDENTIAL_SAVED');
    expect(existsSync(marker())).toBe(false);
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
    // 次の点検: ファイルがないので、受け取りがまた許される。
    await waitForChainEnd(jobManager, await startChain(jobManager));
    const starts = startsOf(worker);
    expect(starts.length).toBe(2);
    expect(receiptOf(starts[1])).toEqual({ credentialRoot: workDirectory });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('I-1: stops the worker and removes the file when CREDENTIAL_SAVED does not come within the limit (a late one is not used)', async () => {
    createManualProfile();
    const limitMs = 500;
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, savedDelayMs: limitMs * 4 });
    const jobManager = managerWith(worker, { loginRegistrationTimeoutMs: limitMs });
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    // 遅れて届く知らせの時間を過ぎるまで待ってから確かめる（上限を過ぎたワーカーは止めたので、知らせは届かない）。
    await sleep(limitMs * 6);
    expect(typesOf(worker)).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(jobManager.getAuditJob(chainId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_UNRESPONSIVE' });
    expect(existsSync(marker())).toBe(false);
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
    expect(readRecentCredentialEvents(database, PROFILE_ID)).toEqual([]);
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('M-2: does not switch when the received value went to a place that is not the login destination after the switch', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, carriedBy: { origin: 'http://127.0.0.1:9', path: '/collect' } });
    const jobManager = managerWith(worker);
    const chainId = await startChain(jobManager);
    await waitForChainEnd(jobManager, chainId);
    expect(typesOf(worker)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(existsSync(marker())).toBe(false);
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
    // OP-K（K3）: 送り先が合わない理由を残す。
    expect(jobManager.getAuditJob(chainId)?.loginStage?.autoRegistration)
      .toMatchObject({ automatedLogin: 'NOT_AVAILABLE', automatedLoginReason: 'DESTINATION_MISMATCH' });
  }, TEST_TIMEOUT_MS);

  it('M-2: switches when the received value went to the form destination (the same origin and path)', async () => {
    createManualProfile();
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, carriedBy: { origin: TEST_ORIGIN, path: '/admin/login' } });
    const jobManager = managerWith(worker);
    await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('AUTOMATED_LOGIN');
  }, TEST_TIMEOUT_MS);

  // OP-F（OP-REV2 の m-3）: 消すのは、このジョブの許しの後に書かれた形（改訂 1、作った日時が許しの後）のファイルだけ。資格情報の画面がほかの時に書いたファイルは消さない。
  it.each([
    ['written before the allowance', { createdAt: '20200101000000' }],
    ['of another revision', { credentialRevision: 2 }],
  ] as const)('m-3: keeps a credential file %s (not written by this job after the allowance)', async (_label, override) => {
    createManualProfile();
    markerMetadata.override = override;
    const worker = fakeWorker({ loginFields: LOGIN_FIELDS, exitAfterWriting: true });
    const jobManager = managerWith(worker);
    await waitForChainEnd(jobManager, await startChain(jobManager));
    expect(typesOf(worker)).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(existsSync(marker())).toBe(true);
    expect(getProfile(database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
  }, TEST_TIMEOUT_MS);
});
