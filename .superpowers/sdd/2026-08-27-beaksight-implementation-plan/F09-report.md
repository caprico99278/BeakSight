# F09 実装報告（要約。設計者が保存）

## 結論

完了した。R'2 の I-1・I-2・I-3 と、m1〜m5 を直した。`npm run verify` の終了コードは0（39ファイル・1197件が PASS、build も成功）。

## 変更した Evidence の形

- 種類 `scroll`（`ScrollEvidence`。ID の接頭辞は `EV-SCROLL-`）を加えた。持つ項目は、状態、理由、観測の記録、`restoration`、`innerScrollScan`（`scanLimitReached` を含む）、`finalSnapshot`。
- 観測の記録に、`documentScrollRange` と `bodyScrollRange` を加えた。
- 理由のコードに、`SCROLL_TARGET_UNSTABLE` を加えた。
- `DomEvidence` から、`links` と `truncation.omittedLinkCount` を外した。`collectDomEvidence(page, pageId)` は、Link を受け取らない。
- `unassociatedFields` に、open な shadow root の中の入力欄を含めた。
- 設定の検証で、`startUrl` を `normalizeUrl` で確かめる。locale と timezone は、`Intl.DateTimeFormat` で確かめる。

## 発見事項と、設計者の判断

1. shadow root の中の form に属する入力欄も、`unassociatedFields` に記録した。→ 承認する。Rule から見えない入力欄をなくすためである。
2. scroll の Evidence の観測の記録は、期限で抑えているだけで、件数の上限がない。→ F11 で、件数の上限と、切り捨てた件数の記録を加える。
3. `omittedLinkCount` の不正な値のテストを、DOM の Evidence が Link を持たないことのテストに置き換えた。→ 承認する。
4. スキーマの scroll の理由の一覧を、手で写している。一致を確かめるテストがない。→ F11 で、一致を確かめるテストを加える。
5. 共通部品台帳と Task 14 の設計書の更新。→ 設計者が行う（Task 14 の設計書 4.1 は更新済み）。
