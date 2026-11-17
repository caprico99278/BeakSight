// AUD-7: 4xx・5xx の指摘の区分を、表示用モデルが 1 回だけ引く（ブラウザを使わない）。
// - Rule が決めた区分（SITE_FAILURE・UNDETERMINED・EXPECTED_BRANCH）を `verification.httpError` に置く。BeakSight の遮断との関係が CAUSED・POSSIBLE の指摘は
//   COLLECTION_CAUSED にする（遮断の結び付きは、表示用モデルの 1 か所のまま）。
// - EXPECTED_BRANCH は Finding にならないので、件数と事実を `summary.httpErrorsNotCounted` に出す（バンドルの summary.json にだけ）。
// - UNDETERMINED は、候補群の確信度を 1 段下げる。
// - DEF-206: 同じ読み込みに承認したサービスの Origin の 401 があれば、その読み込みの `RESOURCE_4XX` は `POSSIBLE`（`APPROVED_SERVICE_UNAUTHORIZED`）。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type {
  ErrorDisplayEvidence,
  NetworkEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
} from '../../src/core/evidence-types.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, PAGE_3, auditRun, dom, finding, fixtureUrl, idOf, page, record } from '../helpers/audit-run-fixture.js';

const TIMING = Object.freeze({
  startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1,
  connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1,
});
const SECRET_VALUE = 'abcdef0123456789';

const exchange = (id: number, path: string, status: number, approvedService = false): readonly [NetworkRequestEvidence, NetworkResponseEvidence] => {
  const requestId = `REQ-${String(id).padStart(6, '0')}`;
  const url = fixtureUrl(path);
  return [
    {
      requestId, url, method: 'GET', resourceType: 'fetch', headers: { status: 'OBSERVED', values: {} }, timing: TIMING,
      redirectFromRequestId: null, redirectToRequestId: null, redirectChainRequestIds: [], isNavigationRequest: false, isMainFrame: true, truncated: false,
    },
    {
      requestId, url, status, statusText: '', headers: { status: 'OBSERVED', values: {} }, contentLengthHeader: null, timing: TIMING,
      transferSize: { status: 'NOT_OBSERVED' }, isNavigationRequest: false, isMainFrame: true, truncated: false,
      ...(status >= 400 ? {
        errorContext: {
          approvedService,
          bodySummary: { status: 'OBSERVED', format: 'JSON', fields: [{ key: 'code', valueType: 'string', value: 'NO_DATA', secretLike: false, truncated: false }] },
        },
      } : {}),
    },
  ] as const;
};

const networkOf = (...exchanges: readonly (readonly [NetworkRequestEvidence, NetworkResponseEvidence])[]): NetworkEvidence => ({
  requests: exchanges.map(([request]) => request),
  responses: exchanges.map(([, response]) => response),
  failures: [], omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0,
});

const NOT_SHOWN: ErrorDisplayEvidence = { status: 'OBSERVED', matches: [] };
const SHOWN: ErrorDisplayEvidence = { status: 'OBSERVED', matches: [{ source: 'ALERT', words: ['失敗'] }] };

const resourceMessage = (path: string, status: number): string => `資源の応答が HTTP ステータス ${status} でした（URL: ${fixtureUrl(path)}、種類: fetch）。`;

const run = () => {
  // PAGE-1: 画面に誤りなし。/api/me の 401 は後で 200（EXPECTED_BRANCH。指摘なし）、/api/list の 406 は回復しない（UNDETERMINED）。
  const p1Dom = dom(1, PAGE_1, 'desktop', 'p1', { errorDisplay: NOT_SHOWN });
  const p1Network = record('network', 2, PAGE_1, 'desktop', networkOf(exchange(1, '/api/me', 401), exchange(2, '/api/me', 200), exchange(3, '/api/list', 406)));
  // PAGE-2: 画面に誤りの表示。/api/list の 406 は回復しない（SITE_FAILURE）。
  const p2Dom = dom(3, PAGE_2, 'desktop', 'p2', { errorDisplay: SHOWN });
  const p2Network = record('network', 4, PAGE_2, 'desktop', networkOf(exchange(4, '/api/list', 406)));
  // PAGE-3: 承認したサービスの Origin の 401（DEF-206。COLLECTION_CAUSED）。
  const p3Dom = dom(5, PAGE_3, 'desktop', 'p3', { errorDisplay: NOT_SHOWN });
  const p3Network = record('network', 6, PAGE_3, 'desktop', networkOf(exchange(5, '/api/service', 401, true)));
  const findings = [
    finding(1, 'ERROR', 'RESOURCE', PAGE_1, [idOf(p1Network)], { ruleId: 'RESOURCE_4XX', message: resourceMessage('/api/list', 406) }),
    finding(2, 'ERROR', 'RESOURCE', PAGE_2, [idOf(p2Network)], { ruleId: 'RESOURCE_4XX', message: resourceMessage('/api/list', 406) }),
    finding(3, 'ERROR', 'RESOURCE', PAGE_3, [idOf(p3Network)], { ruleId: 'RESOURCE_4XX', message: resourceMessage('/api/service', 401) }),
  ] as const;
  return auditRun({
    pages: [
      page(PAGE_1, '/', 'AUDITED', [p1Dom, p1Network], [findings[0]]),
      page(PAGE_2, '/second.html', 'AUDITED', [p2Dom, p2Network], [findings[1]]),
      page(PAGE_3, '/third.html', 'AUDITED', [p3Dom, p3Network], [findings[2]]),
    ],
  });
};

describe('AUD-7: the classes of the HTTP error findings in the report model', () => {
  it('reads the class of each finding once, and turns the collection side ones into COLLECTION_CAUSED', () => {
    const model = buildReportViewModel(run());
    const classOf = (pageId: string): unknown => model.findings.find(({ finding: value }) => value.pageId === pageId)?.verification.httpError?.errorClass;
    expect(classOf(PAGE_1)).toBe('UNDETERMINED');
    expect(classOf(PAGE_2)).toBe('SITE_FAILURE');
    expect(classOf(PAGE_3)).toBe('COLLECTION_CAUSED');
    expect(model.findings.find(({ finding: value }) => value.pageId === PAGE_3)?.beaksightBlockRelation).toMatchObject({
      relation: 'POSSIBLE', reason: 'APPROVED_SERVICE_UNAUTHORIZED',
    });
    expect(model.findings.find(({ finding: value }) => value.pageId === PAGE_2)?.verification.httpError?.responses).toEqual([
      expect.objectContaining({ url: fixtureUrl('/api/list'), status: 406, recovered: false, errorDisplay: 'SHOWN', errorClass: 'SITE_FAILURE' }),
    ]);
  });

  it('counts the expected branches with their facts, outside the findings', () => {
    const { httpErrorsNotCounted } = buildReportViewModel(run()).summary;
    expect(httpErrorsNotCounted.total).toBe(1);
    expect(httpErrorsNotCounted.byRule).toEqual([{ ruleId: 'RESOURCE_4XX', count: 1 }]);
    expect(httpErrorsNotCounted.responses).toEqual([
      expect.objectContaining({
        pageId: PAGE_1, viewport: 'desktop', ruleId: 'RESOURCE_4XX', url: fixtureUrl('/api/me'), method: 'GET', status: 401,
        recovered: true, retryStatuses: [200], errorDisplay: 'NOT_SHOWN', credentials: { cookie: false, authorization: false },
      }),
    ]);
  });

  it('lowers the confidence of the groups with an undetermined class', () => {
    const { findingGroups, findings } = buildReportViewModel(run());
    const groupOf = (pageId: string) => {
      const findingId = findings.find(({ finding: value }) => value.pageId === pageId)?.finding.findingId;
      return findingGroups.find((group) => findingId !== undefined && group.findingIds.includes(findingId));
    };
    // 群は Rule と鍵でまとまる（同じ Rule の 3 件は 1 つの群）。UNDETERMINED が 1 件でもあれば 1 段下げる。
    expect(groupOf(PAGE_1)?.confidence).toBe('MEDIUM');
  });

  it('puts the class and the summary into the bundle only, not into the HTML body', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const summary = JSON.parse(new TextDecoder().decode(entries['summary.json'])) as { readonly httpErrorsNotCounted: unknown };
    expect(summary.httpErrorsNotCounted).toEqual(JSON.parse(JSON.stringify(model.summary.httpErrorsNotCounted)));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.httpErrorsNote);
    const html = renderHtmlReport(model);
    expect(html).not.toContain('NO_DATA');
    expect(html).not.toContain('EXPECTED_BRANCH');
    expect(html).not.toContain(SECRET_VALUE);
  });
});
