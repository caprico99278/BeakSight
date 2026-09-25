import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../src/core/immutable.js';

describe('deepFreeze', () => {
  it('freezes nested objects and arrays and returns the same reference', () => {
    const value = { outer: { inner: { leaf: 1 } }, list: [{ item: 'a' }, ['nested']] };

    const frozen = deepFreeze(value);

    expect(frozen).toBe(value);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.outer)).toBe(true);
    expect(Object.isFrozen(frozen.outer.inner)).toBe(true);
    expect(Object.isFrozen(frozen.list)).toBe(true);
    expect(Object.isFrozen(frozen.list[0])).toBe(true);
    expect(Object.isFrozen(frozen.list[1])).toBe(true);
  });

  it('returns primitives and null unchanged', () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it('handles shared and cyclic references without infinite recursion', () => {
    const shared = { value: 1 };
    const cyclic: { self?: unknown; shared: typeof shared; again: typeof shared } = { shared, again: shared };
    cyclic.self = cyclic;

    deepFreeze(cyclic);

    expect(Object.isFrozen(cyclic)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it('does not descend into an object that is already frozen, matching the existing implementations', () => {
    const child = { value: 1 };
    const alreadyFrozen = Object.freeze({ child });

    deepFreeze(alreadyFrozen);

    expect(Object.isFrozen(child)).toBe(false);
  });
});
