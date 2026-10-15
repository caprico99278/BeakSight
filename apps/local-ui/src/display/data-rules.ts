/**
 * シナリオの入力の規則の状態（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。ブラウザでも動く純粋な部品（値は持たず、型だけを
 * `src/control/data-rules-view.ts` から読む）。
 * - 規則の集まりを保存していない → 未設定。判定（`evaluateRuleSet` の結果。判定の owner は `src/control/data-rules/field-evaluation.ts`）で
 *   すべての欄が決まった → すべて決まった。ほか → 不足あり。判定はやり直さない（結果の `executable` を見るだけ）。
 * - 表示（ラベル、色、説明）は `src/presentation/catalog.ts` の `INPUT_RULE_STATE_CATALOG`。
 */
import type { RuleSetEvaluation } from '../../../../src/control/data-rules-view.js';

/** 入力の規則の状態（閉じた一覧）。 */
export const INPUT_RULE_STATES = Object.freeze(['NOT_SET', 'DECIDED', 'INSUFFICIENT'] as const);
export type InputRuleState = (typeof INPUT_RULE_STATES)[number];

/** 保存した規則の集まりがあるかと、判定の結果から、入力の規則の状態を選ぶ。 */
export const inputRuleStateOf = (saved: boolean, evaluation: Pick<RuleSetEvaluation, 'executable'>): InputRuleState => {
  if (!saved) {
    return 'NOT_SET';
  }
  return evaluation.executable ? 'DECIDED' : 'INSUFFICIENT';
};
