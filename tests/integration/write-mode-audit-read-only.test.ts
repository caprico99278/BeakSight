// MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 3 章の判断 1、4.5、5 章、6 章の受け入れ条件 4）: 書き込みのモード（`TEST_APPROVED_WRITE`）の
// プロファイルで始めた監査のジョブでも、監査の段は読み取りだけ（読み取りでない要求はサーバに届かず、Run の Safety の記録に止めた要求が残る）ことを確かめる
// 結合テスト。監査のジョブの送信の扱いは、プロファイルのモードでなくジョブの種類で決まる（ワーカー・Run の流れ・Safety・Browser はモードを見ない）。
// - 作りは、認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）で同じことを確かめている `auth-mode-contrast.test.ts`（T32i）に合わせ、プロファイルのモードだけを
//   書き込みのモードに替えた。ジョブの管理（`createAuditJobManager`）から、本物の子 process（`child_process.fork`。一時のビルド）のワーカーで動かす。
// - 監査の段の確かめ: 管理画面の先頭から、読み込みの後でログインの送信先（`/login`）へ main frame のナビゲーションの POST（フォームの送信）を試みる画面
//   （`adminReloginForm`）へリンクする。その POST がサーバに届かず、Run の Safety の記録に止めた POST が残る。対照として、Guard のない Context では、同じ
//   画面の POST がサーバに届くことも確かめる（試みが本物であること）。
// - MI-F2（独立レビュー MI-R の Minor 13 の (b)）: 管理画面の先頭から、読み込みの後でページのスクリプトが fetch の POST と `navigator.sendBeacon` を
//   送ろうとする画面（`adminScriptSends`）へもリンクする。どちらもサーバに届かない。対照の Context では、同じ画面の 2 つの送信がサーバに届く。
// - ログイン用の Browser は、2 つの Chromium（テストの既定の headless shell と、CLI の起動の設定の headless。`launchCliChromium` と同じ起動の部品）で
//   確かめる。対照の Context も同じ 2 つ。監査の段の Browser は、ワーカーの本番の依存（CLI の起動の設定。`WORKER_CONFIG_OVERRIDES` で headless）のまま
//   （入口から替える口はない。`auth-mode-contrast.test.ts` と同じ）。
// - 2 つのプロファイル: 手動のセッションの引き継ぎ（`MANUAL_SESSION`。どの OS でも）と、自動ログイン（`AUTOMATED_LOGIN`。Windows だけ。サーバの開始の確かめで
//   強制するため、ほかでは理由を出して飛ばす）。全部の回の後に 2 秒待って、サーバの記録を数え直す。
// - 監査の段の送信の扱いは `READ_ONLY`（OP-I の後は、人が詳しい内容で選んだ形。`hideJobBrowser` が明示して保存する）。
// サーバは 127.0.0.1 だけで待ち受ける。作業のディレクトリ、管理データ、資格情報のフォルダ、出力先は、一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION, WRITE_AUDIT_MODE, type AuthStrategy } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, readProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import { DEFAULT_AUDIT_SEND_POLICY } from '../../src/core/audit-send-policy.js';
import { PAGE_ARTIFACT_FILE_NAMES, RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { RunStatus } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  AUTH_SITE_SESSION_COOKIE,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteRequest,
} from '../helpers/authenticated-site-fixture.js';
import { AUTO_LOGIN_ENTRY_LAUNCHES, autoLoginWorkerEntrySource, type AutoLoginEntryLaunch } from '../helpers/auto-login-worker-entry.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { expectWorkersExited, isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import { filesUnder, nonReadRequestsOf } from '../helpers/leak-places.js';
import { descendantsOf, listProcesses } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import {
  createPortableTestCredentialProtector,
  createPortableTestKey,
  createTestCredentialStore,
  type TestCredentialStore,
} from '../helpers/test-credential-store.js';
import { createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const IS_WINDOWS = process.platform === 'win32';
const AUTOMATED_SKIP_REASON = 'the automated login runs only on Windows (the server start check rejects it elsewhere)';

const SUITE_TIMEOUT_MS = 600_000;
const JOB_TIMEOUT_MS = 180_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms。`auth-mode-contrast.test.ts` と同じ 2 秒）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
/** 対照（Guard のない Context）で、画面の POST がサーバに届くのを待つ上限（ms）。 */
const CONTROL_DELIVERY_LIMIT_MS = 10_000;
/** 手動のログインの段で、人の操作の代わりの口を待つ時間（ms。テストの口がすぐに引き継ぐ）。 */
const LOGIN_TIMEOUT_MS = 60_000;
/** 監査の段で読む管理画面（管理画面、ログインの送信先へ POST を試みる画面、2 つ目の画面、別の Origin の部品の画面）。 */
const AUDITED_ADMIN_PATHS = Object.freeze([
  AUTH_SITE_PATHS.admin,
  AUTH_SITE_PATHS.adminRelogin,
  AUTH_SITE_PATHS.adminSecond,
  AUTH_SITE_PATHS.adminFrames,
  // MI-F2: スクリプトが fetch の POST と `navigator.sendBeacon` を送ろうとする画面。
  AUTH_SITE_PATHS.adminScriptSends,
] as const);
/** MI-F2: 送信を試みる画面（読み取りが完全でなくてよい画面。止めた送信で不完全になりうる）。 */
const SENDING_ADMIN_PATHS: readonly string[] = Object.freeze([AUTH_SITE_PATHS.adminRelogin, AUTH_SITE_PATHS.adminScriptSends]);
/** MI-F2: スクリプトの送信の受け口（fetch の POST と `navigator.sendBeacon`。サーバの記録の形）。 */
const SCRIPT_SEND_POSTS: readonly string[] = Object.freeze([
  `POST ${AUTH_SITE_PATHS.adminFetchSink}`,
  `POST ${AUTH_SITE_PATHS.adminBeaconSink}`,
]);
/** 監査の fixture のサイトの振る舞い（ログインのフォーム、ログインの送信先へ POST を試みる画面、スクリプトの送信を試みる画面）。 */
const SITE_OPTIONS = Object.freeze({ loginForm: true, adminReloginForm: true, adminScriptSends: true } as const);
/** 巡回するページの数の上限（読む管理画面の数。上限に当たって PARTIAL にならない）。 */
const MAX_PAGES = AUDITED_ADMIN_PATHS.length;
/** 監査の Run の状態として受ける値（送信を試みる画面の読み取りは、止めた送信で PARTIAL になりうる。`auth-mode-contrast.test.ts` と同じ）。 */
const READ_THROUGH_RUN_STATUSES: readonly RunStatus[] = Object.freeze(['COMPLETE', 'PARTIAL']);
const ENTRY_FILE_NAME = 'write-mode-audit-entry.mjs';
/** 手動のログインの段の口が呼ばれた記録のファイル（作業のディレクトリの中）。 */
const MANUAL_STAGE_RECORD = 'manual-login-stage.log';
const POST_METHOD = 'POST';
/** ログインの送信先への POST（サーバの記録の形）。 */
const LOGIN_POST = `${POST_METHOD} ${AUTH_SITE_PATHS.login}`;

/** ログイン用の Browser の起動（テストの既定の headless shell と、CLI の起動の設定の headless）。 */
const LAUNCHES = AUTO_LOGIN_ENTRY_LAUNCHES;
type Launch = AutoLoginEntryLaunch;

/** 対照で、テストの process が起動する Chromium（ログイン用の Browser と同じ 2 つ）。 */
const CONTROL_LAUNCHERS: Readonly<Record<Launch, () => Promise<Browser>>> = Object.freeze({
  'test-default': () => launchHeadlessChromium(),
  cli: () => launchCliChromium(),
});

/** 2 つの書き込みのモードのプロファイル（手動のセッションの引き継ぎと、自動ログイン）。 */
const PROFILES = Object.freeze({
  manual: { profileId: 'example-write-audit-manual', auth: 'MANUAL_SESSION' },
  automated: { profileId: 'example-write-audit-auto', auth: 'AUTOMATED_LOGIN' },
} as const satisfies Record<string, { readonly profileId: string; readonly auth: AuthStrategy }>);
type ProfileKey = keyof typeof PROFILES;

/** 1 つの Chromium の場面の作業の場所（一時のフォルダ）と、記録。 */
interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly credentials: TestCredentialStore;
  readonly site: AuthenticatedSite;
  readonly manager: AuditJobManager;
  readonly children: ChildProcess[];
  readonly workerPids: number[];
  /** 次に起動するワーカーへ標準入力で渡すセッション（手動のジョブだけ。ほかは空）。 */
  nextHandoff: string;
}

const targetConfigPathOf = (key: ProfileKey): string => `local/targets/${PROFILES[key].profileId}.json`;
const outputDirectoryOf = (space: Workspace, key: ProfileKey): string => join(space.directory, `${PROFILES[key].profileId}-output`);

/** プロファイルの認証の設定（手動は `automatedLogin` が null、自動は欄と失敗の条件を持つ。`auth-mode-contrast.test.ts` と同じ形）。 */
const setupOf = (site: AuthenticatedSite, key: ProfileKey): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILES[key].profileId,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
  successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [AUTH_SITE_PATHS.adminLogout],
  auditPathPrefixes: [AUTH_SITE_PATHS.admin],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: PROFILES[key].auth === 'MANUAL_SESSION'
    ? null
    : {
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
async function credentialOf(site: AuthenticatedSite): Promise<{ readonly username: string; readonly password: string }> {
  const values = new Map<string, string>();
  await site.fillCredentials(async (selector, value) => {
    values.set(selector, value);
  });
  return { username: values.get(AUTH_SITE_LOGIN_FIELDS.user) ?? '', password: values.get(AUTH_SITE_LOGIN_FIELDS.pass) ?? '' };
}

/** ターゲット設定を書き、書き込みのモードのプロファイルと認証の設定を保存する（Interaction は、ターゲット設定では有効にしておく）。 */
async function prepareProfile(
  space: { readonly directory: string; readonly database: ControlDatabase; readonly contexts: Map<string, ProfileValidationContext>; readonly site: AuthenticatedSite },
  key: ProfileKey,
): Promise<void> {
  const path = targetConfigPathOf(key);
  await mkdir(join(space.directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(space.directory, path), JSON.stringify(cliTargetConfig(PROFILES[key].profileId, space.site.originA, AUTH_SITE_PATHS.admin, {
    crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
    audit: { performance: false, accessibility: false, interactions: true, screenshots: false },
    output: { directory: join(space.directory, `${PROFILES[key].profileId}-output`) },
  })), 'utf8');
  space.contexts.set(path, { targetConfig: await loadConfig(join(space.directory, path)) });
  const resolveContext = (target: string): ProfileValidationContext | undefined => space.contexts.get(target);
  const created = createProfile(space.database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILES[key].profileId,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: path,
    environment: 'TEST',
    // MI-5: `auth-mode-contrast.test.ts` との違いは、このモードだけ。
    mode: WRITE_AUDIT_MODE,
    auth: PROFILES[key].auth,
    approvedTestOrigins: [space.site.originA],
    environmentEvidenceRef: `evidence/${PROFILES[key].profileId}/isolation-check-1`,
  }, { resolveContext });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。監査の段の送信の扱いは読み取りだけ（OP-I でサイトの既定は通す側になったので、`hideJobBrowser` が
  // 読み取りだけを明示して保存する。人が詳しい内容で選んだ形）。
  hideJobBrowser(space.database, PROFILES[key].profileId);
  expect(readProfileDisplaySettings(space.database, PROFILES[key].profileId).auditSendPolicy).toBe(DEFAULT_AUDIT_SEND_POLICY);
  const saved = saveAuthSetup(space.database, setupOf(space.site, key), { resolveContext });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
}

/** ワーカーがすべて終わり、その子孫（Chromium）が残っていないことを確かめる。 */
async function expectNoChromiumLeft(space: Workspace): Promise<void> {
  await expectWorkersExited(space.children, { limitMs: PROCESS_EXIT_LIMIT_MS, requireExitEvent: true });
  const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
  for (;;) {
    const processes = await listProcesses();
    const descendants = space.workerPids.flatMap((pid) => descendantsOf(pid, processes));
    if (descendants.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      expect(descendants.map(({ name }) => name), 'processes left after the worker exited').toEqual([]);
      return;
    }
    await wait(WAIT_POLL_MS);
  }
}

/** 監査の Run のディレクトリの `run.json`。 */
const runJsonOf = (space: Workspace, key: ProfileKey, job: AuditJobView): Record<string, unknown> => {
  if (job.runDirectory === null) {
    throw new Error('the job has no Run directory');
  }
  return JSON.parse(readFileSync(join(outputDirectoryOf(space, key), job.runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as Record<string, unknown>;
};

/** `page.json` の、このテストが読む項目。 */
interface PageResultView {
  readonly pageUrl: string;
  readonly status: string;
  readonly evidence: readonly { readonly type: string }[];
}

/** 監査の Run のディレクトリの、すべてのページの結果（`page.json`）。 */
const pageResultsOf = (space: Workspace, key: ProfileKey, job: AuditJobView): readonly PageResultView[] =>
  filesUnder(join(outputDirectoryOf(space, key), job.runDirectory ?? ''))
    .filter(([path]) => !path.includes('!') && path.endsWith(PAGE_ARTIFACT_FILE_NAMES.page))
    .map(([, bytes]) => JSON.parse(bytes.toString('utf8')) as PageResultView);

/** 1 つのジョブの結果と、その間のサーバの記録。 */
interface JobObservation {
  readonly job: AuditJobView;
  /** そのジョブの間にサーバに届いた要求。 */
  readonly requests: readonly AuthenticatedSiteRequest[];
  readonly successfulLogins: number;
}

/** 監査のジョブを始めて、終わるまで待つ（手動のジョブは、ワーカーに引き継ぐセッションを渡す）。 */
async function runAuditJob(space: Workspace, key: ProfileKey): Promise<JobObservation> {
  const requestsBefore = space.site.requests.length;
  const loginsBefore = space.site.successfulLogins;
  space.nextHandoff = PROFILES[key].auth === 'MANUAL_SESSION'
    ? JSON.stringify({
      cookie: { name: AUTH_SITE_SESSION_COOKIE, value: space.site.issueSession(), url: space.site.originA },
      url: `${space.site.originA}${AUTH_SITE_PATHS.admin}`,
    })
    : '';
  const started = await space.manager.startAuditJob({ profileId: PROFILES[key].profileId, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
  if (!started.ok) {
    throw new Error(`the audit job did not start: ${started.reason} ${JSON.stringify(started)}`);
  }
  const job = await waitForJob(space.manager, started.job.jobId, isJobEnded, { limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });
  await expectNoChromiumLeft(space);
  return { job, requests: space.site.requests.slice(requestsBefore), successfulLogins: space.site.successfulLogins - loginsBefore };
}

/** 監査の段の要求（ログインの段の後。最初の `adminRelogin` の要求から後）の、読み取りでないもの。 */
const auditStageNonReadOf = (observation: JobObservation): readonly string[] => {
  const first = observation.requests.findIndex(({ path }) => path === AUTH_SITE_PATHS.adminRelogin);
  return first < 0 ? [] : nonReadRequestsOf(observation.requests, first);
};

/** 書き込みのモードの監査の Run の共通の確かめ: 読み取りだけ、Interaction なし、止めた POST の記録がある（`auth-mode-contrast.test.ts` と同じ条件）。 */
function expectReadOnlyAudit(space: Workspace, key: ProfileKey, observation: JobObservation): void {
  const { job, requests } = observation;
  // 書き込みのモードのプロファイルの、監査のジョブ（改訂は始めた時のまま）。
  expect(getProfile(space.database, PROFILES[key].profileId)?.profile.mode).toBe(WRITE_AUDIT_MODE);
  expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', failureReason: null, lastAuthState: 'AUTHENTICATED', profileRevision: MIN_PROFILE_REVISION });
  expect(READ_THROUGH_RUN_STATUSES).toContain(job.resultRunStatus);
  expect(job.exitCode).toBe(exitCodeForRunStatus(job.resultRunStatus ?? 'FAILED'));
  const run = runJsonOf(space, key, job);
  expect((run['executions'] as readonly { readonly endReason: string }[]).map(({ endReason }) => endReason)).toEqual(['COMPLETED']);
  expect(run['incompleteReasons']).toEqual([]);
  // ログインの送信先へ POST を試みる画面を、監査の段で読んだ（試みが起きた）。その POST は Guard が止め、サーバに届かない。
  expect(requests.filter(({ path, authenticated }) => path === AUTH_SITE_PATHS.adminRelogin && authenticated).length).toBeGreaterThan(0);
  expect(auditStageNonReadOf(observation)).toEqual([]);
  // MI-F2: スクリプトが fetch の POST と `navigator.sendBeacon` を送ろうとする画面も、監査の段で読んだ。どちらの送信もサーバに届かない。
  expect(requests.filter(({ path, authenticated }) => path === AUTH_SITE_PATHS.adminScriptSends && authenticated).length).toBeGreaterThan(0);
  expect(nonReadRequestsOf(requests).filter((request) => SCRIPT_SEND_POSTS.includes(request))).toEqual([]);
  const safety = run['safety'] as { readonly blockedRequestsByMethod: Readonly<Record<string, number>>; readonly invariantViolationCount: number };
  expect(safety.blockedRequestsByMethod[POST_METHOD] ?? 0).toBeGreaterThan(0);
  expect(safety.invariantViolationCount).toBe(0);
  // 管理画面の 5 つを読んだ。読み取りが完全でないのは、送信を試みる画面だけ。
  const pages = pageResultsOf(space, key, job);
  expect(pages.map(({ pageUrl }) => new URL(pageUrl).pathname).sort()).toEqual([...AUDITED_ADMIN_PATHS].sort());
  expect(pages.filter(({ pageUrl, status }) => status !== 'AUDITED' && !SENDING_ADMIN_PATHS.includes(new URL(pageUrl).pathname))).toEqual([]);
  expect(pages.filter(({ status }) => status === 'SKIPPED' || status === 'FAILED')).toEqual([]);
  // Interaction を行わない（有効な設定で無効。ターゲット設定では有効にしてある）。書き込みのモードでも、監査は Interaction を有効にしない。
  expect((run['effectiveConfig'] as { readonly audit: { readonly interactions: boolean } }).audit.interactions).toBe(false);
  const types = pages.flatMap(({ evidence }) => evidence.map(({ type }) => type));
  expect(types.length).toBeGreaterThan(0);
  expect(types).not.toContain('interaction');
  // ログアウトと削除の画面は、巡回の候補に入らず、サーバに届かない。
  expect(requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.adminLogout) || path.startsWith(AUTH_SITE_PATHS.adminDelete))).toEqual([]);
}

let build: TemporaryBuild;

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
}, SUITE_TIMEOUT_MS);

describe('MI-5: the audit job of a write mode (TEST_APPROVED_WRITE) profile stays read only', () => {
  describe.each(LAUNCHES)('with the %s Chromium for the login Browser', (launch) => {
    let space: Workspace | undefined;
    const current = (): Workspace => {
      if (space === undefined) {
        throw new Error('no workspace');
      }
      return space;
    };

    beforeAll(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'beaksight-write-mode-audit-'));
      const key = createPortableTestKey();
      const database = openControlDatabase(resolveControlDatabasePath(directory));
      const credentials = await createTestCredentialStore({ protector: createPortableTestCredentialProtector(key) });
      const site = await startAuthenticatedSite(SITE_OPTIONS);
      const contexts = new Map<string, ProfileValidationContext>();
      for (const profile of Object.keys(PROFILES) as ProfileKey[]) {
        await prepareProfile({ directory, database, contexts, site }, profile);
      }
      const credential = await credentialOf(site);
      await credentials.store.register({ profileId: PROFILES.automated.profileId, loginOrigin: site.originA, ...credential });
      const entry = join(build.rootDirectory, `${launch}-${Date.now()}-${ENTRY_FILE_NAME}`);
      await writeFile(entry, autoLoginWorkerEntrySource({
        launch,
        manualStageRecord: join(directory, MANUAL_STAGE_RECORD),
        protectorKey: key,
        portableCredentialStore: true,
        manualStage: { kind: 'SESSION_HANDOFF', loginTimeoutMs: LOGIN_TIMEOUT_MS },
      }), 'utf8');
      const children: ChildProcess[] = [];
      const workerPids: number[] = [];
      const forkWorker: AuditWorkerForker = createRecordingFork({
        stdinText: () => current().nextHandoff,
        onChild: (child) => {
          children.push(child);
          if (child.pid !== undefined) {
            workerPids.push(child.pid);
          }
        },
        onReceived: () => undefined,
        onOutput: () => undefined,
      });
      const manager = createAuditJobManager({
        database,
        repositoryRoot: directory,
        workerPath: entry,
        resolveContext: (path) => contexts.get(path),
        forkWorker,
        credentials: { root: credentials.root, store: credentials.store },
      });
      space = { directory, database, credentials, site, manager, children, workerPids, nextHandoff: '' };
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
      if (space === undefined) {
        return;
      }
      const { manager, children, database, credentials, site, directory } = space;
      await manager.close();
      const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
      for (const child of leftovers) {
        child.kill();
      }
      closeControlDatabase(database);
      await credentials.remove();
      await site.close();
      await rm(directory, { recursive: true, force: true });
      space = undefined;
      expect(leftovers.length, 'workers left running after the tests').toBe(0);
    }, SUITE_TIMEOUT_MS);

    it('the manual session handoff of a write mode profile: the audit starts, and no non-read request reaches the server', async () => {
      const work = current();
      const observation = await runAuditJob(work, 'manual');
      expectReadOnlyAudit(work, 'manual', observation);
      // ログインの POST も 0（サーバに届いた読み取りでない要求が、ジョブの全体で 0）。
      expect(nonReadRequestsOf(observation.requests)).toEqual([]);
      expect(observation.successfulLogins).toBe(0);
    }, JOB_TIMEOUT_MS);

    it.skipIf(!IS_WINDOWS)(`the automated login of a write mode profile: one login POST in the login stage only, and the audit stage is read only${IS_WINDOWS ? '' : ` [skipped: ${AUTOMATED_SKIP_REASON}]`}`, async () => {
      const work = current();
      const observation = await runAuditJob(work, 'automated');
      expectReadOnlyAudit(work, 'automated', observation);
      // ログインの POST は、ログインの段の 1 回だけ（監査の段の最初の要求より前）。監査の段の同じ形の POST は、サーバに届かない。
      expect(nonReadRequestsOf(observation.requests)).toEqual([LOGIN_POST]);
      const loginPostIndex = observation.requests.findIndex(({ method, path }) => `${method} ${path}` === LOGIN_POST);
      const firstAuditStageIndex = observation.requests.findIndex(({ path }) => path === AUTH_SITE_PATHS.adminRelogin);
      expect(loginPostIndex).toBeGreaterThanOrEqual(0);
      expect(loginPostIndex).toBeLessThan(firstAuditStageIndex);
      expect(observation.successfulLogins).toBe(1);
    }, JOB_TIMEOUT_MS);

    it('counts the server record again after 2 seconds: only the login POST of the automated login stage arrived', async () => {
      const work = current();
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(nonReadRequestsOf(work.site.requests)).toEqual(IS_WINDOWS ? [LOGIN_POST] : []);
    });

    it('the control: without the Guard, the same pages deliver their POSTs to the server (the attempts are real)', async () => {
      const control = await startAuthenticatedSite(SITE_OPTIONS);
      const browser = await CONTROL_LAUNCHERS[launch]();
      try {
        const context = await browser.newContext();
        await context.addCookies([{ name: AUTH_SITE_SESSION_COOKIE, value: control.issueSession(), url: control.originA }]);
        const page = await context.newPage();
        await page.goto(`${control.originA}${AUTH_SITE_PATHS.adminRelogin}`);
        const deadline = Date.now() + CONTROL_DELIVERY_LIMIT_MS;
        while (nonReadRequestsOf(control.requests).length === 0 && Date.now() < deadline) {
          await wait(WAIT_POLL_MS);
        }
        expect(nonReadRequestsOf(control.requests)).toEqual([LOGIN_POST]);
        // MI-F2: 同じ Context で、スクリプトが fetch の POST と `navigator.sendBeacon` を送る画面を開くと、2 つの送信がサーバに届く（試みが本物であること）。
        await page.goto(`${control.originA}${AUTH_SITE_PATHS.adminScriptSends}`);
        const scriptDeadline = Date.now() + CONTROL_DELIVERY_LIMIT_MS;
        const scriptSends = (): readonly string[] => nonReadRequestsOf(control.requests).filter((request) => SCRIPT_SEND_POSTS.includes(request));
        while (scriptSends().length < SCRIPT_SEND_POSTS.length && Date.now() < scriptDeadline) {
          await wait(WAIT_POLL_MS);
        }
        expect([...scriptSends()].sort()).toEqual([...SCRIPT_SEND_POSTS].sort());
      } finally {
        await browser.close();
        await control.close();
      }
    });
  });
});
