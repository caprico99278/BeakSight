/**
 * EV-2（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 撮った画像の範囲に対象が入ったか（`TargetImageInclusion`）の決め方の 1 か所。
 * 対象まで動かして撮る部品（`src/evidence/reveal-and-capture.ts`。測った矩形と見える部分）と、指摘の画像の参照（`src/core/finding-image-regions.ts`。
 * 画像の座標の矩形と画像の大きさ）が使う。純粋な関数だけ。
 */
import { TARGET_IMAGE_INCLUSIONS, type TargetImageInclusion } from './evidence-types.js';

const [INSIDE, PARTIAL, OUTSIDE] = TARGET_IMAGE_INCLUSIONS;

/** 入ったとみなす誤差（px。小数の矩形の丸め）。 */
export const TARGET_IMAGE_INCLUSION_TOLERANCE_PX = 1;

/** 左上と大きさの矩形。 */
export interface InclusionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 矩形 `inner` の全部が、矩形 `outer` に入るか（誤差つき）。 */
const containsBox = (outer: InclusionBox, inner: InclusionBox): boolean =>
  outer.x <= inner.x + TARGET_IMAGE_INCLUSION_TOLERANCE_PX && outer.y <= inner.y + TARGET_IMAGE_INCLUSION_TOLERANCE_PX
  && outer.x + outer.width >= inner.x + inner.width - TARGET_IMAGE_INCLUSION_TOLERANCE_PX
  && outer.y + outer.height >= inner.y + inner.height - TARGET_IMAGE_INCLUSION_TOLERANCE_PX;

/** hit-test の点の数と、最前面が対象（か子孫）だった点の数。 */
export interface InclusionHits {
  readonly hitTestPointCount: number;
  readonly hitPointCount: number;
}

/**
 * 測った対象の矩形と、見える部分（viewport と、内容を切り取る祖先の箱で切り取った後）から決める（見える部分がなければ `OUTSIDE`）。REV-EV12 の I-2: hit-test の
 * 事実を渡したときは、点があって最前面に対象が 1 つもない（ほかの部品の下に隠れて写らない）なら `OUTSIDE`。
 */
export function inclusionOfVisiblePart(rect: InclusionBox | null, visible: InclusionBox | null, hits?: InclusionHits): TargetImageInclusion {
  if (rect === null || visible === null || (hits !== undefined && hits.hitTestPointCount > 0 && hits.hitPointCount === 0)) {
    return OUTSIDE;
  }
  if (containsBox(visible, rect)) {
    return INSIDE;
  }
  return visible.width > 0 && visible.height > 0 ? PARTIAL : OUTSIDE;
}

/** 画像の座標の矩形の並びが、画像（幅・高さ）に入ったか（全部が入れば `INSIDE`、どれかが一部でも入れば `PARTIAL`、ほかは `OUTSIDE`）。 */
export function inclusionInImage(rects: readonly InclusionBox[], width: number, height: number): TargetImageInclusion {
  const image = { x: 0, y: 0, width, height };
  if (rects.length > 0 && rects.every((rect) => containsBox(image, rect))) {
    return INSIDE;
  }
  const touches = (rect: InclusionBox): boolean => Math.min(rect.x + rect.width, width) > Math.max(rect.x, 0)
    && Math.min(rect.y + rect.height, height) > Math.max(rect.y, 0);
  return rects.some(touches) ? PARTIAL : OUTSIDE;
}

/**
 * 固定の枠の覆いの測り直しの 1 つの位置で、対象が見えて、覆う部品に覆われないか（見える部分の点の最前面が対象で、覆う部品の点がない）。部品（撮る位置を決める）と
 * 覆いの区分（`occlusionRevealOutcomeOf`）が使う 1 か所。
 */
export const isUncoveredMeasurement = (measured: {
  readonly found: boolean;
  readonly visibleRect: InclusionBox | null;
  readonly hitPointCount: number;
  readonly coveredPointCount?: number;
}): boolean => measured.found && measured.visibleRect !== null && measured.hitPointCount > 0 && (measured.coveredPointCount ?? 0) === 0;

/** 分けて撮った部分ごとの結果をまとめる（全部が `INSIDE` なら `INSIDE`、どれかが入れば `PARTIAL`、ほかは `OUTSIDE`）。 */
export function combinedInclusion(inclusions: readonly TargetImageInclusion[]): TargetImageInclusion {
  if (inclusions.length > 0 && inclusions.every((inclusion) => inclusion === INSIDE)) {
    return INSIDE;
  }
  return inclusions.some((inclusion) => inclusion !== OUTSIDE) ? PARTIAL : OUTSIDE;
}
