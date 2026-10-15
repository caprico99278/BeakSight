/**
 * 秘密の目印の検査（端から端まで。Task 25 の設計書 4.6、6 章。T25f）。ビルドした画面を一時の root の起動の部品で起動し、画面から認証つきの監査
 * （`TEST_AUTH_PASSIVE`、`MANUAL_SESSION`）を最後まで行って、秘密の目印が、どこにも出ないことを、バイトで検索して確かめる。
 * - 目印: Cookie の値（回転で替えた値を含む）、localStorage の値、ログインの POST の本文の資格情報（利用者名とパスワード）、URL の query に入れた
 *   token の値（リンク、画像、移動の先の `code` と `state`）。どれも、fixture のサイトが起動のたびに作るランダムな仮の値（値を出力しない）。
 * - 検索する場所: Run のディレクトリのすべてのファイル（保存と、ZIP を展開した中身を含む）、管理データのファイルと WAL（と、すべての表のすべての行）、
 *   画面のサーバの標準出力と標準エラー、ワーカーの標準出力と標準エラー、IPC の記録（ワーカーが親へ送ったメッセージのすべて）、画面の HTML と
 *   Server Function の応答（ジョブの行を含む）。
 * - URL の query の token は、伏せ字の印（`token=[REDACTED]` など）に替わって、成果物に現れる。
 * - 場面: (1) 最後まで終わる監査、(2) セッションの切れで止まった監査と、その再開（もう一度ログインして最後まで）。
 * 監査のワーカーは、一時の root の入口をテストだけの入口に替えて動かす（`helpers/auth-worker.ts`。ログイン用の Browser も headless。人の操作の代わりに、
 * 受け渡しのサーバの資格情報を入れる。IPC と出力の記録を写す）。監査の Browser は、本番と同じ CLI の起動の設定の headless。管理データ、ターゲット設定、
 * 出力先は、一時の root の中だけ。fixture のサイトは 127.0.0.1 だけ。
 */
import { mkdirSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_DATA_DIRECTORY_NAME, resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../../src/core/artifact-layout.js';
import { REDACTED } from '../../../src/core/redaction.js';
import { LOCAL_UI_AUDIT_TEXT } from '../../../src/presentation/messages.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  AUTH_SITE_TOKEN_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../../../tests/helpers/authenticated-site-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  WORKER_RECORD_FILES,
  installTestAuthWorkerEntry,
  startCredentialRelay,
  writeAuthTargetConfig,
  type CredentialRelay,
  type RelayedCredentials,
} from './helpers/auth-worker.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { databaseRowsPlace, filesUnder, leakedPlaces, textPlace, type SearchedPlace } from './helpers/secret-markers.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** 監査の終わりを待つ上限（ミリ秒）。 */
const AUDIT_TIMEOUT_MS = 180_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 480_000;
/** process が消えるのを待つ上限（ミリ秒）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** テストだけの入口の、ログインを待つ時間（ミリ秒）。 */
const TEST_LOGIN_TIMEOUT_MS = 120_000;
/** 受け渡しのサーバに、ログインの画面の準備の知らせが来るのを待つ間隔（ミリ秒）。 */
const RELAY_POLL_MS = 100;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 80;
/** 監査するページの上限（管理画面、report、item、jump、second、frames のすべて。上限で止まると PARTIAL になるため）。 */
const MAX_PAGES = 6;
/** テストの値（匿名）。 */
const COMPLETE_PROFILE = 't25f-markers-complete';
const LOST_PROFILE = 't25f-markers-lost';
const FIRST_REVISION = 1;
/** ログインの段で許す POST の回数。 */
const MAX_LOGIN_ATTEMPTS = 1;
/** 記録のフォルダ（一時の root の中）。 */
const RECORD_DIRECTORY_NAME = 't25f-worker-records';
/** 伏せ字の印に替わって現れるはずの、URL の query の形。 */
const REDACTED_QUERY_FORMS = Object.freeze([`token=${REDACTED}&page=2`, `access_token=${REDACTED}`, `code=${REDACTED}&state=${REDACTED}`]);

const auditText = LOCAL_UI_AUDIT_TEXT;

let root: TemporaryUiRoot | undefined;
let completeSite: AuthenticatedSite | undefined;
let lostSite: AuthenticatedSite | undefined;
let relay: CredentialRelay | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const configs = new Map<string, string>();
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];
/** テストの process で集めた資格情報の値（目印。出力しない）。 */
const credentialMarkers = new Set<string>();

const rootOf = (): string => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root.root;
};

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

const siteOf = (value: AuthenticatedSite | undefined): AuthenticatedSite => {
  if (value === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return value;
};

const recordDirectory = (): string => `${rootOf()}/${RECORD_DIRECTORY_NAME}`;

/** ページを開く（記録は付けない）と、Tab だけのフォーカスの移動（CCX-16 の共通の補助）。 */
const { openPage, tabTo } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  recordPages: false,
});

const callFunction = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async (name: string, method: 'GET' | 'POST', data?: unknown): Promise<unknown> => {
  const result = await callFunction(name, method, data);
  expect(result.response.status, name).toBe(200);
  return result.value;
};

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する。 */
const recordDescendants = async (): Promise<void> => {
  descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
};

/** 認証つきの読み取りの監査のプロファイルの文書。 */
const authProfileDocument = (profileId: string, targetConfigPath: string, origin: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [origin],
  environmentEvidenceRef: 't25f-evidence',
});

/** 認証の設定の文書（ログアウトを読まないパスに、管理画面を読む範囲に）。 */
const authSetupDocument = (profileId: string, origin: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-auth-setup/2',
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${origin}${AUTH_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin, path: AUTH_SITE_PATHS.login }],
  successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [AUTH_SITE_PATHS.adminLogout],
  auditPathPrefixes: [AUTH_SITE_PATHS.admin],
  maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** プロファイルと認証の設定を作る。 */
const prepareProfile = async (profileId: string, site: AuthenticatedSite): Promise<void> => {
  const config = configs.get(profileId) ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: authProfileDocument(profileId, config, site.originA) })).toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetupDocument(profileId, site.originA) })).toMatchObject({ ok: true });
};

/** fixture の正しい資格情報（値はテストの process の中だけ。目印として覚える。出力しない）。 */
const credentialsOf = async (site: AuthenticatedSite): Promise<RelayedCredentials> => {
  const fields: (readonly [string, string])[] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
    credentialMarkers.add(value);
  });
  return { fields, submit: AUTH_SITE_LOGIN_FIELDS.submit };
};

/** 受け渡しのサーバに、ログインの画面の準備の知らせが `count` 回来るまで待つ。 */
const waitForLoginPage = async (count: number): Promise<void> => {
  await expect.poll(() => relay?.requested() ?? 0, { timeout: AUDIT_TIMEOUT_MS, interval: RELAY_POLL_MS }).toBeGreaterThanOrEqual(count);
};

/** 一覧の行の「監査を始める」から開始の画面を開き、`startNew` に合わせて選び、開始してジョブの画面に移る（キーボードだけ）。ジョブの ID を返す。 */
const startFromList = async (profileId: string, startNew: boolean): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const page = await openPage('/');
  const row = page.locator(`tr[data-profile-id="${profileId}"]`);
  await tabTo(page, row.getByRole('link', { name: auditText.profileList.startAudit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  await tabTo(page, page.getByRole('radio', { name: auditText.start.resume }));
  if (startNew) {
    await page.keyboard.press('ArrowDown');
  }
  expect(await page.getByRole('radio', { name: startNew ? auditText.start.startNew : auditText.start.resume }).isChecked()).toBe(true);
  await tabTo(page, page.getByRole('button', { name: auditText.start.submit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return { page, jobId: new URL(page.url()).pathname.split('/').at(-1) ?? '' };
};

const jobState = (page: Page, state: string): Locator => page.locator(`[data-testid="job-state"][data-state="${state}"]`);
const authState = (page: Page, state: string): Locator => page.locator(`[data-testid="job-auth-state"][data-auth-state="${state}"]`);

/** 資格情報を渡して監査を始め、終わりまで待つ。ジョブの画面と ID を返す。 */
const runAudit = async (
  profileId: string,
  site: AuthenticatedSite,
  startNew: boolean,
  expectedAuthState: string,
): Promise<{ readonly page: Page; readonly jobId: string }> => {
  const requestedBefore = relay?.requested() ?? 0;
  relay?.provide(await credentialsOf(site));
  const job = await startFromList(profileId, startNew);
  await waitForLoginPage(requestedBefore + 1);
  await recordDescendants();
  await jobState(job.page, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
  await authState(job.page, expectedAuthState).waitFor({ timeout: UI_TIMEOUT_MS });
  return job;
};

/**
 * 管理データのすべての表のすべての行（読み取りだけで開く。ジョブの行を含む）。検索の部品は `helpers/secret-markers.ts`（CCX-16。CC-066。
 * フォルダの下のすべてのファイルと ZIP の中、UTF-8 と UTF-16LE の両方で探す）。
 */
const databaseRows = (): SearchedPlace => {
  const { place, rowCounts } = databaseRowsPlace(resolveControlDatabasePath(rootOf()), 'database:rows');
  expect(rowCounts.size).toBeGreaterThan(0);
  return place;
};

/** 検索するすべての場所（Run のディレクトリ、管理データ、出力、IPC の記録、画面の HTML と Server Function の応答）。 */
const searchedPlaces = async (profileId: string, jobId: string): Promise<readonly SearchedPlace[]> => {
  const places: SearchedPlace[] = [
    ...filesUnder(`${rootOf()}/t25e-output-${profileId}`, 'run'),
    ...filesUnder(`${rootOf()}/${CONTROL_DATA_DIRECTORY_NAME}`, 'local-data'),
    databaseRows(),
    ...filesUnder(recordDirectory(), 'worker'),
    textPlace('server:output', started().output()),
  ];
  for (const path of ['/', '/jobs', `/jobs/${jobId}`, `/start/${profileId}`, `/auth-setup/${profileId}`, `/profiles/${profileId}`]) {
    const response = await rawRequest(started().port, path, { headers: { cookie } });
    expect(response.status, path).toBe(200);
    places.push(textPlace(`html:${path}`, response.body));
  }
  for (const [name, data] of [
    ['getAuditJobFn', { jobId }],
    ['listAuditJobsFn', undefined],
    ['auditStartSummaryFn', { profileId }],
    ['getAuthSetupFn', { profileId }],
    ['listProfilesFn', undefined],
  ] as const) {
    const result = await callFunction(name, 'GET', data);
    expect(result.response.status, name).toBe(200);
    places.push(textPlace(`function:${name}`, result.response.body));
  }
  console.info(`[CCX-16] t25f searched places: ${places.length}`);
  return places;
};

/** `site` の目印（Cookie の値（回転した値を含む）と localStorage、資格情報、URL の query の token）。種類ごとの数も返す。 */
const markersOf = (site: AuthenticatedSite): { readonly all: readonly string[]; readonly counts: Readonly<Record<string, number>> } => {
  const cookieAndStorage = site.secretValues();
  const credentials = [...credentialMarkers];
  const queryTokens = site.queryTokenValues();
  return {
    all: [...new Set([...cookieAndStorage, ...credentials, ...queryTokens])],
    counts: { cookieAndStorage: cookieAndStorage.length, credentials: credentials.length, queryTokens: queryTokens.length },
  };
};

const containsBytes = (bytes: Uint8Array, needle: string): boolean => Buffer.from(bytes).includes(Buffer.from(needle, 'utf8'));

/** サーバに届いた要求のうち、path と query に `value` を含むものの数（値は出力しない）。 */
const requestsWith = (site: AuthenticatedSite, value: string | undefined): number =>
  site.requests.filter(({ path }) => value !== undefined && path.includes(value)).length;

/** fixture のサイトに届いた、GET と HEAD 以外の要求（`<method> <path>`）。 */
const nonReadRequests = (site: AuthenticatedSite): readonly string[] =>
  site.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  completeSite = await startAuthenticatedSite({ loginForm: true, rotate: true, queryTokens: true });
  lostSite = await startAuthenticatedSite({
    loginForm: true,
    rotate: true,
    queryTokens: true,
    expireFirstSessionAtPath: AUTH_SITE_TOKEN_PATHS.item,
  });
  relay = await startCredentialRelay();
  mkdirSync(recordDirectory(), { recursive: true });
  installTestAuthWorkerEntry(root.root, relay.url, TEST_LOGIN_TIMEOUT_MS, recordDirectory());
  configs.set(COMPLETE_PROFILE, writeAuthTargetConfig(root.root, COMPLETE_PROFILE, completeSite.originA, AUTH_SITE_PATHS.admin, MAX_PAGES));
  configs.set(LOST_PROFILE, writeAuthTargetConfig(root.root, LOST_PROFILE, lostSite.originA, AUTH_SITE_PATHS.admin, MAX_PAGES));
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  await prepareProfile(COMPLETE_PROFILE, completeSite);
  await prepareProfile(LOST_PROFILE, lostSite);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await relay?.close();
  await completeSite?.close();
  await lostSite?.close();
  root?.remove();
});

describe('T25f: no secret marker anywhere after an authenticated audit from the screen', () => {
  it('completes the audit, and no marker is in the Run directory, the control data, the outputs, the IPC records or the screen', async () => {
    const site = siteOf(completeSite);
    const { page, jobId } = await runAudit(COMPLETE_PROFILE, site, true, 'AUTHENTICATED');
    expect(await page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    await page.close();
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequests(site)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    // 巡回は伏せ字の前の URL で行った（画像の目印と、移動の先の code の目印つきの要求が、サーバに届いた）。
    const [, , , pixel, code] = site.queryTokenValues();
    expect(requestsWith(site, pixel)).toBeGreaterThan(0);
    expect(requestsWith(site, code)).toBeGreaterThan(0);

    const markers = markersOf(site);
    // 回転で替えた値を含む Cookie と localStorage（3 つ以上）、資格情報（2 つ）、URL の query の token（すべて）。
    expect(markers.counts.cookieAndStorage).toBeGreaterThan(2);
    expect(markers.counts.credentials).toBeGreaterThanOrEqual(2);
    expect(markers.counts.queryTokens).toBeGreaterThan(0);
    const places = await searchedPlaces(COMPLETE_PROFILE, jobId);
    expect(places.some(({ place }) => place.endsWith(WORKER_RECORD_FILES.ipc))).toBe(true);
    expect(places.some(({ place }) => place.startsWith('local-data:') && place.endsWith('-wal'))).toBe(true);
    expect(places.some(({ place }) => place.startsWith('run:') && place.includes('.zip!'))).toBe(true);
    expect(leakedPlaces(places, markers.all)).toEqual([]);

    // URL の query の token は、伏せ字の印に替わって、成果物に現れる。
    const audit = places.find(({ place }) => place.startsWith('run:') && place.endsWith(RUN_ARTIFACT_FILE_NAMES.audit));
    for (const form of REDACTED_QUERY_FORMS) {
      expect(containsBytes(audit?.bytes ?? new Uint8Array(), form), form).toBe(true);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('stops with SESSION_LOST and resumes with a new login, and no marker is anywhere after either', async () => {
    const site = siteOf(lostSite);
    const stopped = await runAudit(LOST_PROFILE, site, true, 'SESSION_LOST');
    expect(await stopped.page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    expect(await stopped.page.getByTestId('job-session-lost-url').textContent()).toBe(`${site.originA}${AUTH_SITE_TOKEN_PATHS.item}`);
    await stopped.page.close();

    // 止まった Run: 保存が残り、目印はどこにもなく、保存のページには伏せ字の印が現れる。
    const stoppedPlaces = await searchedPlaces(LOST_PROFILE, stopped.jobId);
    const checkpointFiles = stoppedPlaces.filter(({ place }) => place.startsWith('run:') && place.includes('/checkpoint/'));
    expect(checkpointFiles.length).toBeGreaterThan(0);
    expect(checkpointFiles.some(({ bytes }) => containsBytes(bytes, `token=${REDACTED}`))).toBe(true);
    expect(leakedPlaces(stoppedPlaces, markersOf(site).all)).toEqual([]);

    // 再開（もう一度ログイン。2 回目のログインのセッションは切れない）→ 最後まで。
    const resumed = await runAudit(LOST_PROFILE, site, false, 'AUTHENTICATED');
    expect(await resumed.page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    await resumed.page.close();
    expect(site.successfulLogins).toBe(2);
    expect(nonReadRequests(site)).toEqual([`POST ${AUTH_SITE_PATHS.login}`, `POST ${AUTH_SITE_PATHS.login}`]);
    const runFiles = filesUnder(`${rootOf()}/t25e-output-${LOST_PROFILE}`, 'run');
    const runJson = runFiles.find(({ place }) => place.endsWith(`/${RUN_ARTIFACT_FILE_NAMES.run}`));
    const { executions } = JSON.parse(Buffer.from(runJson?.bytes ?? new Uint8Array()).toString('utf8')) as {
      readonly executions: readonly { readonly endReason: string | null }[];
    };
    // 同じ Run の 2 回の実行（セッションの切れで止まった実行と、再開して終えた実行）。
    expect(executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_AUTH_SESSION_LOST', 'COMPLETED']);

    const markers = markersOf(site);
    expect(markers.counts.credentials).toBeGreaterThanOrEqual(2);
    const resumedPlaces = await searchedPlaces(LOST_PROFILE, resumed.jobId);
    expect(leakedPlaces(resumedPlaces, markers.all)).toEqual([]);
    const audit = resumedPlaces.find(({ place }) => place.startsWith('run:') && place.endsWith(RUN_ARTIFACT_FILE_NAMES.audit));
    expect(containsBytes(audit?.bytes ?? new Uint8Array(), `token=${REDACTED}&page=2`)).toBe(true);
  }, SCENARIO_TIMEOUT_MS);
});
