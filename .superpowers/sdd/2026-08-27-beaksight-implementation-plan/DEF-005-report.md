# DEF-005 実装報告（要約。設計者が保存）

## 結論

完了した。原因は、製品のコードではなかった。Chromium の振る舞いと、テストの後片付けのしかたが重なって起きていた。実装者の報告では、`npm run verify` は PASS した（71ファイル、2466件）。

## 原因と根拠

- 止まっていたのは、`closePassivePage` の中の `page.close()` だった。drain、Context を閉じる処理、サーバの close は、止まっていなかった。
- Chromium の通信の記録と、Guard を使わないスクリプトで、次のことを確かめた。
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に page を閉じると、Chromium は要求を捨て、page を閉じない。
  - これは、失敗の種類にも、Guard の有無にも関係しない。
  - `context.close()` なら、止まった page もすぐに閉じる。
- DEF-004 より前は、接続拒否で Context が無効になっていた。そのため、`page.close()` まで処理が進まず、この問題は表に出なかった。
- 製品のコードは、ナビゲーションごとに新しい page を開くので、この条件には当たらない（推論）。

## 修正

- `tests/integration/page-navigation.test.ts` の後片付けを、Context を閉じる形に直した。テストの条件は変えていない。
- 閉じる処理の所要時間を測るテストを、2件加えた。Page Auditor と同じ `closePassivePageAndContext` を使い、5秒以内に終わることを確かめる。
- ファイル全体を8回続けて実行し、8回とも PASS した。

## 発見事項と、設計者の判断

1. `page.close()` には期限がない。そのため、Chromium の上の条件に当たると、永久に止まる。対象は、`closePassiveGuardedPage` と、Page Auditor の閉じる処理である。
   - 判断: 潜在的な不具合 DEF-006 として登録する。
   - Task 14 の方針（止まり続ける経路を残さない）に従い、次のように直す。
     - page を閉じる処理に、期限を付ける。
     - 期限を過ぎた場合は、Context を閉じる処理に切り替える。
   - 実施の時期は、Task 16 の前の整理のサブタスクである。
2. `tests/helpers/passive-cleanup.ts` は、page を閉じてから Context を閉じる。
   - 判断: DEF-006 と同じサブタスクで、テストの補助も同じ形に直す。
