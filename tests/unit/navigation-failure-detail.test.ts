// R15a（Task 14〜17 の設計書 5.6.4）: ナビゲーションが失敗したときの理由（`NAVIGATION_FAILED`）の detail。
// Run Coordinator は、この detail で再試行するかを判断する。
import { describe, expect, it } from 'vitest';
import { chromiumNetErrorCode, navigationFailureDetail } from '../../src/orchestration/page-auditor.js';

describe('chromiumNetErrorCode', () => {
  it.each([
    ['page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/\nCall log:\n  - navigating to "http://127.0.0.1:9/"', 'net::ERR_CONNECTION_REFUSED'],
    ['page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:9/', 'net::ERR_CONNECTION_RESET'],
    ['net::ERR_EMPTY_RESPONSE', 'net::ERR_EMPTY_RESPONSE'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED; retry: net::ERR_ABORTED', 'net::ERR_NAME_NOT_RESOLVED'],
    ['page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at http://127.0.0.1:9/', 'net::ERR_HTTP2_PROTOCOL_ERROR'],
  ])('takes the first Chromium error code from %j', (failureDetail, code) => {
    expect(chromiumNetErrorCode(failureDetail)).toBe(code);
  });

  it.each([
    ['a message without a code', 'page.goto: Target page, context or browser has been closed'],
    ['a lower-case code', 'page.goto: net::err_connection_refused'],
    ['a code without the name', 'page.goto: net::ERR_'],
    ['an empty message', ''],
    ['no message', null],
  ])('returns null for %s', (_label, failureDetail) => {
    expect(chromiumNetErrorCode(failureDetail)).toBeNull();
  });
});

describe('navigationFailureDetail', () => {
  it('writes TIMEOUT and BLOCKED_EXTERNAL_REDIRECT as the outcome kind itself', () => {
    expect(navigationFailureDetail({ navigationOutcome: 'TIMEOUT', failureDetail: 'page.goto: Timeout 1000ms exceeded.' }))
      .toBe('TIMEOUT');
    expect(navigationFailureDetail({
      navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT',
      failureDetail: 'page.goto: net::ERR_BLOCKED_BY_CLIENT at http://127.0.0.1:9/',
    })).toBe('BLOCKED_EXTERNAL_REDIRECT');
  });

  it('writes FAILED:<Chromium error code> for other failures', () => {
    expect(navigationFailureDetail({
      navigationOutcome: 'FAILED',
      failureDetail: 'page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:9/',
    })).toBe('FAILED:net::ERR_CONNECTION_RESET');
  });

  it('writes FAILED when the failure has no Chromium error code', () => {
    expect(navigationFailureDetail({ navigationOutcome: 'FAILED', failureDetail: 'page.goto: Target closed' })).toBe('FAILED');
    expect(navigationFailureDetail({ navigationOutcome: 'FAILED', failureDetail: null })).toBe('FAILED');
  });

  it('rejects the OK outcome, which is not a navigation failure', () => {
    expect(() => navigationFailureDetail({ navigationOutcome: 'OK', failureDetail: null })).toThrow(RangeError);
  });
});
