import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { awaitBeforeDeadline } from '../core/deadline.js';
import type {
  CLSAttributionEvidence,
  HeaderEvidence,
  INPAttributionEvidence,
  LCPAttributionEvidence,
  NavigationTimingEvidence,
  NetworkEvidence,
  PerformanceEvidence,
  PerformanceEvidenceFacts,
  PerformanceTruncationEvidence,
  ResourceCategory,
  ResourceCategoryBasis,
  ResourceCoverageEvidence,
  ResourceSizeEvidence,
  ResourceSizeStatus,
  ResourceSummariesEvidence,
  ResourceSummaryEvidence,
  ResourceTimingEvidence,
  ServerTimingEvidence,
  ServerTimingSource,
  TelemetryCandidateEvidence,
  TelemetryHeaderDirection,
  TelemetryHeaderEvidence,
  TelemetryMatchingBasis,
  UnobservedWebVitalStatus,
  WebVitalEvidence,
  WebVitalsEvidence,
} from '../core/evidence-types.js';
import {
  INP_INTERACTION_TYPES,
  UNOBSERVED_WEB_VITAL_STATUSES,
  WEB_VITAL_NAVIGATION_TYPES,
} from '../core/evidence-types.js';
import {
  isNonNegativeFiniteNumber,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
} from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_RESOURCE_TIMING_ENTRIES, MAX_URL_LENGTH } from '../core/limits.js';
import { truncateText } from '../core/text.js';

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 512;
const MAX_RESOURCES = MAX_RESOURCE_TIMING_ENTRIES;
const MAX_SERVER_TIMING_PER_ENTRY = 20;
const MAX_SERVER_TIMING_TOTAL = 500;
const MAX_TELEMETRY_HEADERS = 200;
const MAX_TELEMETRY_CANDIDATES = 100;
const MAX_PROJECTED_REQUESTS = MAX_RESOURCES;
const MAX_PROJECTED_RESPONSES = MAX_TELEMETRY_HEADERS;
const MAX_PROJECTED_HEADER_FIELDS = 32;

const installedContexts = new WeakSet<BrowserContext>();
const pendingInstallations = new WeakMap<BrowserContext, Promise<void>>();

const TELEMETRY_HEADER_NAMES = new Set([
  'traceparent',
  'tracestate',
  'request-id',
  'correlation-id',
  'x-traceparent',
  'x-tracestate',
  'x-request-id',
  'x-correlation-id',
]);

const GENERIC_TELEMETRY_HINTS = Object.freeze([
  'analytics',
  'telemetry',
  'collect',
  'metrics',
  'rum',
  'apm',
  'beacon',
  'track',
] as const);


export interface PerformanceCollectionOptions {
  readonly deadlineAtMs: number;
}

// Network Evidence の同期的な射影の途中で期限を過ぎたことを表す。
const DEADLINE = Symbol('deadline');

/** ブラウザ内の処理に渡す上限値。ブラウザ内では import できないため、Node側の定数を引数で渡す。 */
interface BrowserPerformanceLimits {
  readonly maxIdLength: number;
  readonly maxTextLength: number;
  readonly maxUrlLength: number;
  readonly maxResourceTimingEntries: number;
  readonly maxServerTimingPerEntry: number;
}

const BROWSER_PERFORMANCE_LIMITS: BrowserPerformanceLimits = Object.freeze({
  maxIdLength: MAX_ID_LENGTH,
  maxTextLength: MAX_TEXT_LENGTH,
  maxUrlLength: MAX_URL_LENGTH,
  maxResourceTimingEntries: MAX_RESOURCES,
  maxServerTimingPerEntry: MAX_SERVER_TIMING_PER_ENTRY,
});

/** ブラウザ内の処理に渡す値の一覧。ブラウザ内では import できないため、core の配列を引数で渡す。 */
interface BrowserPerformanceValueLists {
  readonly webVitalNavigationTypes: readonly string[];
  readonly inpInteractionTypes: readonly string[];
}

const BROWSER_PERFORMANCE_VALUE_LISTS: BrowserPerformanceValueLists = Object.freeze({
  webVitalNavigationTypes: WEB_VITAL_NAVIGATION_TYPES,
  inpInteractionTypes: INP_INTERACTION_TYPES,
});

function initializePerformanceState(
  library: unknown,
  limits: BrowserPerformanceLimits,
  valueLists: BrowserPerformanceValueLists,
): void {
  const { maxIdLength, maxTextLength, maxUrlLength, maxResourceTimingEntries } = limits;
  // Resource Timing のバッファを広げ、満杯になったことを記録する。ページのリスナーより先に動くよう capture で登録する。
  let resourceBufferSize: number | null = null;
  try {
    if (typeof performance.setResourceTimingBufferSize === 'function') {
      performance.setResourceTimingBufferSize(maxResourceTimingEntries);
      resourceBufferSize = maxResourceTimingEntries;
    }
  } catch {
    resourceBufferSize = null;
  }
  let resourceBufferFull = false;
  let resourceBufferObservable = false;
  try {
    performance.addEventListener('resourcetimingbufferfull', () => {
      resourceBufferFull = true;
    }, { capture: true });
    resourceBufferObservable = true;
  } catch {
    resourceBufferObservable = false;
  }
  let textTruncated = false;
  const supportedEntries = new Set(
    typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes
      : [],
  );
  const blank = (status: UnobservedWebVitalStatus) => ({
    status,
    value: null,
    id: null,
    navigationType: null,
    attribution: null,
  });
  const libraryRecord = typeof library === 'object' && library !== null
    ? library as Record<string, unknown>
    : {};
  const support = {
    CLS: supportedEntries.has('layout-shift'),
    FCP: supportedEntries.has('paint'),
    INP: supportedEntries.has('event')
      && typeof globalThis.PerformanceEventTiming === 'function'
      && 'interactionId' in globalThis.PerformanceEventTiming.prototype,
    LCP: supportedEntries.has('largest-contentful-paint'),
    TTFB: typeof performance.getEntriesByType === 'function',
  };
  const state: Record<string, Record<string, unknown>> = {
    CLS: blank(support.CLS && typeof libraryRecord.onCLS === 'function' ? 'NOT_OBSERVED' : 'UNSUPPORTED'),
    FCP: blank(support.FCP && typeof libraryRecord.onFCP === 'function' ? 'NOT_OBSERVED' : 'UNSUPPORTED'),
    INP: blank(support.INP && typeof libraryRecord.onINP === 'function' ? 'NOT_OBSERVED' : 'UNSUPPORTED'),
    LCP: blank(support.LCP && typeof libraryRecord.onLCP === 'function' ? 'NOT_OBSERVED' : 'UNSUPPORTED'),
    TTFB: blank(support.TTFB && typeof libraryRecord.onTTFB === 'function' ? 'NOT_OBSERVED' : 'UNSUPPORTED'),
  };
  const boundedString = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (value.length > maxLength) textTruncated = true;
    return value.slice(0, maxLength);
  };
  const nonnegative = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  );
  const attributionFor = (name: string, value: unknown): Record<string, string | number> | null => {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, string | number> = {};
    const copyString = (key: string, maxLength = maxTextLength): void => {
      const normalized = boundedString(source[key], maxLength);
      if (normalized !== undefined) output[key] = normalized;
    };
    const copyNumber = (key: string): void => {
      const normalized = nonnegative(source[key]);
      if (normalized !== undefined) output[key] = normalized;
    };
    if (name === 'CLS') {
      copyString('largestShiftTarget');
      copyNumber('largestShiftTime');
      copyNumber('largestShiftValue');
      copyString('loadState');
    } else if (name === 'LCP') {
      copyString('target');
      copyString('url', maxUrlLength);
      copyNumber('timeToFirstByte');
      copyNumber('resourceLoadDelay');
      copyNumber('resourceLoadDuration');
      copyNumber('elementRenderDelay');
    } else if (name === 'INP') {
      copyString('interactionTarget');
      copyNumber('interactionTime');
      if (
        typeof source.interactionType === 'string'
        && valueLists.inpInteractionTypes.includes(source.interactionType)
      ) {
        output.interactionType = source.interactionType;
      }
      copyNumber('nextPaintTime');
      copyNumber('inputDelay');
      copyNumber('processingDuration');
      copyNumber('presentationDelay');
      copyString('loadState');
    }
    return Object.keys(output).length === 0 ? null : output;
  };
  // web-vitals の `rating` は読まない（しきい値に照らした評価は Rule Catalog が行う）。
  const report = (name: string, metric: unknown): void => {
    if (typeof metric !== 'object' || metric === null) return;
    const candidate = metric as Record<string, unknown>;
    const value = nonnegative(candidate.value);
    if (value === undefined) return;
    const navigationTypes = new Set(valueLists.webVitalNavigationTypes);
    state[name] = {
      status: 'OBSERVED',
      value,
      id: boundedString(candidate.id, maxIdLength) ?? null,
      navigationType: typeof candidate.navigationType === 'string' && navigationTypes.has(candidate.navigationType)
        ? candidate.navigationType
        : null,
      attribution: name === 'CLS' || name === 'LCP' || name === 'INP'
        ? attributionFor(name, candidate.attribution)
        : null,
    };
  };
  const register = (name: keyof typeof support, callbackName: string): void => {
    if (!support[name]) return;
    const callback = libraryRecord[callbackName];
    if (typeof callback !== 'function') return;
    try {
      callback((metric: unknown) => report(name, metric), { reportAllChanges: true });
    } catch {
      state[name] = blank('UNSUPPORTED');
    }
  };
  register('CLS', 'onCLS');
  register('FCP', 'onFCP');
  register('INP', 'onINP');
  register('LCP', 'onLCP');
  register('TTFB', 'onTTFB');

  const snapshot = (): {
    readonly webVitals: Record<string, Record<string, unknown>>;
    readonly textTruncated: boolean;
    readonly resourceBuffer: { readonly size: number | null; readonly full: boolean | null };
  } => ({
    webVitals: Object.fromEntries(Object.entries(state).map(([name, metric]) => [
      name,
      {
        ...metric,
        attribution: typeof metric.attribution === 'object' && metric.attribution !== null
          ? { ...(metric.attribution as Record<string, unknown>) }
          : null,
      },
    ])),
    textTruncated,
    // リスナーを登録できなかった場合は、満杯かどうかが分からないので `null` にする。
    resourceBuffer: { size: resourceBufferSize, full: resourceBufferObservable ? resourceBufferFull : null },
  });
  Object.defineProperty(globalThis, '__BEAKSIGHT_PERFORMANCE__', {
    configurable: false,
    enumerable: false,
    get: snapshot,
    set: () => undefined,
  });
}

function webVitalsBundleUrl(): URL {
  return new URL('./web-vitals.attribution.iife.js', import.meta.resolve('web-vitals'));
}

async function createInitScript(): Promise<string> {
  const bundle = await readFile(webVitalsBundleUrl(), { encoding: 'utf8' });
  return `${bundle}\n;(${initializePerformanceState.toString()})(`
    + `typeof webVitals === 'object' ? webVitals : undefined, ${JSON.stringify(BROWSER_PERFORMANCE_LIMITS)}, `
    + `${JSON.stringify(BROWSER_PERFORMANCE_VALUE_LISTS)});`;
}

function validateOptions(options: PerformanceCollectionOptions): void {
  if (!Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Performance collection deadline must be finite');
  }
}

/** 文字列を上限で切り詰める。切り詰めた場合は `state.textTruncated` を立てる。文字列でなければ `null`。 */
function boundedString(value: unknown, maximum: number, state: TextState): string | null {
  if (typeof value !== 'string') return null;
  const bounded = truncateText(value, maximum);
  if (bounded.truncated) state.textTruncated = true;
  return bounded.text;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  return isNonNegativeFiniteNumber(value) ? value : null;
}

function emptyVital(status: UnobservedWebVitalStatus = 'NOT_OBSERVED'): WebVitalEvidence<never> {
  return Object.freeze({
    status,
    value: null,
    id: null,
    navigationType: null,
    attribution: null,
  });
}

interface TextState {
  textTruncated: boolean;
}

interface ValidationState extends TextState {
  invalid: boolean;
  /** 上限のため記録しなかった Server-Timing の件数（ブラウザ内とNode側の切り捨ての合計）。 */
  omittedServerTimingCount: number;
}

function createValidationState(): ValidationState {
  return { invalid: false, textTruncated: false, omittedServerTimingCount: 0 };
}

/** 上限のため記録しなかった件数を加える。件数が0以上の安全な整数でない場合や、合計が安全な整数を超える場合は不正なデータとする。 */
function addOmittedServerTiming(validation: ValidationState, count: unknown): void {
  const total = isNonNegativeSafeInteger(count) ? validation.omittedServerTimingCount + count : Number.NaN;
  if (!isNonNegativeSafeInteger(total)) {
    validation.invalid = true;
    return;
  }
  validation.omittedServerTimingCount = total;
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, string | number>,
  key: string,
  validation: ValidationState,
  maximum = MAX_TEXT_LENGTH,
): void {
  if (!(key in source)) return;
  const value = boundedString(source[key], maximum, validation);
  if (value !== null) target[key] = value;
}

function copyOptionalNumber(
  source: Record<string, unknown>,
  target: Record<string, string | number>,
  key: string,
  validation: ValidationState,
): void {
  if (!(key in source)) return;
  const value = nonnegative(source[key]);
  if (value === null) {
    validation.invalid = true;
    return;
  }
  target[key] = value;
}

function normalizeAttribution(
  name: keyof WebVitalsEvidence,
  value: unknown,
  validation: ValidationState,
): Readonly<CLSAttributionEvidence | LCPAttributionEvidence | INPAttributionEvidence> | null {
  if (name === 'FCP' || name === 'TTFB') return null;
  const source = record(value);
  if (source === null) return null;
  const target: Record<string, string | number> = {};
  if (name === 'CLS') {
    copyOptionalString(source, target, 'largestShiftTarget', validation);
    copyOptionalNumber(source, target, 'largestShiftTime', validation);
    copyOptionalNumber(source, target, 'largestShiftValue', validation);
    copyOptionalString(source, target, 'loadState', validation);
  } else if (name === 'LCP') {
    copyOptionalString(source, target, 'target', validation);
    copyOptionalString(source, target, 'url', validation, MAX_URL_LENGTH);
    copyOptionalNumber(source, target, 'timeToFirstByte', validation);
    copyOptionalNumber(source, target, 'resourceLoadDelay', validation);
    copyOptionalNumber(source, target, 'resourceLoadDuration', validation);
    copyOptionalNumber(source, target, 'elementRenderDelay', validation);
  } else {
    copyOptionalString(source, target, 'interactionTarget', validation);
    copyOptionalNumber(source, target, 'interactionTime', validation);
    if ('interactionType' in source) {
      const interactionType = INP_INTERACTION_TYPES.find((type) => type === source.interactionType);
      if (interactionType !== undefined) {
        target.interactionType = interactionType;
      }
    }
    copyOptionalNumber(source, target, 'nextPaintTime', validation);
    copyOptionalNumber(source, target, 'inputDelay', validation);
    copyOptionalNumber(source, target, 'processingDuration', validation);
    copyOptionalNumber(source, target, 'presentationDelay', validation);
    copyOptionalString(source, target, 'loadState', validation);
  }
  return Object.keys(target).length === 0 ? null : Object.freeze(target);
}

function normalizeVital<TAttribution>(
  name: keyof WebVitalsEvidence,
  value: unknown,
  validation: ValidationState,
): WebVitalEvidence<TAttribution> {
  const source = record(value);
  // `rating` はブラウザが返しても読まない（V12）。
  const unobservedStatus = UNOBSERVED_WEB_VITAL_STATUSES.find((status) => status === source?.status);
  if (source !== null && unobservedStatus !== undefined) {
    if (
      source.value !== null
      || source.id !== null
      || source.navigationType !== null
      || source.attribution !== null
    ) {
      validation.invalid = true;
    }
    return emptyVital(unobservedStatus);
  }
  if (source?.status !== 'OBSERVED') {
    validation.invalid = true;
    return emptyVital();
  }
  const metricValue = nonnegative(source.value);
  if (metricValue === null) {
    validation.invalid = true;
    return emptyVital();
  }
  const navigationType = WEB_VITAL_NAVIGATION_TYPES.find((type) => type === source.navigationType)
    ?? (source.navigationType === null
      ? null
      : (validation.invalid = true, null));
  const id = boundedString(source.id, MAX_ID_LENGTH, validation);
  if (source.id !== null && id === null) validation.invalid = true;
  return Object.freeze({
    status: 'OBSERVED',
    value: metricValue,
    id,
    navigationType,
    attribution: normalizeAttribution(name, source.attribution, validation) as Readonly<TAttribution> | null,
  });
}

function normalizeWebVitals(value: unknown, validation: ValidationState): WebVitalsEvidence | null {
  const source = record(value);
  if (source === null) {
    validation.invalid = true;
    return null;
  }
  const vitalValidation = createValidationState();
  const normalized = Object.freeze({
    CLS: normalizeVital<CLSAttributionEvidence>('CLS', source.CLS, vitalValidation),
    FCP: normalizeVital<never>('FCP', source.FCP, vitalValidation),
    INP: normalizeVital<INPAttributionEvidence>('INP', source.INP, vitalValidation),
    LCP: normalizeVital<LCPAttributionEvidence>('LCP', source.LCP, vitalValidation),
    TTFB: normalizeVital<never>('TTFB', source.TTFB, vitalValidation),
  });
  if (vitalValidation.invalid) {
    validation.invalid = true;
    return null;
  }
  if (vitalValidation.textTruncated) validation.textTruncated = true;
  return normalized;
}

/**
 * 1件の Navigation・Resource Timing の Server-Timing を正規化する。
 * ブラウザ内で切り捨てた件数（`omittedServerTimingCount`）と、Node側の1件あたりの上限で切り捨てた件数を数える。
 */
function normalizeServerTiming(
  entry: Record<string, unknown>,
  source: ServerTimingSource,
  url: string,
  validation: ValidationState,
): readonly Readonly<ServerTimingEvidence>[] {
  const value = entry.serverTiming;
  if (!Array.isArray(value)) {
    validation.invalid = true;
    return Object.freeze([]);
  }
  addOmittedServerTiming(validation, entry.omittedServerTimingCount);
  addOmittedServerTiming(validation, Math.max(0, value.length - MAX_SERVER_TIMING_PER_ENTRY));
  const output: ServerTimingEvidence[] = [];
  for (const candidate of value.slice(0, MAX_SERVER_TIMING_PER_ENTRY)) {
    const item = record(candidate);
    const name = boundedString(item?.name, MAX_TEXT_LENGTH, validation);
    const duration = nonnegative(item?.duration);
    if (item === null || name === null || duration === null) {
      validation.invalid = true;
      continue;
    }
    output.push(Object.freeze({
      source,
      url,
      name,
      description: boundedString(item.description, MAX_TEXT_LENGTH, validation) ?? '',
      duration,
    }));
  }
  return Object.freeze(output);
}

const NAVIGATION_NUMBERS = Object.freeze([
  'startTime',
  'duration',
  'responseStart',
  'responseEnd',
  'domContentLoadedEventStart',
  'domContentLoadedEventEnd',
  'loadEventStart',
  'loadEventEnd',
  'transferSize',
  'encodedBodySize',
  'decodedBodySize',
] as const);

function normalizeNavigation(value: unknown, validation: ValidationState): NavigationTimingEvidence | null {
  if (!Array.isArray(value)) {
    validation.invalid = true;
    return null;
  }
  if (value.length === 0) return null;
  const item = record(value[0]);
  const url = boundedString(item?.name, MAX_URL_LENGTH, validation);
  if (item === null || url === null) {
    validation.invalid = true;
    return null;
  }
  const numbers = Object.fromEntries(NAVIGATION_NUMBERS.map((key) => [key, nonnegative(item[key])]));
  if (Object.values(numbers).some((number) => number === null)) {
    validation.invalid = true;
    return null;
  }
  return Object.freeze({
    url,
    navigationType: boundedString(item.type, MAX_TEXT_LENGTH, validation) ?? '',
    startTime: numbers.startTime as number,
    duration: numbers.duration as number,
    responseStart: numbers.responseStart as number,
    responseEnd: numbers.responseEnd as number,
    domContentLoadedEventStart: numbers.domContentLoadedEventStart as number,
    domContentLoadedEventEnd: numbers.domContentLoadedEventEnd as number,
    loadEventStart: numbers.loadEventStart as number,
    loadEventEnd: numbers.loadEventEnd as number,
    transferSize: numbers.transferSize as number,
    encodedBodySize: numbers.encodedBodySize as number,
    decodedBodySize: numbers.decodedBodySize as number,
    serverTiming: normalizeServerTiming(item, 'NAVIGATION', url, validation),
  });
}

const RESOURCE_NUMBERS = Object.freeze([
  'startTime',
  'duration',
  'responseStart',
  'responseEnd',
  'transferSize',
  'encodedBodySize',
  'decodedBodySize',
] as const);

function networkCategory(resourceType: string): ResourceCategory | null {
  switch (resourceType.toLowerCase()) {
    case 'script': return 'script';
    case 'stylesheet': return 'stylesheet';
    case 'image': return 'image';
    case 'fetch':
    case 'xhr': return 'fetch-xhr';
    default: return null;
  }
}

function initiatorCategory(initiatorType: string): ResourceCategory | null {
  switch (initiatorType.toLowerCase()) {
    case 'script': return 'script';
    case 'stylesheet':
      return 'stylesheet';
    case 'img':
    case 'image': return 'image';
    case 'fetch':
    case 'xmlhttprequest':
    case 'xhr': return 'fetch-xhr';
    default: return null;
  }
}

function initiatorRequestType(initiatorType: string): string | null {
  switch (initiatorType.toLowerCase()) {
    case 'script': return 'script';
    case 'stylesheet': return 'stylesheet';
    case 'img':
    case 'image': return 'image';
    case 'fetch': return 'fetch';
    case 'xmlhttprequest':
    case 'xhr': return 'xhr';
    default: return null;
  }
}

interface ProjectedNetworkRequest {
  readonly requestId: string;
  readonly url: string;
  readonly correlationUrl: string | null;
  readonly method: string;
  readonly resourceType: string;
  readonly correlationResourceType: string | null;
  readonly headers: HeaderEvidence;
}

interface ProjectedNetworkResponse {
  readonly requestId: string;
  readonly url: string;
  readonly headers: HeaderEvidence;
}

interface ProjectedNetworkEvidence {
  readonly requests: readonly Readonly<ProjectedNetworkRequest>[];
  readonly responses: readonly Readonly<ProjectedNetworkResponse>[];
  /** 上限のため読まなかったリクエストと response の件数。 */
  readonly omittedRequestCount: number;
  readonly omittedResponseCount: number;
  /** 読んだ文字列のどれかを上限で切り詰めたか。 */
  readonly textTruncated: boolean;
}

/** `value.slice(0, maximum)` と同じ結果を返し、切り詰めた場合は `state.textTruncated` を立てる。 */
function clip(value: string, maximum: number, state: TextState): string {
  const text = value.slice(0, maximum);
  if (text.length < value.length) state.textTruncated = true;
  return text;
}

function projectHeaderEvidence(
  headers: HeaderEvidence,
  deadlineAtMs: number,
  state: TextState,
): HeaderEvidence | typeof DEADLINE {
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const status = headers.status;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  if (status === 'FAILED') {
    const rawErrorText = headers.errorText;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const errorText = clip(rawErrorText, MAX_ERROR_MESSAGE_LENGTH, state);
    return Object.freeze({
      status: 'FAILED',
      errorText,
    });
  }
  const sourceValues = headers.values;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const values: Record<string, string> = {};
  let scanned = 0;
  const ownKeys = Reflect.ownKeys(sourceValues);
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  for (const key of ownKeys) {
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (typeof key !== 'string') continue;
    scanned += 1;
    if (scanned > MAX_PROJECTED_HEADER_FIELDS) break;
    const descriptor = Object.getOwnPropertyDescriptor(sourceValues, key);
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (descriptor === undefined || !descriptor.enumerable || key.length > MAX_TEXT_LENGTH) continue;
    const normalizedName = key.toLowerCase();
    if (!TELEMETRY_HEADER_NAMES.has(normalizedName)) continue;
    const value = sourceValues[key];
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (typeof value === 'string') {
      values[key] = clip(value, MAX_TEXT_LENGTH, state);
    }
  }
  return Date.now() >= deadlineAtMs
    ? DEADLINE
    : Object.freeze({ status: 'OBSERVED', values: Object.freeze(values) });
}

function projectNetworkEvidence(
  networkEvidence: NetworkEvidence,
  deadlineAtMs: number,
): ProjectedNetworkEvidence | typeof DEADLINE {
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const sourceRequests = networkEvidence.requests;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const sourceResponses = networkEvidence.responses;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const requestLength = sourceRequests.length;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const responseLength = sourceResponses.length;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const requestLimit = Math.min(requestLength, MAX_PROJECTED_REQUESTS);
  const responseLimit = Math.min(responseLength, MAX_PROJECTED_RESPONSES);
  const requests: ProjectedNetworkRequest[] = [];
  const responses: ProjectedNetworkResponse[] = [];
  const state: TextState = { textTruncated: false };
  for (let index = 0; index < requestLimit; index += 1) {
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const source = sourceRequests[index];
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (source === undefined) continue;
    const rawRequestId = source.requestId;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const requestId = clip(rawRequestId, MAX_ID_LENGTH, state);
    const rawUrl = source.url;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const url = clip(rawUrl, MAX_URL_LENGTH, state);
    const correlationUrl = rawUrl.length <= MAX_URL_LENGTH ? rawUrl : null;
    const rawMethod = source.method;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const method = clip(rawMethod, MAX_TEXT_LENGTH, state);
    const rawResourceType = source.resourceType;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const resourceType = clip(rawResourceType, MAX_TEXT_LENGTH, state);
    let correlationResourceType: string | null = null;
    if (rawResourceType.length <= MAX_TEXT_LENGTH) {
      const normalizedResourceType = rawResourceType.toLowerCase();
      if (normalizedResourceType.length <= MAX_TEXT_LENGTH) correlationResourceType = normalizedResourceType;
    }
    const rawHeaders = source.headers;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const headers = projectHeaderEvidence(rawHeaders, deadlineAtMs, state);
    if (headers === DEADLINE) return DEADLINE;
    requests.push(Object.freeze({
      requestId,
      url,
      correlationUrl,
      method,
      resourceType,
      correlationResourceType,
      headers,
    }));
    if (Date.now() >= deadlineAtMs) return DEADLINE;
  }
  for (let index = 0; index < responseLimit; index += 1) {
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const source = sourceResponses[index];
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (source === undefined) continue;
    const rawRequestId = source.requestId;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const requestId = clip(rawRequestId, MAX_ID_LENGTH, state);
    const rawUrl = source.url;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const url = clip(rawUrl, MAX_URL_LENGTH, state);
    const rawHeaders = source.headers;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const headers = projectHeaderEvidence(rawHeaders, deadlineAtMs, state);
    if (headers === DEADLINE) return DEADLINE;
    responses.push(Object.freeze({
      requestId,
      url,
      headers,
    }));
    if (Date.now() >= deadlineAtMs) return DEADLINE;
  }
  return Object.freeze({
    requests: Object.freeze(requests),
    responses: Object.freeze(responses),
    omittedRequestCount: requestLength - requestLimit,
    omittedResponseCount: responseLength - responseLimit,
    textTruncated: state.textTruncated,
  });
}

function requestQueues(requests: readonly ProjectedNetworkRequest[]): Map<string, ProjectedNetworkRequest[]> {
  const queues = new Map<string, ProjectedNetworkRequest[]>();
  for (const request of requests) {
    if (
      request.correlationResourceType === null
      || request.correlationResourceType === 'document'
      || request.correlationUrl === null
    ) continue;
    const queue = queues.get(request.correlationUrl) ?? [];
    queue.push(request);
    queues.set(request.correlationUrl, queue);
  }
  return queues;
}

function takeCompatibleRequest(
  queue: ProjectedNetworkRequest[] | undefined,
  initiatorType: string,
): ProjectedNetworkRequest | undefined {
  if (queue === undefined || queue.length === 0) return undefined;
  const exactRequestType = initiatorRequestType(initiatorType);
  if (exactRequestType !== null) {
    const compatibleIndex = queue.findIndex((request) => (
      request.correlationResourceType === exactRequestType
    ));
    return compatibleIndex < 0 ? undefined : queue.splice(compatibleIndex, 1)[0];
  }
  if (queue.length === 1) return queue.shift();
  const resourceTypes = new Set(queue.map((request) => request.correlationResourceType));
  return resourceTypes.size === 1 ? queue.shift() : undefined;
}

/** 文書のOrigin。文書を観測できない場合と、Originが不透明（`null`）な場合は `null`。 */
function documentOrigin(navigation: NavigationTimingEvidence | null): string | null {
  if (navigation === null) return null;
  try {
    const origin = new URL(navigation.url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * 転送量と本文の大きさがすべて0で、文書と別Origin（または文書のOriginが分からない）の資源は、
 * Timing-Allow-Origin がないため大きさを隠されたものとして扱い、大きさを不明とする。
 */
function resourceSizeStatus(
  rawUrl: string,
  sizes: { readonly transferSize: number; readonly encodedBodySize: number; readonly decodedBodySize: number },
  origin: string | null,
): ResourceSizeStatus {
  if (sizes.transferSize !== 0 || sizes.encodedBodySize !== 0 || sizes.decodedBodySize !== 0) return 'OBSERVED';
  if (origin === null) return 'CROSS_ORIGIN_RESTRICTED';
  try {
    return new URL(rawUrl).origin === origin ? 'OBSERVED' : 'CROSS_ORIGIN_RESTRICTED';
  } catch {
    return 'CROSS_ORIGIN_RESTRICTED';
  }
}

function normalizeResources(
  value: unknown,
  projectedRequests: readonly ProjectedNetworkRequest[],
  origin: string | null,
  validation: ValidationState,
): readonly Readonly<ResourceTimingEvidence>[] {
  if (!Array.isArray(value)) {
    validation.invalid = true;
    return Object.freeze([]);
  }
  const queues = requestQueues(projectedRequests);
  const output: ResourceTimingEvidence[] = [];
  for (const candidate of value.slice(0, MAX_RESOURCES)) {
    const item = record(candidate);
    const rawUrl = typeof item?.name === 'string' ? item.name : null;
    const url = boundedString(rawUrl, MAX_URL_LENGTH, validation);
    const initiatorType = boundedString(item?.initiatorType, MAX_TEXT_LENGTH, validation);
    if (item === null || rawUrl === null || url === null || initiatorType === null) {
      validation.invalid = true;
      continue;
    }
    const numbers = Object.fromEntries(RESOURCE_NUMBERS.map((key) => [key, nonnegative(item[key])]));
    if (Object.values(numbers).some((number) => number === null)) {
      validation.invalid = true;
      continue;
    }
    const queue = queues.get(rawUrl);
    const request = takeCompatibleRequest(queue, initiatorType);
    const fromNetwork = request?.correlationResourceType === null || request === undefined
      ? null
      : networkCategory(request.correlationResourceType);
    const fromInitiator = initiatorCategory(initiatorType);
    const category = fromNetwork ?? fromInitiator;
    const categoryBasis: ResourceCategoryBasis = fromNetwork !== null
      ? 'NETWORK_EVIDENCE'
      : fromInitiator !== null
        ? 'INITIATOR_TYPE'
        : 'UNKNOWN';
    const sizes = {
      transferSize: numbers.transferSize as number,
      encodedBodySize: numbers.encodedBodySize as number,
      decodedBodySize: numbers.decodedBodySize as number,
    };
    const sizeEvidence: ResourceSizeEvidence = resourceSizeStatus(rawUrl, sizes, origin) === 'OBSERVED'
      ? { sizeStatus: 'OBSERVED', ...sizes }
      : { sizeStatus: 'CROSS_ORIGIN_RESTRICTED', transferSize: null, encodedBodySize: null, decodedBodySize: null };
    output.push(Object.freeze({
      url,
      initiatorType,
      startTime: numbers.startTime as number,
      duration: numbers.duration as number,
      responseStart: numbers.responseStart as number,
      responseEnd: numbers.responseEnd as number,
      ...sizeEvidence,
      requestId: request === undefined ? null : boundedString(request.requestId, MAX_ID_LENGTH, validation),
      networkResourceType: request === undefined
        ? null
        : boundedString(request.resourceType, MAX_TEXT_LENGTH, validation),
      category,
      categoryBasis,
      serverTiming: normalizeServerTiming(item, 'RESOURCE', url, validation),
    }));
  }
  return Object.freeze(output);
}

function emptySummary(): ResourceSummaryEvidence {
  return { count: 0, sizeUnknownCount: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 };
}

/** 観測できた資源をカテゴリごとに集計する。大きさが不明な資源は件数だけを数え、大きさの合計に0として入れない。 */
function summarizeResources(
  resources: readonly ResourceTimingEvidence[],
  validation: ValidationState,
): ResourceSummariesEvidence | null {
  const mutable: Record<ResourceCategory, ResourceSummaryEvidence> = {
    script: emptySummary(),
    stylesheet: emptySummary(),
    image: emptySummary(),
    'fetch-xhr': emptySummary(),
  };
  for (const resource of resources) {
    if (resource.category === null) continue;
    const previous = mutable[resource.category];
    const next = resource.sizeStatus === 'OBSERVED'
      ? {
        count: previous.count + 1,
        sizeUnknownCount: previous.sizeUnknownCount,
        transferSize: previous.transferSize + resource.transferSize,
        encodedBodySize: previous.encodedBodySize + resource.encodedBodySize,
        decodedBodySize: previous.decodedBodySize + resource.decodedBodySize,
      }
      : { ...previous, count: previous.count + 1, sizeUnknownCount: previous.sizeUnknownCount + 1 };
    if (Object.values(next).some((value) => !isNonNegativeSafeInteger(value))) {
      validation.invalid = true;
      return null;
    }
    mutable[resource.category] = next;
  }
  return Object.freeze({
    script: Object.freeze(mutable.script),
    stylesheet: Object.freeze(mutable.stylesheet),
    image: Object.freeze(mutable.image),
    'fetch-xhr': Object.freeze(mutable['fetch-xhr']),
  });
}

/**
 * Resource Timing の観測範囲を正規化する。バッファの状態か、上限で記録しなかった件数が不正な場合は、
 * 不正なデータとして `null` を返す（完全に観測できたとはみなさない）。
 */
function normalizeResourceCoverage(
  rawRecord: Record<string, unknown>,
  rawResources: unknown,
  retainedEntryCount: number,
  validation: ValidationState,
): ResourceCoverageEvidence | null {
  const buffer = record(rawRecord.resourceBuffer);
  const bufferSize = buffer?.size;
  const bufferFull = buffer?.full;
  const browserOmitted = rawRecord.omittedResourceEntryCount;
  if (
    buffer === null
    || typeof bufferFull !== 'boolean'
    || !(bufferSize === null || isPositiveSafeInteger(bufferSize))
    || !isNonNegativeSafeInteger(browserOmitted)
    || !Array.isArray(rawResources)
  ) {
    validation.invalid = true;
    return null;
  }
  const omittedEntryCount = browserOmitted + Math.max(0, rawResources.length - MAX_RESOURCES);
  if (!isNonNegativeSafeInteger(omittedEntryCount)) {
    validation.invalid = true;
    return null;
  }
  return Object.freeze({ bufferSize, bufferFull, retainedEntryCount, omittedEntryCount });
}

function selectedTelemetryHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).filter(([name]) => (
    TELEMETRY_HEADER_NAMES.has(name.toLowerCase())
  )).map(([name, value]) => [name.slice(0, MAX_TEXT_LENGTH), value.slice(0, MAX_TEXT_LENGTH)])));
}

function telemetryHeaderObservation(
  direction: TelemetryHeaderDirection,
  requestId: string,
  url: string,
  headers: HeaderEvidence,
): TelemetryHeaderEvidence | null {
  if (headers.status === 'FAILED') {
    return Object.freeze({
      direction,
      requestId: requestId.slice(0, MAX_ID_LENGTH),
      url: url.slice(0, MAX_URL_LENGTH),
      status: 'FAILED',
      errorText: headers.errorText.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    });
  }
  const values = selectedTelemetryHeaders(headers.values);
  return Object.keys(values).length === 0 ? null : Object.freeze({
    direction,
    requestId: requestId.slice(0, MAX_ID_LENGTH),
    url: url.slice(0, MAX_URL_LENGTH),
    status: 'OBSERVED',
    values,
  });
}

interface TelemetryFacts {
  readonly headers: readonly TelemetryHeaderEvidence[];
  readonly candidates: readonly Readonly<TelemetryCandidateEvidence>[];
  readonly omittedHeaderCount: number;
  readonly omittedCandidateCount: number;
}

function telemetryFacts(networkEvidence: ProjectedNetworkEvidence): TelemetryFacts {
  const allObservations: TelemetryHeaderEvidence[] = [];
  for (const request of networkEvidence.requests) {
    const observation = telemetryHeaderObservation(
      'REQUEST', request.requestId, request.url, request.headers,
    );
    if (observation !== null) allObservations.push(observation);
  }
  for (const response of networkEvidence.responses) {
    const observation = telemetryHeaderObservation(
      'RESPONSE', response.requestId, response.url, response.headers,
    );
    if (observation !== null) allObservations.push(observation);
  }
  const observations = allObservations.slice(0, MAX_TELEMETRY_HEADERS);

  // 候補の判定には、上限で記録しなかったヘッダの観測も使う。
  const headerNamesByRequest = new Map<string, string[]>();
  for (const observation of allObservations) {
    if (observation.status !== 'OBSERVED') continue;
    const names = headerNamesByRequest.get(observation.requestId) ?? [];
    const existing = new Set(names.map((name) => name.toLowerCase()));
    for (const name of Object.keys(observation.values)) {
      if (!existing.has(name.toLowerCase())) {
        names.push(name);
        existing.add(name.toLowerCase());
      }
    }
    headerNamesByRequest.set(observation.requestId, names);
  }

  const candidates: TelemetryCandidateEvidence[] = [];
  let omittedCandidateCount = 0;
  for (const request of networkEvidence.requests) {
    const matchedHeaderNames = headerNamesByRequest.get(request.requestId) ?? [];
    const lowerUrl = request.url.toLowerCase();
    const matchedHints = GENERIC_TELEMETRY_HINTS.filter((hint) => lowerUrl.includes(hint));
    const matchingBasis: TelemetryMatchingBasis[] = [];
    if (matchedHeaderNames.length > 0) matchingBasis.push('TRACE_OR_CORRELATION_HEADER');
    if (matchedHints.length > 0) matchingBasis.push('GENERIC_URL_HINT');
    if (matchingBasis.length === 0) continue;
    if (candidates.length >= MAX_TELEMETRY_CANDIDATES) {
      omittedCandidateCount += 1;
      continue;
    }
    candidates.push(Object.freeze({
      requestId: request.requestId.slice(0, MAX_ID_LENGTH),
      url: request.url.slice(0, MAX_URL_LENGTH),
      method: request.method.slice(0, MAX_TEXT_LENGTH),
      resourceType: request.resourceType.slice(0, MAX_TEXT_LENGTH),
      matchingBasis: Object.freeze(matchingBasis),
      matchedHeaderNames: Object.freeze([...matchedHeaderNames]),
      matchedHints: Object.freeze([...matchedHints]),
    }));
  }
  return Object.freeze({
    headers: Object.freeze(observations),
    candidates: Object.freeze(candidates),
    omittedHeaderCount: allObservations.length - observations.length,
    omittedCandidateCount,
  });
}

function browserSnapshot(limits: BrowserPerformanceLimits): unknown {
  const globalObject = globalThis as typeof globalThis & {
    __BEAKSIGHT_PERFORMANCE__?: unknown;
  };
  const pageState = globalObject.__BEAKSIGHT_PERFORMANCE__;
  const pageStateRecord = typeof pageState === 'object' && pageState !== null && !Array.isArray(pageState)
    ? pageState as Record<string, unknown>
    : undefined;
  const serverTimingOf = (entry: PerformanceResourceTiming) => {
    const serverTiming = Array.from(entry.serverTiming ?? []);
    return {
      serverTiming: serverTiming.slice(0, limits.maxServerTimingPerEntry).map((server) => ({
        name: server.name,
        description: server.description,
        duration: server.duration,
      })),
      omittedServerTimingCount: Math.max(0, serverTiming.length - limits.maxServerTimingPerEntry),
    };
  };
  const navigationEntries = performance.getEntriesByType('navigation').slice(0, 1).map((entry) => {
    const navigation = entry as PerformanceNavigationTiming;
    return {
      name: navigation.name,
      type: navigation.type,
      startTime: navigation.startTime,
      duration: navigation.duration,
      responseStart: navigation.responseStart,
      responseEnd: navigation.responseEnd,
      domContentLoadedEventStart: navigation.domContentLoadedEventStart,
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventStart: navigation.loadEventStart,
      loadEventEnd: navigation.loadEventEnd,
      transferSize: navigation.transferSize,
      encodedBodySize: navigation.encodedBodySize,
      decodedBodySize: navigation.decodedBodySize,
      ...serverTimingOf(navigation),
    };
  });
  const allResourceEntries = performance.getEntriesByType('resource');
  const resourceEntries = allResourceEntries.slice(0, limits.maxResourceTimingEntries).map((entry) => {
    const resource = entry as PerformanceResourceTiming;
    return {
      name: resource.name,
      initiatorType: resource.initiatorType,
      startTime: resource.startTime,
      duration: resource.duration,
      responseStart: resource.responseStart,
      responseEnd: resource.responseEnd,
      transferSize: resource.transferSize,
      encodedBodySize: resource.encodedBodySize,
      decodedBodySize: resource.decodedBodySize,
      ...serverTimingOf(resource),
    };
  });
  return {
    webVitals: pageStateRecord?.webVitals,
    webVitalsTextTruncated: pageStateRecord?.textTruncated,
    resourceBuffer: pageStateRecord?.resourceBuffer,
    navigationEntries,
    resourceEntries,
    omittedResourceEntryCount: allResourceEntries.length - resourceEntries.length,
  };
}

/** ブラウザの値を観測する前の事実。資源の集計と観測範囲は、0件ではなく `null`（未観測）にする。 */
function unobservedFacts(
  projected: ProjectedNetworkEvidence | null,
  telemetry: TelemetryFacts | null,
): PerformanceEvidenceFacts {
  return {
    webVitals: null,
    navigationTiming: null,
    resources: Object.freeze([]),
    resourceSummaries: null,
    resourceCoverage: null,
    serverTiming: Object.freeze([]),
    telemetryHeaders: telemetry?.headers ?? Object.freeze([]),
    telemetryCandidates: telemetry?.candidates ?? Object.freeze([]),
    truncation: projected === null || telemetry === null
      ? null
      : truncationFacts(projected, telemetry, null, false),
  };
}

function truncationFacts(
  projected: ProjectedNetworkEvidence,
  telemetry: TelemetryFacts,
  omittedServerTimingCount: number | null,
  browserTextTruncated: boolean,
): PerformanceTruncationEvidence {
  return Object.freeze({
    omittedServerTimingCount,
    omittedTelemetryHeaderCount: telemetry.omittedHeaderCount,
    omittedTelemetryCandidateCount: telemetry.omittedCandidateCount,
    omittedNetworkRequestCount: projected.omittedRequestCount,
    omittedNetworkResponseCount: projected.omittedResponseCount,
    textTruncated: projected.textTruncated || browserTextTruncated,
  });
}

function partial(
  reason: Extract<PerformanceEvidence, { readonly status: 'PARTIAL' }>['reason'],
  facts: PerformanceEvidenceFacts,
): PerformanceEvidence {
  return deepFreeze({ status: 'PARTIAL', reason, ...facts });
}

function completeBeforeDeadline(
  deadlineAtMs: number,
  facts: PerformanceEvidenceFacts,
): PerformanceEvidence {
  if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', facts);
  const complete = deepFreeze({ status: 'COMPLETE' as const, reason: 'COLLECTED' as const, ...facts });
  return Date.now() >= deadlineAtMs ? partial('DEADLINE_EXCEEDED', facts) : complete;
}

export class PerformanceCollector {
  async installBeforeNavigation(context: BrowserContext): Promise<void> {
    if (installedContexts.has(context)) return;
    const pending = pendingInstallations.get(context);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const installation = (async () => {
      const content = await createInitScript();
      await context.addInitScript({ content });
      installedContexts.add(context);
    })();
    pendingInstallations.set(context, installation);
    try {
      await installation;
    } finally {
      if (pendingInstallations.get(context) === installation) pendingInstallations.delete(context);
    }
  }

  async collect(
    page: Page,
    networkEvidence: NetworkEvidence,
    options: PerformanceCollectionOptions,
  ): Promise<PerformanceEvidence> {
    validateOptions(options);
    const deadlineAtMs = options.deadlineAtMs;
    const unavailable = unobservedFacts(null, null);
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', unavailable);
    const projectedNetwork = projectNetworkEvidence(networkEvidence, deadlineAtMs);
    if (projectedNetwork === DEADLINE || Date.now() >= deadlineAtMs) {
      return partial('DEADLINE_EXCEEDED', unavailable);
    }
    const telemetry = telemetryFacts(projectedNetwork);
    const empty = unobservedFacts(projectedNetwork, telemetry);
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', unavailable);

    const evaluated = await awaitBeforeDeadline(
      page.evaluate(browserSnapshot, BROWSER_PERFORMANCE_LIMITS),
      deadlineAtMs,
    );
    if (evaluated.status === 'REJECTED') {
      return Date.now() >= deadlineAtMs
        ? partial('DEADLINE_EXCEEDED', empty)
        : partial('EVALUATION_FAILED', empty);
    }
    if (evaluated.status === 'DEADLINE_EXCEEDED') return partial('DEADLINE_EXCEEDED', empty);

    const validation = createValidationState();
    const rawRecord = record(evaluated.value);
    if (rawRecord === null) {
      return partial('INVALID_BROWSER_DATA', empty);
    }
    const webVitals = normalizeWebVitals(rawRecord.webVitals, validation);
    const webVitalsTextTruncated = rawRecord.webVitalsTextTruncated;
    if (typeof webVitalsTextTruncated !== 'boolean') validation.invalid = true;
    const navigationTiming = normalizeNavigation(rawRecord.navigationEntries, validation);
    const resources = normalizeResources(
      rawRecord.resourceEntries,
      projectedNetwork.requests,
      documentOrigin(navigationTiming),
      validation,
    );
    const resourceCoverage = normalizeResourceCoverage(
      rawRecord,
      rawRecord.resourceEntries,
      resources.length,
      validation,
    );
    const allServerTiming = [
      ...(navigationTiming?.serverTiming ?? []),
      ...resources.flatMap((resource) => resource.serverTiming),
    ];
    const serverTiming = Object.freeze(allServerTiming.slice(0, MAX_SERVER_TIMING_TOTAL));
    addOmittedServerTiming(validation, allServerTiming.length - serverTiming.length);
    const facts: PerformanceEvidenceFacts = {
      webVitals,
      navigationTiming,
      resources,
      resourceSummaries: summarizeResources(resources, validation),
      resourceCoverage,
      serverTiming,
      telemetryHeaders: telemetry.headers,
      telemetryCandidates: telemetry.candidates,
      truncation: truncationFacts(
        projectedNetwork,
        telemetry,
        validation.omittedServerTimingCount,
        validation.textTruncated || (webVitals !== null && webVitalsTextTruncated === true),
      ),
    };
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', facts);
    if (validation.invalid) return partial('INVALID_BROWSER_DATA', facts);
    if (resourceCoverage !== null && (resourceCoverage.bufferFull || resourceCoverage.omittedEntryCount > 0)) {
      return partial('RESOURCE_LIMIT_REACHED', facts);
    }
    return completeBeforeDeadline(deadlineAtMs, facts);
  }
}
