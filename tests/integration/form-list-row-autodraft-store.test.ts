// LU-11（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 4.0 の D3・D5、5.4 の 4。LU-11 fix round 1・2）: 行の下に広がるフォーム（形 B）の
// 操作さがしから承認まで。
// - 仮のサイト（`fixtures/list-row-form-site.ts`。フォームが「編集」と同じ行にある作りと、すぐ下の隠れた行にある作り）を、本物の factory と Guard の PRIMARY の
//   Context で読む（発見の入口 → 送らずに観察する probe）。フォームの候補に同じ行の開き手（`rowOpener`）が結ばれ、probe が押した行のフォームの欄の見え方が
//   読み直され（fix round 2）、その結果の発見の文書から、形 B の更新の下書きを作り、保存し、承認まで通る（2 つの作り）。
// - 安全の条件: サーバに届いた読み取りでない要求は 0（probe は「編集」を押すが、フォームを見せるだけで送らない）。
// - 管理データは一時のフォルダの本物（`openControlDatabase`）。同じ行の開き手のない形は、合成の発見の文書で確かめる。
// 値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import type { AutoDraftScenarioFact } from '../../src/control/approval/api-scenario-autodraft.js';
import { formAnswerReadChoiceOf, formAnswerReadVerificationOf, formAutoDraftPlanOf } from '../../src/control/approval/form-scenario-autodraft.js';
import {
  approveScenario,
  createScenario,
  listScenarios,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioDraftContext,
  readVerificationOnlyReadCheckIds,
  updateScenario,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { formUpdateAutoDraftOf } from '../../src/control/approval/update-autodraft.js';
import { PRE_APPROVAL_EVALUATION_PREMISE, planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { varyingFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck, listReadChecks } from '../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, type ProfileContextResolver } from '../../src/control/store/profile-store.js';
import { wait } from '../../src/core/deadline.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryCandidatesOf,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
  type DiscoveryReadPageRecord,
} from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests, listRowFormTemplatedIdentityDigestOf } from '../../src/discovery/fingerprint.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  LIST_ROW_FORM_ELEMENTS,
  LIST_ROW_FORM_ITEMS,
  LIST_ROW_FORM_LAYOUTS,
  LIST_ROW_FORM_PATHS,
  startListRowFormSite,
  type ListRowFormSite,
} from '../../fixtures/list-row-form-site.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { PROBE_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const TEST_TIMEOUT_MS = 120_000;
/** 押した後に静まるまで待つ時間（ms。本番の既定より短い、テストの値）。 */
const SHORT_QUIET_WAIT_MS = 300;
/** 読んだ後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 500;
const UI_TIMEOUT_MS = 15_000;

/** 本物の factory と Guard の PRIMARY の Context で、画面を読み（発見の入口）、probe を通した記録。 */
async function discoverScreen(
  browser: Browser,
  factories: BrowserContextFactory[],
  origin: string,
  path: string,
): Promise<DiscoveryReadPageRecord> {
  const config = fastRunConfig(origin, path);
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), PROBE_FACTORY_OPTIONS);
  factories.push(factory);
  const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
  const page = await factory.createPassivePage(context);
  await page.goto(`${origin}${path}`);
  await page.locator('main h1').first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  const observation = factory.submissionObservationOf(context);
  if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
  const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([origin]) } });
  expect(discovered.incompleteReasons).toEqual([]);
  const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
    targetPolicy: { allowedOrigins: new Set([origin]), isExcludedPage: () => false },
    quietWaitMs: SHORT_QUIET_WAIT_MS,
  });
  await wait(LATE_REQUEST_WAIT_MS);
  return probed;
}

const rowFormsOf = (record: DiscoveryReadPageRecord): readonly DiscoveryCandidate[] =>
  record.candidates.filter((candidate) => candidate.kind === 'FORM' && candidate.submitterWords.includes(LIST_ROW_FORM_ELEMENTS.saveText));

// ---------------------------------------------------------------------------------------------------------------
// 下書き → 保存 → 承認（管理データは一時のフォルダの本物。発見の文書は、操作さがしの結果か合成の値）
// ---------------------------------------------------------------------------------------------------------------

const PROFILE_ID = 'example-form-list-row';
const DISCOVERY_JOB_ID = 'job-form-list-row-d1';
const DISCOVERED_AT = '20261103000000';
const CREATED_AT = '20261103001000';
const RULES_AT = '20261103001500';
const LINKED_AT = '20261103002000';
const UPDATE_AT = '20261103002500';
const APPROVED_AT = '20261103003000';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-form-list-row' } });

/** 発見の文書（読んだ画面の記録から）。 */
const discoveryOf = (records: readonly DiscoveryReadPageRecord[], origin: string): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: DISCOVERY_JOB_ID,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: records.map((record) => ({ url: `${origin}${record.location?.path ?? '/'}`, state: 'READ', record, blockedRequests: 0 })),
  omittedUnreadPages: 0,
} as DiscoveryDocument);

const setupOf = (origin: string): AuthSetup => Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${origin}/login`,
  loginPostEndpoints: [{ origin, path: '/login' }],
  successCondition: { pathPrefix: '/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: ['/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 一時のフォルダの管理データ（プロファイル・認証の設定・発見の索引まで入れたもの）。 */
interface Store {
  readonly database: ControlDatabase;
  readonly facts: ApprovalExternalFacts;
  readonly discovery: DiscoveryDocument;
  readonly candidates: readonly DiscoveryCandidate[];
  close(): void;
}

const openStore = async (origin: string, discovery: DiscoveryDocument): Promise<Store> => {
  const workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-form-list-row-'));
  const database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  const close = (): void => {
    closeControlDatabase(database);
    rmSync(workDirectory, { recursive: true, force: true });
  };
  try {
    mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
    writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
    // 仮のサイトの Origin（127.0.0.1 の空いたポート）を許すターゲットの文脈（テストの resolver と同じく、知っているパスだけを解決する）。
    const context = Object.freeze({ targetConfig: createTestConfig(origin) });
    const resolveContext: ProfileContextResolver = (path) => (resolveTestContext(path) === undefined ? undefined : context);
    expect(createProfile(database, testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION, origin), { resolveContext }).ok).toBe(true);
    expect(saveAuthSetup(database, setupOf(origin), { resolveContext })).toMatchObject({ ok: true });
    expect(createStartingJob(database, {
      jobId: DISCOVERY_JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: DISCOVERED_AT,
    }, () => null)).toEqual({ ok: true });
    expect(recordLoginCheckFinished(database, DISCOVERY_JOB_ID, 0, DISCOVERED_AT)).toBe(true);
    const candidates = mergeDiscoveryCandidates(discoveryCandidatesOf(discovery));
    recordDiscoveryCandidates(database, {
      profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT, entries: candidates.map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(discovery),
    });
    const stored = getProfile(database, PROFILE_ID);
    const facts = stored === null ? null : await approvalExternalFactsOf(stored, {
      database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
    });
    if (facts === null) throw new Error('the external facts are not available');
    return { database, facts, discovery, candidates, close };
  } catch (error) {
    close();
    throw error;
  }
};

const contextOf = (store: Store) => {
  const context = readScenarioDraftContext(store.database, PROFILE_ID, DISCOVERY_JOB_ID, null);
  if (context === null) throw new Error('the draft context is not available');
  return context;
};
const scenarioFactsOf = (store: Store): readonly AutoDraftScenarioFact[] => listScenarios(store.database, PROFILE_ID).map((scenario) => ({
  scenarioId: scenario.scenarioId, kind: scenario.current.kind, state: scenario.state,
  candidateIdentityDigest: scenario.current.candidate.identityDigest, shapeDigest: scenario.current.api?.shapeDigest ?? null,
}));
const planOf = (store: Store, candidates: readonly DiscoveryCandidate[] = store.candidates) =>
  formAutoDraftPlanOf({ profileId: PROFILE_ID, candidates, context: contextOf(store), scenarios: scenarioFactsOf(store) });
const readCheckFactsOf = (store: Store) => listReadChecks(store.database, PROFILE_ID).map(({ readCheckId, revision, definition }) => ({
  readCheckId, revision, targetPagePath: definition.targetPagePath ?? null,
  targetIdentityDigest: definition.targetIdentityDigest ?? null, parameterNames: Object.keys(definition.parameters),
}));
const clock = (): string => UPDATE_AT;

const attachRules = (store: Store, scenarioId: string, at: string): { readonly revision: number; readonly varying: readonly string[] } => {
  const scenario = readScenario(store.database, scenarioId);
  if (scenario === null) throw new Error('no scenario');
  const inferred = inferRuleSetContent(scenario.current, scenario.evidence);
  const saved = saveRuleSetAndAttach(store.database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: inferred.content, expectedScenarioRevision: scenario.revision, at,
  });
  if (!saved.ruleSet.ok || saved.attachment === null || !saved.attachment.ok) throw new Error(`the rules were not attached: ${JSON.stringify(saved)}`);
  const { current, evidence, revision } = saved.attachment.scenario;
  return { revision, varying: varyingFieldNamesOf(planRuleSet(saved.ruleSet.ruleSet, current, evidence, undefined, PRE_APPROVAL_EVALUATION_PREMISE)) };
};

const approve = (store: Store, scenarioId: string, expectedRevision: number, receiptId: string) => {
  const status = readScenarioApprovalStatus(store.database, scenarioId, store.facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  return approveScenario(store.database, {
    scenarioId, expectedRevision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: store.facts, at: APPROVED_AT, confirmSideEffects: true,
  });
};

/** 登録の下書きを、画面のサーバと同じ順で作り（シナリオ → 規則 → 照合の専用の定義 → 答え合わせに結ぶ）、承認する。 */
const createLedger = (store: Store): string => {
  const [create] = planOf(store).creates;
  if (create?.status !== 'NEW' || create.answerRead === null) throw new Error(`the create is ${create?.status ?? 'none'}`);
  expect(create.recordId?.value).toEqual({ source: 'URL_PATH_PATTERNS', pathPatterns: [`${LIST_ROW_FORM_PATHS.list}/{id}`] });
  const scenarioId = 'auto-form-create';
  expect(createScenario(store.database, { scenarioId, draft: create.draft, discovery: store.discovery, at: CREATED_AT })).toMatchObject({ ok: true });
  const { revision, varying } = attachRules(store, scenarioId, RULES_AT);
  const choice = formAnswerReadChoiceOf({
    answerRead: create.answerRead.value, definitions: readCheckFactsOf(store),
    verificationOnlyReadCheckIds: readVerificationOnlyReadCheckIds(store.database, PROFILE_ID),
  });
  if (choice.kind !== 'CREATE') throw new Error(`the answer check is ${choice.kind}`);
  const validation = validateReadCheckDefinition(choice.definition, create.answerRead.value.candidate);
  if (!validation.ok) throw new Error(`the answer check was rejected: ${JSON.stringify(validation.errors)}`);
  const saved = createReadCheck(store.database, { readCheckId: 'read-answer', profileId: PROFILE_ID, definition: validation.definition, at: CREATED_AT });
  if (!saved.ok) throw new Error(saved.reason);
  const readVerification = formAnswerReadVerificationOf({
    reference: { readCheckId: 'read-answer', revision: saved.readCheck.revision }, parameterName: create.answerRead.value.parameterName,
    textFieldNames: create.textFieldNames, varyingFieldNames: varying,
  });
  const linked = updateScenario(store.database, {
    scenarioId, expectedRevision: revision, draft: { ...create.draft, verification: { recordId: create.recordId?.value ?? null, readVerification } },
    discovery: store.discovery, at: LINKED_AT,
  });
  if (!linked.ok) throw new Error(`the answer check was not linked: ${linked.reason} ${JSON.stringify(linked.draftErrors)}`);
  // 点検の連鎖と同じ順: 登録を承認した（副作用の確認を兼ねる）後に、その台帳に結ぶ更新を作る（メールの欄も毎回違う値の規則になる）。
  expect(approve(store, scenarioId, linked.scenario.revision, 'receipt-create')).toMatchObject({ ok: true, scenario: { state: 'APPROVED' } });
  return scenarioId;
};

/** 形 B の更新の下書きを作り、保存し、承認する（行を選ぶ欄は変えない）。 */
const draftSaveAndApproveUpdate = (store: Store, ledgerId: string, editorDigest: string): void => {
  const updates = planOf(store).updates;
  // 行ごとのフォームは 1 行にまとめる（最初の行のフォーム）。
  expect(updates).toHaveLength(1);
  const [planned] = updates;
  if (planned?.status !== 'NEW') throw new Error(`the update plan is ${planned?.status ?? 'none'}`);
  expect(planned.row.candidate.action?.path).toBe(`${LIST_ROW_FORM_PATHS.list}/${String(LIST_ROW_FORM_ITEMS[0].id)}`);
  const outcome = formUpdateAutoDraftOf({ database: store.database, profileId: PROFILE_ID, discovery: store.discovery, clock }, planned, true);
  expect(outcome).toMatchObject({ status: 'CREATED', presetLedger: { value: ledgerId }, presetTemplate: { value: LIST_ROW_FORM_PATHS.list } });
  const scenario = outcome.scenarioId === null ? null : readScenario(store.database, outcome.scenarioId);
  if (scenario === null) throw new Error('the update was not saved');
  const rowKeyField = scenario.current.update?.listRow?.rowKeyField;
  expect(scenario.current.update).toMatchObject({
    targetCreateScenarioId: ledgerId,
    formPathTemplate: LIST_ROW_FORM_PATHS.list,
    actionPathTemplate: `${LIST_ROW_FORM_PATHS.list}/{id}`,
    listRow: { listPagePath: LIST_ROW_FORM_PATHS.list, openerIdentityDigest: editorDigest },
    templatedIdentityDigest: listRowFormTemplatedIdentityDigestOf(planned.row.candidate),
  });
  // 行を選ぶ欄は保つ欄で、変える欄ではない（LU-11 fix round 2）。
  expect(scenario.current.update?.keepFieldNames).toContain(rowKeyField);
  expect(scenario.current.fieldNames).not.toContain(rowKeyField);
  expect(approve(store, scenario.scenarioId, scenario.revision, 'receipt-update')).toMatchObject({ ok: true, scenario: { state: 'APPROVED' } });
};

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('LU-11: a list row form from the real discovery to the approval with the real factory and Guard with %s', (_label, launch) => {
  let browser: Browser;
  let site: ListRowFormSite | undefined;
  let store: Store | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    store?.close();
    store = undefined;
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each(LIST_ROW_FORM_LAYOUTS)('binds the forms of the rows to the named row editor in %s, reads the pressed row again, drafts, saves and approves the update, and sends nothing', async (layout) => {
    site = await startListRowFormSite(layout);
    const create = await discoverScreen(browser, factories, site.origin, LIST_ROW_FORM_PATHS.create);
    const record = await discoverScreen(browser, factories, site.origin, LIST_ROW_FORM_PATHS.list);
    // サーバに届いた読み取りでない要求は 0（probe は「編集」を押してフォームを見せるが、送らない）。
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path}`)).toEqual([]);
    const editors = record.candidates.filter((candidate) => candidate.kind === 'BUTTON' && candidate.submitterWords.includes(LIST_ROW_FORM_ELEMENTS.editText));
    expect(editors).toHaveLength(LIST_ROW_FORM_ITEMS.length);
    const forms = rowFormsOf(record);
    expect(forms.map(({ action }) => action?.path)).toEqual(LIST_ROW_FORM_ITEMS.map(({ id }) => `${LIST_ROW_FORM_PATHS.list}/${String(id)}`));
    expect(forms.map(({ classification }) => classification)).toEqual(LIST_ROW_FORM_ITEMS.map(() => 'UPDATE'));
    expect(forms.map(({ rowOpener }) => rowOpener)).toEqual(LIST_ROW_FORM_ITEMS.map(() => ({
      identityDigest: editors[0]?.identityDigest, hasName: true, openerWords: [LIST_ROW_FORM_ELEMENTS.editText],
    })));
    // 検索の form と削除のボタンは開き手を持たない。
    const others = record.candidates.filter((candidate) => !forms.includes(candidate));
    expect(others.map(({ rowOpener }) => rowOpener)).toEqual(others.map(() => undefined));
    // 押した行（最初の行）のフォームだけ、欄が見える形に読み直される（ほかの行は押していないので見えないまま）。識別の digest は変わらない。
    expect(forms.map(({ fields }) => fields.map(({ hidden }) => hidden))).toEqual([
      [false, false], ...LIST_ROW_FORM_ITEMS.slice(1).map(() => [true, true]),
    ]);
    expect(new Set(forms.map(({ ruleDigest }) => ruleDigest)).size).toBe(2);
    store = await openStore(site.origin, discoveryOf([create, record], site.origin));
    const ledgerId = createLedger(store);
    draftSaveAndApproveUpdate(store, ledgerId, editors[0]?.identityDigest ?? '');
  }, TEST_TIMEOUT_MS);
});

describe('LU-11: a list row form without the opener of its row (synthetic discovery)', () => {
  const location = (path: string) => ({ origin: TEST_ORIGIN, path });
  const syntheticOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
    ...discovered, ...classifyCandidate(discovered, { allowedOrigins: new Set([TEST_ORIGIN]) }), ...computeCandidateDigests(discovered),
  });
  const E = LIST_ROW_FORM_ELEMENTS;
  const CREATE = syntheticOf(sampleForm({
    page: location(LIST_ROW_FORM_PATHS.create), action: sampleAction(LIST_ROW_FORM_PATHS.list, [], TEST_ORIGIN), submitterText: E.createText,
    fields: [sampleField(E.titleField, 'text', { required: true }), sampleField(E.emailField, 'email', { required: true })],
  }));
  const SEARCH = syntheticOf(sampleForm({
    page: location(LIST_ROW_FORM_PATHS.list), formMethod: 'GET', action: sampleAction(LIST_ROW_FORM_PATHS.list, [], TEST_ORIGIN), submitterText: E.searchText,
    fields: [sampleField(E.searchField, 'search')],
  }));
  const ROW_FORMS = LIST_ROW_FORM_ITEMS.map(({ id }) => syntheticOf(sampleForm({
    page: location(LIST_ROW_FORM_PATHS.list), action: sampleAction(`${LIST_ROW_FORM_PATHS.list}/${String(id)}`, [], TEST_ORIGIN), submitterText: E.saveText,
    fields: [sampleField(E.titleField, 'text', { hasValue: true }), sampleField(E.emailField, 'email', { hasValue: true })],
  })));
  const recordOf = (path: string, candidates: readonly DiscoveryCandidate[]): DiscoveryReadPageRecord =>
    ({ location: location(path), incompleteReasons: [], candidates });
  let store: Store | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('does not save the update when the form has no opener of its row', async () => {
    store = await openStore(TEST_ORIGIN, discoveryOf([
      recordOf(LIST_ROW_FORM_PATHS.create, [CREATE]), recordOf(LIST_ROW_FORM_PATHS.list, [SEARCH, ...ROW_FORMS]),
    ], TEST_ORIGIN));
    createLedger(store);
    const [planned] = planOf(store).updates;
    if (planned === undefined) throw new Error('no update plan');
    expect(formUpdateAutoDraftOf({ database: store.database, profileId: PROFILE_ID, discovery: store.discovery, clock }, planned, true).status)
      .toBe('NOT_SAVED');
  });
});
