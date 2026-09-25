# F20b 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` が PASS した（41ファイル、1587件）。`isolated-interaction` を2回続けて実行し、2回とも406件が PASS した。

## 主な変更

- Blocker を解消した。`passive-request-guard.test.ts` の偽の handle 2か所が、属性の記録を返すようにした。期待値は変えていない。
- `INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength = 4_096` を加えた。class だけは、この上限まで記録する。
- class を名前ごとに比べられない場合は、class の変化を根拠にしない（fail-closed）。
- `CLASS_ATTRIBUTE_NAME` を、`interaction-collector.ts` の1か所に定義した。

## 実装者の判断と、設計者の判断

1. 既存のテスト3か所を、新しい仕様（class 専用の上限と fail-closed）に合わせて直した。条件は弱めておらず、記録の検証のテストは3件増えた。→ 承認する。
2. 上限の選び方は、Node 側とブラウザの中の2か所にある。ブラウザの中の関数は、Node 側の関数を呼べないためである。class の名前だけは、引数で同じ定数を渡している。→ 承認する。実行環境が違うため、共通化の対象外とする（スキル 6.1）。
3. `discover-candidates.ts` から `interaction-collector.ts` への import が加わった。循環はない。→ 承認する。
4. `isolated-interaction.test.ts` のほかの偽の handle は、変えていない。記録がない場合の動きを確かめるテストもあるためである。→ 承認する。
5. 共通部品台帳は、設計者が更新した。
