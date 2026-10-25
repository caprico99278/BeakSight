// T32i（Task 32 の設計書 `2026-10-15-beaksight-task-32-integration-final-gate-design.md` 4.3。ロードマップ Task 32 の「テストサイトで手動
// セッション認証と自動ログインが異なる権限として成立」）: 1 つの fixture のサイト（ログインの画面と、ログインの後に読める管理画面を持つ
// `authenticated-site-fixture.ts` の `loginForm`）に対して、手動のセッションの引き継ぎ（`MANUAL_SESSION`）と自動ログイン（`AUTOMATED_LOGIN`）の
// 2 つのプロファイルで監査を行い、並べて確かめる結合テスト。
// - 動かし方: ジョブの管理（`createAuditJobManager`）から、本物の子 process（`child_process.fork`。一時のビルド）のワーカーで動かす。IPC、ワーカーの
//   標準出力と標準エラー、管理データ（WAL を含む）に秘密が出ないことを確かめるには、本物のワーカーとジョブの管理が要るため（同じ process の中の
//   流れでは、IPC と管理データの書き込みが起きない）。作りは `audit-worker-auth-fork.test.ts`（T25d）と `audit-worker-automated-login-fork.test.ts`
//   （T26d-2）に合わせる。
// - 子 process の入口は、テストだけの入口（一時のビルドの root に書く `.mjs`）。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの
//   口（関数の引数）で呼ぶ。
//   - 手動のログインの段: ログイン用の Browser を headless に替え、人の操作の代わりの口（`onLoginPageReady`）で、テストが標準入力で渡した
//     セッション（サーバが `issueSession()` で作った値）を Cookie に入れて管理画面を開く（人がすでに持つセッションを引き継ぐ形。ログインの POST を
//     送らない）。口が呼ばれたら、記録のファイルに書く。
//   - 自動ログインの段: 資格情報のファイルの部品は、別の process でも戻せる偽の暗号化の部品（テストだけの鍵。`test-credential-store.ts`）。
//     Windows の資格情報マネージャーにも本物の DPAPI にも登録しない。
//   - ログイン用の Browser は、2 つの Chromium（テストの既定の headless shell と、CLI の起動の設定の headless）で確かめる。監査の段の Browser は、
//     ワーカーの本番の依存（CLI の起動の設定。`WORKER_CONFIG_OVERRIDES` で headless）のまま（入口から替える口はない）。
// - 監査の段の確かめ: 管理画面の先頭から、読み込みの後でログインの送信先（`/login`）へ main frame のナビゲーションの POST を試みる画面
//   （`adminReloginForm`）へリンクする。ログインの段の Guard が許す形と同じ要求が、監査の段では止まる（サーバに届かず、Run の Safety の記録に
//   止めた POST が残る）。対照として、Guard のない Context では、同じ画面の POST がサーバに届くことも確かめる。
// - 確かめる項目（両方のプロファイル。自動ログインの失敗の形は資格情報の誤り 1 つ）: ログインの POST の数（手動 0、自動はログインの段の 1）、
//   監査の段で読み取りでない要求 0、Interaction の送信 0（有効な設定で無効、Interaction の Evidence がない）、資格情報とセッションの目印が成果物
//   （ZIP の中身を含む）・管理データ（WAL を含む）・IPC・ワーカーの出力に出ない、ログインの段の許可が監査の段に引き継がれない、自動ログインに
//   失敗しても手動のログインの段を開かない、認証の状態の記録（ジョブの行、`AUTH_STATE`、試しの表）がそれぞれの方式を示す。全部の回の後に
//   2 秒待って、サーバの記録を数え直す。
// 自動ログインは Windows だけで動く（サーバの開始の確かめで強制する）ので、この端から端は Windows だけで行い、ほかでは理由を出して飛ばす。
// サーバは 127.0.0.1 だけで待ち受ける。作業のディレクトリ、管理データ、資格情報のフォルダ、出力先は、一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAILURE_EXIT_CODE, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import {  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION, type AuthStrategy } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { PAGE_ARTIFACT_FILE_NAMES, RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { RunStatus } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
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
import {
  AUTO_LOGIN_CONTROL_TABLES,
  databaseFilePlaces,
  databaseTablesText,
  filesUnder,
  nonReadRequestsOf,
  placesWithMarkers,
  textLeakPlace,
} from '../helpers/leak-places.js';
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
const SKIP_REASON = 'the automated login runs only on Windows (the server start check rejects it elsewhere)';

const SUITE_TIMEOUT_MS = 600_000;
const JOB_TIMEOUT_MS = 180_000;
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms。指示書の 2 秒）。 */
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
] as const);
/** 巡回するページの数の上限（読む管理画面の数。上限に当たって PARTIAL にならない）。 */
const MAX_PAGES = AUDITED_ADMIN_PATHS.length;
/**
 * 監査の Run の状態として受ける値。送信を試みる画面の読み取りは、止めた送信で PARTIAL になりうる（`DOM_READINESS_FAILED`。発見事項）。
 * 安全の理由で止まった状態（`ABORTED_BY_SAFETY`）と `FAILED` は受けない。
 */
const READ_THROUGH_RUN_STATUSES: readonly RunStatus[] = Object.freeze(['COMPLETE', 'PARTIAL']);
const ENTRY_FILE_NAME = 'auth-mode-contrast-entry.mjs';
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

/** 3 つのプロファイル（手動のセッションの引き継ぎ、自動ログイン、資格情報の誤りの自動ログイン）。 */
const PROFILES = Object.freeze({
  manual: { profileId: 'example-contrast-manual', auth: 'MANUAL_SESSION' },
  automated: { profileId: 'example-contrast-auto', auth: 'AUTOMATED_LOGIN' },
  automatedFailure: { profileId: 'example-contrast-auto-fail', auth: 'AUTOMATED_LOGIN' },
} as const satisfies Record<string, { readonly profileId: string; readonly auth: AuthStrategy }>);
type ProfileKey = keyof typeof PROFILES;

/** 誤りの資格情報（自動ログインの失敗の形）にするため、正しいパスワードの後に足す文字。 */
const WRONG_PASSWORD_SUFFIX = '-wrong';

/** 1 つの Chromium の場面の作業の場所（一時のフォルダ）と、記録。 */
interface Workspace {
  readonly launch: Launch;
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly credentials: TestCredentialStore;
  readonly site: AuthenticatedSite;
  readonly manager: AuditJobManager;
  readonly contexts: Map<string, ProfileValidationContext>;
  /** 親が受けたすべてのメッセージ（受けた順）。 */
  readonly received: unknown[];
  /** 親が送ったメッセージ（`START` と `STOP`）。 */
  readonly sent: unknown[];
  /** ワーカーの標準出力と標準エラー。 */
  workerOutput: string;
  readonly children: ChildProcess[];
  readonly workerPids: number[];
  /** 次に起動するワーカーへ標準入力で渡すセッション（手動のジョブだけ。ほかは空）。 */
  nextHandoff: string;
  /** サイトの正しい資格情報（欄に入れる口で受け取った値。出力しない）。 */
  readonly credential: { readonly username: string; readonly password: string };
}

const targetConfigPathOf = (key: ProfileKey): string => `local/targets/${PROFILES[key].profileId}.json`;
const outputDirectoryOf = (space: Workspace, key: ProfileKey): string => join(space.directory, `${PROFILES[key].profileId}-output`);

/** プロファイルの認証の設定（手動は `automatedLogin` が null、自動は欄と失敗の条件を持つ）。 */
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

/** ターゲット設定を書き、プロファイルと認証の設定を保存する（Interaction は、ターゲット設定では有効にしておく）。 */
async function prepareProfile(space: Pick<Workspace, 'directory' | 'database' | 'contexts' | 'site'>, key: ProfileKey): Promise<void> {
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
    mode: 'TEST_AUTH_PASSIVE',
    auth: PROFILES[key].auth,
    approvedTestOrigins: [space.site.originA],
    environmentEvidenceRef: `evidence/${PROFILES[key].profileId}/isolation-check-1`,
  }, { resolveContext });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。
  hideJobBrowser(space.database, PROFILES[key].profileId);
  const saved = saveAuthSetup(space.database, setupOf(space.site, key), { resolveContext });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
}

/** 手動のログインの段の口が呼ばれた記録（行）。 */
const manualStageCalls = (space: Workspace): readonly string[] => {
  const path = join(space.directory, MANUAL_STAGE_RECORD);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : [];
};

/** 自動ログインの試しの表の、ジョブの行（結果と送信したか）。 */
const attemptsOf = (space: Workspace, jobId: string): readonly unknown[] => {
  const raw = new DatabaseSync(resolveControlDatabasePath(space.directory), { readOnly: true });
  try {
    return raw.prepare('SELECT result, submitted FROM auto_login_attempts WHERE job_id = ?').all(jobId);
  } finally {
    raw.close();
  }
};

/** 目印が出た場所（管理データのファイルと WAL、表、IPC の記録、ワーカーの出力、ジョブの見え方、すべてのプロファイルの出力先）。 */
function leakedPlaces(space: Workspace, markers: readonly string[]): readonly string[] {
  const databasePath = resolveControlDatabasePath(space.directory);
  return placesWithMarkers([
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, AUTO_LOGIN_CONTROL_TABLES)),
    textLeakPlace('ipc received', JSON.stringify(space.received)),
    textLeakPlace('ipc sent', JSON.stringify(space.sent)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('job views', JSON.stringify(space.manager.listAuditJobs())),
    ...(Object.keys(PROFILES) as ProfileKey[]).flatMap((key) => filesUnder(outputDirectoryOf(space, key))),
  ], markers);
}

/** 資格情報（誤りの値を含む）とセッションの目印。 */
const markersOf = (space: Workspace): readonly string[] => [
  space.credential.username,
  space.credential.password,
  `${space.credential.password}${WRONG_PASSWORD_SUFFIX}`,
  ...space.site.secretValues(),
];

const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

/** ジョブの、`since` 番目から後に受けたメッセージ（`HEARTBEAT` を除く）。 */
const workerMessagesSince = (space: Workspace, since: number): readonly WorkerToParentMessage[] =>
  space.received.slice(since).filter(isWorkerMessage).filter(({ type }) => type !== 'HEARTBEAT');

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

/** 1 つのジョブの結果と、その間のサーバの記録とメッセージ。 */
interface JobObservation {
  readonly job: AuditJobView;
  /** そのジョブの間にサーバに届いた要求。 */
  readonly requests: readonly AuthenticatedSiteRequest[];
  readonly messages: readonly WorkerToParentMessage[];
  /** そのジョブの間に呼ばれた、手動のログインの段の口。 */
  readonly manualStageCalls: readonly string[];
  readonly successfulLogins: number;
}

/** 監査のジョブを始めて、終わるまで待つ（手動のジョブは、ワーカーに引き継ぐセッションを渡す）。 */
async function runAuditJob(space: Workspace, key: ProfileKey): Promise<JobObservation> {
  const requestsBefore = space.site.requests.length;
  const messagesBefore = space.received.length;
  const manualBefore = manualStageCalls(space).length;
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
  return {
    job,
    requests: space.site.requests.slice(requestsBefore),
    messages: workerMessagesSince(space, messagesBefore),
    manualStageCalls: manualStageCalls(space).slice(manualBefore),
    successfulLogins: space.site.successfulLogins - loginsBefore,
  };
}

/** `AUTH_STATE` の状態の並びと、自動ログインの結果の並び。 */
const authStatesOf = (observation: JobObservation): readonly { readonly state: string; readonly automatedLogin: unknown }[] =>
  observation.messages.flatMap((message) => (message.type === 'AUTH_STATE'
    ? [{ state: message.state, automatedLogin: message.automatedLogin ?? null }]
    : []));

/** 監査の段の要求（ログインの段の後。最初の `adminRelogin` の要求から後）の、読み取りでないもの。 */
const auditStageNonReadOf = (observation: JobObservation): readonly string[] => {
  const first = observation.requests.findIndex(({ path }) => path === AUTH_SITE_PATHS.adminRelogin);
  return first < 0 ? [] : nonReadRequestsOf(observation.requests, first);
};

/** 監査の Run の共通の確かめ（両方のプロファイル）: 読み取りだけ、Interaction なし、ログインの段の許可を引き継がない。 */
function expectReadOnlyAudit(space: Workspace, key: ProfileKey, observation: JobObservation): void {
  const { job, requests } = observation;
  // Run は最後まで進む（安全の理由で止まらない）。止めた送信で、その画面の読み取りが PARTIAL になりうる（発見事項。下のページの確かめ）。
  expect(job).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', failureReason: null, lastAuthState: 'AUTHENTICATED' });
  expect(READ_THROUGH_RUN_STATUSES).toContain(job.resultRunStatus);
  expect(job.exitCode).toBe(exitCodeForRunStatus(job.resultRunStatus ?? 'FAILED'));
  const run = runJsonOf(space, key, job);
  expect((run['executions'] as readonly { readonly endReason: string }[]).map(({ endReason }) => endReason)).toEqual(['COMPLETED']);
  expect(run['incompleteReasons']).toEqual([]);
  // ログインの送信先へ POST を試みる画面を、監査の段で読んだ（試みが起きた）。その POST は Guard が止め、サーバに届かない。
  expect(requests.filter(({ path, authenticated }) => path === AUTH_SITE_PATHS.adminRelogin && authenticated).length).toBeGreaterThan(0);
  expect(auditStageNonReadOf(observation)).toEqual([]);
  const safety = run['safety'] as { readonly blockedRequestsByMethod: Readonly<Record<string, number>>; readonly invariantViolationCount: number };
  expect(safety.blockedRequestsByMethod[POST_METHOD] ?? 0).toBeGreaterThan(0);
  expect(safety.invariantViolationCount).toBe(0);
  // 管理画面の 4 つを読んだ。読み取りが完全でないのは、送信を試みる画面だけ（ほかは AUDITED。ログインの画面へ移されていない）。
  const pages = pageResultsOf(space, key, job);
  expect(pages.map(({ pageUrl }) => new URL(pageUrl).pathname).sort()).toEqual([...AUDITED_ADMIN_PATHS].sort());
  expect(pages.filter(({ pageUrl, status }) => status !== 'AUDITED' && new URL(pageUrl).pathname !== AUTH_SITE_PATHS.adminRelogin)).toEqual([]);
  expect(pages.filter(({ status }) => status === 'SKIPPED' || status === 'FAILED')).toEqual([]);
  // Interaction を行わない（有効な設定で無効。ターゲット設定では有効にしてある。Interaction の Evidence がない）。
  expect((run['effectiveConfig'] as { readonly audit: { readonly interactions: boolean } }).audit.interactions).toBe(false);
  const types = pages.flatMap(({ evidence }) => evidence.map(({ type }) => type));
  expect(types.length).toBeGreaterThan(0);
  expect(types).not.toContain('interaction');
  // ログアウトと削除の画面は、巡回の候補に入らず、サーバに届かない。成果物は ZIP まで書いた。
  expect(requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.adminLogout) || path.startsWith(AUTH_SITE_PATHS.adminDelete))).toEqual([]);
  expect(filesUnder(outputDirectoryOf(space, key)).some(([path]) => path.includes('.zip!'))).toBe(true);
}

let build: TemporaryBuild;

beforeAll(async () => {
  if (!IS_WINDOWS) {
    return;
  }
  build = await buildIntoTemporaryDirectory();
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
}, SUITE_TIMEOUT_MS);

describe.skipIf(!IS_WINDOWS)(`T32i: the manual session handoff and the automated login as different permissions${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, () => {
  describe.each(LAUNCHES)('with the %s Chromium for the login Browser', (launch) => {
    let space: Workspace | undefined;
    const current = (): Workspace => {
      if (space === undefined) {
        throw new Error('no workspace');
      }
      return space;
    };

    beforeAll(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'beaksight-auth-mode-contrast-'));
      const key = createPortableTestKey();
      const database = openControlDatabase(resolveControlDatabasePath(directory));
      const credentials = await createTestCredentialStore({ protector: createPortableTestCredentialProtector(key) });
      const site = await startAuthenticatedSite({ loginForm: true, adminReloginForm: true });
      const contexts = new Map<string, ProfileValidationContext>();
      for (const profile of Object.keys(PROFILES) as ProfileKey[]) {
        await prepareProfile({ directory, database, contexts, site }, profile);
      }
      const credential = await credentialOf(site);
      await credentials.store.register({ profileId: PROFILES.automated.profileId, loginOrigin: site.originA, ...credential });
      await credentials.store.register({
        profileId: PROFILES.automatedFailure.profileId,
        loginOrigin: site.originA,
        username: credential.username,
        password: `${credential.password}${WRONG_PASSWORD_SUFFIX}`,
      });
      const entry = join(build.rootDirectory, `${launch}-${Date.now()}-${ENTRY_FILE_NAME}`);
      // 手動のログインの段は、手動のジョブのときだけ、テストが標準入力で渡すセッションを入れる（資格情報とセッションの値は入口に書かない）。
      await writeFile(entry, autoLoginWorkerEntrySource({
        launch,
        manualStageRecord: join(directory, MANUAL_STAGE_RECORD),
        protectorKey: key,
        portableCredentialStore: true,
        manualStage: { kind: 'SESSION_HANDOFF', loginTimeoutMs: LOGIN_TIMEOUT_MS },
      }), 'utf8');
      const children: ChildProcess[] = [];
      const received: unknown[] = [];
      const sent: unknown[] = [];
      const workerPids: number[] = [];
      // IPC と標準出力・標準エラーを記録し、手動のジョブには引き継ぐセッションを標準入力で渡して fork する。
      const contrastFork: AuditWorkerForker = createRecordingFork({
        stdinText: () => current().nextHandoff,
        onChild: (child) => {
          children.push(child);
          if (child.pid !== undefined) {
            workerPids.push(child.pid);
          }
        },
        onReceived: (message) => received.push(message),
        onOutput: (chunk) => { current().workerOutput += chunk; },
        onSent: (message) => sent.push(message),
      });
      const manager = createAuditJobManager({
        database,
        repositoryRoot: directory,
        workerPath: entry,
        resolveContext: (path) => contexts.get(path),
        forkWorker: contrastFork,
        credentials: { root: credentials.root, store: credentials.store },
      });
      space = {
        launch, directory, database, credentials, site, manager, contexts, received, sent, workerOutput: '', children, workerPids, nextHandoff: '', credential,
      };
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

    it('the manual session handoff: no login POST, read only audit, no Interaction, no carried over login permission, no secret marker', async () => {
      const work = current();
      const observation = await runAuditJob(work, 'manual');
      expectReadOnlyAudit(work, 'manual', observation);
      // ログインの POST は 0（サーバに届いた読み取りでない要求が、ジョブの全体で 0）。人の操作の代わりの口は、セッションを引き継いだだけ。
      expect(nonReadRequestsOf(observation.requests)).toEqual([]);
      expect(observation.successfulLogins).toBe(0);
      expect(observation.manualStageCalls).toEqual(['launchLoginBrowser', 'onLoginPageReady']);
      // 認証の状態の記録: 手動のログインの段（`AWAITING_LOGIN` → `AUTHENTICATED`。自動ログインの結果を持たない）。試しの表に行がない。
      expect(authStatesOf(observation)).toEqual([
        { state: 'AWAITING_LOGIN', automatedLogin: null },
        { state: 'AUTHENTICATED', automatedLogin: null },
      ]);
      expect(observation.job.autoLoginAttempt).toBeNull();
      expect(attemptsOf(work, observation.job.jobId)).toEqual([]);
      expect(leakedPlaces(work, markersOf(work))).toEqual([]);
    }, JOB_TIMEOUT_MS);

    it('the automated login: one login POST in the login stage only, read only audit, no Interaction, the login permission not carried over', async () => {
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
      // 手動のログインの段を開かない。
      expect(observation.manualStageCalls).toEqual([]);
      // 認証の状態の記録: 自動ログインの結果（成功、送信あり）。`AWAITING_LOGIN`（人を待つ）を送らない。試しの表に 1 行。
      const states = authStatesOf(observation);
      expect(states.map(({ state }) => state)).not.toContain('AWAITING_LOGIN');
      expect(states.at(-1)).toMatchObject({ state: 'AUTHENTICATED', automatedLogin: { result: 'SUCCEEDED', submitted: 'YES' } });
      expect(observation.job.autoLoginAttempt).toMatchObject({ result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null });
      expect(attemptsOf(work, observation.job.jobId)).toEqual([{ result: 'SUCCEEDED', submitted: 'YES' }]);
      expect(leakedPlaces(work, markersOf(work))).toEqual([]);
    }, JOB_TIMEOUT_MS);

    it('the automated login failure (invalid credentials): no audit, and the manual login stage is never opened', async () => {
      const work = current();
      const observation = await runAuditJob(work, 'automatedFailure');
      expect(observation.job).toMatchObject({
        jobKind: 'AUDIT',
        state: 'FAILED',
        exitCode: FAILURE_EXIT_CODE,
        failureReason: 'INVALID_CREDENTIALS',
        runId: null,
        lastAuthState: 'AUTOMATED_LOGIN_FAILED',
        autoLoginAttempt: { result: 'INVALID_CREDENTIALS', submitted: 'YES' },
      });
      // ログインの POST は 1 回（誤りの資格情報）。監査を始めない（管理画面を読まない、Run を作らない）。
      expect(nonReadRequestsOf(observation.requests)).toEqual([LOGIN_POST]);
      expect(observation.successfulLogins).toBe(0);
      expect(observation.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.admin))).toEqual([]);
      expect(observation.messages.map(({ type }) => type)).not.toContain('RUN_STARTED');
      expect(existsSync(outputDirectoryOf(work, 'automatedFailure'))).toBe(false);
      // 手動のログインの段（ログイン用の Browser の起動と、人の操作の代わりの口）を、一度も呼ばない。
      expect(observation.manualStageCalls).toEqual([]);
      expect(authStatesOf(observation).map(({ state }) => state)).toEqual(['AUTOMATED_LOGIN_FAILED']);
      expect(attemptsOf(work, observation.job.jobId)).toEqual([{ result: 'INVALID_CREDENTIALS', submitted: 'YES' }]);
      expect(leakedPlaces(work, markersOf(work))).toEqual([]);
    }, JOB_TIMEOUT_MS);

    it('counts the server record again after 2 seconds: only the two login POSTs of the automated login stages arrived', async () => {
      const work = current();
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(nonReadRequestsOf(work.site.requests)).toEqual([LOGIN_POST, LOGIN_POST]);
      expect(work.site.successfulLogins).toBe(1);
      expect(manualStageCalls(work)).toEqual(['launchLoginBrowser', 'onLoginPageReady']);
    });

    it('the control: without the Guard, the same page delivers its login POST to the server (the attempt is real)', async () => {
      const control = await startAuthenticatedSite({ loginForm: true, adminReloginForm: true });
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
      } finally {
        await browser.close();
        await control.close();
      }
    });

    it('the control: the marker search finds a marker placed on purpose in the output and in the IPC record', async () => {
      const work = current();
      const [marker] = work.site.secretValues();
      expect(marker).toBeDefined();
      const placed = join(outputDirectoryOf(work, 'manual'), 'placed-on-purpose.txt');
      await writeFile(placed, `x${marker ?? ''}x`, 'utf8');
      work.received.push({ placedOnPurpose: marker });
      try {
        expect(leakedPlaces(work, [marker ?? ''])).toEqual(['ipc received', placed]);
      } finally {
        work.received.pop();
        await rm(placed, { force: true });
      }
    });
  });
});
