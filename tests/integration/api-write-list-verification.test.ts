// OP-R（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R1）: API の登録の答え合わせを、登録の画面の 1 つ上の一覧の画面で行う。
// 本物のテスト環境の事実: 推した詳細の画面（`/admin/<x>/{id}`）はサイトになく、答え合わせが合わなかった。一覧の画面は点検の段のリンクにあり、データは SPA の
// 手続きの呼び出し（POST）で取って表に描く。
// - fixture: 詳細の画面がなく（`memberDetailPage` なし）、一覧の画面（`memberListPage`）が手続きの呼び出しで会員を描く形（`startSpaAuthSite`）。
// - 照合の READ の画面は、本番の自動の下書きの選び方（`autoDraftReadCheckChoiceOf`）で選ぶ（点検の段のリンクの path を渡す）。シナリオと書き込みの指定は、本番の
//   部品（保存の口、`writeStartSpecOf`、IPC の契約）で作る。
// - 確かめること: 登録は 1 件だけ届く。一覧の画面への GET は 1 回だけ。答え合わせは「作った値を含む」で `VERIFIED`。届いた読み取りでない要求は、登録と一覧の
//   手続きの呼び出し（送信の扱いで通した、サイトが自動で送る読み取りの手続き）だけ。詳細の画面は読まない。
// - OP-REV6 の I-1: 一覧の画面には前の登録が並ぶので、期待は実行のたびに違う値になる欄（`uniqueEachRunFieldNamesOf`。ここはメール）と比べる。人の名前と比べる
//   期待では、書き込みの指定を作らない（前の登録と同じ名前が一覧にあり、新しい登録が一覧にまだ出ていなくても、`VERIFIED` と報告しない）。
// - 書き込みの安全のテストなので、テストの既定の Chromium と CLI の起動の設定の両方で、順に確かめる（同時には動かさない）。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { autoDraftReadCheckChoiceOf } from '../../src/control/approval/api-scenario-autodraft.js';
import { readScenarioRevisions } from '../../src/control/approval/scenario-store.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { readLatestRuleSet } from '../../src/control/data-rules/rule-store.js';
import { uniqueEachRunFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
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
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { discoveryReadPagePaths } from '../../src/discovery/discovery-result.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { createApiCreateScenario, discoverSpaMemberScreens, spaApiWriteConfigOf, spaRunAuthenticationOf } from '../helpers/api-write-scenario.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { SPA_APP_PATHS, SPA_BACKEND_PATHS, SPA_MEMBER_LIST_PATH, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';

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
/** 自動の下書きの、定義の数の上限（テストの値。上限に当たらない数）。 */
const MAX_TEST_DEFINITIONS = 10;
const PROFILE_ID = 'example-op-r';
const SCENARIO_ID = 'scenario-api-create-list';
const READ_CHECK_ID = 'rc-api-list';
const GRANT_ID = 'grant-list';
const SHA256_HEX_LENGTH = 64;
const ALLOWED = Object.freeze({ allowed: true });
const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');
/** 鍵ごとの値（場面ごとに別の値。メールアドレスの鍵はメールアドレスの形）。 */
const valuesFor = (keys: readonly string[], index: number): Record<string, string> =>
  Object.fromEntries(keys.map((key) => [key, key === 'email' ? `op-r-${String(index)}@example.invalid` : `OP-R ${key} ${String(index)}`]));
let site: SpaAuthSite;
let directory = '';
let database: ControlDatabase;
/** 自動の下書きの選び方が選んだ、照合の READ の画面の path。 */
let chosenReadPath = '';
let writeFor: (index: number) => WorkerStartApiWrite = () => {
  throw new Error('the scenario is not prepared');
};
/** OP-REV6 の I-1: 期待を人の名前の欄に替えた版の書き込みの指定（作れなければ null）。`uniqueOf` は、親が渡す「実行のたびに違う値になる欄」。 */
let nameWriteFor: (index: number, values: Record<string, string>, uniqueOf: readonly string[]) => WorkerStartApiWrite | null = () => null;
/** OP-REV6 の I-1: 入力の規則から求めた、実行のたびに違う値になる欄（本番の判定）と、変わりうる欄の判定の前の形（RED の確かめに使った）。 */
let uniqueFieldNames: readonly string[] = [];
/** シナリオの送る欄。 */
let scenarioFieldNames: readonly string[] = [];
let caseNumber = 0;

const memberPosts = (): number => site.requests
  .filter((request) => request.origin === 'backend' && request.method === 'POST' && request.path.startsWith(SPA_BACKEND_PATHS.members)).length;
const nonReads = (): number => site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method)).length;
/** 届いた、アプリの画面への GET（`since` 番目の記録から。path で選ぶ）。 */
const pageReads = (since: number, path: string): number => site.requests.slice(since)
  .filter((request) => request.origin === 'app' && request.method === 'GET' && request.path === path).length;
/** 届いた、会員の詳細の画面の形（`/admin/members/<番号>`）への GET。 */
const detailReads = (since: number): number => site.requests.slice(since)
  .filter((request) => request.origin === 'app' && request.method === 'GET' && /^\/admin\/members\/[0-9]+$/u.test(request.path)).length;
const backendRequests = (since: number, method: string, path: string): number => site.requests.slice(since)
  .filter((request) => request.origin === 'backend' && !request.preflight && request.method === method && request.path.startsWith(path)).length;

beforeAll(async () => {
  site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberListPage: true });
  directory = await mkdtemp(join(tmpdir(), 'beaksight-api-write-list-'));
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
  // 本番の自動の下書きの選び方（データのない形の推しの登録。点検の段のリンクに、一覧の画面と登録の画面がある）。
  const choice = autoDraftReadCheckChoiceOf({
    createPagePath: SPA_APP_PATHS.memberNew, readPagePaths: discoveryReadPagePaths(document), definitions: [], maxDefinitions: MAX_TEST_DEFINITIONS,
    withoutData: true, auditLinkPaths: [SPA_APP_PATHS.admin, SPA_MEMBER_LIST_PATH, SPA_APP_PATHS.memberNew],
  });
  if (choice.kind === 'NOT_INFERRED') throw new Error('no READ page was chosen');
  chosenReadPath = choice.template.value;
  const created = createApiCreateScenario(database, {
    profileId: PROFILE_ID, scenarioId: SCENARIO_ID, readCheckId: READ_CHECK_ID, site, document, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    at: nowText, readTargetPagePath: chosenReadPath,
  });
  const revision = readScenarioRevisions(database, SCENARIO_ID).find(({ revision: value }) => value === created.scenario.revision);
  const readCheck = listReadChecks(database, PROFILE_ID).find(({ readCheckId }) => readCheckId === READ_CHECK_ID);
  if (revision === undefined || readCheck === undefined) throw new Error('the scenario revision or the READ check is missing');
  const rules = readLatestRuleSet(database, SCENARIO_ID);
  if (rules === null) throw new Error('the input rules are missing');
  scenarioFieldNames = revision.scenario.fieldNames;
  uniqueFieldNames = uniqueEachRunFieldNamesOf(planRuleSet(rules.ruleSet, revision.scenario, revision.evidence));
  const specOf = (scenario: ScenarioRevision, values: Record<string, string>, uniqueOf: readonly string[]) => writeStartSpecOf({
    scenario, evidence: revision.evidence, grantId: GRANT_ID, values, readCheck, uniqueEachRunFieldNames: uniqueOf,
    targetPage: { origin: site.appOrigin, path: chosenReadPath }, profileId: PROFILE_ID,
    seedRecord: {
      seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
      seedInput: { profileId: PROFILE_ID, scenarioId: SCENARIO_ID, scenarioRevision: revision.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
        executionGrantId: GRANT_ID },
      baseDate: '2026-11-02',
      attempt: 0,
    },
    approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: SCENARIO_ID, scenarioRevision: revision.revision, grantId: GRANT_ID }),
  });
  const read = revision.scenario.verification.readVerification;
  if (read === null) throw new Error('the scenario has no READ verification');
  const nameScenario: ScenarioRevision = {
    ...revision.scenario,
    verification: { ...revision.scenario.verification, readVerification: { ...read, expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] } },
  };
  nameWriteFor = (_index, values, uniqueOf) => {
    const spec = specOf(nameScenario, values, uniqueOf);
    return spec !== null && isWorkerStartApiWrite(spec) ? spec : null;
  };
  writeFor = (index: number): WorkerStartApiWrite => {
    const spec = writeStartSpecOf({
      uniqueEachRunFieldNames: uniqueFieldNames,
      scenario: revision.scenario, evidence: revision.evidence, grantId: GRANT_ID, values: valuesFor(revision.scenario.fieldNames, index), readCheck,
      // ジョブの管理（`#readCheckLaunches`）と同じく、画面の path の定義の対象の画面は、開始の URL の Origin とその path。
      targetPage: { origin: site.appOrigin, path: chosenReadPath }, profileId: PROFILE_ID,
      seedRecord: {
        seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
        seedInput: { profileId: PROFILE_ID, scenarioId: SCENARIO_ID, scenarioRevision: revision.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
          executionGrantId: GRANT_ID },
        baseDate: '2026-11-02',
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

describe.each(LAUNCHERS)('OP-R (R1): the verification READ of an API create on the list page with %s', (label, launch) => {
  let expectedPosts = 0;
  let expectedOtherNonReads = 0;
  let postsBefore = 0;
  let nonReadsBefore = 0;

  beforeAll(() => {
    postsBefore = memberPosts();
    nonReadsBefore = nonReads();
  });

  afterEach(() => {
    expect(memberPosts() - postsBefore, 'member POSTs that reached the server').toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore, 'non-read requests that reached the server').toBe(expectedPosts + expectedOtherNonReads);
  });

  afterAll(async () => {
    await sleep(LATE_DELIVERY_SETTLE_MS);
    expect(memberPosts() - postsBefore).toBe(expectedPosts);
    expect(nonReads() - nonReadsBefore).toBe(expectedPosts + expectedOtherNonReads);
  }, TEST_TIMEOUT_MS);

  const runWrite = async (
    auditSendPolicy: 'READ_ONLY' | 'PASS_EXCEPT_DELETE',
    write?: WorkerStartApiWrite,
  ): Promise<{ readonly document: ActionRunDocument; readonly since: number }> => {
    caseNumber += 1;
    site.setMemberSaveResponse('markedRepresentation');
    const since = site.requests.length;
    const outputDirectory = join(directory, `output-${String(caseNumber)}`);
    const outcome = await executeWriteCreateRun({
      config: spaApiWriteConfigOf(site, outputDirectory, { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS }, audit: { sendPolicy: auditSendPolicy } }),
      jobId: `job-api-list-${String(caseNumber)}`,
      authentication: spaRunAuthenticationOf(site),
      write: write ?? writeFor(caseNumber),
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      recheck: () => Promise.resolve(ALLOWED),
      reportSubmission: () => undefined,
      resultTimeoutMs: RESULT_TIMEOUT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    site.setMemberSaveResponse(null);
    if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
    return { document, since };
  };

  it(`chooses the list page one above the create page, reads it once and verifies the created value (${label})`, async () => {
    expect(chosenReadPath).toBe(SPA_MEMBER_LIST_PATH);
    // OP-REV6 の I-1: 期待は、実行のたびに違う値になる欄（メール）と比べる。人の名前は、その欄に入らない。
    expect(uniqueFieldNames).toContain('email');
    expect(uniqueFieldNames).not.toContain('name');
    expect(writeFor(caseNumber + 1).readVerification.definition.expectations).toEqual([expect.objectContaining({ kind: 'TEXT_CONTAINS' })]);
    const run = await runWrite('PASS_EXCEPT_DELETE');
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', responseJudgement: 'SUCCESS', readVerification: { readCheckId: READ_CHECK_ID, result: 'MATCHED' },
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
    });
    expect(run.document.recordId).toMatch(/^[0-9]+$/u);
    // 一覧の画面への GET は 1 回だけ。詳細の画面は読まない。一覧の手続きの呼び出しは 1 回届いた（送信の扱いで通した、サイトが自動で送る読み取りの手続き）。
    expect(pageReads(run.since, SPA_MEMBER_LIST_PATH)).toBe(1);
    expect(detailReads(run.since)).toBe(0);
    expect(backendRequests(run.since, 'POST', SPA_BACKEND_PATHS.rpcListMembers)).toBe(1);
    expectedOtherNonReads += 1;
    // 一覧の画面からの更新（PATCH）は届かない（押さない）。
    expect(backendRequests(run.since, 'PATCH', SPA_BACKEND_PATHS.members)).toBe(0);
  }, TEST_TIMEOUT_MS);

  // OP-REV6 の I-1: 期待が人の名前で、前の登録と同じ名前が一覧にあり、新しい登録が一覧にまだ出ていない場面。本番の判定（実行のたびに違う値になる欄）では、書き込みの
  // 指定を作らない（送らない。`VERIFIED` と報告しない）。登録は届かない。
  it(`does not make a list page verification compared with a person name that a former registration on the list has (OP-REV6 I-1) (${label})`, async () => {
    const sameName = `OP-R 同じ名前 ${String(caseNumber)}`;
    site.addMember(sameName, { email: `op-r-former-${String(caseNumber)}@example.invalid` });
    site.setMemberListRpcLimit(site.memberCount);
    try {
      const values = { ...valuesFor(scenarioFieldNames, caseNumber + 1), name: sameName };
      const write = nameWriteFor(caseNumber + 1, values, uniqueFieldNames);
      if (write !== null) {
        // 作ってしまったときは、実際に流して、前の登録の名前で一致して `VERIFIED` と報告しないかを見る（RED の確かめの道）。
        const run = await runWrite('PASS_EXCEPT_DELETE', write);
        expectedPosts += 1;
        expectedOtherNonReads += 1;
        expect(run.document.result, 'a former registration with the same name must not verify the new one').not.toBe('VERIFIED');
      }
      expect(write).toBeNull();
    } finally {
      site.setMemberListRpcLimit(null);
    }
  }, TEST_TIMEOUT_MS);

  // 読み取りだけ（`READ_ONLY`）なら、今どおり、一覧の手続きの呼び出しも止める（届かない。確かめられないので `VERIFIED` にしない）。端末の負荷を抑えるため、テストの
  // 既定の Chromium だけで確かめる。
  if (label === LAUNCHERS[0]?.[0]) {
    it(`does not claim the verification when the data procedure call of the list page is stopped with READ_ONLY (${label})`, async () => {
      const run = await runWrite('READ_ONLY');
      expectedPosts += 1;
      expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS' });
      expect(run.document.result).not.toBe('VERIFIED');
      expect(backendRequests(run.since, 'POST', SPA_BACKEND_PATHS.rpcListMembers)).toBe(0);
    }, TEST_TIMEOUT_MS);
  }
});
