// 管理データのジョブの表（`jobs`）と管理のロックの表（`control_instance`）の結合テスト（Task 24 の設計書 4.4。T24e・T24h-4・T25d・T26c・T27c・
// T30d・T31e・T43c）。LG-2 で、版ごとのテスト（`control-store-jobs-migration`・`control-store-jobs-v3`・`control-store-v4`・`v5`・`v8`・`v9`・`v12`）の
// 今の形の確かめを、今の版の管理データの上にまとめた（前の版からの上げと前の版の形の確かめは捨てた。CHECK の値の一覧が名前つきの一覧と等しいことは
// `control-store-base-schema.test.ts`）。
// - `jobs` は `STRICT` で、状態・理由・結果の種類・Run の状態・ジョブの種類の CHECK は名前つきの一覧と同じ。ジョブの種類は NOT NULL で既定の値がない。
//   終わっていないジョブは全体で 1 行まで（一意の部分索引）。終わりの状態と `finished_at`、理由の有無が食い違う行を拒む。
// - 最後の認証の状態（`last_auth_state`）と止まったページの URL（`session_lost_url`）、書き込みのジョブの報告の確かめ（`write_report_check`）の形。
// - 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_STATES,
  FINAL_AUDIT_JOB_STATES,
  WRITE_REPORT_CHECKS,
} from '../../src/control/job/job-records.js';
import { readJob } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import {
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_AUTH_STATES,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_OUTCOME_KINDS,
} from '../../src/control/worker-protocol.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';
import {
  checkListOf,
  countOf,
  indexNamesOf,
  insertRow,
  tableSqlOf,
  useControlStoreWorkspace,
  type SqlValue,
} from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-jobs';
const CREATED_AT = '20261009000000';
const FINISHED_AT = '20261009000100';

const workspace = useControlStoreWorkspace('beaksight-control-jobs-table-');

/** 今の版の管理データ（プロファイルを 1 つ入れた）の生の接続。 */
const preparedConnection = (): DatabaseSync => workspace.latestConnection([PROFILE_ID]);

/** 正しい形の行（`overrides` で列を置き換える）。ジョブの種類（`job_kind`）は必ず書く。 */
const jobRow = (overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-1',
  profile_id: PROFILE_ID,
  profile_revision: MIN_PROFILE_REVISION,
  state: 'STARTING',
  start_new: 0,
  created_at: CREATED_AT,
  job_kind: 'AUDIT',
  ...overrides,
});

const insertJob = (connection: DatabaseSync, row: Record<string, SqlValue>): void => insertRow(connection, 'jobs', row);

describe('Control store: the jobs table', () => {
  it('is STRICT, and its CHECK lists are the named lists', () => {
    const connection = preparedConnection();
    const sql = tableSqlOf(connection, 'jobs');
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    expect(checkListOf(sql, 'state')).toEqual([...AUDIT_JOB_STATES]);
    expect(checkListOf(sql, 'failure_reason')).toEqual([...AUDIT_JOB_FAILURE_REASONS]);
    expect(checkListOf(sql, 'end_kind')).toEqual([...WORKER_OUTCOME_KINDS]);
    expect(checkListOf(sql, 'run_status')).toEqual([...RUN_STATUSES]);
    expect(checkListOf(sql, 'last_auth_state')).toEqual([...WORKER_AUTH_STATES]);
    expect(checkListOf(sql, 'job_kind')).toEqual([...AUDIT_JOB_KINDS]);
    expect(AUDIT_JOB_FAILURE_REASONS).toEqual(expect.arrayContaining(['AUTH_SETUP_CHANGED', ...WORKER_LOGIN_FAILURE_STATES]));
    expect(indexNamesOf(connection, 'jobs')).toEqual(['jobs_created_at', 'jobs_single_active']);
  });

  it('accepts rows in the right shape for every state', () => {
    const connection = preparedConnection();
    insertJob(connection, jobRow({ job_id: 'job-active', state: ACTIVE_AUDIT_JOB_STATES[0] ?? 'STARTING' }));
    insertJob(connection, jobRow({ job_id: 'job-finished', state: 'FINISHED', finished_at: FINISHED_AT, exit_code: 0, run_status: 'COMPLETE', end_kind: 'RAN', run_id: 'RUN-20261009000000', run_directory: 'RUN-20261009000000' }));
    insertJob(connection, jobRow({ job_id: 'job-failed', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', exit_code: 4 }));
    insertJob(connection, jobRow({ job_id: 'job-interrupted', state: 'INTERRUPTED', finished_at: FINISHED_AT, failure_reason: 'SERVER_RESTARTED' }));
    expect(countOf(connection, 'jobs')).toBe(4);
  });

  it.each([
    ['an unknown state', { state: 'PAUSED' }],
    ['an unknown failure reason', { state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CRASHED' }],
    ['an unknown end kind', { state: 'FINISHED', finished_at: FINISHED_AT, end_kind: 'DONE' }],
    ['an unknown run status', { state: 'FINISHED', finished_at: FINISHED_AT, run_status: 'DONE' }],
    ['start_new that is not 0 or 1', { start_new: 2 }],
    ['an exit code out of range', { state: 'FINISHED', finished_at: FINISHED_AT, exit_code: 256 }],
    ['a negative exit code', { state: 'FINISHED', finished_at: FINISHED_AT, exit_code: -1 }],
    ['a worker pid of 0', { worker_pid: 0 }],
    ['a revision below the minimum', { profile_revision: MIN_PROFILE_REVISION - 1 }],
    ['a job id with an upper case letter', { job_id: 'Job-1' }],
    ['an empty job id', { job_id: '' }],
    ['a timestamp that is not 14 digits', { created_at: '2026-10-09' }],
    ['last_progress that is not JSON', { last_progress: '{' }],
    ['last_notice that is not JSON', { last_notice: 'notice' }],
    ['a final state without finished_at', { state: 'FINISHED' }],
    ['an active state with finished_at', { finished_at: FINISHED_AT }],
    ['FAILED without a reason', { state: 'FAILED', finished_at: FINISHED_AT }],
    ['FINISHED with a reason', { state: 'FINISHED', finished_at: FINISHED_AT, failure_reason: 'WORKER_EXITED' }],
    ['an unknown profile', { profile_id: 'missing-profile' }],
    ['a text in an integer column (STRICT)', { exit_code: 'zero', state: 'FINISHED', finished_at: FINISHED_AT }],
  ] as const)('rejects a row with %s', (_name, overrides) => {
    const connection = preparedConnection();
    expect(() => insertJob(connection, jobRow(overrides))).toThrow();
    expect(countOf(connection, 'jobs')).toBe(0);
  });

  it('keeps at most one job that has not ended (STARTING, RUNNING or STOPPING) in the whole table', () => {
    const connection = preparedConnection();
    insertJob(connection, jobRow({ job_id: 'job-1', state: 'RUNNING' }));
    for (const state of ACTIVE_AUDIT_JOB_STATES) {
      expect(() => insertJob(connection, jobRow({ job_id: `job-${state.toLowerCase()}`, state }))).toThrow(/UNIQUE/u);
    }
    for (const state of FINAL_AUDIT_JOB_STATES) {
      insertJob(connection, jobRow({
        job_id: `job-${state.toLowerCase()}`,
        state,
        finished_at: FINISHED_AT,
        failure_reason: state === 'FINISHED' ? null : 'WORKER_EXITED',
      }));
    }
    connection.prepare("UPDATE jobs SET state = 'INTERRUPTED', finished_at = ?, failure_reason = 'SERVER_RESTARTED' WHERE job_id = 'job-1'").run(FINISHED_AT);
    insertJob(connection, jobRow({ job_id: 'job-next', state: 'STARTING' }));
  });

  it('has the auth state column and the session lost URL column of the closed shapes', () => {
    const connection = preparedConnection();
    insertJob(connection, jobRow({
      job_id: 'job-timeout', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'LOGIN_TIMEOUT', last_auth_state: 'LOGIN_TIMEOUT',
    }));
    insertJob(connection, jobRow({
      job_id: 'job-lost', state: 'FINISHED', finished_at: FINISHED_AT, last_auth_state: 'SESSION_LOST', session_lost_url: 'http://127.0.0.1/admin',
    }));
    for (const row of [
      { job_id: 'bad-state', last_auth_state: 'LOGGED_IN' },
      { job_id: 'bad-empty-url', session_lost_url: '' },
      { job_id: 'bad-long-url', session_lost_url: 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH + 1) },
      { job_id: 'bad-strict', session_lost_url: new Uint8Array([1]) },
    ]) {
      expect(() => insertJob(connection, jobRow({ state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', ...row })), row.job_id)
        .toThrow();
    }
  });

  it('has job_kind with the named list and no default value, and accepts the job kinds with their failure reasons', () => {
    const connection = preparedConnection();
    const sql = tableSqlOf(connection, 'jobs');
    expect(sql).not.toMatch(/\bDEFAULT\b/iu);
    expect(connection.prepare("SELECT \"notnull\" AS not_null, dflt_value FROM pragma_table_info('jobs') WHERE name = 'job_kind'").get())
      .toEqual({ not_null: 1, dflt_value: null });
    expect(checkListOf(sql, 'job_kind')).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    const finished = { state: 'FINISHED', finished_at: FINISHED_AT } as const;
    const failed = (reason: string): Record<string, SqlValue> => ({ state: 'FAILED', finished_at: FINISHED_AT, failure_reason: reason });
    for (const [jobId, row] of [
      ['job-audit', { job_kind: 'AUDIT', ...failed('ACCOUNT_LOCKED') }],
      ['job-check', { job_kind: 'LOGIN_CHECK', ...finished }],
      ['job-discovery', { job_kind: 'DISCOVERY', ...finished }],
      ['job-read', { job_kind: 'READ_CHECK', ...failed('JOB_KIND_NOT_SUPPORTED') }],
      ['job-write', { job_kind: 'WRITE_CREATE', ...failed('WRITE_RESULT_INVALID') }],
      ['job-write-2', { job_kind: 'WRITE_CREATE', ...failed('WRITE_GRANT_REJECTED') }],
      ['job-update', { job_kind: 'WRITE_UPDATE', ...failed('WRITE_GRANT_REJECTED') }],
      ['job-entry', { job_kind: WORKER_ENTRY_CHECK_JOB_KIND, ...finished }],
      ['job-entry-bad', { job_kind: WORKER_ENTRY_CHECK_JOB_KIND, ...failed('ENTRY_CHECK_RESULT_INVALID') }],
    ] as const) {
      insertJob(connection, jobRow({ job_id: jobId, ...row }));
    }
    for (const [name, row] of [
      ['without job_kind', { job_id: 'job-none', job_kind: null, ...finished }],
      ['an unknown job_kind', { job_id: 'job-bad', job_kind: 'LOGIN', ...finished }],
      ['a delete job kind', { job_id: 'job-delete', job_kind: 'WRITE_DELETE', ...finished }],
      ['an unknown failure reason', { job_id: 'job-bad-reason', job_kind: 'AUDIT', ...failed('SUCCEEDED') }],
      ['another unknown failure reason', { job_id: 'job-bad-reason-2', job_kind: 'AUDIT', ...failed('MATCHED') }],
    ] as const) {
      expect(() => insertJob(connection, jobRow(row)), name).toThrow();
    }
    expect(countOf(connection, 'jobs')).toBe(9);
  });

  it('accepts a closed report check value for a write job only, and rejects another value', () => {
    const connection = preparedConnection();
    for (const [index, check] of WRITE_REPORT_CHECKS.entries()) {
      insertJob(connection, jobRow({
        job_id: `job-w${index}`, job_kind: index % 2 === 0 ? 'WRITE_CREATE' : 'WRITE_UPDATE', state: 'FINISHED', finished_at: FINISHED_AT,
        write_report_check: check,
      }));
    }
    const finished = { state: 'FINISHED', finished_at: FINISHED_AT } as const;
    expect(() => insertJob(connection, jobRow({ job_id: 'job-x', job_kind: 'WRITE_CREATE', write_report_check: 'SOMETHING_ELSE', ...finished }))).toThrow();
    expect(() => insertJob(connection, jobRow({ job_id: 'job-a', job_kind: 'AUDIT', write_report_check: 'VALID', ...finished }))).toThrow();
    expect(() => insertJob(connection, jobRow({ job_id: 'job-e', job_kind: WORKER_ENTRY_CHECK_JOB_KIND, write_report_check: 'VALID', ...finished }))).toThrow();
    insertJob(connection, jobRow({ job_id: 'job-b', job_kind: 'AUDIT', write_report_check: null, ...finished }));
  });

  it('reads an ENTRY_CHECK job through the job store', () => {
    const connection = preparedConnection();
    insertJob(connection, jobRow({
      job_id: 'job-entry', job_kind: WORKER_ENTRY_CHECK_JOB_KIND, state: 'FINISHED', finished_at: FINISHED_AT, run_id: 'RUN-20261017000000',
      run_status: 'COMPLETE',
    }));
    connection.close();
    const database = openControlDatabase(workspace.databasePath());
    try {
      expect(readJob(database, 'job-entry')?.jobKind).toBe(WORKER_ENTRY_CHECK_JOB_KIND);
    } finally {
      closeControlDatabase(database);
    }
  });
});

// T24h-4（DEF-061）: 管理のロックの表（画面のサーバを 1 つだけにする）。1 行だけ、Run のロックと同じ項目と port。
describe('Control store: the control instance lock table', () => {
  const insertInstance = (connection: DatabaseSync, values: Record<string, SqlValue>): void =>
    insertRow(connection, 'control_instance', { slot: 1, process_id: 100, booted_at_ms: 0, acquired_at_ms: 1, heartbeat_at_ms: 1, port: null, ...values });

  it('is STRICT and accepts one row in the right shape', () => {
    const connection = preparedConnection();
    expect(tableSqlOf(connection, 'control_instance')).toMatch(/\)\s*STRICT\s*$/u);
    insertInstance(connection, { port: 4400 });
    expect(countOf(connection, 'control_instance')).toBe(1);
    expect(() => insertInstance(connection, {})).toThrow(/UNIQUE|PRIMARY/u);
  });

  it.each([
    ['a slot other than 1', { slot: 2 }],
    ['a process id of 0', { process_id: 0 }],
    ['a negative time', { heartbeat_at_ms: -1 }],
    ['a port of 0', { port: 0 }],
    ['a port above 65535', { port: 65_536 }],
    ['a text in an integer column (STRICT)', { process_id: 'one' }],
  ] as const)('rejects a row with %s', (_name, values) => {
    const connection = preparedConnection();
    expect(() => insertInstance(connection, values)).toThrow();
    expect(countOf(connection, 'control_instance')).toBe(0);
  });
});
