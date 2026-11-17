// DEF-240（SREV-ARR2 の確かめ直しの Minor）: 英字のすぐ後に仮名・漢字が続く名前（`deleted済み`・`purgedフラグ`・`status済み`）を、語の区切りとして扱う。
// 語の比べは 1 か所の部品（`fieldNameWordsOf`。`fieldNameHasListedWord`・`fieldNameHasStateWord` が使う）なので、最上位の鍵と行の中の鍵の両方に効く。
// 日本語だけの名前・英語だけの名前の判定は変わらない。
import { describe, expect, it } from 'vitest';
import {
  fieldNameHasRemovalWord,
  fieldNameHasStateWord,
  fieldNameWordsOf,
  isApiRowKeyNameUsable,
  isApiSoftDeleteKeyName,
} from '../../src/discovery/classify.js';

/** SREV-ARR2 の確かめ直しの言い換えのうち、英字の後に仮名・漢字が続くもの。 */
const MIXED_NAMES = ['deleted済み', 'purgedフラグ', 'status済み', 'removed日時', 'trashフラグ', 'is_deleted済み', 'deleteフラグ', 'archived済み', '会員deleted', '旧status'];

describe('DEF-240: the boundary between Latin letters and kana or kanji', () => {
  it('splits a name at the boundary between Latin letters and kana or kanji', () => {
    expect(fieldNameWordsOf('deleted済み')).toEqual(['deleted', '済み']);
    expect(fieldNameWordsOf('purgedフラグ')).toEqual(['purged', 'フラグ']);
    expect(fieldNameWordsOf('会員deleted')).toEqual(['会員', 'deleted']);
    expect(fieldNameWordsOf('ｓｔａｔｕｓ済み')).toEqual(['status', '済み']);
  });

  it.each(MIXED_NAMES)('rejects %s as an inner key and finds its word', (name) => {
    expect(isApiRowKeyNameUsable(name)).toBe(false);
  });

  it('finds the state words and the soft delete words in the mixed names', () => {
    expect(fieldNameHasStateWord('status済み')).toBe(true);
    expect(fieldNameHasStateWord('deleted済み')).toBe(true);
    expect(isApiSoftDeleteKeyName('purgedフラグ')).toBe(true);
    expect(fieldNameHasRemovalWord('deleteフラグ')).toBe(true);
  });

  it('keeps the names only in Japanese and only in English as before', () => {
    expect(fieldNameWordsOf('名前')).toEqual(['名前']);
    expect(fieldNameWordsOf('deleteFlag')).toEqual(['delete', 'flag']);
    expect(fieldNameWordsOf('user_name2')).toEqual(['user', 'name', '2']);
    for (const name of ['name', 'email', 'year', 'title', '名前', 'メール', '住所', 'note_メモ']) {
      expect(isApiRowKeyNameUsable(name), name).toBe(true);
    }
    for (const name of ['削除', '退会', 'deleted', 'status', 'deleteFlag']) {
      expect(isApiRowKeyNameUsable(name), name).toBe(false);
    }
  });
});
