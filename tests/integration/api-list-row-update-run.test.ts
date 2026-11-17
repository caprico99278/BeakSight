// LU-10（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 4.0 の D2〜D4、4.0.1 の K1・K3、5.3 の 2、5.5、5.7、8 章の「書き込みのジョブ」）:
// ワーカーの一覧の行から開く API の更新の流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun` に、`update.listRow` のある送り方 API の UPDATE の
// 書き込みの指定を渡す）を、同じ process の中で、本物の factory と Guard、本物の Chromium（テストの既定の headless）と、127.0.0.1 の仮のサイト（`fixtures/list-row-update-site.ts` の書き込みの段の場面）で確かめる結合テスト。
// - 書き込みの指定は本番の部品で作る: 凍結した Context の操作さがし（`probeDiscoveredSubmissions`）で見た窓の中の保存の候補から、下書きの確かめ
//   （`validateScenarioDraft`。台帳の行の選び方 `listRow`）と開始の指定（`writeStartSpecOf`）を作り、IPC の契約（`validateParentToWorkerMessage`）を通す。
// - 正常: A_FILTER・A_PATH は、届く読み取りでない要求が台帳の番号の行への PATCH の 1 件だけで、変えた欄だけが変わり（サーバの状態で確かめる）、`VERIFIED`。
//   A_DRAFT は、開き手を押した時のサイトの下書きの POST が通り（N2）、Guard の記録（`action-evidence.json` の `guard.passedRequests`）に残り、更新は `VERIFIED`。
// - 送らない: 行が 0・2（`ROW_NOT_UNIQUE`）、開き手がない（`OPENER_NOT_FOUND`）、名前のないアイコンだけ（`OPENER_UNNAMED`）、前の値が台帳と違う
//   （`KNOWN_KEPT_VALUE_MISMATCH`）、照合へ回す送信先を作れない番号（`TARGET_RECORD_UNUSABLE`。Context を作る前）。どれも PATCH は届かない。
// - 削除の要求は、どの場面でもサーバに届かない。
// - LU-SFIX2-A（LU-SREV2 の S5）: 開き手を押したときにページが続けて送る、承認した送信先・その下・表の一覧の path（A_PATH）への要求と DELETE は、窓の前（N2）
//   でも止まる（サーバに届かない）。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。値は合成のテストデータだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LIST_ROW_UPDATE_ELEMENTS,
  LIST_ROW_UPDATE_PATHS,
  LIST_ROW_UPDATE_WRITE_SCREENS,
  startListRowUpdateSite,
  type ListRowUpdateShape,
  type ListRowUpdateSite,
  type ListRowUpdateWriteItem,
} from '../../fixtures/list-row-update-site.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { ActionEvidenceDocument, ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import type { RecordValueWrite } from '../../src/control/actions/write-result-facts.js';
import type { ScenarioKindFact, ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { ReadCheckView } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerStartApiWrite,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
  type WorkerStartApiWrite,
} from '../../src/control/worker-protocol.js';
import { ACTION_EVIDENCE_ARTIFACT_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoverPageCandidates, probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import { locationOfUrl, probePageCandidates } from '../../src/discovery/probe.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { browserSharedForRun } from '../helpers/browser-proxies.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { PROBE_FACTORY_OPTIONS, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { ALL_CONFIRMED, PROFILE_ID, sampleScenario } from '../unit/approval-samples.js';

const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 押した後に結果を待つ上限（ms）。 */
const RESULT_TIMEOUT_MS = 5_000;
/** 全部の場面の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** 操作さがしの、押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 操作さがしの、遅れて届く要求を待つ時間（ms）。 */
const PROBE_LATE_REQUEST_WAIT_MS = 500;
/** 画面の準備を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
const LEDGER_ID = 'scenario-lu10-create';
const READ_CHECK_ID = 'rc-lu10-list';
const GRANT_ID = 'grant-lu10';
const SESSION_LOST_PATH = '/login';
const SHA256_HEX_LENGTH = 64;
const ALLOWED = Object.freeze({ allowed: true });
/** 行を選ぶ欄（台帳の登録の、毎回違う欄）と変える欄。 */
const ROW_KEY_FIELD = 'tag';
const CHANGED_FIELD = 'name';
/** 更新の対象の行の番号（真ん中の行）。 */
const TARGET_ID = 2;

/** 場面ごとの行（対象の行の行を選ぶ値は場面ごとに違う。ほかの行は同じ形）。 */
const itemsFor = (caseLabel: string, targetCode: string): ListRowUpdateWriteItem[] => [
  { id: 1, tag: `lu10-${caseLabel}-other-1`, name: 'item one' },
  { id: TARGET_ID, tag: targetCode, name: 'item two' },
  { id: 3, tag: `lu10-${caseLabel}-other-3`, name: 'item three' },
];

let site: ListRowUpdateSite;
let directory = '';
let caseNumber = 0;

beforeAll(async () => {
  site = await startListRowUpdateSite();
  directory = await mkdtemp(join(tmpdir(), 'beaksight-api-list-row-update-run-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await site?.close();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}, SUITE_TIMEOUT_MS);

/** 読み取りでない要求と事前確認（`since` 番目の記録から）。 */
const nonReadsSince = (since: number): readonly string[] => site.requests.slice(since)
  .filter((request) => request.preflight || !READ_METHODS.has(request.method))
  .map(({ origin, method, path }) => `${origin} ${method} ${path}`);
const deletes = (): number => site.requests.filter((request) => request.method === 'DELETE').length;

/** 設定（一覧の画面から。出力先は `outputDirectory`。送信の扱いはサイトの既定の `PASS_EXCEPT_DELETE`）。 */
const configOf = (listPath: string, outputDirectory: string): AuditConfig => {
  const base = fastRunConfig(site.appOrigin, listPath, {
    output: { directory: outputDirectory }, crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS }, audit: { sendPolicy: 'PASS_EXCEPT_DELETE' },
  });
  return { ...base, site: { startUrl: `${site.appOrigin}${listPath}`, allowedOrigins: [site.appOrigin] } };
};

/** 認証の指定（ログインのない仮のサイト。API の Origin を承認したサービスの Origin にする）。 */
const authenticationOf = (): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [site.appOrigin],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: SESSION_LOST_PATH,
  filterState: filterAuthenticatedState,
  auditStage: {
    approvedServiceOrigins: [site.apiOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.apiOrigin, path: '/token', requiredQuery: [] },  },
});

/** 凍結した Context で一覧の画面の操作さがしをして、窓の中の保存の候補（開き手つきの `API_UPDATE`）を返す。サーバに届く読み取りでない要求は 0。 */
async function probeSaveCandidate(browser: Browser, listPath: string): Promise<DiscoveryCandidate> {
  const since = site.requests.length;
  const config = configOf(listPath, join(directory, 'unused-probe-output'));
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
    ...PROBE_FACTORY_OPTIONS,
    authentication: {
      initialState: { cookies: [], origins: [] },
      filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
      auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      auditStage: authenticationOf().auditStage,
    },
    serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
    auditStageMonitor: new AuditStageMonitor(),
  });
  try {
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${listPath}`);
    await page.locator(`#${LIST_ROW_UPDATE_ELEMENTS.table} tbody tr`).first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
      targetPolicy: { allowedOrigins: new Set([site.appOrigin]), isExcludedPage: () => false },
      quietWaitMs: SHORT_QUIET_WAIT_MS,
    });
    await sleep(PROBE_LATE_REQUEST_WAIT_MS);
    expect(nonReadsSince(since), 'non-read requests that reached the server in the probe').toEqual([]);
    const save = probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.saveText)
      && candidate.submissionProbe?.result === 'API_UPDATE' && candidate.submissionProbe.opener !== undefined);
    if (save === undefined) throw new Error(`the probe found no save with an opener on ${listPath}`);
    return save;
  } finally {
    await factory.close();
  }
}

/**
 * 名前のないアイコンだけの開き手の識別の digest（画面を読むだけ。押さない）。凍結しない Passive の Context で読み、行の中の、削除の語のない名前のない候補の
 * 識別の digest（押す部品と同じ `probedCandidateIdentityDigestOf`）。
 */
async function iconOpenerDigestOf(browser: Browser, listPath: string): Promise<string> {
  const config = configOf(listPath, join(directory, 'unused-icon-output'));
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  try {
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${listPath}`);
    await page.locator(`#${LIST_ROW_UPDATE_ELEMENTS.table} tbody tr`).first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const probe = await probePageCandidates(page, Date.now() + UI_TIMEOUT_MS);
    if (probe.status !== 'READ') throw new Error('the list page was not probed');
    const icon = probe.candidates.find((candidate) => !candidate.hasSubmitterText && !candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.removeText)
      && candidate.submitter !== undefined);
    if (icon === undefined) throw new Error('the list page has no icon-only opener');
    return probedCandidateIdentityDigestOf(locationOfUrl(page.url()).location, icon);
  } finally {
    await factory.close();
  }
}

/** 台帳の登録（番号の鍵は応答の本文の `id`、毎回違う欄は行を選ぶ欄）。 */
const ledgerFactOf = (): ScenarioKindFact => Object.freeze<ScenarioKindFact>({
  scenarioId: LEDGER_ID,
  profileId: PROFILE_ID,
  kind: 'CREATE',
  apiRequest: { origin: site.apiOrigin, pathShape: LIST_ROW_UPDATE_PATHS.items },
  apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  uniqueEachRunFieldNames: [ROW_KEY_FIELD],
});

/** 下書きの確かめ（本番の部品）が作る、一覧の行の更新のシナリオの版（変える鍵は名前、保つ鍵と行を選ぶ欄は `tag`）。 */
const listRowScenarioOf = (candidate: DiscoveryCandidate, listPath: string, filterName: string | null): ScenarioRevision => {
  const opener = candidate.submissionProbe?.opener;
  if (opener === undefined) throw new Error('the candidate has no opener');
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: candidate.identityDigest,
    transport: 'API',
    fieldNames: [CHANGED_FIELD],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: {
      resultJudgement: null, recordId: null,
      readVerification: {
        readCheckId: READ_CHECK_ID, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: CHANGED_FIELD }], verificationOnly: true,
      },
    },
    api: {
      shapeDigest: candidate.submissionProbe?.shapeDigest,
      pageKeys: [],
      filterName,
      recordId: null,
      ledger: {
        targetCreateScenarioId: LEDGER_ID, formPathTemplate: listPath,
        listRow: { listPagePath: listPath, openerIdentityDigest: opener.identityDigest, rowKeyField: ROW_KEY_FIELD },
      },
      keptKeys: [ROW_KEY_FIELD],
    },
  }, candidate, [
    { readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pagePath: listPath },
  ] as never, {
    scenarioId: null,
    scenarios: [ledgerFactOf()],
    approvedServiceOrigins: [site.apiOrigin],
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  return { ...sampleScenario(), ...result.content, inputRuleReference: null } as ScenarioRevision;
};

/** 開始の指定（本番の `writeStartSpecOf`。台帳の照合済みの登録は対象の行の `tag` と前の名前）。IPC の契約も通す。 */
const writeOf = (
  scenario: ScenarioRevision,
  candidate: DiscoveryCandidate,
  listPath: string,
  ledgerCode: string,
  newName: string,
): WorkerStartApiWrite => {
  const ledgerWrites: readonly RecordValueWrite[] = [{
    writeKind: 'CREATE', recordId: String(TARGET_ID), targetRecordId: null, result: 'VERIFIED',
    submittedValues: { [ROW_KEY_FIELD]: ledgerCode, [CHANGED_FIELD]: 'item two' }, submittedAt: '20261103000000', recordedAt: '20261103000000',
  }];
  const readCheck: ReadCheckView = {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, createdAt: '20261103000000', updatedAt: '20261103000000', canceledAt: null,
    definition: { targetPagePath: listPath, parameters: {}, expectations: [] } as unknown as ReadCheckDefinition,
  };
  const spec = writeStartSpecOf({
    scenario, evidence: candidate, grantId: GRANT_ID, profileId: PROFILE_ID,
    seedRecord: {
      seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
      seedInput: { profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
        executionGrantId: GRANT_ID },
      baseDate: '2026-11-03',
      attempt: 0,
    } as never,
    values: { [CHANGED_FIELD]: newName },
    readCheck,
    targetPage: { origin: site.appOrigin, path: listPath },
    targetRecordId: String(TARGET_ID),
    ledgerWrites,
    ledgerUniqueEachRunFieldNames: [ROW_KEY_FIELD],
    approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
  });
  if (spec === null || !isWorkerStartApiWrite(spec)) throw new Error('the list row API write specification was not built');
  expect(spec.update?.listRow).toEqual({ rowKeyValue: ledgerCode, deferredPriorValues: { keptKeys: [ROW_KEY_FIELD] } });
  expect(ipcErrorsOf(spec)).toEqual([]);
  return spec;
};

/** IPC の契約の誤り（`START` に入れて確かめる）。 */
const ipcErrorsOf = (write: WorkerStartApiWrite): readonly string[] => {
  const setup: AuthSetup = Object.freeze({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: PROFILE_ID,
    profileRevision: 1,
    loginStartUrl: `${site.appOrigin}${SESSION_LOST_PATH}`,
    loginPostEndpoints: [{ origin: site.appOrigin, path: SESSION_LOST_PATH }],
    successCondition: { pathPrefix: '/items', selector: null },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [],
    auditPathPrefixes: ['/items'],
    maxLoginAttempts: 2,
    allowedIdpOrigins: [],
    automatedLogin: null,
  });
  const checked = validateParentToWorkerMessage({
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'START',
    jobId: 'job-lu10',
    jobKind: 'WRITE_UPDATE',
    targetConfigPath: 'local/targets/example-lu10.json',
    startNew: true,
    targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
    authentication: {
      setup,
      approvedTestOrigins: [site.appOrigin],
      approvedServiceOrigins: [site.apiOrigin],
      authenticationSha256: workerAuthenticationDigestOf(setup, [site.appOrigin], {
        jobKind: 'WRITE_UPDATE', automatedLogin: null, approvedServiceOrigins: [site.apiOrigin],
      }),
    },
    write,
  });
  return checked.ok ? [] : checked.errors;
};

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('LU-10: the list row API update write flow with %s', (label, launch) => {
  let browser: Browser;
  /** 形ごとの、操作さがしの保存の候補とシナリオ。 */
  const prepared = new Map<ListRowUpdateShape, { readonly candidate: DiscoveryCandidate; readonly scenario: ScenarioRevision }>();
  let deletesBefore = 0;
  let caseSince = 0;
  /** 場面ごとに期待する、サーバに届く読み取りでない要求（`origin method path`）。 */
  let expectedNonReads: readonly string[] = [];
  /** この Chromium の場面すべてで届いた読み取りでない要求の数（全部の後に数え直す）。 */
  let suiteSince = 0;
  let suiteExpected = 0;
  /** 名前のないアイコンだけの開き手の識別の digest（D3 の守りを確かめるために、開始の指定に入れる）。 */
  let unnamedOpenerDigest = '';

  beforeAll(async () => {
    browser = await launch();
    for (const shape of ['A_FILTER', 'A_PATH', 'A_DRAFT'] as const) {
      site.setWriteOpener('NAMED');
      site.setWriteItems(itemsFor(`probe-${shape}`, `lu10-probe-${shape}-target`));
      const listPath = LIST_ROW_UPDATE_WRITE_SCREENS[shape];
      const candidate = await probeSaveCandidate(browser, listPath);
      prepared.set(shape, { candidate, scenario: listRowScenarioOf(candidate, listPath, shape === 'A_PATH' ? null : 'id') });
    }
    site.setWriteOpener('UNNAMED');
    site.setWriteItems(itemsFor('probe-unnamed', 'lu10-probe-unnamed-target'));
    unnamedOpenerDigest = await iconOpenerDigestOf(browser, LIST_ROW_UPDATE_WRITE_SCREENS.A_DRAFT);
    site.setWriteOpener('NAMED');
    // W-FIX: 書き込みの流れは、この Browser を共有する（`browserSharedForRun`）。ここでは閉じず、組の終わりに閉じる。
    deletesBefore = deletes();
    suiteSince = site.requests.length;
  }, SUITE_TIMEOUT_MS);

  afterEach(() => {
    expect(nonReadsSince(caseSince), 'non-read requests that reached the server').toEqual(expectedNonReads);
    expect(deletes() - deletesBefore, 'DELETE requests that reached the server').toBe(0);
    suiteExpected += expectedNonReads.length;
    site.setWriteOpener('NAMED');
    site.setWriteScene({ localEcho: false, ignorePatch: false, cookieEcho: false });
    site.setWriteOpenerSends([]);
  });

  afterAll(async () => {
    await browser?.close();
    await sleep(LATE_DELIVERY_SETTLE_MS);
    expect(nonReadsSince(suiteSince)).toHaveLength(suiteExpected);
    expect(deletes() - deletesBefore).toBe(0);
  }, TEST_TIMEOUT_MS);

  /** 場面を準備して、書き込みの流れを 1 回流す（行・開き手の形・開始の指定の書き換えを受ける）。 */
  const runCase = async (
    shape: ListRowUpdateShape,
    options: {
      readonly items?: (code: string, newName: string) => ListRowUpdateWriteItem[];
      readonly ledgerCode?: (code: string) => string;
      readonly opener?: 'NAMED' | 'UNNAMED' | 'NONE';
      readonly tamper?: (write: WorkerStartApiWrite) => WorkerStartApiWrite;
      readonly expected: (newName: string) => readonly string[];
    },
  ): Promise<{
    readonly run: ActionRunDocument; readonly evidence: ActionEvidenceDocument; readonly newName: string; readonly code: string; readonly since: number;
  }> => {
    caseNumber += 1;
    const entry = prepared.get(shape);
    if (entry === undefined) throw new Error(`the shape ${shape} is not prepared`);
    const listPath = LIST_ROW_UPDATE_WRITE_SCREENS[shape];
    const code = `lu10-${String(caseNumber)}-target`;
    const newName = `LU-10 新しい名前 ${String(caseNumber)}`;
    site.setWriteItems(options.items?.(code, newName) ?? itemsFor(String(caseNumber), code));
    site.setWriteOpener(options.opener ?? 'NAMED');
    const built = writeOf(entry.scenario, entry.candidate, listPath, options.ledgerCode?.(code) ?? code, newName);
    const write = options.tamper?.(built) ?? built;
    expectedNonReads = options.expected(newName);
    caseSince = site.requests.length;
    const outputDirectory = join(directory, `output-${String(caseNumber)}`);
    const outcome = await executeWriteCreateRun({
      config: configOf(listPath, outputDirectory),
      jobId: `job-lu10-${String(caseNumber)}`,
      authentication: authenticationOf(),
      write,
      // SLIM-2（X7）: 流れごとに Chromium を起こさず、この組の Browser を共有する（Context は流れごと）。
      launchBrowser: async () => browserSharedForRun(browser),
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      recheck: () => Promise.resolve(ALLOWED),
      reportSubmission: () => undefined,
      resultTimeoutMs: RESULT_TIMEOUT_MS,
      observationWindows: TEST_OBSERVATION_WINDOWS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
    const run = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
    const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as ActionEvidenceDocument;
    return { run, evidence, newName, code, since: caseSince };
  };

  const patchOf = (shape: ListRowUpdateShape): string =>
    `api PATCH ${shape === 'A_PATH' ? `${LIST_ROW_UPDATE_PATHS.items}/${String(TARGET_ID)}` : LIST_ROW_UPDATE_PATHS.items}`;

  // SLIM W-3: 形（A_FILTER・A_PATH・A_DRAFT）の掛け算を減らした。成功は A_FILTER と A_DRAFT（下の N2）の 2 つ、窓の前の止めは A_FILTER と A_PATH、ほかは 1 形。
  // 行と開き手の選び方は単体（`scenario-list-row-ledger`・`api-list-row-update-start`）が確かめる。
  it.each(['A_FILTER'] as const)(`sends only the PATCH of the ledger row and verifies it on the list (%s, ${label})`, async (shape) => {
    const { run, newName, code, since } = await runCase(shape, { expected: () => [patchOf(shape)] });
    // 5.7: 一覧の画面の読み込みは、送る前の READ の 1 回（LU-SFIX4）、書き込みの段の 1 回と照合の READ の 1 回だけ（ページ送り・検索・読み込み直しをしない）。
    expect(site.requests.slice(since).filter((request) => request.origin === 'app' && request.method === 'GET'
      && request.path === LIST_ROW_UPDATE_WRITE_SCREENS[shape])).toHaveLength(3);
    expect(run).toMatchObject({
      submission: 'SENT', responseJudgement: 'SUCCESS', recordId: String(TARGET_ID),
      readVerification: { readCheckId: READ_CHECK_ID, result: 'MATCHED' }, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
      update: { targetRecordId: String(TARGET_ID), updateEvidence: { fields: [{ fieldName: CHANGED_FIELD, role: 'CHANGED', matched: true }] } },
    });
    // 変えたのは対象の行の名前だけ（行を選ぶ欄と、ほかの行は変わらない）。
    const after = site.writeItems();
    expect(after.find(({ id }) => id === TARGET_ID)).toEqual({ id: TARGET_ID, tag: code, name: newName });
    expect(after.filter(({ id }) => id !== TARGET_ID).map(({ name }) => name)).toEqual(['item one', 'item three']);
    // 行を選ぶ値は記録に出ない（`values` と同じ扱いの値は、送った欄のほかに書かない）。
    expect(JSON.stringify(run)).not.toContain(code);
  }, TEST_TIMEOUT_MS);

  // K3: 照合の READ の行の確かめ。新しい値が、選んだ行のほかの行にもある（含む行がちょうど 1 つでない）ときは、送ったが確かめられない（`VERIFIED` にしない）。
  it(`does not claim the verification when the new value is not only in the chosen row (${label})`, async () => {
    const { run } = await runCase('A_FILTER', {
      items: (code, newName) => [...itemsFor('shared', code).filter(({ id }) => id !== 3), { id: 3, tag: 'lu10-shared-other-3', name: newName }],
      expected: () => [patchOf('A_FILTER')],
    });
    expect(run).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', readVerification: { result: 'UNDETERMINED' } });
    expect(run.result).not.toBe('VERIFIED');
    expect(run.update?.updateEvidence?.fields).toEqual([expect.objectContaining({ fieldName: CHANGED_FIELD, role: 'CHANGED', matched: null })]);
  }, TEST_TIMEOUT_MS);

  // LU-SFIX2-B（LU-SREV2 の Important-1 の S7・S8）: 照合の READ の Context には、書き込みの段の前の世代の localStorage を渡す。ページが窓の名前を localStorage に
  // 保存し、一覧を開くとその名前を行に描く場面で、サーバが PATCH で状態を変えなければ `VERIFIED` にしない（localStorage を使わない対照と同じ）。サーバが
  // 状態を変えたときは、今のとおり `VERIFIED`。
  // LU-SFIX3-B（LU-SREV3 の Important-1 の S7c）: ページが窓の名前を document.cookie（HttpOnly でない cookie）に保存して行に描く場面も、`VERIFIED` にしない
  // （A_FILTER と A_PATH）。
  it.each<readonly [string, ListRowUpdateShape, boolean, boolean, boolean]>([
    ['the server ignores the PATCH and the page echoes the saved name', 'A_FILTER', true, true, false],
    ['the server applies the PATCH and the page echoes the saved name', 'A_FILTER', true, false, false],
    ['the server ignores the PATCH and the page echoes the name saved in a cookie (S7c)', 'A_PATH', false, true, true],
  ])(`judges by the server state when %s (%s, LU-SFIX2-B, ${label})`, async (_name, shape, localEcho, ignorePatch, cookieEcho) => {
    site.setWriteScene({ localEcho, ignorePatch, cookieEcho });
    const { run, newName } = await runCase(shape, { expected: () => [patchOf(shape)] });
    expect(run).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS' });
    expect(site.writeItems().find(({ id }) => id === TARGET_ID)?.name).toBe(ignorePatch ? 'item two' : newName);
    if (ignorePatch) {
      expect(run.result).not.toBe('VERIFIED');
      expect(['PARTIAL', 'UNKNOWN']).toContain(run.result);
      expect(run.readVerification?.result).not.toBe('MATCHED');
    } else {
      expect(run).toMatchObject({ readVerification: { result: 'MATCHED' }, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    }
  }, TEST_TIMEOUT_MS);

  // LU-SFIX5（LU-SREV4 の Important-1）: 一覧の画面のスクリプトが、最初に開かれた時刻を localStorage か HttpOnly でない cookie に記録し、一定の時間より後に開かれた
  // ときだけ、窓で入れた名前を行に描く。サーバは PATCH を受けても変えない。書き込みのジョブの中のどの Context でページが書いた値も次へ渡さないので、`VERIFIED` に
  // ならない。
  it.each<readonly [string, boolean]>([['localStorage', false]])(
    `does not verify when the page draws the saved name after a time kept in %s (A_FILTER, LU-SFIX5, ${label})`,
    async (_store, cookieEcho) => {
      site.setWriteScene({ localEcho: !cookieEcho, cookieEcho, ignorePatch: true, timeGateMs: 1_500 });
      const { run } = await runCase('A_FILTER', { expected: () => [patchOf('A_FILTER')] });
      expect(run).toMatchObject({ submission: 'SENT' });
      expect(run.result).not.toBe('VERIFIED');
      expect(run.readVerification?.result).not.toBe('MATCHED');
      expect(site.writeItems().find(({ id }) => id === TARGET_ID)?.name).toBe('item two');
    },
    TEST_TIMEOUT_MS,
  );

  // LU-SFIX4（LU-REV の I-1）: 対象の行の変える欄が、もう新しい値を語として含む（`<新しい値> old`）。サーバは PATCH を受けても変えない。送る前の READ が、選んだ行に
  // 新しい値がもう見えていると判定し、送らない（前は、サーバが変えなくても `VERIFIED` になった）。開き手も押さない（下書きの POST も届かない）。
  it.each(['A_DRAFT'] as const)(`sends nothing when the chosen row already shows the new value (%s, VALUE_ALREADY_PRESENT, ${label})`, async (shape) => {
    site.setWriteScene({ localEcho: false, ignorePatch: true });
    const { run } = await runCase(shape, {
      items: (code, newName) => itemsFor('present', code).map((item) => (item.id === TARGET_ID ? { ...item, name: `${newName} old` } : item)),
      expected: () => [],
    });
    expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'VALUE_ALREADY_PRESENT', result: 'BLOCKED' });
  }, TEST_TIMEOUT_MS);

  // RB-14a: 開き手を押した時（窓の前。N2）のページの送信の扱いは、ここでは確かめない。サイトの下書きの POST を通すことは、ずれの確かめの通り道の代表が、
  // 承認した送信先・その下・表の一覧の path を止めることは guard-api-write-stage（LU-5・N2・LU-SFIX1）が確かめる。SD-2: ページ自身の DELETE は届き、BeakSight が削除の操作をしないことは `destructive-action-guard` が確かめる。

  // SLIM W-3: 行が 0 件・開き手がない（OPENER_NOT_FOUND）の場面は、行の選び方の単体（`scenario-list-row-ledger`）に任せて外した。
  it.each<readonly [string, (code: string) => ListRowUpdateWriteItem[]]>([
    ['two rows with the row key value', (code) => [...itemsFor('twice', code), { id: 4, tag: code, name: 'item four' }]],
  ])(`sends nothing for %s (ROW_NOT_UNIQUE, ${label})`, async (_name, items) => {
    const { run } = await runCase('A_FILTER', { items, expected: () => [] });
    expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'ROW_NOT_UNIQUE', result: 'BLOCKED' });
  }, TEST_TIMEOUT_MS);

  it(`does not press an icon-only opener without a name and sends nothing (OPENER_UNNAMED, ${label})`, async () => {
    // D3: 開始の指定が名前のないアイコンの識別を持っていても（下書きの確かめは作らない形。ワーカーの守りを確かめる）、押さない。下書きの POST も届かない。
    const { run } = await runCase('A_DRAFT', {
      opener: 'UNNAMED',
      tamper: (write) => ({
        ...write,
        api: { ...write.api, ledger: { ...write.api.ledger!, listRow: { ...write.api.ledger!.listRow!, openerIdentityDigest: unnamedOpenerDigest } } },
      }),
      expected: () => [],
    });
    expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'OPENER_UNNAMED', result: 'BLOCKED' });
  }, TEST_TIMEOUT_MS);

  it(`sends nothing when the kept value on the page differs from the ledger (KNOWN_KEPT_VALUE_MISMATCH, ${label})`, async () => {
    // 台帳の値（行を選ぶ値）は、ページの値の一部（BeakSight の外で値が変わった行）。行は見つかるが、窓の保つ欄の値が台帳の値と違う。
    // LU-SFIX2-A: 行の選び方は区切りのある一致なので、ページの値は、台帳の値の後に空白の区切りで語を足した形にする（`-` で続けると、別の値として行に当たらない）。
    const { run } = await runCase('A_FILTER', { items: (code) => itemsFor('changed', `${code} changed`), expected: () => [] });
    expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH', result: 'BLOCKED' });
  }, TEST_TIMEOUT_MS);

  // 条件 4: 照合へ回す送信先（`apiWriteCheckPathOf`）を作れない期待（filter も path の番号もない更新）は、Context を作る前に止める。番号の形の誤りは、IPC と
  // 記録のスキーマが同じ形（`isUsableRecordId`）で拒むので、ここでは filter の名前を外した開始の指定で確かめる（ワーカーの守りを確かめる）。
  it(`stops before the write stage Context when the expectation makes no checked destination (TARGET_RECORD_UNUSABLE, ${label})`, async () => {
    const since = site.requests.length;
    const { run } = await runCase('A_FILTER', {
      tamper: (write) => ({ ...write, api: { ...write.api, filterName: null } }),
      expected: () => [],
    });
    expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'TARGET_RECORD_UNUSABLE', result: 'BLOCKED' });
    // 一覧の画面も読まない（書き込みの段の Context を作らない）。
    expect(site.requests.slice(since).filter(({ origin }) => origin === 'app')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
