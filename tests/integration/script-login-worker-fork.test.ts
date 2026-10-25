// T34c（Task 34 の設計書 3.3〜3.5、4 章、5 章の 1・5）: スクリプトで送るログインの手動のログインの監査を、本物のワーカー（ジョブの管理が
// `child_process.fork` する一時のビルド）で、ログインから監査の終わりまで通す。
// - 子 process の入口は、テストだけの入口（`testLoginWorkerEntrySource`）。人の操作の代わりに、テストが標準入力で渡した仮の資格情報を、テストだけの口が
//   入力する（`audit-worker-auth-fork.test.ts` と同じ作り）。ログイン用の Browser は、テストの既定の headless shell と、CLI の起動の設定の両方で
//   確かめる（監査の Browser は本番と同じ）。
// - サイトは fixture（`startSpaAuthSite`。`preLoginRpc: optional`、`postLoginFunction: continueOnFailure`）。プロファイルの許可 Origin はアプリの
//   Origin、承認したサービスの Origin は token と API のバックエンドの Origin。認証の設定は版 3 のスクリプトで送るログイン（ログインの直後のサーバの
//   関数だけを登録する。手続きの呼び出しは登録しない）。
// - 確かめること: ジョブが COMPLETE で終わる。ローカル ストレージの状態が監査の段に引き継がれ、一覧が成果物（`visible-text.txt`）に出る。バックエンドに
//   届いた読み取りでない要求は、token の POST 1 回と、登録したサーバの関数の呼び出し 1 回だけ（全部の後に待って数え直す）。`AUTH_STATE` の
//   `AUTHENTICATED` が数（`scriptLogin`）を持つ。秘密の目印（資格情報、API の鍵、発行した token）が、親が受けたメッセージのすべて、ジョブの一覧、
//   管理データのファイル（WAL を含む）、ワーカーの標準出力と標準エラー、成果物（ZIP の中身を含む）に出ない。process が残らない。
// - T34e: `AUTH_STATE` の `AUTHENTICATED` は、止めた読み取りでない要求の一覧（登録しない手続きの呼び出しの Origin・path・理由）も持ち、ジョブの管理が
//   数と一覧を、管理データのジョブの行（`login_stage_summary`）に残す。token の query の値は、一覧と管理データに出ない。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { READ_METHODS, placesWithMarkers } from '../helpers/leak-places.js';
import { waitUntilExited } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { testLoginWorkerEntrySource, type TestLoginWorkerLaunch } from '../helpers/test-login-worker-entry.js';
import {
  STDIN_CREDENTIALS_EXPRESSION,
  STDIN_CREDENTIALS_PRELUDE,
  createForkTestProfile,
  createRecordingFork,
  processTreeOf,
  readRunArtifacts,
  waitForValue,
} from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 300_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
const CHROMIUM_EXIT_LIMIT_MS = 15_000;
/** ログインを待つ時間（ms。テストの口が入力する）。 */
const LOGIN_TIMEOUT_MS = 60_000;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const ENTRY_FILE_NAME = 'script-login-worker-test-entry.mjs';
const ENTRY_DIST_PREFIX = './dist/';
/** 監査するページの数の上限（管理画面、登録の画面、更新の画面の 3 つ。ログアウトは読まないパス）。 */
const MAX_PAGES = 3;
const MAX_LOGIN_ATTEMPTS = 1;
const ONE_SIDE_POST = 1;
/** 成功の確かめまでに、登録しない手続きの呼び出し（任意）を止める回数（`/auth` と `/admin` を開いたときに 1 回ずつ）。 */
const TENANT_CALLS_THROUGH_LOGIN = 2;
/** fixture の既存の会員の名前（一覧が成果物に出たかを、見えている文字で確かめる）。 */
const EXISTING_NAME = '既存花子';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY_PREFIX = 'fixture';
const FIXTURE_KEY_SUFFIX = '-auth-token';
/** 状態を待つ時間の上限と間隔（CC-095: 待ちは `waitForValue`）。 */
const WAIT_TIMING = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

const LOGIN_LAUNCHES: readonly (readonly [string, TestLoginWorkerLaunch])[] = [
  ['the default test Chromium', 'TEST_DEFAULT'],
  ['the CLI Chromium', 'CLI'],
];

/**
 * T34e: スクリプトの送信の要求の種類（fetch か xhr）。fixture は `fetch()` で送るが、Guard が判定に使う種類は Chromium が報告する値（両方の Chromium で
 * xhr と報告された）なので、どちらも受ける。
 */
const SCRIPT_RESOURCE_TYPE = expect.stringMatching(/^(?:fetch|xhr)$/u);
const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

describe.each(LOGIN_LAUNCHES)('T34c: the script login audit in a child worker (login Browser: %s)', (label, loginLaunch) => {
  let site: SpaAuthSite;
  let build: TemporaryBuild;
  let workDirectory: string;
  const children: ChildProcess[] = [];
  const profileId = `example-script-${loginLaunch.toLowerCase().split('_').join('-')}`;
  const targetConfigPath = `local/targets/${profileId}.json`;
  const outputDirectory = (): string => join(workDirectory, `${profileId}-output`);

  beforeAll(async () => {
    site = await startSpaAuthSite({ preLoginRpc: 'optional', postLoginFunction: 'continueOnFailure' });
    site.addMember(EXISTING_NAME);
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-script-login-fork-'));
    await mkdir(join(workDirectory, 'local', 'targets'), { recursive: true });
    await writeFile(join(workDirectory, targetConfigPath), JSON.stringify(cliTargetConfig(profileId, site.appOrigin, SPA_APP_PATHS.admin, {
      crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
      audit: { screenshots: false },
      output: { directory: outputDirectory() },
    })), 'utf8');
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of leftovers) {
      child.kill();
    }
    await build?.remove();
    await site?.close();
    if (workDirectory !== undefined) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    expect(leftovers.length, 'workers left running after the tests').toBe(0);
  }, SUITE_TIMEOUT_MS);

  const setupOf = (): AuthSetupV3 => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId,
    profileRevision: MIN_PROFILE_REVISION,
    loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
    sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
    excludedPaths: [SPA_APP_PATHS.logout],
    auditPathPrefixes: [],
    maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: null,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    loginSideRequests: [{ origin: site.backendOrigin, path: SPA_BACKEND_PATHS.functionSyncAccess, method: 'POST', maxPerLoginStage: ONE_SIDE_POST }],
    successStorageKey: { origin: site.appOrigin, prefix: FIXTURE_KEY_PREFIX, suffix: FIXTURE_KEY_SUFFIX },
  });

  /** 状態を待つ（CC-095）。 */
  const waitFor = <T>(read: () => T | null): Promise<T> => waitForValue(read, WAIT_TIMING);
  /** プロファイル（CC-095。2 つの場面で同じもの）。 */
  const createScriptProfile = (database: ControlDatabase, resolveContext: (path: string) => { readonly targetConfig: AuditConfig } | undefined) =>
    createForkTestProfile(database, {
      profileId,
      targetConfigPath,
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.appOrigin],
      approvedServiceOrigins: [site.backendOrigin],
    }, resolveContext);

  it(`logs in by the script, audits with the stored state, and leaks no secret marker (${label})`, async () => {
    const database: ControlDatabase = openControlDatabase(resolveControlDatabasePath(workDirectory));
    let manager: AuditJobManager | undefined;
    try {
      const targetConfig = await loadConfig(join(workDirectory, targetConfigPath));
      const resolveContext = (): { readonly targetConfig: typeof targetConfig } => ({ targetConfig });
      const profile = createScriptProfile(database, resolveContext);
      expect(profile.ok, JSON.stringify(profile)).toBe(true);
      const saved = saveAuthSetup(database, setupOf(), { resolveContext });
      expect(saved.ok, JSON.stringify(saved)).toBe(true);

      const fields: [string, string][] = [];
      await site.fillCredentials(async (selector, value) => {
        fields.push([selector, value]);
      });
      const entry = join(build.rootDirectory, `${profileId}-${ENTRY_FILE_NAME}`);
      await writeFile(entry, testLoginWorkerEntrySource({
        distPrefix: ENTRY_DIST_PREFIX,
        loginTimeoutMs: LOGIN_TIMEOUT_MS,
        prelude: STDIN_CREDENTIALS_PRELUDE,
        credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
        loginLaunch,
      }), 'utf8');
      const received: unknown[] = [];
      let output = '';
      const forkWorker: AuditWorkerForker = createRecordingFork({
        entry,
        stdinText: () => JSON.stringify({ fields, submit: SPA_LOGIN_FIELDS.submit }),
        onChild: (child) => children.push(child),
        onReceived: (message) => received.push(message),
        onOutput: (chunk) => { output += chunk; },
      });
      manager = createAuditJobManager({
        database,
        repositoryRoot: workDirectory,
        workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
        resolveContext,
        forkWorker,
      });
      const started = await manager.startAuditJob({ profileId, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      if (!started.ok) {
        throw new Error(`the job did not start: ${started.reason}`);
      }
      const { jobId } = started.job;
      await waitFor(() => (readJob(database, jobId)?.lastAuthState === 'AWAITING_LOGIN' ? true : null));
      const tree = await processTreeOf(children.at(-1)?.pid ?? 0);
      const ended: AuditJobView = await waitFor(() => {
        const job = readJob(database, jobId);
        return job !== null && job.finishedAt !== null ? job : null;
      });
      expect(ended).toMatchObject({
        state: 'FINISHED',
        resultRunStatus: 'COMPLETE',
        exitCode: EXIT_CODES.COMPLETE,
        lastAuthState: 'AUTHENTICATED',
        failureReason: null,
      });
      await wait(LATE_REQUEST_WAIT_MS);

      // バックエンドに届いた読み取りでない要求は、token の POST 1 回と、登録したサーバの関数の呼び出し 1 回だけ（事前確認は Guard が満たす）。
      const nonReads = site.requests
        .filter((request) => request.origin !== 'app' && !request.preflight && !READ_METHODS.has(request.method))
        .map(({ method, path }) => `${method} ${path}`);
      // ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1。意図して直した期待）: 手動のログインの段は、登録していないテナントの手続きの
      // 呼び出しも止めずに通す（形だけを記録する）。監査の段は今どおり（登録した呼び出しのほかは届かない）。
      const tenantCalls = nonReads.filter((entry) => entry === `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`);
      expect(tenantCalls.length).toBeGreaterThanOrEqual(1);
      expect(nonReads.filter((entry) => entry !== `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`).sort()).toEqual([
        `POST ${SPA_BACKEND_PATHS.functionSyncAccess}`,
        `POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`,
      ].sort());
      expect(readJob(database, jobId)?.loginStage?.passedRequests?.requests.map(({ path }) => path)).toContain(SPA_BACKEND_PATHS.rpcResolveTenant);
      expect(site.requests.filter((request) => request.origin === 'app' && request.method !== 'GET')).toEqual([]);
      expect(site.successfulLogins).toBe(1);
      expect(site.functionCalls).toBe(ONE_SIDE_POST);
      // 監査の段は、引き継いだ状態の Bearer で一覧を読んだ（成果物の見えている文字に出る）。
      expect(site.requests.some((request) => request.origin === 'backend' && request.method === 'GET' && request.bearerValid === true)).toBe(true);
      // CC-095: Run の成果物（見えている文字と、目印の検査の場所）。
      const artifacts = readRunArtifacts(outputDirectory());
      const { places } = artifacts;
      const visibleTexts = artifacts.visibleTexts.join('\n');
      expect(visibleTexts).toContain(EXISTING_NAME);

      const messages = received.filter(isWorkerMessage);
      expect(messages).toHaveLength(received.length);
      const authStates = messages.flatMap((message) => (message.type === 'AUTH_STATE' ? [message] : []));
      expect(authStates.map(({ state }) => state)).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED']);
      expect(authStates[1]?.scriptLogin).toMatchObject({
        tokenRequestsAllowed: 1,
        sideRequestsAllowed: [ONE_SIDE_POST],
        // ML-a（意図して直した期待）: 手動のログインの段は、登録していない手続きの呼び出しを止めずに通す（止めた数は 0）。
        blockedByReason: { TOKEN_REQUEST_OVER_LIMIT: 0, UNREGISTERED_NON_READ: 0 },
      });
      // T34e・ML-a: 通した手続きの呼び出しの Origin と path と理由（通さなければ止めた理由）が、IPC と管理データのジョブの行に残る（数のまとめと一緒に）。
      const tenantPassed = {
        requests: [{
          origin: site.backendOrigin,
          path: SPA_BACKEND_PATHS.rpcResolveTenant,
          resourceType: SCRIPT_RESOURCE_TYPE,
          reason: 'UNREGISTERED_NON_READ',
          count: tenantCalls.length,
          beforeToken: true,
        }],
        unlisted: 0,
      };
      expect(authStates[1]?.blockedRequests).toBeUndefined();
      expect(authStates[1]?.passedRequests).toEqual(tenantPassed);
      // T43d（Task 43 の設計書 4.4）: ログインの段の観察（新しく出た鍵の名前と、成功の画面のセレクタの案。値と要素の文字は持たない）も、IPC と管理データの
      // ジョブの行に残る。
      expect(authStates[1]?.loginObservation).toEqual({
        // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前（`SPA_AUTH_STORAGE_KEY`）の最初と最後の部分の接頭辞と接尾辞の案だけ。
        // T43R2-fix（意図して直した期待）: 一般の語の側（`-token`）だけ（`SPA_AUTH_STORAGE_KEY` の最初の部分は一般の語でない）。
        storageKeys: { origin: site.appOrigin, shapes: [{ prefix: '', suffix: `-${SPA_AUTH_STORAGE_KEY.split('-').at(-1) ?? ''}` }], omitted: 0 },
        successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: expect.any(String) },
        // DEF-161（FM2e の 3A.4 に合わせて直した期待）: 手動のログインの段の始めに検出したログインの 3 つの欄の CSS の案（欄の値は持たない）。
        loginFields: { username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit },
      });
      expect(readJob(database, jobId)?.loginStage).toMatchObject({
        scriptLogin: authStates[1]?.scriptLogin, blockedRequests: null, passedRequests: tenantPassed, observation: authStates[1]?.loginObservation,
      });
      expect(JSON.stringify(readJob(database, jobId)?.loginStage)).not.toContain('grant_type');

      // 秘密の目印: 親が受けたメッセージのすべて、ジョブの一覧、管理データのファイルと WAL、ワーカーの標準出力と標準エラー、成果物。
      const markers = site.secretValues();
      expect(markers.length).toBeGreaterThan(2);
      const leaked = (text: string): readonly string[] => markers.filter((marker) => text.includes(marker));
      const databasePath = resolveControlDatabasePath(workDirectory);
      const databaseBytes = [databasePath, `${databasePath}-wal`]
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path).toString('latin1'))
        .join('\n');
      // DEF-161: ログインの欄の案（`loginFields`）にも、入れた資格情報の値と秘密の目印が出ない（下の IPC とジョブの一覧の確かめも、観察を含む）。
      expect(leaked(JSON.stringify(authStates[1]?.loginObservation?.loginFields ?? null))).toEqual([]);
      expect(leaked(JSON.stringify(received))).toEqual([]);
      expect(leaked(JSON.stringify(manager.listAuditJobs()))).toEqual([]);
      expect(leaked(databaseBytes)).toEqual([]);
      expect(leaked(output)).toEqual([]);
      expect(places.length).toBeGreaterThan(0);
      expect(placesWithMarkers(places, markers)).toEqual([]);
      expect(await waitUntilExited(tree, CHROMIUM_EXIT_LIMIT_MS), 'processes left after the job ended').toEqual([]);
    } finally {
      await manager?.close();
      closeControlDatabase(database);
    }
  }, SUITE_TIMEOUT_MS);

  // T34R-fix-a（T34R の I-1）: ログインの段で、登録していない送信を止めた後に利用者が「監査を止める」と、ワーカーは数と一覧を親に渡してから終わる。
  // 管理データのジョブに一覧が残り、ジョブの終わり方は今どおり（止めた状態）。
  it(`keeps the list of the blocked requests in the job when the job is stopped during the login stage (${label})`, async () => {
    const database: ControlDatabase = openControlDatabase(resolveControlDatabasePath(workDirectory));
    let manager: AuditJobManager | undefined;
    try {
      const targetConfig = await loadConfig(join(workDirectory, targetConfigPath));
      const resolveContext = (): { readonly targetConfig: typeof targetConfig } => ({ targetConfig });
      // 前の場面と同じプロファイルと認証の設定（この場面だけを流すときは、ここで作る。作り済みなら作れないが、それでよい）。
      createScriptProfile(database, resolveContext);
      saveAuthSetup(database, setupOf(), { resolveContext });

      // 人の操作をしない入口（ログインを待ち続ける）。
      const entry = join(build.rootDirectory, `${profileId}-stop-${ENTRY_FILE_NAME}`);
      await writeFile(entry, testLoginWorkerEntrySource({
        distPrefix: ENTRY_DIST_PREFIX,
        loginTimeoutMs: LOGIN_TIMEOUT_MS,
        credentialsExpression: null,
        loginLaunch,
      }), 'utf8');
      const received: unknown[] = [];
      const forkWorker: AuditWorkerForker = createRecordingFork({
        entry,
        onChild: (child) => children.push(child),
        onReceived: (message) => received.push(message),
      });
      manager = createAuditJobManager({
        database,
        repositoryRoot: workDirectory,
        workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
        resolveContext,
        forkWorker,
      });
      const scriptsBefore = site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length;
      // ML-a: 前の場面の手動のログインの成功で、認証の設定が自動で登録され、プロファイルの改訂が進んでいることがある（今の改訂で始める）。
      const expectedRevision = getProfile(database, profileId)?.profile.revision ?? MIN_PROFILE_REVISION;
      const started = await manager.startAuditJob({ profileId, expectedRevision, startNew: true });
      if (!started.ok) {
        throw new Error(`the job did not start: ${started.reason}`);
      }
      const { jobId } = started.job;
      await waitFor(() => (readJob(database, jobId)?.lastAuthState === 'AWAITING_LOGIN' ? true : null));
      // ログインの画面のスクリプトが動き、手続きの呼び出しを Guard が通す（ML-a。手動のログインの段）まで待つ。
      await waitFor(() => (site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length > scriptsBefore
        ? true : null));
      await wait(LATE_REQUEST_WAIT_MS);
      expect(manager.stopAuditJob(jobId).ok).toBe(true);
      const ended: AuditJobView = await waitFor(() => {
        const job = readJob(database, jobId);
        return job !== null && job.finishedAt !== null ? job : null;
      });
      expect(ended).toMatchObject({ state: 'INTERRUPTED', lastAuthState: 'AWAITING_LOGIN' });
      // ML-a（意図して直した期待）: 手動のログインの段は、登録していない手続きの呼び出しを止めずに通し、通した送信の一覧に残す（前の場面の自動の登録で登録済み
      // なら、登録した送信として通す）。止めた送信の一覧はない。どちらでも、数と一覧は止めたジョブに残る。
      expect(ended.loginStage?.blockedRequests).toBeNull();
      expect(ended.loginStage?.scriptLogin).toEqual(expect.objectContaining({ tokenRequestsAllowed: 0 }));
      const passedTenant = ended.loginStage?.passedRequests?.requests.find(({ path }) => path === SPA_BACKEND_PATHS.rpcResolveTenant);
      const registeredTenant = (ended.loginStage?.scriptLogin?.sideRequestsAllowed ?? []).some((count) => count >= 1);
      expect(passedTenant === undefined ? registeredTenant : passedTenant).toEqual(passedTenant === undefined ? true : {
        origin: site.backendOrigin,
        path: SPA_BACKEND_PATHS.rpcResolveTenant,
        resourceType: SCRIPT_RESOURCE_TYPE,
        reason: 'UNREGISTERED_NON_READ',
        count: 1,
        beforeToken: true,
      });
      const leakedMarkers = site.secretValues().filter((marker) => JSON.stringify(received).includes(marker));
      expect(leakedMarkers).toEqual([]);
    } finally {
      await manager?.close();
      closeControlDatabase(database);
    }
  }, SUITE_TIMEOUT_MS);
});
