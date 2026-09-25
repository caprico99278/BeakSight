# R6 指示書: F16・F17・F17b の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

直前の確認のレビュー R5（`R5-review-result.md`）の指摘 N-1〜N-6 が、F16・F17・F17b で解消したかを確かめてください。

- 修正の報告: `F16-report.md`、`F17-report.md`、`F17b-report.md`
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（4.4.1〜4.4.4）

あわせて、これらの修正で新しい問題が入っていないかも確かめてください。

## とくに確かめること

1. **偽の VERIFIED がないこと**
   - R5 の再現条件のページ（タイマー、rAF、hover intent、transition の終わり、focus で付く class、ripple）で、何もしないボタンが VERIFIED にならないこと。
   - 次のページでも、VERIFIED にならないこと。
     - 遅れて位置や大きさが変わるページ
     - 覆われたボタン
     - 内側の領域のボタン
   - これらを、`127.0.0.1` か `setContent` で、テストとは別に実際に確かめてください。
2. **偽の NOT_VERIFIABLE が多すぎないこと**
   - 次の部品で、VERIFIED になること。
     - `<details>`
     - アコーディオン
     - タブ
     - class のトグル
     - `aria-pressed`
     - hover で文字が変わるボタン
     - `aria-controls` のあるモーダル
     - 大きさが変わるボタン
   - 安定性の確認と持続の確認の時間（500ms）が、実際によく使われる部品の動きに対して適切かを評価してください。
3. **安全の性質**
   - 次のことが変わっていないことを確かめる。
     - 下準備（同じ要素かの確認、スクロール、hover、focus、安定性の確認、handle の破棄）の後に凍結する順序
     - 凍結の後の受け入れの判定、BLOCKED の優先、Guard、fail-closed
   - unhandledRejection がないこと。
4. **Evidence**
   - `changedAttributes` と `changedAttributesTruncated`、`detailsOpen` が、型・スキーマ・実際の結果で一致していること。
5. **設定**
   - `interactionTimeoutMs` の下限が、設定の検証とスキーマで一致すること。
   - 時間の定数が `src/core/limits.ts` の1か所だけにあり、層の向きが正しいこと。
6. **理由の整形**
   - すべての経路で、理由の文字列に制御文字や断片が残らないこと。
7. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行する。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/core/limits.ts`、`src/core/evidence-types.ts`
- `src/config/validate-config.ts`
- `schemas/page.schema.json`、`schemas/run.schema.json`
- 対応するテストと fixture
