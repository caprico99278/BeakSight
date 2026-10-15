// T30g（Task 30 の設計書 2 章のユーザーの判断 3。T30g の Blocker の判断（案 A））: 連続の上限の予定（`execution-grant.ts` の `writeScheduleOf`）。
// - `writeRateRejectionOf` と同じ数え方（`COMMITTED`・`UNKNOWN` で締めた予約。`RELEASED` と締めていない予約は数えない）で、次に書き込める時刻と、
//   24 時間の窓の中の残りの件数を求める。次の時刻では `writeRateRejectionOf` が null になり、その 1 秒前は拒む。
import { describe, expect, it } from 'vitest';
import {
  writeRateRejectionOf,
  writeScheduleOf,
  type RatedWriteReservation,
} from '../../src/control/approval/execution-grant.js';
import { MAX_WRITES_PER_DAY, MIN_WRITE_INTERVAL_MS, WRITE_RATE_WINDOW_MS } from '../../src/control/approval/scenario-contracts.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';

const NOW = new Date(Date.parse('2026-10-13T12:00:00Z'));
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

const settledBefore = (ms: number, state: RatedWriteReservation['state'] = 'COMMITTED'): RatedWriteReservation =>
  ({ state, settledAt: formatCompactUtcTimestamp(new Date(NOW.getTime() - ms), 'test settled time') });

/** 次の時刻で許し、その 1 秒前は拒む。 */
const expectNextIsFirstAllowed = (reservations: readonly RatedWriteReservation[]): void => {
  const { nextWriteAllowedAt } = writeScheduleOf(reservations, NOW);
  expect(nextWriteAllowedAt).not.toBeNull();
  const next = dateOfCompactUtcTimestamp(nextWriteAllowedAt ?? '');
  expect(writeRateRejectionOf(reservations, next)).toBeNull();
  expect(writeRateRejectionOf(reservations, new Date(next.getTime() - SECOND_MS))).not.toBeNull();
};

describe('write schedule (T30g)', () => {
  it('allows a write now with the whole window left when nothing was written', () => {
    expect(writeScheduleOf([], NOW)).toEqual({ nextWriteAllowedAt: null, remainingInWindow: MAX_WRITES_PER_DAY });
    expect(Object.isFrozen(writeScheduleOf([], NOW))).toBe(true);
  });

  it('counts only COMMITTED and UNKNOWN settled reservations, like the rate limit', () => {
    const reservations: RatedWriteReservation[] = [
      settledBefore(HOUR_MS, 'RELEASED'),
      { state: 'RESERVED', settledAt: null },
      settledBefore(2 * HOUR_MS, 'UNKNOWN'),
      settledBefore(3 * HOUR_MS),
    ];
    expect(writeScheduleOf(reservations, NOW)).toEqual({ nextWriteAllowedAt: null, remainingInWindow: MAX_WRITES_PER_DAY - 2 });
    expect(writeRateRejectionOf(reservations, NOW)).toBeNull();
  });

  it('gives the end of the interval after the last write', () => {
    const reservations = [settledBefore(MINUTE_MS)];
    expect(writeScheduleOf(reservations, NOW)).toEqual({
      nextWriteAllowedAt: formatCompactUtcTimestamp(new Date(NOW.getTime() - MINUTE_MS + MIN_WRITE_INTERVAL_MS), 'expected'),
      remainingInWindow: MAX_WRITES_PER_DAY - 1,
    });
    expectNextIsFirstAllowed(reservations);
  });

  it('gives the time when the oldest write leaves the window when the window is full', () => {
    const reservations = Array.from({ length: MAX_WRITES_PER_DAY }, (_unused, index) => settledBefore((index + 1) * HOUR_MS));
    const schedule = writeScheduleOf(reservations, NOW);
    expect(schedule.remainingInWindow).toBe(0);
    expect(schedule.nextWriteAllowedAt)
      .toBe(formatCompactUtcTimestamp(new Date(NOW.getTime() - MAX_WRITES_PER_DAY * HOUR_MS + WRITE_RATE_WINDOW_MS), 'expected'));
    expectNextIsFirstAllowed(reservations);
  });

  it('takes the later of the interval and the window, and does not count writes out of the window', () => {
    const reservations = [
      settledBefore(2 * MINUTE_MS),
      ...Array.from({ length: MAX_WRITES_PER_DAY - 1 }, (_unused, index) => settledBefore((index + 1) * HOUR_MS)),
      settledBefore(WRITE_RATE_WINDOW_MS + MINUTE_MS),
    ];
    expect(writeScheduleOf(reservations, NOW).remainingInWindow).toBe(0);
    expectNextIsFirstAllowed(reservations);
  });
});
