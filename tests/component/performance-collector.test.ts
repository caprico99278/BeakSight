import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RESOURCE_TIMING_ENTRIES } from '../../src/core/limits.js';
import type {
  HeaderEvidence,
  NetworkEvidence,
  NetworkRequestEvidence,
  PerformanceEvidence,
  ResourceSummariesEvidence,
  WebVitalsEvidence,
} from '../../src/core/evidence-types.js';
import { PAGE_PERFORMANCE_STATE_PROPERTY, PerformanceCollector } from '../../src/evidence/performance-collector.js';

const readControl = vi.hoisted(() => ({ failuresRemaining: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async readFile(...arguments_: Parameters<typeof actual.readFile>) {
      if (readControl.failuresRemaining > 0) {
        readControl.failuresRemaining -= 1;
        throw new Error('fixture bundle read failure');
      }
      return actual.readFile(...arguments_);
    },
  };
});

const NETWORK_COVERAGE = Object.freeze({
  omittedRequestCount: 0,
  omittedResponseCount: 0,
  omittedFailureCount: 0,
});

const REQUEST_FLAGS = Object.freeze({
  isNavigationRequest: false,
  isMainFrame: true,
  truncated: false,
});

const RESPONSE_FLAGS = Object.freeze({
  ...REQUEST_FLAGS,
  transferSize: Object.freeze({ status: 'NOT_OBSERVED' as const }),
});

const EMPTY_NETWORK: NetworkEvidence = Object.freeze({
  requests: Object.freeze([]),
  responses: Object.freeze([]),
  failures: Object.freeze([]),
  ...NETWORK_COVERAGE,
});

function networkOf(
  requests: NetworkEvidence['requests'],
  responses: NetworkEvidence['responses'] = [],
): NetworkEvidence {
  return { requests, responses, failures: [], ...NETWORK_COVERAGE };
}

function timing(responseEnd = 20) {
  return Object.freeze({
    startTime: 0,
    domainLookupStart: 1,
    domainLookupEnd: 2,
    connectStart: 2,
    secureConnectionStart: 3,
    connectEnd: 4,
    requestStart: 5,
    responseStart: 10,
    responseEnd,
  });
}

function networkEvidence(): NetworkEvidence {
  return Object.freeze({
    requests: Object.freeze([
      Object.freeze({
        requestId: 'REQ-000001',
        url: 'https://fixture.test/app.js',
        method: 'GET',
        resourceType: 'script',
        headers: Object.freeze({
          status: 'OBSERVED' as const,
          values: Object.freeze({
            traceparent: '00-trace-request',
            tracestate: 'fixture=request',
            'x-request-id': 'request-123',
            authorization: '[REDACTED]',
          }),
        }),
        timing: timing(),
        redirectFromRequestId: null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze([]),
        ...REQUEST_FLAGS,
      }),
      Object.freeze({
        requestId: 'REQ-000002',
        url: 'https://fixture.test/analytics/collect',
        method: 'GET',
        resourceType: 'fetch',
        headers: Object.freeze({ status: 'FAILED' as const, errorText: 'headers unavailable' }),
        timing: timing(),
        redirectFromRequestId: null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze([]),
        ...REQUEST_FLAGS,
      }),
      Object.freeze({
        requestId: 'REQ-000003',
        url: 'https://fixture.test/site.css',
        method: 'GET',
        resourceType: 'stylesheet',
        headers: Object.freeze({ status: 'OBSERVED' as const, values: Object.freeze({}) }),
        timing: timing(),
        redirectFromRequestId: null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze([]),
        ...REQUEST_FLAGS,
      }),
    ]),
    responses: Object.freeze([
      Object.freeze({
        requestId: 'REQ-000001',
        url: 'https://fixture.test/app.js',
        status: 200,
        statusText: 'OK',
        headers: Object.freeze({
          status: 'OBSERVED' as const,
          values: Object.freeze({
            'X-Correlation-Id': 'correlation-456',
            'set-cookie': '[REDACTED]',
          }),
        }),
        contentLengthHeader: '12',
        timing: timing(),
        ...RESPONSE_FLAGS,
      }),
      Object.freeze({
        requestId: 'REQ-000002',
        url: 'https://fixture.test/analytics/collect',
        status: 204,
        statusText: 'No Content',
        headers: Object.freeze({ status: 'FAILED' as const, errorText: 'response headers unavailable' }),
        contentLengthHeader: null,
        timing: timing(),
        ...RESPONSE_FLAGS,
      }),
    ]),
    failures: Object.freeze([]),
    ...NETWORK_COVERAGE,
  });
}

function requestEvidence(
  requestId: string,
  url: string,
  resourceType: string,
  headers: HeaderEvidence = Object.freeze({
    status: 'OBSERVED',
    values: Object.freeze({}),
  }),
): NetworkRequestEvidence {
  return {
    requestId,
    url,
    method: 'GET',
    resourceType,
    headers,
    timing: timing(),
    redirectFromRequestId: null,
    redirectToRequestId: null,
    redirectChainRequestIds: [],
    ...REQUEST_FLAGS,
  };
}

function networkWithRequests(requests: NetworkRequestEvidence[]): NetworkEvidence {
  return networkOf(requests);
}

function rawResource(
  name: string,
  initiatorType: string,
  sizes: { readonly transferSize?: number; readonly encodedBodySize?: number; readonly decodedBodySize?: number } = {},
): Record<string, unknown> {
  return {
    name,
    initiatorType,
    startTime: 1,
    duration: 2,
    responseStart: 2,
    responseEnd: 3,
    transferSize: sizes.transferSize ?? 10,
    encodedBodySize: sizes.encodedBodySize ?? 8,
    decodedBodySize: sizes.decodedBodySize ?? 12,
    serverTiming: [],
    omittedServerTimingCount: 0,
  };
}

interface RawBrowserEvidenceFixture {
  readonly webVitals: {
    readonly CLS: Record<string, unknown>;
    readonly FCP: Record<string, unknown>;
    INP: Record<string, unknown>;
    readonly LCP: Record<string, unknown>;
    readonly TTFB: Record<string, unknown>;
  };
  navigationEntries: Record<string, unknown>[];
  resourceEntries: Record<string, unknown>[];
  omittedResourceEntryCount: unknown;
  resourceBuffer: unknown;
  webVitalsTextTruncated: unknown;
}

function rawBrowserEvidence(): RawBrowserEvidenceFixture {
  return {
    webVitals: {
      CLS: {
        status: 'OBSERVED',
        value: 0,
        id: 'cls-1',
        rating: 'good',
        navigationType: 'navigate',
        attribution: {
          largestShiftTarget: '#hero',
          largestShiftTime: 12,
          largestShiftValue: 0,
          loadState: 'complete',
          largestShiftEntry: { forbidden: true },
        },
      },
      FCP: {
        status: 'OBSERVED',
        value: 15,
        id: 'fcp-1',
        rating: 'good',
        navigationType: 'navigate',
        attribution: { forbidden: true },
      },
      INP: {
        status: 'NOT_OBSERVED',
        value: null,
        id: null,
        rating: null,
        navigationType: null,
        attribution: null,
      },
      LCP: {
        status: 'OBSERVED',
        value: 25,
        id: 'lcp-1',
        rating: 'good',
        navigationType: 'navigate',
        attribution: {
          target: '#hero',
          url: 'https://fixture.test/hero.png',
          timeToFirstByte: 4,
          resourceLoadDelay: 2,
          resourceLoadDuration: 8,
          elementRenderDelay: 11,
          lcpEntry: { forbidden: true },
        },
      },
      TTFB: {
        status: 'UNSUPPORTED',
        value: null,
        id: null,
        rating: null,
        navigationType: null,
        attribution: null,
      },
    },
    navigationEntries: [{
      name: 'https://fixture.test/',
      type: 'navigate',
      startTime: 0,
      duration: 40,
      responseStart: 10,
      responseEnd: 20,
      domContentLoadedEventStart: 21,
      domContentLoadedEventEnd: 22,
      loadEventStart: 30,
      loadEventEnd: 31,
      transferSize: 1_000,
      encodedBodySize: 800,
      decodedBodySize: 1_200,
      serverTiming: [
        { name: 'cache', description: 'hit', duration: 1.5 },
        { name: 'db', description: 'primary', duration: 3 },
      ],
      omittedServerTimingCount: 0,
    }],
    resourceEntries: [
      {
        name: 'https://fixture.test/app.js',
        initiatorType: 'other',
        startTime: 5,
        duration: 12,
        responseStart: 8,
        responseEnd: 17,
        transferSize: 100,
        encodedBodySize: 80,
        decodedBodySize: 120,
        serverTiming: [{ name: 'edge', description: 'warm', duration: 0.5 }],
        omittedServerTimingCount: 0,
      },
      {
        name: 'https://fixture.test/photo.png',
        initiatorType: 'img',
        startTime: 6,
        duration: 15,
        responseStart: 9,
        responseEnd: 21,
        transferSize: 200,
        encodedBodySize: 180,
        decodedBodySize: 240,
        serverTiming: [],
        omittedServerTimingCount: 0,
      },
      {
        name: 'https://fixture.test/site.css',
        initiatorType: 'link',
        startTime: 6,
        duration: 4,
        responseStart: 7,
        responseEnd: 10,
        transferSize: 90,
        encodedBodySize: 70,
        decodedBodySize: 110,
        serverTiming: [],
        omittedServerTimingCount: 0,
      },
      {
        name: 'https://fixture.test/analytics/collect',
        initiatorType: 'fetch',
        startTime: 8,
        duration: 6,
        responseStart: 10,
        responseEnd: 14,
        transferSize: 40,
        encodedBodySize: 20,
        decodedBodySize: 20,
        serverTiming: [],
        omittedServerTimingCount: 0,
      },
      {
        name: 'https://fixture.test/unknown.bin',
        initiatorType: 'link',
        startTime: 7,
        duration: 5,
        responseStart: 8,
        responseEnd: 12,
        transferSize: 50,
        encodedBodySize: 40,
        decodedBodySize: 60,
        serverTiming: [],
        omittedServerTimingCount: 0,
      },
    ],
    omittedResourceEntryCount: 0,
    resourceBuffer: { size: 500, full: false },
    webVitalsTextTruncated: false,
  };
}

function fakePage(result: unknown): Page {
  return { evaluate: vi.fn(async () => result) } as unknown as Page;
}

/**
 * L2: 期限を渡さないときの偽のページ（進みの見張りのページの自発の変化の受け口 `on`・`off`・`isClosed` を持つ。事象は出さず、画面の変化の読み取りも
 * できないので、ページの自発の変化の印は付かない）。
 */
function watchablePage(evaluate: () => Promise<unknown>): Page {
  return { evaluate: vi.fn(evaluate), on: () => undefined, off: () => undefined, isClosed: () => false } as unknown as Page;
}

function requireWebVitals(result: PerformanceEvidence): Readonly<WebVitalsEvidence> {
  expect(result.webVitals).not.toBeNull();
  if (result.webVitals === null) throw new Error('Expected available Web Vital evidence');
  return result.webVitals;
}

function requireResourceSummaries(result: PerformanceEvidence): Readonly<ResourceSummariesEvidence> {
  expect(result.resourceSummaries).not.toBeNull();
  if (result.resourceSummaries === null) throw new Error('Expected available resource summaries');
  return result.resourceSummaries;
}

afterEach(() => {
  readControl.failuresRemaining = 0;
  vi.useRealTimers();
});

describe('PerformanceCollector', () => {
  it('installs the local attribution bundle once per context across collector instances', async () => {
    const scripts: string[] = [];
    const context = {
      addInitScript: vi.fn(async ({ content }: { content: string }) => {
        scripts.push(content);
      }),
    } as unknown as BrowserContext;

    await Promise.all([
      new PerformanceCollector().installBeforeNavigation(context),
      new PerformanceCollector().installBeforeNavigation(context),
    ]);
    await new PerformanceCollector().installBeforeNavigation(context);

    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.length).toBeGreaterThan(15_000);
    expect(scripts[0]).toContain('onCLS');
    // UPG-SW: 状態の大域の名前は、ただ 1 つの定数（プロセスごとの乱数。BeakSight の文字を含まない）で、初期化のスクリプトに渡す。
    expect(scripts[0]).toContain(JSON.stringify(PAGE_PERFORMANCE_STATE_PROPERTY));
    expect(PAGE_PERFORMANCE_STATE_PROPERTY).toMatch(/^_[0-9a-f]{16}$/u);
    expect(scripts[0]).not.toMatch(/beaksight/iu);
  });

  it('does not mark failed bundle reads or addInitScript calls as installed', async () => {
    readControl.failuresRemaining = 1;
    let addFailuresRemaining = 1;
    const context = {
      addInitScript: vi.fn(async () => {
        if (addFailuresRemaining > 0) {
          addFailuresRemaining -= 1;
          throw new Error('fixture addInitScript failure');
        }
      }),
    } as unknown as BrowserContext;
    const collector = new PerformanceCollector();

    await expect(collector.installBeforeNavigation(context)).rejects.toThrow('fixture bundle read failure');
    await expect(collector.installBeforeNavigation(context)).rejects.toThrow('fixture addInitScript failure');
    await collector.installBeforeNavigation(context);
    await collector.installBeforeNavigation(context);

    expect(context.addInitScript).toHaveBeenCalledTimes(2);
  });

  it('preserves all five vital states and never turns missing INP into zero', async () => {
    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    const webVitals = requireWebVitals(result);
    expect(webVitals.CLS).toMatchObject({ status: 'OBSERVED', value: 0 });
    expect(webVitals.FCP).toMatchObject({ status: 'OBSERVED', value: 15 });
    expect(webVitals.INP).toEqual({
      status: 'NOT_OBSERVED',
      value: null,
      id: null,
      navigationType: null,
      attribution: null,
    });
    expect(webVitals.LCP).toMatchObject({ status: 'OBSERVED', value: 25 });
    expect(webVitals.TTFB).toMatchObject({ status: 'UNSUPPORTED', value: null });
  });

  it('retains only bounded primitive CLS, LCP, and INP attribution allowlists', async () => {
    const raw = rawBrowserEvidence();
    raw.webVitals.INP = {
      status: 'OBSERVED',
      value: 80,
      id: 'inp-1',
      rating: 'needs-improvement',
      navigationType: 'navigate',
      attribution: {
        interactionTarget: '#control',
        interactionTime: 100,
        interactionType: 'pointer',
        nextPaintTime: 180,
        inputDelay: 10,
        processingDuration: 30,
        presentationDelay: 40,
        loadState: 'complete',
        processedEventEntries: [{ forbidden: true }],
        arbitrary: 'forbidden',
      },
    };
    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    const webVitals = requireWebVitals(result);
    expect(webVitals.CLS.attribution).toEqual({
      largestShiftTarget: '#hero',
      largestShiftTime: 12,
      largestShiftValue: 0,
      loadState: 'complete',
    });
    expect(webVitals.LCP.attribution).toEqual({
      target: '#hero',
      url: 'https://fixture.test/hero.png',
      timeToFirstByte: 4,
      resourceLoadDelay: 2,
      resourceLoadDuration: 8,
      elementRenderDelay: 11,
    });
    expect(webVitals.INP.attribution).toEqual({
      interactionTarget: '#control',
      interactionTime: 100,
      interactionType: 'pointer',
      nextPaintTime: 180,
      inputDelay: 10,
      processingDuration: 30,
      presentationDelay: 40,
      loadState: 'complete',
    });
    expect(JSON.stringify(result)).not.toContain('forbidden');
  });

  it('maps bounded navigation, resources, server timing, and transparent resource categories', async () => {
    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkEvidence(),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.navigationTiming).toMatchObject({
      url: 'https://fixture.test/',
      navigationType: 'navigate',
      domContentLoadedEventStart: 21,
      domContentLoadedEventEnd: 22,
      loadEventStart: 30,
      loadEventEnd: 31,
      transferSize: 1_000,
      encodedBodySize: 800,
      decodedBodySize: 1_200,
    });
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://fixture.test/app.js',
        requestId: 'REQ-000001',
        networkResourceType: 'script',
        category: 'script',
        categoryBasis: 'NETWORK_EVIDENCE',
      }),
      expect.objectContaining({
        url: 'https://fixture.test/photo.png',
        requestId: null,
        category: 'image',
        categoryBasis: 'INITIATOR_TYPE',
      }),
      expect.objectContaining({
        url: 'https://fixture.test/unknown.bin',
        category: null,
        categoryBasis: 'UNKNOWN',
      }),
    ]));
    const resourceSummaries = requireResourceSummaries(result);
    expect(resourceSummaries.script).toEqual({
      count: 1,
      sizeUnknownCount: 0,
      transferSize: 100,
      encodedBodySize: 80,
      decodedBodySize: 120,
    });
    expect(resourceSummaries.image.count).toBe(1);
    expect(resourceSummaries.stylesheet).toEqual({
      count: 1,
      sizeUnknownCount: 0,
      transferSize: 90,
      encodedBodySize: 70,
      decodedBodySize: 110,
    });
    expect(resourceSummaries['fetch-xhr'].count).toBe(1);
    expect(result.serverTiming).toEqual([
      expect.objectContaining({ source: 'NAVIGATION', name: 'cache', duration: 1.5 }),
      expect.objectContaining({ source: 'NAVIGATION', name: 'db', duration: 3 }),
      expect.objectContaining({ source: 'RESOURCE', url: 'https://fixture.test/app.js', name: 'edge' }),
    ]);
  });

  it('clones canonical NetworkEvidence telemetry headers, failure truth, and candidate bases', async () => {
    const network = networkEvidence();
    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.telemetryHeaders).toEqual([
      {
        direction: 'REQUEST',
        requestId: 'REQ-000001',
        url: 'https://fixture.test/app.js',
        status: 'OBSERVED',
        values: {
          traceparent: '00-trace-request',
          tracestate: 'fixture=request',
          'x-request-id': 'request-123',
        },
      },
      {
        direction: 'REQUEST',
        requestId: 'REQ-000002',
        url: 'https://fixture.test/analytics/collect',
        status: 'FAILED',
        errorText: 'headers unavailable',
      },
      {
        direction: 'RESPONSE',
        requestId: 'REQ-000001',
        url: 'https://fixture.test/app.js',
        status: 'OBSERVED',
        values: { 'X-Correlation-Id': 'correlation-456' },
      },
      {
        direction: 'RESPONSE',
        requestId: 'REQ-000002',
        url: 'https://fixture.test/analytics/collect',
        status: 'FAILED',
        errorText: 'response headers unavailable',
      },
    ]);
    expect(result.telemetryCandidates).toEqual([
      {
        requestId: 'REQ-000001',
        url: 'https://fixture.test/app.js',
        method: 'GET',
        resourceType: 'script',
        matchingBasis: ['TRACE_OR_CORRELATION_HEADER'],
        matchedHeaderNames: ['traceparent', 'tracestate', 'x-request-id', 'X-Correlation-Id'],
        matchedHints: [],
      },
      {
        requestId: 'REQ-000002',
        url: 'https://fixture.test/analytics/collect',
        method: 'GET',
        resourceType: 'fetch',
        matchingBasis: ['GENERIC_URL_HINT'],
        matchedHeaderNames: [],
        matchedHints: ['analytics', 'collect'],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('authorization');
    expect(JSON.stringify(result)).not.toContain('set-cookie');
    expect(network.requests[0]?.headers.status).toBe('OBSERVED');
  });

  it('returns immutable deadline PARTIAL evidence without starting evaluation after entry expiry', async () => {
    const page = { evaluate: vi.fn() } as unknown as Page;
    const result = await new PerformanceCollector().collect(page, networkEvidence(), {
      deadlineAtMs: Date.now() - 1,
    });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(result.navigationTiming).toBeNull();
    expect(result.resources).toEqual([]);
    expect(result.webVitals).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.webVitals)).toBe(true);
    expect(Object.isFrozen(result.resources)).toBe(true);
    expect(Object.isFrozen(result.telemetryHeaders)).toBe(true);
    expect(Object.isFrozen(result.telemetryHeaders[0])).toBe(true);
  });

  it('returns explicit evaluation PARTIAL while preserving only caller-supplied telemetry facts', async () => {
    const page = { evaluate: vi.fn(async () => { throw new Error('fixture evaluation failure'); }) } as unknown as Page;
    const result = await new PerformanceCollector().collect(page, networkEvidence(), {
      deadlineAtMs: Date.now() + 1_000,
    });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED' });
    expect(result.webVitals).toBeNull();
    expect(result.navigationTiming).toBeNull();
    expect(result.resources).toEqual([]);
    expect(result.telemetryCandidates).toHaveLength(2);
  });

  it('rejects invalid browser numbers without retaining synthetic or non-finite values', async () => {
    const raw = rawBrowserEvidence();
    raw.webVitals.LCP.value = Number.NaN;
    raw.navigationEntries[0]!.transferSize = -1;
    raw.resourceEntries[0]!.duration = Number.POSITIVE_INFINITY;
    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'INVALID_BROWSER_DATA' });
    expect(result.webVitals).toBeNull();
    expect(result.navigationTiming).toBeNull();
    expect(result.resources.some((resource) => resource.url.endsWith('/app.js'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('null,"id":"lcp-1"');
  });

  it('deeply freezes every result layer and detaches it from page and network aliases', async () => {
    const raw = rawBrowserEvidence();
    const network = networkEvidence();
    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );
    raw.resourceEntries[0]!.name = 'https://mutated.test/';

    expect(result.resources[0]?.url).toBe('https://fixture.test/app.js');
    expect(Object.isFrozen(result.navigationTiming)).toBe(true);
    expect(Object.isFrozen(result.navigationTiming?.serverTiming)).toBe(true);
    expect(Object.isFrozen(result.resources[0])).toBe(true);
    expect(Object.isFrozen(result.resources[0]?.serverTiming)).toBe(true);
    expect(Object.isFrozen(result.resourceSummaries)).toBe(true);
    expect(Object.isFrozen(requireResourceSummaries(result).script)).toBe(true);
    expect(Object.isFrozen(result.serverTiming[0])).toBe(true);
    expect(Object.isFrozen(result.telemetryCandidates[0]?.matchingBasis)).toBe(true);
    expect(Object.isFrozen(requireWebVitals(result).CLS.attribution)).toBe(true);
  });

  it('L2: projects every request and response beyond the former limits (500 and 200)', async () => {
    const requests = Array.from({ length: 1_200 }, (_value, index) => requestEvidence(
      `REQ-${index}`,
      `https://fixture.test/analytics/${index}`,
      'fetch',
      { status: 'OBSERVED', values: { traceparent: `00-${index}` } },
    ));
    const responses = requests.map((request) => ({
      requestId: request.requestId,
      url: request.url,
      status: 200,
      statusText: 'OK',
      headers: { status: 'OBSERVED' as const, values: { 'x-request-id': request.requestId } },
      contentLengthHeader: null,
      timing: timing(),
      ...RESPONSE_FLAGS,
    }));

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkOf(requests, responses),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(result.telemetryHeaders).toHaveLength(2_400);
    expect(result.telemetryCandidates).toHaveLength(1_200);
    expect(result.truncation).toMatchObject({
      omittedNetworkRequestCount: 0,
      omittedNetworkResponseCount: 0,
      omittedTelemetryHeaderCount: 0,
      omittedTelemetryCandidateCount: 0,
    });
  });

  it('L2: keeps every telemetry header field of one record (no 32 field limit)', async () => {
    const values: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      values[`x-filler-${index}`] = 'v';
    }
    values['x-request-id'] = 'late-field';
    const request = requestEvidence('REQ-WIDE', 'https://fixture.test/api', 'fetch', { status: 'OBSERVED', values });

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkWithRequests([request]),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.telemetryHeaders).toEqual([expect.objectContaining({ requestId: 'REQ-WIDE', values: { 'x-request-id': 'late-field' } })]);
  });

  it.each([
    ['navigation entries', (raw: RawBrowserEvidenceFixture) => { raw.navigationEntries = {} as Record<string, unknown>[]; }],
    ['resource entries', (raw: RawBrowserEvidenceFixture) => { raw.resourceEntries = {} as Record<string, unknown>[]; }],
    ['navigation Server-Timing', (raw: RawBrowserEvidenceFixture) => {
      raw.navigationEntries[0]!.serverTiming = {};
    }],
    ['resource Server-Timing', (raw: RawBrowserEvidenceFixture) => {
      raw.resourceEntries[0]!.serverTiming = {};
    }],
  ])('rejects malformed non-array %s instead of treating it as empty', async (_name, mutate) => {
    const raw = rawBrowserEvidence();
    mutate(raw);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'INVALID_BROWSER_DATA' });
  });

  it('correlates resources only to compatible non-document requests with deterministic duplicate use', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/same-fetch', 'fetch'),
      rawResource('https://fixture.test/ambiguous', 'link'),
      rawResource('https://fixture.test/duplicate-images', 'img'),
      rawResource('https://fixture.test/duplicate-images', 'img'),
    );
    const network = networkWithRequests([
      requestEvidence('REQ-DOCUMENT', 'https://fixture.test/same-fetch', 'document'),
      requestEvidence('REQ-FETCH', 'https://fixture.test/same-fetch', 'fetch'),
      requestEvidence('REQ-AMBIGUOUS-SCRIPT', 'https://fixture.test/ambiguous', 'script'),
      requestEvidence('REQ-AMBIGUOUS-IMAGE', 'https://fixture.test/ambiguous', 'image'),
      requestEvidence('REQ-IMAGE-ONE', 'https://fixture.test/duplicate-images', 'image'),
      requestEvidence('REQ-IMAGE-TWO', 'https://fixture.test/duplicate-images', 'image'),
    ]);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources.map(({ requestId, networkResourceType, category, categoryBasis }) => ({
      requestId,
      networkResourceType,
      category,
      categoryBasis,
    }))).toEqual([
      {
        requestId: 'REQ-FETCH',
        networkResourceType: 'fetch',
        category: 'fetch-xhr',
        categoryBasis: 'NETWORK_EVIDENCE',
      },
      {
        requestId: null,
        networkResourceType: null,
        category: null,
        categoryBasis: 'UNKNOWN',
      },
      {
        requestId: 'REQ-IMAGE-ONE',
        networkResourceType: 'image',
        category: 'image',
        categoryBasis: 'NETWORK_EVIDENCE',
      },
      {
        requestId: 'REQ-IMAGE-TWO',
        networkResourceType: 'image',
        category: 'image',
        categoryBasis: 'NETWORK_EVIDENCE',
      },
    ]);
  });

  it('uses exact raw request types for known fetch initiator identity', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/fetch-select', 'fetch'),
      rawResource('https://fixture.test/fetch-no-match', 'fetch'),
    );
    const network = networkWithRequests([
      requestEvidence('REQ-XHR-FIRST', 'https://fixture.test/fetch-select', 'xhr'),
      requestEvidence('REQ-FETCH', 'https://fixture.test/fetch-select', 'fetch'),
      requestEvidence('REQ-XHR-ONLY', 'https://fixture.test/fetch-no-match', 'xhr'),
    ]);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({
      requestId: 'REQ-FETCH',
      networkResourceType: 'fetch',
      category: 'fetch-xhr',
      categoryBasis: 'NETWORK_EVIDENCE',
    });
    expect(result.resources[1]).toMatchObject({
      requestId: null,
      networkResourceType: null,
      category: 'fetch-xhr',
      categoryBasis: 'INITIATOR_TYPE',
    });
  });

  it('does not correlate an unknown initiator when duplicate URL request types are heterogeneous', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/heterogeneous', 'link'),
    );
    const network = networkWithRequests([
      requestEvidence('REQ-HETEROGENEOUS-SCRIPT', 'https://fixture.test/heterogeneous', 'script'),
      requestEvidence('REQ-HETEROGENEOUS-FONT', 'https://fixture.test/heterogeneous', 'font'),
    ]);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({
      requestId: null,
      networkResourceType: null,
      category: null,
      categoryBasis: 'UNKNOWN',
    });
  });

  it('does not collapse fetch and xhr into one request identity for an unknown initiator', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/fetch-or-xhr', 'link'),
    );
    const network = networkWithRequests([
      requestEvidence('REQ-FETCH', 'https://fixture.test/fetch-or-xhr', 'fetch'),
      requestEvidence('REQ-XHR', 'https://fixture.test/fetch-or-xhr', 'xhr'),
    ]);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({
      requestId: null,
      networkResourceType: null,
      category: null,
      categoryBasis: 'UNKNOWN',
    });
  });

  it('does not correlate overlong raw resource types that differ beyond the display bound', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/overlong-types', 'link'),
    );
    const sharedPrefix = 'x'.repeat(512);
    const network = networkWithRequests([
      requestEvidence('REQ-TYPE-A', 'https://fixture.test/overlong-types', `${sharedPrefix}a`),
      requestEvidence('REQ-TYPE-B', 'https://fixture.test/overlong-types', `${sharedPrefix}b`),
    ]);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      network,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({
      requestId: null,
      networkResourceType: null,
      category: null,
      categoryBasis: 'UNKNOWN',
    });
  });

  it('does not claim a css-initiated resource is a stylesheet without Task 7 type evidence', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/css-initiated-image.png', 'css'),
    );

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({
      requestId: null,
      networkResourceType: null,
      category: null,
      categoryBasis: 'UNKNOWN',
    });
  });

  it('uses one detached NetworkEvidence projection when caller data mutates during evaluate', async () => {
    let resolveEvaluation: ((value: unknown) => void) | undefined;
    const evaluation = new Promise((resolve) => { resolveEvaluation = resolve; });
    const request = {
      ...requestEvidence(
        'REQ-ORIGINAL',
        'https://fixture.test/app.js',
        'script',
        { status: 'OBSERVED', values: { traceparent: '00-original' } },
      ),
    };
    const network = networkWithRequests([request]);
    const page = { evaluate: vi.fn(() => evaluation) } as unknown as Page;
    const resultPromise = new PerformanceCollector().collect(page, network, {
      deadlineAtMs: Date.now() + 1_000,
    });

    request.requestId = 'REQ-MUTATED';
    request.url = 'https://mutated.test/changed.js';
    request.resourceType = 'image';
    request.headers = { status: 'OBSERVED', values: { traceparent: '00-mutated' } };
    resolveEvaluation?.(rawBrowserEvidence());
    const result = await resultPromise;

    expect(result.resources[0]).toMatchObject({
      requestId: 'REQ-ORIGINAL',
      networkResourceType: 'script',
      category: 'script',
      categoryBasis: 'NETWORK_EVIDENCE',
    });
    expect(result.telemetryHeaders[0]).toMatchObject({
      requestId: 'REQ-ORIGINAL',
      url: 'https://fixture.test/app.js',
      values: { traceparent: '00-original' },
    });
    expect(JSON.stringify(result)).not.toContain('MUTATED');
    expect(JSON.stringify(result)).not.toContain('mutated.test');
  });

  it('makes unsafe finite resource summary overflow unavailable instead of emitting Infinity', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/huge-a.js', 'script', {
        transferSize: Number.MAX_VALUE,
        encodedBodySize: Number.MAX_VALUE,
        decodedBodySize: Number.MAX_VALUE,
      }),
      rawResource('https://fixture.test/huge-b.js', 'script', {
        transferSize: Number.MAX_VALUE,
        encodedBodySize: Number.MAX_VALUE,
        decodedBodySize: Number.MAX_VALUE,
      }),
    );

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({
      status: 'PARTIAL',
      reason: 'INVALID_BROWSER_DATA',
      resourceSummaries: null,
    });
    expect(JSON.stringify(result)).not.toContain('"transferSize":null');
    expect(JSON.stringify(result)).not.toContain('Infinity');
  });
  it('does not retain the web-vitals rating even when the browser reports one', async () => {
    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    const webVitals = requireWebVitals(result);
    for (const vital of Object.values(webVitals)) {
      expect(vital).not.toHaveProperty('rating');
    }
    expect(JSON.stringify(result)).not.toContain('rating');
  });

  it('accepts unobserved vitals that carry no rating field', async () => {
    const raw = rawBrowserEvidence();
    raw.webVitals.INP = {
      status: 'NOT_OBSERVED',
      value: null,
      id: null,
      navigationType: null,
      attribution: null,
    };

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(requireWebVitals(result).INP).toEqual({
      status: 'NOT_OBSERVED',
      value: null,
      id: null,
      navigationType: null,
      attribution: null,
    });
  });

  it.each([
    ['evaluation failure', () => ({ evaluate: vi.fn(async () => { throw new Error('fixture failure'); }) }), 1_000],
    ['expired deadline', () => ({ evaluate: vi.fn() }), -1],
    ['non-object browser data', () => ({ evaluate: vi.fn(async () => null) }), 1_000],
  ] as const)('does not report zero resource summaries after %s', async (_name, createPage, offsetMs) => {
    const result = await new PerformanceCollector().collect(
      createPage() as unknown as Page,
      networkEvidence(),
      { deadlineAtMs: Date.now() + offsetMs },
    );

    expect(result.status).toBe('PARTIAL');
    expect(result.resourceSummaries).toBeNull();
    expect(result.resourceCoverage).toBeNull();
    expect(result.truncation?.omittedServerTimingCount ?? null).toBeNull();
    expect(JSON.stringify(result)).not.toContain('"count":0');
  });

  it('reports a full Resource Timing buffer as PARTIAL with the coverage facts', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceBuffer = { size: MAX_RESOURCE_TIMING_ENTRIES, full: true };

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'RESOURCE_LIMIT_REACHED' });
    expect(result.resourceCoverage).toEqual({
      bufferSize: MAX_RESOURCE_TIMING_ENTRIES,
      bufferFull: true,
      retainedEntryCount: 5,
      omittedEntryCount: 0,
    });
    expect(result.resources).toHaveLength(5);
    expect(requireResourceSummaries(result).image.count).toBe(1);
    expect(Object.isFrozen(result.resourceCoverage)).toBe(true);
  });

  it('counts resource entries beyond the retained limit and does not claim completeness', async () => {
    const raw = rawBrowserEvidence();
    raw.omittedResourceEntryCount = 7;

    const reported = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(reported).toMatchObject({ status: 'PARTIAL', reason: 'RESOURCE_LIMIT_REACHED' });
    expect(reported.resourceCoverage).toMatchObject({ bufferFull: false, retainedEntryCount: 5, omittedEntryCount: 7 });

  });

  it('L2: records every resource entry the browser returned beyond the former limit (500)', async () => {
    const oversized = rawBrowserEvidence();
    oversized.resourceEntries.splice(0, oversized.resourceEntries.length, ...Array.from(
      { length: MAX_RESOURCE_TIMING_ENTRIES + 3 },
      (_value, index) => rawResource(`https://fixture.test/item-${index}.js`, 'script'),
    ));
    const all = await new PerformanceCollector().collect(
      fakePage(oversized),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(all.status).toBe('COMPLETE');
    expect(all.resources).toHaveLength(MAX_RESOURCE_TIMING_ENTRIES + 3);
    expect(all.resourceCoverage).toMatchObject({
      retainedEntryCount: MAX_RESOURCE_TIMING_ENTRIES + 3,
      omittedEntryCount: 0,
    });
  });

  it('L2: does not report a full browser buffer as a loss when the entries were observed by the performance observer', async () => {
    const raw = { ...rawBrowserEvidence(), resourceSource: 'OBSERVER', resourceBuffer: { size: MAX_RESOURCE_TIMING_ENTRIES, full: true } };

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(result.resourceCoverage).toMatchObject({ bufferFull: true, omittedEntryCount: 0 });
  });

  it.each([
    ['missing buffer facts', (raw: RawBrowserEvidenceFixture) => { raw.resourceBuffer = undefined; }],
    ['non-boolean buffer full flag', (raw: RawBrowserEvidenceFixture) => { raw.resourceBuffer = { size: 500, full: 'no' }; }],
    ['negative omitted entry count', (raw: RawBrowserEvidenceFixture) => { raw.omittedResourceEntryCount = -1; }],
    ['missing omitted server timing count', (raw: RawBrowserEvidenceFixture) => {
      delete raw.resourceEntries[0]!.omittedServerTimingCount;
    }],
  ])('rejects %s instead of assuming complete resource coverage', async (_name, mutate) => {
    const raw = rawBrowserEvidence();
    mutate(raw);

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'INVALID_BROWSER_DATA' });
  });

  it('prefers INVALID_BROWSER_DATA over RESOURCE_LIMIT_REACHED when both apply', async () => {
    const raw = rawBrowserEvidence();
    raw.resourceBuffer = { size: MAX_RESOURCE_TIMING_ENTRIES, full: true };
    raw.resourceEntries[0]!.duration = -1;

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'INVALID_BROWSER_DATA' });
    expect(result.resourceCoverage?.bufferFull).toBe(true);
  });

  it('keeps cross-origin zero-size resources out of transfer totals and counts them as size unknown', async () => {
    const raw = rawBrowserEvidence();
    const zero = { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 };
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://cdn.other.test/restricted.js', 'script', zero),
      rawResource('https://fixture.test/cached.js', 'script', zero),
      rawResource('https://cdn.other.test/allowed.js', 'script', {
        transferSize: 300,
        encodedBodySize: 200,
        decodedBodySize: 400,
      }),
      rawResource('https://fixture.test/app.js', 'script', {
        transferSize: 10,
        encodedBodySize: 8,
        decodedBodySize: 12,
      }),
    );

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(result.resources.map(({ url, sizeStatus, transferSize }) => ({ url, sizeStatus, transferSize }))).toEqual([
      { url: 'https://cdn.other.test/restricted.js', sizeStatus: 'CROSS_ORIGIN_RESTRICTED', transferSize: null },
      { url: 'https://fixture.test/cached.js', sizeStatus: 'OBSERVED', transferSize: 0 },
      { url: 'https://cdn.other.test/allowed.js', sizeStatus: 'OBSERVED', transferSize: 300 },
      { url: 'https://fixture.test/app.js', sizeStatus: 'OBSERVED', transferSize: 10 },
    ]);
    expect(result.resources[0]).toMatchObject({ encodedBodySize: null, decodedBodySize: null });
    expect(requireResourceSummaries(result).script).toEqual({
      count: 4,
      sizeUnknownCount: 1,
      transferSize: 310,
      encodedBodySize: 208,
      decodedBodySize: 412,
    });
  });

  it('treats zero-size resources as size unknown when the document origin is not observed', async () => {
    const raw = rawBrowserEvidence();
    raw.navigationEntries = [];
    raw.resourceEntries.splice(0, raw.resourceEntries.length,
      rawResource('https://fixture.test/zero.js', 'script', { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 }),
    );

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({ sizeStatus: 'CROSS_ORIGIN_RESTRICTED', transferSize: null });
    expect(requireResourceSummaries(result).script).toMatchObject({ count: 1, sizeUnknownCount: 1, transferSize: 0 });
  });

  it('L2: records every Server-Timing entry beyond the former per-entry (20) and total (500) limits', async () => {
    const raw = rawBrowserEvidence();
    const serverTiming = Array.from({ length: 25 }, (_value, index) => ({
      name: `metric-${index}`,
      description: '',
      duration: 1,
    }));
    raw.navigationEntries[0]!.serverTiming = [];
    raw.resourceEntries.splice(0, raw.resourceEntries.length, ...Array.from({ length: 26 }, (_value, index) => ({
      ...rawResource(`https://fixture.test/timed-${index}.js`, 'script'),
      serverTiming,
      omittedServerTimingCount: 0,
    })));

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(result.serverTiming).toHaveLength(26 * 25);
    expect(result.truncation?.omittedServerTimingCount).toBe(0);
  });

  it('still counts Server-Timing entries that a browser snapshot reported as omitted', async () => {
    const raw = rawBrowserEvidence();
    const serverTiming = Array.from({ length: 20 }, (_value, index) => ({
      name: `metric-${index}`,
      description: '',
      duration: 1,
    }));
    raw.navigationEntries[0]!.serverTiming = [];
    raw.resourceEntries.splice(0, raw.resourceEntries.length, ...Array.from({ length: 26 }, (_value, index) => ({
      ...rawResource(`https://fixture.test/timed-${index}.js`, 'script'),
      serverTiming,
      omittedServerTimingCount: 1,
    })));

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    // L2: 上限で捨てないので、記録は全部（26 × 20）。数は、ブラウザが省いたと報告した数（1 件ずつ）だけ。
    expect(result.serverTiming).toHaveLength(26 * 20);
    expect(result.truncation?.omittedServerTimingCount).toBe(26);
  });

  it('L2: without a deadline, waits for a browser snapshot longer than the former deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const page = watchablePage(() => new Promise((resolve) => {
      setTimeout(() => resolve(rawBrowserEvidence()), 120_000);
    }));

    let settled = false;
    const pending = new PerformanceCollector().collect(page, networkEvidence()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await pending;
    expect(result.status).toBe('COMPLETE');
    expect(result.resources).toHaveLength(5);
  });

  it('L2: without a deadline, ends as unresponsive only after the quiet limit and keeps the network facts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const page = watchablePage(() => new Promise(() => undefined));
    const quietLimitMs = 5_000;

    let settled = false;
    const pending = new PerformanceCollector().collect(page, networkEvidence(), { watch: { quietLimitMs } }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(quietLimitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'STAGE_UNRESPONSIVE' });
    expect(result.telemetryCandidates).toHaveLength(2);
    expect(result.resources).toEqual([]);
  });

  it('reports no truncation for small evidence', async () => {
    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkEvidence(),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.truncation).toEqual({
      omittedServerTimingCount: 0,
      omittedTelemetryHeaderCount: 0,
      omittedTelemetryCandidateCount: 0,
      omittedNetworkRequestCount: 0,
      omittedNetworkResponseCount: 0,
      textTruncated: false,
    });
    expect(Object.isFrozen(result.truncation)).toBe(true);
  });

  // 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しは、network の記録で 1 件の記録とまとめた記録（`repeatedReads`）になる。Resource Timing の項目は、
  // 1 件の記録と照らし合わせられなかったら、同じ口（Origin と path）のまとめた記録の資源の種類で分ける（要求の ID は、1 件の記録がないので持たない）。
  it('categorizes the Resource Timing entries of the repeated reads by the resource type of their group', async () => {
    const first = requestEvidence('REQ-CSS-0', 'https://fixture.test/item.css?i=0', 'stylesheet');
    const network: NetworkEvidence = {
      ...networkWithRequests([first]),
      repeatedReads: [{
        method: 'GET', origin: 'https://fixture.test', path: '/item.css', resourceType: 'stylesheet', status: 200, isMainFrame: true, count: 3,
        firstRequestId: 'REQ-CSS-0', first: { url: first.url, timing: timing() }, slowest: { url: first.url, timing: timing() },
        firstStartTime: 0, lastStartTime: 2, transfer: { observedCount: 3, totalBytes: 30 }, distinctQueryCount: 3,
      }],
    };
    const raw = rawBrowserEvidence();
    raw.resourceEntries = [0, 1, 2].map((index) => rawResource(`https://fixture.test/item.css?i=${String(index)}`, 'link'));
    // 種類の違う資源（script として始めた）は、まとめた記録の種類（stylesheet）と合わないので、まとめた記録で分けない。
    raw.resourceEntries.push(rawResource('https://fixture.test/item.css?i=9', 'script'));

    const result = await new PerformanceCollector().collect(fakePage(raw), network, { deadlineAtMs: Date.now() + 1_000 });

    expect(result.resources.map(({ requestId, networkResourceType, categoryBasis }) => [requestId, networkResourceType, categoryBasis])).toEqual([
      ['REQ-CSS-0', 'stylesheet', 'NETWORK_EVIDENCE'],
      [null, 'stylesheet', 'NETWORK_EVIDENCE'],
      [null, 'stylesheet', 'NETWORK_EVIDENCE'],
      [null, null, 'INITIATOR_TYPE'],
    ]);
    expect(result.resourceSummaries?.stylesheet.count).toBe(3);
  });

  // 設計者の判断 2026-11-11: URL は切り詰めない（network の記録の URL・Resource Timing・navigation・LCP の URL の全部を残す）。前の上限（2,048 文字）より長い
  // URL も、Resource Timing と network の要求を照らし合わせる。
  it('keeps whole long URLs and correlates a long Resource Timing URL with its network request', async () => {
    const longUrl = `https://fixture.test/${'a'.repeat(5_000)}.js`;
    const longPageUrl = `https://fixture.test/?q=${'p'.repeat(5_000)}`;
    const longImageUrl = `https://fixture.test/${'i'.repeat(5_000)}.png`;
    const request = requestEvidence('REQ-LONG-URL', longUrl, 'script', Object.freeze({
      status: 'OBSERVED',
      values: Object.freeze({ traceparent: '00-trace-long' }),
    }));
    const raw = rawBrowserEvidence();
    raw.resourceEntries = [rawResource(longUrl, 'script')];
    raw.navigationEntries = [{ ...raw.navigationEntries[0], name: longPageUrl }];
    const lcp = raw.webVitals.LCP as { attribution: Record<string, unknown> };
    lcp.attribution = { ...lcp.attribution, url: longImageUrl };

    const result = await new PerformanceCollector().collect(fakePage(raw), networkWithRequests([request]), { deadlineAtMs: Date.now() + 1_000 });

    expect(result.status).toBe('COMPLETE');
    expect(result.resources[0]).toMatchObject({ url: longUrl, requestId: 'REQ-LONG-URL', categoryBasis: 'NETWORK_EVIDENCE' });
    expect(result.telemetryHeaders[0]).toMatchObject({ url: longUrl });
    expect(result.telemetryCandidates[0]).toMatchObject({ url: longUrl });
    expect(result.navigationTiming).toMatchObject({ url: longPageUrl });
    expect(requireWebVitals(result).LCP.attribution).toMatchObject({ url: longImageUrl });
    expect(result.truncation?.textTruncated).toBe(false);
  });

  it('LZ-2: keeps long ids, texts and header error text whole, and still reports the browser web-vitals truncation of an older state', async () => {
    const longMethod = 'M'.repeat(513);
    const longId = `REQ-${'i'.repeat(257)}`;
    const longErrorText = 'e'.repeat(2_049);
    const request = { ...requestEvidence(longId, 'https://fixture.test/app.js', 'script', { status: 'FAILED', errorText: longErrorText }), method: longMethod };
    const fromNetwork = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkWithRequests([request]),
      { deadlineAtMs: Date.now() + 1_000 },
    );
    expect(fromNetwork.truncation?.textTruncated).toBe(false);
    expect(fromNetwork.telemetryHeaders[0]).toMatchObject({ requestId: longId, status: 'FAILED', errorText: longErrorText });

    const raw = rawBrowserEvidence();
    raw.webVitalsTextTruncated = true;
    const fromBrowser = await new PerformanceCollector().collect(
      fakePage(raw),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );
    expect(fromBrowser.status).toBe('COMPLETE');
    expect(fromBrowser.truncation?.textTruncated).toBe(true);
  });
});
