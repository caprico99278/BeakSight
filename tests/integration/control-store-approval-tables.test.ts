// 管理データのシナリオ・承認・許可・予約と入力の規則の表（`scenarios`、`scenario_revisions`、`approval_receipts`、`execution_grants`、
// `write_reservations`、`rule_sets`、`rule_set_revisions`）の結合テスト（T28c・T29d・T31e）。LG-2 で、版ごとのテスト（`control-store-v6`・`v7`・`v9`）の
// 今の形の確かめを、今の版の管理データの上にまとめた（前の版からの上げと前の版の文の固定は捨てた。CHECK の値の一覧が名前つきの一覧と等しいことは
// `control-store-base-schema.test.ts`）。
// - STRICT、プロファイルへの外部キー、ジョブへの外部キーなし、閉じた一覧と時刻・指紋・ID の形と、状態と時刻の組み合わせの CHECK、消費していない
//   有効な許可の部分一意の索引、1 つの許可に予約は 1 件。UPDATE の許可の対象のレコードの ID は、使える形か null。
// - 規則の集まりはシナリオごとに 1 つ、版の写しは規則の集まりと版で一意、digest の形・JSON の object・版の最小・時刻の形の CHECK。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RECEIPT_KINDS,
  SCENARIO_STATES,
  WRITE_RESERVATION_STATES,
} from '../../src/control/approval/scenario-contracts.js';
import {
  checkListOf,
  columnNamesOf,
  countOf,
  foreignTablesOf,
  indexNamesOf,
  insertRow,
  tableSqlOf,
  useControlStoreWorkspace,
  type SqlValue,
} from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-v6';
const OTHER_PROFILE_ID = 'example-v6-other';
const CREATED_AT = '20261012000000';
const LATER_AT = '20261012000100';
const EXPIRES_AT = '20261111000000';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const workspace = useControlStoreWorkspace('beaksight-control-approval-');

/** 今の版の管理データ（プロファイルを 2 つ入れた）の生の接続。 */
const latestConnection = (): DatabaseSync => workspace.latestConnection([PROFILE_ID, OTHER_PROFILE_ID]);

const scenarioRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'DRAFT', last_approval_receipt_id: null,
  created_at: CREATED_AT, updated_at: CREATED_AT, ...row,
});

const revisionRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  scenario_id: 'scenario-1', revision: 1, profile_id: PROFILE_ID, document: '{"kind":"CREATE"}', evidence: '{"kind":"FORM"}',
  discovery_job_id: 'job-1', recorded_at: CREATED_AT, ...row,
});

const approvalRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  receipt_id: 'receipt-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', kind: 'APPROVAL', scenario_revision: 1, approval_digest: DIGEST,
  target_receipt_id: null, recorded_at: CREATED_AT, expires_at: EXPIRES_AT, document: '{"kind":"APPROVAL"}', ...row,
});

const revocationRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  receipt_id: 'receipt-2', profile_id: PROFILE_ID, scenario_id: 'scenario-1', kind: 'REVOCATION', scenario_revision: null, approval_digest: null,
  target_receipt_id: 'receipt-1', recorded_at: LATER_AT, expires_at: null, document: '{"kind":"REVOCATION"}', ...row,
});

const grantRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  grant_id: 'grant-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, approval_receipt_id: 'receipt-1', job_id: 'job-w1',
  issued_at: CREATED_AT, expires_at: LATER_AT, consumed_at: null, invalidated_at: null, ...row,
});

const reservationRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  grant_id: 'grant-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', count: 1, state: 'RESERVED', reserved_at: CREATED_AT, settled_at: null, ...row,
});

/** シナリオと承認までの 1 組の行を入れた接続。 */
const approvedConnection = (): DatabaseSync => {
  const connection = latestConnection();
  insertRow(connection, 'scenarios', scenarioRow());
  insertRow(connection, 'scenario_revisions', revisionRow());
  insertRow(connection, 'approval_receipts', approvalRow());
  return connection;
};

describe('Control store: the scenario, approval, grant and reservation tables', () => {
  it('are STRICT, refer to the profiles (and not to the jobs), and have the columns of the design', () => {
    const connection = latestConnection();
    for (const table of ['scenarios', 'scenario_revisions', 'approval_receipts', 'execution_grants', 'write_reservations']) {
      expect(tableSqlOf(connection, table), table).toMatch(/\)\s*STRICT\s*$/u);
      expect(foreignTablesOf(connection, table), table).toContain('profiles');
      expect(foreignTablesOf(connection, table), table).not.toContain('jobs');
    }
    expect(columnNamesOf(connection, 'scenarios')).toEqual([
      'scenario_id', 'profile_id', 'revision', 'state', 'last_approval_receipt_id', 'created_at', 'updated_at',
    ]);
    expect(columnNamesOf(connection, 'scenario_revisions')).toEqual([
      'scenario_id', 'revision', 'profile_id', 'document', 'evidence', 'discovery_job_id', 'recorded_at',
    ]);
    expect(columnNamesOf(connection, 'approval_receipts')).toEqual([
      'receipt_id', 'profile_id', 'scenario_id', 'kind', 'scenario_revision', 'approval_digest', 'target_receipt_id', 'recorded_at', 'expires_at',
      'document',
    ]);
    expect(columnNamesOf(connection, 'execution_grants')).toEqual([
      'grant_id', 'profile_id', 'scenario_id', 'scenario_revision', 'approval_receipt_id', 'job_id', 'issued_at', 'expires_at', 'consumed_at',
      // T31e: UPDATE の許可の対象のレコードの ID。
      'invalidated_at', 'target_record_id',
    ]);
    expect(columnNamesOf(connection, 'write_reservations')).toEqual([
      'reservation_id', 'grant_id', 'profile_id', 'scenario_id', 'count', 'state', 'reserved_at', 'settled_at',
    ]);
    expect(checkListOf(tableSqlOf(connection, 'scenarios'), 'state')).toEqual([...SCENARIO_STATES]);
    expect(checkListOf(tableSqlOf(connection, 'approval_receipts'), 'kind')).toEqual([...APPROVAL_RECEIPT_KINDS]);
    expect(checkListOf(tableSqlOf(connection, 'write_reservations'), 'state')).toEqual([...WRITE_RESERVATION_STATES]);
    expect(indexNamesOf(connection, 'approval_receipts')).toEqual(['approval_receipts_scenario_recorded', 'approval_receipts_single_revocation']);
    expect(indexNamesOf(connection, 'execution_grants')).toEqual(['execution_grants_single_open']);
    expect(indexNamesOf(connection, 'write_reservations')).toEqual(['write_reservations_scenario_state', 'write_reservations_single_per_grant']);
    for (const table of ['scenarios', 'scenario_revisions', 'approval_receipts']) {
      expect(columnNamesOf(connection, table).filter((name) => /value|label|token|password|credential|secret/iu.test(name)), table).toEqual([]);
    }
  });

  it('accepts scenarios and revisions in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'scenarios', scenarioRow());
    insertRow(connection, 'scenario_revisions', revisionRow());
    insertRow(connection, 'scenario_revisions', revisionRow({ revision: 2 }));
    for (const [name, row] of [
      ['the same id twice', scenarioRow()],
      ['an unknown state', scenarioRow({ scenario_id: 's-2', state: 'EXPIRED' })],
      ['an approved state without an approval', scenarioRow({ scenario_id: 's-3', state: 'APPROVED' })],
      ['a revoked state without an approval', scenarioRow({ scenario_id: 's-4', state: 'REVOKED' })],
      ['a revision of 0', scenarioRow({ scenario_id: 's-5', revision: 0 })],
      ['an upper case id', scenarioRow({ scenario_id: 'Scenario-6' })],
      ['an update before the creation', scenarioRow({ scenario_id: 's-7', created_at: LATER_AT, updated_at: CREATED_AT })],
      ['a time that is not 14 digits', scenarioRow({ scenario_id: 's-8', updated_at: '2026-10-12' })],
      ['an unknown profile', scenarioRow({ scenario_id: 's-9', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'scenarios', row), name).toThrow();
    }
    insertRow(connection, 'scenarios', scenarioRow({ scenario_id: 's-approved', state: 'APPROVED', last_approval_receipt_id: 'receipt-x' }));
    expect(countOf(connection, 'scenarios')).toBe(2);
    for (const [name, row] of [
      ['the same revision twice', revisionRow()],
      ['an unknown scenario', revisionRow({ scenario_id: 'missing' })],
      ['a document that is not an object', revisionRow({ revision: 3, document: '[]' })],
      ['evidence that is not JSON', revisionRow({ revision: 3, evidence: '{' })],
      ['an upper case discovery job id', revisionRow({ revision: 3, discovery_job_id: 'Job-1' })],
      ['a revision of 0', revisionRow({ revision: 0 })],
    ] as const) {
      expect(() => insertRow(connection, 'scenario_revisions', row), name).toThrow();
    }
    expect(countOf(connection, 'scenario_revisions')).toBe(2);
  });

  it('accepts approval and revocation receipts and rejects the rows that break the CHECKs (one revocation per approval)', () => {
    const connection = approvedConnection();
    insertRow(connection, 'approval_receipts', revocationRow());
    for (const [name, row] of [
      ['the same receipt twice', approvalRow()],
      ['an unknown kind', approvalRow({ receipt_id: 'r-3', kind: 'EXPIRY' })],
      ['an approval without a revision', approvalRow({ receipt_id: 'r-4', scenario_revision: null })],
      ['an approval without a digest', approvalRow({ receipt_id: 'r-5', approval_digest: null })],
      ['an approval without an expiry', approvalRow({ receipt_id: 'r-6', expires_at: null })],
      ['an approval with a target', approvalRow({ receipt_id: 'r-7', target_receipt_id: 'receipt-1' })],
      ['an expiry before the approval', approvalRow({ receipt_id: 'r-8', expires_at: CREATED_AT })],
      ['a digest of another shape', approvalRow({ receipt_id: 'r-9', approval_digest: 'a'.repeat(64) })],
      ['a revocation without a target', revocationRow({ receipt_id: 'r-10', target_receipt_id: null })],
      ['a revocation with a digest', revocationRow({ receipt_id: 'r-11', approval_digest: DIGEST })],
      ['a second revocation of the same approval', revocationRow({ receipt_id: 'r-12' })],
      ['a revocation of an unknown receipt', revocationRow({ receipt_id: 'r-13', target_receipt_id: 'missing' })],
      ['a document that is not an object', approvalRow({ receipt_id: 'r-14', document: '"x"' })],
      ['an unknown scenario', approvalRow({ receipt_id: 'r-15', scenario_id: 'missing' })],
    ] as const) {
      expect(() => insertRow(connection, 'approval_receipts', row), name).toThrow();
    }
    expect(countOf(connection, 'approval_receipts')).toBe(2);
  });

  it('accepts execution grants and keeps one open grant per scenario', () => {
    const connection = approvedConnection();
    insertRow(connection, 'execution_grants', grantRow());
    for (const [name, row] of [
      ['a second open grant of the scenario', grantRow({ grant_id: 'grant-2', job_id: 'job-w2' })],
      ['a second grant for the same job', grantRow({ grant_id: 'grant-3', consumed_at: LATER_AT })],
      ['an expiry not after the issue', grantRow({ grant_id: 'grant-4', job_id: 'job-w4', expires_at: CREATED_AT, consumed_at: LATER_AT })],
      ['a grant both consumed and invalidated', grantRow({ grant_id: 'grant-5', job_id: 'job-w5', consumed_at: LATER_AT, invalidated_at: LATER_AT })],
      ['an unknown approval receipt', grantRow({ grant_id: 'grant-6', job_id: 'job-w6', approval_receipt_id: 'missing', consumed_at: LATER_AT })],
      ['an upper case job id', grantRow({ grant_id: 'grant-7', job_id: 'Job-W7', consumed_at: LATER_AT })],
    ] as const) {
      expect(() => insertRow(connection, 'execution_grants', row), name).toThrow();
    }
    insertRow(connection, 'execution_grants', grantRow({ grant_id: 'grant-8', job_id: 'job-w8', consumed_at: LATER_AT }));
    insertRow(connection, 'execution_grants', grantRow({ grant_id: 'grant-9', job_id: 'job-w9', invalidated_at: LATER_AT }));
    expect(countOf(connection, 'execution_grants')).toBe(3);
  });

  it('accepts a usable record id or null as the target of a grant, and rejects other values', () => {
    const connection = approvedConnection();
    insertRow(connection, 'execution_grants', grantRow({ consumed_at: LATER_AT }));
    insertRow(connection, 'execution_grants', grantRow({ grant_id: 'grant-2', job_id: 'job-w2', consumed_at: LATER_AT }));
    connection.prepare("UPDATE execution_grants SET target_record_id = 'rec-1' WHERE grant_id = 'grant-1'").run();
    expect(() => connection.prepare("UPDATE execution_grants SET target_record_id = '../1' WHERE grant_id = 'grant-2'").run()).toThrow();
    expect(() => connection.prepare("UPDATE execution_grants SET target_record_id = '' WHERE grant_id = 'grant-2'").run()).toThrow();
    expect(connection.prepare('SELECT grant_id, target_record_id FROM execution_grants ORDER BY grant_id').all())
      .toEqual([{ grant_id: 'grant-1', target_record_id: 'rec-1' }, { grant_id: 'grant-2', target_record_id: null }]);
  });

  it('accepts write reservations in each state with the matching time and rejects the rest', () => {
    const connection = approvedConnection();
    insertRow(connection, 'execution_grants', grantRow());
    insertRow(connection, 'write_reservations', reservationRow());
    // T28R-fix-1（M-4）: 1 つの許可に予約は 1 件なので、決着した状態ごとに、消費した許可を 1 つずつ作る。
    WRITE_RESERVATION_STATES.filter((value) => value !== 'RESERVED').forEach((state, index) => {
      const grantId = `grant-settled-${index}`;
      insertRow(connection, 'execution_grants', grantRow({ grant_id: grantId, job_id: `job-settled-${index}`, consumed_at: LATER_AT }));
      insertRow(connection, 'write_reservations', reservationRow({ grant_id: grantId, state, settled_at: LATER_AT }));
    });
    for (const [name, row] of [
      ['an unknown state', reservationRow({ state: 'SENT' })],
      ['a reserved state with a settled time', reservationRow({ settled_at: LATER_AT })],
      ['a released state without a settled time', reservationRow({ state: 'RELEASED' })],
      ['a settled time before the reservation', reservationRow({ state: 'COMMITTED', reserved_at: LATER_AT, settled_at: CREATED_AT })],
      ['a count of 0', reservationRow({ count: 0 })],
      ['a count above the per-run default', reservationRow({ count: 2 })],
      ['an unknown grant', reservationRow({ grant_id: 'missing' })],
      // T28R-fix-1（M-4）: 1 つの許可に予約は 1 件まで（一意の索引）。
      ['a second reservation of the same grant', reservationRow({ state: 'RELEASED', settled_at: LATER_AT })],
    ] as const) {
      expect(() => insertRow(connection, 'write_reservations', row), name).toThrow();
    }
    expect(countOf(connection, 'write_reservations')).toBe(WRITE_RESERVATION_STATES.length);
  });
});

describe('Control store: the rule set tables', () => {
  const RULE_CREATED_AT = '20261013000000';
  const RULE_LATER_AT = '20261013000100';

  /** シナリオ 1 件を入れた接続。 */
  const scenarioConnection = (): DatabaseSync => {
    const connection = latestConnection();
    insertRow(connection, 'scenarios', scenarioRow({ created_at: RULE_CREATED_AT, updated_at: RULE_CREATED_AT }));
    return connection;
  };

  const ruleSetRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    rule_set_id: 'rules-1', scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, created_at: RULE_CREATED_AT, updated_at: RULE_CREATED_AT, ...row,
  });

  const ruleRevisionRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    rule_set_id: 'rules-1', revision: 1, scenario_id: 'scenario-1', profile_id: PROFILE_ID, document: '{"schemaVersion":"beaksight-data-rule/2"}',
    digest: DIGEST, recorded_at: RULE_CREATED_AT, ...row,
  });

  it('makes STRICT tables with foreign keys to the profiles and the scenarios', () => {
    const connection = scenarioConnection();
    for (const table of ['rule_sets', 'rule_set_revisions']) {
      expect(tableSqlOf(connection, table)).toMatch(/\)\s*STRICT$/u);
    }
    expect(foreignTablesOf(connection, 'rule_sets')).toEqual(['profiles', 'scenarios']);
    expect(foreignTablesOf(connection, 'rule_set_revisions')).toEqual(['profiles', 'rule_sets', 'scenarios']);
  });

  it('accepts a rule set and its revisions', () => {
    const connection = scenarioConnection();
    insertRow(connection, 'rule_sets', ruleSetRow());
    insertRow(connection, 'rule_set_revisions', ruleRevisionRow());
    insertRow(connection, 'rule_set_revisions', ruleRevisionRow({ revision: 2, recorded_at: RULE_LATER_AT }));
    expect(countOf(connection, 'rule_set_revisions')).toBe(2);
  });

  it.each<readonly [string, string, Record<string, SqlValue>]>([
    ['a second rule set of the scenario', 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2' })],
    ['a rule set of a missing scenario', 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2', scenario_id: 'scenario-missing' })],
    ['a revision of 0', 'rule_set_revisions', ruleRevisionRow({ revision: 0 })],
    ['a duplicate revision', 'rule_set_revisions', ruleRevisionRow()],
    ['a bad digest', 'rule_set_revisions', ruleRevisionRow({ revision: 3, digest: 'sha256:xyz' })],
    ['a document that is not an object', 'rule_set_revisions', ruleRevisionRow({ revision: 3, document: '[]' })],
    ['a bad time', 'rule_set_revisions', ruleRevisionRow({ revision: 3, recorded_at: '2026-10-13' })],
    ['a revision of a missing rule set', 'rule_set_revisions', ruleRevisionRow({ rule_set_id: 'rules-missing', revision: 3 })],
  ])('rejects %s', (_label, table, row) => {
    const connection = scenarioConnection();
    insertRow(connection, 'rule_sets', ruleSetRow());
    insertRow(connection, 'rule_set_revisions', ruleRevisionRow());
    expect(() => insertRow(connection, table, row)).toThrow();
  });

  it('rejects a bad rule set id (for another scenario)', () => {
    const connection = scenarioConnection();
    insertRow(connection, 'scenarios', scenarioRow({ scenario_id: 'scenario-2', created_at: RULE_CREATED_AT, updated_at: RULE_CREATED_AT }));
    expect(() => insertRow(connection, 'rule_sets', ruleSetRow({ rule_set_id: 'Rules_2', scenario_id: 'scenario-2' }))).toThrow();
    insertRow(connection, 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2', scenario_id: 'scenario-2' }));
    expect(countOf(connection, 'rule_sets')).toBe(1);
  });

  it('rejects a rule set whose update time is before its creation time', () => {
    const connection = scenarioConnection();
    expect(() => insertRow(connection, 'rule_sets', ruleSetRow({ updated_at: '20261012000000' }))).toThrow();
  });
});
