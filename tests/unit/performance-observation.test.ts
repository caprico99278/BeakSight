// AUD-6c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-6c）: 性能の値の観測の範囲（ブラウザを使わない）。
// - 記録ごとに、測った段・観測の時間（読み込みの始まりから測った時まで）・測る前に BeakSight がページにした操作（スクロール・通知の枠の押下）を出す。
// - INP の未観測は、未観測として出す（0 や良い値にしない）。
// - 遅い記録（LCP・FCP・TTFB が今の poor の境界を超えた）には、時間の内訳を残す: 最初のデータの要求（fetch・XHR）が始まるまでの待ちと、その要求の通信の時間。
// - 表示用モデルが 1 回だけ作り、バンドルの summary.json にだけ出す。
import { describe, expect, it } from 'vitest';
import { judgedWebVitalsOf } from '../../src/audit/performance-observation.js';
import type { EvidenceCapture, EvidencePayloadByType, PageId, ViewportProfile } from '../../src/core/contracts.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, fixtureUrl, page, record } from '../helpers/audit-run-fixture.js';

const vital = (value: number | null) => (value === null
  ? { status: 'NOT_OBSERVED', value: null, id: null, navigationType: null, attribution: null }
  : { status: 'OBSERVED', value, id: 'v', navigationType: 'navigate', attribution: null });

const resource = (path: string, category: string, startTime: number, responseEnd: number) => ({
  url: fixtureUrl(path), initiatorType: category === 'fetch-xhr' ? 'fetch' : 'script', startTime, duration: responseEnd - startTime,
  responseStart: responseEnd - 10, responseEnd, requestId: null, networkResourceType: null, category, categoryBasis: 'INITIATOR_TYPE',
  serverTiming: [], sizeStatus: 'OBSERVED', transferSize: 1, encodedBodySize: 1, decodedBodySize: 1,
});

const CAPTURE: EvidenceCapture = {
  stateId: 'STATE-000001' as never, phase: 'performance', startedAt: '2026-09-24T00:00:00.000Z', finishedAt: '2026-09-24T00:00:00.100Z', url: null, scrollPosition: null,
};

const performance = (sequence: number, pageId: PageId, viewport: ViewportProfile, lcp: number, extra: object) => ({
  ...record('performance', sequence, pageId, viewport, {
    status: 'COMPLETE',
    reason: 'COLLECTED',
    webVitals: { LCP: vital(lcp), FCP: vital(500), CLS: vital(0), TTFB: vital(100), INP: vital(null) },
    navigationTiming: null,
    resources: [
      resource('/app.js', 'script', 10, 200),
      resource('/api/slow', 'fetch-xhr', 1500, 3900),
      resource('/api/later', 'fetch-xhr', 2000, 2100),
    ],
    resourceSummaries: null,
    resourceCoverage: null,
    serverTiming: [],
    telemetryHeaders: [],
    telemetryCandidates: [],
    truncation: null,
    ...extra,
  } as unknown as EvidencePayloadByType['performance']),
  capture: CAPTURE,
});

describe('AUD-6c: the observation scope of the performance values', () => {
  it('adds the stage, the observation time, the operations, the unobserved INP and the breakdown of a slow record', () => {
    const result = auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [
        performance(1, PAGE_1, 'desktop', 5000, { observedForMs: 6000, operationsBeforeMeasurement: { scrolled: true, notificationFramePressed: false } }),
        performance(2, PAGE_1, 'mobile', 1000, { observedForMs: 2500, operationsBeforeMeasurement: { scrolled: false, notificationFramePressed: true } }),
      ])],
    });
    expect(buildReportViewModel(result).summary.performanceObservations).toEqual([
      {
        pageId: PAGE_1, viewport: 'desktop', stage: 'performance', observedForMs: 6000,
        operations: { scrolled: true, notificationFramePressed: false },
        inp: 'NOT_OBSERVED',
        slowMetrics: ['LCP'],
        breakdown: { waitUntilFirstDataRequestMs: 1500, firstDataRequest: { url: fixtureUrl('/api/slow'), communicationMs: 2400 } },
      },
      {
        pageId: PAGE_1, viewport: 'mobile', stage: 'performance', observedForMs: 2500,
        operations: { scrolled: false, notificationFramePressed: true },
        inp: 'NOT_OBSERVED',
        slowMetrics: [],
        breakdown: null,
      },
    ]);
    expect(CHATGPT_BUNDLE_GUIDE_TEXT.performanceObservationsNote.length).toBeGreaterThan(0);
  });

  it('keeps the records of the earlier versions without the new facts', () => {
    const result = auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [performance(1, PAGE_1, 'desktop', 5000, {})])] });
    expect(buildReportViewModel(result).summary.performanceObservations).toEqual([
      expect.objectContaining({ observedForMs: null, operations: null, slowMetrics: ['LCP'] }),
    ]);
  });

  it('EV-1 M-4: judges by the LCP before the scroll only when it was observed', () => {
    const webVitals = { LCP: vital(5000), FCP: vital(500), CLS: vital(0), TTFB: vital(100), INP: vital(null) } as never;
    expect(judgedWebVitalsOf({ webVitals, lcpBeforeScroll: vital(null) as never })?.LCP.value).toBe(5000);
    expect(judgedWebVitalsOf({ webVitals, lcpBeforeScroll: vital(1000) as never })?.LCP.value).toBe(1000);
  });
});
