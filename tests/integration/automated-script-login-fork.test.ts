// T36c（Task 36 の設計書 3.3・3.4・4 章・5 章の 1〜4）: スクリプトで送るログインの自動ログインのジョブを、ジョブの管理（`createAuditJobManager`）から、
// 本物の子 process（`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）で、端から端まで確かめる。
// - 子 process の入口は、自動ログインの fork のテストと同じテストだけの入口（`autoLoginWorkerEntrySource`。資格情報のファイルの部品は、別の process でも
//   戻せる偽の暗号化の部品）。自動ログイン用の Browser は、テストの既定の headless shell と、CLI の起動の設定の両方。
// - サイトは fixture（`startSpaAuthSite`）。プロファイルの許可 Origin はアプリの Origin、承認したサービスの Origin は token と API のバックエンドの
//   Origin。認証の設定は版 3 のスクリプトで送るログイン（`SCRIPT_REQUEST`）の自動ログイン。
// - ログインの検証（`LOGIN_CHECK`）の成功と、自動ログインからの監査（`AUDIT`。COMPLETE）。届いた読み取りでない要求は token の送信 1 回だけ。
//   ジョブの行に、スクリプトで送るログインの数（`loginStage.scriptLogin`）が残る。
// - 誤ったパスワード（400）は `INVALID_CREDENTIALS` で止める、429 は `RATE_LIMITED` と次に始められる時刻、503 と応答なしは `AUTH_RESULT_UNKNOWN` で
//   止める。送信を止めない form は、資格情報を含む要求がサーバに届かず `AUTH_RESULT_UNKNOWN` で止める（設計者の判断 3）。止めたかは、最小の間隔の後の
//   次の開始が `AUTO_LOGIN_HELD` で拒まれることで確かめる。
// - 資格情報の目印が、管理データ（WAL を含む）、IPC（親が受けたすべてと送ったもの）、ワーカーの標準出力と標準エラー、ジョブの一覧、成果物に出ない。
// 作業のディレクトリ、管理データ、資格情報のフォルダ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。自動ログインは Windows だけで
// 動く（サーバの開始の確かめで強制する）ので、この端から端は Windows だけで行う。
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../src/control/job/auto-login-limits.js';
import { clearAutoLoginHold, readAutoLoginLimitInputs } from '../../src/control/job/auto-login-store.js';
import { formatCompactUtcTimestamp, parseCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { AUTO_LOGIN_ENTRY_LAUNCHES, autoLoginWorkerEntrySource, type AutoLoginEntryLaunch } from '../helpers/auto-login-worker-entry.js';
import { isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import {
  AUTO_LOGIN_CONTROL_TABLES,
  databaseFilePlaces,
  databaseTablesText,
  placesWithMarkers,
  READ_METHODS,
  textLeakPlace,
} from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import {
  createPortableTestCredentialProtector,
  createPortableTestKey,
  createTestCredentialStore,
  type TestCredentialStore,
} from '../helpers/test-credential-store.js';
import { createForkTestProfile, createRecordingFork, readRunArtifacts } from '../helpers/worker-fork-support.js';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login runs only on Windows (the server start check rejects it elsewhere)';

const SUITE_TIMEOUT_MS = 600_000;
const JOB_TIMEOUT_MS = 180_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const MAX_PAGES = 3;
const START_TIME_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
/** T36R-fix（T36R の M-4）: 送った後に応答がなかった回の試しの行の数（DEF-099。上限で 2 回と数える）。 */
const UNANSWERED_ATTEMPT_ROWS = 2;
const PROFILE_ID = 'example-script-auto-fork';
const TARGET_CONFIG_PATH = 'local/targets/script-auto-fork.json';
const OUTPUT_DIRECTORY_NAME = 'script-auto-fork-output';
const ENTRY_FILE_NAME = 'script-automated-login-test-entry.mjs';
const MANUAL_STAGE_RECORD = 'manual-login-stage.log';
const EXISTING_NAME = '既存花子';
const WRONG_PASSWORD_SUFFIX = '-wrong';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });

let build: TemporaryBuild;
const children: ChildProcess[] = [];

/** 1 つの場面の作業の場所と記録。 */
interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly credentials: TestCredentialStore;
  readonly key: string;
  readonly received: unknown[];
  readonly sent: unknown[];
  workerOutput: string;
  nowMs: number;
  manager: AuditJobManager | undefined;
  site: SpaAuthSite | undefined;
  targetConfig: AuditConfig | undefined;
}

let workspace: Workspace | undefined;

const current = (): Workspace => {
  if (workspace === undefined) {
    throw new Error('no workspace');
  }
  return workspace;
};

beforeAll(async () => {
  if (IS_WINDOWS) {
    build = await buildIntoTemporaryDirectory();
  }
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of leftovers) {
    child.kill();
  }
  await build?.remove();
  expect(leftovers.length, 'workers left running after the tests').toBe(0);
}, SUITE_TIMEOUT_MS);

afterEach(async () => {
  if (workspace === undefined) {
    return;
  }
  await workspace.manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  closeControlDatabase(workspace.database);
  await workspace.credentials.remove();
  await workspace.site?.close();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

/** 作業の場所を作り、サイトを始める。 */
async function prepare(options: SpaAuthSiteOptions): Promise<Workspace> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-script-auto-fork-'));
  const key = createPortableTestKey();
  const site = await startSpaAuthSite(options);
  site.addMember(EXISTING_NAME);
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    credentials: await createTestCredentialStore({ protector: createPortableTestCredentialProtector(key) }),
    key,
    received: [],
    sent: [],
    workerOutput: '',
    nowMs: START_TIME_MS,
    manager: undefined,
    site,
    targetConfig: undefined,
  };
  return workspace;
}

/** fixture の資格情報（欄の順に、メールアドレスとパスワード）。 */
const credentialsOf = async (site: SpaAuthSite): Promise<{ readonly username: string; readonly password: string }> => {
  const values: string[] = [];
  await site.fillCredentials(async (_selector, value) => {
    values.push(value);
  });
  const [username = '', password = ''] = values;
  return { username, password };
};

/** スクリプトで送るログインの自動ログインの認証の設定。 */
const setupOf = (site: SpaAuthSite): AuthSetupV3 => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout, '/admin/members'],
  auditPathPrefixes: [SPA_APP_PATHS.admin],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: SPA_LOGIN_FIELDS.email,
    passwordSelector: SPA_LOGIN_FIELDS.password,
    submitSelector: SPA_LOGIN_FIELDS.submit,
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
  loginSideRequests: [],
  successStorageKey: { origin: site.appOrigin, ...FIXTURE_KEY },
});

/** IPC と標準出力・標準エラーを記録しながら fork する。 */
const recordingFork: AuditWorkerForker = (modulePath, args, options) => {
  const space = current();
  return createRecordingFork({
    onChild: (child) => children.push(child),
    onReceived: (message) => space.received.push(message),
    onOutput: (chunk) => { space.workerOutput += chunk; },
    onSent: (message) => space.sent.push(message),
  })(modulePath, args, options);
};

/** プロファイルと認証の設定と資格情報を保存し、ジョブの管理を作る（`passwordSuffix` を足すと、誤ったパスワードを保存する）。 */
async function managerFor(launch: AutoLoginEntryLaunch, passwordSuffix = ''): Promise<AuditJobManager> {
  const space = current();
  const site = space.site;
  if (site === undefined) {
    throw new Error('no site');
  }
  await mkdir(join(space.directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(space.directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig(PROFILE_ID, site.appOrigin, SPA_APP_PATHS.admin, {
    crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
    audit: { screenshots: false },
    output: { directory: join(space.directory, OUTPUT_DIRECTORY_NAME) },
  })), 'utf8');
  space.targetConfig = await loadConfig(join(space.directory, TARGET_CONFIG_PATH));
  const resolveContext = (): { readonly targetConfig: AuditConfig } | undefined =>
    (space.targetConfig === undefined ? undefined : { targetConfig: space.targetConfig });
  const profile = createForkTestProfile(space.database, {
    profileId: PROFILE_ID,
    targetConfigPath: TARGET_CONFIG_PATH,
    auth: 'AUTOMATED_LOGIN',
    approvedTestOrigins: [site.appOrigin],
    approvedServiceOrigins: [site.backendOrigin],
  }, resolveContext);
  expect(profile.ok, JSON.stringify(profile)).toBe(true);
  const saved = saveAuthSetup(space.database, setupOf(site), { resolveContext });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const credentials = await credentialsOf(site);
  await space.credentials.store.register({
    profileId: PROFILE_ID,
    loginOrigin: site.appOrigin,
    username: credentials.username,
    password: `${credentials.password}${passwordSuffix}`,
  });
  const entry = join(build.rootDirectory, `${launch}-${Date.now()}-${ENTRY_FILE_NAME}`);
  await writeFile(entry, autoLoginWorkerEntrySource({
    launch,
    manualStageRecord: join(space.directory, MANUAL_STAGE_RECORD),
    protectorKey: space.key,
    portableCredentialStore: true,
    manualStage: { kind: 'REJECT' },
  }), 'utf8');
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: space.directory,
    workerPath: entry,
    resolveContext,
    forkWorker: recordingFork,
    now: () => new Date(space.nowMs),
    credentials: { root: space.credentials.root, store: space.credentials.store },
  });
  return space.manager;
}

const waitForEnd = (jobManager: AuditJobManager, jobId: string): Promise<AuditJobView> =>
  waitForJob(jobManager, jobId, isJobEnded, { limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

/** バックエンドに届いた（事前確認でない）読み取りでない要求の path（query を除く）。 */
const backendNonReads = (site: SpaAuthSite): readonly string[] => site.requests
  .filter((request) => request.origin !== 'app' && !request.preflight && !READ_METHODS.has(request.method))
  .map(({ path }) => path.split('?')[0] ?? '');

/** 目印が出た場所（管理データのファイルと WAL、表、IPC、ワーカーの出力、ジョブの一覧、成果物）。 */
function leakedPlaces(markers: readonly string[]): readonly string[] {
  const space = current();
  const databasePath = resolveControlDatabasePath(space.directory);
  return placesWithMarkers([
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, AUTO_LOGIN_CONTROL_TABLES)),
    textLeakPlace('ipc received', JSON.stringify(space.received)),
    textLeakPlace('ipc sent', JSON.stringify(space.sent)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('job views', JSON.stringify(space.manager?.listAuditJobs() ?? [])),
    ...readRunArtifacts(join(space.directory, OUTPUT_DIRECTORY_NAME)).places,
  ], markers);
}

describe.skipIf(!IS_WINDOWS)(`T36c: the automated script login jobs end to end${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, () => {
  describe.each(AUTO_LOGIN_ENTRY_LAUNCHES)('with the %s Chromium for the automated login', (launch) => {
    // T36R-fix（ユーザーの判断「ログインの画面に form の要素がなければ止めるのでは監査が開始できない」）: form の要素のないログインの画面でも成功する。
    it.each<readonly [string, SpaAuthSiteOptions]>([
      ['the login form', {}],
      ['the login page without a form element', { loginLayout: 'formless' }],
    ])('checks the login by the script on %s, with the token request sent once and the counts in the job row', async (_name, options) => {
      const space = await prepare(options);
      const site = space.site as SpaAuthSite;
      const credentials = await credentialsOf(site);
      const jobManager = await managerFor(launch);
      const started = await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (!started.ok) {
        throw new Error(`the login check did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      await wait(LATE_REQUEST_WAIT_MS);
      expect(ended).toMatchObject({
        jobKind: 'LOGIN_CHECK',
        state: 'FINISHED',
        exitCode: EXIT_CODES.COMPLETE,
        lastAuthState: 'AUTHENTICATED',
        autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES', formInvalidReason: null },
      });
      expect(ended.loginStage?.scriptLogin).toMatchObject({ tokenRequestsAllowed: 1, blockedByReason: { LOGIN_CREDENTIAL_IN_REQUEST: 0 } });
      expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
      expect(site.successfulLogins).toBe(1);
      expect(existsSync(join(space.directory, MANUAL_STAGE_RECORD))).toBe(false);
      expect(leakedPlaces([credentials.username, credentials.password])).toEqual([]);
    }, JOB_TIMEOUT_MS);

    it('audits after the automated script login (COMPLETE), with only the token request as a non-read request', async () => {
      const space = await prepare({});
      const site = space.site as SpaAuthSite;
      const credentials = await credentialsOf(site);
      const jobManager = await managerFor(launch);
      const started = await jobManager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      if (!started.ok) {
        throw new Error(`the audit did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      await wait(LATE_REQUEST_WAIT_MS);
      expect(ended).toMatchObject({
        state: 'FINISHED',
        resultRunStatus: 'COMPLETE',
        exitCode: EXIT_CODES.COMPLETE,
        lastAuthState: 'AUTHENTICATED',
        autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES' },
      });
      const { run, visibleTexts } = readRunArtifacts(join(space.directory, OUTPUT_DIRECTORY_NAME));
      expect(run?.runStatus).toBe('COMPLETE');
      expect(visibleTexts.some((text) => text.includes(EXISTING_NAME))).toBe(true);
      expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
      expect(leakedPlaces([credentials.username, credentials.password, ...site.secretValues()])).toEqual([]);
    }, JOB_TIMEOUT_MS);

    // T36R-fix（T36R の M-4）: 最後の列は、上限で数える試しの行の数。token の送信に応答がなかった回（応答なし）は、送った後に応答がなかった印
    // （`responseAfterSubmission: false`。DEF-099）で、親が 2 回と数える。
    it.each<readonly [string, SpaAuthSiteOptions, string, string, string, readonly string[], number]>([
      ['a wrong password (400)', {}, WRONG_PASSWORD_SUFFIX, 'INVALID_CREDENTIALS', 'YES', [SPA_BACKEND_PATHS.token], 1],
      ['a server error (503)', { tokenResponse: 'serverError' }, '', 'AUTH_RESULT_UNKNOWN', 'YES', [SPA_BACKEND_PATHS.token], 1],
      ['no response', { tokenResponse: 'noResponse' }, '', 'AUTH_RESULT_UNKNOWN', 'YES', [SPA_BACKEND_PATHS.token], UNANSWERED_ATTEMPT_ROWS],
      ['a form submitted by the default GET with the credentials', { nativeFormSubmit: true }, '', 'AUTH_RESULT_UNKNOWN', 'UNKNOWN', [], 1],
    ])('stops the automated login on %s', async (_name, options, passwordSuffix, result, submitted, nonReads, attemptRows) => {
      const space = await prepare(options);
      const site = space.site as SpaAuthSite;
      const credentials = await credentialsOf(site);
      const jobManager = await managerFor(launch, passwordSuffix);
      const started = await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (!started.ok) {
        throw new Error(`the login check did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      await wait(LATE_REQUEST_WAIT_MS);
      expect(ended).toMatchObject({
        state: 'FAILED',
        failureReason: result,
        exitCode: FAILURE_EXIT_CODE,
        lastAuthState: 'AUTOMATED_LOGIN_FAILED',
        autoLoginAttempt: { result, submitted, retryAfterUntil: null },
      });
      expect(backendNonReads(site)).toEqual(nonReads);
      const carrying = site.requests.filter((request) => request.origin === 'app'
        && [credentials.username, credentials.password].some((value) => request.path.includes(value) || request.path.includes(encodeURIComponent(value))));
      expect(carrying).toEqual([]);
      expect(readAutoLoginLimitInputs(space.database, PROFILE_ID, new Date(space.nowMs)).attempts).toHaveLength(attemptRows);
      // 止めた: 最小の間隔の後でも、次の開始は止めた状態で拒まれる（人が解くまで）。
      space.nowMs += AUTO_LOGIN_MIN_INTERVAL_MS + 1;
      expect(await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
        .toMatchObject({ ok: false, reason: 'AUTO_LOGIN_HELD' });
      expect(leakedPlaces([credentials.username, credentials.password])).toEqual([]);
    }, JOB_TIMEOUT_MS);

    it('records the rate limit (429) with the next start time, and refuses the start before it', async () => {
      const space = await prepare({ tokenResponse: 'rateLimited' });
      const site = space.site as SpaAuthSite;
      const jobManager = await managerFor(launch);
      const started = await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
      if (!started.ok) {
        throw new Error(`the login check did not start: ${started.reason}`);
      }
      const ended = await waitForEnd(jobManager, started.job.jobId);
      expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'RATE_LIMITED', autoLoginAttempt: { result: 'RATE_LIMITED', submitted: 'YES' } });
      expect(ended.autoLoginAttempt?.retryAfterUntil).not.toBeNull();
      expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
      space.nowMs += AUTO_LOGIN_MIN_INTERVAL_MS + 1;
      // T36R-fix（T36c の残り。理由の値を固定）: 429 は送った後の失敗なので止める。止めている間の次の開始は `AUTO_LOGIN_HELD`（止めている行が先。
      // `auto-login-limits.ts`。Task 26 の設計書 4.5）。
      expect(await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
        .toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD', errors: [], nextAllowedAt: null });
      // 人が解いた後も、`Retry-After` の期限の前は `AUTO_LOGIN_RATE_LIMITED`（次に始められる時刻つき）。ワーカーは本当の時計で期限を求めるので、
      // 期限の 1 ミリ秒前を今とする。
      const deadline = parseCompactUtcTimestamp(ended.autoLoginAttempt?.retryAfterUntil);
      if (deadline === null) {
        throw new Error('the rate limited attempt has no Retry-After deadline');
      }
      expect(clearAutoLoginHold(space.database, PROFILE_ID, formatCompactUtcTimestamp(new Date(space.nowMs), 'test time'))).toBe(true);
      space.nowMs = deadline.getTime() - 1;
      expect(await jobManager.startLoginCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
        .toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: expect.any(String) });
    }, JOB_TIMEOUT_MS);
  });
});
