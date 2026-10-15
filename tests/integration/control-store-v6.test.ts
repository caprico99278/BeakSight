// T28c（Task 28 の設計書 4.2「管理データの版 6」）: 管理データの版 6 の結合テスト。
// - 版 5 の文の CHECK の値の一覧は、版 5 を公開した時点の写しで固定する（版 4 と同じ教訓）。版 1〜5 の生成される SQL の文を、版ごとの SHA-256 で
//   固定する（版 5 の値は、T28c の変更の前の `dist` の文から求めた。写しへの置き換えの前後で同じ）。版 6 の文も SHA-256 で固定する（次の版のため）。
// - 版 1〜5 のデータベースが、`openControlDatabase` で版 6 に上がる。
// - 版 6 の表（`scenarios`、`scenario_revisions`、`approval_receipts`、`execution_grants`、`write_reservations`）: STRICT、プロファイルへの外部キー、
//   ジョブへの外部キーなし、閉じた一覧（T28a の一覧）と時刻・指紋・ID の形と、状態と時刻の組み合わせの CHECK、消費していない有効な許可の部分一意の索引。
// 一時のフォルダだけを使い、終わったら消す。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_RECEIPT_KINDS,
  SCENARIO_STATES,
  WRITE_RESERVATION_STATES,
} from '../../src/control/approval/scenario-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_STATES,
  AUDIT_JOB_STATES_WITH_REASON,
  FINAL_AUDIT_JOB_STATES,
} from '../../src/control/job/job-records.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { WORKER_AUTH_STATES, WORKER_OUTCOME_KINDS } from '../../src/control/worker-protocol.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  FORM_METHODS,
  METHOD_OVERRIDE_VALUES,
} from '../../src/discovery/candidate-contracts.js';
import { READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { expectRowsCopiedThroughUpgrade, snapshotTableRows } from '../helpers/control-upgrade-rows.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const DISCOVERY_SCHEMA_VERSION = 5;
const APPROVAL_SCHEMA_VERSION = 6;
const PROFILE_ID = 'example-v6';
const OTHER_PROFILE_ID = 'example-v6-other';
const CREATED_AT = '20261012000000';
const LATER_AT = '20261012000100';
const EXPIRES_AT = '20261111000000';
const DIGEST = `sha256:${'a'.repeat(64)}`;

// ---------------------------------------------------------------------------------------------------------------
// 公開した時点の値の一覧（版 5。ここを書き換えると、公開済みの版の中身が変わる）
// ---------------------------------------------------------------------------------------------------------------

const PUBLISHED_V5_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_V5_ACTIVE_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING'];
const PUBLISHED_V5_FINAL_JOB_STATES = ['FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_V5_JOB_STATES_WITH_REASON = ['FAILED', 'INTERRUPTED'];
const PUBLISHED_V5_RUN_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY'];
const PUBLISHED_V5_OUTCOME_KINDS = ['RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE'];
const PUBLISHED_V5_FAILURE_REASONS = [
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED',
  'AUTH_SETUP_CHANGED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN',
  'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID',
  'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST',
  'JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID',
];
const PUBLISHED_V5_AUTH_STATES = [
  'AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'AUTOMATED_LOGIN_FAILED',
];
const PUBLISHED_V5_JOB_KINDS = ['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK'];
const PUBLISHED_V5_CLASSIFICATIONS = [
  'READ', 'CREATE', 'UPDATE', 'NOT_EXECUTABLE', 'NEEDS_BINDING', 'UNSUPPORTED_READ_TRANSPORT', 'BLOCKED_EXTERNAL', 'DISPLAY_ONLY',
];
const PUBLISHED_V5_REASON_CODES = [
  'ACTION_OUTSIDE_ALLOWED_ORIGINS', 'DESTRUCTIVE', 'READ_GET_FORM', 'GET_WITH_PASSWORD_FIELD', 'GET_WITH_MULTIPART', 'POST_SEARCH',
  'GRAPHQL_ENDPOINT', 'JS_BOUND', 'JS_DELEGATED', 'NO_KNOWN_ACTION', 'DIALOG_METHOD', 'METHOD_OVERRIDE_UNRECOGNIZED', 'UPDATE_METHOD',
  'UPDATE_WORD', 'CREATE_WORD', 'UNCLASSIFIED', 'DUPLICATE_IDENTITY_CONFLICT',
];
const PUBLISHED_V5_FORM_METHODS = ['GET', 'POST', 'DIALOG'];
const PUBLISHED_V5_METHOD_OVERRIDES = ['PUT', 'PATCH', 'DELETE'];
const PUBLISHED_V5_READ_CHECK_RESULTS = [
  'MATCHED', 'NOT_MATCHED', 'UNDETERMINED', 'READ_BLOCKED_BY_POLICY', 'READ_CANDIDATE_DRIFTED', 'READ_CANDIDATE_NOT_READ',
];

/** 版 5 の文の、`<列> IN (…)` の一覧のすべて（出てくる順）。 */
const PUBLISHED_VERSION_5_LISTS: readonly string[] = [
  `state: ${PUBLISHED_V5_JOB_STATES.join(',')}`,
  'start_new: 0,1',
  `run_status: ${PUBLISHED_V5_RUN_STATUSES.join(',')}`,
  `end_kind: ${PUBLISHED_V5_OUTCOME_KINDS.join(',')}`,
  `failure_reason: ${PUBLISHED_V5_FAILURE_REASONS.join(',')}`,
  `last_auth_state: ${PUBLISHED_V5_AUTH_STATES.join(',')}`,
  `job_kind: ${PUBLISHED_V5_JOB_KINDS.join(',')}`,
  `state: ${PUBLISHED_V5_FINAL_JOB_STATES.join(',')}`,
  `state: ${PUBLISHED_V5_JOB_STATES_WITH_REASON.join(',')}`,
  `state: ${PUBLISHED_V5_ACTIVE_JOB_STATES.join(',')}`,
  `state: ${PUBLISHED_V5_ACTIVE_JOB_STATES.join(',')}`,
  `classification: ${PUBLISHED_V5_CLASSIFICATIONS.join(',')}`,
  `reason_code: ${PUBLISHED_V5_REASON_CODES.join(',')}`,
  `form_method: ${PUBLISHED_V5_FORM_METHODS.join(',')}`,
  `method_override: ${PUBLISHED_V5_METHOD_OVERRIDES.join(',')}`,
  'has_state_field: 0,1',
  `result: ${PUBLISHED_V5_READ_CHECK_RESULTS.join(',')}`,
];

/** 版 6 の文の、`<列> IN (…)` の一覧のすべて（出てくる順。版 6 を公開するときの写し）。 */
const VERSION_6_LISTS: readonly string[] = [
  'state: DRAFT,APPROVED,REVOKED',
  'kind: APPROVAL,REVOCATION',
  'state: RESERVED,RELEASED,COMMITTED,UNKNOWN',
];

/** 版の文をつなぐ区切り（SHA-256 を求めるときだけに使う。`control-store-v4.test.ts`・`control-store-v5.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/**
 * 版 1〜6 の文（`statements` を `STATEMENT_SEPARATOR` でつないだ UTF-8）の SHA-256。版 1〜4 は `control-store-v5.test.ts` と同じ値。版 5 は、T28c の
 * 変更の前の `dist`（2026-10-12 の build）の文から求めた。版 6 は、T28c で版 6 を作った時点の文から求めた（公開の前に変えるときは、この値も変える）。
 */
const STATEMENT_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
  'c01a9cc2de065f758b0280b4294a5be917b9f1ad963db6128f8286ed97f91356',
  'e29dd348aa3d4846b4b19e25e0a8806407a9f39f43ccc4b4a380f3a1b3413816',
  // T28R-fix-1（独立レビュー T28R の M-4）: 版 6（未公開）に、1 つの許可に予約は 1 件の一意の索引を足した（前の値は 77c71766…）。
  '5538786b9028813c60d5ea87df1b51db74a232244724b43136692ace2a27533d',
];

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v6-'));
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) connection.close();
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

const rawConnection = (): DatabaseSync => {
  const connection = new DatabaseSync(databasePath(), { timeout: RAW_TIMEOUT_MS, enableForeignKeyConstraints: true });
  connections.push(connection);
  return connection;
};

const inListsOf = (statements: readonly string[]): readonly string[] =>
  statements.flatMap((statement) => [...statement.matchAll(/\b(\w+) IN \(([^()]*)\)/gu)]
    .map((match) => `${match[1]}: ${(match[2] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, '')).join(',')}`));

const sha256Of = (statements: readonly string[]): string => createHash('sha256').update(statements.join(STATEMENT_SEPARATOR), 'utf8').digest('hex');

const prepareAtVersion = (versions: number): DatabaseSync => {
  mkdirSync(dirname(databasePath()), { recursive: true });
  const raw = rawConnection();
  raw.exec('PRAGMA journal_mode = WAL');
  expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, versions))).toEqual({ foundSchemaVersion: 0, schemaVersion: versions });
  for (const profileId of [PROFILE_ID, OTHER_PROFILE_ID]) {
    raw.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(profileId, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(publicProfile(profileId, MIN_PROFILE_REVISION)), CREATED_AT);
  }
  return raw;
};

const latestConnection = (): DatabaseSync => {
  prepareAtVersion(1).close();
  closeControlDatabase(openControlDatabase(databasePath()));
  return rawConnection();
};

type SqlValue = string | number | null | Uint8Array;

const insertRow = (connection: DatabaseSync, table: string, row: Record<string, SqlValue>): void => {
  const columns = Object.keys(row);
  connection.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
};

const countOf = (connection: DatabaseSync, table: string): number =>
  (connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const tableSqlOf = (connection: DatabaseSync, name: string): string =>
  String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

const columnNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);

const foreignTablesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  [...new Set((connection.prepare('SELECT "table" AS target FROM pragma_foreign_key_list(?)').all(table) as { target: string }[])
    .map((row) => row.target))].sort();

const checkListOf = (sql: string, column: string): readonly string[] => {
  const match = new RegExp(String.raw`\b${column} IN \(([^)]*)\)`, 'u').exec(sql);
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, ''));
};

const indexNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as { name: string }[])
    .map((row) => row.name);

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

/** 版 6 の表に、承認までの 1 組の行を入れた接続。 */
const approvedConnection = (): DatabaseSync => {
  const connection = latestConnection();
  insertRow(connection, 'scenarios', scenarioRow());
  insertRow(connection, 'scenario_revisions', revisionRow());
  insertRow(connection, 'approval_receipts', approvalRow());
  return connection;
};

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('Control store version 6 (T28c): the version list and the published versions', () => {
  it('is after versions 1 to 5, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.slice(0, APPROVAL_SCHEMA_VERSION).map(({ version }) => version))
      .toEqual([1, 2, 3, 4, DISCOVERY_SCHEMA_VERSION, APPROVAL_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(APPROVAL_SCHEMA_VERSION);
  });

  it('keeps every CHECK list of the published version 5 as the copy at the time version 5 was published', () => {
    expect(inListsOf(CONTROL_MIGRATIONS[DISCOVERY_SCHEMA_VERSION - 1]?.statements ?? [])).toEqual(PUBLISHED_VERSION_5_LISTS);
  });

  it('keeps the generated statements of versions 1 to 6 byte for byte', () => {
    STATEMENT_SHA256.forEach((expected, index) => {
      expect(sha256Of(CONTROL_MIGRATIONS[index]?.statements ?? []), `version ${index + 1}: 公開済みの版の文は変えない`).toBe(expected);
    });
  });

  it('has copies that the named lists still start with (values are only appended to the named lists)', () => {
    for (const [named, published] of [
      [AUDIT_JOB_STATES, PUBLISHED_V5_JOB_STATES],
      [ACTIVE_AUDIT_JOB_STATES, PUBLISHED_V5_ACTIVE_JOB_STATES],
      [FINAL_AUDIT_JOB_STATES, PUBLISHED_V5_FINAL_JOB_STATES],
      [AUDIT_JOB_STATES_WITH_REASON, PUBLISHED_V5_JOB_STATES_WITH_REASON],
      [RUN_STATUSES, PUBLISHED_V5_RUN_STATUSES],
      [WORKER_OUTCOME_KINDS, PUBLISHED_V5_OUTCOME_KINDS],
      [AUDIT_JOB_FAILURE_REASONS, PUBLISHED_V5_FAILURE_REASONS],
      [WORKER_AUTH_STATES, PUBLISHED_V5_AUTH_STATES],
      [AUDIT_JOB_KINDS, PUBLISHED_V5_JOB_KINDS],
      [CANDIDATE_CLASSIFICATIONS, PUBLISHED_V5_CLASSIFICATIONS],
      [CANDIDATE_REASON_CODES, PUBLISHED_V5_REASON_CODES],
      [FORM_METHODS, PUBLISHED_V5_FORM_METHODS],
      [METHOD_OVERRIDE_VALUES, PUBLISHED_V5_METHOD_OVERRIDES],
      [READ_CHECK_RESULTS, PUBLISHED_V5_READ_CHECK_RESULTS],
    ] as const) {
      expect((named as readonly string[]).slice(0, published.length)).toEqual(published);
    }
  });

  it('builds the CHECK lists of version 6 from the closed lists of T28a', () => {
    expect(inListsOf(CONTROL_MIGRATIONS[APPROVAL_SCHEMA_VERSION - 1]?.statements ?? [])).toEqual(VERSION_6_LISTS);
    expect(VERSION_6_LISTS).toEqual([
      `state: ${SCENARIO_STATES.join(',')}`,
      `kind: ${APPROVAL_RECEIPT_KINDS.join(',')}`,
      `state: ${WRITE_RESERVATION_STATES.join(',')}`,
    ]);
  });
});

describe('Control store version 6 (T28c): upgrades', () => {
  it.each([1, 2, 3, 4, DISCOVERY_SCHEMA_VERSION])('upgrades a database at version %i to version 6', (versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['scenarios', 'scenario_revisions', 'approval_receipts', 'execution_grants', 'write_reservations', 'discovery_candidates']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
    expect(countOf(reopened, 'profiles')).toBe(2);
  });

  it('keeps the rows of version 5 (jobs, candidates and READ checks)', () => {
    const raw = prepareAtVersion(DISCOVERY_SCHEMA_VERSION);
    insertRow(raw, 'jobs', {
      job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: 1, state: 'FINISHED', start_new: 0, created_at: CREATED_AT, finished_at: LATER_AT,
      job_kind: 'DISCOVERY',
    });
    insertRow(raw, 'discovery_jobs', { job_id: 'job-1', profile_id: PROFILE_ID, recorded_at: LATER_AT, read_page_paths: '[]' });
    // DEF-118: 版 5 の列の値がすべて写ることを確かめる（後の版で足された列は比べない。列の一覧は版 5 の表から読む）。
    const before = snapshotTableRows(raw, 'jobs', 'job_id');
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const reopened = rawConnection();
    expectRowsCopiedThroughUpgrade(reopened, 'jobs', 'job_id', before);
    expect(countOf(reopened, 'discovery_jobs')).toBe(1);
  });
});

describe('Control store version 6 (T28c): the tables', () => {
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
      // T31e（版 9）: UPDATE の許可の対象のレコードの ID。
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
