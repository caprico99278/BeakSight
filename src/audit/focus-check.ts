/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: フォーカスまで隠す要素（画面の外に置いた、フォーカスできる要素）の
 * 判定の唯一の所。Rule（`FOCUSED_CONTROL_HIDDEN`）と表示用モデル（数）が使う。純粋な関数だけ。
 * - 判定の順: フォーカスが当たらない → `NOT_FOCUSED`（指摘にしない。キーボードで移れない要素は、この確かめの外）。フォーカスの後の矩形がない・ビューポートと
 *   交わらない → `OUTSIDE_VIEWPORT`。描かれて見えない → `NOT_VISIBLE`。ほかの要素が押下を受ける → `NOT_HITTABLE`。どれでもない → `APPEARS`（指摘にしない）。
 * - 隠したままの区分（`OUTSIDE_VIEWPORT`・`NOT_VISIBLE`・`NOT_HITTABLE`）だけを指摘にする。
 * - AUD-3: 通常の Tab の確かめの結果と、確信度を下げる項目（循環の守りの部品・Tab で届いて見える項目）の決まりも、ここに置く（指摘と項目の結びは `src/core/focus-check-items.ts`）。
 */
import type { FocusCheckItemEvidence, FocusCheckItemKind } from '../core/evidence-types.js';

/** フォーカスまで隠す要素の Rule の ID（Rule `./focus-rules.ts` と、表示用モデルが指摘を見分けるのに使う）。 */
export const FOCUSED_CONTROL_HIDDEN_RULE_ID = 'FOCUSED_CONTROL_HIDDEN';

/**
 * AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 5）: 通常の Tab の確かめの結果の閉じた一覧。`SHOWN` は届いて見えた（直の
 * focus の判定の `APPEARS` と同じ読み）、`HIDDEN` は届いたが隠れたまま、`NOT_REACHED` は届かなかった。
 */
export const SEQUENTIAL_TAB_OUTCOMES = Object.freeze(['SHOWN', 'HIDDEN', 'NOT_REACHED'] as const);
export type SequentialTabOutcome = (typeof SEQUENTIAL_TAB_OUTCOMES)[number];

/** AUD-3: 1 つの項目の、通常の Tab の確かめの結果（確かめなかった項目は `null`）。 */
export function sequentialTabOutcomeOf(
  item: FocusCheckItemEvidence,
  viewport: { readonly width: number; readonly height: number },
): SequentialTabOutcome | null {
  const tab = item.sequentialTab;
  if (tab === undefined) {
    return null;
  }
  if (!tab.reached) {
    return 'NOT_REACHED';
  }
  return focusCheckOutcomeOf({ ...tab, focused: true }, viewport) === 'APPEARS' ? 'SHOWN' : 'HIDDEN';
}

/** AUD-3（6.2 の 2・5）: 指摘の項目（`focusCheckItemOfFinding` で引く）の文脈（表示用モデルの検証の欄。前の版の記録の種別・確かめなかった Tab は `null`）。 */
export interface FocusCheckFindingView {
  readonly kind: FocusCheckItemKind | null;
  readonly sequentialTab: SequentialTabOutcome | null;
}

/** AUD-3: 指摘の項目の文脈を作る。 */
export const focusCheckFindingViewOf = (
  item: FocusCheckItemEvidence,
  viewport: { readonly width: number; readonly height: number },
): FocusCheckFindingView => ({ kind: item.kind ?? null, sequentialTab: sequentialTabOutcomeOf(item, viewport) });

/**
 * AUD-3（6.2 の 2・5）: 候補群の確信度を 1 段下げる項目か（循環の守りの部品か、通常の Tab で届いて見える項目）。重さは変えない。Tab で届かない項目は下げない
 * （文に事実を足す）。RVP-1（設計書 `2026-11-24-beaksight-review-pending-evidence-design.md` 2.2）: 通常の Tab の確かめがない項目（走らなかった・途中で止まった・
 * 幅の走査の幅）も下げる（直の focus だけの事実なので）。
 */
export const focusCheckLowersConfidence = (view: FocusCheckFindingView): boolean =>
  view.kind === 'GUARD' || view.sequentialTab === 'SHOWN' || view.sequentialTab === null;

/**
 * RVP-1（2.2）: 前面の窓の背後の項目の扱い。直の focus で押せず、開いた前面の窓が覆っていた（`frontWindowCovered`）項目は、前面の窓が背後を覆うのは作りどおりなので
 * 指摘にしない（`EXCLUDED`。数は記録に残る）。ただし、通常の Tab の確かめで、前面の窓を開いたまま背後のこの要素へ移ったときだけ指摘にする（`TAB_BEHIND`）。
 * 前面の窓が覆っていない項目は `NOT_COVERED`（今の判定のまま）。
 */
export type FrontWindowFocusDisposition = 'NOT_COVERED' | 'TAB_BEHIND' | 'EXCLUDED';

export function frontWindowFocusDispositionOf(
  item: FocusCheckItemEvidence,
  viewport: { readonly width: number; readonly height: number },
): FrontWindowFocusDisposition {
  if (item.frontWindowCovered !== true || focusCheckOutcomeOf(item, viewport) !== 'NOT_HITTABLE') {
    return 'NOT_COVERED';
  }
  return item.sequentialTab?.reached === true && item.sequentialTab.behindFrontWindow === true ? 'TAB_BEHIND' : 'EXCLUDED';
}

/** フォーカスの確かめの結果の閉じた一覧（数の並びの順）。 */
export const FOCUS_CHECK_OUTCOMES = Object.freeze(['APPEARS', 'OUTSIDE_VIEWPORT', 'NOT_VISIBLE', 'NOT_HITTABLE', 'NOT_FOCUSED'] as const);
export type FocusCheckOutcome = (typeof FOCUS_CHECK_OUTCOMES)[number];

/** 指摘にする結果（フォーカスしても隠れたまま）。 */
export const FOCUS_CHECK_HIDDEN_OUTCOMES = Object.freeze(['OUTSIDE_VIEWPORT', 'NOT_VISIBLE', 'NOT_HITTABLE'] as const satisfies readonly FocusCheckOutcome[]);
export type HiddenFocusCheckOutcome = (typeof FOCUS_CHECK_HIDDEN_OUTCOMES)[number];

/** 指摘にする結果か。 */
export const isHiddenFocusCheckOutcome = (outcome: FocusCheckOutcome): outcome is HiddenFocusCheckOutcome =>
  (FOCUS_CHECK_HIDDEN_OUTCOMES as readonly FocusCheckOutcome[]).includes(outcome);

/** 1 つの要素のフォーカスの確かめの結果。 */
export function focusCheckOutcomeOf(
  item: Pick<FocusCheckItemEvidence, 'focused' | 'afterRect' | 'visibleAfterFocus' | 'hitAfterFocus'>,
  viewport: { readonly width: number; readonly height: number },
): FocusCheckOutcome {
  if (!item.focused) {
    return 'NOT_FOCUSED';
  }
  const box = item.afterRect;
  const inViewport = box !== null
    && Math.min(box.right, viewport.width) - Math.max(box.left, 0) > 0
    && Math.min(box.bottom, viewport.height) - Math.max(box.top, 0) > 0;
  if (!inViewport) {
    return 'OUTSIDE_VIEWPORT';
  }
  if (!item.visibleAfterFocus) {
    return 'NOT_VISIBLE';
  }
  return item.hitAfterFocus ? 'APPEARS' : 'NOT_HITTABLE';
}
