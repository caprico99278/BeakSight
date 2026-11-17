/**
 * AUD-3b・3c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3b・3c）: 固定の要素の重なりの区分の唯一の決め方。
 * - 区分の閉じた一覧（`FIXED_OVERLAP_CLASSES`）と、描画と押下の事実（Collector が残した hit-test の点ごとの事実）からの決め方を、このファイルの 1 か所に置く。
 *   覆いの Rule（`FIXED_ELEMENT_OCCLUSION`）と大きすぎる固定要素の Rule（`OVERSIZED_FIXED_ELEMENT`）は、ここの結果で Finding にするかを決める。
 * - 表示用モデルは、指摘ごとの区分（`fixedOverlapOfFinding`）と、Finding にしなかった区分の数（`fixedOverlapsNotCountedOf`）を、ここから読む
 *   （Rule のファイルは import できないため。ARCH07）。数え直しや判定の複製はしない。
 * - 設計者の判断（2026-11-10）:
 *   - `GEOMETRY_ONLY`・`MODAL`・`SCROLL_REVEALABLE` は Finding にしない（数える）。ほかは Finding にする。
 *   - 押下を捕まえるのは、点の 1 つでも、最前面が覆う要素かその子孫のとき。覆われる要素の側を先に見る（覆われる要素が最前面なら、捕まえない）。
 *   - 描画の遮蔽は hit-test だけで決めない。覆う側の要素の背景・不透明度の事実で決め、決められない（`PARTIAL`）ときは確信度を下げる（表示用モデル）。
 *   - 1 つの指摘（覆う要素ごと）の区分は、いちばん強い区分。強さは `FIXED_OVERLAP_CLASSES` の順。
 *   - 前の版の Evidence（hit-test の事実がない）は、今までの判定のまま Finding にし、区分は `null`。
 */
import type { EvidencePayloadByType } from '../core/contracts.js';
import {
  FIXED_ELEMENT_POSITIONS,
  type FixedElementEvidence,
  type LayoutDocumentEvidence,
  type LayoutElementKind,
  type LayoutEvidence,
  type OverlapHitLayerEvidence,
  type OverlapHitTestEvidence,
  type RectangleEvidence,
  type RevealedTargetEvidence,
  type ScrollContainerEvidence,
  type VisibilityEvidence,
} from '../core/evidence-types.js';
import { colorAlphaOf, isPassThroughContainer, POINTER_EVENTS_NONE } from '../core/own-surface.js';
import { isUncoveredMeasurement } from '../core/target-image-inclusion.js';

// ---------------------------------------------------------------------------------------------------------------
// 判定の定数（Task 12・13 の設計書 5.1。layout の Rule のファイルから移した）
// ---------------------------------------------------------------------------------------------------------------

/**
 * `FIXED_ELEMENT_OCCLUSION`: 覆われた要素の、ビューポートの中に見えている面積のうち、固定要素と重なる割合が、これを超えたら覆うとみなす。
 * 固定要素の影や細い帯が、要素の端に少し掛かるだけの場合を除くため、4分の1を超える場合に限る。
 */
export const FIXED_OCCLUSION_MIN_COVERED_RATIO = 0.25;

/**
 * `OVERSIZED_FIXED_ELEMENT`: 固定要素がビューポートの面積に占める割合が、これを超えたら Finding にする。
 * 通常の固定ヘッダー・フッター（Mobile の 390 × 844 で高さ 60〜120 px、7〜15%）は超えず、
 * 内容の3割以上を常に隠す帯やバナーは超える値にした。
 */
export const OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO = 0.3;

/** 数えなかった組の区分（AUD-3a）。 */
export const FIXED_OCCLUSION_REACHABLE_BY_SCROLL = 'REACHABLE_BY_SCROLL';

/** 覆いの Rule と、大きすぎる固定要素の Rule の ID（区分を持つ Rule）。 */
export const FIXED_OCCLUSION_RULE_ID = 'FIXED_ELEMENT_OCCLUSION';
export const OVERSIZED_FIXED_ELEMENT_RULE_ID = 'OVERSIZED_FIXED_ELEMENT';

// ---------------------------------------------------------------------------------------------------------------
// 区分の閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/**
 * 固定の要素の重なりの区分（強い順）。
 * - `RENDER_AND_POINTER`: 覆う側が描画で覆い、押下も捕まえる。
 * - `POINTER_ONLY`: 描かないが、押下を捕まえる。
 * - `RENDER_ONLY`: 描画で覆うが、押下は通る（`pointer-events: none` など）。
 * - `GEOMETRY_ONLY`: 描かず、押下も通る。境界が重なるだけ。
 * - `MODAL`: 開いたモーダル（`dialog` の showModal・`aria-modal="true"`）。
 * - `SCROLL_REVEALABLE`: スクロールすれば、覆いの外へ出せる（AUD-3a）。
 */
export const FIXED_OVERLAP_CLASSES = Object.freeze([
  'RENDER_AND_POINTER',
  'POINTER_ONLY',
  'RENDER_ONLY',
  'GEOMETRY_ONLY',
  'MODAL',
  'SCROLL_REVEALABLE',
] as const);
export type FixedOverlapClass = (typeof FIXED_OVERLAP_CLASSES)[number];

/** Finding にする区分（強い順）。ほかの区分は Finding にせず、数える。 */
export const FIXED_OVERLAP_FINDING_CLASSES = Object.freeze(['RENDER_AND_POINTER', 'POINTER_ONLY', 'RENDER_ONLY'] as const satisfies readonly FixedOverlapClass[]);
export type FixedOverlapFindingClass = (typeof FIXED_OVERLAP_FINDING_CLASSES)[number];

/** 描画の度合い（強い順）。`PARTIAL` は、描くが、覆いを決められない（半透明・背景の画像・文字だけ・枠線だけ・不透明度が 1 未満）。 */
export const FIXED_OVERLAP_RENDER_LEVELS = Object.freeze(['OPAQUE', 'PARTIAL', 'NONE'] as const);
export type FixedOverlapRenderLevel = (typeof FIXED_OVERLAP_RENDER_LEVELS)[number];

const FINDING_CLASS_SET: ReadonlySet<FixedOverlapClass> = new Set(FIXED_OVERLAP_FINDING_CLASSES);

/** Finding にする区分か。区分のない前の版の Evidence（`null`）は、今までどおり Finding にする。 */
export const isFindingFixedOverlapClass = (overlapClass: FixedOverlapClass | null): boolean =>
  overlapClass === null || FINDING_CLASS_SET.has(overlapClass);

/** いちばん強い区分（`FIXED_OVERLAP_CLASSES` の順。空なら `null`）。 */
export const strongestFixedOverlapClass = (classes: readonly FixedOverlapClass[]): FixedOverlapClass | null =>
  classes.reduce<FixedOverlapClass | null>((strongest, current) =>
    (strongest === null || FIXED_OVERLAP_CLASSES.indexOf(current) < FIXED_OVERLAP_CLASSES.indexOf(strongest) ? current : strongest), null);

const strongerRender = (first: FixedOverlapRenderLevel, second: FixedOverlapRenderLevel): FixedOverlapRenderLevel =>
  (FIXED_OVERLAP_RENDER_LEVELS.indexOf(first) <= FIXED_OVERLAP_RENDER_LEVELS.indexOf(second) ? first : second);

// ---------------------------------------------------------------------------------------------------------------
// 描画と押下の事実からの判定
// ---------------------------------------------------------------------------------------------------------------

/** 1 つの要素の描画の度合い。描く面がない・隠れている・不透明度が 0 は `NONE`。背景の色が不透明で、不透明度が 1 なら `OPAQUE`。ほかは `PARTIAL`。 */
export const layerPaintLevelOf = (layer: OverlapHitLayerEvidence): FixedOverlapRenderLevel => {
  if (layer.visibility !== 'visible' || !(layer.effectiveOpacity > 0) || !layer.paintsOwnSurface) {
    return 'NONE';
  }
  return colorAlphaOf(layer.backgroundColor) === 1 && layer.effectiveOpacity >= 1 ? 'OPAQUE' : 'PARTIAL';
};

const OVERLAY_SIDE_RELATIONS: ReadonlySet<string> = new Set(['OVERLAY', 'OVERLAY_DESCENDANT']);

/** hit-test の点ごとの事実の判定（描画の度合いと、押下を捕まえた点の数）。 */
export interface FixedOverlapHitJudgement {
  readonly render: FixedOverlapRenderLevel;
  readonly capturedPointCount: number;
  readonly pointCount: number;
}

/**
 * hit-test の点ごとの事実を判定する。
 * - 押下: 最前面が覆う要素かその子孫なら、その点は捕まえる。覆われる要素の側（`COVERED`・`COVERED_DESCENDANT`）が最前面なら、捕まえない。
 * - 描画: 対象の手前にある、覆う要素かその子孫の描画の度合い（いちばん強いもの）。
 * - 覆う要素が hit-test に出ない（`pointer-events: none`）ときは、手前に描く（`overlayAbove`）場合だけ、覆う要素そのものの描画の度合いを使う。
 * - 固定要素だけの事実（対象が `BENEATH`）で、下に祖先のほかの要素がない点は、覆うものがないので数えない。
 */
export function hitTestJudgementOf(hitTest: OverlapHitTestEvidence, { overlayAbove }: { readonly overlayAbove: boolean }): FixedOverlapHitJudgement {
  let render: FixedOverlapRenderLevel = 'NONE';
  let capturedPointCount = 0;
  const overlayHidden = hitTest.overlay.pointerEvents === POINTER_EVENTS_NONE;
  for (const point of hitTest.points) {
    if (hitTest.target === 'BENEATH' && !point.targetFound) {
      continue;
    }
    if (point.topRelation !== null && OVERLAY_SIDE_RELATIONS.has(point.topRelation)) {
      capturedPointCount += 1;
    }
    for (const layer of point.layers) {
      if (OVERLAY_SIDE_RELATIONS.has(layer.relation)) {
        render = strongerRender(render, layerPaintLevelOf(layer));
      }
    }
    if (overlayHidden && overlayAbove) {
      render = strongerRender(render, layerPaintLevelOf(hitTest.overlay));
    }
  }
  return { render, capturedPointCount, pointCount: hitTest.points.length };
}

/** 区分の決め方（決める順: モーダル → スクロールで見える → 描画と押下）。 */
export function fixedOverlapClassOf({ modal, scrollRevealable, render, pointerCaptured }: {
  readonly modal: boolean;
  readonly scrollRevealable: boolean;
  readonly render: FixedOverlapRenderLevel;
  readonly pointerCaptured: boolean;
}): FixedOverlapClass {
  if (modal) {
    return 'MODAL';
  }
  if (scrollRevealable) {
    return 'SCROLL_REVEALABLE';
  }
  if (render !== 'NONE') {
    return pointerCaptured ? 'RENDER_AND_POINTER' : 'RENDER_ONLY';
  }
  return pointerCaptured ? 'POINTER_ONLY' : 'GEOMETRY_ONLY';
}

const isModal = (hitTest: OverlapHitTestEvidence): boolean => hitTest.modal.dialogModal || hitTest.modal.ariaModal;

// ---------------------------------------------------------------------------------------------------------------
// 形の小さな部品（layout の Rule と共有する）
// ---------------------------------------------------------------------------------------------------------------

/** 描画されて見える内容か（可視、不透明度が0でない、`aria-hidden` でない）。 */
export const isPaintedContent = (visibility: VisibilityEvidence): boolean =>
  visibility.visible && visibility.opacity > 0 && !visibility.ariaHidden;

/** 描画されて見えるか（可視、不透明度が0でない）。固定要素は、`aria-hidden` でも内容を覆うので、これで判定する。 */
export const isPainted = (visibility: VisibilityEvidence): boolean => visibility.visible && visibility.opacity > 0;

export const isFixedPosition = (position: string): boolean => (FIXED_ELEMENT_POSITIONS as readonly string[]).includes(position);

/** 整数の z-index。`auto` や不明な値は null。 */
export const parseZIndex = (zIndex: string): number | null => (/^-?\d+$/u.test(zIndex) ? Number.parseInt(zIndex, 10) : null);

export const areaOf = (rect: RectangleEvidence): number => Math.max(0, rect.width) * Math.max(0, rect.height);

export const clipToViewport = (rect: RectangleEvidence, width: number, height: number): number =>
  Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0))
  * Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));

export const intersectionArea = (first: RectangleEvidence, second: RectangleEvidence, width: number, height: number): number => {
  const left = Math.max(first.left, second.left, 0);
  const top = Math.max(first.top, second.top, 0);
  const right = Math.min(first.right, second.right, width);
  const bottom = Math.min(first.bottom, second.bottom, height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

/**
 * Rule が判定に使う layout の結果の範囲。
 * - `PRIMARY`: 主要なビューポートの結果（`primary`）だけ。
 * - `PRIMARY_AND_STRESS_SWEEP`: それに加えて、レスポンシブの幅ごとの結果（`stressSweep`）。設計書 5.1.1 の5つの Rule が使う。
 */
export type LayoutScope = 'PRIMARY' | 'PRIMARY_AND_STRESS_SWEEP';

/** layout の結果の 1 つ（幅ごとの結果は、その幅。`primary` は null）。 */
export interface LayoutSourceOfPayload {
  readonly layout: LayoutEvidence;
  readonly stressWidth: number | null;
}

/**
 * layout の Evidence の payload から、Rule が判定に使う layout の結果（収集が `PARTIAL` でも、集めた事実があれば使う）。幅ごとの結果は、設計書 5.1.1 に従い、
 * `FAILED` の結果・layout が null の結果・`primary` の layout と同じ幅の結果を除く（`primary` の layout が null なら、幅で除かない）。
 */
export const layoutSourcesOfPayload = (payload: EvidencePayloadByType['layout'], scope: LayoutScope): readonly LayoutSourceOfPayload[] => {
  const primaryLayout = payload.primary.layout;
  const sources: LayoutSourceOfPayload[] = primaryLayout === null ? [] : [{ layout: primaryLayout, stressWidth: null }];
  if (scope === 'PRIMARY_AND_STRESS_SWEEP') {
    const primaryWidth = primaryLayout?.document.viewportWidth ?? null;
    for (const result of payload.stressSweep ?? []) {
      if (result.status !== 'FAILED' && result.layout !== null && result.width !== primaryWidth) {
        sources.push({ layout: result.layout, stressWidth: result.width });
      }
    }
  }
  return sources;
};

// ---------------------------------------------------------------------------------------------------------------
// FIXED_ELEMENT_OCCLUSION の組
// ---------------------------------------------------------------------------------------------------------------

export interface OcclusionFacts {
  readonly overlaySelector: string;
  readonly overlayPosition: string;
  readonly overlayZIndex: string;
  readonly overlayVisibility: VisibilityEvidence;
  readonly overlayRect: RectangleEvidence;
  readonly coveredSelector: string;
  readonly coveredPosition: string;
  readonly coveredZIndex: string;
  readonly coveredVisibility: VisibilityEvidence;
  readonly coveredRect: RectangleEvidence;
  /** EV-2: 覆われる要素の種類（見出しの重なりは `heading`）。押す部品か（「押せません」と言えるか）を見分ける。 */
  readonly coveredKind: LayoutElementKind;
  readonly coveredInFixedLayer: boolean;
  /** AUD-3b: hit-test の事実（前の版の Evidence にはない）。 */
  readonly hitTest: OverlapHitTestEvidence | undefined;
  /** EV-1: 覆われる要素のいちばん近い、縦にスクロールできる祖先（なければ、前の版の Evidence と同じく `undefined`）。 */
  readonly coveredScrollContainer: ScrollContainerEvidence | undefined;
}

/**
 * 固定要素が、覆われる要素より手前に描かれるか（重なりの文脈の入れ子は Evidence にないので、同じ文脈にあるとみなす近似）。
 * - 固定要素の z-index が負なら、通常の流れの内容より奥に描かれる。
 * - 覆われる要素が静的配置なら、z-index が0以上の固定要素（配置された要素）が手前に描かれる。
 * - 覆われる要素も配置されている場合は、固定要素の z-index（`auto` は0）が、覆われる要素の z-index より大きい場合に限る。
 * AUD-3b: hit-test の事実がある組では、押下を受ける覆いの前後は hit-test で決まる。この近似は、hit-test に出ない覆い（`pointer-events: none`）の描画にだけ使う。
 */
const overlayPaintsAbove = (facts: OcclusionFacts): boolean => {
  const overlayLevel = parseZIndex(facts.overlayZIndex) ?? 0;
  if (overlayLevel < 0) {
    return false;
  }
  if (facts.coveredPosition === 'static') {
    return true;
  }
  return overlayLevel > (parseZIndex(facts.coveredZIndex) ?? 0);
};

const occlusionFactsOf = (layout: LayoutEvidence): readonly OcclusionFacts[] => {
  const facts: OcclusionFacts[] = layout.fixedHeadingOverlaps.map((overlap) => ({
    overlaySelector: overlap.overlaySelector,
    overlayPosition: overlap.overlayPosition,
    overlayZIndex: overlap.overlayZIndex,
    overlayVisibility: overlap.overlayVisibility,
    overlayRect: overlap.overlayRect,
    coveredSelector: overlap.headingSelector,
    coveredPosition: overlap.headingPosition,
    coveredZIndex: overlap.headingZIndex,
    coveredVisibility: overlap.headingVisibility,
    coveredRect: overlap.headingRect,
    coveredKind: 'heading',
    // 見出しの祖先の固定要素は、この Evidence にないので、下で主要要素の重なりの事実から補う。
    coveredInFixedLayer: false,
    hitTest: overlap.hitTest,
    coveredScrollContainer: overlap.coveredScrollContainer,
  }));
  for (const { first, second, hitTest, coveredScrollContainer } of layout.elementOverlaps) {
    const firstFixed = isFixedPosition(first.position);
    const secondFixed = isFixedPosition(second.position);
    if (firstFixed === secondFixed) {
      continue;
    }
    const [overlay, covered] = firstFixed ? [first, second] : [second, first];
    facts.push({
      overlaySelector: overlay.selector,
      overlayPosition: overlay.position,
      overlayZIndex: overlay.zIndex,
      overlayVisibility: overlay.visibility,
      overlayRect: overlay.rect,
      coveredSelector: covered.selector,
      coveredPosition: covered.position,
      coveredZIndex: covered.zIndex,
      coveredVisibility: covered.visibility,
      coveredRect: covered.rect,
      coveredKind: covered.kind,
      coveredInFixedLayer: covered.fixedOrStickyAncestor,
      hitTest,
      coveredScrollContainer,
    });
  }
  return facts;
};

/** 固定要素か、固定要素の子孫と分かっている要素の selector（見出しの重なりの Evidence にない事実を補う）。 */
const fixedLayerSelectorsOf = (layout: LayoutEvidence): ReadonlySet<string> => {
  const selectors = new Set<string>(layout.fixedElements.map((element) => element.selector));
  for (const { first, second } of layout.elementOverlaps) {
    for (const element of [first, second]) {
      if (element.fixedOrStickyAncestor || isFixedPosition(element.position)) {
        selectors.add(element.selector);
      }
    }
  }
  return selectors;
};

/**
 * DEF-204（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.5）: 描く面がなく `pointer-events: none` の固定要素（中の子だけが見える入れ物）の
 * selector。覆いの規則は、この入れ物を覆う側として数えない（中の固定の子は、今までどおり数える）。AUD-3c: hit-test の事実がある組では、`GEOMETRY_ONLY` に数える。
 */
const passThroughContainerSelectorsOf = (layout: LayoutEvidence): ReadonlySet<string> =>
  new Set(layout.fixedElements.filter(isPassThroughContainer).map((element) => element.selector));

/** 覆われた割合（ビューポートの中に見えている面積に対する、固定要素との交わりの面積の比）。見えている面積が 0 なら 0。 */
const coveredRatioOf = (overlayRect: RectangleEvidence, coveredRect: RectangleEvidence, width: number, height: number): number => {
  const coveredVisibleArea = clipToViewport(coveredRect, width, height);
  return coveredVisibleArea > 0 ? intersectionArea(overlayRect, coveredRect, width, height) / coveredVisibleArea : 0;
};

/** 縦に `dy` だけ上へ動かした矩形（文書を `dy` だけ下へスクロールしたときの、通常の流れの要素の位置）。 */
const shiftedUp = (box: RectangleEvidence, dy: number): RectangleEvidence => ({
  ...box,
  y: box.y - dy,
  top: box.top - dy,
  bottom: box.bottom - dy,
});

/** 2 つの矩形の交わり（なければ、幅か高さが 0 の矩形）。 */
const intersectionRectOf = (first: RectangleEvidence, second: RectangleEvidence): RectangleEvidence => {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.max(left, Math.min(first.right, second.right));
  const bottom = Math.max(top, Math.min(first.bottom, second.bottom));
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
};

/**
 * AUD-3a（設計書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-3a）・EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1）:
 * 先頭の位置で固定要素に覆われる要素が、スクロールすれば固定要素の外へ出せるか。判定の部品はこの 1 か所。
 * - 動かせる量は、文書の量（Evidence の `max(documentElementScrollHeight, bodyScrollHeight) - viewportHeight`。0 未満は 0）と、EV-1: 覆われる要素の
 *   いちばん近い縦のスクロールの祖先の残りの量（`scrollRangeY - scrollTop`。祖先の事実がない前の版の Evidence は 0）の和。祖先を先に動かし、足りない分を
 *   文書で動かす（文書を動かすと、祖先も一緒に上がる）。
 * - 対象は `position: fixed` の固定要素だけ（sticky は、包含ブロックの端で止まり、スクロールで位置が変わるので、今のとおり数える）。
 * - 固定要素の上に、要素を置ける空きがあるときに限る: 固定要素の上端が、要素の高さ以上（ビューポートの高さの半分より高い要素は、半分以上）。
 *   上の固定のヘッダ（上端が 0）は、下へスクロールすると内容がさらに下へ潜るので、ここには当たらない。
 * - 要素の下端を固定要素の上端に合わせるまで（動かせる量が足りなければ、その量まで）上へ動かした位置で、要素の見える部分（祖先があれば、祖先の箱の中の
 *   部分）がビューポートの中にあり、覆われた割合がしきい値（`FIXED_OCCLUSION_MIN_COVERED_RATIO`）以下なら、外へ出せるとする。
 * - 横のスクロールは考えない。
 */
const reachableByScroll = (facts: OcclusionFacts, document: LayoutDocumentEvidence): boolean => {
  const { viewportWidth, viewportHeight } = document;
  const documentRange = Math.max(0, Math.max(document.documentElementScrollHeight, document.bodyScrollHeight) - viewportHeight);
  const container = facts.coveredScrollContainer;
  const containerRange = container === undefined ? 0 : Math.max(0, container.scrollRangeY - container.scrollTop);
  const overlayTop = facts.overlayRect.top;
  if (
    facts.overlayPosition !== 'fixed'
    || !Number.isFinite(documentRange)
    || !Number.isFinite(containerRange)
    || documentRange + containerRange <= 0
    || overlayTop <= 0
    || overlayTop < Math.min(facts.coveredRect.height, viewportHeight / 2)
  ) {
    return false;
  }
  const needed = Math.max(0, facts.coveredRect.bottom - overlayTop);
  const containerShift = Math.min(containerRange, needed);
  const documentShift = Math.min(documentRange, needed - containerShift);
  if (containerShift + documentShift <= 0) {
    return false;
  }
  const moved = shiftedUp(facts.coveredRect, containerShift + documentShift);
  const visible = container === undefined ? moved : intersectionRectOf(moved, shiftedUp(container.rect, documentShift));
  if (clipToViewport(visible, viewportWidth, viewportHeight) <= 0) {
    return false;
  }
  const ratio = coveredRatioOf(facts.overlayRect, visible, viewportWidth, viewportHeight);
  return Number.isFinite(ratio) && ratio <= FIXED_OCCLUSION_MIN_COVERED_RATIO;
};

/**
 * 覆いの判定の場面。`AFTER_NOTIFICATION_DISMISSAL` 以外の印は `BEFORE_NOTIFICATION_DISMISSAL` だけ。
 * DEF-210 の閉じる前の layout（`BEFORE_NOTIFICATION_DISMISSAL`）は、ページを開くたびに通知の枠が内容を覆う事実を 1 回だけ伝えるためのもので、
 * スクロールで逃がせるかとは別の意味なので、AUD-3a の除外を当てない（設計者の判断。2026-11-09）。
 */
export type OcclusionLayoutKind = 'AFTER_NOTIFICATION_DISMISSAL' | 'BEFORE_NOTIFICATION_DISMISSAL';

/** 区分を付けた覆いの組。`overlapClass`・`render` が `null` の組は、前の版の Evidence（hit-test の事実がない。今までの判定で数える）。 */
export interface ClassifiedOcclusionPair {
  readonly facts: OcclusionFacts;
  readonly ratio: number;
  readonly overlapClass: FixedOverlapClass | null;
  readonly render: FixedOverlapRenderLevel | null;
}

/**
 * 先頭の位置（文書のスクロール位置が 0, 0）で集めた layout で、見える固定要素が、固定要素でない主要要素をしきい値を超えて覆う組に、区分を付ける。
 * 先頭の位置でない layout は、組なし。前の版の Evidence（hit-test の事実がない）は、今までの判定（z-index の近似・DEF-204 の入れ物を除く・AUD-3a）のまま。
 */
export const classifiedOcclusionPairsOf = (
  layout: LayoutEvidence,
  kind: OcclusionLayoutKind = 'AFTER_NOTIFICATION_DISMISSAL',
): readonly ClassifiedOcclusionPair[] => {
  if (layout.scrollPosition.scrollX !== 0 || layout.scrollPosition.scrollY !== 0) {
    return [];
  }
  const { viewportWidth, viewportHeight } = layout.document;
  const fixedLayerSelectors = fixedLayerSelectorsOf(layout);
  const passThroughContainers = passThroughContainerSelectorsOf(layout);
  const pairs: ClassifiedOcclusionPair[] = [];
  for (const facts of occlusionFactsOf(layout)) {
    const { hitTest } = facts;
    if (
      !isPainted(facts.overlayVisibility)
      || (hitTest === undefined && passThroughContainers.has(facts.overlaySelector))
      || !isPaintedContent(facts.coveredVisibility)
      || facts.coveredInFixedLayer
      || isFixedPosition(facts.coveredPosition)
      || fixedLayerSelectors.has(facts.coveredSelector)
      || (hitTest === undefined && !overlayPaintsAbove(facts))
    ) {
      continue;
    }
    const ratio = coveredRatioOf(facts.overlayRect, facts.coveredRect, viewportWidth, viewportHeight);
    if (!Number.isFinite(ratio) || ratio <= FIXED_OCCLUSION_MIN_COVERED_RATIO) {
      continue;
    }
    const scrollRevealable = kind === 'AFTER_NOTIFICATION_DISMISSAL' && reachableByScroll(facts, layout.document);
    if (hitTest === undefined) {
      pairs.push({ facts, ratio, overlapClass: scrollRevealable ? 'SCROLL_REVEALABLE' : null, render: null });
      continue;
    }
    if (passThroughContainers.has(facts.overlaySelector) && !isModal(hitTest)) {
      pairs.push({ facts, ratio, overlapClass: 'GEOMETRY_ONLY', render: 'NONE' });
      continue;
    }
    const judged = hitTestJudgementOf(hitTest, { overlayAbove: overlayPaintsAbove(facts) });
    pairs.push({
      facts,
      ratio,
      overlapClass: fixedOverlapClassOf({ modal: isModal(hitTest), scrollRevealable, render: judged.render, pointerCaptured: judged.capturedPointCount > 0 }),
      render: judged.render,
    });
  }
  return pairs;
};

// ---------------------------------------------------------------------------------------------------------------
// OVERSIZED_FIXED_ELEMENT の要素
// ---------------------------------------------------------------------------------------------------------------

/** 区分を付けた、大きすぎる固定要素。`overlapClass`・`render` が `null` の要素は、前の版の Evidence（今までの判定で数える）。 */
export interface ClassifiedFixedElement {
  readonly element: FixedElementEvidence;
  readonly ratio: number;
  readonly overlapClass: FixedOverlapClass | null;
  readonly render: FixedOverlapRenderLevel | null;
}

/**
 * 見える固定要素（`position: fixed | sticky`）が、ビューポートの面積のしきい値を超えて占めるものに、区分を付ける。z-index が負の固定要素は、内容の奥に描く背景と
 * みなし、対象にしない。前の版の Evidence は、今までどおり DEF-204 の入れ物を除く。AUD-3c: hit-test の事実がある要素は、要素の面の上の点で、その下にある内容
 * （祖先でない要素）を描画と押下で妨げるかで区分する（下に内容がない、内容を中に持つ外枠は `GEOMETRY_ONLY`）。
 */
export const classifiedOversizedFixedElementsOf = (layout: LayoutEvidence): readonly ClassifiedFixedElement[] =>
  layout.fixedElements.flatMap((element): ClassifiedFixedElement[] => {
    const ratio = element.viewportAreaRatio;
    const { hitTest } = element;
    if (
      !isPainted(element.visibility)
      || (hitTest === undefined && isPassThroughContainer(element))
      || (parseZIndex(element.zIndex) ?? 0) < 0
      || !Number.isFinite(ratio)
      || ratio <= OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO
      || areaOf(element.rect) <= 0
    ) {
      return [];
    }
    if (hitTest === undefined) {
      return [{ element, ratio, overlapClass: null, render: null }];
    }
    if (isPassThroughContainer(element) && !isModal(hitTest)) {
      return [{ element, ratio, overlapClass: 'GEOMETRY_ONLY', render: 'NONE' }];
    }
    const judged = hitTestJudgementOf(hitTest, { overlayAbove: true });
    return [{
      element,
      ratio,
      overlapClass: fixedOverlapClassOf({ modal: isModal(hitTest), scrollRevealable: false, render: judged.render, pointerCaptured: judged.capturedPointCount > 0 }),
      render: judged.render,
    }];
  });

// ---------------------------------------------------------------------------------------------------------------
// EV-2: 動かして測り直した覆いの区分（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 動かして測り直した覆いの区分（強い順）。
 * - `HIDDEN_AT_END`: 対象を動かした位置でも、末尾まで動かした位置でも、隠れたまま（または見えない）。
 * - `SCROLL_AVOIDABLE`: 覆う部品は残るが、動かした位置のどちらかで、対象が見えて覆われない。
 * - `INITIAL_ONLY`: 動かすと、覆う部品が画面から消える（初めの位置だけの覆い）。
 */
export const FIXED_OCCLUSION_REVEAL_OUTCOMES = Object.freeze(['HIDDEN_AT_END', 'SCROLL_AVOIDABLE', 'INITIAL_ONLY'] as const);
export type FixedOcclusionRevealOutcome = (typeof FIXED_OCCLUSION_REVEAL_OUTCOMES)[number];

/** 押す部品の種類（「押せません」と言える覆われる要素）。 */
const CONTROL_KINDS: ReadonlySet<LayoutElementKind> = new Set(['button', 'link', 'input']);

/**
 * 1 つの組の、動かした位置（`TARGET`）・1 画面分動かした位置（`ONE_SCREEN`）・末尾の位置（`END`）の測りからの区分（決められなければ `null`）。
 * REV-EV12 の I-1: 部品は、動かした位置で覆われたままの組だけを 1 画面分動かし、覆う部品が残る組だけを末尾まで動かす。
 * - 覆う部品が消えた位置で、対象が見えて覆われなければ `INITIAL_ONLY`。動かした位置か末尾で見えて覆われなければ `SCROLL_AVOIDABLE`。末尾でも見えて覆われない
 *   位置がなければ `HIDDEN_AT_END`。
 */
export function occlusionRevealOutcomeOf(
  target: RevealedTargetEvidence | undefined,
  oneScreen: RevealedTargetEvidence | undefined,
  end: RevealedTargetEvidence | undefined,
): FixedOcclusionRevealOutcome | null {
  if (target === undefined) {
    return null;
  }
  // REV-EV3 の M-1: 初めの位置だけの覆いは、覆う部品が消えた位置で、対象が見えて覆われていないときだけ（消えた位置で対象が画面の外なら、一度も見えていない）。
  if ([target, oneScreen, end].some((measured) => measured !== undefined && measured.overlayPresent === false && isUncoveredMeasurement(measured))) {
    return 'INITIAL_ONLY';
  }
  if (isUncoveredMeasurement(target) || (end !== undefined && isUncoveredMeasurement(end))) {
    return 'SCROLL_AVOIDABLE';
  }
  return end === undefined ? null : 'HIDDEN_AT_END';
}

/** 1 つの覆いの指摘（覆う要素ごと）の測り直しの結果。 */
export interface OcclusionRevealView {
  /** いちばん強い区分（測り直しのない組だけなら `null`）。 */
  readonly outcome: FixedOcclusionRevealOutcome | null;
  /**
   * 「押せません」と言えるか: 押下を捕まえる区分の組で、覆われる要素が押す部品で、測り直しで有効と分かり、末尾でも隠れるもの（見出しなど読む対象と、測り直しの
   * ない組からは言わない）。
   */
  readonly pressBlocked: boolean;
}

/** 覆いの指摘の組と、同じ状態・同じ幅の測り直しの記録から、区分と「押せません」と言えるかを決める（判定の 1 か所）。 */
export function occlusionRevealOf(pairs: readonly ClassifiedOcclusionPair[], reveals: readonly RevealedTargetEvidence[]): OcclusionRevealView {
  let outcome: FixedOcclusionRevealOutcome | null = null;
  let pressBlocked = false;
  for (const { facts, overlapClass } of pairs) {
    const measuredAt = (position: RevealedTargetEvidence['position']): RevealedTargetEvidence | undefined => reveals.find((reveal) =>
      reveal.purpose === 'FIXED_ELEMENT_OCCLUSION' && reveal.position === position
      && reveal.overlaySelector === facts.overlaySelector && reveal.selectors[0] === facts.coveredSelector);
    const target = measuredAt('TARGET');
    const pairOutcome = occlusionRevealOutcomeOf(target, measuredAt('ONE_SCREEN'), measuredAt('END'));
    if (pairOutcome === null) {
      continue;
    }
    if (outcome === null || FIXED_OCCLUSION_REVEAL_OUTCOMES.indexOf(pairOutcome) < FIXED_OCCLUSION_REVEAL_OUTCOMES.indexOf(outcome)) {
      outcome = pairOutcome;
    }
    pressBlocked ||= pairOutcome === 'HIDDEN_AT_END'
      && (overlapClass === 'RENDER_AND_POINTER' || overlapClass === 'POINTER_ONLY')
      && CONTROL_KINDS.has(facts.coveredKind)
      && target?.control?.interactive === true && target.control.enabled;
  }
  return { outcome, pressBlocked };
}

// ---------------------------------------------------------------------------------------------------------------
// 指摘ごとの区分と、Finding にしなかった区分の数（表示用モデルが読む）
// ---------------------------------------------------------------------------------------------------------------

/** 1 つの指摘の区分（覆う要素ごとの、いちばん強い区分）と、描画を決められたか（いちばん強い描画の度合いが `PARTIAL` なら偽）。 */
export interface FixedOverlapFindingView {
  readonly overlapClass: FixedOverlapClass;
  readonly renderDetermined: boolean;
}

/** 覆う要素の、Finding にする組の区分（前の版の Evidence の組だけなら `null`）。 */
export const occlusionFindingViewOf = (pairs: readonly ClassifiedOcclusionPair[]): FixedOverlapFindingView | null => {
  const classified = pairs.flatMap(({ overlapClass, render }) => (overlapClass === null || render === null ? [] : [{ overlapClass, render }]));
  const overlapClass = strongestFixedOverlapClass(classified.map((pair) => pair.overlapClass));
  if (overlapClass === null) {
    return null;
  }
  const render = classified.reduce<FixedOverlapRenderLevel>((strongest, pair) => strongerRender(strongest, pair.render), 'NONE');
  return { overlapClass, renderDetermined: render !== 'PARTIAL' };
};

/** 大きすぎる固定要素の区分（前の版の Evidence なら `null`）。 */
export const oversizedFindingViewOf = (classified: ClassifiedFixedElement): FixedOverlapFindingView | null =>
  (classified.overlapClass === null || classified.render === null
    ? null
    : { overlapClass: classified.overlapClass, renderDetermined: classified.render !== 'PARTIAL' });

/** 指摘の目印（Finding の `groupingKeys`、または下書きの同一性の要素）の値。 */
const keyValueOf = (keys: readonly { readonly name: string; readonly value: string }[], name: string): string | undefined =>
  keys.find((key) => key.name === name)?.value;

/**
 * 指摘の区分（覆いの Rule と大きすぎる固定要素の Rule だけ。ほかの Rule・前の版の Evidence・目印のない指摘は `null`）。指摘が参照する layout の Evidence の payload と、
 * 指摘の目印（覆う要素の selector・幅）から、Rule と同じ決め方で引く。幅の目印があれば、その幅の結果。覆いの Rule で主の layout に組がなければ、通知の枠を閉じる前の
 * layout（DEF-210）で引く。
 */
export function fixedOverlapOfFinding(
  finding: { readonly ruleId: string; readonly keys: readonly { readonly name: string; readonly value: string }[] },
  payload: EvidencePayloadByType['layout'],
): FixedOverlapFindingView | null {
  const widthText = keyValueOf(finding.keys, 'stressWidth');
  const layout = widthText === undefined
    ? payload.primary.layout
    : payload.stressSweep?.find((result) => String(result.width) === widthText)?.layout ?? null;
  if (layout === null) {
    return null;
  }
  if (finding.ruleId === FIXED_OCCLUSION_RULE_ID) {
    const overlaySelector = keyValueOf(finding.keys, 'overlaySelector');
    if (overlaySelector === undefined) {
      return null;
    }
    const of = (pairs: readonly ClassifiedOcclusionPair[]): readonly ClassifiedOcclusionPair[] =>
      pairs.filter((pair) => pair.facts.overlaySelector === overlaySelector && isFindingFixedOverlapClass(pair.overlapClass));
    const after = of(classifiedOcclusionPairsOf(layout));
    if (after.length > 0 || widthText !== undefined) {
      return occlusionFindingViewOf(after);
    }
    const before = payload.beforeNotificationDismissal?.layout ?? null;
    return before === null ? null : occlusionFindingViewOf(of(classifiedOcclusionPairsOf(before, 'BEFORE_NOTIFICATION_DISMISSAL')));
  }
  if (finding.ruleId === OVERSIZED_FIXED_ELEMENT_RULE_ID) {
    const selector = keyValueOf(finding.keys, 'selector');
    const classified = classifiedOversizedFixedElementsOf(layout).find((candidate) => candidate.element.selector === selector);
    return classified === undefined ? null : oversizedFindingViewOf(classified);
  }
  return null;
}

/** Finding にしなかった区分の数の 1 行。 */
export interface FixedOverlapNotCountedEntry {
  readonly ruleId: string;
  readonly overlapClass: FixedOverlapClass;
  readonly count: number;
}

/**
 * 1 つの layout の Evidence の payload で、Finding にしなかった区分（`GEOMETRY_ONLY`・`MODAL`・`SCROLL_REVEALABLE`）の数。覆いの Rule は、主の layout と
 * 幅ごとの結果の組の数（Rule と同じ範囲）。大きすぎる固定要素の Rule は、主の layout の要素の数。通知の枠を閉じる前の layout は数えない。並びは Rule、区分の順。
 */
export function fixedOverlapsNotCountedOf(payload: EvidencePayloadByType['layout']): readonly FixedOverlapNotCountedEntry[] {
  const counts = new Map<string, number>();
  const add = (ruleId: string, overlapClass: FixedOverlapClass | null): void => {
    if (overlapClass !== null && !isFindingFixedOverlapClass(overlapClass)) {
      const key = JSON.stringify([ruleId, overlapClass]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };
  for (const { layout } of layoutSourcesOfPayload(payload, 'PRIMARY_AND_STRESS_SWEEP')) {
    for (const pair of classifiedOcclusionPairsOf(layout)) {
      add(FIXED_OCCLUSION_RULE_ID, pair.overlapClass);
    }
  }
  for (const { layout } of layoutSourcesOfPayload(payload, 'PRIMARY')) {
    for (const element of classifiedOversizedFixedElementsOf(layout)) {
      add(OVERSIZED_FIXED_ELEMENT_RULE_ID, element.overlapClass);
    }
  }
  const entries: FixedOverlapNotCountedEntry[] = [];
  for (const ruleId of [FIXED_OCCLUSION_RULE_ID, OVERSIZED_FIXED_ELEMENT_RULE_ID]) {
    for (const overlapClass of FIXED_OVERLAP_CLASSES) {
      const count = counts.get(JSON.stringify([ruleId, overlapClass]));
      if (count !== undefined) {
        entries.push({ ruleId, overlapClass, count });
      }
    }
  }
  return entries;
}
