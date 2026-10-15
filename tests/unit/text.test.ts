import { describe, expect, it } from 'vitest';
import {
  BIDI_CONTROL_CHARACTERS,
  compareCodeUnits,
  hasBidiControl,
  hasControlCharacter,
  hasControlOrLineSeparator,
  hasLoneSurrogate,
  normalizeWhitespace,
  removeBidiControls,
  removeLoneSurrogates,
  replaceControlCharacters,
  replaceControlOrLineSeparators,
  truncateText,
} from '../../src/core/text.js';

describe('normalizeWhitespace', () => {
  it('matches replace(/\\s+/gu, " ").trim() for ASCII and Unicode whitespace', () => {
    const inputs = [
      '',
      '   ',
      '  Fixture   audit  ',
      'Primary\n navigation',
      'tab\tseparated\r\nlines',
      ' non-breaking space　ideographic em\uFEFFbom',
      'already normal',
    ];

    for (const input of inputs) {
      expect(normalizeWhitespace(input)).toBe(input.replace(/\s+/gu, ' ').trim());
    }
    expect(normalizeWhitespace('  Fixture   audit  ')).toBe('Fixture audit');
  });
});

describe('truncateText', () => {
  it('returns the original text and reports no truncation when it fits', () => {
    expect(truncateText('short', 5)).toEqual({ text: 'short', truncated: false });
    expect(truncateText('', 0)).toEqual({ text: '', truncated: false });
  });

  it('cuts at the maximum number of UTF-16 code units and reports truncation', () => {
    expect(truncateText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncateText('abc', 0)).toEqual({ text: '', truncated: true });
    expect(truncateText('x'.repeat(600), 512).text).toBe('x'.repeat(512));
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(truncateText('abcdef', 3))).toBe(true);
  });

  it('rejects a maximum length that is not a non-negative safe integer', () => {
    for (const maxLength of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => truncateText('value', maxLength)).toThrow(RangeError);
    }
  });

  it('rejects a value that is not a string, as the former `.slice` call sites did', () => {
    for (const value of [12_345, 0, null, undefined, true, { length: 1 }, ['a', 'b'], Symbol('text')]) {
      expect(() => truncateText(value as never, 10)).toThrow(TypeError);
    }
  });
});

describe('compareCodeUnits', () => {
  it('orders strings by UTF-16 code units, not by locale', () => {
    expect(compareCodeUnits('Z', 'a')).toBe(-1);
    expect(compareCodeUnits('a', 'Z')).toBe(1);
    expect(compareCodeUnits('same', 'same')).toBe(0);
    expect(compareCodeUnits('a', 'ab')).toBe(-1);
    expect(compareCodeUnits('￿', '\u{10000}')).toBe(1);
    expect(['b', 'B', 'a', 'A', 'é', 'e'].sort(compareCodeUnits)).toEqual(['A', 'B', 'a', 'b', 'e', 'é']);
  });
});

// CCX-3（CC-052、CC-053）: 制御文字・行と段落の区切り・向きを変える文字・対になっていないサロゲートの、名前を付けた判定。
describe('character classes (CCX-3)', () => {
  /** BMP のすべてのコード単位（サロゲートを含む）と、補助面の文字の例。 */
  const SAMPLES: readonly string[] = [
    ...Array.from({ length: 0x10000 }, (_, codeUnit) => String.fromCharCode(codeUnit)),
    '\u{1F600}', '\u{E0001}', '\u{10FFFF}',
  ];
  const BIDI_CODE_POINTS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const LINE_SEPARATORS = ['\u2028', '\u2029'];

  /** 判定が期待と違ったサンプル（コードポイントの 16 進）。 */
  const mismatches = (samples: readonly string[], actual: (sample: string) => boolean, expected: (sample: string) => boolean): string[] =>
    samples.filter((sample) => actual(sample) !== expected(sample)).map((sample) => (sample.codePointAt(0) ?? -1).toString(16));

  it('hasControlCharacter is exactly the general category Cc (C0, DEL, C1)', () => {
    expect(mismatches(SAMPLES, hasControlCharacter, (sample) => {
      const codePoint = sample.codePointAt(0) ?? -1;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })).toEqual([]);
  });

  it('hasControlOrLineSeparator is Cc and the line and paragraph separators (Zl, Zp)', () => {
    expect(mismatches(SAMPLES, hasControlOrLineSeparator, (sample) => hasControlCharacter(sample) || LINE_SEPARATORS.includes(sample)))
      .toEqual([]);
  });

  it('hasBidiControl is exactly ALM, LRM, RLM, the embeddings and overrides, and the isolates', () => {
    expect(BIDI_CONTROL_CHARACTERS.map((character) => character.codePointAt(0))).toEqual(BIDI_CODE_POINTS);
    expect(Object.isFrozen(BIDI_CONTROL_CHARACTERS)).toBe(true);
    expect(mismatches(SAMPLES, hasBidiControl, (sample) => BIDI_CODE_POINTS.includes(sample.codePointAt(0) ?? -1))).toEqual([]);
  });

  it('hasLoneSurrogate means the same as !String.prototype.isWellFormed', () => {
    const samples = [...SAMPLES, 'a\ud800b', '\udc00\ud800', '😀', 'x\ud83d', '\ude00x', ''];
    expect(mismatches(samples, hasLoneSurrogate, (sample) => !sample.isWellFormed())).toEqual([]);
    expect(hasLoneSurrogate('\ud800')).toBe(true);
    expect(hasLoneSurrogate('\u{1F600}')).toBe(false);
  });

  it('finds a character anywhere in a longer text, also when called again (no shared regular expression state)', () => {
    for (let round = 0; round < 3; round += 1) {
      expect(hasControlCharacter('abc\u0085def')).toBe(true);
      expect(hasControlOrLineSeparator('abc\u2028def')).toBe(true);
      expect(hasControlCharacter('abc\u2028def')).toBe(false);
      expect(hasBidiControl('abc\u061cdef')).toBe(true);
      expect(hasLoneSurrogate('abc\udfffdef')).toBe(true);
    }
  });

  it('replaces and removes the classes', () => {
    for (let round = 0; round < 2; round += 1) {
      expect(replaceControlCharacters('a\u0000b\u2028c\u009fd', ' ')).toBe('a b\u2028c d');
      expect(replaceControlOrLineSeparators('a\u0000b\u2028c\u2029d\u202ee', ' ')).toBe('a b c d\u202ee');
      expect(removeBidiControls('a\u061cb\u200ec\u202ed\u2069e\u200bf')).toBe('abcde\u200bf');
      expect(removeLoneSurrogates('a\ud800b\u{1F600}c\udfff')).toBe('ab\u{1F600}c');
    }
  });
});
