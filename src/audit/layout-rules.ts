import type { EvidenceId, EvidencePayloadByType, Severity } from '../core/contracts.js';
import type {
  LayoutEvidence,
  NotificationFrameHiddenReason,
  NotificationOverlayEvidence,
  OutsideViewportEvidence,
  RevealedTargetEvidence,
} from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { compareCodeUnits, truncateText } from '../core/text.js';
import { formatDecimal, formatPercent, formatPixels } from '../presentation/format.js';
import {
  FIXED_OCCLUSION_REVEAL_TEXT,
  FIXED_OVERLAP_READ_TARGET_TEXT,
  FIXED_OVERLAP_TEXT,
  NOTIFICATION_OVERLAY_TEXT,
  stressWidthFindingMessageText,
} from '../presentation/messages.js';
import {
  FIXED_OCCLUSION_MIN_COVERED_RATIO,
  FIXED_OCCLUSION_REACHABLE_BY_SCROLL,
  OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO,
  classifiedOcclusionPairsOf,
  classifiedOversizedFixedElementsOf,
  isFindingFixedOverlapClass,
  isPaintedContent,
  layoutSourcesOfPayload,
  occlusionFindingViewOf,
  occlusionRevealOf,
  oversizedFindingViewOf,
  type ClassifiedOcclusionPair,
  type FixedOverlapFindingView,
  type LayoutScope,
  type OcclusionLayoutKind,
} from './fixed-overlap-classes.js';
import { OVERLAP_MIN_AREA_RATIO, overlapFindingPairsOf, type OverlapRuleId } from './overlap-pairs.js';
import {
  LINE_CLAMP_VISIBLE_LINE_TOLERANCE,
  MAX_IGNORED_CLIPPED_OVERFLOW_PX,
  isClippedToZeroArea,
  textClippingDirectionsOf,
} from './text-clipping.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// 判定の定数（Task 12・13 の設計書 5.1。値と根拠は、設計書 14.8「誤検知を避ける」に沿って決めた）
// ---------------------------------------------------------------------------------------------------------------

/** `DOCUMENT_HORIZONTAL_OVERFLOW`: 文書の横幅がビューポートを超えてよい量（px）。1 px でも横スクロールが生じるので 0。 */
export const MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX = 0;

// EV-2: `ELEMENT_OVERLAP`・`CONTENT_COLLISION` の面積の比のしきい値と、組の決め方は `./overlap-pairs.ts` の 1 か所（ここは写さない）。
export { OVERLAP_MIN_AREA_RATIO };

// AUD-3b・3c: `FIXED_ELEMENT_OCCLUSION`・`OVERSIZED_FIXED_ELEMENT` のしきい値と、覆いの区分の決め方は `./fixed-overlap-classes.ts` の 1 か所（ここは写さない）。
export { FIXED_OCCLUSION_MIN_COVERED_RATIO, FIXED_OCCLUSION_REACHABLE_BY_SCROLL, OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO };

/**
 * `DYNAMIC_LAYOUT_SHIFT`: ユーザー入力のない最大の layout shift の値（CLS の attribution の `largestShiftValue`）が、これを超えたら
 * Finding にする。Web Vitals の CLS の「good」の境界 0.1 と同じ値で、その1回の shift だけで good の範囲を外れる場合に限る。
 * CLS そのものの poor の境界は `src/audit/performance-rules.ts` が持つ（ここでは使わない）。
 */
export const MIN_DYNAMIC_LAYOUT_SHIFT_SCORE = 0.1;

// EV-4: `TEXT_CLIPPING` の差のしきい値と、指摘にする見切れの決め方は `./text-clipping.ts` の 1 か所（ここは写さない）。
export { LINE_CLAMP_VISIBLE_LINE_TOLERANCE, MAX_IGNORED_CLIPPED_OVERFLOW_PX };

/** `TEXT_CLIPPING` の文言に載せるテキストの先頭の長さ（UTF-16 のコード単位）。 */
const CLIPPED_TEXT_EXCERPT_LENGTH = 40;

/** 通常の流れの外に置く `position`。画面外に置いて隠す要素や、装飾の重ね置きに使われるので、はみ出しと大きさ0の判定から除く。 */
const OUT_OF_FLOW_POSITIONS: readonly string[] = Object.freeze(['absolute', 'fixed']);

const RULE_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// 共通の小さな処理
// ---------------------------------------------------------------------------------------------------------------

/** 幅ごとの結果から作る Finding の同一性の要素の名前（設計書 5.1.1）。値は幅の10進の文字列。 */
export const STRESS_WIDTH_IDENTITY_FIELD_NAME = 'stressWidth';

interface LayoutSource {
  readonly evidenceId: EvidenceId;
  readonly layout: LayoutEvidence;
  /** 幅ごとの結果の幅（px）。`primary` の結果は null。 */
  readonly stressWidth: number | null;
}

/**
 * 入力のビューポートの layout の事実と、その Evidence の ID。収集が `PARTIAL` でも、集めた事実があれば使う。
 * 収集されなかった部分（上限で省いた候補、期限の後の要素）は、問題なしとみなさず、単に判定しない。
 * 幅ごとの結果の選び方（設計書 5.1.1）は `layoutSourcesOfPayload` の 1 か所（AUD-3c: 区分の数え方と同じ範囲にするため）。
 */
const layoutsOf = (input: PageRuleInput, scope: LayoutScope): readonly LayoutSource[] =>
  evidenceOfType(input, 'layout').flatMap(({ evidenceId, payload }) =>
    layoutSourcesOfPayload(payload, scope).map(({ layout, stressWidth }) => ({ evidenceId, layout, stressWidth })));

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
  plainMessage: string,
  evaluate: (input: PageRuleInput, draft: (spec: Omit<LayoutDraftSpec, 'ruleId' | 'severity'>) => FindingDraft) =>
    readonly FindingDraft[],
): AuditRule => ({
  ruleId,
  version: RULE_VERSION,
  category: 'LAYOUT',
  severity,
  plainMessage,
  evaluate: (input) => evaluate(input, (spec) => layoutDraft({ ...spec, ruleId, severity })),
});

/** 1つの layout の判定の結果（Evidence の ID と、幅の情報を付ける前のもの）。 */
type LayoutJudgement = Omit<LayoutDraftSpec, 'ruleId' | 'severity' | 'evidenceId'>;

/**
 * EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: layout の Evidence と同じ状態・同じ幅で、対象まで動かして撮った画像の測り直しの記録
 * （その画像の Evidence の `reveal`）。状態のない前の版の Evidence は、空。
 */
const revealsOf = (input: PageRuleInput, evidenceId: EvidenceId, stressWidth: number | null): readonly RevealedTargetEvidence[] => {
  const stateId = input.evidence.find((record) => record.evidenceId === evidenceId)?.capture?.stateId;
  if (stateId === undefined) {
    return [];
  }
  return evidenceOfType(input, 'screenshot')
    .filter((record) => record.capture?.stateId === stateId && (record.payload.stressWidth ?? null) === stressWidth)
    .flatMap((record) => record.payload.reveal?.targets ?? []);
};

/**
 * layout の事実を1つずつ判定する Rule。判定（`judge`）は `primary` と幅ごとの結果で同じものを使い、
 * 幅ごとの結果から作る下書きにだけ、同一性の要素 `stressWidth` と、文言の先頭の幅を加える。
 * `primary` の下書きは `judge` の結果のままにし、既存の fingerprint を変えない。EV-2: `judge` は、同じ状態・同じ幅の測り直しの記録も受け取れる。
 */
const layoutFactRule = (
  ruleId: string,
  severity: Severity,
  plainMessage: string,
  scope: LayoutScope,
  judge: (layout: LayoutEvidence, reveals: readonly RevealedTargetEvidence[]) => readonly LayoutJudgement[],
): AuditRule => layoutRule(ruleId, severity, plainMessage, (input, draft) =>
  layoutsOf(input, scope).flatMap(({ evidenceId, layout, stressWidth }) =>
    judge(layout, revealsOf(input, evidenceId, stressWidth)).map(({ message, identityFields }) => (stressWidth === null
      ? draft({ message, evidenceId, identityFields })
      : draft({
        // BN-c: 文の形は `stressWidthFindingMessageText` の 1 か所（幅の読み込みと指摘の結び付けも、同じ関数で照らす）。
        message: stressWidthFindingMessageText(formatPixels(stressWidth), message),
        evidenceId,
        identityFields: [...identityFields, { name: STRESS_WIDTH_IDENTITY_FIELD_NAME, value: String(stressWidth) }],
      })))));

// ---------------------------------------------------------------------------------------------------------------
// DOCUMENT_HORIZONTAL_OVERFLOW
// ---------------------------------------------------------------------------------------------------------------

const documentHorizontalOverflow = layoutFactRule('DOCUMENT_HORIZONTAL_OVERFLOW', 'ERROR',
  'ページが画面の幅より広くなっています。横に動かさないと、全部が見えません。',
  'PRIMARY_AND_STRESS_SWEEP', (layout) => {
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
 * - `clip`・`clip-path` で描く面が 0 の要素（祖先が隠すものを含む）は、画面から隠す手法とみなし、対象にしない（DEF-205）。
 */
const elementOutsideViewport = layoutFactRule('ELEMENT_OUTSIDE_VIEWPORT', 'WARN',
  'ページの部品の一部が、画面の外へはみ出しています。見えないところがあります。',
  'PRIMARY_AND_STRESS_SWEEP', (layout) => {
  const viewportWidth = layout.document.viewportWidth;
  const boxes = layout.boxesOutsideViewport;
  return boxes.flatMap((box) => {
    const { left, right } = box.outside;
    if (
      !(left || right)
      || !isPaintedContent(box.visibility)
      || isClippedToZeroArea(box.visibility)
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

// 指摘にする重なりの組の決め方（対象の要素・どちらの Rule か・面積の比）は `./overlap-pairs.ts`（`overlapFindingPairsOf`）の 1 か所。

const overlapRule = (ruleId: OverlapRuleId, subject: string, plainMessage: string) =>
  layoutFactRule(ruleId, 'WARN', plainMessage, 'PRIMARY_AND_STRESS_SWEEP', (layout) =>
    overlapFindingPairsOf(layout, ruleId).map(({ firstSelector, secondSelector, overlapArea, ratio }) => ({
      message: `${subject} ${firstSelector} と ${secondSelector} が重なっています（重なりの面積 `
        + `${formatDecimal(overlapArea)} px²。小さい方の要素の面積の ${formatPercent(ratio)} で、`
        + `しきい値 ${formatPercent(OVERLAP_MIN_AREA_RATIO)} を超えています）。`,
      identityFields: [
        { name: 'firstSelector', value: firstSelector },
        { name: 'secondSelector', value: secondSelector },
      ],
    })));

// ---------------------------------------------------------------------------------------------------------------
// TEXT_CLIPPING
// ---------------------------------------------------------------------------------------------------------------

/**
 * `overflow` が `hidden`・`clip` の方向で、内容が表示の大きさを超えて見切れているテキスト。指摘にする見切れの決め方（見る方向・隠す手法・意図した省略）は
 * `textClippingDirectionsOf`（`./text-clipping.ts`）の 1 か所。
 */
const textClipping = layoutFactRule('TEXT_CLIPPING', 'WARN',
  '文字の一部が、欄からはみ出して切れています。最後まで読めないところがあります。',
  'PRIMARY', (layout) =>
  layout.clippedText.flatMap((clipped) => {
    const directions = textClippingDirectionsOf(clipped);
    if (directions === null) {
      return [];
    }
    const details: string[] = [];
    const { horizontal, vertical } = directions;
    if (horizontal) {
      details.push(`横方向: overflow-x: ${clipped.overflowX}、表示の幅 ${formatPixels(clipped.clientWidth)}、`
        + `内容の幅 ${formatPixels(clipped.scrollWidth)}`);
    }
    if (vertical) {
      details.push(`縦方向: overflow-y: ${clipped.overflowY}、表示の高さ ${formatPixels(clipped.clientHeight)}、`
        + `内容の高さ ${formatPixels(clipped.scrollHeight)}`);
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

// AUD-3b・3c: 覆いの組の事実の読み方・手前かの近似・DEF-204 の入れ物・AUD-3a のスクロールで逃がせる量・区分は、`./fixed-overlap-classes.ts`
// （`classifiedOcclusionPairsOf`）の 1 か所。ここでは、Finding にする区分の組を、覆う要素ごとにまとめて文言を作る。

interface OcclusionSummary {
  readonly overlayPosition: string;
  readonly coveredSelectors: Set<string>;
  largestSelector: string;
  largestRatio: number;
  /** AUD-3c: Finding にする組（区分のない前の版の組を含む）。 */
  readonly pairs: ClassifiedOcclusionPair[];
}

/**
 * AUD-3a: `FIXED_ELEMENT_OCCLUSION` が、スクロールすれば外へ出せるので数えなかった組の数と区分。Finding の外の記録のための値で、画面には出さない。
 * 同じ固定要素と要素の組が、見出しの重なりと主要要素の重なりの両方にあれば、2 組と数える（Evidence の組の数）。AUD-3c: 組の区分 `SCROLL_REVEALABLE` を数える。
 */
export const fixedOcclusionScrollExclusionsOf = (
  layout: LayoutEvidence,
): { readonly reason: typeof FIXED_OCCLUSION_REACHABLE_BY_SCROLL; readonly pairCount: number } => ({
  reason: FIXED_OCCLUSION_REACHABLE_BY_SCROLL,
  pairCount: classifiedOcclusionPairsOf(layout).filter((pair) => pair.overlapClass === 'SCROLL_REVEALABLE').length,
});

/**
 * AUD-3c: 区分ごとのやさしい文（区分のない前の版の Evidence の指摘は、文を足さない）。EV-2: 押下を捕まえる区分でも、「押せません」と言えない指摘（見出しなど
 * 読む対象・測り直しのない組・末尾まで隠れたままでない組）は、押せるかに触れない文にする。
 */
const fixedOverlapSentenceOf = (view: FixedOverlapFindingView | null, pressBlocked: boolean): string => {
  if (view === null) {
    return '';
  }
  if (!pressBlocked && (view.overlapClass === 'RENDER_AND_POINTER' || view.overlapClass === 'POINTER_ONLY')) {
    return FIXED_OVERLAP_READ_TARGET_TEXT[view.overlapClass];
  }
  return FIXED_OVERLAP_TEXT[view.overlapClass];
};

/**
 * 先頭の位置（文書のスクロール位置が 0, 0）で集めた layout で、見える固定要素が、固定要素でない主要要素を覆うもの。
 * 固定要素ごとに1件にまとめ、覆った要素の件数と、最も大きく覆われた要素を文言に載せる。
 * AUD-3c: Finding にするのは、区分が `FIXED_OVERLAP_FINDING_CLASSES` の組（と、区分のない前の版の組）だけ。スクロールで逃がせる組（AUD-3a）・幾何だけ・
 * モーダルは数えない。文言の後に、いちばん強い区分のやさしい文を足す（区分のコードは文言に出さない）。DEF-210 の閉じる前の layout には、AUD-3a を当てない。
 */
const judgeFixedElementOcclusion = (
  layout: LayoutEvidence,
  kind: OcclusionLayoutKind = 'AFTER_NOTIFICATION_DISMISSAL',
  reveals: readonly RevealedTargetEvidence[] = [],
): readonly LayoutJudgement[] => {
  const summaries = new Map<string, OcclusionSummary>();
  for (const pair of classifiedOcclusionPairsOf(layout, kind)) {
    if (!isFindingFixedOverlapClass(pair.overlapClass)) {
      continue;
    }
    const { facts, ratio } = pair;
    const summary = summaries.get(facts.overlaySelector);
    if (summary === undefined) {
      summaries.set(facts.overlaySelector, {
        overlayPosition: facts.overlayPosition,
        coveredSelectors: new Set([facts.coveredSelector]),
        largestSelector: facts.coveredSelector,
        largestRatio: ratio,
        pairs: [pair],
      });
      continue;
    }
    summary.pairs.push(pair);
    summary.coveredSelectors.add(facts.coveredSelector);
    if (
      ratio > summary.largestRatio
      || (ratio === summary.largestRatio && compareCodeUnits(facts.coveredSelector, summary.largestSelector) < 0)
    ) {
      summary.largestSelector = facts.coveredSelector;
      summary.largestRatio = ratio;
    }
  }
  return [...summaries].map(([overlaySelector, summary]) => {
    // EV-2: 動かして測り直した結果（末尾でも隠れる・スクロールで避けられる・初めの位置だけ）を文に足し、「押せません」は結果で言えるときだけにする。
    const reveal = occlusionRevealOf(summary.pairs, reveals);
    return {
      message: `先頭の位置で、固定要素 ${overlaySelector}（position: ${summary.overlayPosition}）が、主要要素 `
        + `${summary.coveredSelectors.size} 件を覆っています。最も大きく覆われた要素は ${summary.largestSelector} で、`
        + `ビューポートの中に見えている面積の ${formatPercent(summary.largestRatio)} が重なっています`
        + `（しきい値 ${formatPercent(FIXED_OCCLUSION_MIN_COVERED_RATIO)}）。${fixedOverlapSentenceOf(occlusionFindingViewOf(summary.pairs), reveal.pressBlocked)}`
        + (reveal.outcome === null ? '' : FIXED_OCCLUSION_REVEAL_TEXT[reveal.outcome]),
      identityFields: [{ name: 'overlaySelector', value: overlaySelector }],
    };
  });
};

/** `FIXED_ELEMENT_OCCLUSION` の同一性の要素の名前（覆う固定要素の selector）。 */
const OCCLUSION_IDENTITY_FIELD_NAME = 'overlaySelector';

/**
 * `FIXED_ELEMENT_OCCLUSION`。主の layout と幅ごとの結果は、今までどおり判定する（`layoutFactRule` と同じ）。
 * DEF-210（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.3）: 通知の枠が Run の中で初めて出たビューポートでは、枠を閉じる前の layout
 * （`beforeNotificationDismissal`）も 1 回だけ判定し、主の layout で同じ固定要素の下書きがないものだけを足す（閉じた枠の覆いだけが残る。同じ固定要素を
 * 2 回数えない）。同一性の要素は、主の layout の下書きと同じ形（覆う固定要素の selector）。
 */
const fixedElementOcclusionFacts = layoutFactRule('FIXED_ELEMENT_OCCLUSION', 'WARN',
  '画面に止まって動かない部品が、ページの大事なところを隠しています。',
  'PRIMARY_AND_STRESS_SWEEP', (layout, reveals) => judgeFixedElementOcclusion(layout, 'AFTER_NOTIFICATION_DISMISSAL', reveals));
const fixedElementOcclusion: AuditRule = {
  ...fixedElementOcclusionFacts,
  evaluate: (input) => {
    const drafts = fixedElementOcclusionFacts.evaluate(input);
    const overlaysOf = (judgements: readonly { readonly identityFields: readonly FindingFingerprintIdentityField[] }[]): Set<string> =>
      new Set(judgements.flatMap(({ identityFields }) =>
        identityFields.filter((field) => field.name === OCCLUSION_IDENTITY_FIELD_NAME).map((field) => field.value)));
    const extra = evidenceOfType(input, 'layout').flatMap((record) => {
      const before = record.payload.beforeNotificationDismissal?.layout ?? null;
      const primary = record.payload.primary.layout;
      if (before === null || before === undefined) {
        return [];
      }
      const afterOverlays = overlaysOf(primary === null ? [] : judgeFixedElementOcclusion(primary));
      return judgeFixedElementOcclusion(before, 'BEFORE_NOTIFICATION_DISMISSAL')
        .filter(({ identityFields }) => [...overlaysOf([{ identityFields }])].every((overlay) => !afterOverlays.has(overlay)))
        .map(({ message, identityFields }) => layoutDraft({
          ruleId: fixedElementOcclusionFacts.ruleId,
          severity: fixedElementOcclusionFacts.severity,
          message,
          evidenceId: record.evidenceId,
          identityFields,
        }));
    });
    return [...drafts, ...extra];
  },
};

// ---------------------------------------------------------------------------------------------------------------
// ZERO_SIZE_INTERACTIVE_ELEMENT
// ---------------------------------------------------------------------------------------------------------------

/**
 * 可視と判定された操作要素（リンク、ボタン、入力欄）の幅か高さが0のもの。
 * - 通常の流れの外の要素（`absolute`・`fixed`）は、見た目を置き換えたチェックボックスや、フォーカスまで隠すスキップリンクなど、
 *   意図して大きさを0にする手法と区別できないので除く。透明な要素と `aria-hidden` の要素も除く。
 * - 大きさのある描画された子孫を持つ要素（float の画像や absolute の子を包むリンク）は、実際に操作できるので除く（設計書 5.1.2）。
 */
const zeroSizeInteractiveElement = layoutFactRule('ZERO_SIZE_INTERACTIVE_ELEMENT', 'WARN',
  '押すための部品の大きさが、ほとんどありません。見えないか、押せないことがあります。',
  'PRIMARY', (layout) =>
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
 * DEF-204: 描く面がなく `pointer-events: none` の固定要素（中の子だけが見える入れ物。`isPassThroughContainer`）も、対象にしない（中の固定の子は数える）。
 */
const oversizedFixedElement = layoutFactRule('OVERSIZED_FIXED_ELEMENT', 'WARN',
  '画面に止まって動かない部品が大きすぎて、ページの中身が見える場所がせまくなっています。',
  'PRIMARY', (layout) =>
  // AUD-3c: 対象と区分は `classifiedOversizedFixedElementsOf` の 1 か所。Finding にするのは、区分が `FIXED_OVERLAP_FINDING_CLASSES` の要素（と区分のない前の版の要素）。
  classifiedOversizedFixedElementsOf(layout).flatMap((classified) => {
    const { element, ratio } = classified;
    if (!isFindingFixedOverlapClass(classified.overlapClass)) {
      return [];
    }
    return [{
      message: `固定要素 ${element.selector}（position: ${element.position}）が、ビューポートの面積の ${formatPercent(ratio)} を`
        // EV-2 の「押せません」の決まりは覆いの指摘だけ（大きすぎる固定要素の文は、今までどおり区分の文）。
        + `占めています（しきい値 ${formatPercent(OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO)}）。${fixedOverlapSentenceOf(oversizedFindingViewOf(classified), true)}`,
      identityFields: [{ name: 'selector', value: element.selector }],
    }];
  }));

// ---------------------------------------------------------------------------------------------------------------
// NOTIFICATION_NOT_DISMISSIBLE・NOTIFICATION_HANDLED_BEFORE_AUDIT（DEF-210）
// ---------------------------------------------------------------------------------------------------------------

/** 通知の枠の同一性の要素の名前（枠の識別の digest。値・URL・画面の path を持たない）。 */
const NOTIFICATION_FRAME_IDENTITY_FIELD_NAME = 'notificationFrame';

/** 閉じられない枠の理由ごとの文（設計書 3.4）。 */
const NOTIFICATION_NOT_DISMISSIBLE_MESSAGES: Readonly<Record<NotificationFrameHiddenReason, string>> = Object.freeze({
  NOT_DISMISSED: '通知の枠の閉じるボタンを押しましたが、枠が残りました。',
  CLOSE_BUTTON_DISABLED: '通知の枠の閉じるボタンが、押せない状態です。',
  NO_CLOSE_BUTTON: '画面の大きな部分を覆う通知の枠に、閉じるボタンがありません。',
});

/** 主の読み込みと幅の走査の、通知の枠の事実（主の読み込みが先。幅の順）。 */
const notificationOverlaysOf = (payload: EvidencePayloadByType['layout']): readonly NotificationOverlayEvidence[] => [
  ...(payload.notificationOverlay === undefined ? [] : [payload.notificationOverlay]),
  ...(payload.stressNotificationOverlays ?? []).map(({ overlay }) => overlay),
];

/**
 * DEF-210（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.4）: 閉じられない通知の枠（押しても残る、閉じるボタンが押せない、閉じるボタンがなく
 * 画面の大きな部分を覆う）。枠ごと（digest ごと）に 1 件。主の読み込みと幅の走査の同じ枠は、1 件にまとめる（先に見た理由の文にする）。
 */
const notificationNotDismissible = layoutRule('NOTIFICATION_NOT_DISMISSIBLE', 'WARN',
  'ページの通知の枠を閉じられません。画面の一部が、ずっと覆われたままになります。',
  (input, draft) => evidenceOfType(input, 'layout').flatMap((record) => {
    const reasons = new Map<string, NotificationFrameHiddenReason>();
    for (const overlay of notificationOverlaysOf(record.payload)) {
      for (const frame of overlay.frames) {
        if (frame.hiddenReason !== null && !reasons.has(frame.digest)) {
          reasons.set(frame.digest, frame.hiddenReason);
        }
      }
    }
    return [...reasons].map(([digest, reason]) => draft({
      message: `${NOTIFICATION_NOT_DISMISSIBLE_MESSAGES[reason]}点検のために、その枠を隠しました。`,
      evidenceId: record.evidenceId,
      identityFields: [{ name: NOTIFICATION_FRAME_IDENTITY_FIELD_NAME, value: digest }],
    }));
  }));

/**
 * DEF-210（設計書 3.6）: 通知の枠を閉じたか隠したビューポートの知らせ（INFO。ビューポートごとに 1 件）。文は `src/presentation/messages.ts` の
 * `NOTIFICATION_OVERLAY_TEXT`。
 */
const notificationHandledBeforeAudit = layoutRule('NOTIFICATION_HANDLED_BEFORE_AUDIT', 'INFO', NOTIFICATION_OVERLAY_TEXT.handledPlain,
  (input, draft) => evidenceOfType(input, 'layout').flatMap((record) => {
    const frames = notificationOverlaysOf(record.payload).flatMap((overlay) => overlay.frames);
    const dismissed = frames.some((frame) => frame.dismissed);
    const hidden = frames.some((frame) => frame.hidden);
    if (!dismissed && !hidden) {
      return [];
    }
    const message = dismissed && hidden
      ? NOTIFICATION_OVERLAY_TEXT.dismissedAndHidden
      : (dismissed ? NOTIFICATION_OVERLAY_TEXT.dismissed : NOTIFICATION_OVERLAY_TEXT.hidden);
    return [draft({ message, evidenceId: record.evidenceId, identityFields: [] })];
  }));

// ---------------------------------------------------------------------------------------------------------------
// DYNAMIC_LAYOUT_SHIFT
// ---------------------------------------------------------------------------------------------------------------

/**
 * CLS の attribution に、ユーザー入力のない layout shift で最も大きく動いた要素と、その shift の値が記録され、値がしきい値を超えるもの。
 * CLS は、直前にユーザー入力があった shift を含めないので、attribution の shift はユーザー入力のないものである。
 * CLS を観測できなかった場合と、要素が記録されていない場合は、Finding を作らない。
 */
const dynamicLayoutShift = layoutRule('DYNAMIC_LAYOUT_SHIFT', 'WARN',
  '何もしていないのに、表示の途中でページの部品が動きました。読んでいる場所を見失ったり、押しまちがえたりすることがあります。',
  (input, draft) =>
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
  overlapRule('ELEMENT_OVERLAP', '要素', 'ページの部品どうしが重なっています。見えにくいところや、押しにくいところがあります。'),
  textClipping,
  fixedElementOcclusion,
  zeroSizeInteractiveElement,
  overlapRule('CONTENT_COLLISION', '見出し・段落の要素', '見出しや文章どうしが重なっています。読みにくいところがあります。'),
  oversizedFixedElement,
  dynamicLayoutShift,
  notificationNotDismissible,
  notificationHandledBeforeAudit,
]);
