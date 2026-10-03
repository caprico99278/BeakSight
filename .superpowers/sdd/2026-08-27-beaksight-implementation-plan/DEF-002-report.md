# DEF-002 実装報告（要約。設計者が保存）

## 結論

完了した。

- `createEvidenceId` に、継承したプロパティの名前（`'constructor'`、`'toString'`、`'__proto__'` など）を渡すと、`RangeError` になるようにした。判定には `Object.hasOwn` を使う。
- 同じ形の不具合が、`src/core/schema-validator.ts` の `validateArtifact` にもあった。
  - `'constructor'` を渡すと、検証を素通りして `{ ok: true }` を返していた。
  - 同じ方法で直した。表にないスキーマ名は、`RangeError` になる。
- テストは、全体の2119件が PASS した。

## 探した範囲と、設計者の判断

- `src/core/` と `src/safety/` の、ブラケット参照と `in` 演算子を調べた。
- `safety-ledger.ts` の表は、`Object.create(null)` で作られているので、問題ない。
- `interaction-policy.ts` の `interactionRejectionLedgerRecord` は、同じ形の書き方である。ただし、入力は閉じた集合から作られた値だけである。
  - 判断: DEF-003 として登録する。Task 14 のチェックポイントの後に、CC-017 と同じサブタスクで直す。
