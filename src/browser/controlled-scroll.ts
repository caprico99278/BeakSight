import type { ElementHandle, JSHandle, Page } from 'playwright';
import type { PartialFailureReason } from '../core/contracts.js';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';
import {
  SCROLL_TARGETS,
  type InnerScrollContainerEvidence,
  type InnerScrollScanEvidence,
  type InnerScrollStopReason,
  type ScrollCompleteReason,
  type ScrollEvidence,
  type ScrollIncompleteReason,
  type ScrollObservationEvidence,
  type ScrollPosition,
  type ScrollRestorationEvidence,
  type ScrollTargetEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger, isPositiveFiniteNumber, isRecord } from '../core/guards.js';
import type { ProgressSignals } from '../core/progress-watch.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { watchCollection, type CollectorWatchEnd } from './collector-watch.js';
import { composeInPage, type StandardReaders } from './in-page-readers.js';
import { pageFailureReason } from './page-failure.js';

/**
 * controlled scroll の指定。
 *
 * L9（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4・5 の 1・6 の L9）: 期限（`deadlineAtMs`）は任意。省くと期限を置かず、進みの見張り（L0）で
 * 待つ（新しい位置・高さ・作りを読んだときだけ中身の進みの印を付ける。同じ値の繰り返しは進みに数えない）。全く反応がない・静まらないときだけ、それまでの
 * 記録で `PARTIAL`（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）を返す。段の見張りの口（`progress`）を渡すと、自分では見張らず、その口だけを使う（口の
 * abort で、待たずに、それまでの記録を返す。L1b）。期限を渡したときの扱いは、今までどおり（呼ぶ側が渡さなくなるまで残す）。
 */
export interface ControlledScrollOptions {
  readonly deadlineAtMs?: number | undefined;
  readonly stepViewportFraction: number;
  readonly stepWaitMs: number;
  readonly stableWindowMs: number;
  /** L9: 段の見張りの口（page-auditor の scroll の段）。 */
  readonly progress?: ProgressSignals | undefined;
  /** L9: 口も期限もないときの、自分の見張りの反応なしの長さ（ms。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`。テストが短くする）。 */
  readonly quietLimitMs?: number | undefined;
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
// L9（INV-LIMITS の表 A の N16・N18）: 内側のスクロール領域を探すときに調べる要素の数（前は 16,384）と、測定の記録の数（前は 500・先頭 100）の上限は
// 撤廃した（全部を調べ、全部を記録する。`omittedObservationCount` は常に 0）。定数は LZ-1 で消した。
/**
 * L9（N15）: 期限のない呼び出しでは使わない（たどる対象の切り替えは回数で止めず、同じ対象を同じ量で 2 度たどることになったら止める。状態で終える）。
 * 期限（`deadlineAtMs`）を渡す呼び出しだけが、前の決まり（切り替えは 1 回まで）で使う。
 */
export const MAX_SCROLL_TARGET_SWITCHES = 1;

type OriginArgument = Readonly<{ phase: 'RESET' | 'RESTORE'; absoluteDeadlineMs: number | null; awaitFrame: boolean }>;
type MeasureArgument = Readonly<{ phase: 'MEASURE'; lockedTarget: ScrollTarget | null; epsilonPx: number }>;
/** LZ-3b: ページの中の期限の引数は、期限を受けないときは `null`（比べない。前は番兵の `Number.MAX_SAFE_INTEGER`）。`OriginArgument` と同じ形。 */
type StepArgument = Readonly<{ phase: 'STEP'; target: ScrollTarget | null; top: number; absoluteDeadlineMs: number | null }>;
type InnerScrollScanArgument = Readonly<{
  /** `INNER_SCROLL_SCAN` は数えた結果（`InnerScrollScan`）を、`INNER_SCROLL_LOCATE` は見つけた全部の領域の要素（文書の順）を返す（L9）。 */
  phase: 'INNER_SCROLL_SCAN' | 'INNER_SCROLL_LOCATE';
  visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
}>;
type InnerMeasureArgument = Readonly<{ phase: 'INNER_MEASURE' }>;
type InnerStepArgument = Readonly<{ phase: 'INNER_STEP'; top: number; absoluteDeadlineMs: number | null }>;
type InnerRestoreArgument = Readonly<{ phase: 'INNER_RESTORE'; top: number; absoluteDeadlineMs: number | null }>;

/** 内側のスクロール領域の1回の測定（DEF-207。Evidence には記録しない）。 */
interface RawInnerScrollMeasurement {
  readonly connected: boolean;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

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
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
async function scrollDocumentToOriginReader(R: StandardReaders, argument: OriginArgument): Promise<ScrollPosition | 'DEADLINE_EXCEEDED'> {
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
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="body">` など）は、`document` の同じ名前のプロパティを隠すので、
  // `Document.prototype` の getter で読む（部品の `documentProperty`。`src/browser/in-page-readers.ts`。CC-068）。html・body は、名前つきの子で隠れない。
  const { documentProperty } = R;
  const root = documentProperty<Element | null>('scrollingElement') ?? documentProperty<HTMLElement>('documentElement');
  const body = documentProperty<HTMLElement | null>('body');
  const separateBody = body !== null && body !== root ? body : null;
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  separateBody?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  return {
    scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateBody?.scrollTop ?? 0),
  };
}
const scrollDocumentToOriginInPage = composeInPage(scrollDocumentToOriginReader);

/**
 * ブラウザ内で、スクロールする要素を特定し（`lockedTarget` があればそれを使い）、その位置と高さを返す。
 * 文書と body のうち、スクロールできる量が大きいほうを選ぶ（同じなら文書）。どちらも `epsilonPx` 以下なら `null`。
 * 完了と判定する前に候補を比べ直すため、文書と body のスクロールできる量も毎回返す（R'2 の I-1）。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function measureScrollReader(R: StandardReaders, argument: MeasureArgument): RawScrollMeasurement {
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="body">` など）は、`document` の同じ名前のプロパティを隠すので、
  // `Document.prototype` の getter で読む（部品の `documentProperty`。`src/browser/in-page-readers.ts`。CC-068）。html・body は、名前つきの子で隠れない。
  const { documentProperty } = R;
  const root = documentProperty<Element | null>('scrollingElement') ?? documentProperty<HTMLElement>('documentElement');
  const body = documentProperty<HTMLElement | null>('body');
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
      documentProperty<HTMLElement>('documentElement').scrollHeight,
      separateBody?.scrollHeight ?? 0,
    ),
    documentScrollRange: rootRange,
    bodyScrollRange: bodyRange,
  };
}
const measureScrollInPage = composeInPage(measureScrollReader);

/**
 * ブラウザ内で、スクロールする要素を縦方向の位置 `top` へ移動する。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function stepScrollReader(R: StandardReaders, argument: StepArgument): 'MUTATED' | 'DEADLINE_EXCEEDED' {
  if (argument.absoluteDeadlineMs !== null && Date.now() >= argument.absoluteDeadlineMs) {
    return 'DEADLINE_EXCEEDED';
  }
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="body">` など）は、`document` の同じ名前のプロパティを隠すので、
  // `Document.prototype` の getter で読む（部品の `documentProperty`。`src/browser/in-page-readers.ts`。CC-068）。html・body は、名前つきの子で隠れない。
  const { documentProperty } = R;
  const root = documentProperty<Element | null>('scrollingElement') ?? documentProperty<HTMLElement>('documentElement');
  const body = documentProperty<HTMLElement | null>('body');
  const element = argument.target === 'BODY' && body !== null && body !== root ? body : root;
  element.scrollTo({ top: argument.top, behavior: 'instant' });
  return 'MUTATED';
}
const stepScrollInPage = composeInPage(stepScrollReader);

/**
 * ブラウザ内で、文書の全部の要素を走査し、内側のスクロール領域を数える（定義は `InnerScrollScan`）か、見つけた全部の領域を文書の順に返す（L9）。
 * open な shadow root の中の要素もたどる（R'2 の I-3）。shadow root の中は、その host の直後にたどる。L9: 調べる要素の数の上限は置かない。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function scanInnerScrollContainersReader(R: StandardReaders, argument: InnerScrollScanArgument): InnerScrollScan | Element[] {
  // DOM clobbering（DEF-072・DEF-073）: form の中の名前つきの入力の欄は form の、名前つきの img・form などは `document` の、同じ名前の
  // プロパティとメソッドを隠す（`<input name="children">`、`<img name="documentElement">` など）。たどる要素（form になりうる）と `document` の
  // 標準のプロパティとメソッドは、標準の prototype の getter とメソッドで読む（getter は部品の `standardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  const { standardGetter } = R;
  const childrenOf = standardGetter<HTMLCollection>(Element.prototype, 'children');
  const shadowRootOf = standardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');
  const clientHeightOf = standardGetter<number>(Element.prototype, 'clientHeight');
  const scrollHeightOf = standardGetter<number>(Element.prototype, 'scrollHeight');
  const checkVisibilityOf = (element: Element, options: CheckVisibilityOptions): boolean => (
    Element.prototype.checkVisibility.call(element, options)
  );
  const documentElement = standardGetter<HTMLElement>(Document.prototype, 'documentElement')(document);
  const scrollingElement = standardGetter<Element | null>(Document.prototype, 'scrollingElement')(document);
  const documentBody = standardGetter<HTMLElement | null>(Document.prototype, 'body')(document);
  const documentScrollers = new Set<Element>([documentElement]);
  if (scrollingElement !== null) {
    documentScrollers.add(scrollingElement);
  }
  if (documentBody !== null) {
    documentScrollers.add(documentBody);
  }
  // 深さ優先で、文書の順にたどる。要素の子は、shadow root の中の子の後に、light DOM の子をたどる。
  const pending: Element[] = [documentElement];
  const pushChildren = (children: HTMLCollection): void => {
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index] as Element);
    }
  };
  let scannedElementCount = 0;
  const containers: Element[] = [];
  let representative: { clientHeight: number; scrollHeight: number } | null = null;
  let representativeRange = 0;
  for (let element = pending.pop(); element !== undefined; element = pending.pop()) {
    scannedElementCount += 1;
    pushChildren(childrenOf(element));
    const shadowRoot = shadowRootOf(element);
    if (shadowRoot !== null) {
      pushChildren(shadowRoot.children);
    }
    if (documentScrollers.has(element)) {
      continue;
    }
    const clientHeight = clientHeightOf(element);
    const scrollHeight = scrollHeightOf(element);
    if (clientHeight <= 0 || scrollHeight <= clientHeight) {
      continue;
    }
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') {
      continue;
    }
    if (!checkVisibilityOf(element, argument.visibilityOptions)) {
      continue;
    }
    containers.push(element);
    if (representative === null || scrollHeight - clientHeight > representativeRange) {
      representative = { clientHeight, scrollHeight };
      representativeRange = scrollHeight - clientHeight;
    }
  }
  if (argument.phase === 'INNER_SCROLL_LOCATE') {
    return containers;
  }
  return { scannedElementCount, scanLimitReached: false, containerCount: containers.length, representative };
}
const scanInnerScrollContainersInPage = composeInPage(scanInnerScrollContainersReader);

/**
 * L9: ブラウザ内で、`scope` の要素（`null` なら文書の根）の中の全部の要素の作りの印（値を含まない）の集合を返す。伸び続ける画面を、新しい作りが
 * 出なくなったら止めるための、唯一の判定の材料（`scrollStructureSignaturesOf`）。
 * 作りの印は、COV-0 の構造の鍵の考え方（`src/discovery/state-keys.ts`。文字の値を入れない作りの事実）に合わせ、要素の名前・`role`・class の語の
 * 並び・属性の名前の並び・親の要素の名前で作る。属性の値と文字は入れない。class の語と属性の名前の中の数字の並びは `{n}` にまとめる（行ごとの番号で、
 * 同じ作りの行が別の作りに見えないように）。open な shadow root の中の要素も含める。数の上限は置かない。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate`・`ElementHandle.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function structureSignaturesReader(R: StandardReaders, scope: unknown): string[] {
  const { standardGetter } = R;
  const childrenOf = standardGetter<HTMLCollection>(Element.prototype, 'children');
  const shadowRootOf = standardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');
  const localNameOf = standardGetter<string>(Element.prototype, 'localName');
  const root = scope instanceof Element ? scope : standardGetter<HTMLElement>(Document.prototype, 'documentElement')(document);
  const normalized = (token: string): string => token.replace(/[0-9]+/gu, '{n}');
  const signatures = new Set<string>();
  const pending: Array<readonly [Element, string]> = [[root, '']];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const [element, parentName] = item;
    const name = localNameOf(element);
    const role = Element.prototype.getAttribute.call(element, 'role') ?? '';
    const classes = [...new Set((Element.prototype.getAttribute.call(element, 'class') ?? '').split(/\s+/u).filter((token) => token.length > 0).map(normalized))].sort();
    const attributeNames = [...new Set(Element.prototype.getAttributeNames.call(element)
      .filter((attribute) => attribute !== 'class' && attribute !== 'id' && attribute !== 'style')
      .map(normalized))].sort();
    signatures.add(JSON.stringify([parentName, name, role, classes, attributeNames]));
    const children = childrenOf(element);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push([children[index] as Element, name]);
    }
    const shadowRoot = shadowRootOf(element);
    if (shadowRoot !== null) {
      for (let index = shadowRoot.children.length - 1; index >= 0; index -= 1) {
        pending.push([shadowRoot.children[index] as Element, name]);
      }
    }
  }
  return [...signatures];
}
/**
 * L9 の作りの印の読み取り（ページの中で動く。引数は `scope`）。COV-2c（SREV-COV の I-1）: 操作さがしの押す部品も、押した後に「同じ作りの部品が増えただけか」を
 * 見分けるために、同じ読み取り（isolated world で `null` を渡して文書の全体）と同じ判定（`scrollStructureSignaturesOf`）を使う（作りの印を 2 か所に書かない）。
 */
export const structureSignaturesInPage = composeInPage(structureSignaturesReader);

/** L9: 内側の領域の、文書の根からの位置（`elementPathOf`。位置で表せなければ `null`）。 */
function containerPathReader(R: StandardReaders, element: Element): number[] | null {
  return R.elementPathOf(element);
}
const containerPathInPage = composeInPage(containerPathReader);

/**
 * ブラウザ内で、内側のスクロール領域の位置と高さを読む（DEF-207）。位置は変えない。
 * DOM clobbering（DEF-072）: 領域が form のとき、名前つきの入力の欄が同じ名前のプロパティを隠すので、標準の prototype の getter で読む。
 * 部品（`R`）を `composeInPage` で組み込んで `ElementHandle.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function measureInnerScrollReader(R: StandardReaders, element: Element, _argument: InnerMeasureArgument): RawInnerScrollMeasurement {
  const { standardGetter } = R;
  return {
    connected: standardGetter<boolean>(Node.prototype, 'isConnected')(element),
    scrollTop: standardGetter<number>(Element.prototype, 'scrollTop')(element),
    clientHeight: standardGetter<number>(Element.prototype, 'clientHeight')(element),
    scrollHeight: standardGetter<number>(Element.prototype, 'scrollHeight')(element),
  };
}
const measureInnerScrollInPage = composeInPage(measureInnerScrollReader);

/**
 * ブラウザ内で、内側のスクロール領域を縦方向の位置 `top` へ移動する（DEF-207。文書の `stepScrollReader` と同じ動かし方）。
 * 部品（`R`）を `composeInPage` で組み込んで `ElementHandle.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function stepInnerScrollReader(_R: StandardReaders, element: Element, argument: InnerStepArgument): 'MUTATED' | 'DEADLINE_EXCEEDED' {
  if (argument.absoluteDeadlineMs !== null && Date.now() >= argument.absoluteDeadlineMs) {
    return 'DEADLINE_EXCEEDED';
  }
  (Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void).call(element, { top: argument.top, behavior: 'instant' });
  return 'MUTATED';
}
const stepInnerScrollInPage = composeInPage(stepInnerScrollReader);

/**
 * ブラウザ内で、内側のスクロール領域を元の位置 `top` へ戻し、戻した後の `scrollTop` を返す（DEF-207。文書の `restoreOrigin` と同じ考え方）。
 * 部品（`R`）を `composeInPage` で組み込んで `ElementHandle.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function restoreInnerScrollReader(R: StandardReaders, element: Element, argument: InnerRestoreArgument): number | 'DEADLINE_EXCEEDED' {
  if (argument.absoluteDeadlineMs !== null && Date.now() >= argument.absoluteDeadlineMs) {
    return 'DEADLINE_EXCEEDED';
  }
  (Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void).call(element, { top: argument.top, behavior: 'instant' });
  return R.standardGetter<number>(Element.prototype, 'scrollTop')(element);
}
const restoreInnerScrollInPage = composeInPage(restoreInnerScrollReader);

function validateOptions(options: ControlledScrollOptions): void {
  if (options.deadlineAtMs !== undefined && !Number.isFinite(options.deadlineAtMs)) {
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

function isRawInnerScrollMeasurement(value: unknown): value is RawInnerScrollMeasurement {
  return isRecord(value)
    && typeof value.connected === 'boolean'
    && Number.isFinite(value.scrollTop)
    && Number.isFinite(value.clientHeight)
    && Number.isFinite(value.scrollHeight);
}

function isInnerScrollScan(value: unknown): value is InnerScrollScan {
  if (
    !isRecord(value)
    || !isNonNegativeSafeInteger(value.scannedElementCount)
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

/** L9: 作りの印の並びとして、ブラウザが返した値を確かめる。 */
const isSignatureList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

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
  const innerScrollContainers = result.innerScrollContainers === undefined
    ? undefined
    : Object.freeze(result.innerScrollContainers.map((container) => Object.freeze({ ...container })));
  return Object.freeze({
    ...result,
    observations,
    finalSnapshot,
    ...(innerScrollContainers === undefined ? {} : { innerScrollContainers }),
  }) as ScrollResult;
}

// ---------------------------------------------------------------------------------------------------------------
// L9: たどる途中の記録と、ブラウザの呼び出しの待ち方
// ---------------------------------------------------------------------------------------------------------------

/** 内側の領域 1 つをたどる途中の記録（見張りが段を終えても残す）。 */
interface MutableInnerContainerRecord {
  selector: string | null;
  originTop: number | null;
  clientHeight: number | null;
  initialScrollHeight: number | null;
  finalScrollHeight: number | null;
  maxScrollTop: number | null;
  reachedBottom: boolean;
  stepCount: number;
  heightGrowthCount: number;
  stopReason: InnerScrollStopReason | null;
  restored: boolean | null;
}

/** たどる途中の記録（L9。見張りが段を終えたときは、ここまでで結果を作る）。 */
interface ScrollProgressState {
  readonly observations: ScrollObservation[];
  heightGrowthCount: number;
  targetSwitchCount: number;
  innerScrollScan: Readonly<InnerScrollScan> | null;
  readonly innerContainers: MutableInnerContainerRecord[];
  /** 内側の領域を探したか（探していなければ、結果に `innerScrollContainers` を書かない）。 */
  innerContainersLocated: boolean;
}

function freezeInnerContainer(record: MutableInnerContainerRecord, fallback: InnerScrollStopReason): InnerScrollContainerEvidence {
  return Object.freeze({
    selector: record.selector,
    originTop: record.originTop,
    clientHeight: record.clientHeight,
    initialScrollHeight: record.initialScrollHeight,
    finalScrollHeight: record.finalScrollHeight,
    maxScrollTop: record.maxScrollTop,
    reachedBottom: record.reachedBottom,
    stepCount: record.stepCount,
    heightGrowthCount: record.heightGrowthCount,
    stopReason: record.stopReason ?? fallback,
    restored: record.restored,
  });
}

/** ブラウザの呼び出しの結果（期限を受けたときは期限切れもある）。 */
type CallOutcome<T> =
  | Readonly<{ status: 'FULFILLED'; value: T }>
  | Readonly<{ status: 'REJECTED' }>
  | Readonly<{ status: 'DEADLINE_EXCEEDED' }>;

/**
 * たどる文脈。期限を受けたときは、今までどおり期限で待つ（`deadlineAtMs`）。期限を受けないときは、期限を置かずに待ち（`deadlineAtMs` は
 * `undefined`。LZ-3b: 前は番兵の `Infinity`）、見張りの口の abort（`signal`）で、繰り返しを止める。中身の進みの印（`markProgress`）は、新しい値を読んだときだけ付ける。
 */
interface ScrollContext {
  readonly deadlineAtMs: number | undefined;
  readonly signal: AbortSignal | null;
  readonly markProgress: () => void;
}

const hasDeadline = (context: ScrollContext): context is ScrollContext & { readonly deadlineAtMs: number } => context.deadlineAtMs !== undefined;

/** 期限を受けていて、その期限を過ぎたか（期限を受けないときは比べない）。 */
const pastDeadline = (context: ScrollContext, atMs: number = Date.now()): boolean => hasDeadline(context) && atMs >= context.deadlineAtMs;

/** 段を続けられないか（期限を過ぎた、見張りが段を終えた）。 */
const stopped = (context: ScrollContext): boolean => context.signal?.aborted === true || pastDeadline(context);

/** ページの中の期限の引数（期限を受けないときは `null`。ページの中で比べない）。 */
const inPageDeadlineOf = (context: ScrollContext): number | null => (hasDeadline(context) ? context.deadlineAtMs : null);

async function call<T>(context: ScrollContext, operation: Promise<T>): Promise<CallOutcome<T>> {
  const outcome = await awaitBeforeDeadline(operation, context.deadlineAtMs);
  return outcome.status === 'REJECTED' ? Object.freeze({ status: 'REJECTED' }) : outcome;
}

/** 待つ（期限を受けたときは、残りの時間より長く待たない）。 */
async function pause(context: ScrollContext, ms: number): Promise<void> {
  await wait(hasDeadline(context) ? Math.max(0, Math.min(ms, context.deadlineAtMs - Date.now())) : ms);
}

/**
 * L9: 伸び続ける画面の止め方の唯一の判定（文書と内側の領域で共用）。今までに見た作りの印の集合 `seen` に、新しく読んだ印 `read` を足し、新しい作りが
 * 1 つでもあったかを返す。
 */
export function scrollStructureSignaturesOf(seen: Set<string>, read: readonly string[]): boolean {
  let added = false;
  for (const signature of read) {
    if (!seen.has(signature)) {
      seen.add(signature);
      added = true;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------------------------
// RB-9（再構築の設計書 3 章。案 2 章の 2）: 1 回の測定の判定（純粋）。文書の輪と内側の領域の輪が共有する唯一の判定。
// ---------------------------------------------------------------------------------------------------------------

/** 1 回の測定の判定の、前の測定から持ち越す状態。 */
export interface ScrollStepState {
  readonly previousHeight: number | undefined;
  /** 前の測定で、最下部の近く（あと 1 画面の内）にいたか。 */
  readonly previousNearBottom: boolean;
  /** 最下部で高さが変わらなくなった時刻。 */
  readonly bottomStableSinceMs: number | undefined;
  /** 進めることを頼んだ時の位置（頼まなかったときは undefined）。 */
  readonly advanceRequestedFrom: number | undefined;
}

export const INITIAL_SCROLL_STEP_STATE: ScrollStepState = Object.freeze({
  previousHeight: undefined,
  previousNearBottom: false,
  bottomStableSinceMs: undefined,
  advanceRequestedFrom: undefined,
});

/** 1 回の測定（位置・見える高さ・スクロールの高さ）。`canAdvance`: 動かす対象があり、進んだかを確かめられるか（文書の対象がないときは偽）。 */
export interface ScrollStepMeasurement {
  readonly atMs: number;
  readonly position: number;
  readonly viewportHeight: number;
  readonly scrollHeight: number;
  readonly canAdvance: boolean;
}

/** 判定。`STEP` は次に動かす位置（今の位置と同じこともある）。 */
export type ScrollStepVerdict =
  | Readonly<{ kind: 'STEP'; top: number }>
  | Readonly<{ kind: 'BOTTOM_STABLE' }>
  | Readonly<{ kind: 'NOT_ADVANCED' }>
  | Readonly<{ kind: 'NO_NEW_STRUCTURE' }>;

/** 1 回の測定の判定の結果。`heightGrew`: 高さが伸びた。`atBottom`: 最下部にいる。 */
export interface ScrollStep {
  readonly state: ScrollStepState;
  readonly verdict: ScrollStepVerdict;
  readonly heightGrew: boolean;
  readonly atBottom: boolean;
}

/**
 * L9: 伸び続ける画面の止め方のために、作りの印を読み直すか（最下部の近くで高さが伸びたときだけ）。読んだ結果（新しい作りがあったか）を `scrollStep` に渡す。
 */
export const scrollStructureCheckNeeded = (state: ScrollStepState, measurement: Pick<ScrollStepMeasurement, 'scrollHeight'>): boolean =>
  state.previousHeight !== undefined && measurement.scrollHeight > state.previousHeight && state.previousNearBottom;

/**
 * 1 回の測定の判定（純粋）。
 * - `newStructure` が偽（読み直して、新しい作りが出なかった）なら、伸び続ける画面として止める（`NO_NEW_STRUCTURE`）。
 * - 進めることを頼んだのに、高さが変わらず位置も進まなければ止める（`NOT_ADVANCED`）。
 * - 最下部で高さが変わらない状態が `stableWindowMs` 続いたら止める（`BOTTOM_STABLE`）。
 * - ほかは、見える高さの `stepViewportFraction` だけ進める（最下部を越えない）。
 */
/** 最下部にいるか（測定の記録と判定の、唯一の式）。 */
const isAtScrollBottom = (position: number, viewportHeight: number, scrollHeight: number): boolean =>
  position + viewportHeight >= scrollHeight - SCROLL_EPSILON_PX;
/** 前の測定より高さが伸びたか（測定の記録と判定の、唯一の式）。 */
const heightGrewFrom = (previousHeight: number | undefined, scrollHeight: number): boolean =>
  previousHeight !== undefined && scrollHeight > previousHeight;

export function scrollStep(
  state: ScrollStepState,
  measurement: ScrollStepMeasurement,
  policy: { readonly stableWindowMs: number; readonly stepViewportFraction: number },
  newStructure: boolean | undefined,
): ScrollStep {
  const { atMs, position, viewportHeight, scrollHeight } = measurement;
  const heightChanged = state.previousHeight !== undefined && scrollHeight !== state.previousHeight;
  const heightGrew = heightGrewFrom(state.previousHeight, scrollHeight);
  const atBottom = isAtScrollBottom(position, viewportHeight, scrollHeight);
  const result = (verdict: ScrollStepVerdict, next: ScrollStepState = state): ScrollStep =>
    Object.freeze({ state: next, verdict: Object.freeze(verdict), heightGrew, atBottom });
  if (newStructure === false) {
    return result({ kind: 'NO_NEW_STRUCTURE' });
  }
  if (state.advanceRequestedFrom !== undefined && !heightChanged && position <= state.advanceRequestedFrom) {
    return result({ kind: 'NOT_ADVANCED' });
  }
  let bottomStableSinceMs: number | undefined;
  if (atBottom && !heightChanged) {
    bottomStableSinceMs = state.bottomStableSinceMs ?? atMs;
    if (atMs - bottomStableSinceMs >= policy.stableWindowMs) {
      return result({ kind: 'BOTTOM_STABLE' }, Object.freeze({ ...state, bottomStableSinceMs }));
    }
  }
  const stepPx = Math.max(1, Math.floor(viewportHeight * policy.stepViewportFraction));
  const top = Math.min(position + stepPx, Math.max(0, scrollHeight - viewportHeight));
  return result({ kind: 'STEP', top }, Object.freeze({
    previousHeight: scrollHeight,
    previousNearBottom: position + 2 * viewportHeight >= scrollHeight - SCROLL_EPSILON_PX,
    bottomStableSinceMs,
    advanceRequestedFrom: measurement.canAdvance && !atBottom && top > position ? position : undefined,
  }));
}

function partial(
  reason: ControlledScrollPartialReason,
  state: ScrollProgressState,
  restoration: ScrollOriginRestoration,
  innerFallback: InnerScrollStopReason = 'EVALUATION_FAILED',
): ScrollResult {
  return immutableResult({
    status: 'PARTIAL',
    reason,
    observations: state.observations,
    omittedObservationCount: 0,
    heightGrowthCount: state.heightGrowthCount,
    targetSwitchCount: state.targetSwitchCount,
    restoration,
    innerScrollScan: state.innerScrollScan,
    ...innerContainersOf(state, innerFallback),
    finalSnapshot: state.observations.at(-1) ?? null,
  });
}

function innerContainersOf(
  state: ScrollProgressState,
  fallback: InnerScrollStopReason,
): { readonly innerScrollContainers?: readonly InnerScrollContainerEvidence[] } {
  return state.innerContainersLocated
    ? { innerScrollContainers: state.innerContainers.map((record) => freezeInnerContainer(record, fallback)) }
    : {};
}

function completeBeforeDeadline(
  context: ScrollContext,
  reason: ScrollCompleteReason,
  state: ScrollProgressState,
  finalSnapshot: ScrollObservation,
  restoration: ScrollOriginRestoration,
): ScrollResult {
  if (pastDeadline(context)) {
    return partial('DEADLINE_EXCEEDED', state, restoration, 'DEADLINE_EXCEEDED');
  }
  const complete = immutableResult({
    status: 'COMPLETE',
    reason,
    observations: state.observations,
    omittedObservationCount: 0,
    heightGrowthCount: state.heightGrowthCount,
    targetSwitchCount: state.targetSwitchCount,
    restoration,
    innerScrollScan: state.innerScrollScan,
    ...innerContainersOf(state, 'EVALUATION_FAILED'),
    finalSnapshot,
  });
  return pastDeadline(context)
    ? partial('DEADLINE_EXCEEDED', state, restoration, 'DEADLINE_EXCEEDED')
    : complete;
}

/** 文書のスクロール位置を先頭へ戻す。期限を過ぎていれば、ブラウザ内の処理を始めずに記録だけ返す。 */
async function restoreOrigin(page: Page, context: ScrollContext): Promise<ScrollOriginRestoration> {
  if (page.isClosed()) {
    return notRestored('PAGE_CLOSED');
  }
  if (pastDeadline(context)) {
    return notRestored('DEADLINE_EXCEEDED');
  }
  const restored = await call(context, page.evaluate(scrollDocumentToOriginInPage, {
    phase: 'RESTORE',
    absoluteDeadlineMs: inPageDeadlineOf(context),
    awaitFrame: false,
  } satisfies OriginArgument));
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
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function readDocumentScrollPositionReader(R: StandardReaders): ScrollPosition {
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="body">` など）は、`document` の同じ名前のプロパティを隠すので、
  // `Document.prototype` の getter で読む（部品の `documentProperty`。`src/browser/in-page-readers.ts`。CC-068）。html・body は、名前つきの子で隠れない。
  const { documentProperty } = R;
  const root = documentProperty<Element | null>('scrollingElement') ?? documentProperty<HTMLElement>('documentElement');
  const body = documentProperty<HTMLElement | null>('body');
  const separateBody = body !== null && body !== root ? body : null;
  return {
    scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateBody?.scrollTop ?? 0),
  };
}
const readDocumentScrollPositionInPage = composeInPage(readDocumentScrollPositionReader);

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
  context: ScrollContext,
  lockedTarget: ScrollTarget | null,
  previousHeight: number | undefined,
): Promise<MeasureOutcome> {
  const evaluated = await call(context, page.evaluate(measureScrollInPage, {
    phase: 'MEASURE',
    lockedTarget,
    epsilonPx: SCROLL_EPSILON_PX,
  } satisfies MeasureArgument));
  if (evaluated.status === 'REJECTED') {
    return { status: 'REJECTED' };
  }
  if (evaluated.status === 'DEADLINE_EXCEEDED') {
    return { status: 'DEADLINE_EXCEEDED' };
  }
  const observedAtMs = Date.now();
  if (pastDeadline(context, observedAtMs)) {
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
      heightGrew: heightGrewFrom(previousHeight, state.scrollHeight),
      atBottom: isAtScrollBottom(state.scrollY, state.viewportHeight, state.scrollHeight),
    },
  };
}

type InnerScrollScanOutcome =
  | Readonly<{ status: 'SCANNED'; scan: Readonly<InnerScrollScan> }>
  | Readonly<{ status: 'FAILED'; reason: PartialFailureReason }>;

/** 内側のスクロール領域を探す（L9: 数の上限なし）。 */
async function scanInnerScrollContainers(page: Page, context: ScrollContext): Promise<InnerScrollScanOutcome> {
  const evaluated = await call(context, page.evaluate(scanInnerScrollContainersInPage, {
    phase: 'INNER_SCROLL_SCAN',
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  } satisfies InnerScrollScanArgument));
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

/** L9: `scope` の要素（`null` なら文書）の作りの印を読む。読めなければ `null`。 */
async function readStructureSignatures(
  page: Page,
  context: ScrollContext,
  scope: ElementHandle<Element> | null,
): Promise<readonly string[] | null> {
  const read = await call(context, scope === null
    ? page.evaluate(structureSignaturesInPage, null)
    : scope.evaluate(structureSignaturesInPage));
  return read.status === 'FULFILLED' && isSignatureList(read.value) ? read.value : null;
}

/** 位置（`elementPathOf` の並び）を CSS の selector にする（最初の段は文書の根の要素）。 */
const selectorOfPath = (path: readonly number[]): string =>
  [':root', ...path.slice(1).map((index) => `:nth-child(${String(index + 1)})`)].join(' > ');

/** 内側のスクロール領域を、元の位置 `originTop` へ戻す（DEF-207）。戻せたかを返す（確かめられなければ `null`）。 */
async function restoreInnerOrigin(
  page: Page,
  container: ElementHandle<Element>,
  originTop: number,
  context: ScrollContext,
): Promise<boolean | null> {
  if (page.isClosed() || stopped(context)) {
    return null;
  }
  const restored = await call(context, container.evaluate(restoreInnerScrollInPage, {
    phase: 'INNER_RESTORE',
    top: originTop,
    absoluteDeadlineMs: inPageDeadlineOf(context),
  } satisfies InnerRestoreArgument));
  if (restored.status !== 'FULFILLED' || restored.value === 'DEADLINE_EXCEEDED' || !Number.isFinite(restored.value)) {
    return null;
  }
  return Math.abs(restored.value - originTop) <= SCROLL_EPSILON_PX;
}

/** 止めた理由（ページが閉じた・期限・見張り・読み取りの失敗）を、内側の領域の止めた理由にする。 */
const innerStopOf = (page: Page, context: ScrollContext, failed: 'REJECTED' | 'DEADLINE_EXCEEDED'): InnerScrollStopReason => {
  if (failed === 'DEADLINE_EXCEEDED' || pastDeadline(context)) {
    return 'DEADLINE_EXCEEDED';
  }
  return page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED';
};

/**
 * 内側のスクロール領域 1 つを、文書と同じ決まり（1 回の動きの量、落ち着きの待ち、作りの印での止め方）でたどり、最後に元の位置へ戻す（DEF-207・L9）。
 * 要素の特定と動かす操作は、文書と同じ world（`page.evaluateHandle` と `ElementHandle.evaluate`）で行い、クリックや入力はしない。途中の記録は `record` に入れる。
 */
async function traverseInnerScrollContainer(
  page: Page,
  container: ElementHandle<Element>,
  context: ScrollContext,
  options: ControlledScrollOptions,
  record: MutableInnerContainerRecord,
): Promise<void> {
  const path = await call(context, container.evaluate(containerPathInPage));
  if (path.status === 'FULFILLED' && Array.isArray(path.value) && path.value.every((step) => isNonNegativeSafeInteger(step))) {
    record.selector = selectorOfPath(path.value);
  }
  const seenStructure = new Set<string>();
  let step: ScrollStepState = INITIAL_SCROLL_STEP_STATE;
  const finish = async (reason: InnerScrollStopReason): Promise<void> => {
    record.stopReason = reason;
    if (record.originTop !== null) {
      record.restored = await restoreInnerOrigin(page, container, record.originTop, context);
    }
  };
  // 伸び続ける領域の止め方（作りの印）。期限を受けたとき（今までの決まり）は使わない。
  const structureStop = !hasDeadline(context);
  if (structureStop) {
    const initial = await readStructureSignatures(page, context, container);
    if (initial !== null) {
      scrollStructureSignaturesOf(seenStructure, initial);
    }
  }
  while (!stopped(context)) {
    const evaluated = await call(context, container.evaluate(measureInnerScrollInPage, {
      phase: 'INNER_MEASURE',
    } satisfies InnerMeasureArgument));
    if (evaluated.status !== 'FULFILLED') {
      await finish(innerStopOf(page, context, evaluated.status));
      return;
    }
    const observedAtMs = Date.now();
    const state: unknown = evaluated.value;
    if (!isRawInnerScrollMeasurement(state)) {
      await finish('EVALUATION_FAILED');
      return;
    }
    if (!state.connected) {
      await finish('DISCONNECTED');
      return;
    }
    const firstMeasurement = record.originTop === null;
    record.originTop ??= state.scrollTop;
    record.clientHeight = state.clientHeight;
    record.initialScrollHeight ??= state.scrollHeight;
    record.finalScrollHeight = state.scrollHeight;
    // 新しい位置か高さを読んだときだけ、中身の進みの印を付ける。
    if (firstMeasurement || record.maxScrollTop === null || state.scrollTop > record.maxScrollTop || state.scrollHeight !== step.previousHeight) {
      context.markProgress();
    }
    record.maxScrollTop = Math.max(record.maxScrollTop ?? state.scrollTop, state.scrollTop);
    const measurement: ScrollStepMeasurement = {
      atMs: observedAtMs, position: state.scrollTop, viewportHeight: state.clientHeight, scrollHeight: state.scrollHeight, canAdvance: true,
    };
    // 最下部の近くで読み込まれた内容が、新しい作りを出さなければ止める（伸び続ける画面）。
    let newStructure: boolean | undefined;
    if (structureStop && scrollStructureCheckNeeded(step, measurement)) {
      const read = await readStructureSignatures(page, context, container);
      newStructure = read === null ? undefined : scrollStructureSignaturesOf(seenStructure, read);
    }
    const judged = scrollStep(step, measurement, options, newStructure);
    if (judged.heightGrew) {
      record.heightGrowthCount += 1;
    }
    if (judged.verdict.kind === 'NO_NEW_STRUCTURE' || judged.verdict.kind === 'NOT_ADVANCED') {
      await finish(judged.verdict.kind);
      return;
    }
    record.reachedBottom ||= judged.atBottom;
    if (judged.verdict.kind === 'BOTTOM_STABLE') {
      await finish('BOTTOM_AND_HEIGHT_STABLE');
      return;
    }
    step = judged.state;
    const top = judged.verdict.top;
    const moved = await call(context, container.evaluate(stepInnerScrollInPage, {
      phase: 'INNER_STEP',
      top,
      absoluteDeadlineMs: inPageDeadlineOf(context),
    } satisfies InnerStepArgument));
    if (moved.status !== 'FULFILLED') {
      await finish(innerStopOf(page, context, moved.status));
      return;
    }
    if (moved.value === 'DEADLINE_EXCEEDED') {
      await finish('DEADLINE_EXCEEDED');
      return;
    }
    if (top > state.scrollTop) {
      record.stepCount += 1;
    }
    await pause(context, options.stepWaitMs);
  }
  if (record.stopReason === null && hasDeadline(context)) {
    await finish('DEADLINE_EXCEEDED');
  }
}

/**
 * L9（COV-5・AUD-5）: 見つけた全部の内側のスクロール領域を、文書の順に、1 つずつたどる。内側の量が文書の量以下でも、たどる。どれか 1 つでも
 * たどり終えなかった（`BOTTOM_AND_HEIGHT_STABLE`・`NO_NEW_STRUCTURE` のほか）ら、`INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返す（ほかの領域は続けてたどる）。
 */
async function traverseAllInnerScrollContainers(
  page: Page,
  context: ScrollContext,
  options: ControlledScrollOptions,
  state: ScrollProgressState,
): Promise<'TRAVERSED' | ControlledScrollPartialReason> {
  const located = await call(context, page.evaluateHandle(scanInnerScrollContainersInPage, {
    phase: 'INNER_SCROLL_LOCATE',
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  } satisfies InnerScrollScanArgument));
  if (located.status === 'REJECTED') {
    return pageFailureReason(page);
  }
  if (located.status === 'DEADLINE_EXCEEDED') {
    return 'DEADLINE_EXCEEDED';
  }
  const list: JSHandle = located.value;
  const handles: ElementHandle<Element>[] = [];
  try {
    const properties = await call(context, list.getProperties());
    if (properties.status !== 'FULFILLED') {
      return properties.status === 'DEADLINE_EXCEEDED' ? 'DEADLINE_EXCEEDED' : pageFailureReason(page);
    }
    for (const [name, property] of [...properties.value.entries()].sort(([left], [right]) => Number(left) - Number(right))) {
      const element = /^\d+$/u.test(name) ? property.asElement() as ElementHandle<Element> | null : null;
      if (element === null) {
        void property.dispose().catch(() => undefined);
      } else {
        handles.push(element);
      }
    }
    // 見つけた全部の領域の記録を先に作る（途中で止まっても、たどらなかった領域が記録に残る）。
    const records = handles.map((): MutableInnerContainerRecord => ({
      selector: null,
      originTop: null,
      clientHeight: null,
      initialScrollHeight: null,
      finalScrollHeight: null,
      maxScrollTop: null,
      reachedBottom: false,
      stepCount: 0,
      heightGrowthCount: 0,
      stopReason: null,
      restored: null,
    }));
    for (const record of records) {
      state.innerContainers.push(record);
    }
    state.innerContainersLocated = true;
    for (const [index, handle] of handles.entries()) {
      const record = records[index] as MutableInnerContainerRecord;
      if (stopped(context)) {
        // 期限で止めたときは、たどらなかった領域にも理由を書く（見張りが終えたときは、結果を作るときに、見張りの理由を書く）。
        if (context.signal?.aborted !== true) {
          record.stopReason = 'DEADLINE_EXCEEDED';
        }
        continue;
      }
      await traverseInnerScrollContainer(page, handle, context, options, record);
    }
  } finally {
    // 手放すのを待たない（ページが止まっていても待たない）。
    void list.dispose().catch(() => undefined);
    for (const handle of handles) {
      void handle.dispose().catch(() => undefined);
    }
  }
  const notTraversed = state.innerContainers.some((record) =>
    record.stopReason !== 'BOTTOM_AND_HEIGHT_STABLE' && record.stopReason !== 'NO_NEW_STRUCTURE');
  return notTraversed ? 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED' : 'TRAVERSED';
}

/**
 * 文書のスクロール位置を戻した結果と、内側の領域を戻した結果をまとめる（DEF-207・L9）。文書を戻せなかったときは文書の記録を、
 * 文書を戻せて内側の領域のどれかを戻せなかったときは `POSITION_NOT_AT_ORIGIN` を残す。
 */
function combineRestorations(documentRestoration: ScrollOriginRestoration, state: ScrollProgressState): ScrollOriginRestoration {
  if (documentRestoration.status === 'NOT_RESTORED') {
    return documentRestoration;
  }
  return state.innerContainers.some((record) => record.restored === false) ? notRestored('POSITION_NOT_AT_ORIGIN') : documentRestoration;
}

/**
 * 文書と body のうち、測定の時点でたどっていない候補と、そのスクロールできる量。
 * 対象が決まっていない場合は、量の大きいほう（同じなら文書。`measureScrollReader` の選び方と同じ）。
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

/** 見張りが段を終えた理由を、scroll の記録の理由にする（Run の時間の上限は期限切れ）。 */
const scrollEndReasonOf = (end: CollectorWatchEnd): ControlledScrollPartialReason & InnerScrollStopReason => end;

export async function controlledScroll(page: Page, options: ControlledScrollOptions): Promise<ScrollResult> {
  validateOptions(options);
  const state: ScrollProgressState = {
    observations: [],
    heightGrowthCount: 0,
    targetSwitchCount: 0,
    innerScrollScan: null,
    innerContainers: [],
    innerContainersLocated: false,
  };
  if (options.deadlineAtMs !== undefined && options.progress === undefined) {
    return scrollDocument(page, options, { deadlineAtMs: options.deadlineAtMs, signal: null, markProgress: () => undefined }, state);
  }
  // L9: 期限を置かずに、進みの見張りで待つ。ブラウザの呼び出しは返るたびに印を付けず（`track` を使わない）、新しい値を読んだときだけ印を付ける。
  const caller = options.progress;
  const outcome = await watchCollection(
    page,
    (signals) => scrollDocument(page, options, {
      deadlineAtMs: options.deadlineAtMs,
      signal: signals.signal,
      markProgress: () => signals.mark('BROWSER_RESPONSE'),
    }, state),
    caller === undefined
      ? { quietLimitMs: options.quietLimitMs }
      : { progress: Object.freeze({ signal: caller.signal, mark: caller.mark, track: <T>(operation: PromiseLike<T>): Promise<T> => Promise.resolve(operation) }) },
  );
  switch (outcome.status) {
    case 'FULFILLED':
      return outcome.value;
    case 'REJECTED':
      return partial('EVALUATION_FAILED', state, notRestored('EVALUATION_FAILED'));
    case 'ENDED': {
      // 見張りが段を終えた（全く反応がない・静まらない・Run の時間の上限）。戻すのは待たず（止まったページを待たない）、それまでの記録を返す。
      const reason = scrollEndReasonOf(outcome.end);
      return partial(reason, state, notRestored(reason), reason);
    }
  }
}

/** 文書（か body）をたどり、続けて内側の領域を全部たどる（`controlledScroll` の本体）。 */
async function scrollDocument(
  page: Page,
  options: ControlledScrollOptions,
  context: ScrollContext,
  state: ScrollProgressState,
): Promise<ScrollResult> {
  const { stepWaitMs } = options;

  if (page.isClosed()) {
    return partial('PAGE_CLOSED', state, notRestored('PAGE_CLOSED'));
  }

  const reset = await call(context, page.evaluate(scrollDocumentToOriginInPage, {
    phase: 'RESET',
    absoluteDeadlineMs: inPageDeadlineOf(context),
    awaitFrame: true,
  } satisfies OriginArgument));
  if (reset.status === 'REJECTED') {
    const reason = pageFailureReason(page);
    return partial(reason, state, notRestored(reason));
  }
  if (reset.status === 'DEADLINE_EXCEEDED' || reset.value === 'DEADLINE_EXCEEDED') {
    return partial('DEADLINE_EXCEEDED', state, notRestored('DEADLINE_EXCEEDED'));
  }
  context.markProgress();

  // 部分結果を返す前にも、先頭へ戻すことを試み、その結果を記録する。
  const finish = async (reason: ControlledScrollPartialReason): Promise<ScrollResult> =>
    partial(reason, state, combineRestorations(await restoreOrigin(page, context), state));

  // L9: 伸び続ける画面の止め方（作りの印）。期限を受けたとき（今までの決まり）は使わない。
  const structureStop = !hasDeadline(context);
  const seenStructure = new Set<string>();
  if (structureStop) {
    const initial = await readStructureSignatures(page, context, null);
    if (initial !== null) {
      scrollStructureSignaturesOf(seenStructure, initial);
    }
  }
  // L9（N15）: 完了の前に切り替えた対象と、そのときの量（同じ対象を同じ量で 2 度たどることになったら、揺れ続ける画面として止める）。
  const switchedStates = new Set<string>();

  let lockedTarget: ScrollTarget | null = null;
  let step: ScrollStepState = INITIAL_SCROLL_STEP_STATE;
  let advanced = false;
  let maxScrollY = -1;
  while (!stopped(context)) {
    const measured = await measure(page, context, lockedTarget, step.previousHeight);
    if (measured.status === 'REJECTED') {
      return finish(pageFailureReason(page));
    }
    if (measured.status === 'DEADLINE_EXCEEDED') {
      return finish('DEADLINE_EXCEEDED');
    }
    const observation = measured.observation;
    state.observations.push(observation);
    // 新しい位置か高さを読んだときだけ、中身の進みの印を付ける（同じ値の繰り返しは進みに数えない）。
    if (observation.scrollY > maxScrollY || (step.previousHeight !== undefined && observation.scrollHeight !== step.previousHeight)) {
      context.markProgress();
    }
    maxScrollY = Math.max(maxScrollY, observation.scrollY);
    lockedTarget ??= observation.scrollTarget;
    if (observation.scrollY > SCROLL_EPSILON_PX) {
      advanced = true;
    }
    const contentExceedsViewport = observation.contentHeight > observation.viewportHeight + SCROLL_EPSILON_PX;
    if (observation.scrollTarget === null && contentExceedsViewport) {
      return finish('SCROLL_TARGET_UNRESOLVED');
    }
    const measurement: ScrollStepMeasurement = {
      atMs: observation.observedAtMs,
      position: observation.scrollY,
      viewportHeight: observation.viewportHeight,
      scrollHeight: observation.scrollHeight,
      canAdvance: observation.scrollTarget !== null,
    };
    // L9: 最下部の近くで読み込まれた内容が、新しい作りを出さなければ止める（伸び続ける画面）。
    let newStructure: boolean | undefined;
    if (structureStop && scrollStructureCheckNeeded(step, measurement)) {
      const read = await readStructureSignatures(page, context, null);
      newStructure = read === null ? undefined : scrollStructureSignaturesOf(seenStructure, read);
      if (newStructure !== false) {
        context.markProgress();
      }
    }
    const judged = scrollStep(step, measurement, options, newStructure);
    if (judged.verdict.kind === 'NOT_ADVANCED') {
      return finish('SCROLL_NOT_ADVANCED');
    }
    if (judged.heightGrew) {
      state.heightGrowthCount += 1;
    }
    if (judged.verdict.kind !== 'STEP') {
      if (judged.verdict.kind === 'BOTTOM_STABLE' && !advanced && contentExceedsViewport) {
        return finish('SCROLL_NOT_ADVANCED');
      }
      const endReason: ScrollCompleteReason = judged.verdict.kind === 'NO_NEW_STRUCTURE' ? 'NO_NEW_STRUCTURE' : 'BOTTOM_AND_HEIGHT_STABLE';
      // 内側のスクロール領域を探し、記録する（R4 の N1）。
      const scanned = await scanInnerScrollContainers(page, context);
      if (scanned.status === 'FAILED') {
        return finish(scanned.reason);
      }
      state.innerScrollScan = scanned.scan;
      const traversedRange = observation.scrollTarget === null
        ? 0
        : observation.scrollHeight - observation.viewportHeight;
      const innerRange = state.innerScrollScan.representative === null
        ? 0
        : state.innerScrollScan.representative.scrollHeight - state.innerScrollScan.representative.clientHeight;
      // 完了と判定する前に、候補のスクロールできる量を比べ直す（R'2 の I-1）。たどっていないほう（文書か body）が大きくなっていれば、対象を
      // 切り替えてたどり直す。L9: 回数で止めず、同じ対象を同じ量でもう一度たどることになったら、揺れ続ける画面として止める。
      const alternative = alternativeDocumentTarget(observation);
      if (
        endReason === 'BOTTOM_AND_HEIGHT_STABLE'
        && alternative.range > SCROLL_EPSILON_PX
        && alternative.range > traversedRange
        && (hasDeadline(context) ? alternative.range >= innerRange : true)
      ) {
        const switchState = `${alternative.target}:${String(alternative.range)}`;
        if (hasDeadline(context) ? state.targetSwitchCount >= MAX_SCROLL_TARGET_SWITCHES : switchedStates.has(switchState)) {
          return finish('SCROLL_TARGET_UNSTABLE');
        }
        switchedStates.add(switchState);
        state.targetSwitchCount += 1;
        lockedTarget = alternative.target;
        step = INITIAL_SCROLL_STEP_STATE;
        advanced = false;
        maxScrollY = -1;
        continue;
      }
      // DEF-207・L9: 見つけた全部の内側の領域を、文書と同じ決まりでたどり、元の位置へ戻す。期限を受けたとき（今までの決まり）は、内側の領域が
      // 文書より大きくスクロールできるときだけたどる。
      if (state.innerScrollScan.containerCount > 0 && (!hasDeadline(context) || innerRange > traversedRange)) {
        const traversal = await traverseAllInnerScrollContainers(page, context, options, state);
        if (traversal !== 'TRAVERSED') {
          return finish(traversal);
        }
      }
      if (context.signal?.aborted === true) {
        return finish('DEADLINE_EXCEEDED');
      }
      const restoration = combineRestorations(await restoreOrigin(page, context), state);
      return completeBeforeDeadline(context, endReason, state, observation, restoration);
    }
    step = judged.state;
    const moved = await call(context, page.evaluate(stepScrollInPage, {
      phase: 'STEP',
      target: observation.scrollTarget,
      top: judged.verdict.top,
      absoluteDeadlineMs: inPageDeadlineOf(context),
    } satisfies StepArgument));
    if (moved.status === 'REJECTED') {
      return finish(pageFailureReason(page));
    }
    if (moved.status === 'DEADLINE_EXCEEDED' || moved.value === 'DEADLINE_EXCEEDED') {
      return finish('DEADLINE_EXCEEDED');
    }
    await pause(context, stepWaitMs);
  }

  return finish('DEADLINE_EXCEEDED');
}
