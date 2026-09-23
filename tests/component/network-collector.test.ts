import type { Page, Request, Response } from 'playwright';
import { describe, expect, it } from 'vitest';
import { NetworkCollector } from '../../src/evidence/network-collector.js';

type Listener = (...arguments_: readonly unknown[]) => void;

class FakePage {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...arguments_: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

const timing: ReturnType<Request['timing']> = {
  startTime: 10,
  domainLookupStart: 11,
  domainLookupEnd: 12,
  connectStart: 13,
  secureConnectionStart: 14,
  connectEnd: 15,
  requestStart: 16,
  responseStart: 17,
  responseEnd: 18,
};

interface FakeRequestOptions {
  readonly url: string;
  readonly method?: string;
  readonly resourceType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allHeaders?: () => Promise<Record<string, string>>;
  readonly redirectedFrom?: Request | null;
  readonly failure?: string | null;
}

function fakeRequest(options: FakeRequestOptions): Request {
  let redirectedTo: Request | null = null;
  let requestTiming = { ...timing };
  const request = {
    url: () => options.url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'document',
    headers: () => ({ ...options.headers }),
    allHeaders: options.allHeaders ?? (async () => ({ ...options.headers })),
    redirectedFrom: () => options.redirectedFrom ?? null,
    redirectedTo: () => redirectedTo,
    timing: () => ({ ...requestTiming }),
    failure: () => options.failure === undefined || options.failure === null
      ? null
      : { errorText: options.failure },
    __setRedirectedTo: (next: Request) => {
      redirectedTo = next;
    },
    __setTiming: (next: ReturnType<Request['timing']>) => {
      requestTiming = { ...next };
    },
  } as unknown as Request & {
    __setRedirectedTo(next: Request): void;
    __setTiming(next: ReturnType<Request['timing']>): void;
  };
  return request;
}

function setRequestTiming(request: Request, next: ReturnType<Request['timing']>): void {
  (request as Request & {
    __setTiming(value: ReturnType<Request['timing']>): void;
  }).__setTiming(next);
}

function connectRedirect(from: Request, to: Request): void {
  (from as Request & { __setRedirectedTo(next: Request): void }).__setRedirectedTo(to);
}

function fakeResponse(
  request: Request,
  status: number,
  headers: Readonly<Record<string, string>>,
  allHeaders: () => Promise<Record<string, string>> = async () => ({ ...headers }),
): Response {
  return {
    request: () => request,
    url: () => request.url(),
    status: () => status,
    statusText: () => status === 302 ? 'Found' : 'OK',
    headers: () => ({ ...headers }),
    allHeaders,
  } as unknown as Response;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('NetworkCollector', () => {
  it('normalizes requests, redirects, responses, failures, timing, telemetry, and only redacted selected allHeaders', async () => {
    const page = new FakePage();
    const handle = NetworkCollector.attach(page as unknown as Page);
    const redirected = fakeRequest({
      url: 'https://fixture.test/start',
      headers: { accept: 'text/html' },
      allHeaders: async () => ({
        accept: 'text/html',
        authorization: 'Bearer request-secret',
        cookie: 'fixture-session=request-secret',
        traceparent: '00-request-trace',
        tracestate: 'fixture=request',
        'x-request-id': 'request-123',
        'x-correlation-id': 'correlation-123',
        'x-unselected-secret': 'must-not-enter-evidence',
      }),
    });
    const destination = fakeRequest({
      url: 'https://fixture.test/final',
      redirectedFrom: redirected,
      headers: { Accept: 'text/html' },
    });
    connectRedirect(redirected, destination);
    const failed = fakeRequest({
      url: 'https://fixture.test/app.js',
      resourceType: 'script',
      failure: 'net::ERR_CONNECTION_RESET',
    });

    page.emit('request', redirected);
    page.emit('response', fakeResponse(
      redirected,
      302,
      { location: '/final' },
      async () => ({
        location: '/final',
        'set-cookie': 'fixture-session=response-secret',
        traceparent: '00-response-trace',
        tracestate: 'fixture=response',
        'x-request-id': 'response-123',
        'x-correlation-id': 'response-correlation-123',
        'x-unselected-secret': 'must-not-enter-evidence',
      }),
    ));
    page.emit('request', destination);
    page.emit('response', fakeResponse(destination, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': '42',
      'X-Api-Key': 'response-secret',
      'X-Unselected-Secret': 'must-not-enter-evidence',
    }));
    setRequestTiming(destination, { ...timing, responseEnd: 99 });
    page.emit('requestfinished', destination);
    page.emit('request', failed);
    page.emit('requestfailed', failed);

    const evidence = await handle.snapshot();

    expect(evidence.requests).toHaveLength(3);
    expect(evidence.requests[0]).toMatchObject({
      requestId: 'REQ-000001',
      url: 'https://fixture.test/start',
      method: 'GET',
      resourceType: 'document',
      redirectFromRequestId: null,
      redirectToRequestId: 'REQ-000002',
      redirectChainRequestIds: [],
      headers: {
        status: 'OBSERVED',
        values: {
          accept: 'text/html',
          authorization: '[REDACTED]',
          cookie: '[REDACTED]',
          traceparent: '00-request-trace',
          tracestate: 'fixture=request',
          'x-request-id': 'request-123',
          'x-correlation-id': 'correlation-123',
        },
      },
      timing,
    });
    expect(evidence.requests[1]).toMatchObject({
      requestId: 'REQ-000002',
      redirectFromRequestId: 'REQ-000001',
      redirectToRequestId: null,
      redirectChainRequestIds: ['REQ-000001'],
      timing: { ...timing, responseEnd: 99 },
    });
    expect(evidence.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: 'REQ-000001',
        status: 302,
        headers: {
          status: 'OBSERVED',
          values: {
            location: '/final',
            'set-cookie': '[REDACTED]',
            traceparent: '00-response-trace',
            tracestate: 'fixture=response',
            'x-request-id': 'response-123',
            'x-correlation-id': 'response-correlation-123',
          },
        },
      }),
      expect.objectContaining({
        requestId: 'REQ-000002',
        status: 200,
        contentLengthHeader: '42',
        headers: {
          status: 'OBSERVED',
          values: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': '42',
            'X-Api-Key': '[REDACTED]',
          },
        },
        timing: { ...timing, responseEnd: 99 },
      }),
    ]));
    expect(evidence.failures).toEqual([
      expect.objectContaining({
        requestId: 'REQ-000003',
        url: 'https://fixture.test/app.js',
        resourceType: 'script',
        errorText: 'net::ERR_CONNECTION_RESET',
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain('must-not-enter-evidence');
    expect(JSON.stringify(evidence)).not.toContain('request-secret');
    expect(JSON.stringify(evidence)).not.toContain('response-secret');
  });

  it('returns repeatable deeply immutable snapshots detached from internal state', async () => {
    const page = new FakePage();
    const handle = NetworkCollector.attach(page as unknown as Page);
    const request = fakeRequest({
      url: 'https://fixture.test/image.png',
      resourceType: 'image',
      headers: { Accept: 'image/png' },
    });
    page.emit('request', request);
    page.emit('response', fakeResponse(request, 404, {
      'Content-Type': 'image/png',
      'Content-Length': '13',
    }));

    const first = await handle.snapshot();
    const second = await handle.snapshot();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.requests).not.toBe(first.requests);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.requests)).toBe(true);
    expect(Object.isFrozen(first.requests[0])).toBe(true);
    expect(Object.isFrozen(first.requests[0]?.headers)).toBe(true);
    expect(first.requests[0]?.headers.status).toBe('OBSERVED');
    if (first.requests[0]?.headers.status === 'OBSERVED') {
      expect(Object.isFrozen(first.requests[0].headers.values)).toBe(true);
    }
    expect(Object.isFrozen(first.requests[0]?.timing)).toBe(true);
    expect(Object.isFrozen(first.requests[0]?.redirectChainRequestIds)).toBe(true);
    expect(Object.isFrozen(first.responses[0])).toBe(true);
  });

  it('detaches idempotently, ignores late events, and does not disturb another collector', async () => {
    const page = new FakePage();
    const first = NetworkCollector.attach(page as unknown as Page);
    const second = NetworkCollector.attach(page as unknown as Page);
    const beforeDetach = fakeRequest({ url: 'https://fixture.test/before' });
    page.emit('request', beforeDetach);

    first.detach();
    first.detach();
    const afterDetach = fakeRequest({ url: 'https://fixture.test/after' });
    page.emit('request', afterDetach);

    expect((await first.snapshot()).requests.map((request) => request.url)).toEqual([
      'https://fixture.test/before',
    ]);
    expect((await second.snapshot()).requests.map((request) => request.url)).toEqual([
      'https://fixture.test/before',
      'https://fixture.test/after',
    ]);
    expect(page.listenerCount('request')).toBe(1);
    expect(page.listenerCount('response')).toBe(1);
    expect(page.listenerCount('requestfailed')).toBe(1);
    expect(page.listenerCount('requestfinished')).toBe(1);

    second.detach();
    expect(page.listenerCount('request')).toBe(0);
    expect(page.listenerCount('response')).toBe(0);
    expect(page.listenerCount('requestfailed')).toBe(0);
    expect(page.listenerCount('requestfinished')).toBe(0);
  });

  it('awaits the invocation-boundary header reads without reordering, cross-contamination, or post-detach events', async () => {
    const page = new FakePage();
    const firstRequestHeaders = deferred<Record<string, string>>();
    const firstResponseHeaders = deferred<Record<string, string>>();
    const secondRequestHeaders = deferred<Record<string, string>>();
    const secondResponseHeaders = deferred<Record<string, string>>();
    const handle = NetworkCollector.attach(page as unknown as Page);
    const firstRequest = fakeRequest({
      url: 'https://fixture.test/first',
      allHeaders: () => firstRequestHeaders.promise,
    });
    const secondRequest = fakeRequest({
      url: 'https://fixture.test/second',
      allHeaders: () => secondRequestHeaders.promise,
    });

    page.emit('request', firstRequest);
    page.emit('response', fakeResponse(
      firstRequest,
      200,
      {},
      () => firstResponseHeaders.promise,
    ));
    page.emit('request', secondRequest);
    page.emit('response', fakeResponse(
      secondRequest,
      200,
      {},
      () => secondResponseHeaders.promise,
    ));
    const snapshot = Promise.resolve(handle.snapshot());
    let settled = false;
    void snapshot.then(() => {
      settled = true;
    });

    handle.detach();
    page.emit('request', fakeRequest({ url: 'https://fixture.test/late' }));
    secondResponseHeaders.resolve({ 'x-request-id': 'second-response' });
    secondRequestHeaders.resolve({ 'x-request-id': 'second-request' });
    await Promise.resolve();
    expect(settled).toBe(false);
    firstResponseHeaders.resolve({ 'x-request-id': 'first-response' });
    firstRequestHeaders.resolve({ 'x-request-id': 'first-request' });

    const evidence = await snapshot;
    expect(evidence.requests.map((request) => ({
      url: request.url,
      headers: request.headers,
    }))).toEqual([
      {
        url: 'https://fixture.test/first',
        headers: { status: 'OBSERVED', values: { 'x-request-id': 'first-request' } },
      },
      {
        url: 'https://fixture.test/second',
        headers: { status: 'OBSERVED', values: { 'x-request-id': 'second-request' } },
      },
    ]);
    expect(evidence.responses.map((response) => ({
      url: response.url,
      headers: response.headers,
    }))).toEqual([
      {
        url: 'https://fixture.test/first',
        headers: { status: 'OBSERVED', values: { 'x-request-id': 'first-response' } },
      },
      {
        url: 'https://fixture.test/second',
        headers: { status: 'OBSERVED', values: { 'x-request-id': 'second-response' } },
      },
    ]);
    expect(evidence.requests.some((request) => request.url.endsWith('/late'))).toBe(false);
  });

  it('reports request and response allHeaders rejection instead of claiming empty observed headers', async () => {
    const page = new FakePage();
    const handle = NetworkCollector.attach(page as unknown as Page);
    const request = fakeRequest({
      url: 'https://fixture.test/header-failure',
      headers: { accept: 'text/html' },
      allHeaders: async () => {
        throw new Error('request headers unavailable');
      },
    });
    page.emit('request', request);
    page.emit('response', fakeResponse(
      request,
      200,
      { 'content-type': 'text/html' },
      async () => {
        throw new Error('response headers unavailable');
      },
    ));

    const evidence = await handle.snapshot();
    expect(evidence.requests[0]).toMatchObject({
      headers: { status: 'FAILED', errorText: 'request headers unavailable' },
    });
    expect(evidence.responses[0]).toMatchObject({
      headers: { status: 'FAILED', errorText: 'response headers unavailable' },
      contentLengthHeader: null,
    });
    expect(JSON.stringify(evidence)).not.toContain('"status":"OBSERVED","values":{}');
    expect(Object.isFrozen(evidence.requests[0]?.headers)).toBe(true);
    expect(Object.isFrozen(evidence.responses[0]?.headers)).toBe(true);
  });
});
