// T41d（Task 41 の設計書 3.4、4 章、5 章の 1〜4）: ワーカーの API の更新の書き込みの流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun` に、送り方
// API の UPDATE の書き込みの指定を渡す）を、同じ process の中で、本物の Chromium（テストの既定の headless と、CLI の起動の設定の両方）と 127.0.0.1 の fixture
// （`startSpaAuthSite` の form のない会員の更新の画面）で確かめる結合テスト。ログインの段は通さず、fixture が出したセッションを認証つきの Run の指定で渡す。
// - シナリオは本番の部品（`createScenario`）で、本物の発見の成果物から作る（変える鍵は名前、保つ鍵はメールアドレスと備考、filter は `id`）。開始の口（T41b）が
//   できるまでは、開始の指定をテストの中で組み立てる（約束の形: `api` はシナリオの API の指定のまま、`values` は変える鍵だけ、`update: { targetRecordId }`）。
// - 流れ: 前の読み取り（凍結した Context で対象の ID の更新の画面を読み、画面の path を型にした識別の digest で候補を照らし、欄の値を読む）→ 書き込みの段（開き
//   直した画面の値が前の値と同じこと、変える欄にだけ値を入れる、2 段の窓）→ 1 回の PATCH → 後の照合（読み直して欄ごとに照らす）→ 照合の READ。
// - 正常: PATCH は 1 回、変えた欄だけが変わり（サーバの記録で確かめる）、`VERIFIED`。本文が変える欄だけ・204・値を遅れて入れる形も `VERIFIED`。
// - 送らない: ページが保つ値や filter を書き換える（`PAYLOAD_MISMATCH`。PATCH は 0 回）。
// - 成功と偽らない: サーバの副作用（`UNEXPECTED_FIELD_CHANGE`）、0 行（`[]`）、2 行の一覧（`MULTIPLE_CONDITIONS_MATCHED`。T41R-fix の I-2）、ID の不一致
//   （`RECORD_ID_MISMATCH`）、400・503・応答なし。
// - T41R-fix（C-1・I-1）: 値を長く遅れて入れる画面（1500 ms・2500 ms）で、保つ欄を空で上書きする PATCH を送らない。値を読む要求の応答が遅れる形は
//   `VERIFIED` か送らない、値を読んだ後にページのタイマーだけで遅れる形・目印の欄がすべて空の前の読み取り・押す直前に保つ値が変わる形は送らない
//   （`PRECHECK_FAILED`。押す直前の読み直しは送る直前の確かめ直しの前なので、確かめ直しまで進まない）。T41R-fix-2: 読み直しの後、押す時にページが保つ値を
//   変える形は、送る瞬間に Guard が止める（`PAYLOAD_MISMATCH`。PATCH は 0 回）。場面ごとに新しい対象の会員を足す。
// - T41R3-fix（C-3・M-1）: 開始の指定に台帳が知る保つ鍵の値（`update.knownKeptValues`）を入れる。保つ欄に仮の値を出してから本当の値を入れる画面と、
//   BeakSight の外で保つ値が変わったレコードは送らない（`PRECHECK_FAILED`）。開いたままの要求のある画面は、要求が止む待ちを一度だけにして時間を縮める。
// - 秘密の目印と保つ欄の値（メールアドレス）は、成果物（ZIP の中身を含む）に出ない。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { actionRunMatchesWriteStart } from '../../src/control/actions/action-api-summary.js';
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
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { executeWriteCreateRun, type WriteCreateRunOutcome } from '../../src/worker/write-create-run.js';
import type { WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import {
  API_WRITE_READ_TEMPLATE_PATH,
  createApiCreateScenario,
  createApiUpdateScenario,
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
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaHostileMemberSave,
  type SpaMemberUpdateResponse,
} from '../helpers/spa-auth-site-fixture.js';
import { readWriteReportFiles } from '../helpers/write-report-checks.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
const NAVIGATION_INTERVAL_MS = 300;
const RESULT_TIMEOUT_MS = 5_000;
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** T41R-fix: 値が長く遅れて入る場面の遅れ（ms。T41R の再現と同じ）。 */
const LONG_DELAYS_MS = [1_500, 2_500] as const;
/** T41R2-fix: 保つ欄のメールアドレスだけを遅れて入れる時間（ms。T41R2 の再現と同じ）。 */
const KEPT_EMAIL_DELAY_MS = 2_500;
/** T41R3-fix（M-1）: 開いたままの要求のあるページの 1 回の書き込みの時間の上限（ms。待ちを省く前は約 22〜27 秒）。 */
const HELD_REQUEST_RUN_LIMIT_MS = 17_000;const PROFILE_ID = 'example-t41d';
const CREATE_SCENARIO_ID = 'scenario-api-create-t41d';
const UPDATE_SCENARIO_ID = 'scenario-api-update-t41d';
const READ_CHECK_ID = 'rc-api-t41d';
const GRANT_ID = 'grant-t41d';
const EXISTING_NAME = '既存 会員';
const SHA256_HEX_LENGTH = 64;
const ALLOWED = Object.freeze({ allowed: true });
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');

let site: SpaAuthSite;
let directory = '';
let database: ControlDatabase;
/** 対象のレコード（発見の前に足した会員）の ID。 */
let targetId = 0;
/** 開始の指定（場面の番号ごとの新しい名前と、その値で作った照合の READ の期待）。 */
let writeFor: (index: number) => WorkerStartApiWrite = () => {
  throw new Error('the scenario is not prepared');
};
let caseNumber = 0;

const memberPatches = (): number => site.requests
  .filter((request) => request.origin === 'backend' && request.method === 'PATCH' && request.path.startsWith(SPA_BACKEND_PATHS.members)).length;
const nonReads = (): number => site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method)).length;
const nameFor = (index: number): string => `T41d 名前 ${String(index)}`;

beforeAll(async () => {
  site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberDetailPage: true });
  targetId = site.addMember(EXISTING_NAME);
  directory = await mkdtemp(join(tmpdir(), 'beaksight-api-update-run-'));
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
  const createScenario = createApiCreateScenario(database, {
    profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    at: nowText,
  });
  const updateScenario = createApiUpdateScenario(database, {
    profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO_ID, ledgerScenarioId: CREATE_SCENARIO_ID, document, updatePagePath: spaMemberEditPathOf(targetId), at: nowText,
  });
  const createRevision = readScenarioRevisions(database, CREATE_SCENARIO_ID).find(({ revision }) => revision === createScenario.scenario.revision);
  const readCheck = listReadChecks(database, PROFILE_ID).find(({ readCheckId }) => readCheckId === READ_CHECK_ID);
  const update = updateScenario.scenario.current;
  if (createRevision === undefined || readCheck === undefined || update.api === undefined) throw new Error('the scenarios or the READ check are missing');
  const updateApi = update.api;
  writeFor = (index: number): WorkerStartApiWrite => {
    // 照合の READ と seed の形は、本番の親の部品で作った登録の開始の指定を元にする（UPDATE の開始の口は T41b）。
    const base = writeStartSpecOf({
      scenario: createRevision.scenario, evidence: createRevision.evidence, grantId: GRANT_ID,
      values: Object.fromEntries(createRevision.scenario.fieldNames.map((key) => [key, key === 'email' ? 't41d@example.invalid' : nameFor(index)])), readCheck,
      targetPage: { origin: site.appOrigin, path: API_WRITE_READ_TEMPLATE_PATH }, profileId: PROFILE_ID,
      seedRecord: {
        seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
        seedInput: { profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: update.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
          executionGrantId: GRANT_ID },
        baseDate: '2026-10-18',
        attempt: 0,
      },
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, scenarioRevision: createRevision.revision, grantId: GRANT_ID }),
    });
    if (base === null || !isWorkerStartApiWrite(base)) throw new Error('the base specification was not built');
    const name = nameFor(index);
    return {
      ...base,
      scenarioId: UPDATE_SCENARIO_ID,
      scenarioRevision: update.revision,
      formPage: { origin: site.appOrigin, path: spaMemberEditPathOf(targetId) },
      candidate: { identityDigest: update.candidate.identityDigest, ruleDigest: update.candidate.ruleDigest },
      submitterIdentityDigest: update.candidate.identityDigest,
      api: updateApi,
      values: { name },
      verification: { successCondition: null, inputErrorCondition: null, recordId: null },
      readVerification: {
        ...base.readVerification,
        definition: { ...base.readVerification.definition, expectations: [{ kind: 'TEXT_CONTAINS', text: name }] },
      },
      approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: update.revision, grantId: GRANT_ID }),
      // T41R3-fix: 保つ鍵の最後に分かっている値（親が台帳から求める。対象の会員のメールアドレスは、どの場面でも変わらない）。
      update: { targetRecordId: String(targetId), knownKeptValues: [{ key: 'email', value: site.memberOf(targetId)?.email ?? '' }] },
    } as WorkerStartApiWrite;
  };
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (database !== undefined) closeControlDatabase(database);
  await site?.close();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}, SUITE_TIMEOUT_MS);

describe.each(LAUNCHERS)('T41d: the API update write flow with %s', (label, launch) => {
  let expectedPatches = 0;
  let patchesBefore = 0;
  let nonReadsBefore = 0;

  beforeAll(() => {
    patchesBefore = memberPatches();
    nonReadsBefore = nonReads();
  });

  afterEach(() => {
    site.setHostileMemberSave(null);
    site.setMemberUpdateChangedOnly(false);
    site.setMemberUpdateSideEffect(false);
    site.setMemberUpdateResponse(null);
    site.setMemberValuesDelayed(false);
    site.setMemberDetailDelay(null);
    site.setMemberKeptRewriteOnInput(false);
    site.setMemberKeptRewriteOnPress(false);
    site.setMemberKeptEmailDelay(null);
    site.setMemberHoldRequest(false);
    site.setMemberPlaceholderEmail(null);
    expect(memberPatches() - patchesBefore, 'member PATCHes that reached the server').toBe(expectedPatches);
    expect(nonReads() - nonReadsBefore, 'non-read requests that reached the server').toBe(expectedPatches);
  });

  afterAll(async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(memberPatches() - patchesBefore).toBe(expectedPatches);
    expect(nonReads() - nonReadsBefore).toBe(expectedPatches);
  }, TEST_TIMEOUT_MS);

  interface Run {
    readonly outcome: WriteCreateRunOutcome;
    readonly document: ActionRunDocument;
    readonly evidence: Record<string, unknown>;
    readonly write: WorkerStartApiWrite;
    /** T41R-fix-2: 送る直前の確かめ直し（`recheck`）を呼んだ回数。 */
    readonly rechecks: number;
  }

  const runWrite = async (change: (write: WorkerStartApiWrite) => WorkerStartApiWrite = (write) => write): Promise<Run> => {
    caseNumber += 1;
    const write = change(writeFor(caseNumber));
    const reports: WorkerWriteSubmissionReport[] = [];
    let rechecks = 0;
    const keptEmail = site.memberOf(Number(write.update?.targetRecordId ?? targetId))?.email ?? '';
    const outcome = await executeWriteCreateRun({
      config: spaApiWriteConfigOf(site, join(directory, `output-${String(caseNumber)}`), { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS } }),
      jobId: `job-api-update-${String(caseNumber)}`,
      authentication: spaRunAuthenticationOf(site),
      write,
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      recheck: () => {
        rechecks += 1;
        return Promise.resolve(ALLOWED);
      },
      reportSubmission: (report) => reports.push(report),
      resultTimeoutMs: RESULT_TIMEOUT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
    const text = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
    const document = JSON.parse(text) as ActionRunDocument;
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
    // 親の照らし合わせ（送り方と API の要約が START の API の指定と同じ。手書きの確かめを含む）も通る。
    expect(actionRunMatchesWriteStart(document, write.api)).toBe(true);
    // 秘密の目印と、保つ欄の値（メールアドレス）は、成果物に出ない。
    const markers = [...site.secretValues(), keptEmail].filter((marker) => marker !== '');
    for (const marker of markers) {
      expect(text).not.toContain(marker);
    }
    await readWriteReportFiles(outcome.runDirectory, document, { markers, approvalFacts: write.approvalFacts });
    expect(reports).toEqual([{ submission: document.submission, blockReason: document.blockReason }]);
    const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, 'action-evidence.json'), 'utf8')) as Record<string, unknown>;
    return { outcome, document, evidence, write, rechecks };
  };

  it(`updates the changed field once and keeps the other fields, checks them after the update, and verifies (${label})`, async () => {
    const before = site.memberOf(targetId);
    const run = await runWrite();
    expectedPatches += 1;
    const after = site.memberOf(targetId);
    expect(after).toMatchObject({ name: nameFor(caseNumber), email: before?.email, note: before?.note });
    expect(run.document).toMatchObject({
      transport: 'API', submission: 'SENT', responseJudgement: 'SUCCESS', recordId: String(targetId), result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
      update: { targetRecordId: String(targetId) }, readVerification: { result: 'MATCHED' }, submittedValues: { name: nameFor(caseNumber) },
    });
    expect(run.document.update?.updateEvidence?.fields.map(({ fieldName, role, matched }) => [fieldName, role, matched])).toEqual([
      ['name', 'CHANGED', true], ['email', 'KEPT', true], ['note', 'KEPT', true],
    ]);
    expect(run.outcome).toMatchObject({ runStatus: 'COMPLETE', result: 'VERIFIED' });
  }, TEST_TIMEOUT_MS);

  it.each<[string, () => void]>([
    ['the body has only the changed field', () => site.setMemberUpdateChangedOnly(true)],
    ['the server answers 204 without a body', () => site.setMemberUpdateResponse('noContent')],
    ['the page fills the values later', () => site.setMemberValuesDelayed(true)],
  ])(`verifies when %s (${label})`, async (_name, prepare) => {
    prepare();
    const run = await runWrite();
    expectedPatches += 1;
    expect(site.memberOf(targetId)?.name).toBe(nameFor(caseNumber));
    expect(run.document).toMatchObject({ submission: 'SENT', recordId: String(targetId), result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
  }, TEST_TIMEOUT_MS);

  it.each<[string, SpaHostileMemberSave]>([
    ['rewrites a kept value', 'keptValueRewrite'],
    ['rewrites the filter', 'filterRewrite'],
  ])(`does not send when the page %s: PAYLOAD_MISMATCH, no PATCH (${label})`, async (_name, hostile) => {
    site.setHostileMemberSave(hostile);
    const before = site.memberOf(targetId);
    const run = await runWrite();
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(site.memberOf(targetId)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it.each<[string, () => void, Partial<ActionRunDocument>]>([
    ['a side effect of the server on a kept field', () => site.setMemberUpdateSideEffect(true), { result: 'UNKNOWN', reason: 'UNEXPECTED_FIELD_CHANGE' }],
    ['an empty list (no row updated)', () => site.setMemberUpdateResponse('emptyRows'), { result: 'UNKNOWN', reason: 'NO_CONDITION_MATCHED' }],
    ['another record id in the body', () => site.setMemberUpdateResponse('otherRecordId'), { result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH' }],
    // T41R-fix（I-2）: 2 行の一覧（2 行以上を更新した。どの行が変わったか分からない）。
    ['a list of two rows in the body', () => site.setMemberUpdateResponse('twoRows'), { result: 'UNKNOWN', reason: 'MULTIPLE_CONDITIONS_MATCHED' }],
    // T41R2-fix（M-1）: 行の数が分からない本文（読む上限を超える 2 行、JSON でない本文）。
    ['a list of two rows over the read limit', () => site.setMemberUpdateResponse('largeTwoRows'), { result: 'UNKNOWN', reason: 'NO_CONDITION_MATCHED' }],
    ['a body that is not JSON', () => site.setMemberUpdateResponse('notJson'), { result: 'UNKNOWN', reason: 'NO_CONDITION_MATCHED' }],
    ['a 400', () => site.setMemberUpdateResponse('clientError' satisfies SpaMemberUpdateResponse), { result: 'FAILED', reason: 'INPUT_ERROR' }],
    ['a 503', () => site.setMemberUpdateResponse('serverError'), { result: 'UNKNOWN', reason: 'SERVER_ERROR' }],
    ['no response', () => site.setMemberUpdateResponse('noResponse'), { result: 'UNKNOWN', reason: 'NO_RESPONSE' }],
  ])(`does not claim a success for %s (${label})`, async (_name, prepare, expected) => {
    prepare();
    const run = await runWrite();
    expectedPatches += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', update: { targetRecordId: String(targetId) }, ...expected });
    expect(run.document.result).not.toBe('VERIFIED');
    expect(run.outcome).toMatchObject({ runStatus: 'PARTIAL' });
  }, TEST_TIMEOUT_MS);

  // T41R-fix（Task 41 の設計書 8 章の「T41R の途中の報告」の C-1・I-1）: 値を遅れて入れる画面で、保つ欄を空で上書きする PATCH を送らない。場面ごとに新しい
  // 対象の会員（保つ欄に値がある）を足す（前の場面の書き込みが後の場面に残らないように）。
  // T41R3-fix: `ledger` が真なら、親が台帳から求める保つ鍵ごとの最後に分かっている値（`START` の `update.knownKeptValues`。T41R3-fix-B の約束の形）を、
  // 足した会員の値で渡す。
  const freshTarget = (ledger = false) => {
    const tag = String(caseNumber + 1);
    const email = `t41r-${tag}@example.invalid`;
    const note = `保つ備考 ${tag}`;
    const id = site.addMember(`T41R 対象 ${tag}`, { email, note });
    const update = { targetRecordId: String(id), knownKeptValues: ledger ? [{ key: 'email', value: email }, { key: 'note', value: note }] : [] };
    return {
      id,
      before: site.memberOf(id),
      change: (write: WorkerStartApiWrite): WorkerStartApiWrite => ({ ...write, formPage: { ...write.formPage, path: spaMemberEditPathOf(id) }, update }),
    };
  };

  it(`does not send when only the kept email is filled ${String(KEPT_EMAIL_DELAY_MS)} ms later and the ledger knows its value: PRECHECK_FAILED (${label})`, async () => {
    site.setMemberKeptEmailDelay(KEPT_EMAIL_DELAY_MS);
    const target = freshTarget(true);
    const run = await runWrite(target.change);
    // T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由（台帳が知る保つ鍵の値と違う）も残す。
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    expect(site.memberOf(target.id)).toEqual(target.before);
  }, TEST_TIMEOUT_MS);

  // T41R3-fix（C-3）: 保つ欄に仮の値（「読み込み中」）を出してから本当の値を入れる画面。仮の値は台帳の値と違うので送らない。
  it(`does not send when the page shows a placeholder in a kept field before the real value: PRECHECK_FAILED (${label})`, async () => {
    site.setMemberPlaceholderEmail(KEPT_EMAIL_DELAY_MS);
    const target = freshTarget(true);
    const run = await runWrite(target.change);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    expect(site.memberOf(target.id)).toEqual(target.before);
  }, TEST_TIMEOUT_MS);

  // T41R3-fix: BeakSight の外で保つ値が変わったレコード（台帳の値と違う）は、送らない。
  it(`does not send when a kept value was changed outside BeakSight: PRECHECK_FAILED (${label})`, async () => {
    const target = freshTarget(true);
    site.setMemberValues(target.id, { note: '外で変えた備考' });
    const before = site.memberOf(target.id);
    const run = await runWrite(target.change);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    expect(site.memberOf(target.id)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it(`verifies on a page that keeps a request open when the values are filled at once, without waiting again for the requests (${label})`, async () => {
    site.setMemberHoldRequest(true);
    const target = freshTarget(true);
    const startedAt = Date.now();
    const run = await runWrite(target.change);
    const elapsedMs = Date.now() - startedAt;
    expectedPatches += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', recordId: String(target.id) });
    expect(site.memberOf(target.id)).toEqual({ ...target.before, name: nameFor(caseNumber) });
    // T41R3-fix（M-1）: 一度要求が止む待ちの上限に届いた画面は、残りの読み取りでその待ちを省く（省く前は 1 回に約 22〜27 秒）。
    expect(elapsedMs).toBeLessThan(HELD_REQUEST_RUN_LIMIT_MS);
  }, TEST_TIMEOUT_MS);

  it.each(LONG_DELAYS_MS)(`does not empty a kept field when the read of the values answers %i ms later: verifies or does not send (${label})`, async (delayMs) => {
    site.setMemberDetailDelay(delayMs);
    const target = freshTarget();
    const run = await runWrite(target.change);
    const sent = run.document.submission !== 'NOT_SENT';
    expectedPatches += sent ? 1 : 0;
    expect(site.memberOf(target.id)).toMatchObject({ email: target.before?.email, note: target.before?.note });
    if (sent) {
      expect(run.document).toMatchObject({ result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
      expect(site.memberOf(target.id)?.name).toBe(nameFor(caseNumber));
    } else {
      expect(run.document).toMatchObject({ blockReason: 'PRECHECK_FAILED', result: 'BLOCKED' });
    }
  }, TEST_TIMEOUT_MS);

  it.each(LONG_DELAYS_MS)(`does not send when the page fills the values %i ms after the read by a timer only: PRECHECK_FAILED (${label})`, async (delayMs) => {
    site.setMemberValuesDelayed(true, delayMs);
    const target = freshTarget();
    const run = await runWrite(target.change);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'PRIOR_VALUES_EMPTY', result: 'BLOCKED', reservationState: 'RELEASED',
    });
    expect(site.memberOf(target.id)).toEqual(target.before);
  }, TEST_TIMEOUT_MS);

  it(`does not send when every marked field of the prior read is empty: PRECHECK_FAILED (${label})`, async () => {
    const emptyId = site.addMember('', { email: '', note: '' });
    const before = site.memberOf(emptyId);
    const update = { targetRecordId: String(emptyId), knownKeptValues: [] };
    const run = await runWrite((write) => ({ ...write, formPage: { ...write.formPage, path: spaMemberEditPathOf(emptyId) }, update }));
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'PRIOR_VALUES_EMPTY', result: 'BLOCKED' });
    expect(site.memberOf(emptyId)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it(`does not press when the page changes a kept value after the input: PRECHECK_FAILED before the window (${label})`, async () => {
    site.setMemberKeptRewriteOnInput(true);
    const target = freshTarget();
    const run = await runWrite(target.change);
    // 押す直前の読み直しで止める（Guard の照合の前。送信の段で止めた `PAYLOAD_MISMATCH` ではない）。T41R-fix-2: 読み直しは送る直前の確かめ直しの前なので、
    // 確かめ直しまで進まない。T44e: 具体的な理由は、前の値と違う（押す直前の読み直し）。
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'PRIOR_VALUE_CHANGED', result: 'BLOCKED' });
    expect(run.rechecks).toBe(0);
    expect(site.memberOf(target.id)).toEqual(target.before);
  }, TEST_TIMEOUT_MS);

  // T41R-fix-2（設計書 8 章の「T41R-fix の報告（設計者の判断）」）: 読み直しの後、押す時にページが保つ値を変えても、送る瞬間に Guard が前の値と照らして
  // 止める（PATCH は 0 回）。確かめ直しは押す前に 1 回。
  it(`does not send when the page changes a kept value at the press after the reread: PAYLOAD_MISMATCH, no PATCH (${label})`, async () => {
    site.setMemberKeptRewriteOnPress(true);
    const target = freshTarget();
    const run = await runWrite(target.change);
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(run.rechecks).toBe(1);
    // 止めた証拠: 送る中身の照合で止めた数が 1 以上。
    const guard = run.evidence['guard'] as { readonly blockedByPayloadReason: Readonly<Record<string, number>> };
    expect(Object.values(guard.blockedByPayloadReason).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
    expect(site.memberOf(target.id)).toEqual(target.before);
  }, TEST_TIMEOUT_MS);
});
