# T13b 指示書: NAVIGATION_TIMEOUT と UNEXPECTED_ORIGIN_REDIRECT を Cross-page rule に加える

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T13b
- 目的: page rule から移した2つの Rule を、Cross-page rule として実装する。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` 第7章（2026-09-24 に追加した入力の説明）
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` 4.3.0
- 前の報告: 作業記録置き場の `T12b-report.md`、`T13-report.md`

T13 の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`（ナビゲーションの結果の種類の一覧 `NAVIGATION_OUTCOME_KINDS` と、その型を加えることに限る）
- `src/audit/cross-page-rules.ts`、`tests/component/cross-page-rules.test.ts`
- `src/audit/rule-engine.ts`（例外を失敗に変える関数を export することに限る）、`tests/component/rule-engine.test.ts`
- `src/core/evidence-types.ts` への `SitemapEvidence` の型の追加
- `tests/unit/schema-enum-consistency.test.ts`（スキーマに一覧を加える場合に限る）

## 実装する内容

1. `NAVIGATION_OUTCOME_KINDS = ['OK', 'TIMEOUT', 'FAILED', 'BLOCKED_EXTERNAL_REDIRECT'] as const` と、その型を、core に置く。
2. Cross-page rule の入力に、次の2つを加える。
   - ページとビューポートごとのナビゲーションの結果: 要求したURL、最終URL（null 可）、結果の種類
   - 許可Originの一覧
   - 入力の型の置き場所は、T13 の決め方に合わせる。
3. `NAVIGATION_TIMEOUT`（ERROR、category は HTTP）: 結果の種類が `TIMEOUT` のページごとに、1つの Finding にする。ビューポートの違いでは分けない。
4. `UNEXPECTED_ORIGIN_REDIRECT`（WARN、category は HTTP）: 次のどちらかに当てはまるページごとに、1つの Finding にする。
   - 結果の種類が `BLOCKED_EXTERNAL_REDIRECT`
   - 最終URLの Origin が、許可Originの一覧の外
5. Finding の検査、fingerprint、並べ替え、ID の採番は、`materializeFindingDrafts` を使う。
6. Finding の `evidenceRefs` は、1件以上が必要である。ナビゲーションの結果に Evidence の ID がない場合の扱いは、T13 の Rule の決め方に合わせる。
   - 決め方が合わない場合は、止まって報告する。
   - 例えば、ナビゲーションの結果が network の Evidence の ID を持つようにする方法がある。そのために、入力に ID を持たせる必要があれば、その方法を提案する。

7. **Rule の例外の封じ込め**（T13 の判断6）
   - `rule-engine.ts` の、例外を失敗に変える関数（`toRuleEvaluationFailure`）を export する。
   - `evaluateCrossPageRules` は、各 Rule の評価の例外を、この関数で封じ込める。
     - 例外を投げた Rule は、`RULE_EVALUATION_FAILED` の失敗として結果に含める。
     - ほかの Rule の評価は続ける。
   - 同じ変換を、2か所に書かない。
   - テスト用に仮の Rule を差し込めるよう、Rule の一覧を DI で受け取れるようにする。本番の既定値は `CROSS_PAGE_RULES` とする。
8. **sitemap の型**（T13 の判断1）
   - `cross-page-rules.ts` の中の sitemap の型を、`src/core/evidence-types.ts` に `SitemapEvidence` として移す。
   - `cross-page-rules.ts` は、その型を import して使う。

## 受け入れ条件

- 2つの Rule について、成立する場合と成立しない場合のテストがある。修正前に RED、修正後に GREEN になる。
- 次の場合は、Finding にならない。
  - `OK` の結果
  - 許可Originの中へのリダイレクト（例: http から https）
- 入力の順序を入れ替えても、出力が同じになる。
- 仮の Rule が例外を投げても、ほかの Rule の Finding は返り、失敗が1件記録される。修正前に RED、修正後に GREEN になる。
- `npm run typecheck` と、担当のテストが PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。
