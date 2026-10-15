/**
 * シナリオの画面（一覧・作成・詳細・承認・撤回・変更・差分・履歴）と、その Server Functions を、ビルドした画面のサーバ（一時の root）で確かめる
 * （Task 28 の設計書 3 章、4.6、4.7。T28e）。監査のワーカーは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の
 * `discovery`。サイトに接続しない）に替えて、最後の発見のジョブ（`discovery.json` と候補の索引）を作る。
 * - 入力の検証（`schemas/control/ui-scenario-*`）: 合わない入力は 400 で、何も作らない。CSRF: cross-site の POST と Origin の違う POST は 403。
 * - 書き込みのモード（`TEST_APPROVED_WRITE`）でないプロファイルには、シナリオの動線（プロファイルの詳細、候補の「シナリオを作る」）が出ず、
 *   サーバも拒む（`SCENARIO_MODE_NOT_WRITE`）。「シナリオを作る」は、登録（CREATE）・更新（UPDATE）の候補だけに出る。
 * - 作成: 送る欄は候補の送れる欄だけを選べる（秘密に見える名前・危険な語・送れない欄・パスワードの欄は選べず、理由が出る）。拒む理由は項目ごと。
 * - 承認の守り: 確認のダイアログなしに承認できない（開くと取り消し側にフォーカス。Enter・Escape では承認しない）。古い画面の承認は拒まれる
 *   （版の衝突、承認の digest の不一致）。副作用の未確認は拒まれる。撤回も確認のダイアログの後だけ。
 * - 差分（最後の承認との、項目ごとの機械の読める差分と日本語の説明）、状態（下書き・承認済み・要再承認・撤回済み）、承認と撤回の履歴、版の履歴。
 * - 書き込みを実行するボタンと、実行の許可を出す Server Function がない。画面と応答に、Cookie・画面の token・選択肢の値が出ない。
 *   T30g（Task 30 の設計書 3 章、T30g の Blocker の判断（案 A））: 書き込みの開始は、開始の画面（`write-job-functions.ts` の 2 つの Server Function）
 *   だけにある。シナリオの画面（一覧・作成・詳細・変更）には、書き込みを実行するボタンがない（開始の画面へのリンクだけ）。
 * - T30g: 検証の指定の入力と保存、未指定のときの「実行できない理由」、開始の画面の確かめる内容と拒む理由（承認・間隔・モード）、CSRF のない開始の
 *   要求を拒む、偽のワーカーでの開始から結果（`UNKNOWN`）の表示、記録だけを入れた管理データの結果（`VERIFIED`・`PARTIAL`・`BLOCKED`）の表示、
 *   予約が `RESERVED` のまま残らない。
 * - すべての画面で、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。ブラウザのバンドルに、シナリオの表の SQL が入らない。
 * - T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」）: UPDATE の候補の作成の画面で、台帳（登録のシナリオ）、候補の path から作る型（作れなければ
 *   手で入力）、欄の役割（既定は保つ。メールと電話も保つ。状態の欄は変えられない）を、キーボードだけで入れて保存する。下書きの誤りを入力の近くに出す。
 *   秘密に見える名前の見える欄がある画面は、候補を作れない理由を出す。詳細に UPDATE の指定と更新の予定のレコード（ある・ない）を出す。CSRF のない
 *   要求と、書き込みのモードでないプロファイルは拒む。
 * - T31h-2（Task 31 の設計書 3 章の「対象の選び方」「証拠と記録」、10 章）: UPDATE の開始の画面に、更新するレコード（予定のレコード）、変える欄と
 *   保つ欄、型に ID を入れた送り先と画面の path を出す。承認がない・対象のレコードがないときは始められない。CSRF のない開始の要求を拒む。画面が
 *   見せた予定の ID が発行の時に変わったら（管理データに新しい登録を足して作る）、`TARGET_SELECTION_CHANGED` をカタログの文言で出す。偽のワーカー
 *   （`action-run.json` の UPDATE の形を書く）で画面から始め、本当の締めの道で決めた結果（`VERIFIED` の前後の差分、`UNKNOWN` の
 *   `UNEXPECTED_FIELD_CHANGE`、`PARTIAL` の `UPDATE_POSTCHECK_UNDETERMINED`）をジョブの詳細と履歴に出す。保つ欄の値は出さない（記録にない）。
 *   書き込みのモードでないプロファイルは始められない。同じシナリオの連続の書き込みの間隔があるので、結果ごとに UPDATE のシナリオを分ける。
 * - T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」「監査済みデータの台帳」）: 偽のワーカーが書いた報告（証拠・承認の要約・HTML・ZIP）が
 *   親の確かめに通ったジョブだけ、4 つの成果物を配り、結果の画面と履歴に開く・落とすリンクを出す（HTML は style の hash の CSP の下で色が当たる）。
 *   通らない報告（ZIP の後に HTML を書き換えた）は、ファイルがあっても配らず、理由を出す。許可の外・パストラバーサル・別のジョブ・Host の違いは
 *   配らない。台帳の画面（プロファイルの画面からキーボードで開く）は管理データの台帳と同じ行を出し、注記を出す。CSRF・Host・入力の誤りを拒み、
 *   書き込みのモードでないプロファイルには台帳を出さない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。Chromium は headless だけ。スクリーンショットは、環境変数
 * `T28E_SCREENSHOT_DIR` があれば、そこに保存する。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../../src/cli/exit-codes.js';
import { WORKER_PROTOCOL_VERSION } from '../../../src/control/worker-protocol.js';
import { APPROVAL_SUMMARY_SCHEMA_VERSION } from '../../../src/control/actions/action-contracts.js';
import { readAuditedDataLedger } from '../../../src/control/actions/write-result-facts.js';
import { readApprovalReceipts, readScenario, readWriteReservations } from '../../../src/control/approval/scenario-store.js';
import { RECORD_ID_PLACEHOLDER } from '../../../src/control/approval-view.js';
import { readJob } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
} from '../../../src/core/artifact-layout.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoverySummaryOf, type DiscoveryDocument } from '../../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../../src/discovery/fingerprint.js';
import { ACTION_OUTCOME_REASON_CATALOG, APPROVAL_DIGEST_ITEM_CATALOG, WRITE_REPORT_CHECK_CATALOG } from '../../../src/presentation/catalog.js';
import {
  EXECUTION_GRANT_REJECTION_DESCRIPTIONS,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_REPORT_TEXT,
  LOCAL_UI_WRITE_TEXT,
  SCENARIO_DRAFT_REJECTION_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  WRITE_START_LOCAL_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker, type FakeWorkerValues } from '../../../tests/helpers/fake-audit-worker.js';
import { verifiedUpdateDocuments } from '../../../tests/helpers/action-report-samples.js';
import { seedWriteResultForTest } from '../../../tests/helpers/write-result-fixtures.js';
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

const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, MISDIRECTED: 421 });
/** ジョブの終わりを待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 60_000;
const WAIT_POLL_MS = 200;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** 画面の操作を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 200;
/** 偽のワーカーの合図の間隔（ms）。 */
const FAKE_HEARTBEAT_INTERVAL_MS = 200;
const FAKE_RUN_ID = 'RUN-20261013000000';
const OTHER_RUN_ID = 'RUN-20261013000999';
/** 許可 Origin（偽のワーカーは接続しない。値は匿名のループバック）。 */
const ORIGIN = 'http://127.0.0.1:4173';
const WRITE_PROFILE_ID = 't28e-write';
const PASSIVE_PROFILE_ID = 't28e-passive';
const FIRST_REVISION = 1;
/** 選択肢の値の目印（ページが書いた値。シナリオの画面と応答には出さない）。 */
const OPTION_MARKER = 'opt-t28e-marker-7f3a';
const SCREENSHOT_DIRECTORY = process.env['T28E_SCREENSHOT_DIR'];

/** 偽のワーカーの入口（一時の root の、画面のサーバが fork する場所）。 */
const WORKER_ENTRY = 'dist/worker/audit-worker.js';

const text = LOCAL_UI_SCENARIO_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
const descendants: ProcessIdentity[] = [];
/** テストをまたいで使う値。 */
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
/** 登録（CREATE）。送れる欄、秘密に見える名前、危険な語、読み取り専用、パスワード、見えない欄、選択肢の値の目印を持つ。 */
const CREATE = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/admin/members/new' }, formMethod: 'POST', action: sampleAction('/admin/members', [], ORIGIN), submitterText: '登録',
  fields: [
    sampleField('name', 'text', { required: true, constraints: { ...NO_CONSTRAINTS, maxlength: '40' } }),
    sampleField('email', 'email'),
    sampleField('plan', 'select-one', { options: ['', OPTION_MARKER] }),
    sampleField('authenticity_token', 'hidden', { hasValue: true }),
    sampleField('api_key'),
    sampleField('delete_flag', 'checkbox'),
    sampleField('kept', 'text', { readonly: true }),
    sampleField('pin', 'password'),
  ],
}));
/**
 * 更新（UPDATE。`_method` の PATCH）。T31h-1: 欄の役割の確かめのため、メール・電話・状態の欄（select の `status`）・見えない欄・読み取り専用の欄を
 * 持つ。画面の path と送信先の path で、`admin`・`members`・`1` の区切りが同じ（型の組は 3 つ）。
 */
const UPDATE = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/admin/members/1/edit' }, formMethod: 'POST', methodOverride: 'PATCH', action: sampleAction('/admin/members/1', [], ORIGIN),
  submitterText: '更新',
  fields: [
    sampleField('name'),
    sampleField('email', 'email'),
    sampleField('phone', 'tel'),
    sampleField('status', 'select-one', { options: ['active', 'paused'] }),
    sampleField('note', 'textarea'),
    sampleField('_method', 'hidden', { hasValue: true }),
    sampleField('lock_version', 'hidden', { hasValue: true }),
    sampleField('kept', 'text', { readonly: true }),
  ],
}));
/** T31h-1: 秘密に見える名前の見える欄（`api_key`）がある更新の画面（UPDATE を受けない）。 */
const UPDATE_SECRET = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/admin/keys/2/edit' }, formMethod: 'POST', methodOverride: 'PATCH', action: sampleAction('/admin/keys/2', [], ORIGIN),
  submitterText: '更新',
  fields: [sampleField('label'), sampleField('api_key'), sampleField('_method', 'hidden', { hasValue: true })],
}));
/** T31h-1: 画面の path と送信先の path に同じ区切りがない更新の画面（型を作れない。手で入力する）。 */
const UPDATE_NO_TEMPLATE = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/edit-profile' }, formMethod: 'POST', methodOverride: 'PATCH', action: sampleAction('/profile-save', [], ORIGIN),
  submitterText: '更新',
  fields: [sampleField('nickname'), sampleField('_method', 'hidden', { hasValue: true })],
}));
/** 検索（READ）。 */
const SEARCH = candidateOf(sampleForm({
  page: { origin: ORIGIN, path: '/admin/members' }, formMethod: 'GET', action: sampleAction('/admin/members', [], ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search')],
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
  pages: [CREATE, UPDATE, SEARCH, UPDATE_SECRET, UPDATE_NO_TEMPLATE].map((candidate) => ({
    url: `${candidate.page.origin}${candidate.page.path}`,
    state: 'READ' as const,
    record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
    blockedRequests: 0,
  })),
  omittedUnreadPages: 0,
});

/** 一時の root の監査のワーカーの入口を、発見の偽のワーカーに替える（出力先はプロファイルの設定のもの）。 */
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

/** 発見を 1 回行う（偽のワーカー）。 */
const discover = async (profileId: string, outputDirectory: string): Promise<void> => {
  installFakeDiscovery(outputDirectory);
  const job = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', { profileId, expectedRevision: FIRST_REVISION });
  expect(job.ok).toBe(true);
  expect(await waitForEnd(job.jobId)).toMatchObject({ state: 'FINISHED' });
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
  environmentEvidenceRef: 't28e-evidence',
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

/** 副作用の確認（4 項目）。 */
const confirmations = (confirmed: boolean): Record<string, boolean> =>
  Object.fromEntries(['TEST_RECORDS_ONLY', 'NO_EXTERNAL_NOTIFICATION', 'NO_PAYMENT_OR_EXTERNAL_SERVICE', 'NOT_DESTRUCTIVE'].map((item) => [item, confirmed]));

/** 下書き（作成の形）。 */
const draftOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  profileId: WRITE_PROFILE_ID,
  candidateIdentityDigest: CREATE.identityDigest,
  fieldNames: ['name'],
  readChecks: [],
  sideEffectConfirmations: confirmations(true),
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  ...overrides,
});

/** 変更の下書き（プロファイルと候補を持たない）。 */
const changeOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const { profileId: _profileId, candidateIdentityDigest: _candidate, ...rest } = draftOf(overrides);
  return rest;
};

interface DetailView {
  readonly eligible: boolean;
  readonly editable: boolean;
  readonly scenario: { readonly scenarioId: string; readonly revision: number; readonly state: string; readonly fieldNames: readonly string[] };
  readonly status: { readonly displayState: string; readonly reasons: readonly string[]; readonly approvalDigest: string; readonly expiresAt: string | null } | null;
  readonly unconfirmedSideEffects: readonly string[];
  readonly history: readonly { readonly kind: string; readonly scenarioRevision: number | null }[];
  readonly revisions: readonly { readonly revision: number }[];
  readonly lastApprovalRevision: number | null;
  readonly differences: readonly { readonly item: string; readonly previous: unknown; readonly current: unknown }[] | null;
}

const detailOf = (scenarioId: string): Promise<DetailView> => valueOf<DetailView>('scenarioDetailPageFn', 'GET', { scenarioId });

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）。 */
const { openPage, tabTo, screenshot, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: SCREENSHOT_DIRECTORY,
});

/** フォーカスのある要素の文字。 */
const focusedText = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.textContent ?? '');

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  state.writeTarget = writeTarget('t28e-write', 't28e-write-output');
  const passiveTarget = writeTarget('t28e-passive', 't28e-passive-output');
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const [profileId, target, mode] of [
    [WRITE_PROFILE_ID, state.writeTarget, 'TEST_APPROVED_WRITE'],
    [PASSIVE_PROFILE_ID, passiveTarget, 'TEST_AUTH_PASSIVE'],
  ] as const) {
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocument(profileId, target, mode, FIRST_REVISION) })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetup(profileId) })).toMatchObject({ ok: true });
  }
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

describe('T28e: scenario Server Functions (registration, input validation, CSRF, no execution path)', () => {
  it('lists the scenario Server Functions by name, and no Server Function issues or consumes an execution grant', () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining([
      'scenarioListPageFn',
      'scenarioFormPageFn',
      'scenarioDetailPageFn',
      'createScenarioFn',
      'updateScenarioFn',
      'approveScenarioFn',
      'revokeScenarioFn',
      // T32g: 監査済みデータの台帳の画面（読むだけ）。
      'auditedDataLedgerPageFn',
    ]));
    // T30g: 書き込みの開始の画面の Server Function だけ（許可の消費・予約の締めの Server Function はない）。T31h-2: UPDATE の開始を足した。
    expect([...ids.keys()].filter((name) => /grant|reserv|consume|execut|settle|write/iu.test(name)).sort())
      .toEqual(['startWriteCreateFn', 'startWriteUpdateFn', 'writeStartPageFn']);
  });

  it('rejects inputs that do not match the schemas with 400, and creates nothing', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['scenarioListPageFn', 'GET', { profileId: '' }],
      ['scenarioFormPageFn', 'GET', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: 'not-a-digest' }],
      ['scenarioDetailPageFn', 'GET', { scenarioId: '../x' }],
      ['createScenarioFn', 'POST', { draft: draftOf(), extra: true }],
      ['createScenarioFn', 'POST', { draft: 'not an object' }],
      ['updateScenarioFn', 'POST', { scenarioId: 'scenario-1', expectedRevision: 0, draft: changeOf() }],
      ['updateScenarioFn', 'POST', { scenarioId: 'scenario-1', expectedRevision: 1, draft: draftOf() }],
      ['approveScenarioFn', 'POST', { scenarioId: 'scenario-1', expectedRevision: 1 }],
      ['approveScenarioFn', 'POST', { scenarioId: 'scenario-1', expectedRevision: 1, expectedApprovalDigest: 'sha256:xyz' }],
      ['approveScenarioFn', 'POST', { scenarioId: 'scenario-1', expectedRevision: 1, expectedApprovalDigest: digest, confirmed: true }],
      ['revokeScenarioFn', 'POST', { scenarioId: 'Scenario-1', expectedRevision: 1 }],
    ];
    for (const [name, method, data] of rejected) {
      const result = await call(name, method, data);
      expect(result.response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ eligible: true, scenarios: [] });
  });

  it('keeps the CSRF protection: a cross-site or other-origin POST is 403, and changes nothing', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    for (const [name, data] of [
      ['createScenarioFn', { draft: draftOf() }],
      ['updateScenarioFn', { scenarioId: 'scenario-1', expectedRevision: 1, draft: changeOf() }],
      ['approveScenarioFn', { scenarioId: 'scenario-1', expectedRevision: 1, expectedApprovalDigest: digest }],
      ['revokeScenarioFn', { scenarioId: 'scenario-1', expectedRevision: 1 }],
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
    expect(await valueOf('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ scenarios: [] });
  });
});

describe('T28e: the scenario screens', () => {
  it('offers the scenarios only to the write mode profile, and only for the CREATE and UPDATE candidates', async () => {
    await discover(WRITE_PROFILE_ID, 't28e-write-output');
    await discover(PASSIVE_PROFILE_ID, 't28e-passive-output');

    const write = await openPage(`/discovery/${WRITE_PROFILE_ID}`);
    for (const [candidate, shown] of [[CREATE, 1], [UPDATE, 1], [SEARCH, 0]] as const) {
      expect(await write.locator(`[data-testid="discovery-candidate"][data-digest="${candidate.identityDigest}"]`)
        .getByTestId('candidate-create-scenario').count(), candidate.classification).toBe(shown);
    }
    await screenshot(write, 'e01-discovery-create-scenario-links');
    const passive = await openPage(`/discovery/${PASSIVE_PROFILE_ID}`);
    expect(await passive.getByTestId('candidate-create-scenario').count()).toBe(0);

    const writeDetail = await openPage(`/profiles/${WRITE_PROFILE_ID}`);
    expect(await writeDetail.getByTestId('profile-scenarios').getByRole('link', { name: text.profileDetail.open }).getAttribute('href'))
      .toBe(`/scenarios/${WRITE_PROFILE_ID}`);
    const passiveDetail = await openPage(`/profiles/${PASSIVE_PROFILE_ID}`);
    expect(await passiveDetail.getByTestId('profile-scenarios').count()).toBe(0);

    // サーバも拒む（画面の動線がなくても、書き込みのモードでないプロファイルにはシナリオを作らない）。
    expect(await valueOf('scenarioListPageFn', 'GET', { profileId: PASSIVE_PROFILE_ID })).toMatchObject({ eligible: false, editable: false });
    expect(await valueOf('createScenarioFn', 'POST', { draft: draftOf({ profileId: PASSIVE_PROFILE_ID }) }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_MODE_NOT_WRITE' });
    const passiveList = await openPage(`/scenarios/${PASSIVE_PROFILE_ID}`);
    expect(await passiveList.getByTestId('scenario-not-eligible').textContent()).toBe(text.notEligible);
    expect(await valueOf('scenarioListPageFn', 'GET', { profileId: PASSIVE_PROFILE_ID })).toMatchObject({ scenarios: [] });
  });

  it('lets only the sendable fields be selected, and shows why the others cannot be', async () => {
    const form = await valueOf<{
      candidate: { fields: readonly { name: string; rejection: string | null }[] } | null;
      candidateRejection: string | null;
      rules: Record<string, unknown>;
    }>('scenarioFormPageFn', 'GET', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: CREATE.identityDigest });
    expect(form.candidateRejection).toBeNull();
    expect(form.candidate?.fields.map(({ name, rejection }) => [name, rejection])).toEqual([
      ['name', null],
      ['email', null],
      ['plan', null],
      ['authenticity_token', 'SCENARIO_FIELD_SECRET_LIKE'],
      ['api_key', 'SCENARIO_FIELD_SECRET_LIKE'],
      ['delete_flag', 'SCENARIO_FIELD_DANGEROUS_WORD'],
      ['kept', 'SCENARIO_FIELD_NOT_ALLOWED'],
      ['pin', 'SCENARIO_FIELD_TYPE_NOT_SENDABLE'],
    ]);
    expect(form.rules).toEqual({
      minLimit: 1,
      maxCreatesPerRun: 1,
      maxCumulativeCreates: 20,
      minTtlDays: 1,
      maxTtlDays: 30,
      sideEffects: ['TEST_RECORDS_ONLY', 'NO_EXTERNAL_NOTIFICATION', 'NO_PAYMENT_OR_EXTERNAL_SERVICE', 'NOT_DESTRUCTIVE'],
    });
    expect(await valueOf('scenarioFormPageFn', 'GET', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: SEARCH.identityDigest }))
      .toMatchObject({ candidateRejection: 'SCENARIO_CANDIDATE_NOT_WRITABLE' });
    expect(await valueOf('scenarioFormPageFn', 'GET', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: `sha256:${'f'.repeat(64)}` }))
      .toMatchObject({ candidate: null, candidateRejection: 'SCENARIO_CANDIDATE_UNKNOWN' });

    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(CREATE.identityDigest)}`);
    const checkbox = (name: string): Locator => page.locator(`[data-testid="scenario-field"][data-field-name="${name}"] input[type="checkbox"]`);
    for (const name of ['name', 'email', 'plan']) {
      expect(await checkbox(name).isDisabled(), name).toBe(false);
    }
    for (const name of ['authenticity_token', 'api_key', 'delete_flag', 'kept', 'pin']) {
      expect(await checkbox(name).isDisabled(), name).toBe(true);
      expect(await page.locator(`[data-testid="scenario-field"][data-field-name="${name}"]`).getByTestId('scenario-field-blocked').count(), name).toBe(1);
    }
    await screenshot(page, 'e02-scenario-new');
  });

  it('rejects a draft by item on the server (fields, limits, TTL)', async () => {
    const rejected = await valueOf<{ ok: boolean; reason: string; errors: readonly { code: string; fieldName: string | null }[] }>('createScenarioFn', 'POST', {
      draft: draftOf({
        fieldNames: ['name', 'api_key', 'delete_flag', 'kept', 'pin'],
        limits: { maxCreatesPerRun: 2, maxCumulativeCreates: 21 },
        approvalTtlDays: 31,
      }),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('SCENARIO_DRAFT_INVALID');
    expect(rejected.errors.map(({ code, fieldName }) => [code, fieldName])).toEqual([
      ['SCENARIO_FIELD_SECRET_LIKE', 'api_key'],
      ['SCENARIO_FIELD_DANGEROUS_WORD', 'delete_flag'],
      ['SCENARIO_FIELD_NOT_ALLOWED', 'kept'],
      ['SCENARIO_FIELD_TYPE_NOT_SENDABLE', 'pin'],
      // T30f fix round 1・2（DEF-098）: CREATE の、既定の値が分からない見える欄（select）を送る欄にしていない。
      ['SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT', 'plan'],
      ['SCENARIO_LIMIT_ABOVE_DEFAULT', null],
      ['SCENARIO_LIMIT_ABOVE_DEFAULT', null],
      ['SCENARIO_TTL_ABOVE_DEFAULT', null],
    ]);
    expect(await valueOf('createScenarioFn', 'POST', { draft: draftOf({ limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 0 } }) }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_DRAFT_INVALID', errors: [{ code: 'SCENARIO_INPUT_INVALID', fieldName: null }] });
    const notWritable = await valueOf<{ reason: string; errors: readonly { code: string }[] }>('createScenarioFn', 'POST', {
      draft: draftOf({ candidateIdentityDigest: SEARCH.identityDigest }),
    });
    expect(notWritable.reason).toBe('SCENARIO_DRAFT_INVALID');
    expect(notWritable.errors[0]?.code).toBe('SCENARIO_CANDIDATE_NOT_WRITABLE');
    expect(await valueOf('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).toMatchObject({ scenarios: [] });
  });

  it('creates a scenario by keyboard from the candidate, and does not approve it while a side effect is unconfirmed', async () => {
    const discovery = await openPage(`/discovery/${WRITE_PROFILE_ID}`);
    await tabTo(discovery, discovery.locator(`[data-testid="discovery-candidate"][data-digest="${CREATE.identityDigest}"]`).getByTestId('candidate-create-scenario'));
    await discovery.keyboard.press('Enter');
    await discovery.getByTestId('scenario-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await discovery.getByTestId('scenario-target').getAttribute('data-digest')).toBe(CREATE.identityDigest);
    for (const target of [
      discovery.locator('[data-testid="scenario-field"][data-field-name="name"] input[type="checkbox"]'),
      discovery.locator('[data-testid="scenario-field"][data-field-name="email"] input[type="checkbox"]'),
      // T30f fix round 1・2（DEF-098）: CREATE は、既定の値が分からない見える欄（select の plan）も送る欄にする。
      discovery.locator('[data-testid="scenario-field"][data-field-name="plan"] input[type="checkbox"]'),
      discovery.locator('input[data-side-effect="TEST_RECORDS_ONLY"]'),
      discovery.locator('input[data-side-effect="NO_EXTERNAL_NOTIFICATION"]'),
      discovery.locator('input[data-side-effect="NO_PAYMENT_OR_EXTERNAL_SERVICE"]'),
    ]) {
      await tabTo(discovery, target);
      await discovery.keyboard.press('Space');
    }
    await screenshot(discovery, 'e03-scenario-new-filled');
    await tabTo(discovery, discovery.getByTestId('scenario-save'));
    await discovery.keyboard.press('Enter');
    await discovery.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE_ID}/[a-z0-9-]+\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    state.scenarioId = new URL(discovery.url()).pathname.split('/').at(-1) ?? '';
    await discovery.getByTestId('scenario-state').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await discovery.getByTestId('scenario-state').getAttribute('data-state')).toBe('DRAFT');
    expect(await discovery.getByTestId('scenario-unconfirmed').count()).toBe(1);
    expect(await discovery.getByTestId('scenario-approve').count()).toBe(0);
    expect(await discovery.getByTestId('scenario-input-rules').textContent()).toBe(text.inputRulesMissing);
    await screenshot(discovery, 'e04-scenario-detail-draft');

    const detail = await detailOf(state.scenarioId);
    expect(detail.scenario).toMatchObject({ revision: 1, state: 'DRAFT', fieldNames: ['email', 'name', 'plan'] });
    expect(detail.unconfirmedSideEffects).toEqual(['NOT_DESTRUCTIVE']);
    expect(detail.status).toMatchObject({ displayState: 'DRAFT', reasons: [] });
    // 画面を通さずに承認を送っても、副作用の未確認で拒む。
    expect(await valueOf('approveScenarioFn', 'POST', {
      scenarioId: state.scenarioId, expectedRevision: 1, expectedApprovalDigest: detail.status?.approvalDigest,
    })).toMatchObject({ ok: false, reason: 'SCENARIO_SIDE_EFFECTS_UNCONFIRMED' });
    expect((await detailOf(state.scenarioId)).history).toEqual([]);

    const list = await openPage(`/scenarios/${WRITE_PROFILE_ID}`);
    const row = list.locator(`[data-testid="scenario-row"][data-scenario-id="${state.scenarioId}"]`);
    expect(await row.getAttribute('data-kind')).toBe('CREATE');
    expect(await row.getByTestId('scenario-state').getAttribute('data-state')).toBe('DRAFT');
    expect(await row.getByTestId('scenario-limits-used').textContent()).toBe(text.limitsValue('1件', '0件', '20件'));
    await screenshot(list, 'e05-scenario-list-draft');
  });

  it('shows the revision conflict when the scenario changed after the edit screen opened, and saves the change after a reload', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}/edit`);
    await page.getByTestId('scenario-form').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await valueOf('updateScenarioFn', 'POST', {
      scenarioId: state.scenarioId, expectedRevision: 1, draft: changeOf({ fieldNames: ['email', 'name', 'plan'], sideEffectConfirmations: { ...confirmations(true), NOT_DESTRUCTIVE: false } }),
    })).toMatchObject({ ok: true, revision: 2 });
    await tabTo(page, page.locator('input[data-side-effect="NOT_DESTRUCTIVE"]'));
    await page.keyboard.press('Space');
    await tabTo(page, page.getByTestId('scenario-save'));
    await page.keyboard.press('Enter');
    await page.getByTestId('scenario-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-rejection').getAttribute('data-reason')).toBe('SCENARIO_REVISION_CONFLICT');
    await screenshot(page, 'e06-scenario-edit-conflict');

    const reloaded = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}/edit`);
    await tabTo(reloaded, reloaded.locator('input[data-side-effect="NOT_DESTRUCTIVE"]'));
    await reloaded.keyboard.press('Space');
    await tabTo(reloaded, reloaded.getByTestId('scenario-save'));
    await reloaded.keyboard.press('Enter');
    await reloaded.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    const detail = await detailOf(state.scenarioId);
    expect(detail.scenario.revision).toBe(3);
    expect(detail.unconfirmedSideEffects).toEqual([]);
    expect(detail.revisions.map(({ revision }) => revision)).toEqual([1, 2, 3]);
  });

  it('approves only after the confirmation dialog: the dialog opens on the cancel button, and Enter or Escape does not approve', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`);
    const approve = page.getByTestId('scenario-approve');
    await tabTo(page, approve);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await focusedText(page)).toBe(text.approveDialog.cancel);
    expect(await dialog.getByTestId('scenario-approve-details').textContent()).toContain(text.noApproval);
    await screenshot(page, 'e07-scenario-approve-dialog');
    await page.keyboard.press('Enter');
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    await approve.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect((await detailOf(state.scenarioId)).history).toEqual([]);

    await approve.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    expect(await focusedText(page)).toBe(text.approveDialog.confirm);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}\\?notice=approved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId('scenario-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('APPROVED');
    expect(await page.getByTestId('scenario-differences').getByTestId('scenario-diff-empty').count()).toBe(1);
    await screenshot(page, 'e08-scenario-approved');
    const detail = await detailOf(state.scenarioId);
    expect(detail.scenario.state).toBe('APPROVED');
    expect(detail.status?.displayState).toBe('APPROVED');
    expect(detail.status?.expiresAt).not.toBeNull();
    expect(detail.history).toEqual([expect.objectContaining({ kind: 'APPROVAL', scenarioRevision: 3 })]);
    expect(detail.lastApprovalRevision).toBe(3);
    expect(detail.differences).toEqual([]);
  });

  it('rejects an approval from an old screen (another revision, or the same revision with an old digest), and shows the differences', async () => {
    const before = await detailOf(state.scenarioId);
    const oldDigest = before.status?.approvalDigest;
    expect(await valueOf('updateScenarioFn', 'POST', {
      scenarioId: state.scenarioId, expectedRevision: 3, draft: changeOf({ fieldNames: ['name', 'plan'], limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 5 } }),
    })).toMatchObject({ ok: true, revision: 4 });
    expect(await valueOf('approveScenarioFn', 'POST', { scenarioId: state.scenarioId, expectedRevision: 3, expectedApprovalDigest: oldDigest }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_REVISION_CONFLICT' });
    expect(await valueOf('approveScenarioFn', 'POST', { scenarioId: state.scenarioId, expectedRevision: 4, expectedApprovalDigest: oldDigest }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_APPROVAL_DIGEST_MISMATCH' });

    const changed = await detailOf(state.scenarioId);
    expect(changed.status).toMatchObject({ displayState: 'NEEDS_REAPPROVAL', reasons: ['SCENARIO_REVISION_CHANGED'] });
    expect(changed.differences).toEqual([
      { item: 'scenarioRevision', previous: 3, current: 4 },
      { item: 'fieldNames', previous: ['email', 'name', 'plan'], current: ['name', 'plan'] },
      { item: 'limits', previous: [1, 20], current: [1, 5] },
    ]);

    // 画面を開いた後に、プロファイルが変わった（承認の digest が変わる）。画面の古い digest の承認は拒まれ、理由を出す。
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`);
    const diff = page.getByTestId('scenario-differences');
    expect(await diff.locator('[data-testid="scenario-diff-item"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item'))))
      .toEqual(['scenarioRevision', 'fieldNames', 'limits']);
    expect(await diff.locator('[data-item="limits"] th').textContent()).toBe(APPROVAL_DIGEST_ITEM_CATALOG.limits.label);
    expect(await diff.locator('[data-item="limits"] code').textContent()).toBe(text.diffValue('[1,20]', '[1,5]'));
    await screenshot(page, 'e09-scenario-needs-reapproval');
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_APPROVED_WRITE', FIRST_REVISION + 1), expectedRevision: FIRST_REVISION,
    })).toMatchObject({ ok: true });
    await tabTo(page, page.getByTestId('scenario-approve'));
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByRole('dialog').getByTestId('scenario-diff-item').count()).toBe(3);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.getByTestId('scenario-action-rejection').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-action-rejection').getAttribute('data-reason')).toBe('SCENARIO_APPROVAL_DIGEST_MISMATCH');
    expect(await page.getByTestId('scenario-action-rejection').textContent())
      .toContain(SCENARIO_REQUEST_REJECTION_DESCRIPTIONS.SCENARIO_APPROVAL_DIGEST_MISMATCH.description);
    await screenshot(page, 'e10-scenario-stale-approval');
    const stale = await detailOf(state.scenarioId);
    expect(stale.history).toHaveLength(1);
    expect(stale.status?.reasons).toEqual(['SCENARIO_REVISION_CHANGED', 'PROFILE_REVISION_CHANGED']);
    expect(stale.differences?.map(({ item }) => item)).toEqual(['scenarioRevision', 'profileRevision', 'fieldNames', 'limits']);
  });

  it('approves the current screen again, and revokes only after the confirmation dialog', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`);
    await tabTo(page, page.getByTestId('scenario-approve'));
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForURL(/notice=approved$/u, { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId('scenario-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('APPROVED');

    const revoke = page.getByTestId('scenario-revoke');
    await tabTo(page, revoke);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: text.revokeDialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await focusedText(page)).toBe(text.revokeDialog.cancel);
    expect(await dialog.textContent()).toContain(text.revokeDialog.body);
    await screenshot(page, 'e11-scenario-revoke-dialog');
    await page.keyboard.press('Enter');
    await expect.poll(() => dialog.isVisible(), { timeout: UI_TIMEOUT_MS }).toBe(false);
    expect((await detailOf(state.scenarioId)).scenario.state).toBe('APPROVED');
    await revoke.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForURL(/notice=revoked$/u, { timeout: UI_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId('scenario-state').getAttribute('data-state'), { timeout: UI_TIMEOUT_MS }).toBe('REVOKED');
    expect(await page.getByTestId('scenario-revoke').count()).toBe(0);
    await screenshot(page, 'e12-scenario-revoked');

    const detail = await detailOf(state.scenarioId);
    expect(detail.history.map(({ kind }) => kind)).toEqual(['APPROVAL', 'APPROVAL', 'REVOCATION']);
    expect(detail.status).toMatchObject({ displayState: 'REVOKED', reasons: ['REVOKED'] });
    expect(await valueOf('revokeScenarioFn', 'POST', { scenarioId: state.scenarioId, expectedRevision: detail.scenario.revision }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_NOT_APPROVED' });
    const list = await openPage(`/scenarios/${WRITE_PROFILE_ID}`);
    expect(await list.locator(`[data-testid="scenario-row"][data-scenario-id="${state.scenarioId}"]`).getByTestId('scenario-state').getAttribute('data-state'))
      .toBe('REVOKED');
    await screenshot(list, 'e13-scenario-list-revoked');
  });

  it('has no button that runs a write, and shows no cookie, screen token or option value in the screens and the responses', async () => {
    const allowedButtons = new Set<string>([
      text.approve, text.revoke, text.save, text.reload, text.approveDialog.confirm, text.approveDialog.cancel, text.revokeDialog.confirm,
      text.revokeDialog.cancel,
    ]);
    const paths = [
      `/scenarios/${WRITE_PROFILE_ID}`,
      `/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(CREATE.identityDigest)}`,
      `/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}`,
      `/scenarios/${WRITE_PROFILE_ID}/${state.scenarioId}/edit`,
    ];
    const texts: string[] = [];
    for (const path of paths) {
      const page = await openPage(path);
      const buttons = await page.getByRole('button', { includeHidden: true }).evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
      expect(buttons.filter((label) => !allowedButtons.has(label)), path).toEqual([]);
      texts.push(await page.content());
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).toBe(STATUS.OK);
      texts.push(response.body);
    }
    for (const [name, data] of [
      ['scenarioListPageFn', { profileId: WRITE_PROFILE_ID }],
      ['scenarioFormPageFn', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: CREATE.identityDigest }],
      ['scenarioDetailPageFn', { scenarioId: state.scenarioId }],
    ] as const) {
      texts.push((await call(name, 'GET', data)).response.body);
    }
    const cookieValue = cookie.split('=').slice(1).join('=');
    const token = started().tokenUrl.searchParams.values().next().value ?? '';
    const markers = [cookieValue, token, OPTION_MARKER].filter((marker) => marker.length > 0);
    expect(markers).toHaveLength(3);
    expect(texts.flatMap((body, index) => markers.filter((marker) => body.includes(marker)).map(() => index))).toEqual([]);
    // 対照: 選択肢の値の目印は、候補の画面（発見の結果。設計どおり）には出る。
    expect((await rawRequest(started().port, `/discovery/${WRITE_PROFILE_ID}`, { headers: { cookie } })).body).toContain(OPTION_MARKER);
  });

  it('keeps the server parts of the scenarios out of the browser bundle', () => {
    const clientDirectory = `${rootOf().root}/apps/local-ui/dist/client`;
    const files = readdirSync(clientDirectory, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.js'));
    const bundle = files.map((path) => readFileSync(`${clientDirectory}/${path}`, 'utf8')).join('\n');
    for (const marker of ['scenario_revisions', 'approval_receipts', 'execution_grants', 'write_reservations', 'FROM scenarios', 'beaksight-approval/1']) {
      expect(bundle.includes(marker), marker).toBe(false);
    }
    expect(bundle.match(/["'`]node:[a-z/_]+["'`]/gu) ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T30g: 書き込みの画面（検証の指定、開始、結果）
// ---------------------------------------------------------------------------------------------------------------

const writeText = LOCAL_UI_WRITE_TEXT;
/** 書き込みの開始の結果（画面のサーバが返す形の、確かめに使う所）。 */
type WriteStartResult = { readonly ok: boolean; readonly jobId?: string; readonly stage?: string; readonly reason?: string;
  readonly invalidityReasons?: readonly string[] };
/** 開始の画面の値（確かめに使う所）。 */
interface WriteStartPage {
  readonly eligible: boolean;
  readonly startable: boolean;
  readonly approved: boolean | null;
  readonly invalidityReasons: readonly string[];
  readonly missingVerification: readonly string[];
  readonly nextWriteAllowedAt: string | null;
  readonly remainingInWindow: number;
  readonly used: number;
  readonly remaining: number;
  readonly notificationConfirmed: boolean;
  readonly evidencePresent: boolean;
  readonly startBlocker: string | null;
}
/** 書き込みの scenario（検証の指定と承認つき）。 */
const writeState: { scenarioId: string; readCheckId: string; profileRevision: number; jobId: string } = {
  scenarioId: '', readCheckId: '', profileRevision: FIRST_REVISION, jobId: '',
};
/** 記録だけを入れる結果の時刻の間隔（連続の上限の間隔より長い。ms）。 */
const SEEDED_WRITE_STEP_MS = 10 * 60_000;

/** 画面のサーバが開いている管理データに、別の接続で（テストだけの操作として）読み書きする。 */
const withControlData = <T>(use: (database: ControlDatabase) => T): T => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    return use(database);
  } finally {
    closeControlDatabase(database);
  }
};

const writePageOf = (scenarioId: string): Promise<WriteStartPage> => valueOf<WriteStartPage>('writeStartPageFn', 'GET', { scenarioId });

/** 一時の root の監査のワーカーの入口を、書き込みの偽のワーカーに替える（確かめ直しの後、送信の報告なしに落ちる）。 */
const installFakeWrite = (outputDirectory: string): void => {
  const directory = `${rootOf().root}/fake-workers/write-${outputDirectory}`;
  mkdirSync(directory, { recursive: true });
  const worker = writeFakeWorker(directory, 'write', {
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
    write: { outputDirectory: `${rootOf().root}/${outputDirectory}`, recheck: 1, onReject: 'report', submission: null, actionRunText: null, end: 'crash' },
  });
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
};

describe('T30g: the write screens (verification spec, start, results)', () => {
  it('makes a CREATE scenario and shows the missing verification items as the reason it cannot run', async () => {
    // 前の場面でプロファイルの改訂が上がることがあるので、今の改訂を読み、認証の設定をその改訂で保存し直す（開始の前の確かめが通るように）。
    const profile = await valueOf<{ profile: { revision: number } } | null>('getProfileFn', 'GET', { profileId: WRITE_PROFILE_ID });
    writeState.profileRevision = profile?.profile.revision ?? FIRST_REVISION;
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...authSetup(WRITE_PROFILE_ID), profileRevision: writeState.profileRevision } }))
      .toMatchObject({ ok: true });
    // 最後の発見のジョブ（偽のワーカー。登録と検索の候補）を、この場面でも今の改訂で行う（候補の索引と `discovery.json`）。
    installFakeDiscovery('t28e-write-output');
    const discovery = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', {
      profileId: WRITE_PROFILE_ID, expectedRevision: writeState.profileRevision,
    });
    expect(discovery.ok).toBe(true);
    expect(await waitForEnd(discovery.jobId)).toMatchObject({ state: 'FINISHED' });
    const readCheck = await valueOf<{ ok: boolean; readCheckId: string }>('createReadCheckFn', 'POST', {
      profileId: WRITE_PROFILE_ID,
      definition: { targetIdentityDigest: SEARCH.identityDigest, parameters: { q: 't30g' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    });
    expect(readCheck.ok).toBe(true);
    writeState.readCheckId = readCheck.readCheckId;
    const created = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
      draft: draftOf({ fieldNames: ['email', 'name', 'plan'] }),
    });
    expect(created.ok).toBe(true);
    writeState.scenarioId = created.scenarioId;

    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}`);
    const missing = page.getByTestId('scenario-verification-missing');
    await missing.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await missing.getAttribute('data-reason')).toBe('VERIFICATION_SPEC_MISSING');
    expect(await missing.locator('li').evaluateAll((items) => items.map((item) => item.getAttribute('data-item'))))
      .toEqual(['successCondition', 'inputErrorCondition', 'recordId', 'readVerification']);
    expect(await page.getByTestId('scenario-open-write').count()).toBe(1);
    expect(await page.getByTestId('write-history-empty').textContent()).toBe(writeText.noWrites);
    await screenshot(page, 'g01-scenario-verification-missing');
  });

  it('saves the verification spec from the edit screen, and shows it on the detail screen', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}/edit`);
    await page.getByTestId('scenario-form').waitFor({ timeout: UI_TIMEOUT_MS });
    const success = page.getByTestId('scenario-verification-successCondition');
    await success.getByLabel(writeText.conditionPathPrefix, { exact: true }).fill('/admin/members/');
    await success.getByLabel(writeText.conditionSelector, { exact: true }).fill('.registered');
    const inputError = page.getByTestId('scenario-verification-inputErrorCondition');
    await inputError.getByLabel(writeText.conditionPathPrefix, { exact: true }).fill('/admin/members/new');
    await inputError.getByLabel(writeText.conditionSelector, { exact: true }).fill('.error');
    const recordId = page.getByTestId('scenario-verification-recordId');
    await recordId.getByLabel(writeText.recordIdSource, { exact: true }).selectOption('URL_PATH_PATTERN');
    await recordId.getByLabel(writeText.recordIdValue, { exact: true }).fill('/admin/members/{id}');
    const read = page.getByTestId('scenario-verification-readVerification');
    await read.getByLabel(writeText.readVerificationCheck, { exact: true }).selectOption(writeState.readCheckId);
    await read.locator('[data-testid="scenario-verification-binding"][data-parameter-name="q"] select').selectOption('name');
    await read.getByTestId('scenario-verification-add-expectation').click();
    await read.locator('[data-testid="scenario-verification-expectation"][data-index="0"]').getByLabel(writeText.expectationCount, { exact: true }).fill('1');
    for (const item of await page.locator('input[data-side-effect]').all()) {
      await item.check();
    }
    await screenshot(page, 'g02-scenario-verification-filled');
    await page.getByTestId('scenario-save').click();
    await page.waitForURL(/notice=saved$/u, { timeout: UI_TIMEOUT_MS });
    await page.getByTestId('scenario-verification-values').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-verification-missing').count()).toBe(0);
    expect(await page.getByTestId('scenario-verification-values').locator('dd').evaluateAll((items) => items.map((item) => item.getAttribute('data-set'))))
      .toEqual(['true', 'true', 'true', 'true']);
    const detail = await valueOf<{ scenario: { revision: number; verification: Record<string, unknown> }; missingVerification: readonly string[] }>(
      'scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId },
    );
    expect(detail.missingVerification).toEqual([]);
    expect(detail.scenario.verification).toEqual({
      successCondition: { pathPrefix: '/admin/members/', selector: '.registered' },
      inputErrorCondition: { pathPrefix: '/admin/members/new', selector: '.error' },
      recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' },
      readVerification: { readCheckId: writeState.readCheckId, revision: 1, bindings: [{ parameterName: 'q', fieldName: 'name' }],
        expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    });
    await screenshot(page, 'g03-scenario-verification-saved');
  });

  it('shows what to confirm before the start, and the server rejects the start of an unapproved scenario without issuing a grant', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}/write`);
    const start = page.getByTestId('write-start');
    await start.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getAttribute('data-startable')).toBe('false');
    expect(await page.getByTestId('write-start-open').count()).toBe(0);
    expect(await page.getByTestId('write-start-approval').getAttribute('data-approved')).toBe('false');
    expect(await page.getByTestId('write-start-notification').getAttribute('data-confirmed')).toBe('true');
    expect(await page.getByTestId('write-start-evidence').getAttribute('data-present')).toBe('true');
    expect(await page.getByTestId('write-start-next').getAttribute('data-next')).toBe('');
    expect(await page.getByTestId('write-start-fields').textContent()).toContain('name');
    await screenshot(page, 'g04-write-start-unapproved');
    const view = await writePageOf(writeState.scenarioId);
    expect(view).toMatchObject({ eligible: true, startable: false, approved: false, missingVerification: [], used: 0, remaining: 20, remainingInWindow: 5 });
    const revision = (await valueOf<{ scenario: { revision: number } }>('scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId })).scenario.revision;
    const result = await valueOf<WriteStartResult>('startWriteCreateFn', 'POST', { scenarioId: writeState.scenarioId, expectedRevision: revision });
    expect(result).toMatchObject({ ok: false, stage: 'GRANT', reason: 'GRANT_APPROVAL_INVALID' });
    expect(result.invalidityReasons).toContain('NOT_APPROVED');
    withControlData((database) => expect(readWriteReservations(database, writeState.scenarioId)).toEqual([]));
  });

  it('keeps the CSRF protection for the start: a cross-site or other-origin POST is 403, and issues nothing', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get('startWriteCreateFn') ?? ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body: encodeServerFunctionPayload({ scenarioId: writeState.scenarioId, expectedRevision: 1 }),
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    // T30g fix round 1: 開始の要求の形は、専用のスキーマ（`ui-write-start`）で確かめる。合わない入力は 400 で、何も発行しない。
    for (const data of [
      { scenarioId: writeState.scenarioId, expectedRevision: 1, extra: true },
      { scenarioId: writeState.scenarioId, expectedRevision: 0 },
      { scenarioId: '../x', expectedRevision: 1 },
    ]) {
      expect((await call('startWriteCreateFn', 'POST', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    withControlData((database) => expect(readWriteReservations(database, writeState.scenarioId)).toEqual([]));
  });

  it('starts the write from the screen after the dialog, and shows the UNKNOWN result clearly (no reservation stays RESERVED)', async () => {
    // テストだけの準備: 入力の規則（送る欄すべての規則）を画面のサーバの口で付け、画面の承認の Server Function で承認する。
    const detail = await valueOf<{ scenario: { revision: number } }>('scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId });
    const saved = await valueOf<{ ok: boolean }>('saveDataRulesFn', 'POST', {
      scenarioId: writeState.scenarioId,
      expectedScenarioRevision: detail.scenario.revision,
      expectedRuleSetRevision: null,
      fieldRules: [
        { fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['t30g-name'] },
        { fieldName: 'email', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['t30g@example.invalid'] },
        { fieldName: 'plan', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [OPTION_MARKER] },
      ],
      relations: [],
      uniqueKeyFieldNames: [],
    });
    expect(saved.ok).toBe(true);
    const approvable = await valueOf<{ scenario: { revision: number }; status: { approvalDigest: string } | null }>(
      'scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId },
    );
    expect(await valueOf('approveScenarioFn', 'POST', {
      scenarioId: writeState.scenarioId, expectedRevision: approvable.scenario.revision, expectedApprovalDigest: approvable.status?.approvalDigest,
    })).toMatchObject({ ok: true });
    installFakeWrite('t28e-write-output');

    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}/write`);
    await page.getByTestId('write-start-open').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('write-start').getAttribute('data-startable')).toBe('true');
    await screenshot(page, 'g05-write-start-ready');
    await page.getByTestId('write-start-open').click();
    const dialog = page.getByRole('dialog', { name: writeText.startDialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await focusedText(page)).toBe(writeText.startDialog.cancel);
    await dialog.getByRole('button', { name: writeText.startDialog.confirm, exact: true }).click();
    await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
    writeState.jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    expect(await waitForEnd(writeState.jobId)).toMatchObject({ state: 'INTERRUPTED' });

    const job = await openPage(`/jobs/${writeState.jobId}`);
    const unknown = job.getByTestId('write-result-unknown');
    await unknown.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await unknown.textContent()).toBe(writeText.unknownBody);
    expect(await job.getByTestId('write-result').getAttribute('data-result')).toBe('UNKNOWN');
    expect(await job.getByRole('alert').filter({ hasText: writeText.unknownHeading }).count()).toBe(1);
    await screenshot(job, 'g06-write-result-unknown');
    withControlData((database) => {
      const reservations = readWriteReservations(database, writeState.scenarioId);
      expect(reservations.map(({ state: reservationState }) => reservationState)).toEqual(['UNKNOWN']);
    });

    // 連続の上限: 次に実行できる時刻を出し、今の開始はサーバが拒む（許可を出さないので、予約は増えない）。
    const view = await writePageOf(writeState.scenarioId);
    expect(view.nextWriteAllowedAt).not.toBeNull();
    expect(view).toMatchObject({ startable: false, used: 1, remainingInWindow: 4 });
    const revision = (await valueOf<{ scenario: { revision: number } }>('scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId })).scenario.revision;
    const again = await valueOf<WriteStartResult>('startWriteCreateFn', 'POST', { scenarioId: writeState.scenarioId, expectedRevision: revision });
    expect(again).toMatchObject({ ok: false, stage: 'GRANT', reason: 'GRANT_WRITE_INTERVAL_NOT_ELAPSED' });
    const rejected = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}/write`);
    await rejected.getByTestId('write-start-next').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejected.getByTestId('write-start-next').getAttribute('data-next')).not.toBe('');
    expect(EXECUTION_GRANT_REJECTION_DESCRIPTIONS.GRANT_WRITE_INTERVAL_NOT_ELAPSED.description.length).toBeGreaterThan(0);
    withControlData((database) => expect(readWriteReservations(database, writeState.scenarioId).map(({ state: reservationState }) => reservationState))
      .toEqual(['UNKNOWN']));
  });

  it('shows the VERIFIED, PARTIAL and BLOCKED results recorded in the control data in the write history', async () => {
    // テストだけの操作: 最後の承認が縛った事実で、許可の発行・消費・送る前の記録・締めを、連続の上限の間隔より後の時刻で書く。
    withControlData((database) => {
      const scenario = readScenario(database, writeState.scenarioId);
      const approval = readApprovalReceipts(database, writeState.scenarioId).findLast((receipt) => receipt.kind === 'APPROVAL');
      if (scenario === null || approval?.kind !== 'APPROVAL') {
        throw new Error('the approved scenario is missing');
      }
      const external = { authSetupDigest: approval.bound.authSetupDigest, targetConfigDigest: approval.bound.targetConfigDigest };
      const reports = [
        { submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: 'rec-1', readVerification: 'MATCHED' },
        { submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: null, readVerification: null },
        { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null },
      ] as const;
      reports.forEach((report, index) => {
        const at = formatCompactUtcTimestamp(new Date(Date.now() + (index + 1) * SEEDED_WRITE_STEP_MS), 't30g test-only write');
        seedWriteResultForTest(database, {
          profileId: WRITE_PROFILE_ID,
          scenarioId: writeState.scenarioId,
          scenarioRevision: scenario.revision,
          grantId: `t30g-grant-${String(index)}`,
          jobId: `t30g-job-${String(index)}`,
          external,
          at,
          submittedValues: { name: `t30g-${String(index)}` },
          report: { ...report, submittedAt: report.submission === 'SENT' ? at : null },
        });
      });
    });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}`);
    await page.getByTestId('write-history').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('write-history-entry').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-result'))))
      .toEqual(['BLOCKED', 'PARTIAL', 'VERIFIED', 'UNKNOWN']);
    await screenshot(page, 'g07-write-history');
    withControlData((database) => expect(readWriteReservations(database, writeState.scenarioId).filter(({ state: reservationState }) => reservationState === 'RESERVED'))
      .toEqual([]));
  });

  it('does not offer the write start to a profile that is not in the write mode, and the server rejects the start', async () => {
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_AUTH_PASSIVE', writeState.profileRevision + 1),
      expectedRevision: writeState.profileRevision,
    })).toMatchObject({ ok: true });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${writeState.scenarioId}`);
    await page.getByTestId('scenario-status').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-open-write').count()).toBe(0);
    const view = await writePageOf(writeState.scenarioId);
    expect(view).toMatchObject({ eligible: false, startable: false, startBlocker: 'MODE_NOT_EXECUTABLE' });
    const revision = (await valueOf<{ scenario: { revision: number } }>('scenarioDetailPageFn', 'GET', { scenarioId: writeState.scenarioId })).scenario.revision;
    expect(await valueOf<WriteStartResult>('startWriteCreateFn', 'POST', { scenarioId: writeState.scenarioId, expectedRevision: revision }))
      .toMatchObject({ ok: false, stage: 'START', reason: 'MODE_NOT_EXECUTABLE' });
    withControlData((database) => expect(readWriteReservations(database, writeState.scenarioId).filter(({ state: reservationState }) => reservationState === 'RESERVED'))
      .toEqual([]));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T31h-1: UPDATE の指定の入力と、更新の予定のレコードの表示
// ---------------------------------------------------------------------------------------------------------------

/** UPDATE の候補のフォームの画面の値（確かめに使うもの）。 */
interface UpdateFormPage {
  readonly eligible: boolean;
  readonly editable: boolean;
  readonly candidateRejection: string | null;
  readonly candidate: {
    readonly scenarioKind: string | null;
    readonly fields: readonly { readonly name: string; readonly rejection: string | null; readonly roleRequired: boolean }[];
  } | null;
  readonly update: {
    readonly ledgerOptions: readonly { readonly scenarioId: string; readonly pagePath: string; readonly unboundTemplates: readonly number[] }[];
    readonly templateOptions: readonly { readonly formPathTemplate: string; readonly actionPathTemplate: string; readonly recordId: string }[];
    readonly placeholder: string;
  } | null;
}

/** UPDATE のシナリオの詳細の値（確かめに使うもの）。 */
interface UpdateDetail {
  readonly scenario: { readonly kind: string; readonly fieldNames: readonly string[]; readonly update: Record<string, unknown> | null };
  readonly updateLedger: { readonly scenarioId: string; readonly pagePath: string | null } | null;
  readonly plannedUpdateTarget: string | null;
}

/** 下書きの誤り（確かめに使うもの）。 */
interface DraftRejection {
  readonly ok: boolean;
  readonly reason: string;
  readonly errors: readonly { readonly code: string; readonly fieldName: string | null }[];
}

/** UPDATE の候補の型（ID の区切りを印にした形）。 */
const UPDATE_FORM_TEMPLATE = `/admin/members/${RECORD_ID_PLACEHOLDER}/edit`;
const UPDATE_ACTION_TEMPLATE = `/admin/members/${RECORD_ID_PLACEHOLDER}`;
/** 役割を決める欄（候補の欄の順）と、保つ欄（保存の形は UTF-16 のコード単位の順）。 */
const UPDATE_ROLE_FIELDS = Object.freeze(['name', 'email', 'phone', 'status', 'note']);
const UPDATE_KEPT_FIELDS = Object.freeze(['email', 'note', 'phone', 'status']);

/** UPDATE の下書き（作成の形。既定は、`name` を変え、ほかを保ち、ID の区切りの型）。 */
const updateScenarioDraftOf = (
  ledgerId: string,
  overrides: Record<string, unknown> = {},
  update: Record<string, unknown> = {},
): Record<string, unknown> => draftOf({
  candidateIdentityDigest: UPDATE.identityDigest,
  fieldNames: ['name'],
  update: {
    targetCreateScenarioId: ledgerId,
    formPathTemplate: UPDATE_FORM_TEMPLATE,
    actionPathTemplate: UPDATE_ACTION_TEMPLATE,
    keepFieldNames: [...UPDATE_KEPT_FIELDS],
    ...update,
  },
  ...overrides,
});

const updateFormPageOf = (candidate: DiscoveryCandidate): Promise<UpdateFormPage> =>
  valueOf<UpdateFormPage>('scenarioFormPageFn', 'GET', { profileId: WRITE_PROFILE_ID, candidateIdentityDigest: candidate.identityDigest });

/** 役割の欄の、変える・保つのラジオボタン。 */
const roleRadioOf = (page: Page, name: string, role: 'CHANGE' | 'KEEP'): Locator =>
  page.locator(`[data-testid="scenario-update-role"][data-field-name="${name}"] input[type="radio"][value="${role}"]`);

/** 選択の要素で、キーボードだけで値を選ぶ（Tab でフォーカスし、先頭から矢印で動かす）。 */
const chooseByKeyboard = async (page: Page, select: Locator, value: string): Promise<void> => {
  await tabTo(page, select);
  await page.keyboard.press('Home');
  const count = await select.locator('option').count();
  for (let index = 0; index < count && await select.inputValue() !== value; index += 1) {
    await page.keyboard.press('ArrowDown');
  }
  expect(await select.inputValue()).toBe(value);
};

/** T31h-1 の場面をまたぐ値。 */
const updateState: { profileRevision: number; scenarioId: string } = { profileRevision: 0, scenarioId: '' };

describe('T31h-1: the UPDATE spec on the scenario screens', () => {
  it('offers no UPDATE form to a profile that is not in the write mode, and the server rejects the UPDATE draft', async () => {
    // 前の場面（T30g）で、プロファイルは書き込みのモードでなくなっている。
    const form = await updateFormPageOf(UPDATE);
    expect(form).toMatchObject({ eligible: false, editable: false });
    expect(await valueOf('createScenarioFn', 'POST', { draft: updateScenarioDraftOf(writeState.scenarioId) }))
      .toMatchObject({ ok: false, reason: 'SCENARIO_MODE_NOT_WRITE' });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE.identityDigest)}`);
    await page.getByTestId('scenario-profile').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-form').count()).toBe(0);
    expect(await page.getByTestId('scenario-update').count()).toBe(0);

    // 書き込みのモードに戻し、認証の設定を今の改訂で保存し直し、発見を今の改訂で行う（候補の索引と `discovery.json`）。
    const passiveRevision = writeState.profileRevision + 1;
    updateState.profileRevision = passiveRevision + 1;
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_APPROVED_WRITE', updateState.profileRevision),
      expectedRevision: passiveRevision,
    })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...authSetup(WRITE_PROFILE_ID), profileRevision: updateState.profileRevision } }))
      .toMatchObject({ ok: true });
    installFakeDiscovery('t28e-write-output');
    const discovery = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', {
      profileId: WRITE_PROFILE_ID, expectedRevision: updateState.profileRevision,
    });
    expect(discovery.ok).toBe(true);
    expect(await waitForEnd(discovery.jobId)).toMatchObject({ state: 'FINISHED' });
  });

  it('tells the roles, the fields that cannot be changed and the template options of an UPDATE candidate from the owners', async () => {
    const form = await updateFormPageOf(UPDATE);
    expect(form).toMatchObject({ eligible: true, editable: true, candidateRejection: null });
    expect(form.candidate?.scenarioKind).toBe('UPDATE');
    expect(form.candidate?.fields.filter(({ roleRequired }) => roleRequired).map(({ name, rejection }) => [name, rejection])).toEqual([
      ['name', null],
      ['email', null],
      ['phone', null],
      ['status', 'SCENARIO_STATE_FIELD_NOT_CHANGEABLE'],
      ['note', null],
    ]);
    expect(form.candidate?.fields.filter(({ roleRequired }) => !roleRequired).map(({ name }) => name)).toEqual(['_method', 'lock_version', 'kept']);
    expect(form.update?.placeholder).toBe(RECORD_ID_PLACEHOLDER);
    expect(form.update?.templateOptions).toEqual([
      { formPathTemplate: `/${RECORD_ID_PLACEHOLDER}/members/1/edit`, actionPathTemplate: `/${RECORD_ID_PLACEHOLDER}/members/1`, recordId: 'admin' },
      { formPathTemplate: `/admin/${RECORD_ID_PLACEHOLDER}/1/edit`, actionPathTemplate: `/admin/${RECORD_ID_PLACEHOLDER}/1`, recordId: 'members' },
      { formPathTemplate: UPDATE_FORM_TEMPLATE, actionPathTemplate: UPDATE_ACTION_TEMPLATE, recordId: '1' },
    ]);
    // 台帳の選択肢は、同じプロファイルの登録（CREATE）のシナリオだけ。
    const ledgerIds = form.update?.ledgerOptions.map(({ scenarioId }) => scenarioId) ?? [];
    expect(ledgerIds).toEqual(expect.arrayContaining([state.scenarioId, writeState.scenarioId]));
    for (const scenarioId of ledgerIds) {
      expect((await valueOf<UpdateDetail>('scenarioDetailPageFn', 'GET', { scenarioId })).scenario.kind, scenarioId).toBe('CREATE');
    }
    // 登録の候補には、UPDATE の値がない。T31b の「選べない」（UPDATE の指定がない）は出ない。
    expect((await updateFormPageOf(CREATE)).update).toBeNull();
    // 秘密に見える名前の見える欄がある画面は、候補を作れない理由を出す。同じ区切りのない画面は、型の選択肢がない（手で入力する）。
    expect(await updateFormPageOf(UPDATE_SECRET)).toMatchObject({ candidateRejection: 'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD' });
    const noTemplate = await updateFormPageOf(UPDATE_NO_TEMPLATE);
    expect(noTemplate).toMatchObject({ candidateRejection: null });
    expect(noTemplate.update?.templateOptions).toEqual([]);

    const secret = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE_SECRET.identityDigest)}`);
    const rejected = secret.getByTestId('scenario-candidate-rejected');
    await rejected.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejected.getAttribute('data-reason')).toBe('SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD');
    expect(await secret.getByTestId('scenario-form').count()).toBe(0);
    await screenshot(secret, 'h01-update-secret-like-field');
  });

  // T31R-fix-1 の I-2: 型の組のうち、台帳の登録の ID の取り方（T30g の場面の登録のシナリオは `/admin/members/{id}`）に結び付かない組（`{id}` の前の
  // 区切りが `members` でない組）は選べず、選んだ組が結び付かなくなったら理由を出す。サーバも、結び付かない型の下書きを拒む。
  it('does not offer the template options not bound to the record id of the ledger, and the server rejects them (T31R-fix-1 I-2)', async () => {
    const form = await updateFormPageOf(UPDATE);
    const bound = form.update?.ledgerOptions.find(({ scenarioId }) => scenarioId === writeState.scenarioId);
    expect(bound?.unboundTemplates).toEqual([0, 1]);
    // T28e の場面の登録のシナリオは、登録の ID の取り方が未指定（確かめない）。
    expect(form.update?.ledgerOptions.find(({ scenarioId }) => scenarioId === state.scenarioId)?.unboundTemplates).toEqual([]);

    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE.identityDigest)}`);
    await page.getByTestId('scenario-update').waitFor({ timeout: UI_TIMEOUT_MS });
    const ledger = page.getByTestId('scenario-update-ledger');
    const template = page.getByTestId('scenario-update-template');
    await ledger.selectOption(state.scenarioId);
    await template.selectOption('0');
    expect(await page.getByTestId('scenario-update-template-unbound').count()).toBe(0);
    await ledger.selectOption(writeState.scenarioId);
    expect(await page.getByTestId('scenario-update-template-unbound').textContent())
      .toBe(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS.SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID.description);
    expect(await template.locator('option').evaluateAll((options) => options.map((option) => [option.getAttribute('value'), (option as HTMLOptionElement).disabled])))
      .toEqual([['0', true], ['1', true], ['2', false], ['manual', false]]);
    await screenshot(page, 'h01b-update-template-unbound');

    const rejected = await valueOf<DraftRejection>('createScenarioFn', 'POST', {
      draft: updateScenarioDraftOf(writeState.scenarioId, {}, {
        formPathTemplate: form.update?.templateOptions[0]?.formPathTemplate, actionPathTemplate: form.update?.templateOptions[0]?.actionPathTemplate,
      }),
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'SCENARIO_DRAFT_INVALID' });
    expect(rejected.errors.map(({ code }) => code)).toContain('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
  });

  it('makes an UPDATE scenario by keyboard: the ledger, a template from the candidate paths and the roles (kept by default)', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE.identityDigest)}`);
    await page.getByTestId('scenario-update').waitFor({ timeout: UI_TIMEOUT_MS });
    // 送る欄の選択（CREATE）は出ない。役割の既定は、すべて保つ（メールと電話も保つ）。
    expect(await page.getByTestId('scenario-fields').count()).toBe(0);
    const roles = page.getByTestId('scenario-update-role');
    expect(await roles.evaluateAll((items) => items.map((item) => [item.getAttribute('data-field-name'), item.getAttribute('data-role')])))
      .toEqual(UPDATE_ROLE_FIELDS.map((name) => [name, 'KEEP']));
    for (const name of ['email', 'phone']) {
      expect(await page.locator(`[data-testid="scenario-update-role"][data-field-name="${name}"]`).getByTestId('scenario-update-contact-hint').count(), name)
        .toBe(1);
    }
    expect(await page.locator('[data-testid="scenario-update-role"][data-field-name="name"]').getByTestId('scenario-update-contact-hint').count()).toBe(0);
    // 状態の欄は「変える」を選べず、理由を出す。
    expect(await roleRadioOf(page, 'status', 'CHANGE').isDisabled()).toBe(true);
    expect(await page.locator('[data-testid="scenario-update-role"][data-field-name="status"]').getByTestId('scenario-update-role-blocked').textContent())
      .toBe(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS.SCENARIO_STATE_FIELD_NOT_CHANGEABLE.description);
    expect(await page.getByTestId('scenario-update-other-field').evaluateAll((items) => items.map((item) => item.getAttribute('data-field-name'))))
      .toEqual(['_method', 'lock_version', 'kept']);
    // 型は、候補の path の最後の組（ID の区切り）が既定。候補の path を出す。
    expect(await page.getByTestId('scenario-update-template').inputValue()).toBe('2');
    expect(await page.getByTestId('scenario-update-candidate-paths').textContent())
      .toBe(text.update.candidatePaths(UPDATE.page.path, UPDATE.action?.path ?? ''));
    await screenshot(page, 'h02-update-new');

    await chooseByKeyboard(page, page.getByTestId('scenario-update-ledger'), writeState.scenarioId);
    await tabTo(page, roleRadioOf(page, 'name', 'KEEP'));
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('[data-testid="scenario-update-role"][data-field-name="name"]').getAttribute('data-role')).toBe('CHANGE');
    await screenshot(page, 'h03-update-new-filled');
    await tabTo(page, page.getByTestId('scenario-save'));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE_ID}/[a-z0-9-]+\\?notice=saved$`, 'u'), { timeout: UI_TIMEOUT_MS });
    updateState.scenarioId = new URL(page.url()).pathname.split('/').at(-1) ?? '';

    // 詳細: UPDATE の指定と、更新の予定のレコード（台帳の照合済みの登録の最新。T30g の場面の `rec-1`）。
    const section = page.getByTestId('scenario-update-section');
    await section.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await section.getByTestId('scenario-update-ledger-value').getAttribute('data-scenario-id')).toBe(writeState.scenarioId);
    expect(await section.getByTestId('scenario-update-form-template').textContent()).toBe(UPDATE_FORM_TEMPLATE);
    expect(await section.getByTestId('scenario-update-action-template').textContent()).toBe(UPDATE_ACTION_TEMPLATE);
    expect(await section.getByTestId('scenario-update-changed').textContent()).toBe(listText(['name']));
    expect(await section.getByTestId('scenario-update-kept').textContent()).toBe(listText(UPDATE_KEPT_FIELDS));
    expect(await section.getByTestId('scenario-update-planned').getAttribute('data-target')).toBe('rec-1');
    await screenshot(page, 'h04-update-detail');
    const detail = await valueOf<UpdateDetail>('scenarioDetailPageFn', 'GET', { scenarioId: updateState.scenarioId });
    expect(detail.scenario).toMatchObject({ kind: 'UPDATE', fieldNames: ['name'] });
    expect(detail.scenario.update).toEqual({
      targetCreateScenarioId: writeState.scenarioId,
      formPathTemplate: UPDATE_FORM_TEMPLATE,
      actionPathTemplate: UPDATE_ACTION_TEMPLATE,
      keepFieldNames: [...UPDATE_KEPT_FIELDS],
    });
    expect(detail).toMatchObject({ plannedUpdateTarget: 'rec-1', updateLedger: { scenarioId: writeState.scenarioId, pagePath: CREATE.page.path } });

    // 変更の画面は、保存した UPDATE の指定から始まる。
    const edit = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateState.scenarioId}/edit`);
    await edit.getByTestId('scenario-update').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await edit.getByTestId('scenario-update-ledger').inputValue()).toBe(writeState.scenarioId);
    expect(await edit.getByTestId('scenario-update-template').inputValue()).toBe('2');
    expect(await edit.getByTestId('scenario-update-role').evaluateAll((items) => items.map((item) => item.getAttribute('data-role'))))
      .toEqual(['CHANGE', 'KEEP', 'KEEP', 'KEEP', 'KEEP']);
  });

  it('shows the draft errors near the UPDATE inputs (typed templates, no field to change), and the server rejects the roles by field', async () => {
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/new?candidate=${encodeURIComponent(UPDATE_NO_TEMPLATE.identityDigest)}`);
    await page.getByTestId('scenario-update').waitFor({ timeout: UI_TIMEOUT_MS });
    // 型を作れない画面は、手で入力する。
    expect(await page.getByTestId('scenario-update-no-template').count()).toBe(1);
    expect(await page.getByTestId('scenario-update-template').inputValue()).toBe('manual');
    const templates = page.getByTestId('scenario-update-templates');
    for (const label of [text.update.formPathTemplate, text.update.actionPathTemplate]) {
      await tabTo(page, templates.getByLabel(label, { exact: true }));
      await page.keyboard.type(`/edit-profile/${RECORD_ID_PLACEHOLDER}`);
    }
    await tabTo(page, page.getByTestId('scenario-save'));
    await page.keyboard.press('Enter');
    const rejection = page.getByTestId('scenario-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-reason')).toBe('SCENARIO_DRAFT_INVALID');
    // 型の誤りは型の近くに、変える欄がない誤りは役割の近くに出す（上のお知らせには出さない）。
    expect(await templates.locator('.field-error').first().textContent())
      .toBe(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS.SCENARIO_UPDATE_PATH_MISMATCH.description);
    expect(await page.getByTestId('scenario-update-roles-errors').textContent())
      .toBe(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS.SCENARIO_UPDATE_NO_CHANGED_FIELD.description);
    for (const code of ['SCENARIO_UPDATE_PATH_MISMATCH', 'SCENARIO_UPDATE_NO_CHANGED_FIELD']) {
      expect(await rejection.locator(`[data-code="${code}"]`).count(), code).toBe(0);
    }
    await screenshot(page, 'h05-update-draft-errors');

    // 欄ごとの役割の誤り（状態の欄を変える、変える欄と保つ欄の重なり、役割の漏れ）と、台帳の誤りを、サーバが欄ごとに返す。
    const rejected = await valueOf<DraftRejection>('createScenarioFn', 'POST', {
      draft: updateScenarioDraftOf(updateState.scenarioId, { fieldNames: ['name', 'status'] }, { keepFieldNames: ['email', 'name', 'note'] }),
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'SCENARIO_DRAFT_INVALID' });
    expect(rejected.errors.map(({ code, fieldName }) => [code, fieldName])).toEqual(expect.arrayContaining([
      ['SCENARIO_UPDATE_TARGET_NOT_CREATE', null],
      ['SCENARIO_STATE_FIELD_NOT_CHANGEABLE', 'status'],
      ['SCENARIO_UPDATE_FIELD_ROLE_OVERLAP', 'name'],
      ['SCENARIO_UPDATE_FIELD_ROLE_MISSING', 'phone'],
    ]));
  });

  it('shows that no record can be the target when the ledger has no verified registration', async () => {
    // 台帳: T28e の場面の登録のシナリオ（照合済みの登録がない）。
    const created = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', { draft: updateScenarioDraftOf(state.scenarioId) });
    expect(created.ok).toBe(true);
    expect(await valueOf<UpdateDetail>('scenarioDetailPageFn', 'GET', { scenarioId: created.scenarioId })).toMatchObject({ plannedUpdateTarget: null });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${created.scenarioId}`);
    const planned = page.getByTestId('scenario-update-planned');
    await planned.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await planned.getAttribute('data-target')).toBe('');
    expect(await planned.textContent()).toBe(text.update.noPlannedTarget);
    await screenshot(page, 'h06-update-no-target');
  });

  it('keeps the CSRF protection for the UPDATE draft: a cross-site or other-origin POST is 403, and creates nothing', async () => {
    const before = (await valueOf<{ scenarios: readonly unknown[] }>('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).scenarios.length;
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get('createScenarioFn') ?? ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body: encodeServerFunctionPayload({ draft: updateScenarioDraftOf(writeState.scenarioId) }),
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    expect((await valueOf<{ scenarios: readonly unknown[] }>('scenarioListPageFn', 'GET', { profileId: WRITE_PROFILE_ID })).scenarios).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T31h-2: UPDATE の開始と結果の画面
// ---------------------------------------------------------------------------------------------------------------

/** UPDATE の開始の画面の値（確かめに使う所）。 */
interface UpdateStartPage extends WriteStartPage {
  readonly scenario: { readonly kind: string; readonly revision: number };
  readonly update: {
    readonly targetCreateScenarioId: string;
    readonly plannedTarget: string | null;
    readonly changedFieldNames: readonly string[];
    readonly keptFieldNames: readonly string[];
    readonly formPath: string | null;
    readonly actionPath: string | null;
  } | null;
}

/** UPDATE のシナリオの、結果ごとの固定の値（一意にする欄の組は `name`。同じ台帳の値と重ならない）。 */
const UPDATE_VALUES = Object.freeze({ verified: 't31h2-verified', unexpected: 't31h2-unexpected', undetermined: 't31h2-undetermined', none: 't31h2-none' });
/** 前の値（偽のワーカーが更新の前に読んだとする値。合成のテストデータ）。 */
const PREVIOUS_NAME = 't31h2-before';
/**
 * 偽のワーカーが書く送信の時刻の、成果物を作る時からの幅（ms）。送信の時刻は、開始のときの送る前の記録より後でなければ、締めの部品が成果物を
 * 使わない（本物のワーカーは開始の後に書く）。
 */
const ACTION_RUN_TIME_OFFSET_MS = 60_000;
/** 次の登録を入れる時刻の、T30g の場面の記録の後の幅（連続の上限の間隔より長い）。 */
const NEXT_REGISTRATION_OFFSET_MS = 5 * SEEDED_WRITE_STEP_MS;

/** UPDATE の検証の指定（照合の READ は T30g の場面の定義。結び付ける値は変える欄 `name`）。 */
const updateVerificationOf = (): Record<string, unknown> => ({
  successCondition: { pathPrefix: '/admin/members/', selector: '.updated' },
  inputErrorCondition: { pathPrefix: '/admin/members/', selector: '.error' },
  recordId: { source: 'URL_PATH_PATTERN', pathPattern: `/admin/members/${RECORD_ID_PLACEHOLDER}` },
  readVerification: { readCheckId: writeState.readCheckId, revision: 1, bindings: [{ parameterName: 'q', fieldName: 'name' }],
    expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
});

/** シナリオを、画面の承認の Server Function で承認する。 */
const approveByFunction = async (scenarioId: string): Promise<void> => {
  const detail = await valueOf<{ scenario: { revision: number }; status: { approvalDigest: string } | null }>('scenarioDetailPageFn', 'GET', { scenarioId });
  expect(await valueOf('approveScenarioFn', 'POST', {
    scenarioId, expectedRevision: detail.scenario.revision, expectedApprovalDigest: detail.status?.approvalDigest,
  })).toMatchObject({ ok: true });
};

/** UPDATE のシナリオを作り（検証の指定つき）、入力の規則を付け、求めれば承認する。シナリオの id を返す。 */
const prepareUpdateWrite = async (ledgerId: string, value: string, approve: boolean): Promise<string> => {
  const created = await valueOf<{ ok: boolean; scenarioId: string }>('createScenarioFn', 'POST', {
    draft: updateScenarioDraftOf(ledgerId, { verification: updateVerificationOf() }),
  });
  expect(created.ok).toBe(true);
  const detail = await valueOf<{ scenario: { revision: number } }>('scenarioDetailPageFn', 'GET', { scenarioId: created.scenarioId });
  expect(await valueOf<{ ok: boolean }>('saveDataRulesFn', 'POST', {
    scenarioId: created.scenarioId,
    expectedScenarioRevision: detail.scenario.revision,
    expectedRuleSetRevision: null,
    fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [value] }],
    relations: [],
    uniqueKeyFieldNames: ['name'],
  })).toMatchObject({ ok: true });
  if (approve) {
    await approveByFunction(created.scenarioId);
  }
  return created.scenarioId;
};

const updatePageOf = (scenarioId: string): Promise<UpdateStartPage> => valueOf<UpdateStartPage>('writeStartPageFn', 'GET', { scenarioId });

/** UPDATE の証拠の保つ欄（既定はすべて一致。`overrides` で欄ごとの一致を変える）。 */
const keptEvidenceOf = (overrides: Readonly<Record<string, boolean | null>> = {}): readonly Record<string, unknown>[] =>
  UPDATE_KEPT_FIELDS.map((fieldName) => ({
    fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: Object.hasOwn(overrides, fieldName) ? overrides[fieldName] ?? null : true,
  }));

/**
 * 偽のワーカーが書く UPDATE の `action-run.json`（ジョブの id・許可の id・seed の記録・対象の ID は、偽のワーカーが `START` の値に置き換える印。
 * 取れた ID も対象の ID の印）。結果と理由は、締めの部品が決め直す（ここの値は成果物の形のためだけ）。
 */
const updateActionRunTextOf = (
  scenarioId: string,
  scenarioRevision: number,
  value: string,
  changedMatched: boolean | null,
  kept: readonly Record<string, unknown>[],
  outcome: { readonly result: string; readonly reason: string },
): string => {
  const at = formatCompactUtcTimestamp(new Date(Date.now() + ACTION_RUN_TIME_OFFSET_MS), 't31h2 fake action run');
  const verification = updateVerificationOf();
  return JSON.stringify({
    schemaVersion: 'action-run-schema/1.0',
    jobId: '__START_JOB_ID__',
    runId: FAKE_RUN_ID,
    profileId: WRITE_PROFILE_ID,
    scenarioId,
    scenarioRevision,
    grantId: '__START_GRANT_ID__',
    seedRecord: '__START_SEED_RECORD__',
    submittedValues: { name: value },
    resultConditions: { successCondition: verification['successCondition'], inputErrorCondition: verification['inputErrorCondition'] },
    submission: 'SENT',
    blockReason: null,
    httpStatus: 200,
    responseJudgement: 'SUCCESS',
    recordId: '__START_TARGET_RECORD_ID__',
    readVerification: { readCheckId: writeState.readCheckId, readCheckRevision: 1, result: 'MATCHED' },
    reservationState: 'COMMITTED',
    result: outcome.result,
    reason: outcome.reason,
    startedAt: at,
    submittedAt: at,
    finishedAt: at,
    update: {
      targetRecordId: '__START_TARGET_RECORD_ID__',
      updateEvidence: { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: PREVIOUS_NAME, newValue: value, matched: changedMatched }, ...kept] },
    },
  });
};

/** T32g: 偽のワーカーが書く書き込みの報告（HTML と ZIP を含む）。 */
type FakeWriteReport = NonNullable<NonNullable<FakeWorkerValues['write']>['report']>;

/**
 * 一時の root の監査のワーカーの入口を、UPDATE の `action-run.json` を書いて終わる偽のワーカーに替える。T32g: `report` があれば、書き込みの報告
 * （証拠・承認の要約・HTML・ZIP）も書く。
 */
const installFakeUpdateWrite = (outputDirectory: string, actionRunText: string, report: FakeWriteReport | null = null): void => {
  const directory = `${rootOf().root}/fake-workers/update-${String(Date.now())}`;
  mkdirSync(directory, { recursive: true });
  const worker = writeFakeWorker(directory, 'write', {
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
    write: {
      outputDirectory: `${rootOf().root}/${outputDirectory}`, recheck: 1, onReject: 'report', submission: { submission: 'SENT', blockReason: null },
      actionRunText, end: 'finish', ...(report === null ? {} : { report }),
    },
  });
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
};

/** 画面から UPDATE を始める（確認のダイアログの後）。ジョブの id を返す。 */
const startUpdateOnScreen = async (scenarioId: string, shot: string): Promise<string> => {
  const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${scenarioId}/write`);
  await page.getByTestId('write-start-open').waitFor({ timeout: UI_TIMEOUT_MS });
  await screenshot(page, shot);
  await page.getByTestId('write-start-open').click();
  const dialog = page.getByRole('dialog', { name: writeText.startDialog.title });
  await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
  expect(await dialog.textContent()).toContain(writeText.startDialogUpdateBody);
  expect(await focusedText(page)).toBe(writeText.startDialog.cancel);
  await dialog.getByRole('button', { name: writeText.startDialog.confirm, exact: true }).click();
  await page.waitForURL(/\/jobs\/[a-z0-9-]+$/u, { timeout: UI_TIMEOUT_MS });
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
};

/** 予約が `RESERVED` のまま残っていない。 */
const expectNoReservedLeft = (scenarioId: string): void => {
  withControlData((database) => expect(readWriteReservations(database, scenarioId).filter(({ state: reservationState }) => reservationState === 'RESERVED'))
    .toEqual([]));
};

/** T31h-2 の場面をまたぐ値。 */
const updateWriteState: { verifiedId: string; plannedBefore: string } = { verifiedId: '', plannedBefore: '' };

describe('T31h-2: the UPDATE write start and results', () => {
  it('shows what to confirm before an UPDATE start, and the server rejects an unapproved scenario and a kind mismatch without a grant', async () => {
    updateWriteState.verifiedId = await prepareUpdateWrite(writeState.scenarioId, UPDATE_VALUES.verified, false);
    const view = await updatePageOf(updateWriteState.verifiedId);
    const planned = view.update?.plannedTarget ?? '';
    expect(planned).not.toBe('');
    updateWriteState.plannedBefore = planned;
    expect(view).toMatchObject({
      eligible: true, startable: false, approved: false, missingVerification: [],
      scenario: { kind: 'UPDATE' },
      update: {
        targetCreateScenarioId: writeState.scenarioId,
        changedFieldNames: ['name'],
        keptFieldNames: [...UPDATE_KEPT_FIELDS],
        // 送り先と画面の path は、シナリオの型に予定のレコードの ID を入れた形。
        formPath: `/admin/members/${planned}/edit`,
        actionPath: `/admin/members/${planned}`,
      },
    });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateWriteState.verifiedId}/write`);
    const start = page.getByTestId('write-start');
    await start.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await start.getAttribute('data-startable')).toBe('false');
    expect(await start.getAttribute('data-kind')).toBe('UPDATE');
    expect(await page.getByTestId('write-start-target').getAttribute('data-target')).toBe(planned);
    expect(await page.getByTestId('write-start-target').textContent()).toBe(planned);
    expect(await page.getByTestId('write-start-changed').textContent()).toBe(listText(['name']));
    expect(await page.getByTestId('write-start-kept').textContent()).toBe(listText(UPDATE_KEPT_FIELDS));
    expect(await page.getByTestId('write-start-action').getAttribute('data-path')).toBe(`/admin/members/${planned}`);
    expect(await page.getByTestId('write-start-form').getAttribute('data-path')).toBe(`/admin/members/${planned}/edit`);
    expect(await page.getByTestId('write-start-fields').count()).toBe(0);
    expect(await page.getByTestId('write-start-open').count()).toBe(0);
    expect(await page.getByText(writeText.confirmNoteUpdate, { exact: true }).count()).toBe(1);
    await screenshot(page, 'h2-01-update-start-unapproved');
    // 詳細から開始の画面へ移れる。
    const detail = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateWriteState.verifiedId}`);
    await detail.getByTestId('scenario-status').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await detail.getByTestId('scenario-open-write').count()).toBe(1);

    const revision = view.scenario.revision;
    expect(await valueOf<WriteStartResult>('startWriteUpdateFn', 'POST', {
      scenarioId: updateWriteState.verifiedId, expectedRevision: revision, expectedTargetRecordId: planned,
    })).toMatchObject({ ok: false, stage: 'GRANT', reason: 'GRANT_APPROVAL_INVALID' });
    // 種類の違い: UPDATE を CREATE の口で、CREATE を UPDATE の口で始めない（画面のサーバが、許可を出す前に拒む）。
    expect(await valueOf<WriteStartResult>('startWriteCreateFn', 'POST', { scenarioId: updateWriteState.verifiedId, expectedRevision: revision }))
      .toMatchObject({ ok: false, stage: 'LOCAL', reason: 'WRITE_KIND_NOT_CREATE' });
    const createRevision = (await detailOf(writeState.scenarioId)).scenario.revision;
    expect(await valueOf<WriteStartResult>('startWriteUpdateFn', 'POST', {
      scenarioId: writeState.scenarioId, expectedRevision: createRevision, expectedTargetRecordId: planned,
    })).toMatchObject({ ok: false, stage: 'LOCAL', reason: 'WRITE_KIND_NOT_UPDATE' });
    expect(WRITE_START_LOCAL_REJECTION_DESCRIPTIONS.WRITE_KIND_NOT_UPDATE.description.length).toBeGreaterThan(0);
    withControlData((database) => expect(readWriteReservations(database, updateWriteState.verifiedId)).toEqual([]));
  });

  it('keeps the CSRF protection for the UPDATE start: a cross-site or other-origin POST is 403, a bad input is 400, and issues nothing', async () => {
    const data = { scenarioId: updateWriteState.verifiedId, expectedRevision: 1, expectedTargetRecordId: 'rec-1' };
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get('startWriteUpdateFn') ?? ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body: encodeServerFunctionPayload(data),
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    for (const bad of [
      { scenarioId: updateWriteState.verifiedId, expectedRevision: 1 },
      { ...data, expectedTargetRecordId: '../x' },
      { ...data, expectedTargetRecordId: '' },
      { ...data, extra: true },
    ]) {
      expect((await call('startWriteUpdateFn', 'POST', bad)).response.status, JSON.stringify(bad)).toBe(STATUS.BAD_REQUEST);
    }
    withControlData((database) => expect(readWriteReservations(database, updateWriteState.verifiedId)).toEqual([]));
  });

  it('cannot start an UPDATE when the ledger has no record to update (approved), and the server rejects it with the catalog reason', async () => {
    // 台帳: T28e の場面の登録のシナリオ（照合済みの登録がない）。
    const scenarioId = await prepareUpdateWrite(state.scenarioId, UPDATE_VALUES.none, true);
    const view = await updatePageOf(scenarioId);
    expect(view).toMatchObject({ approved: true, startable: false, update: { plannedTarget: null, formPath: null, actionPath: null } });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${scenarioId}/write`);
    const target = page.getByTestId('write-start-target');
    await target.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await target.getAttribute('data-target')).toBe('');
    expect(await target.textContent()).toBe(text.update.noPlannedTarget);
    expect(await page.getByTestId('write-start-open').count()).toBe(0);
    await screenshot(page, 'h2-02-update-start-no-target');
    expect(await valueOf<WriteStartResult>('startWriteUpdateFn', 'POST', {
      scenarioId, expectedRevision: view.scenario.revision, expectedTargetRecordId: 'rec-1',
    })).toMatchObject({ ok: false, stage: 'GRANT', reason: 'TARGET_RECORD_UNAVAILABLE' });
    withControlData((database) => expect(readWriteReservations(database, scenarioId)).toEqual([]));
  });

  it('shows TARGET_SELECTION_CHANGED with the catalog text when a new registration changed the planned record after the screen showed it', async () => {
    await approveByFunction(updateWriteState.verifiedId);
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateWriteState.verifiedId}/write`);
    await page.getByTestId('write-start-open').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('write-start-target').getAttribute('data-target')).toBe(updateWriteState.plannedBefore);
    // テストだけの操作: 台帳（登録のシナリオ）を今の事実で承認し直し、照合まで済んだ新しい登録を、前の記録より後の時刻で入れる。
    if ((await detailOf(writeState.scenarioId)).status?.displayState !== 'APPROVED') {
      await approveByFunction(writeState.scenarioId);
    }
    withControlData((database) => {
      const scenario = readScenario(database, writeState.scenarioId);
      const approval = readApprovalReceipts(database, writeState.scenarioId).findLast((receipt) => receipt.kind === 'APPROVAL');
      if (scenario === null || approval?.kind !== 'APPROVAL') {
        throw new Error('the approved ledger scenario is missing');
      }
      const at = formatCompactUtcTimestamp(new Date(Date.now() + NEXT_REGISTRATION_OFFSET_MS), 't31h2 test-only registration');
      seedWriteResultForTest(database, {
        profileId: WRITE_PROFILE_ID,
        scenarioId: writeState.scenarioId,
        scenarioRevision: scenario.revision,
        grantId: 't31h2-grant-registration',
        jobId: 't31h2-job-registration',
        external: { authSetupDigest: approval.bound.authSetupDigest, targetConfigDigest: approval.bound.targetConfigDigest },
        at,
        submittedValues: { name: 't31h2-registered' },
        report: { submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: 'rec-2', readVerification: 'MATCHED',
          submittedAt: at },
      });
    });
    await page.getByTestId('write-start-open').click();
    const dialog = page.getByRole('dialog', { name: writeText.startDialog.title });
    await dialog.waitFor({ timeout: UI_TIMEOUT_MS });
    await dialog.getByRole('button', { name: writeText.startDialog.confirm, exact: true }).click();
    const rejection = page.getByTestId('write-start-rejection');
    await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await rejection.getAttribute('data-stage')).toBe('GRANT');
    expect(await rejection.getAttribute('data-reason')).toBe('TARGET_SELECTION_CHANGED');
    expect(await rejection.textContent()).toContain(EXECUTION_GRANT_REJECTION_DESCRIPTIONS.TARGET_SELECTION_CHANGED.description);
    await screenshot(page, 'h2-03-update-target-changed');
    withControlData((database) => expect(readWriteReservations(database, updateWriteState.verifiedId)).toEqual([]));
    expect((await updatePageOf(updateWriteState.verifiedId)).update?.plannedTarget).toBe('rec-2');
  });

  it('starts an UPDATE from the screen with the fake worker, and shows the VERIFIED result with the before and after values', async () => {
    const view = await updatePageOf(updateWriteState.verifiedId);
    installFakeUpdateWrite('t28e-write-output', updateActionRunTextOf(updateWriteState.verifiedId, view.scenario.revision, UPDATE_VALUES.verified, true,
      keptEvidenceOf(), { result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' }));
    const jobId = await startUpdateOnScreen(updateWriteState.verifiedId, 'h2-04-update-start-ready');
    expect(await waitForEnd(jobId)).toMatchObject({ state: 'FINISHED', failureReason: null });

    const job = await openPage(`/jobs/${jobId}`);
    const result = job.getByTestId('write-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await result.getAttribute('data-result')).toBe('VERIFIED');
    expect(await result.getAttribute('data-kind')).toBe('UPDATE');
    expect(await job.getByTestId('write-result-target').textContent()).toBe('rec-2');
    expect(await job.getByTestId('write-result-record-id').textContent()).toBe('rec-2');
    const changed = job.getByTestId('write-result-diff-changed');
    expect(await changed.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-field-name'), row.getAttribute('data-matched')])))
      .toEqual([['name', 'true']]);
    expect(await changed.getByTestId('write-result-diff-previous').textContent()).toBe(PREVIOUS_NAME);
    expect(await changed.getByTestId('write-result-diff-new').textContent()).toBe(UPDATE_VALUES.verified);
    expect(await job.getByTestId('write-result-diff-kept').evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-field-name'),
      row.getAttribute('data-matched')]))).toEqual(UPDATE_KEPT_FIELDS.map((name) => [name, 'true']));
    expect(await job.getByTestId('write-result-unknown').count()).toBe(0);
    await screenshot(job, 'h2-05-update-result-verified');
    expectNoReservedLeft(updateWriteState.verifiedId);

    // 履歴: 対象の ID の列を出す。
    const detail = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateWriteState.verifiedId}`);
    const entry = detail.getByTestId('write-history-entry');
    await entry.first().waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await entry.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-result'), row.getAttribute('data-target')])))
      .toEqual([['VERIFIED', 'rec-2']]);
  });

  it.each<readonly [string, string, boolean | null, Readonly<Record<string, boolean | null>>, string, string, string]>([
    ['UNKNOWN with an unexpected change of a kept field', UPDATE_VALUES.unexpected, true, { status: false }, 'UNKNOWN', 'UNEXPECTED_FIELD_CHANGE', 'h2-06'],
    ['PARTIAL with a field that could not be checked', UPDATE_VALUES.undetermined, null, {}, 'PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED', 'h2-07'],
  ])('shows the %s settled from the fake worker', async (_label, value, changedMatched, kept, resultName, reason, shot) => {
    const scenarioId = await prepareUpdateWrite(writeState.scenarioId, value, true);
    const view = await updatePageOf(scenarioId);
    expect(view).toMatchObject({ startable: true, update: { plannedTarget: 'rec-2' } });
    installFakeUpdateWrite('t28e-write-output', updateActionRunTextOf(scenarioId, view.scenario.revision, value, changedMatched, keptEvidenceOf(kept),
      { result: resultName, reason }));
    const jobId = await startUpdateOnScreen(scenarioId, `${shot}-update-start`);
    expect(await waitForEnd(jobId)).toMatchObject({ state: 'FINISHED', failureReason: null });
    const job = await openPage(`/jobs/${jobId}`);
    const result = job.getByTestId('write-result');
    await result.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await result.getAttribute('data-result')).toBe(resultName);
    expect(await job.getByTestId('write-result-reason').getAttribute('data-reason')).toBe(reason);
    expect(await job.getByTestId('write-result-reason').textContent()).toBe(ACTION_OUTCOME_REASON_CATALOG[reason as keyof typeof ACTION_OUTCOME_REASON_CATALOG].label);
    if (resultName === 'UNKNOWN') {
      // `UNKNOWN` は、今の critical のお知らせのまま。
      expect(await job.getByRole('alert').filter({ hasText: writeText.unknownHeading }).count()).toBe(1);
      expect(await job.locator('[data-testid="write-result-diff-kept"][data-field-name="status"]').getAttribute('data-matched')).toBe('false');
    } else {
      expect(await job.getByTestId('write-result-partial').textContent()).toBe(writeText.partialUpdateBody);
      expect(await job.getByTestId('write-result-diff-changed').getAttribute('data-matched')).toBe('');
    }
    await screenshot(job, `${shot}-update-result`);
    expectNoReservedLeft(scenarioId);
  });

  it('does not offer the UPDATE start to a profile that is not in the write mode, and the server rejects the start', async () => {
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_AUTH_PASSIVE', updateState.profileRevision + 1),
      expectedRevision: updateState.profileRevision,
    })).toMatchObject({ ok: true });
    const page = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${updateWriteState.verifiedId}`);
    await page.getByTestId('scenario-status').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('scenario-open-write').count()).toBe(0);
    const view = await updatePageOf(updateWriteState.verifiedId);
    expect(view).toMatchObject({ eligible: false, startable: false, startBlocker: 'MODE_NOT_EXECUTABLE' });
    expect(await valueOf<WriteStartResult>('startWriteUpdateFn', 'POST', {
      scenarioId: updateWriteState.verifiedId, expectedRevision: view.scenario.revision, expectedTargetRecordId: view.update?.plannedTarget ?? 'rec-2',
    })).toMatchObject({ ok: false, stage: 'START', reason: 'MODE_NOT_EXECUTABLE' });
    expectNoReservedLeft(updateWriteState.verifiedId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T32g: 書き込みの報告の配布（親の確かめに通ったものだけ）と、監査済みデータの台帳の画面
// ---------------------------------------------------------------------------------------------------------------

/** 偽のワーカーが書く報告の HTML（`<head>` の `<style>` の 1 つ。クラスの色で、CSP の下でスタイルが効くかを確かめる）。 */
const REPORT_STYLE = '.t32g-mark{color:rgb(1, 2, 3)}';
const REPORT_HTML = `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="utf-8"><title>t32g</title><style>${REPORT_STYLE}</style></head>`
  + '<body><main><p class="t32g-mark" data-testid="t32g-mark">t32g</p></main></body></html>\n';
/** 色が当たったときの計算した値。 */
const REPORT_STYLE_COLOR = 'rgb(1, 2, 3)';
/** T32g の UPDATE で送る値（一意にする欄の組は同じ台帳のシナリオで重ならないので、T31h-2 と別の値）。 */
const REPORT_VALUES = Object.freeze({ valid: 't32g-valid', mismatch: 't32g-mismatch' });
/** 偽のワーカーが ZIP を作るときに読み込む fflate（依存にある部品の入口）。 */
const FFLATE_URL = pathToFileURL(createRequire(import.meta.url).resolve('fflate')).href;
/** 書き込みの報告の 4 つの成果物の種類。 */
const WRITE_REPORT_ARTIFACT_KINDS = Object.freeze(['ACTION_REPORT', 'ACTION_EVIDENCE_JSON', 'APPROVAL_SUMMARY_JSON', 'ACTION_BUNDLE']);
const reportText = LOCAL_UI_WRITE_REPORT_TEXT;
const ledgerText = LOCAL_UI_LEDGER_TEXT;

/**
 * 偽のワーカーが書く報告（`action-run.json` の文と重なる値が同じ、照合まで済んだ UPDATE の証拠。印はジョブの id と対象の ID。偽のワーカーが
 * START の値に置き換える）。`tamper` は、ZIP の後にディスクの HTML を書き換える（親の確かめに通らない）。
 */
const fakeWriteReportOf = (scenarioId: string, scenarioRevision: number, actionRunText: string, tamper: 'disk' | null): FakeWriteReport => {
  const run = JSON.parse(actionRunText) as { result: string; reason: string; startedAt: string; finishedAt: string };
  const base = verifiedUpdateDocuments().evidence;
  return {
    approvalSummarySchemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
    actionEvidenceText: JSON.stringify({
      ...base,
      jobId: '__START_JOB_ID__',
      runId: FAKE_RUN_ID,
      profileId: WRITE_PROFILE_ID,
      scenarioId,
      scenarioRevision,
      recordId: '__START_TARGET_RECORD_ID__',
      update: { ...base.update, targetRecordId: '__START_TARGET_RECORD_ID__' },
      result: run.result,
      reason: run.reason,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }),
    reportHtml: REPORT_HTML,
    bundle: { name: actionBundleFileName(run.finishedAt), fflateUrl: FFLATE_URL, ...(tamper === null ? {} : { tamper }) },
  };
};

/** ジョブの詳細の値（T32g で確かめる項目）。 */
interface ReportJobDetail {
  readonly artifacts: readonly { readonly kind: string; readonly relativePath: string; readonly href: string }[];
  readonly write: {
    readonly scenarioId: string;
    readonly report: { readonly check: string | null; readonly reportHref: string | null; readonly bundleHref: string | null };
  } | null;
}

/** 台帳の画面の値（確かめる項目）。 */
interface LedgerPage {
  readonly eligible: boolean;
  readonly entries: readonly { readonly jobId: string; readonly recordId: string | null; readonly updates: { readonly count: number } }[];
  readonly scenarios: readonly { readonly scenarioId: string; readonly used: number; readonly limit: number }[];
}

/** UPDATE を偽のワーカーで画面から始め、終わったジョブの id を返す（`tamper` は報告を食い違わせる）。 */
const runReportedUpdate = async (value: string, shot: string, tamper: 'disk' | null): Promise<string> => {
  const scenarioId = await prepareUpdateWrite(writeState.scenarioId, value, true);
  const view = await updatePageOf(scenarioId);
  expect(view).toMatchObject({ startable: true });
  const actionRunText = updateActionRunTextOf(scenarioId, view.scenario.revision, value, true, keptEvidenceOf(),
    { result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
  installFakeUpdateWrite('t28e-write-output', actionRunText, fakeWriteReportOf(scenarioId, view.scenario.revision, actionRunText, tamper));
  const jobId = await startUpdateOnScreen(scenarioId, shot);
  expect(await waitForEnd(jobId)).toMatchObject({ state: 'FINISHED', failureReason: null });
  return jobId;
};

/** 偽のワーカーの Run のディレクトリ（すべての偽のジョブが同じ Run の ID を使う）。 */
const fakeRunDirectory = (): string => `${rootOf().root}/t28e-write-output/${FAKE_RUN_ID}`;

/** 成果物の要求（cookie つき）。 */
const getArtifact = (path: string) => rawRequest(started().port, path, { headers: { cookie } });

/** T32g の場面をまたぐ値。 */
const reportState: { validJobId: string; mismatchJobId: string; discoveryJobId: string } = { validJobId: '', mismatchJobId: '', discoveryJobId: '' };

describe('T32g: the write report on the screens, and the audited data ledger', () => {
  it('distributes the four report artifacts of a write job whose report passed the check, and offers them on the job and the history', async () => {
    // T31h-2 の最後で、書き込みのモードでなくした。書き込みのモードに戻し、認証の設定と発見を今の改訂で行う（T31h-1 と同じ）。
    const passiveRevision = updateState.profileRevision + 1;
    updateState.profileRevision = passiveRevision + 1;
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_APPROVED_WRITE', updateState.profileRevision),
      expectedRevision: passiveRevision,
    })).toMatchObject({ ok: true });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...authSetup(WRITE_PROFILE_ID), profileRevision: updateState.profileRevision } }))
      .toMatchObject({ ok: true });
    installFakeDiscovery('t28e-write-output');
    const discovery = await valueOf<{ ok: boolean; jobId: string }>('startDiscoveryFn', 'POST', {
      profileId: WRITE_PROFILE_ID, expectedRevision: updateState.profileRevision,
    });
    expect(discovery.ok).toBe(true);
    expect(await waitForEnd(discovery.jobId)).toMatchObject({ state: 'FINISHED' });
    reportState.discoveryJobId = discovery.jobId;

    const jobId = await runReportedUpdate(REPORT_VALUES.valid, 'g32-01-report-start', null);
    reportState.validJobId = jobId;
    expect(withControlData((database) => readJob(database, jobId)?.writeReportCheck)).toBe('VALID');
    const detail = await valueOf<ReportJobDetail>('getAuditJobFn', 'GET', { jobId });
    expect(detail.artifacts.map(({ kind }) => kind)).toEqual(expect.arrayContaining([...WRITE_REPORT_ARTIFACT_KINDS]));
    const bundle = detail.artifacts.find(({ kind }) => kind === 'ACTION_BUNDLE')?.relativePath ?? '';
    expect(bundle).toMatch(/^beaksight-action-bundle_\d{14}\.zip$/u);
    expect(detail.write?.report).toEqual({
      check: 'VALID',
      reportHref: `/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`,
      bundleHref: `/artifacts/${jobId}/${bundle}`,
    });

    // 4 つの成果物: JSON は ASCII の名前のダウンロード、HTML は style の hash の CSP、ZIP はその名前のダウンロード。
    for (const name of [ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME]) {
      const response = await getArtifact(`/artifacts/${jobId}/${name}`);
      expect(response.status, name).toBe(STATUS.OK);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/u);
      expect(response.body).toBe(readFileSync(`${fakeRunDirectory()}/${name}`, 'utf8'));
    }
    const html = await getArtifact(`/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`);
    expect(html.status).toBe(STATUS.OK);
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-disposition']).toBeUndefined();
    const styleHash = createHash('sha256').update(REPORT_STYLE, 'utf8').digest('base64');
    const policy = String(html.headers['content-security-policy']);
    expect(policy).toContain(`style-src 'sha256-${styleHash}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/unsafe-|allow-scripts|script-src/u);
    expect(html.headers['x-beaksight-artifact-style-sha256']).toBeUndefined();
    const zip = await getArtifact(`/artifacts/${jobId}/${bundle}`);
    expect(zip.status).toBe(STATUS.OK);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toBe(`attachment; filename="${bundle}"`);

    // ジョブの詳細: 報告を開く・落とすリンク。開いた HTML は、CSP の下でクラスの色が当たる（CSP の違反と console の誤りは、ページの記録の補助が
    // 0 件を確かめる）。
    const job = await openPage(`/jobs/${jobId}`);
    const report = job.getByTestId('write-report');
    await report.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await report.getAttribute('data-check')).toBe('VALID');
    expect(await job.getByTestId('write-report-open').getAttribute('href')).toBe(detail.write?.report.reportHref);
    expect(await job.getByTestId('write-report-open').textContent()).toBe(reportText.openReport);
    expect(await job.getByTestId('write-report-download').getAttribute('href')).toBe(detail.write?.report.bundleHref);
    expect(await job.getByTestId('write-report-download').getAttribute('download')).not.toBeNull();
    expect(await job.locator('[data-artifact="ACTION_REPORT"]').count()).toBe(1);
    await screenshot(job, 'g32-02-report-links');
    const opened = await openPage(`/artifacts/${jobId}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`);
    expect(await opened.getByTestId('t32g-mark').evaluate((element) => getComputedStyle(element).color)).toBe(REPORT_STYLE_COLOR);

    // 書き込みの履歴: 報告の欄に開くリンク。
    const history = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${detail.write?.scenarioId ?? ''}`);
    const entry = history.locator(`[data-testid="write-history-entry"][data-job-id="${jobId}"]`);
    await entry.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await entry.getAttribute('data-report-check')).toBe('VALID');
    expect(await entry.getByTestId('write-history-report-open').getAttribute('href')).toBe(detail.write?.report.reportHref);
  });

  it('does not distribute a report that did not pass the check, and shows the reason on the job and the history', async () => {
    const jobId = await runReportedUpdate(REPORT_VALUES.mismatch, 'g32-03-mismatch-start', 'disk');
    reportState.mismatchJobId = jobId;
    expect(withControlData((database) => readJob(database, jobId)?.writeReportCheck)).toBe('BUNDLE_MISMATCH');
    const detail = await valueOf<ReportJobDetail>('getAuditJobFn', 'GET', { jobId });
    expect(detail.artifacts.filter(({ kind }) => WRITE_REPORT_ARTIFACT_KINDS.includes(kind))).toEqual([]);
    expect(detail.write?.report).toEqual({ check: 'BUNDLE_MISMATCH', reportHref: null, bundleHref: null });
    // ファイルはディスクにあるが、確かめに通らないので配らない。
    expect(readdirSync(fakeRunDirectory())).toEqual(expect.arrayContaining([ACTION_REPORT_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME]));
    for (const name of [ACTION_REPORT_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME]) {
      expect((await getArtifact(`/artifacts/${jobId}/${name}`)).status, name).toBe(STATUS.NOT_FOUND);
    }
    const job = await openPage(`/jobs/${jobId}`);
    const report = job.getByTestId('write-report');
    await report.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await report.getAttribute('data-check')).toBe('BUNDLE_MISMATCH');
    expect(await job.getByTestId('write-report-open').count()).toBe(0);
    expect(await job.getByTestId('write-report-reason').textContent()).toBe(WRITE_REPORT_CHECK_CATALOG.BUNDLE_MISMATCH.label);
    expect(await job.getByText(reportText.notDistributed, { exact: true }).count()).toBe(1);
    await screenshot(job, 'g32-04-report-not-distributed');
    const history = await openPage(`/scenarios/${WRITE_PROFILE_ID}/${detail.write?.scenarioId ?? ''}`);
    const entry = history.locator(`[data-testid="write-history-entry"][data-job-id="${jobId}"]`);
    await entry.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await entry.getAttribute('data-report-check')).toBe('BUNDLE_MISMATCH');
    expect(await entry.getByTestId('write-history-report-open').count()).toBe(0);
  });

  it('serves no file outside the allowed list, no traversal, no report of another job, and keeps the Host and cookie checks', async () => {
    const valid = reportState.validJobId;
    // 確かめに通った報告を持たないジョブ（発見のジョブと、食い違ったジョブ。同じ Run のディレクトリに報告のファイルがある）からは配らない。
    for (const jobId of [reportState.discoveryJobId, reportState.mismatchJobId]) {
      for (const name of [ACTION_REPORT_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME]) {
        expect((await getArtifact(`/artifacts/${jobId}/${name}`)).status, `${jobId} ${name}`).toBe(STATUS.NOT_FOUND);
      }
    }
    for (const path of [
      `/artifacts/${valid}/action-run.json`,
      `/artifacts/${valid}/beaksight-action-bundle_20000101000000.zip`,
      `/artifacts/${valid}/ACTION-REPORT.HTML`,
      `/artifacts/${valid}/..%2F${ACTION_REPORT_ARTIFACT_FILE_NAME}`,
      `/artifacts/${valid}/pages%2F..%2F${ACTION_REPORT_ARTIFACT_FILE_NAME}`,
      `/artifacts/${valid}/${ACTION_REPORT_ARTIFACT_FILE_NAME}%00`,
      `/artifacts/${valid}/${ACTION_REPORT_ARTIFACT_FILE_NAME}::$DATA`,
      `/artifacts/${reportState.mismatchJobId}/..%2F..%2F${FAKE_RUN_ID}%2F${ACTION_REPORT_ARTIFACT_FILE_NAME}`,
    ]) {
      expect((await getArtifact(path)).status, path).toBe(STATUS.NOT_FOUND);
    }
    // Host の違いは 421、cookie なしは配らない。
    const other = await rawRequest(started().port, `/artifacts/${valid}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`, {
      host: `localhost:${String(started().port)}`, headers: { cookie },
    });
    expect(other.status).toBe(STATUS.MISDIRECTED);
    expect(other.body).not.toContain('t32g-mark');
    expect((await rawRequest(started().port, `/artifacts/${valid}/${ACTION_REPORT_ARTIFACT_FILE_NAME}`)).body).not.toContain('t32g-mark');
  });

  it('shows the audited data ledger of the profile from the profile screen by keyboard, the same as the control data', async () => {
    const profile = await openPage(`/profiles/${WRITE_PROFILE_ID}`);
    await tabTo(profile, profile.getByTestId('profile-open-ledger'));
    await profile.keyboard.press('Enter');
    await profile.waitForURL(new RegExp(`/ledger/${WRITE_PROFILE_ID}$`, 'u'), { timeout: UI_TIMEOUT_MS });
    await profile.getByTestId('ledger').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await profile.getByTestId('ledger-note').textContent()).toBe(ledgerText.note);
    await screenshot(profile, 'g32-05-ledger');
    const stored = withControlData((database) => readAuditedDataLedger(database, WRITE_PROFILE_ID));
    expect(stored.length).toBeGreaterThan(0);
    // 照合まで済んだ登録 rec-2（T31h-2 で足した登録）には、画面から始めた UPDATE が数えられている。
    expect(stored.find(({ recordId }) => recordId === 'rec-2')?.updates.count).toBeGreaterThan(0);
    const rows = await profile.getByTestId('ledger-entry').evaluateAll((elements) => elements.map((row) => [
      row.getAttribute('data-job-id'), row.getAttribute('data-record-id'), row.getAttribute('data-update-count'), row.getAttribute('data-last-update-result'),
    ]));
    expect(rows).toEqual(stored.map((entry) => [entry.jobId, entry.recordId ?? '', String(entry.updates.count), entry.updates.last?.result ?? '']));
    const view = await valueOf<LedgerPage>('auditedDataLedgerPageFn', 'GET', { profileId: WRITE_PROFILE_ID });
    expect(view.eligible).toBe(true);
    expect(view.entries.map(({ jobId, recordId, updates }) => [jobId, recordId, updates.count]))
      .toEqual(stored.map(({ jobId, recordId, updates }) => [jobId, recordId, updates.count]));
    // 累計の件数と上限（シナリオごと。発行の判定と同じ数え方）。
    const ledgerScenario = view.scenarios.find(({ scenarioId }) => scenarioId === writeState.scenarioId);
    expect(ledgerScenario?.limit).toBe(withControlData((database) => readScenario(database, writeState.scenarioId)?.current.limits.maxCumulativeCreates));
    expect(await profile.locator(`[data-testid="ledger-scenario"][data-scenario-id="${writeState.scenarioId}"]`).getAttribute('data-used'))
      .toBe(String(ledgerScenario?.used));
    // seed の値と Cookie の値は出さない。
    const html = await profile.content();
    expect(html).not.toContain('a'.repeat(64));
    expect(html).not.toContain(cookie.slice(cookie.indexOf('=') + 1));
    // キーボードだけで、行からシナリオを開ける。
    await tabTo(profile, profile.getByTestId('ledger-entry').first().getByTestId('ledger-open-scenario'));
    await profile.keyboard.press('Enter');
    await profile.waitForURL(new RegExp(`/scenarios/${WRITE_PROFILE_ID}/[a-z0-9-]+$`, 'u'), { timeout: UI_TIMEOUT_MS });
  });

  it('keeps the CSRF and Host checks for the ledger, and rejects a bad input with 400', async () => {
    const payload = encodeURIComponent(encodeServerFunctionPayload({ profileId: WRITE_PROFILE_ID }));
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${ids.get('auditedDataLedgerPageFn') ?? ''}?payload=${payload}`, {
        headers: { cookie, 'x-tsr-serverfn': 'true', ...headers },
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
      expect(response.body).not.toContain(writeState.scenarioId);
    }
    expect((await rawRequest(started().port, `/ledger/${WRITE_PROFILE_ID}`, { host: `localhost:${String(started().port)}`, headers: { cookie } })).status)
      .toBe(STATUS.MISDIRECTED);
    for (const data of [{ profileId: '' }, { profileId: '../x' }, { profileId: WRITE_PROFILE_ID, extra: true }]) {
      expect((await call('auditedDataLedgerPageFn', 'GET', data)).response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    expect(await valueOf('auditedDataLedgerPageFn', 'GET', { profileId: 'no-such-profile' })).toBeNull();
  });

  it('does not show the ledger for a profile that is not in the write mode', async () => {
    const passive = await openPage(`/ledger/${PASSIVE_PROFILE_ID}`);
    await passive.getByTestId('ledger-not-eligible').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await passive.getByTestId('ledger-not-eligible').textContent()).toBe(ledgerText.notEligible);
    expect(await passive.getByTestId('ledger-entry').count()).toBe(0);
    expect(await valueOf<LedgerPage>('auditedDataLedgerPageFn', 'GET', { profileId: PASSIVE_PROFILE_ID })).toMatchObject({ eligible: false, entries: [] });
    const profile = await openPage(`/profiles/${PASSIVE_PROFILE_ID}`);
    await profile.locator('main').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await profile.getByTestId('profile-open-ledger').count()).toBe(0);
    // 書き込みのモードでなくしたプロファイルは、記録があっても台帳を出さない。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: profileDocument(WRITE_PROFILE_ID, state.writeTarget, 'TEST_AUTH_PASSIVE', updateState.profileRevision + 1),
      expectedRevision: updateState.profileRevision,
    })).toMatchObject({ ok: true });
    const page = await openPage(`/ledger/${WRITE_PROFILE_ID}`);
    await page.getByTestId('ledger-not-eligible').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('ledger-entry').count()).toBe(0);
    await screenshot(page, 'g32-06-ledger-not-eligible');
  });
});
