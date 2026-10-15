// T29c fix round 1（ReDoS）: 欄の pattern の閉じた単純な文法（`src/control/data-rules/simple-pattern.ts`）の検査。
// - ページが書いた pattern を正規表現にしない。受ける形（`\d`・`[0-9]`・英数字・カタカナ・ひらがなの範囲と `ー`、ハイフン、`{n}`・`{n,m}`・`+`）だけを
//   解釈し、値に当てる。一覧の外の pattern と、長すぎる pattern は解釈しない（null。判定は `PATTERN_UNSUPPORTED`）。
// - 悪意のある pattern（入れ子の量指定子など）も、正規表現を作らずに速く null になる。
import { describe, expect, it } from 'vitest';
import {
  MAX_SIMPLE_PATTERN_LENGTH,
  MAX_SIMPLE_PATTERN_REPEAT,
  MAX_SIMPLE_PATTERN_VALUE_LENGTH,
  MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS,
  SIMPLE_PATTERN_CLASS_ITEMS,
  matchesSimplePattern,
  parseSimplePattern,
} from '../../src/control/data-rules/simple-pattern.js';
import { textConstraintCheckOf } from '../../src/control/data-rules/text-constraints.js';

const matches = (pattern: string, value: string): boolean | null => {
  const parsed = parseSimplePattern(pattern);
  return parsed === null ? null : matchesSimplePattern(parsed, value);
};

describe('simple pattern: the accepted grammar (T29c fix round 1)', () => {
  it('keeps the class items as a frozen closed list', () => {
    expect(Object.isFrozen(SIMPLE_PATTERN_CLASS_ITEMS)).toBe(true);
    expect(Object.keys(SIMPLE_PATTERN_CLASS_ITEMS)).toEqual(expect.arrayContaining(['0-9', 'A-Z', 'a-z', 'ァ-ヶ', 'ぁ-ん', 'ー']));
  });

  it.each<readonly [string, string, boolean]>([
    ['\\d{3}', '123', true],
    ['\\d{3}', '12', false],
    ['\\d{3}', '1234', false],
    ['\\d{2,4}', '123', true],
    ['\\d{2,4}', '1', false],
    ['[0-9]{11}', '09001234567', true],
    ['[0-9]{11}', '090-0123-4567', false],
    ['\\d{3}-\\d{4}-\\d{4}', '090-0123-4567', true],
    ['[0-9]{3}-[0-9]{4}-[0-9]{4}', '09001234567', false],
    ['\\d{2,4}\\-\\d{2,4}\\-\\d{4}', '03-0000-0000', true],
    ['[A-Za-z0-9]{1,8}', 'abC12', true],
    ['[a-zA-Z0-9]{1,8}', 'abc-12', false],
    ['[0-9A-Za-z]+', 'Z9', true],
    ['[ァ-ヶー]+', 'サトウハナコ', true],
    ['[ァ-ヶー]+', 'さとう', false],
    ['[ァ-ヶー]+', 'サトウ ハナコ', false],
    ['[ぁ-んー]+', 'さとう', true],
    ['^\\d{3}$', '123', true],
    ['[0-9]+[0-9]{2}', '123', true],
    ['[0-9]+[0-9]{2}', '12', false],
    ['\\d+', '', false],
  ])('reads %j against %j as %s', (pattern, value, expected) => {
    expect(matches(pattern, value)).toBe(expected);
  });
});

describe('simple pattern: patterns outside the grammar (T29c fix round 1)', () => {
  it.each([
    '(a+)+$',
    '(?:a|aa)*b',
    '(\\d+)+',
    '.*',
    '\\w+',
    '[^0-9]+',
    '[0-9',
    '\\d{',
    '\\d{3,2}',
    `\\d{${MAX_SIMPLE_PATTERN_REPEAT + 1}}`,
    '\\d{1,99999999999999999999}',
    'abc',
    '[a-f]+',
    '[0-9]*',
    '\\d?',
    'a|b',
    '\\p{L}+',
    '',
    `${'\\d'.repeat(MAX_SIMPLE_PATTERN_LENGTH)}`,
  ])('does not read %j', (pattern) => {
    expect(parseSimplePattern(pattern)).toBeNull();
  });

  it('turns a pattern outside the grammar into PATTERN for every value, quickly and without a regular expression', () => {
    const check = textConstraintCheckOf({ pattern: `(a+)+${'a'.repeat(400)}$`, minlength: null, maxlength: null });
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      expect(check(`${'a'.repeat(40)}!`)).toBe('PATTERN');
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('applies a pattern of the grammar in the text constraints', () => {
    const check = textConstraintCheckOf({ pattern: '[0-9]{11}', minlength: null, maxlength: null });
    expect(check('09001234567')).toBeNull();
    expect(check('090-0123-4567')).toBe('PATTERN');
  });
});

describe('simple pattern: the limits of the work (T29R-fix-1: M-3)', () => {
  /** 最悪の形の時間を測る回数と、名前つきの時間の上限（ms）。 */
  const WORST_CASE_RUNS = 1_000;
  const WORST_CASE_LIMIT_MS = 1_000;
  /** 回数が決まらない量の部品（数字が 1 回以上）。 */
  const DIGITS_ONE_OR_MORE = String.raw`\d+`;

  it('reads at most MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS variable quantifiers (+ and {n,m}), and fixed counts are not counted', () => {
    const variable = (count: number): string => DIGITS_ONE_OR_MORE.repeat(count);
    expect(parseSimplePattern(variable(MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS))).not.toBeNull();
    expect(parseSimplePattern(variable(MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS + 1))).toBeNull();
    expect(parseSimplePattern(`${'[a-z]{1,3}'.repeat(MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS)}${DIGITS_ONE_OR_MORE}`)).toBeNull();
    expect(parseSimplePattern(`${String.raw`\d{3}-`.repeat(MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS)}${DIGITS_ONE_OR_MORE}`)).not.toBeNull();
  });

  it('does not match a value longer than MAX_SIMPLE_PATTERN_VALUE_LENGTH', () => {
    expect(matches('[0-9]+', '1'.repeat(MAX_SIMPLE_PATTERN_VALUE_LENGTH))).toBe(true);
    expect(matches('[0-9]+', '1'.repeat(MAX_SIMPLE_PATTERN_VALUE_LENGTH + 1))).toBe(false);
  });

  it('matches the worst case (the most variable quantifiers and the longest value) within the time limit', () => {
    const parsed = parseSimplePattern(`${DIGITS_ONE_OR_MORE.repeat(MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS)}[a-z]`);
    expect(parsed).not.toBeNull();
    const value = '1'.repeat(MAX_SIMPLE_PATTERN_VALUE_LENGTH);
    const started = performance.now();
    for (let run = 0; run < WORST_CASE_RUNS; run += 1) {
      expect(parsed === null ? null : matchesSimplePattern(parsed, value)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(WORST_CASE_LIMIT_MS);
  });
});
