// T36R-fix（T36R の M-5）: ログインの応答の状態のコードから結果への表（400・401・423・429 の対応）は 1 か所（`automated-login-results.ts`）で、
// form の送信のログインの文書の応答（`statusOutcome`）と、スクリプトで送るログインの token の送信の応答（`tokenResponseOutcome`）が同じ表を使う。
// `Retry-After` のヘッダの名前と、大文字と小文字を区別しないヘッダの読み方も 1 か所（`src/safety/http-headers.ts`）。
import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_UNKNOWN_RESULT,
  LOGIN_HTTP_STATUS_RESULTS,
  loginHttpStatusResultOf,
} from '../../src/control/auth/automated-login-results.js';
import { TOO_MANY_REQUESTS_HTTP_STATUS } from '../../src/core/http-status.js';
import { RETRY_AFTER_HEADER, headerValueOf } from '../../src/safety/http-headers.js';

/** 表にない状態の例（2xx・3xx・4xx・5xx）。 */
const OK_STATUS = 200;
const FOUND_STATUS = 302;
const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_STATUS = 500;
const UNAVAILABLE_STATUS = 503;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const LOCKED_STATUS = 423;

describe('T36R-fix (M-5): the one table from a login response status to a result', () => {
  it('has the rows for 400, 401, 423 and 429 in one place', () => {
    expect(LOGIN_HTTP_STATUS_RESULTS.map(({ status, result }) => [status, result])).toEqual([
      [BAD_REQUEST_STATUS, 'INVALID_CREDENTIALS'],
      [UNAUTHORIZED_STATUS, 'INVALID_CREDENTIALS'],
      [LOCKED_STATUS, 'ACCOUNT_LOCKED'],
      [TOO_MANY_REQUESTS_HTTP_STATUS, AUTOMATED_LOGIN_RATE_LIMITED_RESULT],
    ]);
    expect(Object.isFrozen(LOGIN_HTTP_STATUS_RESULTS)).toBe(true);
  });

  it('maps a token response: 400 and 401, 423, 429, 5xx, and any other status as unknown', () => {
    const resultOf = (status: number) => loginHttpStatusResultOf(status, 'TOKEN_RESPONSE');
    expect(resultOf(BAD_REQUEST_STATUS)).toBe('INVALID_CREDENTIALS');
    expect(resultOf(UNAUTHORIZED_STATUS)).toBe('INVALID_CREDENTIALS');
    expect(resultOf(LOCKED_STATUS)).toBe('ACCOUNT_LOCKED');
    expect(resultOf(TOO_MANY_REQUESTS_HTTP_STATUS)).toBe(AUTOMATED_LOGIN_RATE_LIMITED_RESULT);
    for (const status of [SERVER_ERROR_STATUS, UNAVAILABLE_STATUS, FOUND_STATUS, NOT_FOUND_STATUS]) {
      expect(resultOf(status)).toBe(AUTOMATED_LOGIN_UNKNOWN_RESULT);
    }
  });

  it('maps a document response of the form login: 429 and 5xx only (400, 401 and 423 are decided by the failure conditions)', () => {
    const resultOf = (status: number) => loginHttpStatusResultOf(status, 'DOCUMENT_RESPONSE');
    expect(resultOf(TOO_MANY_REQUESTS_HTTP_STATUS)).toBe(AUTOMATED_LOGIN_RATE_LIMITED_RESULT);
    expect(resultOf(SERVER_ERROR_STATUS)).toBe(AUTOMATED_LOGIN_UNKNOWN_RESULT);
    for (const status of [OK_STATUS, FOUND_STATUS, BAD_REQUEST_STATUS, UNAUTHORIZED_STATUS, LOCKED_STATUS, NOT_FOUND_STATUS]) {
      expect(resultOf(status)).toBeNull();
    }
  });
});

describe('T36R-fix (M-5): the Retry-After header name and the case-insensitive header reader', () => {
  it('reads a header whatever the letter case of its name, and only a string value', () => {
    expect(RETRY_AFTER_HEADER).toBe('retry-after');
    expect(headerValueOf({ 'Retry-After': '5' }, RETRY_AFTER_HEADER)).toBe('5');
    expect(headerValueOf({ 'RETRY-AFTER': '7' }, 'Retry-After')).toBe('7');
    expect(headerValueOf({ 'retry-after': 5 }, RETRY_AFTER_HEADER)).toBeUndefined();
    expect(headerValueOf({ other: '5' }, RETRY_AFTER_HEADER)).toBeUndefined();
    expect(headerValueOf(undefined, RETRY_AFTER_HEADER)).toBeUndefined();
    expect(headerValueOf(['5'], RETRY_AFTER_HEADER)).toBeUndefined();
  });
});
