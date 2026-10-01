import { describe, expect, it } from 'vitest';
import {
  DISPLAY_TIME_ZONE,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatElapsedTime,
  formatInteger,
  formatMilliseconds,
  formatNotObserved,
  formatPercent,
  formatPixels,
  formatRequestsWithPeak,
  formatTimes,
} from '../../src/presentation/format.js';
import {
  FORMAT_UNIT_TEXT,
  NOT_OBSERVED_TEXT,
  countWithPeakPerMinuteText,
  countWithRecentAndPeakPerMinuteText,
} from '../../src/presentation/messages.js';

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

// L7（サイトへの負荷の制御の設計書 4.5、4.8）: 回数の書式。区切りは `formatCount` と同じで、単位だけが違う。
describe('formatTimes', () => {
  it('groups the digits like formatCount and appends the unit of times', () => {
    expect(FORMAT_UNIT_TEXT.times).toBe('回');
    expect(formatTimes(0)).toBe('0回');
    expect(formatTimes(284)).toBe('284回');
    expect(formatTimes(1234)).toBe('1,234回');
    expect(formatTimes(1234567)).toBe('1,234,567回');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s', (value) => {
    expect(formatTimes(value)).toBe(NOT_OBSERVED_TEXT);
  });
});

// L7（設計書 4.8）: 経過時間の書式。時間・分・秒で書き、1時間以上では秒を省く。端数は切り捨てる（経過した分だけを示す）。
describe('formatElapsedTime', () => {
  const SECOND_MS = 1000;
  const MINUTE_MS = 60 * SECOND_MS;
  const HOUR_MS = 60 * MINUTE_MS;

  it('uses the units of hours, minutes and seconds from the message catalog', () => {
    expect(FORMAT_UNIT_TEXT).toMatchObject({ hours: '時間', minutes: '分', seconds: '秒' });
  });

  it('shows less than one minute in whole seconds, cutting off the fraction', () => {
    expect(formatElapsedTime(0)).toBe('0秒');
    expect(formatElapsedTime(999)).toBe('0秒');
    expect(formatElapsedTime(40 * SECOND_MS)).toBe('40秒');
    expect(formatElapsedTime(59 * SECOND_MS)).toBe('59秒');
    expect(formatElapsedTime(MINUTE_MS - 1)).toBe('59秒');
  });

  it('shows one minute or more in minutes and seconds, without zero seconds', () => {
    expect(formatElapsedTime(60 * SECOND_MS)).toBe('1分');
    expect(formatElapsedTime(MINUTE_MS + SECOND_MS)).toBe('1分1秒');
    expect(formatElapsedTime(24 * MINUTE_MS + 10 * SECOND_MS)).toBe('24分10秒');
    expect(formatElapsedTime(HOUR_MS - 1)).toBe('59分59秒');
  });

  it('shows one hour or more in hours and minutes, without seconds and without zero minutes', () => {
    expect(formatElapsedTime(HOUR_MS)).toBe('1時間');
    expect(formatElapsedTime(HOUR_MS + 59 * SECOND_MS)).toBe('1時間');
    expect(formatElapsedTime(HOUR_MS + 5 * MINUTE_MS)).toBe('1時間5分');
    expect(formatElapsedTime(HOUR_MS + 5 * MINUTE_MS + 30 * SECOND_MS)).toBe('1時間5分');
    expect(formatElapsedTime(25 * HOUR_MS + 59 * MINUTE_MS)).toBe('25時間59分');
  });

  it('keeps formatDuration as it was', () => {
    expect(formatDuration(65_432)).toBe('65.4秒');
  });

  it.each(UNOBSERVED_NUMBERS)('shows the not-observed text for %s', (value) => {
    expect(formatElapsedTime(value)).toBe(NOT_OBSERVED_TEXT);
  });
});

// L7（設計書 4.5、4.8。L6 の報告の発見事項3）: 要求の件数と1分あたりの最大の組み立ての、唯一の場所。直近の1分の件数を渡すと、
// それも添える（実行中の進み具合の行）。
describe('formatRequestsWithPeak', () => {
  it('shows a request count with the peak per minute, in the count format', () => {
    expect(formatRequestsWithPeak({ count: 3400, peakPerMinute: 210 })).toBe('3,400件（1分あたり最大 210件）');
    expect(formatRequestsWithPeak({ count: 0, peakPerMinute: 0 })).toBe('0件（1分あたり最大 0件）');
    expect(formatRequestsWithPeak({ count: 3400, peakPerMinute: 210 }))
      .toBe(countWithPeakPerMinuteText(formatCount(3400), formatCount(210)));
  });

  it('adds the count of the latest minute before the peak when it is given', () => {
    expect(formatRequestsWithPeak({ count: 1930, peakPerMinute: 61 }, 38)).toBe('1,930件（直近1分 38件、1分あたり最大 61件）');
    expect(formatRequestsWithPeak({ count: 0, peakPerMinute: 0 }, 0)).toBe('0件（直近1分 0件、1分あたり最大 0件）');
    expect(formatRequestsWithPeak({ count: 1930, peakPerMinute: 61 }, 38))
      .toBe(countWithRecentAndPeakPerMinuteText(formatCount(1930), formatCount(38), formatCount(61)));
  });

  it('shows the values as they are given (does not compute them)', () => {
    // 直近の1分の件数が最大より大きい、矛盾した値でも、そのまま示す。
    expect(formatRequestsWithPeak({ count: 5, peakPerMinute: 3 }, 9)).toBe('5件（直近1分 9件、1分あたり最大 3件）');
  });

  it('shows the not-observed text for a value that was not observed', () => {
    expect(formatRequestsWithPeak({ count: -1, peakPerMinute: 2 })).toBe(`${NOT_OBSERVED_TEXT}（1分あたり最大 2件）`);
  });
});
