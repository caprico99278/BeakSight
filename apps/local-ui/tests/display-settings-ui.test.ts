/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.2 の画面）: プロファイルの画面の表示の設定（ジョブのブラウザを表示する。
 * 既定は表示）と、ジョブの画面の「見るだけ。操作しない」の注意を、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。表示の設定は、
 * 承認に結ばれるプロファイルの文書・改訂とは別に持つ（切り替えても、プロファイルの改訂は変わらない）。ジョブの行は、テストだけの操作で管理データに書く
 * （ワーカーは起動しない。サイトへは接続しない）。値は匿名（ループバック）。
 * FM-3: 表示の設定は、チェックを切り替えたらその場で保存する（欄の専用の保存のボタンはない）。保存の間はチェックを押せず、保存できたら欄の中に
 * 「保存しました」を出す。保存できない（拒まれた・Server Function が例外を投げた）ときは、チェックを元の値に戻し、理由を出す。失敗は、画面が送る
 * 保存の要求を、テストだけの操作（`page.route`）で止める・差し替えて起こす。
 */
import type { Browser, BrowserContext, Locator, Page, Route } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordEnded } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { ProfileDisplaySettings } from '../../../src/control/store/profile-store.js';
import { LOCAL_UI_DISPLAY_SETTINGS_TEXT } from '../../../src/presentation/messages.js';
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
const PROFILE_ID = 'fm1-display';
/** FM-3: 保存の要求の入力を差し替える先の、ないプロファイル（画面のサーバが `PROFILE_NOT_FOUND` で拒む）。 */
const MISSING_PROFILE_ID = 'fm3-not-there';
/** FM-3: 止めた・差し替えた要求で、Chromium が console に出す誤り（テストがわざと起こしたもの）。 */
const LOAD_FAILURE_PATTERN = /^Failed to load resource: /u;
const RUNNING_JOB_ID = 'job-fm1-running';
const ENDED_JOB_ID = 'job-fm1-ended';
const JOB_CREATED_AT = '20261019010000';
const JOB_ENDED_AT = '20261019011000';
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });

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
  screenshotDirectory: process.env['FM1_SCREENSHOT_DIR'],
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
const storedSettings = (): Promise<ProfileDisplaySettings> => valueOf<ProfileDisplaySettings>('profileDisplaySettingsFn', 'GET', { profileId: PROFILE_ID });
/** FM-3: 画面が送る、表示の設定の保存の要求か（`page.route` の判定）。 */
const isSaveRequest = (url: URL): boolean => isServerFunctionUrlOf(ids, 'saveProfileDisplaySettingsFn', url);

/** FM-3: プロファイルの画面を開き、表示の設定の欄と、ジョブのブラウザのチェックを返す。 */
const openDisplaySettings = async (): Promise<{ page: Page; panel: Locator; toggle: Locator }> => {
  const page = await openPage(`/profiles/${PROFILE_ID}`);
  const panel = page.getByTestId('profile-display-settings');
  await panel.waitFor({ timeout: UI_TIMEOUT_MS });
  return { page, panel, toggle: panel.getByRole('checkbox', { name: text.showJobBrowser }) };
};

/** テストだけの操作: 動いている監査のジョブの行と、終わった行を書く（ワーカーの代わり）。 */
const writeJobs = (): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    for (const jobId of [ENDED_JOB_ID, RUNNING_JOB_ID]) {
      expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
        .toEqual({ ok: true });
      if (jobId === ENDED_JOB_ID) {
        expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
      }
    }
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
  writeJobs();
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

describe('FM-1: the display setting of the job browser and the watch-only notice', () => {
  it('shows the job browser by default, warns not to operate it on a running job, and not on an ended job', async () => {
    const profile = await openPage(`/profiles/${PROFILE_ID}`);
    const panel = profile.getByTestId('profile-display-settings');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('checkbox', { name: text.showJobBrowser }).isChecked()).toBe(true);
    await screenshot(profile, 'fm1-10-display-settings');
    const running = await openPage(`/jobs/${RUNNING_JOB_ID}`);
    const notice = running.getByTestId('job-browser-watch-only');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.textContent()).toContain(text.watchOnly);
    const ended = await openPage(`/jobs/${ENDED_JOB_ID}`);
    await ended.getByTestId('job-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await ended.getByTestId('job-browser-watch-only').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('saves the setting on the switch itself (no save button, the switches are disabled while saving) without changing the profile revision, and the running job shows no notice when the browser is hidden', async () => {
    const before = await profileRevision();
    const { page, panel, toggle } = await openDisplaySettings();
    // FM-3: 欄に専用の保存のボタンはない。切り替えるとすぐ保存すること（プロファイルの保存とは別）を、欄の説明に出す。
    expect(await panel.getByRole('button').count()).toBe(0);
    expect(await panel.textContent()).toContain(text.autoSaveNote);
    // 保存の要求を止めておき、保存の間は、どちらのチェックも押せないことを確かめる（テストだけの操作）。
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const hold = async (route: Route): Promise<void> => {
      await held;
      await route.continue();
    };
    await page.route(isSaveRequest, hold);
    await toggle.click();
    await expect.poll(() => toggle.isDisabled(), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await panel.getByRole('checkbox', { name: text.auditSendPassExceptDelete }).isDisabled()).toBe(true);
    expect(await panel.getByTestId('profile-display-settings-saving').textContent()).toBe(text.saving);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    release();
    // 切り替えるだけで保存される（ボタンを押さない）。
    const saved = panel.getByTestId('profile-display-settings-saved');
    await saved.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await saved.textContent()).toBe(text.saved);
    await page.unroute(isSaveRequest, hold);
    expect(await toggle.isDisabled()).toBe(false);
    expect(await toggle.isChecked()).toBe(false);
    // 保存の後も、切り替えたチェックにフォーカスが残る（キーボードで続けて操作できる）。
    expect(await toggle.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await panel.getByTestId('profile-display-settings-saving').count()).toBe(0);
    expect(await storedSettings()).toEqual({ showJobBrowser: false, auditSendPolicy: 'READ_ONLY' });
    expect(await profileRevision()).toBe(before);
    await screenshot(page, 'fm3-10-saved-on-switch');
    const again = await openPage(`/profiles/${PROFILE_ID}`);
    const reloaded = again.getByTestId('profile-display-settings');
    await reloaded.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reloaded.getByRole('checkbox', { name: text.showJobBrowser }).isChecked()).toBe(false);
    const running = await openPage(`/jobs/${RUNNING_JOB_ID}`);
    await running.getByTestId('job-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await running.getByTestId('job-browser-watch-only').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('puts the switch back and shows the reason when the save is rejected, and keeps the stored setting', async () => {
    const stored = await storedSettings();
    const { page, panel, toggle } = await openDisplaySettings();
    expect(await toggle.isChecked()).toBe(stored.showJobBrowser);
    // テストだけの操作: 画面が送る保存の要求の入力を、ないプロファイルに差し替える（画面のサーバが PROFILE_NOT_FOUND で拒む）。
    await page.route(isSaveRequest, (route) =>
      route.continue({ postData: encodeServerFunctionPayload({ profileId: MISSING_PROFILE_ID, showJobBrowser: !stored.showJobBrowser }) }));
    await toggle.click();
    const rejection = panel.getByTestId('profile-display-settings-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('PROFILE_NOT_FOUND');
    expect(await rejection.textContent()).toContain(text.rejected);
    expect(await rejection.textContent()).toContain(text.reasons.PROFILE_NOT_FOUND);
    // チェックは元の値に戻り、また押せる。「保存しました」は出さない。
    expect(await toggle.isChecked()).toBe(stored.showJobBrowser);
    expect(await toggle.isDisabled()).toBe(false);
    expect(await panel.getByTestId('profile-display-settings-saved').count()).toBe(0);
    expect(await storedSettings()).toEqual(stored);
    await screenshot(page, 'fm3-11-rejected');
  }, SCENARIO_TIMEOUT_MS);

  it('puts the switch back and shows the error when the save throws (an input check error and a communication error)', async () => {
    const failures: readonly { readonly name: string; readonly fail: (route: Route) => Promise<void> }[] = [
      // テストだけの操作: 入力を、検証で拒まれる形に差し替える（画面のサーバが 400 を返し、Server Function の呼び出しが例外を投げる）。
      { name: 'input check', fail: (route) => route.continue({ postData: encodeServerFunctionPayload({ profileId: PROFILE_ID, showJobBrowser: 'yes' }) }) },
      // テストだけの操作: 要求を通信の誤りで終える（Server Function の呼び出しが例外を投げる）。
      { name: 'communication', fail: (route) => route.abort('failed') },
    ];
    for (const { name, fail } of failures) {
      const stored = await storedSettings();
      const { page, panel, toggle } = await openDisplaySettings();
      await page.route(isSaveRequest, fail);
      await toggle.click();
      const failed = panel.getByTestId('profile-display-settings-request-failed');
      await failed.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await failed.textContent(), name).toContain(text.rejected);
      expect(await failed.textContent(), name).toContain(text.requestFailed);
      expect(await toggle.isChecked(), name).toBe(stored.showJobBrowser);
      expect(await toggle.isDisabled(), name).toBe(false);
      expect(await panel.getByTestId('profile-display-settings-saved').count(), name).toBe(0);
      expect(await panel.getByTestId('profile-display-settings-rejection').count(), name).toBe(0);
      expect(await storedSettings(), name).toEqual(stored);
      await screenshot(page, `fm3-12-request-failed-${name.replaceAll(' ', '-')}`);
      // わざと起こした読み込みの誤りだけを、console の誤りの記録から外す（ほかの誤りは、各テストの後の確かめで誤りになる）。
      expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length, name).toBeGreaterThan(0);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('keeps the input check of the save', async () => {
    for (const data of [{ profileId: PROFILE_ID, showJobBrowser: 'yes' }, { profileId: PROFILE_ID }, { profileId: PROFILE_ID, showJobBrowser: true, extra: 1 }]) {
      expect((await call('saveProfileDisplaySettingsFn', 'POST', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('saveProfileDisplaySettingsFn', 'POST', { profileId: 'not-there', showJobBrowser: true })).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND' });
  });
});
