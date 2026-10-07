// サイトが応答しないときに Run を止める設計書（`2026-10-05-beaksight-site-unavailability-stop-design.md`）の 2章、2.1、2.2。
// SU1、SU1b: サイトの不調の判定の owner（`src/orchestration/site-availability.ts`）。BeakSight が始めた main frame の読み込みの観測
// （`src/browser/main-frame-load.ts` の `MainFrameLoadObservation`）が、サイトの不調（応答（ヘッダ）のない時間切れ、ネットワークの層の
// 失敗、429・502・503・504 の応答）に当たるかを、ここだけで決める。応答を受けた後の時間切れは、不調にしない（2.2）。
// 時間切れとネットワークの層の失敗の詳細は、`navigationFailureDetail`（`src/orchestration/page-navigation.ts`）の形と同じにする。
// SU2a（設計書 3.1）: 不調を検知した段階の閉じた一覧と、理由とページの結果の `detail` の組み立ても、ここだけで行う。
// SU2b（設計書 3.1）: 不調を検知したため始めなかったビューポートの理由（`SITE_UNAVAILABLE_SKIP_REASON`）も、ここで公開する。
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { INCOMPLETE_REASON_CODES, type IncompleteReason, type ViewportProfile } from '../../src/core/contracts.js';
import { navigationFailureDetail } from '../../src/orchestration/page-navigation.js';
import {
  SITE_UNAVAILABILITY_KINDS,
  SITE_UNAVAILABILITY_STAGES,
  SITE_UNAVAILABLE_HTTP_STATUSES,
  SITE_UNAVAILABLE_SKIP_REASON,
  siteUnavailabilityOf,
  siteUnavailableDetail,
  siteUnavailableStageDetail,
  type SiteUnavailability,
  type SiteUnavailabilityKind,
  type SiteUnavailabilityStage,
} from '../../src/orchestration/site-availability.js';
import { NETWORK_LAYER_FAILURE_CODES } from '../../src/safety/network-layer-failure.js';

/** サイトの不調を示さない HTTP の status の例（成功、リダイレクト、4xx（429 を除く）、500 などの 5xx）。 */
const AVAILABLE_HTTP_STATUSES = [200, 204, 301, 302, 304, 308, 400, 401, 403, 404, 410, 500, 501, 505] as const;

/** 応答（ヘッダ）を受けた後の時間切れで、不調にしない status の例（成功、見つからない、そのページだけの不具合）。 */
const HEADERS_RECEIVED_TIMEOUT_STATUSES = [200, 404, 500] as const;

/** 不調の代表として使う status（503 Service Unavailable。`SITE_UNAVAILABLE_HTTP_STATUSES` の1つ）。 */
const SERVICE_UNAVAILABLE_STATUS = 503;

/** 読み込みが終わった観測（`OK`。4xx・5xx も `OK`）。 */
const answered = (httpStatus: number | null): MainFrameLoadObservation => ({ navigationOutcome: 'OK', httpStatus, failureDetail: null });

/** 失敗した観測（`FAILED`。失敗の詳細は Playwright のエラーのメッセージ）。 */
const failed = (failureDetail: string | null, httpStatus: number | null = null): MainFrameLoadObservation => ({
  navigationOutcome: 'FAILED',
  httpStatus,
  failureDetail,
});

/** Playwright のエラーのメッセージの形（`page.goto: <Chromium のエラーのコード> at <URL>`）。 */
const gotoMessage = (code: string): string => `page.goto: ${code} at http://127.0.0.1:9/`;

/** Playwright の期限切れの観測（`TIMEOUT`。失敗の詳細は Playwright のエラーのメッセージ）。 */
const timedOut = (httpStatus: number | null): MainFrameLoadObservation => ({
  navigationOutcome: 'TIMEOUT',
  httpStatus,
  failureDetail: 'page.goto: Timeout 30000ms exceeded.',
});

/** main frame の最後の文書の要求に、応答（ヘッダ）を1つも受けずに時間切れになった観測。 */
const TIMED_OUT_WITHOUT_RESPONSE: MainFrameLoadObservation = Object.freeze(timedOut(null));

describe('the closed lists of site unavailability (design 2)', () => {
  it('lists the kinds of site unavailability, frozen', () => {
    expect([...SITE_UNAVAILABILITY_KINDS]).toEqual(['TIMEOUT', 'NETWORK_FAILURE', 'HTTP_STATUS']);
    expect(Object.isFrozen(SITE_UNAVAILABILITY_KINDS)).toBe(true);
    expectTypeOf<SiteUnavailabilityKind>().toEqualTypeOf<'TIMEOUT' | 'NETWORK_FAILURE' | 'HTTP_STATUS'>();
    expectTypeOf<SiteUnavailability>().toEqualTypeOf<{ readonly kind: SiteUnavailabilityKind; readonly detail: string }>();
  });

  it('lists 429, 502, 503 and 504 as the HTTP statuses of an unavailable site (not 500), frozen', () => {
    expect([...SITE_UNAVAILABLE_HTTP_STATUSES]).toEqual([429, 502, 503, 504]);
    expect(Object.isFrozen(SITE_UNAVAILABLE_HTTP_STATUSES)).toBe(true);
    expect(SITE_UNAVAILABLE_HTTP_STATUSES).toContain(SERVICE_UNAVAILABLE_STATUS);
  });

  it('judges the observation of the main frame load (design 2.1)', () => {
    expectTypeOf(siteUnavailabilityOf).parameters.toEqualTypeOf<[MainFrameLoadObservation]>();
    expectTypeOf(siteUnavailabilityOf).returns.toEqualTypeOf<SiteUnavailability | null>();
  });
});

describe('siteUnavailabilityOf: a timeout (design 2, 2.2)', () => {
  it('treats a timeout without any response to the last document request as TIMEOUT, with the detail of navigationFailureDetail, frozen', () => {
    const result = siteUnavailabilityOf(TIMED_OUT_WITHOUT_RESPONSE);

    expect(result).toEqual({ kind: 'TIMEOUT', detail: 'TIMEOUT' });
    expect(result?.detail).toBe(navigationFailureDetail(TIMED_OUT_WITHOUT_RESPONSE));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('treats a timeout of the deadline race (no failure message) without any response as TIMEOUT', () => {
    expect(siteUnavailabilityOf({ navigationOutcome: 'TIMEOUT', httpStatus: null, failureDetail: null }))
      .toEqual({ kind: 'TIMEOUT', detail: 'TIMEOUT' });
  });

  it.each(HEADERS_RECEIVED_TIMEOUT_STATUSES)(
    'does not treat a timeout after an HTTP %d response (the body or the parts were slow) as site unavailability',
    (status) => {
      expect(siteUnavailabilityOf(timedOut(status))).toBeNull();
      expect(siteUnavailabilityOf({ navigationOutcome: 'TIMEOUT', httpStatus: status, failureDetail: null })).toBeNull();
    },
  );

  it.each(SITE_UNAVAILABLE_HTTP_STATUSES)('treats a timeout after an HTTP %d response as HTTP_STATUS, with HTTP <status>', (status) => {
    const result = siteUnavailabilityOf(timedOut(status));

    expect(result).toEqual({ kind: 'HTTP_STATUS', detail: `HTTP ${status}` });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('siteUnavailabilityOf: a failure (design 2)', () => {
  it.each(NETWORK_LAYER_FAILURE_CODES)('treats the network-layer failure %s as NETWORK_FAILURE, with FAILED:<code>', (code) => {
    const observation = failed(gotoMessage(code));
    const result = siteUnavailabilityOf(observation);

    expect(result).toEqual({ kind: 'NETWORK_FAILURE', detail: `FAILED:${code}` });
    expect(result?.detail).toBe(navigationFailureDetail(observation));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR'])(
    'treats the TLS failure %s as NETWORK_FAILURE',
    (code) => {
      expect(siteUnavailabilityOf(failed(gotoMessage(code)))).toEqual({ kind: 'NETWORK_FAILURE', detail: `FAILED:${code}` });
    },
  );

  it('treats a failure message that is only the Chromium code as NETWORK_FAILURE', () => {
    expect(siteUnavailabilityOf(failed('net::ERR_CONNECTION_REFUSED')))
      .toEqual({ kind: 'NETWORK_FAILURE', detail: 'FAILED:net::ERR_CONNECTION_REFUSED' });
  });

  it('prefers NETWORK_FAILURE to the HTTP status of the last document response', () => {
    expect(siteUnavailabilityOf(failed(gotoMessage('net::ERR_CONNECTION_RESET'), SERVICE_UNAVAILABLE_STATUS)))
      .toEqual({ kind: 'NETWORK_FAILURE', detail: 'FAILED:net::ERR_CONNECTION_RESET' });
  });

  it.each([
    // ブラウザやページの都合でも起きる中断（DEF-027 で別に扱う）。
    'net::ERR_ABORTED',
    // 配送の取りこぼしを示しうる、判断に迷う理由。
    'net::ERR_FAILED',
    // Guard が止めた要求（外部へのリダイレクトの遮断も、観測では `FAILED` になる。設計書 2.1）。
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_BLOCKED_BY_CLIENT.Inspector',
    // ネットワークの層の失敗の閉じた一覧にない理由。
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'net::ERR_TOO_MANY_REDIRECTS',
  ])('does not treat the failure %s without any response as site unavailability', (code) => {
    expect(siteUnavailabilityOf(failed(gotoMessage(code)))).toBeNull();
  });

  it.each(SITE_UNAVAILABLE_HTTP_STATUSES)(
    'treats net::ERR_ABORTED after an HTTP %d response as HTTP_STATUS, with HTTP <status>',
    (status) => {
      const result = siteUnavailabilityOf(failed(gotoMessage('net::ERR_ABORTED'), status));

      expect(result).toEqual({ kind: 'HTTP_STATUS', detail: `HTTP ${status}` });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each(HEADERS_RECEIVED_TIMEOUT_STATUSES)('does not treat net::ERR_ABORTED after an HTTP %d response as site unavailability', (status) => {
    expect(siteUnavailabilityOf(failed(gotoMessage('net::ERR_ABORTED'), status))).toBeNull();
  });

  it('judges a failure by its first Chromium code, as navigationFailureDetail does', () => {
    expect(siteUnavailabilityOf(failed('page.goto: net::ERR_ABORTED; then net::ERR_CONNECTION_RESET'))).toBeNull();
    expect(siteUnavailabilityOf(failed('page.goto: net::ERR_CONNECTION_RESET; then net::ERR_ABORTED')))
      .toEqual({ kind: 'NETWORK_FAILURE', detail: 'FAILED:net::ERR_CONNECTION_RESET' });
  });

  it.each([
    ['a message without a Chromium code', 'page.goto: Target page, context or browser has been closed'],
    ['no message', null],
  ])('does not treat a failure with %s and without any response as site unavailability', (_label, failureDetail) => {
    expect(siteUnavailabilityOf(failed(failureDetail))).toBeNull();
  });

  it('treats a failure without a Chromium code after an HTTP 503 response as HTTP_STATUS', () => {
    expect(siteUnavailabilityOf(failed('page.goto: Target page, context or browser has been closed', SERVICE_UNAVAILABLE_STATUS)))
      .toEqual({ kind: 'HTTP_STATUS', detail: `HTTP ${SERVICE_UNAVAILABLE_STATUS}` });
  });
});

describe('siteUnavailabilityOf: a finished load (design 2)', () => {
  it.each(SITE_UNAVAILABLE_HTTP_STATUSES)('treats an HTTP %d response as HTTP_STATUS, with HTTP <status>', (status) => {
    const result = siteUnavailabilityOf(answered(status));

    expect(result).toEqual({ kind: 'HTTP_STATUS', detail: `HTTP ${status}` });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(AVAILABLE_HTTP_STATUSES)('does not treat an HTTP %d response as site unavailability', (status) => {
    expect(siteUnavailabilityOf(answered(status))).toBeNull();
  });

  it('does not treat a load that finished without a response (no HTTP status) as site unavailability', () => {
    expect(siteUnavailabilityOf(answered(null))).toBeNull();
  });
});

describe('siteUnavailabilityOf: the kinds (design 2)', () => {
  it('gives only the kinds of the closed list', () => {
    const kinds = [
      siteUnavailabilityOf(TIMED_OUT_WITHOUT_RESPONSE),
      siteUnavailabilityOf(failed(gotoMessage('net::ERR_CONNECTION_RESET'))),
      siteUnavailabilityOf(answered(SERVICE_UNAVAILABLE_STATUS)),
    ].map((result) => result?.kind);

    expect(kinds).toEqual([...SITE_UNAVAILABILITY_KINDS]);
  });
});

/** 判定の結果（`siteUnavailabilityOf` が返したもの）。不調でなければテストの前提が崩れているので、例外にする。 */
function detected(observation: MainFrameLoadObservation): SiteUnavailability {
  const result = siteUnavailabilityOf(observation);
  if (result === null) {
    throw new Error('the observation must be site unavailability');
  }
  return result;
}

describe('the stages where site unavailability is detected (design 3.1)', () => {
  it('lists the stages, frozen', () => {
    expect([...SITE_UNAVAILABILITY_STAGES]).toEqual(['passive', 'stress-layout', 'interaction', 'site-metadata']);
    expect(Object.isFrozen(SITE_UNAVAILABILITY_STAGES)).toBe(true);
    expectTypeOf<SiteUnavailabilityStage>().toEqualTypeOf<'passive' | 'stress-layout' | 'interaction' | 'site-metadata'>();
  });
});

describe('the detail of the site unavailability reasons (design 3.1, 3.2)', () => {
  it('builds the detail of the viewport reason as <stage>:<detail of the judgment>', () => {
    expect(siteUnavailableStageDetail('passive', detected(TIMED_OUT_WITHOUT_RESPONSE))).toBe('passive:TIMEOUT');
    expect(siteUnavailableStageDetail('stress-layout', detected(answered(SERVICE_UNAVAILABLE_STATUS))))
      .toBe(`stress-layout:HTTP ${SERVICE_UNAVAILABLE_STATUS}`);
    expect(siteUnavailableStageDetail('interaction', detected(failed(gotoMessage('net::ERR_CONNECTION_RESET')))))
      .toBe('interaction:FAILED:net::ERR_CONNECTION_RESET');
    expectTypeOf(siteUnavailableStageDetail).parameters.toEqualTypeOf<[SiteUnavailabilityStage, SiteUnavailability]>();
    expectTypeOf(siteUnavailableStageDetail).returns.toEqualTypeOf<string>();
  });

  it.each([
    ['desktop', 'passive', TIMED_OUT_WITHOUT_RESPONSE, 'desktop:passive:TIMEOUT'],
    ['mobile', 'passive', answered(SERVICE_UNAVAILABLE_STATUS), `mobile:passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}`],
    ['desktop', 'stress-layout', failed(gotoMessage('net::ERR_CONNECTION_REFUSED')), 'desktop:stress-layout:FAILED:net::ERR_CONNECTION_REFUSED'],
  ] as const)(
    'builds the detail of the page result and the Run reason as <viewport>:<stage>:<detail> (%s, %s)',
    (viewport, stage, observation, expected) => {
      expect(siteUnavailableDetail(viewport, stage, detected(observation))).toBe(expected);
    },
  );

  it('builds the detail of the page result and the Run reason as <stage>:<detail> without a viewport', () => {
    const unavailability = detected(TIMED_OUT_WITHOUT_RESPONSE);

    expect(siteUnavailableDetail(null, 'site-metadata', unavailability)).toBe('site-metadata:TIMEOUT');
    // ビューポートのない形は、ビューポートの理由の detail と同じ形である。
    expect(siteUnavailableDetail(null, 'site-metadata', unavailability)).toBe(siteUnavailableStageDetail('site-metadata', unavailability));
    expectTypeOf(siteUnavailableDetail).parameters
      .toEqualTypeOf<[ViewportProfile | null, SiteUnavailabilityStage, SiteUnavailability]>();
    expectTypeOf(siteUnavailableDetail).returns.toEqualTypeOf<string>();
  });
});

describe('the reason of what was not started after site unavailability (design 3.1)', () => {
  it('is SITE_UNAVAILABLE without a detail, frozen', () => {
    expect(SITE_UNAVAILABLE_SKIP_REASON).toEqual({ code: 'SITE_UNAVAILABLE', detail: null });
    expect(Object.isFrozen(SITE_UNAVAILABLE_SKIP_REASON)).toBe(true);
    expect(INCOMPLETE_REASON_CODES).toContain(SITE_UNAVAILABLE_SKIP_REASON.code);
    expectTypeOf(SITE_UNAVAILABLE_SKIP_REASON).toExtend<IncompleteReason>();
  });
});
