# RT12e 指示書: 横方向の見切れのしきい値を、固定の値にする

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12e
- 目的: RT12d の発見事項2を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2 の `TEXT_CLIPPING` の判定の方法
- 前の報告: 作業記録置き場の `RT12d-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- `tests/integration/layout-accessibility.test.ts`、`tests/component/layout-collector.test.ts`（必要な場合に限る）
- `fixtures/site/layout-text-clipping-lines.html` への追記

## 修正する内容

- `textLineClipOf` のしきい値を、縦と横で分ける。
  - 縦方向: いまのまま、行の高さの4分の1（`clippedTextLineMinOutsideRatio`）とする。
  - 横方向: 箱の外に出た量が 2 px を超えれば、「またぐ」とする。
    - 値は、名前を付けた定数（例: `clippedTextLineMaxIgnoredHorizontalOverflowPx`）として、`LAYOUT_THRESHOLDS` に置く。
- fixture とテストで、次のことを確かめる。
  - 幅 300px の `overflow:hidden` の箱に、1行 380px のテキスト（`white-space:nowrap`）を入れる。この場合は、`partiallyClippedText` が真になり、Finding ができる。修正前に RED、修正後に GREEN になること。
  - 横に隠れたスライドでは、引き続き Finding ができない。
  - 文字の張り出しが 2 px 以下の箱では、Finding ができない。
  - これまでの見切れの fixture の結果は、変わらない。

## 受け入れ条件

- 修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
