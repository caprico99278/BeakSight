# F06b 実装報告（要約。設計者が保存）

## 結論

一部完了（範囲外のテスト2件で Blocker）。

- 凍結の前に下準備を入れた。手順は、候補の探し直し、handle の解決、期限付きの `scrollIntoViewIfNeeded`、handle の破棄、ページが落ち着くのを待つこと、の順である。
- `isolated-interaction.test.ts` を2回続けて実行し、2回とも178件がすべて PASS した。
- 内側の要素がスクロールするページの何もしないボタンは、修正前は VERIFIED になった（RED）。修正後は NOT_VERIFIABLE になった。
- 内側の領域の画面外にあるアコーディオンは、VERIFIED になった。スクロールで起きた GET はサーバに届いた。
- `position: fixed` のボタンのテストは、修正前も PASS した。回帰テストとして残した。
- 下準備の途中の失敗、期限切れ、DOM の作業量の上限は、それぞれ区別できる理由で NOT_VERIFIABLE になる。

## Blocker と、設計者の判断

- `tests/integration/passive-request-guard.test.ts` の2件（`drains deferred download/popup cleanup failure ...`）が FAIL するようになった。偽の `elementHandle` に `scrollIntoViewIfNeeded` がないためである。
- → F06c で、偽の handle に1行を加えて直す。テストが確かめている意図は変えない。

## 実装者の判断と、設計者の判断

1. 落ち着くのを待つ描画を2回にした（`SCROLL_PREPARATION_SETTLE_FRAMES`）。IntersectionObserver による遅延読み込みの通信が、凍結の後に届かないようにするためである。→ 承認する。さらに遅れて始まる通信が遮断されることは、初めの読み込みの後に遅れて始まる通信と同じ限界として許容する。
2. 候補を一意に特定できない場合と、除外される見込みの場合は、スクロールしない。凍結の後に受け入れられた場合は、click せずに NOT_VERIFIABLE にする。→ 承認する。
3. ブラウザから不正な値を受け取った場合は、これまでどおり EXECUTION_FAILED にする。→ 承認する。
4. 既存のテスト27か所の偽の page を、テスト用の補助関数 `withScrollPreparation` で包んだ。expect は変えていない。→ 承認する。
