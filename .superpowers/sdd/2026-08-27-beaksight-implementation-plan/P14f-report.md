# P14f 実装報告（要約。設計者が保存）

## 結論

完了した。R14r の Important-1 と Minor-1〜3 を直した。実装者の報告では、`npm run verify` は PASS した（58ファイル、2169件。build を含む）。

- `ContextConstructionError(context, ledger, cause)` の形にした。
  - 構築の失敗は、`#constructionFailure` の1か所でエラーにする。
  - Context が閉じられたかどうかに関係なく、このエラーを投げる。
  - factory は、失敗した Context と Ledger の対応を消さない。
- Passive、Interaction、幅の走査の3つの経路で、Guard の取り付けの失敗の違反が、集計されるようになった。これは、実際のブラウザの統合テストで確かめた。
- 候補の発見は、Passive の期限の中で行う。Interaction の予算は、発見が終わった時刻から数える。
  - 期限が見積もりとちょうど等しい設定でも、1件目の候補が監査される。
- `COLLECTOR_DEADLINE_MARGIN_MS = 500` を置いた。期限を受け取る collector には、ページの期限からこの値を引いた時刻を渡す。
- 場面の名前に、`interaction-context-close` を加えた。`now` の前提を、JSDoc に書いた。

## 実装者の判断と、設計者の判断

1. 余裕を 500ms とした。→ 承認する。
   - 期限の後に結果を返すまでの時間（タイマーの遅れと、結果の組み立て）は、数百 ms に収まる。500ms は、それを上回る。
   - 一方で、500ms は、既定のページの期限の 1% 未満である。
2. `createPassivePage` の準備の失敗も、`ContextConstructionError` にした。→ 承認する。3つの経路の扱いがそろう。

## 発見事項と、設計者の判断

1. 共通部品台帳と、設計書 4.5.5 の場面の一覧を、更新する必要がある。→ 設計者が更新した。
2. 「Guard の取り付けを失敗させる Browser の Proxy」が、4つのテストファイルに重複している。→ CC-019 として登録した。C14x で、`tests/helpers/` にまとめる。
3. テストファイルの改行が、一時的に CRLF になった。→ 設計者が確かめた。`git ls-files --eol` と CRLF の検索で、作業ツリーのファイルはすべて LF だった。
