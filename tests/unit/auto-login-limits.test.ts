// T26c（Task 26 の設計書 4.5、10 章の 4）: 自動ログインの上限の判定（`src/control/job/auto-login-limits.ts`。純粋な関数）の単体テスト。
// - 名前つきの定数（1 回のジョブで POST 1 回、最小の間隔 5 分、24 時間で 10 回、`Retry-After` の上限 24 時間、結果を待つ 30 秒）。
// - 境界: ちょうど 5 分、24 時間の窓の端、10 回目と 11 回目、`Retry-After` の秒・HTTP の日付・読めない値・負の値・上限。
// - 止めている間は `AUTO_LOGIN_HELD`（次の時刻なし）。解いた後も、最小の間隔と `Retry-After` は守る。
// - 結果の閉じた一覧（`src/control/auth/automated-login-results.ts`）とログインの Origin の部品。
import { describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../src/control/auth/auth-setup-contracts.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSIONS,
  loginOriginOf,
} from '../../src/control/auth/automated-login-results.js';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MAX_LOGIN_POSTS_PER_JOB,
  AUTO_LOGIN_MAX_RETRY_AFTER_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
  AUTO_LOGIN_RESULT_TIMEOUT_MS,
  dateOfCompactUtcTimestamp,
  decideAutoLoginStart,
  retryAfterUntilOf,
  type AutoLoginAttemptForLimits,
} from '../../src/control/job/auto-login-limits.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const stamp = (date: Date): string => formatCompactUtcTimestamp(date, 'test time');
const attemptAt = (offsetMs: number, retryAfterUntil: string | null = null): AutoLoginAttemptForLimits =>
  ({ startedAt: stamp(at(offsetMs)), retryAfterUntil });
const HOLD = Object.freeze({ reason: 'ACCOUNT_LOCKED' as const, heldAt: stamp(at(-HOUR_MS)) });

describe('auto login limits: the named constants (design 4.5, 10.4, approved by the user)', () => {
  it('has the approved values', () => {
    expect(AUTO_LOGIN_MAX_LOGIN_POSTS_PER_JOB).toBe(AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS);
    expect(AUTO_LOGIN_MAX_LOGIN_POSTS_PER_JOB).toBe(1);
    expect(AUTO_LOGIN_MIN_INTERVAL_MS).toBe(5 * MINUTE_MS);
    expect(AUTO_LOGIN_DAILY_WINDOW_MS).toBe(24 * HOUR_MS);
    expect(AUTO_LOGIN_DAILY_MAX_ATTEMPTS).toBe(10);
    expect(AUTO_LOGIN_MAX_RETRY_AFTER_MS).toBe(24 * HOUR_MS);
    expect(AUTO_LOGIN_RESULT_TIMEOUT_MS).toBe(30 * SECOND_MS);
  });
});

describe('auto login results (design 4.5)', () => {
  it('is the closed list of the design, with SUCCEEDED first and the failures after it', () => {
    expect(AUTOMATED_LOGIN_RESULTS).toEqual([
      'SUCCEEDED', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN',
      'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE',
      // T26g-1: 送信の窓の中で、許した POST のほかの要求を止めた。
      'UNEXPECTED_LOGIN_REQUEST',
    ]);
    expect(AUTOMATED_LOGIN_FAILURE_RESULTS).toEqual(AUTOMATED_LOGIN_RESULTS.filter((result) => result !== 'SUCCEEDED'));
    expect(AUTOMATED_LOGIN_SUBMISSIONS).toEqual(['YES', 'NO', 'UNKNOWN']);
    expect(Object.isFrozen(AUTOMATED_LOGIN_RESULTS)).toBe(true);
    expect(Object.isFrozen(AUTOMATED_LOGIN_FAILURE_RESULTS)).toBe(true);
  });

  it('derives the login origin from loginStartUrl with the existing origin canonicalization', () => {
    expect(loginOriginOf('https://app.example.invalid/login?next=%2F')).toBe('https://app.example.invalid');
    expect(loginOriginOf('http://127.0.0.1:4173/sign-in')).toBe('http://127.0.0.1:4173');
    expect(loginOriginOf('https://APP.example.invalid:443/login')).toBe('https://app.example.invalid');
    for (const value of ['not a url', 'ftp://app.example.invalid/login', 'file:///C:/login', '']) {
      expect(loginOriginOf(value), value).toBeUndefined();
    }
  });
});

describe('auto login limits: the decision (design 4.5)', () => {
  it('allows the first attempt', () => {
    expect(decideAutoLoginStart({ attempts: [], hold: null, now: NOW })).toEqual({ ok: true });
  });

  it('keeps the minimum interval from the last start: just under 5 minutes is refused, exactly 5 minutes is allowed', () => {
    const justUnder = decideAutoLoginStart({ attempts: [attemptAt(-AUTO_LOGIN_MIN_INTERVAL_MS + SECOND_MS)], hold: null, now: NOW });
    expect(justUnder).toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stamp(at(SECOND_MS)) });
    expect(decideAutoLoginStart({ attempts: [attemptAt(-AUTO_LOGIN_MIN_INTERVAL_MS)], hold: null, now: NOW })).toEqual({ ok: true });
    // 最後の開始から数える（古い記録は数えない）。
    const lastWins = decideAutoLoginStart({
      attempts: [attemptAt(-HOUR_MS), attemptAt(-MINUTE_MS), attemptAt(-2 * HOUR_MS)],
      hold: null,
      now: NOW,
    });
    expect(lastWins).toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stamp(at(AUTO_LOGIN_MIN_INTERVAL_MS - MINUTE_MS)) });
  });

  it('counts the starts in the 24 hour window: 9 earlier starts allow the 10th, 10 refuse the 11th until the oldest leaves the window', () => {
    const spaced = (count: number, firstOffsetMs: number): AutoLoginAttemptForLimits[] =>
      Array.from({ length: count }, (_, index) => attemptAt(firstOffsetMs + index * HOUR_MS));
    const firstOffsetMs = -AUTO_LOGIN_DAILY_WINDOW_MS + HOUR_MS;
    expect(decideAutoLoginStart({ attempts: spaced(AUTO_LOGIN_DAILY_MAX_ATTEMPTS - 1, firstOffsetMs), hold: null, now: NOW })).toEqual({ ok: true });
    const full = spaced(AUTO_LOGIN_DAILY_MAX_ATTEMPTS, firstOffsetMs);
    expect(decideAutoLoginStart({ attempts: full, hold: null, now: NOW })).toEqual({
      ok: false,
      reason: 'AUTO_LOGIN_RATE_LIMITED',
      nextAllowedAt: stamp(at(firstOffsetMs + AUTO_LOGIN_DAILY_WINDOW_MS)),
    });
    // 窓の端: ちょうど 24 時間前の開始は窓の外。24 時間より 1 秒新しい開始は窓の中。
    const edge = [attemptAt(-AUTO_LOGIN_DAILY_WINDOW_MS), ...spaced(AUTO_LOGIN_DAILY_MAX_ATTEMPTS - 1, firstOffsetMs)];
    expect(decideAutoLoginStart({ attempts: edge, hold: null, now: NOW })).toEqual({ ok: true });
    const inside = [attemptAt(-AUTO_LOGIN_DAILY_WINDOW_MS + SECOND_MS), ...spaced(AUTO_LOGIN_DAILY_MAX_ATTEMPTS - 1, firstOffsetMs)];
    expect(decideAutoLoginStart({ attempts: inside, hold: null, now: NOW })).toEqual({
      ok: false,
      reason: 'AUTO_LOGIN_RATE_LIMITED',
      nextAllowedAt: stamp(at(SECOND_MS)),
    });
  });

  it('keeps the latest Retry-After deadline of the records', () => {
    const attempts = [
      attemptAt(-2 * HOUR_MS, stamp(at(HOUR_MS))),
      attemptAt(-3 * HOUR_MS, stamp(at(2 * HOUR_MS))),
      attemptAt(-4 * HOUR_MS, stamp(at(-MINUTE_MS))),
    ];
    expect(decideAutoLoginStart({ attempts, hold: null, now: NOW }))
      .toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stamp(at(2 * HOUR_MS)) });
    expect(decideAutoLoginStart({ attempts: [attemptAt(-2 * HOUR_MS, stamp(NOW))], hold: null, now: NOW })).toEqual({ ok: true });
  });

  it('returns the latest of the times when several limits apply', () => {
    const attempts = [attemptAt(-MINUTE_MS, stamp(at(10 * MINUTE_MS)))];
    expect(decideAutoLoginStart({ attempts, hold: null, now: NOW }))
      .toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stamp(at(10 * MINUTE_MS)) });
  });

  it('refuses with AUTO_LOGIN_HELD and no next time while the profile is held, even when the other limits pass', () => {
    expect(decideAutoLoginStart({ attempts: [], hold: HOLD, now: NOW })).toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null });
    expect(decideAutoLoginStart({ attempts: [attemptAt(-MINUTE_MS)], hold: HOLD, now: NOW }))
      .toEqual({ ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null });
  });

  it('still keeps the minimum interval and Retry-After after the hold is cleared', () => {
    expect(decideAutoLoginStart({ attempts: [attemptAt(-MINUTE_MS)], hold: null, now: NOW }))
      .toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED' });
    expect(decideAutoLoginStart({ attempts: [attemptAt(-HOUR_MS, stamp(at(HOUR_MS)))], hold: null, now: NOW }))
      .toEqual({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stamp(at(HOUR_MS)) });
  });

  it('rejects records that are not 14 digit UTC timestamps (caller error)', () => {
    expect(() => decideAutoLoginStart({ attempts: [{ startedAt: '2026-10-10', retryAfterUntil: null }], hold: null, now: NOW })).toThrow(RangeError);
    expect(() => decideAutoLoginStart({ attempts: [{ startedAt: stamp(NOW), retryAfterUntil: '20261399000000' }], hold: null, now: NOW }))
      .toThrow(RangeError);
    expect(() => decideAutoLoginStart({ attempts: [], hold: null, now: new Date(Number.NaN) })).toThrow(RangeError);
  });

  it('reads compact UTC timestamps back into the same time', () => {
    expect(dateOfCompactUtcTimestamp(stamp(NOW)).getTime()).toBe(NOW.getTime());
    for (const value of ['', '2026101012000', '202610101200000', '2026a010120000', '20260230120000', '20261010250000']) {
      expect(() => dateOfCompactUtcTimestamp(value), value).toThrow(RangeError);
    }
  });
});

describe('auto login limits: reading Retry-After (design 4.5)', () => {
  const capped = stamp(at(AUTO_LOGIN_MAX_RETRY_AFTER_MS));

  it('reads delta seconds', () => {
    expect(retryAfterUntilOf('120', NOW)).toBe(stamp(at(2 * MINUTE_MS)));
    expect(retryAfterUntilOf(' 0 ', NOW)).toBe(stamp(NOW));
    expect(retryAfterUntilOf(String(AUTO_LOGIN_MAX_RETRY_AFTER_MS / SECOND_MS), NOW)).toBe(capped);
  });

  it('rounds a deadline inside a second up to the next second (never earlier than the server asked)', () => {
    const now = new Date(NOW.getTime() + 300);
    expect(retryAfterUntilOf('1', now)).toBe(stamp(at(2 * SECOND_MS)));
  });

  it('reads an HTTP date (IMF-fixdate)', () => {
    expect(retryAfterUntilOf('Sat, 10 Oct 2026 13:30:00 GMT', NOW)).toBe(stamp(at(90 * MINUTE_MS)));
  });

  it('takes the upper limit for unreadable, negative, past and too long values', () => {
    for (const value of [
      null,
      '',
      'soon',
      '-5',
      '1.5',
      '+30',
      '0x10',
      String(AUTO_LOGIN_MAX_RETRY_AFTER_MS / SECOND_MS + 1),
      '9'.repeat(400),
      'Sat, 10 Oct 2026 11:59:59 GMT',
      'Sun, 11 Oct 2026 12:00:01 GMT',
      'Saturday, 10-Oct-26 13:30:00 GMT',
      'Sat Oct 10 13:30:00 2026',
      'Sat, 10 Oct 2026 13:30:00 +0000',
      'Sat, 31 Feb 2026 13:30:00 GMT',
    ]) {
      expect(retryAfterUntilOf(value, NOW), String(value)).toBe(capped);
    }
  });
});
