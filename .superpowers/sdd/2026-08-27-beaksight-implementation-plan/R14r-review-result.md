# R14r P14e の確認のレビューの結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 3）

## 前回の指摘の解消

| 指摘 | 状態 | 根拠 |
| --- | --- | --- |
| I1 | 解消 | 31通りのページで確かめた。止まり方を段階ごとに変えたページ、無限の rAF、大きな DOM、終わらない応答で、最も長くても期限の 2.18 倍で戻った。Context は残らず、unhandledRejection も出なかった |
| I2 | 一部解消 | `ContextConstructionError` の経路は直った。Guard が Context を閉じた場合の経路が、残っている |
| m1 | 解消 | |
| m2 | 一部解消 | 境界の値で、候補を1件も監査できない |
| m4 | 解消 | |

## 新しい指摘と、設計者の判断

- **Important-1: Guard の取り付けの失敗で Context が閉じられた場合に、その Ledger の違反が集計から漏れる**
  - 問題: factory は、ふつうの Error を投げる。また、Ledger との対応を消す。Passive、Interaction、幅の走査の3つの経路で再現した。
  - 判断: P14f で直す。
    - Context の構築に失敗した場合は、Context が閉じられたかどうかに関係なく、`ContextConstructionError` を投げる。このエラーは、Ledger を持つ。
    - factory は、Ledger との対応を消さない。
    - 3つの経路のどれでも、その Ledger を集計と Evidence に含める。
- **Minor-1: 設定の検証の境界の値では、候補を1件も監査できない**
  - 判断: P14f で直す。
    - 候補の発見は、Passive の page で行う。そのため、Passive の段階の期限の中で行う。
    - Interaction の段階の予算は、発見が終わった時点から数える。
    - これで、設定の検証を通った設定なら、1件目の候補が予算に収まる。
    - P14e の判断1（発見は Interaction の段階の期限で待つ）を改める。
- **Minor-2: 期限を受け取る collector の PARTIAL の Evidence が、ページの期限で捨てられる**
  - 判断: P14f で直す。
    - collector に渡す期限は、ページの期限から、少しの余裕を引いた時刻にする。
    - 余裕は、名前を付けた定数にする。
- **Minor-3: その他**
  - 判断: P14f で直す。
    - Interaction の Context の閉じる処理の、場面の名前を直す。
    - 注入する `now` は、`Date.now` と同じ基準でなければならない。`awaitBeforeDeadline` が `Date.now` を使うためである。この前提を、JSDoc と設計書に書く。

## 再実行の記録

- 関係する11ファイルで、445件が PASS した。
- 検証用のスクリプトで、I1 の35件が PASS した。I2 の漏れも再現した。
