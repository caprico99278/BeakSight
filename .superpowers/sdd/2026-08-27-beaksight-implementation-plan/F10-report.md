# F10 実装報告（要約。設計者が保存）

## 結論

完了した。

- click の前後で、対象のスクロールする祖先（文書を含む）のスクロール位置を比べる。位置が変わっていた場合、または比べられない場合は、`boundingBox` の変化を VERIFIED の根拠にしない。
- レビューの (a) と (b) は、修正の前は VERIFIED だった（RED）。修正の後は NOT_VERIFIABLE になった（GREEN）。アコーディオンは、属性の変化によって VERIFIED になった。
- `isolated-interaction.test.ts` を2回続けて実行し、2回とも194件が PASS した。`passive-request-guard.test.ts` は120件が PASS した。
- Evidence の型、Guard、判定の順序は変えていない。

## 公開したもの

- `InteractionScrollRecord`: 保持した handle の検査の結果に含まれる。
- `compareInteractionScrollRecords`: 比べた結果として、`UNCHANGED`、`SCROLLED`、`UNCOMPARABLE` のいずれかを返す。
- `interactionGeometryChanged`: 位置の変化を判定する。

## 実装者の判断と、設計者の判断

1. 記録する祖先は、`overflow` が `visible` と `clip` 以外のものすべてとし、`hidden` も含めた。`scrollIntoView` は `hidden` の要素もスクロールさせるためである。→ 承認する。
2. スクロールの記録がない検査の結果は、拒否せずに、比べられないものとして扱う。→ 承認する。これは fail-closed の方向である。
3. 前後で祖先の並びが変わった場合は、比べられないものとして扱う。→ 承認する。
4. スクロールを検出した後も、期限まで観測を続ける。遅れて起きる属性の変化を、VERIFIED として拾うためである。→ 承認する。
5. 重複していた検査を1つにまとめた。→ 承認する。

## 発見事項と、設計者の判断

- 共通部品台帳に登録する。→ 設計者が登録する。
- 設計書 4.4 に、古い文が残っている。→ 設計者が直す。
