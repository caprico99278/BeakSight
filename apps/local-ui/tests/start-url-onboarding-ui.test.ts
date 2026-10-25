/**
 * T43b（Task 43 の設計書 4.2、5 章の 1・2）: 開始の URL だけを入れてプロファイルを作ると、サーバが対象の設定のファイル
 * `local/targets/<profileId>.json` を作り、プロファイルがそれを指すことの確かめ。ビルドした画面を一時の root の起動の部品で起動し、Playwright の
 * headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。ファイルは一時の root にだけ書く（実際の `local/` に書かない）。
 * - 開始の URL を入れると、プロファイルの ID と許可 Origin の案が埋まり、利用者が ID を直すまで URL に追従する。テストの環境のモードを選ぶと、
 *   テスト環境の Origin に許可 Origin が写る。
 * - 保存すると、ファイルができ（中身は `target.id`・`site`・既定値の負荷と出力）、CLI の `loadConfig` で読める。詳細の「次にすること」から
 *   監査の開始の画面まで、リンクだけで進める（公開のモード。監査は始めない）。
 * - 同じ名前のファイルがあれば上書きせず、誤りにする（プロファイルも作らない）。プロファイルの内容の誤りでは、ファイルを作らない。
 * - 認証の設定の画面は、新しい設定のときだけ、開始の URL の path で監査の path と成功の画面の path を埋める（保存した設定があればその値）。
 * - 「すでにある設定のファイルを使う」流れは今どおり（ファイルを作らない）。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件（どこにも接続しない）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { GENERATED_TARGET_CRAWL_LIMITS } from '../../../src/config/target-config-draft.js';
import { formatDuration, formatInteger } from '../../../src/presentation/format.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  EXAMPLE_TARGET_CONFIG,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { nextStepStatesOf } from './helpers/next-steps.ts';
import { chooseExistingTargetConfig } from './helpers/profile-form.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
const MAX_TAB_PRESSES = 60;

/** テストの値（予約の名前と、使っていない 127.0.0.1 の番号。どこにも接続しない）。 */
const PUBLIC_START_URL = 'https://www.example.test/shop/';
const PUBLIC_PROFILE = 'www-example-test';
const PUBLIC_ORIGIN = 'https://www.example.test';
const TEST_START_URL = 'http://127.0.0.1:9/admin/';
const TEST_ORIGIN = 'http://127.0.0.1:9';
const TEST_PROFILE = 't43b-test-auth';
const START_PATH = '/admin/';
const EXISTS_PROFILE = 't43b-exists';
const INVALID_PROFILE = 't43b-invalid-profile';
const EXISTING_FILE_PROFILE = 't43b-existing-file';
const GENERATED_DIRECTORY = 'local/targets';

const text = LOCAL_UI_TEXT.profileForm;

let root: TemporaryUiRoot | undefined;
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

const rootPath = (): string => root?.root ?? '';

/** 一時の root の中の、作られたファイルのパス。 */
const generatedFileOf = (profileId: string): string => `${rootPath()}/${GENERATED_DIRECTORY}/${profileId}.json`;

const { openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  requireCspRecord: true,
});

/** Server Function を呼び、200 の値を返す。 */
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);
  return result.value as T;
};

/** 作成の画面の欄（ラベルは完全一致で選ぶ。「環境」などはほかのラベルに部分一致するため）。 */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/** 一時の root の `local/targets/` の中の、一時のファイル（書き込みの途中のもの）の名前。 */
const leftoverTemporaryFiles = (): readonly string[] => {
  const directory = `${rootPath()}/${GENERATED_DIRECTORY}`;
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.tmp')) : [];
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
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
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('T43b: creating a profile from the start URL only', () => {
  it('starts with the start URL, fills the id and the allowed origin, and follows the URL until the id is edited', async () => {
    const page = await openPage('/profiles/new');
    const startUrl = field(page, text.startUrl);
    await startUrl.waitFor({ timeout: UI_TIMEOUT_MS });
    // 最初の欄は開始の URL（選び方の既定は「開始の URL から作る」）。設定のファイルの選択の欄は出ない。
    expect(await field(page, text.targetSourceNew).isChecked()).toBe(true);
    expect(await field(page, text.targetConfigPath).count()).toBe(0);
    const firstInput = page.locator('form input:not([type="radio"]), form select, form textarea').first();
    expect(await firstInput.getAttribute('name')).toBe('startUrl');

    await startUrl.fill('https://first.example.test/a/');
    await expect.poll(() => field(page, text.profileId).inputValue(), { timeout: UI_TIMEOUT_MS }).toBe('first-example-test');
    expect(await field(page, text.allowedOrigins).inputValue()).toBe('https://first.example.test');
    // URL を変えると、ID と許可 Origin も追従する。
    await startUrl.fill('https://second.example.test/b/');
    await expect.poll(() => field(page, text.profileId).inputValue(), { timeout: UI_TIMEOUT_MS }).toBe('second-example-test');
    expect(await field(page, text.allowedOrigins).inputValue()).toBe('https://second.example.test');
    // 利用者が ID を直した後は、URL を変えても ID は変わらない（許可 Origin は追従する）。
    await field(page, text.profileId).fill('my-own-id');
    await startUrl.fill('https://third.example.test/');
    await expect.poll(() => field(page, text.allowedOrigins).inputValue(), { timeout: UI_TIMEOUT_MS }).toBe('https://third.example.test');
    expect(await field(page, text.profileId).inputValue()).toBe('my-own-id');

    // 受けない開始の URL は、保存の前に欄の誤りになる（何も送らない）。
    await startUrl.fill('https://third.example.test/#top');
    await page.getByRole('button', { name: text.save }).click();
    await page.getByText(TARGET_SITE_PROBLEM_DESCRIPTIONS.START_URL_HAS_FRAGMENT).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await startUrl.getAttribute('aria-invalid')).toBe('true');
    expect(existsSync(generatedFileOf('my-own-id'))).toBe(false);
  });

  it('saves with the start URL only, writes local/targets/<id>.json, and reaches the start screen by links (public mode)', async () => {
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(PUBLIC_START_URL);
    await expect.poll(() => field(page, text.profileId).inputValue(), { timeout: UI_TIMEOUT_MS }).toBe(PUBLIC_PROFILE);
    // 保存すると作るファイルの場所を示す。
    await page.getByTestId('generated-target-config-path').filter({ hasText: `${GENERATED_DIRECTORY}/${PUBLIC_PROFILE}.json` })
      .waitFor({ timeout: UI_TIMEOUT_MS });
    // T43b fix round 2: 最初は 3 ページ・10 秒間隔で作り、広げるときはファイルを直すことを示す（文言はカタログ）。
    expect(await page.getByTestId('generated-target-config-note').textContent()).toBe(text.generatedTargetConfigNote(
      formatInteger(GENERATED_TARGET_CRAWL_LIMITS.maxPages),
      formatDuration(GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs),
    ));
    await page.getByRole('button', { name: text.save }).click();
    await page.waitForURL(new RegExp(`/profiles/${PUBLIC_PROFILE}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByText(text.created).waitFor({ timeout: UI_TIMEOUT_MS });

    // ファイル: 中身は target.id・site・負荷と出力。負荷は最初の読み込みのための控えめな値（最大 3 ページ、間隔 10 秒。T43b fix round 2）で、
    // ほかの負荷と出力は既定値。CLI の loadConfig で読める。一時のファイルは残らない。
    const path = generatedFileOf(PUBLIC_PROFILE);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      target: { id: PUBLIC_PROFILE },
      site: { startUrl: PUBLIC_START_URL, allowedOrigins: [PUBLIC_ORIGIN] },
      crawl: { ...DEFAULT_CONFIG.crawl, maxPages: 3, minNavigationIntervalMs: 10_000 },
      output: DEFAULT_CONFIG.output,
    });
    const loaded = await loadConfig(path);
    expect(loaded.site).toEqual({ startUrl: PUBLIC_START_URL, allowedOrigins: [PUBLIC_ORIGIN] });
    expect([loaded.crawl.maxPages, loaded.crawl.minNavigationIntervalMs]).toEqual([3, 10_000]);
    expect(leftoverTemporaryFiles()).toEqual([]);

    // プロファイルは作ったファイルを指す。
    const saved = await valueOf<{ profile: { targetConfigPath: string; environment: string; mode: string } }>(
      'getProfileFn', 'GET', { profileId: PUBLIC_PROFILE },
    );
    expect(saved.profile).toMatchObject({ targetConfigPath: `${GENERATED_DIRECTORY}/${PUBLIC_PROFILE}.json`, environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE' });

    // 詳細の「次にすること」→ 監査の開始の画面（リンクだけ、キーボードで）。
    expect(await nextStepStatesOf(page, UI_TIMEOUT_MS)).toEqual(['NOT_NEEDED', 'NOT_NEEDED', 'NOT_NEEDED', 'NEEDED']);
    await tabTo(page, page.getByTestId('profile-audit-start').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/start/${PUBLIC_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('start-target').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('start-target').textContent()).toContain(PUBLIC_START_URL);
    // 開始の画面にも、作ったファイルの間隔（10 秒）が出る。
    expect(await page.getByTestId('start-interval').textContent()).toBe(formatDuration(10_000));
  });

  it('does not overwrite a file with the same name, and does not create the profile', async () => {
    mkdirSync(`${rootPath()}/${GENERATED_DIRECTORY}`, { recursive: true });
    const existing = `${JSON.stringify({ target: { id: EXISTS_PROFILE }, site: { startUrl: 'https://kept.example.test/', allowedOrigins: ['https://kept.example.test'] } })}\n`;
    writeFileSync(generatedFileOf(EXISTS_PROFILE), existing, 'utf8');

    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill('https://new.example.test/');
    await field(page, text.profileId).fill(EXISTS_PROFILE);
    await page.getByRole('button', { name: text.save }).click();
    await page.getByText(TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS.TARGET_CONFIG_EXISTS.description).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(page.url()).toMatch(/\/profiles\/new$/u);
    expect(readFileSync(generatedFileOf(EXISTS_PROFILE), 'utf8')).toBe(existing);
    expect(await valueOf('getProfileFn', 'GET', { profileId: EXISTS_PROFILE })).toBeNull();
    expect(leftoverTemporaryFiles()).toEqual([]);

    // T43R-fix-D（M-6）、CC-101（T43R-fix-D2）: 名前が Windows の予約名なら、案の段で作るファイルの場所を示さずに理由を出し、保存の前に名前の欄の
    // 誤りにする（何も送らない。ファイルもプロファイルも作らない）。
    await field(page, text.profileId).fill('nul');
    const reserved = page.getByTestId('generated-target-config-reserved');
    await reserved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reserved.textContent()).toBe(TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS.TARGET_CONFIG_NAME_RESERVED.description);
    expect(await page.getByTestId('generated-target-config-path').count()).toBe(0);
    await page.getByRole('button', { name: text.save }).click();
    await expect.poll(() => field(page, text.profileId).getAttribute('aria-invalid'), { timeout: UI_TIMEOUT_MS }).toBe('true');
    expect(page.url()).toMatch(/\/profiles\/new$/u);
    // 予約名のファイルの有無は、Windows ではデバイスを指しうるので調べない。ディレクトリの中身で確かめる。
    expect(readdirSync(`${rootPath()}/${GENERATED_DIRECTORY}`).filter((name) => name.toLowerCase().startsWith('nul'))).toEqual([]);
    expect(await valueOf('getProfileFn', 'GET', { profileId: 'nul' })).toBeNull();
  });

  it('does not write the file when the profile itself is rejected, nor for a rejected site sent directly', async () => {
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill('https://outside.example.test/');
    await field(page, text.profileId).fill(INVALID_PROFILE);
    await field(page, text.mode).selectOption('TEST_AUTH_PASSIVE');
    const testOrigins = field(page, text.approvedTestOrigins);
    await testOrigins.waitFor({ timeout: UI_TIMEOUT_MS });
    // テスト環境の Origin を、対象の許可 Origin の外にする（プロファイルの検証が拒む）。
    await testOrigins.fill('https://elsewhere.example.test');
    await field(page, text.environmentEvidenceRef).fill('t43b-evidence');
    await page.getByRole('button', { name: text.save }).click();
    await page.getByText(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_TEST_ORIGIN_OUTSIDE_TARGET).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(existsSync(generatedFileOf(INVALID_PROFILE))).toBe(false);

    // Server Function を直接呼んでも、受けない開始の URL ではファイルを作らない。
    const profile = {
      schemaVersion: 'beaksight-profile/1',
      profileId: 't43b-direct',
      revision: 1,
      targetConfigPath: `${GENERATED_DIRECTORY}/t43b-direct.json`,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      auth: 'NONE',
      approvedTestOrigins: [],
      environmentEvidenceRef: null,
    };
    expect(await valueOf('createProfileFn', 'POST', {
      profile,
      newTargetSite: { startUrl: 'https://user:secret@direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toEqual({ ok: false, reason: 'TARGET_SITE_INVALID', siteProblems: ['START_URL_HAS_CREDENTIALS'] });
    // 名前の形に合わない ID では、パスを作らない（任意のパスに書かない）。
    expect(await valueOf('createProfileFn', 'POST', {
      profile: { ...profile, profileId: '../escape' },
      newTargetSite: { startUrl: 'https://direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toMatchObject({ ok: false, reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_ID_INVALID'] });
    // T43R-fix-D（M-6）: Windows の予約名の名前は、理由つきで拒む（ファイルを作らない）。
    expect(await valueOf('createProfileFn', 'POST', {
      profile: { ...profile, profileId: 'con' },
      newTargetSite: { startUrl: 'https://direct.example.test/', allowedOrigins: ['https://direct.example.test'] },
    })).toEqual({ ok: false, reason: 'TARGET_CONFIG_NAME_RESERVED', siteProblems: [] });
    expect(await valueOf('getProfileFn', 'GET', { profileId: 'con' })).toBeNull();
    expect(existsSync(generatedFileOf('t43b-direct'))).toBe(false);
    expect(existsSync(`${rootPath()}/local/escape.json`)).toBe(false);
    expect(leftoverTemporaryFiles()).toEqual([]);
  });

  it('copies the allowed origin to the test origins in a test mode, and fills the new auth setup from the start URL path', async () => {
    const page = await openPage('/profiles/new');
    await field(page, text.startUrl).fill(TEST_START_URL);
    await field(page, text.profileId).fill(TEST_PROFILE);
    await field(page, text.mode).selectOption('TEST_AUTH_PASSIVE');
    const testOrigins = field(page, text.approvedTestOrigins);
    await testOrigins.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await testOrigins.inputValue()).toBe(TEST_ORIGIN);
    await field(page, text.environmentEvidenceRef).fill('t43b-evidence');
    await page.getByRole('button', { name: text.save }).click();
    await page.waitForURL(new RegExp(`/profiles/${TEST_PROFILE}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByText(text.created).waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await valueOf<{ profile: { targetConfigPath: string; approvedTestOrigins: readonly string[] } }>(
      'getProfileFn', 'GET', { profileId: TEST_PROFILE },
    );
    expect(saved.profile).toMatchObject({ targetConfigPath: `${GENERATED_DIRECTORY}/${TEST_PROFILE}.json`, approvedTestOrigins: [TEST_ORIGIN] });

    // 新しい認証の設定: 監査の path と成功の画面の path は開始の URL の path。除外の path は今の既定（空）のまま。
    const setupText = LOCAL_UI_AUTH_TEXT.setup;
    const setup = await openPage(`/auth-setup/${TEST_PROFILE}`);
    await setup.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(setup, setupText.auditPathPrefixes).inputValue()).toBe(START_PATH);
    expect(await field(setup, setupText.successPathPrefix).inputValue()).toBe(START_PATH);
    expect(await field(setup, setupText.excludedPaths).inputValue()).toBe('');

    // 保存した設定があれば、その値を出す（案で上書きしない）。
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: {
        ...FORM_NAVIGATION_SETUP_ITEMS,
        profileId: TEST_PROFILE,
        profileRevision: 1,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
        successCondition: { pathPrefix: '/admin/home/', selector: '#admin-ok' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: ['/admin/logout'],
        auditPathPrefixes: ['/admin/reports/'],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
      },
    })).toMatchObject({ ok: true });
    const reopened = await openPage(`/auth-setup/${TEST_PROFILE}`);
    await reopened.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(reopened, setupText.auditPathPrefixes).inputValue()).toBe('/admin/reports/');
    expect(await field(reopened, setupText.successPathPrefix).inputValue()).toBe('/admin/home/');
  });

  it('keeps the existing file flow: choosing a file creates no file', async () => {
    const page = await openPage('/profiles/new');
    await field(page, text.profileId).waitFor({ timeout: UI_TIMEOUT_MS });
    await chooseExistingTargetConfig(page, EXAMPLE_TARGET_CONFIG, UI_TIMEOUT_MS);
    await page.getByText(text.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
    // 開始の URL と許可 Origin の欄は出ない。
    expect([await field(page, text.startUrl).count(), await field(page, text.allowedOrigins).count()]).toEqual([0, 0]);
    await field(page, text.profileId).fill(EXISTING_FILE_PROFILE);
    await page.getByRole('button', { name: text.save }).click();
    await page.waitForURL(new RegExp(`/profiles/${EXISTING_FILE_PROFILE}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByText(text.created).waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: EXISTING_FILE_PROFILE });
    expect(saved.profile.targetConfigPath).toBe(EXAMPLE_TARGET_CONFIG);
    expect(existsSync(generatedFileOf(EXISTING_FILE_PROFILE))).toBe(false);
  });
});
