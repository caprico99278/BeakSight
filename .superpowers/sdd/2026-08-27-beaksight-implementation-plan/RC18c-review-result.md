# RC18c レビュー結果（要約。設計者が保存）

## 総合判定

承認。Critical 0件、Important 0件、Minor 3件。DEF-012 への対応を、完了とする。

## RC18b の指摘の判定

- N1（OOPIF）: 解消。
  - `--site-per-process` の headless（22通り）と、`channel: 'chromium'`（完全版の Chromium の headless。20通り）で確かめた。
  - どの場合も、外部スキームへのリダイレクトが止まり、記録され、違反は0件だった。
    - OOPIF の自分での移動
    - 構文解析の途中の `location.replace`
    - meta refresh
    - 別のサイトを経由する場合
    - 入れ子の2段と3段
  - 子の `Fetch.enable` を1.5秒遅らせても、見逃しはなかった（時間の窓がないことの確認）。
- N2（幅の走査の理由）: 解消。

## 問題がなかった点

- OOPIF が閉じたときに、session と登録が消える。延べ80件の付与と外しでも、違反は出ない。
- 付けるのは iframe だけである。dedicated worker は止まらず、Service Worker は登録されない。
- page の session の判定は、変わっていない。
- OOPIF の中の既存の判定（POST、PUT、DELETE、form、外への移動、`window.open`、凍結の後）は、働く。
- DEF-013（遅いリダイレクト）は、OOPIF の中でも、偽の違反にならない。

## Minor と、設計者の判断

1. M1: 設計書 4.2.1 の OOPIF の制約の記述と、DEF-012 の記述が古い。→ 設計者が直した。
2. M2: GATE-S03 の入れ子の場合が、中の frame が OOPIF であることを確かめていない。Gate に、OOPIF の Interaction の段階の確認もない。→ C18d で加える。
3. M3: fail-closed の分岐のうち3つ（iframe でない target、`waitingForDebugger` が偽、`OOPIF_GUARD_PROTOCOL_FAILED`）が、テストされていない。→ C18d で、注入によるテストを加える。
4. 参考: OOPIF の処理中に frame が消えた場合の偽の違反（DEF-014 の3）は、`channel.closed` を手がかりに、予期した失敗として扱えるかもしれない（推測）。→ DEF-014 に書き足した。

## 確認できなかった点

- 本物の headed での動き（禁止のため）
- fenced frame と、先読み（speculation rules）の page が、横取りの対象になるか → DEF-012 の残る制約に書いた。
