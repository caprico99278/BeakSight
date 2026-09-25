# F21 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` が PASS した（41ファイル、1602件）。`isolated-interaction` を2回続けて実行し、2回とも421件が PASS した。

- `InteractionChangeEvidenceOptions` に、`ariaStateAttributesOnly` を加えた。
- `isolated-auditor.ts` は、`hasExplicitTabRole(resolvedCandidate.role)` の結果を、この項目に渡す。判定は、下準備と同じ関数を使う。
- 明示した tab で、すでに選ばれているものを押すと、NOT_VERIFIABLE になる。対象は、Radix の自動と手動、`focused`、boxShadow の形。
- 選ばれていないタブを押すと、`changedAttributes: ['aria-selected']` で VERIFIED になる。

## 実装者の判断と、設計者の判断

1. 属性の変化のうち、ARIA の状態の属性（`INTERACTION_ARIA_STATE_ATTRIBUTES`）だけは根拠に残す。`aria-pressed` や `aria-checked` の変化は、属性の変化としてしか検出されないためである。→ 承認する。設計書 4.4.1 に書き加えた。
2. fixture のトリガーは、すべて `tabindex="-1"` から始める。Radix の実際の動きに合わせ、すでに選ばれているタブの RED を再現するためである。→ 承認する。
