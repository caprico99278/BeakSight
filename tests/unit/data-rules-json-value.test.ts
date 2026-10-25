// T38e（Task 38 の設計書 3.6）: 作った値（文字列）を、鍵の JSON の型に変える部品（`src/control/data-rules/json-value.ts` の `jsonValueOf`）の検査。
// - string はそのまま。number は正規の 10 進の形だけ（先頭の 0、小数部の末尾の 0、指数、`+`、`-0`、空白、16 進を拒む。桁は
//   `MAX_JSON_NUMBER_DIGITS` まで。JSON にしたときの文字列が、元の文字列と同じになる）。boolean は `true`・`false` だけ。null は値を作らない（null）
//   だけ。object・array には変えない。
// - Task 39 の Guard の照合が使う（Node 側の純粋な関数。ブラウザの部品を import しない。`data-rules-boundary.test.ts` の (a)）。
import { describe, expect, it } from 'vitest';
import {
  JSON_SCALAR_VALUE_TYPES,
  JSON_VALUE_CONVERSION_FAILURES,
  MAX_JSON_NUMBER_DIGITS,
  jsonNumberRangeFits,
  jsonValueOf,
  type JsonValueConversionFailure,
} from '../../src/control/data-rules/json-value.js';
import type { ApiJsonValueType } from '../../src/core/api-request-shape.js';

const failureOf = (value: string | null, type: ApiJsonValueType): JsonValueConversionFailure | null => {
  const result = jsonValueOf(value, type);
  return result.ok ? null : result.reason;
};

describe('T38e: the closed lists and the limit', () => {
  it('converts to the scalar JSON types only, with a closed list of failures and a named digit limit', () => {
    expect(JSON_SCALAR_VALUE_TYPES).toEqual(['string', 'number', 'boolean', 'null']);
    expect(JSON_VALUE_CONVERSION_FAILURES).toEqual([
      'VALUE_MISSING', 'NOT_A_NUMBER', 'NOT_CANONICAL_NUMBER', 'TOO_MANY_DIGITS', 'NOT_A_BOOLEAN', 'NOT_NULL', 'NOT_A_SCALAR_TYPE',
    ]);
    expect(Object.isFrozen(JSON_SCALAR_VALUE_TYPES)).toBe(true);
    expect(Object.isFrozen(JSON_VALUE_CONVERSION_FAILURES)).toBe(true);
    expect(MAX_JSON_NUMBER_DIGITS).toBe(15);
  });
});

describe('T38e: string', () => {
  it.each(['abc', '', '01', '1e3', ' 名前 ', 'true', 'null'])('keeps %j as a string', (value) => {
    expect(jsonValueOf(value, 'string')).toEqual({ ok: true, value });
  });
});

describe('T38e: number (the canonical decimal form)', () => {
  it.each([
    ['0', 0],
    ['7', 7],
    ['12', 12],
    ['-12', -12],
    ['1.5', 1.5],
    ['-0.25', -0.25],
    ['0.000001', 0.000001],
    ['123456789012345', 123456789012345],
    ['-12345678901234.5', -12345678901234.5],
    ['0.12345678901234', 0.12345678901234],
  ])('converts %j to the number %j, and JSON keeps the same text', (text, number) => {
    const result = jsonValueOf(text, 'number');
    expect(result).toEqual({ ok: true, value: number });
    expect(result.ok && JSON.stringify(result.value)).toBe(text);
  });

  it.each([
    ['01', 'NOT_CANONICAL_NUMBER'],
    ['00', 'NOT_CANONICAL_NUMBER'],
    ['-01', 'NOT_CANONICAL_NUMBER'],
    ['1.50', 'NOT_CANONICAL_NUMBER'],
    ['1.0', 'NOT_CANONICAL_NUMBER'],
    ['1.', 'NOT_CANONICAL_NUMBER'],
    ['.5', 'NOT_CANONICAL_NUMBER'],
    ['+1', 'NOT_CANONICAL_NUMBER'],
    ['-0', 'NOT_CANONICAL_NUMBER'],
    ['-0.0', 'NOT_CANONICAL_NUMBER'],
    ['1e3', 'NOT_CANONICAL_NUMBER'],
    ['1E3', 'NOT_CANONICAL_NUMBER'],
    ['1e-7', 'NOT_CANONICAL_NUMBER'],
    [' 1', 'NOT_CANONICAL_NUMBER'],
    ['1 ', 'NOT_CANONICAL_NUMBER'],
    ['0x10', 'NOT_CANONICAL_NUMBER'],
    ['1_000', 'NOT_A_NUMBER'],
    ['1,000', 'NOT_A_NUMBER'],
    // JSON にすると指数の表記になる（`1e-7`）。
    ['0.0000001', 'NOT_CANONICAL_NUMBER'],
    ['1234567890123456', 'TOO_MANY_DIGITS'],
    ['0.123456789012345', 'TOO_MANY_DIGITS'],
    ['-1234567890123.456', 'TOO_MANY_DIGITS'],
    ['abc', 'NOT_A_NUMBER'],
    ['', 'NOT_A_NUMBER'],
    [' ', 'NOT_A_NUMBER'],
    ['-', 'NOT_A_NUMBER'],
    ['Infinity', 'NOT_A_NUMBER'],
    ['NaN', 'NOT_A_NUMBER'],
    ['１２', 'NOT_A_NUMBER'],
    ['true', 'NOT_A_NUMBER'],
  ] as const)('rejects %j (%s)', (text, reason) => {
    expect(failureOf(text, 'number')).toBe(reason);
  });
});

describe('T38e: a number range (min, max, step) fits the number key', () => {
  it.each([
    ['1', '9', '1', true],
    ['-5', '5', '0.25', true],
    ['0', '99999999999999', '0.1', true],
    ['0', '999999999999999', '0.5', false],
    ['0.5', '999999999999999', '1', false],
    ['01', '9', '1', false],
    ['1', '9e1', '1', false],
    ['1', '9', '1.0', false],
    ['1', '9', '-0', false],
  ] as const)('min %j, max %j, step %j → %j', (min, max, step, fits) => {
    expect(jsonNumberRangeFits(min, max, step)).toBe(fits);
  });
});

describe('T38e: boolean and null', () => {
  it('converts only true and false to a boolean', () => {
    expect(jsonValueOf('true', 'boolean')).toEqual({ ok: true, value: true });
    expect(jsonValueOf('false', 'boolean')).toEqual({ ok: true, value: false });
    for (const text of ['TRUE', 'False', '1', '0', 'on', '', ' true']) {
      expect(failureOf(text, 'boolean')).toBe('NOT_A_BOOLEAN');
    }
  });

  it('converts only the value not made (null) to null, and a missing value is a failure for the other types', () => {
    expect(jsonValueOf(null, 'null')).toEqual({ ok: true, value: null });
    for (const text of ['null', '', 'NULL']) {
      expect(failureOf(text, 'null')).toBe('NOT_NULL');
    }
    for (const type of ['string', 'number', 'boolean'] as const) {
      expect(failureOf(null, type)).toBe('VALUE_MISSING');
    }
  });

  it('does not convert to an object or an array, and returns frozen results', () => {
    expect(failureOf('{}', 'object')).toBe('NOT_A_SCALAR_TYPE');
    expect(failureOf('[]', 'array')).toBe('NOT_A_SCALAR_TYPE');
    expect(failureOf(null, 'array')).toBe('NOT_A_SCALAR_TYPE');
    expect(Object.isFrozen(jsonValueOf('1', 'number'))).toBe(true);
    expect(Object.isFrozen(jsonValueOf('x', 'number'))).toBe(true);
  });
});
