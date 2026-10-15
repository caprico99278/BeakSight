// 管理データの版 2（監査のジョブの表 `jobs`。Task 24 の設計書 4.4。T24e）の結合テスト。
// - 版 1 だけのデータベース（Task 23 で公開した形）が、`openControlDatabase` で版 2 に上がる。版 1 の行（プロファイル）は残る。
// - `jobs` は `STRICT` で、状態・理由・結果の種類・Run の状態の CHECK は名前つきの一覧と同じ。終わっていないジョブは全体で 1 行まで
//   （一意の部分索引）。終わりの状態と `finished_at`、理由の有無が食い違う行を拒む。
// - 一時のフォルダだけを使い、終わったら消す。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_STATES,
  FINAL_AUDIT_JOB_STATES,
} from '../../src/control/job/job-records.js';
import { WORKER_OUTCOME_KINDS } from '../../src/control/worker-protocol.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

/** テストの接続は busy を待たない。 */
const RAW_TIMEOUT_MS = 0;
/** 版 2（ジョブの表）。 */
const JOBS_SCHEMA_VERSION = 2;
const PROFILE_ID = 'example-jobs';
const CREATED_AT = '20261009000000';
const FINISHED_AT = '20261009000100';

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-jobs-migration-'));
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) {
      connection.close();
    }
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const rawConnection = (path: string): DatabaseSync => {
  const connection = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS, enableForeignKeyConstraints: true });
  connections.push(connection);
  return connection;
};

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

/** 版 2 のデータベース（プロファイルを 1 つ作った）を用意し、生の接続を返す。 */
const preparedConnection = (): DatabaseSync => {
  const database = openControlDatabase(databasePath());
  try {
    expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
  return rawConnection(databasePath());
};

/** 正しい形の行（`overrides` で列を置き換える）。T26c: 最新の版（版 4）のジョブの表は、種類（`job_kind`）を必ず書く。 */
const jobRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: 'job-1',
  profile_id: PROFILE_ID,
  profile_revision: MIN_PROFILE_REVISION,
  state: 'STARTING',
  start_new: 0,
  created_at: CREATED_AT,
  job_kind: 'AUDIT',
  ...overrides,
});

const insertJob = (connection: DatabaseSync, row: Record<string, unknown>): void => {
  const columns = Object.keys(row);
  connection.prepare(`INSERT INTO jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] as string | number | null));
};

const pragmaOf = (connection: DatabaseSync, name: string): unknown =>
  (connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];

/** `CHECK (… IN (…))` の値の一覧を、表の定義の SQL から取り出す。 */
const checkListOf = (sql: string, column: string): readonly string[] => {
  const match = new RegExp(String.raw`${column} IN \(([^)]*)\)`, 'u').exec(sql);
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, ''));
};

describe('Control store version 2: the jobs table', () => {
  // T25a round 1: 版 3（認証の設定の表）を足したので、「版 2 が最新」の固定を、「版 2 が一覧の 2 番目にあり、中身が変わっていない」の
  // 確かめに移した（最新の版は `CONTROL_SCHEMA_VERSION` の定数で確かめる）。
  it('has version 2 as the second entry after version 1, with its contents unchanged', () => {
    expect(CONTROL_MIGRATIONS.slice(0, JOBS_SCHEMA_VERSION).map(({ version }) => version)).toEqual([1, JOBS_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(JOBS_SCHEMA_VERSION);
    const version2 = CONTROL_MIGRATIONS[JOBS_SCHEMA_VERSION - 1];
    expect(version2?.seed).toBeUndefined();
    const createdNames = (version2?.statements ?? [])
      .map((statement) => /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(\w+)/u.exec(statement)?.[1]);
    expect(createdNames).toEqual(['jobs', 'jobs_single_active', 'jobs_created_at', 'control_instance']);
  });

  it('upgrades a database that has only version 1 to the latest version (through version 2), and keeps the profiles', () => {
    mkdirSync(dirname(databasePath()), { recursive: true });
    const raw = rawConnection(databasePath());
    raw.exec('PRAGMA journal_mode = WAL');
    expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, 1))).toEqual({ foundSchemaVersion: 0, schemaVersion: 1 });
    raw.close();
    const version1 = openControlDatabaseAtVersion1();
    expect(version1).toBe(1);

    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(1);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
      expect(getProfile(database, PROFILE_ID)?.profile.profileId).toBe(PROFILE_ID);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection(databasePath());
    expect(pragmaOf(reopened, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'jobs'").get() as { n: number }).n).toBe(1);
  });

  it('is STRICT, and its CHECK lists are the named lists', () => {
    const connection = preparedConnection();
    const sql = String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'jobs'").get() as { sql: string }).sql);
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    expect(checkListOf(sql, 'state')).toEqual([...AUDIT_JOB_STATES]);
    expect(checkListOf(sql, 'failure_reason')).toEqual([...AUDIT_JOB_FAILURE_REASONS]);
    expect(checkListOf(sql, 'end_kind')).toEqual([...WORKER_OUTCOME_KINDS]);
    expect(checkListOf(sql, 'run_status')).toEqual([...RUN_STATUSES]);
  });

  it('accepts rows in the right shape for every state', () => {
    const connection = preparedConnection();
    insertJob(connection, jobRow({ job_id: 'job-active', state: ACTIVE_AUDIT_JOB_STATES[0] }));
    insertJob(connection, jobRow({ job_id: 'job-finished', state: 'FINISHED', finished_at: FINISHED_AT, exit_code: 0, run_status: 'COMPLETE', end_kind: 'RAN', run_id: 'RUN-20261009000000', run_directory: 'RUN-20261009000000' }));
    insertJob(connection, jobRow({ job_id: 'job-failed', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', exit_code: 4 }));
    insertJob(connection, jobRow({ job_id: 'job-interrupted', state: 'INTERRUPTED', finished_at: FINISHED_AT, failure_reason: 'SERVER_RESTARTED' }));
    expect((connection.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n).toBe(4);
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
    expect((connection.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n).toBe(0);
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
});

// T24h-4（DEF-061）: 管理のロックの表（画面のサーバを 1 つだけにする）。1 行だけ、Run のロックと同じ項目と port。
describe('Control store version 2: the control instance lock table', () => {
  const insertInstance = (connection: DatabaseSync, values: Record<string, unknown>): void => {
    const row = { slot: 1, process_id: 100, booted_at_ms: 0, acquired_at_ms: 1, heartbeat_at_ms: 1, port: null, ...values };
    const columns = Object.keys(row);
    connection.prepare(`INSERT INTO control_instance (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => row[column as keyof typeof row] as number | null));
  };

  it('is STRICT and accepts one row in the right shape', () => {
    const connection = preparedConnection();
    const sql = String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'control_instance'").get() as { sql: string }).sql);
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    insertInstance(connection, { port: 4400 });
    expect((connection.prepare('SELECT count(*) AS n FROM control_instance').get() as { n: number }).n).toBe(1);
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
    expect((connection.prepare('SELECT count(*) AS n FROM control_instance').get() as { n: number }).n).toBe(0);
  });
});

/** 版 1 だけのデータベースの `user_version`（生の接続で読み、すぐ閉じる）。 */
function openControlDatabaseAtVersion1(): unknown {
  const connection = rawConnection(databasePath());
  const version = pragmaOf(connection, 'user_version');
  // 版 1 の表にプロファイルを入れておく（版 2 に上がった後も残ることを確かめる）。
  connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE_ID, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(publicProfile(PROFILE_ID, MIN_PROFILE_REVISION)), CREATED_AT);
  connection.close();
  return version;
}
