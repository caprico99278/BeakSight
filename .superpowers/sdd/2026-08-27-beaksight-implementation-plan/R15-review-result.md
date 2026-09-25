# R15 Task 15 のチェックポイントの独立レビューの結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 2 / Minor 6）

## 仕様どおりと確かめられた点

- クロールの振る舞い:
  - BFS の順、深さ、重複の排除
  - `INTERNAL_NAVIGABLE` だけをたどる
  - 上限の確認を、ページごとに行う
  - 再試行の対象を1つの定数で決め、再試行は1回だけ
- Run Status:
  - 50/50 のページを監査したら `COMPLETE`、49/50 なら `PARTIAL` になる
  - Run Status は、`deriveRunStatus` だけが決める
  - 設計書 5.6.6 の表の入力
- 安全:
  - PREFLIGHT が失敗した場合は、サイトにアクセスしない
  - sitemap にだけある URL を巡回しない
  - metadata の取得は、GET だけで行う
- run・pages・findings が、それぞれのスキーマに合う

## 指摘と、設計者の判断

- **I1: Ledger の集計と Run Status の入力の誤りを、テストが検出できない**
  - 問題: 6か所を壊しても、テストがすべて PASS した。
  - 判断: R15e で、検出できるテストを加える。
- **I2: Page Auditor が例外を投げると、その試行の違反が集計から消える**
  - 判断: R15e で直す。
    - Coordinator は、`createSafetyLedger` を包み、Run の間に作ったすべての Ledger を1か所に登録する。
    - `RunSafetySummary` の違反・記録の切り詰め・遮断の件数は、この登録からだけ集計する。これで、集計の出どころを1つにする。
    - ページの `safety` の Evidence は、Rule のためのものとして、そのまま残す。
    - 設計書 5.6.5 を直した。
- **Minor-1: `site-metadata.ts` の page の閉じる処理に、期限がない**
  - 判断: C15x（DEF-006）の範囲に加える。
- **Minor-2: `browser.close()` と、`environment.ts` の `page.evaluate` に、期限がない**
  - 判断: C15x の範囲に加える。
- **Minor-3: PREFLIGHT の Guard の失敗が `FAILED` になる**
  - 上位の設計書 9.5 は、Safety Guard の初期化の失敗を、`ABORTED_BY_SAFETY` の条件としている。
  - 判断: R15e で直す。
    - `deriveRunStatus` で、違反の判定を、PREFLIGHT の失敗の判定より先に行う。
    - PREFLIGHT の Guard の失敗で違反が記録された場合は、`ABORTED_BY_SAFETY` になる。
    - 違反のない PREFLIGHT の失敗は、`FAILED` のままとする。
    - 設計書 5.6.7 を直した。
- **Minor-4: 最後のページで実行時間の上限を超えた場合に、記録されない**
  - 判断: R15e で直す。
    - 事実として、`crawlLimits.maxRuntimeReached` を真にする。
    - 監査していない URL はないので、Run の理由は付けない。そのため、`PARTIAL` にはしない。
    - 設計書 5.6.3 を直した。
- **Minor-5: 重複の排除が、Crawl Frontier と Crawl Queue の2か所にある**
  - 判断: 受け入れる。
    - SKIPPED を含む URL の状態の管理は、Coordinator（Frontier）の責務である（設計書 5.6.3）。
    - Queue の排除は、二重の防御として残す。
    - 設計書 5.6.3 に書いた。
- **Minor-6: 再試行の前の試行の Evidence を捨てている**
  - 上位の設計書 10.1 の「最初の失敗 Evidence は保持する」に反している。
  - 判断: R15e で直す。
    - 最初の試行の Evidence を、最終のページの `evidence` に残す。
    - `RunRetryRecord` に `evidenceIds` を加え、どの Evidence が最初の試行のものかを参照できるようにする。
    - 最初の試行の Finding は、残さない。Rule は、最終の試行の Evidence で評価するためである。
    - 設計書 5.6.4 を直した。

## その他

- レビュー担当が、一時ディレクトリにリポジトリの `node_modules` へのジャンクションを作っていた。
  - 設計者が、ジャンクションだけを外してから、コピーを削除した。リポジトリの `node_modules` が無事であることも確かめた（54項目のまま）。
  - 同じことが起きないよう、共通ルールに「一時ディレクトリにリポジトリへのリンクを作らない」を加えた。
