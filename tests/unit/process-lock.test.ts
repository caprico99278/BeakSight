// T24h-3: ロックの判定と原子的な取り直しの部品を `src/core/` へ移した（振る舞いは変えない移動）。
// - `src/orchestration/run-checkpoint.ts` が、移した部品を今の名前で export し直していること（同じもの）。判定そのものの意味は、既存の
//   `run-checkpoint.test.ts`・`run-checkpoint-session.test.ts`・`stale-lock-takeover.test.ts` などが、今の名前で確かめる。
// - `src/core/` の新しいファイルが、`src/orchestration/`・`src/report/`・`src/control/` を import しないこと。
// - 取り直しの手順（`takeOverLockFile`）の判断: 偽のファイルの操作で、動かせない・違うものを動かした・作れた・作れなかった、のそれぞれ。
// - 一時ファイルの名前の決まり（`temporaryPathFor`・`isTemporaryFileName`）と、古いロックを動かす先の名前（`movedStaleLockPathFor`）。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as lockFile from '../../src/core/lock-file.js';
import * as processLock from '../../src/core/process-lock.js';
import * as temporaryFileName from '../../src/core/temporary-file-name.js';
import * as runCheckpoint from '../../src/orchestration/run-checkpoint.js';

const MOVED_VALUES = [
  'LOCK_TAKEOVER_MAX_ATTEMPTS',
  'LOCK_TAKEOVER_OUTCOMES',
  'LOCK_TAKEOVER_RESULT_KINDS',
  'RUN_LOCK_BOOT_TIME_TOLERANCE_MS',
  'RUN_LOCK_HEARTBEAT_INTERVAL_MS',
  'RUN_LOCK_STALE_AFTER_MS',
  'RUN_LOCK_STATES',
  'acquireLockTakingOverStale',
  'createRunLock',
  'currentProcessRunLockHost',
  'isOwnRunLock',
  'isProcessRunning',
  'judgeRunLock',
  'renewRunLock',
  'takeOverStaleLock',
] as const;

describe('the lock parts moved to src/core', () => {
  it('are exported again by run-checkpoint.ts under the same names (the very same values)', () => {
    for (const name of MOVED_VALUES) {
      expect(runCheckpoint[name], name).toBe(processLock[name]);
    }
    expect(Object.keys(processLock).sort()).toEqual([...MOVED_VALUES].sort());
  });

  it('keeps the values of the lock constants and the closed lists', () => {
    expect(processLock.RUN_LOCK_BOOT_TIME_TOLERANCE_MS).toBe(120_000);
    expect(processLock.RUN_LOCK_STALE_AFTER_MS).toBe(300_000);
    expect(processLock.RUN_LOCK_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(processLock.RUN_LOCK_STATES).toEqual(['ACTIVE', 'STALE']);
    expect(processLock.LOCK_TAKEOVER_OUTCOMES).toEqual(['ACQUIRED', 'CHANGED', 'LOST']);
    expect(processLock.LOCK_TAKEOVER_RESULT_KINDS).toEqual(['ACQUIRED', 'HELD', 'CONTENDED']);
    expect(processLock.LOCK_TAKEOVER_MAX_ATTEMPTS).toBe(3);
  });

  it('do not import src/orchestration, src/report or src/control', () => {
    for (const file of ['src/core/process-lock.ts', 'src/core/lock-file.ts', 'src/core/temporary-file-name.ts']) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/^import[^;]*from '([^']+)';/gmu)].map((match) => match[1] ?? '');
      expect(imports.filter((specifier) => /\/(?:orchestration|report|control)\//u.test(specifier)), file).toEqual([]);
    }
  });
});

describe('takeOverLockFile (the decisions of the atomic takeover)', () => {
  const JUDGED = Object.freeze({ processId: 1, bootedAtMs: 2, acquiredAtMs: 3, heartbeatAtMs: 4 });
  const LOCK_PATH = join('out', 'run.lock');

  /** 偽のファイルの操作と、呼ばれた操作の記録。 */
  function fakeOperations(options: { readonly moved: boolean; readonly content?: unknown; readonly created?: boolean }) {
    const calls: string[] = [];
    const operations: lockFile.LockFileTakeoverOperations = {
      moveAway: async (path, movedPath) => {
        calls.push(`moveAway ${basename(path)} -> ${movedPath === LOCK_PATH ? 'same' : 'other'}`);
        return options.moved;
      },
      readJson: async () => {
        calls.push('readJson');
        return options.content;
      },
      createExclusive: async (path) => {
        calls.push(`createExclusive ${basename(path)}`);
        return options.created ?? true;
      },
      restore: async (_movedPath, path) => {
        calls.push(`restore ${basename(path)}`);
      },
      remove: async () => {
        calls.push('remove');
      },
    };
    return { operations, calls };
  }

  it('reports CHANGED without anything else when the lock has gone', async () => {
    const { operations, calls } = fakeOperations({ moved: false });
    await expect(lockFile.takeOverLockFile(operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'CHANGED' });
    expect(calls).toEqual(['moveAway run.lock -> other']);
  });

  it('restores the moved lock and reports CHANGED when it is not the judged one', async () => {
    const { operations, calls } = fakeOperations({ moved: true, content: { ...JUDGED, heartbeatAtMs: 5 } });
    await expect(lockFile.takeOverLockFile(operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'CHANGED' });
    expect(calls).toEqual(['moveAway run.lock -> other', 'readJson', 'restore run.lock', 'remove']);
  });

  it('creates the new lock with wx and reports ACQUIRED, or LOST when wx loses', async () => {
    const won = fakeOperations({ moved: true, content: { ...JUDGED } });
    await expect(lockFile.takeOverLockFile(won.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'ACQUIRED' });
    expect(won.calls).toEqual(['moveAway run.lock -> other', 'readJson', 'createExclusive run.lock', 'remove']);

    const lost = fakeOperations({ moved: true, content: { ...JUDGED }, created: false });
    await expect(lockFile.takeOverLockFile(lost.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'LOST' });
    expect(lost.calls).toEqual(['moveAway run.lock -> other', 'readJson', 'createExclusive run.lock', 'remove']);
  });

  it('moves the stale lock to a unique temporary-file name that has the process ID', () => {
    const first = lockFile.movedStaleLockPathFor(LOCK_PATH);
    const second = lockFile.movedStaleLockPathFor(LOCK_PATH);
    expect(first).not.toBe(second);
    expect(basename(first).startsWith(`.run.lock.stale-${process.pid}-`)).toBe(true);
    expect(temporaryFileName.isTemporaryFileName(basename(first))).toBe(true);
  });
});

describe('the temporary file names', () => {
  it('tells the names made by temporaryPathFor from other names', () => {
    expect(temporaryFileName.isTemporaryFileName(basename(temporaryFileName.temporaryPathFor(join('a', 'state.json'))))).toBe(true);
    for (const name of ['state.json', '.state.json.tmp', '.state.json.not-a-uuid.tmp', '..00000000-0000-0000-0000-000000000000.tmp']) {
      expect(temporaryFileName.isTemporaryFileName(name), name).toBe(false);
    }
  });
});
