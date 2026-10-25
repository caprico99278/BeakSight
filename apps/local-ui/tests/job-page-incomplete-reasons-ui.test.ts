/**
 * T44c（Task 44 の設計書 P1-4。設計者の判断）: 監査のジョブの詳細の画面に、`run.json` の任意の項目 `pageIncompleteReasonCounts`（ページの未完了の理由ごとの
 * ページ数）を、理由の説明（表示カタログ）と次にできること（レポートと同じ文）と並べて出す。項目のない Run（理由を持つページのない Run と、前の書き手の
 * Run）には欄を出さない。
 * ビルドした画面を一時の root の起動の部品で起動し、headless の Chromium で開く。ジョブの行と `run.json` は、テストだけの操作で書く（ワーカーは起動しない。
 * サイトへは接続しない）。値は匿名（ループバック）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { PageIncompleteReasonCount, RunSummary } from '../../../src/core/contracts.js';
import { createRunId } from '../../../src/core/ids.js';
import { formatCount } from '../../../src/presentation/format.js';
import {
  INCOMPLETE_REASON_DESCRIPTIONS,
  INCOMPLETE_REASON_NEXT_STEPS,
  LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT,
} from '../../../src/presentation/messages.js';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const PROFILE_ID = 't44c-reasons';
const CREATED_AT = '20261021020000';
const STARTED_AT = '20261021020001';
const FINISHED_AT = '20261021020100';
const STATUS_OK = 200;
const INNER_SCROLL = 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED';
const COUNTS: readonly PageIncompleteReasonCount[] = Object.freeze([
  { code: 'COLLECTOR_INCOMPLETE', pages: 2 },
  { code: INNER_SCROLL, pages: 9 },
]);

const text = LOCAL_UI_PAGE_INCOMPLETE_REASON_TEXT;

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

const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: process.env['T44C_SCREENSHOT_DIR'],
});

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, name).toBe(STATUS_OK);
  return result.value as T;
};

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
  writeFinishedAuditJob('job-t44c-reasons', 1, COUNTS);
  writeFinishedAuditJob('job-t44c-no-reasons', 2, null);
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

describe('T44c: the page incomplete reasons of an audit job', () => {
  it('shows the number of the pages for each reason with its description and the next step (the same text as the report)', async () => {
    const page = await openPage('/jobs/job-t44c-reasons');
    const panel = page.getByTestId('job-page-incomplete-reasons');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
    const rows = await panel.getByTestId('job-page-incomplete-reason-list').evaluate((table) =>
      [...table.querySelectorAll('tbody tr')].map((row) => [row.getAttribute('data-code') ?? '', ...[...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')]));
    expect(rows).toEqual([
      ['COLLECTOR_INCOMPLETE', `${INCOMPLETE_REASON_DESCRIPTIONS.COLLECTOR_INCOMPLETE} COLLECTOR_INCOMPLETE`, formatCount(2), INCOMPLETE_REASON_NEXT_STEPS.COLLECTOR_INCOMPLETE],
      [INNER_SCROLL, `${INCOMPLETE_REASON_DESCRIPTIONS[INNER_SCROLL]} ${INNER_SCROLL}`, formatCount(9), INCOMPLETE_REASON_NEXT_STEPS[INNER_SCROLL]],
    ]);
    // 画面のサーバが返す値も、数と理由のコードだけ。
    const detail = await valueOf<{ pageIncompleteReasons: unknown }>('getAuditJobFn', 'GET', { jobId: 'job-t44c-reasons' });
    expect(detail.pageIncompleteReasons).toEqual(COUNTS);
  }, SCENARIO_TIMEOUT_MS);

  it('shows nothing for a Run without the item', async () => {
    const page = await openPage('/jobs/job-t44c-no-reasons');
    await page.getByTestId('job-run-status').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('job-page-incomplete-reasons').count()).toBe(0);
    expect((await valueOf<{ pageIncompleteReasons: unknown }>('getAuditJobFn', 'GET', { jobId: 'job-t44c-no-reasons' })).pageIncompleteReasons).toBeNull();
  }, SCENARIO_TIMEOUT_MS);
});
