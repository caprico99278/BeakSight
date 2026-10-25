// T35b（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限を数える部品（`src/crawl/service-request-budget.ts`）。
// - DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、2.3）: 要求を断るのは、実行の数が実行の上限（`perRun`）に届いた後だけ。
//   1 分あたりの上限（`perMinute`）では断らない（ページの読み込みの途中で止めない）。代わりに、次の読み込みの前に待つ時間（`waitBeforeNextLoadMs`）を
//   返す。直近 60 秒（`LOAD_PEAK_WINDOW_MS`。負荷の 1 分あたりの最大と同じ窓）に数えた数が `perMinute` 以上なら、窓の中の数が `perMinute` を下回るまでの
//   時間（最大で 60 秒）。断った要求は数えない。
// - 上限に届いたか（`isLimitReached`）: 断った要求があるか、実行の上限まで使ったか。Run が次のページを始めない判断に使う（T35c）。
// - 時計が戻っても、窓は戻る前の最後の時刻を基準にする（負荷の部品と同じ）。待つ時間も 60 秒を超えない。
import { describe, expect, it } from 'vitest';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';

class FakeClock {
  nowMs = 1_000_000;
  readonly now = (): number => this.nowMs;
}

const consumeTimes = (budget: { tryConsume(): boolean }, count: number): readonly boolean[] =>
  Array.from({ length: count }, () => budget.tryConsume());

describe('T35b: the budget of the requests to the approved service origins', () => {
  // DEF-141 で意図して直した期待: 前は、1 分あたりの上限で 4 つめの要求を断った（ページの読み込みの途中で止めた）。
  it('does not refuse a request by the per minute limit (DEF-141), and does not reach the limit by it', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now });
    expect(consumeTimes(budget, 10)).toEqual(Array.from({ length: 10 }, () => true));
    expect(budget.isLimitReached()).toBe(false);
    expect(budget.snapshot()).toEqual({ admitted: 10, refused: 0, limitReached: false });
  });

  it('refuses every request after the per run limit, even after the window', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 10, perRun: 2, now: clock.now });
    expect(budget.isLimitReached()).toBe(false);
    expect(consumeTimes(budget, 2)).toEqual([true, true]);
    // 実行の上限まで使った時点で、上限に届いた（次の要求を送れない）。
    expect(budget.isLimitReached()).toBe(true);
    clock.nowMs += LOAD_PEAK_WINDOW_MS * 10;
    expect(budget.tryConsume()).toBe(false);
    expect(budget.snapshot()).toEqual({ admitted: 2, refused: 1, limitReached: true });
  });

  it('refuses by the per run limit counted from the earlier executions, regardless of the per minute limit', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 1, perRun: 5, now: clock.now, initialAdmitted: 3 });
    expect(consumeTimes(budget, 3)).toEqual([true, true, false]);
    expect(budget.snapshot()).toEqual({ admitted: 5, refused: 1, limitReached: true });
  });

  it('does not reach the limit while the requests stay under both limits', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 2, perRun: 10, now: clock.now });
    for (let round = 0; round < 3; round += 1) {
      expect(consumeTimes(budget, 2)).toEqual([true, true]);
      clock.nowMs += LOAD_PEAK_WINDOW_MS;
    }
    expect(budget.snapshot()).toEqual({ admitted: 6, refused: 0, limitReached: false });
  });

  it.each([
    ['a zero per minute limit', { perMinute: 0, perRun: 1 }],
    ['a fractional per run limit', { perMinute: 1, perRun: 1.5 }],
    ['a negative limit', { perMinute: -1, perRun: 1 }],
  ])('rejects %s', (_label, limits) => {
    expect(() => createServiceRequestBudget({ ...limits, now: () => 0 })).toThrow(RangeError);
  });

  it('rejects a clock that does not return milliseconds', () => {
    const budget = createServiceRequestBudget({ perMinute: 1, perRun: 1, now: () => Number.NaN });
    expect(() => budget.tryConsume()).toThrow(RangeError);
    expect(() => budget.waitBeforeNextLoadMs()).toThrow(RangeError);
  });
});

describe('DEF-141: the wait before the next load by the per minute limit', () => {
  it('does not wait while the requests in the last minute are under the per minute limit', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now });
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
    consumeTimes(budget, 2);
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
  });

  it('waits until the oldest request in the window passes one minute when the window is at the limit', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 2, perRun: 100, now: clock.now });
    budget.tryConsume();
    clock.nowMs += 10_000;
    budget.tryConsume();
    clock.nowMs += 5_000;
    // 窓の中の最も古い要求（15 秒前）が 1 分を過ぎるまで。
    expect(budget.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS - 15_000);
    clock.nowMs += LOAD_PEAK_WINDOW_MS - 15_000;
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
  });

  it('waits until the count in the window falls under the limit when one load sent more than the limit (at most one minute)', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now });
    // 1 回の読み込みで、上限の 3 倍を、1 秒ごとに出した（断らない）。
    for (let index = 0; index < 9; index += 1) {
      expect(budget.tryConsume()).toBe(true);
      clock.nowMs += 1_000;
    }
    // 窓の中の 9 件のうち、新しい方から 3 件目（6 秒前に送った）が窓を出れば、窓の中の数は 2 になる。
    const waitMs = budget.waitBeforeNextLoadMs();
    expect(waitMs).toBe(LOAD_PEAK_WINDOW_MS - 3_000);
    expect(waitMs).toBeLessThanOrEqual(LOAD_PEAK_WINDOW_MS);
    clock.nowMs += waitMs;
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
    budget.tryConsume();
    expect(budget.waitBeforeNextLoadMs()).toBeGreaterThan(0);
  });

  it('waits a whole minute at most when all the requests were sent just now', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 2, perRun: 100, now: clock.now });
    consumeTimes(budget, 50);
    expect(budget.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS);
  });

  it('counts the window from the last time when the clock goes back, and waits a minute at most', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 2, perRun: 10, now: clock.now });
    expect(consumeTimes(budget, 2)).toEqual([true, true]);
    clock.nowMs -= LOAD_PEAK_WINDOW_MS * 2;
    expect(budget.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS);
    // 戻った時計でも断らない（1 分あたりの上限では断らない）。窓は戻る前の最後の時刻のまま。
    expect(budget.tryConsume()).toBe(true);
    expect(budget.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS);
    clock.nowMs += LOAD_PEAK_WINDOW_MS * 3;
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
  });

  it('does not wait for the requests of the earlier executions (the window is new in each execution)', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 1, perRun: 100, now: clock.now, initialAdmitted: 50 });
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
  });
});

// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の間で、1 分の窓を持ち越す（実行の上限は段ごとに数える）。
describe('FM2d: the per minute window carried over between the stages of a chain', () => {
  it('exposes the times of the window (oldest first, only the last minute)', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now });
    budget.tryConsume();
    clock.nowMs += 10_000;
    budget.tryConsume();
    expect(budget.windowTimesMs()).toEqual([1_000_000, 1_010_000]);
    clock.nowMs += LOAD_PEAK_WINDOW_MS - 5_000;
    // 最初の要求は窓を出た。
    expect(budget.windowTimesMs()).toEqual([1_010_000]);
    expect(Object.isFrozen(budget.windowTimesMs())).toBe(true);
  });

  it('waits by the carried window, and counts the run limit from zero', () => {
    const clock = new FakeClock();
    const first = createServiceRequestBudget({ perMinute: 2, perRun: 2, now: clock.now });
    expect(consumeTimes(first, 2)).toEqual([true, true]);
    expect(first.isLimitReached()).toBe(true);
    clock.nowMs += 1_000;
    const second = createServiceRequestBudget({ perMinute: 2, perRun: 2, now: clock.now, initialWindowTimesMs: first.windowTimesMs() });
    // 窓は持ち越すので、前の段の 2 件が 1 分を過ぎるまで待つ。
    expect(second.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS - 1_000);
    // 実行の上限は段ごと（前の段の数は数えない）。
    expect(second.isLimitReached()).toBe(false);
    expect(second.snapshot()).toEqual({ admitted: 0, refused: 0, limitReached: false });
    clock.nowMs += LOAD_PEAK_WINDOW_MS;
    expect(second.waitBeforeNextLoadMs()).toBe(0);
  });

  it('combines the carried window with the new requests', () => {
    const clock = new FakeClock();
    const second = createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now, initialWindowTimesMs: [990_000, 995_000] });
    expect(second.waitBeforeNextLoadMs()).toBe(0);
    second.tryConsume();
    // 窓の 3 件（持ち越した 2 件と新しい 1 件）。最も古いものが出るまで待つ。
    expect(second.waitBeforeNextLoadMs()).toBe(990_000 + LOAD_PEAK_WINDOW_MS - 1_000_000);
  });

  it('drops the carried times outside the window, and rejects a malformed window', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({
      perMinute: 3, perRun: 100, now: clock.now, initialWindowTimesMs: [1_000_000 - LOAD_PEAK_WINDOW_MS - 1, 999_000],
    });
    expect(budget.windowTimesMs()).toEqual([999_000]);
    expect(() => createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now, initialWindowTimesMs: [2, 1] })).toThrow(RangeError);
    expect(() => createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now, initialWindowTimesMs: [-1] })).toThrow(RangeError);
    expect(() => createServiceRequestBudget({ perMinute: 3, perRun: 100, now: clock.now, initialWindowTimesMs: 'x' as never })).toThrow(TypeError);
  });
});
