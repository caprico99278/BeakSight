/**
 * ML-b（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2〜2.4）: 手動のログインの間の画面を、ビルドした画面のサーバ
 * （一時の root）と headless の Chromium で確かめる。ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは接続しない）。
 * - ジョブが `AWAITING_LOGIN` のときだけ、「ログインを終えた」のボタンと説明を出す。押すと、ジョブの管理の口（`confirmManualLogin`）を呼ぶ Server Function
 *   （POST）を送り、拒まれたら理由を出す（この場面のジョブは、ジョブの管理が動かしていないので、受け付けない）。CSRF と入力の形の確かめは今の作り。
 * - 手動のログインの成功から自動で登録した設定（認証の設定の版 3 のスクリプトの送信先、ログインに伴う送信、成功の鍵の形と、プロファイルの承認したサービスの
 *   Origin）を、ジョブの画面とプロファイルの画面に出し、認証の設定の画面への入口と、保存でプロファイルの改訂が進むことの知らせを置く。
 * 値は匿名（`example.invalid` とループバック）。
 */
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3 } from '../../../src/control/auth/auth-setup-contracts.js';
import { createStartingJob, recordAuthState, recordEnded } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { LOCAL_UI_MANUAL_LOGIN_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
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
import { callServerFunction, encodeServerFunctionPayload, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
const PROFILE_ID = 'mlb-manual';
const AWAITING_JOB_ID = 'job-mlb-awaiting';
const AUTHENTICATED_JOB_ID = 'job-mlb-authenticated';
const JOB_CREATED_AT = '20261019010000';
const JOB_ENDED_AT = '20261019011000';
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const TENANT_PATH = '/rest/v1/rpc/resolve_tenant';
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403 });
const SCREENSHOT_DIRECTORY = process.env['MLB_SCREENSHOT_DIR'];

const text = LOCAL_UI_MANUAL_LOGIN_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

/** 自動で登録したとする、スクリプトで送るログインの認証の設定（版 3）。 */
const scriptSetupOf = (profileId: string, profileRevision: number) => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId,
  profileRevision,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TENANT_PATH, method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-auth-token' },
});

/** テストだけの操作: ジョブの行を書き、最後の認証の状態にする（ワーカーの代わり）。`ended` なら終わった行にする（同時に動くジョブは 1 つだけ）。 */
const writeJob = (jobId: string, state: 'AWAITING_LOGIN' | 'AUTHENTICATED', ended: boolean): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 2, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
      .toEqual({ ok: true });
    expect(recordAuthState(database, jobId, state, null, null)).toBe(true);
    if (ended) {
      expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
    }
  } finally {
    closeControlDatabase(database);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  const profile = {
    schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: 1, targetConfigPath: `config/targets/${PROFILE_ID}.json`, environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
  };
  expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
  // 自動で登録したとする設定: プロファイルの承認したサービスの Origin（改訂が進む）と、認証の設定の版 3。
  expect(await valueOf('updateProfileFn', 'POST', { profile: { ...profile, revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] }, expectedRevision: 1 }))
    .toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: scriptSetupOf(PROFILE_ID, 2) })).toMatchObject({ ok: true });
  writeJob(AUTHENTICATED_JOB_ID, 'AUTHENTICATED', true);
  writeJob(AWAITING_JOB_ID, 'AWAITING_LOGIN', false);
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('ML-b: the "login finished" button while the job awaits the manual login', () => {
  it('shows the button and the note only while the job awaits the login, and shows the reason when the job manager does not accept it', async () => {
    const page = await openPage(`/jobs/${AWAITING_JOB_ID}`);
    const panel = page.getByTestId('job-manual-login');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByTestId('job-manual-login-note').textContent()).toBe(text.note);
    const button = panel.getByTestId('job-manual-login-confirm');
    expect(await button.textContent()).toBe(text.confirm);
    await screenshot(page, 'mlb-01-awaiting-login');
    await button.click();
    // この場面のジョブは、ジョブの管理が動かしていない（テストだけの行）ので、受け付けない（ML-b-2: ジョブの管理の閉じた一覧の理由）。理由の説明を出す。
    const rejection = panel.getByTestId('job-manual-login-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('JOB_NOT_ACTIVE');
    expect(await rejection.textContent()).toContain(text.rejected);
    expect(await rejection.textContent()).toContain(text.rejectionReasons.JOB_NOT_ACTIVE);
  }, SCENARIO_TIMEOUT_MS);

  it('keeps the CSRF protection and the input check for the Server Function', async () => {
    const id = ids.get('confirmManualLoginFn') ?? '';
    expect(id).not.toBe('');
    const response = await rawRequest(started().port, `/_serverFn/${id}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', 'sec-fetch-site': 'cross-site', origin: started().origin },
      body: encodeServerFunctionPayload({ jobId: AWAITING_JOB_ID }),
    });
    expect(response.status).toBe(STATUS.FORBIDDEN);
    for (const data of [{ jobId: AWAITING_JOB_ID, extra: true }, { jobId: '' }, {}]) {
      expect((await call('confirmManualLoginFn', 'POST', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
  });

  it('does not show the button when the job does not await the login', async () => {
    const page = await openPage(`/jobs/${AUTHENTICATED_JOB_ID}`);
    await page.getByTestId('job-auth').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-manual-login').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});

describe('ML-b: the settings registered from the manual login', () => {
  it('shows the registered settings on the job and the profile screens, with the way to review them and the note of the profile revision', async () => {
    for (const [path, testId] of [[`/jobs/${AUTHENTICATED_JOB_ID}`, 'job-login-setup'], [`/profiles/${PROFILE_ID}`, 'profile-login-setup']] as const) {
      const page = await openPage(path);
      const panel = page.getByTestId(testId);
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await panel.locator('[data-item="token"]').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
      expect(await panel.locator('[data-item="token"]').textContent()).toContain('grant_type');
      expect(await panel.locator('[data-item="sideRequests"] li').evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))).toEqual([TENANT_PATH]);
      expect(await panel.locator('[data-item="serviceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
      expect(await panel.locator('[data-item="successKey"]').textContent()).toBe(text.successKeyValue('', '-auth-token'));
      expect(await panel.getByTestId(`${testId}-revision-note`).textContent()).toBe(text.revisionNote);
      expect(await panel.getByTestId(`${testId}-review`).getAttribute('href')).toBe(`/auth-setup/${PROFILE_ID}`);
      // 値（query の値・token）は出さない。
      expect(await panel.textContent()).not.toContain('password');
      // FM-1（手動の操作を減らす設計書 2.3）: プロファイルの画面は、手動のログインのプロファイルで設定があれば「次から自動でログインする」を出す。
      // ジョブの画面は、そのジョブが登録した（SAVED）ときだけ（このジョブは登録の結果を持たない）。
      expect(await panel.getByTestId(`${testId}-automated-login`).count()).toBe(testId === 'profile-login-setup' ? 1 : 0);
      await screenshot(page, `mlb-02-${testId}`);
    }
  }, SCENARIO_TIMEOUT_MS);
});
