# F06c 実装報告（要約。設計者が保存）

## 結論

完了した。`tests/integration/passive-request-guard.test.ts` の偽の `elementHandle` に、`scrollIntoViewIfNeeded` を1行加えた。

- 修正の前は、2件が FAIL した（RED）。修正の後は、120件がすべて PASS した。
- expect は変えていない。
- 後片付けの失敗のコードは、凍結の後にポップアップとダウンロードが起きた場合にだけ記録される。そのため、既存の expect が PASS したことで、テストの意図が保たれていることも確かめられた。

## 発見事項

使われていない偽の定義（`page.locator().nth().elementHandle()`）が残っている。影響はないので、そのままにする。
