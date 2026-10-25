// AS-c（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「ユーザーの言葉と選択（AS-c）」「AS-c の Blocker」「AS-c の WebSocket の Blocker」の
// 行の 2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` のプロファイルの、スクリプトで送るログインの監査を、本物のワーカー（ジョブの管理が `child_process.fork`
// する一時のビルド）で、ログインから監査の終わりまで通す（`spa-audit-worker-fork.test.ts` と同じ作り。ログイン用の Browser は、テストの既定の headless
// shell と、CLI の起動の設定の両方）。
// - サイトは fixture（`startSpaAuthSite`）。画面を開くたびに token を更新し（`refreshOnLoad`）、更新で前の token を無効にし、使い終えた refresh token の
//   再使用でセッションを消す（`refreshRotation`）。
// - 確かめること: ジョブが認証のまま終わる（セッションの切れなし）。監査の段で token を更新し、更新した状態を次の Context へ引き継ぐ（再使用 0 回）。
//   token・API の鍵・資格情報（目印の値）が、親が受けたメッセージのすべて（IPC）、ジョブの一覧、管理データのファイル（WAL を含む）、ワーカーの標準出力と
//   標準エラー、成果物（保存と `run.json` を含む。ZIP の中身も）に出ない。process が残らない。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { saveProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { placesWithMarkers } from '../helpers/leak-places.js';
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
const ENTRY_FILE_NAME = 'audit-send-refresh-worker-test-entry.mjs';
const ENTRY_DIST_PREFIX = './dist/';
/** 監査する画面の数（管理画面と、会員の登録と更新の画面。どれも開くたびに token を更新する）。 */
const MAX_PAGES = 3;
/** 1 つの画面の最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
const MAX_LOGIN_ATTEMPTS = 1;
const SERVICE_REQUEST_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const WAIT_TIMING = Object.freeze({ limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });

const LOGIN_LAUNCHES: readonly (readonly [string, TestLoginWorkerLaunch])[] = [
  ['the default test Chromium', 'TEST_DEFAULT'],
  ['the CLI Chromium', 'CLI'],
];
const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

describe('AS-c: the token refresh of a PASS_EXCEPT_DELETE audit in a child worker', () => {
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
    const profileId = `example-audit-send-refresh-${loginLaunch.toLowerCase().split('_').join('-')}`;
    const targetConfigPath = `local/targets/${profileId}.json`;
    const outputDirectory = (): string => join(workDirectory, `${profileId}-output`);

    beforeAll(async () => {
      site = await startSpaAuthSite({ refreshOnLoad: true, refreshRotation: true });
      site.addMember('既存花子');
      workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-send-refresh-fork-'));
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
      excludedPaths: [SPA_APP_PATHS.logout],
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      loginSideRequests: [],
      successStorageKey: { origin: site.appOrigin, ...FIXTURE_KEY },
      auditReadRequests: [],
      serviceRequestLimits: SERVICE_REQUEST_LIMITS,
    });

    it(`refreshes the token on every load, hands the new state to the next Context, and leaks no token (${label})`, async () => {
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
        // AS-b: プロファイルの監査の段の送信の扱い（ジョブのブラウザは headless のまま）。
        expect(saveProfileDisplaySettings(database, profileId, { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' }).ok).toBe(true);
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
        await waitForValue(() => (readJob(database, jobId)?.lastAuthState === 'AWAITING_LOGIN' ? true : null), WAIT_TIMING);
        const tree = await processTreeOf(children.at(-1)?.pid ?? 0);
        const ended: AuditJobView = await waitForValue(() => {
          const job = readJob(database, jobId);
          return job !== null && job.finishedAt !== null ? job : null;
        }, WAIT_TIMING);
        expect(ended).toMatchObject({ state: 'FINISHED', lastAuthState: 'AUTHENTICATED', failureReason: null });
        await wait(LATE_REQUEST_WAIT_MS);

        const { places, run, pages } = readRunArtifacts(outputDirectory());
        expect(run?.executions.at(-1)?.endReason).toBe('COMPLETED');
        expect(run?.effectiveConfig.audit.sendPolicy).toBe('PASS_EXCEPT_DELETE');
        expect(pages).toHaveLength(MAX_PAGES);
        // 監査の段の読み込みのたびに 1 回更新し（ログインの段の分を足す）、古い refresh token の再使用はない（引き継ぎが効いた）。
        expect(site.refreshes).toBeGreaterThanOrEqual(MAX_PAGES * PRIMARY_LOADS_PER_PAGE);
        expect(site.reusedRefreshes).toBe(0);
        expect(run?.safety.auditSend?.passedRequests).toBeGreaterThanOrEqual(MAX_PAGES * PRIMARY_LOADS_PER_PAGE);

        // 目印: 発行した token・API の鍵・資格情報。
        const markers = site.secretValues();
        expect(markers.length).toBeGreaterThan(MAX_PAGES * PRIMARY_LOADS_PER_PAGE);
        const leaked = (text: string): readonly string[] => markers.filter((marker) => text.includes(marker));
        const databasePath = resolveControlDatabasePath(workDirectory);
        const databaseBytes = [databasePath, `${databasePath}-wal`]
          .filter((path) => existsSync(path))
          .map((path) => readFileSync(path).toString('latin1'))
          .join('\n');
        expect(received.filter(isWorkerMessage)).toHaveLength(received.length);
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
