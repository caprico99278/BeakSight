import { randomBytes } from 'node:crypto';
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
  PerformanceOperationsEvidence,
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
import { MAX_RESOURCE_TIMING_ENTRIES } from '../core/limits.js';
import { requestEndpointKeyOf } from '../core/request-endpoint-key.js';
import { watchCollection, type CollectorWatchOptions } from '../browser/collector-watch.js';

// LZ-2: ID と文の長さの上限（前の `MAX_ID_LENGTH` 256・`MAX_TEXT_LENGTH` 512）は撤廃した。
/** Resource Timing のバッファの大きさ（ページの `setResourceTimingBufferSize` に渡す）。L2: 記録の件数の上限には使わない。 */
const MAX_RESOURCES = MAX_RESOURCE_TIMING_ENTRIES;
// L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4、INV-LIMITS の表 A の N10・N11）: Server-Timing（1 件 20・合計 500）・計測のヘッダ（200）・
// 計測の候補（100）・写しの要求と応答とヘッダの欄の件数の上限は撤廃した（全部を記録する）。定数は LZ-1 で消した。

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
  /**
   * 収集の期限（`Date.now()` と同じ基準）。L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 省略すると期限を置かず、ブラウザの値の
   * 読み取りを進みの見張りで待つ（全く反応がない・静まらないときだけ、それまでの記録で `PARTIAL`）。渡したときの扱いは、呼ぶ側（L1）が渡さなく
   * なるまで今のまま残す。
   */
  readonly deadlineAtMs?: number | undefined;
  /** L2: 進みの見張りの指定（期限を渡さないときだけ使う）。 */
  readonly watch?: CollectorWatchOptions | undefined;
  /** AUD-6c: 測る前に BeakSight がページにした操作（記録に `operationsBeforeMeasurement` として残す。省略は記録しない）。 */
  readonly operationsBeforeMeasurement?: PerformanceOperationsEvidence | undefined;
  /** EV-1: scroll の段の前に読んだ LCP（`readLcpBeforeScroll`。記録に `lcpBeforeScroll` として残す。省略は記録しない）。 */
  readonly lcpBeforeScroll?: Readonly<WebVitalEvidence<LCPAttributionEvidence>> | undefined;
}

// Network Evidence の同期的な射影の途中で期限を過ぎたことを表す。
const DEADLINE = Symbol('deadline');

/**
 * ブラウザ内の処理に渡す値。ブラウザ内では import できないため、Node側の定数を引数で渡す。LZ-2: ID と文の長さの上限（前は 256・512）は渡さない
 * （切り詰めない）。
 */
interface BrowserPerformanceLimits {
  /** ページの Resource Timing のバッファの大きさ（L2: 記録の件数の上限ではない）。設計者の判断 2026-11-11: URL の長さの上限は渡さない（切り詰めない）。 */
  readonly maxResourceTimingEntries: number;
}

const BROWSER_PERFORMANCE_LIMITS: BrowserPerformanceLimits = Object.freeze({
  maxResourceTimingEntries: MAX_RESOURCES,
});

/**
 * L2: Resource Timing をどこから読んだか（ブラウザ内の値）。`OBSERVER` は、初期化のときに付けた `PerformanceObserver`（`buffered`）が受けた全部の
 * 項目（ページのバッファが満杯になっても、ページが消しても、受けた項目は残る）。`BUFFER` は、observer を付けられなかったときの、ページのバッファの
 * 項目（満杯なら欠けうる）。値がない（古い形）ときは `BUFFER` とみなす。
 */
const RESOURCE_SOURCE_OBSERVER = 'OBSERVER';

/** ブラウザ内の処理に渡す値の一覧。ブラウザ内では import できないため、core の配列を引数で渡す。 */
interface BrowserPerformanceValueLists {
  readonly webVitalNavigationTypes: readonly string[];
  readonly inpInteractionTypes: readonly string[];
}

const BROWSER_PERFORMANCE_VALUE_LISTS: BrowserPerformanceValueLists = Object.freeze({
  webVitalNavigationTypes: WEB_VITAL_NAVIGATION_TYPES,
  inpInteractionTypes: INP_INTERACTION_TYPES,
});

/** `PAGE_PERFORMANCE_STATE_PROPERTY` の乱数の bytes の数（16 進で 2 倍の文字数になる）。 */
const PAGE_PERFORMANCE_STATE_PROPERTY_RANDOM_BYTES = 8;

/**
 * Web Vitals の状態を置く、ページの main world の大域の名前（UPG-SW。ただ 1 つの作る所）。web-vitals は main world で動くので、状態は main world の
 * 大域に置き、`collect` の `page.evaluate` で読む。ページのスクリプトは大域の名前を読めるので、BeakSight や Collector だと推し量れる名前にしない
 * （ユーザーの方針）。名前は、プロセスごとの暗号の乱数（16 進。BeakSight の文字を作れない）で、初期化のスクリプトと `collect` に引数で渡す。
 */
export const PAGE_PERFORMANCE_STATE_PROPERTY: string = `_${randomBytes(PAGE_PERFORMANCE_STATE_PROPERTY_RANDOM_BYTES).toString('hex')}`;

function initializePerformanceState(
  library: unknown,
  limits: BrowserPerformanceLimits,
  valueLists: BrowserPerformanceValueLists,
  stateProperty: string,
): void {
  const { maxResourceTimingEntries } = limits;
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
  // L2: Resource Timing の項目は、observer で全部を受けて持つ（バッファの大きさで欠けない。件数の上限を置かない）。付けられなければ `null`。
  let resourceObserver: PerformanceObserver | null = null;
  const observedResources: PerformanceEntry[] = [];
  try {
    if (
      typeof PerformanceObserver === 'function'
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes('resource')
    ) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) observedResources.push(entry);
      });
      observer.observe({ type: 'resource', buffered: true });
      resourceObserver = observer;
    }
  } catch {
    resourceObserver = null;
  }
  // LZ-2: 文は切り詰めないので、いつも偽（前の形のために残す）。
  const textTruncated = false;
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
  const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const nonnegative = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  );
  const attributionFor = (name: string, value: unknown): Record<string, string | number> | null => {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, string | number> = {};
    const copyString = (key: string): void => {
      const normalized = stringOf(source[key]);
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
      // 設計者の判断 2026-11-11: URL は切り詰めない。
      if (typeof source.url === 'string') output.url = source.url;
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
      id: stringOf(candidate.id) ?? null,
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
    readonly observedResources: readonly PerformanceEntry[] | null;
  } => ({
    // L2: observer がまだ渡していない項目も取り出してから写す。
    observedResources: resourceObserver === null
      ? null
      : (() => {
        for (const entry of resourceObserver.takeRecords()) observedResources.push(entry);
        return observedResources.slice();
      })(),
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
  Object.defineProperty(globalThis, stateProperty, {
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
    + `${JSON.stringify(BROWSER_PERFORMANCE_VALUE_LISTS)}, ${JSON.stringify(PAGE_PERFORMANCE_STATE_PROPERTY)});`;
}

function validateOptions(options: PerformanceCollectionOptions): void {
  if (options.deadlineAtMs !== undefined && !Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Performance collection deadline must be finite');
  }
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

/** 設計者の判断 2026-11-11: URL は切り詰めない。LZ-2: ID と文も切り詰めない（文字列ならそのまま、ほかは `null`）。 */
function wholeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 設計者の判断 2026-11-11: URL の欄を、切り詰めずに写す（あれば）。 */
function copyOptionalWholeString(source: Record<string, unknown>, target: Record<string, string | number>, key: string): void {
  if (!(key in source)) return;
  const value = wholeString(source[key]);
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
    copyOptionalWholeString(source, target, 'largestShiftTarget');
    copyOptionalNumber(source, target, 'largestShiftTime', validation);
    copyOptionalNumber(source, target, 'largestShiftValue', validation);
    copyOptionalWholeString(source, target, 'loadState');
  } else if (name === 'LCP') {
    copyOptionalWholeString(source, target, 'target');
    copyOptionalWholeString(source, target, 'url');
    copyOptionalNumber(source, target, 'timeToFirstByte', validation);
    copyOptionalNumber(source, target, 'resourceLoadDelay', validation);
    copyOptionalNumber(source, target, 'resourceLoadDuration', validation);
    copyOptionalNumber(source, target, 'elementRenderDelay', validation);
  } else {
    copyOptionalWholeString(source, target, 'interactionTarget');
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
    copyOptionalWholeString(source, target, 'loadState');
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
  const id = wholeString(source.id);
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
  // L2: 1 件の項目の Server-Timing を全部記録する（ブラウザが省いたと報告した数だけを数える）。
  addOmittedServerTiming(validation, entry.omittedServerTimingCount);
  const output: ServerTimingEvidence[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    const name = wholeString(item?.name);
    const duration = nonnegative(item?.duration);
    if (item === null || name === null || duration === null) {
      validation.invalid = true;
      continue;
    }
    output.push(Object.freeze({
      source,
      url,
      name,
      description: wholeString(item.description) ?? '',
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
  const url = wholeString(item?.name);
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
    navigationType: wholeString(item.type) ?? '',
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
  /**
   * 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しをまとめた記録（`repeatedReads`）の、口（Origin と path）ごとの資源の種類（小文字。照らし合わせの
   * 鍵）。1 件の記録と照らし合わせられなかった Resource Timing の項目を分けるのに使う。
   */
  readonly repeatedReadTypes: ReadonlyMap<string, ReadonlySet<string>>;
  /** 上限のため読まなかったリクエストと response の件数。 */
  readonly omittedRequestCount: number;
  readonly omittedResponseCount: number;
  /** 前は、読んだ文字列のどれかを上限で切り詰めたか。LZ-2 で切り詰めなくなったので、いつも偽。 */
  readonly textTruncated: boolean;
}

/**
 * LZ-3b: 期限 `deadlineAtMs` を受けていて、その期限を過ぎたか（`undefined` は期限なしで、比べない。前は番兵の `Infinity` を渡していた）。
 */
const pastDeadline = (deadlineAtMs: number | undefined): boolean => deadlineAtMs !== undefined && Date.now() >= deadlineAtMs;

/** LZ-2: ID・method・資源の種類・ヘッダの値・失敗の文は切り詰めない（前は 256・512・2,048 まで）。 */
function projectHeaderEvidence(
  headers: HeaderEvidence,
  deadlineAtMs: number | undefined,
): HeaderEvidence | typeof DEADLINE {
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const status = headers.status;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  if (status === 'FAILED') {
    const errorText = headers.errorText;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    return Object.freeze({
      status: 'FAILED',
      errorText,
    });
  }
  const sourceValues = headers.values;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const values: Record<string, string> = {};
  const ownKeys = Reflect.ownKeys(sourceValues);
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  // L2: 欄の数の上限を置かない（全部の欄を見る）。
  for (const key of ownKeys) {
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(sourceValues, key);
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    if (descriptor === undefined || !descriptor.enumerable) continue;
    const normalizedName = key.toLowerCase();
    if (!TELEMETRY_HEADER_NAMES.has(normalizedName)) continue;
    const value = sourceValues[key];
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    if (typeof value === 'string') {
      values[key] = value;
    }
  }
  return pastDeadline(deadlineAtMs)
    ? DEADLINE
    : Object.freeze({ status: 'OBSERVED', values: Object.freeze(values) });
}

function projectNetworkEvidence(
  networkEvidence: NetworkEvidence,
  deadlineAtMs: number | undefined,
): ProjectedNetworkEvidence | typeof DEADLINE {
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const sourceRequests = networkEvidence.requests;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const sourceResponses = networkEvidence.responses;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const requestLength = sourceRequests.length;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  const responseLength = sourceResponses.length;
  if (pastDeadline(deadlineAtMs)) return DEADLINE;
  // L2: 件数の上限を置かない（全部の要求と応答を写す）。
  const requestLimit = requestLength;
  const responseLimit = responseLength;
  const requests: ProjectedNetworkRequest[] = [];
  const responses: ProjectedNetworkResponse[] = [];
  for (let index = 0; index < requestLimit; index += 1) {
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const source = sourceRequests[index];
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    if (source === undefined) continue;
    const requestId = source.requestId;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const rawUrl = source.url;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    // 設計者の判断 2026-11-11: URL は切り詰めず、長い URL も Resource Timing と照らし合わせる。
    const url = rawUrl;
    const correlationUrl = rawUrl;
    const method = source.method;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const resourceType = source.resourceType;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const correlationResourceType: string | null = resourceType.toLowerCase();
    const rawHeaders = source.headers;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
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
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
  }
  for (let index = 0; index < responseLimit; index += 1) {
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const source = sourceResponses[index];
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    if (source === undefined) continue;
    const requestId = source.requestId;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const rawUrl = source.url;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    // 設計者の判断 2026-11-11: URL は切り詰めない。
    const url = rawUrl;
    const rawHeaders = source.headers;
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
    const headers = projectHeaderEvidence(rawHeaders, deadlineAtMs);
    if (headers === DEADLINE) return DEADLINE;
    responses.push(Object.freeze({
      requestId,
      url,
      headers,
    }));
    if (pastDeadline(deadlineAtMs)) return DEADLINE;
  }
  const repeatedReadTypes = new Map<string, Set<string>>();
  for (const repeated of networkEvidence.repeatedReads ?? []) {
    const key = requestEndpointKeyOf(null, `${repeated.origin}${repeated.path}`);
    const types = repeatedReadTypes.get(key) ?? new Set<string>();
    types.add(repeated.resourceType.toLowerCase());
    repeatedReadTypes.set(key, types);
  }
  return Object.freeze({
    requests: Object.freeze(requests),
    responses: Object.freeze(responses),
    repeatedReadTypes,
    omittedRequestCount: requestLength - requestLimit,
    omittedResponseCount: responseLength - responseLimit,
    textTruncated: false,
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

/**
 * 設計者の判断 2026-11-11: Resource Timing の項目の URL の口（Origin と path）の、まとめた記録の資源の種類（小文字）。種類が 1 つに決まらない、文書の種類、
 * 始めた種類（`initiatorRequestType`）と合わない、URL を解析できない、まとめた記録がないときは `null`。
 */
function repeatedReadTypeOf(repeatedReadTypes: ReadonlyMap<string, ReadonlySet<string>>, rawUrl: string, initiatorType: string): string | null {
  if (repeatedReadTypes.size === 0) return null;
  // 口の鍵は、作り方の 1 か所（`requestEndpointKeyOf`。method は見ない）で作る。
  const types = repeatedReadTypes.get(requestEndpointKeyOf(null, rawUrl));
  if (types === undefined || types.size !== 1) return null;
  const [type] = types;
  if (type === undefined || type === 'document') return null;
  const exactRequestType = initiatorRequestType(initiatorType);
  return exactRequestType === null || exactRequestType === type ? type : null;
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
  repeatedReadTypes: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): readonly Readonly<ResourceTimingEvidence>[] {
  if (!Array.isArray(value)) {
    validation.invalid = true;
    return Object.freeze([]);
  }
  const queues = requestQueues(projectedRequests);
  const output: ResourceTimingEvidence[] = [];
  // L2: ブラウザが返した項目を全部記録する（件数の上限を置かない）。
  for (const candidate of value) {
    const item = record(candidate);
    const rawUrl = typeof item?.name === 'string' ? item.name : null;
    // 設計者の判断 2026-11-11: URL は切り詰めない。
    const url = rawUrl;
    const initiatorType = wholeString(item?.initiatorType);
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
    // 設計者の判断 2026-11-11: 1 件の記録と照らし合わせられなかったら、同じ口のまとめた記録の資源の種類で分ける（種類が 1 つに決まり、始めた種類と合うときだけ）。
    const repeatedType = request === undefined ? repeatedReadTypeOf(repeatedReadTypes, rawUrl, initiatorType) : null;
    const networkType = request === undefined ? repeatedType : request.correlationResourceType;
    const fromNetwork = networkType === null ? null : networkCategory(networkType);
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
      requestId: request === undefined ? null : request.requestId,
      networkResourceType: request === undefined ? repeatedType : request.resourceType,
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
  // L2: Node 側では捨てない。数えるのは、ブラウザが省いたと報告した数だけ。
  const omittedEntryCount = browserOmitted;
  return Object.freeze({ bufferSize, bufferFull, retainedEntryCount, omittedEntryCount });
}

function selectedTelemetryHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).filter(([name]) => (
    TELEMETRY_HEADER_NAMES.has(name.toLowerCase())
  ))));
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
      requestId,
      // 設計者の判断 2026-11-11: URL は切り詰めない。LZ-2: ID と失敗の文も切り詰めない。
      url,
      status: 'FAILED',
      errorText: headers.errorText,
    });
  }
  const values = selectedTelemetryHeaders(headers.values);
  return Object.keys(values).length === 0 ? null : Object.freeze({
    direction,
    requestId,
    url,
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
  // L2: 件数の上限を置かない（全部の観測を記録する）。
  const observations = allObservations;

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
  // L2: 候補の数の上限を置かない（数は常に 0）。
  const omittedCandidateCount = 0;
  for (const request of networkEvidence.requests) {
    const matchedHeaderNames = headerNamesByRequest.get(request.requestId) ?? [];
    const lowerUrl = request.url.toLowerCase();
    const matchedHints = GENERIC_TELEMETRY_HINTS.filter((hint) => lowerUrl.includes(hint));
    const matchingBasis: TelemetryMatchingBasis[] = [];
    if (matchedHeaderNames.length > 0) matchingBasis.push('TRACE_OR_CORRELATION_HEADER');
    if (matchedHints.length > 0) matchingBasis.push('GENERIC_URL_HINT');
    if (matchingBasis.length === 0) continue;
    candidates.push(Object.freeze({
      requestId: request.requestId,
      url: request.url,
      method: request.method,
      resourceType: request.resourceType,
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

/** `browserSnapshot` に渡す値（ブラウザ内では import できないため、引数で渡す）。 */
interface BrowserSnapshotInput {
  readonly limits: BrowserPerformanceLimits;
  /** Web Vitals の状態の大域の名前（`PAGE_PERFORMANCE_STATE_PROPERTY`）。 */
  readonly stateProperty: string;
}

function browserSnapshot({ limits, stateProperty }: BrowserSnapshotInput): unknown {
  const pageState: unknown = (globalThis as unknown as Record<string, unknown>)[stateProperty];
  const pageStateRecord = typeof pageState === 'object' && pageState !== null && !Array.isArray(pageState)
    ? pageState as Record<string, unknown>
    : undefined;
  // L2: Server-Timing は、1 件の項目のものも全部を写す（件数の上限を置かない）。
  const serverTimingOf = (entry: PerformanceResourceTiming) => {
    const serverTiming = Array.from(entry.serverTiming ?? []);
    return {
      serverTiming: serverTiming.map((server) => ({
        name: server.name,
        description: server.description,
        duration: server.duration,
      })),
      omittedServerTimingCount: 0,
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
  // L2: observer が受けた全部の項目（なければ、ページのバッファの項目）を、件数の上限なしに写す。
  const observed = pageStateRecord?.observedResources;
  const allResourceEntries: readonly PerformanceEntry[] = Array.isArray(observed)
    ? observed as PerformanceEntry[]
    : performance.getEntriesByType('resource');
  const resourceEntries = allResourceEntries.map((entry) => {
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
    resourceSource: Array.isArray(observed) ? 'OBSERVER' : 'BUFFER',
    omittedResourceEntryCount: 0,
    // AUD-6c: 観測の時間（文書の読み込みの始まりから、今まで）。
    observedAtMs: performance.now(),
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
  deadlineAtMs: number | undefined,
  facts: PerformanceEvidenceFacts,
): PerformanceEvidence {
  if (pastDeadline(deadlineAtMs)) return partial('DEADLINE_EXCEEDED', facts);
  const complete = deepFreeze({ status: 'COMPLETE' as const, reason: 'COLLECTED' as const, ...facts });
  return pastDeadline(deadlineAtMs) ? partial('DEADLINE_EXCEEDED', facts) : complete;
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

  /**
   * EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1・2 章）: scroll の段の前に、ページの中の Web Vitals の状態から LCP だけを読む（読み込み
   * 直しも測り直しもしない。1 回の読み取り）。スクロールで後から描かれた塊が LCP に数えられる前の値を、`collect` の `lcpBeforeScroll` に渡すため。init script が
   * 入っていない・形が違う・読めないときは `undefined`。
   */
  async readLcpBeforeScroll(page: Page): Promise<Readonly<WebVitalEvidence<LCPAttributionEvidence>> | undefined> {
    try {
      const raw = await page.evaluate((stateProperty: string): unknown => {
        const state: unknown = (globalThis as unknown as Record<string, unknown>)[stateProperty];
        const vitals: unknown = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)['webVitals'] : undefined;
        return typeof vitals === 'object' && vitals !== null ? (vitals as Record<string, unknown>)['LCP'] : undefined;
      }, PAGE_PERFORMANCE_STATE_PROPERTY);
      if (raw === undefined) {
        return undefined;
      }
      const validation = createValidationState();
      const vital = normalizeVital<LCPAttributionEvidence>('LCP', raw, validation);
      return validation.invalid ? undefined : deepFreeze(vital);
    } catch {
      return undefined;
    }
  }

  async collect(
    page: Page,
    networkEvidence: NetworkEvidence,
    options: PerformanceCollectionOptions = {},
  ): Promise<PerformanceEvidence> {
    validateOptions(options);
    // L2・LZ-3b: 期限を渡さなければ、期限は比べない（`pastDeadline`。前は番兵の `Infinity`）。ブラウザの読み取りは進みの見張りで待つ。
    const { deadlineAtMs } = options;
    const watched = deadlineAtMs === undefined;
    const unavailable = unobservedFacts(null, null);
    if (pastDeadline(deadlineAtMs)) return partial('DEADLINE_EXCEEDED', unavailable);
    const projectedNetwork = projectNetworkEvidence(networkEvidence, deadlineAtMs);
    if (projectedNetwork === DEADLINE || pastDeadline(deadlineAtMs)) {
      return partial('DEADLINE_EXCEEDED', unavailable);
    }
    const telemetry = telemetryFacts(projectedNetwork);
    const empty = unobservedFacts(projectedNetwork, telemetry);
    if (pastDeadline(deadlineAtMs)) return partial('DEADLINE_EXCEEDED', unavailable);

    const snapshotInput: BrowserSnapshotInput = { limits: BROWSER_PERFORMANCE_LIMITS, stateProperty: PAGE_PERFORMANCE_STATE_PROPERTY };
    let evaluated: Readonly<{ status: 'FULFILLED'; value: unknown }>;
    if (watched) {
      // L2: 期限を置かず、進みの見張りで待つ。見張りが終えたら、写した network の事実（telemetry）を残した `PARTIAL`。
      const outcome = await watchCollection(
        page,
        (signals) => signals.track(page.evaluate(browserSnapshot, snapshotInput)),
        options.watch ?? {},
      );
      if (outcome.status === 'ENDED') return partial(outcome.end, empty);
      if (outcome.status === 'REJECTED') return partial('EVALUATION_FAILED', empty);
      evaluated = outcome;
    } else {
      const read = await awaitBeforeDeadline(page.evaluate(browserSnapshot, snapshotInput), deadlineAtMs);
      if (read.status === 'REJECTED') {
        return pastDeadline(deadlineAtMs)
          ? partial('DEADLINE_EXCEEDED', empty)
          : partial('EVALUATION_FAILED', empty);
      }
      if (read.status === 'DEADLINE_EXCEEDED') return partial('DEADLINE_EXCEEDED', empty);
      evaluated = read;
    }

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
      projectedNetwork.repeatedReadTypes,
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
    // L2: 合計の件数の上限を置かない。
    const serverTiming = Object.freeze(allServerTiming);
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
      // AUD-6c: 観測の時間（読めない値は `null`）と、呼び出し側が渡した、測る前の操作。
      observedForMs: nonnegative(rawRecord.observedAtMs),
      ...(options.operationsBeforeMeasurement === undefined ? {} : { operationsBeforeMeasurement: { ...options.operationsBeforeMeasurement } }),
      ...(options.lcpBeforeScroll === undefined ? {} : { lcpBeforeScroll: options.lcpBeforeScroll }),
    };
    if (pastDeadline(deadlineAtMs)) return partial('DEADLINE_EXCEEDED', facts);
    if (validation.invalid) return partial('INVALID_BROWSER_DATA', facts);
    // L2: observer が全部を受けたときは、ページのバッファが満杯でも欠けない。バッファから読んだとき（observer を付けられなかった）だけ、満杯を欠けとする。
    const bufferLoss = rawRecord.resourceSource !== RESOURCE_SOURCE_OBSERVER && resourceCoverage?.bufferFull === true;
    if (resourceCoverage !== null && (bufferLoss || resourceCoverage.omittedEntryCount > 0)) {
      return partial('RESOURCE_LIMIT_REACHED', facts);
    }
    return completeBeforeDeadline(deadlineAtMs, facts);
  }
}
