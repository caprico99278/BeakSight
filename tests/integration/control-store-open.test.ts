// 管理データを開いて準備する部品（`openControlDatabase`）の結合テスト（Task 23 の設計書 4.3、7 章の「何もない状態からの準備」。T23a）。
// - すべて `os.tmpdir()` の下の一時のフォルダで行い、終わったら消す（リポジトリの `local-data/` を作らない）。
// - 利用者のファイルを上書きしないことは、前後の SHA-256 で確かめる。
// - `node:sqlite` は、テストの側では準備の結果を確かめるためだけに直接使う（`src/` の外。Gate の対象外）。
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROL_DB_BUSY_TIMEOUT_MS,
  closeControlDatabase,
  openControlDatabase,
  type ControlDatabase,
} from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_DB_APPLICATION_ID, CONTROL_SCHEMA_VERSION } from '../../src/control/store/migrations.js';
import { ControlStoreError, type ControlStoreFailureReason } from '../../src/control/store/store-errors.js';
import { withWriteTransaction } from '../../src/control/store/transaction.js';

/** 別のアプリの `application_id`（BeakSight の値と違うもの）。 */
const FOREIGN_APPLICATION_ID = 0x0f0f0f0f;
/** 生のデータベースを読むときの busy の待ち（ミリ秒）。テストの接続は待たない。 */
const RAW_TIMEOUT_MS = 0;
/** SQLite のページの大きさ（既定）。壊すページの位置に使う。 */
const SQLITE_PAGE_SIZE = 4096;
/** `quick_check` を失敗させるために書く行の数（複数のページにまたがる量）。 */
const CORRUPTION_ROW_COUNT = 2000;
/** 行の長さを変える周期（索引のページを複数にするため）。 */
const CORRUPTION_ROW_PADDING_CYCLE = 50;
/** ページの番号の始まり（SQLite のページは 1 始まり）。 */
const FIRST_PAGE_NUMBER = 1;
/** 壊すときに書く byte。 */
const CORRUPTION_BYTE = 0x5a;
/** 読み取り専用と、書き込みの許可。 */
const READ_ONLY_MODE = 0o444;
const READ_WRITE_MODE = 0o666;
const NOT_WRITABLE_DIRECTORY_MODE = 0o555;
const WRITABLE_DIRECTORY_MODE = 0o755;
/** `DATABASE_LOCKED` の確かめの時間の上限（busy の待ち＋余裕）。 */
const LOCKED_TEST_TIMEOUT_MS = CONTROL_DB_BUSY_TIMEOUT_MS * 4;
/** busy の待ちの計測の許容（タイマーの粗さの分だけ短く測れてよい）。 */
const BUSY_WAIT_TOLERANCE_RATIO = 0.9;

let workDirectory = '';
const opened: ControlDatabase[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-store-'));
});

afterEach(() => {
  for (const database of opened.splice(0)) {
    closeControlDatabase(database);
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const open = (path: string): ControlDatabase => {
  const database = openControlDatabase(path);
  opened.push(database);
  return database;
};

const hashOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** `openControlDatabase` が投げた `ControlStoreError` の理由。投げなければ失敗にする。 */
const failureReasonOf = (path: string): ControlStoreFailureReason => {
  try {
    open(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStoreError);
    return (error as ControlStoreError).reason;
  }
  throw new Error(`openControlDatabase(${path}) did not fail`);
};

/** 生の接続で読む（テストの確かめ用）。 */
const withRaw = <T>(path: string, read: (connection: DatabaseSync) => T): T => {
  const connection = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS });
  try {
    return read(connection);
  } finally {
    connection.close();
  }
};

const pragmaOf = (connection: DatabaseSync, name: string): unknown =>
  (connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];

const databasePathIn = (root: string): string => resolveControlDatabasePath(root);

describe('openControlDatabase: preparing from nothing (design 4.3, 7)', () => {
  it('creates the folder and the database when neither exists, and sets WAL, application_id and user_version', () => {
    const path = databasePathIn(workDirectory);
    expect(existsSync(dirname(path))).toBe(false);

    const database = open(path);
    expect(database.path).toBe(path);
    expect(database.foundSchemaVersion).toBe(0);
    expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    expect(Object.isFrozen(database)).toBe(true);
    expect(statSync(dirname(path)).isDirectory()).toBe(true);
    closeControlDatabase(database);

    // close で WAL の補助のファイルが消える（調査の事実）。
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    withRaw(path, (connection) => {
      expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
      expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
      expect(pragmaOf(connection, 'journal_mode')).toBe('wal');
    });
  });

  it('creates the database when the folder exists but the file does not', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    const database = open(path);
    expect(database.foundSchemaVersion).toBe(0);
    expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
  });

  it('initializes a 0-byte file', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    writeFileSync(path, '');
    const database = open(path);
    expect(database.foundSchemaVersion).toBe(0);
    closeControlDatabase(database);
    withRaw(path, (connection) => {
      expect(pragmaOf(connection, 'application_id')).toBe(CONTROL_DB_APPLICATION_ID);
      expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    });
  });

  it('works with Japanese and spaces in the path', () => {
    const path = databasePathIn(join(workDirectory, '管理 データ の 場所'));
    const database = open(path);
    expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    expect(existsSync(path)).toBe(true);
  });

  it('is idempotent: the second open changes nothing and reports the existing version', () => {
    const path = databasePathIn(workDirectory);
    closeControlDatabase(open(path));
    const before = hashOf(path);

    const second = open(path);
    expect(second.foundSchemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    expect(second.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    closeControlDatabase(second);
    expect(hashOf(path)).toBe(before);
  });

  it('closeControlDatabase can be called twice', () => {
    const database = open(databasePathIn(workDirectory));
    closeControlDatabase(database);
    expect(() => closeControlDatabase(database)).not.toThrow();
    expect(database.connection.isOpen).toBe(false);
  });

  it('rejects a relative path (the caller must pass resolveControlDatabasePath or an absolute path)', () => {
    expect(() => openControlDatabase(join('local-data', 'beaksight-control.sqlite'))).toThrow(RangeError);
  });
});

describe('openControlDatabase: stops without touching the user\'s files (design 4.3, 7)', () => {
  it('DATA_DIRECTORY_NOT_DIRECTORY: a file stands where the folder should be', () => {
    const path = databasePathIn(workDirectory);
    writeFileSync(dirname(path), 'not a folder');
    const before = hashOf(dirname(path));
    expect(failureReasonOf(path)).toBe('DATA_DIRECTORY_NOT_DIRECTORY');
    expect(hashOf(dirname(path))).toBe(before);
  });

  it('DATA_DIRECTORY_NOT_DIRECTORY: a file stands where a parent folder should be', () => {
    const blocker = join(workDirectory, 'blocker');
    writeFileSync(blocker, 'not a folder');
    expect(failureReasonOf(databasePathIn(blocker))).toBe('DATA_DIRECTORY_NOT_DIRECTORY');
    expect(readFileSync(blocker, 'utf8')).toBe('not a folder');
  });

  it('DATA_DIRECTORY_NOT_WRITABLE: the folder cannot be created', () => {
    if (process.platform === 'win32') {
      // Windows: 使われていないドライブの下には作れない。
      const unusedDrive = [...'ZYXWVUTSRQPONMLKJIHGFED'].map((letter) => `${letter}:\\`).find((root) => !existsSync(root));
      expect(unusedDrive).toBeDefined();
      expect(failureReasonOf(databasePathIn(join(unusedDrive ?? '', 'beaksight')))).toBe('DATA_DIRECTORY_NOT_WRITABLE');
      return;
    }
    // POSIX: 書き込みのできないフォルダの下には作れない。
    const parent = join(workDirectory, 'locked-parent');
    mkdirSync(parent);
    chmodSync(parent, NOT_WRITABLE_DIRECTORY_MODE);
    try {
      expect(failureReasonOf(databasePathIn(parent))).toBe('DATA_DIRECTORY_NOT_WRITABLE');
    } finally {
      chmodSync(parent, WRITABLE_DIRECTORY_MODE);
    }
  });

  it('NOT_A_SQLITE_FILE: a text file is neither overwritten nor moved', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    writeFileSync(path, 'this is a note that the user saved here\n');
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_SQLITE_FILE');
    expect(hashOf(path)).toBe(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-journal`)).toBe(false);
  });

  it('NOT_A_SQLITE_FILE: a file shorter than the SQLite header', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    writeFileSync(path, 'SQLite');
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_SQLITE_FILE');
    expect(hashOf(path)).toBe(before);
  });

  it('NOT_A_SQLITE_FILE: a folder stands where the database file should be', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(path, { recursive: true });
    expect(failureReasonOf(path)).toBe('NOT_A_SQLITE_FILE');
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('NOT_A_BEAKSIGHT_DATABASE: another application_id', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    withRaw(path, (connection) => connection.exec(`PRAGMA application_id = ${FOREIGN_APPLICATION_ID}`));
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_BEAKSIGHT_DATABASE');
    expect(hashOf(path)).toBe(before);
  });

  it('NOT_A_BEAKSIGHT_DATABASE: user_version is 0 but tables exist (another program\'s database)', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    withRaw(path, (connection) => connection.exec('CREATE TABLE notes (body TEXT)'));
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_BEAKSIGHT_DATABASE');
    // WAL に切り替えていない（ヘッダーも含めて 1 byte も変えていない）。
    expect(hashOf(path)).toBe(before);
    withRaw(path, (connection) => {
      expect(pragmaOf(connection, 'journal_mode')).toBe('delete');
      expect(pragmaOf(connection, 'application_id')).toBe(0);
    });
  });

  it('NOT_A_BEAKSIGHT_DATABASE: application_id is 0 but user_version is set (another program\'s versioning)', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    withRaw(path, (connection) => connection.exec('PRAGMA user_version = 3'));
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_BEAKSIGHT_DATABASE');
    expect(hashOf(path)).toBe(before);
  });

  it('NOT_A_BEAKSIGHT_DATABASE: the BeakSight application_id with user_version 0 and tables', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    withRaw(path, (connection) => {
      connection.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
      connection.exec('CREATE TABLE stray (x INTEGER)');
    });
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('NOT_A_BEAKSIGHT_DATABASE');
    expect(hashOf(path)).toBe(before);
  });

  it('DATABASE_FROM_NEWER_VERSION: user_version is newer than this BeakSight knows, and nothing is written', () => {
    const path = databasePathIn(workDirectory);
    closeControlDatabase(open(path));
    withRaw(path, (connection) => connection.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION + 1}`));
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('DATABASE_FROM_NEWER_VERSION');
    expect(hashOf(path)).toBe(before);
    withRaw(path, (connection) => expect(pragmaOf(connection, 'user_version')).toBe(CONTROL_SCHEMA_VERSION + 1));
  });

  it('DATABASE_READ_ONLY: the database file is read-only', () => {
    const path = databasePathIn(workDirectory);
    closeControlDatabase(open(path));
    const before = hashOf(path);
    chmodSync(path, READ_ONLY_MODE);
    try {
      expect(failureReasonOf(path)).toBe('DATABASE_READ_ONLY');
    } finally {
      chmodSync(path, READ_WRITE_MODE);
    }
    expect(hashOf(path)).toBe(before);
  });

  it('DATABASE_INTEGRITY_FAILED: the SQLite header is followed by garbage', () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(SQLITE_PAGE_SIZE, CORRUPTION_BYTE)]));
    const before = hashOf(path);
    expect(failureReasonOf(path)).toBe('DATABASE_INTEGRITY_FAILED');
    expect(hashOf(path)).toBe(before);
  });

  it('DATABASE_INTEGRITY_FAILED: quick_check finds a broken page', () => {
    const path = databasePathIn(workDirectory);
    const database = open(path);
    // テストのための表（複数のページを使う）。版 1 の表のページを壊すと、開く途中の読み取りで先に止まるので、
    // T23c で版 1 に表が入った後は、この表の根のページ（`sqlite_schema.rootpage`）だけを壊す。
    database.connection.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT');
    database.connection.exec('CREATE INDEX filler_body ON filler (body)');
    withWriteTransaction(database, (connection) => {
      const insert = connection.prepare('INSERT INTO filler (body) VALUES (?)');
      for (let index = 0; index < CORRUPTION_ROW_COUNT; index += 1) {
        insert.run(`row-${index}-${'x'.repeat(index % CORRUPTION_ROW_PADDING_CYCLE)}`);
      }
    });
    const { rootpage: corruptedPage } = database.connection
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'filler'").get() as { rootpage: number };
    closeControlDatabase(database);
    expect(corruptedPage).toBeGreaterThan(FIRST_PAGE_NUMBER);
    expect(statSync(path).size).toBeGreaterThanOrEqual(SQLITE_PAGE_SIZE * corruptedPage);

    const descriptor = openSync(path, 'r+');
    try {
      writeSync(descriptor, Buffer.alloc(SQLITE_PAGE_SIZE, CORRUPTION_BYTE), 0, SQLITE_PAGE_SIZE, SQLITE_PAGE_SIZE * (corruptedPage - FIRST_PAGE_NUMBER));
    } finally {
      closeSync(descriptor);
    }
    // 1 ページ目（表の一覧）は無事なので、開いて版を確かめるところまでは進み、`quick_check` で止まる。
    expect(() => openControlDatabase(path)).toThrow(/^DATABASE_INTEGRITY_FAILED: quick_check reported/u);
  });

  it('DATABASE_LOCKED: another connection holds an exclusive lock longer than the busy timeout', { timeout: LOCKED_TEST_TIMEOUT_MS }, () => {
    const path = databasePathIn(workDirectory);
    mkdirSync(dirname(path));
    const holder = new DatabaseSync(path, { timeout: RAW_TIMEOUT_MS });
    try {
      holder.exec('CREATE TABLE held (x INTEGER)');
      holder.exec('BEGIN EXCLUSIVE');
      holder.exec('INSERT INTO held VALUES (1)');
      const started = performance.now();
      expect(failureReasonOf(path)).toBe('DATABASE_LOCKED');
      // busy の待ち（名前つきの定数）の間は待ってから止める。
      expect(performance.now() - started).toBeGreaterThanOrEqual(CONTROL_DB_BUSY_TIMEOUT_MS * BUSY_WAIT_TOLERANCE_RATIO);
      holder.exec('ROLLBACK');
    } finally {
      holder.close();
    }
  });
});

