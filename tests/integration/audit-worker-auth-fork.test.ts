// T25d（Task 25 の設計書 4.4、4.6）: 認証つきのワーカーを、本物の子 process（`child_process.fork`。一時のビルド）で動かす結合テスト。
// - 子 process の入口は、テストだけの入口（一時のビルドの root に書く `.mjs`）。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの
//   口（関数の引数）で、ログイン用の Browser を CLI の起動の設定の headless に替え、待つ時間を短くして呼ぶ。本番の入口（`audit-worker.ts`）は
//   指定を渡さない（`worker-login-hooks.test.ts`）。監査の Browser は、本番と同じく `WORKER_CONFIG_OVERRIDES` で headless。
// - 直接の fork: 認証つきの `START` で `AUTH_STATE`（`AWAITING_LOGIN`）→ 時間切れ → `LOGIN_TIMEOUT` と `FAILED`、終了コード 1。ワーカーと
//   Chromium の process が残らない。標準出力には何も書かない。
// - ジョブの管理から（`createAuditJobManager` が fork する）: 人の操作の代わりに、テストが標準入力で渡した仮の資格情報を、テストだけの口が入力
//   する。ログイン → 監査 → FINISHED（COMPLETE）。ジョブの行に最後の認証の状態。秘密の目印（Cookie と localStorage の値）が、親が受けた
//   メッセージのすべて、ジョブの行、管理データのファイル（WAL を含む）、ワーカーの標準出力と標準エラーに出ない。process が残らない。
// - DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 3 章の 1・2）: fixture のログインの後の画面が IndexedDB に目印を書き、2 ページ目は
//   その記録がなければログインの画面へ移す。ジョブは COMPLETE で終わり（IndexedDB を引き継いだ）、ログインの段の状態の名前の記録が IPC とジョブの行に
//   残る。IndexedDB の値の目印も、ほかの目印と同じ場所に出ない。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import {
  STDIN_CREDENTIALS_EXPRESSION,
  STDIN_CREDENTIALS_PRELUDE,
  createRecordingFork,
  hideJobBrowser,
  processTreeOf,
  waitForValue,
  type WaitTiming,
} from '../helpers/worker-fork-support.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { nonReadRequestsOf } from '../helpers/leak-places.js';
import { waitUntilExited } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';

const SUITE_TIMEOUT_MS = 300_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
const CHROMIUM_EXIT_LIMIT_MS = 15_000;
/** 直接の fork の場面のログインを待つ時間（ms。人の操作を待たない）。Chromium の process の一覧を読む間（数秒）より長くする。 */
const SHORT_LOGIN_TIMEOUT_MS = 8_000;
/** ジョブの管理の場面のログインを待つ時間（ms。テストの口が入力する）。 */
const LONG_LOGIN_TIMEOUT_MS = 60_000;
const ENTRY_FILE_NAME = 'auth-worker-test-entry.mjs';
const PROFILE_ID = 'example-auth-fork';
const TARGET_CONFIG_PATH = 'local/targets/auth-fork.json';
const MAX_PAGES = 3;

/** テストだけの入口（一時のビルドの root に書く）から見た、ビルドの `dist/` の場所。 */
const ENTRY_DIST_PREFIX = './dist/';

/** 状態を待つ時間の上限と間隔。 */
const WAIT_TIMING: WaitTiming = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

let site: AuthenticatedSite;
let build: TemporaryBuild;
let workDirectory: string;
const children: ChildProcess[] = [];

/**
 * テストだけの入口を書き、そのパスを返す（CCX-23: 入口の本文は、画面のテストと共用する `testLoginWorkerEntrySource`）。資格情報は、ファイルにも
 * 環境変数にも書かず、標準入力から受ける（`worker-fork-support.ts` の準備。`[セレクタ, 値]` の組と、送るボタンのセレクタ）。
 */
async function writeEntry(name: string, loginTimeoutMs: number, readCredentials: boolean): Promise<string> {
  const path = join(build.rootDirectory, `${name}-${ENTRY_FILE_NAME}`);
  const source = testLoginWorkerEntrySource({
    distPrefix: ENTRY_DIST_PREFIX,
    loginTimeoutMs,
    ...(readCredentials ? { prelude: STDIN_CREDENTIALS_PRELUDE } : {}),
    credentialsExpression: readCredentials ? STDIN_CREDENTIALS_EXPRESSION : null,
  });
  await writeFile(path, source, 'utf8');
  return path;
}

const setupFor = (started: AuthenticatedSite): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${started.originA}${AUTH_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: started.originA, path: AUTH_SITE_PATHS.login }],
  successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [AUTH_SITE_PATHS.adminLogout],
  auditPathPrefixes: [AUTH_SITE_PATHS.admin],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 作業のディレクトリに、ターゲット JSON を書く。 */
async function writeTarget(): Promise<void> {
  await mkdir(join(workDirectory, 'local', 'targets'), { recursive: true });
  await writeFile(join(workDirectory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('auth-fork', site.originA, AUTH_SITE_PATHS.admin, {
    crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
    audit: { screenshots: false },
    output: { directory: join(workDirectory, 'auth-fork-output') },
  })), 'utf8');
}

const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

/** 秘密の目印が、`text` に現れたもの。 */
const leakedMarkers = (text: string): readonly string[] => site.secretValues().filter((marker) => text.includes(marker));

describe('T25d: the authenticated worker in a child process (login Browser replaced by the headless CLI launch settings)', () => {
  beforeAll(async () => {
    // DEF-139: ログインの後の画面が IndexedDB に秘密の目印を書き、2 ページ目はその記録がなければログインの画面へ移す（引き継ぎと目印の確かめ）。
    site = await startAuthenticatedSite({ loginForm: true, indexedDbGate: true });
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-worker-auth-fork-'));
    await writeTarget();
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

  it('sends AWAITING_LOGIN, then LOGIN_TIMEOUT and FAILED, exits with 1, and leaves no worker or Chromium process', async () => {
    const entry = await writeEntry('timeout', SHORT_LOGIN_TIMEOUT_MS, false);
    const child = fork(entry, [], { cwd: workDirectory, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
    children.push(child);
    const messages: unknown[] = [];
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('message', (message: unknown) => {
      messages.push(message);
      if (isWorkerMessage(message) && message.type === 'READY') {
        const setup = setupFor(site);
        child.send({
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'START',
          jobId: 'job-timeout',
          jobKind: 'AUDIT',
          targetConfigPath: TARGET_CONFIG_PATH,
          startNew: true,
          targetConfigSha256: targetConfigDigestOf(readFileSync(join(workDirectory, TARGET_CONFIG_PATH))),
          authentication: { setup, approvedTestOrigins: [site.originA], authenticationSha256: workerAuthenticationDigestOf(setup, [site.originA], { jobKind: 'AUDIT', automatedLogin: null }) },
        });
      }
    });
    const exited = new Promise<number | null>((resolvePromise) => child.on('exit', (code) => resolvePromise(code)));

    await waitForValue(() => (messages.some((message) => isWorkerMessage(message) && message.type === 'AUTH_STATE') ? true : null), WAIT_TIMING);
    const tree = await processTreeOf(child.pid ?? 0);
    expect(tree.length, 'the worker has no Chromium while it waits for the login').toBeGreaterThan(1);

    expect(await exited).toBe(FAILURE_EXIT_CODE);
    const received = messages.filter(isWorkerMessage);
    expect(received).toHaveLength(messages.length);
    expect(received.flatMap((message) => (message.type === 'AUTH_STATE' ? [message.state] : []))).toEqual(['AWAITING_LOGIN', 'LOGIN_TIMEOUT']);
    expect(received.flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['LOGIN_TIMEOUT']);
    expect(received.map(({ type }) => type)).not.toContain('RUN_STARTED');
    expect(stdout).toBe('');
    expect(leakedMarkers(`${stdout}${stderr}`)).toEqual([]);
    expect(await waitUntilExited(tree, CHROMIUM_EXIT_LIMIT_MS), 'processes left after the worker exited').toEqual([]);
    expect(nonReadRequestsOf(site.requests)).toEqual([]);
  }, SUITE_TIMEOUT_MS);

  it('runs an authenticated job from the job manager (login by the test hook), records the auth state, and leaks no secret marker', async () => {
    const database: ControlDatabase = openControlDatabase(resolveControlDatabasePath(workDirectory));
    let manager: AuditJobManager | undefined;
    try {
      const targetConfig = await loadConfig(join(workDirectory, TARGET_CONFIG_PATH));
      const resolveContext = (): { readonly targetConfig: typeof targetConfig } => ({ targetConfig });
      expect(createProfile(database, {
        schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
        profileId: PROFILE_ID,
        revision: MIN_PROFILE_REVISION,
        targetConfigPath: TARGET_CONFIG_PATH,
        environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'MANUAL_SESSION',
        approvedTestOrigins: [site.originA],
        environmentEvidenceRef: 'evidence/example-auth-fork/isolation-check-1',
      }, { resolveContext }).ok).toBe(true);
      // FM-2: テストのジョブのブラウザは今どおり headless。
      hideJobBrowser(database, PROFILE_ID);
      expect(saveAuthSetup(database, setupFor(site), { resolveContext }).ok).toBe(true);

      const fields: [string, string][] = [];
      await site.fillCredentials(async (selector, value) => {
        fields.push([selector, value]);
      });
      const entry = await writeEntry('job', LONG_LOGIN_TIMEOUT_MS, true);
      const received: unknown[] = [];
      let output = '';
      const forkWorker: AuditWorkerForker = createRecordingFork({
        entry,
        stdinText: () => JSON.stringify({ fields, submit: AUTH_SITE_LOGIN_FIELDS.submit }),
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
      const started = await manager.startAuditJob({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
      if (!started.ok) {
        throw new Error(`the job did not start: ${started.reason}`);
      }
      const { jobId } = started.job;
      await waitForValue(() => (readJob(database, jobId)?.lastAuthState === 'AWAITING_LOGIN' ? true : null), WAIT_TIMING);
      const tree = await processTreeOf(children.at(-1)?.pid ?? 0);

      const ended: AuditJobView = await waitForValue(() => {
        const job = readJob(database, jobId);
        return job !== null && job.finishedAt !== null ? job : null;
      }, WAIT_TIMING);
      expect(ended).toMatchObject({
        state: 'FINISHED',
        resultRunStatus: 'COMPLETE',
        exitCode: EXIT_CODES.COMPLETE,
        lastAuthState: 'AUTHENTICATED',
        sessionLostUrl: null,
        failureReason: null,
      });
      expect(site.successfulLogins).toBe(1);
      expect(nonReadRequestsOf(site.requests)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
      const states = received.filter(isWorkerMessage).flatMap((message) => (message.type === 'AUTH_STATE' ? [message.state] : []));
      expect(states).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED']);
      // DEF-139: IndexedDB を引き継いだので、2 ページ目まで監査した（2 ページ目はログインの画面へ移さなかった。COMPLETE は上で確かめた）。
      expect(site.requests.filter(({ path, authenticated }) => path === AUTH_SITE_PATHS.adminSecond && authenticated).length).toBeGreaterThan(0);
      // DEF-139（設計書 2.1）: ログインの段の状態の名前の記録が、IPC とジョブの行（画面が読む口）に残る。名前は形だけで、値を持たない。
      const authenticatedMessage = received.filter(isWorkerMessage)
        .find((message): message is Extract<WorkerToParentMessage, { readonly type: 'AUTH_STATE' }> => message.type === 'AUTH_STATE' && message.state === 'AUTHENTICATED');
      const stateNames = readJob(database, jobId)?.loginStage?.stateNames;
      expect(stateNames).toEqual(authenticatedMessage?.loginStateNames);
      expect(stateNames?.cookies.rows).toContainEqual({
        domain: new URL(site.originA).hostname, path: '/', hostOnly: true, shape: null, outcome: 'CARRIED', count: 1,
      });
      expect(stateNames?.localStorage.rows).toContainEqual({ origin: site.originA, shape: { prefix: '', suffix: '_token' }, outcome: 'CARRIED', count: 1 });
      expect(stateNames?.indexedDB.rows).toContainEqual({ origin: site.originA, shape: { prefix: '', suffix: '-session' }, outcome: 'CARRIED', count: 1 });

      // 秘密の目印: 親が受けたメッセージのすべて、ジョブの行、管理データのファイルと WAL、ワーカーの標準出力と標準エラー。
      const databasePath = resolveControlDatabasePath(workDirectory);
      const databaseBytes = [databasePath, `${databasePath}-wal`]
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path).toString('latin1'))
        .join('\n');
      expect(leakedMarkers(JSON.stringify(received))).toEqual([]);
      expect(leakedMarkers(JSON.stringify(manager.listAuditJobs()))).toEqual([]);
      expect(leakedMarkers(databaseBytes)).toEqual([]);
      expect(leakedMarkers(output)).toEqual([]);
      expect(site.secretValues().length).toBeGreaterThan(1);
      expect(await waitUntilExited(tree, CHROMIUM_EXIT_LIMIT_MS), 'processes left after the job ended').toEqual([]);
    } finally {
      await manager?.close();
      closeControlDatabase(database);
    }
  }, SUITE_TIMEOUT_MS);
});
