// T26d-2（Task 26 の設計書 3 章、4.4、4.5、4.7、6 章）: 自動ログインのジョブを、ジョブの管理（`createAuditJobManager`）から、本物の子 process
// （`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）で、端から端まで確かめる結合テスト。
// - 子 process の入口は、テストだけの入口（一時のビルドの root に書く `.mjs`）。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの
//   口（関数の引数）で呼ぶ: 資格情報のファイルの部品は、別の process でも戻せる偽の暗号化の部品（テストだけの鍵）で作る（`openCredentialStore`）。
//   自動ログイン用の Browser は、2 つの Chromium（テストの既定の headless shell と、CLI の起動の設定の headless。後者は本番の依存のまま）で確かめる。
//   手動のログインの段の口（`launchLoginBrowser`、`onLoginPageReady`）は、呼ばれたら記録のファイルに書く（自動ログインが手動へ切り替えないことの確かめ）。
// - ログインの検証（`LOGIN_CHECK`）: 成功と各失敗の結果、送信、`Retry-After` の期限、理由のコード。Run を作らない。サーバに届いた GET と HEAD 以外の
//   要求は、送った場面ではログインの POST 1 回だけ、送る前に止まる場面では 0。
// - 自動ログインの後の監査（`AUDIT`）: 読み取りだけで COMPLETE（GET と HEAD 以外はログインの POST 1 回だけ）。自動ログインの失敗では、監査を始めず、
//   headed のブラウザ（手動のログインの段）を開かない。セッションが切れて止まった Run の再開で、自動ログインし直す（試しの記録が 2 つ。上限に数える）。
// - 本物の DPAPI（Windows だけ。一時のフォルダ）: 本物の暗号化の部品で資格情報を保存し、本番の部品のままのワーカーでログインの検証が成功する。
// - 目印（資格情報の値、セッションの値）: 管理データのファイルと WAL、ワーカーと親の標準出力と標準エラー、IPC の記録（親が受けたすべて、親が送った
//   `START`）、ジョブの行と新しい表、Run のディレクトリ（監査のとき。ZIP の中身を含む）のどこにも出ない。
// 自動ログインは Windows だけで動く（サーバの開始の確かめで強制する。round 1）ので、この端から端は Windows だけで行い、ほかでは理由を出して飛ばす。
// サーバは 127.0.0.1 だけで待ち受ける。作業のディレクトリ、
// 管理データ、資格情報のフォルダ、出力先は、一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import {  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createCredentialStore, type CredentialStore } from '../../src/control/credentials/credential-store.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS, dateOfCompactUtcTimestamp } from '../../src/control/job/auto-login-limits.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { wait } from '../../src/core/deadline.js';
import { createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_PATHS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  FIXTURE_RETRY_AFTER_SECONDS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFormVariant,
  type AutomatedLoginOutcome,
} from '../helpers/automated-login-fixture.js';
import { AUTO_LOGIN_ENTRY_LAUNCHES, autoLoginWorkerEntrySource, type AutoLoginEntryLaunch } from '../helpers/auto-login-worker-entry.js';
import {
  AUTO_LOGIN_CONTROL_TABLES,
  databaseFilePlaces,
  databaseTablesText,
  filesUnder,
  nonReadRequestsOf,
  placesWithMarkers,
  textLeakPlace,
} from '../helpers/leak-places.js';
import { isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import { descendantsOf, listProcesses } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import {
  createPortableTestCredentialProtector,
  createPortableTestKey,
  createTestCredentialStore,
  type TestCredentialStore,
} from '../helpers/test-credential-store.js';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login runs only on Windows (the server start check rejects it elsewhere), and this end to end uses the real DPAPI';

const SUITE_TIMEOUT_MS = 600_000;
const JOB_TIMEOUT_MS = 180_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 20_000;
const SECOND_MS = 1_000;
const MAX_PAGES = 3;
const START_TIME_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const PROFILE_ID = 'example-auto-fork';
const TARGET_CONFIG_PATH = 'local/targets/auto-fork.json';
const ENTRY_FILE_NAME = 'automated-login-test-entry.mjs';
const MANUAL_STAGE_RECORD = 'manual-login-stage.log';

/** 自動ログイン用の Browser の起動（テストの既定の headless shell と、CLI の起動の設定の headless）。 */
const LAUNCHES = AUTO_LOGIN_ENTRY_LAUNCHES;
type Launch = AutoLoginEntryLaunch;

let build: TemporaryBuild;
let fixture: AutomatedLoginFixture;
const fixtureCredentials = { username: '', password: '' };
const children: ChildProcess[] = [];

/** 1 つのテストの作業の場所（一時のフォルダ）と、記録。 */
interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly credentials: TestCredentialStore;
  readonly key: string;
  /** 親が受けたすべてのメッセージ。 */
  readonly received: unknown[];
  /** 親が送ったメッセージ（`START` と `STOP`）。 */
  readonly sent: unknown[];
  /** ワーカーの標準出力と標準エラー。 */
  workerOutput: string;
  /** 親（このテストの process）の標準出力と標準エラー。 */
  parentOutput: string;
  readonly workerPids: number[];
  nowMs: number;
  manager: AuditJobManager | undefined;
  readonly contexts: Map<string, ProfileValidationContext>;
}

let workspace: Workspace | undefined;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const current = (): Workspace => {
  if (workspace === undefined) {
    throw new Error('no workspace');
  }
  return workspace;
};

beforeAll(async () => {
  if (!IS_WINDOWS) {
    return;
  }
  build = await buildIntoTemporaryDirectory();
  fixtureCredentials.username = `user-${createPortableTestKey().slice(0, 24)}`;
  fixtureCredentials.password = `pass-${createPortableTestKey().slice(0, 24)}`;
  fixture = await startAutomatedLoginFixture({ username: fixtureCredentials.username, password: fixtureCredentials.password });
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of leftovers) {
    child.kill();
  }
  await fixture?.close();
  await build?.remove();
  expect(leftovers.length, 'workers left running after the tests').toBe(0);
}, SUITE_TIMEOUT_MS);

beforeEach(async () => {
  if (!IS_WINDOWS) {
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-auto-login-fork-'));
  const key = createPortableTestKey();
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    credentials: await createTestCredentialStore({ protector: createPortableTestCredentialProtector(key) }),
    key,
    received: [],
    sent: [],
    workerOutput: '',
    parentOutput: '',
    workerPids: [],
    nowMs: START_TIME_MS,
    manager: undefined,
    contexts: new Map(),
  };
  const capture = (write: typeof process.stdout.write) => ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (workspace !== undefined) {
      workspace.parentOutput += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stdout.write = capture(originalStdoutWrite);
  process.stderr.write = capture(originalStderrWrite);
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (workspace === undefined) {
    return;
  }
  await workspace.manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  closeControlDatabase(workspace.database);
  await workspace.credentials.remove();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

/** テストだけの入口を書き、そのパスを返す（`portable` が偽なら、本番の資格情報の部品のまま）。 */
async function writeEntry(launch: Launch, portable: boolean, key: string): Promise<string> {
  const space = current();
  const path = join(build.rootDirectory, `${launch}-${portable ? 'portable' : 'production'}-${Date.now()}-${ENTRY_FILE_NAME}`);
  // 手動のログインの段の口は、呼ばれたら記録して失敗する（自動ログインが手動へ切り替えないことの確かめ）。
  const source = autoLoginWorkerEntrySource({
    launch,
    manualStageRecord: join(space.directory, MANUAL_STAGE_RECORD),
    protectorKey: key,
    portableCredentialStore: portable,
    manualStage: { kind: 'REJECT' },
  });
  await writeFile(path, source, 'utf8');
  return path;
}

/** IPC と標準出力・標準エラーを記録しながら fork する。 */
const recordingFork: AuditWorkerForker = (modulePath, args, options) => {
  const space = current();
  return createRecordingFork({
    onChild: (child) => {
      children.push(child);
      if (child.pid !== undefined) {
        space.workerPids.push(child.pid);
      }
    },
    onReceived: (message) => space.received.push(message),
    onOutput: (chunk) => { space.workerOutput += chunk; },
    onSent: (message) => space.sent.push(message),
  })(modulePath, args, options);
};

/** ターゲット設定を書き、プロファイルと認証の設定を保存する。 */
async function prepareProfile(origin: string, startPath: string, setup: AuthSetup): Promise<void> {
  const space = current();
  await mkdir(join(space.directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(space.directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('auto-fork', origin, startPath, {
    crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: join(space.directory, 'auto-fork-output') },
  })), 'utf8');
  const targetConfig = await loadConfig(join(space.directory, TARGET_CONFIG_PATH));
  space.contexts.set(TARGET_CONFIG_PATH, { targetConfig });
  const resolveContext = (path: string): ProfileValidationContext | undefined => space.contexts.get(path);
  const created = createProfile(space.database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: TARGET_CONFIG_PATH,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'AUTOMATED_LOGIN',
    approvedTestOrigins: [origin],
    environmentEvidenceRef: 'evidence/example-auto-fork/isolation-check-1',
  }, { resolveContext });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。
  hideJobBrowser(space.database, PROFILE_ID);
  const saved = saveAuthSetup(space.database, setup, { resolveContext });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
}

/** ジョブの管理を作る（入口、資格情報の部品、時刻）。 */
async function managerFor(launch: Launch, options: { readonly portable?: boolean; readonly workerKey?: string; readonly store?: CredentialStore; readonly root?: string } = {}): Promise<AuditJobManager> {
  const space = current();
  const portable = options.portable ?? true;
  const entry = await writeEntry(launch, portable, options.workerKey ?? space.key);
  await space.manager?.close();
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: space.directory,
    workerPath: entry,
    resolveContext: (path) => space.contexts.get(path),
    forkWorker: recordingFork,
    now: () => new Date(space.nowMs),
    credentials: { root: options.root ?? space.credentials.root, store: options.store ?? space.credentials.store },
  });
  return space.manager;
}

/** ジョブが終わるまで待つ（CC-072: 待ちはジョブの管理のテストの補助 `waitForJob`）。 */
const waitForEnd = (jobManager: AuditJobManager, jobId: string): Promise<AuditJobView> =>
  waitForJob(jobManager, jobId, isJobEnded, { limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

/** ワーカーがすべて終わり、その子孫（Chromium）が残っていないことを確かめる。 */
async function expectNoProcessLeft(): Promise<void> {
  const space = current();
  const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
  for (;;) {
    const workersDone = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const processes = await listProcesses();
    const descendants = space.workerPids.flatMap((pid) => descendantsOf(pid, processes));
    if (workersDone && descendants.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      expect(descendants.map(({ name }) => name), 'processes left after the worker exited').toEqual([]);
      expect(workersDone).toBe(true);
      return;
    }
    await wait(WAIT_POLL_MS);
  }
}

/** 目印が出た場所（管理データのファイルと WAL、表、IPC の記録、標準出力と標準エラー、Run のディレクトリ）。 */
function leakedPlaces(markers: readonly string[]): readonly string[] {
  const space = current();
  const databasePath = resolveControlDatabasePath(space.directory);
  return placesWithMarkers([
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, AUTO_LOGIN_CONTROL_TABLES)),
    textLeakPlace('ipc received', JSON.stringify(space.received)),
    textLeakPlace('ipc sent', JSON.stringify(space.sent)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('parent output', space.parentOutput),
    textLeakPlace('job views', JSON.stringify(space.manager?.listAuditJobs() ?? [])),
    ...filesUnder(join(space.directory, 'auto-fork-output')),
  ], markers);
}

const startTypes = (space: Workspace): readonly unknown[] => space.sent.filter((message) => (message as Record<string, unknown>)['type'] === 'START');

const workerTypes = (space: Workspace): readonly string[] => space.received
  .map((message) => String((message as Record<string, unknown>)['type']))
  .filter((type) => type !== 'HEARTBEAT');

// ---------------------------------------------------------------------------------------------------------------
// ログインの検証（`LOGIN_CHECK`）
// ---------------------------------------------------------------------------------------------------------------

/** ログインの画面の fixture の認証の設定。 */
const fixtureSetupOf = (variant: AutomatedLoginFormVariant, outcome: AutomatedLoginOutcome): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: fixture.formUrl(variant, outcome),
  loginPostEndpoints: [{ origin: fixture.originA, path: fixture.authPath(outcome) }],
  successCondition: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success,
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: [AUTOMATED_LOGIN_FIXTURE_PATHS.home],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
    passwordSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.password,
    submitSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit,
    failureConditions: {
      invalidCredentials: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials,
      accountLocked: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked,
      mfaRequired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.mfaRequired,
      credentialExpired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.credentialExpired,
    },
  },
});

interface LoginCheckCase {
  readonly name: string;
  readonly variant: AutomatedLoginFormVariant;
  readonly outcome: AutomatedLoginOutcome;
  readonly result: string;
  readonly submitted: 'YES' | 'NO';
  readonly formInvalidReason: string | null;
  /** ワーカーが、別の鍵の偽の暗号化の部品を使う（復号できない）。 */
  readonly otherWorkerKey?: boolean;
}

const LOGIN_CHECK_CASES: readonly LoginCheckCase[] = [
  { name: 'success', variant: 'standard', outcome: 'success', result: 'SUCCEEDED', submitted: 'YES', formInvalidReason: null },
  { name: 'invalid credentials', variant: 'standard', outcome: 'invalid', result: 'INVALID_CREDENTIALS', submitted: 'YES', formInvalidReason: null },
  { name: 'account locked', variant: 'standard', outcome: 'locked', result: 'ACCOUNT_LOCKED', submitted: 'YES', formInvalidReason: null },
  { name: 'MFA required', variant: 'standard', outcome: 'mfa', result: 'MFA_REQUIRED', submitted: 'YES', formInvalidReason: null },
  { name: 'credential expired', variant: 'standard', outcome: 'expired', result: 'CREDENTIAL_EXPIRED', submitted: 'YES', formInvalidReason: null },
  { name: '429 with Retry-After', variant: 'standard', outcome: 'rate-seconds', result: 'RATE_LIMITED', submitted: 'YES', formInvalidReason: null },
  { name: '500', variant: 'standard', outcome: 'error', result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', formInvalidReason: null },
  { name: 'a GET form', variant: 'get', outcome: 'success', result: 'LOGIN_FORM_INVALID', submitted: 'NO', formInvalidReason: 'METHOD_NOT_POST' },
  {
    name: 'a credential the worker cannot decrypt', variant: 'standard', outcome: 'success', result: 'CREDENTIAL_UNAVAILABLE', submitted: 'NO',
    formInvalidReason: null, otherWorkerKey: true,
  },
];

describe.skipIf(!IS_WINDOWS)(`T26d-2: the automated login jobs end to end${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, () => {
  describe.each(LAUNCHES)('the login check with the %s Chromium', (launch) => {
    it.each(LOGIN_CHECK_CASES)('$name', async (testCase) => {
      const space = current();
      await prepareProfile(fixture.originA, AUTOMATED_LOGIN_FIXTURE_PATHS.home, fixtureSetupOf(testCase.variant, testCase.outcome));
      await space.credentials.store.register({
        profileId: PROFILE_ID,
        loginOrigin: fixture.originA,
        username: fixtureCredentials.username,
        password: fixtureCredentials.password,
      });
      const jobManager = await managerFor(launch, testCase.otherWorkerKey === true ? { workerKey: createPortableTestKey() } : {});
      const since = fixture.requests.length;
      const before = Date.now();
      const started = await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (!started.ok) {
        throw new Error(`the login check did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      const after = Date.now();
      const succeeded = testCase.result === 'SUCCEEDED';

      expect(ended).toMatchObject({
        jobKind: 'LOGIN_CHECK',
        state: succeeded ? 'FINISHED' : 'FAILED',
        failureReason: succeeded ? null : testCase.result,
        exitCode: succeeded ? EXIT_CODES.COMPLETE : FAILURE_EXIT_CODE,
        runId: null,
        runDirectory: null,
        lastAuthState: succeeded ? 'AUTHENTICATED' : 'AUTOMATED_LOGIN_FAILED',
        autoLoginAttempt: { result: testCase.result, submitted: testCase.submitted, formInvalidReason: testCase.formInvalidReason },
      });
      const retryAfterUntil = ended.autoLoginAttempt?.retryAfterUntil ?? null;
      if (testCase.result === 'RATE_LIMITED') {
        const until = dateOfCompactUtcTimestamp(retryAfterUntil ?? '').getTime();
        expect(until).toBeGreaterThanOrEqual(before + FIXTURE_RETRY_AFTER_SECONDS * SECOND_MS - SECOND_MS);
        expect(until).toBeLessThanOrEqual(after + FIXTURE_RETRY_AFTER_SECONDS * SECOND_MS + SECOND_MS);
      } else {
        expect(retryAfterUntil).toBeNull();
      }
      // Run を作らない（監査の段のメッセージがない）。
      expect(workerTypes(space)).not.toContain('RUN_STARTED');
      expect(workerTypes(space)).not.toContain('FINISHED');
      expect(existsSync(join(space.directory, 'auto-fork-output'))).toBe(false);
      // GET と HEAD 以外の要求は、送った場面ではログインの POST 1 回だけ、送る前に止まる場面では 0。
      const posts = nonReadRequestsOf(fixture.requests, since);
      expect(posts).toEqual(testCase.submitted === 'YES' ? [`POST ${fixture.authPath(testCase.outcome)}`] : []);
      // 資格情報の目印は、ログインの POST の本文のほかに、サーバに届いた要求に現れない（URL の query にもない）。
      const markers = [fixtureCredentials.username, fixtureCredentials.password];
      const carriers = fixture.requests.slice(since).filter(({ path, body }) => markers.some((marker) => path.includes(marker) || body.includes(marker)));
      expect(carriers.map(({ method, path }) => `${method} ${path}`)).toEqual(posts);
      // 手動のログインの段へ切り替えない。
      expect(existsSync(join(space.directory, MANUAL_STAGE_RECORD))).toBe(false);
      expect(startTypes(space)).toHaveLength(1);
      expect(leakedPlaces(markers)).toEqual([]);
      await expectNoProcessLeft();
    }, JOB_TIMEOUT_MS);
  });

  // -------------------------------------------------------------------------------------------------------------
  // 自動ログインの後の監査（`AUDIT`）
  // -------------------------------------------------------------------------------------------------------------

  /** 認証つきの fixture のサイトの、自動ログインの認証の設定。 */
  const siteSetupOf = (site: AuthenticatedSite): AuthSetup => ({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: PROFILE_ID,
    profileRevision: MIN_PROFILE_REVISION,
    loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
    loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
    successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [AUTH_SITE_PATHS.adminLogout],
    auditPathPrefixes: [AUTH_SITE_PATHS.admin],
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: {
      usernameSelector: AUTH_SITE_LOGIN_FIELDS.user,
      passwordSelector: AUTH_SITE_LOGIN_FIELDS.pass,
      submitSelector: AUTH_SITE_LOGIN_FIELDS.submit,
      failureConditions: {
        invalidCredentials: { pathPrefix: AUTH_SITE_PATHS.login, selector: '#login-failed' },
        accountLocked: null,
        mfaRequired: null,
        credentialExpired: null,
      },
    },
  });

  /** サイトの正しい資格情報（値はテストに返さないので、欄に入れる口で受け取る）。 */
  const siteCredentialsOf = async (site: AuthenticatedSite): Promise<{ readonly username: string; readonly password: string }> => {
    const values = new Map<string, string>();
    await site.fillCredentials(async (selector, value) => {
      values.set(selector, value);
    });
    return { username: values.get(AUTH_SITE_LOGIN_FIELDS.user) ?? '', password: values.get(AUTH_SITE_LOGIN_FIELDS.pass) ?? '' };
  };

  /** 監査のジョブを始めて、終わるまで待つ。 */
  const runAudit = async (jobManager: AuditJobManager, startNew: boolean): Promise<AuditJobView> => {
    const started = await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew });
    if (!started.ok) {
      throw new Error(`the audit job did not start: ${started.reason} ${JSON.stringify(started)}`);
    }
    return waitForEnd(jobManager, started.job.jobId);
  };

  describe.each(LAUNCHES)('the audit after the automated login with the %s Chromium', (launch) => {
    it('logs in automatically, audits read only to COMPLETE, and sends no other non-read request than the login POST', async () => {
      const site = await startAuthenticatedSite({ loginForm: true });
      try {
        const space = current();
        await prepareProfile(site.originA, AUTH_SITE_PATHS.admin, siteSetupOf(site));
        const credential = await siteCredentialsOf(site);
        await space.credentials.store.register({ profileId: PROFILE_ID, loginOrigin: site.originA, ...credential });
        const jobManager = await managerFor(launch);
        const ended = await runAudit(jobManager, true);

        expect(ended).toMatchObject({
          jobKind: 'AUDIT',
          state: 'FINISHED',
          resultRunStatus: 'COMPLETE',
          exitCode: EXIT_CODES.COMPLETE,
          lastAuthState: 'AUTHENTICATED',
          failureReason: null,
          autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null },
        });
        expect(site.successfulLogins).toBe(1);
        expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
        expect(workerTypes(space)).toContain('RUN_STARTED');
        expect(existsSync(join(space.directory, MANUAL_STAGE_RECORD))).toBe(false);
        const markers = [credential.username, credential.password, ...site.secretValues()];
        expect(filesUnder(join(space.directory, 'auto-fork-output')).some(([path]) => path.includes('.zip!'))).toBe(true);
        expect(leakedPlaces(markers)).toEqual([]);
        await expectNoProcessLeft();
      } finally {
        await site.close();
      }
    }, JOB_TIMEOUT_MS);

    it('does not start the audit and never opens the manual (headed) login when the automated login fails', async () => {
      const site = await startAuthenticatedSite({ loginForm: true });
      try {
        const space = current();
        await prepareProfile(site.originA, AUTH_SITE_PATHS.admin, siteSetupOf(site));
        const credential = await siteCredentialsOf(site);
        await space.credentials.store.register({ profileId: PROFILE_ID, loginOrigin: site.originA, username: credential.username, password: `${credential.password}-wrong` });
        const jobManager = await managerFor(launch);
        const ended = await runAudit(jobManager, true);

        expect(ended).toMatchObject({
          jobKind: 'AUDIT',
          state: 'FAILED',
          failureReason: 'INVALID_CREDENTIALS',
          runId: null,
          lastAuthState: 'AUTOMATED_LOGIN_FAILED',
          autoLoginAttempt: { result: 'INVALID_CREDENTIALS', submitted: 'YES' },
        });
        expect(site.successfulLogins).toBe(0);
        expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
        expect(workerTypes(space)).not.toContain('RUN_STARTED');
        expect(existsSync(join(space.directory, 'auto-fork-output'))).toBe(false);
        // 手動のログインの段（headed のログイン用の Browser の起動と、人の操作の代わりの口）を、一度も呼ばない。
        expect(existsSync(join(space.directory, MANUAL_STAGE_RECORD))).toBe(false);
        expect(leakedPlaces([credential.username, credential.password, `${credential.password}-wrong`])).toEqual([]);
        await expectNoProcessLeft();
      } finally {
        await site.close();
      }
    }, JOB_TIMEOUT_MS);

    it('logs in automatically again when it resumes a Run stopped by a lost session (counted as another attempt)', async () => {
      const site = await startAuthenticatedSite({ loginForm: true, expireFirstSessionAtPath: AUTH_SITE_PATHS.adminSecond });
      try {
        const space = current();
        await prepareProfile(site.originA, AUTH_SITE_PATHS.admin, siteSetupOf(site));
        const credential = await siteCredentialsOf(site);
        await space.credentials.store.register({ profileId: PROFILE_ID, loginOrigin: site.originA, ...credential });
        const jobManager = await managerFor(launch);
        const stopped = await runAudit(jobManager, true);
        expect(stopped).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', lastAuthState: 'SESSION_LOST' });
        expect(stopped.autoLoginAttempt).toMatchObject({ result: 'SUCCEEDED', submitted: 'YES' });

        // 5 分の間隔の中では、再開も始められない（上限に数える）。
        expect(await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: false }))
          .toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED' });
        space.nowMs += AUTO_LOGIN_MIN_INTERVAL_MS;
        const resumed = await runAudit(jobManager, false);
        expect(resumed).toMatchObject({
          state: 'FINISHED',
          resultRunStatus: 'COMPLETE',
          runId: stopped.runId,
          lastAuthState: 'AUTHENTICATED',
          autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES' },
        });
        expect(site.successfulLogins).toBe(2);
        expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`, `POST ${AUTH_SITE_PATHS.login}`]);
        const attempts = new DatabaseSync(resolveControlDatabasePath(space.directory), { readOnly: true });
        try {
          expect(attempts.prepare('SELECT result, submitted FROM auto_login_attempts ORDER BY attempt_id').all())
            .toEqual([{ result: 'SUCCEEDED', submitted: 'YES' }, { result: 'SUCCEEDED', submitted: 'YES' }]);
        } finally {
          attempts.close();
        }
        expect(existsSync(join(space.directory, MANUAL_STAGE_RECORD))).toBe(false);
        expect(leakedPlaces([credential.username, credential.password, ...site.secretValues()])).toEqual([]);
        await expectNoProcessLeft();
      } finally {
        await site.close();
      }
    }, JOB_TIMEOUT_MS);
  });

  // -------------------------------------------------------------------------------------------------------------
  // 本物の DPAPI
  // -------------------------------------------------------------------------------------------------------------

  it('logs in with a credential saved by the real DPAPI protector, through the production credential component of the worker', async () => {
    const space = current();
    const realRoot = await mkdtemp(join(tmpdir(), 'beaksight-auto-login-dpapi-'));
    try {
      const realStore = createCredentialStore(realRoot);
      expect(await realStore.checkProtection()).toBe('AVAILABLE');
      await prepareProfile(fixture.originA, AUTOMATED_LOGIN_FIXTURE_PATHS.home, fixtureSetupOf('standard', 'success'));
      await realStore.register({
        profileId: PROFILE_ID,
        loginOrigin: fixture.originA,
        username: fixtureCredentials.username,
        password: fixtureCredentials.password,
      });
      const jobManager = await managerFor('cli', { portable: false, store: realStore, root: realRoot });
      const since = fixture.requests.length;
      const started = await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (!started.ok) {
        throw new Error(`the login check did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      expect(ended).toMatchObject({
        state: 'FINISHED',
        lastAuthState: 'AUTHENTICATED',
        autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES' },
      });
      expect(readJob(space.database, started.job.jobId)?.exitCode).toBe(EXIT_CODES.COMPLETE);
      expect(nonReadRequestsOf(fixture.requests, since)).toEqual([`POST ${fixture.authPath('success')}`]);
      const markers = [fixtureCredentials.username, fixtureCredentials.password];
      const credentialFiles = filesUnder(realRoot);
      expect(credentialFiles.length).toBe(1);
      expect(credentialFiles.filter(([, bytes]) => markers.some((marker) => bytes.includes(Buffer.from(marker, 'utf8'))))).toEqual([]);
      expect(leakedPlaces(markers)).toEqual([]);
      await expectNoProcessLeft();
    } finally {
      await rm(realRoot, { recursive: true, force: true });
    }
  }, JOB_TIMEOUT_MS);
});
