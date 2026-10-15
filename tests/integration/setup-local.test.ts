// `npm run setup:local` の入口（`runSetupLocal`）の結合テスト（Task 23 の設計書 4.6、7 章の「何もない状態からの準備」。T23d）。
// - すべて `os.tmpdir()` の下の一時のフォルダを repoRoot にして行い、終わったら消す（リポジトリの `local-data/` を作らない）。
// - 利用者のファイルを上書きしないことは、前後の SHA-256 で確かめる。
// - `node:sqlite` は、テストの側では、ほかのプログラムのファイルを作るためだけに直接使う（`src/` の外。Gate の対象外）。
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAILURE_EXIT_CODE, SUCCESS_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { MIN_CONTROL_NODE_VERSION } from '../../src/control/environment/control-environment.js';
import { runSetupLocal, type SetupLocalResult } from '../../src/control/setup-local.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_SCHEMA_VERSION } from '../../src/control/store/migrations.js';
import { formatCount } from '../../src/presentation/format.js';
import { CONTROL_STORE_FAILURE_DESCRIPTIONS, SETUP_LOCAL_TEXT } from '../../src/presentation/messages.js';

/** 別のアプリの `application_id`。 */
const FOREIGN_APPLICATION_ID = 0x0f0f0f0f;
/** 読み取り専用と、書き込みの許可。 */
const READ_ONLY_MODE = 0o444;
const READ_WRITE_MODE = 0o666;
/** 古い Node の版（下限より小さい）。 */
const OLD_NODE_VERSION = '22.0.0';

let repoRoot = '';
/** 一時のフォルダの最上位（`repoRoot` をその下に変えるテストがあっても、これを消す）。 */
let workDirectory = '';

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-setup-local-'));
  repoRoot = workDirectory;
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

interface Captured {
  readonly result: SetupLocalResult;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (options: Partial<Parameters<typeof runSetupLocal>[0]> = {}): Captured => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = runSetupLocal({
    repoRoot,
    output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    ...options,
  });
  return { result, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
};

const hashOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const databasePath = (): string => resolveControlDatabasePath(repoRoot);

const expectFailure = (captured: Captured, reason: keyof typeof CONTROL_STORE_FAILURE_DESCRIPTIONS): void => {
  expect(captured.result).toEqual({ exitCode: FAILURE_EXIT_CODE, outcome: 'FAILED', reason });
  expect(captured.stdout).toBe('');
  expect(captured.stderr).toContain(SETUP_LOCAL_TEXT.failedHeading);
  expect(captured.stderr).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason].description);
  expect(captured.stderr).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS[reason].action);
  expect(captured.stderr).toContain(reason);
};

describe('runSetupLocal: from nothing (design 4.6)', () => {
  it('creates local-data/ and the database, shows the place, the version, SQLite, the counts and quick_check, and exits 0', () => {
    expect(existsSync(join(repoRoot, 'local-data'))).toBe(false);
    const first = run();
    expect(first.result).toEqual({ exitCode: SUCCESS_EXIT_CODE, outcome: 'CREATED' });
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain(SETUP_LOCAL_TEXT.doneHeading);
    expect(first.stdout).toContain(databasePath());
    expect(first.stdout).toContain(SETUP_LOCAL_TEXT.createdText(CONTROL_SCHEMA_VERSION));
    expect(first.stdout).toMatch(/SQLite/u);
    expect(first.stdout).toContain(SETUP_LOCAL_TEXT.profileCountsText(formatCount(0), formatCount(0)));
    expect(first.stdout).toContain(SETUP_LOCAL_TEXT.quickCheckOk);
    expect(existsSync(databasePath())).toBe(true);
  });

  it('the second run reports the existing database and changes nothing (idempotent)', () => {
    run();
    const before = hashOf(databasePath());
    const second = run();
    expect(second.result).toEqual({ exitCode: SUCCESS_EXIT_CODE, outcome: 'EXISTING' });
    expect(second.stdout).toContain(SETUP_LOCAL_TEXT.existingText(CONTROL_SCHEMA_VERSION));
    expect(second.stdout).not.toContain(SETUP_LOCAL_TEXT.createdText(CONTROL_SCHEMA_VERSION));
    expect(hashOf(databasePath())).toBe(before);
    const third = run();
    expect(third.result.outcome).toBe('EXISTING');
    expect(hashOf(databasePath())).toBe(before);
  });

  it('works with Japanese and spaces in the repository path', () => {
    repoRoot = join(repoRoot, '日本語 の フォルダ');
    mkdirSync(repoRoot);
    expect(run().result.outcome).toBe('CREATED');
    expect(run().result.outcome).toBe('EXISTING');
  });
});

describe('runSetupLocal: stops with an explanation, an action and a non-zero exit code, and keeps the files', () => {
  it('NOT_A_SQLITE_FILE: a text file at the database path', () => {
    mkdirSync(dirname(databasePath()));
    writeFileSync(databasePath(), 'a note that the user saved here\n');
    const before = hashOf(databasePath());
    const captured = run();
    expectFailure(captured, 'NOT_A_SQLITE_FILE');
    expect(captured.stderr).toContain(SETUP_LOCAL_TEXT.filesKept);
    expect(captured.stderr).toContain(databasePath());
    expect(hashOf(databasePath())).toBe(before);
  });

  it('NOT_A_SQLITE_FILE: a folder at the database path', () => {
    mkdirSync(databasePath(), { recursive: true });
    expectFailure(run(), 'NOT_A_SQLITE_FILE');
    expect(existsSync(databasePath())).toBe(true);
  });

  it('DATA_DIRECTORY_NOT_DIRECTORY: a file where local-data/ should be', () => {
    const blocker = dirname(databasePath());
    writeFileSync(blocker, 'not a folder');
    const before = hashOf(blocker);
    expectFailure(run(), 'DATA_DIRECTORY_NOT_DIRECTORY');
    expect(hashOf(blocker)).toBe(before);
  });

  it('NOT_A_BEAKSIGHT_DATABASE: another program\'s SQLite file', () => {
    mkdirSync(dirname(databasePath()));
    const connection = new DatabaseSync(databasePath());
    try {
      connection.exec(`PRAGMA application_id = ${FOREIGN_APPLICATION_ID}`);
      connection.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    } finally {
      connection.close();
    }
    const before = hashOf(databasePath());
    const captured = run();
    expectFailure(captured, 'NOT_A_BEAKSIGHT_DATABASE');
    expect(captured.stderr).toContain(SETUP_LOCAL_TEXT.filesKept);
    expect(hashOf(databasePath())).toBe(before);
  });

  it('DATABASE_FROM_NEWER_VERSION: made by a newer BeakSight', () => {
    run();
    const connection = new DatabaseSync(databasePath());
    try {
      connection.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    } finally {
      connection.close();
    }
    const before = hashOf(databasePath());
    expectFailure(run(), 'DATABASE_FROM_NEWER_VERSION');
    expect(hashOf(databasePath())).toBe(before);
  });

  it('DATABASE_READ_ONLY: a read-only database file', () => {
    run();
    const before = hashOf(databasePath());
    chmodSync(databasePath(), READ_ONLY_MODE);
    try {
      expectFailure(run(), 'DATABASE_READ_ONLY');
    } finally {
      chmodSync(databasePath(), READ_WRITE_MODE);
    }
    expect(hashOf(databasePath())).toBe(before);
  });

  it('NODE_VERSION_UNSUPPORTED: an old Node (the environment check result is given), and nothing is created', () => {
    const captured = run({ checkEnvironment: () => ({ ok: false, nodeVersion: OLD_NODE_VERSION, reason: 'NODE_VERSION_UNSUPPORTED' }) });
    expectFailure(captured, 'NODE_VERSION_UNSUPPORTED');
    expect(captured.stderr).toContain(SETUP_LOCAL_TEXT.nodeVersionText(OLD_NODE_VERSION, MIN_CONTROL_NODE_VERSION));
    expect(existsSync(join(repoRoot, 'local-data'))).toBe(false);
  });

  it('NODE_SQLITE_UNAVAILABLE: no SQLite feature (the environment check result is given), and nothing is created', () => {
    const captured = run({ checkEnvironment: () => ({ ok: false, nodeVersion: process.versions.node, reason: 'NODE_SQLITE_UNAVAILABLE' }) });
    expectFailure(captured, 'NODE_SQLITE_UNAVAILABLE');
    expect(existsSync(join(repoRoot, 'local-data'))).toBe(false);
  });
});
