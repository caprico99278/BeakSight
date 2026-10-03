# F05 実装報告（要約。設計者が保存）

## 結論

完了した。

- 5つの型の定義を、`src/core/evidence-types.ts` の1か所だけにした。元の owner のファイルは、その型の別名だけを持つ。
- `RunStatusInput.incompleteReasons` を、`readonly IncompleteReason[]` にした。

## 検証

- 修正前に、型の定義が1か所であることを確かめるテストが RED になることを確かめた。構造化した入力の型検査も、修正前は RED になった。修正後は GREEN になった。
- `npm run typecheck` が PASS した。
- unit と component のテスト（28ファイル・643件）と、integration のテスト（11ファイル・364件）が PASS した。
- `src/` を走査して、型の定義が1か所であることを確かめるテストを加えた。

## 発見事項と、設計者の判断

1. `deriveRunStatus()` で、要素の形の検査を外した。→ 承認する。要素が1件以上あれば PARTIAL になるので、検査を外しても結果は変わらない。
2. Interaction の href の種類の値の一覧が、`interaction-policy.ts:109` にもう一度書かれている。→ DEF-001b で、core に `INTERACTION_HREF_KINDS` を置き、型をそこから導く形にまとめる。
3. 共通部品台帳の記述が古い。→ 設計者が直す。
