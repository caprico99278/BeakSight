/**
 * DN-1（設計書 `doc/design/2026-11-16-beaksight-profile-display-name-design.md` 2・3 章）: サイトの画面に出す名前の決め方（`siteNameOf`。画面のどこも
 * これを通す）。表示名があればそれを、なければ（前の版の管理データ・まだ変えていないサイト）今どおり見分けの印を出す。
 */
import { describe, expect, it } from 'vitest';
import { siteNameOf } from '../src/display/site-name';

describe('DN-1: the name of a site on the screens', () => {
  it('shows the display name when there is one, and the profile id otherwise', () => {
    const names = { 'example-public': 'テストの店' };
    expect(siteNameOf(names, 'example-public')).toBe('テストの店');
    expect(siteNameOf(names, 'example-other')).toBe('example-other');
    expect(siteNameOf({}, 'example-public')).toBe('example-public');
  });
});
