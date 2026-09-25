import type { Page } from 'playwright';
import { pageFailureReason } from '../browser/page-failure.js';
import type { Viewport } from '../config/types.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  FIXED_ELEMENT_POSITIONS,
  HORIZONTAL_CLIP_ANCESTOR_KINDS,
  LAYOUT_ELEMENT_KINDS,
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type ClippedTextEvidence,
  type FixedElementEvidence,
  type FixedElementPosition,
  type FixedHeadingOverlapEvidence,
  type HorizontalClipAncestorKind,
  type LayoutCollectionResult,
  type LayoutDocumentEvidence,
  type LayoutElementEvidence,
  type LayoutElementKind,
  type LayoutEvidence,
  type LayoutIncompleteReason,
  type LayoutTruncationEvidence,
  type OutsideViewportEvidence,
  type RectangleEvidence,
  type ScrollPosition,
  type StressLayoutEvidence,
  type StressLayoutFailureReason,
  type StressLayoutFailureStage,
  type VisibilityEvidence,
  type ZeroSizeInteractiveEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeFiniteNumber, isNonNegativeSafeInteger, isPositiveFiniteNumber } from '../core/guards.js';
import {
  GEOMETRY_EPSILON_PX,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_SELECTOR_DEPTH,
  MAX_SELECTOR_LENGTH,
} from '../core/limits.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';

export const LAYOUT_THRESHOLDS = Object.freeze({
  stressViewportHeight: 900,
  minOcclusionAreaPx2: 1,
  maxZeroSizeDimensionPx: 0,
  geometryEpsilonPx: GEOMETRY_EPSILON_PX,
  maxOutsideViewportCandidates: 100,
  maxZeroSizeInteractiveCandidates: 100,
  maxClippedTextCandidates: 100,
  maxFixedHeadingOverlapCandidates: 100,
  /** 記録する主要要素どうしの重なりの候補の最大件数。超えた分は件数だけを記録する。 */
  maxElementOverlapCandidates: 100,
  /** 記録する固定要素（`position: fixed | sticky`）の最大件数。超えた分は件数だけを記録する。 */
  maxFixedElementCandidates: 100,
  /** 重なりの走査の1回（固定要素と見出し、主要要素どうし）で比べる組の最大数。超えたら走査を止め、その事実を記録する。 */
  maxOverlapComparisons: 200_000,
  maxClippedTextLength: 256,
  /**
   * 見切れの候補1つあたり、`partiallyClippedText` を判定するために走査する、子孫のテキストのノードの最大数（空白だけのノードも数える）。
   * 超えた場合は判定できないものとして false にし、その件数を記録する。候補の上限（`maxClippedTextCandidates`）と掛けた値が、1ページの走査の上限になる。
   */
  maxClippedTextNodeScan: 256,
  /**
   * `partiallyClippedText` の判定で、箱と交わるテキストの行を、縦方向に「切り取られている」とみなす、箱の外に出た量の割合の下限（この値を含まない）。
   * 割合は、行の矩形の高さに対して計る。行の矩形はフォントの内容領域の高さを持ち、行の高さより大きいことがあるので、
   * 行の高さが小さい文章で、行の矩形が箱の上下にわずかに出るだけの場合を除くため、4分の1を超える場合に限る（設計書 5.1.2、RT12r の N1）。
   * 箱の上に出た量と下に出た量は、別々にこの割合と比べ、合計しない（RT12r2 の I1。合計すると、1行の箱で誤って報告するため）。
   */
  clippedTextLineMinOutsideRatio: 0.25,
  /**
   * `partiallyClippedText` の判定で、箱と交わるテキストの行を、横方向に「切り取られている」とみなさない、箱の外に出た量の上限（px。この値を含む）。
   * 横方向には、フォントの内容領域と行の高さのずれがないので、割合ではなく、文字の少しの張り出しだけを許す固定の値にする（設計書 5.1.2、RT12d の発見事項2）。
   * 縦方向と同じく、箱の左に出た量と右に出た量は、別々にこの値と比べる（RT12r2 の I1）。
   */
  clippedTextLineMaxIgnoredHorizontalOverflowPx: 2,
  /**
   * 大きさ0の操作要素の候補1つあたり、`hasRenderedDescendant` を判定するために走査する子孫の要素の最大数。
   * 超えた場合は判定できないものとして false にし、その件数を記録する。
   */
  maxRenderedDescendantScan: 256,
  /** 描画された子孫とみなさない、子孫の幅か高さの上限（px。この値を含む）。visually hidden の要素を数えないため（RT12r の N5）。 */
  maxUnrenderedDescendantDimensionPx: VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  maxSelectorLength: MAX_SELECTOR_LENGTH,
  maxSelectorDepth: MAX_SELECTOR_DEPTH,
  viewportMatchTolerancePx: 0,
  minViewportIntersectionDimensionPx: 0,
  /** 期限を指定されなかったときの、1回の layout の収集の期限（ミリ秒）。 */
  defaultTimeoutMs: 10_000,
  /** ブラウザ内の走査を、期限のこの時間前に止める（部分結果を期限までに Node 側へ返すための時間。ミリ秒）。 */
  partialResultReserveMs: 250,
});

export const STRESS_VIEWPORT_HEIGHT = LAYOUT_THRESHOLDS.stressViewportHeight;

/**
 * 祖先の `overflow-x` の計算値ごとの、横方向の切り取りの種類（Task 12・13 の設計書 5.1.2）。ここにない値（`visible`）は切り取らない。
 * ブラウザ内の、祖先の overflow による切り取りの判定（重なりの候補、見切れの候補）も、このキーを切り取る overflow の一覧として使う。
 */
const HORIZONTAL_CLIP_BY_OVERFLOW = Object.freeze({
  hidden: 'CLIPPED',
  clip: 'CLIPPED',
  auto: 'SCROLLABLE',
  scroll: 'SCROLLABLE',
} as const satisfies Readonly<Record<string, Exclude<HorizontalClipAncestorKind, 'NONE'>>>);

/** 主要要素の種類を決める selector。上から順に当てはめる（`input[type=submit]` は `button` になる）。 */
const LAYOUT_ELEMENT_KIND_SELECTORS: readonly (readonly [Exclude<LayoutElementKind, 'other'>, string])[] = Object.freeze([
  ['heading', 'h1, h2, h3, h4, h5, h6, [role="heading"]'],
  ['paragraph', 'p'],
  ['image', 'img, svg, [role="img"]'],
  [
    'button',
    'button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], [role="button"]',
  ],
  ['link', 'a[href], [role="link"]'],
  ['input', 'input, select, textarea'],
  ['table', 'table'],
  ['media', 'iframe, video, embed, object, canvas'],
] as const);

export interface LayoutCollectionOptions {
  /** 収集の期限（`Date.now()` の絶対時刻）。省略時は呼び出し時点から `defaultTimeoutMs` 後。 */
  readonly deadlineAtMs: number;
}

type RawLayoutElementEvidence = Omit<LayoutElementEvidence, 'area'>;

interface RawElementOverlapEvidence {
  readonly first: RawLayoutElementEvidence;
  readonly second: RawLayoutElementEvidence;
  readonly intersection: RectangleEvidence & { readonly area: number };
  readonly truncated: boolean;
}

interface RawFixedElementEvidence extends RawLayoutElementEvidence {
  readonly truncated: boolean;
}

interface RawLayoutEvidence {
  readonly scrollPosition: ScrollPosition;
  readonly document: LayoutDocumentEvidence;
  readonly boxesOutsideViewport: readonly OutsideViewportEvidence[];
  readonly zeroSizeInteractive: readonly ZeroSizeInteractiveEvidence[];
  readonly clippedText: readonly ClippedTextEvidence[];
  readonly fixedHeadingOverlaps: readonly FixedHeadingOverlapEvidence[];
  readonly elementOverlaps: readonly RawElementOverlapEvidence[];
  readonly fixedElements: readonly RawFixedElementEvidence[];
  readonly truncation: LayoutTruncationEvidence;
  /** ブラウザ内の走査が止まった理由（期限だけ）。比べる組の上限は `truncation.overlapComparisonLimitReached` で返す。 */
  readonly incompleteReason: BrowserLayoutIncompleteReason | null;
}

type BrowserLayoutIncompleteReason = Extract<LayoutIncompleteReason, 'DEADLINE_EXCEEDED'>;

export interface PassiveStressSession {
  readonly page: Page;
  close(): Promise<void>;
}

export type PassiveStressSessionFactory = (viewport: Viewport) => Promise<PassiveStressSession>;

export interface StressLayoutOptions {
  /** すべての幅の収集の期限（`Date.now()` の絶対時刻）。省略時は呼び出し時点から、幅の数 × `defaultTimeoutMs` 後。 */
  readonly deadlineAtMs: number;
}

function positiveFiniteDimension(value: number, name: string): void {
  if (!isPositiveFiniteNumber(value)) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid non-finite browser geometry: ${name}`);
  }
}

function nonnegative(value: number, name: string): void {
  if (isNonNegativeFiniteNumber(value)) {
    return;
  }
  finite(value, name);
  throw new Error(`Invalid negative browser geometry: ${name}`);
}

function count(value: number, name: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`Invalid browser layout count: ${name}`);
  }
  return value;
}

function flag(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid browser layout flag: ${name}`);
  }
  return value;
}

function freezeRect(rect: RectangleEvidence, name: string): RectangleEvidence {
  finite(rect.x, `${name}.x`);
  finite(rect.y, `${name}.y`);
  finite(rect.top, `${name}.top`);
  finite(rect.right, `${name}.right`);
  finite(rect.bottom, `${name}.bottom`);
  finite(rect.left, `${name}.left`);
  nonnegative(rect.width, `${name}.width`);
  nonnegative(rect.height, `${name}.height`);
  return Object.freeze({ ...rect });
}

function freezeIntersection(
  intersection: RectangleEvidence & { readonly area: number },
  name: string,
): RectangleEvidence & { readonly area: number } {
  nonnegative(intersection.area, `${name}.area`);
  return Object.freeze({ ...freezeRect(intersection, name), area: intersection.area });
}

function freezeVisibility(visibility: VisibilityEvidence, name: string): VisibilityEvidence {
  finite(visibility.opacity, `${name}.opacity`);
  nonnegative(visibility.clientRectCount, `${name}.clientRectCount`);
  return Object.freeze({ ...visibility });
}

function validateSelector(selector: string, name: string): string {
  if (selector.length === 0 || selector.length > LAYOUT_THRESHOLDS.maxSelectorLength) {
    throw new Error(`Invalid or unbounded browser selector: ${name}`);
  }
  return selector;
}

function validateKind(kind: LayoutElementKind, name: string): LayoutElementKind {
  if (!(LAYOUT_ELEMENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid browser layout element kind: ${name}`);
  }
  return kind;
}

function validateHorizontalClipAncestor(kind: HorizontalClipAncestorKind, name: string): HorizontalClipAncestorKind {
  if (!(HORIZONTAL_CLIP_ANCESTOR_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid browser layout horizontalClipAncestor: ${name}`);
  }
  return kind;
}

/** 一覧の中の祖先の番号。null か、一覧の範囲の中の、自分以外の番号であること。 */
function validateListedAncestorIndex(index: number | null, ownIndex: number, listLength: number, name: string): number | null {
  if (index !== null && (!isNonNegativeSafeInteger(index) || index >= listLength || index === ownIndex)) {
    throw new Error(`Invalid browser layout nearestListedAncestorIndex: ${name}`);
  }
  return index;
}

/** 上限を超えて返された分を切り捨て、その件数を返す（ブラウザ内の上限の確認と二重に守る）。 */
function retain<T>(items: readonly T[], limit: number): { readonly retained: readonly T[]; readonly excess: number } {
  const retained = items.slice(0, limit);
  return { retained, excess: items.length - retained.length };
}

function freezeElement(element: RawLayoutElementEvidence, name: string): LayoutElementEvidence {
  const rect = freezeRect(element.rect, `${name}.rect`);
  return Object.freeze({
    selector: validateSelector(element.selector, name),
    kind: validateKind(element.kind, `${name}.kind`),
    rect,
    area: rect.width * rect.height,
    visibility: freezeVisibility(element.visibility, `${name}.visibility`),
    position: element.position,
    zIndex: element.zIndex,
    overflowX: element.overflowX,
    overflowY: element.overflowY,
    fixedOrStickyAncestor: flag(element.fixedOrStickyAncestor, `${name}.fixedOrStickyAncestor`),
  });
}

function freezeFixedElement(
  element: RawFixedElementEvidence,
  documentEvidence: LayoutDocumentEvidence,
  name: string,
): FixedElementEvidence {
  const position = FIXED_ELEMENT_POSITIONS.find((candidate) => candidate === element.position);
  if (position === undefined) {
    throw new Error(`Invalid browser fixed element position: ${name}`);
  }
  const facts = freezeElement(element, name);
  const { rect } = facts;
  const intersectionWidth = Math.max(0, Math.min(rect.right, documentEvidence.viewportWidth) - Math.max(rect.left, 0));
  const intersectionHeight = Math.max(
    0,
    Math.min(rect.bottom, documentEvidence.viewportHeight) - Math.max(rect.top, 0),
  );
  const viewportIntersectionArea = intersectionWidth * intersectionHeight;
  const viewportArea = documentEvidence.viewportWidth * documentEvidence.viewportHeight;
  return Object.freeze({
    ...facts,
    position,
    viewportIntersectionArea,
    viewportArea,
    viewportAreaRatio: viewportArea > 0 ? viewportIntersectionArea / viewportArea : 0,
    truncated: flag(element.truncated, `${name}.truncated`),
  });
}

function validateIncompleteReason(
  reason: BrowserLayoutIncompleteReason | null,
): BrowserLayoutIncompleteReason | null {
  if (reason !== null && reason !== 'DEADLINE_EXCEEDED') {
    throw new Error('Invalid browser layout incompleteReason');
  }
  return reason;
}

function freezeLayout(raw: RawLayoutEvidence): LayoutEvidence {
  finite(raw.scrollPosition.scrollX, 'scrollPosition.scrollX');
  finite(raw.scrollPosition.scrollY, 'scrollPosition.scrollY');
  const scrollPosition = Object.freeze({
    scrollX: raw.scrollPosition.scrollX,
    scrollY: raw.scrollPosition.scrollY,
  });
  const { viewportHorizontalClip, ...documentSizes } = raw.document;
  for (const [name, value] of Object.entries(documentSizes)) {
    if (name === 'horizontalOverflowPx') {
      finite(value, `document.${name}`);
    } else {
      nonnegative(value, `document.${name}`);
    }
  }
  const horizontalOverflowPx = Math.max(
    0,
    raw.document.documentElementScrollWidth,
    raw.document.bodyScrollWidth,
  ) - raw.document.viewportWidth;
  const documentEvidence = Object.freeze({
    ...raw.document,
    horizontalOverflowPx: Math.max(0, horizontalOverflowPx),
    viewportHorizontalClip: validateHorizontalClipAncestor(viewportHorizontalClip, 'document.viewportHorizontalClip'),
  });
  const outsideRetention = retain(raw.boxesOutsideViewport, LAYOUT_THRESHOLDS.maxOutsideViewportCandidates);
  const boxesOutsideViewport = Object.freeze(outsideRetention.retained
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `boxesOutsideViewport[${index}]`),
      kind: validateKind(candidate.kind, `boxesOutsideViewport[${index}].kind`),
      rect: freezeRect(candidate.rect, `boxesOutsideViewport[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `boxesOutsideViewport[${index}].visibility`),
      horizontalClipAncestor: validateHorizontalClipAncestor(
        candidate.horizontalClipAncestor,
        `boxesOutsideViewport[${index}]`,
      ),
      nearestListedAncestorIndex: validateListedAncestorIndex(
        candidate.nearestListedAncestorIndex,
        index,
        outsideRetention.retained.length,
        `boxesOutsideViewport[${index}]`,
      ),
      outside: Object.freeze({ ...candidate.outside }),
      truncated: flag(candidate.truncated, `boxesOutsideViewport[${index}].truncated`),
    })));
  const zeroSizeRetention = retain(raw.zeroSizeInteractive, LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates);
  const zeroSizeInteractive = Object.freeze(zeroSizeRetention.retained
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `zeroSizeInteractive[${index}]`),
      rect: freezeRect(candidate.rect, `zeroSizeInteractive[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `zeroSizeInteractive[${index}].visibility`),
      hasRenderedDescendant: flag(candidate.hasRenderedDescendant, `zeroSizeInteractive[${index}].hasRenderedDescendant`),
      truncated: flag(candidate.truncated, `zeroSizeInteractive[${index}].truncated`),
    })));
  const clippedRetention = retain(raw.clippedText, LAYOUT_THRESHOLDS.maxClippedTextCandidates);
  const clippedText = Object.freeze(clippedRetention.retained
    .map((candidate, index) => {
      nonnegative(candidate.clientWidth, `clippedText[${index}].clientWidth`);
      nonnegative(candidate.clientHeight, `clippedText[${index}].clientHeight`);
      nonnegative(candidate.scrollWidth, `clippedText[${index}].scrollWidth`);
      nonnegative(candidate.scrollHeight, `clippedText[${index}].scrollHeight`);
      const text = candidate.text.slice(0, LAYOUT_THRESHOLDS.maxClippedTextLength);
      return Object.freeze({
        ...candidate,
        selector: validateSelector(candidate.selector, `clippedText[${index}]`),
        text,
        rect: freezeRect(candidate.rect, `clippedText[${index}].rect`),
        visibility: freezeVisibility(candidate.visibility, `clippedText[${index}].visibility`),
        partiallyClippedText: flag(candidate.partiallyClippedText, `clippedText[${index}].partiallyClippedText`),
        truncated: flag(candidate.truncated, `clippedText[${index}].truncated`) || text.length < candidate.text.length,
      });
    }));
  const fixedHeadingRetention = retain(raw.fixedHeadingOverlaps, LAYOUT_THRESHOLDS.maxFixedHeadingOverlapCandidates);
  const fixedHeadingOverlaps = Object.freeze(fixedHeadingRetention.retained
    .map((candidate, index) => Object.freeze({
      ...candidate,
      overlaySelector: validateSelector(candidate.overlaySelector, `fixedHeadingOverlaps[${index}].overlay`),
      headingSelector: validateSelector(candidate.headingSelector, `fixedHeadingOverlaps[${index}].heading`),
      overlayRect: freezeRect(candidate.overlayRect, `fixedHeadingOverlaps[${index}].overlayRect`),
      headingRect: freezeRect(candidate.headingRect, `fixedHeadingOverlaps[${index}].headingRect`),
      overlayVisibility: freezeVisibility(
        candidate.overlayVisibility,
        `fixedHeadingOverlaps[${index}].overlayVisibility`,
      ),
      headingVisibility: freezeVisibility(
        candidate.headingVisibility,
        `fixedHeadingOverlaps[${index}].headingVisibility`,
      ),
      intersection: freezeIntersection(candidate.intersection, `fixedHeadingOverlaps[${index}].intersection`),
      truncated: flag(candidate.truncated, `fixedHeadingOverlaps[${index}].truncated`),
    })));
  const overlapRetention = retain(raw.elementOverlaps, LAYOUT_THRESHOLDS.maxElementOverlapCandidates);
  const elementOverlaps = Object.freeze(overlapRetention.retained
    .map((candidate, index) => Object.freeze({
      first: freezeElement(candidate.first, `elementOverlaps[${index}].first`),
      second: freezeElement(candidate.second, `elementOverlaps[${index}].second`),
      intersection: freezeIntersection(candidate.intersection, `elementOverlaps[${index}].intersection`),
      truncated: flag(candidate.truncated, `elementOverlaps[${index}].truncated`),
    })));
  const fixedRetention = retain(raw.fixedElements, LAYOUT_THRESHOLDS.maxFixedElementCandidates);
  const fixedElements = Object.freeze(fixedRetention.retained
    .map((candidate, index) => freezeFixedElement(candidate, documentEvidence, `fixedElements[${index}]`)));
  const truncation = raw.truncation;
  const omitted = (value: number, name: keyof LayoutTruncationEvidence, excess: number): number => (
    count(value, `truncation.${name}`) + excess
  );

  return Object.freeze({
    scrollPosition,
    document: documentEvidence,
    boxesOutsideViewport,
    zeroSizeInteractive,
    clippedText,
    fixedHeadingOverlaps,
    elementOverlaps,
    fixedElements,
    truncation: Object.freeze({
      omittedOutsideViewportCount: omitted(
        truncation.omittedOutsideViewportCount,
        'omittedOutsideViewportCount',
        outsideRetention.excess,
      ),
      omittedZeroSizeInteractiveCount: omitted(
        truncation.omittedZeroSizeInteractiveCount,
        'omittedZeroSizeInteractiveCount',
        zeroSizeRetention.excess,
      ),
      omittedClippedTextCount: omitted(
        truncation.omittedClippedTextCount,
        'omittedClippedTextCount',
        clippedRetention.excess,
      ),
      omittedFixedHeadingOverlapCount: omitted(
        truncation.omittedFixedHeadingOverlapCount,
        'omittedFixedHeadingOverlapCount',
        fixedHeadingRetention.excess,
      ),
      omittedElementOverlapCount: omitted(
        truncation.omittedElementOverlapCount,
        'omittedElementOverlapCount',
        overlapRetention.excess,
      ),
      omittedFixedElementCount: omitted(
        truncation.omittedFixedElementCount,
        'omittedFixedElementCount',
        fixedRetention.excess,
      ),
      overlapComparisonLimitReached: flag(
        truncation.overlapComparisonLimitReached,
        'truncation.overlapComparisonLimitReached',
      ),
      clippedTextNodeScanLimitReachedCount: count(
        truncation.clippedTextNodeScanLimitReachedCount,
        'truncation.clippedTextNodeScanLimitReachedCount',
      ),
      renderedDescendantScanLimitReachedCount: count(
        truncation.renderedDescendantScanLimitReachedCount,
        'truncation.renderedDescendantScanLimitReachedCount',
      ),
    }),
  });
}

interface LayoutEvaluationArgument {
  readonly thresholds: typeof LAYOUT_THRESHOLDS;
  readonly visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
  readonly kindSelectors: typeof LAYOUT_ELEMENT_KIND_SELECTORS;
  /** 固定要素とみなす `position` の値（`FIXED_ELEMENT_POSITIONS`）。ブラウザ内では import できないため、引数で渡す。 */
  readonly fixedPositions: typeof FIXED_ELEMENT_POSITIONS;
  /** 祖先の `overflow-x` ごとの、横方向の切り取りの種類（`HORIZONTAL_CLIP_BY_OVERFLOW`）。 */
  readonly horizontalClipByOverflow: typeof HORIZONTAL_CLIP_BY_OVERFLOW;
  /** ブラウザ内の走査を止める時刻（`Date.now()` の絶対時刻）。 */
  readonly scanDeadlineAtMs: number;
}

/**
 * ブラウザ内で、上限付きのジオメトリの事実を1回の走査で集める。
 * 候補の件数は上限を確かめてから selector を作り、兄弟の順番は親ごとに1回だけ数える（要素数に比例する作業量）。
 * 期限を過ぎたら走査を止め、それまでに集めた事実と理由を返す。
 */
function collectLayoutInPage({
  thresholds,
  visibilityOptions,
  kindSelectors,
  fixedPositions,
  horizontalClipByOverflow,
  scanDeadlineAtMs,
}: LayoutEvaluationArgument): RawLayoutEvidence {
  const actualViewport = { width: window.innerWidth, height: window.innerHeight };
  // 文書のスクロール位置（`ScrollPosition` の定義）。`scrollingElement` ではない body のスクロール量を含める。
  const scrollingRoot = document.scrollingElement ?? document.documentElement;
  const separateScrollBody = document.body !== null && document.body !== scrollingRoot ? document.body : null;
  const scrollPosition = {
    scrollX: window.scrollX + (separateScrollBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateScrollBody?.scrollTop ?? 0),
  };
  let incompleteReason: 'DEADLINE_EXCEEDED' | null = null;
  const deadlinePassed = (): boolean => {
    if (incompleteReason === null && Date.now() >= scanDeadlineAtMs) {
      incompleteReason = 'DEADLINE_EXCEEDED';
    }
    return incompleteReason !== null;
  };
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  // 同じ親の子の `nth-of-type` の番号を、親ごとに1回だけ数えて覚える。
  const nthOfTypeIndexes = new Map<Element, number>();
  const nthOfType = (element: Element): number => {
    const known = nthOfTypeIndexes.get(element);
    if (known !== undefined) {
      return known;
    }
    const parent = element.parentElement;
    if (parent === null) {
      return 1;
    }
    const counts = new Map<string, number>();
    for (const child of parent.children) {
      const next = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, next);
      nthOfTypeIndexes.set(child, next);
    }
    return nthOfTypeIndexes.get(element) ?? 1;
  };
  const selectorFor = (element: Element): { selector: string; truncated: boolean } => {
    let selector: string;
    if (element.id.length > 0) {
      selector = `#${CSS.escape(element.id)}`;
    } else {
      const segments: string[] = [];
      let current: Element | null = element;
      while (
        current !== null
        && current !== document.documentElement
        && segments.length < thresholds.maxSelectorDepth
      ) {
        segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${nthOfType(current)})`);
        current = current.parentElement;
      }
      selector = segments.join(' > ');
    }
    return selector.length > thresholds.maxSelectorLength
      ? { selector: selector.slice(0, thresholds.maxSelectorLength), truncated: true }
      : { selector, truncated: false };
  };
  const rectFor = (element: Element): RectangleEvidence => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  };
  // 可視判定は checkVisibility だけで行う（設計書 foundation-corrections 5.5）。
  // 大きさが0であること（rect）と aria-hidden は、可視判定に含めず、別の項目として記録する。
  const visibilityFor = (element: Element, style: CSSStyleDeclaration, visible: boolean): VisibilityEvidence => ({
    visible,
    display: style.display,
    visibility: style.visibility,
    opacity: Number.parseFloat(style.opacity),
    hiddenAttribute: element instanceof HTMLElement ? element.hidden !== false : false,
    ariaHidden: element.getAttribute('aria-hidden') === 'true',
    clientRectCount: element.getClientRects().length,
  });
  const kindOf = (element: Element): LayoutElementKind => {
    for (const [kind, selector] of kindSelectors) {
      if (element.matches(selector)) {
        return kind;
      }
    }
    return 'other';
  };
  const isFixedOrSticky = (position: string): boolean => (fixedPositions as readonly string[]).includes(position);
  const intersectsViewport = (rect: RectangleEvidence): boolean => (
    Math.min(rect.right, actualViewport.width) - Math.max(rect.left, 0)
      > thresholds.minViewportIntersectionDimensionPx
    && Math.min(rect.bottom, actualViewport.height) - Math.max(rect.top, 0)
      > thresholds.minViewportIntersectionDimensionPx
  );
  const intersectionOf = (
    first: RectangleEvidence,
    second: RectangleEvidence,
  ): (RectangleEvidence & { area: number }) | null => {
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const area = width * height;
    return area >= thresholds.minOcclusionAreaPx2
      ? { x: left, y: top, top, right, bottom, left, width, height, area }
      : null;
  };

  // 祖先の overflow による切り取り（R4 の M3、RT12 の I1）。
  // - 祖先は、親から `maxSelectorDepth` 個までに限る（上限の外の祖先の切り取りは考慮しない）。
  // - html・body・`scrollingElement` は、ビューポートのスクロールとして扱い、祖先の切り取りに数えない。
  // - `position: fixed` の要素は、祖先の overflow で切り取られないものとして扱う（transform を持つ祖先の中の場合を除く近似）。
  // - `position: absolute` の要素は、包含ブロック（position が static でないか、transform を持つ祖先）とその祖先だけが切り取る。
  // - overflow が効かない箱（`display: inline`・`contents`）は、切り取りに数えない。
  const horizontalClipOf = (overflow: string): Exclude<HorizontalClipAncestorKind, 'NONE'> | undefined => (
    Object.hasOwn(horizontalClipByOverflow, overflow)
      ? horizontalClipByOverflow[overflow as keyof typeof horizontalClipByOverflow]
      : undefined
  );
  const clippingOverflows = new Set<string>(Object.keys(horizontalClipByOverflow));
  const documentScrollers = new Set<Element>([document.documentElement]);
  if (document.body !== null) {
    documentScrollers.add(document.body);
  }
  if (document.scrollingElement !== null) {
    documentScrollers.add(document.scrollingElement);
  }
  /** 要素を overflow で切り取りうる祖先と、その計算値を、近い順に返す（上の決まりに従う）。`fixed` の祖先は、返した後で止める。 */
  function* clippingAncestorsOf(
    element: Element,
    style: CSSStyleDeclaration,
  ): Generator<readonly [Element, CSSStyleDeclaration]> {
    if (style.position === 'fixed') {
      return;
    }
    let waitForContainingBlock = style.position === 'absolute';
    let ancestor = element.parentElement;
    for (
      let depth = 0;
      ancestor !== null && depth < thresholds.maxSelectorDepth && !documentScrollers.has(ancestor);
      depth += 1, ancestor = ancestor.parentElement
    ) {
      const ancestorStyle = window.getComputedStyle(ancestor);
      const establishesContainingBlock = ancestorStyle.position !== 'static' || ancestorStyle.transform !== 'none';
      if (waitForContainingBlock && !establishesContainingBlock) {
        continue;
      }
      if (ancestorStyle.display !== 'inline' && ancestorStyle.display !== 'contents') {
        yield [ancestor, ancestorStyle];
      }
      if (ancestorStyle.position === 'fixed') {
        return;
      }
      waitForContainingBlock = ancestorStyle.position === 'absolute';
    }
  }
  // 重なりの候補を集めるときに、祖先で切り取った後に見える部分が残るかを確かめる（R4 の M3）。
  const hasVisibleAreaAfterAncestorClip = (element: Element, style: CSSStyleDeclaration, rect: RectangleEvidence): boolean => {
    let { left, top, right, bottom } = rect;
    const remains = (): boolean => (
      right - left > thresholds.maxZeroSizeDimensionPx && bottom - top > thresholds.maxZeroSizeDimensionPx
    );
    for (const [ancestor, ancestorStyle] of clippingAncestorsOf(element, style)) {
      const box = ancestor.getBoundingClientRect();
      const boxLeft = box.left + ancestor.clientLeft;
      const boxTop = box.top + ancestor.clientTop;
      if (clippingOverflows.has(ancestorStyle.overflowX)) {
        left = Math.max(left, boxLeft);
        right = Math.min(right, boxLeft + ancestor.clientWidth);
      }
      if (clippingOverflows.has(ancestorStyle.overflowY)) {
        top = Math.max(top, boxTop);
        bottom = Math.min(bottom, boxTop + ancestor.clientHeight);
      }
      if (!remains()) {
        return false;
      }
    }
    return remains();
  };
  // ビューポートの横方向の overflow（設計書 5.1.2、RT12c）。CSS Overflow の仕様に従い、html の `overflow` が両方向とも
  // `visible` なら body の値が、そうでなければ html の値が、ビューポートに伝わる。`visible` は `NONE` にする。
  const rootStyle = window.getComputedStyle(document.documentElement);
  const bodyStyle = document.body instanceof HTMLBodyElement ? window.getComputedStyle(document.body) : null;
  const bodyPropagatesToViewport = bodyStyle !== null
    && rootStyle.overflowX === 'visible'
    && rootStyle.overflowY === 'visible';
  const viewportHorizontalClip: HorizontalClipAncestorKind = horizontalClipOf(
    (bodyPropagatesToViewport ? bodyStyle : rootStyle).overflowX,
  ) ?? 'NONE';
  // 祖先としての html・body の横方向の切り取り。ビューポートが切り取るか、ビューポートに伝わらない body の
  // `overflow-x` が `hidden`・`clip` なら、はみ出した部分は切り取られる。
  // `auto`・`scroll` は、ビューポートのスクロールと同じなので、切り取りに数えない（文書の横のはみ出しとして扱う）。
  const documentRootHorizontalClip: HorizontalClipAncestorKind = viewportHorizontalClip === 'CLIPPED'
    || (bodyStyle !== null && !bodyPropagatesToViewport && horizontalClipOf(bodyStyle.overflowX) === 'CLIPPED')
    ? 'CLIPPED'
    : 'NONE';
  // 横方向に最も近い、overflow-x が visible 以外の祖先の種類（設計書 5.1.2）。
  const horizontalClipAncestorOf = (element: Element, style: CSSStyleDeclaration): HorizontalClipAncestorKind => {
    if (style.position === 'fixed') {
      return 'NONE';
    }
    for (const [, ancestorStyle] of clippingAncestorsOf(element, style)) {
      const kind = horizontalClipOf(ancestorStyle.overflowX);
      if (kind !== undefined) {
        return kind;
      }
      if (ancestorStyle.position === 'fixed') {
        return 'NONE';
      }
    }
    return documentRootHorizontalClip;
  };
  const hasText = (value: string | null): boolean => value !== null && /\S/u.test(value);
  // 子孫のテキストが、要素の箱（padding box）で切り取られているか（設計書 5.1.2、RT12 の I2、RT12r の N1）。
  // 縦方向: 行の矩形はフォントの内容領域の高さを持ち、行の高さと一致しないので、箱の外に出た量が行の高さの一定の割合を超える行だけを数える。
  // 横方向: このずれがないので、箱の外に出た量が、文字の少しの張り出しとして許す固定の値を超える行を数える（RT12d の発見事項2）。
  // どちらの方向も、箱の片側ずつに出た量を比べ、両側の量を合計しない（RT12r2 の I1）。
  // 見えない要素（`VISIBILITY_CHECK_OPTIONS` の `checkVisibility` が偽の要素）の中のテキストは、判定に使わない（RT12r2 の M1）。
  const textLineClipOf = (
    element: HTMLElement,
    rect: RectangleEvidence,
    widthClipped: boolean,
    heightClipped: boolean,
  ): { readonly clipped: boolean; readonly limitReached: boolean } => {
    const left = rect.left + element.clientLeft;
    const top = rect.top + element.clientTop;
    const right = left + element.clientWidth;
    const bottom = top + element.clientHeight;
    const epsilon = thresholds.geometryEpsilonPx;
    const minOutsideRatio = thresholds.clippedTextLineMinOutsideRatio;
    const maxIgnoredHorizontalOverflow = thresholds.clippedTextLineMaxIgnoredHorizontalOverflowPx;
    /** 行の [start, end) が、箱の [boxStart, boxEnd) の始まりの側か終わりの側の外に、limit を超えて出ているか（片側ずつ比べる）。 */
    const sticksOutBeyond = (start: number, end: number, boxStart: number, boxEnd: number, limit: number): boolean => (
      boxStart - start > limit || end - boxEnd > limit
    );
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let scanned = 0;
    // 箱の中に見える行があったか。箱の上か下に丸ごと出た行があったか（見える行が見つかるまで、判定を保留する）。
    let visibleLineFound = false;
    let lineWhollyAboveOrBelow = false;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (scanned >= thresholds.maxClippedTextNodeScan) {
        return { clipped: false, limitReached: true };
      }
      scanned += 1;
      if (!hasText(node.nodeValue) || node.parentElement?.checkVisibility(visibilityOptions) === false) {
        continue;
      }
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        const overlapsHorizontally = Math.min(line.right, right) - Math.max(line.left, left) > epsilon;
        const overlapsVertically = Math.min(line.bottom, bottom) - Math.max(line.top, top) > epsilon;
        if (overlapsHorizontally && overlapsVertically) {
          if (
            (widthClipped && sticksOutBeyond(line.left, line.right, left, right, maxIgnoredHorizontalOverflow))
            || (heightClipped
              && sticksOutBeyond(line.top, line.bottom, top, bottom, (line.bottom - line.top) * minOutsideRatio))
          ) {
            return { clipped: true, limitReached: false };
          }
          visibleLineFound = true;
        } else if (heightClipped && overlapsHorizontally && !overlapsVertically) {
          lineWhollyAboveOrBelow = true;
        }
        if (visibleLineFound && lineWhollyAboveOrBelow) {
          return { clipped: true, limitReached: false };
        }
      }
    }
    return { clipped: false, limitReached: false };
  };
  // 子孫に、可視で大きさのある要素があるか（設計書 5.1.2、RT12 の I3）。幅か高さが 1 px 以下の子孫（visually hidden）は数えない（RT12r の N5）。
  // 文書の左か上の外に丸ごと置かれた子孫（文書の座標で、右端か下端が 0 以下のもの。`left:-9999px` など）も数えない（RT12r2 の M2）。
  // ただし、候補自身が文書の外にある場合は、そうした子孫も数える（RT12r3 の m1）。`translate3d` で文書の外へ動かした
  // カルーセルのスライドの中のリンクを、誤って報告しないためである。候補が文書の外にあるとは、文書の座標で、
  // 「左端が負で、かつ右端が 0 以下」か「上端が負で、かつ下端が 0 以下」であることをいう（設計書 5.1.2）。
  // 幅か高さが 0 の候補が文書の端（0）にある場合は、文書の中とみなす。
  const renderedDescendantOf = (
    element: Element,
    style: CSSStyleDeclaration,
    rect: RectangleEvidence,
  ): { readonly rendered: boolean; readonly limitReached: boolean } => {
    // 大きさが0の方向を、要素自身が overflow で切り取るなら、子孫は見えない。
    if (
      (clippingOverflows.has(style.overflowX) && rect.width <= thresholds.maxZeroSizeDimensionPx)
      || (clippingOverflows.has(style.overflowY) && rect.height <= thresholds.maxZeroSizeDimensionPx)
    ) {
      return { rendered: false, limitReached: false };
    }
    const candidateOutsideDocument = (
      rect.left + scrollPosition.scrollX < 0 && rect.right + scrollPosition.scrollX <= 0
    ) || (
      rect.top + scrollPosition.scrollY < 0 && rect.bottom + scrollPosition.scrollY <= 0
    );
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    let scanned = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (scanned >= thresholds.maxRenderedDescendantScan) {
        return { rendered: false, limitReached: true };
      }
      scanned += 1;
      const descendant = node as Element;
      if (!descendant.checkVisibility(visibilityOptions)) {
        continue;
      }
      const box = descendant.getBoundingClientRect();
      if (
        box.width > thresholds.maxUnrenderedDescendantDimensionPx
        && box.height > thresholds.maxUnrenderedDescendantDimensionPx
        && (
          candidateOutsideDocument
          || (box.right + scrollPosition.scrollX > 0 && box.bottom + scrollPosition.scrollY > 0)
        )
      ) {
        return { rendered: true, limitReached: false };
      }
    }
    return { rendered: false, limitReached: false };
  };

  interface ObservedElement {
    readonly element: Element;
    readonly order: number;
    readonly rect: RectangleEvidence;
    readonly style: CSSStyleDeclaration;
    readonly visibility: VisibilityEvidence;
    readonly kind: LayoutElementKind;
    readonly fixed: boolean;
    readonly fixedOrStickyAncestor: boolean;
  }

  /** はみ出しの候補と、その要素（一覧の中の祖先の番号を、最後に求めるため）と、文書の順の番号。 */
  interface OutsideCandidate {
    readonly element: Element;
    readonly order: number;
    readonly evidence: Omit<OutsideViewportEvidence, 'nearestListedAncestorIndex'>;
  }

  const allElements = document.body === null ? [] : [...document.body.querySelectorAll('*')];
  // はみ出しの候補は、次の順に優先して、件数の上限まで残す（どの組も文書の順に集める）。
  // 1. 横にはみ出すか固定の要素で、横方向に切り取る祖先もスクロールできる祖先もない（`horizontalClipAncestor` が `NONE`）もの（RT12r の N4）
  // 2. 横にはみ出すか固定の要素で、それ以外のもの（カルーセルの中のスライドなど）
  // 3. 縦にだけはみ出すもの
  const unclippedPriorityOutsideViewport: OutsideCandidate[] = [];
  const clippedPriorityOutsideViewport: OutsideCandidate[] = [];
  const ordinaryOutsideViewport: OutsideCandidate[] = [];
  const zeroSizeInteractive: ZeroSizeInteractiveEvidence[] = [];
  const clippedText: ClippedTextEvidence[] = [];
  const headings: ObservedElement[] = [];
  const fixedCandidates: ObservedElement[] = [];
  const primaryElements: ObservedElement[] = [];
  let outsideViewportCount = 0;
  let zeroSizeInteractiveCount = 0;
  let clippedTextCount = 0;
  let clippedTextNodeScanLimitReachedCount = 0;
  let renderedDescendantScanLimitReachedCount = 0;
  // 要素（とその祖先）に `position: fixed | sticky` があるか。親は子より先に走査されるので、親の値を引き継ぐ。
  const withinFixedOrSticky = new Map<Element, boolean>();
  if (document.body !== null) {
    withinFixedOrSticky.set(document.body, isFixedOrSticky(window.getComputedStyle(document.body).position));
  }

  for (const [order, element] of allElements.entries()) {
    if (deadlinePassed()) {
      break;
    }
    const style = window.getComputedStyle(element);
    const fixed = isFixedOrSticky(style.position);
    const parent = element.parentElement;
    const fixedOrStickyAncestor = parent !== null && (withinFixedOrSticky.get(parent) ?? false);
    withinFixedOrSticky.set(element, fixed || fixedOrStickyAncestor);
    const visible = element.checkVisibility(visibilityOptions);
    if (!visible) {
      continue;
    }
    const rect = rectFor(element);
    const visibility = visibilityFor(element, style, visible);
    const kind = kindOf(element);

    const outside = {
      left: rect.left < -thresholds.geometryEpsilonPx,
      right: rect.right > actualViewport.width + thresholds.geometryEpsilonPx,
      top: rect.top < -thresholds.geometryEpsilonPx,
      bottom: rect.bottom > actualViewport.height + thresholds.geometryEpsilonPx,
    };
    if (outside.left || outside.right || outside.top || outside.bottom) {
      outsideViewportCount += 1;
      const prioritized = outside.left || outside.right || fixed;
      const limit = thresholds.maxOutsideViewportCandidates;
      // 祖先をたどる処理は、残せる組がある場合だけ行う。
      let retained: OutsideCandidate[] | null = null;
      let horizontalClipAncestor: HorizontalClipAncestorKind | null = null;
      if (!prioritized) {
        retained = ordinaryOutsideViewport.length < limit ? ordinaryOutsideViewport : null;
      } else if (unclippedPriorityOutsideViewport.length < limit || clippedPriorityOutsideViewport.length < limit) {
        horizontalClipAncestor = horizontalClipAncestorOf(element, style);
        const group = horizontalClipAncestor === 'NONE' ? unclippedPriorityOutsideViewport : clippedPriorityOutsideViewport;
        retained = group.length < limit ? group : null;
      }
      if (retained !== null) {
        const { selector, truncated } = selectorFor(element);
        retained.push({
          element,
          order,
          evidence: {
            selector,
            kind,
            rect,
            visibility,
            position: style.position,
            zIndex: style.zIndex,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            horizontalClipAncestor: horizontalClipAncestor ?? horizontalClipAncestorOf(element, style),
            outside,
            truncated,
          },
        });
      }
    }

    if (
      (rect.width <= thresholds.maxZeroSizeDimensionPx || rect.height <= thresholds.maxZeroSizeDimensionPx)
      && element.matches('a[href], button, input, select, textarea, [role="button"], [role="link"]')
    ) {
      zeroSizeInteractiveCount += 1;
      if (zeroSizeInteractive.length < thresholds.maxZeroSizeInteractiveCandidates) {
        const { selector, truncated } = selectorFor(element);
        const descendantScan = renderedDescendantOf(element, style, rect);
        if (descendantScan.limitReached) {
          renderedDescendantScanLimitReachedCount += 1;
        }
        zeroSizeInteractive.push({
          selector,
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          rect,
          visibility,
          position: style.position,
          zIndex: style.zIndex,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          hasRenderedDescendant: descendantScan.rendered,
          truncated,
        });
      }
    }

    if (element instanceof HTMLElement) {
      const widthClipped = clippingOverflows.has(style.overflowX)
        && element.scrollWidth > element.clientWidth + thresholds.geometryEpsilonPx;
      const heightClipped = clippingOverflows.has(style.overflowY)
        && element.scrollHeight > element.clientHeight + thresholds.geometryEpsilonPx;
      if (widthClipped || heightClipped) {
        const text = normalize(element.innerText);
        if (text.length > 0) {
          clippedTextCount += 1;
          if (clippedText.length < thresholds.maxClippedTextCandidates) {
            const { selector, truncated } = selectorFor(element);
            const lineCheck = textLineClipOf(element, rect, widthClipped, heightClipped);
            if (lineCheck.limitReached) {
              clippedTextNodeScanLimitReachedCount += 1;
            }
            clippedText.push({
              selector,
              text: text.slice(0, thresholds.maxClippedTextLength),
              rect,
              visibility,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              position: style.position,
              zIndex: style.zIndex,
              clientWidth: element.clientWidth,
              clientHeight: element.clientHeight,
              scrollWidth: element.scrollWidth,
              scrollHeight: element.scrollHeight,
              widthClipped,
              heightClipped,
              partiallyClippedText: lineCheck.clipped,
              truncated: truncated || text.length > thresholds.maxClippedTextLength,
            });
          }
        }
      }
    }

    const observed: ObservedElement = {
      element,
      order,
      rect,
      style,
      visibility,
      kind,
      fixed,
      fixedOrStickyAncestor,
    };
    const heading = element.matches('h1, h2, h3, h4, h5, h6');
    const primary = (kind !== 'other' || fixed)
      && rect.width > thresholds.maxZeroSizeDimensionPx
      && rect.height > thresholds.maxZeroSizeDimensionPx;
    // 祖先の overflow で切り取られて見える部分が残らない要素は、重なりの候補にしない（R4 の M3）。
    if ((heading || primary) && !hasVisibleAreaAfterAncestorClip(element, style, rect)) {
      continue;
    }
    if (heading) {
      headings.push(observed);
    }
    if (fixed) {
      fixedCandidates.push(observed);
    }
    if (primary) {
      primaryElements.push(observed);
    }
  }

  let overlapComparisonLimitReached = false;
  // 重なりの走査1回ぶんの、比べる組の上限を管理する。上限に達したら false を返す。
  const comparisonBudget = (): (() => boolean) => {
    let comparisons = 0;
    return () => {
      if (comparisons >= thresholds.maxOverlapComparisons) {
        overlapComparisonLimitReached = true;
        return false;
      }
      comparisons += 1;
      return true;
    };
  };
  const related = (first: Element, second: Element): boolean => (
    first === second || first.contains(second) || second.contains(first)
  );

  const fixedHeadingOverlaps: FixedHeadingOverlapEvidence[] = [];
  let fixedHeadingOverlapCount = 0;
  const compareFixedHeading = comparisonBudget();
  fixedHeadingScan:
  for (const overlay of fixedCandidates) {
    for (const heading of headings) {
      if (deadlinePassed() || !compareFixedHeading()) {
        break fixedHeadingScan;
      }
      if (
        related(overlay.element, heading.element)
        || !intersectsViewport(overlay.rect)
        || !intersectsViewport(heading.rect)
      ) {
        continue;
      }
      const intersection = intersectionOf(overlay.rect, heading.rect);
      if (intersection === null) {
        continue;
      }
      fixedHeadingOverlapCount += 1;
      if (fixedHeadingOverlaps.length >= thresholds.maxFixedHeadingOverlapCandidates) {
        continue;
      }
      const overlaySelector = selectorFor(overlay.element);
      const headingSelector = selectorFor(heading.element);
      fixedHeadingOverlaps.push({
        overlaySelector: overlaySelector.selector,
        headingSelector: headingSelector.selector,
        overlayRect: overlay.rect,
        headingRect: heading.rect,
        overlayVisibility: overlay.visibility,
        headingVisibility: heading.visibility,
        overlayPosition: overlay.style.position as FixedElementPosition,
        overlayZIndex: overlay.style.zIndex,
        overlayOverflowX: overlay.style.overflowX,
        overlayOverflowY: overlay.style.overflowY,
        headingPosition: heading.style.position,
        headingZIndex: heading.style.zIndex,
        headingOverflowX: heading.style.overflowX,
        headingOverflowY: heading.style.overflowY,
        intersection,
        truncated: overlaySelector.truncated || headingSelector.truncated,
      });
    }
  }

  const elementFacts = (
    observed: ObservedElement,
    selector: string,
  ): RawLayoutElementEvidence => ({
    selector,
    kind: observed.kind,
    rect: observed.rect,
    visibility: observed.visibility,
    position: observed.style.position,
    zIndex: observed.style.zIndex,
    overflowX: observed.style.overflowX,
    overflowY: observed.style.overflowY,
    fixedOrStickyAncestor: observed.fixedOrStickyAncestor,
  });
  const elementOverlaps: RawElementOverlapEvidence[] = [];
  let elementOverlapCount = 0;
  const recordOverlap = (first: ObservedElement, second: ObservedElement): void => {
    if (related(first.element, second.element)) {
      return;
    }
    const intersection = intersectionOf(first.rect, second.rect);
    if (intersection === null) {
      return;
    }
    elementOverlapCount += 1;
    if (elementOverlaps.length >= thresholds.maxElementOverlapCandidates) {
      return;
    }
    const [earlier, later] = first.order < second.order ? [first, second] : [second, first];
    const earlierSelector = selectorFor(earlier.element);
    const laterSelector = selectorFor(later.element);
    elementOverlaps.push({
      first: elementFacts(earlier, earlierSelector.selector),
      second: elementFacts(later, laterSelector.selector),
      intersection,
      truncated: earlierSelector.truncated || laterSelector.truncated,
    });
  };

  // 固定要素を含む組を先に調べる（上限で切り捨てるときに優先する）。どちらもビューポートと交わる組に限る。
  const primaryInViewport = primaryElements.filter((observed) => intersectsViewport(observed.rect));
  const fixedPrimaryInViewport = primaryInViewport.filter((observed) => observed.fixed);
  const compareFixedPairs = comparisonBudget();
  fixedPairScan:
  for (const overlay of fixedPrimaryInViewport) {
    for (const other of primaryInViewport) {
      if (other.fixed && other.order <= overlay.order) {
        continue;
      }
      if (deadlinePassed() || !compareFixedPairs()) {
        break fixedPairScan;
      }
      recordOverlap(overlay, other);
    }
  }

  // 固定要素でない主要要素どうしは、上端の順に並べ、縦に重なる組だけを比べる。
  const staticPrimary = primaryElements
    .filter((observed) => !observed.fixed)
    .sort((first, second) => first.rect.top - second.rect.top || first.order - second.order);
  const compareStaticPairs = comparisonBudget();
  staticPairScan:
  for (const [index, current] of staticPrimary.entries()) {
    for (let next = index + 1; next < staticPrimary.length; next += 1) {
      const candidate = staticPrimary[next];
      if (candidate === undefined || candidate.rect.top >= current.rect.bottom) {
        break;
      }
      if (deadlinePassed() || !compareStaticPairs()) {
        break staticPairScan;
      }
      recordOverlap(current, candidate);
    }
  }

  const fixedPrimary = primaryElements.filter((observed) => observed.fixed);
  const fixedElements: RawFixedElementEvidence[] = fixedPrimary
    .slice(0, thresholds.maxFixedElementCandidates)
    .map((observed) => {
      const { selector, truncated } = selectorFor(observed.element);
      return { ...elementFacts(observed, selector), truncated };
    });

  // 優先の順に上限まで選び、文書の順に並べ直す。
  const retainedOutsideViewport = [
    ...unclippedPriorityOutsideViewport,
    ...clippedPriorityOutsideViewport,
    ...ordinaryOutsideViewport,
  ]
    .slice(0, thresholds.maxOutsideViewportCandidates)
    .sort((first, second) => first.order - second.order);
  // 一覧の中の、最も近い祖先の番号（設計書 5.1.2）。一覧の要素ごとに、親の方向へたどって探す。
  const listedIndexes = new Map(retainedOutsideViewport.map(({ element }, index) => [element, index] as const));
  const boxesOutsideViewport: OutsideViewportEvidence[] = retainedOutsideViewport.map(({ element, evidence }) => {
    let nearestListedAncestorIndex: number | null = null;
    for (
      let ancestor = element.parentElement;
      ancestor !== null && nearestListedAncestorIndex === null;
      ancestor = ancestor.parentElement
    ) {
      nearestListedAncestorIndex = listedIndexes.get(ancestor) ?? null;
    }
    return { ...evidence, nearestListedAncestorIndex };
  });
  const root = document.documentElement;
  const body = document.body;
  const documentElementScrollWidth = root?.scrollWidth ?? 0;
  const bodyScrollWidth = body?.scrollWidth ?? 0;
  return {
    scrollPosition,
    document: {
      viewportWidth: actualViewport.width,
      viewportHeight: actualViewport.height,
      documentElementClientWidth: root?.clientWidth ?? 0,
      documentElementClientHeight: root?.clientHeight ?? 0,
      documentElementScrollWidth,
      documentElementScrollHeight: root?.scrollHeight ?? 0,
      bodyScrollWidth,
      bodyScrollHeight: body?.scrollHeight ?? 0,
      bodyClientWidth: body?.clientWidth ?? 0,
      bodyClientHeight: body?.clientHeight ?? 0,
      horizontalOverflowPx: Math.max(
        0,
        Math.max(documentElementScrollWidth, bodyScrollWidth) - actualViewport.width,
      ),
      viewportHorizontalClip,
    },
    boxesOutsideViewport,
    zeroSizeInteractive,
    clippedText,
    fixedHeadingOverlaps,
    elementOverlaps,
    fixedElements,
    truncation: {
      omittedOutsideViewportCount: outsideViewportCount - retainedOutsideViewport.length,
      omittedZeroSizeInteractiveCount: zeroSizeInteractiveCount - zeroSizeInteractive.length,
      omittedClippedTextCount: clippedTextCount - clippedText.length,
      omittedFixedHeadingOverlapCount: fixedHeadingOverlapCount - fixedHeadingOverlaps.length,
      omittedElementOverlapCount: elementOverlapCount - elementOverlaps.length,
      omittedFixedElementCount: fixedPrimary.length - fixedElements.length,
      overlapComparisonLimitReached,
      clippedTextNodeScanLimitReachedCount,
      renderedDescendantScanLimitReachedCount,
    },
    incompleteReason,
  };
}

const DEADLINE_EXCEEDED_WITHOUT_LAYOUT: LayoutCollectionResult = Object.freeze({
  status: 'PARTIAL',
  reason: 'DEADLINE_EXCEEDED',
  layout: null,
});

/**
 * 上限付き・読み取り専用のジオメトリ観測結果を、期限付きの単一のブラウザevaluationで収集する。
 * 期限を過ぎた場合は、例外を投げずに `PARTIAL` と理由を返す。
 * ブラウザ内の評価の失敗、不正なジオメトリ、実際のビューポートとの食い違いは、例外として呼び出し側に返す。
 */
export async function collectLayoutEvidence(
  page: Page,
  viewport: Viewport,
  options: LayoutCollectionOptions = { deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs },
): Promise<LayoutCollectionResult> {
  positiveFiniteDimension(viewport.width, 'Layout viewport width');
  positiveFiniteDimension(viewport.height, 'Layout viewport height');
  const { deadlineAtMs } = options;
  if (!Number.isFinite(deadlineAtMs)) {
    throw new Error('Layout collection deadline must be finite');
  }
  const viewportSnapshot = Object.freeze({ width: viewport.width, height: viewport.height });
  if (Date.now() >= deadlineAtMs) {
    return DEADLINE_EXCEEDED_WITHOUT_LAYOUT;
  }
  const evaluated = await awaitBeforeDeadline(page.evaluate(collectLayoutInPage, {
    thresholds: LAYOUT_THRESHOLDS,
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
    kindSelectors: LAYOUT_ELEMENT_KIND_SELECTORS,
    fixedPositions: FIXED_ELEMENT_POSITIONS,
    horizontalClipByOverflow: HORIZONTAL_CLIP_BY_OVERFLOW,
    scanDeadlineAtMs: deadlineAtMs - LAYOUT_THRESHOLDS.partialResultReserveMs,
  } satisfies LayoutEvaluationArgument), deadlineAtMs);
  if (evaluated.status === 'DEADLINE_EXCEEDED') {
    return DEADLINE_EXCEEDED_WITHOUT_LAYOUT;
  }
  if (evaluated.status === 'REJECTED') {
    throw evaluated.reason;
  }

  const raw = evaluated.value;
  const incompleteReason = validateIncompleteReason(raw.incompleteReason);
  const evidence = freezeLayout(raw);
  if (
    Math.abs(evidence.document.viewportWidth - viewportSnapshot.width) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
    || Math.abs(evidence.document.viewportHeight - viewportSnapshot.height) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
  ) {
    throw new Error(
      `Caller viewport ${viewportSnapshot.width}x${viewportSnapshot.height} does not match actual browser viewport `
      + `${evidence.document.viewportWidth}x${evidence.document.viewportHeight}`,
    );
  }
  // 期限を優先する。比べる組の上限に達した場合も COMPLETE にしない（R4 の M2）。
  const reason: LayoutIncompleteReason | null = incompleteReason
    ?? (evidence.truncation.overlapComparisonLimitReached ? 'LAYOUT_COMPARISON_LIMIT_REACHED' : null);
  return reason === null
    ? Object.freeze({ status: 'COMPLETE', layout: evidence })
    : Object.freeze({ status: 'PARTIAL', reason, layout: evidence });
}

function failedWidth(
  width: number,
  stage: StressLayoutFailureStage,
  reason: StressLayoutFailureReason,
  error: unknown,
): StressLayoutEvidence {
  return Object.freeze({
    width,
    height: STRESS_VIEWPORT_HEIGHT,
    status: 'FAILED',
    stage,
    reason,
    message: error === undefined ? null : safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH),
    layout: null,
  });
}

/**
 * レスポンシブの各幅を、その都度新規に保護されたowner管理下のセッションでサンプリングする。
 * ある幅の遷移や収集が失敗しても、それまでの幅の結果を保持し、失敗した幅を理由付きで記録して次の幅へ進む。
 * 期限を過ぎた後の幅は、セッションを作らずに `NOT_STARTED` として記録する。
 * セッションの作成と close の失敗は、owner のライフサイクルの失敗として例外で返す。
 */
export async function collectStressLayout(
  pageFactory: PassiveStressSessionFactory,
  url: string,
  widths: readonly number[],
  options: StressLayoutOptions = { deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs * widths.length },
): Promise<readonly StressLayoutEvidence[]> {
  if (typeof pageFactory !== 'function') {
    throw new Error('A passive stress session factory is required');
  }
  if (widths.some((width) => !Number.isFinite(width) || !Number.isInteger(width) || width <= 0)) {
    throw new Error('Responsive stress widths must be positive finite integers');
  }
  const { deadlineAtMs } = options;
  if (!Number.isFinite(deadlineAtMs)) {
    throw new Error('Responsive stress deadline must be finite');
  }

  const results: StressLayoutEvidence[] = [];
  for (const width of widths) {
    if (Date.now() >= deadlineAtMs) {
      results.push(failedWidth(width, 'NOT_STARTED', 'DEADLINE_EXCEEDED', undefined));
      continue;
    }
    const viewport = Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT });
    const session = await pageFactory(viewport);
    let workError: unknown;
    let closeError: unknown;
    let result: StressLayoutEvidence | undefined;
    try {
      const navigated = await awaitBeforeDeadline(session.page.goto(url, { waitUntil: 'load' }), deadlineAtMs);
      if (navigated.status === 'DEADLINE_EXCEEDED') {
        result = failedWidth(width, 'NAVIGATION', 'DEADLINE_EXCEEDED', undefined);
      } else if (navigated.status === 'REJECTED') {
        workError = navigated.reason;
        result = failedWidth(width, 'NAVIGATION', 'NAVIGATION_FAILED', navigated.reason);
      } else {
        const collected = await collectLayoutEvidence(session.page, viewport, { deadlineAtMs });
        result = collected.status === 'COMPLETE'
          ? Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT, status: 'COMPLETE', layout: collected.layout })
          : Object.freeze({
            width,
            height: STRESS_VIEWPORT_HEIGHT,
            status: 'PARTIAL',
            reason: collected.reason,
            layout: collected.layout,
          });
      }
    } catch (error) {
      workError = error;
      result = failedWidth(width, 'COLLECTION', pageFailureReason(session.page), error);
    } finally {
      try {
        await session.close();
      } catch (error) {
        closeError = error;
      }
    }

    if (closeError !== undefined) {
      if (workError !== undefined) {
        throw new AggregateError([workError, closeError], 'Responsive stress work and owner close both failed');
      }
      throw closeError;
    }
    if (result === undefined) {
      throw new Error('Responsive stress collection produced no result');
    }
    results.push(result);
  }
  return Object.freeze(results);
}
