// 管理データへの書き込みの唯一の入口（Task 23 の設計書 4.3 の「書き込みの決まり」。T23a）。
// - `BEGIN IMMEDIATE` で始め、成功なら `COMMIT`、失敗なら `ROLLBACK` する（SQLite は失敗しても自動では戻さない。調査の事実）。
// - 書き込みに deferred の `BEGIN` は使わない（調査で、busy の待ちが効かずに大量に失敗した）。deferred の `BEGIN` は、書き込みを
//   `PRAGMA query_only` で拒む、読むだけの入口（`withReadTransaction`）だけが使う（T24e round 2）。
// - Architecture Gate（`tests/architecture/control-store-boundary.test.ts`）: `src/` の中で SQL の `BEGIN` を書くのは、この関数の中
//   （`BEGIN IMMEDIATE`）と、読むだけの入口 `withReadTransaction` の中（deferred の `BEGIN`。`PRAGMA query_only` つき。T24e round 2）だけ。
// - 書き込みは同期だけ（`node:sqlite` は同期の API）。関数が Promise を返したら、元に戻して拒否する（await の間にトランザクションを
//   開いたままにしない）。入れ子にはしない（外のトランザクションを壊さない）。
import type { SqliteConnection } from './sqlite-module.js';
import { classifySqliteFailure, ControlStoreError } from './store-errors.js';

/** 書き込みに使う接続を持つもの（`ControlDatabase` と、版の管理の途中の接続）。 */
export interface ControlConnectionHandle {
  readonly connection: SqliteConnection;
}

/** Promise のように見える値か（`then` の関数を持つ）。 */
const isThenable = (value: unknown): boolean =>
  (typeof value === 'object' || typeof value === 'function')
  && value !== null
  && typeof (value as { readonly then?: unknown }).then === 'function';

/** 開いているトランザクションを元に戻す（開いていなければ何もしない）。 */
const rollbackIfOpen = (connection: SqliteConnection): void => {
  if (connection.isTransaction) {
    connection.exec('ROLLBACK');
  }
};

/** SQLite の誤りを、分類できれば `ControlStoreError` にする。分類できなければ元の誤りのまま。 */
const classified = (error: unknown, detail: string): unknown => {
  const reason = classifySqliteFailure(error);
  return reason === null ? error : new ControlStoreError(reason, detail, { cause: error });
};

/**
 * `write` を 1 つの書き込みのトランザクション（`BEGIN IMMEDIATE`）の中で行い、その戻り値を返す。
 * - `write` が投げたら、`ROLLBACK` してから、同じ誤りを投げ直す。
 * - 始め（busy の待ちを過ぎた、読み取り専用など）と `COMMIT` の失敗は、分類できれば `ControlStoreError` にして投げる。
 */
export const withWriteTransaction = <T>(handle: ControlConnectionHandle, write: (connection: SqliteConnection) => T): T => {
  const { connection } = handle;
  if (connection.isTransaction) {
    throw new Error('withWriteTransaction must not nest inside another transaction');
  }
  try {
    connection.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw classified(error, 'could not begin a write transaction');
  }
  let result: T;
  try {
    result = write(connection);
  } catch (error) {
    rollbackIfOpen(connection);
    throw error;
  }
  if (isThenable(result)) {
    rollbackIfOpen(connection);
    throw new TypeError('withWriteTransaction takes a synchronous function; the returned promise was rolled back');
  }
  try {
    connection.exec('COMMIT');
  } catch (error) {
    rollbackIfOpen(connection);
    throw classified(error, 'could not commit the write transaction');
  }
  return result;
};

/** 読むだけの印（`PRAGMA query_only`）を外す。外せなくても投げない（呼び出し側が元の誤りを投げる。外せたかを返す）。 */
const leaveQueryOnly = (connection: SqliteConnection): boolean => {
  try {
    connection.exec('PRAGMA query_only = OFF');
    return true;
  } catch {
    return false;
  }
};

/**
 * `read` を、読むだけのトランザクションの中で行い、その戻り値を返す（T24e round 2）。管理データの部品の中の、読むだけの関数が使う。
 * - deferred の `BEGIN` で始め（書き込みのロックを取らない。WAL では、別の接続の書き込みを止めない）、`PRAGMA query_only = ON` にして
 *   から読む。読む中の書き込みは、SQLite が `SQLITE_READONLY` で拒む（何も書かれない）。
 * - 終わりには、成功でも失敗でも、必ず `PRAGMA query_only = OFF` に戻す。成功なら `COMMIT`、失敗なら `ROLLBACK` してから、同じ誤りを
 *   投げ直す。`query_only` を戻せなかったときも、`ROLLBACK` してから誤りを投げる（同じ接続の、後の書き込みが黙って通らないことはない）。
 * - 入れ子にしない（ほかのトランザクションの中では `Error`）。関数が Promise を返したら、元に戻して `TypeError`（`withWriteTransaction` と同じ）。
 */
export const withReadTransaction = <T>(handle: ControlConnectionHandle, read: (connection: SqliteConnection) => T): T => {
  const { connection } = handle;
  if (connection.isTransaction) {
    throw new Error('withReadTransaction must not nest inside another transaction');
  }
  try {
    connection.exec('BEGIN');
  } catch (error) {
    throw classified(error, 'could not begin a read transaction');
  }
  let result: T;
  try {
    connection.exec('PRAGMA query_only = ON');
    result = read(connection);
    if (isThenable(result)) {
      throw new TypeError('withReadTransaction takes a synchronous function; the returned promise was rolled back');
    }
  } catch (error) {
    leaveQueryOnly(connection);
    rollbackIfOpen(connection);
    throw error;
  }
  if (!leaveQueryOnly(connection)) {
    rollbackIfOpen(connection);
    throw new Error('withReadTransaction could not turn query_only off');
  }
  try {
    connection.exec('COMMIT');
  } catch (error) {
    rollbackIfOpen(connection);
    throw classified(error, 'could not commit the read transaction');
  }
  return result;
};
