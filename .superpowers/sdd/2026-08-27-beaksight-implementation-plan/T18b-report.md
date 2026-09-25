# T18b 実装報告（要約。設計者が保存）

## 結論

完了した。GATE-S01〜S10 の35件が、すべて PASS した（3回実行して、約30秒）。

- 今のコードで FAIL した Gate は、ない。安全の不変条件が破られている形跡は、なかった。
- `src/` と `fixtures/` は、変えていない。
- 作ったファイル:
  - `tests/helpers/gate-harness.ts`
  - `tests/integration/safety-gates.test.ts`
- 数え方: 操作の直前に `openServerWindow(server)` で印を付け、その後の `getCounters()` と `getRequestObservations()` の差分を見る。Ledger の記録は、補助の確認として使う。
- どの Gate にも、対照の確認（Guard がなければ、同じ操作でリクエストが届く）を置いた。

## Gate ごとの要点

- S01・S02: Passive と Interaction の両方で、POST、PUT、PATCH、DELETE が届かない。
- S03: `mailto:` と `tel:` のリンクの click が行われない。そのページの GET だけが届く。
- S04: `/popup-target.html` への GET は、0件である。
- S05: `/__download` への GET は、0件である。
- S06: `/navigation-target.html` への GET は、0件である。
- S06（RP18 の指摘4）: 本物の Guard で、無効化が終わらない状態を作った。その後の POST の fetch、GET の fetch、移動は、どれも届かない。
- S07: `webSocketUpgrade` は、0である。
- S08: Passive と Interaction の両方で、Worker の取得と Worker の POST が、届かない。
- S09: 実際の CLI の Run で、書き出したすべてのファイルと、ZIP の中身に、秘密の値の3つが、どれも含まれない。
  - 対照: その値のヘッダ（`Cookie` など）が、実際に送受信されている。page.json では、`[REDACTED]` になっている。
- S10: Guard の取り付けの失敗では、Run Status は `ABORTED_BY_SAFETY`、終了コードは 3 になる。`newContext` の失敗では、`FAILED`、終了コードは 1 になる。
  - どちらも、Run Coordinator と CLI の両方で確かめた。
  - サーバへのリクエストは、GET も含めて0件だった。
- 終了コード 3 を最後まで通すことは、S10 の CLI のテストで確かめた。

## 実装者の判断と、設計者の判断

1. Interaction の段階で DELETE を送る fixture がないため、テストの側から初期化のスクリプトを加えて確かめた。→ **fixture を加える形に直す（T18e）。**
   - `fixtures/site/delete-request.html`（ボタンで DELETE を送る。`put-request.html` と同じ形）を加える。
   - S02 の Interaction の DELETE は、その fixture を使う形にする。ほかのメソッドと、確かめ方をそろえる。
2. Passive の段階は、factory の Guard の層で確かめた。Page Auditor は通さない。→ 承認する。Page Auditor も、同じ factory を使う。
3. RP18 の指摘4の状態の作り方
   - Browser の Proxy で、Context の `close` を止めた。
   - 凍結は、2つ目の page を開いて、本物の Guard の検査で失敗させた。
   - → 承認する。一度も凍結されていない状態で待つのをやめる、より厳しい場合である。
4. S03 は、click が行われないことで確かめる。独自のスキームの fixture はない。→ 承認する。独自のスキームは、Task 18 の後の整理で、fixture を加えるかを検討する。
5. S09 のリクエスト側の秘密の値は、`Cookie` で確かめた。→ 承認する。製品は `Authorization` を付けない。
6. S10 は、PREFLIGHT での Guard の初期化の失敗だけを確かめる。→ 承認する。途中の段階の失敗は、既存の page-auditor のテストが確かめている。
7. 届かないことを確かめる前に、300ms 待つ（期限の値ではない）。→ 承認する。待つ前に、試みが実際に起きたことを確かめているので、空振りしない。

## 発見事項と、設計者の判断

1. 不具合は、見つからなかった。
2. 補助の重複（振る舞いの違いはない）。→ CC-029 に加えた。
   - `preflight.test.ts` の `recordingLauncher` と、`newContext` を失敗させる Proxy
   - `isolated-interaction.test.ts:1001-1019` の `candidateNamed` と `input`
3. 共通部品台帳に、`gate-harness.ts` の行がない。→ 設計者が加えた。
