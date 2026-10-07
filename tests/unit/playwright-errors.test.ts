import { errors } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_BY_CLIENT_FAILURE_TEXTS,
  INVALID_INTERCEPTION_ID_FAILURE_TEXTS,
  isBlockedByClientFailure,
  isInvalidInterceptionIdFailure,
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

// DEF-026（設計書 `2026-10-05-beaksight-def-026-guard-canceled-document-design.md` 2章）: Guard の CDP の層の命令
// （`Fetch.continueRequest`、`Fetch.failRequest`）が、一時停止の ID が無効なために失敗したときの文言の、完全一致の閉じた一覧。
// page の session（Playwright の `CDPSession.send`）は命令の名前を含む形、OOPIF の session は Chromium の失敗の応答の文言そのもの。
describe('isInvalidInterceptionIdFailure (DEF-026)', () => {
  /** page の session の、進める命令の失敗の文言（DEF-026 の調査で、本番と同じ文言を再現した）。 */
  const PAGE_CONTINUE_TEXT = 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.';
  /** page の session の、止める命令の失敗の文言。 */
  const PAGE_FAIL_TEXT = 'cdpSession.send: Protocol error (Fetch.failRequest): Invalid InterceptionId.';
  /** OOPIF の session の失敗の文言（Chromium の失敗の応答の `message`。進める命令と止める命令で同じ）。 */
  const OOPIF_TEXT = 'Invalid InterceptionId.';

  it('lists exactly the page session texts of both commands and the OOPIF session text', () => {
    expect([...INVALID_INTERCEPTION_ID_FAILURE_TEXTS]).toEqual([PAGE_CONTINUE_TEXT, PAGE_FAIL_TEXT, OOPIF_TEXT]);
    expect(Object.isFrozen(INVALID_INTERCEPTION_ID_FAILURE_TEXTS)).toBe(true);
  });

  it.each([PAGE_CONTINUE_TEXT, PAGE_FAIL_TEXT, OOPIF_TEXT])('reports %s as an invalid interception id failure', (text) => {
    expect(isInvalidInterceptionIdFailure(text)).toBe(true);
  });

  it.each([
    ['the OOPIF text without the final period', 'Invalid InterceptionId'],
    ['the page text without the final period', 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId'],
    ['the page text without the cdpSession.send prefix', 'Protocol error (Fetch.continueRequest): Invalid InterceptionId.'],
    ['the same failure of another command', 'cdpSession.send: Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.'],
    ['the same failure of another domain', 'cdpSession.send: Protocol error (Network.continueInterceptedRequest): Invalid InterceptionId.'],
    ['a longer text that contains the OOPIF text', 'Protocol error: Invalid InterceptionId.'],
    ['a longer text with the same prefix', 'Invalid InterceptionId. (retry)'],
    ['a different case', 'invalid interceptionid.'],
    ['surrounding spaces', ' Invalid InterceptionId. '],
    ['the failure after the target closed', 'cdpSession.send: Target page, context or browser has been closed'],
    ['the failure after the OOPIF session was detached', 'OOPIF interception session was detached'],
    ['another protocol failure of the same command', 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid state for continueInterceptedRequest'],
    ['an empty text', ''],
    ['null', null],
    ['undefined', undefined],
  ])('does not report %s as an invalid interception id failure (unknown failures stay violations)', (_label, text) => {
    expect(isInvalidInterceptionIdFailure(text)).toBe(false);
  });
});
