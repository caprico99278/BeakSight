/**
 * シナリオの表示の状態（Task 28 の設計書 4.6 の一覧の「状態」。T28e）。ブラウザでも動く純粋な部品（値は持たず、型だけを
 * `src/control/approval-view.ts` から読む）。
 * - 保存した状態（`SCENARIO_STATES`）と、再承認の判定（`evaluateApprovalValidity` の結果。判定の owner は `src/control/approval/approval-validity.ts`）
 *   から、画面に出す状態を 1 つ選ぶ。判定はやり直さない（理由の一覧を見るだけ）。
 * - 選び方（この順）: 判定が有効 → 承認済み、撤回の理由 → 撤回済み、期限切れの理由 → 期限切れ、承認の記録がない → 下書き、ほか → 要再承認。
 *   画面は、状態と一緒に、再承認が要る理由の一覧（未承認の理由を除く）を示す。
 * - 表示（ラベル、色、説明）は `src/presentation/catalog.ts` の `SCENARIO_DISPLAY_STATE_CATALOG`。
 */
import type { ApprovalInvalidityReason, ApprovalValidity } from '../../../../src/control/approval-view.js';

/** 画面の表示の状態（閉じた一覧）。 */
export const SCENARIO_DISPLAY_STATES = Object.freeze(['DRAFT', 'APPROVED', 'NEEDS_REAPPROVAL', 'EXPIRED', 'REVOKED'] as const);
export type ScenarioDisplayState = (typeof SCENARIO_DISPLAY_STATES)[number];

/** 状態を決める理由（撤回、期限切れ、承認の記録がない）。 */
const REVOKED_REASON = 'REVOKED' satisfies ApprovalInvalidityReason;
const EXPIRED_REASON = 'EXPIRED' satisfies ApprovalInvalidityReason;
const NOT_APPROVED_REASON = 'NOT_APPROVED' satisfies ApprovalInvalidityReason;

/** 再承認の判定から、画面の表示の状態を選ぶ。 */
export const scenarioDisplayStateOf = (validity: ApprovalValidity): ScenarioDisplayState => {
  if (validity.approved) {
    return 'APPROVED';
  }
  if (validity.reasons.includes(REVOKED_REASON)) {
    return 'REVOKED';
  }
  if (validity.reasons.includes(EXPIRED_REASON)) {
    return 'EXPIRED';
  }
  return validity.reasons.includes(NOT_APPROVED_REASON) ? 'DRAFT' : 'NEEDS_REAPPROVAL';
};

/** 画面に示す、再承認が要る理由（未承認の理由は状態で示すので除く。判定の順のまま）。 */
export const shownInvalidityReasonsOf = (validity: ApprovalValidity): readonly ApprovalInvalidityReason[] =>
  (validity.approved ? [] : validity.reasons.filter((reason) => reason !== NOT_APPROVED_REASON));
