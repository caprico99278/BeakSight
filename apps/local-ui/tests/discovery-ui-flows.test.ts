/**
 * 操作の候補の画面と READ の確かめの画面の操作の確かめ（Task 27 の設計書 4.4、4.5、4.7、4.8。T27f）。ビルドした画面を一時の root の起動の部品で
 * 起動し、Playwright の headless の Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。監査のワーカーは、一時の root の入口を
 * テストだけの入口（`helpers/auth-worker.ts`。手動のログインの段で、人の操作の代わりに受け渡しのサーバの資格情報を入れる。ログイン用の Browser も
 * headless）に替えて、本物の発見と READ の確かめを、127.0.0.1 の fixture のサイト（`tests/helpers/discovery-site-fixture.ts`）に対して動かす。
 * - プロファイルの詳細から（キーボードだけ）、操作の候補の画面: 認証の設定がない → 理由（`AUTH_SETUP_MISSING`）で、開始のボタンを出さない。
 * - 「操作の候補を探す」（キーボード）→ ジョブの画面は種類と状態だけ（進み具合を送らない）→ 候補の一覧: 分類（READ、CREATE、UPDATE、
 *   NOT_EXECUTABLE、NEEDS_BINDING）、実行できないことの明示、ドリフトの `NEW`、詳しい内容（欄の型、送れる欄）。画面を変えた 2 回目の発見で
 *   `CHANGED`・`MISSING`・`UNCHANGED`。
 * - READ の確かめの定義: 作成（送れる欄だけが入力の欄）、秘密に見える名前の欄の拒否（項目ごとの誤り）、版の衝突、削除（確かめのダイアログ）。
 * - 「READ を確かめる」→ ジョブ → 結果（定義ごとの結果、詳しい理由、期待ごとの要約、`read-evidence.json` へのリンク）。
 * - 画面（ページの HTML、Server Function の応答、成果物）に、Cookie・資格情報・CSRF のトークン・入力の値・hidden の値・選択肢の label・表の行の
 *   目印が出ない。READ の送る値（テスト用の値）は、定義の画面に出る（設計どおり）。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。fixture のサイトに届いた GET と HEAD 以外の要求は、ログインの POST だけ。
 *   ワーカーと Chromium の process が残らない。スクリーンショットは、環境変数 `T27F_SCREENSHOT_DIR` があれば、そこに保存する。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_JOB_STATE_CATALOG, CANDIDATE_CLASSIFICATION_CATALOG, READ_CHECK_EXPECTATION_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_READ_CHECK_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  DISCOVERY_SITE_LOGIN_FIELDS,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  startDiscoverySite,
  type DiscoverySite,
} from '../../../tests/helpers/discovery-site-fixture.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import {
  installTestAuthWorkerEntry,
  startCredentialRelay,
  writeAuthTargetConfig,
  type CredentialRelay,
  type RelayedCredentials,
} from './helpers/auth-worker.ts';
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
/** ジョブの終わりを待つ上限（ms）。 */
const JOB_TIMEOUT_MS = 240_000;
/** 1 つの場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 360_000;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 60_000;
/** テストだけの入口の、ログインを待つ時間（ms）。 */
const TEST_LOGIN_TIMEOUT_MS = 120_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 120;
/** 巡回の上限（読む範囲の画面をすべて読める数）。 */
const MAX_PAGES = 30;
const PROFILE_ID = 't27f-ui';
const FIRST_REVISION = 1;
/** READ の確かめの送る値と期待（テスト環境のテスト用の値。秘密ではない）。 */
const ORDER_QUERY = 'りんご';
const ORDER_COUNT = '2';
const LOOKUP_ID = 'A-1';
const DETAIL_FIELD = '名前';
const DETAIL_VALUE = 'りんご';
const SCREENSHOT_DIRECTORY = process.env['T27F_SCREENSHOT_DIR'];
/** 読み込みを短くするために読まない、発見に要らない画面（設定どおりの除外。危険な語を含まない）。 */
const SKIPPED_PATHS: readonly string[] = [
  DISCOVERY_SITE_PATHS.spa,
  DISCOVERY_SITE_PATHS.beacon,
  DISCOVERY_SITE_PATHS.duplicate,
  DISCOVERY_SITE_READ_CHECK_PATHS.brokenSearch,
  DISCOVERY_SITE_READ_CHECK_PATHS.shape,
  DISCOVERY_SITE_READ_CHECK_PATHS.exitSearch,
];

const text = LOCAL_UI_DISCOVERY_TEXT;
const readText = LOCAL_UI_READ_CHECK_TEXT;

let root: TemporaryUiRoot | undefined;
let site: DiscoverySite | undefined;
let relay: CredentialRelay | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];
/** 場面をまたいで使う値。 */
const state: { discoveryJobs: string[]; readCheckJob: string; ordersCheckId: string; lookupCheckId: string } = {
  discoveryJobs: [],
  readCheckJob: '',
  ordersCheckId: '',
  lookupCheckId: '',
};

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};
const siteOf = (): DiscoverySite => {
  if (site === undefined) {
    throw new Error('fixture のサイトが起動していない');
  }
  return site;
};

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求）、Tab だけのフォーカスの移動、スクリーンショット（CCX-16 の共通の補助）。 */
const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

const callFunction = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callFunction(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(200);
  return result.value as T;
};

/** fixture の正しい資格情報（値はテストの process の中だけ。出力しない）。 */
const credentials = async (): Promise<RelayedCredentials> => {
  const fields: (readonly [string, string])[] = [];
  await siteOf().fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  return { fields, submit: DISCOVERY_SITE_LOGIN_FIELDS.submit };
};

const jobState = (page: Page, value: keyof typeof AUDIT_JOB_STATE_CATALOG): Locator => page.locator(`[data-testid="job-state"][data-state="${value}"]`);

/** ジョブの画面で、終わるのを待つ（その間の画面のサーバの子孫を記録する）。 */
const waitForFinished = async (page: Page): Promise<void> => {
  descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
  await jobState(page, 'FINISHED').waitFor({ timeout: JOB_TIMEOUT_MS });
};

/** 開始のボタンをキーボードで押し、ジョブの画面に移る。ジョブの ID を返す。 */
const startFrom = async (page: Page, button: Locator): Promise<string> => {
  await tabTo(page, button);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
};

/** 候補の行（画面の path と分類）。 */
const candidateRow = (page: Page, path: string, classification: keyof typeof CANDIDATE_CLASSIFICATION_CATALOG): Locator =>
  page.locator(`[data-testid="discovery-page"][data-page-path="${path}"] [data-testid="discovery-candidate"][data-classification="${classification}"]`);

/** 候補の画面で、ある画面の READ の候補の識別の digest を読む。 */
const readDigestOf = async (path: string): Promise<string> => {
  const page = await openPage(`/discovery/${PROFILE_ID}`);
  const digest = await candidateRow(page, path, 'READ').first().getAttribute('data-digest');
  await page.close();
  return digest ?? '';
};

/** 定義を作る画面で、項目を入れて保存する（保存のボタンはキーボードで押す）。 */
const fillDefinition = async (
  page: Page,
  parameters: Readonly<Record<string, string>>,
  expectation: { readonly kindLabel: string; readonly values: Readonly<Record<string, string>> },
): Promise<void> => {
  for (const [name, value] of Object.entries(parameters)) {
    await page.getByTestId('read-check-parameters').getByLabel(name, { exact: true }).fill(value);
  }
  const row = page.locator('[data-testid="read-check-expectation"][data-index="0"]');
  await row.getByLabel(readText.expectationKind, { exact: true }).selectOption({ label: expectation.kindLabel });
  for (const [label, value] of Object.entries(expectation.values)) {
    await row.getByLabel(label, { exact: true }).fill(value);
  }
  await tabTo(page, page.getByTestId('read-check-save'));
  await page.keyboard.press('Enter');
};

/** 候補の画面から、READ の候補の「READ の確かめを作る」を開く（キーボード）。 */
const openNewDefinition = async (path: string): Promise<Page> => {
  const page = await openPage(`/discovery/${PROFILE_ID}`);
  const link = candidateRow(page, path, 'READ').first().getByTestId('candidate-create-read-check');
  await tabTo(page, link);
  await page.keyboard.press('Enter');
  await page.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** fixture のサイトに届いた、GET と HEAD 以外の要求。 */
const nonReadRequests = (): readonly string[] =>
  siteOf().requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startDiscoverySite({ readCheckPages: true });
  relay = await startCredentialRelay();
  installTestAuthWorkerEntry(root.root, relay.url, TEST_LOGIN_TIMEOUT_MS);
  const target = writeAuthTargetConfig(root.root, PROFILE_ID, site.origin, DISCOVERY_SITE_PATHS.admin, MAX_PAGES);
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
      revision: FIRST_REVISION,
      targetConfigPath: target,
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: 't27f-evidence',
    },
  })).toMatchObject({ ok: true });
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await relay?.close();
  await site?.close();
  root?.remove();
});

describe('local UI: the operation candidates (DISCOVERY)', () => {
  it('opens the candidates from the profile by keyboard, and shows AUTH_SETUP_MISSING without a start button', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    await tabTo(page, page.getByTestId('profile-discovery').getByRole('link', { name: text.profileDetail.openDiscovery }));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/discovery/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('discovery-guidance').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await page.getByTestId('start-reason').textContent()).toBe(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description);
    expect(await page.getByTestId('discovery-start').count()).toBe(0);
    expect(await page.getByTestId('discovery-no-records').textContent()).toBe(text.noDiscovery);
    await screenshot(page, '01-discovery-auth-setup-missing');
  }, SCENARIO_TIMEOUT_MS);

  it('starts a discovery by keyboard, shows only the kind and the state on the job screen, and lists the classified candidates', async () => {
    const fixture = siteOf();
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: {
        schemaVersion: 'beaksight-auth-setup/2',
        profileId: PROFILE_ID,
        profileRevision: FIRST_REVISION,
        loginStartUrl: `${fixture.origin}${DISCOVERY_SITE_PATHS.login}`,
        loginPostEndpoints: [{ origin: fixture.origin, path: DISCOVERY_SITE_PATHS.login }],
        successCondition: { pathPrefix: DISCOVERY_SITE_PATHS.admin, selector: '#admin-ok' },
        sessionLostCondition: { pathPrefix: null },
        excludedPaths: [DISCOVERY_SITE_PATHS.logout, DISCOVERY_SITE_READ_CHECK_PATHS.privateArea, ...SKIPPED_PATHS],
        auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
        maxLoginAttempts: 2,
        allowedIdpOrigins: [],
        automatedLogin: null,
      },
    })).toMatchObject({ ok: true });

    const page = await openPage(`/discovery/${PROFILE_ID}`);
    relay?.provide(await credentials());
    const jobId = await startFrom(page, page.getByTestId('discovery-start'));
    state.discoveryJobs.push(jobId);
    expect(await page.getByTestId('job-kind').getAttribute('data-kind')).toBe('DISCOVERY');
    expect(await page.getByTestId('job-no-progress').textContent()).toBe(text.job.noProgress);
    expect(await page.getByTestId('job-progress').count()).toBe(0);
    expect(await page.getByTestId('job-progress-empty').count()).toBe(0);
    await screenshot(page, '02-discovery-job-running');
    await waitForFinished(page);
    expect(await page.getByTestId('job-run-status').getAttribute('data-run-status')).toBe('COMPLETE');
    expect(await page.locator('[data-artifact="DISCOVERY_JSON"]').count()).toBe(1);
    await screenshot(page, '03-discovery-job-finished');

    await tabTo(page, page.getByTestId('job-open-discovery'));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/discovery/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('discovery-end-reason').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('discovery-end-reason').getAttribute('data-reason')).toBe('COMPLETED');
    const p = DISCOVERY_SITE_PATHS;
    const r = DISCOVERY_SITE_READ_CHECK_PATHS;
    for (const [path, classification] of [
      [p.search, 'READ'],
      [r.orders, 'READ'],
      [r.lookup, 'READ'],
      [r.secretSearch, 'READ'],
      [p.create, 'CREATE'],
      [p.update, 'UPDATE'],
      [p.remove, 'NOT_EXECUTABLE'],
      [p.js, 'NEEDS_BINDING'],
    ] as const) {
      const row = candidateRow(page, path, classification).first();
      expect(await row.count(), `${path} ${classification}`).toBe(1);
      expect(await row.getAttribute('data-drift')).toBe('NEW');
      expect(await row.getByText(CANDIDATE_CLASSIFICATION_CATALOG[classification].label).count()).toBe(1);
      expect(await row.getByTestId('candidate-execution').textContent())
        .toContain(classification === 'READ' ? text.readCheckable : text.notExecutable);
    }
    // 詳しい内容: 欄の型と、値を送れるか（CSRF のトークンと hidden の欄は送れない）。
    const orders = page.locator(`[data-testid="discovery-page"][data-page-path="${r.orders}"]`);
    await orders.getByTestId('candidate-detail').first().locator('summary').click();
    const fields = orders.getByTestId('candidate-fields').first();
    expect(await fields.locator('tr[data-field-name]').evaluateAll((rows) =>
      rows.map((row) => [row.getAttribute('data-field-name'), row.getAttribute('data-sendable')]))).toEqual([
      ['authenticity_token', 'false'],
      ['scope', 'false'],
      ['q', 'true'],
      ['status', 'true'],
    ]);
    await screenshot(page, '04-discovery-candidates');
  }, SCENARIO_TIMEOUT_MS);

  it('shows CHANGED, MISSING and UNCHANGED after a second discovery of a changed screen', async () => {
    siteOf().setVariant('changed');
    const page = await openPage(`/discovery/${PROFILE_ID}`);
    relay?.provide(await credentials());
    state.discoveryJobs.push(await startFrom(page, page.getByTestId('discovery-start')));
    await waitForFinished(page);
    const discovery = await openPage(`/discovery/${PROFILE_ID}`);
    const variant = DISCOVERY_SITE_PATHS.variant;
    expect(await candidateRow(discovery, variant, 'READ').getAttribute('data-drift')).toBe('CHANGED');
    expect(await candidateRow(discovery, variant, 'CREATE').getAttribute('data-drift')).toBe('MISSING');
    expect(await candidateRow(discovery, variant, 'CREATE').getByTestId('candidate-execution').textContent()).toContain(text.notExecutable);
    expect(await candidateRow(discovery, DISCOVERY_SITE_PATHS.search, 'READ').getAttribute('data-drift')).toBe('UNCHANGED');
    // 消えた候補は、READ の確かめに使わない（最後の発見の結果にない）。
    await screenshot(discovery, '05-discovery-drift');
  }, SCENARIO_TIMEOUT_MS);
});

describe('local UI: the READ check definitions and results (READ_CHECK)', () => {
  it('creates a definition with only the sendable fields as inputs, and keeps the test values on the definition screen', async () => {
    const r = DISCOVERY_SITE_READ_CHECK_PATHS;
    const page = await openNewDefinition(r.orders);
    const parameters = page.getByTestId('read-check-parameters');
    expect(await parameters.locator('input[data-parameter]').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('data-parameter'))))
      .toEqual(['q', 'status']);
    await screenshot(page, '06-read-check-new');
    await fillDefinition(page, { q: ORDER_QUERY }, { kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_EQUALS.label, values: { [readText.expectationCount]: ORDER_COUNT } });
    await page.waitForURL(new RegExp(`/read-checks/${PROFILE_ID}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('read-check-notice').getAttribute('data-notice')).toBe('saved');
    const row = page.getByTestId('read-check-definition').first();
    state.ordersCheckId = await row.getAttribute('data-read-check-id') ?? '';
    expect(await row.getByTestId('read-check-definition-parameters').textContent()).toBe(`q=${JSON.stringify(ORDER_QUERY)}`);
    expect(await page.getByTestId('start-reason').count()).toBe(0);

    const lookup = await openNewDefinition(r.lookup);
    await fillDefinition(lookup, { id: LOOKUP_ID }, {
      kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.DETAIL_FIELD_EQUALS.label,
      values: { [readText.expectationField]: DETAIL_FIELD, [readText.expectationValue]: DETAIL_VALUE },
    });
    await lookup.waitForURL(new RegExp(`/read-checks/${PROFILE_ID}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => lookup.getByTestId('read-check-definition').count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    const ids2 = await lookup.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-read-check-id') ?? ''));
    state.lookupCheckId = ids2.find((id) => id !== state.ordersCheckId) ?? '';
    expect(state.lookupCheckId).not.toBe('');
    await screenshot(lookup, '07-read-check-definitions');
  }, SCENARIO_TIMEOUT_MS);

  it('rejects a value for a secret-like field and shows the reason on that field', async () => {
    const page = await openNewDefinition(DISCOVERY_SITE_READ_CHECK_PATHS.secretSearch);
    await fillDefinition(page, { api_key: 'test-value', q: ORDER_QUERY }, { kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.ROW_COUNT_AT_LEAST.label, values: { [readText.expectationCount]: '1' } });
    await page.getByTestId('read-check-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('read-check-rejection').getAttribute('data-reason')).toBe('READ_PARAMETER_SECRET_LIKE');
    const field = page.getByTestId('read-check-parameters').getByLabel('api_key', { exact: true });
    expect(await field.getAttribute('aria-invalid')).toBe('true');
    expect(await page.getByTestId('read-check-parameters').getByLabel('q', { exact: true }).getAttribute('aria-invalid')).toBe('false');
    await page.getByText(READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS.READ_PARAMETER_SECRET_LIKE.description).first().waitFor();
    expect(new URL(page.url()).pathname).toBe(`/read-checks/${PROFILE_ID}/new`);
    await screenshot(page, '08-read-check-secret-like');
  }, SCENARIO_TIMEOUT_MS);

  it('shows READ_CHECK_REVISION_CONFLICT when the definition changed after the screen opened, and removes a definition after the dialog', async () => {
    const page = await openPage(`/read-checks/${PROFILE_ID}/${state.ordersCheckId}`);
    await page.getByTestId('read-check-form').waitFor({ timeout: UI_TIMEOUT_MS });
    const view = await valueOf<{ definitions: readonly { readCheckId: string; definition: unknown }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    const current = view.definitions.find((definition) => definition.readCheckId === state.ordersCheckId);
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: state.ordersCheckId, expectedRevision: 1, definition: current?.definition }))
      .toMatchObject({ ok: true, revision: 2 });
    await tabTo(page, page.getByTestId('read-check-save'));
    await page.keyboard.press('Enter');
    await page.getByTestId('read-check-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('read-check-rejection').getAttribute('data-reason')).toBe('READ_CHECK_REVISION_CONFLICT');
    await screenshot(page, '09-read-check-conflict');

    // 削除するための定義を 1 つ作り、定義の画面から確かめのダイアログで削除する（キーボード）。
    const search = await openNewDefinition(DISCOVERY_SITE_PATHS.search);
    await fillDefinition(search, {}, { kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG.TEXT_CONTAINS.label, values: { [readText.expectationText]: '検索' } });
    await search.waitForURL(new RegExp(`/read-checks/${PROFILE_ID}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => search.getByTestId('read-check-definition').count(), { timeout: UI_TIMEOUT_MS }).toBe(3);
    const all = await search.getByTestId('read-check-definition').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-read-check-id') ?? ''));
    const removable = all.find((id) => id !== state.ordersCheckId && id !== state.lookupCheckId) ?? '';
    const edit = await openPage(`/read-checks/${PROFILE_ID}/${removable}`);
    await tabTo(edit, edit.getByTestId('read-check-remove'));
    await edit.keyboard.press('Enter');
    await edit.getByRole('dialog').waitFor({ timeout: UI_TIMEOUT_MS });
    await screenshot(edit, '10-read-check-remove-dialog');
    await edit.keyboard.press('Tab');
    await edit.keyboard.press('Enter');
    await edit.waitForURL(new RegExp(`/read-checks/${PROFILE_ID}\\?notice=removed$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => edit.getByTestId('read-check-definition').count(), { timeout: UI_TIMEOUT_MS }).toBe(2);
    expect(await edit.locator(`[data-testid="read-check-definition"][data-read-check-id="${removable}"]`).count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('starts the READ checks by keyboard and shows the results by definition with the detail and the link to read-evidence.json', async () => {
    const page = await openPage(`/read-checks/${PROFILE_ID}`);
    relay?.provide(await credentials());
    state.readCheckJob = await startFrom(page, page.getByTestId('read-check-start'));
    expect(await page.getByTestId('job-kind').getAttribute('data-kind')).toBe('READ_CHECK');
    expect(await page.getByTestId('job-no-progress').textContent()).toBe(text.job.noProgress);
    await waitForFinished(page);
    await tabTo(page, page.getByTestId('job-open-read-checks'));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/read-checks/${PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const results = page.locator(`[data-testid="read-check-result"][data-job-id="${state.readCheckJob}"]`);
    await results.first().waitFor({ timeout: UI_TIMEOUT_MS });
    const byId = new Map(await results.evaluateAll((rows) => rows.map((row) => [
      row.getAttribute('data-read-check-id') ?? '',
      [row.getAttribute('data-result'), row.getAttribute('data-detail')] as const,
    ] as const)));
    expect(byId.get(state.ordersCheckId)).toEqual(['MATCHED', 'EXPECTATIONS_EVALUATED']);
    expect(byId.get(state.lookupCheckId)).toEqual(['MATCHED', 'EXPECTATIONS_EVALUATED']);
    const lookupRow = page.locator(`[data-testid="read-check-result"][data-read-check-id="${state.lookupCheckId}"]`);
    expect(await lookupRow.textContent()).toContain(JSON.stringify(DETAIL_VALUE));
    const evidence = await page.getByTestId('read-check-evidence').getAttribute('href');
    expect(evidence).toBe(`/artifacts/${state.readCheckJob}/read-evidence.json`);
    expect((await rawRequest(started().port, evidence ?? '', { headers: { cookie } })).status).toBe(200);
    await screenshot(page, '11-read-check-results');
  }, SCENARIO_TIMEOUT_MS);

  it('shows no secret marker on the screens, in the Server Function responses or in the artifacts, and sent only GET besides the logins', async () => {
    const markers = siteOf().secretValues();
    expect(markers.length).toBeGreaterThan(5);
    const leaked = (body: string): readonly string[] => markers.filter((marker) => body.includes(marker));
    const texts: string[] = [];
    for (const path of [
      `/discovery/${PROFILE_ID}`,
      `/read-checks/${PROFILE_ID}`,
      `/read-checks/${PROFILE_ID}/${state.ordersCheckId}`,
      `/profiles/${PROFILE_ID}`,
      '/jobs',
      `/jobs/${state.readCheckJob}`,
      ...state.discoveryJobs.map((jobId) => `/jobs/${jobId}`),
      `/artifacts/${state.readCheckJob}/read-evidence.json`,
      ...state.discoveryJobs.map((jobId) => `/artifacts/${jobId}/discovery.json`),
    ]) {
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      texts.push(response.body);
    }
    for (const [name, data] of [
      ['discoveryPageFn', { profileId: PROFILE_ID }],
      ['readCheckPageFn', { profileId: PROFILE_ID }],
      ['getAuditJobFn', { jobId: state.readCheckJob }],
      ['listAuditJobsFn', undefined],
    ] as const) {
      const result = await callFunction(name, 'GET', data);
      expect(result.response.status, name).toBe(200);
      texts.push(result.response.body);
    }
    expect(texts.flatMap(leaked)).toEqual([]);
    // READ の送る値（テスト用の値）は、定義の画面に出る（設計書 4.5）。
    const definitions = await openPage(`/read-checks/${PROFILE_ID}`);
    const html = await definitions.content();
    expect(html).toContain(JSON.stringify(ORDER_QUERY));
    expect(html).toContain(JSON.stringify(LOOKUP_ID));
    // サイトへの要求: ログインの POST のほかは GET と HEAD だけ（発見 2 回と READ の確かめ 1 回で、ログインは 3 回）。
    expect(nonReadRequests()).toEqual([
      `POST ${DISCOVERY_SITE_PATHS.login}`,
      `POST ${DISCOVERY_SITE_PATHS.login}`,
      `POST ${DISCOVERY_SITE_PATHS.login}`,
    ]);
  }, SCENARIO_TIMEOUT_MS);
});
