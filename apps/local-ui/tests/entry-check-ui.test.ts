/**
 * T43c（Task 43 の設計書 4.3、5 章の 3）: 入口の確かめの画面の操作の確かめ。ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の
 * Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。監査のワーカーは本番の入口のまま（入口の確かめはログインの段を通さない）で、
 * 127.0.0.1 の fixture のサイト（`tests/helpers/entry-check-site.ts`。値の目印を入れたログインの画面）に対して、本物の入口の確かめを動かす。
 * - プロファイルの詳細の「入口を確かめる」（キーボード）→ ジョブの画面に、読んだ事実（終わり方、移った先、欄の候補と一意な CSS、form）と案を出す。
 *   成果物のリンク。公開のプロファイルには、認証の設定の画面へのリンクを出さない。
 * - 始められない理由: 対象の設定のファイルを読めないプロファイルは、押せない形で理由を出す。認証の設定のないテストのプロファイルは始められる
 *   （認証の設定は要らない）。
 * - 認証の設定の画面: 保存した設定がないときは、最後の成功した入口の確かめの案を欄に埋め、案であることを示す（開始の URL の path の案より優先。ログインの
 *   画面の path に当たる成功の画面の path の案は空にする）。自動ログインのプロファイルでは 3 つのセレクタも埋める。保存した設定があれば埋めない。
 * - 画面（ページの本文）に欄の値の目印が出ない。すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。fixture のサイトに届いた要求は
 *   GET と HEAD だけで、許可 Origin の外には届かない。
 */
import { rmSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_JOB_STATE_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
} from '../../../src/presentation/messages.js';
import { SPA_APP_PATHS, startSpaAuthSite, type SpaAuthSite } from '../../../tests/helpers/spa-auth-site-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  ENTRY_CHECK_SITE_PATHS,
  ENTRY_CHECK_VALUE_MARKERS,
  startEntryCheckSite,
  type EntryCheckSite,
} from '../../../tests/helpers/entry-check-site.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
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
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** ジョブの終わりを待つ上限（ms）。 */
const JOB_TIMEOUT_MS = 120_000;
/** 入口の確かめのジョブを読み直す間隔（ms）。 */
const ENTRY_CHECK_POLL_MS = 250;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 240_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 120;
const FIRST_REVISION = 1;
const PUBLIC_PROFILE = 't43c-public';
const MANUAL_PROFILE = 't43c-manual';
const AUTOMATED_PROFILE = 't43c-automated';
const SAVED_PROFILE = 't43c-saved';
const BROKEN_PROFILE = 't43c-broken';
/** T44e: 開始の URL が許可 Origin の外へ移ろうとするプロファイル（終わり方 `LEFT_ALLOWED_ORIGINS`）。 */
const LEFT_PROFILE = 't44e-left';
/** T44e（P2-8）: SPA（スクリプトで送るログイン）の入口の確かめのプロファイル。 */
const SPA_PROFILE = 't44e-spa';

const text = LOCAL_UI_ENTRY_CHECK_TEXT;

let root: TemporaryUiRoot | undefined;
let site: EntryCheckSite | undefined;
/** T44e（P2-8）: SPA の fixture（入口の確かめは 1 回読むだけ。ログインはしない）。 */
let spaSite: SpaAuthSite | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const siteOf = (): EntryCheckSite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

const { openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);  return result.value as T;
};

const jobState = (page: Page, value: keyof typeof AUDIT_JOB_STATE_CATALOG): Locator => page.locator(`[data-testid="job-state"][data-state="${value}"]`);

/** テストのプロファイルの文書。 */
const testProfileOf = (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN'): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(root?.root ?? '', profileId, siteOf().originA, ENTRY_CHECK_SITE_PATHS.prefilled, 1),
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth,
  approvedTestOrigins: [siteOf().originA],
  environmentEvidenceRef: 't43c-evidence',
});

/** 公開のプロファイルの文書（`startPath` は開始の URL の path。既定はログインの画面）。 */
const publicProfileOf = (profileId: string, startPath: string = ENTRY_CHECK_SITE_PATHS.prefilled): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeAuthTargetConfig(root?.root ?? '', profileId, siteOf().originA, startPath, 1),
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
});

/** 手動のログインの認証の設定（フォームの送信）。 */
const savedSetupOf = (profileId: string): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${siteOf().originA}/saved-login`,
  loginPostEndpoints: [{ origin: siteOf().originA, path: '/saved-session' }],
  successCondition: { pathPrefix: '/saved-home', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/saved-home'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 入口の確かめを Server Function で始め、終わるまで待つ（ジョブの ID を返す）。 */
const runEntryCheck = async (profileId: string): Promise<string> => {
  const job = await valueOf<{ ok: boolean; jobId: string }>('startEntryCheckFn', 'POST', { profileId, expectedRevision: FIRST_REVISION });
  expect(job.ok).toBe(true);
  // PRE42-CC 組 UI-K2（CC-112）: 読み直して待つのは補助（上限と間隔は前と同じ）。
  const detail = await waitForJobViaServerFunctions(
    (jobId) => valueOf<{ state: string; active: boolean }>('getAuditJobFn', 'GET', { jobId }),
    job.jobId,
    (current) => !current.active,
    { limitMs: JOB_TIMEOUT_MS, stepMs: ENTRY_CHECK_POLL_MS },
  );
  expect(detail.state).toBe('FINISHED');
  return job.jobId;
};

/** ページの本文に、欄の値の目印がない。 */
const expectNoMarkers = async (page: Page): Promise<void> => {
  const html = await page.content();
  for (const marker of Object.values(ENTRY_CHECK_VALUE_MARKERS)) {
    expect(html.includes(marker), marker).toBe(false);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startEntryCheckSite();
  spaSite = await startSpaAuthSite();
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const profile of [
    publicProfileOf(PUBLIC_PROFILE),
    publicProfileOf(BROKEN_PROFILE),
    publicProfileOf(LEFT_PROFILE, ENTRY_CHECK_SITE_PATHS.redirectOut),
    testProfileOf(MANUAL_PROFILE, 'MANUAL_SESSION'),
    testProfileOf(AUTOMATED_PROFILE, 'AUTOMATED_LOGIN'),
    testProfileOf(SAVED_PROFILE, 'MANUAL_SESSION'),
    {
      ...testProfileOf(SPA_PROFILE, 'MANUAL_SESSION'),
      targetConfigPath: writeAuthTargetConfig(root.root, SPA_PROFILE, spaSite.appOrigin, SPA_APP_PATHS.auth, 1),
      approvedTestOrigins: [spaSite.appOrigin],
    },
  ]) {
    expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
  }
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: savedSetupOf(SAVED_PROFILE) })).toMatchObject({ ok: true });
  // 対象の設定のファイルを読めないプロファイル（作った後にファイルを消す）。
  const broken = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: BROKEN_PROFILE });
  rmSync(`${root.root}/${broken.profile.targetConfigPath}`);
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  if (site !== undefined) {
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method)), 'non-read requests').toEqual([]);
    expect(site.requests.filter(({ site: origin }) => origin === 'B'), 'requests outside the allowed origins').toEqual([]);
    await site.close();
  }
  if (spaSite !== undefined) {
    // 入口の確かめは読み取りだけ（ログインの送信も、サービスへの要求もない）。
    expect(spaSite.requests.filter(({ method }) => !READ_METHODS.has(method)), 'non-read requests to the SPA').toEqual([]);
    await spaSite.close();
  }
  root?.remove();
}, SCENARIO_TIMEOUT_MS);

describe('T43c: the entry check on the screens', () => {
  it('starts the entry check from the profile detail by keyboard, and shows the facts and the proposal on the job screen', async () => {
    const page = await openPage(`/profiles/${PUBLIC_PROFILE}`);
    const panel = page.getByTestId('entry-check-panel');
    await panel.getByRole('heading', { name: text.panel.heading, exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByTestId('entry-check-no-latest').count()).toBe(1);
    const button = panel.getByTestId('entry-check-start');
    expect(await button.isEnabled()).toBe(true);
    await tabTo(page, button);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    await jobState(page, 'FINISHED').waitFor({ timeout: JOB_TIMEOUT_MS });
    const result = page.getByTestId('job-entry-check');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('READ');
    expect(await page.getByTestId('job-entry-check-login-page').getAttribute('data-login-page')).toBe('true');
    const fields = page.getByTestId('job-entry-check-fields');
    expect(await fields.locator('tr[data-field="username"] code').textContent()).toBe('#login-id');
    expect(await fields.locator('tr[data-field="password"] code').textContent()).toBe('#login-password');
    expect(await fields.locator('tr[data-field="submit"] code').textContent()).toBe('#login-submit');
    expect(await page.getByTestId('job-entry-check-proposal').locator('[data-transport]').getAttribute('data-transport')).toBe('FORM_NAVIGATION');
    expect(await page.getByTestId('job-entry-check-proposal').textContent()).toContain(`${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.session}`);
    // 公開のプロファイルは認証の設定を使わないので、認証の設定の画面へのリンクを出さない。
    expect(await page.getByTestId('job-entry-check-open-auth-setup').count()).toBe(0);
    expect(await page.locator('[data-artifact="ENTRY_CHECK_JSON"]').count()).toBe(1);
    await expectNoMarkers(page);

    // プロファイルの詳細に、最後の成功した入口の確かめが出る。
    const detail = await openPage(`/profiles/${PUBLIC_PROFILE}`);
    await detail.getByTestId('entry-check-latest').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await detail.getByTestId('entry-check-latest-proposal').getAttribute('data-proposal')).toBe('true');
  }, SCENARIO_TIMEOUT_MS);

  it('shows the reason why the entry check cannot start, with the button disabled', async () => {
    const page = await openPage(`/profiles/${BROKEN_PROFILE}`);
    const panel = page.getByTestId('entry-check-panel');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByTestId('entry-check-start').isDisabled()).toBe(true);
    const reason = panel.getByTestId('entry-check-start-reason');
    expect(await reason.getAttribute('data-reason')).toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(await reason.textContent()).toContain(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.TARGET_CONFIG_UNAVAILABLE.description);
  }, SCENARIO_TIMEOUT_MS);

  it('fills a new auth setup with the proposal of the last entry check (a test profile without an auth setup), as a proposal', async () => {
    const page = await openPage(`/auth-setup/${MANUAL_PROFILE}`);
    const panel = page.getByTestId('entry-check-panel');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    // 認証の設定がなくても始められる。
    expect(await panel.getByTestId('entry-check-start').isEnabled()).toBe(true);
    expect(await page.getByTestId('auth-setup-entry-check-draft').count()).toBe(0);
    await tabTo(page, panel.getByTestId('entry-check-start'));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    await jobState(page, 'FINISHED').waitFor({ timeout: JOB_TIMEOUT_MS });
    // 認証の設定を使うプロファイルなので、認証の設定の画面へのリンクを出す。
    await page.getByTestId('job-entry-check-open-auth-setup').click();
    await page.waitForURL(new RegExp(`/auth-setup/${MANUAL_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('auth-setup-entry-check-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('[name="loginStartUrl"]').inputValue()).toBe(`${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.prefilled}`);
    expect(await page.locator('[name="sessionLostPathPrefix"]').inputValue()).toBe(ENTRY_CHECK_SITE_PATHS.prefilled);
    expect(await page.locator('[name="loginPostEndpoints"]').inputValue()).toBe(`${siteOf().originA}${ENTRY_CHECK_SITE_PATHS.session}`);
    // 開始の URL の path の案（T43b）は、ログインの画面の path に当たるので、成功の画面の path に残さない。
    expect(await page.locator('[name="successPathPrefix"]').inputValue()).toBe('');
    // 保存していない（案のまま）。
    const stored = await valueOf<{ stored: unknown }>('getAuthSetupFn', 'GET', { profileId: MANUAL_PROFILE });
    expect(stored.stored).toBeNull();
    await expectNoMarkers(page);
  }, SCENARIO_TIMEOUT_MS);

  it('fills the three selectors of the automated login from the proposal', async () => {
    await runEntryCheck(AUTOMATED_PROFILE);
    const page = await openPage(`/auth-setup/${AUTOMATED_PROFILE}`);
    await page.getByTestId('auth-setup-entry-check-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('[name="usernameSelector"]').inputValue()).toBe('#login-id');
    expect(await page.locator('[name="passwordSelector"]').inputValue()).toBe('#login-password');
    expect(await page.locator('[name="submitSelector"]').inputValue()).toBe('#login-submit');
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-7。測りの記録の 3.3 の B）: 案を作れなかった終わり方に、次にできることを出す。
  it('shows the next step when the start URL tried to leave the allowed origins', async () => {
    const jobId = await runEntryCheck(LEFT_PROFILE);
    const page = await openPage(`/jobs/${jobId}`);
    await page.getByTestId('job-entry-check').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('LEFT_ALLOWED_ORIGINS');
    expect(await page.getByTestId('job-entry-check-next-step').textContent()).toBe(LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons.LEFT_ALLOWED_ORIGINS);
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-8。設計の変更の履歴の T44e の行の (1) 案 (a)）: SPA（action のないログインの form。スクリプトで送るログイン）の入口の確かめの
  // 案は「スクリプトの送信」で、token の送信先と成功のローカル ストレージの鍵が空。手動のログインのプロファイルでは、そのまま保存できる（前は
  // `AUTH_SETUP_SCRIPT_LOGIN_REQUIRED` で拒まれた）。入口の確かめの結果と認証の設定の画面に、「手動のログインで一度ログインすると、送信先が自動で登録される」
  // 旨を出す（空の欄は、手動のログインの成功の後の自動の登録が埋める。`tests/integration/manual-login-pass-through.test.ts`）。
  it('saves the proposal of an SPA entry check as it is for a manual login profile, with the guidance of the automatic registration', async () => {
    const jobId = await runEntryCheck(SPA_PROFILE);
    const job = await openPage(`/jobs/${jobId}`);
    await job.getByTestId('job-entry-check').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await job.getByTestId('job-entry-check-end-reason').getAttribute('data-end-reason')).toBe('READ');
    expect(await job.getByTestId('job-entry-check-proposal').locator('[data-transport]').getAttribute('data-transport')).toBe('SCRIPT_REQUEST');
    expect(await job.getByTestId('job-entry-check-script-login-note').textContent()).toBe(LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote);
    const page = await openPage(`/auth-setup/${SPA_PROFILE}`);
    await page.getByTestId('auth-setup-entry-check-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('input[name="loginTransport"][value="SCRIPT_REQUEST"]').isChecked()).toBe(true);
    expect(await page.getByTestId('auth-setup-script-login-note').textContent()).toBe(LOCAL_UI_AUTH_TEXT.scriptLoginAutoRegistrationNote);
    // T44h の判断 (2)（測りの記録の N3）: 手動のログインのプロファイルでは、入口の確かめの案の文も自動の登録に合わせ、承認したサービスの Origin がなくても
    // 赤い文（先にプロファイルで足す）は出さない。
    expect(await page.getByTestId('auth-setup-entry-check-script').textContent()).toBe(text.authSetup.scriptTargetAutoRegistered);
    expect(await page.getByTestId('auth-setup-no-service-origins').count()).toBe(0);
    // 案にない欄（ログインが済んだと判定するパス。開始の URL の path はログインの画面なので、案は空）だけを人が入れる。送信先と鍵は空のまま。
    await page.locator('[name="successPathPrefix"]').fill(SPA_APP_PATHS.admin);
    await tabTo(page, page.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }));
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
    // 拒まれたときは、誤りの文を失敗の知らせに出す（値は画面に出ない）。
    expect(await page.getByTestId('auth-setup-rejection').count(), (await page.locator('.field-error').allTextContents()).join(' / ')).toBe(0);
    expect(await page.getByTestId('auth-setup-saved').count()).toBe(1);
    expect(await page.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBe(0);
    const stored = await valueOf<{ stored: { setup: Record<string, unknown> } | null }>('getAuthSetupFn', 'GET', { profileId: SPA_PROFILE });
    expect(stored.stored?.setup).toMatchObject({ loginTransport: 'SCRIPT_REQUEST', scriptLogin: null, successStorageKey: null });
  }, SCENARIO_TIMEOUT_MS);

  it('does not fill the auth setup with the proposal when a setup is saved', async () => {
    await runEntryCheck(SAVED_PROFILE);
    const page = await openPage(`/auth-setup/${SAVED_PROFILE}`);
    await page.getByTestId('entry-check-latest').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-entry-check-draft').count()).toBe(0);
    expect(await page.locator('[name="loginStartUrl"]').inputValue()).toBe(`${siteOf().originA}/saved-login`);
    expect(await page.locator('[name="loginPostEndpoints"]').inputValue()).toBe(`${siteOf().originA}/saved-session`);
  }, SCENARIO_TIMEOUT_MS);
});
