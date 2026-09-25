# RT12b 実装報告（要約。設計者が保存）

## 結論

完了した。I4・I5・M7・M8・M9 を直した。担当のテスト454件は PASS した。`npm run typecheck` のエラーは、並行して作業中の RT12a の `layout-rules.test.ts` だけから出ている。

## 主な変更

- `TARGET_NAVIGATION_FAILED` は、`navigationOutcome === 'FAILED'` の場合だけにした。
- canonical が自分自身かどうかは、`isCanonicalPage` で、`pageUrl` と正規化した最終URLの両方を比べる。
- `freezeCatalog(rules, registeredRules)` を総称型にした。`CROSS_PAGE_RULES` も、`RULE_CATALOG` と合わせて検査する。
- 下書きの version と category が、Rule の定義と一致するかを検査する。
- `finding.schema.json` の `evidenceRefs` に、`minItems: 1` を加えた。
- HTTP のステータスの範囲を、`rule-helpers.ts` にまとめた。まとめたものは、`*_HTTP_STATUS_RANGE` と `isHttpStatusInRange` である。
- I5 のテストは、実装を一時的に壊して、RED になることを確かめた。

## 発見事項と、設計者の判断

1. 共通部品台帳が古くなっている。→ 設計者が更新した。
2. `isLinkTargetVerified` は、理由のコード `NAVIGATION_FAILED` で判断している。→ P14a で直す。
   - `navigationOutcome` が null でないことを、「リンク先を検証した」の条件にする。
   - Task 14 からは、すべてのビューポートに `navigationOutcome` が記録される。このため、理由のコードより正確である。
3. `CANONICAL_TARGET_NOT_FOUND` では、自分自身かどうかを `pageUrl` だけで比べている。→ このままにする。実際の結果に違いが出ないためである。
4. テストで渡した Rule の一覧が検査に反すると、`evaluateCrossPageRules` が例外を投げる。→ 承認する。`RuleEngine` と同じ扱いである。
