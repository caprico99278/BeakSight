/**
 * T44e（Task 44 の設計書 P2-4。設計の変更の履歴の T44e の行の (2)）: 書き込みのジョブが送る前の確かめで送らずに止めた（`PRECHECK_FAILED`）とき、
 * `action-run.json` の具体的な理由（`precheckDetail`。台帳が知る保つ鍵の値と違う、など）と次にできることを、ジョブの画面に出す。ビルドした画面のサーバ
 * （一時の root）と headless の Chromium で確かめる。ジョブの行と `action-run.json` は、テストだけの操作で書く（ワーカーの代わり。サイトへは接続しない）。
 * 理由のない前の記録（項目なし）と、送る中身の照合で止めた記録（`PAYLOAD_MISMATCH`）には、欄を出さない。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { PRECHECK_FAILURE_DETAIL_DESCRIPTIONS } from '../../../src/presentation/messages.js';
import { blockedDocuments } from '../../../tests/helpers/action-report-samples.js';
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

const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
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
  root = createTemporaryUiRoot('built');
  const target = writeAuthTargetConfig(root.root, PROFILE_ID, TEST_ORIGIN, '/admin', 1);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  const created = await callServerFunction({ port: server.port, origin: server.origin, cookie, ids }, 'createProfileFn', 'POST', {
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

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('T44e: the concrete reason of a write stopped before sending', () => {
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
