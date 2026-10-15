// CCX-20（CC-083）: 入力の規則の基準日（Asia/Tokyo の `YYYY-MM-DD`）の owner（`src/core/base-date.ts` の `baseDateOf`）と、それを使う
// ジョブの管理の `writeBaseDateOf`（実行の許可の発行の時刻（UTC の 14 桁）から）。
import { describe, expect, it } from 'vitest';
import { BASE_DATE_TIME_ZONE, baseDateOf } from '../../src/core/base-date.js';
import { writeBaseDateOf } from '../../src/control/job/write-job-start.js';

describe('baseDateOf (CCX-20)', () => {
  it('returns the Asia/Tokyo date of the time, changing the date at 15:00 UTC', () => {
    expect(BASE_DATE_TIME_ZONE).toBe('Asia/Tokyo');
    expect(baseDateOf(new Date('2026-10-13T14:59:59.999Z'))).toBe('2026-10-13');
    expect(baseDateOf(new Date('2026-10-13T15:00:00.000Z'))).toBe('2026-10-14');
    expect(baseDateOf(new Date('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01');
    expect(baseDateOf(new Date('2028-02-28T15:00:00.000Z'))).toBe('2028-02-29');
  });

  it('throws a RangeError for an invalid time', () => {
    expect(() => baseDateOf(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('is the same as the base date of the write job (from the compact UTC issue time)', () => {
    expect(writeBaseDateOf('20261013145959')).toBe('2026-10-13');
    expect(writeBaseDateOf('20261013150000')).toBe('2026-10-14');
    expect(() => writeBaseDateOf('not a time')).toThrow(RangeError);
  });
});
