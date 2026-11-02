/**
 * MI-C2 項目 19: 画面の URL の search の値を閉じた一覧の値だけにする部品（`src/display/search-values.ts`）。一覧の値はそのまま、ほか（ほかの文字列、
 * 文字列でない値、なし）は一覧にない値として扱う。画面ごとの確かめ直しは、各画面のテスト（一覧にない値で知らせを出さない）が確かめる。
 */
import { describe, expect, it } from 'vitest';
import { closedSearchValueOf, isClosedSearchValue } from '../src/display/search-values';

const NOTICES = Object.freeze(['saved', 'removed'] as const);

describe('MI-C2: the search values of a closed list', () => {
  it('keeps a value of the list and drops any other value', () => {
    expect(closedSearchValueOf(NOTICES, 'saved')).toBe('saved');
    expect(closedSearchValueOf(NOTICES, 'removed')).toBe('removed');
    for (const value of ['foo', 'Saved', '', undefined, null, 1, ['saved'], { saved: true }]) {
      expect(closedSearchValueOf(NOTICES, value), JSON.stringify(value)).toBeUndefined();
      expect(isClosedSearchValue(NOTICES, value), JSON.stringify(value)).toBe(false);
    }
    expect(isClosedSearchValue(NOTICES, 'saved')).toBe(true);
  });
});
