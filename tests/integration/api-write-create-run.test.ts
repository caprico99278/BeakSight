// T40b-1（Task 40 の設計書 3.3、4 章、5 章の 1・3・4）: ワーカーの API の登録の書き込みの流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun`
// に、送り方 API の書き込みの指定を渡す）を、同じ process の中で、本物の Chromium（テストの既定の headless）と 127.0.0.1 の
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { DEFAULT_CHROMIUM_LAUNCHERS, launchHeadlessChromium, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTO_REQUEST_PATHS,
  SPA_BACKEND_PATHS,
  SPA_OTHER_COLLECT_PATH,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaMemberSaveResponse,
} from '../helpers/spa-auth-site-fixture.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { readWriteReportFiles } from '../helpers/write-report-checks.js';

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
/** OP-N: 届いた、バックエンドへの要求（`since` 番目の記録から。method と path で選ぶ。事前確認は数えない）。 */
const backendRequests = (since: number, method: string, path: string): number => site.requests.slice(since)
  .filter((request) => request.origin === 'backend' && !request.preflight && request.method === method && request.path.startsWith(path)).length;

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

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T40b-1: the API create write flow with %s', (label, launchChromium) => {
  // SLIM-2（X7）: 書き込みの流れごとに Chromium を起こさず、1 つの Browser を共有する（Context は流れごと）。
  const launch = useSharedRunBrowser(launchChromium);
  /** これまでの場面で、サーバに届いてよいと確かめた登録の数。 */
  let expectedPosts = 0;
  /** OP-N: これまでの場面で、届いてよいと確かめた、承認した登録のほかの読み取りでない要求（送信の扱いで通した、サイトが自動で送る通信）の数。 */
  let expectedOtherNonReads = 0;
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
    site.setMemberSaveResponsePadding(null);
    site.setMemberDetailResponse(null);
    site.setMemberSaveOnInput(false);
    site.setMemberSideRequestsOnInput(false);
    site.setMemberAutoRequests(null);
    site.setMemberSaveAborted(false);
    site.setMemberNewRenderDelay(null);
    site.setMemberInputQuirk(null);
    site.setMemberDetailRpcRead(false);
    expect(memberPosts().length - postsBefore, 'member POSTs that reached the server').toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore, 'non-read requests that reached the server').toBe(expectedPosts + expectedOtherNonReads);
  });

  afterAll(async () => {
    // 遅れて届く要求を待って数え直す。TEST-TIME-B（案 9）: どの回も Browser を閉じた後なので、受けている途中の要求が 0 になってから短い余白だけ待つ。
    await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, site);
    expect(memberPosts().length - postsBefore).toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore).toBe(expectedPosts + expectedOtherNonReads);
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
    /** OP-N: 監査の段の送信の扱い（プロファイルの設定。親が `START` で渡し、ワーカーが実効の設定の上書きにする値。省略は読み取りだけ）。 */
    readonly auditSendPolicy?: 'READ_ONLY' | 'PASS_EXCEPT_DELETE';
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
      config: spaApiWriteConfigOf(site, outputDirectory, {
        crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
        ...(options.auditSendPolicy === undefined ? {} : { audit: { sendPolicy: options.auditSendPolicy } }),
      }),
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
      observationWindows: TEST_OBSERVATION_WINDOWS,
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
      schemaVersion: 'action-run-schema/1.2', transport: 'API', resultJudgement: null, submission: 'SENT', blockReason: null, httpStatus: 201,
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

  // RB-11: 照合の READ の結果と応答の状態からの判定（一致しない画面・503）は単体（`write-create-run-api`・`action-outcome`）と `write-run-loop`（成功でない応答は
  // 照合しない）が、`{id}` の画面の事前の判定（危険な語・除外の path）は単体 `read-check-page-path`（`recordPageReadTargetOf`）が確かめる。
  // SPEC-1: 撤廃した上限（L12b の登録の ID の長さ・L10 の応答の本文の大きさ 1 MiB）の場面は消した。撤廃の確かめは単体の `api-record-id.test.ts` にある。

  // RB-14a: 値を入れる間（窓の観察の段）にページが出す承認どおりの要求を照合にかけずに止めること（T40R-fix-A）は guard-api-write-stage（窓の観察の段の
  // 要求・窓の外の要求）が、止めたら押さない判定は単体 write-stage-steps（`submissionWindowVerdictOf`）が確かめる。

  // OP-M（本物のテスト環境の事実: 値を入れた後に、承認した送信のほかの要求が出て `UNEXPECTED_REQUEST` で止まった。何の要求だったかの記録がなかった）: 値を入れる
  // 間に、ページが入力の確かめの手続きの呼び出し（本文に入れた値）、使われ方の記録の beacon、承認していない Origin への記録を出す。止める判定は今どおり
  // （押さずに `PRECHECK_FAILED`・`UNEXPECTED_REQUEST`）で、証拠に、出た要求の形（送り方・送り先の区分・path の形・種類・時点・理由・目印の真偽）が値と
  // 承認していない Origin の名前を含まずに残る。
  // RB-4b: 値を入れた後にページが出す要求を「予期しない要求」として止め、その形を記録する場面は外した（書き込みの最中も、サイトの通信は止めない。ユーザーの判断
  // 2026-11-15）。止める先がないので、別の所の確かめはない。

  /** OP-N: 証拠の Guard の要約の、止めた一覧と通した一覧。 */
  const guardListsOf = (run: Run): { readonly blocked: readonly Record<string, unknown>[]; readonly passed: readonly Record<string, unknown>[] } => {
    const guard = run.evidence['guard'] as { readonly unexpectedRequests?: readonly Record<string, unknown>[]; readonly passedRequests?: readonly Record<string, unknown>[] };
    return { blocked: guard.unexpectedRequests ?? [], passed: guard.passedRequests ?? [] };
  };
  /** OP-N: 証拠に、入れた値と承認していない Origin の名前が出ない。 */
  const expectNoValuesInEvidence = (run: Run): void => {
    const text = JSON.stringify(run.evidence['guard']);
    for (const value of Object.values(run.write.values)) {
      if (value !== null) expect(text).not.toContain(value);
    }
    expect(JSON.stringify(run.evidence)).not.toContain(site.otherOrigin);
  };
  const scriptSendType = expect.stringMatching(/^(?:fetch|xhr)$/u);

  // RB-11: 値を入れた後の読み取りと WebSocket の張り直しを止めない（既定は通す）ことは、ずれの確かめの通り道の代表（`tests/contract/pass-through-paths`）が確かめる。

  // RB-4b: 値を入れた後の、入れた値を運ぶページの要求で書き込みを取りやめる場面（前の N1）は外した（書き込みの最中も、サイトの通信は止めない。ユーザーの判断
  // 2026-11-15。入れた値は、そのページの要求でサーバに届きうる）。止める先がないので、別の所の確かめはない。

  // OP-N（設計書 4.1.7 の N2）: 値を入れる前に、サイトが自動で送る通信（手続きの呼び出し）は、送信の扱いが `PASS_EXCEPT_DELETE` なら、監査の段と同じ判定で通す
  // （書き込みには数えない。証拠に形と数を残す）。SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: ページの DELETE も通す。
  // 承認していない Origin の外のスクリプトの読み取りも止めない。数える書き込みは承認した 1 件だけで、`VERIFIED`。
  it(`passes the procedure call and the DELETE that the page sends before the values are typed with PASS_EXCEPT_DELETE (N2, SD-2) (${label})`, async () => {
    site.setMemberAutoRequests('BEFORE_FILL');
    const run = await runWrite('markedRepresentation', { auditSendPolicy: 'PASS_EXCEPT_DELETE' });
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', blockReason: null, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    // OP-Q（設計書 4.1.8 の Q1。OP-REV3 の C-1 を改めた）: 手続きの呼び出しと DELETE は、送る前の確かめの画面と書き込みの段の画面の 2 回ずつ届いた（送る前の
    // 確かめの Context にも、書き込みの段の値を入れる前と同じ決まりで送信の扱いを当てる）。
    expect(backendRequests(run.since, 'POST', SPA_AUTO_REQUEST_PATHS.rpcStatus)).toBe(2);
    expect(backendRequests(run.since, 'DELETE', SPA_AUTO_REQUEST_PATHS.previews)).toBe(2);
    expectedOtherNonReads += 4;
    const { blocked, passed } = guardListsOf(run);
    // 書き込みの段で通した手続きの呼び出しと DELETE（値を入れる前。目印なし）。
    expect(passed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'POST', destination: 'APPROVED_SERVICE_ORIGIN', pathShape: SPA_AUTO_REQUEST_PATHS.rpcStatus, resourceType: scriptSendType, timing: 'BEFORE_FILL',
        reason: 'AUDIT_SEND_PASSED', markerInBody: false, count: 1,
      }),
      expect.objectContaining({ method: 'DELETE', pathShape: SPA_AUTO_REQUEST_PATHS.previews, timing: 'BEFORE_FILL', reason: 'AUDIT_SEND_PASSED' }),
    ]));
    expect(blocked.filter((request) => request['method'] === 'DELETE')).toEqual([]);
    // RB-4b: 承認していない Origin の外のスクリプトの読み取りは、止めない（止めた一覧に出ない）。
    expect(blocked.filter((request) => request['pathShape'] === SPA_AUTO_REQUEST_PATHS.widget)).toEqual([]);
    expectNoValuesInEvidence(run);
  }, TEST_TIMEOUT_MS);

  // SLIM W-3: プロファイルが読み取りだけ（`READ_ONLY`）のときに値を入れる前の自動の通信も止める（今のまま）場面は外した。READ_ONLY の書き込みの段の止め方は
  // `write-stage-after-press-sends.test.ts` と `guard-api-write-stage.test.ts` が確かめる。

  // L12a（設計書 `2026-11-09-beaksight-remove-limits-design.md`、L12 の判断。OP-REV3 の C-2 の「押した後は止める」を置き換えた）: 押した後に、ページが自分で
  // 送る読み取りでない要求（値のない呼び出し、値を本文・ヘッダ・Cookie に持つ呼び出し）は、送信の扱いが `PASS_EXCEPT_DELETE` なら、削除を含めて届く（SD-2 の方針
  // 「サイトの通信は止めない。BeakSight は削除の操作をしない」）。書き込みに数えるのは承認した 1 件だけで、ほかは通した一覧（`passedRequests`。押した後の時点）に分けて残る。入れた値は、これらの
  // 要求でサーバに届く（証拠には値を残さない）。
  // RB-11: 押した後のページの読み取りでない要求を止めずに通すこと（L12a・SD-2）は、`write-stage-after-press-sends` とずれの確かめの通り道の代表が確かめる。

  // RB-14a: 値を入れる前に、承認した送信先の形を変えた path への POST を止めること（OP-REV3 の C-1・I-1）は、単体 request-policy-write-stage-audit-send と
  // guard-api-write-stage（窓の前の送信先の下・一覧の path）が確かめる。承認していない Origin への POST を通すことは、ずれの確かめの通り道の代表が確かめる。

  // OP-Q（設計書 4.1.8 の Q1。本物のテスト環境の事実: 照合の READ の Context が読み取りだけだったので、詳細の画面のデータを取る手続きの呼び出しが止まり、
  // `READ_VERIFICATION_UNDETERMINED` になった）: 照合の READ の Context にも、書き込みの段の値を入れる前と同じ決まりで送信の扱いを当てる。データを取る手続きの呼び出し
  // （承認したサービスの Origin への POST。承認した送信先の下ではない）が 1 回届き、画面に作った値が出て `VERIFIED`。登録は 1 件だけ。
  // RB-11: 照合の READ の画面の手続きの呼び出しを PASS_EXCEPT_DELETE で通す（Q1）ことは、ずれの確かめの通り道の代表が確かめる。

  // OP-Q（Q1）: プロファイルが読み取りだけ（`READ_ONLY`）なら、今どおり、照合の READ の画面の手続きの呼び出しも止める（届かない。確かめられないので `PARTIAL`）。
  it(`stops the data procedure call of the verification READ page with READ_ONLY, as now (Q1) (${label})`, async () => {
    site.setMemberDetailRpcRead(true);
    const run = await runWrite('markedRepresentation', { auditSendPolicy: 'READ_ONLY' });
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', responseJudgement: 'SUCCESS', readVerification: { result: 'UNDETERMINED' }, result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED',
    });
    expect(backendRequests(run.since, 'POST', SPA_BACKEND_PATHS.rpcGetMember)).toBe(0);
  }, TEST_TIMEOUT_MS);

  // RB-11: ページが要求を取り消して応答をページに返せなかったとき（画面から ID を取る形）の段の輪の反応は `write-run-loop`、取り消しの観察は
  // guard-write-stage（223）が確かめる。

  // RB-14a: ページが承認と違う本文を送る形の照合（PAYLOAD_MISMATCH）は、guard-api-write-stage（敵対的な保存・ページの送信）と単体 api-write-payload-policy、
  // 照合で止めたときの記録は単体 write-run-loop が確かめる。

  // RB-11: 送信の要素が見つからない候補の不一致（OP-L L1）と、値が残らない・作り直しで空になったときの入力の失敗（OP-O O1・OP-P）の証拠への写しは
  // `write-run-loop`、入力の部品の失敗の観察は `api-write-submitter`（269・352・428）が確かめる。SPA の入れ直し・探し直しの輪（OP-O・OP-P）は
  // `api-write-submitter`（250・333）と純粋な判定 `refillStepOf`・`pressRetryStepOf` が、欄が後から描かれるのを待つ輪（OP-L L1）は純粋な判定
  // `inspectAgainStepOf`（`write-stage-steps`）と、1 回の確かめの観察 `api-write-submitter`（428）が確かめる。
});
