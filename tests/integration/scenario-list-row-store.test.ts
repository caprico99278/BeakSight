// LU-6 fix round 1（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.4、fix round 1 の判断 1・3）: 一覧の行の API の更新（台帳に `listRow`）を、
// 本物の管理データに保存して読み戻し、承認の有効性を確かめる。
// - 台帳は API の登録（ID は応答の本文の鍵 `id`）。入力の規則の最新の版から、実行のたびに違う値になる欄（メール）が台帳の事実
//   （`scenarioKindFactsIn` の `uniqueEachRunFieldNames`）に入り、行を選ぶ欄の確かめが通る。規則がなければ拒む（今のまま）。
// - 一覧の行の更新は画面の path を型にした識別の digest を持たず、承認の有効性は API の登録と同じく候補の識別の digest で確かめる。
// 管理データは一時のフォルダだけを使う。値は匿名の合成のテストデータだけ。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import {
  approveScenario,
  createScenario,
  readScenario,
  readScenarioApprovalStatus,
  type ApprovalExternalFacts,
} from '../../src/control/approval/scenario-store.js';
import { scenarioKindFactsIn } from '../../src/control/approval/scenario-facts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { withReadTransaction } from '../../src/control/store/transaction.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import {
  observedSubmissionProbeOf,
  submissionProbeOpenerOf,
  type SubmissionProbeInputField,
  type SubmissionProbeOpener,
} from '../../src/discovery/submission-probe-contracts.js';
import { ALL_CONFIRMED, candidateOf } from '../unit/approval-samples.js';
import { NO_JS_BINDING, sampleButton } from '../unit/discovery-candidate-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';

const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-list-row' } });
const PROFILE_ID = 'example-list-row';
const CREATE_ID = 'scenario-list-create';
const UPDATE_ID = 'scenario-list-update';
const READ_CHECK_ID = 'rc-list';
const DISCOVERY_JOB_ID = 'job-lrow-d1';
const API_ORIGIN = 'https://api.example.invalid';
const NEW_PATH = '/admin/members/new';
const LIST_PATH = '/admin/members';
const DISCOVERED_AT = '20261102000000';
const CREATED_AT = '20261102001000';
const APPROVED_AT = '20261102002000';
const OPENER_DIGEST = `sha256:${'1'.repeat(64)}`;

const PROBE_MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];
const BODY = { name: PROBE_MARKERS[0], email: PROBE_MARKERS[1] };

/** form のない画面の保存のボタン（probe が API の型を見た候補。一覧の行の開き手の後に押した保存は `opener` を持つ）。 */
const buttonOf = (path: string, method: string, url: string, opener?: SubmissionProbeOpener): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: TEST_ORIGIN, path }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method, resourceType: 'fetch', url, origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' }, body: { kind: 'TEXT', text: JSON.stringify(BODY) },
    }, { pagePath: path, markers: PROBE_MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 2, skippedFieldCount: 0 }, INPUT_FIELDS, ['保存'], opener),
});
const CREATE_CANDIDATE = buttonOf(NEW_PATH, 'POST', `${API_ORIGIN}/rest/v1/members?select=*`);
const LIST_UPDATE_CANDIDATE = buttonOf(LIST_PATH, 'PATCH', `${API_ORIGIN}/rest/v1/members?id=eq.4&select=*`,
  submissionProbeOpenerOf(OPENER_DIGEST, true, ['編集']));

const pageOf = (candidate: DiscoveryCandidate) => ({
  url: `${TEST_ORIGIN}${candidate.page.path}`,
  state: 'READ',
  record: { location: candidate.page, incompleteReasons: [], candidates: [candidate] },
  blockedRequests: 0,
});
const DISCOVERY: DiscoveryDocument = {
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: DISCOVERY_JOB_ID,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [pageOf(CREATE_CANDIDATE), pageOf(LIST_UPDATE_CANDIDATE)],
  omittedUnreadPages: 0,
} as DiscoveryDocument;

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

const LIST_ROW = Object.freeze({ listPagePath: LIST_PATH, openerIdentityDigest: OPENER_DIGEST, rowKeyField: 'email' });

let workDirectory = '';
let database: ControlDatabase;
let facts: ApprovalExternalFacts;

const revisionOf = (scenarioId: string): number => readScenario(database, scenarioId)?.revision ?? 0;

const draftOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[], api: Record<string, unknown>, expectedField: string) => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: {
    resultJudgement: null, recordId: null,
    readVerification: { readCheckId: READ_CHECK_ID, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: expectedField }] },
  },
  api: { shapeDigest: candidate.submissionProbe?.shapeDigest ?? '', pageKeys: [], filterName: null, recordId: null, ledger: null, ...api },
});

const UPDATE_DRAFT = draftOf(LIST_UPDATE_CANDIDATE, ['name'], {
  filterName: 'id', ledger: { targetCreateScenarioId: CREATE_ID, formPathTemplate: LIST_PATH, listRow: LIST_ROW },
}, 'name');

/** 台帳の登録の入力の規則（メールは型から作る。実行のたびに違う値になる欄）。 */
const attachCreateRules = (): void => {
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${CREATE_ID}`, scenarioId: CREATE_ID, expectedRevision: null, content: {
      fieldRules: [
        { fieldName: 'email', semanticKind: 'EMAIL', method: 'FROM_TYPE', range: null, fixedValues: [] },
        { fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['登録一郎'] },
      ] as never,
      relations: [],
      uniqueKeyFieldNames: [],
    },
    expectedScenarioRevision: revisionOf(CREATE_ID), at: CREATED_AT,
  });
  if (saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  }
};

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-list-row-store-'));
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
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT,
    entries: mergeDiscoveryCandidates([CREATE_CANDIDATE, LIST_UPDATE_CANDIDATE]).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(DISCOVERY),
  });
  expect(createReadCheck(database, {
    readCheckId: READ_CHECK_ID, profileId: PROFILE_ID,
    definition: { targetPagePath: '/admin/members/{id}', parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, at: DISCOVERED_AT,
  })).toMatchObject({ ok: true });
  const stored = getProfile(database, PROFILE_ID);
  const external = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (external === null) {
    throw new Error('the external facts are not available');
  }
  facts = external;
  expect(createScenario(database, {
    scenarioId: CREATE_ID, draft: draftOf(CREATE_CANDIDATE, ['email', 'name'], { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }, 'email'),
    discovery: DISCOVERY, at: CREATED_AT,
  } as Parameters<typeof createScenario>[1])).toMatchObject({ ok: true });
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('LU-6 fix round 1: a list row API UPDATE in the control data', () => {
  it('puts the fields that differ each run of the ledger into the scenario facts (from the latest input rules), and none without rules', () => {
    const factOf = () => withReadTransaction(database, (connection) => scenarioKindFactsIn(connection, PROFILE_ID))
      .find(({ scenarioId }) => scenarioId === CREATE_ID);
    expect(factOf()?.uniqueEachRunFieldNames).toBeNull();
    attachCreateRules();
    expect(factOf()?.uniqueEachRunFieldNames).toEqual(['email']);
  });

  it('rejects the list row update while the ledger has no input rules (the row key field cannot be checked)', () => {
    const saved = createScenario(database, { scenarioId: UPDATE_ID, draft: UPDATE_DRAFT, discovery: DISCOVERY, at: CREATED_AT } as Parameters<typeof createScenario>[1]);
    expect(saved).toMatchObject({ ok: false });
    expect(JSON.stringify(saved)).toContain('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
  });

  it('saves the list row update, reads it back, and approves it by the identity digest of the candidate', () => {
    attachCreateRules();
    expect(createScenario(database, { scenarioId: UPDATE_ID, draft: UPDATE_DRAFT, discovery: DISCOVERY, at: CREATED_AT } as Parameters<typeof createScenario>[1]))
      .toMatchObject({ ok: true });
    const api = readScenario(database, UPDATE_ID)?.current.api;
    expect(api?.ledger).toEqual({ targetCreateScenarioId: CREATE_ID, formPathTemplate: LIST_PATH, listRow: LIST_ROW });
    expect(api?.templatedIdentityDigest).toBeUndefined();
    // 承認の確かめ（候補の識別の digest で候補を見つける。型にした digest がなくても `RangeError` にしない）。
    const status = readScenarioApprovalStatus(database, UPDATE_ID, facts, dateOfCompactUtcTimestamp(APPROVED_AT));
    expect(status?.approvalDigest).toMatch(/^sha256:/u);
    expect(approveScenario(database, {
      scenarioId: UPDATE_ID, expectedRevision: revisionOf(UPDATE_ID), expectedApprovalDigest: status?.approvalDigest ?? '', receiptId: 'receipt-update',
      external: facts, at: APPROVED_AT,
    })).toMatchObject({ ok: true });
  });
});
