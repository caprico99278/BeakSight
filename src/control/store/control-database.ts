// 管理データを開いて準備する唯一の入口（Task 23 の設計書 4.3 の 1〜8、4.6。T23a）。冪等（何回開いてもよい）。
// 手順:
//   1. 環境の確かめ（`checkControlEnvironment`）。通らなければ、何も作らずに止める。`node:sqlite` は、その後に読み込む。
//   2. 置き場所のフォルダがなければ作る。フォルダの位置にフォルダでないものがあれば止める。
//   3. ファイルがあり、大きさが 0 でなければ、先頭 16 byte が SQLite の印かを確かめる。違えば止める。
//   4. 選択肢を常にオブジェクトで渡して開く（`undefined` を渡すと実行時に失敗する。調査の事実）。
//   5. 誰のデータベースか、どの版かを読んで確かめる（何も書かないうちに。ほかのプログラムのファイルを WAL に変えないため、
//      設計書の 6 と 7 の確かめの一部を、5 の WAL より先に行う）。
//   6. `PRAGMA journal_mode=WAL` の結果が `wal` か。`synchronous` は既定（FULL）のまま。
//   7. 版の管理（`runControlMigrations`。版 1 で `application_id` を書く）。
//   8. `PRAGMA quick_check` が `ok` か。
// 止めるときは `ControlStoreError`（閉じた一覧の理由）。利用者のファイルを上書き・削除・移動しない。
// 途中で止めたときは、開いた接続を閉じてから投げる。
import { accessSync, closeSync, constants, mkdirSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { errorCodeOf } from '../../core/errors.js';
import { checkControlEnvironment } from '../environment/control-environment.js';
import {
  assertControlDatabaseIdentity,
  CONTROL_MIGRATIONS,
  CONTROL_SCHEMA_VERSION,
  readControlDatabaseIdentity,
  runControlMigrations,
} from './migrations.js';
import { loadNodeSqlite, type SqliteConnection } from './sqlite-module.js';
import { classifySqliteFailure, ControlStoreError, toControlStoreError } from './store-errors.js';
import type { ControlConnectionHandle } from './transaction.js';

/** 別の接続が書き込み中のときに待つ時間の上限（ミリ秒）。調査で、4〜8 process の同時の書き込みで取りこぼしのなかった値。 */
export const CONTROL_DB_BUSY_TIMEOUT_MS = 5000;

/** SQLite のファイルの先頭の印（`SQLite format 3` と 0 の byte。16 byte）。 */
const SQLITE_FILE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** 開くときの選択肢（常にオブジェクトで渡す。拡張の読み込みと、二重引用符の文字列を許さない）。 */
const CONTROL_DB_OPEN_OPTIONS = Object.freeze({
  open: true,
  readOnly: false,
  timeout: CONTROL_DB_BUSY_TIMEOUT_MS,
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  allowExtension: false,
});

/** WAL の journal mode の名前。 */
const WAL_JOURNAL_MODE = 'wal';
/** `quick_check` が問題なしのときの結果。 */
const QUICK_CHECK_OK = 'ok';

/** 書き込み中のファイルを別のプログラムが開いているときの、OS の誤りのコード。 */
const LOCKED_FILE_ERROR_CODES: ReadonlySet<string> = new Set(['EBUSY']);
/** フォルダの位置（またはその上）にフォルダでないものがあるときの、OS の誤りのコード。 */
const NOT_DIRECTORY_ERROR_CODES: ReadonlySet<string> = new Set(['ENOTDIR', 'EEXIST']);

/** 開いた管理データ（凍結）。 */
export interface ControlDatabase extends ControlConnectionHandle {
  /** ファイルの場所（絶対パス）。 */
  readonly path: string;
  /** 開いたときの版（0 は、この準備で新しく作ったデータベース）。 */
  readonly foundSchemaVersion: number;
  /** 準備の後の版（`CONTROL_SCHEMA_VERSION`）。 */
  readonly schemaVersion: number;
}

// OS の誤りのコード（`ENOENT` など）の取り出し（`errorCodeOf`）は、`src/core/errors.ts` に移した（CC-062。CCX-11）。

/** 2. 置き場所のフォルダを用意する。 */
const prepareDataDirectory = (directory: string): void => {
  let stats: Stats | undefined;
  try {
    stats = statSync(directory, { throwIfNoEntry: false });
  } catch (error) {
    const code = errorCodeOf(error);
    throw new ControlStoreError(
      code !== null && NOT_DIRECTORY_ERROR_CODES.has(code) ? 'DATA_DIRECTORY_NOT_DIRECTORY' : 'DATA_DIRECTORY_NOT_WRITABLE',
      'could not inspect the data directory',
      { cause: error },
    );
  }
  if (stats !== undefined) {
    if (!stats.isDirectory()) {
      throw new ControlStoreError('DATA_DIRECTORY_NOT_DIRECTORY', 'the data directory path is not a directory');
    }
    return;
  }
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    const code = errorCodeOf(error);
    throw new ControlStoreError(
      code !== null && NOT_DIRECTORY_ERROR_CODES.has(code) ? 'DATA_DIRECTORY_NOT_DIRECTORY' : 'DATA_DIRECTORY_NOT_WRITABLE',
      'could not create the data directory',
      { cause: error },
    );
  }
};

/** ファイルの先頭の `SQLITE_FILE_HEADER` の長さを読む（読むだけ）。 */
const readFileHeader = (path: string): Buffer => {
  const header = Buffer.alloc(SQLITE_FILE_HEADER.length);
  let bytesRead = 0;
  try {
    const descriptor = openSync(path, 'r');
    try {
      bytesRead = readSync(descriptor, header, 0, header.length, 0);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = errorCodeOf(error);
    throw new ControlStoreError(
      code !== null && LOCKED_FILE_ERROR_CODES.has(code) ? 'DATABASE_LOCKED' : 'DATABASE_OPEN_FAILED',
      'could not read the database file header',
      { cause: error },
    );
  }
  return header.subarray(0, bytesRead);
};

/** 3. ファイルがあれば、SQLite のファイルで、書き込めるかを確かめる（何も書かない）。 */
const inspectExistingFile = (path: string): void => {
  let stats: Stats | undefined;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    throw new ControlStoreError('DATABASE_OPEN_FAILED', 'could not inspect the database file', { cause: error });
  }
  if (stats === undefined) {
    try {
      accessSync(dirname(path), constants.W_OK);
    } catch (error) {
      throw new ControlStoreError('DATA_DIRECTORY_NOT_WRITABLE', 'the data directory is not writable', { cause: error });
    }
    return;
  }
  if (!stats.isFile()) {
    throw new ControlStoreError('NOT_A_SQLITE_FILE', 'the database path is not a regular file');
  }
  if (stats.size > 0 && !readFileHeader(path).equals(SQLITE_FILE_HEADER)) {
    throw new ControlStoreError('NOT_A_SQLITE_FILE', 'the file does not start with the SQLite header');
  }
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    throw new ControlStoreError('DATABASE_READ_ONLY', 'the database file is not writable', { cause: error });
  }
};

/** 6. journal mode を WAL にし、結果が `wal` であることを確かめる。 */
export const ensureWalJournalMode = (connection: SqliteConnection): void => {
  const row = connection.prepare('PRAGMA journal_mode = WAL').get() as Record<string, unknown> | undefined;
  const mode = row?.['journal_mode'];
  if (mode !== WAL_JOURNAL_MODE) {
    throw new ControlStoreError('DATABASE_WAL_UNAVAILABLE', `journal_mode is ${String(mode)}, not ${WAL_JOURNAL_MODE}`);
  }
};

/** `quick_check` の結果（問題がなければ `ok` の 1 行だけ）。 */
export interface QuickCheckResult {
  readonly ok: boolean;
  /** `quick_check` が返した行（最大 `QUICK_CHECK_MAX_MESSAGES` 行）。 */
  readonly messages: readonly string[];
}

/** `quick_check` が返す問題の行の数の上限（SQLite の既定と同じ）。 */
const QUICK_CHECK_MAX_MESSAGES = 100;

/**
 * `PRAGMA quick_check` を行う（読むだけ）。開くときの確かめ（手順 8）と、状態の表示（`getStoreStatus`）が使う。
 * 壊れ方によっては、SQLite が行を返さずに誤り（`SQLITE_CORRUPT` など）を投げるので、それも「ok でない」結果にする
 * （誤りの文を `messages` に入れる）。壊れているかどうかと関係のない誤り（busy など）は投げ直す。
 */
export const runQuickCheck = (connection: SqliteConnection): QuickCheckResult => {
  let messages: string[];
  try {
    const rows = connection.prepare(`PRAGMA quick_check(${QUICK_CHECK_MAX_MESSAGES})`).all() as Record<string, unknown>[];
    messages = rows.map((row) => String(row['quick_check']));
  } catch (error) {
    if (classifySqliteFailure(error) !== 'DATABASE_INTEGRITY_FAILED') {
      throw error;
    }
    messages = [error instanceof Error ? error.message : String(error)];
  }
  return Object.freeze({
    ok: messages.length === 1 && messages[0] === QUICK_CHECK_OK,
    messages: Object.freeze(messages),
  });
};

/** 8. `quick_check` が `ok` の 1 行だけであることを確かめる。 */
const ensureQuickCheckOk = (connection: SqliteConnection): void => {
  const result = runQuickCheck(connection);
  if (!result.ok) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `quick_check reported ${result.messages.length} problem rows`);
  }
};

/** 途中で止めるときに、接続を閉じる（閉じるときの誤りは、元の誤りを隠さないように無視する）。 */
const closeQuietly = (connection: SqliteConnection): void => {
  try {
    if (connection.isOpen) {
      connection.close();
    }
  } catch {
    // 元の誤りを投げるので、ここでは何もしない。
  }
};

/**
 * 管理データを開いて準備する（設計書 4.3 の 1〜8）。`databasePath` は絶対パス（本番は `resolveControlDatabasePath` の結果）。
 * 止めるときは `ControlStoreError`。
 */
export const openControlDatabase = (databasePath: string): ControlDatabase => {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) {
    throw new RangeError('the control database path must be an absolute path');
  }

  // 1. 環境の確かめ。`node:sqlite` は、通った後に読み込む。
  const environment = checkControlEnvironment();
  if (!environment.ok) {
    throw new ControlStoreError(environment.reason, `the control environment check failed on Node ${environment.nodeVersion}`);
  }
  const sqlite = loadNodeSqlite();
  if (sqlite === undefined) {
    throw new ControlStoreError('NODE_SQLITE_UNAVAILABLE', 'node:sqlite could not be loaded');
  }

  // 2〜3. フォルダとファイル（何も書き換えない）。
  prepareDataDirectory(dirname(databasePath));
  inspectExistingFile(databasePath);

  // 4. 開く。
  let connection: SqliteConnection;
  try {
    connection = new sqlite.DatabaseSync(databasePath, CONTROL_DB_OPEN_OPTIONS);
  } catch (error) {
    throw toControlStoreError(error, 'DATABASE_OPEN_FAILED', 'could not open the control database');
  }

  try {
    // 5. 誰のデータベースか、どの版か（読むだけ）。
    assertControlDatabaseIdentity(readControlDatabaseIdentity(connection), CONTROL_SCHEMA_VERSION);
    // 6〜8.
    ensureWalJournalMode(connection);
    const outcome = runControlMigrations(connection, CONTROL_MIGRATIONS);
    ensureQuickCheckOk(connection);
    return Object.freeze({ path: databasePath, connection, ...outcome });
  } catch (error) {
    closeQuietly(connection);
    throw toControlStoreError(error, 'DATABASE_OPEN_FAILED', 'could not prepare the control database');
  }
};

/** 管理データを閉じる。2 回呼んでもよい。 */
export const closeControlDatabase = (database: ControlDatabase): void => {
  if (database.connection.isOpen) {
    database.connection.close();
  }
};
