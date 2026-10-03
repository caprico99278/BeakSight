# T13b 実装報告（要約。設計者が保存）

## 結論

完了した。担当のテスト61件と `npm run typecheck` は PASS した。設計者も、すべての並行作業が終わった後に `npm run typecheck` を実行し、PASS を確かめた。

- Cross-page rule として、次の2つを登録した。
  - `NAVIGATION_TIMEOUT`（ERROR、category は HTTP）
  - `UNEXPECTED_ORIGIN_REDIRECT`（WARN、category は HTTP）
- `evaluateCrossPageRules(input, rules = CROSS_PAGE_RULES)` は、Rule の例外を `toRuleEvaluationFailure` で封じ込める。
- `NAVIGATION_OUTCOME_KINDS` と `SitemapEvidence` を core に置いた。

## 実装者の判断と、設計者の判断

1. ナビゲーションの結果は、次のように持つ。→ 承認する。
   - 新しく持たせるのは、結果の種類（`navigationOutcome`）だけにする。要求したURLと最終URLは、`ViewportAuditResult` の既存の項目を使う。
   - スキップしたビューポートでは、`navigationOutcome` を null にする。
   - Task 14 で `ViewportAuditResult` とスキーマに加え、Cross-page rule の型は `ViewportAuditResult` の別名にする。これを、Task 14 の設計書 4.3.0 に書いた。
2. network の Evidence がないときは、Finding を作らない。→ 承認する。
   - ただし、Task 14 の Page Auditor は、ナビゲーションが失敗した場合も、network の Evidence を必ず記録する。これを Task 14 の設計書 4.3.0 に書き、統合テストで確かめる。
3. 失敗の並べ替えの比較を、その場で書いた。→ T12f で直す。`compareRuleEvaluationFailures` を export して使う。
4. 最終URLが許可Originの外のときは、`INCONSISTENT_ORIGIN` と `UNEXPECTED_ORIGIN_REDIRECT` の2つの Finding ができる。→ T12f で直す。
   - 最終URLの事実は、`UNEXPECTED_ORIGIN_REDIRECT` だけで扱う。
   - `INCONSISTENT_ORIGIN` は、canonical の Origin だけを扱う。
   - Rule の設計書 第7章を直した。
5. `NAVIGATION_TIMEOUT` の文言には、期限の値を書いていない。→ 受け入れる。
