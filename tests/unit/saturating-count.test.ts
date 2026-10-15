import { describe, expect, it } from 'vitest';
import { saturatingAdd, saturatingIncrement } from '../../src/core/saturating-count.js';

// CCX-2（CC-055・CC-067 の前半）: 件数を安全な整数の上限（`Number.MAX_SAFE_INTEGER`）で止める足し算の owner は
// `src/core/saturating-count.ts`。Safety Ledger と Guard は、これを使う。
describe('saturating counts in src/core (CCX-2, CC-055, CC-067)', () => {
  it('adds one below the safe integer limit', () => {
    expect(saturatingIncrement(0)).toBe(1);
    expect(saturatingIncrement(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stays at the safe integer limit', () => {
    expect(saturatingIncrement(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('adds an increment and stops at the safe integer limit', () => {
    const increment = 3;
    expect(saturatingAdd(0, increment)).toBe(increment);
    expect(saturatingAdd(Number.MAX_SAFE_INTEGER - 1, increment)).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturatingAdd(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturatingAdd(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps every result a safe integer', () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      expect(Number.isSafeInteger(saturatingIncrement(value))).toBe(true);
      expect(Number.isSafeInteger(saturatingAdd(value, Number.MAX_SAFE_INTEGER))).toBe(true);
    }
  });
});
