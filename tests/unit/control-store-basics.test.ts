// 管理データの部品の土台の単体テスト（Task 23 の設計書 4.3、4.6 の「Git の管理の外であることの保証」、7 章。T23a）。
// - 場所の唯一の owner（`resolveControlDatabasePath`）と、Git の管理の外（`.gitignore`）。
// - 止める理由の閉じた一覧と、SQLite の誤りの分類。
// - 書き込みの唯一の入口（`withWriteTransaction`）。メモリの上のデータベースで確かめる（ファイルを作らない）。
// - WAL の確かめ（実のファイルで WAL にならない状態を作れないので、`PRAGMA journal_mode` の結果を返す偽の接続で確かめる）。
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROL_ENVIRONMENT_FAILURE_REASONS } from '../../src/control/environment/control-environment.js';
import { ensureWalJournalMode } from '../../src/control/store/control-database.js';
import {
  CONTROL_DATABASE_FILE_NAME,
  CONTROL_DATA_DIRECTORY_NAME,
  resolveControlDatabasePath,
} from '../../src/control/store/database-path.js';
import type { SqliteConnection } from '../../src/control/store/sqlite-module.js';
import {
  CONTROL_STORE_FAILURE_REASONS,
  ControlStoreError,
  classifySqliteFailure,
  toControlStoreError,
} from '../../src/control/store/store-errors.js';
import { withWriteTransaction } from '../../src/control/store/transaction.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** SQLite の誤り（`node:sqlite` が投げる形）を作る。 */
const sqliteError = (errcode: number): Error => Object.assign(new Error(`sqlite error ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode });

describe('Control store: location (design 4.3, 4.6)', () => {
  it('resolves local-data/beaksight-control.sqlite under the repository root', () => {
    expect(CONTROL_DATA_DIRECTORY_NAME).toBe('local-data');
    expect(CONTROL_DATABASE_FILE_NAME).toBe('beaksight-control.sqlite');
    const path = resolveControlDatabasePath(REPOSITORY_ROOT);
    expect(isAbsolute(path)).toBe(true);
    expect(relative(REPOSITORY_ROOT, path).split(sep)).toEqual(['local-data', 'beaksight-control.sqlite']);
  });

  it('resolves under any absolute root, including Japanese and spaces', () => {
    const root = join(REPOSITORY_ROOT, '管理 データ');
    expect(resolveControlDatabasePath(root)).toBe(join(root, 'local-data', 'beaksight-control.sqlite'));
  });

  it('rejects a relative or empty root (the caller must decide the root)', () => {
    for (const root of ['', '.', 'local', `..${sep}x`]) {
      expect(() => resolveControlDatabasePath(root), JSON.stringify(root)).toThrow(RangeError);
    }
  });

  it('keeps local-data/ out of Git (.gitignore has /local-data/)', () => {
    const lines = readFileSync(join(REPOSITORY_ROOT, '.gitignore'), 'utf8').split(/\r?\n/u).map((line) => line.trim());
    expect(lines).toContain('/local-data/');
  });
});

describe('Control store: failure reasons', () => {
  it('is a closed, frozen list that starts with the environment reasons', () => {
    expect(CONTROL_STORE_FAILURE_REASONS).toEqual([
      ...CONTROL_ENVIRONMENT_FAILURE_REASONS,
      'DATA_DIRECTORY_NOT_DIRECTORY',
      'DATA_DIRECTORY_NOT_WRITABLE',
      'NOT_A_SQLITE_FILE',
      'NOT_A_BEAKSIGHT_DATABASE',
      'DATABASE_FROM_NEWER_VERSION',
      // LG-2: 基準の版（版 17）より前の版の管理データ。
      'DATABASE_FROM_OLDER_VERSION',
      'DATABASE_LOCKED',
      'DATABASE_READ_ONLY',
      'DATABASE_WAL_UNAVAILABLE',
      'DATABASE_INTEGRITY_FAILED',
      'MIGRATION_FAILED',
      'DATABASE_OPEN_FAILED',
    ]);
    expect(Object.isFrozen(CONTROL_STORE_FAILURE_REASONS)).toBe(true);
    expect(new Set(CONTROL_STORE_FAILURE_REASONS).size).toBe(CONTROL_STORE_FAILURE_REASONS.length);
  });

  it('ControlStoreError carries the reason, an English detail and the cause', () => {
    const cause = new Error('low level');
    const error = new ControlStoreError('NOT_A_SQLITE_FILE', 'the file does not start with the SQLite header', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ControlStoreError');
    expect(error.reason).toBe('NOT_A_SQLITE_FILE');
    expect(error.message).toBe('NOT_A_SQLITE_FILE: the file does not start with the SQLite header');
    expect(error.cause).toBe(cause);
  });

  it('classifies SQLite errors by the primary result code (extended codes included)', () => {
    expect(classifySqliteFailure(sqliteError(5))).toBe('DATABASE_LOCKED'); // SQLITE_BUSY
    expect(classifySqliteFailure(sqliteError(517))).toBe('DATABASE_LOCKED'); // SQLITE_BUSY_SNAPSHOT
    expect(classifySqliteFailure(sqliteError(6))).toBe('DATABASE_LOCKED'); // SQLITE_LOCKED
    expect(classifySqliteFailure(sqliteError(14))).toBe('DATABASE_LOCKED'); // SQLITE_CANTOPEN（フォルダは先に確かめてある）
    expect(classifySqliteFailure(sqliteError(8))).toBe('DATABASE_READ_ONLY'); // SQLITE_READONLY
    expect(classifySqliteFailure(sqliteError(1032))).toBe('DATABASE_READ_ONLY'); // SQLITE_READONLY_DBMOVED
    expect(classifySqliteFailure(sqliteError(11))).toBe('DATABASE_INTEGRITY_FAILED'); // SQLITE_CORRUPT
    expect(classifySqliteFailure(sqliteError(26))).toBe('DATABASE_INTEGRITY_FAILED'); // SQLITE_NOTADB
    expect(classifySqliteFailure(sqliteError(1))).toBeNull(); // SQLITE_ERROR（構文の誤りなど）
    expect(classifySqliteFailure(sqliteError(10))).toBeNull(); // SQLITE_IOERR
    expect(classifySqliteFailure(new Error('not sqlite'))).toBeNull();
    expect(classifySqliteFailure(Object.assign(new Error('x'), { code: 'OTHER', errcode: 5 }))).toBeNull();
    expect(classifySqliteFailure('text')).toBeNull();
  });

  it('toControlStoreError keeps a ControlStoreError, classifies SQLite errors, and falls back otherwise', () => {
    const existing = new ControlStoreError('DATABASE_FROM_NEWER_VERSION', 'x');
    expect(toControlStoreError(existing, 'MIGRATION_FAILED', 'y')).toBe(existing);
    const busy = sqliteError(5);
    const classified = toControlStoreError(busy, 'MIGRATION_FAILED', 'migration to version 1 failed');
    expect(classified.reason).toBe('DATABASE_LOCKED');
    expect(classified.cause).toBe(busy);
    const syntax = sqliteError(1);
    const fallback = toControlStoreError(syntax, 'MIGRATION_FAILED', 'migration to version 1 failed');
    expect(fallback.reason).toBe('MIGRATION_FAILED');
    expect(fallback.message).toBe('MIGRATION_FAILED: migration to version 1 failed');
    expect(toControlStoreError(sqliteError(10), 'DATABASE_OPEN_FAILED', 'open failed').reason).toBe('DATABASE_OPEN_FAILED');
  });
});

describe('Control store: WAL check (design 4.3 step 5)', () => {
  const fakeConnection = (journalMode: unknown): SqliteConnection => ({
    prepare: () => ({ get: () => ({ journal_mode: journalMode }) }),
  }) as unknown as SqliteConnection;

  it('accepts wal', () => {
    expect(() => ensureWalJournalMode(fakeConnection('wal'))).not.toThrow();
  });

  it('stops with DATABASE_WAL_UNAVAILABLE for any other journal mode', () => {
    for (const mode of ['delete', 'memory', 'truncate', 'off', undefined, 1]) {
      let caught: unknown;
      try {
        ensureWalJournalMode(fakeConnection(mode));
      } catch (error) {
        caught = error;
      }
      expect(caught, String(mode)).toBeInstanceOf(ControlStoreError);
      expect((caught as ControlStoreError).reason).toBe('DATABASE_WAL_UNAVAILABLE');
    }
  });
});

describe('Control store: withWriteTransaction (design 4.3 "書き込みの決まり")', () => {
  const openMemory = (): { readonly connection: SqliteConnection } => {
    const connection = new DatabaseSync(':memory:', { timeout: 0 });
    connection.exec('CREATE TABLE t (x INTEGER) STRICT');
    return { connection };
  };
  const countRows = (handle: { readonly connection: SqliteConnection }): number =>
    Number((handle.connection.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n);

  it('commits and returns the value when the function succeeds', () => {
    const handle = openMemory();
    try {
      const value = withWriteTransaction(handle, (connection) => {
        expect(connection.isTransaction).toBe(true);
        connection.exec('INSERT INTO t VALUES (1)');
        return 'done';
      });
      expect(value).toBe('done');
      expect(handle.connection.isTransaction).toBe(false);
      expect(countRows(handle)).toBe(1);
    } finally {
      handle.connection.close();
    }
  });

  it('rolls back and rethrows the same error when the function throws', () => {
    const handle = openMemory();
    try {
      const failure = new Error('stop');
      expect(() => withWriteTransaction(handle, (connection) => {
        connection.exec('INSERT INTO t VALUES (1)');
        connection.exec('CREATE TABLE u (y INTEGER)');
        throw failure;
      })).toThrow(failure);
      expect(handle.connection.isTransaction).toBe(false);
      expect(countRows(handle)).toBe(0);
      expect(handle.connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'u'").get()).toEqual({ n: 0 });
    } finally {
      handle.connection.close();
    }
  });

  it('rolls back and rejects a function that returns a promise (writes are synchronous)', () => {
    const handle = openMemory();
    try {
      expect(() => withWriteTransaction(handle, (connection) => {
        connection.exec('INSERT INTO t VALUES (1)');
        return Promise.resolve(1);
      })).toThrow(TypeError);
      expect(handle.connection.isTransaction).toBe(false);
      expect(countRows(handle)).toBe(0);
    } finally {
      handle.connection.close();
    }
  });

  it('refuses to nest, and leaves the outer transaction as it is', () => {
    const handle = openMemory();
    try {
      withWriteTransaction(handle, (connection) => {
        connection.exec('INSERT INTO t VALUES (1)');
        expect(() => withWriteTransaction(handle, () => 0)).toThrow(/nest/u);
        expect(connection.isTransaction).toBe(true);
      });
      expect(countRows(handle)).toBe(1);
    } finally {
      handle.connection.close();
    }
  });
});
