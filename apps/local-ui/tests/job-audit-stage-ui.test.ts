/**
 * T37a（Task 37 の設計書 3.1）: ジョブの詳細の画面に、発見と READ の確かめのジョブの監査の段の数（成果物 `discovery.json`・`read-evidence.json` の任意の
 * 項目 `authentication`。`run.json` と同じ形）を、ログインの段の要約と並べて出す。
 * - 管理データには保存しない（版を上げない）。画面のサーバは、成果物を、スキーマとジョブの ID を確かめる読み出し（`readJobResultDocument`）で読む。
 *   終わった（`FINISHED`）ジョブだけ出す。
 * - 数がない（監査の段の口のない）ジョブには、欄を出さない。
 * - DEF-141: 1 分あたりの上限で待った回数と時間の合計を欄に足し、待つ間の知らせを進みの欄に出す。
 * ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で開く。ジョブの行と成果物は、
 * テストだけの操作で書く（ワーカーの代わり）。テストの値は匿名（テスト環境の Origin はループバック。接続しない）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStartingJob, recordFinished, recordNotice, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import type { RunAuthenticationSummary } from '../../../src/core/contracts.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/discovery-result.js';
import { READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION } from '../../../src/discovery/read-check-evaluation.js';
import { formatCount, formatDuration, formatTimes } from '../../../src/presentation/format.js';
import {
  JOB_SAFETY_VIOLATION_STAGE_LABELS,
  LOCAL_UI_AUDIT_STAGE_TEXT,
  LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT,
  LOCAL_UI_PRESS_LIMIT_PROBE_TEXT,
  LOCAL_UI_SAFETY_VIOLATION_TEXT,
  serviceRequestPacingWaitText,
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
    : ['read-evidence.json', { schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, ...base, endReason: 'SERVICE_REQUEST_LIMIT_REACHED', checks: [], ...extra }];
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

describe('T37a: the counts of the audit stage on the job detail of the discovery and READ check jobs', () => {
  const text = LOCAL_UI_AUDIT_STAGE_TEXT;

  for (const [jobKind, jobId, runId] of [
    ['DISCOVERY', 'job-t37a-discovery', 'RUN-20261017010001'],
    ['READ_CHECK', 'job-t37a-read-check', 'RUN-20261017010002'],
  ] as const) {
    it(`shows the counts of the ${jobKind} job from its artifact`, async () => {
      writeFinishedJob(jobId, jobKind, runId, SUMMARY);
      const page = await openPage(`/jobs/${jobId}`);
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
      expect(await panel.getByRole('heading', { name: text.heading }).count()).toBe(1);
      expect(await panel.getByTestId('job-safety-violation-stage').textContent())
        .toBe(JOB_SAFETY_VIOLATION_STAGE_LABELS[jobKind === 'DISCOVERY' ? 'SUBMISSION_PROBE' : 'PAGE_LOAD']);
      expect(await panel.getByTestId('job-safety-violation-page').textContent()).toBe('/admin/staff');
      expect(await panel.getByTestId('job-safety-violation-count').textContent()).toBe(formatCount(3));
      if (jobKind === 'DISCOVERY') {
        expect(await panel.getByTestId('job-safety-violation-press-words').textContent()).toBe('保存');
        expect(await panel.getByTestId('job-safety-violation-press-identity').textContent()).toBe(IDENTITY_DIGEST);
      } else {
        expect(await panel.getByTestId('job-safety-violation-press-words').count()).toBe(0);
      }
      const rows = await panel.getByTestId('job-safety-violation-list').evaluate((table) =>
        [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')));
      expect(rows).toEqual([
        ['PASSIVE_GUARD_PAGE_NOT_READY', 'Navigation started before explicit page readiness', 'GET', TEST_ORIGIN, '/admin/staff/1/edit'],
        ['GUARD_TASK_LIMIT_REACHED', 'requestfailed callback', text.noRequest],
      ]);
      // 一覧に載せなかった違反の数（数は全体）。
      expect(await panel.getByTestId('job-safety-violation-omitted').textContent()).toBe(text.omittedText(formatCount(1)));
      await screenshot(page, `def144-${jobKind.toLowerCase()}-safety-violation`);
    }, SCENARIO_TIMEOUT_MS);
  }

  // DEF-144 の後半（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 発見のジョブの、外部のアプリへ移るので押さなかったボタンの数と、
  // 読み込み直した画面の数（成果物の `externalSchemeProbes`）。
  it('shows the buttons not pressed for an external scheme and the reloaded pages of a discovery job', async () => {
    const probeText = LOCAL_UI_EXTERNAL_SCHEME_PROBE_TEXT;
    writeFinishedJob('job-def144-external-scheme', 'DISCOVERY', 'RUN-20261017010008', null, { externalSchemeProbes: { notPressed: 2, reloadedPages: 1 } });
    const page = await openPage('/jobs/job-def144-external-scheme');
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

  // T44c（Task 44 の設計書 P1-3）: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数（成果物の `pressLimitProbes`）。
  it('shows the buttons with a create or update word not pressed because of the press limit of a discovery job (T44c)', async () => {
    const limitText = LOCAL_UI_PRESS_LIMIT_PROBE_TEXT;
    writeFinishedJob('job-t44c-press-limit', 'DISCOVERY', 'RUN-20261021010009', null, { pressLimitProbes: { priorityNotPressed: 4 } });
    const page = await openPage('/jobs/job-t44c-press-limit');
    const panel = page.getByTestId('job-press-limit-probes');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('heading', { name: limitText.heading }).count()).toBe(1);
    expect(await panel.getByText(limitText.body).count()).toBe(1);
    expect(await panel.getByTestId('job-press-limit-priority-not-pressed').textContent()).toBe(formatCount(4));
  }, SCENARIO_TIMEOUT_MS);
});
