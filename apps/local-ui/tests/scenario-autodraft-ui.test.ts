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
import { formatInteger } from '../../../src/presentation/format.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listScenarios, readScenario } from '../../../src/control/approval/scenario-store.js';
import { readLatestRuleSet } from '../../../src/control/data-rules/rule-store.js';
import { EXTERNAL_NOTIFICATION_AT_APPROVAL, planRuleSet, varyingFieldNamesOf } from '../../../src/control/data-rules-view.js';
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
import { DRAFT_VALUE_TEXT, LOCAL_UI_AUTO_DRAFT_TEXT, LOCAL_UI_SCENARIO_TEXT, LOCAL_UI_WRITE_STAGE_TEXT } from '../../../src/presentation/messages.js';
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
import { createProfileInStore, saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
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
/** PL-D2: 作る前に開いておいた、もう 1 つのタブ（記録しないで開き、使う場面で記録に入れる。各テストの後に閉じないため）。 */
let otherTab: Page | undefined;

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

const { openPage, recordPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
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
  // MI-F1（設計書 4.7.1 の 1）: 承認したサービスの Origin は、画面の作成の口では受けない（手動のログインの観察だけが足す）。テストの準備は、観察の後の形の
  // プロファイルを保存の部品で直接作る。
  expect(await createProfileInStore(root.root, profileDocument(FIRST_REVISION))).toMatchObject({ ok: true });
  expect(await saveAuthSetupRequestInStore(root, {
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
    expect([...ids.keys()]).toEqual(expect.arrayContaining(['scenarioAutoDraftPreviewFn', 'createScenarioAutoDraftsFn']));
    // PL-5 の修正の 1 回目: 規則を付ける口は、保存の口がすべての保存で付けるので捨てた。
    expect(ids.has('attachAutoDraftRulesFn')).toBe(false);
    for (const [name, data] of [
      ['createScenarioAutoDraftsFn', { profileId: PROFILE_ID, expectedRevision: FIRST_REVISION }],
      ['createScenarioAutoDraftsFn', { profileId: PROFILE_ID, expectedRevision: 0, discoveryJobId: 'job-x' }],
    ] as const) {
      expect((await call(name, 'POST', data)).response.status, name).toBe(STATUS.BAD_REQUEST);
    }
    expect(withControlData((database) => listScenarios(database, PROFILE_ID))).toEqual([]);
  });

  // PL-U の修正の 1 回目（設計書 14.1 の判断、U3）: 確認のダイアログはなくした（1 回の押下で作る。下書きは何も送らず、書き込みの OK の前に中身を見られる）。
  // 前の「確認のダイアログに作るものを出し、やめると何も作らない」の場面は、ダイアログがないので消した。作ったものは、結果の 1 行と一覧で確かめる。
  it('makes the drafts by one press without a dialog, and tells what it made in one line and in the list', async () => {
    // PL-D2: 作る前の画面を、もう 1 つのタブで開いておく（次の場面で、このタブから押す）。
    otherTab = await context?.newPage();
    await otherTab?.goto(`${started().origin}/discovery/${PROFILE_ID}`, { waitUntil: 'networkidle' });
    await otherTab?.getByTestId('auto-draft-open').waitFor({ timeout: UI_TIMEOUT_MS });
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const panel = page.getByTestId('auto-draft-panel');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByTestId('auto-draft-blocker').count()).toBe(0);
    expect(withControlData((database) => listScenarios(database, PROFILE_ID))).toEqual([]);
    await tabTo(page, panel.getByTestId('auto-draft-open'));
    await page.keyboard.press('Enter');
    const result = panel.getByTestId('auto-draft-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByRole('dialog').count()).toBe(0);
    // 結果の 1 行（作った書き込みの手順の数）。一覧には、画面と「下書きを作りました」。
    expect(await result.getByTestId('auto-draft-created-count').textContent()).toBe(text.createdCount(formatInteger(1)));
    const created = result.getByTestId('auto-draft-result-create');
    expect(await created.textContent()).toContain(`${NEW_PATH}: ${text.createdStatus}`);
    // PL-5（3 章の 2）: 結果の一覧は、画面と作ったかだけ（推した ID の項目・答え合わせの型・送り方の形は出さない）。
    expect(await result.textContent()).not.toContain(TEMPLATE);
    expect(await created.getAttribute('data-status')).toBe('CREATED');
    state.createId = (await created.getAttribute('data-scenario-id')) ?? '';
    // FM2R の Minor 9: 自動の下書きが作ったシナリオの id は、推測の印の出どころの頭を持つ。
    expect(state.createId.startsWith('auto-')).toBe(true);
    // PL-5: 入れる値の決まりを付けられなかったときだけ、その 1 行を出す（付けたので出さない）。
    expect(await created.getByTestId('auto-draft-rules-failed').count()).toBe(0);
    const update = result.getByTestId('auto-draft-result-update');
    // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10、規則 F）: 更新の変える鍵は BeakSight が決め、登録を保存した後の文脈で、台帳（結び付く
    // 登録が 1 つ）と型を決めて、更新の下書きも保存する（前は、人が作成の画面で変える鍵を選んだ）。作成の画面へのリンクは出さない。
    expect(await update.getAttribute('data-status')).toBe('CREATED');
    expect(await update.getByTestId('auto-draft-open-create-form').count()).toBe(0);
    await screenshot(page, 'fm2b-02-result');

    // 管理データ: 登録の下書きと、規則 F の更新の下書き（OP-2）。`DRAFT`、副作用の確認はすべて偽、承認の記録なし。推した規則を付け、`{id}` の型の定義を作った。
    const saved = withControlData((database) => ({
      scenarios: listScenarios(database, PROFILE_ID),
      rules: readLatestRuleSet(database, state.createId),
      readChecks: listReadChecks(database, PROFILE_ID),
    }));
    expect(saved.scenarios.map(({ state: scenarioState, current }) => [scenarioState, current.kind]).sort())
      .toEqual([['DRAFT', 'CREATE'], ['DRAFT', 'UPDATE']]);
    const scenario = saved.scenarios.find(({ scenarioId }) => scenarioId === state.createId);
    expect(Object.values(scenario?.current.sideEffectConfirmations ?? {})).toEqual([false, false, false, false]);
    expect(scenario?.lastApprovalReceiptId).toBeNull();
    expect(scenario?.current.api?.recordId).toEqual({ source: 'RESPONSE_BODY_KEY', key: 'id' });
    expect(scenario?.current.inputRuleReference).not.toBeNull();
    expect(saved.rules?.ruleSet.fieldRules.map(({ fieldName }) => fieldName)).toEqual(['email', 'name']);
    expect(saved.readChecks.map(({ definition }) => definition.targetPagePath)).toEqual([TEMPLATE]);
    // 期待の欄は、規則の後に、実行のたびに変わる欄から推して、照合の READ に結んだ（推測の印は詳細の値。PL-5: 確認の結果には出さない）。
    const read = scenario?.current.verification.readVerification;
    expect(read?.readCheckId).toBe(saved.readChecks[0]?.readCheckId);
    expect(read?.bindings).toEqual([]);
    expect((await valueOf<{ inferredItems: readonly { item: string; ground: string; value: string }[] }>('scenarioDetailPageFn', 'GET', { scenarioId: state.createId }))
      .inferredItems.find(({ item }) => item === 'READ_EXPECTATION')).toMatchObject({ ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' });
    // MI-C（MI-6 の報告の片付け）: 期待の欄は、承認の前の画面と同じ判定の前提（副作用を承認のダイアログで確認する前提 `EXTERNAL_NOTIFICATION_AT_APPROVAL`）で、
    // 実行のたびに変わる欄から推す（確認のない下書きでも、メールの欄を変わる欄に数える）。
    if (scenario === undefined || saved.rules === null) {
      throw new Error('the automatic draft or its rules were not saved');
    }
    const varyingAtApproval = varyingFieldNamesOf(planRuleSet(saved.rules.ruleSet, scenario.current, scenario.evidence, undefined, {
      notificationConfirmation: EXTERNAL_NOTIFICATION_AT_APPROVAL,
    }));
    expect(varyingAtApproval).toContain('email');
    expect(read?.expectations).toEqual([{ kind: 'TEXT_CONTAINS', fieldName: scenario.current.fieldNames.find((name) => varyingAtApproval.includes(name)) }]);
    // 目印の値は、画面に出ない。
    const body = await page.content();
    for (const marker of MARKERS) {
      expect(body.includes(marker), marker).toBe(false);
    }
  });

  // PL-D2: 作った書き込みの手順が 0 個のときは、「0 個作りました」ではなく、作らなかったことが分かる 1 行を出す（作る前に開いておいたタブから押す）。
  it('tells in one line that it made nothing when the drafts were already made from another tab', async () => {
    if (otherTab === undefined) {
      throw new Error('the other tab was not opened');
    }
    await recordPage(otherTab);
    const panel = otherTab.getByTestId('auto-draft-panel');
    await tabTo(otherTab, panel.getByTestId('auto-draft-open'));
    await otherTab.keyboard.press('Enter');
    const result = panel.getByTestId('auto-draft-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await result.getByTestId('auto-draft-created-count').textContent()).toBe(text.noneCreated);
    expect(await result.getByTestId('auto-draft-result-create').getAttribute('data-status')).toBe('EXISTING');
    // OP-2: 登録と、規則 F の更新の 2 つのまま（作り直さない）。
    expect(withControlData((database) => listScenarios(database, PROFILE_ID)).length).toBe(2);
  });

  it('lists the existing draft on the second press and makes nothing new', async () => {
    const preview = await valueOf<{ creates: readonly { status: string; scenarioId: string | null }[]; updates: readonly { status: string }[] }>(
      'scenarioAutoDraftPreviewFn', 'GET', { profileId: PROFILE_ID },
    );
    expect(preview.creates).toEqual([expect.objectContaining({ status: 'EXISTING', scenarioId: state.createId })]);
    // PL-5（設計書 3 章の 1）: 作ってあるときは、要点に「作ってあります」と主のボタン「書き込みの手順を見る」を出し、もう一度作るボタンは出さない。
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    await page.getByTestId('discovery-drafted').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('auto-draft-open').count()).toBe(0);
    expect(await page.getByTestId('discovery-open-scenarios').getAttribute('href')).toBe(`/scenarios/${PROFILE_ID}`);
    // 画面を通さずにもう一度作っても、既にある（何も作らない）。
    const again = await valueOf<{ ok: boolean; creates: readonly { status: string }[] }>('createScenarioAutoDraftsFn', 'POST', {
      profileId: PROFILE_ID, expectedRevision: FIRST_REVISION, discoveryJobId: (await valueOf<{ discoveryJobId: string }>('scenarioAutoDraftPreviewFn', 'GET', {
        profileId: PROFILE_ID,
      })).discoveryJobId,
    });
    expect(again).toMatchObject({ ok: true, creates: [{ status: 'EXISTING' }] });
    expect(withControlData((database) => listScenarios(database, PROFILE_ID)).length).toBe(2);
    expect(withControlData((database) => listReadChecks(database, PROFILE_ID)).length).toBe(1);
  });

  // OP-2（設計書 4.1 の D10）: 前は、作成の画面で人が変える鍵を選んで保存した。今は、自動の下書きが規則 F で決めた更新を保存する。前の作成の画面の確かめと同じ
  // 値（変える鍵、台帳、写した照合の READ、推した規則）を、保存した更新の下書きで確かめる。
  it('saved the update with the changed key chosen by rule F, the ledger, the copied READ verification and the inferred rules', async () => {
    const [templateCheck] = withControlData((database) => listReadChecks(database, PROFILE_ID));
    const updateId = withControlData((database) => listScenarios(database, PROFILE_ID)).find(({ current }) => current.kind === 'UPDATE')?.scenarioId ?? '';
    const saved = withControlData((database) => ({ scenario: readScenario(database, updateId), rules: readLatestRuleSet(database, updateId) }));
    expect(saved.scenario?.current).toMatchObject({ kind: 'UPDATE', fieldNames: ['name'], api: { ledger: { targetCreateScenarioId: state.createId } } });
    expect(saved.scenario?.state).toBe('DRAFT');
    expect(saved.rules).not.toBeNull();
    // MI-7: 保存した照合の READ は、台帳の定義の今の版と、変える鍵の「本文が含む」（結び付けは 0 件）。推した規則で、比べる欄は実行のたびに変わる値になる
    // （許可の発行の `READ_VERIFICATION_NOT_VARYING` に当たらない）。
    expect(saved.scenario?.current.verification.readVerification).toEqual({
      readCheckId: templateCheck?.readCheckId, revision: templateCheck?.revision, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }],
    });
    if (saved.scenario === null || saved.rules === null) {
      throw new Error('the update scenario or its rules were not saved');
    }
    expect(varyingFieldNamesOf(planRuleSet(saved.rules.ruleSet, saved.scenario.current, saved.scenario.evidence))).toContain('name');
    // PL-5 の 9 の (1): 規則は保存の口が 1 回だけ付ける（付け直さない。規則の集まりは版 1 のまま）。
    expect(saved.rules.ruleSet.revision).toBe(1);
  });

  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、閉じた一覧にない知らせの値では、シナリオの画面に知らせの枠を出さない。一覧の値なら出す。
  it('shows no notice on the scenario screen for a search value outside the closed list', async () => {
    const unknown = await openPage(`/scenarios/${PROFILE_ID}/${state.createId}?notice=foo`);
    await unknown.locator('h1.page-title').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await unknown.getByTestId('scenario-notice').count()).toBe(0);
    const shown = await openPage(`/scenarios/${PROFILE_ID}/${state.createId}?notice=saved`);
    await shown.getByTestId('scenario-notice').waitFor({ timeout: UI_TIMEOUT_MS });
  });

  it('shows the inferred items and their grounds on the scenario screen and in the approval dialog', async () => {
    const page = await openPage(`/scenarios/${PROFILE_ID}/${state.createId}`);
    const inferred = page.getByTestId('scenario-inferred');
    // PL-5（設計書 3 章の 1）: 推した項目は、詳しい内容の中（項目の名前と印。値は出さない）。
    await inferred.waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const items = await inferred.locator('li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item')));
    expect(items).toEqual(['RECORD_ID_KEY', 'READ_PAGE_TEMPLATE', 'READ_EXPECTATION']);
    expect(await inferred.textContent()).toContain(DRAFT_VALUE_TEXT.grounds.RECORD_ID_KEY_FROM_UPDATE_FILTER);
    // MI-6（設計書 4.6、ユーザーの判断 2）: 副作用を確かめていない下書きでも、承認のボタンを出す（4 項目は、承認のダイアログの 1 回で確かめる）。
    expect(await page.getByTestId('scenario-approve').count()).toBe(1);
    await screenshot(page, 'fm2b-04-inferred');
    // 人が版を上げる（今の変更の口。ここでは副作用もすべて確かめた版）。推測の項目は残り、承認のダイアログにも出る。
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
    // PL-5: 承認のダイアログには、推測の項目が残ることの 1 行だけ（項目の値は出さない）。
    expect(await dialog.getByTestId('scenario-approve-inferred').textContent()).toBe(text.approveInferredHeading);
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

  // MI-7（設計書 4.6）: 台帳の登録のシナリオに照合の READ がない（古い記録など）ときは、埋めずに、理由と人が作る手順を出す（今どおり人が作る形）。
  it('leaves the READ verification of the update to the person with the reason when the ledger has no READ verification', async () => {
    const current = withControlData((database) => readScenario(database, state.createId)?.current);
    if (current?.api === undefined) {
      throw new Error('the API scenario was not found');
    }
    const noRead = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
      draft: {
        profileId: PROFILE_ID,
        candidateIdentityDigest: current.candidate.identityDigest,
        transport: 'API',
        fieldNames: [...current.fieldNames],
        readChecks: [],
        sideEffectConfirmations: Object.fromEntries(SIDE_EFFECTS.map((item) => [item, false])),
        limits: { ...current.limits },
        approvalTtlDays: current.approvalTtlDays,
        verification: { resultJudgement: null, recordId: null, readVerification: null },
        api: {
          shapeDigest: current.api.shapeDigest, pageKeys: current.api.pageKeys.map(({ key }) => key), filterName: null, recordId: current.api.recordId, ledger: null,
        },
      },
    });
    expect(noRead.ok).toBe(true);
    const page = await openPage(`/scenarios/${PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE.identityDigest)}&shape=${
      encodeURIComponent(UPDATE.submissionProbe?.shapeDigest ?? '')}&ledger=${encodeURIComponent(noRead.scenarioId)}`);
    await page.getByTestId('scenario-api-fields').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.locator('select[name="api-ledger"]').inputValue()).toBe(noRead.scenarioId);
    await page.locator('input[data-api-role="name"][value="CHANGE"]').check();
    // PL-5 の 9 の (2): 写すのは保存の口だけ。写せない（台帳に照合の READ がない）ときは、保存した後の要点に、答え合わせを決められなかった 1 行を出す
    // （写したとは言わない）。人が作るときの欄（見るだけの確かめを選ぶ）は、詳しい内容に残る。
    expect(await page.locator('select[name="readVerification-check"] option').count()).toBeGreaterThan(1);
    await screenshot(page, 'mi7-02-update-read-unavailable');
    await page.getByTestId('scenario-save').click();
    await page.waitForURL(new RegExp(`/scenarios/${PROFILE_ID}/[a-z0-9-]+\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('scenario-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-verification-missing').textContent()).toBe(LOCAL_UI_WRITE_STAGE_TEXT.scenario.verificationMissing);
    expect(await page.getByTestId('scenario-verification-copied').count()).toBe(0);
    const saved = withControlData((database) => readScenario(database, new URL(page.url()).pathname.split('/').at(-1) ?? ''));
    expect(saved?.current.verification.readVerification).toBeNull();
  });

  it('cannot be pressed when the profile revision is not the one of the latest discovery, and tells the reason and the next step', async () => {
    expect(await valueOf('updateProfileFn', 'POST', { profile: profileDocument(FIRST_REVISION + 1), expectedRevision: FIRST_REVISION }))
      .toMatchObject({ ok: true });
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const blocker = page.getByTestId('auto-draft-blocker');
    await blocker.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await blocker.getAttribute('data-reason')).toBe('DISCOVERY_STALE');
    expect(await blocker.textContent()).toContain(text.blockers.DISCOVERY_STALE.action);
    // PL-5（設計書 4 章の 6）: 押せないボタンは出さない（理由と次にすることを要点に出す）。
    expect(await page.getByTestId('auto-draft-open').count()).toBe(0);
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
