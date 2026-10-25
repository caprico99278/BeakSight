// T43c（Task 43 の設計書 4.3）: 入口の確かめの、一意な CSS の組み立ての純粋な部品（`src/discovery/entry-check-selectors.ts`）の単体テスト。
// - 識別子の escape（CSSOM の「識別子の直列化」と同じ形。数字で始まる id、`-` だけ、記号、制御文字、NUL、非 ASCII）。
// - 文字列の escape（引用符、`\`、制御文字）。
// - 1 つの要素の事実からの候補の並び（`#id` → `tag[name="…"]` → `tag[type="…"]`。空の属性は使わない。同じ候補を重ねない）。
// - 候補ごとの数え方の結果から、ちょうど 1 つに当たり、その要素を指す最初の候補を選ぶ（0 件・2 件・別の要素は選ばない）。
// - 欄の候補の数がちょうど 1 つでなければ、案を出さない。
import { describe, expect, it } from 'vitest';
import {
  cssIdentifierOf,
  cssStringOf,
  entryFieldSelectorOf,
  entrySelectorCandidatesOf,
  uniqueEntrySelectorOf,
  type EntrySelectorCheck,
} from '../../src/discovery/entry-check-selectors.js';

describe('T43c: the CSS identifier escape (the CSSOM serialization of an identifier)', () => {
  it.each([
    ['email', 'email'],
    ['login-email', 'login-email'],
    ['_user', '_user'],
    ['1user', '\\31 user'],
    ['-1user', '-\\31 user'],
    ['-', '\\-'],
    ['--x', '--x'],
    ['a b', 'a\\ b'],
    ['a.b#c', 'a\\.b\\#c'],
    ['login:email', 'login\\:email'],
    ['x"y', 'x\\"y'],
    ['x\\y', 'x\\\\y'],
    ['\u0001x', '\\1 x'],
    ['x\u007fy', 'x\\7f y'],
    ['\u0000x', '�x'],
    ['メール', 'メール'],
  ])('escapes %j as %j', (value, expected) => {
    expect(cssIdentifierOf(value)).toBe(expected);
  });
});

describe('T43c: the CSS string escape', () => {
  it.each([
    ['email', '"email"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
    ['a\nb', '"a\\a b"'],
    ['\u0000', '"�"'],
    ['user[name]', '"user[name]"'],
  ])('quotes %j as %j', (value, expected) => {
    expect(cssStringOf(value)).toBe(expected);
  });
});

describe('T43c: the selector candidates of one element', () => {
  it('lists #id, then tag[name], then tag[type], escaping each part', () => {
    expect(entrySelectorCandidatesOf({ tag: 'input', id: '1st-mail', name: 'user[email]', type: 'email' })).toEqual([
      '#\\31 st-mail',
      'input[name="user[email]"]',
      'input[type="email"]',
    ]);
  });

  it('skips the empty attributes (an element with only a type gives the type selector)', () => {
    expect(entrySelectorCandidatesOf({ tag: 'input', id: '', name: '', type: 'password' })).toEqual(['input[type="password"]']);
    expect(entrySelectorCandidatesOf({ tag: 'button', id: '', name: 'go', type: '' })).toEqual(['button[name="go"]']);
  });

  it('gives no candidate without a tag, or without any of the attributes', () => {
    expect(entrySelectorCandidatesOf({ tag: '', id: 'x', name: 'y', type: 'z' })).toEqual([]);
    expect(entrySelectorCandidatesOf({ tag: 'div', id: '', name: '', type: '' })).toEqual([]);
  });

  // FM2R の Minor 14: 秘密に見える `id`・`name`（判定は `src/core/url-path-redaction.ts` の `isValueLikeText`。区切り `-`・`_`・`.`・`:` で分けた部分にも
  // 当てる）は、候補の CSS に使わない（`tag[type="…"]` は残す）。ふつうの名前は今どおり使う。
  it('never builds a candidate from a secret-looking id or name', () => {
    const hex = '0123456789abcdef'.repeat(4);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLXZhbHVl';
    expect(entrySelectorCandidatesOf({ tag: 'input', id: `t${hex}`, name: `p${hex}`, type: 'text' })).toEqual(['input[type="text"]']);
    expect(entrySelectorCandidatesOf({ tag: 'input', id: `pw-${hex}`, name: `pw_${hex}`, type: 'password' })).toEqual(['input[type="password"]']);
    expect(entrySelectorCandidatesOf({ tag: 'input', id: jwt, name: 'user@example.com', type: '' })).toEqual([]);
    expect(entrySelectorCandidatesOf({ tag: 'input', id: 'login-email', name: 'user[email]', type: 'email' })).toEqual([
      '#login-email',
      'input[name="user[email]"]',
      'input[type="email"]',
    ]);
  });

  // FM2R の確かめ直しの R-2: セレクタの案に固有の決まり（UUID、16 桁以上の 16 進、10 桁以上の数字の連なり、角括弧も区切り）。共通の判定
  // `isValueLikeText` の意味は変えない（URL の path の伏せ字は今どおり）。
  it('never builds a candidate from a UUID, a 16-digit hex, a long digit run, or a secret-looking part in brackets', () => {
    const typeOnly = ['input[type="text"]'];
    for (const value of [
      '3f2b8c1a-9d4e-4f7a-8b6c-1e2d3c4b5a69',
      '0123456789abcdef',
      `login[${'0123456789abcdef'.repeat(2)}]`,
      '482910374615',
      'user-4829103746',
    ]) {
      expect(entrySelectorCandidatesOf({ tag: 'input', id: value, name: value, type: 'text' }), value).toEqual(typeOnly);
    }
    // ふつうの名前（短い数字、15 桁までの 16 進に見えない語、角括弧の中のふつうの語）は、今どおり使う。
    expect(entrySelectorCandidatesOf({ tag: 'input', id: 'username', name: 'login[email]', type: 'text' })).toEqual([
      '#username', 'input[name="login[email]"]', 'input[type="text"]',
    ]);
    expect(entrySelectorCandidatesOf({ tag: 'input', id: 'field-123456789', name: 'deadbeef', type: '' })).toEqual([
      '#field-123456789', 'input[name="deadbeef"]',
    ]);
  });
});

describe('T43c: choosing the unique selector', () => {
  const check = (selector: string, matches: number, matchesElement: boolean): EntrySelectorCheck => ({ selector, matches, matchesElement });

  it('chooses the first selector that matches exactly one element, which is the candidate', () => {
    expect(uniqueEntrySelectorOf([check('#email', 2, true), check('input[name="email"]', 1, true), check('input[type="email"]', 1, true)]))
      .toBe('input[name="email"]');
  });

  it('chooses nothing when every selector matches no element, two elements, or another element', () => {
    expect(uniqueEntrySelectorOf([check('#a', 0, false), check('#b', 2, true), check('#c', 1, false)])).toBeNull();
    expect(uniqueEntrySelectorOf([])).toBeNull();
  });

  it('gives a field selector only when the field has exactly one candidate', () => {
    const checks = [check('#password', 1, true)];
    expect(entryFieldSelectorOf(1, checks)).toBe('#password');
    expect(entryFieldSelectorOf(0, checks)).toBeNull();
    expect(entryFieldSelectorOf(2, checks)).toBeNull();
  });
});
