import type { EvidenceId, Severity } from '../core/contracts.js';
import {
  FIXED_ELEMENT_POSITIONS,
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type ElementOverlapEvidence,
  type LayoutElementEvidence,
  type LayoutElementKind,
  type LayoutEvidence,
  type OutsideViewportEvidence,
  type RectangleEvidence,
  type VisibilityEvidence,
} from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { compareCodeUnits, truncateText } from '../core/text.js';
import { formatDecimal, formatPercent, formatPixels } from '../presentation/format.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// 判定の定数（Task 12・13 の設計書 5.1。値と根拠は、設計書 14.8「誤検知を避ける」に沿って決めた）
// ---------------------------------------------------------------------------------------------------------------

/** `DOCUMENT_HORIZONTAL_OVERFLOW`: 文書の横幅がビューポートを超えてよい量（px）。1 px でも横スクロールが生じるので 0。 */
export const MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX = 0;

/**
 * `ELEMENT_OVERLAP`・`CONTENT_COLLISION`: 重なりの面積が、小さい方の要素の面積に占める割合が、これを超えたら Finding にする。
 * 行の高さの余白（half-leading）や、数 px の負の margin による箱の重なりは、文字や画像の重なりにならないことが多いので、
 * 小さい方の要素の4分の1を超えて重なる場合に限る。
 */
export const OVERLAP_MIN_AREA_RATIO = 0.25;

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

/**
 * `DYNAMIC_LAYOUT_SHIFT`: ユーザー入力のない最大の layout shift の値（CLS の attribution の `largestShiftValue`）が、これを超えたら
 * Finding にする。Web Vitals の CLS の「good」の境界 0.1 と同じ値で、その1回の shift だけで good の範囲を外れる場合に限る。
 * CLS そのものの poor の境界は `src/audit/performance-rules.ts` が持つ（ここでは使わない）。
 */
export const MIN_DYNAMIC_LAYOUT_SHIFT_SCORE = 0.1;

/**
 * `TEXT_CLIPPING`: 内容の大きさと表示の大きさの差が、この値以下なら見切れとみなさない（px）。
 * `scrollHeight`・`clientHeight` は整数に丸めた値なので、1 px の差は丸めで生じうる。
 */
export const MAX_IGNORED_CLIPPED_OVERFLOW_PX = 1;

/** `TEXT_CLIPPING` の文言に載せるテキストの先頭の長さ（UTF-16 のコード単位）。 */
const CLIPPED_TEXT_EXCERPT_LENGTH = 40;

/** 通常の流れの外に置く `position`。画面外に置いて隠す要素や、装飾の重ね置きに使われるので、はみ出しと大きさ0の判定から除く。 */
const OUT_OF_FLOW_POSITIONS: readonly string[] = Object.freeze(['absolute', 'fixed']);

/** 内容を切り取り、スクロールでも見せない `overflow`（`auto`・`scroll` はスクロールで見られるので含めない）。 */
const CLIPPING_OVERFLOWS: readonly string[] = Object.freeze(['hidden', 'clip']);

/** テキストを含む主要要素の種類（`CONTENT_COLLISION` の対象）。 */
const TEXT_ELEMENT_KINDS: readonly LayoutElementKind[] = Object.freeze(['heading', 'paragraph']);

/**
 * テキストを含まない主要要素の種類（`ELEMENT_OVERLAP` の対象）。テキストの要素とこれらの組は、float で回り込む画像やボタンと、
 * その横の段落の箱が重なるだけの場合と区別できない（Evidence に float がない）ので、Finding にしない。
 * 表（`table`）と埋め込み（`media`）は、はみ出しの判定のために加えた種類（設計書 5.1.2、RT12r の N3）で、重なりの対象には加えない。
 */
const NON_TEXT_ELEMENT_KINDS: readonly LayoutElementKind[] = Object.freeze(['image', 'button', 'link', 'input']);

const RULE_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// 共通の小さな処理
// ---------------------------------------------------------------------------------------------------------------

/** 幅ごとの結果から作る Finding の同一性の要素の名前（設計書 5.1.1）。値は幅の10進の文字列。 */
export const STRESS_WIDTH_IDENTITY_FIELD_NAME = 'stressWidth';

/**
 * Rule が判定に使う layout の結果の範囲。
 * - `PRIMARY`: 主要なビューポートの結果（`primary`）だけ。
 * - `PRIMARY_AND_STRESS_SWEEP`: それに加えて、レスポンシブの幅ごとの結果（`stressSweep`）。設計書 5.1.1 の5つの Rule が使う。
 */
type LayoutScope = 'PRIMARY' | 'PRIMARY_AND_STRESS_SWEEP';

interface LayoutSource {
  readonly evidenceId: EvidenceId;
  readonly layout: LayoutEvidence;
  /** 幅ごとの結果の幅（px）。`primary` の結果は null。 */
  readonly stressWidth: number | null;
}

/**
 * 入力のビューポートの layout の事実と、その Evidence の ID。収集が `PARTIAL` でも、集めた事実があれば使う。
 * 収集されなかった部分（上限で省いた候補、期限の後の要素）は、問題なしとみなさず、単に判定しない。
 * 幅ごとの結果（`scope` が `PRIMARY_AND_STRESS_SWEEP` の場合）は、設計書 5.1.1 に従い、次のものを除く。
 * - `FAILED` の結果と、layout が null の結果（`PARTIAL` で layout がある結果は、集めた部分で判定する）。
 * - `primary` の layout のビューポートの幅と同じ幅の結果（`primary` と重複するため）。
 *   `primary` の layout が null の場合は、重複しないので除かない。
 */
const layoutsOf = (input: PageRuleInput, scope: LayoutScope): readonly LayoutSource[] =>
  evidenceOfType(input, 'layout').flatMap((record) => {
    const { evidenceId, payload } = record;
    const primaryLayout = payload.primary.layout;
    const sources: LayoutSource[] = primaryLayout === null ? [] : [{ evidenceId, layout: primaryLayout, stressWidth: null }];
    if (scope === 'PRIMARY_AND_STRESS_SWEEP') {
      const primaryWidth = primaryLayout?.document.viewportWidth ?? null;
      for (const result of payload.stressSweep ?? []) {
        if (result.status !== 'FAILED' && result.layout !== null && result.width !== primaryWidth) {
          sources.push({ evidenceId, layout: result.layout, stressWidth: result.width });
        }
      }
    }
    return sources;
  });

/** 描画されて見える内容か（可視、不透明度が0でない、`aria-hidden` でない）。 */
const isPaintedContent = (visibility: VisibilityEvidence): boolean =>
  visibility.visible && visibility.opacity > 0 && !visibility.ariaHidden;

/** 描画されて見えるか（可視、不透明度が0でない）。固定要素は、`aria-hidden` でも内容を覆うので、これで判定する。 */
const isPainted = (visibility: VisibilityEvidence): boolean => visibility.visible && visibility.opacity > 0;

const isFixedPosition = (position: string): boolean => (FIXED_ELEMENT_POSITIONS as readonly string[]).includes(position);

/** 整数の z-index。`auto` や不明な値は null。 */
const parseZIndex = (zIndex: string): number | null => (/^-?\d+$/u.test(zIndex) ? Number.parseInt(zIndex, 10) : null);

const areaOf = (rect: RectangleEvidence): number => Math.max(0, rect.width) * Math.max(0, rect.height);

const clipToViewport = (rect: RectangleEvidence, width: number, height: number): number =>
  Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0))
  * Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));

const intersectionArea = (first: RectangleEvidence, second: RectangleEvidence, width: number, height: number): number => {
  const left = Math.max(first.left, second.left, 0);
  const top = Math.max(first.top, second.top, 0);
  const right = Math.min(first.right, second.right, width);
  const bottom = Math.min(first.bottom, second.bottom, height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

interface LayoutDraftSpec {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  readonly evidenceId: EvidenceId;
  readonly identityFields: readonly FindingFingerprintIdentityField[];
}

const layoutDraft = ({ ruleId, severity, message, evidenceId, identityFields }: LayoutDraftSpec): FindingDraft => ({
  ruleId,
  ruleVersion: RULE_VERSION,
  category: 'LAYOUT',
  severity,
  message,
  evidenceRefs: [evidenceId],
  identityFields,
});

const layoutRule = (
  ruleId: string,
  severity: Severity,
  evaluate: (input: PageRuleInput, draft: (spec: Omit<LayoutDraftSpec, 'ruleId' | 'severity'>) => FindingDraft) =>
    readonly FindingDraft[],
): AuditRule => ({
  ruleId,
  version: RULE_VERSION,
  category: 'LAYOUT',
  severity,
  evaluate: (input) => evaluate(input, (spec) => layoutDraft({ ...spec, ruleId, severity })),
});

/** 1つの layout の判定の結果（Evidence の ID と、幅の情報を付ける前のもの）。 */
type LayoutJudgement = Omit<LayoutDraftSpec, 'ruleId' | 'severity' | 'evidenceId'>;

/**
 * layout の事実を1つずつ判定する Rule。判定（`judge`）は `primary` と幅ごとの結果で同じものを使い、
 * 幅ごとの結果から作る下書きにだけ、同一性の要素 `stressWidth` と、文言の先頭の幅を加える。
 * `primary` の下書きは `judge` の結果のままにし、既存の fingerprint を変えない。
 */
const layoutFactRule = (
  ruleId: string,
  severity: Severity,
  scope: LayoutScope,
  judge: (layout: LayoutEvidence) => readonly LayoutJudgement[],
): AuditRule => layoutRule(ruleId, severity, (input, draft) =>
  layoutsOf(input, scope).flatMap(({ evidenceId, layout, stressWidth }) =>
    judge(layout).map(({ message, identityFields }) => (stressWidth === null
      ? draft({ message, evidenceId, identityFields })
      : draft({
        message: `レスポンシブの幅 ${formatPixels(stressWidth)} の確認で、${message}`,
        evidenceId,
        identityFields: [...identityFields, { name: STRESS_WIDTH_IDENTITY_FIELD_NAME, value: String(stressWidth) }],
      })))));

// ---------------------------------------------------------------------------------------------------------------
// DOCUMENT_HORIZONTAL_OVERFLOW
// ---------------------------------------------------------------------------------------------------------------

const documentHorizontalOverflow = layoutFactRule('DOCUMENT_HORIZONTAL_OVERFLOW', 'ERROR', 'PRIMARY_AND_STRESS_SWEEP', (layout) => {
  const { document } = layout;
  const overflow = document.horizontalOverflowPx;
  // ビューポートが横に切り取る（`overflow-x: hidden | clip` が html か body から伝わる）場合は、横スクロールが生じない（設計書 5.1.2）。
  if (
    document.viewportHorizontalClip === 'CLIPPED'
    || !Number.isFinite(overflow)
    || overflow <= MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX
  ) {
    return [];
  }
  const documentWidth = Math.max(document.documentElementScrollWidth, document.bodyScrollWidth);
  return [{
    message: `文書の横幅（${formatPixels(documentWidth)}）が、ビューポートの幅（${formatPixels(document.viewportWidth)}）を `
      + `${formatPixels(overflow)} 超えています。`,
    identityFields: [],
  }];
});

// ---------------------------------------------------------------------------------------------------------------
// ELEMENT_OUTSIDE_VIEWPORT
// ---------------------------------------------------------------------------------------------------------------

const isHorizontallyOutside = (box: OutsideViewportEvidence): boolean => box.outside.left || box.outside.right;

/**
 * 一覧（`boxesOutsideViewport`）の中に、横方向にはみ出す祖先があるか（設計書 5.1.2。入れ子の要素ごとに Finding を重ねない）。
 * 最も近い祖先の番号を順にたどる。縦方向だけにはみ出す祖先（ページの下へ続く外枠など）は、同じはみ出しではないので数えない。
 */
const hasHorizontallyOutsideListedAncestor = (
  boxes: readonly OutsideViewportEvidence[],
  box: OutsideViewportEvidence,
): boolean => {
  const visited = new Set<number>();
  for (let index = box.nearestListedAncestorIndex; index !== null && !visited.has(index);) {
    visited.add(index);
    const ancestor = boxes[index];
    if (ancestor === undefined) {
      return false;
    }
    if (isHorizontallyOutside(ancestor)) {
      return true;
    }
    index = ancestor.nearestListedAncestorIndex;
  }
  return false;
};

/**
 * 通常の流れにある（`absolute`・`fixed` でない）見える主要要素が、ビューポートの中に一部を残したまま、横方向に外へはみ出すもの。
 * - 全体がビューポートの外にある要素は、画面外に置いて隠す手法（スキップリンクなど）とみなし、対象にしない。
 * - 横方向に切り取る祖先（`CLIPPED`）か、スクロールできる祖先（`SCROLLABLE`）の中の要素は、はみ出しではないので対象にしない
 *   （カルーセル、横にスクロールする表、body の `overflow-x: hidden`。設計書 5.1.2）。
 * - 主要要素でない要素（kind が `other`）と、横にはみ出す祖先が一覧にある要素は、対象にしない（入れ子ごとに重ねない）。
 */
const elementOutsideViewport = layoutFactRule('ELEMENT_OUTSIDE_VIEWPORT', 'WARN', 'PRIMARY_AND_STRESS_SWEEP', (layout) => {
  const viewportWidth = layout.document.viewportWidth;
  const boxes = layout.boxesOutsideViewport;
  return boxes.flatMap((box) => {
    const { left, right } = box.outside;
    if (
      !(left || right)
      || !isPaintedContent(box.visibility)
      || OUT_OF_FLOW_POSITIONS.includes(box.position)
      || box.rect.right <= 0
      || box.rect.left >= viewportWidth
      || box.horizontalClipAncestor !== 'NONE'
      || box.kind === 'other'
      || hasHorizontallyOutsideListedAncestor(boxes, box)
    ) {
      return [];
    }
    const sides = left && right ? '左右の端' : left ? '左端' : '右端';
    return [{
      message: `要素 ${box.selector} が、ビューポート（幅 ${formatPixels(viewportWidth)}）の${sides}から、横方向に外へはみ出しています`
        + `（要素の左端 ${formatPixels(box.rect.left)}、右端 ${formatPixels(box.rect.right)}）。`,
      identityFields: [{ name: 'selector', value: box.selector }],
    }];
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ELEMENT_OVERLAP と CONTENT_COLLISION
// ---------------------------------------------------------------------------------------------------------------

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

type OverlapRuleId = 'ELEMENT_OVERLAP' | 'CONTENT_COLLISION';

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

const overlapRule = (ruleId: OverlapRuleId, subject: string) =>
  layoutFactRule(ruleId, 'WARN', 'PRIMARY_AND_STRESS_SWEEP', (layout) =>
    layout.elementOverlaps.flatMap((overlap) => {
      if (
        overlapRuleFor(overlap) !== ruleId
        || !isStaticOverlapElement(overlap.first)
        || !isStaticOverlapElement(overlap.second)
      ) {
        return [];
      }
      const smallerArea = Math.min(overlap.first.area, overlap.second.area);
      const ratio = smallerArea > 0 ? overlap.intersection.area / smallerArea : 0;
      if (!Number.isFinite(ratio) || ratio <= OVERLAP_MIN_AREA_RATIO) {
        return [];
      }
      const [firstSelector, secondSelector] = [overlap.first.selector, overlap.second.selector].sort(compareCodeUnits);
      return [{
        message: `${subject} ${firstSelector} と ${secondSelector} が重なっています（重なりの面積 `
          + `${formatDecimal(overlap.intersection.area)} px²。小さい方の要素の面積の ${formatPercent(ratio)} で、`
          + `しきい値 ${formatPercent(OVERLAP_MIN_AREA_RATIO)} を超えています）。`,
        identityFields: [
          { name: 'firstSelector', value: firstSelector ?? '' },
          { name: 'secondSelector', value: secondSelector ?? '' },
        ],
      }];
    }));

// ---------------------------------------------------------------------------------------------------------------
// TEXT_CLIPPING
// ---------------------------------------------------------------------------------------------------------------

/**
 * `overflow` が `hidden`・`clip` の方向で、内容が表示の大きさを超えて見切れているテキスト。
 * - `auto`・`scroll` の方向はスクロールで見られるので、見切れにしない。
 * - 子孫のテキストが箱で切り取られている候補（`partiallyClippedText`）だけを対象にする。テキストでない中身（画像、カルーセルの外枠）の
 *   はみ出しや、横方向に箱と重ならないテキスト（隠れたスライド）は、対象にしない（設計書 5.1.2）。
 * - 幅か高さが `VISUALLY_HIDDEN_MAX_DIMENSION_PX` 以下の箱は、画面から隠す手法とみなし、見切れにしない。
 */
const textClipping = layoutFactRule('TEXT_CLIPPING', 'WARN', 'PRIMARY', (layout) =>
  layout.clippedText.flatMap((clipped) => {
    if (
      !clipped.partiallyClippedText
      || !isPaintedContent(clipped.visibility)
      || clipped.rect.width <= VISUALLY_HIDDEN_MAX_DIMENSION_PX
      || clipped.rect.height <= VISUALLY_HIDDEN_MAX_DIMENSION_PX
    ) {
      return [];
    }
    const details: string[] = [];
    if (
      CLIPPING_OVERFLOWS.includes(clipped.overflowX)
      && clipped.scrollWidth - clipped.clientWidth > MAX_IGNORED_CLIPPED_OVERFLOW_PX
    ) {
      details.push(`横方向: overflow-x: ${clipped.overflowX}、表示の幅 ${formatPixels(clipped.clientWidth)}、`
        + `内容の幅 ${formatPixels(clipped.scrollWidth)}`);
    }
    if (
      CLIPPING_OVERFLOWS.includes(clipped.overflowY)
      && clipped.scrollHeight - clipped.clientHeight > MAX_IGNORED_CLIPPED_OVERFLOW_PX
    ) {
      details.push(`縦方向: overflow-y: ${clipped.overflowY}、表示の高さ ${formatPixels(clipped.clientHeight)}、`
        + `内容の高さ ${formatPixels(clipped.scrollHeight)}`);
    }
    if (details.length === 0) {
      return [];
    }
    const excerpt = truncateText(clipped.text, CLIPPED_TEXT_EXCERPT_LENGTH);
    const text = `${excerpt.text}${excerpt.truncated || clipped.truncated ? '…' : ''}`;
    return [{
      message: `要素 ${clipped.selector} のテキストが見切れています（${details.join('。')}）。テキストの先頭: 「${text}」`,
      identityFields: [{ name: 'selector', value: clipped.selector }],
    }];
  }));

// ---------------------------------------------------------------------------------------------------------------
// FIXED_ELEMENT_OCCLUSION
// ---------------------------------------------------------------------------------------------------------------

interface OcclusionFacts {
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
  readonly coveredInFixedLayer: boolean;
}

/**
 * 固定要素が、覆われる要素より手前に描かれるか。
 * - 固定要素の z-index が負なら、通常の流れの内容より奥に描かれる。
 * - 覆われる要素が静的配置なら、z-index が0以上の固定要素（配置された要素）が手前に描かれる。
 * - 覆われる要素も配置されている場合は、固定要素の z-index（`auto` は0）が、覆われる要素の z-index より大きい場合に限る
 *   （同じ場合は文書の順で決まり、ここでは判断できないので、手前とみなさない）。
 * 重なりの文脈（stacking context）の入れ子は Evidence にないので、同じ文脈にあるとみなす近似である。
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
    // 見出しの祖先の固定要素は、この Evidence にないので、下で主要要素の重なりの事実から補う。
    coveredInFixedLayer: false,
  }));
  for (const { first, second } of layout.elementOverlaps) {
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
      coveredInFixedLayer: covered.fixedOrStickyAncestor,
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

interface OcclusionSummary {
  readonly overlayPosition: string;
  readonly coveredSelectors: Set<string>;
  largestSelector: string;
  largestRatio: number;
}

/**
 * 先頭の位置（文書のスクロール位置が 0, 0）で集めた layout で、見える固定要素が、固定要素でない主要要素を覆うもの。
 * 固定要素ごとに1件にまとめ、覆った要素の件数と、最も大きく覆われた要素を文言に載せる。
 */
const fixedElementOcclusion = layoutFactRule('FIXED_ELEMENT_OCCLUSION', 'WARN', 'PRIMARY_AND_STRESS_SWEEP', (layout) => {
  if (layout.scrollPosition.scrollX !== 0 || layout.scrollPosition.scrollY !== 0) {
    return [];
  }
  const { viewportWidth, viewportHeight } = layout.document;
  const fixedLayerSelectors = fixedLayerSelectorsOf(layout);
  const summaries = new Map<string, OcclusionSummary>();
  for (const facts of occlusionFactsOf(layout)) {
    if (
      !isPainted(facts.overlayVisibility)
      || !isPaintedContent(facts.coveredVisibility)
      || facts.coveredInFixedLayer
      || isFixedPosition(facts.coveredPosition)
      || fixedLayerSelectors.has(facts.coveredSelector)
      || !overlayPaintsAbove(facts)
    ) {
      continue;
    }
    const coveredVisibleArea = clipToViewport(facts.coveredRect, viewportWidth, viewportHeight);
    const ratio = coveredVisibleArea > 0
      ? intersectionArea(facts.overlayRect, facts.coveredRect, viewportWidth, viewportHeight) / coveredVisibleArea
      : 0;
    if (!Number.isFinite(ratio) || ratio <= FIXED_OCCLUSION_MIN_COVERED_RATIO) {
      continue;
    }
    const summary = summaries.get(facts.overlaySelector);
    if (summary === undefined) {
      summaries.set(facts.overlaySelector, {
        overlayPosition: facts.overlayPosition,
        coveredSelectors: new Set([facts.coveredSelector]),
        largestSelector: facts.coveredSelector,
        largestRatio: ratio,
      });
      continue;
    }
    summary.coveredSelectors.add(facts.coveredSelector);
    if (
      ratio > summary.largestRatio
      || (ratio === summary.largestRatio && compareCodeUnits(facts.coveredSelector, summary.largestSelector) < 0)
    ) {
      summary.largestSelector = facts.coveredSelector;
      summary.largestRatio = ratio;
    }
  }
  return [...summaries].map(([overlaySelector, summary]) => ({
    message: `先頭の位置で、固定要素 ${overlaySelector}（position: ${summary.overlayPosition}）が、主要要素 `
      + `${summary.coveredSelectors.size} 件を覆っています。最も大きく覆われた要素は ${summary.largestSelector} で、`
      + `ビューポートの中に見えている面積の ${formatPercent(summary.largestRatio)} が重なっています`
      + `（しきい値 ${formatPercent(FIXED_OCCLUSION_MIN_COVERED_RATIO)}）。`,
    identityFields: [{ name: 'overlaySelector', value: overlaySelector }],
  }));
});

// ---------------------------------------------------------------------------------------------------------------
// ZERO_SIZE_INTERACTIVE_ELEMENT
// ---------------------------------------------------------------------------------------------------------------

/**
 * 可視と判定された操作要素（リンク、ボタン、入力欄）の幅か高さが0のもの。
 * - 通常の流れの外の要素（`absolute`・`fixed`）は、見た目を置き換えたチェックボックスや、フォーカスまで隠すスキップリンクなど、
 *   意図して大きさを0にする手法と区別できないので除く。透明な要素と `aria-hidden` の要素も除く。
 * - 大きさのある描画された子孫を持つ要素（float の画像や absolute の子を包むリンク）は、実際に操作できるので除く（設計書 5.1.2）。
 */
const zeroSizeInteractiveElement = layoutFactRule('ZERO_SIZE_INTERACTIVE_ELEMENT', 'WARN', 'PRIMARY', (layout) =>
  layout.zeroSizeInteractive.flatMap((element) => {
    if (
      element.hasRenderedDescendant
      || !isPaintedContent(element.visibility)
      || OUT_OF_FLOW_POSITIONS.includes(element.position)
    ) {
      return [];
    }
    const role = element.role === null ? '' : `、role="${element.role}"`;
    return [{
      message: `操作要素 ${element.selector}（${element.tagName}${role}）は可視と判定されましたが、大きさが `
        + `${formatDecimal(element.rect.width)} × ${formatPixels(element.rect.height)} です。`,
      identityFields: [{ name: 'selector', value: element.selector }],
    }];
  }));

// ---------------------------------------------------------------------------------------------------------------
// OVERSIZED_FIXED_ELEMENT
// ---------------------------------------------------------------------------------------------------------------

/**
 * 見える固定要素（`position: fixed | sticky`）が、ビューポートの面積のしきい値を超えて占めるもの。
 * z-index が負の固定要素は、内容の奥に描く背景とみなし、対象にしない。
 */
const oversizedFixedElement = layoutFactRule('OVERSIZED_FIXED_ELEMENT', 'WARN', 'PRIMARY', (layout) =>
  layout.fixedElements.flatMap((element) => {
    const ratio = element.viewportAreaRatio;
    if (
      !isPainted(element.visibility)
      || (parseZIndex(element.zIndex) ?? 0) < 0
      || !Number.isFinite(ratio)
      || ratio <= OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO
      || areaOf(element.rect) <= 0
    ) {
      return [];
    }
    return [{
      message: `固定要素 ${element.selector}（position: ${element.position}）が、ビューポートの面積の ${formatPercent(ratio)} を`
        + `占めています（しきい値 ${formatPercent(OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO)}）。`,
      identityFields: [{ name: 'selector', value: element.selector }],
    }];
  }));

// ---------------------------------------------------------------------------------------------------------------
// DYNAMIC_LAYOUT_SHIFT
// ---------------------------------------------------------------------------------------------------------------

/**
 * CLS の attribution に、ユーザー入力のない layout shift で最も大きく動いた要素と、その shift の値が記録され、値がしきい値を超えるもの。
 * CLS は、直前にユーザー入力があった shift を含めないので、attribution の shift はユーザー入力のないものである。
 * CLS を観測できなかった場合と、要素が記録されていない場合は、Finding を作らない。
 */
const dynamicLayoutShift = layoutRule('DYNAMIC_LAYOUT_SHIFT', 'WARN', (input, draft) =>
  evidenceOfType(input, 'performance').flatMap((record) => {
    const cls = record.payload.webVitals?.CLS;
    if (cls === undefined || cls.status !== 'OBSERVED' || cls.attribution === null) {
      return [];
    }
    const { largestShiftTarget: target, largestShiftValue: value } = cls.attribution;
    if (
      typeof target !== 'string'
      || target.length === 0
      || typeof value !== 'number'
      || !Number.isFinite(value)
      || value <= MIN_DYNAMIC_LAYOUT_SHIFT_SCORE
    ) {
      return [];
    }
    return [draft({
      message: `ユーザー入力のない layout shift で、要素 ${target} が動きました（最大の shift の値 ${formatDecimal(value)}、`
        + `しきい値 ${formatDecimal(MIN_DYNAMIC_LAYOUT_SHIFT_SCORE)}）。`,
      evidenceId: record.evidenceId,
      identityFields: [{ name: 'shiftTarget', value: target }],
    })];
  }));

/** レイアウトの page rule（T12c）の一覧。登録は `RULE_CATALOG`（`./rule-catalog.ts`）がまとめて行う。 */
export const LAYOUT_RULES: readonly AuditRule[] = Object.freeze([
  documentHorizontalOverflow,
  elementOutsideViewport,
  overlapRule('ELEMENT_OVERLAP', '要素'),
  textClipping,
  fixedElementOcclusion,
  zeroSizeInteractiveElement,
  overlapRule('CONTENT_COLLISION', '見出し・段落の要素'),
  oversizedFixedElement,
  dynamicLayoutShift,
]);
