# R15 指示書: Task 15（Run Coordinator）のチェックポイントの独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest の CLI です。

このレビューは、実装タスク指示 第12章のチェックポイント（Task 15）です。Critical と Important がなければ、Task 15 を完了とします。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトは、リポジトリの外（一時ディレクトリ）に置いてください。
- Git は、表示だけのコマンドを使ってください。使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- `npm run build` は実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- `npx` は、導入済みのコマンドだけに使ってください。
- インターネット上のサイトにアクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `local/` 配下のファイルは使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第5章（とくに 5.4.1 と 5.6）
  - `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md`
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（第9章 Completion Semantics、SSOT Owner Matrix、Safety Invariants、ARCH03、ARCH05）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 15
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第8章
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - `src/orchestration/run-coordinator.ts`、`crawl-frontier.ts`、`run-aggregation.ts`、`preflight.ts`、`environment.ts`、`run-id.ts`、`skipped-page.ts`
  - `src/crawl/site-metadata.ts`、`src/crawl/sitemap-evidence.ts`
  - `src/config/viewport-size.ts`
  - `src/safety/network-layer-failure.ts`、`src/safety/passive-request-guard.ts`（DEF-004 の分）
  - R15a で変えた型とスキーマ
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `I15a-report.md`、`R15a-report.md`、`R15b-report.md`、`R15c-report.md`、`R15d-report.md`
  - `DEF-004-report.md`、`DEF-004b-report.md`、`DEF-005-report.md`、`RDEF4-review-result.md`
  - 報告の末尾の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **完了の正直さ**（実装タスク指示 第9章）
   - 監査していないページ、上限、期限切れ、確かめられなかった Interaction、失敗が、隠されていないこと。
   - Finding の件数が、Run Status を決めていないこと。
   - 50/50 で `COMPLETE` になれること。
   - 1ページでも監査していなければ、`COMPLETE` にならないこと。
   - Run Status は、`deriveRunStatus` だけが決めていること（ARCH05）。
   - 各入力の値が、設計書 5.6.6 の表のとおりであること。
2. **安全**
   - PREFLIGHT が失敗した場合は、対象のサイトにアクセスしないこと。
   - robots.txt と sitemap の取得が、Guard の付いた Context の GET だけで行われること。
   - sitemap にだけある URL を巡回しないこと。
   - 違反が1件でもあれば、`ABORTED_BY_SAFETY` になること。
   - 集計に、すべての Ledger（PREFLIGHT、環境、metadata、各ページ、再試行の前の試行）が含まれること。
   - DEF-004 と DEF-004b の後、接続拒否などでは `ABORTED_BY_SAFETY` にならず、ページの `FAILED` になること。
3. **クロール**
   - BFS の順、深さ、重複の排除、`INTERNAL_NAVIGABLE` だけをたどること（ARCH03）。
   - Link の再抽出をしないこと。
   - 上限の確認が、各ページの前に行われること。
   - 再試行の対象が、1つの定数だけで決まり、1回だけであること。
   - 最初の試行の記録が、残ること。
   - ID と順序が、決定論的であること。
4. **集計**
   - `RunSummary` の件数が、事実と一致すること。
   - `RunSafetySummary` の集計が、1か所で行われること。
   - Cross-page rule の入力が正しいこと。対象は、SKIPPED のページ、sitemap、切り詰めの印、未検証のリンクの件数である。
5. **止まり続ける経路**
   - Run が止まり続ける経路がないこと。
   - DEF-006（page を閉じる処理に期限がない）は、登録済みの潜在的な不具合です。それ以外に、同じ種類の経路がないかを確かめてください。
6. **スキーマ**
   - 実際の `AuditRunResult` の `run`、`pages`、`findings` が、それぞれのスキーマに合うこと。
   - fixture の統合テストで確かめてください。
7. **テストの質**
   - 単体テストと統合テストが、実装の誤りを検出できる形であること。
   - 実行時間が妥当であること。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- 指摘: 各指摘に、次の項目を書いてください。
  - 重大度（Critical / Important / Minor）
  - 該当箇所（`パス:行`）
  - 問題の内容
  - 根拠（仕様のどの記述か、再現の手順）
  - 期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード、所要時間）
- 確認できなかった点

重大度の基準は、次のとおりです。

- Critical: 安全性の不変条件の違反、または仕様の中核の欠落
- Important: 仕様からの明確な逸脱、現実的に起きうる不具合、誤りを検出できないテスト
- Minor: それ以外

設計者が報告の中で承認した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘には、「推測」と明記してください。
