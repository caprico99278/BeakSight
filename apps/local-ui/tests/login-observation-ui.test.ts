/**
 * T43d（Task 43 の設計書 4.4、5 章の 4・5）: ジョブの詳細の「登録する」と「案を認証の設定に入れる」、認証の設定の画面の下書きとまとめて保存を、ビルドした
 * 画面のサーバ（一時の root）と headless の Chromium で確かめる。ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは
 * 接続しない）。
 * - ジョブの詳細: 止めた送信の表に、query の名前（記録した `grant_type` の値つき）と登録の列。token の送信の形の行とログインの前後の手続きの行には
 *   「登録する」、伏せた path の行と登録済みの送信の上限で止めた行には手で入れる案内（リンクなし）。観察の欄に、新しく出た鍵の名前と成功の画面のセレクタの案。
 * - 「登録する」は保存しない: 認証の設定の画面を下書きつきで開き、欄に入れ、プロファイルに足す承認したサービスの Origin を知らせる。保存を押すと、
 *   プロファイル（承認したサービスの Origin）と認証の設定を 1 回で保存し、認証の設定は「古い」にならない。
 * - 「案を認証の設定に入れる」は、鍵の名前を接頭辞に、セレクタを成功の画面のセレクタに入れる（保存は利用者）。
 * - 競合: 下書きを開いた後にプロファイルが変わったら、まとめて保存は改訂の衝突で拒み、どちらも書かない（読み直しのボタン）。
 * - 形の違う下書き（URL を直したもの）は欄に入れない。
 * 値は匿名（`example.invalid` とループバック）。
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3 } from '../../../src/control/auth/auth-setup-contracts.js';
import { DISCOVERY_LOGOUT_WORDS } from '../../../src/discovery/classification-words.js';
import { newStorageKeyShapesOf } from '../../../src/discovery/login-observation.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { REDACTED_PATH_SEGMENT } from '../../../src/core/url-path-redaction.js';
import { LOGIN_TRANSPORT_CATALOG } from '../../../src/presentation/catalog.js';
import { formatCount } from '../../../src/presentation/format.js';
import {
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
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
const PROFILE_ID = 't43d-observed';
const CONFLICT_PROFILE_ID = 't43d-conflict';
const JOB_ID = 'job-t43d-observed';
const CONFLICT_JOB_ID = 'job-t43d-conflict';
const HOSTILE_JOB_ID = 'job-t43r2-hostile';
const JOB_CREATED_AT = '20261017010000';
const JOB_ENDED_AT = '20261017011000';
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const TENANT_PATH = '/rest/v1/rpc/resolve_tenant';
const KEY_NAME = 'example-auth-token';
/** `KEY_NAME` の、接頭辞と接尾辞の案（T43R-fix の C-1 (a)）。 */
// T43R2-fix（意図して直した期待）: 一般の語の側（`-token`）だけ。最初の部分（`example`）は一般の語でないので接頭辞は空。
const KEY_SHAPE = Object.freeze({ prefix: '', suffix: '-token' });
const SCREENSHOT_DIRECTORY = process.env['T43D_SCREENSHOT_DIR'];

const authText = LOCAL_UI_AUTH_TEXT.setup;
const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT.setup;
const observedText = LOCAL_UI_LOGIN_OBSERVATION_TEXT;

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

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(200);
  return result.value as T;
};

interface AuthSetupPage {
  readonly profile: { readonly revision: number; readonly approvedServiceOrigins: readonly string[] };
  readonly stored: { readonly setup: Record<string, unknown>; readonly freshness: string } | null;
}
const authSetupPageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const rowLabel = (line: number, label: string): string => `${authText.lineText(String(line))} ${label}`;

const profileDocumentOf = (profileId: string, revision: number, serviceOrigins: readonly string[] = []) => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision,
  targetConfigPath: `config/targets/${profileId}.json`,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: `${profileId}-evidence`,
  ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
});

/** 前に保存してある、フォームの送信の認証の設定（版 3）。 */
const formSetupOf = (profileId: string) => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId,
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
});

/** ログインの段で止まったジョブのまとめ（token の送信、手続きの呼び出し、伏せた path、登録済みの上限、観察）。 */
const SUMMARY: AuditJobLoginStageSummary = {
  scriptLogin: null,
  blockedRequests: {
    requests: [
      {
        origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
        query: { names: ['grant_type', 'redirect_to'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
      },
      { origin: SERVICE_ORIGIN, path: TENANT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 2 },
      { origin: SERVICE_ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
      { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'SIDE_REQUEST_OVER_LIMIT', count: 1 },
      // T43R-fix の M-2: 登録した token の送信先で、必須の query が違ったので止めた行（`grant_type` の値があっても「登録する」を出さない）。
      {
        origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'TOKEN_REQUEST_QUERY_MISMATCH', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'refresh_token' }] },
      },
    ],
    unlisted: 0,
  },
  observation: {
    // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前は接頭辞と接尾辞の組だけ。
    storageKeys: { origin: TEST_ORIGIN, shapes: [KEY_SHAPE, { prefix: 'session.', suffix: '.idToken' }], omitted: 1 },
    successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' },
  },
};

/** テストだけの操作: ログインの段で止まったジョブの行を書く（ワーカーの代わり）。 */
const writeJob = (jobId: string, profileId: string, summary: AuditJobLoginStageSummary = SUMMARY): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
      .toEqual({ ok: true });
    expect(recordAuthState(database, jobId, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
    expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

/** ジョブの詳細を開き、ログインの段の欄を待つ。 */
const openJob = async (jobId: string): Promise<Page> => {
  const page = await openPage(`/jobs/${jobId}`);
  await page.getByTestId('job-login-stage').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/**
 * 行の下書きのリンクを押し、認証の設定の画面の下書きの知らせを待つ。FM-1（手動の操作を減らす設計書 2.1）: 「登録する」はその場で保存するボタンになり
 * （`login-stage-register-ui.test.ts`）、下書きのリンクは「認証の設定の画面で直す」として残した。
 */
const openDraftFromRow = async (page: Page, rowIndex: number): Promise<void> => {
  await page.getByTestId('job-login-stage-blocked').locator('tbody tr').nth(rowIndex).getByTestId('job-login-stage-edit-draft').click();
  await page.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
  await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
};

const saveSetup = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: authText.save }).click();
  await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
  writeAuthTargetConfig(root.root, CONFLICT_PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const profileId of [PROFILE_ID, CONFLICT_PROFILE_ID]) {
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(profileId, 1) })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: formSetupOf(profileId) })).toMatchObject({ ok: true });
  }
  writeJob(JOB_ID, PROFILE_ID);
  writeJob(CONFLICT_JOB_ID, CONFLICT_PROFILE_ID);
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

// T43R2-fix（Task 43 の設計書 7 章の最後の行）: 利用者の名前が鍵の名前の端に入る形（再レビュー T43R2 の 3 つと `alice/auth/token`）から作った案を出す
// ジョブの詳細と、その「案を認証の設定に入れる」の下書きの URL と認証の設定の画面に、名前が出ない。
describe('T43R2-fix: no user name on the job detail and the draft URL', () => {
  it('shows only the general word sides of the key names, and the user names are neither on the screens nor in the draft URL', async () => {
    const shapes = newStorageKeyShapesOf([], ['entryuser.session.token', 'app.session.entryuser', 'alice@example.com:session:token', 'alice/auth/token']);
    expect(shapes).not.toBeNull();
    writeJob(HOSTILE_JOB_ID, CONFLICT_PROFILE_ID, {
      scriptLogin: null, blockedRequests: null, observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [...(shapes?.shapes ?? [])], omitted: shapes?.omitted ?? 0 } },
    });
    const page = await openJob(HOSTILE_JOB_ID);
    const markers = ['entryuser', 'alice', 'example.com'];
    const jobText = await page.locator('body').textContent() ?? '';
    expect(markers.filter((marker) => jobText.includes(marker))).toEqual([]);
    expect(await page.getByTestId('job-login-observation-keys').textContent())
      .toBe(['.token', '/token', ':token'].map((suffix) => `${observedText.storageKeyMiddle}${suffix}`).join(', ') + ` ${observedText.omittedQueryNames(formatCount(1))}`);
    await page.getByTestId('job-login-observation-apply').click();
    await page.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(markers.filter((marker) => page.url().includes(marker) || decodeURIComponent(page.url()).includes(marker))).toEqual([]);
    // このプロファイルの保存した設定はフォームの送信なので、スクリプトの送信を選ぶと、鍵の欄に案が入っている。
    await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).check();
    expect(await field(page, scriptText.storageSuffix).inputValue()).toBe('.token');
    expect(await field(page, scriptText.storagePrefix).inputValue()).toBe('');
    const setupText = await page.locator('body').textContent() ?? '';
    expect(markers.filter((marker) => setupText.includes(marker))).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);
});

describe('T43d: the register buttons and the observation on the job detail', () => {
  it('shows the query names, the register buttons only for the rows with a draft, and the observation', async () => {
    const page = await openJob(JOB_ID);
    const table = page.getByTestId('job-login-stage-blocked');
    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBe(5);
    // token の送信の形の行: query の名前と、記録した `grant_type` の値。
    expect(await rows.nth(0).getByTestId('job-login-stage-query').textContent())
      .toBe(`grant_type（${observedText.recordedValue}: password）, redirect_to`);
    expect(await rows.nth(0).getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('TOKEN_TARGET');
    expect(await rows.nth(1).getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('SIDE_REQUEST');
    // 伏せた path の行と、登録済みの送信の上限で止めた行には、リンクがなく、手で入れる案内がある。
    expect(await rows.nth(2).getByTestId('job-login-stage-register').count()).toBe(0);
    expect(await rows.nth(2).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualRedactedPath);
    expect(await rows.nth(3).getByTestId('job-login-stage-register').count()).toBe(0);
    expect(await rows.nth(3).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualAlreadyRegistered);
    expect(await rows.nth(4).getByTestId('job-login-stage-register').count()).toBe(0);
    expect(await rows.nth(4).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualAlreadyRegistered);
    // 観察の欄（伏せた鍵の名前は伏せた旨を添える。セレクタは CSS と種類の説明だけ）。
    const observation = page.getByTestId('job-login-observation');
    expect(await observation.getByTestId('job-login-observation-keys').textContent()).toBe(
      `${KEY_SHAPE.prefix}${observedText.storageKeyMiddle}${KEY_SHAPE.suffix}, session.${observedText.storageKeyMiddle}.idToken ${observedText.omittedQueryNames(formatCount(1))}`,
    );
    expect(await observation.getByTestId('job-login-observation-selector').textContent())
      .toBe(`#logout${observedText.successSelectorLogout('logout')}`);
    expect(DISCOVERY_LOGOUT_WORDS).toContain('logout');
    expect(await observation.getByTestId('job-login-observation-apply').count()).toBe(1);
    await screenshot(page, 'g01-job-login-stage-register');
  }, SCENARIO_TIMEOUT_MS);
});

describe('T43d: the draft of the auth setup and the save of both', () => {
  it('opens the auth setup with the token target draft, saves the profile and the auth setup at once, and the setup is current', async () => {
    const page = await openJob(JOB_ID);
    await openDraftFromRow(page, 0);
    // 下書きは保存していない（保存してある設定はフォームの送信のまま）。
    expect((await authSetupPageOf(PROFILE_ID)).stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION' });
    expect(await page.getByTestId('auth-setup-observed-service-origins').textContent()).toBe(SERVICE_ORIGIN);
    expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
    expect(await field(page, scriptText.scriptOrigin).inputValue()).toBe(SERVICE_ORIGIN);
    expect(await field(page, scriptText.scriptPath).inputValue()).toBe(TOKEN_PATH);
    expect(await field(page, rowLabel(1, scriptText.queryName)).inputValue()).toBe('grant_type');
    expect(await field(page, rowLabel(1, scriptText.queryValue)).inputValue()).toBe('password');
    // 成功の鍵の形は、利用者が入れる（ここでは観察の案の名前）。
    await field(page, scriptText.storageOrigin).selectOption(TEST_ORIGIN);
    await field(page, scriptText.storagePrefix).fill(KEY_NAME);
    await screenshot(page, 'g02-auth-setup-token-draft');
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await authSetupPageOf(PROFILE_ID);
    expect(saved.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] });
    expect(saved.stored?.freshness).toBe('CURRENT');
    expect(saved.stored?.setup).toMatchObject({
      profileRevision: 2,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      successStorageKey: { origin: TEST_ORIGIN, prefix: KEY_NAME, suffix: '' },
    });
    // 保存の後は下書きなしで読み直す（URL に下書きを残さない）。
    expect(page.url()).not.toContain('draft');
  }, SCENARIO_TIMEOUT_MS);

  it('adds the side request draft to the saved list without a profile change, and puts the observation into the key and the selector', async () => {
    const page = await openJob(JOB_ID);
    await openDraftFromRow(page, 1);
    // サービスの Origin は前の保存で承認したので、プロファイルは変えない。
    expect(await page.getByTestId('auth-setup-observed-service-origins').count()).toBe(0);
    expect(await field(page, rowLabel(1, scriptText.sideOrigin)).inputValue()).toBe(SERVICE_ORIGIN);
    expect(await field(page, rowLabel(1, scriptText.sidePath)).inputValue()).toBe(TENANT_PATH);
    expect(await field(page, rowLabel(1, scriptText.sideMaxPerLoginStage)).inputValue()).toBe('1');
    await saveSetup(page);
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    const saved = await authSetupPageOf(PROFILE_ID);
    expect(saved.profile.revision).toBe(2);
    expect(saved.stored?.setup).toMatchObject({ loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TENANT_PATH, method: 'POST', maxPerLoginStage: 1 }] });

    const job = await openJob(JOB_ID);
    await job.getByTestId('job-login-observation-apply').click();
    await job.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await field(job, scriptText.storagePrefix).inputValue()).toBe(KEY_SHAPE.prefix);
    expect(await field(job, scriptText.storageSuffix).inputValue()).toBe(KEY_SHAPE.suffix);
    expect(await field(job, authText.successSelector).inputValue()).toBe('#logout');
    // 前に保存したログインに伴う送信は残る。
    expect(await field(job, rowLabel(1, scriptText.sidePath)).inputValue()).toBe(TENANT_PATH);
    await saveSetup(job);
    await job.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect((await authSetupPageOf(PROFILE_ID)).stored?.setup).toMatchObject({ successCondition: { pathPrefix: '/admin', selector: '#logout' } });
  }, SCENARIO_TIMEOUT_MS);

  it('rejects the save of both with the revision conflict when the profile changed after the draft was opened, and writes neither', async () => {
    const page = await openJob(CONFLICT_JOB_ID);
    await openDraftFromRow(page, 0);
    await field(page, scriptText.storageOrigin).selectOption(TEST_ORIGIN);
    await field(page, scriptText.storagePrefix).fill(KEY_NAME);
    // 下書きを開いた後に、プロファイルが別の操作で変わる。
    expect(await valueOf('updateProfileFn', 'POST', { profile: profileDocumentOf(CONFLICT_PROFILE_ID, 2), expectedRevision: 1 })).toMatchObject({ ok: true });
    await saveSetup(page);
    const rejection = page.getByTestId('auth-setup-rejection');
    expect(await rejection.getAttribute('data-reason')).toBe('PROFILE_REVISION_CONFLICT');
    expect(await rejection.textContent()).toBe(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description);
    expect(await page.getByRole('button', { name: LOCAL_UI_TEXT.reload }).count()).toBe(1);
    const after = await authSetupPageOf(CONFLICT_PROFILE_ID);
    expect(after.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [] });
    expect(after.stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION', profileRevision: 1 });
  }, SCENARIO_TIMEOUT_MS);

  it('does not put a draft of a wrong shape into the fields', async () => {
    const wrong = encodeURIComponent(JSON.stringify({ scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token?grant_type=password', requiredQuery: [] } }));
    const page = await openPage(`/auth-setup/${PROFILE_ID}?draft=${wrong}`);
    await page.getByTestId('auth-setup-observed-draft-invalid').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-observed-draft').count()).toBe(0);
    expect(await field(page, scriptText.scriptPath).inputValue()).toBe(TOKEN_PATH);
  }, SCENARIO_TIMEOUT_MS);
});
