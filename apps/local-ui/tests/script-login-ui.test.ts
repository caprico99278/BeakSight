/**
 * スクリプトで送るログインの画面（T34d。Task 34 の設計書 3.1、3.2、3.6）を、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。
 * - プロファイルの画面: 「承認したサービスの Origin」の欄は、テスト環境の 2 つのモードだけ出る。誤り（形の誤り、テスト環境の Origin との重なり）は、
 *   その欄に出る。保存すると、プロファイルの項目になる。
 * - 認証の設定の画面: ログインの送り方でスクリプトの送信を選ぶと、フォームの送信先の欄が消え、token の送信先（Origin は承認したサービスの Origin から
 *   選ぶ）・必須の query の組・ログインに伴う送信の一覧・成功のローカル ストレージの鍵の形の欄が出る。保存すると版 3 の設定になり、読み直すと同じ値。
 * - 誤りは、検証の owner の位置で欄と行に出る（要る項目の欠け、承認していないサービスの Origin、必須の query、送信先の重なり、鍵の形、フォームの送信の
 *   送信先の欠け）。
 * - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 版 2 の設定は保存できない（版 3 だけ。前の版の知らせと、版 2 のまま保存する道は捨てた）。
 * - 秘密の目印: 秘密に見える名前の query の値（目印）は、保存を拒まれ、Server Function の応答と管理データ（WAL を含む）に出ない。
 * - T34e: ジョブの詳細に「ログインの段で止めた送信」の表（Origin、パス、種類、理由、回数）と、数のまとめと、登録の案内が出る（値に見える区切りを
 *   伏せた path は伏せた旨を添え、一覧の上限を超えた数は文で）。ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない）。
 * - T35d: スクリプトの送信のときだけ、監査の段の読み取りの手続きの呼び出しの一覧と、サービスの Origin への要求の上限の欄が出る。保存して読み直すと
 *   同じ値（空の上限は上限の値）。重なりと範囲の外の上限は、欄と行に出る。フォームの送信では出ない。項目を足さない保存では、項目を持たない。
 * - T36a（Task 36 の設計書 3.5）: 自動ログインのプロファイルでも「ログインの送り方」を選べる。スクリプトで送るログインを選んで保存すると、自動ログインの
 *   設定（3 つのセレクタ、固定の回数）を持つ版 3 のスクリプトの送信の設定になる。
 * ターゲット設定と管理データは一時の root の中だけ（監査はしない。サイトへは接続しない）。値は匿名（`example.invalid` とループバック）。
 */
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  MAX_SERVICE_REQUESTS_PER_MINUTE,
  MAX_SERVICE_REQUESTS_PER_RUN,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { WORKER_LOGIN_CREDENTIAL_BLOCK_REASON, WORKER_SCRIPT_LOGIN_BLOCK_REASONS } from '../../../src/control/worker-protocol.js';
import { REDACTED_PATH_SEGMENT } from '../../../src/core/url-path-redaction.js';
import { formatCount, formatTimes } from '../../../src/presentation/format.js';
import { LOGIN_TRANSPORT_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_SPA_AUDIT_TEXT,
  LOCAL_UI_TEXT,
  LOGIN_STAGE_BLOCK_REASON_LABELS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { databaseFilePlaces, placesWithMarkers } from '../../../tests/helpers/leak-places.js';
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
import { chooseExistingTargetConfig } from './helpers/profile-form.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 120_000;
/** フォーカスを Tab で動かす回数の上限（使わないが、補助の決まり）。 */
const MAX_TAB_PRESSES = 80;
/** 巡回の上限（ターゲット設定の値。監査はしない）。 */
const MAX_PAGES = 3;
/** テストの値（匿名）。テスト環境の Origin はループバック（接続しない）。サービスの Origin は `example.invalid`。 */
const SCRIPT_PROFILE = 't34d-script';
const LEGACY_PROFILE = 't34d-legacy';
const JOB_PROFILE = 't34e-job';
const AUTO_PROFILE = 't36a-auto';
const JOB_ID = 'job-t34e-login-stage';
const JOB_CREATED_AT = '20261016010000';
const JOB_ENDED_AT = '20261016011000';
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_SERVICE_ORIGIN = 'https://other-service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const SIDE_PATH = '/functions/v1/sync_access';
const SIDE_COUNT = 2;
/** T36R-fix（T36R の M-7）: ジョブの行に書く、資格情報を含む要求を止めた数。 */
const CREDENTIAL_BLOCKED_COUNT = 2;
const ADMIN_PATH = '/admin';
const LOGOUT_PATH = '/admin/logout';
/** 秘密に見える名前の query の値の目印（起動のたびに作る。出力しない）。 */
const SECRET_MARKER = `m${randomBytes(16).toString('hex')}`;
const SCREENSHOT_DIRECTORY = process.env['T34D_SCREENSHOT_DIR'];

const profileText = LOCAL_UI_TEXT.profileForm;
const authText = LOCAL_UI_AUTH_TEXT.setup;
const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
/** Server Function の応答の本文（ブラウザが受けたもの。目印の検査に使う）。 */
const responseBodies: string[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root;
};

const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
  onPageCreated: (page) => {
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/_serverFn/')) {
        void response.text().then((body) => responseBodies.push(body), () => undefined);
      }
    });
  },
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  responseBodies.push(result.response.body);
  expect(result.response.status, name).toBe(200);
  return result.value as T;
};

/** 保存してある認証の設定（画面の Server Function の値）。 */
interface AuthSetupPage {
  readonly profile: { readonly revision: number; readonly approvedServiceOrigins: readonly string[] };
  readonly stored: { readonly setup: Record<string, unknown>; readonly updatedAt: string } | null;
}
const authSetupPageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });

/** 欄（ラベルは完全一致）。 */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/** 行の欄のラベル（`1 行目 名前` の形）。 */
const rowLabel = (line: number, label: string): string => `${authText.lineText(String(line))} ${label}`;

/** 認証の設定の画面を開き、フォームが出るまで待つ。 */
const openAuthSetup = async (profileId: string): Promise<Page> => {
  const page = await openPage(`/auth-setup/${profileId}`);
  await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** 保存を押し、保存の知らせか拒否が出るまで待つ。 */
const saveSetup = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: authText.save }).click();
  await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
};

/** 欄の誤りの文（`aria-invalid` と、誤りの文を含むこと）。 */
const expectFieldError = async (page: Page, label: string, description: string): Promise<void> => {
  expect(await field(page, label).getAttribute('aria-invalid'), label).toBe('true');
  expect(await page.locator('.field', { has: field(page, label) }).locator('.field-error').textContent(), label).toContain(description);
};

/** 一覧の枠の誤りの文（行の見出しつき）。 */
const expectGroupError = async (page: Page, testId: string, text: string): Promise<void> => {
  const group = page.getByTestId(testId);
  expect(await group.getAttribute('aria-invalid'), testId).toBe('true');
  expect(await group.locator('.field-error').textContent(), testId).toContain(text);
};

/** 手動のログインのテスト環境のプロファイルを Server Function で作る（版 2 の場面の準備）。 */
const profileDocumentOf = (profileId: string, targetConfigPath: string, revision: number, serviceOrigins: readonly string[]) => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision,
  targetConfigPath,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: `${profileId}-evidence`,
  ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
});

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  writeAuthTargetConfig(root.root, SCRIPT_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  writeAuthTargetConfig(root.root, LEGACY_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  writeAuthTargetConfig(root.root, JOB_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  writeAuthTargetConfig(root.root, AUTO_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
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

describe('T34d: the approved service origins on the profile screen', () => {
  it('shows the field only for the two test modes, puts its errors on it, and saves the origins', async () => {
    const page = await openPage('/profiles/new');
    await field(page, profileText.profileId).fill(SCRIPT_PROFILE);
    // T43b: 作成の画面の既定は「開始の URL から新しく作る」。この流れは、すでにある設定のファイルを選ぶ。
    await chooseExistingTargetConfig(page, `config/targets/${SCRIPT_PROFILE}.json`, UI_TIMEOUT_MS);
    await page.getByText(profileText.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
    // 公開の監査のモード（既定）では、欄がない。
    expect(await field(page, scriptText.profile.approvedServiceOrigins).count()).toBe(0);
    await field(page, profileText.environment).selectOption('TEST');
    await field(page, profileText.mode).selectOption('TEST_AUTH_PASSIVE');
    await field(page, profileText.auth).selectOption('MANUAL_SESSION');
    await field(page, profileText.approvedTestOrigins).fill(TEST_ORIGIN);
    await field(page, profileText.environmentEvidenceRef).fill(`${SCRIPT_PROFILE}-evidence`);
    const services = field(page, scriptText.profile.approvedServiceOrigins);
    await services.waitFor({ timeout: UI_TIMEOUT_MS });

    // 形の誤りと、テスト環境の Origin との重なりは、欄に出る。
    for (const [value, code] of [
      ['ftp://service.example.invalid', 'PROFILE_SERVICE_ORIGIN_INVALID'],
      [TEST_ORIGIN, 'PROFILE_SERVICE_ORIGIN_INSIDE_TARGET'],
    ] as const) {
      await services.fill(value);
      await page.getByRole('button', { name: profileText.save }).click();
      await expect.poll(() => services.getAttribute('aria-invalid'), { timeout: UI_TIMEOUT_MS }).toBe('true');
      await expectFieldError(page, scriptText.profile.approvedServiceOrigins, PROFILE_VALIDATION_ERROR_DESCRIPTIONS[code]);
    }
    await screenshot(page, 'd01-profile-service-origin-error');
    await services.fill(`${SERVICE_ORIGIN}\n${OTHER_SERVICE_ORIGIN}`);
    await page.getByRole('button', { name: profileText.save }).click();
    await page.getByText(profileText.created).waitFor({ timeout: UI_TIMEOUT_MS });
    const detail = await valueOf<{ profile: { approvedServiceOrigins?: readonly string[] } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE });
    expect(detail.profile.approvedServiceOrigins).toEqual([SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN]);
    // 読み直すと、同じ値（1 行に 1 つ）。
    const reopened = await openPage(`/profiles/${SCRIPT_PROFILE}`);
    expect(await field(reopened, scriptText.profile.approvedServiceOrigins).inputValue()).toBe(`${SERVICE_ORIGIN}\n${OTHER_SERVICE_ORIGIN}`);
    await screenshot(reopened, 'd02-profile-service-origins');
  }, SCENARIO_TIMEOUT_MS);
});

describe('T34d: the version 3 auth setup screen (the script login)', () => {
  it('saves a script login setup as version 3, and shows the same values after reopening', async () => {
    const page = await openAuthSetup(SCRIPT_PROFILE);
    expect(await page.getByTestId('auth-setup-service-origins').textContent()).toContain(SERVICE_ORIGIN);
    // 既定はフォームの送信（今の欄）。スクリプトの送信を選ぶと、フォームの送信先の欄が消え、スクリプトの欄が出る。
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(1);
    expect(await page.getByTestId('auth-setup-script').count()).toBe(0);
    await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).check();
    await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
    expect(await page.getByTestId('auth-setup-script-method').textContent()).toContain(scriptText.setup.methodFixedValue);

    await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
    await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
    await field(page, authText.excludedPaths).fill(LOGOUT_PATH);
    await field(page, scriptText.setup.scriptOrigin).selectOption(SERVICE_ORIGIN);
    await field(page, scriptText.setup.scriptPath).fill(TOKEN_PATH);
    await page.getByRole('button', { name: scriptText.setup.addQuery }).click();
    await field(page, rowLabel(1, scriptText.setup.queryName)).fill('grant_type');
    await field(page, rowLabel(1, scriptText.setup.queryValue)).fill('password');
    await page.getByRole('button', { name: scriptText.setup.addSideRequest }).click();
    await field(page, rowLabel(1, scriptText.setup.sideOrigin)).selectOption(SERVICE_ORIGIN);
    await field(page, rowLabel(1, scriptText.setup.sidePath)).fill(SIDE_PATH);
    await field(page, rowLabel(1, scriptText.setup.sideMaxPerLoginStage)).selectOption(String(SIDE_COUNT));
    await field(page, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
    await field(page, scriptText.setup.storagePrefix).fill('app-');
    await field(page, scriptText.setup.storageSuffix).fill('-auth-token');
    await screenshot(page, 'd03-auth-setup-script-filled');
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });

    const stored = (await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup;
    expect(stored).toMatchObject({
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginTransport: 'SCRIPT_REQUEST',
      loginPostEndpoints: [],
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', maxPerLoginStage: SIDE_COUNT }],
      successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
      successCondition: { pathPrefix: ADMIN_PATH, selector: null },
    });

    const reopened = await openAuthSetup(SCRIPT_PROFILE);
    expect(await reopened.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
    expect(await field(reopened, scriptText.setup.scriptOrigin).inputValue()).toBe(SERVICE_ORIGIN);
    expect(await field(reopened, scriptText.setup.scriptPath).inputValue()).toBe(TOKEN_PATH);
    expect(await field(reopened, rowLabel(1, scriptText.setup.queryName)).inputValue()).toBe('grant_type');
    expect(await field(reopened, rowLabel(1, scriptText.setup.queryValue)).inputValue()).toBe('password');
    expect(await field(reopened, rowLabel(1, scriptText.setup.sideOrigin)).inputValue()).toBe(SERVICE_ORIGIN);
    expect(await field(reopened, rowLabel(1, scriptText.setup.sidePath)).inputValue()).toBe(SIDE_PATH);
    expect(await field(reopened, rowLabel(1, scriptText.setup.sideMaxPerLoginStage)).inputValue()).toBe(String(SIDE_COUNT));
    expect(await field(reopened, scriptText.setup.storageOrigin).inputValue()).toBe(TEST_ORIGIN);
    expect(await field(reopened, scriptText.setup.storagePrefix).inputValue()).toBe('app-');
    expect(await field(reopened, scriptText.setup.storageSuffix).inputValue()).toBe('-auth-token');
    await screenshot(reopened, 'd04-auth-setup-script-reopened');
  }, SCENARIO_TIMEOUT_MS);

  it('puts the version 3 errors on their fields and lines, and saves nothing', async () => {
    const before = (await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt;
    const page = await openAuthSetup(SCRIPT_PROFILE);
    // 必須の query の名前が空、ログインに伴う送信が token の送信先と同じ、鍵の接頭辞と接尾辞が空。
    await field(page, rowLabel(1, scriptText.setup.queryName)).fill(' ');
    await field(page, rowLabel(1, scriptText.setup.sidePath)).fill(TOKEN_PATH);
    await field(page, scriptText.setup.storagePrefix).fill('');
    await field(page, scriptText.setup.storageSuffix).fill('');
    await saveSetup(page);
    expect(await page.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    await expectGroupError(page, 'auth-setup-required-query',
      `${authText.lineText('1')}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_REQUIRED_QUERY_INVALID}`);
    await expectGroupError(page, 'auth-setup-side-requests',
      `${authText.lineText('1')}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED}`);
    await expectFieldError(page, scriptText.setup.storageOrigin, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_STORAGE_KEY_INVALID);
    await screenshot(page, 'd05-auth-setup-script-errors');

    // T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルでは、token の送信先を空にしても、要る項目の欠けにならない（手動のログインの後に自動で
    // 登録される。自動ログインのプロファイルは今どおり欠けにする: `tests/unit/control-auth-setup-v3.test.ts`）。ここでは鍵の誤りも入れて、保存させない。
    const second = await openAuthSetup(SCRIPT_PROFILE);
    await field(second, scriptText.setup.scriptOrigin).selectOption('');
    await field(second, scriptText.setup.scriptPath).fill('');
    await second.getByRole('button', { name: rowLabel(1, scriptText.setup.removeQuery) }).click();
    await field(second, scriptText.setup.storagePrefix).fill('');
    await field(second, scriptText.setup.storageSuffix).fill('');
    await saveSetup(second);
    expect(await second.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    await expectFieldError(second, scriptText.setup.storageOrigin, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_STORAGE_KEY_INVALID);
    expect(await field(second, scriptText.setup.scriptOrigin).getAttribute('aria-invalid')).toBe('false');
    expect(await second.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBe(0);

    // フォームの送信に戻して送信先を空にすると、版 3 のフォームの送信の送信先の欠け（送信先の欄）。
    const third = await openAuthSetup(SCRIPT_PROFILE);
    await third.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).check();
    expect(await third.getByTestId('auth-setup-script').count()).toBe(0);
    await field(third, authText.loginPostEndpoints).fill('');
    await saveSetup(third);
    await expectFieldError(third, authText.loginPostEndpoints, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED);
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt).toBe(before);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the saved origin that the profile no longer approves, and puts SERVICE_ORIGIN_NOT_APPROVED on it', async () => {
    const page = await authSetupPageOf(SCRIPT_PROFILE);
    const detail = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE });
    // テストだけの操作: プロファイルの承認したサービスの Origin から、保存した token の送信先の Origin を外す。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocumentOf(SCRIPT_PROFILE, detail.profile.targetConfigPath, page.profile.revision + 1, [OTHER_SERVICE_ORIGIN]),
      expectedRevision: page.profile.revision,
    })).toMatchObject({ ok: true });
    const screen = await openAuthSetup(SCRIPT_PROFILE);
    expect(await field(screen, scriptText.setup.scriptOrigin).inputValue()).toBe(SERVICE_ORIGIN);
    await field(screen, rowLabel(1, scriptText.setup.sideOrigin)).selectOption(OTHER_SERVICE_ORIGIN);
    await saveSetup(screen);
    await expectFieldError(screen, scriptText.setup.scriptOrigin, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED);
    // 承認している Origin を選び直すと、保存できる。
    await field(screen, scriptText.setup.scriptOrigin).selectOption(OTHER_SERVICE_ORIGIN);
    await saveSetup(screen);
    await screen.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toMatchObject({ scriptLogin: { origin: OTHER_SERVICE_ORIGIN } });
  }, SCENARIO_TIMEOUT_MS);

  it('rejects saving a version 2 setup, and saves a setup of the form navigation as version 3 (LG-3)', async () => {
    const configPath = `config/targets/${LEGACY_PROFILE}.json`;
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(LEGACY_PROFILE, configPath, 1, []) })).toMatchObject({ ok: true });
    // テストだけの操作: 版 2 の設定を保存しようとする（前の版の画面で保存したものの代わり）。保存の部品が形の誤りで拒む。
    const legacy = {
      schemaVersion: 'beaksight-auth-setup/2',
      profileId: LEGACY_PROFILE,
      profileRevision: 1,
      loginStartUrl: `${TEST_ORIGIN}/login`,
      loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
      successCondition: { pathPrefix: ADMIN_PATH, selector: '#menu' },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [LOGOUT_PATH],
      auditPathPrefixes: [ADMIN_PATH],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    };
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: legacy })).toMatchObject({ ok: false });
    expect((await authSetupPageOf(LEGACY_PROFILE)).stored).toBeNull();
    // 同じ項目の版 3（フォームの送信）は保存でき、画面はフォームの送信のまま開く。
    const current = { ...legacy, schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, loginTransport: 'FORM_NAVIGATION', scriptLogin: null, loginSideRequests: [], successStorageKey: null };
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: current })).toMatchObject({ ok: true });
    const page = await openAuthSetup(LEGACY_PROFILE);
    expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).isChecked()).toBe(true);
    expect(await field(page, authText.loginPostEndpoints).inputValue()).toBe(`${TEST_ORIGIN}/login`);
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(LEGACY_PROFILE)).stored?.setup).toEqual(current);
  }, SCENARIO_TIMEOUT_MS);

  it('rejects a secret-like query name, and the value is in no Server Function response nor in the control data', async () => {
    const page = await openAuthSetup(SCRIPT_PROFILE);
    await field(page, rowLabel(1, scriptText.setup.queryName)).fill('client_secret');
    await field(page, rowLabel(1, scriptText.setup.queryValue)).fill(SECRET_MARKER);
    await saveSetup(page);
    await expectGroupError(page, 'auth-setup-required-query',
      `${authText.lineText('1')}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SECRET_LIKE_VALUE}`);
    await authSetupPageOf(SCRIPT_PROFILE);
    await expect.poll(() => responseBodies.length, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
    expect(responseBodies.filter((body) => body.includes(SECRET_MARKER))).toEqual([]);
    expect(placesWithMarkers(databaseFilePlaces(resolveControlDatabasePath(rootOf().root)), [SECRET_MARKER])).toEqual([]);
    // 画面の HTML に、Cookie の値が出ない。
    expect(await page.content()).not.toContain(cookie.slice(cookie.indexOf('=') + 1));
  }, SCENARIO_TIMEOUT_MS);
});

describe('T34e: the requests blocked in the login stage on the job detail', () => {
  it('shows the table of the blocked requests, the counts, the hidden path, the unlisted requests and the guidance', async () => {
    const configPath = `config/targets/${JOB_PROFILE}.json`;
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(JOB_PROFILE, configPath, 1, [SERVICE_ORIGIN]) })).toMatchObject({ ok: true });
    const summary: AuditJobLoginStageSummary = {
      scriptLogin: {
        tokenRequestsAllowed: 1,
        sideRequestsAllowed: [SIDE_COUNT],
        serviceOriginReads: 3,
        blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [
          // T36R-fix（T36R の M-7）: 資格情報を含む要求を止めた数（2）は、止めた読み取りでない送信の数に足さず、独立の欄に出す。
          reason, reason === 'UNREGISTERED_NON_READ' ? 4 : reason === 'TOKEN_REQUEST_QUERY_MISMATCH' ? 1
            : reason === WORKER_LOGIN_CREDENTIAL_BLOCK_REASON ? CREDENTIAL_BLOCKED_COUNT : 0,
        ])) as NonNullable<AuditJobLoginStageSummary['scriptLogin']>['blockedByReason'],
      },
      blockedRequests: {
        requests: [
          { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 3 },
          { origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'TOKEN_REQUEST_QUERY_MISMATCH', count: 1 },
          { origin: SERVICE_ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, resourceType: 'document', reason: 'UNREGISTERED_NON_READ', count: 1 },
        ],
        unlisted: 1,
      },
    };
    // テストだけの操作: ログインの段で止まったジョブの行を書く（ワーカーの代わり）。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, {
        jobId: JOB_ID, jobKind: 'AUDIT', profileId: JOB_PROFILE, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT,
      }, () => null)).toEqual({ ok: true });
      expect(recordAuthState(database, JOB_ID, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
      expect(recordEnded(database, JOB_ID, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
    } finally {
      closeControlDatabase(database);
    }

    const page = await openPage(`/jobs/${JOB_ID}`);
    const panel = page.getByTestId('job-login-stage');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    const text = LOCAL_UI_LOGIN_STAGE_TEXT;
    expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
    // 表の見出しと行（Origin、パス、種類、理由、回数）。
    const table = panel.getByRole('table');
    // T43d（意図して直した期待。Task 43 の設計書 4.4）: query の名前の列と、登録の列（「登録する」か、手で入れる案内）を足した。
    const observedText = LOCAL_UI_LOGIN_OBSERVATION_TEXT;
    expect(await table.locator('thead th').allTextContents()).toEqual([
      text.columns.origin, text.columns.path, text.columns.resourceType, text.columns.reason, text.columns.count,
      observedText.columns.query, observedText.columns.register,
    ]);
    const rows = await table.locator('tbody tr').evaluateAll((elements) =>
      elements.map((element) => [...element.querySelectorAll('td')].map((cell) => cell.textContent ?? '')));
    expect(rows).toEqual([
      [SERVICE_ORIGIN, '/rest/v1/rpc/log_login', 'fetch', LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ, formatTimes(3),
        // FM-1（意図して直した期待。手動の操作を減らす設計書 2.1）: 「登録する」はその場で保存するボタンになり、下書きのリンクは「認証の設定の画面で直す」。
        observedText.noQuery, `${observedText.register}${observedText.registerSideRequest}${LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT.editDraft}`],
      [SERVICE_ORIGIN, TOKEN_PATH, 'fetch', LOGIN_STAGE_BLOCK_REASON_LABELS.TOKEN_REQUEST_QUERY_MISMATCH, formatTimes(1),
        observedText.noQuery, observedText.manualAlreadyRegistered],
      // 値に見える区切りを伏せた path は、伏せた旨を添える（登録の案は作らない）。
      [SERVICE_ORIGIN, `/session/${REDACTED_PATH_SEGMENT}${text.redactedPathNote}`, 'document', LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ,
        formatTimes(1), observedText.noQuery, observedText.manualRedactedPath],
    ]);
    expect(await panel.getByTestId('job-login-stage-unlisted').textContent()).toBe(text.unlisted(formatCount(1)));
    // 数のまとめ（スクリプトで送るログイン）。
    const counts = await panel.getByTestId('job-login-stage-counts').textContent();
    for (const part of [text.tokenRequestsAllowed, formatTimes(1), text.sideRequestsAllowed, formatTimes(SIDE_COUNT), text.serviceOriginReads,
      formatTimes(3), text.blockedTotal, formatTimes(5)]) {
      expect(counts).toContain(part);
    }
    // T36R-fix（T36R の M-7）: 「資格情報を含む要求を止めた数」は独立の欄（見出しと値の組）。
    const facts = await panel.getByTestId('job-login-stage-counts').evaluate((list) =>
      [...list.querySelectorAll('dt')].map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
    expect(facts).toContainEqual([text.credentialRequestsBlocked, formatTimes(CREDENTIAL_BLOCKED_COUNT)]);
    expect(facts).toContainEqual([text.blockedTotal, formatTimes(5)]);
    expect(await panel.getByTestId('job-login-stage-guidance').textContent()).toBe(text.guidance);
    expect(await panel.getByRole('link', { name: text.openSetup }).getAttribute('href')).toBe(`/auth-setup/${JOB_PROFILE}`);
    await screenshot(page, 'e01-job-login-stage-blocked');
  }, SCENARIO_TIMEOUT_MS);
});

// T35d（Task 35 の設計書 3.1）: スクリプトの送信のときだけ、監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限の欄が出る。
describe('T35d: the audit stage items of the script login setup', () => {
  const auditText = LOCAL_UI_SPA_AUDIT_TEXT.setup;
  const READ_PATH = '/rest/v1/rpc/list_items';
  const READ_COUNT = 3;
  const PER_MINUTE = 30;

  it('saves the audit read requests and the service request limits (an empty limit is the maximum), and shows the same values after reopening', async () => {
    // T34d の場面の後の、項目のない設定（項目を足さない保存では、項目を持たない）。
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).not.toHaveProperty('auditReadRequests');
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).not.toHaveProperty('serviceRequestLimits');
    const page = await openAuthSetup(SCRIPT_PROFILE);
    await page.getByTestId('auth-setup-audit-reads').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-audit-reads').textContent()).toContain(auditText.auditReadsJudgement);
    await page.getByRole('button', { name: auditText.addRead }).click();
    await field(page, rowLabel(1, auditText.readOrigin)).selectOption(OTHER_SERVICE_ORIGIN);
    await field(page, rowLabel(1, auditText.readPath)).fill(READ_PATH);
    await field(page, rowLabel(1, auditText.readMaxPerPageLoad)).selectOption(String(READ_COUNT));
    expect(await page.getByTestId('auth-setup-audit-read-row').first().textContent()).toContain(scriptText.setup.methodFixedValue);
    await field(page, auditText.perMinute).fill(String(PER_MINUTE));
    await screenshot(page, 'e01-auth-setup-audit-reads');
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toMatchObject({
      auditReadRequests: [{ origin: OTHER_SERVICE_ORIGIN, path: READ_PATH, method: 'POST', maxPerPageLoad: READ_COUNT }],
      serviceRequestLimits: { perMinute: PER_MINUTE, perRun: MAX_SERVICE_REQUESTS_PER_RUN },
    });
    const reopened = await openAuthSetup(SCRIPT_PROFILE);
    expect(await field(reopened, rowLabel(1, auditText.readOrigin)).inputValue()).toBe(OTHER_SERVICE_ORIGIN);
    expect(await field(reopened, rowLabel(1, auditText.readPath)).inputValue()).toBe(READ_PATH);
    expect(await field(reopened, rowLabel(1, auditText.readMaxPerPageLoad)).inputValue()).toBe(String(READ_COUNT));
    expect(await field(reopened, auditText.perMinute).inputValue()).toBe(String(PER_MINUTE));
    expect(await field(reopened, auditText.perRun).inputValue()).toBe(String(MAX_SERVICE_REQUESTS_PER_RUN));
  }, SCENARIO_TIMEOUT_MS);

  it('puts the duplicated read and the limit beyond the maximum on their fields, and saves nothing', async () => {
    const before = (await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt;
    const page = await openAuthSetup(SCRIPT_PROFILE);
    await page.getByRole('button', { name: auditText.addRead }).click();
    await field(page, rowLabel(2, auditText.readOrigin)).selectOption(OTHER_SERVICE_ORIGIN);
    await field(page, rowLabel(2, auditText.readPath)).fill(READ_PATH);
    await saveSetup(page);
    await expectGroupError(page, 'auth-setup-audit-reads',
      `${authText.lineText('2')}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED}`);
    // 上限の範囲の誤りは、検証の owner が中身の確かめの前に返す（重なりと同時には出ない）ので、重なりを消してから確かめる。
    await page.getByRole('button', { name: rowLabel(2, auditText.removeRead) }).click();
    await field(page, auditText.perMinute).fill(String(MAX_SERVICE_REQUESTS_PER_MINUTE + 1));
    await saveSetup(page);
    await expectFieldError(page, auditText.perMinute, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_LIMIT_EXCEEDED);
    await screenshot(page, 'e02-auth-setup-audit-reads-errors');
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt).toBe(before);
  }, SCENARIO_TIMEOUT_MS);

  it('does not show the audit stage items for the form navigation', async () => {
    const page = await openAuthSetup(SCRIPT_PROFILE);
    await page.getByTestId('auth-setup-audit-reads').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).check();
    expect(await page.getByTestId('auth-setup-audit-reads').count()).toBe(0);
    expect(await field(page, auditText.perMinute).count()).toBe(0);
    expect(await field(page, auditText.perRun).count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});

describe('T36a: the login transport of an automated login profile', () => {
  it('lets an automated login profile choose the script login, and saves it as version 3 with the automated login settings', async () => {
    const configPath = `config/targets/${AUTO_PROFILE}.json`;
    const profile = { ...profileDocumentOf(AUTO_PROFILE, configPath, 1, [SERVICE_ORIGIN]), auth: 'AUTOMATED_LOGIN' };
    expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
    const page = await openAuthSetup(AUTO_PROFILE);
    // 自動ログインの欄と、ログインの送り方の欄の両方がある（既定はフォームの送信）。
    await page.getByTestId('auth-setup-automated').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-transport').count()).toBe(1);
    expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).isChecked()).toBe(true);
    await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).check();
    await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);

    await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
    await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
    await field(page, scriptText.setup.scriptOrigin).selectOption(SERVICE_ORIGIN);
    await field(page, scriptText.setup.scriptPath).fill(TOKEN_PATH);
    await page.getByRole('button', { name: scriptText.setup.addQuery }).click();
    await field(page, rowLabel(1, scriptText.setup.queryName)).fill('grant_type');
    await field(page, rowLabel(1, scriptText.setup.queryValue)).fill('password');
    await field(page, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
    await field(page, scriptText.setup.storagePrefix).fill('app-');
    await field(page, scriptText.setup.storageSuffix).fill('-auth-token');
    await field(page, authText.usernameSelector).fill('#email');
    await field(page, authText.passwordSelector).fill('#password');
    await field(page, authText.submitSelector).fill('#login');
    await screenshot(page, 'e02-auth-setup-automated-script');
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });

    expect((await authSetupPageOf(AUTO_PROFILE)).stored?.setup).toMatchObject({
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginTransport: 'SCRIPT_REQUEST',
      loginPostEndpoints: [],
      maxLoginAttempts: 1,
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
      automatedLogin: { usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login' },
    });
    const reopened = await openAuthSetup(AUTO_PROFILE);
    expect(await reopened.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
  }, SCENARIO_TIMEOUT_MS);
});
