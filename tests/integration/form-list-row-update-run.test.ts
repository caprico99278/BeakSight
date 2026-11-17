// LU-12・LU-12b（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 4.0 の D2〜D5、4.0.1 の K1・K3、5.5、5.7、8 章の「書き込みのジョブ」）:
// ワーカーの、行の下に広がるフォーム（形 B）の更新の流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun` に、`update.listRow` のある form の UPDATE の
// 書き込みの指定を渡す）を、同じ process の中で、本物の factory と Guard、本物の Chromium（テストの既定の headless）と、127.0.0.1 の仮のサイト（`fixtures/list-row-form-site.ts` の書き込みの段の場面）で確かめる結合テスト。
// - 書き込みの指定は本番の部品で作る: 凍結した Context の発見の入口と操作さがし（`probeDiscoveredSubmissions`）で見た行のフォームの候補から、下書きの確かめ
//   （`validateScenarioDraft`。UPDATE の指定の `listRow`）と開始の指定（`writeStartSpecOf`）を作り、IPC の契約（`validateParentToWorkerMessage`）を通す。
// - 正常: `IN_ROW`・`ROW_BELOW` とも、届く読み取りでない要求は台帳の番号の送信先への POST の 1 件だけで、変えた欄（題名）だけが変わり、`VERIFIED`。照合は候補の
//   READ（一覧の検索の form）に行の選び方を渡し、選んだ行に新しい値があるときだけ `VERIFIED`（ほかの行にもあれば `VERIFIED` にしない）。
// - 送らない: 行が 0・2（`ROW_NOT_UNIQUE`）、開き手がない・名前のないアイコンだけ（`OPENER_NOT_FOUND`）、送信先のフォームがない・2 つ（`FORM_NOT_READY`。入力の
//   失敗の理由は `FORM_NOT_FOUND`・`FORM_AMBIGUOUS`）、前の値が台帳と違う（`KNOWN_KEPT_VALUE_MISMATCH`）。
// - 開き手を押した時（窓の前。N2）にページが送る、承認した送信先への POST と DELETE は届かない。削除の要求は、どの場面でもサーバに届かない。
// 届いたかは fixture の記録で数える。各場面の後に数え、全部の場面の後に名前つきの時間だけ待って数え直す。出力先は一時のフォルダだけ。値は合成のテストデータだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LIST_ROW_FORM_ELEMENTS,
  LIST_ROW_FORM_PATHS,
  LIST_ROW_FORM_TIME_GATE_STORES,
  startListRowFormSite,
  type ListRowFormLayout,
  type ListRowFormSite,
  type ListRowFormWriteItem,
  type ListRowFormWriteScene,
} from '../../fixtures/list-row-form-site.js';
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
  type WorkerStartWrite,
} from '../../src/control/worker-protocol.js';
import { ACTION_EVIDENCE_ARTIFACT_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import type { ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { DEFAULT_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { PROBE_FACTORY_OPTIONS, TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { ALL_CONFIRMED, PROFILE_ID, sampleScenario } from '../unit/approval-samples.js';

const LAYOUTS: readonly ListRowFormLayout[] = ['IN_ROW', 'ROW_BELOW'];
const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 押した後に結果を待つ上限（ms）。 */
const RESULT_TIMEOUT_MS = 5_000;
/** 全部の場面の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** 操作さがしの、押した後に静まるまで待つ時間（ms。テストの値）。 */
const SHORT_QUIET_WAIT_MS = 300;
/** 操作さがしの、遅れて届く要求を待つ時間（ms）。 */
const PROBE_LATE_REQUEST_WAIT_MS = 500;
/** 画面の準備を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
const LEDGER_ID = 'scenario-lu12-create';
const READ_CHECK_ID = 'rc-lu12-search';
const GRANT_ID = 'grant-lu12';
const SESSION_LOST_PATH = '/login';
const SHA256_HEX_LENGTH = 64;
const ALLOWED = Object.freeze({ allowed: true });
const E = LIST_ROW_FORM_ELEMENTS;
/** 行を選ぶ欄（台帳の登録の毎回違う欄。保つ欄）と変える欄。 */
const ROW_KEY_FIELD = E.emailField;
const CHANGED_FIELD = E.titleField;
/** 更新の対象の行の番号（真ん中の行）。 */
const TARGET_ID = 2;
const TARGET_POST = `POST ${LIST_ROW_FORM_PATHS.list}/${String(TARGET_ID)}`;
/** LU-SFIX5: 登録の場面で、サーバが足す行の番号と、登録の POST。 */
const CREATE_RECORD_ID = 99;
const CREATE_POST = `POST ${LIST_ROW_FORM_PATHS.list}`;

/** 場面ごとの行（対象の行のメールは場面ごとに違う。ほかの行は同じ形）。 */
const itemsFor = (caseLabel: string, targetEmail: string): ListRowFormWriteItem[] => [
  { id: 1, title: 'item one', email: `lu12-${caseLabel}-1@example.invalid` },
  { id: TARGET_ID, title: 'item two', email: targetEmail },
  { id: 3, title: 'item three', email: `lu12-${caseLabel}-3@example.invalid` },
];

let directory = '';
let caseNumber = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'beaksight-form-list-row-update-run-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}, SUITE_TIMEOUT_MS);

/** 設定（一覧の画面から。出力先は `outputDirectory`。送信の扱いは既定の `PASS_EXCEPT_DELETE`）。 */
const configOf = (origin: string, outputDirectory: string): AuditConfig => createTestConfig(origin, LIST_ROW_FORM_PATHS.list, {
  crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
  audit: { screenshots: false, sendPolicy: 'PASS_EXCEPT_DELETE' },
  output: { directory: outputDirectory },
});

/** 認証の指定（ログインのない仮のサイト）。 */
const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: SESSION_LOST_PATH,
  filterState: filterAuthenticatedState,
});

/** 凍結した Context で一覧の画面の発見と操作さがしをして、押した行のフォームの候補と検索の候補を返す。サーバに届く読み取りでない要求は 0。 */
async function probeListPage(browser: Browser, site: ListRowFormSite): Promise<{ readonly form: DiscoveryCandidate; readonly search: DiscoveryCandidate }> {
  const since = site.requests.length;
  const config = configOf(site.origin, join(directory, 'unused-probe-output'));
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), PROBE_FACTORY_OPTIONS);
  try {
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.origin}${LIST_ROW_FORM_PATHS.list}`);
    await page.locator('main h1').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.origin]) } });
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
      targetPolicy: { allowedOrigins: new Set([site.origin]), isExcludedPage: () => false },
      quietWaitMs: SHORT_QUIET_WAIT_MS,
    });
    await sleep(PROBE_LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(since).filter(({ method }) => !READ_METHODS.has(method)), 'non-read requests in the probe').toEqual([]);
    // 押した行（最初の行）のフォーム（欄が見える形に読み直された候補）。
    const form = probed.candidates.find((candidate) => candidate.kind === 'FORM' && candidate.submitterWords.includes(E.saveText)
      && candidate.rowOpener !== undefined && candidate.fields.every(({ hidden }) => !hidden));
    const search = probed.candidates.find((candidate) => candidate.formMethod === 'GET' && candidate.classification === 'READ');
    if (form === undefined || search === undefined) throw new Error('the probe found no row form or no search form');
    return { form, search };
  } finally {
    await factory.close();
  }
}

/** 台帳の登録（行を選ぶ欄のメールは毎回違う欄）。 */
const ledgerFactOf = (): ScenarioKindFact => Object.freeze<ScenarioKindFact>({
  scenarioId: LEDGER_ID,
  profileId: PROFILE_ID,
  kind: 'CREATE',
  formRecordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${LIST_ROW_FORM_PATHS.list}/{id}`] },
  uniqueEachRunFieldNames: [ROW_KEY_FIELD, CHANGED_FIELD],
} as ScenarioKindFact);

/** 下書きの確かめ（本番の部品）が作る、形 B の更新のシナリオの版（変える欄は題名、保つ欄と行を選ぶ欄はメール）。 */
const listRowScenarioOf = (form: DiscoveryCandidate, search: DiscoveryCandidate): ScenarioRevision => {
  const opener = form.rowOpener;
  if (opener === undefined) throw new Error('the form has no row opener');
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: form.identityDigest,
    fieldNames: [CHANGED_FIELD],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: {
      recordId: null,
      readVerification: {
        readCheckId: READ_CHECK_ID, revision: 1, bindings: [{ parameterName: E.searchField, fieldName: CHANGED_FIELD }],
        expectations: [{ kind: 'TEXT_CONTAINS', fieldName: CHANGED_FIELD }], verificationOnly: true,
      },
    },
    update: {
      targetCreateScenarioId: LEDGER_ID,
      formPathTemplate: LIST_ROW_FORM_PATHS.list,
      actionPathTemplate: `${LIST_ROW_FORM_PATHS.list}/{id}`,
      keepFieldNames: [ROW_KEY_FIELD],
      listRow: { listPagePath: LIST_ROW_FORM_PATHS.list, openerIdentityDigest: opener.identityDigest, rowKeyField: ROW_KEY_FIELD },
    },
  }, form, [
    { readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [E.searchField], targetIdentityDigest: search.identityDigest },
  ] as never, {
    scenarioId: null,
    scenarios: [ledgerFactOf()],
    profileRevisions: { discoveryJob: 2, current: 2 },
  });
  if (!result.ok) throw new Error(`the draft was rejected: ${JSON.stringify(result.errors)}`);
  return { ...sampleScenario(), ...result.content, inputRuleReference: null } as ScenarioRevision;
};

/**
 * LU-SFIX5: 登録の form の候補（登録の画面を凍結した Context で読む。押さない）。登録の照合と送る前の READ は、更新と同じ一覧の検索の候補の READ。
 */
async function discoverCreateForm(browser: Browser, site: ListRowFormSite): Promise<DiscoveryCandidate> {
  const config = configOf(site.origin, join(directory, 'unused-create-output'));
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  try {
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.origin}${LIST_ROW_FORM_PATHS.create}`);
    await page.locator('main h1').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.origin]) } });
    const create = discovered.candidates.find((candidate) => candidate.kind === 'FORM' && candidate.classification === 'CREATE');
    if (create === undefined) throw new Error('the create page has no create form');
    return create;
  } finally {
    await factory.close();
  }
}

/** LU-SFIX5: 下書きの確かめ（本番の部品）が作る、登録のシナリオの版（題名とメール。ID は送った後の URL の型。照合は一覧の検索に題名を結ぶ）。 */
const createScenarioOf = (create: DiscoveryCandidate, search: DiscoveryCandidate): ScenarioRevision => {
  const result = validateScenarioDraft({
    profileId: PROFILE_ID,
    candidateIdentityDigest: create.identityDigest,
    fieldNames: [ROW_KEY_FIELD, CHANGED_FIELD],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: {
      recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${LIST_ROW_FORM_PATHS.list}/{id}`] },
      readVerification: {
        readCheckId: READ_CHECK_ID, revision: 1, bindings: [{ parameterName: E.searchField, fieldName: CHANGED_FIELD }],
        expectations: [{ kind: 'TEXT_CONTAINS', fieldName: CHANGED_FIELD }], verificationOnly: true,
      },
    },
  }, create, [
    { readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [E.searchField], targetIdentityDigest: search.identityDigest },
  ] as never, { scenarioId: null, scenarios: [], profileRevisions: { discoveryJob: 2, current: 2 } });
  if (!result.ok) throw new Error(`the create draft was rejected: ${JSON.stringify(result.errors)}`);
  return { ...sampleScenario(), ...result.content, kind: 'CREATE', inputRuleReference: null } as ScenarioRevision;
};

/** IPC の契約の誤り（`START` に入れて確かめる）。 */
const ipcErrorsOf = (origin: string, write: WorkerStartWrite, jobKind: 'WRITE_UPDATE' | 'WRITE_CREATE' = 'WRITE_UPDATE'): readonly string[] => {
  const setup: AuthSetup = Object.freeze({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: PROFILE_ID,
    profileRevision: 1,
    loginStartUrl: `${origin}${SESSION_LOST_PATH}`,
    loginPostEndpoints: [{ origin, path: SESSION_LOST_PATH }],
    successCondition: { pathPrefix: LIST_ROW_FORM_PATHS.list, selector: null },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [],
    auditPathPrefixes: [LIST_ROW_FORM_PATHS.list],
    maxLoginAttempts: 2,
    allowedIdpOrigins: [],
    automatedLogin: null,
  });
  const checked = validateParentToWorkerMessage({
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'START',
    jobId: 'job-lu12',
    jobKind,
    targetConfigPath: 'local/targets/example-lu12.json',
    startNew: true,
    targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
    authentication: {
      setup,
      approvedTestOrigins: [origin],
      authenticationSha256: workerAuthenticationDigestOf(setup, [origin], { jobKind, automatedLogin: null }),
    },
    write,
  });
  return checked.ok ? [] : checked.errors;
};

/** 開始の指定（本番の `writeStartSpecOf`。台帳の照合済みの登録は対象の行の前の題名とメール）。IPC の契約も通す。 */
const writeOf = (
  origin: string,
  scenario: ScenarioRevision,
  form: DiscoveryCandidate,
  search: DiscoveryCandidate,
  ledgerEmail: string,
  newTitle: string,
): WorkerStartWrite => {
  const ledgerWrites: readonly RecordValueWrite[] = [{
    writeKind: 'CREATE', recordId: String(TARGET_ID), targetRecordId: null, result: 'VERIFIED',
    submittedValues: { [ROW_KEY_FIELD]: ledgerEmail, [CHANGED_FIELD]: 'item two' }, submittedAt: '20261103000000', recordedAt: '20261103000000',
  }];
  const readCheck: ReadCheckView = {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, createdAt: '20261103000000', updatedAt: '20261103000000', canceledAt: null,
    definition: { targetIdentityDigest: search.identityDigest, parameters: { [E.searchField]: '' }, expectations: [] } as unknown as ReadCheckDefinition,
  };
  const spec = writeStartSpecOf({
    scenario, evidence: form, grantId: GRANT_ID, profileId: PROFILE_ID,
    seedRecord: {
      seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
      seedInput: { profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
        executionGrantId: GRANT_ID },
      baseDate: '2026-11-03',
      attempt: 0,
    } as never,
    values: { [CHANGED_FIELD]: newTitle },
    readCheck,
    targetPage: { origin, path: LIST_ROW_FORM_PATHS.list },
    targetRecordId: String(TARGET_ID),
    ledgerWrites,
    ledgerUniqueEachRunFieldNames: [ROW_KEY_FIELD, CHANGED_FIELD],
    approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
  });
  if (spec === null || isWorkerStartApiWrite(spec)) throw new Error('the list row form write specification was not built');
  expect(spec.formPage.path).toBe(LIST_ROW_FORM_PATHS.list);
  expect(spec.request.path).toBe(`${LIST_ROW_FORM_PATHS.list}/${String(TARGET_ID)}`);
  expect(spec.update?.listRow).toEqual({
    listPagePath: LIST_ROW_FORM_PATHS.list, openerIdentityDigest: form.rowOpener?.identityDigest, rowKeyValue: ledgerEmail,
  });
  expect(spec.update?.knownKeptValues).toEqual([{ key: ROW_KEY_FIELD, value: ledgerEmail }]);
  expect(ipcErrorsOf(origin, spec)).toEqual([]);
  return spec;
};

/** LU-SFIX5: 登録の開始の指定（本番の `writeStartSpecOf`）。IPC の契約も通す。 */
const createWriteOf = (origin: string, scenario: ScenarioRevision, create: DiscoveryCandidate, search: DiscoveryCandidate, email: string, title: string): WorkerStartWrite => {
  const readCheck: ReadCheckView = {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID, revision: 1, createdAt: '20261103000000', updatedAt: '20261103000000', canceledAt: null,
    definition: { targetIdentityDigest: search.identityDigest, parameters: { [E.searchField]: '' }, expectations: [] } as unknown as ReadCheckDefinition,
  };
  const spec = writeStartSpecOf({
    scenario, evidence: create, grantId: GRANT_ID, profileId: PROFILE_ID,
    seedRecord: {
      seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
      seedInput: { profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
        executionGrantId: GRANT_ID },
      baseDate: '2026-11-03',
      attempt: 0,
    } as never,
    values: { [ROW_KEY_FIELD]: email, [CHANGED_FIELD]: title },
    readCheck,
    targetPage: { origin, path: LIST_ROW_FORM_PATHS.list },
    approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: PROFILE_ID, scenarioId: scenario.scenarioId, scenarioRevision: scenario.revision, grantId: GRANT_ID }),
  });
  if (spec === null || isWorkerStartApiWrite(spec)) throw new Error('the create write specification was not built');
  expect(ipcErrorsOf(origin, spec, 'WRITE_CREATE')).toEqual([]);
  return spec;
};

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('LU-12: the list row form update write flow with %s', (label, launch) => {
  describe.each(LAYOUTS)('in the layout %s', (layout) => {
    // SLIM-2（X7）: 流れごとに Chromium を起こさず、この組で 1 つの Browser を共有する（Context は流れごと）。
    const runLaunch = useSharedRunBrowser(launch);
    // SLIM W-3: 形（行の中・行の下）で変わるのは、行のフォームの見つけ方と窓の前の止め。2 つの形で流すのは成功と窓の前の止めだけで、ほかは行の中の形だけ
    // （行の選び方と開始の組み立ては単体 `scenario-list-row-ledger`・`api-list-row-update-start`・`form-list-row-autodraft` が確かめる）。
    const inRowOnly = layout === 'IN_ROW';
    let site: ListRowFormSite;
    let prepared: {
      readonly form: DiscoveryCandidate; readonly search: DiscoveryCandidate; readonly scenario: ScenarioRevision;
      readonly create: DiscoveryCandidate; readonly createScenario: ScenarioRevision;
    };
    let caseSince = 0;
    let expectedNonReads: readonly string[] = [];
    let suiteSince = 0;
    let suiteExpected = 0;

    const nonReadsSince = (since: number): readonly string[] => site.requests.slice(since)
      .filter((request) => !READ_METHODS.has(request.method)).map(({ method, path }) => `${method} ${path}`);
    const deletes = (): number => site.requests.filter((request) => request.method === 'DELETE').length;

    beforeAll(async () => {
      site = await startListRowFormSite(layout);
      site.setWriteScene({ items: itemsFor('probe', 'lu12-probe-target@example.invalid'), targetId: TARGET_ID });
      const browser = await launch();
      try {
        const { form, search } = await probeListPage(browser, site);
        const create = await discoverCreateForm(browser, site);
        prepared = { form, search, scenario: listRowScenarioOf(form, search), create, createScenario: createScenarioOf(create, search) };
      } finally {
        await browser.close();
      }
      suiteSince = site.requests.length;
    }, SUITE_TIMEOUT_MS);

    afterEach(() => {
      expect(nonReadsSince(caseSince), 'non-read requests that reached the server').toEqual(expectedNonReads);
      expect(deletes(), 'DELETE requests that reached the server').toBe(0);
      suiteExpected += expectedNonReads.length;
    });

    afterAll(async () => {
      await sleep(LATE_DELIVERY_SETTLE_MS);
      expect(nonReadsSince(suiteSince)).toHaveLength(suiteExpected);
      expect(deletes()).toBe(0);
      await site?.close();
    }, TEST_TIMEOUT_MS);

    /** 場面を準備して、書き込みの流れを 1 回流す。 */
    const runCase = async (options: {
      readonly scene?: (email: string, newTitle: string) => Partial<Omit<ListRowFormWriteScene, 'targetId'>>;
      readonly ledgerEmail?: (email: string) => string;
      /** LU-SFIX5: 登録の書き込みのジョブにする（対象の行を更新せず、新しい行を登録する）。 */
      readonly create?: boolean;
      readonly expected: readonly string[];
    }): Promise<{ readonly run: ActionRunDocument; readonly evidence: ActionEvidenceDocument; readonly newTitle: string; readonly email: string; readonly since: number }> => {
      caseNumber += 1;
      const email = `lu12-${String(caseNumber)}-target@example.invalid`;
      const newTitle = `LU-12 新しい題名 ${String(caseNumber)}`;
      site.setWriteScene({ items: itemsFor(String(caseNumber), email), ...options.scene?.(email, newTitle), targetId: TARGET_ID });
      const write = options.create === true
        ? createWriteOf(site.origin, prepared.createScenario, prepared.create, prepared.search, `lu12-${String(caseNumber)}-new@example.invalid`, newTitle)
        : writeOf(site.origin, prepared.scenario, prepared.form, prepared.search, options.ledgerEmail?.(email) ?? email, newTitle);
      expectedNonReads = options.expected;
      caseSince = site.requests.length;
      const outcome = await executeWriteCreateRun({
        config: configOf(site.origin, join(directory, `output-${String(caseNumber)}`)),
        jobId: `job-lu12-${String(caseNumber)}`,
        authentication: authenticationOf(site.origin),
        write,
        launchBrowser: runLaunch,
        clock: () => new Date(),
        now: () => Date.now(),
        stopSignal: new AbortController().signal,
        recheck: () => Promise.resolve(ALLOWED),
        reportSubmission: () => undefined,
        resultTimeoutMs: RESULT_TIMEOUT_MS,
        observationWindows: TEST_OBSERVATION_WINDOWS,
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
      const runText = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
      const run = JSON.parse(runText) as ActionRunDocument;
      expect(await validateArtifact('action-run', run)).toEqual({ ok: true });
      // 行を選ぶ値（保つ欄のメール）は記録に出ない。
      expect(runText).not.toContain(email);
      const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as ActionEvidenceDocument;
      return { run, evidence, newTitle, email, since: caseSince };
    };

    it(`sends only the POST to the ledger row and verifies it on the list (${label})`, async () => {
      const { run, newTitle, email, since } = await runCase({ expected: [TARGET_POST] });
      expect(run).toMatchObject({
        submission: 'SENT', responseJudgement: 'SUCCESS', recordId: String(TARGET_ID),
        readVerification: { readCheckId: READ_CHECK_ID, result: 'MATCHED' }, result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
        update: { targetRecordId: String(TARGET_ID), updateEvidence: { fields: [{ fieldName: CHANGED_FIELD, role: 'CHANGED', matched: true }] } },
      });
      // 変えたのは対象の行の題名だけ（保つ欄のメールと、ほかの行は変わらない）。
      const after = site.writeItems();
      expect(after.find(({ id }) => id === TARGET_ID)).toEqual({ id: TARGET_ID, title: newTitle, email });
      expect(after.filter(({ id }) => id !== TARGET_ID).map(({ title }) => title)).toEqual(['item one', 'item three']);
      // 5.7: 一覧の画面の読み込みは、送る前の READ の 2 回（LU-SFIX4。対象の画面と READ の URL）、書き込みの段の 1 回、POST の後の 303 の 1 回、照合の対象の画面の
      // 1 回、READ の URL の 1 回（ページ送り・読み込み直しをしない）。
      expect(site.requests.slice(since).filter(({ method, path }) => method === 'GET' && path === LIST_ROW_FORM_PATHS.list)).toHaveLength(6);
    }, TEST_TIMEOUT_MS);

    // K3: 照合の READ の行の確かめ。新しい値が、選んだ行のほかの行にもある（含む行がちょうど 1 つでない）ときは、送ったが `VERIFIED` にしない。
    it.runIf(inRowOnly)(`does not claim the verification when the new title is not only in the chosen row (${label})`, async () => {
      const { run } = await runCase({
        scene: (email, newTitle) => ({ items: [...itemsFor('shared', email).filter(({ id }) => id !== 3), { id: 3, title: newTitle, email: 'lu12-shared-3@example.invalid' }] }),
        expected: [TARGET_POST],
      });
      expect(run).toMatchObject({ submission: 'SENT' });
      expect(run.result).not.toBe('VERIFIED');
      expect(run.readVerification?.result).not.toBe('MATCHED');
    }, TEST_TIMEOUT_MS);

    it.runIf(inRowOnly).each<readonly [string, (email: string) => ListRowFormWriteItem[]]>([
      ['no row with the row key value (0 rows)', () => itemsFor('zero', 'lu12-zero-not-the-ledger@example.invalid')],
      ['two rows with the row key value', (email) => [...itemsFor('twice', email), { id: 4, title: 'item four', email }]],
    ])(`sends nothing for %s (ROW_NOT_UNIQUE, ${label})`, async (_name, items) => {
      const { run } = await runCase({ scene: (email) => ({ items: items(email) }), expected: [] });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'ROW_NOT_UNIQUE', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    it.runIf(inRowOnly).each(['NONE', 'UNNAMED'] as const)(`sends nothing when the row has no named opener (%s, OPENER_NOT_FOUND, ${label})`, async (opener) => {
      const { run } = await runCase({ scene: () => ({ opener }), expected: [] });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'OPENER_NOT_FOUND', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    it.runIf(inRowOnly).each<readonly ['NONE' | 'TWO', string]>([['NONE', 'FORM_NOT_FOUND'], ['TWO', 'FORM_AMBIGUOUS']])(
      `sends nothing when the row has %s form to the ledger destination (FORM_NOT_READY, ${label})`,
      async (targetForms, reason) => {
        const { run, evidence } = await runCase({ scene: () => ({ targetForms }), expected: [] });
        expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'FORM_NOT_READY', result: 'BLOCKED' });
        expect(evidence.precheck?.inputFailure).toMatchObject({ stage: 'INSPECT', reason });
      },
      TEST_TIMEOUT_MS,
    );

    it.runIf(inRowOnly)(`sends nothing when the kept value on the page differs from the ledger (KNOWN_KEPT_VALUE_MISMATCH, ${label})`, async () => {
      // 台帳の値（行を選ぶ値）は、ページの値の一部（BeakSight の外で値が変わった行）。行は語の区切りで当たるが、フォームの保つ欄の値が台帳の値と違う。
      const { run } = await runCase({ scene: (email) => ({ items: itemsFor('changed', `${email} changed`) }), expected: [] });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    // RB-14a: 開き手を押した時（窓の前。N2）のページの送信の扱いは、ここでは確かめない。承認した送信先とその型・表の path を止めること（LU-SFIX3-B）は
    // write-update-run（形 C の更新の form）と単体 write-stage-guarded-path-shape が確かめる。SD-2: ページ自身の DELETE は届き、BeakSight が削除の操作を
    // しないことは `destructive-action-guard` が確かめる。

    // LU-SFIX4（LU-REV の I-1）: 対象の行の変える欄が、もう新しい値を語として含む（`<新しい値> old`）。サーバは POST を受けても変えない。送る前の READ が、選んだ行に
    // 新しい値がもう見えていると判定し、送らない（前は、サーバが変えなくても `VERIFIED` になった）。
    it.runIf(inRowOnly)(`sends nothing when the chosen row already shows the new value (VALUE_ALREADY_PRESENT, LU-SFIX4 I-1, ${label})`, async () => {
      const { run } = await runCase({
        scene: (email, newTitle) => ({
          items: itemsFor('present', email).map((item) => (item.id === TARGET_ID ? { ...item, title: `${newTitle} old` } : item)), ignorePost: true,
        }),
        expected: [],
      });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'VALUE_ALREADY_PRESENT', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    // LU-SFIX4（LU-REV の I-1b）: 一覧の画面が、照合の READ の `?q=` の値を対象の行に描く。サーバは POST を受けても変えない。送る前の READ が同じ形で読み、送らない。
    it.runIf(inRowOnly)(`sends nothing when the list page draws the READ query in the chosen row (VALUE_ALREADY_PRESENT, LU-SFIX4 I-1b, ${label})`, async () => {
      const { run } = await runCase({ scene: () => ({ echoQuery: true, ignorePost: true }), expected: [] });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'VALUE_ALREADY_PRESENT', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    // LU-SFIX4（LU-REV の I-2）: 開き手を押した後に、ページが行のフォームの送信ボタンの文字を変える（「削除」・承認と違う語）。form の識別が承認の候補と違うので、
    // 押さない（前は、そのまま押して POST が届き、`VERIFIED` になった）。
    // SLIM W-3: 「登録」への書き換えは、同じ識別の照らしの「削除」と同じ分岐なので外した。
    it.runIf(inRowOnly).each(['削除'])(`does not press when the page relabels the submit button of the row form to %s after the opener (FORM_NOT_READY, LU-SFIX4 I-2, ${label})`,
      async (text) => {
        const { run } = await runCase({ scene: () => ({ relabelSubmitOnOpen: text }), expected: [] });
        expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'FORM_NOT_READY', result: 'BLOCKED' });
      }, TEST_TIMEOUT_MS);

    // LU-SFIX4（LU-REV の I-2）: 識別を照らした後、値を入れた時にページが送信ボタンの文字を「削除」に変える。押す時点の確かめ（`pressWithPressTimeGuard`）で語が承認と
    // 違うので、押さない。
    it.runIf(inRowOnly)(`does not press when the page relabels the submit button to 削除 while the values are filled (FORM_NOT_READY, LU-SFIX4 I-2, ${label})`, async () => {
      const { run, evidence } = await runCase({ scene: () => ({ relabelSubmitOnInput: '削除' }), expected: [] });
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', precheckDetail: 'FORM_NOT_READY', result: 'BLOCKED' });
      expect(evidence.precheck?.inputFailure).toMatchObject({ stage: 'SUBMIT' });
    }, TEST_TIMEOUT_MS);

    // LU-SFIX5（LU-SREV4 の Important-1）: 一覧の画面のスクリプトが、最初に開かれた時刻を localStorage か HttpOnly でない cookie に記録し、一定の時間より後に開かれた
    // ときだけ `?q=` の値を対象の行に描く。サーバは POST を受けても変えない。書き込みのジョブの中の Context でページが書いた値は、次の Context へ渡さないので、
    // 照合でも描かれず、`VERIFIED` にならない（前は、送る前の READ の記録を照合が受け継ぎ、`VERIFIED` になった）。
    // SLIM W-3: 時刻を保つ場所（localStorage・cookie）は、次の Context へ渡さない同じ作りなので、最初の場所だけ。
    it.runIf(inRowOnly).each(LIST_ROW_FORM_TIME_GATE_STORES.slice(0, 1))(`does not verify the update when the page draws the query after a time kept in %s (LU-SFIX5, ${label})`, async (store) => {
      const { run } = await runCase({ scene: () => ({ timeGatedEcho: store, ignorePost: true }), expected: [TARGET_POST] });
      expect(run).toMatchObject({ submission: 'SENT' });
      expect(run.result).not.toBe('VERIFIED');
      expect(run.readVerification?.result).not.toBe('MATCHED');
      expect(site.writeItems().find(({ id }) => id === TARGET_ID)?.title).toBe('item two');
    }, TEST_TIMEOUT_MS);

    // LU-SFIX5: 登録も同じ（送る前の READ の記録を、照合が受け継がない）。サーバは登録の POST を受けても行を足さない（番号の画面へは移す）。
    it.runIf(inRowOnly).each(LIST_ROW_FORM_TIME_GATE_STORES.slice(0, 1))(
      `does not verify the create when the page draws the query after a time kept in %s (LU-SFIX5, ${label})`,
      async (store) => {
        const { run } = await runCase({ create: true, scene: () => ({ timeGatedEcho: store, ignorePost: true, createRecordId: CREATE_RECORD_ID }), expected: [CREATE_POST] });
        expect(run).toMatchObject({ submission: 'SENT' });
        expect(run.result).not.toBe('VERIFIED');
        expect(run.readVerification?.result).not.toBe('MATCHED');
        expect(site.writeItems().some(({ id }) => id === CREATE_RECORD_ID)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    // LU-SFIX5: 正しい登録（サーバが行を足す）は、今のとおり書き込み 1 件で `VERIFIED`（照合の対照）。
    it.runIf(inRowOnly)(`verifies a correct create (LU-SFIX5 control, ${label})`, async () => {
      const { run } = await runCase({ create: true, scene: () => ({ createRecordId: CREATE_RECORD_ID }), expected: [CREATE_POST] });
      expect(run).toMatchObject({ submission: 'SENT', recordId: String(CREATE_RECORD_ID), result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
    }, TEST_TIMEOUT_MS);

    // LU-SFIX5（LU-SREV4 の Minor-1）: 識別を照らし、値を入れた後、送信ボタンを押し始めた時（`pointerdown`）に、ページが文字を「削除」に変える。押す時点の確かめ
    // （`submitterFactsAccepted`）で語が承認と違うので、押した事象をページに届けない（書き込みは届かない）。
    it.runIf(inRowOnly)(`does not deliver the press when the page relabels the submit button to 削除 when the press starts (LU-SFIX5 Minor-1, ${label})`, async () => {
      const { run, evidence } = await runCase({ scene: () => ({ relabelSubmitOnPointerDown: '削除' }), expected: [] });
      console.info(`LU-SFIX5 (${label} ${layout}) pointerdown relabel: ${JSON.stringify({ precheckDetail: run.precheckDetail, inputFailure: evidence.precheck?.inputFailure })}`);
      expect(run).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED' });
      expect(evidence.precheck?.inputFailure).toMatchObject({ stage: 'SUBMIT' });
    }, TEST_TIMEOUT_MS);
  });
});
