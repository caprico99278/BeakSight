# F19 実装報告（要約。設計者が保存）

## 結論

完了した。`npm run verify` は PASS した（41ファイル、1537件）。`isolated-interaction` を2回続けて実行し、2回とも357件が PASS した。

- 設計書 4.4.1 の10個の属性を、`INTERACTION_NON_EVIDENCE_ATTRIBUTES`（`src/evidence/interaction-collector.ts`）として1か所に定義した。これらの変化は、`attributes` の根拠にしない。
- Radix Tooltip、tippy.js、React Aria の3つの形の何もしないボタンは、NOT_VERIFIABLE になった。Radix のアコーディオンの形は、`changedAttributes: ['aria-expanded']` で VERIFIED になった。
- Minor-3 を直した。根拠になる属性が0件になった場合は、`changedAttributesTruncated` を false にする。
- 新しい fixture: `fixtures/site/non-evidence-attribute-buttons.html`。テストは18件を追加した。

## 実装者の判断と、設計者の判断

1. 根拠にしない属性は、`changedAttributes` に残さない。型の説明のとおり、`changedAttributes` は「根拠になった属性の名前」とする。型とスキーマは変えない。→ 承認する。根拠にしない変化を記録しなくても、判定の説明には足りる。
2. 定数の置き場所は、根拠の判定の owner である `interaction-collector.ts` とする。→ 承認する。共通部品台帳には、設計者が追記した。
