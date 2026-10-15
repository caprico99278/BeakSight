// T26d-1（Task 26 の設計書 4.4 の 5、4.5）: 自動ログインの結果を待つ時間と `Retry-After` の読み方を、ワーカーから届く場所
// （`src/control/auth/automated-login-timing.ts`）に移したことの単体テスト。
// - 定義は 1 か所（`src/control/job/auto-login-limits.ts` は、ここから import して同じものを公開する）。
// - `retryAfterUntilDateOf` は、`retryAfterUntilOf`（UTC の 14 桁）と同じ時刻を `Date` で返す（ワーカーの結果の `retryAfterUntil`）。
import { describe, expect, it } from 'vitest';
import {
  AUTO_LOGIN_MAX_RETRY_AFTER_MS,
  AUTO_LOGIN_RESULT_TIMEOUT_MS,
  retryAfterUntilDateOf,
  retryAfterUntilOf,
} from '../../src/control/auth/automated-login-timing.js';
import * as limits from '../../src/control/job/auto-login-limits.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe('automated login timing (design 4.4, 4.5)', () => {
  it('keeps the approved values', () => {
    expect(AUTO_LOGIN_RESULT_TIMEOUT_MS).toBe(30 * SECOND_MS);
    expect(AUTO_LOGIN_MAX_RETRY_AFTER_MS).toBe(24 * HOUR_MS);
  });

  it('is defined once: the job limits re-export the same values and functions', () => {
    expect(limits.AUTO_LOGIN_RESULT_TIMEOUT_MS).toBe(AUTO_LOGIN_RESULT_TIMEOUT_MS);
    expect(limits.AUTO_LOGIN_MAX_RETRY_AFTER_MS).toBe(AUTO_LOGIN_MAX_RETRY_AFTER_MS);
    expect(limits.retryAfterUntilOf).toBe(retryAfterUntilOf);
  });

  it('returns the same deadline as a Date (seconds, HTTP dates, and the upper limit)', () => {
    expect(retryAfterUntilDateOf('120', NOW).getTime()).toBe(at(2 * MINUTE_MS).getTime());
    expect(retryAfterUntilDateOf('Sat, 10 Oct 2026 13:30:00 GMT', NOW).getTime()).toBe(at(90 * MINUTE_MS).getTime());
    expect(retryAfterUntilDateOf(null, NOW).getTime()).toBe(at(AUTO_LOGIN_MAX_RETRY_AFTER_MS).getTime());
    expect(retryAfterUntilDateOf('soon', NOW).getTime()).toBe(at(AUTO_LOGIN_MAX_RETRY_AFTER_MS).getTime());
    const inSecond = new Date(NOW.getTime() + 300);
    expect(retryAfterUntilDateOf('1', inSecond).getTime()).toBe(at(2 * SECOND_MS).getTime());
    for (const value of ['0', '45', 'Sat, 10 Oct 2026 12:10:00 GMT', '', null]) {
      expect(formatCompactUtcTimestamp(retryAfterUntilDateOf(value, NOW), 'test')).toBe(retryAfterUntilOf(value, NOW));
    }
  });

  it('rejects an invalid now (caller error)', () => {
    expect(() => retryAfterUntilDateOf('1', new Date(Number.NaN))).toThrow(RangeError);
  });
});
