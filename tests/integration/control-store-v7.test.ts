// T29d（Task 29 の設計書 4.3「管理データの版 7」）: 管理データの版 7 の結合テスト。
// - 版 6 は G28 で公開になったので、版 6 の文の CHECK の値の一覧と数値は、公開した時点の写し（`VERSION_6_…`）で固定する。版 1〜6 の文の SHA-256 は、
//   写しへの置き換えの前後で同じ（版 6 の値は `control-store-v6.test.ts` と同じ）。版 7 の文も SHA-256 で固定する（次の版のため）。
// - 版 1〜6 のデータベースが、`openControlDatabase` で版 7 に上がる（版 6 の行は残る）。
// - 版 7 の表（`rule_sets`、`rule_set_revisions`）: STRICT、プロファイルとシナリオへの外部キー、規則の集まりはシナリオごとに 1 つ、版の写しは
//   規則の集まりと版で一意、digest の形・JSON の object・版の最小・時刻の形の CHECK。
// 一時のフォルダだけを使い、終わったら消す。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_RECEIPT_KINDS,
  DEFAULT_MAX_CREATES_PER_RUN,
  MIN_SCENARIO_LIMIT,
  MIN_SCENARIO_REVISION,
  SCENARIO_STATES,
  WRITE_RESERVATION_STATES,
} from '../../src/control/approval/scenario-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const APPROVAL_SCHEMA_VERSION = 6;
const RULE_SET_SCHEMA_VERSION = 7;
const PROFILE_ID = 'example-v7';
const CREATED_AT = '20261013000000';
const LATER_AT = '20261013000100';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** 版 6 の文の、`<列> IN (…)` の一覧（版 6 を公開した時点。ここを書き換えると、公開済みの版の中身が変わる）。 */
const PUBLISHED_VERSION_6_LISTS: readonly string[] = [
  'state: DRAFT,APPROVED,REVOKED',
  'kind: APPROVAL,REVOCATION',
  'state: RESERVED,RELEASED,COMMITTED,UNKNOWN',
];

/** 版 6 を公開した時点の数値（版の最小、件数の最小と 1 回の Run の上限）。 */
const PUBLISHED_VERSION_6_NUMBERS = Object.freeze({ minRevision: 1, minLimit: 1, maxCreatesPerRun: 1 });

/** 版の文をつなぐ区切り（`control-store-v6.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/** 版 6 と版 7 の文の SHA-256（版 6 は `control-store-v6.test.ts` と同じ値。版 7 は T29d で版 7 を作った時点の文から求めた）。 */
const VERSION_6_SHA256 = '5538786b9028813c60d5ea87df1b51db74a232244724b43136692ace2a27533d';
const VERSION_7_SHA256 = '123b5aee905b0e5810e5ad64f19cc44c4e879ccaa7f2de14b6825f7b10a935fb';

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v7-'));
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

/** 版 7 のデータベースに、シナリオ 1 件を入れた接続。 */
const latestConnection = (): DatabaseSync => {
  prepareAtVersion(1).close();
  closeControlDatabase(openControlDatabase(databasePath()));
  const connection = rawConnection();
  insertRow(connection, 'scenarios', {
    scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'DRAFT', last_approval_receipt_id: null,
    created_at: CREATED_AT, updated_at: CREATED_AT,
  });
  return connection;
};

const ruleSetRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  rule_set_id: 'rules-1', scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, created_at: CREATED_AT, updated_at: CREATED_AT, ...row,
});

const revisionRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  rule_set_id: 'rules-1', revision: 1, scenario_id: 'scenario-1', profile_id: PROFILE_ID, document: '{"schemaVersion":"beaksight-data-rule/1"}',
  digest: DIGEST, recorded_at: CREATED_AT, ...row,
});

describe('Control store version 7 (T29d): the version list and the published version 6', () => {
  it('is after versions 1 to 6, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.slice(0, RULE_SET_SCHEMA_VERSION).map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, APPROVAL_SCHEMA_VERSION,
      RULE_SET_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(RULE_SET_SCHEMA_VERSION);
  });

  it('keeps the statements of version 6 byte for byte (the copies), and fixes the statements of version 7', () => {
    expect(sha256Of(CONTROL_MIGRATIONS[APPROVAL_SCHEMA_VERSION - 1]?.statements ?? [])).toBe(VERSION_6_SHA256);
    expect(sha256Of(CONTROL_MIGRATIONS[RULE_SET_SCHEMA_VERSION - 1]?.statements ?? [])).toBe(VERSION_7_SHA256);
  });

  it('keeps every CHECK list of the published version 6 as the copy, and the named lists still start with it', () => {
    expect(inListsOf(CONTROL_MIGRATIONS[APPROVAL_SCHEMA_VERSION - 1]?.statements ?? [])).toEqual(PUBLISHED_VERSION_6_LISTS);
    for (const [named, published] of [
      [SCENARIO_STATES, ['DRAFT', 'APPROVED', 'REVOKED']],
      [APPROVAL_RECEIPT_KINDS, ['APPROVAL', 'REVOCATION']],
      [WRITE_RESERVATION_STATES, ['RESERVED', 'RELEASED', 'COMMITTED', 'UNKNOWN']],
    ] as const) {
      expect((named as readonly string[]).slice(0, published.length)).toEqual(published);
    }
    expect({ minRevision: MIN_SCENARIO_REVISION, minLimit: MIN_SCENARIO_LIMIT, maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN })
      .toEqual(PUBLISHED_VERSION_6_NUMBERS);
  });

  it('has no CHECK list in version 7', () => {
    expect(inListsOf(CONTROL_MIGRATIONS[RULE_SET_SCHEMA_VERSION - 1]?.statements ?? [])).toEqual([]);
  });
});

describe('Control store version 7 (T29d): upgrades', () => {
  it.each([1, 2, 3, 4, 5, APPROVAL_SCHEMA_VERSION])('upgrades a database at version %i to version 7', (versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['rule_sets', 'rule_set_revisions', 'scenarios', 'execution_grants']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
  });

  it('keeps the rows of version 6', () => {
    const raw = prepareAtVersion(APPROVAL_SCHEMA_VERSION);
    insertRow(raw, 'scenarios', {
      scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'DRAFT', last_approval_receipt_id: null,
      created_at: CREATED_AT, updated_at: CREATED_AT,
    });
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    expect(countOf(rawConnection(), 'scenarios')).toBe(1);
  });
});

describe('Control store version 7 (T29d): the tables', () => {
  it('makes STRICT tables with foreign keys to the profiles and the scenarios', () => {
    const connection = latestConnection();
    for (const table of ['rule_sets', 'rule_set_revisions']) {
      expect(tableSqlOf(connection, table)).toMatch(/\)\s*STRICT$/u);
    }
    expect(foreignTablesOf(connection, 'rule_sets')).toEqual(['profiles', 'scenarios']);
    expect(foreignTablesOf(connection, 'rule_set_revisions')).toEqual(['profiles', 'rule_sets', 'scenarios']);
  });

  it('accepts a rule set and its revisions', () => {
    const connection = latestConnection();
    insertRow(connection, 'rule_sets', ruleSetRow());
    insertRow(connection, 'rule_set_revisions', revisionRow());
    insertRow(connection, 'rule_set_revisions', revisionRow({ revision: 2, recorded_at: LATER_AT }));
    expect(countOf(connection, 'rule_set_revisions')).toBe(2);
  });

  it.each<readonly [string, string, Record<string, SqlValue>]>([
    ['a second rule set of the scenario', 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2' })],
    ['a rule set of a missing scenario', 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2', scenario_id: 'scenario-missing' })],
    ['a revision of 0', 'rule_set_revisions', revisionRow({ revision: 0 })],
    ['a duplicate revision', 'rule_set_revisions', revisionRow()],
    ['a bad digest', 'rule_set_revisions', revisionRow({ revision: 3, digest: 'sha256:xyz' })],
    ['a document that is not an object', 'rule_set_revisions', revisionRow({ revision: 3, document: '[]' })],
    ['a bad time', 'rule_set_revisions', revisionRow({ revision: 3, recorded_at: '2026-10-13' })],
    ['a revision of a missing rule set', 'rule_set_revisions', revisionRow({ rule_set_id: 'rules-missing', revision: 3 })],
  ])('rejects %s', (_label, table, row) => {
    const connection = latestConnection();
    insertRow(connection, 'rule_sets', ruleSetRow());
    insertRow(connection, 'rule_set_revisions', revisionRow());
    expect(() => insertRow(connection, table, row)).toThrow();
  });

  it('rejects a bad rule set id (for another scenario)', () => {
    const connection = latestConnection();
    insertRow(connection, 'scenarios', {
      scenario_id: 'scenario-2', profile_id: PROFILE_ID, revision: 1, state: 'DRAFT', last_approval_receipt_id: null,
      created_at: CREATED_AT, updated_at: CREATED_AT,
    });
    expect(() => insertRow(connection, 'rule_sets', ruleSetRow({ rule_set_id: 'Rules_2', scenario_id: 'scenario-2' }))).toThrow();
    insertRow(connection, 'rule_sets', ruleSetRow({ rule_set_id: 'rules-2', scenario_id: 'scenario-2' }));
    expect(countOf(connection, 'rule_sets')).toBe(1);
  });

  it('rejects a rule set whose update time is before its creation time', () => {
    const connection = latestConnection();
    expect(() => insertRow(connection, 'rule_sets', ruleSetRow({ updated_at: '20261012000000' }))).toThrow();
  });
});
