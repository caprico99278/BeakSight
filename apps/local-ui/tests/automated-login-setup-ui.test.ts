/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの成功の後の「次から自動でログインする」から、1 つの画面（資格情報の画面の、手動のログインの
 * プロファイルの形）で、認証の方式の変更・ログインの 3 つのセレクタ・資格情報を、確認 1 回で保存する。ビルドした画面のサーバ（一時の root）と headless の
 * Chromium で、本物のジョブの管理と確かめる。監査のワーカーは偽のワーカー（`auth-manual-confirm`。サイトに接続しない）に替える。偽のワーカーは、
 * 「ログインを終えた」を受けたら、通した送信の一覧とログインの段の観察（ログインの欄の案つき）で認証済みにする。
 * - 案の入った画面: 3 つのセレクタに案が入り、推測の印と根拠が付く。人が直すと「人が決める」の印になる。
 * - 確認のダイアログ: 変えるもの（方式・セレクタ・回数の上限・資格情報）と、改訂が進むこと。
 * - 保存の後: 自動ログインのプロファイルになり、資格情報を保存した状態と、「ログインを確かめる」のボタンを出す（自動では始めない）。
 * - 拒否（2 回入れたパスワードの違い）: 理由と、何も保存していないこと。入力は空にする。
 * - パスワードは画面に出ない: 目印の値が、ページの HTML、Server Function の応答、管理データのファイルと WAL、偽のワーカーが受けたメッセージにない。
 * 資格情報は、本物の DPAPI（Windows だけ。一時の root の中の資格情報のフォルダ）で暗号化する。Windows でなければ、理由を出して飛ばす。値は匿名
 * （`example.invalid` とループバック）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { credentialFilePathFor, resolveCredentialDirectory } from '../../../src/control/credentials/credential-store.js';
import { CONTROL_DATA_DIRECTORY_NAME } from '../../../src/control/store/database-path.js';
import { DRAFT_VALUE_ORIGIN_CATALOG } from '../../../src/presentation/catalog.js';
import {
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker, type FakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
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
import { filesUnder, leakedPlaces } from './helpers/secret-markers.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions, type ServerFunctionJobWaitTiming } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the one screen saves the credential with the real DPAPI, which exists only on Windows';
const UI_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 30_000, stepMs: 100 });
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
const PROFILE_ID = 'fm2e-manual-ui';
const FIRST_REVISION = 1;
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
const STATUS_OK = 200;
const SCREENSHOT_DIRECTORY = process.env['FM2E_SCREENSHOT_DIR'];
/** 案（偽のワーカーが、ログインの段の始めに検出した形で送る）と、人が直す値。 */
const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });
const EDITED_SUBMIT = 'button[type="submit"]';

/** 実行ごとの目印（値を出力しない。比べるときは真偽だけを見る）。 */
const RUN = randomUUID();
const USER = `fm2e-user-${RUN}`;
const PASS = `fm2e-pass-${RUN}`;
const PASS_TYPO = `fm2e-typo-${RUN}`;
const MARKERS = Object.freeze([USER, PASS, PASS_TYPO]);
const leaks = (value: string): boolean => MARKERS.some((marker) => value.includes(marker));

/** 手動のログインの段で通した送信（token の送信だけ）と、観察（成功の鍵の形と、ログインの欄の案）。 */
const PASSED_REQUESTS = Object.freeze({
  requests: [{
    origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
    query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
  }],
  unlisted: 0,
});
const LOGIN_OBSERVATION = Object.freeze({
  storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 },
  loginFields: FIELDS,
});

const text = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let worker: FakeWorker | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const htmlSnapshots: string[] = [];
const responseBodies: string[] = [];

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
  // Server Function の応答の本文を集める（目印がないことを確かめる）。
  onPageCreated: (page) => {
    page.on('response', (response) => {
      if (response.url().includes('/_serverFn/')) {
        void response.text().then((body) => responseBodies.push(body), () => undefined);
      }
    });
  },
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(STATUS_OK);
  responseBodies.push(JSON.stringify(result.value));
  return result.value as T;
};

interface JobValue {
  readonly active: boolean;
  readonly lastAuthState: string | null;
  readonly loginStage: { readonly autoRegistration?: { readonly result: string } } | null;
}

/** ジョブの値を 1 回読む（応答の本文は `valueOf` が集める）。待つのは `waitForJobViaServerFunctions`。 */
const readJob = (jobId: string): Promise<JobValue | null> => valueOf<JobValue | null>('getAuditJobFn', 'GET', { jobId });

/** ページの HTML を覚える（最後に目印がないことを確かめる）。 */
const snapshot = async (page: Page): Promise<void> => {
  htmlSnapshots.push(await page.content());
};

/** 手動のログインの認証の設定（版 2。フォームの送信のログイン）。 */
const formSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

beforeAll(async () => {
  if (!IS_WINDOWS) return;
  root = createTemporaryUiRoot('built');
  writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
  const directory = `${root.root}/fake-workers/fm2e`;
  mkdirSync(directory, { recursive: true });
  worker = writeFakeWorker(directory, 'auth-manual-confirm', fakeWorkerValuesOf({ runId: 'RUN-20261022000000', otherRunId: 'RUN-20261022000999' }, {
    heartbeatIntervalMs: 200,
    loginStage: { passedRequests: PASSED_REQUESTS, loginObservation: LOGIN_OBSERVATION },
  }));
  writeFileSync(`${root.root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
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
    schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: FIRST_REVISION, targetConfigPath: `config/targets/${PROFILE_ID}.json`,
    environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
  };
  expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: formSetup })).toMatchObject({ ok: true });
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  if (IS_WINDOWS) await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('FM2e: the one screen of the automated login', () => {
  it.skipIf(!IS_WINDOWS)(`shows the proposals, confirms the changes once, saves, and offers the login check (${SKIP_REASON} otherwise)`, async () => {
    // 手動のログインのジョブ（「ログインを終えた」→ 止める）。ジョブの管理が背後で認証の設定を登録し（改訂 2）、観察の欄の案はジョブの行に残る。
    const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION, startNew: true });
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
    expect(await valueOf('confirmManualLoginFn', 'POST', { jobId: start.jobId })).toEqual({ ok: true });
    await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
    await waitForJobViaServerFunctions(readJob, start.jobId, (job) => !job.active && job.loginStage?.autoRegistration?.result === 'SAVED', JOB_WAIT);
    const revision = FIRST_REVISION + 1;

    // ジョブの画面の「次から自動でログインする」から、1 つの画面へ進む。
    const jobPage = await openPage(`/jobs/${start.jobId}`);
    const offer = jobPage.getByTestId('job-login-setup-automated-login');
    await offer.waitFor({ timeout: UI_TIMEOUT_MS });
    await offer.getByTestId('automated-login-offer-setup').click();
    await jobPage.waitForURL(`**/credentials/${PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
    const form = jobPage.getByTestId('automated-login-setup');
    await form.waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(jobPage);
    // 1 つの画面を出すときは、「資格情報を使わない」の知らせを出さない。
    expect(await jobPage.getByTestId('credential-not-eligible').count()).toBe(0);

    // 案の入った画面: 3 つのセレクタに案と推測の印。方式は今の方式 → 自動ログイン。
    const method = form.getByTestId('automated-login-setup-method');
    expect(await method.locator('[data-item="before"]').getAttribute('data-auth')).toBe('MANUAL_SESSION');
    expect(await method.locator('[data-item="after"]').getAttribute('data-auth')).toBe('AUTOMATED_LOGIN');
    for (const [field, value] of Object.entries(FIELDS)) {
      const row = form.locator(`[data-testid="automated-login-setup-selector"][data-field="${field}"]`);
      expect(await row.locator('input').inputValue(), field).toBe(value);
      const mark = row.getByTestId('automated-login-setup-origin');
      expect(await mark.getAttribute('data-origin'), field).toBe('INFERRED');
      expect(await mark.getAttribute('data-ground'), field).toBe('LOGIN_FIELD_SINGLE_CANDIDATE');
      expect(await mark.textContent(), field).toContain(DRAFT_VALUE_ORIGIN_CATALOG.INFERRED.label);
    }
    await screenshot(jobPage, 'fm2e-01-proposals');

    // 人が直すと「人が決める」の印。
    const submitRow = form.locator('[data-testid="automated-login-setup-selector"][data-field="submit"]');
    await submitRow.locator('input').fill(EDITED_SUBMIT);
    expect(await submitRow.getByTestId('automated-login-setup-origin').getAttribute('data-origin')).toBe('HUMAN');

    // 拒否（2 回入れたパスワードの違い）: 理由を出し、何も保存しない。入力は空にする。
    await form.locator('input[name="username"]').fill(USER);
    await form.locator('input[name="password"]').fill(PASS);
    await form.locator('input[name="passwordConfirmation"]').fill(PASS_TYPO);
    await form.getByTestId('automated-login-setup-review').click();
    const dialog = jobPage.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.dialog.confirm }).click();
    const rejection = form.getByTestId('automated-login-setup-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('CREDENTIAL_CONFIRMATION_MISMATCH');
    expect(await rejection.textContent()).toBe(CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS.CREDENTIAL_CONFIRMATION_MISMATCH.description);
    expect(await form.getByTestId('automated-login-setup-rollback').textContent()).toBe(text.rollbacks.NOT_NEEDED);
    expect(await form.locator('input[name="password"]').inputValue()).toBe('');
    expect(await form.locator('input[name="username"]').inputValue()).toBe('');
    expect(await valueOf<{ eligible: boolean }>('getCredentialPageFn', 'GET', { profileId: PROFILE_ID })).toMatchObject({ eligible: false });
    await snapshot(jobPage);

    // 確認のダイアログ: 変えるもの（方式・セレクタ・資格情報）と、改訂が進むこと。
    await form.locator('input[name="username"]').fill(USER);
    await form.locator('input[name="password"]').fill(PASS);
    await form.locator('input[name="passwordConfirmation"]').fill(PASS);
    await form.getByTestId('automated-login-setup-review').click();
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    const rows = dialog.getByTestId('automated-login-setup-change');
    expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-item'))))
      .toEqual(['method', 'username', 'password', 'submit', 'credential']);
    expect(await dialog.locator('[data-item="submit"] code').textContent()).toBe(EDITED_SUBMIT);
    expect(await dialog.locator('[data-item="credential"]').textContent()).toContain(text.dialog.credentialAfter);
    expect(await dialog.getByTestId('automated-login-setup-revision').textContent())
      .toBe(text.dialog.revisionNotice(LOCAL_UI_TEXT.profileForm.revisionText(revision), LOCAL_UI_TEXT.profileForm.revisionText(revision + 1)));
    // 承認したシナリオはない（承認が外れる知らせは出さない）。
    expect(await dialog.getByTestId('automated-login-setup-approval').count()).toBe(0);
    // パスワードはダイアログにも出ない。
    expect(leaks(await dialog.innerHTML())).toBe(false);
    await screenshot(jobPage, 'fm2e-02-dialog');
    await dialog.getByRole('button', { name: text.dialog.confirm }).click();

    // 保存の後: 自動ログインのプロファイルになり、資格情報を保存した状態と「ログインを確かめる」のボタン（自動では始めない）。
    await jobPage.locator('[data-testid="credential-done"][data-notice="automatedLoginSetUp"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await jobPage.getByTestId('credential-saved').getAttribute('data-saved')).toBe('yes');
    expect(await jobPage.getByTestId('automated-login-setup-login-check-note').textContent()).toBe(text.loginCheckNote);
    const loginCheck = jobPage.getByTestId('next-step-links').locator(`a[href="/login-check/${PROFILE_ID}"]`);
    expect(await loginCheck.count()).toBe(1);
    expect(await loginCheck.textContent()).toBe(LOCAL_UI_LOGIN_CHECK_TEXT.pages.loginCheck);
    expect(await jobPage.getByTestId('automated-login-setup').count()).toBe(0);
    await snapshot(jobPage);
    await screenshot(jobPage, 'fm2e-03-saved');
    const profileValue = await valueOf<{ profile: { auth: string; revision: number } } | null>('getProfileFn', 'GET', { profileId: PROFILE_ID });
    expect(profileValue?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: revision + 1 });
    const setup = await valueOf<{ stored: { setup: { automatedLogin: unknown; maxLoginAttempts: number }; freshness: string } | null }>('getAuthSetupFn', 'GET', { profileId: PROFILE_ID });
    expect(setup.stored?.freshness).toBe('CURRENT');
    expect(setup.stored?.setup.automatedLogin).toMatchObject({ usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: EDITED_SUBMIT });
    // ログインの確かめは始めていない（ジョブは、最初の手動のログインのジョブだけ）。
    const jobs = await valueOf<readonly { jobKind: string }[]>('listAuditJobsFn', 'GET');
    expect(jobs.filter((job) => job.jobKind === 'LOGIN_CHECK')).toEqual([]);
    expect(existsSync(credentialFilePathFor(resolveCredentialDirectory(rootOf().root), PROFILE_ID))).toBe(true);

    // パスワードは画面に出ない（HTML、応答、管理データ、偽のワーカーが受けたメッセージ）。
    expect(htmlSnapshots.filter(leaks)).toEqual([]);
    expect(responseBodies.filter(leaks)).toEqual([]);
    const dataFiles = filesUnder(`${rootOf().root}/${CONTROL_DATA_DIRECTORY_NAME}`, 'local-data');
    expect(dataFiles.length).toBeGreaterThan(0);
    expect(leakedPlaces(dataFiles, MARKERS)).toEqual([]);
    expect(leaks(JSON.stringify(worker?.received() ?? []))).toBe(false);
    expect(leaks(started().output())).toBe(false);
  }, SCENARIO_TIMEOUT_MS);
});
