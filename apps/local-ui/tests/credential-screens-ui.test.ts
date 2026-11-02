/**
 * PL-4（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2・3、4 章の 3、6 章の 4、7 章）: 自動ログインにする画面・ログインの ID と
 * パスワードの画面・ログインの設定の画面の形を、ビルドした画面のサーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - どの画面も、main の主のボタンは 1 つまで（`expectAtMostOnePrimaryButton`）、アクセシビリティの違反 0（`axeViolationsOf`）。
 * - 自動ログインにする画面（手でログインするサイト）: 見える入力は ID・パスワード・パスワードをもう一度の 3 つと、主のボタン「自動ログインにする」だけ。CSS
 *   セレクタの欄・方式の表・詳しい設定は出さない（案が 3 つそろうとき）。案がそろわないときは「このサイトでは自動ログインを使えません」と出して、欄もボタンも
 *   出さない。確定のダイアログ（PL-S の文）で確定すると、点検の開始の画面へ移る（移った印つき）。保存の後の画面（変える・削除・ログインを確かめる）は出ない。
 * - 手でログインするサイトでログインの設定がないとき: 「先に 1 回、手でログインして点検してください」と、主のボタン「点検を始める」。公開の画面だけのサイトは、
 *   ID とパスワードは要らない旨だけ（ボタンなし）。
 * - ID とパスワードの画面（自動ログインのサイト）: 要点に「自動ログインを使っています。…」とログインする先（ホストだけ）。主のボタンは「点検を始める」。変える・
 *   削除は、閉じた詳しい内容の中。日時・改訂・Origin・暗号化の行と、秒の上限の表示は出さない。止めているときは理由と、停止を解く入口（ログインの確かめの画面）。
 * - ログインの設定の画面: 要点に、自動で保存した設定であることと、直すのは観察で入らない欄だけであること。読むだけの送信先の欄（ログインの画面のアドレス・送り方・
 *   送信先・自動ログインの欄の目印）は、詳しい内容の中にも出さない（MI 4.7.1 の 6 で変えられない）。
 * 状態は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは接続しない）。資格情報は本物の DPAPI で保存するので、自動ログインの場面は
 * Windows だけ。値は匿名（ループバック）。
 */
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { createCredentialStore } from '../../../src/control/credentials/credential-store.js';
import { recordAutoLoginResult } from '../../../src/control/job/auto-login-store.js';
import { createStartingJob, recordAuthState, recordFinished, recordLoginCheckFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { getAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { AUTOMATED_LOGIN_RESULT_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_NEXT_STEP_TEXT,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { createTemporaryUiRoot, findFreePort, startLauncher, stopServer, type StartedServer, type TemporaryUiRoot } from './helpers/local-server.ts';
import { createProfileInStore, readProfileInStore, saveAuthSetupInStore } from './helpers/profile-store-setup.ts';
import { axeViolationsOf, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login states save the credential with the real DPAPI, which exists only on Windows';
const UI_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const MAX_PAGES = 3;
const FIRST_REVISION = 1;
const TEST_ORIGIN = 'http://127.0.0.1:9';
const TEST_HOST = new URL(TEST_ORIGIN).host;
const LOGIN_START_URL = `${TEST_ORIGIN}/auth`;
const ADMIN_PATH = '/admin';
/** 手でログインしたときに観察した、ログインの欄の案（偽の観察。値は読まない）。 */
const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });

/** 状態ごとのサイト。 */
const PROFILES = Object.freeze({
  switch: 'pl4-switch',
  noProposal: 'pl4-no-proposal',
  noSetup: 'pl4-no-setup',
  public: 'pl4-public',
  saved: 'pl4-saved',
  held: 'pl4-held',
  empty: 'pl4-empty',
});

const setupText = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;
const credentialText = LOCAL_UI_CREDENTIAL_TEXT;

/** 実行ごとの目印（値を出力しない）。 */
const RUN = randomUUID();
const USER = `pl4-user-${RUN}`;
const PASS = `pl4-pass-${RUN}`;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
});

/** 管理データを開いて 1 回書く・読む（テストだけの操作）。 */
const withDatabase = <T>(use: (database: ReturnType<typeof openControlDatabase>) => T): T => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    return use(database);
  } finally {
    closeControlDatabase(database);
  }
};

const now = (): string => formatCompactUtcTimestamp(new Date(), 'test job time');

/** 手でログインした点検の、ログインの段の観察（欄の案つき）を持つ、終わったジョブの行を書く（ワーカーの代わり）。 */
const writeManualLoginJob = (profileId: string): void => {
  const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
  withDatabase((database) => {
    const at = now();
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt: at }, () => null))
      .toEqual({ ok: true });
    expect(recordAuthState(database, jobId, 'AUTHENTICATED', null, { scriptLogin: null, blockedRequests: null, observation: { loginFields: FIELDS } }))
      .toBe(true);
    expect(recordLoginCheckFinished(database, jobId, 0, at)).toBe(true);
  });
};

/** 自動ログインの点検が送った後に失敗した（自動ログインを止めた）ジョブの行を書く。 */
const writeHeldAudit = (profileId: string): void => {
  const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
  const runId = 'RUN-20261026000000';
  withDatabase((database) => {
    const createdAt = now();
    expect(createStartingJob(database, {
      jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt, autoLoginAttempt: { credentialRevision: 1 },
    }, () => null)).toEqual({ ok: true });
    expect(recordAutoLoginResult(database, { jobId, result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, at: createdAt }))
      .toMatchObject({ recorded: true });
    expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: createdAt })).toBe(true);
    expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, now()))
      .toBe(true);
  });
};

/** テスト用のサイトのプロファイル。 */
const testProfileOf = (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN'): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1', profileId, revision: FIRST_REVISION, targetConfigPath: `config/targets/${profileId}.json`,
  environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
});

/** フォームで送るログインの認証の設定（入口の確かめの後に、BeakSight が案で保存した形）。`automated` なら自動ログインの欄の目印も。 */
const formSetupOf = (profileId: string, automated: boolean): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: LOGIN_START_URL,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  successCondition: { pathPrefix: ADMIN_PATH, selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: FIELDS.username,
      passwordSelector: FIELDS.password,
      submitSelector: FIELDS.submit,
      failureConditions: { invalidCredentials: { pathPrefix: '/auth', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    }
    : null,
});

/** テスト用のサイトを作る（`setup` が真なら、ログインの設定も保存する）。 */
const createTestProfile = async (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN', setup: boolean): Promise<void> => {
  writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  expect(await createProfileInStore(rootOf().root, testProfileOf(profileId, auth))).toMatchObject({ ok: true });
  if (setup) {
    expect(await saveAuthSetupInStore(rootOf().root, formSetupOf(profileId, auth === 'AUTOMATED_LOGIN'))).toMatchObject({ ok: true });
  }
};

/** ID とパスワードの画面を開き、要点のパネルを待つ。 */
const openCredentials = async (profileId: string): Promise<Page> => {
  const page = await openPage(`/credentials/${profileId}`);
  await page.getByTestId('credential-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** main の中で見えている入力の欄の名前と、見えているボタン・リンク（ボタンの見た目）の名前。 */
const visibleControlsOf = async (page: Page): Promise<{ readonly inputs: readonly (string | null)[]; readonly buttons: readonly string[] }> => ({
  inputs: await page.locator('main input:visible, main select:visible, main textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))),
  buttons: (await page.locator('main button:visible, main a.button:visible').allTextContents()).map((label) => label.trim()),
});

/** 3 章の形の共通の確かめ（主のボタン 1 つまで、axe の違反 0、見える区画の数）。 */
const expectScreenShape = async (page: Page, label: string, sections: number): Promise<void> => {
  await expectAtMostOnePrimaryButton(page);
  expect(await axeViolationsOf(page), label).toEqual([]);
  expect(await page.locator('main > section:visible').count(), label).toBe(sections);
};

/** 2 章の「出さないもの」と、秒の上限の表示が、main の見える文にないこと。 */
const expectNoTechnicalText = async (page: Page, label: string): Promise<void> => {
  const shown = await page.getByRole('main').innerText();
  for (const hidden of [TEST_ORIGIN, LOGIN_START_URL, ...Object.values(FIELDS), '300秒', '86400秒', '24時間']) {
    expect(shown, `${label}: ${hidden}`).not.toContain(hidden);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  await createTestProfile(PROFILES.switch, 'MANUAL_SESSION', true);
  writeManualLoginJob(PROFILES.switch);
  await createTestProfile(PROFILES.noProposal, 'MANUAL_SESSION', true);
  await createTestProfile(PROFILES.noSetup, 'MANUAL_SESSION', false);
  const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.public, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
  expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.public, publicPath))).toMatchObject({ ok: true });
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

describe('PL-4: the screen to switch to the automated login (a site with the manual login)', () => {
  it('shows only the three inputs and the primary button when the three proposals are complete (no selectors, no method table, no details)', async () => {
    const page = await openCredentials(PROFILES.switch);
    const form = page.getByTestId('automated-login-setup');
    await form.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await visibleControlsOf(page)).toEqual({ inputs: ['username', 'password', 'passwordConfirmation'], buttons: [setupText.review] });
    expect(await primaryButtonLabelsInMain(page)).toEqual([setupText.review]);
    expect(await page.locator('main details').count()).toBe(0);
    expect(await page.locator('main [data-testid="automated-login-setup-selector"], main [data-testid="automated-login-setup-method"]').count()).toBe(0);
    // テスト用のアカウントだけを入れることと、ブラウザに保存させないこと（安全のために必ず見せる。7 章）。
    expect(await page.getByTestId('credential-test-account-only').textContent()).toBe(credentialText.testAccountOnlyBody);
    expect(await page.getByTestId('credential-not-eligible').count()).toBe(0);
    await expectNoTechnicalText(page, PROFILES.switch);
    await expectScreenShape(page, PROFILES.switch, 1);
  });

  it('says the automated login is not available, without inputs and without a button, when the proposals are not complete', async () => {
    const page = await openCredentials(PROFILES.noProposal);
    expect(await page.getByTestId('automated-login-setup-not-available').textContent()).toBe(setupText.notAvailable);
    expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [] });
    expect(await page.getByTestId('automated-login-setup-form').count()).toBe(0);
    await expectScreenShape(page, PROFILES.noProposal, 1);
  });

  it('asks for one manual audit first, with the primary button to start the audit, when the manual login site has no login setup (S4)', async () => {
    const page = await openCredentials(PROFILES.noSetup);
    const note = page.getByTestId('credential-not-eligible');
    expect(await note.getAttribute('data-kind')).toBe('MANUAL');
    expect(await note.textContent()).toBe(credentialText.notEligibleManual);
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START]);
    expect(await page.locator('main a.button--primary').getAttribute('href')).toBe(`/start/${PROFILES.noSetup}`);
    expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START] });
    await expectScreenShape(page, PROFILES.noSetup, 1);
  });

  it('says no password is needed, without a button, for a site with the public pages only', async () => {
    const page = await openCredentials(PROFILES.public);
    const note = page.getByTestId('credential-not-eligible');
    expect(await note.getAttribute('data-kind')).toBe('PUBLIC');
    expect(await note.textContent()).toBe(credentialText.notEligiblePublic);
    expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [] });
    await expectScreenShape(page, PROFILES.public, 1);
  });

  it.skipIf(!IS_WINDOWS)(`confirms once with the dialog (the PL-S lines), then moves to the audit start screen (${SKIP_REASON} otherwise)`, async () => {
    const page = await openCredentials(PROFILES.switch);
    const form = page.getByTestId('automated-login-setup');
    await form.locator('input[name="username"]').fill(USER);
    await form.locator('input[name="password"]').fill(PASS);
    await form.locator('input[name="passwordConfirmation"]').fill(PASS);
    await form.getByRole('button', { name: setupText.review }).click();
    const dialog = page.getByRole('dialog', { name: setupText.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-S の文（パスワードを入れる先・テスト用のアカウントだけ・保存の場所・回数の決まり）は変わらない。
    expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(setupText.dialog.destination(TEST_HOST));
    expect(await dialog.getByTestId('automated-login-setup-test-account').textContent()).toBe(setupText.dialog.testAccountOnly);
    expect(await dialog.getByTestId('automated-login-setup-storage').textContent()).toBe(setupText.dialog.storage);
    expect(await dialog.getByTestId('automated-login-setup-limits').count()).toBe(1);
    await expectAtMostOnePrimaryButton(page);
    await dialog.getByRole('button', { name: setupText.dialog.confirm }).click();
    // 確定の後は、点検の開始の画面へ移る（移った印と、自動ログインにした印）。保存の後の画面（変える・削除・ログインを確かめる）は出ない。
    await page.waitForURL(new RegExp(`/start/${PROFILES.switch}[?]arrived=auto&automatedLogin=setUp$`, 'u'), { timeout: UI_TIMEOUT_MS });
    // 開始の画面の中身は PL-3 の作り直しの範囲なので、描き終えたこと（読む量の表があること）だけを待つ。
    await page.getByTestId('start-target').waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('automated-login-setup').count()).toBe(0);
    expect(await page.getByTestId('credential-done').count()).toBe(0);
    expect(await page.getByTestId('automated-login-setup-login-check-note').count()).toBe(0);
    expect(readProfileInStore(rootOf(), PROFILES.switch)?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: FIRST_REVISION + 1 });
    // 欄の目印は、観察の案のまま保存した。
    expect(withDatabase((database) => getAuthSetup(database, PROFILES.switch))?.setup.automatedLogin)
      .toMatchObject({ usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit });
    // 値は画面に出ない。
    expect(await page.content()).not.toContain(PASS);
    expect(await page.content()).not.toContain(USER);
  });
});

describe('PL-4: the ID and password screen (a site with the automated login)', () => {
  beforeAll(async () => {
    if (!IS_WINDOWS) return;
    const credentials = createCredentialStore(rootOf().root);
    for (const profileId of [PROFILES.saved, PROFILES.held, PROFILES.empty]) {
      await createTestProfile(profileId, 'AUTOMATED_LOGIN', true);
    }
    for (const profileId of [PROFILES.saved, PROFILES.held]) {
      await credentials.register({ profileId, loginOrigin: TEST_ORIGIN, username: `pl4-user-${randomUUID()}`, password: `pl4-pass-${randomUUID()}` });
    }
    writeHeldAudit(PROFILES.held);
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)(`saved: the summary says where it is kept, the primary button starts the audit, and the change and the removal are in the details (${SKIP_REASON} otherwise)`, async () => {
    const page = await openCredentials(PROFILES.saved);
    const saved = page.getByTestId('credential-saved');
    expect(await saved.getAttribute('data-saved')).toBe('yes');
    expect(await saved.textContent()).toBe(credentialText.summary.saved);
    expect(await page.getByTestId('credential-destination').textContent()).toBe(credentialText.summary.destination(TEST_HOST));
    expect(await page.getByTestId('credential-hold').count()).toBe(0);
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START]);
    expect(await visibleControlsOf(page)).toEqual({ inputs: [], buttons: [LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_START] });
    expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
    const details = page.getByTestId('credential-advanced-settings');
    expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    expect(await page.getByTestId('credential-change-form').isVisible()).toBe(false);
    expect(await page.getByTestId('credential-remove').isVisible()).toBe(false);
    await expectNoTechnicalText(page, PROFILES.saved);
    await expectScreenShape(page, PROFILES.saved, 2);
    // 詳しい内容を開くと、変える欄と削除がある（主のボタンは増えない）。
    await openAdvancedSettings(page, 'credential-advanced-settings', UI_TIMEOUT_MS);
    expect(await page.getByTestId('credential-change-form').isVisible()).toBe(true);
    expect(await page.getByTestId('credential-remove').isVisible()).toBe(true);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
  });

  it.skipIf(!IS_WINDOWS)(`held: the reason and what to do, no primary button, and the way to clear the hold (${SKIP_REASON} otherwise)`, async () => {
    const page = await openCredentials(PROFILES.held);
    const held = page.getByTestId('credential-hold');
    expect(await held.getAttribute('data-held')).toBe('yes');
    expect(await held.textContent()).toBe(credentialText.summary.held(AUTOMATED_LOGIN_RESULT_CATALOG.INVALID_CREDENTIALS.label));
    expect(await primaryButtonLabelsInMain(page)).toEqual([]);
    expect(await page.locator(`main a[href$="/login-check/${PROFILES.held}"]`).textContent()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.CLEAR_HOLD);
    await expectNoTechnicalText(page, PROFILES.held);
    await expectScreenShape(page, PROFILES.held, 2);
  });

  it.skipIf(!IS_WINDOWS)(`not saved yet: the three inputs and the primary button to register them in the summary (${SKIP_REASON} otherwise)`, async () => {
    const page = await openCredentials(PROFILES.empty);
    expect(await page.getByTestId('credential-saved').getAttribute('data-saved')).toBe('no');
    expect(await page.getByTestId('credential-saved').textContent()).toBe(credentialText.summary.notSaved);
    expect(await visibleControlsOf(page)).toEqual({ inputs: ['username', 'password', 'passwordConfirmation'], buttons: [credentialText.register.submit] });
    expect(await primaryButtonLabelsInMain(page)).toEqual([credentialText.register.submit]);
    await expectNoTechnicalText(page, PROFILES.empty);
    await expectScreenShape(page, PROFILES.empty, 1);
  });
});

describe('PL-4: the login setup screen', () => {
  it('says the setup was saved automatically, and shows no read-only destination fields even in the details', async () => {
    const page = await openPage(`/auth-setup/${PROFILES.noProposal}`);
    const summary = page.getByTestId('auth-setup-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.getByTestId('auth-setup-summary-line').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.summarySaved);
    expect(await page.getByTestId('auth-setup-freshness').getAttribute('data-freshness')).toBe('CURRENT');
    expect(await page.getByTestId('auth-setup-profile').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-value-sources').count()).toBe(0);
    expect(await page.getByTestId('entry-check-panel').count()).toBe(0);
    await expectNoTechnicalText(page, PROFILES.noProposal);
    await expectScreenShape(page, PROFILES.noProposal, 2);
    await openAdvancedSettings(page, 'auth-setup-advanced-settings', UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-destination-locked').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.destinationLockedNote);
    expect(await page.getByRole('main').innerText()).not.toContain(LOGIN_START_URL);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
  });

  it('names the entry check button the same as the site screen (re-check the entry), when the setup is not saved yet', async () => {
    const page = await openPage(`/auth-setup/${PROFILES.noSetup}`);
    await page.getByTestId('auth-setup-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auth-setup-summary-line').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.summaryNotSaved);
    const panel = page.getByTestId('entry-check-panel');
    expect((await panel.getByTestId('entry-check-start').textContent())?.trim()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
  });

  it('guides to the same button name in the next steps of the entry check job (READ_FAILED, NAVIGATION_FAILED)', () => {
    for (const reason of ['READ_FAILED', 'NAVIGATION_FAILED'] as const) {
      expect(LOCAL_UI_JOB_NEXT_STEPS.entryCheckEndReasons[reason], reason).toContain(`「${LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY}」`);
    }
  });

  it.skipIf(!IS_WINDOWS)(`shows no selectors of the automated login even in the details (${SKIP_REASON} otherwise)`, async () => {
    const page = await openPage(`/auth-setup/${PROFILES.saved}`);
    await page.getByTestId('auth-setup-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    await openAdvancedSettings(page, 'auth-setup-advanced-settings', UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-automated').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
    const shown = await page.getByRole('main').innerText();
    for (const selector of Object.values(FIELDS)) {
      expect(shown, selector).not.toContain(selector);
    }
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
  });
});
