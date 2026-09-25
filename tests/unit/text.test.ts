import { describe, expect, it } from 'vitest';
import { compareCodeUnits, normalizeWhitespace, truncateText } from '../../src/core/text.js';

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
