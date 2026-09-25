import { describe, expect, it } from 'vitest';
import {
  DISPLAY_TIME_ZONE,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatMilliseconds,
  formatNotObserved,
  formatPercent,
  formatPixels,
} from '../../src/presentation/format.js';
import { NOT_OBSERVED_TEXT } from '../../src/presentation/messages.js';

/** 置き換える前の Rule のファイルの丸め方（文言が変わらないことを確かめるための比較用）。 */
const formerRoundToThousandths = (value: number): string => String(Math.round(value * 1000) / 1000);
const formerPercent = (ratio: number): string => `${String(Math.round(ratio * 1000) / 10)}%`;

const SAMPLE_VALUES = [
  0, 1, -1, 12, 390, 0.1, 0.25, 1 / 3, 2 / 3, 0.0005, 0.0015, 1.0005, 1.23456, 99.9995, 4000.4567, 0.123456789,
  -0.0001, -2.5004, 1234567.891234, 1e-7,
];

describe('formatDecimal', () => {
  it('rounds to at most three fraction digits by default and drops trailing zeros', () => {
    expect(formatDecimal(12)).toBe('12');
    expect(formatDecimal(0.1)).toBe('0.1');
    expect(formatDecimal(1.23456)).toBe('1.235');
    expect(formatDecimal(1 / 3)).toBe('0.333');
    expect(formatDecimal(-0.0001)).toBe('0');
  });

  it('rounds to the given number of fraction digits', () => {
    expect(formatDecimal(1.23456, 1)).toBe('1.2');
    expect(formatDecimal(1.25, 0)).toBe('1');
    expect(formatDecimal(1.5, 0)).toBe('2');
  });

  it('keeps the wording of the former rule-local formatNumber', () => {
    for (const value of SAMPLE_VALUES) {
      expect(formatDecimal(value)).toBe(formerRoundToThousandths(value));
    }
  });
});

describe('formatPixels and formatMilliseconds', () => {
  it('append the unit after the rounded value', () => {
    expect(formatPixels(390)).toBe('390 px');
    expect(formatPixels(12.34567)).toBe('12.346 px');
    expect(formatMilliseconds(4000)).toBe('4000 ms');
    expect(formatMilliseconds(4000.4567)).toBe('4000.457 ms');
  });

  it('keep the wording of the former messages', () => {
    for (const value of SAMPLE_VALUES) {
      expect(formatPixels(value)).toBe(`${formerRoundToThousandths(value)} px`);
      expect(formatMilliseconds(value)).toBe(`${formerRoundToThousandths(value)} ms`);
    }
  });
});

describe('formatPercent', () => {
  it('shows a ratio as a percentage with at most one fraction digit by default', () => {
    expect(formatPercent(0.25)).toBe('25%');
    expect(formatPercent(0.3)).toBe('30%');
    expect(formatPercent(0.12345)).toBe('12.3%');
    expect(formatPercent(1 / 3)).toBe('33.3%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('rounds to the given number of fraction digits', () => {
    expect(formatPercent(0.123456, 2)).toBe('12.35%');
    expect(formatPercent(0.12345, 0)).toBe('12%');
  });

  it('keeps the wording of the former rule-local formatPercent', () => {
    for (const ratio of SAMPLE_VALUES) {
      expect(formatPercent(ratio)).toBe(formerPercent(ratio));
    }
  });
});

/** 観測できなかった値の表現（呼び出し側が渡しうるもの）。 */
const UNOBSERVED_NUMBERS = [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1] as const;

describe('formatNotObserved', () => {
  it('returns the not-observed text, never 0 or an empty string', () => {
    expect(formatNotObserved()).toBe(NOT_OBSERVED_TEXT);
    expect(formatNotObserved()).not.toBe('');
    expect(formatNotObserved()).not.toBe('0');
  });
});

describe('formatDateTime', () => {
  it('shows an ISO 8601 timestamp in Asia/Tokyo with the JST suffix', () => {
    expect(DISPLAY_TIME_ZONE).toBe('Asia/Tokyo');
    expect(formatDateTime('2026-09-24T06:30:00.000Z')).toBe('2026-09-24 15:30:00 JST');
    expect(formatDateTime('2026-09-23T15:00:00Z')).toBe('2026-09-24 00:00:00 JST');
    expect(formatDateTime('2026-12-31T23:59:59.999Z')).toBe('2027-01-01 08:59:59 JST');
  });

  it('uses the 24-hour clock with two digits', () => {
    expect(formatDateTime('2026-01-02T03:04:05Z')).toBe('2026-01-02 12:04:05 JST');
    expect(formatDateTime('2026-01-01T15:00:00Z')).toBe('2026-01-02 00:00:00 JST');
  });

  it('shows the not-observed text for null', () => {
    expect(formatDateTime(null)).toBe(NOT_OBSERVED_TEXT);
  });

  it('shows an unparseable timestamp as it was recorded instead of hiding it', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

describe('formatDuration', () => {
  it('shows durations below one second in whole milliseconds', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12.6)).toBe('13 ms');
  });

  it('shows durations of one second or more in seconds with one fraction digit', () => {
    expect(formatDuration(999.6)).toBe('1秒');
    expect(formatDuration(1000)).toBe('1秒');
    expect(formatDuration(1500)).toBe('1.5秒');
    expect(formatDuration(65_432)).toBe('65.4秒');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s', (value) => {
    expect(formatDuration(value)).toBe(NOT_OBSERVED_TEXT);
  });
});

describe('formatBytes', () => {
  it('uses B, KB and MB (1 KB = 1024 B)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(5.25 * 1024 * 1024)).toBe('5.3 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3072 MB');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s', (value) => {
    expect(formatBytes(value)).toBe(NOT_OBSERVED_TEXT);
  });
});

// C16d（設計書 6.1.10）: 整数（リンクの深さの上限、HTTP ステータスなど）の書式。
describe('formatInteger', () => {
  it('shows an integer in decimal digits, without grouping or a unit', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(3)).toBe('3');
    expect(formatInteger(200)).toBe('200');
    expect(formatInteger(404)).toBe('404');
    expect(formatInteger(1234567)).toBe('1234567');
    expect(formatInteger(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  it('rounds a value that is not an integer, and shows -0 as 0', () => {
    expect(formatInteger(2.4)).toBe('2');
    expect(formatInteger(2.5)).toBe('3');
    expect(formatInteger(-0)).toBe('0');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s, like the other formats', (value) => {
    expect(formatInteger(value)).toBe(NOT_OBSERVED_TEXT);
  });
});

describe('formatCount', () => {
  it('groups the digits and appends the counter word', () => {
    expect(formatCount(0)).toBe('0件');
    expect(formatCount(3)).toBe('3件');
    expect(formatCount(1234567)).toBe('1,234,567件');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s', (value) => {
    expect(formatCount(value)).toBe(NOT_OBSERVED_TEXT);
  });
});
