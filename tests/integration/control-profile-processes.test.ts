// プロファイルの保存の、複数の process と強制終了の結合テスト（Task 23 の設計書 7 章の「書き込み」「落ちたとき」。T23c）。
// - 同時の更新: 2 つの子 process が、同じ改訂を元に同時に更新する。片方だけが成功し、もう片方は改訂の衝突になる（名前つきの回数）。
// - 落ちたとき: 書き込みのトランザクションの途中で子 process を強制終了する。開き直して `quick_check` が ok で、書きかけ（行と履歴）が
//   残らない（名前つきの回数）。任意の時に強制終了する場合も、行と履歴が食い違わない。
// - 一時のフォルダだけを使い、終わったら消す。起動した子 process は、すべて止める。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, listProfiles } from '../../src/control/store/profile-store.js';
import { getStoreStatus } from '../../src/control/store/store-status.js';
import {
  CHILD_PROFILE_ID,
  CHILD_PROTOCOL,
  PROFILE_CHILD_MODULE_URL,
  PUBLIC_TARGET_PATH,
  SECOND_PUBLIC_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  spawnTypeScriptChild,
} from './control-profile-fixtures.js';

/** 同時の更新を繰り返す回数。 */
const CONCURRENT_UPDATE_ROUNDS = 5;
/** 書き込みのトランザクションの途中で強制終了する回数。 */
const HELD_TRANSACTION_KILL_ROUNDS = 3;
/** 更新を繰り返す子 process を、任意の時に強制終了する回数。 */
const LOOP_KILL_ROUNDS = 3;
/** 任意の時の強制終了の前に、子 process が終えるのを待つ更新の回数（少なくとも 1 回は書いてから止める）。 */
const LOOP_UPDATES_BEFORE_KILL = 3;
/** 子 process の 1 行の応答を待つ上限（ミリ秒）。busy の待ち（5 秒）より長く。 */
const CHILD_LINE_TIMEOUT_MS = 20_000;
/** このファイルのテストの時間の上限（ミリ秒）。 */
const PROCESS_TEST_TIMEOUT_MS = 120_000;

let workDirectory = '';
let databasePath = '';
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-processes-'));
  databasePath = resolveControlDatabasePath(workDirectory);
  const database = openControlDatabase(databasePath);
  try {
    const created = createProfile(database, publicProfile(CHILD_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext });
    expect(created.ok).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  rmSync(workDirectory, { recursive: true, force: true });
});

/** 子 process を止めて、終わるのを待つ。 */
const stopChild = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
};

/** 子 process の標準出力を 1 行ずつ読む（読んだ行を順に返す）。 */
interface LineReader {
  readonly next: () => Promise<string>;
  readonly close: () => void;
}

const lineReaderOf = (child: ChildProcessWithoutNullStreams): LineReader => {
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const readline: Interface = createInterface({ input: child.stdout });
  readline.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      lines.push(line);
    } else {
      waiter(line);
    }
  });
  return {
    next: () => {
      const line = lines.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no line from the child process; stderr: ${stderr}`)), CHILD_LINE_TIMEOUT_MS);
        waiters.push((received) => {
          clearTimeout(timer);
          resolve(received);
        });
      });
    },
    close: () => readline.close(),
  };
};

const startChild = (mode: string): { readonly child: ChildProcessWithoutNullStreams; readonly reader: LineReader } => {
  const child = spawnTypeScriptChild(PROFILE_CHILD_MODULE_URL, [mode, databasePath]);
  children.push(child);
  return { child, reader: lineReaderOf(child) };
};

/** 管理データを開いて読む（開くときに `quick_check` まで行う）。 */
const withDatabase = <T>(read: (database: ControlDatabase) => T): T => {
  const database = openControlDatabase(databasePath);
  try {
    return read(database);
  } finally {
    closeControlDatabase(database);
  }
};

interface HistoryRow {
  readonly revision: number;
  readonly document: string;
}

/** 行と履歴が食い違っていないこと: 履歴の改訂が 1 から 1 ずつ続き、最後の履歴の文書が今の行の文書と同じ。 */
const expectConsistentHistory = (database: ControlDatabase): number => {
  const current = getProfile(database, CHILD_PROFILE_ID);
  expect(current).not.toBeNull();
  const history = database.connection
    .prepare('SELECT revision, document FROM profile_revisions WHERE profile_id = ? ORDER BY revision')
    .all(CHILD_PROFILE_ID) as unknown as HistoryRow[];
  expect(history.map((row) => row.revision)).toEqual(history.map((_row, index) => MIN_PROFILE_REVISION + index));
  const latest = history.at(-1);
  expect(latest?.revision).toBe(current?.profile.revision);
  expect(JSON.parse(latest?.document ?? 'null')).toEqual(current?.profile);
  return current?.profile.revision ?? 0;
};

describe('concurrent updates from two processes', () => {
  it(`exactly one of two updates based on the same revision wins, ${CONCURRENT_UPDATE_ROUNDS} rounds`, { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    const first = startChild(CHILD_PROTOCOL.serveMode);
    const second = startChild(CHILD_PROTOCOL.serveMode);
    expect(await first.reader.next()).toBe(CHILD_PROTOCOL.ready);
    expect(await second.reader.next()).toBe(CHILD_PROTOCOL.ready);

    let expectedRevision = MIN_PROFILE_REVISION;
    for (let round = 0; round < CONCURRENT_UPDATE_ROUNDS; round += 1) {
      const command = (targetConfigPath: string): string => `${CHILD_PROTOCOL.update} ${expectedRevision} ${targetConfigPath}\n`;
      first.child.stdin.write(command(PUBLIC_TARGET_PATH));
      second.child.stdin.write(command(SECOND_PUBLIC_TARGET_PATH));
      const results = [await first.reader.next(), await second.reader.next()];
      expect([...results].sort(), `round ${round}`).toEqual([CHILD_PROTOCOL.updated, 'PROFILE_REVISION_CONFLICT'].sort());
      expectedRevision += 1;
    }

    for (const { child, reader } of [first, second]) {
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the child process did not exit')), CHILD_LINE_TIMEOUT_MS);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      child.stdin.write(`${CHILD_PROTOCOL.exit}\n`);
      expect(await exited).toBe(0);
      reader.close();
    }

    withDatabase((database) => {
      expect(expectConsistentHistory(database)).toBe(MIN_PROFILE_REVISION + CONCURRENT_UPDATE_ROUNDS);
      expect(listProfiles(database)).toHaveLength(1);
    });
  });
});

describe('a process killed in the middle of a write transaction', () => {
  it(`leaves no partial write and passes quick_check, ${HELD_TRANSACTION_KILL_ROUNDS} rounds`, { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    const before = withDatabase((database) => JSON.stringify({
      profiles: listProfiles(database),
      history: database.connection.prepare('SELECT * FROM profile_revisions ORDER BY revision').all(),
    }));
    for (let round = 0; round < HELD_TRANSACTION_KILL_ROUNDS; round += 1) {
      const { child, reader } = startChild(CHILD_PROTOCOL.holdMode);
      expect(await reader.next(), `round ${round}`).toBe(CHILD_PROTOCOL.inTransaction);
      await stopChild(child);
      reader.close();

      withDatabase((database) => {
        expect(getStoreStatus(database).quickCheck).toEqual({ ok: true, messages: ['ok'] });
        expect(JSON.stringify({
          profiles: listProfiles(database),
          history: database.connection.prepare('SELECT * FROM profile_revisions ORDER BY revision').all(),
        }), `round ${round}`).toBe(before);
      });
    }
  });

  it(`keeps the row and the history consistent when killed at any time, ${LOOP_KILL_ROUNDS} rounds`, { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    let lastRevision = MIN_PROFILE_REVISION;
    for (let round = 0; round < LOOP_KILL_ROUNDS; round += 1) {
      const { child, reader } = startChild(CHILD_PROTOCOL.loopMode);
      for (let update = 0; update < LOOP_UPDATES_BEFORE_KILL; update += 1) {
        expect(await reader.next()).toMatch(new RegExp(`^${CHILD_PROTOCOL.done} \\d+$`, 'u'));
      }
      await stopChild(child);
      reader.close();

      const revision = withDatabase((database) => {
        expect(getStoreStatus(database).quickCheck.ok).toBe(true);
        return expectConsistentHistory(database);
      });
      expect(revision).toBeGreaterThanOrEqual(lastRevision + LOOP_UPDATES_BEFORE_KILL);
      lastRevision = revision;
    }
  });
});
