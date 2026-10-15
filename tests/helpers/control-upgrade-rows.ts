// DEF-118: 管理データの版を上げた後に、前の版の表の行が写ったかを確かめる補助（`control-store-v5`・`control-store-v6` の結合テスト）。
// - 前の版の表の列と行を、版を上げる前の接続で写し取る（列の一覧はテストに書き写さず、その版の表の定義から読む）。
// - 版を上げた後の表が、前の版の列をすべて持ち、前の版の列の値がすべて、行ごとにそのまま写ったことを確かめる。後の版で足された列
//   （例: 版 10 の `jobs.write_report_check`）は比べない（足された列の値は、その版のテストが確かめる）。版を足しても、古い版のテストは落ちない。
import type { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';

/** 表の列と行の写し（列は表の定義の順。行は `orderBy` の順）。 */
export interface TableRowsSnapshot {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/** 表の列の名前（表の定義の順）。 */
const columnNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);

/** `table` の列と、`orderBy` の順の行を写し取る（`table` と `orderBy` はテストが決めた固定の名前）。 */
export const snapshotTableRows = (connection: DatabaseSync, table: string, orderBy: string): TableRowsSnapshot => ({
  columns: columnNamesOf(connection, table),
  rows: connection.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[],
});

/**
 * 版を上げた後の `table` が、`before`（前の版の写し）の列をすべて持ち、前の版の列の値が、行ごとにすべてそのまま写ったことを確かめる。
 * 行の数と順（`orderBy`）も同じであること。
 */
export const expectRowsCopiedThroughUpgrade = (
  connection: DatabaseSync,
  table: string,
  orderBy: string,
  before: TableRowsSnapshot,
): void => {
  const after = snapshotTableRows(connection, table, orderBy);
  expect(before.columns.filter((column) => !after.columns.includes(column)), `${table}: the columns of the earlier version`).toEqual([]);
  expect(after.rows.map((row) => Object.fromEntries(before.columns.map((column) => [column, row[column]]))), `${table}: the rows`)
    .toEqual(before.rows);
};
