// T35b（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求を数える部品（`src/crawl/service-request-budget.ts`）。
// - L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。ユーザーの判断「要求の上限…は基本方針に反する。削除以外は全て通せ」）: 1 分あたりの上限で
//   待つこと（DEF-141 の 600 件）と、1 回の Run の上限で断る・止めること（10,000 件）を撤廃した。この部品は要求を数えるだけで、断らず、待つ時間も返さず、
//   上限に届いたとも言わない。LZ-3c: 上限の値（前の `perMinute`・`perRun`）も受けない（前の「値の形を確かめる」場面は捨てた）。
//   前の期待（上限で断る・待つ）は、この決まりに合わせて直した。
// - 数えた数（`admitted`）と、まとめて実行で持ち越す 1 分の窓の時刻（`windowTimesMs`。FM2d）は、記録として今のまま持つ。
import { describe, expect, it } from 'vitest';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';

class FakeClock {
  nowMs = 1_000_000;
  readonly now = (): number => this.nowMs;
}

const consumeTimes = (budget: { tryConsume(): boolean }, count: number): readonly boolean[] =>
  Array.from({ length: count }, () => budget.tryConsume());

describe('L11: the requests to the approved service origins are counted, never refused, and never make the run wait', () => {
  it('admits every request and never reaches a limit, counting from the earlier executions', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ now: clock.now, initialAdmitted: 5 });
    expect(consumeTimes(budget, 50)).toEqual(Array.from({ length: 50 }, () => true));
    expect(budget.snapshot()).toEqual({ admitted: 55, refused: 0, limitReached: false });
  });

  it('never asks to wait before the next load, even after many requests in one minute', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ now: clock.now });
    consumeTimes(budget, 1_000);
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
    clock.nowMs -= LOAD_PEAK_WINDOW_MS * 2;
    expect(budget.waitBeforeNextLoadMs()).toBe(0);
    const carried = createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: budget.windowTimesMs() });
    expect(carried.waitBeforeNextLoadMs()).toBe(0);
  });

  it('rejects a clock that does not return milliseconds', () => {
    const budget = createServiceRequestBudget({ now: () => Number.NaN });
    expect(() => budget.tryConsume()).toThrow(RangeError);
  });
});

// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の間で、1 分の窓の時刻を持ち越す（記録として）。
describe('FM2d: the per minute window carried over between the stages of a chain', () => {
  it('exposes the times of the window (oldest first, only the last minute)', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ now: clock.now });
    budget.tryConsume();
    clock.nowMs += 10_000;
    budget.tryConsume();
    expect(budget.windowTimesMs()).toEqual([1_000_000, 1_010_000]);
    clock.nowMs += LOAD_PEAK_WINDOW_MS - 5_000;
    // 最初の要求は窓を出た。
    expect(budget.windowTimesMs()).toEqual([1_010_000]);
    expect(Object.isFrozen(budget.windowTimesMs())).toBe(true);
  });

  it('keeps every request of the last minute in the window', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: [990_000, 995_000] });
    consumeTimes(budget, 3);
    expect(budget.windowTimesMs()).toEqual([990_000, 995_000, 1_000_000, 1_000_000, 1_000_000]);
    expect(budget.snapshot()).toEqual({ admitted: 3, refused: 0, limitReached: false });
  });

  it('drops the carried times outside the window, and rejects a malformed window', () => {
    const clock = new FakeClock();
    const budget = createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: [1_000_000 - LOAD_PEAK_WINDOW_MS - 1, 999_000] });
    expect(budget.windowTimesMs()).toEqual([999_000]);
    expect(() => createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: [2, 1] })).toThrow(RangeError);
    expect(() => createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: [-1] })).toThrow(RangeError);
    expect(() => createServiceRequestBudget({ now: clock.now, initialWindowTimesMs: 'x' as never })).toThrow(TypeError);
  });
});
