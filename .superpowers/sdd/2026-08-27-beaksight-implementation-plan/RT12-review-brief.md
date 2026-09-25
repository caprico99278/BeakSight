# RT12 指示書: Task 12・13（Rule Catalog、Rule Engine、各 Rule、Cross-page rule）の独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest で作った CLI です。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。検証用のスクリプトが必要な場合は、リポジトリの外（一時ディレクトリ）に置いてください。
- Git は、表示だけのコマンド（`git status`、`git diff`、`git log`、`git show`、`git blame`）以外を使わないでください。commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- `npm run build` は実行しないでください。テストは、`npx vitest run <対象ファイル>` のように対象を絞って実行してください。`npm run typecheck` は実行してかまいません。
- `npx` は、`node_modules` に導入済みのコマンドだけに使ってください。
- インターネット上のサイトにアクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。`local/` 配下のファイルは使わないでください。

## 対象

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`（第5章〜第7章。2026-09-24 に追加した 5.1.1、5.4.1、第6章の共通化と ruleId の決まり、第7章の入力を含む）
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（SSOT Owner Matrix、Safety Invariants、禁止事項）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12・13
  - `doc/design/2026-08-27-beaksight-web-audit-design.md`（とくに第14章）
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（Finding の文言は Rule が持つこと、GATE-UI06、依存の向き）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - `src/audit/*.ts`（rule、rule-catalog、rule-engine、rule-helpers、各 `*-rules.ts`、cross-page-rules）
  - `src/presentation/format.ts`
  - `src/core/evidence-types.ts` と `src/core/contracts.ts` の追加分（Evidence の種類 `safety`、`NAVIGATION_OUTCOME_KINDS`、`SitemapEvidence`、`RULE_EVALUATION_FAILED`）
  - `src/safety/safety-ledger.ts` の `safetyEventsEvidenceFromSnapshot`
  - `schemas/page.schema.json` と `schemas/run.schema.json` の追加分
- 各サブタスクの報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `T12a-report.md`、`T12a2-report.md`、`T12b-report.md`、`T12c-report.md`、`T12d0-report.md`、`T12d-report-2.md`、`T12e-report.md`、`T12f-report.md`、`T13-report.md`、`T13b-report.md`
  - 報告の末尾の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **仕様との一致**
   - 設計書の表の Rule が、すべて実装され、登録されていること。確かめる項目は、ruleId、category、severity、判定の要点である。
   - 過不足がないこと。
2. **誤検知と見逃し**
   - 意味的な判断や美的な判断を、Finding にしていないこと。
   - 観測できなかった値（`NOT_OBSERVED`、`UNSUPPORTED`、null）から、Finding を作っていないこと。
   - よくあるページの形で、明らかな誤検知がないこと。例は次のとおり。
     - 正常なリダイレクト（http から https）
     - エラーページの共通の title
     - スキップリンク
     - visually hidden の要素
     - 固定ヘッダー
     - 遅延読み込みの画像
     - Guard による遮断
   - 必要なら、テストの見本を参考に、一時ディレクトリで入力を作って確かめてください。
3. **決定論**
   - 入力の順序を変えても、Finding の順序、ID、fingerprint が変わらないこと。
   - fingerprint に、ビューポートと安定した対象の識別子が正しく含まれること。
   - 同じ事実から、2つの Finding が重ねて作られていないこと。
4. **SSOT と共通化**
   - Rule の登録先が `RULE_CATALOG` と `CROSS_PAGE_RULES` だけであること。
   - Finding への変換（`materializeFindingDrafts`）、Evidence の取り出し（`evidenceOfType`）、数値の書式（`format.ts`）と同じ意味の処理が、ほかに書かれていないこと。
   - 型の定義が1か所にあること。確かめる対象は、Safety の事象の型と、enum の `as const` の配列である。
   - 日本語の文字列リテラルが、GATE-UI06 の許す場所（`src/audit/*-rules.ts` など）にだけあること。
5. **例外と契約**
   - Rule の例外が封じ込められ、失敗が `RULE_EVALUATION_FAILED` として返ること。これを、Page rule と Cross-page rule の両方で確かめる。
   - Evidence のない入力で、例外を投げないこと。
   - 型、スキーマ、テストの見本が一致していること。
6. **テストの質**
   - 各 Rule に、成立する場合と成立しない場合のテストがあること。
   - テストが、実装の誤りを検出できる形になっていること。例えば、しきい値の境界、ビューポートの取り違え、切り詰められた値の扱い。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- 指摘: 各指摘に、次の項目を書いてください。
  - 重大度（Critical / Important / Minor）
  - 該当箇所（`パス:行`）
  - 問題の内容
  - 根拠（仕様のどの記述か、再現の手順）
  - 期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード）
- 確認できなかった点

重大度の基準は次のとおりです。

- Critical: 安全性の不変条件の違反、または仕様の中核の欠落
- Important: 仕様からの明確な逸脱、よくあるページで起きる誤検知や見逃し、誤りを検出できないテスト
- Minor: それ以外

設計者が報告の中で承認した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘には、「推測」と明記してください。
