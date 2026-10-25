// T35b（Task 35 の設計書 3.4）: 負荷の部品（`src/crawl/load-meter.ts`）の、承認したサービスの Origin の区分（`run.json` の
// `load.approvedServiceOrigins` の値。書くのは T35c）。
// - サービスの Origin を渡したときだけ区分を持つ（`serviceOriginRequests()`）。区分は `otherOrigins` の内数で、数え方（数えない要求、1 分あたりの
//   最大）は、ほかの区分と同じ。`snapshot()` の形は変えない（公開の監査と、フォームの送信のログインの監査の出力を変えない）。
import { describe, expect, it } from 'vitest';
import { LOAD_PEAK_WINDOW_MS, createLoadMeter } from '../../src/crawl/load-meter.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const BLOCKED_BY_CLIENT = 'net::ERR_BLOCKED_BY_CLIENT';

describe('T35b: the approved service origins of the load meter', () => {
  it('counts the requests to the approved service origins as a part of the other origins', () => {
    let nowMs = 0;
    const meter = createLoadMeter({ allowedOrigins: [APP_ORIGIN], approvedServiceOrigins: [SERVICE_ORIGIN], now: () => nowMs });
    meter.recordRequestFinished({}, `${APP_ORIGIN}/admin`);
    meter.recordRequestFinished({}, `${SERVICE_ORIGIN}/rest/v1/members`);
    meter.recordRequestFinished({}, `${SERVICE_ORIGIN}/rest/v1/members?select=*`);
    meter.recordRequestFinished({}, `${OTHER_ORIGIN}/lib.js`);
    meter.recordRequestFailed({}, `${SERVICE_ORIGIN}/blocked`, BLOCKED_BY_CLIENT);
    const cached = {};
    meter.recordServedFromRunCache(cached);
    meter.recordRequestFinished(cached, `${SERVICE_ORIGIN}/cached`);
    nowMs += LOAD_PEAK_WINDOW_MS;
    meter.recordRequestFinished({}, `${SERVICE_ORIGIN}/later`);
    expect(meter.serviceOriginRequests()).toEqual({ count: 3, peakPerMinute: 2 });
    expect(meter.snapshot()).toEqual({
      allowedOrigins: { count: 1, peakPerMinute: 1 },
      otherOrigins: { count: 4, peakPerMinute: 3 },
      servedFromCache: 1,
      withheldOtherOrigins: 0,
    });
  });

  it('has no service origin part without the approved service origins (the output does not change)', () => {
    const meter = createLoadMeter({ allowedOrigins: [APP_ORIGIN], now: () => 0 });
    meter.recordRequestFinished({}, `${SERVICE_ORIGIN}/rest/v1/members`);
    expect(meter.serviceOriginRequests()).toBeNull();
    expect(Object.keys(meter.snapshot()).sort()).toEqual(['allowedOrigins', 'otherOrigins', 'servedFromCache', 'withheldOtherOrigins']);
  });

  it('takes over the service origin part on a resume, and rejects a malformed value', () => {
    const meter = createLoadMeter({
      allowedOrigins: [APP_ORIGIN],
      approvedServiceOrigins: [SERVICE_ORIGIN],
      initialServiceOriginRequests: { count: 5, peakPerMinute: 4 },
      now: () => 0,
    });
    meter.recordRequestFinished({}, `${SERVICE_ORIGIN}/x`);
    expect(meter.serviceOriginRequests()).toEqual({ count: 6, peakPerMinute: 4 });
    expect(() => createLoadMeter({
      allowedOrigins: [APP_ORIGIN], approvedServiceOrigins: [SERVICE_ORIGIN], initialServiceOriginRequests: { count: -1, peakPerMinute: 0 }, now: () => 0,
    })).toThrow(RangeError);
    expect(() => createLoadMeter({ allowedOrigins: [APP_ORIGIN], approvedServiceOrigins: [1] as unknown as string[], now: () => 0 })).toThrow(TypeError);
  });
});
