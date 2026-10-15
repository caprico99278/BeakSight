// CCX-11（CC-063）: 管理データの日時（UTC の 14 桁）を、画面に返す ISO 8601 と時刻（ms）に読み戻す（`src/server/timestamps.ts`）。
import { describe, expect, it } from 'vitest';
import { formatDateTime, formatNotObserved } from '../../../src/presentation/format.js';
import { compactTimestampMs, isoTimestampOf, isoTimestampOrNull } from '../src/server/timestamps';

describe('timestamps for the local UI (CC-063)', () => {
  it.each([
    ['20261011090300', '2026-10-11T09:03:00Z'],
    ['20240229235959', '2024-02-29T23:59:59Z'],
    ['10000101000000', '1000-01-01T00:00:00Z'],
  ])('turns %s into %s, and its time', (compact, iso) => {
    expect(isoTimestampOf(compact)).toBe(iso);
    expect(isoTimestampOrNull(compact)).toBe(iso);
    expect(compactTimestampMs(compact)).toBe(Date.parse(iso));
  });

  it('keeps null as null', () => {
    expect(isoTimestampOrNull(null)).toBeNull();
  });

  // CCX-11 で意図して変えた行（設計者の判断 4。core の厳しい読み戻しにそろえる）: 以前は、形の違う値をそのまま返し（表示もそのまま）、
  // `compactTimestampMs` は `Date.parse` で読める形（`2026-10-11`）を時刻にしていた。今は、どれも読み戻さず「未観測」と `null`。
  it.each(['2026-10-11', 'garbage', '', '2026-10-11T09:03:00Z', '2026101109030'])('shows a value of another shape (%j) as not observed', (compact) => {
    expect(isoTimestampOf(compact)).toBe(formatNotObserved());
    expect(isoTimestampOrNull(compact)).toBe(formatNotObserved());
    expect(formatDateTime(isoTimestampOf(compact))).toBe(formatNotObserved());
    expect(compactTimestampMs(compact)).toBeNull();
  });

  // CCX-11 で意図して変えた行: 以前は、ありえない日時を ISO 8601 の形にして返し、表示の `Date.parse` が繰り越して別の日時を示していた
  // （`20260230120000` は `2026-03-02 21:00:00 JST`、`20261010240000` は `2026-10-11 09:00:00 JST`）か、そのままの文字列を示していた
  // （`20261301000000` は `2026-13-01T00:00:00Z`）。今は、どれも「未観測」と `null`。
  it.each(['20260230120000', '20261010240000', '20261301000000', '20250229000000', '20261010126000', '09991231235959'])(
    'shows an impossible date (%s) as not observed, without rolling it over',
    (compact) => {
      expect(isoTimestampOf(compact)).toBe(formatNotObserved());
      expect(formatDateTime(isoTimestampOf(compact))).toBe(formatNotObserved());
      expect(compactTimestampMs(compact)).toBeNull();
    },
  );
});
