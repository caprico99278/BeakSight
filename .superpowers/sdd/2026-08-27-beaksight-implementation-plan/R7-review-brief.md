# R7 指示書: F18 の確認のレビュー（Task 11 のチェックポイントの判定）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこには、厳守事項・背景・報告の形式が書かれています。末尾の「Interaction の検証についての判定基準」にも従ってください。

## 担当

確認のレビュー R6（`R6-review-result.md`）の指摘が、F18（`F18-report.md`）で解消したかを確かめてください。

あわせて、Task 11 の範囲（Interaction の検証と、その安全の性質）に、Important 以上の問題が残っていないかを確かめてください。このレビューの結果で、Task 11 のチェックポイントを通過できるかを判断します。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.1〜4.8（とくに 4.4.1〜4.4.4）

## とくに確かめること

1. R6 の I-1・I-2・M-2・M-3・M-4 が解消していること。
   - 実際の Chromium（`127.0.0.1` または `setContent`）でも確かめてください。
2. よく使われる部品で、偽の VERIFIED がないこと。
   - 例: ripple、focus、hover の見た目の変化、遅延読み込み、覆われたボタン。
3. 何かが起きるよく使われる部品で、偽の NOT_VERIFIABLE への後退がないこと。
   - 例: アコーディオン、`<details>`、タブ、トグル、`aria-pressed`、モーダル。
4. 安全の性質が後退していないこと。
   - 凍結の順序、Guard、fail-closed、BLOCKED の優先、unhandledRejection がないこと。
5. Evidence の型、スキーマ、実際の結果が一致していること。
6. テストの安定性。
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行してください。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/core/evidence-types.ts`、`src/core/limits.ts`
- `schemas/page.schema.json`
- 対応するテストと fixture
