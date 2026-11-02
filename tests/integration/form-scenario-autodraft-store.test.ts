// PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8 章、8.1 の「自動で決める項目」）: フォームの形の自動の下書きを、今の保存の口で保存したときの
// 結合。管理データは一時のフォルダの本物（`openControlDatabase`）。発見の文書と索引は合成の値（サイトに接続しない）。
// - 登録: 下書き（ID の型つき）→ 推した入れる値の決まり → 変わる欄で答え合わせを結ぶ（照合の専用の定義。期待は「作った値を含む」）→ 承認のダイアログの 1 回の
//   確認で承認 → 実行の許可を出せる（検証の指定に未指定がなく、比べる欄は実行のたびに変わる値）。人の入力は承認の確認だけ。
// - 書き換え: 変える欄を選ぶだけで、台帳の ID の型と答え合わせを写した下書きを保存でき、承認できる（写し方は `update-verification-copy.ts`）。
// 値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import { type AutoDraftScenarioFact } from '../../src/control/approval/api-scenario-autodraft.js';
import {
  formAnswerReadChoiceOf,
  formAnswerReadVerificationOf,
  formAutoDraftPlanOf,
  formTextFieldNamesOf,
  formUpdateDraftPresetOf,
} from '../../src/control/approval/form-scenario-autodraft.js';
import { missingVerificationItemsOf } from '../../src/control/approval/scenario-policy.js';
import {
  approveScenario,
  createScenario,
  issueExecutionGrant,
  listScenarios,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioDraftContext,
  readVerificationOnlyReadCheckIds,
  updateScenario,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { updateVerificationCopyOf } from '../../src/control/approval/update-verification-copy.js';
import { PRE_APPROVAL_EVALUATION_PREMISE, planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { varyingFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck, listReadChecks } from '../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-form-autodraft';
const DISCOVERY_JOB_ID = 'job-form-autodraft-d1';
const DISCOVERED_AT = '20261027000000';
const CREATED_AT = '20261027001000';
const RULES_AT = '20261027001500';
const LINKED_AT = '20261027002000';
const APPROVED_AT = '20261027003000';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-form-autodraft' } });

const location = (path: string) => ({ origin: TEST_ORIGIN, path });
const ALLOWED: ReadonlySet<string> = new Set([TEST_ORIGIN]);
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered, ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }), ...computeCandidateDigests(discovered),
});
const CREATE = candidateOf(sampleForm({
  page: location('/admin/members/new'), action: sampleAction('/admin/members', [], TEST_ORIGIN), submitterText: '登録',
  fields: [sampleField('name', 'text', { required: true }), sampleField('email', 'email')],
}));
const UPDATE = candidateOf(sampleForm({
  page: location('/admin/members/1001/edit'), action: sampleAction('/admin/members/1001', [], TEST_ORIGIN), methodOverride: 'PATCH', submitterText: '更新',
  fields: [sampleField('_method', 'hidden', { hasValue: true }), sampleField('name'), sampleField('email', 'email')],
}));
const SEARCH = candidateOf(sampleForm({
  page: location('/admin/members'), formMethod: 'GET', action: sampleAction('/admin/members', [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));

const pageOf = (candidate: DiscoveryCandidate) => ({
  url: `${TEST_ORIGIN}${candidate.page.path}`, state: 'READ', record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] }, blockedRequests: 0,
});
const DISCOVERY = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: DISCOVERY_JOB_ID,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [pageOf(CREATE), pageOf(UPDATE), pageOf(SEARCH)],
  omittedUnreadPages: 0,
} as DiscoveryDocument;
const CANDIDATES = mergeDiscoveryCandidates([CREATE, UPDATE, SEARCH]);

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

let workDirectory = '';
let database: ControlDatabase;
let facts: ApprovalExternalFacts;

const contextOf = () => {
  const context = readScenarioDraftContext(database, PROFILE_ID, DISCOVERY_JOB_ID, null);
  if (context === null) {
    throw new Error('the draft context is not available');
  }
  return context;
};
const scenarioFactsOf = (): readonly AutoDraftScenarioFact[] => listScenarios(database, PROFILE_ID).map((scenario) => ({
  scenarioId: scenario.scenarioId, kind: scenario.current.kind, state: scenario.state,
  candidateIdentityDigest: scenario.current.candidate.identityDigest, shapeDigest: scenario.current.api?.shapeDigest ?? null,
}));
const planOf = () => formAutoDraftPlanOf({ profileId: PROFILE_ID, candidates: CANDIDATES, context: contextOf(), scenarios: scenarioFactsOf() });
const readCheckFactsOf = () => listReadChecks(database, PROFILE_ID).map(({ readCheckId, revision, definition }) => ({
  readCheckId, revision, targetPagePath: definition.targetPagePath ?? null,
  targetIdentityDigest: definition.targetIdentityDigest ?? null, parameterNames: Object.keys(definition.parameters),
}));

/** 推した入れる値の決まりを付け、承認の前の前提で、実行のたびに値が変わる欄を返す（画面のサーバの `attachInferredRulesOf` と同じ 2 段の口）。 */
const attachRules = (scenarioId: string, at: string): { readonly revision: number; readonly varying: readonly string[] } => {
  const scenario = readScenario(database, scenarioId);
  if (scenario === null) {
    throw new Error('no scenario');
  }
  const inferred = inferRuleSetContent(scenario.current, scenario.evidence);
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: inferred.content, expectedScenarioRevision: scenario.revision, at,
  });
  if (!saved.ruleSet.ok || saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the rules were not attached: ${JSON.stringify(saved)}`);
  }
  const { current, evidence, revision } = saved.attachment.scenario;
  return { revision, varying: varyingFieldNamesOf(planRuleSet(saved.ruleSet.ruleSet, current, evidence, undefined, PRE_APPROVAL_EVALUATION_PREMISE)) };
};

/** 承認のダイアログの 1 回の確認で承認する（MI-6 の口）。 */
const approve = (scenarioId: string, expectedRevision: number, receiptId: string) => {
  const status = readScenarioApprovalStatus(database, scenarioId, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
  return approveScenario(database, {
    scenarioId, expectedRevision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId, external: facts, at: APPROVED_AT, confirmSideEffects: true,
  });
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-form-autodraft-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  expect(createProfile(database, testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
  expect(createStartingJob(database, {
    jobId: DISCOVERY_JOB_ID, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: DISCOVERED_AT,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, DISCOVERY_JOB_ID, 0, DISCOVERED_AT)).toBe(true);
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT, entries: CANDIDATES.map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** 登録の下書きを、画面のサーバと同じ順で作る（シナリオ → 規則 → 照合の専用の定義 → 答え合わせに結ぶ）。作ったシナリオの id と版を返す。 */
const createFormDraft = (): { readonly scenarioId: string; readonly revision: number } => {
  const [create] = planOf().creates;
  if (create?.status !== 'NEW' || create.answerRead === null) {
    throw new Error(`the create is ${create?.status ?? 'none'}`);
  }
  expect(create.gaps).toEqual([]);
  const scenarioId = 'auto-form-create';
  expect(createScenario(database, { scenarioId, draft: create.draft, discovery: DISCOVERY, at: CREATED_AT })).toMatchObject({ ok: true });
  const { revision, varying } = attachRules(scenarioId, RULES_AT);
  const choice = formAnswerReadChoiceOf({
    answerRead: create.answerRead.value, definitions: readCheckFactsOf(), verificationOnlyReadCheckIds: readVerificationOnlyReadCheckIds(database, PROFILE_ID), maxDefinitions: 20,
  });
  if (choice.kind !== 'CREATE') {
    throw new Error(`the answer check is ${choice.kind}`);
  }
  const validation = validateReadCheckDefinition(choice.definition, create.answerRead.value.candidate);
  if (!validation.ok) {
    throw new Error(`the answer check was rejected: ${JSON.stringify(validation.errors)}`);
  }
  const saved = createReadCheck(database, { readCheckId: 'read-answer', profileId: PROFILE_ID, definition: validation.definition, at: CREATED_AT });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  const readVerification = formAnswerReadVerificationOf({
    reference: { readCheckId: 'read-answer', revision: saved.readCheck.revision }, parameterName: create.answerRead.value.parameterName,
    textFieldNames: create.textFieldNames, varyingFieldNames: varying,
  });
  expect(readVerification).not.toBeNull();
  const linked = updateScenario(database, {
    scenarioId, expectedRevision: revision, draft: { ...create.draft, verification: { recordId: create.recordId?.value ?? null, readVerification } },
    discovery: DISCOVERY, at: LINKED_AT,
  });
  if (!linked.ok) {
    throw new Error(`the answer check was not linked: ${linked.reason} ${JSON.stringify(linked.draftErrors)}`);
  }
  return { scenarioId, revision: linked.scenario.revision };
};

describe('PL-6b: the automatic form drafts saved through the current store', () => {
  it('makes a create with the record id, the answer check and the rules, approves it with one confirmation, and issues the grant', () => {
    const { scenarioId, revision } = createFormDraft();
    const scenario = readScenario(database, scenarioId);
    expect(scenario?.current.verification).toEqual({
      resultJudgement: 'FORM_STRUCTURE',
      recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/admin/members/{id}', '/admin/members/{id}/edit'] },
      readVerification: {
        readCheckId: 'read-answer', revision: 1, bindings: [{ parameterName: 'q', fieldName: 'name' }],
        expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }], verificationOnly: true,
      },
    });
    expect(scenario?.current.inputRuleReference).not.toBeNull();
    expect(missingVerificationItemsOf(scenario?.current.verification ?? { resultJudgement: null, recordId: null, readVerification: null }, scenario?.current)).toEqual([]);
    // 照合の専用の定義は、単独の READ の作業から外れる。
    expect(readVerificationOnlyReadCheckIds(database, PROFILE_ID)).toEqual(['read-answer']);
    const approved = approve(scenarioId, revision, 'receipt-create');
    expect(approved).toMatchObject({ ok: true, scenario: { state: 'APPROVED' } });
    const approvedRevision = approved.ok ? approved.scenario.revision : 0;
    expect(issueExecutionGrant(database, {
      scenarioId, expectedRevision: approvedRevision, grantId: 'grant-create', jobId: 'job-write-create', count: 1, external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: true });
    // 同じ行は、もう作らない。
    expect(planOf().creates).toEqual([{ status: 'EXISTING', row: expect.objectContaining({ kind: 'CREATE' }), scenarioId }]);
  });

  it('saves an update with the changed field only: the ledger, the templates and the verification come from the create', () => {
    const { scenarioId: ledgerId } = createFormDraft();
    // OP-2（D10、規則 F）: 変える欄は BeakSight が決める（登録で送った名前。保つ欄はメール）。
    const [planned] = planOf().updates;
    expect(planned).toMatchObject({ status: 'NEW', changedFieldNames: ['name'], keepFieldNames: ['email'], ground: 'SENT_BY_CREATE' });
    const ledger = readScenario(database, ledgerId);
    const preset = formUpdateDraftPresetOf(UPDATE, listScenarios(database, PROFILE_ID)
      .map(({ scenarioId, current }) => ({ scenarioId, kind: current.kind, recordId: current.verification.recordId })));
    expect(preset.ledger?.value).toBe(ledgerId);
    const templates = preset.templates?.value;
    if (ledger === null || templates === undefined) {
      throw new Error('no ledger or templates');
    }
    // 変える欄は規則 F の結果。保つ欄は、ほかの見えていて編集できる欄。
    const fieldNames = planned?.status === 'NEW' ? [...planned.changedFieldNames] : [];
    const copy = updateVerificationCopyOf({
      transport: 'FORM', ledger: ledger.current.verification, readChecks: readCheckFactsOf(), changedFieldNames: fieldNames,
      changedTextFieldNames: formTextFieldNamesOf(UPDATE, fieldNames),
    });
    if (copy.kind !== 'FILLED') {
      throw new Error(`the copy is ${copy.kind}`);
    }
    const draft = {
      profileId: PROFILE_ID, candidateIdentityDigest: UPDATE.identityDigest, fieldNames, readChecks: [],
      sideEffectConfirmations: ledger.current.sideEffectConfirmations, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, approvalTtlDays: 30,
      update: { targetCreateScenarioId: ledgerId, formPathTemplate: templates.formPathTemplate, actionPathTemplate: templates.actionPathTemplate, keepFieldNames: ['email'] },
      verification: { recordId: copy.recordId, readVerification: copy.readVerification },
    };
    const saved = createScenario(database, { scenarioId: 'form-update', draft, discovery: DISCOVERY, at: LINKED_AT });
    if (!saved.ok) {
      throw new Error(`the update was not saved: ${saved.reason} ${JSON.stringify(saved.draftErrors)}`);
    }
    expect(saved.scenario.current.verification.readVerification?.bindings).toEqual([{ parameterName: 'q', fieldName: 'name' }]);
    expect(missingVerificationItemsOf(saved.scenario.current.verification, saved.scenario.current)).toEqual([]);
    const { revision } = attachRules('form-update', LINKED_AT);
    expect(approve('form-update', revision, 'receipt-update')).toMatchObject({ ok: true, scenario: { state: 'APPROVED' } });
  });
});
