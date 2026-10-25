/**
 * ML-b-2（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.2、2.3）: 手動のログインの「ログインを終えた」と、通した送信の表と、
 * 手動のログインの成功から自動で登録した設定を、ビルドした画面のサーバ（一時の root）と headless の Chromium で、本物のジョブの管理と確かめる。
 * 監査のワーカーは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `auth-manual-confirm`。ML-a。サイトに接続しない）に替える。
 * 偽のワーカーは、ログインを待ち、「ログインを終えた」（`LOGIN_CONFIRMED`）を受けたら、通した送信の一覧とログインの段の観察つきで認証済みにして、監査に進む。
 * - ボタンを押すと、ジョブの管理がワーカーへ知らせ、監査に進む（ボタンは消える）。2 回目は、閉じた一覧の理由で拒む。
 * - 通した送信の表（行ごとの「登録する」）。
 * - ジョブが終わった後に、ジョブの管理が背後で設定を登録する。画面は、結果が書かれるまで読み直しを続け、SAVED（このジョブで登録した、足した Origin）と
 *   SKIPPED（理由と次にすること）を出す。
 * 値は匿名（`example.invalid` とループバック）。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {  LOGIN_SIDE_REQUEST_METHODS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { formatCount } from '../../../src/presentation/format.js';
import {
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
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
import { callServerFunction, isServerFunctionUrlOf, readServerFunctionIds } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions, type ServerFunctionJobWaitTiming } from './helpers/server-function-job-wait.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 30_000, stepMs: 100 });
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
const PROFILE_ID = 'mlb2-manual';
const FIRST_REVISION = 1;
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const TENANT_PATH = '/rest/v1/rpc/current_tenant';
const AFTER_TOKEN_PATH = '/rest/v1/rpc/after_login';
const LOGOUT_PATH = '/auth/v1/logout';
const ANALYTICS_ORIGIN = 'https://analytics.example.invalid';
const ANALYTICS_PATH = '/v1/collect';
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
const FAKE_HEARTBEAT_INTERVAL_MS = 200;
const FAKE_RUN_ID = 'RUN-20261019000000';
const OTHER_RUN_ID = 'RUN-20261019000999';
const STATUS_OK = 200;
const SCREENSHOT_DIRECTORY = process.env['MLB_SCREENSHOT_DIR'];

/**
 * 手動のログインの段で通した送信（最初に見た順。理由は、通さなければ止めた理由）。ML-b-3（ML-a-fix の決まり）: 印 `beforeToken` は、token の送信より前に
 * 最初に見た行だけ。自動で登録するログインに伴う送信は、印があり、種類が fetch・xhr で、手続きの呼び出しの path（`/rpc/`）で、危険な語・読まないパスで
 * ない行だけ。
 * - テナントを決める手続きの呼び出し（token の前。`/rpc/`）: 登録する。回数は閉じた上限の定数にする（上限の決まりが変わっても、値を書き写さない）。
 * - 第三者の解析の送信（token の前。手続きの呼び出しでない）: 登録しない（案だけ）。Origin も足さない。
 * - token の送信: token の送信先として登録する。
 * - token の後の手続きの呼び出し: 登録しない（案だけ）。
 * - 危険な語の path（ログアウト。token の後）: 登録しない。
 */
const PASSED_REQUESTS = Object.freeze({
  requests: [
    { origin: SERVICE_ORIGIN, path: TENANT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE, beforeToken: true },
    { origin: ANALYTICS_ORIGIN, path: ANALYTICS_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, beforeToken: true },
    {
      origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
    },
    { origin: SERVICE_ORIGIN, path: AFTER_TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
    { origin: SERVICE_ORIGIN, path: LOGOUT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
  ],
  unlisted: 0,
});
const LOGIN_OBSERVATION = Object.freeze({ storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } });

const text = LOCAL_UI_MANUAL_LOGIN_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let worker: FakeWorker | undefined;
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
const workerOf = (): FakeWorker => {
  if (worker === undefined) throw new Error('偽のワーカーがない');
  return worker;
};

const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(STATUS_OK);
  return result.value as T;
};

interface JobValue {
  readonly active: boolean;
  readonly lastAuthState: string | null;
  readonly loginStage: { readonly autoRegistration?: unknown } | null;
}

/** ジョブの値を 1 回読む（画面のサーバの管理データを読むだけ）。条件に当たるまで待つのは `waitForJobViaServerFunctions`。 */
const readJob = (jobId: string): Promise<JobValue | null> => valueOf<JobValue | null>('getAuditJobFn', 'GET', { jobId });

/** 手動のログインの認証の設定（版 2。フォームの送信のログイン）。 */
const formSetupOf = (profileRevision: number) => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision,
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

const startJob = async (expectedRevision: number): Promise<string> => {
  const start = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision, startNew: true });
  expect(start.ok, JSON.stringify(start)).toBe(true);
  return start.jobId;
};

const confirmedMessages = (): number => workerOf().received().filter((message) => message['type'] === 'LOGIN_CONFIRMED').length;

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
  const directory = `${root.root}/fake-workers/mlb2`;
  mkdirSync(directory, { recursive: true });
  worker = writeFakeWorker(directory, 'auth-manual-confirm', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
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
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: formSetupOf(FIRST_REVISION) })).toMatchObject({ ok: true });
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  rootOf().remove();
});

describe('ML-b-2: the manual login with the job manager and the fake worker', () => {
  it('goes on to the audit when the button is pressed, shows the passed requests, and shows the settings this job registered', async () => {
    const jobId = await startJob(FIRST_REVISION);
    const page = await openPage(`/jobs/${jobId}`);
    const panel = page.getByTestId('job-manual-login');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    await screenshot(page, 'mlb2-01-awaiting-login');
    expect(confirmedMessages()).toBe(0);
    await panel.getByTestId('job-manual-login-confirm').click();

    // ボタンを押す → ジョブの管理がワーカーへ知らせ、監査に進む（認証済み。ボタンは消える）。
    await expect.poll(() => page.getByTestId('job-auth-state').getAttribute('data-auth-state'), { timeout: UI_TIMEOUT_MS }).toBe('AUTHENTICATED');
    await expect.poll(() => panel.count(), { timeout: UI_TIMEOUT_MS }).toBe(0);
    expect(confirmedMessages()).toBe(1);
    // 2 回目は、閉じた一覧の理由で拒む（ワーカーへは送らない）。
    expect(await valueOf('confirmManualLoginFn', 'POST', { jobId })).toEqual({ ok: false, reason: 'ALREADY_CONFIRMED' });
    expect(confirmedMessages()).toBe(1);

    // 通した送信の表（行ごとに、通さなければ止めた理由と「登録する」）。
    const passed = page.getByTestId('job-login-stage-passed');
    await passed.waitFor({ timeout: UI_TIMEOUT_MS });
    const rows = passed.locator('tbody tr');
    expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-path'))))
      .toEqual([TENANT_PATH, ANALYTICS_PATH, TOKEN_PATH, AFTER_TOKEN_PATH, LOGOUT_PATH]);
    expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-reason')))).toEqual(PASSED_REQUESTS.requests.map(() => 'NON_READ_METHOD'));
    // ML-b-3: token の送信より前に最初に見た行の印（カタログの文言）。
    expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-before-token')))).toEqual(['true', 'true', null, null, null]);
    expect(await rows.nth(0).textContent()).toContain(LOCAL_UI_LOGIN_STAGE_TEXT.passedBeforeToken);
    expect(await rows.nth(2).textContent()).not.toContain(LOCAL_UI_LOGIN_STAGE_TEXT.passedBeforeToken);
    const tokenRow = passed.locator(`tbody tr[data-path="${TOKEN_PATH}"]`);
    expect(await tokenRow.getByTestId('job-login-stage-query').textContent()).toContain('grant_type');
    expect(await tokenRow.getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('TOKEN_TARGET');
    // 自動で登録しない行も、表の「登録する」の案として出る（第三者の解析の送信、token の後の手続きの呼び出し）。
    for (const path of [ANALYTICS_PATH, AFTER_TOKEN_PATH]) {
      expect(await passed.locator(`tbody tr[data-path="${path}"]`).getByTestId('job-login-stage-register').getAttribute('data-registration'), path)
        .toBe('SIDE_REQUEST');
    }
    await screenshot(page, 'mlb2-02-passed-requests');

    // ジョブが終わったら、ジョブの管理が背後で設定を登録する。画面は、読み込み直しなしで、このジョブで登録したことと足した Origin を出す。
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
    const registration = page.getByTestId('job-login-auto-registration');
    await registration.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await registration.getAttribute('data-result')).toBe('SAVED');
    expect(await registration.textContent()).toContain(text.autoRegistration.saved);
    expect(await registration.textContent()).toContain(LOCAL_UI_TEXT.profileForm.revisionText(FIRST_REVISION + 1));
    // 足す Origin は、token の送信先と、自動で登録した送信の送り先だけ（第三者の解析の Origin は足さない）。
    expect(await registration.locator('[data-item="addedServiceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
    // 登録した設定の中身: token の送信先と、token の前の手続きの呼び出しだけ（解析の送信、token の後の送信、危険な語の path は入れない）。
    const setup = page.getByTestId('job-login-setup');
    expect(await setup.locator('[data-item="token"]').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
    const sides = setup.locator('[data-item="sideRequests"] li');
    expect(await sides.evaluateAll((items) => items.map((item) => item.getAttribute('data-path')))).toEqual([TENANT_PATH]);
    expect(await sides.first().textContent()).toBe(text.sideRequestValue(
      LOGIN_SIDE_REQUEST_METHODS[0], `${SERVICE_ORIGIN}${TENANT_PATH}`, formatCount(MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE),
    ));
    expect(await setup.locator('[data-item="serviceOrigins"]').textContent()).toBe(SERVICE_ORIGIN);
    // FM-1（手動の操作を減らす設計書 2.3）: 自動の登録が SAVED なら、「次から自動でログインする」と、その手順の画面への入口を出す。
    // FM2e（同 3A.4。意図して直した期待）: 3 つの画面への入口の代わりに、1 回の操作で設定を終える画面（資格情報の画面）への入口 1 つ。
    const offer = page.getByTestId('job-login-setup-automated-login');
    await offer.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await offer.getByRole('heading').textContent()).toBe(LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.offer.heading);
    expect(await offer.getByTestId('automated-login-offer-setup').getAttribute('href')).toBe(`/credentials/${PROFILE_ID}`);
    await screenshot(page, 'mlb2-03-auto-registration-saved');
  }, SCENARIO_TIMEOUT_MS);

  it('shows the reason and the next step when the job registered nothing', async () => {
    // 前のジョブが登録した設定（改訂 2）のまま、同じ送信を通す。足すものがないので、登録しない（NOTHING_NEW）。
    const jobId = await startJob(FIRST_REVISION + 1);
    await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
    expect(await valueOf('confirmManualLoginFn', 'POST', { jobId })).toEqual({ ok: true });
    await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AUTHENTICATED', JOB_WAIT);
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
    await waitForJobViaServerFunctions(readJob, jobId, (job) => !job.active, JOB_WAIT);
    const page = await openPage(`/jobs/${jobId}`);
    const registration = page.getByTestId('job-login-auto-registration');
    await registration.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await registration.getAttribute('data-result')).toBe('SKIPPED');
    expect(await registration.getAttribute('data-reason')).toBe('NOTHING_NEW');
    const shown = await registration.textContent();
    expect(shown).toContain(text.autoRegistration.skipped);
    expect(shown).toContain(text.autoRegistration.skipReasons.NOTHING_NEW.label);
    expect(shown).toContain(text.autoRegistration.skipReasons.NOTHING_NEW.next);
    // FM-1（設計書 2.3）: 「次から自動でログインする」は、このジョブが登録した（SAVED）ときだけ出す。
    expect(await page.getByTestId('job-login-setup-automated-login').count()).toBe(0);
    await screenshot(page, 'mlb2-04-auto-registration-skipped');
  }, SCENARIO_TIMEOUT_MS);

  it('DEF-146: shows the request error when the call of "ログインを終えた" fails, and the button can be pressed again', async () => {
    const jobId = await startJob(FIRST_REVISION + 1);
    await waitForJobViaServerFunctions(readJob, jobId, (job) => job.lastAuthState === 'AWAITING_LOGIN', JOB_WAIT);
    const page = await openPage(`/jobs/${jobId}`);
    const panel = page.getByTestId('job-manual-login');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    const before = confirmedMessages();
    // テストだけの操作: 「ログインを終えた」の要求を通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
    await page.route((url) => isServerFunctionUrlOf(ids, 'confirmManualLoginFn', url), (route) => route.abort('failed'));
    const button = panel.getByTestId('job-manual-login-confirm');
    await button.click();
    const failed = panel.getByTestId('job-manual-login-request-failed');
    await failed.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await failed.textContent()).toContain(text.rejected);
    expect(await failed.textContent()).toContain(text.requestFailed);
    expect(await panel.getByTestId('job-manual-login-rejection').count()).toBe(0);
    expect(await panel.getByTestId('job-manual-login-accepted').count()).toBe(0);
    expect(await button.isDisabled()).toBe(false);
    expect(confirmedMessages()).toBe(before);
    await screenshot(page, 'mlb2-05-confirm-request-failed');
    await page.close();
    // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す。
    expect(takeConsoleErrors(page, /^Failed to load resource: /u).length).toBeGreaterThan(0);
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: false })).toMatchObject({ ok: true });
    await waitForJobViaServerFunctions(readJob, jobId, (job) => !job.active, JOB_WAIT);
  }, SCENARIO_TIMEOUT_MS);
});
