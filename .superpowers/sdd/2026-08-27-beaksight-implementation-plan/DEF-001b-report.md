# DEF-001b 実装報告（要約。設計者が保存）

## 結論

完了した。

- accessibility の Evidence の COMPLETE と PARTIAL の両方に、必須の項目 `frameScope: 'SAME_ORIGIN_ONLY'` を加えた。型・スキーマ・collector の3か所で、この項目をそろえた。
- `INTERACTION_HREF_KINDS` を core に置いた。型はこの定数から導き、interaction-policy はこの定数を使う。
- `npm run verify` の終了コードは0だった。39ファイル・1022件の検証が PASS し、build も成功した。

## 発見事項と、設計者の判断

- 共通部品台帳に、`INTERACTION_HREF_KINDS` と `frameScope` を登録する。→ 設計者が登録する。
