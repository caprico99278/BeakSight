// 版の管理（migration）の結合テスト（Task 23 の設計書 4.3 の 7、7 章の「版の管理」。T23a）。
// - 途中で失敗する DDL は、表も版（`user_version`）も `application_id` も元に戻る（`BEGIN IMMEDIATE` → 失敗 → `ROLLBACK`）。
// - 版の一覧の形（1 から始まり、1 ずつ増える）と、版 1（中身が空でも `user_version` が 1、`application_id` が書かれる）。
// - 一時のフォルダだけを使い、終わったら消す。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import {
  CONTROL_DB_APPLICATION_ID,
  CONTROL_MIGRATIONS,
  CONTROL_SCHEMA_VERSION,
  runControlMigrations,
  type ControlMigration,
} from '../../src/control/store/migrations.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';

/** テストの接続は busy を待たない。 */
const RAW_TIMEOUT_MS = 0;

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-migrations-'));
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) {
      connection.close();
    }
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const rawConnection = (name: string): DatabaseSync => {
  const connection = new DatabaseSync(join(workDirectory, name), { timeout: RAW_TIMEOUT_MS });
  connections.push(connection);
  return connection;
};

const pragmaOf = (connection: DatabaseSync, name: string): unknown =>
  (connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];

const tableNamesOf = (connection: DatabaseSync): readonly string[] =>
  (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);

const migrationFailureOf = (run: () => unknown): ControlStoreError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStoreError);
    return error as ControlStoreError;
  }
  throw new Error('the migration did not fail');
};

const migration = (version: number, statements: readonly string[]): ControlMigration => ({ version, statements });

describe('Control store migrations: the list', () => {
  it('starts at version 1, increases by 1, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    CONTROL_MIGRATIONS.forEach((step, index) => expect(step.version).toBe(index + 1));
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(Object.isFrozen(CONTROL_MIGRATIONS)).toBe(true);
    for (const step of CONTROL_MIGRATIONS) {
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(step.statements)).toBe(true);
    }
  });

  it('does not write BEGIN, COMMIT, ROLLBACK or user_version in the migration statements (the runner owns them)', () => {
    for (const statement of CONTROL_MIGRATIONS.flatMap((step) => step.statements)) {
      expect(statement).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|END\s+TRANSACTION|user_version|application_id)\b/iu);
    }
  });

  it('application_id is a positive 32-bit signed integer', () => {
    expect(Number.isSafeInteger(CONTROL_DB_APPLICATION_ID)).toBe(true);
    expect(CONTROL_DB_APPLICATION_ID).toBeGreaterThan(0);
    expect(CONTROL_DB_APPLICATION_ID).toBeLessThanOrEqual(0x7fffffff);
  });

  it('rejects a list that does not start at 1 or skips a version (programming error)', () => {
    const connection = rawConnection('list.sqlite');
    expect(() => runControlMigrations(connection, [migration(2, [])])).toThrow(RangeError);
    expect(() => runControlMigrations(connection, [migration(1, []), migration(3, [])])).toThrow(RangeError);
    expect(() => runControlMigrations(connection, [])).toThrow(RangeError);
    expect(pragmaOf(connection, 'user_version')).toBe(0);
    expect(pragmaOf(connection, 'application_id')).toBe(0);
  });
});

describe('Control store migrations: applying', () => {
  it('an empty version 1 still sets user_version to 1 and writes application_id', () => {
    const connection = rawConnection('empty.sqlite');
    expect(runControlMigrations(connection, [migration(1, [])])).toEqual({ foundSchemaVersion: 0, schemaVersion: 1 });
    expect(pragmaOf(connection, 'user_version')).toBe(1);
    expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
    expect(connection.isTransaction).toBe(false);
  });

  it('applies only the missing versions, one transaction each', () => {
    const connection = rawConnection('steps.sqlite');
    runControlMigrations(connection, [migration(1, ['CREATE TABLE a (x INTEGER) STRICT'])]);
    expect(runControlMigrations(connection, [
      migration(1, ['CREATE TABLE a (x INTEGER) STRICT']),
      migration(2, ['CREATE TABLE b (y INTEGER) STRICT', 'CREATE INDEX b_y ON b (y)']),
    ])).toEqual({ foundSchemaVersion: 1, schemaVersion: 2 });
    expect(tableNamesOf(connection)).toEqual(['a', 'b']);
    expect(pragmaOf(connection, 'user_version')).toBe(2);
  });

  it('a failing DDL in version 1 rolls back the tables, user_version and application_id', () => {
    const connection = rawConnection('fail-1.sqlite');
    const failure = migrationFailureOf(() => runControlMigrations(connection, [
      migration(1, ['CREATE TABLE created_then_rolled_back (x INTEGER) STRICT', 'CREATE TABLE broken (']),
    ]));
    expect(failure.reason).toBe('MIGRATION_FAILED');
    expect(failure.cause).toBeDefined();
    expect(connection.isTransaction).toBe(false);
    expect(tableNamesOf(connection)).toEqual([]);
    expect(pragmaOf(connection, 'user_version')).toBe(0);
    expect(pragmaOf(connection, 'application_id')).toBe(0);
  });

  it('a failing DDL in a later version keeps the earlier versions and rolls back only the failing one', () => {
    const connection = rawConnection('fail-2.sqlite');
    const steps = [
      migration(1, ['CREATE TABLE a (x INTEGER) STRICT']),
      migration(2, ['CREATE TABLE b (y INTEGER) STRICT', 'INSERT INTO missing_table VALUES (1)']),
    ];
    const failure = migrationFailureOf(() => runControlMigrations(connection, steps));
    expect(failure.reason).toBe('MIGRATION_FAILED');
    expect(failure.message).toMatch(/version 2/u);
    expect(tableNamesOf(connection)).toEqual(['a']);
    expect(pragmaOf(connection, 'user_version')).toBe(1);
    expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
  });

  it('skips a version that another connection applied in the meantime (re-reads inside the transaction)', () => {
    const path = join(workDirectory, 'race.sqlite');
    const first = rawConnection('race.sqlite');
    const second = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS });
    connections.push(second);
    const steps = [migration(1, ['CREATE TABLE a (x INTEGER) STRICT'])];
    runControlMigrations(first, steps);
    // `second` の側から見ても、もう版 1 なので、表を二重に作らない。
    expect(runControlMigrations(second, steps)).toEqual({ foundSchemaVersion: 1, schemaVersion: 1 });
    expect(tableNamesOf(second)).toEqual(['a']);
  });

  it('stops with DATABASE_FROM_NEWER_VERSION before writing anything', () => {
    const connection = rawConnection('newer.sqlite');
    connection.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
    connection.exec('PRAGMA user_version = 3');
    const failure = migrationFailureOf(() => runControlMigrations(connection, [migration(1, []), migration(2, [])]));
    expect(failure.reason).toBe('DATABASE_FROM_NEWER_VERSION');
    expect(pragmaOf(connection, 'user_version')).toBe(3);
  });
});

describe('Control store migrations: through openControlDatabase', () => {
  it('opens a database that an older BeakSight left at an earlier version and brings it to the latest', () => {
    const path = join(workDirectory, 'local-data', 'beaksight-control.sqlite');
    mkdirSync(dirname(path));
    // 古い版を再現: 版 1 の前（`application_id` は BeakSight、`user_version` 0、表なし）。
    // T23c で版 1 に表が入ったので、開いた後に版だけを 0 に戻す形ではなく、生の接続で版 1 の前の状態を作る（確かめる意味は同じ）。
    const raw = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS });
    raw.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
    raw.close();

    const reopened = openControlDatabase(path);
    try {
      expect(reopened.foundSchemaVersion).toBe(0);
      expect(reopened.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(reopened);
    }
  });
});
