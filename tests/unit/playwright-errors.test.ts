import { errors } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_BY_CLIENT_FAILURE_TEXTS,
  isBlockedByClientFailure,
  isPlaywrightTimeoutError,
} from '../../src/browser/playwright-errors.js';

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

// L4（サイトへの負荷の制御の設計書 4.5）: `route.abort('blockedbyclient')` で止めた要求の失敗の理由の、完全一致の閉じた一覧。
// Chromium は、文書の要求では `net::ERR_BLOCKED_BY_CLIENT`、文書以外の要求では `net::ERR_BLOCKED_BY_CLIENT.Inspector` を報告する。
describe('isBlockedByClientFailure (L4)', () => {
  it('lists exactly the two failure texts Chromium reports for requests aborted with blockedbyclient', () => {
    expect([...BLOCKED_BY_CLIENT_FAILURE_TEXTS]).toEqual(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_CLIENT.Inspector']);
    expect(Object.isFrozen(BLOCKED_BY_CLIENT_FAILURE_TEXTS)).toBe(true);
  });

  it.each(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_CLIENT.Inspector'])('reports %s as blocked by the client', (text) => {
    expect(isBlockedByClientFailure(text)).toBe(true);
  });

  it.each([
    ['another failure', 'net::ERR_CONNECTION_REFUSED'],
    ['an aborted request', 'net::ERR_ABORTED'],
    ['a longer text with the same prefix', 'net::ERR_BLOCKED_BY_CLIENT.Other'],
    ['a different case', 'net::err_blocked_by_client'],
    ['surrounding spaces', ' net::ERR_BLOCKED_BY_CLIENT '],
    ['a related but different reason', 'net::ERR_BLOCKED_BY_RESPONSE'],
    ['an empty text', ''],
    ['null', null],
    ['undefined', undefined],
  ])('does not report %s as blocked by the client (unknown reasons are counted)', (_label, text) => {
    expect(isBlockedByClientFailure(text)).toBe(false);
  });
});
