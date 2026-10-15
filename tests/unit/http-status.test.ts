import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ruleHelpers from '../../src/audit/rule-helpers.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
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

  it('freezes the ranges', () => {
    for (const range of [SUCCESS_HTTP_STATUS_RANGE, CLIENT_ERROR_HTTP_STATUS_RANGE, SERVER_ERROR_HTTP_STATUS_RANGE, ERROR_HTTP_STATUS_RANGE]) {
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

  it('is re-exported by the rule helpers under the same names, as the same values', () => {
    expect(ruleHelpers.SUCCESS_HTTP_STATUS_RANGE).toBe(SUCCESS_HTTP_STATUS_RANGE);
    expect(ruleHelpers.CLIENT_ERROR_HTTP_STATUS_RANGE).toBe(CLIENT_ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.SERVER_ERROR_HTTP_STATUS_RANGE).toBe(SERVER_ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.ERROR_HTTP_STATUS_RANGE).toBe(ERROR_HTTP_STATUS_RANGE);
    expect(ruleHelpers.isHttpStatusInRange).toBe(isHttpStatusInRange);
    expectTypeOf<ruleHelpers.HttpStatusRange>().toEqualTypeOf<HttpStatusRange>();
  });
});
