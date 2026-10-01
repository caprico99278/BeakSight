// L2（サイトへの負荷の制御の設計書 4.1、第7章）: ページの読み込みの間隔を守る部品 `NavigationPacer`。
// 時刻と待ちを注入し、実際には待たずに確かめる。待ちは、偽の時計の予約として扱い、テストが時刻の順に終わらせる。
// L2-fix-round-1: 1回の呼び出しの待ちの上限（時計が戻った場合）と、`sleep` を呼ぶ回数の上限（時計が進まない場合）。
import { describe, expect, it } from 'vitest';
import {
  createNavigationPacer,
  MAX_SLEEPS_PER_NAVIGATION,
  type NavigationPacer,
  type NavigationPacerSnapshot,
} from '../../src/crawl/navigation-pacer.js';

const START_MS = 1_000_000;
const INTERVAL_MS = 5_000;
/** 時計が大きく戻る場合の戻り幅（10分。`START_MS` より小さくして、戻った後の時刻を 0 以上に保つ）。 */
const LARGE_CLOCK_SET_BACK_MS = 10 * 60 * 1_000;
/** 時計が少しだけ戻る場合の戻り幅（間隔より短い）。 */
const SMALL_CLOCK_SET_BACK_MS = 2_000;
/**
 * 1回の呼び出しで `sleep` が呼ばれる回数が、これを超えたら偽の `sleep` が例外を投げる（上限の定数より十分に多い回数）。
 * 待ちをやめない実装でも、Promise の鎖が回り続けてテストが止まるのではなく、失敗として観察できるようにするため。
 * 上限の定数そのものからは作らない（定数がない実装でも、この見張りは働く必要がある）。
 */
const RUNAWAY_SLEEP_COUNT = 100;

/**
 * 偽の時計。`sleep(ms)` は、今の時刻から `ms` 後に終わる予約を作る（同時に始めた待ちは、同じ時刻に終わる）。
 * `settle` は、渡した Promise が決まるまで、予約を時刻の順に終わらせる。`earlyMs` を指定すると、次の1回の待ちだけ、
 * 指定より `earlyMs` だけ早く終わる（タイマーが早く発火する場合を表す）。
 */
class FakeTime {
  nowMs = START_MS;
  readonly sleeps: number[] = [];
  earlyMs = 0;
  readonly #timers: { readonly atMs: number; readonly resolve: () => void }[] = [];

  readonly now = (): number => this.nowMs;

  readonly sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    const earlyMs = this.earlyMs;
    this.earlyMs = 0;
    return new Promise<void>((resolve) => {
      this.#timers.push({ atMs: this.nowMs + ms - earlyMs, resolve });
    });
  };

  advance(ms: number): void {
    this.nowMs += ms;
  }

  async settle<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const observed = promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (;;) {
      await flush();
      if (settled) {
        await observed;
        return promise;
      }
      this.#timers.sort((left, right) => left.atMs - right.atMs);
      const next = this.#timers.shift();
      if (next === undefined) {
        throw new Error('the promise did not settle and no sleep is pending');
      }
      this.nowMs = Math.max(this.nowMs, next.atMs);
      next.resolve();
    }
  }
}

/** 予約した待ちの後の処理（Promise の鎖）を進める。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function pacerWith(time: FakeTime, minIntervalMs = INTERVAL_MS, initial?: NavigationPacerSnapshot): NavigationPacer {
  return createNavigationPacer({
    minIntervalMs,
    now: time.now,
    sleep: time.sleep,
    ...(initial === undefined ? {} : { initial }),
  });
}

describe('NavigationPacer (load control design 4.1)', () => {
  it('does not wait before the first navigation and records its start', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);

    expect(pacer.snapshot()).toEqual({ navigationCount: 0, totalWaitMs: 0, lastNavigationStartedAtMs: null });
    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(0);

    expect(time.sleeps).toEqual([]);
    expect(pacer.snapshot()).toEqual({ navigationCount: 1, totalWaitMs: 0, lastNavigationStartedAtMs: START_MS });
  });

  it('waits only for the rest of the interval when called before it has passed, and records the start after the wait', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    await time.settle(pacer.beforeNavigation());
    time.advance(1_200);

    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(3_800);

    expect(time.sleeps).toEqual([3_800]);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 2,
      totalWaitMs: 3_800,
      lastNavigationStartedAtMs: START_MS + INTERVAL_MS,
    });
  });

  it.each([INTERVAL_MS, INTERVAL_MS + 1_000])('does not wait when %i ms have passed since the previous start', async (elapsedMs) => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    await time.settle(pacer.beforeNavigation());
    time.advance(elapsedMs);

    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(0);

    expect(time.sleeps).toEqual([]);
    expect(pacer.snapshot()).toEqual({ navigationCount: 2, totalWaitMs: 0, lastNavigationStartedAtMs: START_MS + elapsedMs });
  });

  it('counts the navigations and sums the waits', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    const waits: number[] = [];
    for (const elapsedMs of [0, 1_000, 6_000, 4_999]) {
      time.advance(elapsedMs);
      waits.push(await time.settle(pacer.beforeNavigation()));
    }

    expect(waits).toEqual([0, 4_000, 0, 1]);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 4,
      totalWaitMs: 4_001,
      // 開始: 0、5,000、11,000、16,000（待った後）。
      lastNavigationStartedAtMs: START_MS + 16_000,
    });
  });

  it('keeps the interval in the order of the calls when calls overlap', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    const starts: number[] = [];
    const call = async (): Promise<number> => {
      const waited = await pacer.beforeNavigation();
      starts.push(pacer.snapshot().lastNavigationStartedAtMs ?? Number.NaN);
      return waited;
    };

    // 前の呼び出しが終わる前に、3回呼ぶ。
    const calls = Promise.all([call(), call(), call()]);
    await expect(time.settle(calls)).resolves.toEqual([0, INTERVAL_MS, INTERVAL_MS]);

    expect(starts).toEqual([START_MS, START_MS + INTERVAL_MS, START_MS + 2 * INTERVAL_MS]);
    expect(time.sleeps).toEqual([INTERVAL_MS, INTERVAL_MS]);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 3,
      totalWaitMs: 2 * INTERVAL_MS,
      lastNavigationStartedAtMs: START_MS + 2 * INTERVAL_MS,
    });
  });

  it('waits again for the rest when the wait ends before the interval has passed', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    await time.settle(pacer.beforeNavigation());
    // タイマーが 3ms 早く発火する。
    time.earlyMs = 3;

    const waited = await time.settle(pacer.beforeNavigation());

    // 1回目の待ちは 3ms 早く終わるので、残りの 3ms を待ち直す。
    expect(time.sleeps).toEqual([INTERVAL_MS, 3]);
    expect(waited).toBe(INTERVAL_MS);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 2,
      totalWaitMs: INTERVAL_MS,
      lastNavigationStartedAtMs: START_MS + INTERVAL_MS,
    });
  });

  it.each([LARGE_CLOCK_SET_BACK_MS, SMALL_CLOCK_SET_BACK_MS])(
    'waits no longer than the interval from the call when the clock has gone back %i ms before the previous start',
    async (setBackMs) => {
      const time = new FakeTime();
      const pacer = pacerWith(time);
      await time.settle(pacer.beforeNavigation());
      // 時計が後ろに戻る（利用者が時刻を直した、OS が時刻を合わせ直した、など）。
      const calledAtMs = START_MS - setBackMs;
      time.nowMs = calledAtMs;

      const waited = await time.settle(pacer.beforeNavigation());

      // 戻った分は待たず、呼ばれた時刻から間隔の分だけ待つ。
      expect(time.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(INTERVAL_MS);
      expect(time.sleeps).toEqual([INTERVAL_MS]);
      expect(waited).toBe(INTERVAL_MS);
      expect(pacer.snapshot()).toEqual({
        navigationCount: 2,
        totalWaitMs: INTERVAL_MS,
        lastNavigationStartedAtMs: calledAtMs + INTERVAL_MS,
      });
    },
  );

  it('passes no more than the interval to every sleep when the clock goes back during the first sleep (L2-fix-round-2)', async () => {
    let nowMs = START_MS;
    const sleeps: number[] = [];
    const pacer = createNavigationPacer({
      minIntervalMs: INTERVAL_MS,
      now: () => nowMs,
      // 待った分だけ時計が進む。ただし、1回目の待ちの途中で、時計が大きく戻る。
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        if (sleeps.length === 1) {
          nowMs -= LARGE_CLOCK_SET_BACK_MS;
        }
      },
    });
    await pacer.beforeNavigation();

    const waited = await pacer.beforeNavigation();

    // どの回の待ちも間隔以下に切り詰め、上限の回数で待ちをやめる。戻った分（10分）を待ち直さない。
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(INTERVAL_MS);
    expect(sleeps).toEqual(Array.from({ length: MAX_SLEEPS_PER_NAVIGATION }, () => INTERVAL_MS));
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAX_SLEEPS_PER_NAVIGATION * INTERVAL_MS);
    const startedAtMs = START_MS + MAX_SLEEPS_PER_NAVIGATION * INTERVAL_MS - LARGE_CLOCK_SET_BACK_MS;
    // 開始の時刻は呼ばれた時刻より前（時計が戻った）なので、待った時間は 0 と記録する。
    expect(waited).toBe(0);
    expect(pacer.snapshot()).toEqual({ navigationCount: 2, totalWaitMs: 0, lastNavigationStartedAtMs: startedAtMs });
  });

  it('stops waiting after the maximum number of sleeps when the clock does not advance, and records the time then as the start', async () => {
    const sleeps: number[] = [];
    const pacer = createNavigationPacer({
      minIntervalMs: INTERVAL_MS,
      // 時計が進まない（偽の時計と、すぐに終わる待ちを組み合わせた場合）。
      now: () => START_MS,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length > RUNAWAY_SLEEP_COUNT) {
          throw new Error(`sleep was called more than ${RUNAWAY_SLEEP_COUNT} times in one navigation`);
        }
      },
    });
    await pacer.beforeNavigation();

    await expect(pacer.beforeNavigation()).resolves.toBe(0);

    expect(sleeps).toHaveLength(MAX_SLEEPS_PER_NAVIGATION);
    expect(sleeps).toEqual(Array.from({ length: MAX_SLEEPS_PER_NAVIGATION }, () => INTERVAL_MS));
    expect(pacer.snapshot()).toEqual({ navigationCount: 2, totalWaitMs: 0, lastNavigationStartedAtMs: START_MS });
  });

  it('stops waiting after the maximum number of sleeps when every sleep ends early, and records the time then as the start', async () => {
    let nowMs = START_MS;
    const sleeps: number[] = [];
    const pacer = createNavigationPacer({
      minIntervalMs: INTERVAL_MS,
      now: () => nowMs,
      // どの待ちも、指定の半分（切り上げ）で終わる（タイマーが早く発火し続ける場合）。
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length > RUNAWAY_SLEEP_COUNT) {
          throw new Error(`sleep was called more than ${RUNAWAY_SLEEP_COUNT} times in one navigation`);
        }
        nowMs += Math.ceil(ms / 2);
      },
    });
    await pacer.beforeNavigation();

    const waited = await pacer.beforeNavigation();

    // 待ち直すたびに、残りを指定する。上限の回数で、目標に届いていなくても待ちをやめる。
    const expectedSleeps: number[] = [];
    let expectedNowMs = START_MS;
    for (let index = 0; index < MAX_SLEEPS_PER_NAVIGATION; index += 1) {
      const remainingMs = START_MS + INTERVAL_MS - expectedNowMs;
      expectedSleeps.push(remainingMs);
      expectedNowMs += Math.ceil(remainingMs / 2);
    }
    expect(sleeps).toEqual(expectedSleeps);
    expect(expectedNowMs).toBeLessThan(START_MS + INTERVAL_MS);
    expect(waited).toBe(expectedNowMs - START_MS);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 2,
      totalWaitMs: expectedNowMs - START_MS,
      lastNavigationStartedAtMs: expectedNowMs,
    });
  });

  it('never sleeps when the interval is 0', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time, 0);

    for (let index = 0; index < 3; index += 1) {
      await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(0);
    }

    expect(time.sleeps).toEqual([]);
    expect(pacer.snapshot()).toEqual({ navigationCount: 3, totalWaitMs: 0, lastNavigationStartedAtMs: START_MS });
  });

  it('continues from the initial record and keeps the interval from its last start (resume)', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time, INTERVAL_MS, {
      navigationCount: 7,
      totalWaitMs: 12_000,
      lastNavigationStartedAtMs: START_MS - 1_000,
    });

    expect(pacer.snapshot()).toEqual({ navigationCount: 7, totalWaitMs: 12_000, lastNavigationStartedAtMs: START_MS - 1_000 });
    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(4_000);

    expect(time.sleeps).toEqual([4_000]);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 8,
      totalWaitMs: 16_000,
      lastNavigationStartedAtMs: START_MS + 4_000,
    });
  });

  it('does not wait before the first navigation when the initial record has no last start', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time, INTERVAL_MS, { navigationCount: 0, totalWaitMs: 0, lastNavigationStartedAtMs: null });

    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(0);
    expect(time.sleeps).toEqual([]);
  });

  it('returns a frozen snapshot', async () => {
    const time = new FakeTime();
    const pacer = pacerWith(time);
    await time.settle(pacer.beforeNavigation());

    expect(Object.isFrozen(pacer.snapshot())).toBe(true);
  });

  it('does not record a navigation whose wait failed, and keeps pacing the next calls', async () => {
    const time = new FakeTime();
    let failNext = false;
    const pacer = createNavigationPacer({
      minIntervalMs: INTERVAL_MS,
      now: time.now,
      sleep: async (ms) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected sleep failure');
        }
        await time.sleep(ms);
      },
    });
    await time.settle(pacer.beforeNavigation());
    failNext = true;

    await expect(time.settle(pacer.beforeNavigation())).rejects.toThrow('injected sleep failure');
    expect(pacer.snapshot()).toEqual({ navigationCount: 1, totalWaitMs: 0, lastNavigationStartedAtMs: START_MS });

    await expect(time.settle(pacer.beforeNavigation())).resolves.toBe(INTERVAL_MS);
    expect(pacer.snapshot()).toEqual({
      navigationCount: 2,
      totalWaitMs: INTERVAL_MS,
      lastNavigationStartedAtMs: START_MS + INTERVAL_MS,
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5000' as unknown as number])(
    'rejects the minimum interval %s with RangeError',
    (minIntervalMs) => {
      const time = new FakeTime();
      expect(() => createNavigationPacer({ minIntervalMs, now: time.now, sleep: time.sleep })).toThrow(RangeError);
    },
  );

  it.each([
    ['a negative navigation count', { navigationCount: -1, totalWaitMs: 0, lastNavigationStartedAtMs: null }],
    ['a fractional navigation count', { navigationCount: 1.5, totalWaitMs: 0, lastNavigationStartedAtMs: null }],
    ['a negative total wait', { navigationCount: 1, totalWaitMs: -1, lastNavigationStartedAtMs: START_MS }],
    ['a non-finite total wait', { navigationCount: 1, totalWaitMs: Number.POSITIVE_INFINITY, lastNavigationStartedAtMs: START_MS }],
    ['a negative last start', { navigationCount: 1, totalWaitMs: 0, lastNavigationStartedAtMs: -1 }],
    ['a NaN last start', { navigationCount: 1, totalWaitMs: 0, lastNavigationStartedAtMs: Number.NaN }],
    ['a missing last start', { navigationCount: 1, totalWaitMs: 0 }],
  ])('rejects an initial record with %s with RangeError', (_label, initial) => {
    const time = new FakeTime();
    expect(() => createNavigationPacer({
      minIntervalMs: INTERVAL_MS,
      now: time.now,
      sleep: time.sleep,
      initial: initial as NavigationPacerSnapshot,
    })).toThrow(RangeError);
  });

  it('rejects an initial record that is not an object, and a clock or a sleep that is not a function, with TypeError', () => {
    const time = new FakeTime();
    const base = { minIntervalMs: INTERVAL_MS, now: time.now, sleep: time.sleep };
    expect(() => createNavigationPacer({ ...base, initial: null as unknown as NavigationPacerSnapshot })).toThrow(TypeError);
    expect(() => createNavigationPacer({ ...base, now: 'now' as unknown as () => number })).toThrow(TypeError);
    expect(() => createNavigationPacer({ ...base, sleep: undefined as unknown as (ms: number) => Promise<void> })).toThrow(TypeError);
  });

  it('rejects the navigation with RangeError when the clock returns a time that is not a non-negative safe integer', async () => {
    const pacer = createNavigationPacer({ minIntervalMs: INTERVAL_MS, now: () => Number.NaN, sleep: async () => undefined });

    await expect(pacer.beforeNavigation()).rejects.toThrow(RangeError);
    expect(pacer.snapshot()).toEqual({ navigationCount: 0, totalWaitMs: 0, lastNavigationStartedAtMs: null });
  });
});
