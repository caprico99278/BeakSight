// T25d（Task 25 の設計書 4.4、変更履歴の 2026-10-10 の T25d の Blocker の行の (4)）: 管理データの版 3 で、ジョブの表（`jobs`）を作り直す。
// - 版 2 は公開済みなので、版 2 の `failure_reason` の CHECK は、版 2 を公開した時点の一覧の写しのまま（T25d の認証の理由を含まない）。
// - 版 3 の作り直しの後は、`failure_reason` の CHECK が今の一覧（`AUDIT_JOB_FAILURE_REASONS`。認証の理由を含む）になり、最後の認証の状態
//   （`last_auth_state`。`WORKER_AUTH_STATES`）と、止まったページの URL（`session_lost_url`）の列がある。
// - 版 1 だけ、版 2 まで（ジョブの行あり）のデータベースが、最新の版に上がる。前の行（プロファイル、ジョブ、認証の設定の表）は残り、
//   終わっていないジョブの一意の部分索引と、作成の日時の索引も作り直される。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { AUDIT_JOB_FAILURE_REASONS } from '../../src/control/job/job-records.js';
import { readJob } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { MAX_WORKER_NOTICE_URL_LENGTH, WORKER_AUTH_STATES, WORKER_LOGIN_FAILURE_STATES } from '../../src/control/worker-protocol.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const JOBS_SCHEMA_VERSION = 2;
const AUTH_JOBS_SCHEMA_VERSION = 3;
const PROFILE_ID = 'example-jobs-v3';
const CREATED_AT = '20261010000000';
const FINISHED_AT = '20261010000100';
/** 版 2 を公開した時点の `failure_reason` の一覧（版 2 の中身を変えないことの確かめ）。 */
const VERSION_2_FAILURE_REASONS = Object.freeze([
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED',
  'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN',
]);

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-jobs-v3-'));
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

/** `versions` の版までだけのデータベースを作り（プロファイルを 1 つ入れる）、生の接続を返す。 */
const prepareAtVersion = (versions: number): DatabaseSync => {
  mkdirSync(dirname(databasePath()), { recursive: true });
  const raw = rawConnection();
  raw.exec('PRAGMA journal_mode = WAL');
  expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, versions))).toEqual({ foundSchemaVersion: 0, schemaVersion: versions });
  raw.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE_ID, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(publicProfile(PROFILE_ID, MIN_PROFILE_REVISION)), CREATED_AT);
  return raw;
};

const tableSqlOf = (connection: DatabaseSync, name: string): string =>
  String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

const checkListOf = (sql: string, column: string): readonly string[] => {
  const match = new RegExp(String.raw`\b${column} IN \(([^)]*)\)`, 'u').exec(sql);
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, ''));
};

const insertJob = (connection: DatabaseSync, row: Record<string, unknown>): void => {
  const full = { job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: MIN_PROFILE_REVISION, state: 'STARTING', start_new: 0, created_at: CREATED_AT, ...row };
  const columns = Object.keys(full);
  connection.prepare(`INSERT INTO jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => full[column as keyof typeof full] as string | number | null | Uint8Array));
};

const indexNamesOf = (connection: DatabaseSync): readonly string[] =>
  (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);

describe('Control store version 3 (T25d): the jobs table rebuilt with the auth columns', () => {
  it('keeps the failure reasons of version 2 as published, without the auth reasons', () => {
    const raw = prepareAtVersion(JOBS_SCHEMA_VERSION);
    expect(checkListOf(tableSqlOf(raw, 'jobs'), 'failure_reason')).toEqual([...VERSION_2_FAILURE_REASONS]);
    expect(() => insertJob(raw, { state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'LOGIN_TIMEOUT' })).toThrow(/CHECK/u);
  });

  it('upgrades a version 2 database with jobs to the latest version, keeping the rows and the indexes', () => {
    const raw = prepareAtVersion(JOBS_SCHEMA_VERSION);
    insertJob(raw, { job_id: 'job-old', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', exit_code: 4 });
    insertJob(raw, { job_id: 'job-active', state: 'RUNNING' });
    raw.close();

    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(JOBS_SCHEMA_VERSION);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
      expect(readJob(database, 'job-old')).toMatchObject({ state: 'FAILED', failureReason: 'CONFIG_ERROR', exitCode: 4, lastAuthState: null, sessionLostUrl: null });
      expect(readJob(database, 'job-active')).toMatchObject({ state: 'RUNNING', lastAuthState: null, sessionLostUrl: null });
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    expect(indexNamesOf(reopened)).toEqual(['jobs_created_at', 'jobs_single_active']);
    // T26c: 最新の版（版 4）のジョブの表は、種類（`job_kind`）を必ず書く。
    expect(() => insertJob(reopened, { job_id: 'job-second-active', state: 'STARTING', job_kind: 'AUDIT' })).toThrow(/UNIQUE/u);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'auth_setups'").get() as { n: number }).n).toBe(1);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'jobs_v%'").get() as { n: number }).n).toBe(0);
  });

  it('upgrades a version 1 database to the latest version (through versions 2 and 3)', () => {
    prepareAtVersion(1).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(1);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
      expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(AUTH_JOBS_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
  });

  it('has the CHECK lists of the named lists, the auth state column and the session lost URL column', () => {
    prepareAtVersion(1).close();
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    const sql = tableSqlOf(connection, 'jobs');
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    expect(checkListOf(sql, 'failure_reason')).toEqual([...AUDIT_JOB_FAILURE_REASONS]);
    expect(checkListOf(sql, 'last_auth_state')).toEqual([...WORKER_AUTH_STATES]);
    expect(AUDIT_JOB_FAILURE_REASONS).toEqual(expect.arrayContaining(['AUTH_SETUP_CHANGED', ...WORKER_LOGIN_FAILURE_STATES]));
    // T26c: 最新の版（版 4）のジョブの表は、種類（`job_kind`）を必ず書く。
    insertJob(connection, {
      job_id: 'job-timeout', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'LOGIN_TIMEOUT', last_auth_state: 'LOGIN_TIMEOUT', job_kind: 'AUDIT',
    });
    insertJob(connection, {
      job_id: 'job-lost', state: 'FINISHED', finished_at: FINISHED_AT, last_auth_state: 'SESSION_LOST', session_lost_url: 'http://127.0.0.1/admin',
      job_kind: 'AUDIT',
    });
    for (const row of [
      { job_id: 'bad-state', last_auth_state: 'LOGGED_IN' },
      { job_id: 'bad-empty-url', session_lost_url: '' },
      { job_id: 'bad-long-url', session_lost_url: 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH + 1) },
      { job_id: 'bad-strict', session_lost_url: new Uint8Array([1]) },
    ]) {
      expect(() => insertJob(connection, { state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', job_kind: 'AUDIT', ...row }), row.job_id)
        .toThrow();
    }
  });
});
