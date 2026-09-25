# F11 指示書: scroll の Evidence の件数の上限と、理由の一覧の一致の確認

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F11
- 目的: F09 の報告の発見事項2と4を直す。
- 背景: 作業記録置き場の `F09-report.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/browser/controlled-scroll.ts`
- `src/core/evidence-types.ts`（scroll の Evidence の型に、切り捨ての件数の項目を加えるだけ）
- `schemas/page.schema.json`
- テスト: `tests/integration/controlled-scroll.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`

## 修正する内容

1. **観測の記録の件数の上限**
   - controlled scroll の結果の `observations` に、件数の上限を設ける。上限の値は controlled-scroll の中に定数として置き、設計書 5.8 の考え方（敵対的なページへの備え）に沿って決める。
   - 上限を超えた場合は、最初の観測と最後の観測を残す。そのうえで、切り捨てた件数を記録する（例: `omittedObservationCount`）。どの観測を残すかは、判定に必要な情報が失われない形にし、報告する。
   - 型とスキーマも直す。
   - 偽のページで、上限を超える観測が起きる場合をテストする。修正前に RED、修正後に GREEN になること。
2. **理由の一覧の一致**
   - スキーマの scroll の理由の enum と、`ScrollIncompleteReason` の一覧が一致することを確かめるテストを加える。
   - `ScrollIncompleteReason` が値の配列から導かれていない場合は、`as const` の配列から導く形にする。
   - 同じように手で写している一覧が、ほかの Evidence のスキーマにもあれば、一覧にして報告する（直すのは scroll だけでよい）。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。
