/**
 * FM2b（手を減らす段 2 の設計書 3A.2、3A.3。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））: 発見の画面の「シナリオの下書きを作る」と、その案内から
 * 開く作成の画面、シナリオの画面の推測の項目を、ビルドした画面のサーバ（一時の root）で確かめる。監査のワーカーは、偽のワーカー（`discovery`。
 * サイトに接続しない）で、最後の発見のジョブ（API の登録と更新の型を持つ候補と、読めた画面）を作る。
 * - ボタン: 押すと、作るもの（登録の下書き・推した値の印と根拠・照合の READ の定義の予定・入力の規則・更新の案内）を確認のダイアログで出し、確認の後に
 *   だけ作る（取り消すと何も作らない）。作った下書きは `DRAFT` で、副作用の確認は偽（承認・実行の許可は作らない）。もう一度押すと「既にある」。
 * - 更新は作らない。リンクの先の作成の画面は、台帳と更新の画面の型を前もって選び、変える欄を人が選ぶ案内を出す。保存の後に、推した規則を付ける。
 * - シナリオの画面に、推した値のまま残る項目と根拠を出し、承認のダイアログにも出す。
 * - 最後の発見の時の改訂と今の改訂が違えば、押せず、理由と次にできることを出す。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件（サイトへの要求が出ない）。目印の値は画面に出ない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。Chromium は headless だけ。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listScenarios, readScenario } from '../../../src/control/approval/scenario-store.js';
import { readLatestRuleSet } from '../../../src/control/data-rules/rule-store.js';
import { listReadChecks } from '../../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { apiRequestShapeOf } from '../../../src/core/api-request-shape.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../../src/discovery/fingerprint.js';
import { observedSubmissionProbeOf } from '../../../src/discovery/submission-probe-contracts.js';
import { DRAFT_VALUE_ORIGIN_CATALOG } from '../../../src/presentation/catalog.js';
import { DRAFT_VALUE_TEXT, LOCAL_UI_AUTO_DRAFT_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { NO_JS_BINDING, sampleButton } from '../../../tests/unit/discovery-candidate-samples.js';
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
import { createUiPageKit } from './helpers/ui-page.ts';

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
const PROFILE_ID = 'fm2b-auto';
const OUTPUT = 'fm2b-auto-output';
const FIRST_REVISION = 1;
const SCREENSHOT_DIRECTORY = process.env['FM2B_SCREENSHOT_DIR'];
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
/** probe の目印（値。シナリオと画面には出ない）。 */
const MARKERS = ['bsprobe0000000000fm2a', 'bsprobe0000000000fm2b@example.invalid'];
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
/** 読めた会員の詳しい画面（照合の READ の `{id}` の型を推す元）。 */
const DETAIL_PATH = '/admin/members/12';
const TEMPLATE = '/admin/members/{id}';
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
const apiButtonOf = (pagePath: string, method: 'POST' | 'PATCH', query: string): DiscoveryCandidate => {
  const shape = apiRequestShapeOf({
    method,
    resourceType: 'fetch',
    url: `${API_SERVICE_ORIGIN}/rest/v1/members?${query}`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1] }) },
  }, { pagePath, markers: MARKERS });
  return {
    ...candidateOf(sampleButton({ page: { origin: ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
    submissionProbe: observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
      { filledFieldCount: 2, skippedFieldCount: 0 }, [
        { name: 'name', selector: '#name', type: 'text', marker: 0 },
        { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
      ]),
  };
};
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

const installFakeDiscovery = (): void => {
  const directory = `${rootOf().root}/fake-workers/${OUTPUT}`;
  mkdirSync(directory, { recursive: true });
  const document = documentOf();
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
  environmentEvidenceRef: 'fm2b-evidence',
});

const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  state.targetPath = 'local/targets/fm2b-auto.json';
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
  expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(FIRST_REVISION) })).toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', {
    setup: {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId: PROFILE_ID,
      profileRevision: FIRST_REVISION,
      loginStartUrl: `${ORIGIN}/login`,
      loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
      successCondition: { pathPrefix: '/admin', selector: null },
      sessionLostCondition: { pathPrefix: null },
      excludedPaths: ['/admin/logout'],
      auditPathPrefixes: ['/admin'],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
    },
  })).toMatchObject({ ok: true });
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

describe('FM2b: the scenario drafts made by one press on the discovery screen', () => {
  it('registers the Server Functions and rejects the inputs that do not match the schemas', async () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining(['scenarioAutoDraftPreviewFn', 'createScenarioAutoDraftsFn', 'attachAutoDraftRulesFn']));
    for (const [name, data] of [
      ['createScenarioAutoDraftsFn', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION }],
      ['createScenarioAutoDraftsFn', { profileId: PROFILE_ID, expectedRevision: 0, discoveryJobId: 'job-x' }],
      ['attachAutoDraftRulesFn', { scenarioId: '../x', expectedRevision: 1 }],
    ] as const) {
      expect((await call(name, 'POST', data)).response.status, name).toBe(STATUS.BAD_REQUEST);
    }
    expect(withControlData((database) => listScenarios(database, PROFILE_ID))).toEqual([]);
  });

  it('shows what it makes in the confirmation dialog, makes nothing on cancel, and makes the drafts after the confirmation', async () => {
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const panel = page.getByTestId('auto-draft-panel');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByTestId('auto-draft-blocker').count()).toBe(0);
    await tabTo(page, panel.getByTestId('auto-draft-open'));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    // 開いたときは取り消し側にフォーカス（Enter で作らない）。
    expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toBe(text.dialog.cancel);
    const create = dialog.getByTestId('auto-draft-preview-create');
    expect(await create.getAttribute('data-status')).toBe('NEW');
    expect(await create.getByTestId('auto-draft-record-id-key').getAttribute('data-value')).toBe('id');
    expect(await create.getByTestId('auto-draft-record-id-key').getByTestId('draft-value-mark').getAttribute('data-ground')).toBe('RECORD_ID_KEY_FROM_UPDATE_FILTER');
    expect(await create.getByTestId('auto-draft-record-id-key').textContent()).toContain(DRAFT_VALUE_ORIGIN_CATALOG.INFERRED.label);
    expect(await create.getByTestId('auto-draft-preview-read-check').getAttribute('data-outcome')).toBe('CREATED');
    expect(await create.getByTestId('auto-draft-preview-read-check').textContent()).toContain(TEMPLATE);
    expect(await dialog.getByTestId('auto-draft-preview-update').getAttribute('data-status')).toBe('NEEDS_CHANGED_FIELDS');
    await screenshot(page, 'fm2b-01-dialog');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS });
    expect(withControlData((database) => listScenarios(database, PROFILE_ID))).toEqual([]);

    await panel.getByTestId('auto-draft-open').click();
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.dialog.confirm, exact: true }).click();
    const result = panel.getByTestId('auto-draft-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    const created = result.getByTestId('auto-draft-result-create');
    expect(await created.getAttribute('data-status')).toBe('CREATED');
    state.createId = (await created.getAttribute('data-scenario-id')) ?? '';
    // FM2R の Minor 9: 自動の下書きが作ったシナリオの id は、推測の印の出どころの頭を持つ。
    expect(state.createId.startsWith('auto-')).toBe(true);
    expect(await created.getByTestId('auto-draft-read-check').getAttribute('data-outcome')).toBe('CREATED');
    expect(await created.getByTestId('auto-draft-expectation').count()).toBe(1);
    expect(await created.getByTestId('auto-draft-rules').getAttribute('data-attached')).toBe('true');
    const update = result.getByTestId('auto-draft-result-update');
    expect(await update.getAttribute('data-status')).toBe('NEEDS_CHANGED_FIELDS');
    // 作る順: 登録を先に保存したので、更新の台帳の案はその登録（結び付く登録が 1 つ）。
    expect(await update.getByTestId('auto-draft-preset-ledger').getAttribute('data-value')).toBe(state.createId);
    expect(await update.getByTestId('auto-draft-preset-ledger').getByTestId('draft-value-mark').getAttribute('data-ground')).toBe('SINGLE_BOUND_LEDGER');
    await screenshot(page, 'fm2b-02-result');

    // 管理データ: 登録の下書きだけ（更新は作らない）。`DRAFT`、副作用の確認はすべて偽、承認の記録なし。推した規則を付け、`{id}` の型の定義を作った。
    const saved = withControlData((database) => ({
      scenarios: listScenarios(database, PROFILE_ID),
      rules: readLatestRuleSet(database, state.createId),
      readChecks: listReadChecks(database, PROFILE_ID),
    }));
    expect(saved.scenarios.map(({ scenarioId, state: scenarioState, current }) => [scenarioId, scenarioState, current.kind]))
      .toEqual([[state.createId, 'DRAFT', 'CREATE']]);
    const [scenario] = saved.scenarios;
    expect(Object.values(scenario?.current.sideEffectConfirmations ?? {})).toEqual([false, false, false, false]);
    expect(scenario?.lastApprovalReceiptId).toBeNull();
    expect(scenario?.current.api?.recordId).toEqual({ source: 'RESPONSE_BODY_KEY', key: 'id' });
    expect(scenario?.current.inputRuleReference).not.toBeNull();
    expect(saved.rules?.ruleSet.fieldRules.map(({ fieldName }) => fieldName)).toEqual(['email', 'name']);
    expect(saved.readChecks.map(({ definition }) => definition.targetPagePath)).toEqual([TEMPLATE]);
    // 期待の欄は、規則の後に、実行のたびに変わる欄から推して、照合の READ に結んだ（推測の印つき）。
    const expectation = created.getByTestId('auto-draft-expectation');
    expect(await expectation.getByTestId('draft-value-mark').getAttribute('data-ground')).toBe('READ_EXPECTATION_FROM_VARYING_FIELD');
    const read = scenario?.current.verification.readVerification;
    expect(read?.readCheckId).toBe(saved.readChecks[0]?.readCheckId);
    expect(read?.bindings).toEqual([]);
    expect(read?.expectations).toEqual([{ kind: 'TEXT_CONTAINS', fieldName: await expectation.getAttribute('data-value') }]);
    // 目印の値は、画面に出ない。
    const body = await page.content();
    for (const marker of MARKERS) {
      expect(body.includes(marker), marker).toBe(false);
    }
  });

  it('lists the existing draft on the second press and makes nothing new', async () => {
    const preview = await valueOf<{ creates: readonly { status: string; scenarioId: string | null }[]; updates: readonly { status: string }[] }>(
      'scenarioAutoDraftPreviewFn', 'GET', { profileId: PROFILE_ID },
    );
    expect(preview.creates).toEqual([expect.objectContaining({ status: 'EXISTING', scenarioId: state.createId })]);
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    await page.getByTestId('auto-draft-open').click();
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await dialog.getByTestId('auto-draft-preview-create').getAttribute('data-status')).toBe('EXISTING');
    expect(await dialog.getByTestId('auto-draft-preview-create').textContent()).toContain(text.createStatuses.EXISTING);
    await dialog.getByRole('button', { name: text.dialog.confirm, exact: true }).click();
    await page.getByTestId('auto-draft-result').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auto-draft-result-create').getAttribute('data-status')).toBe('EXISTING');
    expect(withControlData((database) => listScenarios(database, PROFILE_ID)).length).toBe(1);
    expect(withControlData((database) => listReadChecks(database, PROFILE_ID)).length).toBe(1);
  });

  it('opens the create form of the update with the ledger and the template chosen beforehand, and attaches the inferred rules after the save', async () => {
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    await page.getByTestId('auto-draft-open').click();
    const dialog = page.getByRole('dialog', { name: text.dialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: text.dialog.confirm, exact: true }).click();
    const link = page.getByTestId('auto-draft-result-update').getByTestId('auto-draft-open-create-form');
    await link.waitFor({ timeout: UI_TIMEOUT_MS });
    await tabTo(page, link);
    await page.keyboard.press('Enter');
    const guide = page.getByTestId('auto-draft-form-guide');
    await guide.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await guide.textContent()).toContain(text.form.chooseChangedFields);
    expect(await guide.getByTestId('auto-draft-form-preset-ledger').getAttribute('data-value')).toBe(state.createId);
    expect(await guide.getByTestId('auto-draft-form-preset-template').getByTestId('draft-value-mark').getAttribute('data-ground')).toBe('ONLY_FORM_PATH_TEMPLATE');
    expect(await page.locator('select[name="api-ledger"]').inputValue()).toBe(state.createId);
    expect(await page.locator('select[name="api-formPathTemplate"]').inputValue()).toBe('/admin/members/{id}/edit');
    // 変える鍵は人が選ぶ（既定はすべて保つ）。
    expect(await page.locator('[data-testid="scenario-api-key"][data-role="CHANGE"]').count()).toBe(0);
    await screenshot(page, 'fm2b-03-update-form');
    await page.locator('input[data-api-role="name"][value="CHANGE"]').check();
    for (const side of SIDE_EFFECTS) {
      await page.locator(`input[data-side-effect="${side}"]`).check();
    }
    await page.getByTestId('scenario-save').click();
    await page.waitForURL(new RegExp(`/scenarios/${PROFILE_ID}/[a-z0-9-]+\\?notice=autoRules$`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-notice').textContent()).toBe(text.savedWithRules);
    const updateId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const saved = withControlData((database) => ({ scenario: readScenario(database, updateId), rules: readLatestRuleSet(database, updateId) }));
    expect(saved.scenario?.current).toMatchObject({ kind: 'UPDATE', fieldNames: ['name'], api: { ledger: { targetCreateScenarioId: state.createId } } });
    expect(saved.scenario?.state).toBe('DRAFT');
    expect(saved.rules).not.toBeNull();
    // 導線の外（印なしの URL）で作った更新には、規則を付けない。付け直しも拒む。
    expect(await valueOf('attachAutoDraftRulesFn', 'POST', { scenarioId: updateId, expectedRevision: saved.scenario?.revision ?? 0 }))
      .toEqual({ ok: false, reason: 'AUTO_RULES_ALREADY_SET' });
  });

  it('shows the inferred items and their grounds on the scenario screen and in the approval dialog', async () => {
    const page = await openPage(`/scenarios/${PROFILE_ID}/${state.createId}`);
    const inferred = page.getByTestId('scenario-inferred');
    await inferred.waitFor({ timeout: UI_TIMEOUT_MS });
    const items = await inferred.locator('li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item')));
    expect(items).toEqual(['RECORD_ID_KEY', 'READ_PAGE_TEMPLATE', 'READ_EXPECTATION']);
    expect(await inferred.textContent()).toContain(DRAFT_VALUE_TEXT.grounds.RECORD_ID_KEY_FROM_UPDATE_FILTER);
    // 副作用を確かめていない下書きは、承認のボタンを出さない（人が「変える」で確かめる）。
    expect(await page.getByTestId('scenario-approve').count()).toBe(0);
    await screenshot(page, 'fm2b-04-inferred');
    // 人が副作用を確かめて版を上げる（今の変更の口）。推測の項目は残り、承認のダイアログにも出る。
    const current = withControlData((database) => readScenario(database, state.createId)?.current);
    if (current?.api === undefined) {
      throw new Error('the API scenario was not found');
    }
    expect(await valueOf('updateScenarioFn', 'POST', {
      scenarioId: state.createId,
      expectedRevision: withControlData((database) => readScenario(database, state.createId)?.revision ?? 0),
      draft: {
        transport: 'API',
        fieldNames: [...current.fieldNames],
        readChecks: [],
        sideEffectConfirmations: Object.fromEntries(SIDE_EFFECTS.map((item) => [item, true])),
        limits: { ...current.limits },
        approvalTtlDays: current.approvalTtlDays,
        verification: structuredClone(current.verification),
        api: {
          shapeDigest: current.api.shapeDigest,
          pageKeys: current.api.pageKeys.map(({ key }) => key),
          filterName: current.api.filterName,
          recordId: current.api.recordId,
          ledger: null,
        },
      },
    })).toMatchObject({ ok: true });
    const detail = await openPage(`/scenarios/${PROFILE_ID}/${state.createId}`);
    await detail.getByTestId('scenario-approve').waitFor({ timeout: UI_TIMEOUT_MS });
    await detail.getByTestId('scenario-approve').click();
    const dialog = detail.getByRole('dialog', { name: LOCAL_UI_SCENARIO_TEXT.approveDialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await dialog.getByTestId('scenario-approve-inferred').locator('li').count()).toBe(3);
    expect(await dialog.textContent()).toContain(text.approveInferredHeading);
    await screenshot(detail, 'fm2b-05-approve-inferred');
    // 承認はしない（取り消す）。
    await dialog.getByRole('button', { name: LOCAL_UI_SCENARIO_TEXT.approveDialog.cancel, exact: true }).click();
    expect(withControlData((database) => readScenario(database, state.createId)?.state)).toBe('DRAFT');

    // FM2R の Minor 9: 人が作ったシナリオに、人が推しと同じ値（応答の鍵 `id` と同じ照合の READ）を入れても、推測の印は出さない。
    const byPerson = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
      draft: {
        profileId: PROFILE_ID,
        candidateIdentityDigest: withControlData((database) => readScenario(database, state.createId)?.current.candidate.identityDigest),
        transport: 'API',
        fieldNames: [...current.fieldNames],
        readChecks: [],
        sideEffectConfirmations: Object.fromEntries(SIDE_EFFECTS.map((item) => [item, false])),
        limits: { ...current.limits },
        approvalTtlDays: current.approvalTtlDays,
        verification: structuredClone(current.verification),
        api: {
          shapeDigest: current.api.shapeDigest, pageKeys: current.api.pageKeys.map(({ key }) => key), filterName: null, recordId: current.api.recordId, ledger: null,
        },
      },
    });
    expect(byPerson.ok).toBe(true);
    expect(await valueOf<{ inferredItems: readonly unknown[] }>('scenarioDetailPageFn', 'GET', { scenarioId: byPerson.scenarioId }))
      .toMatchObject({ inferredItems: [] });
    expect((await valueOf<{ inferredItems: readonly unknown[] }>('scenarioDetailPageFn', 'GET', { scenarioId: state.createId })).inferredItems).toHaveLength(3);
  });

  it('cannot be pressed when the profile revision is not the one of the latest discovery, and tells the reason and the next step', async () => {
    expect(await valueOf('updateProfileFn', 'POST', { profile: profileDocument(FIRST_REVISION + 1), expectedRevision: FIRST_REVISION }))
      .toMatchObject({ ok: true });
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const blocker = page.getByTestId('auto-draft-blocker');
    await blocker.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await blocker.getAttribute('data-reason')).toBe('DISCOVERY_STALE');
    expect(await blocker.textContent()).toContain(text.blockers.DISCOVERY_STALE.action);
    expect(await page.getByTestId('auto-draft-open').isDisabled()).toBe(true);
    await screenshot(page, 'fm2b-06-stale');
    // サーバも作らない（画面を通さない要求）。
    const before = withControlData((database) => listScenarios(database, PROFILE_ID).length);
    const preview = await valueOf<{ discoveryJobId: string | null }>('scenarioAutoDraftPreviewFn', 'GET', { profileId: PROFILE_ID });
    expect(await valueOf('createScenarioAutoDraftsFn', 'POST', {
      profileId: PROFILE_ID, expectedRevision: FIRST_REVISION + 1, discoveryJobId: preview.discoveryJobId ?? 'job-none',
    })).toEqual({ ok: false, blocker: 'DISCOVERY_STALE' });
    expect(withControlData((database) => listScenarios(database, PROFILE_ID).length)).toBe(before);
  });
});
