/**
 * AS-b（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1・2.3、受け入れ条件 5）: プロファイルの画面の、監査の段の送信の扱いの設定と、
 * ジョブの画面の、通したことの知らせを、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。
 * - 設定は表示の設定と同じ欄（`DisplaySettingsPanel`。承認に結ばれるプロファイルの改訂の外）。既定は読み取りだけ。通す側へ切り替えるときは確認のダイアログ
 *   （やめると切り替わらない）。保存してもプロファイルの改訂は変わらない。読み取りだけへ戻すときはダイアログを出さない。
 *   FM-3: 専用の保存のボタンはない。通す側へは、確認のダイアログで「通す」を選んだ時点で保存する（「やめる」なら保存の要求を送らない）。読み取りだけへは、
 *   切り替えた時点で保存する。保存できなければ、チェックを元の値に戻し、誤りを出す。
 * - ジョブの画面: 終わった監査のジョブの `run.json` の `safety.auditSend` が `PASS_EXCEPT_DELETE` なら、「この監査では、ページが出す送信のうち削除のほかを通した
 *   （N 件）」を目立つ形で出す。読み取りだけの Run と、項目のない古い Run には出さない。文言と出すかどうかは表示カタログ（同じ部品を報告と共用する）。
 * - 通した要求の path（値に見える区切りは伏せたもの）と、目印の値は、画面に出さない（数だけ）。
 * ジョブの行と成果物は、テストだけの操作で書く（ワーカーは起動しない。サイトへは接続しない）。値は匿名（ループバック）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { RunAuditSendSummary, RunSummary } from '../../../src/core/contracts.js';
import { createRunId } from '../../../src/core/ids.js';
import { formatCount } from '../../../src/presentation/format.js';
import { AUDIT_SEND_TEXT, LOCAL_UI_DISPLAY_SETTINGS_TEXT } from '../../../src/presentation/messages.js';
import { runSummary } from '../../../tests/helpers/audit-run-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const PROFILE_ID = 'asb-send';
const CREATED_AT = '20261019020000';
const STARTED_AT = '20261019020001';
const FINISHED_AT = '20261019020100';
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
const PASSED_REQUESTS = 4;
const PASSED_OTHER_ORIGIN_REQUESTS = 2;
const PASSED_WEB_SOCKETS = 3;
/** AS-c fix round 1: そのうち Guard の判定を通らずに開いた接続と、危険な語の接続の数。 */
const PASSED_WEB_SOCKETS_OUTSIDE_GUARD = 2;
const PASSED_DANGEROUS_WEB_SOCKETS = 1;
/** 画面に出てはならない目印（`run.json` の method ごとの数の鍵に入れる）。 */
const MARKER = 'asb-marker-not-on-screen';
const NOTICE_PREFIX = 'この監査では、ページが出す送信のうち削除のほかを通した';
/** FM-3: 止めた要求で、Chromium が console に出す誤り（テストがわざと起こしたもの）。 */
const LOAD_FAILURE_PATTERN = /^Failed to load resource: /u;

const text = LOCAL_UI_DISPLAY_SETTINGS_TEXT;

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

const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: process.env['ASB_SCREENSHOT_DIR'],
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};
const profileRevision = async (): Promise<number> =>
  (await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: PROFILE_ID })).profile.revision;
const storedPolicy = async (): Promise<string> =>
  (await valueOf<{ auditSendPolicy: string }>('profileDisplaySettingsFn', 'GET', { profileId: PROFILE_ID })).auditSendPolicy;
/** FM-3: 画面が送る、表示の設定の保存の要求か（`page.route` と要求の記録の判定）。 */
const isSaveRequest = (url: URL): boolean => isServerFunctionUrlOf(ids, 'saveProfileDisplaySettingsFn', url);
/** FM-3: `page` が送った保存の要求を数える（記録の配列を返す）。 */
const recordSaveRequests = (page: Page): string[] => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (isSaveRequest(new URL(request.url()))) {
      requests.push(request.method());
    }
  });
  return requests;
};

/** 終わった監査のジョブの行と、その `run.json` を書く（テストだけの操作。ワーカーの代わり）。`auditSend` が `null` なら、項目のない古い Run。 */
const writeFinishedAuditJob = (jobId: string, sequence: number, auditSend: RunAuditSendSummary | null): void => {
  const runId = createRunId(20261019020000 + sequence);
  const base = runSummary({ runId });
  const run: RunSummary = {
    ...base,
    safety: { ...base.safety, ...(auditSend === null ? {} : { auditSend }) },
  };
  const runDirectory = join(rootOf().root, outputDirectoryOf(PROFILE_ID), runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, 'run.json'), JSON.stringify(run), 'utf8');
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
      .toEqual({ ok: true });
    expect(recordRunStarted(database, jobId, { runId, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
    expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId, runDirectory: runId, runStatus: 'COMPLETE' }, FINISHED_AT)).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  const targetConfigPath = writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
  writeFinishedAuditJob('job-asb-passed', 1, {
    // 目印は method の鍵に入れる（画面は数だけを出すので、出てはならない）。
    policy: 'PASS_EXCEPT_DELETE', passedRequests: PASSED_REQUESTS, passedRequestsByMethod: { POST: 3, [MARKER]: 1 },
    // AS-c: ほかの Origin へ通した数と、通した WebSocket の接続の数。
    passedOtherOriginRequests: PASSED_OTHER_ORIGIN_REQUESTS, passedWebSockets: PASSED_WEB_SOCKETS,
    // AS-c fix round 1: Guard の判定を通らずに開いた接続と、危険な語の接続。
    passedWebSocketsOutsideGuard: PASSED_WEB_SOCKETS_OUTSIDE_GUARD, passedDangerousWebSockets: PASSED_DANGEROUS_WEB_SOCKETS,
  });
  writeFinishedAuditJob('job-asb-read-only', 2, { policy: 'READ_ONLY', passedRequests: 0, passedRequestsByMethod: {} });
  writeFinishedAuditJob('job-asb-old', 3, null);
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

describe('AS-b: the audit send policy of a profile', () => {
  it('is READ_ONLY by default, asks before switching to PASS_EXCEPT_DELETE and saves on the confirm only, keeps the revision, and goes back (saved on the switch) without a dialog', async () => {
    const before = await profileRevision();
    expect(await storedPolicy()).toBe('READ_ONLY');
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const saveRequests = recordSaveRequests(page);
    const panel = page.getByTestId('profile-display-settings');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    // FM-3: 欄に専用の保存のボタンはない。
    expect(await panel.getByRole('button').count()).toBe(0);
    const toggle = panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
    expect(await toggle.isChecked()).toBe(false);

    // やめると、切り替わらず、保存の要求を送らない。
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: text.auditSendDialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await dialog.textContent()).toContain(text.auditSendDialogBody);
    await screenshot(page, 'asb-10-confirm-dialog');
    await dialog.getByRole('button', { name: text.auditSendCancel, exact: true }).click();
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect(await toggle.isChecked()).toBe(false);
    expect(saveRequests).toEqual([]);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    expect(await storedPolicy()).toBe('READ_ONLY');

    // 「通す」を選ぶと、切り替わり、その場で保存される（保存のボタンを押さない。プロファイルの改訂は変わらない）。
    await toggle.click();
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.auditSendConfirm, exact: true }).click();
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    await panel.getByTestId('profile-display-settings-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await toggle.isChecked()).toBe(true);
    expect(saveRequests).toEqual(['POST']);
    expect(await storedPolicy()).toBe('PASS_EXCEPT_DELETE');
    expect(await profileRevision()).toBe(before);

    const again = await openPage(`/profiles/${PROFILE_ID}`);
    const againSaveRequests = recordSaveRequests(again);
    const reloaded = again.getByTestId('profile-display-settings');
    await reloaded.waitFor({ timeout: UI_TIMEOUT_MS });
    const reloadedToggle = reloaded.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
    expect(await reloadedToggle.isChecked()).toBe(true);
    await screenshot(again, 'asb-11-pass-except-delete');

    // 読み取りだけへ戻すときは、ダイアログを出さず、切り替えた時点で保存される。
    await reloadedToggle.click();
    expect(await again.getByRole('dialog', { name: text.auditSendDialogTitle }).isVisible()).toBe(false);
    await reloaded.getByTestId('profile-display-settings-saved').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reloadedToggle.isChecked()).toBe(false);
    expect(againSaveRequests).toEqual(['POST']);
    expect(await storedPolicy()).toBe('READ_ONLY');
    expect(await profileRevision()).toBe(before);
  }, SCENARIO_TIMEOUT_MS);

  it('puts the switch back to READ_ONLY and shows the error when the save after the confirm fails', async () => {
    expect(await storedPolicy()).toBe('READ_ONLY');
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const panel = page.getByTestId('profile-display-settings');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    const toggle = panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete });
    // テストだけの操作: 画面が送る保存の要求を、通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
    await page.route(isSaveRequest, (route) => route.abort('failed'));
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: text.auditSendDialogTitle });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.auditSendConfirm, exact: true }).click();
    const failed = panel.getByTestId('profile-display-settings-request-failed');
    await failed.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await failed.textContent()).toContain(text.requestFailed);
    // チェックは読み取りだけに戻り、また押せる。保存された扱いは読み取りだけのまま。
    expect(await toggle.isChecked()).toBe(false);
    expect(await toggle.getAttribute('data-policy')).toBe('READ_ONLY');
    expect(await toggle.isDisabled()).toBe(false);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    expect(await storedPolicy()).toBe('READ_ONLY');
    await screenshot(page, 'fm3-20-audit-send-request-failed');
    // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す。
    expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT_MS);

  it('keeps the input check of the save (the listed values only), and the display only save keeps the policy', async () => {
    for (const auditSendPolicy of ['PASS_ALL', '', null, true]) {
      const result = await call('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true, auditSendPolicy });
      expect(result.response.status, String(auditSendPolicy)).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' }))
      .toEqual({ ok: true, settings: { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
    expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true }))
      .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'PASS_EXCEPT_DELETE' } });
    expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: PROFILE_ID, showJobBrowser: true, auditSendPolicy: 'READ_ONLY' }))
      .toEqual({ ok: true, settings: { showJobBrowser: true, auditSendPolicy: 'READ_ONLY' } });
  });
});

describe('AS-b: the notice of the passed sends on the job screen', () => {
  it('shows the notice with the number for a PASS_EXCEPT_DELETE audit, and nothing for READ_ONLY and an old Run', async () => {
    const passed = await openPage('/jobs/job-asb-passed');
    const notice = passed.getByTestId('job-audit-send-notice');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.textContent()).toContain(AUDIT_SEND_TEXT.passedNotice(formatCount(PASSED_REQUESTS)));
    expect(await notice.getAttribute('data-policy')).toBe('PASS_EXCEPT_DELETE');
    // AS-c: 内訳（ほかの Origin への送信と、WebSocket の接続）。
    expect(await passed.getByTestId('job-audit-send-detail').textContent())
      .toBe(AUDIT_SEND_TEXT.passedDetail(formatCount(PASSED_OTHER_ORIGIN_REQUESTS), formatCount(PASSED_WEB_SOCKETS)));
    // AS-c fix round 1: Guard の判定を通らずに開いた接続と、危険な語の接続の知らせ。
    expect(await passed.getByTestId('job-audit-send-websocket-caution').textContent())
      .toBe(AUDIT_SEND_TEXT.webSocketCaution(formatCount(PASSED_WEB_SOCKETS_OUTSIDE_GUARD), formatCount(PASSED_DANGEROUS_WEB_SOCKETS)));
    expect(await passed.content()).not.toContain(MARKER);
    await screenshot(passed, 'asb-20-job-notice');
    for (const jobId of ['job-asb-read-only', 'job-asb-old']) {
      const page = await openPage(`/jobs/${jobId}`);
      await page.getByTestId('job-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      await page.getByTestId('job-run-status').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('job-audit-send-notice').count(), jobId).toBe(0);
      expect(await page.getByTestId('job-audit-send-websocket-caution').count(), jobId).toBe(0);
      expect(await page.content(), jobId).not.toContain(NOTICE_PREFIX);
    }
  }, SCENARIO_TIMEOUT_MS);
});
