// T29c（T29c の指示書の判断 5。CC-082 の 1 つ目）: 欄の名前が語の一覧の語に当たるか（`src/discovery/classify.ts` の `fieldNameHasListedWord`）。
// - 英語の語は語の単位の並び（`fieldNameWordsOf`）、日本語の語は部分一致（畳み込んだ形と、区切りを除いた形）。
// - 危険な語の判定（`fieldNameHasDestructiveWord`）は、この関数に危険な語の一覧を渡したものと同じ結果（判定の結果を変えない）。
import { describe, expect, it } from 'vitest';
import { DISCOVERY_DESTRUCTIVE_WORDS } from '../../src/discovery/classification-words.js';
import { fieldNameHasDestructiveWord, fieldNameHasListedWord } from '../../src/discovery/classify.js';

describe('fieldNameHasListedWord (T29c, CC-082)', () => {
  it.each<readonly [string, readonly string[], boolean]>([
    ['telNumber', ['tel'], true],
    ['hotel', ['tel'], false],
    ['user[sign_out]', ['sign-out'], true],
    ['signout_at', ['sign-out'], false],
    ['電話番号', ['電話'], true],
    ['電 話', ['電話'], true],
    ['ＴＥＬ', ['tel'], true],
    ['name', [], false],
    ['', ['tel', '電話'], false],
  ])('reads %j with %j as %s', (name, words, expected) => {
    expect(fieldNameHasListedWord(name, words)).toBe(expected);
  });

  it('gives the same result as the destructive word judgement of the discovery', () => {
    const names = ['delete_flag', 'deleteFlag', 'include_disabled', 'user[remove]', 'sign-out', 'signOut', '削除フラグ', '取り 消し', 'XMLDelete',
      'delete2', 'name', 'cancel_reason', 'キャンセル', 'ｷｬﾝｾﾙ', 'archive', 'archived_at', 'bulk-edit', 'title', ''];
    for (const name of names) {
      expect(fieldNameHasListedWord(name, DISCOVERY_DESTRUCTIVE_WORDS), name).toBe(fieldNameHasDestructiveWord(name));
    }
  });
});
