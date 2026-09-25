import type { Page } from 'playwright';
import type { PartialFailureReason } from '../core/contracts.js';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';
import {
  SCROLL_TARGETS,
  type InnerScrollScanEvidence,
  type ScrollEvidence,
  type ScrollIncompleteReason,
  type ScrollObservationEvidence,
  type ScrollPosition,
  type ScrollRestorationEvidence,
  type ScrollTargetEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger, isPositiveFiniteNumber, isRecord } from '../core/guards.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { pageFailureReason } from './page-failure.js';

export interface ControlledScrollOptions {
  readonly deadlineAtMs: number;
  readonly stepViewportFraction: number;
  readonly stepWaitMs: number;
  readonly stableWindowMs: number;
}

// 結果の型の定義は `src/core/evidence-types.ts` に1か所だけ置き、ここでは型の別名として公開する（R'2 の I-2）。

/** 文書をスクロールする要素（定義と選び方は `ScrollTargetEvidence`）。 */
export type ScrollTarget = ScrollTargetEvidence;

/** controlled scroll の1回の測定（定義は `ScrollObservationEvidence`）。 */
export type ScrollObservation = ScrollObservationEvidence;

/** 内側のスクロール領域を探した結果（定義は `InnerScrollScanEvidence`）。 */
export type InnerScrollScan = InnerScrollScanEvidence;

/** controlled scroll が `PARTIAL` を返す理由（定義は `ScrollIncompleteReason`）。 */
export type ControlledScrollPartialReason = ScrollIncompleteReason;

/** 終了時に文書の先頭（0, 0）へ戻せたかどうか（定義は `ScrollRestorationEvidence`）。 */
export type ScrollOriginRestoration = ScrollRestorationEvidence;

/** controlled scroll の結果。scroll の Evidence の payload（定義は `ScrollEvidence`）。 */
export type ScrollResult = ScrollEvidence;

/** スクロール位置と高さを比べるときの許容誤差（CSSピクセル）。 */
const SCROLL_EPSILON_PX = 1;
const MAX_STEP_VIEWPORT_FRACTION = 0.9;
/**
 * 内側のスクロール領域を探すときに調べる要素の最大数（open な shadow root の中の要素を含む）。
 * 超えた場合は `scanLimitReached` を記録する。
 */
const MAX_INNER_SCROLL_SCAN_ELEMENTS = 16_384;
/** 完了と判定する前の測り直しで、文書と body のうち大きいほうが変わっていた場合に、対象を切り替える最大の回数。 */
const MAX_SCROLL_TARGET_SWITCHES = 1;
/**
 * scroll の Evidence に記録する測定（`observations`）の最大件数（設計書 foundation-corrections 5.8）。
 * 期限まで高さが増え続けるページや、待ち時間の短い設定でも、Evidence の大きさを抑える。
 * 超えた場合は、最初の `MAX_LEADING_SCROLL_OBSERVATIONS` 件と、最後の残りの件数を残し、その間を切り捨てて
 * 切り捨てた件数を `omittedObservationCount` に記録する。
 */
export const MAX_SCROLL_OBSERVATIONS = 500;
/**
 * 上限を超えた場合に残す、最初の測定の件数。最初の測定は、たどる対象を決めた時点の状態と、初めの高さの増え方を示す。
 * 残り（`MAX_SCROLL_OBSERVATIONS - MAX_LEADING_SCROLL_OBSERVATIONS` 件）は最後の測定に充てる。最後の測定は、
 * 完了や `PARTIAL` の判定の直前の状態（最下部での安定の待ち、対象の切り替えの前後）を示し、`finalSnapshot` を含む。
 */
export const MAX_LEADING_SCROLL_OBSERVATIONS = 100;

type OriginArgument = Readonly<{ phase: 'RESET' | 'RESTORE'; absoluteDeadlineMs: number | null; awaitFrame: boolean }>;
type MeasureArgument = Readonly<{ phase: 'MEASURE'; lockedTarget: ScrollTarget | null; epsilonPx: number }>;
type StepArgument = Readonly<{ phase: 'STEP'; target: ScrollTarget | null; top: number; absoluteDeadlineMs: number }>;
type InnerScrollScanArgument = Readonly<{
  phase: 'INNER_SCROLL_SCAN';
  maxElements: number;
  visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
}>;

interface RawScrollMeasurement {
  readonly scrollTarget: ScrollTarget | null;
  readonly scrollY: number;
  readonly viewportHeight: number;
  readonly scrollHeight: number;
  readonly contentHeight: number;
  readonly documentScrollRange: number;
  readonly bodyScrollRange: number;
}

/**
 * ブラウザ内で、文書のスクロール位置を先頭（0, 0）に戻し、戻した後の位置を返す。
 * `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
async function scrollDocumentToOriginInPage(argument: OriginArgument): Promise<ScrollPosition | 'DEADLINE_EXCEEDED'> {
  const pastDeadline = (): boolean => argument.absoluteDeadlineMs !== null && Date.now() >= argument.absoluteDeadlineMs;
  if (pastDeadline()) {
    return 'DEADLINE_EXCEEDED';
  }
  if (argument.awaitFrame && typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (pastDeadline()) {
    return 'DEADLINE_EXCEEDED';
  }
  const root = document.scrollingElement ?? document.documentElement;
  const body = document.body;
  const separateBody = body !== null && body !== root ? body : null;
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  separateBody?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  return {
    scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateBody?.scrollTop ?? 0),
  };
}

/**
 * ブラウザ内で、スクロールする要素を特定し（`lockedTarget` があればそれを使い）、その位置と高さを返す。
 * 文書と body のうち、スクロールできる量が大きいほうを選ぶ（同じなら文書）。どちらも `epsilonPx` 以下なら `null`。
 * 完了と判定する前に候補を比べ直すため、文書と body のスクロールできる量も毎回返す（R'2 の I-1）。
 * `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function measureScrollInPage(argument: MeasureArgument): RawScrollMeasurement {
  const root = document.scrollingElement ?? document.documentElement;
  const body = document.body;
  const separateBody = body !== null && body !== root ? body : null;
  const scrollRange = (element: Element): number => element.scrollHeight - element.clientHeight;
  const isScrollContainer = (element: Element): boolean => (
    !['visible', 'clip'].includes(window.getComputedStyle(element).overflowY)
  );
  const rootRange = scrollRange(root);
  const bodyRange = separateBody !== null && isScrollContainer(separateBody) ? scrollRange(separateBody) : 0;
  let target = argument.lockedTarget;
  if (target === null) {
    if (Math.max(rootRange, bodyRange) > argument.epsilonPx) {
      target = bodyRange > rootRange ? 'BODY' : 'SCROLLING_ELEMENT';
    }
  }
  if (target === 'BODY' && separateBody === null) {
    target = null;
  }
  const element = target === 'BODY' && separateBody !== null ? separateBody : root;
  return {
    scrollTarget: target,
    scrollY: element.scrollTop,
    viewportHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    contentHeight: Math.max(
      root.scrollHeight,
      document.documentElement.scrollHeight,
      separateBody?.scrollHeight ?? 0,
    ),
    documentScrollRange: rootRange,
    bodyScrollRange: bodyRange,
  };
}

/**
 * ブラウザ内で、スクロールする要素を縦方向の位置 `top` へ移動する。
 * `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function stepScrollInPage(argument: StepArgument): 'MUTATED' | 'DEADLINE_EXCEEDED' {
  if (Date.now() >= argument.absoluteDeadlineMs) {
    return 'DEADLINE_EXCEEDED';
  }
  const root = document.scrollingElement ?? document.documentElement;
  const body = document.body;
  const element = argument.target === 'BODY' && body !== null && body !== root ? body : root;
  element.scrollTo({ top: argument.top, behavior: 'instant' });
  return 'MUTATED';
}

/**
 * ブラウザ内で、文書の要素を上限付きで走査し、内側のスクロール領域を数える（定義は `InnerScrollScan`）。
 * open な shadow root の中の要素もたどり、上限の数に含める（R'2 の I-3）。shadow root の中は、その host の直後にたどる。
 * `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function scanInnerScrollContainersInPage(argument: InnerScrollScanArgument): InnerScrollScan {
  const documentScrollers = new Set<Element>([document.documentElement]);
  if (document.scrollingElement !== null) {
    documentScrollers.add(document.scrollingElement);
  }
  if (document.body !== null) {
    documentScrollers.add(document.body);
  }
  // 深さ優先で、文書の順にたどる。要素の子は、shadow root の中の子の後に、light DOM の子をたどる。
  const pending: Element[] = [document.documentElement];
  const pushChildren = (children: HTMLCollection): void => {
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index] as Element);
    }
  };
  let scannedElementCount = 0;
  let scanLimitReached = false;
  let containerCount = 0;
  let representative: { clientHeight: number; scrollHeight: number } | null = null;
  let representativeRange = 0;
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    if (scannedElementCount >= argument.maxElements) {
      scanLimitReached = true;
      break;
    }
    scannedElementCount += 1;
    pushChildren(element.children);
    if (element.shadowRoot !== null) {
      pushChildren(element.shadowRoot.children);
    }
    if (documentScrollers.has(element)) {
      continue;
    }
    const clientHeight = element.clientHeight;
    const scrollHeight = element.scrollHeight;
    if (clientHeight <= 0 || scrollHeight <= clientHeight) {
      continue;
    }
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') {
      continue;
    }
    if (!element.checkVisibility(argument.visibilityOptions)) {
      continue;
    }
    containerCount += 1;
    if (representative === null || scrollHeight - clientHeight > representativeRange) {
      representative = { clientHeight, scrollHeight };
      representativeRange = scrollHeight - clientHeight;
    }
  }
  return { scannedElementCount, scanLimitReached, containerCount, representative };
}

function validateOptions(options: ControlledScrollOptions): void {
  if (!Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Controlled scroll deadline must be finite');
  }
  if (
    !isPositiveFiniteNumber(options.stepViewportFraction)
    || options.stepViewportFraction > MAX_STEP_VIEWPORT_FRACTION
  ) {
    throw new Error(`Controlled scroll step fraction must be greater than zero and at most ${MAX_STEP_VIEWPORT_FRACTION}`);
  }
  if (!isPositiveFiniteNumber(options.stepWaitMs)) {
    throw new Error('Controlled scroll step wait must be positive and finite');
  }
  if (!isPositiveFiniteNumber(options.stableWindowMs)) {
    throw new Error('Controlled scroll stable window must be positive and finite');
  }
}

function isScrollPosition(value: unknown): value is ScrollPosition {
  return isRecord(value) && Number.isFinite(value.scrollX) && Number.isFinite(value.scrollY);
}

function freezePosition(position: ScrollPosition): Readonly<ScrollPosition> {
  return Object.freeze({ scrollX: position.scrollX, scrollY: position.scrollY });
}

function isRawScrollMeasurement(value: unknown): value is RawScrollMeasurement {
  return isRecord(value)
    && (value.scrollTarget === null || (SCROLL_TARGETS as readonly unknown[]).includes(value.scrollTarget))
    && Number.isFinite(value.scrollY)
    && Number.isFinite(value.viewportHeight)
    && Number.isFinite(value.scrollHeight)
    && Number.isFinite(value.contentHeight)
    && Number.isFinite(value.documentScrollRange)
    && Number.isFinite(value.bodyScrollRange);
}

function isInnerScrollScan(value: unknown): value is InnerScrollScan {
  if (
    !isRecord(value)
    || !isNonNegativeSafeInteger(value.scannedElementCount)
    || value.scannedElementCount > MAX_INNER_SCROLL_SCAN_ELEMENTS
    || typeof value.scanLimitReached !== 'boolean'
    || !isNonNegativeSafeInteger(value.containerCount)
    || value.containerCount > value.scannedElementCount
  ) {
    return false;
  }
  const representative = value.representative;
  if (value.containerCount === 0) {
    return representative === null;
  }
  return isRecord(representative)
    && isNonNegativeSafeInteger(representative.clientHeight)
    && isNonNegativeSafeInteger(representative.scrollHeight)
    && representative.clientHeight > 0
    && representative.scrollHeight > representative.clientHeight;
}

function freezeInnerScrollScan(scan: InnerScrollScan): Readonly<InnerScrollScan> {
  return Object.freeze({
    scannedElementCount: scan.scannedElementCount,
    scanLimitReached: scan.scanLimitReached,
    containerCount: scan.containerCount,
    representative: scan.representative === null
      ? null
      : Object.freeze({
          clientHeight: scan.representative.clientHeight,
          scrollHeight: scan.representative.scrollHeight,
        }),
  });
}

function notRestored(
  reason: Extract<ScrollOriginRestoration, { readonly status: 'NOT_RESTORED' }>['reason'],
  position: ScrollPosition | null = null,
): ScrollOriginRestoration {
  return Object.freeze({
    status: 'NOT_RESTORED',
    reason,
    position: position === null ? null : freezePosition(position),
  });
}

function restorationFromPosition(position: ScrollPosition): ScrollOriginRestoration {
  if (Math.abs(position.scrollX) > SCROLL_EPSILON_PX || Math.abs(position.scrollY) > SCROLL_EPSILON_PX) {
    return notRestored('POSITION_NOT_AT_ORIGIN', position);
  }
  return Object.freeze({ status: 'RESTORED', position: freezePosition(position) });
}

function immutableResult(result: ScrollResult): ScrollResult {
  const observations = Object.freeze(result.observations.map((observation) => Object.freeze({ ...observation })));
  const finalSnapshot = result.finalSnapshot === null ? null : Object.freeze({ ...result.finalSnapshot });
  return Object.freeze({ ...result, observations, finalSnapshot }) as ScrollResult;
}

/**
 * 測定の記録。件数が `MAX_SCROLL_OBSERVATIONS` を超えたら、最初の `MAX_LEADING_SCROLL_OBSERVATIONS` 件の直後の
 * 測定（残している最後の側で最も古いもの）を切り捨て、切り捨てた件数を数える。最後の測定は切り捨てない。
 */
interface ObservationLog {
  readonly observations: ScrollObservation[];
  omittedCount: number;
}

function createObservationLog(): ObservationLog {
  return { observations: [], omittedCount: 0 };
}

function recordObservation(log: ObservationLog, observation: ScrollObservation): void {
  log.observations.push(observation);
  if (log.observations.length > MAX_SCROLL_OBSERVATIONS) {
    log.observations.splice(MAX_LEADING_SCROLL_OBSERVATIONS, 1);
    log.omittedCount += 1;
  }
}

function partial(
  reason: ControlledScrollPartialReason,
  log: ObservationLog,
  heightGrowthCount: number,
  targetSwitchCount: number,
  restoration: ScrollOriginRestoration,
  innerScrollScan: Readonly<InnerScrollScan> | null = null,
): ScrollResult {
  return immutableResult({
    status: 'PARTIAL',
    reason,
    observations: log.observations,
    omittedObservationCount: log.omittedCount,
    heightGrowthCount,
    targetSwitchCount,
    restoration,
    innerScrollScan,
    finalSnapshot: log.observations.at(-1) ?? null,
  });
}

function completeBeforeDeadline(
  deadlineAtMs: number,
  log: ObservationLog,
  heightGrowthCount: number,
  targetSwitchCount: number,
  finalSnapshot: ScrollObservation,
  restoration: ScrollOriginRestoration,
  innerScrollScan: Readonly<InnerScrollScan> | null,
): ScrollResult {
  if (Date.now() >= deadlineAtMs) {
    return partial('DEADLINE_EXCEEDED', log, heightGrowthCount, targetSwitchCount, restoration, innerScrollScan);
  }
  const complete = immutableResult({
    status: 'COMPLETE',
    reason: 'BOTTOM_AND_HEIGHT_STABLE',
    observations: log.observations,
    omittedObservationCount: log.omittedCount,
    heightGrowthCount,
    targetSwitchCount,
    restoration,
    innerScrollScan,
    finalSnapshot,
  });
  return Date.now() >= deadlineAtMs
    ? partial('DEADLINE_EXCEEDED', log, heightGrowthCount, targetSwitchCount, restoration, innerScrollScan)
    : complete;
}

/** 文書のスクロール位置を先頭へ戻す。期限を過ぎていれば、ブラウザ内の処理を始めずに記録だけ返す。 */
async function restoreOrigin(page: Page, deadlineAtMs: number): Promise<ScrollOriginRestoration> {
  if (page.isClosed()) {
    return notRestored('PAGE_CLOSED');
  }
  if (Date.now() >= deadlineAtMs) {
    return notRestored('DEADLINE_EXCEEDED');
  }
  const restored = await awaitBeforeDeadline(page.evaluate(scrollDocumentToOriginInPage, {
    phase: 'RESTORE',
    absoluteDeadlineMs: deadlineAtMs,
    awaitFrame: false,
  } satisfies OriginArgument), deadlineAtMs);
  if (restored.status === 'REJECTED') {
    return notRestored(pageFailureReason(page));
  }
  if (restored.status === 'DEADLINE_EXCEEDED' || restored.value === 'DEADLINE_EXCEEDED') {
    return notRestored('DEADLINE_EXCEEDED');
  }
  if (!isScrollPosition(restored.value)) {
    return notRestored('EVALUATION_FAILED');
  }
  return restorationFromPosition(restored.value);
}

/**
 * 文書のスクロール位置を先頭（0, 0）へ戻し、戻した後の位置を返す。
 * 戻せなかった場合（ページのスクリプトが位置を固定している場合など）も、実際の位置を返す。
 * 期限の管理は呼び出し側が行う。
 */
export async function scrollDocumentToOrigin(page: Page): Promise<Readonly<ScrollPosition>> {
  const position = await page.evaluate(scrollDocumentToOriginInPage, {
    phase: 'RESTORE',
    absoluteDeadlineMs: null,
    awaitFrame: false,
  } satisfies OriginArgument);
  if (!isScrollPosition(position)) {
    throw new Error('Browser returned an invalid document scroll position');
  }
  return freezePosition(position);
}

/**
 * ブラウザ内で、文書のスクロール位置（`ScrollPosition` の定義）を読む。位置は変えない。
 * `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function readDocumentScrollPositionInPage(): ScrollPosition {
  const root = document.scrollingElement ?? document.documentElement;
  const body = document.body;
  const separateBody = body !== null && body !== root ? body : null;
  return {
    scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateBody?.scrollTop ?? 0),
  };
}

/**
 * 文書のスクロール位置を読む（位置は変えない）。collector が「収集した時点のスクロール位置」を記録するときに使う。
 * ブラウザが不正な値を返した場合は例外を投げる。期限の管理は呼び出し側が行う。
 */
export async function readDocumentScrollPosition(page: Page): Promise<Readonly<ScrollPosition>> {
  const position: unknown = await page.evaluate(readDocumentScrollPositionInPage);
  if (!isScrollPosition(position)) {
    throw new Error('Browser returned an invalid document scroll position');
  }
  return freezePosition(position);
}

type MeasureOutcome =
  | Readonly<{ status: 'MEASURED'; observation: ScrollObservation }>
  | Readonly<{ status: 'REJECTED' }>
  | Readonly<{ status: 'DEADLINE_EXCEEDED' }>;

async function measure(
  page: Page,
  deadlineAtMs: number,
  lockedTarget: ScrollTarget | null,
  previousHeight: number | undefined,
): Promise<MeasureOutcome> {
  const evaluated = await awaitBeforeDeadline(page.evaluate(measureScrollInPage, {
    phase: 'MEASURE',
    lockedTarget,
    epsilonPx: SCROLL_EPSILON_PX,
  } satisfies MeasureArgument), deadlineAtMs);
  if (evaluated.status === 'REJECTED') {
    return { status: 'REJECTED' };
  }
  if (evaluated.status === 'DEADLINE_EXCEEDED') {
    return { status: 'DEADLINE_EXCEEDED' };
  }
  const observedAtMs = Date.now();
  if (observedAtMs >= deadlineAtMs) {
    return { status: 'DEADLINE_EXCEEDED' };
  }
  const state: unknown = evaluated.value;
  if (!isRawScrollMeasurement(state)) {
    return { status: 'REJECTED' };
  }
  return {
    status: 'MEASURED',
    observation: {
      observedAtMs,
      scrollTarget: state.scrollTarget,
      scrollY: state.scrollY,
      viewportHeight: state.viewportHeight,
      scrollHeight: state.scrollHeight,
      contentHeight: state.contentHeight,
      documentScrollRange: state.documentScrollRange,
      bodyScrollRange: state.bodyScrollRange,
      heightGrew: previousHeight !== undefined && state.scrollHeight > previousHeight,
      atBottom: state.scrollY + state.viewportHeight >= state.scrollHeight - SCROLL_EPSILON_PX,
    },
  };
}

type InnerScrollScanOutcome =
  | Readonly<{ status: 'SCANNED'; scan: Readonly<InnerScrollScan> }>
  | Readonly<{ status: 'FAILED'; reason: PartialFailureReason }>;

/** 内側のスクロール領域を、期限までに上限付きで探す。 */
async function scanInnerScrollContainers(page: Page, deadlineAtMs: number): Promise<InnerScrollScanOutcome> {
  const evaluated = await awaitBeforeDeadline(page.evaluate(scanInnerScrollContainersInPage, {
    phase: 'INNER_SCROLL_SCAN',
    maxElements: MAX_INNER_SCROLL_SCAN_ELEMENTS,
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  } satisfies InnerScrollScanArgument), deadlineAtMs);
  if (evaluated.status === 'REJECTED') {
    return { status: 'FAILED', reason: pageFailureReason(page) };
  }
  if (evaluated.status === 'DEADLINE_EXCEEDED') {
    return { status: 'FAILED', reason: 'DEADLINE_EXCEEDED' };
  }
  const scan: unknown = evaluated.value;
  if (!isInnerScrollScan(scan)) {
    return { status: 'FAILED', reason: 'EVALUATION_FAILED' };
  }
  return { status: 'SCANNED', scan: freezeInnerScrollScan(scan) };
}

/**
 * 文書と body のうち、測定の時点でたどっていない候補と、そのスクロールできる量。
 * 対象が決まっていない場合は、量の大きいほう（同じなら文書。`measureScrollInPage` の選び方と同じ）。
 */
function alternativeDocumentTarget(
  observation: ScrollObservation,
): Readonly<{ target: ScrollTarget; range: number }> {
  switch (observation.scrollTarget) {
    case 'SCROLLING_ELEMENT':
      return { target: 'BODY', range: observation.bodyScrollRange };
    case 'BODY':
      return { target: 'SCROLLING_ELEMENT', range: observation.documentScrollRange };
    case null:
      return observation.bodyScrollRange > observation.documentScrollRange
        ? { target: 'BODY', range: observation.bodyScrollRange }
        : { target: 'SCROLLING_ELEMENT', range: observation.documentScrollRange };
  }
}

export async function controlledScroll(page: Page, options: ControlledScrollOptions): Promise<ScrollResult> {
  validateOptions(options);
  const deadlineAtMs = options.deadlineAtMs;
  const stepWaitMs = options.stepWaitMs;
  const stableWindowMs = options.stableWindowMs;
  const stepViewportFraction = options.stepViewportFraction;
  const observationLog = createObservationLog();
  let heightGrowthCount = 0;
  // 完了と判定する前の測り直しで、たどる対象を切り替えた回数（上限は `MAX_SCROLL_TARGET_SWITCHES`）。
  let targetSwitchCount = 0;

  if (page.isClosed()) {
    return partial('PAGE_CLOSED', observationLog, heightGrowthCount, targetSwitchCount, notRestored('PAGE_CLOSED'));
  }

  const reset = await awaitBeforeDeadline(page.evaluate(scrollDocumentToOriginInPage, {
    phase: 'RESET',
    absoluteDeadlineMs: deadlineAtMs,
    awaitFrame: true,
  } satisfies OriginArgument), deadlineAtMs);
  if (reset.status === 'REJECTED') {
    const reason = pageFailureReason(page);
    return partial(reason, observationLog, heightGrowthCount, targetSwitchCount, notRestored(reason));
  }
  if (reset.status === 'DEADLINE_EXCEEDED' || reset.value === 'DEADLINE_EXCEEDED') {
    return partial('DEADLINE_EXCEEDED', observationLog, heightGrowthCount, targetSwitchCount, notRestored('DEADLINE_EXCEEDED'));
  }

  let innerScrollScan: Readonly<InnerScrollScan> | null = null;
  // 部分結果を返す前にも、先頭へ戻すことを試み、その結果を記録する。
  const finish = async (reason: ControlledScrollPartialReason): Promise<ScrollResult> => (
    partial(
      reason,
      observationLog,
      heightGrowthCount,
      targetSwitchCount,
      await restoreOrigin(page, deadlineAtMs),
      innerScrollScan,
    )
  );

  let lockedTarget: ScrollTarget | null = null;
  let previousHeight: number | undefined;
  let bottomStableSinceMs: number | undefined;
  let advanceRequestedFromY: number | undefined;
  let advanced = false;
  while (Date.now() < deadlineAtMs) {
    const measured = await measure(page, deadlineAtMs, lockedTarget, previousHeight);
    if (measured.status === 'REJECTED') {
      return finish(pageFailureReason(page));
    }
    if (measured.status === 'DEADLINE_EXCEEDED') {
      return finish('DEADLINE_EXCEEDED');
    }
    const observation = measured.observation;
    recordObservation(observationLog, observation);
    lockedTarget ??= observation.scrollTarget;
    if (observation.scrollY > SCROLL_EPSILON_PX) {
      advanced = true;
    }
    const contentExceedsViewport = observation.contentHeight > observation.viewportHeight + SCROLL_EPSILON_PX;
    if (observation.scrollTarget === null && contentExceedsViewport) {
      return finish('SCROLL_TARGET_UNRESOLVED');
    }
    const heightChanged = previousHeight !== undefined && observation.scrollHeight !== previousHeight;
    if (
      advanceRequestedFromY !== undefined
      && !heightChanged
      && observation.scrollY <= advanceRequestedFromY
    ) {
      return finish('SCROLL_NOT_ADVANCED');
    }
    if (observation.heightGrew) {
      heightGrowthCount += 1;
    }

    if (observation.atBottom && !heightChanged) {
      bottomStableSinceMs ??= observation.observedAtMs;
      if (observation.observedAtMs - bottomStableSinceMs >= stableWindowMs) {
        if (!advanced && contentExceedsViewport) {
          return finish('SCROLL_NOT_ADVANCED');
        }
        // 内側のスクロール領域のほうが大きくスクロールできるページを COMPLETE にしないよう、内側の領域を探して比べる
        // （R4 の N1。文書が body の余白の分だけスクロールできる場合も、本文が内側の領域にあることがある）。
        const scanned = await scanInnerScrollContainers(page, deadlineAtMs);
        if (scanned.status === 'FAILED') {
          return finish(scanned.reason);
        }
        innerScrollScan = scanned.scan;
        const traversedRange = observation.scrollTarget === null
          ? 0
          : observation.scrollHeight - observation.viewportHeight;
        const innerRange = innerScrollScan.representative === null
          ? 0
          : innerScrollScan.representative.scrollHeight - innerScrollScan.representative.clientHeight;
        // 完了と判定する前に、候補のスクロールできる量を比べ直す（R'2 の I-1）。最初の測定の後に、たどっていないほう
        // （文書か body）が大きくなっていれば、1回だけ対象を切り替えてたどり直す。2回目も変わっていれば完了にしない。
        const alternative = alternativeDocumentTarget(observation);
        if (
          alternative.range > SCROLL_EPSILON_PX
          && alternative.range > traversedRange
          && alternative.range >= innerRange
        ) {
          if (targetSwitchCount >= MAX_SCROLL_TARGET_SWITCHES) {
            return finish('SCROLL_TARGET_UNSTABLE');
          }
          targetSwitchCount += 1;
          lockedTarget = alternative.target;
          previousHeight = undefined;
          bottomStableSinceMs = undefined;
          advanceRequestedFromY = undefined;
          advanced = false;
          continue;
        }
        if (innerScrollScan.containerCount > 0 && innerRange > traversedRange) {
          return finish('INNER_SCROLL_CONTAINER_NOT_TRAVERSED');
        }
        if (observation.scrollTarget === null && innerScrollScan.scanLimitReached) {
          return finish('INNER_SCROLL_SCAN_LIMIT_REACHED');
        }
        const restoration = await restoreOrigin(page, deadlineAtMs);
        return completeBeforeDeadline(
          deadlineAtMs,
          observationLog,
          heightGrowthCount,
          targetSwitchCount,
          observation,
          restoration,
          innerScrollScan,
        );
      }
    } else {
      bottomStableSinceMs = undefined;
    }
    previousHeight = observation.scrollHeight;

    const stepPx = Math.max(1, Math.floor(observation.viewportHeight * stepViewportFraction));
    const maxScrollY = Math.max(0, observation.scrollHeight - observation.viewportHeight);
    const top = Math.min(observation.scrollY + stepPx, maxScrollY);
    advanceRequestedFromY = observation.scrollTarget !== null && !observation.atBottom && top > observation.scrollY
      ? observation.scrollY
      : undefined;
    const moved = await awaitBeforeDeadline(page.evaluate(stepScrollInPage, {
      phase: 'STEP',
      target: observation.scrollTarget,
      top,
      absoluteDeadlineMs: deadlineAtMs,
    } satisfies StepArgument), deadlineAtMs);
    if (moved.status === 'REJECTED') {
      return finish(pageFailureReason(page));
    }
    if (moved.status === 'DEADLINE_EXCEEDED' || moved.value === 'DEADLINE_EXCEEDED') {
      return finish('DEADLINE_EXCEEDED');
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(stepWaitMs, remainingMs));
  }

  return finish('DEADLINE_EXCEEDED');
}
