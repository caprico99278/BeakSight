// SR-1-F2（DEF-170。目当てを絞った再レビュー SR-1R の Critical）: 古いロックの取り直しが重なっても、片方だけが持ち、他方は止まる。
// 重ね方は、レビュー担当の実験 `scratchpad\sr-1r\exp\lock-paths.test.ts` の E2・E3・E4 と同じ形（`ArtifactWriter` のファイルの操作の `rename`・`link` の
// 止め口で順番を決める。時間に左右されない）。直した後は、止めた起動が取り直しの札を持つので、ほかの起動は止め口に来ずに終わる。止め口は、
// ほかの起動が終わった後にも開ける（直した後に待ち続けない）。
// - E2（2 つの再開）: B が古いロック S を動かす直前で止まる間に、A が S を取り直す。直す前は、B が A の新しいロックを動かし、A の後始末がそれを消し、
//   B は戻せずに空いた名前に作って、両方が持った。
// - E3（3 つの再開）: A が S を動かす直前で止まる間に、B が S を取り直す。A が B のロックを動かした隙に C が作る。直す前は、B（ロックのファイルなし）と
//   C の両方が持ち、B のハートビートが C のロックを上書きした。
// - E4（出力先の開始のロック）: E3 と同じ形の 3 つの起動。直す前は、B と C の両方が持った。
// - 札の持ち主が死んでいれば、札を消して 1 回だけやり直す。動かしたファイルがなくなった・違うときは、取り直さない（fail-closed）。
// - 持ち主の側の確かめ: 再開の後始末の後に読み直す。ハートビートは、自分のロックのときだけ書き換える。
// - 後始末: ロックの横のファイルのうち、名前の process が動いているものは消さず、死んでいるものは消す。
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFilePath, checkpointArtifactRelativePath, outputStartLockPath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { movedStaleLockPathFor, newLockTemporaryPathFor, takeoverTokenPathFor } from '../../src/core/lock-file.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  isProcessRunning,
  RUN_LOCK_TAKEOVER_GRACE_MS,
  type RunLock,
} from '../../src/core/process-lock.js';
import { findActiveRunInOutputDirectory, holdOutputStartLock } from '../../src/orchestration/output-start-lock.js';
import { checkRunCheckpointConsistency } from '../../src/orchestration/run-checkpoint.js';
import {
  RunCheckpointSession,
  RunLockLostError,
  type RunCheckpointHeartbeatTimer,
  type RunCheckpointSessionTimers,
} from '../../src/orchestration/run-checkpoint-session.js';
import { ArtifactWriter, type CheckpointFileOperations } from '../../src/report/artifact-writer.js';
import { endWorkerRun, startWorkerRun } from '../../src/worker/worker-run-session.js';
import { FIXTURE_RUN_ID } from '../helpers/audit-run-fixture.js';
import { createDeferred } from '../helpers/deferred.js';
import { sampleRunCheckpoint } from '../helpers/run-checkpoint-samples.js';

/** 古いロックの OS の起動の時刻のずれ（判定の許しの幅を大きく超える）。 */
const OTHER_BOOT_OFFSET_MS = 86_400_000;
const RESUME = Object.freeze({ mode: 'RESUME', completedPageIds: [] } as const);
const MOVED_MARKER = '.stale-';

let workDirectory = '';
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-lock-takeover-overlap-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const newDirectory = (): string => {
  caseNumber += 1;
  return join(workDirectory, `case-${String(caseNumber)}`);
};

/** 前の起動の古いロック（OS の起動の時刻が違い、持ち主の process も終わっている。DEF-172 の猶予を置かずに取り直す形）。 */
const staleLock = (): RunLock => {
  const host = currentProcessRunLockHost(Date.now());
  return { ...createRunLock({ ...host, processId: deadProcessId() }), bootedAtMs: host.bootedAtMs - OTHER_BOOT_OFFSET_MS };
};

/** 終わった process の ID。 */
const deadProcessId = (): number => {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined || isProcessRunning(child.pid)) {
    throw new Error('could not get the ID of a finished process');
  }
  return child.pid;
};

const nodeFileOperations = (): CheckpointFileOperations => ({
  mkdir: async (path, options) => mkdir(path, options),
  open: async (path, flags) => open(path, flags),
  rename: async (oldPath, newPath) => rename(oldPath, newPath),
  rm: async (path, options) => rm(path, options),
  link: async (existingPath, newPath) => link(existingPath, newPath),
  unlink: async (path) => unlink(path),
});

/** 止め口: `reached` に来たら、`proceed` まで待つ。 */
interface Gate {
  readonly reached: ReturnType<typeof createDeferred<void>>;
  readonly proceed: ReturnType<typeof createDeferred<void>>;
}
const newGate = (): Gate => ({ reached: createDeferred<void>(), proceed: createDeferred<void>() });

/**
 * 古いロックを動かす最初の `rename` を、動かす前（`before`）と動かした後（`after`）で止めるファイルの操作。動かす先の名前が、ロックの名前の
 * `.stale-` の形のものだけ（取り直しの札を動かす `rename` は止めない）。
 */
function movingGatedOperations(lockPath: string, before: Gate, after: Gate): CheckpointFileOperations {
  let first = true;
  const movedPrefix = `.${basename(lockPath)}${MOVED_MARKER}`;
  return {
    ...nodeFileOperations(),
    rename: async (oldPath, newPath) => {
      if (!first || oldPath !== lockPath || !basename(newPath).startsWith(movedPrefix)) {
        await rename(oldPath, newPath);
        return;
      }
      first = false;
      before.reached.resolve();
      await before.proceed.promise;
      await rename(oldPath, newPath);
      after.reached.resolve();
      await after.proceed.promise;
    },
  };
}

/** 手で回すハートビートのタイマー。 */
const manualTimers = (): RunCheckpointSessionTimers & { readonly fire: () => void } => {
  let callback: (() => void) | null = null;
  const timer: RunCheckpointHeartbeatTimer = { unref: () => undefined };
  return {
    setInterval: (beat) => {
      callback = beat;
      return timer;
    },
    clearInterval: () => {
      callback = null;
    },
    fire: () => {
      callback?.();
    },
  };
};

const session = (options: { readonly fileOperations?: CheckpointFileOperations; readonly timers?: RunCheckpointSessionTimers } = {}): RunCheckpointSession =>
  new RunCheckpointSession({
    store: new ArtifactWriter(options.fileOperations === undefined ? {} : { fileOperations: options.fileOperations }),
    now: () => Date.now(),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });

const newStaleRun = async (): Promise<{ readonly runDirectory: string; readonly lockPath: string }> => {
  const runDirectory = join(newDirectory(), 'run');
  const lockPath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'));
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify(staleLock()), 'utf8');
  return { runDirectory, lockPath };
};

const readLock = async (lockPath: string): Promise<unknown> => JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
const flush = async (): Promise<void> => wait(50);

describe('DEF-170: overlapping takeovers of a stale lock leave only one holder', () => {
  it('E2: two resumes; the other takeover does not move the new lock, and only one holds', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const before = newGate();
    const after = newGate();
    let released = false;
    const releaseB = (): void => {
      if (!released) {
        released = true;
        before.proceed.resolve();
      }
    };
    // A が新しいロックを作った直後に、B に動かさせ、B が動かし終えるまで A を止める（直す前の形）。
    const operationsA: CheckpointFileOperations = {
      ...nodeFileOperations(),
      link: async (existingPath, newPath) => {
        await link(existingPath, newPath);
        if (newPath === lockPath && !released) {
          releaseB();
          await after.reached.promise;
        }
      },
    };
    const sessionB = session({ fileOperations: movingGatedOperations(lockPath, before, after) });
    const startB = sessionB.start(runDirectory, RESUME);
    await before.reached.promise;
    const sessionA = session({ fileOperations: operationsA });
    const resultA = await sessionA.start(runDirectory, RESUME);
    releaseB();
    after.proceed.resolve();
    const resultB = await startB;
    try {
      expect([resultA.ok, resultB.ok].filter(Boolean), JSON.stringify({ resultA, resultB })).toHaveLength(1);
      // 直した後は、B が取り直しの札を持つ間に A が来るので、A は止まり、B が持つ。
      expect(resultA).toMatchObject({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY' });
      expect(resultB.ok).toBe(true);
      expect(await readdir(dirname(lockPath))).toEqual([basename(lockPath)]);
    } finally {
      await sessionA.abandon();
      await sessionB.abandon();
    }
  });

  it('E3: three resumes; the second does not take over while the first holds the takeover token, and the heartbeat does not overwrite', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const before = newGate();
    const after = newGate();
    const sessionA = session({ fileOperations: movingGatedOperations(lockPath, before, after) });
    const startA = sessionA.start(runDirectory, RESUME);
    await before.reached.promise;
    const timersB = manualTimers();
    const sessionB = session({ timers: timersB });
    const resultB = await sessionB.start(runDirectory, RESUME);
    before.proceed.resolve();
    await after.reached.promise;
    // A が動かした隙（ロックの名前が空）に、C が作る。
    const timersC = manualTimers();
    const sessionC = session({ timers: timersC });
    const resultC = await sessionC.start(runDirectory, RESUME);
    const lockOfC = await readLock(lockPath).catch(() => null);
    after.proceed.resolve();
    const resultA = await startA;
    try {
      expect([resultA.ok, resultB.ok, resultC.ok].filter(Boolean), JSON.stringify({ resultA, resultB, resultC })).toHaveLength(1);
      expect(resultB).toMatchObject({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY' });
      expect(resultC.ok).toBe(true);
      expect(resultA.ok).toBe(false);
      timersB.fire();
      timersC.fire();
      await flush();
      expect(await readLock(lockPath)).toMatchObject({ processId: process.pid, acquiredAtMs: (lockOfC as RunLock).acquiredAtMs });
      expect(await readdir(dirname(lockPath))).toEqual([basename(lockPath)]);
    } finally {
      await sessionA.abandon();
      await sessionB.abandon();
      await sessionC.abandon();
    }
  });

  it('E4: three starts of the output start lock; only one holds', async () => {
    const outputDirectory = newDirectory();
    const lockPath = outputStartLockPath(outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(lockPath, JSON.stringify(staleLock()), 'utf8');
    const before = newGate();
    const after = newGate();
    const startA = holdOutputStartLock(new ArtifactWriter({ fileOperations: movingGatedOperations(lockPath, before, after) }), outputDirectory, Date.now());
    await before.reached.promise;
    const resultB = await holdOutputStartLock(new ArtifactWriter(), outputDirectory, Date.now());
    before.proceed.resolve();
    await after.reached.promise;
    const resultC = await holdOutputStartLock(new ArtifactWriter(), outputDirectory, Date.now());
    after.proceed.resolve();
    const resultA = await startA;
    const results = [resultA, resultB, resultC];
    try {
      expect(results.filter(({ kind }) => kind === 'ACQUIRED').length, JSON.stringify(results)).toBe(1);
      expect(resultB.kind).toBe('HELD_BY_ANOTHER_START');
      expect(resultC.kind).toBe('ACQUIRED');
      expect(await readdir(outputDirectory)).toEqual([basename(lockPath)]);
    } finally {
      for (const result of results) {
        if (result.kind === 'ACQUIRED') {
          await result.release();
        }
      }
    }
  });
});

describe('DEF-170: the takeover token and the moved file', () => {
  it('refuses the takeover while a running process holds the token, and takes it over after the token of a dead process', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const tokenPath = takeoverTokenPathFor(lockPath);
    expect(dirname(tokenPath)).toBe(dirname(lockPath));
    const host = currentProcessRunLockHost(Date.now());
    await writeFile(tokenPath, JSON.stringify({ processId: process.pid, bootedAtMs: host.bootedAtMs, createdAtMs: host.nowMs }), 'utf8');
    const refused = session();
    await expect(refused.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY' });
    // 札も古いロックも、そのまま。
    expect(await readdir(dirname(lockPath))).toEqual([basename(tokenPath), basename(lockPath)].sort());

    await writeFile(tokenPath, JSON.stringify({ processId: deadProcessId(), createdAtMs: Date.now() }), 'utf8');
    const taken = session();
    try {
      await expect(taken.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
      expect(await readLock(lockPath)).toMatchObject({ processId: process.pid });
      expect(await readdir(dirname(lockPath))).toEqual([basename(lockPath)]);
    } finally {
      await taken.abandon();
    }
  });

  it('does not take over when the moved file disappeared or was another lock (fail-closed), and leaves no token', async () => {
    for (const change of ['DISAPPEARED', 'ANOTHER_LOCK'] as const) {
      const { runDirectory, lockPath } = await newStaleRun();
      const other = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 7_777 });
      const operations: CheckpointFileOperations = {
        ...nodeFileOperations(),
        rename: async (oldPath, newPath) => {
          await rename(oldPath, newPath);
          if (oldPath === lockPath && basename(newPath).startsWith(`.${basename(lockPath)}${MOVED_MARKER}`)) {
            if (change === 'DISAPPEARED') {
              await rm(newPath);
            } else {
              await writeFile(newPath, JSON.stringify(other), 'utf8');
            }
          }
        },
      };
      const start = session({ fileOperations: operations });
      const result = await start.start(runDirectory, RESUME);
      expect(result, change).toMatchObject({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY' });
      const names = await readdir(dirname(lockPath));
      expect(names.filter((name) => name.endsWith('.takeover')), change).toEqual([]);
      if (change === 'ANOTHER_LOCK') {
        // 動かしてしまった他人のロックは、元の名前へ戻す。
        expect(await readLock(lockPath)).toEqual(other);
      } else {
        expect(names).toEqual([]);
      }
    }
  });
});

describe('DEF-170: the checks of the holder', () => {
  it('refuses the resume when the lock is no longer its own after the cleanup', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    await rm(lockPath);
    const other = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 7_777 });
    const writer = new ArtifactWriter();
    const store = new Proxy(writer, {
      get(target, property, receiver) {
        if (property === 'cleanUpForResume') {
          return async (...args: Parameters<ArtifactWriter['cleanUpForResume']>) => {
            const removed = await target.cleanUpForResume(...args);
            await writeFile(lockPath, JSON.stringify(other), 'utf8');
            return removed;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const timers = manualTimers();
    const refused = new RunCheckpointSession({ store, now: () => Date.now(), timers });
    await expect(refused.start(runDirectory, RESUME)).resolves.toEqual({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: other });
    timers.fire();
    await flush();
    expect(await readLock(lockPath)).toEqual(other);
  });

  it('rewrites the heartbeat only while the lock is its own, and stops the heartbeat after losing it', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    await rm(lockPath);
    const timers = manualTimers();
    const holder = session({ timers });
    await expect(holder.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
    try {
      timers.fire();
      await flush();
      expect(holder.lockLost).toBe(false);
      const other = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 7_777 });
      await writeFile(lockPath, JSON.stringify(other), 'utf8');
      timers.fire();
      await flush();
      expect(await readLock(lockPath)).toEqual(other);
      expect(holder.lockLost).toBe(true);
    } finally {
      await holder.abandon();
    }
  });
});

describe('DEF-170: the cleanup keeps the side files of running processes', () => {
  it('removes the side files of the run lock of dead processes and keeps those of running ones', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const dead = deadProcessId();
    const livePath = movedStaleLockPathFor(lockPath);
    const liveNewPath = newLockTemporaryPathFor(lockPath);
    const deadPath = movedStaleLockPathFor(lockPath).replace(`${MOVED_MARKER}${String(process.pid)}-`, `${MOVED_MARKER}${String(dead)}-`);
    const deadNewPath = newLockTemporaryPathFor(lockPath).replace(`.new-${String(process.pid)}-`, `.new-${String(dead)}-`);
    const deadTokenPath = takeoverTokenPathFor(lockPath);
    for (const path of [livePath, liveNewPath, deadPath, deadNewPath]) {
      await writeFile(path, '{}', 'utf8');
    }
    await writeFile(deadTokenPath, JSON.stringify({ processId: dead, createdAtMs: Date.now() }), 'utf8');

    const removed = await new ArtifactWriter().cleanUpForResume(runDirectory, []);

    expect([...removed].sort()).toEqual([deadPath, deadNewPath, deadTokenPath].map((path) => `checkpoint/${basename(path)}`).sort());
    expect((await readdir(dirname(lockPath))).sort()).toEqual([basename(lockPath), basename(livePath), basename(liveNewPath)].sort());
  });

  it('removes the dead side files of the output start lock when it takes the start lock', async () => {
    const outputDirectory = newDirectory();
    const lockPath = outputStartLockPath(outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    const dead = deadProcessId();
    const liveNewPath = newLockTemporaryPathFor(lockPath);
    const deadNewPath = liveNewPath.replace(`.new-${String(process.pid)}-`, `.new-${String(dead)}-`);
    await writeFile(liveNewPath, '{}', 'utf8');
    await writeFile(deadNewPath, '{}', 'utf8');
    await writeFile(takeoverTokenPathFor(lockPath), JSON.stringify({ processId: dead, createdAtMs: Date.now() }), 'utf8');

    const held = await holdOutputStartLock(new ArtifactWriter(), outputDirectory, Date.now());
    expect(held.kind).toBe('ACQUIRED');
    expect((await readdir(outputDirectory)).sort()).toEqual([basename(lockPath), basename(liveNewPath)].sort());
    if (held.kind === 'ACQUIRED') {
      await held.release();
    }
  });
});

// SR-1-F4（DEF-172。再レビュー SR-1R2 の Critical・Important）: 動いている持ち主のロックが古く見えても、すぐには取り直さない（猶予の後に読み直す）。
// 持ち主の側は、読み込みと Run のディレクトリへの書き込みの直前に、ロックのファイルを読んで確かめる。札は起動の時刻と作った時刻でも判定する。
// 形はレビュー担当の実験 `scratchpad\sr-1r2\exp\new-paths.test.ts` の N1・N2・N4・N5。猶予の待ちは注入した待ちで進め、実際には 75 秒待たない。
/** 時計が進んだ起動（スリープの後、時計の跳び、止まった process の後を模す）のずれ（ms）。 */
const CLOCK_SHIFT_MS = 6 * 60_000;

/** 時計が `shiftMs` だけ進んだ、再開の保存のセッション（待ちは `waitFor`）。 */
const shiftedSession = (options: {
  readonly shiftMs: number;
  readonly waitFor: (ms: number) => Promise<void>;
  readonly fileOperations?: CheckpointFileOperations;
  readonly timers?: RunCheckpointSessionTimers;
}): RunCheckpointSession => new RunCheckpointSession({
  store: new ArtifactWriter(options.fileOperations === undefined ? {} : { fileOperations: options.fileOperations }),
  now: () => Date.now() + options.shiftMs,
  timers: options.timers ?? manualTimers(),
  wait: options.waitFor,
});

/** ロックのハートビートの時刻が `before` から変わるまで待つ（上限つき）。 */
const untilHeartbeatChanges = async (lockPath: string, before: unknown): Promise<void> => {
  for (let tries = 0; tries < 100 && JSON.stringify(await readLock(lockPath)) === JSON.stringify(before); tries += 1) {
    await wait(10);
  }
};

/** ロックを失った起動が、Run のディレクトリへ書く（保存）ときに拒まれるか（拒まれれば真。書けてしまえば偽）。 */
const refusesToWrite = async (holder: RunCheckpointSession): Promise<boolean> =>
  await holder.saveState(sampleRunCheckpoint()).then(() => false, (error: unknown) => error instanceof RunLockLostError);

describe('DEF-172: a live owner whose lock looks stale, and the checks of the holder', () => {
  it('N2: does not take over the lock of a running owner whose heartbeat advances during the grace, and takes over a stalled one', async () => {
    for (const ownerBeats of [true, false]) {
      const { runDirectory, lockPath } = await newStaleRun();
      const timersA = manualTimers();
      const sessionA = session({ timers: timersA });
      await expect(sessionA.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
      const waits: number[] = [];
      const sessionB = shiftedSession({
        shiftMs: CLOCK_SHIFT_MS,
        waitFor: async (ms) => {
          waits.push(ms);
          if (ms === RUN_LOCK_TAKEOVER_GRACE_MS && ownerBeats) {
            // 猶予の間に、A のハートビート（1 分ごと）が打たれる。
            const before = await readLock(lockPath);
            await wait(5);
            timersA.fire();
            await untilHeartbeatChanges(lockPath, before);
          }
        },
      });
      const resultB = await sessionB.start(runDirectory, RESUME);
      try {
        expect(waits, String(ownerBeats)).toContain(RUN_LOCK_TAKEOVER_GRACE_MS);
        if (ownerBeats) {
          // A は動いていて、ハートビートが進んだ。B は取り直さない。A は書ける。
          expect(resultB).toMatchObject({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN' });
          await expect(sessionA.confirmLockHeld()).resolves.toBe(true);
        } else {
          // A は止まっていた（ハートビートが進まない）。B が取り直し、A は次の書き込みの前に気づいて書かない。
          expect(resultB.ok).toBe(true);
          expect(await refusesToWrite(sessionA)).toBe(true);
          expect(sessionA.lockLost).toBe(true);
          await expect(sessionB.confirmLockHeld()).resolves.toBe(true);
        }
      } finally {
        await sessionA.abandon();
        await sessionB.abandon();
      }
    }
  });

  it('N1: the start whose lock was moved away and replaced stops at its next write, without waiting for its heartbeat', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const tokenPath = takeoverTokenPathFor(lockPath);
    const cAtToken = newGate();
    const cMoved = newGate();
    // C は、古いロック S を判定した後、札を作る直前で止まる。札を取った後、動かした直後でも止まる。
    let cTokenGated = false;
    const operationsC: CheckpointFileOperations = {
      ...nodeFileOperations(),
      link: async (existingPath, newPath) => {
        if (newPath === tokenPath && !cTokenGated) {
          cTokenGated = true;
          cAtToken.reached.resolve();
          await cAtToken.proceed.promise;
        }
        await link(existingPath, newPath);
      },
      rename: async (oldPath, newPath) => {
        await rename(oldPath, newPath);
        if (oldPath === lockPath && basename(newPath).startsWith(`.${basename(lockPath)}${MOVED_MARKER}`)) {
          cMoved.reached.resolve();
          await cMoved.proceed.promise;
        }
      },
    };
    const sessionC = session({ fileOperations: operationsC });
    const startC = sessionC.start(runDirectory, RESUME);
    await cAtToken.reached.promise;
    // A は S を取り直し、後始末と読み直しを終える。
    const sessionA = session({ timers: manualTimers() });
    await expect(sessionA.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
    cAtToken.proceed.resolve();
    await Promise.race([cMoved.reached.promise, startC]);
    // C が A のロックを動かした隙に、E が作る。C は A のロックを戻せない。
    const sessionE = session({ timers: manualTimers() });
    const resultE = await sessionE.start(runDirectory, RESUME);
    cMoved.proceed.resolve();
    const resultC = await startC;
    try {
      expect(resultE.ok).toBe(true);
      expect(resultC.ok).toBe(false);
      // A はハートビートを待たずに、次の書き込みの前に気づいて書かない。E は書ける。
      expect(await refusesToWrite(sessionA)).toBe(true);
      await expect(sessionE.confirmLockHeld()).resolves.toBe(true);
    } finally {
      await sessionA.abandon();
      await sessionC.abandon();
      await sessionE.abandon();
    }
  });

  it('N5: the heartbeat that overwrote a takeover in its read-then-write gap leaves only one writer', async () => {
    const { runDirectory, lockPath } = await newStaleRun();
    const aAtRewrite = newGate();
    let gated = false;
    // A のハートビートは、自分のロックを読んだ後、書き換え（一時ファイルを作って rename）の直前で止まる。
    const operationsA: CheckpointFileOperations = {
      ...nodeFileOperations(),
      open: async (path, flags) => {
        if (gated && flags === 'wx' && basename(path).startsWith(`.${basename(lockPath)}.`) && !basename(path).includes('.new-')) {
          gated = false;
          aAtRewrite.reached.resolve();
          await aAtRewrite.proceed.promise;
        }
        return open(path, flags);
      },
    };
    const timersA = manualTimers();
    const sessionA = session({ fileOperations: operationsA, timers: timersA });
    await expect(sessionA.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
    gated = true;
    timersA.fire();
    await aAtRewrite.reached.promise;
    // A のハートビートが止まっている間に、時計の進んだ B が、猶予の後に取り直す（ハートビートは進まない）。
    const sessionB = shiftedSession({ shiftMs: CLOCK_SHIFT_MS, waitFor: async () => undefined });
    const resultB = await sessionB.start(runDirectory, RESUME);
    aAtRewrite.proceed.resolve();
    await flush();
    try {
      expect(resultB.ok).toBe(true);
      // A の書き換えが B のロックを上書きした。書けるのは 1 つだけ（A）。B は次の書き込みの前に気づいて書かない。
      const refused = [await refusesToWrite(sessionA), await refusesToWrite(sessionB)];
      expect(refused).toEqual([false, true]);
    } finally {
      await sessionA.abandon();
      await sessionB.abandon();
    }
  });

  it('N4: treats a takeover token as dead when its process ID is reused (another boot time, or too old), and takes the lock over', async () => {
    const livePid = process.ppid;
    expect(isProcessRunning(livePid)).toBe(true);
    const host = currentProcessRunLockHost(Date.now());
    for (const token of [
      { processId: livePid, createdAtMs: host.nowMs - 7 * 86_400_000 },
      { processId: livePid, bootedAtMs: host.bootedAtMs - OTHER_BOOT_OFFSET_MS, createdAtMs: host.nowMs },
      { processId: livePid, bootedAtMs: host.bootedAtMs, createdAtMs: host.nowMs - 7 * 86_400_000 },
    ]) {
      const { runDirectory, lockPath } = await newStaleRun();
      await writeFile(takeoverTokenPathFor(lockPath), JSON.stringify(token), 'utf8');
      const taken = session();
      try {
        await expect(taken.start(runDirectory, RESUME), JSON.stringify(token)).resolves.toMatchObject({ ok: true });
        expect(await readdir(dirname(lockPath))).toEqual([basename(lockPath)]);
      } finally {
        await taken.abandon();
      }

      const outputDirectory = newDirectory();
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(outputStartLockPath(outputDirectory), JSON.stringify(staleLock()), 'utf8');
      await writeFile(takeoverTokenPathFor(outputStartLockPath(outputDirectory)), JSON.stringify(token), 'utf8');
      const start = await holdOutputStartLock(new ArtifactWriter(), outputDirectory, Date.now());
      expect(start.kind, JSON.stringify(token)).toBe('ACQUIRED');
      if (start.kind === 'ACQUIRED') {
        await start.release();
      }
    }
  });

  it('keeps a new worker Run out of an output directory whose running owner looks stale but beats during the grace', async () => {
    for (const ownerBeats of [true, false]) {
      const outputDirectory = newDirectory();
      const runDirectory = join(outputDirectory, 'RUN-20261024000000');
      const lockPath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'));
      await mkdir(dirname(lockPath), { recursive: true });
      // 動いている持ち主（この process）の、6 分前のハートビートのロック（持ち主が止まっていたか、時計が進んだ起動から見たもの）。
      const old = createRunLock(currentProcessRunLockHost(Date.now() - CLOCK_SHIFT_MS));
      await writeFile(lockPath, JSON.stringify(old), 'utf8');
      const waits: number[] = [];
      const started = await startWorkerRun(new ArtifactWriter(), outputDirectory, () => new Date(), () => Date.now(), {
        wait: async (ms) => {
          waits.push(ms);
          if (ownerBeats) {
            await writeFile(lockPath, JSON.stringify({ ...old, heartbeatAtMs: Date.now() }), 'utf8');
          }
        },
      });
      try {
        expect(waits, String(ownerBeats)).toContain(RUN_LOCK_TAKEOVER_GRACE_MS);
        expect(started.kind, String(ownerBeats)).toBe(ownerBeats ? 'RUN_ACTIVE' : 'STARTED');
      } finally {
        if (started.kind === 'STARTED') {
          await endWorkerRun(new ArtifactWriter(), started);
        }
      }
    }
  });
});

// SR-1-F5（再レビュー SR-1R3 の I1・M3）: レビュー担当の実験 `scratchpad\sr-1r3\exp\new-paths.test.ts` の U3 と、`cli-clock.test.ts` の
// `finish-during-grace` の形。
describe('SR-1-F5: the grace waits once per check, and a resume does not go on with a decision made before the grace', () => {
  it('U3: waits only once for all the leftover locks of reused process IDs when it checks the output directory', async () => {
    const outputDirectory = newDirectory();
    const host = currentProcessRunLockHost(Date.now());
    const reusedPidLock = (): RunLock => ({ ...createRunLock({ ...host, processId: process.ppid }), bootedAtMs: host.bootedAtMs - OTHER_BOOT_OFFSET_MS });
    const runIds = ['RUN-20260101000001', 'RUN-20260101000002', 'RUN-20260101000003'];
    for (const runId of runIds) {
      const lockPath = artifactFilePath(join(outputDirectory, runId), checkpointArtifactRelativePath('lock'));
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify(reusedPidLock()), 'utf8');
    }
    for (const round of [1, 2]) {
      const waits: number[] = [];
      const active = await findActiveRunInOutputDirectory(new ArtifactWriter(), outputDirectory, Date.now(), {
        wait: async (ms) => {
          waits.push(ms);
        },
      });
      expect(active, String(round)).toBeNull();
      // 3 つの古く見えるロックに、まとめて 1 回だけ待つ（1 回の確かめで最大 75 秒）。
      expect(waits, String(round)).toEqual([RUN_LOCK_TAKEOVER_GRACE_MS]);
    }
    // 待つ間に 1 つのロックが更新されれば、その Run が動いている。
    const changedLockPath = artifactFilePath(join(outputDirectory, runIds[1] ?? ''), checkpointArtifactRelativePath('lock'));
    const active = await findActiveRunInOutputDirectory(new ArtifactWriter(), outputDirectory, Date.now(), {
      wait: async () => {
        await writeFile(changedLockPath, JSON.stringify({ ...reusedPidLock(), heartbeatAtMs: Date.now() + 1 }), 'utf8');
      },
    });
    expect(active).toBe(runIds[1]);
  });

  it('M3: does not resume when the saved state changed during the grace (the owner finished meanwhile), and leaves no lock', async () => {
    const runDirectory = join(newDirectory(), FIXTURE_RUN_ID);
    const writer = new ArtifactWriter();
    await writer.writeCheckpointState(runDirectory, sampleRunCheckpoint());
    const sessionA = session({ timers: manualTimers() });
    await expect(sessionA.start(runDirectory, RESUME)).resolves.toMatchObject({ ok: true });
    // B が再開を選んだときの保存（CLI が読むのと同じ読み方）。
    const chosen = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);
    if (!chosen.ok) {
      throw new Error('the saved state is not readable');
    }
    const finished = sampleRunCheckpoint({ state: 'FINISHED' });
    // 時計の進んだ B が猶予を置く間に、A が Run を終える（最後の状態を書き、ロックを外す）。
    const sessionB = shiftedSession({
      shiftMs: CLOCK_SHIFT_MS,
      waitFor: async (ms) => {
        if (ms === RUN_LOCK_TAKEOVER_GRACE_MS) {
          await sessionA.finish(finished);
        }
      },
    });
    const resultB = await sessionB.start(runDirectory, { mode: 'RESUME', completedPageIds: [], expectedState: chosen.state });
    try {
      expect(resultB).toMatchObject({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN' });
      // B は、取ったロックを外し、A の最後の状態はそのまま。
      expect((await readdir(join(runDirectory, 'checkpoint'))).sort()).toEqual(['state.json', 'state.prev.json']);
      const after = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);
      expect(after.ok && after.state.state).toBe('FINISHED');
    } finally {
      await sessionB.abandon();
    }
  });
});
