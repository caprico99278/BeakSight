// T41d-2（Task 41 の設計書 3.2・3.4、5 章）: fixture の form のない会員の画面（`memberScreenLayout: 'formless'`）で、発見 → API の登録のシナリオと API の
// 更新のシナリオ → 承認 → 登録のジョブ（台帳に照合済みの行）→ 更新の許可（その行が対象）→ 更新のジョブの開始 → ワーカーに `START`（送り方 API の
// UPDATE）→ ワーカーの API の更新の流れ → 親の締め、までを、ジョブの管理（`createAuditJobManager`）と本物のワーカー（`child_process.fork`。一時の
// ビルドの本番の process の組み立てを、ログインの段の口だけ替えたテストだけの入口）で確かめる。形は `write-job-api-start.test.ts` と同じ。
// - 発見の前に会員を 1 人足す（更新の画面 `/admin/members/{id}/edit` を発見で見るため）。台帳の対象は、登録のジョブが作った会員（照合済みの最新の 1 件）。
// - 更新: 台帳の UPDATE の行は `VERIFIED`（`READ_VERIFICATION_MATCHED`）で `update_evidence`（変えた欄は名前、保つ欄はメールアドレスと備考、どれも一致）を
//   持ち、予約は `COMMITTED`、報告の確かめは `VALID`。サーバの記録でも、変えた欄だけが変わる。
// - サーバに届いた読み取りでない要求は、ジョブごとに、ログインの段の token の送信 1 回と、承認した書き込み 1 回（登録は POST、更新は PATCH）だけ。
//   同じ許可で同時に 2 回始めると 1 つだけ始まり、消費した許可では始まらない（PATCH は 1 回のまま）。
// - 秘密の目印は、IPC・管理データのファイル（WAL を含む）・成果物・ワーカーの出力に出ない。保つ欄の値（対象のメールアドレス）は、更新の Run の成果物に
//   出ない。T41R3-fix（設計書 8 章の「T41R3」）: 更新の `START` は、台帳が知る保つ鍵の値（`update.knownKeptValues`。BeakSight が作ったテストの値で、
//   `values` と同じ扱い）を持つ。process が残らない。
// - ワーカーの Browser は本番の起動の設定（CLI の Chromium）。テストの既定の headless との両方での安全の数は、同じ process の中の流れの結合
//   （`api-write-update-run.test.ts`）が確かめる。
import type { ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { readWriteResult } from '../../src/control/actions/write-result-facts.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  approveScenario,
  issueExecutionGrant,
  readExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
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
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  API_WRITE_FIXTURE_SESSION_KEY,
  API_WRITE_SERVICE_REQUEST_LIMITS,
  createApiCreateScenario,
  createApiUpdateScenario,
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
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 400_000;
const WAIT_LIMIT_MS = 180_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 30_000;
/** ログインを待つ時間（ms。テストの口が入力する）。 */
const LOGIN_TIMEOUT_MS = 60_000;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
const PROFILE_ID = 'example-t41d2';
const CREATE_ID = 'scenario-api-create-t41d2';
const UPDATE_ID = 'scenario-api-update-t41d2';
const READ_CHECK_ID = 'rc-api-member-t41d2';
const MARKER_PREFIX = 'bsprobe';
const EXISTING_NAME = '既存 会員';
const OUTPUT_DIRECTORY_NAME = 'api-update-output';
const ENTRY_FILE_NAME = 'api-update-worker-test-entry.mjs';
const ENTRY_DIST_PREFIX = './dist/';

let build: TemporaryBuild;
let site: SpaAuthSite;
let directory = '';
let database: ControlDatabase;
let manager: AuditJobManager;
/** 発見の前に足した会員の ID（更新の画面を発見で見るため）。 */
let existingId = 0;
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

const revisionOf = (scenarioId: string): number => readScenario(database, scenarioId)?.revision ?? 0;

const approve = async (scenarioId: string, receiptId: string): Promise<void> => {
  const facts = await externalFacts();
  const status = readScenarioApprovalStatus(database, scenarioId, facts, new Date());
  expect(approveScenario(database, {
    scenarioId, expectedRevision: revisionOf(scenarioId), expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: facts, at: nowText(),
  })).toMatchObject({ ok: true });
};

const issue = async (scenarioId: string, grantId: string, expectedTargetRecordId?: string) => issueExecutionGrant(database, {
  scenarioId, expectedRevision: revisionOf(scenarioId), grantId, jobId: `job-${grantId}`, count: 1, external: await externalFacts(), at: nowText(),
  ...(expectedTargetRecordId === undefined ? {} : { expectedTargetRecordId }),
});

const startInput = (scenarioId: string, grantId: string) => ({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, scenarioId, grantId });

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

/** サーバに届いた読み取りでない要求（preflight を含む）を、method と query のない path で並べる。 */
const nonReadRequests = (): string[] => site.requests
  .filter((request) => request.preflight || !READ_METHODS.has(request.method))
  .map(({ method, path, preflight }) => `${preflight ? 'PREFLIGHT ' : ''}${method} ${path.split('?')[0] ?? ''}`);
/** サーバに届いた会員の更新（バックエンドの members への PATCH）。 */
const memberPatches = (): number => site.requests.filter((request) => request.origin === 'backend' && request.method === 'PATCH'
  && request.path.startsWith(SPA_BACKEND_PATHS.members)).length;

/** 版 3 のスクリプトで送るログインの認証の設定（`write-job-api-start.test.ts` と同じ）。 */
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
  directory = await mkdtemp(join(tmpdir(), 'beaksight-write-api-update-'));
  database = openControlDatabase(resolveControlDatabasePath(directory));
  site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true });
  existingId = site.addMember(EXISTING_NAME);
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

describe('T41d-2: an API UPDATE from the ledger row through the worker update flow and the settlement of the parent', () => {
  it('updates the verified registration once, records the VERIFIED UPDATE row with the evidence, commits the reservation, and leaks nothing', async () => {
    // 発見（本物の流れ）、照合の READ、API の登録と更新のシナリオ（入力の規則はテンプレート）、承認。
    const document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), () => launchHeadlessChromium());
    createApiCreateScenario(database, {
      profileId: PROFILE_ID, scenarioId: CREATE_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      at: nowText,
    });
    createApiUpdateScenario(database, {
      profileId: PROFILE_ID, scenarioId: UPDATE_ID, ledgerScenarioId: CREATE_ID, document, updatePagePath: spaMemberEditPathOf(existingId), at: nowText,
      readCheckId: READ_CHECK_ID,
    });
    await approve(CREATE_ID, 'receipt-api-create');
    await approve(UPDATE_ID, 'receipt-api-update');
    // 台帳がまだ空なので、更新の予定の対象はない。
    expect(readPlannedUpdateTarget(database, UPDATE_ID)).toBeNull();

    // 登録のジョブ（台帳に照合済みの行を作る）。
    const writesAtStart = nonReadRequests().length;
    expect(await issue(CREATE_ID, 'grant-c1')).toMatchObject({ ok: true });
    const createStarted = await manager.startWriteCreate(startInput(CREATE_ID, 'grant-c1'));
    if (!createStarted.ok) throw new Error(`the create job did not start: ${JSON.stringify(createStarted)}`);
    const createEnded = await waitForEnd(createStarted.job.jobId);
    expect(createEnded).toMatchObject({ jobKind: 'WRITE_CREATE', state: 'FINISHED', resultRunStatus: 'COMPLETE', writeReportCheck: 'VALID' });
    const created = readWriteResult(database, createEnded.jobId);
    expect(created).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reservationState: 'COMMITTED', transport: 'API' });
    const targetRecordId = created?.recordId ?? '';
    expect(targetRecordId).toMatch(/^[0-9]+$/u);
    expect(targetRecordId).not.toBe(String(existingId));
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(nonReadRequests().slice(writesAtStart)).toEqual([`POST ${SPA_BACKEND_PATHS.token}`, `POST ${SPA_BACKEND_PATHS.members}`]);

    // 更新の許可: 台帳の照合済みの最新の 1 件（登録のジョブが作った会員）が対象。予約は RESERVED。
    expect(readPlannedUpdateTarget(database, UPDATE_ID)).toBe(targetRecordId);
    expect(await issue(UPDATE_ID, 'grant-u1', targetRecordId)).toMatchObject({
      ok: true, grant: { targetRecordId, reservation: { state: 'RESERVED', count: 1 } },
    });
    const before = site.memberOf(Number(targetRecordId));
    if (before === undefined) throw new Error('the registered member is missing');
    expect(before.email.length).toBeGreaterThan(0);
    const existingBefore = site.memberOf(existingId);

    // 更新のジョブ: 同じ許可で同時に 2 回始めると、1 つだけ始まる。
    const writesBeforeUpdate = nonReadRequests().length;
    const startsBefore = sentToWorker.length;
    const starts = await Promise.all([
      manager.startWriteUpdate(startInput(UPDATE_ID, 'grant-u1')),
      manager.startWriteUpdate(startInput(UPDATE_ID, 'grant-u1')),
    ]);
    expect(starts.filter((started) => started.ok)).toHaveLength(1);
    const started = starts.find((value) => value.ok);
    if (started === undefined || !started.ok) throw new Error(`the update job did not start: ${JSON.stringify(starts)}`);
    const ended = await waitForEnd(started.job.jobId);
    expect(ended).toMatchObject({ jobKind: 'WRITE_UPDATE', state: 'FINISHED', resultRunStatus: 'COMPLETE', writeReportCheck: 'VALID' });

    // `START`: API の UPDATE（対象の ID、変える鍵だけの値）。T41R3-fix: 保つ欄の値は、台帳が知る値（`knownKeptValues`）だけを持つ。
    const updateStarts = sentToWorker.slice(startsBefore).filter((message) => (message as { readonly type?: unknown }).type === 'START') as Record<string, unknown>[];
    expect(updateStarts).toHaveLength(1);
    const write = updateStarts[0]?.['write'] as Record<string, unknown>;
    expect(updateStarts[0]).toMatchObject({ jobKind: 'WRITE_UPDATE' });
    expect(write).toMatchObject({
      transport: 'API', scenarioId: UPDATE_ID, grantId: 'grant-u1', update: { targetRecordId },
      formPage: { origin: site.appOrigin, path: spaMemberEditPathOf(Number(targetRecordId)) },
    });
    const newName = (write['values'] as Record<string, unknown>)['name'];
    expect(Object.keys(write['values'] as object)).toEqual(['name']);
    expect((write['update'] as { readonly knownKeptValues: unknown }).knownKeptValues).toEqual(expect.arrayContaining([{ key: 'email', value: before.email }]));

    // サーバ: 届いた読み取りでない要求は、ログインの token 1 回と PATCH 1 回だけ。変えた欄だけが変わり、ほかの会員は変わらない。
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(nonReadRequests().slice(writesBeforeUpdate)).toEqual([`POST ${SPA_BACKEND_PATHS.token}`, `PATCH ${SPA_BACKEND_PATHS.members}`]);
    expect(memberPatches()).toBe(1);
    expect(site.memberOf(Number(targetRecordId))).toEqual({ ...before, name: newName });
    expect(site.memberOf(existingId)).toEqual(existingBefore);

    // 台帳: UPDATE の行は VERIFIED で、更新の後の照合の証拠を持つ。予約は COMMITTED。許可は消費した。
    const result = readWriteResult(database, ended.jobId);
    expect(result).toMatchObject({
      submission: 'SENT', blockReason: null, responseJudgement: 'SUCCESS', recordId: targetRecordId, targetRecordId, result: 'VERIFIED',
      reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', transport: 'API',
    });
    expect(result?.updateEvidence?.fields.map(({ fieldName, role, matched }) => [fieldName, role, matched])).toEqual([
      ['name', 'CHANGED', true], ['email', 'KEPT', true], ['note', 'KEPT', true],
    ]);
    expect(readExecutionGrant(database, 'grant-u1')).toMatchObject({ consumedAt: expect.any(String), reservation: { state: 'COMMITTED' } });

    // 二重の更新 0: 消費した許可では始まらない。PATCH は 1 回のまま。
    expect(await manager.startWriteUpdate(startInput(UPDATE_ID, 'grant-u1'))).toMatchObject({ ok: false });
    await sleep(LATE_REQUEST_WAIT_MS);
    expect(memberPatches()).toBe(1);

    // 秘密の目印は、IPC・管理データのファイル・成果物・ワーカーの出力に出ない。保つ欄の値（メールアドレス）は、更新の Run の成果物に出ない。
    const places: (readonly [string, Buffer])[] = [
      ...databaseFilePlaces(resolveControlDatabasePath(directory)),
      ...filesUnder(outputDirectory()),
      ['ipc sent', Buffer.from(JSON.stringify(sentToWorker), 'utf8')],
      ['ipc received', Buffer.from(JSON.stringify(received), 'utf8')],
      ['worker output', Buffer.from(workerOutput, 'utf8')],
    ];
    expect(placesWithMarkers(places, [...site.secretValues(), MARKER_PREFIX])).toEqual([]);
    if (ended.runDirectory === null) throw new Error('the update job has no Run directory');
    const updateRunDirectory = join(outputDirectory(), ended.runDirectory);
    expect(readdirSync(updateRunDirectory).length).toBeGreaterThan(0);
    expect(placesWithMarkers(filesUnder(updateRunDirectory), [before.email])).toEqual([]);
    const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
    for (;;) {
      const processes = await listProcesses();
      const left = workerPids.flatMap((pid) => descendantsOf(pid, processes));
      if (children.every((child) => child.exitCode !== null || child.signalCode !== null) && left.length === 0) break;
      if (Date.now() > deadline) throw new Error(`processes left: ${JSON.stringify(left)}`);
      await sleep(WAIT_POLL_MS);
    }
  }, TEST_TIMEOUT_MS);
});
