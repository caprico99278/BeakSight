// 管理データの状態（Task 23 の設計書 4.3 の `getStoreStatus`、4.7 の「環境の状態」。T23c）。読むだけ（書き込みの文を書かない）。
// 場所、SQLite の版、データベースの版、作ったときの版と日時（`store_meta`）、状態ごとのプロファイルの件数、`quick_check` の結果。
import { runQuickCheck, type ControlDatabase, type QuickCheckResult } from './control-database.js';
import { CONTROL_SCHEMA_VERSION } from './migrations.js';
import { PROFILE_STATUSES, STORE_META_KEYS, type ProfileStatus } from './profile-records.js';
import { ControlStoreError } from './store-errors.js';

/** 管理データの状態（凍結）。 */
export interface ControlStoreStatus {
  /** ファイルの場所（絶対パス）。 */
  readonly path: string;
  /** 使っている SQLite の版（`sqlite_version()`）。 */
  readonly sqliteVersion: string;
  /** データベースの版（`user_version`）。 */
  readonly schemaVersion: number;
  /** この BeakSight が知る最新の版。 */
  readonly latestSchemaVersion: number;
  /** 作ったときの版（`store_meta`。読めなければ `null`）。 */
  readonly createdSchemaVersion: number | null;
  /** 作ったときの日時（UTC の 14 桁。読めなければ `null`）。 */
  readonly createdAt: string | null;
  /** 状態ごとのプロファイルの件数（件数が 0 の状態も含む）。 */
  readonly profileCounts: Readonly<Record<ProfileStatus, number>>;
  readonly quickCheck: QuickCheckResult;
}

/** 10 進の整数の文字列。 */
const DECIMAL_INTEGER_PATTERN = /^\d+$/u;

const readSingle = (database: ControlDatabase, sql: string, column: string): unknown =>
  (database.connection.prepare(sql).get() as Record<string, unknown> | undefined)?.[column];

const readInteger = (database: ControlDatabase, sql: string, column: string): number => {
  const value = readSingle(database, sql, column);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `${sql} did not return an integer`);
  }
  return value;
};

const readMeta = (database: ControlDatabase): ReadonlyMap<string, string> => {
  const rows = database.connection.prepare('SELECT key, value FROM store_meta').all() as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key, row.value]));
};

/** 管理データの状態を読む。 */
export const getStoreStatus = (database: ControlDatabase): ControlStoreStatus => {
  const meta = readMeta(database);
  const createdSchemaVersionText = meta.get(STORE_META_KEYS.createdSchemaVersion);
  const counts = new Map(
    (database.connection.prepare('SELECT status, count(*) AS profile_count FROM profiles GROUP BY status').all() as {
      status: string;
      profile_count: number;
    }[]).map((row) => [row.status, row.profile_count]),
  );
  const profileCounts = Object.freeze(Object.fromEntries(
    PROFILE_STATUSES.map((status) => [status, counts.get(status) ?? 0]),
  ) as Record<ProfileStatus, number>);
  return Object.freeze({
    path: database.path,
    sqliteVersion: String(readSingle(database, 'SELECT sqlite_version() AS sqlite_version', 'sqlite_version')),
    schemaVersion: readInteger(database, 'PRAGMA user_version', 'user_version'),
    latestSchemaVersion: CONTROL_SCHEMA_VERSION,
    createdSchemaVersion: createdSchemaVersionText !== undefined && DECIMAL_INTEGER_PATTERN.test(createdSchemaVersionText)
      ? Number(createdSchemaVersionText)
      : null,
    createdAt: meta.get(STORE_META_KEYS.createdAt) ?? null,
    profileCounts,
    quickCheck: runQuickCheck(database.connection),
  });
};
