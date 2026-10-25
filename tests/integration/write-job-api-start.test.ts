// T40a（Task 40 の設計書 3.1・3.2、5 章の 1・2）と T40b-1（3.3、4 章、5 章の 1・2・4）: fixture の form のない登録の画面（`memberScreenLayout:
// 'formless'`）で、発見 → API のシナリオ → 承認 → 許可 → 書き込みのジョブの開始 → ワーカーに `START`（送り方 API）→ ワーカーの API の書き込みの流れ →
// 台帳 → 報告、までを、ジョブの管理（`createAuditJobManager`）と本物のワーカー（`child_process.fork`。一時のビルドの本番の process の組み立てを、
// ログインの段の口だけ替えたテストだけの入口）で確かめる。T40b-2: 照合の READ（`{id}` に取った ID を入れた会員の詳細の画面を 1 回読む）まで通し、
// 結果は `VERIFIED`（`READ_VERIFICATION_MATCHED`）、ジョブは `COMPLETE`。
// - 発見は本物の流れ（`executeDiscoveryRun`。同じ process の中。認証つきの factory と Guard、送らずに観察する probe）。準備の部品は
//   `tests/helpers/api-write-scenario.ts`（本番の部品の公開の口だけ）。
// - 認証の設定は版 3 のスクリプトで送るログイン（ワーカーのログインの段が token を 1 回送る。資格情報はテストが標準入力で渡す）。
// - シナリオ: 送る鍵は欄に対応する鍵、照合の READ は `{id}` の型の画面の READ（`/admin/members/{id}/edit`）。検証の指定は照合の READ だけ（ID は API の
//   `recordId`）。`START` の 2 つの条件は null。
// - 許可: API の登録には出る（予約は `RESERVED`）。予約と上限は今どおり使う: 1 回の件数の上限を超える件数は拒む、開いた許可があるうちは次の許可を
//   拒む、同じ許可で同時に 2 回始めると 1 つだけ始まる、書き込みの後は 5 分の間隔で次の許可を拒み、消費した許可では始まらない（二重の登録 0、
//   上限の超過 0）。
// - 書き込み: サーバに届いた登録は 1 回だけ。応答の本文から ID が取れ、台帳に API の行（送り方と型の要約）、`action-run.json`・`action-evidence.json` は
//   1.1 の API の形、予約は `COMMITTED`。
// - 秘密の目印（fixture の資格情報・API の鍵・発行した token、応答の本文の目印、probe の目印）は、IPC・管理データのファイル（WAL を含む）・成果物
//   （ZIP の中身を含む）・ワーカーの出力に出ない。process が残らない。
// - API の更新（Task 41）は、許可から `START` までを `api-update-grant-start.test.ts`（T41b）が、本物のワーカーの更新の流れと親の締めまでを
//   `write-job-api-update.test.ts`（T41d-2）が確かめる。
// - SR-1-F（SR-1 の Minor-1）: 承認の期限切れ・許可の後の取り消し・始めた直後の取り消しで、登録の POST が届かないこと（下の 1 つ目の describe）。
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { actionApiSummaryOf } from '../../src/control/actions/action-api-summary.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import { approvalExpiresAtOf } from '../../src/control/approval/approval-validity.js';
import { APPROVAL_TTL_DAYS } from '../../src/control/approval/scenario-contracts.js';
import {
  approveScenario,
  issueExecutionGrant,
  readExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  revokeScenarioApproval,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { ACTION_EVIDENCE_ARTIFACT_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { DAY_MS } from '../../src/core/time-units.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  API_WRITE_FIXTURE_SESSION_KEY,
  API_WRITE_READ_TEMPLATE_PATH,
  API_WRITE_SERVICE_REQUEST_LIMITS,
  createApiCreateScenario,
  DEFAULT_SPA_DISCOVERY_JOB_ID,
  discoverSpaMemberScreens,
} from '../helpers/api-write-scenario.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { databaseFilePlaces, filesUnder, placesWithMarkers, READ_METHODS } from '../helpers/leak-places.js';
import { descendantsOf, listProcesses } from '../helpers/process-tree.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 300_000;
const WAIT_LIMIT_MS = 180_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 30_000;
/** ログインを待つ時間（ms。テストの口が入力する）。 */
const LOGIN_TIMEOUT_MS = 60_000;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
const PROFILE_ID = 'example-t40a';
const SCENARIO_ID = 'scenario-api-create';
const READ_CHECK_ID = 'rc-api-member';
const MARKER_PREFIX = 'bsprobe';
const OUTPUT_DIRECTORY_NAME = 'api-write-output';
const ENTRY_FILE_NAME = 'api-write-worker-test-entry.mjs';
const ENTRY_DIST_PREFIX = './dist/';

let build: TemporaryBuild;
let site: SpaAuthSite;
let directory = '';
let database: ControlDatabase;
let manager: AuditJobManager;
const children: ChildProcess[] = [];
const workerPids: number[] = [];
/** ワーカーから受けたメッセージと、ワーカーへ送ったメッセージ。 */
const received: unknown[] = [];
const sentToWorker: unknown[] = [];
let workerOutput = '';

const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');
const targetConfigPath = `local/targets/${PROFILE_ID}.json`;
const outputDirectory = (): string => join(directory, OUTPUT_DIRECTORY_NAME);

const externalFacts = async (): Promise<ApprovalExternalFacts> => {
  const stored = getProfile(database, PROFILE_ID);
  const value = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: directory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (value === null) {
    throw new Error('the external facts are not available');
  }
  return value;
};

const issue = async (grantId: string, count = 1, scenarioId = SCENARIO_ID) => issueExecutionGrant(database, {
  scenarioId, expectedRevision: readScenario(database, scenarioId)?.revision ?? 0, grantId, jobId: `job-${grantId}`, count,
  external: await externalFacts(), at: nowText(),
});

const startInput = (grantId: string, scenarioId = SCENARIO_ID) => ({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId, grantId });

/** ジョブの管理の時計の、実際の時刻からのずれ（ms。SR-1-F の承認の期限切れの場面だけが動かす。ほかは 0）。 */
let managerClockOffsetMs = 0;

const waitForEnd = async (jobId: string): Promise<AuditJobView> => {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const job = manager.getAuditJob(jobId);
    if (job !== null && job.finishedAt !== null && manager.runningWorkerCount() === 0) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`the job did not end: ${JSON.stringify(job)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
};

/** サーバに届いた読み取りでない要求（preflight を含む）。 */
const nonReadRequests = () => site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method));
/** サーバに届いた登録（バックエンドの members への POST）。 */
const memberPosts = () => site.requests.filter((request) => request.origin === 'backend' && request.method === 'POST'
  && request.path.startsWith(SPA_BACKEND_PATHS.members));

/** 版 3 のスクリプトで送るログインの認証の設定（ログインの段の token の送信。監査の段の手続きの呼び出しは登録しない）。 */
const setupOf = (): AuthSetupV3 => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  auditPathPrefixes: [SPA_APP_PATHS.admin],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
  loginSideRequests: [],
  successStorageKey: { origin: site.appOrigin, ...API_WRITE_FIXTURE_SESSION_KEY },
  auditReadRequests: [],
  serviceRequestLimits: API_WRITE_SERVICE_REQUEST_LIMITS,
});

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
  directory = await mkdtemp(join(tmpdir(), 'beaksight-write-api-start-'));
  database = openControlDatabase(resolveControlDatabasePath(directory));
  site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true });
  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, targetConfigPath), JSON.stringify(cliTargetConfig(PROFILE_ID, site.appOrigin, SPA_APP_PATHS.admin, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: outputDirectory() },
  })), 'utf8');
  const context: ProfileValidationContext = { targetConfig: await loadConfig(join(directory, targetConfigPath)) };
  const resolveContext = (path: string): ProfileValidationContext | undefined => (path === targetConfigPath ? context : undefined);
  expect(createProfile(database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'TEST',
    mode: 'TEST_APPROVED_WRITE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [site.appOrigin],
    approvedServiceOrigins: [site.backendOrigin],
    environmentEvidenceRef: `evidence/${PROFILE_ID}/isolation-check-1`,
  }, { resolveContext }).ok).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless。
  hideJobBrowser(database, PROFILE_ID);
  expect(saveAuthSetup(database, setupOf(), { resolveContext })).toMatchObject({ ok: true });
  // テストだけの入口: 人の操作の代わりに、標準入力の資格情報をログインの画面に入れて送る（ログイン用の Browser は CLI の起動の設定の headless）。
  const entry = join(build.rootDirectory, `${PROFILE_ID}-${ENTRY_FILE_NAME}`);
  await writeFile(entry, testLoginWorkerEntrySource({
    distPrefix: ENTRY_DIST_PREFIX, loginTimeoutMs: LOGIN_TIMEOUT_MS, prelude: STDIN_CREDENTIALS_PRELUDE, credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
  }), 'utf8');
  const fields: [string, string][] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  const recordingFork: AuditWorkerForker = createRecordingFork({
    entry,
    stdinText: () => JSON.stringify({ fields, submit: SPA_LOGIN_FIELDS.submit }),
    onChild: (child) => {
      children.push(child);
      if (child.pid !== undefined) {
        workerPids.push(child.pid);
      }
    },
    onSent: (message) => sentToWorker.push(message),
    onReceived: (message) => received.push(message),
    onOutput: (chunk) => { workerOutput += chunk; },
  });
  manager = createAuditJobManager({
    database,
    repositoryRoot: directory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext: async (path) => (path === targetConfigPath ? { targetConfig: await loadConfig(join(directory, path)) } : undefined),
    forkWorker: recordingFork,
    now: () => new Date(Date.now() + managerClockOffsetMs),
  });
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())))));
  if (database !== undefined) closeControlDatabase(database);
  await site?.close();
  await build?.remove();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}, SUITE_TIMEOUT_MS);

// SR-1-F（PRE42 の安全の組の独立のレビュー SR-1 の Minor-1。レビュー担当の実験 `scratchpad\sr-1\exp\api-approval.test.ts` の形）: 同じ form のない
// 登録の画面の、別の API のシナリオで、本物のワーカーと Guard を通して確かめる。
// - 承認の期限切れ（許可を出した後に、承認の期限が切れた）と、許可の後の取り消しでは、ジョブを始めず（`START` を 0 回）、読み取りでない要求も届かない。
// - 始めた直後の取り消し（ワーカーのログインの段の間）では、送る直前の確かめ直しで止まり、登録の POST は届かない（ログインの段の token の送信だけ）。
// - 対照（取り消しのない承認）では、登録の POST が 1 回だけ届く。
// 承認の期限切れは、実際に待たず、ジョブの管理の時計（`now`）だけを進めて作る（許可を出すときは、実際の時刻で承認が有効）。期限の近い承認の時刻は
// 過去なので、発見の時刻が後になる下の describe より先に行う（シナリオの準備は、プロファイルの最後の発見より前の時刻を拒む）。
describe('SR-1-F: the approval expiry and the revocations of an API CREATE scenario, through the real worker and Guard', () => {
  const APPROVAL_SCENARIO_ID = 'scenario-api-create-approval';
  const APPROVAL_READ_CHECK_ID = 'rc-api-member-approval';
  /** 許可を出すときの、承認の期限までの残り（ms）。 */
  const APPROVAL_REMAINING_MS = 60_000;
  /** 承認の期限切れを作るために、ジョブの管理の時計を進める量（ms。残りより長く、許可の期限 5 分より短い）。 */
  const EXPIRED_CLOCK_OFFSET_MS = 90_000;

  const startMessageCount = (): number => sentToWorker.filter((message) => (message as { readonly type?: unknown }).type === 'START').length;
  const requestLines = (from: number): readonly string[] => nonReadRequests().slice(from).map(({ method, path }) => `${method} ${path}`);
  const tokenLine = `POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`;
  const revision = (): number => readScenario(database, APPROVAL_SCENARIO_ID)?.revision ?? 0;
  const approve = async (receiptId: string, at: string) => {
    const facts = await externalFacts();
    const status = readScenarioApprovalStatus(database, APPROVAL_SCENARIO_ID, facts, new Date());
    return approveScenario(database, {
      scenarioId: APPROVAL_SCENARIO_ID, expectedRevision: revision(), expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: facts, at,
    });
  };
  const revoke = (receiptId: string) => revokeScenarioApproval(database, {
    scenarioId: APPROVAL_SCENARIO_ID, expectedRevision: revision(), receiptId, at: nowText(),
  });

  it('starts no job after the approval expiry or a revocation, sends no member POST after a revocation just after the start, and one member POST without them', async () => {
    // 発見のジョブの行は、下の describe の発見と別の ID にする（組 Z: `discoverSpaMemberScreens` に ID を渡す。前は文書の `jobId` を後から替えていた）。
    const document = await discoverSpaMemberScreens(site, join(directory, 'discovery-approval'), () => launchHeadlessChromium(), {
      jobId: `${DEFAULT_SPA_DISCOVERY_JOB_ID}-approval`,
    });
    const approvedAt = formatCompactUtcTimestamp(new Date(Date.now() - APPROVAL_TTL_DAYS * DAY_MS + APPROVAL_REMAINING_MS), 'approval time');
    createApiCreateScenario(database, {
      profileId: PROFILE_ID, scenarioId: APPROVAL_SCENARIO_ID, readCheckId: APPROVAL_READ_CHECK_ID, site, document,
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, at: () => approvedAt,
    });
    const startsBefore = startMessageCount();
    const nonReadBefore = nonReadRequests().length;
    const postsBefore = memberPosts().length;

    // 1. 承認の期限切れ: 期限の近い承認で許可を出し、ジョブの管理の時計で期限を過ぎてから始める。
    expect(await approve('receipt-approval-expiring', approvedAt)).toMatchObject({ ok: true });
    expect(await issue('grant-approval-expired', 1, APPROVAL_SCENARIO_ID)).toMatchObject({ ok: true });
    const expiresAtMs = dateOfCompactUtcTimestamp(approvalExpiresAtOf(approvedAt, APPROVAL_TTL_DAYS)).getTime();
    managerClockOffsetMs = EXPIRED_CLOCK_OFFSET_MS;
    try {
      expect(expiresAtMs).toBeLessThan(Date.now() + managerClockOffsetMs);
      expect(readScenarioApprovalStatus(database, APPROVAL_SCENARIO_ID, await externalFacts(), new Date(Date.now() + managerClockOffsetMs))?.validity)
        .toMatchObject({ approved: false, reasons: expect.arrayContaining(['EXPIRED']) });
      expect(await manager.startWriteCreate(startInput('grant-approval-expired', APPROVAL_SCENARIO_ID)))
        .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    } finally {
      managerClockOffsetMs = 0;
    }

    // 2. 許可の後の取り消し: 承認し直して許可を出し、取り消してから始める。
    expect(await approve('receipt-approval-revoked', nowText())).toMatchObject({ ok: true });
    expect(await issue('grant-approval-revoked', 1, APPROVAL_SCENARIO_ID)).toMatchObject({ ok: true });
    expect(revoke('receipt-approval-revocation-1')).toMatchObject({ ok: true });
    expect(await manager.startWriteCreate(startInput('grant-approval-revoked', APPROVAL_SCENARIO_ID)))
      .toMatchObject({ ok: false, reason: 'WRITE_GRANT_REJECTED' });
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(startMessageCount()).toBe(startsBefore);
    expect(requestLines(nonReadBefore)).toEqual([]);

    // 3. 始めた直後の取り消し（ワーカーのログインの段の間）: 送る直前の確かめ直しで止まる。
    expect(await approve('receipt-approval-revoked-at-start', nowText())).toMatchObject({ ok: true });
    expect(await issue('grant-approval-revoked-at-start', 1, APPROVAL_SCENARIO_ID)).toMatchObject({ ok: true });
    site.setMemberSaveResponse('markedRepresentation');
    const revokedAtStart = await manager.startWriteCreate(startInput('grant-approval-revoked-at-start', APPROVAL_SCENARIO_ID));
    expect(revoke('receipt-approval-revocation-2')).toMatchObject({ ok: true });
    if (!revokedAtStart.ok) throw new Error(`the write job did not start: ${JSON.stringify(revokedAtStart)}`);
    const revokedJob = await waitForEnd(revokedAtStart.job.jobId);
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(readWriteResult(database, revokedJob.jobId)).toMatchObject({ submission: 'NOT_SENT', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(memberPosts().length).toBe(postsBefore);
    expect(requestLines(nonReadBefore)).toEqual([tokenLine]);

    // 4. 対照: 取り消しのない承認では、登録が 1 回だけ届く。
    expect(await approve('receipt-approval-control', nowText())).toMatchObject({ ok: true });
    expect(await issue('grant-approval-control', 1, APPROVAL_SCENARIO_ID)).toMatchObject({ ok: true });
    const control = await manager.startWriteCreate(startInput('grant-approval-control', APPROVAL_SCENARIO_ID));
    if (!control.ok) throw new Error(`the write job did not start: ${JSON.stringify(control)}`);
    expect(await waitForEnd(control.job.jobId)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(memberPosts().length).toBe(postsBefore + 1);
    expect(requestLines(nonReadBefore)).toEqual([tokenLine, tokenLine, `POST ${SPA_BACKEND_PATHS.members}`]);
    expect(startMessageCount()).toBe(startsBefore + 2);
  }, TEST_TIMEOUT_MS);
});

describe('T40a・T40b-1: an API CREATE scenario from the formless member screen through the worker write flow', () => {
  it('issues a grant with the reservation and the limits, sends the API START, writes once, records the API row and the 1.1 reports, and leaks nothing', async () => {
    // 発見（本物の流れ）、発見のジョブの行と索引、照合の READ、シナリオ（送る鍵は欄に対応する鍵）、入力の規則（テンプレート）。
    const document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), () => launchHeadlessChromium());
    const attached = createApiCreateScenario(database, {
      profileId: PROFILE_ID, scenarioId: SCENARIO_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      at: nowText,
    });
    const facts = await externalFacts();
    const status = readScenarioApprovalStatus(database, SCENARIO_ID, facts, new Date());
    expect(approveScenario(database, {
      scenarioId: SCENARIO_ID, expectedRevision: attached.scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '',
      receiptId: 'receipt-api-create', external: facts, at: nowText(),
    })).toMatchObject({ ok: true });

    // 許可: 1 回の件数の上限を超える件数は拒む。API の登録には許可が出る（予約は RESERVED）。開いた許可があるうちは、次の許可を拒む。
    expect(await issue('grant-over', 2)).toMatchObject({ ok: false });
    const first = await issue('grant-api-1');
    expect(first).toMatchObject({ ok: true, grant: { reservation: { state: 'RESERVED', count: 1 } } });
    expect(await issue('grant-api-2')).toMatchObject({ ok: false, reason: 'GRANT_ALREADY_OPEN' });

    // 開始: 同じ許可で同時に 2 回始めると、1 つだけ始まる。親は API の書き込みの指定を `START` に入れる。
    site.setMemberSaveResponse('markedRepresentation');
    const writesBefore = nonReadRequests().length;
    const membersBefore = site.memberCount;
    // SR-1-F: 上の describe（承認の期限切れと取り消し）のジョブの IPC と登録は数えない。
    const sentBefore = sentToWorker.length;
    const receivedBefore = received.length;
    const postsBefore = memberPosts().length;
    const requestsBefore = site.requests.length;
    const starts = await Promise.all([manager.startWriteCreate(startInput('grant-api-1')), manager.startWriteCreate(startInput('grant-api-1'))]);
    expect(starts.filter((started) => started.ok)).toHaveLength(1);
    const started = starts.find((value) => value.ok);
    if (started === undefined || !started.ok) throw new Error(`the write job did not start: ${JSON.stringify(starts)}`);
    const ended = await waitForEnd(started.job.jobId);
    expect(ended).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', resultRunStatus: 'COMPLETE' });

    const startMessages = sentToWorker.slice(sentBefore).filter((message) => (message as { readonly type?: unknown }).type === 'START') as Record<string, unknown>[];
    expect(startMessages).toHaveLength(1);
    const write = startMessages[0]?.['write'] as Record<string, unknown>;
    const scenario = readScenario(database, SCENARIO_ID)?.current;
    expect(write).toMatchObject({
      transport: 'API',
      scenarioId: SCENARIO_ID,
      grantId: 'grant-api-1',
      formPage: { origin: site.appOrigin, path: SPA_APP_PATHS.memberNew },
      candidate: { identityDigest: scenario?.candidate.identityDigest },
      submitterIdentityDigest: scenario?.candidate.identityDigest,
      api: scenario?.api,
      verification: { successCondition: null, inputErrorCondition: null, recordId: null },
      readVerification: {
        readCheckId: READ_CHECK_ID,
        targetPage: { origin: site.appOrigin, path: API_WRITE_READ_TEMPLATE_PATH },
        definition: { targetPagePath: API_WRITE_READ_TEMPLATE_PATH, parameters: {} },
      },
    });
    expect(Object.keys(write['values'] as object).sort()).toEqual([...(scenario?.fieldNames ?? [])].sort());
    expect((startMessages[0]?.['authentication'] as Record<string, unknown>)['approvedServiceOrigins']).toEqual([site.backendOrigin]);

    // ワーカーはログインし、送信の報告（SENT）を 1 回送って終わる。
    const messages = received.slice(receivedBefore).flatMap((message) => {
      const value = validateWorkerToParentMessage(message);
      return value.ok ? [value.message] : [];
    }) as WorkerToParentMessage[];
    expect(messages.length).toBe(received.length - receivedBefore);
    expect(messages.filter(({ type }) => type === 'WRITE_SUBMISSION').map((message) => (message.type === 'WRITE_SUBMISSION'
      ? `${message.submission} ${String(message.blockReason)}` : ''))).toEqual(['SENT null']);
    expect(messages.some(({ type }) => type === 'FAILED')).toBe(false);

    // サーバに届いた登録は 1 回。台帳は API の行（送り方と型の要約）と応答の本文の ID、予約は COMMITTED。
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(memberPosts().length).toBe(postsBefore + 1);
    // 読み取りでない要求は、ログインの段の token の送信 1 回と、承認した登録 1 回だけ。
    expect(nonReadRequests().slice(writesBefore).map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`,
      `POST ${SPA_BACKEND_PATHS.members}`,
    ]);
    expect(site.memberCount).toBe(membersBefore + 1);
    const result = readWriteResult(database, ended.jobId);
    expect(result).toMatchObject({
      submission: 'SENT', blockReason: null, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', httpStatus: 201,
      transport: 'API',
      api: { shapeDigest: scenario?.api?.shapeDigest, method: 'POST', origin: site.backendOrigin, pathShape: scenario?.api?.request.pathShape },
    });
    expect(result?.recordId).toMatch(/^[0-9]+$/u);
    // T40b-2: `{id}` に ID を入れた会員の詳細の画面を、1 回だけ読んだ（ほかの詳細の画面は読まない）。
    expect(site.requests.slice(requestsBefore).filter((request) => request.origin === 'app' && request.method === 'GET'
      && /^\/admin\/members\/[^/]+$/u.test(request.path) && request.path !== SPA_APP_PATHS.memberNew).map(({ path }) => path))
      .toEqual([`/admin/members/${result?.recordId ?? ''}`]);
    expect(readExecutionGrant(database, 'grant-api-1')).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'COMMITTED' } });

    // 記録と報告は 1.1 の API の形（成否の条件なし、API の要約、送った値は鍵ごとの生成した値、送信先は API の path）。
    if (ended.runDirectory === null) throw new Error('the job has no Run directory');
    const runDirectory = join(outputDirectory(), ended.runDirectory);
    const actionRun = JSON.parse(readFileSync(artifactFilePath(runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
    expect(await validateArtifact('action-run', actionRun)).toEqual({ ok: true });
    if (scenario?.api === undefined) throw new Error('the scenario has no API specification');
    expect(actionRun).toMatchObject({
      schemaVersion: 'action-run-schema/1.1', transport: 'API', resultConditions: null, api: actionApiSummaryOf(scenario.api, {}),
      submittedValues: write['values'], recordId: result?.recordId,
      readVerification: { readCheckId: READ_CHECK_ID, result: 'MATCHED' }, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
    });
    const evidence = JSON.parse(readFileSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as Record<string, unknown>;
    expect(await validateArtifact('action-evidence', evidence)).toEqual({ ok: true });
    expect(evidence).toMatchObject({
      transport: 'API', api: actionRun.api, submission: { state: 'SENT', actionPath: scenario.api.request.pathShape },
      readVerification: { state: 'EXECUTED', result: 'MATCHED', url: `${site.appOrigin}/admin/members/${result?.recordId ?? ''}` },
    });

    // 二重の登録 0・上限の超過 0: 消費した許可では始まらない。書き込みの後は、5 分の間隔で次の許可を拒む。登録は 1 回のまま。
    expect(await manager.startWriteCreate(startInput('grant-api-1'))).toMatchObject({ ok: false });
    expect(await issue('grant-api-3')).toMatchObject({ ok: false, reason: 'GRANT_WRITE_INTERVAL_NOT_ELAPSED' });
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(memberPosts().length).toBe(postsBefore + 1);

    // 秘密の目印（fixture の秘密、応答の本文の目印、probe の目印）は、IPC・管理データのファイル・成果物・ワーカーの出力に出ない。process が残らない。
    const places: (readonly [string, Buffer])[] = [
      ...databaseFilePlaces(resolveControlDatabasePath(directory)),
      ...filesUnder(outputDirectory()),
      ['ipc sent', Buffer.from(JSON.stringify(sentToWorker), 'utf8')],
      ['ipc received', Buffer.from(JSON.stringify(received), 'utf8')],
      ['worker output', Buffer.from(workerOutput, 'utf8')],
    ];
    expect(placesWithMarkers(places, [...site.secretValues(), site.memberSaveResponseMarker(), MARKER_PREFIX])).toEqual([]);
    const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
    for (;;) {
      const processes = await listProcesses();
      const left = workerPids.flatMap((pid) => descendantsOf(pid, processes));
      if (children.every((child) => child.exitCode !== null || child.signalCode !== null) && left.length === 0) break;
      if (Date.now() > deadline) throw new Error(`processes left: ${JSON.stringify(left)}`);
      await sleep(WAIT_POLL_MS);
    }
    expect(existsSync(resolveControlDatabasePath(directory))).toBe(true);
  }, TEST_TIMEOUT_MS);
});
