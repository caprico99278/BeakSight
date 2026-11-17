// P14b（Task 14〜17 の設計書 4.5.7）: 各段階の期限は、ページの期限と「現在の時刻 + 段階の予算」の早い方。
import { describe, expect, it } from 'vitest';
import { OPEN_ENDED_STAGE_MS, openEndedStageDeadline, stageDeadline } from '../../src/orchestration/stage-deadline.js';

describe('stageDeadline', () => {
  it('returns now plus the stage budget when that is earlier than the page deadline', () => {
    expect(stageDeadline(10_000, 1_000, 2_000)).toBe(3_000);
  });

  it('returns the page deadline when now plus the stage budget is later', () => {
    expect(stageDeadline(10_000, 9_000, 2_000)).toBe(10_000);
  });

  it('returns the page deadline when both are equal', () => {
    expect(stageDeadline(3_000, 1_000, 2_000)).toBe(3_000);
  });

  it('returns the page deadline when the stage has no budget of its own (null)', () => {
    expect(stageDeadline(10_000, 1_000, null)).toBe(10_000);
  });

  it('returns the page deadline even when it has already passed', () => {
    expect(stageDeadline(1_000, 5_000, 2_000)).toBe(1_000);
    expect(stageDeadline(1_000, 5_000, null)).toBe(1_000);
  });

  it('accepts a zero stage budget as "now"', () => {
    expect(stageDeadline(10_000, 1_000, 0)).toBe(1_000);
  });

  it.each([
    ['a non-finite page deadline', Number.POSITIVE_INFINITY, 1_000, 2_000],
    ['a NaN page deadline', Number.NaN, 1_000, 2_000],
    ['a non-finite now', 10_000, Number.NaN, 2_000],
    ['a negative stage budget', 10_000, 1_000, -1],
    ['a non-finite stage budget', 10_000, 1_000, Number.POSITIVE_INFINITY],
    ['a NaN stage budget', 10_000, 1_000, Number.NaN],
  ])('throws RangeError for %s', (_label, pageDeadlineAtMs, nowMs, stageBudgetMs) => {
    expect(() => stageDeadline(pageDeadlineAtMs, nowMs, stageBudgetMs)).toThrow(RangeError);
  });

  it('throws RangeError for values that are not numbers', () => {
    expect(() => stageDeadline('10000' as unknown as number, 1_000, 2_000)).toThrow(RangeError);
    expect(() => stageDeadline(10_000, 1_000, '2000' as unknown as number)).toThrow(RangeError);
    expect(() => stageDeadline(10_000, 1_000, undefined as unknown as null)).toThrow(RangeError);
  });

  it('throws RangeError when now plus the stage budget is not finite', () => {
    expect(() => stageDeadline(10_000, Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(RangeError);
  });
});

// L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: 期限を撤廃した段で、期限の数を必ず受け取る部品に渡す値。
describe('openEndedStageDeadline (L1)', () => {
  it('is far beyond any page deadline (the maximum timer delay), and not later than the run time limit', () => {
    expect(OPEN_ENDED_STAGE_MS).toBe(2_147_483_647);
    // LZ-1: Run の時間の上限がないことは、番兵（`Infinity`）でなく、指定なし（省略）で表す。
    expect(openEndedStageDeadline(1_000)).toBe(1_000 + OPEN_ENDED_STAGE_MS);
    expect(openEndedStageDeadline(1_000, undefined)).toBe(1_000 + OPEN_ENDED_STAGE_MS);
    expect(openEndedStageDeadline(1_000, 5_000)).toBe(5_000);
    expect(() => openEndedStageDeadline(Number.NaN, 5_000)).toThrow(RangeError);
  });
});
