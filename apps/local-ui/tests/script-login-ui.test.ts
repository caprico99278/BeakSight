/**
 * スクリプトで送るログインの画面（T34d。Task 34 の設計書 3.1、3.2、3.6）を、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。
 * - プロファイルの画面: 「承認したサービスの Origin」の欄は、テスト環境の 2 つのモードだけ出る。誤り（形の誤り、テスト環境の Origin との重なり）は、
 *   その欄に出る。保存すると、プロファイルの項目になる。
 * - 認証の設定の画面: ログインの送り方でスクリプトの送信を選ぶと、フォームの送信先の欄が消え、token の送信先（Origin は承認したサービスの Origin から
 *   選ぶ）・必須の query の組・ログインに伴う送信の一覧・成功のローカル ストレージの鍵の形の欄が出る。保存すると版 3 の設定になり、読み直すと同じ値。
 *   PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: token の送信先・必須の query・ログインに伴う送信は、設定がないときも読むだけ
 *   （手で入れない。観察が入れる）。入口の確かめの案がないときの既定の送り方は、送信先のない形（スクリプトの送信）。
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
import { GENERATED_TARGET_CRAWL_LIMITS } from '../../../src/config/target-config-draft.js';
import { REDACTED_PATH_SEGMENT } from '../../../src/core/url-path-redaction.js';
import { formatCount, formatTimes } from '../../../src/presentation/format.js';
import { LOGIN_TRANSPORT_CATALOG, REQUEST_RESOURCE_TYPE_LABELS } from '../../../src/presentation/catalog.js';
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
import { REMOVED_ADD_BUTTON_LABELS, openAuthSetupAdvancedSettings, openProfileAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
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
import { openProfileAdvancedSettings } from './helpers/profile-form.ts';
import { createProfileInStore, updateProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';

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
/** MI-F5: 版 3 の誤りの表示を、欄を手で入れられる新しい設定で確かめるプロファイル（認証の設定を保存しない）。 */
const ERRORS_PROFILE = 't34d-errors';
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
  await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
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
  writeAuthTargetConfig(root.root, ERRORS_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
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

// MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2・4.9。T34d の欄の手順を 4.2 の形に直した）: 承認したサービスの Origin は、
// 利用者が知りえないので画面から足さない（手動のログインの観察だけが足す）。作成の画面には欄を出さず（詳しい設定の中にも）、プロファイルの詳細の編集
// （詳しい設定）では、読むだけの一覧と「消す」だけにする。監査の対象の Origin が入っているときの拒否の文は、4.9 の形で一覧に出す。
describe('T34d: the approved service origins on the profile screen', () => {
  it('has no field on the creation screen, lists the origins read-only with "remove" on the edit screen, and saves the removal', async () => {
    const configPath = `config/targets/${SCRIPT_PROFILE}.json`;
    const thirdServiceOrigin = 'https://third-service.example.invalid';
    // 作成の画面: どの使い方でも、承認したサービスの Origin の欄はない。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面の見える
    // 入力は開始のアドレス・使い方・保存だけで、たたんだ詳しい設定（前は監査モードを選んで確かめた）もない。
    const create = await openPage('/profiles/new');
    await field(create, profileText.startUrl).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await create.locator('main details').count()).toBe(0);
    for (const usage of [profileText.usageTestAuth, profileText.usagePublic]) {
      await field(create, usage).check();
      expect(await create.locator('[name="approvedServiceOrigins"]').count(), usage).toBe(0);
      expect(await create.getByText(scriptText.profile.approvedServiceOrigins).count(), usage).toBe(0);
    }
    // プロファイルは Server Function で作る（作成の画面でテスト環境を保存すると、入口の確かめが TEST_ORIGIN へ接続するため。作成の画面の保存は
    // `start-url-onboarding-ui.test.ts`）。手動のログインの観察の代わりに、承認したサービスの Origin を Server Function で足す（テストだけの操作）。
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(SCRIPT_PROFILE, configPath, 1, []) })).toMatchObject({ ok: true });
    // MI-F1（設計書 4.7.1 の 1）: 画面の編集の口は承認したサービスの Origin を足さないので、テストの準備は保存の部品で直接更新する。
    expect(await updateProfileInStore(rootOf().root, profileDocumentOf(SCRIPT_PROFILE, configPath, 2, [SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN, thirdServiceOrigin]), 1))
      .toMatchObject({ ok: true });

    // 編集（詳しい設定の中）: 読むだけの一覧と「消す」。足す欄はない。
    const page = await openPage(`/profiles/${SCRIPT_PROFILE}`);
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    const list = page.getByTestId('profile-service-origins');
    await list.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await list.locator('code').allTextContents()).toEqual([SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN, thirdServiceOrigin]);
    expect(await list.locator('input, textarea, select').count()).toBe(0);
    expect(await page.locator('[name="approvedServiceOrigins"]').count()).toBe(0);
    expect(await list.textContent()).toContain(scriptText.profile.approvedServiceOriginsHint);
    await screenshot(page, 'd01-profile-service-origins-list');
    await list.getByRole('button', { name: scriptText.profile.removeServiceOriginLabel(thirdServiceOrigin) }).click();
    await expect.poll(() => list.locator('code').allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN]);
    await page.getByRole('button', { name: profileText.save }).click();
    await page.getByText(profileText.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    const detail = await valueOf<{ profile: { revision: number; approvedServiceOrigins?: readonly string[] } }>(
      'getProfileFn', 'GET', { profileId: SCRIPT_PROFILE },
    );
    expect(detail.profile).toMatchObject({ revision: 3, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN] });

    // 監査の対象の Origin（設定のファイルの allowedOrigins）に入るサービスの Origin は拒み、4.9 の形の文を一覧に出す（ここでは、サービスの Origin を
    // 監査の対象に含む設定のファイルへ切り替えて、重なりを作る。loopback でない Origin なので、読み込みの間隔は作るファイルの控えめな値にする）。
    writeAuthTargetConfig(rootOf().root, 't34d-service-site', SERVICE_ORIGIN, ADMIN_PATH, MAX_PAGES, GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs);
    const reopened = await openPage(`/profiles/${SCRIPT_PROFILE}`);
    await openProfileAdvancedSettings(reopened, UI_TIMEOUT_MS);
    await field(reopened, profileText.targetConfigPath).selectOption('config/targets/t34d-service-site.json');
    await reopened.getByRole('button', { name: profileText.save }).click();
    const reopenedList = reopened.getByTestId('profile-service-origins');
    await reopenedList.locator('.field-error').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reopenedList.locator('.field-error').textContent())
      .toContain(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_SERVICE_ORIGIN_INSIDE_TARGET);
    expect(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_SERVICE_ORIGIN_INSIDE_TARGET)
      .toContain('手でログインすると、ログインの先のサイトのアドレスが自動で入ります');
    await screenshot(reopened, 'd02-profile-service-origin-error');
    expect((await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE })).profile.revision).toBe(3);
  }, SCENARIO_TIMEOUT_MS);
});

describe('T34d: the version 3 auth setup screen (the script login)', () => {
  // MI-F5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6・7。T34d の手で入れる手順を直した）: ログインの送信先（token の送信先、必須の
  // query、ログインに伴う送信）は、入口の確かめと手動のログインの観察からだけ入る。認証の設定がまだない画面でスクリプトの送信の欄を出し、手で入れた送信先の最初の
  // 保存は拒む。観察の後の形の設定（テストの準備。保存の部品で直接）は、読み直すと送信先を読むだけで出し、送信先でない欄（成功の鍵）は入力の欄のまま。
  // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8。MI 4.7.1 の 6 の持ち越し。この場面の手で入れる手順を直した）: 入口の確かめの案がない
  // ときの既定の送り方は、送信先のない形（スクリプトの送信）。token の送信先・必須の query・ログインに伴う送信は、設定がないときも入力の欄を出さず、読むだけで出す。
  // 手で入れた送信先の最初の保存の拒否は、画面の保存の Server Function へ、前に欄で入れていた値を直接送って確かめる。
  it('shows the script login fields for a new setup, rejects the destination typed by hand, and shows the observed setup read-only after reopening', async () => {
    const page = await openAuthSetup(SCRIPT_PROFILE);
    // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章・3 章の 2。前はサイトの値の表に承認したサービスの Origin の一覧を出していた）: Origin の一覧は
    // 画面に出さない（プロファイルの値で確かめる）。
    expect(await page.getByTestId('auth-setup-service-origins').count()).toBe(0);
    expect((await authSetupPageOf(SCRIPT_PROFILE)).profile.approvedServiceOrigins).toContain(SERVICE_ORIGIN);
    // 既定はスクリプトの送信（送信先のない形）。フォームの送信先の欄はなく、スクリプトの欄が出る。
    expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
    await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
    // PL-4（同 3 章の 3。前は送信の method の固定と、token の送信先・必須の query・ログインに伴う送信を読むだけの値で出していた）: どれも出さない（直せない
    // 欄を見せない。入るのは手動のログインの観察からだけ）。入力の欄も、足すボタンもない。
    expect(await page.getByTestId('auth-setup-script-method').count()).toBe(0);
    for (const name of ['scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0']) {
      expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
    }
    // OP-DEF の 5: 足すボタンの文言はカタログから消した（使い先がない）。前の名前のボタンが出ないことは、今も確かめる。
    for (const label of REMOVED_ADD_BUTTON_LABELS) {
      expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
    }
    for (const testId of ['auth-setup-destination-script-origin', 'auth-setup-destination-script-path', 'auth-setup-destination-required-query',
      'auth-setup-destination-side-requests']) {
      expect(await page.getByTestId(testId).count(), testId).toBe(0);
    }
    // 送信先でない欄（成功の鍵）は、入力の欄のまま。
    expect(await field(page, scriptText.setup.storageOrigin).count()).toBe(1);
    await screenshot(page, 'd03-auth-setup-script-new');

    // 手で入れた送信先（前は欄で入れた値）の最初の保存は、画面の保存の Server Function でも拒む（入口の確かめの案がないので、送信先のない形だけを受ける）。
    const revision = (await authSetupPageOf(SCRIPT_PROFILE)).profile.revision;
    const observed = {
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId: SCRIPT_PROFILE,
      profileRevision: revision,
      loginStartUrl: `${TEST_ORIGIN}/login`,
      loginPostEndpoints: [],
      successCondition: { pathPrefix: ADMIN_PATH, selector: null },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [LOGOUT_PATH],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', maxPerLoginStage: SIDE_COUNT }],
      successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
    };
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: observed })).toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_OBSERVED_ONLY' });
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored).toBeNull();

    // テストの準備: 手動のログインの観察の後の形の設定を、保存の部品で直接保存する。
    expect(await saveAuthSetupRequestInStore(root, { setup: observed })).toMatchObject({ ok: true });

    const reopened = await openAuthSetup(SCRIPT_PROFILE);
    // PL-4（同 3 章の 3。前は送り方と送信先を読むだけの値で出していた）: 変えられない送り方と送信先は出さない。値は、下の保存の後の設定が観察の値のままで
    // あることで確かめる。
    expect(await reopened.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).count()).toBe(0);
    expect(await reopened.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
    expect(await reopened.getByRole('main').innerText()).not.toContain(TOKEN_PATH);
    expect(await field(reopened, scriptText.setup.storageOrigin).inputValue()).toBe(TEST_ORIGIN);
    expect(await field(reopened, scriptText.setup.storagePrefix).inputValue()).toBe('app-');
    expect(await field(reopened, scriptText.setup.storageSuffix).inputValue()).toBe('-auth-token');
    // 送信先でない欄の保存は受け、保存した設定は版 3 のスクリプトの送信のまま。
    await saveSetup(reopened);
    await reopened.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toEqual(observed);
    await screenshot(reopened, 'd04-auth-setup-script-reopened');
  }, SCENARIO_TIMEOUT_MS);

  // MI-F5: 版 3 の誤りの表示は、欄を手で入れられる新しい設定（認証の設定のない別のプロファイル）で確かめる。検証の誤りは、送信先の確かめより先に返る。
  // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: 必須の query とログインに伴う送信は、画面で手で入れなくなった（読むだけ）。その行の
  // 誤り（名前の空、token の送信先との重なり）の位置は、画面の保存の Server Function へ直接送って、検証の owner が返す項目と行で確かめる。
  it('puts the version 3 errors on their fields and lines, and saves nothing', async () => {
    const configPath = `config/targets/${ERRORS_PROFILE}.json`;
    expect(await createProfileInStore(rootOf().root, profileDocumentOf(ERRORS_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
    const fillScript = async (page: Page): Promise<void> => {
      // PL-S: 入口の確かめの案がないので、既定がスクリプトの送信（送信先のない形）。
      expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
      await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
      await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
      await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
      await field(page, authText.excludedPaths).fill(LOGOUT_PATH);
    };
    // 必須の query の名前が空、ログインに伴う送信が token の送信先と同じ（画面の保存の Server Function へ直接。何も保存しない）。
    const revision = (await authSetupPageOf(ERRORS_PROFILE)).profile.revision;
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: {
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        profileId: ERRORS_PROFILE,
        profileRevision: revision,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [],
        successCondition: { pathPrefix: ADMIN_PATH, selector: null },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [LOGOUT_PATH],
        auditPathPrefixes: [],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: ' ', value: 'password' }] },
        loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TOKEN_PATH, method: 'POST', maxPerLoginStage: 1 }],
        successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
      },
    })).toMatchObject({
      ok: false,
      reason: 'AUTH_SETUP_INVALID',
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'AUTH_SETUP_REQUIRED_QUERY_INVALID', field: 'requiredQuery', line: 1 }),
        expect.objectContaining({ code: 'AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED', field: 'loginSideRequests', line: 1 }),
      ]),
    });
    expect((await authSetupPageOf(ERRORS_PROFILE)).stored).toBeNull();

    // T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルでは、token の送信先が空でも、要る項目の欠けにならない（手動のログインの後に自動で
    // 登録される。自動ログインのプロファイルは今どおり欠けにする: `tests/unit/control-auth-setup-v3.test.ts`）。ここでは鍵の誤り（接頭辞と接尾辞が空）を入れて、
    // 保存させない。
    const second = await openAuthSetup(ERRORS_PROFILE);
    await fillScript(second);
    await field(second, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
    await saveSetup(second);
    expect(await second.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    await expectFieldError(second, scriptText.setup.storageOrigin, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_STORAGE_KEY_INVALID);
    expect(await second.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBe(0);
    await screenshot(second, 'd05-auth-setup-script-errors');

    // フォームの送信を選び、送信先を空のまま保存すると、版 3 のフォームの送信の送信先の欠け（送信先の欄）。
    const third = await openAuthSetup(ERRORS_PROFILE);
    await third.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).check();
    expect(await third.getByTestId('auth-setup-script').count()).toBe(0);
    await field(third, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
    await field(third, authText.successPathPrefix).fill(ADMIN_PATH);
    await field(third, authText.loginPostEndpoints).fill('');
    await saveSetup(third);
    await expectFieldError(third, authText.loginPostEndpoints, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED);
    expect((await authSetupPageOf(ERRORS_PROFILE)).stored).toBeNull();
  }, SCENARIO_TIMEOUT_MS);

  // MI-F5: 送信先は読むだけなので、承認から外れた Origin の設定は、画面では選び直さない（誤りの文を出して保存しない）。直すのは観察（ここではテストの準備）。
  it('shows the saved origin that the profile no longer approves, and puts SERVICE_ORIGIN_NOT_APPROVED on it', async () => {
    const page = await authSetupPageOf(SCRIPT_PROFILE);
    const detail = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE });
    // テストだけの操作: プロファイルの承認したサービスの Origin から、保存した token の送信先の Origin を外す。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocumentOf(SCRIPT_PROFILE, detail.profile.targetConfigPath, page.profile.revision + 1, [OTHER_SERVICE_ORIGIN]),
      expectedRevision: page.profile.revision,
    })).toMatchObject({ ok: true });
    const screen = await openAuthSetup(SCRIPT_PROFILE);
    // PL-4: token の送信先は出さない（欄がないので、保存の誤りはフォームの上の知らせに、項目の名前つきで出す）。
    expect(await screen.getByTestId('auth-setup-destination-script-origin').count()).toBe(0);
    await saveSetup(screen);
    expect(await screen.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    const rejectionNotice = await screen.locator('.notice', { has: screen.getByTestId('auth-setup-rejection') }).textContent();
    expect(rejectionNotice).toContain(`${scriptText.setup.scriptOrigin}: `);
    expect(rejectionNotice).toContain(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED);
    // テストの準備: 手動のログインで観察し直した形（承認している Origin への送信先）を、保存の部品で直接保存する。
    const current = (await authSetupPageOf(SCRIPT_PROFILE));
    expect(await saveAuthSetupRequestInStore(root, {
      setup: {
        ...current.stored?.setup,
        profileRevision: current.profile.revision,
        scriptLogin: { origin: OTHER_SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [{ origin: OTHER_SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', maxPerLoginStage: SIDE_COUNT }],
      },
    })).toMatchObject({ ok: true });
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
    // 同じ項目の版 3（フォームの送信）は保存でき（テストの準備。送信先は観察から入る）、画面はフォームの送信のまま開く（送信先は読むだけ）。
    const current = { ...legacy, schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, loginTransport: 'FORM_NAVIGATION', scriptLogin: null, loginSideRequests: [], successStorageKey: null };
    expect(await saveAuthSetupRequestInStore(root, { setup: current })).toMatchObject({ ok: true });
    const page = await openAuthSetup(LEGACY_PROFILE);
    // PL-4: 送り方とフォームの送信先は出さない（保存の後の設定が、そのままであることで確かめる）。
    expect(await page.getByTestId('auth-setup-destination-transport').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-destination-post-endpoints').count()).toBe(0);
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(LEGACY_PROFILE)).stored?.setup).toEqual(current);
  }, SCENARIO_TIMEOUT_MS);

  // MI-F5: 必須の query は画面で手で入れないので、秘密に見える名前の query は、画面の保存の Server Function へ直接送って確かめる（検証が先に拒む）。
  it('rejects a secret-like query name, and the value is in no Server Function response nor in the control data', async () => {
    const stored = await authSetupPageOf(SCRIPT_PROFILE);
    const setup = stored.stored?.setup ?? {};
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: { ...setup, scriptLogin: { origin: OTHER_SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'client_secret', value: SECRET_MARKER }] } },
    })).toMatchObject({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: expect.arrayContaining([{ code: 'AUTH_SETUP_SECRET_LIKE_VALUE', field: 'requiredQuery', line: 1 }]) });
    const page = await openAuthSetup(SCRIPT_PROFILE);
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
    // MI-F1（設計書 4.7.1 の 1）: 承認したサービスの Origin は、画面の作成の口では受けない。テストの準備は、保存の部品で直接作る。
    expect(await createProfileInStore(rootOf().root, profileDocumentOf(JOB_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
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
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: ログインの段の記録は、たたんだ詳しい内容の中。開いてから確かめる。
    await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
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
      [SERVICE_ORIGIN, '/rest/v1/rpc/log_login', REQUEST_RESOURCE_TYPE_LABELS.fetch, LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ, formatTimes(3),
        // FM-1（意図して直した期待。手動の操作を減らす設計書 2.1）: 「登録する」はその場で保存するボタンになり、下書きのリンクは「認証の設定の画面で直す」。
        observedText.noQuery, `${observedText.register}${observedText.registerSideRequest}${LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT.editDraft}`],
      [SERVICE_ORIGIN, TOKEN_PATH, REQUEST_RESOURCE_TYPE_LABELS.fetch, LOGIN_STAGE_BLOCK_REASON_LABELS.TOKEN_REQUEST_QUERY_MISMATCH, formatTimes(1),
        observedText.noQuery, observedText.manualAlreadyRegistered],
      // 値に見える区切りを伏せた path は、伏せた旨を添える（登録の案は作らない）。
      [SERVICE_ORIGIN, `/session/${REDACTED_PATH_SEGMENT}${text.redactedPathNote}`, REQUEST_RESOURCE_TYPE_LABELS.document, LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ,
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

  // MI-F5: 認証の設定があるときは送り方を読むだけなので、フォームの送信の設定のプロファイル（版 2 の場面の後）で確かめる。
  it('does not show the audit stage items for the form navigation', async () => {
    const page = await openAuthSetup(LEGACY_PROFILE);
    // PL-4: 送り方は出さない（フォームの送信の設定であることは、保存した設定で確かめる）。
    expect((await authSetupPageOf(LEGACY_PROFILE)).stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION' });
    expect(await page.getByTestId('auth-setup-audit-reads').count()).toBe(0);
    expect(await field(page, auditText.perMinute).count()).toBe(0);
    expect(await field(page, auditText.perRun).count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});

describe('T36a: the login transport of an automated login profile', () => {
  it('lets an automated login profile choose the script login, and saves it as version 3 with the automated login settings', async () => {
    const configPath = `config/targets/${AUTO_PROFILE}.json`;
    // MI-C2 項目 16・MI-F1（設計書 4.7.1 の 1・2）: 承認したサービスの Origin つきのプロファイルと、自動ログインのプロファイルは、画面の作成・編集の口では
    // 作れない（Origin は手動のログインの観察が足し、自動ログインへは切り替えだけで入る）。テストの準備は、手動のログインのプロファイルを保存の部品で作り
    // （承認したサービスの Origin は、手動のログインの観察の代わりにテストが入れる）、保存の部品で自動ログインに更新する（Origin は足さない）。
    expect(await createProfileInStore(rootOf().root, profileDocumentOf(AUTO_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
    const profile = { ...profileDocumentOf(AUTO_PROFILE, configPath, 2, [SERVICE_ORIGIN]), auth: 'AUTOMATED_LOGIN' };
    expect(await updateProfileInStore(rootOf().root, profile, 1)).toMatchObject({ ok: true });
    const page = await openAuthSetup(AUTO_PROFILE);
    // 自動ログインの欄と、ログインの送り方の欄の両方がある。PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: 入口の確かめの案がないので、
    // 既定はスクリプトの送信（送信先のない形）。token の送信先と必須の query は、読むだけ（手で入れない）。
    await page.getByTestId('auth-setup-automated').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-transport').count()).toBe(1);
    expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
    await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
    expect(await page.locator('[name="scriptOrigin"], [name="scriptPath"]').count()).toBe(0);

    await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
    await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
    await field(page, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
    await field(page, scriptText.setup.storagePrefix).fill('app-');
    await field(page, scriptText.setup.storageSuffix).fill('-auth-token');
    await field(page, authText.usernameSelector).fill('#email');
    await field(page, authText.passwordSelector).fill('#password');
    await field(page, authText.submitSelector).fill('#login');
    await screenshot(page, 'e02-auth-setup-automated-script');
    // 設定のない自動ログインのプロファイル（MI より前の形）の画面の最初の保存は、自動ログインに要る token の送信先がないので、検証が拒む（何も保存しない。
    // token の送信先は観察からだけ入る）。
    await saveSetup(page);
    expect(await page.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
    expect(await page.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBeGreaterThan(0);
    expect((await authSetupPageOf(AUTO_PROFILE)).stored).toBeNull();

    // テストの準備: 切り替えの後の形の設定（自動ログインの設定を持つ版 3 のスクリプトの送信）を、保存の部品で直接保存する。
    const observed = {
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId: AUTO_PROFILE,
      profileRevision: 2,
      loginStartUrl: `${TEST_ORIGIN}/login`,
      loginPostEndpoints: [],
      successCondition: { pathPrefix: ADMIN_PATH, selector: null },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: [],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: {
        usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      },
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [],
      successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
    };
    // MI-F5（設計書 4.7.1 の 6）: 手で入れた送信先（前は欄で入れた値）の最初の保存は、画面の保存の Server Function でも拒む（設定のない自動ログインのプロファイルを含む）。
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: observed })).toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_OBSERVED_ONLY' });
    expect((await authSetupPageOf(AUTO_PROFILE)).stored).toBeNull();
    expect(await saveAuthSetupRequestInStore(root, { setup: observed })).toMatchObject({ ok: true });

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
    // MI-F5・PL-4: 認証の設定があるときは、送り方と自動ログインのセレクタも変えられないので出さない（値は上の保存した設定で確かめた）。
    expect(await reopened.getByTestId('auth-setup-destination-transport').count()).toBe(0);
    expect(await reopened.getByTestId('auth-setup-destination-password-selector').count()).toBe(0);
    expect(await reopened.locator('input[name="passwordSelector"]').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});
