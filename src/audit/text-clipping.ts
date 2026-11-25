/**
 * EV-4（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.4）: `TEXT_CLIPPING` の指摘にする見切れの決め方の 1 か所。Rule
 * （`./layout-rules.ts`）と、対象まで動かして撮る対象の選び方（`./overlap-pairs.ts` の `revealTargetsOfLayout`。Page Auditor は Rule のファイルを import できない。
 * GATE-ARCH07）が使う。
 */
import {
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type ClippedTextEvidence,
  type CutScrollRegionEvidence,
  type VisibilityEvidence,
} from '../core/evidence-types.js';
import { isPaintedContent } from './fixed-overlap-classes.js';

/**
 * `TEXT_CLIPPING`: 内容の大きさと表示の大きさの差が、この値以下なら見切れとみなさない（px）。
 * `scrollHeight`・`clientHeight` は整数に丸めた値なので、1 px の差は丸めで生じうる。
 */
export const MAX_IGNORED_CLIPPED_OVERFLOW_PX = 1;

/**
 * AUD-4a: `TEXT_CLIPPING`: 行数の省略で、見える行の数が省略の行の数とみなせる差（行。この値を含む）。行の高さと箱の高さの丸め（数 px）を吸収し、
 * 行の途中で切れる箱（半行の差）は残すため、4分の1行にした（layout の collector の行のまたぎのしきい値 `clippedTextLineMinOutsideRatio` と同じ考え）。
 */
export const LINE_CLAMP_VISIBLE_LINE_TOLERANCE = 0.25;

/** 内容を切り取り、スクロールでも見せない `overflow`（`auto`・`scroll` はスクロールで見られるので含めない）。 */
const CLIPPING_OVERFLOWS: readonly string[] = Object.freeze(['hidden', 'clip']);

/**
 * DEF-205: `clip`・`clip-path` で描く面が 0 の要素（視覚的に隠す手法。祖先が隠すものを含む）か。記録のない前の版の Evidence は、隠していないものとして
 * 扱う（今までどおり数える）。`TEXT_CLIPPING`・`ELEMENT_OUTSIDE_VIEWPORT` が外す。
 */
export const isClippedToZeroArea = (visibility: VisibilityEvidence): boolean => visibility.clippedToZeroArea === true;

/**
 * AUD-4a: 見切れの候補が、意図した省略か（Finding から外すか）。`horizontal`・`vertical` は、`TEXT_CLIPPING` が見切れとみなした方向。
 * - `COLLAPSED`（閉じた折りたたみ）: 外す。
 * - `INTENDED_ELLIPSIS`（ellipsis で折り返さない）: 横だけ見切れるときに外す。
 * - `LINE_CLAMP`（行数の省略）: 縦だけ見切れて、見える行の数が省略の行の数と `LINE_CLAMP_VISIBLE_LINE_TOLERANCE` の差の中なら外す
 *   （行の途中で切れるもの、clamp と高さが合わないものは残す）。
 * 区分のない記録（AUD-4a より前の Evidence を含む）は外さない（今の判定のまま）。
 */
const isIntendedClipping = (clipped: ClippedTextEvidence, horizontal: boolean, vertical: boolean): boolean => {
  switch (clipped.intendedClipping) {
    case 'COLLAPSED':
      return true;
    case 'INTENDED_ELLIPSIS':
      return horizontal && !vertical;
    case 'LINE_CLAMP': {
      const clampCount = clipped.lineClampCount ?? null;
      const visibleLineCount = clipped.visibleLineCount ?? null;
      return vertical && !horizontal && clampCount !== null && visibleLineCount !== null
        && Math.abs(visibleLineCount - clampCount) <= LINE_CLAMP_VISIBLE_LINE_TOLERANCE;
    }
    default:
      return false;
  }
};

/** 指摘にする見切れの方向。 */
export interface TextClippingDirections {
  readonly horizontal: boolean;
  readonly vertical: boolean;
}

/**
 * `overflow` が `hidden`・`clip` の方向で、内容が表示の大きさを超えて見切れているテキストなら、その方向（指摘にしなければ `null`）。
 * - `auto`・`scroll` の方向はスクロールで見られるので、見切れにしない。
 * - 子孫のテキストが箱で切り取られている候補（`partiallyClippedText`）だけを対象にする。テキストでない中身（画像、カルーセルの外枠）の
 *   はみ出しや、横方向に箱と重ならないテキスト（隠れたスライド）は、対象にしない（設計書 5.1.2）。
 * - 幅か高さが `VISUALLY_HIDDEN_MAX_DIMENSION_PX` 以下の箱は、画面から隠す手法とみなし、見切れにしない。
 * - `clip`・`clip-path` で描く面が 0 の要素（祖先が隠すものを含む）も、画面から隠す手法とみなし、見切れにしない（DEF-205）。
 * - AUD-4a: 意図した省略（`isIntendedClipping`）は、見切れにしない。区分は Evidence の `intendedClipping` に残る（画面には出さない）。
 */
export const textClippingDirectionsOf = (clipped: ClippedTextEvidence): TextClippingDirections | null => {
  if (
    !clipped.partiallyClippedText
    || !isPaintedContent(clipped.visibility)
    || isClippedToZeroArea(clipped.visibility)
    || clipped.rect.width <= VISUALLY_HIDDEN_MAX_DIMENSION_PX
    || clipped.rect.height <= VISUALLY_HIDDEN_MAX_DIMENSION_PX
  ) {
    return null;
  }
  const horizontal = CLIPPING_OVERFLOWS.includes(clipped.overflowX) && clipped.scrollWidth - clipped.clientWidth > MAX_IGNORED_CLIPPED_OVERFLOW_PX;
  const vertical = CLIPPING_OVERFLOWS.includes(clipped.overflowY) && clipped.scrollHeight - clipped.clientHeight > MAX_IGNORED_CLIPPED_OVERFLOW_PX;
  return (horizontal || vertical) && !isIntendedClipping(clipped, horizontal, vertical) ? { horizontal, vertical } : null;
};

/**
 * S-06（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 4.4）: 端が外枠で切れる、内側のスクロール領域で、指摘にするもの。外枠は、
 * 見切れと同じ決まり（`textClippingDirectionsOf`。見る方向・隠す手法・意図した省略）で決める（領域の中の文字は外枠の行の判定に使っていないので、行の判定の
 * 結果は問わない）。記録のない前の版の Evidence は空。
 */
export const cutScrollRegionsOf = (clipped: ClippedTextEvidence): readonly CutScrollRegionEvidence[] => {
  const regions = clipped.cutScrollRegions ?? [];
  return regions.length > 0 && textClippingDirectionsOf({ ...clipped, partiallyClippedText: true }) !== null ? regions : [];
};
