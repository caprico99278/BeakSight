# T12d 実装報告（1回目。要約。設計者が保存）

## 結論

Blocker で停止した。ファイルは変更していない。

## Blocker

Safety の Evidence の種類 `safety` がまだない。加えるには、許可されていない `src/core/ids.ts`（Evidence の ID の接頭辞の網羅的な表）と `tests/unit/schema-validator.test.ts`（Evidence の見本の網羅的な表）も変える必要がある。

## 実装者が示した、設計者に決めてほしい点

1. Evidence の中身の形。Ledger の snapshot のすべてを持つか、ページの事象の部分だけを持つか。
2. Interaction の凍結中に遮断したリクエストとナビゲーション（`INTERACTION_FROZEN`。GET を含む）を、どの Rule に対応させるか。
3. 件数の上限を超えた分の数え方。
4. Evidence をどの単位で作るか。あわせて、ビューポートの値をどうするか。

## 設計者の判断

- 選択肢 B を採る。前段のサブタスク T12d0 で、Evidence の型、ID、スキーマ、Ledger の型の別名、テストを整える。その後の T12d では、Rule だけを実装する。
- 上の1〜4は、Rule の設計書 5.4.1 に決めた（2026-09-24）。
- 発見事項も採り入れる。Evidence の種類を加えるときは、`ids.ts` と `schema-validator.test.ts` も変更の対象になる。これを、Task 14 の設計書にも書く。
