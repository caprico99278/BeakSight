# C18f 実装報告（要約。設計者が保存）

## 結論

完了した。違反を検出した後は、次のものを始めない。

- 新しいページ
- 同じページの次のビューポート
- 幅の走査の次の幅
- Interaction の次の候補
- 再試行
- robots.txt と sitemap の取得

RC18a の再現のサイトで、違反は6件から1件になった。2つ目以降のページには、GET を1回も送っていない。

- 違反の検出: Run Coordinator の `#safetyViolationRecorded`（`run-coordinator.ts:560`）が、Ledger の登録を調べる。
  - ページを始める前は、登録のすべての Ledger を調べる。
  - ページの中は、そのページで作った Ledger だけを調べる。
- 止める場所:
  - 新しいページ: `run-coordinator.ts:501-502`
  - 再試行: `:602`
  - metadata: `:476-477`
  - 次のビューポート: `page-auditor.ts:319`
  - 幅: `:576-579`
  - 候補: `:712`
- 新しい理由のコード: `SAFETY_VIOLATION_ABORT`（contracts、run のスキーマ、`messages.ts`）
- 始めなかったものの記録:
  - ページ: `skippedPageResult` で、`SKIPPED`、理由 `SAFETY_VIOLATION_ABORT`
  - ビューポート: `SKIPPED`、同じ理由
  - 幅の走査の幅: `COLLECTOR_INCOMPLETE` / `stress-layout:SAFETY_VIOLATION_ABORT`
  - Interaction の候補: `COLLECTOR_INCOMPLETE` / `interaction:SAFETY_VIOLATION_ABORT:remaining=<件数>`
  - metadata: Evidence は作らず、Run の理由に `{code:'SAFETY_VIOLATION_ABORT', detail:'site-metadata'}` を加える。
  - Run の理由に、`{code:'SAFETY_VIOLATION_ABORT', detail:null}` を1件加える。
- `safetyViolationRecorded` は、Page Auditor の必須の依存である。渡し忘れは、型のエラーと、実行時の `TypeError` になる。
- Run Status を決めるのは、`deriveRunStatus` だけのままである。
- 後始末と書き出しは、今までどおり行う。

## 実装者の判断と、設計者の判断

1. 違反の検出は、Ledger の登録を調べる方法にした。→ 承認する。
   - 通知の仕組みを加えるには、`SafetyLedger` を変える必要がある。
   - 登録を調べれば、Run の Safety の集計と同じ値を使える。
2. ページの中では、そのページの Ledger だけを調べる。→ 承認する。snapshot の回数を抑えるためである。
3. 既存の `SAFETY_INVARIANT_VIOLATION` ではなく、新しいコードにした。→ 承認する。そのページ自体の違反と区別するためである。
4. 幅の走査の次の幅も止めた。次の幅で止めると、すでに終えた幅の layout の結果は残らない（Ledger は残る）。→ 承認する。
5. 再試行、必須の依存、metadata の3点。→ 設計者の判断のとおり、実装した。
   - 既存のテスト `run-coordinator.test.ts:985` の期待値と名前の変更は、承認済みである。
   - 最初の試行の違反を数えるという、このテストの意図は残っている。

## 発見事項と、設計者の判断

1. Desktop の後には違反がなく、Mobile の途中で違反が起きた場合（Desktop のナビゲーションが、再試行の対象の失敗であることも条件）。
   - このとき、Mobile のスクリーンショットは `retry-1/` に置かれたまま、再試行はしない。
   - → 受け入れる。表示は Evidence の ID で結び付けるので、崩れない。ファイルの置き場所の名前だけが、実際と合わない。
2. 結合のテストで、15件が失敗した。→ 並行で作業中だった C18g の途中の状態によるもの。設計者の verify で確かめる。
3. 共通部品台帳の更新。→ 設計者が行った。
