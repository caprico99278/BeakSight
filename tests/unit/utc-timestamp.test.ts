// BN1（ChatGPT 用バンドルのファイル名の設計書 2.1）: UTC の14桁の日時の書式（`YYYYMMDDHHmmss`）の唯一の owner。
// Run の ID（`createRunIdFromTime`）と ChatGPT 用バンドルのファイル名（`bundleFileName`）の両方が、これを使う。
import { describe, expect, it } from 'vitest';
import {
  COMPACT_UTC_TIMESTAMP_LENGTH,
  formatCompactUtcTimestamp,
  isCompactUtcTimestamp,
} from '../../src/core/utc-timestamp.js';

const SUBJECT = 'sample time';

describe('formatCompactUtcTimestamp (bundle file name design 2.1)', () => {
  it('formats the instant as YYYYMMDDHHmmss in UTC, with a 24-hour clock', () => {
    expect(formatCompactUtcTimestamp(new Date('2026-10-08T15:09:30.999Z'), SUBJECT)).toBe('20261008150930');
  });

  it('uses UTC even when the instant is given with a local offset', () => {
    // 日本時間の 2026-10-09 00:05:09 は、UTC では 2026-10-08 15:05:09 である。
    expect(formatCompactUtcTimestamp(new Date('2026-10-09T00:05:09+09:00'), SUBJECT)).toBe('20261008150509');
  });

  it('zero-pads every month, day, hour, minute and second field, and always has the same length', () => {
    expect(formatCompactUtcTimestamp(new Date('2027-01-02T03:04:05.000Z'), SUBJECT)).toBe('20270102030405');
    expect(formatCompactUtcTimestamp(new Date('1000-01-01T00:00:00.000Z'), SUBJECT)).toHaveLength(COMPACT_UTC_TIMESTAMP_LENGTH);
    expect(formatCompactUtcTimestamp(new Date('9999-12-31T23:59:59.999Z'), SUBJECT)).toBe('99991231235959');
  });

  it('rejects an invalid Date, a value that is not a Date and years that do not have four digits, naming the subject', () => {
    expect(() => formatCompactUtcTimestamp(new Date(Number.NaN), SUBJECT)).toThrow(new RangeError(`${SUBJECT} must be a valid Date`));
    expect(() => formatCompactUtcTimestamp('2026-10-08T00:00:00Z' as unknown as Date, SUBJECT))
      .toThrow(new RangeError(`${SUBJECT} must be a valid Date`));
    expect(() => formatCompactUtcTimestamp(new Date('0999-12-31T23:59:59.000Z'), SUBJECT))
      .toThrow(new RangeError(`${SUBJECT} must have a four-digit UTC year`));
    expect(() => formatCompactUtcTimestamp(new Date('+010000-01-01T00:00:00.000Z'), SUBJECT))
      .toThrow(new RangeError(`${SUBJECT} must have a four-digit UTC year`));
  });
});

describe('isCompactUtcTimestamp (bundle file name design 2.1)', () => {
  it('accepts exactly the shape that formatCompactUtcTimestamp makes', () => {
    expect(COMPACT_UTC_TIMESTAMP_LENGTH).toBe('YYYYMMDDHHmmss'.length);
    expect(isCompactUtcTimestamp(formatCompactUtcTimestamp(new Date('2026-10-08T03:09:30.000Z'), SUBJECT))).toBe(true);
  });

  it('rejects other lengths and characters other than ASCII digits', () => {
    for (const value of ['', '2026100803093', '202610080309300', '2026-10-08T03', '2026100803093a', '２０２６１００８０３０９３０', ' 20261008030930']) {
      expect(isCompactUtcTimestamp(value), value).toBe(false);
    }
  });
});
