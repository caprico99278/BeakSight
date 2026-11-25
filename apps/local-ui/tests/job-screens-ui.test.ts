/**
 * SLIM-GROUP の UI-4（束 S4 job-screens-ui）: 作業の画面と、作業の行から開く画面を、1 つの画面のサーバ（一時の root）と headless の Chromium で確かめる
 * （ワーカーは起動しない。ジョブの行と成果物は、テストだけの操作で書く。サイトへは接続しない）。元のファイルごとに describe で包み、本文はできるだけそのまま写した。
 * 元のファイル（apps/local-ui/tests/）:
 * - 丸ごと（削った場面を除く）: job-screen-ui、job-audit-stage-ui、job-page-incomplete-reasons-ui、login-observation-ui、login-stage-register-ui、
 *   read-check-page-ui、script-login-ui、write-precheck-detail-ui、job-stop-ui（job-stop-ui は画面のサーバを落とす場面があるので、束の最後に置く）。
 * - 一部だけ: credential-destination-observed-only（画面の 2 場面: 送信先を読むだけで出す 7 と PL-S）。
 * 削った場面と、同じことを確かめている別の所:
 * - job-screen-ui: 同じ画面の種類（作業の画面）の 2 回目以降の axe（axe は、作業の画面は動いている状態で 1 回、作業の一覧で 1 回。主のボタンの数の確かめは
 *   各状態に残す）。要点の文と次の段の確かめのうち、表示の関数の単体（`apps/local-ui/tests/job-summary.test.ts`）に同じものがある次の場面:
 *   問題が 0 件の結果の 1 行（'gives the number of problems of a complete audit whose small summary was read'）、送信を通した点検も移る（'moves a finished audit
 *   and the stages of a finished chain to the same place whatever the send policy'）、安全の違反とログインの切れで移らない（'moves a complete audit and a
 *   partial audit to the site, and nothing else of the audits'）。移らないことの画面の配線は、失敗の 1 場面に残す。
 * - job-audit-stage-ui: 押す数の上限の欄を出さない場面（COV-1。撤廃した上限の名残）。
 * - read-check-page-ui: 前の上限より多く期待を足せる場面（L4。撤廃した上限の名残）。別の所: `tests/integration/control-read-check-store.test.ts` の
 *   'does not limit the definitions of one profile (more than the former limit)'、`tests/unit/read-check-contracts.test.ts`（前の上限を超える期待を受ける）。
 * - login-stage-register-ui の MI-G: 保存の拒否を Server Function で写した場面（自動ログインのジョブの行からの拒否、Origin を足す保存の拒否と手動での保存、
 *   承認済みの Origin へのログインに伴う送信の拒否、プロファイルの更新と作成の拒否）。別の所: `tests/unit/login-stage-row-registration.test.ts`（MI-G・MI-F1）、
 *   `tests/unit/credential-destination.test.ts`（`SERVICE_ORIGIN_ADD_NOT_OBSERVED`・`AUTOMATED_LOGIN_SWITCH_REQUIRED`）、
 *   `tests/integration/credential-destination-lock.test.ts`（`CREDENTIAL_DESTINATION_LOCKED`）、`tests/integration/control-login-registration.test.ts`。
 *   画面の場面（理由を出す、下書きのリンクを出さない）は残す。
 * - credential-destination-observed-only: 3a〜3c・3d（並行）・M-1・最初の保存の Server Function の場面。別の所:
 *   `tests/integration/credential-destination-observed-only.test.ts`（速い組）。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page, Route } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { GENERATED_TARGET_CRAWL_LIMITS } from '../../../src/config/target-config-draft.js';
import { recordDiscoveryCandidates } from '../../../src/control/job/discovery-index-store.js';
import {
  createStartingJob,
  recordAuthState,
  recordEnded,
  recordFinished,
  recordLoginStageAutoRegistration,
  recordNotice,
  recordProgress,
  recordRunStarted,
  recordStopping,
  type AuditJobLoginStageSummary,
  type NewAuditJob,
} from '../../../src/control/job/job-store.js';
import { recordReadCheckResults } from '../../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile } from '../../../src/control/store/profile-store.js';
import { WORKER_LOGIN_CREDENTIAL_BLOCK_REASON, WORKER_SCRIPT_LOGIN_BLOCK_REASONS, type WorkerRunNotice } from '../../../src/control/worker-protocol.js';
import { REPORT_SUMMARY_ARTIFACT_FILE_NAME } from '../../../src/core/artifact-layout.js';
import { WORKER_AUDIT_JOB_KIND, WORKER_LOGIN_CHECK_JOB_KIND } from '../../../src/core/audit-job-values.js';
import type {
  PageIncompleteReasonCount,
  RunAuditSendSummary,
  RunAuthenticationSummary,
  RunId,
  RunStatus,
  RunSummary,
} from '../../../src/core/contracts.js';
import { createRunId } from '../../../src/core/ids.js';
import { REDACTED_PATH_SEGMENT } from '../../../src/core/url-path-redaction.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { DISCOVERY_LOGOUT_WORDS } from '../../../src/discovery/classification-words.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/discovery-result.js';
import { newStorageKeyShapesOf } from '../../../src/discovery/login-observation.js';
import { READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/read-check-evaluation.js';
import {
  DISCOVERY_END_REASON_CATALOG,
  HTTP_METHOD_LABELS,
  LOGIN_TRANSPORT_CATALOG,
  READ_CHECK_END_REASON_CATALOG,
  REQUEST_RESOURCE_TYPE_LABELS,
} from '../../../src/presentation/catalog.js';
import { formatCount, formatDuration, formatTimes } from '../../../src/presentation/format.js';
import {
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  AUDIT_SEND_TEXT,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  INCOMPLETE_REASON_DESCRIPTIONS,
  INCOMPLETE_REASON_NEXT_STEPS,
  JOB_SAFETY_VIOLATION_STAGE_LABELS,
  LOCAL_UI_AUDIT_STAGE_TEXT,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SAFETY_VIOLATION_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_SPA_AUDIT_TEXT,
  LOCAL_UI_TEXT,
  LOGIN_STAGE_BLOCK_REASON_LABELS,
  PRECHECK_FAILURE_DETAIL_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  READ_CHECK_DETAIL_DESCRIPTIONS,
  READ_CHECK_TARGET_KIND_LABELS,
  describeIncompleteReasonOf,
  nextStepOfIncompleteReasonOf,
  serviceRequestPacingWaitText,
  siteUnavailableRecheckText,
} from '../../../src/presentation/messages.js';
import { REPORT_SUMMARY_SCHEMA_VERSION } from '../../../src/report/report-summary.js';
import { blockedDocuments } from '../../../tests/helpers/action-report-samples.js';
import { runSummary } from '../../../tests/helpers/audit-run-fixture.js';
import { databaseFilePlaces, placesWithMarkers } from '../../../tests/helpers/leak-places.js';
import { AUDIT_JOB_POLL_INTERVAL_MS } from '../src/display/job-polling';
import { openAdvancedSettings } from './helpers/advanced-settings.ts';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { REMOVED_ADD_BUTTON_LABELS, openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { stopServer } from './helpers/local-server.ts';
import { openProfileAdvancedSettings } from './helpers/profile-form.ts';
import { createProfileInStore, saveAuthSetupInStore, saveAuthSetupRequestInStore, updateProfileInStore } from './helpers/profile-store-setup.ts';
import { axeViolationsOf, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { encodeServerFunctionPayload, isServerFunctionUrlOf } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { createUiServerKit, sharedUiServerKitOf } from './helpers/ui-server.ts';

/** 束の 1 つのサーバの準備と後始末の上限（ms）。 */
const BUNDLE_SETUP_TIMEOUT_MS = 120_000;

const serverKit = createUiServerKit();
beforeAll(() => serverKit.setUp(), BUNDLE_SETUP_TIMEOUT_MS);
afterAll(() => serverKit.tearDown());

/**
 * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、4 章の 2、7 章、13 章の 3・10・11・13）: 作業の画面を、ビルドした画面の
 * サーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - 画面の形: どの状態（動いている、ログイン待ち、止めている、成功、送信を通した、失敗、中断、安全の違反、ログインの切れ）でも、本文の主のボタンは 1 つまで。
 *   アクセシビリティの検査（axe。wcag2a・wcag2aa・wcag22aa）の違反 0 は、作業の画面と作業の一覧で 1 回ずつ（束で、状態ごとの axe を外した）。要点は結果の
 *   1 行と次の 1 つ。ID・日時・終了コードは、たたんだ詳しい内容の中だけ。
 * - 待つ間（13 章の 11）: 「読んだページ 3 / 20。長くても あと 約 3 分」と「この画面は自動で新しくなります。閉じても点検は続きます。」。技術の文を出さない。
 * - 結果への導線（13 章の 13）: 終わった点検の主のボタンは「結果を見る」（HTML の報告）。詳しい内容の「できたファイル」に、報告を重ねて出さない。
 *   PL-R: 報告の小さなまとめ（`report-summary.json`）を読めた、最後まで終わった点検の結果の 1 行は「問題が 2 件見つかりました」。
 * - 自動で次へ（3 章の 5）: 動いている間に見ていた点検が成功で終わったら、サイトの詳細へ移る（印 `arrived=auto` と、どの作業から移ったか `fromJob`。h1 に
 *   フォーカス）。失敗の点検は移らない。終わった作業を開いただけでは移らない。
 * - 済んだ操作を出さない（4 章の 2）: 自動の登録が済んだ作業に、行の「登録する」「認証の設定の画面で直す」「案を認証の設定に入れる」を出さない。行の登録が要る
 *   ときは、要点に理由を出し、詳しい内容を開いて表を出す。読み上げの区画は要点の 1 つだけ（13 章の 10）。
 * - 作業の一覧（3 章）: 行は「何の作業か・いつ・結果」の 3 つ。
 * 値は匿名（ループバック）。
 */
describe('job-screen-ui: PL-2 the job screen', () => {
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

  let runSequence = 0;
  /** このファイルで書いた作業（同時に動ける作業は 1 つなので、各テストの後に、動いたままの作業を中断に直す）。 */
  const writtenJobs: string[] = [];

  const { started, rootOf, contextOf, setUp } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
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
  const startAuditJob = (jobId: string, jobKind: 'AUDIT' | 'DISCOVERY' = 'AUDIT'): RunId => {
    runSequence += 1;
    writtenJobs.push(jobId);
    const runId = createRunId(20261026000000 + runSequence);
    withDatabase((database) => {
      const at = now();
      expect(createStartingJob(database, { jobId, jobKind, profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: at }, () => null))
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

  /** ページの送信を止めずに通した記録（送信を通した点検）。 */
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

  /** 画面の形（主のボタン 1 つまで、axe の違反 0）。束: axe は作業の画面の種類ごとに 1 回（動いている状態）。ほかの状態は主のボタンの数だけを確かめる。 */
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
    const targetConfigPath = await setUp((root) => writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', {
      minNavigationIntervalMs: NAVIGATION_INTERVAL_MS,
      maxPages: MAX_PAGES,
      screenshots: false,
    }));
    expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILE_ID, targetConfigPath))).toMatchObject({ ok: true });
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

  describe('PL-2: the job screen while the job runs (13 章の 10・11)', () => {
    it('shows the result line and the note of the automatic refresh, with no primary button and the stop as a secondary', async () => {
      startAuditJob('job-pl2-running');
      withDatabase((database) => expect(recordProgress(database, 'job-pl2-running', PROGRESS)).toBe(true));
      const page = await openPage('/jobs/job-pl2-running');
      await waitForResult(page, 'RUNNING');
      const summary = page.getByTestId('job-summary-panel');
      expect(await summary.getByTestId('job-result').textContent()).toBe(summaryText.active.RUNNING('点検'));
      // DPROG (b): 見積もりの基準（ワーカーの実行から最初に受けた進み）はジョブの管理のメモリにあり、行だけを書いた作業にはないので、見積もりを出さない
      // （求め方は `job-summary.test.ts`）。
      expect(await summary.getByTestId('job-progress-estimate').count()).toBe(0);
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
      // 束: 作業の画面の axe は、この 1 回（同じ部品で描くほかの状態は、主のボタンの数だけ）。
      await expectScreenShape(page, 'running');
      await screenshot(page, 'pl2-01-running');
    }, SCENARIO_TIMEOUT_MS);

    it('DEF-195・DPROG: shows the progress of the discovery job in the words of the stage, without the numbers of the audit', async () => {
      startAuditJob('job-def195-discovery', 'DISCOVERY');
      withDatabase((database) => expect(recordProgress(database, 'job-def195-discovery', PROGRESS)).toBe(true));
      const page = await openPage('/jobs/job-def195-discovery');
      await waitForResult(page, 'RUNNING');
      const progress = page.getByTestId('job-stage-progress');
      // 進み具合の欄は、たたんだ詳しい内容の中（閉じた details の中は読み上げの木から外れるので、隠れた見出しも数える）。
      expect(await progress.getByRole('heading', { includeHidden: true }).textContent()).toBe(LOCAL_UI_AUDIT_TEXT.job.stageProgressHeading('操作さがし'));
      expect(await progress.getByTestId('job-screens-finished').textContent()).toBe(formatCount(3));
      // DSEED2: 連鎖でない操作さがしは、見つけた画面を分けない（今のまま）。
      expect(await progress.getByTestId('job-screens-discovered').textContent()).toBe(formatCount(5));
      expect(await page.getByTestId('job-pages-finished').count()).toBe(0);

      // DSEED2: 連鎖の操作さがし（ワーカーが分け方を送る）は、点検から引き継いだ画面と新しく見つけた画面に分けて出す。同じプロファイルで動く作業は 1 つだけ
      // なので、前の作業の行を終えてから書く（後片付けの `afterEach` と同じ終わり方）。
      withDatabase((database) => {
        recordEnded(database, 'job-def195-discovery', { state: 'INTERRUPTED', reason: 'WORKER_EXITED', exitCode: null, at: now() });
      });
      startAuditJob('job-dseed2-discovery', 'DISCOVERY');
      const split = { fromAuditStage: 4, newlyFound: 1 };
      withDatabase((database) => expect(recordProgress(database, 'job-dseed2-discovery', { ...PROGRESS, pagesDiscoveredSplit: split })).toBe(true));
      const chained = await openPage('/jobs/job-dseed2-discovery');
      await waitForResult(chained, 'RUNNING');
      expect(await chained.getByTestId('job-stage-progress').getByTestId('job-screens-discovered').textContent())
        .toBe(LOCAL_UI_AUDIT_TEXT.job.screensDiscoveredSplit(formatCount(5), formatCount(4), formatCount(1)));
    }, SCENARIO_TIMEOUT_MS);

    it('waits for the manual login in one panel: the result line, the primary "login finished" and the secondary stop', async () => {
      startAuditJob('job-pl2-awaiting');
      withDatabase((database) => expect(recordAuthState(database, 'job-pl2-awaiting', 'AWAITING_LOGIN', null)).toBe(true));
      const page = await openPage('/jobs/job-pl2-awaiting');
      await waitForResult(page, 'AWAITING_LOGIN');
      const summary = page.getByTestId('job-summary-panel');
      expect(await summary.getByTestId('job-result').textContent()).toBe(summaryText.active.AWAITING_LOGIN);
      // まだ 1 ページも読んでいない: 見つけたページの数も 1 ページの時間も分からないので、見積もりを出さない（DEF-192）。
      expect(await summary.getByTestId('job-progress-estimate').count()).toBe(0);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_MANUAL_LOGIN_TEXT.confirm]);
      expect(await summary.getByTestId('job-manual-login-confirm').isVisible()).toBe(true);
      expect(await summary.getByRole('button', { name: LOCAL_UI_AUDIT_TEXT.job.stop('点検') }).isVisible()).toBe(true);
      // 「見るだけにして操作しない」の注意は、ログインを待つ間は出さない（「ログインしてください」と食い違う）。
      expect(await page.getByTestId('job-browser-watch-only').count()).toBe(0);
      await expectAtMostOnePrimaryButton(page);
      await screenshot(page, 'pl2-02-awaiting-login');
    }, SCENARIO_TIMEOUT_MS);

    it('shows the stop requested text as the result line while stopping', async () => {
      startAuditJob('job-pl2-stopping');
      withDatabase((database) => expect(recordStopping(database, 'job-pl2-stopping', now())).toBe(true));
      const page = await openPage('/jobs/job-pl2-stopping');
      await waitForResult(page, 'STOPPING');
      expect(await page.getByTestId('job-stop-requested').textContent()).toBe(AUDIT_JOB_STOP_REQUESTED_TEXTS.AUDIT);
      expect(await primaryButtonLabelsInMain(page)).toEqual([]);
      await expectAtMostOnePrimaryButton(page);
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
      await expectAtMostOnePrimaryButton(page);
      await screenshot(page, 'pl2-03-complete');
    }, SCENARIO_TIMEOUT_MS);

    // PL-R（設計書 14 章、13 章の 13。PL-2 の持ち越し）: 点検が最後まで終わり、報告を作る時に書いた小さなまとめ（`report-summary.json`）を読めたときは、結果の
    // 1 行に問題の数を出す。まとめが読めない（形が違う）ときは、今の文のまま。束: 問題が 0 件の場面は、表示の関数の単体（`job-summary.test.ts` の PL-R）に任せた。
    it('says the number of problems of a finished audit from the small summary of the report, and keeps the sentence without a readable one', async () => {
      const cases = [
        { jobId: 'job-plr-two', summary: reportSummaryOf(2), expected: summaryText.auditCompleteWithProblems('2') },
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
        await expectAtMostOnePrimaryButton(page);
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
      await expectAtMostOnePrimaryButton(page);
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
      await expectAtMostOnePrimaryButton(page);
    }, SCENARIO_TIMEOUT_MS);

    it('shows the safety stop and the session loss in the summary', async () => {
      const safetyRun = startAuditJob('job-pl2-safety');
      finishAuditJob('job-pl2-safety', safetyRun, 'ABORTED_BY_SAFETY');
      const safety = await openPage('/jobs/job-pl2-safety');
      await waitForResult(safety, 'SAFETY_VIOLATION');
      expect(await safety.getByTestId('job-result').textContent()).toBe(summaryText.finished.SAFETY_VIOLATION);
      await expectAtMostOnePrimaryButton(safety);

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
      await expectAtMostOnePrimaryButton(lost);
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

    // 束: 移らないことの画面の配線は、失敗の 1 場面で確かめる（安全の違反・ログインの切れで移らない判定は `job-summary.test.ts`）。
    it('does not move after a failure', async () => {
      const jobId = 'job-pl2-stay-failed';
      startAuditJob(jobId);
      const page = await openPage(`/jobs/${jobId}`);
      await waitForResult(page, 'RUNNING');
      withDatabase((database) => expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'WORKER_START_FAILED', exitCode: null, at: now() })).toBe(true));
      await waitForResult(page, 'FAILED');
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
      await expectAtMostOnePrimaryButton(page);
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
      await expectAtMostOnePrimaryButton(page);
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
});

/**
 * T37a（Task 37 の設計書 3.1）: ジョブの詳細の画面に、発見と READ の確かめのジョブの監査の段の数（成果物 `discovery.json`・`read-evidence.json` の任意の
 * 項目 `authentication`。`run.json` と同じ形）を、ログインの段の要約と並べて出す。
 * - 管理データには保存しない（版を上げない）。画面のサーバは、成果物を、スキーマとジョブの ID を確かめる読み出し（`readJobResultDocument`）で読む。
 *   終わった（`FINISHED`）ジョブだけ出す。
 * - 数がない（監査の段の口のない）ジョブには、欄を出さない。
 * - DEF-141: 1 分あたりの上限で待った回数と時間の合計を欄に足し、待つ間の知らせを進みの欄に出す。
 * 束: 押す数の上限の欄を出さない場面（COV-1。撤廃した上限の名残）は消した。
 */
describe('job-audit-stage-ui: T37a and DEF-144 on the job detail', () => {
  /** 画面の操作を待つ上限（ms）。 */
  const UI_TIMEOUT_MS = 15_000;
  /** 1 つの場面の上限（ms）。 */
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const PROFILE_ID = 't37a-job';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const ADMIN_PATH = '/admin';
  const CREATED_AT = '20261017010000';
  const STARTED_AT = '20261017010001';
  const FINISHED_AT = '20261017010100';
  /** 書いた出力先（`writeAuthTargetConfig` の決まり）。 */
  const OUTPUT_DIRECTORY = `t25e-output-${PROFILE_ID}`;
  const SCREENSHOT_DIRECTORY = process.env['T37A_SCREENSHOT_DIR'];

  const SUMMARY: RunAuthenticationSummary = Object.freeze({
    registeredReadRequestsAllowed: 4,
    tokenRefreshBlocked: 1,
    otherNonReadBlocked: 2,
    serviceUnauthorizedResponses: 3,
    serviceRequestLimitReached: true,
  });

  const { started, rootOf, contextOf, valueOf } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
  });

  /** 終わった発見か READ の確かめのジョブの行と、その成果物を書く（テストだけの操作。ワーカーの代わり）。 */
  const writeFinishedJob = (
    jobId: string,
    jobKind: 'DISCOVERY' | 'READ_CHECK',
    runId: string,
    authentication: RunAuthenticationSummary | null,
    /** DEF-144: 成果物に足す（上書きする）項目（終わり方と違反の中身）。 */
    extra: Readonly<Record<string, unknown>> = {},
  ): void => {
    const base = {
      jobId, runId, startedAt: STARTED_AT, finishedAt: FINISHED_AT, runStatus: 'PARTIAL',
      ...(authentication === null ? {} : { authentication }),
    };
    const [fileName, document] = jobKind === 'DISCOVERY'
      ? ['discovery.json', {
        schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION, ...base, endReason: 'SERVICE_REQUEST_LIMIT_REACHED', maxPages: MAX_PAGES,
        pages: [{ url: `${TEST_ORIGIN}${ADMIN_PATH}`, state: 'NOT_READ', reason: 'SERVICE_REQUEST_LIMIT_REACHED' }], omittedUnreadPages: 0, ...extra,
      }]
      // RCA-5: read-evidence 1.3 は検索の確かめの組 `searchChecks` を必ず持つ（ないと画面のサーバがスキーマで読まない）。
      : ['read-evidence.json', {
        schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, ...base, endReason: 'SERVICE_REQUEST_LIMIT_REACHED', checks: [], searchChecks: [], ...extra,
      }];
    const runDirectory = join(rootOf().root, OUTPUT_DIRECTORY, runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, fileName), JSON.stringify(document), 'utf8');
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId, jobKind, profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 1, runId: runId as never, runDirectory: runId, runStatus: 'PARTIAL' }, FINISHED_AT))
        .toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  beforeAll(async () => {
    const target = writeAuthTargetConfig(rootOf().root, PROFILE_ID, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    expect(await valueOf('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: PROFILE_ID,
        revision: 1,
        targetConfigPath: target,
        environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'MANUAL_SESSION',
        approvedTestOrigins: [TEST_ORIGIN],
        environmentEvidenceRef: `${PROFILE_ID}-evidence`,
      },
    })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  describe('T37a: the counts of the audit stage on the job detail of the discovery and READ check jobs', () => {
    const text = LOCAL_UI_AUDIT_STAGE_TEXT;

    for (const [jobKind, jobId, runId] of [
      ['DISCOVERY', 'job-t37a-discovery', 'RUN-20261017010001'],
      ['READ_CHECK', 'job-t37a-read-check', 'RUN-20261017010002'],
    ] as const) {
      it(`shows the counts of the ${jobKind} job from its artifact`, async () => {
        writeFinishedJob(jobId, jobKind, runId, SUMMARY);
        const page = await openPage(`/jobs/${jobId}`);
        // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 数と記録は、たたんだ詳しい内容の中。開いてから確かめる。
        await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
        const panel = page.getByTestId('job-audit-stage');
        await panel.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
        const facts = await panel.getByTestId('job-audit-stage-counts').evaluate((list) =>
          [...list.querySelectorAll('dt')].map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
        expect(facts).toEqual([
          [text.registeredReadRequestsAllowed, formatTimes(SUMMARY.registeredReadRequestsAllowed)],
          [text.tokenRefreshBlocked, formatTimes(SUMMARY.tokenRefreshBlocked)],
          [text.otherNonReadBlocked, formatTimes(SUMMARY.otherNonReadBlocked)],
          [text.serviceUnauthorizedResponses, formatTimes(SUMMARY.serviceUnauthorizedResponses)],
          [text.serviceRequestLimitReached, text.limitReached],
        ]);
        expect(await panel.getByTestId('job-audit-stage-limit').textContent()).toBe(text.limitReachedNote);
        await screenshot(page, `t37a-${jobKind.toLowerCase()}-audit-stage`);
      }, SCENARIO_TIMEOUT_MS);
    }

    // DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2）: 1 分あたりの上限で次の読み込みの前に待った回数と時間の合計を、数の欄に
    // 足す（前の版の成果物にはないので、ないときは行を出さない。上の場面）。
    it('shows the times and the total of the waits by the per minute limit', async () => {
      const summary: RunAuthenticationSummary = { ...SUMMARY, serviceRequestLimitReached: false, serviceRequestPacingWaits: 3, serviceRequestPacingWaitMs: 125_000 };
      writeFinishedJob('job-def141-waits', 'DISCOVERY', 'RUN-20261017010004', summary);
      const page = await openPage('/jobs/job-def141-waits');
      // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 数と記録は、たたんだ詳しい内容の中。開いてから確かめる。
      await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
      const panel = page.getByTestId('job-audit-stage');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      const facts = await panel.getByTestId('job-audit-stage-counts').evaluate((list) =>
        [...list.querySelectorAll('dt')].map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
      expect(facts.slice(-2)).toEqual([
        [text.serviceRequestPacingWaits, formatTimes(3)],
        [text.serviceRequestPacingWaitMs, formatDuration(125_000)],
      ]);
      expect(await panel.getByTestId('job-audit-stage-limit').count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);

    // DEF-141: 待つ間の知らせ（`SERVICE_REQUEST_PACING_WAIT`）を、ジョブの画面の進みの欄に、CLI と同じ文言で出す。
    it('shows the notice of the wait by the per minute limit while the job runs', async () => {
      const jobId = 'job-def141-notice';
      const notice = { kind: 'SERVICE_REQUEST_PACING_WAIT', waitMs: 42_000, waitCount: 2, totalWaitMs: 90_000 } as const;
      const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
      try {
        expect(createStartingJob(database, { jobId, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT },
          () => null)).toEqual({ ok: true });
        expect(recordRunStarted(database, jobId, { runId: 'RUN-20261017010005' as never, runDirectory: 'RUN-20261017010005', startedAt: STARTED_AT })).toBe(true);
        expect(recordNotice(database, jobId, notice)).toBe(true);
      } finally {
        closeControlDatabase(database);
      }
      try {
        const page = await openPage(`/jobs/${jobId}`);
        const shown = page.getByTestId('job-notice');
        await shown.waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await shown.textContent())
          .toBe(serviceRequestPacingWaitText(formatDuration(notice.waitMs), notice.waitCount, formatDuration(notice.totalWaitMs)));
      } finally {
        // 動いているジョブを終えておく（同じプロファイルで、次の場面のジョブを作れるように）。
        const closing = openControlDatabase(resolveControlDatabasePath(rootOf().root));
        try {
          recordFinished(closing, jobId, { kind: 'RAN', exitCode: 0, runId: 'RUN-20261017010005' as never, runDirectory: 'RUN-20261017010005', runStatus: 'COMPLETE' },
            FINISHED_AT);
        } finally {
          closeControlDatabase(closing);
        }
      }
    }, SCENARIO_TIMEOUT_MS);

    it('does not show the counts of a job without them', async () => {
      writeFinishedJob('job-t37a-no-stage', 'DISCOVERY', 'RUN-20261017010003', null);
      const page = await openPage('/jobs/job-t37a-no-stage');
      // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 数と記録は、たたんだ詳しい内容の中。開いてから確かめる。
      await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
      await page.getByTestId('job-summary').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('job-audit-stage').count()).toBe(0);
      // DEF-144: 違反の中身のないジョブには、違反の欄を出さない。
      expect(await page.getByTestId('job-safety-violation').count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);
  });

  // DEF-144（指示書 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/DEF-144-brief.md`）: 発見と READ の確かめのジョブが安全の違反で止まったときの、
  // 違反の中身（成果物の `safetyViolation`）を、ジョブの画面に出す（種類・内容・結びつく要求の method と Origin と path・起きた段・画面の path・押していた候補）。
  describe('DEF-144: the content of the safety violation on the job detail', () => {
    const text = LOCAL_UI_SAFETY_VIOLATION_TEXT;
    // 候補の識別の digest の形（`schemas/control/candidate.schema.json` の `$defs/digest`。形が違う成果物は、画面のサーバが読まない）。
    const IDENTITY_DIGEST = `sha256:${'a'.repeat(64)}`;
    const VIOLATION = Object.freeze({
      pagePath: '/admin/staff',
      stage: 'SUBMISSION_PROBE',
      press: { submitterWords: ['保存'], identityDigest: IDENTITY_DIGEST },
      invariantViolationCount: 3,
      invariantViolations: [
        {
          code: 'PASSIVE_GUARD_PAGE_NOT_READY',
          message: 'Navigation started before explicit page readiness',
          request: { method: 'GET', origin: TEST_ORIGIN, path: '/admin/staff/1/edit' },
        },
        { code: 'GUARD_TASK_LIMIT_REACHED', message: 'requestfailed callback' },
      ],
      recordTruncated: false,
    });

    for (const [jobKind, jobId, runId] of [
      ['DISCOVERY', 'job-def144-discovery', 'RUN-20261017010006'],
      ['READ_CHECK', 'job-def144-read-check', 'RUN-20261017010007'],
    ] as const) {
      it(`shows the kind, the stage, the place and the pressed candidate of the ${jobKind} job from its artifact`, async () => {
        writeFinishedJob(jobId, jobKind, runId, null, {
          endReason: 'SAFETY_VIOLATION',
          safetyViolation: jobKind === 'DISCOVERY' ? VIOLATION : { ...VIOLATION, stage: 'PAGE_LOAD', press: null },
        });
        const page = await openPage(`/jobs/${jobId}`);
        const panel = page.getByTestId('job-safety-violation');
        await panel.waitFor({ timeout: UI_TIMEOUT_MS });
        // PL-2（設計書 7 章、3 章の 2）: 止めた事実・ステップ・画面・押していたボタンの語は、ふだんの画面に出す。押していたボタンの識別、違反の数と表は、
        // たたんだ詳しい内容の中（`job-safety-violation-details`）。
        await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
        const details = page.getByTestId('job-safety-violation-details');
        expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
        expect(await panel.getByTestId('job-safety-violation-stage').textContent())
          .toBe(JOB_SAFETY_VIOLATION_STAGE_LABELS[jobKind === 'DISCOVERY' ? 'SUBMISSION_PROBE' : 'PAGE_LOAD']);
        expect(await panel.getByTestId('job-safety-violation-page').textContent()).toBe('/admin/staff');
        expect(await details.getByTestId('job-safety-violation-count').textContent()).toBe(formatCount(3));
        if (jobKind === 'DISCOVERY') {
          expect(await panel.getByTestId('job-safety-violation-press-words').textContent()).toBe('保存');
          expect(await details.getByTestId('job-safety-violation-press-identity').textContent()).toBe(IDENTITY_DIGEST);
        } else {
          expect(await panel.getByTestId('job-safety-violation-press-words').count()).toBe(0);
        }
        const rows = await details.getByTestId('job-safety-violation-list').evaluate((table) =>
          [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')));
        expect(rows).toEqual([
          // PL-W（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2・4）: 違反の記号と送り方は、日本語の名前で出す（記号は行の data-code に残る）。
          [text.codeFamilies.GUARD, 'Navigation started before explicit page readiness', HTTP_METHOD_LABELS.GET, TEST_ORIGIN, '/admin/staff/1/edit'],
          [text.codeFamilies.GUARD, 'requestfailed callback', text.noRequest],
        ]);
        // 一覧に載せなかった違反の数（数は全体）。
        expect(await details.getByTestId('job-safety-violation-omitted').textContent()).toBe(text.omittedText(formatCount(1)));
        // MI-F3: 期待は固定の文字でも書く（同じ関数で期待を作ると、「1件 件」の誤りを捕まえないため）。
        expect(await details.getByTestId('job-safety-violation-omitted').textContent()).toBe('一覧に載せなかった違反が 1件あります。');
        await screenshot(page, `def144-${jobKind.toLowerCase()}-safety-violation`);
      }, SCENARIO_TIMEOUT_MS);
    }

    // DEF-144 の後半（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 発見のジョブの、外部のアプリへ移るので押さなかったボタンの数と、
    // 読み込み直した画面の数（成果物の `externalSchemeProbes`）。
    it('shows the buttons not pressed for an external scheme and the reloaded pages of a discovery job', async () => {
      const probeText = LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT;
      writeFinishedJob('job-def144-external-scheme', 'DISCOVERY', 'RUN-20261017010008', null, { externalSchemeProbes: { notPressed: 2, reloadedPages: 1 } });
      const page = await openPage('/jobs/job-def144-external-scheme');
      // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 数と記録は、たたんだ詳しい内容の中。開いてから確かめる。
      await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
      const panel = page.getByTestId('job-external-scheme-probes');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await panel.getByRole('heading', { name: probeText.heading }).count()).toBe(1);
      expect(await panel.getByTestId('job-external-scheme-not-pressed').textContent()).toBe(formatCount(2));
      expect(await panel.getByTestId('job-external-scheme-reloaded').textContent()).toBe(formatCount(1));
      // 違反で止まっていないジョブには、違反の欄を出さない。
      expect(await page.getByTestId('job-safety-violation').count()).toBe(0);
      // T44c: 押す数の上限の数を持たない成果物には、その欄を出さない。
      expect(await page.getByTestId('job-press-limit-probes').count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);
  });
});

/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの詳細の画面に、`run.json` の任意の項目 `pageIncompleteReasonCounts`（ページの未完了の理由ごとの
 * ページ数）を、理由の説明（表示カタログ）と次にできること（レポートと同じ文）と並べて出す。項目のない Run（理由を持つページのない Run と、前の書き手の
 * Run）には欄を出さない。
 */
describe('job-page-incomplete-reasons-ui: T44c the page incomplete reasons of an audit job', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PROFILE_ID = 't44c-reasons';
  const CREATED_AT = '20261021020000';
  const STARTED_AT = '20261021020001';
  const FINISHED_AT = '20261021020100';
  const INNER_SCROLL = 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED';
  // PIR: 点検の範囲の外へ移ったページは別の行。アドレスを持たない項目（前の書き手）には、アドレスの欄を出さない。
  const OUTSIDE = { code: 'NAVIGATION_FAILED', detail: 'BLOCKED_EXTERNAL_REDIRECT' } as const;
  const COUNTS: readonly PageIncompleteReasonCount[] = Object.freeze([
    { code: 'COLLECTOR_INCOMPLETE', pages: 2, pageUrls: ['http://127.0.0.1:9/a.html', 'http://127.0.0.1:9/b.html'] },
    { code: INNER_SCROLL, pages: 9 },
    { ...OUTSIDE, pages: 1, pageUrls: ['http://127.0.0.1:9/away.html'] },
  ]);

  const text = LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT;

  /** サーバの準備と Server Function の呼び出し（`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['T44C_SCREENSHOT_DIR'],
  });

  /** 終わった監査のジョブの行と、その `run.json` を書く（テストだけの操作）。`counts` が `null` なら、項目のない Run。 */
  const writeFinishedAuditJob = (jobId: string, sequence: number, counts: readonly PageIncompleteReasonCount[] | null): void => {
    const runId = createRunId(20261021020000 + sequence);
    const run: RunSummary = { ...runSummary({ runId }), ...(counts === null ? {} : { pageIncompleteReasonCounts: counts }) };
    const runDirectory = join(rootOf().root, outputDirectoryOf(PROFILE_ID), runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify(run), 'utf8');
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, jobId, { runId, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 1, runId, runDirectory: runId, runStatus: 'PARTIAL' }, FINISHED_AT)).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  beforeAll(async () => {
    const targetConfigPath = await setUp((root) =>
      writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false }));
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    writeFinishedAuditJob('job-t44c-reasons', 1, COUNTS);
    writeFinishedAuditJob('job-t44c-no-reasons', 2, null);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

  it('shows the number of the pages for each reason with its description and the next step (the same text as the report)', async () => {
    const page = await openPage('/jobs/job-t44c-reasons');
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 要点には「確かめきれなかった所があります」の 1 行だけを出し、理由ごとのページ数は、
    // たたんだ詳しい内容の中。開いてから確かめる。
    expect(await page.getByTestId('job-summary-panel').getByTestId('job-incomplete').textContent())
      .toBe(LOCAL_UI_JOB_SUMMARY_TEXT.incomplete(LOCAL_UI_TEXT.advancedSettings.summary));
    await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
    const panel = page.getByTestId('job-page-incomplete-reasons');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
    const rows = await panel.getByTestId('job-page-incomplete-reason-list').evaluate((table) =>
      [...table.querySelectorAll('tbody tr')].map((row) => {
        const [reason, pages, nextStep] = [...row.querySelectorAll(':scope > td')];
        return [
          row.getAttribute('data-code') ?? '',
          reason?.textContent ?? '',
          pages?.firstChild?.textContent ?? '',
          [...(pages?.querySelectorAll('li') ?? [])].map((item) => item.textContent ?? ''),
          nextStep?.textContent ?? '',
        ];
      }));
    // PL-W（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2・4）: 理由のコードは画面に出さない（行の data-code にだけ残る）。
    // PIR: 各行に、そのページのアドレスの全部（たたんだ欄の中の文字）。範囲の外へ移ったページは別の文。
    expect(rows).toEqual([
      ['COLLECTOR_INCOMPLETE', INCOMPLETE_REASON_DESCRIPTIONS.COLLECTOR_INCOMPLETE, formatCount(2), COUNTS[0]?.pageUrls, INCOMPLETE_REASON_NEXT_STEPS.COLLECTOR_INCOMPLETE],
      [INNER_SCROLL, INCOMPLETE_REASON_DESCRIPTIONS[INNER_SCROLL], formatCount(9), [], INCOMPLETE_REASON_NEXT_STEPS[INNER_SCROLL]],
      ['NAVIGATION_FAILED', describeIncompleteReasonOf(OUTSIDE), formatCount(1), COUNTS[2]?.pageUrls, nextStepOfIncompleteReasonOf(OUTSIDE)],
    ]);
    expect(await panel.getByTestId('job-page-incomplete-reason-urls').count()).toBe(2);
    // 画面のサーバが返す値は、数・理由のコード・範囲の外の印・ページのアドレス。
    const detail = await valueOf<{ pageIncompleteReasons: unknown }>('getAuditJobFn', 'GET', { jobId: 'job-t44c-reasons' });
    expect(detail.pageIncompleteReasons).toEqual(COUNTS);
  }, SCENARIO_TIMEOUT_MS);

  it('shows nothing for a Run without the item', async () => {
    const page = await openPage('/jobs/job-t44c-no-reasons');
    await page.getByTestId('job-run-status').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-page-incomplete-reasons').count()).toBe(0);
    expect(await page.getByTestId('job-incomplete').count()).toBe(0);
    expect((await valueOf<{ pageIncompleteReasons: unknown }>('getAuditJobFn', 'GET', { jobId: 'job-t44c-no-reasons' })).pageIncompleteReasons).toBeNull();
  }, SCENARIO_TIMEOUT_MS);
});

/**
 * T44e（Task 44 の設計書 P2-4。設計の変更の履歴の T44e の行の (2)）: 書き込みのジョブが送る前の確かめで送らずに止めた（`PRECHECK_FAILED`）とき、
 * `action-run.json` の具体的な理由（`precheckDetail`。台帳が知る保つ鍵の値と違う、など）と次にできることを、ジョブの画面に出す。
 * 理由のない前の記録（項目なし）と、送る中身の照合で止めた記録（`PAYLOAD_MISMATCH`）には、欄を出さない。
 * 束: 理由の文は `write-screen-reasons.test.ts`（書き込みの画面の 1 行）に同じものがない（ジョブの画面の説明と次の段）ので、画面の側に残した。
 */
describe('write-precheck-detail-ui: T44e the concrete reason of a write stopped before sending', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const PROFILE_ID = 't44e-write-detail';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const CREATED_AT = '20261021020000';
  const STARTED_AT = '20261021020001';
  const FINISHED_AT = '20261021020100';
  /** 書いた出力先（`writeAuthTargetConfig` の決まり）。 */
  const OUTPUT_DIRECTORY = `t25e-output-${PROFILE_ID}`;

  const { started, rootOf, contextOf, call } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['T44E_SCREENSHOT_DIR'],
  });

  /** テストだけの操作: 終わった更新の書き込みのジョブの行と、その `action-run.json` を書く（`overrides` は記録の項目）。 */
  const writeFinishedWriteJob = (jobId: string, runId: string, overrides: Readonly<Record<string, unknown>>): void => {
    const runDirectory = join(rootOf().root, OUTPUT_DIRECTORY, runId);
    mkdirSync(runDirectory, { recursive: true });
    const actionRun = { ...blockedDocuments().actionRun, jobId, runId, profileId: PROFILE_ID, ...overrides };
    writeFileSync(join(runDirectory, 'action-run.json'), JSON.stringify(actionRun), 'utf8');
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId, jobKind: 'WRITE_UPDATE', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'PARTIAL' }, FINISHED_AT)).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  beforeAll(async () => {
    const target = writeAuthTargetConfig(rootOf().root, PROFILE_ID, TEST_ORIGIN, '/admin', 1);
    const created = await call('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: PROFILE_ID,
        revision: 1,
        targetConfigPath: target,
        environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'MANUAL_SESSION',
        approvedTestOrigins: [TEST_ORIGIN],
        environmentEvidenceRef: `${PROFILE_ID}-evidence`,
      },
    });
    expect(created.value).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  it('shows the reason and the next step when the kept value differs from the ledger', async () => {
    const jobId = 'job-t44e-write-kept';
    writeFinishedWriteJob(jobId, 'RUN-20261021020001', { blockReason: 'PRECHECK_FAILED', reason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH' });
    const page = await openPage(`/jobs/${jobId}`);
    const detail = page.getByTestId('job-write-precheck-detail');
    await detail.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await detail.getAttribute('data-detail')).toBe('KNOWN_KEPT_VALUE_MISMATCH');
    expect(await detail.textContent()).toContain(PRECHECK_FAILURE_DETAIL_DESCRIPTIONS.KNOWN_KEPT_VALUE_MISMATCH.description);
    expect(await detail.textContent()).toContain(PRECHECK_FAILURE_DETAIL_DESCRIPTIONS.KNOWN_KEPT_VALUE_MISMATCH.action);
    await screenshot(page, 't44e-write-precheck-detail');
  }, SCENARIO_TIMEOUT_MS);

  it('shows no reason for a record without the item and for a stop by the payload check', async () => {
    writeFinishedWriteJob('job-t44e-write-old', 'RUN-20261021020002', { blockReason: 'PRECHECK_FAILED', reason: 'PRECHECK_FAILED' });
    writeFinishedWriteJob('job-t44e-write-payload', 'RUN-20261021020003', {});
    for (const jobId of ['job-t44e-write-old', 'job-t44e-write-payload']) {
      const page = await openPage(`/jobs/${jobId}`);
      await page.locator('[data-testid="job-state"][data-state="FINISHED"]').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('job-write-precheck-detail').count(), jobId).toBe(0);
    }
  }, SCENARIO_TIMEOUT_MS);
});

/**
 * T37d（Task 37 の設計書 3.5）: READ の確かめの画面の、画面の path を読む定義の作成と、結果の表示。
 * - 定義の作成で「候補を読む」と「画面を読む」を選べる。「画面を読む」は、画面の path の欄と、直近の発見の結果の画面（読めた画面）から選ぶ一覧。発見の
 *   結果を読めなければ、一覧を出さずに入力だけ。
 * - 保存の検証の誤り（正規の形でない path、危険な語）は、理由を path の欄と上のお知らせに出し、保存しない。
 * - 結果の表に、対象の種類と画面の path、判定できない詳しい理由（`SERVICE_READ_REFUSED`）を出す。
 * 発見と READ の確かめのジョブの行と成果物は、テストだけの操作で書く（ワーカーの代わり）。テストの値は匿名（テスト環境の Origin はループバック。接続しない）。
 * 束: 「前の上限より多く期待を足せる（L4）」の場面は消した（撤廃した上限の名残。上限がないことは `tests/integration/control-read-check-store.test.ts`・
 * `tests/unit/read-check-contracts.test.ts`）。
 */
describe('read-check-page-ui: T37d the READ check definitions of a page path on the local UI', () => {
  /** 画面の操作を待つ上限（ms）。 */
  const UI_TIMEOUT_MS = 15_000;
  /** 1 つの場面の上限（ms）。 */
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const PROFILE_ID = 't37d-page';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const ADMIN_PATH = '/admin';
  const DETAIL_PATH = '/admin/members/1';
  const CREATED_AT = '20261017020000';
  const STARTED_AT = '20261017020001';
  const FINISHED_AT = '20261017020100';
  const RECORDED_AT = '20261017020200';
  /** 書いた出力先（`writeAuthTargetConfig` の決まり）。 */
  const OUTPUT_DIRECTORY = `t25e-output-${PROFILE_ID}`;
  const SCREENSHOT_DIRECTORY = process.env['T37D_SCREENSHOT_DIR'];
  const text = LOCAL_UI_READ_CHECK_TEXT;
  /** DEF-136: 発見のジョブの、サイトの不調の確かめ直しを待つ知らせ。 */
  const NOTICE = Object.freeze({
    kind: 'SITE_UNAVAILABLE_RECHECK', url: `${TEST_ORIGIN}${DETAIL_PATH}`, delayMs: 60_000, attempt: 1, maxAttempts: 1,
  } as const satisfies WorkerRunNotice);

  const { started, rootOf, contextOf, valueOf } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
  });

  /** 管理データに、テストだけの操作で書く（ワーカーとジョブの管理の代わり）。 */
  const withDatabase = <T>(use: (database: ControlDatabase) => T): T => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      return use(database);
    } finally {
      closeControlDatabase(database);
    }
  };

  /** 終わったジョブの行と、その成果物を書く。 */
  const writeFinishedJob = (
    jobId: string,
    jobKind: 'DISCOVERY' | 'READ_CHECK',
    runId: string,
    fileName: string,
    document: unknown,
    notice: WorkerRunNotice | null = null,
  ): void => {
    const runDirectory = join(rootOf().root, OUTPUT_DIRECTORY, runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, fileName), JSON.stringify(document), 'utf8');
    withDatabase((database) => {
      expect(createStartingJob(database, { jobId, jobKind, profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: STARTED_AT })).toBe(true);
      // DEF-136: 実行中の知らせ（ワーカーの `NOTICE` の代わり）。
      if (notice !== null) {
        expect(recordNotice(database, jobId, notice)).toBe(true);
      }
      expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, FINISHED_AT))
        .toBe(true);
    });
  };

  /** 直近の発見の結果（読めた画面 2 つ。候補なし）を書き、索引に記録する。 */
  const writeDiscovery = (): void => {
    const jobId = 'job-t37d-discovery';
    const runId = 'RUN-20261017020001';
    const pageOf = (path: string): unknown => ({
      url: `${TEST_ORIGIN}${path}`, state: 'READ', record: { location: { origin: TEST_ORIGIN, path }, incompleteReasons: [], candidates: [] }, blockedRequests: 0,
    });
    writeFinishedJob(jobId, 'DISCOVERY', runId, 'discovery.json', {
      schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION, jobId, runId, startedAt: STARTED_AT, finishedAt: FINISHED_AT, runStatus: 'COMPLETE',
      endReason: 'COMPLETED', maxPages: MAX_PAGES, pages: [pageOf(ADMIN_PATH), pageOf(DETAIL_PATH)], omittedUnreadPages: 0,
    });
    withDatabase((database) => {
      recordDiscoveryCandidates(database, { profileId: PROFILE_ID, jobId, at: FINISHED_AT, entries: [], readPagePaths: [ADMIN_PATH, DETAIL_PATH] });
    });
  };

  beforeAll(async () => {
    const target = writeAuthTargetConfig(rootOf().root, PROFILE_ID, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    expect(await valueOf('createProfileFn', 'POST', {
      profile: {
        schemaVersion: 'beaksight-profile/1',
        profileId: PROFILE_ID,
        revision: 1,
        targetConfigPath: target,
        environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'MANUAL_SESSION',
        approvedTestOrigins: [TEST_ORIGIN],
        environmentEvidenceRef: `${PROFILE_ID}-evidence`,
      },
    })).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、閉じた一覧にない知らせの値では、知らせの枠を出さない。一覧の値なら出す。
  it('shows no notice for a search value outside the closed list', async () => {
    const unknown = await openPage(`/read-checks/${PROFILE_ID}?notice=foo`);
    await unknown.locator('h1.page-title').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await unknown.getByTestId('read-check-notice').count()).toBe(0);
    const shown = await openPage(`/read-checks/${PROFILE_ID}?notice=removed`);
    await shown.getByTestId('read-check-notice').waitFor({ timeout: UI_TIMEOUT_MS });
  });

  it('chooses between reading a candidate and reading a page, and offers only the input without a discovery result', async () => {
    const page = await openPage(`/read-checks/${PROFILE_ID}/new`);
    const kinds = page.getByTestId('read-check-target-kind');
    await kinds.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await kinds.locator('label').allTextContents()).toEqual([READ_CHECK_TARGET_KIND_LABELS.CANDIDATE, READ_CHECK_TARGET_KIND_LABELS.PAGE]);
    expect(await page.locator('input[data-target-kind="CANDIDATE"]').isChecked()).toBe(true);
    expect(await page.getByTestId('read-check-candidate-missing').count()).toBe(1);
    await page.locator('input[data-target-kind="PAGE"]').check();
    await page.getByTestId('read-check-page-path').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('read-check-no-page-paths').textContent()).toBe(text.page.noPagePaths);
    expect(await page.getByTestId('read-check-page-path-choice').count()).toBe(0);
    expect(await page.getByTestId('read-check-parameters').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('rejects a page path that is not canonical or has a dangerous word, with the reason at the path field, and saves nothing', async () => {
    const page = await openPage(`/read-checks/${PROFILE_ID}/new?target=PAGE`);
    const path = page.getByTestId('read-check-page-path');
    await path.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator('select[name$="-kind"]').selectOption('ROW_COUNT_AT_LEAST');
    await page.locator('input[name$="-count"]').fill('1');
    for (const [value, reason] of [['/admin/../members', 'READ_PAGE_PATH_INVALID'], ['/admin/logout', 'READ_PAGE_PATH_DANGEROUS_WORD']] as const) {
      await path.fill(value);
      await page.getByTestId('read-check-save').click();
      const rejection = page.getByTestId('read-check-rejection');
      await page.locator(`[data-testid="read-check-rejection"][data-reason="${reason}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await rejection.locator(`[data-code="${reason}"] p`).first().textContent()).toBe(READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[reason].description);
      expect(await page.locator('[data-testid="read-check-page"] .field-error, [data-testid="read-check-page"] [role="alert"]').allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining(READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS[reason].description)]));
    }
    await screenshot(page, 't37d-page-path-rejected');
    expect(await valueOf<{ definitions: readonly unknown[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID }))
      .toMatchObject({ definitions: [] });
  }, SCENARIO_TIMEOUT_MS);

  it('chooses a page path from the latest discovery result, saves the definition, and lists it as reading a page', async () => {
    writeDiscovery();
    const page = await openPage(`/read-checks/${PROFILE_ID}/new?target=PAGE`);
    const choice = page.getByTestId('read-check-page-path-choice');
    await choice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await choice.locator('option').allTextContents()).toEqual([text.page.chooseNone, ADMIN_PATH, DETAIL_PATH]);
    await choice.selectOption(DETAIL_PATH);
    expect(await page.getByTestId('read-check-page-path').inputValue()).toBe(DETAIL_PATH);
    await page.locator('select[name$="-kind"]').selectOption('DETAIL_FIELD_EQUALS');
    await page.locator('input[name$="-field"]').fill('名前');
    await page.locator('input[name$="-value"]').fill('一覧花子');
    await screenshot(page, 't37d-page-path-form');
    await page.getByTestId('read-check-save').click();
    await page.getByTestId('read-check-notice').waitFor({ timeout: UI_TIMEOUT_MS });
    const row = page.locator('[data-testid="read-check-definition"][data-target-kind="PAGE"]');
    expect(await row.count()).toBe(1);
    expect(await row.locator('th code').textContent()).toBe(DETAIL_PATH);
    expect(await row.locator('td').first().textContent()).toBe(READ_CHECK_TARGET_KIND_LABELS.PAGE);
    expect(await page.getByTestId('read-check-create-page').count()).toBe(1);
  }, SCENARIO_TIMEOUT_MS);

  // MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.8）: 対象の種類は来たリンクで決め、radio を出さない（リンクなしのときだけ出す）。画面の
  // path は、直近の発見の結果の先頭を既定にする。期待の既定（最初の期待の種類）は変えない。
  it('decides the target kind by the link without the radio, and chooses the first page path by default', async () => {
    const fromPage = await openPage(`/read-checks/${PROFILE_ID}/new?target=PAGE`);
    const choice = fromPage.getByTestId('read-check-page-path-choice');
    await choice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await fromPage.getByTestId('read-check-target-kind').count()).toBe(0);
    expect(await choice.inputValue()).toBe(ADMIN_PATH);
    expect(await fromPage.getByTestId('read-check-page-path').inputValue()).toBe(ADMIN_PATH);
    const defaultKind = await fromPage.locator('select[name$="-kind"]').inputValue();
    await screenshot(fromPage, 'mi7-read-check-from-page');

    // 候補から来た（候補の識別の digest つき）: 種類は候補（画面の path の欄は出さない）。
    const fromCandidate = await openPage(`/read-checks/${PROFILE_ID}/new?candidate=${encodeURIComponent(`sha256:${'0'.repeat(64)}`)}`);
    await fromCandidate.getByTestId('read-check-candidate-missing').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await fromCandidate.getByTestId('read-check-target-kind').count()).toBe(0);
    expect(await fromCandidate.getByTestId('read-check-page').count()).toBe(0);

    // リンクなし: radio を出し、選んでも radio を出したまま（画面の path の既定も先頭）。
    const plain = await openPage(`/read-checks/${PROFILE_ID}/new`);
    await plain.getByTestId('read-check-target-kind').waitFor({ timeout: UI_TIMEOUT_MS });
    await plain.locator('input[data-target-kind="PAGE"]').check();
    await plain.getByTestId('read-check-page-path-choice').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await plain.getByTestId('read-check-target-kind').count()).toBe(1);
    expect(await plain.getByTestId('read-check-page-path-choice').inputValue()).toBe(ADMIN_PATH);
    // 期待の既定（最初の期待の種類）は、リンクで来たときと同じ（変えていない）。
    expect(await plain.locator('select[name$="-kind"]').inputValue()).toBe(defaultKind);
  }, SCENARIO_TIMEOUT_MS);

  it('shows the target kind, the page path and the detail of UNDETERMINED in the results', async () => {
    const view = await valueOf<{ definitions: readonly { readCheckId: string; revision: number }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    const [definition] = view.definitions;
    if (definition === undefined) {
      throw new Error('the page path definition was not saved');
    }
    const jobId = 'job-t37d-read';
    const runId = 'RUN-20261017020002';
    writeFinishedJob(jobId, 'READ_CHECK', runId, 'read-evidence.json', {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, jobId, runId, startedAt: STARTED_AT, finishedAt: FINISHED_AT, runStatus: 'PARTIAL',
      endReason: 'COMPLETED', searchChecks: [],
      checks: [{
        readCheckId: definition.readCheckId, readCheckRevision: definition.revision, targetKind: 'PAGE', targetPagePath: DETAIL_PATH, state: 'EXECUTED',
        result: 'UNDETERMINED', detail: 'SERVICE_READ_REFUSED', url: `${TEST_ORIGIN}${DETAIL_PATH}`, httpStatus: 200, blockedRequests: 0,
        structure: null, expectations: [],
      }],
    });
    withDatabase((database) => {
      expect(recordReadCheckResults(database, [{
        jobId, readCheckId: definition.readCheckId, readCheckRevision: definition.revision, result: 'UNDETERMINED', at: RECORDED_AT,
      }]).recorded).toEqual([definition.readCheckId]);
    });
    const page = await openPage(`/read-checks/${PROFILE_ID}`);
    const result = page.locator(`[data-testid="read-check-result"][data-read-check-id="${definition.readCheckId}"]`);
    await result.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await result.getAttribute('data-target-kind')).toBe('PAGE');
    expect(await result.getAttribute('data-detail')).toBe('SERVICE_READ_REFUSED');
    expect(await result.locator('th code').textContent()).toBe(DETAIL_PATH);
    const cells = await result.locator('td').allTextContents();
    expect(cells[0]).toBe(READ_CHECK_TARGET_KIND_LABELS.PAGE);
    expect(cells).toContain(READ_CHECK_DETAIL_DESCRIPTIONS.SERVICE_READ_REFUSED);
    await screenshot(page, 't37d-page-path-result');
  }, SCENARIO_TIMEOUT_MS);

  // DEF-136（設計書 `2026-10-18-beaksight-job-site-unavailability-design.md` の 3.3）: サイトの不調で止まったジョブの結果に、止まった理由と、次にすること
  // （サイトが戻ってから始め直す）を出す（文はカタログ）。
  it('shows the stop by the site unavailability and what to do next on the READ check results and the discovery result', async () => {
    const view = await valueOf<{ definitions: readonly { readCheckId: string; revision: number }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    const [definition] = view.definitions;
    if (definition === undefined) {
      throw new Error('the page path definition was not saved');
    }
    // 1 つ目の定義は確かめ、2 つ目の定義（今は消した定義）の画面で不調が続いて止まった形。
    const readJobId = 'job-def136-read';
    const readRunId = 'RUN-20261017020003';
    const removedId = 'read-def136-removed';
    writeFinishedJob(readJobId, 'READ_CHECK', readRunId, 'read-evidence.json', {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, jobId: readJobId, runId: readRunId, startedAt: STARTED_AT, finishedAt: FINISHED_AT,
      runStatus: 'PARTIAL', endReason: 'SITE_UNAVAILABLE', searchChecks: [],
      checks: [{
        readCheckId: definition.readCheckId, readCheckRevision: definition.revision, targetKind: 'PAGE', targetPagePath: DETAIL_PATH, state: 'EXECUTED',
        result: 'UNDETERMINED', detail: 'SERVICE_READ_REFUSED', url: `${TEST_ORIGIN}${DETAIL_PATH}`, httpStatus: 200, blockedRequests: 0,
        structure: null, expectations: [],
      }, {
        readCheckId: removedId, readCheckRevision: 1, targetKind: 'PAGE', targetPagePath: ADMIN_PATH, state: 'NOT_EXECUTED', reason: 'SITE_UNAVAILABLE',
      }],
    });
    withDatabase((database) => {
      expect(recordReadCheckResults(database, [{
        jobId: readJobId, readCheckId: definition.readCheckId, readCheckRevision: definition.revision, result: 'UNDETERMINED', at: RECORDED_AT,
      }]).recorded).toEqual([definition.readCheckId]);
    });
    const readPage = await openPage(`/read-checks/${PROFILE_ID}`);
    const job = readPage.locator(`[data-testid="read-check-job"][data-job-id="${readJobId}"]`);
    await job.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const endReason = job.getByTestId('read-check-end-reason');
    expect(await endReason.getAttribute('data-reason')).toBe('SITE_UNAVAILABLE');
    expect(await endReason.textContent()).toContain(READ_CHECK_END_REASON_CATALOG.SITE_UNAVAILABLE.label);
    expect(await endReason.textContent()).toContain(READ_CHECK_END_REASON_CATALOG.SITE_UNAVAILABLE.description);
    expect(await job.locator(`li[data-read-check-id="${removedId}"]`).textContent()).toBe(READ_CHECK_END_REASON_CATALOG.SITE_UNAVAILABLE.label);
    await screenshot(readPage, 'def136-read-check-site-unavailable');

    const discoveryJobId = 'job-def136-discovery';
    const discoveryRunId = 'RUN-20261017020004';
    writeFinishedJob(discoveryJobId, 'DISCOVERY', discoveryRunId, 'discovery.json', {
      schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION, jobId: discoveryJobId, runId: discoveryRunId, startedAt: STARTED_AT, finishedAt: FINISHED_AT,
      runStatus: 'PARTIAL', endReason: 'SITE_UNAVAILABLE', maxPages: MAX_PAGES, omittedUnreadPages: 0,
      pages: [
        { url: `${TEST_ORIGIN}${ADMIN_PATH}`, state: 'READ', record: { location: { origin: TEST_ORIGIN, path: ADMIN_PATH }, incompleteReasons: [], candidates: [] },
          blockedRequests: 0 },
        { url: `${TEST_ORIGIN}${DETAIL_PATH}`, state: 'NOT_READ', reason: 'SITE_UNAVAILABLE' },
        { url: `${TEST_ORIGIN}/admin/broken`, state: 'NOT_READ', reason: 'HTTP_ERROR_STATUS' },
      ],
    }, NOTICE);
    withDatabase((database) => {
      recordDiscoveryCandidates(database, { profileId: PROFILE_ID, jobId: discoveryJobId, at: FINISHED_AT, entries: [], readPagePaths: [ADMIN_PATH] });
    });
    const discoveryPage = await openPage(`/discovery/${PROFILE_ID}`);
    const discoveryEnd = discoveryPage.getByTestId('discovery-end-reason');
    await discoveryEnd.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await discoveryEnd.getAttribute('data-reason')).toBe('SITE_UNAVAILABLE');
    expect(await discoveryEnd.textContent()).toBe(DISCOVERY_END_REASON_CATALOG.SITE_UNAVAILABLE.label);
    expect(await discoveryPage.locator('p.muted').allTextContents()).toContain(DISCOVERY_END_REASON_CATALOG.SITE_UNAVAILABLE.description);
    expect(await discoveryPage.locator('li[data-reason="SITE_UNAVAILABLE"]').count()).toBe(1);
    expect(await discoveryPage.locator('li[data-reason="HTTP_ERROR_STATUS"]').count()).toBe(1);
    await screenshot(discoveryPage, 'def136-discovery-site-unavailable');

    // ジョブの画面: 確かめ直しを待っていることの知らせ（監査と同じ文）。
    const jobPage = await openPage(`/jobs/${discoveryJobId}`);
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: 終わった作業の最後の知らせは、たたんだ詳しい内容の中。
    await openAdvancedSettings(jobPage, 'job-details', UI_TIMEOUT_MS);
    const notice = jobPage.getByTestId('job-notice');
    await notice.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await notice.textContent()).toBe(siteUnavailableRecheckText(NOTICE.url, formatDuration(NOTICE.delayMs), NOTICE.attempt, NOTICE.maxAttempts));
    await screenshot(jobPage, 'def136-job-notice');
  }, SCENARIO_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-5・P2-7）: 最初の定義の前に止まった READ の確かめのジョブ（結果の記録が 1 件もない）も結果の一覧に並べ、止まった理由と
  // 次にできることを出す。ジョブの画面にも、終わり方と次にできることを出す。
  it('lists a READ check job that stopped before the first definition with the reason and the next step, also on the job screen', async () => {
    const view = await valueOf<{ definitions: readonly { readCheckId: string; revision: number }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    const [definition] = view.definitions;
    if (definition === undefined) {
      throw new Error('the page path definition was not saved');
    }
    const jobId = 'job-t44e-read-stopped';
    const runId = 'RUN-20261017020005';
    writeFinishedJob(jobId, 'READ_CHECK', runId, 'read-evidence.json', {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, jobId, runId, startedAt: STARTED_AT, finishedAt: FINISHED_AT,
      runStatus: 'PARTIAL', endReason: 'MAX_RUNTIME_REACHED', searchChecks: [],
      checks: [{
        readCheckId: definition.readCheckId, readCheckRevision: definition.revision, targetKind: 'PAGE', targetPagePath: DETAIL_PATH, state: 'NOT_EXECUTED',
        reason: 'MAX_RUNTIME_REACHED',
      }],
    });
    const readPage = await openPage(`/read-checks/${PROFILE_ID}`);
    const job = readPage.locator(`[data-testid="read-check-job"][data-job-id="${jobId}"]`);
    await job.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await job.getByTestId('read-check-end-reason').getAttribute('data-reason')).toBe('MAX_RUNTIME_REACHED');
    expect(await job.getByTestId('read-check-end-reason').textContent()).toContain(READ_CHECK_END_REASON_CATALOG.MAX_RUNTIME_REACHED.description);
    expect(await job.getByTestId('read-check-end-reason-next').textContent()).toBe(LOCAL_UI_JOB_NEXT_STEPS.readCheckEndReasons.MAX_RUNTIME_REACHED);
    expect(await job.locator(`li[data-read-check-id="${definition.readCheckId}"]`).textContent()).toContain(READ_CHECK_END_REASON_CATALOG.MAX_RUNTIME_REACHED.label);
    expect(await job.getByTestId('read-check-result').count()).toBe(0);
    await screenshot(readPage, 't44e-read-check-stopped-before-first');

    const jobPage = await openPage(`/jobs/${jobId}`);
    const endReason = jobPage.getByTestId('job-end-reason');
    await endReason.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await endReason.getAttribute('data-reason')).toBe('MAX_RUNTIME_REACHED');
    expect(await jobPage.getByTestId('job-end-reason-next').textContent()).toContain(LOCAL_UI_JOB_NEXT_STEPS.readCheckEndReasons.MAX_RUNTIME_REACHED ?? '');
    await screenshot(jobPage, 't44e-job-read-check-end');
  }, SCENARIO_TIMEOUT_MS);
});

/**
 * T43d（Task 43 の設計書 4.4、5 章の 4・5）: ジョブの詳細の「登録する」と「案を認証の設定に入れる」、認証の設定の画面の下書きとまとめて保存を確かめる。
 * - ジョブの詳細: 止めた送信の表に、query の名前（記録した `grant_type` の値つき）と登録の列。token の送信の形の行とログインの前後の手続きの行には
 *   「登録する」、伏せた path の行と登録済みの送信の上限で止めた行には手で入れる案内（リンクなし）。観察の欄に、新しく出た鍵の名前と成功の画面のセレクタの案。
 * - 「登録する」は保存しない: 認証の設定の画面を下書きつきで開き、欄に入れ、プロファイルに足す承認したサービスの Origin を知らせる。保存を押すと、
 *   プロファイル（承認したサービスの Origin）と認証の設定を 1 回で保存し、認証の設定は「古い」にならない。
 * - 「案を認証の設定に入れる」は、鍵の名前を接頭辞に、セレクタを成功の画面のセレクタに入れる（保存は利用者）。
 * - 競合: 下書きを開いた後にプロファイルが変わったら、まとめて保存は改訂の衝突で拒み、どちらも書かない（読み直しのボタン）。
 * - 形の違う下書き（URL を直したもの）は欄に入れない。
 * 値は匿名（`example.invalid` とループバック）。
 */
describe('login-observation-ui: T43d the register buttons, the observation and the draft of the auth setup', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const PROFILE_ID = 't43d-observed';
  const CONFLICT_PROFILE_ID = 't43d-conflict';
  const JOB_ID = 'job-t43d-observed';
  const CONFLICT_JOB_ID = 'job-t43d-conflict';
  const HOSTILE_JOB_ID = 'job-t43r2-hostile';
  const JOB_CREATED_AT = '20261017010000';
  const JOB_ENDED_AT = '20261017011000';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const TENANT_PATH = '/rest/v1/rpc/resolve_tenant';
  const KEY_NAME = 'example-auth-token';
  /** `KEY_NAME` の、接頭辞と接尾辞の案（T43R-fix の C-1 (a)）。 */
  // T43R2-fix（意図して直した期待）: 一般の語の側（`-token`）だけ。最初の部分（`example`）は一般の語でないので接頭辞は空。
  const KEY_SHAPE = Object.freeze({ prefix: '', suffix: '-token' });
  const SCREENSHOT_DIRECTORY = process.env['T43D_SCREENSHOT_DIR'];

  const authText = LOCAL_UI_AUTH_TEXT.setup;
  const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT.setup;
  const observedText = LOCAL_UI_LOGIN_OBSERVATION_TEXT;

  const { started, rootOf, contextOf, valueOf } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
  });

  interface AuthSetupPage {
    readonly profile: { readonly revision: number; readonly approvedServiceOrigins: readonly string[] };
    readonly stored: { readonly setup: Record<string, unknown>; readonly freshness: string } | null;
  }
  const authSetupPageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });

  const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

  const profileDocumentOf = (profileId: string, revision: number, serviceOrigins: readonly string[] = []) => ({
    schemaVersion: 'beaksight-profile/1',
    profileId,
    revision,
    targetConfigPath: `config/targets/${profileId}.json`,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [TEST_ORIGIN],
    environmentEvidenceRef: `${profileId}-evidence`,
    ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
  });

  /** 前に保存してある、フォームの送信の認証の設定（版 3）。 */
  const formSetupOf = (profileId: string) => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId,
    profileRevision: 1,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
    loginTransport: 'FORM_NAVIGATION',
    scriptLogin: null,
    loginSideRequests: [],
    successStorageKey: null,
  });

  /** ログインの段で止まったジョブのまとめ（token の送信、手続きの呼び出し、伏せた path、登録済みの上限、観察）。 */
  const SUMMARY: AuditJobLoginStageSummary = {
    scriptLogin: null,
    blockedRequests: {
      requests: [
        {
          origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
          query: { names: ['grant_type', 'redirect_to'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
        },
        { origin: SERVICE_ORIGIN, path: TENANT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 2 },
        { origin: SERVICE_ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
        { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'SIDE_REQUEST_OVER_LIMIT', count: 1 },
        // T43R-fix の M-2: 登録した token の送信先で、必須の query が違ったので止めた行（`grant_type` の値があっても「登録する」を出さない）。
        {
          origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'TOKEN_REQUEST_QUERY_MISMATCH', count: 1,
          query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'refresh_token' }] },
        },
      ],
      unlisted: 0,
    },
    observation: {
      // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前は接頭辞と接尾辞の組だけ。
      storageKeys: { origin: TEST_ORIGIN, shapes: [KEY_SHAPE, { prefix: 'session.', suffix: '.idToken' }], omitted: 1 },
      successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' },
    },
  };

  /** テストだけの操作: ログインの段で止まったジョブの行を書く（ワーカーの代わり）。 */
  const writeJob = (jobId: string, profileId: string, summary: AuditJobLoginStageSummary = SUMMARY): void => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId, jobKind: 'AUDIT', profileId, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordAuthState(database, jobId, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
      expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };

  /** ジョブの詳細を開き、ログインの段の欄を待つ。 */
  const openJob = async (jobId: string): Promise<Page> => {
    const page = await openPage(`/jobs/${jobId}`);
    // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: ログインの段の記録と観察した案は、たたんだ詳しい内容の中（行の登録が要るときは
    // 開いて出る）。開いてから確かめる。
    await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
    await page.getByTestId('job-login-stage').waitFor({ timeout: UI_TIMEOUT_MS });
    return page;
  };

  /**
   * 行の下書きのリンクを押し、認証の設定の画面の下書きの知らせを待つ。FM-1（手動の操作を減らす設計書 2.1）: 「登録する」はその場で保存するボタンになり
   * （`login-stage-register-ui`）、下書きのリンクは「認証の設定の画面で直す」として残した。
   */
  const openDraftFromRow = async (page: Page, rowIndex: number): Promise<void> => {
    await page.getByTestId('job-login-stage-blocked').locator('tbody tr').nth(rowIndex).getByTestId('job-login-stage-edit-draft').click();
    await page.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
  };

  const saveSetup = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: authText.save }).click();
    await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
  };

  beforeAll(async () => {
    writeAuthTargetConfig(rootOf().root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, CONFLICT_PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
    for (const profileId of [PROFILE_ID, CONFLICT_PROFILE_ID]) {
      expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(profileId, 1) })).toMatchObject({ ok: true });
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: formSetupOf(profileId) })).toMatchObject({ ok: true });
    }
    writeJob(JOB_ID, PROFILE_ID);
    writeJob(CONFLICT_JOB_ID, CONFLICT_PROFILE_ID);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  // T43R2-fix（Task 43 の設計書 7 章の最後の行）: 利用者の名前が鍵の名前の端に入る形（再レビュー T43R2 の 3 つと `alice/auth/token`）から作った案を出す
  // ジョブの詳細と、その「案を認証の設定に入れる」の下書きの URL と認証の設定の画面に、名前が出ない。
  describe('T43R2-fix: no user name on the job detail and the draft URL', () => {
    it('shows only the general word sides of the key names, and the user names are neither on the screens nor in the draft URL', async () => {
      const shapes = newStorageKeyShapesOf([], ['entryuser.session.token', 'app.session.entryuser', 'alice@example.com:session:token', 'alice/auth/token']);
      expect(shapes).not.toBeNull();
      writeJob(HOSTILE_JOB_ID, CONFLICT_PROFILE_ID, {
        scriptLogin: null, blockedRequests: null, observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [...(shapes?.shapes ?? [])], omitted: shapes?.omitted ?? 0 } },
      });
      const page = await openJob(HOSTILE_JOB_ID);
      const markers = ['entryuser', 'alice', 'example.com'];
      const jobText = await page.locator('body').textContent() ?? '';
      expect(markers.filter((marker) => jobText.includes(marker))).toEqual([]);
      expect(await page.getByTestId('job-login-observation-keys').textContent())
        .toBe(['.token', '/token', ':token'].map((suffix) => `${observedText.storageKeyMiddle}${suffix}`).join(', ') + ` ${observedText.omittedQueryNames(formatCount(1))}`);
      await page.getByTestId('job-login-observation-apply').click();
      await page.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(markers.filter((marker) => page.url().includes(marker) || decodeURIComponent(page.url()).includes(marker))).toEqual([]);
      // MI-F5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6）: 認証の設定があるときは、ログインの送り方は読むだけ（このプロファイルの
      // 保存した設定はフォームの送信のまま。送り方は入口の確かめと手動のログインの観察からだけ入る）。
      await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
      expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).count()).toBe(0);
      // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 3。前は読むだけの値で出していた）: 変えられない送り方は出さない。
      expect(await page.getByTestId('auth-setup-destination-transport').count()).toBe(0);
      const setupText = await page.locator('body').textContent() ?? '';
      expect(markers.filter((marker) => setupText.includes(marker))).toEqual([]);
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('T43d: the register buttons and the observation on the job detail', () => {
    it('shows the query names, the register buttons only for the rows with a draft, and the observation', async () => {
      const page = await openJob(JOB_ID);
      const table = page.getByTestId('job-login-stage-blocked');
      const rows = table.locator('tbody tr');
      expect(await rows.count()).toBe(5);
      // token の送信の形の行: query の名前と、記録した `grant_type` の値。
      expect(await rows.nth(0).getByTestId('job-login-stage-query').textContent())
        .toBe(`grant_type（${observedText.recordedValue}: password）, redirect_to`);
      expect(await rows.nth(0).getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('TOKEN_TARGET');
      expect(await rows.nth(1).getByTestId('job-login-stage-register').getAttribute('data-registration')).toBe('SIDE_REQUEST');
      // 伏せた path の行と、登録済みの送信の上限で止めた行には、リンクがなく、手で入れる案内がある。
      expect(await rows.nth(2).getByTestId('job-login-stage-register').count()).toBe(0);
      expect(await rows.nth(2).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualRedactedPath);
      expect(await rows.nth(3).getByTestId('job-login-stage-register').count()).toBe(0);
      expect(await rows.nth(3).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualAlreadyRegistered);
      expect(await rows.nth(4).getByTestId('job-login-stage-register').count()).toBe(0);
      expect(await rows.nth(4).getByTestId('job-login-stage-manual').textContent()).toBe(observedText.manualAlreadyRegistered);
      // 観察の欄（伏せた鍵の名前は伏せた旨を添える。セレクタは CSS と種類の説明だけ）。
      const observation = page.getByTestId('job-login-observation');
      expect(await observation.getByTestId('job-login-observation-keys').textContent()).toBe(
        `${KEY_SHAPE.prefix}${observedText.storageKeyMiddle}${KEY_SHAPE.suffix}, session.${observedText.storageKeyMiddle}.idToken ${observedText.omittedQueryNames(formatCount(1))}`,
      );
      expect(await observation.getByTestId('job-login-observation-selector').textContent())
        .toBe(`#logout${observedText.successSelectorLogout('logout')}`);
      expect(DISCOVERY_LOGOUT_WORDS).toContain('logout');
      expect(await observation.getByTestId('job-login-observation-apply').count()).toBe(1);
      await screenshot(page, 'g01-job-login-stage-register');
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('T43d: the draft of the auth setup and the save of both', () => {
    it('opens the auth setup with the token target draft, saves the profile and the auth setup at once, and the setup is current', async () => {
      const page = await openJob(JOB_ID);
      await openDraftFromRow(page, 0);
      // 下書きは保存していない（保存してある設定はフォームの送信のまま）。
      expect((await authSetupPageOf(PROFILE_ID)).stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION' });
      expect(await page.getByTestId('auth-setup-observed-service-origins').textContent()).toBe(SERVICE_ORIGIN);
      // MI-F5（設計書 4.7.1 の 6）・PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 3。前は読むだけの値で出していた）: 下書きの送り方と送信先は、
      // 画面に出さずに行の観察のまま保存する（下の保存した設定で確かめる）。
      expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
      expect(await page.getByRole('main').innerText()).not.toContain(TOKEN_PATH);
      // 成功の鍵の形は、利用者が入れる（ここでは観察の案の名前）。
      await field(page, scriptText.storageOrigin).selectOption(TEST_ORIGIN);
      await field(page, scriptText.storagePrefix).fill(KEY_NAME);
      await screenshot(page, 'g02-auth-setup-token-draft');
      await saveSetup(page);
      await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      const saved = await authSetupPageOf(PROFILE_ID);
      expect(saved.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] });
      expect(saved.stored?.freshness).toBe('CURRENT');
      expect(saved.stored?.setup).toMatchObject({
        profileRevision: 2,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        successStorageKey: { origin: TEST_ORIGIN, prefix: KEY_NAME, suffix: '' },
      });
      // 保存の後は下書きなしで読み直す（URL に下書きを残さない）。
      expect(page.url()).not.toContain('draft');
    }, SCENARIO_TIMEOUT_MS);

    it('adds the side request draft to the saved list without a profile change, and puts the observation into the key and the selector', async () => {
      const page = await openJob(JOB_ID);
      await openDraftFromRow(page, 1);
      // サービスの Origin は前の保存で承認したので、プロファイルは変えない。
      expect(await page.getByTestId('auth-setup-observed-service-origins').count()).toBe(0);
      // MI-F5・PL-4: 下書きのログインに伴う送信は、画面に出さずに保存する（回数は欄の既定の 1。下の保存した設定で確かめる）。
      expect(await page.getByTestId('auth-setup-destination-side-requests').count()).toBe(0);
      await saveSetup(page);
      await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      const saved = await authSetupPageOf(PROFILE_ID);
      expect(saved.profile.revision).toBe(2);
      expect(saved.stored?.setup).toMatchObject({ loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TENANT_PATH, method: 'POST', maxPerLoginStage: 1 }] });

      const job = await openJob(JOB_ID);
      await job.getByTestId('job-login-observation-apply').click();
      await job.getByTestId('auth-setup-observed-draft').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await field(job, scriptText.storagePrefix).inputValue()).toBe(KEY_SHAPE.prefix);
      expect(await field(job, scriptText.storageSuffix).inputValue()).toBe(KEY_SHAPE.suffix);
      expect(await field(job, authText.successSelector).inputValue()).toBe('#logout');
      // 前に保存したログインに伴う送信は残る（PL-4: 画面には出さないので、保存した設定で確かめる）。
      expect(await job.getByTestId('auth-setup-destination-side-requests').count()).toBe(0);
      await saveSetup(job);
      await job.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect((await authSetupPageOf(PROFILE_ID)).stored?.setup).toMatchObject({
        successCondition: { pathPrefix: '/admin', selector: '#logout' },
        loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TENANT_PATH, method: 'POST', maxPerLoginStage: 1 }],
      });
    }, SCENARIO_TIMEOUT_MS);

    it('rejects the save of both with the revision conflict when the profile changed after the draft was opened, and writes neither', async () => {
      const page = await openJob(CONFLICT_JOB_ID);
      await openDraftFromRow(page, 0);
      await field(page, scriptText.storageOrigin).selectOption(TEST_ORIGIN);
      await field(page, scriptText.storagePrefix).fill(KEY_NAME);
      // 下書きを開いた後に、プロファイルが別の操作で変わる。
      expect(await valueOf('updateProfileFn', 'POST', { profile: profileDocumentOf(CONFLICT_PROFILE_ID, 2), expectedRevision: 1 })).toMatchObject({ ok: true });
      await saveSetup(page);
      const rejection = page.getByTestId('auth-setup-rejection');
      expect(await rejection.getAttribute('data-reason')).toBe('PROFILE_REVISION_CONFLICT');
      expect(await rejection.textContent()).toBe(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description);
      expect(await page.getByRole('button', { name: LOCAL_UI_TEXT.reload }).count()).toBe(1);
      const after = await authSetupPageOf(CONFLICT_PROFILE_ID);
      expect(after.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [] });
      expect(after.stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION', profileRevision: 1 });
    }, SCENARIO_TIMEOUT_MS);

    it('does not put a draft of a wrong shape into the fields', async () => {
      const wrong = encodeURIComponent(JSON.stringify({ scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token?grant_type=password', requiredQuery: [] } }));
      const page = await openPage(`/auth-setup/${PROFILE_ID}?draft=${wrong}`);
      await page.getByTestId('auth-setup-observed-draft-invalid').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('auth-setup-observed-draft').count()).toBe(0);
      await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
      // PL-4（前は読むだけの値で、保存した送信先のままかを見ていた）: 送信先は出さないので、保存しても保存した送信先のままであることで確かめる。
      expect(await page.getByTestId('auth-setup-destination-script-path').count()).toBe(0);
      await saveSetup(page);
      expect(await page.getByTestId('auth-setup-rejection').count()).toBe(0);
      expect((await authSetupPageOf(PROFILE_ID)).stored?.setup).toMatchObject({ scriptLogin: { path: TOKEN_PATH } });
    }, SCENARIO_TIMEOUT_MS);
  });
});

/**
 * FM-1（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` の 2.1、4 章の 1）: ジョブの詳細のログインの段の表の「登録する」を、確認の
 * ダイアログの後に、その場で保存することを確かめる。画面は移らない。成功の鍵は、ジョブのログインの観察から入る（今まで、案に鍵が入らず
 * `AUTH_SETUP_STORAGE_KEY_INVALID` で保存できなかった）。値は匿名（`example.invalid` とループバック）。
 * MI-G（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7、6 章の 6）: 自動ログインの記録（試しのあるジョブ、ログインの確かめの
 * ジョブ）と、自動ログインのプロファイルの行からは、token の送信先と承認したサービスの Origin を足す登録を、案と保存の両方で拒み、何も保存しない。
 * 束: MI-G は画面の場面（理由を出す、下書きのリンクを出さない）だけ残し、保存の拒否を Server Function で写した場面は消した（別の所はファイルの頭の注）。
 */
describe('login-stage-register-ui: FM-1 the register button and MI-G', () => {
  const UI_TIMEOUT_MS = 15_000;
  const SCENARIO_TIMEOUT_MS = 120_000;
  const MAX_TAB_PRESSES = 80;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const PROFILE_ID = 'fm1-register';
  const JOB_ID = 'job-fm1-register';
  const JOB_CREATED_AT = '20261019010000';
  const JOB_ENDED_AT = '20261019011000';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const AFTER_PATH = '/rest/v1/rpc/after_login';
  const LOGOUT_PATH = '/auth/v1/logout';
  const KEY_SHAPE = Object.freeze({ prefix: '', suffix: '-token' });
  const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });

  const text = LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT;

  const { started, rootOf, contextOf, call, valueOf } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['FM1_SCREENSHOT_DIR'],
  });

  interface AuthSetupPage {
    readonly profile: { readonly revision: number; readonly approvedServiceOrigins?: readonly string[] };
    readonly stored: { readonly setup: Record<string, unknown>; readonly freshness: string } | null;
  }
  const authSetupPage = (): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId: PROFILE_ID });

  /** フォームの送信の認証の設定（版 3）。 */
  const formSetup = {
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId: PROFILE_ID,
    profileRevision: 1,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
    loginTransport: 'FORM_NAVIGATION',
    scriptLogin: null,
    loginSideRequests: [],
    successStorageKey: null,
  };

  /** ログインの段で止まったジョブのまとめ（token の送信、token の後の手続きの呼び出し、危険な語の path と、成功の鍵の観察）。 */
  const SUMMARY: AuditJobLoginStageSummary = {
    scriptLogin: null,
    blockedRequests: {
      requests: [
        {
          origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
          query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
        },
        { origin: SERVICE_ORIGIN, path: AFTER_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
        { origin: SERVICE_ORIGIN, path: LOGOUT_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
      ],
      unlisted: 0,
    },
    observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [KEY_SHAPE], omitted: 0 } },
  };

  /** ログインの段で止まって終わったジョブを書く（MI-G: 種類と、自動ログインの試しの記録を変えられる）。 */
  const writeJobOf = (job: Pick<NewAuditJob, 'jobId' | 'jobKind' | 'profileId' | 'autoLoginAttempt'>, summary: AuditJobLoginStageSummary = SUMMARY): void => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { ...job, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null)).toEqual({ ok: true });
      expect(recordAuthState(database, job.jobId, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
      expect(recordEnded(database, job.jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  };
  const writeJob = (): void => {
    writeJobOf({ jobId: JOB_ID, jobKind: WORKER_AUDIT_JOB_KIND, profileId: PROFILE_ID });
  };

  const rowOf = (page: Page, index: number) => page.getByTestId('job-login-stage-blocked').locator('tbody tr').nth(index);

  beforeAll(async () => {
    writeAuthTargetConfig(rootOf().root, PROFILE_ID, TEST_ORIGIN, '/admin', MAX_PAGES);
    const profile = {
      schemaVersion: 'beaksight-profile/1', profileId: PROFILE_ID, revision: 1, targetConfigPath: `config/targets/${PROFILE_ID}.json`, environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${PROFILE_ID}-evidence`,
    };
    expect(await valueOf('createProfileFn', 'POST', { profile })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: formSetup })).toMatchObject({ ok: true });
    writeJob();
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  describe('FM-1: the register button saves the row on the spot after the confirmation', () => {
    it('saves nothing when the dialog is cancelled', async () => {
      const page = await openPage(`/jobs/${JOB_ID}`);
      await rowOf(page, 0).getByTestId('job-login-stage-register').click();
      const dialog = page.getByRole('dialog', { name: text.dialogTitle });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
      await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
      expect((await authSetupPage()).profile.revision).toBe(1);
    }, SCENARIO_TIMEOUT_MS);

    it('saves the token target with the observed storage key on the spot, and the screen does not move', async () => {
      const page = await openPage(`/jobs/${JOB_ID}`);
      const url = page.url();
      await rowOf(page, 0).getByTestId('job-login-stage-register').click();
      const dialog = page.getByRole('dialog', { name: text.dialogTitle });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      // 足すもの（token の送信先と必須の query の名前）と、足す承認したサービスの Origin と、保存した後の改訂を出す。
      expect(await dialog.getByTestId('login-stage-register-added').getAttribute('data-kind')).toBe('TOKEN_TARGET');
      expect(await dialog.getByTestId('login-stage-register-added').textContent()).toContain(`${SERVICE_ORIGIN}${TOKEN_PATH}`);
      expect(await dialog.getByTestId('login-stage-register-added').textContent()).toContain('grant_type');
      expect(await dialog.textContent()).not.toContain('password');
      expect(await dialog.getByTestId('login-stage-register-origins').textContent()).toBe(SERVICE_ORIGIN);
      expect(await dialog.getByTestId('login-stage-register-revision').textContent()).toBe(LOCAL_UI_TEXT.profileForm.revisionText(2));
      await screenshot(page, 'fm1-01-register-dialog');
      await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
      const saved = rowOf(page, 0).getByTestId('job-login-stage-registered');
      await saved.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await saved.textContent()).toBe(text.saved(LOCAL_UI_TEXT.profileForm.revisionText(2)));
      expect(page.url()).toBe(url);
      const after = await authSetupPage();
      expect(after.profile).toMatchObject({ revision: 2, approvedServiceOrigins: [SERVICE_ORIGIN] });
      expect(after.stored?.freshness).toBe('CURRENT');
      expect(after.stored?.setup).toMatchObject({
        profileRevision: 2,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        successStorageKey: { origin: TEST_ORIGIN, ...KEY_SHAPE },
      });
      await screenshot(page, 'fm1-02-registered');
    }, SCENARIO_TIMEOUT_MS);

    it('adds a side request the automatic registration would not add, and shows the reason for a row it cannot add', async () => {
      const page = await openPage(`/jobs/${JOB_ID}`);
      await rowOf(page, 1).getByTestId('job-login-stage-register').click();
      const dialog = page.getByRole('dialog', { name: text.dialogTitle });
      await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await dialog.getByTestId('login-stage-register-added').getAttribute('data-kind')).toBe('SIDE_REQUEST');
      expect(await dialog.getByTestId('login-stage-register-origins').count()).toBe(0);
      await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
      await rowOf(page, 1).getByTestId('job-login-stage-registered').waitFor({ timeout: UI_TIMEOUT_MS });
      expect((await authSetupPage()).stored?.setup).toMatchObject({
        loginSideRequests: [{ origin: SERVICE_ORIGIN, path: AFTER_PATH, method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
      });
      // 危険な語の path の行: ダイアログを出さずに、理由を出す。何も保存しない。
      await rowOf(page, 2).getByTestId('job-login-stage-register').click();
      const rejection = rowOf(page, 2).getByTestId('job-login-stage-register-rejection');
      await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await rejection.getAttribute('data-reason')).toBe('EXCLUDED_PATH');
      expect(await rejection.textContent()).toContain(text.reasons.EXCLUDED_PATH);
      expect(await page.getByRole('dialog', { name: text.dialogTitle }).isVisible()).toBe(false);
      expect((await authSetupPage()).profile.revision).toBe(3);
      // 下書きのリンク（認証の設定の画面で直す）も残る。
      expect(await rowOf(page, 0).getByTestId('job-login-stage-edit-draft').textContent()).toBe(text.editDraft);
    }, SCENARIO_TIMEOUT_MS);

    it('rejects the save when the profile changed after the dialog, and keeps the input checks', async () => {
      expect(await valueOf('registerLoginStageRowFn', 'POST', { jobId: JOB_ID, passed: false, index: 1, expectedProfileRevision: 1 }))
        .toEqual({ ok: false, reason: 'PROFILE_CHANGED', codes: [] });
      expect(await valueOf('loginStageRowProposalFn', 'GET', { jobId: JOB_ID, passed: true, index: 0 })).toEqual({ ok: false, reason: 'ROW_NOT_FOUND' });
      // LZ-3c: 行の番号に最大はない（前は 8 を拒んだ）。負の番号は形の誤り。
      for (const data of [{ jobId: JOB_ID, passed: false, index: -1 }, { jobId: JOB_ID, passed: 'no', index: 0 }, { jobId: JOB_ID, index: 0 }]) {
        expect((await call('loginStageRowProposalFn', 'GET', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
      }
      expect((await authSetupPage()).profile.revision).toBe(3);
    });
  });

  // MI-G（設計書 4.7）: 自動ログインの文脈の行からは、新しいログインの送信先を足さない。手動のログインのプロファイルの手動のジョブの行は、上の FM-1 のとおり通る。
  describe('MI-G: rows from the automated login cannot add a login target or a service origin', () => {
    const MANUAL_PROFILE = 'mig-manual';
    const AUTO_PROFILE = 'mig-auto';
    const ATTEMPT_JOB = 'job-mig-attempt';
    const CHECK_JOB = 'job-mig-check';
    const AUTO_PROFILE_JOB = 'job-mig-auto-profile';
    const NEW_TOKEN_PATH = '/auth/v2/token';
    const OTHER_ORIGIN = 'https://other.example.invalid';
    const REASON = 'NEW_TARGET_FROM_AUTOMATED_LOGIN';
    /** 今の token の送信先と違う token の送信と、`sideOrigin` への token の後の手続きの呼び出し。 */
    const summaryOf = (sideOrigin: string): AuditJobLoginStageSummary => ({
      ...SUMMARY,
      blockedRequests: {
        requests: [
          {
            origin: SERVICE_ORIGIN, path: NEW_TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
            query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
          },
          { origin: sideOrigin, path: AFTER_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1 },
        ],
        unlisted: 0,
      },
    });
    const profileOf = (profileId: string, auth: string, approvedServiceOrigins: readonly string[]) => ({
      schemaVersion: 'beaksight-profile/1', profileId, revision: 1, targetConfigPath: `config/targets/${profileId}.json`, environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins, environmentEvidenceRef: `${profileId}-evidence`,
    });
    /** スクリプトで送るログインの認証の設定（token の送信先の Origin は承認済み。自動ログインのプロファイルは自動ログインの欄を持つ）。 */
    const scriptSetupOf = (profileId: string, automatedLogin: unknown) => ({
      ...formSetup,
      profileId,
      loginPostEndpoints: [],
      automatedLogin,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      successStorageKey: { origin: TEST_ORIGIN, ...KEY_SHAPE },
    });
    const pageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });
    const expectRejected = async (jobId: string, index: number): Promise<void> => {
      expect(await valueOf('loginStageRowProposalFn', 'GET', { jobId, passed: false, index })).toEqual({ ok: false, reason: REASON });
      expect(await valueOf('registerLoginStageRowFn', 'POST', { jobId, passed: false, index, expectedProfileRevision: 1 }))
        .toEqual({ ok: false, reason: REASON, codes: [] });
    };

    beforeAll(async () => {
      writeAuthTargetConfig(rootOf().root, MANUAL_PROFILE, TEST_ORIGIN, '/admin', MAX_PAGES);
      writeAuthTargetConfig(rootOf().root, AUTO_PROFILE, TEST_ORIGIN, '/admin', MAX_PAGES);
      // MI-C2 項目 16・MI-F1（設計書 4.7.1 の 1・2）: 画面の道（`createProfileFn`）では、承認したサービスの Origin つきのプロファイルと、自動ログインの
      // プロファイルを作れなくなった。ここでは、手動のログインの観察で Origin が入った手動のログインのプロファイルと、その後に切り替えた、今ある形の自動ログインの
      // プロファイル（設計書 4.4: そのまま動く）を、管理データの保存の部品で直接作る（テストだけの操作）。
      const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
      try {
        for (const profile of [profileOf(MANUAL_PROFILE, 'MANUAL_SESSION', [SERVICE_ORIGIN]), profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN', [SERVICE_ORIGIN])]) {
          const targetConfig = await loadConfig(`${rootOf().root}/${profile.targetConfigPath}`);
          expect(createProfile(database, profile, { resolveContext: () => ({ targetConfig }) }).ok).toBe(true);
        }
      } finally {
        closeControlDatabase(database);
      }
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: scriptSetupOf(MANUAL_PROFILE, null) })).toMatchObject({ ok: true });
      expect(await saveAuthSetupRequestInStore(rootOf(), {
        setup: scriptSetupOf(AUTO_PROFILE, {
          usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
          failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
        }),
      })).toMatchObject({ ok: true });
      // 手動のログインのプロファイルの、自動ログインの記録のジョブ（2 つ目の行の送り先は、まだ承認していない Origin）。
      writeJobOf({ jobId: ATTEMPT_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: MANUAL_PROFILE, autoLoginAttempt: { credentialRevision: 1 } }, summaryOf(OTHER_ORIGIN));
      writeJobOf({ jobId: CHECK_JOB, jobKind: WORKER_LOGIN_CHECK_JOB_KIND, profileId: MANUAL_PROFILE }, summaryOf(OTHER_ORIGIN));
      // 自動ログインのプロファイルの、手動のジョブ（2 つ目の行の送り先は、承認したサービスの Origin）。
      writeJobOf({ jobId: AUTO_PROFILE_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: AUTO_PROFILE }, summaryOf(SERVICE_ORIGIN));
    }, SCENARIO_TIMEOUT_MS);

    it('rejects a new token target from the manual job of the automated login profile, and shows the reason on the screen', async () => {
      const before = await pageOf(AUTO_PROFILE);
      await expectRejected(AUTO_PROFILE_JOB, 0);
      const page = await openPage(`/jobs/${AUTO_PROFILE_JOB}`);
      await rowOf(page, 0).getByTestId('job-login-stage-register').click();
      const rejection = rowOf(page, 0).getByTestId('job-login-stage-register-rejection');
      await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await rejection.getAttribute('data-reason')).toBe(REASON);
      expect(await rejection.textContent()).toContain(text.reasons[REASON]);
      expect(await page.getByRole('dialog', { name: text.dialogTitle }).isVisible()).toBe(false);
      await screenshot(page, 'mig-01-automated-login-rejected');
      const after = await pageOf(AUTO_PROFILE);
      expect(after.profile).toEqual(before.profile);
      expect(after.stored?.setup).toEqual(before.stored?.setup);
    }, SCENARIO_TIMEOUT_MS);

    // MI-C 項目 12: 自動ログインの文脈の行（自動ログインの試しのあるジョブ、ログインの確かめのジョブ、自動ログインのプロファイル）には、認証の設定の画面を
    // 下書きつきで開くリンク（「認証の設定の画面で直す」）を出さない（MI-G の拒否と同じ文脈の判定）。手動のログインのジョブの行には、今どおり出す。
    it('does not show the draft link on the rows in the automated login context, and still shows it for the manual login job', async () => {
      for (const jobId of [ATTEMPT_JOB, CHECK_JOB, AUTO_PROFILE_JOB]) {
        const page = await openPage(`/jobs/${jobId}`);
        await rowOf(page, 0).getByTestId('job-login-stage-register').waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await page.getByTestId('job-login-stage-edit-draft').count(), jobId).toBe(0);
      }
      const manual = await openPage(`/jobs/${JOB_ID}`);
      await rowOf(manual, 0).getByTestId('job-login-stage-register').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await manual.getByTestId('job-login-stage-edit-draft').count()).toBeGreaterThan(0);
    }, SCENARIO_TIMEOUT_MS);
  });
});

/**
 * MI-F5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6・7）: ログインの送信先は、入口の確かめと手動のログインの観察から
 * だけ入る。束には画面の 2 場面だけを入れた（3a〜3c・3d・M-1・最初の保存の Server Function の場面は、`tests/integration/credential-destination-observed-only.test.ts`）。
 * - 7: 認証の設定があるときは、送信先の項目を入力の欄にせず、読むだけで出す。
 * - PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8。MI 4.7.1 の 6 の持ち越し）: token の送信先・必須の query・ログインに伴う送信は、
 *   設定がないときも読むだけで出す。送り方の案がない（入口の確かめがない）ときの既定は送信先のない形で、画面の最初の保存がそのまま通る。
 * 値は匿名（`example.invalid` とループバック）。
 */
describe('credential-destination-observed-only: MI-F5 the destination on the auth setup screen', () => {
  const SCENARIO_TIMEOUT_MS = 180_000;
  const UI_TIMEOUT_MS = 15_000;
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const GRANT = Object.freeze({ name: 'grant_type', value: 'password' });
  const PROFILES = Object.freeze({
    draft: 'mif5-draft',
    /** PL-S: 入口の確かめも設定もない、手動のログインのプロファイル（認証の設定の画面の最初の保存を、画面の道で確かめる）。 */
    firstScreen: 'mif5-first-screen',
  });

  const { started, rootOf, contextOf, valueOf } = sharedUiServerKitOf(serverKit);

  type Setup = Record<string, unknown>;
  const setupOf = async (profileId: string): Promise<Setup | null> =>
    (await valueOf<{ readonly stored: { readonly setup: Setup } | null }>('getAuthSetupFn', 'GET', { profileId })).stored?.setup ?? null;

  const AUTOMATED_LOGIN = Object.freeze({
    usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  });

  /** スクリプトで送るログインの認証の設定（手動のログインの観察の後の形。token の送信先は承認したサービスの Origin）。 */
  const scriptSetupOf = (profileId: string, profileRevision: number, automated: boolean): Setup => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId,
    profileRevision,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
    allowedIdpOrigins: [],
    automatedLogin: automated ? AUTOMATED_LOGIN : null,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] },
    loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/tenant', method: 'POST', maxPerLoginStage: 2 }],
    successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
  });

  const profileDocumentOf = (profileId: string, auth: string, targetConfig: string = profileId) => ({
    schemaVersion: 'beaksight-profile/1', profileId, revision: 1, targetConfigPath: `config/targets/${targetConfig}.json`, environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins: [SERVICE_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
  });

  /** テストの準備（管理データの保存の部品を直接呼ぶ。手動のログインの観察と切り替えの後の形）。 */
  const seedProfile = async (profileId: string, auth: string, withSetup: boolean, targetConfig: string = profileId): Promise<void> => {
    expect(await createProfileInStore(rootOf().root, profileDocumentOf(profileId, auth, targetConfig))).toMatchObject({ ok: true });
    if (withSetup) {
      expect(await saveAuthSetupInStore(rootOf().root, scriptSetupOf(profileId, 1, auth === 'AUTOMATED_LOGIN'))).toMatchObject({ ok: true });
    }
  };

  beforeAll(async () => {
    for (const profileId of Object.values(PROFILES)) {
      writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, '/admin', MAX_PAGES);
    }
    await seedProfile(PROFILES.draft, 'MANUAL_SESSION', true);
    await seedProfile(PROFILES.firstScreen, 'MANUAL_SESSION', false);
  }, SCENARIO_TIMEOUT_MS);

  describe('MI-F5: the auth setup screen shows the destination read-only when an auth setup exists (7)', () => {
    it('has no input for the destination items, and keeps the inputs of the other fields', async () => {
      const page = await (contextOf() as BrowserContext).newPage();
      try {
        await page.goto(`${started().origin}/auth-setup/${PROFILES.draft}`, { waitUntil: 'networkidle' });
        await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
        await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
        for (const name of ['loginStartUrl', 'loginTransport', 'loginPostEndpoints', 'scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0', 'sideRequestPath0']) {
          expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
        }
        expect(await page.getByTestId('auth-setup-destination-locked').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.destinationLockedNote);
        // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 3。前は読むだけの値で出していた）: 変えられない送信先は、読むだけの値でも出さない。
        expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
        expect(await page.getByRole('main').innerText()).not.toContain(TOKEN_PATH);
        for (const name of ['excludedPaths', 'auditPathPrefixes', 'successPathPrefix', 'storagePrefix']) {
          expect(await page.locator(`[name="${name}"]`).count(), name).toBe(1);
        }
      } finally {
        await page.close();
      }
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('PL-S: the token target, the required query and the side requests are read-only without an auth setup too (MI 4.7.1 の 6)', () => {
    it('shows the draft without a destination (no entry check) read-only, and its first save on the screen passes', async () => {
      const page = await (contextOf() as BrowserContext).newPage();
      try {
        await page.goto(`${started().origin}/auth-setup/${PROFILES.firstScreen}`, { waitUntil: 'networkidle' });
        await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
        await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
        // 送り方の案がないときの既定は、送信先のない形（スクリプトの送信）。設定がないので、ログインの画面の URL と送り方は入力の欄のまま。
        expect(await page.locator('input[name="loginTransport"][value="SCRIPT_REQUEST"]').isChecked()).toBe(true);
        expect(await page.locator('[name="loginStartUrl"]').count()).toBe(1);
        expect(await page.getByTestId('auth-setup-destination-locked').count()).toBe(0);
        // token の送信先・必須の query・ログインに伴う送信は、入力の欄を出さず、読むだけ（観察が入れる）。
        for (const name of ['scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0', 'sideRequestPath0']) {
          expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
        }
        // OP-DEF の 5: 足すボタンの文言はカタログから消した（使い先がない）。前の名前のボタンが出ないことは、今も確かめる。
        for (const label of REMOVED_ADD_BUTTON_LABELS) {
          expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
        }
        // PL-4（前は読むだけの値「なし」で出していた）: 読むだけの値も出さない。
        for (const testId of ['auth-setup-destination-script-origin', 'auth-setup-destination-script-path', 'auth-setup-destination-required-query',
          'auth-setup-destination-side-requests']) {
          expect(await page.getByTestId(testId).count(), testId).toBe(0);
        }
        // 最初の保存: ログインの画面の URL と、ログインが済んだと判定するパスだけを入れて保存すると、そのまま通る（送信先のない形）。
        await page.locator('[name="loginStartUrl"]').fill(`${TEST_ORIGIN}/auth`);
        await page.locator('[name="successPathPrefix"]').fill('/admin');
        await page.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
        await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
        expect(await page.getByTestId('auth-setup-rejection').count()).toBe(0);
        expect(await setupOf(PROFILES.firstScreen)).toMatchObject({ loginTransport: 'SCRIPT_REQUEST', scriptLogin: null, loginSideRequests: [], loginPostEndpoints: [] });
      } finally {
        await page.close();
      }
    }, SCENARIO_TIMEOUT_MS);
  });
});

/**
 * スクリプトで送るログインの画面（T34d。Task 34 の設計書 3.1、3.2、3.6）を確かめる。
 * - プロファイルの画面: 「承認したサービスの Origin」の欄は、テスト環境の 2 つのモードだけ出る。誤り（形の誤り、テスト環境の Origin との重なり）は、
 *   その欄に出る。保存すると、プロファイルの項目になる。
 * - 認証の設定の画面: ログインの送り方でスクリプトの送信を選ぶと、フォームの送信先の欄が消え、token の送信先（Origin は承認したサービスの Origin から
 *   選ぶ）・必須の query の組・ログインに伴う送信の一覧・成功のローカル ストレージの鍵の形の欄が出る。保存すると版 3 の設定になり、読み直すと同じ値。
 *   PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: token の送信先・必須の query・ログインに伴う送信は、設定がないときも読むだけ
 *   （手で入れない。観察が入れる）。入口の確かめの案がないときの既定の送り方は、送信先のない形（スクリプトの送信）。
 * - 誤りは、検証の owner の位置で欄と行に出る（要る項目の欠け、承認していないサービスの Origin、必須の query、送信先の重なり、鍵の形、フォームの送信の
 *   送信先の欠け）。
 * - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 版 2 の設定は保存できない（版 3 だけ。前の版の知らせと、版 2 のまま保存する道は捨てた）。
 * - 秘密の目印: 秘密に見える名前の query の値（目印）は、保存を拒まれ、Server Function の応答と管理データ（WAL を含む）に出ない。
 * - T34e: ジョブの詳細に「ログインの段で止めた送信」の表（Origin、パス、種類、理由、回数）と、数のまとめと、登録の案内が出る（値に見える区切りを
 *   伏せた path は伏せた旨を添え、一覧の上限を超えた数は文で）。ジョブの行は、テストだけの操作で管理データに書く（ワーカーは起動しない）。
 * - T35d: スクリプトの送信のときだけ、監査の段の読み取りの手続きの呼び出しの一覧と、サービスの Origin への要求の上限の欄が出る。保存して読み直すと
 *   同じ値（空の上限は上限の値）。重なりと範囲の外の上限は、欄と行に出る。フォームの送信では出ない。項目を足さない保存では、項目を持たない。
 * - T36a（Task 36 の設計書 3.5）: 自動ログインのプロファイルでも「ログインの送り方」を選べる。スクリプトで送るログインを選んで保存すると、自動ログインの
 *   設定（3 つのセレクタ、固定の回数）を持つ版 3 のスクリプトの送信の設定になる。
 * ターゲット設定と管理データは一時の root の中だけ（監査はしない。サイトへは接続しない）。値は匿名（`example.invalid` とループバック）。
 */
describe('script-login-ui: T34d・T34e・T35d・T36a the script login screens', () => {
  /** 画面の操作を待つ上限（ms）。 */
  const UI_TIMEOUT_MS = 15_000;
  /** 1 つの場面の上限（ms）。 */
  const SCENARIO_TIMEOUT_MS = 120_000;
  /** フォーカスを Tab で動かす回数の上限（使わないが、補助の決まり）。 */
  const MAX_TAB_PRESSES = 80;
  /** 巡回の上限（ターゲット設定の値。監査はしない）。 */
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  /** テストの値（匿名）。テスト環境の Origin はループバック（接続しない）。サービスの Origin は `example.invalid`。 */
  const SCRIPT_PROFILE = 't34d-script';
  const LEGACY_PROFILE = 't34d-legacy';
  const JOB_PROFILE = 't34e-job';
  const AUTO_PROFILE = 't36a-auto';
  /** MI-F5: 版 3 の誤りの表示を、欄を手で入れられる新しい設定で確かめるプロファイル（認証の設定を保存しない）。 */
  const ERRORS_PROFILE = 't34d-errors';
  const JOB_ID = 'job-t34e-login-stage';
  const JOB_CREATED_AT = '20261016010000';
  const JOB_ENDED_AT = '20261016011000';
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const OTHER_SERVICE_ORIGIN = 'https://other-service.example.invalid';
  const TOKEN_PATH = '/auth/v1/token';
  const SIDE_PATH = '/functions/v1/sync_access';
  const SIDE_COUNT = 2;
  /** T36R-fix（T36R の M-7）: ジョブの行に書く、資格情報を含む要求を止めた数。 */
  const CREDENTIAL_BLOCKED_COUNT = 2;
  const ADMIN_PATH = '/admin';
  const LOGOUT_PATH = '/admin/logout';
  /** 秘密に見える名前の query の値の目印（起動のたびに作る。出力しない）。 */
  const SECRET_MARKER = `m${randomBytes(16).toString('hex')}`;
  const SCREENSHOT_DIRECTORY = process.env['T34D_SCREENSHOT_DIR'];

  const profileText = LOCAL_UI_TEXT.profileForm;
  const authText = LOCAL_UI_AUTH_TEXT.setup;
  const scriptText = LOCAL_UI_SCRIPT_LOGIN_TEXT;

  const { started, rootOf, contextOf, call, cookieOf } = sharedUiServerKitOf(serverKit);
  /** Server Function の応答の本文（ブラウザが受けたもの。目印の検査に使う）。 */
  const responseBodies: string[] = [];

  const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: SCREENSHOT_DIRECTORY,
    onPageCreated: (page) => {
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.startsWith('/_serverFn/')) {
          void response.text().then((body) => responseBodies.push(body), () => undefined);
        }
      });
    },
  });

  const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
    const result = await call(name, method, data);
    responseBodies.push(result.response.body);
    expect(result.response.status, name).toBe(200);
    return result.value as T;
  };

  /** 保存してある認証の設定（画面の Server Function の値）。 */
  interface AuthSetupPage {
    readonly profile: { readonly revision: number; readonly approvedServiceOrigins: readonly string[] };
    readonly stored: { readonly setup: Record<string, unknown>; readonly updatedAt: string } | null;
  }
  const authSetupPageOf = (profileId: string): Promise<AuthSetupPage> => valueOf<AuthSetupPage>('getAuthSetupFn', 'GET', { profileId });

  /** 欄（ラベルは完全一致）。 */
  const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

  /** 行の欄のラベル（`1 行目 名前` の形）。 */
  const rowLabel = (line: number, label: string): string => `${authText.lineText(String(line))} ${label}`;

  /** 認証の設定の画面を開き、フォームが出るまで待つ。 */
  const openAuthSetup = async (profileId: string): Promise<Page> => {
    const page = await openPage(`/auth-setup/${profileId}`);
    await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
    return page;
  };

  /** 保存を押し、保存の知らせか拒否が出るまで待つ。 */
  const saveSetup = async (page: Page): Promise<void> => {
    await page.getByRole('button', { name: authText.save }).click();
    await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
  };

  /** 欄の誤りの文（`aria-invalid` と、誤りの文を含むこと）。 */
  const expectFieldError = async (page: Page, label: string, description: string): Promise<void> => {
    expect(await field(page, label).getAttribute('aria-invalid'), label).toBe('true');
    expect(await page.locator('.field', { has: field(page, label) }).locator('.field-error').textContent(), label).toContain(description);
  };

  /** 一覧の枠の誤りの文（行の見出しつき）。 */
  const expectGroupError = async (page: Page, testId: string, text: string): Promise<void> => {
    const group = page.getByTestId(testId);
    expect(await group.getAttribute('aria-invalid'), testId).toBe('true');
    expect(await group.locator('.field-error').textContent(), testId).toContain(text);
  };

  /** 手動のログインのテスト環境のプロファイルを Server Function で作る（版 2 の場面の準備）。 */
  const profileDocumentOf = (profileId: string, targetConfigPath: string, revision: number, serviceOrigins: readonly string[]) => ({
    schemaVersion: 'beaksight-profile/1',
    profileId,
    revision,
    targetConfigPath,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [TEST_ORIGIN],
    environmentEvidenceRef: `${profileId}-evidence`,
    ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: serviceOrigins }),
  });

  beforeAll(() => {
    writeAuthTargetConfig(rootOf().root, SCRIPT_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, LEGACY_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, JOB_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, AUTO_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, ERRORS_PROFILE, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  // MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2・4.9。T34d の欄の手順を 4.2 の形に直した）: 承認したサービスの Origin は、
  // 利用者が知りえないので画面から足さない（手動のログインの観察だけが足す）。作成の画面には欄を出さず（詳しい設定の中にも）、プロファイルの詳細の編集
  // （詳しい設定）では、読むだけの一覧と「消す」だけにする。監査の対象の Origin が入っているときの拒否の文は、4.9 の形で一覧に出す。
  describe('T34d: the approved service origins on the profile screen', () => {
    it('has no field on the creation screen, lists the origins read-only with "remove" on the edit screen, and saves the removal', async () => {
      const configPath = `config/targets/${SCRIPT_PROFILE}.json`;
      const thirdServiceOrigin = 'https://third-service.example.invalid';
      // 作成の画面: どの使い方でも、承認したサービスの Origin の欄はない。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面の見える
      // 入力は開始のアドレス・使い方・保存だけで、たたんだ詳しい設定（前は監査モードを選んで確かめた）もない。
      const create = await openPage('/profiles/new');
      await field(create, profileText.startUrl).waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await create.locator('main details').count()).toBe(0);
      for (const usage of [profileText.usageTestAuth, profileText.usagePublic]) {
        await field(create, usage).check();
        expect(await create.locator('[name="approvedServiceOrigins"]').count(), usage).toBe(0);
        expect(await create.getByText(scriptText.profile.approvedServiceOrigins).count(), usage).toBe(0);
      }
      // プロファイルは Server Function で作る（作成の画面でテスト環境を保存すると、入口の確かめが TEST_ORIGIN へ接続するため。作成の画面の保存は
      // `start-url-onboarding-ui.test.ts`）。手動のログインの観察の代わりに、承認したサービスの Origin を Server Function で足す（テストだけの操作）。
      expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(SCRIPT_PROFILE, configPath, 1, []) })).toMatchObject({ ok: true });
      // MI-F1（設計書 4.7.1 の 1）: 画面の編集の口は承認したサービスの Origin を足さないので、テストの準備は保存の部品で直接更新する。
      expect(await updateProfileInStore(rootOf().root, profileDocumentOf(SCRIPT_PROFILE, configPath, 2, [SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN, thirdServiceOrigin]), 1))
        .toMatchObject({ ok: true });

      // 編集（詳しい設定の中）: 読むだけの一覧と「消す」。足す欄はない。
      const page = await openPage(`/profiles/${SCRIPT_PROFILE}`);
      await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
      const list = page.getByTestId('profile-service-origins');
      await list.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await list.locator('code').allTextContents()).toEqual([SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN, thirdServiceOrigin]);
      expect(await list.locator('input, textarea, select').count()).toBe(0);
      expect(await page.locator('[name="approvedServiceOrigins"]').count()).toBe(0);
      expect(await list.textContent()).toContain(scriptText.profile.approvedServiceOriginsHint);
      await screenshot(page, 'd01-profile-service-origins-list');
      await list.getByRole('button', { name: scriptText.profile.removeServiceOriginLabel(thirdServiceOrigin) }).click();
      await expect.poll(() => list.locator('code').allTextContents(), { timeout: UI_TIMEOUT_MS }).toEqual([SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN]);
      await page.getByRole('button', { name: profileText.save }).click();
      await page.getByText(profileText.updated).waitFor({ timeout: UI_TIMEOUT_MS });
      const detail = await valueOf<{ profile: { revision: number; approvedServiceOrigins?: readonly string[] } }>(
        'getProfileFn', 'GET', { profileId: SCRIPT_PROFILE },
      );
      expect(detail.profile).toMatchObject({ revision: 3, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_SERVICE_ORIGIN] });

      // 監査の対象の Origin（設定のファイルの allowedOrigins）に入るサービスの Origin は拒み、4.9 の形の文を一覧に出す（ここでは、サービスの Origin を
      // 監査の対象に含む設定のファイルへ切り替えて、重なりを作る。loopback でない Origin なので、読み込みの間隔は作るファイルの控えめな値にする）。
      writeAuthTargetConfig(rootOf().root, 't34d-service-site', SERVICE_ORIGIN, ADMIN_PATH, MAX_PAGES, GENERATED_TARGET_CRAWL_LIMITS.minNavigationIntervalMs);
      const reopened = await openPage(`/profiles/${SCRIPT_PROFILE}`);
      await openProfileAdvancedSettings(reopened, UI_TIMEOUT_MS);
      await field(reopened, profileText.targetConfigPath).selectOption('config/targets/t34d-service-site.json');
      await reopened.getByRole('button', { name: profileText.save }).click();
      const reopenedList = reopened.getByTestId('profile-service-origins');
      await reopenedList.locator('.field-error').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await reopenedList.locator('.field-error').textContent())
        .toContain(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_SERVICE_ORIGIN_INSIDE_TARGET);
      expect(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_SERVICE_ORIGIN_INSIDE_TARGET)
        .toContain('手でログインすると、ログインの先のサイトのアドレスが自動で入ります');
      await screenshot(reopened, 'd02-profile-service-origin-error');
      expect((await valueOf<{ profile: { revision: number } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE })).profile.revision).toBe(3);
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('T34d: the version 3 auth setup screen (the script login)', () => {
    // MI-F5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6・7。T34d の手で入れる手順を直した）: ログインの送信先（token の送信先、必須の
    // query、ログインに伴う送信）は、入口の確かめと手動のログインの観察からだけ入る。認証の設定がまだない画面でスクリプトの送信の欄を出し、手で入れた送信先の最初の
    // 保存は拒む。観察の後の形の設定（テストの準備。保存の部品で直接）は、読み直すと送信先を読むだけで出し、送信先でない欄（成功の鍵）は入力の欄のまま。
    // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8。MI 4.7.1 の 6 の持ち越し。この場面の手で入れる手順を直した）: 入口の確かめの案がない
    // ときの既定の送り方は、送信先のない形（スクリプトの送信）。token の送信先・必須の query・ログインに伴う送信は、設定がないときも入力の欄を出さず、読むだけで出す。
    // 手で入れた送信先の最初の保存の拒否は、画面の保存の Server Function へ、前に欄で入れていた値を直接送って確かめる。
    it('shows the script login fields for a new setup, rejects the destination typed by hand, and shows the observed setup read-only after reopening', async () => {
      const page = await openAuthSetup(SCRIPT_PROFILE);
      // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章・3 章の 2。前はサイトの値の表に承認したサービスの Origin の一覧を出していた）: Origin の一覧は
      // 画面に出さない（プロファイルの値で確かめる）。
      expect(await page.getByTestId('auth-setup-service-origins').count()).toBe(0);
      expect((await authSetupPageOf(SCRIPT_PROFILE)).profile.approvedServiceOrigins).toContain(SERVICE_ORIGIN);
      // 既定はスクリプトの送信（送信先のない形）。フォームの送信先の欄はなく、スクリプトの欄が出る。
      expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
      await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
      // PL-4（同 3 章の 3。前は送信の method の固定と、token の送信先・必須の query・ログインに伴う送信を読むだけの値で出していた）: どれも出さない（直せない
      // 欄を見せない。入るのは手動のログインの観察からだけ）。入力の欄も、足すボタンもない。
      expect(await page.getByTestId('auth-setup-script-method').count()).toBe(0);
      for (const name of ['scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0']) {
        expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
      }
      // OP-DEF の 5: 足すボタンの文言はカタログから消した（使い先がない）。前の名前のボタンが出ないことは、今も確かめる。
      for (const label of REMOVED_ADD_BUTTON_LABELS) {
        expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
      }
      for (const testId of ['auth-setup-destination-script-origin', 'auth-setup-destination-script-path', 'auth-setup-destination-required-query',
        'auth-setup-destination-side-requests']) {
        expect(await page.getByTestId(testId).count(), testId).toBe(0);
      }
      // 送信先でない欄（成功の鍵）は、入力の欄のまま。
      expect(await field(page, scriptText.setup.storageOrigin).count()).toBe(1);
      await screenshot(page, 'd03-auth-setup-script-new');

      // 手で入れた送信先（前は欄で入れた値）の最初の保存は、画面の保存の Server Function でも拒む（入口の確かめの案がないので、送信先のない形だけを受ける）。
      const revision = (await authSetupPageOf(SCRIPT_PROFILE)).profile.revision;
      const observed = {
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        profileId: SCRIPT_PROFILE,
        profileRevision: revision,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [],
        successCondition: { pathPrefix: ADMIN_PATH, selector: null },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [LOGOUT_PATH],
        auditPathPrefixes: [],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [{ origin: SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', maxPerLoginStage: SIDE_COUNT }],
        successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
      };
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: observed })).toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_OBSERVED_ONLY' });
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored).toBeNull();

      // テストの準備: 手動のログインの観察の後の形の設定を、保存の部品で直接保存する。
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: observed })).toMatchObject({ ok: true });

      const reopened = await openAuthSetup(SCRIPT_PROFILE);
      // PL-4（同 3 章の 3。前は送り方と送信先を読むだけの値で出していた）: 変えられない送り方と送信先は出さない。値は、下の保存の後の設定が観察の値のままで
      // あることで確かめる。
      expect(await reopened.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).count()).toBe(0);
      expect(await reopened.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
      expect(await reopened.getByRole('main').innerText()).not.toContain(TOKEN_PATH);
      expect(await field(reopened, scriptText.setup.storageOrigin).inputValue()).toBe(TEST_ORIGIN);
      expect(await field(reopened, scriptText.setup.storagePrefix).inputValue()).toBe('app-');
      expect(await field(reopened, scriptText.setup.storageSuffix).inputValue()).toBe('-auth-token');
      // 送信先でない欄の保存は受け、保存した設定は版 3 のスクリプトの送信のまま。
      await saveSetup(reopened);
      await reopened.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toEqual(observed);
      await screenshot(reopened, 'd04-auth-setup-script-reopened');
    }, SCENARIO_TIMEOUT_MS);

    // MI-F5: 版 3 の誤りの表示は、欄を手で入れられる新しい設定（認証の設定のない別のプロファイル）で確かめる。検証の誤りは、送信先の確かめより先に返る。
    // PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: 必須の query とログインに伴う送信は、画面で手で入れなくなった（読むだけ）。その行の
    // 誤り（名前の空、token の送信先との重なり）の位置は、画面の保存の Server Function へ直接送って、検証の owner が返す項目と行で確かめる。
    it('puts the version 3 errors on their fields and lines, and saves nothing', async () => {
      const configPath = `config/targets/${ERRORS_PROFILE}.json`;
      expect(await createProfileInStore(rootOf().root, profileDocumentOf(ERRORS_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
      const fillScript = async (page: Page): Promise<void> => {
        // PL-S: 入口の確かめの案がないので、既定がスクリプトの送信（送信先のない形）。
        expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
        await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
        await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
        await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
        await field(page, authText.excludedPaths).fill(LOGOUT_PATH);
      };
      // 必須の query の名前が空、ログインに伴う送信が token の送信先と同じ（画面の保存の Server Function へ直接。何も保存しない）。
      const revision = (await authSetupPageOf(ERRORS_PROFILE)).profile.revision;
      expect(await valueOf('saveAuthSetupFn', 'POST', {
        setup: {
          schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
          profileId: ERRORS_PROFILE,
          profileRevision: revision,
          loginStartUrl: `${TEST_ORIGIN}/login`,
          loginPostEndpoints: [],
          successCondition: { pathPrefix: ADMIN_PATH, selector: null },
          sessionLostCondition: { pathPrefix: null },
          excludedPaths: [LOGOUT_PATH],
          auditPathPrefixes: [],
          maxLoginAttempts: 1,
          allowedIdpOrigins: [],
          automatedLogin: null,
          loginTransport: 'SCRIPT_REQUEST',
          scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: ' ', value: 'password' }] },
          loginSideRequests: [{ origin: SERVICE_ORIGIN, path: TOKEN_PATH, method: 'POST', maxPerLoginStage: 1 }],
          successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
        },
      })).toMatchObject({
        ok: false,
        reason: 'AUTH_SETUP_INVALID',
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'AUTH_SETUP_REQUIRED_QUERY_INVALID', field: 'requiredQuery', line: 1 }),
          expect.objectContaining({ code: 'AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED', field: 'loginSideRequests', line: 1 }),
        ]),
      });
      expect((await authSetupPageOf(ERRORS_PROFILE)).stored).toBeNull();

      // T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルでは、token の送信先が空でも、要る項目の欠けにならない（手動のログインの後に自動で
      // 登録される。自動ログインのプロファイルは今どおり欠けにする: `tests/unit/control-auth-setup-v3.test.ts`）。ここでは鍵の誤り（接頭辞と接尾辞が空）を入れて、
      // 保存させない。
      const second = await openAuthSetup(ERRORS_PROFILE);
      await fillScript(second);
      await field(second, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
      await saveSetup(second);
      expect(await second.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
      await expectFieldError(second, scriptText.setup.storageOrigin, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_STORAGE_KEY_INVALID);
      expect(await second.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBe(0);
      await screenshot(second, 'd05-auth-setup-script-errors');

      // フォームの送信を選び、送信先を空のまま保存すると、版 3 のフォームの送信の送信先の欠け（送信先の欄）。
      const third = await openAuthSetup(ERRORS_PROFILE);
      await third.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.FORM_NAVIGATION.label }).check();
      expect(await third.getByTestId('auth-setup-script').count()).toBe(0);
      await field(third, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
      await field(third, authText.successPathPrefix).fill(ADMIN_PATH);
      await field(third, authText.loginPostEndpoints).fill('');
      await saveSetup(third);
      await expectFieldError(third, authText.loginPostEndpoints, AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED);
      expect((await authSetupPageOf(ERRORS_PROFILE)).stored).toBeNull();
    }, SCENARIO_TIMEOUT_MS);

    // MI-F5: 送信先は読むだけなので、承認から外れた Origin の設定は、画面では選び直さない（誤りの文を出して保存しない）。直すのは観察（ここではテストの準備）。
    it('shows the saved origin that the profile no longer approves, and puts SERVICE_ORIGIN_NOT_APPROVED on it', async () => {
      const page = await authSetupPageOf(SCRIPT_PROFILE);
      const detail = await valueOf<{ profile: { targetConfigPath: string } }>('getProfileFn', 'GET', { profileId: SCRIPT_PROFILE });
      // テストだけの操作: プロファイルの承認したサービスの Origin から、保存した token の送信先の Origin を外す。
      expect(await valueOf('updateProfileFn', 'POST', {
        profile: profileDocumentOf(SCRIPT_PROFILE, detail.profile.targetConfigPath, page.profile.revision + 1, [OTHER_SERVICE_ORIGIN]),
        expectedRevision: page.profile.revision,
      })).toMatchObject({ ok: true });
      const screen = await openAuthSetup(SCRIPT_PROFILE);
      // PL-4: token の送信先は出さない（欄がないので、保存の誤りはフォームの上の知らせに、項目の名前つきで出す）。
      expect(await screen.getByTestId('auth-setup-destination-script-origin').count()).toBe(0);
      await saveSetup(screen);
      expect(await screen.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
      const rejectionNotice = await screen.locator('.notice', { has: screen.getByTestId('auth-setup-rejection') }).textContent();
      expect(rejectionNotice).toContain(`${scriptText.setup.scriptOrigin}: `);
      expect(rejectionNotice).toContain(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED);
      // テストの準備: 手動のログインで観察し直した形（承認している Origin への送信先）を、保存の部品で直接保存する。
      const current = (await authSetupPageOf(SCRIPT_PROFILE));
      expect(await saveAuthSetupRequestInStore(rootOf(), {
        setup: {
          ...current.stored?.setup,
          profileRevision: current.profile.revision,
          scriptLogin: { origin: OTHER_SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
          loginSideRequests: [{ origin: OTHER_SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', maxPerLoginStage: SIDE_COUNT }],
        },
      })).toMatchObject({ ok: true });
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toMatchObject({ scriptLogin: { origin: OTHER_SERVICE_ORIGIN } });
    }, SCENARIO_TIMEOUT_MS);

    it('rejects saving a version 2 setup, and saves a setup of the form navigation as version 3 (LG-3)', async () => {
      const configPath = `config/targets/${LEGACY_PROFILE}.json`;
      expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(LEGACY_PROFILE, configPath, 1, []) })).toMatchObject({ ok: true });
      // テストだけの操作: 版 2 の設定を保存しようとする（前の版の画面で保存したものの代わり）。保存の部品が形の誤りで拒む。
      const legacy = {
        schemaVersion: 'beaksight-auth-setup/2',
        profileId: LEGACY_PROFILE,
        profileRevision: 1,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
        successCondition: { pathPrefix: ADMIN_PATH, selector: '#menu' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [LOGOUT_PATH],
        auditPathPrefixes: [ADMIN_PATH],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: null,
      };
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: legacy })).toMatchObject({ ok: false });
      expect((await authSetupPageOf(LEGACY_PROFILE)).stored).toBeNull();
      // 同じ項目の版 3（フォームの送信）は保存でき（テストの準備。送信先は観察から入る）、画面はフォームの送信のまま開く（送信先は読むだけ）。
      const current = { ...legacy, schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, loginTransport: 'FORM_NAVIGATION', scriptLogin: null, loginSideRequests: [], successStorageKey: null };
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: current })).toMatchObject({ ok: true });
      const page = await openAuthSetup(LEGACY_PROFILE);
      // PL-4: 送り方とフォームの送信先は出さない（保存の後の設定が、そのままであることで確かめる）。
      expect(await page.getByTestId('auth-setup-destination-transport').count()).toBe(0);
      expect(await page.getByTestId('auth-setup-destination-post-endpoints').count()).toBe(0);
      expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
      await saveSetup(page);
      await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect((await authSetupPageOf(LEGACY_PROFILE)).stored?.setup).toEqual(current);
    }, SCENARIO_TIMEOUT_MS);

    // MI-F5: 必須の query は画面で手で入れないので、秘密に見える名前の query は、画面の保存の Server Function へ直接送って確かめる（検証が先に拒む）。
    it('rejects a secret-like query name, and the value is in no Server Function response nor in the control data', async () => {
      const stored = await authSetupPageOf(SCRIPT_PROFILE);
      const setup = stored.stored?.setup ?? {};
      expect(await valueOf('saveAuthSetupFn', 'POST', {
        setup: { ...setup, scriptLogin: { origin: OTHER_SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'client_secret', value: SECRET_MARKER }] } },
      })).toMatchObject({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: expect.arrayContaining([{ code: 'AUTH_SETUP_SECRET_LIKE_VALUE', field: 'requiredQuery', line: 1 }]) });
      const page = await openAuthSetup(SCRIPT_PROFILE);
      await authSetupPageOf(SCRIPT_PROFILE);
      await expect.poll(() => responseBodies.length, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
      expect(responseBodies.filter((body) => body.includes(SECRET_MARKER))).toEqual([]);
      expect(placesWithMarkers(databaseFilePlaces(resolveControlDatabasePath(rootOf().root)), [SECRET_MARKER])).toEqual([]);
      // 画面の HTML に、Cookie の値が出ない。
      const cookie = cookieOf();
      expect(await page.content()).not.toContain(cookie.slice(cookie.indexOf('=') + 1));
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('T34e: the requests blocked in the login stage on the job detail', () => {
    it('shows the table of the blocked requests, the counts, the hidden path, the unlisted requests and the guidance', async () => {
      const configPath = `config/targets/${JOB_PROFILE}.json`;
      // MI-F1（設計書 4.7.1 の 1）: 承認したサービスの Origin は、画面の作成の口では受けない。テストの準備は、保存の部品で直接作る。
      expect(await createProfileInStore(rootOf().root, profileDocumentOf(JOB_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
      const summary: AuditJobLoginStageSummary = {
        scriptLogin: {
          tokenRequestsAllowed: 1,
          sideRequestsAllowed: [SIDE_COUNT],
          serviceOriginReads: 3,
          blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [
            // T36R-fix（T36R の M-7）: 資格情報を含む要求を止めた数（2）は、止めた読み取りでない送信の数に足さず、独立の欄に出す。
            reason, reason === 'UNREGISTERED_NON_READ' ? 4 : reason === 'TOKEN_REQUEST_QUERY_MISMATCH' ? 1
              : reason === WORKER_LOGIN_CREDENTIAL_BLOCK_REASON ? CREDENTIAL_BLOCKED_COUNT : 0,
          ])) as NonNullable<AuditJobLoginStageSummary['scriptLogin']>['blockedByReason'],
        },
        blockedRequests: {
          requests: [
            { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 3 },
            { origin: SERVICE_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'TOKEN_REQUEST_QUERY_MISMATCH', count: 1 },
            { origin: SERVICE_ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, resourceType: 'document', reason: 'UNREGISTERED_NON_READ', count: 1 },
          ],
          unlisted: 1,
        },
      };
      // テストだけの操作: ログインの段で止まったジョブの行を書く（ワーカーの代わり）。
      const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
      try {
        expect(createStartingJob(database, {
          jobId: JOB_ID, jobKind: 'AUDIT', profileId: JOB_PROFILE, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT,
        }, () => null)).toEqual({ ok: true });
        expect(recordAuthState(database, JOB_ID, 'LOGIN_TIMEOUT', null, summary)).toBe(true);
        expect(recordEnded(database, JOB_ID, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: JOB_ENDED_AT })).toBe(true);
      } finally {
        closeControlDatabase(database);
      }

      const page = await openPage(`/jobs/${JOB_ID}`);
      // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2）: ログインの段の記録は、たたんだ詳しい内容の中。開いてから確かめる。
      await openAdvancedSettings(page, 'job-details', UI_TIMEOUT_MS);
      const panel = page.getByTestId('job-login-stage');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      const text = LOCAL_UI_LOGIN_STAGE_TEXT;
      expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
      // 表の見出しと行（Origin、パス、種類、理由、回数）。
      const table = panel.getByRole('table');
      // T43d（意図して直した期待。Task 43 の設計書 4.4）: query の名前の列と、登録の列（「登録する」か、手で入れる案内）を足した。
      const observedText = LOCAL_UI_LOGIN_OBSERVATION_TEXT;
      expect(await table.locator('thead th').allTextContents()).toEqual([
        text.columns.origin, text.columns.path, text.columns.resourceType, text.columns.reason, text.columns.count,
        observedText.columns.query, observedText.columns.register,
      ]);
      const rows = await table.locator('tbody tr').evaluateAll((elements) =>
        elements.map((element) => [...element.querySelectorAll('td')].map((cell) => cell.textContent ?? '')));
      expect(rows).toEqual([
        [SERVICE_ORIGIN, '/rest/v1/rpc/log_login', REQUEST_RESOURCE_TYPE_LABELS.fetch, LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ, formatTimes(3),
          // FM-1（意図して直した期待。手動の操作を減らす設計書 2.1）: 「登録する」はその場で保存するボタンになり、下書きのリンクは「認証の設定の画面で直す」。
          observedText.noQuery, `${observedText.register}${observedText.registerSideRequest}${LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT.editDraft}`],
        [SERVICE_ORIGIN, TOKEN_PATH, REQUEST_RESOURCE_TYPE_LABELS.fetch, LOGIN_STAGE_BLOCK_REASON_LABELS.TOKEN_REQUEST_QUERY_MISMATCH, formatTimes(1),
          observedText.noQuery, observedText.manualAlreadyRegistered],
        // 値に見える区切りを伏せた path は、伏せた旨を添える（登録の案は作らない）。
        [SERVICE_ORIGIN, `/session/${REDACTED_PATH_SEGMENT}${text.redactedPathNote}`, REQUEST_RESOURCE_TYPE_LABELS.document, LOGIN_STAGE_BLOCK_REASON_LABELS.UNREGISTERED_NON_READ,
          formatTimes(1), observedText.noQuery, observedText.manualRedactedPath],
      ]);
      expect(await panel.getByTestId('job-login-stage-unlisted').textContent()).toBe(text.unlisted(formatCount(1)));
      // 数のまとめ（スクリプトで送るログイン）。
      const counts = await panel.getByTestId('job-login-stage-counts').textContent();
      for (const part of [text.tokenRequestsAllowed, formatTimes(1), text.sideRequestsAllowed, formatTimes(SIDE_COUNT), text.serviceOriginReads,
        formatTimes(3), text.blockedTotal, formatTimes(5)]) {
        expect(counts).toContain(part);
      }
      // T36R-fix（T36R の M-7）: 「資格情報を含む要求を止めた数」は独立の欄（見出しと値の組）。
      const facts = await panel.getByTestId('job-login-stage-counts').evaluate((list) =>
        [...list.querySelectorAll('dt')].map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? '']));
      expect(facts).toContainEqual([text.credentialRequestsBlocked, formatTimes(CREDENTIAL_BLOCKED_COUNT)]);
      expect(facts).toContainEqual([text.blockedTotal, formatTimes(5)]);
      expect(await panel.getByTestId('job-login-stage-guidance').textContent()).toBe(text.guidance);
      expect(await panel.getByRole('link', { name: text.openSetup }).getAttribute('href')).toBe(`/auth-setup/${JOB_PROFILE}`);
      await screenshot(page, 'e01-job-login-stage-blocked');
    }, SCENARIO_TIMEOUT_MS);
  });

  // T35d（Task 35 の設計書 3.1）: スクリプトの送信のときだけ、監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限の欄が出る。
  describe('T35d: the audit stage items of the script login setup', () => {
    const auditText = LOCAL_UI_SPA_AUDIT_TEXT.setup;
    const READ_PATH = '/rest/v1/rpc/list_items';
    /** L11: 回数は数えないので、回数の欄は出さない。保存の値は、新しい行の初めの値（下限の 1）のまま。 */
    const READ_COUNT = 1;

    // L11 で直した: 承認したサービスへの要求の上限は撤廃したので、上限の欄は出さず、保存もしない。1 回の読み込みの回数の欄も出さない（回数は数えない）。
    it('saves the audit read requests without the service request limit fields (L11), and shows the same values after reopening', async () => {
      // T34d の場面の後の、項目のない設定（項目を足さない保存では、項目を持たない）。
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).not.toHaveProperty('auditReadRequests');
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).not.toHaveProperty('serviceRequestLimits');
      const page = await openAuthSetup(SCRIPT_PROFILE);
      await page.getByTestId('auth-setup-audit-reads').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('auth-setup-audit-reads').textContent()).toContain(auditText.auditReadsJudgement);
      await page.getByRole('button', { name: auditText.addRead }).click();
      await field(page, rowLabel(1, auditText.readOrigin)).selectOption(OTHER_SERVICE_ORIGIN);
      await field(page, rowLabel(1, auditText.readPath)).fill(READ_PATH);
      expect(await field(page, rowLabel(1, auditText.readMaxPerPageLoad)).count()).toBe(0);
      expect(await page.getByTestId('auth-setup-audit-read-row').first().textContent()).toContain(scriptText.setup.methodFixedValue);
      expect(await field(page, auditText.perMinute).count()).toBe(0);
      expect(await field(page, auditText.perRun).count()).toBe(0);
      await screenshot(page, 'e01-auth-setup-audit-reads');
      await saveSetup(page);
      await page.getByTestId('auth-setup-saved').waitFor({ timeout: UI_TIMEOUT_MS });
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).toMatchObject({
        auditReadRequests: [{ origin: OTHER_SERVICE_ORIGIN, path: READ_PATH, method: 'POST', maxPerPageLoad: READ_COUNT }],
      });
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.setup).not.toHaveProperty('serviceRequestLimits');
      const reopened = await openAuthSetup(SCRIPT_PROFILE);
      expect(await field(reopened, rowLabel(1, auditText.readOrigin)).inputValue()).toBe(OTHER_SERVICE_ORIGIN);
      expect(await field(reopened, rowLabel(1, auditText.readPath)).inputValue()).toBe(READ_PATH);
    }, SCENARIO_TIMEOUT_MS);

    // L11 で直した: 上限の欄はなくなったので、上限の範囲の誤りの確かめは捨て、重なりの誤りだけを確かめる。
    it('puts the duplicated read on its field, and saves nothing', async () => {
      const before = (await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt;
      const page = await openAuthSetup(SCRIPT_PROFILE);
      await page.getByRole('button', { name: auditText.addRead }).click();
      await field(page, rowLabel(2, auditText.readOrigin)).selectOption(OTHER_SERVICE_ORIGIN);
      await field(page, rowLabel(2, auditText.readPath)).fill(READ_PATH);
      await saveSetup(page);
      await expectGroupError(page, 'auth-setup-audit-reads',
        `${authText.lineText('2')}: ${AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED}`);
      await screenshot(page, 'e02-auth-setup-audit-reads-errors');
      expect((await authSetupPageOf(SCRIPT_PROFILE)).stored?.updatedAt).toBe(before);
    }, SCENARIO_TIMEOUT_MS);

    // MI-F5: 認証の設定があるときは送り方を読むだけなので、フォームの送信の設定のプロファイル（版 2 の場面の後）で確かめる。
    it('does not show the audit stage items for the form navigation', async () => {
      const page = await openAuthSetup(LEGACY_PROFILE);
      // PL-4: 送り方は出さない（フォームの送信の設定であることは、保存した設定で確かめる）。
      expect((await authSetupPageOf(LEGACY_PROFILE)).stored?.setup).toMatchObject({ loginTransport: 'FORM_NAVIGATION' });
      expect(await page.getByTestId('auth-setup-audit-reads').count()).toBe(0);
      expect(await field(page, auditText.perMinute).count()).toBe(0);
      expect(await field(page, auditText.perRun).count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);
  });

  describe('T36a: the login transport of an automated login profile', () => {
    it('lets an automated login profile choose the script login, and saves it as version 3 with the automated login settings', async () => {
      const configPath = `config/targets/${AUTO_PROFILE}.json`;
      // MI-C2 項目 16・MI-F1（設計書 4.7.1 の 1・2）: 承認したサービスの Origin つきのプロファイルと、自動ログインのプロファイルは、画面の作成・編集の口では
      // 作れない（Origin は手動のログインの観察が足し、自動ログインへは切り替えだけで入る）。テストの準備は、手動のログインのプロファイルを保存の部品で作り
      // （承認したサービスの Origin は、手動のログインの観察の代わりにテストが入れる）、保存の部品で自動ログインに更新する（Origin は足さない）。
      expect(await createProfileInStore(rootOf().root, profileDocumentOf(AUTO_PROFILE, configPath, 1, [SERVICE_ORIGIN]))).toMatchObject({ ok: true });
      const profile = { ...profileDocumentOf(AUTO_PROFILE, configPath, 2, [SERVICE_ORIGIN]), auth: 'AUTOMATED_LOGIN' };
      expect(await updateProfileInStore(rootOf().root, profile, 1)).toMatchObject({ ok: true });
      const page = await openAuthSetup(AUTO_PROFILE);
      // 自動ログインの欄と、ログインの送り方の欄の両方がある。PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8）: 入口の確かめの案がないので、
      // 既定はスクリプトの送信（送信先のない形）。token の送信先と必須の query は、読むだけ（手で入れない）。
      await page.getByTestId('auth-setup-automated').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('auth-setup-transport').count()).toBe(1);
      expect(await page.getByRole('radio', { name: LOGIN_TRANSPORT_CATALOG.SCRIPT_REQUEST.label }).isChecked()).toBe(true);
      await page.getByTestId('auth-setup-script').waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await field(page, authText.loginPostEndpoints).count()).toBe(0);
      expect(await page.locator('[name="scriptOrigin"], [name="scriptPath"]').count()).toBe(0);

      await field(page, authText.loginStartUrl).fill(`${TEST_ORIGIN}/login`);
      await field(page, authText.successPathPrefix).fill(ADMIN_PATH);
      await field(page, scriptText.setup.storageOrigin).selectOption(TEST_ORIGIN);
      await field(page, scriptText.setup.storagePrefix).fill('app-');
      await field(page, scriptText.setup.storageSuffix).fill('-auth-token');
      await field(page, authText.usernameSelector).fill('#email');
      await field(page, authText.passwordSelector).fill('#password');
      await field(page, authText.submitSelector).fill('#login');
      await screenshot(page, 'e02-auth-setup-automated-script');
      // 設定のない自動ログインのプロファイル（MI より前の形）の画面の最初の保存は、自動ログインに要る token の送信先がないので、検証が拒む（何も保存しない。
      // token の送信先は観察からだけ入る）。
      await saveSetup(page);
      expect(await page.getByTestId('auth-setup-rejection').getAttribute('data-reason')).toBe('AUTH_SETUP_INVALID');
      expect(await page.getByText(AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS.AUTH_SETUP_SCRIPT_LOGIN_REQUIRED).count()).toBeGreaterThan(0);
      expect((await authSetupPageOf(AUTO_PROFILE)).stored).toBeNull();

      // テストの準備: 切り替えの後の形の設定（自動ログインの設定を持つ版 3 のスクリプトの送信）を、保存の部品で直接保存する。
      const observed = {
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        profileId: AUTO_PROFILE,
        profileRevision: 2,
        loginStartUrl: `${TEST_ORIGIN}/login`,
        loginPostEndpoints: [],
        successCondition: { pathPrefix: ADMIN_PATH, selector: null },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [],
        auditPathPrefixes: [],
        maxLoginAttempts: 1,
        allowedIdpOrigins: [],
        automatedLogin: {
          usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
          failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
        },
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [],
        successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
      };
      // MI-F5（設計書 4.7.1 の 6）: 手で入れた送信先（前は欄で入れた値）の最初の保存は、画面の保存の Server Function でも拒む（設定のない自動ログインのプロファイルを含む）。
      expect(await valueOf('saveAuthSetupFn', 'POST', { setup: observed })).toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_OBSERVED_ONLY' });
      expect((await authSetupPageOf(AUTO_PROFILE)).stored).toBeNull();
      expect(await saveAuthSetupRequestInStore(rootOf(), { setup: observed })).toMatchObject({ ok: true });

      expect((await authSetupPageOf(AUTO_PROFILE)).stored?.setup).toMatchObject({
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        loginTransport: 'SCRIPT_REQUEST',
        loginPostEndpoints: [],
        maxLoginAttempts: 1,
        scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
        automatedLogin: { usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login' },
      });
      const reopened = await openAuthSetup(AUTO_PROFILE);
      // MI-F5・PL-4: 認証の設定があるときは、送り方と自動ログインのセレクタも変えられないので出さない（値は上の保存した設定で確かめた）。
      expect(await reopened.getByTestId('auth-setup-destination-transport').count()).toBe(0);
      expect(await reopened.getByTestId('auth-setup-destination-password-selector').count()).toBe(0);
      expect(await reopened.locator('input[name="passwordSelector"]').count()).toBe(0);
    }, SCENARIO_TIMEOUT_MS);
  });
});

/**
 * DEF-146: ジョブの画面の「監査を止める」の確認のダイアログで「止める」を押した後に、止める要求の結果を必ず画面に出すことを確かめる。
 * - 発見のジョブ（`DISCOVERY`）でも、ボタンとダイアログが出て、「止める」が Server Function（`stopAuditJobFn`）を呼ぶ。ジョブの管理が拒んだ理由
 *   （このテストの行はこの画面のサーバのものではないので `JOB_NOT_OWNED`）を出し、ダイアログを閉じる。
 * - Server Function の呼び出しが例外で終わる（通信の誤り、入力の検証の誤りの 400）・結果の形でない値で終わるときも、何も出さずに消えず、要求の誤りを
 *   出してダイアログを閉じ、もう一度押せる。誤りは、画面が送る止める要求を、テストだけの操作（`page.route`）で止める・差し替えて起こす。
 * - 画面のサーバが落ちた後（テストだけの操作で止める）に押したときも、要求の誤りを出す。
 * - DEF-146 の 2 回目: 確認のダイアログの題と確定のボタンは、ジョブの種類に合わせた呼び名（発見のジョブは「発見を止めますか」「発見を止める」）で、
 *   取り消しは「止めずに戻る」（「やめる」と読み違えない）。文言はカタログ（`AUDIT_JOB_STOP_TARGET_NAMES`、`LOCAL_UI_AUDIT_TEXT.stopDialog`）。
 * - T44d（Task 44 の設計書 P2-3）: ダイアログの本文（`AUDIT_JOB_STOP_DIALOG_BODIES`）と、ジョブの画面の大きい止めるボタン（「発見を止める」）も、
 *   ジョブの種類に合わせる。止める要求を送った後の文（`AUDIT_JOB_STOP_REQUESTED_TEXTS`）も、種類ごと（発見は「次の画面を読まずに止まります」）。
 * 値は匿名（ループバック）。
 * 束: 最後の場面で画面のサーバを落とし、動いている発見のジョブの行を残すので、この describe は束の最後に置く（後の describe はない）。
 */
describe('job-stop-ui: DEF-146 the result of the stop on the job screen of a discovery job', () => {
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

  const text = LOCAL_UI_AUDIT_TEXT;
  /** 発見のジョブの、止める確認のダイアログの呼び名。 */
  const DISCOVERY_TARGET = AUDIT_JOB_STOP_TARGET_NAMES.DISCOVERY;
  /** 前の取り消しのボタンの文言（「止める」と読み違えた。DEF-146）。 */
  const AMBIGUOUS_CANCEL_LABEL = 'やめる';

  /** サーバの準備と Server Function の呼び出し（`helpers/ui-server.ts`）。 */
  const { started, rootOf, contextOf, idsOf, valueOf, setUp, tearDown } = sharedUiServerKitOf(serverKit);

  const { openPage, screenshot, expectCleanAndClosePages, takeConsoleErrors } = createUiPageKit({
    contextOf,
    originOf: () => started().origin,
    maxTabPresses: MAX_TAB_PRESSES,
    screenshotDirectory: process.env['DEF146_SCREENSHOT_DIR'],
  });

  /** 画面が送る、止める要求か（`page.route` の判定）。 */
  const isStopRequest = (url: URL): boolean => isServerFunctionUrlOf(idsOf(), 'stopAuditJobFn', url);

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
    const targetConfigPath = await setUp((root) =>
      writeAuditTargetConfig(root.root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false }));
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    writeRunningDiscoveryJob(JOB_ID, RUN_ID);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    await expectCleanAndClosePages();
  });

  afterAll(async () => {
    await tearDown();
  });

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
    expect(text.stopDialog.title(DISCOVERY_TARGET)).toBe('操作さがしを止めますか');
    // T44d: 本文は発見のもの（再開しない）。監査の本文（今のページの監査を終えてから止まり、続きから再開する）は出さない。
    const dialogText = await dialog.textContent();
    expect(dialogText).toContain(AUDIT_JOB_STOP_DIALOG_BODIES.DISCOVERY.stop);
    expect(dialogText).not.toContain(AUDIT_JOB_STOP_DIALOG_BODIES.AUDIT.stop);
    expect(dialogText).not.toContain('続きから再開');
    expect(await dialog.getByRole('button').allTextContents()).toEqual([text.stopDialog.cancel, text.stopDialog.confirm(DISCOVERY_TARGET)]);
    expect(text.stopDialog.confirm(DISCOVERY_TARGET)).toBe('操作さがしを止める');
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
    // テストだけの操作: 画面のサーバを落とす（ページは開いたまま）。束: 束の最後の場面（この後にサーバを使う場面はない）。
    await stopServer(started());
    const { dialog, stopButton } = await pressStop(page);
    await expectRequestFailed(page, dialog, stopButton, 'server gone');
    await screenshot(page, 'def146-03-server-gone');
    await page.close();
    expect(takeConsoleErrors(page, LOAD_FAILURE_PATTERN).length).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT_MS);
});
