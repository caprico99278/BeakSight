// T32g（Task 32 の設計書 4.1 の「報告の確かめの記録」。設計者の判断の案 A）: 管理データの版 10 の結合テスト。
// - 版 9 は G31 で公開になったので、版 9 の文の CHECK の値の一覧と数値は、公開した時点の写し（`VERSION_9_…`）で固定する。版 1〜9 の文の SHA-256 は、
//   写しへの置き換えの前後で同じ（`control-store-v9.test.ts` と同じ値）。版 10 の文も SHA-256 で固定する（次の版のため）。
// - 版 10 は、ジョブの表に、書き込みのジョブの報告の確かめの結果の列（`write_report_check`。`WRITE_REPORT_CHECKS` の閉じた一覧。書き込みのジョブ
//   だけが持てる）を足す（今の行は残り、列は null）。`write_results`・`scenario-store.ts` は変えない。
// - 記録の口（`recordWriteReportCheck`）は 1 回だけ書く（書き込みのジョブだけ。2 回目と書き込みでないジョブは書かない）。読む口（`readJob`）が返す。
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
  WRITE_REPORT_CHECKS,
} from '../../src/control/job/job-records.js';
import { readJob, recordWriteReportCheck } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { WORKER_AUTH_STATES, WORKER_OUTCOME_KINDS, WORKER_RUN_STATUSES, WORKER_WRITE_JOB_KINDS } from '../../src/control/worker-protocol.js';
import { READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const UPDATE_SCHEMA_VERSION = 9;
const REPORT_CHECK_SCHEMA_VERSION = 10;
const PROFILE_ID = 'example-v10';
const CREATED_AT = '20261015000000';
const LATER_AT = '20261015000100';

/** 版の文をつなぐ区切り（`control-store-v6.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/** 版 1〜9 の文の SHA-256（`control-store-v9.test.ts` と同じ値。版 9 は G31 で公開した時点の値）。 */
const PUBLISHED_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
  'c01a9cc2de065f758b0280b4294a5be917b9f1ad963db6128f8286ed97f91356',
  'e29dd348aa3d4846b4b19e25e0a8806407a9f39f43ccc4b4a380f3a1b3413816',
  '5538786b9028813c60d5ea87df1b51db74a232244724b43136692ace2a27533d',
  '123b5aee905b0e5810e5ad64f19cc44c4e879ccaa7f2de14b6825f7b10a935fb',
  'a2212614448cac1cb6d350a74f17e5b619751ceb8d89e48e5af51daeea748889',
  '1e634af1992ee6a9189c258da291f25d6ab425548fdaa1060d2896f1f9fe0aec',
];
/** 版 10 の文の SHA-256（T32g で版 10 を作った時点の文から求めた。版 10 を公開する前に文を変えたら、ここも直して理由を書く）。 */
const VERSION_10_SHA256 = 'df622a8e362fac98a9831b0c308d892d093a381f5cac9259a1cc610a13a0255a';

/** 版 9 を公開した時点の、`<列> IN (…)` の一覧の写し。 */
const PUBLISHED_VERSION_9_LISTS: readonly string[] = [
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
  'job_kind: AUDIT,LOGIN_CHECK,DISCOVERY,READ_CHECK,WRITE_CREATE,WRITE_UPDATE',
  'state: FINISHED,FAILED,INTERRUPTED',
  'state: FAILED,INTERRUPTED',
  'state: STARTING,RUNNING,STOPPING',
  'state: STARTING,RUNNING,STOPPING',
  'write_kind: CREATE,UPDATE',
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
    'READ_VERIFICATION_MATCHED', 'READ_VERIFICATION_NOT_MATCHED', 'READ_VERIFICATION_UNDETERMINED', 'RECORD_ID_MISMATCH', 'UNEXPECTED_FIELD_CHANGE',
    'UPDATE_POSTCHECK_UNDETERMINED',
  ].join(',')}`,
  'reservation_state: COMMITTED,UNKNOWN,RELEASED',
];

/** 版 9 を公開した時点の数値（HTTP の状態の最小と最大、登録の ID の最大長、使える登録の ID の最大長）。 */
const PUBLISHED_VERSION_9_NUMBERS = Object.freeze({ minHttpStatus: 100, maxHttpStatus: 599, maxRecordIdLength: 256, maxSafeRecordIdLength: 64 });

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v10-'));
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

const named = (column: string, values: readonly string[]): string => `${column}: ${values.join(',')}`;

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

const insertJob = (connection: DatabaseSync, row: Record<string, SqlValue>): void => {
  const full: Record<string, SqlValue> = {
    job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: 1, state: 'FINISHED', start_new: 1, created_at: CREATED_AT, finished_at: LATER_AT,
    job_kind: 'AUDIT', ...row,
  };
  const columns = Object.keys(full);
  connection.prepare(`INSERT INTO jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => full[column] ?? null));
};

describe('Control store version 10 (T32g): the version list and the published version 9', () => {
  it('is after versions 1 to 9, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.map(({ version }) => version).slice(0, REPORT_CHECK_SCHEMA_VERSION)).toEqual([1, 2, 3, 4, 5, 6, 7, 8,
      UPDATE_SCHEMA_VERSION, REPORT_CHECK_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(REPORT_CHECK_SCHEMA_VERSION);
  });

  it('keeps the statements of versions 1 to 9 byte for byte (the copies), and fixes the statements of version 10', () => {
    expect(PUBLISHED_SHA256.map((_sha, index) => sha256Of(statementsOf(index + 1)))).toEqual(PUBLISHED_SHA256);
    expect(sha256Of(statementsOf(REPORT_CHECK_SCHEMA_VERSION))).toBe(VERSION_10_SHA256);
  });

  it('keeps every CHECK list and number of the published version 9 as the copy, and the named lists still start with it', () => {
    expect(inListsOf(statementsOf(UPDATE_SCHEMA_VERSION))).toEqual(PUBLISHED_VERSION_9_LISTS);
    const startsWith = (column: string, values: readonly string[]): void => {
      const published = PUBLISHED_VERSION_9_LISTS.find((list) => list.startsWith(`${column}: `)) ?? '';
      expect(named(column, values).startsWith(published), column).toBe(true);
    };
    startsWith('failure_reason', AUDIT_JOB_FAILURE_REASONS);
    startsWith('job_kind', AUDIT_JOB_KINDS);
    startsWith('last_auth_state', WORKER_AUTH_STATES);
    startsWith('run_status', WORKER_RUN_STATUSES);
    startsWith('end_kind', WORKER_OUTCOME_KINDS);
    startsWith('write_kind', SCENARIO_KINDS);
    startsWith('submission', SUBMISSION_STATES);
    startsWith('block_reason', ACTION_BLOCK_REASONS);
    startsWith('response_judgement', RESPONSE_JUDGEMENTS);
    startsWith('read_verification', READ_CHECK_RESULTS);
    startsWith('result', ACTION_RESULTS);
    startsWith('reason', ACTION_OUTCOME_REASONS);
    startsWith('reservation_state', SETTLED_RESERVATION_STATES);
    expect(PUBLISHED_VERSION_9_LISTS).toEqual(expect.arrayContaining([
      named('state', AUDIT_JOB_STATES), named('state', FINAL_AUDIT_JOB_STATES), named('state', AUDIT_JOB_STATES_WITH_REASON),
      named('state', ACTIVE_AUDIT_JOB_STATES),
    ]));
    expect({ minHttpStatus: MIN_HTTP_STATUS, maxHttpStatus: MAX_HTTP_STATUS, maxRecordIdLength: MAX_RECORD_ID_LENGTH, maxSafeRecordIdLength: MAX_SAFE_RECORD_ID_LENGTH })
      .toEqual(PUBLISHED_VERSION_9_NUMBERS);
  });

  it('builds the CHECK lists of version 10 from the named closed lists', () => {
    expect(inListsOf(statementsOf(REPORT_CHECK_SCHEMA_VERSION))).toEqual([
      named('write_report_check', WRITE_REPORT_CHECKS),
      named('job_kind', WORKER_WRITE_JOB_KINDS),
    ]);
    expect(WRITE_REPORT_CHECKS[0]).toBe('VALID');
  });
});

describe('Control store version 10 (T32g): the report check of a write job', () => {
  it('upgrades a version 9 database, keeping the job rows with no report check', () => {
    const raw = prepareAtVersion(UPDATE_SCHEMA_VERSION);
    insertJob(raw, { job_id: 'job-old', job_kind: 'WRITE_CREATE' });
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    expect(connection.prepare("SELECT job_id, write_report_check FROM jobs WHERE job_id = 'job-old'").get()).toEqual({ job_id: 'job-old', write_report_check: null });
  });

  it('accepts a closed value for a write job only, and rejects another value', () => {
    const raw = prepareAtVersion(REPORT_CHECK_SCHEMA_VERSION);
    for (const [index, check] of WRITE_REPORT_CHECKS.entries()) {
      insertJob(raw, { job_id: `job-w${index}`, job_kind: index % 2 === 0 ? 'WRITE_CREATE' : 'WRITE_UPDATE', write_report_check: check });
    }
    expect(() => insertJob(raw, { job_id: 'job-x', job_kind: 'WRITE_CREATE', write_report_check: 'SOMETHING_ELSE' })).toThrow();
    expect(() => insertJob(raw, { job_id: 'job-a', job_kind: 'AUDIT', write_report_check: 'VALID' })).toThrow();
    insertJob(raw, { job_id: 'job-b', job_kind: 'AUDIT', write_report_check: null });
  });

  it('records the report check of a write job once, and reads it back; another kind of job is not written', () => {
    const raw = prepareAtVersion(1);
    raw.close();
    const database = openControlDatabase(databasePath());
    try {
      const connection = rawConnection();
      insertJob(connection, { job_id: 'job-w', job_kind: 'WRITE_CREATE' });
      insertJob(connection, { job_id: 'job-a', job_kind: 'AUDIT' });
      connection.close();
      expect(readJob(database, 'job-w')?.writeReportCheck).toBeNull();
      expect(recordWriteReportCheck(database, 'job-w', 'BUNDLE_MISMATCH')).toBe(true);
      expect(recordWriteReportCheck(database, 'job-w', 'VALID')).toBe(false);
      expect(readJob(database, 'job-w')?.writeReportCheck).toBe('BUNDLE_MISMATCH');
      expect(recordWriteReportCheck(database, 'job-a', 'VALID')).toBe(false);
      expect(readJob(database, 'job-a')?.writeReportCheck).toBeNull();
      expect(() => recordWriteReportCheck(database, 'job-w', 'OTHER' as never)).toThrow(RangeError);
    } finally {
      closeControlDatabase(database);
    }
  });
});
