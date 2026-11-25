// BS-1（設計書 `doc/design/2026-11-19-beaksight-measurement-tag-inventory-design.md`）: 計測タグの一覧（表示用モデルで 1 回だけ集計）と、根拠・限界の印。
// 識別子は作り物の値。
import { describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import type { PageAuditResult, PageId, ViewportProfile } from '../../src/core/contracts.js';
import type { NetworkEvidence, NetworkRequestEvidence, NetworkResponseEvidence, NetworkTimingEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { measurementTagOf } from '../../src/core/measurement-services.js';
import { MEASUREMENT_TAG_TEXT } from '../../src/presentation/messages.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, networkFailure, page, record, safety } from '../helpers/audit-run-fixture.js';

const TIMING: NetworkTimingEvidence = {
  startTime: -1, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1,
};
const request = (requestId: string, url: string, method = 'GET'): NetworkRequestEvidence => ({
  requestId, url, method, resourceType: 'script', headers: { status: 'OBSERVED', values: {} }, timing: TIMING,
  redirectFromRequestId: null, redirectToRequestId: null, redirectChainRequestIds: [], truncated: false, isNavigationRequest: false, isMainFrame: true,
});
const response = (requestId: string, url: string, status = 200): NetworkResponseEvidence => ({
  requestId, url, status, statusText: '', headers: { status: 'OBSERVED', values: {} }, contentLengthHeader: null, timing: TIMING,
  transferSize: { status: 'NOT_OBSERVED' }, truncated: false, isNavigationRequest: false, isMainFrame: true,
});
const network = (sequence: number, pageId: PageId, viewport: ViewportProfile, payload: Partial<NetworkEvidence>) =>
  record('network', sequence, pageId, viewport, { requests: [], responses: [], failures: [], omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0, ...payload });

const CONTAINERS = ['GTM-TEST001', 'GTM-TEST002', 'GTM-TEST003', 'GTM-TEST004'].map((id) => `https://www.googletagmanager.com/gtm.js?id=${id}`);
const ADS = 'https://www.googleadservices.com/pagead/conversion/1234567/?label=x';
const ANALYTICS = 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST0001';
const UNLISTED = 'https://cdn.example.net/lib.js?id=GTM-TEST009';
const LOADED = [...CONTAINERS, ADS, ANALYTICS, UNLISTED];

/** 3 ページ × 2 ビューポートに、同じ読み込みがある Run（`extra` はページごとに足す Evidence）。 */
function siteRun(options: { readonly pages?: readonly PageAuditResult[]; readonly run?: Parameters<typeof auditRun>[0] } = {}) {
  const pages = [1, 2, 3].map((number) => {
    const pageId = createPageId(number);
    const evidence = (['desktop', 'mobile'] as const).map((viewport, index) => network(number * 10 + index, pageId, viewport, {
      requests: LOADED.map((url, at) => request(`r${at}`, url)),
      responses: LOADED.map((url, at) => response(`r${at}`, url)),
    }));
    return page(pageId, `/p${number}.html`, 'AUDITED', evidence);
  });
  return auditRun({ ...options.run, pages: [...pages, ...(options.pages ?? [])] });
}

describe('BS-1: the measurement tags of a Run', () => {
  it('takes the kind and the identifier from a URL of the list only', () => {
    expect(measurementTagOf(CONTAINERS[0] ?? '')).toEqual({ service: 'TAG_MANAGER', tagId: 'GTM-TEST001', queryName: 'id' });
    expect(measurementTagOf(ADS)).toEqual({ service: 'ADS_CONVERSION', tagId: '1234567', queryName: null });
    expect(measurementTagOf(UNLISTED)).toBeNull();
  });

  it('makes one row for each kind and identifier over the whole site, with the pages, both viewports and the summary of the kinds', () => {
    const { tags, countsByGroup } = buildReportViewModel(siteRun()).summary.measurementTags;
    expect(tags.map(({ service, tagId }) => `${service}:${tagId}`)).toEqual([
      'TAG_MANAGER:GTM-TEST001', 'TAG_MANAGER:GTM-TEST002', 'TAG_MANAGER:GTM-TEST003', 'TAG_MANAGER:GTM-TEST004',
      'ADS_CONVERSION:1234567', 'ANALYTICS_COLLECT:G-TEST0001',
    ]);
    for (const tag of tags) {
      expect(tag.pageCount).toBe(3);
      expect(tag.viewports).toEqual({ desktop: true, mobile: true });
      expect(tag.results.STATUS_2XX).toBe(6);
      expect(tag.evidence?.path).toBe('pages/PAGE-000001/page.json');
    }
    expect(countsByGroup).toEqual({ TAG_MANAGEMENT: 4, ANALYTICS: 1, ADVERTISING: 1 });
  });

  it('counts the loads kept only in the repeated reads', () => {
    const pageId = createPageId(4);
    const extra = page(pageId, '/p4.html', 'AUDITED', [network(40, pageId, 'desktop', {
      requests: [request('r0', CONTAINERS[0] ?? '')],
      responses: [response('r0', CONTAINERS[0] ?? '')],
      repeatedReads: [{
        method: 'GET', origin: 'https://www.googletagmanager.com', path: '/gtm.js', resourceType: 'script', status: 200, isMainFrame: true, count: 3,
        firstRequestId: 'r0', first: { url: CONTAINERS[0] ?? '', timing: TIMING }, slowest: { url: CONTAINERS[0] ?? '', timing: TIMING },
        firstStartTime: 0, lastStartTime: 0, transfer: { observedCount: 0, totalBytes: 0 }, distinctQueryCount: 1,
      }],
    })]);
    const tag = buildReportViewModel(siteRun({ pages: [extra] })).summary.measurementTags.tags[0];
    expect(tag?.requestCount).toBe(6 + 3);
    expect(tag?.pageCount).toBe(4);
  });

  it('counts the sending stopped by BeakSight in a READ_ONLY Run and says that it is not known whether it arrived', () => {
    const pageId = createPageId(4);
    const beacon = 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST0001&en=x';
    const extra = page(pageId, '/p4.html', 'AUDITED', [
      network(40, pageId, 'desktop', { requests: [request('b0', beacon, 'POST')], failures: [networkFailure(beacon, 'ping', 'net::ERR_FAILED', { requestId: 'b0', method: 'POST' })] }),
      safety(41, pageId, 'desktop', { blockedRequests: [{ method: 'POST', url: beacon, reason: 'NON_READ_METHOD', resourceType: 'ping', phase: 'LOAD' }] }),
    ]);
    const model = buildReportViewModel(siteRun({
      pages: [extra],
      run: { run: { safety: { ...auditRun().run.safety, auditSend: { policy: 'READ_ONLY', passedRequests: 0, passedRequestsByMethod: {} } } } },
    }));
    const { tags, limits } = model.summary.measurementTags;
    expect(tags.find(({ service }) => service === 'ANALYTICS_COLLECT')?.results.BLOCKED).toBe(1);
    expect(limits.blockedRequestCount).toBe(1);
    const html = renderHtmlReport(model);
    expect(html).toContain(MEASUREMENT_TAG_TEXT.auditSendNote.READ_ONLY);
    expect(html).toContain(MEASUREMENT_TAG_TEXT.factNote);
    for (const word of ['二重計上', '確認済み', '確かめました']) {
      expect(html).not.toContain(word);
    }
  });

  it('tells the number of the pages not checked in a PARTIAL Run', () => {
    const failed = page(createPageId(4), '/p4.html', 'FAILED');
    const model = buildReportViewModel(siteRun({ pages: [failed], run: { run: { runStatus: 'PARTIAL' } } }));
    expect(model.summary.measurementTags.limits).toMatchObject({ incomplete: true, failedPageCount: 1 });
    expect(renderHtmlReport(model)).toContain(MEASUREMENT_TAG_TEXT.incompleteNote('1', '0', '0'));
  });

  it('puts one line in the CLI result and a section in the HTML only when a tag was observed', () => {
    const withTags = buildReportViewModel(siteRun());
    expect(runSummaryLines(withTags.summary, 'output/RUN-1').join('\n')).toContain(MEASUREMENT_TAG_TEXT.cliValue('6'));
    const without = buildReportViewModel(auditRun());
    expect(without.summary.measurementTags.tags).toEqual([]);
    expect(runSummaryLines(without.summary, 'output/RUN-1').join('\n')).not.toContain(MEASUREMENT_TAG_TEXT.cliLabel);
    expect(renderHtmlReport(without)).not.toContain(MEASUREMENT_TAG_TEXT.heading);
  });
});
