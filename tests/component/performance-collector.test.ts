import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_RESOURCE_TIMING_ENTRIES } from '../../src/core/limits.js';
import type {
  HeaderEvidence,
  NetworkEvidence,
  NetworkRequestEvidence,
  PerformanceEvidence,
  ResourceSummariesEvidence,
  WebVitalsEvidence,
} from '../../src/core/evidence-types.js';
import { PerformanceCollector } from '../../src/evidence/performance-collector.js';

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
    expect(scripts[0]).toContain('__BEAKSIGHT_PERFORMANCE__');
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

  it('adjudicates late completion and rejection as deadline without mutating returned evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let resolveLate: ((value: unknown) => void) | undefined;
    const lateResolution = new Promise((resolve) => { resolveLate = resolve; });
    const resolvingPage = { evaluate: vi.fn(() => lateResolution) } as unknown as Page;
    const resolvingPromise = new PerformanceCollector().collect(resolvingPage, EMPTY_NETWORK, {
      deadlineAtMs: 10_020,
    });
    await vi.advanceTimersByTimeAsync(20);
    const resolvingResult = await resolvingPromise;
    expect(resolvingResult).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    resolveLate?.(rawBrowserEvidence());
    await Promise.resolve();
    expect(resolvingResult.resources).toEqual([]);

    vi.setSystemTime(20_000);
    let rejectLate: ((reason: unknown) => void) | undefined;
    const lateRejection = new Promise((_resolve, reject) => { rejectLate = reject; });
    const rejectingPage = { evaluate: vi.fn(() => lateRejection) } as unknown as Page;
    const rejectingPromise = new PerformanceCollector().collect(rejectingPage, EMPTY_NETWORK, {
      deadlineAtMs: 20_020,
    });
    await vi.advanceTimersByTimeAsync(20);
    const rejectingResult = await rejectingPromise;
    expect(rejectingResult).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    rejectLate?.(new Error('late rejection'));
    await Promise.resolve();
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

  it('checks an expired deadline before reading any NetworkEvidence field', async () => {
    const network = new Proxy({} as NetworkEvidence, {
      get() {
        throw new Error('NetworkEvidence must not be traversed after entry expiry');
      },
    });
    const page = { evaluate: vi.fn() } as unknown as Page;

    const result = await new PerformanceCollector().collect(page, network, {
      deadlineAtMs: Date.now() - 1,
    });

    expect(result).toMatchObject({
      status: 'PARTIAL',
      reason: 'DEADLINE_EXCEEDED',
      webVitals: null,
      telemetryHeaders: [],
      telemetryCandidates: [],
    });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('does not read responses after the requests getter reaches the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(35_000);
    const deadlineAtMs = 35_050;
    let responseReads = 0;
    const network = Object.defineProperties({}, {
      requests: {
        get() {
          vi.setSystemTime(deadlineAtMs);
          return [];
        },
      },
      responses: {
        get() {
          responseReads += 1;
          return [];
        },
      },
      failures: { value: [] },
    }) as NetworkEvidence;
    const page = { evaluate: vi.fn() } as unknown as Page;

    const result = await new PerformanceCollector().collect(page, network, { deadlineAtMs });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(responseReads).toBe(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('caches caller-owned request and response array lengths during projection', async () => {
    let requestLengthReads = 0;
    let responseLengthReads = 0;
    const requests = new Proxy([
      requestEvidence('REQ-LENGTH', 'https://fixture.test/app.js', 'script'),
    ], {
      get(target, property, receiver) {
        if (property === 'length') requestLengthReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const responses = new Proxy([] as NetworkEvidence['responses'][number][], {
      get(target, property, receiver) {
        if (property === 'length') responseLengthReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkOf(requests, responses),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
    expect(requestLengthReads).toBe(1);
    expect(responseLengthReads).toBe(1);
  });

  it.each(['REQUEST', 'RESPONSE'] as const)(
    'does not read %s scalars after its indexed getter reaches the deadline',
    async (direction) => {
      vi.useFakeTimers();
      vi.setSystemTime(36_000);
      const deadlineAtMs = 36_050;
      const lateReads: string[] = [];
      const baseRequest = requestEvidence('REQ-INDEXED', 'https://fixture.test/app.js', 'script');
      const request = new Proxy(baseRequest, {
        get(target, property, receiver) {
          if (Date.now() >= deadlineAtMs) lateReads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      });
      const baseResponse = networkEvidence().responses[0]!;
      const response = new Proxy(baseResponse, {
        get(target, property, receiver) {
          if (Date.now() >= deadlineAtMs) lateReads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      });
      const requests = direction === 'REQUEST'
        ? new Proxy([request], {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property === '0') vi.setSystemTime(deadlineAtMs);
            return value;
          },
        })
        : [];
      const responses = direction === 'RESPONSE'
        ? new Proxy([response], {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property === '0') vi.setSystemTime(deadlineAtMs);
            return value;
          },
        })
        : [];
      const page = { evaluate: vi.fn() } as unknown as Page;

      const result = await new PerformanceCollector().collect(
        page,
        networkOf(requests, responses),
        { deadlineAtMs },
      );

      expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
      expect(lateReads).toEqual([]);
      expect(page.evaluate).not.toHaveBeenCalled();
    },
  );

  it('does not read FAILED header errorText after status reaches the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(37_000);
    const deadlineAtMs = 37_050;
    const lateReads: string[] = [];
    const headers = Object.defineProperties({}, {
      status: {
        get() {
          vi.setSystemTime(deadlineAtMs);
          return 'FAILED';
        },
      },
      errorText: {
        get() {
          if (Date.now() >= deadlineAtMs) lateReads.push('errorText');
          return 'unavailable';
        },
      },
    }) as HeaderEvidence;
    const request = { ...requestEvidence('REQ-FAILED', 'https://fixture.test/app.js', 'script'), headers };

    const result = await new PerformanceCollector().collect(
      { evaluate: vi.fn() } as unknown as Page,
      networkWithRequests([request]),
      { deadlineAtMs },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(lateReads).toEqual([]);
  });

  it('caches OBSERVED header values and stops after a value getter reaches the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(38_000);
    const deadlineAtMs = 38_050;
    let valuesReads = 0;
    const lateReads: string[] = [];
    const values = Object.defineProperties({}, {
      traceparent: {
        enumerable: true,
        get() {
          vi.setSystemTime(deadlineAtMs);
          return '00-trace';
        },
      },
      'x-request-id': {
        enumerable: true,
        get() {
          if (Date.now() >= deadlineAtMs) lateReads.push('x-request-id');
          return 'late-id';
        },
      },
    });
    const headers = Object.defineProperties({}, {
      status: { get: () => 'OBSERVED' },
      values: {
        get() {
          valuesReads += 1;
          if (Date.now() >= deadlineAtMs) lateReads.push('values');
          return values;
        },
      },
    }) as HeaderEvidence;
    const request = { ...requestEvidence('REQ-VALUES', 'https://fixture.test/app.js', 'script'), headers };

    const result = await new PerformanceCollector().collect(
      { evaluate: vi.fn() } as unknown as Page,
      networkWithRequests([request]),
      { deadlineAtMs },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(valuesReads).toBe(1);
    expect(lateReads).toEqual([]);
  });

  it('gates the ownKeys and own-property descriptor header boundaries separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(39_000);
    const deadlineAtMs = 39_050;
    const lateReads: string[] = [];
    const valuesTarget = { traceparent: '00-trace' };
    const values = new Proxy(valuesTarget, {
      ownKeys(target) {
        vi.setSystemTime(deadlineAtMs);
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        if (Date.now() >= deadlineAtMs) lateReads.push(`descriptor:${String(property)}`);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const request = {
      ...requestEvidence('REQ-OWN-KEYS', 'https://fixture.test/app.js', 'script'),
      headers: { status: 'OBSERVED' as const, values },
    };

    const result = await new PerformanceCollector().collect(
      { evaluate: vi.fn() } as unknown as Page,
      networkWithRequests([request]),
      { deadlineAtMs },
    );

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(lateReads).toEqual([]);
  });

  it('bounds request and response projection before evaluation', async () => {
    const request = requestEvidence('REQ-BOUNDED', 'https://fixture.test/app.js', 'script');
    const response = {
      requestId: request.requestId,
      url: request.url,
      status: 200,
      statusText: 'OK',
      headers: { status: 'OBSERVED' as const, values: {} },
      contentLengthHeader: null,
      timing: timing(),
      ...RESPONSE_FLAGS,
    };
    const requests = new Proxy(Array.from({ length: 501 }, () => request), {
      get(target, property, receiver) {
        if (property === '500') throw new Error('unbounded request traversal');
        return Reflect.get(target, property, receiver);
      },
    });
    const responses = new Proxy(Array.from({ length: 501 }, () => response), {
      get(target, property, receiver) {
        if (property === '500') throw new Error('unbounded response traversal');
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkOf(requests, responses),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.status).toBe('COMPLETE');
  });

  it('stops projection when its deadline is reached and returns no speculative telemetry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const deadlineAtMs = 30_050;
    const traced = requestEvidence(
      'REQ-TRACE',
      'https://fixture.test/analytics/collect',
      'fetch',
      { status: 'OBSERVED', values: { traceparent: '00-before-deadline' } },
    );
    const requests = new Proxy([traced, traced], {
      get(target, property, receiver) {
        if (property === '1') vi.setSystemTime(deadlineAtMs);
        return Reflect.get(target, property, receiver);
      },
    });
    const page = { evaluate: vi.fn() } as unknown as Page;

    const result = await new PerformanceCollector().collect(
      page,
      networkOf(requests),
      { deadlineAtMs },
    );

    expect(result).toMatchObject({
      status: 'PARTIAL',
      reason: 'DEADLINE_EXCEEDED',
      webVitals: null,
      telemetryHeaders: [],
      telemetryCandidates: [],
    });
    expect(page.evaluate).not.toHaveBeenCalled();
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

  it('bounds projected scalar retention and excludes overlong URLs from exact correlation', async () => {
    const overlongUrl = `https://fixture.test/analytics/${'a'.repeat(2_100)}`;
    const raw = rawBrowserEvidence();
    raw.resourceEntries.splice(0, raw.resourceEntries.length, rawResource(overlongUrl, 'link'));
    const request = {
      ...requestEvidence(
        'R'.repeat(300),
        overlongUrl,
        'resource-type-'.repeat(60),
        { status: 'OBSERVED', values: { traceparent: 'v'.repeat(700) } },
      ),
      method: 'M'.repeat(700),
    };

    const result = await new PerformanceCollector().collect(
      fakePage(raw),
      networkWithRequests([request]),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.resources[0]).toMatchObject({ requestId: null, networkResourceType: null });
    expect(result.telemetryCandidates[0]?.requestId.length).toBeLessThanOrEqual(256);
    expect(result.telemetryCandidates[0]?.url.length).toBeLessThanOrEqual(2_048);
    expect(result.telemetryCandidates[0]?.method.length).toBeLessThanOrEqual(512);
    expect(result.telemetryCandidates[0]?.resourceType.length).toBeLessThanOrEqual(512);
    const observedHeader = result.telemetryHeaders.find((header) => header.status === 'OBSERVED');
    expect(observedHeader?.status === 'OBSERVED' ? observedHeader.values.traceparent?.length : 0)
      .toBeLessThanOrEqual(512);
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

    const oversized = rawBrowserEvidence();
    oversized.resourceEntries.splice(0, oversized.resourceEntries.length, ...Array.from(
      { length: MAX_RESOURCE_TIMING_ENTRIES + 3 },
      (_value, index) => rawResource(`https://fixture.test/item-${index}.js`, 'script'),
    ));
    const bounded = await new PerformanceCollector().collect(
      fakePage(oversized),
      EMPTY_NETWORK,
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(bounded).toMatchObject({ status: 'PARTIAL', reason: 'RESOURCE_LIMIT_REACHED' });
    expect(bounded.resources).toHaveLength(MAX_RESOURCE_TIMING_ENTRIES);
    expect(bounded.resourceCoverage).toMatchObject({
      retainedEntryCount: MAX_RESOURCE_TIMING_ENTRIES,
      omittedEntryCount: 3,
    });
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

  it('records Server-Timing entries omitted by the per-entry and total limits', async () => {
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

    expect(result.serverTiming).toHaveLength(500);
    expect(result.truncation?.omittedServerTimingCount).toBe(26 + 20);
  });

  it('records telemetry headers, telemetry candidates, and projected network records omitted by limits', async () => {
    const requests = Array.from({ length: 505 }, (_value, index) => requestEvidence(
      `REQ-${index}`,
      `https://fixture.test/analytics/${index}`,
      'fetch',
      { status: 'OBSERVED', values: { traceparent: `00-${index}` } },
    ));
    const responses = Array.from({ length: 205 }, (_value, index) => ({
      requestId: `REQ-${index}`,
      url: `https://fixture.test/analytics/${index}`,
      status: 204,
      statusText: 'No Content',
      headers: { status: 'OBSERVED' as const, values: {} },
      contentLengthHeader: null,
      timing: timing(),
      ...RESPONSE_FLAGS,
    }));

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkOf(requests, responses),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.telemetryHeaders).toHaveLength(200);
    expect(result.telemetryCandidates).toHaveLength(100);
    expect(result.truncation).toMatchObject({
      omittedNetworkRequestCount: 5,
      omittedNetworkResponseCount: 5,
      omittedTelemetryHeaderCount: 300,
      omittedTelemetryCandidateCount: 400,
    });
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

  it('marks truncated text from projected network scalars and from browser web-vitals state', async () => {
    const request = { ...requestEvidence('REQ-LONG-METHOD', 'https://fixture.test/app.js', 'script'), method: 'M'.repeat(700) };
    const fromNetwork = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkWithRequests([request]),
      { deadlineAtMs: Date.now() + 1_000 },
    );
    expect(fromNetwork.truncation?.textTruncated).toBe(true);

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

  it('bounds FAILED telemetry header error text by the shared error message limit', async () => {
    const request = requestEvidence(
      'REQ-HEADER-FAILURE',
      'https://fixture.test/app.js',
      'script',
      { status: 'FAILED', errorText: 'e'.repeat(MAX_ERROR_MESSAGE_LENGTH + 10) },
    );

    const result = await new PerformanceCollector().collect(
      fakePage(rawBrowserEvidence()),
      networkWithRequests([request]),
      { deadlineAtMs: Date.now() + 1_000 },
    );

    expect(result.telemetryHeaders[0]).toEqual({
      direction: 'REQUEST',
      requestId: 'REQ-HEADER-FAILURE',
      url: 'https://fixture.test/app.js',
      status: 'FAILED',
      errorText: 'e'.repeat(MAX_ERROR_MESSAGE_LENGTH),
    });
    expect(result.truncation?.textTruncated).toBe(true);
  });
});
