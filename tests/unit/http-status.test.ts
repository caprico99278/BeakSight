import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ruleHelpers from '../../src/audit/rule-helpers.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  ERROR_HTTP_STATUS_RANGE,
  REDIRECTION_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  isHttpErrorOrNonStandardStatus,
  isHttpStatusInRange,
  type HttpStatusRange,
} from '../../src/core/http-status.js';

// CCX-2（CC-042）: HTTP の status の範囲と、その判定の owner は `src/core/http-status.ts`。Rule の補助（`rule-helpers.ts`）は、
// 同じものを今の名前のまま公開し直す（別の値を持たない）。
describe('HTTP status ranges in src/core (CCX-2, CC-042)', () => {
  it('defines the success, client error, server error and error ranges with both ends included', () => {
    expect(SUCCESS_HTTP_STATUS_RANGE).toEqual({ min: 200, max: 299 });
    expect(CLIENT_ERROR_HTTP_STATUS_RANGE).toEqual({ min: 400, max: 499 });
    expect(SERVER_ERROR_HTTP_STATUS_RANGE).toEqual({ min: 500, max: 599 });
    expect(ERROR_HTTP_STATUS_RANGE).toEqual({ min: CLIENT_ERROR_HTTP_STATUS_RANGE.min, max: SERVER_ERROR_HTTP_STATUS_RANGE.max });
  });

  // PRE42-CC 組 S2（CC-042 の Guard の 3xx）: Guard のリダイレクトの判定（`redirectLocations`）が使う 3xx の範囲。
  it('defines the redirection range (3xx) with both ends included', () => {
    expect(REDIRECTION_HTTP_STATUS_RANGE).toEqual({ min: 300, max: 399 });
    expect(isHttpStatusInRange(299, REDIRECTION_HTTP_STATUS_RANGE)).toBe(false);
    expect(isHttpStatusInRange(300, REDIRECTION_HTTP_STATUS_RANGE)).toBe(true);
    expect(isHttpStatusInRange(399, REDIRECTION_HTTP_STATUS_RANGE)).toBe(true);
    expect(isHttpStatusInRange(400, REDIRECTION_HTTP_STATUS_RANGE)).toBe(false);
  });

  it('freezes the ranges', () => {
    for (const range of [
      SUCCESS_HTTP_STATUS_RANGE,
      REDIRECTION_HTTP_STATUS_RANGE,
      CLIENT_ERROR_HTTP_STATUS_RANGE,
      SERVER_ERROR_HTTP_STATUS_RANGE,
      ERROR_HTTP_STATUS_RANGE,
    ]) {
      expect(Object.isFrozen(range)).toBe(true);
    }
  });

  it('reports whether a status is in a range, and never puts an unobserved status in a range', () => {
    expect(isHttpStatusInRange(ERROR_HTTP_STATUS_RANGE.min, ERROR_HTTP_STATUS_RANGE)).toBe(true);
    expect(isHttpStatusInRange(ERROR_HTTP_STATUS_RANGE.max, ERROR_HTTP_STATUS_RANGE)).toBe(true);
    expect(isHttpStatusInRange(ERROR_HTTP_STATUS_RANGE.min - 1, ERROR_HTTP_STATUS_RANGE)).toBe(false);
    expect(isHttpStatusInRange(ERROR_HTTP_STATUS_RANGE.max + 1, ERROR_HTTP_STATUS_RANGE)).toBe(false);
    expect(isHttpStatusInRange(null, SUCCESS_HTTP_STATUS_RANGE)).toBe(false);
  });

  // PRE42-CC 組 R（CC-042 の残り）: READ の確かめの誤りの判定。4xx・5xx に加えて、600 以上の決まっていない status も誤りとして扱う。
  it('treats 4xx, 5xx and the non-standard statuses of 600 or more as errors, and never an unobserved status', () => {
    for (const status of [ERROR_HTTP_STATUS_RANGE.min, 404, 500, ERROR_HTTP_STATUS_RANGE.max, 600, 999]) {
      expect(isHttpErrorOrNonStandardStatus(status), String(status)).toBe(true);
    }
    for (const status of [100, 200, 302, ERROR_HTTP_STATUS_RANGE.min - 1]) {
      expect(isHttpErrorOrNonStandardStatus(status), String(status)).toBe(false);
    }
    expect(isHttpErrorOrNonStandardStatus(null)).toBe(false);
  });

  it('is re-exported by the rule helpers under the same names, as the same values', () => {
    expect(ruleHelpers.SUCCESS_HTTP_STATUS_RANGE).toBe(SUCCESS_HTTP_STATUS_RANGE);
    expect(ruleHelpers.CLIENT_ERROR_HTTP_STATUS_RANGE).toBe(CLIENT_ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.SERVER_ERROR_HTTP_STATUS_RANGE).toBe(SERVER_ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.ERROR_HTTP_STATUS_RANGE).toBe(ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.isHttpStatusInRange).toBe(isHttpStatusInRange);
    expectTypeOf<ruleHelpers.HttpStatusRange>().toEqualTypeOf<HttpStatusRange>();
  });
});
