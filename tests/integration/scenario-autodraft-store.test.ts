// FM2b（手を減らす段 2 の設計書 3A.2。5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））: ボタン 1 回で作る下書きを、今の保存の口で保存したときの
// 結合。管理データは一時のフォルダの本物（`openControlDatabase`）。発見の文書と索引は合成の値（サイトに接続しない）。
// - 作った登録の下書きは `DRAFT` で、副作用の確認の 4 項目はすべて偽。承認は、今の承認の手順（画面が出した版と承認の digest、副作用の確認）でだけ通る:
//   そのままでは `SCENARIO_SIDE_EFFECTS_UNCONFIRMED`、違う digest は `SCENARIO_APPROVAL_DIGEST_MISMATCH`、人が副作用を確かめて版を上げた後の今の digest で
//   だけ承認できる。
// - 変える欄が 0 の更新の下書きは、今の保存の口で保存できない（`SCENARIO_UPDATE_NO_CHANGED_FIELD`。何も書かない）ので、承認に進めない。自動の下書きは更新を
//   保存しない（作成の画面へ案内する）。登録を保存した後は、その登録が台帳の案になる（結び付く登録が 1 つ）。
// - 保存した後に計画をやり直すと、同じ型の行は「既にある」になり、作らない。
// 値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  apiAutoDraftPlanOf,
  apiUpdateDraftPresetOf,
  inferredReadExpectationOf,
  type AutoDraftScenarioFact,
} from '../../src/control/approval/api-scenario-autodraft.js';
import { planRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { varyingFieldNamesOf } from '../../src/control/data-rules/varying-values.js';
import { apiScenarioDraftInputOf, apiScenarioFormOf } from '../../src/control/approval/api-scenario-draft.js';
import {
  approveScenario,
  createScenario,
  listScenarios,
  readScenarioApprovalStatus,
  readScenarioDraftContext,
  updateScenario,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import { ALL_CONFIRMED, candidateOf } from '../unit/approval-samples.js';
import { NO_JS_BINDING, sampleButton } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-autodraft';
const DISCOVERY_JOB_ID = 'job-autodraft-d1';
const API_ORIGIN = 'https://api.example.invalid';
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
const CREATE_ID = 'scenario-auto-create';
const DISCOVERED_AT = '20261022000000';
const CREATED_AT = '20261022001000';
const CHANGED_AT = '20261022002000';
const APPROVED_AT = '20261022003000';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-autodraft' } });
const OTHER_DIGEST = `sha256:${'9'.repeat(64)}`;

const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];

const buttonOf = (path: string, method: string, url: string): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: TEST_ORIGIN, path }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method, resourceType: 'fetch', url, origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1] }) },
    }, { pagePath: path, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 2, skippedFieldCount: 0 }, INPUT_FIELDS),
});
const CREATE_CANDIDATE = buttonOf(NEW_PATH, 'POST', `${API_ORIGIN}/rest/v1/members?select=*`);
const UPDATE_CANDIDATE = buttonOf(EDIT_PATH, 'PATCH', `${API_ORIGIN}/rest/v1/members?id=eq.1&select=*`);

const pageOf = (candidate: DiscoveryCandidate) => ({
  url: `${TEST_ORIGIN}${candidate.page.path}`,
  state: 'READ',
  record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
  blockedRequests: 0,
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
  pages: [pageOf(CREATE_CANDIDATE), pageOf(UPDATE_CANDIDATE)],
  omittedUnreadPages: 0,
} as DiscoveryDocument;
const CANDIDATES = mergeDiscoveryCandidates([CREATE_CANDIDATE, UPDATE_CANDIDATE]);

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
  scenarioId: scenario.scenarioId,
  kind: scenario.current.kind,
  state: scenario.state,
  candidateIdentityDigest: scenario.current.candidate.identityDigest,
  shapeDigest: scenario.current.api?.shapeDigest ?? null,
}));
const planOf = () => apiAutoDraftPlanOf({ profileId: PROFILE_ID, candidates: CANDIDATES, context: contextOf(), scenarios: scenarioFactsOf() });

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-scenario-autodraft-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  expect(createProfile(database, { ...testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), approvedServiceOrigins: [API_ORIGIN] },
    { resolveContext: resolveTestContext }).ok).toBe(true);
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

describe('FM2b: the automatic drafts saved through the current store', () => {
  it('saves the create draft as a DRAFT with no side effect confirmed, and approves it only through the current approval steps', () => {
    const [create] = planOf().creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    const created = createScenario(database, { scenarioId: CREATE_ID, draft: create.draft, discovery: DISCOVERY, at: CREATED_AT });
    if (!created.ok) {
      throw new Error(`the create draft was not saved: ${created.reason} ${JSON.stringify(created.draftErrors)}`);
    }
    expect(created.scenario.state).toBe('DRAFT');
    expect(Object.values(created.scenario.current.sideEffectConfirmations)).toEqual([false, false, false, false]);
    expect(created.scenario.current.api?.recordId).toEqual({ source: 'RESPONSE_BODY_KEY', key: 'id' });

    // そのままでは承認できない（副作用を確かめていない）。違う digest も拒む。
    const first = readScenarioApprovalStatus(database, CREATE_ID, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
    expect(approveScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: 1, expectedApprovalDigest: first?.approvalDigest ?? '', receiptId: 'receipt-1', external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: false, reason: 'SCENARIO_SIDE_EFFECTS_UNCONFIRMED' });
    expect(approveScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: 1, expectedApprovalDigest: OTHER_DIGEST, receiptId: 'receipt-2', external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: false, reason: 'SCENARIO_APPROVAL_DIGEST_MISMATCH' });

    // 人が副作用を確かめて版を上げる（今の変更の口）。前の digest では承認できず、今の digest でだけ承認できる。
    expect(updateScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: 1, draft: { ...create.draft, sideEffectConfirmations: ALL_CONFIRMED }, discovery: DISCOVERY, at: CHANGED_AT,
    })).toMatchObject({ ok: true, scenario: { revision: 2, state: 'DRAFT' } });
    expect(approveScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: 2, expectedApprovalDigest: first?.approvalDigest ?? '', receiptId: 'receipt-3', external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: false, reason: 'SCENARIO_APPROVAL_DIGEST_MISMATCH' });
    const current = readScenarioApprovalStatus(database, CREATE_ID, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
    expect(approveScenario(database, {
      scenarioId: CREATE_ID, expectedRevision: 2, expectedApprovalDigest: current?.approvalDigest ?? '', receiptId: 'receipt-4', external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: true, scenario: { state: 'APPROVED' } });
  });

  it('cannot save an update draft without a changed key (so it never reaches the approval), and binds the update to the saved create', () => {
    const plan = planOf();
    expect(plan.updates.map(({ status }) => status)).toEqual(['NEEDS_CHANGED_FIELDS']);
    const [create] = plan.creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    expect(createScenario(database, { scenarioId: CREATE_ID, draft: create.draft, discovery: DISCOVERY, at: CREATED_AT })).toMatchObject({ ok: true });
    // 作る順: 登録を保存した後の文脈で、更新の台帳の案は、その登録（結び付く登録が 1 つ）。
    const { form } = apiScenarioFormOf({
      profileId: PROFILE_ID, candidate: UPDATE_CANDIDATE, context: contextOf(),
      scenarios: listScenarios(database, PROFILE_ID).map((scenario) => ({ scenarioId: scenario.scenarioId, kind: scenario.current.kind, pagePath: scenario.evidence.page.path })),
    });
    if (form === null) {
      throw new Error('the update has no form');
    }
    const preset = apiUpdateDraftPresetOf(form);
    expect(preset.ledger).toEqual({ value: CREATE_ID, origin: 'DETERMINED', ground: 'SINGLE_BOUND_LEDGER' });
    // 変える鍵を選ばない（すべて保つ）更新の下書きは、今の保存の口が拒み、何も書かない。
    const probe = UPDATE_CANDIDATE.submissionProbe as SubmissionProbeRecord;
    const base = apiScenarioDraftInputOf(PROFILE_ID, UPDATE_CANDIDATE, probe, { fieldNames: [], pageKeys: [], formPathTemplate: preset.formPathTemplate?.value ?? '' });
    const draft = {
      ...base,
      api: {
        ...(base['api'] as Record<string, unknown>), keptKeys: ['email', 'name'],
        ledger: { targetCreateScenarioId: CREATE_ID, formPathTemplate: preset.formPathTemplate?.value ?? '' },
      },
    };
    const saved = createScenario(database, { scenarioId: 'scenario-auto-update', draft, discovery: DISCOVERY, at: CREATED_AT });
    expect(saved).toMatchObject({ ok: false, reason: 'SCENARIO_DRAFT_INVALID' });
    expect(saved.ok ? [] : saved.draftErrors.map(({ code }) => code)).toEqual(['SCENARIO_UPDATE_NO_CHANGED_FIELD']);
    expect(listScenarios(database, PROFILE_ID).map(({ scenarioId }) => scenarioId)).toEqual([CREATE_ID]);
  });

  it('infers the expectation of the READ from a varying field after the inferred rules are attached', () => {
    const [create] = planOf().creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    const created = createScenario(database, { scenarioId: CREATE_ID, draft: create.draft, discovery: DISCOVERY, at: CREATED_AT });
    if (!created.ok) {
      throw new Error('the create draft was not saved');
    }
    const inferred = inferRuleSetContent(created.scenario.current, created.scenario.evidence);
    const saved = saveRuleSetAndAttach(database, {
      ruleSetId: `rules-${CREATE_ID}`, scenarioId: CREATE_ID, expectedRevision: null, content: inferred.content,
      expectedScenarioRevision: created.scenario.revision, at: CHANGED_AT,
    });
    if (!saved.ruleSet.ok || saved.attachment === null || !saved.attachment.ok) {
      throw new Error(`the rules were not attached: ${JSON.stringify(saved)}`);
    }
    const { current, evidence } = saved.attachment.scenario;
    const varying = varyingFieldNamesOf(planRuleSet(saved.ruleSet.ruleSet, current, evidence));
    expect(inferredReadExpectationOf(current.fieldNames, varying))
      .toEqual({ value: { kind: 'TEXT_CONTAINS', fieldName: varying.find((name) => current.fieldNames.includes(name)) }, origin: 'INFERRED',
        ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' });
    expect(varying.length).toBeGreaterThan(0);
  });

  it('does not make the drafts again once the rows have scenarios', () => {
    const [create] = planOf().creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    expect(createScenario(database, { scenarioId: CREATE_ID, draft: create.draft, discovery: DISCOVERY, at: CREATED_AT })).toMatchObject({ ok: true });
    expect(planOf().creates).toEqual([{ status: 'EXISTING', row: expect.objectContaining({ kind: 'CREATE' }), scenarioId: CREATE_ID }]);
  });
});
