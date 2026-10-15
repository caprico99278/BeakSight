// T28d（Task 28 の設計書 3 章の「実行の許可」「件数の予約」、4.4）: 実行の許可と件数の予約の純粋な決まり（`src/control/approval/execution-grant.ts`）。
// - 拒む理由の閉じた一覧、予約の状態の遷移の表、許可の期限の計算（ちょうど期限の時刻は期限切れ）、上限と残りの数え方（累積は `RESERVED`・
//   `COMMITTED`・`UNKNOWN` を数え、`RELEASED` は数えない）、書き込みの同時実行の枠の判定。
import { describe, expect, it } from 'vitest';
import {
  COUNTED_WRITE_RESERVATION_STATES,
  EXECUTION_GRANT_REJECTION_REASONS,
  WRITE_RESERVATION_REJECTION_REASONS,
  WRITE_RESERVATION_TRANSITIONS,
  executionGrantExpiresAtOf,
  expiredOpenGrantIdsOf,
  isExecutionGrantExpired,
  isWriteConcurrencyAvailable,
  isWriteReservationTransitionAllowed,
  environmentEvidenceRejectionOf,
  selectUpdateTargetRecordId,
  targetSelectionRejectionOf,
  usedCumulativeWrites,
  writeLimitRejectionOf,
  writeRateRejectionOf,
} from '../../src/control/approval/execution-grant.js';
import {
  DEFAULT_MAX_CUMULATIVE_CREATES,
  EXECUTION_GRANT_TTL_MS,
  MAX_WRITES_PER_DAY,
  MIN_WRITE_INTERVAL_MS,
  WRITE_JOB_CONCURRENCY,
  WRITE_RATE_WINDOW_MS,
  WRITE_RESERVATION_STATES,
} from '../../src/control/approval/scenario-contracts.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';

const LIMITS = Object.freeze({ maxCreatesPerRun: 1, maxCumulativeCreates: 3 });
const SECOND_MS = 1_000;

describe('execution grant policy (T28d)', () => {
  it('has the closed lists of the rejection reasons', () => {
    expect(EXECUTION_GRANT_REJECTION_REASONS).toEqual([
      'GRANT_SCENARIO_NOT_FOUND',
      'GRANT_REVISION_CONFLICT',
      'GRANT_APPROVAL_INVALID',
      'NEEDS_RULE_INPUT',
      // T30a: 検証の指定のどれかが未指定（発行の確かめに足すのは T30d）。
      'VERIFICATION_SPEC_MISSING',
      // T30d: 環境の証跡の参照が空、連続の上限（間隔と 24 時間の件数）。
      'GRANT_ENVIRONMENT_EVIDENCE_MISSING',
      'GRANT_WRITE_INTERVAL_NOT_ELAPSED',
      'GRANT_DAILY_WRITE_LIMIT_REACHED',
      'GRANT_ALREADY_OPEN',
      'GRANT_WRITE_CONCURRENCY_EXCEEDED',
      'GRANT_RUN_LIMIT_EXCEEDED',
      'GRANT_CUMULATIVE_LIMIT_REACHED',
      'GRANT_FACTS_CHANGED',
      'GRANT_NOT_FOUND',
      'GRANT_MISMATCH',
      'GRANT_EXPIRED',
      'GRANT_ALREADY_CONSUMED',
      'GRANT_INVALIDATED',
      'GRANT_NOT_CONSUMED',
      // T28R-fix-1（I-2、M-2）。
      'GRANT_RESERVATION_SETTLED',
      'GRANT_CLOCK_BEFORE_APPROVAL',
      'GRANT_CLOCK_BEFORE_ISSUE',
      // T31b: UPDATE の指定の前に保存した UPDATE の版には、許可を出さない。
      'SCENARIO_UPDATE_SPEC_MISSING',
      // T31e: UPDATE の対象の選び直し（画面の予定の ID と違う・対象がない）。
      'TARGET_SELECTION_CHANGED',
      'TARGET_RECORD_UNAVAILABLE',
      // T31R-fix-1 の I-2: 台帳の登録の ID の取り方が、下書きの保存の後に変わり、path の型の `{id}` の位置に結び付かなくなった。
      'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
    ]);
    expect(WRITE_RESERVATION_REJECTION_REASONS).toEqual(['RESERVATION_NOT_FOUND', 'RESERVATION_TRANSITION_NOT_ALLOWED']);
    expect(Object.isFrozen(EXECUTION_GRANT_REJECTION_REASONS) && Object.isFrozen(WRITE_RESERVATION_REJECTION_REASONS)).toBe(true);
  });

  it('allows only RESERVED to COMMITTED, UNKNOWN or RELEASED (a closed table)', () => {
    expect(WRITE_RESERVATION_TRANSITIONS).toEqual({
      RESERVED: ['COMMITTED', 'UNKNOWN', 'RELEASED'],
      RELEASED: [],
      COMMITTED: [],
      UNKNOWN: [],
    });
    expect(Object.keys(WRITE_RESERVATION_TRANSITIONS)).toEqual([...WRITE_RESERVATION_STATES]);
    for (const from of WRITE_RESERVATION_STATES) {
      for (const to of WRITE_RESERVATION_STATES) {
        expect(isWriteReservationTransitionAllowed(from, to), `${from} -> ${to}`)
          .toBe(from === 'RESERVED' && to !== 'RESERVED');
      }
    }
  });

  it('computes the grant expiry from the issue time, and an exact expiry is expired', () => {
    const issuedAt = '20261012030000';
    const expiresAt = executionGrantExpiresAtOf(issuedAt);
    expect(expiresAt).toBe('20261012030500');
    expect(dateOfCompactUtcTimestamp(expiresAt).getTime() - dateOfCompactUtcTimestamp(issuedAt).getTime()).toBe(EXECUTION_GRANT_TTL_MS);
    const expiry = dateOfCompactUtcTimestamp(expiresAt).getTime();
    expect(isExecutionGrantExpired(expiresAt, new Date(expiry - SECOND_MS))).toBe(false);
    expect(isExecutionGrantExpired(expiresAt, new Date(expiry))).toBe(true);
    expect(isExecutionGrantExpired(expiresAt, new Date(expiry + SECOND_MS))).toBe(true);
    expect(() => executionGrantExpiresAtOf('2026-10-12')).toThrow(RangeError);
  });

  // T28R-fix-1（M-6）: 発行と画面が同じ数え方を使う。数えない許可（期限切れでまだ無効にしていない許可など）の予約は数えない。
  it('does not count the reservations of the excluded grants', () => {
    const reservations = [
      { grantId: 'grant-1', state: 'COMMITTED' as const, count: 1 },
      { grantId: 'grant-2', state: 'RESERVED' as const, count: 1 },
    ];
    expect(usedCumulativeWrites(reservations)).toBe(2);
    expect(usedCumulativeWrites(reservations, new Set(['grant-2']))).toBe(1);
    expect(expiredOpenGrantIdsOf([
      { grantId: 'grant-1', expiresAt: '20261012030500', consumedAt: null, invalidatedAt: null },
      { grantId: 'grant-2', expiresAt: '20261012030500', consumedAt: '20261012030100', invalidatedAt: null },
      { grantId: 'grant-3', expiresAt: '20261012040500', consumedAt: null, invalidatedAt: null },
    ], new Date(Date.parse('2026-10-12T03:05:00Z')))).toEqual(new Set(['grant-1']));
  });

  it('counts RESERVED, COMMITTED and UNKNOWN in the cumulative use, and not RELEASED', () => {
    expect(COUNTED_WRITE_RESERVATION_STATES).toEqual(['RESERVED', 'COMMITTED', 'UNKNOWN']);
    expect(usedCumulativeWrites([
      { state: 'RESERVED', count: 1 },
      { state: 'COMMITTED', count: 1 },
      { state: 'UNKNOWN', count: 1 },
      { state: 'RELEASED', count: 1 },
    ])).toBe(3);
    expect(usedCumulativeWrites([])).toBe(0);
  });

  it.each([
    ['a count within the limits', 1, [], null],
    ['a count above the per-run limit', 2, [], 'GRANT_RUN_LIMIT_EXCEEDED'],
    ['a zero count', 0, [], 'GRANT_RUN_LIMIT_EXCEEDED'],
    ['the last write of the cumulative limit', 1, [{ state: 'COMMITTED', count: 1 }, { state: 'UNKNOWN', count: 1 }], null],
    ['the cumulative limit reached', 1, [{ state: 'COMMITTED', count: 1 }, { state: 'UNKNOWN', count: 1 }, { state: 'RESERVED', count: 1 }],
      'GRANT_CUMULATIVE_LIMIT_REACHED'],
    ['released writes that are not counted', 1,
      [{ state: 'COMMITTED', count: 1 }, { state: 'RELEASED', count: 1 }, { state: 'RELEASED', count: 1 }, { state: 'UNKNOWN', count: 1 }], null],
  ] as const)('judges %s', (_label, count, reservations, expected) => {
    expect(writeLimitRejectionOf(count, LIMITS, reservations)).toBe(expected);
  });

  it('rejects at the default cumulative limit', () => {
    const used = Array.from({ length: DEFAULT_MAX_CUMULATIVE_CREATES }, () => ({ state: 'COMMITTED' as const, count: 1 }));
    const limits = { maxCreatesPerRun: 1, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES };
    expect(writeLimitRejectionOf(1, limits, used.slice(1))).toBeNull();
    expect(writeLimitRejectionOf(1, limits, used)).toBe('GRANT_CUMULATIVE_LIMIT_REACHED');
  });

  // T30d（Task 30 の設計書 2 章のユーザーの判断 3、3 章の「連続の上限」）: 同じシナリオの最後の書き込み（`COMMITTED`・`UNKNOWN` の予約を締めた
  // 時刻）から 5 分以上、24 時間の窓の中の書き込みが 5 件未満。`RELEASED` と `RESERVED` は数えない。
  describe('write rate limits (T30d)', () => {
    const NOW = Date.parse('2026-10-13T12:00:00Z');
    const at = (offsetMs: number): string => {
      const date = new Date(NOW + offsetMs);
      return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
    };
    const MINUTE_MS = 60_000;

    it('has the user-approved values as named constants', () => {
      expect(MIN_WRITE_INTERVAL_MS).toBe(5 * MINUTE_MS);
      expect(MAX_WRITES_PER_DAY).toBe(5);
      expect(WRITE_RATE_WINDOW_MS).toBe(24 * 60 * MINUTE_MS);
    });

    it.each<readonly [string, readonly { readonly state: 'COMMITTED' | 'UNKNOWN' | 'RELEASED' | 'RESERVED'; readonly settledAt: string | null }[],
      string | null]>([
      ['no write', [], null],
      ['a write exactly 5 minutes ago', [{ state: 'COMMITTED', settledAt: at(-MIN_WRITE_INTERVAL_MS) }], null],
      ['a write 4 minutes 59 seconds ago', [{ state: 'COMMITTED', settledAt: at(-MIN_WRITE_INTERVAL_MS + 1_000) }], 'GRANT_WRITE_INTERVAL_NOT_ELAPSED'],
      ['an UNKNOWN write 1 minute ago (counted)', [{ state: 'UNKNOWN', settledAt: at(-MINUTE_MS) }], 'GRANT_WRITE_INTERVAL_NOT_ELAPSED'],
      ['a RELEASED reservation 1 minute ago (not counted)', [{ state: 'RELEASED', settledAt: at(-MINUTE_MS) }], null],
      ['4 writes in the window', [1, 2, 3, 4].map((hour) => ({ state: 'COMMITTED' as const, settledAt: at(-hour * 60 * MINUTE_MS) })), null],
      ['5 writes in the window', [1, 2, 3, 4, 5].map((hour) => ({ state: 'COMMITTED' as const, settledAt: at(-hour * 60 * MINUTE_MS) })),
        'GRANT_DAILY_WRITE_LIMIT_REACHED'],
      ['5 writes with UNKNOWN in the window', [1, 2, 3, 4, 5].map((hour) => ({ state: hour % 2 === 0 ? 'UNKNOWN' as const : 'COMMITTED' as const,
        settledAt: at(-hour * 60 * MINUTE_MS) })), 'GRANT_DAILY_WRITE_LIMIT_REACHED'],
      ['5 writes with a RELEASED one in the window', [1, 2, 3, 4, 5].map((hour) => ({ state: hour === 3 ? 'RELEASED' as const : 'COMMITTED' as const,
        settledAt: at(-hour * 60 * MINUTE_MS) })), null],
      ['5 writes, the oldest exactly 24 hours ago (outside the window)', [1, 2, 3, 4].map((hour) => ({ state: 'COMMITTED' as const,
        settledAt: at(-hour * 60 * MINUTE_MS) })).concat([{ state: 'COMMITTED', settledAt: at(-WRITE_RATE_WINDOW_MS) }]), null],
      ['5 writes, the oldest 1 second inside the window', [1, 2, 3, 4].map((hour) => ({ state: 'COMMITTED' as const,
        settledAt: at(-hour * 60 * MINUTE_MS) })).concat([{ state: 'COMMITTED', settledAt: at(-WRITE_RATE_WINDOW_MS + 1_000) }]),
      'GRANT_DAILY_WRITE_LIMIT_REACHED'],
      ['a RESERVED reservation (not settled)', [{ state: 'RESERVED', settledAt: null }], null],
    ])('judges %s', (_label, writes, expected) => {
      expect(writeRateRejectionOf(writes, new Date(NOW))).toBe(expected);
    });

    it('reports the interval before the daily limit', () => {
      const writes = [0, 1, 2, 3, 4].map((hour) => ({ state: 'COMMITTED' as const, settledAt: at(-hour * 60 * MINUTE_MS - MINUTE_MS) }));
      expect(writeRateRejectionOf(writes, new Date(NOW))).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');
    });
  });

  it('rejects a profile without an environment evidence reference (null, empty or blank) (T30d)', () => {
    expect(environmentEvidenceRejectionOf('evidence/test-env.md')).toBeNull();
    for (const reference of [null, '', '   ']) {
      expect(environmentEvidenceRejectionOf(reference), String(reference)).toBe('GRANT_ENVIRONMENT_EVIDENCE_MISSING');
    }
  });

  it('keeps the write concurrency at WRITE_JOB_CONCURRENCY', () => {
    expect(WRITE_JOB_CONCURRENCY).toBe(1);
    expect(isWriteConcurrencyAvailable(0)).toBe(true);
    expect(isWriteConcurrencyAvailable(WRITE_JOB_CONCURRENCY)).toBe(false);
  });
});

// T31e（Task 31 の設計書 2 章のユーザーの判断 4・5、3 章の「対象の選び方」）: UPDATE の対象の選び方と、発行の中の選び直しの判定（純粋）。
describe('execution grant policy (T31e): the update target', () => {
  const registration = (recordId: string, registeredAt: string, jobId = `job-${recordId}`) => ({ recordId, registeredAt, jobId });

  it('chooses the latest registration, by the registration time and then by the job id, and null without one', () => {
    expect(selectUpdateTargetRecordId([])).toBeNull();
    expect(selectUpdateTargetRecordId([
      registration('rec-1', '20261014000000'), registration('rec-3', '20261014000200'), registration('rec-2', '20261014000100'),
    ])).toBe('rec-3');
    // 同じ時刻なら、ジョブの id の UTF-16 のコード単位の順の後のもの（並べた順によらない）。
    expect(selectUpdateTargetRecordId([registration('rec-a', '20261014000000', 'job-b'), registration('rec-b', '20261014000000', 'job-a')]))
      .toBe('rec-a');
    expect(selectUpdateTargetRecordId([registration('rec-b', '20261014000000', 'job-a'), registration('rec-a', '20261014000000', 'job-b')]))
      .toBe('rec-a');
  });

  it('tells an unavailable target and a changed choice', () => {
    expect(targetSelectionRejectionOf(null, null)).toBe('TARGET_RECORD_UNAVAILABLE');
    expect(targetSelectionRejectionOf(null, 'rec-1')).toBe('TARGET_RECORD_UNAVAILABLE');
    expect(targetSelectionRejectionOf('rec-2', 'rec-1')).toBe('TARGET_SELECTION_CHANGED');
    expect(targetSelectionRejectionOf('rec-2', null)).toBe('TARGET_SELECTION_CHANGED');
    expect(targetSelectionRejectionOf('rec-2', 'rec-2')).toBeNull();
  });
});
