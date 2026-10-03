// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 4.3.1、4.4、4.5）の R4a と R4a2a: 保存のセッション
// （`src/orchestration/run-checkpoint-session.ts`）。偽の保存の書き手と、注入した時刻・タイマー・プロセスの判定で確かめる。
// 本物の `ArtifactWriter` を書き手にした確かめは、結合テスト（`tests/integration/run-checkpoint.test.ts`）で行う。
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { PageId } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  createRunLock,
  currentProcessRunLockHost,
  renewRunLock,
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  RUN_LOCK_STALE_AFTER_MS,
  type RunCheckpoint,
  type RunCheckpointLockAcquisition,
  type RunCheckpointPage,
  type RunCheckpointStore,
  type RunLock,
  type RunLockHost,
} from '../../src/orchestration/run-checkpoint.js';
import {
  RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS,
  RUN_CHECKPOINT_SESSION_START_MODES,
  RunCheckpointSession,
  type RunCheckpointHeartbeatTimer,
  type RunCheckpointSessionOptions,
  type RunCheckpointSessionStartOptions,
  type RunCheckpointSessionTimers,
} from '../../src/orchestration/run-checkpoint-session.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { PAGE_1, PAGE_2 } from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';

const RUN_DIRECTORY = 'C:/work/output/RUN-20261001000000';
const PROCESS_ID = 4_321;
const BOOTED_AT_MS = 500_000;
const STARTED_AT_MS = 1_000_000;

/** 今のプロセスの値（注入した時刻から作る）。 */
const lockHost = (nowMs: number): RunLockHost => Object.freeze({ processId: PROCESS_ID, nowMs, bootedAtMs: BOOTED_AT_MS });

/** 書き手が呼ばれた順の記録の1件。 */
type StoreCall =
  | { readonly kind: 'writeCheckpointPage'; readonly runDirectory: string; readonly page: RunCheckpointPage }
  | { readonly kind: 'writeCheckpointState'; readonly runDirectory: string; readonly state: RunCheckpoint }
  | { readonly kind: 'acquireRunLock'; readonly runDirectory: string; readonly lock: RunLock }
  | { readonly kind: 'rewriteRunLock'; readonly runDirectory: string; readonly lock: RunLock }
  | { readonly kind: 'readRunLock'; readonly runDirectory: string }
  | { readonly kind: 'releaseRunLock'; readonly runDirectory: string }
  | { readonly kind: 'cleanUpForResume'; readonly runDirectory: string; readonly completedPageIds: readonly PageId[] };

/**
 * 偽の書き手。呼ばれた順に `calls` に記録する。振る舞いは、各操作の差し替え口で変える。差し替えていない `readRunLock` は、
 * 最後に書いたロック（`acquireRunLock` で作れたものか、`rewriteRunLock` で書き換えたもの。なければ `null`）を返す。
 */
function fakeStore(overrides: Partial<RunCheckpointStore> = {}): { readonly store: RunCheckpointStore; readonly calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  let lockOnDisk: unknown = null;
  const store: RunCheckpointStore = {
    writeCheckpointPage: async (runDirectory, page) => {
      calls.push({ kind: 'writeCheckpointPage', runDirectory, page });
      return overrides.writeCheckpointPage === undefined ? `checkpoint/pages/${page.pageId}.json` : overrides.writeCheckpointPage(runDirectory, page);
    },
    writeCheckpointState: async (runDirectory, state) => {
      calls.push({ kind: 'writeCheckpointState', runDirectory, state });
      await overrides.writeCheckpointState?.(runDirectory, state);
    },
    acquireRunLock: async (runDirectory, lock) => {
      calls.push({ kind: 'acquireRunLock', runDirectory, lock });
      const acquisition: RunCheckpointLockAcquisition = overrides.acquireRunLock === undefined
        ? { acquired: true }
        : await overrides.acquireRunLock(runDirectory, lock);
      lockOnDisk = acquisition.acquired ? lock : acquisition.existing;
      return acquisition;
    },
    rewriteRunLock: async (runDirectory, lock) => {
      calls.push({ kind: 'rewriteRunLock', runDirectory, lock });
      await overrides.rewriteRunLock?.(runDirectory, lock);
      lockOnDisk = lock;
    },
    readRunLock: async (runDirectory) => {
      calls.push({ kind: 'readRunLock', runDirectory });
      return overrides.readRunLock === undefined ? lockOnDisk : overrides.readRunLock(runDirectory);
    },
    releaseRunLock: async (runDirectory) => {
      calls.push({ kind: 'releaseRunLock', runDirectory });
      await overrides.releaseRunLock?.(runDirectory);
    },
    cleanUpForResume: async (runDirectory, completedPageIds) => {
      calls.push({ kind: 'cleanUpForResume', runDirectory, completedPageIds });
      return overrides.cleanUpForResume === undefined ? [] : overrides.cleanUpForResume(runDirectory, completedPageIds);
    },
  };
  return { store, calls };
}

/** 偽のタイマー1つ（`setInterval` の戻り値）。 */
interface FakeTimer extends RunCheckpointHeartbeatTimer {
  readonly callback: () => void;
  readonly intervalMs: number;
  readonly unref: ReturnType<typeof vi.fn<() => unknown>>;
  cleared: boolean;
}

/** 偽のタイマー。`tick` で、解除されていないタイマーの関数を1回ずつ呼ぶ（1回分の間隔が過ぎたものとする）。 */
function fakeTimers(): { readonly timers: RunCheckpointSessionTimers; readonly created: FakeTimer[]; tick(): void } {
  const created: FakeTimer[] = [];
  return {
    timers: {
      setInterval: (callback, intervalMs) => {
        const timer: FakeTimer = { callback, intervalMs, unref: vi.fn<() => unknown>(), cleared: false };
        created.push(timer);
        return timer;
      },
      clearInterval: (timer) => {
        (timer as FakeTimer).cleared = true;
      },
    },
    created,
    tick: () => {
      for (const timer of created.filter(({ cleared }) => !cleared)) {
        timer.callback();
      }
    },
  };
}

/**
 * 偽の書き手、偽のタイマー、注入した時刻で作ったセッション。`isProcessRunning` を渡すと、ロックの判定に使うプロセスの判定を
 * 差し替える（省略すると、セッションの既定の `isProcessRunning`）。
 */
function createSession(
  overrides: Partial<RunCheckpointStore> = {},
  options: Pick<RunCheckpointSessionOptions, 'isProcessRunning'> = {},
) {
  const { store, calls } = fakeStore(overrides);
  const clock = { nowMs: STARTED_AT_MS };
  const timers = fakeTimers();
  const session = new RunCheckpointSession({
    store,
    now: () => clock.nowMs,
    createLockHost: lockHost,
    timers: timers.timers,
    isProcessRunning: options.isProcessRunning,
  });
  return { session, calls, clock, timers };
}

/** 書き出しの Promise の後の処理を終わらせる（ハートビートの書き出しは、待たれないため）。 */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

const kindsOf = (calls: readonly StoreCall[]): string[] => calls.map(({ kind }) => kind);

/** 外から解決する Promise。 */
function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R4a: the checkpoint samples of the tests (CC-037)', () => {
  it('match the checkpoint schemas and the R2 consistency checks', async () => {
    const state = sampleRunCheckpoint({ startPageFinished: true });
    const page = sampleRunCheckpointPage();
    await expect(validateArtifact('checkpoint', sampleRunCheckpoint())).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint', state)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint-page', page)).resolves.toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(sampleRunCheckpoint())).toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
    expect(checkRunCheckpointPageConsistency(page, state)).toEqual({ ok: true });
  });
});

describe('R4a: the checkpoint store interface (design 4.3.1)', () => {
  it('is satisfied by ArtifactWriter, without orchestration importing report', () => {
    expectTypeOf<ArtifactWriter>().toExtend<RunCheckpointStore>();
    const store: RunCheckpointStore = new ArtifactWriter();
    expect(typeof store.writeCheckpointPage).toBe('function');
    expectTypeOf<Awaited<ReturnType<ArtifactWriter['acquireRunLock']>>>().toExtend<RunCheckpointLockAcquisition>();
  });
});

describe('R4a: starting the checkpoint session of a new Run (design 4.3.1, 4.4)', () => {
  it('creates the lock exclusively from the values of the current process and the injected clock', async () => {
    const { session, calls } = createSession();

    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([{ kind: 'acquireRunLock', runDirectory: RUN_DIRECTORY, lock: createRunLock(lockHost(STARTED_AT_MS)) }]);
  });

  it('uses currentProcessRunLockHost when no lock host function is given', async () => {
    const { store, calls } = fakeStore();
    const session = new RunCheckpointSession({ store, now: () => STARTED_AT_MS, timers: fakeTimers().timers });

    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    const [call] = calls;
    expect(call?.kind).toBe('acquireRunLock');
    const host = currentProcessRunLockHost(STARTED_AT_MS);
    expect(call?.kind === 'acquireRunLock' ? call.lock : null).toMatchObject({
      processId: process.pid,
      acquiredAtMs: STARTED_AT_MS,
      heartbeatAtMs: STARTED_AT_MS,
    });
    // OS の起動の時刻は、`os.uptime()` から作るので、呼ぶたびに少しずれることがある。
    expect(Math.abs((call?.kind === 'acquireRunLock' ? call.lock.bootedAtMs : 0) - host.bootedAtMs)).toBeLessThanOrEqual(1_000);
  });

  it('returns a failure with the existing lock and starts no heartbeat when the lock cannot be created', async () => {
    const existing = { processId: 1, bootedAtMs: 0, acquiredAtMs: 0, heartbeatAtMs: 0 };
    const { session, calls, timers } = createSession({ acquireRunLock: async () => ({ acquired: false, existing }) });

    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: false, existingLock: existing });

    expect(timers.created).toEqual([]);
    expect(kindsOf(calls)).toEqual(['acquireRunLock']);
    // 始められなかったセッションでは、保存しない。やめる操作は、何もしない。
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    await expect(session.abandon()).resolves.toBeUndefined();
    expect(kindsOf(calls)).toEqual(['acquireRunLock']);
  });

  it('passes on the failure of the store when the lock cannot be written', async () => {
    const failure = new Error('lock write failed');
    const { session, timers } = createSession({ acquireRunLock: async () => Promise.reject(failure) });

    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).rejects.toBe(failure);
    expect(timers.created).toEqual([]);
  });

  it('stops the timer it made when the heartbeat cannot be started, and can be started again', async () => {
    const { store } = fakeStore();
    const failing: RunCheckpointHeartbeatTimer = {
      unref: () => {
        throw new Error('unref failed');
      },
    };
    const working: RunCheckpointHeartbeatTimer = { unref: () => undefined };
    const made: RunCheckpointHeartbeatTimer[] = [failing, working];
    const cleared: RunCheckpointHeartbeatTimer[] = [];
    const session = new RunCheckpointSession({
      store,
      now: () => STARTED_AT_MS,
      createLockHost: lockHost,
      timers: {
        setInterval: () => made.shift() ?? working,
        clearInterval: (timer) => {
          cleared.push(timer);
        },
      },
    });

    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).rejects.toThrow('unref failed');
    expect(cleared).toEqual([failing]);
    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
    expect(cleared).toEqual([failing]);
  });

  it('rejects a second start, a start mode outside the closed list, and an empty run directory', async () => {
    // R4a2a で `RESUME` を加えた（再開の始め方は、下の R4a2a のテストで確かめる）。
    expect(RUN_CHECKPOINT_SESSION_START_MODES).toEqual(['NEW_RUN', 'RESUME']);
    const { session } = createSession();
    await expect(session.start('', { mode: 'NEW_RUN' })).rejects.toThrow(TypeError);
    await expect(session.start(RUN_DIRECTORY, { mode: 'CONTINUE' } as unknown as { mode: 'NEW_RUN' })).rejects.toThrow(RangeError);

    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).rejects.toThrow(/already/u);
  });

  it('rejects options that are not a store, a clock, a lock host function, or timers with TypeError', () => {
    const { store } = fakeStore();
    const valid: RunCheckpointSessionOptions = { store, now: () => STARTED_AT_MS };
    const invalid: unknown[] = [
      undefined,
      { ...valid, store: undefined },
      { ...valid, store: { ...store, releaseRunLock: undefined } },
      { ...valid, now: 1 },
      { ...valid, createLockHost: 'host' },
      { ...valid, timers: { setInterval: () => ({ unref: () => undefined }) } },
    ];
    for (const options of invalid) {
      expect(() => new RunCheckpointSession(options as RunCheckpointSessionOptions)).toThrow(TypeError);
    }
    expect(() => new RunCheckpointSession(valid)).not.toThrow();
  });
});

describe('R4a: the heartbeat of the lock (design 4.3.1, 4.4)', () => {
  it('rewrites the heartbeat time of the lock every minute with an unref timer', async () => {
    const { session, calls, clock, timers } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    const lock = createRunLock(lockHost(STARTED_AT_MS));

    expect(timers.created).toHaveLength(1);
    expect(timers.created[0]?.intervalMs).toBe(RUN_LOCK_HEARTBEAT_INTERVAL_MS);
    expect(timers.created[0]?.unref).toHaveBeenCalledOnce();

    clock.nowMs = STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS;
    timers.tick();
    await flush();
    clock.nowMs = STARTED_AT_MS + 2 * RUN_LOCK_HEARTBEAT_INTERVAL_MS;
    timers.tick();
    await flush();

    expect(calls.slice(1)).toEqual([
      { kind: 'rewriteRunLock', runDirectory: RUN_DIRECTORY, lock: renewRunLock(lock, STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS) },
      { kind: 'rewriteRunLock', runDirectory: RUN_DIRECTORY, lock: renewRunLock(lock, STARTED_AT_MS + 2 * RUN_LOCK_HEARTBEAT_INTERVAL_MS) },
    ]);
  });

  it('does not throw or reject when a heartbeat write fails, and writes again at the next minute', async () => {
    let failures = 0;
    const { session, calls, timers } = createSession({
      rewriteRunLock: async () => {
        failures += 1;
        if (failures === 1) {
          throw new Error('heartbeat write failed');
        }
      },
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    expect(() => timers.tick()).not.toThrow();
    await flush();
    timers.tick();
    await flush();

    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'rewriteRunLock']);
    await expect(session.saveState(sampleRunCheckpoint())).resolves.toBeUndefined();
  });

  it('does not throw when the store throws synchronously from a heartbeat write', async () => {
    const { store } = fakeStore();
    const timers = fakeTimers();
    const session = new RunCheckpointSession({
      store: {
        ...store,
        rewriteRunLock: () => {
          throw new Error('synchronous heartbeat failure');
        },
      },
      now: () => STARTED_AT_MS,
      createLockHost: lockHost,
      timers: timers.timers,
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    expect(() => timers.tick()).not.toThrow();
    await flush();
  });

  it('skips a heartbeat while the previous heartbeat write is still in progress', async () => {
    const writing = deferred();
    let writes = 0;
    const { session, calls, timers } = createSession({
      rewriteRunLock: async () => {
        writes += 1;
        if (writes === 1) {
          await writing.promise;
        }
      },
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    timers.tick();
    timers.tick();
    await flush();
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock']);

    writing.resolve();
    await flush();
    timers.tick();
    await flush();
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'rewriteRunLock']);
  });
});

describe('R4a: saving pages and the run state (design 4.3)', () => {
  it('passes the page checkpoint and the state to the store with the run directory of the session', async () => {
    const { session, calls } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    const page = sampleRunCheckpointPage();
    const state = sampleRunCheckpoint({ startPageFinished: true });

    await expect(session.savePage(page)).resolves.toBeUndefined();
    await expect(session.saveState(state)).resolves.toBeUndefined();

    expect(calls.slice(1)).toEqual([
      { kind: 'writeCheckpointPage', runDirectory: RUN_DIRECTORY, page },
      { kind: 'writeCheckpointState', runDirectory: RUN_DIRECTORY, state },
    ]);
  });

  it('passes the failures of the store on to the caller', async () => {
    const pageFailure = new Error('page write failed');
    const stateFailure = new Error('state write failed');
    const { session } = createSession({
      writeCheckpointPage: async () => Promise.reject(pageFailure),
      writeCheckpointState: async () => Promise.reject(stateFailure),
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await expect(session.savePage(sampleRunCheckpointPage())).rejects.toBe(pageFailure);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toBe(stateFailure);
  });

  it('rejects saving before the session starts', async () => {
    const { session, calls } = createSession();

    await expect(session.savePage(sampleRunCheckpointPage())).rejects.toThrow(/not active/u);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    expect(calls).toEqual([]);
  });
});

describe('R4a: finishing and abandoning the session (design 4.3.1)', () => {
  it('finishes by writing the final state, stopping the heartbeat, and then releasing the lock', async () => {
    const { session, calls, timers } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    const finalState = sampleRunCheckpoint({ startPageFinished: true, state: 'FINISHED' });

    await session.finish(finalState);

    expect(calls.slice(1)).toEqual([
      { kind: 'writeCheckpointState', runDirectory: RUN_DIRECTORY, state: finalState },
      { kind: 'releaseRunLock', runDirectory: RUN_DIRECTORY },
    ]);
    expect(timers.created[0]?.cleared).toBe(true);
    // 終えた後は、ハートビートも保存もしない。
    timers.tick();
    await flush();
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'writeCheckpointState', 'releaseRunLock']);
    await expect(session.saveState(finalState)).rejects.toThrow(/not active/u);
    await expect(session.finish(finalState)).rejects.toThrow(/not active/u);
  });

  it('stops the heartbeat before the lock is released', async () => {
    const order: string[] = [];
    const timers = fakeTimers();
    const { store } = fakeStore();
    const session = new RunCheckpointSession({
      store: { ...store, releaseRunLock: async () => { order.push(`release cleared=${String(timers.created[0]?.cleared)}`); } },
      now: () => STARTED_AT_MS,
      createLockHost: lockHost,
      timers: timers.timers,
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await session.finish(sampleRunCheckpoint({ state: 'FINISHED' }));

    expect(order).toEqual(['release cleared=true']);
  });

  it('waits for a heartbeat write in progress before releasing the lock (the write must not recreate the released lock)', async () => {
    const writing = deferred();
    const { session, calls, timers } = createSession({ rewriteRunLock: async () => writing.promise });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    timers.tick();
    await flush();

    const finished = session.finish(sampleRunCheckpoint({ state: 'FINISHED' }));
    await flush();
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'writeCheckpointState']);

    writing.resolve();
    await finished;
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'writeCheckpointState', 'releaseRunLock']);
  });

  it('keeps the lock and stops the heartbeat when the final state cannot be written', async () => {
    const failure = new Error('final state write failed');
    const { session, calls, timers } = createSession({ writeCheckpointState: async () => Promise.reject(failure) });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await expect(session.finish(sampleRunCheckpoint({ state: 'FINISHED' }))).rejects.toBe(failure);

    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'writeCheckpointState']);
    expect(timers.created[0]?.cleared).toBe(true);
  });

  it('passes on the failure of releasing the lock after stopping the heartbeat', async () => {
    const failure = new Error('lock release failed');
    const { session, timers } = createSession({ releaseRunLock: async () => Promise.reject(failure) });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await expect(session.finish(sampleRunCheckpoint({ state: 'FINISHED' }))).rejects.toBe(failure);
    expect(timers.created[0]?.cleared).toBe(true);
  });

  it('abandons by stopping the heartbeat without releasing the lock (the state stays IN_PROGRESS for a resume)', async () => {
    const { session, calls, timers } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    await session.saveState(sampleRunCheckpoint());

    await expect(session.abandon()).resolves.toBeUndefined();

    expect(timers.created[0]?.cleared).toBe(true);
    timers.created[0]?.callback();
    await flush();
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'writeCheckpointState']);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    // 2回目のやめる操作は、何もしない。
    await expect(session.abandon()).resolves.toBeUndefined();
  });

  it('waits for a heartbeat write in progress when it is abandoned, and never rejects', async () => {
    const writing = deferred();
    const { session, timers } = createSession({ rewriteRunLock: async () => writing.promise });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    timers.tick();

    let abandoned = false;
    const abandoning = session.abandon().then(() => {
      abandoned = true;
    });
    await flush();
    expect(abandoned).toBe(false);

    writing.reject(new Error('heartbeat write failed'));
    await abandoning;
    expect(abandoned).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R4a2a: 再開のときの始め方（設計書 4.4、4.5）
// ---------------------------------------------------------------------------------------------------------------

/** 前の回のロックを取った、別のプロセスの ID。 */
const OTHER_PROCESS_ID = 8_765;
/** 再開する保存の、終わったページの ID。 */
const COMPLETED_PAGE_IDS: readonly PageId[] = Object.freeze([PAGE_1]);
/** 後始末で消したもの（偽の書き手が返す、Run のディレクトリからの相対パス）。 */
const REMOVED_PATHS: readonly string[] = Object.freeze([`pages/${PAGE_2}`, `checkpoint/pages/${PAGE_2}.json`]);

/** 再開の始め方の指定。 */
const resume = (completedPageIds: readonly PageId[] = COMPLETED_PAGE_IDS): RunCheckpointSessionStartOptions =>
  Object.freeze({ mode: 'RESUME', completedPageIds });

/**
 * 前の回のロック。既定は、別のプロセスが、今と同じ OS の起動の時刻で取り、ハートビートが1分前のもの（そのプロセスが動いていれば、
 * 動いている Run のもの）。
 */
const previousLock = (overrides: Partial<RunLock> = {}): RunLock => Object.freeze({
  processId: OTHER_PROCESS_ID,
  bootedAtMs: BOOTED_AT_MS,
  acquiredAtMs: STARTED_AT_MS - 2 * RUN_LOCK_STALE_AFTER_MS,
  heartbeatAtMs: STARTED_AT_MS - RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  ...overrides,
});

/** すでにあったロックを返す、ロックの作成の差し替え。 */
const lockExists = (existing: unknown): Pick<RunCheckpointStore, 'acquireRunLock'> => ({
  acquireRunLock: async () => ({ acquired: false, existing }),
});

describe('R4a2a: starting the checkpoint session of a resumed Run (design 4.4, 4.5)', () => {
  it('has the closed list of the reasons why a resume does not start', () => {
    expect(RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS).toEqual(['LOCK_HELD_BY_ACTIVE_RUN', 'LOCK_TAKEN_OVER_CONCURRENTLY']);
    expect(Object.isFrozen(RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS)).toBe(true);
  });

  it('creates the lock when there is none, cleans up the run directory before the heartbeat, and then starts the heartbeat', async () => {
    let timersAtCleanUp = -1;
    const { session, calls, clock, timers } = createSession({
      cleanUpForResume: async () => {
        timersAtCleanUp = timers.created.length;
        return REMOVED_PATHS;
      },
    });
    const lock = createRunLock(lockHost(STARTED_AT_MS));

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({ ok: true, removedPaths: REMOVED_PATHS });

    expect(calls).toEqual([
      { kind: 'acquireRunLock', runDirectory: RUN_DIRECTORY, lock },
      { kind: 'cleanUpForResume', runDirectory: RUN_DIRECTORY, completedPageIds: COMPLETED_PAGE_IDS },
    ]);
    expect(timersAtCleanUp).toBe(0);
    expect(timers.created).toHaveLength(1);
    expect(timers.created[0]?.intervalMs).toBe(RUN_LOCK_HEARTBEAT_INTERVAL_MS);
    expect(timers.created[0]?.unref).toHaveBeenCalledOnce();

    // 始めた後は、新しい Run と同じく、ハートビートと保存を行う。
    clock.nowMs = STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS;
    timers.tick();
    await flush();
    expect(calls.at(-1)).toEqual({
      kind: 'rewriteRunLock',
      runDirectory: RUN_DIRECTORY,
      lock: renewRunLock(lock, STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS),
    });
    await expect(session.saveState(sampleRunCheckpoint({ startPageFinished: true }))).resolves.toBeUndefined();
  });

  it('fails without rewriting the lock, cleaning up or starting the heartbeat when the lock belongs to a running Run', async () => {
    const existing = previousLock();
    const isProcessRunning = vi.fn((processId: number) => processId === OTHER_PROCESS_ID);
    const { session, calls, timers } = createSession(lockExists(existing), { isProcessRunning });

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({
      ok: false,
      reason: 'LOCK_HELD_BY_ACTIVE_RUN',
      existingLock: existing,
    });

    expect(isProcessRunning).toHaveBeenCalledWith(OTHER_PROCESS_ID);
    expect(kindsOf(calls)).toEqual(['acquireRunLock']);
    expect(timers.created).toEqual([]);
    // 始められなかったセッションでは、保存しない。
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    expect(kindsOf(calls)).toEqual(['acquireRunLock']);
  });

  it('judges the lock with isProcessRunning when no process check is given', async () => {
    // このプロセスが取ったロック（今の OS の起動の時刻で、ハートビートは1分前）。このプロセスは動いているので、動いている Run のもの。
    const existing = previousLock({ processId: process.pid });
    const { store, calls } = fakeStore(lockExists(existing));
    const timers = fakeTimers();
    const session = new RunCheckpointSession({ store, now: () => STARTED_AT_MS, createLockHost: lockHost, timers: timers.timers });

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({
      ok: false,
      reason: 'LOCK_HELD_BY_ACTIVE_RUN',
      existingLock: existing,
    });
    expect(kindsOf(calls)).toEqual(['acquireRunLock']);
    expect(timers.created).toEqual([]);
  });

  it.each([
    [
      'the OS has been restarted since (another boot time, even with the process ID of a running process)',
      previousLock({ processId: PROCESS_ID, bootedAtMs: BOOTED_AT_MS - RUN_LOCK_BOOT_TIME_TOLERANCE_MS - 1 }),
      true,
    ],
    ['the process of the lock is not running', previousLock(), false],
    ['the heartbeat of the lock is older than the limit', previousLock({ heartbeatAtMs: STARTED_AT_MS - RUN_LOCK_STALE_AFTER_MS - 1 }), true],
    ['the lock could not be read as JSON', null, true],
  ] as const)('takes over the stale lock when %s: rewrites it, reads it back, cleans up, and then starts the heartbeat', async (
    _case,
    existing,
    running,
  ) => {
    let timersAtCleanUp = -1;
    const { session, calls, clock, timers } = createSession({
      ...lockExists(existing),
      cleanUpForResume: async () => {
        timersAtCleanUp = timers.created.length;
        return REMOVED_PATHS;
      },
    }, { isProcessRunning: () => running });
    const lock = createRunLock(lockHost(STARTED_AT_MS));

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({ ok: true, removedPaths: REMOVED_PATHS });

    expect(calls).toEqual([
      { kind: 'acquireRunLock', runDirectory: RUN_DIRECTORY, lock },
      { kind: 'rewriteRunLock', runDirectory: RUN_DIRECTORY, lock },
      { kind: 'readRunLock', runDirectory: RUN_DIRECTORY },
      { kind: 'cleanUpForResume', runDirectory: RUN_DIRECTORY, completedPageIds: COMPLETED_PAGE_IDS },
    ]);
    expect(timersAtCleanUp).toBe(0);
    expect(timers.created).toHaveLength(1);
    expect(timers.created[0]?.unref).toHaveBeenCalledOnce();
    // ハートビートは、作り直した自分のロックを更新する。
    clock.nowMs = STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS;
    timers.tick();
    await flush();
    expect(calls.at(-1)).toEqual({
      kind: 'rewriteRunLock',
      runDirectory: RUN_DIRECTORY,
      lock: renewRunLock(lock, STARTED_AT_MS + RUN_LOCK_HEARTBEAT_INTERVAL_MS),
    });
  });

  it.each([
    ['another process rewrote it at the same time', { ...createRunLock(lockHost(STARTED_AT_MS)), processId: OTHER_PROCESS_ID }],
    ['it was taken at another time', { ...createRunLock(lockHost(STARTED_AT_MS)), acquiredAtMs: STARTED_AT_MS + 1 }],
    ['it is gone or cannot be read as JSON', null],
  ] as const)('fails without touching the lock again, cleaning up or starting the heartbeat when the lock read back is not its own: %s', async (
    _case,
    readBack,
  ) => {
    const { session, calls, timers } = createSession({
      ...lockExists(previousLock()),
      readRunLock: async () => readBack,
    }, { isProcessRunning: () => false });

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({
      ok: false,
      reason: 'LOCK_TAKEN_OVER_CONCURRENTLY',
      existingLock: readBack,
    });

    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'readRunLock']);
    expect(timers.created).toEqual([]);
    timers.tick();
    await flush();
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    await expect(session.abandon()).resolves.toBeUndefined();
    // ロックは相手のもののまま（書き換えも、消すこともしない）。
    expect(kindsOf(calls)).toEqual(['acquireRunLock', 'rewriteRunLock', 'readRunLock']);
  });

  it.each([
    ['rewriting the stale lock', 'rewriteRunLock', ['acquireRunLock', 'rewriteRunLock']],
    ['reading the lock back', 'readRunLock', ['acquireRunLock', 'rewriteRunLock', 'readRunLock']],
    ['cleaning up the run directory', 'cleanUpForResume', ['acquireRunLock', 'rewriteRunLock', 'readRunLock', 'cleanUpForResume']],
  ] as const)('passes on the failure of the store in %s, and starts no heartbeat', async (_case, operation, expectedKinds) => {
    const failure = new Error(`${operation} failed`);
    const { session, calls, timers } = createSession({
      ...lockExists(previousLock()),
      [operation]: async () => Promise.reject(failure),
    }, { isProcessRunning: () => false });

    await expect(session.start(RUN_DIRECTORY, resume())).rejects.toBe(failure);

    expect(kindsOf(calls)).toEqual(expectedKinds);
    expect(timers.created).toEqual([]);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
  });

  it('rejects a resume without the list of completed page IDs, or with a malformed page ID, before touching the lock', async () => {
    const { session, calls } = createSession();

    await expect(session.start(RUN_DIRECTORY, { mode: 'RESUME' } as unknown as RunCheckpointSessionStartOptions)).rejects.toThrow(TypeError);
    await expect(session.start(RUN_DIRECTORY, resume(['../x' as PageId]))).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);

    await expect(session.start(RUN_DIRECTORY, resume([]))).resolves.toEqual({ ok: true, removedPaths: [] });
    await expect(session.start(RUN_DIRECTORY, resume())).rejects.toThrow(/already/u);
  });

  it('rejects a process check that is not a function, and a store without the operations of a resume, with TypeError', () => {
    const { store } = fakeStore();
    const valid: RunCheckpointSessionOptions = { store, now: () => STARTED_AT_MS };
    const invalid: unknown[] = [
      { ...valid, isProcessRunning: true },
      { ...valid, store: { ...store, readRunLock: undefined } },
      { ...valid, store: { ...store, cleanUpForResume: undefined } },
    ];
    for (const options of invalid) {
      expect(() => new RunCheckpointSession(options as RunCheckpointSessionOptions)).toThrow(TypeError);
    }
    expect(() => new RunCheckpointSession({ ...valid, isProcessRunning: () => true })).not.toThrow();
  });
});
