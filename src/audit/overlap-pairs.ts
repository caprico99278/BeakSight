/**
 * EV-2（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 重なりの指摘にする組の決め方と、対象まで動かして撮る対象の選び方の 1 か所
 * （EV-4: 見切れの対象も、ここで選ぶ）。
 * `ELEMENT_OVERLAP`・`CONTENT_COLLISION` の Rule（`./layout-rules.ts`）と、Page Auditor（撮る対象を選ぶ）が使う。Page Auditor は Rule のファイルを import
 * できない（GATE-ARCH07）ので、判定をここに置く（`./fixed-overlap-classes.ts` と同じ形）。
 */
import type { ElementOverlapEvidence, LayoutElementEvidence, LayoutElementKind, LayoutEvidence, RevealTargetSpec } from '../core/evidence-types.js';
import { compareCodeUnits } from '../core/text.js';
import { classifiedOcclusionPairsOf, isFindingFixedOverlapClass, isPaintedContent } from './fixed-overlap-classes.js';
import { textClippingDirectionsOf } from './text-clipping.js';

/**
 * `ELEMENT_OVERLAP`・`CONTENT_COLLISION`: 重なりの面積が、小さい方の要素の面積に占める割合が、これを超えたら Finding にする。
 * 行の高さの余白（half-leading）や、数 px の負の margin による箱の重なりは、文字や画像の重なりにならないことが多いので、
 * 小さい方の要素の4分の1を超えて重なる場合に限る。
 */
export const OVERLAP_MIN_AREA_RATIO = 0.25;

/** テキストを含む主要要素の種類（`CONTENT_COLLISION` の対象）。 */
const TEXT_ELEMENT_KINDS: readonly LayoutElementKind[] = Object.freeze(['heading', 'paragraph']);

/**
 * テキストを含まない主要要素の種類（`ELEMENT_OVERLAP` の対象）。テキストの要素とこれらの組は、float で回り込む画像やボタンと、
 * その横の段落の箱が重なるだけの場合と区別できない（Evidence に float がない）ので、Finding にしない。
 * 表（`table`）と埋め込み（`media`）は、はみ出しの判定のために加えた種類（設計書 5.1.2、RT12r の N3）で、重なりの対象には加えない。
 */
const NON_TEXT_ELEMENT_KINDS: readonly LayoutElementKind[] = Object.freeze(['image', 'button', 'link', 'input']);

/**
 * 重なりの判定の対象にする要素か。見える内容で、静的配置（`position: static`）で、z-index を指定せず、固定要素の子孫でないもの。
 * 固定要素とその子孫の重なりは、`FIXED_ELEMENT_OCCLUSION`・`OVERSIZED_FIXED_ELEMENT` で扱う。
 * `absolute` などで意図して重ねた要素と、z-index で重なりの順序を指定した要素は、意図した重なりと区別できないので除く。
 */
const isStaticOverlapElement = (element: LayoutElementEvidence): boolean =>
  isPaintedContent(element.visibility)
  && element.position === 'static'
  && element.zIndex === 'auto'
  && !element.fixedOrStickyAncestor;

export type OverlapRuleId = 'ELEMENT_OVERLAP' | 'CONTENT_COLLISION';

/** 重なりの組が、どちらの Rule の対象か。どちらでもなければ null（テキストの要素とテキストでない要素の組など）。 */
const overlapRuleFor = (overlap: ElementOverlapEvidence): OverlapRuleId | null => {
  const kinds = [overlap.first.kind, overlap.second.kind];
  if (kinds.every((kind) => TEXT_ELEMENT_KINDS.includes(kind))) {
    return 'CONTENT_COLLISION';
  }
  if (kinds.every((kind) => NON_TEXT_ELEMENT_KINDS.includes(kind))) {
    return 'ELEMENT_OVERLAP';
  }
  return null;
};

/** 指摘にする重なりの組（selector はコードの単位の順）。 */
export interface OverlapFindingPair {
  readonly firstSelector: string;
  readonly secondSelector: string;
  readonly overlapArea: number;
  readonly ratio: number;
}

/** その Rule が指摘にする重なりの組（判定の 1 か所。Rule と、対象まで動かして撮る対象の選び方が使う）。 */
export const overlapFindingPairsOf = (layout: LayoutEvidence, ruleId: OverlapRuleId): readonly OverlapFindingPair[] =>
  layout.elementOverlaps.flatMap((overlap) => {
    if (
      overlapRuleFor(overlap) !== ruleId
      || !isStaticOverlapElement(overlap.first)
      || !isStaticOverlapElement(overlap.second)
    ) {
      return [];
    }
    // EV-1: ELEMENT_OVERLAP は、行ごとの矩形の重なりの事実があれば、その面積で比べる。外接矩形だけの重なり（複数行のリンクの空き）は、面積が 0 になり
    // 指摘にしない。事実のない前の版の Evidence は、外接矩形のまま。REV-SD2 の I-3: 重なりの点の hit-test（両方が押下に出るか）は記録だけで、消す理由に
    // しない（押下を通す飾り `pointer-events: none` との本当の重なりを消さない）。
    const lineOverlap = ruleId === 'ELEMENT_OVERLAP' ? overlap.lineOverlap : undefined;
    const overlapArea = lineOverlap?.area ?? overlap.intersection.area;
    const smallerArea = Math.min(overlap.first.area, overlap.second.area);
    const ratio = smallerArea > 0 ? overlapArea / smallerArea : 0;
    if (!Number.isFinite(ratio) || ratio <= OVERLAP_MIN_AREA_RATIO) {
      return [];
    }
    const [firstSelector = '', secondSelector = ''] = [overlap.first.selector, overlap.second.selector].sort(compareCodeUnits);
    return [{ firstSelector, secondSelector, overlapArea, ratio }];
  });

/**
 * 1 つの layout（主の layout か幅の layout）で、対象まで動かして撮る対象（指摘にする重なりの組と、指摘にする覆いの組の覆われる要素）。選び方は Rule と同じ
 * 判定（`overlapFindingPairsOf`・`classifiedOcclusionPairsOf`）。並びは重なり → 見切れ → 覆い。EV-4: 主の layout（`primary`）では、指摘にする見切れの要素
 * （`textClippingDirectionsOf`。Rule は主の layout だけを見る）も足す。
 */
export const revealTargetsOfLayout = (layout: LayoutEvidence, primary: boolean): readonly RevealTargetSpec[] => [
  ...(['ELEMENT_OVERLAP', 'CONTENT_COLLISION'] as const).flatMap((ruleId) => overlapFindingPairsOf(layout, ruleId).map(({ firstSelector, secondSelector }) => ({
    purpose: 'ELEMENT_OVERLAP' as const,
    selectors: [firstSelector, secondSelector],
  }))),
  ...(primary ? layout.clippedText : [])
    .filter((clipped) => textClippingDirectionsOf(clipped) !== null)
    .map(({ selector }) => ({ purpose: 'TEXT_CLIPPING' as const, selectors: [selector] })),
  ...classifiedOcclusionPairsOf(layout)
    .filter((pair) => isFindingFixedOverlapClass(pair.overlapClass))
    .map(({ facts }) => ({ purpose: 'FIXED_ELEMENT_OCCLUSION' as const, selectors: [facts.coveredSelector], overlaySelector: facts.overlaySelector })),
];
