# R'2 型・collector の修正の確認のレビューの結果（2026-09-23）

総合判定: 修正が必要（Critical 0 / Important 3 / Minor 5）

## 前回の指摘の解消

- R3: M1、M3、M4、M5、M6、M7 は解消した。
- R4: N2、M1、M2、M3、V13 は解消した。Link の入口は1つになった。
- R4 の N1 は一部解消にとどまる。I-1 と I-3 の場合が残っている。

## 新しい指摘と、設計者の判断

- **I-1 / Important**（`controlled-scroll.ts:178-185, 589, 223-229`）
  - 指摘: スクロールの対象を最初の測定で固定している。そのため、後から body のほうがスクロールできる量が大きくなると、偽の COMPLETE になる。
  - 判断: F09 で直す。完了と判定する前に、候補を比べ直す。別の候補のほうが大きければ、1回だけ対象を切り替えてたどり直す。2回目も変わった場合は PARTIAL にする。
- **I-2 / Important**
  - 指摘: `ScrollResult` と `innerScrollScan` を入れる場所が、Evidence の型にもスキーマにもない。そのため、設計者が承認した「上限に達したことは Evidence に残す」という前提が満たされていない。
  - 判断: 設計者の設計の漏れである。F09 で、Evidence の種類として `scroll` を加える（型とスキーマ）。Task 14 の設計書 4.1 にも、スクロールの結果を Evidence として記録することを明記する。
- **I-3 / Important**（`controlled-scroll.ts:230`）
  - 指摘: 内側の領域を探す走査が、shadow root の中に入らない。
  - 判断: F09 で、open な shadow root も上限の範囲で走査する。全画面を占める同じ Origin の iframe は、制約として設計書 5.1 に明記する。
- **m1**: 文書をたどった後に走査が上限に達して COMPLETE になる場合のテストがない。→ F09 で加える。
- **m2**: `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` の説明が古い。→ F09 で直す。
- **m3**: Task 14〜17 の設計書が `LinkEvidence[]` のままになっている。また、DOM の Evidence が links の複製を持つ。
  - 判断: 設計書は設計者が直す。DOM の Evidence からは links を外し、Link の Evidence の1か所だけに置く（F09）。
- **m4**: shadow DOM の中の入力欄が記録されない。→ F09 で、open な shadow root の中の入力欄も、form に属さない入力欄として記録する。
- **m5**: 設定の検証で、正規化した後に2048文字を超える `startUrl` を受け入れてしまう。locale と timezone も、値が正しいかを確かめていない。→ F09 で直す。

## 再実行の記録

- 担当範囲の15ファイル・497件が PASS した。typecheck も PASS した。
- `setContent` で、15通りの場合を実際に確かめた。
