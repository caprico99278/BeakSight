# T12e 実装報告（要約。設計者が保存）

## 結論

完了した。次の5つの Rule が、`stressSweep` の幅ごとの結果も判定するようになった。担当のテスト36件は PASS した。

- `DOCUMENT_HORIZONTAL_OVERFLOW`
- `ELEMENT_OUTSIDE_VIEWPORT`
- `ELEMENT_OVERLAP`
- `CONTENT_COLLISION`
- `FIXED_ELEMENT_OCCLUSION`

`npm run typecheck` のエラーは、並行して作業中の T12d0 のテストファイルだけで起きた。

## 実装の要点

- 1つの layout を判定する処理を、`layoutFactRule` で包んだ。判定の処理は、主要な結果（`primary`）と幅ごとの結果で共通にした。
- 幅ごとの結果から作った下書きには、次の2つを付ける。
  - 同一性の要素 `stressWidth`
  - 文言の先頭の「レスポンシブの幅 N px の確認で、」
- `primary` の Finding の fingerprint は、変わっていない。
- 幅ごとの結果から作った Finding の `evidenceRefs` は、`primary` と同じ layout の Evidence を参照する。

## 実装者の判断と、設計者の判断

1. `primary` の layout がない場合は、主要なビューポートと同じ幅の結果も除かずに判定する。→ 承認する。この場合は `primary` の Finding ができないので、重複しない。
2. 幅の数値の書式には、`formatNumber` を使った。→ T12f で `src/presentation/format.ts` に移す（CC-013）。
