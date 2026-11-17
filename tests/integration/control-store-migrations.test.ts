// 版の管理（migration）の結合テスト（Task 23 の設計書 4.3 の 7、7 章の「版の管理」。T23a。LG-2 で基準の版から作る形に改めた）。
// - 空のデータベースは、基準の版（版 17）の文と seed を 1 つのトランザクションで流し、`application_id` と `user_version` を書く。
// - 基準の版の後の段は、版 18 から 1 ずつ増える（合成の一覧で、版 18 から後の口を確かめる。COV-1 の版 18 は最後の describe）。版ごとに 1 つのトランザクション。
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

// COV-1（網羅の設計書 3.3）: 版 18 は、索引の型の digest と鍵と欄の対応の digest の一覧の件数の CHECK（版 13 の 3 件。押す上限と結び付いていた）を外す。
// SQLite は CHECK を外せないので、表を作り直して行を写す（列の順・ほかの CHECK・索引・外部キーは版 17 のまま）。
describe('Control store migrations: version 18 drops the limit of the shape digests of the discovery index (COV-1)', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const OTHER = `sha256:${'b'.repeat(64)}`;
  const AT = '20261109000000';
  const profileRow = (connection: DatabaseSync): void => {
    connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, 1, ?, ?, ?)')
      .run('example-cov1', 'ACTIVE', '{}', AT);
  };
  const candidateValues = (identity: string, shapes: string | null): readonly (string | number | null)[] => [
    'example-cov1', identity, OTHER, 'DISPLAY_ONLY', 'NO_KNOWN_ACTION', '/admin', null, null, null, 0, 'job-1', AT, 'job-1', AT, null, '[]', shapes, shapes,
  ];
  const INSERT_CANDIDATE = 'INSERT INTO discovery_candidates (profile_id, identity_digest, rule_digest, classification, reason_code, page_path, action_path, '
    + 'form_method, method_override, has_state_field, first_seen_job_id, first_seen_at, last_seen_job_id, last_seen_at, last_changed_job_id, '
    + 'templated_identity_digests, shape_digests, key_field_digests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const columnsOf = (connection: DatabaseSync): readonly string[] =>
    (connection.prepare('PRAGMA table_info(discovery_candidates)').all() as { name: string }[]).map((row) => row.name);
  const tableSql = (connection: DatabaseSync): string =>
    String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'discovery_candidates'").get() as { sql: string }).sql);

  it('makes the table of version 17 without the two limits only (the frozen copy of the statement)', () => {
    const v17 = CONTROL_SCHEMA_BASE.statements.find((statement) => statement.startsWith('CREATE TABLE discovery_candidates ('));
    const expected = (v17 ?? '').replace('CREATE TABLE discovery_candidates (', 'CREATE TABLE discovery_candidates_v18 (')
      .replace(/\s+AND json_array_length\(shape_digests\) <= 3\)\)/u, '))')
      .replace(/\s+AND json_array_length\(key_field_digests\) <= 3\)\)/u, '))');
    expect(expected).not.toBe(v17);
    expect(CONTROL_MIGRATIONS[0]?.statements[0]).toBe(expected);
  });

  it('is the version after the base, and moves the rows of version 17 without loss', () => {
    expect(CONTROL_MIGRATIONS[0]?.version).toBe(NEXT_VERSION);
    const connection = rawConnection('v18.sqlite');
    connection.exec('PRAGMA foreign_keys = ON');
    expect(runControlMigrations(connection, [])).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION });
    profileRow(connection);
    const three = JSON.stringify([DIGEST, OTHER, `sha256:${'c'.repeat(64)}`]);
    connection.prepare(INSERT_CANDIDATE).run(...candidateValues(DIGEST, three));
    expect(() => connection.prepare(INSERT_CANDIDATE).run(...candidateValues(OTHER, JSON.stringify([DIGEST, DIGEST, DIGEST, DIGEST])))).toThrow();
    const columnsBefore = columnsOf(connection);
    expect(runControlMigrations(connection)).toEqual({ foundSchemaVersion: BASE_VERSION, schemaVersion: CONTROL_SCHEMA_VERSION });
    expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    expect(columnsOf(connection)).toEqual(columnsBefore);
    expect(connection.prepare('SELECT identity_digest, shape_digests, key_field_digests FROM discovery_candidates').all())
      .toEqual([{ identity_digest: DIGEST, shape_digests: three, key_field_digests: three }]);
    // 前の上限を超える長さを受ける。壊れた JSON と、配列でない値は今のまま拒む。
    connection.prepare(INSERT_CANDIDATE).run(...candidateValues(OTHER, JSON.stringify([DIGEST, DIGEST, DIGEST, DIGEST])));
    expect(() => connection.prepare(INSERT_CANDIDATE).run(...candidateValues(`sha256:${'d'.repeat(64)}`, '{}'))).toThrow();
    expect(tableSql(connection)).not.toContain('json_array_length(shape_digests)');
    expect(tableSql(connection)).not.toContain('json_array_length(key_field_digests)');
    expect(tableSql(connection)).toContain('STRICT');
    expect(connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'discovery_candidates' AND sql IS NOT NULL").all())
      .toEqual([{ name: 'discovery_candidates_profile_last_seen' }]);
    expect(tableNamesOf(connection)).not.toContain('discovery_candidates_v18');
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

// L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18 と L12b の設計者の判断 1）: 版 19 は、実行の許可と書き込みの結果の、対象のレコードの ID
// （`target_record_id`）の長さの上限（64 文字）と、書き込みの結果の登録の ID（`record_id`）の長さの上限（256 文字。判断 2）だけを外す。1 文字以上と、使える文字
// （英数字・`_`・`-`）の決まりは残す。外部キーで参照される表も、行を失わずに替える。
describe('Control store migrations: version 19 drops the length limit of the target record id (L12b)', () => {
  const AT = '20261110000000';
  const LATER = '20261110000100';
  const ID_64 = 'a'.repeat(64);
  const ID_65 = 'b'.repeat(65);
  const seedParents = (connection: DatabaseSync): void => {
    connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, 1, ?, ?, ?)').run('example-l12b', 'ACTIVE', '{}', AT);
    connection.prepare('INSERT INTO scenarios (scenario_id, profile_id, revision, state, last_approval_receipt_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
      .run('scenario-l12b', 'example-l12b', 'APPROVED', 'receipt-l12b', AT, AT);
    connection.prepare('INSERT INTO approval_receipts (receipt_id, profile_id, scenario_id, kind, scenario_revision, approval_digest, target_receipt_id, recorded_at, '
      + 'expires_at, document) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)')
      .run('receipt-l12b', 'example-l12b', 'scenario-l12b', 'APPROVAL', `sha256:${'c'.repeat(64)}`, AT, LATER, '{}');
  };
  const insertGrant = (connection: DatabaseSync, grantId: string, targetRecordId: string): void => {
    connection.prepare('INSERT INTO execution_grants (grant_id, profile_id, scenario_id, scenario_revision, approval_receipt_id, job_id, issued_at, expires_at, '
      + 'consumed_at, invalidated_at, target_record_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?)')
      .run(grantId, 'example-l12b', 'scenario-l12b', 'receipt-l12b', `job-${grantId}`, AT, LATER, AT, targetRecordId);
    connection.prepare('INSERT INTO write_reservations (grant_id, profile_id, scenario_id, count, state, reserved_at, settled_at) VALUES (?, ?, ?, 1, ?, ?, NULL)')
      .run(grantId, 'example-l12b', 'scenario-l12b', 'RESERVED', AT);
    connection.prepare('INSERT INTO write_results (job_id, grant_id, profile_id, scenario_id, scenario_revision, write_kind, target_record_id, submitted_values, '
      + 'phone_numbers, recorded_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .run(`job-${grantId}`, grantId, 'example-l12b', 'scenario-l12b', 'UPDATE', targetRecordId, '{}', '[]', AT);
  };
  const tableSql = (connection: DatabaseSync, name: string): string =>
    String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);
  const columnsOf = (connection: DatabaseSync, name: string): readonly string[] =>
    (connection.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((row) => row.name);

  it('makes the two tables of version 17 without the length limit only (the frozen copies of the statements)', () => {
    const step = CONTROL_MIGRATIONS.find(({ version }) => version === BASE_VERSION + 2);
    const v17Of = (head: string): string => CONTROL_SCHEMA_BASE.statements.find((statement) => statement.startsWith(head)) ?? '';
    // L12b の設計者の判断 2: 書き込みの結果の登録の ID（`record_id`）の上限（256 文字）も外す。
    const withoutLimit = (statement: string): string =>
      statement.split('length(target_record_id) BETWEEN 1 AND 64').join('length(target_record_id) >= 1')
        .split('length(record_id) BETWEEN 1 AND 256').join('length(record_id) >= 1');
    const expectedResults = withoutLimit(v17Of('CREATE TABLE "write_results" (')).split('CREATE TABLE "write_results" (').join('CREATE TABLE write_results_v19 (');
    const expectedGrants = withoutLimit(v17Of('CREATE TABLE execution_grants ('));
    expect(expectedGrants).not.toBe(v17Of('CREATE TABLE execution_grants ('));
    expect(step?.statements).toContain(expectedResults);
    expect(step?.statements).toContain(expectedGrants);
    // 索引は版 17 と同じ文で作り直す。
    for (const head of ['CREATE UNIQUE INDEX execution_grants_single_open ', 'CREATE INDEX write_results_scenario_recorded ', 'CREATE INDEX write_results_profile ']) {
      expect(step?.statements).toContain(v17Of(head));
    }
  });

  it('moves the rows of version 18 without loss, keeps the references, and then accepts an id over 64 characters (the characters are still checked)', () => {
    const connection = rawConnection('v19.sqlite');
    connection.exec('PRAGMA foreign_keys = ON');
    // 版 18 まで上げてから、前の上限ちょうどの ID の行を入れる。
    expect(runControlMigrations(connection, CONTROL_MIGRATIONS.slice(0, 1))).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION + 1 });
    seedParents(connection);
    insertGrant(connection, 'grant-64', ID_64);
    expect(() => insertGrant(connection, 'grant-65', ID_65)).toThrow();
    const before = {
      grants: columnsOf(connection, 'execution_grants'),
      results: columnsOf(connection, 'write_results'),
      rows: connection.prepare('SELECT grant_id, target_record_id FROM execution_grants').all(),
    };
    expect(runControlMigrations(connection)).toEqual({ foundSchemaVersion: BASE_VERSION + 1, schemaVersion: CONTROL_SCHEMA_VERSION });
    expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    expect(columnsOf(connection, 'execution_grants')).toEqual(before.grants);
    expect(columnsOf(connection, 'write_results')).toEqual(before.results);
    expect(connection.prepare('SELECT grant_id, target_record_id FROM execution_grants').all()).toEqual(before.rows);
    expect(connection.prepare('SELECT target_record_id FROM write_results').all()).toEqual([{ target_record_id: ID_64 }]);
    // 前の上限を超える長さを受ける。空と、使えない文字は今のまま拒む。
    insertGrant(connection, 'grant-65', ID_65);
    expect(() => insertGrant(connection, 'grant-empty', '')).toThrow();
    expect(() => insertGrant(connection, 'grant-slash', 'a/b')).toThrow();
    for (const name of ['execution_grants', 'write_results']) {
      expect(tableSql(connection, name)).not.toContain('BETWEEN 1 AND 64');
      expect(tableSql(connection, name)).toContain('STRICT');
    }
    expect(tableSql(connection, 'write_results')).not.toContain('length(record_id) BETWEEN 1 AND 256');
    expect(tableSql(connection, 'write_results')).toContain('length(record_id) >= 1');
    expect(tableNamesOf(connection)).not.toContain('execution_grants_v19');
    expect(tableNamesOf(connection)).not.toContain('write_results_v19');
    expect((connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('execution_grants', 'write_results') AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string }[]).map(({ name }) => name))
      .toEqual(['execution_grants_single_open', 'write_results_profile', 'write_results_scenario_recorded']);
    // 外部キーは、替えた表を指したまま（予約と結果が許可を参照する）。
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => connection.prepare('INSERT INTO write_reservations (grant_id, profile_id, scenario_id, count, state, reserved_at, settled_at) VALUES (?, ?, ?, 1, ?, ?, NULL)')
      .run('grant-missing', 'example-l12b', 'scenario-l12b', 'RESERVED', AT)).toThrow();
    expect(connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

// URL-LEN（設計書 `2026-11-09-beaksight-remove-limits-design.md` 1〜3 章）: 版 20 は、URL と URL の path の長さの上限（2,048・1,024）と、URL を含む JSON の全体の
// 長さの上限（32,768・65,536）だけを外す。空でないこと・`/` で始まること・使える文字・JSON の形の決まりは残す。参照される表（READ の確かめの定義）も、行を失わずに替える。
describe('Control store migrations: version 20 drops the length limits of the URLs (URL-LEN)', () => {
  const AT = '20261112000000';
  const LATER = '20261112000100';
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const OTHER = `sha256:${'b'.repeat(64)}`;
  const pathOf = (length: number): string => `/${'p'.repeat(length - 1)}`;
  const originOf = (length: number): string => `https://${'o'.repeat(length - 'https://'.length)}`;
  const jsonOf = (length: number): string => `{"a":"${'j'.repeat(length - '{"a":""}'.length)}"}`;
  const statementOf = (statements: readonly string[] | undefined, head: string): string => (statements ?? []).find((statement) => statement.startsWith(head)) ?? '';
  const tableSql = (connection: DatabaseSync, name: string): string =>
    String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

  const seedParents = (connection: DatabaseSync): void => {
    connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, 1, ?, ?, ?)').run('example-urllen', 'ACTIVE', '{}', AT);
    connection.prepare('INSERT INTO scenarios (scenario_id, profile_id, revision, state, last_approval_receipt_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
      .run('scenario-urllen', 'example-urllen', 'APPROVED', 'receipt-urllen', AT, AT);
    connection.prepare('INSERT INTO approval_receipts (receipt_id, profile_id, scenario_id, kind, scenario_revision, approval_digest, target_receipt_id, recorded_at, '
      + 'expires_at, document) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)')
      .run('receipt-urllen', 'example-urllen', 'scenario-urllen', 'APPROVAL', DIGEST, AT, LATER, '{}');
  };
  const insertCandidate = (connection: DatabaseSync, identity: string, path: string): void => {
    connection.prepare('INSERT INTO discovery_candidates (profile_id, identity_digest, rule_digest, classification, reason_code, page_path, action_path, form_method, '
      + 'method_override, has_state_field, first_seen_job_id, first_seen_at, last_seen_job_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)')
      .run('example-urllen', identity, OTHER, 'READ', 'READ_GET_FORM', path, path, 'GET', 'job-1', AT, 'job-1', AT);
  };
  const insertJob = (connection: DatabaseSync, jobId: string, url: string, summary: string, loss: string): void => {
    connection.prepare('INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, finished_at, job_kind, session_lost_url, '
      + 'login_stage_summary, session_loss) VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?)')
      .run(jobId, 'example-urllen', 'FINISHED', AT, LATER, 'AUDIT', url, summary, loss);
  };
  const insertApiResult = (connection: DatabaseSync, id: string, origin: string, path: string): void => {
    connection.prepare('INSERT INTO execution_grants (grant_id, profile_id, scenario_id, scenario_revision, approval_receipt_id, job_id, issued_at, expires_at, '
      + 'consumed_at, invalidated_at, target_record_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL)')
      .run(`grant-${id}`, 'example-urllen', 'scenario-urllen', 'receipt-urllen', `job-${id}`, AT, LATER, AT);
    connection.prepare('INSERT INTO write_results (job_id, grant_id, profile_id, scenario_id, scenario_revision, write_kind, submitted_values, phone_numbers, '
      + 'recorded_at, transport, api_shape_digest, api_method, api_origin, api_path_shape) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`job-${id}`, `grant-${id}`, 'example-urllen', 'scenario-urllen', 'CREATE', '{}', '[]', AT, 'API', DIGEST, 'POST', origin, path);
  };
  const insertReadCheck = (connection: DatabaseSync, id: string, path: string): void => {
    connection.prepare('INSERT INTO read_checks (read_check_id, profile_id, target_identity_digest, parameters, expectations, revision, created_at, updated_at, '
      + 'canceled_at, target_page_path) VALUES (?, ?, NULL, ?, ?, 1, ?, ?, NULL, ?)')
      .run(id, 'example-urllen', '{}', '[]', AT, AT, path);
  };
  const insertAll = (connection: DatabaseSync, suffix: string, identity: string, url: number, path: number, summary: number, loss: number): void => {
    insertCandidate(connection, identity, pathOf(url));
    insertJob(connection, `job-${suffix}`, originOf(url), jsonOf(summary), jsonOf(loss));
    insertApiResult(connection, suffix, originOf(url), pathOf(path));
    insertReadCheck(connection, `read-${suffix}`, pathOf(path));
  };
  const snapshotOf = (connection: DatabaseSync): unknown => ({
    candidates: connection.prepare('SELECT * FROM discovery_candidates ORDER BY identity_digest').all(),
    jobs: connection.prepare('SELECT * FROM jobs ORDER BY job_id').all(),
    results: connection.prepare('SELECT * FROM write_results ORDER BY job_id').all(),
    readChecks: connection.prepare('SELECT * FROM read_checks ORDER BY read_check_id').all(),
    readResults: connection.prepare('SELECT * FROM read_check_results ORDER BY result_id').all(),
  });

  it('makes the four tables of the previous versions without the length limits only (the frozen copies of the statements)', () => {
    const v17 = CONTROL_SCHEMA_BASE.statements;
    const v18 = CONTROL_MIGRATIONS.find(({ version }) => version === BASE_VERSION + 1)?.statements;
    const v19 = CONTROL_MIGRATIONS.find(({ version }) => version === BASE_VERSION + 2)?.statements;
    const replaced = (statement: string, pairs: readonly (readonly [string, string])[]): string =>
      pairs.reduce((text, [from, to]) => {
        expect(text, from).toContain(from);
        return text.split(from).join(to);
      }, statement);
    const statements = CONTROL_MIGRATIONS.find(({ version }) => version === BASE_VERSION + 3)?.statements;
    expect(statements).toContain(replaced(statementOf(v18, 'CREATE TABLE discovery_candidates_v18 ('), [
      ['discovery_candidates_v18 (', 'discovery_candidates_v20 ('],
      ['length(page_path) BETWEEN 1 AND 2048', 'length(page_path) >= 1'],
      ['length(action_path) BETWEEN 1 AND 2048', 'length(action_path) >= 1'],
    ]));
    expect(statements).toContain(replaced(statementOf(v17, 'CREATE TABLE "jobs" ('), [
      ['CREATE TABLE "jobs" (', 'CREATE TABLE jobs_v20 ('],
      ['length(session_lost_url) BETWEEN 1 AND 2048', 'length(session_lost_url) >= 1'],
      ["'object'\n        AND length(login_stage_summary) <= 32768))", "'object'))"],
      ["'object'\n      AND length(session_loss) <= 65536))", "'object'))"],
    ]));
    expect(statements).toContain(replaced(statementOf(v19, 'CREATE TABLE write_results_v19 ('), [
      ['write_results_v19 (', 'write_results_v20 ('],
      ['length(api_origin) BETWEEN 1 AND 2048', 'length(api_origin) >= 1'],
      ['length(api_path_shape) BETWEEN 1 AND 1024', 'length(api_path_shape) >= 1'],
    ]));
    expect(statements).toContain(replaced(statementOf(v17, 'CREATE TABLE "read_checks" ('), [
      ['length(target_page_path) BETWEEN 1 AND 1024', 'length(target_page_path) >= 1'],
    ]));
    // 索引は前の版と同じ文で作り直す。
    for (const head of ['CREATE UNIQUE INDEX jobs_single_active ', 'CREATE INDEX jobs_created_at ', 'CREATE INDEX read_checks_profile_created ']) {
      expect(statements).toContain(statementOf(v17, head));
    }
    for (const head of ['CREATE INDEX discovery_candidates_profile_last_seen ', 'CREATE INDEX write_results_scenario_recorded ', 'CREATE INDEX write_results_profile ']) {
      expect(statements).toContain(statementOf(v19, head) || statementOf(v18, head));
    }
  });

  it('moves the rows of version 19 at the former limits without loss, and then accepts longer values (the other rules are still checked)', () => {
    const connection = rawConnection('v20.sqlite');
    connection.exec('PRAGMA foreign_keys = ON');
    expect(runControlMigrations(connection, CONTROL_MIGRATIONS.slice(0, 2))).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION + 2 });
    seedParents(connection);
    // 前の上限ちょうど（URL 2,048・path 1,024・JSON 32,768 と 65,536）の行。
    insertAll(connection, 'max', DIGEST, 2_048, 1_024, 32_768, 65_536);
    connection.prepare('INSERT INTO read_check_results (job_id, read_check_id, read_check_revision, result, recorded_at) VALUES (?, ?, 1, ?, ?)')
      .run('job-max', 'read-max', 'MATCHED', AT);
    // 版 19 では、前の上限を超える値を拒む。
    expect(() => insertCandidate(connection, OTHER, pathOf(2_049))).toThrow();
    expect(() => insertJob(connection, 'job-url', originOf(2_049), '{}', '{}')).toThrow();
    expect(() => insertJob(connection, 'job-summary', originOf(10), jsonOf(32_769), '{}')).toThrow();
    expect(() => insertJob(connection, 'job-loss', originOf(10), '{}', jsonOf(65_537))).toThrow();
    expect(() => insertReadCheck(connection, 'read-long', pathOf(1_025))).toThrow();
    const before = snapshotOf(connection);

    expect(runControlMigrations(connection)).toEqual({ foundSchemaVersion: BASE_VERSION + 2, schemaVersion: CONTROL_SCHEMA_VERSION });
    expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    expect(snapshotOf(connection)).toEqual(before);

    // 前の上限を超える値を受ける。
    insertAll(connection, 'long', OTHER, 4_096, 4_096, 70_000, 70_000);
    // 空・`/` で始まらない path・壊れた JSON の形・query のある画面の path は今のまま拒む。
    expect(() => insertCandidate(connection, `sha256:${'d'.repeat(64)}`, '')).toThrow();
    expect(() => insertCandidate(connection, `sha256:${'d'.repeat(64)}`, 'relative')).toThrow();
    expect(() => insertJob(connection, 'job-empty', '', '{}', '{}')).toThrow();
    expect(() => insertJob(connection, 'job-array', originOf(10), '[]', '{}')).toThrow();
    expect(() => insertReadCheck(connection, 'read-query', '/a?b')).toThrow();
    expect(() => insertApiResult(connection, 'empty', '', '/x')).toThrow();
    for (const name of ['discovery_candidates', 'jobs', 'write_results', 'read_checks']) {
      expect(tableSql(connection, name)).not.toMatch(/(?:path|url|origin|path_shape)\) BETWEEN 1 AND (?:1024|2048)|<= (?:32768|65536)/u);
      expect(tableSql(connection, name)).toContain('STRICT');
    }
    expect(tableNamesOf(connection).filter((name) => name.includes('_v20'))).toEqual([]);
    expect((connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN ('discovery_candidates', 'jobs', 'write_results', 'read_checks') "
      + 'AND sql IS NOT NULL ORDER BY name').all() as { name: string }[]).map(({ name }) => name))
      .toEqual(['discovery_candidates_profile_last_seen', 'jobs_created_at', 'jobs_single_active', 'read_checks_profile_created', 'write_results_profile',
        'write_results_scenario_recorded']);
    // 外部キーは、替えた表を指したまま（確かめの結果が定義を参照する）。
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => connection.prepare('INSERT INTO read_check_results (job_id, read_check_id, read_check_revision, result, recorded_at) VALUES (?, ?, 1, ?, ?)')
      .run('job-x', 'read-missing', 'MATCHED', AT)).toThrow();
    expect(connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

// LZ-3a（設計書 `2026-11-09-beaksight-remove-limits-design.md` 1〜3 章）: 版 21 は、発見のジョブの読み切れた画面の path の数の上限（10,000）だけを外す。
// JSON の配列であることの決まりは残す。
describe('Control store migrations: version 21 drops the count limit of the read page paths (LZ-3a)', () => {
  const AT = '20261113000000';
  const pathsOf = (count: number): string => JSON.stringify(Array.from({ length: count }, (_value, index) => `/p/${index}`));
  const statementOf = (statements: readonly string[] | undefined, head: string): string => (statements ?? []).find((statement) => statement.startsWith(head)) ?? '';
  const insertJob = (connection: DatabaseSync, jobId: string, paths: string): void => {
    connection.prepare('INSERT INTO discovery_jobs (job_id, profile_id, recorded_at, read_page_paths) VALUES (?, ?, ?, ?)').run(jobId, 'example-lz3a', AT, paths);
  };

  it('makes the table of version 17 without the count limit only (the frozen copy of the statement)', () => {
    const statements = CONTROL_MIGRATIONS.find(({ version }) => version === BASE_VERSION + 4)?.statements;
    const v17 = statementOf(CONTROL_SCHEMA_BASE.statements, 'CREATE TABLE discovery_jobs (');
    const limit = "'array'\n      AND json_array_length(read_page_paths) <= 10000)";
    expect(v17).toContain(limit);
    expect(statements).toContain(v17.replace('CREATE TABLE discovery_jobs (', 'CREATE TABLE discovery_jobs_v21 (').replace(limit, "'array')"));
    expect(statements).toContain(statementOf(CONTROL_SCHEMA_BASE.statements, 'CREATE INDEX discovery_jobs_profile_recorded '));
  });

  it('moves the rows of version 20 without loss, and then accepts more paths than the former limit', () => {
    const connection = rawConnection('v21.sqlite');
    connection.exec('PRAGMA foreign_keys = ON');
    expect(runControlMigrations(connection, CONTROL_MIGRATIONS.slice(0, 3))).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION + 3 });
    connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, 1, ?, ?, ?)').run('example-lz3a', 'ACTIVE', '{}', AT);
    insertJob(connection, 'job-max', pathsOf(10_000));
    expect(() => insertJob(connection, 'job-over', pathsOf(10_001))).toThrow();
    const before = connection.prepare('SELECT * FROM discovery_jobs ORDER BY job_id').all();

    expect(runControlMigrations(connection)).toEqual({ foundSchemaVersion: BASE_VERSION + 3, schemaVersion: CONTROL_SCHEMA_VERSION });
    expect(connection.prepare('SELECT * FROM discovery_jobs ORDER BY job_id').all()).toEqual(before);
    insertJob(connection, 'job-over', pathsOf(10_001));
    expect(() => insertJob(connection, 'job-object', '{}')).toThrow();
    expect(tableNamesOf(connection).filter((name) => name.includes('_v21'))).toEqual([]);
    expect((connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'discovery_jobs' AND sql IS NOT NULL").all() as { name: string }[])
      .map(({ name }) => name)).toEqual(['discovery_jobs_profile_recorded']);
    expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

// DN-1（設計書 `2026-11-16-beaksight-profile-display-name-design.md` 2・3 章）: 版 22 は、プロファイルの表示の設定に画面に出す名前の列を足す。
// 前の版の行は、名前なし（NULL）のまま読める。
describe('Control store migrations: version 22 adds the display name to the display settings (DN-1)', () => {
  const AT = '20261116000000';
  const PROFILE_ID = 'example-dn1';
  const setName = (connection: DatabaseSync, name: string): unknown =>
    connection.prepare('UPDATE profile_display_settings SET display_name = ? WHERE profile_id = ?').run(name, PROFILE_ID);

  it('keeps the rows of version 21 without a display name, and then accepts a name of 1 to 80 characters only', () => {
    const connection = rawConnection('v22.sqlite');
    connection.exec('PRAGMA foreign_keys = ON');
    expect(runControlMigrations(connection, CONTROL_MIGRATIONS.slice(0, 4))).toEqual({ foundSchemaVersion: 0, schemaVersion: BASE_VERSION + 4 });
    connection.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, 1, ?, ?, ?)').run(PROFILE_ID, 'ACTIVE', '{}', AT);
    connection.prepare('INSERT INTO profile_display_settings (profile_id, show_job_browser, audit_send_policy, updated_at) VALUES (?, 0, ?, ?)')
      .run(PROFILE_ID, 'READ_ONLY', AT);
    const before = connection.prepare('SELECT * FROM profile_display_settings').all();

    expect(runControlMigrations(connection)).toEqual({ foundSchemaVersion: BASE_VERSION + 4, schemaVersion: CONTROL_SCHEMA_VERSION });
    expect(connection.prepare('SELECT * FROM profile_display_settings').all()).toEqual(before.map((row) => ({ ...row, display_name: null })));
    setName(connection, 'あ'.repeat(80));
    expect(() => setName(connection, '')).toThrow();
    expect(() => setName(connection, 'あ'.repeat(81))).toThrow();
    expect(connection.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});
