import type { Frame, Page, Request, Response } from 'playwright';
import { isBlockedByClientFailure } from '../core/blocked-by-client-failures.js';
import { safeErrorMessage } from '../core/errors.js';
import type {
  BlockedEventPhase,
  HeaderEvidence,
  NetworkEvidence,
  NetworkFailureEvidence,
  NetworkRepeatedReadEvidence,
  NetworkRepeatedReadSampleEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
  NetworkTimingEvidence,
  RequestOriginFlags,
  ResponseBodySummaryEvidence,
  ResponseErrorContextEvidence,
  ResponseTransferSizeEvidence,
} from '../core/evidence-types.js';
import { summarizeErrorResponseBody, unreadableErrorResponseBody } from './response-error-summary.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { ERROR_HTTP_STATUS_RANGE, isHttpStatusInRange } from '../core/http-status.js';
import { requestEndpointKeyOf } from '../core/request-endpoint-key.js';
import { createRequestId, sha256HexOfText } from '../core/ids.js';
import { redactHeaders } from '../safety/redact.js';
import { createCollectorHandle, type CollectorHandle } from './collector-handle.js';
import { watchCollection, type CollectorWatchOptions } from '../browser/collector-watch.js';

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
  /** ヘッダの読み取り（まだ始めていなければ `null`。`readHeaders` で始める）。 */
  headers: Promise<HeaderObservation> | null;
  /** 設計者の判断 2026-11-11 の C: まだ始めていないヘッダの読み取り（始めたら、またはまとめて捨てたら `null`）。 */
  readHeaders: (() => Promise<Record<string, string>>) | null;
  timing: NetworkTimingEvidence;
  readonly redirectFromRequestId: string | null;
  redirectToRequestId: string | null;
  readonly redirectChainRequestIds: readonly string[];
  readonly truncated: boolean;
  transferSize: Promise<ResponseTransferSizeEvidence> | null;
  /**
   * DEF-245 の続き: 要求が終わったか（`requestfinished`・`requestfailed` を受けた）。ページが本文を読まない要求には、Chromium が終わりの事象を出さず、
   * 本文の読み取りも返らないので、写しは、終わっていない要求の本文を待たない。
   */
  ended: boolean;
}

interface MutableNetworkResponseEvidence extends RequestOriginFlags {
  readonly request: MutableNetworkRequestEvidence;
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  /** ヘッダの読み取り（まだ始めていなければ `null`。`readHeaders` で始める）。 */
  headers: Promise<HeaderObservation> | null;
  /** 設計者の判断 2026-11-11 の C: まだ始めていないヘッダの読み取り（始めたら、またはまとめて捨てたら `null`）。 */
  readHeaders: (() => Promise<Record<string, string>>) | null;
  timing: NetworkTimingEvidence;
  readonly truncated: boolean;
  /** AUD-7: 4xx・5xx の応答の文脈の読み取り（ほかの応答は `null`）。 */
  readonly errorContext: Promise<ResponseErrorContextEvidence> | null;
  /** DEF-245 の続き: 要求が終わらないまま写すときの、応答の文脈（本文は読めなかった。4xx・5xx の応答だけ。ほかは `null`）。 */
  readonly errorContextIfNotEnded: ResponseErrorContextEvidence | null;
}

/** AUD-7: 応答の文脈を読む（本文は Playwright がもう受け取ったものを読む。要求は増やさない）。読み取りの失敗は要旨なしの理由にし、例外を投げない。 */
function startErrorContextObservation(response: Response, approvedService: boolean): Promise<ResponseErrorContextEvidence> {
  const contextOf = (bodySummary: ResponseBodySummaryEvidence): ResponseErrorContextEvidence => Object.freeze({ bodySummary, approvedService });
  let contentType: string | null;
  let body: Promise<Buffer>;
  try {
    contentType = response.headers()['content-type'] ?? null;
    body = response.body();
  } catch (error) {
    return Promise.resolve(contextOf(unreadableErrorResponseBody(error)));
  }
  return body.then(
    (bytes) => contextOf(summarizeErrorResponseBody(bytes, contentType)),
    (error: unknown) => contextOf(unreadableErrorResponseBody(error)),
  );
}

/** AUD-7: URL の Origin が、承認したサービスの Origin の一覧にあるか（解析できない URL は、ない）。 */
const isApprovedServiceUrl = (url: string, origins: ReadonlySet<string>): boolean => {
  if (origins.size === 0) {
    return false;
  }
  try {
    return origins.has(new URL(url).origin);
  } catch {
    return false;
  }
};

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
  // LZ-2: 値の長さの上限（前は `MAX_HEADER_VALUE_LENGTH`）は置かない。伏せた値を切り詰めずに残す。
  return Object.freeze({
    evidence: Object.freeze({ status: 'OBSERVED', values: Object.freeze(redactHeaders(selected)) }),
    truncated: false,
  });
}

function failedHeaders(error: unknown): HeaderObservation {
  return Object.freeze({
    evidence: Object.freeze({ status: 'FAILED', errorText: safeErrorMessage(error) }),
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
  return Object.freeze({ status: 'FAILED', errorText: safeErrorMessage(error) });
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

interface ResponseSnapshotSeed extends Omit<NetworkResponseEvidence, 'headers' | 'contentLengthHeader' | 'transferSize' | 'errorContext'> {
  readonly headers: Promise<HeaderObservation>;
  readonly transferSize: Promise<ResponseTransferSizeEvidence> | null;
  readonly errorContext: Promise<ResponseErrorContextEvidence> | null;
}

/** ヘッダを読む口を持たないまま読もうとした記録の、ヘッダの値（ふつうは起きない。まとめて捨てた記録は写さない）。 */
const HEADERS_NOT_READ_TEXT = 'The headers were not read before the request record was kept';

/**
 * 設計者の判断 2026-11-11 の C: 記録のヘッダの読み取りを、まだなら始めて返す（要求が終わった後と、写しのときに呼ぶ。始めた後は、読む口を持たない）。
 */
function startedHeaders(
  record: { headers: Promise<HeaderObservation> | null; readHeaders: (() => Promise<Record<string, string>>) | null },
  selectedNames: ReadonlySet<string>,
): Promise<HeaderObservation> {
  if (record.headers === null) {
    const read = record.readHeaders;
    record.readHeaders = null;
    record.headers = read === null ? Promise.resolve(failedHeaders(new Error(HEADERS_NOT_READ_TEXT))) : startHeaderObservation(read, selectedNames);
  }
  return record.headers;
}

function captureRequest(request: MutableNetworkRequestEvidence): RequestSnapshotSeed {
  return {
    requestId: request.requestId,
    url: request.url,
    method: request.method,
    resourceType: request.resourceType,
    headers: startedHeaders(request, REQUEST_HEADER_NAMES),
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
    headers: startedHeaders(response, RESPONSE_HEADER_NAMES),
    timing: Object.freeze({ ...response.timing }),
    isNavigationRequest: response.isNavigationRequest,
    isMainFrame: response.isMainFrame,
    transferSize: response.request.transferSize,
    truncated: response.truncated,
    // DEF-245 の続き: 要求が終わっていなければ、本文の読み取りを待たない（もう読めていれば、その値。`Promise.race` は、先に決まっていた方を取る）。
    errorContext: response.errorContext === null || response.request.ended || response.errorContextIfNotEnded === null
      ? response.errorContext
      : Promise.race([response.errorContext, Promise.resolve(response.errorContextIfNotEnded)]),
  };
}

async function materializeResponse(response: ResponseSnapshotSeed): Promise<NetworkResponseEvidence> {
  const [observation, transferSize, errorContext] = await Promise.all([
    response.headers,
    response.transferSize ?? TRANSFER_SIZE_NOT_OBSERVED,
    response.errorContext,
  ]);
  const headers = copyHeaders(observation.evidence);
  const contentLengthHeader = headers.status === 'OBSERVED'
    ? Object.entries(headers.values).find(([name]) => name.toLowerCase() === 'content-length')?.[1] ?? null
    : null;
  const { errorContext: _pending, ...rest } = response;
  return Object.freeze({
    ...rest,
    headers,
    contentLengthHeader,
    timing: Object.freeze({ ...response.timing }),
    transferSize: copyTransferSize(transferSize),
    truncated: response.truncated || observation.truncated,
    // AUD-7: 誤りの応答だけが持つ（ほかの応答の形は変えない）。
    ...(errorContext === null ? {} : { errorContext }),
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

/**
 * BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 3）: `NetworkCollector.attach` の省略できる指定。
 * - `phaseOf`: 失敗を記録する時点の印を読む口（呼び出し側が、Guard の時点の決め方 `pageEventPhaseOf` を渡す）。省略は `LOAD`（Guard のない page）。口の例外も `LOAD`。
 */
export interface NetworkCollectorOptions {
  readonly phaseOf?: (() => BlockedEventPhase) | undefined;
  /** L2: 写し（`snapshot`）の header と転送量の読み取りを待つ、進みの見張りの指定（テストが反応なしの長さを短くする）。 */
  readonly watch?: CollectorWatchOptions | undefined;
  /** AUD-7: 承認したサービスの Origin（誤りの応答の文脈の `approvedService` に使う）。省略は空。 */
  readonly approvedServiceOrigins?: readonly string[] | undefined;
}

/** L1b: 写し（`snapshot`）の指定。段の見張りの口を渡すと、写しは自分では見張らず、その口だけを使う（`watchCollection`）。 */
export interface NetworkSnapshotOptions {
  readonly watch?: CollectorWatchOptions | undefined;
}

/** network の collector の手綱（写しに、見張りの指定を渡せる）。 */
export interface NetworkCollectorHandle extends CollectorHandle<NetworkEvidence> {
  snapshot(options?: NetworkSnapshotOptions): Promise<NetworkEvidence>;
  /**
   * AUD-2b（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-2b）: データの要求（`fetch`・`xhr`）と、DEF-245 の直しから画面の形を変える部品
   * （画像・フォント・スタイル・スクリプト。`DATA_REQUEST_RESOURCE_TYPES`）の要求の今の数。`inFlight` は始まって、まだ終わらない
   * （`requestfinished`・`requestfailed` の前の）数、`events` は始まり・終わり・失敗の事象の通しの数（増えたら、データの通信が動いた）。落ち着きの判定が読む。
   */
  dataRequestActivity(): DataRequestActivity;
}

/** AUD-2b: データの要求の今の数（`NetworkCollectorHandle.dataRequestActivity`）。 */
export interface DataRequestActivity {
  readonly inFlight: number;
  readonly events: number;
  /**
   * 設計者の判断（2026-11-10）: 口（`requestEndpointKeyOf`。メソッドと Origin と path）ごとの事実。`inFlight` は終わっていない要求の口（要求の順。同じ口の
   * 要求が 2 つあれば 2 つ）、`completed` は応答を返し終えた（`requestfinished` の）口（重なりなし。初めて終えた順）。落ち着きの判定が読む。
   */
  readonly endpoints: DataRequestEndpoints;
}

/** データの要求の口ごとの事実（`DataRequestActivity.endpoints`。形は `page-settling.ts` の `DataEndpointActivity` と同じ）。 */
export interface DataRequestEndpoints {
  readonly inFlight: readonly string[];
  readonly completed: readonly string[];
  /** DEF-245 の C: 要求が失敗で終わった口（重なりなし。1 つもなければ欄を持たない）。 */
  readonly failed?: readonly string[];
}

/**
 * 落ち着きの待ちが口ごとに数える資源の種類（Playwright の `resourceType`。数えるのは `createDataRequestTracker` の 1 か所）。AUD-2b: データの要求（fetch・XHR）。
 * DEF-245 の B・D の直し（設計者の判断 2026-11-11）: 画面の形を変える部品の読み込み（画像・フォント・スタイル・スクリプト）も数える。新しい口の部品が途中なら
 * 待ち（画像が入る前の配置で証拠を取らない）、一度終わった口へのくり返しは待たない（C と同じ決まり。判定は `dataQuietnessOf`）。動画・音声（`media`）は、
 * 流し続ける読み込みで終わらないことがあるので数えない。
 */
const DATA_REQUEST_RESOURCE_TYPES: ReadonlySet<string> = new Set(['fetch', 'xhr', 'image', 'font', 'stylesheet', 'script']);

/** L2: 進みの見張りが終えるまでに、ブラウザが返さなかった header と転送量の読み取りの文。 */
export const NETWORK_READ_UNRETURNED_TEXT = 'The browser did not return this value before the progress watch ended';
const UNRETURNED_HEADERS: HeaderObservation = Object.freeze({
  evidence: Object.freeze({ status: 'FAILED', errorText: NETWORK_READ_UNRETURNED_TEXT }),
  truncated: false,
});
const UNRETURNED_TRANSFER_SIZE: ResponseTransferSizeEvidence = Object.freeze({ status: 'FAILED', errorText: NETWORK_READ_UNRETURNED_TEXT });
/** 本文を読めなかった応答の文脈（`errorText` は読めなかった理由の文）。 */
const UNREADABLE_ERROR_CONTEXT = (approvedService: boolean, errorText: string): ResponseErrorContextEvidence =>
  Object.freeze({ bodySummary: unreadableErrorResponseBody(errorText), approvedService });
const UNRETURNED_ERROR_CONTEXT = (approvedService: boolean): ResponseErrorContextEvidence =>
  UNREADABLE_ERROR_CONTEXT(approvedService, NETWORK_READ_UNRETURNED_TEXT);
/**
 * DEF-245 の続き: 写しの時点で要求が終わっていない（ページが本文を読まない要求で、Chromium が終わりの事象を出さない）ので、本文を待たなかった応答の文。
 */
export const NETWORK_RESPONSE_NOT_ENDED_TEXT = 'The request had not ended when the evidence was taken, so its body was not read';
const NOT_ENDED_BODY_TEXT = NETWORK_RESPONSE_NOT_ENDED_TEXT;

const LOAD_PHASE: BlockedEventPhase = 'LOAD';

/** データの要求の数え方（`NetworkCollector` と `DataActivityCollector` の共通。数えるのは、ここだけ）。 */
interface DataRequestTracker {
  readonly start: (request: Request) => void;
  /**
   * DEF-245 の続き: 応答（ヘッダ）を受けた。その要求を、応答を返し終えたものとして数える（終わりの事象を待たない。ページが本文を読まない要求には、Chromium が
   * `requestfinished`・`requestfailed` を出さない）。
   */
  readonly respond: (response: Response) => void;
  readonly end: (request: Request, finished: boolean) => void;
  readonly activity: () => DataRequestActivity;
}

function createDataRequestTracker(): DataRequestTracker {
  // AUD-2b: 終わっていないデータの要求と、データの要求の事象の通しの数。
  // 設計者の判断（2026-11-10）: 途中の要求の口と、応答を返し終えた口（落ち着きの判定が、口ごとにデータの静まりを見る）。
  const inFlight = new Map<Request, string>();
  const completed = new Set<string>();
  // DEF-245 の C: 要求が失敗で終わった口（落ち着きの判定が、終わった口として扱う。判定は `dataQuietnessOf`）。
  const failed = new Set<string>();
  let events = 0;
  /** 要求の終わり（応答を受けた・終わりの事象を受けた・失敗した）。2 回目からは何もしない（応答の後の `requestfinished` など）。 */
  const end = (request: Request, finished: boolean): void => {
    const endpoint = inFlight.get(request);
    if (endpoint !== undefined) {
      inFlight.delete(request);
      events += 1;
      if (finished) {
        completed.add(endpoint);
      } else {
        failed.add(endpoint);
      }
    }
  };
  return Object.freeze({
    start: (request: Request): void => {
      if (DATA_REQUEST_RESOURCE_TYPES.has(request.resourceType())) {
        inFlight.set(request, requestEndpointKeyOf(request.method(), request.url()));
        events += 1;
      }
    },
    respond: (response: Response): void => end(response.request(), true),
    end: (request: Request, finished: boolean): void => end(request, finished),
    activity: (): DataRequestActivity => Object.freeze({
      inFlight: inFlight.size,
      events,
      endpoints: Object.freeze({
        inFlight: Object.freeze([...inFlight.values()]),
        completed: Object.freeze([...completed]),
        ...(failed.size === 0 ? {} : { failed: Object.freeze([...failed]) }),
      }),
    }),
  });
}

/** 落ち着きの待ちのためだけの口の手綱（要求ごとの記録を持たない）。 */
export interface DataActivityCollectorHandle {
  dataRequestActivity(): DataRequestActivity;
  detach(): void;
}

/**
 * 設計者の判断 2026-11-11: 落ち着きの待ちのためだけに、データの要求の口ごとの事実を数える口（`NetworkCollector.dataRequestActivity` と同じ値）。要求ごとの記録と、
 * ヘッダ・転送量の読み取りをしない（記録を残さない所で、要求の速さに比べてメモリを使わない）。
 */
export class DataActivityCollector {
  static attach(page: Page): DataActivityCollectorHandle {
    const tracker = createDataRequestTracker();
    const onRequest = (request: Request): void => tracker.start(request);
    const onResponse = (response: Response): void => tracker.respond(response);
    const onFinished = (request: Request): void => tracker.end(request, true);
    const onFailed = (request: Request): void => tracker.end(request, false);
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    let attached = true;
    return Object.freeze({
      dataRequestActivity: (): DataRequestActivity => tracker.activity(),
      detach: (): void => {
        if (!attached) return;
        attached = false;
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfinished', onFinished);
        page.off('requestfailed', onFailed);
      },
    });
  }
}

/** 同じ口の成功した読み取りのくり返しとして、まとめてよい method（読み取り）。 */
const REPEATABLE_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** まとめている途中の、同じ口のくり返しの記録（`NetworkRepeatedReadEvidence` の元）。 */
interface RepeatedReadGroup {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly resourceType: string;
  readonly status: number;
  readonly isMainFrame: boolean | null;
  count: number;
  readonly firstRequestId: string;
  readonly first: NetworkRepeatedReadSampleEvidence;
  slowest: NetworkRepeatedReadSampleEvidence;
  readonly firstStartTime: number;
  lastStartTime: number;
  observedTransferCount: number;
  totalTransferBytes: number;
  /** 見た query の digest（`queryDigestOf`。違いの数を数える。値そのものは持たず、記録にも出さない）。 */
  readonly queries: Set<number>;
}

/** `queryDigestOf` の digest に使う、SHA-256 の 16 進の先頭の桁の数（13 桁 = 52 ビット。JavaScript の数で正確に表せる幅の中）。 */
const QUERY_DIGEST_HEX_DIGITS = 13;
const HEX_RADIX = 16;

/**
 * 設計者の判断 2026-11-11 の続き: query の文字列の digest（SHA-256 の上位 52 ビットの数。digest の作り方は `sha256HexOfText` の 1 か所）。違いの数を、
 * 文字列を持たずに数える（1 件あたりを小さくする）。違う文字列が同じ digest になるのは、52 ビットの幅なので、要求の数が数百万でも、ほぼ起きない。
 */
function queryDigestOf(query: string): number {
  return Number.parseInt(sha256HexOfText(query).slice(0, QUERY_DIGEST_HEX_DIGITS), HEX_RADIX);
}

function repeatedReadOfGroup(group: RepeatedReadGroup): NetworkRepeatedReadEvidence {
  return Object.freeze({
    method: group.method,
    origin: group.origin,
    path: group.path,
    resourceType: group.resourceType,
    status: group.status,
    isMainFrame: group.isMainFrame,
    count: group.count,
    firstRequestId: group.firstRequestId,
    first: group.first,
    slowest: group.slowest,
    firstStartTime: group.firstStartTime,
    lastStartTime: group.lastStartTime,
    transfer: Object.freeze({ observedCount: group.observedTransferCount, totalBytes: group.totalTransferBytes }),
    distinctQueryCount: group.queries.size,
  });
}

export class NetworkCollector {
  static attach(page: Page, options: NetworkCollectorOptions = {}): NetworkCollectorHandle {
    const phaseOf = (): BlockedEventPhase => {
      try {
        return options.phaseOf?.() ?? LOAD_PHASE;
      } catch {
        return LOAD_PHASE;
      }
    };
    const approvedServiceOrigins: ReadonlySet<string> = new Set(options.approvedServiceOrigins ?? []);
    let nextRequestSequence = 1;
    const requestIds = new WeakMap<Request, string>();
    const requestRecords = new WeakMap<Request, MutableNetworkRequestEvidence>();
    // 設計者の判断 2026-11-11: 1 件ずつの記録は、要求の ID（と応答の通しの番号）で引ける形で持つ（まとめた要求の記録を、順を崩さずに外すため）。
    const requests = new Map<string, MutableNetworkRequestEvidence>();
    const responses = new Map<number, MutableNetworkResponseEvidence>();
    let nextResponseSequence = 1;
    const failures: NetworkFailureEvidence[] = [];
    // L2: 件数の上限を外したので、終わった要求の response の時刻の書き換えは、要求の ID ごとの一覧で引く（全部の response を毎回なめない）。要求が終わったら
    // 消す（終わった後に引くことはない。設計者の判断 2026-11-11 の C）。
    const responsesByRequestId = new Map<string, number[]>();
    // 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返し（鍵ごと）と、まとめた要求の転送量の読み取りの途中のもの。
    const repeatedReads = new Map<string, RepeatedReadGroup>();
    const pendingRepeatedReadTransfers = new Set<Promise<void>>();
    // L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4、INV-LIMITS の表 A の N9）: 件数の上限（`MAX_NETWORK_REQUESTS`）を置かず、全部の
    // リクエストと、その response・失敗を記録する。省いた数の欄は、形を保つために残し、常に 0。
    const omittedRequestCount = 0;
    const omittedResponseCount = 0;
    const omittedFailureCount = 0;

    const ensureRequest = (request: Request): MutableNetworkRequestEvidence => {
      const existing = requestRecords.get(request);
      if (existing !== undefined) {
        return existing;
      }

      const redirectedFrom = request.redirectedFrom();
      const predecessor = redirectedFrom === null ? null : ensureRequest(redirectedFrom);
      const requestId = createRequestId(nextRequestSequence);
      nextRequestSequence += 1;
      const redirectChainRequestIds = predecessor === null
        ? []
        : [...predecessor.redirectChainRequestIds, predecessor.requestId];
      // 設計者の判断 2026-11-11: URL は切り詰めない（長い URL も全部残す。証拠を削る上限を置かない）。LZ-2: method も切り詰めない。
      const url = request.url();
      const record: MutableNetworkRequestEvidence = {
        requestId,
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        // 設計者の判断 2026-11-11 の C: ヘッダは、要求が終わった後に、残す記録だけ読む（`startedHeaders`）。
        headers: null,
        readHeaders: () => request.allHeaders(),
        timing: copyTiming(request.timing()),
        redirectFromRequestId: predecessor?.requestId ?? null,
        redirectToRequestId: null,
        redirectChainRequestIds: Object.freeze(redirectChainRequestIds),
        isNavigationRequest: request.isNavigationRequest(),
        isMainFrame: isMainFrameRequest(page, request),
        truncated: false,
        transferSize: null,
        ended: false,
      };
      requestIds.set(request, requestId);
      requestRecords.set(request, record);
      requests.set(requestId, record);
      if (predecessor !== null) {
        predecessor.redirectToRequestId = requestId;
      }
      return record;
    };

    const dataRequests = createDataRequestTracker();
    /** 設計者の判断 2026-11-11 の C: 1 件の記録として残す要求と、その応答のヘッダの読み取りを始める（要求が終わった後に呼ぶ）。 */
    const startKeptHeaders = (requestRecord: MutableNetworkRequestEvidence, sequences: readonly number[]): void => {
      void startedHeaders(requestRecord, REQUEST_HEADER_NAMES);
      for (const sequence of sequences) {
        const response = responses.get(sequence);
        if (response !== undefined) {
          void startedHeaders(response, RESPONSE_HEADER_NAMES);
        }
      }
    };
    const onRequest = (request: Request): void => {
      ensureRequest(request);
      dataRequests.start(request);
    };
    /** まとめた要求の転送量を、読めたら足す（読み取りの途中のものは、写しが待つ）。 */
    const addRepeatedReadTransfer = (group: RepeatedReadGroup, transferSize: Promise<ResponseTransferSizeEvidence>): void => {
      const read = transferSize.then((size) => {
        if (size.status === 'OBSERVED') {
          group.observedTransferCount += 1;
          group.totalTransferBytes += size.totalBytes;
        }
      });
      pendingRepeatedReadTransfers.add(read);
      void read.finally(() => pendingRepeatedReadTransfers.delete(read));
    };
    /**
     * 設計者の判断 2026-11-11: 終わった要求が、同じ口の成功した読み取りのくり返しとしてまとめてよいものなら、その鍵の事実（ほかは `null`）。読み取りで、文書の
     * 読み込みでなく、リダイレクトに関わらず、method を切り詰めておらず、応答が 1 つで、その status が 4xx・5xx でないもの。
     */
    const repeatedReadKeyOf = (record: MutableNetworkRequestEvidence, response: MutableNetworkResponseEvidence | undefined) => {
      if (
        response === undefined
        || !REPEATABLE_READ_METHODS.has(record.method)
        || record.isNavigationRequest
        || record.truncated
        || record.redirectFromRequestId !== null
        || record.redirectToRequestId !== null
        || response.errorContext !== null
        || isHttpStatusInRange(response.status, ERROR_HTTP_STATUS_RANGE)
      ) {
        return null;
      }
      let parsed: URL;
      try {
        parsed = new URL(record.url);
      } catch {
        return null;
      }
      return {
        key: JSON.stringify([record.method, parsed.origin, parsed.pathname, record.resourceType, response.status, record.isMainFrame]),
        origin: parsed.origin,
        path: parsed.pathname,
        queryDigest: queryDigestOf(parsed.search),
        status: response.status,
      };
    };
    const onResponse = (response: Response): void => {
      const request = response.request();
      const requestRecord = ensureRequest(request);
      // 設計者の判断 2026-11-11: URL は切り詰めない。
      const url = response.url();
      const status = response.status();
      const isErrorStatus = isHttpStatusInRange(status, ERROR_HTTP_STATUS_RANGE);
      const approvedService = isApprovedServiceUrl(url, approvedServiceOrigins);
      // DEF-245 の続き: 応答（ヘッダ）を受けたら、落ち着きの判定では、その要求を終わったものとして数える（本文を読まない要求には終わりの事象が来ない）。
      dataRequests.respond(response);
      const responseRecord: MutableNetworkResponseEvidence = {
        request: requestRecord,
        requestId: requestIds.get(request) ?? requestRecord.requestId,
        url,
        status,
        statusText: response.statusText(),
        // 設計者の判断 2026-11-11 の C: ヘッダは、要求が終わった後に、残す記録だけ読む（`startedHeaders`）。
        headers: null,
        readHeaders: () => response.allHeaders(),
        timing: copyTiming(request.timing()),
        isNavigationRequest: requestRecord.isNavigationRequest,
        isMainFrame: requestRecord.isMainFrame,
        truncated: false,
        // AUD-7: 誤り（4xx・5xx）の応答だけ、文脈を読む。
        errorContext: isErrorStatus
          ? startErrorContextObservation(response, approvedService)
          : null,
        // DEF-245 の続き: 要求が終わらないまま写すときは、本文を待たずに「読めなかった」とする（理由の文は、終わっていないこと）。
        errorContextIfNotEnded: isErrorStatus ? UNREADABLE_ERROR_CONTEXT(approvedService, NOT_ENDED_BODY_TEXT) : null,
      };
      const sequence = nextResponseSequence;
      nextResponseSequence += 1;
      responses.set(sequence, responseRecord);
      const sameRequest = responsesByRequestId.get(responseRecord.requestId);
      if (sameRequest === undefined) {
        responsesByRequestId.set(responseRecord.requestId, [sequence]);
      } else {
        sameRequest.push(sequence);
      }
    };
    const onRequestFailed = (request: Request): void => {
      // 失敗は応答を返し終えていないので、口を「届いた」にしない（応答を受けた後の失敗なら、口は応答の時点で終わっている）。
      dataRequests.end(request, false);
      const requestRecord = ensureRequest(request);
      requestRecord.ended = true;
      // 失敗した要求の記録は残すので、ヘッダを読む（設計者の判断 2026-11-11 の C）。応答の時刻は、もう書き換えない（引く一覧を消す）。
      startKeptHeaders(requestRecord, responsesByRequestId.get(requestRecord.requestId) ?? []);
      responsesByRequestId.delete(requestRecord.requestId);
      // 設計者の判断 2026-11-11: URL は切り詰めない。LZ-2: method と失敗の文も切り詰めない（`truncated` はいつも偽）。
      const url = request.url();
      const failureText = request.failure()?.errorText ?? 'UNKNOWN_REQUEST_FAILURE';
      failures.push(Object.freeze({
        requestId: requestRecord.requestId,
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: failureText,
        timing: copyTiming(request.timing()),
        isNavigationRequest: requestRecord.isNavigationRequest,
        isMainFrame: requestRecord.isMainFrame,
        truncated: false,
        // BN-a: BeakSight が止めた要求の失敗か（遮断の失敗の理由の唯一の判定で照らす）と、記録した時点。
        blockedByBeakSight: isBlockedByClientFailure(failureText),
        phase: phaseOf(),
      }));
    };
    const onRequestFinished = (request: Request): void => {
      dataRequests.end(request, true);
      const requestRecord = ensureRequest(request);
      requestRecord.ended = true;
      const finalTiming = copyTiming(request.timing());
      requestRecord.timing = finalTiming;
      const sequences = responsesByRequestId.get(requestRecord.requestId) ?? [];
      responsesByRequestId.delete(requestRecord.requestId);
      for (const sequence of sequences) {
        const response = responses.get(sequence);
        if (response !== undefined) {
          response.timing = finalTiming;
        }
      }
      const [onlySequence] = sequences;
      const repeat = sequences.length === 1 && onlySequence !== undefined
        ? repeatedReadKeyOf(requestRecord, responses.get(onlySequence))
        : null;
      if (repeat === null || requestRecord.transferSize !== null) {
        startKeptHeaders(requestRecord, sequences);
        requestRecord.transferSize ??= startTransferSizeObservation(request);
        return;
      }
      const sample: NetworkRepeatedReadSampleEvidence = Object.freeze({ url: requestRecord.url, timing: finalTiming });
      const group = repeatedReads.get(repeat.key);
      if (group === undefined) {
        // 最初の 1 件は、1 件の記録として残し、まとめの元にする。
        startKeptHeaders(requestRecord, sequences);
        requestRecord.transferSize = startTransferSizeObservation(request);
        const created: RepeatedReadGroup = {
          method: requestRecord.method,
          origin: repeat.origin,
          path: repeat.path,
          resourceType: requestRecord.resourceType,
          status: repeat.status,
          isMainFrame: requestRecord.isMainFrame,
          count: 1,
          firstRequestId: requestRecord.requestId,
          first: sample,
          slowest: sample,
          firstStartTime: finalTiming.startTime,
          lastStartTime: finalTiming.startTime,
          observedTransferCount: 0,
          totalTransferBytes: 0,
          queries: new Set([repeat.queryDigest]),
        };
        repeatedReads.set(repeat.key, created);
        addRepeatedReadTransfer(created, requestRecord.transferSize);
        return;
      }
      // 2 件目からは、1 件の記録を外し、数と代表と転送量だけを残す（ヘッダは読まない）。
      requestRecord.readHeaders = null;
      const folded = responses.get(onlySequence as number);
      if (folded !== undefined) {
        folded.readHeaders = null;
      }
      requests.delete(requestRecord.requestId);
      responses.delete(onlySequence as number);
      group.count += 1;
      group.lastStartTime = Math.max(group.lastStartTime, finalTiming.startTime);
      if (finalTiming.responseEnd > group.slowest.timing.responseEnd) {
        group.slowest = sample;
      }
      group.queries.add(repeat.queryDigest);
      addRepeatedReadTransfer(group, startTransferSizeObservation(request));
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    page.on('requestfinished', onRequestFinished);

    // 手綱の `snapshot` は、渡した関数そのもの（`createCollectorHandle`）なので、写しの指定を受ける形で公開する。
    const handle = createCollectorHandle(
      async (snapshotOptions: NetworkSnapshotOptions = {}): Promise<NetworkEvidence> => {
        const requestBoundary = [...requests.values()].map(captureRequest);
        const responseBoundary = [...responses.values()].map(captureResponse);
        const failureBoundary = failures.map(copyFailure);
        const repeatedReadTransfers = [...pendingRepeatedReadTransfers];
        const omitted = {
          omittedRequestCount,
          omittedResponseCount,
          omittedFailureCount,
        };
        // L2: header と転送量の読み取りは、期限を置かずに進みの見張りで待つ（返るたびに進みの印）。ブラウザが反応なしの長さの間に返さなかった
        // ものだけを、読めなかった（`FAILED`）として記録し、ほかの記録は全部残す。
        const pending: Promise<unknown>[] = [
          ...requestBoundary.map((request) => request.headers),
          ...responseBoundary.flatMap((response) => [
            response.headers,
            ...(response.transferSize === null ? [] : [response.transferSize]),
            ...(response.errorContext === null ? [] : [response.errorContext]),
          ]),
          ...repeatedReadTransfers,
        ];
        let endWatch: () => void = () => undefined;
        const watchEnded = new Promise<void>((resolve) => {
          endWatch = resolve;
        });
        const orUnreturned = <T>(read: Promise<T>, unreturned: T): Promise<T> =>
          Promise.race([read, watchEnded.then(() => unreturned)]);
        const materialized = Promise.all([
          Promise.all(requestBoundary.map((request) => materializeRequest({
            ...request,
            headers: orUnreturned(request.headers, UNRETURNED_HEADERS),
          }))),
          Promise.all(responseBoundary.map((response) => materializeResponse({
            ...response,
            headers: orUnreturned(response.headers, UNRETURNED_HEADERS),
            transferSize: response.transferSize === null ? null : orUnreturned(response.transferSize, UNRETURNED_TRANSFER_SIZE),
            errorContext: response.errorContext === null
              ? null
              : orUnreturned(response.errorContext, UNRETURNED_ERROR_CONTEXT(isApprovedServiceUrl(response.url, approvedServiceOrigins))),
          }))),
        ]);
        await watchCollection(
          page,
          (signals) => Promise.all(pending.map((read) => signals.track(read))),
          snapshotOptions.watch ?? options.watch ?? {},
          { pageSignals: false },
        );
        endWatch();
        const [requestSnapshots, responseSnapshots] = await materialized;
        // 設計者の判断 2026-11-11: 2 件以上をまとめた記録だけを出す（1 件だけの鍵は、1 件の記録のままで足りる）。
        const repeated = [...repeatedReads.values()].filter((group) => group.count > 1).map(repeatedReadOfGroup);
        return Object.freeze({
          requests: Object.freeze(requestSnapshots),
          responses: Object.freeze(responseSnapshots),
          failures: Object.freeze(failureBoundary),
          ...omitted,
          ...(repeated.length === 0 ? {} : { repeatedReads: Object.freeze(repeated) }),
        });
      },
      () => {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        page.off('requestfinished', onRequestFinished);
      },
    );
    return Object.freeze({
      snapshot: handle.snapshot as NetworkCollectorHandle['snapshot'],
      detach: () => handle.detach(),
      dataRequestActivity: (): DataRequestActivity => dataRequests.activity(),
    });
  }
}
