// 管理データの表の結合テストの補助（LG-2。設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.7.1）。
// - 今の版の管理データを、一時のフォルダに新しく作り（`openControlDatabase`）、プロファイルを入れた生の接続を返す。前の版の管理データは作らない
//   （版 1〜16 の段は捨てた。前の版で止まることは `control-store-open.test.ts` が確かめる）。
// - 行の挿入、行の数、表の文、列の名前、`<列> IN (…)` の値の一覧、外部キーの先、索引の名前の読み出し（前は版のテストごとに書き写していた）。
// - 一時のフォルダは、テストごとに作って消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { publicProfile } from '../integration/control-profile-fixtures.js';

/** 行の値（`node:sqlite` に渡せる形）。 */
export type SqlValue = string | number | null | Uint8Array;

/** テストの接続は busy を待たない。 */
const RAW_TIMEOUT_MS = 0;
/** プロファイルの行の更新の日時（例の値）。 */
const PROFILE_UPDATED_AT = '20261024000000';

/** テストごとの管理データの置き場所と、生の接続。 */
export interface ControlStoreWorkspace {
  /** 管理データのファイル（テストごとの一時のフォルダの中）。 */
  readonly databasePath: () => string;
  /** 生の接続（外部キーの確かめを有効にする。テストの後に閉じる）。 */
  readonly rawConnection: () => DatabaseSync;
  /** 今の版の管理データを新しく作り、`profileIds` のプロファイル（公開の監査。改訂 1）を入れた生の接続を返す。 */
  readonly latestConnection: (profileIds: readonly string[]) => DatabaseSync;
}

/** テストのファイルの最上位で呼ぶ（`beforeEach`・`afterEach` で一時のフォルダを作って消す）。 */
export const useControlStoreWorkspace = (prefix: string): ControlStoreWorkspace => {
  let workDirectory = '';
  const connections: DatabaseSync[] = [];
  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), prefix));
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
  const latestConnection = (profileIds: readonly string[]): DatabaseSync => {
    closeControlDatabase(openControlDatabase(databasePath()));
    const connection = rawConnection();
    for (const profileId of profileIds) {
      insertRow(connection, 'profiles', {
        profile_id: profileId, revision: MIN_PROFILE_REVISION, status: 'ACTIVE',
        document: JSON.stringify(publicProfile(profileId, MIN_PROFILE_REVISION)), updated_at: PROFILE_UPDATED_AT,
      });
    }
    return connection;
  };
  return Object.freeze({ databasePath, rawConnection, latestConnection });
};

/** 表に 1 行を入れる（`table` と列の名前はテストが決めた固定の名前）。 */
export const insertRow = (connection: DatabaseSync, table: string, row: Readonly<Record<string, SqlValue>>): void => {
  const columns = Object.keys(row);
  connection.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
};

/** 表の行の数。 */
export const countOf = (connection: DatabaseSync, table: string): number =>
  (connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** 表を作った文（`sqlite_schema.sql`）。 */
export const tableSqlOf = (connection: DatabaseSync, name: string): string =>
  String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

/** 表の列の名前（表の定義の順）。 */
export const columnNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);

/** 文の中の、最初の `<列> IN (…)` の値の一覧。 */
export const checkListOf = (sql: string, column: string): readonly string[] => {
  const match = new RegExp(String.raw`\b${column} IN \(([^)]*)\)`, 'u').exec(sql);
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, ''));
};

/** 文の中の、すべての `<列> IN (…)` の一覧（`<列>: 値,値` の形。出てくる順）。 */
export const inListsOf = (statements: readonly string[]): readonly string[] =>
  statements.flatMap((statement) => [...statement.matchAll(/\b(\w+) IN \(([^()]*)\)/gu)]
    .map((match) => `${match[1]}: ${(match[2] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, '')).join(',')}`));

/** 外部キーの先の表（名前の順。重なりを除く）。 */
export const foreignTablesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  [...new Set((connection.prepare('SELECT "table" AS target FROM pragma_foreign_key_list(?)').all(table) as { target: string }[])
    .map((row) => row.target))].sort();

/**
 * 管理データの形（fixture `tests/fixtures/control-schema/v17-schema.json` と同じ形）。`objects` は `sqlite_schema` の type・name・tbl_name・sql
 * （type・name の順）。`tables` は表ごとの `pragma_table_info`（列の順）、`pragma_index_list` と `pragma_index_info`、`pragma_foreign_key_list`。
 * 値は JSON にして戻す（`node:sqlite` の行は prototype のない object のため）。
 */
export const schemaShapeOf = (connection: DatabaseSync): { readonly objects: unknown; readonly tables: unknown } => {
  const objects = connection.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all() as Record<string, unknown>[];
  const tables: Record<string, unknown> = {};
  for (const table of objects.filter((row) => row['type'] === 'table').map((row) => String(row['name']))) {
    const indexes = connection.prepare('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name').all(table) as
      Record<string, unknown>[];
    tables[table] = {
      columns: connection.prepare('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid').all(table),
      indexes: indexes.map((index) => ({
        name: index['name'],
        unique: index['unique'],
        origin: index['origin'],
        partial: index['partial'],
        columns: connection.prepare('SELECT seqno, cid, name FROM pragma_index_info(?) ORDER BY seqno').all(String(index['name'])),
      })),
      foreignKeys: connection
        .prepare('SELECT id, seq, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?) ORDER BY id, seq')
        .all(table),
    };
  }
  return JSON.parse(JSON.stringify({ objects, tables })) as { readonly objects: unknown; readonly tables: unknown };
};

/** 表の索引の名前（自動の索引を除く。名前の順）。 */
export const indexNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as
    { name: string }[]).map((row) => row.name);
