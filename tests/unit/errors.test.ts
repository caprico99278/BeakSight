import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_FALLBACK, errorMessageOrString, safeErrorMessage } from '../../src/core/errors.js';

describe('safeErrorMessage', () => {
  it('returns the message of an Error without the error name', () => {
    expect(safeErrorMessage(new TypeError('bad input'))).toBe('bad input');
  });

  it('describes primitive values without throwing', () => {
    expect(safeErrorMessage('plain failure')).toBe('plain failure');
    expect(safeErrorMessage(undefined)).toBe('undefined');
    expect(safeErrorMessage(null)).toBe('null');
    expect(safeErrorMessage(true)).toBe('true');
    expect(safeErrorMessage(false)).toBe('false');
    expect(safeErrorMessage(42.5)).toBe('42.5');
    expect(safeErrorMessage(Number.NaN)).toBe('NaN');
    expect(safeErrorMessage(Symbol('secret'))).toBe('symbol');
    expect(safeErrorMessage(10n)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('reads a string message from plain objects and functions', () => {
    const callable = Object.assign(() => undefined, { message: 'callable failure' });

    expect(safeErrorMessage({ message: 'object failure' })).toBe('object failure');
    expect(safeErrorMessage(callable)).toBe('callable failure');
  });

  it('uses the fallback when an object has no string message', () => {
    expect(safeErrorMessage({})).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage({ message: 404 })).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage({ message: { toString: () => 'coerced' } })).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(Object.create(null) as object)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('uses the fallback when reading the message throws', () => {
    const throwingGetter = Object.defineProperty({}, 'message', {
      get(): never {
        throw new Error('getter exploded');
      },
    });
    const throwingProxy = new Proxy({}, {
      get(): never {
        throw new Error('proxy trap exploded');
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(safeErrorMessage(throwingGetter)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(throwingProxy)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(revocable.proxy)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('reads a message through a well-behaved Proxy', () => {
    const proxy = new Proxy({}, {
      get: (_target, property) => (property === 'message' ? 'proxied failure' : undefined),
    });

    expect(safeErrorMessage(proxy)).toBe('proxied failure');
  });

  it('does not call toString or Symbol.toPrimitive on hostile objects', () => {
    let coerced = false;
    const hostile = {
      toString(): string {
        coerced = true;
        throw new Error('toString exploded');
      },
      [Symbol.toPrimitive](): string {
        coerced = true;
        throw new Error('toPrimitive exploded');
      },
    };

    expect(safeErrorMessage(hostile)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(coerced).toBe(false);
  });

  it('keeps a long message whole (LZ-2: no length limit)', () => {
    const long = 'x'.repeat(2_049);
    expect(safeErrorMessage(new Error(long))).toBe(long);
    expect(safeErrorMessage({ message: long })).toBe(long);
  });

  it('uses the caller-provided fallback wherever the default fallback would be used', () => {
    const fallback = 'Caller error could not be safely normalized';
    const throwingProxy = new Proxy({}, {
      get(): never {
        throw new Error('proxy trap exploded');
      },
    });

    expect(safeErrorMessage({}, fallback)).toBe(fallback);
    expect(safeErrorMessage({ message: 404 }, fallback)).toBe(fallback);
    expect(safeErrorMessage(throwingProxy, fallback)).toBe(fallback);
    expect(safeErrorMessage(10n, fallback)).toBe(fallback);
    expect(safeErrorMessage(new Error('readable'), fallback)).toBe('readable');
    expect(safeErrorMessage(undefined, fallback)).toBe('undefined');
    expect(safeErrorMessage({}, undefined)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('defines a non-empty fallback message', () => {
    expect(ERROR_MESSAGE_FALLBACK.length).toBeGreaterThan(0);
  });
});

describe('errorMessageOrString (PRE42-CC group 5a, N1)', () => {
  // 置き換える前のインラインの式（`error instanceof Error ? error.message : String(error)`）と、どの値でも同じ結果になる。
  const inline = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  it('returns the message of an Error and String(value) otherwise, the same as the inline expression', () => {
    const values: readonly unknown[] = [
      new Error('broken'),
      new TypeError(''),
      Object.assign(new Error('with code'), { code: 'ENOENT' }),
      'plain failure',
      '',
      undefined,
      null,
      42,
      10n,
      Symbol('name'),
      { message: 'not an Error' },
      { toString: () => 'custom' },
      [1, 2],
    ];
    for (const value of values) {
      expect(errorMessageOrString(value)).toBe(inline(value));
    }
    expect(errorMessageOrString(new Error('broken'))).toBe('broken');
    expect(errorMessageOrString({ message: 'not an Error' })).toBe('[object Object]');
  });

  it('does not limit the length', () => {
    const long = 'x'.repeat(4_096);
    expect(errorMessageOrString(new Error(long))).toBe(long);
  });
});
