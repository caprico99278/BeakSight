// 版の管理（migration）の結合テスト（Task 23 の設計書 4.3 の 7、7 章の「版の管理」。T23a。LG-2 で基準の版から作る形に改めた）。
// - 空のデータベースは、基準の版（版 17）の文と seed を 1 つのトランザクションで流し、`application_id` と `user_version` を書く。
// - 基準の版の後の段は、版 18 から 1 ずつ増える（今は空。ここでは合成の一覧で、版 18 から後の口を確かめる）。版ごとに 1 つのトランザクション。
// - 途中で失敗する DDL は、表も版（`user_version`）も `application_id` も元に戻る（`BEGIN IMMEDIATE` → 失敗 → `ROLLBACK`）。
// - 基準の版より前の版（版 1〜16）と、より新しい版は、何も書かないうちに止める。
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
  CONTROL_SCHEMA_BASE,
  CONTROL_SCHEMA_VERSION,
  runControlMigrations,
  type ControlMigration,
  type ControlSchemaBase,
} from '../../src/control/store/migrations.js';
import { STORE_META_KEYS } from '../../src/control/store/profile-records.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';

/** テストの接続は busy を待たない。 */
const RAW_TIMEOUT_MS = 0;
/** 基準の版と、その次の段（合成の一覧の版）。 */
const BASE_VERSION = CONTROL_SCHEMA_BASE.version;
const NEXT_VERSION = BASE_VERSION + 1;
const SECOND_NEXT_VERSION = BASE_VERSION + 2;
/** seed の日時の例（`now` に渡す時刻と、その 14 桁の形）。 */
const SEED_TIME = new Date(Date.UTC(2026, 9, 24, 1, 2, 3));
const SEED_TIME_TEXT = '20261024010203';

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

/** 合成の基準の版（表は `statements` だけ。seed は書かない）。 */
const syntheticBase = (statements: readonly string[]): ControlSchemaBase => ({ version: BASE_VERSION, statements, seed: () => undefined });

describe('Control store migrations: the list', () => {
  it('starts after the base version, increases by 1, and the latest version is the base plus the steps', () => {
    CONTROL_MIGRATIONS.forEach((step, index) => expect(step.version).toBe(NEXT_VERSION + index));
    expect(CONTROL_SCHEMA_VERSION).toBe(BASE_VERSION + CONTROL_MIGRATIONS.length);
    expect(Object.isFrozen(CONTROL_MIGRATIONS)).toBe(true);
    expect(Object.isFrozen(CONTROL_SCHEMA_BASE)).toBe(true);
    expect(Object.isFrozen(CONTROL_SCHEMA_BASE.statements)).toBe(true);
    for (const step of CONTROL_MIGRATIONS) {
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(step.statements)).toBe(true);
    }
  });

  it('does not write BEGIN, COMMIT, ROLLBACK or user_version in the base and the step statements (the runner owns them)', () => {
    for (const statement of [...CONTROL_SCHEMA_BASE.statements, ...CONTROL_MIGRATIONS.flatMap((step) => step.statements)]) {
      expect(statement).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|END\s+TRANSACTION|user_version|application_id)\b/iu);
    }
  });

  it('application_id is a positive 32-bit signed integer', () => {
    expect(Number.isSafeInteger(CONTROL_DB_APPLICATION_ID)).toBe(true);
    expect(CONTROL_DB_APPLICATION_ID).toBeGreaterThan(0);
    expect(CONTROL_DB_APPLICATION_ID).toBeLessThanOrEqual(0x7fffffff);
  });

  it('rejects a list that does not start after the base or skips a version, and a base that is not positive (programming error)', () => {
    const connection = rawConnection('list.sqlite');
    expect(() => runControlMigrations(connection, [migration(BASE_VERSION, [])])).toThrow(RangeError);
    expect(() => runControlMigrations(connection, [migration(SECOND_NEXT_VERSION, [])])).toThrow(RangeError);
    expect(() => runControlMigrations(connection, [migration(NEXT_VERSION, []), migration(NEXT_VERSION + 2, [])])).toThrow(RangeError);
    expect(() => runControlMigrations(connection, [], { base: { ...syntheticBase([]), version: 0 } })).toThrow(RangeError);
    expect(pragmaOf(connection, 'user_version')).toBe(0);
    expect(pragmaOf(connection, 'application_id')).toBe(0);
    expect(tableNamesOf(connection)).toEqual([]);
  });
});

describe('Control store migrations: applying', () => {
  it('creates an empty database at the base version with the seed in one transaction', () => {
    const connection = rawConnection('base.sqlite');
    expect(runControlMigrations(connection, [], { now: () => SEED_TIME })).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION });
    expect(pragmaOf(connection, 'user_version')).toBe(BASE_VERSION);
    expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
    expect(connection.isTransaction).toBe(false);
    expect(connection.prepare('SELECT key, value FROM store_meta ORDER BY key').all()).toEqual([
      { key: STORE_META_KEYS.createdAt, value: SEED_TIME_TEXT },
      { key: STORE_META_KEYS.createdSchemaVersion, value: String(BASE_VERSION) },
    ]);
    // 2 回目は何もしない。
    expect(runControlMigrations(connection, [])).toEqual({ foundSchemaVersion: BASE_VERSION, schemaVersion: BASE_VERSION });
  });

  it('applies only the missing later steps, one transaction each, and records the latest version in the seed', () => {
    const connection = rawConnection('steps.sqlite');
    expect(runControlMigrations(connection, [migration(NEXT_VERSION, ['CREATE TABLE a (x INTEGER) STRICT'])]))
      .toEqual({ foundSchemaVersion: 0, schemaVersion: NEXT_VERSION });
    expect(connection.prepare('SELECT value FROM store_meta WHERE key = ?').get(STORE_META_KEYS.createdSchemaVersion))
      .toEqual({ value: String(NEXT_VERSION) });
    expect(runControlMigrations(connection, [
      migration(NEXT_VERSION, ['CREATE TABLE a (x INTEGER) STRICT']),
      migration(SECOND_NEXT_VERSION, ['CREATE TABLE b (y INTEGER) STRICT', 'CREATE INDEX b_y ON b (y)']),
    ])).toEqual({ foundSchemaVersion: NEXT_VERSION, schemaVersion: SECOND_NEXT_VERSION });
    expect(tableNamesOf(connection)).toEqual(expect.arrayContaining(['a', 'b', 'profiles', 'jobs']));
    expect(pragmaOf(connection, 'user_version')).toBe(SECOND_NEXT_VERSION);
  });

  it('a failing DDL in the base rolls back the tables, user_version and application_id', () => {
    const connection = rawConnection('fail-base.sqlite');
    const failure = migrationFailureOf(() => runControlMigrations(connection, [], {
      base: syntheticBase(['CREATE TABLE created_then_rolled_back (x INTEGER) STRICT', 'CREATE TABLE broken (']),
    }));
    expect(failure.reason).toBe('MIGRATION_FAILED');
    expect(failure.message).toMatch(new RegExp(`version ${BASE_VERSION}`, 'u'));
    expect(failure.cause).toBeDefined();
    expect(connection.isTransaction).toBe(false);
    expect(tableNamesOf(connection)).toEqual([]);
    expect(pragmaOf(connection, 'user_version')).toBe(0);
    expect(pragmaOf(connection, 'application_id')).toBe(0);
  });

  it('a failing DDL in a later step keeps the base and rolls back only the failing step', () => {
    const connection = rawConnection('fail-step.sqlite');
    const steps = [
      migration(NEXT_VERSION, ['CREATE TABLE a (x INTEGER) STRICT']),
      migration(SECOND_NEXT_VERSION, ['CREATE TABLE b (y INTEGER) STRICT', 'INSERT INTO missing_table VALUES (1)']),
    ];
    const failure = migrationFailureOf(() => runControlMigrations(connection, steps, { base: syntheticBase(['CREATE TABLE base_table (z INTEGER) STRICT']) }));
    expect(failure.reason).toBe('MIGRATION_FAILED');
    expect(failure.message).toMatch(new RegExp(`version ${SECOND_NEXT_VERSION}`, 'u'));
    expect(tableNamesOf(connection)).toEqual(['a', 'base_table']);
    expect(pragmaOf(connection, 'user_version')).toBe(NEXT_VERSION);
    expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
  });

  it('skips a version that another connection applied in the meantime (re-reads inside the transaction)', () => {
    const path = join(workDirectory, 'race.sqlite');
    const first = rawConnection('race.sqlite');
    const second = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS });
    connections.push(second);
    const steps = [migration(NEXT_VERSION, ['CREATE TABLE a (x INTEGER) STRICT'])];
    runControlMigrations(first, steps);
    // `second` の側から見ても、もう版 18 なので、表を二重に作らない。
    expect(runControlMigrations(second, steps)).toEqual({ foundSchemaVersion: NEXT_VERSION, schemaVersion: NEXT_VERSION });
    expect(tableNamesOf(second).filter((name) => name === 'a')).toEqual(['a']);
  });

  it('stops with DATABASE_FROM_NEWER_VERSION before writing anything', () => {
    const connection = rawConnection('newer.sqlite');
    connection.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
    connection.exec(`PRAGMA user_version = ${SECOND_NEXT_VERSION}`);
    const failure = migrationFailureOf(() => runControlMigrations(connection, [migration(NEXT_VERSION, [])]));
    expect(failure.reason).toBe('DATABASE_FROM_NEWER_VERSION');
    expect(pragmaOf(connection, 'user_version')).toBe(SECOND_NEXT_VERSION);
    expect(tableNamesOf(connection)).toEqual([]);
  });

  it('stops with DATABASE_FROM_OLDER_VERSION before writing anything, for every version before the base', () => {
    for (let version = 1; version < BASE_VERSION; version += 1) {
      const connection = rawConnection(`older-${version}.sqlite`);
      connection.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
      connection.exec('CREATE TABLE profiles (profile_id TEXT PRIMARY KEY NOT NULL) STRICT');
      connection.exec(`PRAGMA user_version = ${version}`);
      const failure = migrationFailureOf(() => runControlMigrations(connection));
      expect(failure.reason, `version ${version}`).toBe('DATABASE_FROM_OLDER_VERSION');
      expect(pragmaOf(connection, 'user_version')).toBe(version);
      expect(tableNamesOf(connection)).toEqual(['profiles']);
    }
  });
});

describe('Control store migrations: through openControlDatabase', () => {
  it('creates the base version in a file that BeakSight marked before any version (application_id only, no tables)', () => {
    const path = join(workDirectory, 'local-data', 'beaksight-control.sqlite');
    mkdirSync(dirname(path));
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
