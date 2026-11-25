// AUD-6b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-6b）: リンクごとの確かめの状態（`links.json`）。ブラウザを使わない。
// - 状態は 3 つ: 移って確認（行き先のページを読んだ）・静的な候補（外部・http 以外の scheme・受け入れない href）・未検証（内部で、行き先を読んでいない）。
// - 移って確認は、行き先のページの記録（状態の番号・最後の URL）と、行き先のページの main frame の移動の要求（リダイレクトの鎖）から作る。
// - 未検証は、今ある事実から理由を決め、次に要る手順をやさしい文で付ける。未検証の数は、リンク切れ・検証済みと別の欄にする。
// - 今ある事実だけで作る（新しく移らない）。表示用モデルが 1 回だけ作り、バンドルは写すだけ。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { LinkEvidence, NetworkRequestEvidence, NetworkResponseEvidence } from '../../src/core/evidence-types.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, LINK_CHECK_NEXT_STEP_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import {
  PAGE_1,
  PAGE_2,
  PAGE_3,
  auditRun,
  fixtureUrl,
  metadata,
  page,
  record,
  runSummary,
  viewportResult,
} from '../helpers/audit-run-fixture.js';

const link = (rawHref: string, admission: LinkEvidence['admission'], normalized: LinkEvidence['normalized']): LinkEvidence => ({
  sourcePageId: PAGE_1, anchorText: rawHref, ariaLabel: null, title: null, rawHref, normalized, admission, truncated: false,
});
const internal = (path: string): LinkEvidence => {
  const url = fixtureUrl(path);
  return link(path, { kind: 'INTERNAL_NAVIGABLE', url }, { ok: true, url });
};

const TIMING = Object.freeze({
  startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1,
  connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1,
});
const navigationRequest = (requestId: string, path: string, chain: readonly string[], to: string | null): NetworkRequestEvidence => ({
  requestId, url: fixtureUrl(path), method: 'GET', resourceType: 'document', headers: { status: 'OBSERVED', values: {} }, timing: TIMING,
  redirectFromRequestId: chain.at(-1) ?? null, redirectToRequestId: to, redirectChainRequestIds: chain,
  isNavigationRequest: true, isMainFrame: true, truncated: false,
});
const navigationResponse = (requestId: string, path: string, status: number): NetworkResponseEvidence => ({
  requestId, url: fixtureUrl(path), status, statusText: '', headers: { status: 'OBSERVED', values: {} }, contentLengthHeader: null, timing: TIMING,
  transferSize: { status: 'NOT_OBSERVED' }, isNavigationRequest: true, isMainFrame: true, truncated: false,
});

const run = () => auditRun({
  run: runSummary({ crawlLimits: { maxPagesReached: true, maxDepthReached: false, maxRuntimeReached: false } }),
  pages: [
    page(PAGE_1, '/', 'AUDITED', [
      metadata(1, PAGE_1),
      record('link', 20, PAGE_1, 'desktop', {
        links: [
          internal('/second.html'),
          internal('/third.html'),
          internal('/not-read.html'),
          link('https://example.invalid/', { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://example.invalid/' }, { ok: true, url: 'https://example.invalid/' as never }),
          link('tel:0120000000', { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'tel:0120000000', scheme: 'tel' }, { ok: false, rawUrl: 'tel:0120000000', reason: 'UNSUPPORTED_SCHEME' }),
          internal('/second.html'),
        ],
        omittedLinkCount: 0,
      }),
    ]),
    // 移って確認: リダイレクトの鎖（/second.html 301 → /moved.html 200）。
    page(PAGE_2, '/second.html', 'AUDITED', [
      record('network', 30, PAGE_2, 'desktop', {
        requests: [navigationRequest('REQ-1', '/second.html', [], 'REQ-2'), navigationRequest('REQ-2', '/moved.html', ['REQ-1'], null)],
        responses: [navigationResponse('REQ-1', '/second.html', 301), navigationResponse('REQ-2', '/moved.html', 200)],
        failures: [], omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0,
      }),
    ], [], {
      viewports: {
        desktop: viewportResult(fixtureUrl('/second.html'), 'AUDITED', { finalUrl: fixtureUrl('/moved.html') }),
        mobile: viewportResult(fixtureUrl('/second.html'), 'AUDITED', { finalUrl: fixtureUrl('/moved.html') }),
      },
    }),
    // リンク切れ（移って確認の 404）。
    page(PAGE_3, '/third.html', 'AUDITED', [], [], {
      viewports: {
        desktop: viewportResult(fixtureUrl('/third.html'), 'AUDITED', { httpStatus: 404 }),
        mobile: viewportResult(fixtureUrl('/third.html'), 'AUDITED', { httpStatus: 404 }),
      },
    }),
  ],
});

describe('AUD-6b: the check state of each link', () => {
  it('splits the links into navigated, static candidates and unverified, with the facts of each', () => {
    const { linkChecks } = buildReportViewModel(run());
    expect(linkChecks.counts).toEqual({ total: 5, navigated: 2, navigatedBroken: 1, staticCandidate: 2, unverified: 1, outsideReadScope: 0 });
    const byHref = new Map(linkChecks.links.map((entry) => [entry.href, entry]));
    expect(byHref.get('/second.html')).toEqual({
      sourcePageId: PAGE_1,
      href: '/second.html',
      resolvedUrl: fixtureUrl('/second.html'),
      admission: 'INTERNAL_NAVIGABLE',
      status: 'NAVIGATED',
      unverified: null,
      navigation: [
        {
          viewport: 'desktop', navigationOutcome: 'OK', httpStatus: 200, finalUrl: fixtureUrl('/moved.html'),
          redirectChain: [{ url: fixtureUrl('/second.html'), status: 301 }, { url: fixtureUrl('/moved.html'), status: 200 }],
        },
        { viewport: 'mobile', navigationOutcome: 'OK', httpStatus: 200, finalUrl: fixtureUrl('/moved.html'), redirectChain: [] },
      ],
      access: 'OPEN',
    });
    expect(byHref.get('/third.html')).toMatchObject({ status: 'NAVIGATED', navigation: [{ httpStatus: 404 }, { httpStatus: 404 }] });
    expect(byHref.get('/not-read.html')).toMatchObject({
      status: 'UNVERIFIED',
      navigation: [],
      access: null,
      unverified: { reason: 'TARGET_NOT_AUDITED', crawlLimitsReached: ['maxPages'], nextStep: LINK_CHECK_NEXT_STEP_TEXT.TARGET_NOT_AUDITED },
    });
    expect(byHref.get('https://example.invalid/')).toMatchObject({ status: 'STATIC_CANDIDATE', admission: 'EXTERNAL_RECORD_ONLY', unverified: null });
    expect(byHref.get('tel:0120000000')).toMatchObject({ status: 'STATIC_CANDIDATE', resolvedUrl: null, admission: 'SPECIAL_SCHEME_RECORD_ONLY' });
  });

  // DEF-296: 巡回の候補から外した行き先（読む範囲の外・読まないパス・危険な語）は、別の理由にし、確かめていないリンクの数に入れない。
  it('gives the links to a target outside the read scope their own reason, out of the unverified count', () => {
    const { linkChecks } = buildReportViewModel(run(), { isOutsideReadScope: (url) => url === fixtureUrl('/not-read.html') });
    expect(linkChecks.links.find((entry) => entry.href === '/not-read.html')).toMatchObject({
      status: 'UNVERIFIED',
      unverified: { reason: 'OUTSIDE_READ_SCOPE', nextStep: LINK_CHECK_NEXT_STEP_TEXT.OUTSIDE_READ_SCOPE },
    });
    expect(linkChecks.counts).toMatchObject({ total: 5, unverified: 0, outsideReadScope: 1 });
  });

  it('writes links.json to the bundle as the copy of the report model, with the reading note', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    expect(JSON.parse(new TextDecoder().decode(entries['links.json']))).toEqual(JSON.parse(JSON.stringify(model.linkChecks)));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.linkChecksNote);
  });
});
