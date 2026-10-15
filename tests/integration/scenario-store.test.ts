// T28c（Task 28 の設計書 3 章、4.1、4.2、4.7、10 章の 1・3・4）: シナリオ・版の写し・承認と撤回の記録の保存（`src/control/approval/scenario-store.ts`）の
// 結合テスト。
// - 作成: 最後の発見のジョブの `discovery.json` から候補の写しを読み、`validateScenarioDraft` を通す。取り消したプロファイル、書き込みのモードでない
//   プロファイル、最後の発見でない文書、見つからない候補は拒む。
// - 版の更新: 画面が読んだ版と違えば `SCENARIO_REVISION_CONFLICT`。承認済みの版を変えると `DRAFT` に戻る。
// - 承認: 画面から来た版と承認の digest が、サーバで求め直した値と一致し、副作用の確認がすべて済み、承認できる事実（再承認の判定の理由が
//   `NOT_APPROVED` だけ）のときだけ、承認者 `LOCAL_OPERATOR` の記録を追記する。撤回: 撤回の記録を追記し、状態を `REVOKED` にする。
// - 承認と撤回の記録は行が増えるだけ（書き換えない）。データベースを開き直した後も、読み出しと有効性が同じ。
// - 秘密: 写しと記録に、入力の値・トークン・hidden の値・資格情報が入らない（目印の値で確かめる。入れる口がない・形の外の項目は拒む）。
// 一時のフォルダだけを使い、終わったら消す。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import { UNSPECIFIED_VERIFICATION } from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_STORE_REJECTION_REASONS,
  approveScenario,
  createScenario,
  issueExecutionGrant,
  listScenarios,
  readApprovalReceipts,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioRevisions,
  revokeScenarioApproval,
  updateScenario,
  type ApprovalExternalFacts,
  type ScenarioStoreResult,
} from '../../src/control/approval/scenario-store.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, retireProfile, updateProfile } from '../../src/control/store/profile-store.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
} from '../../src/discovery/discovery-result.js';
import { ALL_CONFIRMED, CREATE_CANDIDATE, READ_CANDIDATE, UPDATE_CANDIDATE, candidateOf } from '../unit/approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import { resolveTestContext, testAuthProfile, testWriteProfile } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-write';
const PASSIVE_PROFILE_ID = 'example-passive';
const DISCOVERED_AT = '20261012000000';
const CREATED_AT = '20261012010000';
const UPDATED_AT = '20261012020000';
const APPROVED_AT = '20261012030000';
const REVOKED_AT = '20261012040000';
const EXPIRES_AT = '20261111030000';
const IN_TTL = new Date(Date.parse('2026-10-13T00:00:00Z'));
const AFTER_TTL = new Date(Date.parse('2026-11-11T03:00:00Z'));
const EXTERNAL: ApprovalExternalFacts = Object.freeze({
  authSetupDigest: `sha256:${'2'.repeat(64)}`,
  targetConfigDigest: '3'.repeat(64),
});
const SECRET_MARKER = 'MARKER-SECRET-VALUE-T28C';

let workDirectory = '';
let database: ControlDatabase;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

/** 発見のジョブ 1 回の `discovery.json` の形。 */
const discoveryDocument = (jobId: string, candidates: readonly DiscoveryCandidate[]): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId,
  runId: 'RUN-000001',
  startedAt: DISCOVERED_AT,
  finishedAt: DISCOVERED_AT,
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [{
    url: 'http://127.0.0.1:4173/members/new',
    state: 'READ',
    record: { location: { origin: 'http://127.0.0.1:4173', path: '/members/new' }, incompleteReasons: [], candidates: [...candidates] },
    blockedRequests: 0,
  }],
  omittedUnreadPages: 0,
});

/** 発見のジョブを索引に記録し、その文書を返す。 */
const discover = (jobId: string, candidates: readonly DiscoveryCandidate[], at = DISCOVERED_AT): DiscoveryDocument => {
  const document = discoveryDocument(jobId, candidates);
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID,
    jobId,
    at,
    entries: mergeDiscoveryCandidates(candidates).map(discoveryIndexEntryOf),
    readPagePaths: discoveryReadPagePaths(document),
  });
  return document;
};

const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
  // T30f fix round 1（DEF-098）: CREATE の候補の見えていて編集できる select（`plan`）も送る欄にする。
  fieldNames: ['name', 'email', 'plan'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  ...overrides,
});

let latest: DiscoveryDocument;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-scenario-store-'));
  database = openControlDatabase(databasePath());
  expect(createProfile(database, testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(createProfile(database, testAuthProfile(PASSIVE_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  latest = discover('job-d1', [CREATE_CANDIDATE, UPDATE_CANDIDATE, READ_CANDIDATE]);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const create = (overrides: Record<string, unknown> = {}, scenarioId = 'scenario-1', discovery: DiscoveryDocument | null = latest): ScenarioStoreResult =>
  createScenario(database, { scenarioId, draft: draft(overrides), discovery, at: CREATED_AT });

const digestOf = (scenarioId = 'scenario-1', external: ApprovalExternalFacts = EXTERNAL): string => {
  const status = readScenarioApprovalStatus(database, scenarioId, external, IN_TTL);
  if (status === null) {
    throw new Error('no scenario');
  }
  return status.approvalDigest;
};

const approve = (overrides: Partial<Parameters<typeof approveScenario>[1]> = {}): ScenarioStoreResult => approveScenario(database, {
  scenarioId: 'scenario-1',
  expectedRevision: 1,
  expectedApprovalDigest: digestOf(),
  receiptId: 'receipt-1',
  external: EXTERNAL,
  at: APPROVED_AT,
  ...overrides,
});

const reasonOf = (result: ScenarioStoreResult): string | null => (result.ok ? null : result.reason);

describe('scenario store (T28c): create', () => {
  it('has the closed list of the rejection reasons', () => {
    expect(SCENARIO_STORE_REJECTION_REASONS).toEqual([
      'SCENARIO_PROFILE_NOT_FOUND',
      'SCENARIO_PROFILE_RETIRED',
      'SCENARIO_MODE_NOT_WRITE',
      'SCENARIO_DISCOVERY_NOT_LATEST',
      'SCENARIO_CANDIDATE_NOT_FOUND',
      'SCENARIO_DRAFT_INVALID',
      'SCENARIO_NOT_FOUND',
      'SCENARIO_REVISION_CONFLICT',
      'SCENARIO_APPROVAL_DIGEST_MISMATCH',
      'SCENARIO_SIDE_EFFECTS_UNCONFIRMED',
      'SCENARIO_NOT_APPROVABLE',
      'SCENARIO_NOT_APPROVED',
      'SCENARIO_FACTS_CHANGED',
      // T29d fix round 1: 付ける入力の規則の参照が、規則の集まりの最新の版と一致しない。
      'SCENARIO_INPUT_RULES_NOT_LATEST',
      // T31b: UPDATE の指定の前に保存した UPDATE の版は、承認しない。
      'SCENARIO_UPDATE_SPEC_MISSING',
    ]);
    expect(Object.isFrozen(SCENARIO_STORE_REJECTION_REASONS)).toBe(true);
  });

  it('creates a DRAFT at revision 1 with the copy of the candidate of the latest discovery, and reads it back', () => {
    const created = create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.scenario).toMatchObject({
      scenarioId: 'scenario-1', profileId: PROFILE_ID, revision: 1, state: 'DRAFT', lastApprovalReceiptId: null,
      createdAt: CREATED_AT, updatedAt: CREATED_AT, discoveryJobId: 'job-d1',
    });
    expect(created.scenario.current).toMatchObject({
      schemaVersion: 'beaksight-scenario/1', scenarioId: 'scenario-1', revision: 1, kind: 'CREATE', fieldNames: ['email', 'name', 'plan'],
      inputRuleReference: null, createdAt: CREATED_AT, updatedAt: CREATED_AT,
      candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest },
    });
    expect(created.scenario.evidence).toEqual(CREATE_CANDIDATE);
    expect(Object.isFrozen(created.scenario.evidence)).toBe(true);
    expect(readScenario(database, 'scenario-1')).toEqual(created.scenario);
    expect(readScenario(database, 'scenario-missing')).toBeNull();
    expect(listScenarios(database, PROFILE_ID).map(({ scenarioId }) => scenarioId)).toEqual(['scenario-1']);
    expect(readScenarioRevisions(database, 'scenario-1').map(({ revision }) => revision)).toEqual([1]);
  });

  it('rejects a profile that is missing, retired or not in the write mode, and writes nothing', () => {
    expect(reasonOf(create({ profileId: 'missing-profile' }))).toBe('SCENARIO_PROFILE_NOT_FOUND');
    expect(reasonOf(create({ profileId: PASSIVE_PROFILE_ID }, 'scenario-passive'))).toBe('SCENARIO_MODE_NOT_WRITE');
    expect(retireProfile(database, { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    expect(reasonOf(create())).toBe('SCENARIO_PROFILE_RETIRED');
    expect(listScenarios(database, PROFILE_ID)).toEqual([]);
  });

  it('rejects a document that is not of the latest discovery job, and a candidate that it does not have', () => {
    const older = latest;
    latest = discover('job-d2', [CREATE_CANDIDATE, UPDATE_CANDIDATE], '20261012000500');
    expect(reasonOf(create({}, 'scenario-old', older))).toBe('SCENARIO_DISCOVERY_NOT_LATEST');
    expect(reasonOf(create({}, 'scenario-none', null))).toBe('SCENARIO_DISCOVERY_NOT_LATEST');
    expect(reasonOf(create({ candidateIdentityDigest: READ_CANDIDATE.identityDigest, fieldNames: ['q'] }, 'scenario-read')))
      .toBe('SCENARIO_CANDIDATE_NOT_FOUND');
    expect(listScenarios(database, PROFILE_ID)).toEqual([]);
  });

  it('rejects a draft that validateScenarioDraft rejects, with its errors', () => {
    const result = create({ fieldNames: ['API-Key', 'plan'], approvalTtlDays: 31 });
    expect(result.ok ? null : [result.reason, result.draftErrors.map(({ code }) => code)])
      .toEqual(['SCENARIO_DRAFT_INVALID', ['SCENARIO_FIELD_SECRET_LIKE', 'SCENARIO_TTL_ABOVE_DEFAULT']]);
    expect(reasonOf(create({ candidateIdentityDigest: READ_CANDIDATE.identityDigest, fieldNames: [] }, 'scenario-read')))
      .toBe('SCENARIO_DRAFT_INVALID');
  });

  it('checks the READ check references against the definitions of the profile', () => {
    expect(createReadCheck(database, {
      readCheckId: 'rc-1', profileId: PROFILE_ID, at: CREATED_AT,
      definition: { targetIdentityDigest: READ_CANDIDATE.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    }).ok).toBe(true);
    expect(create({ readChecks: [{ readCheckId: 'rc-1', revision: 1 }] }).ok).toBe(true);
    const stale = create({ readChecks: [{ readCheckId: 'rc-1', revision: 2 }] }, 'scenario-2');
    expect(stale.ok ? null : stale.draftErrors.map(({ code }) => code)).toEqual(['SCENARIO_READ_CHECK_REVISION_MISMATCH']);
  });

  it('rejects a used scenario id as a caller error', () => {
    create();
    expect(() => create()).toThrow(RangeError);
  });
});

describe('scenario store (T28c): revisions', () => {
  it('raises the revision, keeps the old revision, and rejects a stale revision', () => {
    create();
    const changed = updateScenario(database, {
      scenarioId: 'scenario-1', expectedRevision: 1, draft: draft({ fieldNames: ['name', 'plan'], approvalTtlDays: 7 }), discovery: latest, at: UPDATED_AT,
    });
    expect(changed.ok && changed.scenario).toMatchObject({ revision: 2, state: 'DRAFT', updatedAt: UPDATED_AT, createdAt: CREATED_AT });
    expect(changed.ok && changed.scenario.current).toMatchObject({ revision: 2, fieldNames: ['name', 'plan'], approvalTtlDays: 7, createdAt: CREATED_AT, updatedAt: UPDATED_AT });
    expect(readScenarioRevisions(database, 'scenario-1').map(({ revision, scenario }) => [revision, scenario.approvalTtlDays])).toEqual([[1, 30], [2, 7]]);
    expect(reasonOf(updateScenario(database, { scenarioId: 'scenario-1', expectedRevision: 1, draft: draft(), discovery: latest, at: UPDATED_AT })))
      .toBe('SCENARIO_REVISION_CONFLICT');
    expect(reasonOf(updateScenario(database, { scenarioId: 'scenario-missing', expectedRevision: 1, draft: draft(), discovery: latest, at: UPDATED_AT })))
      .toBe('SCENARIO_NOT_FOUND');
  });

  it('returns an approved scenario to DRAFT when its revision changes, and the approval is no longer valid', () => {
    create();
    expect(approve().ok).toBe(true);
    const changed = updateScenario(database, { scenarioId: 'scenario-1', expectedRevision: 1, draft: draft({ fieldNames: ['name', 'plan'] }), discovery: latest, at: REVOKED_AT });
    expect(changed.ok && [changed.scenario.state, changed.scenario.lastApprovalReceiptId]).toEqual(['DRAFT', 'receipt-1']);
    const status = readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL);
    expect(status?.validity).toEqual({ approved: false, reasons: ['SCENARIO_REVISION_CHANGED'] });
  });

  it('rejects a change for a retired profile', () => {
    create();
    expect(retireProfile(database, { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    expect(reasonOf(updateScenario(database, { scenarioId: 'scenario-1', expectedRevision: 1, draft: draft(), discovery: latest, at: UPDATED_AT })))
      .toBe('SCENARIO_PROFILE_RETIRED');
  });
});

describe('scenario store (T28c): approval and revocation', () => {
  it('appends an approval of LOCAL_OPERATOR when the revision and the digest match, and the approval is valid', () => {
    create();
    const digest = digestOf();
    const approved = approve({ expectedApprovalDigest: digest });
    expect(approved.ok && approved.scenario).toMatchObject({ state: 'APPROVED', lastApprovalReceiptId: 'receipt-1', updatedAt: APPROVED_AT });
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual([{
      schemaVersion: 'beaksight-approval-receipt/1',
      kind: 'APPROVAL',
      receiptId: 'receipt-1',
      profileId: PROFILE_ID,
      scenarioId: 'scenario-1',
      scenarioRevision: 1,
      approvalDigest: digest,
      bound: {
        profileRevision: MIN_PROFILE_REVISION,
        authSetupDigest: EXTERNAL.authSetupDigest,
        targetConfigDigest: EXTERNAL.targetConfigDigest,
        candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
        candidateRuleDigest: CREATE_CANDIDATE.ruleDigest,
        inputRuleReference: null,
      },
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      approver: 'LOCAL_OPERATOR',
    }]);
    const scenario = readScenario(database, 'scenario-1');
    expect(digest).toBe(scenario === null ? '' : computeApprovalDigest(scenario.current, {
      profileRevision: MIN_PROFILE_REVISION, authSetupDigest: EXTERNAL.authSetupDigest, targetConfigDigest: EXTERNAL.targetConfigDigest,
    }));
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: true, receiptId: 'receipt-1', expiresAt: EXPIRES_AT });
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, AFTER_TTL)?.validity).toEqual({ approved: false, reasons: ['EXPIRED'] });
  });

  it('rejects an old revision, a digest computed from other facts, and unconfirmed side effects, and writes nothing', () => {
    create();
    expect(reasonOf(approve({ expectedRevision: 2 }))).toBe('SCENARIO_REVISION_CONFLICT');
    const otherDigest = digestOf('scenario-1', { ...EXTERNAL, targetConfigDigest: '4'.repeat(64) });
    expect(reasonOf(approve({ expectedApprovalDigest: otherDigest }))).toBe('SCENARIO_APPROVAL_DIGEST_MISMATCH');
    expect(reasonOf(approve({ external: { ...EXTERNAL, authSetupDigest: null } }))).toBe('SCENARIO_APPROVAL_DIGEST_MISMATCH');
    expect(reasonOf(approve({ scenarioId: 'scenario-missing' }))).toBe('SCENARIO_NOT_FOUND');
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual([]);

    expect(create({ sideEffectConfirmations: { ...ALL_CONFIRMED, NO_EXTERNAL_NOTIFICATION: false } }, 'scenario-2').ok).toBe(true);
    expect(reasonOf(approveScenario(database, {
      scenarioId: 'scenario-2', expectedRevision: 1, expectedApprovalDigest: digestOf('scenario-2'), receiptId: 'receipt-2', external: EXTERNAL, at: APPROVED_AT,
    }))).toBe('SCENARIO_SIDE_EFFECTS_UNCONFIRMED');
    expect(readScenario(database, 'scenario-2')?.state).toBe('DRAFT');
  });

  it('rejects an approval when the facts do not allow it (the candidate is missing, the profile changed), with the reasons', () => {
    create();
    latest = discover('job-d2', [UPDATE_CANDIDATE], '20261012000500');
    const missing = approve();
    expect(missing.ok ? null : [missing.reason, missing.invalidityReasons]).toEqual(['SCENARIO_NOT_APPROVABLE', ['CANDIDATE_MISSING']]);
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual([]);
  });

  it('rejects the approval of a scenario whose profile was retired', () => {
    create();
    const digest = digestOf();
    expect(retireProfile(database, { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    const result = approve({ expectedApprovalDigest: digest });
    expect(result.ok).toBe(false);
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual([]);
  });

  it('requires a new approval after a profile edit (any edit)', () => {
    create();
    expect(approve().ok).toBe(true);
    expect(updateProfile(database, {
      profile: { ...testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION + 1), environmentEvidenceRef: 'evidence/example-test-env/isolation-check-2' },
      expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: false, reasons: ['PROFILE_REVISION_CHANGED'] });
  });

  it('revokes the last approval by appending a revocation, and does not revoke twice', () => {
    create();
    approve();
    const revoked = revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-2', at: REVOKED_AT });
    expect(revoked.ok && revoked.scenario).toMatchObject({ state: 'REVOKED', lastApprovalReceiptId: 'receipt-1', updatedAt: REVOKED_AT });
    expect(readApprovalReceipts(database, 'scenario-1').map(({ kind, receiptId }) => [kind, receiptId]))
      .toEqual([['APPROVAL', 'receipt-1'], ['REVOCATION', 'receipt-2']]);
    expect(readApprovalReceipts(database, 'scenario-1')[1]).toEqual({
      schemaVersion: 'beaksight-approval-receipt/1', kind: 'REVOCATION', receiptId: 'receipt-2', profileId: PROFILE_ID, scenarioId: 'scenario-1',
      targetReceiptId: 'receipt-1', revokedAt: REVOKED_AT, reason: 'OPERATOR_REQUEST',
    });
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL)?.validity).toEqual({ approved: false, reasons: ['REVOKED'] });
    expect(reasonOf(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-3', at: REVOKED_AT })))
      .toBe('SCENARIO_NOT_APPROVED');
    expect(reasonOf(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 2, receiptId: 'receipt-3', at: REVOKED_AT })))
      .toBe('SCENARIO_REVISION_CONFLICT');
  });

  it('approves again after a revocation, only by appending (the receipts are never rewritten)', () => {
    create();
    approve();
    revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-2', at: REVOKED_AT });
    const before = readApprovalReceipts(database, 'scenario-1');
    expect(approve({ receiptId: 'receipt-3', at: '20261012050000' }).ok).toBe(true);
    const after = readApprovalReceipts(database, 'scenario-1');
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map(({ receiptId }) => receiptId)).toEqual(['receipt-1', 'receipt-2', 'receipt-3']);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: true, receiptId: 'receipt-3', expiresAt: '20261111050000' });
  });

  // T28R-fix-1（M-4）: 撤回の記録の対象が承認の記録であることは、表の CHECK では他の行を見られないので、保存の部品の書き方で守る（撤回の対象は、
  // そのシナリオの最後の承認の記録だけ）。今の書き方で守られていることを固定する。
  it('makes every revocation target the approval receipt that it revokes', () => {
    create();
    approve();
    revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-2', at: REVOKED_AT });
    approve({ receiptId: 'receipt-3', at: '20261012050000' });
    revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-4', at: '20261012060000' });
    const receipts = readApprovalReceipts(database, 'scenario-1');
    const kindOf = new Map(receipts.map((receipt) => [receipt.receiptId, receipt.kind]));
    const targets = receipts.flatMap((receipt) => (receipt.kind === 'REVOCATION' ? [receipt.targetReceiptId] : []));
    expect(targets).toEqual(['receipt-1', 'receipt-3']);
    expect(targets.map((target) => kindOf.get(target))).toEqual(['APPROVAL', 'APPROVAL']);
    expect(reasonOf(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-5', at: '20261012070000' })))
      .toBe('SCENARIO_NOT_APPROVED');
  });

  it('rejects the revocation of a scenario without an approval', () => {
    create();
    expect(reasonOf(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: 1, receiptId: 'receipt-2', at: REVOKED_AT })))
      .toBe('SCENARIO_NOT_APPROVED');
    expect(reasonOf(revokeScenarioApproval(database, { scenarioId: 'scenario-missing', expectedRevision: 1, receiptId: 'receipt-2', at: REVOKED_AT })))
      .toBe('SCENARIO_NOT_FOUND');
  });
});

// T30a（Task 30 の設計書 3 章の「検証の指定」）: 検証の指定を保存の形に通し、照合の READ の結び付けを READ の定義の今の版の送る値で確かめる。
// 検証の指定の前に保存した版は、すべて未指定として読む。
describe('scenario store (T30a): verification spec', () => {
  const VERIFICATION = Object.freeze({
    successCondition: { pathPrefix: '/members/', selector: '.registered' },
    inputErrorCondition: { pathPrefix: '/members/new', selector: '.error' },
    recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' },
    readVerification: {
      readCheckId: 'rc-1',
      revision: 1,
      bindings: [{ parameterName: 'q', fieldName: 'name' }],
      expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
    },
  });

  beforeEach(() => {
    expect(createReadCheck(database, {
      readCheckId: 'rc-1', profileId: PROFILE_ID, at: CREATED_AT,
      definition: { targetIdentityDigest: READ_CANDIDATE.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    }).ok).toBe(true);
  });

  it('stores the verification spec and reads it back after reopening the database', () => {
    expect(create({ verification: VERIFICATION }).ok).toBe(true);
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readScenario(database, 'scenario-1')?.current.verification).toEqual(VERIFICATION);
  });

  it('checks the bindings against the parameters of the current revision of the READ check', () => {
    const result = create({ verification: { ...VERIFICATION, readVerification: { ...VERIFICATION.readVerification, bindings: [{ parameterName: 'page', fieldName: 'name' }] } } });
    expect(result.ok ? null : result.draftErrors.map(({ code }) => code)).toEqual(['SCENARIO_VERIFICATION_PARAMETER_UNKNOWN']);
    expect(readScenario(database, 'scenario-1')).toBeNull();
  });

  it('reads a revision stored before the verification spec as all unspecified', () => {
    expect(create().ok).toBe(true);
    closeControlDatabase(database);
    const raw = new DatabaseSync(databasePath());
    try {
      const row = raw.prepare('SELECT document FROM scenario_revisions WHERE scenario_id = ?').get('scenario-1') as { readonly document: string };
      const { verification: _omitted, ...legacy } = JSON.parse(row.document) as Record<string, unknown>;
      raw.prepare('UPDATE scenario_revisions SET document = ? WHERE scenario_id = ?').run(JSON.stringify(legacy), 'scenario-1');
    } finally {
      raw.close();
    }
    database = openControlDatabase(databasePath());
    expect(readScenario(database, 'scenario-1')?.current.verification).toEqual(UNSPECIFIED_VERIFICATION);
  });
});

// T31b（Task 31 の設計書 3 章の「UPDATE の指定」、11 章の T31b の Blocker の判断）: UPDATE のシナリオの保存・承認・発行。
describe('scenario store (T31b): UPDATE scenarios', () => {
  const UPDATE_DRAFT = Object.freeze({
    candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest,
    fieldNames: ['name'],
    update: { targetCreateScenarioId: 'scenario-1', formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}', keepFieldNames: [] },
  });

  /** 保存した版から UPDATE の指定を除く（UPDATE の指定の前に保存した版の形）。 */
  const dropUpdateSpec = (scenarioId: string): void => {
    closeControlDatabase(database);
    const raw = new DatabaseSync(databasePath());
    try {
      const row = raw.prepare('SELECT document FROM scenario_revisions WHERE scenario_id = ?').get(scenarioId) as { readonly document: string };
      const { update: _omitted, ...legacy } = JSON.parse(row.document) as Record<string, unknown>;
      raw.prepare('UPDATE scenario_revisions SET document = ? WHERE scenario_id = ?').run(JSON.stringify(legacy), scenarioId);
    } finally {
      raw.close();
    }
    database = openControlDatabase(databasePath());
  };

  it('saves an UPDATE scenario that refers to a CREATE scenario of the profile, with the templated identity digest', () => {
    expect(create().ok).toBe(true);
    const created = create(UPDATE_DRAFT, 'scenario-update');
    expect(created.ok ? created.scenario.current.update : null).toMatchObject({
      targetCreateScenarioId: 'scenario-1',
      formPathTemplate: '/members/{id}/edit',
      actionPathTemplate: '/members/{id}',
      keepFieldNames: [],
    });
    expect(readScenario(database, 'scenario-update')?.current.kind).toBe('UPDATE');
    // CREATE のシナリオは UPDATE の指定を持たない。
    expect(readScenario(database, 'scenario-1')?.current.update).toBeNull();
  });

  it('checks the target with the scenarios of the profile in the same transaction', () => {
    const missing = create(UPDATE_DRAFT, 'scenario-update');
    expect(missing.ok ? null : missing.draftErrors.map(({ code }) => code)).toEqual(['SCENARIO_UPDATE_TARGET_NOT_FOUND']);
    expect(create().ok).toBe(true);
    expect(create(UPDATE_DRAFT, 'scenario-update').ok).toBe(true);
    // UPDATE のシナリオは台帳の参照にできない。
    const chained = create({ ...UPDATE_DRAFT, update: { ...UPDATE_DRAFT.update, targetCreateScenarioId: 'scenario-update' } }, 'scenario-update-2');
    expect(chained.ok ? null : chained.draftErrors.map(({ code }) => code)).toEqual(['SCENARIO_UPDATE_TARGET_NOT_CREATE']);
  });

  /** 別のレコード（`/members/2`）の、同じ形の更新の画面の候補（T31e）。 */
  const OTHER_RECORD_UPDATE_CANDIDATE = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/2/edit' },
    action: sampleAction('/members/2'),
    methodOverride: 'PATCH',
    submitterText: '更新',
    enctype: 'multipart/form-data',
    fields: [sampleField('name'), sampleField('_method', 'hidden', { hasValue: true })],
  }));

  /** 索引の型にした識別の digest の一覧を消す（管理データの版 9 の前に書いた索引の形）。 */
  const dropTemplatedDigests = (): void => {
    closeControlDatabase(database);
    const raw = new DatabaseSync(databasePath());
    try {
      raw.prepare('UPDATE discovery_candidates SET templated_identity_digests = NULL').run();
    } finally {
      raw.close();
    }
    database = openControlDatabase(databasePath());
  };

  it('approves an UPDATE scenario with the templated digests of the index (version 9. T31e)', () => {
    expect(create().ok).toBe(true);
    expect(create({ ...UPDATE_DRAFT, sideEffectConfirmations: ALL_CONFIRMED }, 'scenario-update').ok).toBe(true);
    expect(readScenarioApprovalStatus(database, 'scenario-update', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: false, reasons: ['NOT_APPROVED'] });
    const result = approve({ scenarioId: 'scenario-update', expectedApprovalDigest: digestOf('scenario-update') });
    expect(result.ok).toBe(true);
  });

  it('keeps an UPDATE approval valid with the index of another record page only (T31e)', () => {
    expect(create().ok).toBe(true);
    expect(create({ ...UPDATE_DRAFT, sideEffectConfirmations: ALL_CONFIRMED }, 'scenario-update').ok).toBe(true);
    expect(approve({ scenarioId: 'scenario-update', expectedApprovalDigest: digestOf('scenario-update') }).ok).toBe(true);
    // 次の発見で、レコード 1 の画面は読まず、レコード 2 の画面だけを読んだ（レコード 1 の候補は `NOT_REVISITED`）。
    latest = discover('job-d2', [CREATE_CANDIDATE, OTHER_RECORD_UPDATE_CANDIDATE, READ_CANDIDATE], '20261012000500');
    expect(readScenarioApprovalStatus(database, 'scenario-update', EXTERNAL, IN_TTL)?.validity).toMatchObject({ approved: true });
  });

  it('does not approve an UPDATE scenario with an index written before version 9 (CANDIDATE_TEMPLATES_UNAVAILABLE)', () => {
    expect(create().ok).toBe(true);
    expect(create({ ...UPDATE_DRAFT, sideEffectConfirmations: ALL_CONFIRMED }, 'scenario-update').ok).toBe(true);
    dropTemplatedDigests();
    const result = approve({ scenarioId: 'scenario-update', expectedApprovalDigest: digestOf('scenario-update') });
    expect(result.ok ? null : [result.reason, result.invalidityReasons]).toEqual(['SCENARIO_NOT_APPROVABLE', ['CANDIDATE_TEMPLATES_UNAVAILABLE']]);
    // 次の発見で一覧を書くと、承認できる。
    latest = discover('job-d2', [CREATE_CANDIDATE, UPDATE_CANDIDATE, READ_CANDIDATE], '20261012000500');
    expect(approve({ scenarioId: 'scenario-update', expectedApprovalDigest: digestOf('scenario-update') }).ok).toBe(true);
  });

  it('reads a stored UPDATE revision without the spec, and neither approves it nor issues a grant for it', () => {
    expect(create().ok).toBe(true);
    expect(create(UPDATE_DRAFT, 'scenario-update').ok).toBe(true);
    dropUpdateSpec('scenario-update');
    expect(readScenario(database, 'scenario-update')?.current.update).toBeNull();
    expect(readScenarioApprovalStatus(database, 'scenario-update', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: false, reasons: ['UPDATE_SPEC_MISSING', 'NOT_APPROVED'] });
    expect(reasonOf(approve({ scenarioId: 'scenario-update', expectedApprovalDigest: digestOf('scenario-update') }))).toBe('SCENARIO_UPDATE_SPEC_MISSING');
    const issued = issueExecutionGrant(database, {
      scenarioId: 'scenario-update', expectedRevision: 1, grantId: 'grant-1', jobId: 'job-w1', count: 1, external: EXTERNAL, at: APPROVED_AT,
    });
    expect(issued.ok ? null : issued.reason).toBe('SCENARIO_UPDATE_SPEC_MISSING');
  });
});

describe('scenario store (T28c): after reopening the database', () => {
  it('reads the same scenario, revisions, receipts and validity', () => {
    create();
    approve();
    const scenario = readScenario(database, 'scenario-1');
    const receipts = readApprovalReceipts(database, 'scenario-1');
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readScenario(database, 'scenario-1')).toEqual(scenario);
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual(receipts);
    expect(readScenarioRevisions(database, 'scenario-1')).toHaveLength(1);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, IN_TTL)?.validity)
      .toEqual({ approved: true, receiptId: 'receipt-1', expiresAt: EXPIRES_AT });
  });
});

describe('scenario store (T28c): secrets', () => {
  it('stores no input value, token, hidden value or credential in the copies and the receipts', () => {
    create();
    approve();
    // 目印の値を入れる口がない（下書きの形の外の項目、候補の形の外の項目、外の事実の余分な項目）。どれも拒まれるか、書かれない。
    expect(reasonOf(create({ values: { name: SECRET_MARKER } }, 'scenario-marker-1'))).toBe('SCENARIO_DRAFT_INVALID');
    const smuggled = { ...CREATE_CANDIDATE, fields: CREATE_CANDIDATE.fields.map((field) => ({ ...field, value: SECRET_MARKER })) } as DiscoveryCandidate;
    expect(() => create({}, 'scenario-marker-2', discoveryDocument('job-d1', [smuggled, UPDATE_CANDIDATE, READ_CANDIDATE]))).toThrow(RangeError);
    expect(create({}, 'scenario-marker-3').ok).toBe(true);
    expect(approveScenario(database, {
      scenarioId: 'scenario-marker-3', expectedRevision: 1, expectedApprovalDigest: digestOf('scenario-marker-3'), receiptId: 'receipt-m',
      external: { ...EXTERNAL, password: SECRET_MARKER } as ApprovalExternalFacts, at: APPROVED_AT,
    }).ok).toBe(true);
    closeControlDatabase(database);
    for (const path of [databasePath(), `${databasePath()}-wal`]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(SECRET_MARKER, 'utf8')), path).toBe(false);
      }
    }
    database = openControlDatabase(databasePath());
    const evidence = JSON.stringify(readScenarioRevisions(database, 'scenario-1'));
    expect(evidence).not.toMatch(/"value"|"label"|"password"|"token"/u);
    expect(JSON.stringify(readApprovalReceipts(database, 'scenario-marker-3'))).not.toContain(SECRET_MARKER);
  });
});
