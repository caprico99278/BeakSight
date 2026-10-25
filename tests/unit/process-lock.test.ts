// T24h-3: ロックの判定と原子的な取り直しの部品を `src/core/` へ移した（振る舞いは変えない移動）。
// - `src/core/process-lock.ts` が公開する名前の閉じた一覧（LG-4: `run-checkpoint.ts` からの export し直しは捨てた）。判定そのものの意味は、既存の
//   `run-checkpoint.test.ts`・`run-checkpoint-session.test.ts`・`stale-lock-takeover.test.ts` などが確かめる。
// - `src/core/` の新しいファイルが、`src/orchestration/`・`src/report/`・`src/control/` を import しないこと。
// - 取り直しの手順（`takeOverLockFile`）の判断: 偽のファイルの操作で、動かせない・違うものを動かした・作れた・作れなかった、のそれぞれ。
// - 一時ファイルの名前の決まり（`temporaryPathFor`・`isTemporaryFileName`）と、古いロックを動かす先の名前（`movedStaleLockPathFor`）。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as lockFile from '../../src/core/lock-file.js';
import * as processLock from '../../src/core/process-lock.js';
import * as temporaryFileName from '../../src/core/temporary-file-name.js';

const MOVED_VALUES = [
  'ACTIVE_RUN_LOCK_STATE',
  'LOCK_TAKEOVER_MAX_ATTEMPTS',
  'LOCK_TAKEOVER_OUTCOMES',
  'LOCK_TAKEOVER_RESULT_KINDS',
  'RUN_LOCK_BOOT_TIME_TOLERANCE_MS',
  'RUN_LOCK_HEARTBEAT_INTERVAL_MS',
  'RUN_LOCK_STALE_AFTER_MS',
  'RUN_LOCK_STATES',
  // DEF-172: 取り直す前の猶予（判定の部品は `judgeRunLockWithGrace` の 1 つ）。
  'RUN_LOCK_TAKEOVER_GRACE_MARGIN_MS',
  'RUN_LOCK_TAKEOVER_GRACE_MS',
  'acquireLockTakingOverStale',
  'createRunLock',
  'currentProcessRunLockHost',
  'isOwnRunLock',
  'isProcessRunning',
  'judgeRunLock',
  'judgeRunLockWithGrace',
  // SR-1-F5: いくつものロックをまとめて判定する形（待つのは 1 回だけ）。
  'judgeRunLocksWithGrace',
  'renewRunLock',
  'takeOverStaleLock',
] as const;

describe('the lock parts moved to src/core', () => {
  it('exports exactly the lock parts', () => {
    expect(Object.keys(processLock).sort()).toEqual([...MOVED_VALUES].sort());
  });

  it('keeps the values of the lock constants and the closed lists', () => {
    expect(processLock.RUN_LOCK_BOOT_TIME_TOLERANCE_MS).toBe(120_000);
    expect(processLock.RUN_LOCK_STALE_AFTER_MS).toBe(300_000);
    expect(processLock.RUN_LOCK_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    // DEF-172: 取り直す前の猶予は、ハートビートの間隔より長い。
    expect(processLock.RUN_LOCK_TAKEOVER_GRACE_MS).toBe(75_000);
    expect(processLock.RUN_LOCK_TAKEOVER_GRACE_MS).toBeGreaterThan(processLock.RUN_LOCK_HEARTBEAT_INTERVAL_MS);
    // SR-1-F5: 開始のロック（更新しない）を持ったまま待つのは、出力先の確かめ（1 回）と、再開の Run のロック（1 回）の 2 回まで。その間に、
    // 開始のロックが古く見えない（取った時刻から `RUN_LOCK_STALE_AFTER_MS` 以内）。
    expect(2 * processLock.RUN_LOCK_TAKEOVER_GRACE_MS).toBeLessThan(processLock.RUN_LOCK_STALE_AFTER_MS);
    const startLock = processLock.createRunLock({ processId: process.pid, nowMs: 1_000_000, bootedAtMs: 500_000 });
    expect(processLock.judgeRunLock(startLock, {
      nowMs: 1_000_000 + 2 * processLock.RUN_LOCK_TAKEOVER_GRACE_MS, bootedAtMs: 500_000, isProcessRunning: () => true,
    })).toBe('ACTIVE');
    expect(processLock.RUN_LOCK_STATES).toEqual(['ACTIVE', 'STALE']);
    // PRE42-CC 組 R（CC-110）: 判定の結果の `ACTIVE` の名前つきの定数は、閉じた一覧の値と同じ。
    expect(processLock.ACTIVE_RUN_LOCK_STATE).toBe('ACTIVE');
    expect(processLock.RUN_LOCK_STATES).toContain(processLock.ACTIVE_RUN_LOCK_STATE);
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

  const TOKEN = '.run.lock.takeover';
  // DEF-172: 札は、OS の起動の時刻と作った時刻が今のものに近いときだけ、動いている持ち主のもの。
  const TOKEN_HOST = processLock.currentProcessRunLockHost(Date.now());
  const TOKEN_HOLDER = Object.freeze({ processId: 9_999, bootedAtMs: TOKEN_HOST.bootedAtMs, createdAtMs: TOKEN_HOST.nowMs });

  /**
   * 偽のファイルの操作と、呼ばれた操作の記録。DEF-170: 取り直しの札の作成（`tokens` の順の結果。省略は作れる）、札の持ち主が動いているか
   * （`holderRunning`）、動かしたファイルがあるか（`movedExists`）。
   */
  function fakeOperations(options: {
    readonly moved: boolean;
    readonly content?: unknown;
    readonly created?: boolean;
    readonly tokens?: readonly boolean[];
    readonly holderRunning?: boolean;
    readonly movedExists?: boolean;
  }) {
    const calls: string[] = [];
    let tokenAttempts = 0;
    const isToken = (path: string): boolean => basename(path) === TOKEN;
    const operations: lockFile.LockFileTakeoverOperations = {
      moveAway: async (path, movedPath) => {
        calls.push(`moveAway ${basename(path)} -> ${movedPath === LOCK_PATH ? 'same' : 'other'}`);
        return isToken(path) ? true : options.moved;
      },
      readJson: async (path) => {
        calls.push('readJson');
        return isToken(path) || basename(path).startsWith(`.${TOKEN}.stale-`) ? TOKEN_HOLDER : options.content;
      },
      exists: async () => options.movedExists ?? true,
      createExclusive: async (path) => {
        calls.push(`createExclusive ${basename(path)}`);
        return options.created ?? true;
      },
      createExclusiveFile: async (path) => {
        calls.push(`createToken ${basename(path)}`);
        const created = options.tokens?.[tokenAttempts] ?? true;
        tokenAttempts += 1;
        return created;
      },
      restore: async (_movedPath, path) => {
        calls.push(`restore ${basename(path)}`);
      },
      remove: async (path) => {
        calls.push(`remove ${isToken(path) ? 'token' : 'moved'}`);
      },
      isProcessRunning: () => options.holderRunning ?? true,
    };
    return { operations, calls };
  }

  it('reports CHANGED without anything else when the lock has gone, and removes the takeover token', async () => {
    const { operations, calls } = fakeOperations({ moved: false });
    await expect(lockFile.takeOverLockFile(operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'CHANGED' });
    expect(calls).toEqual([`createToken ${TOKEN}`, 'moveAway run.lock -> other', 'remove token']);
  });

  it('restores the moved lock and reports LOST when it is not the judged one or has disappeared (DEF-170, fail-closed)', async () => {
    const other = fakeOperations({ moved: true, content: { ...JUDGED, heartbeatAtMs: 5 } });
    await expect(lockFile.takeOverLockFile(other.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'LOST' });
    expect(other.calls).toEqual([`createToken ${TOKEN}`, 'moveAway run.lock -> other', 'readJson', 'restore run.lock', 'remove moved', 'remove token']);

    const gone = fakeOperations({ moved: true, content: null, movedExists: false });
    await expect(lockFile.takeOverLockFile(gone.operations, LOCK_PATH, null)).resolves.toEqual({ outcome: 'LOST' });
    expect(gone.calls).toEqual([`createToken ${TOKEN}`, 'moveAway run.lock -> other', 'readJson', 'restore run.lock', 'remove moved', 'remove token']);
  });

  it('creates the new lock exclusively and reports ACQUIRED, or LOST when the creation loses', async () => {
    const won = fakeOperations({ moved: true, content: { ...JUDGED } });
    await expect(lockFile.takeOverLockFile(won.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'ACQUIRED' });
    expect(won.calls).toEqual([`createToken ${TOKEN}`, 'moveAway run.lock -> other', 'readJson', 'createExclusive run.lock', 'remove moved', 'remove token']);

    const lost = fakeOperations({ moved: true, content: { ...JUDGED }, created: false });
    await expect(lockFile.takeOverLockFile(lost.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'LOST' });
    expect(lost.calls).toEqual([`createToken ${TOKEN}`, 'moveAway run.lock -> other', 'readJson', 'createExclusive run.lock', 'remove moved', 'remove token']);
  });

  it('reports LOST without moving the lock while a running process holds the takeover token (DEF-170)', async () => {
    const held = fakeOperations({ moved: true, content: { ...JUDGED }, tokens: [false] });
    await expect(lockFile.takeOverLockFile(held.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'LOST' });
    expect(held.calls).toEqual([`createToken ${TOKEN}`, 'readJson']);
  });

  it('removes the token of a dead process and tries once more (DEF-170)', async () => {
    const retried = fakeOperations({ moved: true, content: { ...JUDGED }, tokens: [false, true], holderRunning: false });
    await expect(lockFile.takeOverLockFile(retried.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'ACQUIRED' });
    expect(retried.calls).toEqual([
      `createToken ${TOKEN}`, 'readJson', `moveAway ${TOKEN} -> other`, 'readJson', 'remove moved',
      `createToken ${TOKEN}`, 'moveAway run.lock -> other', 'readJson', 'createExclusive run.lock', 'remove moved', 'remove token',
    ]);
    const twice = fakeOperations({ moved: true, content: { ...JUDGED }, tokens: [false, false], holderRunning: false });
    await expect(lockFile.takeOverLockFile(twice.operations, LOCK_PATH, JUDGED)).resolves.toEqual({ outcome: 'LOST' });
    expect(twice.calls.filter((call) => call.startsWith('createToken'))).toHaveLength(lockFile.TAKEOVER_TOKEN_MAX_ATTEMPTS);
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
