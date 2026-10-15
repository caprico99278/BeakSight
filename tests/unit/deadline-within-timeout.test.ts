// CCX-7b（共通化の台帳の CC-047）: 「期限（なければ無し）と、今から timeout 後の早い方」の計算を `src/core/deadline.ts` の
// `deadlineWithinTimeoutAtMs` にまとめる。期限の表（期限が今より前、今の後で timeout 後より早い、同じ、遅い、期限なし、timeout が 0 と 1）で、
// まとめた部品と、それを使う `passiveSessionOpenDeadlineAtMs`（DEF-008）の値を固定する。今の時刻は `Date.now()` を 1 回だけ読む。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadlineWithinTimeoutAtMs } from '../../src/core/deadline.js';
import { SESSION_OPEN_TIMEOUT_MS } from '../../src/core/limits.js';
import { passiveSessionOpenDeadlineAtMs } from '../../src/orchestration/passive-session-open.js';

/** 偽の今の時刻（`Date.now()` の値）。 */
const NOW_MS = 1_000_000;
const TIMEOUT_MS = 300;
/** 期限と今の時刻の差（ms）。`TIMEOUT_MS` より小さい。 */
const SHORT_OFFSET_MS = 100;
/** 期限と今の時刻の差（ms）。`TIMEOUT_MS` より大きい。 */
const LONG_OFFSET_MS = 500;
const ZERO_TIMEOUT_MS = 0;
const ONE_MS_TIMEOUT = 1;

/** `[行の名前, 期限, timeout, 結果]`。 */
const DEADLINE_TABLE: readonly (readonly [string, number | undefined, number, number])[] = [
  ['the deadline is before now', NOW_MS - SHORT_OFFSET_MS, TIMEOUT_MS, NOW_MS - SHORT_OFFSET_MS],
  ['the deadline is after now and before the timeout', NOW_MS + SHORT_OFFSET_MS, TIMEOUT_MS, NOW_MS + SHORT_OFFSET_MS],
  ['the deadline is at the timeout', NOW_MS + TIMEOUT_MS, TIMEOUT_MS, NOW_MS + TIMEOUT_MS],
  ['the deadline is after the timeout', NOW_MS + LONG_OFFSET_MS, TIMEOUT_MS, NOW_MS + TIMEOUT_MS],
  ['there is no deadline', undefined, TIMEOUT_MS, NOW_MS + TIMEOUT_MS],
  ['the timeout is 0', NOW_MS + SHORT_OFFSET_MS, ZERO_TIMEOUT_MS, NOW_MS],
  ['the timeout is 1', NOW_MS + SHORT_OFFSET_MS, ONE_MS_TIMEOUT, NOW_MS + ONE_MS_TIMEOUT],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deadlineWithinTimeoutAtMs (CCX-7b)', () => {
  it.each(DEADLINE_TABLE)('returns the earlier of the deadline and now + timeout when %s', (_case, deadlineAtMs, timeoutMs, expected) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);

    expect(deadlineWithinTimeoutAtMs(deadlineAtMs, timeoutMs)).toBe(expected);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-finite deadline as Math.min does (the callers validate their deadlines)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);

    expect(deadlineWithinTimeoutAtMs(Number.NaN, TIMEOUT_MS)).toBeNaN();
    expect(deadlineWithinTimeoutAtMs(Number.POSITIVE_INFINITY, TIMEOUT_MS)).toBe(NOW_MS + TIMEOUT_MS);
    expect(deadlineWithinTimeoutAtMs(Number.NEGATIVE_INFINITY, TIMEOUT_MS)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('passiveSessionOpenDeadlineAtMs on the deadline table (DEF-008, CCX-7b)', () => {
  it.each(DEADLINE_TABLE.filter(([, , timeoutMs]) => timeoutMs > ZERO_TIMEOUT_MS))(
    'returns the earlier of notAfterMs and now + timeoutMs when %s',
    (_case, notAfterMs, timeoutMs, expected) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);

      expect(passiveSessionOpenDeadlineAtMs({ timeoutMs, notAfterMs })).toBe(expected);
    },
  );

  it('uses SESSION_OPEN_TIMEOUT_MS without timeoutMs, and rejects a timeout of 0', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);

    expect(passiveSessionOpenDeadlineAtMs({ notAfterMs: NOW_MS + SHORT_OFFSET_MS })).toBe(NOW_MS + SHORT_OFFSET_MS);
    expect(passiveSessionOpenDeadlineAtMs()).toBe(NOW_MS + SESSION_OPEN_TIMEOUT_MS);
    expect(() => passiveSessionOpenDeadlineAtMs({ timeoutMs: ZERO_TIMEOUT_MS })).toThrow(RangeError);
  });
});
