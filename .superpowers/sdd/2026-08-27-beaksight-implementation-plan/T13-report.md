# T13 実装報告（要約。設計者が保存）

## 結論

完了した。設計書 第7章の Cross-page rule 9件を、`src/audit/cross-page-rules.ts` に実装し、`CROSS_PAGE_RULES` に登録した。担当のテスト26件は PASS した。`npm run typecheck` のエラーは、並行して作業中の T12c のテストファイルからだけ出ている。

## 入口と入力の型

- 入口は `evaluateCrossPageRules({ targetId, firstFindingSequence, allowedOrigins, allowedQueryParameters, pages, sitemap? })` の1つだけ。
  - `pages` は `Pick<PageAuditResult, 'pageId'|'pageUrl'|'viewports'|'evidence'>` の配列。
  - `sitemap` は、`{ evidenceId, urls }`。この型は、仮に Cross-page rule のファイルの中に置いている。
- 結果は、`MaterializeFindingDraftsResult` に `unverifiedInternalLinkCount` を加えたもの。

## 実装者の判断と、設計者の判断

1. 入力に `allowedQueryParameters` を持たせ、クロールと同じ `normalizeUrl` の規則で正規化する。→ 承認する。
   - sitemap の型は、T13b で core（`src/core/evidence-types.ts`）に移す。Evidence の型の SSOT は core にあるためである。
   - sitemap を独立した Evidence の種類にするかどうかは、Task 15 の設計で決める。
2. 検証できなかった内部リンクは、「リンク元のページとリンク先のURLの組」の件数で数える。→ 承認する。
3. Finding の文脈は、次のようにする。→ 承認する。
   - リンクの Finding: リンク元のページを文脈にし、ビューポートは null にする。
   - canonical の集まりの Finding: pageId と pageUrl を null にする。
4. title と canonical は、2xx の文書のものだけを比べる。切り詰められたものは比べない。→ 承認する。誤検知を避けるため。
5. 同じ `pageUrl` が2回ある入力は、呼び出し側の誤りとして `TypeError` を投げる。→ 承認する。
6. Rule の例外を封じ込めていない。→ T13b で直す。
   - `rule-engine.ts` の、例外を失敗に変える関数（`toRuleEvaluationFailure`）を export する。
   - Cross-page rule も、その関数で例外を封じ込め、ほかの Rule の評価を続ける。
   - 同じ変換を、2か所に書かない。
