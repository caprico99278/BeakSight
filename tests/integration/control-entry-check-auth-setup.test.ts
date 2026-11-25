// MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3、6 章の受け入れ条件 2・3）: 入口の確かめの後に、ジョブの管理が認証の設定を案で
// 保存する。偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `entry-check` と `auth-manual-confirm`）を本物の `fork` で起動する。
// - 入口の確かめが「読んだ」で終わり、ログインの画面に見え、認証の設定がまだないとき、案（`proposedAuthSetupOf`）を今の保存の部品で保存する。プロファイルの
//   改訂は進めない。すでにあるときは上書きしない。ログインの画面に見えない・読んでいない・ジョブの間にプロファイルの改訂が進んだときは保存しない。
// - 受け入れ条件 3 の前半: 入口の確かめ → 手動のログインの監査 → 自動の登録が、認証の設定の画面を開かずに通る（画面の保存の Server Function を呼ばない）。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。例の値は匿名の値（`example.invalid`）だけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION, entryCheckRunStatusOf, entryCheckSummaryOf, type EntryCheckDocument } from '../../src/control/entry-check.js';
import type { AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, updateProfile, type ProfileContextResolver } from '../../src/control/store/profile-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { createTestConfig } from '../helpers/test-config.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, publicProfile, testAuthProfile } from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261026000000';
const OTHER_RUN_ID = 'RUN-20261026000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-entry-auth';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const JOB_ID_PLACEHOLDER = '__JOB_ID__';
const TEST_TIMEOUT_MS = 60_000;

/** 開始の URL の path（ログインの画面の path と前方一致しない。今の案の成功の画面の path が残る形）。 */
const START_PATH = '/dashboard';
const CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig(TEST_ORIGIN, START_PATH) });
/** NL-3: このパソコンで動かすサイト（loopback）の対象の設定。 */
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const LOOPBACK_TARGET_PATH = 'local/targets/example-loopback.json';
const LOOPBACK_CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig(LOOPBACK_ORIGIN, START_PATH) });
const resolveContext: ProfileContextResolver = (path) => {
  if (path === TEST_TARGET_PATH) {
    return CONTEXT;
  }
  return path === LOOPBACK_TARGET_PATH ? LOOPBACK_CONTEXT : undefined;
};
const OUTPUT_DIRECTORY_NAME = CONTEXT.targetConfig.output.directory;

const documentFor = (overrides: Partial<EntryCheckDocument> = {}): EntryCheckDocument => ({
  schemaVersion: ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
  jobId: JOB_ID_PLACEHOLDER,
  runId: FAKE_RUN_ID,
  startedAt: '20261026000000',
  finishedAt: '20261026000001',
  runStatus: 'COMPLETE',
  endReason: 'READ',
  landing: { origin: TEST_ORIGIN, path: '/login', inAllowedOrigins: true },
  facts: {
    loginPage: true,
    fields: {
      username: { candidates: 1, selector: '#user' },
      password: { candidates: 1, selector: '#pass' },
      submit: { candidates: 1, selector: '#go' },
    },
    form: { placement: 'NONE', action: null, method: null },
  },
  proposal: {
    loginStartUrl: `${TEST_ORIGIN}/login`,
    sessionLostPathPrefix: '/login',
    loginTransport: 'SCRIPT_REQUEST',
    loginPostEndpoint: null,
    selectors: { username: '#user', password: '#pass', submit: '#go' },
  },
  blockedRequests: 0,
  ...overrides,
});

/** 手動のログインの段で通した送信（token の送信）と、観察（成功の鍵の形）。 */
const PASSED_REQUESTS = Object.freeze({
  requests: [
    { origin: SERVICE_ORIGIN, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] } },
  ],
  unlisted: 0,
});
const LOGIN_OBSERVATION = Object.freeze({ storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } });

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };

const managerWith = async (worker: FakeWorker, outputName: string): Promise<AuditJobManager> => {
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveContext, join(OUTPUT_DIRECTORY_NAME, outputName)),
    forkWorker: forks.fork,
  });
  return manager;
};

const entryCheckWorker = (name: string, document: EntryCheckDocument): FakeWorker => {
  const directory = join(workDirectory, name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, 'entry-check', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    entryCheck: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY_NAME, name),
      documentText: JSON.stringify(document),
      summary: { ...entryCheckSummaryOf(document) },
      runStatus: document.runStatus,
    },
  }));
};

/**
 * 1 回の入口の確かめのジョブを行い、背後の保存が終わるまで待つ（ジョブの管理を閉じると、背後の保存を待つ）。`whileRunning` は、ジョブを始めた直後
 * （ワーカーが終わる前）に行う。
 */
async function runEntryCheck(name: string, document: EntryCheckDocument, whileRunning: () => void = () => undefined): Promise<void> {
  const jobManager = await managerWith(entryCheckWorker(name, document), name);
  const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
  if (!started.ok) {
    throw new Error(`the entry check job did not start: ${started.reason}`);
  }
  whileRunning();
  const ended = await waitForJob(currentManager, started.job.jobId, isJobEnded);
  expect(ended).toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'FINISHED', failureReason: null });
  await jobManager.close();
  manager = undefined;
}

const savedSetup = (): AuthSetupV3 => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/saved-login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/saved-login' }],
  successCondition: { pathPrefix: '/home', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: ['/home'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-entry-check-auth-setup-'));
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  writeFileSync(join(workDirectory, LOOPBACK_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('MI-3: the job manager saves the auth setup proposal after an entry check', () => {
  it('saves the proposal when the entry check read a login page and no auth setup exists, without moving the profile revision', async () => {
    await runEntryCheck('login-page', documentFor());
    const stored = getAuthSetup(database, PROFILE_ID);
    expect(stored?.freshness).toBe('CURRENT');
    expect(stored?.setup).toEqual({
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId: PROFILE_ID,
      profileRevision: MIN_PROFILE_REVISION,
      loginStartUrl: `${TEST_ORIGIN}/login`,
      loginPostEndpoints: [],
      successCondition: { pathPrefix: START_PATH, selector: null },
      sessionLostCondition: { pathPrefix: '/login' },
      excludedPaths: [],
      auditPathPrefixes: [START_PATH],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: null,
      loginSideRequests: [],
      successStorageKey: null,
    });
    expect(getProfile(database, PROFILE_ID)?.profile.revision).toBe(MIN_PROFILE_REVISION);
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('does not overwrite an auth setup that already exists', async () => {
    expect(saveAuthSetup(database, savedSetup(), { resolveContext }).ok).toBe(true);
    await runEntryCheck('existing', documentFor());
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(savedSetup());
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a page that is not a login page', documentFor({ facts: { ...documentFor().facts!, loginPage: false }, proposal: null })],
    ['a page that left the allowed origins (not read)', documentFor({
      endReason: 'LEFT_ALLOWED_ORIGINS',
      landing: { origin: 'https://other.example.invalid', path: null, inAllowedOrigins: false },
      facts: null,
      proposal: null,
    })],
  ])('does not save for %s', async (name, document) => {
    await runEntryCheck(name.split(' ').join('-').replace(/[()]/gu, ''), document);
    expect(getAuthSetup(database, PROFILE_ID)).toBeNull();
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  // MI-F1（設計書 4.3・4.7.1。MI-R の Minor 3）: 自動ログインのプロファイルは、資格情報の送信先（フォームの送信先、セレクタ）を人の確かめなしに保存しない
  // ため、案で保存しない（手動のログインのプロファイルだけ）。
  it('does not save the proposal for an AUTOMATED_LOGIN profile', async () => {
    const profile = getProfile(database, PROFILE_ID)?.profile;
    expect(updateProfile(database, {
      profile: { ...profile, revision: MIN_PROFILE_REVISION + 1, auth: 'AUTOMATED_LOGIN' },
      expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext }).ok).toBe(true);
    // フォームの送信の案（自動ログインのプロファイルで、保存の検証を通る形。送信先とセレクタを案のまま保存してしまう道）。
    const formDocument = documentFor({ proposal: { ...documentFor().proposal!, loginTransport: 'FORM_NAVIGATION', loginPostEndpoint: { origin: TEST_ORIGIN, path: '/login' } } });
    const jobManager = await managerWith(entryCheckWorker('automated', formDocument), 'automated');
    const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const ended = await waitForJob(currentManager, started.job.jobId, isJobEnded);
    expect(ended).toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'FINISHED', failureReason: null });
    await jobManager.close();
    manager = undefined;
    expect(getAuthSetup(database, PROFILE_ID)).toBeNull();
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);

  it('does not save when the user saved the profile while the job ran (the revision moved)', async () => {
    await runEntryCheck('revision-moved', documentFor(), () => {
      expect(updateProfile(database, {
        profile: testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION + 1),
        expectedRevision: MIN_PROFILE_REVISION,
      }, { resolveContext }).ok).toBe(true);
    });
    expect(getAuthSetup(database, PROFILE_ID)).toBeNull();
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);
});

// MI-F1（設計書 4.3。MI-R の Minor 4）: 「設定がないときだけ保存する」の確かめは、保存のトランザクションの中で行う（保存の部品の引数 `onlyWhenAbsent`）。
describe('MI-F1: the auth setup store saves only when no auth setup exists, inside the transaction', () => {
  it('rejects the save with onlyWhenAbsent when an auth setup exists, and keeps the saved one', () => {
    expect(saveAuthSetup(database, savedSetup(), { resolveContext })).toMatchObject({ ok: true });
    const other = { ...savedSetup(), excludedPaths: ['/other'] };
    expect(saveAuthSetup(database, other, { resolveContext, onlyWhenAbsent: true })).toMatchObject({ ok: false, reason: 'AUTH_SETUP_ALREADY_EXISTS' });
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(savedSetup());
  });

  it('saves with onlyWhenAbsent when no auth setup exists', () => {
    expect(saveAuthSetup(database, savedSetup(), { resolveContext, onlyWhenAbsent: true })).toMatchObject({ ok: true });
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(savedSetup());
  });
});

describe('MI-3 (the acceptance 3, first half): entry check, a manual login audit and the automatic registration without the auth setup page', () => {
  it('passes from the entry check to the automatic registration with the proposal saved by the job manager', async () => {
    await runEntryCheck('flow', documentFor());
    expect(getAuthSetup(database, PROFILE_ID)?.setup.profileRevision).toBe(MIN_PROFILE_REVISION);

    const values: Partial<FakeWorkerValues> = { loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION } };
    const mode: FakeWorkerMode = 'auth-manual-confirm';
    const jobManager = await managerWith(writeFakeWorker(workDirectory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, values)), 'audit');
    const started = await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { jobId } = started.job;
    await waitForJob(jobManager, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN');
    expect(await jobManager.confirmManualLogin(jobId)).toEqual({ ok: true });
    await waitForJob(jobManager, jobId, (job) => job.lastAuthState === 'AUTHENTICATED');
    jobManager.stopAuditJob(jobId);
    await waitForJob(jobManager, jobId, isJobEnded);
    const registered = await waitForJob(jobManager, jobId, (job) => job.loginStage?.autoRegistration !== undefined);
    expect(registered.loginStage?.autoRegistration).toEqual({ result: 'SAVED', profileRevision: MIN_PROFILE_REVISION + 1, addedServiceOrigins: [SERVICE_ORIGIN] });
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toMatchObject({
      profileRevision: MIN_PROFILE_REVISION + 1,
      loginStartUrl: `${TEST_ORIGIN}/login`,
      excludedPaths: [],
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
    });
    await expectWorkersExited(children);
  }, TEST_TIMEOUT_MS);
});

// OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11、4.1.3 の 3）: 作成の画面の「点検を始める」は、印つきの下調べ（`thenStartAudit`）を始め、
// ジョブの管理が、下調べの後（ログインの設定の案の保存の後）に、続けて点検（まとめて実行）を始める。保存できなかったときは始めない。
/** OP-1: 続けて始める点検の状態を読み直す間隔（ms）。 */
const FOLLOW_UP_POLL_MS = 25;

describe('OP-1: the job manager starts the audit right after the entry check started with the mark', () => {
  const waitForFollowUp = async (jobManager: AuditJobManager, jobId: string): Promise<unknown> => {
    const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
    for (;;) {
      const followUp = jobManager.entryCheckFollowUpOf(jobId);
      if (followUp !== null && followUp.state !== 'WAITING') {
        return followUp;
      }
      if (Date.now() > deadline) {
        throw new Error(`the follow up did not settle: ${JSON.stringify(followUp)}`);
      }
      await wait(FOLLOW_UP_POLL_MS);
    }
  };

  it('starts the chained audit after the proposal was saved', async () => {
    const jobManager = await managerWith(entryCheckWorker('follow-up-started', documentFor()), 'follow-up-started');
    const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    expect(jobManager.entryCheckFollowUpOf(started.job.jobId)).toEqual({ state: 'WAITING' });
    const followUp = await waitForFollowUp(jobManager, started.job.jobId) as { readonly state: string; readonly jobId?: string };
    expect(followUp.state).toBe('STARTED');
    expect(getAuthSetup(database, PROFILE_ID)).not.toBeNull();
    const chained = jobManager.getAuditJob(followUp.jobId ?? '');
    expect(chained?.jobKind).toBe('AUDIT');
    expect(jobManager.getStageChainOfJob(followUp.jobId ?? '')?.chainId).toBe(followUp.jobId);
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);

  it('does not start the audit when the entry check did not see a login page (no auth setup)', async () => {
    const jobManager = await managerWith(entryCheckWorker('follow-up-not-started', documentFor({
      facts: { ...(documentFor().facts as NonNullable<EntryCheckDocument['facts']>), loginPage: false },
    })), 'follow-up-not-started');
    const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    expect(await waitForFollowUp(jobManager, started.job.jobId)).toEqual({ state: 'SKIPPED' });
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);

  // OP-1 修正の 2 回目（4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」）: ログインしなくても見られるサイトも、印つきの下調べの後に、ジョブの管理が
  // 続けて点検を始める。公開の画面だけのプロファイルは連鎖しないので、単独の点検（まとめて実行ではない）。ログインの設定は要らないので、作らない。
  it('starts the single audit after the entry check of a public profile', async () => {
    const publicId = 'example-entry-public';
    expect(createProfile(database, publicProfile(publicId, MIN_PROFILE_REVISION, TEST_TARGET_PATH), { resolveContext }).ok).toBe(true);
    const jobManager = await managerWith(entryCheckWorker('follow-up-public', documentFor({
      facts: { ...(documentFor().facts as NonNullable<EntryCheckDocument['facts']>), loginPage: false },
      proposal: null,
    })), 'follow-up-public');
    const started = await jobManager.startEntryCheck({ profileId: publicId, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    const followUp = await waitForFollowUp(jobManager, started.job.jobId) as { readonly state: string; readonly jobId?: string };
    expect(followUp.state).toBe('STARTED');
    expect(jobManager.getAuditJob(followUp.jobId ?? '')).toMatchObject({ jobKind: 'AUDIT', profileId: publicId });
    expect(jobManager.getStageChainOfJob(followUp.jobId ?? '')).toBeNull();
    expect(getAuthSetup(database, publicId)).toBeNull();
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);

  // OP-1 修正の 2 回目（4.1.3 の 3「下調べが失敗したときは、点検を始めずに、サイトの画面へ移る」）: 下調べが開始のページを読めなかったとき（開けなかった・止めた
  // など）は、ログインの設定の要らない公開のサイトでも、続けて点検を始めない（ログインが必要なサイトは、ログインの設定がないので、前から始めなかった）。
  for (const endReason of ['NAVIGATION_FAILED', 'STOPPED'] as const) {
    it(`does not start the audit of a public profile when the entry check ended with ${endReason}`, async () => {
      const publicId = `example-entry-public-${endReason.toLowerCase().replaceAll('_', '-')}`;
      expect(createProfile(database, publicProfile(publicId, MIN_PROFILE_REVISION, TEST_TARGET_PATH), { resolveContext }).ok).toBe(true);
      const name = `follow-up-public-${endReason.toLowerCase()}`;
      const jobManager = await managerWith(entryCheckWorker(name, documentFor({
        endReason, runStatus: entryCheckRunStatusOf(endReason), landing: null, facts: null, proposal: null,
      })), name);
      const started = await jobManager.startEntryCheck({ profileId: publicId, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
      if (!started.ok) {
        throw new Error(`the entry check job did not start: ${started.reason}`);
      }
      expect(await waitForFollowUp(jobManager, started.job.jobId)).toEqual({ state: 'SKIPPED' });
      expect(jobManager.listAuditJobs().filter((job) => job.profileId === publicId).map((job) => job.jobKind)).toEqual(['ENTRY_CHECK']);
      await jobManager.close();
      manager = undefined;
    }, TEST_TIMEOUT_MS);
  }

  // REV-PAR の m-4: 下調べの後に続けて始める点検は、同じ流れの続きなので空きメモリを確かめない。同じサイトの別の設定が動いていて始められなかったときは、
  // 黙って飛ばさず、その理由を残す（作業の画面が出す）。
  describe('with a job of another profile running (REV-PAR m-4)', () => {
    const PUBLIC_ID = 'example-entry-public-parallel';
    const HOLDER_ID = 'example-entry-holder';
    const HOLDER_TARGET_PATH = 'local/targets/example-holder.json';
    const GIB = 1024 ** 3;
    /** 別のサイト（許可 Origin が重ならない）。 */
    const OTHER_SITE_CONTEXT: ProfileValidationContext = Object.freeze({ targetConfig: createTestConfig('https://other-site.example.invalid', START_PATH) });
    const publicDocument = (): EntryCheckDocument => documentFor({
      facts: { ...(documentFor().facts as NonNullable<EntryCheckDocument['facts']>), loginPage: false },
      proposal: null,
    });

    /** 1 つ目の起動だけを、止めるまで動く偽のワーカー（ほかの設定のジョブ）にする管理。`holderContext` はそのジョブのサイト。 */
    const parallelManager = (name: string, holderContext: ProfileValidationContext, memory: { freeBytes: number }, gate: Promise<void> | null): AuditJobManager => {
      const worker = entryCheckWorker(name, publicDocument());
      const holding = writeFakeWorker(join(workDirectory, name), 'hold', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }));
      let forked = 0;
      let entryStarted = false;
      const contextOf = withOutputDirectory((path) => (path === HOLDER_TARGET_PATH ? holderContext : resolveContext(path)), join(OUTPUT_DIRECTORY_NAME, name));
      const resolver = async (path: string): Promise<ProfileValidationContext | undefined> => {
        // 下調べの開始の後に読む（続けて始める点検の開始）ときだけ、`gate` まで待つ（その間に、同じサイトの別の設定を始める）。
        if (path !== HOLDER_TARGET_PATH && entryStarted && gate !== null) {
          await gate;
        }
        entryStarted ||= path !== HOLDER_TARGET_PATH;
        return contextOf(path);
      };
      manager = createFakeWorkerJobManager({
        database,
        workDirectory,
        worker,
        resolveContext: resolver,
        forkWorker: (modulePath, args, options) => {
          forked += 1;
          return forks.fork(forked === (gate === null ? 1 : 2) ? holding.path : modulePath, args, options);
        },
        machineMemory: () => ({ freeBytes: memory.freeBytes, totalBytes: 16 * GIB }),
      });
      return manager;
    };

    beforeEach(() => {
      writeFileSync(join(workDirectory, HOLDER_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
      expect(createProfile(database, publicProfile(PUBLIC_ID, MIN_PROFILE_REVISION, TEST_TARGET_PATH), { resolveContext }).ok).toBe(true);
      expect(createProfile(database, publicProfile(HOLDER_ID, MIN_PROFILE_REVISION, HOLDER_TARGET_PATH), { resolveContext: () => CONTEXT }).ok).toBe(true);
    });

    it('starts the audit after the entry check without checking the free memory', async () => {
      const memory = { freeBytes: 16 * GIB };
      const jobManager = parallelManager('follow-up-memory', OTHER_SITE_CONTEXT, memory, null);
      const holder = await jobManager.startAuditJob({ profileId: HOLDER_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      await waitForJob(currentManager, holder.ok ? holder.job.jobId : '', (job) => job.state === 'RUNNING');
      const started = await jobManager.startEntryCheck({ profileId: PUBLIC_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
      memory.freeBytes = 0;

      expect(await waitForFollowUp(jobManager, started.ok ? started.job.jobId : '')).toMatchObject({ state: 'STARTED' });
    });

    it('keeps the reason when another profile of the same site started before the audit', async () => {
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolveGate) => {
        open = resolveGate;
      });
      const jobManager = parallelManager('follow-up-same-site', CONTEXT, { freeBytes: 16 * GIB }, gate);
      const started = await jobManager.startEntryCheck({ profileId: PUBLIC_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
      await waitForJob(currentManager, started.ok ? started.job.jobId : '', isJobEnded);
      const holder = await jobManager.startAuditJob({ profileId: HOLDER_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      expect(holder.ok).toBe(true);
      open();

      expect(await waitForFollowUp(jobManager, started.ok ? started.job.jobId : '')).toEqual({ state: 'SKIPPED', reason: 'SITE_ALREADY_ACTIVE' });
    });
  });

  it('has no follow up without the mark', async () => {
    const jobManager = await managerWith(entryCheckWorker('follow-up-none', documentFor()), 'follow-up-none');
    const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    await waitForJob(currentManager, started.job.jobId, isJobEnded);
    expect(jobManager.entryCheckFollowUpOf(started.job.jobId)).toBeNull();
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);
});

// NL-3（設計書 `2026-11-06-beaksight-no-login-test-site-design.md` 3.3 の 2）: 入口の確かめがログインの画面を見なかった、手動のログインで認証の設定のない
// プロファイルは、ジョブの管理がプロファイルの次の改訂をログインなし（`NONE`）で保存し、続けて点検（まとめて実行）を始める。保存できるか（`approvedTestOrigins`
// がすべて loopback か）は、プロファイルの検証が決める（loopback でなければ、今のとおり保存せず、点検も始めない。上の OP-1 の describe）。
describe('NL-3: the job manager saves the profile without login after an entry check that did not see a login page', () => {
  const LOOPBACK_PROFILE_ID = 'example-entry-loopback';
  const notLoginPage = (): EntryCheckDocument => documentFor({
    landing: { origin: LOOPBACK_ORIGIN, path: START_PATH, inAllowedOrigins: true },
    facts: { ...(documentFor().facts as NonNullable<EntryCheckDocument['facts']>), loginPage: false },
    proposal: null,
  });
  const createLoopbackProfile = (): void => {
    expect(createProfile(database, {
      ...testAuthProfile(LOOPBACK_PROFILE_ID, MIN_PROFILE_REVISION, LOOPBACK_ORIGIN),
      targetConfigPath: LOOPBACK_TARGET_PATH,
    }, { resolveContext }).ok).toBe(true);
  };
  const waitForSettled = async (jobManager: AuditJobManager, jobId: string): Promise<{ readonly state: string; readonly jobId?: string }> => {
    const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
    for (;;) {
      const followUp = jobManager.entryCheckFollowUpOf(jobId);
      if (followUp !== null && followUp.state !== 'WAITING') {
        return followUp;
      }
      if (Date.now() > deadline) {
        throw new Error(`the follow up did not settle: ${JSON.stringify(followUp)}`);
      }
      await wait(FOLLOW_UP_POLL_MS);
    }
  };

  it('saves the next revision with auth NONE on a loopback site and starts the chained audit', async () => {
    createLoopbackProfile();
    const jobManager = await managerWith(entryCheckWorker('no-login-loopback', notLoginPage()), 'no-login-loopback');
    const started = await jobManager.startEntryCheck({ profileId: LOOPBACK_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    const followUp = await waitForSettled(jobManager, started.job.jobId);
    expect(followUp.state).toBe('STARTED');
    const stored = getProfile(database, LOOPBACK_PROFILE_ID)?.profile;
    expect(stored).toMatchObject({ revision: MIN_PROFILE_REVISION + 1, auth: 'NONE', mode: 'TEST_AUTH_PASSIVE', approvedTestOrigins: [LOOPBACK_ORIGIN] });
    expect(stored?.loginPreference).toBeUndefined();
    expect(getAuthSetup(database, LOOPBACK_PROFILE_ID)).toBeNull();
    expect(jobManager.getAuditJob(followUp.jobId ?? '')).toMatchObject({ jobKind: 'AUDIT', profileId: LOOPBACK_PROFILE_ID, profileRevision: MIN_PROFILE_REVISION + 1 });
    expect(jobManager.getStageChainOfJob(followUp.jobId ?? '')?.chainId).toBe(followUp.jobId);
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);

  it('keeps MANUAL_SESSION and does not start the audit on a site that is not loopback', async () => {
    const jobManager = await managerWith(entryCheckWorker('no-login-remote', documentFor({
      facts: { ...(documentFor().facts as NonNullable<EntryCheckDocument['facts']>), loginPage: false },
      proposal: null,
    })), 'no-login-remote');
    const started = await jobManager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    expect(await waitForSettled(jobManager, started.job.jobId)).toEqual({ state: 'SKIPPED' });
    expect(getProfile(database, PROFILE_ID)?.profile).toMatchObject({ revision: MIN_PROFILE_REVISION, auth: 'MANUAL_SESSION' });
    expect(getAuthSetup(database, PROFILE_ID)).toBeNull();
    await jobManager.close();
    manager = undefined;
  }, TEST_TIMEOUT_MS);

  it('keeps MANUAL_SESSION and saves the auth setup proposal when a loopback site shows a login page', async () => {
    createLoopbackProfile();
    const document = documentFor({
      landing: { origin: LOOPBACK_ORIGIN, path: '/login', inAllowedOrigins: true },
      proposal: { ...documentFor().proposal!, loginStartUrl: `${LOOPBACK_ORIGIN}/login` },
    });
    const jobManager = await managerWith(entryCheckWorker('login-loopback', document), 'login-loopback');
    const started = await jobManager.startEntryCheck({ profileId: LOOPBACK_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    await waitForJob(currentManager, started.job.jobId, isJobEnded);
    await jobManager.close();
    manager = undefined;
    expect(getProfile(database, LOOPBACK_PROFILE_ID)?.profile).toMatchObject({ revision: MIN_PROFILE_REVISION, auth: 'MANUAL_SESSION' });
    expect(getAuthSetup(database, LOOPBACK_PROFILE_ID)).not.toBeNull();
  }, TEST_TIMEOUT_MS);

  it('does not save when the user saved the profile while the job ran (the revision moved)', async () => {
    createLoopbackProfile();
    const jobManager = await managerWith(entryCheckWorker('no-login-moved', notLoginPage()), 'no-login-moved');
    const started = await jobManager.startEntryCheck({ profileId: LOOPBACK_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    expect(updateProfile(database, {
      profile: { ...testAuthProfile(LOOPBACK_PROFILE_ID, MIN_PROFILE_REVISION + 1, LOOPBACK_ORIGIN), targetConfigPath: LOOPBACK_TARGET_PATH },
      expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext }).ok).toBe(true);
    await waitForJob(currentManager, started.job.jobId, isJobEnded);
    await jobManager.close();
    manager = undefined;
    expect(getProfile(database, LOOPBACK_PROFILE_ID)?.profile).toMatchObject({ revision: MIN_PROFILE_REVISION + 1, auth: 'MANUAL_SESSION' });
  }, TEST_TIMEOUT_MS);
});
