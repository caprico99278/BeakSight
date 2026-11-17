/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: フォーカスまで隠す要素（画面の外に置いた、フォーカスできる要素）の
 * 判定の唯一の所。Rule（`FOCUSED_CONTROL_HIDDEN`）と表示用モデル（数）が使う。純粋な関数だけ。
 * - 判定の順: フォーカスが当たらない → `NOT_FOCUSED`（指摘にしない。キーボードで移れない要素は、この確かめの外）。フォーカスの後の矩形がない・ビューポートと
 *   交わらない → `OUTSIDE_VIEWPORT`。描かれて見えない → `NOT_VISIBLE`。ほかの要素が押下を受ける → `NOT_HITTABLE`。どれでもない → `APPEARS`（指摘にしない）。
 * - 隠したままの区分（`OUTSIDE_VIEWPORT`・`NOT_VISIBLE`・`NOT_HITTABLE`）だけを指摘にする。
 */
import type { FocusCheckItemEvidence } from '../core/evidence-types.js';

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
  item: FocusCheckItemEvidence,
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
