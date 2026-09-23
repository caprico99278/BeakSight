import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import type { HeaderEvidence, NetworkEvidence } from './network-collector.js';

const MAX_URL_LENGTH = 2_048;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 512;
const MAX_RESOURCES = 500;
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

export type WebVitalStatus = 'OBSERVED' | 'NOT_OBSERVED' | 'UNSUPPORTED';
export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';
export type WebVitalNavigationType =
  | 'navigate'
  | 'reload'
  | 'back-forward'
  | 'back-forward-cache'
  | 'prerender'
  | 'restore'
  | 'soft-navigation';

export interface CLSAttributionEvidence {
  readonly largestShiftTarget?: string;
  readonly largestShiftTime?: number;
  readonly largestShiftValue?: number;
  readonly loadState?: string;
}

export interface LCPAttributionEvidence {
  readonly target?: string;
  readonly url?: string;
  readonly timeToFirstByte?: number;
  readonly resourceLoadDelay?: number;
  readonly resourceLoadDuration?: number;
  readonly elementRenderDelay?: number;
}

export interface INPAttributionEvidence {
  readonly interactionTarget?: string;
  readonly interactionTime?: number;
  readonly interactionType?: 'pointer' | 'keyboard';
  readonly nextPaintTime?: number;
  readonly inputDelay?: number;
  readonly processingDuration?: number;
  readonly presentationDelay?: number;
  readonly loadState?: string;
}

export type WebVitalEvidence<TAttribution> = Readonly<{
  readonly status: 'OBSERVED';
  readonly value: number;
  readonly id: string | null;
  readonly rating: WebVitalRating | null;
  readonly navigationType: WebVitalNavigationType | null;
  readonly attribution: Readonly<TAttribution> | null;
}> | Readonly<{
  readonly status: 'NOT_OBSERVED' | 'UNSUPPORTED';
  readonly value: null;
  readonly id: null;
  readonly rating: null;
  readonly navigationType: null;
  readonly attribution: null;
}>;

export interface WebVitalsEvidence {
  readonly CLS: WebVitalEvidence<CLSAttributionEvidence>;
  readonly FCP: WebVitalEvidence<never>;
  readonly INP: WebVitalEvidence<INPAttributionEvidence>;
  readonly LCP: WebVitalEvidence<LCPAttributionEvidence>;
  readonly TTFB: WebVitalEvidence<never>;
}

export interface ServerTimingEvidence {
  readonly source: 'NAVIGATION' | 'RESOURCE';
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly duration: number;
}

export interface NavigationTimingEvidence {
  readonly url: string;
  readonly navigationType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly domContentLoadedEventStart: number;
  readonly domContentLoadedEventEnd: number;
  readonly loadEventStart: number;
  readonly loadEventEnd: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
}

export type ResourceCategory = 'script' | 'stylesheet' | 'image' | 'fetch-xhr';
export type ResourceCategoryBasis = 'NETWORK_EVIDENCE' | 'INITIATOR_TYPE' | 'UNKNOWN';

export interface ResourceTimingEvidence {
  readonly url: string;
  readonly initiatorType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  readonly requestId: string | null;
  readonly networkResourceType: string | null;
  readonly category: ResourceCategory | null;
  readonly categoryBasis: ResourceCategoryBasis;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
}

export interface ResourceSummaryEvidence {
  readonly count: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
}

export interface ResourceSummariesEvidence {
  readonly script: Readonly<ResourceSummaryEvidence>;
  readonly stylesheet: Readonly<ResourceSummaryEvidence>;
  readonly image: Readonly<ResourceSummaryEvidence>;
  readonly 'fetch-xhr': Readonly<ResourceSummaryEvidence>;
}

export type TelemetryHeaderEvidence = Readonly<{
  readonly direction: 'REQUEST' | 'RESPONSE';
  readonly requestId: string;
  readonly url: string;
  readonly status: 'OBSERVED';
  readonly values: Readonly<Record<string, string>>;
}> | Readonly<{
  readonly direction: 'REQUEST' | 'RESPONSE';
  readonly requestId: string;
  readonly url: string;
  readonly status: 'FAILED';
  readonly errorText: string;
}>;

export interface TelemetryCandidateEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly matchingBasis: readonly ('TRACE_OR_CORRELATION_HEADER' | 'GENERIC_URL_HINT')[];
  readonly matchedHeaderNames: readonly string[];
  readonly matchedHints: readonly string[];
}

interface PerformanceEvidenceFacts {
  readonly webVitals: Readonly<WebVitalsEvidence> | null;
  readonly navigationTiming: Readonly<NavigationTimingEvidence> | null;
  readonly resources: readonly Readonly<ResourceTimingEvidence>[];
  readonly resourceSummaries: Readonly<ResourceSummariesEvidence> | null;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
  readonly telemetryHeaders: readonly TelemetryHeaderEvidence[];
  readonly telemetryCandidates: readonly Readonly<TelemetryCandidateEvidence>[];
}

export type PerformanceEvidence = Readonly<PerformanceEvidenceFacts & {
  readonly status: 'COMPLETE';
  readonly reason: 'COLLECTED';
}> | Readonly<PerformanceEvidenceFacts & {
  readonly status: 'PARTIAL';
  readonly reason: 'DEADLINE_EXCEEDED' | 'EVALUATION_FAILED' | 'INVALID_BROWSER_DATA';
}>;

export interface PerformanceCollectionOptions {
  readonly deadlineAtMs: number;
}

type OperationOutcome<T> =
  | { readonly status: 'FULFILLED'; readonly value: T }
  | { readonly status: 'REJECTED'; readonly reason: unknown };

const DEADLINE = Symbol('deadline');

function initializePerformanceState(library: unknown): void {
  const maxIdLength = 256;
  const maxTextLength = 512;
  const maxUrlLength = 2_048;
  const supportedEntries = new Set(
    typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes
      : [],
  );
  const blank = (status: 'NOT_OBSERVED' | 'UNSUPPORTED') => ({
    status,
    value: null,
    id: null,
    rating: null,
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
  const boundedString = (value: unknown, maxLength: number): string | undefined => (
    typeof value === 'string' ? value.slice(0, maxLength) : undefined
  );
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
      if (source.interactionType === 'pointer' || source.interactionType === 'keyboard') {
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
  const report = (name: string, metric: unknown): void => {
    if (typeof metric !== 'object' || metric === null) return;
    const candidate = metric as Record<string, unknown>;
    const value = nonnegative(candidate.value);
    if (value === undefined) return;
    const rating = candidate.rating === 'good'
      || candidate.rating === 'needs-improvement'
      || candidate.rating === 'poor'
      ? candidate.rating
      : null;
    const navigationTypes = new Set([
      'navigate', 'reload', 'back-forward', 'back-forward-cache', 'prerender', 'restore', 'soft-navigation',
    ]);
    state[name] = {
      status: 'OBSERVED',
      value,
      id: boundedString(candidate.id, maxIdLength) ?? null,
      rating,
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

  const snapshot = (): { readonly webVitals: Record<string, Record<string, unknown>> } => ({
    webVitals: Object.fromEntries(Object.entries(state).map(([name, metric]) => [
      name,
      {
        ...metric,
        attribution: typeof metric.attribution === 'object' && metric.attribution !== null
          ? { ...(metric.attribution as Record<string, unknown>) }
          : null,
      },
    ])),
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
  return `${bundle}\n;(${initializePerformanceState.toString()})(typeof webVitals === 'object' ? webVitals : undefined);`;
}

function validateOptions(options: PerformanceCollectionOptions): void {
  if (!Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Performance collection deadline must be finite');
  }
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T | typeof DEADLINE> {
  const outcome = operation.then<OperationOutcome<T>, OperationOutcome<T>>(
    (value) => ({ status: 'FULFILLED', value }),
    (reason: unknown) => ({ status: 'REJECTED', reason }),
  );
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return DEADLINE;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      outcome,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), remainingMs);
      }),
    ]);
    if (result === DEADLINE || Date.now() >= deadlineAtMs) {
      return DEADLINE;
    }
    if (result.status === 'REJECTED') {
      throw result.reason;
    }
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' ? value.slice(0, maximum) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function emptyVital(status: 'NOT_OBSERVED' | 'UNSUPPORTED' = 'NOT_OBSERVED'): WebVitalEvidence<never> {
  return Object.freeze({
    status,
    value: null,
    id: null,
    rating: null,
    navigationType: null,
    attribution: null,
  });
}

interface ValidationState {
  invalid: boolean;
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, string | number>,
  key: string,
  maximum = MAX_TEXT_LENGTH,
): void {
  if (!(key in source)) return;
  const value = boundedString(source[key], maximum);
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
    copyOptionalString(source, target, 'largestShiftTarget');
    copyOptionalNumber(source, target, 'largestShiftTime', validation);
    copyOptionalNumber(source, target, 'largestShiftValue', validation);
    copyOptionalString(source, target, 'loadState');
  } else if (name === 'LCP') {
    copyOptionalString(source, target, 'target');
    copyOptionalString(source, target, 'url', MAX_URL_LENGTH);
    copyOptionalNumber(source, target, 'timeToFirstByte', validation);
    copyOptionalNumber(source, target, 'resourceLoadDelay', validation);
    copyOptionalNumber(source, target, 'resourceLoadDuration', validation);
    copyOptionalNumber(source, target, 'elementRenderDelay', validation);
  } else {
    copyOptionalString(source, target, 'interactionTarget');
    copyOptionalNumber(source, target, 'interactionTime', validation);
    if ('interactionType' in source) {
      if (source.interactionType === 'pointer' || source.interactionType === 'keyboard') {
        target.interactionType = source.interactionType;
      }
    }
    copyOptionalNumber(source, target, 'nextPaintTime', validation);
    copyOptionalNumber(source, target, 'inputDelay', validation);
    copyOptionalNumber(source, target, 'processingDuration', validation);
    copyOptionalNumber(source, target, 'presentationDelay', validation);
    copyOptionalString(source, target, 'loadState');
  }
  return Object.keys(target).length === 0 ? null : Object.freeze(target);
}

function normalizeVital<TAttribution>(
  name: keyof WebVitalsEvidence,
  value: unknown,
  validation: ValidationState,
): WebVitalEvidence<TAttribution> {
  const source = record(value);
  if (source?.status === 'UNSUPPORTED' || source?.status === 'NOT_OBSERVED') {
    if (
      source.value !== null
      || source.id !== null
      || source.rating !== null
      || source.navigationType !== null
      || source.attribution !== null
    ) {
      validation.invalid = true;
    }
    return emptyVital(source.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'NOT_OBSERVED');
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
  const rating = source.rating === 'good'
    || source.rating === 'needs-improvement'
    || source.rating === 'poor'
    ? source.rating
    : source.rating === null
      ? null
      : (validation.invalid = true, null);
  const navigationType = source.navigationType === 'navigate'
    || source.navigationType === 'reload'
    || source.navigationType === 'back-forward'
    || source.navigationType === 'back-forward-cache'
    || source.navigationType === 'prerender'
    || source.navigationType === 'restore'
    || source.navigationType === 'soft-navigation'
    ? source.navigationType
    : source.navigationType === null
      ? null
      : (validation.invalid = true, null);
  const id = boundedString(source.id, MAX_ID_LENGTH);
  if (source.id !== null && id === null) validation.invalid = true;
  return Object.freeze({
    status: 'OBSERVED',
    value: metricValue,
    id,
    rating,
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
  const vitalValidation: ValidationState = { invalid: false };
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
  return normalized;
}

function normalizeServerTiming(
  value: unknown,
  source: 'NAVIGATION' | 'RESOURCE',
  url: string,
  validation: ValidationState,
): readonly Readonly<ServerTimingEvidence>[] {
  if (!Array.isArray(value)) {
    validation.invalid = true;
    return Object.freeze([]);
  }
  const output: ServerTimingEvidence[] = [];
  for (const candidate of value.slice(0, MAX_SERVER_TIMING_PER_ENTRY)) {
    const item = record(candidate);
    const name = boundedString(item?.name, MAX_TEXT_LENGTH);
    const duration = nonnegative(item?.duration);
    if (item === null || name === null || duration === null) {
      validation.invalid = true;
      continue;
    }
    output.push(Object.freeze({
      source,
      url,
      name,
      description: boundedString(item.description, MAX_TEXT_LENGTH) ?? '',
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
  const url = boundedString(item?.name, MAX_URL_LENGTH);
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
    navigationType: boundedString(item.type, MAX_TEXT_LENGTH) ?? '',
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
    serverTiming: normalizeServerTiming(item.serverTiming, 'NAVIGATION', url, validation),
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
}

function projectHeaderEvidence(headers: HeaderEvidence, deadlineAtMs: number): HeaderEvidence | typeof DEADLINE {
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  const status = headers.status;
  if (Date.now() >= deadlineAtMs) return DEADLINE;
  if (status === 'FAILED') {
    const rawErrorText = headers.errorText;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const errorText = rawErrorText.slice(0, MAX_TEXT_LENGTH);
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
      values[key] = value.slice(0, MAX_TEXT_LENGTH);
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
  for (let index = 0; index < requestLimit; index += 1) {
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const source = sourceRequests[index];
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    if (source === undefined) continue;
    const rawRequestId = source.requestId;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const requestId = rawRequestId.slice(0, MAX_ID_LENGTH);
    const rawUrl = source.url;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const url = rawUrl.slice(0, MAX_URL_LENGTH);
    const correlationUrl = rawUrl.length <= MAX_URL_LENGTH ? rawUrl : null;
    const rawMethod = source.method;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const method = rawMethod.slice(0, MAX_TEXT_LENGTH);
    const rawResourceType = source.resourceType;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const resourceType = rawResourceType.slice(0, MAX_TEXT_LENGTH);
    let correlationResourceType: string | null = null;
    if (rawResourceType.length <= MAX_TEXT_LENGTH) {
      const normalizedResourceType = rawResourceType.toLowerCase();
      if (normalizedResourceType.length <= MAX_TEXT_LENGTH) correlationResourceType = normalizedResourceType;
    }
    const rawHeaders = source.headers;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const headers = projectHeaderEvidence(rawHeaders, deadlineAtMs);
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
    const requestId = rawRequestId.slice(0, MAX_ID_LENGTH);
    const rawUrl = source.url;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const url = rawUrl.slice(0, MAX_URL_LENGTH);
    const rawHeaders = source.headers;
    if (Date.now() >= deadlineAtMs) return DEADLINE;
    const headers = projectHeaderEvidence(rawHeaders, deadlineAtMs);
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

function normalizeResources(
  value: unknown,
  projectedRequests: readonly ProjectedNetworkRequest[],
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
    const url = boundedString(rawUrl, MAX_URL_LENGTH);
    const initiatorType = boundedString(item?.initiatorType, MAX_TEXT_LENGTH);
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
    output.push(Object.freeze({
      url,
      initiatorType,
      startTime: numbers.startTime as number,
      duration: numbers.duration as number,
      responseStart: numbers.responseStart as number,
      responseEnd: numbers.responseEnd as number,
      transferSize: numbers.transferSize as number,
      encodedBodySize: numbers.encodedBodySize as number,
      decodedBodySize: numbers.decodedBodySize as number,
      requestId: request === undefined ? null : boundedString(request.requestId, MAX_ID_LENGTH),
      networkResourceType: request === undefined ? null : boundedString(request.resourceType, MAX_TEXT_LENGTH),
      category,
      categoryBasis,
      serverTiming: normalizeServerTiming(item.serverTiming, 'RESOURCE', url, validation),
    }));
  }
  return Object.freeze(output);
}

function emptySummary(): ResourceSummaryEvidence {
  return { count: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 };
}

function summarizeResources(
  resources: readonly ResourceTimingEvidence[],
  validation?: ValidationState,
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
    const next = {
      count: previous.count + 1,
      transferSize: previous.transferSize + resource.transferSize,
      encodedBodySize: previous.encodedBodySize + resource.encodedBodySize,
      decodedBodySize: previous.decodedBodySize + resource.decodedBodySize,
    };
    if (Object.values(next).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      if (validation !== undefined) validation.invalid = true;
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

function emptyResourceSummaries(): ResourceSummariesEvidence {
  return summarizeResources([]) as ResourceSummariesEvidence;
}

function selectedTelemetryHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).filter(([name]) => (
    TELEMETRY_HEADER_NAMES.has(name.toLowerCase())
  )).map(([name, value]) => [name.slice(0, MAX_TEXT_LENGTH), value.slice(0, MAX_TEXT_LENGTH)])));
}

function telemetryHeaderObservation(
  direction: 'REQUEST' | 'RESPONSE',
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
      errorText: headers.errorText.slice(0, MAX_TEXT_LENGTH),
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
}

function emptyTelemetryFacts(): TelemetryFacts {
  return Object.freeze({
    headers: Object.freeze([]),
    candidates: Object.freeze([]),
  });
}

function telemetryFacts(networkEvidence: ProjectedNetworkEvidence): TelemetryFacts {
  const observations: TelemetryHeaderEvidence[] = [];
  for (const request of networkEvidence.requests) {
    const observation = telemetryHeaderObservation(
      'REQUEST', request.requestId, request.url, request.headers,
    );
    if (observation !== null && observations.length < MAX_TELEMETRY_HEADERS) observations.push(observation);
  }
  for (const response of networkEvidence.responses) {
    const observation = telemetryHeaderObservation(
      'RESPONSE', response.requestId, response.url, response.headers,
    );
    if (observation !== null && observations.length < MAX_TELEMETRY_HEADERS) observations.push(observation);
  }

  const headerNamesByRequest = new Map<string, string[]>();
  for (const observation of observations) {
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
  for (const request of networkEvidence.requests) {
    if (candidates.length >= MAX_TELEMETRY_CANDIDATES) break;
    const matchedHeaderNames = headerNamesByRequest.get(request.requestId) ?? [];
    const lowerUrl = request.url.toLowerCase();
    const matchedHints = GENERIC_TELEMETRY_HINTS.filter((hint) => lowerUrl.includes(hint));
    const matchingBasis: ('TRACE_OR_CORRELATION_HEADER' | 'GENERIC_URL_HINT')[] = [];
    if (matchedHeaderNames.length > 0) matchingBasis.push('TRACE_OR_CORRELATION_HEADER');
    if (matchedHints.length > 0) matchingBasis.push('GENERIC_URL_HINT');
    if (matchingBasis.length === 0) continue;
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
  });
}

function browserSnapshot(): unknown {
  const globalObject = globalThis as typeof globalThis & {
    __BEAKSIGHT_PERFORMANCE__?: unknown;
  };
  const pageState = globalObject.__BEAKSIGHT_PERFORMANCE__;
  const pageStateRecord = typeof pageState === 'object' && pageState !== null && !Array.isArray(pageState)
    ? pageState as Record<string, unknown>
    : undefined;
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
      serverTiming: Array.from(navigation.serverTiming ?? []).slice(0, 20).map((server) => ({
        name: server.name,
        description: server.description,
        duration: server.duration,
      })),
    };
  });
  const resourceEntries = performance.getEntriesByType('resource').slice(0, 500).map((entry) => {
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
      serverTiming: Array.from(resource.serverTiming ?? []).slice(0, 20).map((server) => ({
        name: server.name,
        description: server.description,
        duration: server.duration,
      })),
    };
  });
  return {
    webVitals: pageStateRecord?.webVitals,
    navigationEntries,
    resourceEntries,
  };
}

function emptyFacts(telemetry: TelemetryFacts): PerformanceEvidenceFacts {
  const resources = Object.freeze([]) as readonly ResourceTimingEvidence[];
  return {
    webVitals: null,
    navigationTiming: null,
    resources,
    resourceSummaries: emptyResourceSummaries(),
    serverTiming: Object.freeze([]),
    telemetryHeaders: telemetry.headers,
    telemetryCandidates: telemetry.candidates,
  };
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
    const unavailable = emptyFacts(emptyTelemetryFacts());
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', unavailable);
    const projectedNetwork = projectNetworkEvidence(networkEvidence, deadlineAtMs);
    if (projectedNetwork === DEADLINE || Date.now() >= deadlineAtMs) {
      return partial('DEADLINE_EXCEEDED', unavailable);
    }
    const telemetry = telemetryFacts(projectedNetwork);
    const empty = emptyFacts(telemetry);
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', unavailable);

    let raw: unknown | typeof DEADLINE;
    try {
      raw = await beforeDeadline(page.evaluate(browserSnapshot), deadlineAtMs);
    } catch {
      return Date.now() >= deadlineAtMs
        ? partial('DEADLINE_EXCEEDED', empty)
        : partial('EVALUATION_FAILED', empty);
    }
    if (raw === DEADLINE) return partial('DEADLINE_EXCEEDED', empty);

    const validation: ValidationState = { invalid: false };
    const rawRecord = record(raw);
    if (rawRecord === null) {
      return partial('INVALID_BROWSER_DATA', empty);
    }
    const webVitals = normalizeWebVitals(rawRecord.webVitals, validation);
    const navigationTiming = normalizeNavigation(rawRecord.navigationEntries, validation);
    const resources = normalizeResources(rawRecord.resourceEntries, projectedNetwork.requests, validation);
    const serverTiming = Object.freeze([
      ...(navigationTiming?.serverTiming ?? []),
      ...resources.flatMap((resource) => resource.serverTiming),
    ].slice(0, MAX_SERVER_TIMING_TOTAL));
    const facts: PerformanceEvidenceFacts = {
      webVitals,
      navigationTiming,
      resources,
      resourceSummaries: summarizeResources(resources, validation),
      serverTiming,
      telemetryHeaders: telemetry.headers,
      telemetryCandidates: telemetry.candidates,
    };
    if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', facts);
    return validation.invalid
      ? partial('INVALID_BROWSER_DATA', facts)
      : completeBeforeDeadline(deadlineAtMs, facts);
  }
}
