# R9 指示書: F20・F20b の確認のレビュー（Task 11 のチェックポイントの判定）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこには、厳守事項・背景・報告の形式が書かれています。末尾の「Interaction の検証についての判定基準」にも、必ず従ってください。

## 担当

確認のレビュー R8（`R8-review-result.md`）の Important-1 と Important-2 が、F20・F20b（`F20-report.md`、`F20b-report.md`）で解消したかを確かめてください。

あわせて、Task 11 の範囲（Interaction の検証と、その安全の性質）に、Important 以上の問題が残っていないかを確かめてください。このレビューの結果で、Task 11 のチェックポイントを通過できるかを判断します。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1〜4.4.4
- とくに、R8 と F20 を受けて加えた、次の3つを確かめてください。
  - 名前の決まり
  - focus をしない要素と、focus による状態の変化
  - 長い class

## とくに確かめること

1. **R8 の指摘の解消**
   - R8 の Important-1（Headless UI v2、MUI）と Important-2（自動で切り替わるタブ）が解消していること。
   - 実際の Chromium（`127.0.0.1` または `setContent`）でも確かめてください。
2. **新しい決まりの副作用**
   - 名前の決まり（`focus` か `hover` を含む名前を根拠にしない）、tab に focus をしないこと、focus の前後の比較、class の fail-closed によって、何かが起きるよく使われる部品が、偽の NOT_VERIFIABLE に後退していないこと。
   - 例: アコーディオン、`<details>`、タブ（自動と手動）、トグル、スイッチ、`aria-pressed`、モーダル、メニュー、Tailwind や shadcn の長い class を持つボタン。
   - focus で開くのに、click でも開閉するコンボボックスやメニューの扱いが、妥当かを評価してください。
3. **偽の VERIFIED**
   - よく使われる部品の形で、偽の VERIFIED が残っていないこと。
   - とくに、`role="tab"` に focus をしないことで、focus で付く状態（class、属性、style）が、click の後の差に出ないかを確かめてください。
4. **安全の性質**
   - 次のことが後退していないこと。
     - 凍結の順序
     - Guard
     - fail-closed
     - BLOCKED の優先
     - 下準備の作業量の差し引き
   - unhandledRejection がないこと。
5. **Evidence の一致**
   - Evidence の型、スキーマ、実際の結果が一致していること。
6. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行してください。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/safety/interaction-policy.ts`
- `src/core/evidence-types.ts`
- `schemas/page.schema.json`
- 対応するテストと fixture。とくに次の2つ。
  - `fixtures/site/non-evidence-attribute-buttons.html`
  - `fixtures/site/focus-activated-tabs.html`
