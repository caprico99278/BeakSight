// 管理データを読むだけの入口（`withReadTransaction`。T24e round 2）の結合テスト。WAL の実のファイルで確かめる（一時のフォルダだけ）。
// - deferred の `BEGIN` → `PRAGMA query_only = ON` → 読む → `PRAGMA query_only = OFF` → `COMMIT`。
// - 読む中の書き込みは `query_only` で失敗し、何も書かれない。失敗でも例外でも、`query_only` は戻り、トランザクションは閉じる。
// - 終わった後は、書き込みの入口で書ける。入れ子と Promise の拒否は、書き込みの入口と同じ。
// - 読む間も、別の接続の書き込み（`BEGIN IMMEDIATE`）は待たされない（WAL の読み取りは書き込みを止めない）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteConnection } from '../../src/control/store/sqlite-module.js';
import { withReadTransaction, withWriteTransaction } from '../../src/control/store/transaction.js';

/** テストの接続は busy を待たない（待たされたら、すぐに失敗にする）。 */
const NO_BUSY_WAIT_MS = 0;
/** SQLite の読み取り専用の誤り（`SQLITE_READONLY`）。 */
const SQLITE_READONLY = 8;

let workDirectory = '';
let path = '';
const connections: DatabaseSync[] = [];

const open = (): { readonly connection: SqliteConnection } => {
  const connection = new DatabaseSync(path, { timeout: NO_BUSY_WAIT_MS });
  connections.push(connection);
  return { connection };
};

const queryOnlyOf = (handle: { readonly connection: SqliteConnection }): unknown =>
  (handle.connection.prepare('PRAGMA query_only').get() as Record<string, unknown>)['query_only'];

const countRows = (handle: { readonly connection: SqliteConnection }): number =>
  Number((handle.connection.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-read-transaction-'));
  path = join(workDirectory, 'read.sqlite');
  const setup = open();
  setup.connection.exec('PRAGMA journal_mode = WAL');
  setup.connection.exec('CREATE TABLE t (x INTEGER) STRICT');
  setup.connection.exec('INSERT INTO t VALUES (1)');
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) {
      connection.close();
    }
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('Control store: withReadTransaction (T24e round 2)', () => {
  it('reads inside a transaction with query_only on, returns the value, and closes the transaction with query_only off', () => {
    const handle = open();
    const value = withReadTransaction(handle, (connection) => {
      expect(connection.isTransaction).toBe(true);
      expect(queryOnlyOf({ connection })).toBe(1);
      return countRows({ connection });
    });
    expect(value).toBe(1);
    expect(handle.connection.isTransaction).toBe(false);
    expect(queryOnlyOf(handle)).toBe(0);
  });

  it('rejects a write inside the read with SQLITE_READONLY, writes nothing, and restores query_only', () => {
    const handle = open();
    let caught: unknown;
    expect(() => withReadTransaction(handle, (connection) => {
      try {
        connection.exec('INSERT INTO t VALUES (2)');
      } catch (error) {
        caught = error;
        throw error;
      }
    })).toThrow();
    expect((caught as { readonly errcode?: unknown }).errcode).toBe(SQLITE_READONLY);
    expect(handle.connection.isTransaction).toBe(false);
    expect(queryOnlyOf(handle)).toBe(0);
    expect(countRows(handle)).toBe(1);
    expect(countRows(open())).toBe(1);
  });

  it('can write through withWriteTransaction after a read, and after a read that threw', () => {
    const handle = open();
    withReadTransaction(handle, (connection) => countRows({ connection }));
    withWriteTransaction(handle, (connection) => {
      connection.exec('INSERT INTO t VALUES (2)');
    });
    const failure = new Error('read failed');
    expect(() => withReadTransaction(handle, () => {
      throw failure;
    })).toThrow(failure);
    expect(queryOnlyOf(handle)).toBe(0);
    expect(handle.connection.isTransaction).toBe(false);
    withWriteTransaction(handle, (connection) => {
      connection.exec('INSERT INTO t VALUES (3)');
    });
    expect(countRows(open())).toBe(3);
  });

  it('rejects a function that returns a promise, and restores query_only', () => {
    const handle = open();
    expect(() => withReadTransaction(handle, () => Promise.resolve(1))).toThrow(TypeError);
    expect(handle.connection.isTransaction).toBe(false);
    expect(queryOnlyOf(handle)).toBe(0);
  });

  it('does not nest inside another transaction (read or write)', () => {
    const handle = open();
    expect(() => withWriteTransaction(handle, () => withReadTransaction(handle, () => 1))).toThrow(/must not nest/u);
    expect(() => withReadTransaction(handle, () => withReadTransaction(handle, () => 1))).toThrow(/must not nest/u);
    expect(() => withReadTransaction(handle, () => withWriteTransaction(handle, () => 1))).toThrow(/must not nest/u);
    expect(handle.connection.isTransaction).toBe(false);
    expect(queryOnlyOf(handle)).toBe(0);
  });

  it('does not block a writer on another connection while it reads', () => {
    const reader = open();
    const writer = open();
    const seen = withReadTransaction(reader, (connection) => {
      const before = countRows({ connection });
      withWriteTransaction(writer, (writing) => {
        writing.exec('INSERT INTO t VALUES (2)');
      });
      // 読む間は、始めた時点の内容のまま（WAL の読み取りの一貫性）。
      return [before, countRows({ connection })];
    });
    expect(seen).toEqual([1, 1]);
    expect(countRows(reader)).toBe(2);
  });
});
