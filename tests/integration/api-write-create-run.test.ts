// T40b-1（Task 40 の設計書 3.3、4 章、5 章の 1・3・4）: ワーカーの API の登録の書き込みの流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun`
// に、送り方 API の書き込みの指定を渡す）を、同じ process の中で、本物の Chromium（テストの既定の headless と、CLI の起動の設定の両方）と 127.0.0.1 の
// fixture（`startSpaAuthSite` の form のない会員の画面）で確かめる結合テスト。ログインの段は通さず、fixture が出したセッションを認証つきの Run の指定で
// 渡す。IPC の 2 つの口（確かめ直し、送信の報告）は、テストが偽の親として受ける。
// - 書き込みの指定は、本番の親の部品（`writeStartSpecOf`）が、本物の発見の成果物から作った API のシナリオで作る（API の指定と digest を手で書かない）。
// - 正常: サーバに届いた登録は 1 回、応答の本文から ID が取れ、`action-run.json`・`action-evidence.json` は 1.1 の API の形。T40b-2: `{id}` に ID を入れた
//   会員の詳細の画面を 1 回だけ読み、照合が一致して `VERIFIED`（`READ_VERIFICATION_MATCHED`）。
// - T40b-2 の照合の READ: 一致しない画面（`UNKNOWN`・`READ_VERIFICATION_NOT_MATCHED`）、照合の画面の 500 と、サービスの Origin が断った読み取り
//   （`PARTIAL`・`READ_VERIFICATION_UNDETERMINED`）、取れた ID が危険な語・読まないパスに当たる path になる（画面を読まずに `READ_BLOCKED_BY_POLICY`。
//   その画面への GET は 0 回）。ID がなければ照合の READ を行わない（実行しなかった印。詳細の画面への GET は 0 回）。
// - 成功と偽らない: ID のない 2xx（`PARTIAL`・`RECORD_ID_NOT_FOUND`）、400（`FAILED`・`INPUT_ERROR`）、429（`FAILED`・`RATE_LIMITED`）、503（`UNKNOWN`・
//   `SERVER_ERROR`）、応答なし（`UNKNOWN`・`NO_RESPONSE`）、100〜599 の外の状態（`UNKNOWN`、状態と判定は null）。届いた登録は 1 回以下。
// - 送らない: ページが照合に合わない本文を送る（`softDeleteKey`。`PAYLOAD_MISMATCH`）、送る前の確かめで送信の要素が見つからない（`PRECHECK_FAILED`）。
//   届いた登録は 0 回。
// - 秘密の目印（fixture の資格情報・API の鍵・発行した token、応答の本文の目印）は、成果物（ZIP の中身を含む）に出ない。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { actionApiSummaryOf } from '../../src/control/actions/action-api-summary.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { readScenarioRevisions } from '../../src/control/approval/scenario-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { listReadChecks } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { isWorkerStartApiWrite, type WorkerStartApiWrite } from '../../src/control/worker-protocol.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { executeWriteCreateRun, type WriteCreateRunOutcome } from '../../src/worker/write-create-run.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import {
  API_WRITE_READ_TEMPLATE_PATH,
  createApiCreateScenario,
  discoverSpaMemberScreens,
  spaApiWriteConfigOf,
  spaRunAuthenticationOf,
} from '../helpers/api-write-scenario.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_OUT_OF_RANGE_STATUS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaMemberSaveResponse,
} from '../helpers/spa-auth-site-fixture.js';
import { readWriteReportFiles } from '../helpers/write-report-checks.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 押した後に結果を待つ上限（ms）。 */
const RESULT_TIMEOUT_MS = 5_000;
/** 全部の場面の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
const PROFILE_ID = 'example-t40b';
const SCENARIO_ID = 'scenario-api-create-direct';
const READ_CHECK_ID = 'rc-api-direct';
const GRANT_ID = 'grant-direct';
const SHA256_HEX_LENGTH = 64;
/** どの送信の要素にも当たらない識別の digest。 */
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
const ALLOWED = Object.freeze({ allowed: true });
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');
/** 鍵ごとの値（場面ごとに別の値。メールアドレスの鍵はメールアドレスの形）。 */
const valuesFor = (keys: readonly string[], index: number): Record<string, string> =>
  Object.fromEntries(keys.map((key) => [key, key === 'email' ? `t40b-${String(index)}@example.invalid` : `T40b ${key} ${String(index)}`]));
let site: SpaAuthSite;
let directory = '';
let database: ControlDatabase;
/** 本番の親の部品が作る、API の登録の書き込みの指定（場面の番号ごとの値と、その値で作った照合の READ の期待）。 */
let writeFor: (index: number) => WorkerStartApiWrite = () => {
  throw new Error('the scenario is not prepared');
};
let caseNumber = 0;

/** 届いた登録（バックエンドの members への POST）。 */
const memberPosts = (): readonly string[] => site.requests
  .filter((request) => request.origin === 'backend' && request.method === 'POST' && request.path.startsWith(SPA_BACKEND_PATHS.members))
  .map((request) => request.path);
/** T40b-2: 届いた、会員の詳細の画面（`{id}` の画面）への GET（`since` 番目の記録から。`id` を渡せば、その ID の画面だけ）。 */
const detailPageReads = (since: number, id?: string): readonly string[] => site.requests.slice(since)
  .filter((request) => request.origin === 'app' && request.method === 'GET'
    && (id === undefined ? /^\/admin\/members\/[^/]+$/u.test(request.path) && request.path !== SPA_APP_PATHS.memberNew : request.path === `/admin/members/${id}`))
  .map((request) => request.path);
/** 届いた読み取りでない要求（事前確認を含む）。 */
const nonReads = (): number => site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method)).length;

beforeAll(async () => {
  site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true });
  directory = await mkdtemp(join(tmpdir(), 'beaksight-api-write-run-'));
  database = openControlDatabase(resolveControlDatabasePath(directory));
  const targetConfigPath = `local/targets/${PROFILE_ID}.json`;
  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, targetConfigPath), JSON.stringify(cliTargetConfig(PROFILE_ID, site.appOrigin, SPA_APP_PATHS.admin, {
    audit: { screenshots: false }, output: { directory: join(directory, 'unused-output') },
  })), 'utf8');
  const context: ProfileValidationContext = { targetConfig: await loadConfig(join(directory, targetConfigPath)) };
  const resolveContext = (path: string): ProfileValidationContext | undefined => (path === targetConfigPath ? context : undefined);
  expect(createProfile(database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION, profileId: PROFILE_ID, revision: MIN_PROFILE_REVISION, targetConfigPath, environment: 'TEST',
    mode: 'TEST_APPROVED_WRITE', auth: 'MANUAL_SESSION', approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: [site.backendOrigin],
    environmentEvidenceRef: `evidence/${PROFILE_ID}/isolation-check-1`,
  }, { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, {
    ...FORM_NAVIGATION_SETUP_ITEMS, profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION,
    loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }],
    successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: null }, sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
    excludedPaths: [SPA_APP_PATHS.logout], auditPathPrefixes: [SPA_APP_PATHS.admin], maxLoginAttempts: 2, allowedIdpOrigins: [], automatedLogin: null,
  }, { resolveContext })).toMatchObject({ ok: true });
  const document = await discoverSpaMemberScreens(site, join(directory, 'discovery'), () => launchHeadlessChromium());
  const created = createApiCreateScenario(database, {
    profileId: PROFILE_ID, scenarioId: SCENARIO_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    at: nowText,
  });
  const revision = readScenarioRevisions(database, SCENARIO_ID).find(({ revision: value }) => value === created.scenario.revision);
  const readCheck = listReadChecks(database, PROFILE_ID).find(({ readCheckId }) => readCheckId === READ_CHECK_ID);
  if (revision === undefined || readCheck === undefined) throw new Error('the scenario revision or the READ check is missing');
  // T40b-2: 場面ごとの値で、照合の READ の期待（生成した値で作る）も作り直す（本番の親の部品で作る）。
  writeFor = (index: number): WorkerStartApiWrite => {
    const spec = writeStartSpecOf({
      scenario: revision.scenario, evidence: revision.evidence, grantId: GRANT_ID, values: valuesFor(revision.scenario.fieldNames, index), readCheck,
      targetPage: { origin: site.appOrigin, path: API_WRITE_READ_TEMPLATE_PATH }, profileId: PROFILE_ID,
      seedRecord: {
        seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
        seedInput: { profileId: PROFILE_ID, scenarioId: SCENARIO_ID, scenarioRevision: revision.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
          executionGrantId: GRANT_ID },
        baseDate: '2026-10-17',
        attempt: 0,
      },
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: SCENARIO_ID, scenarioRevision: revision.revision, grantId: GRANT_ID }),
    });
    if (spec === null || !isWorkerStartApiWrite(spec)) throw new Error('the API write specification was not built');
    return spec;
  };
  writeFor(0);
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (database !== undefined) closeControlDatabase(database);
  await site?.close();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}, SUITE_TIMEOUT_MS);

describe.each(LAUNCHERS)('T40b-1: the API create write flow with %s', (label, launch) => {
  /** これまでの場面で、サーバに届いてよいと確かめた登録の数。 */
  let expectedPosts = 0;
  let postsBefore = 0;
  let nonReadsBefore = 0;

  beforeAll(() => {
    postsBefore = memberPosts().length;
    nonReadsBefore = nonReads();
  });

  afterEach(() => {
    site.setMemberSaveResponse(null);
    site.setHostileMemberSave(null);
    site.setMemberSaveRecordId(null);
    site.setMemberDetailResponse(null);
    site.setMemberSaveOnInput(false);
    site.setMemberSaveAborted(false);
    expect(memberPosts().length - postsBefore, 'member POSTs that reached the server').toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore, 'non-read requests that reached the server').toBe(expectedPosts);
  });

  afterAll(async () => {
    // 遅れて届く要求を待って数え直す。
    await sleep(LATE_DELIVERY_SETTLE_MS);
    expect(memberPosts().length - postsBefore).toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore).toBe(expectedPosts);
  }, TEST_TIMEOUT_MS);

  interface Run {
    readonly outcome: WriteCreateRunOutcome;
    readonly document: ActionRunDocument;
    readonly documentText: string;
    readonly runDirectory: string;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    readonly write: WorkerStartApiWrite;
    /** T40b-2: 書き込みの流れを始める前の、サーバの記録の位置。 */
    readonly since: number;
    /** T40b-2: `action-evidence.json` の中身。 */
    readonly evidence: Record<string, unknown>;
  }

  /** 場面の指定（書き込みの指定の替え方、読まないパスに足す path）。 */
  interface RunOptions {
    readonly change?: (write: WorkerStartApiWrite) => WorkerStartApiWrite;
    readonly extraExcludedPathPrefixes?: readonly string[];
    /** T40R-fix-A: 押す直前の確かめ直しの答え（省略は許す）。 */
    readonly recheck?: () => Promise<WorkerWriteRecheckOutcome>;
  }

  /** 書き込みの流れを 1 回動かし、`action-run.json` を読んで、スキーマと報告の 2 つの JSON と目印を確かめる。 */
  const runWrite = async (response: SpaMemberSaveResponse | null, options: RunOptions = {}): Promise<Run> => {
    caseNumber += 1;
    site.setMemberSaveResponse(response);
    const since = site.requests.length;
    const write = (options.change ?? ((value: WorkerStartApiWrite) => value))(writeFor(caseNumber));
    const reports: WorkerWriteSubmissionReport[] = [];
    const outputDirectory = join(directory, `output-${String(caseNumber)}`);
    const outcome = await executeWriteCreateRun({
      config: spaApiWriteConfigOf(site, outputDirectory, { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS } }),
      jobId: `job-api-${String(caseNumber)}`,
      authentication: spaRunAuthenticationOf(site, options.extraExcludedPathPrefixes),
      write,
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      recheck: options.recheck ?? (() => Promise.resolve(ALLOWED)),
      reportSubmission: (report) => reports.push(report),
      resultTimeoutMs: RESULT_TIMEOUT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
    const documentText = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
    const document = JSON.parse(documentText) as ActionRunDocument;
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
    const markers = [...site.secretValues(), site.memberSaveResponseMarker()];
    for (const marker of markers) {
      expect(documentText).not.toContain(marker);
    }
    await readWriteReportFiles(outcome.runDirectory, document, { markers, approvalFacts: write.approvalFacts });
    // 送信の報告は 1 回で、成果物と同じ。
    expect(reports).toEqual([{ submission: document.submission, blockReason: document.blockReason }]);
    const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, 'action-evidence.json'), 'utf8')) as Record<string, unknown>;
    return { outcome, document, documentText, runDirectory: outcome.runDirectory, reports, write, since, evidence };
  };

  it(`sends the approved create once, takes the record id from the response body, reads the {id} page once, and verifies (${label})`, async () => {
    const membersBefore = site.memberCount;
    const run = await runWrite('markedRepresentation');
    expectedPosts += 1;
    expect(site.memberCount).toBe(membersBefore + 1);
    expect(run.document).toMatchObject({
      schemaVersion: 'action-run-schema/1.1', transport: 'API', resultConditions: null, submission: 'SENT', blockReason: null, httpStatus: 201,
      responseJudgement: 'SUCCESS', readVerification: { readCheckId: READ_CHECK_ID, result: 'MATCHED' }, reservationState: 'COMMITTED',
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', submittedValues: run.write.values,
    });
    expect(run.document.recordId).toMatch(/^[0-9]+$/u);
    const recordId = run.document.recordId ?? '';
    const created = site.memberOf(Number(recordId));
    expect(created?.email).toBe(run.write.values['email']);
    expect(run.document.api).toEqual(actionApiSummaryOf(run.write.api, {}));
    expect(run.evidence).toMatchObject({
      transport: 'API', api: run.document.api, precheck: { candidateDigestMatched: true, blockReason: null },
      submission: { state: 'SENT', actionPath: run.write.api.request.pathShape },
      readVerification: { state: 'EXECUTED', result: 'MATCHED', detail: 'EXPECTATIONS_EVALUATED', url: `${site.appOrigin}/admin/members/${recordId}` },
    });
    // `{id}` の画面は 1 回だけ読む（ほかの詳細の画面は読まない）。
    expect(detailPageReads(run.since)).toEqual([`/admin/members/${recordId}`]);
    // サーバに届いた登録は、有効な Bearer と、承認した鍵の本文を持つ。
    const posted = site.requests.filter((request) => request.origin === 'backend' && request.method === 'POST').at(-1);
    expect(posted?.bearerValid).toBe(true);
    expect(posted?.bodyKeys).toEqual([...run.write.api.keyFields.map(({ key }) => key), ...run.write.api.pageKeys.map(({ key }) => key)].sort());
    expect(run.outcome).toMatchObject({ runStatus: 'COMPLETE', result: 'VERIFIED' });
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a page that does not match', 'mismatch', 'NOT_MATCHED', { result: 'UNKNOWN', reason: 'READ_VERIFICATION_NOT_MATCHED' }],
    ['a page that answers 500', 'serverError', 'UNDETERMINED', { result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED' }],
    ['a page whose service read is refused', 'unauthorizedRead', 'UNDETERMINED', { result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED' }],
  ] as const)(`does not claim a success for %s in the verification READ (${label})`, async (_name, detailResponse, readResult, expected) => {
    site.setMemberDetailResponse(detailResponse);
    const run = await runWrite('markedRepresentation');
    expectedPosts += 1;
    const recordId = run.document.recordId ?? '';
    expect(recordId).toMatch(/^[0-9]+$/u);
    expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', readVerification: { result: readResult }, ...expected });
    expect(run.evidence).toMatchObject({ readVerification: { state: 'EXECUTED', result: readResult } });
    expect(detailPageReads(run.since)).toEqual([`/admin/members/${recordId}`]);
    expect(run.outcome).toMatchObject({ runStatus: 'PARTIAL' });
  }, TEST_TIMEOUT_MS);

  it.each([
    ['has a dangerous word', (index: number): string => `delete-${String(index)}`, [] as readonly string[]],
    ['falls under an excluded path', (index: number): string => `x-hidden-${String(index)}`, ['/admin/members/x-hidden'] as readonly string[]],
  ])(`does not read the {id} page when the path of the record id %s: blocked by the policy, no GET (${label})`, async (_name, idOf, excluded) => {
    const recordId = idOf(caseNumber + 1);
    site.setMemberSaveRecordId(recordId);
    const run = await runWrite('markedRepresentation', { extraExcludedPathPrefixes: excluded });
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', responseJudgement: 'SUCCESS', recordId, readVerification: { result: 'READ_BLOCKED_BY_POLICY' },
      result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED',
    });
    expect(run.evidence).toMatchObject({ readVerification: { state: 'EXECUTED', result: 'READ_BLOCKED_BY_POLICY', detail: 'REQUEST_POLICY', httpStatus: null } });
    // その画面への GET は 0 回（ほかの詳細の画面も読まない）。
    expect(detailPageReads(run.since, recordId)).toEqual([]);
    expect(detailPageReads(run.since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a 2xx without the record id', 'noRecordId', { httpStatus: 201, responseJudgement: 'SUCCESS', result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' }],
    ['a 400', 'clientError', { httpStatus: 400, responseJudgement: 'INPUT_ERROR', result: 'FAILED', reason: 'INPUT_ERROR' }],
    ['a 429', 'rateLimited', { httpStatus: 429, responseJudgement: 'RATE_LIMITED', result: 'FAILED', reason: 'RATE_LIMITED' }],
    ['a 503', 'serverError', { httpStatus: 503, responseJudgement: 'SERVER_ERROR', result: 'UNKNOWN', reason: 'SERVER_ERROR' }],
    ['no response', 'noResponse', { httpStatus: null, responseJudgement: null, result: 'UNKNOWN', reason: 'NO_RESPONSE', reservationState: 'UNKNOWN' }],
    [`a status outside 100 to 599 (${String(SPA_OUT_OF_RANGE_STATUS)})`, 'outOfRangeStatus',
      { httpStatus: null, responseJudgement: null, result: 'UNKNOWN', reason: 'NO_RESPONSE', reservationState: 'UNKNOWN' }],
  ] as const)(`does not claim a success for %s (${label})`, async (_name, response, expected) => {
    const run = await runWrite(response);
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', blockReason: null, recordId: null, ...expected });
    expect(run.document.result).not.toBe('VERIFIED');
    // 完了にしない（違反もない）。T40b-2: ID がない・成功でないので、照合の READ は行わない（詳細の画面への GET は 0 回）。
    expect(run.outcome).toMatchObject({ runStatus: 'PARTIAL' });
    expect(run.evidence).toMatchObject({ readVerification: { state: 'NOT_EXECUTED' } });
    expect(detailPageReads(run.since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 値を入れる間は送信の窓の観察の段で、ページの JS が入力の事象で承認どおりの要求を出しても、Guard は
  // 照合にかけずに止めて数える（送り手に渡さない）。押す直前の確かめ直しが拒んでも許しても、登録は届かず、押さずに `PRECHECK_FAILED`（予約は戻る）。
  it.each([
    ['the recheck rejects', (): Promise<WorkerWriteRecheckOutcome> => Promise.resolve({ allowed: false, reason: 'GRANT_INVALID' })],
    ['the recheck allows', undefined],
  ])(`does not send the request that the page sends on the input events while values are typed (%s) (${label})`, async (_name, recheck) => {
    site.setMemberSaveOnInput(true);
    const run = await runWrite('markedRepresentation', recheck === undefined ? {} : { recheck });
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reason: 'PRECHECK_FAILED', reservationState: 'RELEASED', httpStatus: null,
    });
    // 止めた証拠: 窓の中で、今の判定で止めた要求を数えた（照合にはかけていない）。
    const guard = run.evidence['guard'] as { readonly blockedByOtherRulesInWindow: number; readonly blockedByPayloadReason: Record<string, number> };
    expect(guard.blockedByOtherRulesInWindow).toBeGreaterThan(0);
    expect(Object.values(guard.blockedByPayloadReason).every((count) => count === 0)).toBe(true);
    expect(detailPageReads(run.since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T40R-fix-A（T40R の I-2）: ID を画面から取る形で、登録の画面（`/admin/members/new`）自身が ID の型（`/admin/members/{id}`）に当たる。押す前の画面から同じ
  // 取り方で取れた値（`new`）は ID として使わない（`RECORD_ID_NOT_FOUND`。照合の READ は行わない）。保存の確かめ（T40R-fix-B）が拒む形なので、開始の指定を
  // テストの中で直接組み立てる。
  const pageIdFromUrl = (write: WorkerStartApiWrite): WorkerStartApiWrite => ({
    ...write, api: { ...write.api, recordId: null }, verification: { ...write.verification, recordId: { source: 'URL_PATH_PATTERN', pathPattern: API_WRITE_READ_TEMPLATE_PATH } },
  });

  it(`does not take the create page path itself as the record id from the page URL pattern (${label})`, async () => {
    const run = await runWrite('markedRepresentation', { change: pageIdFromUrl });
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', responseJudgement: 'SUCCESS', httpStatus: 201, recordId: null, readVerification: null, result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND',
    });
    expect(detailPageReads(run.since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it(`does not take the record id from the page when the page aborts its request after sending (${label})`, async () => {
    site.setMemberSaveAborted(true);
    const run = await runWrite('markedRepresentation', { change: pageIdFromUrl });
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', recordId: null, readVerification: null });
    expect(run.document.result).not.toBe('VERIFIED');
    expect(detailPageReads(run.since)).toEqual([]);
    // T40R-fix-A（T40R の I-2 の (c)）: Guard は応答をページに返せなかったことを印し、画面から ID を取る形では `RESPONSE_NOT_DELIVERED`（`UNKNOWN`）。
    expect(run.document).toMatchObject({ responseJudgement: 'RESPONSE_NOT_DELIVERED', result: 'UNKNOWN', reason: 'RESPONSE_NOT_DELIVERED' });
    expect(run.evidence).toMatchObject({ guard: { responseDeliveryCanceled: true } });
  }, TEST_TIMEOUT_MS);

  it(`keeps the record id from the response body when the page aborts its request after sending (${label})`, async () => {
    site.setMemberSaveAborted(true);
    const run = await runWrite('markedRepresentation');
    expectedPosts += 1;
    // 応答の本文から ID を取る形は、送り手が受けた応答で決まる（印があっても今どおり。照合の READ まで進む）。
    expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    expect(run.document.recordId).toMatch(/^[0-9]+$/u);
  }, TEST_TIMEOUT_MS);

  it(`does not send a body that the page changed against the approval: PAYLOAD_MISMATCH, no write (${label})`, async () => {
    site.setHostileMemberSave('softDeleteKey');
    const run = await runWrite(null);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH', reservationState: 'RELEASED', httpStatus: null,
    });
    expect(run.document.api?.pageKeyValues).toBeNull();
  }, TEST_TIMEOUT_MS);

  it(`does not send when the precheck finds no submitter: PRECHECK_FAILED, no write (${label})`, async () => {
    const run = await runWrite(null, { change: (write) => ({ ...write, submitterIdentityDigest: UNMATCHED_DIGEST }) });
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(run.evidence).toMatchObject({ precheck: { candidateDigestMatched: false, blockReason: 'PRECHECK_FAILED' }, guard: null });
  }, TEST_TIMEOUT_MS);
});
