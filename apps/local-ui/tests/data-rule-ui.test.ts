/**
 * 入力の規則（補完）の画面と、その Server Functions を、ビルドした画面のサーバ（一時の root）で確かめる（Task 29 の設計書 3 章の「補完の画面」、4.3、4.4。
 * T29e）。監査のワーカーは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `discovery`。サイトに接続しない）に替えて、
 * 最後の発見のジョブを作る（`scenario-ui.test.ts` と同じ作り）。
 * - 入力の検証（`schemas/control/ui-scenario-key`、`ui-data-rule-save`）: 合わない入力は 400。CSRF: cross-site の POST と Origin の違う POST は 403。
 * - 表示: 送る欄ごとの状態と細分、出どころ（人・テンプレート・汎用・送らない側）、外部到達。入力の規則の状態（未設定・すべて決まった・不足あり）は、
 *   シナリオの詳細と一覧にも出る。
 * - 編集と保存: 確認のダイアログ（取り消し側にフォーカス。保存すると再承認になることを示す）の後にだけ保存する。保存するとシナリオの版が上がり、
 *   下書きに戻る（承認していれば、要再承認）。版の衝突は保存しない。秘密に見える名前の欄に値を入れると拒む。中身の誤りも拒む。
 * - データの例: 送る欄すべてが決まったときだけ出る。メールは example.invalid の合成の宛先、通知の欄は送らない。画面の要求は画面のサーバだけ（外への要求 0）。
 * - 書き込みのモードでないプロファイルでは、編集と例が出ず、サーバも拒む。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。ブラウザのバンドルに、規則の表の SQL が入らない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。Chromium は headless だけ。スクリーンショットは、環境変数 `T29E_SCREENSHOT_DIR` が
 * あれば、そこに保存する。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../../src/cli/exit-codes.js';
import { WORKER_PROTOCOL_VERSION } from '../../../src/control/worker-protocol.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../../src/discovery/fingerprint.js';
import { LOCAL_UI_DATA_RULE_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { NO_CONSTRAINTS, sampleAction, sampleField, sampleForm } from '../../../tests/unit/discovery-candidate-samples.js';
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
import { callServerFunction, encodeServerFunctionPayload, readServerFunctionIds, type ServerFunctionCall } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403 });
const WAIT_LIMIT_MS = 60_000;
const WAIT_POLL_MS = 200;
const PROCESS_EXIT_LIMIT_MS = 20_000;
const UI_TIMEOUT_MS = 15_000;
const MAX_TAB_PRESSES = 200;
const FAKE_HEARTBEAT_INTERVAL_MS = 200;
const FAKE_RUN_ID = 'RUN-20261013000000';
const OTHER_RUN_ID = 'RUN-20261013000999';
/** 許可 Origin（偽のワーカーは接続しない。値は匿名のループバック）。 */
const ORIGIN = 'http://127.0.0.1:4173';
const WRITE_PROFILE_ID = 't29e-write';
const FIRST_REVISION = 1;
/** 画面の例の数（`data-rule-functions.ts` の `EXAMPLE_COUNT`）。 */
const EXAMPLE_COUNT = 3;
const SCREENSHOT_DIRECTORY = process.env['T29E_SCREENSHOT_DIR'];
const WORKER_ENTRY = 'dist/worker/audit-worker.js';

const text = LOCAL_UI_DATA_RULE_TEXT;
const scenarioText = LOCAL_UI_SCENARIO_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];
const state: { scenarioId: string; writeTarget: string } = { scenarioId: '', writeTarget: '' };

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

// ---------------------------------------------------------------------------------------------------------------
// 候補と成果物（分類と指紋は本物の部品で求める）
// ---------------------------------------------------------------------------------------------------------------

const ALLOWED: ReadonlySet<string> = new Set([ORIGIN]);
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }),
  ...computeCandidateDigests(discovered),
});
/** 登録（CREATE）。氏名（テンプレート）、メール（テンプレート）、選択肢（汎用）、通知（送らない側）、推せない欄、秘密に見える名前の欄。 */
const CREATE = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/admin/members/new' }, formMethod: 'POST', action: sampleAction('/admin/members', [], ORIGIN), submitterText: '登録',
  fields: [
    sampleField('name', 'text', { required: true, constraints: { ...NO_CONSTRAINTS, maxlength: '40' } }),
    sampleField('email', 'email'),
    sampleField('plan', 'select-one', { options: ['', 'basic', 'premium'] }),
    sampleField('notify', 'checkbox', { options: ['1'] }),
    sampleField('code_x'),
    sampleField('api_key'),
  ],
}));

const discoveryDocument = (): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: FAKE_RUN_ID,
  startedAt: '20261013000000',
  finishedAt: '20261013000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [CREATE].map((candidate) => ({
    url: `${candidate.page.origin}${candidate.page.path}`,
    state: 'READ' as const,
    record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
    blockedRequests: 0,
  })),
  omittedUnreadPages: 0,
});

const installFakeDiscovery = (outputDirectory: string): void => {
  const directory = `${rootOf().root}/fake-workers/${outputDirectory}`;
  mkdirSync(directory, { recursive: true });
  const document = discoveryDocument();
  const worker = writeFakeWorker(directory, 'discovery', {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    runId: FAKE_RUN_ID,
    otherRunId: OTHER_RUN_ID,
    heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
    exitCodes: {
      complete: EXIT_CODES.COMPLETE,
      partial: EXIT_CODES.PARTIAL,
      interrupted: INTERRUPTED_EXIT_CODE,
      configError: EXIT_CODES.CONFIG_ERROR,
      failure: FAILURE_EXIT_CODE,
    },
    discovery: {
      outputDirectory: `${rootOf().root}/${outputDirectory}`,
      documentText: JSON.stringify(document),
      summary: { ...discoverySummaryOf(document) },
      runStatus: 'COMPLETE',
    },
  });
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
};

const waitForEnd = async (jobId: string): Promise<{ readonly state: string }> => {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const job = await valueOf<{ state: string; active: boolean } | null>('getAuditJobFn', 'GET', { jobId });
    if (job !== null && !job.active) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`ジョブが終わらなかった: ${JSON.stringify(job)}`);
    }
    descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_MS));
  }
};

const writeTarget = (name: string, outputDirectory: string): string => {
  const path = `config/targets/${name}.json`;
  mkdirSync(`${rootOf().root}/config/targets`, { recursive: true });
  writeFileSync(`${rootOf().root}/${path}`, `${JSON.stringify({
    target: { id: name },
    site: { startUrl: `${ORIGIN}/admin`, allowedOrigins: [ORIGIN] },
    crawl: { minNavigationIntervalMs: 0, maxPages: 10 },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: outputDirectory },
  }, null, 2)}\n`, 'utf8');
  return path;
};

const profileDocument = (profileId: string, targetConfigPath: string, mode: string, revision: number): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision,
  targetConfigPath,
  environment: 'TEST',
  mode,
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN],
  environmentEvidenceRef: 't29e-evidence',
});

const authSetup = (profileId: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-auth-setup/2',
  profileId,
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
});

const ALL_CONFIRMED = Object.fromEntries(['TEST_RECORDS_ONLY', 'NO_EXTERNAL_NOTIFICATION', 'NO_PAYMENT_OR_EXTERNAL_SERVICE', 'NOT_DESTRUCTIVE']
  .map((item) => [item, true]));

interface FieldView {
  readonly fieldName: string;
  readonly selected: boolean;
  readonly status: string;
  readonly problem: { readonly code: string; readonly detail: string } | null;
  readonly source: string | null;
  readonly secretLike: boolean;
  readonly allowedKinds: readonly string[];
}
interface PageView {
  readonly eligible: boolean;
  readonly editable: boolean;
  readonly scenario: { readonly revision: number; readonly state: string };
  readonly ruleSet: { readonly ruleSetId: string; readonly revision: number } | null;
  readonly inputRuleState: string;
  readonly fields: readonly FieldView[];
  readonly examples: readonly { readonly index: number; readonly values: readonly { fieldName: string; value: string | null; synthetic: string | null }[] }[] | null;
}

const pageOf = (scenarioId: string): Promise<PageView> => valueOf<PageView>('dataRulePageFn', 'GET', { scenarioId });

/** 保存の入力（中身は引数）。 */
const saveOf = (scenarioId: string, page: PageView, content: Record<string, unknown>): Record<string, unknown> => ({
  scenarioId,
  expectedScenarioRevision: page.scenario.revision,
  expectedRuleSetRevision: page.ruleSet?.revision ?? null,
  fieldRules: [],
  relations: [],
  uniqueKeyFieldNames: [],
  ...content,
});

const FIXED_CODE_RULE = { fieldName: 'code_x', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['A1', 'A2'] };

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）。 */
const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

const focusedText = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.textContent ?? '');

const rulesPath = (): string => `/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}/rules`;

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  state.writeTarget = writeTarget('t29e-write', 't29e-write-output');
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_APPROVED_WRITE', FIRST_REVISION) }))
    .toMatchObject({ ok: true });
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetup(WRITE_PROFILE_ID) })).toMatchObject({ ok: true });
  installFakeDiscovery('t29e-write-output');
  const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: WRITE_PROFILE_ID, expectedRevision: FIRST_REVISION });
  expect(job.ok).toBe(true);
  expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
  const created = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
    draft: {
      profileId: WRITE_PROFILE_ID,
      candidateIdentityDigest: CREATE.identityDigest,
      fieldNames: ['name', 'email', 'plan', 'notify', 'code_x'],
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
    },
  });
  expect(created.ok).toBe(true);
  state.scenarioId = created.scenarioId;
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

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('T29e: data rule Server Functions (registration, input validation, CSRF)', () => {
  it('lists the data rule Server Functions, and none issues an execution grant', () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining(['dataRulePageFn', 'saveDataRulesFn']));
    // T30g: 実行の許可の発行と書き込みの開始は、書き込みの開始の画面の 2 つの Server Function だけ（入力の規則の画面の Server Function は当たらない。
    // 許可の消費・予約の締めの Server Function はない）。発行を呼べる画面のコードが 1 ファイルだけであることは、Gate `approval-ssot` の (e)。
    const executionPaths = [...ids.keys()].filter((name) => /grant|reserv|consume|execut|settle|write/iu.test(name)).sort();
    // T31h-2: UPDATE の開始（`startWriteUpdateFn`）も、同じ書き込みの開始の画面のファイルにある。
    expect(executionPaths).toEqual(['startWriteCreateFn', 'startWriteUpdateFn', 'writeStartPageFn']);
    expect(executionPaths.filter((name) => ['dataRulePageFn', 'saveDataRulesFn'].includes(name))).toEqual([]);
  });

  it('rejects inputs that do not match the schemas with 400, and saves nothing', async () => {
    const page = await pageOf(state.scenarioId);
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['dataRulePageFn', 'GET', { scenarioId: '../x' }],
      ['saveDataRulesFn', 'POST', { ...saveOf(state.scenarioId, page, {}), extra: true }],
      ['saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, { expectedScenarioRevision: 0 })],
      ['saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, { fieldRules: [{ ...FIXED_CODE_RULE, semanticKind: 'ADDRESS' }] })],
      ['saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, { fieldRules: [{ ...FIXED_CODE_RULE, method: 'FROM_LLM' }] })],
    ];
    for (const [name, method, data] of rejected) {
      expect((await call(name, method, data)).response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
    }
    expect((await pageOf(state.scenarioId)).ruleSet).toBeNull();
  });

  it('keeps the CSRF protection: a cross-site or other-origin POST is 403, and saves nothing', async () => {
    const page = await pageOf(state.scenarioId);
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get('saveDataRulesFn') ?? ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body: encodeServerFunctionPayload(saveOf(state.scenarioId, page, { fieldRules: [FIXED_CODE_RULE] })),
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    expect((await pageOf(state.scenarioId)).ruleSet).toBeNull();
  });
});

describe('T29e: the data rule screen', () => {
  it('shows the state, the detail and the source of each field, and no example while a field is undecided', async () => {
    const view = await pageOf(state.scenarioId);
    expect(view).toMatchObject({ eligible: true, editable: true, inputRuleState: 'NOT_SET', ruleSet: null, examples: null });
    expect(view.fields.map(({ fieldName, status, problem, source }) => [fieldName, status, problem?.detail ?? null, source])).toEqual([
      ['code_x', 'NEEDS_RULE_INPUT', 'SEMANTIC_KIND_UNDECIDED', null],
      ['email', 'DECIDED', null, 'TEMPLATE'],
      ['name', 'DECIDED', null, 'TEMPLATE'],
      ['notify', 'DECIDED', null, 'OPT_OUT'],
      ['plan', 'DECIDED', null, 'GENERIC'],
    ]);
    const page = await openPage(rulesPath());
    const field = (name: string): Locator => page.locator(`[data-testid="data-rule-field"][data-field-name="${name}"]`);
    expect(await page.getByTestId('data-rule-state').getAttribute('data-state')).toBe('NOT_SET');
    expect(await field('code_x').getByTestId('data-rule-status').getAttribute('data-detail')).toBe('SEMANTIC_KIND_UNDECIDED');
    expect(await field('notify').getAttribute('data-source')).toBe('OPT_OUT');
    expect(await field('email').getByTestId('data-rule-external').textContent()).toContain(text.columns.external);
    expect(await page.getByTestId('data-rule-examples-unavailable').textContent()).toBe(text.examplesUnavailable);
    expect(await page.getByTestId('data-rule-no-execution').textContent()).toBe(text.noExecution);
    await screenshot(page, 'r01-rules-not-set');

    const detail = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`);
    expect(await detail.getByTestId('scenario-input-rules').getAttribute('data-state')).toBe('NOT_SET');
    expect(await detail.getByTestId('scenario-input-rules').textContent()).toBe(scenarioText.inputRulesMissing);
    expect(await detail.getByTestId('scenario-open-rules').getAttribute('href')).toBe(rulesPath());
    const list = await openPage(`/scenarios/${WRITE_PROFILE_ID}`);
    expect(await list.locator(`[data-testid="scenario-row"][data-scenario-id="${state.scenarioId}"]`).getByTestId('scenario-input-rule-state')
      .getAttribute('data-state')).toBe('NOT_SET');
  });

  it('saves the rules only after the confirmation dialog, raises the scenario revision and shows examples that are not sent', async () => {
    const before = await pageOf(state.scenarioId);
    const page = await openPage(rulesPath());
    await page.locator('select[data-kind-for="code_x"]').selectOption('FIXED_LIST');
    await page.locator('select[data-method-for="code_x"]').selectOption('FROM_FIXED_LIST');
    const fixed = page.locator('textarea[data-fixed-for="code_x"]');
    await tabTo(page, fixed);
    await page.keyboard.type('A1\nA2');
    await screenshot(page, 'r02-rules-edited');
    const save = page.getByTestId('data-rule-save');
    await tabTo(page, save);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await focusedText(page)).toBe(text.saveDialog.cancel);
    expect(await dialog.textContent()).toContain(text.saveDialog.body);
    await screenshot(page, 'r03-rules-save-dialog');
    await page.keyboard.press('Enter');
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect((await pageOf(state.scenarioId)).ruleSet).toBeNull();
    await save.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    expect(await focusedText(page)).toBe(text.saveDialog.confirm);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/rules\?notice=saved$/u, { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId('data-rule-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('DECIDED');
    expect(await page.getByTestId('data-rule-example').count()).toBe(EXAMPLE_COUNT);
    expect(await page.getByTestId('data-rule-synthetic').first().getAttribute('data-synthetic')).toBe('EMAIL');
    await screenshot(page, 'r04-rules-saved-examples');

    const after = await pageOf(state.scenarioId);
    expect(after).toMatchObject({ inputRuleState: 'DECIDED', ruleSet: { revision: 1 }, scenario: { revision: before.scenario.revision + 1, state: 'DRAFT' } });
    expect(after.fields.find((field) => field.fieldName === 'code_x')).toMatchObject({ status: 'DECIDED', source: 'HUMAN' });
    expect(after.examples).toHaveLength(EXAMPLE_COUNT);
    for (const example of after.examples ?? []) {
      const values = new Map(example.values.map((value) => [value.fieldName, value]));
      expect(values.get('email')?.value?.endsWith('@example.invalid')).toBe(true);
      expect(values.get('email')?.synthetic).toBe('EMAIL');
      expect(values.get('notify')?.value).toBeNull();
      expect(['A1', 'A2']).toContain(values.get('code_x')?.value);
      expect(['basic', 'premium']).toContain(values.get('plan')?.value);
    }
    const detail = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`);
    expect(await detail.getByTestId('scenario-input-rules').getAttribute('data-state')).toBe('DECIDED');
    await screenshot(detail, 'r05-scenario-detail-rules-decided');
  });

  it('turns an approved scenario back to needing approval when the rules are saved again', async () => {
    const detail = await valueOf<{ scenario: { revision: number }; status: { approvalDigest: string } | null }>('scenarioDetailPageFn', 'GET', {
      scenarioId: state.scenarioId,
    });
    expect(await valueOf('approveScenarioFn', 'POST', {
      scenarioId: state.scenarioId, expectedRevision: detail.scenario.revision, expectedApprovalDigest: detail.status?.approvalDigest,
    })).toMatchObject({ ok: true });
    const page = await pageOf(state.scenarioId);
    expect(page.scenario.state).toBe('APPROVED');
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, {
      fieldRules: [{ ...FIXED_CODE_RULE, fixedValues: ['A3'] }], uniqueKeyFieldNames: ['code_x'],
    }))).toMatchObject({ ok: true, ruleSetRevision: 2, scenarioRevision: page.scenario.revision + 1 });
    const changed = await valueOf<{ scenario: { state: string }; status: { displayState: string; reasons: readonly string[] } | null }>(
      'scenarioDetailPageFn', 'GET', { scenarioId: state.scenarioId },
    );
    expect(changed.scenario.state).toBe('DRAFT');
    expect(changed.status).toMatchObject({ displayState: 'NEEDS_REAPPROVAL' });
    expect(changed.status?.reasons).toEqual(expect.arrayContaining(['SCENARIO_REVISION_CHANGED', 'INPUT_RULES_CHANGED']));
  });

  it('shows the revision conflict when the rules changed after the screen opened, and saves nothing', async () => {
    const page = await openPage(rulesPath());
    await page.getByTestId('data-rule-form').waitFor({ timeout: UI_TIMEOUT_MS });
    const current = await pageOf(state.scenarioId);
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, current, { fieldRules: [FIXED_CODE_RULE] })))
      .toMatchObject({ ok: true, ruleSetRevision: 3 });
    const save = page.getByTestId('data-rule-save');
    await tabTo(page, save);
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.getByTestId('data-rule-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('data-rule-rejection').getAttribute('data-reason')).toBe('RULE_SET_REVISION_CONFLICT');
    await screenshot(page, 'r06-rules-conflict');
    expect((await pageOf(state.scenarioId)).ruleSet?.revision).toBe(3);
  });

  it('rejects fixed values of a secret-looking field and an inconsistent content, and saves nothing', async () => {
    const page = await pageOf(state.scenarioId);
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, {
      fieldRules: [{ fieldName: 'api_key', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['x'] }],
    }))).toEqual({ ok: false, stage: 'RULE_SET', reason: 'RULE_SET_SECRET_FIELD_FIXED_VALUE' });
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, { fieldRules: [FIXED_CODE_RULE, FIXED_CODE_RULE] })))
      .toEqual({ ok: false, stage: 'RULE_SET', reason: 'DATA_RULE_CONTENT_INVALID' });
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, page, { uniqueKeyFieldNames: ['missing'] })))
      .toEqual({ ok: false, stage: 'RULE_SET', reason: 'DATA_RULE_CONTENT_INVALID' });
    expect((await pageOf(state.scenarioId)).ruleSet?.revision).toBe(page.ruleSet?.revision);
  });

  it('keeps the server parts of the data rules out of the browser bundle', () => {
    const clientDirectory = `${rootOf().root}/apps/local-ui/dist/client`;
    const files = readdirSync(clientDirectory, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.js'));
    const bundle = files.map((path) => readFileSync(`${clientDirectory}/${path}`, 'utf8')).join('\n');
    for (const marker of ['rule_set_revisions', 'FROM rule_sets', 'beaksight-data-rule-digest/1', 'screen-example-']) {
      expect(bundle.includes(marker), marker).toBe(false);
    }
  });

  it('does not offer the editor or the examples to a profile that is not in the write mode, and the server rejects the save', async () => {
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_AUTH_PASSIVE', FIRST_REVISION + 1), expectedRevision: FIRST_REVISION,
    })).toMatchObject({ ok: true });
    const view = await pageOf(state.scenarioId);
    expect(view).toMatchObject({ eligible: false, editable: false });
    // T29R-fix-1（M-9）: 書き込みのモードでないプロファイルには、データの例を作って返さない（送る欄すべてが決まっていても）。
    expect(view.examples).toBeNull();
    const page = await openPage(rulesPath());
    expect(await page.getByTestId('scenario-not-eligible').count()).toBe(1);
    expect(await page.getByTestId('data-rule-editor').count()).toBe(0);
    expect(await page.getByTestId('data-rule-examples').count()).toBe(0);
    await screenshot(page, 'r07-rules-not-eligible');
    expect(await valueOf('saveDataRulesFn', 'POST', saveOf(state.scenarioId, view, { fieldRules: [FIXED_CODE_RULE] })))
      .toEqual({ ok: false, stage: 'RULE_SET', reason: 'RULE_SET_MODE_NOT_WRITE' });
  });
});
