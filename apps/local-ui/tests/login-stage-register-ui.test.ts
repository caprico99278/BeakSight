/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.1、4 章の 1）: ジョブの詳細のログインの段の表の「登録する」を、確認の
 * ダイアログの後に、その場で保存することを、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。画面は移らない。成功の鍵は、ジョブの
 * ログインの観察から入る（今まで、案に鍵が入らず `AUTH_SETUP_STORAGE_KEY_INVALID` で保存できなかった）。ジョブの行は、テストだけの操作で管理データに書く
 * （ワーカーは起動しない。サイトへは接続しない）。値は匿名（`example.invalid` とループバック）。
 * MI-G（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7、6 章の 6）: 自動ログインの記録（試しのあるジョブ、ログインの確かめの
 * ジョブ）と、自動ログインのプロファイルの行からは、token の送信先と承認したサービスの Origin を足す登録を、案と保存の両方で拒み、何も保存しない。
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE } from '../../../src/control/auth/auth-setup-contracts.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary, type NewAuditJob } from '../../../src/control/job/job-store.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { createProfile } from '../../../src/control/store/profile-store.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { WORKER_AUDIT_JOB_KIND, WORKER_LOGIN_CHECK_JOB_KIND } from '../../../src/core/audit-job-values.js';
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
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';

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

/** ログインの段で止まって終わったジョブを書く（MI-G: 種類と、自動ログインの試しの記録を変えられる）。 */
const writeJobOf = (job: Pick<NewAuditJob, 'jobId' | 'jobKind' | 'profileId' | 'autoLoginAttempt'>, summary: AuditJobLoginStageSummary = SUMMARY): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    expect(createStartingJob(database, { ...job, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null)).toEqual({ ok: true });
    expect(recordAuthState(database, job.jobId, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
    expect(recordEnded(database, job.jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};
const writeJob = (): void => {
  writeJobOf({ jobId: JOB_ID, jobKind: WORKER_AUDIT_JOB_KIND, profileId: PROFILE_ID });
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
  expect(await saveAuthSetupRequestInStore(root, { setup: formSetup })).toMatchObject({ ok: true });
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

// MI-G（設計書 4.7）: 自動ログインの文脈の行からは、新しいログインの送信先を足さない。手動のログインのプロファイルの手動のジョブの行は、上の FM-1 のとおり通る。
describe('MI-G: rows from the automated login cannot add a login target or a service origin', () => {
  const MANUAL_PROFILE = 'mig-manual';
  const AUTO_PROFILE = 'mig-auto';
  const ATTEMPT_JOB = 'job-mig-attempt';
  const CHECK_JOB = 'job-mig-check';
  const AUTO_PROFILE_JOB = 'job-mig-auto-profile';
  const MANUAL_PROFILE_JOB = 'job-mig-manual-profile';
  const NEW_TOKEN_PATH = '/auth/v2/token';
  const OTHER_ORIGIN = 'https://other.example.invalid';
  const REASON = 'NEW_TARGET_FROM_AUTOMATED_LOGIN';
  /** 今の token の送信先と違う token の送信と、`sideOrigin` への token の後の手続きの呼び出し。 */
  const summaryOf = (sideOrigin: string): AuditJobLoginStageSummary => ({
    ...SUMMARY,
    blockedRequests: {
      requests: [
        {
          origin: SERVICE_ORIGIN, path: NEW_TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
          query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
        },
        { origin: sideOrigin, path: AFTER_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
      ],
      unlisted: 0,
    },
  });
  const profileOf = (profileId: string, auth: string, approvedServiceOrigins: readonly string[]) => ({
    schemaVersion: 'beaksight-profile/1', profileId, revision: 1, targetConfigPath: `config/targets/${profileId}.json`, environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins, environmentEvidenceRef: `${profileId}-evidence`,
  });
  /** スクリプトで送るログインの認証の設定（token の送信先の Origin は承認済み。自動ログインのプロファイルは自動ログインの欄を持つ）。 */
  const scriptSetupOf = (profileId: string, automatedLogin: unknown) => ({
    ...formSetup,
    profileId,
    loginPostEndpoints: [],
    automatedLogin,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    successStorageKey: { origin: TEST_ORIGIN, ...KEY_SHAPE },
  });
  const pageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });
  const expectRejected = async (jobId: string, index: number): Promise<void> => {
    expect(await valueOf('loginStageRowProposalFn', 'GET', { jobId, passed: false, index })).toEqual({ ok: false, reason: REASON });
    expect(await valueOf('registerLoginStageRowFn', 'POST', { jobId, passed: false, index, expectedProfileRevision: 1 }))
      .toEqual({ ok: false, reason: REASON, codes: [] });
  };

  beforeAll(async () => {
    writeAuthTargetConfig(rootOf().root, MANUAL_PROFILE, TEST_ORIGIN, '/admin', MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, AUTO_PROFILE, TEST_ORIGIN, '/admin', MAX_PAGES);
    // MI-C2 項目 16・MI-F1（設計書 4.7.1 の 1・2）: 画面の道（`createProfileFn`）では、承認したサービスの Origin つきのプロファイルと、自動ログインの
    // プロファイルを作れなくなった。ここでは、手動のログインの観察で Origin が入った手動のログインのプロファイルと、その後に切り替えた、今ある形の自動ログインの
    // プロファイル（設計書 4.4: そのまま動く）を、管理データの保存の部品で直接作る（テストだけの操作）。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      for (const profile of [profileOf(MANUAL_PROFILE, 'MANUAL_SESSION', [SERVICE_ORIGIN]), profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN', [SERVICE_ORIGIN])]) {
        const targetConfig = await loadConfig(`${rootOf().root}/${profile.targetConfigPath}`);
        expect(createProfile(database, profile, { resolveContext: () => ({ targetConfig }) }).ok).toBe(true);
      }
    } finally {
      closeControlDatabase(database);
    }
    expect(await saveAuthSetupRequestInStore(root, { setup: scriptSetupOf(MANUAL_PROFILE, null) })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(root, {
      setup: scriptSetupOf(AUTO_PROFILE, {
        usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      }),
    })).toMatchObject({ ok: true });
    // 手動のログインのプロファイルの、自動ログインの記録のジョブ（2 つ目の行の送り先は、まだ承認していない Origin）。
    writeJobOf({ jobId: ATTEMPT_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: MANUAL_PROFILE, autoLoginAttempt: { credentialRevision: 1 } }, summaryOf(OTHER_ORIGIN));
    writeJobOf({ jobId: CHECK_JOB, jobKind: WORKER_LOGIN_CHECK_JOB_KIND, profileId: MANUAL_PROFILE }, summaryOf(OTHER_ORIGIN));
    // 自動ログインのプロファイルの、手動のジョブ（2 つ目の行の送り先は、承認したサービスの Origin）。
    writeJobOf({ jobId: AUTO_PROFILE_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: AUTO_PROFILE }, summaryOf(SERVICE_ORIGIN));
    // MI-F1（設計書 4.7.1 の 1）: 手動のログインのプロファイルの、手動のログインのジョブ（2 つ目の行の送り先は、まだ承認していない Origin。下書きからの保存の
    // 観察の元）。
    writeJobOf({ jobId: MANUAL_PROFILE_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: MANUAL_PROFILE }, summaryOf(OTHER_ORIGIN));
  }, SCENARIO_TIMEOUT_MS);

  it('rejects the token target and the side request of a new origin from the jobs of the automated login, and saves nothing', async () => {
    const before = await pageOf(MANUAL_PROFILE);
    for (const jobId of [ATTEMPT_JOB, CHECK_JOB]) {
      // 今と違う token の送信先の行と、まだ承認していない Origin への送信の行（承認したサービスの Origin を足す）。
      await expectRejected(jobId, 0);
      await expectRejected(jobId, 1);
    }
    const after = await pageOf(MANUAL_PROFILE);
    expect(after.profile).toEqual(before.profile);
    expect(after.profile.revision).toBe(1);
    expect(after.stored?.setup).toEqual(before.stored?.setup);
  });

  it('rejects a new token target from the manual job of the automated login profile, and shows the reason on the screen', async () => {
    const before = await pageOf(AUTO_PROFILE);
    await expectRejected(AUTO_PROFILE_JOB, 0);
    const page = await openPage(`/jobs/${AUTO_PROFILE_JOB}`);
    await rowOf(page, 0).getByTestId('job-login-stage-register').click();
    const rejection = rowOf(page, 0).getByTestId('job-login-stage-register-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe(REASON);
    expect(await rejection.textContent()).toContain(text.reasons[REASON]);
    expect(await page.getByRole('dialog', { name: text.dialogTitle }).isVisible()).toBe(false);
    await screenshot(page, 'mig-01-automated-login-rejected');
    const after = await pageOf(AUTO_PROFILE);
    expect(after.profile).toEqual(before.profile);
    expect(after.stored?.setup).toEqual(before.stored?.setup);
  }, SCENARIO_TIMEOUT_MS);

  // MI-C 項目 12（安全。MI-G の守りを回り込む道）: 認証の設定の画面の「承認したサービスの Origin を足して保存する」（`saveAuthSetupWithServiceOriginsFn`）も、
  // 自動ログインのプロファイルでは、新しい Origin を足す保存を拒む（MI-G と同じ理由）。手動のログインのプロファイルでは、今どおり保存できる。
  // MI-F1（設計書 4.7.1 の 1）: 足す Origin は、画面の送る値でなく、下書きを作ったジョブの記録の行からサーバが組み立て直す（要求は行を持つ）。
  it('rejects the auth setup save that adds a new service origin to the automated login profile, and saves nothing', async () => {
    const before = await pageOf(AUTO_PROFILE);
    const setup = { ...before.stored?.setup, profileRevision: 2, loginSideRequests: [{ origin: OTHER_ORIGIN, path: AFTER_PATH, method: 'POST', maxPerLoginStage: 1 }] };
    expect(await valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', { setup, expectedRevision: 1, row: { jobId: AUTO_PROFILE_JOB, passed: false, index: 1 } }))
      .toEqual({ ok: false, reason: REASON, errors: [] });
    const after = await pageOf(AUTO_PROFILE);
    expect(after.profile).toEqual(before.profile);
    expect(after.profile.revision).toBe(1);
    expect(after.stored).toEqual(before.stored);
  });

  it('still saves the auth setup with a new service origin for the manual login profile, from the row of its manual login job', async () => {
    const before = await pageOf(MANUAL_PROFILE);
    const setup = { ...before.stored?.setup, profileRevision: 2, loginSideRequests: [{ origin: OTHER_ORIGIN, path: AFTER_PATH, method: 'POST', maxPerLoginStage: 1 }] };
    // 自動ログインの記録のジョブの行（同じ Origin を記録していても）からは足さない。
    expect(await valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', { setup, expectedRevision: 1, row: { jobId: ATTEMPT_JOB, passed: false, index: 1 } }))
      .toEqual({ ok: false, reason: REASON, errors: [] });
    expect(await valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', { setup, expectedRevision: 1, row: { jobId: MANUAL_PROFILE_JOB, passed: false, index: 1 } }))
      .toMatchObject({ ok: true, stored: { freshness: 'CURRENT' } });
    expect((await pageOf(MANUAL_PROFILE)).profile).toMatchObject({ revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_ORIGIN] });
  });

  // MI-C 項目 12: 自動ログインの文脈の行（自動ログインの試しのあるジョブ、ログインの確かめのジョブ、自動ログインのプロファイル）には、認証の設定の画面を
  // 下書きつきで開くリンク（「認証の設定の画面で直す」）を出さない（MI-G の拒否と同じ文脈の判定）。手動のログインのジョブの行には、今どおり出す。
  it('does not show the draft link on the rows in the automated login context, and still shows it for the manual login job', async () => {
    for (const jobId of [ATTEMPT_JOB, CHECK_JOB, AUTO_PROFILE_JOB]) {
      const page = await openPage(`/jobs/${jobId}`);
      await rowOf(page, 0).getByTestId('job-login-stage-register').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('job-login-stage-edit-draft').count(), jobId).toBe(0);
    }
    const manual = await openPage(`/jobs/${JOB_ID}`);
    await rowOf(manual, 0).getByTestId('job-login-stage-register').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await manual.getByTestId('job-login-stage-edit-draft').count()).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT_MS);

  // MI-F1（設計書 4.7.1 の 3）: 自動ログインのプロファイルでは、承認済みの Origin へのログインに伴う送信も、送信先が変わるので足さない（4.7 の「足せる」を
  // 4.7.1 の 3 で閉じた）。案と保存の両方で拒み、何も保存しない。
  it('rejects a side request to an approved service origin from the automated login profile, and saves nothing (MI-F1)', async () => {
    const before = await pageOf(AUTO_PROFILE);
    const LOCKED = 'CREDENTIAL_DESTINATION_LOCKED';
    expect(await valueOf('loginStageRowProposalFn', 'GET', { jobId: AUTO_PROFILE_JOB, passed: false, index: 1 })).toEqual({ ok: false, reason: LOCKED });
    expect(await valueOf('registerLoginStageRowFn', 'POST', { jobId: AUTO_PROFILE_JOB, passed: false, index: 1, expectedProfileRevision: 1 }))
      .toEqual({ ok: false, reason: LOCKED, codes: [] });
    const after = await pageOf(AUTO_PROFILE);
    expect(after.profile).toEqual(before.profile);
    expect(after.stored?.setup).toEqual(before.stored?.setup);
  });

  // MI-C2 項目 16（安全。設計書 4.7）・MI-F1（設計書 4.7.1 の 1・2）: プロファイルの保存（更新・作成）では、方式によらず承認したサービスの Origin を足さず、
  // 自動ログインへは切り替えだけで入る（作成と編集で自動ログインにしない）。
  const THIRD_ORIGIN = 'https://third.example.invalid';
  const NOT_OBSERVED = 'SERVICE_ORIGIN_ADD_NOT_OBSERVED';
  const SWITCH_REQUIRED = 'AUTOMATED_LOGIN_SWITCH_REQUIRED';
  /** 承認したサービスの Origin の項目のないプロファイル（空の一覧は送らない。画面の保存と同じ形）。 */
  const withoutServiceOrigins = (profile: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'approvedServiceOrigins'));

  it('rejects the profile update that adds a service origin to the automated login profile, or switches to it with a new origin', async () => {
    const auto = await pageOf(AUTO_PROFILE);
    const added = { ...profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN', [SERVICE_ORIGIN, OTHER_ORIGIN]), revision: auto.profile.revision + 1 };
    expect(await valueOf('updateProfileFn', 'POST', { profile: added, expectedRevision: auto.profile.revision }))
      .toMatchObject({ ok: false, reason: NOT_OBSERVED });
    expect((await pageOf(AUTO_PROFILE)).profile).toEqual(auto.profile);

    // 手動のログインのプロファイルを、編集で自動ログインに変える（Origin を足すとき、足さないとき）。
    const manual = await pageOf(MANUAL_PROFILE);
    const switchedOf = (origins: readonly string[]) => ({ ...profileOf(MANUAL_PROFILE, 'AUTOMATED_LOGIN', origins), revision: manual.profile.revision + 1 });
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: switchedOf([...(manual.profile.approvedServiceOrigins ?? []), THIRD_ORIGIN]), expectedRevision: manual.profile.revision,
    })).toMatchObject({ ok: false, reason: NOT_OBSERVED });
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: switchedOf(manual.profile.approvedServiceOrigins ?? []), expectedRevision: manual.profile.revision,
    })).toMatchObject({ ok: false, reason: SWITCH_REQUIRED });
    expect((await pageOf(MANUAL_PROFILE)).profile).toEqual(manual.profile);
  });

  it('rejects creating an automated login profile, with or without service origins, and adding a service origin to the manual login profile', async () => {
    const created = 'mic2-auto';
    writeAuthTargetConfig(rootOf().root, created, TEST_ORIGIN, '/admin', MAX_PAGES);
    expect(await valueOf('createProfileFn', 'POST', { profile: profileOf(created, 'AUTOMATED_LOGIN', [SERVICE_ORIGIN]) }))
      .toMatchObject({ ok: false, reason: NOT_OBSERVED });
    expect(await valueOf('createProfileFn', 'POST', { profile: withoutServiceOrigins(profileOf(created, 'AUTOMATED_LOGIN', [])) }))
      .toMatchObject({ ok: false, reason: SWITCH_REQUIRED });
    expect(await valueOf('getProfileFn', 'GET', { profileId: created })).toBeNull();
    // 手動のログインのプロファイルとしては、今どおり作れる。
    expect(await valueOf('createProfileFn', 'POST', { profile: withoutServiceOrigins(profileOf(created, 'MANUAL_SESSION', [])) }))
      .toMatchObject({ ok: true });

    // 手動のログインのプロファイルでも、編集では足さない（消すのは受ける）。
    const manual = await pageOf(MANUAL_PROFILE);
    const origins = manual.profile.approvedServiceOrigins ?? [];
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...profileOf(MANUAL_PROFILE, 'MANUAL_SESSION', [...origins, THIRD_ORIGIN]), revision: manual.profile.revision + 1 },
      expectedRevision: manual.profile.revision,
    })).toMatchObject({ ok: false, reason: NOT_OBSERVED });
    expect((await pageOf(MANUAL_PROFILE)).profile).toEqual(manual.profile);
  });
});
