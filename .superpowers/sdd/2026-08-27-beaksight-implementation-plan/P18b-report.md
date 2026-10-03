# P18b 実装報告（要約。設計者が保存）

## 結論

一部完了。担当のテスト（163件）と typecheck は PASS した。Ledger と違反の型を使う26ファイル（1414件）も PASS した。並行作業のため、verify は実行していない。

- CC-015: 完了した。
  - 違反の形を定義しているのは、core の `SafetyInvariantViolationSummary` だけになった。
  - Ledger の `InvariantViolationEvent` は、その別名になった。
- CC-028: 一部だけ完了した。
  - 事象の記録の分類の名前（`#pushEvent` と、その11か所の呼び出し）の型を、`SafetyLedgerRecordCategory = SafetyEventKind | 'invariantViolations'` に絞った。
  - 数えられなかった遮断の分類の名前（`#recordUncountedBlockedRequest`）と、`#reachedCategories` は、`string` のままである（下の判断1）。

## 実装者の判断と、設計者の判断

1. `#recordUncountedBlockedRequest` の分類の名前は、`'blockedRequestsByMethod'` と `` `blockedRequestsByMethod.${method}.counter` `` である。これらは、指定の一覧に入らない。
   - 既存のテストも、この値を固定している。
   - → **案(a)にする。P18e で行う。**
     - 閉じたテンプレートの型（例: `'blockedRequestsByMethod' | \`blockedRequestsByMethod.${string}.counter\``）を加える。
     - `#reachedCategories` の型を、`SafetyLedgerRecordCategory` とその型の和にする。
     - 値、JSON、既存のテストは、変わらない。
   - `evidence-types.ts` の `SafetyLedgerRecordLimits.reachedCategories` と、スキーマは、`string` のままにする。JSON の形を変えないためである。
2. CC-015 は、型の比較が構造だけで行われるため、型のテストでは RED を作れない。→ 承認する。
   - 代わりに、ソースの検査（違反の形の宣言が `core/contracts.ts` の1か所だけであること）で、RED と GREEN を確かめた。
   - 置き場所（`safety-ledger.test.ts`）も、承認する。
3. `SafetyLedgerRecordCategory` を export した。→ 承認する。テストから分類の型を確かめるためである。
