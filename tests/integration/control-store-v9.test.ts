// T31e（Task 31 の設計書 3 章の「対象の選び方」「証拠と記録」「記録」、11 章の T31b の Blocker の判断）: 管理データの版 9 の結合テスト。
// - 版 8 は G30 で公開になったので、版 8 の文の CHECK の値の一覧と数値は、公開した時点の写し（`VERSION_8_…`）で固定する。版 1〜8 の文の SHA-256 は、
//   写しへの置き換えの前後で同じ（版 8 は `control-store-v8.test.ts` と同じ値）。版 9 の文も SHA-256 で固定する（次の版のため）。
// - 版 9 は、ジョブの表を作り直してジョブの種類 `WRITE_UPDATE` を足し（今の行を移す）、書き込みの結果の表を作り直して書き込みの種類・対象の
//   レコードの ID・UPDATE の証拠の列を足し（今の行は `CREATE` として移す）、発見の索引に型にした識別の digest の一覧の列を、実行の許可に対象の
//   レコードの ID の列を足す。CHECK の値の一覧は、閉じた一覧から作る（下の写しと一致する）。
// - 版 1〜8 のデータベースが、`openControlDatabase` で版 9 に上がる（版 8 までの行は残る）。
// 一時のフォルダだけを使い、終わったら消す。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTION_BLOCK_REASONS,
  ACTION_OUTCOME_REASONS,
  ACTION_RESULTS,
  MAX_HTTP_STATUS,
  MIN_HTTP_STATUS,
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
} from '../../src/control/actions/action-contracts.js';
import { MAX_SAFE_RECORD_ID_LENGTH } from '../../src/control/actions/action-outcome.js';
import { MAX_RECORD_ID_LENGTH, SCENARIO_KINDS } from '../../src/control/approval/scenario-contracts.js';
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
import { WORKER_AUTH_STATES, WORKER_OUTCOME_KINDS, WORKER_RUN_STATUSES } from '../../src/control/worker-protocol.js';
import { READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const WRITE_RESULT_SCHEMA_VERSION = 8;
const UPDATE_SCHEMA_VERSION = 9;
const PROFILE_ID = 'example-v9';
const CREATED_AT = '20261014000000';
const LATER_AT = '20261014000100';
const SETTLED_AT = '20261014000200';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

/** 版の文をつなぐ区切り（`control-store-v6.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/** 版 1〜8 の文の SHA-256（版 1〜7 は `control-store-v8.test.ts` と同じ値。版 8 は G30 で公開した時点の値）。 */
const PUBLISHED_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
  'c01a9cc2de065f758b0280b4294a5be917b9f1ad963db6128f8286ed97f91356',
  'e29dd348aa3d4846b4b19e25e0a8806407a9f39f43ccc4b4a380f3a1b3413816',
  '5538786b9028813c60d5ea87df1b51db74a232244724b43136692ace2a27533d',
  '123b5aee905b0e5810e5ad64f19cc44c4e879ccaa7f2de14b6825f7b10a935fb',
  'a2212614448cac1cb6d350a74f17e5b619751ceb8d89e48e5af51daeea748889',
];
/**
 * 版 9 の文の SHA-256（T31e で版 9 を作った時点の文から求めた。版 9 を公開する前に文を変えたら、ここも直して理由を書く）。T31e fix round 1: 版 9 の
 * 公開の前に、結果の理由に `RECORD_ID_MISMATCH`・`UNEXPECTED_FIELD_CHANGE` を足して作り直した。前の値は
 * `4a8c2f5f10d52fa1b2cb4f6397e9a43a4f4ba8ae7ab25c3e1a619a12e83ec80e`。T31f: 版 9 の公開の前に、結果の理由に `UPDATE_POSTCHECK_UNDETERMINED` を
 * 足して作り直した。前の値は `ae9c1c0d39c8e0735606626d547521fdc58f690b0dbd0a8a4dd828b153180bda`。
 */
const VERSION_9_SHA256 = '1e634af1992ee6a9189c258da291f25d6ab425548fdaa1060d2896f1f9fe0aec';

/** 版 8 を公開した時点の、`<列> IN (…)` の一覧の写し（`control-store-v8.test.ts` の `VERSION_8_LISTS` と同じ値）。 */
const PUBLISHED_VERSION_8_LISTS: readonly string[] = [
  'state: STARTING,RUNNING,STOPPING,FINISHED,FAILED,INTERRUPTED',
  'start_new: 0,1',
  'run_status: COMPLETE,PARTIAL,FAILED,ABORTED_BY_SAFETY',
  'end_kind: RAN,RUN_ACTIVE,VERSION_MISMATCH,RUN_DIRECTORY_UNAVAILABLE,RESUME_UNAVAILABLE',
  `failure_reason: ${[
    'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED', 'AUTH_SETUP_CHANGED',
    'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED', 'WORKER_START_FAILED', 'WORKER_NOT_READY',
    'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED',
    'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED',
    'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST', 'JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID',
    'WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID',
  ].join(',')}`,
  `last_auth_state: ${[
    'AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
    'AUTOMATED_LOGIN_FAILED',
  ].join(',')}`,
  'job_kind: AUDIT,LOGIN_CHECK,DISCOVERY,READ_CHECK,WRITE_CREATE',
  'state: FINISHED,FAILED,INTERRUPTED',
  'state: FAILED,INTERRUPTED',
  'state: STARTING,RUNNING,STOPPING',
  'state: STARTING,RUNNING,STOPPING',
  'submission: NOT_SENT,SENT,UNKNOWN',
  'block_reason: PAYLOAD_MISMATCH,PRECHECK_FAILED',
  `response_judgement: ${[
    'SUCCESS', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED', 'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT',
    'RESPONSE_NOT_DELIVERED',
  ].join(',')}`,
  'read_verification: MATCHED,NOT_MATCHED,UNDETERMINED,READ_BLOCKED_BY_POLICY,READ_CANDIDATE_DRIFTED,READ_CANDIDATE_NOT_READ',
  'result: VERIFIED,PARTIAL,BLOCKED,UNKNOWN,FAILED',
  `reason: ${[
    'PAYLOAD_MISMATCH', 'PRECHECK_FAILED', 'NO_RESPONSE', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED',
    'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT', 'RESPONSE_NOT_DELIVERED', 'RECORD_ID_NOT_FOUND', 'RECORD_ID_UNSAFE',
    'READ_VERIFICATION_MATCHED', 'READ_VERIFICATION_NOT_MATCHED', 'READ_VERIFICATION_UNDETERMINED',
  ].join(',')}`,
  'reservation_state: COMMITTED,UNKNOWN,RELEASED',
];

/** 版 8 を公開した時点の数値（HTTP の状態の最小と最大、登録の ID の最大長）。 */
const PUBLISHED_VERSION_8_NUMBERS = Object.freeze({ minHttpStatus: 100, maxHttpStatus: 599, maxRecordIdLength: 256 });

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v9-'));
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

const statementsOf = (version: number): readonly string[] => CONTROL_MIGRATIONS[version - 1]?.statements ?? [];

const prepareAtVersion = (versions: number): DatabaseSync => {
  mkdirSync(dirname(databasePath()), { recursive: true });
  const raw = rawConnection();
  raw.exec('PRAGMA journal_mode = WAL');
  expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, versions))).toEqual({ foundSchemaVersion: 0, schemaVersion: versions });
  raw.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE_ID, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(publicProfile(PROFILE_ID, MIN_PROFILE_REVISION)), CREATED_AT);
  return raw;
};

type SqlValue = string | number | null;

const insertRow = (connection: DatabaseSync, table: string, row: Record<string, SqlValue>): void => {
  const columns = Object.keys(row);
  connection.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
};

const countOf = (connection: DatabaseSync, table: string): number =>
  (connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const tableSqlOf = (connection: DatabaseSync, name: string): string =>
  String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

const foreignTablesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  [...new Set((connection.prepare('SELECT "table" AS target FROM pragma_foreign_key_list(?)').all(table) as { target: string }[])
    .map((row) => row.target))].sort();

/** ジョブの行（版 5〜9 の列）。 */
const jobRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: 1, state: 'FINISHED', start_new: 1, created_at: CREATED_AT, finished_at: LATER_AT,
  job_kind: 'AUDIT', ...row,
});

/** シナリオ・承認の記録・許可 2 件を入れる（版 6 以降の表）。 */
const insertGrants = (connection: DatabaseSync): void => {
  insertRow(connection, 'scenarios', {
    scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'APPROVED', last_approval_receipt_id: 'receipt-1',
    created_at: CREATED_AT, updated_at: CREATED_AT,
  });
  insertRow(connection, 'approval_receipts', {
    receipt_id: 'receipt-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', kind: 'APPROVAL', scenario_revision: 1, approval_digest: DIGEST,
    target_receipt_id: null, recorded_at: CREATED_AT, expires_at: '20261113000000', document: '{}',
  });
  for (const suffix of ['1', '2']) {
    insertRow(connection, 'execution_grants', {
      grant_id: `grant-${suffix}`, profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, approval_receipt_id: 'receipt-1',
      job_id: `job-w${suffix}`, issued_at: CREATED_AT, expires_at: '20261014000500', consumed_at: LATER_AT, invalidated_at: null,
    });
  }
};

/** 版 9 のデータベースに、シナリオ・承認の記録・許可を入れた接続。 */
const latestConnection = (): DatabaseSync => {
  prepareAtVersion(1).close();
  closeControlDatabase(openControlDatabase(databasePath()));
  const connection = rawConnection();
  insertGrants(connection);
  return connection;
};

/** 書き込みの結果の、締める前の行（版 9。登録）。 */
const pendingRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-w1', grant_id: 'grant-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, write_kind: 'CREATE',
  seed_record: '{"seed":"x"}', submitted_values: '{"name":"サンプル 太郎"}', unique_key: '{"name":"サンプル 太郎"}', phone_numbers: '[]',
  recorded_at: CREATED_AT, ...row,
});

/** 照合まで済んだ、締めた行。 */
const verifiedRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => pendingRow({
  submission: 'SENT', block_reason: null, http_status: 200, response_judgement: 'SUCCESS', record_id: '42', read_verification: 'MATCHED',
  result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservation_state: 'COMMITTED', submitted_at: LATER_AT, settled_at: SETTLED_AT, ...row,
});

/** 送らずに止めた、締めた行。 */
const blockedRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => pendingRow({
  submission: 'NOT_SENT', block_reason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH', reservation_state: 'RELEASED',
  settled_at: SETTLED_AT, ...row,
});

/** UPDATE の証拠（変えた欄の前と新しい値、保つ欄の一致の真偽）。 */
const EVIDENCE = JSON.stringify({ fields: [
  { fieldName: 'name', role: 'CHANGED', previousValue: 'サンプル 太郎', newValue: 'サンプル 花子', matched: true },
  { fieldName: 'email', role: 'KEPT', previousValue: null, newValue: null, matched: true },
] });

describe('Control store version 9 (T31e): the version list and the published version 8', () => {
  it('is after versions 1 to 8, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.slice(0, UPDATE_SCHEMA_VERSION).map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7,
      WRITE_RESULT_SCHEMA_VERSION, UPDATE_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(UPDATE_SCHEMA_VERSION);
  });

  it('keeps the statements of versions 1 to 8 byte for byte (the copies), and fixes the statements of version 9', () => {
    expect(PUBLISHED_SHA256.map((_sha, index) => sha256Of(statementsOf(index + 1)))).toEqual(PUBLISHED_SHA256);
    expect(sha256Of(statementsOf(UPDATE_SCHEMA_VERSION))).toBe(VERSION_9_SHA256);
  });

  it('keeps every CHECK list and number of the published version 8 as the copy, and the named lists still start with it', () => {
    expect(inListsOf(statementsOf(WRITE_RESULT_SCHEMA_VERSION))).toEqual(PUBLISHED_VERSION_8_LISTS);
    const named = (column: string, values: readonly string[]): string => `${column}: ${values.join(',')}`;
    const startsWith = (column: string, values: readonly string[]): void => {
      const published = PUBLISHED_VERSION_8_LISTS.find((list) => list.startsWith(`${column}: `)) ?? '';
      expect(named(column, values).startsWith(published), column).toBe(true);
    };
    startsWith('failure_reason', AUDIT_JOB_FAILURE_REASONS);
    startsWith('job_kind', AUDIT_JOB_KINDS);
    startsWith('last_auth_state', WORKER_AUTH_STATES);
    startsWith('run_status', WORKER_RUN_STATUSES);
    startsWith('end_kind', WORKER_OUTCOME_KINDS);
    startsWith('submission', SUBMISSION_STATES);
    startsWith('block_reason', ACTION_BLOCK_REASONS);
    startsWith('response_judgement', RESPONSE_JUDGEMENTS);
    startsWith('read_verification', READ_CHECK_RESULTS);
    startsWith('result', ACTION_RESULTS);
    startsWith('reason', ACTION_OUTCOME_REASONS);
    startsWith('reservation_state', SETTLED_RESERVATION_STATES);
    expect(PUBLISHED_VERSION_8_LISTS).toEqual(expect.arrayContaining([
      named('state', AUDIT_JOB_STATES), named('state', FINAL_AUDIT_JOB_STATES), named('state', AUDIT_JOB_STATES_WITH_REASON),
      named('state', ACTIVE_AUDIT_JOB_STATES),
    ]));
    expect({ minHttpStatus: MIN_HTTP_STATUS, maxHttpStatus: MAX_HTTP_STATUS, maxRecordIdLength: MAX_RECORD_ID_LENGTH })
      .toEqual(PUBLISHED_VERSION_8_NUMBERS);
  });

  it('builds every CHECK list of version 9 from the named closed lists', () => {
    const named = (column: string, values: readonly string[]): string => `${column}: ${values.join(',')}`;
    expect(inListsOf(statementsOf(UPDATE_SCHEMA_VERSION))).toEqual([
      named('state', AUDIT_JOB_STATES),
      'start_new: 0,1',
      named('run_status', WORKER_RUN_STATUSES),
      named('end_kind', WORKER_OUTCOME_KINDS),
      named('failure_reason', AUDIT_JOB_FAILURE_REASONS),
      named('last_auth_state', WORKER_AUTH_STATES),
      named('job_kind', AUDIT_JOB_KINDS),
      named('state', FINAL_AUDIT_JOB_STATES),
      named('state', AUDIT_JOB_STATES_WITH_REASON),
      named('state', ACTIVE_AUDIT_JOB_STATES),
      named('state', ACTIVE_AUDIT_JOB_STATES),
      named('write_kind', SCENARIO_KINDS),
      named('submission', SUBMISSION_STATES),
      named('block_reason', ACTION_BLOCK_REASONS),
      named('response_judgement', RESPONSE_JUDGEMENTS),
      named('read_verification', READ_CHECK_RESULTS),
      named('result', ACTION_RESULTS),
      named('reason', ACTION_OUTCOME_REASONS),
      named('reservation_state', SETTLED_RESERVATION_STATES),
    ]);
    expect(AUDIT_JOB_KINDS).toContain('WRITE_UPDATE');
  });
});

describe('Control store version 9 (T31e): upgrades', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, WRITE_RESULT_SCHEMA_VERSION])('upgrades a database at version %i to version 9', (versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['write_results', 'jobs', 'discovery_candidates', 'execution_grants']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
    expect((reopened.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name IN
      ('jobs_single_active', 'jobs_created_at', 'write_results_scenario_recorded', 'write_results_profile')`).get() as { n: number }).n).toBe(4);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '%\\_v9' ESCAPE '\\'").get() as { n: number }).n).toBe(0);
  });

  it('moves the job rows and the write results of version 8, the results as CREATE, and keeps the other rows', () => {
    const raw = prepareAtVersion(WRITE_RESULT_SCHEMA_VERSION);
    insertRow(raw, 'jobs', jobRow());
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-2', job_kind: 'WRITE_CREATE', state: 'FAILED', failure_reason: 'WRITE_RESULT_INVALID' }));
    insertGrants(raw);
    const { write_kind: _kind, ...version8Row } = verifiedRow();
    insertRow(raw, 'write_results', version8Row);
    insertRow(raw, 'discovery_jobs', { job_id: 'job-d1', profile_id: PROFILE_ID, recorded_at: CREATED_AT, read_page_paths: '[]' });
    insertRow(raw, 'discovery_candidates', {
      profile_id: PROFILE_ID, identity_digest: DIGEST, rule_digest: OTHER_DIGEST, classification: 'UPDATE', reason_code: 'UPDATE_METHOD', page_path: '/a/1/edit',
      action_path: '/a/1', form_method: 'POST', method_override: 'PATCH', has_state_field: 0, first_seen_job_id: 'job-d1', first_seen_at: CREATED_AT,
      last_seen_job_id: 'job-d1', last_seen_at: CREATED_AT, last_changed_job_id: null,
    });
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    expect(connection.prepare('SELECT job_id, job_kind, state, failure_reason FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'job-1', job_kind: 'AUDIT', state: 'FINISHED', failure_reason: null },
      { job_id: 'job-2', job_kind: 'WRITE_CREATE', state: 'FAILED', failure_reason: 'WRITE_RESULT_INVALID' },
    ]);
    expect(connection.prepare('SELECT job_id, write_kind, target_record_id, update_evidence, result, record_id, settled_at FROM write_results')
      .all()).toEqual([{ job_id: 'job-w1', write_kind: 'CREATE', target_record_id: null, update_evidence: null, result: 'VERIFIED', record_id: '42',
      settled_at: SETTLED_AT }]);
    expect(connection.prepare('SELECT identity_digest, templated_identity_digests FROM discovery_candidates').all())
      .toEqual([{ identity_digest: DIGEST, templated_identity_digests: null }]);
    expect(connection.prepare('SELECT grant_id, target_record_id FROM execution_grants ORDER BY grant_id').all())
      .toEqual([{ grant_id: 'grant-1', target_record_id: null }, { grant_id: 'grant-2', target_record_id: null }]);
    expect(countOf(connection, 'scenarios')).toBe(1);
  });

  it('accepts the update job kind only from version 9', () => {
    const old = prepareAtVersion(WRITE_RESULT_SCHEMA_VERSION);
    expect(() => insertRow(old, 'jobs', jobRow({ job_kind: 'WRITE_UPDATE' }))).toThrow();
    old.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    insertRow(connection, 'jobs', jobRow({ job_kind: 'WRITE_UPDATE', state: 'FAILED', failure_reason: 'WRITE_GRANT_REJECTED' }));
    expect(() => insertRow(connection, 'jobs', jobRow({ job_id: 'job-3', job_kind: 'WRITE_DELETE' }))).toThrow();
    expect(countOf(connection, 'jobs')).toBe(1);
  });
});

describe('Control store version 9 (T31e): the write result table', () => {
  it('makes a STRICT table with foreign keys to the profiles, the scenarios and the grants', () => {
    const connection = latestConnection();
    expect(tableSqlOf(connection, 'write_results')).toMatch(/\)\s*STRICT$/u);
    expect(foreignTablesOf(connection, 'write_results')).toEqual(['execution_grants', 'profiles', 'scenarios']);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a pending create row', pendingRow()],
    ['a verified create row', verifiedRow()],
    ['a blocked create row', blockedRow()],
    ['a pending update row', pendingRow({ write_kind: 'UPDATE', target_record_id: 'rec_42-A' })],
    ['a verified update row with its evidence', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: EVIDENCE })],
    ['an unknown update row without evidence', pendingRow({ write_kind: 'UPDATE', target_record_id: '42', submission: 'UNKNOWN', result: 'UNKNOWN',
      reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN', settled_at: SETTLED_AT })],
    ['a blocked update row', blockedRow({ write_kind: 'UPDATE', target_record_id: '42' })],
    ['a target id of the maximum length', pendingRow({ write_kind: 'UPDATE', target_record_id: 'x'.repeat(MAX_SAFE_RECORD_ID_LENGTH) })],
  ])('accepts %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', row);
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['an unknown write kind', pendingRow({ write_kind: 'DELETE' })],
    ['a missing write kind', pendingRow({ write_kind: null })],
    ['a create row with a target', pendingRow({ target_record_id: '42' })],
    ['an update row without a target', pendingRow({ write_kind: 'UPDATE' })],
    ['a target with a slash', pendingRow({ write_kind: 'UPDATE', target_record_id: '4/2' })],
    ['a target with a dot', pendingRow({ write_kind: 'UPDATE', target_record_id: '4.2' })],
    ['a target with a space', pendingRow({ write_kind: 'UPDATE', target_record_id: '4 2' })],
    ['a non-ASCII target', pendingRow({ write_kind: 'UPDATE', target_record_id: 'レコード' })],
    ['an empty target', pendingRow({ write_kind: 'UPDATE', target_record_id: '' })],
    ['a too long target', pendingRow({ write_kind: 'UPDATE', target_record_id: 'x'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1) })],
    ['evidence of a create row', verifiedRow({ update_evidence: EVIDENCE })],
    ['evidence of a pending update row', pendingRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: EVIDENCE })],
    ['evidence that is not an object', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: '[]' })],
    ['a verified update row without evidence', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42' })],
    ['a VERIFIED row without a matched READ (as version 8)', verifiedRow({ read_verification: 'UNDETERMINED' })],
    ['a NOT_SENT row with a response (as version 8)', blockedRow({ http_status: 200 })],
  ])('rejects %s', (_label, row) => {
    const connection = latestConnection();
    expect(() => insertRow(connection, 'write_results', row)).toThrow();
    expect(countOf(connection, 'write_results')).toBe(0);
  });
});

describe('Control store version 9 (T31e): the templated digests of the index and the target of the grants', () => {
  const candidateRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    profile_id: PROFILE_ID, identity_digest: DIGEST, rule_digest: OTHER_DIGEST, classification: 'UPDATE', reason_code: 'UPDATE_METHOD',
    page_path: '/a/1/edit', action_path: '/a/1', form_method: 'POST', method_override: 'PATCH', has_state_field: 0, first_seen_job_id: 'job-d1',
    first_seen_at: CREATED_AT, last_seen_job_id: 'job-d1', last_seen_at: CREATED_AT, last_changed_job_id: null, ...row,
  });

  it('accepts a JSON array or null as the templated digests, and rejects other values', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_candidates', candidateRow({ templated_identity_digests: JSON.stringify([OTHER_DIGEST]) }));
    insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: OTHER_DIGEST, templated_identity_digests: null }));
    expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: `sha256:${'c'.repeat(64)}`,
      templated_identity_digests: '{}' }))).toThrow();
    expect(() => insertRow(connection, 'discovery_candidates', candidateRow({ identity_digest: `sha256:${'d'.repeat(64)}`,
      templated_identity_digests: 'not json' }))).toThrow();
    expect(countOf(connection, 'discovery_candidates')).toBe(2);
  });

  it('accepts a usable record id or null as the target of a grant, and rejects other values', () => {
    const connection = latestConnection();
    connection.prepare("UPDATE execution_grants SET target_record_id = 'rec-1' WHERE grant_id = 'grant-1'").run();
    expect(() => connection.prepare("UPDATE execution_grants SET target_record_id = '../1' WHERE grant_id = 'grant-2'").run()).toThrow();
    expect(() => connection.prepare("UPDATE execution_grants SET target_record_id = '' WHERE grant_id = 'grant-2'").run()).toThrow();
    expect(connection.prepare('SELECT grant_id, target_record_id FROM execution_grants ORDER BY grant_id').all())
      .toEqual([{ grant_id: 'grant-1', target_record_id: 'rec-1' }, { grant_id: 'grant-2', target_record_id: null }]);
  });
});
