import { describe, expect, it } from 'vitest';
import {
  isNonNegativeFiniteNumber,
  isNonNegativeSafeInteger,
  isPositiveFiniteNumber,
  isPositiveSafeInteger,
  isRecord,
} from '../../src/core/guards.js';

describe('isRecord', () => {
  it('accepts non-null, non-array objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
  });

  it('rejects null, arrays, functions, and primitives', () => {
    for (const value of [null, undefined, [], [1], () => undefined, 'text', 1, true, Symbol('s'), 1n]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('isPositiveFiniteNumber', () => {
  it('accepts finite numbers greater than zero', () => {
    for (const value of [Number.MIN_VALUE, 0.5, 1, 1_280, Number.MAX_VALUE]) {
      expect(isPositiveFiniteNumber(value)).toBe(true);
    }
  });

  it('rejects zero, negatives, non-finite numbers, and non-numbers', () => {
    for (const value of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', 1n, null, undefined]) {
      expect(isPositiveFiniteNumber(value)).toBe(false);
    }
  });
});

describe('isNonNegativeSafeInteger', () => {
  it('accepts zero and positive safe integers', () => {
    for (const value of [0, -0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(isNonNegativeSafeInteger(value)).toBe(true);
    }
  });

  it('rejects negatives, fractions, unsafe integers, non-finite numbers, and non-numbers', () => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '0', 0n, null]) {
      expect(isNonNegativeSafeInteger(value)).toBe(false);
    }
  });
});

describe('isPositiveSafeInteger', () => {
  it('accepts positive safe integers', () => {
    for (const value of [1, 2, Number.MAX_SAFE_INTEGER]) {
      expect(isPositiveSafeInteger(value)).toBe(true);
    }
  });

  it('rejects zero, negatives, fractions, unsafe integers, non-finite numbers, and non-numbers', () => {
    for (const value of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '1', 1n]) {
      expect(isPositiveSafeInteger(value)).toBe(false);
    }
  });
});

describe('isNonNegativeFiniteNumber', () => {
  it('accepts zero and finite numbers greater than zero', () => {
    for (const value of [0, -0, Number.MIN_VALUE, 0.5, 1, 1_280, Number.MAX_VALUE]) {
      expect(isNonNegativeFiniteNumber(value)).toBe(true);
    }
  });

  it('rejects negatives, non-finite numbers, and non-numbers', () => {
    for (const value of [-Number.MIN_VALUE, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0', 0n, null, undefined]) {
      expect(isNonNegativeFiniteNumber(value)).toBe(false);
    }
  });
});
