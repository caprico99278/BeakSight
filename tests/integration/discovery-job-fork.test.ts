// T27d（Task 27 の設計書 3 章、4.2、4.4、4.6、6 章）: 発見のジョブ（`DISCOVERY`）を、ジョブの管理（`createAuditJobManager` の `startDiscovery`）から、
// 本物の子 process（`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）で、端から端まで確かめる結合テスト。
// - 子 process の入口は、テストだけの入口（一時のビルドの root に書く `.mjs`）。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの
//   口（関数の引数）で呼ぶ: 手動のログインの段の Browser を CLI の起動の設定の headless に替え、人の操作の代わりに、テストが標準入力で渡した仮の
//   資格情報を入れる。自動ログインでは、資格情報のファイルの部品を、別の process でも戻せる偽の暗号化の部品（テストだけの鍵）で作る。発見の
//   Browser は本番の依存のまま（CLI の起動の設定の headless。テストの既定の Chromium は `discovery-run.test.ts` で確かめる）。
// - 手動のログインと自動のログインのそれぞれで、発見を最後まで行い、`discovery.json` と索引が期待どおり（分類、ドリフトの `NEW`）。手動のログインで
//   続けて、2 回目は `UNCHANGED`、画面を変えて `CHANGED`・`MISSING`、巡回の上限で `NOT_REVISITED`、同じ識別の digest の中身の違う 2 つの form は
//   `DUPLICATE_IDENTITY_CONFLICT`。
// - サイトへの要求: ログインの POST（ログインの段）のほかは GET（と HEAD）だけ。読まないパスと範囲の外と危険な語は 0 件。読み込みの間隔は設定の
//   値以上（サーバに届いた時刻の、最初から最後までの長さで。DEF-100 fix から許容なし）。読んだ画面の数は上限以下。
// - セッションの切れで止まる（`SESSION_LOST` を記録し、読んだ画面までを索引に入れる）。ワーカーが途中で落ちたら、ジョブは中断（索引を変えない。
//   再開しない）。
// - 秘密の目印（セッションの値、localStorage、資格情報、CSRF とトークン、入力の値）が、`discovery.json`、管理データのファイルと WAL と表、親が
//   受けたメッセージ、ワーカーの標準出力と標準エラーに出ない。ワーカーと Chromium の process が残らない。
// - T27e（Task 27 の設計書 4.5、4.6）: 発見の後に、READ の確かめの定義を作り（候補に照らす検証 `validateReadCheckDefinition` と保存
//   `createReadCheck` を直接呼ぶ）、READ の確かめのジョブ（`startReadCheck`）を、手動と自動のログインのそれぞれで最後まで行う。結果が
//   `read_check_results` に記録される。サーバが受けた要求は、ログインの POST のほかは GET（と HEAD）だけで、READ の URL の query は定義の欄の名前だけ。
//   秘密の目印（表の行の目印を含む）が、`read-evidence.json`、管理データ、IPC、ワーカーの出力に出ない。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、資格情報のフォルダ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import {  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../src/control/job/auto-login-limits.js';
import { readDiscoveryIndex, type DiscoveryCandidateIndexView } from '../../src/control/job/discovery-index-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { createReadCheck, readRecentReadCheckResults } from '../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import {
  STDIN_CREDENTIALS_EXPRESSION,
  STDIN_CREDENTIALS_PRELUDE,
  createRecordingFork,
  hideJobBrowser,
} from '../helpers/worker-fork-support.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import {
  DISCOVERY_SITE_FORBIDDEN_PATHS,
  DISCOVERY_SITE_LOGIN_FIELDS,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  DISCOVERY_SITE_READ_PAGES,
  startDiscoverySite,
  type DiscoverySite,
} from '../helpers/discovery-site-fixture.js';
import { isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import {
  databaseFilePlaces,
  databaseTablesText,
  filesUnder,
  nonReadRequestsOf,
  placesWithMarkers,
  READ_METHODS,
  textLeakPlace,
  type LeakPlace,
} from '../helpers/leak-places.js';
import {
  PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE,
  PORTABLE_CREDENTIAL_STORE_IMPORTS_SOURCE,
  portableTestProtectorSourceOf,
} from '../helpers/auto-login-worker-entry.js';
import { descendantsOf, listProcesses } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import {
  createPortableTestCredentialProtector,
  createPortableTestKey,
  createTestCredentialStore,
  type TestCredentialStore,
} from '../helpers/test-credential-store.js';

const IS_WINDOWS = process.platform === 'win32';
const AUTOMATED_SKIP_REASON = 'the automated login runs only on Windows (the server start check rejects it elsewhere)';
const SUITE_TIMEOUT_MS = 900_000;
const JOB_TIMEOUT_MS = 240_000;
const WAIT_LIMIT_MS = 180_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 60_000;
const PROFILE_ID = 'example-discovery-fork';
const TARGET_CONFIG_PATH = 'local/targets/discovery-fork.json';
const OUTPUT_DIRECTORY_NAME = 'discovery-fork-output';
const ENTRY_FILE_NAME = 'discovery-worker-test-entry.mjs';
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
/**
 * サーバに届いた時刻の長さで許す不足（ms。`navigation-pacing.test.ts` の `SERVER_ARRIVAL_DELAY_TOLERANCE_MS` と同じ根拠の値）。DEF-100 fix から 0
 * （pacer は、前の読み込みの文書の要求の応答を受けた時刻からも間隔を数えるので、届く間隔は設定以上。前は 250）。
 */
const SERVER_ARRIVAL_DELAY_TOLERANCE_MS = 0;
const ENOUGH_PAGES = 30;
const SMALL_MAX_PAGES = 3;
/** T27e: 自動ログインの最小の間隔を越えるときの余り（ms）。 */
const AUTO_LOGIN_MIN_INTERVAL_MARGIN_MS = 1_000;

/**
 * テストだけの入口の本文（一時のビルドの root に書く）。CC-091（PRE42-CC の組 6a）: 共用の `testLoginWorkerEntrySource`（CLI の起動の設定の
 * headless のログイン用の Browser）に、移せる偽の暗号化の部品で資格情報の部品を開く口（`auto-login-worker-entry.ts`）を `additionalHooks` で足す。
 * 資格情報は、ファイルにも環境変数にも書かず、手動のログインでは標準入力から受ける（`worker-fork-support.ts` の準備。`[セレクタ, 値]` の組と、
 * 送るボタンのセレクタ）。自動ログインでは標準入力を読まず、ログインの画面の口を渡さない。自動ログインの資格情報は、偽の暗号化の部品で暗号化した
 * 資格情報のファイル（一時のフォルダ）から、本番の流れで読む。
 */
const entrySourceOf = (automated: boolean, protectorKey: string): string => testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  prelude: `${PORTABLE_CREDENTIAL_STORE_IMPORTS_SOURCE}\n${portableTestProtectorSourceOf(protectorKey)}${automated ? '' : STDIN_CREDENTIALS_PRELUDE}`,
  credentialsExpression: automated ? null : STDIN_CREDENTIALS_EXPRESSION,
  additionalHooks: PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE,
});

let build: TemporaryBuild;
const children: ChildProcess[] = [];

/** 1 つのテストの作業の場所と記録。 */
interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly credentials: TestCredentialStore;
  readonly key: string;
  readonly site: DiscoverySite;
  readonly received: unknown[];
  workerOutput: string;
  readonly workerPids: number[];
  manager: AuditJobManager | undefined;
  /** 手動のログインで、ワーカーの標準入力に渡す資格情報（`null` なら渡さない）。 */
  manualCredentials: string | null;
  /** T27e: ジョブの管理の時刻の進め（ms。自動ログインの最小の間隔を、待たずに越えるため。ジョブの管理の `now` に足す）。 */
  clockOffsetMs: number;
}

let workspace: Workspace | undefined;

const current = (): Workspace => {
  if (workspace === undefined) {
    throw new Error('no workspace');
  }
  return workspace;
};

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
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
  await workspace.site.close();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

/** 作業の場所を作る（fixture のサーバ、管理データ、資格情報のフォルダ）。 */
async function prepareWorkspace(siteOptions: Parameters<typeof startDiscoverySite>[0] = {}): Promise<Workspace> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-fork-'));
  const key = createPortableTestKey();
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    credentials: await createTestCredentialStore({ protector: createPortableTestCredentialProtector(key) }),
    key,
    site: await startDiscoverySite(siteOptions),
    received: [],
    workerOutput: '',
    workerPids: [],
    manager: undefined,
    manualCredentials: null,
    clockOffsetMs: 0,
  };
  return workspace;
}

/** ターゲット JSON を書く（`maxPages` を替えて書き直せる）。 */
async function writeTarget(maxPages: number): Promise<void> {
  const space = current();
  await mkdir(join(space.directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(space.directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('discovery-fork', space.site.origin, DISCOVERY_SITE_PATHS.admin, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, maxPages },
    audit: { screenshots: false },
    output: { directory: join(space.directory, OUTPUT_DIRECTORY_NAME) },
  })), 'utf8');
}

const setupFor = (site: DiscoverySite, automated: boolean): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${site.origin}${DISCOVERY_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.origin, path: DISCOVERY_SITE_PATHS.login }],
  successCondition: { pathPrefix: DISCOVERY_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  // T27e: READ の確かめの画面の読まないパス（`privateArea`）も入れる（READ の確かめの画面のない fixture では、届くリンクがない）。
  excludedPaths: [DISCOVERY_SITE_PATHS.logout, DISCOVERY_SITE_READ_CHECK_PATHS.privateArea],
  auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 2,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: DISCOVERY_SITE_LOGIN_FIELDS.user,
      passwordSelector: DISCOVERY_SITE_LOGIN_FIELDS.pass,
      submitSelector: DISCOVERY_SITE_LOGIN_FIELDS.submit,
      failureConditions: {
        invalidCredentials: { pathPrefix: DISCOVERY_SITE_PATHS.loginError, selector: '#invalid' },
        accountLocked: null,
        mfaRequired: null,
        credentialExpired: null,
      },
    }
    : null,
});

/** プロファイルと認証の設定を保存し、ジョブの管理を作る。 */
async function prepareProfile(automated: boolean, maxPages = ENOUGH_PAGES): Promise<AuditJobManager> {
  const space = current();
  await writeTarget(maxPages);
  const resolveContext = async (path: string): Promise<ProfileValidationContext | undefined> =>
    (path === TARGET_CONFIG_PATH ? { targetConfig: await loadConfig(join(space.directory, path)) } : undefined);
  const context = await resolveContext(TARGET_CONFIG_PATH);
  const contextResolver = (): ProfileValidationContext | undefined => context;
  expect(createProfile(space.database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: TARGET_CONFIG_PATH,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: automated ? 'AUTOMATED_LOGIN' : 'MANUAL_SESSION',
    approvedTestOrigins: [space.site.origin],
    environmentEvidenceRef: 'evidence/example-discovery-fork/isolation-check-1',
  }, { resolveContext: contextResolver }).ok).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。
  hideJobBrowser(space.database, PROFILE_ID);
  expect(saveAuthSetup(space.database, setupFor(space.site, automated), { resolveContext: contextResolver }).ok).toBe(true);
  const entry = join(build.rootDirectory, `${Date.now()}-${automated ? 'automated' : 'manual'}-${ENTRY_FILE_NAME}`);
  await writeFile(entry, entrySourceOf(automated, space.key), 'utf8');
  if (!automated) {
    const fields: [string, string][] = [];
    await space.site.fillCredentials(async (selector, value) => {
      fields.push([selector, value]);
    });
    space.manualCredentials = JSON.stringify({ fields, submit: DISCOVERY_SITE_LOGIN_FIELDS.submit });
  }
  const recordingFork: AuditWorkerForker = createRecordingFork({
    entry,
    stdinText: () => space.manualCredentials ?? '',
    onChild: (child) => {
      children.push(child);
      if (child.pid !== undefined) {
        space.workerPids.push(child.pid);
      }
    },
    onReceived: (message) => space.received.push(message),
    onOutput: (chunk) => { space.workerOutput += chunk; },
  });
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: space.directory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext,
    forkWorker: recordingFork,
    credentials: { root: space.credentials.root, store: space.credentials.store },
    now: () => new Date(Date.now() + space.clockOffsetMs),
  });
  return space.manager;
}

/** 発見のジョブを始めて、終わるまで待つ（`whileRunning` は、ジョブの間に 1 回だけ呼ぶ）。 */
async function runDiscovery(whileRunning?: (jobId: string) => Promise<void>): Promise<AuditJobView> {
  return runJob('DISCOVERY', whileRunning);
}

/** ジョブ（発見か READ の確かめ。T27e）を始めて、終わるまで待つ（`whileRunning` は、ジョブの間に 1 回だけ呼ぶ）。 */
async function runJob(kind: 'DISCOVERY' | 'READ_CHECK', whileRunning?: (jobId: string) => Promise<void>): Promise<AuditJobView> {
  const space = current();
  const manager = space.manager;
  if (manager === undefined) {
    throw new Error('no manager');
  }
  const request = { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION };
  const started = kind === 'DISCOVERY' ? await manager.startDiscovery(request) : await manager.startReadCheck(request);
  if (!started.ok) {
    throw new Error(`the ${kind} job did not start: ${started.reason} ${JSON.stringify(started)}`);
  }
  await whileRunning?.(started.job.jobId);
  // CC-072: 待ちはジョブの管理のテストの補助 `waitForJob`。
  return waitForJob(manager, started.job.jobId, isJobEnded, { limitMs: WAIT_LIMIT_MS, pollMs: WAIT_POLL_MS });
}

/** ジョブの `discovery.json`（スキーマに通ることも確かめる）。 */
async function documentOf(job: AuditJobView): Promise<DiscoveryDocument> {
  if (job.runDirectory === null) {
    throw new Error('the job has no Run directory');
  }
  const text = readFileSync(artifactFilePath(join(current().directory, OUTPUT_DIRECTORY_NAME, job.runDirectory), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8');
  const document = JSON.parse(text) as DiscoveryDocument;
  expect((await validateArtifact('discovery', document)).ok).toBe(true);
  return document;
}

const readPathsOf = (document: DiscoveryDocument): readonly string[] =>
  document.pages.flatMap((page) => (page.state === 'READ' ? [new URL(page.url).pathname] : []));

const driftsOf = (): ReadonlyMap<string, DiscoveryCandidateIndexView> =>
  new Map(readDiscoveryIndex(current().database, PROFILE_ID).candidates.map((candidate) => [candidate.pagePath + ' ' + candidate.identityDigest, candidate]));

const candidatesOn = (path: string): readonly DiscoveryCandidateIndexView[] =>
  readDiscoveryIndex(current().database, PROFILE_ID).candidates.filter((candidate) => candidate.pagePath === path);

/** サーバの要求の確かめ（`since` 番目から）: GET と HEAD のほかはログインの POST だけ、届いてはならないパスは 0、間隔は設定の値以上。 */
function expectReadOnlyRequests(since: number, readPages: number, loginPosts: number): void {
  const requests = current().site.requests.slice(since);
  expect(nonReadRequestsOf(requests))
    .toEqual(Array.from({ length: loginPosts }, () => `POST ${DISCOVERY_SITE_PATHS.login}`));
  expect(requests.filter(({ path }) => DISCOVERY_SITE_FORBIDDEN_PATHS.includes(path.split('?')[0] ?? path))).toEqual([]);
  // 発見の読み込み: ログインの POST の後の、管理画面の HTML の要求のうち、ログインの段の着地（最初の 1 つ）を除いたもの。
  const postIndex = requests.findIndex(({ method }) => method === 'POST');
  const documents = requests.slice(postIndex + 1).filter(({ adminDocument }) => adminDocument).slice(loginPosts > 0 ? 1 : 0);
  expect(documents).toHaveLength(readPages);
  // 別の process の pacer の記録は読めないので、サーバに届いた時刻の、最初から最後までの長さで確かめる（DEF-100 fix から、pacer は前の読み込みの
  // 応答を受けた時刻からも間隔を数えるので、許容は 0。読み込みの開始どうしの間隔そのものは `discovery-run.test.ts` が pacer の記録で確かめる）。
  const first = documents[0];
  const last = documents.at(-1);
  if (first !== undefined && last !== undefined && documents.length > 1) {
    expect(last.at - first.at).toBeGreaterThanOrEqual((documents.length - 1) * NAVIGATION_INTERVAL_MS - SERVER_ARRIVAL_DELAY_TOLERANCE_MS);
  }
}

/** 目印を探す管理データの表（ジョブ、発見の候補とジョブ、自動ログインの試し、READ の確かめの定義と結果）。 */
const DISCOVERY_LEAK_TABLES: readonly string[] = Object.freeze([
  'jobs', 'discovery_candidates', 'discovery_jobs', 'auto_login_attempts', 'read_checks', 'read_check_results',
]);

/** 目印が出た場所（成果物（ZIP は展開した中身も）、管理データのファイルと WAL と表、IPC、ワーカーの出力、ジョブの値）。 */
function leakedPlaces(): readonly string[] {
  const space = current();
  const databasePath = resolveControlDatabasePath(space.directory);
  const places: readonly LeakPlace[] = [
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, DISCOVERY_LEAK_TABLES)),
    textLeakPlace('ipc received', JSON.stringify(space.received)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('job views', JSON.stringify(space.manager?.listAuditJobs() ?? [])),
    textLeakPlace('index', JSON.stringify(readDiscoveryIndex(space.database, PROFILE_ID))),
    ...filesUnder(join(space.directory, OUTPUT_DIRECTORY_NAME)),
  ];
  const markers = space.site.secretValues();
  expect(markers.length).toBeGreaterThan(5);
  return placesWithMarkers(places, markers);
}

/** ワーカーがすべて終わり、その子孫（Chromium）が残っていないこと。 */
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

const workerMessages = (): readonly WorkerToParentMessage[] => current().received.flatMap((message) => {
  const checked = validateWorkerToParentMessage(message);
  return checked.ok ? [checked.message] : [];
});

describe('T27d: the discovery job end to end with the manual login', () => {
  beforeEach(async () => {
    await prepareWorkspace();
  });

  it('discovers to the end, records NEW, then UNCHANGED, CHANGED and MISSING, NOT_REVISITED and the duplicate conflict', async () => {
    const space = current();
    await prepareProfile(false);

    // 1 回目: すべての画面を読み、すべての候補が NEW。
    const first = await runDiscovery();
    expect(first).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', resultRunStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', failureReason: null });
    const firstDocument = await documentOf(first);
    expect([...readPathsOf(firstDocument)].sort()).toEqual([...DISCOVERY_SITE_READ_PAGES].sort());
    expect(space.site.successfulLogins).toBe(1);
    expectReadOnlyRequests(0, DISCOVERY_SITE_READ_PAGES.length, 1);
    const firstIndex = readDiscoveryIndex(space.database, PROFILE_ID);
    expect(firstIndex.latestJobId).toBe(first.jobId);
    expect(firstIndex.candidates.every(({ drift }) => drift === 'NEW')).toBe(true);
    expect(candidatesOn(DISCOVERY_SITE_PATHS.search).map(({ classification }) => classification)).toEqual(['READ']);
    expect(candidatesOn(DISCOVERY_SITE_PATHS.create).map(({ classification }) => classification)).toEqual(['CREATE']);
    expect(candidatesOn(DISCOVERY_SITE_PATHS.update).map(({ classification }) => classification)).toEqual(['UPDATE']);
    expect(candidatesOn(DISCOVERY_SITE_PATHS.remove).map(({ classification }) => classification)).toEqual(['NOT_EXECUTABLE']);
    expect(candidatesOn(DISCOVERY_SITE_PATHS.js).map(({ classification }) => classification)).toEqual(['NEEDS_BINDING', 'NEEDS_BINDING']);
    // 同じ識別の digest で中身の違う 2 つの form は、1 件にまとめて DISPLAY_ONLY・DUPLICATE_IDENTITY_CONFLICT（READ の対象にしない）。
    expect(candidatesOn(DISCOVERY_SITE_PATHS.duplicate).map(({ classification, reasonCode }) => [classification, reasonCode]))
      .toEqual([['DISPLAY_ONLY', 'DUPLICATE_IDENTITY_CONFLICT']]);
    // IPC: 候補を載せず、件数の要約だけ。
    const finished = workerMessages().filter((message) => message.type === 'FINISHED');
    expect(finished.map((message) => (message.type === 'FINISHED' ? message.discovery : null)))
      .toEqual([{ pagesRead: DISCOVERY_SITE_READ_PAGES.length, pagesNotRead: 4, candidates: expect.any(Number) as number }]);

    // 2 回目: 何も変わらない（UNCHANGED）。
    const beforeSecond = space.site.requests.length;
    const second = await runDiscovery();
    expect(second).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
    expectReadOnlyRequests(beforeSecond, DISCOVERY_SITE_READ_PAGES.length, 1);
    expect(readDiscoveryIndex(space.database, PROFILE_ID).candidates.every(({ drift }) => drift === 'UNCHANGED')).toBe(true);

    // 3 回目: 画面を変える（1 つ目の form の欄を必須にし、2 つ目の form を消す）→ CHANGED と MISSING。
    space.site.setVariant('changed');
    const third = await runDiscovery();
    expect(third).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
    expect(candidatesOn(DISCOVERY_SITE_PATHS.variant).map(({ classification, drift }) => [classification, drift]).sort())
      .toEqual([['CREATE', 'MISSING'], ['READ', 'CHANGED']]);
    expect(readDiscoveryIndex(space.database, PROFILE_ID).candidates
      .filter(({ pagePath }) => pagePath !== DISCOVERY_SITE_PATHS.variant)
      .every(({ drift }) => drift === 'UNCHANGED')).toBe(true);

    // 4 回目: 巡回の上限を小さくする → 読まなかった画面の候補は NOT_REVISITED（MISSING にしない）。
    await writeTarget(SMALL_MAX_PAGES);
    const beforeFourth = space.site.requests.length;
    const fourth = await runDiscovery();
    expect(fourth).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL' });
    const fourthDocument = await documentOf(fourth);
    expect(fourthDocument.endReason).toBe('MAX_PAGES_REACHED');
    expect(readPathsOf(fourthDocument)).toHaveLength(SMALL_MAX_PAGES);
    expectReadOnlyRequests(beforeFourth, SMALL_MAX_PAGES, 1);
    const readNow = new Set(readPathsOf(fourthDocument));
    const fourthIndex = readDiscoveryIndex(space.database, PROFILE_ID);
    expect(fourthIndex.latestReadPagePaths).toEqual([...readNow].sort());
    for (const candidate of fourthIndex.candidates) {
      if (!readNow.has(candidate.pagePath) && candidate.lastSeenJobId !== fourth.jobId) {
        expect(candidate.drift, candidate.pagePath).toBe('NOT_REVISITED');
      }
    }
    expect(fourthIndex.candidates.some(({ drift }) => drift === 'NOT_REVISITED')).toBe(true);
    expect(fourthIndex.candidates.filter(({ drift }) => drift === 'MISSING')).toEqual([]);

    // 秘密の目印が、どこにも出ない。process が残らない。
    expect(driftsOf().size).toBeGreaterThan(0);
    expect(leakedPlaces()).toEqual([]);
    await expectNoProcessLeft();
  }, JOB_TIMEOUT_MS * 4);

  it('interrupts the job when the worker exits during the crawl, and keeps the index', async () => {
    const space = current();
    await prepareProfile(false);
    const ended = await runDiscovery(async () => {
      const deadline = Date.now() + WAIT_LIMIT_MS;
      // ログインの段の着地と、発見の 1 画面目が届いたら、ワーカーを止める（kill）。
      while (space.site.requests.filter(({ adminDocument }) => adminDocument).length < 2) {
        if (Date.now() > deadline) {
          throw new Error('the discovery did not start reading');
        }
        await wait(WAIT_POLL_MS);
      }
      children.at(-1)?.kill();
    });
    expect(ended).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(readDiscoveryIndex(space.database, PROFILE_ID)).toEqual({ latestJobId: null, latestSeenAt: null, latestReadPagePaths: [], candidates: [] });
    expect(space.site.requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ path }) => path)).toEqual([DISCOVERY_SITE_PATHS.login]);
    await expectNoProcessLeft();
  }, JOB_TIMEOUT_MS);
});

describe('T27d: the discovery job end to end with a session that expires', () => {
  beforeEach(async () => {
    // 管理画面の HTML を 3 つまで読めるセッション（ログインの段の着地を含む）。
    await prepareWorkspace({ expireAfterAdminPages: 3 });
  });

  it('stops at a lost session (SESSION_LOST), records the pages read so far, and does not resume', async () => {
    const space = current();
    await prepareProfile(false);
    const ended = await runDiscovery();
    expect(ended).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', lastAuthState: 'SESSION_LOST' });
    expect(ended.sessionLostUrl).not.toBeNull();
    const document = await documentOf(ended);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    // ログインの段の着地（1 つ目）を含めて 3 つまで読めるので、発見は 2 画面。
    expect(readPathsOf(document)).toHaveLength(2);
    expect(readDiscoveryIndex(space.database, PROFILE_ID).latestJobId).toBe(ended.jobId);
    expect(space.site.requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ path }) => path)).toEqual([DISCOVERY_SITE_PATHS.login]);
    expect(space.site.requests.filter(({ path }) => DISCOVERY_SITE_FORBIDDEN_PATHS.includes(path.split('?')[0] ?? path))).toEqual([]);
    expect(leakedPlaces()).toEqual([]);
    await expectNoProcessLeft();
  }, JOB_TIMEOUT_MS);
});

describe.skipIf(!IS_WINDOWS)(`T27d: the discovery job end to end with the automated login${IS_WINDOWS ? '' : ` [skipped: ${AUTOMATED_SKIP_REASON}]`}`, () => {
  beforeEach(async () => {
    await prepareWorkspace();
  });

  it('logs in automatically, discovers to the end with reads only, and records NEW', async () => {
    const space = current();
    await prepareProfile(true);
    const values = new Map<string, string>();
    await space.site.fillCredentials(async (selector, value) => {
      values.set(selector, value);
    });
    await space.credentials.store.register({
      profileId: PROFILE_ID,
      loginOrigin: space.site.origin,
      username: values.get(DISCOVERY_SITE_LOGIN_FIELDS.user) ?? '',
      password: values.get(DISCOVERY_SITE_LOGIN_FIELDS.pass) ?? '',
    });
    const ended = await runDiscovery();
    expect(ended).toMatchObject({
      jobKind: 'DISCOVERY',
      state: 'FINISHED',
      resultRunStatus: 'COMPLETE',
      lastAuthState: 'AUTHENTICATED',
      autoLoginAttempt: { result: 'SUCCEEDED', submitted: 'YES' },
    });
    const document = await documentOf(ended);
    expect([...readPathsOf(document)].sort()).toEqual([...DISCOVERY_SITE_READ_PAGES].sort());
    expectReadOnlyRequests(0, DISCOVERY_SITE_READ_PAGES.length, 1);
    const index = readDiscoveryIndex(space.database, PROFILE_ID);
    expect(index.latestJobId).toBe(ended.jobId);
    expect(index.candidates.length).toBeGreaterThan(0);
    expect(index.candidates.every(({ drift }) => drift === 'NEW')).toBe(true);
    expect(leakedPlaces()).toEqual([]);
    await expectNoProcessLeft();
  }, JOB_TIMEOUT_MS);
});

/**
 * T27e: 発見の成果物の候補から、READ の確かめの定義を作って保存する（候補に照らす検証と保存の部品を直接呼ぶ。画面の保存の口は T27f）。
 */
function createDefinitions(document: DiscoveryDocument): readonly string[] {
  const R = DISCOVERY_SITE_READ_CHECK_PATHS;
  const formOn = (path: string) => {
    const form = discoveryCandidatesOf(document).find((candidate) => candidate.page.path === path && candidate.kind === 'FORM');
    if (form === undefined) {
      throw new Error(`no form on ${path}`);
    }
    return form;
  };
  const definitions: readonly (readonly [string, string, Omit<ReadCheckDefinition, 'targetIdentityDigest'>])[] = [
    ['read-orders', R.orders, { parameters: { q: 'りんご', status: 'open' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] }],
    ['read-orders-text', R.orders, { parameters: { q: 'みかん' }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'りんご' }] }],
    ['read-lookup', R.lookup, { parameters: { id: 'A-3' }, expectations: [{ kind: 'DETAIL_FIELD_EQUALS', field: '状態', value: 'closed' }] }],
    ['read-private', R.exitSearch, { parameters: { reason: 'x' }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }],
  ];
  for (const [readCheckId, path, rest] of definitions) {
    const candidate = formOn(path);
    const checked = validateReadCheckDefinition({ targetIdentityDigest: candidate.identityDigest, ...rest }, candidate);
    if (!checked.ok) {
      throw new Error(`the definition ${readCheckId} was rejected: ${JSON.stringify(checked.errors)}`);
    }
    expect(createReadCheck(current().database, { readCheckId, profileId: PROFILE_ID, definition: checked.definition, at: '20261011000000' }).ok).toBe(true);
  }
  // 秘密に見える名前の欄に値を送る定義は、保存の前の検証で拒まれる（保存しない）。
  const secret = formOn(R.secretSearch);
  expect(validateReadCheckDefinition({ targetIdentityDigest: secret.identityDigest, parameters: { api_key: 'x', q: 'y' }, expectations: [{ kind: 'TEXT_CONTAINS', text: 'y' }] }, secret))
    .toMatchObject({ ok: false, errors: [{ code: 'READ_PARAMETER_SECRET_LIKE' }] });
  return definitions.map(([readCheckId]) => readCheckId);
}

/** T27e: ジョブの `read-evidence.json`（スキーマに通ることも確かめる）。 */
async function evidenceOf(job: AuditJobView): Promise<ReadEvidenceDocument> {
  if (job.runDirectory === null) {
    throw new Error('the job has no Run directory');
  }
  const text = readFileSync(artifactFilePath(join(current().directory, OUTPUT_DIRECTORY_NAME, job.runDirectory), READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8');
  const document = JSON.parse(text) as ReadEvidenceDocument;
  expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
  return document;
}

/** T27e: 発見 → 定義の作成 → READ の確かめ → 結果の記録（手動と自動のログインで共通）。 */
async function discoverThenReadCheck(loginPosts: number): Promise<void> {
  const space = current();
  const discovery = await runDiscovery();
  expect(discovery).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
  const ids = createDefinitions(await documentOf(discovery));
  // 自動ログインの最小の間隔（5 分）を、待たずに越える（ジョブの管理の時刻だけを進める。サイトへの要求の間隔は変えない）。
  space.clockOffsetMs += AUTO_LOGIN_MIN_INTERVAL_MS + AUTO_LOGIN_MIN_INTERVAL_MARGIN_MS;
  const before = space.site.requests.length;
  const readCheck = await runJob('READ_CHECK');
  expect(readCheck).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', resultRunStatus: 'COMPLETE', lastAuthState: 'AUTHENTICATED', failureReason: null });
  const evidence = await evidenceOf(readCheck);
  // 定義の順は、管理データの一覧の順（作った時刻、定義の ID）。
  expect(evidence.checks.map((check) => [check.readCheckId, check.state === 'EXECUTED' ? check.result : check.reason])).toEqual([
    ['read-lookup', 'MATCHED'],
    ['read-orders', 'MATCHED'],
    ['read-orders-text', 'NOT_MATCHED'],
    ['read-private', 'READ_BLOCKED_BY_POLICY'],
  ]);
  // 結果の記録。
  expect(readRecentReadCheckResults(space.database, PROFILE_ID).map(({ jobId, readCheckId, result }) => [jobId, readCheckId, result]).sort())
    .toEqual([
      [readCheck.jobId, 'read-lookup', 'MATCHED'],
      [readCheck.jobId, 'read-orders', 'MATCHED'],
      [readCheck.jobId, 'read-orders-text', 'NOT_MATCHED'],
      [readCheck.jobId, 'read-private', 'READ_BLOCKED_BY_POLICY'],
    ]);
  expect(ids).toHaveLength(4);
  // サイトへの要求: ログインの POST のほかは GET（と HEAD）だけ。読まないパスへは届かない。READ の URL の query は、定義の欄の名前だけ。
  const requests = space.site.requests.slice(before);
  expect(nonReadRequestsOf(requests))
    .toEqual(Array.from({ length: loginPosts }, () => `POST ${DISCOVERY_SITE_PATHS.login}`));
  expect(requests.filter(({ path }) => path.startsWith(DISCOVERY_SITE_READ_CHECK_PATHS.privateArea) || DISCOVERY_SITE_FORBIDDEN_PATHS.includes(path.split('?')[0] ?? path)))
    .toEqual([]);
  const readUrls = requests.filter(({ path }) => path.includes('?') && !path.startsWith(DISCOVERY_SITE_PATHS.login)).map(({ path }) => new URL(path, space.site.origin));
  expect(readUrls.map((url) => [url.pathname, [...url.searchParams.keys()]])).toEqual([
    [DISCOVERY_SITE_READ_CHECK_PATHS.order, ['id']],
    [DISCOVERY_SITE_READ_CHECK_PATHS.orders, ['q', 'status']],
    [DISCOVERY_SITE_READ_CHECK_PATHS.orders, ['q']],
  ]);
  // IPC: 結果を載せず、件数の要約だけ。
  expect(workerMessages().flatMap((message) => (message.type === 'FINISHED' && message.readCheck !== undefined ? [message.readCheck] : [])))
    .toEqual([{ checks: 4, executed: 4 }]);
  expect(leakedPlaces()).toEqual([]);
  await expectNoProcessLeft();
}

describe('T27e: discovery, then the READ check job end to end with the manual login', () => {
  beforeEach(async () => {
    await prepareWorkspace({ readCheckPages: true });
  });

  it('discovers, saves definitions from the candidates, runs READ_CHECK with reads only and records the results', async () => {
    await prepareProfile(false);
    await discoverThenReadCheck(1);
  }, JOB_TIMEOUT_MS * 2);
});

describe.skipIf(!IS_WINDOWS)(`T27e: discovery, then the READ check job end to end with the automated login${IS_WINDOWS ? '' : ` [skipped: ${AUTOMATED_SKIP_REASON}]`}`, () => {
  beforeEach(async () => {
    await prepareWorkspace({ readCheckPages: true });
  });

  it('logs in automatically for each job, runs READ_CHECK with reads only and records the results', async () => {
    const space = current();
    await prepareProfile(true);
    const values = new Map<string, string>();
    await space.site.fillCredentials(async (selector, value) => {
      values.set(selector, value);
    });
    await space.credentials.store.register({
      profileId: PROFILE_ID,
      loginOrigin: space.site.origin,
      username: values.get(DISCOVERY_SITE_LOGIN_FIELDS.user) ?? '',
      password: values.get(DISCOVERY_SITE_LOGIN_FIELDS.pass) ?? '',
    });
    await discoverThenReadCheck(1);
    expect(space.manager?.listAuditJobs().map(({ jobKind, autoLoginAttempt }) => [jobKind, autoLoginAttempt?.result ?? null]).sort())
      .toEqual([['DISCOVERY', 'SUCCEEDED'], ['READ_CHECK', 'SUCCEEDED']]);
  }, JOB_TIMEOUT_MS * 2);
});
