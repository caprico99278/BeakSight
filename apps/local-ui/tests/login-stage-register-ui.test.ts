/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.1、4 章の 1）: ジョブの詳細のログインの段の表の「登録する」を、確認の
 * ダイアログの後に、その場で保存することを、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。画面は移らない。成功の鍵は、ジョブの
 * ログインの観察から入る（今まで、案に鍵が入らず `AUTH_SETUP_STORAGE_KEY_INVALID` で保存できなかった）。ジョブの行は、テストだけの操作で管理データに書く
 * （ワーカーは起動しない。サイトへは接続しない）。値は匿名（`example.invalid` とループバック）。
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE } from '../../../src/control/auth/auth-setup-contracts.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT, LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
const PROFILE_ID = 'fm1-register';
const JOB_ID = 'job-fm1-register';
const JOB_CREATED_AT = '20261019010000';
const JOB_ENDED_AT = '20261019011000';
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const AFTER_PATH = '/rest/v1/rpc/after_login';
const LOGOUT_PATH = '/auth/v1/logout';
const KEY_SHAPE = Object.freeze({ prefix: '', suffix: '-token' });
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });

const text = LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT;

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
  screenshotDirectory: process.env['FM1_SCREENSHOT_DIR'],
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

interface AuthSetupPage {
  readonly profile: { readonly revision: number; readonly approvedServiceOrigins?: readonly string[] };
  readonly stored: { readonly setup: Record<string, unknown>; readonly freshness: string } | null;
}
const authSetupPage = (): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId: PROFILE_ID });

/** フォームの送信の認証の設定（版 3）。 */
const formSetup = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: PROFILE_ID,
  profileRevision: 1,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'FORM_NAVIGATION',
  scriptLogin: null,
  loginSideRequests: [],
  successStorageKey: null,
};

/** ログインの段で止まったジョブのまとめ（token の送信、token の後の手続きの呼び出し、危険な語の path と、成功の鍵の観察）。 */
const SUMMARY: AuditJobLoginStageSummary = {
  scriptLogin: null,
  blockedRequests: {
    requests: [
      {
        origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
      },
      { origin: SERVICE_ORIGIN, path: AFTER_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
      { origin: SERVICE_ORIGIN, path: LOGOUT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
    ],
    unlisted: 0,
  },
  observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [KEY_SHAPE], omitted: 0 } },
};

const writeJob = (): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    expect(createStartingJob(database, { jobId: JOB_ID, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
      .toEqual({ ok: true });
    expect(recordAuthState(database, JOB_ID, 'LOGIN_TIMEOUT', null, SUMMARY)).toBe(true);
    expect(recordEnded(database, JOB_ID, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

const rowOf = (page: Page, index: number) => page.getByTestId('job-login-stage-blocked').locator('tbody tr').nth(index);

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
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: formSetup })).toMatchObject({ ok: true });
  writeJob();
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

describe('FM-1: the register button saves the row on the spot after the confirmation', () => {
  it('saves nothing when the dialog is cancelled', async () => {
    const page = await openPage(`/jobs/${JOB_ID}`);
    await rowOf(page, 0).getByTestId('job-login-stage-register').click();
    const dialog = page.getByRole('dialog', { name: text.dialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect((await authSetupPage()).profile.revision).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  it('saves the token target with the observed storage key on the spot, and the screen does not move', async () => {
    const page = await openPage(`/jobs/${JOB_ID}`);
    const url = page.url();
    await rowOf(page, 0).getByTestId('job-login-stage-register').click();
    const dialog = page.getByRole('dialog', { name: text.dialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // 足すもの（token の送信先と必須の query の名前）と、足す承認したサービスの Origin と、保存した後の改訂を出す。
    expect(await dialog.getByTestId('login-stage-register-added').getAttribute('data-kind')).toBe('TOKEN_TARGET');
    expect(await dialog.getByTestId('login-stage-register-added').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
    expect(await dialog.getByTestId('login-stage-register-added').textContent()).toContain('grant_type');
    expect(await dialog.textContent()).not.toContain('password');
    expect(await dialog.getByTestId('login-stage-register-origins').textContent()).toBe(SERVICE_ORIGIN);
    expect(await dialog.getByTestId('login-stage-register-revision').textContent()).toBe(LOCAL_UI_TEXT.profileForm.revisionText(2));
    await screenshot(page, 'fm1-01-register-dialog');
    await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
    const saved = rowOf(page, 0).getByTestId('job-login-stage-registered');
    await saved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await saved.textContent()).toBe(text.saved(LOCAL_UI_TEXT.profileForm.revisionText(2)));
    expect(page.url()).toBe(url);
    const after = await authSetupPage();
    expect(after.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] });
    expect(after.stored?.freshness).toBe('CURRENT');
    expect(after.stored?.setup).toMatchObject({
      profileRevision: 2,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      successStorageKey: { origin: TEST_ORIGIN, ...KEY_SHAPE },
    });
    await screenshot(page, 'fm1-02-registered');
  }, SCENARIO_TIMEOUT_MS);

  it('adds a side request the automatic registration would not add, and shows the reason for a row it cannot add', async () => {
    const page = await openPage(`/jobs/${JOB_ID}`);
    await rowOf(page, 1).getByTestId('job-login-stage-register').click();
    const dialog = page.getByRole('dialog', { name: text.dialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await dialog.getByTestId('login-stage-register-added').getAttribute('data-kind')).toBe('SIDE_REQUEST');
    expect(await dialog.getByTestId('login-stage-register-origins').count()).toBe(0);
    await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
    await rowOf(page, 1).getByTestId('job-login-stage-registered').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPage()).stored?.setup).toMatchObject({
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: AFTER_PATH, method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
    });
    // 危険な語の path の行: ダイアログを出さずに、理由を出す。何も保存しない。
    await rowOf(page, 2).getByTestId('job-login-stage-register').click();
    const rejection = rowOf(page, 2).getByTestId('job-login-stage-register-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('EXCLUDED_PATH');
    expect(await rejection.textContent()).toContain(text.reasons.EXCLUDED_PATH);
    expect(await page.getByRole('dialog', { name: text.dialogTitle }).isVisible()).toBe(false);
    expect((await authSetupPage()).profile.revision).toBe(3);
    // 下書きのリンク（認証の設定の画面で直す）も残る。
    expect(await rowOf(page, 0).getByTestId('job-login-stage-edit-draft').textContent()).toBe(text.editDraft);
  }, SCENARIO_TIMEOUT_MS);

  it('rejects the save when the profile changed after the dialog, and keeps the input checks', async () => {
    expect(await valueOf('registerLoginStageRowFn', 'POST', { jobId: JOB_ID, passed: false, index: 1, expectedProfileRevision: 1 }))
      .toEqual({ ok: false, reason: 'PROFILE_CHANGED', codes: [] });
    expect(await valueOf('loginStageRowProposalFn', 'GET', { jobId: JOB_ID, passed: true, index: 0 })).toEqual({ ok: false, reason: 'ROW_NOT_FOUND' });
    for (const data of [{ jobId: JOB_ID, passed: false, index: 8 }, { jobId: JOB_ID, passed: 'no', index: 0 }, { jobId: JOB_ID, index: 0 }]) {
      expect((await call('loginStageRowProposalFn', 'GET', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    expect((await authSetupPage()).profile.revision).toBe(3);
  });
});
