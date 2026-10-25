// T24h-2（DEF-060。独立レビュー T24R の I1）: 古いロックの取り直しを、2 つの起動が同時に行っても、1 つだけが持つ。
// - 重ね方は時間に左右されない: それぞれの起動の `ArtifactWriter` のファイルの操作（`fileOperations`）の最初の `rename` を、両方の起動が
//   そこに来るまで止め、片方ずつ進める（片方が取り直しを終えてから、もう片方が続ける。直す前の「書き換えて読み直す」方式では、両方が
//   自分のものと読む順）。
// - Run のロック（保存のセッションの再開の始め方）: 死んだ process の古いロックを、2 つのセッションが同時に取り直す。
// - 出力先の開始のロック（`acquireOutputStartLock` と同じ部品）: 同じく 2 つの起動が同時に取り直す。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  artifactFilePath,
  checkpointArtifactRelativePath,
  listRunDirectories,
  outputStartLockPath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import { createRunId } from '../../src/core/ids.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  isProcessRunning,
  type RunLock,
  type RunLockHost,
} from '../../src/core/process-lock.js';
import { RunCheckpointSession, type RunCheckpointSessionStart } from '../../src/orchestration/run-checkpoint-session.js';
import { ArtifactWriter, type CheckpointFileOperations } from '../../src/report/artifact-writer.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';

let workDirectory: string;
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-stale-lock-takeover-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const newDirectory = (): string => {
  caseNumber += 1;
  return join(workDirectory, `case-${caseNumber}`);
};

/** 終わった process の ID（子の process を起動して、終わるのを待つ）。 */
function deadProcessId(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined || isProcessRunning(child.pid)) {
    throw new Error('could not get the ID of a finished process');
  }
  return child.pid;
}

/** 2 つの起動の、それぞれの名前の変更の止め口。 */
interface RenameGate {
  /** 最初の `rename` に来た。 */
  readonly reached: Deferred<void>;
  /** 最初の `rename` を進めてよい。 */
  readonly proceed: Deferred<void>;
}

const newGate = (): RenameGate => ({ reached: createDeferred<void>(), proceed: createDeferred<void>() });

/** 最初の `rename` だけを、`gate.proceed` まで止めるファイルの操作（ほかは `node:fs/promises` のまま）。 */
function gatedFileOperations(gate: RenameGate): CheckpointFileOperations {
  let first = true;
  return {
    mkdir: async (path, options) => mkdir(path, options),
    open: async (path, flags) => open(path, flags),
    rm: async (path, options) => rm(path, options),
    rename: async (oldPath, newPath) => {
      if (first) {
        first = false;
        gate.reached.resolve();
        await gate.proceed.promise;
      }
      await rename(oldPath, newPath);
    },
  };
}

/** 取り直しの後の段（保存のセッションの再開の後始末）の止め口。 */
interface AfterTakeoverGate {
  /** 取り直しの後の段に来た。 */
  readonly reached: Deferred<void>;
  /** 取り直しの後の段を進めてよい。 */
  readonly proceed: Deferred<void>;
}

/**
 * 2 つの起動を重ねる: 両方が最初の `rename` に来るまで待ち、1 つ目を進めて、取り直しの後の段に来るか終わるまで待ち、2 つ目を同じく進め、
 * 最後に両方の後の段を進める。`start(index, writer, after)` が、その起動の取り直しの全体（`after` は、取り直しの後の段の止め口）。
 */
async function overlapTwoTakeovers<T>(
  start: (index: number, writer: ArtifactWriter, after: AfterTakeoverGate) => Promise<T>,
): Promise<readonly T[]> {
  const gates = [newGate(), newGate()] as const;
  const afters: readonly AfterTakeoverGate[] = [0, 1].map(() => ({ reached: createDeferred<void>(), proceed: createDeferred<void>() }));
  const runs = gates.map(async (gate, index) =>
    await start(index, new ArtifactWriter({ fileOperations: gatedFileOperations(gate) }), afters[index]!));
  // DEF-170: 取り直しの札を持てなかった起動は、`rename` に来ずに終わる（ほかが取り直している）。
  await Promise.all(gates.map(async (gate, index) => await Promise.race([gate.reached.promise, runs[index]])));
  gates[0].proceed.resolve();
  await Promise.race([afters[0]!.reached.promise, runs[0]]);
  gates[1].proceed.resolve();
  await Promise.race([afters[1]!.reached.promise, runs[1]]);
  afters.forEach((after) => after.proceed.resolve());
  return await Promise.all(runs);
}

/** `writer` の Run のロックと保存の口を持ち、再開の後始末（`cleanUpForResume`）を `after` で止める書き手。 */
function storeStoppingAfterTakeover(writer: ArtifactWriter, after: AfterTakeoverGate): ArtifactWriter {
  return new Proxy(writer, {
    get(target, property, receiver) {
      if (property === 'cleanUpForResume') {
        return async (...args: Parameters<ArtifactWriter['cleanUpForResume']>) => {
          after.reached.resolve();
          await after.proceed.promise;
          return await target.cleanUpForResume(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 2 つのセッションの、別々の持ち主の値（同じ process の中なので、process の ID を分けて、どちらも動いているとみなす）。 */
const OWNER_PROCESS_IDS = [1_001, 1_002] as const;

describe('DEF-060: two resumes take over the same stale run lock at the same time', () => {
  it('lets only one checkpoint session start; the other one is refused', async () => {
    const runDirectory = runArtifactDirectory(newDirectory(), createRunId(20261009000000));
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await new ArtifactWriter().acquireRunLock(runDirectory, stale);
    const deadOwner = stale.processId;

    const starts = await overlapTwoTakeovers(async (index, writer, after): Promise<RunCheckpointSessionStart> => {
      const session = new RunCheckpointSession({
        store: storeStoppingAfterTakeover(writer, after),
        now: () => Date.now(),
        createLockHost: (nowMs): RunLockHost => ({ ...currentProcessRunLockHost(nowMs), processId: OWNER_PROCESS_IDS[index]! }),
        isProcessRunning: (processId) => processId !== deadOwner,
      });
      const started = await session.start(runDirectory, { mode: 'RESUME', completedPageIds: [] });
      if (started.ok) {
        await session.abandon();
      }
      return started;
    });

    // DEF-170: 2 つ目は、1 つ目が取り直しの札を持つ間に来れば `LOCK_TAKEN_OVER_CONCURRENTLY`、取り直しの後に来れば `LOCK_HELD_BY_ACTIVE_RUN`。
    const held = starts.findIndex(({ ok }) => ok);
    expect(starts.filter(({ ok }) => ok)).toHaveLength(1);
    expect(starts[1 - held]).toMatchObject({ ok: false, reason: expect.stringMatching(/^LOCK_(?:HELD_BY_ACTIVE_RUN|TAKEN_OVER_CONCURRENTLY)$/u) });
    const lock = await new ArtifactWriter().readRunLock(runDirectory);
    expect(lock).toMatchObject({ processId: OWNER_PROCESS_IDS[held as 0 | 1] });
  });
});

describe('DEF-060: two starts take over the same stale output start lock at the same time', () => {
  it('lets only one start hold the start lock', async () => {
    const outputDirectory = newDirectory();
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await new ArtifactWriter().acquireOutputStartLock(outputDirectory, stale);
    const deadOwner = stale.processId;
    const { acquireLockTakingOverStale } = await import('../../src/core/process-lock.js');

    const results = await overlapTwoTakeovers(async (index, writer) => {
      const lock: RunLock = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: OWNER_PROCESS_IDS[index]! });
      const host = currentProcessRunLockHost(Date.now());
      return await acquireLockTakingOverStale(
        {
          acquire: async (value) => await writer.acquireOutputStartLock(outputDirectory, value),
          takeOver: async (existing, value) => await writer.takeOverOutputStartLock(outputDirectory, existing, value),
        },
        lock,
        { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning: (processId) => processId !== deadOwner },
      );
    });

    // DEF-170: 2 つ目は、取り直しの札を持てなければ `CONTENDED`、取り直しの後に来れば `HELD`。
    const held = results.findIndex(({ kind }) => kind === 'ACQUIRED');
    expect(results.filter(({ kind }) => kind === 'ACQUIRED')).toHaveLength(1);
    expect(['HELD', 'CONTENDED']).toContain(results[1 - held]?.kind);
    await expect(new ArtifactWriter().readOutputStartLock(outputDirectory)).resolves.toMatchObject({ processId: OWNER_PROCESS_IDS[held as 0 | 1] });
    // 動かした古いファイルは残らず、出力先の Run のディレクトリの一覧にも混ざらない。
    expect((await readdir(outputDirectory)).sort()).toEqual([outputStartLockPath(outputDirectory).slice(outputDirectory.length + 1)]);
    expect(await listRunDirectories(outputDirectory)).toEqual([]);
  });
});

describe('ArtifactWriter: the atomic takeover of a stale lock', () => {
  it('moves the judged stale lock away, creates the new lock with wx, and removes the moved file', async () => {
    const outputDirectory = newDirectory();
    const writer = new ArtifactWriter();
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await writer.acquireOutputStartLock(outputDirectory, stale);
    const lock = createRunLock(currentProcessRunLockHost(Date.now()));

    await expect(writer.takeOverOutputStartLock(outputDirectory, stale, lock)).resolves.toEqual({ outcome: 'ACQUIRED' });

    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toEqual(lock);
    expect(await readdir(outputDirectory)).toHaveLength(1);
  });

  // DEF-170: 動かしたものが判定したものでなければ、戻して `LOST`（取り直しに進まない。fail-closed。前は `CHANGED`）。
  it('reports LOST and leaves the lock as it is when the lock is not the judged one (another start moved or renewed it)', async () => {
    const runDirectory = runArtifactDirectory(newDirectory(), createRunId(20261009000000));
    const writer = new ArtifactWriter();
    const judged = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    const current = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 7_777 });
    await writer.acquireRunLock(runDirectory, current);

    await expect(writer.takeOverRunLock(runDirectory, judged, createRunLock(currentProcessRunLockHost(Date.now()))))
      .resolves.toEqual({ outcome: 'LOST' });

    await expect(writer.readRunLock(runDirectory)).resolves.toEqual(current);
    expect(await readdir(join(runDirectory, 'checkpoint'))).toEqual(['run.lock']);
  });

  it('reports CHANGED when the lock has gone before it could be moved', async () => {
    const outputDirectory = newDirectory();
    await mkdir(outputDirectory, { recursive: true });
    const judged = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });

    await expect(new ArtifactWriter().takeOverOutputStartLock(outputDirectory, judged, createRunLock(currentProcessRunLockHost(Date.now()))))
      .resolves.toEqual({ outcome: 'CHANGED' });
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
  });

  it('reports LOST when another start created the new lock first (wx lost after moving the stale one)', async () => {
    const outputDirectory = newDirectory();
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await new ArtifactWriter().acquireOutputStartLock(outputDirectory, stale);
    const others = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 8_888 });
    // 古いロックを動かした直後（最初の `rename` の後）に、別の起動が新しいロックを作る。
    const writer = new ArtifactWriter({
      fileOperations: {
        mkdir: async (path, options) => mkdir(path, options),
        rm: async (path, options) => rm(path, options),
        rename: async (oldPath, newPath) => {
          await rename(oldPath, newPath);
          if (oldPath === outputStartLockPath(outputDirectory)) {
            await writeFile(outputStartLockPath(outputDirectory), JSON.stringify(others), { flag: 'wx' });
          }
        },
        open: async (path, flags) => open(path, flags),
      },
    });

    await expect(writer.takeOverOutputStartLock(outputDirectory, stale, createRunLock(currentProcessRunLockHost(Date.now()))))
      .resolves.toEqual({ outcome: 'LOST' });
    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toEqual(others);
  });

  it('goes on when the moved stale file cannot be removed (no warning)', async () => {
    const outputDirectory = newDirectory();
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await new ArtifactWriter().acquireOutputStartLock(outputDirectory, stale);
    const lock = createRunLock(currentProcessRunLockHost(Date.now()));
    const writer = new ArtifactWriter({
      fileOperations: {
        mkdir: async (path, options) => mkdir(path, options),
        open: async (path, flags) => open(path, flags),
        rename: async (oldPath, newPath) => rename(oldPath, newPath),
        rm: async () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        },
      },
    });

    await expect(writer.takeOverOutputStartLock(outputDirectory, stale, lock)).resolves.toEqual({ outcome: 'ACQUIRED' });
    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toEqual(lock);
    // 消せなかった動かしたファイルは、出力先の Run のディレクトリの一覧に混ざらない。
    expect(await listRunDirectories(outputDirectory)).toEqual([]);
  });

  it('keeps the moved file names out of the cleanup of a resumed run (a temporary file name)', async () => {
    const runDirectory = runArtifactDirectory(newDirectory(), createRunId(20261009000000));
    const stale = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });
    await new ArtifactWriter().acquireRunLock(runDirectory, stale);
    const writer = new ArtifactWriter({
      fileOperations: {
        mkdir: async (path, options) => mkdir(path, options),
        open: async (path, flags) => open(path, flags),
        rename: async (oldPath, newPath) => rename(oldPath, newPath),
        rm: async () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        },
      },
    });
    await expect(writer.takeOverRunLock(runDirectory, stale, createRunLock(currentProcessRunLockHost(Date.now()))))
      .resolves.toEqual({ outcome: 'ACQUIRED' });
    // DEF-170: 消せなかったのは、動かした古いロックと、取り直しの札（持ち主はこの process）。
    const left = (await readdir(join(runDirectory, 'checkpoint'))).sort();
    expect(left).toHaveLength(3);
    expect(left.filter((name) => name.endsWith('.takeover'))).toEqual(['.run.lock.takeover']);

    // DEF-170: 持ち主の process（この process）が動いている間は、再開のときの後始末も消さない（ほかの起動の取り直しの途中のものを消さない）。
    // 死んだ process のものは消す（`lock-takeover-overlap.test.ts`）。
    await expect(new ArtifactWriter().cleanUpForResume(runDirectory, [])).resolves.toHaveLength(0);
    expect((await readdir(join(runDirectory, 'checkpoint'))).sort()).toEqual(left);
    expect(existsSync(artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock')))).toBe(true);
  });
});
