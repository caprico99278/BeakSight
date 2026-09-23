import type { Page, Request, Response } from 'playwright';
import { redactHeaders } from '../safety/redact.js';
import { createCollectorHandle, type CollectorHandle } from './collector-handle.js';

const REQUEST_HEADER_NAMES = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'range',
  'referer',
  'request-id',
  'correlation-id',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-api-key',
  'x-auth-token',
  'x-correlation-id',
  'x-request-id',
  'x-session-id',
]);

const RESPONSE_HEADER_NAMES = new Set([
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'location',
  'request-id',
  'correlation-id',
  'server',
  'server-timing',
  'set-cookie',
  'traceparent',
  'tracestate',
  'vary',
  'x-api-key',
  'x-auth-token',
  'x-correlation-id',
  'x-request-id',
  'x-session-id',
]);

export type HeaderEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly values: Readonly<Record<string, string>>;
    }
  | {
      readonly status: 'FAILED';
      readonly errorText: string;
    };

export interface NetworkRequestEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: HeaderEvidence;
  readonly timing: NetworkTimingEvidence;
  readonly redirectFromRequestId: string | null;
  readonly redirectToRequestId: string | null;
  readonly redirectChainRequestIds: readonly string[];
}

export interface NetworkResponseEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderEvidence;
  readonly contentLengthHeader: string | null;
  readonly timing: NetworkTimingEvidence;
}

export interface NetworkFailureEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly errorText: string;
  readonly timing: NetworkTimingEvidence;
}

export interface NetworkEvidence {
  readonly requests: readonly NetworkRequestEvidence[];
  readonly responses: readonly NetworkResponseEvidence[];
  readonly failures: readonly NetworkFailureEvidence[];
}

interface MutableNetworkRequestEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: Promise<HeaderEvidence>;
  timing: NetworkTimingEvidence;
  readonly redirectFromRequestId: string | null;
  redirectToRequestId: string | null;
  readonly redirectChainRequestIds: readonly string[];
}

interface MutableNetworkResponseEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Promise<HeaderEvidence>;
  timing: NetworkTimingEvidence;
}

function formatRequestId(sequence: number): string {
  return `REQ-${String(sequence).padStart(6, '0')}`;
}

type NetworkTimingEvidence = Readonly<ReturnType<Request['timing']>>;

function copyTiming(timing: ReturnType<Request['timing']>): NetworkTimingEvidence {
  return Object.freeze({ ...timing });
}

function selectedHeaders(
  headers: Record<string, string>,
  selectedNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const selected = Object.fromEntries(Object.entries(headers).filter(([name]) => (
    selectedNames.has(name.toLowerCase())
  )));
  return Object.freeze(redactHeaders(selected));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedHeaders(error: unknown): HeaderEvidence {
  return Object.freeze({ status: 'FAILED', errorText: errorMessage(error) });
}

function startHeaderObservation(
  readAllHeaders: () => Promise<Record<string, string>>,
  selectedNames: ReadonlySet<string>,
): Promise<HeaderEvidence> {
  let allHeaders: Promise<Record<string, string>>;
  try {
    allHeaders = readAllHeaders();
  } catch (error) {
    return Promise.resolve(failedHeaders(error));
  }
  return allHeaders.then(
    (headers) => Object.freeze({
      status: 'OBSERVED' as const,
      values: selectedHeaders(headers, selectedNames),
    }),
    failedHeaders,
  );
}

function copyHeaders(headers: HeaderEvidence): HeaderEvidence {
  return headers.status === 'OBSERVED'
    ? Object.freeze({ status: 'OBSERVED', values: Object.freeze({ ...headers.values }) })
    : Object.freeze({ status: 'FAILED', errorText: headers.errorText });
}

interface RequestSnapshotSeed extends Omit<NetworkRequestEvidence, 'headers'> {
  readonly headers: Promise<HeaderEvidence>;
}

interface ResponseSnapshotSeed extends Omit<NetworkResponseEvidence, 'headers' | 'contentLengthHeader'> {
  readonly headers: Promise<HeaderEvidence>;
}

function captureRequest(request: MutableNetworkRequestEvidence): RequestSnapshotSeed {
  return {
    ...request,
    timing: Object.freeze({ ...request.timing }),
    redirectChainRequestIds: Object.freeze([...request.redirectChainRequestIds]),
  };
}

async function materializeRequest(request: RequestSnapshotSeed): Promise<NetworkRequestEvidence> {
  return Object.freeze({
    ...request,
    headers: copyHeaders(await request.headers),
    timing: Object.freeze({ ...request.timing }),
    redirectChainRequestIds: Object.freeze([...request.redirectChainRequestIds]),
  });
}

function captureResponse(response: MutableNetworkResponseEvidence): ResponseSnapshotSeed {
  return { ...response, timing: Object.freeze({ ...response.timing }) };
}

async function materializeResponse(response: ResponseSnapshotSeed): Promise<NetworkResponseEvidence> {
  const headers = copyHeaders(await response.headers);
  const contentLengthHeader = headers.status === 'OBSERVED'
    ? Object.entries(headers.values).find(([name]) => name.toLowerCase() === 'content-length')?.[1] ?? null
    : null;
  return Object.freeze({
    ...response,
    headers,
    contentLengthHeader,
    timing: Object.freeze({ ...response.timing }),
  });
}

function copyFailure(failure: NetworkFailureEvidence): NetworkFailureEvidence {
  return Object.freeze({ ...failure, timing: Object.freeze({ ...failure.timing }) });
}

export class NetworkCollector {
  static attach(page: Page): CollectorHandle<NetworkEvidence> {
    let nextRequestSequence = 1;
    const requestIds = new WeakMap<Request, string>();
    const requestRecords = new WeakMap<Request, MutableNetworkRequestEvidence>();
    const requests: MutableNetworkRequestEvidence[] = [];
    const responses: MutableNetworkResponseEvidence[] = [];
    const failures: NetworkFailureEvidence[] = [];

    const ensureRequest = (request: Request): MutableNetworkRequestEvidence => {
      const existing = requestRecords.get(request);
      if (existing !== undefined) {
        return existing;
      }

      const redirectedFrom = request.redirectedFrom();
      const predecessor = redirectedFrom === null ? null : ensureRequest(redirectedFrom);
      const requestId = formatRequestId(nextRequestSequence);
      nextRequestSequence += 1;
      const redirectChainRequestIds = predecessor === null
        ? []
        : [...predecessor.redirectChainRequestIds, predecessor.requestId];
      const record: MutableNetworkRequestEvidence = {
        requestId,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: startHeaderObservation(() => request.allHeaders(), REQUEST_HEADER_NAMES),
        timing: copyTiming(request.timing()),
        redirectFromRequestId: predecessor?.requestId ?? null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze(redirectChainRequestIds),
      };
      requestIds.set(request, requestId);
      requestRecords.set(request, record);
      requests.push(record);
      if (predecessor !== null) {
        predecessor.redirectToRequestId = requestId;
      }
      return record;
    };

    const onRequest = (request: Request): void => {
      ensureRequest(request);
    };
    const onResponse = (response: Response): void => {
      const request = response.request();
      const requestRecord = ensureRequest(request);
      responses.push({
        requestId: requestIds.get(request) ?? requestRecord.requestId,
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers: startHeaderObservation(() => response.allHeaders(), RESPONSE_HEADER_NAMES),
        timing: copyTiming(request.timing()),
      });
    };
    const onRequestFailed = (request: Request): void => {
      const requestRecord = ensureRequest(request);
      failures.push(Object.freeze({
        requestId: requestRecord.requestId,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText ?? 'UNKNOWN_REQUEST_FAILURE',
        timing: copyTiming(request.timing()),
      }));
    };
    const onRequestFinished = (request: Request): void => {
      const requestRecord = ensureRequest(request);
      const finalTiming = copyTiming(request.timing());
      requestRecord.timing = finalTiming;
      for (const response of responses) {
        if (response.requestId === requestRecord.requestId) {
          response.timing = finalTiming;
        }
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    page.on('requestfinished', onRequestFinished);

    return createCollectorHandle(
      async () => {
        const requestBoundary = requests.map(captureRequest);
        const responseBoundary = responses.map(captureResponse);
        const failureBoundary = failures.map(copyFailure);
        const [requestSnapshots, responseSnapshots] = await Promise.all([
          Promise.all(requestBoundary.map(materializeRequest)),
          Promise.all(responseBoundary.map(materializeResponse)),
        ]);
        return Object.freeze({
          requests: Object.freeze(requestSnapshots),
          responses: Object.freeze(responseSnapshots),
          failures: Object.freeze(failureBoundary),
        });
      },
      () => {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        page.off('requestfinished', onRequestFinished);
      },
    );
  }
}
