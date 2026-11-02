/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの成功の後の「次から自動でログインする」から、1 つの画面（資格情報の画面の、手動のログインの
 * プロファイルの形）で、認証の方式の変更・ログインの 3 つのセレクタ・資格情報を、確認 1 回で保存する。ビルドした画面のサーバ（一時の root）と headless の
 * Chromium で、本物のジョブの管理と確かめる。監査のワーカーは偽のワーカー（`auth-manual-confirm`。サイトに接続しない）に替える。偽のワーカーは、
 * 「ログインを終えた」を受けたら、通した送信の一覧とログインの段の観察（ログインの欄の案つき）で認証済みにする。
 * - 案の入った画面: 3 つのセレクタの案は、画面に出さずにそのまま送る（PL-4。前は欄に案と推測の印を出し、人が直せた）。
 * - 確認のダイアログ: 変えるもの（方式・回数の上限・資格情報）と、改訂が進むこと。PL-S: セレクタは出さず、パスワードを入れる先（ホストだけ）・テスト用の
 *   アカウントだけ・保存の場所・回数の決まりを出す。
 * - 保存の後: 自動ログインのプロファイルになり、資格情報を保存する。PL-4: 点検の開始の画面へ移る（ログインの確かめは始めない。判断 1）。
 * - 拒否（2 回入れたパスワードの違い）: 理由と、何も保存していないこと。入力は空にする。
 * - パスワードは画面に出ない: 目印の値が、ページの HTML、Server Function の応答、管理データのファイルと WAL、偽のワーカーが受けたメッセージにない。
 * - MI-4（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.4。案のそろった画面の確かめを 4.4 に合わせて直した）: 3 つのセレクタの案が
 *   そろうときは、見える入力は資格情報の 3 欄と「自動ログインにする」だけ（PL-4: セレクタの欄は出さない）。
 * - MI-4（受け入れ条件 3）: プロファイルの詳細の「次にすること」の「次から自動でログインする」（手動のログインの登録の前は、手動のログインで 1 回ログインする
 *   案内）→ 資格情報の 3 欄と確認 → ログインの確かめ、が、認証の設定の画面を開かずに通る。ログインの確かめのジョブは、偽のワーカー（`auto-login-success`）に
 *   替えて行う。
 * - MI-4 の C（設計書 8 章）: 自動ログインに切り替えたプロファイルを、手動のログインへ戻す道（詳しい設定の編集で認証の方式を戻す → 古くなった認証の設定を
 *   保存し直す）の後に、手動のログインの監査と自動の登録が通ること。もう一度切り替えるには、残った資格情報を先に消すこと。
 * - MI-F2（設計書 4.1、6 章の受け入れ条件 3。独立レビュー MI-R の I-4）: fixture のサイト（127.0.0.1 の SPA。スクリプトで送るログインで、token の送信先は
 *   別の Origin のバックエンド）に対して、本物のワーカーで、作成の画面（開始の URL だけ）→ 保存して入口を確かめる（認証の設定の自動保存）→ 手動のログインの
 *   監査 → 自動の登録 →「次から自動でログインする」（資格情報の 3 欄と確認）→ ログインを確かめる（`AUTHENTICATED`）までを、1 本のテストで、認証の設定の
 *   画面を開かずに通す。ワーカーは、手動のログインの段の口だけを替えたテストだけの入口（`helpers/auth-worker.ts` の `installTestAuthWorkerEntry`。人の
 *   操作の代わりに、受け渡しのサーバから資格情報を受けて入れる。自動ログインの段は本番のまま）。
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
import { WORKER_ENTRY_CHECK_JOB_KIND, WORKER_LOGIN_CHECK_JOB_KIND } from '../../../src/control/worker-protocol.js';
import { AUTO_LOGIN_DAILY_MAX_ATTEMPTS, AUTO_LOGIN_DAILY_WINDOW_MS, AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { DAY_MS, MINUTE_MS } from '../../../src/core/time-units.js';
import { formatInteger } from '../../../src/presentation/format.js';
import {
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker, type FakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../../../tests/helpers/spa-auth-site-fixture.js';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { installTestAuthWorkerEntry, startCredentialRelay, writeAuthTargetConfig, type CredentialRelay } from './helpers/auth-worker.ts';
import { profileStageOf } from './helpers/next-steps.ts';
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
import { waitForJobViaServerFunctions, waitForNoActiveJobViaServerFunctions, type ServerFunctionJobWaitTiming } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the one screen saves the credential with the real DPAPI, which exists only on Windows';
const UI_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 30_000, stepMs: 100 });
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
const PROFILE_ID = 'fm2e-manual-ui';
/** MI-4: 「次にすること」から自動ログインへ進むプロファイル（スクリプトで送るログイン。手動のログインの自動の登録の前は、token の送信先と成功の鍵がない）。 */
const FLOW_PROFILE_ID = 'mi4-manual-flow';
const FIRST_REVISION = 1;
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
const STATUS_OK = 200;
const SCREENSHOT_DIRECTORY = process.env['FM2E_SCREENSHOT_DIR'];
/** 案（偽のワーカーが、ログインの段の始めに検出した形で送る）。 */
const FIELDS = Object.freeze({ username: '#email', password: '#password', submit: '#login' });

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
/** MI-4: ログインの確かめのジョブの偽のワーカー（成功で終える）。 */
let loginCheckWorker: FakeWorker | undefined;
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

/**
 * MI-4・PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2、4 章の 3。前は、セレクタの欄を閉じた「詳しい設定」にたたんでいた）: 切り替えの画面で、
 * 見える入力が資格情報の 3 欄と「自動ログインにする」だけか。セレクタの欄・方式の表・詳しい設定は、画面にない（観察の案のまま送る）。
 */
const expectOnlyCredentialInputsVisible = async (form: ReturnType<Page['getByTestId']>): Promise<void> => {
  expect(await form.locator('details').count()).toBe(0);
  expect(await form.locator('[data-testid="automated-login-setup-selector"], [data-testid="automated-login-setup-method"]').count()).toBe(0);
  expect(await form.locator('input:visible, select:visible, textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))))
    .toEqual(['username', 'password', 'passwordConfirmation']);
  expect(await form.locator('button:visible').evaluateAll((items) => items.map((item) => item.getAttribute('data-testid'))))
    .toEqual(['automated-login-setup-review']);
  const shown = await form.innerText();
  for (const selector of Object.values(FIELDS)) {
    expect(shown, selector).not.toContain(selector);
  }
};

/** PL-4（設計書 6 章の 4）: 確定の後に移る点検の開始の画面の URL（移った印と、自動ログインにした印）。 */
const startAfterSetUpUrlOf = (profileId: string): RegExp => new RegExp(`/start/${profileId}[?]arrived=auto&automatedLogin=setUp$`, 'u');

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
  const loginCheckDirectory = `${root.root}/fake-workers/mi4-login-check`;
  mkdirSync(loginCheckDirectory, { recursive: true });
  loginCheckWorker = writeFakeWorker(loginCheckDirectory, 'auto-login-success',
    fakeWorkerValuesOf({ runId: 'RUN-20261026000000', otherRunId: 'RUN-20261026000999' }, { heartbeatIntervalMs: 200 }));
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
  expect(await saveAuthSetupRequestInStore(root, { setup: formSetup })).toMatchObject({ ok: true });
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

    // MI-C 項目 11: ジョブの画面の登録した設定の欄には「次から自動でログインする」を出さない（案内はプロファイルの詳細の「次にすること」の 1 か所）。
    const job = await openPage(`/jobs/${start.jobId}`);
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 登録した設定の欄は、たたんだ詳しい内容の中。
    await openAdvancedSettings(job, 'job-details', UI_TIMEOUT_MS);
    await job.getByTestId('job-login-setup').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await job.getByTestId('job-login-setup-automated-login').count()).toBe(0);
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動でログインする」は、ふだんの流れ（要点）からなくした。1 つの画面へは、
    // サイトの画面の詳しい内容の中の直す道（ID とパスワードの画面を開く）から進む。
    const jobPage = await openPage(`/profiles/${PROFILE_ID}`);
    await profileStageOf(jobPage, UI_TIMEOUT_MS);
    expect(await jobPage.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
    expect(await jobPage.getByTestId('profile-login-setup').count()).toBe(0);
    await openAdvancedSettings(jobPage, 'profile-edit-advanced-settings', UI_TIMEOUT_MS);
    const offer = jobPage.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]');
    expect(await offer.textContent()).toBe(LOCAL_UI_NEXT_STEP_TEXT.actions.CREDENTIAL);
    await offer.click();
    await jobPage.waitForURL(`**/credentials/${PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
    const form = jobPage.getByTestId('automated-login-setup');
    await form.waitFor({ timeout: UI_TIMEOUT_MS });
    await snapshot(jobPage);
    // 1 つの画面を出すときは、「資格情報を使わない」の知らせを出さない。
    expect(await jobPage.getByTestId('credential-not-eligible').count()).toBe(0);

    // MI-4・PL-4: 3 つの案がそろうので、セレクタは観察の案のまま送る（画面に欄も印も出さない）。見える入力は資格情報の 3 欄と「自動ログインにする」だけ。
    await expectOnlyCredentialInputsVisible(form);
    await screenshot(jobPage, 'fm2e-01-proposals');

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

    // 確認のダイアログ: 変えるもの（方式・資格情報）と、改訂が進むこと。
    // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 2。前はセレクタの 3 行を出していた）: CSS セレクタはダイアログに出さない（直した値は保存の後の
    // 認証の設定で確かめる）。代わりに、パスワードを入れる先（ログインの画面のホストだけ）、テスト用のアカウントだけ、保存の場所、回数の決まり（定義元の定数）を出す。
    await form.locator('input[name="username"]').fill(USER);
    await form.locator('input[name="password"]').fill(PASS);
    await form.locator('input[name="passwordConfirmation"]').fill(PASS);
    await form.getByTestId('automated-login-setup-review').click();
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    const rows = dialog.getByTestId('automated-login-setup-change');
    expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-item'))))
      .toEqual(['method', 'credential']);
    expect(await dialog.locator('[data-item="credential"]').textContent()).toContain(text.dialog.credentialAfter);
    const dialogText = await dialog.textContent() ?? '';
    for (const selector of Object.values(FIELDS)) {
      expect(dialogText, selector).not.toContain(selector);
    }
    expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(text.dialog.destination(new URL(TEST_ORIGIN).host));
    expect(dialogText).not.toContain(TEST_ORIGIN);
    expect(await dialog.getByTestId('automated-login-setup-test-account').textContent()).toBe(text.dialog.testAccountOnly);
    expect(await dialog.getByTestId('automated-login-setup-storage').textContent()).toBe(text.dialog.storage);
    expect(await dialog.getByTestId('automated-login-setup-limits').textContent()).toBe(text.dialog.limits(
      formatInteger(AUTO_LOGIN_MIN_INTERVAL_MS / MINUTE_MS),
      formatInteger(AUTO_LOGIN_DAILY_WINDOW_MS / DAY_MS),
      formatInteger(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
    ));
    expect(await dialog.getByTestId('automated-login-setup-revision').textContent())
      .toBe(text.dialog.revisionNotice(LOCAL_UI_TEXT.profileForm.revisionText(revision), LOCAL_UI_TEXT.profileForm.revisionText(revision + 1)));
    // 承認したシナリオはない（承認が外れる知らせは出さない）。
    expect(await dialog.getByTestId('automated-login-setup-approval').count()).toBe(0);
    // パスワードはダイアログにも出ない。
    expect(leaks(await dialog.innerHTML())).toBe(false);
    await screenshot(jobPage, 'fm2e-02-dialog');
    await dialog.getByRole('button', { name: text.dialog.confirm }).click();

    // 保存の後: 自動ログインのプロファイルになり、資格情報を保存した。PL-4（設計書 4 章の 3、6 章の 4。前は、この画面に済んだ知らせ・「ログインを確かめる」の
    // 案内・次の手順のリンクを出していた）: 確定で点検の開始の画面へ移る（移った印つき）。ログインの確かめは始めない（点検の最初の自動ログインが兼ねる。判断 1）。
    await jobPage.waitForURL(startAfterSetUpUrlOf(PROFILE_ID), { timeout: UI_TIMEOUT_MS });
    // PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: 開始の画面の読む量の上限は詳しい内容の中。見えるのは要点のパネル。
    await jobPage.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-3（13 章の最後の段落）: 移ってきた開始の画面の要点の 1 行目に、何が起きたか（自動ログインにした）を書く。開き直した画面（印なし）には出さない。
    expect(await jobPage.getByTestId('start-summary').locator('p').first().getAttribute('data-testid')).toBe('start-arrived-automated-login');
    expect(await jobPage.getByTestId('start-arrived-automated-login').textContent()).toBe(text.arrived);
    expect(await jobPage.getByTestId('start-submit').count()).toBe(1);
    const reopenedStart = await openPage(`/start/${PROFILE_ID}`);
    await reopenedStart.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reopenedStart.getByTestId('start-arrived-automated-login').count()).toBe(0);
    await reopenedStart.close();
    expect(await jobPage.getByTestId('automated-login-setup').count()).toBe(0);
    expect(await jobPage.getByTestId('automated-login-setup-login-check-note').count()).toBe(0);
    await snapshot(jobPage);
    await screenshot(jobPage, 'fm2e-03-saved');
    expect((await valueOf<{ credential: unknown }>('getCredentialPageFn', 'GET', { profileId: PROFILE_ID })).credential).not.toBeNull();
    const profileValue = await valueOf<{ profile: { auth: string; revision: number } } | null>('getProfileFn', 'GET', { profileId: PROFILE_ID });
    expect(profileValue?.profile).toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: revision + 1 });
    const setup = await valueOf<{ stored: { setup: { automatedLogin: unknown; maxLoginAttempts: number }; freshness: string } | null }>('getAuthSetupFn', 'GET', { profileId: PROFILE_ID });
    expect(setup.stored?.freshness).toBe('CURRENT');
    // 観察の案のまま保存した（PL-4: 人が直す道はない）。
    expect(setup.stored?.setup.automatedLogin).toMatchObject({ usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit });
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
/**
 * MI-4（設計書 4.4、6 章の受け入れ条件 3、8 章）: 手動のログインの監査 → 自動の登録 → 「次にすること」の「次から自動でログインする」→ 資格情報の 3 欄と確認
 * → ログインの確かめ、が、認証の設定の画面を開かずに通る。その後、手動のログインへ戻す道で、手動のログインの監査と自動の登録が通る。
 */
describe('MI-4: from the next steps to the automated login, and back to the manual login', () => {
  /** スクリプトで送るログインの、手動のログインの認証の設定（token の送信先と成功の鍵は、手動のログインの自動の登録が埋める）。 */
  const scriptSetupOf = (profileRevision: number) => ({
    ...formSetup,
    profileId: FLOW_PROFILE_ID,
    profileRevision,
    loginPostEndpoints: [],
    loginTransport: 'SCRIPT_REQUEST',
  });

  /** 手動のログインのジョブ（「ログインを終えた」→ 止める）を行い、自動の登録の結果を返す。 */
  const runManualLogin = async (expectedRevision: number): Promise<{ readonly result: string; readonly reason?: string }> => {
    const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: FLOW_PROFILE_ID, expectedRevision, startNew: true });
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
    expect(await valueOf('confirmManualLoginFn', 'POST', { jobId: start.jobId })).toEqual({ ok: true });
    await waitForJobViaServerFunctions(readJob, start.jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
    const ended = await waitForJobViaServerFunctions(readJob, start.jobId,
      (job) => !job.active && job.loginStage?.autoRegistration !== undefined, JOB_WAIT);
    return ended.loginStage?.autoRegistration as { readonly result: string; readonly reason?: string };
  };

  /** ジョブの管理が起動するワーカーを替える（同じ一時の root の `dist/worker/audit-worker.js`）。 */
  const useWorker = (fake: FakeWorker | undefined): void => {
    if (fake === undefined) throw new Error('偽のワーカーがない');
    writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(fake.path, 'utf8'), 'utf8');
  };

  /**
   * 自動ログインへの切り替えの画面を出せるか（資格情報の画面の値の `automatedLoginSetup`。OP-1（D5）で「次から自動でログインする」の段をなくしたので、前の段の値の
   * 代わりに、切り替えの画面そのものの値で確かめる）。
   */
  const automatedLoginOffered = async (): Promise<boolean> =>
    (await valueOf<{ automatedLoginSetup: { authSetupCurrent: boolean } | null } | null>('getCredentialPageFn', 'GET', { profileId: FLOW_PROFILE_ID }))
      ?.automatedLoginSetup?.authSetupCurrent === true;

  it.skipIf(!IS_WINDOWS)(`reaches the login check from the next steps without opening the auth setup screen, then goes back to the manual login (${SKIP_REASON} otherwise)`, async () => {
    const profile = {
      schemaVersion: 'beaksight-profile/1', profileId: FLOW_PROFILE_ID, revision: FIRST_REVISION,
      targetConfigPath: writeAuthTargetConfig(rootOf().root, FLOW_PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES),
      environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${FLOW_PROFILE_ID}-evidence`,
    };
    expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(root, { setup: scriptSetupOf(FIRST_REVISION) })).toMatchObject({ ok: true });
    const visited: string[] = [];

    // 手でログインした点検の前: PL-1（4 章の 1）: 「次から自動でログインする」は出さず、主のボタンは「点検を始める」（開いたブラウザで手でログインする）。
    const before = await openPage(`/profiles/${FLOW_PROFILE_ID}`);
    expect(await profileStageOf(before, UI_TIMEOUT_MS)).toBe('AUDIT_MANUAL_LOGIN');
    expect(await before.getByTestId('profile-summary').locator('[data-action="AUDIT_START"]').getAttribute('href')).toBe(`/start/${FLOW_PROFILE_ID}`);
    expect(await before.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
    await snapshot(before);

    // 手動のログインの監査 → 自動の登録（改訂 2。token の送信先・成功の鍵・承認したサービスの Origin）。
    expect(await runManualLogin(FIRST_REVISION)).toMatchObject({ result: 'SAVED' });
    const registered = FIRST_REVISION + 1;

    // 要点の主のボタン「次から自動でログインする」→ 切り替えの画面（資格情報の画面）。
    const page = await openPage(`/profiles/${FLOW_PROFILE_ID}`);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });
    // OP-1（D5）: 要点には出さない。詳しい内容の直す道（ID とパスワードの画面を開く）から進む。
    await profileStageOf(page, UI_TIMEOUT_MS);
    expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
    await screenshot(page, 'mi4-01-next-steps');
    await openAdvancedSettings(page, 'profile-edit-advanced-settings', UI_TIMEOUT_MS);
    await page.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]').click();
    await page.waitForURL(`**/credentials/${FLOW_PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
    const form = page.getByTestId('automated-login-setup');
    await form.waitFor({ timeout: UI_TIMEOUT_MS });
    await expectOnlyCredentialInputsVisible(form);
    await snapshot(page);
    await screenshot(page, 'mi4-02-folded');

    // 資格情報の 3 欄と確認だけで保存する（案のセレクタのまま）。
    await form.locator('input[name="username"]').fill(USER);
    await form.locator('input[name="password"]').fill(PASS);
    await form.locator('input[name="passwordConfirmation"]').fill(PASS);
    await form.getByTestId('automated-login-setup-review').click();
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 9 章の 2）: CSS セレクタはダイアログに出さない（案のまま保存したことは、保存の後の認証の設定で確かめる）。
    expect(await dialog.locator('code').count()).toBe(0);
    expect(await dialog.getByTestId('automated-login-setup-destination').textContent()).toBe(text.dialog.destination(new URL(TEST_ORIGIN).host));
    await dialog.getByRole('button', { name: text.dialog.confirm }).click();
    // PL-4（設計書 6 章の 4）: 確定で点検の開始の画面へ移る（ログインの確かめへの入口は出さない。判断 1）。
    await page.waitForURL(startAfterSetUpUrlOf(FLOW_PROFILE_ID), { timeout: UI_TIMEOUT_MS });
    await snapshot(page);
    const switched = registered + 1;
    expect((await valueOf<{ profile: { auth: string; revision: number } }>('getProfileFn', 'GET', { profileId: FLOW_PROFILE_ID })).profile)
      .toMatchObject({ auth: 'AUTOMATED_LOGIN', revision: switched });

    // ログインの確かめの画面（停止を解く入口として残す）は、直接開いて確かめる。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の最後）: 止めて
    // いないので、要点は「止まっていません」と主のボタン「点検を始める」で、ログインだけを試すボタンはない。ログインの確かめのジョブは、開始の Server Function で
    // 始める（偽のワーカーが成功で終える）。
    useWorker(loginCheckWorker);
    await page.goto(`${started().origin}/login-check/${FLOW_PROFILE_ID}`);
    await page.waitForURL(`**/login-check/${FLOW_PROFILE_ID}`, { timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('login-check-summary').getAttribute('data-state')).toBe('notHeld');
    expect(await page.getByTestId('login-check-open-start').getAttribute('href')).toBe(`/start/${FLOW_PROFILE_ID}`);
    expect(await page.getByTestId('login-check-start').count()).toBe(0);
    const loginCheckStart = await valueOf<{ ok: boolean; jobId: string }>('startLoginCheckFn', 'POST', { profileId: FLOW_PROFILE_ID, expectedRevision: switched });
    expect(loginCheckStart.ok).toBe(true);
    const loginCheckJobId = loginCheckStart.jobId;
    const checked = await waitForJobViaServerFunctions(readJob, loginCheckJobId, (job) => !job.active, JOB_WAIT);
    expect(checked).toMatchObject({ lastAuthState: 'AUTHENTICATED' });
    const jobs = await valueOf<readonly { jobId: string; jobKind: string; state: string }[]>('listAuditJobsFn', 'GET');
    expect(jobs.find((job) => job.jobId === loginCheckJobId)).toMatchObject({ jobKind: 'LOGIN_CHECK', state: 'FINISHED' });
    await page.goto(`${started().origin}/profiles/${FLOW_PROFILE_ID}`);
    // PL-1（4 章の 7）: 自動ログインをしたばかりなので、自動ログインの間隔の中。主のボタンを出さず、要点に始められる時刻を出す。
    expect(await profileStageOf(page, UI_TIMEOUT_MS)).toBe('AUTO_LOGIN_WAIT');
    expect(await page.getByTestId('profile-summary').locator('[data-action]').count()).toBe(0);
    expect(await page.getByTestId('profile-next-allowed-at').getAttribute('data-next-allowed-at')).not.toBe('');
    // 自動ログインのプロファイルには、もう「次から自動でログインする」を出さない。
    expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"]').count()).toBe(0);
    await snapshot(page);
    // 認証の設定の画面は、一度も開いていない。
    expect(visited.filter((path) => path.startsWith('/auth-setup/'))).toEqual([]);
    expect(visited).toContain(`/credentials/${FLOW_PROFILE_ID}`);
    expect(visited).toContain(`/login-check/${FLOW_PROFILE_ID}`);

    // C（設計書 8 章）: 手動のログインへ戻す道。詳しい設定の編集（プロファイルの保存）で認証の方式を戻し、古くなった認証の設定を手動のログインの形
    // （`automatedLogin` なし。認証の設定の画面の保存と同じ形）で保存し直す。
    useWorker(worker);
    const current = await valueOf<{ profile: Record<string, unknown> & { revision: number } }>('getProfileFn', 'GET', { profileId: FLOW_PROFILE_ID });
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...current.profile, auth: 'MANUAL_SESSION', revision: switched + 1 }, expectedRevision: switched,
    })).toMatchObject({ ok: true });
    const back = switched + 1;
    expect(await automatedLoginOffered()).toBe(false);
    const stale = await valueOf<{ stored: { setup: Record<string, unknown>; freshness: string } | null }>('getAuthSetupFn', 'GET', { profileId: FLOW_PROFILE_ID });
    expect(stale.stored?.freshness).toBe('STALE');
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...stale.stored?.setup, profileRevision: back, automatedLogin: null } }))
      .toMatchObject({ ok: true });
    expect(await automatedLoginOffered()).toBe(true);
    // 手動のログインの監査が通る。自動の登録は、足す送信がないので「足すものなし」（MI-G の拒否にならない）。
    expect(await runManualLogin(back)).toEqual({ result: 'SKIPPED', reason: 'NOTHING_NEW' });
    // もう一度切り替えるには、残った資格情報を先に消す（残っている間は、資格情報のファイルの部品が拒む）。
    const again = {
      profileId: FLOW_PROFILE_ID, expectedRevision: back,
      usernameSelector: FIELDS.username, passwordSelector: FIELDS.password, submitSelector: FIELDS.submit,
      username: USER, password: PASS, passwordConfirmation: PASS,
    };
    expect(await valueOf('setUpAutomatedLoginFn', 'POST', again)).toMatchObject({ ok: false, kind: 'CREDENTIAL', reason: 'CREDENTIAL_ALREADY_EXISTS' });
    expect(await valueOf('removeCredentialFn', 'POST', { profileId: FLOW_PROFILE_ID })).toMatchObject({ ok: true });
    expect(await valueOf('setUpAutomatedLoginFn', 'POST', again)).toMatchObject({ ok: true, profileRevision: back + 1 });

    // パスワードは画面と応答に出ない。
    expect(htmlSnapshots.filter(leaks)).toEqual([]);
    expect(responseBodies.filter(leaks)).toEqual([]);
    expect(leaks(JSON.stringify(loginCheckWorker?.received() ?? []))).toBe(false);
  }, SCENARIO_TIMEOUT_MS);
});
/**
 * MI-F2（設計書 4.1、6 章の受け入れ条件 3。独立レビュー MI-R の I-4）: fixture のサイトに対して、作成の画面から「ログインを確かめる」までを、本物のワーカーで、
 * 認証の設定の画面を開かずに通す。利用者が入れるのは、開始の URL（作成の画面）と、資格情報の 3 欄だけ。押すのは、保存して入口を確かめる・監査を始める・
 * 次から自動でログインする・自動ログインにする・確認・（開始の画面で）点検を始める。
 */
describe('MI-F2 / OP-1: acceptance on the fixture site, from the create screen to the second (automated) audit, typing the credential only once on the site', () => {
  /** 本物のワーカーのジョブ（入口の確かめ・手動のログインの監査・ログインの確かめ）を待つ上限と間隔（ms。ワーカーの起動、Chromium、ログインを含む）。 */
  const REAL_JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 180_000, stepMs: 250 });
  /** 1 本の通しの上限（ms。本物のジョブ 3 つ）。 */
  const FLOW_TIMEOUT_MS = 600_000;
  /** テストだけの入口の、手動のログインを待つ時間（ms）。 */
  const TEST_LOGIN_TIMEOUT_MS = 120_000;
  /** 巡回の上限（開始の画面と、その下の画面。ループバックの fixture）。 */
  const SPA_MAX_PAGES = 2;
  /** 開始の URL の Origin と開始の URL が同じ、すでにある設定のファイルの名前（作成の画面がこのファイルを選ぶ。MI-1 の設計者の判断）。 */
  const SPA_TARGET_NAME = 'mif2-spa';

  interface RealJobValue {
    readonly jobId: string;
    readonly jobKind: string;
    readonly profileId: string;
    readonly active: boolean;
    readonly state: string;
    readonly lastAuthState: string | null;
    readonly loginStage: { readonly autoRegistration?: { readonly result: string; readonly addedServiceOrigins?: readonly string[] } } | null;
  }

  let spa: SpaAuthSite | undefined;
  let relay: CredentialRelay | undefined;
  /** fixture の資格情報（欄のセレクタと値。値はテストの process の中だけ。出力しない）。 */
  let credentialFields: readonly (readonly [string, string])[] = [];
  const spaOf = (): SpaAuthSite => {
    if (spa === undefined) throw new Error('fixture のサイトが起動していない');
    return spa;
  };
  const credentialValueOf = (selector: string): string => credentialFields.find(([field]) => field === selector)?.[1] ?? '';
  const spaLeaks = (value: string): boolean => credentialFields.some(([, secret]) => value.includes(secret));
  const readRealJob = (jobId: string): Promise<RealJobValue | null> => valueOf<RealJobValue | null>('getAuditJobFn', 'GET', { jobId });
  const jobIdOfPage = (page: Page): string => new URL(page.url()).pathname.split('/').at(-1) ?? '';
  /** PL-3: まとめて実行のすべての段が終わるまで待つ（このプロファイルの、終わっていないジョブがなくなるまで）。 */
  const waitForNoActiveJob = (profileId: string): Promise<void> =>
    waitForNoActiveJobViaServerFunctions(() => valueOf<readonly RealJobValue[]>('listAuditJobsFn', 'GET'), profileId, REAL_JOB_WAIT);

  beforeAll(async () => {
    if (!IS_WINDOWS) return;
    spa = await startSpaAuthSite();
    const fields: (readonly [string, string])[] = [];
    await spa.fillCredentials(async (selector, value) => {
      fields.push([selector, value]);
    });
    credentialFields = fields;
    relay = await startCredentialRelay();
    writeAuthTargetConfig(rootOf().root, SPA_TARGET_NAME, spa.appOrigin, SPA_APP_PATHS.admin, SPA_MAX_PAGES);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await relay?.close();
    await spa?.close();
  });

  it.skipIf(!IS_WINDOWS)(`creates the profile, logs in by hand once on the site, is switched to the automated login, and audits again automatically (${SKIP_REASON} otherwise)`, async () => {
    // 前の場面の偽のワーカーを、本物のワーカー（手動のログインの段の口だけを替えた入口）に替える。
    installTestAuthWorkerEntry(rootOf().root, relay?.url ?? '', TEST_LOGIN_TIMEOUT_MS);
    const visited: string[] = [];
    const track = (page: Page): Page => {
      visited.push(new URL(page.url()).pathname);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
      });
      return page;
    };
    const startUrl = `${spaOf().appOrigin}${SPA_APP_PATHS.admin}`;

    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1〜D5・D11、4.1.3。前の MI-F2 の流れ（手動のログインの監査 →「次から自動でログインする」で
    // ID とパスワードをもう一度入れる）を置き換えた）: 利用者が入れるのは、作成の画面の開始の URL と、テスト対象のログインの画面での ID とパスワードの 1 回だけ
    // （人の代わりに入口が入れる）。BeakSight の画面では ID もパスワードも入れない。「ログインを終えた」も押さない。
    // 1. 作成の画面: 開始の URL だけを入れて「点検を始める」（使い方と隔離の扱いは既定のまま）。下調べ → 点検（まとめて実行）へ、自動で進む。
    relay?.provide({ fields: credentialFields, submit: SPA_LOGIN_FIELDS.submit });
    const create = track(await openPage('/profiles/new'));
    await create.getByLabel(LOCAL_UI_TEXT.profileForm.startUrl, { exact: true }).fill(startUrl);
    await create.getByRole('button', { name: LOCAL_UI_TEXT.profileForm.saveAndCheckEntry }).click();
    await create.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryCheck = await waitForJobViaServerFunctions(readRealJob, jobIdOfPage(create), (job) => !job.active, REAL_JOB_WAIT);
    expect(entryCheck).toMatchObject({ jobKind: WORKER_ENTRY_CHECK_JOB_KIND, state: 'FINISHED' });
    const profileId = entryCheck.profileId;
    // 2. 下調べの後に、ジョブの管理が続けて点検を始め、作業の画面がその点検の作業へ移る（手でのログイン → 登録と自動ログインへの切り替え → 点検と操作さがし）。
    await create.waitForURL((url) => url.pathname.startsWith('/jobs/') && !url.pathname.endsWith(entryCheck.jobId), { timeout: REAL_JOB_WAIT.limitMs });
    await waitForNoActiveJob(profileId);
    const firstAuditId = (await valueOf<readonly RealJobValue[]>('listAuditJobsFn', 'GET')).find((job) => job.profileId === profileId && job.jobKind === 'AUDIT')?.jobId ?? '';
    const firstAudit = await waitForJobViaServerFunctions(readRealJob, firstAuditId,
      (job) => !job.active && job.loginStage?.autoRegistration !== undefined, REAL_JOB_WAIT);
    expect(firstAudit).toMatchObject({ jobKind: 'AUDIT', lastAuthState: 'AUTHENTICATED' });
    await waitForNoActiveJob(profileId);
    // 3. 登録と切り替えは、ログインの直後の 1 回の保存（改訂 2）。token の送信先の Origin を承認したサービスの Origin に足し、自動ログインになった。
    expect(firstAudit.loginStage?.autoRegistration).toMatchObject({ result: 'SAVED', addedServiceOrigins: [spaOf().tokenOrigin], automatedLogin: 'SWITCHED' });
    expect((await valueOf<{ profile: Record<string, unknown> }>('getProfileFn', 'GET', { profileId })).profile)
      .toMatchObject({ revision: FIRST_REVISION + 1, auth: 'AUTOMATED_LOGIN', approvedServiceOrigins: [spaOf().tokenOrigin] });
    // 操作さがしは、登録の後の設定で行われた（後の段のジョブの改訂は登録の後の改訂）。
    const stageJobs = (await valueOf<readonly (RealJobValue & { readonly profileRevision: number })[]>('listAuditJobsFn', 'GET'))
      .filter((job) => job.profileId === profileId && job.jobKind === 'DISCOVERY');
    expect(stageJobs.map(({ profileRevision }) => profileRevision)).toEqual([FIRST_REVISION + 1]);
    await snapshot(create);

    // 4. 2 回目の点検: 押すだけ（自動ログイン）。サイトの画面の主のボタン「点検を始める」→ 開始の画面の「点検を始める」。
    const second = track(await openPage(`/profiles/${profileId}`));
    expect(await profileStageOf(second, UI_TIMEOUT_MS)).toBe('AUDIT_AUTOMATED_LOGIN');
    await second.getByTestId('profile-summary').locator('[data-action="AUDIT_START"]').click();
    await second.waitForURL(`**/start/${profileId}`, { timeout: UI_TIMEOUT_MS });
    await second.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-3（4 章の 4）: 始め方の選択は、前回の点検が最後まで終わらなかったときだけ、詳しい内容に出る（出たら、新しく始めるを選ぶ）。
    if (await second.locator('input[name="start-mode"]').count() > 0) {
      await openAdvancedSettings(second, 'start-advanced-settings', UI_TIMEOUT_MS);
      await second.getByRole('radio', { name: LOCAL_UI_AUDIT_TEXT.start.startNew }).check();
    }
    await second.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.start.submit }).click();
    await second.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const automatedAudit = await waitForJobViaServerFunctions(readRealJob, jobIdOfPage(second), (job) => !job.active, REAL_JOB_WAIT);
    expect(automatedAudit).toMatchObject({ jobKind: 'AUDIT', state: 'FINISHED', lastAuthState: 'AUTHENTICATED' });
    await waitForNoActiveJob(profileId);
    expect((await valueOf<readonly RealJobValue[]>('listAuditJobsFn', 'GET')).filter((job) => job.profileId === profileId && job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND))
      .toEqual([]);
    await snapshot(second);

    // 認証の設定の画面・ログインの確かめの画面・ID とパスワードの画面は、一度も開いていない（BeakSight の画面では ID もパスワードも入れていない）。
    expect(visited.filter((path) => path.startsWith('/auth-setup/') || path.startsWith('/login-check/') || path.startsWith('/credentials/'))).toEqual([]);
    for (const path of ['/profiles/new', `/profiles/${profileId}`, `/start/${profileId}`]) {
      expect(visited, path).toContain(path);
    }
    // 資格情報の値は、画面と Server Function の応答に出ない。
    expect(htmlSnapshots.filter(spaLeaks)).toEqual([]);
    expect(responseBodies.filter(spaLeaks)).toEqual([]);
  }, FLOW_TIMEOUT_MS);
});
