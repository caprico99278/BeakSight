/**
 * 操作の候補と READ の確かめの Server Functions と画面を、ビルドした画面のサーバ（一時の root）で確かめる（Task 27 の設計書 4.5、4.7、4.8。T27f）。
 * 監査のワーカーは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `discovery`・`read-check`。サイトに接続しない）に
 * 替えて動かす（本物のワーカーと Chromium での端から端は `discovery-ui-flows.test.ts`）。
 * - 入力の検証（`schemas/control/ui-discovery-start`・`ui-read-check-*`）: 合わない入力は 400 で、ジョブも定義も作らない。CSRF: cross-site の POST と
 *   Origin の違う POST は 403。
 * - 開始できない理由: 公開の監査のプロファイル（`MODE_NOT_EXECUTABLE`）、定義が 0 件（`READ_CHECK_DEFINITIONS_MISSING`）。
 * - 許可 Origin が 2 つ: 同じ path の候補を、画面の Origin で区別して示す（T27c の申し送り 3）。
 * - 定義の保存の拒否の理由（秘密に見える名前、送れない欄、READ でない候補、分からない候補、版の衝突、削除した定義）を項目ごとに返す。取り消した
 *   プロファイルでは、作れない・変えられない（削除はできる）。
 * - READ の確かめの結果（定義ごとの結果、詳しい理由、`read-evidence.json` へのリンク）。
 * - ブラウザのバンドル（`dist/client`）に、サーバの部品（SQL、`node:` の部品）が入らない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。偽のワーカーはサイトに接続しない。Chromium は headless だけ。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../../src/cli/exit-codes.js';
import { WORKER_PROTOCOL_VERSION } from '../../../src/control/worker-protocol.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../../src/discovery/fingerprint.js';
import { CANDIDATE_CLASSIFICATION_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_TEXT,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker, type FakeWorkerMode, type FakeWorkerValues } from '../../../tests/helpers/fake-audit-worker.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { sampleAction, sampleField, sampleForm } from '../../../tests/unit/discovery-candidate-samples.js';
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

const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404 });
/** ジョブの終わりを待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 60_000;
const WAIT_POLL_MS = 200;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 偽のワーカーの合図の間隔（ms）。 */
const FAKE_HEARTBEAT_INTERVAL_MS = 200;
const FAKE_RUN_ID = 'RUN-20261012000000';
const OTHER_RUN_ID = 'RUN-20261012000999';
/** 2 つの許可 Origin（偽のワーカーは接続しない。値は匿名のループバック）。 */
const ORIGIN_A = 'http://127.0.0.1:4173';
const ORIGIN_B = 'http://127.0.0.1:4174';
const PROFILE_ID = 't27f-two-origins';
const PUBLIC_PROFILE_ID = 't27f-public';
const RETIRED_PROFILE_ID = 't27f-retired';
const TARGET_NAME = 't27f-fake';
const PUBLIC_TARGET_NAME = 't27f-fake-public';
const OUTPUT_DIRECTORY = 't27f-fake-output';
const SCREENSHOT_DIRECTORY = process.env['T27F_SCREENSHOT_DIR'];

/** 偽のワーカーの入口（一時の root の、画面のサーバが fork する場所）。 */
const WORKER_ENTRY = 'dist/worker/audit-worker.js';

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];

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

const ALLOWED: ReadonlySet<string> = new Set([ORIGIN_A, ORIGIN_B]);
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }),
  ...computeCandidateDigests(discovered),
});
const ITEMS_PATH = '/admin/items';
/** 同じ path の、2 つの Origin の検索（READ）。 */
const SEARCH_A = candidateOf(sampleForm({
  page: { origin: ORIGIN_A, path: ITEMS_PATH }, formMethod: 'GET', action: sampleAction(ITEMS_PATH, [], ORIGIN_A), submitterText: '検索',
  fields: [
    sampleField('q', 'search'),
    sampleField('authenticity_token', 'hidden'),
    sampleField('kept', 'text', { readonly: true }),
    sampleField('api_key'),
    sampleField('status', 'select-one', { options: ['', 'open', 'closed'] }),
    // DEF-094（T28e fix round 1）: ファイルの欄は、名前にかかわらず値を送れない。
    sampleField('attachment', 'file'),
  ],
}));
const SEARCH_B = candidateOf(sampleForm({
  page: { origin: ORIGIN_B, path: ITEMS_PATH }, formMethod: 'GET', action: sampleAction(ITEMS_PATH, [], ORIGIN_B), submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));
/** 登録（CREATE。実行できない）。 */
const CREATE = candidateOf(sampleForm({
  page: { origin: ORIGIN_A, path: '/admin/new' }, formMethod: 'POST', action: sampleAction('/admin/items', [], ORIGIN_A), submitterText: '登録',
  fields: [sampleField('name'), sampleField('authenticity_token', 'hidden')],
}));

const discoveryDocument = (): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: '__JOB_ID__',
  runId: FAKE_RUN_ID,
  startedAt: '20261012000000',
  finishedAt: '20261012000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [
    { url: `${ORIGIN_A}${ITEMS_PATH}`, state: 'READ', record: { location: SEARCH_A.page, incompleteReasons: [], candidates: [SEARCH_A] }, blockedRequests: 0 },
    { url: `${ORIGIN_B}${ITEMS_PATH}`, state: 'READ', record: { location: SEARCH_B.page, incompleteReasons: [], candidates: [SEARCH_B] }, blockedRequests: 0 },
    { url: `${ORIGIN_A}/admin/new`, state: 'READ', record: { location: CREATE.page, incompleteReasons: [], candidates: [CREATE] }, blockedRequests: 0 },
    { url: `${ORIGIN_A}/admin/logout`, state: 'NOT_READ', reason: 'EXCLUDED' },
  ],
  omittedUnreadPages: 0,
});

/** 一時の root の監査のワーカーの入口を、偽のワーカーに替える。 */
const installFakeWorker = (mode: FakeWorkerMode, extra: Partial<FakeWorkerValues>): void => {
  const directory = `${rootOf().root}/fake-workers/${mode}`;
  mkdirSync(directory, { recursive: true });
  const worker = writeFakeWorker(directory, mode, {
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
    ...extra,
  });
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
};

interface JobDetail {
  readonly jobId: string;
  readonly jobKind: string;
  readonly state: string;
  readonly failureReason: string | null;
  readonly active: boolean;
  readonly artifacts: readonly { readonly kind: string; readonly href: string }[];
}

const waitForEnd = async (jobId: string): Promise<JobDetail> => {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const job = await valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });
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

const writeTarget = (name: string, origins: readonly string[]): string => {
  const path = `config/targets/${name}.json`;
  mkdirSync(`${rootOf().root}/config/targets`, { recursive: true });
  writeFileSync(`${rootOf().root}/${path}`, `${JSON.stringify({
    target: { id: name },
    site: { startUrl: `${origins[0] ?? ''}/admin`, allowedOrigins: [...origins] },
    crawl: { minNavigationIntervalMs: 0, maxPages: 10 },
    viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: OUTPUT_DIRECTORY },
  }, null, 2)}\n`, 'utf8');
  return path;
};

const testProfile = (profileId: string, targetConfigPath: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1',
  profileId,
  revision: 1,
  targetConfigPath,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN_A, ORIGIN_B],
  environmentEvidenceRef: 't27f-evidence',
});

const authSetup = (profileId: string): Record<string, unknown> => ({
  schemaVersion: 'beaksight-auth-setup/2',
  profileId,
  profileRevision: 1,
  loginStartUrl: `${ORIGIN_A}/login`,
  loginPostEndpoints: [{ origin: ORIGIN_A, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）。 */
const { openPage, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  const target = writeTarget(TARGET_NAME, [ORIGIN_A, ORIGIN_B]);
  const publicTarget = writeTarget(PUBLIC_TARGET_NAME, [ORIGIN_A]);
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const profileId of [PROFILE_ID, RETIRED_PROFILE_ID]) {
    expect(await valueOf('createProfileFn', 'POST', { profile: testProfile(profileId, target) })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetup(profileId) })).toMatchObject({ ok: true });
  }
  expect(await valueOf('createProfileFn', 'POST', {
    profile: {
      schemaVersion: 'beaksight-profile/1',
      profileId: PUBLIC_PROFILE_ID,
      revision: 1,
      targetConfigPath: publicTarget,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      auth: 'NONE',
      approvedTestOrigins: [],
      environmentEvidenceRef: null,
    },
  })).toMatchObject({ ok: true });
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

describe('T27f: discovery and READ check Server Functions (registration, input validation, CSRF)', () => {
  it('lists the Server Functions by name', () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining([
      'discoveryPageFn',
      'startDiscoveryFn',
      'readCheckPageFn',
      'createReadCheckFn',
      'updateReadCheckFn',
      'cancelReadCheckFn',
      'startReadCheckFn',
    ]));
  });

  it('rejects inputs that do not match the schemas with 400, and creates no job and no definition', async () => {
    const definition = { targetIdentityDigest: SEARCH_A.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['discoveryPageFn', 'GET', { profileId: 1 }],
      ['startDiscoveryFn', 'POST', { profileId: PROFILE_ID }],
      ['startDiscoveryFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1, startNew: true }],
      ['startReadCheckFn', 'POST', { profileId: 'NOT VALID', expectedRevision: 1 }],
      ['createReadCheckFn', 'POST', { profileId: PROFILE_ID }],
      ['createReadCheckFn', 'POST', { profileId: PROFILE_ID, definition, extra: true }],
      ['createReadCheckFn', 'POST', { profileId: PROFILE_ID, definition: 'not an object' }],
      ['updateReadCheckFn', 'POST', { readCheckId: '../x', expectedRevision: 1, definition }],
      ['updateReadCheckFn', 'POST', { readCheckId: 'read-1', expectedRevision: 0, definition }],
      ['cancelReadCheckFn', 'POST', { readCheckId: 'read-1' }],
      ['readCheckPageFn', 'GET', { profileId: '' }],
    ];
    for (const [name, method, data] of rejected) {
      const result = await call(name, method, data);
      expect(result.response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('listAuditJobsFn', 'GET')).toEqual([]);
    expect(await valueOf('readCheckPageFn', 'GET', { profileId: PROFILE_ID })).toMatchObject({ definitions: [] });
  });

  it('keeps the CSRF protection: a cross-site or other-origin POST is 403, and changes nothing', async () => {
    const definition = { targetIdentityDigest: SEARCH_A.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
    for (const [name, data] of [
      ['startDiscoveryFn', { profileId: PROFILE_ID, expectedRevision: 1 }],
      ['startReadCheckFn', { profileId: PROFILE_ID, expectedRevision: 1 }],
      ['createReadCheckFn', { profileId: PROFILE_ID, definition }],
      ['cancelReadCheckFn', { readCheckId: 'read-1', expectedRevision: 1 }],
    ] as const) {
      for (const headers of [
        { 'sec-fetch-site': 'cross-site', origin: started().origin },
        { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
        { origin: 'http://attacker.invalid' },
      ]) {
        const response = await rawRequest(started().port, `/_serverFn/${ids.get(name) ?? ''}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
          body: encodeServerFunctionPayload(data),
        });
        expect(response.status, `${name} ${JSON.stringify(headers)}`).toBe(STATUS.FORBIDDEN);
      }
    }
    expect(await valueOf('listAuditJobsFn', 'GET')).toEqual([]);
  });
});

describe('T27f: why a discovery or a READ check cannot start', () => {
  it('shows MODE_NOT_EXECUTABLE for a public profile and READ_CHECK_DEFINITIONS_MISSING without definitions, and the job manager rejects the same', async () => {
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: 'not-there' })).toBeNull();
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: PUBLIC_PROFILE_ID })).toMatchObject({
      eligible: false,
      start: { blocker: 'MODE_NOT_EXECUTABLE' },
      latest: null,
      candidates: [],
    });
    expect(await valueOf('startDiscoveryFn', 'POST', { profileId: PUBLIC_PROFILE_ID, expectedRevision: 1 }))
      .toEqual({ ok: false, reason: 'MODE_NOT_EXECUTABLE', errorCodes: [], authSetupErrors: [] });
    expect(await valueOf('readCheckPageFn', 'GET', { profileId: PROFILE_ID })).toMatchObject({
      eligible: true,
      editable: true,
      start: { blocker: 'READ_CHECK_DEFINITIONS_MISSING' },
    });
    expect(await valueOf('startReadCheckFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1 }))
      .toEqual({ ok: false, reason: 'READ_CHECK_DEFINITIONS_MISSING', errorCodes: [], authSetupErrors: [] });
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: PROFILE_ID })).toMatchObject({ eligible: true, start: { blocker: null } });

    const page = await openPage(`/discovery/${PUBLIC_PROFILE_ID}`);
    expect(await page.getByTestId('discovery-not-eligible').textContent()).toBe(LOCAL_UI_DISCOVERY_TEXT.notEligible);
    expect(await page.getByTestId('start-reason').getAttribute('data-reason')).toBe('MODE_NOT_EXECUTABLE');
    expect(await page.getByRole('button', { name: LOCAL_UI_DISCOVERY_TEXT.submit }).count()).toBe(0);
    await screenshot(page, 'f01-discovery-public-profile');
  });
});

describe('T27f: two allowed origins, the definition rejections, the retired profile and the results (fake worker)', () => {
  it('runs a discovery and shows the candidates of the same path apart by their origins', async () => {
    const document = discoveryDocument();
    installFakeWorker('discovery', {
      discovery: {
        outputDirectory: `${rootOf().root}/${OUTPUT_DIRECTORY}`,
        documentText: JSON.stringify(document),
        summary: { ...discoverySummaryOf(document) },
        runStatus: 'COMPLETE',
      },
    });
    const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1 });
    expect(job.ok).toBe(true);
    const ended = await waitForEnd(job.jobId);
    expect(ended).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', failureReason: null });
    expect(ended.artifacts.map((artifact) => artifact.kind)).toEqual(['DISCOVERY_JSON']);
    const artifact = await rawRequest(started().port, ended.artifacts[0]?.href ?? '', { headers: { cookie } });
    expect(artifact.status).toBe(STATUS.OK);
    expect(String(artifact.headers['content-disposition'])).toContain('attachment');

    const view = await valueOf<{
      showOrigins: boolean;
      latest: { jobId: string; result: { endReason: string; pagesRead: number; unreadReasons: unknown[] } | null } | null;
      candidates: readonly { identityDigest: string; pagePath: string; drift: string; classification: string; readCheckable: boolean;
        detail: { pageOrigin: string; fields: readonly { name: string; sendable: boolean; secretLike: boolean; options: unknown }[] } | null }[];
    }>('discoveryPageFn', 'GET', { profileId: PROFILE_ID });
    expect(view.showOrigins).toBe(true);
    expect(view.latest).toMatchObject({ jobId: job.jobId, result: { endReason: 'COMPLETED', pagesRead: 3, unreadReasons: [{ reason: 'EXCLUDED', count: 1 }] } });
    const byDigest = new Map(view.candidates.map((candidate) => [candidate.identityDigest, candidate]));
    expect(byDigest.get(SEARCH_A.identityDigest)).toMatchObject({ pagePath: ITEMS_PATH, drift: 'NEW', classification: 'READ', readCheckable: true, detail: { pageOrigin: ORIGIN_A } });
    expect(byDigest.get(SEARCH_B.identityDigest)).toMatchObject({ pagePath: ITEMS_PATH, drift: 'NEW', classification: 'READ', readCheckable: true, detail: { pageOrigin: ORIGIN_B } });
    expect(byDigest.get(CREATE.identityDigest)).toMatchObject({ classification: 'CREATE', readCheckable: false });
    // 送れる欄の判定（見える・読み取り専用でない・無効でない）と、秘密に見える名前の欄の選択肢を返さないこと。
    expect(byDigest.get(SEARCH_A.identityDigest)?.detail?.fields.map(({ name, sendable, secretLike }) => [name, sendable, secretLike])).toEqual([
      ['q', true, false],
      ['authenticity_token', false, true],
      ['kept', false, false],
      ['api_key', true, true],
      ['status', true, false],
      // DEF-094（T28e fix round 1。意図した変化）: ファイルの欄は送れない欄として示す（修正の前は「送れる」だった）。
      ['attachment', false, false],
    ]);

    const page = await openPage(`/discovery/${PROFILE_ID}`);
    const groups = page.getByTestId('discovery-page');
    expect(await groups.count()).toBe(3);
    const itemsGroups = page.locator(`[data-testid="discovery-page"][data-page-path="${ITEMS_PATH}"]`);
    expect(await itemsGroups.count()).toBe(2);
    expect(await itemsGroups.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-page-origin')).sort()))
      .toEqual([ORIGIN_A, ORIGIN_B]);
    for (const origin of [ORIGIN_A, ORIGIN_B]) {
      expect(await page.locator(`[data-testid="discovery-page"][data-page-origin="${origin}"][data-page-path="${ITEMS_PATH}"] h3`).textContent())
        .toContain(`${origin}${ITEMS_PATH}`);
    }
    const create = page.locator(`[data-testid="discovery-candidate"][data-digest="${CREATE.identityDigest}"]`);
    expect(await create.getAttribute('data-classification')).toBe('CREATE');
    expect(await create.getByTestId('candidate-execution').textContent()).toContain(LOCAL_UI_DISCOVERY_TEXT.notExecutable);
    expect(await create.getByText(CANDIDATE_CLASSIFICATION_CATALOG.CREATE.label).count()).toBe(1);
    await screenshot(page, 'f02-discovery-two-origins');
  });

  it('returns the reasons of a rejected definition by item, and saves, changes and removes a definition', async () => {
    const base = { targetIdentityDigest: SEARCH_A.identityDigest, parameters: { q: 'test-value' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
    const create = (definition: unknown) => valueOf<Record<string, unknown>>('createReadCheckFn', 'POST', { profileId: PROFILE_ID, definition });
    expect(await create({ ...base, parameters: { q: 'x', api_key: 'y', authenticity_token: 'z', kept: 'w', attachment: 'f', unknown: 'v' } })).toEqual({
      ok: false,
      reason: 'READ_PARAMETER_SECRET_LIKE',
      errors: [
        { code: 'READ_PARAMETER_SECRET_LIKE', parameter: 'api_key' },
        { code: 'READ_PARAMETER_SECRET_LIKE', parameter: 'authenticity_token' },
        { code: 'READ_PARAMETER_NOT_ALLOWED', parameter: 'kept' },
        // DEF-094（T28e fix round 1）: ファイルの欄の値は、保存を拒む。
        { code: 'READ_PARAMETER_NOT_ALLOWED', parameter: 'attachment' },
        { code: 'READ_PARAMETER_NOT_ALLOWED', parameter: 'unknown' },
      ],
    });
    expect(await create({ ...base, targetIdentityDigest: CREATE.identityDigest, parameters: { name: 'x' } }))
      .toEqual({ ok: false, reason: 'READ_CANDIDATE_NOT_READ', errors: [{ code: 'READ_CANDIDATE_NOT_READ', parameter: null }] });
    expect(await create({ ...base, targetIdentityDigest: `sha256:${'f'.repeat(64)}` }))
      .toEqual({ ok: false, reason: 'READ_CANDIDATE_UNKNOWN', errors: [{ code: 'READ_CANDIDATE_UNKNOWN', parameter: null }] });
    expect(await create({ ...base, expectations: [] })).toMatchObject({ ok: false, reason: 'READ_CHECK_INPUT_INVALID' });
    expect(Object.keys(READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS)).toContain('READ_CHECK_PROFILE_RETIRED');

    const saved = await create(base) as { ok: boolean; readCheckId: string; revision: number };
    expect(saved).toMatchObject({ ok: true, revision: 1 });
    const changed = { ...base, parameters: { q: 'other-value', status: 'open' } };
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: saved.readCheckId, expectedRevision: 1, definition: changed }))
      .toEqual({ ok: true, readCheckId: saved.readCheckId, revision: 2 });
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: saved.readCheckId, expectedRevision: 1, definition: changed }))
      .toEqual({ ok: false, reason: 'READ_CHECK_REVISION_CONFLICT', errors: [{ code: 'READ_CHECK_REVISION_CONFLICT', parameter: null }] });
    const page = await valueOf<{ definitions: readonly { readCheckId: string; revision: number; definition: unknown; candidate: unknown }[]; start: { blocker: unknown } }>(
      'readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    expect(page.definitions).toEqual([expect.objectContaining({ readCheckId: saved.readCheckId, revision: 2, definition: changed })]);
    expect(page.start.blocker).toBeNull();

    const second = await create({ ...base, targetIdentityDigest: SEARCH_B.identityDigest }) as { readCheckId: string };
    expect(await valueOf('cancelReadCheckFn', 'POST', { readCheckId: second.readCheckId, expectedRevision: 1 })).toEqual({ ok: true });
    expect(await valueOf('cancelReadCheckFn', 'POST', { readCheckId: second.readCheckId, expectedRevision: 1 }))
      .toEqual({ ok: false, reason: 'READ_CHECK_CANCELED' });
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: second.readCheckId, expectedRevision: 1, definition: base }))
      .toEqual({ ok: false, reason: 'READ_CHECK_CANCELED', errors: [{ code: 'READ_CHECK_CANCELED', parameter: null }] });
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: 'no-such-check', expectedRevision: 1, definition: base }))
      .toEqual({ ok: false, reason: 'READ_CHECK_NOT_FOUND', errors: [{ code: 'READ_CHECK_NOT_FOUND', parameter: null }] });
  });

  it('runs the READ checks and shows the results by definition with the detail and the link to read-evidence.json', async () => {
    installFakeWorker('read-check', { readCheck: { outputDirectory: `${rootOf().root}/${OUTPUT_DIRECTORY}`, results: ['NOT_MATCHED'] } });
    const job = await valueOf<{ ok: boolean; jobId: string }>('startReadCheckFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1 });
    expect(job.ok).toBe(true);
    const ended = await waitForEnd(job.jobId);
    expect(ended).toMatchObject({ jobKind: 'READ_CHECK', state: 'FINISHED', failureReason: null });
    expect(ended.artifacts.map((artifact) => artifact.kind)).toEqual(['DISCOVERY_JSON', 'READ_EVIDENCE_JSON']);
    const view = await valueOf<{ results: readonly { jobId: string; evidenceHref: string | null; endReason: string | null;
      results: readonly { result: string; detail: string | null }[] }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    expect(view.results).toEqual([expect.objectContaining({
      jobId: job.jobId,
      evidenceHref: `/artifacts/${job.jobId}/read-evidence.json`,
      endReason: 'COMPLETED',
      results: [expect.objectContaining({ result: 'NOT_MATCHED', detail: 'EXPECTATIONS_EVALUATED' })],
    })]);
    const evidence = await rawRequest(started().port, view.results[0]?.evidenceHref ?? '', { headers: { cookie } });
    expect(evidence.status).toBe(STATUS.OK);

    const jobPage = await openPage(`/jobs/${job.jobId}`);
    expect(await jobPage.getByTestId('job-kind').getAttribute('data-kind')).toBe('READ_CHECK');
    expect(await jobPage.getByTestId('job-no-progress').textContent()).toBe(LOCAL_UI_DISCOVERY_TEXT.job.noProgress);
    expect(await jobPage.getByTestId('job-progress-empty').count()).toBe(0);
    await screenshot(jobPage, 'f03-read-check-job');

    const page = await openPage(`/read-checks/${PROFILE_ID}`);
    const row = page.locator(`[data-testid="read-check-result"][data-job-id="${job.jobId}"]`).first();
    expect(await row.getAttribute('data-result')).toBe('NOT_MATCHED');
    expect(await row.getAttribute('data-detail')).toBe('EXPECTATIONS_EVALUATED');
    expect(await page.getByTestId('read-check-evidence').getAttribute('href')).toBe(`/artifacts/${job.jobId}/read-evidence.json`);
    await screenshot(page, 'f04-read-check-results');
  });

  it('does not create or change a definition on a retired profile (READ_CHECK_PROFILE_RETIRED), and still removes one', async () => {
    const definition = { targetIdentityDigest: SEARCH_A.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
    // 取り消す前は、発見の記録がないので、候補が分からない（READ_CANDIDATE_UNKNOWN）。取り消した後は、候補の検証の前に、プロファイルの状態で拒む。
    const saved = await valueOf<{ ok: boolean; reason?: string }>('createReadCheckFn', 'POST', { profileId: RETIRED_PROFILE_ID, definition });
    expect(saved).toMatchObject({ ok: false, reason: 'READ_CANDIDATE_UNKNOWN' });
    expect(await valueOf('retireProfileFn', 'POST', { profileId: RETIRED_PROFILE_ID, expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(await valueOf('createReadCheckFn', 'POST', { profileId: RETIRED_PROFILE_ID, definition }))
      .toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_RETIRED', errors: [{ code: 'READ_CHECK_PROFILE_RETIRED', parameter: null }] });
    expect(await valueOf('createReadCheckFn', 'POST', { profileId: 'not-there', definition }))
      .toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_NOT_FOUND', errors: [{ code: 'READ_CHECK_PROFILE_NOT_FOUND', parameter: null }] });
    // T28b fix round 1: READ の確かめを許さないモードのプロファイル（公開の監査）では、候補の検証の前に、モードで拒む。
    expect(await valueOf('createReadCheckFn', 'POST', { profileId: PUBLIC_PROFILE_ID, definition }))
      .toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_NOT_ELIGIBLE', errors: [{ code: 'READ_CHECK_PROFILE_NOT_ELIGIBLE', parameter: null }] });
    expect(await valueOf('readCheckPageFn', 'GET', { profileId: RETIRED_PROFILE_ID })).toMatchObject({ editable: false, start: { blocker: 'PROFILE_RETIRED' } });
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: RETIRED_PROFILE_ID })).toMatchObject({ start: { blocker: 'PROFILE_RETIRED' } });
    expect(await valueOf('startDiscoveryFn', 'POST', { profileId: RETIRED_PROFILE_ID, expectedRevision: 2 }))
      .toMatchObject({ ok: false, reason: 'PROFILE_RETIRED' });
    const page = await openPage(`/read-checks/${RETIRED_PROFILE_ID}`);
    expect(await page.getByTestId('read-check-retired').count()).toBe(1);
    expect(await page.getByRole('button', { name: LOCAL_UI_DISCOVERY_TEXT.submit }).count()).toBe(0);

    // 定義のあるプロファイルを取り消すと、定義は変えられない（READ_CHECK_PROFILE_RETIRED）が、削除はできる。
    const before = await valueOf<{ definitions: readonly { readCheckId: string; revision: number }[] }>('readCheckPageFn', 'GET', { profileId: PROFILE_ID });
    const [kept] = before.definitions;
    expect(kept).toBeDefined();
    expect(await valueOf('retireProfileFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(await valueOf('updateReadCheckFn', 'POST', { readCheckId: kept?.readCheckId, expectedRevision: kept?.revision, definition }))
      .toEqual({ ok: false, reason: 'READ_CHECK_PROFILE_RETIRED', errors: [{ code: 'READ_CHECK_PROFILE_RETIRED', parameter: null }] });
    expect(await valueOf('cancelReadCheckFn', 'POST', { readCheckId: kept?.readCheckId, expectedRevision: kept?.revision })).toEqual({ ok: true });
    const retiredPage = await openPage(`/discovery/${PROFILE_ID}`);
    expect(await retiredPage.getByTestId('start-reason').getAttribute('data-reason')).toBe('PROFILE_RETIRED');
    expect(await retiredPage.getByTestId('candidate-create-read-check').count()).toBe(0);
    await screenshot(retiredPage, 'f05-discovery-retired-profile');
  });
});

describe('T27f: the browser bundle does not include the server parts', () => {
  it('has no SQL, node: modules or server-only names in dist/client', () => {
    const clientDirectory = `${rootOf().root}/apps/local-ui/dist/client`;
    const files = readdirSync(clientDirectory, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    const text = files.map((path) => readFileSync(`${clientDirectory}/${path}`, 'utf8')).join('\n');
    // 管理データの表の名前（SQL）と、サーバの部品の名前（ビルドで名前が残る文字列）。
    for (const marker of ['discovery_candidates', 'discovery_jobs', 'read_check_results', 'FROM read_checks', 'SELECT ']) {
      expect(text.includes(marker), marker).toBe(false);
    }
    // Node の部品の指定子（文言の中の「node:sqlite」などの語は数えない。引用符で囲まれた指定子だけ）。
    expect(text.match(/["'`]node:[a-z/_]+["'`]/gu) ?? []).toEqual([]);
  });
});

// T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5、10 章の 5）: 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルでも、認証の設定・発見・READ の
// 確かめを使える（画面の出し分けは、`src/control/execution-policy.ts` の判定）。プロファイルの詳細に、認証の設定と、操作の候補・READ の確かめへの
// 動線を出す。認証つきの監査は始められない（一覧に「監査を始める」を出さず、開始の確かめは `MODE_NOT_EXECUTABLE`。フォームの案内で理由を出す）。
describe('T28b: a write mode profile uses the auth setup, the discovery and the READ checks, but not the audit', () => {
  const WRITE_PROFILE_ID = 't28b-write';

  it('saves the auth setup, offers the discovery and the READ checks, and shows why the audit cannot start', async () => {
    const target = `config/targets/${TARGET_NAME}.json`;
    expect(await valueOf('createProfileFn', 'POST', { profile: { ...testProfile(WRITE_PROFILE_ID, target), mode: 'TEST_APPROVED_WRITE' } }))
      .toMatchObject({ ok: true });
    expect(await valueOf('getAuthSetupFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ eligible: true, stored: null });
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ eligible: true, start: { blocker: 'AUTH_SETUP_MISSING' } });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetup(WRITE_PROFILE_ID) })).toMatchObject({ ok: true });
    expect(await valueOf('discoveryPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ eligible: true, start: { blocker: null } });
    expect(await valueOf('readCheckPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({
      eligible: true,
      editable: true,
      start: { blocker: 'READ_CHECK_DEFINITIONS_MISSING' },
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({
      mode: 'TEST_APPROVED_WRITE',
      blocker: 'MODE_NOT_EXECUTABLE',
      authRequired: false,
    });
    expect(await valueOf('startAuditJobFn', 'POST', { profileId: WRITE_PROFILE_ID, expectedRevision: 1, startNew: true }))
      .toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });

    const detail = await openPage(`/profiles/${WRITE_PROFILE_ID}`);
    const authPanel = detail.getByTestId('profile-auth-setup');
    expect(await authPanel.getByRole('link', { name: LOCAL_UI_AUTH_TEXT.profileDetail.open }).getAttribute('href')).toBe(`/auth-setup/${WRITE_PROFILE_ID}`);
    const discoveryPanel = detail.getByTestId('profile-discovery');
    expect(await discoveryPanel.getByRole('link', { name: LOCAL_UI_DISCOVERY_TEXT.profileDetail.openDiscovery }).getAttribute('href'))
      .toBe(`/discovery/${WRITE_PROFILE_ID}`);
    expect(await discoveryPanel.getByRole('link', { name: LOCAL_UI_DISCOVERY_TEXT.profileDetail.openReadChecks }).getAttribute('href'))
      .toBe(`/read-checks/${WRITE_PROFILE_ID}`);
    // 手動のログインなので、資格情報の動線は出さない。認証つきの監査を始められない理由は、フォームの案内で出す。
    expect(await detail.getByTestId('profile-credentials').count()).toBe(0);
    expect(await detail.getByText(LOCAL_UI_TEXT.profileForm.testModeNotice).count()).toBe(1);
    await screenshot(detail, 't28b-write-profile-detail');

    const discovery = await openPage(`/discovery/${WRITE_PROFILE_ID}`);
    expect(await discovery.getByTestId('discovery-not-eligible').count()).toBe(0);
    expect(await discovery.getByRole('button', { name: LOCAL_UI_DISCOVERY_TEXT.submit }).count()).toBe(1);

    const list = await openPage('/');
    const row = list.locator(`[data-profile-id="${WRITE_PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
  });
});
