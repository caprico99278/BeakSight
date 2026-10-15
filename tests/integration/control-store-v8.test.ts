// T30d（Task 30 の設計書 3 章の「記録」「予約の締め」）: 管理データの版 8 の結合テスト。
// - 版 7 は G29 で公開になったので、版 7 の文の数値（規則の集まりの版の最小）は、公開した時点の写し（`VERSION_7_…`）で固定する。版 1〜7 の文の
//   SHA-256 は、写しへの置き換えの前後で同じ（版 6・7 の値は `control-store-v7.test.ts` と同じ）。版 8 の文も SHA-256 で固定する（次の版のため）。
// - 版 8 は、ジョブの表を作り直してジョブの種類 `WRITE_CREATE` と書き込みのジョブの失敗の理由を足し（今の行を移す）、書き込みの結果の表
//   （`write_results`）を足す。CHECK の値の一覧は、`src/control/actions/action-contracts.ts` などの閉じた一覧から作る（下の写しと一致する）。
// - 版 1〜7 のデータベースが、`openControlDatabase` で版 8 に上がる（版 7 までの行は残る）。
// T31e: 版 8 は G30 で公開になった。版 8 の文は、公開した時点の写し（`VERSION_8_…`）で固定した（SHA-256 は前と同じ）。版 8 の表の確かめは、版 8 まで
// 上げたデータベース（`runControlMigrations` で版 8 まで）で行う（版 9 の表は `control-store-v9.test.ts`）。CHECK の値の一覧は、今の名前つきの一覧が
// 版 8 の写しで始まることを確かめる（版 9 で値を足したため）。
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
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
} from '../../src/control/actions/action-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { MIN_RULE_SET_REVISION } from '../../src/control/data-rules/rule-contracts.js';
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
import { READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const RULE_SET_SCHEMA_VERSION = 7;
const WRITE_RESULT_SCHEMA_VERSION = 8;
const PROFILE_ID = 'example-v8';
const CREATED_AT = '20261013000000';
const LATER_AT = '20261013000100';
const SETTLED_AT = '20261013000200';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** 版の文をつなぐ区切り（`control-store-v6.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/** 版 1〜7 の文の SHA-256（版 6・7 は `control-store-v7.test.ts` と同じ値。版 1〜5 は、版 7 を固定する前の木から求めた値）。 */
const PUBLISHED_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
  'c01a9cc2de065f758b0280b4294a5be917b9f1ad963db6128f8286ed97f91356',
  'e29dd348aa3d4846b4b19e25e0a8806407a9f39f43ccc4b4a380f3a1b3413816',
  '5538786b9028813c60d5ea87df1b51db74a232244724b43136692ace2a27533d',
  '123b5aee905b0e5810e5ad64f19cc44c4e879ccaa7f2de14b6825f7b10a935fb',
];
/**
 * 版 8 の文の SHA-256（T30d で版 8 を作った時点の文から求めた。T30f: 版 8 の公開の前に、結果の理由に `RECORD_ID_UNSAFE` を足して作り直した（設計書
 * 11 章の Blocker 2 の判断）。前の値は `5b13c79d28847b16326744f3d8ba14cb48c7bc3f8d9648df70dd7040293f70be`）。T30R2-fix-1（M-b）: 版 8 の公開の
 * 前に、結果の判定と理由に `RESPONSE_NOT_DELIVERED` を足して作り直した。前の値は
 * `f4e0bddb058f9e1c548978bc918fb70e63f1c9b115828fb2cafdd208424f50e5`。
 */
const VERSION_8_SHA256 = 'a2212614448cac1cb6d350a74f17e5b619751ceb8d89e48e5af51daeea748889';

/** 版 7 を公開した時点の数値（規則の集まりの版の最小）。 */
const PUBLISHED_VERSION_7_MIN_RULE_SET_REVISION = 1;

/**
 * 版 8 の文の、`<列> IN (…)` の一覧の写し（T30d で版 8 を作った時点。版 8 を公開した後に名前つきの一覧へ値を足すときは、版 8 の文を写しで固定する）。
 * 今の名前つきの一覧と一致することも確かめる。
 */
const VERSION_8_LISTS: readonly string[] = [
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
    'READ_VERIFICATION_MATCHED',
    'READ_VERIFICATION_NOT_MATCHED', 'READ_VERIFICATION_UNDETERMINED',
  ].join(',')}`,
  'reservation_state: COMMITTED,UNKNOWN,RELEASED',
];

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v8-'));
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

/** ジョブの行（版 5〜8 の列）。 */
const jobRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: 1, state: 'FINISHED', start_new: 1, created_at: CREATED_AT, finished_at: LATER_AT,
  job_kind: 'AUDIT', ...row,
});

/** 版 8 のデータベースに、シナリオ・承認の記録・許可を 1 件ずつ入れた接続（T31e: 版 8 まで上げる。最新の版ではない）。 */
const latestConnection = (): DatabaseSync => {
  const connection = prepareAtVersion(WRITE_RESULT_SCHEMA_VERSION);
  insertRow(connection, 'scenarios', {
    scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'APPROVED', last_approval_receipt_id: 'receipt-1',
    created_at: CREATED_AT, updated_at: CREATED_AT,
  });
  insertRow(connection, 'approval_receipts', {
    receipt_id: 'receipt-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', kind: 'APPROVAL', scenario_revision: 1, approval_digest: DIGEST,
    target_receipt_id: null, recorded_at: CREATED_AT, expires_at: '20261112000000', document: '{}',
  });
  for (const suffix of ['1', '2']) {
    insertRow(connection, 'execution_grants', {
      grant_id: `grant-${suffix}`, profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, approval_receipt_id: 'receipt-1',
      job_id: `job-w${suffix}`, issued_at: CREATED_AT, expires_at: '20261013000500', consumed_at: LATER_AT, invalidated_at: null,
    });
  }
  return connection;
};

/** 書き込みの結果の、締める前の行。 */
const pendingRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-w1', grant_id: 'grant-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1,
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

describe('Control store version 8 (T30d): the version list and the published version 7', () => {
  it('is after versions 1 to 7, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.slice(0, WRITE_RESULT_SCHEMA_VERSION).map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, RULE_SET_SCHEMA_VERSION,
      WRITE_RESULT_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(WRITE_RESULT_SCHEMA_VERSION);
  });

  it('keeps the statements of versions 1 to 7 byte for byte (the copies), and fixes the statements of version 8', () => {
    expect(PUBLISHED_SHA256.map((_sha, index) => sha256Of(statementsOf(index + 1)))).toEqual(PUBLISHED_SHA256);
    expect(sha256Of(statementsOf(WRITE_RESULT_SCHEMA_VERSION))).toBe(VERSION_8_SHA256);
  });

  it('keeps the number of the published version 7 as the copy', () => {
    expect(MIN_RULE_SET_REVISION).toBe(PUBLISHED_VERSION_7_MIN_RULE_SET_REVISION);
    expect(inListsOf(statementsOf(RULE_SET_SCHEMA_VERSION))).toEqual([]);
  });

  it('builds every CHECK list of version 8 from the copies, and the named closed lists still start with them (T31e)', () => {
    expect(inListsOf(statementsOf(WRITE_RESULT_SCHEMA_VERSION))).toEqual(VERSION_8_LISTS);
    const named = (column: string, values: readonly string[]): string => `${column}: ${values.join(',')}`;
    const lists: readonly (readonly [string, readonly string[]])[] = [
      ['state', AUDIT_JOB_STATES],
      ['failure_reason', AUDIT_JOB_FAILURE_REASONS],
      ['job_kind', AUDIT_JOB_KINDS],
      ['state', FINAL_AUDIT_JOB_STATES],
      ['state', AUDIT_JOB_STATES_WITH_REASON],
      ['state', ACTIVE_AUDIT_JOB_STATES],
      ['submission', SUBMISSION_STATES],
      ['block_reason', ACTION_BLOCK_REASONS],
      ['response_judgement', RESPONSE_JUDGEMENTS],
      ['read_verification', READ_CHECK_RESULTS],
      ['result', ACTION_RESULTS],
      ['reason', ACTION_OUTCOME_REASONS],
      ['reservation_state', SETTLED_RESERVATION_STATES],
    ];
    for (const [column, values] of lists) {
      expect(VERSION_8_LISTS.some((published) => named(column, values).startsWith(published) && published.startsWith(`${column}: `)), column)
        .toBe(true);
    }
  });
});

describe('Control store version 8 (T30d): upgrades', () => {
  it.each([1, 2, 3, 4, 5, 6, RULE_SET_SCHEMA_VERSION])('upgrades a database at version %i to version 8', (versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['write_results', 'jobs', 'rule_sets', 'execution_grants']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name IN ('jobs_single_active', 'jobs_created_at')")
      .get() as { n: number }).n).toBe(2);
  });

  it('moves the job rows of version 7 into the new job table, and keeps the other rows', () => {
    const raw = prepareAtVersion(RULE_SET_SCHEMA_VERSION);
    insertRow(raw, 'jobs', jobRow());
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-2', job_kind: 'READ_CHECK', state: 'FAILED', failure_reason: 'READ_CHECK_RESULT_INVALID' }));
    insertRow(raw, 'scenarios', {
      scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'DRAFT', last_approval_receipt_id: null,
      created_at: CREATED_AT, updated_at: CREATED_AT,
    });
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    expect(connection.prepare('SELECT job_id, job_kind, state, failure_reason FROM jobs ORDER BY job_id').all()).toEqual([
      { job_id: 'job-1', job_kind: 'AUDIT', state: 'FINISHED', failure_reason: null },
      { job_id: 'job-2', job_kind: 'READ_CHECK', state: 'FAILED', failure_reason: 'READ_CHECK_RESULT_INVALID' },
    ]);
    expect(countOf(connection, 'scenarios')).toBe(1);
  });

  it('accepts the write job kind and the write failure reasons only from version 8', () => {
    const old = prepareAtVersion(RULE_SET_SCHEMA_VERSION);
    expect(() => insertRow(old, 'jobs', jobRow({ job_kind: 'WRITE_CREATE' }))).toThrow();
    // T31e: 版 8 まで上げる（最新の版 9 は `WRITE_UPDATE` を受ける。`control-store-v9.test.ts`）。
    expect(runControlMigrations(old, CONTROL_MIGRATIONS.slice(0, WRITE_RESULT_SCHEMA_VERSION)))
      .toEqual({ foundSchemaVersion: RULE_SET_SCHEMA_VERSION, schemaVersion: WRITE_RESULT_SCHEMA_VERSION });
    const connection = old;
    insertRow(connection, 'jobs', jobRow({ job_kind: 'WRITE_CREATE', state: 'FAILED', failure_reason: 'WRITE_RESULT_INVALID' }));
    insertRow(connection, 'jobs', jobRow({ job_id: 'job-2', job_kind: 'WRITE_CREATE', state: 'FAILED', failure_reason: 'WRITE_GRANT_REJECTED' }));
    expect(() => insertRow(connection, 'jobs', jobRow({ job_id: 'job-3', job_kind: 'WRITE_UPDATE' }))).toThrow();
    expect(countOf(connection, 'jobs')).toBe(2);
  });
});

describe('Control store version 8 (T30d): the write result table', () => {
  it('makes a STRICT table with foreign keys to the profiles, the scenarios and the grants', () => {
    const connection = latestConnection();
    expect(tableSqlOf(connection, 'write_results')).toMatch(/\)\s*STRICT$/u);
    expect(foreignTablesOf(connection, 'write_results')).toEqual(['execution_grants', 'profiles', 'scenarios']);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a pending row', pendingRow()],
    ['a pending row without a seed record and values (closed by the recovery)', pendingRow({ seed_record: null, submitted_values: '{}', unique_key: null })],
    ['a verified row', verifiedRow()],
    ['a blocked row', blockedRow()],
    ['an unknown row without a response', pendingRow({
      submission: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN', settled_at: SETTLED_AT,
    })],
    ['a failed row (input error)', verifiedRow({ http_status: 422, response_judgement: 'INPUT_ERROR', record_id: null, read_verification: null,
      result: 'FAILED', reason: 'INPUT_ERROR' })],
  ])('accepts %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', row);
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a second result of the grant', pendingRow({ job_id: 'job-w9' })],
    ['a second result of the job', pendingRow({ grant_id: 'grant-2' })],
    ['a missing grant', pendingRow({ job_id: 'job-w3', grant_id: 'grant-missing' })],
    ['a bad job id', pendingRow({ job_id: 'Job W3', grant_id: 'grant-2' })],
    ['values that are not an object', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', submitted_values: '[]' })],
    ['phone numbers that are not an array', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', phone_numbers: '{}' })],
    ['a result without a settlement time', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', submission: 'UNKNOWN', result: 'UNKNOWN',
      reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN' })],
    ['a settlement time without a result', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', settled_at: SETTLED_AT })],
    ['a pending row with a response', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 200 })],
    ['an unknown submission state', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', submission: 'MAYBE' })],
    ['an unknown result', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'COMPLETE' })],
    ['a RESERVED settlement', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'RESERVED' })],
    ['a NOT_SENT row that is not BLOCKED', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'FAILED', reason: 'INPUT_ERROR' })],
    ['a NOT_SENT row with a consumed reservation', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'COMMITTED' })],
    ['a NOT_SENT row with a response', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 200 })],
    ['a NOT_SENT row with a submission time', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', submitted_at: LATER_AT })],
    ['a NOT_SENT row without a block reason', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', block_reason: null })],
    ['a SENT row with a block reason', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', block_reason: 'PAYLOAD_MISMATCH' })],
    ['a SENT row that is BLOCKED', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH' })],
    ['a SENT row with a released reservation', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'RELEASED' })],
    ['a VERIFIED row without a matched READ', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', read_verification: 'UNDETERMINED' })],
    ['a VERIFIED row without a record id', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', record_id: null })],
    ['an empty record id', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', record_id: '' })],
    ['a bad HTTP status', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 99 })],
    ['a settlement before the record', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', settled_at: '20261012000000' })],
  ])('rejects %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', pendingRow());
    expect(() => insertRow(connection, 'write_results', row)).toThrow();
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it('accepts a second write result for another grant', () => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', pendingRow());
    insertRow(connection, 'write_results', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2' }));
    expect(countOf(connection, 'write_results')).toBe(2);
  });
});
