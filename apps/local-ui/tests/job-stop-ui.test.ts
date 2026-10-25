/**
 * DEF-146: ジョブの画面の「監査を止める」の確認のダイアログで「止める」を押した後に、止める要求の結果を必ず画面に出すことを、ビルドした画面のサーバ
 * （一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - 発見のジョブ（`DISCOVERY`）でも、ボタンとダイアログが出て、「止める」が Server Function（`stopAuditJobFn`）を呼ぶ。ジョブの管理が拒んだ理由
 *   （このテストの行はこの画面のサーバのものではないので `JOB_NOT_OWNED`）を出し、ダイアログを閉じる。
 * - Server Function の呼び出しが例外で終わる（通信の誤り、入力の検証の誤りの 400）・結果の形でない値で終わるときも、何も出さずに消えず、要求の誤りを
 *   出してダイアログを閉じ、もう一度押せる。誤りは、画面が送る止める要求を、テストだけの操作（`page.route`）で止める・差し替えて起こす。
 * - 画面のサーバが落ちた後（テストだけの操作で止める）に押したときも、要求の誤りを出す。
 * - DEF-146 の 2 回目: 確認のダイアログの題と確定のボタンは、ジョブの種類に合わせた呼び名（発見のジョブは「発見を止めますか」「発見を止める」）で、
 *   取り消しは「止めずに戻る」（「やめる」と読み違えない）。文言はカタログ（`AUDIT_JOB_STOP_TARGET_NAMES`、`LOCAL_UI_AUDIT_TEXT.stopDialog`）。
 * - T44d（Task 44 の設計書 P2-3）: ダイアログの本文（`AUDIT_JOB_STOP_DIALOG_BODIES`）と、ジョブの画面の大きい止めるボタン（「発見を止める」）も、
 *   ジョブの種類に合わせる。止める要求を送った後の文（`AUDIT_JOB_STOP_REQUESTED_TEXTS`）も、種類ごと（発見は「次の画面を読まずに止まります」）。
 * ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない。サイトへは接続しない）。値は匿名（ループバック）。
 */
import type { Browser, BrowserContext, Locator, Page, Route } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordEnded, recordRunStarted, recordStopping } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import {
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  LOCAL_UI_AUDIT_TEXT,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { callServerFunction, encodeServerFunctionPayload, isServerFunctionUrlOf, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const PROFILE_ID = 'def146-stop';
const JOB_ID = 'job-def146-discovery';
const RUN_ID = 'RUN-20261021000000';
/** T44d: 止める要求の後の文を確かめた後に替える、動いている行の ID。 */
const NEXT_JOB_ID = 'job-t44d-discovery-next';
const NEXT_RUN_ID = 'RUN-20261021000001';
/** 止めた・差し替えた要求と、落とした画面のサーバへの要求で、Chromium が console に出す誤り（テストがわざと起こしたもの）。 */
const LOAD_FAILURE_PATTERN = /^Failed to load resource: /u;
const STATUS = Object.freeze({ OK: 200 });

const text = LOCAL_UI_AUDIT_TEXT;
/** 発見のジョブの、止める確認のダイアログの呼び名。 */
const DISCOVERY_TARGET = AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY;
/** 前の取り消しのボタンの文言（「止める」と読み違えた。DEF-146）。 */
const AMBIGUOUS_CANCEL_LABEL = 'やめる';

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
  screenshotDirectory: process.env['DEF146_SCREENSHOT_DIR'],
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

/** 画面が送る、止める要求か（`page.route` の判定）。 */
const isStopRequest = (url: URL): boolean => isServerFunctionUrlOf(ids, 'stopAuditJobFn', url);

/** 今動いている（テストの行の）発見のジョブ（T44d: 止める要求の後の文を確かめたら、別の ID の行に替える）。 */
let runningJobId = JOB_ID;

/** テストだけの操作: 管理データを開いて `operate` を行う。 */
const withDatabase = (operate: (database: ReturnType<typeof openControlDatabase>, now: string) => void): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    operate(database, formatCompactUtcTimestamp(new Date(), 'test job time'));
  } finally {
    closeControlDatabase(database);
  }
};

/** テストだけの操作: 動いている発見のジョブの行を書く（ワーカーの代わり。この画面のサーバのジョブの管理は持たない）。 */
const writeRunningDiscoveryJob = (jobId: string, runId: string): void => {
  withDatabase((database, now) => {
    expect(createStartingJob(database, { jobId, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: now }, () => null))
      .toEqual({ ok: true });
    expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: now })).toBe(true);
  });
  runningJobId = jobId;
};

/** ジョブの画面を開き、「監査を止める」→ 確認のダイアログの「止める」を押す。止める欄を返す。 */
const pressStop = async (page: Page): Promise<{ dialog: Locator; stopButton: Locator }> => {
  const stopButton = page.getByRole('button', { name: text.job.stop(DISCOVERY_TARGET), exact: true });
  await stopButton.click();
  const dialog = page.getByRole('dialog', { name: text.stopDialog.title(DISCOVERY_TARGET) });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  await dialog.getByRole('button', { name: text.stopDialog.confirm(DISCOVERY_TARGET), exact: true }).click();
  return { dialog, stopButton };
};

const openRunningJob = async (): Promise<Page> => {
  const page = await openPage(`/jobs/${runningJobId}`);
  await page.locator('[data-testid="job-state"][data-state="RUNNING"]').waitFor({ timeout: UI_TIMEOUT_MS });
  expect(await page.getByTestId('job-kind').getAttribute('data-kind')).toBe('DISCOVERY');
  return page;
};

/** 要求の誤りが出て、ダイアログが閉じ、もう一度押せる。 */
const expectRequestFailed = async (page: Page, dialog: Locator, stopButton: Locator, name: string): Promise<void> => {
  const failed = page.getByTestId('job-stop-request-failed');
  await failed.waitFor({ timeout: UI_TIMEOUT_MS });
  expect(await failed.textContent(), name).toContain(text.job.stopRequestFailed);
  expect(await page.getByText(text.job.stopRejectedHeading).count(), name).toBe(1);
  expect(await page.getByTestId('job-stop-rejection').count(), name).toBe(0);
  await expect.poll(async () => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
  expect(await stopButton.isDisabled(), name).toBe(false);
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
  writeRunningDiscoveryJob(JOB_ID, RUN_ID);
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

describe('DEF-146: the result of the stop on the job screen of a discovery job', () => {
  it('names the dialog after the kind of the job, and the cancel reads "do not stop" (no "やめる")', async () => {
    const page = await openRunningJob();
    let stopRequests = 0;
    await page.route(isStopRequest, async (route) => {
      stopRequests += 1;
      await route.continue();
    });
    // T44d（Task 44 の設計書 P2-3）: 大きい止めるボタンも、ジョブの種類の呼び名（「監査を止める」は出さない）。
    expect(await page.getByRole('button', { name: text.job.stop(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT) }).count()).toBe(0);
    await page.getByRole('button', { name: text.job.stop(DISCOVERY_TARGET), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: text.stopDialog.title(DISCOVERY_TARGET) });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(text.stopDialog.title(DISCOVERY_TARGET)).toBe('発見を止めますか');
    // T44d: 本文は発見のもの（再開しない）。監査の本文（今のページの監査を終えてから止まり、続きから再開する）は出さない。
    const dialogText = await dialog.textContent();
    expect(dialogText).toContain(AUDIT_JOB_STOP_DIALOG_BODIES.DISCOVERY.stop);
    expect(dialogText).not.toContain(AUDIT_JOB_STOP_DIALOG_BODIES.AUDIT.stop);
    expect(dialogText).not.toContain('続きから再開');
    expect(await dialog.getByRole('button').allTextContents()).toEqual([text.stopDialog.cancel, text.stopDialog.confirm(DISCOVERY_TARGET)]);
    expect(text.stopDialog.confirm(DISCOVERY_TARGET)).toBe('発見を止める');
    expect(text.stopDialog.cancel).toBe('止めずに戻る');
    expect(await dialog.getByRole('button', { name: AMBIGUOUS_CANCEL_LABEL, exact: true }).count()).toBe(0);
    // 開いたときのフォーカスは取り消し（今の決まりのまま）。取り消すと、止める要求は送らない。
    expect(await dialog.getByRole('button', { name: text.stopDialog.cancel }).evaluate((element) => element === document.activeElement)).toBe(true);
    await screenshot(page, 'def146-00-dialog');
    await page.keyboard.press('Enter');
    await expect.poll(async () => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect(stopRequests).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the text after the stop request for the kind of the job (T44d: a discovery job does not read the next screen)', async () => {
    // テストだけの操作: 動いている行を「止めています」にする（ジョブの管理の代わり）。確かめた後は終わりにし、別の ID の動いている行に替える。
    const stoppingJobId = runningJobId;
    withDatabase((database, now) => {
      expect(recordStopping(database, stoppingJobId, now)).toBe(true);
    });
    const page = await openPage(`/jobs/${stoppingJobId}`);
    await page.locator('[data-testid="job-state"][data-state="STOPPING"]').waitFor({ timeout: UI_TIMEOUT_MS });
    const requested = page.getByTestId('job-stop-requested');
    expect(await requested.textContent()).toBe(AUDIT_JOB_STOP_REQUESTED_TEXTS.DISCOVERY);
    expect(await requested.textContent()).not.toBe(AUDIT_JOB_STOP_REQUESTED_TEXTS.AUDIT);
    // 止める要求の後は、ふつうの止めるボタンを出さない（今のまま）。
    expect(await page.getByRole('button', { name: text.job.stop(DISCOVERY_TARGET), exact: true }).count()).toBe(0);
    await screenshot(page, 't44d-00-stop-requested');
    withDatabase((database, now) => {
      expect(recordEnded(database, stoppingJobId, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: now })).toBe(true);
    });
    writeRunningDiscoveryJob(NEXT_JOB_ID, NEXT_RUN_ID);
  }, SCENARIO_TIMEOUT_MS);

  it('calls the stop from the dialog and shows the reason the job management refused it', async () => {
    const page = await openRunningJob();
    const { dialog, stopButton } = await pressStop(page);
    const rejection = page.getByTestId('job-stop-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('JOB_NOT_OWNED');
    expect(await rejection.textContent()).toContain(AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS.JOB_NOT_OWNED.description);
    await expect.poll(async () => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect(await stopButton.isDisabled()).toBe(false);
    expect(await page.getByTestId('job-stop-request-failed').count()).toBe(0);
    await screenshot(page, 'def146-01-rejected');
  }, SCENARIO_TIMEOUT_MS);

  it('shows the request error when the stop call throws or ends without a result (communication, input check, unexpected value)', async () => {
    const failures: readonly { readonly name: string; readonly fail: (route: Route) => Promise<void>; readonly loadFailure: boolean }[] = [
      // テストだけの操作: 要求を通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
      { name: 'communication', fail: (route) => route.abort('failed'), loadFailure: true },
      // テストだけの操作: 入力を、検証で拒まれる形に差し替える（画面のサーバが 400 を返す）。
      { name: 'input check', fail: (route) => route.continue({ postData: encodeServerFunctionPayload({ jobId: runningJobId, force: 'true' }) }), loadFailure: true },
      // テストだけの操作: 結果の形でない値を返す（200。止める結果の `ok` も理由もない）。
      { name: 'unexpected value', fail: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: encodeServerFunctionPayload(null) }), loadFailure: false },
    ];
    for (const { name, fail, loadFailure } of failures) {
      const page = await openRunningJob();
      await page.route(isStopRequest, fail);
      const { dialog, stopButton } = await pressStop(page);
      await expectRequestFailed(page, dialog, stopButton, name);
      await screenshot(page, `def146-02-request-failed-${name.replaceAll(' ', '-')}`);
      await page.close();
      if (loadFailure) {
        // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す（ほかの誤りは、各テストの後の確かめで誤りになる）。
        expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length, name).toBeGreaterThan(0);
      }
    }
  }, SCENARIO_TIMEOUT_MS);

  it('shows the request error when the screen server has gone', async () => {
    const page = await openRunningJob();
    // テストだけの操作: 画面のサーバを落とす（ページは開いたまま）。
    await stopServer(server);
    const { dialog, stopButton } = await pressStop(page);
    await expectRequestFailed(page, dialog, stopButton, 'server gone');
    await screenshot(page, 'def146-03-server-gone');
    await page.close();
    expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT_MS);
});
