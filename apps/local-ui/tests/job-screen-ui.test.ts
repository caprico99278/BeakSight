/**
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、4 章の 2、7 章、13 章の 3・10・11・13）: 作業の画面を、ビルドした画面の
 * サーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - 画面の形: どの状態（動いている、ログイン待ち、止めている、成功、送信を通した、失敗、中断、安全の違反、ログインの切れ）でも、本文の主のボタンは 1 つまでで、
 *   アクセシビリティの検査（axe。wcag2a・wcag2aa・wcag22aa）の違反は 0。要点は結果の 1 行と次の 1 つ。ID・日時・終了コードは、たたんだ詳しい内容の中だけ。
 * - 待つ間（13 章の 11）: 「読んだページ 3 / 20。長くても あと 約 3 分」と「この画面は自動で新しくなります。閉じても点検は続きます。」。技術の文を出さない。
 * - 結果への導線（13 章の 13）: 終わった点検の主のボタンは「結果を見る」（HTML の報告）。詳しい内容の「できたファイル」に、報告を重ねて出さない。
 *   PL-R: 報告の小さなまとめ（`report-summary.json`）を読めた、最後まで終わった点検の結果の 1 行は「問題が 2 件見つかりました」。
 * - 自動で次へ（3 章の 5）: 動いている間に見ていた点検が成功で終わったら、サイトの詳細へ移る（印 `arrived=auto` と、どの作業から移ったか `fromJob`。h1 に
 *   フォーカス）。送信を通した点検も移る（OP-U）。失敗・安全の違反・ログインの切れ・途中で終わった点検は移らない。終わった作業を開いただけでは移らない。
 * - 済んだ操作を出さない（4 章の 2）: 自動の登録が済んだ作業に、行の「登録する」「認証の設定の画面で直す」「案を認証の設定に入れる」を出さない。行の登録が要る
 *   ときは、要点に理由を出し、詳しい内容を開いて表を出す。読み上げの区画は要点の 1 つだけ（13 章の 10）。
 * - 作業の一覧（3 章）: 行は「何の作業か・いつ・結果」の 3 つ。
 * ジョブの行と成果物は、テストだけの操作で管理データと一時の root に書く（ワーカーは起動しない。サイトへは接続しない）。値は匿名（ループバック）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createStartingJob,
  recordAuthState,
  recordEnded,
  recordFinished,
  recordLoginStageAutoRegistration,
  recordProgress,
  recordRunStarted,
  recordStopping,
  type AuditJobLoginStageSummary,
} from '../../../src/control/job/job-store.js';
import type { ControlDatabase } from '../../../src/control/store/control-database.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { RunAuditSendSummary, RunId, RunStatus, RunSummary } from '../../../src/core/contracts.js';
import { REPORT_SUMMARY_ARTIFACT_FILE_NAME } from '../../../src/core/artifact-layout.js';
import { createRunId } from '../../../src/core/ids.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { formatCount } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  AUDIT_SEND_TEXT,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { REPORT_SUMMARY_SCHEMA_VERSION } from '../../../src/report/report-summary.js';
import { runSummary } from '../../../tests/helpers/audit-run-fixture.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { AUDIT_JOB_POLL_INTERVAL_MS } from '../src/display/job-polling';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { createTemporaryUiRoot, findFreePort, startLauncher, stopServer, type StartedServer, type TemporaryUiRoot } from './helpers/local-server.ts';
import { createProfileInStore } from './helpers/profile-store-setup.ts';
import { axeViolationsOf, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const PROFILE_ID = 'pl2-jobs';
/** ターゲット設定のページの上限と、ページの読み込みの間隔（見積もりの元。設計書 13 章の 11 の例と同じ 20 ページ・10 秒）。 */
const MAX_PAGES = 20;
const NAVIGATION_INTERVAL_MS = 10_000;
/** 移らないことを確かめる前に待つ時間（読み直しの間隔の 2 回分）。 */
const STAY_WAIT_MS = AUDIT_JOB_POLL_INTERVAL_MS * 2;
const DETAILS = 'job-details';

const summaryText = LOCAL_UI_JOB_SUMMARY_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let runSequence = 0;
/** このファイルで書いた作業（同時に動ける作業は 1 つなので、各テストの後に、動いたままの作業を中断に直す）。 */
const writtenJobs: string[] = [];

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
  requireCspRecord: true,
  screenshotDirectory: process.env['PL2_SCREENSHOT_DIR'],
});

/** テストだけの操作: 管理データを開いて閉じる。 */
const withDatabase = <T>(use: (database: ControlDatabase) => T): T => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    return use(database);
  } finally {
    closeControlDatabase(database);
  }
};

const now = (): string => formatCompactUtcTimestamp(new Date(), 'test job time');

/** 動いている点検の作業の行を書き、その点検の回の ID を返す（ワーカーの代わり）。 */
const startAuditJob = (jobId: string): RunId => {
  runSequence += 1;
  writtenJobs.push(jobId);
  const runId = createRunId(20261026000000 + runSequence);
  withDatabase((database) => {
    const at = now();
    expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: at }, () => null))
      .toEqual({ ok: true });
    expect(recordRunStarted(database, jobId, { runId, runDirectory: runId, startedAt: at })).toBe(true);
  });
  return runId;
};

/** 点検の回の成果物（`run.json` と、あれば `report.html`）を書く。`auditSend` を渡すと、ページの送信の扱いを入れる。 */
const writeRunFiles = (runId: RunId, options: {
  readonly report: boolean;
  readonly auditSend?: RunAuditSendSummary;
  /** PL-R: 報告の小さなまとめ（`report-summary.json`）。渡したときだけ書く。 */
  readonly reportSummary?: Readonly<Record<string, unknown>>;
}): void => {
  const base = runSummary({ runId });
  const run: RunSummary = { ...base, safety: { ...base.safety, ...(options.auditSend === undefined ? {} : { auditSend: options.auditSend }) } };
  const runDirectory = join(rootOf().root, outputDirectoryOf(PROFILE_ID), runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, 'run.json'), JSON.stringify(run), 'utf8');
  if (options.report) {
    writeFileSync(join(runDirectory, 'report.html'), '<!doctype html><html lang="ja"><head><title>r</title><style>body{}</style></head><body></body></html>', 'utf8');
  }
  if (options.reportSummary !== undefined) {
    writeFileSync(join(runDirectory, REPORT_SUMMARY_ARTIFACT_FILE_NAME), JSON.stringify(options.reportSummary), 'utf8');
  }
};

/** PL-R: 報告の小さなまとめ（Run の ID は書くときに入れる）。 */
const reportSummaryOf = (problemCount: number) => ({
  schemaVersion: REPORT_SUMMARY_SCHEMA_VERSION,
  runStatus: 'COMPLETE',
  problemCount,
  findingCounts: { ERROR: problemCount, WARN: 0, INFO: 0, SAFETY: 0 },
  notFullyCheckedPageCount: 0,
});

/** 点検の作業を、結果（点検の回の状態）で終える。 */
const finishAuditJob = (jobId: string, runId: RunId, runStatus: RunStatus): void => {
  withDatabase((database) => {
    expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId, runDirectory: runId, runStatus }, now())).toBe(true);
  });
};

/** ページの送信のうち、削除のほかを通した記録（送信を通した点検）。 */
const PASSED_SENDS: RunAuditSendSummary = Object.freeze({
  policy: 'PASS_EXCEPT_DELETE',
  passedRequests: 2,
  passedRequestsByMethod: { POST: 2 },
  passedOtherOriginRequests: 0,
  passedWebSockets: 0,
  passedWebSocketsOutsideGuard: 0,
  passedDangerousWebSockets: 0,
} satisfies RunAuditSendSummary);

/** 進み具合の知らせ（3 / 20 ページ）。 */
const PROGRESS = Object.freeze({
  pagesFinished: 3,
  pagesDiscovered: 5,
  maxPages: MAX_PAGES,
  elapsedMs: 30_000,
  navigationCount: 3,
  pacingWaitMs: 0,
  requests: { allowedOrigins: { count: 3, peakPerMinute: 3 }, otherOrigins: { count: 0, peakPerMinute: 0 }, servedFromCache: 0, withheldOtherOrigins: 0 },
  recentPerMinute: { allowedOrigins: 3, otherOrigins: 0 },
});

/** ログインの段のまとめ（登録できる token の送信の行が 1 つと、成功の鍵の観察）。 */
const LOGIN_STAGE: AuditJobLoginStageSummary = {
  scriptLogin: null,
  blockedRequests: {
    requests: [{
      origin: 'https://service.example.invalid', path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
    }],
    unlisted: 0,
  },
  observation: { storageKeys: { origin: 'http://127.0.0.1:9', shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } },
};

/** ログインの段のまとめを持って終わった点検の作業（自動の登録の結果つき）。 */
const writeLoginStageJob = (jobId: string, registration: Parameters<typeof recordLoginStageAutoRegistration>[2]): void => {
  const runId = startAuditJob(jobId);
  withDatabase((database) => {
    expect(recordAuthState(database, jobId, 'AUTHENTICATED', null, LOGIN_STAGE)).toBe(true);
  });
  finishAuditJob(jobId, runId, 'COMPLETE');
  withDatabase((database) => {
    expect(recordLoginStageAutoRegistration(database, jobId, registration)).toBe(true);
  });
};

/** 要点の結果の 1 行の種類を待つ。 */
const waitForResult = async (page: Page, result: string): Promise<void> => {
  await page.locator(`[data-testid="job-result"][data-result="${result}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
};

/** 画面の形（主のボタン 1 つまで、axe の違反 0）。 */
const expectScreenShape = async (page: Page, name: string): Promise<void> => {
  await expectAtMostOnePrimaryButton(page);
  expect(await axeViolationsOf(page), name).toEqual([]);
};

/** 作業の画面のまま、移らない（読み直しの 2 回分を待ってから確かめる）。 */
const expectStays = async (page: Page, jobId: string): Promise<void> => {
  await page.waitForTimeout(STAY_WAIT_MS);
  expect(new URL(page.url()).pathname).toBe(`/jobs/${jobId}`);
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  const targetConfigPath = writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', {
    minNavigationIntervalMs: NAVIGATION_INTERVAL_MS,
    maxPages: MAX_PAGES,
    screenshots: false,
  });
  expect(await createProfileInStore(root.root, publicProfileDocument(PROFILE_ID, targetConfigPath))).toMatchObject({ ok: true });
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  withDatabase((database) => {
    for (const jobId of writtenJobs.splice(0)) {
      // 終わった作業の行は書き換えない（`recordEnded` は動いている行だけを書く）。
      recordEnded(database, jobId, { state: 'INTERRUPTED', reason: 'WORKER_EXITED', exitCode: null, at: now() });
    }
  });
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('PL-2: the job screen while the job runs (13 章の 10・11)', () => {
  it('shows the result line, the estimate and the note of the automatic refresh, with no primary button and the stop as a secondary', async () => {
    startAuditJob('job-pl2-running');
    withDatabase((database) => expect(recordProgress(database, 'job-pl2-running', PROGRESS)).toBe(true));
    const page = await openPage('/jobs/job-pl2-running');
    await waitForResult(page, 'RUNNING');
    const summary = page.getByTestId('job-summary-panel');
    expect(await summary.getByTestId('job-result').textContent()).toBe(summaryText.active.RUNNING('点検'));
    // 13 章の 11: 残り 17 ページ × 10 秒 = 170 秒 → 長くても あと 約 3 分。
    expect(await summary.getByTestId('job-progress-estimate').textContent()).toBe(summaryText.progressEstimate('3', '20', '3'));
    expect(await summary.getByTestId('job-auto-refresh').textContent()).toBe(summaryText.autoRefresh('点検'));
    // 技術の文（読み直しの間隔。前の「この画面は、2秒ごとに自動で新しくなります」。PL-TD で文言を消した）を出さない。
    expect(await page.getByRole('main').textContent()).not.toMatch(/\d+秒ごと/u);
    expect(await primaryButtonLabelsInMain(page)).toEqual([]);
    expect(await summary.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.job.stop('点検') }).count()).toBe(1);
    // ID・日時・終了コードは、たたんだ詳しい内容の中だけ。
    expect(await page.getByTestId('job-run-id').isVisible()).toBe(false);
    expect(await page.getByTestId(DETAILS).evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    // 13 章の 10: 読み上げの区画は要点の 1 つだけ。
    expect(await page.locator('main [aria-live]').count()).toBe(1);
    await expectScreenShape(page, 'running');
    await screenshot(page, 'pl2-01-running');
  }, SCENARIO_TIMEOUT_MS);

  it('waits for the manual login in one panel: the result line, the primary "login finished" and the secondary stop', async () => {
    startAuditJob('job-pl2-awaiting');
    withDatabase((database) => expect(recordAuthState(database, 'job-pl2-awaiting', 'AWAITING_LOGIN', null)).toBe(true));
    const page = await openPage('/jobs/job-pl2-awaiting');
    await waitForResult(page, 'AWAITING_LOGIN');
    const summary = page.getByTestId('job-summary-panel');
    expect(await summary.getByTestId('job-result').textContent()).toBe(summaryText.active.AWAITING_LOGIN);
    // まだ 1 ページも読んでいない: 20 ページ × 10 秒 = 200 秒 → 長くても あと 約 4 分。
    expect(await summary.getByTestId('job-progress-estimate').textContent()).toBe(summaryText.progressEstimate('0', '20', '4'));
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_MANUAL_LOGIN_TEXT.confirm]);
    expect(await summary.getByTestId('job-manual-login-confirm').isVisible()).toBe(true);
    expect(await summary.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.job.stop('点検') }).isVisible()).toBe(true);
    // 「見るだけにして操作しない」の注意は、ログインを待つ間は出さない（「ログインしてください」と食い違う）。
    expect(await page.getByTestId('job-browser-watch-only').count()).toBe(0);
    await expectScreenShape(page, 'awaiting login');
    await screenshot(page, 'pl2-02-awaiting-login');
  }, SCENARIO_TIMEOUT_MS);

  it('shows the stop requested text as the result line while stopping', async () => {
    startAuditJob('job-pl2-stopping');
    withDatabase((database) => expect(recordStopping(database, 'job-pl2-stopping', now())).toBe(true));
    const page = await openPage('/jobs/job-pl2-stopping');
    await waitForResult(page, 'STOPPING');
    expect(await page.getByTestId('job-stop-requested').textContent()).toBe(AUDIT_JOB_STOP_REQUESTED_TEXTS.AUDIT);
    expect(await primaryButtonLabelsInMain(page)).toEqual([]);
    await expectScreenShape(page, 'stopping');
  }, SCENARIO_TIMEOUT_MS);
});

describe('PL-2: the job screen after the job ended (7 章、13 章の 13)', () => {
  it('opens the result as the one primary button of a finished audit, and does not repeat the report in the details', async () => {
    const runId = startAuditJob('job-pl2-complete');
    writeRunFiles(runId, { report: true });
    finishAuditJob('job-pl2-complete', runId, 'COMPLETE');
    const page = await openPage('/jobs/job-pl2-complete');
    await waitForResult(page, 'AUDIT_COMPLETE');
    expect(await page.getByTestId('job-result').textContent()).toBe(summaryText.finished.AUDIT_COMPLETE);
    expect(await primaryButtonLabelsInMain(page)).toEqual([summaryText.openResult]);
    const open = page.getByTestId('job-open-report');
    expect(await open.getAttribute('href')).toBe(`/artifacts/job-pl2-complete/report.html`);
    expect(await open.getAttribute('target')).toBe('_blank');
    // 詳しい内容の「できたファイル」には、run.json はあり、報告（HTML）は重ねて出さない。
    await openAdvancedSettings(page, DETAILS, UI_TIMEOUT_MS);
    expect(await page.getByTestId('job-artifacts').locator('[data-artifact="RUN_JSON"]').count()).toBe(1);
    expect(await page.locator('[data-artifact="REPORT"]').count()).toBe(1);
    // 終わった作業を開いただけでは、移らない。
    await expectStays(page, 'job-pl2-complete');
    await expectScreenShape(page, 'complete');
    await screenshot(page, 'pl2-03-complete');
  }, SCENARIO_TIMEOUT_MS);

  // PL-R（設計書 14 章、13 章の 13。PL-2 の持ち越し）: 点検が最後まで終わり、報告を作る時に書いた小さなまとめ（`report-summary.json`）を読めたときは、結果の
  // 1 行に問題の数を出す。まとめが読めない（形が違う）ときは、今の文のまま。
  it('says the number of problems of a finished audit from the small summary of the report, and keeps the sentence without a readable one', async () => {
    const cases = [
      { jobId: 'job-plr-two', summary: reportSummaryOf(2), expected: summaryText.auditCompleteWithProblems('2') },
      { jobId: 'job-plr-none', summary: reportSummaryOf(0), expected: summaryText.auditCompleteWithoutProblems },
      { jobId: 'job-plr-broken', summary: { ...reportSummaryOf(2), problemCount: -1 }, expected: summaryText.finished.AUDIT_COMPLETE },
    ] as const;
    for (const { jobId, summary, expected } of cases) {
      const runId = startAuditJob(jobId);
      writeRunFiles(runId, { report: true, reportSummary: { ...summary, runId } });
      finishAuditJob(jobId, runId, 'COMPLETE');
      const page = await openPage(`/jobs/${jobId}`);
      await waitForResult(page, 'AUDIT_COMPLETE');
      expect(await page.getByTestId('job-result').textContent(), jobId).toBe(expected);
      expect(await primaryButtonLabelsInMain(page), jobId).toEqual([summaryText.openResult]);
      await expectScreenShape(page, jobId);
    }
  }, SCENARIO_TIMEOUT_MS);

  // OP-U（設計者の判断の 2）: 作業の画面には、通したことの知らせを出さない（通した数は成果物と報告に残す）。
  it('does not show the notice of the passed sends on the job screen', async () => {
    const runId = startAuditJob('job-pl2-passed');
    writeRunFiles(runId, { report: true, auditSend: PASSED_SENDS });
    finishAuditJob('job-pl2-passed', runId, 'COMPLETE');
    const page = await openPage('/jobs/job-pl2-passed');
    await waitForResult(page, 'AUDIT_COMPLETE');
    expect(await page.getByTestId('job-audit-send-notice').count()).toBe(0);
    expect(await page.content()).not.toContain(AUDIT_SEND_TEXT.passedNotice(formatCount(2)));
    expect(await primaryButtonLabelsInMain(page)).toEqual([summaryText.openResult]);
    await expectScreenShape(page, 'passed sends');
  }, SCENARIO_TIMEOUT_MS);

  it.each([
    { jobId: 'job-pl2-failed', result: 'FAILED', end: { state: 'FAILED', reason: 'WORKER_START_FAILED' } },
    { jobId: 'job-pl2-interrupted', result: 'INTERRUPTED', end: { state: 'INTERRUPTED', reason: 'WORKER_EXITED' } },
  ] as const)('shows the reason of $result in the summary, with no primary button', async ({ jobId, result, end }) => {
    startAuditJob(jobId);
    withDatabase((database) => expect(recordEnded(database, jobId, { ...end, exitCode: null, at: now() })).toBe(true));
    const page = await openPage(`/jobs/${jobId}`);
    await waitForResult(page, result);
    expect(await page.getByTestId('job-summary-panel').getByTestId('job-failure').getAttribute('data-reason')).toBe(end.reason);
    expect(await primaryButtonLabelsInMain(page)).toEqual([]);
    await expectScreenShape(page, result);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the safety stop and the session loss in the summary', async () => {
    const safetyRun = startAuditJob('job-pl2-safety');
    finishAuditJob('job-pl2-safety', safetyRun, 'ABORTED_BY_SAFETY');
    const safety = await openPage('/jobs/job-pl2-safety');
    await waitForResult(safety, 'SAFETY_VIOLATION');
    expect(await safety.getByTestId('job-result').textContent()).toBe(summaryText.finished.SAFETY_VIOLATION);
    await expectScreenShape(safety, 'safety');

    const lostRun = startAuditJob('job-pl2-session');
    withDatabase((database) => expect(recordAuthState(database, 'job-pl2-session', 'SESSION_LOST', 'http://127.0.0.1:9/admin/logout')).toBe(true));
    finishAuditJob('job-pl2-session', lostRun, 'PARTIAL');
    const lost = await openPage('/jobs/job-pl2-session');
    await waitForResult(lost, 'SESSION_LOST');
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 要点にはアドレスの後ろを出さない。切れたページのアドレスは詳しい内容に残す。
    expect(await lost.getByTestId('job-session-lost-page').textContent()).toBe(summaryText.sessionLostPage);
    expect(await lost.getByTestId('job-summary-panel').textContent()).not.toContain('/admin/logout');
    expect(await lost.getByTestId('job-session-lost-url').textContent()).toBe('http://127.0.0.1:9/admin/logout');
    // 次にすること（ログインの設定を開く）は二次のボタン。
    expect(await lost.getByTestId('job-open-auth-setup').isVisible()).toBe(true);
    await expectScreenShape(lost, 'session lost');
  }, SCENARIO_TIMEOUT_MS);
});

describe('PL-2: the automatic move after a success (3 章の 5)', () => {
  it('moves a watched audit to the site when it finished with success, with the arrival mark and the focus on the h1', async () => {
    const runId = startAuditJob('job-pl2-move');
    const page = await openPage('/jobs/job-pl2-move');
    await waitForResult(page, 'RUNNING');
    finishAuditJob('job-pl2-move', runId, 'COMPLETE');
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\\?`, 'u'), { timeout: UI_TIMEOUT_MS });
    const search = new URL(page.url()).searchParams;
    expect(search.get('arrived')).toBe('auto');
    expect(search.get('fromJob')).toBe('job-pl2-move');
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? null), { timeout: UI_TIMEOUT_MS }).toBe('H1');
  }, SCENARIO_TIMEOUT_MS);

  // PL-U（設計書 14.1 の U1）: 一部のページを見られなかった点検も、完了と同じくサイトの画面へ移し、要点の 1 行目にそのことを書く。
  it('moves a watched partial audit to the site too, and says in the first line that some pages were not seen', async () => {
    const runId = startAuditJob('job-plu-partial-move');
    const page = await openPage('/jobs/job-plu-partial-move');
    await waitForResult(page, 'RUNNING');
    finishAuditJob('job-plu-partial-move', runId, 'PARTIAL');
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\\?`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get('fromJob')).toBe('job-plu-partial-move');
    const arrival = page.getByTestId('profile-arrival');
    await arrival.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await arrival.getAttribute('data-result')).toBe('AUDIT_PARTIAL');
    expect(await arrival.textContent()).toBe('点検が終わりました。一部のページは見られませんでした。');
    expect(await arrival.textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.finished.AUDIT_PARTIAL);
  }, SCENARIO_TIMEOUT_MS);

  // OP-U（設計者の判断の 1）: 既定の送信の扱い（削除のほかを通す）で通した点検も、読み取りだけと同じくサイトの画面へ移す（前は移さなかった）。
  it('moves a watched audit that passed the sends of the page to the site too', async () => {
    const runId = startAuditJob('job-opu-passed-move');
    const page = await openPage('/jobs/job-opu-passed-move');
    await waitForResult(page, 'RUNNING');
    writeRunFiles(runId, { report: true, auditSend: PASSED_SENDS });
    finishAuditJob('job-opu-passed-move', runId, 'COMPLETE');
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\\?`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get('fromJob')).toBe('job-opu-passed-move');
  }, SCENARIO_TIMEOUT_MS);

  it.each([
    { name: 'a failure', jobId: 'job-pl2-stay-failed', result: 'FAILED' },
    { name: 'a safety stop', jobId: 'job-pl2-stay-safety', result: 'SAFETY_VIOLATION' },
    { name: 'a session loss', jobId: 'job-pl2-stay-session', result: 'SESSION_LOST' },
  ] as const)('does not move after $name', async ({ jobId, result }) => {
    const runId = startAuditJob(jobId);
    const page = await openPage(`/jobs/${jobId}`);
    await waitForResult(page, 'RUNNING');
    switch (result) {
      case 'FAILED':
        withDatabase((database) => expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: now() })).toBe(true));
        break;
      case 'SAFETY_VIOLATION':
        finishAuditJob(jobId, runId, 'ABORTED_BY_SAFETY');
        break;
      case 'SESSION_LOST':
        withDatabase((database) => expect(recordAuthState(database, jobId, 'SESSION_LOST', 'http://127.0.0.1:9/admin/logout')).toBe(true));
        finishAuditJob(jobId, runId, 'PARTIAL');
        break;
    }
    await waitForResult(page, result);
    await expectStays(page, jobId);
  }, SCENARIO_TIMEOUT_MS);
});

describe('PL-2: the finished operations are not shown (4 章の 2)', () => {
  it('does not show the row registration, the draft link and the observation apply after the automatic registration', async () => {
    writeLoginStageJob('job-pl2-registered', { result: 'SAVED', profileRevision: 2, addedServiceOrigins: [] });
    const page = await openPage('/jobs/job-pl2-registered');
    await waitForResult(page, 'AUDIT_COMPLETE');
    expect(await page.getByTestId('job-login-remembered').textContent()).toBe(LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.saved);
    await openAdvancedSettings(page, DETAILS, UI_TIMEOUT_MS);
    await page.getByTestId('job-login-stage-blocked').waitFor({ timeout: UI_TIMEOUT_MS });
    for (const testId of ['job-login-stage-register', 'job-login-stage-edit-draft', 'job-login-observation-apply', 'job-login-setup-review']) {
      expect(await page.getByTestId(testId).count(), testId).toBe(0);
    }
    expect(await page.locator('main [aria-live]').count()).toBe(1);
    await expectScreenShape(page, 'registered');
  }, SCENARIO_TIMEOUT_MS);

  it('shows the reason in the summary and opens the details with the rows when a row must be registered', async () => {
    writeLoginStageJob('job-pl2-register-needed', { result: 'SKIPPED', reason: 'MULTIPLE_TOKEN_TARGETS' });
    const page = await openPage('/jobs/job-pl2-register-needed');
    await waitForResult(page, 'AUDIT_COMPLETE');
    const needed = page.getByTestId('job-summary-panel').getByTestId('job-login-registration-needed');
    expect(await needed.textContent()).toContain(summaryText.registrationNeeded(LOCAL_UI_TEXT.advancedSettings.summary));
    expect(await needed.textContent()).toContain(LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.skipReasons.MULTIPLE_TOKEN_TARGETS.next);
    await expect.poll(() => page.getByTestId(DETAILS).evaluate((element) => (element as HTMLDetailsElement).open), { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(await page.getByTestId('job-login-stage-register').isVisible()).toBe(true);
    await expectScreenShape(page, 'register needed');
  }, SCENARIO_TIMEOUT_MS);
});

describe('PL-2: the list of the jobs (3 章)', () => {
  it('has the three columns: what, when and the result', async () => {
    const page = await openPage('/jobs');
    const table = page.getByTestId('job-list');
    await table.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await table.locator('thead th').allTextContents())
      .toEqual([summaryText.listColumns.what, summaryText.listColumns.when, summaryText.listColumns.result]);
    const row = table.locator('tr[data-job-id="job-pl2-complete"]');
    expect(await row.locator('th, td').count()).toBe(3);
    // 点検の回の ID は出さない。
    expect(await table.textContent()).not.toContain('RUN-');
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);
});
