import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_FALLBACK, safeErrorMessage } from '../../src/core/errors.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';

describe('safeErrorMessage', () => {
  it('returns the message of an Error without the error name', () => {
    expect(safeErrorMessage(new TypeError('bad input'), MAX_ERROR_MESSAGE_LENGTH)).toBe('bad input');
  });

  it('describes primitive values without throwing', () => {
    expect(safeErrorMessage('plain failure', 100)).toBe('plain failure');
    expect(safeErrorMessage(undefined, 100)).toBe('undefined');
    expect(safeErrorMessage(null, 100)).toBe('null');
    expect(safeErrorMessage(true, 100)).toBe('true');
    expect(safeErrorMessage(false, 100)).toBe('false');
    expect(safeErrorMessage(42.5, 100)).toBe('42.5');
    expect(safeErrorMessage(Number.NaN, 100)).toBe('NaN');
    expect(safeErrorMessage(Symbol('secret'), 100)).toBe('symbol');
    expect(safeErrorMessage(10n, 100)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('reads a string message from plain objects and functions', () => {
    const callable = Object.assign(() => undefined, { message: 'callable failure' });

    expect(safeErrorMessage({ message: 'object failure' }, 100)).toBe('object failure');
    expect(safeErrorMessage(callable, 100)).toBe('callable failure');
  });

  it('uses the fallback when an object has no string message', () => {
    expect(safeErrorMessage({}, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage({ message: 404 }, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage({ message: { toString: () => 'coerced' } }, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(Object.create(null) as object, 100)).toBe(ERROR_MESSAGE_FALLBACK);
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

    expect(safeErrorMessage(throwingGetter, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(throwingProxy, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(safeErrorMessage(revocable.proxy, 100)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('reads a message through a well-behaved Proxy', () => {
    const proxy = new Proxy({}, {
      get: (_target, property) => (property === 'message' ? 'proxied failure' : undefined),
    });

    expect(safeErrorMessage(proxy, 100)).toBe('proxied failure');
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

    expect(safeErrorMessage(hostile, 100)).toBe(ERROR_MESSAGE_FALLBACK);
    expect(coerced).toBe(false);
  });

  it('keeps every result within the caller-provided maximum length', () => {
    const long = 'x'.repeat(5_000);
    const values: readonly unknown[] = [
      long,
      new Error(long),
      { message: long },
      undefined,
      null,
      true,
      123_456_789,
      Symbol('long'),
      10n,
      {},
      new Proxy({}, { get: () => { throw new Error('trap'); } }),
    ];

    for (const maxLength of [0, 1, 3, 16, MAX_ERROR_MESSAGE_LENGTH]) {
      for (const value of values) {
        const message = safeErrorMessage(value, maxLength);
        expect(typeof message).toBe('string');
        expect(message.length).toBeLessThanOrEqual(maxLength);
      }
    }
    expect(safeErrorMessage(new Error(long), MAX_ERROR_MESSAGE_LENGTH)).toBe(long.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    expect(safeErrorMessage(ERROR_MESSAGE_FALLBACK, 5)).toBe(ERROR_MESSAGE_FALLBACK.slice(0, 5));
    expect(safeErrorMessage({}, 5)).toBe(ERROR_MESSAGE_FALLBACK.slice(0, 5));
  });

  it('rejects a maximum length that is not a non-negative safe integer', () => {
    for (const maxLength of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => safeErrorMessage('value', maxLength)).toThrow(RangeError);
    }
  });

  it('uses the caller-provided fallback wherever the default fallback would be used', () => {
    const fallback = 'Caller error could not be safely normalized';
    const throwingProxy = new Proxy({}, {
      get(): never {
        throw new Error('proxy trap exploded');
      },
    });

    expect(safeErrorMessage({}, 100, fallback)).toBe(fallback);
    expect(safeErrorMessage({ message: 404 }, 100, fallback)).toBe(fallback);
    expect(safeErrorMessage(throwingProxy, 100, fallback)).toBe(fallback);
    expect(safeErrorMessage(10n, 100, fallback)).toBe(fallback);
    expect(safeErrorMessage({}, 6, fallback)).toBe(fallback.slice(0, 6));
    expect(safeErrorMessage(new Error('readable'), 100, fallback)).toBe('readable');
    expect(safeErrorMessage(undefined, 100, fallback)).toBe('undefined');
    expect(safeErrorMessage({}, 100, undefined)).toBe(ERROR_MESSAGE_FALLBACK);
  });

  it('defines a non-empty fallback message', () => {
    expect(ERROR_MESSAGE_FALLBACK.length).toBeGreaterThan(0);
    expect(ERROR_MESSAGE_FALLBACK.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
  });
});
