import { errors } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isPlaywrightTimeoutError } from '../../src/browser/playwright-errors.js';

// CC-017: Playwright の期限切れの判定は、`isPlaywrightTimeoutError` だけで行う。
describe('isPlaywrightTimeoutError (CC-017)', () => {
  it('reports the Playwright TimeoutError as a timeout', () => {
    expect(isPlaywrightTimeoutError(new errors.TimeoutError('Timeout 10ms exceeded.'))).toBe(true);
  });

  it('reports the Playwright TimeoutError as a timeout even when its name was changed', () => {
    const error = new errors.TimeoutError('Timeout 10ms exceeded.');
    error.name = 'Error';

    expect(isPlaywrightTimeoutError(error)).toBe(true);
  });

  it('reports an Error whose name is TimeoutError as a timeout', () => {
    const error = new Error('Timeout 10ms exceeded.');
    error.name = 'TimeoutError';

    expect(isPlaywrightTimeoutError(error)).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('navigation failed')],
    ['a TypeError', new TypeError('bad value')],
    ['an object that is not an Error but is named TimeoutError', { name: 'TimeoutError', message: 'timeout' }],
    ['a string', 'TimeoutError'],
    ['null', null],
    ['undefined', undefined],
  ])('does not report %s as a timeout', (_label, value) => {
    expect(isPlaywrightTimeoutError(value)).toBe(false);
  });

  it('returns false instead of throwing when reading the name throws', () => {
    const error = new Error('hostile');
    Object.defineProperty(error, 'name', {
      get(): string {
        throw new Error('name getter failed');
      },
    });

    expect(isPlaywrightTimeoutError(error)).toBe(false);
  });

  it('returns false instead of throwing when the instanceof check throws', () => {
    const hostile = new Proxy({}, {
      getPrototypeOf(): object {
        throw new Error('prototype unavailable');
      },
    });

    expect(isPlaywrightTimeoutError(hostile)).toBe(false);
  });
});
