import type { Frame, Page, Request, Response } from 'playwright';
import { safeErrorMessage } from '../core/errors.js';
import type {
  HeaderEvidence,
  NetworkEvidence,
  NetworkFailureEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
  NetworkTimingEvidence,
  RequestOriginFlags,
  ResponseTransferSizeEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createRequestId } from '../core/ids.js';
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  MAX_HTTP_METHOD_LENGTH,
  MAX_NETWORK_REQUESTS,
  MAX_URL_LENGTH,
} from '../core/limits.js';
import { truncateText } from '../core/text.js';
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

interface HeaderObservation {
  readonly evidence: HeaderEvidence;
  readonly truncated: boolean;
}

interface MutableNetworkRequestEvidence extends RequestOriginFlags {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: Promise<HeaderObservation>;
  timing: NetworkTimingEvidence;
  readonly redirectFromRequestId: string | null;
  redirectToRequestId: string | null;
  readonly redirectChainRequestIds: readonly string[];
  readonly truncated: boolean;
  transferSize: Promise<ResponseTransferSizeEvidence> | null;
}

interface MutableNetworkResponseEvidence extends RequestOriginFlags {
  readonly request: MutableNetworkRequestEvidence;
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Promise<HeaderObservation>;
  timing: NetworkTimingEvidence;
  readonly truncated: boolean;
}

const TRANSFER_SIZE_NOT_OBSERVED: ResponseTransferSizeEvidence = Object.freeze({ status: 'NOT_OBSERVED' });
const INVALID_TRANSFER_SIZE_TEXT = 'Response transfer size is not a non-negative safe integer';

function copyTiming(timing: ReturnType<Request['timing']>): NetworkTimingEvidence {
  return Object.freeze({ ...timing });
}

function selectedHeaders(
  headers: Record<string, string>,
  selectedNames: ReadonlySet<string>,
): HeaderObservation {
  const selected = Object.fromEntries(Object.entries(headers).filter(([name]) => (
    selectedNames.has(name.toLowerCase())
  )));
  let truncated = false;
  const bounded = Object.fromEntries(Object.entries(redactHeaders(selected)).map(([name, value]) => {
    const boundedValue = truncateText(value, MAX_HEADER_VALUE_LENGTH);
    truncated ||= boundedValue.truncated;
    return [name, boundedValue.text];
  }));
  return Object.freeze({
    evidence: Object.freeze({ status: 'OBSERVED', values: Object.freeze(bounded) }),
    truncated,
  });
}

function failedHeaders(error: unknown): HeaderObservation {
  return Object.freeze({
    evidence: Object.freeze({ status: 'FAILED', errorText: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) }),
    truncated: false,
  });
}

function startHeaderObservation(
  readAllHeaders: () => Promise<Record<string, string>>,
  selectedNames: ReadonlySet<string>,
): Promise<HeaderObservation> {
  let allHeaders: Promise<Record<string, string>>;
  try {
    allHeaders = readAllHeaders();
  } catch (error) {
    return Promise.resolve(failedHeaders(error));
  }
  return allHeaders.then((headers) => selectedHeaders(headers, selectedNames), failedHeaders);
}

function failedTransferSize(error: unknown): ResponseTransferSizeEvidence {
  return Object.freeze({ status: 'FAILED', errorText: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) });
}

function transferSizeFrom(sizes: unknown): ResponseTransferSizeEvidence {
  const headersBytes = typeof sizes === 'object' && sizes !== null
    ? Reflect.get(sizes, 'responseHeadersSize') as unknown
    : undefined;
  const bodyBytes = typeof sizes === 'object' && sizes !== null
    ? Reflect.get(sizes, 'responseBodySize') as unknown
    : undefined;
  if (!isNonNegativeSafeInteger(headersBytes) || !isNonNegativeSafeInteger(bodyBytes)) {
    return failedTransferSize(INVALID_TRANSFER_SIZE_TEXT);
  }
  const totalBytes = headersBytes + bodyBytes;
  return isNonNegativeSafeInteger(totalBytes)
    ? Object.freeze({ status: 'OBSERVED', headersBytes, bodyBytes, totalBytes })
    : failedTransferSize(INVALID_TRANSFER_SIZE_TEXT);
}

/** 完了したリクエストの転送量を読む。読み取りの失敗は `FAILED` として記録し、例外を投げない。 */
function startTransferSizeObservation(request: Request): Promise<ResponseTransferSizeEvidence> {
  let sizes: Promise<unknown>;
  try {
    sizes = request.sizes();
  } catch (error) {
    return Promise.resolve(failedTransferSize(error));
  }
  return sizes.then(transferSizeFrom, failedTransferSize);
}

function copyHeaders(headers: HeaderEvidence): HeaderEvidence {
  return headers.status === 'OBSERVED'
    ? Object.freeze({ status: 'OBSERVED', values: Object.freeze({ ...headers.values }) })
    : Object.freeze({ status: 'FAILED', errorText: headers.errorText });
}

function copyTransferSize(transferSize: ResponseTransferSizeEvidence): ResponseTransferSizeEvidence {
  return Object.freeze({ ...transferSize });
}

interface RequestSnapshotSeed extends Omit<NetworkRequestEvidence, 'headers'> {
  readonly headers: Promise<HeaderObservation>;
}

interface ResponseSnapshotSeed extends Omit<NetworkResponseEvidence, 'headers' | 'contentLengthHeader' | 'transferSize'> {
  readonly headers: Promise<HeaderObservation>;
  readonly transferSize: Promise<ResponseTransferSizeEvidence> | null;
}

function captureRequest(request: MutableNetworkRequestEvidence): RequestSnapshotSeed {
  return {
    requestId: request.requestId,
    url: request.url,
    method: request.method,
    resourceType: request.resourceType,
    headers: request.headers,
    timing: Object.freeze({ ...request.timing }),
    redirectFromRequestId: request.redirectFromRequestId,
    redirectToRequestId: request.redirectToRequestId,
    redirectChainRequestIds: Object.freeze([...request.redirectChainRequestIds]),
    isNavigationRequest: request.isNavigationRequest,
    isMainFrame: request.isMainFrame,
    truncated: request.truncated,
  };
}

async function materializeRequest(request: RequestSnapshotSeed): Promise<NetworkRequestEvidence> {
  const headers = await request.headers;
  return Object.freeze({
    ...request,
    headers: copyHeaders(headers.evidence),
    timing: Object.freeze({ ...request.timing }),
    redirectChainRequestIds: Object.freeze([...request.redirectChainRequestIds]),
    truncated: request.truncated || headers.truncated,
  });
}

function captureResponse(response: MutableNetworkResponseEvidence): ResponseSnapshotSeed {
  return {
    requestId: response.requestId,
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    timing: Object.freeze({ ...response.timing }),
    isNavigationRequest: response.isNavigationRequest,
    isMainFrame: response.isMainFrame,
    transferSize: response.request.transferSize,
    truncated: response.truncated,
  };
}

async function materializeResponse(response: ResponseSnapshotSeed): Promise<NetworkResponseEvidence> {
  const [observation, transferSize] = await Promise.all([
    response.headers,
    response.transferSize ?? TRANSFER_SIZE_NOT_OBSERVED,
  ]);
  const headers = copyHeaders(observation.evidence);
  const contentLengthHeader = headers.status === 'OBSERVED'
    ? Object.entries(headers.values).find(([name]) => name.toLowerCase() === 'content-length')?.[1] ?? null
    : null;
  return Object.freeze({
    ...response,
    headers,
    contentLengthHeader,
    timing: Object.freeze({ ...response.timing }),
    transferSize: copyTransferSize(transferSize),
    truncated: response.truncated || observation.truncated,
  });
}

function copyFailure(failure: NetworkFailureEvidence): NetworkFailureEvidence {
  return Object.freeze({ ...failure, timing: Object.freeze({ ...failure.timing }) });
}

/** リクエストのフレームがメインフレームか。フレームを得られない場合（Service Worker のリクエストなど）は `null`。 */
function isMainFrameRequest(page: Page, request: Request): boolean | null {
  let frame: Frame;
  let mainFrame: Frame;
  try {
    frame = request.frame();
    mainFrame = page.mainFrame();
  } catch {
    return null;
  }
  return frame === mainFrame;
}

export class NetworkCollector {
  static attach(page: Page): CollectorHandle<NetworkEvidence> {
    let nextRequestSequence = 1;
    const requestIds = new WeakMap<Request, string>();
    const requestRecords = new WeakMap<Request, MutableNetworkRequestEvidence>();
    const omittedRequests = new WeakSet<Request>();
    const requests: MutableNetworkRequestEvidence[] = [];
    const responses: MutableNetworkResponseEvidence[] = [];
    const failures: NetworkFailureEvidence[] = [];
    let omittedRequestCount = 0;
    let omittedResponseCount = 0;
    let omittedFailureCount = 0;

    // 件数の上限を超えたリクエストは記録せず、件数だけを数えて `null` を返す。
    const ensureRequest = (request: Request): MutableNetworkRequestEvidence | null => {
      const existing = requestRecords.get(request);
      if (existing !== undefined) {
        return existing;
      }
      if (omittedRequests.has(request)) {
        return null;
      }

      const redirectedFrom = request.redirectedFrom();
      const predecessor = redirectedFrom === null ? null : ensureRequest(redirectedFrom);
      if (requests.length >= MAX_NETWORK_REQUESTS) {
        omittedRequests.add(request);
        omittedRequestCount += 1;
        return null;
      }
      const requestId = createRequestId(nextRequestSequence);
      nextRequestSequence += 1;
      const redirectChainRequestIds = predecessor === null
        ? []
        : [...predecessor.redirectChainRequestIds, predecessor.requestId];
      const url = truncateText(request.url(), MAX_URL_LENGTH);
      const method = truncateText(request.method(), MAX_HTTP_METHOD_LENGTH);
      const record: MutableNetworkRequestEvidence = {
        requestId,
        url: url.text,
        method: method.text,
        resourceType: request.resourceType(),
        headers: startHeaderObservation(() => request.allHeaders(), REQUEST_HEADER_NAMES),
        timing: copyTiming(request.timing()),
        redirectFromRequestId: predecessor?.requestId ?? null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze(redirectChainRequestIds),
        isNavigationRequest: request.isNavigationRequest(),
        isMainFrame: isMainFrameRequest(page, request),
        truncated: url.truncated || method.truncated,
        transferSize: null,
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
      if (requestRecord === null) {
        omittedResponseCount += 1;
        return;
      }
      const url = truncateText(response.url(), MAX_URL_LENGTH);
      responses.push({
        request: requestRecord,
        requestId: requestIds.get(request) ?? requestRecord.requestId,
        url: url.text,
        status: response.status(),
        statusText: response.statusText(),
        headers: startHeaderObservation(() => response.allHeaders(), RESPONSE_HEADER_NAMES),
        timing: copyTiming(request.timing()),
        isNavigationRequest: requestRecord.isNavigationRequest,
        isMainFrame: requestRecord.isMainFrame,
        truncated: url.truncated,
      });
    };
    const onRequestFailed = (request: Request): void => {
      const requestRecord = ensureRequest(request);
      if (requestRecord === null) {
        omittedFailureCount += 1;
        return;
      }
      const url = truncateText(request.url(), MAX_URL_LENGTH);
      const method = truncateText(request.method(), MAX_HTTP_METHOD_LENGTH);
      const errorText = truncateText(request.failure()?.errorText ?? 'UNKNOWN_REQUEST_FAILURE', MAX_ERROR_MESSAGE_LENGTH);
      failures.push(Object.freeze({
        requestId: requestRecord.requestId,
        url: url.text,
        method: method.text,
        resourceType: request.resourceType(),
        errorText: errorText.text,
        timing: copyTiming(request.timing()),
        isNavigationRequest: requestRecord.isNavigationRequest,
        isMainFrame: requestRecord.isMainFrame,
        truncated: url.truncated || method.truncated || errorText.truncated,
      }));
    };
    const onRequestFinished = (request: Request): void => {
      const requestRecord = ensureRequest(request);
      if (requestRecord === null) {
        return;
      }
      const finalTiming = copyTiming(request.timing());
      requestRecord.timing = finalTiming;
      requestRecord.transferSize ??= startTransferSizeObservation(request);
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
        const omitted = {
          omittedRequestCount,
          omittedResponseCount,
          omittedFailureCount,
        };
        const [requestSnapshots, responseSnapshots] = await Promise.all([
          Promise.all(requestBoundary.map(materializeRequest)),
          Promise.all(responseBoundary.map(materializeResponse)),
        ]);
        return Object.freeze({
          requests: Object.freeze(requestSnapshots),
          responses: Object.freeze(responseSnapshots),
          failures: Object.freeze(failureBoundary),
          ...omitted,
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
