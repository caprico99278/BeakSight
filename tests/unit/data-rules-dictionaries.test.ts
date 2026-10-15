/**
 * 辞書（`src/control/data-rules/dictionaries/`。Task 29 の設計書 2 章の判断 3、3 章の辞書。T29b）の固定のテスト。
 * - 件数（姓・名は各 30〜50 件、備考の文例と商品名は各 10〜20 件）。
 * - 重なりがない（姓・名は表記とフリガナのそれぞれで）。
 * - 危険な語（発見の分類の危険な語。部分一致）・秘密に見える語・外部到達の語（電話・メール・通知など）に当たらない。
 * - 制御文字・行と段落の区切り・向きを変える文字・対になっていないサロゲートがない（`src/core/text.ts` の判定）。前後に空白がない。
 * - フリガナはカタカナだけ。
 *
 * 外部到達の語は、T29a の owner（`src/control/data-rules/external-delivery-words.ts`）の一覧と判定で確かめる。欄の名前の判定（語の単位）に
 * 加えて、一覧の語（欄の名前の語と autocomplete の値）が文のどこかに含まれないことも確かめる（部分一致。辞書の側は厳しく見る）。
 */
import { describe, expect, it } from 'vitest';
import {
  AVOIDED_PERSON_NAME_PAIRS,
  DICTIONARY_SIZE_LIMITS,
  FAMILY_NAMES,
  GIVEN_NAMES,
  PRODUCT_NAMES,
  REMARK_PHRASES,
  type NameEntry,
} from '../../src/control/data-rules/dictionaries/dictionaries.js';
import {
  EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS,
  EXTERNAL_DELIVERY_NAME_WORDS,
  externalDeliveryKindsOfName,
} from '../../src/control/data-rules/external-delivery-words.js';
import { isSecretLikeQueryName, isSecretUrlQueryParameterName, SECRET_URL_QUERY_PARAMETER_NAMES } from '../../src/core/secret-query-names.js';
import { foldNfkcCase, hasBidiControl, hasControlOrLineSeparator, hasLoneSurrogate, normalizeWhitespace } from '../../src/core/text.js';
import { readParametersHaveDestructiveWord } from '../../src/discovery/classify.js';

/** 外部到達の語（owner の欄の名前の語と autocomplete の値のすべて。比べる形）。 */
const EXTERNAL_DELIVERY_WORDS: readonly string[] = Object.freeze([
  ...Object.values(EXTERNAL_DELIVERY_NAME_WORDS).flat(),
  ...Object.values(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS).flat(),
]);

/** カタカナ（ァ〜ヺ）と長音の符号（ー）だけ。 */
const KATAKANA_ONLY = /^[ァ-ヺー]+$/u;

const nameTexts = (entries: readonly NameEntry[]): readonly string[] => entries.flatMap(({ name, kana }) => [name, kana]);

const ALL_TEXTS: readonly (readonly [string, string])[] = [
  ...nameTexts(FAMILY_NAMES).map((text) => ['family name', text] as const),
  ...nameTexts(GIVEN_NAMES).map((text) => ['given name', text] as const),
  ...REMARK_PHRASES.map((text) => ['remark', text] as const),
  ...PRODUCT_NAMES.map((text) => ['product', text] as const),
];

describe('data rule dictionaries (Task 29 design 3)', () => {
  it('has the expected number of entries', () => {
    const counts: readonly (readonly [string, number, { readonly min: number; readonly max: number }])[] = [
      ['family names', FAMILY_NAMES.length, DICTIONARY_SIZE_LIMITS.names],
      ['given names', GIVEN_NAMES.length, DICTIONARY_SIZE_LIMITS.names],
      ['remarks', REMARK_PHRASES.length, DICTIONARY_SIZE_LIMITS.phrases],
      ['products', PRODUCT_NAMES.length, DICTIONARY_SIZE_LIMITS.phrases],
    ];
    for (const [label, count, { min, max }] of counts) {
      expect(count, label).toBeGreaterThanOrEqual(min);
      expect(count, label).toBeLessThanOrEqual(max);
    }
    // 設計書の件数（姓・名は 30〜50 件、文例と商品名は 10〜20 件）を、名前つきの上限に固定する。
    expect(DICTIONARY_SIZE_LIMITS).toEqual({ names: { min: 30, max: 50 }, phrases: { min: 10, max: 20 } });
  });

  it('has no duplicates (names and their kana separately)', () => {
    const lists: readonly (readonly [string, readonly string[]])[] = [
      ['family names', FAMILY_NAMES.map(({ name }) => name)],
      ['family kana', FAMILY_NAMES.map(({ kana }) => kana)],
      ['given names', GIVEN_NAMES.map(({ name }) => name)],
      ['given kana', GIVEN_NAMES.map(({ kana }) => kana)],
      ['remarks', REMARK_PHRASES],
      ['products', PRODUCT_NAMES],
    ];
    for (const [label, list] of lists) {
      expect(new Set(list).size, label).toBe(list.length);
    }
    // 姓と名に、同じ表記の語を置かない（どちらの語かが決まるように）。
    const familyNames = new Set(FAMILY_NAMES.map(({ name }) => name));
    expect(GIVEN_NAMES.filter(({ name }) => familyNames.has(name))).toEqual([]);
  });

  it('has kana in katakana only', () => {
    for (const { name, kana } of [...FAMILY_NAMES, ...GIVEN_NAMES]) {
      expect(kana, name).toMatch(KATAKANA_ONLY);
    }
  });

  it('does not hit destructive words', () => {
    for (const [label, text] of ALL_TEXTS) {
      expect(readParametersHaveDestructiveWord({ '': text }), `${label}: ${text}`).toBe(false);
    }
  });

  it('does not hit secret-like words', () => {
    const secretWords = SECRET_URL_QUERY_PARAMETER_NAMES.map(foldNfkcCase);
    for (const [label, text] of ALL_TEXTS) {
      const folded = foldNfkcCase(text);
      expect(isSecretLikeQueryName(text), `${label}: ${text}`).toBe(false);
      expect(isSecretUrlQueryParameterName(text), `${label}: ${text}`).toBe(false);
      expect(secretWords.filter((word) => folded.includes(word)), `${label}: ${text}`).toEqual([]);
    }
  });

  it('does not hit external delivery words (the owner of T29a)', () => {
    expect(EXTERNAL_DELIVERY_WORDS.length).toBeGreaterThan(0);
    for (const [label, text] of ALL_TEXTS) {
      const folded = foldNfkcCase(text);
      expect(externalDeliveryKindsOfName(text), `${label}: ${text}`).toEqual([]);
      expect(EXTERNAL_DELIVERY_WORDS.filter((word) => folded.includes(word)), `${label}: ${text}`).toEqual([]);
    }
  });

  it('has no control characters, line separators, bidi controls, lone surrogates or surrounding spaces', () => {
    for (const [label, text] of ALL_TEXTS) {
      expect(text.length, `${label}: ${text}`).toBeGreaterThan(0);
      expect(hasControlOrLineSeparator(text), `${label}: ${text}`).toBe(false);
      expect(hasBidiControl(text), `${label}: ${text}`).toBe(false);
      expect(hasLoneSurrogate(text), `${label}: ${text}`).toBe(false);
      expect(normalizeWhitespace(text), `${label}: ${text}`).toBe(text);
    }
  });

  it('the checks above detect violating samples (not vacuous)', () => {
    expect(readParametersHaveDestructiveWord({ '': '予約を削除する' })).toBe(true);
    expect(isSecretLikeQueryName('my_token')).toBe(true);
    expect(EXTERNAL_DELIVERY_WORDS.filter((word) => foldNfkcCase('メールで受け取る').includes(word))).not.toEqual([]);
    expect(externalDeliveryKindsOfName('電話番号')).not.toEqual([]);
    expect(hasControlOrLineSeparator('a\u0007b')).toBe(true);
    expect(hasBidiControl('a‮b')).toBe(true);
    expect('さとう').not.toMatch(KATAKANA_ONLY);
    expect('サトウ').toMatch(KATAKANA_ONLY);
  });

  it('is frozen', () => {
    for (const list of [FAMILY_NAMES, GIVEN_NAMES, REMARK_PHRASES, PRODUCT_NAMES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    for (const entry of [...FAMILY_NAMES, ...GIVEN_NAMES]) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe('avoided person name pairs (T29R-fix-1: M-8)', () => {
  /** 一覧の件数の下限（設計者の判断の 7 組）。 */
  const MIN_AVOIDED_PAIRS = 7;

  it('is a frozen closed list of pairs of the name dictionaries, without duplicates', () => {
    expect(Object.isFrozen(AVOIDED_PERSON_NAME_PAIRS)).toBe(true);
    expect(AVOIDED_PERSON_NAME_PAIRS.length).toBeGreaterThanOrEqual(MIN_AVOIDED_PAIRS);
    const families = new Set(FAMILY_NAMES.map((entry) => entry.name));
    const givens = new Set(GIVEN_NAMES.map((entry) => entry.name));
    const keys = AVOIDED_PERSON_NAME_PAIRS.map(({ family, given }) => JSON.stringify([family, given]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const pair of AVOIDED_PERSON_NAME_PAIRS) {
      expect(Object.isFrozen(pair)).toBe(true);
      expect(Object.keys(pair).sort()).toEqual(['family', 'given']);
      expect(families.has(pair.family), pair.family).toBe(true);
      expect(givens.has(pair.given), pair.given).toBe(true);
    }
  });
});
