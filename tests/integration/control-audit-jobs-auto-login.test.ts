// T26d-2（Task 26 の設計書 4.5、4.7）: 自動ログインのジョブ（ログインの検証 `LOGIN_CHECK` と、自動ログインのプロファイルの監査）の、ジョブの管理の
// 開始の確かめ・上限・記録・終わりと回復。偽のワーカー（`tests/helpers/fake-audit-worker.ts`）を本物の `fork` で起動する（本物のワーカーと Chromium
// での端から端は `audit-worker-automated-login-fork.test.ts`）。時刻は、ジョブの管理の `now` を差し替えて進める。
// - 開始の前の確かめ: 資格情報なし（`CREDENTIAL_MISSING`）、Origin の違い（`CREDENTIAL_STALE`）、暗号化が使えない（`CREDENTIAL_PROTECTION_UNAVAILABLE`）、
//   止めている（`AUTO_LOGIN_HELD`）、5 分の間隔・24 時間の上限・`Retry-After`（`AUTO_LOGIN_RATE_LIMITED` と次の時刻）。拒むときは行を作らず、
//   ワーカーを起動しない。上限は、ジョブを作るトランザクションの中で確かめ直す（同時の 2 つの開始）。
// - `START` は、ジョブの種類と、資格情報の改訂の番号と根だけを持つ（値・暗号文・ユーザー名を持たない）。
// - `AUTH_STATE` の結果の記録（結果・送信・`Retry-After` の期限・理由のコード）と、止める規則。ログインの検証の成功は `FINISHED`（Run なし）。
// - ワーカーが途中で落ちた試しは `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める。画面のサーバの起動の回復で、前の管理の試しを閉じる。
// - 資格情報を変えてよいか（`CREDENTIAL_IN_USE`）。ワーカーの環境から、デバッグの出力の変数を外す（公開の監査を含む）。
// - 目印（資格情報の値）は、`START`、ジョブの行と新しい表、管理データのファイルと WAL のどこにも出ない。
// round 1: 方式としてはどの OS でも実行できる（`execution-policy.ts`）。Windows だけであることは、資格情報の暗号化の確かめ（`checkProtection`）で強制する
// ので、プラットフォームを差し替えた部品で、Windows でないときに始まらないことを確かめる。資格情報の部品はテストの偽物（Windows として振る舞う）なので、
// このファイルは、どの OS でも動く。ワーカーを起動できなかった試しは送信 `NO`（止めない）、起動した後に落ちた試しは `UNKNOWN`（止める）。
// 管理データと資格情報のフォルダは、一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import {  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import { createCredentialStoreWith, type CredentialStore } from '../../src/control/credentials/credential-store.js';
import { CredentialProtectionError } from '../../src/control/credentials/dpapi-protector.js';
import {
  WORKER_EXCLUDED_ENVIRONMENT_VARIABLES,
  workerEnvironmentOf,
  type AuditJobManager,
  type AuditJobTiming,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
} from '../../src/control/job/auto-login-limits.js';
import { clearAutoLoginHold, readAutoLoginHold, RESENT_ATTEMPT_JOB_ID_PREFIX } from '../../src/control/job/auto-login-store.js';
import { createStartingJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import {
  WORKER_PROTOCOL_VERSION,
  workerAuthenticationDigestOf,
  type WorkerStartAutomatedLogin,
} from '../../src/control/worker-protocol.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode } from '../helpers/fake-audit-worker.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
} from '../helpers/job-test-support.js';
import { createTestCredentialProtector, createTestCredentialStore, type TestCredentialStore } from '../helpers/test-credential-store.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  OTHER_TEST_ORIGIN,
  PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

/** テストの時間（ms。共通の設定に重ねて、準備と合図の見張りを長くする。自動ログインの段の時間のため）。 */
const TEST_TIMING: Partial<AuditJobTiming> = Object.freeze({ readyTimeoutMs: 5_000, heartbeatTimeoutMs: 3_000 });
/** 状態が変わるのを待つ上限（ms。共通の既定より長い。読み直す間隔は既定）。 */
const WAIT_OPTIONS = Object.freeze({ limitMs: 20_000 });
const TEST_TIMEOUT_MS = 120_000;
const FAKE_RUN_ID = 'RUN-20261010000000';
const OTHER_RUN_ID = 'RUN-20261010000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-auto-job';
const MANUAL_PROFILE_ID = 'example-manual-job';
const PUBLIC_PROFILE_ID = 'example-public-job';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const START_TIME_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const RETRY_AFTER_OFFSET_MS = 2 * HOUR;
const MARKER_BYTES = 12;


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

const MANUAL_SETUP: AuthSetup = Object.freeze({
  ...AUTOMATED_SETUP,
  profileId: MANUAL_PROFILE_ID,
  maxLoginAttempts: 2,
  automatedLogin: null,
});

/** 資格情報の目印（実行ごとのランダムな値。記録も出力もしない）。 */
const USERNAME_MARKER = `user${randomBytes(MARKER_BYTES).toString('hex')}`;
const PASSWORD_MARKER = `pass${randomBytes(MARKER_BYTES).toString('hex')}`;
const MARKERS: readonly string[] = [USERNAME_MARKER, PASSWORD_MARKER];

let workDirectory = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;
let manager: AuditJobManager | undefined;
let nowMs = START_TIME_MS;
let forkedEnvironments: NodeJS.ProcessEnv[] = [];
/** 起動したワーカー（後片付けで、残っていないことを確かめる）と、起動ごとの環境の写し（CCX-18: `createCountingFork` の受け手）。 */
const forks = createCountingFork({ onFork: (options) => forkedEnvironments.push({ ...options.env }) });
const children = forks.children;

const clock = (): Date => new Date(nowMs);
const stampAt = (timeMs: number): string => formatCompactUtcTimestamp(new Date(timeMs), 'test time');

const countingFork: AuditWorkerForker = forks.fork;

const fakeWorker = (mode: FakeWorkerMode, autoLoginReport?: Record<string, unknown>): FakeWorker => writeFakeWorker(
  workDirectory,
  mode,
  fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, autoLoginReport === undefined ? {} : { autoLoginReport }),
);

const managerWith = (worker: FakeWorker, store: CredentialStore = credentials.store): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: resolveTestContext,
    forkWorker: countingFork,
    timing: TEST_TIMING,
    now: clock,
    credentials: { root: credentials.root, store },
  });
  return manager;
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

const automatedProfile = (): SiteProfile => ({ ...testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' });

const register = (store: CredentialStore = credentials.store, loginOrigin = TEST_ORIGIN) =>
  store.register({ profileId: PROFILE_ID, loginOrigin, username: USERNAME_MARKER, password: PASSWORD_MARKER });

const loginCheck = () => Object.freeze({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-auto-login-jobs-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  credentials = await createTestCredentialStore();
  nowMs = START_TIME_MS;
  forks.reset();
  forkedEnvironments = [];
  expect(createProfile(database, automatedProfile(), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, AUTOMATED_SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  await credentials.remove();
  rmSync(workDirectory, { recursive: true, force: true });
});

/** ログインの検証を始めて、終わるまで待つ。 */
async function runLoginCheck(jobManager: AuditJobManager): Promise<AuditJobView> {
  const started = await jobManager.startLoginCheck(loginCheck());
  if (!started.ok) {
    throw new Error(`the login check did not start: ${started.reason}`);
  }
  return waitForJob(jobManager, started.job.jobId, isJobEnded, WAIT_OPTIONS);
}

const rawRows = (table: string): Record<string, unknown>[] => {
  const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory), { readOnly: true });
  try {
    return raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
};

/** 目印が出た場所（管理データのファイルと WAL、ジョブの行と新しい表、ジョブの画面の値）。 */
const leakedPlaces = (jobManager: AuditJobManager): readonly string[] => {
  const databasePath = resolveControlDatabasePath(workDirectory);
  const places: [string, string][] = [
    ...[databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path): [string, string] => [path, readFileSync(path).toString('latin1')]),
    ...['jobs', 'auto_login_attempts', 'auto_login_holds', 'credential_events'].map((table): [string, string] => [table, JSON.stringify(rawRows(table))]),
    ['job views', JSON.stringify(jobManager.listAuditJobs())],
  ];
  return places.flatMap(([place, text]) => MARKERS.filter((marker) => text.includes(marker)).map(() => place));
};

describe('automated login jobs (T26d-2)', () => {
  describe('START and the result of a login check', () => {
    it('sends the job kind, the credential revision and the root only, and records a successful login check without a Run', async () => {
      const metadata = await register();
      const worker = fakeWorker('auto-login-success');
      const jobManager = managerWith(worker);
      const ended = await runLoginCheck(jobManager);

      expect(ended).toMatchObject({
        jobKind: 'LOGIN_CHECK',
        state: 'FINISHED',
        exitCode: EXIT_CODES.COMPLETE,
        runId: null,
        runDirectory: null,
        resultRunStatus: null,
        endKind: null,
        failureReason: null,
        lastAuthState: 'AUTHENTICATED',
        startNew: false,
        autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null },
      });
      const start = worker.received().find((message) => message['type'] === 'START');
      const automatedLogin: WorkerStartAutomatedLogin = { credentialRevision: metadata.credentialRevision, credentialRoot: credentials.root };
      expect(start).toEqual({
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'START',
        jobId: ended.jobId,
        jobKind: 'LOGIN_CHECK',
        targetConfigPath: TEST_TARGET_PATH,
        startNew: false,
        targetConfigSha256: expect.any(String),
        authentication: {
          setup: AUTOMATED_SETUP,
          approvedTestOrigins: [TEST_ORIGIN],
          authenticationSha256: workerAuthenticationDigestOf(AUTOMATED_SETUP, [TEST_ORIGIN], { jobKind: 'LOGIN_CHECK', automatedLogin }),
          automatedLogin,
        },
      });
      // `START` に、資格情報の値・暗号文・ユーザー名がない。
      const credentialFile = readFileSync(join(credentials.store.directory, `${PROFILE_ID}.credential.json`), 'utf8');
      const ciphers = Object.values(JSON.parse(credentialFile) as Record<string, unknown>).filter((value) => typeof value === 'string' && value.length > 40);
      expect(ciphers.length).toBeGreaterThan(1);
      for (const value of [...MARKERS, ...ciphers as string[]]) {
        expect(JSON.stringify(worker.received())).not.toContain(value);
      }
      expect(readAutoLoginHold(database, PROFILE_ID)).toBeNull();
      expect(leakedPlaces(jobManager)).toEqual([]);
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it.each([
      ['a failure that was sent (held)', { result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null }, true],
      ['a result that may have been sent (held)', { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retryAfterUntil: null, formInvalidReason: null }, true],
      ['the form check before sending (not held)', { result: 'LOGIN_FORM_INVALID', submitted: 'NO', retryAfterUntil: null, formInvalidReason: 'METHOD_NOT_POST' }, false],
      ['a changed credential before sending (not held)', { result: 'CREDENTIAL_CHANGED', submitted: 'NO', retryAfterUntil: null, formInvalidReason: null }, false],
    ] as const)('records %s, and fails the job with the result', async (_name, report, held) => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-failure', report));
      const ended = await runLoginCheck(jobManager);

      expect(ended).toMatchObject({
        jobKind: 'LOGIN_CHECK',
        state: 'FAILED',
        failureReason: report.result,
        exitCode: FAILURE_EXIT_CODE,
        runId: null,
        lastAuthState: 'AUTOMATED_LOGIN_FAILED',
        autoLoginAttempt: report,
      });
      expect(readAutoLoginHold(database, PROFILE_ID)?.reason ?? null).toBe(held ? report.result : null);
      expect(rawRows('auto_login_attempts')).toMatchObject([{ form_invalid_reason: report.formInvalidReason, credential_revision: 1 }]);
      expect(leakedPlaces(jobManager)).toEqual([]);
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    // DEF-099 fix round 1: 送った後に応答がなかった回（`responseAfterSubmission: false`）は、試しの行を 2 行書く（上限で 2 回と数える）。応答が
    // あった回は 1 行。
    it.each([
      ['an unanswered submission (two attempts)', false, 2],
      ['an answered submission (one attempt)', true, 1],
    ] as const)('records %s', async (_name, responseAfterSubmission, rows) => {
      await register();
      const report = { result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null, responseAfterSubmission };
      const jobManager = managerWith(fakeWorker('auto-login-failure', report));
      const ended = await runLoginCheck(jobManager);
      expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'AUTH_RESULT_UNKNOWN', lastAuthState: 'AUTOMATED_LOGIN_FAILED' });
      const attempts = rawRows('auto_login_attempts');
      expect(attempts).toHaveLength(rows);
      expect(attempts.every((row) => row['result'] === 'AUTH_RESULT_UNKNOWN' && row['submitted'] === 'YES')).toBe(true);
      expect(readAutoLoginHold(database, PROFILE_ID)?.reason).toBe('AUTH_RESULT_UNKNOWN');
      expect(leakedPlaces(jobManager)).toEqual([]);
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('treats a login check without a result, and a Run of a login check, as protocol violations (and holds the unknown attempt)', async () => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-no-report'));
      const ended = await runLoginCheck(jobManager);
      expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
      expect(ended.autoLoginAttempt).toEqual({ result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retryAfterUntil: null, formInvalidReason: null });
      expect(readAutoLoginHold(database, PROFILE_ID)?.reason).toBe('AUTH_RESULT_UNKNOWN');

      clearAutoLoginHold(database, PROFILE_ID, stampAt(nowMs));
      nowMs += AUTO_LOGIN_MIN_INTERVAL_MS;
      await manager?.close();
      const second = managerWith(fakeWorker('auto-login-run-started'));
      expect(await runLoginCheck(second)).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION', runId: null });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);
  });

  describe('the limits through the job manager', () => {
    it('rejects a second start within 5 minutes with the next time, and starts again after the interval', async () => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      await runLoginCheck(jobManager);
      const firstStart = nowMs;

      nowMs += AUTO_LOGIN_MIN_INTERVAL_MS - SECOND;
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({
        ok: false,
        reason: 'AUTO_LOGIN_RATE_LIMITED',
        errors: [],
        nextAllowedAt: stampAt(firstStart + AUTO_LOGIN_MIN_INTERVAL_MS),
      });
      // 監査の開始も、同じ上限に当たる（自動ログインのプロファイルの監査は、自動ログインを行う）。
      expect(await jobManager.startAuditJob({ ...loginCheck(), startNew: true })).toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED' });
      expect(forks.count()).toBe(1);

      nowMs = firstStart + AUTO_LOGIN_MIN_INTERVAL_MS;
      expect((await runLoginCheck(jobManager)).state).toBe('FINISHED');
      expect(forks.count()).toBe(2);
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('holds after a failure that was sent (AUTO_LOGIN_HELD with no next time), until the hold is cleared', async () => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-failure'));
      await runLoginCheck(jobManager);
      nowMs += HOUR;
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD', errors: [], nextAllowedAt: null });
      expect(forks.count()).toBe(1);
      clearAutoLoginHold(database, PROFILE_ID, stampAt(nowMs));
      expect(await jobManager.startLoginCheck(loginCheck())).toMatchObject({ ok: true });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('records the Retry-After deadline of 429 and waits for it even after the hold is cleared', async () => {
      await register();
      const deadline = stampAt(START_TIME_MS + RETRY_AFTER_OFFSET_MS);
      const report = { result: 'RATE_LIMITED', submitted: 'YES', retryAfterUntil: deadline, formInvalidReason: null };
      const jobManager = managerWith(fakeWorker('auto-login-failure', report));
      expect(await runLoginCheck(jobManager)).toMatchObject({ failureReason: 'RATE_LIMITED', autoLoginAttempt: report });
      clearAutoLoginHold(database, PROFILE_ID, stampAt(nowMs));
      nowMs += AUTO_LOGIN_MIN_INTERVAL_MS;
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', errors: [], nextAllowedAt: deadline });
      nowMs = START_TIME_MS + RETRY_AFTER_OFFSET_MS;
      expect(await jobManager.startLoginCheck(loginCheck())).toMatchObject({ ok: true });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('rejects the eleventh start in 24 hours until the first one leaves the window', async () => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      for (let index = 0; index < AUTO_LOGIN_DAILY_MAX_ATTEMPTS; index += 1) {
        nowMs = START_TIME_MS + index * AUTO_LOGIN_MIN_INTERVAL_MS;
        expect((await runLoginCheck(jobManager)).state).toBe('FINISHED');
      }
      nowMs = START_TIME_MS + AUTO_LOGIN_DAILY_MAX_ATTEMPTS * AUTO_LOGIN_MIN_INTERVAL_MS;
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({
        ok: false,
        reason: 'AUTO_LOGIN_RATE_LIMITED',
        errors: [],
        nextAllowedAt: stampAt(START_TIME_MS + AUTO_LOGIN_DAILY_WINDOW_MS),
      });
      nowMs = START_TIME_MS + AUTO_LOGIN_DAILY_WINDOW_MS;
      expect(await jobManager.startLoginCheck(loginCheck())).toMatchObject({ ok: true });
      expect(forks.count()).toBe(AUTO_LOGIN_DAILY_MAX_ATTEMPTS + 1);
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('checks the limits again in the transaction that creates the job (two starts at the same time)', async () => {
      await register();
      // 2 つの開始が、どちらも開始の前の確かめ（暗号化の確かめ）を終えてから、ジョブを作るようにする。
      let arrived = 0;
      let release: () => void = () => undefined;
      const bothArrived = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      const gated: CredentialStore = {
        ...credentials.store,
        readMetadata: (profileId) => credentials.store.readMetadata(profileId),
        checkProtection: async () => {
          arrived += 1;
          if (arrived === 2) {
            release();
          }
          await bothArrived;
          return credentials.store.checkProtection();
        },
      };
      const jobManager = managerWith(fakeWorker('auto-login-wait'), gated);
      const results = await Promise.all([jobManager.startLoginCheck(loginCheck()), jobManager.startLoginCheck(loginCheck())]);
      const accepted = results.filter((result) => result.ok);
      const rejected = results.filter((result) => !result.ok);
      expect(accepted).toHaveLength(1);
      // 上限をトランザクションの中で確かめ直さなければ、2 つ目は `JOB_ALREADY_ACTIVE` になる。
      expect(rejected).toEqual([{ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', errors: [], nextAllowedAt: stampAt(START_TIME_MS + AUTO_LOGIN_MIN_INTERVAL_MS) }]);
      expect(rawRows('auto_login_attempts')).toHaveLength(1);
      expect(forks.count()).toBe(1);
    }, TEST_TIMEOUT_MS);

    it('closes the attempt of a worker that could not be started as AUTH_RESULT_UNKNOWN (NO), and does not hold (round 1)', async () => {
      await register();
      const missing: FakeWorker = { path: join(workDirectory, 'missing-worker.mjs'), received: () => [] };
      const jobManager = managerWith(missing);
      const started = await jobManager.startLoginCheck(loginCheck());
      if (!started.ok) throw new Error(started.reason);
      const ended = await waitForJob(jobManager, started.job.jobId, isJobEnded, WAIT_OPTIONS);
      expect(ended).toMatchObject({
        state: 'FAILED',
        failureReason: 'WORKER_START_FAILED',
        autoLoginAttempt: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'NO', retryAfterUntil: null, formInvalidReason: null },
      });
      expect(forks.count()).toBe(0);
      expect(readAutoLoginHold(database, PROFILE_ID)).toBeNull();
      // T30R2-fix-1（M-d）: 送っていないことが分かる回なので、試しの行は 1 行（2 回と数えない。手順書 `automated-login.md`）。
      expect(rawRows('auto_login_attempts')).toHaveLength(1);
      // 止めていないので、5 分の間隔の後には、また始められる。
      nowMs += AUTO_LOGIN_MIN_INTERVAL_MS;
      await manager?.close();
      expect(await managerWith(fakeWorker('auto-login-success')).startLoginCheck(loginCheck())).toMatchObject({ ok: true });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('closes the attempt of a worker that exited during the login as AUTH_RESULT_UNKNOWN (UNKNOWN), and holds', async () => {
      await register();
      const jobManager = managerWith(fakeWorker('auto-login-crash'));
      const ended = await runLoginCheck(jobManager);
      expect(ended).toMatchObject({
        state: 'INTERRUPTED',
        failureReason: 'WORKER_EXITED',
        autoLoginAttempt: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retryAfterUntil: null, formInvalidReason: null },
      });
      // T30R-fix-1（M-2）: 送信したかもしれない回は、試しの行を 2 行書く（少なく数えない側）。
      expect(rawRows('auto_login_attempts')).toEqual([
        expect.objectContaining({ job_id: ended.jobId, result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' }),
        expect.objectContaining({ job_id: `${RESENT_ATTEMPT_JOB_ID_PREFIX}${ended.jobId}`, result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' }),
      ]);
      expect(readAutoLoginHold(database, PROFILE_ID)?.reason).toBe('AUTH_RESULT_UNKNOWN');
      nowMs += HOUR;
      expect(await jobManager.startLoginCheck(loginCheck())).toMatchObject({ ok: false, reason: 'AUTO_LOGIN_HELD' });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);

    it('closes the attempt of the previous server at the recovery of the start-up of the UI server, and holds', async () => {
      await register();
      // 前の画面のサーバが、試し始めた記録とジョブの行を作った後に落ちた（ワーカーの合図の記録がない古い行）。
      const createdAt = stampAt(START_TIME_MS - HOUR);
      expect(createStartingJob(database, {
        jobId: 'job-previous-server',
        jobKind: 'LOGIN_CHECK',
        profileId: PROFILE_ID,
        profileRevision: MIN_PROFILE_REVISION,
        startNew: false,
        createdAt,
        autoLoginAttempt: { credentialRevision: 1 },
      }, () => null)).toEqual({ ok: true });
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      expect(jobManager.recoverInterruptedJobs()).toBe(1);
      expect(jobManager.getAuditJob('job-previous-server')).toMatchObject({
        state: 'INTERRUPTED',
        failureReason: 'SERVER_RESTARTED',
        autoLoginAttempt: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' },
      });
      // T30R-fix-1（M-2）: 再起動の回復で閉じた試しも 2 行。
      expect(rawRows('auto_login_attempts').map((row) => [row['job_id'], row['result'], row['submitted']])).toEqual([
        ['job-previous-server', 'AUTH_RESULT_UNKNOWN', 'UNKNOWN'],
        [`${RESENT_ATTEMPT_JOB_ID_PREFIX}job-previous-server`, 'AUTH_RESULT_UNKNOWN', 'UNKNOWN'],
      ]);
      expect(readAutoLoginHold(database, PROFILE_ID)?.reason).toBe('AUTH_RESULT_UNKNOWN');
      expect(await jobManager.startLoginCheck(loginCheck())).toMatchObject({ ok: false, reason: 'AUTO_LOGIN_HELD' });
      expect(forks.count()).toBe(0);
    }, TEST_TIMEOUT_MS);
  });

  describe('the checks before an automated login start', () => {
    it('rejects a profile without a credential, without starting a worker', async () => {
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', errors: [] });
      expect(await jobManager.startAuditJob({ ...loginCheck(), startNew: true })).toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', errors: [] });
      expect(forks.count()).toBe(0);
      expect(jobManager.listAuditJobs()).toEqual([]);
      expect(rawRows('auto_login_attempts')).toEqual([]);
    });

    it('rejects a credential of another login origin (CREDENTIAL_STALE)', async () => {
      await register(credentials.store, OTHER_TEST_ORIGIN);
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'CREDENTIAL_STALE', errors: [] });
      expect(forks.count()).toBe(0);
    });

    it('rejects the automated login when the server is not Windows (CREDENTIAL_PROTECTION_UNAVAILABLE), without starting a worker (round 1)', async () => {
      await register();
      // 資格情報のファイルはある（Windows として保存した）。画面のサーバのプラットフォームだけを、Windows でないものに差し替える。
      const notWindows = createCredentialStoreWith(credentials.root, {
        protector: createTestCredentialProtector(),
        spawnProcess: () => {
          throw new Error('no child process in this test');
        },
        now: clock,
        platform: 'linux',
        renameFile: rename,
        waitBeforeRetry: async () => undefined,
      });
      expect(await notWindows.readMetadata(PROFILE_ID)).not.toBeNull();
      const jobManager = managerWith(fakeWorker('auto-login-success'), notWindows);
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'CREDENTIAL_PROTECTION_UNAVAILABLE', errors: [] });
      expect(await jobManager.startAuditJob({ ...loginCheck(), startNew: true }))
        .toEqual({ ok: false, reason: 'CREDENTIAL_PROTECTION_UNAVAILABLE', errors: [] });
      expect(forks.count()).toBe(0);
      expect(jobManager.listAuditJobs()).toEqual([]);
      expect(rawRows('auto_login_attempts')).toEqual([]);
    });

    it('rejects when the encryption is not available (CREDENTIAL_PROTECTION_UNAVAILABLE)', async () => {
      await register();
      const broken = createCredentialStoreWith(credentials.root, {
        protector: {
          protect: async () => {
            throw new CredentialProtectionError('PROTECTION_FAILED');
          },
          unprotect: async () => {
            throw new CredentialProtectionError('PROTECTION_FAILED');
          },
        },
        spawnProcess: () => {
          throw new Error('no child process in this test');
        },
        now: clock,
        platform: 'win32',
        renameFile: rename,
        waitBeforeRetry: async () => undefined,
      });
      const jobManager = managerWith(fakeWorker('auto-login-success'), broken);
      expect(await jobManager.startLoginCheck(loginCheck())).toEqual({ ok: false, reason: 'CREDENTIAL_PROTECTION_UNAVAILABLE', errors: [] });
      expect(forks.count()).toBe(0);
    });

    it('rejects a login check of a manual login profile and of a public profile', async () => {
      expect(createProfile(database, testAuthProfile(MANUAL_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      expect(saveAuthSetup(database, MANUAL_SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
      expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      const jobManager = managerWith(fakeWorker('auto-login-success'));
      for (const profileId of [MANUAL_PROFILE_ID, PUBLIC_PROFILE_ID]) {
        expect(await jobManager.startLoginCheck({ profileId, expectedRevision: MIN_PROFILE_REVISION }))
          .toEqual({ ok: false, reason: 'AUTH_STRATEGY_NOT_EXECUTABLE', errors: [] });
      }
      expect(await jobManager.startLoginCheck({ profileId: 'Bad Id', expectedRevision: MIN_PROFILE_REVISION }))
        .toEqual({ ok: false, reason: 'INVALID_REQUEST', errors: [] });
      expect(forks.count()).toBe(0);
    });

    it('answers CREDENTIAL_IN_USE while a job of the profile has not ended', async () => {
      await register();
      expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      const jobManager = managerWith(fakeWorker('auto-login-wait'));
      expect(jobManager.checkCredentialChange(PROFILE_ID)).toEqual({ ok: true });
      const started = await jobManager.startLoginCheck(loginCheck());
      if (!started.ok) throw new Error(started.reason);
      expect(jobManager.checkCredentialChange(PROFILE_ID)).toEqual({ ok: false, reason: 'CREDENTIAL_IN_USE' });
      expect(jobManager.checkCredentialChange(PUBLIC_PROFILE_ID)).toEqual({ ok: true });
      expect(jobManager.stopAuditJob(started.job.jobId).ok).toBe(true);
      const ended = await waitForJob(jobManager, started.job.jobId, isJobEnded, WAIT_OPTIONS);
      expect(ended).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
      expect(jobManager.checkCredentialChange(PROFILE_ID)).toEqual({ ok: true });
      await expectWorkersExited(children, WAIT_OPTIONS);
    }, TEST_TIMEOUT_MS);
  });
});

describe('the environment of the worker (T26d-2)', () => {
  it('removes the debug output variables (in any case) and keeps the others', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: 'p', DEBUG: 'pw:api', debug_file: 'x.log', PwDebug: '1', PWDEBUGIMPL: '1', NODE_DEBUG: 'http', NODE_DEBUG_NATIVE: 'x',
      node_options: '--inspect', OTHER: 'kept', DEBUGGER: 'kept', NODE_ENV: 'kept',
    };
    expect(workerEnvironmentOf(source)).toEqual({ PATH: 'p', OTHER: 'kept', DEBUGGER: 'kept', NODE_ENV: 'kept' });
    expect(source['DEBUG']).toBe('pw:api');
    expect([...WORKER_EXCLUDED_ENVIRONMENT_VARIABLES])
      .toEqual(['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'PWDEBUGIMPL', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_OPTIONS']);
    expect(Object.isFrozen(WORKER_EXCLUDED_ENVIRONMENT_VARIABLES)).toBe(true);
  });

  it('forks every worker (a public audit too) without the debug output variables, and with the other variables', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const saved = Object.fromEntries(WORKER_EXCLUDED_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]));
    for (const name of WORKER_EXCLUDED_ENVIRONMENT_VARIABLES) {
      process.env[name] = 'enabled-for-the-test';
    }
    process.env['BEAKSIGHT_T26D2_KEPT'] = 'kept';
    try {
      const jobManager = managerWith(fakeWorker('finish'));
      const started = await jobManager.startAuditJob({ profileId: PUBLIC_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      if (!started.ok) throw new Error(started.reason);
      expect(await waitForJob(jobManager, started.job.jobId, isJobEnded, WAIT_OPTIONS)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE', jobKind: 'AUDIT', autoLoginAttempt: null });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      delete process.env['BEAKSIGHT_T26D2_KEPT'];
    }
    expect(forkedEnvironments).toHaveLength(1);
    const environment = forkedEnvironments[0] ?? {};
    const names = Object.keys(environment).map((name) => name.toUpperCase());
    expect(names.filter((name) => (WORKER_EXCLUDED_ENVIRONMENT_VARIABLES as readonly string[]).includes(name))).toEqual([]);
    expect(environment['BEAKSIGHT_T26D2_KEPT']).toBe('kept');
    expect(names).toContain('PATH');
    await expectWorkersExited(children, WAIT_OPTIONS);
  }, TEST_TIMEOUT_MS);
});
