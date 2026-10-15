/**
 * 画面から動かす認証つきの監査の操作の確かめ（Task 25 の設計書 4.5、4.6、6 章。T25e）。ビルドした画面を一時の root の起動の部品で起動し、
 * Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 認証の設定がない → 開始の画面は理由（`AUTH_SETUP_MISSING`）と案内（ログインの案内、認証の設定へのリンク）を出し、開始のボタンを出さない。
 * - 認証の設定の画面（プロファイルの詳細から、キーボードだけ）: 秘密の欄がない、既定で読まない語の一覧、保存の拒否の項目ごとの誤り、保存、
 *   `STALE`（プロファイルの改訂が変わった）の表示と開始の拒否、保存し直すと `CURRENT`。
 * - 認証つきの開始: 開始の画面のログインの案内と認証の設定の要点 → ジョブの画面の「ログイン待ち」→（人の操作の代わりに、テストだけの入口が
 *   資格情報を入れる）→「ログイン済み」と結果。画面（ページの HTML、Server Function の応答）に、Cookie と localStorage の目印が出ない。
 * - セッションが切れて止まった（`SESSION_LOST`）: 止まったページの URL と、読まないパスに足す案内と、認証の設定へのリンク。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。fixture のサイトに届いた GET と HEAD 以外の要求は、ログインの
 *   POST だけ。ワーカーと Chromium の process が残らない。
 * 監査のワーカーは、一時の root の入口をテストだけの入口に替えて動かす（`helpers/auth-worker.ts`。ログイン用の Browser も headless）。管理データ、
 * ターゲット設定、出力先は、一時の root の中だけ。fixture のサイトは 127.0.0.1 だけ。スクリーンショットは、環境変数 `T25E_SCREENSHOT_DIR` が
 * あれば、そこに保存する。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../../src/control/auth/auth-setup-contracts.js';
import {
  AUDIT_JOB_AUTH_STATE_CATALOG,
  AUDIT_JOB_STATE_CATALOG,
  AUTH_SETUP_FRESHNESS_CATALOG,
} from '../../../src/presentation/catalog.js';
import { formatInteger } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
} from '../../../src/presentation/messages.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../../../tests/helpers/authenticated-site-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** 監査の終わりを待つ上限（ミリ秒）。 */
const AUDIT_TIMEOUT_MS = 150_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 300_000;
/** process が消えるのを待つ上限（ミリ秒）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** テストだけの入口の、ログインを待つ時間（ミリ秒。テストが資格情報を渡すまでの間を含む）。 */
const TEST_LOGIN_TIMEOUT_MS = 120_000;
/** 受け渡しのサーバに、ログインの画面の準備の知らせが来るのを待つ間隔（ミリ秒）。 */
const RELAY_POLL_MS = 100;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 80;
/** 監査するページの上限（管理画面の数ページ）。 */
const MAX_PAGES = 3;
/** テストの値（匿名）。 */
const MAIN_PROFILE = 't25e-ui-auth';
const LOST_PROFILE = 't25e-ui-lost';
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
/** 秘密の欄の名前に見える語（認証の設定の画面の入力の欄の名前に、含まれないこと）。 */
const SECRET_FIELD_NAME = /pass|secret|cookie|token|credential/iu;

const auditText = LOCAL_UI_AUDIT_TEXT;
const authText = LOCAL_UI_AUTH_TEXT;
const SCREENSHOT_DIRECTORY = process.env['T25E_SCREENSHOT_DIR'];

let root: TemporaryUiRoot | undefined;
let mainSite: AuthenticatedSite | undefined;
let lostSite: AuthenticatedSite | undefined;
let relay: CredentialRelay | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
let mainConfig = '';
let lostConfig = '';
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];

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

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求）、Tab だけのフォーカスの移動、スクリーンショット（CCX-16 の共通の補助）。 */
const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する。 */
const recordDescendants = async (): Promise<readonly ProcessIdentity[]> => {
  const found = descendantsOf(started().child.pid ?? 0, await listProcesses());
  descendants.push(...found);
  return found;
};

const callFunction = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async (name: string, method: 'GET' | 'POST', data?: unknown): Promise<unknown> => {
  const result = await callFunction(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);
  return result.value;
};

/** 認証つきの読み取りの監査のプロファイルの文書。 */
const authProfileDocument = (profileId: string, targetConfigPath: string, origin: string, revision: number): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision,
  targetConfigPath,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [origin],
  environmentEvidenceRef: 't25e-evidence',
});

/** fixture の正しい資格情報（値はテストの process の中だけ。出力しない）。 */
const credentialsOf = async (site: AuthenticatedSite): Promise<RelayedCredentials> => {
  const fields: (readonly [string, string])[] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  return { fields, submit: AUTH_SITE_LOGIN_FIELDS.submit };
};

/** 受け渡しのサーバに、ログインの画面の準備の知らせ（資格情報の取りに来る要求）が `count` 回来るまで待つ。 */
const waitForLoginPage = async (count: number): Promise<void> => {
  await expect.poll(() => relay?.requested() ?? 0, { timeout: AUDIT_TIMEOUT_MS, interval: RELAY_POLL_MS }).toBeGreaterThanOrEqual(count);
};

/** 一覧の行の「監査を始める」から、開始の画面を開く（キーボードだけ）。 */
const openStartFromList = async (profileId: string): Promise<Page> => {
  const page = await openPage('/');
  const row = page.locator(`tr[data-profile-id="${profileId}"]`);
  await tabTo(page, row.getByRole('link', { name: auditText.profileList.startAudit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** 開始の画面で「新しく始める」を選んで開始し、ジョブの画面に移る（キーボードだけ）。ジョブの ID を返す。 */
const startNewFromStartPage = async (page: Page): Promise<string> => {
  await tabTo(page, page.getByRole('radio', { name: auditText.start.resume }));
  await page.keyboard.press('ArrowDown');
  expect(await page.getByRole('radio', { name: auditText.start.startNew }).isChecked()).toBe(true);
  await tabTo(page, page.getByRole('button', { name: auditText.start.submit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
};

const jobState = (page: Page, state: keyof typeof AUDIT_JOB_STATE_CATALOG): Locator =>
  page.locator(`[data-testid="job-state"][data-state="${state}"]`);

const authState = (page: Page, state: keyof typeof AUDIT_JOB_AUTH_STATE_CATALOG): Locator =>
  page.locator(`[data-testid="job-auth-state"][data-auth-state="${state}"]`);

/** 認証の設定の画面の、項目の入力（ラベルは完全一致）。 */
const field = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

/** 認証の設定の画面で、項目を書き換える。 */
const fillSetup = async (page: Page, values: Readonly<Record<string, string>>): Promise<void> => {
  for (const [label, value] of Object.entries(values)) {
    await field(page, label).fill(value);
  }
};

/** fixture のサイトに届いた、GET と HEAD 以外の要求（`<method> <path>`）。 */
const nonReadRequests = (site: AuthenticatedSite): readonly string[] =>
  site.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  mainSite = await startAuthenticatedSite({ loginForm: true });
  // ログインの画面の後の管理画面（ログイン用の Browser が 1 回読む）の次に、セッションを期限切れにする（監査の最初のページで切れる）。
  lostSite = await startAuthenticatedSite({ loginForm: true, maxAdminPages: 1 });
  relay = await startCredentialRelay();
  installTestAuthWorkerEntry(root.root, relay.url, TEST_LOGIN_TIMEOUT_MS);
  mainConfig = writeAuthTargetConfig(root.root, MAIN_PROFILE, mainSite.originA, AUTH_SITE_PATHS.admin, MAX_PAGES);
  lostConfig = writeAuthTargetConfig(root.root, LOST_PROFILE, lostSite.originA, AUTH_SITE_PATHS.admin, MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  expect(page.url()).toBe(`${server.origin}/`);
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: authProfileDocument(MAIN_PROFILE, mainConfig, mainSite.originA, FIRST_REVISION) }))
    .toMatchObject({ ok: true });
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await relay?.close();
  await mainSite?.close();
  await lostSite?.close();
  root?.remove();
});

describe('local UI: the authenticated audit (TEST_AUTH_PASSIVE)', () => {
  it('shows AUTH_SETUP_MISSING on the start screen with the login guidance and a link to the auth setup, and no start button', async () => {
    const start = await openStartFromList(MAIN_PROFILE);
    expect(await start.getByTestId('start-login-guidance').textContent()).toBe(authText.start.guidance);
    expect(await start.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await start.getByTestId('start-reason').textContent()).toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description);
    expect(await start.getByText(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.action).count()).toBe(1);
    expect(await start.getByRole('button', { name: auditText.start.submit }).count()).toBe(0);
    await screenshot(start, '01-start-auth-setup-missing');

    await tabTo(start, start.getByTestId('start-open-auth-setup'));
    await start.keyboard.press('Enter');
    await start.waitForURL(new RegExp(`/auth-setup/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await start.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
  }, SCENARIO_TIMEOUT_MS);

  it('opens the auth setup from the profile, has no secret field, and shows the errors by field after a rejected save', async () => {
    const site = siteOf(mainSite);
    const profile = await openPage(`/profiles/${MAIN_PROFILE}`);
    await tabTo(profile, profile.getByTestId('profile-auth-setup').getByRole('link', { name: authText.profileDetail.open }));
    await profile.keyboard.press('Enter');
    await profile.waitForURL(new RegExp(`/auth-setup/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const page = profile;
    await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });

    // 秘密を入れる欄がない（案内はある）。
    expect(await page.getByTestId('auth-setup-no-secret').textContent()).toBe(authText.setup.noSecretBody);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    const names = await page.locator('input, textarea, select').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('name') ?? ''));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => SECRET_FIELD_NAME.test(name))).toEqual([]);
    expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('NONE');
    expect(await page.getByTestId('auth-setup-default-excluded').locator('li').allTextContents()).toEqual([...DEFAULT_EXCLUDED_URL_WORDS]);

    // 誤りのある値で保存 → 項目ごとの誤り（保存しない）。
    const setup = authText.setup;
    await fillSetup(page, {
      [setup.loginStartUrl]: `${site.originA}${AUTH_SITE_PATHS.login}`,
      [setup.loginPostEndpoints]: `${site.originA}${AUTH_SITE_PATHS.login}`,
      [setup.successPathPrefix]: '/',
      [setup.excludedPaths]: `${AUTH_SITE_PATHS.adminLogout}\nadmin`,
      [setup.auditPathPrefixes]: AUTH_SITE_PATHS.admin,
    });
    await tabTo(page, page.getByRole('button', { name: setup.save }));
    await page.keyboard.press('Enter');
    await page.getByTestId('auth-setup-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    expect(await page.getByTestId('auth-setup-rejection').textContent()).toBe(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS.AUTH_SETUP_INVALID.description);
    expect(await field(page, setup.successPathPrefix).getAttribute('aria-invalid')).toBe('true');
    expect(await field(page, setup.excludedPaths).getAttribute('aria-invalid')).toBe('true');
    expect(await field(page, setup.loginStartUrl).getAttribute('aria-invalid')).toBe('false');
    await page.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS).waitFor();
    await page.getByText(`${setup.lineText(formatInteger(2))}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_PATH_INVALID}`).waitFor();
    expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('NONE');
    await screenshot(page, '02-auth-setup-errors');

    // 直して保存（キーボード）→ 保存の知らせと CURRENT。
    await fillSetup(page, {
      [setup.successPathPrefix]: AUTH_SITE_PATHS.admin,
      [setup.successSelector]: '#admin-ok',
      [setup.excludedPaths]: AUTH_SITE_PATHS.adminLogout,
    });
    await tabTo(page, page.getByRole('button', { name: setup.save }));
    await page.keyboard.press('Enter');
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator('[data-testid="auth-setup-freshness"][data-freshness="CURRENT"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-freshness').textContent()).toBe(AUTH_SETUP_FRESHNESS_CATALOG.CURRENT.label);
    expect(await field(page, setup.successSelector).inputValue()).toBe('#admin-ok');
    await screenshot(page, '03-auth-setup-saved');
  }, SCENARIO_TIMEOUT_MS);

  it('shows STALE after the profile changes, rejects the start with AUTH_SETUP_STALE, and becomes CURRENT after saving again', async () => {
    const site = siteOf(mainSite);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: authProfileDocument(MAIN_PROFILE, mainConfig, site.originA, SECOND_REVISION),
      expectedRevision: FIRST_REVISION,
    })).toMatchObject({ ok: true });

    const page = await openPage(`/auth-setup/${MAIN_PROFILE}`);
    expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('STALE');
    expect(await page.getByTestId('auth-setup-freshness').textContent()).toBe(AUTH_SETUP_FRESHNESS_CATALOG.STALE.label);
    expect(await page.getByTestId('auth-setup-stale').textContent()).toBe(authText.setup.staleBody);
    await screenshot(page, '04-auth-setup-stale');

    const start = await openStartFromList(MAIN_PROFILE);
    expect(await start.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_STALE');
    expect(await start.getByTestId('start-reason').textContent()).toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_STALE.description);
    expect(await start.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await start.getByRole('button', { name: auditText.start.submit }).count()).toBe(0);
    await screenshot(start, '05-start-auth-setup-stale');

    await tabTo(page, page.getByRole('button', { name: authText.setup.save }));
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="auth-setup-freshness"][data-freshness="CURRENT"]').waitFor({ timeout: UI_TIMEOUT_MS });
  }, SCENARIO_TIMEOUT_MS);

  it('starts the authenticated audit: awaiting login, then authenticated and the result, and the screen shows no cookie marker', async () => {
    const site = siteOf(mainSite);
    const start = await openStartFromList(MAIN_PROFILE);
    const summary = await start.getByTestId('start-auth-setup').textContent();
    expect(summary).toContain(`${site.originA}${AUTH_SITE_PATHS.login}`);
    expect(summary).toContain(AUTH_SITE_PATHS.admin);
    expect(await start.getByTestId('start-login-guidance').textContent()).toBe(authText.start.guidance);
    await screenshot(start, '06-start-authenticated');
    const jobId = await startNewFromStartPage(start);

    // ログインの画面を開いた（受け渡しのサーバに来た）→ 画面は「ログイン待ち」。
    await waitForLoginPage(1);
    await authState(start, 'AWAITING_LOGIN').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    expect(await start.getByTestId('job-auth-state').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.AWAITING_LOGIN.label);
    expect(await start.getByTestId('job-auth-description').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.AWAITING_LOGIN.description);
    expect((await recordDescendants()).length).toBeGreaterThan(0);
    await screenshot(start, '07-awaiting-login');

    // 人の操作の代わりに、テストだけの入口が資格情報を入れる → ログイン済み → 監査 → 終わり。
    relay?.provide(await credentialsOf(site));
    await jobState(start, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    await authState(start, 'AUTHENTICATED').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    expect(await start.getByTestId('job-session-lost-url').count()).toBe(0);
    await screenshot(start, '08-authenticated-finished');
    expect(site.successfulLogins).toBe(1);
    expect(nonReadRequests(site)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);

    // 画面（ページの HTML、Server Function の応答）に、Cookie と localStorage の目印が出ない。
    const markers = site.secretValues();
    expect(markers.length).toBeGreaterThan(1);
    const leaked = (text: string): readonly string[] => markers.filter((marker) => text.includes(marker));
    const texts: string[] = [await start.content()];
    for (const path of ['/', '/jobs', `/jobs/${jobId}`, `/start/${MAIN_PROFILE}`, `/auth-setup/${MAIN_PROFILE}`, `/profiles/${MAIN_PROFILE}`]) {
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      texts.push(response.body);
    }
    for (const [name, data] of [
      ['getAuditJobFn', { jobId }],
      ['listAuditJobsFn', undefined],
      ['auditStartSummaryFn', { profileId: MAIN_PROFILE }],
      ['getAuthSetupFn', { profileId: MAIN_PROFILE }],
      ['listProfilesFn', undefined],
    ] as const) {
      const result = await callFunction(name, 'GET', data);
      expect(result.response.status, name).toBe(200);
      texts.push(result.response.body);
    }
    expect(texts.flatMap(leaked)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  it('stops with SESSION_LOST: shows the URL of the stopped page and the guidance with a link to the auth setup', async () => {
    const site = siteOf(lostSite);
    expect(await valueOf('createProfileFn', 'POST', { profile: authProfileDocument(LOST_PROFILE, lostConfig, site.originA, FIRST_REVISION) }))
      .toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: {
        schemaVersion: 'beaksight-auth-setup/2',
        profileId: LOST_PROFILE,
        profileRevision: FIRST_REVISION,
        loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
        loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
        successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [AUTH_SITE_PATHS.adminLogout],
        auditPathPrefixes: [AUTH_SITE_PATHS.admin],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
      },
    })).toMatchObject({ ok: true });
    const requestedBefore = relay?.requested() ?? 0;
    relay?.provide(await credentialsOf(site));
    const start = await openStartFromList(LOST_PROFILE);
    const jobId = await startNewFromStartPage(start);
    await waitForLoginPage(requestedBefore + 1);
    await recordDescendants();

    await jobState(start, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    await authState(start, 'SESSION_LOST').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    expect(await start.getByTestId('job-auth-state').textContent()).toBe(AUDIT_JOB_AUTH_STATE_CATALOG.SESSION_LOST.label);
    expect(await start.getByTestId('job-session-lost-url').textContent()).toBe(`${site.originA}${AUTH_SITE_PATHS.admin}`);
    expect(await start.getByTestId('job-session-lost-guidance').textContent()).toBe(authText.job.sessionLostGuidance);
    // 止まったページの URL は、リンクにしない。
    expect(await start.getByTestId('job-auth').locator(`a[href*="${site.originA}"]`).count()).toBe(0);
    await screenshot(start, '09-session-lost');
    expect(nonReadRequests(site)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);

    await tabTo(start, start.getByTestId('job-open-auth-setup'));
    await start.keyboard.press('Enter');
    await start.waitForURL(new RegExp(`/auth-setup/${LOST_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await start.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(jobId).not.toBe('');
  }, SCENARIO_TIMEOUT_MS);
});
