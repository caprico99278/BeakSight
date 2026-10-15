/**
 * 自動ログインの画面の操作の確かめ（Task 26 の設計書 4.1 の「起動のとき」、4.2、4.3、4.6、4.7。T26e）。ビルドした画面を一時の root の起動の部品で
 * 起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 資格情報の画面（プロファイルの詳細から）: 登録（キーボードだけ。パスワードの不一致の拒否）、変更（ユーザー名だけ、パスワードと停止の解除）、
 *   入れ直し（保存した Origin が認証の設定と違う）、削除（確かめのダイアログ）、ジョブが動いている間の拒否（`CREDENTIAL_IN_USE`）。
 * - 認証の設定の画面の自動ログインの欄（回数は 1 に固定の表示、条件の重なりの誤りを項目に出す）。
 * - ログインの確かめ（`LOGIN_CHECK`）: 始められない理由（`CREDENTIAL_MISSING`、`AUTO_LOGIN_HELD`、`AUTO_LOGIN_RATE_LIMITED` と次に始められる日時、
 *   `AUTH_STRATEGY_NOT_EXECUTABLE`）、止めた状態と解除（確かめのダイアログ）、成功と失敗の結果の表示（ジョブの種類、結果、送信、人がすること）。
 * - 監査の開始の画面の自動ログインの案内と上限の状態、環境の状態の画面の暗号化の状態。
 * - 手動のログインのプロファイルでは、資格情報の画面を出さず、直接の要求を拒む。CSRF（cross-site の POST は 403）、スキーマに合わない入力は 400。
 * - 値を出さない: 目印の値（ユーザー名とパスワード）が、ページの HTML（すべての画面）、Server Function の応答（成功と誤り）、画面のサーバの標準出力と
 *   標準エラー、管理データのファイルと WAL、資格情報のファイル（暗号文）のどこにもない。
 * - Windows でないとき（画面のサーバの `process.platform` をテストだけの前処理で差し替える）は「この環境では使えない」を出し、保存を拒む。起動のときに
 *   資格情報のフォルダの書きかけの一時のファイルを消す。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。ワーカーと Chromium の process が残らない。
 * 資格情報は、本物の DPAPI（Windows だけ。一時の root の中の資格情報のフォルダ。資格情報マネージャーは使わない）で暗号化する。Windows でなければ、
 * その場面を理由を出して飛ばす。監査のワーカーは、一時の root の入口をテストだけの入口に替えて動かす（自動ログインの段は本番のまま。headless）。
 * fixture のサイトは 127.0.0.1 だけ。目印の値は実行ごとのランダムな値で、出力しない（比べるときは真偽だけを見る）。スクリーンショットは、環境変数
 * `T26E_SCREENSHOT_DIR` があれば、そこに保存する（値は写らない: 入力の欄は送った後に空にする）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_2,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
} from '../../../src/control/auth/auth-setup-contracts.js';
import {
  MAX_CREDENTIAL_VALUE_LENGTH,
  credentialFilePathFor,
  resolveCredentialDirectory,
} from '../../../src/control/credentials/credential-store.js';
import { CONTROL_DATA_DIRECTORY_NAME } from '../../../src/control/store/database-path.js';
import { temporaryPathFor } from '../../../src/core/temporary-file-name.js';
import { AUTOMATED_LOGIN_RESULT_CATALOG, CREDENTIAL_ENVIRONMENT_CATALOG } from '../../../src/presentation/catalog.js';
import { formatTimes } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_PATHS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginOutcome,
} from '../../../tests/helpers/automated-login-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { MANUAL_LOGIN_STAGE_RECORD, WORKER_RECORD_FILES, installTestAutomatedLoginWorkerEntry } from './helpers/auth-worker.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  startLauncherWithNodeArguments,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, encodeServerFunctionPayload, readServerFunctionIds } from './helpers/server-functions.ts';
import { filesUnder, leakedPlaces } from './helpers/secret-markers.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the credential screen saves with the real DPAPI, which exists only on Windows';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 20_000;
/** ログインの確かめのジョブの終わりを待つ上限（ミリ秒。ワーカーの起動、Chromium、結果を待つ時間を含む）。 */
const JOB_TIMEOUT_MS = 150_000;
/** 1 つの場面の上限（ミリ秒）。 */
const SCENARIO_TIMEOUT_MS = 300_000;
/** process が消えるのを待つ上限（ミリ秒）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** 状態を読み直す間隔（ミリ秒）。 */
const POLL_MS = 250;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 80;
/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403 });
const FIRST_REVISION = 1;

/** テストの値（匿名）。 */
const MAIN_PROFILE = 't26e-main';
const INVALID_PROFILE = 't26e-invalid';
const SLOW_PROFILE = 't26e-slow';
const MANUAL_PROFILE = 't26e-manual';
const LINUX_PROFILE = 't26e-linux';
/** T26g-2: 取り消しで資格情報を消す（ジョブなし・ジョブあり）、自動ログインでなくなったプロファイルに残った資格情報を消す。 */
const RETIRE_PROFILE = 't26g2-retire';
const RETIRE_RUNNING_PROFILE = 't26g2-retire-running';
const LEFTOVER_PROFILE = 't26g2-leftover';
/** T26g-3: プロファイルの詳細の画面から、残った資格情報の画面へ移る。 */
const LEFTOVER_LINK_PROFILE = 't26g3-leftover-link';

/** 実行ごとの目印（値を出力しない）。fixture の正しい資格情報と、誤りの値。 */
const RUN = randomUUID();
const USER_OK = `t26e-user-${RUN}`;
const PASS_OK = `t26e-pass-${RUN}`;
const PASS_WRONG = `t26e-wrong-${RUN}`;
const PASS_TYPO = `t26e-typo-${RUN}`;
const USER_OTHER = `t26e-other-${RUN}`;
const MARKERS = Object.freeze([USER_OK, PASS_OK, PASS_WRONG, PASS_TYPO, USER_OTHER]);
const leaks = (text: string): boolean => MARKERS.some((marker) => text.includes(marker));

const credentialText = LOCAL_UI_CREDENTIAL_TEXT;
const checkText = LOCAL_UI_LOGIN_CHECK_TEXT;
const SCREENSHOT_DIRECTORY = process.env['T26E_SCREENSHOT_DIR'];

let root: TemporaryUiRoot | undefined;
let fixture: AutomatedLoginFixture | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
let recordDirectory = '';
let slowPosts = 0;
/** 画面の HTML と、Server Function の応答の本文（最後に目印がないことを確かめる）。 */
const htmlSnapshots: string[] = [];
const responseBodies: string[] = [];
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const site = (): AutomatedLoginFixture => {
  if (fixture === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return fixture;
};
const rootOf = (): string => root?.root ?? '';

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求）、Tab だけのフォーカスの移動、スクリーンショット（CCX-16 の共通の補助）。 */
const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
  // Server Function の応答の本文を集め、開いたページの HTML を集める（最後に目印がないことを確かめる）。
  onPageCreated: (page) => {
    page.on('response', (response) => {
      if (response.url().includes('/_serverFn/')) {
        void response.text().then((body) => responseBodies.push(body), () => undefined);
      }
    });
  },
  afterOpen: (page) => snapshot(page),
});

/** 今のページの HTML を集める（最後に目印がないことを確かめる）。 */
const snapshot = async (page: Page): Promise<void> => {
  htmlSnapshots.push(await page.content());
};

/** キーボードだけで、欄に値を入れる（Tab で移り、打つ）。 */
const typeInto = async (page: Page, target: Locator, value: string): Promise<void> => {
  await tabTo(page, target);
  await page.keyboard.type(value);
};

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する。 */
const recordDescendants = async (): Promise<void> => {
  descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
};

/** Server Function を呼ぶ（応答の本文を集める）。 */
const callFunction = async (name: string, method: 'GET' | 'POST', data?: unknown) => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  responseBodies.push(result.response.body);
  return result;
};

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callFunction(name, method, data);
  expect(result.response.status, `${name} status`).toBe(STATUS.OK);
  return result.value as T;
};

/** 監査の対象の Origin を 2 つ（fixture の 2 つの名前）許すターゲット設定を書く。 */
const writeTargetConfig = (name: string): string => {
  const path = `config/targets/${name}.json`;
  mkdirSync(`${rootOf()}/config/targets`, { recursive: true });
  writeFileSync(`${rootOf()}/${path}`, `${JSON.stringify({
    target: { id: name },
    site: { startUrl: `${site().originA}${AUTOMATED_LOGIN_FIXTURE_PATHS.home}`, allowedOrigins: [site().originA, site().originB] },
    crawl: { minNavigationIntervalMs: 0, maxPages: 1 },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: `t26e-output-${name}` },
  }, null, 2)}\n`, 'utf8');
  return path;
};

/** 認証つきの読み取りの監査のプロファイルの文書。 */
const profileDocument = (profileId: string, auth: 'AUTOMATED_LOGIN' | 'MANUAL_SESSION'): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: writeTargetConfig(profileId),
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth,
  approvedTestOrigins: [site().originA, site().originB],
  environmentEvidenceRef: 't26e-evidence',
});

/** fixture のログインの画面の、自動ログインの認証の設定（`origin` は、ログインの画面と送信先の Origin）。 */
const automatedSetupOf = (profileId: string, outcome: AutomatedLoginOutcome, origin: string = site().originA): Record<string, unknown> => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${origin}${new URL(site().formUrl('standard', outcome)).pathname}${new URL(site().formUrl('standard', outcome)).search}`,
  loginPostEndpoints: [{ origin, path: site().authPath(outcome) }],
  successCondition: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success,
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: [AUTOMATED_LOGIN_FIXTURE_PATHS.home],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
    passwordSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.password,
    submitSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit,
    failureConditions: {
      invalidCredentials: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials,
      accountLocked: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked,
      mfaRequired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.mfaRequired,
      credentialExpired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.credentialExpired,
    },
  },
});

interface JobDetail {
  readonly jobId: string;
  readonly jobKind: string;
  readonly active: boolean;
  readonly state: string;
  readonly autoLogin: { readonly result: string | null; readonly submitted: string | null } | null;
}

/** ジョブが終わるまで待つ。 */
const waitForJobEnd = async (jobId: string): Promise<JobDetail> => {
  await recordDescendants();
  let job: JobDetail | null = null;
  await expect.poll(async () => {
    job = await valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });
    return job?.active;
  }, { timeout: JOB_TIMEOUT_MS, interval: POLL_MS }).toBe(false);
  if (job === null) {
    throw new Error('ジョブがない');
  }
  return job;
};

/** ログインの確かめの画面から、ログインの確かめを始め（キーボードだけ）、ジョブの画面に移る。ジョブの ID を返す。 */
const startLoginCheckFromPage = async (page: Page): Promise<string> => {
  await tabTo(page, page.getByTestId('login-check-start'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
};

/** ジョブの画面で、結果が出るまで待つ（画面は終わるまで読み直す）。 */
const waitForResultOnPage = async (page: Page, result: string): Promise<void> => {
  await page.locator(`[data-testid="job-auto-login-result"][data-result="${result}"]`).waitFor({ timeout: JOB_TIMEOUT_MS });
  await page.locator('[data-testid="job-state"]:not([data-state="STARTING"]):not([data-state="RUNNING"]):not([data-state="STOPPING"])')
    .waitFor({ timeout: JOB_TIMEOUT_MS });
  await snapshot(page);
};

/** 資格情報の画面の、欄（ラベルは完全一致）。 */
const field = (page: Page, label: string): Locator => page.getByLabel(label, { exact: true });

/** 資格情報の画面の、保存の拒否の理由。 */
const rejectionReason = (page: Page): Promise<string | null> => page.getByTestId('credential-rejection').getAttribute('data-reason');

/** fixture に届いた、GET と HEAD 以外の要求（`<method> <path>`）。 */
const nonReadRequests = (): readonly string[] =>
  site().requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

describe.skipIf(!IS_WINDOWS)(`T26e: the automated login screens${IS_WINDOWS ? '' : ` [skipped: ${SKIP_REASON}]`}`, () => {
  beforeAll(async () => {
    root = createTemporaryUiRoot('built');
    recordDirectory = `${root.root}/t26e-worker-records`;
    installTestAutomatedLoginWorkerEntry(root.root, recordDirectory);
    fixture = await startAutomatedLoginFixture({ username: USER_OK, password: PASS_OK, onSlowPost: () => { slowPosts += 1; } });
    ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
    browser = await launchHeadlessChromium();
    server = await startLauncher(root, await findFreePort());
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
    await page.close();
    const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
    for (const profileId of [MAIN_PROFILE, INVALID_PROFILE, SLOW_PROFILE]) {
      expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(profileId, 'AUTOMATED_LOGIN') })).toMatchObject({ ok: true });
    }
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(MANUAL_PROFILE, 'MANUAL_SESSION') })).toMatchObject({ ok: true });
    for (const [profileId, outcome] of [[INVALID_PROFILE, 'success'], [SLOW_PROFILE, 'slow']] as const) {
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: automatedSetupOf(profileId, outcome) })).toMatchObject({ ok: true });
    }
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await stopServer(server);
    expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
    await fixture?.close();
    root?.remove();
  }, SCENARIO_TIMEOUT_MS);

  it('shows the encryption state on the environment page, and the login check only for the automated login profiles', async () => {
    const environment = await openPage('/environment');
    const protection = environment.getByTestId('environment-credential-protection');
    expect(await protection.getAttribute('data-state')).toBe('AVAILABLE');
    expect(await protection.textContent()).toBe(CREDENTIAL_ENVIRONMENT_CATALOG.AVAILABLE.label);
    await screenshot(environment, '01-environment');
    const list = await openPage('/');
    for (const profileId of [MAIN_PROFILE, INVALID_PROFILE, SLOW_PROFILE]) {
      expect(await list.locator(`tr[data-profile-id="${profileId}"]`).getByRole('link', { name: checkText.profileList.loginCheck }).count()).toBe(1);
    }
    expect(await list.locator(`tr[data-profile-id="${MANUAL_PROFILE}"]`).getByRole('link', { name: checkText.profileList.loginCheck }).count())
      .toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('saves the automated login fields of the auth setup, shows the fixed number of attempts, and puts an ambiguity error on its field', async () => {
    const page = await openPage(`/auth-setup/${MAIN_PROFILE}`);
    const setupText = LOCAL_UI_AUTH_TEXT.setup;
    expect(await page.getByTestId('auth-setup-automated').count()).toBe(1);
    expect(await page.locator('select[name="maxLoginAttempts"]').count()).toBe(0);
    expect(await page.getByTestId('auth-setup-max-login-attempts-fixed').textContent())
      .toBe(setupText.maxLoginAttemptsFixedText(formatTimes(AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS)));
    expect(await page.getByTestId('auth-setup-no-secret').textContent()).toBe(setupText.noSecretBodyAutomated);
    const setup = automatedSetupOf(MAIN_PROFILE, 'success');
    const names = setupText.failureConditionNames;
    await field(page, setupText.loginStartUrl).fill(String(setup['loginStartUrl']));
    await field(page, setupText.loginPostEndpoints).fill(`${site().originA}${site().authPath('success')}`);
    await field(page, setupText.successPathPrefix).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success.pathPrefix);
    await field(page, setupText.successSelector).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success.selector);
    await field(page, setupText.excludedPaths).fill('/logout');
    await field(page, setupText.usernameSelector).fill(AUTOMATED_LOGIN_FIXTURE_SELECTORS.username);
    await field(page, setupText.passwordSelector).fill(AUTOMATED_LOGIN_FIXTURE_SELECTORS.password);
    await field(page, setupText.submitSelector).fill(AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit);
    await field(page, setupText.failurePathPrefixLabel(names.invalidCredentials)).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials.pathPrefix);
    await field(page, setupText.failureSelectorLabel(names.invalidCredentials)).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials.selector);
    // 成功の条件と同じパスで、セレクタがない（同時に当たりうる）。
    await field(page, setupText.failurePathPrefixLabel(names.accountLocked)).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success.pathPrefix);
    await page.getByRole('button', { name: setupText.save }).click();
    await page.getByTestId('auth-setup-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    const lockedPath = page.locator('input[name="accountLockedPathPrefix"]');
    expect(await lockedPath.getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('.field-error').filter({ hasText: AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS }).count())
      .toBeGreaterThan(0);
    await screenshot(page, '02-auth-setup-automated-error');
    await field(page, setupText.failurePathPrefixLabel(names.accountLocked)).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked.pathPrefix);
    await field(page, setupText.failureSelectorLabel(names.accountLocked)).fill(AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked.selector);
    await page.getByRole('button', { name: setupText.save }).click();
    await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    const stored = await valueOf<{ stored: { setup: Record<string, unknown> } }>('getAuthSetupFn', 'GET', { profileId: MAIN_PROFILE });
    expect(stored.stored.setup).toMatchObject({
      maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
      automatedLogin: {
        usernameSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
        failureConditions: {
          invalidCredentials: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials,
          accountLocked: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked,
          mfaRequired: null,
          credentialExpired: null,
        },
      },
    });
  }, SCENARIO_TIMEOUT_MS);

  it('shows CREDENTIAL_MISSING on the login check screen and the automated guidance on the start screen, without a start button', async () => {
    const check = await openPage(`/login-check/${MAIN_PROFILE}`);
    expect(await check.getByTestId('login-check-guidance').textContent()).toBe(checkText.guidance);
    expect(await check.getByTestId('start-reason').getAttribute('data-reason')).toBe('CREDENTIAL_MISSING');
    expect(await check.getByTestId('login-check-start').count()).toBe(0);
    expect(await check.getByTestId('start-open-credentials').count()).toBe(1);
    await screenshot(check, '03-login-check-credential-missing');
    const start = await openPage(`/start/${MAIN_PROFILE}`);
    expect(await start.getByTestId('start-login-guidance').textContent()).toBe(LOCAL_UI_AUTH_TEXT.start.automatedGuidance);
    expect(await start.getByTestId('start-auto-login-limit').getAttribute('data-state')).toBe('ready');
    expect(await start.getByTestId('start-reason').getAttribute('data-reason')).toBe('CREDENTIAL_MISSING');
    expect(await start.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).count()).toBe(0);
    await screenshot(start, '04-start-automated');
  }, SCENARIO_TIMEOUT_MS);

  it('registers the credential with the keyboard only, after rejecting a mismatched password, and never shows the values', async () => {
    const profile = await openPage(`/profiles/${MAIN_PROFILE}`);
    await tabTo(profile, profile.getByTestId('profile-credentials').getByRole('link', { name: credentialText.profileDetail.open }));
    await profile.keyboard.press('Enter');
    await profile.waitForURL(new RegExp(`/credentials/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const page = profile;
    await page.getByTestId('credential-register-form').waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    expect(await page.getByTestId('credential-test-account-only').textContent()).toBe(credentialText.testAccountOnlyBody);
    expect(await page.getByTestId('credential-saved').getAttribute('data-saved')).toBe('no');
    expect(await page.getByTestId('credential-protection').getAttribute('data-state')).toBe('AVAILABLE');
    const username = field(page, credentialText.username);
    const password = field(page, credentialText.password);
    const confirmation = field(page, credentialText.passwordConfirmation);
    expect(await username.getAttribute('autocomplete')).toBe('off');
    expect(await username.getAttribute('spellcheck')).toBe('false');
    expect(await password.getAttribute('type')).toBe('password');
    expect(await password.getAttribute('autocomplete')).toBe('new-password');
    expect(await password.getAttribute('spellcheck')).toBe('false');
    expect(await confirmation.getAttribute('autocomplete')).toBe('new-password');
    await screenshot(page, '05-credentials-empty');

    await typeInto(page, username, USER_OK);
    await typeInto(page, password, PASS_OK);
    await typeInto(page, confirmation, PASS_TYPO);
    await page.keyboard.press('Enter');
    await page.getByTestId('credential-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejectionReason(page)).toBe('CREDENTIAL_CONFIRMATION_MISMATCH');
    expect(await page.getByTestId('credential-rejection').getAttribute('data-field')).toBe('password');
    // 送った後は、入力の値を空にする（HTML に値を残さない）。
    expect([await username.inputValue(), await password.inputValue(), await confirmation.inputValue()]).toEqual(['', '', '']);
    await snapshot(page);
    await screenshot(page, '06-credentials-mismatch');

    await typeInto(page, username, USER_OK);
    await typeInto(page, password, PASS_OK);
    await typeInto(page, confirmation, PASS_OK);
    await page.keyboard.press('Enter');
    await page.getByTestId('credential-done').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-done').getAttribute('data-notice')).toBe('registered');
    expect(await page.getByTestId('credential-saved').getAttribute('data-saved')).toBe('yes');
    expect(await page.getByTestId('credential-last-change').getAttribute('data-kind')).toBe('CREATED');
    expect(await page.getByTestId('credential-origin-state').getAttribute('data-state')).toBe('ok');
    expect(await page.getByTestId('credential-hold').getAttribute('data-held')).toBe('no');
    // 止めていないときは、変更の画面に停止の解除の選択を出さない。
    expect(await page.locator('input[name="clearHold"]').count()).toBe(0);
    await snapshot(page);
    await screenshot(page, '07-credentials-registered');
  }, SCENARIO_TIMEOUT_MS);

  it('checks the login (LOGIN_CHECK): the success result, the job kind, then AUTO_LOGIN_RATE_LIMITED with the next allowed time', async () => {
    const list = await openPage('/');
    await tabTo(list, list.locator(`tr[data-profile-id="${MAIN_PROFILE}"]`).getByRole('link', { name: checkText.profileList.loginCheck }));
    await list.keyboard.press('Enter');
    await list.waitForURL(new RegExp(`/login-check/${MAIN_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await list.getByTestId('login-check-start').waitFor({ timeout: UI_TIMEOUT_MS });
    await screenshot(list, '08-login-check-ready');
    const postsBefore = nonReadRequests().length;
    const jobId = await startLoginCheckFromPage(list);
    await waitForResultOnPage(list, 'SUCCEEDED');
    expect(await list.getByTestId('job-kind').getAttribute('data-kind')).toBe('LOGIN_CHECK');
    expect(await list.getByTestId('job-auto-login-submitted').getAttribute('data-submitted')).toBe('YES');
    expect(await list.getByTestId('job-auto-login-description').textContent()).toBe(AUTOMATED_LOGIN_RESULT_CATALOG.SUCCEEDED.description);
    expect(await list.getByTestId('job-artifacts-empty').count()).toBe(0);
    await screenshot(list, '09-job-login-check-succeeded');
    expect(await waitForJobEnd(jobId)).toMatchObject({ jobKind: 'LOGIN_CHECK', autoLogin: { result: 'SUCCEEDED', submitted: 'YES' } });
    // 送ったのは、ログインの POST の 1 回だけ。
    expect(nonReadRequests().slice(postsBefore)).toEqual([`POST ${site().authPath('success')}`]);

    const again = await openPage(`/login-check/${MAIN_PROFILE}`);
    expect(await again.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTO_LOGIN_RATE_LIMITED');
    expect(await again.getByTestId('start-next-allowed-at').count()).toBe(1);
    expect(await again.getByTestId('login-check-start').count()).toBe(0);
    await screenshot(again, '10-login-check-rate-limited');
    const start = await openPage(`/start/${MAIN_PROFILE}`);
    expect(await start.getByTestId('start-auto-login-limit').getAttribute('data-state')).toBe('waiting');
    // 直接の開始の要求も、ジョブの管理が上限で拒み、次に始められる日時を返す。
    const rejected = await valueOf<{ ok: boolean; reason: string; nextAllowedAt: string }>(
      'startLoginCheckFn', 'POST', { profileId: MAIN_PROFILE, expectedRevision: FIRST_REVISION },
    );
    expect(rejected).toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED' });
    expect(rejected.nextAllowedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  }, SCENARIO_TIMEOUT_MS);

  it('shows a failed login check with what the person should do, holds the automated login, and clears the hold together with a change', async () => {
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: INVALID_PROFILE, username: USER_OK, password: PASS_WRONG, passwordConfirmation: PASS_WRONG,
    })).toMatchObject({ ok: true, credential: { lastChangeKind: 'CREATED' } });
    const check = await openPage(`/login-check/${INVALID_PROFILE}`);
    const jobId = await startLoginCheckFromPage(check);
    await waitForResultOnPage(check, 'INVALID_CREDENTIALS');
    expect(await check.getByTestId('job-failure').getAttribute('data-reason')).toBe('INVALID_CREDENTIALS');
    expect(await check.getByText(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.INVALID_CREDENTIALS.action).count()).toBe(1);
    await screenshot(check, '11-job-login-check-invalid');
    expect(await waitForJobEnd(jobId)).toMatchObject({ autoLogin: { result: 'INVALID_CREDENTIALS', submitted: 'YES' } });

    const held = await openPage(`/login-check/${INVALID_PROFILE}`);
    expect(await held.getByTestId('login-check-hold').getAttribute('data-reason')).toBe('INVALID_CREDENTIALS');
    expect(await held.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTO_LOGIN_HELD');
    expect(await held.getByTestId('login-check-start').count()).toBe(0);
    await screenshot(held, '12-login-check-held');

    const page = await openPage(`/credentials/${INVALID_PROFILE}`);
    expect(await page.getByTestId('credential-hold').getAttribute('data-held')).toBe('yes');
    await page.getByLabel(credentialText.change.changePassword).check();
    await field(page, credentialText.change.newPassword).fill(PASS_OK);
    await field(page, credentialText.change.newPasswordConfirmation).fill(PASS_OK);
    await page.getByLabel(credentialText.clearHold.label).check();
    await page.getByTestId('credential-change-submit').click();
    await page.getByTestId('credential-done').first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-done').first().getAttribute('data-notice')).toBe('changedAndHoldCleared');
    expect(await page.getByText(credentialText.clearHold.done).count()).toBe(1);
    expect(await page.getByTestId('credential-last-change').getAttribute('data-kind')).toBe('PASSWORD_CHANGED');
    expect(await page.getByTestId('credential-hold').getAttribute('data-held')).toBe('no');
    await snapshot(page);
    await screenshot(page, '13-credentials-changed-and-hold-cleared');
    const after = await openPage(`/login-check/${INVALID_PROFILE}`);
    // 解いても、自動ログインどうしの最小の間隔は守る。
    expect(await after.getByTestId('login-check-hold').count()).toBe(0);
    expect(await after.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTO_LOGIN_RATE_LIMITED');
  }, SCENARIO_TIMEOUT_MS);

  it('refuses to change or delete the credential while a job of the profile runs (CREDENTIAL_IN_USE), then clears the hold with the dialog', async () => {
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: SLOW_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toMatchObject({ ok: true });
    const startResult = await valueOf<{ ok: boolean; jobId: string }>('startLoginCheckFn', 'POST', {
      profileId: SLOW_PROFILE, expectedRevision: FIRST_REVISION,
    });
    expect(startResult.ok).toBe(true);
    await expect.poll(() => slowPosts, { timeout: JOB_TIMEOUT_MS, interval: POLL_MS }).toBeGreaterThan(0);
    await recordDescendants();

    const page = await openPage(`/credentials/${SLOW_PROFILE}`);
    expect(await page.getByTestId('credential-in-use').count()).toBe(1);
    await page.getByLabel(credentialText.change.changeUsername).check();
    await field(page, credentialText.change.newUsername).fill(USER_OTHER);
    await page.getByTestId('credential-change-submit').click();
    await page.getByTestId('credential-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejectionReason(page)).toBe('CREDENTIAL_IN_USE');
    expect(await page.getByText(CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS.CREDENTIAL_IN_USE.description).count()).toBe(1);
    await snapshot(page);
    await screenshot(page, '14-credentials-in-use');
    expect(await valueOf('removeCredentialFn', 'POST', { profileId: SLOW_PROFILE }))
      .toEqual({ ok: false, reason: 'CREDENTIAL_IN_USE', field: null });
    expect(await valueOf('getCredentialPageFn', 'GET', { profileId: SLOW_PROFILE })).toMatchObject({
      inUse: true,
      credential: { credentialRevision: 1, lastChangeKind: 'CREATED' },
    });

    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: startResult.jobId, force: false })).toMatchObject({ ok: true });
    const ended = await waitForJobEnd(startResult.jobId);
    expect(ended.autoLogin?.submitted).toBe('YES');

    const check = await openPage(`/login-check/${SLOW_PROFILE}`);
    await check.getByTestId('login-check-hold').waitFor({ timeout: UI_TIMEOUT_MS });
    await tabTo(check, check.getByTestId('login-check-clear-hold'));
    await check.keyboard.press('Enter');
    const dialog = check.getByRole('dialog', { name: checkText.hold.dialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await screenshot(check, '15-login-check-clear-hold-dialog');
    // 開いたときは「やめる」にフォーカスがある。Tab で「再び許す」へ移って押す。
    await check.keyboard.press('Tab');
    await check.keyboard.press('Enter');
    await check.getByTestId('login-check-hold-notice').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await check.getByTestId('login-check-hold-notice').getAttribute('data-notice')).toBe('cleared');
    await expect.poll(() => check.getByTestId('login-check-hold').count(), { timeout: UI_TIMEOUT_MS, interval: POLL_MS }).toBe(0);
    await snapshot(check);
    await screenshot(check, '16-login-check-hold-cleared');
  }, SCENARIO_TIMEOUT_MS);

  it('asks to replace both values when the login origin changed, replaces them, and deletes the credential after the dialog', async () => {
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: automatedSetupOf(MAIN_PROFILE, 'success', site().originB) })).toMatchObject({ ok: true });
    const page = await openPage(`/credentials/${MAIN_PROFILE}`);
    expect(await page.getByTestId('credential-origin-state').getAttribute('data-state')).toBe('stale');
    expect(await page.getByTestId('credential-replace-needed').count()).toBe(1);
    expect(await page.getByTestId('credential-change-form').count()).toBe(0);
    await screenshot(page, '17-credentials-replace-needed');
    await field(page, credentialText.username).fill(USER_OK);
    await field(page, credentialText.password).fill(PASS_OK);
    await field(page, credentialText.passwordConfirmation).fill(PASS_OK);
    await page.getByTestId('credential-replace-submit').click();
    await page.getByTestId('credential-done').first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-done').first().getAttribute('data-notice')).toBe('replaced');
    expect(await page.getByTestId('credential-last-change').getAttribute('data-kind')).toBe('BOTH_CHANGED');
    expect(await page.getByTestId('credential-origin-state').getAttribute('data-state')).toBe('ok');
    await snapshot(page);

    await tabTo(page, page.getByTestId('credential-remove'));
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: credentialText.remove.title }).waitFor({ timeout: UI_TIMEOUT_MS });
    await screenshot(page, '18-credentials-remove-dialog');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="credential-done"][data-notice="removed"]').waitFor({ timeout: UI_TIMEOUT_MS });
    // DEF-071: 知らせが先に出て、画面の値の読み直しが後になることがある。保存の有無が「なし」になるまで待ってから確かめる（期待は同じ）。
    await page.locator('[data-testid="credential-saved"][data-saved="no"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-saved').getAttribute('data-saved')).toBe('no');
    await snapshot(page);
    await screenshot(page, '19-credentials-removed');
    const check = await openPage(`/login-check/${MAIN_PROFILE}`);
    expect(await check.getByTestId('start-reason').getAttribute('data-reason')).toBe('CREDENTIAL_MISSING');
  }, SCENARIO_TIMEOUT_MS);

  it('does not show the credential screen for a manual login profile, and rejects its direct requests', async () => {
    const page = await openPage(`/credentials/${MANUAL_PROFILE}`);
    expect(await page.getByTestId('credential-not-eligible').count()).toBe(1);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    expect(await page.locator('form').count()).toBe(0);
    const detail = await openPage(`/profiles/${MANUAL_PROFILE}`);
    expect(await detail.getByTestId('profile-credentials').count()).toBe(0);
    const rejected = { ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null };
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: MANUAL_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toEqual(rejected);
    // T26g-2 round 1: 削除は資格で拒まない。ファイルがなければ `CREDENTIAL_MISSING`（残ったファイルを消す場面は下の T26g-2 の検査）。
    expect(await valueOf('removeCredentialFn', 'POST', { profileId: MANUAL_PROFILE }))
      .toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', field: null });
    expect(await valueOf('clearAutoLoginHoldFn', 'POST', { profileId: MANUAL_PROFILE })).toEqual(rejected);
    const check = await openPage(`/login-check/${MANUAL_PROFILE}`);
    expect(await check.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
    expect(await check.getByTestId('login-check-start').count()).toBe(0);
    expect(await valueOf('startLoginCheckFn', 'POST', { profileId: MANUAL_PROFILE, expectedRevision: FIRST_REVISION }))
      .toMatchObject({ ok: false, reason: 'AUTH_STRATEGY_NOT_EXECUTABLE' });
  }, SCENARIO_TIMEOUT_MS);

  // T26g-2（T26R の I1）: プロファイルの取り消しで、保存した資格情報を消す。ジョブが動いていて消せないときは、取り消しは成功のまま、
  // 資格情報の画面から消すよう案内する。
  it('T26g-2: retiring removes the saved credential, and keeps the retirement with a guidance when a running job prevents the removal', async () => {
    const credentialPath = (profileId: string): string => credentialFilePathFor(resolveCredentialDirectory(rootOf()), profileId);
    const retireWithKeyboard = async (page: Page): Promise<void> => {
      await tabTo(page, page.getByRole('button', { name: LOCAL_UI_TEXT.retireDialog.open }));
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: LOCAL_UI_TEXT.retireDialog.title });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain(LOCAL_UI_TEXT.retireDialog.body);
      await tabTo(page, dialog.getByRole('button', { name: LOCAL_UI_TEXT.retireDialog.confirm }));
      await page.keyboard.press('Enter');
      await page.getByText(LOCAL_UI_TEXT.retireDialog.done).waitFor({ timeout: UI_TIMEOUT_MS });
      await snapshot(page);
    };
    for (const [profileId, outcome] of [[RETIRE_PROFILE, 'success'], [RETIRE_RUNNING_PROFILE, 'slow']] as const) {
      expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(profileId, 'AUTOMATED_LOGIN') })).toMatchObject({ ok: true });
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: automatedSetupOf(profileId, outcome) })).toMatchObject({ ok: true });
      expect(await valueOf('registerCredentialFn', 'POST', {
        profileId, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
      })).toMatchObject({ ok: true });
      expect(existsSync(credentialPath(profileId))).toBe(true);
    }

    // ジョブがなければ、取り消しと一緒に消える（案内は出ない）。
    const page = await openPage(`/profiles/${RETIRE_PROFILE}`);
    await retireWithKeyboard(page);
    expect(await page.getByTestId('profile-credential-not-removed').count()).toBe(0);
    expect(existsSync(credentialPath(RETIRE_PROFILE))).toBe(false);
    expect(await valueOf('getCredentialPageFn', 'GET', { profileId: RETIRE_PROFILE })).toMatchObject({ credential: null });

    // ジョブが動いている間は消せない。取り消しは成功のまま、資格情報の画面から消すよう案内する。
    const postsBefore = slowPosts;
    const startResult = await valueOf<{ ok: boolean; jobId: string }>('startLoginCheckFn', 'POST', {
      profileId: RETIRE_RUNNING_PROFILE, expectedRevision: FIRST_REVISION,
    });
    expect(startResult.ok).toBe(true);
    await expect.poll(() => slowPosts, { timeout: JOB_TIMEOUT_MS, interval: POLL_MS }).toBeGreaterThan(postsBefore);
    await recordDescendants();
    const running = await openPage(`/profiles/${RETIRE_RUNNING_PROFILE}`);
    await retireWithKeyboard(running);
    await running.getByTestId('profile-credential-not-removed').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await running.getByTestId('profile-credential-not-removed').textContent()).toBe(LOCAL_UI_TEXT.retireDialog.credentialNotRemoved);
    expect(await valueOf('getProfileFn', 'GET', { profileId: RETIRE_RUNNING_PROFILE })).toMatchObject({ status: 'RETIRED' });
    expect(existsSync(credentialPath(RETIRE_RUNNING_PROFILE))).toBe(true);
    await screenshot(running, '22-retired-credential-not-removed');
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: startResult.jobId, force: false })).toMatchObject({ ok: true });
    await waitForJobEnd(startResult.jobId);

    // 案内の先の資格情報の画面から消せる。
    await running.getByRole('link', { name: credentialText.profileDetail.open }).first().click();
    await running.waitForURL(new RegExp(`/credentials/${RETIRE_RUNNING_PROFILE}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await tabTo(running, running.getByTestId('credential-remove'));
    await running.keyboard.press('Enter');
    await running.getByRole('dialog', { name: credentialText.remove.title }).waitFor({ timeout: UI_TIMEOUT_MS });
    await running.keyboard.press('Tab');
    await running.keyboard.press('Enter');
    await running.locator('[data-testid="credential-done"][data-notice="removed"]').waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(running);
    expect(existsSync(credentialPath(RETIRE_RUNNING_PROFILE))).toBe(false);
  }, SCENARIO_TIMEOUT_MS);

  // T26g-2 round 1（設計者の判断 (3)）: 自動ログインでなくなったプロファイルに残った資格情報は、資格情報の画面で削除の操作だけを出し、消せる。
  it('T26g-2: shows only the removal for a credential left on a profile that is no longer an automated login profile, and removes it', async () => {
    const credentialPath = credentialFilePathFor(resolveCredentialDirectory(rootOf()), LEFTOVER_PROFILE);
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(LEFTOVER_PROFILE, 'AUTOMATED_LOGIN') })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: automatedSetupOf(LEFTOVER_PROFILE, 'success') })).toMatchObject({ ok: true });
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: LEFTOVER_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toMatchObject({ ok: true });
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...profileDocument(LEFTOVER_PROFILE, 'MANUAL_SESSION'), revision: FIRST_REVISION + 1 },
      expectedRevision: FIRST_REVISION,
    })).toMatchObject({ ok: true });
    expect(existsSync(credentialPath)).toBe(true);

    const page = await openPage(`/credentials/${LEFTOVER_PROFILE}`);
    expect(await page.getByTestId('credential-not-eligible').count()).toBe(1);
    expect(await page.getByTestId('credential-leftover').textContent()).toBe(credentialText.leftoverNotEligible);
    expect(await page.getByTestId('credential-remove').count()).toBe(1);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    expect(await page.locator('form').count()).toBe(0);
    await screenshot(page, '23-credentials-leftover');
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: LEFTOVER_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toEqual({ ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null });

    await tabTo(page, page.getByTestId('credential-remove'));
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: credentialText.remove.title }).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="credential-done"][data-notice="removed"]').waitFor({ timeout: UI_TIMEOUT_MS });
    // DEF-071 と同じ揺らぎを避ける: 残った資格情報の知らせが消えるまで待ってから確かめる（期待は同じ）。
    await page.getByTestId('credential-leftover').waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('credential-leftover').count()).toBe(0);
    expect(await page.getByTestId('credential-remove').count()).toBe(0);
    await snapshot(page);
    expect(existsSync(credentialPath)).toBe(false);
  }, SCENARIO_TIMEOUT_MS);

  // T26g-3（T26g-2 の発見 2）: 認証の方式が自動ログインでなくても、資格情報のファイルが残っていれば、プロファイルの詳細の画面に資格情報の画面への
  // リンクを出す（判定はサーバ）。残っていなければ出さない。
  it('T26g-3: links the profile detail to the credential screen when a credential is left on a profile that is not an automated login profile', async () => {
    const plain = await openPage(`/profiles/${MANUAL_PROFILE}`);
    expect(await plain.getByTestId('profile-credential-leftover').count()).toBe(0);

    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(LEFTOVER_LINK_PROFILE, 'AUTOMATED_LOGIN') })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: automatedSetupOf(LEFTOVER_LINK_PROFILE, 'success') })).toMatchObject({ ok: true });
    expect(await valueOf('registerCredentialFn', 'POST', {
      profileId: LEFTOVER_LINK_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toMatchObject({ ok: true });
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...profileDocument(LEFTOVER_LINK_PROFILE, 'MANUAL_SESSION'), revision: FIRST_REVISION + 1 },
      expectedRevision: FIRST_REVISION,
    })).toMatchObject({ ok: true });

    const page = await openPage(`/profiles/${LEFTOVER_LINK_PROFILE}`);
    expect(await page.getByTestId('profile-credentials').count()).toBe(0);
    expect(await page.getByTestId('profile-credential-leftover').textContent()).toContain(credentialText.profileDetail.leftover);
    await screenshot(page, '24-profile-credential-leftover');
    await tabTo(page, page.getByTestId('profile-credential-leftover').getByRole('link', { name: credentialText.profileDetail.open }));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/credentials/${LEFTOVER_LINK_PROFILE}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('credential-leftover').waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(page);
  }, SCENARIO_TIMEOUT_MS);

  it('keeps the CSRF protection (a cross-site POST is 403) and rejects inputs that do not match the schemas with 400', async () => {
    const before = await valueOf<{ credential: unknown }>('getCredentialPageFn', 'GET', { profileId: INVALID_PROFILE });
    const posts: readonly (readonly [string, unknown])[] = [
      ['registerCredentialFn', { profileId: MAIN_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK }],
      ['changeCredentialFn', { profileId: INVALID_PROFILE, username: USER_OTHER, password: null, passwordConfirmation: null, clearHold: false }],
      ['replaceCredentialFn', { profileId: INVALID_PROFILE, username: USER_OTHER, password: PASS_OK, passwordConfirmation: PASS_OK, clearHold: true }],
      ['removeCredentialFn', { profileId: INVALID_PROFILE }],
      ['clearAutoLoginHoldFn', { profileId: INVALID_PROFILE }],
      ['startLoginCheckFn', { profileId: INVALID_PROFILE, expectedRevision: FIRST_REVISION }],
    ];
    for (const [name, data] of posts) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get(name) ?? ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', 'sec-fetch-site': 'cross-site', origin: started().origin },
        body: encodeServerFunctionPayload(data),
      });
      responseBodies.push(response.body);
      expect(response.status, name).toBe(STATUS.FORBIDDEN);
    }
    const tooLong = 'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH + 1);
    const invalid: readonly (readonly [string, unknown])[] = [
      ['registerCredentialFn', { profileId: MAIN_PROFILE, username: tooLong, password: PASS_OK, passwordConfirmation: PASS_OK }],
      ['registerCredentialFn', { profileId: MAIN_PROFILE, username: USER_OK, password: PASS_OK }],
      ['registerCredentialFn', { profileId: MAIN_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK, extra: 1 }],
      ['changeCredentialFn', { profileId: INVALID_PROFILE, username: USER_OTHER, password: null, passwordConfirmation: null }],
      ['replaceCredentialFn', { profileId: INVALID_PROFILE, username: 1, password: PASS_OK, passwordConfirmation: PASS_OK, clearHold: false }],
      ['startLoginCheckFn', { profileId: INVALID_PROFILE, expectedRevision: 0 }],
    ];
    for (const [name, data] of invalid) {
      const result = await callFunction(name, 'POST', data);
      expect(result.response.status, name).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('getCredentialPageFn', 'GET', { profileId: INVALID_PROFILE })).toEqual(before);
    expect(await valueOf('getCredentialPageFn', 'GET', { profileId: MAIN_PROFILE })).toMatchObject({ credential: null });
  }, SCENARIO_TIMEOUT_MS);

  it('never shows the values: the pages, the responses, the server output, the control data and the credential files', () => {
    expect(htmlSnapshots.length).toBeGreaterThan(10);
    expect(responseBodies.length).toBeGreaterThan(10);
    expect(htmlSnapshots.filter(leaks).length).toBe(0);
    expect(responseBodies.filter(leaks).length).toBe(0);
    expect(leaks(started().output())).toBe(false);
    // フォルダの下のすべてのファイル（ZIP の中を含む）を、UTF-8 と UTF-16LE で探す（CCX-16。CC-066。`helpers/secret-markers.ts`）。
    const dataFiles = filesUnder(`${rootOf()}/${CONTROL_DATA_DIRECTORY_NAME}`, 'local-data');
    expect(dataFiles.some(({ place }) => place.endsWith('-wal'))).toBe(true);
    expect(leakedPlaces(dataFiles, MARKERS)).toEqual([]);
    const credentialFiles = filesUnder(`${rootOf()}/local`, 'local');
    console.info(`[CCX-16] t26e searched files: ${dataFiles.length} + ${credentialFiles.length}`);
    expect(credentialFiles.length).toBeGreaterThan(0);
    expect(leakedPlaces(credentialFiles, MARKERS)).toEqual([]);
    // 自動ログインは、手動のログインの段へ切り替えない。
    expect(existsSync(`${recordDirectory}/${MANUAL_LOGIN_STAGE_RECORD}`)).toBe(false);
    expect(existsSync(`${recordDirectory}/${WORKER_RECORD_FILES.ipc}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Windows でないとき（画面のサーバの `process.platform` を、テストだけの前処理で差し替える）と、起動のときの一時のファイルの片付け
// ---------------------------------------------------------------------------------------------------------------

/** 画面のサーバの process の中で、`process.platform` を Windows でない値にするテストだけの前処理（`node --import`）。 */
const PLATFORM_OVERRIDE_SOURCE = "Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: true });\n";

describe('T26e: on a platform that is not Windows (the server judges it), and the startup cleanup', () => {
  let linuxRoot: TemporaryUiRoot | undefined;
  let linuxServer: StartedServer | undefined;
  let linuxBrowser: Browser | undefined;
  let linuxCookie = '';
  let linuxIds: ReadonlyMap<string, string> = new Map();
  const leftovers: string[] = [];
  let keptFile = '';

  const linuxCall = async (name: string, method: 'GET' | 'POST', data?: unknown): Promise<unknown> => {
    if (linuxServer === undefined) {
      throw new Error('サーバが起動していない');
    }
    const result = await callServerFunction({ port: linuxServer.port, origin: linuxServer.origin, cookie: linuxCookie, ids: linuxIds }, name, method, data);
    expect(result.response.status, name).toBe(STATUS.OK);
    expect(leaks(result.response.body)).toBe(false);
    return result.value;
  };

  beforeAll(async () => {
    linuxRoot = createTemporaryUiRoot('built');
    // 前の画面のサーバが残した、書きかけの一時のファイル（起動のときに消える）と、ほかのファイル（残る）。
    const secrets = `${linuxRoot.root}/local/secrets`;
    mkdirSync(secrets, { recursive: true });
    leftovers.push(temporaryPathFor(`${secrets}/${LINUX_PROFILE}.credential.json`), temporaryPathFor(`${secrets}/other.credential.json`));
    for (const path of leftovers) {
      writeFileSync(path, '{}');
    }
    keptFile = `${secrets}/notes.txt`;
    writeFileSync(keptFile, 'kept');
    const preload = `${linuxRoot.root}/t26e-platform-override.mjs`;
    writeFileSync(preload, PLATFORM_OVERRIDE_SOURCE, 'utf8');
    linuxIds = readServerFunctionIds(`${linuxRoot.root}/apps/local-ui/dist/server/server.js`);
    linuxServer = await startLauncherWithNodeArguments(linuxRoot, await findFreePort(), ['--import', pathToFileURL(preload).href]);
    const exchange = await rawRequest(linuxServer.port, `${linuxServer.tokenUrl.pathname}${linuxServer.tokenUrl.search}`);
    linuxCookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
    linuxBrowser = await launchHeadlessChromium();
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await linuxBrowser?.close();
    await stopServer(linuxServer);
    linuxRoot?.remove();
  });

  it('removes the temporary files left in the credential folder at startup, and keeps the other files', () => {
    expect(leftovers.filter((path) => existsSync(path))).toEqual([]);
    expect(existsSync(keptFile)).toBe(true);
  });

  it('shows "not available in this environment" judged on the server, and rejects saving', async () => {
    if (linuxRoot === undefined || linuxServer === undefined || linuxBrowser === undefined) {
      throw new Error('準備ができていない');
    }
    const config = `config/targets/${LINUX_PROFILE}.json`;
    writeFileSync(`${linuxRoot.root}/${config}`, `${JSON.stringify({
      target: { id: LINUX_PROFILE },
      site: { startUrl: 'http://127.0.0.1:9/home', allowedOrigins: ['http://127.0.0.1:9'] },
      crawl: { minNavigationIntervalMs: 0, maxPages: 1 },
      output: { directory: 't26e-output-linux' },
    }, null, 2)}\n`, 'utf8');
    expect(await linuxCall('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: LINUX_PROFILE,
        revision: FIRST_REVISION,
        targetConfigPath: config,
        environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'AUTOMATED_LOGIN',
        approvedTestOrigins: ['http://127.0.0.1:9'],
        environmentEvidenceRef: 't26e-evidence',
      },
    })).toMatchObject({ ok: true });
    expect(await linuxCall('saveAuthSetupFn', 'POST', {
      setup: {
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
        profileId: LINUX_PROFILE,
        profileRevision: FIRST_REVISION,
        loginStartUrl: 'http://127.0.0.1:9/login',
        loginPostEndpoints: [{ origin: 'http://127.0.0.1:9', path: '/login' }],
        successCondition: { pathPrefix: '/home', selector: '#home' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: ['/logout'],
        auditPathPrefixes: ['/home'],
        maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
        allowedIdpOrigins: [],
        automatedLogin: {
          usernameSelector: '#user',
          passwordSelector: '#pass',
          submitSelector: '#go',
          failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
        },
      },
    })).toMatchObject({ ok: true });
    expect(await linuxCall('environmentStatusFn', 'GET')).toMatchObject({ credentialEnvironment: 'NOT_WINDOWS' });
    expect(await linuxCall('registerCredentialFn', 'POST', {
      profileId: LINUX_PROFILE, username: USER_OK, password: PASS_OK, passwordConfirmation: PASS_OK,
    })).toEqual({ ok: false, reason: 'CREDENTIAL_PLATFORM_UNSUPPORTED', field: null });
    expect(existsSync(`${linuxRoot.root}/local/secrets/${LINUX_PROFILE}.credential.json`)).toBe(false);
    expect(await linuxCall('startLoginCheckFn', 'POST', { profileId: LINUX_PROFILE, expectedRevision: FIRST_REVISION }))
      .toMatchObject({ ok: false, reason: 'CREDENTIAL_MISSING' });

    const linuxContext = await linuxBrowser.newContext();
    try {
      const page = await linuxContext.newPage();
      await page.goto(linuxServer.tokenUrl.href, { waitUntil: 'networkidle' });
      await page.goto(`${linuxServer.origin}/credentials/${LINUX_PROFILE}`, { waitUntil: 'networkidle' });
      expect(await page.getByTestId('credential-unavailable').getAttribute('data-state')).toBe('NOT_WINDOWS');
      expect(await page.getByTestId('credential-unavailable').textContent()).toBe(CREDENTIAL_ENVIRONMENT_CATALOG.NOT_WINDOWS.description);
      expect(await page.getByTestId('credential-protection').getAttribute('data-state')).toBe('NOT_WINDOWS');
      expect(await page.getByTestId('credential-register-form').count()).toBe(0);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      expect(leaks(await page.content())).toBe(false);
      await screenshot(page, '20-credentials-not-windows');
      await page.goto(`${linuxServer.origin}/environment`, { waitUntil: 'networkidle' });
      expect(await page.getByTestId('environment-credential-protection').getAttribute('data-state')).toBe('NOT_WINDOWS');
      await screenshot(page, '21-environment-not-windows');
    } finally {
      await linuxContext.close();
    }
    expect(leaks(linuxServer.output())).toBe(false);
  }, SCENARIO_TIMEOUT_MS);
});
