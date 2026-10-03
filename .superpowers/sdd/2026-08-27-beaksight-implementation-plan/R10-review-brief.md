# R10 指示書: F21 の確認のレビュー（Task 11 のチェックポイントの判定）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこには、厳守事項・背景・報告の形式が書かれています。末尾の「Interaction の検証についての判定基準」にも、必ず従ってください。

## 担当

確認のレビュー R9（`R9-review-result.md`）の Important-1 が、F21（`F21-report.md`）で解消したかを確かめてください。

あわせて、Task 11 の範囲（Interaction の検証と、その安全の性質）に、Important 以上の問題が残っていないかを確かめてください。このレビューの結果で、Task 11 のチェックポイントを通過できるかを判断します。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1〜4.4.4
- とくに、次の2つの項目を確かめてください。
  - 4.4.1 の「focus をしない要素と、focus による状態の変化」
  - R9 の Important-1 を受けて追加した内容

## とくに確かめること

1. **R9 の Important-1 の解消**
   - 次の2つを確かめてください。
     - 明示した tab で、すでに選ばれているものを押すと、NOT_VERIFIABLE になること。
     - 選ばれていないものを押すと、ARIA の状態で VERIFIED になること。
   - 実際の Chromium（`127.0.0.1` または `setContent`）でも確かめてください。
2. **副作用**
   - 明示した tab で、何かが起きるよく使われる形が、偽の NOT_VERIFIABLE になっていないこと。
     - 例: Radix、shadcn、Headless UI、MUI、Bootstrap の形のタブ（自動と手動）。
   - とくに、Bootstrap の形のタブを確かめてください。この形では、`role="tab"` と `aria-selected` と `aria-controls` を持ち、`.active` の class を切り替えます。
   - `role` を持たない部品の結果が変わっていないこと。
3. **偽の VERIFIED**
   - よく使われる部品の形で、偽の VERIFIED が残っていないこと。
4. **安全の性質**
   - 次のことが後退していないこと。
     - 凍結の順序
     - Guard
     - fail-closed
     - BLOCKED の優先
     - 下準備の作業量の差し引き
   - unhandledRejection がないこと。
5. **Evidence**
   - Evidence の型、スキーマ、実際の結果が一致していること。
6. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行してください。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/safety/interaction-policy.ts`
- 対応するテストと fixture（`fixtures/site/focus-activated-tabs.html` を含む）
