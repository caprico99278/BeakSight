/**
 * DEF-137（DEF-128 と同じ揺らぎ）: 保存の知らせと画面の中身を合わせる部品（`apps/local-ui/src/display/saved-notice.ts`）。保存の後に、同じ画面へ search で
 * 知らせを付けて移るとき、保存した改訂も search に載せ、画面の値の改訂がその改訂に届いたときだけ知らせを出す（古い値のまま「保存しました」を出さない）。
 * 改訂を持たない知らせ（search に改訂がない）は、今のまま出す。
 */
import { describe, expect, it } from 'vitest';
import { isSavedNoticeCurrent, savedRevisionOf } from '../src/display/saved-notice';

describe('DEF-137: the saved notice waits for the saved revision', () => {
  it('reads only a positive safe integer as the saved revision', () => {
    expect(savedRevisionOf(2)).toBe(2);
    for (const value of [0, -1, 1.5, '2', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(savedRevisionOf(value), String(value)).toBeUndefined();
    }
  });

  it('shows the notice only when the revision on the screen reached the saved revision', () => {
    expect(isSavedNoticeCurrent(2, 1)).toBe(false);
    expect(isSavedNoticeCurrent(2, 2)).toBe(true);
    expect(isSavedNoticeCurrent(2, 3)).toBe(true);
  });

  it('keeps a notice without a saved revision as it is', () => {
    expect(isSavedNoticeCurrent(undefined, 1)).toBe(true);
  });
});
