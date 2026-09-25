# R8 指示書: F19 の確認のレビュー（Task 11 のチェックポイントの判定）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこには、厳守事項・背景・報告の形式が書かれています。末尾の「Interaction の検証についての判定基準」にも、必ず従ってください。

## 担当

確認のレビュー R7（`R7-review-result.md`）の Important-1 と Minor-3 が、F19（`F19-report.md`）で解消したかを確かめてください。

あわせて、Task 11 の範囲（Interaction の検証と、その安全の性質）に、Important 以上の問題が残っていないかを確かめてください。このレビューの結果で、Task 11 のチェックポイントを通過できるかを判断します。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1〜4.4.4（R7 を受けて更新した「根拠にしない属性」と、4.4.4 の制約）

## とくに確かめること

1. **R7 の指摘の解消**
   - R7 の Important-1 と Minor-3 が解消していること。
   - 実際の Chromium（`127.0.0.1` または `setContent`）でも確かめてください。
2. **根拠を外した副作用**
   - 根拠にしない属性を外したことで、何かが起きるよく使われる部品が、偽の NOT_VERIFIABLE に後退していないこと。
     - 例: Radix、Headless UI、shadcn の形のアコーディオン、タブ、トグル、スイッチ、メニュー、ダイアログ。これらは `data-state` と、`aria-expanded`、`aria-selected`、`aria-checked`、`aria-pressed` などの ARIA の状態が一緒に変わる。
   - とくに、`data-state` だけが変わり、ARIA の状態が変わらない部品で、よく使われるものがないかを評価してください。
     - 例: Radix Collapsible の形の中身だけの切り替え。
     - 見つけた場合は、根拠がほかにあるか（`aria-controls` の先の表示の変化など）も含めて書いてください。
3. **偽の VERIFIED**
   - よく使われる部品の形で、偽の VERIFIED が残っていないこと。
4. **安全の性質**
   - 次のことが後退していないこと。
     - 凍結の順序
     - Guard
     - fail-closed
     - BLOCKED の優先
   - unhandledRejection がないこと。
5. **Evidence の一致**
   - Evidence の型、スキーマ、実際の結果が一致していること。
6. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行してください。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/core/evidence-types.ts`
- `src/core/limits.ts`
- `schemas/page.schema.json`
- 対応するテストと fixture（`fixtures/site/non-evidence-attribute-buttons.html` を含む）
