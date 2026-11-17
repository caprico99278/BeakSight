/**
 * 画面から動かす認証つきの監査の操作の確かめ（Task 25 の設計書 4.5、4.6、6 章。T25e）。ビルドした画面を一時の root の起動の部品で起動し、
 * Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 認証の設定がない → 開始の画面は理由（`AUTH_SETUP_MISSING`）と案内（ログインの案内、認証の設定へのリンク）を出し、開始のボタンを出さない。
 * - 認証の設定の画面（プロファイルの詳細から、キーボードだけ）: 秘密の欄がない、既定で読まない語の一覧、保存の拒否の項目ごとの誤り、保存、
 *   `STALE`（プロファイルの改訂が変わった）の表示と開始の拒否、保存し直すと `CURRENT`。
 * - T44d（Task 44 の設計書 P2-2）: プロファイルの画面の入り口（「認証の設定を開く」）の近くに、読む範囲・読まないパスの今の値と状態の要約。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。
 * UI-6（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）: 前の場面 4（認証つきの開始: ログイン待ち → ログイン済みと結果。画面に Cookie の
 * 目印が出ない）と場面 5（`SESSION_LOST` の止まったページの URL と案内と認証の設定へのリンク）は、同じ認証つきの監査と `SESSION_LOST` を流す
 * `login-secret-markers.test.ts` の同じジョブで確かめる（Cookie の目印は、そこの検索がすべての画面と応答で探す）。この確かめはジョブを始めない。
 * 管理データ、ターゲット設定は、一時の root の中だけ。スクリーンショットは、環境変数 `T25E_SCREENSHOT_DIR` があれば、そこに保存する。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../../src/core/default-excluded-url-words.js';
import { AUTH_SETUP_FRESHNESS_CATALOG } from '../../../src/presentation/catalog.js';
import { formatInteger } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
} from '../../../src/presentation/messages.js';
import { AUTH_SITE_PATHS, startAuthenticatedSite, type AuthenticatedSite } from '../../../tests/helpers/authenticated-site-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import {
  BUILT_SERVER_ENTRY,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { openAuthSetupAdvancedSettings, openProfileAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 300_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 80;
/** 監査するページの上限（ターゲット設定の値。この確かめは監査を始めない）。 */
const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
/** テストの値（匿名）。 */
const MAIN_PROFILE = 't25e-ui-auth';
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
/** 秘密の欄の名前に見える語（認証の設定の画面の入力の欄の名前に、含まれないこと）。 */
const SECRET_FIELD_NAME = /pass|secret|cookie|token|credential/iu;

const auditText = LOCAL_UI_AUDIT_TEXT;
const authText = LOCAL_UI_AUTH_TEXT;
const SCREENSHOT_DIRECTORY = process.env['T25E_SCREENSHOT_DIR'];

let root: TemporaryUiRoot | undefined;
let mainSite: AuthenticatedSite | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
let mainConfig = '';

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

/**
 * 点検を始められないサイトの開始の画面を開く。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: サイトの画面は、押せないときは「点検を始める」を
 * 出さず、要点に理由を出す（前は押せない形のボタンがあった）。そのことを確かめてから、開始の画面を直接開く（開始の画面も同じ確かめの理由を出す）。
 */
const openBlockedStart = async (profileId: string): Promise<Page> => {
  const detail = await openPage(`/profiles/${profileId}`);
  await detail.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  expect(await detail.getByRole('main').getByRole('link', { name: auditText.profileList.startAudit }).count()).toBe(0);
  const page = await openPage(`/start/${profileId}`);
  await page.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** 認証の設定の画面の、項目の入力（ラベルは完全一致）。 */
const field = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

/** 認証の設定の画面で、項目を書き換える。 */
const fillSetup = async (page: Page, values: Readonly<Record<string, string>>): Promise<void> => {
  for (const [label, value] of Object.entries(values)) {
    await field(page, label).fill(value);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  mainSite = await startAuthenticatedSite({ loginForm: true });
  mainConfig = writeAuthTargetConfig(root.root, MAIN_PROFILE, mainSite.originA, AUTH_SITE_PATHS.admin, MAX_PAGES);
  ids = readServerFunctionIds(BUILT_SERVER_ENTRY);
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
  await mainSite?.close();
  root?.remove();
});

describe('local UI: the authenticated audit (TEST_AUTH_PASSIVE)', () => {
  it('shows AUTH_SETUP_MISSING on the start screen with the login guidance and a link to the auth setup, and no start button', async () => {
    const start = await openBlockedStart(MAIN_PROFILE);
    expect(await start.getByTestId('start-login-guidance').textContent()).toBe(authText.start.guidance);
    expect(await start.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await start.getByTestId('start-reason').textContent()).toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description);
    expect(await start.getByText(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.action).count()).toBe(1);
    expect(await start.getByRole('button', { name: auditText.start.submit }).count()).toBe(0);
    await screenshot(start, '01-start-auth-setup-missing');

    await tabTo(start, start.getByTestId('start-open-auth-setup'));
    await start.keyboard.press('Enter');
    await start.waitForURL(new RegExp(`/auth-setup/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await openAuthSetupAdvancedSettings(start, UI_TIMEOUT_MS);
    await start.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
  }, SCENARIO_TIMEOUT_MS);

  it('opens the auth setup from the profile, has no secret field, and shows the errors by field after a rejected save', async () => {
    const site = siteOf(mainSite);
    const profile = await openPage(`/profiles/${MAIN_PROFILE}`);
    // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、6 章の 1〜2。前は T44d の認証の設定の欄に要約を出していた）: 認証の設定がまだないので、
    // 要点の段は入口の確かめから。認証の設定の画面への入口は、詳しい内容の中。
    const summary = profile.getByTestId('profile-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.getAttribute('data-stage')).toBe('ENTRY_NOT_CHECKED');
    await openProfileAuthSetupAdvancedSettings(profile, UI_TIMEOUT_MS);
    await tabTo(profile, profile.getByTestId('profile-detail-actions').getByRole('link', { name: authText.profileDetail.open }));
    await profile.keyboard.press('Enter');
    await profile.waitForURL(new RegExp(`/auth-setup/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const page = profile;
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
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
    // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8 (b)）: 入口の確かめの案がないときの既定の送り方は、送信先のない形（スクリプトの送信）に
    // なった。この場面は、人がフォームの送信先を手で入れる道を確かめるので、先にフォームの送信を選ぶ。
    const setup = authText.setup;
    expect(await page.locator('input[name="loginTransport"][value="SCRIPT_REQUEST"]').isChecked()).toBe(true);
    await page.locator('input[name="loginTransport"][value="FORM_NAVIGATION"]').check();
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

    // MI-F5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6）: 直しても、ログインの送信先（フォームの送信先）を手で入れた最初の保存は拒む
    // （このプロファイルには入口の確かめの案がない。送信先は、入口の確かめと手動のログインの観察からだけ入る）。
    await fillSetup(page, {
      [setup.successPathPrefix]: AUTH_SITE_PATHS.admin,
      [setup.excludedPaths]: AUTH_SITE_PATHS.adminLogout,
    });
    await tabTo(page, page.getByRole('button', { name: setup.save }));
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="auth-setup-rejection"][data-reason="CREDENTIAL_DESTINATION_OBSERVED_ONLY"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-rejection').textContent())
      .toBe(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS.CREDENTIAL_DESTINATION_OBSERVED_ONLY.description);
    expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('NONE');
    // テストの準備: 入口の確かめの後の案の保存と同じ形の設定（フォームの送信先は、ログインの画面の form の送信先）を、保存の部品で直接保存する。
    expect(await saveAuthSetupRequestInStore(root, {
      setup: {
        ...FORM_NAVIGATION_SETUP_ITEMS,
        profileId: MAIN_PROFILE,
        profileRevision: FIRST_REVISION,
        loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
        loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
        successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: null },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [AUTH_SITE_PATHS.adminLogout],
        auditPathPrefixes: [AUTH_SITE_PATHS.admin],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
      },
    })).toMatchObject({ ok: true });

    // 送信先でない欄を直して保存（キーボード）→ 保存の知らせと CURRENT。認証の設定があるときは、ログインの送信先は読むだけ。
    await page.reload();
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-4: 読むだけの送信先の欄は、画面に出さない（値が残ることは、この後の保存と CURRENT で確かめる）。
    expect(await page.getByTestId('auth-setup-destination-login-start-url').count()).toBe(0);
    await fillSetup(page, { [setup.successSelector]: '#admin-ok' });
    await tabTo(page, page.getByRole('button', { name: setup.save }));
    await page.keyboard.press('Enter');
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator('[data-testid="auth-setup-freshness"][data-freshness="CURRENT"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-freshness').textContent()).toBe(AUTH_SETUP_FRESHNESS_CATALOG.CURRENT.label);
    expect(await field(page, setup.successSelector).inputValue()).toBe('#admin-ok');
    await screenshot(page, '03-auth-setup-saved');

    // PL-1（作業記録 UX-1 の画面 A の 1.3。読む範囲と読まないパスは、監査の開始の画面に出す。MI-3）: サイトの画面は、認証の設定が済んだことを段で示す（点検を
    // 始める）。読む範囲と読まないパスの今の値の要約は、サイトの画面から消した（前は T44d で入り口の近くに出していた）。
    const detail = await openPage(`/profiles/${MAIN_PROFILE}`);
    const saved = detail.getByTestId('profile-summary');
    await saved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await saved.getAttribute('data-stage')).toBe('AUDIT_MANUAL_LOGIN');
    expect(await detail.getByTestId('profile-auth-setup-summary').count()).toBe(0);
    expect(await detail.getByRole('main').innerText()).not.toContain(AUTH_SITE_PATHS.adminLogout);
    await openProfileAuthSetupAdvancedSettings(detail, UI_TIMEOUT_MS);
    expect(await detail.getByTestId('profile-detail-actions').getByRole('link', { name: authText.profileDetail.open }).getAttribute('href'))
      .toBe(`/auth-setup/${MAIN_PROFILE}`);
    // 読む範囲と読まないパスの今の値は、監査の開始の画面に出る（MI-3 の C）。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 開始の画面の
    // たたんだ詳しい内容の中（ふだんは見えない）。
    const startScreen = await openPage(`/start/${MAIN_PROFILE}`);
    await startScreen.getByTestId('start-login').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await startScreen.getByTestId('start-auth-setup').textContent()).toContain(AUTH_SITE_PATHS.admin);
    expect(await startScreen.getByRole('main').innerText()).not.toContain(AUTH_SITE_PATHS.admin);
    await openAdvancedSettings(startScreen, 'start-advanced-settings', UI_TIMEOUT_MS);
    expect(await startScreen.getByRole('main').innerText()).toContain(AUTH_SITE_PATHS.admin);
    await screenshot(detail, '03b-profile-auth-setup-summary');
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

    const start = await openBlockedStart(MAIN_PROFILE);
    expect(await start.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_STALE');
    expect(await start.getByTestId('start-reason').textContent()).toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_STALE.description);
    expect(await start.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await start.getByRole('button', { name: auditText.start.submit }).count()).toBe(0);
    await screenshot(start, '05-start-auth-setup-stale');

    // MI-3: 「保存する」は、たたんだ「詳しい設定」の中。開いてから押す。
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    await tabTo(page, page.getByRole('button', { name: authText.setup.save }));
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="auth-setup-freshness"][data-freshness="CURRENT"]').waitFor({ timeout: UI_TIMEOUT_MS });
  }, SCENARIO_TIMEOUT_MS);
});
