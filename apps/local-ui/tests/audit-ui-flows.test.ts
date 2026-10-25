/**
 * 画面から監査を動かす操作の確かめ（Task 24 の設計書 4.4、4.8、7 章「画面」と「負荷」。T24f）。ビルドした画面を一時の root の起動の部品で
 * 起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - プロファイルの登録 → 「監査を始める」→ 開始の画面（設定の要点は読むだけ）→ 進み具合が進む → 終わる → 詳細でレポートを開ける・JSON と ZIP を
 *   落とせる（キーボードだけで操作する）。
 * - 止める（確かめのダイアログ）→ 一部未完了（PARTIAL）。画面を閉じて開き直すと同じ状態。実行履歴と、一覧の「最後の Run」。
 * - 画面のサーバを強制終了 → ワーカーと Chromium が残らない → 起動し直すと、そのジョブが「中断」→ 「前回の続きから再開する」で、同じ Run の
 *   続きから再開する（`RESUME`。Run の ID が同じで、実行の記録が 2 回）。
 * - 監査の間、fixture のサイトに届く要求の間隔が、設定の間隔以上（画面のポーリングで変わらない）。届いた要求は GET と HEAD だけ。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。node と Chromium の process が残らない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。スクリーンショットは、環境変数 `T24F_SCREENSHOT_DIR` があれば、そこに保存する。
 */
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Download, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_JOB_STATE_CATALOG, RUN_EXECUTION_END_REASON_CATALOG, RUN_STATUS_CATALOG } from '../../../src/presentation/catalog.js';
import { formatCount, formatDuration } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_TARGET_NAMES,
  AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION,
  INCOMPLETE_REASON_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_JOB_CONSOLE_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { BROWSER_DEFAULT_FAVICON_PATH, launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  outputDirectoryOf,
  publicProfileDocument,
  startTimedSite,
  targetConfigPathOf,
  writeAuditTargetConfig,
  type SiteRequest,
  type TimedSite,
} from './helpers/audit-site.ts';
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
import { chooseExistingTargetConfig } from './helpers/profile-form.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** 監査の終わりを待つ上限（ミリ秒）。 */
const AUDIT_TIMEOUT_MS = 150_000;
/** 1 つの場面の上限（ミリ秒。監査を 1〜2 回動かす）。 */
const SCENARIO_TIMEOUT_MS = 300_000;
/** process が消えるのを待つ上限（ミリ秒）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 60;
/** 最後まで監査する場面の、ページの読み込みの最小の間隔（ms）。 */
const FULL_INTERVAL_MS = 1_000;
/** 止める場面と、強制終了から再開する場面の間隔（ms。最初のページの後、次のページを終える前に止めるため）。 */
const SLOW_INTERVAL_MS = 3_000;
/**
 * サーバの側の間隔の許容（ms）。DEF-100 fix から、pacer は、読み込みの開始と、前の読み込みの文書の要求を送った時刻・その応答を受けた時刻の
 * 最も遅い方から間隔を数えるので、応答を返した文書の要求がサーバに届く間隔は、設定の間隔以上になる（`tests/integration/navigation-pacing.test.ts`
 * の DEF-100 の test は、許容なしで確かめる）。この画面の test も、DEF-100 の後片付けで許容を 0 にした（両方の Chromium の設定で 5 回ずつ流し、
 * 届く間隔は設定の間隔より 18〜51ms 長かった。2026-10-13）。
 */
const ARRIVAL_JITTER_TOLERANCE_MS = 0;
/** テストの値（匿名）。 */
const FULL_PROFILE = 't24f-ui-full';
const STOP_PROFILE = 't24f-ui-stop';
const RESUME_PROFILE = 't24f-ui-resume';
/** ダウンロードのファイル名の形。 */
const ASCII_FILE_NAME = /^[A-Za-z0-9._-]+$/u;

const text = LOCAL_UI_AUDIT_TEXT;
/** T44e: ジョブの画面の次にできること。 */
const nextSteps = LOCAL_UI_JOB_NEXT_STEPS;
/** T44e: ページの上限で止まる場面（ページの上限 1）。 */
const LIMIT_PROFILE = 't44e-ui-limit';
/** T44g: 設定のファイルの `crawl.allowedQueryParameters` に秘密に見える名前（`token`）を持つ、公開の監査のプロファイル。 */
const SECRET_QUERY_PROFILE = 't44g-ui-secret-query';
const SCREENSHOT_DIRECTORY = process.env['T24F_SCREENSHOT_DIR'];

let root: TemporaryUiRoot | undefined;
let site: TimedSite | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求）、Tab だけのフォーカスの移動、スクリーンショット（CCX-16 の共通の補助）。 */
const { records, openPage, tabTo, screenshot, expectCleanPages, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する。 */
const recordDescendants = async (): Promise<readonly ProcessIdentity[]> => {
  const found = descendantsOf(started().child.pid ?? 0, await listProcesses());
  descendants.push(...found);
  return found;
};

const startServerOnRoot = async (): Promise<void> => {
  if (root === undefined || browser === undefined) {
    throw new Error('準備ができていない');
  }
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  expect(page.url()).toBe(`${server.origin}/`);
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
};

/** Server Function で、公開の監査のプロファイルを作る（画面の登録は、最初の場面で確かめる）。 */
const createProfile = async (profileId: string): Promise<void> => {
  const ids = readServerFunctionIds(`${root?.root ?? ''}/apps/local-ui/dist/server/server.js`);
  const created = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, 'createProfileFn', 'POST', {
    profile: publicProfileDocument(profileId, targetConfigPathOf(profileId)),
  });
  expect(created.value).toMatchObject({ ok: true });
};

/** 一覧の行の「監査を始める」から、開始の画面を開く（キーボードだけ）。 */
const openStartFromList = async (profileId: string): Promise<Page> => {
  const page = await openPage('/');
  const row = page.locator(`tr[data-profile-id="${profileId}"]`);
  await tabTo(page, row.getByRole('link', { name: text.profileList.startAudit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/start/${profileId}$`, 'u'), { timeout: UI_TIMEOUT_MS });
  await page.getByTestId('start-target').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** 開始の画面で、始め方を選んで開始し、ジョブの画面に移る（キーボードだけ）。ジョブの ID を返す。 */
const startFromStartPage = async (page: Page, startNew: boolean): Promise<string> => {
  const radio = page.getByRole('radio', { name: startNew ? text.start.startNew : text.start.resume });
  await tabTo(page, page.getByRole('radio', { name: text.start.resume }));
  if (startNew) {
    await page.keyboard.press('ArrowDown');
  }
  expect(await radio.isChecked()).toBe(true);
  await tabTo(page, page.getByRole('button', { name: text.start.submit }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
};

const jobState = (page: Page, state: keyof typeof AUDIT_JOB_STATE_CATALOG): Locator =>
  page.locator(`[data-testid="job-state"][data-state="${state}"]`);

/** 進み具合で、監査を終えたページが 1 つ以上になるまで待つ（画面のポーリングで、読み込み直さずに変わる）。 */
const waitForFirstPage = async (page: Page): Promise<void> => {
  await page.getByTestId('job-pages-finished').waitFor({ timeout: AUDIT_TIMEOUT_MS });
  await expect.poll(async () => page.getByTestId('job-pages-finished').textContent(), { timeout: AUDIT_TIMEOUT_MS }).not.toBe(formatCount(0));
};

/** 読み込みの間隔（ページの読み込みの開始で数える。ブラウザ自身のアイコンの要求は除く）。 */
const navigationArrivals = (requests: readonly SiteRequest[], fromMs: number, untilMs: number): readonly SiteRequest[] =>
  requests.filter((request) => request.atMs >= fromMs && request.atMs <= untilMs && request.pathname !== BROWSER_DEFAULT_FAVICON_PATH);

const expectPacedArrivals = (arrivals: readonly SiteRequest[], intervalMs: number): void => {
  expect(arrivals.length).toBeGreaterThan(1);
  for (let index = 1; index < arrivals.length; index += 1) {
    const gap = (arrivals[index]?.atMs ?? 0) - (arrivals[index - 1]?.atMs ?? 0);
    expect(gap, `interval before request ${index} (${arrivals[index]?.pathname ?? ''})`).toBeGreaterThanOrEqual(intervalMs - ARRIVAL_JITTER_TOLERANCE_MS);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startTimedSite();
  writeAuditTargetConfig(root.root, FULL_PROFILE, site.origin, { minNavigationIntervalMs: FULL_INTERVAL_MS, screenshots: true });
  writeAuditTargetConfig(root.root, STOP_PROFILE, site.origin, { minNavigationIntervalMs: SLOW_INTERVAL_MS, screenshots: false });
  writeAuditTargetConfig(root.root, RESUME_PROFILE, site.origin, { minNavigationIntervalMs: SLOW_INTERVAL_MS, screenshots: false });
  writeAuditTargetConfig(root.root, LIMIT_PROFILE, site.origin, { minNavigationIntervalMs: FULL_INTERVAL_MS, screenshots: false, maxPages: 1 });
  writeAuditTargetConfig(root.root, SECRET_QUERY_PROFILE, site.origin, {
    minNavigationIntervalMs: FULL_INTERVAL_MS, screenshots: false, allowedQueryParameters: ['page', 'token'],
  });
  browser = await launchHeadlessChromium();
  await startServerOnRoot();
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  // fixture のサイトに届いた要求は、GET と HEAD だけ（upgrade と CONNECT もない）。
  const methods = [...new Set(site?.requests().map((request) => request.method))];
  expect(methods.filter((method) => !READ_METHODS.has(method))).toEqual([]);
  await site?.close();
  root?.remove();
});

describe('local UI: audit from the screen', () => {
  it('registers a profile, starts the audit, follows the progress to the end, opens the report and downloads JSON and ZIP', async () => {
    // プロファイルの登録（画面）。
    const form = await openPage('/profiles/new');
    await form.getByLabel(LOCAL_UI_TEXT.profileForm.profileId).fill(FULL_PROFILE);
    // T43b: 作成の画面の既定は「開始の URL から新しく作る」。この流れは、すでにある設定のファイルを選ぶ。
    await chooseExistingTargetConfig(form, targetConfigPathOf(FULL_PROFILE), UI_TIMEOUT_MS);
    await form.getByText(LOCAL_UI_TEXT.profileForm.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
    await form.getByRole('button', { name: LOCAL_UI_TEXT.profileForm.save }).click();
    await form.getByText(LOCAL_UI_TEXT.profileForm.created).waitFor({ timeout: UI_TIMEOUT_MS });

    // 一覧の「監査を始める」→ 開始の画面（設定の要点は読むだけ）。
    const start = await openStartFromList(FULL_PROFILE);
    expect(await start.getByTestId('start-interval').textContent()).toBe(formatDuration(FULL_INTERVAL_MS));
    expect(await start.getByTestId('start-target').locator('input, select, textarea').count()).toBe(0);
    await screenshot(start, '01-start');
    const auditStartedAt = Date.now();
    const jobId = await startFromStartPage(start, true);

    // 進み具合（ポーリング）→ 終わり。
    await waitForFirstPage(start);
    await recordDescendants();
    await screenshot(start, '02-progress');
    await jobState(start, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    const auditFinishedAt = Date.now();
    await start.getByTestId('job-run-status').waitFor();
    expect(await start.getByTestId('job-run-status').getAttribute('data-run-status')).toMatch(/^(?:COMPLETE|PARTIAL)$/u);
    await start.getByTestId('job-artifacts').waitFor();
    await screenshot(start, '03-finished');

    // レポートを開く（新しいタブ。キーボード）。
    const [report] = await Promise.all([
      context?.waitForEvent('page') ?? Promise.reject(new Error('no context')),
      (async () => {
        await tabTo(start, start.getByRole('link', { name: text.job.openReport }));
        await start.keyboard.press('Enter');
      })(),
    ]);
    const reportRecord = { consoleErrors: [] as string[], external: [] as string[] };
    report.on('console', (message) => {
      if (message.type() === 'error') {
        reportRecord.consoleErrors.push(message.text());
      }
    });
    report.on('request', (request) => {
      if (!request.url().startsWith(`${started().origin}/`)) {
        reportRecord.external.push(request.url());
      }
    });
    await report.waitForLoadState('networkidle');
    expect(report.url()).toBe(`${started().origin}/artifacts/${jobId}/report.html`);
    expect(await report.locator('h1').count()).toBeGreaterThan(0);
    await screenshot(report, '04-report');
    expect(reportRecord.consoleErrors).toEqual([]);
    expect(reportRecord.external).toEqual([]);
    await report.close();

    // JSON と ZIP を落とす。
    const downloads: Download[] = [];
    for (const label of [text.job.downloadRunJson, text.job.downloadAuditJson, text.job.downloadBundle]) {
      const [download] = await Promise.all([start.waitForEvent('download'), start.getByRole('link', { name: label }).click()]);
      downloads.push(download);
    }
    const names = downloads.map((download) => download.suggestedFilename());
    expect(names.every((name) => ASCII_FILE_NAME.test(name)), names.join(', ')).toBe(true);
    expect(names[0]).toMatch(/run\.json$/u);
    expect(names[1]).toMatch(/audit\.json$/u);
    // PRE42-BN: 画面のジョブのバンドルの名前は、プロファイルの名前（profileId）を含む。
    expect(names[2]).toMatch(new RegExp(`^beaksight-audit-bundle_${FULL_PROFILE}_\\d{14}\\.zip$`, 'u'));
    const runJson = JSON.parse(readFileSync(await downloads[0]?.path() ?? '', 'utf8')) as { runId: string };
    expect(await start.getByTestId('job-run-id').textContent()).toBe(runJson.runId);

    // 監査の間、fixture のサイトに届いた読み込みの間隔は、設定の間隔以上（画面のポーリングの間も）。
    expectPacedArrivals(navigationArrivals(site?.requests() ?? [], auditStartedAt, auditFinishedAt), FULL_INTERVAL_MS);
  }, SCENARIO_TIMEOUT_MS);

  it('stops the audit through the confirmation dialog (PARTIAL), and shows the same state after reopening the page', async () => {
    await createProfile(STOP_PROFILE);
    const start = await openStartFromList(STOP_PROFILE);
    const auditStartedAt = Date.now();
    const jobId = await startFromStartPage(start, false);
    await waitForFirstPage(start);
    await recordDescendants();

    // T44d（Task 44 の設計書 P2-3）: 大きい止めるボタンも、ジョブの種類（監査）の呼び名。
    const stop = start.getByRole('button', { name: text.job.stop(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT), exact: true });
    await tabTo(start, stop);
    await start.keyboard.press('Enter');
    // DEF-146: 題と確定のボタンは、ジョブの種類（監査）の呼び名。
    const dialog = start.getByRole('dialog', { name: text.stopDialog.title(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT) });
    await dialog.waitFor();
    // T44d: 本文は監査のもの（今のページを終えてから止まり、前回の続きから再開できる）。
    expect(await dialog.textContent()).toContain(AUDIT_JOB_STOP_DIALOG_BODIES.AUDIT.stop);
    await screenshot(start, '05-stop-dialog');
    await tabTo(start, dialog.getByRole('button', { name: text.stopDialog.confirm(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT), exact: true }));
    await start.keyboard.press('Enter');
    await jobState(start, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    const auditFinishedAt = Date.now();
    expect(await start.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    expect(await start.getByRole('button', { name: text.job.stop(AUDIT_JOB_STOP_TARGET_NAMES.AUDIT), exact: true }).count()).toBe(0);
    expectPacedArrivals(navigationArrivals(site?.requests() ?? [], auditStartedAt, auditFinishedAt), SLOW_INTERVAL_MS);
    await start.close();

    // 画面を閉じて開き直すと、同じ状態。
    const reopened = await openPage(`/jobs/${jobId}`);
    await jobState(reopened, 'FINISHED').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await reopened.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    expect(await reopened.getByTestId('job-run-status').textContent()).toContain(RUN_STATUS_CATALOG.PARTIAL.label);
    // T44e（Task 44 の設計書 P2-7）: 終わり方と Run の理由を、表示のカタログの文で出し、次にできることも出す。
    const runEnd = reopened.getByTestId('job-run-end');
    await runEnd.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await runEnd.getByTestId('job-run-execution-end').getAttribute('data-end-reason')).toBe('STOPPED_BY_SIGNAL');
    expect(await runEnd.textContent()).toContain(RUN_EXECUTION_END_REASON_CATALOG.STOPPED_BY_SIGNAL.label);
    expect(await runEnd.textContent()).toContain(RUN_EXECUTION_END_REASON_CATALOG.STOPPED_BY_SIGNAL.description);
    expect(await runEnd.textContent()).toContain(nextSteps.runExecutionEndReasons.STOPPED_BY_SIGNAL ?? '');
    expect(await runEnd.textContent()).toContain(nextSteps.runStatuses.PARTIAL ?? '');
    const interrupted = runEnd.locator('[data-testid="job-run-reason"][data-reason="RUN_INTERRUPTED"]');
    expect(await interrupted.textContent()).toContain(INCOMPLETE_REASON_DESCRIPTIONS.RUN_INTERRUPTED);
    expect(await interrupted.textContent()).toContain(nextSteps.runReasons.RUN_INTERRUPTED ?? '');
    await screenshot(reopened, '06-stopped');

    // 実行履歴と、一覧の「最後の Run」。
    const jobs = await openPage('/jobs');
    await jobs.locator(`tr[data-job-id="${jobId}"]`).waitFor();
    expect(await jobs.locator('tbody tr').count()).toBe(2);
    await screenshot(jobs, '07-jobs');
    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${STOP_PROFILE}"]`);
    expect(await row.getByTestId('last-run-state').textContent()).toBe(AUDIT_JOB_STATE_CATALOG.FINISHED.label);
    expect(await row.getByTestId('last-run-status').textContent()).toBe(RUN_STATUS_CATALOG.PARTIAL.label);
    await screenshot(list, '08-profiles');
  }, SCENARIO_TIMEOUT_MS);

  it('marks the job interrupted after the server is killed, leaves no process, and resumes the same Run from the screen', async () => {
    await createProfile(RESUME_PROFILE);
    const start = await openStartFromList(RESUME_PROFILE);
    const firstJobId = await startFromStartPage(start, true);
    await waitForFirstPage(start);
    const firstRunId = await start.getByTestId('job-run-id').textContent();
    expect(firstRunId).toMatch(/^RUN-\d+$/u);
    const tree = await recordDescendants();
    expect(tree.length).toBeGreaterThan(0);
    await expectCleanPages();
    await start.close();
    records.splice(0);

    // 画面のサーバだけを強制終了する（子孫は止めない）。ワーカーは IPC が切れて自分で止まり、Chromium も残らない。
    await context?.close();
    process.kill(started().child.pid ?? 0);
    await new Promise<void>((resolveExit) => {
      if (started().child.exitCode !== null || started().child.signalCode !== null) {
        resolveExit();
        return;
      }
      started().child.once('exit', () => resolveExit());
    });
    expect(await waitUntilExited(tree, PROCESS_EXIT_LIMIT_MS)).toEqual([]);

    // 起動し直すと、そのジョブは「中断」（画面のサーバの再起動）。コンソールにも知らせる。
    await startServerOnRoot();
    expect(started().output()).toContain(LOCAL_UI_JOB_CONSOLE_TEXT.recoveredJobs(formatCount(1)));
    const interrupted = await openPage(`/jobs/${firstJobId}`);
    await jobState(interrupted, 'INTERRUPTED').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await interrupted.getByTestId('job-failure').getAttribute('data-reason')).toBe('SERVER_RESTARTED');
    expect(await interrupted.getByTestId('job-failure').textContent()).toBe(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.SERVER_RESTARTED.description);
    await screenshot(interrupted, '09-interrupted');

    // 「前回の続きから再開する」で、同じ Run の続きから再開する。
    const resume = await openStartFromList(RESUME_PROFILE);
    const secondJobId = await startFromStartPage(resume, false);
    expect(secondJobId).not.toBe(firstJobId);
    await resume.getByTestId('job-run-id').filter({ hasText: /^RUN-/u }).waitFor({ timeout: AUDIT_TIMEOUT_MS });
    expect(await resume.getByTestId('job-run-id').textContent()).toBe(firstRunId);
    await recordDescendants();
    await jobState(resume, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    await screenshot(resume, '10-resumed');
    const runJson = JSON.parse(readFileSync(`${root?.root ?? ''}/${outputDirectoryOf(RESUME_PROFILE)}/${firstRunId ?? ''}/run.json`, 'utf8')) as {
      runId: string;
      executions: readonly unknown[];
    };
    expect(runJson.runId).toBe(firstRunId);
    expect(runJson.executions.length).toBeGreaterThanOrEqual(2);
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-7。測りの記録の 3.3 の A4）: ページの上限で止まった Run（PARTIAL）の理由と次にできること（「監査の負荷」でページの上限を上げる）。
  it('shows the reason and the next step when the audit stops at the page limit (MAX_PAGES_REACHED)', async () => {
    await createProfile(LIMIT_PROFILE);
    const start = await openStartFromList(LIMIT_PROFILE);
    await startFromStartPage(start, true);
    await recordDescendants();
    await jobState(start, 'FINISHED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    expect(await start.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('PARTIAL');
    const runEnd = start.getByTestId('job-run-end');
    await runEnd.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await runEnd.getByTestId('job-run-execution-end').getAttribute('data-end-reason')).toBe('COMPLETED');
    const limit = runEnd.locator('[data-testid="job-run-reason"][data-reason="MAX_PAGES_REACHED"]');
    expect(await limit.textContent()).toContain(INCOMPLETE_REASON_DESCRIPTIONS.MAX_PAGES_REACHED);
    expect(await limit.textContent()).toContain(nextSteps.runReasons.MAX_PAGES_REACHED ?? '');
    // 監査しなかったページの数と、ページごとの理由の置き場所（HTML レポート）。
    expect(await runEnd.getByTestId('job-run-page-reasons').count()).toBe(1);
    await screenshot(start, '11-max-pages');
  }, SCENARIO_TIMEOUT_MS);

  // T44g（Task 44 の P4-1 の発見事項 4）: 公開の監査も、設定のファイルの `crawl.allowedQueryParameters` に秘密に見える名前があれば始めない。ジョブの画面に、
  // 設定の誤り（`CONFIG_ERROR`）の理由と、秘密に見える名前を入れられないことの案内が出る。サイトへは何も送らない。
  it('shows CONFIG_ERROR with the guidance when the public audit keeps a secret-like name in crawl.allowedQueryParameters', async () => {
    const requestsBefore = site?.requests().length ?? 0;
    await createProfile(SECRET_QUERY_PROFILE);
    const start = await openStartFromList(SECRET_QUERY_PROFILE);
    await startFromStartPage(start, true);
    await recordDescendants();
    await jobState(start, 'FAILED').waitFor({ timeout: AUDIT_TIMEOUT_MS });
    const failure = start.getByTestId('job-failure');
    expect(await failure.getAttribute('data-reason')).toBe('CONFIG_ERROR');
    expect(await failure.textContent()).toBe(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR.description);
    expect(await start.getByText(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR.action).count()).toBe(1);
    expect(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR.action).toContain(AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION);
    expect(site?.requests().length ?? 0).toBe(requestsBefore);
    await screenshot(start, '12-secret-query-parameters');
  }, SCENARIO_TIMEOUT_MS);
});
