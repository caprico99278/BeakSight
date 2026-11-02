/**
 * PL-5（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 5・6、6 章の 7、7 章、11 章の 1〜4）: 書き込みのステップの画面の形を、
 * ビルドした画面のサーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。監査のワーカーは偽のワーカー（`discovery`。
 * サイトに接続しない）で、最後の発見のジョブ（API の登録と書き換えの形を持つ候補）を作る（`scenario-autodraft-ui.test.ts` と同じ作り）。
 * - どの画面のどの状態でも、main の主のボタンは 1 つまで（`expectAtMostOnePrimaryButton`）、アクセシビリティの違反 0（`axeViolationsOf`）。
 * - 操作さがし: 要点は「書き込める操作が N 件見つかりました」と主のボタン「書き込みの手順を作る」。押せないボタン・候補の種類・送信先・ドリフト・分類の
 *   理由・欄の型は出さない（詳しい内容にも出さない）。
 * - 書き込みの手順: 要点の主のボタンは状態で 1 つ（「書き込みの OK」か「書き込みを始める」）。要求の形・検証の指定・版・digest・ID は出さない。
 * - 書き込みの OK と開始のダイアログ: 何を・どこへ・何件、4 つの約束（7 章）。OP-2 の修正の 1 回目（D6）: 隔離の注意は出さない。
 * - OP-2 の修正の 1 回目（指示書の 6）: サイトの画面の「登録・更新を試せる画面」の一覧（`WriteScreenList`）。主のボタンは 1 つまで、axe の違反 0、チェックの保存の
 *   Server Function（入れる・外す・試せない行）、画面の名前（操作さがしの見出し）、メールなどを送ることがある行の 1 行、秘密の目印が出ないこと。
 * - 人の入力なしに（押すだけで）、操作さがし → 書き込みの手順を作る → OK → 書き込みを始める（確認のダイアログ）まで進む（押下の数を数える）。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../../src/control/approval-external-facts.js';
import { listScenarios, revokeScenarioApproval } from '../../../src/control/approval/scenario-store.js';
import { approveForCheck } from '../../../src/control/approval/update-autodraft.js';
import { getProfile } from '../../../src/control/store/profile-store.js';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { listReadChecks } from '../../../src/control/job/read-check-store.js';
import { pageArtifactRelativePath } from '../../../src/core/artifact-layout.js';
import { WORKER_AUDIT_JOB_KIND } from '../../../src/core/audit-job-values.js';
import type { RunId } from '../../../src/core/contracts.js';
import { createPageId } from '../../../src/core/ids.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { apiRequestShapeOf } from '../../../src/core/api-request-shape.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../../src/discovery/fingerprint.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../../src/discovery/submission-probe-contracts.js';
import {
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_SCREENS_TEXT,
  LOCAL_UI_WRITE_STAGE_TEXT,
  LOCAL_UI_WRITE_TEXT,
} from '../../../src/presentation/messages.js';
import { formatCount, formatInteger } from '../../../src/presentation/format.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { NO_JS_BINDING, sampleAction, sampleButton, sampleField, sampleForm } from '../../../tests/unit/discovery-candidate-samples.js';
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
import { callServerFunction, readServerFunctionIds, type ServerFunctionCall } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';
import { createProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { createUiPageKit } from './helpers/ui-page.ts';
import { READ_CHECK_ADVANCED_SETTINGS } from './helpers/advanced-settings.ts';
import { ISOLATION_NOTICE_FRAGMENT, axeViolationsOf, backLinkCountInMain, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { isolationUnverifiedEvidenceRefOf } from '../src/server/isolation-evidence-ref';
import { writeScreenNotCheckableKindOf } from '../src/display/write-screen-values';
import type { ScenarioDraftRejectionReason } from '../../../src/core/scenario-draft-rejection-reasons.js';

const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });
const WAIT_LIMIT_MS = 60_000;
const WAIT_POLL_MS = 200;
const PROCESS_EXIT_LIMIT_MS = 20_000;
const UI_TIMEOUT_MS = 15_000;
const MAX_TAB_PRESSES = 200;
const FAKE_HEARTBEAT_INTERVAL_MS = 200;
const FAKE_RUN_ID = 'RUN-20261022000000';
const OTHER_RUN_ID = 'RUN-20261022000999';
const ORIGIN = 'http://127.0.0.1:4173';
const API_SERVICE_ORIGIN = 'https://api.example.invalid';
const PROFILE_ID = 'pl5-screens';
const OUTPUT = 'pl5-screens-output';
const FIRST_REVISION = 1;
const SCREENSHOT_DIRECTORY = process.env['PL5_SCREENSHOT_DIR'];
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
/** probe の目印（値。シナリオと画面には出ない）。 */
const MARKERS = ['bsprobe0000000000fm2a', 'bsprobe0000000000fm2b@example.invalid'];
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
/** 読めた会員の詳しい画面（照合の READ の `{id}` の型を推す元）。 */
const DETAIL_PATH = '/admin/members/12';
const SIDE_EFFECTS = ['TEST_RECORDS_ONLY', 'NO_EXTERNAL_NOTIFICATION', 'NO_PAYMENT_OR_EXTERNAL_SERVICE', 'NOT_DESTRUCTIVE'] as const;

const text = LOCAL_UI_AUTO_DRAFT_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];
const state = { createId: '', targetPath: '' };

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
const call = (name: string, method: 'GET' | 'POST', data?: unknown): Promise<ServerFunctionCall> =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 300)}`).toBe(STATUS.OK);
  return result.value as T;
};
const withControlData = <T>(use: (database: ControlDatabase) => T): T => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    return use(database);
  } finally {
    closeControlDatabase(database);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// 候補と成果物（分類と指紋は本物の部品で求める）
// ---------------------------------------------------------------------------------------------------------------

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: new Set([ORIGIN]) }),
  ...computeCandidateDigests(discovered),
});
/** probe で入れた欄（名前と目印の番号を持つものだけを使う）。 */
type ProbeFieldSample = SubmissionProbeInputField & { readonly name: string; readonly marker: number };
/** 登録と更新の画面の、送る欄（名前とメール）。 */
const BASE_SENT_FIELDS: readonly ProbeFieldSample[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];
/** API の形のボタン（`fields` は probe で入れて本文に送った欄、`markers` は probe の目印）。 */
const apiButtonWithFieldsOf = (
  pagePath: string,
  method: 'POST' | 'PATCH',
  query: string,
  fields: readonly ProbeFieldSample[],
  markers: readonly string[],
): DiscoveryCandidate => {
  const shape = apiRequestShapeOf({
    method,
    resourceType: 'fetch',
    url: `${API_SERVICE_ORIGIN}/rest/v1/members?${query}`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: { kind: 'TEXT', text: JSON.stringify(Object.fromEntries(fields.map(({ name, marker }) => [name, markers[marker]]))) },
  }, { pagePath, markers: [...markers] });
  return {
    ...candidateOf(sampleButton({ page: { origin: ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
    submissionProbe: observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
      { filledFieldCount: fields.length, skippedFieldCount: 0 }, fields.map((field) => ({ ...field }))),
  };
};
const apiButtonOf = (pagePath: string, method: 'POST' | 'PATCH', query: string): DiscoveryCandidate =>
  apiButtonWithFieldsOf(pagePath, method, query, BASE_SENT_FIELDS, MARKERS);
const CREATE = apiButtonOf(NEW_PATH, 'POST', 'select=*');
const UPDATE = apiButtonOf(EDIT_PATH, 'PATCH', 'id=eq.1&select=*');

const documentOf = (): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: FAKE_RUN_ID,
  startedAt: '20261022000000',
  finishedAt: '20261022000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [
    ...[CREATE, UPDATE].map((candidate) => ({
      url: `${candidate.page.origin}${candidate.page.path}`,
      state: 'READ' as const,
      record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
      blockedRequests: 0,
    })),
    { url: `${ORIGIN}${DETAIL_PATH}`, state: 'READ' as const, record: { location: { origin: ORIGIN, path: DETAIL_PATH }, incompleteReasons: [], candidates: [] }, blockedRequests: 0 },
  ],
  omittedUnreadPages: 0,
});

const installFakeDiscovery = (document: DiscoveryDocument = documentOf()): void => {
  const directory = `${rootOf().root}/fake-workers/${OUTPUT}`;
  mkdirSync(directory, { recursive: true });
  const worker = writeFakeWorker(directory, 'discovery', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
    discovery: {
      outputDirectory: `${rootOf().root}/${OUTPUT}`,
      documentText: JSON.stringify(document),
      summary: { ...discoverySummaryOf(document) },
      runStatus: 'COMPLETE',
    },
  }));
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
};

/** ジョブが終わるまで待つ（その間の画面のサーバの子孫を記録する。待ち方は補助 `waitForJobViaServerFunctions`。PRE42-CC 組 UI-K2）。 */
const waitForEnd = (jobId: string): Promise<{ readonly state: string }> => waitForJobViaServerFunctions(
  (id) => valueOf<{ state: string; active: boolean } | null>('getAuditJobFn', 'GET', { jobId: id }),
  jobId,
  (job) => !job.active,
  {
    limitMs: WAIT_LIMIT_MS,
    stepMs: WAIT_POLL_MS,
    onPending: async () => {
      descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
    },
  },
);

const profileDocument = (revision: number): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId: PROFILE_ID,
  revision,
  targetConfigPath: state.targetPath,
  environment: 'TEST',
  mode: 'TEST_APPROVED_WRITE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN],
  approvedServiceOrigins: [API_SERVICE_ORIGIN],
  // PL-5（設計書 7 章）: 本番から切り離されているかをまだ確かめていないサイト（書き込みの OK と開始のダイアログに注意が出る）。
  environmentEvidenceRef: isolationUnverifiedEvidenceRefOf(new Date('2026-10-27T00:00:00Z')),
});

/** 手でログインするフォームの認証の設定（テストの準備）。 */
const authSetupOf = (revision: number): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: revision,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  state.targetPath = 'local/targets/pl5-screens.json';
  mkdirSync(`${root.root}/local/targets`, { recursive: true });
  writeFileSync(`${root.root}/${state.targetPath}`, `${JSON.stringify({
    target: { id: PROFILE_ID },
    site: { startUrl: `${ORIGIN}/admin`, allowedOrigins: [ORIGIN] },
    crawl: { minNavigationIntervalMs: 0, maxPages: 10 },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: OUTPUT },
  }, null, 2)}\n`, 'utf8');
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  // MI-F1（設計書 4.7.1 の 1）: 承認したサービスの Origin は、画面の作成の口では受けない（手動のログインの観察だけが足す）。テストの準備は、観察の後の形の
  // プロファイルを保存の部品で直接作る。
  expect(await createProfileInStore(root.root, profileDocument(FIRST_REVISION))).toMatchObject({ ok: true });
  expect(await saveAuthSetupRequestInStore(root, { setup: authSetupOf(FIRST_REVISION) })).toMatchObject({ ok: true });
  installFakeDiscovery();
  const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION });
  expect(job.ok).toBe(true);
  expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
  browser = await launchHeadlessChromium();
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  root?.remove();
});


const stageText = LOCAL_UI_WRITE_STAGE_TEXT;
/** 押した数（人の入力なしに進むことの確かめ。押下だけを数える）。 */
let presses = 0;
const press = async (target: { click: () => Promise<void> }): Promise<void> => {
  presses += 1;
  await target.click();
};

/** 画面の形（主のボタンは 1 つまで、アクセシビリティの違反 0）。 */
const expectScreenShape = async (page: Page, label: string): Promise<void> => {
  await expectAtMostOnePrimaryButton(page);
  expect(await axeViolationsOf(page), label).toEqual([]);
};

/** 画面に出さない技術の値（3 章の 2）が本文にないか。 */
const expectNoTechnicalValues = async (page: Page, values: readonly string[]): Promise<void> => {
  const shown = (await page.locator('main').textContent()) ?? '';
  for (const value of values) {
    expect(shown.includes(value), value).toBe(false);
  }
};

// PL-U（設計書 14.1 の U4）: 書き込みの手順が 0 件の一覧は行き止まりにしない。主のボタン「書き込みの手順を作る」は、操作さがしの結果があれば下書きを作り
// （操作さがしの画面と同じ部品とダイアログ）、使える結果がなければ操作さがしを始める。
describe('PL-U: the empty list of the write steps', () => {
  it('offers one primary button "make the write steps" that makes the drafts from the discovery result (the same part as the discovery screen)', async () => {
    const page = await openPage(`/scenarios/${PROFILE_ID}`);
    await page.getByTestId('scenario-none').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([stageText.discovery.createDrafts]);
    await expectScreenShape(page, 'empty list');
    // ここでは押さない（押すと下書きを作る。作るのは、次の操作さがしから押すだけで進む確かめ。ボタンは操作さがしの画面と同じ部品）。
    expect(await page.getByRole('main').getByTestId('auto-draft-open').count()).toBe(1);
    expect(withControlData((database) => listScenarios(database, PROFILE_ID))).toEqual([]);
  });

});

describe('PL-5: the screens of the write stage (the shape of the screen 3, the safety texts 7)', () => {
  it('shows the found write operations and one primary button "make the write steps" on the discovery screen, and no technical values', async () => {
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const summary = page.getByTestId('discovery-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    // 登録の形と書き換えの形の 2 つ。
    expect(await summary.getByTestId('discovery-found').textContent()).toBe(stageText.discovery.found(formatCount(2)));
    expect(await primaryButtonLabelsInMain(page)).toEqual([stageText.discovery.createDrafts]);
    // 押せない「下書きを作る」は出さない。候補の表（種類・送信先・ドリフト・分類の理由・欄の型）は出さない。
    expect(await page.locator('main button[disabled]').count()).toBe(0);
    for (const testId of ['candidate-drift', 'candidate-fields', 'candidate-execution', 'candidate-create-read-check', 'candidate-create-scenario']) {
      expect(await page.getByTestId(testId).count(), testId).toBe(0);
    }
    await expectNoTechnicalValues(page, ['/rest/v1/members', 'PATCH', 'POST', 'sha256:', API_SERVICE_ORIGIN]);
    await expectScreenShape(page, 'discovery');
    await screenshot(page, 'pl5-01-discovery');
  });

  it('goes from the discovery to the start dialog by presses only, with one primary button on each screen and the safety texts in the dialogs', async () => {
    presses = 0;
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const summary = page.getByTestId('discovery-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    // PL-U の修正の 1 回目（設計書 14.1 の判断、U3）: 確認のダイアログはなく、1 回の押下で作る。作ったものは結果の 1 行で知らせる。
    await press(summary.getByRole('button', { name: stageText.discovery.createDrafts, exact: true }));
    await summary.getByTestId('auto-draft-created-count').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByRole('dialog').count()).toBe(0);
    // 作った後の要点: 書き込みの手順は作ってある。主のボタンは「書き込みの手順を見る」。
    await summary.getByTestId('discovery-drafted').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([stageText.discovery.openScenarios]);
    await expectScreenShape(page, 'discovery after the drafts');
    // OP-2（D10）: 自動の下書きは更新も保存するので、登録の書き込みの手順を種類で選ぶ（一覧の順は ID の順で、決まっていない）。
    const scenario = withControlData((database) => listScenarios(database, PROFILE_ID)).find(({ current }) => current.kind === 'CREATE');
    if (scenario === undefined) {
      throw new Error('the automatic draft was not made');
    }
    state.createId = scenario.scenarioId;
    await press(summary.getByRole('link', { name: stageText.discovery.openScenarios, exact: true }));
    // 書き込みの手順の一覧: 作った 1 つの書き込みの手順を開く。
    await page.waitForURL(new RegExp(`/scenarios/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await expectScreenShape(page, 'scenario list');
    await press(page.locator(`[data-testid="scenario-row"][data-scenario-id="${state.createId}"]`).getByRole('link').first());

    // 書き込みの手順の詳細: 主のボタンは「書き込みの OK」の 1 つ。要求の形・検証の指定・版・digest・ID は出さない。
    const detail = page.getByTestId('scenario-summary');
    await detail.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([stageText.scenario.approve]);
    expect(await detail.textContent()).toContain(stageText.scenario.nextApprove);
    for (const testId of ['scenario-request', 'scenario-verification-section', 'scenario-history', 'scenario-revisions', 'scenario-api-shape']) {
      expect(await page.getByTestId(testId).count(), testId).toBe(0);
    }
    await expectNoTechnicalValues(page, [state.createId, 'sha256:', '/rest/v1/members', API_SERVICE_ORIGIN]);
    await expectScreenShape(page, 'scenario detail before the OK');
    await screenshot(page, 'pl5-02-scenario-draft');

    await press(detail.getByRole('button', { name: stageText.scenario.approve, exact: true }));
    const approveDialog = page.getByRole('dialog', { name: LOCAL_UI_SCENARIO_TEXT.approveDialog.title });
    await approveDialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // 7 章: 何を・どこへ・何件、4 つの約束。OP-2 の修正の 1 回目（判断 5、設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D6）: 隔離の注意は出さない。
    expect(await approveDialog.getByTestId('scenario-approve-target').textContent())
      .toBe(LOCAL_UI_SCENARIO_TEXT.approveDialog.targetCreate(NEW_PATH, formatInteger(1)));
    expect(await approveDialog.getByTestId('scenario-approve-side-effects').locator('li').count()).toBe(SIDE_EFFECTS.length);
    expect(await approveDialog.getByTestId('scenario-approve-isolation-unverified').count()).toBe(0);
    await expectNoTechnicalValues(page, ['sha256:', API_SERVICE_ORIGIN]);
    await expectScreenShape(page, 'approve dialog');
    await press(approveDialog.getByRole('button', { name: LOCAL_UI_SCENARIO_TEXT.approveDialog.confirm, exact: true }));
    await approveDialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS });

    // OK の後: 主のボタンは「書き込みを始める」の 1 つ。
    await expect.poll(async () => primaryButtonLabelsInMain(page), { timeout: UI_TIMEOUT_MS }).toEqual([stageText.scenario.start]);
    expect(await page.getByTestId('scenario-summary').textContent()).toContain(stageText.scenario.nextStart);
    await expectScreenShape(page, 'scenario detail after the OK');
    await screenshot(page, 'pl5-03-scenario-approved');
    await press(page.getByTestId('scenario-summary').getByRole('link', { name: stageText.scenario.start, exact: true }));

    // 書き込みを始める画面: 主のボタンは 1 つ。「書き込みの手順の詳細に戻る」は出さない（今どこにいるかの 1 行で戻れる）。
    const start = page.getByTestId('write-start');
    await start.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_WRITE_TEXT.start]);
    expect(await backLinkCountInMain(page)).toBe(0);
    expect(await page.getByTestId('page-context').getByRole('link', { name: LOCAL_UI_SCENARIO_TEXT.pages.scenario }).count()).toBe(1);
    await expectNoTechnicalValues(page, [state.createId, 'sha256:']);
    await expectScreenShape(page, 'write start');
    await screenshot(page, 'pl5-04-write-start');
    await press(page.getByTestId('write-start-open'));
    const startDialog = page.getByRole('dialog', { name: LOCAL_UI_WRITE_TEXT.startDialog.title });
    await startDialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // D6: 隔離の注意は出さない。
    expect(await startDialog.getByTestId('write-start-isolation-unverified').count()).toBe(0);
    expect(await startDialog.textContent()).not.toContain(ISOLATION_NOTICE_FRAGMENT);
    await expectScreenShape(page, 'start dialog');
    // 始めない（このテストの偽のワーカーは書き込みを行わない。結果までの流れはフォームの形の full-flow と API の形の scenario-ui で確かめる）。
    await startDialog.getByRole('button', { name: LOCAL_UI_WRITE_TEXT.startDialog.cancel, exact: true }).click();
    // 押下の数: 作る・書き込みの手順を見る・開く・OK・OK の確定・書き込みを始める（画面へ）・書き込みを始める（ダイアログ）の 7（入力は 0。PL-U で作るの確定を
    // なくした。前は 8）。
    expect(presses).toBe(7);
  });

  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10）: 更新の変える欄は BeakSight が決め、自動の下書きが更新の下書きも保存する（前は、案内の
  // リンクから更新の作成の画面を開き、人が選んだ）。更新の作成の画面はふだんの流れから外したので、保存した更新の書き込みの手順の画面で、同じ形を確かめる。
  it('shows the saved update of rule F, the list of the made data and the optional READ check screen in the same shape', async () => {
    const updateId = withControlData((database) => listScenarios(database, PROFILE_ID)).find(({ current }) => current.kind === 'UPDATE')?.scenarioId;
    if (updateId === undefined) {
      throw new Error('the update saved by the automatic draft was not found');
    }
    const form = await openPage(`/scenarios/${PROFILE_ID}/${updateId}`);
    await form.locator('h1.page-title').waitFor({ timeout: UI_TIMEOUT_MS });
    // 更新の答え合わせは、保存の口が登録から写した（画面は 1 行だけ。中身と選ぶ所は出さない）。
    expect(await form.getByTestId('scenario-verification-copied').textContent()).toBe(stageText.scenario.verificationCopied);
    expect(await form.getByTestId('scenario-read-from-ledger').count()).toBe(0);
    await expectNoTechnicalValues(form, ['sha256:', API_SERVICE_ORIGIN]);
    await expectScreenShape(form, 'saved update of rule F');

    const ledger = await openPage(`/ledger/${PROFILE_ID}`);
    await ledger.getByTestId('ledger').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await ledger.getByTestId('ledger-count').textContent()).toBe(stageText.ledger.none);
    // 作ったデータがないので、「書き換えを試す」は出さない。
    expect(await ledger.getByTestId('ledger-update-try').count()).toBe(0);
    await expectScreenShape(ledger, 'ledger');

    const readChecks = await openPage(`/read-checks/${PROFILE_ID}`);
    await readChecks.getByTestId('read-check-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await readChecks.getByTestId('read-check-optional').textContent()).toBe(stageText.readChecks.optional);
    await expectScreenShape(readChecks, 'read checks');
    await screenshot(readChecks, 'pl5-05-read-checks');
  });

  // PL-5 の修正の 1 回目（設計書 3 章の 1・2）: 見るだけの確かめの作成と定義の画面も、要点（入力と主のボタン 1 つ）と詳しい内容 1 つ。何回目の変更か・送信先・
  // digest・ID は出さない。削除（取り消せない操作）は詳しい内容の中。
  it('shows the new and the definition screens of a READ check in the same shape', async () => {
    const created = await openPage(`/read-checks/${PROFILE_ID}/new?target=PAGE`);
    await created.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(created)).toEqual([LOCAL_UI_READ_CHECK_TEXT.save]);
    await expectNoTechnicalValues(created, ['sha256:', API_SERVICE_ORIGIN]);
    await expectScreenShape(created, 'new READ check');

    const [definition] = withControlData((database) => listReadChecks(database, PROFILE_ID));
    if (definition === undefined) {
      throw new Error('the READ check made by the draft was not found');
    }
    const edit = await openPage(`/read-checks/${PROFILE_ID}/${definition.readCheckId}`);
    await edit.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(edit)).toEqual([LOCAL_UI_READ_CHECK_TEXT.save]);
    // 削除は詳しい内容の中（閉じている間は見えない）。
    expect(await edit.getByTestId('read-check-remove').isVisible()).toBe(false);
    expect(await edit.getByTestId(READ_CHECK_ADVANCED_SETTINGS).count()).toBe(1);
    await expectNoTechnicalValues(edit, [definition.readCheckId, 'sha256:', LOCAL_UI_TEXT.profileForm.revisionText(definition.revision)]);
    await expectScreenShape(edit, 'READ check definition');
    await screenshot(edit, 'pl5-06-read-check-definition');
  });
});

// PL-U（14.1 の U4）: 操作さがしの結果がまだないサイト（別のサイト。同じ偽のワーカーの出力先を使うので、ほかの確かめの後に置く）。
describe('PL-U: the empty list of the write steps without a discovery result', () => {
  it('starts the discovery from the empty list when there is no discovery result yet', async () => {
    const otherId = `${PROFILE_ID}-empty`;
    const otherPath = `local/targets/${otherId}.json`;
    writeFileSync(`${rootOf().root}/${otherPath}`, readFileSync(`${rootOf().root}/${state.targetPath}`, 'utf8').replace(`"id": "${PROFILE_ID}"`, `"id": "${otherId}"`), 'utf8');
    expect(await createProfileInStore(rootOf().root, { ...profileDocument(FIRST_REVISION), profileId: otherId, targetConfigPath: otherPath }))
      .toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: { ...authSetupOf(FIRST_REVISION), profileId: otherId } })).toMatchObject({ ok: true });
    const page = await openPage(`/scenarios/${otherId}`);
    await page.getByTestId('scenario-none').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([stageText.discovery.createDrafts]);
    await expectScreenShape(page, 'empty list without a discovery');
    await page.getByRole('main').getByRole('button', { name: stageText.discovery.createDrafts, exact: true }).click();
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    expect(await valueOf<{ jobKind: string; profileId: string }>('getAuditJobFn', 'GET', { jobId })).toMatchObject({ jobKind: 'DISCOVERY', profileId: otherId });
    expect(await waitForEnd(jobId)).toMatchObject({ state: 'FINISHED' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// OP-2 の修正の 1 回目（指示書の 6。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.2 の「チェックの保存」）: サイトの画面の一覧
// ---------------------------------------------------------------------------------------------------------------

/** 値を読めない秘密に見える見えない欄のある登録の画面（フォームの形。その画面では作れないので、チェックできない行）。 */
const STAFF_NEW_PATH = '/admin/staff/new';
const STAFF_CREATE = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: STAFF_NEW_PATH },
  action: sampleAction('/admin/staff', [], ORIGIN),
  submitterText: '登録',
  fields: [sampleField('name', 'text', { required: true }), sampleField('api_key', 'hidden', { hasValue: true })],
}));
/** 一覧の行の名前（操作さがしで記録した見出し）。 */
const MEMBER_SCREEN_NAME = '会員の登録';

/** 一覧の確かめの操作さがしの結果（API の登録と更新、読めた会員の画面、チェックできないフォームの登録。登録の画面は見出しを持つ）。 */
const listDocumentOf = (): DiscoveryDocument => {
  const base = documentOf();
  const pages = base.pages.map((page) => (page.state === 'READ' && page.record.location?.path === NEW_PATH
    ? { ...page, record: { ...page.record, screenName: { heading: MEMBER_SCREEN_NAME, title: 'members' } } }
    : page));
  return {
    ...base,
    pages: [...pages, {
      url: `${ORIGIN}${STAFF_NEW_PATH}`, state: 'READ', record: { location: STAFF_CREATE.page, incompleteReasons: [], candidates: [STAFF_CREATE] }, blockedRequests: 0,
    }],
  };
};

interface WriteScreenRowValue {
  readonly rowKey: string;
  readonly screenName: string | null;
  readonly mayNotify: boolean;
  readonly state: string;
  readonly notCheckableReason: string | null;
}

describe('OP-2 fix round 1: the list of the screens to try the create and the update on the site screen', () => {
  const LIST_PROFILE_ID = `${PROFILE_ID}-list`;
  const rowsOf = async (): Promise<readonly WriteScreenRowValue[]> =>
    (await valueOf<{ rows: readonly WriteScreenRowValue[] } | null>('writeScreensFn', 'GET', { profileId: LIST_PROFILE_ID }))?.rows ?? [];
  const scenarioStatesOf = (): readonly (readonly [string, string])[] => withControlData((database) => listScenarios(database, LIST_PROFILE_ID))
    .map(({ current, state: scenarioState }): readonly [string, string] => [current.kind, scenarioState])
    .sort((left, right) => left.join().localeCompare(right.join()));

  beforeAll(async () => {
    const listPath = `local/targets/${LIST_PROFILE_ID}.json`;
    writeFileSync(`${rootOf().root}/${listPath}`, readFileSync(`${rootOf().root}/${state.targetPath}`, 'utf8').replace(`"id": "${PROFILE_ID}"`, `"id": "${LIST_PROFILE_ID}"`), 'utf8');
    expect(await createProfileInStore(rootOf().root, { ...profileDocument(FIRST_REVISION), profileId: LIST_PROFILE_ID, targetConfigPath: listPath }))
      .toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: { ...authSetupOf(FIRST_REVISION), profileId: LIST_PROFILE_ID } })).toMatchObject({ ok: true });
    installFakeDiscovery(listDocumentOf());
    const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: LIST_PROFILE_ID, expectedRevision: FIRST_REVISION });
    expect(job.ok).toBe(true);
    expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
  });

  it('shows the rows with the screen name, the line about mails and the reason of a row that cannot be checked, in the shape of the screen', async () => {
    const page = await openPage(`/profiles/${LIST_PROFILE_ID}`);
    const list = page.getByTestId('write-screens');
    await list.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await list.getByTestId('write-screens-intro').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.intro);
    const member = list.locator('[data-testid="write-screen-row"]').filter({ hasText: MEMBER_SCREEN_NAME });
    expect(await member.count()).toBe(1);
    expect(await member.getAttribute('data-state')).toBe('CHECKABLE');
    // 判断 1: メールなどを送ることがある画面には、その 1 行（チェックがその確認を兼ねる）。
    expect(await member.getByTestId('write-screen-may-notify').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.mayNotify);
    expect(await member.getByTestId('write-screen-check').isEnabled()).toBe(true);
    // 試せない行: チェックできず、理由の 1 行（名前が取れないので、やさしい形の 1 行）。
    const staff = list.locator('[data-testid="write-screen-row"][data-state="NOT_CHECKABLE"]');
    expect(await staff.count()).toBe(1);
    // OP-G（指示書の 7）: 名前が取れない行は、英字の path の語を出さず「登録の画面（1）」の形（名前のない行の中の順）。
    expect(await staff.textContent()).toContain(LOCAL_UI_WRITE_SCREENS_TEXT.unnamedScreen('1'));
    expect(await staff.textContent()).not.toContain('staff');
    expect(await staff.getByTestId('write-screen-check').isDisabled()).toBe(true);
    expect(await staff.getByTestId('write-screen-state').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.states.NOT_CHECKABLE);
    // OP-2 の修正の 2 回目（判断 2）: 理由ごとのやさしい 1 行（秘密に見える欄）。チェックできない行には、更新の 1 行を出さない。
    expect(await staff.getByTestId('write-screen-not-checkable-reason').textContent()).toBe(LOCAL_UI_WRITE_SCREENS_TEXT.notCheckable.SECRET_FIELD);
    // OP-L（L3）: 理由のコードは、文に出さず、行の属性に残す（次の点検で原因が分かるように）。コードは、やさしい 1 行の種類と同じ振り分けに当たる。
    const reasonCode = await staff.getByTestId('write-screen-not-checkable-reason').getAttribute('data-reason');
    expect(reasonCode).toMatch(/^SCENARIO_[A-Z_]+$/u);
    expect(writeScreenNotCheckableKindOf(reasonCode as ScenarioDraftRejectionReason)).toBe('SECRET_FIELD');
    expect(((await staff.textContent()) ?? '').includes(String(reasonCode))).toBe(false);
    expect(await staff.getByTestId('write-screen-update-state').count()).toBe(0);
    // 更新の画面（候補）がある行は、更新の 1 行を出さない（チェックすると、登録と更新を試す）。
    expect(await member.getByTestId('write-screen-update-state').count()).toBe(0);
    expect(await member.getByTestId('write-screen-not-checkable-reason').count()).toBe(0);
    // 一覧に、アドレスの path・技術の値・秘密の目印は出さない（サイトの画面の本文にも、path・digest・目印はない）。
    const listText = (await list.textContent()) ?? '';
    for (const value of [NEW_PATH, STAFF_NEW_PATH, 'sha256:', API_SERVICE_ORIGIN, ...MARKERS]) {
      expect(listText.includes(value), value).toBe(false);
    }
    await expectNoTechnicalValues(page, [NEW_PATH, STAFF_NEW_PATH, 'sha256:', ...MARKERS]);
    await expectScreenShape(page, 'site screen with the list');
    await screenshot(page, 'op2-01-write-screens');
  });

  it('saves the check at once: approves the create and the update of the screen, and revokes them when the check is taken off', async () => {
    const page = await openPage(`/profiles/${LIST_PROFILE_ID}`);
    const member = page.getByTestId('write-screens').locator('[data-testid="write-screen-row"]').filter({ hasText: MEMBER_SCREEN_NAME });
    await member.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(scenarioStatesOf()).toEqual([]);
    // 入れる: ボタンもダイアログもなく、その場で保存する（下書き・承認を 1 回で）。チェックの欄は、保存の後のサーバの値で描く（押した直後は変わらない）ので、
    // 押して、保存の後の状態を待つ。
    await member.getByTestId('write-screen-check').click();
    await expect.poll(() => member.getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('CHECKED');
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await member.getByTestId('write-screen-rejection').count()).toBe(0);
    expect(scenarioStatesOf()).toEqual([['CREATE', 'APPROVED'], ['UPDATE', 'APPROVED']]);
    // チェックの保存は、副作用の確認を兼ねる（承認した版は 4 項目を確かめた版）。
    for (const scenario of withControlData((database) => listScenarios(database, LIST_PROFILE_ID))) {
      expect(Object.values(scenario.current.sideEffectConfirmations)).toEqual([true, true, true, true]);
    }
    expect((await rowsOf()).find(({ screenName }) => screenName === MEMBER_SCREEN_NAME)).toMatchObject({ state: 'CHECKED', mayNotify: true });
    await expectScreenShape(page, 'site screen after the check');
    await screenshot(page, 'op2-02-write-screen-checked');
    // 外す: 承認を取り消す（次の点検から書き込まない）。
    await member.getByTestId('write-screen-check').click();
    await expect.poll(() => member.getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('CHECKABLE');
    expect(scenarioStatesOf()).toEqual([['CREATE', 'REVOKED'], ['UPDATE', 'REVOKED']]);
    // もう一度入れると、同じ手順を承認し直す（作り直さない）。
    await member.getByTestId('write-screen-check').click();
    await expect.poll(() => member.getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('CHECKED');
    expect(scenarioStatesOf()).toEqual([['CREATE', 'APPROVED'], ['UPDATE', 'APPROVED']]);
  });

  // OP-F（OP-REV2 の m-1）: チェックの保存は、画面が描いたときの「知らせを送ることがある」の 1 行（`mayNotifyShown`）を受け取る。サーバの今の値と違えば（古い画面から
  // 保存した）、利用者が見ていない 1 行を根拠にしないので、更新は承認せず、登録だけを承認する。
  it('approves only the create when the screen did not show the line about notifications that the server has now', async () => {
    const member = (await rowsOf()).find(({ screenName }) => screenName === MEMBER_SCREEN_NAME);
    expect(member).toMatchObject({ mayNotify: true });
    const rowKey = member?.rowKey ?? '';
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey, checked: false })).toEqual({ ok: true });
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey, checked: true, mayNotifyShown: false })).toEqual({ ok: true });
    expect(scenarioStatesOf()).toEqual([['CREATE', 'APPROVED'], ['UPDATE', 'REVOKED']]);
    // 画面が 1 行を出していたなら、更新も承認する。
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey, checked: false })).toEqual({ ok: true });
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey, checked: true, mayNotifyShown: true })).toEqual({ ok: true });
    expect(scenarioStatesOf()).toEqual([['CREATE', 'APPROVED'], ['UPDATE', 'APPROVED']]);
  });

  it('rejects the check of a row that cannot be tried, and makes nothing for it; the answers carry no secret marker', async () => {
    const before = scenarioStatesOf();
    const staff = (await rowsOf()).find(({ state: rowState }) => rowState === 'NOT_CHECKABLE');
    expect(staff?.notCheckableReason).not.toBeNull();
    const rejected = await call('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey: staff?.rowKey ?? '', checked: true });
    expect(rejected.response.status).toBe(STATUS.OK);
    expect(rejected.value).toEqual({ ok: false, reason: 'SCREEN_NOT_DRAFTABLE' });
    expect(scenarioStatesOf()).toEqual(before);
    // 一覧の値と保存の答えに、probe の目印（送る値）と技術の値はない。
    const listed = await call('writeScreensFn', 'GET', { profileId: LIST_PROFILE_ID });
    for (const body of [listed.response.body, rejected.response.body]) {
      for (const value of [...MARKERS, API_SERVICE_ORIGIN, NEW_PATH]) {
        expect(body.includes(value), value).toBe(false);
      }
    }
    // 形の違う入力は、スキーマで拒む（保存しない）。
    expect((await call('saveWriteScreenCheckFn', 'POST', { profileId: LIST_PROFILE_ID, rowKey: staff?.rowKey ?? '' })).response.status).toBe(STATUS.BAD_REQUEST);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// OP-S（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.9 の R1 と OP-REV6 の I-1）: チェックを入れたときは、その画面の書き込みの手順を、
// 最後の操作さがしと今の自動の下書きの決まりで作り直す。中身が違えば新しい版にして、その版を承認する。同じなら、承認だけを行う（版を上げない）。
// 本物のテスト環境の事実: 前の決まりで作った手順（推した詳細の画面での答え合わせ）は、チェックを入れ直しても承認だけが新しくなり、一覧の画面での答え合わせ
// （R1）と、毎回違う欄の期待（I-1）が効かなかった。
// ここでは、データのないサイト（詳細の画面を読めず、更新の画面もない）で、まず点検の段のリンクがないうちにチェックする（今の決まりでも、推した詳細の画面の形に
// なる。前の決まりで作った手順の代わり）。その後に、点検の段で一覧の画面へのリンクを見つけた形（終わった点検のジョブと成果物）を足して、チェックを外して入れ直す。
// 書き込みの段は流さない（下書きと承認の結合だけ）。
// ---------------------------------------------------------------------------------------------------------------

describe('OP-S: the check rebuilds the write steps of the screen from the latest discovery with the current rules', () => {
  const REDRAFT_PROFILE_ID = `${PROFILE_ID}-redraft`;
  /** 登録の画面の 1 つ上の一覧の画面（点検の段のリンクにある）。 */
  const MEMBER_LIST_PATH = '/admin/members';
  /** 推した詳細の画面の形（データのないサイトの、よくある形）。 */
  const COMMON_DETAIL_TEMPLATE = '/admin/members/{id}';
  /** 足す点検のジョブ（操作さがしのジョブより前に作った形）。 */
  const AUDIT_JOB_ID = 'op-s-audit-job';
  const AUDIT_RUN_ID = 'RUN-20261001000000';
  const AUDIT_CREATED_AT = '20261001000000';
  /** 登録の画面だけの操作さがしの結果（詳細の画面も更新の画面もない）。 */
  const redraftDocumentOf = (): DiscoveryDocument => {
    const base = documentOf();
    return { ...base, pages: base.pages.filter(({ url }) => url === `${ORIGIN}${NEW_PATH}`) };
  };
  const createScenarioOf = () => {
    const scenarios = withControlData((database) => listScenarios(database, REDRAFT_PROFILE_ID));
    expect(scenarios.map(({ current }) => current.kind)).toEqual(['CREATE']);
    const [scenario] = scenarios;
    if (scenario === undefined) {
      throw new Error('the create scenario is missing');
    }
    return scenario;
  };
  const readCheckPathOf = (readCheckId: string | undefined): string | null | undefined =>
    withControlData((database) => listReadChecks(database, REDRAFT_PROFILE_ID)).find((definition) => definition.readCheckId === readCheckId)?.definition.targetPagePath;
  const check = async (checked: boolean): Promise<void> => {
    const row = (await valueOf<{ rows: readonly WriteScreenRowValue[] } | null>('writeScreensFn', 'GET', { profileId: REDRAFT_PROFILE_ID }))?.rows
      .find(({ rowKey }) => rowKey === CREATE.identityDigest);
    expect(row).toBeDefined();
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', {
      profileId: REDRAFT_PROFILE_ID, rowKey: CREATE.identityDigest, checked, mayNotifyShown: row?.mayNotify ?? false,
    })).toEqual({ ok: true });
  };
  /** 点検の段で、一覧の画面へのリンクを見つけた形（終わった点検のジョブと、その成果物の `page.json`）。 */
  const addAuditStageLinkToList = (): void => {
    withControlData((database) => {
      expect(createStartingJob(database, {
        jobId: AUDIT_JOB_ID, jobKind: WORKER_AUDIT_JOB_KIND, profileId: REDRAFT_PROFILE_ID, profileRevision: FIRST_REVISION, startNew: true, createdAt: AUDIT_CREATED_AT,
      }, () => null)).toEqual({ ok: true });
      expect(recordRunStarted(database, AUDIT_JOB_ID, { runId: AUDIT_RUN_ID as RunId, runDirectory: AUDIT_RUN_ID, startedAt: AUDIT_CREATED_AT })).toBe(true);
      expect(recordFinished(database, AUDIT_JOB_ID, { kind: 'RAN', exitCode: 0, runId: AUDIT_RUN_ID as RunId, runDirectory: AUDIT_RUN_ID, runStatus: 'COMPLETE' },
        AUDIT_CREATED_AT)).toBe(true);
    });
    const pageFile = `${rootOf().root}/${OUTPUT}/${AUDIT_RUN_ID}/${pageArtifactRelativePath(createPageId(1), 'page')}`;
    mkdirSync(pageFile.slice(0, pageFile.lastIndexOf('/')), { recursive: true });
    writeFileSync(pageFile, JSON.stringify({
      evidence: [{
        type: 'link', viewport: 'desktop',
        payload: { links: [{ anchorText: '会員', ariaLabel: null, title: null, normalized: { ok: true, url: `${ORIGIN}${MEMBER_LIST_PATH}` }, admission: { kind: 'INTERNAL_NAVIGABLE' } }] },
      }],
    }), 'utf8');
  };

  beforeAll(async () => {
    const redraftPath = `local/targets/${REDRAFT_PROFILE_ID}.json`;
    writeFileSync(`${rootOf().root}/${redraftPath}`, readFileSync(`${rootOf().root}/${state.targetPath}`, 'utf8')
      .replace(`"id": "${PROFILE_ID}"`, `"id": "${REDRAFT_PROFILE_ID}"`), 'utf8');
    expect(await createProfileInStore(rootOf().root, { ...profileDocument(FIRST_REVISION), profileId: REDRAFT_PROFILE_ID, targetConfigPath: redraftPath }))
      .toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: { ...authSetupOf(FIRST_REVISION), profileId: REDRAFT_PROFILE_ID } })).toMatchObject({ ok: true });
    installFakeDiscovery(redraftDocumentOf());
    const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: REDRAFT_PROFILE_ID, expectedRevision: FIRST_REVISION });
    expect(job.ok).toBe(true);
    expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
  });

  it('rebuilds the old steps (the guessed detail screen) into the list screen and the field that differs each run, and approves the new revision', async () => {
    // 前の決まりの代わり: 点検の段のリンクがないうちのチェックは、推した詳細の画面の形で答え合わせをする手順になる。
    await check(true);
    const old = createScenarioOf();
    expect(old.state).toBe('APPROVED');
    const oldRead = old.current.verification.readVerification;
    expect(readCheckPathOf(oldRead?.readCheckId)).toBe(COMMON_DETAIL_TEMPLATE);
    expect(oldRead?.verificationOnly ?? false).toBe(false);
    await check(false);
    expect(createScenarioOf().state).toBe('REVOKED');
    // 点検の段が一覧の画面へのリンクを見つけた後に、チェックを入れ直す。
    addAuditStageLinkToList();
    await check(true);
    const rebuilt = createScenarioOf();
    expect(rebuilt.scenarioId).toBe(old.scenarioId);
    expect(rebuilt.revision).toBeGreaterThan(old.revision);
    expect(rebuilt.state).toBe('APPROVED');
    // チェックの保存は、副作用の確認を兼ねる（承認した新しい版は 4 項目を確かめた版）。
    expect(Object.values(rebuilt.current.sideEffectConfirmations)).toEqual([true, true, true, true]);
    const read = rebuilt.current.verification.readVerification;
    expect(readCheckPathOf(read?.readCheckId)).toBe(MEMBER_LIST_PATH);
    expect(read?.verificationOnly).toBe(true);
    // OP-REV6 の I-1: 一覧の画面の期待は、実行のたびに違う値になる欄（メール）と比べる（人の名前とは比べない）。
    expect(read?.expectations).toEqual([{ kind: 'TEXT_CONTAINS', fieldName: 'email' }]);
    // 送る欄・ID の取り方は、今の決まりのまま。
    expect(rebuilt.current.fieldNames).toEqual(old.current.fieldNames);
    expect(rebuilt.current.api?.recordId).toEqual(old.current.api?.recordId);
    // 前の照合の定義（照合の専用の印のない、推した詳細の画面の定義）は、取り消さずに残す。
    expect(readCheckPathOf(oldRead?.readCheckId)).toBe(COMMON_DETAIL_TEMPLATE);
  });

  it('only approves again without a new revision when the steps are the same as the current rules make', async () => {
    const before = createScenarioOf();
    await check(false);
    await check(true);
    const after = createScenarioOf();
    expect(after.state).toBe('APPROVED');
    expect(after.revision).toBe(before.revision);
    expect(after.current.verification).toEqual(before.current.verification);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// OP-T（DEF-184）: チェックが入ったままの画面も、まとめて実行を始めるときに、手順の作り直しを確かめる（`startStageChainFn` の中で、ジョブを渡す前）。
// 1. 中身が同じ: 何もしない（版を変えない）。2. 照合の READ だけが違う: 新しい版を承認する。3. 送る中身が違う: 承認を取り消し、もう一度チェックを求める
// （書き込みの段に渡らない）。書き込みの段は流さない: 開始は、古い改訂の要求で、ジョブの管理が開始の直前に拒む（作り直しは、その前に行う）。
// 加えて、OP-S のフォームの形の作り直し（チェックを入れ直す道）。
// ---------------------------------------------------------------------------------------------------------------

describe('OP-T: the start of the stage chain rebuilds the steps of the screens that stay checked', () => {
  const READ_PROFILE_ID = `${PROFILE_ID}-chain-read`;
  const SENT_PROFILE_ID = `${PROFILE_ID}-chain-sent`;
  const FORM_PROFILE_ID = `${PROFILE_ID}-form-redraft`;
  const UNLISTED_PROFILE_ID = `${PROFILE_ID}-chain-unlisted`;
  const GUARD_PROFILE_ID = `${PROFILE_ID}-chain-guard`;
  const FACTS_PROFILE_ID = `${PROFILE_ID}-chain-facts`;
  const UPDATES_PROFILE_ID = `${PROFILE_ID}-chain-updates`;
  /** 増やした電話の欄の probe の目印。 */
  const PHONE_MARKER = 'bsprobe0000000000fm2c';
  const MEMBER_LIST_PATH = '/admin/members';
  const COMMON_DETAIL_TEMPLATE = '/admin/members/{id}';
  /** 開始を、ジョブの管理が開始の直前に拒む改訂（プロファイルの改訂は 1）。 */
  const STALE_REVISION = FIRST_REVISION + 1;
  const AUDIT_JOB_ID = 'op-t-audit-job';
  const AUDIT_RUN_ID = 'RUN-20261001000100';
  const AUDIT_CREATED_AT = '20261001000100';
  /** フォームの形の登録の画面（送り先は会員の一覧の path）。 */
  const FORM_CREATE = candidateOf(sampleForm({
    page: { origin: ORIGIN, path: NEW_PATH }, action: sampleAction(MEMBER_LIST_PATH, [], ORIGIN), submitterText: '登録',
    fields: [sampleField('name', 'text', { required: true }), sampleField('email', 'email')],
  }));
  /** 同じ表の更新の画面（ID の取り方の元）。 */
  const FORM_UPDATE = candidateOf(sampleForm({
    page: { origin: ORIGIN, path: '/admin/members/1001/edit' }, action: sampleAction('/admin/members/1001', [], ORIGIN), methodOverride: 'PATCH',
    submitterText: '更新', fields: [sampleField('_method', 'hidden', { hasValue: true }), sampleField('name'), sampleField('email', 'email')],
  }));
  /** 会員の検索（答え合わせの READ の元。`parameterName` は送る値の名前）。 */
  const searchOf = (parameterName: string): DiscoveryCandidate => candidateOf(sampleForm({
    page: { origin: ORIGIN, path: MEMBER_LIST_PATH }, formMethod: 'GET', action: sampleAction(MEMBER_LIST_PATH, [], ORIGIN), submitterText: '検索',
    fields: [sampleField(parameterName, 'search')],
  }));

  /** 操作さがしの結果（候補ごとに 1 ページ）。 */
  const documentWith = (candidates: readonly DiscoveryCandidate[]): DiscoveryDocument => ({
    ...documentOf(),
    pages: candidates.map((candidate) => ({
      url: `${ORIGIN}${candidate.page.path}`, state: 'READ' as const, record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] }, blockedRequests: 0,
    })),
  });
  /** 登録の画面だけの操作さがしの結果（`create` は登録の候補）。 */
  const createOnlyDocumentOf = (create: DiscoveryCandidate): DiscoveryDocument => documentWith([create]);
  const setUpProfile = async (profileId: string): Promise<void> => {
    const path = `local/targets/${profileId}.json`;
    writeFileSync(`${rootOf().root}/${path}`, readFileSync(`${rootOf().root}/${state.targetPath}`, 'utf8').replace(`"id": "${PROFILE_ID}"`, `"id": "${profileId}"`), 'utf8');
    expect(await createProfileInStore(rootOf().root, { ...profileDocument(FIRST_REVISION), profileId, targetConfigPath: path })).toMatchObject({ ok: true });
    expect(await saveAuthSetupRequestInStore(rootOf(), { setup: { ...authSetupOf(FIRST_REVISION), profileId } })).toMatchObject({ ok: true });
  };
  const discover = async (profileId: string, document: DiscoveryDocument): Promise<void> => {
    installFakeDiscovery(document);
    const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId, expectedRevision: FIRST_REVISION });
    expect(job.ok).toBe(true);
    expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
  };
  const rowOf = async (profileId: string, rowKey: string): Promise<WriteScreenRowValue | undefined> =>
    (await valueOf<{ rows: readonly WriteScreenRowValue[] } | null>('writeScreensFn', 'GET', { profileId }))?.rows.find((row) => row.rowKey === rowKey);
  const check = async (profileId: string, rowKey: string, checked: boolean): Promise<void> => {
    const row = await rowOf(profileId, rowKey);
    expect(row).toBeDefined();
    expect(await valueOf('saveWriteScreenCheckFn', 'POST', { profileId, rowKey, checked, mayNotifyShown: row?.mayNotify ?? false })).toEqual({ ok: true });
  };
  const scenarioOf = (profileId: string, kind: 'CREATE' | 'UPDATE') => {
    const scenario = withControlData((database) => listScenarios(database, profileId)).find(({ current }) => current.kind === kind);
    if (scenario === undefined) {
      throw new Error(`the ${kind} scenario is missing`);
    }
    return scenario;
  };
  const readCheckOf = (profileId: string, readCheckId: string | undefined) =>
    withControlData((database) => listReadChecks(database, profileId)).find((definition) => definition.readCheckId === readCheckId)?.definition;
  /** まとめて実行を始める（古い改訂なので、ジョブの管理が拒む。ワーカーは起動しない）。 */
  const startChain = async (profileId: string): Promise<void> => {
    expect(await valueOf('startStageChainFn', 'POST', { profileId, expectedRevision: STALE_REVISION, startNew: true })).toMatchObject({ ok: false });
  };
  /** 点検の段で、一覧の画面へのリンクを見つけた形（OP-S の確かめと同じ作り。ジョブと Run はこの確かめのもの）。 */
  const addAuditStageLinkToList = (profileId: string): void => {
    withControlData((database) => {
      expect(createStartingJob(database, {
        jobId: AUDIT_JOB_ID, jobKind: WORKER_AUDIT_JOB_KIND, profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt: AUDIT_CREATED_AT,
      }, () => null)).toEqual({ ok: true });
      expect(recordRunStarted(database, AUDIT_JOB_ID, { runId: AUDIT_RUN_ID as RunId, runDirectory: AUDIT_RUN_ID, startedAt: AUDIT_CREATED_AT })).toBe(true);
      expect(recordFinished(database, AUDIT_JOB_ID, { kind: 'RAN', exitCode: 0, runId: AUDIT_RUN_ID as RunId, runDirectory: AUDIT_RUN_ID, runStatus: 'COMPLETE' },
        AUDIT_CREATED_AT)).toBe(true);
    });
    const pageFile = `${rootOf().root}/${OUTPUT}/${AUDIT_RUN_ID}/${pageArtifactRelativePath(createPageId(1), 'page')}`;
    mkdirSync(pageFile.slice(0, pageFile.lastIndexOf('/')), { recursive: true });
    writeFileSync(pageFile, JSON.stringify({
      evidence: [{
        type: 'link', viewport: 'desktop',
        payload: { links: [{ anchorText: '会員', ariaLabel: null, title: null, normalized: { ok: true, url: `${ORIGIN}${MEMBER_LIST_PATH}` }, admission: { kind: 'INTERNAL_NAVIGABLE' } }] },
      }],
    }), 'utf8');
  };

  it('approves the new revision when only the READ check of the checked screen differs, and keeps the revision when the steps are the same', async () => {
    await setUpProfile(READ_PROFILE_ID);
    await discover(READ_PROFILE_ID, createOnlyDocumentOf(CREATE));
    // 前の決まりの代わり（OP-S と同じ）: 点検の段のリンクがないうちのチェックは、推した詳細の画面で答え合わせをする手順になる。
    await check(READ_PROFILE_ID, CREATE.identityDigest, true);
    const old = scenarioOf(READ_PROFILE_ID, 'CREATE');
    expect(old.state).toBe('APPROVED');
    expect(readCheckOf(READ_PROFILE_ID, old.current.verification.readVerification?.readCheckId)?.targetPagePath).toBe(COMMON_DETAIL_TEMPLATE);
    // チェックは入ったまま（外して入れ直さない）で、点検の段が一覧の画面のリンクを見つけた。
    addAuditStageLinkToList(READ_PROFILE_ID);
    expect(await rowOf(READ_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
    await startChain(READ_PROFILE_ID);
    const rebuilt = scenarioOf(READ_PROFILE_ID, 'CREATE');
    expect(rebuilt.scenarioId).toBe(old.scenarioId);
    expect(rebuilt.revision).toBeGreaterThan(old.revision);
    expect(rebuilt.state).toBe('APPROVED');
    expect(Object.values(rebuilt.current.sideEffectConfirmations)).toEqual([true, true, true, true]);
    const read = rebuilt.current.verification.readVerification;
    expect(readCheckOf(READ_PROFILE_ID, read?.readCheckId)?.targetPagePath).toBe(MEMBER_LIST_PATH);
    expect(read?.verificationOnly).toBe(true);
    // 送る中身は同じ。
    expect(rebuilt.current.fieldNames).toEqual(old.current.fieldNames);
    expect(rebuilt.current.api).toEqual(old.current.api);
    expect(await rowOf(READ_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
    // 1: 中身が同じなら、もう一度始めても版は変わらない。
    await startChain(READ_PROFILE_ID);
    const again = scenarioOf(READ_PROFILE_ID, 'CREATE');
    expect(again.revision).toBe(rebuilt.revision);
    expect(again.state).toBe('APPROVED');
    expect(again.current.verification).toEqual(rebuilt.current.verification);
  });

  // 送る中身（ID の取り方）が変わる形: 同じ表の更新の画面がないうちにチェックした登録（送り先の path の後ろに `{id}` を足した、推した形の ID の取り方）。次の
  // 操作さがしで更新の画面が見つかると、ID の取り方は更新の画面の形になる。
  it('revokes the approval and asks for the check again when the sent content differs, so the screen is not handed to the write stage', async () => {
    await setUpProfile(SENT_PROFILE_ID);
    await discover(SENT_PROFILE_ID, documentWith([FORM_CREATE, searchOf('q')]));
    await check(SENT_PROFILE_ID, FORM_CREATE.identityDigest, true);
    const old = scenarioOf(SENT_PROFILE_ID, 'CREATE');
    expect(old.state).toBe('APPROVED');
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: SENT_PROFILE_ID })).toMatchObject({ writesOnCheckedScreens: true });
    await discover(SENT_PROFILE_ID, documentWith([FORM_CREATE, FORM_UPDATE, searchOf('q')]));
    expect(await rowOf(SENT_PROFILE_ID, FORM_CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
    await startChain(SENT_PROFILE_ID);
    const after = scenarioOf(SENT_PROFILE_ID, 'CREATE');
    expect(after.state).not.toBe('APPROVED');
    expect(after.current.verification.recordId).not.toEqual(old.current.verification.recordId);
    // 利用者向けの文は増やさない（今の「もう一度チェックが要る」の表示）。
    expect(await rowOf(SENT_PROFILE_ID, FORM_CREATE.identityDigest)).toMatchObject({ state: 'RECHECK_NEEDED' });
    // 書き込みの段の対象（チェックした画面）に入らない。
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: SENT_PROFILE_ID })).toMatchObject({ writesOnCheckedScreens: false });
    // もう一度チェックすれば、新しい版を承認する（チェックの保存の振る舞いは変えない）。
    await check(SENT_PROFILE_ID, FORM_CREATE.identityDigest, true);
    expect(scenarioOf(SENT_PROFILE_ID, 'CREATE').state).toBe('APPROVED');
    expect(await rowOf(SENT_PROFILE_ID, FORM_CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
  });

  // OP-T fix round 1: API の形で送る中身の形が変わると、計画は別の画面の扱いにする（古い承認済みの手順は、どの行にも結び付かない）。一覧でチェックとして
  // 出ない手順には書き込まないので、まとめて実行の始めに、その承認を取り消す。
  it('revokes the approved steps that no checked row shows (the API shape changed), so they are not handed to the write stage', async () => {
    await setUpProfile(UNLISTED_PROFILE_ID);
    await discover(UNLISTED_PROFILE_ID, createOnlyDocumentOf(CREATE));
    await check(UNLISTED_PROFILE_ID, CREATE.identityDigest, true);
    const old = scenarioOf(UNLISTED_PROFILE_ID, 'CREATE');
    expect(old.state).toBe('APPROVED');
    // 次の操作さがしで、同じ画面の送る欄が変わった（電話の欄が増えた。送る中身の形が変わる）。
    const changed = apiButtonWithFieldsOf(NEW_PATH, 'POST', 'select=*', [...BASE_SENT_FIELDS, { name: 'phone', selector: '#phone', type: 'tel', marker: 2 }],
      [...MARKERS, PHONE_MARKER]);
    expect(changed.identityDigest).toBe(CREATE.identityDigest);
    await discover(UNLISTED_PROFILE_ID, createOnlyDocumentOf(changed));
    // 一覧には、チェックとして出ない（古い手順は、この行に結び付かない）。
    expect(await rowOf(UNLISTED_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKABLE' });
    await startChain(UNLISTED_PROFILE_ID);
    const scenarios = withControlData((database) => listScenarios(database, UNLISTED_PROFILE_ID));
    expect(scenarios.find(({ scenarioId }) => scenarioId === old.scenarioId)?.state).toBe('REVOKED');
    expect(scenarios.filter(({ state: scenarioState }) => scenarioState === 'APPROVED')).toEqual([]);
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: UNLISTED_PROFILE_ID })).toMatchObject({ writesOnCheckedScreens: false });
    expect(await rowOf(UNLISTED_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKABLE' });
  });

  /** まとめて実行を始めた答え（改訂は古いので、ジョブの管理に渡れば、ジョブの管理が拒む）。 */
  const startChainAnswer = (profileId: string): Promise<{ readonly ok: boolean; readonly reason?: string }> =>
    valueOf('startStageChainFn', 'POST', { profileId, expectedRevision: STALE_REVISION, startNew: true });
  const jobCount = async (): Promise<number> => (await valueOf<readonly unknown[]>('listAuditJobsFn', 'GET')).length;
  /** 後の時刻（この時刻で承認し直した手順は、今の時刻では取り消せない。取り消しの口が、最後の変更より前の時刻を拒む）。 */
  const LATER_AT = '20991231000000';
  /** 承認した手順を、後の時刻で承認し直す（今の取り消しと承認の口。チェックの範囲の承認 `approveForCheck`）。 */
  const reapproveLater = async (profileId: string, scenarioId: string): Promise<void> => {
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      const stored = getProfile(database, profileId);
      const external = stored === null ? null : await approvalExternalFactsOf(stored, {
        database, repositoryRoot: rootOf().root, credentialStore: { readMetadata: () => Promise.resolve(null) },
      });
      if (external === null) {
        throw new Error('the external facts are not available');
      }
      const scenario = listScenarios(database, profileId).find((item) => item.scenarioId === scenarioId);
      expect(revokeScenarioApproval(database, {
        scenarioId, expectedRevision: scenario?.revision ?? 0, receiptId: randomUUID(), at: LATER_AT,
      })).toMatchObject({ ok: true });
      expect(approveForCheck(database, [scenarioId], external, () => LATER_AT)).toEqual({ ok: true });
    } finally {
      closeControlDatabase(database);
    }
  };
  /** API の形で、送る中身の形が変わった後の操作さがし（古い承認済みの手順は、どの行にも結び付かない）。 */
  const changeCreateShape = async (profileId: string): Promise<void> => {
    const changed = apiButtonWithFieldsOf(NEW_PATH, 'POST', 'select=*', [...BASE_SENT_FIELDS, { name: 'phone', selector: '#phone', type: 'tel', marker: 2 }],
      [...MARKERS, PHONE_MARKER]);
    await discover(profileId, createOnlyDocumentOf(changed));
  };

  // OP-T fix round 2（I-1）: 一覧に出ない承認を取り消せなかった（取り消しの口の誤り）ときは、開始を拒む（ジョブの管理に渡さない。ジョブを作らない）。
  it('refuses the start when the approvals that no checked row shows cannot be revoked', async () => {
    await setUpProfile(GUARD_PROFILE_ID);
    await discover(GUARD_PROFILE_ID, createOnlyDocumentOf(CREATE));
    await check(GUARD_PROFILE_ID, CREATE.identityDigest, true);
    const old = scenarioOf(GUARD_PROFILE_ID, 'CREATE');
    // 取り消しの口が誤りになる形: 後の時刻で承認し直した（今の時刻の取り消しは、最後の変更より前の時刻なので拒まれる）。
    await reapproveLater(GUARD_PROFILE_ID, old.scenarioId);
    await changeCreateShape(GUARD_PROFILE_ID);
    const jobsBefore = await jobCount();
    expect(await startChainAnswer(GUARD_PROFILE_ID)).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    expect(await jobCount()).toBe(jobsBefore);
    expect(scenarioOf(GUARD_PROFILE_ID, 'CREATE').state).toBe('APPROVED');
  });

  // OP-T fix round 2（Minor 2）: 承認の判定の事実を読めない（ターゲットの設定のファイルがない）ときは、チェックを消さずに開始を拒む。
  it('keeps the checks and refuses the start when the facts for the approval cannot be read', async () => {
    await setUpProfile(FACTS_PROFILE_ID);
    await discover(FACTS_PROFILE_ID, createOnlyDocumentOf(CREATE));
    await check(FACTS_PROFILE_ID, CREATE.identityDigest, true);
    const old = scenarioOf(FACTS_PROFILE_ID, 'CREATE');
    expect(old.state).toBe('APPROVED');
    const targetFile = `${rootOf().root}/local/targets/${FACTS_PROFILE_ID}.json`;
    const movedFile = `${targetFile}.moved`;
    renameSync(targetFile, movedFile);
    try {
      expect(await startChainAnswer(FACTS_PROFILE_ID)).toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    } finally {
      renameSync(movedFile, targetFile);
    }
    const after = scenarioOf(FACTS_PROFILE_ID, 'CREATE');
    expect(after.state).toBe('APPROVED');
    expect(after.revision).toBe(old.revision);
    expect(await rowOf(FACTS_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
  });

  // OP-T fix round 2（I-2）: 1 つの登録に、承認済みの更新が 2 つ結び付く（更新の送る中身の形が変わり、チェックし直して新しい更新ができた）。行に出ていない更新は、
  // まとめて実行の始めに取り消す（書き込みの段の対象は、登録の台帳に結ぶ承認済みの最初の更新なので、行が出している更新だけが残る）。
  it('revokes the approved updates of a checked screen other than the one the row shows', async () => {
    await setUpProfile(UPDATES_PROFILE_ID);
    await discover(UPDATES_PROFILE_ID, documentOf());
    await check(UPDATES_PROFILE_ID, CREATE.identityDigest, true);
    const create = scenarioOf(UPDATES_PROFILE_ID, 'CREATE');
    const oldUpdate = scenarioOf(UPDATES_PROFILE_ID, 'UPDATE');
    expect([create.state, oldUpdate.state]).toEqual(['APPROVED', 'APPROVED']);
    // 次の操作さがしで、更新の画面の送る欄が変わった。チェックを外さずに、もう一度チェックする（新しい更新を作って承認する）。
    const changedUpdate = apiButtonWithFieldsOf(EDIT_PATH, 'PATCH', 'id=eq.1&select=*',
      [...BASE_SENT_FIELDS, { name: 'phone', selector: '#phone', type: 'tel', marker: 2 }], [...MARKERS, PHONE_MARKER]);
    const base = documentOf();
    await discover(UPDATES_PROFILE_ID, {
      ...base,
      pages: base.pages.map((page) => (page.state === 'READ' && page.record.location?.path === EDIT_PATH
        ? { ...page, record: { ...page.record, candidates: [changedUpdate] } }
        : page)),
    });
    await check(UPDATES_PROFILE_ID, CREATE.identityDigest, true);
    const approvedUpdatesOf = () => withControlData((database) => listScenarios(database, UPDATES_PROFILE_ID))
      .filter(({ current, state: scenarioState }) => current.kind === 'UPDATE' && scenarioState === 'APPROVED')
      .map(({ scenarioId }) => scenarioId);
    const before = approvedUpdatesOf();
    expect(before).toHaveLength(2);
    expect(before).toContain(oldUpdate.scenarioId);
    const newUpdateId = before.find((id) => id !== oldUpdate.scenarioId);
    await startChain(UPDATES_PROFILE_ID);
    // 行に出ていない（古い形の）更新は取り消され、行が出している更新だけが承認済みで残る（書き込みの段の対象は、この 1 つだけ）。
    expect(approvedUpdatesOf()).toEqual([newUpdateId]);
    expect(scenarioOf(UPDATES_PROFILE_ID, 'CREATE').state).toBe('APPROVED');
    expect(await rowOf(UPDATES_PROFILE_ID, CREATE.identityDigest)).toMatchObject({ state: 'CHECKED' });
  });

  it('rebuilds the steps of a form screen when the check is put again (OP-S, the form shape)', async () => {
    await setUpProfile(FORM_PROFILE_ID);
    await discover(FORM_PROFILE_ID, documentWith([FORM_CREATE, FORM_UPDATE, searchOf('q')]));
    await check(FORM_PROFILE_ID, FORM_CREATE.identityDigest, true);
    const old = scenarioOf(FORM_PROFILE_ID, 'CREATE');
    expect(old.state).toBe('APPROVED');
    expect(old.current.verification.readVerification?.bindings.map(({ parameterName }) => parameterName)).toEqual(['q']);
    // 次の操作さがしで、検索の送る値の名前が変わった（照合の READ だけが違う）。チェックを外して入れ直す。
    await discover(FORM_PROFILE_ID, documentWith([FORM_CREATE, FORM_UPDATE, searchOf('keyword')]));
    await check(FORM_PROFILE_ID, FORM_CREATE.identityDigest, false);
    await check(FORM_PROFILE_ID, FORM_CREATE.identityDigest, true);
    const rebuilt = scenarioOf(FORM_PROFILE_ID, 'CREATE');
    expect(rebuilt.scenarioId).toBe(old.scenarioId);
    expect(rebuilt.revision).toBeGreaterThan(old.revision);
    expect(rebuilt.state).toBe('APPROVED');
    const read = rebuilt.current.verification.readVerification;
    expect(read?.bindings.map(({ parameterName }) => parameterName)).toEqual(['keyword']);
    expect(read?.verificationOnly).toBe(true);
    expect(read?.readCheckId).not.toBe(old.current.verification.readVerification?.readCheckId);
    expect(readCheckOf(FORM_PROFILE_ID, read?.readCheckId)?.parameters).toEqual({ keyword: '' });
    // 送る欄と ID の取り方は同じ。
    expect(rebuilt.current.fieldNames).toEqual(old.current.fieldNames);
    expect(rebuilt.current.verification.recordId).toEqual(old.current.verification.recordId);
  });
});
