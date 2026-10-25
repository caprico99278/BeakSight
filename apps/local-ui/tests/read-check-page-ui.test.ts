/**
 * T37d（Task 37 の設計書 3.5）: READ の確かめの画面の、画面の path を読む定義の作成と、結果の表示。
 * - 定義の作成で「候補を読む」と「画面を読む」を選べる。「画面を読む」は、画面の path の欄と、直近の発見の結果の画面（読めた画面）から選ぶ一覧。発見の
 *   結果を読めなければ、一覧を出さずに入力だけ。
 * - 保存の検証の誤り（正規の形でない path、危険な語）は、理由を path の欄と上のお知らせに出し、保存しない。
 * - 結果の表に、対象の種類と画面の path、判定できない詳しい理由（`SERVICE_READ_REFUSED`）を出す。
 * ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で開く。発見と READ の確かめの
 * ジョブの行と成果物は、テストだけの操作で書く（ワーカーの代わり）。テストの値は匿名（テスト環境の Origin はループバック。接続しない）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recordDiscoveryCandidates } from '../../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordFinished, recordNotice, recordRunStarted } from '../../../src/control/job/job-store.js';
import type { WorkerRunNotice } from '../../../src/control/worker-protocol.js';
import { formatDuration } from '../../../src/presentation/format.js';
import { recordReadCheckResults } from '../../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/discovery-result.js';
import { READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/read-check-evaluation.js';
import { DISCOVERY_END_REASON_CATALOG, READ_CHECK_END_REASON_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_READ_CHECK_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  READ_CHECK_DETAIL_DESCRIPTIONS,
  READ_CHECK_TARGET_KIND_LABELS,
  siteUnavailableRecheckText,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const MAX_PAGES = 3;
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

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root;
};

const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(200);
  return result.value as T;
};

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
  root = createTemporaryUiRoot('built');
  const target = writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
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

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('T37d: the READ check definitions of a page path on the local UI', () => {
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
      endReason: 'COMPLETED',
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
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
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
      runStatus: 'PARTIAL', endReason: 'SITE_UNAVAILABLE',
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
    await job.waitFor({ timeout: UI_TIMEOUT_MS });
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
      runStatus: 'PARTIAL', endReason: 'MAX_RUNTIME_REACHED',
      checks: [{
        readCheckId: definition.readCheckId, readCheckRevision: definition.revision, targetKind: 'PAGE', targetPagePath: DETAIL_PATH, state: 'NOT_EXECUTED',
        reason: 'MAX_RUNTIME_REACHED',
      }],
    });
    const readPage = await openPage(`/read-checks/${PROFILE_ID}`);
    const job = readPage.locator(`[data-testid="read-check-job"][data-job-id="${jobId}"]`);
    await job.waitFor({ timeout: UI_TIMEOUT_MS });
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
