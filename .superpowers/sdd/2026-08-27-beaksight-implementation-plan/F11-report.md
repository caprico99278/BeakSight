# F11 実装報告（要約。設計者が保存）

## 結論

完了した。

- scroll の観測の記録に、件数の上限を設けた。上限は500件で、最初の100件と最後の400件を残す。切り捨てた件数は `omittedObservationCount` に記録する。
- `ScrollIncompleteReason` を、`SCROLL_INCOMPLETE_REASONS`（`as const`）から導く形にした。スキーマの enum と一致することを、テストで確かめた。
- `npm run verify` の終了コードは0だった（39ファイル・1205件が PASS した）。

## 発見事項と、設計者の判断

1. 型の定義を1か所にまとめるため、`evidence-types.ts` に `SCROLL_INCOMPLETE_REASONS` を置いた。→ 承認する。
2. スクロールの対象を切り替えた回数を、Evidence に記録していない。→ F12 で加える。
3. スキーマの enum と、TypeScript の型の間で、値の一覧を手で写している箇所が20以上ある。一致を確かめるテストもない。→ F12 で、TypeScript の型を `as const` の配列から導く形にそろえ、スキーマの enum と一致することを1つのテストでまとめて確かめる（SSOT）。
4. 共通部品台帳への登録。→ 設計者が行う。
