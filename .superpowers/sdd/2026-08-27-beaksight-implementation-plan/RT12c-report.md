# RT12c 実装報告（要約。設計者が保存）

## 結論

完了した。layout の Evidence の `document` に、`viewportHorizontalClip` を加えた。この値は、ビューポートに伝わる overflow を、CSS の仕様どおりに求めたものである。値が `CLIPPED` のときは、`DOCUMENT_HORIZONTAL_OVERFLOW` を作らない。幅ごとの結果にも、同じ決まりが当たる。`npm run verify` は PASS した（51ファイル、1927件）。

## 実装者の判断と、設計者の判断

1. 外枠の fixture は、そのままでは文書が横へスクロールしない。そこで、テストの中で `page.evaluate` を使って要素を加え、本当にスクロールする場合を作った。→ 承認する。既存の前例に沿っている。
2. 項目の名前は `viewportHorizontalClip` とする。→ 承認する。
3. 次の形では、誤検知が残りうる。→ 制約として受け入れ、設計書 5.1.2 に書いた。
   - html が `overflow-x:auto`
   - ビューポートに伝わらない body が `overflow-x:hidden`
