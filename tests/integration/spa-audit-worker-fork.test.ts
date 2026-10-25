// T35c（Task 35 の設計書 3.2〜3.7、4 章、5 章の 1〜5）: スクリプトで送るログインの監査を、本物のワーカー（ジョブの管理が `child_process.fork` する
// 一時のビルド）で、ログインから監査の終わりまで通す（`script-login-worker-fork.test.ts` と同じ作り。ログイン用の Browser は、テストの既定の headless
// shell と、CLI の起動の設定の両方）。
// - サイトは fixture（`startSpaAuthSite`）。一覧は手続きの呼び出しで読み（`rpcReads`）、`/auth` と `/admin` でテナントを決める手続きの呼び出し（必須。
//   `preLoginRpc: required`）、token の更新、ログインの直後のサーバの関数、計測の送信、WebSocket、会員のメールアドレスで絞り込む読み取りを出す。
// - 認証の設定は版 3 のスクリプトで送るログイン。ログインの段は、2 つの手続きの呼び出しを登録する（`loginSideRequests`）。監査の段は、同じ 2 つを
//   読み取りの手続きの呼び出し（`auditReadRequests`）に登録し、読む範囲を `/admin` に絞る（会員のページは読まない）。
// - 確かめること: ジョブが COMPLETE で終わる。Desktop と Mobile で一覧が成果物（`visible-text.txt`）に出る。範囲の外のアプリのスクリプト（`/app.js`）が
//   読める。登録した手続きの呼び出しは回数の中で届き（ログインの段の数と、`run.json` の監査の段の数の和）、token の更新・サーバの関数・計測の送信・
//   WebSocket は届かない。届いた読み取りでない要求は、ログインの token 1 回と、登録した手続きの呼び出しだけ（全部の後に待って数え直す）。
//   `run.json` に監査の段の数と、承認したサービスの Origin の区分がある。秘密の目印（資格情報、API の鍵、発行した token）と、サービスの Origin の URL
//   の query の値（会員のメールアドレス）が、成果物（ZIP の中身を含む）、管理データのファイル（WAL を含む）、親が受けたメッセージのすべて、ジョブの
//   一覧、ワーカーの標準出力と標準エラーに出ない。process が残らない。
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
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { READ_METHODS, placesWithMarkers } from '../helpers/leak-places.js';
import { waitUntilExited } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
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
/** token の更新までの時間（ms。ページの監査の間に送られる短さ）。 */
const SHORT_REFRESH_MS = 50;
const ENTRY_FILE_NAME = 'spa-audit-worker-test-entry.mjs';
const ENTRY_DIST_PREFIX = './dist/';
/** 監査するページの数の上限（範囲と除外で、読むのは管理画面だけになる）。 */
const MAX_PAGES = 3;
const MAX_LOGIN_ATTEMPTS = 1;
/** ログインの段で、テナントを決める手続きの呼び出しを通す回数（`/auth` と `/admin` を開いたときに 1 回ずつ）。 */
const TENANT_CALLS_THROUGH_LOGIN = 2;
/** ログインの段で、一覧の手続きの呼び出しを通す回数（成功の確かめの `/admin` で 1 回）。 */
const LIST_CALLS_THROUGH_LOGIN = 1;
const ONE_PER_LOAD = 1;
/** 1 ページの最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
/** 監査の段に登録する、読み取りの手続きの呼び出しの数（一覧とテナント）。 */
const REGISTERED_READS = 2;
/** 承認したサービスの Origin への要求の上限（設定の上限の値）。 */
const SERVICE_REQUEST_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
/** fixture の既存の会員の名前（一覧が成果物に出たかを、見えている文字で確かめる）。 */
const EXISTING_NAME = '既存花子';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
/** 状態を待つ時間の上限と間隔（CC-095: 待ちは `waitForValue`）。 */
const WAIT_TIMING = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

const LOGIN_LAUNCHES: readonly (readonly [string, TestLoginWorkerLaunch])[] = [
  ['the default test Chromium', 'TEST_DEFAULT'],
  ['the CLI Chromium', 'CLI'],
];
const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

describe('T35c: the script login SPA audit in a child worker', () => {
  let build: TemporaryBuild;

  beforeAll(async () => {
    build = await buildIntoTemporaryDirectory();
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await build?.remove();
  }, SUITE_TIMEOUT_MS);

  describe.each(LOGIN_LAUNCHES)('login Browser: %s', (label, loginLaunch) => {
    let site: SpaAuthSite;
    let workDirectory: string;
    const children: ChildProcess[] = [];
    const profileId = `example-spa-audit-${loginLaunch.toLowerCase().split('_').join('-')}`;
    const targetConfigPath = `local/targets/${profileId}.json`;
    const outputDirectory = (): string => join(workDirectory, `${profileId}-output`);

    beforeAll(async () => {
      site = await startSpaAuthSite({
        rpcReads: true,
        preLoginRpc: 'required',
        postLoginFunction: 'continueOnFailure',
        refreshAfterMs: SHORT_REFRESH_MS,
        rumBeacon: true,
        websocket: true,
        emailFilterRead: true,
      });
      site.addMember(EXISTING_NAME);
      workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-spa-audit-fork-'));
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
      // 会員のページ（登録と更新）は読まない（読むのは管理画面だけ。登録した手続きの呼び出しの数を、読み込みの数から決める）。
      excludedPaths: [SPA_APP_PATHS.logout, '/admin/members'],
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      loginSideRequests: [
        { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant, method: 'POST', maxPerLoginStage: TENANT_CALLS_THROUGH_LOGIN },
        { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcListMembers, method: 'POST', maxPerLoginStage: LIST_CALLS_THROUGH_LOGIN },
      ],
      successStorageKey: { origin: site.appOrigin, ...FIXTURE_KEY },
      auditReadRequests: [
        { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcListMembers, method: 'POST', maxPerPageLoad: ONE_PER_LOAD },
        { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant, method: 'POST', maxPerPageLoad: ONE_PER_LOAD },
      ],
      serviceRequestLimits: SERVICE_REQUEST_LIMITS,
    });

    /** 状態を待つ（CC-095）。 */
    const waitFor = <T>(read: () => T | null): Promise<T> => waitForValue(read, WAIT_TIMING);

    it(`logs in by the script, reads the list by the registered calls, blocks the rest, and leaks no marker (${label})`, async () => {
      const database: ControlDatabase = openControlDatabase(resolveControlDatabasePath(workDirectory));
      let manager: AuditJobManager | undefined;
      try {
        const targetConfig = await loadConfig(join(workDirectory, targetConfigPath));
        const resolveContext = (): { readonly targetConfig: typeof targetConfig } => ({ targetConfig });
        const profile = createForkTestProfile(database, {
          profileId,
          targetConfigPath,
          auth: 'MANUAL_SESSION',
          approvedTestOrigins: [site.appOrigin],
          approvedServiceOrigins: [site.backendOrigin],
        }, resolveContext);
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

        // CC-095: Run の成果物（ZIP の中身を除いた `run.json`・`page.json`・見えている文字と、ZIP の中身を含む場所）。
        const { places, run, pages, visibleTexts } = readRunArtifacts(outputDirectory());
        expect(run?.runStatus).toBe('COMPLETE');
        expect(run?.executions.at(-1)?.endReason).toBe('COMPLETED');
        // 読むのは管理画面だけ。Desktop と Mobile の両方で監査し、一覧が成果物の見えている文字に出る。
        expect(pages.map(({ pageUrl }) => new URL(pageUrl).pathname)).toEqual([SPA_APP_PATHS.admin]);
        expect(pages[0]?.viewports['desktop']?.status).toBe('AUDITED');
        expect(pages[0]?.viewports['mobile']?.status).toBe('AUDITED');
        expect(visibleTexts.length).toBeGreaterThan(0);
        expect(visibleTexts.every((text) => text.includes(EXISTING_NAME))).toBe(true);
        // 範囲を `/admin` に絞っても、範囲の外のアプリのスクリプトは読める（ログインの段と監査の段で）。
        expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length).toBeGreaterThan(1);

        // 届いた読み取りでない要求は、ログインの token 1 回と、登録した手続きの呼び出しだけ（事前確認は Guard が満たす）。
        const messages = received.filter(isWorkerMessage);
        expect(messages).toHaveLength(received.length);
        const authStates = messages.flatMap((message) => (message.type === 'AUTH_STATE' ? [message] : []));
        expect(authStates.map(({ state }) => state)).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED']);
        const loginStage = authStates[1]?.scriptLogin;
        expect(loginStage).toMatchObject({ tokenRequestsAllowed: 1, sideRequestsAllowed: [TENANT_CALLS_THROUGH_LOGIN, LIST_CALLS_THROUGH_LOGIN] });
        const auditStageAllowed = REGISTERED_READS * PRIMARY_LOADS_PER_PAGE;
        expect(run?.authentication).toMatchObject({ registeredReadRequestsAllowed: auditStageAllowed, serviceRequestLimitReached: false });
        expect(run?.authentication?.tokenRefreshBlocked).toBeGreaterThan(0);
        expect(run?.authentication?.otherNonReadBlocked).toBeGreaterThan(0);
        const nonReads = site.requests
          .filter((request) => request.origin !== 'app' && !request.preflight && !READ_METHODS.has(request.method))
          .map(({ method, path }) => `${method} ${path}`);
        // ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1。意図して直した期待）: 手動のログインの段は、ページの送信（token の更新、
        // サーバの関数の呼び出し）も止めずに通し、形だけを `AUTH_STATE` の `passedRequests` に残す。監査の段は今どおり（登録した呼び出しのほかは止める）。
        const loginStageOnly = new Set([`POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.refresh}`, `POST ${SPA_BACKEND_PATHS.functionSyncAccess}`]);
        expect(nonReads.filter((entry) => !loginStageOnly.has(entry)).sort()).toEqual([
          `POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`,
          ...Array.from({ length: TENANT_CALLS_THROUGH_LOGIN + PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`),
          ...Array.from({ length: LIST_CALLS_THROUGH_LOGIN + PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcListMembers}`),
        ].sort());
        const passedPaths = new Set((authStates[1]?.passedRequests?.requests ?? []).map(({ path }) => path));
        for (const entry of nonReads.filter((value) => loginStageOnly.has(value))) {
          expect(passedPaths.has((entry.split(' ')[1] ?? '').split('?')[0] ?? '')).toBe(true);
        }
        // ML-a: アプリの Origin への読み取りでない要求（計測の送信）も、手動のログインの段で通したものだけ（通した送信の一覧にある path）。監査の段では届かない。
        const appNonReads = site.requests.filter((request) => request.origin === 'app' && request.method !== 'GET');
        expect(appNonReads.filter(({ path }) => !passedPaths.has(path.split('?')[0] ?? ''))).toEqual([]);
        expect(site.rumBeacons).toBeLessThanOrEqual(appNonReads.length);
        expect(site.successfulLogins).toBe(1);
        // 手動のログインの段で通した分だけ（監査の段では届かない）。
        expect(site.refreshes).toBeLessThanOrEqual(nonReads.filter((entry) => entry.includes(`grant_type=${SPA_GRANT_TYPES.refresh}`)).length);
        expect(site.functionCalls).toBeLessThanOrEqual(nonReads.filter((entry) => entry.includes(SPA_BACKEND_PATHS.functionSyncAccess)).length);
        // 承認したサービスの Origin への要求は、`run.json` の区分に数が出る（監査の段の、届いた要求）。
        expect(run?.load.approvedServiceOrigins?.count).toBeGreaterThan(0);

        // 目印: 秘密の値と、サービスの Origin の URL の query の値（会員のメールアドレス。絞り込みの読み取りで送る）。
        const memberEmail = site.memberOf(1)?.email ?? '';
        expect(memberEmail.length).toBeGreaterThan(0);
        expect(site.requests.some((request) => request.origin === 'backend' && request.path.includes(encodeURIComponent(memberEmail)))).toBe(true);
        const markers = [...site.secretValues(), memberEmail, encodeURIComponent(memberEmail)];
        const leaked = (text: string): readonly string[] => markers.filter((marker) => text.includes(marker));
        const databasePath = resolveControlDatabasePath(workDirectory);
        const databaseBytes = [databasePath, `${databasePath}-wal`]
          .filter((path) => existsSync(path))
          .map((path) => readFileSync(path).toString('latin1'))
          .join('\n');
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
  });
});
